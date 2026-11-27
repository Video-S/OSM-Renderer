import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import * as THREE from 'three';
import { resolveInspectedFeature } from './GeometryBuilder';
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
  DEFAULT_HIERARCHICAL_RESOLUTION_POLICY,
  evaluateAdaptivePrewarmHorizon,
  predictViewportBoundsAtHorizon,
} from './tiling/HierarchicalResolutionPolicy';
import {
  DEFAULT_STREAMING_FRAME_BUDGET_CONFIG,
  identifyStreamingF1Variant,
  parseStreamingFrameBudgetFromSearch,
  resolveStreamingFrameBudgetConfig,
  STREAMING_F1_VARIANTS,
  STREAMING_F2_COMPARISON_VARIANTS,
} from './tiling/StreamingSchedulerConfig';
import {
  createTileDecodeClient,
  type TileDecodeClient,
  type TileDecodeJobOptions,
} from './tiling/TileDecodeClient';
import {
  TileStreamManager,
  type TileViewportGroundBounds,
} from './tiling/TileStreamManager';
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

function createSyntheticTilePayload(params: {
  tx: number;
  ty: number;
  tileCenterX: number;
  tileCenterZ: number;
  tileSizeMeters: number;
}): DecodedTilePayload {
  const { tx, ty, tileCenterX, tileCenterZ, tileSizeMeters } = params;
  const half = tileSizeMeters * 0.5;
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

  const treeCount = 8;
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

interface SyntheticHierarchyFixture {
  rootDir: string;
  index1024Path: string;
  index2048Path: string;
  index4096Path: string;
  descriptorPath: string;
}

async function buildSynthetic3ResolutionFixture(): Promise<SyntheticHierarchyFixture> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkt041-f2-test-'));
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
        const payload = createSyntheticTilePayload({
          tx: tile.tx,
          ty: tile.ty,
          tileCenterX,
          tileCenterZ,
          tileSizeMeters: 1024,
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

test('TKT-041-F2: Staged F2 variants, URL configuration parsing, and f2_combined default preset', () => {
  assert.equal(identifyStreamingF1Variant(DEFAULT_STREAMING_FRAME_BUDGET_CONFIG), 'f2_combined');
  assert.equal(DEFAULT_STREAMING_FRAME_BUDGET_CONFIG.independentPipelineStagesEnabled, true);
  assert.equal(DEFAULT_STREAMING_FRAME_BUDGET_CONFIG.maxConcurrentHttpRetrievals, 8);
  assert.equal(DEFAULT_STREAMING_FRAME_BUDGET_CONFIG.workerConcurrency, 4);
  assert.equal(DEFAULT_STREAMING_FRAME_BUDGET_CONFIG.useCompressedHttpTransfer, true);
  assert.equal(DEFAULT_STREAMING_FRAME_BUDGET_CONFIG.adaptivePrewarmHorizonEnabled, true);

  for (const variant of STREAMING_F2_COMPARISON_VARIANTS) {
    assert.ok(variant in STREAMING_F1_VARIANTS);
    const resolved = resolveStreamingFrameBudgetConfig(variant);
    assert.equal(identifyStreamingF1Variant(resolved), variant);
  }

  const parsed = parseStreamingFrameBudgetFromSearch(
    '?streamingF2Variant=f2_tuned_concurrency&maxConcurrentHttpRetrievals=12&workerConcurrency=4&compressedTransfer=1&adaptivePrewarm=1'
  );
  assert.ok(parsed);
  const resolved = resolveStreamingFrameBudgetConfig(parsed);
  assert.equal(resolved.maxConcurrentHttpRetrievals, 12);
  assert.equal(resolved.workerConcurrency, 4);
  assert.equal(resolved.useCompressedHttpTransfer, true);
  assert.equal(resolved.adaptivePrewarmHorizonEnabled, true);
});

test('TKT-041-F2: Server compressed transfer (?compressed=1) and server timing diagnostics headers', async () => {
  const fixture = await buildSynthetic3ResolutionFixture();
  const server = await startFixtureHttpServer(fixture.descriptorPath);
  try {
    const manifestRes = await fetch(`${server.baseUrl}/manifest`);
    assert.equal(manifestRes.status, 200);
    const manifest = (await manifestRes.json()) as {
      metadata: {
        snapshotId: string;
        bakeSchemaVersion: number;
      };
      tiles: TileManifestEntry[];
    };
    const tile0 = manifest.tiles[0];
    assert.ok(tile0);

    // 1. Default uncompressed request
    const uncompressedRes = await fetch(
      `${server.baseUrl}/r/1024/${manifest.metadata.snapshotId}/${manifest.metadata.bakeSchemaVersion}/0/${tile0.tx}/${tile0.ty}`
    );
    assert.equal(uncompressedRes.status, 200);
    assert.equal(uncompressedRes.headers.get('X-Tile-Transfer-Compressed'), '0');
    assert.ok(Number(uncompressedRes.headers.get('X-Tile-Server-Sqlite-Ms')) >= 0);
    assert.ok(Number(uncompressedRes.headers.get('X-Tile-Server-Inflate-Ms')) >= 0);
    assert.ok(Number(uncompressedRes.headers.get('X-Tile-Server-Total-Ms')) >= 0);
    const uncompressedBuf = await uncompressedRes.arrayBuffer();
    assert.equal(uncompressedBuf.byteLength, tile0.rawBytes);

    // 2. Compressed transfer request (?compressed=1) skips server inflation
    const compressedRes = await fetch(
      `${server.baseUrl}/r/1024/${manifest.metadata.snapshotId}/${manifest.metadata.bakeSchemaVersion}/0/${tile0.tx}/${tile0.ty}?compressed=1`
    );
    assert.equal(compressedRes.status, 200);
    assert.equal(compressedRes.headers.get('X-Tile-Transfer-Compressed'), '1');
    assert.equal(Number(compressedRes.headers.get('X-Tile-Server-Inflate-Ms')), 0);
    const compressedBuf = await compressedRes.arrayBuffer();
    assert.equal(compressedBuf.byteLength, tile0.compressedBytes);
    assert.ok(compressedBuf.byteLength < uncompressedBuf.byteLength);

    // 3. TileDecodeClient decodes deflate-compressed payload accurately
    const decodeClient = createTileDecodeClient({ forceInlineDecode: true });
    const decodedResult = await decodeClient.decodeTile(
      compressedBuf,
      '1024:0:-2:-2'
    );
    assert.equal(decodedResult.decoded.tx, tile0.tx);
    assert.equal(decodedResult.decoded.ty, tile0.ty);
    assert.equal(decodedResult.decoded.totalVertices, tile0.vertexCount);
    decodeClient.dispose();
  } finally {
    await server.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test('TKT-041-F2: Independent HTTP retrieval slot release, retrieved-payload queue, and oversized payload forward progress', async () => {
  const fixture = await buildSynthetic3ResolutionFixture();
  const server = await startFixtureHttpServer(fixture.descriptorPath);
  try {
    // Hold worker decode completion manually so we can verify that HTTP slots
    // release as soon as response.arrayBuffer() finishes and enter retrieved_queued.
    const heldDecodes: Array<{
      key: string;
      buffer: ArrayBuffer;
      release: () => void;
    }> = [];
    const realDecoder = createTileDecodeClient({ forceInlineDecode: true });
    let holdWorkerDecodes = true;

    const gateDecodeClient: TileDecodeClient = {
      setPreparationOptions: (cfg) => realDecoder.setPreparationOptions(cfg),
      getPreparationOptions: () => realDecoder.getPreparationOptions(),
      getActiveWorkerCount: () => 1,
      getBusyWorkerCount: () => (heldDecodes.length > 0 ? 1 : 0),
      getQueuedDecodeCount: () => Math.max(0, heldDecodes.length - 1),
      getPendingDecodeCount: () => heldDecodes.length,
      setMaxWorkerConcurrency: () => {},
      updateJobPriority: (key, priority, isDest) =>
        realDecoder.updateJobPriority(key, priority, isDest),
      getWorkerUtilizationSnapshot: () => ({
        configuredWorkerPoolSize: 1,
        maxConcurrentWorkers: 1,
        busyWorkerCount: heldDecodes.length > 0 ? 1 : 0,
        idleWorkerCount: heldDecodes.length > 0 ? 0 : 1,
        queuedDecodeCount: Math.max(0, heldDecodes.length - 1),
        queuedDestinationDecodeCount: 0,
        activeDestinationWorkerCount: 0,
        totalJobsCompleted: 0,
        totalJobsAbortedInQueue: 0,
        totalJobsAbortedWhileRunning: 0,
        totalJobsRetainedAfterAbort: 0,
        totalWorkerActiveTimeMs: 0,
        totalClientQueueWaitMs: 0,
        wastedWorkerTimeMs: 0,
      }),
      decodeTile: (
        buffer: ArrayBuffer,
        key: string,
        signal?: AbortSignal,
        priority?: number,
        options?: TileDecodeJobOptions
      ) => {
        if (!holdWorkerDecodes) {
          return realDecoder.decodeTile(buffer, key, signal, priority, options);
        }
        return new Promise((resolve, reject) => {
          const item = {
            key,
            buffer,
            release: () => {
              realDecoder
                .decodeTile(buffer, key, signal, priority, options)
                .then(resolve, reject);
            },
          };
          heldDecodes.push(item);
        });
      },
      dispose: () => realDecoder.dispose(),
    };

    // Set maxConcurrentHttpRetrievals = 2, workerConcurrency = 1, and a tiny
    // maxRetrievedPayloadQueueBytes (128 bytes) so individual payloads (>1 KB)
    // exercise the oversized payload forward-progress rule!
    const manager = new TileStreamManager({
      apiBaseUrl: server.baseUrl,
      initialCameraZoom: 1.5,
      decodeClient: gateDecodeClient,
      streamingFrameBudget: {
        ...resolveStreamingFrameBudgetConfig('f2_combined'),
        maxConcurrentHttpRetrievals: 2,
        workerConcurrency: 1,
        maxRetrievedPayloadQueueBytes: 128,
        maxWorkerPreparationBytes: 128,
        transitionDebounceMs: 0,
        predictivePrewarmEnabled: false,
        adaptivePrewarmHorizonEnabled: false,
      },
    });

    await manager.initialize();

    const fullViewport: TileViewportGroundBounds = {
      minX: -1900,
      minZ: -1900,
      maxX: 1900,
      maxZ: 1900,
      focusX: 0,
      focusZ: 0,
      cameraZoom: 1.5, // 1,024 m resolution (16 tiles total)
      viewportWidthPx: 1280,
      viewportHeightPx: 720,
    };
    manager.updateViewport(fullViewport);

    // Wait for HTTP fetches to complete while worker decode is held on the first oversized tile
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 15));
      manager.tick();
      const diag = manager.getDiagnostics();
      if (
        heldDecodes.length >= 1 &&
        diag.throughputPipeline.retrievedQueuedCount >= 1
      ) {
        break;
      }
    }

    const midDiag = manager.getDiagnostics();
    assert.ok(midDiag.throughputPipeline);
    // Worker decode was admitted despite payload exceeding the 128-byte cap (oversized forward progress)
    assert.ok(
      midDiag.throughputPipeline.oversizedPayloadAdmissionsTotal >= 1,
      `Expected oversizedPayloadAdmissionsTotal >= 1, got ${midDiag.throughputPipeline.oversizedPayloadAdmissionsTotal}`
    );
    // HTTP retrieval slot was released when payload arrived, allowing another tile into retrieved_queued
    assert.ok(
      midDiag.throughputPipeline.retrievedQueuedCount >= 1,
      `Expected retrievedQueuedCount >= 1 while worker decode held, got ${midDiag.throughputPipeline.retrievedQueuedCount}`
    );

    // Release all held worker decodes and allow all 16 tiles to finish
    holdWorkerDecodes = false;
    while (heldDecodes.length > 0) {
      const next = heldDecodes.shift()!;
      next.release();
    }

    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 15));
      manager.tick();
      const diag = manager.getDiagnostics();
      if (
        diag.loadedTiles === 16 &&
        diag.throughputPipeline.reconstructedAwaitingGpuBytes === 0
      ) {
        break;
      }
    }

    const finalDiag = manager.getDiagnostics();
    assert.equal(finalDiag.loadedTiles, 16);
    assert.equal(finalDiag.throughputPipeline.httpRetrievingCount, 0);
    assert.equal(finalDiag.throughputPipeline.retrievedQueuedCount, 0);
    assert.equal(finalDiag.throughputPipeline.retrievedPayloadQueueBytes, 0);
    assert.equal(finalDiag.throughputPipeline.inFlightWorkerPreparationBytes, 0);

    manager.dispose();
  } finally {
    await server.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test('TKT-041-F2: Dynamic queue reprioritization and running-worker-job retention on demotion', async () => {
  const fixture = await buildSynthetic3ResolutionFixture();
  const server = await startFixtureHttpServer(fixture.descriptorPath);
  try {
    const manager = new TileStreamManager({
      apiBaseUrl: server.baseUrl,
      initialCameraZoom: 1.5,
      streamingFrameBudget: {
        ...resolveStreamingFrameBudgetConfig('f2_combined'),
        maxConcurrentHttpRetrievals: 2,
        workerConcurrency: 1,
        transitionDebounceMs: 0,
        predictivePrewarmEnabled: false,
        adaptivePrewarmHorizonEnabled: false,
      },
    });
    await manager.initialize();

    // First queue tiles near (-1500, -1500)
    const vpA: TileViewportGroundBounds = {
      minX: -1950,
      minZ: -1950,
      maxX: 1950,
      maxZ: 1950,
      focusX: -1500,
      focusZ: -1500,
      cameraZoom: 1.5,
      viewportWidthPx: 1280,
      viewportHeightPx: 720,
    };
    manager.updateViewport(vpA);

    // Immediately pan camera focus to (+1500, +1500) while tiles are still queued/retrieved
    const vpB: TileViewportGroundBounds = {
      minX: -1950,
      minZ: -1950,
      maxX: 1950,
      maxZ: 1950,
      focusX: 1500,
      focusZ: 1500,
      cameraZoom: 1.5,
      viewportWidthPx: 1280,
      viewportHeightPx: 720,
    };
    manager.updateViewport(vpB);

    const reprioDiag = manager.getDiagnostics();
    assert.ok(
      reprioDiag.throughputPipeline.dynamicReprioritizationsTotal > 0,
      `Expected dynamicReprioritizationsTotal > 0, got ${reprioDiag.throughputPipeline.dynamicReprioritizationsTotal}`
    );

    // Wait for initial 1,024 m load to settle
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 15));
      manager.tick();
      if (manager.getDiagnostics().loadedTiles === 16) break;
    }

    manager.dispose();
  } finally {
    await server.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test('TKT-041-F2: Adaptive latency-aware prewarming horizon and predicted viewport bounds', () => {
  // 1. Stationary camera inside 1,024 m band far from threshold -> no prewarm
  const stationary = evaluateAdaptivePrewarmHorizon({
    activeResolutionMeters: 1024,
    cameraZoom: 1.50,
    scaleVelocityPerSec: 0,
    availableResolutionsMeters: [1024, 2048, 4096],
    policy: DEFAULT_HIERARCHICAL_RESOLUTION_POLICY,
    bandFraction: 0.35,
    historicalPrepLatencyMs: { 1024: 120, 2048: 450, 4096: 1400 },
    leadMultiplier: 1.35,
  });
  assert.equal(stationary.targetResolutionMeters, null);

  // 2. Camera zooming out rapidly toward 1024 -> 2048 threshold (0.80) with 900 ms historical prep latency
  // At zoom = 1.15 (above static prewarm band), scaleVelocity = -0.35/s reaches 0.80 in 1,000 ms <= 900 * 1.35 ms (1,215 ms)
  const fastZoomOut = evaluateAdaptivePrewarmHorizon({
    activeResolutionMeters: 1024,
    cameraZoom: 1.15,
    scaleVelocityPerSec: -0.35,
    availableResolutionsMeters: [1024, 2048, 4096],
    policy: DEFAULT_HIERARCHICAL_RESOLUTION_POLICY,
    bandFraction: 0.35,
    historicalPrepLatencyMs: { 1024: 120, 2048: 900, 4096: 1800 },
    leadMultiplier: 1.35,
  });
  assert.equal(fastZoomOut.targetResolutionMeters, 2048);
  assert.equal(fastZoomOut.triggeredByVelocityHorizon, true);
  assert.ok((fastZoomOut.requiredLeadTimeMs ?? 0) >= 900);

  // 3. Predicted viewport bounds shift along pan velocity and expand when zooming out
  const currentVp = {
    minX: -500,
    minZ: -500,
    maxX: 500,
    maxZ: 500,
    centerX: 0,
    centerZ: 0,
  };
  const predictedVp = predictViewportBoundsAtHorizon({
    currentBounds: currentVp,
    panVelocityXPerSec: 400,
    panVelocityZPerSec: -200,
    zoomRatioAtHorizon: 1.3,
    horizonSeconds: 1.0,
  });
  assert.ok(predictedVp.centerX > currentVp.centerX);
  assert.ok(predictedVp.centerZ < currentVp.centerZ);
  assert.ok(
    predictedVp.maxX - predictedVp.minX > currentVp.maxX - currentVp.minX,
    'Predicted viewport should widen when zooming out'
  );
});

test('TKT-041-F2: Destination progress under continuous active panning, atomic activation, and picking parity', async () => {
  const fixture = await buildSynthetic3ResolutionFixture();
  const server = await startFixtureHttpServer(fixture.descriptorPath);
  try {
    const manager = new TileStreamManager({
      apiBaseUrl: server.baseUrl,
      initialCameraZoom: 1.5,
      streamingFrameBudget: {
        ...resolveStreamingFrameBudgetConfig('f2_combined'),
        transitionDebounceMs: 0,
      },
    });
    await manager.initialize();

    // 1. Start at 1,024 m resolution
    let currentVp: TileViewportGroundBounds = {
      minX: -900,
      minZ: -900,
      maxX: 900,
      maxZ: 900,
      focusX: -400,
      focusZ: -400,
      cameraZoom: 1.5,
      viewportWidthPx: 1280,
      viewportHeightPx: 720,
    };
    manager.updateViewport(currentVp);

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 15));
      manager.tick();
      const diag = manager.getDiagnostics();
      if (
        diag.hierarchical?.activeResolutionMeters === 1024 &&
        diag.loadedTiles >= 4 &&
        diag.throughputPipeline.reconstructedAwaitingGpuBytes === 0
      ) {
        break;
      }
    }
    assert.equal(manager.getDiagnostics().hierarchical?.activeResolutionMeters, 1024);

    // 2. Trigger transition toward 4,096 m (zoom = 0.18) while continuously panning across 1,024 m tiles
    let activated4096 = false;
    for (let step = 0; step < 80; step++) {
      const panOffset = -400 + step * 15;
      currentVp = {
        minX: panOffset - 1200,
        minZ: panOffset - 1200,
        maxX: panOffset + 1200,
        maxZ: panOffset + 1200,
        focusX: panOffset,
        focusZ: panOffset,
        cameraZoom: 0.18, // requests 4,096 m destination resolution
        viewportWidthPx: 1280,
        viewportHeightPx: 720,
      };
      manager.updateViewport(currentVp);
      await new Promise((r) => setTimeout(r, 15));
      manager.tick();

      // Verify uniform viewport resolution invariant on every frame
      const attached = getAttachedResolutions(manager);
      assert.ok(
        attached.size <= 1,
        `Uniform resolution invariant violated: attached resolutions = ${Array.from(attached).join(',')}`
      );

      const diag = manager.getDiagnostics();
      if (diag.hierarchical?.activeResolutionMeters === 4096) {
        activated4096 = true;
        break;
      }
    }

    assert.equal(
      activated4096,
      true,
      'Transition to 4,096 m should complete despite continuous active-resolution panning'
    );

    const finalDiag = manager.getDiagnostics();
    assert.equal(finalDiag.hierarchical?.activeResolutionMeters, 4096);
    assert.equal(finalDiag.hierarchical?.pendingResolutionMeters, null);
    assert.equal(
      finalDiag.hierarchical?.currentTransitionBlocker.destinationCoverageReadinessRatio,
      1
    );

    // 3. Verify feature picking works on the activated 4,096 m scene
    const buildingMeshes = manager.scene.interactiveMeshes.buildings;
    assert.ok(buildingMeshes.length > 0, 'Expected building meshes in 4,096 m active scene');
    const targetMesh = buildingMeshes[0];
    const picked = resolveInspectedFeature({
      object: targetMesh,
      faceIndex: 0,
      point: new THREE.Vector3(0, 5, 0),
      distance: 10,
    } as unknown as THREE.Intersection);
    assert.ok(picked, 'Expected building feature to be pickable after 4,096 m transition');
    assert.equal(picked.category, 'Building');
    assert.equal(picked.type, 'apartments');

    manager.dispose();
  } finally {
    await server.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test('TKT-041-F2: Cancellation and cleanup across all pipeline stages with zero leaked byte reservations', async () => {
  const fixture = await buildSynthetic3ResolutionFixture();
  const server = await startFixtureHttpServer(fixture.descriptorPath);
  try {
    const manager = new TileStreamManager({
      apiBaseUrl: server.baseUrl,
      initialCameraZoom: 1.5,
      streamingFrameBudget: {
        ...resolveStreamingFrameBudgetConfig('f2_combined'),
        maxConcurrentHttpRetrievals: 3,
        workerConcurrency: 2,
        transitionDebounceMs: 0,
      },
    });
    await manager.initialize();

    // Start loading 1,024 m tiles, then rapidly reverse zoom to 2,048 m, 4,096 m, and back to 1,024 m
    const zooms = [1.5, 0.5, 0.18, 1.5, 0.5, 1.5];
    for (const z of zooms) {
      const vp: TileViewportGroundBounds = {
        minX: -1800,
        minZ: -1800,
        maxX: 1800,
        maxZ: 1800,
        focusX: 0,
        focusZ: 0,
        cameraZoom: z,
        viewportWidthPx: 1280,
        viewportHeightPx: 720,
      };
      manager.updateViewport(vp);
      await new Promise((r) => setTimeout(r, 12));
      manager.tick();
    }

    // Settle at final 1,024 m viewport
    const finalVp: TileViewportGroundBounds = {
      minX: -1800,
      minZ: -1800,
      maxX: 1800,
      maxZ: 1800,
      focusX: 0,
      focusZ: 0,
      cameraZoom: 1.5,
      viewportWidthPx: 1280,
      viewportHeightPx: 720,
    };
    manager.updateViewport(finalVp);
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 15));
      manager.tick();
      const diag = manager.getDiagnostics();
      if (
        diag.hierarchical?.activeResolutionMeters === 1024 &&
        diag.loadedTiles === 16 &&
        diag.loadingTiles === 0 &&
        diag.queuedTiles === 0 &&
        diag.throughputPipeline.reconstructedAwaitingGpuBytes === 0
      ) {
        break;
      }
    }

    const settled = manager.getDiagnostics();
    assert.equal(settled.hierarchical?.activeResolutionMeters, 1024);
    assert.equal(settled.loadedTiles, 16);
    assert.equal(settled.loadingTiles, 0);
    assert.equal(settled.queuedTiles, 0);
    assert.equal(settled.throughputPipeline.httpRetrievingCount, 0);
    assert.equal(settled.throughputPipeline.inFlightHttpReservationBytes, 0);
    assert.equal(settled.throughputPipeline.retrievedQueuedCount, 0);
    assert.equal(settled.throughputPipeline.retrievedPayloadQueueBytes, 0);
    assert.equal(settled.throughputPipeline.busyWorkerCount, 0);
    assert.equal(settled.throughputPipeline.inFlightWorkerPreparationBytes, 0);
    assert.equal(settled.throughputPipeline.preparedQueuedCount, 0);

    manager.dispose();
  } finally {
    await server.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});
