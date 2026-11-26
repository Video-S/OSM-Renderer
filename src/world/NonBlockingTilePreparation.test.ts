import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  BAKE_SCHEMA_VERSION,
  CANONICAL_HENGELO_SNAPSHOT_ID,
  CANONICAL_HENGELO_SOURCE_SHA256,
  DEFAULT_PROJECTION_ID,
  OSMTILE1_FORMAT_VERSION,
  TILE_MESH_FLAG_HAS_BVH,
  TILE_MESH_FLAG_VISIBLE,
  TILE_PAYLOAD_FLAG_HAS_BVH,
  UNIT_SLEEPER_BOX_LOCAL_BOUNDS,
  computeLodPolicyHash,
  type DecodedTilePayload,
  type TileManifestEntry,
  type TileSleeperBearerBox,
} from './tiling/TilePackContract';
import {
  buildTileLocalBvh,
  decodeTileBinary,
  encodeDecodedTilePayloadToBinary,
} from './tiling/TileBinaryCodec';
import {
  decodeTileBinaryCompact,
  isCompactDecodedTilePayload,
  materializeDecodedTilePayloadFromCompact,
} from './tiling/CompactTileTransport';
import {
  collectTileTransferables,
  prepareTileInWorker,
} from './tiling/TileDecodeWorker';
import {
  TILE_PREPARATION_VARIANT_PRESETS,
  identifyTilePreparationVariant,
  parseTilePreparationOptionsFromSearch,
  resolveTilePreparationOptions,
  type TilePreparationVariantId,
} from './tiling/TilePreparationConfig';
import { reconstructTileSceneFromDecoded } from './tiling/TileSceneReconstructor';
import { ThemeMaterialRegistry } from './tiling/ThemeMaterialRegistry';
import {
  TileStreamManager,
  type TilePackManifestPayload,
} from './tiling/TileStreamManager';
import { StreamingProfiler } from './tiling/StreamingProfiler';
import {
  attributeWorstFrames,
  summarizeEventConditionedFrames,
  summarizeWorkerDeliveryMetrics,
  verifyFrameStageNesting,
} from './tiling/StreamingFluidityStats';
import {
  getInstancedSpatialIndex,
  setInstancedPickingMode,
} from './InstancedSpatialIndex';
import {
  computeConservativeInstancedBounds,
  computeFoliagePrototypeUnionLocalBoundsArray,
  resolveFoliageRuntimeState,
} from './FoliageLodSystem';
import { buildUnitSleeperBoxGeometry } from './infrastructure/railways/RailwayGeometryBuilder';
import { resolveInspectedFeature } from './GeometryBuilder';
import { MAP_THEMES } from '../styles/mapThemes';
import { deflateTilePayload } from '../server/tiles/TileCompression';
import type { InspectableFeatureInfo } from '../types/MapFeature';

function createRichSyntheticTilePayload(
  tx = 0,
  ty = 0,
  tileSizeMeters = 1024,
  treeCount = 96,
  sleeperCount = 32
): DecodedTilePayload {
  const half = tileSizeMeters * 0.5;

  // 2-building combined mesh with multi-faceRanges + multi-group
  const b1 = new THREE.BoxGeometry(14, 10, 14);
  b1.translate(-40, 5, -20);
  const b2 = new THREE.BoxGeometry(12, 16, 10);
  b2.translate(35, 8, 25);

  const p1 = b1.attributes.position.array as Float32Array;
  const n1 = b1.attributes.normal.array as Float32Array;
  const u1 = b1.attributes.uv.array as Float32Array;
  const i1 = b1.index!.array as Uint16Array;

  const p2 = b2.attributes.position.array as Float32Array;
  const n2 = b2.attributes.normal.array as Float32Array;
  const u2 = b2.attributes.uv.array as Float32Array;
  const i2 = b2.index!.array as Uint16Array;

  const vertOffset = p1.length / 3;
  const positions = new Float32Array(p1.length + p2.length);
  positions.set(p1, 0);
  positions.set(p2, p1.length);

  const normals = new Float32Array(n1.length + n2.length);
  normals.set(n1, 0);
  normals.set(n2, n1.length);

  const uvs = new Float32Array(u1.length + u2.length);
  uvs.set(u1, 0);
  uvs.set(u2, u1.length);

  const indices = new Uint16Array(i1.length + i2.length);
  indices.set(i1, 0);
  for (let k = 0; k < i2.length; k++) {
    indices[i1.length + k] = i2[k] + vertOffset;
  }

  const f1Count = i1.length / 3;
  const f2Count = i2.length / 3;
  const bvh = buildTileLocalBvh(positions, indices);
  b1.dispose();
  b2.dispose();

  // Single-feature road mesh
  const roadGeo = new THREE.BoxGeometry(60, 0.4, 8);
  roadGeo.translate(0, 0.2, 0);
  const roadPos = new Float32Array(roadGeo.attributes.position.array as Float32Array);
  const roadNorm = new Float32Array(roadGeo.attributes.normal.array as Float32Array);
  const roadUv = new Float32Array(roadGeo.attributes.uv.array as Float32Array);
  const roadIdx = new Uint16Array(roadGeo.index!.array as Uint16Array);
  const roadBvh = buildTileLocalBvh(roadPos, roadIdx);
  roadGeo.dispose();

  // Broadleaved canopy + trunk instanced batches
  const dummy = new THREE.Object3D();
  const canopyMatrices = new Float32Array(treeCount * 16);
  const canopyColors = new Float32Array(treeCount * 3);
  const canopyFeatureIdxs = new Int32Array(treeCount);
  const trunkMatrices = new Float32Array(treeCount * 16);
  const trunkFeatureIdxs = new Int32Array(treeCount);

  for (let i = 0; i < treeCount; i++) {
    const col = i % 12;
    const row = Math.floor(i / 12);
    const x = -180 + col * 32 + ((i * 7) % 5);
    const z = -140 + row * 34 + ((i * 11) % 5);
    const scale = 0.8 + (i % 5) * 0.15;
    dummy.position.set(x, 4.5 * scale, z);
    dummy.rotation.set(0, (i * 0.37) % (Math.PI * 2), 0);
    dummy.scale.set(scale, scale, scale);
    dummy.updateMatrix();
    dummy.matrix.toArray(canopyMatrices, i * 16);
    canopyColors[i * 3] = 0.2 + (i % 4) * 0.05;
    canopyColors[i * 3 + 1] = 0.5 + (i % 3) * 0.06;
    canopyColors[i * 3 + 2] = 0.2;
    canopyFeatureIdxs[i] = i % 2 === 0 ? 3 : 4;

    dummy.position.set(x, 0, z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(0.35 * scale, 4.0 * scale, 0.35 * scale);
    dummy.updateMatrix();
    dummy.matrix.toArray(trunkMatrices, i * 16);
    trunkFeatureIdxs[i] = canopyFeatureIdxs[i];
  }

  // Railway sleeper instanced batch with sleeperBoxes
  const sleeperMatrices = new Float32Array(sleeperCount * 16);
  const sleeperFeatureIdxs = new Int32Array(sleeperCount);
  const sleeperBoxes: TileSleeperBearerBox[] = [];

  for (let i = 0; i < sleeperCount; i++) {
    const x = -90 + i * 5.5;
    const z = 85;
    dummy.position.set(x, 0.1, z);
    dummy.rotation.set(0, 0.15, 0);
    dummy.scale.set(0.28, 0.18, 2.4);
    dummy.updateMatrix();
    dummy.matrix.toArray(sleeperMatrices, i * 16);
    sleeperFeatureIdxs[i] = 5;
    sleeperBoxes.push({
      cx: x,
      cz: z,
      yBottom: 0.1,
      yTop: 0.28,
      tx: Math.cos(0.15),
      tz: Math.sin(0.15),
      nx: -Math.sin(0.15),
      nz: Math.cos(0.15),
      halfLen: 0.14,
      halfWidthLeft: 1.2,
      halfWidthRight: 1.2,
      trackId: `trk-${tx}-${ty}`,
    });
  }

  const featureInfos: InspectableFeatureInfo[] = [
    {
      id: `way/bldg-a-${tx}-${ty}`,
      sourceFeatureId: `way/bldg-a-${tx}-${ty}`,
      category: 'Building',
      cartoLabel: 'Residential Building',
      primaryTag: 'building=residential',
      subtype: 'residential',
      name: 'Hengelo Woning Café',
      height: 10,
      osmTags: { building: 'residential', 'addr:city': 'Hengelo' },
    },
    {
      id: `way/bldg-b-${tx}-${ty}`,
      sourceFeatureId: `way/bldg-b-${tx}-${ty}`,
      category: 'Building',
      cartoLabel: 'Commercial Building',
      primaryTag: 'building=commercial',
      subtype: 'commercial',
      name: 'Twente Tower',
      height: 16,
      osmTags: { building: 'commercial', levels: '5' },
    },
    {
      id: `way/road-${tx}-${ty}`,
      sourceFeatureId: `way/road-${tx}-${ty}`,
      category: 'Road',
      cartoLabel: 'Primary Road',
      primaryTag: 'highway=primary',
      subtype: 'primary',
      name: 'Deldenerstraat',
      width: 8,
      isBridge: false,
      isTunnel: false,
      osmTags: { highway: 'primary', surface: 'asphalt' },
    },
    {
      id: `way/forest-a-${tx}-${ty}`,
      sourceFeatureId: `way/forest-a-${tx}-${ty}`,
      category: 'Terrain & Nature',
      cartoLabel: 'Broadleaf Forest',
      primaryTag: 'natural=wood',
      subtype: 'wood',
      name: 'Bos West',
      osmTags: { natural: 'wood', leaf_type: 'broadleaved' },
    },
    {
      id: `way/forest-b-${tx}-${ty}`,
      sourceFeatureId: `way/forest-b-${tx}-${ty}`,
      category: 'Terrain & Nature',
      cartoLabel: 'Park Trees',
      primaryTag: 'leisure=park',
      subtype: 'park',
      name: 'Prins Bernhardplantsoen',
      osmTags: { leisure: 'park' },
    },
    {
      id: `way/rail-${tx}-${ty}`,
      sourceFeatureId: `way/rail-${tx}-${ty}`,
      category: 'Railway',
      cartoLabel: 'Mainline Rail',
      primaryTag: 'railway=rail',
      subtype: 'rail',
      name: 'Spoorlijn Almelo–Salzbergen',
      osmTags: { railway: 'rail', electrified: 'contact_line' },
    },
  ];

  return {
    formatVersion: OSMTILE1_FORMAT_VERSION,
    lod: 0,
    tx,
    ty,
    tileSizeMeters,
    tileCenterX: (tx + 0.5) * tileSizeMeters,
    tileCenterZ: (ty + 0.5) * tileSizeMeters,
    overhangBoundsMin: [-half, 0, -half],
    overhangBoundsMax: [half, 30, half],
    totalTriangles: f1Count + f2Count + roadIdx.length / 3,
    totalVertices: positions.length / 3 + roadPos.length / 3,
    totalDrawCalls: 5,
    renderedFeaturesCount: featureInfos.length,
    forestTreesCount: treeCount,
    sleeper3DBoxCount: sleeperCount,
    railwayRenderSource: 'graph-R+',
    flags: TILE_PAYLOAD_FLAG_HAS_BVH,
    meshes: [
      {
        layer: 'buildings',
        name: `Buildings_Tile_${tx}_${ty}`,
        materialSlotKeys: ['building:wall:default', 'building:roof:default'],
        renderOrder: 0,
        flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_HAS_BVH,
        localPositionOffset: [0, 0, 0],
        bboxMin: [-47, 0, -27],
        bboxMax: [41, 16, 30],
        positions,
        normals,
        uvs,
        switchAttrs: null,
        colors: null,
        indices,
        groups: [
          { start: 0, count: i1.length, materialIndex: 0 },
          { start: i1.length, count: i2.length, materialIndex: 1 },
        ],
        faceRanges: [
          { startFace: 0, endFace: f1Count - 1, infoIdx: 0 },
          { startFace: f1Count, endFace: f1Count + f2Count - 1, infoIdx: 1 },
        ],
        singleFeatureIdx: -1,
        bvh,
      },
      {
        layer: 'roads',
        name: `Roads_Tile_${tx}_${ty}`,
        materialSlotKeys: ['road:primary'],
        renderOrder: 1,
        flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_HAS_BVH,
        localPositionOffset: [0, 0, 0],
        bboxMin: [-30, 0, -4],
        bboxMax: [30, 0.4, 4],
        positions: roadPos,
        normals: roadNorm,
        uvs: roadUv,
        switchAttrs: null,
        colors: null,
        indices: roadIdx,
        groups: [{ start: 0, count: roadIdx.length, materialIndex: 0 }],
        faceRanges: [],
        singleFeatureIdx: 2,
        bvh: roadBvh,
      },
    ],
    instancedBatches: [
      {
        layer: 'foliage',
        name: 'ProceduralForest_BroadleavedCanopy',
        materialSlotKey: 'foliage:broadleaved',
        prototypeKind: 'tree_broadleaved',
        renderOrder: 0,
        flags: TILE_MESH_FLAG_VISIBLE,
        bboxMin: [-half, 0, -half],
        bboxMax: [half, 20, half],
        instanceCount: treeCount,
        matrices: canopyMatrices,
        instanceColors: canopyColors,
        instanceFeatureIdxs: canopyFeatureIdxs,
        sleeperBoxes: null,
      },
      {
        layer: 'foliage',
        name: 'ProceduralForest_TreeTrunks',
        materialSlotKey: 'foliage:trunk',
        prototypeKind: 'tree_trunk',
        renderOrder: 0,
        flags: TILE_MESH_FLAG_VISIBLE,
        bboxMin: [-half, 0, -half],
        bboxMax: [half, 10, half],
        instanceCount: treeCount,
        matrices: trunkMatrices,
        instanceColors: null,
        instanceFeatureIdxs: trunkFeatureIdxs,
        sleeperBoxes: null,
      },
      {
        layer: 'railways',
        name: 'Railway_Sleepers_Instanced',
        materialSlotKey: 'railway:sleeper',
        prototypeKind: 'sleeper_box_unit',
        renderOrder: 2,
        flags: TILE_MESH_FLAG_VISIBLE,
        bboxMin: [-100, 0, 80],
        bboxMax: [100, 1, 90],
        instanceCount: sleeperCount,
        matrices: sleeperMatrices,
        instanceColors: null,
        instanceFeatureIdxs: sleeperFeatureIdxs,
        sleeperBoxes,
      },
    ],
    featureInfos,
    byteLength: 0,
  };
}

test('TilePreparationConfig resolves all 5 presets, query strings, and custom overrides accurately', () => {
  const variants: TilePreparationVariantId[] = [
    'baseline',
    'transfer_only',
    'compact_transport',
    'worker_bvh',
    'combined',
  ];
  for (const v of variants) {
    const resolved = resolveTilePreparationOptions(v);
    assert.equal(identifyTilePreparationVariant(resolved), v);
    const parsed = parseTilePreparationOptionsFromSearch(`?tilePrepVariant=${v}`);
    assert.deepEqual(parsed, TILE_PREPARATION_VARIANT_PRESETS[v]);
  }
  assert.equal(
    identifyTilePreparationVariant(parseTilePreparationOptionsFromSearch('')),
    'combined'
  );
  assert.equal(
    identifyTilePreparationVariant(
      resolveTilePreparationOptions({
        transferAllTypedArrays: true,
        compactMetadataTransport: false,
        workerInstanceBvh: true,
        optimizeMainThreadPrep: false,
      })
    ),
    'worker_bvh'
  );
});

test('Work Package B1: collectTileTransferables audits completeness, deduplicates shared backing buffers, and preserves byteOffsets', () => {
  const payload = createRichSyntheticTilePayload(0, 0, 1024, 32, 16);
  const raw = encodeDecodedTilePayloadToBinary(payload);

  // Baseline intentionally omits instanceFeatureIdxs
  const baselinePrep = prepareTileInWorker(
    raw,
    '0:0',
    TILE_PREPARATION_VARIANT_PRESETS.baseline,
    true
  );
  assert.equal(isCompactDecodedTilePayload(baselinePrep.decoded), false);
  const baselineDecoded = baselinePrep.decoded as DecodedTilePayload;
  const baselineTransfer = collectTileTransferables(
    baselineDecoded,
    TILE_PREPARATION_VARIANT_PRESETS.baseline
  );
  const baselineSet = new Set(baselineTransfer.transferables);
  assert.equal(
    baselineSet.has(baselineDecoded.instancedBatches[0].instanceFeatureIdxs.buffer),
    false,
    'Baseline mode must preserve TKT-039 omission of instanceFeatureIdxs for honest A/B testing'
  );

  // transfer_only transfers ALL typed arrays including instanceFeatureIdxs and deduplicates shared buffers
  const sharedBuf = new ArrayBuffer(1024);
  const sharedViewA = new Float32Array(sharedBuf, 0, 16);
  const sharedViewB = new Int32Array(sharedBuf, 64, 1);
  sharedViewA[0] = 42;
  sharedViewB[0] = 3;

  const transferPrep = prepareTileInWorker(
    raw,
    '0:0',
    TILE_PREPARATION_VARIANT_PRESETS.transfer_only,
    true
  );
  const transferDecoded = transferPrep.decoded as DecodedTilePayload;
  transferDecoded.instancedBatches[0].matrices = sharedViewA;
  transferDecoded.instancedBatches[0].instanceFeatureIdxs = sharedViewB;
  const transferAudit = collectTileTransferables(
    transferDecoded,
    TILE_PREPARATION_VARIANT_PRESETS.transfer_only
  );
  const transferSet = new Set(transferAudit.transferables);
  assert.equal(
    transferSet.size,
    transferAudit.transferables.length,
    'Transferables list must never contain duplicate ArrayBuffers'
  );
  assert.equal(
    transferSet.has(sharedBuf),
    true,
    'Shared ArrayBuffer backing matrices & instanceFeatureIdxs must be included once'
  );
  for (const m of transferDecoded.meshes) {
    assert.ok(transferSet.has(m.positions.buffer));
    assert.ok(transferSet.has(m.normals.buffer));
    assert.ok(transferSet.has(m.indices.buffer));
    if (m.uvs) assert.ok(transferSet.has(m.uvs.buffer));
    if (m.bvh) {
      for (const r of m.bvh.roots) {
        assert.ok(transferSet.has(r));
      }
    }
  }
  for (const b of transferDecoded.instancedBatches) {
    assert.ok(transferSet.has(b.matrices.buffer));
    assert.ok(transferSet.has(b.instanceFeatureIdxs.buffer));
    if (b.instanceColors) assert.ok(transferSet.has(b.instanceColors.buffer));
  }

  // Combined compact + worker_bvh: verify structuredClone with transfer preserves byteOffset/byteLength and all buffers
  const combinedPrep = prepareTileInWorker(
    raw,
    '0:0',
    TILE_PREPARATION_VARIANT_PRESETS.combined,
    true
  );
  assert.equal(isCompactDecodedTilePayload(combinedPrep.decoded), true);
  assert.ok(combinedPrep.transferables.length > 10);
  assert.ok(combinedPrep.transferableBytes > 0);
  const cloned = structuredClone(combinedPrep.decoded, {
    transfer: combinedPrep.transferables,
  });
  assert.equal(isCompactDecodedTilePayload(cloned), true);
  if (isCompactDecodedTilePayload(cloned)) {
    assert.equal(cloned.instancedBatches[0].matrices.byteLength, 32 * 16 * 4);
    assert.equal(cloned.instancedBatches[0].preparedSpatialIndex?.builtInWorker, true);
    assert.ok((cloned.instancedBatches[0].preparedSpatialIndex?.nodeCount ?? 0) > 0);
  }
});

test('Work Package B2: decodeTileBinaryCompact preserves exact OSMTILE1 v1 parity, lazy zero-eager materialization, and resolveInspectedFeature accuracy', () => {
  const payload = createRichSyntheticTilePayload(1, -2, 1024, 64, 24);
  const raw = encodeDecodedTilePayloadToBinary(payload);

  const legacy = decodeTileBinary(raw);
  const compact = decodeTileBinaryCompact(raw);

  // Full materialized parity against decodeTileBinary
  const rematerialized = materializeDecodedTilePayloadFromCompact(compact);
  assert.equal(rematerialized.meshes.length, legacy.meshes.length);
  assert.equal(rematerialized.instancedBatches.length, legacy.instancedBatches.length);
  assert.deepEqual(rematerialized.featureInfos, legacy.featureInfos);
  assert.deepEqual(rematerialized.meshes[0].groups, legacy.meshes[0].groups);
  assert.deepEqual(rematerialized.meshes[0].faceRanges, legacy.meshes[0].faceRanges);
  assert.deepEqual(
    rematerialized.instancedBatches[2].sleeperBoxes,
    legacy.instancedBatches[2].sleeperBoxes
  );

  // Precomputed memory footprint populated
  assert.ok(compact.precomputedFootprint.cpuGeometryBytes > 0);
  assert.ok(compact.precomputedFootprint.bvhBytes > 0);
  assert.equal(compact.precomputedFootprint.instancedBatchCount, 3);

  // UNIT_SLEEPER_BOX_LOCAL_BOUNDS matches buildUnitSleeperBoxGeometry().boundingBox exactly
  const unitSleeperGeo = buildUnitSleeperBoxGeometry();
  unitSleeperGeo.computeBoundingBox();
  const bb = unitSleeperGeo.boundingBox!;
  assert.deepEqual(
    [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z],
    Array.from(UNIT_SLEEPER_BOX_LOCAL_BOUNDS)
  );
  unitSleeperGeo.dispose();

  // Reconstruct compact payload with combined options -> zero eager featureInfos materialized
  const prepared = prepareTileInWorker(
    raw,
    '1:-2',
    TILE_PREPARATION_VARIANT_PRESETS.combined,
    true
  );
  const registry = new ThemeMaterialRegistry(MAP_THEMES.daylight);
  const recon = reconstructTileSceneFromDecoded(prepared.decoded, {
    materialRegistry: registry,
    optimizeMainThreadPrep: true,
    collectStageTimings: true,
  });

  const bldgMesh = recon.scene.buildingsGroup.getObjectByName(
    'Buildings_Tile_1_-2'
  ) as THREE.Mesh;
  assert.ok(bldgMesh);
  const featureTable = bldgMesh.userData.__featureTable;
  assert.ok(featureTable, 'Compact reconstruction should attach LazyTileFeatureTable');
  assert.equal(
    featureTable.materializedCount,
    0,
    'Zero InspectableFeatureInfo objects should be eagerly allocated on tile reconstruction'
  );

  // Verify resolveInspectedFeature works via fast compact paths without forcing legacy arrays
  const hitBldg0 = resolveInspectedFeature({ object: bldgMesh, faceIndex: 0 } as any);
  const hitBldg1 = resolveInspectedFeature({ object: bldgMesh, faceIndex: 13 } as any);
  assert.equal(hitBldg0?.id, 'way/bldg-a-1--2');
  assert.equal(hitBldg0?.name, 'Hengelo Woning Café');
  assert.equal(hitBldg1?.id, 'way/bldg-b-1--2');
  assert.equal(
    featureTable.materializedCount,
    2,
    'Only the 2 actually inspected features should be materialized'
  );

  const roadMesh = recon.scene.roadsGroup.getObjectByName(
    'Roads_Tile_1_-2'
  ) as THREE.Mesh;
  assert.ok(roadMesh);
  const hitRoad = resolveInspectedFeature({ object: roadMesh, faceIndex: 0 } as any);
  assert.equal(hitRoad?.id, 'way/road-1--2');

  const canopyInst = recon.scene.foliageGroup.getObjectByName(
    'ProceduralForest_BroadleavedCanopy'
  ) as THREE.InstancedMesh;
  assert.ok(canopyInst);
  const hitTree0 = resolveInspectedFeature({ object: canopyInst, instanceId: 0 } as any);
  const hitTree1 = resolveInspectedFeature({ object: canopyInst, instanceId: 1 } as any);
  assert.equal(hitTree0?.id, 'way/forest-a-1--2');
  assert.equal(hitTree1?.id, 'way/forest-b-1--2');

  // Zero-copy matrix buffer adoption under optimizeMainThreadPrep: true
  if (isCompactDecodedTilePayload(prepared.decoded)) {
    assert.equal(
      canopyInst.instanceMatrix.array.buffer,
      prepared.decoded.instancedBatches[0].matrices.buffer,
      'InstancedMesh should adopt transferred Float32Array backing buffer directly without copying'
    );
  }

  const sleeperInst = recon.scene.railwaysGroup.getObjectByName(
    'Railway_Sleepers_Instanced'
  ) as THREE.InstancedMesh;
  assert.ok(sleeperInst);
  const hitSleeper = resolveInspectedFeature({ object: sleeperInst, instanceId: 5 } as any);
  assert.equal(hitSleeper?.id, 'way/rail-1--2');

  // Backward-compatible lazy getters materialize exact legacy shapes only when explicitly accessed
  const lazyFaceRanges = bldgMesh.userData.faceRanges;
  assert.equal(lazyFaceRanges.length, 2);
  assert.equal(lazyFaceRanges[0].info.id, 'way/bldg-a-1--2');
  assert.equal(lazyFaceRanges[1].info.id, 'way/bldg-b-1--2');

  const lazyInstanceInfos = canopyInst.userData.instanceInfos;
  assert.equal(lazyInstanceInfos.length, 64);
  assert.equal(lazyInstanceInfos[0].id, 'way/forest-a-1--2');

  const lazySleeperBoxes = sleeperInst.userData.instanceBoxes;
  assert.equal(lazySleeperBoxes.length, 24);
  assert.equal(lazySleeperBoxes[0].trackId, 'trk-1--2');

  recon.dispose();
  registry.dispose();
});

test('Work Package C: worker-built InstancedSpatialIndex achieves exact picking parity (LOD0-LOD2, transforms, near/far) and O(1) bounds/adoption', () => {
  const payload = createRichSyntheticTilePayload(2, -1, 1024, 120, 40);
  const raw = encodeDecodedTilePayloadToBinary(payload);
  const registry = new ThemeMaterialRegistry(MAP_THEMES.daylight);

  // Worker-built (combined) vs sync-built (baseline)
  const workerPrep = prepareTileInWorker(
    raw,
    '2:-1',
    TILE_PREPARATION_VARIANT_PRESETS.combined,
    true
  );
  const baselinePrep = prepareTileInWorker(
    raw,
    '2:-1',
    TILE_PREPARATION_VARIANT_PRESETS.baseline,
    true
  );

  const workerRecon = reconstructTileSceneFromDecoded(workerPrep.decoded, {
    materialRegistry: registry,
    optimizeMainThreadPrep: true,
    collectStageTimings: true,
  });
  const syncRecon = reconstructTileSceneFromDecoded(baselinePrep.decoded, {
    materialRegistry: registry,
    optimizeMainThreadPrep: false,
    collectStageTimings: true,
  });

  // Verify O(1) worker adoption & zero sync fallback
  assert.equal(workerRecon.stageTimings.workerBvhAdoptedCount, 3);
  assert.equal(workerRecon.stageTimings.syncBvhFallbackCount, 0);
  assert.equal(workerRecon.stageTimings.instancedBvhBuildMs, 0);

  assert.equal(syncRecon.stageTimings.workerBvhAdoptedCount, 0);
  assert.equal(syncRecon.stageTimings.syncBvhFallbackCount, 3);

  const workerCanopy = workerRecon.scene.foliageGroup.getObjectByName(
    'ProceduralForest_BroadleavedCanopy'
  ) as THREE.InstancedMesh;
  const syncCanopy = syncRecon.scene.foliageGroup.getObjectByName(
    'ProceduralForest_BroadleavedCanopy'
  ) as THREE.InstancedMesh;

  const workerIndex = getInstancedSpatialIndex(workerCanopy);
  const syncIndex = getInstancedSpatialIndex(syncCanopy);
  assert.ok(workerIndex && syncIndex);
  assert.equal(workerIndex.getStats().builtInWorker, true);
  assert.equal(syncIndex.getStats().builtInWorker, false);

  // Verify O(1) rootBoundsMin/Max + 0.25m margin matches computeConservativeInstancedBounds exactly
  const unionBounds = computeFoliagePrototypeUnionLocalBoundsArray('tree_broadleaved')!;
  const protoBox = new THREE.Box3(
    new THREE.Vector3(unionBounds[0], unionBounds[1], unionBounds[2]),
    new THREE.Vector3(unionBounds[3], unionBounds[4], unionBounds[5])
  );
  const refBounds = computeConservativeInstancedBounds(
    payload.instancedBatches[0].matrices,
    payload.instancedBatches[0].instanceCount,
    protoBox,
    0.25
  );
  assert.ok(workerCanopy.boundingBox);
  for (const axis of ['x', 'y', 'z'] as const) {
    assert.ok(
      Math.abs(workerCanopy.boundingBox!.min[axis] - refBounds.boundingBox.min[axis]) < 1e-3,
      `Bounding box min.${axis} mismatch`
    );
    assert.ok(
      Math.abs(workerCanopy.boundingBox!.max[axis] - refBounds.boundingBox.max[axis]) < 1e-3,
      `Bounding box max.${axis} mismatch`
    );
  }

  // Test across parent transform offset + LOD 0, LOD 1, and LOD 2 swaps + near/far clipping
  const workerRoot = new THREE.Group();
  workerRoot.position.set(workerRecon.tileCenterXZ[0], 0, workerRecon.tileCenterXZ[1]);
  workerRoot.add(workerRecon.scene.foliageGroup);
  workerRoot.updateMatrixWorld(true);

  const syncRoot = new THREE.Group();
  syncRoot.position.set(syncRecon.tileCenterXZ[0], 0, syncRecon.tileCenterXZ[1]);
  syncRoot.add(syncRecon.scene.foliageGroup);
  syncRoot.updateMatrixWorld(true);

  const prevMode = setInstancedPickingMode('accelerated');
  try {
    for (const lodMode of ['lod0', 'lod1', 'lod2'] as const) {
      const state = resolveFoliageRuntimeState(1.0, null, {
        enabled: true,
        lodMode,
        trunkSuppressionEnabled: false,
        frustumCullingEnabled: true,
      });
      workerRecon.applyFoliageRuntimeState(state);
      syncRecon.applyFoliageRuntimeState(state);

      const rc = new THREE.Raycaster();
      for (let i = 0; i < 40; i++) {
        const col = i % 10;
        const row = Math.floor(i / 10);
        const worldX = workerRoot.position.x - 180 + col * 32 + (i % 3) * 0.4;
        const worldZ = workerRoot.position.z - 140 + row * 34 + (i % 2) * 0.4;
        rc.set(new THREE.Vector3(worldX, 60, worldZ), new THREE.Vector3(0, -1, 0));
        rc.near = i % 7 === 0 ? 52 : 0;
        rc.far = i % 9 === 0 ? 56 : Infinity;

        setInstancedPickingMode('accelerated');
        const workerHits = rc.intersectObject(workerCanopy, false);
        const syncHits = rc.intersectObject(syncCanopy, false);

        setInstancedPickingMode('unaccelerated');
        const unaccelHits = rc.intersectObject(syncCanopy, false);

        assert.equal(
          workerHits.length > 0,
          unaccelHits.length > 0,
          `Hit presence mismatch at ${lodMode} ray ${i}`
        );
        assert.equal(
          workerHits.length > 0,
          syncHits.length > 0,
          `Worker vs sync hit presence mismatch at ${lodMode} ray ${i}`
        );

        if (workerHits.length > 0 && unaccelHits.length > 0) {
          assert.equal(workerHits[0].instanceId, unaccelHits[0].instanceId);
          assert.equal(workerHits[0].instanceId, syncHits[0].instanceId);
          assert.ok(Math.abs(workerHits[0].distance - unaccelHits[0].distance) < 1e-4);

          const wInfo = resolveInspectedFeature(workerHits[0]);
          const sInfo = resolveInspectedFeature(syncHits[0]);
          assert.equal(wInfo?.id, sInfo?.id);
        }
      }
    }
  } finally {
    setInstancedPickingMode(prevMode);
    workerRecon.dispose();
    syncRecon.dispose();
    registry.dispose();
  }
});

test('Work Package A: injected inter-frame worker.onmessage, reconstruct, and gl.render stalls align strictly to frame N without N+1 shift', () => {
  const profiler = new StreamingProfiler({
    installBrowserObservers: false,
    instrumentRaycaster: false,
  });
  profiler.setEnabled(true, 'injected_stall_alignment');

  // Frame 1: clean steady frame [100, 106.9]
  profiler.markBeforeGlRender(10);
  const f1 = profiler.finishRenderFrame({
    intervalStartMs: 100,
    frameTimestampMs: 106.9,
    frameIntervalMs: 6.9,
    glRenderCpuMs: 1.2,
    renderCalls: 30,
    renderTriangles: 10000,
    driverGeometries: 10,
    driverTextures: 2,
    driverPrograms: 3,
    gpuTimerQuerySupported: false,
    gpuTimerStatus: 'unsupported',
    gpuDisjointOccurred: false,
    gpuPassTimeMs: null,
  })!;
  assert.equal(f1.frameIndex, 1);

  // Frame 2: inter-frame worker.onmessage stall of 28ms + 1ms continuation occurs between 106.9 and 142.9
  profiler.recordWorkerOnMessage({
    durationMs: 28.0,
    deliveryLatencyMs: 31.5,
    workerBvhBuildMs: 0,
    transferableBytes: 420_000,
    usedCompactTransport: false,
  });
  profiler.recordWorkerContinuation(1.0);
  profiler.recordEvent({
    eventType: 'worker_message_received',
    timestampMs: 120,
    tileKey: '1:0',
    tileSizeMeters: 4096,
    lod: 0,
    durationMs: 28.0,
    queueDepths: { queued: 0, fetching: 0, decoding: 0, readyToCommit: 1, loaded: 4, visible: 4 },
    detail: {
      workerQueueWaitMs: 0.4,
      workerInflateAndDecodeMs: 8.2,
      workerBvhBuildMs: 0,
      workerPayloadPrepMs: 1.1,
      messageDeliveryLatencyMs: 31.5,
      mainOnMessageHandlerMs: 28.0,
      transferableBufferCount: 12,
      transferableBytes: 420_000,
      usedCompactTransport: false,
    },
  });
  profiler.markBeforeGlRender(10);
  const f2 = profiler.finishRenderFrame({
    intervalStartMs: 106.9,
    frameTimestampMs: 142.9,
    frameIntervalMs: 36.0,
    glRenderCpuMs: 1.4,
    renderCalls: 30,
    renderTriangles: 10000,
    driverGeometries: 10,
    driverTextures: 2,
    driverPrograms: 3,
    gpuTimerQuerySupported: false,
    gpuTimerStatus: 'unsupported',
    gpuDisjointOccurred: false,
    gpuPassTimeMs: null,
  })!;
  assert.equal(f2.frameIndex, 2);
  assert.equal(f2.workerOnMessageMs, 28.0);
  assert.equal(f2.workerContinuationMs, 1.0);
  assert.equal(verifyFrameStageNesting(f2).valid, true);

  // Frame 3: clean steady frame [142.9, 149.8] — must NOT inherit frame 2's stall!
  profiler.markBeforeGlRender(10);
  const f3 = profiler.finishRenderFrame({
    intervalStartMs: 142.9,
    frameTimestampMs: 149.8,
    frameIntervalMs: 6.9,
    glRenderCpuMs: 1.2,
    renderCalls: 30,
    renderTriangles: 10000,
    driverGeometries: 10,
    driverTextures: 2,
    driverPrograms: 3,
    gpuTimerQuerySupported: false,
    gpuTimerStatus: 'unsupported',
    gpuDisjointOccurred: false,
    gpuPassTimeMs: null,
  })!;
  assert.equal(f3.frameIndex, 3);
  assert.equal(f3.workerOnMessageMs, 0);

  // Frame 4: reconstruct + first_rendered_use stall [149.8, 174.8]
  profiler.recordStreamTick({
    totalMs: 14.2,
    readyScanAndSortMs: 0.1,
    reconstructMs: 12.5,
    instancedBvhBuildMs: 0,
    instancedBvhAdoptMs: 0.08,
    staticBvhDeserializeMs: 5.5,
    sceneAttachMs: 0.7,
    commitRebuildStatsMs: 0.4,
    commitEmitDiagnosticsMs: 0.2,
    tilesCommittedCount: 1,
    workerBvhAdoptedCount: 3,
    syncBvhFallbackCount: 0,
  });
  profiler.recordMapSceneUseFrame({
    totalMs: 15.0,
    shadowFollowMs: 0.2,
    zoomPropagationMs: 0.1,
    viewportFrameUpdateMs: 14.5,
    railwayIndexRebuildMs: 0,
    telemetryHudMs: 0.1,
  });
  profiler.recordEvent({
    eventType: 'reconstruct_complete',
    timestampMs: 164,
    tileKey: '1:0',
    tileSizeMeters: 4096,
    lod: 0,
    durationMs: 12.5,
    queueDepths: { queued: 0, fetching: 0, decoding: 0, readyToCommit: 0, loaded: 5, visible: 5 },
    detail: {
      instancedBvhBuildMs: 0,
      instancedBvhAdoptMs: 0.08,
      workerBvhAdoptedCount: 3,
      syncBvhFallbackCount: 0,
    },
  });
  profiler.markTilePendingFirstRender({
    tileKey: '1:0',
    tileSizeMeters: 4096,
    lod: 0,
    triangles: 25000,
    meshes: 8,
    compressedBytes: 120000,
    rawBytes: 420000,
    attachTimestampMs: 165,
  });
  profiler.markBeforeGlRender(10);
  const f4 = profiler.finishRenderFrame({
    intervalStartMs: 149.8,
    frameTimestampMs: 174.8,
    frameIntervalMs: 25.0,
    glRenderCpuMs: 6.0,
    renderCalls: 36,
    renderTriangles: 35000,
    driverGeometries: 18,
    driverTextures: 2,
    driverPrograms: 3,
    gpuTimerQuerySupported: false,
    gpuTimerStatus: 'unsupported',
    gpuDisjointOccurred: false,
    gpuPassTimeMs: null,
  })!;
  assert.equal(f4.frameIndex, 4);
  assert.equal(verifyFrameStageNesting(f4).valid, true);

  const snap = profiler.getSnapshot();
  // Verify exact event.frameIndex alignment (no off-by-one shift)
  const workerEvt = snap.events.find((e) => e.eventType === 'worker_message_received')!;
  const reconEvt = snap.events.find((e) => e.eventType === 'reconstruct_complete')!;
  const firstUseEvt = snap.events.find((e) => e.eventType === 'first_rendered_use')!;
  assert.equal(workerEvt.frameIndex, 2);
  assert.equal(reconEvt.frameIndex, 4);
  assert.equal(firstUseEvt.frameIndex, 4);

  const worst = attributeWorstFrames({
    frames: snap.frames,
    events: snap.events,
    longTasks: [],
    loafs: [],
    topN: 4,
  });
  assert.equal(worst[0].frameIndex, 2);
  assert.equal(worst[0].primarySuspect, 'worker_delivery_onmessage');
  assert.equal(worst[1].frameIndex, 4);
  assert.equal(worst[1].primarySuspect, 'sync_tile_commit_reconstruct');

  // Event-conditioned frame distribution + worker delivery summary
  const cond = summarizeEventConditionedFrames(snap.frames);
  assert.equal(cond.quietFrames.sampleCount, 2);
  assert.equal(cond.workerDeliveryFrames.sampleCount, 1);
  assert.equal(cond.tileCommitFrames.sampleCount, 1);
  assert.equal(cond.activeStreamingWorkFrames.sampleCount, 2);

  const wd = summarizeWorkerDeliveryMetrics(snap.events, snap.frames);
  assert.equal(wd.deliveryCount, 1);
  assert.equal(wd.workerBvhAdoptedTotal, 3);
  assert.equal(wd.syncBvhFallbackTotal, 0);
  assert.equal(wd.mainOnMessageHandlerMs.max, 28.0);

  profiler.dispose();
});

test('Resource lifecycle: TileStreamManager loads, cancels, evicts, and reloads tiles cleanly across all 5 tile preparation variants', async () => {
  const tile0 = createRichSyntheticTilePayload(0, 0, 1024, 32, 12);
  const tile1 = createRichSyntheticTilePayload(1, 0, 1024, 32, 12);
  const payloadsByCoord = new Map<string, Uint8Array>([
    ['0:0', deflateTilePayload(encodeDecodedTilePayloadToBinary(tile0))],
    ['1:0', deflateTilePayload(encodeDecodedTilePayloadToBinary(tile1))],
  ]);

  const originE = 350000;
  const originN = 5800000;
  const makeEntry = (p: DecodedTilePayload): TileManifestEntry => {
    const cx = originE + p.tileCenterX;
    const cz = originN - p.tileCenterZ;
    const compBytes = payloadsByCoord.get(`${p.tx}:${p.ty}`)!.byteLength;
    return {
      lod: 0,
      tx: p.tx,
      ty: p.ty,
      minEasting: cx - p.tileSizeMeters * 0.5,
      maxEasting: cx + p.tileSizeMeters * 0.5,
      minNorthing: cz - p.tileSizeMeters * 0.5,
      maxNorthing: cz + p.tileSizeMeters * 0.5,
      tileCenterX: p.tileCenterX,
      tileCenterZ: p.tileCenterZ,
      overhangMinX: p.overhangBoundsMin[0],
      overhangMaxX: p.overhangBoundsMax[0],
      overhangMinY: p.overhangBoundsMin[1],
      overhangMaxY: p.overhangBoundsMax[1],
      overhangMinZ: p.overhangBoundsMin[2],
      overhangMaxZ: p.overhangBoundsMax[2],
      triCount: p.totalTriangles,
      vertexCount: p.totalVertices,
      featureCount: p.featureInfos.length,
      isEmpty: false,
      hasBvh: true,
      rawBytes: compBytes * 2,
      compressedBytes: compBytes,
      contentHash: '0'.repeat(64),
    };
  };

  const manifest: TilePackManifestPayload = {
    available: true,
    packPath: 'synthetic/tkt040-lifecycle.json',
    metadata: {
      snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
      sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
      projectionId: DEFAULT_PROJECTION_ID,
      bakeSchemaVersion: BAKE_SCHEMA_VERSION,
      lodPolicyHash: computeLodPolicyHash({
        projectionId: DEFAULT_PROJECTION_ID,
        tileSizeMeters: 1024,
        collarMeters: 64,
        lod: 0,
        includeBvh: true,
      }),
      compression: 'deflate',
      tileSizeMeters: 1024,
      collarMeters: 64,
      studyOriginEasting: originE,
      studyOriginNorthing: originN,
      gridCols: 2,
      gridRows: 1,
      minTx: 0,
      maxTx: 1,
      minTy: 0,
      maxTy: 0,
      bakeStatus: 'complete',
      createdAtIso: new Date().toISOString(),
      completedAtIso: new Date().toISOString(),
    },
    tiles: [makeEntry(tile0), makeEntry(tile1)],
  };

  const variants: TilePreparationVariantId[] = [
    'baseline',
    'transfer_only',
    'compact_transport',
    'worker_bvh',
    'combined',
  ];

  for (const variant of variants) {
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      const match = url.match(/\/0\/(-?\d+)\/(-?\d+)/);
      const coord = match ? `${match[1]}:${match[2]}` : '';
      const compressed = payloadsByCoord.get(coord);
      if (!compressed) return new Response('Not found', { status: 404 });
      return new Response(compressed.slice().buffer, { status: 200 });
    };

    const manager = new TileStreamManager({
      apiBaseUrl: '/api/tiles-tkt040-test',
      preloadMarginTiles: 0,
      retainMarginTiles: 0.05,
      fetchFn,
      tilePreparationOptions: variant,
    });

    await manager.initialize(manifest);
    manager.updateViewport({
      minX: 200,
      maxX: 800,
      minZ: 200,
      maxZ: 800,
      focusX: 512,
      focusZ: 512,
    });
    await manager.waitForIdle();
    const d1 = manager.getDiagnostics();
    assert.equal(d1.loadedTiles, 1, `[${variant}] expected 1 loaded tile`);
    assert.equal(d1.tilePreparationVariant, variant);
    if (variant === 'worker_bvh' || variant === 'combined') {
      assert.equal(d1.workerBvhAdoptedTotal, 3, `[${variant}] expected 3 adopted BVHs`);
      assert.equal(d1.syncBvhFallbackTotal, 0, `[${variant}] expected 0 sync fallbacks`);
    } else {
      assert.equal(d1.workerBvhAdoptedTotal, 0, `[${variant}] expected 0 adopted BVHs`);
      assert.equal(d1.syncBvhFallbackTotal, 3, `[${variant}] expected 3 sync fallbacks`);
    }

    // Move to tile 1 -> evicts tile 0, loads tile 1
    manager.updateViewport({
      minX: 1200,
      maxX: 1800,
      minZ: 200,
      maxZ: 800,
      focusX: 1536,
      focusZ: 512,
    });
    await manager.waitForIdle();
    assert.equal(manager.getDiagnostics().loadedTiles, 1);
    assert.equal(manager.getDiagnostics().evictedTilesTotal, 1);

    // Move back to tile 0 -> reloads cleanly without detached buffer or leak issues
    manager.updateViewport({
      minX: 200,
      maxX: 800,
      minZ: 200,
      maxZ: 800,
      focusX: 512,
      focusZ: 512,
    });
    await manager.waitForIdle();
    assert.equal(manager.getDiagnostics().loadedTiles, 1);

    manager.dispose();
  }
});
