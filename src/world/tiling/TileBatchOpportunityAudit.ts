import type {
  DecodedTilePayload,
  TileLayerKind,
  TileMeshRecord,
} from './TilePackContract';
import {
  TILE_MESH_FLAG_VISIBLE,
  TILE_MESH_FLAG_STRUCTURAL_3D,
  TILE_MESH_FLAG_UNDERGROUND_GEOM,
  TILE_MESH_FLAG_UNDERGROUND_TRACE,
  TILE_MESH_FLAG_HIDDEN_UNDERGROUND,
} from './TilePackContract';

/**
 * TKT-030. Read-only dry-run analysis of decoded OSMTILE1 records.
 *
 * These are potential mesh-submission savings, NOT measured WebGL draw calls
 * and NOT permission to merge semantic geometry without renderer tests.
 * Batch boundaries never cross a source tile.
 */
export const DEFAULT_BATCH_AUDIT_CELL_SIZES = [128, 256, 512, 1024] as const;

export interface BatchAuditLayer {
  layer: TileLayerKind;
  meshes: number;
  triangles: number;
  staticSubmissionProxy: number;
  serializedVisibleSubmissionProxy: number;
  instancedBatches: number;
  instances: number;
  candidateMeshes: number;
  candidateWithFeatureMapping: number;
  candidateRequiringSemanticReview: number;
  excludedByReason: Record<string, number>;
}

export interface BatchAuditProfile {
  label: string;
  cellMeters: number | null;
  candidateMeshesWithinCells: number;
  candidateMeshesOutsideCells: number;
  mergeGroups: number;
  mergedMeshRecords: number;
  submissionReductionProxy: number;
  serializedVisibleReductionProxy: number;
  afterSubmissionProxy: number;
  afterSerializedVisibleSubmissionProxy: number;
  byLayerReduction: Record<string, number>;
  byMaterialReduction: Record<string, number>;
}

export interface BatchAuditTile {
  key: string;
  tileSizeMeters: number;
  staticMeshes: number;
  instanceBatches: number;
  instances: number;
  submissionProxy: number;
  serializedVisibleSubmissionProxy: number;
  triangles: number;
  featureInfoRecords: number;
  featureCategories: Record<string, number>;
  layers: Record<string, BatchAuditLayer>;
  profiles: BatchAuditProfile[];
}

export interface BatchAuditSummary {
  tiles: number;
  tileSizeMeters: number | 'mixed';
  staticMeshes: number;
  instanceBatches: number;
  instances: number;
  submissionProxy: number;
  serializedVisibleSubmissionProxy: number;
  triangles: number;
  featureInfoRecords: number;
  featureCategories: Record<string, number>;
  layers: Record<string, BatchAuditLayer>;
  profiles: BatchAuditProfile[];
  hotspots: Array<{
    tile: string;
    reductionProxy: number;
    staticMeshes: number;
  }>;
}

type MeshCandidate = {
  mesh: TileMeshRecord;
  material: string;
  key: string;
  visible: boolean;
};

/** Meshes with multiple materials may render once per material group. */
export function estimateStaticMeshSubmissionProxy(mesh: TileMeshRecord): number {
  if (mesh.positions.length === 0 || (mesh.indices && mesh.indices.length === 0)) return 0;
  if (mesh.materialSlotKeys.length > 1) return Math.max(1, mesh.groups.length);
  return 1;
}

function attributeSignature(mesh: TileMeshRecord): string {
  return [
    mesh.normals ? 'n' : '-',
    mesh.uvs ? 'u' : '-',
    mesh.switchAttrs ? 's' : '-',
    mesh.colors ? 'c' : '-',
    mesh.indices instanceof Uint32Array ? 'i32' :
      mesh.indices instanceof Uint16Array ? 'i16' : 'nonindexed',
  ].join('');
}

function isSensitive(mesh: TileMeshRecord, decoded: DecodedTilePayload): boolean {
  // Conservatively flag semantic systems which need explicit visual,
  // inspection, stencil and/or raycasting validation before merging.
  if (
    mesh.layer === 'roads' || mesh.layer === 'railways' ||
    mesh.layer === 'buildings' || mesh.layer === 'water' ||
    mesh.layer === 'landuse' || mesh.layer === 'parks'
  ) return true;
  const semanticFlags = TILE_MESH_FLAG_STRUCTURAL_3D |
    TILE_MESH_FLAG_UNDERGROUND_GEOM |
    TILE_MESH_FLAG_UNDERGROUND_TRACE |
    TILE_MESH_FLAG_HIDDEN_UNDERGROUND;
  if ((mesh.flags & semanticFlags) !== 0) return true;

  const ids = mesh.singleFeatureIdx >= 0
    ? [mesh.singleFeatureIdx, ...mesh.faceRanges.map((r) => r.infoIdx)]
    : mesh.faceRanges.map((r) => r.infoIdx);
  return ids.some((idx) => {
    const feature = decoded.featureInfos[idx];
    if (!feature) return false;
    return Boolean(feature.isBridge || feature.isTunnel ||
      (feature.layer !== undefined && Number(feature.layer) !== 0));
  });
}

/**
 * Structural compatibility only. Not equivalent to proven visual safety.
 * In particular, distinct meshes may depend on submission order even when
 * renderOrder and materials coincide.
 */
export function getMeshBatchExclusionReason(mesh: TileMeshRecord): string | null {
  if (mesh.layer === 'ground') return 'ground';
  if (mesh.layer === 'railways') return 'railway_zoom_or_chunk_semantics';
  if (mesh.chunkKey || mesh.name.includes('_chunk_')) return 'semantic_chunk_parent';
  if (mesh.materialSlotKeys.length !== 1) return 'multi_material_or_missing_material';
  if (mesh.positions.length === 0 || (mesh.indices && mesh.indices.length === 0)) return 'empty_geometry';
  if (mesh.groups.length > 1 ||
      (mesh.groups.length === 1 && mesh.groups[0].materialIndex !== 0)) {
    return 'nontrivial_material_groups';
  }
  const bounds = [...mesh.bboxMin, ...mesh.bboxMax, ...mesh.localPositionOffset];
  if (bounds.some((v) => !Number.isFinite(v))) return 'invalid_bounds';
  if (mesh.bboxMin.some((v, i) => v > mesh.bboxMax[i])) return 'inverted_bounds';
  return null;
}

/**
 * Bounding-box containment, not centroid assignment. Meshes crossing a cell
 * edge remain separate rather than enlarging a batch's culling footprint.
 */
export function getContainedBatchCell(
  mesh: TileMeshRecord,
  tileSizeMeters: number,
  cellMeters: number
): string | null {
  if (!(cellMeters > 0 && tileSizeMeters > 0) ||
      tileSizeMeters % cellMeters !== 0) {
    throw new Error('Batch audit cell size must divide tile size exactly');
  }
  const half = tileSizeMeters * 0.5;
  const eps = 1e-5;
  const findCell = (min: number, max: number): number | null => {
    if (!Number.isFinite(min) || !Number.isFinite(max) ||
        min < -half - eps || max > half + eps || max < min) return null;
    const a = Math.floor((min + half + eps) / cellMeters);
    const b = Math.floor((max + half - (max > min ? eps : -eps)) / cellMeters);
    const n = tileSizeMeters / cellMeters;
    return a === b && a >= 0 && a < n ? a : null;
  };
  const x = findCell(
    mesh.bboxMin[0] + mesh.localPositionOffset[0],
    mesh.bboxMax[0] + mesh.localPositionOffset[0]
  );
  const z = findCell(
    mesh.bboxMin[2] + mesh.localPositionOffset[2],
    mesh.bboxMax[2] + mesh.localPositionOffset[2]
  );
  return x === null || z === null ? null : x + ':' + z;
}

function emptyLayer(layer: TileLayerKind): BatchAuditLayer {
  return {
    layer,
    meshes: 0,
    triangles: 0,
    staticSubmissionProxy: 0,
    serializedVisibleSubmissionProxy: 0,
    instancedBatches: 0,
    instances: 0,
    candidateMeshes: 0,
    candidateWithFeatureMapping: 0,
    candidateRequiringSemanticReview: 0,
    excludedByReason: {},
  };
}

function profileForTile(
  candidates: readonly MeshCandidate[],
  tileSizeMeters: number,
  cellMeters: number | null,
  baseSubmissions: number,
  baseVisibleSubmissions: number
): BatchAuditProfile {
  const groups = new Map<string, MeshCandidate[]>();
  let outside = 0;
  let within = 0;
  for (const candidate of candidates) {
    const cell = cellMeters === null
      ? 'whole_tile'
      : getContainedBatchCell(candidate.mesh, tileSizeMeters, cellMeters);
    if (cell === null) {
      outside++;
      continue;
    }
    within++;
    const key = cell + '|' + candidate.key;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  let saved = 0;
  let visibleSaved = 0;
  let mergeGroups = 0;
  let mergedMeshRecords = 0;
  const byLayerReduction: Record<string, number> = {};
  const byMaterialReduction: Record<string, number> = {};
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const reduction = group.length - 1;
    const head = group[0];
    mergeGroups++;
    mergedMeshRecords += group.length;
    saved += reduction;
    if (head.visible) visibleSaved += reduction;
    byLayerReduction[head.mesh.layer] = (byLayerReduction[head.mesh.layer] || 0) + reduction;
    const materialKey = head.mesh.layer + '/' + head.material;
    byMaterialReduction[materialKey] = (byMaterialReduction[materialKey] || 0) + reduction;
  }
  return {
    label: cellMeters === null ? 'whole-tile-unbounded' : String(cellMeters) + 'm-bounded',
    cellMeters,
    candidateMeshesWithinCells: within,
    candidateMeshesOutsideCells: outside,
    mergeGroups,
    mergedMeshRecords,
    submissionReductionProxy: saved,
    serializedVisibleReductionProxy: visibleSaved,
    afterSubmissionProxy: baseSubmissions - saved,
    afterSerializedVisibleSubmissionProxy: baseVisibleSubmissions - visibleSaved,
    byLayerReduction,
    byMaterialReduction,
  };
}

export function analyzeDecodedTileBatching(
  decoded: DecodedTilePayload,
  cellSizesMeters: readonly number[] = DEFAULT_BATCH_AUDIT_CELL_SIZES
): BatchAuditTile {
  const tileSize = decoded.tileSizeMeters;
  if (!(tileSize > 0)) throw new Error('Invalid decoded tile size');
  for (const cellSize of cellSizesMeters) {
    if (!Number.isSafeInteger(cellSize) ||
        cellSize <= 0 || tileSize % cellSize !== 0) {
      throw new Error('Batch audit cell sizes must be positive integer divisors of tile size');
    }
  }

  const layers: Record<string, BatchAuditLayer> = {};
  const ensureLayer = (layer: TileLayerKind): BatchAuditLayer =>
    (layers[layer] ??= emptyLayer(layer));
  const candidates: MeshCandidate[] = [];
  let staticSubmissions = 0;
  let visibleStaticSubmissions = 0;
  let triangles = 0;

  for (const mesh of decoded.meshes) {
    const stats = ensureLayer(mesh.layer);
    const units = estimateStaticMeshSubmissionProxy(mesh);
    const visible = (mesh.flags & TILE_MESH_FLAG_VISIBLE) !== 0;
    const triCount = (mesh.indices ? mesh.indices.length : mesh.positions.length / 3) / 3;
    stats.meshes++;
    stats.staticSubmissionProxy += units;
    stats.serializedVisibleSubmissionProxy += visible ? units : 0;
    stats.triangles += triCount;
    triangles += triCount;
    staticSubmissions += units;
    visibleStaticSubmissions += visible ? units : 0;

    const reason = getMeshBatchExclusionReason(mesh);
    if (reason) {
      stats.excludedByReason[reason] = (stats.excludedByReason[reason] ?? 0) + 1;
      continue;
    }
    stats.candidateMeshes++;
    if (mesh.singleFeatureIdx >= 0 || mesh.faceRanges.length > 0) {
      stats.candidateWithFeatureMapping++;
    }
    if (isSensitive(mesh, decoded)) stats.candidateRequiringSemanticReview++;
    const material = mesh.materialSlotKeys[0];
    // Delimit each component to avoid accidental material/key aliasing.
    const key = JSON.stringify([
      mesh.layer, material, mesh.renderOrder, mesh.flags, attributeSignature(mesh),
    ]);
    candidates.push({ mesh, material, key, visible });
  }

  let instances = 0;
  let visibleInstancedBatches = 0;
  for (const batch of decoded.instancedBatches) {
    const stats = ensureLayer(batch.layer);
    stats.instancedBatches++;
    stats.instances += batch.instanceCount;
    instances += batch.instanceCount;
    if ((batch.flags & TILE_MESH_FLAG_VISIBLE) !== 0) visibleInstancedBatches++;
  }
  const submissionProxy = staticSubmissions + decoded.instancedBatches.length;
  const visibleSubmissionProxy = visibleStaticSubmissions + visibleInstancedBatches;
  const featureCategories: Record<string, number> = {};
  for (const feature of decoded.featureInfos) {
    const category = feature.category || '(unknown)';
    featureCategories[category] = (featureCategories[category] ?? 0) + 1;
  }
  return {
    key: decoded.lod + ':' + decoded.tx + ':' + decoded.ty,
    tileSizeMeters: tileSize,
    staticMeshes: decoded.meshes.length,
    instanceBatches: decoded.instancedBatches.length,
    instances,
    submissionProxy,
    serializedVisibleSubmissionProxy: visibleSubmissionProxy,
    triangles,
    featureInfoRecords: decoded.featureInfos.length,
    featureCategories,
    layers,
    profiles: [
      profileForTile(candidates, tileSize, null, submissionProxy, visibleSubmissionProxy),
      ...cellSizesMeters.map((cell) =>
        profileForTile(candidates, tileSize, cell, submissionProxy, visibleSubmissionProxy)),
    ],
  };
}

function addCounts(dst: Record<string, number>, source: Record<string, number>): void {
  for (const [key, count] of Object.entries(source)) {
    dst[key] = (dst[key] ?? 0) + count;
  }
}

export function aggregateTileBatchAudits(
  tiles: readonly BatchAuditTile[]
): BatchAuditSummary {
  if (tiles.length === 0) throw new Error('Batch audit needs at least one tile');
  const mergedLayers: Record<string, BatchAuditLayer> = {};
  const mergedProfiles = tiles[0].profiles.map((p): BatchAuditProfile => ({
    ...p,
    byLayerReduction: {},
    byMaterialReduction: {},
    candidateMeshesWithinCells: 0,
    candidateMeshesOutsideCells: 0,
    mergeGroups: 0,
    mergedMeshRecords: 0,
    submissionReductionProxy: 0,
    serializedVisibleReductionProxy: 0,
    afterSubmissionProxy: 0,
    afterSerializedVisibleSubmissionProxy: 0,
  }));
  const featureCategories: Record<string, number> = {};
  const summary: BatchAuditSummary = {
    tiles: tiles.length,
    tileSizeMeters: tiles.every((t) => t.tileSizeMeters === tiles[0].tileSizeMeters)
      ? tiles[0].tileSizeMeters : 'mixed',
    staticMeshes: 0,
    instanceBatches: 0,
    instances: 0,
    submissionProxy: 0,
    serializedVisibleSubmissionProxy: 0,
    triangles: 0,
    featureInfoRecords: 0,
    featureCategories,
    layers: mergedLayers,
    profiles: mergedProfiles,
    hotspots: [],
  };
  for (const tile of tiles) {
    if (tile.profiles.length !== mergedProfiles.length ||
        tile.profiles.some((p, i) => p.label !== mergedProfiles[i].label)) {
      throw new Error('All audited tiles must use identical spatial profile labels');
    }
    summary.staticMeshes += tile.staticMeshes;
    summary.instanceBatches += tile.instanceBatches;
    summary.instances += tile.instances;
    summary.submissionProxy += tile.submissionProxy;
    summary.serializedVisibleSubmissionProxy += tile.serializedVisibleSubmissionProxy;
    summary.triangles += tile.triangles;
    summary.featureInfoRecords += tile.featureInfoRecords;
    addCounts(featureCategories, tile.featureCategories);
    for (const [layer, src] of Object.entries(tile.layers)) {
      const dst = (mergedLayers[layer] ??= emptyLayer(src.layer));
      dst.meshes += src.meshes;
      dst.triangles += src.triangles;
      dst.staticSubmissionProxy += src.staticSubmissionProxy;
      dst.serializedVisibleSubmissionProxy += src.serializedVisibleSubmissionProxy;
      dst.instancedBatches += src.instancedBatches;
      dst.instances += src.instances;
      dst.candidateMeshes += src.candidateMeshes;
      dst.candidateWithFeatureMapping += src.candidateWithFeatureMapping;
      dst.candidateRequiringSemanticReview += src.candidateRequiringSemanticReview;
      addCounts(dst.excludedByReason, src.excludedByReason);
    }
    for (let i = 0; i < mergedProfiles.length; i++) {
      const dst = mergedProfiles[i];
      const src = tile.profiles[i];
      dst.candidateMeshesWithinCells += src.candidateMeshesWithinCells;
      dst.candidateMeshesOutsideCells += src.candidateMeshesOutsideCells;
      dst.mergeGroups += src.mergeGroups;
      dst.mergedMeshRecords += src.mergedMeshRecords;
      dst.submissionReductionProxy += src.submissionReductionProxy;
      dst.serializedVisibleReductionProxy += src.serializedVisibleReductionProxy;
      dst.afterSubmissionProxy += src.afterSubmissionProxy;
      dst.afterSerializedVisibleSubmissionProxy += src.afterSerializedVisibleSubmissionProxy;
      addCounts(dst.byLayerReduction, src.byLayerReduction);
      addCounts(dst.byMaterialReduction, src.byMaterialReduction);
    }
    const reference = tile.profiles.find((p) => p.cellMeters === 256)
      ?? tile.profiles[0];
    summary.hotspots.push({
      tile: tile.key,
      reductionProxy: reference.submissionReductionProxy,
      staticMeshes: tile.staticMeshes,
    });
  }
  summary.hotspots.sort((a, b) =>
    b.reductionProxy - a.reductionProxy ||
    b.staticMeshes - a.staticMeshes ||
    a.tile.localeCompare(b.tile));
  summary.hotspots = summary.hotspots.slice(0, 15);
  return summary;
}
