import * as THREE from 'three';
import type { RailwayVisibilityStatus } from '../../types/BenchmarkTelemetry';

export interface CachedRailwayMeshEntry {
  mesh: THREE.Mesh;
  /** Chain from mesh up to (inclusive of) the cached railway root group for O(depth) visibility checks without .traverse() */
  visibilityChain: THREE.Object3D[];
  isInstanced: boolean;
  baseTriangleCount: number;
  frustumCulled: boolean;
  localBoundingSphere: THREE.Sphere;
}

export interface CachedRailwayIndex {
  rootGroup: THREE.Object3D | null;
  entries: CachedRailwayMeshEntry[];
  staticMeshCount: number;
  staticTriangleCount: number;
}

export interface RailwayVisibilitySample {
  status: RailwayVisibilityStatus;
  staticRailwayMeshes: number;
  staticRailwayTriangles: number;
  activeRailwayMeshes: number | null;
  frustumCulledRailwayMeshes: number | null;
  frustumVisibleRailwayTriangles: number | null;
}

function computeMeshBaseTriangleCount(geo: THREE.BufferGeometry | undefined): number {
  if (!geo) return 0;
  if (geo.index) {
    return Math.round(geo.index.count / 3);
  }
  const pos = geo.attributes.position;
  return pos ? Math.round(pos.count / 3) : 0;
}

function computeInstancedCount(mesh: THREE.Mesh, isInstanced: boolean): number {
  if (!isInstanced) return 1;
  const inst = mesh as unknown as THREE.InstancedMesh;
  return Math.max(0, inst.count || 0);
}

/**
 * Builds a flat, zero-traversal-during-useFrame cache of railway meshes inside `railwaysGroup`.
 * Called only when `activeRailwaysGroup` or `builtGeometry` changes.
 */
export function buildCachedRailwayIndex(
  railwaysGroup: THREE.Object3D | null | undefined
): CachedRailwayIndex {
  if (!railwaysGroup) {
    return {
      rootGroup: null,
      entries: [],
      staticMeshCount: 0,
      staticTriangleCount: 0,
    };
  }

  const entries: CachedRailwayMeshEntry[] = [];
  let staticMeshCount = 0;
  let staticTriangleCount = 0;

  railwaysGroup.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    const isInstanced = (mesh as unknown as THREE.InstancedMesh).isInstancedMesh === true;
    const instMesh = mesh as unknown as THREE.InstancedMesh;
    const baseTriangleCount = computeMeshBaseTriangleCount(mesh.geometry);
    const instCount = computeInstancedCount(mesh, isInstanced);

    staticMeshCount++;
    staticTriangleCount += baseTriangleCount * instCount;

    const visibilityChain: THREE.Object3D[] = [];
    let cur: THREE.Object3D | null = mesh;
    while (cur) {
      visibilityChain.push(cur);
      if (cur === railwaysGroup) break;
      cur = cur.parent;
    }

    let localBoundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    if (isInstanced) {
      if (!instMesh.boundingSphere) {
        instMesh.computeBoundingSphere();
      }
      if (instMesh.boundingSphere) {
        localBoundingSphere = instMesh.boundingSphere.clone();
      }
    } else if (mesh.geometry) {
      if (!mesh.geometry.boundingSphere) {
        mesh.geometry.computeBoundingSphere();
      }
      if (mesh.geometry.boundingSphere) {
        localBoundingSphere = mesh.geometry.boundingSphere.clone();
      }
    }

    entries.push({
      mesh,
      visibilityChain,
      isInstanced,
      baseTriangleCount,
      frustumCulled: mesh.frustumCulled,
      localBoundingSphere,
    });
  });

  return {
    rootGroup: railwaysGroup,
    entries,
    staticMeshCount,
    staticTriangleCount,
  };
}

const _projScreenMatrix = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _worldSphere = new THREE.Sphere();

/**
 * Evaluates frustum visibility over a precomputed CachedRailwayIndex with zero scene traversal
 * and zero per-frame allocations.
 */
export function evaluateCachedRailwayVisibility(params: {
  index: CachedRailwayIndex | null;
  camera: THREE.Camera;
  showRailways: boolean;
  shouldSample: boolean;
}): RailwayVisibilitySample {
  const { index, camera, showRailways, shouldSample } = params;

  if (!showRailways) {
    return {
      status: 'disabled_by_config',
      staticRailwayMeshes: index?.staticMeshCount ?? 0,
      staticRailwayTriangles: index?.staticTriangleCount ?? 0,
      activeRailwayMeshes: 0,
      frustumCulledRailwayMeshes: 0,
      frustumVisibleRailwayTriangles: 0,
    };
  }

  if (!index || !index.rootGroup) {
    return {
      status: 'unavailable',
      staticRailwayMeshes: 0,
      staticRailwayTriangles: 0,
      activeRailwayMeshes: null,
      frustumCulledRailwayMeshes: null,
      frustumVisibleRailwayTriangles: null,
    };
  }

  if (!shouldSample) {
    return {
      status: 'unsampled',
      staticRailwayMeshes: index.staticMeshCount,
      staticRailwayTriangles: index.staticTriangleCount,
      activeRailwayMeshes: null,
      frustumCulledRailwayMeshes: null,
      frustumVisibleRailwayTriangles: null,
    };
  }

  if (index.entries.length === 0) {
    return {
      status: 'measured',
      staticRailwayMeshes: 0,
      staticRailwayTriangles: 0,
      activeRailwayMeshes: 0,
      frustumCulledRailwayMeshes: 0,
      frustumVisibleRailwayTriangles: 0,
    };
  }

  camera.updateMatrixWorld();
  _projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_projScreenMatrix);

  let activeRailwayMeshes = 0;
  let frustumCulledRailwayMeshes = 0;
  let frustumVisibleRailwayTriangles = 0;

  for (let i = 0; i < index.entries.length; i++) {
    const entry = index.entries[i];
    let chainVisible = true;
    for (let j = 0; j < entry.visibilityChain.length; j++) {
      if (!entry.visibilityChain[j].visible) {
        chainVisible = false;
        break;
      }
    }
    if (!chainVisible) continue;

    // Also verify parent chain above rootGroup if rootGroup is nested under hidden groups
    let ancestor = index.rootGroup.parent;
    while (ancestor) {
      if (!ancestor.visible) {
        chainVisible = false;
        break;
      }
      ancestor = ancestor.parent;
    }
    if (!chainVisible) continue;

    const instCount = computeInstancedCount(entry.mesh, entry.isInstanced);
    const tris = entry.baseTriangleCount * instCount;

    let inFrustum = true;
    if (entry.mesh.frustumCulled && Number.isFinite(entry.localBoundingSphere.radius)) {
      _worldSphere.copy(entry.localBoundingSphere).applyMatrix4(entry.mesh.matrixWorld);
      inFrustum = _frustum.intersectsSphere(_worldSphere);
    }

    if (inFrustum) {
      activeRailwayMeshes++;
      frustumVisibleRailwayTriangles += tris;
    } else {
      frustumCulledRailwayMeshes++;
    }
  }

  return {
    status: 'measured',
    staticRailwayMeshes: index.staticMeshCount,
    staticRailwayTriangles: index.staticTriangleCount,
    activeRailwayMeshes,
    frustumCulledRailwayMeshes,
    frustumVisibleRailwayTriangles,
  };
}
