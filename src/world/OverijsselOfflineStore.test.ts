import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
import { isPointInOverijssel } from '../server/osm/overijsselBoundary';
import { buildOverijsselSpatialIndex } from '../server/osm/OverijsselIndexBuilder';
import { OverijsselIndexMissingError, OverijsselOsmStore } from '../server/osm/OverijsselOsmStore';
import { createOsmDataHandler } from '../server/osm/osmDataHandler';
import { resolveOverijsselIndexPath } from '../server/osm/overijsselConfig';
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
