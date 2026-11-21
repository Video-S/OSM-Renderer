import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import * as THREE from 'three';
import { MAP_THEMES } from '../styles/mapThemes';
import {
  bakeStudyRegionTilesToSqlite,
  disposeIngestedStudyRegionPlans,
} from '../server/tiles/OfflineHengeloTileBaker';
import { createTilePackHttpHandler } from '../server/tiles/tilePackHttpHandler';
import { resolveInspectedFeature } from './GeometryBuilder';
import {
  createAlignedStudyGrid,
  formatTileId,
  type StudyGridSpec,
} from './tiling/TileGrid';
import { ingestCanonicalStudyGeoJson } from './tiling/TiledStudyPipeline';
import { createTileDecodeClient } from './tiling/TileDecodeClient';
import { TileStreamManager } from './tiling/TileStreamManager';
import {
  computeCrossModeComparisonSummary,
  formatM2bMarkdownReport,
  parseTileStreamingCliArgs,
  runTileStreamingBenchmark,
  type TileBenchmarkModeResult,
  type TileStreamingBenchmarkReport,
} from '../../benchmarks/tileStreamingRunner';

function build5x5LifecycleGeoJson(grid: StudyGridSpec) {
  const toLonLat = (x: number, z: number): [number, number] =>
    grid.projection.toGeo(x, z);
  const ringToLonLat = (pts: Array<[number, number]>) => [
    pts.map(([x, z]) => toLonLat(x, z)),
  ];

  // 5x5 grid: total span [-1280..1280] x [-1280..1280], tile size 512 m
  // NW tile [col=0, row=0]: x in [-1280..-768], z in [-1280..-768] (center -1024, -1024)
  // SE tile [col=4, row=4]: x in [768..1280], z in [768..1280] (center 1024, 1024)
  return {
    type: 'FeatureCollection',
    features: [
      // Regional residential landuse in NW corner
      {
        type: 'Feature',
        id: 'way/nw-landuse',
        properties: {
          id: 'way/nw-landuse',
          landuse: 'residential',
          name: 'NW Quarter',
        },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [-1220, -1220],
            [-800, -1220],
            [-800, -800],
            [-1220, -800],
            [-1220, -1220],
          ]),
        },
      },
      // NW building
      {
        type: 'Feature',
        id: 'way/nw-depot',
        properties: {
          id: 'way/nw-depot',
          building: 'commercial',
          name: 'NW Terminal',
          height: '18',
        },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [-1040, -1040],
            [-990, -1040],
            [-990, -990],
            [-1040, -990],
            [-1040, -1040],
          ]),
        },
      },
      // NW primary road
      {
        type: 'Feature',
        id: 'way/nw-road',
        properties: {
          id: 'way/nw-road',
          highway: 'primary',
          name: 'NW Ringweg',
        },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-1200, -940), toLonLat(-780, -940)],
        },
      },
      // NW railway
      {
        type: 'Feature',
        id: 'way/nw-rail',
        properties: {
          id: 'way/nw-rail',
          railway: 'rail',
          electrified: 'contact_line',
        },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-1200, -1120), toLonLat(-780, -1120)],
        },
      },
      // SE water park
      {
        type: 'Feature',
        id: 'way/se-water',
        properties: {
          id: 'way/se-water',
          natural: 'water',
          water: 'pond',
          name: 'SE Basin',
        },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [820, 820],
            [920, 820],
            [920, 920],
            [820, 920],
            [820, 820],
          ]),
        },
      },
      // SE building
      {
        type: 'Feature',
        id: 'way/se-tower',
        properties: {
          id: 'way/se-tower',
          building: 'office',
          name: 'SE Innovation Tower',
          height: '24',
        },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [990, 990],
            [1045, 990],
            [1045, 1045],
            [990, 1045],
            [990, 990],
          ]),
        },
      },
      // SE road
      {
        type: 'Feature',
        id: 'way/se-road',
        properties: {
          id: 'way/se-road',
          highway: 'secondary',
          name: 'SE Boulevard',
        },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(780, 1100), toLonLat(1220, 1100)],
        },
      },
      // SE railway + turnout
      {
        type: 'Feature',
        id: 'way/se-rail',
        properties: {
          id: 'way/se-rail',
          railway: 'rail',
          electrified: 'contact_line',
        },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(780, 950), toLonLat(1020, 950), toLonLat(1220, 950)],
        },
      },
      {
        type: 'Feature',
        id: 'way/se-turnout',
        properties: {
          id: 'way/se-turnout',
          railway: 'rail',
          service: 'siding',
        },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(1020, 950), toLonLat(1080, 965), toLonLat(1200, 965)],
        },
      },
    ],
  };
}

async function startLifecycleTileServer(
  options: Parameters<typeof createTilePackHttpHandler>[0]
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  const controller = createTilePackHttpHandler(options);
  app.get('/api/tiles/manifest', controller.manifestHandler);
  app.get('/api/tiles/:lod/:tx/:ty', controller.tilePayloadHandler);
  app.get(
    '/api/tiles/:snapshotId/:schemaVersion/:lod/:tx/:ty',
    controller.tilePayloadHandler
  );

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind ephemeral HTTP server');
  }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}/api/tiles`,
    close: async () => {
      controller.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function countCompositeLayerChildren(scene: TileStreamManager['scene']) {
  const counts = {
    buildings: scene.buildingsGroup.children.length,
    roads: scene.roadsGroup.children.length,
    railways: scene.railwaysGroup.children.length,
    water: scene.waterGroup.children.length,
    parks: scene.parksGroup.children.length,
    landuse: scene.landuseGroup.children.length,
    barriers: scene.barriersGroup.children.length,
    foliage: scene.foliageGroup.children.length,
  };
  const duplicateKeys: string[] = [];
  for (const [layerName, grp] of [
    ['buildings', scene.buildingsGroup],
    ['roads', scene.roadsGroup],
    ['railways', scene.railwaysGroup],
    ['water', scene.waterGroup],
    ['parks', scene.parksGroup],
    ['landuse', scene.landuseGroup],
    ['barriers', scene.barriersGroup],
    ['foliage', scene.foliageGroup],
  ] as const) {
    const seen = new Set<string>();
    for (const child of grp.children) {
      const tileKey = String(child.userData?.tileKey ?? child.name);
      if (seen.has(tileKey)) {
        duplicateKeys.push(`${layerName}:${tileKey}`);
      }
      seen.add(tileKey);
    }
  }
  return { counts, duplicateKeys };
}

test('M2-B lifecycle: 12 repeated distant pan/eviction cycles show zero leaks, exact resource return, and BVH parity', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-m2b-cycles-'));
  const packPath = path.join(tmpDir, 'm2b-5x5-tiles.sqlite');

  const grid = createAlignedStudyGrid({
    name: 'synthetic-5x5-m2b-lifecycle',
    centerLonLat: [6.7935, 52.2625],
    cols: 5,
    rows: 5,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const ingested = ingestCanonicalStudyGeoJson(build5x5LifecycleGeoJson(grid), grid);
  const snapshotId = 'synthetic-m2b-5x5';
  const sourceSha256 = 'e'.repeat(64);

  try {
    bakeStudyRegionTilesToSqlite({
      ingested,
      outPath: packPath,
      snapshotId,
      sourceSha256,
      batchDimension: 3,
      includeBvh: true,
      theme: MAP_THEMES.tactical,
    });
    disposeIngestedStudyRegionPlans(ingested);

    const srv = await startLifecycleTileServer({
      packPath,
      expectedSnapshotId: snapshotId,
      expectedSourceSha256: sourceSha256,
      allowCustomSnapshot: true,
    });

    const decodeClient = createTileDecodeClient({ forceInlineDecode: true });
    const manager = new TileStreamManager({
      apiBaseUrl: srv.baseUrl,
      preloadMarginTiles: 0,
      retainMarginTiles: 0,
      maxConcurrentFetches: 4,
      maxCommitsPerFrame: 2,
      initialTheme: MAP_THEMES.tactical,
      initialCameraZoom: 2.5,
      decodeClient,
    });

    try {
      const meta = await manager.initialize();
      assert.equal(meta.gridCols * meta.gridRows, 25);

      const initialMaterialCount = manager.sharedMaterialRegistry.materialCount;
      assert.ok(initialMaterialCount > 0);

      const nwTile = grid.tiles.find((t) => t.gridCol === 0 && t.gridRow === 0)!;
      const seTile = grid.tiles.find((t) => t.gridCol === 4 && t.gridRow === 4)!;
      const nwKey = formatTileId(nwTile.tx, nwTile.ty);
      const seKey = formatTileId(seTile.tx, seTile.ty);

      const nwViewport = {
        minX: -1120,
        maxX: -920,
        minZ: -1120,
        maxZ: -920,
        focusX: -1020,
        focusZ: -1020,
        cameraZoom: 3.0,
      };
      const seViewport = {
        minX: 920,
        maxX: 1120,
        minZ: 920,
        maxZ: 1120,
        focusX: 1020,
        focusZ: 1020,
        cameraZoom: 3.0,
      };

      // Baseline NW & SE measurements on cycle 0
      let baselineNw: {
        loadedTiles: number;
        activeTileGeometries: number;
        activeTileBvhs: number;
        tileCpuGeometryBytes: number;
        tileBvhBytes: number;
        loadedMeshCount: number;
        layerCounts: ReturnType<typeof countCompositeLayerChildren>['counts'];
      } | null = null;
      let baselineSe: typeof baselineNw = null;

      const raycaster = new THREE.Raycaster();
      (raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;

      const CYCLES = 12;
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        // 1. Pan to NW tile
        manager.updateViewport(nwViewport);
        await manager.waitForIdle();
        const nwDiag = manager.getDiagnostics();
        const nwTree = countCompositeLayerChildren(manager.scene);

        assert.equal(nwTree.duplicateKeys.length, 0, `Duplicate NW children: ${nwTree.duplicateKeys}`);
        assert.equal(nwDiag.loadedTiles, 1);
        assert.deepEqual(nwDiag.loadedTileKeys, [nwKey]);
        assert.equal(manager.getTileState(nwKey), 'loaded');
        assert.equal(manager.getTileState(seKey), 'unloaded');
        assert.equal(manager.sharedMaterialRegistry.disposed, false);
        assert.equal(manager.sharedMaterialRegistry.materialCount, initialMaterialCount);

        if (!baselineNw) {
          baselineNw = {
            loadedTiles: nwDiag.loadedTiles,
            activeTileGeometries: nwDiag.activeTileGeometries,
            activeTileBvhs: nwDiag.activeTileBvhs,
            tileCpuGeometryBytes: nwDiag.tileCpuGeometryBytes,
            tileBvhBytes: nwDiag.tileBvhBytes,
            loadedMeshCount: nwDiag.loadedMeshCount,
            layerCounts: nwTree.counts,
          };
        } else {
          assert.equal(nwDiag.activeTileGeometries, baselineNw.activeTileGeometries);
          assert.equal(nwDiag.activeTileBvhs, baselineNw.activeTileBvhs);
          assert.equal(nwDiag.tileCpuGeometryBytes, baselineNw.tileCpuGeometryBytes);
          assert.equal(nwDiag.tileBvhBytes, baselineNw.tileBvhBytes);
          assert.equal(nwDiag.loadedMeshCount, baselineNw.loadedMeshCount);
          assert.deepEqual(nwTree.counts, baselineNw.layerCounts);
        }

        // Verify BVH raycasting works on cycle 0, 6, and 11 in NW
        if (cycle === 0 || cycle === 6 || cycle === CYCLES - 1) {
          raycaster.set(new THREE.Vector3(-1015, 60, -1015), new THREE.Vector3(0, -1, 0));
          const hits = raycaster.intersectObjects(manager.scene.buildingsGroup.children, true);
          assert.ok(hits.length > 0, `Expected NW building hit on cycle ${cycle}`);
          const info = resolveInspectedFeature(hits[0]);
          assert.equal(info?.sourceFeatureId, 'way/nw-depot');
          assert.equal(info?.osmTags?.name, 'NW Terminal');
        }

        // 2. Pan far to SE tile (evicts NW tile completely)
        manager.updateViewport(seViewport);
        await manager.waitForIdle();
        const seDiag = manager.getDiagnostics();
        const seTree = countCompositeLayerChildren(manager.scene);

        assert.equal(seTree.duplicateKeys.length, 0, `Duplicate SE children: ${seTree.duplicateKeys}`);
        assert.equal(seDiag.loadedTiles, 1);
        assert.deepEqual(seDiag.loadedTileKeys, [seKey]);
        assert.equal(manager.getTileState(seKey), 'loaded');
        assert.equal(manager.getTileState(nwKey), 'unloaded');
        assert.equal(manager.sharedMaterialRegistry.disposed, false);
        assert.equal(manager.sharedMaterialRegistry.materialCount, initialMaterialCount);

        if (!baselineSe) {
          baselineSe = {
            loadedTiles: seDiag.loadedTiles,
            activeTileGeometries: seDiag.activeTileGeometries,
            activeTileBvhs: seDiag.activeTileBvhs,
            tileCpuGeometryBytes: seDiag.tileCpuGeometryBytes,
            tileBvhBytes: seDiag.tileBvhBytes,
            loadedMeshCount: seDiag.loadedMeshCount,
            layerCounts: seTree.counts,
          };
        } else {
          assert.equal(seDiag.activeTileGeometries, baselineSe.activeTileGeometries);
          assert.equal(seDiag.activeTileBvhs, baselineSe.activeTileBvhs);
          assert.equal(seDiag.tileCpuGeometryBytes, baselineSe.tileCpuGeometryBytes);
          assert.equal(seDiag.tileBvhBytes, baselineSe.tileBvhBytes);
          assert.equal(seDiag.loadedMeshCount, baselineSe.loadedMeshCount);
          assert.deepEqual(seTree.counts, baselineSe.layerCounts);
        }

        if (cycle === 0 || cycle === 6 || cycle === CYCLES - 1) {
          raycaster.set(new THREE.Vector3(1015, 60, 1015), new THREE.Vector3(0, -1, 0));
          const hits = raycaster.intersectObjects(manager.scene.buildingsGroup.children, true);
          assert.ok(hits.length > 0, `Expected SE building hit on cycle ${cycle}`);
          const info = resolveInspectedFeature(hits[0]);
          assert.equal(info?.sourceFeatureId, 'way/se-tower');
          assert.equal(info?.osmTags?.name, 'SE Innovation Tower');
        }
      }

      const preDisposeDiag = manager.getDiagnostics();
      assert.equal(
        preDisposeDiag.evictedTilesTotal,
        CYCLES * 2 - 1,
        'Expected 23 total evictions across 12 NW<->SE cycles'
      );
      assert.equal(preDisposeDiag.peakLoadedTiles, 1);
      assert.ok(preDisposeDiag.fetchMsStats && preDisposeDiag.fetchMsStats.count >= 24);
      assert.ok(preDisposeDiag.decodeMsStats && preDisposeDiag.decodeMsStats.count >= 24);
      assert.ok(
        preDisposeDiag.reconstructMsStats && preDisposeDiag.reconstructMsStats.count >= 24
      );
      assert.ok(preDisposeDiag.commitMsStats && preDisposeDiag.commitMsStats.count >= 24);

      // Full unmount disposal verification
      manager.dispose();
      const postDispose = manager.getDiagnostics();
      const postTree = countCompositeLayerChildren(manager.scene);
      assert.equal(postDispose.loadedTiles, 0);
      assert.equal(postDispose.activeTileGeometries, 0);
      assert.equal(postDispose.activeTileBvhs, 0);
      assert.equal(postDispose.tileCpuGeometryBytes, 0);
      assert.equal(postDispose.tileBvhBytes, 0);
      assert.equal(manager.sharedMaterialRegistry.disposed, true);
      assert.deepEqual(postTree.counts, {
        buildings: 0,
        roads: 0,
        railways: 0,
        water: 0,
        parks: 0,
        landuse: 0,
        barriers: 0,
        foliage: 0,
      });
    } finally {
      manager.dispose();
      decodeClient.dispose();
      await srv.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('M2-B telemetry: peak tile counters, latency stats, and resetPerformanceCounters isolate streaming phases cleanly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-m2b-diag-'));
  const packPath = path.join(tmpDir, 'm2b-diag-tiles.sqlite');

  const grid = createAlignedStudyGrid({
    name: 'synthetic-5x5-m2b-diag',
    centerLonLat: [6.7935, 52.2625],
    cols: 5,
    rows: 5,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const ingested = ingestCanonicalStudyGeoJson(build5x5LifecycleGeoJson(grid), grid);
  const snapshotId = 'synthetic-m2b-diag';
  const sourceSha256 = 'f'.repeat(64);

  try {
    bakeStudyRegionTilesToSqlite({
      ingested,
      outPath: packPath,
      snapshotId,
      sourceSha256,
      batchDimension: 3,
      includeBvh: true,
      theme: MAP_THEMES.tactical,
    });
    disposeIngestedStudyRegionPlans(ingested);

    const srv = await startLifecycleTileServer({
      packPath,
      expectedSnapshotId: snapshotId,
      expectedSourceSha256: sourceSha256,
      allowCustomSnapshot: true,
    });

    const delayedFetch: typeof fetch = async (input, init) => {
      const urlStr = String(input);
      if (!urlStr.endsWith('/manifest')) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 15);
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              const err = new Error('Aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true }
          );
        });
      }
      return fetch(input, init);
    };

    const manager = new TileStreamManager({
      apiBaseUrl: srv.baseUrl,
      preloadMarginTiles: 1,
      retainMarginTiles: 1,
      maxConcurrentFetches: 4,
      maxCommitsPerFrame: 2,
      fetchFn: delayedFetch,
    });

    try {
      await manager.initialize();

      // Phase 1: Far overview loads all 25 tiles
      manager.updateViewport({
        minX: -1280,
        maxX: 1280,
        minZ: -1280,
        maxZ: 1280,
        focusX: 0,
        focusZ: 0,
        cameraZoom: 0.25,
      });
      await manager.waitForIdle();
      const d1 = manager.getDiagnostics();
      assert.equal(d1.totalGridCols, 5);
      assert.equal(d1.totalGridRows, 5);
      assert.equal(d1.totalGridTiles, 25);
      assert.equal(d1.loadedTiles, 25);
      assert.equal(d1.peakLoadedTiles, 25);
      assert.ok(d1.compositeSceneRevision > 0);
      assert.ok(d1.fetchMsStats && d1.fetchMsStats.minMs >= 0 && d1.fetchMsStats.maxMs >= d1.fetchMsStats.medianMs);

      // Reset performance counters before closeup phase
      manager.resetPerformanceCounters();
      const dReset = manager.getDiagnostics();
      assert.equal(dReset.loadedTiles, 25);
      assert.equal(dReset.peakLoadedTiles, 25);
      assert.equal(dReset.evictedTilesTotal, 0);
      assert.equal(dReset.fetchMsStats, null);

      // Phase 2: Tight NW closeup evicts outer tiles
      manager.updateViewport({
        minX: -1100,
        maxX: -940,
        minZ: -1100,
        maxZ: -940,
        focusX: -1020,
        focusZ: -1020,
        cameraZoom: 6.5,
      });
      await manager.waitForIdle();
      const d2 = manager.getDiagnostics();
      assert.equal(d2.visibleTiles, 1);
      assert.equal(d2.loadedTiles, 4);
      assert.ok(d2.evictedTilesTotal === 21);

      // Phase 3: Rapid mid-flight cancellation test (reset counters, jump to center, immediately jump to SE)
      manager.resetPerformanceCounters();
      manager.updateViewport({
        minX: -150,
        maxX: 150,
        minZ: -150,
        maxZ: 150,
        focusX: 0,
        focusZ: 0,
        cameraZoom: 3.0,
      });
      manager.updateViewport({
        minX: 920,
        maxX: 1120,
        minZ: 920,
        maxZ: 1120,
        focusX: 1020,
        focusZ: 1020,
        cameraZoom: 3.0,
      });
      assert.ok(manager.getDiagnostics().cancelledRequestsTotal >= 1);
      await manager.waitForIdle();
      const d3 = manager.getDiagnostics();
      assert.equal(d3.loadingTiles, 0);
      assert.equal(d3.failedTiles, 0);
      assert.equal(d3.loadedTiles, 4);
    } finally {
      manager.dispose();
      await srv.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('M2-B runner: CLI parser supports PowerShell comma-split flags and rejects conflicting GPU flags', () => {
  const parsed = parseTileStreamingCliArgs([
    '--dataset=synthetic-smoke-4x4',
    '--modes',
    'm1a_single_scene,',
    'm2a_streaming',
    '--scenarios',
    'closeup_station',
    'far_overview',
    '--eviction-hops=12',
    '--require-hardware',
    '--gpu-backend=d3d11',
    '--out=benchmarks/results/test.json',
  ]);

  assert.equal(parsed.dataset, 'synthetic-smoke-4x4');
  assert.deepEqual(parsed.modes, ['m1a_single_scene', 'm2a_streaming']);
  assert.deepEqual(parsed.scenarios, ['closeup_station', 'far_overview']);
  assert.equal(parsed.evictionHops, 12);
  assert.equal(parsed.requireHardwareGpu, true);
  assert.equal(parsed.gpuBackend, 'd3d11');
  assert.equal(parsed.outputPath, 'benchmarks/results/test.json');

  assert.throws(() =>
    parseTileStreamingCliArgs(['--swiftshader', '--require-hardware'])
  );
  assert.throws(() =>
    parseTileStreamingCliArgs(['--modes=nonexistent_mode'])
  );
});

test('M2-B runner: comparison math, honest Markdown formatting, and missing canonical pack guard', async () => {
  const makeStats = (v: number) => ({
    sampleCount: 4,
    min: v,
    max: v,
    mean: v,
    median: v,
    p95: v,
    p99: v,
    stdDev: 0,
    iqr: 0,
    coefficientOfVariation: 0,
    samples: [v, v, v, v],
  });

  const makeMode = (
    modeId: TileBenchmarkModeResult['modeId'],
    totalMeshes: number,
    frustumMeshes: number,
    drawCalls: number,
    frameMs: number,
    cpuRenderMs: number
  ): TileBenchmarkModeResult => ({
    modeId,
    modeLabel: modeId,
    tileCountInGrid: 64,
    initialization: {
      fetchOrManifestMs: 5,
      ingestMs: modeId === 'm2a_streaming' ? 0 : 1000,
      referenceBuildMs: modeId === 'm1a_single_scene' ? 2000 : null,
      tiledBuildMs: modeId === 'm1a_tiled_64' ? 4000 : null,
      totalInitToFirstFrameMs: 50,
      sharedMaterialCount: modeId === 'm2a_streaming' ? 24 : null,
    },
    scenarios: [
      {
        scenarioId: 'closeup_station',
        cameraPoseSummary: 'target=[0,0,0], zoom=6.5',
        primaryMetrics: {
          phaseId: 'steady_state',
          warmupFrames: 3,
          measuredFrames: 12,
          frameIntervalMs: makeStats(frameMs),
          effectiveMedianFps: Number((1000 / frameMs).toFixed(2)),
          spikesOver33msCount: 0,
          spikesOver50msCount: 0,
          cpuRenderTimeMs: makeStats(cpuRenderMs),
          gpuFrameRenderTimeMs: {
            status: 'unsupported',
            statistics: null,
            sampleCounts: {
              totalFrames: 12,
              valid: 0,
              pending: 0,
              disjoint: 0,
              unsupported: 12,
            },
          },
          webglDrawCallsPerFrame: makeStats(drawCalls),
          renderedTrianglesPerFrame: makeStats(120000),
          meshCounts: {
            total: {
              totalMeshes,
              visibleFlagMeshes: totalMeshes,
              frustumVisibleMeshes: frustumMeshes,
            },
            byLayer: {},
          },
          driverResourcesEnd: {
            driverGeometries: 200,
            driverTextures: 4,
            driverPrograms: 8,
          },
          browserMemoryMB: {
            supported: false,
            usedJSHeapSizeMB: null,
            totalJSHeapSizeMB: null,
            jsHeapSizeLimitMB: null,
          },
          cpuBufferMB: 32,
          bvhMemoryMB: 4,
          streamingDiagnostics: null,
        },
      },
    ],
  });

  const modes: TileBenchmarkModeResult[] = [
    makeMode('m1a_single_scene', 452, 120, 140, 16.6, 2.5),
    makeMode('m1a_tiled_64', 2783, 190, 260, 18.0, 5.2),
    makeMode('m2a_streaming', 680, 180, 210, 16.7, 3.1),
  ];

  const comparisons = computeCrossModeComparisonSummary(modes, ['closeup_station']);
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].m1aSingleMeshes, 452);
  assert.equal(comparisons[0].m1aTiledMeshes, 2783);
  assert.equal(comparisons[0].m2aStreamingMeshesTotal, 680);
  assert.equal(comparisons[0].m2aStreamingMeshesFrustum, 180);
  assert.ok((comparisons[0].meshReductionStreamingVsAllTilesPct ?? 0) > 75);
  assert.equal(comparisons[0].meshRatioStreamingVsSingleScene, 1.5);

  const syntheticReport: TileStreamingBenchmarkReport = {
    schemaVersion: '1.0.0',
    benchmarkName: 'Test M2-B',
    ticket: 'TKT-028',
    milestone: 'M2-B',
    dataset: {
      id: 'synthetic-smoke-4x4',
      description: 'Synthetic test',
      gridCols: 4,
      gridRows: 4,
      totalGridTiles: 16,
      tileSizeMeters: 512,
      isCanonicalHengelo: false,
    },
    renderSettings: {
      viewportWidth: 1440,
      viewportHeight: 900,
      devicePixelRatio: 1,
      themeId: 'tactical',
      roadsMode: 'graph-surface',
      railwaysMode: 'graph-R+',
      preloadMarginTiles: 1,
      retainMarginTiles: 2,
      maxConcurrentFetches: 6,
      maxCommitsPerFrame: 4,
    },
    environment: {
      gitCommitSha: 'unknown',
      gitDirty: false,
      gitMetadataStatus: 'not_a_git_repository',
      timestampIso: new Date().toISOString(),
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      cpuModel: 'Test CPU',
      cpuLogicalCores: 4,
      totalSystemMemoryMB: 8192,
      gcExposed: false,
      browser: {
        browserName: 'Chromium',
        browserVersion: '130',
        userAgent: 'Test',
        viewportWidth: 1440,
        viewportHeight: 900,
        devicePixelRatio: 1,
        webglVersion: 'WebGL2',
        gpuVendor: 'Google',
        gpuRenderer: 'ANGLE (SwiftShader)',
        isSoftwareRenderer: true,
        hardwareAccelerationRequested: false,
        launchFlags: [],
      },
    },
    modes,
    comparisons,
    notes: [],
  };

  const md = formatM2bMarkdownReport(syntheticReport);
  assert.ok(md.includes('Synthetic 4×4 smoke dataset'));
  assert.ok(md.includes('`unsupported`'));

  // Missing canonical SQLite files in sandbox must fail fast with actionable guidance
  if (!fs.existsSync(path.resolve('data/osm/overijssel-tiles-261114-8ae28196.sqlite'))) {
    await assert.rejects(
      () => runTileStreamingBenchmark({ dataset: 'canonical-hengelo' }),
      /Canonical Hengelo dataset requires local Overijssel SQLite/
    );
  }
});
