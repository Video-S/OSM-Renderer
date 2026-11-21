import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MAP_THEMES } from '../styles/mapThemes';
import {
  bakeHengeloTilesFromStore,
  bakeStudyRegionTilesToSqlite,
  disposeIngestedStudyRegionPlans,
} from '../server/tiles/OfflineHengeloTileBaker';
import {
  TilePackSqliteStore,
  TilePackSqliteWriter,
} from '../server/tiles/TilePackSqliteStore';
import {
  verifyBakedTilePackAgainstIngested,
  verifyHengeloTilePackFromStore,
} from '../server/tiles/TilePackVerifier';
import { resolveOverijsselIndexPath } from '../server/osm/overijsselConfig';
import {
  createAlignedStudyGrid,
  type StudyGridSpec,
} from './tiling/TileGrid';
import { ingestCanonicalStudyGeoJson } from './tiling/TiledStudyPipeline';
import {
  BAKE_SCHEMA_VERSION,
  DEFAULT_PROJECTION_ID,
  TilePackCorruptError,
  TilePackIncompatibleError,
  TilePackMissingError,
} from './tiling/TilePackContract';

function buildMultiTileCrossingStudyGeoJson(grid: StudyGridSpec) {
  const toLonLat = (x: number, z: number): [number, number] => grid.projection.toGeo(x, z);
  const ringToLonLat = (pts: Array<[number, number]>) => [pts.map(([x, z]) => toLonLat(x, z))];
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'way/landuse-res',
        properties: { id: 'way/landuse-res', landuse: 'residential', name: 'Centrum' },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [-320, -320],
            [320, -320],
            [320, 320],
            [-320, 320],
            [-320, -320],
          ]),
        },
      },
      {
        type: 'Feature',
        id: 'way/parking-cross',
        properties: { id: 'way/parking-cross', amenity: 'parking', surface: 'asphalt' },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [-90, 40],
            [90, 40],
            [90, 95],
            [-90, 95],
            [-90, 40],
          ]),
        },
      },
      {
        type: 'Feature',
        id: 'way/pitch-cross',
        properties: { id: 'way/pitch-cross', leisure: 'pitch', sport: 'soccer' },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [-180, -45],
            [-110, -45],
            [-110, 45],
            [-180, 45],
            [-180, -45],
          ]),
        },
      },
      {
        type: 'Feature',
        id: 'way/forest-cross',
        properties: { id: 'way/forest-cross', landuse: 'forest', leaf_type: 'mixed' },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [95, -90],
            [210, -90],
            [210, 90],
            [95, 90],
            [95, -90],
          ]),
        },
      },
      {
        type: 'Feature',
        id: 'way/water-cross',
        properties: { id: 'way/water-cross', natural: 'water', water: 'pond' },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [-70, -170],
            [70, -170],
            [70, -110],
            [-70, -110],
            [-70, -170],
          ]),
        },
      },
      {
        type: 'Feature',
        id: 'way/road-primary-w',
        properties: { id: 'way/road-primary-w', highway: 'primary', name: 'Enschedesestraat' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-450, -12), toLonLat(-2, -4), toLonLat(0, -4)],
        },
      },
      {
        type: 'Feature',
        id: 'way/road-primary-e',
        properties: { id: 'way/road-primary-e', highway: 'primary', name: 'Enschedesestraat' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(0, -4), toLonLat(450, -4)],
        },
      },
      {
        type: 'Feature',
        id: 'way/road-res-s',
        properties: { id: 'way/road-res-s', highway: 'residential', name: 'Zuidstraat' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-2, -4), toLonLat(8, 25), toLonLat(8, 420)],
        },
      },
      {
        type: 'Feature',
        id: 'way/bridge-w',
        properties: { id: 'way/bridge-w', highway: 'secondary', name: 'Spoorbrug' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-210, -55), toLonLat(-95, -55)],
        },
      },
      {
        type: 'Feature',
        id: 'way/bridge-span',
        properties: {
          id: 'way/bridge-span',
          highway: 'secondary',
          bridge: 'yes',
          layer: '1',
          name: 'Spoorbrug',
        },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-95, -55), toLonLat(95, -55)],
        },
      },
      {
        type: 'Feature',
        id: 'way/bridge-e',
        properties: { id: 'way/bridge-e', highway: 'secondary', name: 'Spoorbrug' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(95, -55), toLonLat(210, -55)],
        },
      },
      {
        type: 'Feature',
        id: 'way/rail-main-1',
        properties: { id: 'way/rail-main-1', railway: 'rail', electrified: 'contact_line' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-450, -185), toLonLat(-20, -185), toLonLat(0, -185)],
        },
      },
      {
        type: 'Feature',
        id: 'way/rail-main-2',
        properties: { id: 'way/rail-main-2', railway: 'rail', electrified: 'contact_line' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(0, -185), toLonLat(450, -185)],
        },
      },
      {
        type: 'Feature',
        id: 'way/rail-turnout',
        properties: { id: 'way/rail-turnout', railway: 'rail', service: 'siding' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-20, -185), toLonLat(-5, -187.5), toLonLat(40, -195), toLonLat(150, -195)],
        },
      },
      {
        type: 'Feature',
        id: 'way/bldg-seam-owner',
        properties: { id: 'way/bldg-seam-owner', building: 'commercial', name: 'Seam Mall', height: '14' },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [-12, -130],
            [6, -130],
            [6, -110],
            [-12, -110],
            [-12, -130],
          ]),
        },
      },
      {
        type: 'Feature',
        id: 'way/bldg-ne',
        properties: { id: 'way/bldg-ne', building: 'civic', name: 'Town Hall', height: '20' },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [120, -140],
            [150, -140],
            [150, -110],
            [120, -110],
            [120, -140],
          ]),
        },
      },
    ],
  };
}

test('Synthetic 4x4 macro-block bake -> SQLite -> zero-synthesis decode -> SeamValidator & determinism parity', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-m1b-bake-'));
  const packPath = path.join(tmpDir, 'synthetic-tiles.sqlite');

  const grid = createAlignedStudyGrid({
    name: 'synthetic-4x4-m1b',
    centerLonLat: [6.7935, 52.2625],
    cols: 4,
    rows: 4,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const ingested = ingestCanonicalStudyGeoJson(buildMultiTileCrossingStudyGeoJson(grid), grid);
  const snapshotId = 'synthetic-m1b-snapshot';
  const sourceSha256 = 'a'.repeat(64);

  try {
    const bakeReport = bakeStudyRegionTilesToSqlite({
      ingested,
      outPath: packPath,
      snapshotId,
      sourceSha256,
      batchDimension: 2, // 4 macro-blocks of 2x2 tiles each
      includeBvh: true,
      theme: MAP_THEMES.tactical,
    });

    assert.equal(bakeReport.tileCounts.totalTiles, 16);
    assert.equal(bakeReport.macroBlocks.length, 4);
    assert.ok(bakeReport.tileCounts.nonEmptyTiles >= 4);
    assert.ok(bakeReport.dbSizeBytes > 0);
    assert.ok(bakeReport.sizeStats.compressionRatio > 0 && bakeReport.sizeStats.compressionRatio < 1);

    // Non-overlapping stage timing consistency invariants
    const t = bakeReport.timingsMs;
    assert.equal(t.totalBakeMs, t.totalEndToEndMs);
    assert.ok(
      t.totalEndToEndMs >= t.ingestMs + t.tileBakePhaseMs - 0.1,
      `Expected totalEndToEndMs (${t.totalEndToEndMs}) >= ingestMs (${t.ingestMs}) + tileBakePhaseMs (${t.tileBakePhaseMs})`
    );
    assert.ok(
      t.tileBakePhaseMs >= t.tileSynthesisAndEncodeMs + t.compressionMs + t.sqliteWriteMs - 2.0,
      `Expected tileBakePhaseMs (${t.tileBakePhaseMs}) >= sub-stages sum`
    );
    assert.ok(
      Math.abs(t.avgTileSynthAndEncodeMs - t.tileSynthesisAndEncodeMs / 16) <= 0.05,
      `Expected avgTileSynthAndEncodeMs (${t.avgTileSynthAndEncodeMs}) == synth+encode / 16`
    );
    assert.ok(
      Math.abs(t.avgTileBakeMs - t.tileBakePhaseMs / 16) <= 0.05,
      `Expected avgTileBakeMs (${t.avgTileBakeMs}) == tileBakePhaseMs / 16`
    );

    const verifyReport = verifyBakedTilePackAgainstIngested({
      packPath,
      ingested,
      expectedSnapshotId: snapshotId,
      expectedSourceSha256: sourceSha256,
      allowCustomSnapshot: true,
      checkDeterminism: true,
      includeBvh: true,
    });

    assert.equal(verifyReport.isValid, true, `Verify failures: ${verifyReport.failures.join('; ')}`);
    assert.equal(verifyReport.seamReport.isValid, true);
    assert.equal(verifyReport.seamReport.defects.length, 0);
    assert.equal(verifyReport.seamReport.internalSeamsChecked, 24);
    assert.equal(verifyReport.determinismCheck.checked, true);
    assert.equal(verifyReport.determinismCheck.passed, true);
    assert.equal(verifyReport.themeSwapChecks.length, 4);
    assert.ok(verifyReport.themeSwapChecks.every((c) => c.passed));
    assert.ok(verifyReport.bvhInspectionCheck.samplesAttempted >= 10);
    assert.equal(verifyReport.bvhInspectionCheck.samplesPassed, verifyReport.bvhInspectionCheck.samplesAttempted);
    assert.equal(verifyReport.attributeAndInstanceChecks.railwayUvAndSwitchAttrPresent, true);
    assert.equal(verifyReport.attributeAndInstanceChecks.sleeperInstancedParity, true);
  } finally {
    disposeIngestedStudyRegionPlans(ingested);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TilePackSqliteStore rejects missing pack, incomplete bake, schema/SHA mismatch, and corrupted blob', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-m1b-compat-'));
  try {
    // 1. Missing file
    assert.throws(
      () => new TilePackSqliteStore(path.join(tmpDir, 'does-not-exist.sqlite')),
      (err: unknown) => err instanceof TilePackMissingError
    );

    // 2. Incomplete bake (`bake_status = 'in_progress'`)
    const incompletePath = path.join(tmpDir, 'incomplete.sqlite');
    const writer = new TilePackSqliteWriter(incompletePath, {
      snapshotId: 'snap-1',
      sourceSha256: 'b'.repeat(64),
      projectionId: DEFAULT_PROJECTION_ID,
      bakeSchemaVersion: BAKE_SCHEMA_VERSION,
      lodPolicyHash: 'lod0-test',
      compression: 'deflate',
      tileSizeMeters: 512,
      collarMeters: 64,
      studyOriginEasting: 349440,
      studyOriginNorthing: 5792512,
      gridCols: 1,
      gridRows: 1,
      minTx: 682,
      maxTx: 682,
      minTy: 11313,
      maxTy: 11313,
      createdAtIso: new Date().toISOString(),
    });
    // Force write without finalizing by copying staging file (plus any WAL sidecars)
    const stagingFiles = fs
      .readdirSync(tmpDir)
      .filter((f) => f.includes('.staging-') && f.endsWith('.sqlite'));
    assert.equal(stagingFiles.length, 1);
    const stagingBase = path.join(tmpDir, stagingFiles[0]);
    const partialCopy = path.join(tmpDir, 'partial-copy.sqlite');
    fs.copyFileSync(stagingBase, partialCopy);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(stagingBase + suffix)) {
        fs.copyFileSync(stagingBase + suffix, partialCopy + suffix);
      }
    }
    const partialDb = new DatabaseSync(partialCopy);
    partialDb.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;');
    partialDb.close();
    writer.abort();

    assert.throws(
      () => new TilePackSqliteStore(partialCopy, { allowCustomSnapshot: true }),
      (err: unknown) =>
        err instanceof TilePackIncompatibleError && err.reason === 'incomplete_bake'
    );

    // 3. Valid pack checked against mismatched SHA-256 and schema version, plus blob corruption
    const validPackPath = path.join(tmpDir, 'valid.sqlite');
    const grid = createAlignedStudyGrid({
      name: 'compat-1x1',
      centerLonLat: [6.7935, 52.2625],
      cols: 1,
      rows: 1,
      tileSizeMeters: 512,
      collarMeters: 64,
    });
    const ingested = ingestCanonicalStudyGeoJson(buildMultiTileCrossingStudyGeoJson(grid), grid);
    try {
      bakeStudyRegionTilesToSqlite({
        ingested,
        outPath: validPackPath,
        snapshotId: 'snap-valid',
        sourceSha256: 'c'.repeat(64),
      });

      assert.throws(
        () =>
          new TilePackSqliteStore(validPackPath, {
            expectedSourceSha256: 'd'.repeat(64),
            allowCustomSnapshot: true,
          }),
        (err: unknown) =>
          err instanceof TilePackIncompatibleError && err.reason === 'source_sha256_mismatch'
      );

      assert.throws(
        () =>
          new TilePackSqliteStore(validPackPath, {
            expectedSourceSha256: 'c'.repeat(64),
            expectedBakeSchemaVersion: '9.9.9',
            allowCustomSnapshot: true,
          }),
        (err: unknown) =>
          err instanceof TilePackIncompatibleError && err.reason === 'schema_version_mismatch'
      );

      // Corrupt compressed payload in SQLite and verify SHA-256 check catches it
      const rawDb = new DatabaseSync(validPackPath);
      const tile = grid.tiles[0];
      const row = rawDb
        .prepare('SELECT payload FROM tiles WHERE lod = 0 AND tx = ? AND ty = ?')
        .get(tile.tx, tile.ty) as { payload: Uint8Array };
      const flipped = Buffer.from(row.payload);
      flipped[0] ^= 0xff;
      rawDb
        .prepare('UPDATE tiles SET payload = ? WHERE lod = 0 AND tx = ? AND ty = ?')
        .run(flipped, tile.tx, tile.ty);
      rawDb.close();

      const store = new TilePackSqliteStore(validPackPath, {
        expectedSourceSha256: 'c'.repeat(64),
        allowCustomSnapshot: true,
      });
      try {
        assert.throws(
          () => store.getTileDecoded(0, tile.tx, tile.ty),
          (err: unknown) =>
            err instanceof TilePackCorruptError && err.reason === 'content_hash_mismatch'
        );
      } finally {
        store.close();
      }
    } finally {
      disposeIngestedStudyRegionPlans(ingested);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

const canonicalIndexPath = resolveOverijsselIndexPath();
test(
  'Canonical 8x8 Hengelo offline tile bake and verification (skipped when offline SQLite missing)',
  { skip: !fs.existsSync(canonicalIndexPath) },
  () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hengelo-m1b-canonical-'));
    const packPath = path.join(tmpDir, 'hengelo-canonical-tiles.sqlite');
    try {
      const { report } = bakeHengeloTilesFromStore({
        indexPath: canonicalIndexPath,
        outPath: packPath,
        batchDimension: 4,
      });
      assert.equal(report.tileCounts.totalTiles, 64);

      const verifyReport = verifyHengeloTilePackFromStore({
        indexPath: canonicalIndexPath,
        packPath,
      });
      assert.equal(verifyReport.isValid, true);
      assert.equal(verifyReport.seamReport.isValid, true);
      assert.equal(verifyReport.seamReport.defects.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
);
