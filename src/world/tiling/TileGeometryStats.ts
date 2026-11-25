import type * as THREE from 'three';
import type {
  DecodedTilePayload,
  TileInstancedBatchRecord,
  TileMeshRecord,
  TilePrototypeKind,
} from './TilePackContract';
import {
  FOLIAGE_PROTOTYPE_TRIANGLE_COUNTS,
  type FoliageLodLevel,
} from '../FoliageLodSystem';

/**
 * Triangle count of the 3D railway sleeper BoxGeometry(0.24, 0.14, 2.50)
 * reconstructed by TileSceneReconstructor.
 */
export const SLEEPER_3D_PROTOTYPE_TRIANGLES = 12;

/**
 * Vertex count of the 3D railway sleeper BoxGeometry(0.24, 0.14, 2.50).
 */
export const SLEEPER_3D_PROTOTYPE_VERTICES = 24;

/**
 * Approximate vertex counts for the LOD0 foliage prototypes reconstructed at runtime.
 * Kept aligned with FoliagePrototypeRegistry LOD0 geometries.
 */
export const FOLIAGE_LOD0_PROTOTYPE_VERTICES: Readonly<
  Record<'tree_trunk' | 'tree_broadleaved' | 'tree_needleleaved', number>
> = Object.freeze({
  tree_trunk: 28,
  tree_broadleaved: 720,
  tree_needleleaved: 72,
});

export interface ComputedTileGeometryStats {
  staticMeshCount: number;
  instancedBatchCount: number;
  staticTriangles: number;
  staticVertices: number;
  staticDrawCalls: number;
  instancedTriangles: number;
  instancedVertices: number;
  instancedDrawCalls: number;
  totalTriangles: number;
  totalVertices: number;
  totalDrawCalls: number;
  totalInstances: number;
  foliageInstanceCount: number;
  sleeperInstanceCount: number;
  byLayer: Record<
    string,
    {
      meshCount: number;
      instancedBatchCount: number;
      drawCalls: number;
      triangles: number;
      vertices: number;
      instances: number;
    }
  >;
}

export interface TileStatsComparison {
  /** Metadata stored in the OSMTILE1 header (may reflect legacy pre-TKT-037 counting). */
  storedMetadata: {
    totalTriangles: number;
    totalVertices: number;
    totalDrawCalls: number;
  };
  /** Authoritative geometry counts derived directly from decoded mesh buffers and instance prototypes. */
  computedFromBuffers: ComputedTileGeometryStats;
  /** Signed difference: computed - stored (positive indicates legacy under-counting). */
  triangleDelta: number;
  vertexDelta: number;
  drawCallDelta: number;
}

/**
 * Computes exact triangle count for a Three.js BufferGeometry, handling both
 * indexed and non-indexed buffers safely.
 */
export function getBufferGeometryTriangleCount(
  geom: THREE.BufferGeometry | null | undefined
): number {
  if (!geom) return 0;
  if (geom.index) {
    return Math.floor(geom.index.count / 3);
  }
  const posAttr = geom.getAttribute('position');
  return posAttr ? Math.floor(posAttr.count / 3) : 0;
}

/**
 * Computes exact triangle count for a decoded static TileMeshRecord directly from its buffers.
 */
export function getTileMeshRecordTriangleCount(mesh: TileMeshRecord): number {
  if (mesh.indices) {
    return Math.floor(mesh.indices.length / 3);
  }
  return Math.floor(mesh.positions.length / 9);
}

/**
 * Computes vertex count for a decoded static TileMeshRecord.
 */
export function getTileMeshRecordVertexCount(mesh: TileMeshRecord): number {
  return Math.floor(mesh.positions.length / 3);
}

/**
 * Computes the number of WebGL draw calls a static TileMeshRecord produces.
 * Multi-material meshes draw once per non-empty material group.
 */
export function getTileMeshRecordDrawCalls(mesh: TileMeshRecord): number {
  if (mesh.materialSlotKeys.length > 1 && mesh.groups.length > 0) {
    let activeGroups = 0;
    for (const g of mesh.groups) {
      if (g.count > 0) activeGroups++;
    }
    return Math.max(1, activeGroups);
  }
  return 1;
}

/**
 * Returns the exact triangle count per instance for an OSMTILE1 instanced prototype.
 */
export function getInstancedPrototypeTriangleCount(
  prototypeKind: TilePrototypeKind,
  foliageLod: FoliageLodLevel = 'lod0'
): number {
  if (prototypeKind === 'sleeper_box_unit') {
    return SLEEPER_3D_PROTOTYPE_TRIANGLES;
  }
  if (prototypeKind === 'none') {
    return 0;
  }
  return FOLIAGE_PROTOTYPE_TRIANGLE_COUNTS[prototypeKind][foliageLod];
}

/**
 * Returns the exact vertex count per instance for an OSMTILE1 LOD0 instanced prototype.
 */
export function getInstancedPrototypeVertexCount(prototypeKind: TilePrototypeKind): number {
  if (prototypeKind === 'sleeper_box_unit') {
    return SLEEPER_3D_PROTOTYPE_VERTICES;
  }
  if (prototypeKind === 'none') {
    return 0;
  }
  return FOLIAGE_LOD0_PROTOTYPE_VERTICES[prototypeKind];
}

/**
 * Computes exact triangle count for an instanced batch record at the given foliage LOD tier.
 */
export function getInstancedBatchTriangleCount(
  batch: TileInstancedBatchRecord,
  foliageLod: FoliageLodLevel = 'lod0'
): number {
  if (batch.instanceCount <= 0) return 0;
  return batch.instanceCount * getInstancedPrototypeTriangleCount(batch.prototypeKind, foliageLod);
}

/**
 * Derives authoritative geometry statistics directly from a DecodedTilePayload's
 * actual static mesh buffers and instanced batch records (never relying on stored
 * header counters that may have been produced by legacy non-indexed counting).
 */
export function computeDecodedTileGeometryStats(
  payload: DecodedTilePayload,
  foliageLod: FoliageLodLevel = 'lod0'
): ComputedTileGeometryStats {
  let staticTriangles = 0;
  let staticVertices = 0;
  let staticDrawCalls = 0;
  let instancedTriangles = 0;
  let instancedVertices = 0;
  let instancedDrawCalls = 0;
  let totalInstances = 0;
  let foliageInstanceCount = 0;
  let sleeperInstanceCount = 0;

  const byLayer: ComputedTileGeometryStats['byLayer'] = {};
  const ensureLayer = (layer: string) => {
    let entry = byLayer[layer];
    if (!entry) {
      entry = {
        meshCount: 0,
        instancedBatchCount: 0,
        drawCalls: 0,
        triangles: 0,
        vertices: 0,
        instances: 0,
      };
      byLayer[layer] = entry;
    }
    return entry;
  };

  for (const mesh of payload.meshes) {
    const tris = getTileMeshRecordTriangleCount(mesh);
    const verts = getTileMeshRecordVertexCount(mesh);
    const dc = getTileMeshRecordDrawCalls(mesh);
    staticTriangles += tris;
    staticVertices += verts;
    staticDrawCalls += dc;

    const bucket = ensureLayer(mesh.layer);
    bucket.meshCount++;
    bucket.drawCalls += dc;
    bucket.triangles += tris;
    bucket.vertices += verts;
  }

  for (const batch of payload.instancedBatches) {
    if (batch.instanceCount <= 0) continue;
    const tris = getInstancedBatchTriangleCount(batch, foliageLod);
    const verts = batch.instanceCount * getInstancedPrototypeVertexCount(batch.prototypeKind);
    instancedTriangles += tris;
    instancedVertices += verts;
    instancedDrawCalls += 1;
    totalInstances += batch.instanceCount;
    if (batch.prototypeKind === 'sleeper_box_unit') {
      sleeperInstanceCount += batch.instanceCount;
    } else {
      foliageInstanceCount += batch.instanceCount;
    }

    const bucket = ensureLayer(batch.layer);
    bucket.instancedBatchCount++;
    bucket.drawCalls += 1;
    bucket.triangles += tris;
    bucket.vertices += verts;
    bucket.instances += batch.instanceCount;
  }

  return {
    staticMeshCount: payload.meshes.length,
    instancedBatchCount: payload.instancedBatches.length,
    staticTriangles,
    staticVertices,
    staticDrawCalls,
    instancedTriangles,
    instancedVertices,
    instancedDrawCalls,
    totalTriangles: staticTriangles + instancedTriangles,
    totalVertices: staticVertices + instancedVertices,
    totalDrawCalls: staticDrawCalls + instancedDrawCalls,
    totalInstances,
    foliageInstanceCount,
    sleeperInstanceCount,
    byLayer,
  };
}

/**
 * Compares legacy stored OSMTILE1 header counters against authoritative buffer-derived counts.
 */
export function compareStoredVsComputedTileStats(
  payload: DecodedTilePayload,
  foliageLod: FoliageLodLevel = 'lod0'
): TileStatsComparison {
  const computedFromBuffers = computeDecodedTileGeometryStats(payload, foliageLod);
  const storedMetadata = {
    totalTriangles: payload.totalTriangles,
    totalVertices: payload.totalVertices,
    totalDrawCalls: payload.totalDrawCalls,
  };
  return {
    storedMetadata,
    computedFromBuffers,
    triangleDelta: computedFromBuffers.totalTriangles - storedMetadata.totalTriangles,
    vertexDelta: computedFromBuffers.totalVertices - storedMetadata.totalVertices,
    drawCallDelta: computedFromBuffers.totalDrawCalls - storedMetadata.totalDrawCalls,
  };
}
