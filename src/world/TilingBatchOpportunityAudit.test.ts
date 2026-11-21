import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  DecodedTilePayload,
  TileInstancedBatchRecord,
  TileMeshRecord,
} from './tiling/TilePackContract';
import {
  TILE_MESH_FLAG_VISIBLE,
} from './tiling/TilePackContract';
import {
  analyzeDecodedTileBatching,
  aggregateTileBatchAudits,
  getContainedBatchCell,
  getMeshBatchExclusionReason,
} from './tiling/TileBatchOpportunityAudit';
import { parseBatchAuditCli } from '../../scripts/audit-tile-batching';

function mesh(
  options: Partial<TileMeshRecord> = {},
  x = -470,
  z = -470
): TileMeshRecord {
  return {
    layer: 'roads',
    name: 'Roads_residential',
    materialSlotKeys: ['road:residential'],
    renderOrder: 1,
    flags: TILE_MESH_FLAG_VISIBLE,
    localPositionOffset: [0, 0, 0],
    bboxMin: [x, 0, z],
    bboxMax: [x + 5, 0, z + 5],
    positions: new Float32Array([x, 0, z, x + 5, 0, z, x, 0, z + 5]),
    normals: null,
    uvs: null,
    switchAttrs: null,
    colors: null,
    indices: null,
    groups: [],
    faceRanges: [],
    singleFeatureIdx: -1,
    bvh: null,
    ...options,
  };
}

function tile(
  meshes: TileMeshRecord[],
  batches: TileInstancedBatchRecord[] = [],
  tx = 0,
  ty = 0
): DecodedTilePayload {
  return {
    formatVersion: 1,
    lod: 0,
    tx,
    ty,
    tileCenterX: 0,
    tileCenterZ: 0,
    tileSizeMeters: 1024,
    overhangBoundsMin: [-512, 0, -512],
    overhangBoundsMax: [512, 10, 512],
    flags: 0,
    renderedFeaturesCount: 2,
    forestTreesCount: 0,
    sleeper3DBoxCount: 0,
    totalVertices: 3 * meshes.length,
    totalTriangles: meshes.length,
    totalDrawCalls: meshes.length + batches.length,
    railwayRenderSource: 'graph_extrusion',
    featureInfos: [{
      id: 'test-way',
      sourceFeatureId: 'way/test',
      category: 'Road & Way',
      cartoLabel: 'Residential street',
      primaryTag: 'highway=residential',
      subtype: 'residential',
      osmTags: {},
    }],
    meshes,
    instancedBatches: batches,
    byteLength: 512,
  };
}

function instanceBatch(): TileInstancedBatchRecord {
  return {
    layer: 'foliage',
    name: 'ProceduralForest_Trunks',
    materialSlotKey: 'foliage:trunk',
    prototypeKind: 'tree_trunk',
    renderOrder: 1,
    flags: TILE_MESH_FLAG_VISIBLE,
    bboxMin: [-2, 0, -2],
    bboxMax: [2, 8, 2],
    instanceCount: 3,
    matrices: new Float32Array(16 * 3),
    instanceColors: null,
    instanceFeatureIdxs: new Int32Array([-1, -1, -1]),
    sleeperBoxes: null,
  };
}

function profile(
  output: ReturnType<typeof analyzeDecodedTileBatching>,
  cell: number | null
) {
  const found = output.profiles.find((p) => p.cellMeters === cell);
  assert.ok(found);
  return found;
}

test('TKT-030: compatible meshes group by material and spatial cell, never across cells', () => {
  const a = mesh({ singleFeatureIdx: 0 });
  const b = mesh({ faceRanges: [{ startFace: 0, endFace: 1, infoIdx: 0 }] }, -450, -455);
  const c = mesh({}, -210, -470);
  const result = analyzeDecodedTileBatching(tile([a, b, c]), [128, 256, 512]);
  assert.equal(result.submissionProxy, 3);
  assert.equal(result.layers.roads.candidateMeshes, 3);
  assert.equal(result.layers.roads.candidateWithFeatureMapping, 2);
  assert.equal(result.layers.roads.candidateRequiringSemanticReview, 3);
  assert.equal(profile(result, null).submissionReductionProxy, 2);
  assert.equal(profile(result, 128).submissionReductionProxy, 1);
  assert.equal(profile(result, 256).submissionReductionProxy, 1);
  assert.equal(profile(result, 512).submissionReductionProxy, 2);
  assert.equal(profile(result, 256).afterSubmissionProxy, 2);
  assert.equal(result.featureCategories['Road & Way'], 1);
});

test('TKT-030: render state, attribute layout and material must not be mixed', () => {
  const source = mesh();
  const changedMaterial = mesh({ materialSlotKeys: ['road:primary'] }, -459, -459);
  const changedRenderOrder = mesh({ renderOrder: 2 }, -450, -450);
  const changedFlags = mesh({ flags: 0 }, -445, -445);
  const changedAttributes = mesh({ uvs: new Float32Array([0, 0, 0, 1, 1, 0]) }, -440, -440);
  const result = analyzeDecodedTileBatching(tile([
    source, changedMaterial, changedRenderOrder, changedFlags, changedAttributes,
  ]), [256]);
  assert.equal(profile(result, null).submissionReductionProxy, 0);
  assert.equal(profile(result, 256).submissionReductionProxy, 0);
  assert.equal(result.serializedVisibleSubmissionProxy, 4);
});

test('TKT-030: multi-material meshes, railway zoom alternatives and instancing are never counted as new batch candidates', () => {
  const mm = mesh({
    layer: 'buildings',
    name: 'Buildings_default',
    materialSlotKeys: ['building:roof:default', 'building:wall:default'],
    groups: [{ start: 0, count: 3, materialIndex: 0 }, { start: 0, count: 3, materialIndex: 1 }],
  });
  const railway = mesh({
    layer: 'railways',
    name: 'Railway_Rails_3D_chunk_1',
    materialSlotKeys: ['railway:rails_3d'],
  });
  const ground = mesh({ layer: 'ground', materialSlotKeys: ['ground'] });
  const chunked = mesh({ chunkKey: 'semantic-rail-corridor' });
  const result = analyzeDecodedTileBatching(
    tile([mm, railway, ground, chunked], [instanceBatch()]),
    [256]
  );
  assert.equal(result.staticMeshes, 4);
  assert.equal(result.instanceBatches, 1);
  assert.equal(result.instances, 3);
  assert.equal(result.submissionProxy, 6);
  assert.equal(profile(result, null).submissionReductionProxy, 0);
  assert.equal(result.layers.buildings.excludedByReason.multi_material_or_missing_material, 1);
  assert.equal(result.layers.railways.excludedByReason.railway_zoom_or_chunk_semantics, 1);
  assert.equal(result.layers.ground.excludedByReason.ground, 1);
  assert.equal(result.layers.roads.excludedByReason.semantic_chunk_parent, 1);
  assert.equal(result.layers.foliage.instancedBatches, 1);
});

test('TKT-030: contained cell test rejects crossing meshes and geometry outside tile bounds', () => {
  assert.equal(getContainedBatchCell(mesh(), 1024, 256), '0:0');
  assert.equal(getContainedBatchCell(mesh({}, -300, -300), 1024, 256), '0:0');
  assert.equal(getContainedBatchCell(mesh({}, -260, -470), 1024, 256), null);
  assert.equal(getContainedBatchCell(mesh({}, -520, -470), 1024, 256), null);
  assert.equal(getContainedBatchCell(mesh({ localPositionOffset: [300, 0, 0] }), 1024, 256), '1:0');
  assert.throws(() => getContainedBatchCell(mesh(), 1024, 300), /divide tile size/);
  assert.equal(getMeshBatchExclusionReason(mesh({
    groups: [
      { start: 0, count: 1, materialIndex: 0 },
      { start: 1, count: 2, materialIndex: 0 },
    ],
  })), 'nontrivial_material_groups');
});

test('TKT-030: different tiles stay separate even if materials and positions match', () => {
  const a = analyzeDecodedTileBatching(tile([mesh(), mesh({}, -454, -450)], [], 0, 0), [256]);
  const b = analyzeDecodedTileBatching(tile([mesh()], [], 1, 0), [256]);
  const agg = aggregateTileBatchAudits([a, b]);
  assert.equal(agg.tiles, 2);
  assert.equal(agg.staticMeshes, 3);
  assert.equal(agg.submissionProxy, 3);
  assert.equal(agg.profiles.find((p) => p.cellMeters === 256)?.submissionReductionProxy, 1);
  assert.equal(agg.profiles.find((p) => p.cellMeters === 256)?.afterSubmissionProxy, 2);
  assert.equal(agg.layers.roads.candidateMeshes, 3);
  assert.equal(agg.featureInfoRecords, 2);
  assert.equal(agg.hotspots[0].tile, '0:0:0');
  assert.throws(() => aggregateTileBatchAudits([]), /at least one tile/);
});

test('TKT-030: OSM feature categories, primary tags, bridges and layers survive aggregation', () => {
  const sample = tile([mesh({ singleFeatureIdx: 0 })]);
  sample.featureInfos[0].isBridge = true;
  sample.featureInfos[0].layer = 1;
  const analyzed = analyzeDecodedTileBatching(sample, [256]);
  assert.equal(analyzed.featureCategories['Road & Way'], 1);
  assert.equal(analyzed.featurePrimaryTags['highway=residential'], 1);
  assert.equal(analyzed.semanticFeatureFlags.bridges, 1);
  assert.equal(analyzed.semanticFeatureFlags.nonzeroLayers, 1);
  assert.equal(analyzed.semanticFeatureFlags.tunnels, 0);
  const combined = aggregateTileBatchAudits([analyzed, analyzed]);
  assert.equal(combined.featurePrimaryTags['highway=residential'], 2);
  assert.equal(combined.semanticFeatureFlags.bridges, 2);
});

test('TKT-030: CLI defaults to 1024m pack and rejects conflicting/invalid sampling flags', () => {
  const parsed = parseBatchAuditCli([]);
  assert.ok(parsed.packPath?.endsWith('1024m.sqlite'));
  assert.deepEqual(parsed.cellSizesMeters, [128, 256, 512]);
  assert.equal(parsed.regionIndexPath, null);
  const chosen = parseBatchAuditCli([
    '--region-index=data/osm/twente-pilot-1024m/mosaic.json',
    '--cell-meters=512,128,256',
    '--max-tiles=4',
  ]);
  assert.ok(chosen.regionIndexPath?.endsWith('mosaic.json'));
  assert.deepEqual(chosen.cellSizesMeters, [128, 256, 512]);
  assert.equal(chosen.maxTiles, 4);
  assert.throws(() => parseBatchAuditCli(['--pack=a', '--region-index=b']), /either/);
  assert.throws(() => parseBatchAuditCli(['--cell-meters=128,128']), /unique/);
  assert.throws(() => parseBatchAuditCli(['--max-tiles=-5']), /positive/);
  assert.throws(() => parseBatchAuditCli(['--nope=1']), /Unknown/);
});
