import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type FoliageLodLevel = 'lod0' | 'lod1' | 'lod2';
export type FoliageLodMode = 'auto' | FoliageLodLevel;
export type FoliagePrototypeKind =
  | 'tree_trunk'
  | 'tree_broadleaved'
  | 'tree_needleleaved';

export const FOLIAGE_LOD_LEVELS: readonly FoliageLodLevel[] = [
  'lod0',
  'lod1',
  'lod2',
];

export const FOLIAGE_PROTOTYPE_KINDS: readonly FoliagePrototypeKind[] = [
  'tree_trunk',
  'tree_broadleaved',
  'tree_needleleaved',
];

export function isFoliagePrototypeKind(
  kind: string
): kind is FoliagePrototypeKind {
  return (
    kind === 'tree_trunk' ||
    kind === 'tree_broadleaved' ||
    kind === 'tree_needleleaved'
  );
}

/**
 * Exact verified triangle counts per prototype instance across LOD levels.
 *
 * - `tree_trunk`: 6-sided closed cylinder (`CylinderGeometry(0.18, 0.32, 2.5, 6)`) = 24 tris.
 *   Trunks are suppressed via batch visibility (`visible = false`) rather than
 *   swapping to a coarser cylinder.
 * - `tree_broadleaved`:
 *   - `lod0`: 3 subdivided icosahedrons (`detail = 1`) = 240 tris (unchanged baseline).
 *   - `lod1`: 3 unsubdivided icosahedrons (`detail = 0`) = 60 tris (-75.0%, preserves 3-lobe silhouette).
 *     Chosen over a single subdivided icosahedron (80 tris) because it has 25% fewer triangles
 *     while maintaining the asymmetric multi-lobe crown shape.
 *   - `lod2`: 1 unsubdivided icosahedron (`detail = 0`, gently oblate) = 20 tris (-91.7%).
 * - `tree_needleleaved`:
 *   - `lod0`: 3 closed 7-sided cones = 42 tris (unchanged baseline).
 *   - `lod1`: 3 open-ended 5-sided cones = 15 tris (-64.3%, bottom caps unseen under isometric tilt).
 *   - `lod2`: 1 open-ended 5-sided cone = 5 tris (-88.1%).
 */
export const FOLIAGE_PROTOTYPE_TRIANGLE_COUNTS: Readonly<
  Record<FoliagePrototypeKind, Readonly<Record<FoliageLodLevel, number>>>
> = {
  tree_trunk: { lod0: 24, lod1: 24, lod2: 24 },
  tree_broadleaved: { lod0: 240, lod1: 60, lod2: 20 },
  tree_needleleaved: { lod0: 42, lod1: 15, lod2: 5 },
};

/**
 * Screen-space projection thresholds with hysteresis bands for orthographic viewing.
 *
 * Under the application's orthographic camera (`camera.zoom` = CSS pixels per world meter),
 * an object of reference diameter `D` meters spans approximately `D * zoom` CSS pixels.
 * All threshold pairs maintain a hysteresis deadband (`enter < exit`) to prevent rapid
 * popping or oscillation when zooming near a boundary.
 */
export interface FoliageLodThresholds {
  /** Nominal broadleaf/conifer crown diameter in world meters (default 4.0 m). */
  canopyReferenceDiameterMeters: number;
  /** Nominal trunk base diameter in world meters (default 0.64 m). */
  trunkReferenceDiameterMeters: number;
  /** Drop from LOD0 -> LOD1 when projected canopy diameter falls below this CSS px value. */
  lod0ToLod1MaxCanopyPx: number;
  /** Upgrade from LOD1 -> LOD0 when projected canopy diameter reaches or exceeds this CSS px value. */
  lod1ToLod0MinCanopyPx: number;
  /** Drop from LOD1 -> LOD2 when projected canopy diameter falls below this CSS px value. */
  lod1ToLod2MaxCanopyPx: number;
  /** Upgrade from LOD2 -> LOD1 when projected canopy diameter reaches or exceeds this CSS px value. */
  lod2ToLod1MinCanopyPx: number;
  /** Hide trunks when projected trunk diameter falls below this CSS px value. */
  trunkHideMaxPx: number;
  /** Show trunks again when projected trunk diameter reaches or exceeds this CSS px value. */
  trunkShowMinPx: number;
}

/**
 * Provisional screen-space thresholds tuned for Twente orthographic zoom range (`0.15`–`16.0` px/m):
 * - Street / close inspection (`zoom >= 2.10`, canopy >= 8.4 px): `lod0` + trunks visible.
 * - Default neighborhood startup (`zoom = 1.20`, canopy = 4.8 px, trunk = 0.77 px): `lod1` + trunks visible.
 * - City / regional zoom-out (`zoom <= 0.75`, canopy <= 3.0 px, trunk <= 0.48 px): `lod2` + trunks suppressed.
 *
 * All values remain subject to owner visual inspection on hardware GPU.
 */
export const DEFAULT_FOLIAGE_LOD_THRESHOLDS: Readonly<FoliageLodThresholds> = {
  canopyReferenceDiameterMeters: 4.0,
  trunkReferenceDiameterMeters: 0.64,
  lod0ToLod1MaxCanopyPx: 7.2, // zoom < 1.80
  lod1ToLod0MinCanopyPx: 8.4, // zoom >= 2.10
  lod1ToLod2MaxCanopyPx: 3.0, // zoom < 0.75
  lod2ToLod1MinCanopyPx: 3.6, // zoom >= 0.90
  trunkHideMaxPx: 0.50, // zoom < ~0.78
  trunkShowMinPx: 0.60, // zoom >= ~0.94
};

export interface FoliageOptimizationConfig {
  /** Master enable/disable switch. When false, reverts to baseline LOD0 + trunks visible + frustum culling disabled. */
  enabled: boolean;
  /** 'auto' uses screen-space thresholds with hysteresis; explicit levels force a specific canopy LOD. */
  lodMode: FoliageLodMode;
  /** Enables screen-space suppression of trunk batches when trunks are sub-pixel. */
  trunkSuppressionEnabled: boolean;
  /** Enables conservative batch-level frustum culling for instanced foliage batches. */
  frustumCullingEnabled: boolean;
}

export const DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG: Readonly<FoliageOptimizationConfig> =
  {
    enabled: true,
    lodMode: 'auto',
    trunkSuppressionEnabled: true,
    frustumCullingEnabled: true,
  };

export interface FoliageRuntimeState {
  activeLod: FoliageLodLevel;
  trunksVisible: boolean;
  frustumCullingEnabled: boolean;
  effectiveZoom: number;
  canopyScreenDiameterPx: number;
  trunkScreenDiameterPx: number;
  optimizationEnabled: boolean;
  lodMode: FoliageLodMode;
}

export interface FoliageBatchTarget {
  mesh: THREE.InstancedMesh;
  prototypeKind: FoliagePrototypeKind;
  /** Original visibility flag from the tile/scene payload (normally true). */
  baseVisible: boolean;
}

export interface FoliageTelemetrySnapshot {
  activeLod: FoliageLodLevel;
  lodMode: FoliageLodMode;
  optimizationEnabled: boolean;
  trunksVisible: boolean;
  trunkSuppressionEnabled: boolean;
  frustumCullingEnabled: boolean;
  canopyScreenDiameterPx: number;
  trunkScreenDiameterPx: number;
  foliageLayerVisible: boolean;
  residentBatches: number;
  submittedBatches: number;
  frustumCulledBatches: number;
  suppressedTrunkBatches: number;
  residentTreeInstances: number;
  submittedTreeInstances: number;
  residentTrunkInstances: number;
  submittedTrunkInstances: number;
  residentCanopyInstances: number;
  submittedCanopyInstances: number;
  residentBroadleafInstances: number;
  residentConiferInstances: number;
  residentTriangles: number;
  submittedTriangles: number;
  baselineLod0ResidentTriangles: number;
  triangleReductionVsLod0Pct: number;
  sharedPrototypeGeometries: number;
  sharedPrototypeBufferBytes: number;
}

export const CONSERVATIVE_FOLIAGE_BOUNDS_MARGIN_METERS = 0.25;

/**
 * Returns the exact triangle count of a BufferGeometry (handling both indexed and non-indexed buffers).
 */
export function getGeometryTriangleCount(geometry: THREE.BufferGeometry): number {
  if (geometry.index) {
    return Math.floor(geometry.index.count / 3);
  }
  const pos = geometry.attributes.position;
  return pos ? Math.floor(pos.count / 3) : 0;
}

/**
 * Estimates CPU typed-array byte size for a BufferGeometry.
 */
export function estimateBufferGeometryBytes(geometry: THREE.BufferGeometry): number {
  let bytes = 0;
  for (const attr of Object.values(geometry.attributes)) {
    if (attr && 'array' in attr && attr.array) {
      bytes += attr.array.byteLength;
    }
  }
  if (geometry.index?.array) {
    bytes += geometry.index.array.byteLength;
  }
  return bytes;
}

/**
 * Builds an individual foliage prototype BufferGeometry for the given kind and LOD level.
 *
 * `lod0` geometries match the existing baseline implementations in `GeometryBuilder.ts`
 * and `TileSceneReconstructor.ts` bit-for-bit in construction parameters.
 */
export function buildFoliagePrototypeGeometry(
  kind: FoliagePrototypeKind,
  lod: FoliageLodLevel
): THREE.BufferGeometry {
  if (kind === 'tree_trunk') {
    const g = new THREE.CylinderGeometry(0.18, 0.32, 2.5, 6);
    g.translate(0, 1.25, 0);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  if (kind === 'tree_broadleaved') {
    if (lod === 'lod0') {
      const lobeMain = new THREE.IcosahedronGeometry(1.75, 1);
      lobeMain.translate(0, 3.8, 0);
      const lobeLeft = new THREE.IcosahedronGeometry(1.3, 1);
      lobeLeft.translate(-0.85, 3.25, 0.5);
      const lobeRight = new THREE.IcosahedronGeometry(1.35, 1);
      lobeRight.translate(0.8, 3.35, -0.45);
      const merged = mergeGeometries([lobeMain, lobeLeft, lobeRight], false)!;
      lobeMain.dispose();
      lobeLeft.dispose();
      lobeRight.dispose();
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      return merged;
    }

    if (lod === 'lod1') {
      // Three unsubdivided icosahedrons (60 tris total, -75% vs LOD0):
      // preserves the exact 3-lobe broadleaf silhouette while using 25% fewer
      // triangles than a single detail=1 icosahedron (80 tris).
      const lobeMain = new THREE.IcosahedronGeometry(1.75, 0);
      lobeMain.translate(0, 3.8, 0);
      const lobeLeft = new THREE.IcosahedronGeometry(1.3, 0);
      lobeLeft.translate(-0.85, 3.25, 0.5);
      const lobeRight = new THREE.IcosahedronGeometry(1.35, 0);
      lobeRight.translate(0.8, 3.35, -0.45);
      const merged = mergeGeometries([lobeMain, lobeLeft, lobeRight], false)!;
      lobeMain.dispose();
      lobeLeft.dispose();
      lobeRight.dispose();
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      return merged;
    }

    // lod2: single low-poly icosahedron crown (20 tris, -91.7% vs LOD0),
    // proportioned to match the 3-lobe footprint while staying strictly inside LOD0 bounds.
    const single = new THREE.IcosahedronGeometry(1.95, 0);
    single.scale(1.05, 0.9, 0.9);
    single.translate(0, 3.75, 0);
    single.computeBoundingBox();
    single.computeBoundingSphere();
    return single;
  }

  // kind === 'tree_needleleaved'
  if (lod === 'lod0') {
    const tierBottom = new THREE.ConeGeometry(1.85, 2.5, 7);
    tierBottom.translate(0, 3.0, 0);
    const tierMid = new THREE.ConeGeometry(1.4, 2.2, 7);
    tierMid.translate(0, 4.3, 0);
    const tierTop = new THREE.ConeGeometry(0.95, 1.8, 7);
    tierTop.translate(0, 5.4, 0);
    const merged = mergeGeometries([tierBottom, tierMid, tierTop], false)!;
    tierBottom.dispose();
    tierMid.dispose();
    tierTop.dispose();
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }

  if (lod === 'lod1') {
    // 3 open-ended 5-sided cones (15 tris, -64.3% vs LOD0):
    // preserves the tiered pine silhouette while eliminating hidden underside caps.
    const tierBottom = new THREE.ConeGeometry(1.85, 2.5, 5, 1, true);
    tierBottom.translate(0, 3.0, 0);
    const tierMid = new THREE.ConeGeometry(1.4, 2.2, 5, 1, true);
    tierMid.translate(0, 4.3, 0);
    const tierTop = new THREE.ConeGeometry(0.95, 1.8, 5, 1, true);
    tierTop.translate(0, 5.4, 0);
    const merged = mergeGeometries([tierBottom, tierMid, tierTop], false)!;
    tierBottom.dispose();
    tierMid.dispose();
    tierTop.dispose();
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }

  // lod2: single open-ended 5-sided cone spanning exact vertical envelope y in [1.75, 6.30] (5 tris, -88.1% vs LOD0).
  const singleCone = new THREE.ConeGeometry(1.85, 4.55, 5, 1, true);
  singleCone.translate(0, 4.025, 0);
  singleCone.computeBoundingBox();
  singleCone.computeBoundingSphere();
  return singleCone;
}

const cachedUnionLocalBoundsArrays = new Map<
  FoliagePrototypeKind,
  readonly [number, number, number, number, number, number]
>();

/**
 * Worker-safe helper returning the exact union local-space AABB `[minX, minY, minZ, maxX, maxY, maxZ]`
 * across all LOD variants (`lod0`..`lod2`) for a foliage prototype kind.
 *
 * Uses the exact same `buildFoliagePrototypeGeometry` definitions as `FoliagePrototypeRegistry`
 * so worker-side `InstancedSpatialIndex` BVH construction matches main-thread bounds bit-for-bit.
 */
export function computeFoliagePrototypeUnionLocalBoundsArray(
  kind: FoliagePrototypeKind
): readonly [number, number, number, number, number, number] {
  const cached = cachedUnionLocalBoundsArrays.get(kind);
  if (cached) return cached;

  const unionBox = new THREE.Box3();
  const lods: readonly FoliageLodLevel[] =
    kind === 'tree_trunk' ? ['lod0'] : FOLIAGE_LOD_LEVELS;
  for (const lod of lods) {
    const geo = buildFoliagePrototypeGeometry(kind, lod);
    if (geo.boundingBox) {
      unionBox.union(geo.boundingBox);
    }
    geo.dispose();
  }
  const tuple: readonly [number, number, number, number, number, number] = [
    unionBox.min.x,
    unionBox.min.y,
    unionBox.min.z,
    unionBox.max.x,
    unionBox.max.y,
    unionBox.max.z,
  ];
  cachedUnionLocalBoundsArrays.set(kind, tuple);
  return tuple;
}

/**
 * Shared registry owning the small fixed set of foliage prototype `BufferGeometry` objects
 * across all loaded tiles (7 unique GPU buffers total across the entire regional mosaic:
 * 1 trunk + 3 broadleaf LODs + 3 conifer LODs).
 *
 * Parallel to `ThemeMaterialRegistry`: tiles reference these shared geometries and never
 * dispose them individually on tile eviction. The owner (`TileStreamManager` or a standalone
 * `BuiltSceneGeometry`) disposes the registry once on teardown.
 */
export class FoliagePrototypeRegistry {
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly unionLocalBounds = new Map<FoliagePrototypeKind, THREE.Box3>();
  private isDisposed = false;

  constructor() {
    this.initializeAllPrototypes();
  }

  private initializeAllPrototypes(): void {
    // Trunk uses a single shared geometry regardless of canopy LOD (suppressed via visibility).
    const trunkGeo = buildFoliagePrototypeGeometry('tree_trunk', 'lod0');
    this.geometries.set('tree_trunk:lod0', trunkGeo);
    this.unionLocalBounds.set(
      'tree_trunk',
      trunkGeo.boundingBox!.clone()
    );

    for (const kind of ['tree_broadleaved', 'tree_needleleaved'] as const) {
      const unionBox = new THREE.Box3();
      for (const lod of FOLIAGE_LOD_LEVELS) {
        const geo = buildFoliagePrototypeGeometry(kind, lod);
        this.geometries.set(`${kind}:${lod}`, geo);
        if (geo.boundingBox) {
          unionBox.union(geo.boundingBox);
        }
      }
      this.unionLocalBounds.set(kind, unionBox);
    }
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  get geometryCount(): number {
    return this.geometries.size;
  }

  get cpuBufferBytes(): number {
    let total = 0;
    for (const geo of this.geometries.values()) {
      total += estimateBufferGeometryBytes(geo);
    }
    return total;
  }

  getGeometry(
    kind: FoliagePrototypeKind,
    lod: FoliageLodLevel
  ): THREE.BufferGeometry {
    if (this.isDisposed) {
      throw new Error('FoliagePrototypeRegistry has been disposed.');
    }
    const key = kind === 'tree_trunk' ? 'tree_trunk:lod0' : `${kind}:${lod}`;
    const geo = this.geometries.get(key);
    if (!geo) {
      throw new Error(`Missing foliage prototype geometry for ${key}`);
    }
    return geo;
  }

  /**
   * Returns a read-only reference to the union local-space AABB enclosing all LOD variants
   * for the specified foliage prototype kind. Used to compute conservative batch bounds that
   * remain valid across every LOD swap without recomputation.
   */
  getUnionLocalBounds(kind: FoliagePrototypeKind): THREE.Box3 {
    const box = this.unionLocalBounds.get(kind);
    if (!box) {
      throw new Error(`Missing foliage union local bounds for ${kind}`);
    }
    return box;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    for (const geo of this.geometries.values()) {
      geo.dispose();
    }
    this.geometries.clear();
    this.unionLocalBounds.clear();
  }
}

export function normalizeFoliageOptimizationConfig(
  partial?: Partial<FoliageOptimizationConfig> | null
): FoliageOptimizationConfig {
  const lodMode: FoliageLodMode =
    partial?.lodMode === 'lod0' ||
    partial?.lodMode === 'lod1' ||
    partial?.lodMode === 'lod2' ||
    partial?.lodMode === 'auto'
      ? partial.lodMode
      : DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG.lodMode;
  return {
    enabled:
      typeof partial?.enabled === 'boolean'
        ? partial.enabled
        : DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG.enabled,
    lodMode,
    trunkSuppressionEnabled:
      typeof partial?.trunkSuppressionEnabled === 'boolean'
        ? partial.trunkSuppressionEnabled
        : DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG.trunkSuppressionEnabled,
    frustumCullingEnabled:
      typeof partial?.frustumCullingEnabled === 'boolean'
        ? partial.frustumCullingEnabled
        : DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG.frustumCullingEnabled,
  };
}

export function equalFoliageOptimizationConfig(
  a: FoliageOptimizationConfig,
  b: FoliageOptimizationConfig
): boolean {
  return (
    a.enabled === b.enabled &&
    a.lodMode === b.lodMode &&
    a.trunkSuppressionEnabled === b.trunkSuppressionEnabled &&
    a.frustumCullingEnabled === b.frustumCullingEnabled
  );
}

/**
 * Pure deterministic resolver for foliage LOD level, trunk visibility, and frustum culling.
 *
 * Uses orthographic screen-space projection (`projectedPx = referenceDiameterMeters * zoom`)
 * with hysteresis against `previousState` so zooming near a boundary does not flicker.
 */
export function resolveFoliageRuntimeState(
  cameraZoom: number,
  previousState: FoliageRuntimeState | null,
  config: FoliageOptimizationConfig = DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG,
  thresholds: FoliageLodThresholds = DEFAULT_FOLIAGE_LOD_THRESHOLDS
): FoliageRuntimeState {
  const effectiveZoom =
    Number.isFinite(cameraZoom) && cameraZoom > 0 ? cameraZoom : 1.0;
  const canopyScreenDiameterPx =
    thresholds.canopyReferenceDiameterMeters * effectiveZoom;
  const trunkScreenDiameterPx =
    thresholds.trunkReferenceDiameterMeters * effectiveZoom;

  if (!config.enabled) {
    return {
      activeLod: 'lod0',
      trunksVisible: true,
      frustumCullingEnabled: false,
      effectiveZoom,
      canopyScreenDiameterPx,
      trunkScreenDiameterPx,
      optimizationEnabled: false,
      lodMode: config.lodMode,
    };
  }

  let activeLod: FoliageLodLevel;
  if (config.lodMode !== 'auto') {
    activeLod = config.lodMode;
  } else if (!previousState) {
    // Cold start uses hysteresis midpoints for deterministic initial state
    const mid01 =
      (thresholds.lod0ToLod1MaxCanopyPx + thresholds.lod1ToLod0MinCanopyPx) *
      0.5;
    const mid12 =
      (thresholds.lod1ToLod2MaxCanopyPx + thresholds.lod2ToLod1MinCanopyPx) *
      0.5;
    if (canopyScreenDiameterPx >= mid01) {
      activeLod = 'lod0';
    } else if (canopyScreenDiameterPx >= mid12) {
      activeLod = 'lod1';
    } else {
      activeLod = 'lod2';
    }
  } else {
    const prev = previousState.activeLod;
    if (prev === 'lod0') {
      if (canopyScreenDiameterPx < thresholds.lod1ToLod2MaxCanopyPx) {
        activeLod = 'lod2';
      } else if (canopyScreenDiameterPx < thresholds.lod0ToLod1MaxCanopyPx) {
        activeLod = 'lod1';
      } else {
        activeLod = 'lod0';
      }
    } else if (prev === 'lod1') {
      if (canopyScreenDiameterPx >= thresholds.lod1ToLod0MinCanopyPx) {
        activeLod = 'lod0';
      } else if (canopyScreenDiameterPx < thresholds.lod1ToLod2MaxCanopyPx) {
        activeLod = 'lod2';
      } else {
        activeLod = 'lod1';
      }
    } else {
      // prev === 'lod2'
      if (canopyScreenDiameterPx >= thresholds.lod1ToLod0MinCanopyPx) {
        activeLod = 'lod0';
      } else if (canopyScreenDiameterPx >= thresholds.lod2ToLod1MinCanopyPx) {
        activeLod = 'lod1';
      } else {
        activeLod = 'lod2';
      }
    }
  }

  let trunksVisible: boolean;
  if (!config.trunkSuppressionEnabled) {
    trunksVisible = true;
  } else if (!previousState) {
    const midTrunk = (thresholds.trunkHideMaxPx + thresholds.trunkShowMinPx) * 0.5;
    trunksVisible = trunkScreenDiameterPx >= midTrunk;
  } else if (previousState.trunksVisible) {
    trunksVisible = trunkScreenDiameterPx >= thresholds.trunkHideMaxPx;
  } else {
    trunksVisible = trunkScreenDiameterPx >= thresholds.trunkShowMinPx;
  }

  return {
    activeLod,
    trunksVisible,
    frustumCullingEnabled: config.frustumCullingEnabled,
    effectiveZoom,
    canopyScreenDiameterPx,
    trunkScreenDiameterPx,
    optimizationEnabled: true,
    lodMode: config.lodMode,
  };
}

/**
 * Computes exact conservative mesh-local `boundingBox` and `boundingSphere` for an
 * `InstancedMesh` from its raw column-major 4×4 `instanceMatrix` Float32Array and the
 * union prototype local AABB across all LOD tiers.
 *
 * Uses Arvo's exact affine-matrix-by-AABB transform (18 multiplies per instance, zero
 * per-instance heap allocations), then expands all 6 faces by `marginMeters` (default
 * 0.25 m) so trees can never be prematurely frustum-culled near viewport edges under any
 * rotation, scale, canopy overhang, LOD swap, or regional coordinate offset.
 */
export function computeConservativeInstancedBounds(
  matrices: Float32Array,
  instanceCount: number,
  unionPrototypeLocalBox: THREE.Box3,
  marginMeters = CONSERVATIVE_FOLIAGE_BOUNDS_MARGIN_METERS
): { boundingBox: THREE.Box3; boundingSphere: THREE.Sphere } {
  const count = Math.min(instanceCount, Math.floor(matrices.length / 16));
  if (count <= 0 || unionPrototypeLocalBox.isEmpty()) {
    const emptyBox = new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 0)
    );
    return {
      boundingBox: emptyBox,
      boundingSphere: new THREE.Sphere(new THREE.Vector3(0, 0, 0), 0),
    };
  }

  const lMinX = unionPrototypeLocalBox.min.x;
  const lMinY = unionPrototypeLocalBox.min.y;
  const lMinZ = unionPrototypeLocalBox.min.z;
  const lMaxX = unionPrototypeLocalBox.max.x;
  const lMaxY = unionPrototypeLocalBox.max.y;
  const lMaxZ = unionPrototypeLocalBox.max.z;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < count; i++) {
    const o = i * 16;
    // Column-major 4x4 matrix elements:
    // col0 = (e0, e1, e2), col1 = (e4, e5, e6), col2 = (e8, e9, e10), tx = (e12, e13, e14)
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

    // Row 0 (X)
    const xa0 = e0 * lMinX;
    const xb0 = e0 * lMaxX;
    const xa1 = e4 * lMinY;
    const xb1 = e4 * lMaxY;
    const xa2 = e8 * lMinZ;
    const xb2 = e8 * lMaxZ;
    const iMinX =
      tx +
      (xa0 < xb0 ? xa0 : xb0) +
      (xa1 < xb1 ? xa1 : xb1) +
      (xa2 < xb2 ? xa2 : xb2);
    const iMaxX =
      tx +
      (xa0 > xb0 ? xa0 : xb0) +
      (xa1 > xb1 ? xa1 : xb1) +
      (xa2 > xb2 ? xa2 : xb2);

    // Row 1 (Y)
    const ya0 = e1 * lMinX;
    const yb0 = e1 * lMaxX;
    const ya1 = e5 * lMinY;
    const yb1 = e5 * lMaxY;
    const ya2 = e9 * lMinZ;
    const yb2 = e9 * lMaxZ;
    const iMinY =
      ty +
      (ya0 < yb0 ? ya0 : yb0) +
      (ya1 < yb1 ? ya1 : yb1) +
      (ya2 < yb2 ? ya2 : yb2);
    const iMaxY =
      ty +
      (ya0 > yb0 ? ya0 : yb0) +
      (ya1 > yb1 ? ya1 : yb1) +
      (ya2 > yb2 ? ya2 : yb2);

    // Row 2 (Z)
    const za0 = e2 * lMinX;
    const zb0 = e2 * lMaxX;
    const za1 = e6 * lMinY;
    const zb1 = e6 * lMaxY;
    const za2 = e10 * lMinZ;
    const zb2 = e10 * lMaxZ;
    const iMinZ =
      tz +
      (za0 < zb0 ? za0 : zb0) +
      (za1 < zb1 ? za1 : zb1) +
      (za2 < zb2 ? za2 : zb2);
    const iMaxZ =
      tz +
      (za0 > zb0 ? za0 : zb0) +
      (za1 > zb1 ? za1 : zb1) +
      (za2 > zb2 ? za2 : zb2);

    if (iMinX < minX) minX = iMinX;
    if (iMinY < minY) minY = iMinY;
    if (iMinZ < minZ) minZ = iMinZ;
    if (iMaxX > maxX) maxX = iMaxX;
    if (iMaxY > maxY) maxY = iMaxY;
    if (iMaxZ > maxZ) maxZ = iMaxZ;
  }

  const m = Math.max(0, marginMeters);
  const boundingBox = new THREE.Box3(
    new THREE.Vector3(minX - m, minY - m, minZ - m),
    new THREE.Vector3(maxX + m, maxY + m, maxZ + m)
  );
  const boundingSphere = boundingBox.getBoundingSphere(new THREE.Sphere());
  return { boundingBox, boundingSphere };
}

/**
 * Applies the resolved foliage LOD, trunk visibility, and frustum culling state to a
 * collection of foliage `InstancedMesh` batches in O(batches) with zero allocations.
 *
 * Strictly preserves `instanceMatrix`, `instanceColor`, `userData.instanceInfos`,
 * canopy visibility, and conservative bounding volumes.
 */
export function applyFoliageRuntimeStateToBatches(
  batches: readonly FoliageBatchTarget[],
  state: FoliageRuntimeState,
  registry: FoliagePrototypeRegistry
): void {
  if (registry.disposed) return;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const { mesh, prototypeKind, baseVisible } = batch;
    mesh.frustumCulled = state.frustumCullingEnabled;

    if (prototypeKind === 'tree_trunk') {
      mesh.visible = baseVisible && state.trunksVisible;
      continue;
    }

    const nextGeo = registry.getGeometry(prototypeKind, state.activeLod);
    if (mesh.geometry !== nextGeo) {
      mesh.geometry = nextGeo;
    }
    mesh.visible = baseVisible;
  }
}

function inferFoliagePrototypeKind(
  mesh: THREE.InstancedMesh
): FoliagePrototypeKind | null {
  const tagged = mesh.userData?.foliagePrototypeKind;
  if (typeof tagged === 'string' && isFoliagePrototypeKind(tagged)) {
    return tagged;
  }
  const lower = mesh.name.toLowerCase();
  if (lower.includes('trunk')) return 'tree_trunk';
  if (lower.includes('broadleaved') || lower.includes('broadleaf')) {
    return 'tree_broadleaved';
  }
  if (lower.includes('needleleaved') || lower.includes('conifer')) {
    return 'tree_needleleaved';
  }
  return null;
}

function isObjectHierarchyVisible(
  obj: THREE.Object3D,
  stopAt?: THREE.Object3D
): boolean {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (!cur.visible) return false;
    if (cur === stopAt) break;
    cur = cur.parent;
  }
  return true;
}

const _frustum = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();

/**
 * Computes an exact telemetry snapshot of resident vs. frustum-submitted foliage batches,
 * instances, and triangles under the active camera.
 *
 * Uses the exact same `THREE.Frustum.intersectsObject(mesh)` test that `WebGLRenderer`
 * executes per draw call so telemetry reflects true GPU submission counts.
 */
export function computeFoliageTelemetrySnapshot(
  foliageRoot: THREE.Object3D | null,
  camera: THREE.Camera | null,
  state: FoliageRuntimeState,
  config: FoliageOptimizationConfig,
  registry?: FoliagePrototypeRegistry | null
): FoliageTelemetrySnapshot {
  let residentBatches = 0;
  let submittedBatches = 0;
  let frustumCulledBatches = 0;
  let suppressedTrunkBatches = 0;

  let residentTrunkInstances = 0;
  let submittedTrunkInstances = 0;
  let residentCanopyInstances = 0;
  let submittedCanopyInstances = 0;
  let residentBroadleafInstances = 0;
  let residentConiferInstances = 0;

  let residentTriangles = 0;
  let submittedTriangles = 0;
  let baselineLod0ResidentTriangles = 0;

  const foliageLayerVisible = foliageRoot
    ? isObjectHierarchyVisible(foliageRoot)
    : false;

  let hasCameraFrustum = false;
  if (camera) {
    camera.updateMatrixWorld();
    _projScreenMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    );
    _frustum.setFromProjectionMatrix(_projScreenMatrix);
    hasCameraFrustum = true;
  }

  if (foliageRoot) {
    foliageRoot.traverse((obj) => {
      if (!(obj instanceof THREE.InstancedMesh)) return;
      const kind = inferFoliagePrototypeKind(obj);
      if (!kind) return;

      const count = obj.count;
      const trisPerInstance = getGeometryTriangleCount(obj.geometry);
      const batchTris = trisPerInstance * count;
      const lod0Tris = FOLIAGE_PROTOTYPE_TRIANGLE_COUNTS[kind].lod0 * count;

      residentBatches += 1;
      residentTriangles += batchTris;
      baselineLod0ResidentTriangles += lod0Tris;

      if (kind === 'tree_trunk') {
        residentTrunkInstances += count;
      } else {
        residentCanopyInstances += count;
        if (kind === 'tree_broadleaved') {
          residentBroadleafInstances += count;
        } else {
          residentConiferInstances += count;
        }
      }

      if (!foliageLayerVisible) {
        return;
      }

      if (!obj.visible) {
        if (kind === 'tree_trunk' && !state.trunksVisible) {
          suppressedTrunkBatches += 1;
        }
        return;
      }

      // Check parent groups between obj and foliageRoot (e.g. per-tile foliage group)
      if (obj.parent && !isObjectHierarchyVisible(obj.parent, foliageRoot)) {
        return;
      }

      if (obj.frustumCulled && hasCameraFrustum) {
        if (!_frustum.intersectsObject(obj)) {
          frustumCulledBatches += 1;
          return;
        }
      }

      submittedBatches += 1;
      submittedTriangles += batchTris;
      if (kind === 'tree_trunk') {
        submittedTrunkInstances += count;
      } else {
        submittedCanopyInstances += count;
      }
    });
  }

  const residentTreeInstances = Math.max(
    residentCanopyInstances,
    residentTrunkInstances
  );
  const submittedTreeInstances = Math.max(
    submittedCanopyInstances,
    submittedTrunkInstances
  );

  const triangleReductionVsLod0Pct =
    baselineLod0ResidentTriangles > 0
      ? Number(
          (
            ((baselineLod0ResidentTriangles - submittedTriangles) /
              baselineLod0ResidentTriangles) *
            100
          ).toFixed(1)
        )
      : 0;

  return {
    activeLod: state.activeLod,
    lodMode: state.lodMode,
    optimizationEnabled: state.optimizationEnabled,
    trunksVisible: state.trunksVisible,
    trunkSuppressionEnabled: config.trunkSuppressionEnabled,
    frustumCullingEnabled: state.frustumCullingEnabled,
    canopyScreenDiameterPx: Number(state.canopyScreenDiameterPx.toFixed(2)),
    trunkScreenDiameterPx: Number(state.trunkScreenDiameterPx.toFixed(2)),
    foliageLayerVisible,
    residentBatches,
    submittedBatches,
    frustumCulledBatches,
    suppressedTrunkBatches,
    residentTreeInstances,
    submittedTreeInstances,
    residentTrunkInstances,
    submittedTrunkInstances,
    residentCanopyInstances,
    submittedCanopyInstances,
    residentBroadleafInstances,
    residentConiferInstances,
    residentTriangles,
    submittedTriangles,
    baselineLod0ResidentTriangles,
    triangleReductionVsLod0Pct,
    sharedPrototypeGeometries: registry && !registry.disposed ? registry.geometryCount : 0,
    sharedPrototypeBufferBytes: registry && !registry.disposed ? registry.cpuBufferBytes : 0,
  };
}

/**
 * Parses optional foliage optimization query parameters for reproducible manual or
 * benchmark runs:
 * - `foliageOpt=0|1|false|true`
 * - `foliageLod=auto|lod0|lod1|lod2`
 * - `foliageTrunks=0|1|false|true` (controls `trunkSuppressionEnabled`: `0` disables suppression, `1` enables suppression; `foliageTrunkSuppress` alias also supported)
 * - `foliageCull=0|1|false|true`
 */
export function parseFoliageOptimizationConfigFromSearch(
  search: string
): FoliageOptimizationConfig {
  const params = new URLSearchParams(search);
  const parseBool = (raw: string | null, fallback: boolean): boolean => {
    if (raw === null) return fallback;
    const norm = raw.trim().toLowerCase();
    if (norm === '0' || norm === 'false' || norm === 'off') return false;
    if (norm === '1' || norm === 'true' || norm === 'on') return true;
    return fallback;
  };

  const lodRaw = params.get('foliageLod')?.trim().toLowerCase();
  const lodMode: FoliageLodMode =
    lodRaw === 'lod0' || lodRaw === 'lod1' || lodRaw === 'lod2' || lodRaw === 'auto'
      ? lodRaw
      : DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG.lodMode;

  const trunkSuppressParam =
    params.get('foliageTrunkSuppress') ?? params.get('foliageTrunks');

  return {
    enabled: parseBool(
      params.get('foliageOpt'),
      DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG.enabled
    ),
    lodMode,
    trunkSuppressionEnabled: parseBool(
      trunkSuppressParam,
      DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG.trunkSuppressionEnabled
    ),
    frustumCullingEnabled: parseBool(
      params.get('foliageCull'),
      DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG.frustumCullingEnabled
    ),
  };
}
