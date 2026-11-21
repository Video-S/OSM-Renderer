import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  bakeStudyRegionTilesToSqlite,
  disposeIngestedStudyRegionPlans,
} from '../server/tiles/OfflineHengeloTileBaker';
import {
  resolveDefaultTilePackPath,
  resolveTilePackPathForTileSize,
} from '../server/tiles/TilePackSqliteStore';
import { createTilePackHttpHandler } from '../server/tiles/tilePackHttpHandler';
import { verifyBakedTilePackAgainstIngested } from '../server/tiles/TilePackVerifier';
import { createHengeloStudyGrid, DEFAULT_COLLAR_METERS } from './tiling/TileGrid';
import { ingestCanonicalStudyGeoJson } from './tiling/TiledStudyPipeline';
import { createTileDecodeClient } from './tiling/TileDecodeClient';
import { TileStreamManager } from './tiling/TileStreamManager';
import { MAP_THEMES } from '../styles/mapThemes';
import {
  buildSynthetic4096mGeoJson,
  parseTileStreamingCliArgs,
  resolveTileBenchmarkStreamMargins,
} from '../../benchmarks/tileStreamingRunner';

async function startCustomTileServer(packPath: string, snapshotId: string, sourceSha256: string) {
  const controller = createTilePackHttpHandler({
    packPath,
    expectedSnapshotId: snapshotId,
    expectedSourceSha256: sourceSha256,
    allowCustomSnapshot: true,
  });
  const app = express();
  app.get('/manifest', controller.manifestHandler);
  app.get('/:lod/:tx/:ty', controller.tilePayloadHandler);
  app.get('/:snapshotId/:schemaVersion/:lod/:tx/:ty', controller.tilePayloadHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
      controller.close();
    },
  };
}

test('createHengeloStudyGrid(1024, 64) preserves exact 512m bounds, origin, and 512m seam alignment', () => {
  const grid512 = createHengeloStudyGrid(512, DEFAULT_COLLAR_METERS);
  const grid1024 = createHengeloStudyGrid(1024, DEFAULT_COLLAR_METERS);

  assert.equal(grid512.cols, 8);
  assert.equal(grid512.rows, 8);
  assert.equal(grid512.tiles.length, 64);

  assert.equal(grid1024.name, 'hengelo-4x4-m1a-1024m');
  assert.equal(grid1024.cols, 4);
  assert.equal(grid1024.rows, 4);
  assert.equal(grid1024.tiles.length, 16);
  assert.equal(grid1024.tileSizeMeters, 1024);
  assert.equal(grid1024.collarMeters, DEFAULT_COLLAR_METERS);

  // Identical UTM bounds, projection origin, local bounds, and geo bounds
  assert.deepEqual(grid1024.studyUtmBounds, grid512.studyUtmBounds);
  assert.deepEqual(grid1024.studyLocalBounds, grid512.studyLocalBounds);
  assert.deepEqual(grid1024.studyGeoBounds, grid512.studyGeoBounds);
  assert.deepEqual(grid1024.studyExpandedGeoBounds, grid512.studyExpandedGeoBounds);

  const [o1024E, o1024N] = grid1024.projection.localToUtm(0, 0);
  const [o512E, o512N] = grid512.projection.localToUtm(0, 0);
  assert.equal(o1024E, o512E);
  assert.equal(o1024N, o512N);

  // No gaps/overlaps and every 1,024 m edge aligns strictly on a 512 m seam (-2048, -1024, 0, +1024, +2048)
  const expectedEdges = new Set([-2048, -1024, 0, 1024, 2048]);
  for (const tile of grid1024.tiles) {
    assert.equal(tile.localBounds.maxX - tile.localBounds.minX, 1024);
    assert.equal(tile.localBounds.maxZ - tile.localBounds.minZ, 1024);
    assert.ok(expectedEdges.has(tile.localBounds.minX), `minX ${tile.localBounds.minX} not 512m aligned`);
    assert.ok(expectedEdges.has(tile.localBounds.maxX), `maxX ${tile.localBounds.maxX} not 512m aligned`);
    assert.ok(expectedEdges.has(tile.localBounds.minZ), `minZ ${tile.localBounds.minZ} not 512m aligned`);
    assert.ok(expectedEdges.has(tile.localBounds.maxZ), `maxZ ${tile.localBounds.maxZ} not 512m aligned`);
  }

  // Every interior sample across [-2048, 2048] belongs to exactly one 1,024 m tile
  for (const px of [-2048, -1536, -1024, -512, 0, 512, 1024, 1536, 2048]) {
    for (const pz of [-2048, -1024, 0, 1024, 2048]) {
      const owners = grid1024.tiles.filter((t) => {
        const b = t.localBounds;
        const inX = b.includeMaxEdgeX ? px >= b.minX && px <= b.maxX : px >= b.minX && px < b.maxX;
        const inZ = b.includeMaxEdgeZ ? pz >= b.minZ && pz <= b.maxZ : pz >= b.minZ && pz < b.maxZ;
        return inX && inZ;
      });
      assert.equal(owners.length, 1, `Point (${px}, ${pz}) matched ${owners.length} tiles`);
    }
  }

  assert.throws(() => createHengeloStudyGrid(700, 64), /positive integer divisor of 4096/);
});

test('SQLite pack path resolver keeps 512m default separate from 1024m and CLI parser supports experiment flags', () => {
  const path512 = resolveTilePackPathForTileSize(512, '/repo');
  const path1024 = resolveTilePackPathForTileSize(1024, '/repo');
  assert.equal(path512, resolveDefaultTilePackPath('/repo'));
  assert.notEqual(path512, path1024);
  assert.ok(path512.endsWith('overijssel-tiles-261114-8ae28196.sqlite'));
  assert.ok(path1024.endsWith('overijssel-tiles-261114-8ae28196-1024m.sqlite'));

  const parsed = parseTileStreamingCliArgs([
    '--dataset=synthetic-4096m',
    '--tile-size=1024',
    '--compare-tile-sizes',
    '--runs=2',
    '--pack=data/osm/custom.sqlite',
    '--swiftshader',
    '--quick',
  ]);
  assert.equal(parsed.dataset, 'synthetic-4096m');
  assert.equal(parsed.tileSizeMeters, 1024);
  assert.equal(parsed.compareTileSizes, true);
  assert.equal(parsed.runs, 2);
  // CLI parsing preserves the caller's literal path; normalization is deferred until use.
  // A Windows-normalized expectation would incorrectly fail for forward-slash CLI input.
  assert.equal(parsed.packPath, 'data/osm/custom.sqlite');
  assert.equal(parsed.useSwiftShader, true);

  assert.throws(() => parseTileStreamingCliArgs(['--tile-size=768']), /Unsupported --tile-size/);
});

test('benchmark physical-margin opt-in preserves 512m defaults and matches both policies in meters', () => {
  const legacy512 = resolveTileBenchmarkStreamMargins(512, false);
  const legacy1024 = resolveTileBenchmarkStreamMargins(1024, false);
  assert.deepEqual(legacy512, {
    preloadMarginTiles: 1, retainMarginTiles: 2,
    preloadMarginMeters: 512, retainMarginMeters: 1024,
  });
  assert.deepEqual(legacy1024, {
    preloadMarginTiles: 1, retainMarginTiles: 2,
    preloadMarginMeters: 1024, retainMarginMeters: 2048,
  });

  const matched512 = resolveTileBenchmarkStreamMargins(512, true);
  const matched1024 = resolveTileBenchmarkStreamMargins(1024, true);
  assert.deepEqual(matched512, legacy512);
  assert.deepEqual(matched1024, {
    preloadMarginTiles: 0.5, retainMarginTiles: 1,
    preloadMarginMeters: 512, retainMarginMeters: 1024,
  });
  assert.equal(parseTileStreamingCliArgs(['--compare-tile-sizes', '--no-save']).matchPhysicalMargins, false);
  assert.equal(parseTileStreamingCliArgs(['--compare-tile-sizes', '--match-physical-margins', '--no-save']).matchPhysicalMargins, true);
});

test('Full 4,096 m × 4,096 m 1,024 m bake passes TilePackVerifier cleanly (0 seam defects, BVH/theme/determinism)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-tkt028-1024m-verify-'));
  const pack512Path = path.join(tmpDir, 'pack-512m.sqlite');
  const pack1024Path = path.join(tmpDir, 'pack-1024m.sqlite');

  const { geoJson } = buildSynthetic4096mGeoJson(512);
  const grid512 = createHengeloStudyGrid(512, 64);
  const grid1024 = createHengeloStudyGrid(1024, 64);
  const snapshotId = 'synthetic-4096m-verify';
  const sourceSha256 = 'e'.repeat(64);

  const ingested512 = ingestCanonicalStudyGeoJson(geoJson, grid512);
  const ingested1024 = ingestCanonicalStudyGeoJson(geoJson, grid1024);

  try {
    const bake1024 = bakeStudyRegionTilesToSqlite({
      ingested: ingested1024,
      outPath: pack1024Path,
      snapshotId,
      sourceSha256,
      batchDimension: 2,
      includeBvh: true,
      theme: MAP_THEMES.tactical,
    });
    assert.equal(bake1024.grid.cols, 4);
    assert.equal(bake1024.grid.rows, 4);
    assert.equal(bake1024.grid.tileSizeMeters, 1024);
    assert.equal(bake1024.tileCounts.totalTiles, 16);

    const report1024 = verifyBakedTilePackAgainstIngested({
      packPath: pack1024Path,
      ingested: ingested1024,
      expectedSnapshotId: snapshotId,
      expectedSourceSha256: sourceSha256,
      allowCustomSnapshot: true,
      checkDeterminism: true,
      includeBvh: true,
    });
    assert.equal(report1024.isValid, true, `1024m verifier failures: ${report1024.failures.join('; ')}`);
    assert.equal(report1024.seamReport.internalSeamsChecked, 24);
    assert.equal(report1024.seamReport.defects.length, 0);
    assert.equal(report1024.determinismCheck.checked, true);
    assert.equal(report1024.determinismCheck.passed, true);
    assert.ok(report1024.bvhInspectionCheck.samplesAttempted > 0);
    assert.equal(report1024.bvhInspectionCheck.samplesPassed, report1024.bvhInspectionCheck.samplesAttempted);
    assert.equal(report1024.themeSwapChecks.every((t) => t.passed), true);
    assert.equal(report1024.attributeAndInstanceChecks.sleeperInstancedParity, true);

    const bake512 = bakeStudyRegionTilesToSqlite({
      ingested: ingested512,
      outPath: pack512Path,
      snapshotId,
      sourceSha256,
      batchDimension: 4,
      includeBvh: true,
      theme: MAP_THEMES.tactical,
    });
    assert.equal(bake512.tileCounts.totalTiles, 64);
    assert.ok(bake1024.tileCounts.totalTriangles > 0 && bake512.tileCounts.totalTriangles > 0);
  } finally {
    disposeIngestedStudyRegionPlans(ingested512);
    disposeIngestedStudyRegionPlans(ingested1024);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TileStreamManager adapts boundary overlay and evicts/reloads repeatedly with matched 1,024m physical margins', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-tkt028-1024m-stream-'));
  const pack512Path = path.join(tmpDir, 'stream-512m.sqlite');
  const pack1024Path = path.join(tmpDir, 'stream-1024m.sqlite');
  const { geoJson } = buildSynthetic4096mGeoJson(512);
  const grid512 = createHengeloStudyGrid(512, 64);
  const grid1024 = createHengeloStudyGrid(1024, 64);
  const snapshotId = 'synthetic-4096m-stream';
  const sourceSha256 = 'f'.repeat(64);

  const ingested512 = ingestCanonicalStudyGeoJson(geoJson, grid512);
  const ingested1024 = ingestCanonicalStudyGeoJson(geoJson, grid1024);

  try {
    bakeStudyRegionTilesToSqlite({
      ingested: ingested512,
      outPath: pack512Path,
      snapshotId,
      sourceSha256,
      batchDimension: 4,
      includeBvh: true,
    });
    bakeStudyRegionTilesToSqlite({
      ingested: ingested1024,
      outPath: pack1024Path,
      snapshotId,
      sourceSha256,
      batchDimension: 2,
      includeBvh: true,
    });
  } finally {
    disposeIngestedStudyRegionPlans(ingested512);
    disposeIngestedStudyRegionPlans(ingested1024);
  }

  const srv512 = await startCustomTileServer(pack512Path, snapshotId, sourceSha256);
  const srv1024 = await startCustomTileServer(pack1024Path, snapshotId, sourceSha256);

  try {
    // 1) Boundary overlay must preserve its THREE.Group reference while switching 512m vs 1024m
    const mgr1024SameMargin = new TileStreamManager({
      apiBaseUrl: srv1024.baseUrl,
      preloadMarginTiles: 1,
      retainMarginTiles: 2,
      decodeClient: createTileDecodeClient({ forceInlineDecode: true }),
    });
    const overlayGroupBeforeInit = mgr1024SameMargin.tileBoundaryOverlay;
    const meta1024 = await mgr1024SameMargin.initialize();
    assert.equal(meta1024.tileSizeMeters, 1024);
    assert.equal(mgr1024SameMargin.tileBoundaryOverlay, overlayGroupBeforeInit);
    assert.equal(mgr1024SameMargin.getDiagnostics().totalGridTiles, 16);

    // Hop NW -> SE with hopZoom=2.8 viewport (~514m x 321m ground window around [-1300,-1300] and [1300,1300])
    const runNwSeHops = async (mgr: TileStreamManager) => {
      mgr.updateViewport({ minX: -1560, maxX: -1040, minZ: -1460, maxZ: -1140, focusX: -1300, focusZ: -1300, cameraZoom: 2.8 });
      await mgr.waitForIdle();
      mgr.updateViewport({ minX: 1040, maxX: 1560, minZ: 1140, maxZ: 1460, focusX: 1300, focusZ: 1300, cameraZoom: 2.8 });
      await mgr.waitForIdle();
      return mgr.getDiagnostics();
    };

    const mgr512 = new TileStreamManager({
      apiBaseUrl: srv512.baseUrl,
      preloadMarginTiles: 1,
      retainMarginTiles: 2,
      decodeClient: createTileDecodeClient({ forceInlineDecode: true }),
    });
    await mgr512.initialize();

    const diag512 = await runNwSeHops(mgr512);
    const diag1024Retain2 = await runNwSeHops(mgr1024SameMargin);

    // At 512m (retain=2 -> 1,024m ring), all NW tiles evict on SE hop;
    // at 1,024m (retain=2 -> 2,048m ring), center-diagonal overlap tile stays retained (evicted=3, loaded=5)
    assert.ok(diag512.evictedTilesTotal > diag1024Retain2.evictedTilesTotal, `Expected 512m eviction > 1024m retain=2 eviction (${diag512.evictedTilesTotal} vs ${diag1024Retain2.evictedTilesTotal})`);
    assert.equal(diag1024Retain2.evictedTilesTotal, 3);
    assert.equal(diag1024Retain2.loadedTiles, 5);

    // Matched 512m preload / 1,024m retain: fractional margins are supported by AABB selection.
    const matched1024 = resolveTileBenchmarkStreamMargins(1024, true);
    const mgr1024PhysicalParity = new TileStreamManager({
      apiBaseUrl: srv1024.baseUrl,
      preloadMarginTiles: matched1024.preloadMarginTiles,
      retainMarginTiles: matched1024.retainMarginTiles,
      decodeClient: createTileDecodeClient({ forceInlineDecode: true }),
    });
    await mgr1024PhysicalParity.initialize();
    const diag1024Retain1 = await runNwSeHops(mgr1024PhysicalParity);
    assert.equal(diag1024Retain1.evictedTilesTotal, 4);
    assert.equal(diag1024Retain1.loadedTiles, 4);
    assert.ok(diag1024Retain1.evictedTilesTotal > diag1024Retain2.evictedTilesTotal);
    assert.ok(diag1024Retain1.loadedTiles < diag1024Retain2.loadedTiles);
    assert.equal(diag1024Retain1.preloadMarginTiles, 0.5);
    assert.equal(diag1024Retain1.retainMarginTiles, 1);

    // Every SE revisit must return the same settled geometry/BVH/mesh footprint.
    // Check repeated reloading rather than only a single successful eviction.
    for (let cycle = 0; cycle < 5; cycle++) {
      const revisit = await runNwSeHops(mgr1024PhysicalParity);
      for (const field of [
        'loadedTiles', 'tileCpuGeometryBytes', 'tileBvhBytes',
        'activeTileGeometries', 'activeTileBvhs', 'loadedMeshCount',
      ] as const) {
        assert.equal(revisit[field], diag1024Retain1[field], `SE cycle ${cycle + 1}: ${field} changed`);
      }
    }
    assert.ok(mgr1024PhysicalParity.getDiagnostics().evictedTilesTotal >= 24);

    mgr512.dispose();
    mgr1024SameMargin.dispose();
    mgr1024PhysicalParity.dispose();
    assert.equal(mgr1024PhysicalParity.getDiagnostics().activeTileGeometries, 0);
    assert.equal(mgr1024PhysicalParity.getDiagnostics().activeTileBvhs, 0);
  } finally {
    await srv512.close();
    await srv1024.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
