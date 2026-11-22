import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  TWENTE_FULL_CONFIG,
  TWENTE_PILOT_CONFIG,
  createRegionalMosaicPlan,
  getRegionalMosaicPreset,
  type RegionalMosaicIndex,
  type RegionalMosaicShard,
} from './tiling/RegionalMosaicPlan';
import {
  buildRegionalMosaicDryRunReport,
  formatRegionalMosaicDryRunMarkdown,
} from './tiling/RegionalMosaicDryRun';
import {
  BAKE_SCHEMA_VERSION,
  CANONICAL_HENGELO_SNAPSHOT_ID,
  CANONICAL_HENGELO_SOURCE_SHA256,
  DEFAULT_PROJECTION_ID,
  computeLodPolicyHash,
  type TileManifestEntry,
} from './tiling/TilePackContract';
import { encodeBuiltTileToBinary, decodeTileBinary } from './tiling/TileBinaryCodec';
import { deflateTilePayload, sha256Hex } from '../server/tiles/TileCompression';
import { TilePackSqliteWriter } from '../server/tiles/TilePackSqliteStore';
import {
  DEFAULT_MAX_OPEN_SHARD_HANDLES,
  createRegionalMosaicHttpHandler,
} from '../server/tiles/RegionalMosaicHttpHandler';
import {
  cleanupOrphanedShardStagingFiles,
  inspectExistingRegionalShard,
  parseRegionalPilotBakeArgs,
  runRegionalMosaicDryRun,
} from '../../scripts/bake-regional-pilot';
import { verifyPartialRegionalShards } from '../../scripts/verify-regional-mosaic';
import { TileStreamManager } from './tiling/TileStreamManager';
import { MAP_THEMES } from '../styles/mapThemes';
import { GeometryBuilder, type BuiltSceneGeometry } from './GeometryBuilder';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { resolveCameraZoomPolicy } from '../scene/cameraZoomPolicy';

function createMinimalEmptyBuiltScene(): BuiltSceneGeometry {
  const provider = new LocalGeoJsonProvider();
  const emptyData = provider.parseGeoJson(
    { type: 'FeatureCollection', features: [] },
    'SyntheticEmptyTile',
    [6.729032, 52.281848],
    512
  );
  emptyData.bounds = {
    minX: -512,
    maxX: 512,
    minZ: -512,
    maxZ: 512,
    widthMeters: 1024,
    depthMeters: 1024,
  };
  const builder = new GeometryBuilder({ initialCameraZoom: 1.0 });
  return builder.buildScene(emptyData, MAP_THEMES.tactical);
}

let cachedEmptyScene: BuiltSceneGeometry | null = null;
function getReusableEmptyScene(): BuiltSceneGeometry {
  if (!cachedEmptyScene) {
    cachedEmptyScene = createMinimalEmptyBuiltScene();
  }
  return cachedEmptyScene;
}

function writeSyntheticShardPack(shard: RegionalMosaicShard, outPath: string): void {
  const scene = getReusableEmptyScene();
  const [originEasting, originNorthing] = shard.grid.projection.localToUtm(0, 0);
  const lodPolicyHash = computeLodPolicyHash({
    projectionId: DEFAULT_PROJECTION_ID,
    tileSizeMeters: shard.grid.tileSizeMeters,
    collarMeters: shard.grid.collarMeters,
    lod: 0,
    includeBvh: false,
  });

  const writer = new TilePackSqliteWriter(outPath, {
    snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
    sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
    projectionId: DEFAULT_PROJECTION_ID,
    bakeSchemaVersion: BAKE_SCHEMA_VERSION,
    lodPolicyHash,
    compression: 'deflate',
    tileSizeMeters: shard.grid.tileSizeMeters,
    collarMeters: shard.grid.collarMeters,
    studyOriginEasting: originEasting,
    studyOriginNorthing: originNorthing,
    gridCols: shard.grid.cols,
    gridRows: shard.grid.rows,
    minTx: shard.grid.minTx,
    maxTx: shard.grid.maxTx,
    minTy: shard.grid.minTy,
    maxTy: shard.grid.maxTy,
    createdAtIso: '2026-11-22T00:00:00.000Z',
  });

  try {
    const items = shard.grid.tiles.map((tile) => {
      const raw = encodeBuiltTileToBinary({
        tile,
        scene,
        lod: 0,
        includeBvh: false,
      });
      const compressed = deflateTilePayload(raw, 1);
      const manifest: TileManifestEntry = {
        lod: 0,
        tx: tile.tx,
        ty: tile.ty,
        minEasting: tile.utmBounds.minEasting,
        maxEasting: tile.utmBounds.maxEasting,
        minNorthing: tile.utmBounds.minNorthing,
        maxNorthing: tile.utmBounds.maxNorthing,
        tileCenterX: (tile.localBounds.minX + tile.localBounds.maxX) / 2,
        tileCenterZ: (tile.localBounds.minZ + tile.localBounds.maxZ) / 2,
        overhangMinX: -512,
        overhangMaxX: 512,
        overhangMinY: -1,
        overhangMaxY: 1,
        overhangMinZ: -512,
        overhangMaxZ: 512,
        triCount: 0,
        vertexCount: 0,
        featureCount: 0,
        isEmpty: true,
        hasBvh: false,
        rawBytes: raw.byteLength,
        compressedBytes: compressed.byteLength,
        contentHash: sha256Hex(compressed),
      };
      return { manifest, compressedPayload: compressed };
    });
    writer.writeTileBatch(items);
    writer.finalize('2026-11-22T00:00:01.000Z');
  } catch (err) {
    writer.abort();
    throw err;
  }
}

function invokeMockResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown = null;
  const res: any = {
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (payload: unknown) => {
      body = payload;
      return res;
    },
    send: (payload: unknown) => {
      body = payload;
      return res;
    },
    end: () => res,
  };
  return {
    res,
    getResult: () => ({ statusCode, headers, body }),
  };
}

test('TKT-034: TWENTE_FULL_CONFIG 48x40 footprint aligns 1:1 with pilot shards and covers all Twente towns', () => {
  const plan = createRegionalMosaicPlan(TWENTE_FULL_CONFIG);
  assert.equal(plan.grid.cols, 48);
  assert.equal(plan.grid.rows, 40);
  assert.equal(plan.grid.tiles.length, 1920);
  assert.equal(plan.shards.length, 120);
  assert.equal(plan.grid.minTx, 313);
  assert.equal(plan.grid.maxTx, 360);
  assert.equal(plan.grid.minTy, 5639);
  assert.equal(plan.grid.maxTy, 5678);
  assert.equal(plan.grid.studyUtmBounds.minEasting, 320512);
  assert.equal(plan.grid.studyUtmBounds.maxEasting, 369664);
  assert.equal(plan.grid.studyUtmBounds.minNorthing, 5774336);
  assert.equal(plan.grid.studyUtmBounds.maxNorthing, 5815296);

  const report = buildRegionalMosaicDryRunReport(plan);
  assert.equal(report.pilotAlignment.exactShardMatches, 16);
  assert.equal(report.pilotAlignment.pilotShardCount, 16);
  assert.equal(report.grid.internalShardInterfaces, 218);
  assert.equal(report.grid.fourWayShardJunctions, 99);

  // Every required Twente town must be both inside the grid AND inside the Overijssel OSM extract
  const requiredTowns = [
    'Enschede',
    'Hengelo',
    'Almelo',
    'Oldenzaal',
    'Haaksbergen',
    'Rijssen',
    'Denekamp',
  ];
  for (const name of requiredTowns) {
    const entry = report.settlements.find((s) => s.name === name);
    assert.ok(entry, `Missing settlement check for ${name}`);
    assert.equal(entry.inGrid, true, `${name} must lie inside 48x40 grid`);
    assert.equal(entry.inOverijsselExtract, true, `${name} must lie inside Overijssel OSM extract`);
    assert.ok(entry.shardId, `${name} must map to a valid shard ID`);
  }

  // Rectangular coverage must be explicitly distinguished from Overijssel extract availability
  const ov = report.overijsselSourceCoverage;
  assert.equal(
    ov.tiles.insideOverijssel + ov.tiles.straddlesBoundary + ov.tiles.outsideOverijssel,
    1920
  );
  assert.ok(ov.tiles.outsideOverijssel > 0, 'Expected outside-Overijssel border tiles to be explicitly counted');
  assert.equal(
    ov.shards.insideOverijssel + ov.shards.straddlesBoundary + ov.shards.outsideOverijssel,
    120
  );
  assert.equal(ov.shards.outsideOverijssel, 15);
  assert.equal(report.estimates.isEstimate, true);

  const md = formatRegionalMosaicDryRunMarkdown(report);
  assert.match(md, /ESTIMATES ONLY/);
  assert.match(md, /Enschede/);
  assert.match(md, /Denekamp/);
});

test('TKT-034: CLI preset/dry-run parsing preserves pilot defaults and writes reproducible dry-run artifacts without mutating outDir', () => {
  const defaultArgs = parseRegionalPilotBakeArgs([]);
  assert.equal(defaultArgs.config.cols, TWENTE_PILOT_CONFIG.cols);
  assert.equal(defaultArgs.config.rows, TWENTE_PILOT_CONFIG.rows);
  assert.ok(defaultArgs.outDir.endsWith(path.join('data', 'osm', 'twente-pilot-1024m')));
  assert.equal(defaultArgs.dryRun, false);
  assert.equal(defaultArgs.recoverCorrupt, false);

  const fullArgs = parseRegionalPilotBakeArgs([
    '--preset=twente-full',
    '--dry-run',
    '--shards=r05-c07,r06-c08',
    '--recover-corrupt',
  ]);
  assert.equal(fullArgs.config.cols, 48);
  assert.equal(fullArgs.config.rows, 40);
  assert.ok(fullArgs.outDir.endsWith(path.join('data', 'osm', 'twente-full-1024m')));
  assert.equal(fullArgs.dryRun, true);
  assert.equal(fullArgs.recoverCorrupt, true);
  assert.deepEqual(fullArgs.shardIds, ['r05-c07', 'r06-c08']);

  assert.throws(() => getRegionalMosaicPreset('nonexistent-preset'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkt034-dryrun-'));
  try {
    const nonExistentOutDir = path.join(tmpDir, 'twente-full-1024m');
    const jsonPath = path.join(tmpDir, 'plan.json');
    const mdPath = path.join(tmpDir, 'plan.md');
    const report = runRegionalMosaicDryRun({
      config: TWENTE_FULL_CONFIG,
      outDir: nonExistentOutDir,
      shardIds: ['r05-c07', 'r06-c08'],
      reportOut: jsonPath,
      markdownOut: mdPath,
    });
    assert.equal(fs.existsSync(nonExistentOutDir), false, 'Dry-run must not create outDir');
    assert.equal(fs.existsSync(jsonPath), true);
    assert.equal(fs.existsSync(mdPath), true);
    assert.equal(report.shards.length, 2);
    assert.equal(report.existingOutputScan.existingShardFiles, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TKT-034: RegionalMosaicHttpHandler caps open SQLite handles across a full 120-shard (1,920-tile) mosaic and supports TileStreamManager eviction', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkt034-120shards-'));
  const mosaicDir = path.join(tmpDir, 'twente-full-1024m');
  fs.mkdirSync(mosaicDir, { recursive: true });

  const plan = createRegionalMosaicPlan(TWENTE_FULL_CONFIG);
  try {
    for (const shard of plan.shards) {
      writeSyntheticShardPack(shard, path.join(mosaicDir, `${shard.id}.sqlite`));
    }
    const index: RegionalMosaicIndex = {
      schemaVersion: 1,
      config: plan.config,
      snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
      sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
      shards: plan.shards.map((s) => ({ id: s.id, file: `${s.id}.sqlite` })),
    };
    const indexPath = path.join(mosaicDir, 'mosaic.json');
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');

    assert.equal(DEFAULT_MAX_OPEN_SHARD_HANDLES, 16);
    const maxHandles = 6;
    const handler = createRegionalMosaicHttpHandler({
      indexPath,
      maxOpenShardHandles: maxHandles,
    });

    try {
      // 1. Manifest load must scan all 120 shards and close every handle immediately
      const manifestMock = invokeMockResponse();
      await handler.manifestHandler({} as any, manifestMock.res);
      const manifestResult = manifestMock.getResult();
      assert.equal(manifestResult.statusCode, 200);
      const manifestBody = manifestResult.body as any;
      assert.equal(manifestBody.tiles.length, 1920);
      assert.equal(manifestBody.metadata.gridCols, 48);
      assert.equal(manifestBody.metadata.gridRows, 40);
      assert.equal(
        handler.getOpenShardHandleCount(),
        0,
        'Manifest load must not retain open SQLite shard handles'
      );

      // 2. Serve tiles from 24 distinct shards and verify open handle count stays <= maxHandles
      const sampledShards = plan.shards.filter((_, idx) => idx % 5 === 0); // 24 distinct shards
      assert.equal(sampledShards.length, 24);
      for (const shard of sampledShards) {
        const firstTile = shard.grid.tiles[0];
        const tileMock = invokeMockResponse();
        await handler.tilePayloadHandler(
          {
            params: {
              lod: '0',
              tx: String(firstTile.tx),
              ty: String(firstTile.ty),
            },
            headers: {},
          } as any,
          tileMock.res
        );
        const tileRes = tileMock.getResult();
        assert.equal(tileRes.statusCode, 200, `Expected 200 for shard ${shard.id}`);
        assert.ok(Buffer.isBuffer(tileRes.body));
        const decoded = decodeTileBinary(
          new Uint8Array(tileRes.body.buffer, tileRes.body.byteOffset, tileRes.body.byteLength)
        );
        assert.equal(decoded.tx, firstTile.tx);
        assert.equal(decoded.ty, firstTile.ty);
        assert.ok(
          handler.getOpenShardHandleCount() <= maxHandles,
          `Open shard handles (${handler.getOpenShardHandleCount()}) exceeded cap (${maxHandles})`
        );
      }
      assert.equal(handler.getOpenShardHandleCount(), maxHandles);

      // 3. Verify TileStreamManager handles the 1,920-tile manifest, conservative minZoom=0.15, and eviction
      const mockFetch = async (input: string | URL): Promise<Response> => {
        const url = String(input);
        if (url.endsWith('/manifest')) {
          return new Response(JSON.stringify(manifestBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const m = url.match(/\/(\d+)\/(-?\d+)\/(-?\d+)$/);
        assert.ok(m, `Unexpected tile URL: ${url}`);
        const tileMock = invokeMockResponse();
        await handler.tilePayloadHandler(
          {
            params: { lod: m[1], tx: m[2], ty: m[3] },
            headers: {},
          } as any,
          tileMock.res
        );
        const r = tileMock.getResult();
        const buf = r.body as Buffer;
        const copy = new Uint8Array(buf.byteLength);
        copy.set(buf);
        return new Response(copy, {
          status: r.statusCode,
          headers: { 'content-type': 'application/octet-stream' },
        });
      };

      const zoomPolicy = resolveCameraZoomPolicy({ isRegionalStreaming: true });
      assert.equal(zoomPolicy.minZoom, 0.15);

      const manager = new TileStreamManager({
        apiBaseUrl: '/api/tiles-region',
        fetchFn: mockFetch as any,
        preloadMarginTiles: 0.5,
        retainMarginTiles: 1,
        maxCommitsPerFrame: 32,
        initialTheme: MAP_THEMES.tactical,
        initialCameraZoom: 1.5,
      });

      try {
        const meta = await manager.initialize();
        assert.equal(meta.gridCols * meta.gridRows, 1920);
        assert.equal(manager.getDiagnostics().activeMosaicName, 'twente-full-1024m');

        const flushStreamManager = async (timeoutMs = 5000): Promise<void> => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            manager.tick();
            const d = manager.getDiagnostics();
            if (
              d.loadingTiles === 0 &&
              d.queuedTiles === 0 &&
              d.readyToCommitTiles === 0
            ) {
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error('Timed out waiting for TileStreamManager to settle');
        };

        // Focus near region center, load tiles, then jump 20 km east to verify eviction
        manager.updateViewport({
          minX: -600,
          maxX: 600,
          minZ: -600,
          maxZ: 600,
          focusX: 0,
          focusZ: 0,
          cameraZoom: 1.5,
        });
        await flushStreamManager();
        const diagCenter = manager.getDiagnostics();
        assert.ok(diagCenter.loadedTiles > 0 && diagCenter.loadedTiles <= 25);

        // Jump 20 km east (Enschede side) -> all previous center tiles must evict
        manager.updateViewport({
          minX: 19400,
          maxX: 20600,
          minZ: 5400,
          maxZ: 6600,
          focusX: 20000,
          focusZ: 6000,
          cameraZoom: 1.5,
        });
        await flushStreamManager();
        const diagEast = manager.getDiagnostics();
        assert.ok(diagEast.loadedTiles > 0 && diagEast.loadedTiles <= 25);
        assert.ok(diagEast.evictedTilesTotal >= diagCenter.loadedTiles);
        assert.ok(
          handler.getOpenShardHandleCount() <= maxHandles,
          'Streaming tiles via TileStreamManager must respect bounded shard handle cap'
        );
      } finally {
        manager.dispose();
      }
    } finally {
      handler.close();
      assert.equal(handler.getOpenShardHandleCount(), 0);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TKT-034: shard reuse validation distinguishes valid, corrupt/incomplete, and incompatible-grid shards, and partial verification validates bounded experimental subsets', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkt034-recovery-'));
  try {
    const plan = createRegionalMosaicPlan(TWENTE_FULL_CONFIG);
    const hengeloShard = plan.shards.find((s) => s.id === 'r05-c07')!;
    const enschedeShard = plan.shards.find((s) => s.id === 'r06-c08')!;
    const otherShard = plan.shards.find((s) => s.id === 'r00-c00')!;

    const hengeloPath = path.join(tmpDir, `${hengeloShard.id}.sqlite`);
    const enschedePath = path.join(tmpDir, `${enschedeShard.id}.sqlite`);
    writeSyntheticShardPack(hengeloShard, hengeloPath);
    writeSyntheticShardPack(enschedeShard, enschedePath);

    // 1. Valid shards pass both resume inspection and partial experimental verification
    const validRes = inspectExistingRegionalShard(
      hengeloPath,
      hengeloShard,
      CANONICAL_HENGELO_SOURCE_SHA256
    );
    assert.deepEqual(validRes, { status: 'valid', tileCount: 16 });

    const partialSummary = verifyPartialRegionalShards({
      shardsDir: tmpDir,
      config: TWENTE_FULL_CONFIG,
    });
    assert.equal(partialSummary.partial, true);
    assert.equal(partialSummary.verifiedShards, 2);
    assert.equal(partialSummary.plannedShards, 120);
    assert.equal(partialSummary.tiles, 32);
    assert.deepEqual(partialSummary.verifiedShardIds, ['r05-c07', 'r06-c08']);

    // 2. Orphaned staging cleanup removes only matching shard staging files
    const orphanA = path.join(tmpDir, 'r05-c07.sqlite.staging-9999-123.sqlite');
    const orphanB = path.join(tmpDir, 'r05-c07.sqlite.staging-9999-123.sqlite-wal');
    const otherOrphan = path.join(tmpDir, 'r06-c08.sqlite.staging-8888-456.sqlite');
    fs.writeFileSync(orphanA, 'stale');
    fs.writeFileSync(orphanB, 'stale-wal');
    fs.writeFileSync(otherOrphan, 'other');

    const cleaned = cleanupOrphanedShardStagingFiles(tmpDir, 'r05-c07');
    assert.equal(cleaned.length, 2);
    assert.equal(fs.existsSync(orphanA), false);
    assert.equal(fs.existsSync(orphanB), false);
    assert.equal(fs.existsSync(otherOrphan), true);
    fs.rmSync(otherOrphan, { force: true });

    // 3. Bit-corrupted tile blob is detected as corrupt_or_incomplete AND fails partial verify
    const corruptDb = new DatabaseSync(hengeloPath);
    const firstTile = hengeloShard.grid.tiles[0];
    const row = corruptDb
      .prepare('SELECT payload FROM tiles WHERE lod = 0 AND tx = ? AND ty = ?')
      .get(firstTile.tx, firstTile.ty) as { payload: Uint8Array };
    const mutated = new Uint8Array(row.payload);
    mutated[0] ^= 0xff;
    corruptDb
      .prepare('UPDATE tiles SET payload = ? WHERE lod = 0 AND tx = ? AND ty = ?')
      .run(mutated, firstTile.tx, firstTile.ty);
    corruptDb.close();

    const corruptRes = inspectExistingRegionalShard(
      hengeloPath,
      hengeloShard,
      CANONICAL_HENGELO_SOURCE_SHA256
    );
    assert.equal(corruptRes.status, 'corrupt_or_incomplete');
    assert.match(corruptRes.reason, /content_hash_mismatch/);
    assert.throws(() =>
      verifyPartialRegionalShards({
        shardsDir: tmpDir,
        config: TWENTE_FULL_CONFIG,
        shardIds: ['r05-c07'],
      })
    );

    // 4. Truncated non-SQLite junk file is detected as corrupt_or_incomplete
    fs.writeFileSync(hengeloPath, 'not a sqlite file');
    const junkRes = inspectExistingRegionalShard(
      hengeloPath,
      hengeloShard,
      CANONICAL_HENGELO_SOURCE_SHA256
    );
    assert.equal(junkRes.status, 'corrupt_or_incomplete');

    // 5. Valid shard from a DIFFERENT grid coordinate is flagged incompatible_grid_or_source
    //    (must never be silently overwritten even with --recover-corrupt)
    writeSyntheticShardPack(otherShard, hengeloPath);
    const wrongGridRes = inspectExistingRegionalShard(
      hengeloPath,
      hengeloShard,
      CANONICAL_HENGELO_SOURCE_SHA256
    );
    assert.equal(wrongGridRes.status, 'incompatible_grid_or_source');
    assert.throws(() =>
      verifyPartialRegionalShards({
        shardsDir: tmpDir,
        config: TWENTE_FULL_CONFIG,
        shardIds: ['r05-c07'],
      })
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (cachedEmptyScene) {
      cachedEmptyScene.dispose();
      cachedEmptyScene = null;
    }
  }
});
