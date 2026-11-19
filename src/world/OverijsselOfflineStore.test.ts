import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { isPointInOverijssel } from '../server/osm/overijsselBoundary';
import {
  buildOverijsselSpatialIndex,
  computePbfFileDigests,
} from '../server/osm/OverijsselIndexBuilder';
import {
  OverijsselIndexIncompatibleError,
  OverijsselIndexMissingError,
  OverijsselOsmStore,
} from '../server/osm/OverijsselOsmStore';
import { createOsmDataHandler } from '../server/osm/osmDataHandler';
import {
  buildCustomOverijsselSnapshotId,
  isOverijsselAutoBootstrapDisabled,
  OVERIJSSEL_HISTORICAL_BENCHMARK_SHA256,
  OVERIJSSEL_HISTORICAL_BENCHMARK_SNAPSHOT_ID,
  OVERIJSSEL_INDEX_FILENAME,
  OVERIJSSEL_PBF_EXPECTED_BYTES,
  OVERIJSSEL_PBF_EXPECTED_MD5,
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  OVERIJSSEL_PBF_FILENAME,
  OVERIJSSEL_SNAPSHOT_ID,
  parseOverijsselCliOptions,
  resolveOverijsselIndexPath,
} from '../server/osm/overijsselConfig';
import { ensureOverijsselReady } from '../../server';
import { fetchOverijsselPbf } from '../../scripts/fetch-overijssel-pbf';
import { runBuildOverijsselIndex } from '../../scripts/build-overijssel-index';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { parseServerTimingHeader } from './dev/MapLoadDiagnostics';

// ============================================================================
// Minimal deterministic OSM PBF encoder for self-contained pipeline tests
// ============================================================================

function encodeVarint(value: number | bigint): Buffer {
  let v = typeof value === 'bigint' ? value : BigInt(value);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const bytes: number[] = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeZigZag(n: number): bigint {
  const b = BigInt(n);
  return (b << 1n) ^ (b >> 63n);
}

function pbTag(field: number, wire: number): Buffer {
  return encodeVarint((field << 3) | wire);
}

function pbBytes(field: number, payload: Buffer): Buffer {
  return Buffer.concat([pbTag(field, 2), encodeVarint(payload.length), payload]);
}

function pbVarint(field: number, value: number | bigint): Buffer {
  return Buffer.concat([pbTag(field, 0), encodeVarint(value)]);
}

function buildTestOsmPbf(pbfPath: string): void {
  // Coordinates centered around Station Hengelo [6.7935, 52.2625]
  // Includes:
  // - Tagged small detail nodes (bench, waste_basket, street_lamp, natural=tree, obscure custom tag)
  // - Boundary-crossing road way with node IDs (and an external endpoint node outside query bbox!)
  // - Railway way
  // - Building multipolygon relation with courtyard inner ring whose outer way extends outside bbox
  const strings: string[] = [''];
  const intern = (s: string): number => {
    const idx = strings.indexOf(s);
    if (idx !== -1) return idx;
    strings.push(s);
    return strings.length - 1;
  };

  const nodes = [
    // Benches, waste basket, street lamp, tree, obscure feature inside Hengelo query
    { id: 1001, lon: 6.7935, lat: 52.2625, tags: { amenity: 'bench', backrest: 'yes' } },
    { id: 1002, lon: 6.7936, lat: 52.2625, tags: { amenity: 'waste_basket', material: 'metal' } },
    { id: 1003, lon: 6.7937, lat: 52.2626, tags: { highway: 'street_lamp' } },
    { id: 1004, lon: 6.7934, lat: 52.2624, tags: { natural: 'tree', species: 'Quercus' } },
    { id: 1005, lon: 6.7938, lat: 52.2624, tags: { custom_detail: 'tactile_paving_marker' } },

    // Road vertices (node 2003 intentionally 1.5 km east outside 350m query bbox!)
    { id: 2001, lon: 6.793, lat: 52.2625, tags: null },
    { id: 2002, lon: 6.794, lat: 52.2625, tags: null },
    { id: 2003, lon: 6.815, lat: 52.2625, tags: null },

    // Railway vertices
    { id: 3001, lon: 6.7925, lat: 52.2628, tags: null },
    { id: 3002, lon: 6.7945, lat: 52.2628, tags: { railway: 'switch' } },

    // Multipolygon outer square (spans across bbox edge) + inner courtyard square
    { id: 4001, lon: 6.7932, lat: 52.2620, tags: null },
    { id: 4002, lon: 6.8050, lat: 52.2620, tags: null },
    { id: 4003, lon: 6.8050, lat: 52.2623, tags: null },
    { id: 4004, lon: 6.7932, lat: 52.2623, tags: null },

    { id: 4011, lon: 6.7933, lat: 52.2621, tags: null },
    { id: 4012, lon: 6.7934, lat: 52.2621, tags: null },
    { id: 4013, lon: 6.7934, lat: 52.2622, tags: null },
    { id: 4014, lon: 6.7933, lat: 52.2622, tags: null },
  ];

  // Encode DenseNodes
  const denseIds: Buffer[] = [];
  const denseLats: Buffer[] = [];
  const denseLons: Buffer[] = [];
  const denseKvs: Buffer[] = [];
  let pId = 0;
  let pLat = 0;
  let pLon = 0;
  for (const n of nodes) {
    const latRaw = Math.round((n.lat * 1e9) / 100);
    const lonRaw = Math.round((n.lon * 1e9) / 100);
    denseIds.push(encodeVarint(encodeZigZag(n.id - pId)));
    denseLats.push(encodeVarint(encodeZigZag(latRaw - pLat)));
    denseLons.push(encodeVarint(encodeZigZag(lonRaw - pLon)));
    pId = n.id;
    pLat = latRaw;
    pLon = lonRaw;
    if (n.tags) {
      for (const [k, v] of Object.entries(n.tags)) {
        denseKvs.push(encodeVarint(intern(k)), encodeVarint(intern(v)));
      }
    }
    denseKvs.push(encodeVarint(0));
  }
  const denseNodesMsg = Buffer.concat([
    pbBytes(1, Buffer.concat(denseIds)),
    pbBytes(8, Buffer.concat(denseLats)),
    pbBytes(9, Buffer.concat(denseLons)),
    pbBytes(10, Buffer.concat(denseKvs)),
  ]);
  const nodesGroup = pbBytes(2, denseNodesMsg);

  // Encode Ways
  const encodeWay = (id: number, refs: number[], tags: Record<string, string> | null): Buffer => {
    const keys: Buffer[] = [];
    const vals: Buffer[] = [];
    if (tags) {
      for (const [k, v] of Object.entries(tags)) {
        keys.push(encodeVarint(intern(k)));
        vals.push(encodeVarint(intern(v)));
      }
    }
    const refBufs: Buffer[] = [];
    let prevRef = 0;
    for (const r of refs) {
      refBufs.push(encodeVarint(encodeZigZag(r - prevRef)));
      prevRef = r;
    }
    const parts: Buffer[] = [pbVarint(1, id)];
    if (keys.length > 0) {
      parts.push(pbBytes(2, Buffer.concat(keys)), pbBytes(3, Buffer.concat(vals)));
    }
    parts.push(pbBytes(8, Buffer.concat(refBufs)));
    return pbBytes(3, Buffer.concat(parts));
  };

  const waysGroup = Buffer.concat([
    encodeWay(5001, [2001, 2002, 2003], { highway: 'residential', name: 'Stationsplein' }),
    encodeWay(5002, [3001, 3002], { railway: 'rail', gauge: '1435' }),
    encodeWay(5003, [4001, 4002, 4003, 4004, 4001], null),
    encodeWay(5004, [4011, 4012, 4013, 4014, 4011], null),
  ]);

  // Encode Building Multipolygon Relation
  const relOuter = intern('outer');
  const relInner = intern('inner');
  const relTypeK = intern('type');
  const relTypeV = intern('multipolygon');
  const relBldgK = intern('building');
  const relBldgV = intern('yes');
  const relMsg = Buffer.concat([
    pbVarint(1, 6001),
    pbBytes(2, Buffer.concat([encodeVarint(relTypeK), encodeVarint(relBldgK)])),
    pbBytes(3, Buffer.concat([encodeVarint(relTypeV), encodeVarint(relBldgV)])),
    pbBytes(8, Buffer.concat([encodeVarint(relOuter), encodeVarint(relInner)])),
    pbBytes(
      9,
      Buffer.concat([
        encodeVarint(encodeZigZag(5003)),
        encodeVarint(encodeZigZag(5004 - 5003)),
      ])
    ),
    pbBytes(10, Buffer.concat([encodeVarint(1), encodeVarint(1)])),
  ]);
  const relGroup = pbBytes(4, relMsg);

  const strTablePayload = Buffer.concat(
    strings.map((s) => pbBytes(1, Buffer.from(s, 'utf8')))
  );
  const primitiveBlock = Buffer.concat([
    pbBytes(1, strTablePayload),
    pbBytes(2, nodesGroup),
    pbBytes(2, waysGroup),
    pbBytes(2, relGroup),
  ]);

  const wrapBlob = (type: string, rawPayload: Buffer): Buffer => {
    const z = zlib.deflateSync(rawPayload);
    const blob = Buffer.concat([pbVarint(2, rawPayload.length), pbBytes(3, z)]);
    const hdr = Buffer.concat([pbBytes(1, Buffer.from(type, 'utf8')), pbVarint(3, blob.length)]);
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(hdr.length, 0);
    return Buffer.concat([len, hdr, blob]);
  };

  const hdrBlock = Buffer.concat([
    pbBytes(4, Buffer.from('OsmSchema-V0.6', 'utf8')),
    pbBytes(4, Buffer.from('DenseNodes', 'utf8')),
    pbVarint(32, 1794691241),
  ]);

  fs.writeFileSync(
    pbfPath,
    Buffer.concat([wrapBlob('OSMHeader', hdrBlock), wrapBlob('OSMData', primitiveBlock)])
  );
}

test('isPointInOverijssel distinguishes Overijssel/Twente municipalities from external locations', () => {
  // Inside Overijssel (including Twente)
  assert.equal(isPointInOverijssel(52.2625, 6.7935), true, 'Station Hengelo');
  assert.equal(isPointInOverijssel(52.2215, 6.8937), true, 'Enschede Centrum');
  assert.equal(isPointInOverijssel(52.3567, 6.6625), true, 'Almelo');
  assert.equal(isPointInOverijssel(52.3133, 6.9293), true, 'Oldenzaal');
  assert.equal(isPointInOverijssel(52.5168, 6.083), true, 'Zwolle');
  assert.equal(isPointInOverijssel(52.255, 6.1639), true, 'Deventer');

  // Outside Overijssel
  assert.equal(isPointInOverijssel(52.3791, 4.9003), false, 'Amsterdam Centraal');
  assert.equal(isPointInOverijssel(52.2125, 7.022), false, 'Gronau (Germany)');
  assert.equal(isPointInOverijssel(52.2112, 5.9699), false, 'Apeldoorn (Gelderland)');
});

test('OverijsselIndexBuilder and OverijsselOsmStore preserve all features, small details, multipolygons, crossing ways, node IDs, and persist across restarts', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkt022-test-'));
  try {
    const pbfPath = path.join(tmpDir, 'sample.osm.pbf');
    const sqlitePath = path.join(tmpDir, 'sample.sqlite');
    buildTestOsmPbf(pbfPath);

    const buildRes = await buildOverijsselSpatialIndex({
      pbfPath,
      outIndexPath: sqlitePath,
      allowCustomSnapshot: true,
      onProgress: () => {},
    });

    assert.equal(buildRes.nodeCount, 18);
    assert.equal(buildRes.taggedNodeCount, 6);
    assert.equal(buildRes.wayCount, 4);
    assert.equal(buildRes.relationCount, 1);

    // Open store, query Station Hengelo, close, and reopen to verify persistence across restarts
    const store1 = new OverijsselOsmStore(sqlitePath);
    const q1 = store1.queryRegion({
      centerLat: 52.2625,
      centerLon: 6.7935,
      radiusMeters: 350,
      locationName: 'Station Hengelo Test',
    });
    store1.close();

    const store2 = new OverijsselOsmStore(sqlitePath);
    const q2 = store2.queryRegion({
      centerLat: 52.2625,
      centerLon: 6.7935,
      radiusMeters: 350,
      locationName: 'Station Hengelo Test',
    });
    store2.close();

    assert.equal(q2.counts.features, q1.counts.features);
    const features = q2.geojson.features as any[];

    // 1. Small details preserved without filtering
    assert.ok(features.some((f) => f.id === 'node/1001' && f.properties.amenity === 'bench'));
    assert.ok(
      features.some((f) => f.id === 'node/1002' && f.properties.amenity === 'waste_basket')
    );
    assert.ok(features.some((f) => f.id === 'node/1003' && f.properties.highway === 'street_lamp'));
    assert.ok(features.some((f) => f.id === 'node/1004' && f.properties.natural === 'tree'));
    assert.ok(
      features.some(
        (f) => f.id === 'node/1005' && f.properties.custom_detail === 'tactile_paving_marker'
      )
    );

    // 2. Boundary-crossing road preserves out-of-bbox endpoint node 2003 and verified _nodeIds
    const roadFeature = features.find((f) => f.id === 'way/5001');
    assert.ok(roadFeature, 'road way/5001 present');
    assert.equal(roadFeature.geometry.coordinates.length, 3);
    assert.deepEqual(roadFeature.properties._nodeIds, ['2001', '2002', '2003']);

    // 3. Railway way + switch node preserved
    const railFeature = features.find((f) => f.id === 'way/5002');
    assert.ok(railFeature, 'railway way/5002 present');
    assert.deepEqual(railFeature.properties._nodeIds, ['3001', '3002']);

    // 4. Multipolygon building with outer ring + inner courtyard ring reconstructed cleanly
    const mpBuilding = features.find((f) => f.id === 'relation/6001');
    assert.ok(mpBuilding, 'building multipolygon relation/6001 reconstructed');
    assert.equal(mpBuilding.geometry.type, 'Polygon');
    assert.equal(mpBuilding.geometry.coordinates.length, 2, 'outer + inner courtyard ring');

    // 5. Compatible with LocalGeoJsonProvider
    const provider = new LocalGeoJsonProvider();
    const parsed = provider.parseGeoJson(q2.geojson, 'Station Hengelo Test', [6.7935, 52.2625], 350);
    assert.equal(parsed.roads.length, 1);
    assert.equal(parsed.railways.length, 1);
    assert.equal(parsed.buildings.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('/api/osm-data serves Overijssel strictly from local index without contacting Overpass, returns explicit 503 when missing, and routes external cities to Overpass', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkt022-http-'));
  try {
    const pbfPath = path.join(tmpDir, 'sample.osm.pbf');
    const sqlitePath = path.join(tmpDir, 'sample.sqlite');
    const missingSqlitePath = path.join(tmpDir, 'does-not-exist.sqlite');
    buildTestOsmPbf(pbfPath);
    await buildOverijsselSpatialIndex({
      pbfPath,
      outIndexPath: sqlitePath,
      allowCustomSnapshot: true,
      onProgress: () => {},
    });

    // A. Missing index for Overijssel location MUST fail cleanly (503) and NEVER call Overpass
    let missingFetchCalls = 0;
    const missingController = createOsmDataHandler({
      overijsselIndexPath: missingSqlitePath,
      fetchImpl: (async () => {
        missingFetchCalls++;
        throw new Error('Overpass must not be called for Overijssel');
      }) as typeof fetch,
    });
    const appMissing = express();
    appMissing.get('/api/osm-data', missingController.handler);
    const srvMissing = http.createServer(appMissing);
    await new Promise<void>((r) => srvMissing.listen(0, '127.0.0.1', r));
    const portMissing = (srvMissing.address() as any).port;

    try {
      const res = await fetch(
        `http://127.0.0.1:${portMissing}/api/osm-data?lat=52.2625&lon=6.7935&radius=350&name=Station+Hengelo`
      );
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /npm run osm:setup-overijssel/i);
      assert.equal(missingFetchCalls, 0, 'Overpass must NEVER be contacted when Overijssel index is missing');
    } finally {
      missingController.close();
      await new Promise<void>((r) => srvMissing.close(() => r()));
    }

    // B. Present index serves Hengelo locally with zero Overpass calls, while Amsterdam calls mock Overpass
    let externalFetchCalls = 0;
    const okController = createOsmDataHandler({
      overijsselIndexPath: sqlitePath,
      fetchImpl: (async (input: RequestInfo | URL) => {
        externalFetchCalls++;
        const url = String(input);
        assert.match(url, /overpass-api\.de/);
        return new Response(
          JSON.stringify({
            version: 0.6,
            elements: [
              { type: 'node', id: 1, lat: 52.3791, lon: 4.9003 },
              { type: 'node', id: 2, lat: 52.3795, lon: 4.9005 },
              { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'residential' } },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch,
    });
    const appOk = express();
    appOk.get('/api/osm-data', okController.handler);
    const srvOk = http.createServer(appOk);
    await new Promise<void>((r) => srvOk.listen(0, '127.0.0.1', r));
    const portOk = (srvOk.address() as any).port;

    try {
      const hengeloRes = await fetch(
        `http://127.0.0.1:${portOk}/api/osm-data?lat=52.2625&lon=6.7935&radius=350&name=Station+Hengelo`
      );
      assert.equal(hengeloRes.status, 200);
      assert.equal(hengeloRes.headers.get('x-osm-cache'), 'MISS');
      assert.equal(hengeloRes.headers.get('x-osm-source'), 'overijssel-offline');
      assert.equal(externalFetchCalls, 0, 'Overpass must NOT be contacted for Hengelo');

      const parsedTiming = parseServerTimingHeader(
        hengeloRes.headers.get('server-timing'),
        hengeloRes.headers.get('x-osm-source')
      );
      assert.ok(parsedTiming);
      assert.equal(parsedTiming.upstreamSource, 'overijssel-offline');
      assert.ok(parsedTiming.totalServerMs !== null && parsedTiming.totalServerMs >= 0);

      // Warm repeat hits cache
      const hengeloWarmRes = await fetch(
        `http://127.0.0.1:${portOk}/api/osm-data?lat=52.2625&lon=6.7935&radius=350&name=Station+Hengelo`
      );
      assert.equal(hengeloWarmRes.status, 200);
      assert.equal(hengeloWarmRes.headers.get('x-osm-cache'), 'HIT');
      assert.equal(hengeloWarmRes.headers.get('x-osm-source'), 'cache');
      assert.equal(externalFetchCalls, 0);

      // External location (Amsterdam Centraal) still routes through Overpass
      const amsterdamRes = await fetch(
        `http://127.0.0.1:${portOk}/api/osm-data?lat=52.3791&lon=4.9003&radius=350&name=Amsterdam+Centraal`
      );
      assert.equal(amsterdamRes.status, 200);
      assert.equal(amsterdamRes.headers.get('x-osm-source'), 'overpass');
      assert.equal(externalFetchCalls, 1, 'Overpass MUST be used outside Overijssel');
    } finally {
      okController.close();
      await new Promise<void>((r) => srvOk.close(() => r()));
    }

    assert.throws(
      () => new OverijsselOsmStore(missingSqlitePath),
      OverijsselIndexMissingError
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Full Overijssel snapshot spatial index (when present on disk) serves Hengelo and Enschede with small details', (t) => {
  const indexPath = resolveOverijsselIndexPath();
  if (!fs.existsSync(indexPath)) {
    t.skip(`Full Overijssel index not present at ${indexPath}`);
    return;
  }

  const store = new OverijsselOsmStore(indexPath);
  try {
    const hengelo = store.queryRegion({
      centerLat: 52.2625,
      centerLon: 6.7935,
      radiusMeters: 400,
      locationName: 'Station Hengelo',
    });
    assert.ok(hengelo.counts.features > 2000);
    assert.ok(hengelo.geojson.features.some((f: any) => f.properties?.amenity === 'bench'));
    assert.ok(hengelo.geojson.features.some((f: any) => f.properties?.amenity === 'waste_basket'));
    assert.ok(hengelo.geojson.features.some((f: any) => f.properties?.natural === 'tree'));

    const enschede = store.queryRegion({
      centerLat: 52.2215,
      centerLon: 6.8937,
      radiusMeters: 400,
      locationName: 'Enschede Centrum',
    });
    assert.ok(enschede.counts.features > 2000);
    assert.ok(enschede.geojson.features.some((f: any) => f.properties?.amenity === 'bench'));
  } finally {
    store.close();
  }
});

test('Overijssel auto-bootstrap opt-out skips download and indexing while preserving default behavior', async () => {
  // Default behavior: auto-bootstrap remains enabled when opt-out env/CLI flags are absent
  assert.equal(isOverijsselAutoBootstrapDisabled({}, ['node', 'server.ts']), false);

  // Explicit opt-outs: env vars and CLI flag
  assert.equal(
    isOverijsselAutoBootstrapDisabled({ DISABLE_OVERIJSSEL_BOOTSTRAP: 'true' }, ['node', 'server.ts']),
    true
  );
  assert.equal(
    isOverijsselAutoBootstrapDisabled({ DISABLE_OVERIJSSEL_BOOTSTRAP: '1' }, ['node', 'server.ts']),
    true
  );
  assert.equal(
    isOverijsselAutoBootstrapDisabled({ OVERIJSSEL_AUTO_BOOTSTRAP: 'false' }, ['node', 'server.ts']),
    true
  );
  assert.equal(
    isOverijsselAutoBootstrapDisabled({ OVERIJSSEL_AUTO_BOOTSTRAP: '0' }, ['node', 'server.ts']),
    true
  );
  assert.equal(
    isOverijsselAutoBootstrapDisabled({}, ['node', 'server.ts', '--no-overijssel-bootstrap']),
    true
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overijssel-optout-'));
  try {
    const missingIndexPath = path.join(tmpDir, 'missing.sqlite');
    let fetchCalls = 0;
    let buildCalls = 0;

    // 1. With opt-out enabled, ensureOverijsselReady must NOT download or build index
    await ensureOverijsselReady({
      env: { DISABLE_OVERIJSSEL_BOOTSTRAP: 'true' },
      argv: ['node', 'server.ts'],
      indexPath: missingIndexPath,
      fetchPbf: async () => {
        fetchCalls++;
        return { pbfPath: path.join(tmpDir, 'sample.osm.pbf') };
      },
      buildIndex: async () => {
        buildCalls++;
      },
    });
    assert.equal(fetchCalls, 0);
    assert.equal(buildCalls, 0);
    assert.equal(fs.existsSync(missingIndexPath), false);

    // 2. With opt-out unset (default), ensureOverijsselReady triggers download + index build
    await ensureOverijsselReady({
      env: {},
      argv: ['node', 'server.ts'],
      indexPath: missingIndexPath,
      fetchPbf: async () => {
        fetchCalls++;
        return { pbfPath: path.join(tmpDir, 'sample.osm.pbf') };
      },
      buildIndex: async ({ outIndexPath }) => {
        buildCalls++;
        assert.equal(outIndexPath, missingIndexPath);
      },
    });
    assert.equal(fetchCalls, 1);
    assert.equal(buildCalls, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TKT-027: Canonical snapshot constants remain distinct from historical TKT-019/TKT-022 manifest provenance', () => {
  assert.equal(OVERIJSSEL_SNAPSHOT_ID, 'overijssel-261114-8ae28196');
  assert.equal(OVERIJSSEL_PBF_FILENAME, 'overijssel-261114.osm.pbf');
  assert.equal(OVERIJSSEL_INDEX_FILENAME, 'overijssel-261114-8ae28196.sqlite');
  assert.equal(
    OVERIJSSEL_PBF_EXPECTED_SHA256,
    '8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0'
  );
  assert.equal(OVERIJSSEL_PBF_EXPECTED_MD5, '461949c7c40f7d90b4bbb695d0933f57');
  assert.equal(OVERIJSSEL_PBF_EXPECTED_BYTES, 114_506_422);

  assert.equal(OVERIJSSEL_HISTORICAL_BENCHMARK_SNAPSHOT_ID, 'overijssel-261114');
  assert.equal(
    OVERIJSSEL_HISTORICAL_BENCHMARK_SHA256,
    '53d1f2d0b6c9461b4d752610c5c348bb48d1c1ac77838e75b934bf676a980243'
  );
  assert.notEqual(OVERIJSSEL_PBF_EXPECTED_SHA256, OVERIJSSEL_HISTORICAL_BENCHMARK_SHA256);
  assert.notEqual(OVERIJSSEL_SNAPSHOT_ID, OVERIJSSEL_HISTORICAL_BENCHMARK_SNAPSHOT_ID);

  // Historical frozen Hengelo scaling manifest must retain its original 53d1f2d0... provenance
  const manifestPath = path.resolve(process.cwd(), 'benchmarks/datasets/hengelo-scaling/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.sourceFileName, 'overijssel-261114.osm.pbf');
  assert.equal(manifest.sourceSha256, OVERIJSSEL_HISTORICAL_BENCHMARK_SHA256);
});

test('TKT-027: fetchOverijsselPbf verifies SHA-256 strictly, discards mismatched downloads, and provides recovery diagnostics', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkt027-fetch-'));
  try {
    const fixturePbf = path.join(tmpDir, 'fixture.osm.pbf');
    buildTestOsmPbf(fixturePbf);
    const fixtureBytes = fs.readFileSync(fixturePbf);
    const digests = await computePbfFileDigests(fixturePbf);

    const server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/canonical.osm.pbf' });
        res.end();
        return;
      }
      if (req.url === '/canonical.osm.pbf') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(fixtureBytes);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    try {
      const targetPbf = path.join(tmpDir, 'out', 'overijssel.osm.pbf');

      // 1. Download via HTTP redirect with matching expectedSha256 succeeds
      const first = await fetchOverijsselPbf({
        outPath: targetPbf,
        url: `http://127.0.0.1:${port}/redirect`,
        expectedSha256: digests.sha256,
      });
      assert.equal(first.reusedExisting, false);
      assert.equal(first.sha256, digests.sha256);
      assert.equal(first.md5, digests.md5);
      assert.equal(first.bytes, digests.bytes);

      // 2. Subsequent call verifies and reuses the existing file
      const second = await fetchOverijsselPbf({
        outPath: targetPbf,
        url: `http://127.0.0.1:${port}/canonical.osm.pbf`,
        expectedSha256: digests.sha256,
      });
      assert.equal(second.reusedExisting, true);
      assert.equal(second.sha256, digests.sha256);

      // 3. Mismatched existing file throws actionable diagnostics without --force
      await assert.rejects(
        () =>
          fetchOverijsselPbf({
            outPath: targetPbf,
            url: `http://127.0.0.1:${port}/canonical.osm.pbf`,
            expectedSha256: '0'.repeat(64),
          }),
        (err: Error) => {
          assert.match(err.message, /failed SHA-256 verification/i);
          assert.match(err.message, new RegExp(targetPbf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          assert.match(err.message, new RegExp(digests.sha256));
          assert.match(err.message, new RegExp(digests.md5));
          assert.match(err.message, /--allow-custom-snapshot/);
          return true;
        }
      );

      // 4. Mismatched HTTP download discards temp file and leaves outPath absent
      const rejectedOut = path.join(tmpDir, 'out', 'rejected.osm.pbf');
      await assert.rejects(
        () =>
          fetchOverijsselPbf({
            outPath: rejectedOut,
            url: `http://127.0.0.1:${port}/redirect`,
            expectedSha256: 'f'.repeat(64),
          }),
        (err: Error) => {
          assert.match(err.message, /temp file discarded/i);
          assert.match(err.message, /redirected to/i);
          assert.match(err.message, new RegExp(digests.sha256));
          assert.match(err.message, new RegExp(digests.md5));
          return true;
        }
      );
      assert.equal(fs.existsSync(rejectedOut), false);
      const leftoverTemps = fs
        .readdirSync(path.dirname(rejectedOut))
        .filter((f) => f.includes('.download.'));
      assert.equal(leftoverTemps.length, 0);

      // 5. --from local path rejects unapproved mismatch unless skipHashCheck=true
      await assert.rejects(
        () =>
          fetchOverijsselPbf({
            outPath: rejectedOut,
            fromLocalPath: fixturePbf,
            expectedSha256: 'a'.repeat(64),
          }),
        /Local source PBF failed SHA-256 verification/i
      );
      const fromCustom = await fetchOverijsselPbf({
        outPath: rejectedOut,
        fromLocalPath: fixturePbf,
        expectedSha256: 'a'.repeat(64),
        skipHashCheck: true,
      });
      assert.equal(fromCustom.sha256, digests.sha256);
      assert.equal(fs.existsSync(rejectedOut), true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TKT-027: Index builder and OverijsselOsmStore validate provenance, distinguish custom snapshots, reject stale/incompatible DBs, and trigger rebuilds cleanly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkt027-index-'));
  try {
    const pbfA = path.join(tmpDir, 'a.osm.pbf');
    const pbfB = path.join(tmpDir, 'b.osm.pbf');
    buildTestOsmPbf(pbfA);
    // Append a trailing zero byte? PBF length-prefixed blobs require valid framing, so write a second valid PBF or copy with different header timestamp by modifying header byte isn't safe;
    // instead append a 0-length-ignored? No, OsmPbfReader reads until EOF via readInt32BE(offset); so let's construct pbfB with extra trailing uncompressed OSMHeader comment? Easier: buildTestOsmPbf reads fine, let's prepend/modify a tag string!
    fs.copyFileSync(pbfA, pbfB);
    // Modify pbfA vs pbfB cleanly by rebuilding a slightly different valid PBF:
    // Actually we can just patch a single character inside a string? No, zlib-compressed!
    // Let's write pbfB with a small valid OSMData blob or patch an uncompressed blob? Better: call buildTestOsmPbf and verify digests, or build a tiny valid 2nd PBF using the same helper style? Wait: wrapBlob in buildTestOsmPbf isn't exported, let's build a valid 2nd PBF with an extra header blob or re-run node/way? Wait: OsmPbfReader ignores unknown blob types! Adding a harmless 'CustomMeta' blob (header length + BlobHeader + empty Blob) produces a 100% valid OSM PBF with a different SHA-256!
    const customHdr = Buffer.concat([
      pbBytes(1, Buffer.from('CustomTest', 'utf8')),
      pbVarint(3, 0),
    ]);
    const customLen = Buffer.allocUnsafe(4);
    customLen.writeUInt32BE(customHdr.length, 0);
    fs.writeFileSync(pbfB, Buffer.concat([fs.readFileSync(pbfA), customLen, customHdr]));

    const digA = await computePbfFileDigests(pbfA);
    const digB = await computePbfFileDigests(pbfB);
    assert.notEqual(digA.sha256, digB.sha256);

    const indexPath = path.join(tmpDir, 'overijssel.sqlite');

    // 1. Default canonical mode rejects synthetic PBF without allowCustomSnapshot
    await assert.rejects(
      () =>
        runBuildOverijsselIndex({
          pbfPath: pbfA,
          outIndexPath: indexPath,
        }),
      (err: Error) => {
        assert.match(err.message, /Snapshot SHA-256 mismatch/);
        assert.match(err.message, new RegExp(OVERIJSSEL_PBF_EXPECTED_SHA256));
        assert.match(err.message, new RegExp(digA.sha256));
        assert.match(err.message, /--allow-custom-snapshot/);
        return true;
      }
    );

    // 2. Custom snapshot mode writes distinct custom-<12hex> snapshotId + real sourceSha256/Md5/Bytes
    const customResA = await runBuildOverijsselIndex({
      pbfPath: pbfA,
      outIndexPath: indexPath,
      allowCustomSnapshot: true,
    });
    assert.ok(customResA);
    assert.equal(customResA.snapshotMode, 'custom');
    assert.equal(customResA.snapshotId, buildCustomOverijsselSnapshotId(digA.sha256));
    assert.equal(customResA.pbfSha256, digA.sha256);
    assert.equal(customResA.pbfMd5, digA.md5);
    assert.equal(customResA.pbfBytes, digA.bytes);

    const customStore = new OverijsselOsmStore(indexPath);
    const metaA = customStore.getSnapshotMetadata();
    assert.equal(metaA.snapshotMode, 'custom');
    assert.equal(metaA.snapshotId, buildCustomOverijsselSnapshotId(digA.sha256));
    assert.equal(metaA.sourceSha256, digA.sha256);
    assert.equal(metaA.sourceMd5, digA.md5);
    assert.equal(metaA.sourceBytes, digA.bytes);
    customStore.close();

    // 3. Re-running with unchanged PBF A reuses the existing SQLite index (returns null)
    const reused = await runBuildOverijsselIndex({
      pbfPath: pbfA,
      outIndexPath: indexPath,
      allowCustomSnapshot: true,
    });
    assert.equal(reused, null);

    // 4. Switching to PBF B (even with allowCustomSnapshot=true) MUST NOT reuse PBF A's index!
    const customResB = await runBuildOverijsselIndex({
      pbfPath: pbfB,
      outIndexPath: indexPath,
      allowCustomSnapshot: true,
    });
    assert.ok(customResB, 'different PBF bytes must force index rebuild even with allowCustomSnapshot');
    assert.equal(customResB.pbfSha256, digB.sha256);
    assert.equal(customResB.snapshotId, buildCustomOverijsselSnapshotId(digB.sha256));

    // 5. Simulate legacy pre-TKT-027 canonical index built from historical 53d1f2d0... (no snapshot_mode key)
    const db = new DatabaseSync(indexPath);
    db.exec(`
      DELETE FROM metadata WHERE key = 'snapshot_mode';
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('snapshot_id', '${OVERIJSSEL_HISTORICAL_BENCHMARK_SNAPSHOT_ID}');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('source_sha256', '${OVERIJSSEL_HISTORICAL_BENCHMARK_SHA256}');
    `);
    db.close();

    // OverijsselOsmStore rejects legacy/incompatible canonical DB by default
    assert.throws(
      () => new OverijsselOsmStore(indexPath),
      (err: unknown) =>
        err instanceof OverijsselIndexIncompatibleError &&
        err instanceof OverijsselIndexMissingError &&
        err.expectedSha256 === OVERIJSSEL_PBF_EXPECTED_SHA256 &&
        err.actualSha256 === OVERIJSSEL_HISTORICAL_BENCHMARK_SHA256 &&
        /archived TKT-019\/TKT-022 snapshot/i.test(err.message)
    );

    // /api/osm-data treats OverijsselIndexIncompatibleError as HTTP 503 (never falls back to Overpass)
    let overpassCalls = 0;
    const controller = createOsmDataHandler({
      overijsselIndexPath: indexPath,
      fetchImpl: (async () => {
        overpassCalls++;
        throw new Error('Overpass must not be called');
      }) as typeof fetch,
    });
    const app = express();
    app.get('/api/osm-data', controller.handler);
    const srv = http.createServer(app);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as any).port;
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/osm-data?lat=52.2625&lon=6.7935&radius=350&name=Hengelo`
      );
      assert.equal(res.status, 503);
      assert.equal(overpassCalls, 0);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /Incompatible Overijssel SQLite spatial index/i);
    } finally {
      controller.close();
      await new Promise<void>((r) => srv.close(() => r()));
    }

    // 6. Explicit expectedSha256 + expectedSnapshotId works and validates strictly
    const explicitOk = new OverijsselOsmStore(indexPath, {
      expectedSha256: OVERIJSSEL_HISTORICAL_BENCHMARK_SHA256,
      expectedSnapshotId: OVERIJSSEL_HISTORICAL_BENCHMARK_SNAPSHOT_ID,
    });
    explicitOk.close();

    // 7. ensureOverijsselReady detects incompatible index on disk and triggers rebuild with force=true
    let forcedRebuild: boolean | undefined;
    await ensureOverijsselReady({
      env: {},
      argv: ['node', 'server.ts'],
      indexPath,
      fetchPbf: async () => ({ pbfPath: pbfA }),
      buildIndex: async (opts) => {
        forcedRebuild = opts.force;
      },
    });
    assert.equal(forcedRebuild, true);

    // 8. Building in canonical mode with expectedSha256 matching PBF A overrides legacy DB cleanly
    const canonicalBuild = await runBuildOverijsselIndex({
      pbfPath: pbfA,
      outIndexPath: indexPath,
      expectedSha256: digA.sha256,
    });
    assert.ok(canonicalBuild);
    assert.equal(canonicalBuild.snapshotMode, 'canonical');
    assert.equal(canonicalBuild.snapshotId, OVERIJSSEL_SNAPSHOT_ID);

    const canonicalStore = new OverijsselOsmStore(indexPath, { expectedSha256: digA.sha256 });
    assert.equal(canonicalStore.getSnapshotMetadata().snapshotId, OVERIJSSEL_SNAPSHOT_ID);
    canonicalStore.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TKT-027: parseOverijsselCliOptions supports space/equals flags, OVERIJSSEL_* env vars, and npm_config_* PowerShell fallbacks', () => {
  const direct = parseOverijsselCliOptions(
    [
      '--allow-custom-snapshot',
      '--force',
      '--skip-hash-check',
      '--from=C:\\tmp\\custom.pbf',
      '--pbf',
      'data/osm/custom.pbf',
      '--out=data/osm/custom.sqlite',
      '--snapshot-id',
      'my-custom-id',
      '--expected-sha256=ABCDEF01',
    ],
    {}
  );
  assert.deepEqual(direct, {
    pbfPath: 'data/osm/custom.pbf',
    fromLocalPath: 'C:\\tmp\\custom.pbf',
    outPath: 'data/osm/custom.sqlite',
    url: undefined,
    snapshotId: 'my-custom-id',
    expectedSha256: 'abcdef01',
    force: true,
    allowCustomSnapshot: true,
    skipHashCheck: true,
  });

  // PowerShell strips bare `--` so npm consumes `--allow-custom-snapshot` into npm_config_*
  const npmFallback = parseOverijsselCliOptions([], {
    npm_config_allow_custom_snapshot: 'true',
    npm_config_force: '1',
    npm_config_skip_hash_check: 'yes',
    npm_config_from: 'C:\\downloads\\overijssel-261114.osm.pbf',
    npm_config_pbf: 'data/osm/overijssel-261114.osm.pbf',
    npm_config_out: 'data/osm/custom.sqlite',
  });
  assert.equal(npmFallback.allowCustomSnapshot, true);
  assert.equal(npmFallback.force, true);
  assert.equal(npmFallback.skipHashCheck, true);
  assert.equal(npmFallback.fromLocalPath, 'C:\\downloads\\overijssel-261114.osm.pbf');
  assert.equal(npmFallback.pbfPath, 'data/osm/overijssel-261114.osm.pbf');
  assert.equal(npmFallback.outPath, 'data/osm/custom.sqlite');

  // Explicit OVERIJSSEL_* environment variables also work across shells
  const envOverrides = parseOverijsselCliOptions([], {
    OVERIJSSEL_ALLOW_CUSTOM_SNAPSHOT: '1',
    OVERIJSSEL_FORCE: 'true',
    OVERIJSSEL_SKIP_HASH_CHECK: '1',
    OVERIJSSEL_CUSTOM_SNAPSHOT_ID: 'local-overijssel',
  });
  assert.equal(envOverrides.allowCustomSnapshot, true);
  assert.equal(envOverrides.force, true);
  assert.equal(envOverrides.skipHashCheck, true);
  assert.equal(envOverrides.snapshotId, 'local-overijssel');
});


