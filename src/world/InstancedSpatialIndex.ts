import * as THREE from 'three';

export type InstancedPickingMode = 'accelerated' | 'unaccelerated';

export interface InstancedSpatialIndexOptions {
  /** Maximum instances per BVH leaf node (default 8). */
  leafSize?: number;
  /** Conservative metric expansion applied to every instance AABB (default 0.05 m). */
  boundsMarginMeters?: number;
  /** Optional explicit raw column-major 4×4 matrix buffer (defaults to `mesh.instanceMatrix.array`). */
  matrices?: Float32Array;
  /** Optional explicit instance count (defaults to `mesh.count`). */
  instanceCount?: number;
}

export interface InstancedSpatialIndexStats {
  instanceCount: number;
  nodeCount: number;
  leafCount: number;
  maxDepth: number;
  leafSize: number;
  boundsMarginMeters: number;
  buildTimeMs: number;
  estimatedMemoryBytes: number;
}

export interface InstancedPickingAggregateStats {
  indexedBatchCount: number;
  totalIndexedInstances: number;
  totalIndexNodes: number;
  totalIndexMemoryBytes: number;
  totalBuildTimeMs: number;
}

export interface InstancedRaycastDiagnostics {
  mode: InstancedPickingMode;
  batchesVisited: number;
  batchesSkippedInvisible: number;
  batchesRejectedBroadPhase: number;
  batchesTested: number;
  totalInstancesInQueriedBatches: number;
  bvhNodesVisited: number;
  candidateInstances: number;
  exactInstanceTests: number;
  hitsFound: number;
  instancedRaycastDurationMs: number;
}

export const DEFAULT_INSTANCED_BVH_LEAF_SIZE = 8;
export const DEFAULT_INSTANCED_AABB_MARGIN_METERS = 0.05;
const RAY_T_EPSILON = 1e-4;
const RAY_DIR_ZERO_EPSILON = 1e-12;
const FIXED_INDEX_OVERHEAD_BYTES = 96;

let globalInstancedPickingMode: InstancedPickingMode = 'accelerated';

export function getInstancedPickingMode(): InstancedPickingMode {
  return globalInstancedPickingMode;
}

export function setInstancedPickingMode(mode: InstancedPickingMode): InstancedPickingMode {
  globalInstancedPickingMode = mode === 'unaccelerated' ? 'unaccelerated' : 'accelerated';
  return globalInstancedPickingMode;
}

export function parseInstancedPickingModeFromSearch(search: string): InstancedPickingMode {
  const params = new URLSearchParams(search);
  const raw = params.get('instancedPicking')?.trim().toLowerCase();
  if (raw === 'unaccelerated' || raw === 'linear' || raw === '0' || raw === 'false' || raw === 'off') {
    return 'unaccelerated';
  }
  return 'accelerated';
}

export function getEffectiveInstancedPickingMode(
  raycaster?: THREE.Raycaster | null
): InstancedPickingMode {
  const override = (raycaster as unknown as { __instancedPickingMode?: InstancedPickingMode } | null)
    ?.__instancedPickingMode;
  if (override === 'accelerated' || override === 'unaccelerated') {
    return override;
  }
  return globalInstancedPickingMode;
}

export function setRaycasterInstancedPickingMode(
  raycaster: THREE.Raycaster,
  mode: InstancedPickingMode | null
): void {
  const target = raycaster as unknown as { __instancedPickingMode?: InstancedPickingMode };
  if (mode === null) {
    delete target.__instancedPickingMode;
  } else {
    target.__instancedPickingMode = mode;
  }
}

export function withInstancedPickingMode<T>(
  mode: InstancedPickingMode,
  fn: () => T
): T {
  const prev = globalInstancedPickingMode;
  globalInstancedPickingMode = mode;
  try {
    return fn();
  } finally {
    globalInstancedPickingMode = prev;
  }
}

// Lightweight zero-allocation diagnostic counters updated only during actual raycast queries
const lastDiag: InstancedRaycastDiagnostics = {
  mode: 'accelerated',
  batchesVisited: 0,
  batchesSkippedInvisible: 0,
  batchesRejectedBroadPhase: 0,
  batchesTested: 0,
  totalInstancesInQueriedBatches: 0,
  bvhNodesVisited: 0,
  candidateInstances: 0,
  exactInstanceTests: 0,
  hitsFound: 0,
  instancedRaycastDurationMs: 0,
};

export function resetInstancedRaycastDiagnostics(
  mode: InstancedPickingMode = globalInstancedPickingMode
): void {
  lastDiag.mode = mode;
  lastDiag.batchesVisited = 0;
  lastDiag.batchesSkippedInvisible = 0;
  lastDiag.batchesRejectedBroadPhase = 0;
  lastDiag.batchesTested = 0;
  lastDiag.totalInstancesInQueriedBatches = 0;
  lastDiag.bvhNodesVisited = 0;
  lastDiag.candidateInstances = 0;
  lastDiag.exactInstanceTests = 0;
  lastDiag.hitsFound = 0;
  lastDiag.instancedRaycastDurationMs = 0;
}

export function getLastInstancedRaycastDiagnostics(): InstancedRaycastDiagnostics {
  return { ...lastDiag };
}

/**
 * Checks whether an Object3D and every ancestor in its scene-graph chain are visible.
 * Used during accelerated instanced picking so suppressed trunks, hidden 3D sleepers,
 * and disabled layers are rejected in O(depth) without testing contained instances.
 */
export function isObjectHierarchyVisible(obj: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

// Pre-allocated scratch helpers (zero per-ray heap allocations on the hot path)
const _invMeshWorldMatrix = new THREE.Matrix4();
const _instanceLocalMatrix = new THREE.Matrix4();
const _instanceWorldMatrix = new THREE.Matrix4();
const _proxyMesh = new THREE.Mesh();
const _localIntersects: THREE.Intersection[] = [];
const _testSphere = new THREE.Sphere();
const _nodeStack = new Int32Array(256);
const _tEntryStack = new Float64Array(256);
let _activeTraversalDepth = 0;

/**
 * NaN-safe 3D ray-AABB slab intersection returning the nearest valid ray parameter
 * `tEntry >= rayNear` inside `[rayNear, rayFar]`, or `Infinity` when disjoint.
 *
 * Explicitly handles near-zero direction components (e.g. vertical `(0, -1, 0)` rays)
 * so `0 * Infinity = NaN` can never cause a false negative on axis-aligned AABB faces.
 */
function intersectRayAabbSlab(
  ox: number,
  oy: number,
  oz: number,
  invDx: number,
  invDy: number,
  invDz: number,
  hasDx: boolean,
  hasDy: boolean,
  hasDz: boolean,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  rayNear: number,
  rayFar: number
): number {
  let tMin = rayNear;
  let tMax = rayFar;

  if (hasDx) {
    const t1 = (minX - ox) * invDx;
    const t2 = (maxX - ox) * invDx;
    const lo = t1 < t2 ? t1 : t2;
    const hi = t1 > t2 ? t1 : t2;
    if (lo > tMin) tMin = lo;
    if (hi < tMax) tMax = hi;
    if (tMax < tMin) return Number.POSITIVE_INFINITY;
  } else if (ox < minX || ox > maxX) {
    return Number.POSITIVE_INFINITY;
  }

  if (hasDy) {
    const t1 = (minY - oy) * invDy;
    const t2 = (maxY - oy) * invDy;
    const lo = t1 < t2 ? t1 : t2;
    const hi = t1 > t2 ? t1 : t2;
    if (lo > tMin) tMin = lo;
    if (hi < tMax) tMax = hi;
    if (tMax < tMin) return Number.POSITIVE_INFINITY;
  } else if (oy < minY || oy > maxY) {
    return Number.POSITIVE_INFINITY;
  }

  if (hasDz) {
    const t1 = (minZ - oz) * invDz;
    const t2 = (maxZ - oz) * invDz;
    const lo = t1 < t2 ? t1 : t2;
    const hi = t1 > t2 ? t1 : t2;
    if (lo > tMin) tMin = lo;
    if (hi < tMax) tMax = hi;
    if (tMax < tMin) return Number.POSITIVE_INFINITY;
  } else if (oz < minZ || oz > maxZ) {
    return Number.POSITIVE_INFINITY;
  }

  return tMin;
}

/**
 * Flat typed-array 3D AABB BVH indexing individual instances of a `THREE.InstancedMesh`
 * in mesh-local space.
 *
 * Key properties:
 * - Built once from decoded `instanceMatrix` data + conservative union prototype bounds
 *   (covering all foliage LOD0..LOD2 geometries), so zoom-driven LOD swaps never require
 *   rebuilding the index.
 * - Stored in mesh-local space so tile placement offsets and parent group transforms
 *   remain valid without refitting.
 * - Transforms the world ray into mesh-local space with an **unnormalized** direction
 *   vector so slab `t` parameters equal exact world-space distances even under arbitrary
 *   parent scale/rotation/translation.
 * - Broad phase is strictly conservative (Arvo exact affine-AABB transform + metric safety
 *   margin); narrow phase invokes exact `THREE.Mesh.prototype.raycast` against the active
 *   `mesh.geometry`, preserving original `instanceId`, distances, and feature metadata.
 */
export class InstancedSpatialIndex {
  private nodeBounds: Float32Array;
  private nodeMeta: Int32Array;
  private sortedInstanceIds: Uint32Array;
  private instanceBounds: Float32Array;
  private readonly stats: InstancedSpatialIndexStats;
  private isDisposed = false;

  constructor(
    matrices: Float32Array,
    instanceCount: number,
    unionPrototypeLocalBox: THREE.Box3,
    options?: Pick<InstancedSpatialIndexOptions, 'leafSize' | 'boundsMarginMeters'>
  ) {
    const t0 = performance.now();
    const leafSize = Math.max(1, Math.floor(options?.leafSize ?? DEFAULT_INSTANCED_BVH_LEAF_SIZE));
    const margin = Math.max(0, options?.boundsMarginMeters ?? DEFAULT_INSTANCED_AABB_MARGIN_METERS);
    const count = Math.max(0, Math.min(instanceCount, Math.floor(matrices.length / 16)));

    if (count === 0 || unionPrototypeLocalBox.isEmpty()) {
      this.nodeBounds = new Float32Array(0);
      this.nodeMeta = new Int32Array(0);
      this.sortedInstanceIds = new Uint32Array(0);
      this.instanceBounds = new Float32Array(0);
      this.stats = {
        instanceCount: 0,
        nodeCount: 0,
        leafCount: 0,
        maxDepth: 0,
        leafSize,
        boundsMarginMeters: margin,
        buildTimeMs: Number((performance.now() - t0).toFixed(3)),
        estimatedMemoryBytes: FIXED_INDEX_OVERHEAD_BYTES,
      };
      return;
    }

    // 1. Compute conservative per-instance mesh-local AABBs using Arvo's exact affine-AABB transform
    const origBounds = new Float32Array(count * 6);
    const sortedIds = new Uint32Array(count);

    const lMinX = unionPrototypeLocalBox.min.x;
    const lMinY = unionPrototypeLocalBox.min.y;
    const lMinZ = unionPrototypeLocalBox.min.z;
    const lMaxX = unionPrototypeLocalBox.max.x;
    const lMaxY = unionPrototypeLocalBox.max.y;
    const lMaxZ = unionPrototypeLocalBox.max.z;

    for (let i = 0; i < count; i++) {
      sortedIds[i] = i;
      const o = i * 16;
      const e0 = matrices[o];
      const e1 = matrices[o + 1];
      const e2 = matrices[o + 2];
      const e4 = matrices[o + 4];
      const e5 = matrices[o + 5];
      const e6 = matrices[o + 6];
      const e8 = matrices[o + 8];
      const e9 = matrices[o + 9];
      const e10 = matrices[o + 10];
      const tx = matrices[o + 12];
      const ty = matrices[o + 13];
      const tz = matrices[o + 14];

      const xa0 = e0 * lMinX;
      const xb0 = e0 * lMaxX;
      const xa1 = e4 * lMinY;
      const xb1 = e4 * lMaxY;
      const xa2 = e8 * lMinZ;
      const xb2 = e8 * lMaxZ;

      const ya0 = e1 * lMinX;
      const yb0 = e1 * lMaxX;
      const ya1 = e5 * lMinY;
      const yb1 = e5 * lMaxY;
      const ya2 = e9 * lMinZ;
      const yb2 = e9 * lMaxZ;

      const za0 = e2 * lMinX;
      const zb0 = e2 * lMaxX;
      const za1 = e6 * lMinY;
      const zb1 = e6 * lMaxY;
      const za2 = e10 * lMinZ;
      const zb2 = e10 * lMaxZ;

      const b = i * 6;
      origBounds[b] =
        tx + (xa0 < xb0 ? xa0 : xb0) + (xa1 < xb1 ? xa1 : xb1) + (xa2 < xb2 ? xa2 : xb2) - margin;
      origBounds[b + 1] =
        ty + (ya0 < yb0 ? ya0 : yb0) + (ya1 < yb1 ? ya1 : yb1) + (ya2 < yb2 ? ya2 : yb2) - margin;
      origBounds[b + 2] =
        tz + (za0 < zb0 ? za0 : zb0) + (za1 < zb1 ? za1 : zb1) + (za2 < zb2 ? za2 : zb2) - margin;
      origBounds[b + 3] =
        tx + (xa0 > xb0 ? xa0 : xb0) + (xa1 > xb1 ? xa1 : xb1) + (xa2 > xb2 ? xa2 : xb2) + margin;
      origBounds[b + 4] =
        ty + (ya0 > yb0 ? ya0 : yb0) + (ya1 > yb1 ? ya1 : yb1) + (ya2 > yb2 ? ya2 : yb2) + margin;
      origBounds[b + 5] =
        tz + (za0 > zb0 ? za0 : zb0) + (za1 > zb1 ? za1 : zb1) + (za2 > zb2 ? za2 : zb2) + margin;
    }

    // 2. Iterative top-down spatial-midpoint BVH build (guaranteed O(N log N) termination)
    const maxNodes = Math.max(1, Math.min(count * 2, Math.ceil((count / leafSize) * 4) + 16));
    let nodeBoundsBuf = new Float32Array(maxNodes * 6);
    let nodeMetaBuf = new Int32Array(maxNodes * 2);

    const ensureNodeCapacity = (needed: number) => {
      const currentCap = nodeMetaBuf.length >>> 1;
      if (needed <= currentCap) return;
      const nextCap = Math.max(needed, currentCap * 2);
      const nextBounds = new Float32Array(nextCap * 6);
      nextBounds.set(nodeBoundsBuf);
      nodeBoundsBuf = nextBounds;
      const nextMeta = new Int32Array(nextCap * 2);
      nextMeta.set(nodeMetaBuf);
      nodeMetaBuf = nextMeta;
    };

    // Explicit build task stacks: (nodeIdx, start, end, depth)
    const stackNode: number[] = [0];
    const stackStart: number[] = [0];
    const stackEnd: number[] = [count];
    const stackDepth: number[] = [1];

    let nodeCount = 1;
    let leafCount = 0;
    let maxDepth = 1;

    while (stackNode.length > 0) {
      const nodeIdx = stackNode.pop()!;
      const start = stackStart.pop()!;
      const end = stackEnd.pop()!;
      const depth = stackDepth.pop()!;
      if (depth > maxDepth) maxDepth = depth;

      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let minZ = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      let maxZ = Number.NEGATIVE_INFINITY;

      let cMinX = Number.POSITIVE_INFINITY;
      let cMinY = Number.POSITIVE_INFINITY;
      let cMinZ = Number.POSITIVE_INFINITY;
      let cMaxX = Number.NEGATIVE_INFINITY;
      let cMaxY = Number.NEGATIVE_INFINITY;
      let cMaxZ = Number.NEGATIVE_INFINITY;

      for (let i = start; i < end; i++) {
        const b = sortedIds[i] * 6;
        const x0 = origBounds[b];
        const y0 = origBounds[b + 1];
        const z0 = origBounds[b + 2];
        const x1 = origBounds[b + 3];
        const y1 = origBounds[b + 4];
        const z1 = origBounds[b + 5];

        if (x0 < minX) minX = x0;
        if (y0 < minY) minY = y0;
        if (z0 < minZ) minZ = z0;
        if (x1 > maxX) maxX = x1;
        if (y1 > maxY) maxY = y1;
        if (z1 > maxZ) maxZ = z1;

        const cx = x0 + x1;
        const cy = y0 + y1;
        const cz = z0 + z1;
        if (cx < cMinX) cMinX = cx;
        if (cy < cMinY) cMinY = cy;
        if (cz < cMinZ) cMinZ = cz;
        if (cx > cMaxX) cMaxX = cx;
        if (cy > cMaxY) cMaxY = cy;
        if (cz > cMaxZ) cMaxZ = cz;
      }

      const nb = nodeIdx * 6;
      nodeBoundsBuf[nb] = minX;
      nodeBoundsBuf[nb + 1] = minY;
      nodeBoundsBuf[nb + 2] = minZ;
      nodeBoundsBuf[nb + 3] = maxX;
      nodeBoundsBuf[nb + 4] = maxY;
      nodeBoundsBuf[nb + 5] = maxZ;

      const rangeCount = end - start;
      if (rangeCount <= leafSize) {
        nodeMetaBuf[nodeIdx * 2] = start;
        nodeMetaBuf[nodeIdx * 2 + 1] = -rangeCount;
        leafCount++;
        continue;
      }

      const spanX = cMaxX - cMinX;
      const spanY = cMaxY - cMinY;
      const spanZ = cMaxZ - cMinZ;

      let axis = 0;
      let maxSpan = spanX;
      let splitTwice = (cMinX + cMaxX) * 0.5;
      if (spanZ > maxSpan) {
        axis = 2;
        maxSpan = spanZ;
        splitTwice = (cMinZ + cMaxZ) * 0.5;
      }
      if (spanY > maxSpan) {
        axis = 1;
        maxSpan = spanY;
        splitTwice = (cMinY + cMaxY) * 0.5;
      }

      let mid = (start + end) >>> 1;
      if (maxSpan > 1e-6 && depth < 48) {
        // In-place Hoare-style partition around centroid midpoint
        let lo = start;
        let hi = end - 1;
        while (lo <= hi) {
          const b = sortedIds[lo] * 6;
          const c2 = origBounds[b + axis] + origBounds[b + axis + 3];
          if (c2 < splitTwice) {
            lo++;
          } else {
            const tmp = sortedIds[lo];
            sortedIds[lo] = sortedIds[hi];
            sortedIds[hi] = tmp;
            hi--;
          }
        }
        if (lo > start && lo < end) {
          mid = lo;
        }
      }

      const leftIdx = nodeCount;
      const rightIdx = nodeCount + 1;
      nodeCount += 2;
      ensureNodeCapacity(nodeCount);

      nodeMetaBuf[nodeIdx * 2] = leftIdx;
      nodeMetaBuf[nodeIdx * 2 + 1] = rightIdx;

      stackNode.push(rightIdx, leftIdx);
      stackStart.push(mid, start);
      stackEnd.push(end, mid);
      stackDepth.push(depth + 1, depth + 1);
    }

    // 3. Reorder per-instance AABBs into cache-sequential BVH leaf order and trim node buffers
    const sortedBounds = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) {
      const src = sortedIds[i] * 6;
      const dst = i * 6;
      sortedBounds[dst] = origBounds[src];
      sortedBounds[dst + 1] = origBounds[src + 1];
      sortedBounds[dst + 2] = origBounds[src + 2];
      sortedBounds[dst + 3] = origBounds[src + 3];
      sortedBounds[dst + 4] = origBounds[src + 4];
      sortedBounds[dst + 5] = origBounds[src + 5];
    }

    this.nodeBounds = nodeBoundsBuf.slice(0, nodeCount * 6);
    this.nodeMeta = nodeMetaBuf.slice(0, nodeCount * 2);
    this.sortedInstanceIds = sortedIds;
    this.instanceBounds = sortedBounds;

    const estimatedMemoryBytes =
      this.nodeBounds.byteLength +
      this.nodeMeta.byteLength +
      this.sortedInstanceIds.byteLength +
      this.instanceBounds.byteLength +
      FIXED_INDEX_OVERHEAD_BYTES;

    this.stats = {
      instanceCount: count,
      nodeCount,
      leafCount,
      maxDepth,
      leafSize,
      boundsMarginMeters: margin,
      buildTimeMs: Number((performance.now() - t0).toFixed(3)),
      estimatedMemoryBytes,
    };
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  getStats(): InstancedSpatialIndexStats {
    return { ...this.stats };
  }

  estimateMemoryBytes(): number {
    return this.isDisposed ? 0 : this.stats.estimatedMemoryBytes;
  }

  /**
   * Executes spatially accelerated raycast against `mesh` using its currently active
   * prototype `geometry` and `material`, appending exact `THREE.Intersection` hits
   * with original `instanceId` and `object = mesh`.
   */
  raycastMesh(
    mesh: THREE.InstancedMesh,
    raycaster: THREE.Raycaster,
    intersects: THREE.Intersection[]
  ): void {
    const t0 = performance.now();
    lastDiag.mode = 'accelerated';
    lastDiag.batchesVisited += 1;

    if (this.isDisposed || mesh.material === undefined || mesh.count <= 0 || this.stats.instanceCount <= 0) {
      lastDiag.batchesRejectedBroadPhase += 1;
      lastDiag.instancedRaycastDurationMs += performance.now() - t0;
      return;
    }

    if (!isObjectHierarchyVisible(mesh)) {
      lastDiag.batchesSkippedInvisible += 1;
      lastDiag.instancedRaycastDurationMs += performance.now() - t0;
      return;
    }

    const matrixWorld = mesh.matrixWorld;
    if (Math.abs(matrixWorld.determinant()) < 1e-18) {
      lastDiag.batchesRejectedBroadPhase += 1;
      lastDiag.instancedRaycastDurationMs += performance.now() - t0;
      return;
    }

    const invMat = _activeTraversalDepth === 0 ? _invMeshWorldMatrix : new THREE.Matrix4();
    invMat.copy(matrixWorld).invert();
    const m = invMat.elements;

    const wOrigin = raycaster.ray.origin;
    const wDir = raycaster.ray.direction;

    // Transform ray into mesh-local space WITHOUT normalizing local direction so
    // parametric t equals exact world-space distance along raycaster.ray.
    const ox = m[0] * wOrigin.x + m[4] * wOrigin.y + m[8] * wOrigin.z + m[12];
    const oy = m[1] * wOrigin.x + m[5] * wOrigin.y + m[9] * wOrigin.z + m[13];
    const oz = m[2] * wOrigin.x + m[6] * wOrigin.y + m[10] * wOrigin.z + m[14];
    const dx = m[0] * wDir.x + m[4] * wDir.y + m[8] * wDir.z;
    const dy = m[1] * wDir.x + m[5] * wDir.y + m[9] * wDir.z;
    const dz = m[2] * wDir.x + m[6] * wDir.y + m[10] * wDir.z;

    const hasDx = Math.abs(dx) > RAY_DIR_ZERO_EPSILON;
    const hasDy = Math.abs(dy) > RAY_DIR_ZERO_EPSILON;
    const hasDz = Math.abs(dz) > RAY_DIR_ZERO_EPSILON;
    const invDx = hasDx ? 1 / dx : 0;
    const invDy = hasDy ? 1 / dy : 0;
    const invDz = hasDz ? 1 / dz : 0;

    const rayNear = Math.max(0, raycaster.near);
    const rayFar = raycaster.far;

    const nodeBounds = this.nodeBounds;
    const rootT = intersectRayAabbSlab(
      ox,
      oy,
      oz,
      invDx,
      invDy,
      invDz,
      hasDx,
      hasDy,
      hasDz,
      nodeBounds[0],
      nodeBounds[1],
      nodeBounds[2],
      nodeBounds[3],
      nodeBounds[4],
      nodeBounds[5],
      rayNear,
      rayFar
    );

    if (rootT === Number.POSITIVE_INFINITY) {
      lastDiag.batchesRejectedBroadPhase += 1;
      lastDiag.instancedRaycastDurationMs += performance.now() - t0;
      return;
    }

    const activeCount = Math.min(mesh.count, this.stats.instanceCount);
    lastDiag.batchesTested += 1;
    lastDiag.totalInstancesInQueriedBatches += activeCount;

    const firstHitOnly = Boolean((raycaster as unknown as { firstHitOnly?: boolean }).firstHitOnly);
    const nodeMeta = this.nodeMeta;
    const sortedIds = this.sortedInstanceIds;
    const instanceBounds = this.instanceBounds;
    const instMatrixArr = mesh.instanceMatrix.array as Float32Array;

    const proxyMesh = _activeTraversalDepth === 0 ? _proxyMesh : new THREE.Mesh();
    const localMat = _activeTraversalDepth === 0 ? _instanceLocalMatrix : new THREE.Matrix4();
    const worldMat = _activeTraversalDepth === 0 ? _instanceWorldMatrix : new THREE.Matrix4();
    const localHits = _activeTraversalDepth === 0 ? _localIntersects : [];
    const nodeStack = _activeTraversalDepth === 0 ? _nodeStack : new Int32Array(256);
    const tStack = _activeTraversalDepth === 0 ? _tEntryStack : new Float64Array(256);

    proxyMesh.geometry = mesh.geometry;
    proxyMesh.material = mesh.material;

    let effectiveFar = rayFar;
    let closestHit: THREE.Intersection | null = null;
    let nodesVisited = 0;
    let candidates = 0;
    let exactTests = 0;
    let hitsFound = 0;

    _activeTraversalDepth++;
    try {
      let stackTop = 0;
      nodeStack[0] = 0;
      tStack[0] = rootT;
      stackTop = 1;

      while (stackTop > 0) {
        stackTop--;
        const nodeIdx = nodeStack[stackTop];
        const nodeT = tStack[stackTop];

        if (firstHitOnly && nodeT > effectiveFar + RAY_T_EPSILON) {
          continue;
        }

        nodesVisited++;
        const metaOffset = nodeIdx * 2;
        const a = nodeMeta[metaOffset];
        const b = nodeMeta[metaOffset + 1];

        if (b < 0) {
          // Leaf node: [a, a + (-b))
          const leafEnd = a - b;
          for (let p = a; p < leafEnd; p++) {
            const instanceId = sortedIds[p];
            if (instanceId >= activeCount) continue;

            const ib = p * 6;
            const instT = intersectRayAabbSlab(
              ox,
              oy,
              oz,
              invDx,
              invDy,
              invDz,
              hasDx,
              hasDy,
              hasDz,
              instanceBounds[ib],
              instanceBounds[ib + 1],
              instanceBounds[ib + 2],
              instanceBounds[ib + 3],
              instanceBounds[ib + 4],
              instanceBounds[ib + 5],
              rayNear,
              firstHitOnly ? effectiveFar + RAY_T_EPSILON : rayFar
            );

            if (instT === Number.POSITIVE_INFINITY) continue;
            candidates++;

            // Narrow-phase: exact geometry raycast against active prototype geometry
            localMat.fromArray(instMatrixArr, instanceId * 16);
            worldMat.multiplyMatrices(matrixWorld, localMat);
            proxyMesh.matrixWorld = worldMat;
            localHits.length = 0;
            exactTests++;
            proxyMesh.raycast(raycaster, localHits);

            for (let hi = 0; hi < localHits.length; hi++) {
              const hit = localHits[hi];
              hit.instanceId = instanceId;
              hit.object = mesh;
              hitsFound++;

              if (firstHitOnly) {
                if (
                  closestHit === null ||
                  hit.distance < effectiveFar ||
                  (hit.distance === effectiveFar &&
                    instanceId < (closestHit.instanceId ?? Number.MAX_SAFE_INTEGER))
                ) {
                  effectiveFar = hit.distance;
                  closestHit = hit;
                }
              } else {
                intersects.push(hit);
              }
            }
            localHits.length = 0;
          }
        } else {
          // Internal node: test both children and traverse nearer child first
          const queryFar = firstHitOnly ? effectiveFar + RAY_T_EPSILON : rayFar;
          const lb = a * 6;
          const rb = b * 6;

          const tLeft = intersectRayAabbSlab(
            ox,
            oy,
            oz,
            invDx,
            invDy,
            invDz,
            hasDx,
            hasDy,
            hasDz,
            nodeBounds[lb],
            nodeBounds[lb + 1],
            nodeBounds[lb + 2],
            nodeBounds[lb + 3],
            nodeBounds[lb + 4],
            nodeBounds[lb + 5],
            rayNear,
            queryFar
          );
          const tRight = intersectRayAabbSlab(
            ox,
            oy,
            oz,
            invDx,
            invDy,
            invDz,
            hasDx,
            hasDy,
            hasDz,
            nodeBounds[rb],
            nodeBounds[rb + 1],
            nodeBounds[rb + 2],
            nodeBounds[rb + 3],
            nodeBounds[rb + 4],
            nodeBounds[rb + 5],
            rayNear,
            queryFar
          );

          const hitLeft = tLeft !== Number.POSITIVE_INFINITY;
          const hitRight = tRight !== Number.POSITIVE_INFINITY;

          if (hitLeft && hitRight) {
            if (stackTop + 2 <= nodeStack.length) {
              if (tLeft <= tRight) {
                // Push farther (right) first so nearer (left) is popped first
                nodeStack[stackTop] = b;
                tStack[stackTop] = tRight;
                nodeStack[stackTop + 1] = a;
                tStack[stackTop + 1] = tLeft;
              } else {
                nodeStack[stackTop] = a;
                tStack[stackTop] = tLeft;
                nodeStack[stackTop + 1] = b;
                tStack[stackTop + 1] = tRight;
              }
              stackTop += 2;
            }
          } else if (hitLeft) {
            if (stackTop + 1 <= nodeStack.length) {
              nodeStack[stackTop] = a;
              tStack[stackTop] = tLeft;
              stackTop += 1;
            }
          } else if (hitRight) {
            if (stackTop + 1 <= nodeStack.length) {
              nodeStack[stackTop] = b;
              tStack[stackTop] = tRight;
              stackTop += 1;
            }
          }
        }
      }

      if (firstHitOnly && closestHit !== null) {
        intersects.push(closestHit);
      }
    } finally {
      proxyMesh.material = null as unknown as THREE.Material;
      proxyMesh.geometry = null as unknown as THREE.BufferGeometry;
      localHits.length = 0;
      _activeTraversalDepth--;
    }

    lastDiag.bvhNodesVisited += nodesVisited;
    lastDiag.candidateInstances += candidates;
    lastDiag.exactInstanceTests += exactTests;
    lastDiag.hitsFound += hitsFound;
    lastDiag.instancedRaycastDurationMs += performance.now() - t0;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.nodeBounds = new Float32Array(0);
    this.nodeMeta = new Int32Array(0);
    this.sortedInstanceIds = new Uint32Array(0);
    this.instanceBounds = new Float32Array(0);
  }
}

function runUnacceleratedInstancedRaycastWithDiagnostics(
  mesh: THREE.InstancedMesh,
  raycaster: THREE.Raycaster,
  intersects: THREE.Intersection[]
): void {
  const t0 = performance.now();
  lastDiag.mode = 'unaccelerated';
  lastDiag.batchesVisited += 1;

  const beforeLen = intersects.length;
  let sphereHit = true;
  if (mesh.material !== undefined && mesh.count > 0) {
    if (mesh.boundingSphere === null) mesh.computeBoundingSphere();
    if (mesh.boundingSphere !== null) {
      _testSphere.copy(mesh.boundingSphere).applyMatrix4(mesh.matrixWorld);
      sphereHit = raycaster.ray.intersectsSphere(_testSphere);
    }
  } else {
    sphereHit = false;
  }

  THREE.InstancedMesh.prototype.raycast.call(mesh, raycaster, intersects);

  if (!sphereHit) {
    lastDiag.batchesRejectedBroadPhase += 1;
  } else {
    lastDiag.batchesTested += 1;
    lastDiag.totalInstancesInQueriedBatches += mesh.count;
    lastDiag.candidateInstances += mesh.count;
    lastDiag.exactInstanceTests += mesh.count;
  }
  lastDiag.hitsFound += Math.max(0, intersects.length - beforeLen);
  lastDiag.instancedRaycastDurationMs += performance.now() - t0;
}

/**
 * Builds and attaches a mesh-local `InstancedSpatialIndex` to a `THREE.InstancedMesh`,
 * installing a zero-allocation `mesh.raycast` dispatcher that supports switching between
 * accelerated BVH picking and the original unaccelerated Three.js reference path.
 */
export function attachInstancedSpatialIndex(
  mesh: THREE.InstancedMesh,
  unionPrototypeLocalBox: THREE.Box3,
  options?: InstancedSpatialIndexOptions
): InstancedSpatialIndex {
  // Clean up any previously attached index before replacing
  disposeInstancedSpatialIndex(mesh);

  const matrices = options?.matrices ?? (mesh.instanceMatrix.array as Float32Array);
  const instanceCount = options?.instanceCount ?? mesh.count;
  const index = new InstancedSpatialIndex(
    matrices,
    instanceCount,
    unionPrototypeLocalBox,
    options
  );

  mesh.userData = mesh.userData ?? {};
  mesh.userData.instancedSpatialIndex = index;
  mesh.raycast = function acceleratedInstancedRaycast(
    this: THREE.InstancedMesh,
    raycaster: THREE.Raycaster,
    intersects: THREE.Intersection[]
  ) {
    const mode = getEffectiveInstancedPickingMode(raycaster);
    if (mode === 'unaccelerated') {
      runUnacceleratedInstancedRaycastWithDiagnostics(this, raycaster, intersects);
      return;
    }
    index.raycastMesh(this, raycaster, intersects);
  };

  return index;
}

/**
 * Returns the `InstancedSpatialIndex` attached to `mesh`, or `null` if none is attached.
 */
export function getInstancedSpatialIndex(
  mesh: THREE.InstancedMesh | null | undefined
): InstancedSpatialIndex | null {
  if (!mesh) return null;
  const existing = mesh.userData?.instancedSpatialIndex as InstancedSpatialIndex | undefined;
  return existing && !existing.disposed ? existing : null;
}

/**
 * Disposes any `InstancedSpatialIndex` attached to `mesh` and restores the default
 * `THREE.InstancedMesh.prototype.raycast` handler. Safe and idempotent.
 */
export function disposeInstancedSpatialIndex(mesh: THREE.InstancedMesh | null | undefined): void {
  if (!mesh) return;
  const existing = mesh.userData?.instancedSpatialIndex as InstancedSpatialIndex | undefined;
  if (existing && typeof existing.dispose === 'function') {
    existing.dispose();
  }
  if (mesh.userData && 'instancedSpatialIndex' in mesh.userData) {
    delete mesh.userData.instancedSpatialIndex;
  }
  mesh.raycast = THREE.InstancedMesh.prototype.raycast;
}

/**
 * Aggregates memory, node, instance, and construction-time statistics across all
 * spatially indexed `InstancedMesh` batches under `root` (diagnostic snapshot only).
 */
export function collectInstancedSpatialIndexStats(
  root: THREE.Object3D | readonly THREE.Object3D[] | null | undefined
): InstancedPickingAggregateStats {
  let indexedBatchCount = 0;
  let totalIndexedInstances = 0;
  let totalIndexNodes = 0;
  let totalIndexMemoryBytes = 0;
  let totalBuildTimeMs = 0;

  if (!root) {
    return {
      indexedBatchCount,
      totalIndexedInstances,
      totalIndexNodes,
      totalIndexMemoryBytes,
      totalBuildTimeMs,
    };
  }

  const visit = (obj: THREE.Object3D) => {
    const idx = obj.userData?.instancedSpatialIndex as InstancedSpatialIndex | undefined;
    if (idx && !idx.disposed) {
      const s = idx.getStats();
      indexedBatchCount++;
      totalIndexedInstances += s.instanceCount;
      totalIndexNodes += s.nodeCount;
      totalIndexMemoryBytes += s.estimatedMemoryBytes;
      totalBuildTimeMs += s.buildTimeMs;
    }
  };

  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) {
      root[i]?.traverse(visit);
    }
  } else {
    (root as THREE.Object3D).traverse(visit);
  }

  return {
    indexedBatchCount,
    totalIndexedInstances,
    totalIndexNodes,
    totalIndexMemoryBytes,
    totalBuildTimeMs: Number(totalBuildTimeMs.toFixed(3)),
  };
}
