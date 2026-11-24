import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import {
  buildOverijsselSearchIndex,
  evaluateSearchMosaicCoverage,
  normalizeSearchText,
  OverijsselSearchIndexIncompatibleError,
  OverijsselSearchIndexMissingError,
  OverijsselSearchStore,
  type ActiveMosaicCoverageContext,
} from '../server/osm/OverijsselSearchIndex';
import { createSearchDataHandler } from '../server/osm/searchDataHandler';
import {
  OVERIJSSEL_INDEX_SCHEMA_VERSION,
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  OVERIJSSEL_SEARCH_INDEX_SCHEMA_VERSION,
  OVERIJSSEL_SNAPSHOT_ID,
} from '../server/osm/overijsselConfig';
import { geoToUtm32N, RegionalProjection } from './tiling/RegionalProjection';
import type { TileManifestEntry, TilePackMetadata } from './tiling/TilePackContract';

interface SeedSpatialOptions {
  snapshotId?: string;
  snapshotMode?: 'canonical' | 'custom';
  sourceSha256?: string;
}

function createSyntheticSpatialDb(
  sqlitePath: string,
  options: SeedSpatialOptions = {}
): void {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY,
        lon REAL NOT NULL,
        lat REAL NOT NULL,
        tags_json TEXT
      );
      CREATE VIRTUAL TABLE tagged_node_rtree USING rtree(
        id,
        min_lon, max_lon,
        min_lat, max_lat
      );
      CREATE TABLE ways (
        id INTEGER PRIMARY KEY,
        refs_json TEXT NOT NULL,
        tags_json TEXT
      );
      CREATE VIRTUAL TABLE way_rtree USING rtree(
        id,
        min_lon, max_lon,
        min_lat, max_lat
      );
      CREATE TABLE relations (
        id INTEGER PRIMARY KEY,
        members_json TEXT NOT NULL,
        tags_json TEXT
      );
      CREATE VIRTUAL TABLE relation_rtree USING rtree(
        id,
        min_lon, max_lon,
        min_lat, max_lat
      );
    `);

    const insertNode = db.prepare(
      'INSERT INTO nodes (id, lon, lat, tags_json) VALUES (?, ?, ?, ?)'
    );
    const insertNodeRtree = db.prepare(
      'INSERT INTO tagged_node_rtree (id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)'
    );
    const addNode = (
      id: number,
      lon: number,
      lat: number,
      tags: Record<string, string> | null
    ) => {
      insertNode.run(id, lon, lat, tags ? JSON.stringify(tags) : null);
      if (tags) {
        insertNodeRtree.run(id, lon, lon, lat, lat);
      }
    };

    // Places in Twente + 1 outside mosaic border
    addNode(101, 6.7935, 52.2625, { place: 'town', name: 'Hengelo' });
    addNode(102, 6.8937, 52.2215, { place: 'city', name: 'Enschede' });
    addNode(103, 6.6625, 52.3567, { place: 'city', name: 'Almelo' });

    // Railway stations (including hyphenated name for punctuation query check)
    addNode(201, 6.7938, 52.2618, { railway: 'station', name: 'Hengelo' });
    addNode(202, 6.7912, 52.2495, { railway: 'halt', name: 'Hengelo-Zuid' });
    addNode(203, 6.8899, 52.2225, { railway: 'station', name: 'Enschede Centraal' });

    // POIs & diacritic check ("Café Brink" near Hengelo)
    addNode(301, 6.7942, 52.2652, {
      amenity: 'cafe',
      name: 'Café Brink',
      'addr:street': 'Brinkstraat',
      'addr:housenumber': '14',
    });

    // Genuine address node
    addNode(302, 6.7950, 52.2630, {
      'addr:street': 'Enschedesestraat',
      'addr:housenumber': '42',
      'addr:postcode': '7551 EN',
      'addr:city': 'Hengelo',
    });

    // Entry situated on an empty border tile (tile tx=349? Let's place near [6.76, 52.24] mapped as empty in test mosaic)
    addNode(303, 6.7610, 52.2410, {
      amenity: 'shelter',
      name: 'EmptyTile Shelter',
    });

    // Entry well outside the Twente pilot mosaic (Zwolle ~6.083, 52.5168)
    addNode(304, 6.083, 52.5168, {
      place: 'city',
      name: 'Zwolle',
    });

    // Road vertices for split street ways in Hengelo and identical street name in Enschede
    addNode(1001, 6.7920, 52.2626, null);
    addNode(1002, 6.7930, 52.2627, null);
    addNode(1003, 6.7931, 52.2627, null);
    addNode(1004, 6.7942, 52.2628, null);
    addNode(1010, 6.8910, 52.2220, null);
    addNode(1011, 6.8925, 52.2222, null);

    // Building polygon vertices + street-name-bearing building
    addNode(2001, 6.7925, 52.2658, null);
    addNode(2002, 6.7932, 52.2658, null);
    addNode(2003, 6.7932, 52.2662, null);
    addNode(2004, 6.7925, 52.2662, null);

    // Excluded route relation + valid named building relation
    addNode(3001, 6.8935, 52.2216, null);

    const insertWay = db.prepare(
      'INSERT INTO ways (id, refs_json, tags_json) VALUES (?, ?, ?)'
    );
    const insertWayRtree = db.prepare(
      'INSERT INTO way_rtree (id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)'
    );

    // Split primary street in Hengelo (~100 m apart, same 1.5 km cell -> must deduplicate)
    insertWay.run(
      5001,
      JSON.stringify([1001, 1002]),
      JSON.stringify({ highway: 'primary', name: 'Stationsstraat' })
    );
    insertWayRtree.run(5001, 6.7920, 6.7930, 52.2626, 52.2627);

    insertWay.run(
      5002,
      JSON.stringify([1003, 1004]),
      JSON.stringify({ highway: 'residential', name: 'Stationsstraat' })
    );
    insertWayRtree.run(5002, 6.7931, 6.7942, 52.2627, 52.2628);

    // Distinct "Stationsstraat" in Enschede (>8 km away -> must remain separate result!)
    insertWay.run(
      5003,
      JSON.stringify([1010, 1011]),
      JSON.stringify({ highway: 'secondary', name: 'Stationsstraat' })
    );
    insertWayRtree.run(5003, 6.8910, 6.8925, 52.2220, 52.2222);

    // Named building way
    insertWay.run(
      5004,
      JSON.stringify([2001, 2002, 2003, 2004, 2001]),
      JSON.stringify({ building: 'civic', name: 'Stadhuis Hengelo' })
    );
    insertWayRtree.run(5004, 6.7925, 6.7932, 52.2658, 52.2662);

    // Excluded highway detail (traffic signals shouldn't appear as street)
    insertWay.run(
      5005,
      JSON.stringify([1001, 1002]),
      JSON.stringify({ highway: 'traffic_signals', name: 'Signal 42' })
    );
    insertWayRtree.run(5005, 6.7920, 6.7930, 52.2626, 52.2627);

    // Relations: 1 valid landmark building relation + 1 excluded route relation
    const insertRel = db.prepare(
      'INSERT INTO relations (id, members_json, tags_json) VALUES (?, ?, ?)'
    );
    const insertRelRtree = db.prepare(
      'INSERT INTO relation_rtree (id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)'
    );
    insertRel.run(
      6001,
      JSON.stringify([{ type: 'node', ref: 3001, role: 'outer' }]),
      JSON.stringify({
        type: 'multipolygon',
        building: 'church',
        name: 'Grote Kerk Enschede',
      })
    );
    insertRelRtree.run(6001, 6.8933, 6.8937, 52.2214, 52.2218);

    insertRel.run(
      6002,
      JSON.stringify([{ type: 'way', ref: 5001, role: '' }]),
      JSON.stringify({
        type: 'route',
        route: 'bus',
        name: 'Enschede Express Bus Route',
      })
    );
    insertRelRtree.run(6002, 6.7920, 6.7930, 52.2626, 52.2627);

    const insertMeta = db.prepare(
      'INSERT INTO metadata (key, value) VALUES (?, ?)'
    );
    const metaPairs: Array<[string, string]> = [
      ['schema_version', OVERIJSSEL_INDEX_SCHEMA_VERSION],
      ['snapshot_id', options.snapshotId ?? OVERIJSSEL_SNAPSHOT_ID],
      ['snapshot_mode', options.snapshotMode ?? 'custom'],
      ['source_file', 'synthetic-twente.osm.pbf'],
      ['source_sha256', options.sourceSha256 ?? OVERIJSSEL_PBF_EXPECTED_SHA256],
      ['source_md5', '0123456789abcdef0123456789abcdef'],
      ['source_bytes', '123456'],
      ['osm_timestamp_iso', '2026-11-14T21:20:41.000Z'],
      ['attribution', 'Synthetic Test OSM'],
      ['indexed_at_iso', '2026-11-24T00:00:00.000Z'],
      ['node_count', '19'],
      ['tagged_node_count', '10'],
      ['way_count', '5'],
      ['relation_count', '2'],
      ['bbox_min_lon', '6.0'],
      ['bbox_max_lon', '7.0'],
      ['bbox_min_lat', '52.1'],
      ['bbox_max_lat', '52.6'],
    ];
    for (const [k, v] of metaPairs) {
      insertMeta.run(k, v);
    }
  } finally {
    db.close();
  }
}

function buildMockMosaicContext(): ActiveMosaicCoverageContext {
  const [originE, originN] = geoToUtm32N(6.7935, 52.2625);
  const tileSizeMeters = 1024;
  // Cover Hengelo & Enschede across a grid that includes [6.7610, 52.2410] as an empty tile
  const [empE, empN] = geoToUtm32N(6.761, 52.241);
  const empTx = Math.floor(empE / tileSizeMeters);
  const empTy = Math.floor(empN / tileSizeMeters);

  const [hengE, hengN] = geoToUtm32N(6.7935, 52.2625);
  const [ensE, ensN] = geoToUtm32N(6.8937, 52.2215);
  const minTx = Math.min(empTx, Math.floor(hengE / tileSizeMeters), Math.floor(ensE / tileSizeMeters)) - 1;
  const maxTx = Math.max(empTx, Math.floor(hengE / tileSizeMeters), Math.floor(ensE / tileSizeMeters)) + 1;
  const minTy = Math.min(empTy, Math.floor(hengN / tileSizeMeters), Math.floor(ensN / tileSizeMeters)) - 1;
  const maxTy = Math.max(empTy, Math.floor(hengN / tileSizeMeters), Math.floor(ensN / tileSizeMeters)) + 1;

  const tiles: TileManifestEntry[] = [];
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const minEasting = tx * tileSizeMeters;
      const maxEasting = minEasting + tileSizeMeters;
      const minNorthing = ty * tileSizeMeters;
      const maxNorthing = minNorthing + tileSizeMeters;
      const isEmpty = tx === empTx && ty === empTy;
      tiles.push({
        lod: 0,
        tx,
        ty,
        minEasting,
        maxEasting,
        minNorthing,
        maxNorthing,
        tileCenterX: (minEasting + maxEasting) * 0.5 - originE,
        tileCenterZ: originN - (minNorthing + maxNorthing) * 0.5,
        overhangMinX: -512,
        overhangMaxX: 512,
        overhangMinY: 0,
        overhangMaxY: 20,
        overhangMinZ: -512,
        overhangMaxZ: 512,
        triCount: isEmpty ? 0 : 120,
        vertexCount: isEmpty ? 0 : 360,
        featureCount: isEmpty ? 0 : 15,
        isEmpty,
        hasBvh: !isEmpty,
        rawBytes: isEmpty ? 128 : 4096,
        compressedBytes: isEmpty ? 64 : 1024,
        contentHash: `h_${tx}_${ty}`,
      });
    }
  }

  const metadata: TilePackMetadata = {
    snapshotId: OVERIJSSEL_SNAPSHOT_ID,
    sourceSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
    projectionId: 'EPSG:25832',
    bakeSchemaVersion: '1.1.0',
    lodPolicyHash: 'test-policy',
    compression: 'deflate',
    tileSizeMeters,
    collarMeters: 64,
    studyOriginEasting: originE,
    studyOriginNorthing: originN,
    gridCols: maxTx - minTx + 1,
    gridRows: maxTy - minTy + 1,
    minTx,
    maxTx,
    minTy,
    maxTy,
    bakeStatus: 'complete',
    createdAtIso: '2026-11-24T00:00:00Z',
    completedAtIso: '2026-11-24T00:00:01Z',
  };

  return {
    mosaicName: 'synthetic-twente-test-1024m',
    packPath: '/tmp/synthetic-twente-test-1024m/mosaic.json',
    metadata,
    tiles,
  };
}

test('OverijsselSearchIndex builds FTS5 store, ranks exact/prefix/diacritic/punctuation queries, deduplicates split streets, and checks provenance', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-idx-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const spatialPath = path.join(tmpDir, 'twente.sqlite');
  const searchPath = path.join(tmpDir, 'twente.search.sqlite');
  createSyntheticSpatialDb(spatialPath, { snapshotMode: 'custom' });

  const buildRes = buildOverijsselSearchIndex({
    spatialIndexPath: spatialPath,
    outSearchIndexPath: searchPath,
    allowCustomSnapshot: true,
    onProgress: () => {},
  });

  assert.equal(buildRes.snapshotId, OVERIJSSEL_SNAPSHOT_ID);
  assert.equal(fs.existsSync(searchPath), true);
  // Excluded relation 6002 (route) and highway=traffic_signals 5005 must NOT be indexed;
  // Split ways 5001 + 5002 fold into 1 street entry for Hengelo, while way 5003 stays for Enschede.
  assert.equal(buildRes.categoryCounts.place, 4); // Hengelo, Enschede, Almelo, Zwolle
  assert.equal(buildRes.categoryCounts.station, 3); // Hengelo, Hengelo-Zuid, Enschede Centraal
  assert.equal(buildRes.categoryCounts.street, 2); // Stationsstraat (Hengelo) + Stationsstraat (Enschede)
  assert.equal(buildRes.categoryCounts.building, 2); // Stadhuis Hengelo + Grote Kerk Enschede
  assert.equal(buildRes.categoryCounts.poi, 2); // Café Brink + EmptyTile Shelter
  assert.equal(buildRes.categoryCounts.address, 1); // Enschedesestraat 42

  const mosaicContext = buildMockMosaicContext();
  const store = new OverijsselSearchStore(searchPath, spatialPath, {
    allowCustomSnapshot: true,
  });
  t.after(() => store.close());

  const meta = store.getMetadata();
  assert.equal(meta.searchSchemaVersion, OVERIJSSEL_SEARCH_INDEX_SCHEMA_VERSION);
  assert.equal(meta.entryCount, buildRes.entryCount);

  // 1. Exact/priority ranking: "Enschede" city ranks ahead of station / street / building
  const enschedeRes = store.search({ query: 'Enschede', mosaicContext });
  assert.ok(enschedeRes.results.length >= 3);
  assert.equal(enschedeRes.results[0].name, 'Enschede');
  assert.equal(enschedeRes.results[0].category, 'place');
  assert.equal(enschedeRes.results[0].coverage.status, 'covered');

  // 2. Diacritic & case folding ("cafe brink" matches "Café Brink")
  assert.equal(normalizeSearchText('Café   Brink'), 'cafe brink');
  const cafeRes = store.search({ query: 'cafe brink', mosaicContext });
  assert.equal(cafeRes.results.length, 1);
  assert.equal(cafeRes.results[0].name, 'Café Brink');
  assert.equal(cafeRes.results[0].category, 'poi');
  assert.equal(cafeRes.results[0].locality, 'Hengelo');

  // 3. Punctuation tokenization ("Hengelo Zuid" and "Hengelo-Zuid" both match station)
  const zuidSpace = store.search({
    query: 'Hengelo Zuid',
    category: 'station',
    mosaicContext,
  });
  assert.equal(zuidSpace.results.length, 1);
  assert.equal(zuidSpace.results[0].name, 'Hengelo-Zuid');

  // 4. Split street deduplication: Hengelo's two segments collapse to 1 while Enschede remains separate
  const streetsRes = store.search({
    query: 'Stationsstraat',
    category: 'street',
    mosaicContext,
  });
  assert.equal(streetsRes.results.length, 2);
  const localities = new Set(streetsRes.results.map((r) => r.locality));
  assert.deepEqual(localities, new Set(['Hengelo', 'Enschede']));

  // 5. Category filter + address lookup
  const addrRes = store.search({
    query: 'Enschedesestraat 42',
    category: 'address',
    mosaicContext,
  });
  assert.equal(addrRes.results.length, 1);
  assert.equal(addrRes.results[0].postcode, '7551 EN');

  // 6. Mosaic coverage status discrimination (empty_tile & outside_mosaic)
  const emptyRes = store.search({ query: 'EmptyTile', mosaicContext });
  assert.equal(emptyRes.results.length, 1);
  assert.equal(emptyRes.results[0].coverage.status, 'empty_tile');

  const outsideRes = store.search({ query: 'Zwolle', mosaicContext });
  assert.equal(outsideRes.results.length, 1);
  assert.equal(outsideRes.results[0].coverage.status, 'outside_mosaic');

  // 7. Unknown mosaic context + RegionalProjection accuracy
  const [hengE, hengN] = geoToUtm32N(6.7935, 52.2625);
  const covUnknown = evaluateSearchMosaicCoverage(hengE, hengN, null);
  assert.equal(covUnknown.status, 'unknown');
  const covCovered = evaluateSearchMosaicCoverage(hengE, hengN, mosaicContext);
  assert.equal(covCovered.status, 'covered');
  const proj = new RegionalProjection(
    mosaicContext.metadata.studyOriginEasting,
    mosaicContext.metadata.studyOriginNorthing
  );
  const [expectedX, expectedZ] = proj.utmToLocal(hengE, hengN);
  assert.ok(Math.abs((covCovered.worldX ?? 999) - expectedX) < 1e-6);
  assert.ok(Math.abs((covCovered.worldZ ?? 999) - expectedZ) < 1e-6);

  // 8. Limit clamping & excluded route filter
  const busRouteRes = store.search({ query: 'Express Bus Route', mosaicContext });
  assert.equal(busRouteRes.results.length, 0);
  const limited = store.search({ query: 'Hengelo', limit: 2, mosaicContext });
  assert.equal(limited.results.length, 2);
});

test('OverijsselSearchStore rejects missing search DB and incompatible snapshot/schema metadata', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-idx-compat-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const spatialPath = path.join(tmpDir, 'twente.sqlite');
  const searchPath = path.join(tmpDir, 'twente.search.sqlite');
  createSyntheticSpatialDb(spatialPath, { snapshotMode: 'custom' });

  assert.throws(
    () => new OverijsselSearchStore(searchPath, spatialPath, { allowCustomSnapshot: true }),
    OverijsselSearchIndexMissingError
  );

  buildOverijsselSearchIndex({
    spatialIndexPath: spatialPath,
    outSearchIndexPath: searchPath,
    allowCustomSnapshot: true,
    onProgress: () => {},
  });

  // Corrupt source_sha256 in search_metadata
  const db = new DatabaseSync(searchPath);
  db.exec(`UPDATE search_metadata SET value = '${'a'.repeat(64)}' WHERE key = 'source_sha256';`);
  db.close();

  assert.throws(
    () => new OverijsselSearchStore(searchPath, spatialPath, { allowCustomSnapshot: true }),
    (err: unknown) =>
      err instanceof OverijsselSearchIndexIncompatibleError &&
      err.reason === 'snapshot_provenance_mismatch'
  );

  // Corrupt search_schema_version
  const db2 = new DatabaseSync(searchPath);
  db2.exec(`UPDATE search_metadata SET value = '0.0.1' WHERE key = 'search_schema_version';`);
  db2.close();

  assert.throws(
    () => new OverijsselSearchStore(searchPath, spatialPath, { allowCustomSnapshot: true }),
    (err: unknown) =>
      err instanceof OverijsselSearchIndexIncompatibleError &&
      err.reason === 'schema_version_mismatch'
  );
});

test('Search HTTP endpoints expose status, build recovery, and offline local query results', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-http-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const spatialPath = path.join(tmpDir, 'twente.sqlite');
  const searchPath = path.join(tmpDir, 'twente.search.sqlite');
  const missingSpatial = path.join(tmpDir, 'missing.sqlite');
  const mosaicContext = buildMockMosaicContext();

  // 1. Missing spatial DB returns 503 with setup hint
  const missingCtrl = createSearchDataHandler({
    spatialIndexPath: missingSpatial,
    searchIndexPath: path.join(tmpDir, 'missing.search.sqlite'),
  });
  const appMissing = express();
  appMissing.get('/api/search/status', missingCtrl.statusHandler);
  appMissing.get('/api/search', missingCtrl.searchHandler);
  const srvMissing = http.createServer(appMissing);
  await new Promise<void>((r) => srvMissing.listen(0, '127.0.0.1', r));
  const portMissing = (srvMissing.address() as any).port;
  t.after(async () => {
    missingCtrl.close();
    await new Promise<void>((r) => srvMissing.close(() => r()));
  });

  const missingStatus = await fetch(`http://127.0.0.1:${portMissing}/api/search/status`);
  assert.equal(missingStatus.status, 503);
  const missingBody = (await missingStatus.json()) as any;
  assert.equal(missingBody.code, 'OVERIJSSEL_INDEX_MISSING');

  // 2. Present spatial DB without search DB starts as SEARCH_INDEX_MISSING -> POST /api/search/build builds -> GET /api/search works
  createSyntheticSpatialDb(spatialPath, { snapshotMode: 'custom' });
  const ctrl = createSearchDataHandler({
    spatialIndexPath: spatialPath,
    searchIndexPath: searchPath,
    allowCustomSnapshot: true,
    getMosaicCoverage: () => mosaicContext,
  });
  const app = express();
  app.get('/api/search/status', ctrl.statusHandler);
  app.post('/api/search/build', ctrl.buildHandler);
  app.get('/api/search', ctrl.searchHandler);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as any).port;
  t.after(async () => {
    ctrl.close();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  const initialStatusRes = await fetch(`http://127.0.0.1:${port}/api/search/status`);
  assert.equal(initialStatusRes.status, 503);
  const initialStatus = (await initialStatusRes.json()) as any;
  assert.equal(initialStatus.code, 'SEARCH_INDEX_MISSING');
  assert.equal(initialStatus.spatialIndexExists, true);

  const buildRes = await fetch(`http://127.0.0.1:${port}/api/search/build`, {
    method: 'POST',
  });
  assert.equal(buildRes.status, 200);
  const buildJson = (await buildRes.json()) as any;
  assert.equal(buildJson.available, true);
  assert.ok(buildJson.metadata.entryCount > 0);

  const emptyQ = await fetch(`http://127.0.0.1:${port}/api/search?q=`);
  assert.equal(emptyQ.status, 400);

  const queryRes = await fetch(
    `http://127.0.0.1:${port}/api/search?q=${encodeURIComponent('Stadhuis Hengelo')}`
  );
  assert.equal(queryRes.status, 200);
  assert.equal(queryRes.headers.get('x-osm-search-source'), 'overijssel-local-fts5');
  assert.equal(queryRes.headers.get('x-osm-snapshot-id'), OVERIJSSEL_SNAPSHOT_ID);
  const queryJson = (await queryRes.json()) as any;
  assert.equal(queryJson.mosaicName, 'synthetic-twente-test-1024m');
  assert.equal(queryJson.results.length, 1);
  assert.equal(queryJson.results[0].name, 'Stadhuis Hengelo');
  assert.equal(queryJson.results[0].coverage.status, 'covered');
});
