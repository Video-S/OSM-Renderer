import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  MapLoadTimelineTracker,
  parseServerTimingHeader,
  resolveCacheStatusFromHeaders,
} from './dev/MapLoadDiagnostics';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { OsmApiProvider } from './OsmApiProvider';
import { GeometryBuilder } from './GeometryBuilder';
import { prepareInfrastructureRenderPreview } from './infrastructure/rendering/InfrastructureRenderAdapter';
import { MAP_THEMES } from '../styles/mapThemes';

const FORK_FIXTURE_PATH = path.resolve(
  process.cwd(),
  'src/world/prototype/PrinsHendrikkadeForkFixture.json'
);

test('parseServerTimingHeader parses valid headers and returns null cleanly when missing', () => {
  assert.equal(parseServerTimingHeader(null), null);
  assert.equal(parseServerTimingHeader(''), null);
  assert.equal(parseServerTimingHeader('invalid-without-dur'), null);

  const parsed = parseServerTimingHeader(
    'cache;dur=0.412, upstream;dur=1842.5, osmtogeojson;dur=142.3, enrich;dur=38.1, total;dur=2023.4',
    'overpass'
  );
  assert.ok(parsed);
  assert.equal(parsed.cacheLookupMs, 0.412);
  assert.equal(parsed.upstreamFetchMs, 1842.5);
  assert.equal(parsed.upstreamSource, 'overpass');
  assert.equal(parsed.osmtogeojsonMs, 142.3);
  assert.equal(parsed.nodeIdEnrichMs, 38.1);
  assert.equal(parsed.totalServerMs, 2023.4);

  assert.equal(resolveCacheStatusFromHeaders('MISS'), 'cold_miss');
  assert.equal(resolveCacheStatusFromHeaders('HIT'), 'warm_hit');
  assert.equal(resolveCacheStatusFromHeaders(null), 'unknown');
});

test('MapLoadTimelineTracker maintains accounted + unaccounted === total, handles superseded/failed loads, and bounds history', async () => {
  const tracker = new MapLoadTimelineTracker(5);

  // 1. Simulate superseded async request before completion
  const req1 = tracker.startLoad({
    locationId: 'hengelo',
    locationName: 'Station Hengelo',
    radiusMeters: 400,
    sourceType: 'preset_live_osm',
    isInitialStartupLoad: true,
    rendererConfig: {
      roadsMode: 'graph-surface',
      railwaysMode: 'graph-R+',
      railwayPrototypeMode: 'production',
      themeId: 'tactical',
    },
  });
  assert.equal(tracker.isRequestCurrent(req1), true);

  const req2 = tracker.startLoad({
    locationId: 'amsterdam',
    locationName: 'Amsterdam Centraal',
    radiusMeters: 420,
    sourceType: 'preset_live_osm',
    rendererConfig: {
      roadsMode: 'graph-surface',
      railwaysMode: 'graph-R+',
      railwayPrototypeMode: 'production',
      themeId: 'tactical',
    },
  });
  assert.equal(tracker.isRequestCurrent(req1), false);
  assert.equal(tracker.isRequestCurrent(req2), true);

  // Superseded record should be captured in history with status='superseded'
  const histAfterSupersede = tracker.getHistory();
  assert.equal(histAfterSupersede.length, 1);
  assert.equal(histAfterSupersede[0].requestId, req1);
  assert.equal(histAfterSupersede[0].status, 'superseded');
  assert.equal(histAfterSupersede[0].supersededByRequestId, req2);

  // 2. Complete req2 with monotonically progressing real clock stages
  await new Promise((r) => setTimeout(r, 15));
  tracker.recordOsmProviderMetrics(req2, {
    url: '/api/osm-data?lat=52.3791&lon=4.9003&radius=420',
    httpStatus: 200,
    osmRequestMs: 8.5,
    dataTransferAndDecodeMs: 2.2,
    responseTransferMs: 1.4,
    jsonDecodeMs: 0.8,
    geoJsonProcessingMs: 3.1,
    geoJsonSubTimingsMs: {
      boundsAndPreScanMs: 0.5,
      featureClipAndExtractMs: 2.0,
      roadChainingAndStatsMs: 0.6,
    },
    payloadBytes: 245760,
    transferSizeBytes: 51200,
    encodedBodySizeBytes: 50000,
    featureCount: 640,
    cacheStatus: 'cold_miss',
    serverTimings: {
      cacheLookupMs: 0.2,
      upstreamFetchMs: 6.0,
      upstreamSource: 'overpass',
      osmtogeojsonMs: 1.2,
      nodeIdEnrichMs: 0.5,
      totalServerMs: 8.0,
    },
  });
  tracker.recordConsoleDiagnosticsMs(req2, 0.4);
  tracker.markMapDataCommitted(req2, {
    buildings: 120,
    roads: 90,
    railways: 15,
    totalFeaturesParsed: 225,
  });
  tracker.markLoadingIndicatorHidden(req2);
  await new Promise((r) => setTimeout(r, 6));
  tracker.recordInfrastructurePrep(req2, performance.now() - 2, 2.0);
  tracker.recordSceneGeometryBuild(req2, {
    effectStartedAtMs: performance.now() - 4,
    buildDurationMs: 4.0,
    sceneRevision: 1,
    triangles: 48000,
    drawCalls: 42,
  });

  await new Promise((r) => setTimeout(r, 8));
  const completed = tracker.markScenePresented(1);
  assert.ok(completed);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.sceneRevision, 1);
  assert.equal(completed.network.cacheStatus, 'cold_miss');
  assert.ok(completed.timings.totalLoadingMs !== null && completed.timings.totalLoadingMs >= 0);
  assert.ok(
    Math.abs(
      completed.accounting.accountedMs +
        completed.accounting.unaccountedMs -
        (completed.accounting.totalMs ?? 0)
    ) <= 0.1,
    `accounted (${completed.accounting.accountedMs}) + unaccounted (${completed.accounting.unaccountedMs}) should equal total (${completed.accounting.totalMs})`
  );
  assert.ok(
    completed.spinner.prematureSpinnerHideMs !== null &&
      completed.spinner.prematureSpinnerHideMs >= 0,
    'spinner hide timing before presentation must be captured'
  );

  // Subsequent presentation callbacks on same revision must be ignored
  assert.equal(tracker.markScenePresented(1), null);
  assert.equal(tracker.hasFinalizedPresentation(req2), true);

  // 3. Simulate a failed request
  const reqFail = tracker.startLoad({
    locationId: 'custom',
    locationName: 'Bad Coordinates',
    sourceType: 'address_search',
    rendererConfig: {
      roadsMode: 'graph-surface',
      railwaysMode: 'graph-R+',
      railwayPrototypeMode: 'production',
      themeId: 'tactical',
    },
  });
  const failedRecord = tracker.markLoadFailed(reqFail, 'Overpass timeout (504)');
  assert.ok(failedRecord);
  assert.equal(failedRecord.status, 'failed');
  assert.equal(failedRecord.errorMessage, 'Overpass timeout (504)');

  // 4. Repeated loads must stay strictly bounded by maxHistory
  for (let i = 0; i < 60; i++) {
    const r = tracker.startLoad({
      locationId: `repeat_${i}`,
      locationName: `Repeat ${i}`,
      sourceType: 'fixture',
      rendererConfig: {
        roadsMode: 'graph-surface',
        railwaysMode: 'graph-R+',
        railwayPrototypeMode: 'production',
        themeId: 'tactical',
      },
    });
    const rev = 100 + i;
    tracker.markMapDataCommitted(r);
    tracker.recordInfrastructurePrep(r, performance.now(), 0);
    tracker.recordSceneGeometryBuild(r, {
      effectStartedAtMs: performance.now(),
      buildDurationMs: 1.5,
      sceneRevision: rev,
    });
    tracker.markScenePresented(rev);
  }

  assert.equal(tracker.getHistory().length, 5);
});

test('OsmApiProvider records separated transfer, decode, parse, and Server-Timing cold/warm cache states identically to LocalGeoJsonProvider', async () => {
  const rawGeoJson = JSON.parse(readFileSync(FORK_FIXTURE_PATH, 'utf-8'));
  const baselineParser = new LocalGeoJsonProvider();
  const baselineParsed = baselineParser.parseGeoJson(
    rawGeoJson,
    'Prins Fork Test',
    [4.8979, 52.3774],
    400
  );

  let hitCount = 0;
  const server = http.createServer((req, res) => {
    hitCount++;
    const isHit = hitCount > 1;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-OSM-Cache', isHit ? 'HIT' : 'MISS');
    res.setHeader('X-OSM-Source', isHit ? 'cache' : 'overpass');
    res.setHeader(
      'Server-Timing',
      isHit
        ? 'cache;dur=0.150, total;dur=0.250'
        : 'cache;dur=0.100, upstream;dur=120.500, osmtogeojson;dur=8.200, enrich;dur=1.100, total;dur=130.000'
    );
    res.end(JSON.stringify(rawGeoJson));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;

  // Temporarily intercept global fetch targeting localhost:3000 -> our ephemeral test server port
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' ? input : input.toString();
    const rewritten = rawUrl.replace('http://localhost:3000', `http://127.0.0.1:${port}`);
    return originalFetch(rewritten, init);
  };

  try {
    const provider = new OsmApiProvider();

    // Cold load
    const coldParsed = await provider.loadRegion({
      centerLat: 52.3774,
      centerLon: 4.8979,
      radiusMeters: 400,
      locationName: 'Prins Fork Test',
    });
    const coldMetrics = provider.getLastLoadMetrics();
    assert.ok(coldMetrics);
    assert.equal(coldMetrics.cacheStatus, 'cold_miss');
    assert.equal(coldMetrics.serverTimings?.upstreamSource, 'overpass');
    assert.equal(coldMetrics.serverTimings?.upstreamFetchMs, 120.5);
    assert.ok(coldMetrics.responseTransferMs !== null && coldMetrics.responseTransferMs >= 0);
    assert.ok(coldMetrics.jsonDecodeMs !== null && coldMetrics.jsonDecodeMs >= 0);
    assert.ok(coldMetrics.geoJsonProcessingMs >= 0);
    assert.ok(coldMetrics.payloadBytes && coldMetrics.payloadBytes > 0);
    assert.deepEqual(coldParsed.stats, baselineParsed.stats);
    assert.deepEqual(coldParsed.bounds, baselineParsed.bounds);

    // Warm load
    const warmParsed = await provider.loadRegion({
      centerLat: 52.3774,
      centerLon: 4.8979,
      radiusMeters: 400,
      locationName: 'Prins Fork Test',
    });
    const warmMetrics = provider.getLastLoadMetrics();
    assert.ok(warmMetrics);
    assert.equal(warmMetrics.cacheStatus, 'warm_hit');
    assert.equal(warmMetrics.serverTimings?.upstreamSource, 'cache');
    assert.equal(warmMetrics.serverTimings?.upstreamFetchMs, null);
    assert.deepEqual(warmParsed.stats, baselineParsed.stats);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Deterministic local dataset end-to-end instrumentation has negligible overhead and preserves GeometryBuilder output', () => {
  const rawGeoJson = JSON.parse(readFileSync(FORK_FIXTURE_PATH, 'utf-8'));

  // Run real pipeline on local dataset with tracker
  const tracker = new MapLoadTimelineTracker();
  const requestId = tracker.startLoad({
    locationId: 'm23_prins_fork',
    locationName: 'Prins Hendrikkade Fork',
    radiusMeters: 60,
    sourceType: 'fixture',
    rendererConfig: {
      roadsMode: 'graph-surface',
      railwaysMode: 'graph-R+',
      railwayPrototypeMode: 'production',
      themeId: 'tactical',
    },
  });

  const provider = new LocalGeoJsonProvider();
  const tParse0 = performance.now();
  const parsed = provider.parseGeoJson(
    rawGeoJson,
    'Prins Hendrikkade Fork',
    [4.8979247, 52.3773823],
    60
  );
  const tParse1 = performance.now();

  tracker.recordLocalTransferAndParse(requestId, {
    geoJsonProcessingMs: tParse1 - tParse0,
    geoJsonSubTimingsMs: provider.getLastParseSubTimings(),
    featureCount: rawGeoJson.features.length,
  });
  tracker.markMapDataCommitted(requestId, {
    buildings: parsed.stats.totalBuildings,
    roads: parsed.stats.totalRoads,
    railways: parsed.stats.totalRailways,
    totalFeaturesParsed: parsed.diagnostics.totalFeaturesParsed,
  });
  tracker.markLoadingIndicatorHidden(requestId);

  const tPrep0 = performance.now();
  const preview = prepareInfrastructureRenderPreview(parsed, {
    roads: 'graph-surface',
    railways: 'graph-R+',
  });
  const tPrep1 = performance.now();
  tracker.recordInfrastructurePrep(requestId, tPrep0, tPrep1 - tPrep0);

  const tEffect0 = performance.now();
  const builder = new GeometryBuilder({
    infrastructureRenderOptions: { roads: 'graph-surface', railways: 'graph-R+' },
    infrastructureRenderPreview: preview,
  });
  const tBuild0 = performance.now();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);
  const tBuild1 = performance.now();

  tracker.recordSceneGeometryBuild(requestId, {
    effectStartedAtMs: tEffect0,
    buildDurationMs: tBuild1 - tBuild0,
    sceneRevision: 1,
    triangles: scene.stats.totalTriangles,
    drawCalls: scene.stats.totalDrawCalls,
  });

  const completed = tracker.markScenePresented(1);
  assert.ok(completed);
  assert.equal(completed.status, 'completed');
  assert.ok(completed.timings.geoJsonProcessingMs! >= 0);
  assert.ok(completed.timings.infrastructurePreparationMs! >= 0);
  assert.ok(completed.timings.sceneGeometryMs! >= 0);
  assert.ok(completed.timings.totalLoadingMs! >= 0);
  assert.ok(
    completed.accounting.instrumentationOverheadMs < 2.0,
    `Expected <2ms instrumentation overhead, got ${completed.accounting.instrumentationOverheadMs}ms`
  );

  // Verify uninstrumented identical scene output
  const uninstrumentedScene = new GeometryBuilder({
    infrastructureRenderOptions: { roads: 'graph-surface', railways: 'graph-R+' },
    infrastructureRenderPreview: prepareInfrastructureRenderPreview(parsed, {
      roads: 'graph-surface',
      railways: 'graph-R+',
    }),
  }).buildScene(parsed, MAP_THEMES.tactical);

  assert.equal(scene.stats.totalTriangles, uninstrumentedScene.stats.totalTriangles);
  assert.equal(scene.stats.totalDrawCalls, uninstrumentedScene.stats.totalDrawCalls);
  assert.equal(scene.stats.totalVertices, uninstrumentedScene.stats.totalVertices);

  scene.dispose();
  uninstrumentedScene.dispose();
});
