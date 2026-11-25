import type { InspectableFeatureInfo } from '../../types/MapFeature';
import {
  OSMTILE1_FORMAT_VERSION,
  TILE_MESH_FLAG_HAS_BVH,
  TILE_MESH_FLAG_RECEIVE_SHADOW,
  TILE_MESH_FLAG_VISIBLE,
  TILE_PAYLOAD_FLAG_HAS_BVH,
  type DecodedTilePayload,
  type TileFaceRangeRecord,
  type TileInstancedBatchRecord,
  type TileLayerKind,
  type TileMeshGroupRecord,
  type TileMeshRecord,
  type TilePrototypeKind,
  type TileSleeperBearerBox,
} from './TilePackContract';
import {
  buildTileLocalBvh,
  computePositionBBox,
} from './TileBinaryCodec';
import {
  computeDecodedTileGeometryStats,
  getTileMeshRecordTriangleCount,
  type ComputedTileGeometryStats,
} from './TileGeometryStats';
import {
  computeConservativeInstancedBounds,
  FoliagePrototypeRegistry,
  isFoliagePrototypeKind,
} from '../FoliageLodSystem';

export type SpatialSubBatchPolicy = 'parent' | 'child' | number;

export interface TileConsolidationPolicy {
  /** Spatial sub-batching policy for foliage instanced batches ('parent', 'child', or cell size in meters). */
  foliageBatchMode: SpatialSubBatchPolicy;
  /** Spatial sub-batching policy for 3D railway sleeper instanced batches ('parent', 'child', or cell size in meters). */
  sleeperBatchMode: SpatialSubBatchPolicy;
  /** Whether to build fresh indirect MeshBVH structures on every consolidated static mesh (default true). */
  includeBvh: boolean;
}

export const DEFAULT_TILE_CONSOLIDATION_POLICY: TileConsolidationPolicy = {
  foliageBatchMode: 'parent',
  sleeperBatchMode: 'child',
  includeBvh: true,
};

export interface ChildTileConsolidationInput {
  /** Child decoded payload (never mutated). */
  payload: DecodedTilePayload;
  /** Exact UTM center easting of the child tile in meters. */
  childCenterEasting: number;
  /** Exact UTM center northing of the child tile in meters. */
  childCenterNorthing: number;
  /** Child tile X index (for deterministic sorting & chunk keys). */
  tx: number;
  /** Child tile Y index (for deterministic sorting & chunk keys). */
  ty: number;
}

export interface ParentTileConsolidationTarget {
  lod: number;
  tx: number;
  ty: number;
  tileSizeMeters: number;
  /** Exact UTM center easting of the parent tile in meters. */
  parentCenterEasting: number;
  /** Exact UTM center northing of the parent tile in meters. */
  parentCenterNorthing: number;
  /** Parent tile center X in the parent mosaic's regional frame (written into OSMTILE1 header). */
  tileCenterX: number;
  /** Parent tile center Z in the parent mosaic's regional frame (written into OSMTILE1 header). */
  tileCenterZ: number;
}

export interface TileConsolidationAudit {
  childCount: number;
  nonEmptyChildCount: number;
  sourceStaticMeshes: number;
  sourceInstancedBatches: number;
  sourceNonGroundTriangles: number;
  sourceGroundTriangles: number;
  sourceInstancedTrianglesLod0: number;
  sourceStaticDrawCalls: number;
  sourceInstancedDrawCalls: number;
  sourceTotalInstances: number;
  sourceStoredHeaderTriangles: number;
  parentStaticMeshes: number;
  parentInstancedBatches: number;
  parentNonGroundTriangles: number;
  parentGroundTriangles: number;
  parentInstancedTrianglesLod0: number;
  parentStaticDrawCalls: number;
  parentInstancedDrawCalls: number;
  parentTotalInstances: number;
  nonGroundTriangleDelta: number;
  instanceCountDelta: number;
  multiMaterialGroupsBefore: number;
  multiMaterialGroupsAfter: number;
  mixedIndexPromotions: number;
  computedParentStats: ComputedTileGeometryStats;
}

export interface ConsolidatedParentTileResult {
  payload: DecodedTilePayload;
  isEmpty: boolean;
  audit: TileConsolidationAudit;
}

const GROUND_ELEVATION_Y = -0.015;
const SHARED_PROTOTYPE_REGISTRY = new FoliagePrototypeRegistry();

/**
 * Formats a SpatialSubBatchPolicy value for manifest/report provenance.
 */
export function formatSpatialSubBatchPolicy(policy: SpatialSubBatchPolicy): string {
  if (typeof policy === 'number') {
    return `${policy}m`;
  }
  return policy;
}

/**
 * Parses a CLI/config SpatialSubBatchPolicy string ('parent', 'child', or positive meters).
 */
export function parseSpatialSubBatchPolicy(raw: string): SpatialSubBatchPolicy {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'parent' || trimmed === 'child') return trimmed;
  const numeric = Number(trimmed.replace(/m$/, ''));
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.round(numeric);
  }
  throw new Error(
    `Invalid spatial batch policy "${raw}" (expected "parent", "child", or positive meters e.g. "1024")`
  );
}

/**
 * Computes the canonical base mesh/batch name by stripping any spatial `_chunk_*` suffix.
 */
export function getCanonicalMeshBaseName(name: string): string {
  const chunkIdx = name.indexOf('_chunk_');
  return chunkIdx >= 0 ? name.slice(0, chunkIdx) : name;
}

function isGroundMesh(mesh: TileMeshRecord): boolean {
  return mesh.layer === 'ground' || mesh.name === 'GroundPlane';
}

function canonicalFeatureInfoKey(info: InspectableFeatureInfo): string {
  let tagsKey = '';
  if (info.osmTags) {
    const keys = Object.keys(info.osmTags).sort();
    const parts: string[] = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      parts[i] = `${k}=${String(info.osmTags[k])}`;
    }
    tagsKey = parts.join('&');
  }
  const sourceIds = info.sourceFeatureIds ? info.sourceFeatureIds.join(',') : '';
  return [
    info.id,
    info.sourceFeatureId ?? '',
    sourceIds,
    info.name ?? '',
    info.category,
    info.cartoLabel ?? '',
    info.primaryTag ?? '',
    info.subtype ?? '',
    info.type ?? '',
    info.amenity ?? '',
    info.height ?? '',
    info.levels ?? '',
    info.width ?? '',
    info.elevation ?? '',
    info.layer ?? '',
    info.isBridge ? '1' : '0',
    info.isTunnel ? '1' : '0',
    tagsKey,
  ].join('\u001f');
}

interface StaticMeshPart {
  mesh: TileMeshRecord;
  dx: number;
  dz: number;
  featureRemap: Int32Array;
}

interface StaticMergeBucket {
  key: string;
  layer: TileLayerKind;
  baseName: string;
  materialSlotKeys: string[];
  renderOrder: number;
  effectiveFlags: number;
  hasNormals: boolean;
  hasUvs: boolean;
  hasSwitchAttrs: boolean;
  hasColors: boolean;
  parts: StaticMeshPart[];
}

function buildStaticCompatibilityKey(mesh: TileMeshRecord): string {
  const baseName = getCanonicalMeshBaseName(mesh.name);
  const effectiveFlags = mesh.flags & ~TILE_MESH_FLAG_HAS_BVH;
  const attrSig =
    (mesh.normals ? 'N' : '-') +
    (mesh.uvs ? 'U' : '-') +
    (mesh.switchAttrs ? 'S' : '-') +
    (mesh.colors ? 'C' : '-');
  return [
    mesh.layer,
    baseName,
    mesh.materialSlotKeys.join('|'),
    String(mesh.renderOrder),
    String(effectiveFlags),
    attrSig,
  ].join('\u001e');
}

function expandPartTriangleFeatureIndices(
  mesh: TileMeshRecord,
  triCount: number,
  featureRemap: Int32Array
): Int32Array {
  const out = new Int32Array(triCount);
  const defaultIdx =
    mesh.singleFeatureIdx >= 0 && mesh.singleFeatureIdx < featureRemap.length
      ? featureRemap[mesh.singleFeatureIdx]
      : -1;
  out.fill(defaultIdx);

  for (const r of mesh.faceRanges) {
    const mapped =
      r.infoIdx >= 0 && r.infoIdx < featureRemap.length ? featureRemap[r.infoIdx] : -1;
    const start = Math.max(0, r.startFace);
    const end = Math.min(triCount, r.endFace);
    for (let f = start; f < end; f++) {
      out[f] = mapped;
    }
  }
  return out;
}

function expandPartTriangleMaterialIndices(
  mesh: TileMeshRecord,
  triCount: number
): Uint16Array {
  const out = new Uint16Array(triCount);
  if (mesh.groups.length === 0) {
    return out;
  }
  for (const g of mesh.groups) {
    if (g.count <= 0) continue;
    const startFace = Math.floor(g.start / 3);
    const endFace = Math.min(triCount, Math.floor((g.start + g.count) / 3));
    const matIdx = Math.max(0, g.materialIndex);
    for (let f = startFace; f < endFace; f++) {
      out[f] = matIdx;
    }
  }
  return out;
}

function buildCoalescedFaceRanges(faceFeatureIndices: Int32Array): {
  faceRanges: TileFaceRangeRecord[];
  singleFeatureIdx: number;
} {
  const n = faceFeatureIndices.length;
  if (n === 0) return { faceRanges: [], singleFeatureIdx: -1 };

  const ranges: TileFaceRangeRecord[] = [];
  let curInfo = faceFeatureIndices[0];
  let curStart = 0;

  for (let f = 1; f < n; f++) {
    const info = faceFeatureIndices[f];
    if (info !== curInfo) {
      if (curInfo >= 0) {
        ranges.push({ startFace: curStart, endFace: f, infoIdx: curInfo });
      }
      curInfo = info;
      curStart = f;
    }
  }
  if (curInfo >= 0) {
    ranges.push({ startFace: curStart, endFace: n, infoIdx: curInfo });
  }

  if (ranges.length === 1 && ranges[0].startFace === 0 && ranges[0].endFace === n) {
    return { faceRanges: ranges, singleFeatureIdx: ranges[0].infoIdx };
  }
  return { faceRanges: ranges, singleFeatureIdx: -1 };
}

function createParentGroundMesh(
  tileSizeMeters: number,
  includeBvh: boolean
): TileMeshRecord {
  const half = tileSizeMeters * 0.5;
  // Matches THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2)
  const positions = new Float32Array([
    -half, 0, -half,
    half, 0, -half,
    -half, 0, half,
    half, 0, half,
  ]);
  const normals = new Float32Array([
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
  ]);
  const uvs = new Float32Array([
    0, 1,
    1, 1,
    0, 0,
    1, 0,
  ]);
  const indices = new Uint16Array([0, 2, 1, 2, 3, 1]);
  const bvh = includeBvh ? buildTileLocalBvh(positions, indices) : null;
  const flags =
    TILE_MESH_FLAG_VISIBLE |
    TILE_MESH_FLAG_RECEIVE_SHADOW |
    (bvh ? TILE_MESH_FLAG_HAS_BVH : 0);

  return {
    layer: 'ground',
    name: 'GroundPlane',
    materialSlotKeys: ['ground'],
    renderOrder: 0,
    flags,
    localPositionOffset: [0, GROUND_ELEVATION_Y, 0],
    bboxMin: [-half, 0, -half],
    bboxMax: [half, 0, half],
    positions,
    normals,
    uvs,
    switchAttrs: null,
    colors: null,
    indices,
    groups: [],
    faceRanges: [],
    singleFeatureIdx: -1,
    bvh,
  };
}

function mergeStaticBucket(
  bucket: StaticMergeBucket,
  includeBvh: boolean
): {
  mesh: TileMeshRecord;
  groupsBefore: number;
  groupsAfter: number;
  promotedMixedIndex: boolean;
} {
  let totalVerts = 0;
  let totalTris = 0;
  let anyIndexed = false;
  let anyNonIndexed = false;
  let groupsBefore = 0;
  let maxMatIndex = Math.max(0, bucket.materialSlotKeys.length - 1);

  const partMeta = bucket.parts.map((part) => {
    const vCount = Math.floor(part.mesh.positions.length / 3);
    const triCount = getTileMeshRecordTriangleCount(part.mesh);
    if (part.mesh.indices) anyIndexed = true;
    else anyNonIndexed = true;
    totalVerts += vCount;
    totalTris += triCount;
    const partGroups =
      part.mesh.materialSlotKeys.length > 1 && part.mesh.groups.length > 0
        ? part.mesh.groups.length
        : 0;
    groupsBefore += partGroups;
    for (const g of part.mesh.groups) {
      if (g.materialIndex > maxMatIndex) maxMatIndex = g.materialIndex;
    }
    return { part, vCount, triCount };
  });

  const isMultiMaterial = bucket.materialSlotKeys.length > 1 || groupsBefore > 0;
  const outputIndexed = anyIndexed;
  const promotedMixedIndex = anyIndexed && anyNonIndexed;

  if (!outputIndexed && isMultiMaterial) {
    // Pure non-indexed multi-material: reorder triangle vertices directly by materialIndex
    const positions = new Float32Array(totalTris * 9);
    const normals = bucket.hasNormals ? new Float32Array(totalTris * 9) : null;
    const uvs = bucket.hasUvs ? new Float32Array(totalTris * 6) : null;
    const switchAttrs = bucket.hasSwitchAttrs ? new Float32Array(totalTris * 6) : null;
    const colors = bucket.hasColors ? new Float32Array(totalTris * 9) : null;
    const outFaceInfos = new Int32Array(totalTris);

    const numSlots = maxMatIndex + 1;
    const matTriCounts = new Uint32Array(numSlots);
    const partMatIndices: Uint16Array[] = [];
    const partFaceInfos: Int32Array[] = [];

    for (const pm of partMeta) {
      const mIdx = expandPartTriangleMaterialIndices(pm.part.mesh, pm.triCount);
      const fIdx = expandPartTriangleFeatureIndices(
        pm.part.mesh,
        pm.triCount,
        pm.part.featureRemap
      );
      partMatIndices.push(mIdx);
      partFaceInfos.push(fIdx);
      for (let f = 0; f < pm.triCount; f++) {
        matTriCounts[mIdx[f]]++;
      }
    }

    const matFaceCursors = new Uint32Array(numSlots);
    const groups: TileMeshGroupRecord[] = [];
    let runningFaces = 0;
    for (let slot = 0; slot < numSlots; slot++) {
      matFaceCursors[slot] = runningFaces;
      const countFaces = matTriCounts[slot];
      if (countFaces > 0) {
        groups.push({
          start: runningFaces * 3,
          count: countFaces * 3,
          materialIndex: slot,
        });
        runningFaces += countFaces;
      }
    }

    for (let p = 0; p < partMeta.length; p++) {
      const { part, triCount } = partMeta[p];
      const m = part.mesh;
      const mIdx = partMatIndices[p];
      const fIdx = partFaceInfos[p];
      const ox = m.localPositionOffset[0] + part.dx;
      const oy = m.localPositionOffset[1];
      const oz = m.localPositionOffset[2] + part.dz;

      for (let f = 0; f < triCount; f++) {
        const slot = mIdx[f];
        const dstFace = matFaceCursors[slot]++;
        outFaceInfos[dstFace] = fIdx[f];

        const srcBase9 = f * 9;
        const dstBase9 = dstFace * 9;
        for (let c = 0; c < 3; c++) {
          positions[dstBase9 + c * 3] = m.positions[srcBase9 + c * 3] + ox;
          positions[dstBase9 + c * 3 + 1] = m.positions[srcBase9 + c * 3 + 1] + oy;
          positions[dstBase9 + c * 3 + 2] = m.positions[srcBase9 + c * 3 + 2] + oz;
        }
        if (normals && m.normals) {
          normals.set(m.normals.subarray(srcBase9, srcBase9 + 9), dstBase9);
        }
        if (colors && m.colors) {
          colors.set(m.colors.subarray(srcBase9, srcBase9 + 9), dstBase9);
        }
        const srcBase6 = f * 6;
        const dstBase6 = dstFace * 6;
        if (uvs && m.uvs) {
          uvs.set(m.uvs.subarray(srcBase6, srcBase6 + 6), dstBase6);
        }
        if (switchAttrs && m.switchAttrs) {
          switchAttrs.set(m.switchAttrs.subarray(srcBase6, srcBase6 + 6), dstBase6);
        }
      }
    }

    const bbox = computePositionBBox(positions);
    const { faceRanges, singleFeatureIdx } = buildCoalescedFaceRanges(outFaceInfos);
    const bvh = includeBvh ? buildTileLocalBvh(positions, null) : null;
    const flags = bvh
      ? bucket.effectiveFlags | TILE_MESH_FLAG_HAS_BVH
      : bucket.effectiveFlags & ~TILE_MESH_FLAG_HAS_BVH;

    return {
      mesh: {
        layer: bucket.layer,
        name: bucket.baseName,
        materialSlotKeys: [...bucket.materialSlotKeys],
        renderOrder: bucket.renderOrder,
        flags,
        localPositionOffset: [0, 0, 0],
        bboxMin: bbox.min,
        bboxMax: bbox.max,
        positions,
        normals,
        uvs,
        switchAttrs,
        colors,
        indices: null,
        groups,
        faceRanges,
        singleFeatureIdx,
        bvh,
      },
      groupsBefore,
      groupsAfter: groups.length,
      promotedMixedIndex,
    };
  }

  // Concatenate vertex attributes once in deterministic child order
  const positions = new Float32Array(totalVerts * 3);
  const normals = bucket.hasNormals ? new Float32Array(totalVerts * 3) : null;
  const uvs = bucket.hasUvs ? new Float32Array(totalVerts * 2) : null;
  const switchAttrs = bucket.hasSwitchAttrs ? new Float32Array(totalVerts * 2) : null;
  const colors = bucket.hasColors ? new Float32Array(totalVerts * 3) : null;

  const baseVertOffsets = new Uint32Array(partMeta.length);
  let vertCursor = 0;
  for (let p = 0; p < partMeta.length; p++) {
    const { part, vCount } = partMeta[p];
    const m = part.mesh;
    baseVertOffsets[p] = vertCursor;

    const ox = m.localPositionOffset[0] + part.dx;
    const oy = m.localPositionOffset[1];
    const oz = m.localPositionOffset[2] + part.dz;

    const dst3 = vertCursor * 3;
    for (let i = 0; i < vCount; i++) {
      positions[dst3 + i * 3] = m.positions[i * 3] + ox;
      positions[dst3 + i * 3 + 1] = m.positions[i * 3 + 1] + oy;
      positions[dst3 + i * 3 + 2] = m.positions[i * 3 + 2] + oz;
    }
    if (normals && m.normals) {
      normals.set(m.normals.subarray(0, vCount * 3), dst3);
    }
    if (colors && m.colors) {
      colors.set(m.colors.subarray(0, vCount * 3), dst3);
    }
    const dst2 = vertCursor * 2;
    if (uvs && m.uvs) {
      uvs.set(m.uvs.subarray(0, vCount * 2), dst2);
    }
    if (switchAttrs && m.switchAttrs) {
      switchAttrs.set(m.switchAttrs.subarray(0, vCount * 2), dst2);
    }
    vertCursor += vCount;
  }

  let indices: Uint16Array | Uint32Array | null = null;
  let groups: TileMeshGroupRecord[] = [];
  const outFaceInfos = new Int32Array(totalTris);

  if (!outputIndexed) {
    // Non-indexed single-material: vertex order already equals triangle order
    let faceCursor = 0;
    for (let p = 0; p < partMeta.length; p++) {
      const { part, triCount } = partMeta[p];
      const fIdx = expandPartTriangleFeatureIndices(
        part.mesh,
        triCount,
        part.featureRemap
      );
      outFaceInfos.set(fIdx, faceCursor);
      faceCursor += triCount;
    }
  } else {
    indices =
      totalVerts > 65535
        ? new Uint32Array(totalTris * 3)
        : new Uint16Array(totalTris * 3);

    if (isMultiMaterial) {
      // Group triangles by materialIndex so each material slot renders in 1 contiguous draw call
      const numSlots = maxMatIndex + 1;
      const matTriCounts = new Uint32Array(numSlots);
      const partMatIndices: Uint16Array[] = [];
      const partFaceInfos: Int32Array[] = [];

      for (const pm of partMeta) {
        const mIdx = expandPartTriangleMaterialIndices(pm.part.mesh, pm.triCount);
        const fIdx = expandPartTriangleFeatureIndices(
          pm.part.mesh,
          pm.triCount,
          pm.part.featureRemap
        );
        partMatIndices.push(mIdx);
        partFaceInfos.push(fIdx);
        for (let f = 0; f < pm.triCount; f++) {
          matTriCounts[mIdx[f]]++;
        }
      }

      const matFaceCursors = new Uint32Array(numSlots);
      let runningFaces = 0;
      for (let slot = 0; slot < numSlots; slot++) {
        matFaceCursors[slot] = runningFaces;
        const countFaces = matTriCounts[slot];
        if (countFaces > 0) {
          groups.push({
            start: runningFaces * 3,
            count: countFaces * 3,
            materialIndex: slot,
          });
          runningFaces += countFaces;
        }
      }

      for (let p = 0; p < partMeta.length; p++) {
        const { part, triCount } = partMeta[p];
        const m = part.mesh;
        const baseV = baseVertOffsets[p];
        const mIdx = partMatIndices[p];
        const fIdx = partFaceInfos[p];

        if (m.indices) {
          for (let f = 0; f < triCount; f++) {
            const slot = mIdx[f];
            const dstFace = matFaceCursors[slot]++;
            outFaceInfos[dstFace] = fIdx[f];
            const srcI = f * 3;
            const dstI = dstFace * 3;
            indices[dstI] = m.indices[srcI] + baseV;
            indices[dstI + 1] = m.indices[srcI + 1] + baseV;
            indices[dstI + 2] = m.indices[srcI + 2] + baseV;
          }
        } else {
          for (let f = 0; f < triCount; f++) {
            const slot = mIdx[f];
            const dstFace = matFaceCursors[slot]++;
            outFaceInfos[dstFace] = fIdx[f];
            const dstI = dstFace * 3;
            indices[dstI] = baseV + f * 3;
            indices[dstI + 1] = baseV + f * 3 + 1;
            indices[dstI + 2] = baseV + f * 3 + 2;
          }
        }
      }
    } else {
      // Single-material indexed merge
      let faceCursor = 0;
      for (let p = 0; p < partMeta.length; p++) {
        const { part, triCount } = partMeta[p];
        const m = part.mesh;
        const baseV = baseVertOffsets[p];
        const fIdx = expandPartTriangleFeatureIndices(
          m,
          triCount,
          part.featureRemap
        );
        outFaceInfos.set(fIdx, faceCursor);
        const dstStart = faceCursor * 3;
        if (m.indices) {
          for (let i = 0; i < triCount * 3; i++) {
            indices[dstStart + i] = m.indices[i] + baseV;
          }
        } else {
          for (let i = 0; i < triCount * 3; i++) {
            indices[dstStart + i] = baseV + i;
          }
        }
        faceCursor += triCount;
      }
    }
  }

  const bbox = computePositionBBox(positions);
  const { faceRanges, singleFeatureIdx } = buildCoalescedFaceRanges(outFaceInfos);
  const bvh = includeBvh ? buildTileLocalBvh(positions, indices) : null;
  const flags = bvh
    ? bucket.effectiveFlags | TILE_MESH_FLAG_HAS_BVH
    : bucket.effectiveFlags & ~TILE_MESH_FLAG_HAS_BVH;

  return {
    mesh: {
      layer: bucket.layer,
      name: bucket.baseName,
      materialSlotKeys: [...bucket.materialSlotKeys],
      renderOrder: bucket.renderOrder,
      flags,
      localPositionOffset: [0, 0, 0],
      bboxMin: bbox.min,
      bboxMax: bbox.max,
      positions,
      normals,
      uvs,
      switchAttrs,
      colors,
      indices,
      groups,
      faceRanges,
      singleFeatureIdx,
      bvh,
    },
    groupsBefore,
    groupsAfter: groups.length,
    promotedMixedIndex,
  };
}

interface InstancedMergeBucket {
  layer: TileLayerKind;
  baseName: string;
  materialSlotKey: string;
  prototypeKind: TileInstancedBatchRecord['prototypeKind'];
  renderOrder: number;
  flags: number;
  chunkKey?: string;
  matricesList: number[];
  colorsList: number[] | null;
  featureIdxs: number[];
  sleeperBoxes: TileSleeperBearerBox[] | null;
  instanceCount: number;
}

function finalizeInstancedBucket(bucket: InstancedMergeBucket): TileInstancedBatchRecord {
  const count = bucket.instanceCount;
  const matrices = new Float32Array(bucket.matricesList);
  const instanceColors = bucket.colorsList ? new Float32Array(bucket.colorsList) : null;
  const instanceFeatureIdxs = new Int32Array(bucket.featureIdxs);
  const sleeperBoxes = bucket.sleeperBoxes;

  let bboxMin: [number, number, number] = [0, 0, 0];
  let bboxMax: [number, number, number] = [0, 0, 0];

  if (count > 0) {
    if (isFoliagePrototypeKind(bucket.prototypeKind)) {
      const unionLocalBounds = SHARED_PROTOTYPE_REGISTRY.getUnionLocalBounds(
        bucket.prototypeKind
      );
      const bounds = computeConservativeInstancedBounds(
        matrices,
        count,
        unionLocalBounds
      );
      bboxMin = [
        bounds.boundingBox.min.x,
        bounds.boundingBox.min.y,
        bounds.boundingBox.min.z,
      ];
      bboxMax = [
        bounds.boundingBox.max.x,
        bounds.boundingBox.max.y,
        bounds.boundingBox.max.z,
      ];
    } else if (sleeperBoxes && sleeperBoxes.length > 0) {
      let x0 = Infinity,
        y0 = Infinity,
        z0 = Infinity;
      let x1 = -Infinity,
        y1 = -Infinity,
        z1 = -Infinity;
      for (const sb of sleeperBoxes) {
        const reach = Math.max(sb.halfLen, sb.halfWidthLeft, sb.halfWidthRight) + 0.5;
        if (sb.cx - reach < x0) x0 = sb.cx - reach;
        if (sb.cx + reach > x1) x1 = sb.cx + reach;
        if (sb.yBottom - 0.1 < y0) y0 = sb.yBottom - 0.1;
        if (sb.yTop + 0.1 > y1) y1 = sb.yTop + 0.1;
        if (sb.cz - reach < z0) z0 = sb.cz - reach;
        if (sb.cz + reach > z1) z1 = sb.cz + reach;
      }
      if (Number.isFinite(x0)) {
        bboxMin = [x0, y0, z0];
        bboxMax = [x1, y1, z1];
      }
    } else {
      let x0 = Infinity,
        y0 = Infinity,
        z0 = Infinity;
      let x1 = -Infinity,
        y1 = -Infinity,
        z1 = -Infinity;
      for (let i = 0; i < count; i++) {
        const tx = matrices[i * 16 + 12];
        const ty = matrices[i * 16 + 13];
        const tz = matrices[i * 16 + 14];
        if (tx - 3 < x0) x0 = tx - 3;
        if (tx + 3 > x1) x1 = tx + 3;
        if (ty - 2 < y0) y0 = ty - 2;
        if (ty + 4 > y1) y1 = ty + 4;
        if (tz - 3 < z0) z0 = tz - 3;
        if (tz + 3 > z1) z1 = tz + 3;
      }
      if (Number.isFinite(x0)) {
        bboxMin = [x0, y0, z0];
        bboxMax = [x1, y1, z1];
      }
    }
  }

  const finalName = bucket.chunkKey
    ? `${bucket.baseName}_chunk_${bucket.chunkKey}`
    : bucket.baseName;

  return {
    layer: bucket.layer,
    name: finalName,
    materialSlotKey: bucket.materialSlotKey,
    prototypeKind: bucket.prototypeKind,
    renderOrder: bucket.renderOrder,
    flags: bucket.flags,
    bboxMin,
    bboxMax,
    instanceCount: count,
    matrices,
    instanceColors,
    instanceFeatureIdxs,
    sleeperBoxes,
    chunkKey: bucket.chunkKey,
  };
}

/**
 * Consolidates a set of decoded child OSMTILE1 tiles into a single parent tile
 * without invoking GeometryBuilder or altering geographic geometry.
 *
 * Processing is strictly deterministic: child inputs are sorted by (ty, tx),
 * static merge buckets preserve deterministic key/child order, multi-material
 * groups are consolidated to <= 1 group per material slot, and fresh indirect
 * MeshBVH structures are built on all consolidated static meshes.
 */
export function consolidateChildTilePayloads(
  children: readonly ChildTileConsolidationInput[],
  target: ParentTileConsolidationTarget,
  policy: TileConsolidationPolicy = DEFAULT_TILE_CONSOLIDATION_POLICY
): ConsolidatedParentTileResult {
  // Sort child inputs deterministically by (ty, tx)
  const sortedChildren = [...children].sort((a, b) =>
    a.ty !== b.ty ? a.ty - b.ty : a.tx - b.tx
  );

  // Unified featureInfo table with deduplication
  const featureInfos: InspectableFeatureInfo[] = [];
  const featureIdxByKey = new Map<string, number>();
  const internFeature = (info: InspectableFeatureInfo): number => {
    const key = canonicalFeatureInfoKey(info);
    const existing = featureIdxByKey.get(key);
    if (existing !== undefined) return existing;
    const idx = featureInfos.length;
    featureInfos.push(info);
    featureIdxByKey.set(key, idx);
    return idx;
  };

  let nonEmptyChildCount = 0;
  let sourceStaticMeshes = 0;
  let sourceInstancedBatches = 0;
  let sourceNonGroundTriangles = 0;
  let sourceGroundTriangles = 0;
  let sourceInstancedTrianglesLod0 = 0;
  let sourceStaticDrawCalls = 0;
  let sourceInstancedDrawCalls = 0;
  let sourceTotalInstances = 0;
  let sourceStoredHeaderTriangles = 0;
  let railwayRenderSource = 'graph-R+';

  const staticBuckets = new Map<string, StaticMergeBucket>();
  const instancedBuckets = new Map<string, InstancedMergeBucket>();

  for (const child of sortedChildren) {
    const payload = child.payload;
    const childStats = computeDecodedTileGeometryStats(payload, 'lod0');
    sourceStoredHeaderTriangles += payload.totalTriangles;
    if (payload.railwayRenderSource) {
      railwayRenderSource = payload.railwayRenderSource;
    }

    const childHasContent =
      payload.meshes.length > 0 || payload.instancedBatches.length > 0;
    if (!childHasContent) continue;

    nonEmptyChildCount++;
    sourceStaticMeshes += childStats.staticMeshCount;
    sourceInstancedBatches += childStats.instancedBatchCount;
    sourceInstancedTrianglesLod0 += childStats.instancedTriangles;
    sourceStaticDrawCalls += childStats.staticDrawCalls;
    sourceInstancedDrawCalls += childStats.instancedDrawCalls;
    sourceTotalInstances += childStats.totalInstances;

    // Exact local shift from child tile center to parent tile center (+Z = South = -Northing)
    const dx = child.childCenterEasting - target.parentCenterEasting;
    const dz = target.parentCenterNorthing - child.childCenterNorthing;

    // Remap child featureInfos into parent table
    const featureRemap = new Int32Array(payload.featureInfos.length);
    for (let i = 0; i < payload.featureInfos.length; i++) {
      featureRemap[i] = internFeature(payload.featureInfos[i]);
    }

    // Group static meshes by strict compatibility key
    for (const mesh of payload.meshes) {
      const tris = getTileMeshRecordTriangleCount(mesh);
      if (isGroundMesh(mesh)) {
        sourceGroundTriangles += tris;
        continue;
      }
      sourceNonGroundTriangles += tris;
      if (tris === 0) continue;

      const key = buildStaticCompatibilityKey(mesh);
      let bucket = staticBuckets.get(key);
      if (!bucket) {
        bucket = {
          key,
          layer: mesh.layer,
          baseName: getCanonicalMeshBaseName(mesh.name),
          materialSlotKeys: [...mesh.materialSlotKeys],
          renderOrder: mesh.renderOrder,
          effectiveFlags: mesh.flags & ~TILE_MESH_FLAG_HAS_BVH,
          hasNormals: mesh.normals !== null,
          hasUvs: mesh.uvs !== null,
          hasSwitchAttrs: mesh.switchAttrs !== null,
          hasColors: mesh.colors !== null,
          parts: [],
        };
        staticBuckets.set(key, bucket);
      }
      bucket.parts.push({ mesh, dx, dz, featureRemap });
    }

    // Group instanced batches with configurable spatial sub-batching policy
    for (const batch of payload.instancedBatches) {
      if (batch.instanceCount <= 0) continue;
      const baseName = getCanonicalMeshBaseName(batch.name);
      const isFoliage = isFoliagePrototypeKind(batch.prototypeKind);
      const subPolicy = isFoliage ? policy.foliageBatchMode : policy.sleeperBatchMode;
      const effectiveFlags = batch.flags & ~TILE_MESH_FLAG_HAS_BVH;

      const baseKey = [
        batch.layer,
        baseName,
        batch.materialSlotKey,
        batch.prototypeKind,
        String(batch.renderOrder),
        String(effectiveFlags),
      ].join('\u001e');

      const ensureInstBucket = (chunkKey?: string): InstancedMergeBucket => {
        const fullKey = chunkKey ? `${baseKey}\u001e${chunkKey}` : baseKey;
        let ib = instancedBuckets.get(fullKey);
        if (!ib) {
          ib = {
            layer: batch.layer,
            baseName,
            materialSlotKey: batch.materialSlotKey,
            prototypeKind: batch.prototypeKind,
            renderOrder: batch.renderOrder,
            flags: effectiveFlags,
            chunkKey,
            matricesList: [],
            colorsList: null,
            featureIdxs: [],
            sleeperBoxes: null,
            instanceCount: 0,
          };
          instancedBuckets.set(fullKey, ib);
        }
        return ib;
      };

      const appendInstance = (ib: InstancedMergeBucket, idx: number) => {
        // Backfill default white colors if an earlier batch in this bucket lacked instanceColors
        if (batch.instanceColors && ib.colorsList === null) {
          ib.colorsList = new Array(ib.instanceCount * 3).fill(1);
        }

        const mOff = idx * 16;
        for (let k = 0; k < 16; k++) {
          let v = batch.matrices[mOff + k];
          if (k === 12) v += dx;
          else if (k === 14) v += dz;
          ib.matricesList.push(v);
        }

        if (ib.colorsList !== null) {
          if (batch.instanceColors) {
            const cOff = idx * 3;
            ib.colorsList.push(
              batch.instanceColors[cOff],
              batch.instanceColors[cOff + 1],
              batch.instanceColors[cOff + 2]
            );
          } else {
            ib.colorsList.push(1, 1, 1);
          }
        }

        const rawFeatIdx =
          idx < batch.instanceFeatureIdxs.length ? batch.instanceFeatureIdxs[idx] : -1;
        const mappedFeatIdx =
          rawFeatIdx >= 0 && rawFeatIdx < featureRemap.length
            ? featureRemap[rawFeatIdx]
            : -1;
        ib.featureIdxs.push(mappedFeatIdx);

        if (batch.sleeperBoxes && idx < batch.sleeperBoxes.length) {
          if (ib.sleeperBoxes === null) {
            ib.sleeperBoxes = [];
          }
          const sb = batch.sleeperBoxes[idx];
          ib.sleeperBoxes.push({
            ...sb,
            cx: sb.cx + dx,
            cz: sb.cz + dz,
          });
        }

        ib.instanceCount++;
      };

      if (subPolicy === 'parent') {
        const ib = ensureInstBucket(undefined);
        for (let i = 0; i < batch.instanceCount; i++) {
          appendInstance(ib, i);
        }
      } else if (subPolicy === 'child') {
        const childChunkKey = `${child.tx}_${child.ty}`;
        const ib = ensureInstBucket(childChunkKey);
        for (let i = 0; i < batch.instanceCount; i++) {
          appendInstance(ib, i);
        }
      } else {
        const cellMeters = subPolicy;
        for (let i = 0; i < batch.instanceCount; i++) {
          const rebasedX = batch.matrices[i * 16 + 12] + dx;
          const rebasedZ = batch.matrices[i * 16 + 14] + dz;
          const cellX = Math.floor((rebasedX + target.tileSizeMeters * 0.5) / cellMeters);
          const cellZ = Math.floor((rebasedZ + target.tileSizeMeters * 0.5) / cellMeters);
          const ib = ensureInstBucket(`c${cellX}_${cellZ}`);
          appendInstance(ib, i);
        }
      }
    }
  }

  const consolidatedMeshes: TileMeshRecord[] = [];
  const consolidatedInstanced: TileInstancedBatchRecord[] = [];
  let multiMaterialGroupsBefore = 0;
  let multiMaterialGroupsAfter = 0;
  let mixedIndexPromotions = 0;
  let parentGroundTriangles = 0;
  let parentNonGroundTriangles = 0;

  let overMinX = Infinity,
    overMinY = Infinity,
    overMinZ = Infinity;
  let overMaxX = -Infinity,
    overMaxY = -Infinity,
    overMaxZ = -Infinity;

  const expandOverhang = (
    bmin: [number, number, number],
    bmax: [number, number, number]
  ) => {
    if (bmin[0] < overMinX) overMinX = bmin[0];
    if (bmin[1] < overMinY) overMinY = bmin[1];
    if (bmin[2] < overMinZ) overMinZ = bmin[2];
    if (bmax[0] > overMaxX) overMaxX = bmax[0];
    if (bmax[1] > overMaxY) overMaxY = bmax[1];
    if (bmax[2] > overMaxZ) overMaxZ = bmax[2];
  };

  if (nonEmptyChildCount > 0) {
    // Emit one clean parent-sized GroundPlane (2 triangles)
    const groundMesh = createParentGroundMesh(target.tileSizeMeters, policy.includeBvh);
    consolidatedMeshes.push(groundMesh);
    parentGroundTriangles = getTileMeshRecordTriangleCount(groundMesh);

    // Deterministic bucket order
    const sortedStaticKeys = Array.from(staticBuckets.keys()).sort();
    for (const key of sortedStaticKeys) {
      const bucket = staticBuckets.get(key)!;
      const merged = mergeStaticBucket(bucket, policy.includeBvh);
      consolidatedMeshes.push(merged.mesh);
      parentNonGroundTriangles += getTileMeshRecordTriangleCount(merged.mesh);
      multiMaterialGroupsBefore += merged.groupsBefore;
      multiMaterialGroupsAfter += merged.groupsAfter;
      if (merged.promotedMixedIndex) mixedIndexPromotions++;
      expandOverhang(
        [
          merged.mesh.bboxMin[0] + merged.mesh.localPositionOffset[0],
          merged.mesh.bboxMin[1] + merged.mesh.localPositionOffset[1],
          merged.mesh.bboxMin[2] + merged.mesh.localPositionOffset[2],
        ],
        [
          merged.mesh.bboxMax[0] + merged.mesh.localPositionOffset[0],
          merged.mesh.bboxMax[1] + merged.mesh.localPositionOffset[1],
          merged.mesh.bboxMax[2] + merged.mesh.localPositionOffset[2],
        ]
      );
    }

    const sortedInstKeys = Array.from(instancedBuckets.keys()).sort();
    for (const key of sortedInstKeys) {
      const bucket = instancedBuckets.get(key)!;
      if (bucket.instanceCount <= 0) continue;
      const record = finalizeInstancedBucket(bucket);
      consolidatedInstanced.push(record);
      expandOverhang(record.bboxMin, record.bboxMax);
    }
  }

  if (!Number.isFinite(overMinX)) {
    const half = target.tileSizeMeters * 0.5;
    overMinX = -half;
    overMaxX = half;
    overMinY = -0.05;
    overMaxY = 0.05;
    overMinZ = -half;
    overMaxZ = half;
  }

  // Derive forestTreesCount and sleeper3DBoxCount from actual consolidated instances
  let trunkCount = 0;
  let canopyCount = 0;
  let sleeper3DBoxCount = 0;
  for (const b of consolidatedInstanced) {
    if (b.prototypeKind === 'tree_trunk') trunkCount += b.instanceCount;
    else if (
      b.prototypeKind === 'tree_broadleaved' ||
      b.prototypeKind === 'tree_needleleaved'
    ) {
      canopyCount += b.instanceCount;
    } else if (b.prototypeKind === 'sleeper_box_unit') {
      sleeper3DBoxCount += b.instanceCount;
    }
  }
  const forestTreesCount = trunkCount > 0 ? trunkCount : canopyCount;

  // Assemble preliminary payload so computeDecodedTileGeometryStats derives exact header stats
  const hasAnyBvh = consolidatedMeshes.some((m) => m.bvh !== null);
  const preliminaryPayload: DecodedTilePayload = {
    formatVersion: OSMTILE1_FORMAT_VERSION,
    flags: hasAnyBvh ? TILE_PAYLOAD_FLAG_HAS_BVH : 0,
    lod: target.lod,
    tx: target.tx,
    ty: target.ty,
    byteLength: 0,
    renderedFeaturesCount: featureInfos.length,
    forestTreesCount,
    sleeper3DBoxCount,
    totalVertices: 0,
    totalTriangles: 0,
    totalDrawCalls: 0,
    tileCenterX: target.tileCenterX,
    tileCenterZ: target.tileCenterZ,
    tileSizeMeters: target.tileSizeMeters,
    overhangBoundsMin: [overMinX, overMinY, overMinZ],
    overhangBoundsMax: [overMaxX, overMaxY, overMaxZ],
    railwayRenderSource,
    featureInfos,
    meshes: consolidatedMeshes,
    instancedBatches: consolidatedInstanced,
  };

  const computedParentStats = computeDecodedTileGeometryStats(
    preliminaryPayload,
    'lod0'
  );
  preliminaryPayload.totalVertices = computedParentStats.totalVertices;
  preliminaryPayload.totalTriangles = computedParentStats.totalTriangles;
  preliminaryPayload.totalDrawCalls = computedParentStats.totalDrawCalls;

  const isEmpty =
    consolidatedMeshes.length === 0 && consolidatedInstanced.length === 0;

  return {
    payload: preliminaryPayload,
    isEmpty,
    audit: {
      childCount: sortedChildren.length,
      nonEmptyChildCount,
      sourceStaticMeshes,
      sourceInstancedBatches,
      sourceNonGroundTriangles,
      sourceGroundTriangles,
      sourceInstancedTrianglesLod0,
      sourceStaticDrawCalls,
      sourceInstancedDrawCalls,
      sourceTotalInstances,
      sourceStoredHeaderTriangles,
      parentStaticMeshes: computedParentStats.staticMeshCount,
      parentInstancedBatches: computedParentStats.instancedBatchCount,
      parentNonGroundTriangles,
      parentGroundTriangles,
      parentInstancedTrianglesLod0: computedParentStats.instancedTriangles,
      parentStaticDrawCalls: computedParentStats.staticDrawCalls,
      parentInstancedDrawCalls: computedParentStats.instancedDrawCalls,
      parentTotalInstances: computedParentStats.totalInstances,
      nonGroundTriangleDelta: parentNonGroundTriangles - sourceNonGroundTriangles,
      instanceCountDelta: computedParentStats.totalInstances - sourceTotalInstances,
      multiMaterialGroupsBefore,
      multiMaterialGroupsAfter,
      mixedIndexPromotions,
      computedParentStats,
    },
  };
}
