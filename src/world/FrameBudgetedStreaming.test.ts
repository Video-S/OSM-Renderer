import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import * as THREE from 'three';
import {
  resolveInspectedFeature,
  SceneResourceManager,
  type BuiltSceneGeometry,
} from './GeometryBuilder';
import {
  BAKE_SCHEMA_VERSION,
  CANONICAL_HENGELO_SNAPSHOT_ID,
  CANONICAL_HENGELO_SOURCE_SHA256,
  DEFAULT_PROJECTION_ID,
  OSMTILE1_FORMAT_VERSION,
  TILE_MESH_FLAG_CAST_SHADOW,
  TILE_MESH_FLAG_HAS_BVH,
  TILE_MESH_FLAG_RECEIVE_SHADOW,
  TILE_MESH_FLAG_VISIBLE,
  TILE_PAYLOAD_FLAG_HAS_BVH,
  computeLodPolicyHash,
  type DecodedTilePayload,
  type TileInstancedBatchRecord,
  type TileManifestEntry,
  type TileMeshRecord,
} from './tiling/TilePackContract';
import {
  createRegionalMosaicPlan,
  type RegionalMosaicConfig,
  type RegionalMosaicIndex,
} from './tiling/RegionalMosaicPlan';
import {
  buildTileLocalBvh,
  encodeDecodedTilePayloadToBinary,
} from './tiling/TileBinaryCodec';
import {
  HIERARCHICAL_MOSAIC_SCHEMA_TYPE,
  HIERARCHICAL_MOSAIC_SCHEMA_VERSION,
  type HierarchicalRegionalMosaicDescriptor,
} from './tiling/HierarchicalMosaicContract';
import {
  DEFAULT_HIERARCHICAL_RESOURCE_BUDGET,
  normalizeHierarchicalResourceBudget,
} from './tiling/HierarchicalResourceBudget';
import {
  DEFAULT_HIERARCHICAL_RESOLUTION_POLICY,
  resolveApproachingResolutionForPrewarm,
} from './tiling/HierarchicalResolutionPolicy';
import {
  DEFAULT_STREAMING_FRAME_BUDGET_CONFIG,
  identifyStreamingF1Variant,
  parseStreamingFrameBudgetFromSearch,
  resolveStreamingFrameBudgetConfig,
  STREAMING_F1_VARIANTS,
} from './tiling/StreamingSchedulerConfig';
import {
  StreamingWorkloadScheduler,
  type ScheduledWorkUnit,
} from './tiling/StreamingWorkloadScheduler';
import {
  IncrementalGpuPreparer,
  type GpuPrepUploadAdapter,
  type GpuUploadMeshUnit,
} from './tiling/IncrementalGpuPreparer';
import { DeferredDisposalQueue } from './tiling/DeferredDisposalQueue';
import type { ReconstructedTileSceneResult } from './tiling/TileSceneReconstructor';
import {
  TileStreamManager,
  type TileViewportGroundBounds,
} from './tiling/TileStreamManager';
import { StreamingProfiler } from './tiling/StreamingProfiler';
import { verifyFrameStageNesting } from './tiling/StreamingFluidityStats';
import { TilePackSqliteWriter } from '../server/tiles/TilePackSqliteStore';
import { deflateTilePayload, sha256Hex } from '../server/tiles/TileCompression';
import { consolidateRegionalMosaic } from '../server/tiles/OfflineTileConsolidator';
import { createRegionalMosaicHttpHandler } from '../server/tiles/RegionalMosaicHttpHandler';
import type { InspectableFeatureInfo } from '../types/MapFeature';

function makeBoxGeometryData(
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number
): {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
} {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(cx, cy, cz);
  const positions = new Float32Array(g.attributes.position.array as Float32Array);
  const normals = new Float32Array(g.attributes.normal.array as Float32Array);
  const uvs = new Float32Array(g.attributes.uv.array as Float32Array);
  const indices = new Uint16Array(g.index!.array as Uint16Array);
  g.dispose();
  return { positions, normals, uvs, indices };
}

function createSynthetic1024TilePayload(params: {
  tx: number;
  ty: number;
  tileCenterX: number;
  tileCenterZ: number;
  tileSizeMeters: number;
  empty?: boolean;
}): DecodedTilePayload {
  const { tx, ty, tileCenterX, tileCenterZ, tileSizeMeters, empty } = params;
  const half = tileSizeMeters * 0.5;
  if (empty) {
    return {
      formatVersion: OSMTILE1_FORMAT_VERSION,
      flags: TILE_PAYLOAD_FLAG_HAS_BVH,
      lod: 0,
      tx,
      ty,
      tileSizeMeters,
      tileCenterX,
      tileCenterZ,
      overhangBoundsMin: [-half, 0, -half],
      overhangBoundsMax: [half, 0, half],
      totalVertices: 0,
      totalTriangles: 0,
      totalDrawCalls: 0,
      renderedFeaturesCount: 0,
      forestTreesCount: 0,
      sleeper3DBoxCount: 0,
      railwayRenderSource: 'graph-R+',
      byteLength: 0,
      featureInfos: [],
      meshes: [],
      instancedBatches: [],
    };
  }

  const buildingFeature: InspectableFeatureInfo = {
    id: `way/bldg_${tx}_${ty}`,
    sourceFeatureId: `way/bldg_${tx}_${ty}`,
    category: 'Building',
    cartoLabel: 'Apartments',
    primaryTag: 'building=apartments',
    subtype: 'apartments',
    name: `Building ${tx},${ty}`,
    type: 'apartments',
    height: 16,
    levels: 5,
    osmTags: { building: 'apartments', name: `Building ${tx},${ty}` },
  };
  const treeFeature: InspectableFeatureInfo = {
    id: `node/tree_${tx}_${ty}`,
    sourceFeatureId: `node/tree_${tx}_${ty}`,
    category: 'Forest & Woodland',
    cartoLabel: 'Tree',
    primaryTag: 'natural=tree',
    subtype: 'tree',
    name: `Tree ${tx},${ty}`,
    type: 'tree',
    height: 9,
    osmTags: { natural: 'tree' },
  };

  const bBox = makeBoxGeometryData(0, 8, 0, 32, 16, 24);
  const bBvh = buildTileLocalBvh(bBox.positions, bBox.indices);
  const bTriCount = bBox.indices.length / 3;
  const bMesh: TileMeshRecord = {
    layer: 'buildings',
    name: `bldg_${tx}_${ty}`,
    materialSlotKeys: ['building:default:roof'],
    renderOrder: 10,
    flags:
      TILE_MESH_FLAG_VISIBLE |
      TILE_MESH_FLAG_CAST_SHADOW |
      TILE_MESH_FLAG_RECEIVE_SHADOW |
      TILE_MESH_FLAG_HAS_BVH,
    localPositionOffset: [0, 0, 0],
    bboxMin: [-16, 0, -12],
    bboxMax: [16, 16, 12],
    positions: bBox.positions,
    normals: bBox.normals,
    uvs: bBox.uvs,
    switchAttrs: null,
    colors: null,
    indices: bBox.indices,
    groups: [
      {
        start: 0,
        count: bBox.indices.length,
        materialIndex: 0,
      },
    ],
    faceRanges: [
      {
        startFace: 0,
        endFace: bTriCount,
        infoIdx: 0,
      },
    ],
    singleFeatureIdx: 0,
    bvh: bBvh,
  };

  const treeCount = 12;
  const matrices = new Float32Array(treeCount * 16);
  const featureIndices = new Int32Array(treeCount);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < treeCount; i++) {
    const col = i % 4;
    const row = Math.floor(i / 4);
    dummy.position.set(120 + col * 18, 0, 120 + row * 18);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    matrices.set(dummy.matrix.elements, i * 16);
    featureIndices[i] = 1;
  }

  const instancedBatches: TileInstancedBatchRecord[] = [
    {
      layer: 'foliage',
      name: 'ProceduralForest_BroadleavedCanopy',
      materialSlotKey: 'foliage:broadleaved',
      prototypeKind: 'tree_broadleaved',
      renderOrder: 0,
      flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_CAST_SHADOW,
      bboxMin: [110, 0, 110],
      bboxMax: [190, 12, 175],
      instanceCount: treeCount,
      matrices,
      instanceColors: null,
      instanceFeatureIdxs: featureIndices,
      sleeperBoxes: null,
    },
    {
      layer: 'foliage',
      name: 'ProceduralForest_Trunks',
      materialSlotKey: 'foliage:trunk',
      prototypeKind: 'tree_trunk',
      renderOrder: 0,
      flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_CAST_SHADOW,
      bboxMin: [110, 0, 110],
      bboxMax: [190, 6, 175],
      instanceCount: treeCount,
      matrices: new Float32Array(matrices),
      instanceColors: null,
      instanceFeatureIdxs: new Int32Array(featureIndices),
      sleeperBoxes: null,
    },
  ];

  return {
    formatVersion: OSMTILE1_FORMAT_VERSION,
    flags: TILE_PAYLOAD_FLAG_HAS_BVH,
    lod: 0,
    tx,
    ty,
    tileSizeMeters,
    tileCenterX,
    tileCenterZ,
    overhangBoundsMin: [-half, 0, -half],
    overhangBoundsMax: [half, 18, half],
    totalVertices: bBox.positions.length / 3,
    totalTriangles: bTriCount,
    totalDrawCalls: 3,
    renderedFeaturesCount: 2,
    forestTreesCount: treeCount,
    sleeper3DBoxCount: 0,
    railwayRenderSource: 'graph-R+',
    byteLength: 0,
    featureInfos: [buildingFeature, treeFeature],
    meshes: [bMesh],
    instancedBatches,
  };
}

function createMockReconstructedTile(
  meshCount: number,
  sharedMaterial?: THREE.Material
): {
  reconstructed: ReconstructedTileSceneResult;
  meshes: THREE.Mesh[];
  isDisposed: () => boolean;
  areAllGeometriesDisposed: () => boolean;
} {
  const resources = new SceneResourceManager();
  const buildingsGroup = new THREE.Group();
  const roadsGroup = new THREE.Group();
  const railwaysGroup = new THREE.Group();
  const waterGroup = new THREE.Group();
  const parksGroup = new THREE.Group();
  const landuseGroup = new THREE.Group();
  const barriersGroup = new THREE.Group();
  const foliageGroup = new THREE.Group();

  const meshes: THREE.Mesh[] = [];
  const geoDisposedFlags: boolean[] = [];

  for (let i = 0; i < meshCount; i++) {
    const geo = resources.registerGeometry(new THREE.BoxGeometry(4, 4, 4));
    const idx = i;
    geoDisposedFlags.push(false);
    geo.addEventListener('dispose', () => {
      geoDisposedFlags[idx] = true;
    });
    const mat =
      sharedMaterial ??
      resources.registerMaterial(new THREE.MeshStandardMaterial());
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `mock_mesh_${i}`;
    buildingsGroup.add(mesh);
    meshes.push(mesh);
  }

  let disposed = false;
  const dummyGround = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    sharedMaterial ?? new THREE.MeshBasicMaterial()
  );

  const scene: BuiltSceneGeometry = {
    buildingsGroup,
    roadsGroup,
    railwaysGroup,
    waterGroup,
    parksGroup,
    landuseGroup,
    barriersGroup,
    foliageGroup,
    groundMesh: dummyGround,
    interactiveMeshes: { buildings: meshes },
    stats: {
      totalVertices: meshCount * 24,
      totalTriangles: meshCount * 12,
      totalDrawCalls: meshCount,
      renderedFeaturesCount: meshCount,
      forestTreesCount: 0,
    },
    resources,
    infrastructureRenderOptions: { roads: 'e2_plus', railways: 'r_plus' } as any,
    infrastructureRenderPreview: null,
    dispose: () => {
      disposed = true;
      resources.dispose();
    },
    updateTheme: () => {},
  };

  const reconstructed: ReconstructedTileSceneResult = {
    scene,
    tileCenterXZ: [0, 0],
    overhangBounds: {
      min: [-512, 0, -512],
      max: [512, 16, 512],
    },
    applyFoliageRuntimeState: () => {},
    foliageBatchCount: 0,
    instancedPickingStats: {
      indexedBatchCount: 0,
      totalIndexedInstances: 0,
      totalIndexNodes: 0,
      totalIndexMemoryBytes: 0,
      totalBuildTimeMs: 0,
    },
    stageTimings: {
      staticBvhDeserializeMs: 0,
      instancedBvhBuildMs: 0,
      instancedBvhAdoptMs: 0,
      workerBvhAdoptedCount: 0,
      syncBvhFallbackCount: 0,
    },
    dispose: () => {
      disposed = true;
      resources.dispose();
    },
  };

  return {
    reconstructed,
    meshes,
    isDisposed: () => disposed,
    areAllGeometriesDisposed: () => geoDisposedFlags.every(Boolean),
  };
}

interface SyntheticHierarchyFixture {
  rootDir: string;
  index1024Path: string;
  index2048Path: string;
  index4096Path: string;
  descriptorPath: string;
}

async function buildSynthetic3ResolutionFixture(): Promise<SyntheticHierarchyFixture> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkt041-f1-test-'));
  try {
    const dir1024 = path.join(rootDir, 'mosaic-1024m');
    const dir2048 = path.join(rootDir, 'mosaic-2048m');
    const dir4096 = path.join(rootDir, 'mosaic-4096m');
    fs.mkdirSync(path.join(dir1024, 'shards'), { recursive: true });

    const config1024: RegionalMosaicConfig = {
      name: 'synth-twente-1024m',
      centerLonLat: [6.793, 52.265],
      cols: 4,
      rows: 4,
      tileSizeMeters: 1024,
      shardDimension: 4,
      shardCols: 4,
      shardRows: 4,
      collarMeters: 24,
      contextMarginMeters: 48,
    };
    const plan1024 = createRegionalMosaicPlan(config1024);
    const lodPolicyHash = computeLodPolicyHash({
      projectionId: DEFAULT_PROJECTION_ID,
      tileSizeMeters: 1024,
      collarMeters: 24,
      lod: 0,
      includeBvh: true,
    });

    const shardRefs: Array<{ id: string; file: string }> = [];
    for (const shard of plan1024.shards) {
      const relFile = `shards/${shard.id}.sqlite`;
      const absFile = path.join(dir1024, relFile);
      const writer = new TilePackSqliteWriter(absFile, {
        snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
        sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
        projectionId: DEFAULT_PROJECTION_ID,
        bakeSchemaVersion: BAKE_SCHEMA_VERSION,
        lodPolicyHash,
        compression: 'deflate',
        tileSizeMeters: 1024,
        collarMeters: 24,
        studyOriginEasting: shard.grid.projection.originEasting,
        studyOriginNorthing: shard.grid.projection.originNorthing,
        gridCols: shard.grid.cols,
        gridRows: shard.grid.rows,
        minTx: shard.grid.minTx,
        maxTx: shard.grid.maxTx,
        minTy: shard.grid.minTy,
        maxTy: shard.grid.maxTy,
        createdAtIso: '2026-11-26T00:00:00.000Z',
      });

      const batchItems = [];
      for (const tile of shard.grid.tiles) {
        const tileCenterX = (tile.localBounds.minX + tile.localBounds.maxX) * 0.5;
        const tileCenterZ = (tile.localBounds.minZ + tile.localBounds.maxZ) * 0.5;
        const payload = createSynthetic1024TilePayload({
          tx: tile.tx,
          ty: tile.ty,
          tileCenterX,
          tileCenterZ,
          tileSizeMeters: 1024,
          empty: false,
        });
        const rawBytes = encodeDecodedTilePayloadToBinary(payload);
        const compressedPayload = deflateTilePayload(rawBytes);
        const manifest: TileManifestEntry = {
          lod: 0,
          tx: tile.tx,
          ty: tile.ty,
          minEasting: tile.utmBounds.minEasting,
          maxEasting: tile.utmBounds.maxEasting,
          minNorthing: tile.utmBounds.minNorthing,
          maxNorthing: tile.utmBounds.maxNorthing,
          tileCenterX,
          tileCenterZ,
          overhangMinX: payload.overhangBoundsMin[0],
          overhangMaxX: payload.overhangBoundsMax[0],
          overhangMinY: payload.overhangBoundsMin[1],
          overhangMaxY: payload.overhangBoundsMax[1],
          overhangMinZ: payload.overhangBoundsMin[2],
          overhangMaxZ: payload.overhangBoundsMax[2],
          triCount: payload.totalTriangles,
          vertexCount: payload.totalVertices,
          featureCount: payload.renderedFeaturesCount,
          isEmpty: false,
          hasBvh: true,
          rawBytes: rawBytes.byteLength,
          compressedBytes: compressedPayload.byteLength,
          contentHash: sha256Hex(compressedPayload),
        };
        batchItems.push({ manifest, compressedPayload });
      }
      writer.writeTileBatch(batchItems);
      writer.finalize('2026-11-26T00:00:01.000Z');
      shardRefs.push({ id: shard.id, file: relFile });
    }

    const index1024Path = path.join(dir1024, 'mosaic.json');
    const index1024: RegionalMosaicIndex = {
      schemaVersion: 1,
      config: config1024,
      snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
      sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
      shards: shardRefs,
    };
    fs.writeFileSync(index1024Path, JSON.stringify(index1024, null, 2), 'utf8');

    await consolidateRegionalMosaic({
      sourceIndexPath: index1024Path,
      outputDir: dir2048,
      targetTileSizeMeters: 2048,
      mosaicName: 'synth-twente-2048m',
    });
    await consolidateRegionalMosaic({
      sourceIndexPath: index1024Path,
      outputDir: dir4096,
      targetTileSizeMeters: 4096,
      mosaicName: 'synth-twente-4096m',
    });

    const descriptor: HierarchicalRegionalMosaicDescriptor = {
      schemaType: HIERARCHICAL_MOSAIC_SCHEMA_TYPE,
      schemaVersion: HIERARCHICAL_MOSAIC_SCHEMA_VERSION,
      name: 'synth-twente-hierarchical',
      snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
      sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
      projectionId: DEFAULT_PROJECTION_ID,
      levels: [
        { tileSizeMeters: 1024, indexPath: 'mosaic-1024m/mosaic.json' },
        { tileSizeMeters: 2048, indexPath: 'mosaic-2048m/mosaic.json' },
        { tileSizeMeters: 4096, indexPath: 'mosaic-4096m/mosaic.json' },
      ],
    };
    const descriptorPath = path.join(rootDir, 'hierarchical-mosaic.json');
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2), 'utf8');

    return {
      rootDir,
      index1024Path,
      index2048Path: path.join(dir2048, 'mosaic.json'),
      index4096Path: path.join(dir4096, 'mosaic.json'),
      descriptorPath,
    };
  } catch (err) {
    fs.rmSync(rootDir, { recursive: true, force: true });
    throw err;
  }
}

async function startFixtureHttpServer(descriptorPath: string): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = express();
  const handler = createRegionalMosaicHttpHandler({ indexPath: descriptorPath });
  app.get('/api/tiles-region/manifest', (req, res) => {
    void handler.manifestHandler(req, res);
  });
  app.get(
    '/api/tiles-region/r/:tileSizeMeters/:snapshotId/:schemaVersion/:lod/:tx/:ty',
    (req, res) => {
      void handler.tilePayloadHandler(req, res);
    }
  );
  app.get('/api/tiles-region/r/:tileSizeMeters/:lod/:tx/:ty', (req, res) => {
    void handler.tilePayloadHandler(req, res);
  });
  app.get(
    '/api/tiles-region/:snapshotId/:schemaVersion/:lod/:tx/:ty',
    (req, res) => {
      void handler.tilePayloadHandler(req, res);
    }
  );
  app.get('/api/tiles-region/:lod/:tx/:ty', (req, res) => {
    void handler.tilePayloadHandler(req, res);
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/tiles-region`,
    close: async () => {
      handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function getAttachedResolutions(manager: TileStreamManager): Set<number> {
  const attached = new Set<number>();
  const scene = manager.scene;
  const groups = [
    scene.buildingsGroup,
    scene.roadsGroup,
    scene.railwaysGroup,
    scene.waterGroup,
    scene.parksGroup,
    scene.landuseGroup,
    scene.barriersGroup,
    scene.foliageGroup,
  ];
  for (const g of groups) {
    for (const child of g.children) {
      const res = child.userData?.resolutionMeters;
      if (typeof res === 'number') {
        attached.add(res);
      }
    }
  }
  return attached;
}

test('TKT-041-F1: StreamingSchedulerConfig presets, URL parsing, and 1,536 MiB provisional CPU budget', () => {
  assert.equal(
    DEFAULT_HIERARCHICAL_RESOURCE_BUDGET.totalMemoryBudgetBytes,
    1536 * 1024 * 1024
  );
  assert.equal(
    DEFAULT_HIERARCHICAL_RESOURCE_BUDGET.inactiveCacheBudgetBytes,
    384 * 1024 * 1024
  );
  assert.equal(
    DEFAULT_HIERARCHICAL_RESOURCE_BUDGET.maxPendingDecodedBytes,
    256 * 1024 * 1024
  );

  const tight = normalizeHierarchicalResourceBudget({
    totalMemoryBudgetBytes: 64 * 1024 * 1024,
  });
  assert.equal(tight.totalMemoryBudgetBytes, 64 * 1024 * 1024);
  assert.ok(tight.inactiveCacheBudgetBytes <= tight.totalMemoryBudgetBytes);

  for (const id of [
    'tkt041_baseline',
    'scheduler_only',
    'incremental_gpu_only',
    'deferred_disposal_only',
    'debounce_reuse_only',
    'combined',
    'combined_prewarm',
  ] as const) {
    const resolved = resolveStreamingFrameBudgetConfig(id);
    assert.equal(identifyStreamingF1Variant(resolved), id);
  }

  const fromSearch = parseStreamingFrameBudgetFromSearch(
    '?streamingF1Variant=scheduler_only&frameStreamingBudgetMs=1&transitionDebounceMs=250&predictivePrewarm=1&prioritizeDestination=1'
  );
  assert.ok(fromSearch);
  const merged = resolveStreamingFrameBudgetConfig(
    fromSearch,
    DEFAULT_STREAMING_FRAME_BUDGET_CONFIG
  );
  assert.equal(merged.sharedSchedulerEnabled, true);
  assert.equal(merged.frameStreamingBudgetMs, 1);
  assert.equal(merged.transitionDebounceMs, 250);
  assert.equal(merged.predictivePrewarmEnabled, true);
  assert.equal(merged.prioritizeDestinationOverActivePreload, true);
});

test('TKT-041-F1: StreamingWorkloadScheduler priority ordering, time budget, cancellation, and starvation escape', () => {
  let fakeNow = 1000;
  const scheduler = new StreamingWorkloadScheduler(() => fakeNow);
  const executedOrder: string[] = [];

  const units: ScheduledWorkUnit[] = [
    {
      id: 'preload_1',
      priority: 'active_preload',
      tieBreaker: 1,
      isObsolete: () => true, // obsolete unit should be cancelled immediately
      execute: () => {
        executedOrder.push('preload_1');
        fakeNow += 0.8;
        return true;
      },
    },
    {
      id: 'dispose_1',
      priority: 'deferred_disposal',
      tieBreaker: 1,
      execute: () => {
        executedOrder.push('dispose_1');
        fakeNow += 0.7;
        return true;
      },
    },
    {
      id: 'dest_gpu_1',
      priority: 'gpu_prep_destination',
      tieBreaker: 1,
      execute: () => {
        executedOrder.push('dest_gpu_1');
        fakeNow += 1.0;
        return true;
      },
    },
    {
      id: 'active_vis_1',
      priority: 'missing_active_visible',
      tieBreaker: 1,
      execute: () => {
        executedOrder.push('active_vis_1');
        fakeNow += 1.1;
        return true;
      },
    },
  ];

  // With a 2.0 ms frame budget:
  // 1) active_vis_1 executes first (1.1 ms)
  // 2) dest_gpu_1 executes second (1.0 ms -> total 2.1 ms >= 2.0 ms budget)
  // 3) dispose_1 is deferred because remainingMs <= 0
  // 4) preload_1 is cancelled because isObsolete() === true
  const frame1 = scheduler.runFrame(units, 2.0);
  assert.deepEqual(executedOrder, ['active_vis_1', 'dest_gpu_1']);
  assert.equal(frame1.unitsExecuted, 2);
  assert.equal(frame1.unitsDeferred, 1);
  assert.equal(frame1.unitsCancelled, 1);

  // Starvation escape + indivisible overrun accounting:
  // Even if remaining budget is already exhausted or a single unit exceeds budgetMs (3.5 ms > 2.0 ms),
  // at least 1 unit executes and records indivisibleOverrunCount === 1.
  const heavyUnit: ScheduledWorkUnit = {
    id: 'heavy_indivisible',
    priority: 'pending_destination_visible',
    tieBreaker: 0,
    execute: () => {
      executedOrder.push('heavy_indivisible');
      fakeNow += 3.5;
      return true;
    },
  };
  const frame2 = scheduler.runFrame([heavyUnit], 2.0, { alreadyUsedMs: 2.5 });
  assert.equal(frame2.unitsExecuted, 1);
  assert.equal(frame2.indivisibleOverrunCount, 1);
  assert.ok(frame2.maxIndivisibleUnitMs >= 3.5);
  assert.equal(scheduler.getStats().totalIndivisibleOverruns, 1);
});

test('TKT-041-F1: IncrementalGpuPreparer multi-frame slicing, reuse, context loss invalidation, and clean disposal', () => {
  const uploadedMeshNames: string[] = [];
  let contextEpoch = 1;
  let adapterDisposed = false;

  const mockAdapter: GpuPrepUploadAdapter = {
    uploadMeshUnit: (unit: GpuUploadMeshUnit) => {
      uploadedMeshNames.push(unit.mesh.name);
    },
    getContextEpoch: () => contextEpoch,
    dispose: () => {
      adapterDisposed = true;
    },
  };

  const preparer = new IncrementalGpuPreparer({ adapter: mockAdapter });
  const mockTile = createMockReconstructedTile(5);

  assert.equal(preparer.isTilePrepared(mockTile.reconstructed), false);
  assert.equal(preparer.getRemainingUnits(mockTile.reconstructed), 5);

  // Frame 1: upload at most 2 units
  const slice1 = preparer.prepareTileSlice('4096:0:0:0', mockTile.reconstructed, {
    maxUnits: 2,
    maxBytes: 10 * 1024 * 1024,
    maxTimeMs: 10,
  });
  assert.equal(slice1.uploadedUnits, 2);
  assert.equal(slice1.tileCompleted, false);
  assert.equal(preparer.isTilePrepared(mockTile.reconstructed), false);
  assert.equal(preparer.getRemainingUnits(mockTile.reconstructed), 3);

  // Frame 2: upload at most 2 units
  const slice2 = preparer.prepareTileSlice('4096:0:0:0', mockTile.reconstructed, {
    maxUnits: 2,
    maxBytes: 10 * 1024 * 1024,
    maxTimeMs: 10,
  });
  assert.equal(slice2.uploadedUnits, 2);
  assert.equal(slice2.tileCompleted, false);
  assert.equal(preparer.getRemainingUnits(mockTile.reconstructed), 1);

  // Frame 3: finishes remaining 1 unit
  const slice3 = preparer.prepareTileSlice('4096:0:0:0', mockTile.reconstructed, {
    maxUnits: 2,
    maxBytes: 10 * 1024 * 1024,
    maxTimeMs: 10,
  });
  assert.equal(slice3.uploadedUnits, 1);
  assert.equal(slice3.tileCompleted, true);
  assert.equal(preparer.isTilePrepared(mockTile.reconstructed), true);
  assert.equal(preparer.getRemainingUnits(mockTile.reconstructed), 0);
  assert.equal(uploadedMeshNames.length, 5);

  // Verify original parent links on all meshes were preserved
  for (const mesh of mockTile.meshes) {
    assert.equal(mesh.parent, mockTile.reconstructed.scene.buildingsGroup);
  }

  // Calling prepareTileSlice again on an already-prepared tile reuses the existing upload
  const reuseSlice = preparer.prepareTileSlice(
    '4096:0:0:0',
    mockTile.reconstructed,
    {
      maxUnits: 2,
      maxBytes: 10 * 1024 * 1024,
      maxTimeMs: 10,
    }
  );
  assert.equal(reuseSlice.reusedAlreadyPrepared, true);
  assert.equal(reuseSlice.uploadedUnits, 0);
  assert.equal(preparer.getStats().totalTilesReused, 1);

  // Simulate WebGL context restoration (incremented contextEpoch): invalidates prepared status
  contextEpoch += 1;
  preparer.invalidateAllForContextLoss(false);
  assert.equal(preparer.isTilePrepared(mockTile.reconstructed), false);
  assert.equal(preparer.getRemainingUnits(mockTile.reconstructed), 5);

  const sliceAfterRestore = preparer.prepareTileSlice(
    '4096:0:0:0',
    mockTile.reconstructed,
    {
      maxUnits: 10,
      maxBytes: 10 * 1024 * 1024,
      maxTimeMs: 10,
    }
  );
  assert.equal(sliceAfterRestore.uploadedUnits, 5);
  assert.equal(preparer.isTilePrepared(mockTile.reconstructed), true);

  preparer.dispose();
  // Because adapter was passed in (ownsAdapter = false), mockAdapter.dispose is not called unless owned; clean up mockTile
  assert.equal(adapterDisposed, false);
  mockTile.reconstructed.dispose();
});

test('TKT-041-F1: DeferredDisposalQueue immediate detach, paced disposal, duplicate guard, and shared material preservation', () => {
  const queue = new DeferredDisposalQueue();
  const sharedMaterial = new THREE.MeshStandardMaterial();
  let sharedMaterialDisposed = false;
  sharedMaterial.addEventListener('dispose', () => {
    sharedMaterialDisposed = true;
  });

  const t1 = createMockReconstructedTile(2, sharedMaterial);
  const t2 = createMockReconstructedTile(2, sharedMaterial);
  const t3 = createMockReconstructedTile(3, sharedMaterial);

  const added1 = queue.enqueue({
    tileKey: '1024:0:0:0',
    resolutionMeters: 1024,
    lod: 0,
    reconstructed: t1.reconstructed,
    measuredBytes: 2 * 1024 * 1024,
    estimatedGpuBytes: 1 * 1024 * 1024,
    isCacheEviction: true,
  });
  assert.equal(added1, true);

  // Duplicate enqueue for the same reconstructed instance must be rejected
  const dup1 = queue.enqueue({
    tileKey: '1024:0:0:0',
    resolutionMeters: 1024,
    lod: 0,
    reconstructed: t1.reconstructed,
    measuredBytes: 2 * 1024 * 1024,
    estimatedGpuBytes: 1 * 1024 * 1024,
    isCacheEviction: true,
  });
  assert.equal(dup1, false);

  queue.enqueue({
    tileKey: '1024:0:1:0',
    resolutionMeters: 1024,
    lod: 0,
    reconstructed: t2.reconstructed,
    measuredBytes: 3 * 1024 * 1024,
    estimatedGpuBytes: 1 * 1024 * 1024,
    isCacheEviction: true,
  });
  queue.enqueue({
    tileKey: '2048:0:0:0',
    resolutionMeters: 2048,
    lod: 0,
    reconstructed: t3.reconstructed,
    measuredBytes: 5 * 1024 * 1024,
    estimatedGpuBytes: 2 * 1024 * 1024,
    isCacheEviction: true,
  });

  const snap0 = queue.getAccountingSnapshot();
  assert.equal(snap0.pendingTiles, 3);
  assert.equal(snap0.pendingBytes, 10 * 1024 * 1024);
  assert.equal(snap0.byResolution[1024]?.tiles, 2);
  assert.equal(snap0.byResolution[2048]?.tiles, 1);
  assert.equal(t1.isDisposed(), false);

  // Drain 1 tile in frame 1
  const d1 = queue.drainSlice({
    maxTiles: 1,
    maxTimeMs: 10,
  });
  assert.equal(d1.disposedTiles, 1);
  assert.equal(t1.isDisposed(), true);
  assert.equal(t1.areAllGeometriesDisposed(), true);
  assert.equal(t2.isDisposed(), false);
  assert.equal(sharedMaterialDisposed, false);

  // Under high pending-byte pressure, drainToTargetBytes reclaims memory immediately
  const d2 = queue.drainToTargetBytes(0);
  assert.equal(d2.disposedTiles, 2);
  assert.equal(t2.isDisposed(), true);
  assert.equal(t3.isDisposed(), true);
  assert.equal(queue.getAccountingSnapshot().pendingTiles, 0);
  assert.equal(sharedMaterialDisposed, false);
  sharedMaterial.dispose();
});

test('TKT-041-F1: End-to-end TileStreamManager incremental GPU prep, deferred disposal, debounce, and Section 12 transition diagnostics', async () => {
  const fixture = await buildSynthetic3ResolutionFixture();
  const server = await startFixtureHttpServer(fixture.descriptorPath);

  try {
    let fakeClockMs = 10_000;
    const uploadedMeshNames: string[] = [];
    const customGpuAdapter: GpuPrepUploadAdapter = {
      uploadMeshUnit: (u) => {
        uploadedMeshNames.push(u.mesh.name);
      },
      getContextEpoch: () => 1,
      dispose: () => {},
    };

    const profiler = new StreamingProfiler();
    profiler.setEnabled(true, 'f1_integration_test');

    const manager = new TileStreamManager({
      apiBaseUrl: server.baseUrl,
      initialCameraZoom: 1.5, // starts at 1,024 m
      maxCommitsPerFrame: 2,
      nowFn: () => fakeClockMs,
      gpuUploadAdapter: customGpuAdapter,
      profiler,
      streamingFrameBudget: {
        ...STREAMING_F1_VARIANTS.combined,
        transitionDebounceMs: 150,
        maxGpuUploadUnitsPerFrame: 1, // force multi-frame incremental GPU prep
        maxDeferredDisposeTilesPerFrame: 1, // force multi-frame deferred disposal
      },
    });

    try {
      await manager.initialize();

      const centerViewport = (zoom: number): TileViewportGroundBounds => ({
        minX: -600,
        maxX: 600,
        minZ: -600,
        maxZ: 600,
        focusX: 0,
        focusZ: 0,
        cameraZoom: zoom,
        viewportWidthPx: 1280,
        viewportHeightPx: 720,
      });

      manager.updateViewport(centerViewport(1.5));
      await manager.waitForIdle();

      let diag = manager.getDiagnostics();
      assert.ok(diag.hierarchical);
      assert.equal(diag.hierarchical.activeResolutionMeters, 1024);
      assert.deepEqual([...getAttachedResolutions(manager)], [1024]);
      assert.equal(diag.frameBudget.hasValidViewportCoverage, true);

      // 1. Test transition debounce: briefly dip zoom to 0.50 (2,048 m band) for 60 ms (< 150 ms), then return to 1.5
      manager.updateViewport(centerViewport(0.5));
      diag = manager.getDiagnostics();
      assert.equal(diag.hierarchical?.transitionState, 'debouncing');
      assert.equal(
        diag.hierarchical?.currentTransitionBlocker.blockerCategory,
        'debounce_waiting'
      );

      fakeClockMs += 60;
      manager.updateViewport(centerViewport(1.5));
      diag = manager.getDiagnostics();
      assert.equal(diag.hierarchical?.transitionState, 'idle');
      assert.equal(diag.hierarchical?.activeResolutionMeters, 1024);
      assert.equal(diag.frameBudget.transitionsDebouncedAvoided, 1);

      // 2. Sustained zoom-out to 4,096 m (zoom = 0.18) while continuously panning
      manager.updateViewport({
        ...centerViewport(0.18),
        focusX: 50,
      });
      assert.equal(manager.getDiagnostics().hierarchical?.transitionState, 'debouncing');

      // Advance clock past 150 ms debounce while camera is STILL moving (focusX = 120)
      fakeClockMs += 160;
      manager.updateViewport({
        ...centerViewport(0.18),
        focusX: 120,
      });
      diag = manager.getDiagnostics();
      assert.ok(
        diag.hierarchical?.transitionState === 'preparing' ||
          diag.hierarchical?.transitionState === 'ready_to_activate'
      );
      assert.equal(diag.hierarchical?.pendingResolutionMeters, 4096);

      // Pump until 4,096 m tile activates and verify zero duplicate visible resolutions at every frame
      for (let step = 0; step < 60; step++) {
        fakeClockMs += 7;
        const h = manager.getHierarchicalDiagnostics()!;
        if (h.activeResolutionMeters === 4096 && h.transitionState === 'idle') {
          break;
        }
        const attached = getAttachedResolutions(manager);
        assert.ok(
          attached.size <= 1,
          `Expected at most 1 attached resolution during incremental GPU prep, got ${[...attached].join(',')}`
        );
        manager.tick();
        await new Promise((r) => setTimeout(r, 10));
      }

      await manager.waitForIdle();
      diag = manager.getDiagnostics();
      assert.equal(diag.hierarchical?.activeResolutionMeters, 4096);
      assert.equal(diag.hierarchical?.transitionState, 'idle');
      assert.deepEqual([...getAttachedResolutions(manager)], [4096]);
      assert.ok(uploadedMeshNames.length >= 2);
      assert.ok(
        diag.frameBudget.gpuPreparer.totalUnitsUploaded >= 2,
        'Expected incremental GPU preparer to upload destination units before activation'
      );

      // 3. Verify Section 12 TransitionCriticalPathRecord was recorded with all 7 stage timings
      const lastTrans = diag.hierarchical?.lastCompletedTransition;
      assert.ok(lastTrans, 'Expected lastCompletedTransition to be recorded');
      assert.equal(lastTrans.outcome, 'completed');
      assert.equal(lastTrans.fromResolutionMeters, 1024);
      assert.equal(lastTrans.toResolutionMeters, 4096);
      assert.ok(lastTrans.totalDurationMs > 0);
      assert.ok(lastTrans.debounceWaitMs >= 150);
      assert.ok(lastTrans.stagesMs.payloadRetrievalMs >= 0);
      assert.ok(lastTrans.stagesMs.workerDecodeAndBvhMs >= 0);
      assert.ok(lastTrans.stagesMs.reconstructMs >= 0);
      assert.ok(lastTrans.stagesMs.gpuPrepSubmitMs >= 0);
      assert.ok(lastTrans.criticalPathTileKey?.startsWith('r4096:'));

      // 4. Verify feature picking works cleanly on activated 4,096 m scene and never hits detached 1,024 m tiles
      const buildingMeshes = manager.scene.interactiveMeshes.buildings;
      assert.ok(buildingMeshes.length > 0);
      for (const m of buildingMeshes) {
        let cur: THREE.Object3D | null = m;
        let res: number | undefined;
        while (cur) {
          if (typeof cur.userData?.resolutionMeters === 'number') {
            res = cur.userData.resolutionMeters;
            break;
          }
          cur = cur.parent;
        }
        assert.equal(res, 4096);
      }
      const picked = resolveInspectedFeature({
        object: buildingMeshes[0],
        faceIndex: 0,
        distance: 100,
        point: new THREE.Vector3(),
      } as THREE.Intersection);
      assert.ok(picked?.id.startsWith('way/bldg_'));

      // 5. Verify Deferred Disposal Queue when inactive cache is evicted
      manager.setHierarchicalBudgetConfig({
        inactiveCacheBudgetBytes: 0,
      });
      const afterEvictAccounting = manager.getDeferredDisposalAccounting();
      assert.ok(
        afterEvictAccounting.totalEnqueuedTiles > 0,
        'Evicted inactive tiles should enter DeferredDisposalQueue instead of synchronous disposal spike'
      );

      // Drain deferred disposal across subsequent ticks
      for (let i = 0; i < 16; i++) {
        fakeClockMs += 7;
        manager.tick();
      }
      assert.equal(manager.getDeferredDisposalAccounting().pendingTiles, 0);
      assert.ok(manager.getDeferredDisposalAccounting().totalDisposedTiles > 0);

      // 6. Verify profiler stage nesting invariants across recorded frames
      const profSnap = profiler.getSnapshot();
      for (const f of profSnap.frames) {
        const check = verifyFrameStageNesting(f);
        assert.equal(
          check.valid,
          true,
          `Stage nesting violation: ${check.violations.join('; ')}`
        );
      }
    } finally {
      manager.dispose();
      assert.equal(manager.getDeferredDisposalAccounting().pendingTiles, 0);
    }
  } finally {
    await server.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test('TKT-041-F1 Section 12: Predictive pre-warming prepares approaching resolution under healthy headroom and reuses on transition', async () => {
  const policy = DEFAULT_HIERARCHICAL_RESOLUTION_POLICY;
  // Current active = 1024m; zoom-out threshold to 2048m is 0.80. At cameraZoom 0.85 while zooming out, should prewarm 2048m
  const approaching2048 = resolveApproachingResolutionForPrewarm({
    availableResolutionsMeters: [1024, 2048, 4096],
    activeResolutionMeters: 1024,
    cameraZoom: 0.85,
    viewportWidthPx: 1280,
    policy,
    bandFraction: 0.25,
    zoomTrend: 'zooming_out',
  });
  assert.equal(approaching2048.targetResolutionMeters, 2048);

  // If zooming IN away from threshold, do not prewarm 2048m
  const movingAway = resolveApproachingResolutionForPrewarm({
    availableResolutionsMeters: [1024, 2048, 4096],
    activeResolutionMeters: 1024,
    cameraZoom: 0.85,
    viewportWidthPx: 1280,
    policy,
    bandFraction: 0.25,
    zoomTrend: 'zooming_in',
  });
  assert.equal(movingAway.targetResolutionMeters, null);

  const fixture = await buildSynthetic3ResolutionFixture();
  const server = await startFixtureHttpServer(fixture.descriptorPath);

  try {
    const manager = new TileStreamManager({
      apiBaseUrl: server.baseUrl,
      initialCameraZoom: 1.2,
      streamingFrameBudget: {
        ...STREAMING_F1_VARIANTS.combined_prewarm,
        transitionDebounceMs: 0,
      },
    });

    try {
      await manager.initialize();

      const viewport = (zoom: number): TileViewportGroundBounds => ({
        minX: -500,
        maxX: 500,
        minZ: -500,
        maxZ: 500,
        focusX: 0,
        focusZ: 0,
        cameraZoom: zoom,
        viewportWidthPx: 1280,
        viewportHeightPx: 720,
      });

      // Settle at zoom 1.10 (active = 1,024 m)
      manager.updateViewport(viewport(1.1));
      await manager.waitForIdle();
      assert.equal(manager.getHierarchicalDiagnostics()?.activeResolutionMeters, 1024);

      // Move to zoom 0.85 (approaching 0.80 threshold from above while still desiring 1,024 m)
      manager.updateViewport(viewport(0.85));
      assert.equal(
        manager.getHierarchicalDiagnostics()?.prewarmTargetResolutionMeters,
        2048
      );
      await manager.waitForIdle();

      const afterPrewarm = manager.getHierarchicalDiagnostics()!;
      assert.equal(afterPrewarm.activeResolutionMeters, 1024);
      assert.ok(
        afterPrewarm.counters.prewarmTilesPrepared > 0,
        'Expected predictive pre-warming to prepare approaching 2,048 m tiles'
      );

      // Cross threshold to 0.55 (2,048 m): prewarmed tiles should be reused immediately!
      manager.updateViewport(viewport(0.55));
      await manager.waitForIdle();
      const afterCross = manager.getHierarchicalDiagnostics()!;
      assert.equal(afterCross.activeResolutionMeters, 2048);
      assert.ok(
        afterCross.counters.prewarmReusedOnTransition > 0,
        'Expected transition to reuse prewarmed 2,048 m tiles'
      );
      assert.ok(
        (afterCross.lastCompletedTransition?.reusedFromPrewarmCount ?? 0) > 0
      );
    } finally {
      manager.dispose();
    }
  } finally {
    await server.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});
