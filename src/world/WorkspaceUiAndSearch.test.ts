import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createServer as createViteServer } from 'vite';
import {
  WORKSPACE_PREFS_STORAGE_KEY,
  cycleNavSidebarMode,
  loadWorkspacePreferences,
  mapLegacyTabToPanelId,
  pickSearchTargetZoom,
  saveWorkspacePreferences,
  togglePanelSelection,
  type StorageLike,
} from '../components/workspace/workspaceTypes';
import {
  buildOverijsselSearchIndex,
} from '../server/osm/OverijsselSearchIndex';
import { createSearchDataHandler } from '../server/osm/searchDataHandler';
import {
  OVERIJSSEL_INDEX_SCHEMA_VERSION,
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  OVERIJSSEL_SNAPSHOT_ID,
} from '../server/osm/overijsselConfig';
import { createRegionalMosaicHttpHandler } from '../server/tiles/RegionalMosaicHttpHandler';
import { bakeStudyRegionTilesToSqlite } from '../server/tiles/OfflineHengeloTileBaker';
import {
  createRegionalMosaicPlan,
  TWENTE_PILOT_CONFIG,
  type RegionalMosaicIndex,
} from './tiling/RegionalMosaicPlan';
import { ingestCanonicalStudyGeoJson } from './tiling/TiledStudyPipeline';
import {
  CANONICAL_HENGELO_SNAPSHOT_ID,
  CANONICAL_HENGELO_SOURCE_SHA256,
} from './tiling/TilePackContract';
import { utm32NToGeo } from './tiling/RegionalProjection';

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function findPlaywrightChromiumExecutable(): string | undefined {
  const envExec = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (envExec && fs.existsSync(envExec)) return envExec;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright';
  if (!fs.existsSync(root)) return undefined;
  const direct = path.join(root, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
  if (fs.existsSync(direct)) return direct;
  for (const entry of fs.readdirSync(root)) {
    if (entry.startsWith('chromium_headless_shell-')) {
      const candidate = path.join(
        root,
        entry,
        'chrome-headless-shell-linux64',
        'chrome-headless-shell'
      );
      if (fs.existsSync(candidate)) return candidate;
    }
    if (entry.startsWith('chromium-')) {
      const candidate = path.join(root, entry, 'chrome-linux', 'chrome');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function createE2eSpatialDb(sqlitePath: string, emptyTileLon: number, emptyTileLat: number): void {
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE nodes (id INTEGER PRIMARY KEY, lon REAL NOT NULL, lat REAL NOT NULL, tags_json TEXT);
      CREATE VIRTUAL TABLE tagged_node_rtree USING rtree(id, min_lon, max_lon, min_lat, max_lat);
      CREATE TABLE ways (id INTEGER PRIMARY KEY, refs_json TEXT NOT NULL, tags_json TEXT);
      CREATE VIRTUAL TABLE way_rtree USING rtree(id, min_lon, max_lon, min_lat, max_lat);
      CREATE TABLE relations (id INTEGER PRIMARY KEY, members_json TEXT NOT NULL, tags_json TEXT);
      CREATE VIRTUAL TABLE relation_rtree USING rtree(id, min_lon, max_lon, min_lat, max_lat);
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

    // Covered settlement & station inside populated central tile around Hengelo
    addNode(101, 6.7935, 52.2625, { place: 'town', name: 'Hengelo' });
    addNode(102, 6.7942, 52.2621, { railway: 'station', name: 'Station Hengelo' });
    // Entry inside confirmed empty corner tile
    addNode(103, emptyTileLon, emptyTileLat, {
      amenity: 'shelter',
      name: 'EmptyCorner Shelter',
    });
    // Entry completely outside the 4x4 regional mosaic
    addNode(104, 6.083, 52.5168, { place: 'city', name: 'Zwolle' });

    const insertMeta = db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
    for (const [k, v] of [
      ['schema_version', OVERIJSSEL_INDEX_SCHEMA_VERSION],
      ['snapshot_id', OVERIJSSEL_SNAPSHOT_ID],
      ['snapshot_mode', 'custom'],
      ['source_file', 'e2e-synthetic.osm.pbf'],
      ['source_sha256', OVERIJSSEL_PBF_EXPECTED_SHA256],
      ['osm_timestamp_iso', '2026-11-14T21:20:41.000Z'],
      ['attribution', 'Synthetic E2E OSM'],
      ['indexed_at_iso', '2026-11-24T00:00:00.000Z'],
      ['node_count', '4'],
      ['tagged_node_count', '4'],
      ['way_count', '0'],
      ['relation_count', '0'],
      ['bbox_min_lon', '6.0'],
      ['bbox_max_lon', '7.0'],
      ['bbox_min_lat', '52.1'],
      ['bbox_max_lat', '52.6'],
    ]) {
      insertMeta.run(k, v);
    }
  } finally {
    db.close();
  }
}

test('Workspace pure state helpers manage panel toggles, nav rail modes, legacy tabs, and localStorage persistence', () => {
  // Active item toggle closes right panel; clicking different item switches cleanly
  assert.equal(togglePanelSelection(null, 'search'), 'search');
  assert.equal(togglePanelSelection('search', 'search'), null);
  assert.equal(togglePanelSelection('search', 'world'), 'world');

  // Navigation rail cycle: expanded -> compact -> hidden -> expanded
  assert.equal(cycleNavSidebarMode('expanded'), 'compact');
  assert.equal(cycleNavSidebarMode('compact'), 'hidden');
  assert.equal(cycleNavSidebarMode('hidden'), 'expanded');

  // Legacy URL tab compatibility
  assert.equal(mapLegacyTabToPanelId('layers'), 'layers');
  assert.equal(mapLegacyTabToPanelId('inspector'), 'inspector');
  assert.equal(mapLegacyTabToPanelId('style'), 'appearance');
  assert.equal(mapLegacyTabToPanelId('stats'), 'performance');
  assert.equal(mapLegacyTabToPanelId('info'), 'diagnostics');

  // Category zoom presets stay sensible
  assert.ok(pickSearchTargetZoom('place') < pickSearchTargetZoom('street'));
  assert.ok(pickSearchTargetZoom('street') < pickSearchTargetZoom('address'));

  // localStorage persistence & invalid JSON resilience
  const storage = createMemoryStorage();
  saveWorkspacePreferences(
    { navMode: 'compact', activePanel: 'world', hideCameraToolbar: true },
    storage
  );
  assert.deepEqual(loadWorkspacePreferences(storage), {
    navMode: 'compact',
    activePanel: 'world',
    hideCameraToolbar: true,
  });

  storage.setItem(WORKSPACE_PREFS_STORAGE_KEY, '{corrupt json');
  assert.deepEqual(loadWorkspacePreferences(storage), {
    navMode: 'expanded',
    activePanel: null,
    hideCameraToolbar: false,
  });
});

test('Obsolete legacy UI components and external /api/geocode route are removed', () => {
  const repoRoot = process.cwd();
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'src/components/AddressSearchModal.tsx')),
    false,
    'AddressSearchModal.tsx must be deleted'
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'src/components/DevToolsPanel.tsx')),
    false,
    'DevToolsPanel.tsx must be deleted'
  );
  const serverSource = fs.readFileSync(path.join(repoRoot, 'server.ts'), 'utf-8');
  assert.equal(
    serverSource.includes('/api/geocode'),
    false,
    'Legacy /api/geocode route must not exist in server.ts'
  );
  assert.equal(
    serverSource.includes('searchController.searchHandler'),
    true,
    'Offline SQLite search handler must be mounted in server.ts'
  );
});

test('Playwright E2E: workspace boots regional mosaic directly, preserves canvas on sidebar toggles, clamps camera toolbar, and navigates local search results without external geocoding', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-e2e-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 1. Bake a real temporary 4x4 OSMTILE1 single-shard mosaic around Hengelo
  const mosaicName = 'twente-e2e-temp-1024m';
  const mosaicDir = path.join(tmpDir, mosaicName);
  fs.mkdirSync(mosaicDir, { recursive: true });
  const plan = createRegionalMosaicPlan({
    ...TWENTE_PILOT_CONFIG,
    name: mosaicName,
    centerLonLat: [6.7935, 52.2625],
    cols: 4,
    rows: 4,
  });
  const shard = plan.shards[0];

  // Minimal study GeoJSON inside central tile near [6.7935, 52.2625] so center tiles are populated and corner tile is empty
  const studyGeoJson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'way/9001',
        properties: { highway: 'primary', name: 'Stationsstraat' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [6.7925, 52.2624],
            [6.7945, 52.2626],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'way/9002',
        properties: { building: 'yes', name: 'Hengelo Hub', height: '14' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7932, 52.2621],
              [6.7938, 52.2621],
              [6.7938, 52.2624],
              [6.7932, 52.2624],
              [6.7932, 52.2621],
            ],
          ],
        },
      },
    ],
  };

  const ingested = ingestCanonicalStudyGeoJson(studyGeoJson, shard.grid);
  const shardFile = `${shard.id}.sqlite`;
  const shardPath = path.join(mosaicDir, shardFile);
  const bakeReport = bakeStudyRegionTilesToSqlite({
    ingested,
    outPath: shardPath,
    snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
    sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
  });
  assert.ok(bakeReport.tileCounts.nonEmptyTiles >= 1);
  assert.ok(bakeReport.tileCounts.emptyTiles >= 1);

  const mosaicIndex: RegionalMosaicIndex = {
    schemaVersion: 1,
    config: plan.config,
    snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
    sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
    shards: [{ id: shard.id, file: shardFile }],
  };
  const mosaicIndexPath = path.join(mosaicDir, 'mosaic.json');
  fs.writeFileSync(mosaicIndexPath, JSON.stringify(mosaicIndex, null, 2));

  // Locate a guaranteed empty tile's center coordinates
  const cornerTile = shard.grid.tiles[0];
  const [emptyLon, emptyLat] = utm32NToGeo(
    (cornerTile.utmBounds.minEasting + cornerTile.utmBounds.maxEasting) * 0.5,
    (cornerTile.utmBounds.minNorthing + cornerTile.utmBounds.maxNorthing) * 0.5
  );

  // 2. Build temp spatial & FTS5 search index
  const spatialPath = path.join(tmpDir, 'twente-e2e.sqlite');
  const searchPath = path.join(tmpDir, 'twente-e2e.search.sqlite');
  createE2eSpatialDb(spatialPath, emptyLon, emptyLat);
  buildOverijsselSearchIndex({
    spatialIndexPath: spatialPath,
    outSearchIndexPath: searchPath,
    allowCustomSnapshot: true,
    onProgress: () => {},
  });

  // 3. Start isolated Express + Vite middleware server on ephemeral port
  const mosaicCtrl = createRegionalMosaicHttpHandler({ indexPath: mosaicIndexPath });
  const searchCtrl = createSearchDataHandler({
    spatialIndexPath: spatialPath,
    searchIndexPath: searchPath,
    allowCustomSnapshot: true,
    getMosaicCoverage: mosaicCtrl.getCoverageSnapshot,
  });

  const app = express();
  app.use(express.json());
  app.get('/api/search', searchCtrl.searchHandler);
  app.get('/api/search/status', searchCtrl.statusHandler);
  app.post('/api/search/build', searchCtrl.buildHandler);
  app.get('/api/tiles-region/manifest', mosaicCtrl.manifestHandler);
  app.get('/api/tiles-region/:lod/:tx/:ty', mosaicCtrl.tilePayloadHandler);
  app.get(
    '/api/tiles-region/:snapshotId/:schemaVersion/:lod/:tx/:ty',
    mosaicCtrl.tilePayloadHandler
  );

  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'spa',
  });
  app.use(vite.middlewares);

  const httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    searchCtrl.close();
    mosaicCtrl.close();
    await vite.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  // 4. Launch Playwright Chromium
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/ms-playwright')) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright';
  }
  const playwright = await import('playwright');
  const executablePath = findPlaywrightChromiumExecutable();
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
    ],
  });
  t.after(async () => {
    await browser.close();
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 860 },
  });
  const page = await context.newPage();
  await page.addInitScript('window.__name = (fn) => fn;');

  const requestedUrls: string[] = [];
  const externalBlocked: string[] = [];
  await page.route('**/*', (route) => {
    const reqUrl = route.request().url();
    requestedUrls.push(reqUrl);
    if (
      reqUrl.startsWith(baseUrl) ||
      reqUrl.startsWith('data:') ||
      reqUrl.startsWith('blob:')
    ) {
      return route.continue();
    }
    // Fonts CSS from Google Fonts may be requested in dev HTML; abort without failing core app
    externalBlocked.push(reqUrl);
    return route.abort();
  });

  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for regional manifest load & 3D canvas readiness
  await page.waitForSelector('[data-testid="workspace-root"]', { timeout: 20000 });
  await page.waitForFunction(
    () => {
      const h = (window as any).__M21_LAB__;
      return (
        h &&
        h.getActiveMosaicIdentity?.()?.status === 'loaded' &&
        Boolean(document.querySelector('canvas'))
      );
    },
    undefined,
    { timeout: 25000 }
  );

  // Verify direct boot into regional mosaic and zero external geocoding / overpass requests
  assert.ok(
    requestedUrls.some((u) => u.includes('/api/tiles-region/manifest')),
    'Must boot directly from /api/tiles-region/manifest'
  );
  assert.equal(
    requestedUrls.some((u) => u.includes('/api/geocode')),
    false,
    'Must never request obsolete /api/geocode'
  );
  assert.equal(
    externalBlocked.some((u) => /photon|overpass|nominatim/i.test(u)),
    false,
    'Must never attempt external geocoding or Overpass requests'
  );

  // Verify 3-region layout initial state (nav expanded, no right panel open initially, camera toolbar visible)
  const navModeInit = await page.getAttribute('[data-testid="workspace-nav-sidebar"]', 'data-nav-mode');
  assert.equal(navModeInit, 'expanded');
  assert.equal(await page.locator('[data-testid="workspace-context-sidebar"]').count(), 0);
  assert.equal(await page.locator('[data-testid="viewport-camera-toolbar"]').isVisible(), true);

  // Tag the canvas instance on window so we can prove sidebar toggling NEVER remounts <Canvas>
  await page.evaluate(() => {
    (window as any).__E2E_CANVAS_REF__ = document.querySelector('canvas');
  });

  // Toggle World panel and verify active temp mosaic details & zoom policy
  await page.click('[data-testid="nav-item-world"]');
  await page.waitForSelector('[data-testid="panel-world"]');
  assert.equal(
    await page.textContent('[data-testid="active-mosaic-name"]'),
    mosaicName
  );
  assert.equal(
    await page.textContent('[data-testid="effective-min-zoom"]'),
    '0.15x'
  );
  const gridFootprintText = await page.textContent('[data-testid="world-grid-footprint"]');
  assert.ok(gridFootprintText && gridFootprintText.includes('4×4'));

  // Toggle Appearance panel & verify baked tile geometry lock notice
  await page.click('[data-testid="nav-item-appearance"]');
  await page.waitForSelector('[data-testid="appearance-baked-geometry-notice"]');

  // Toggle active item ('appearance') to close right sidebar
  await page.click('[data-testid="nav-item-appearance"]');
  assert.equal(await page.locator('[data-testid="workspace-context-sidebar"]').count(), 0);

  // Collapse nav sidebar -> compact, then hide -> restore UI
  await page.click('[data-testid="btn-nav-toggle-compact"]');
  assert.equal(
    await page.getAttribute('[data-testid="workspace-nav-sidebar"]', 'data-nav-mode'),
    'compact'
  );
  await page.click('[data-testid="btn-enter-immersive-mode"]');
  assert.equal(await page.locator('[data-testid="workspace-nav-sidebar"]').count(), 0);
  assert.equal(await page.locator('[data-testid="viewport-camera-toolbar"]').count(), 0);
  assert.equal(await page.locator('[data-testid="btn-restore-workspace-ui"]').isVisible(), true);

  // Restore UI & verify <Canvas> is still the exact same DOM node (zero remount!)
  await page.click('[data-testid="btn-restore-workspace-ui"]');
  assert.equal(
    await page.getAttribute('[data-testid="workspace-nav-sidebar"]', 'data-nav-mode'),
    'expanded'
  );
  const sameCanvas = await page.evaluate(
    () => (window as any).__E2E_CANVAS_REF__ === document.querySelector('canvas')
  );
  assert.equal(sameCanvas, true, 'Toggling workspace UI must never remount WebGL <Canvas>');

  // Verify persistence across page.reload()
  await page.click('[data-testid="nav-item-layers"]');
  await page.click('[data-testid="btn-nav-toggle-compact"]');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="workspace-context-sidebar"]', { timeout: 20000 });
  assert.equal(
    await page.getAttribute('[data-testid="workspace-nav-sidebar"]', 'data-nav-mode'),
    'compact'
  );
  assert.equal(
    await page.getAttribute('[data-testid="workspace-context-sidebar"]', 'data-active-panel'),
    'layers'
  );

  // Verify CameraToolbar rotate & zoom clamping
  await page.waitForFunction(
    () => Boolean((window as any).__M21_LAB__?.getCameraState?.()),
    undefined,
    { timeout: 15000 }
  );
  const beforeCompass = await page.textContent('[data-testid="camera-compass-indicator"]');
  const beforeCam = await page.evaluate(() => (window as any).__M21_LAB__.getCameraState());
  await page.click('[data-testid="btn-camera-rotate-right"]');
  await page.waitForTimeout(250);
  const afterCompass = await page.textContent('[data-testid="camera-compass-indicator"]');
  const afterRotateCam = await page.evaluate(() => (window as any).__M21_LAB__.getCameraState());
  assert.notEqual(
    afterCompass,
    beforeCompass,
    `Rotate right button must update compass orientation (before=${beforeCompass}, after=${afterCompass})`
  );
  assert.notDeepEqual(
    afterRotateCam.position,
    beforeCam.position,
    'Rotate right button must move camera position'
  );

  // Zoom out repeatedly and confirm zoom stops cleanly at minZoom (0.15) and disables zoom-out
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(80);
    const disabled = await page.isDisabled('[data-testid="btn-camera-zoom-out"]');
    if (disabled) break;
    try {
      await page.click('[data-testid="btn-camera-zoom-out"]', { timeout: 1000 });
    } catch {
      if (await page.isDisabled('[data-testid="btn-camera-zoom-out"]')) break;
      throw new Error('Zoom-out click failed unexpectedly before reaching minZoom');
    }
  }
  await page.waitForTimeout(150);
  const minZoomCam = await page.evaluate(() => (window as any).__M21_LAB__.getCameraState());
  assert.ok(
    minZoomCam.zoom >= 0.149 && minZoomCam.zoom <= 0.16,
    `Camera zoom (${minZoomCam.zoom}) must stop cleanly at regional minZoom 0.15`
  );
  assert.equal(
    await page.isDisabled('[data-testid="btn-camera-zoom-out"]'),
    true,
    'Zoom-out button must be disabled at minZoom 0.15'
  );

  // Verify offline Search flow: covered result navigates camera; empty/outside results stay disabled
  await page.click('[data-testid="nav-item-search"]');
  await page.waitForSelector('[data-testid="search-panel-input"]');

  // 1) Empty tile entry must render disabled
  await page.fill('[data-testid="search-panel-input"]', 'EmptyCorner');
  await page.waitForSelector('[data-testid="search-result-node/103"]', { timeout: 10000 });
  assert.equal(
    await page.isDisabled('[data-testid="search-result-node/103"]'),
    true,
    'Empty tile search result must be disabled'
  );

  // 2) Outside mosaic entry must render disabled
  await page.fill('[data-testid="search-panel-input"]', 'Zwolle');
  await page.waitForSelector('[data-testid="search-result-node/104"]', { timeout: 10000 });
  assert.equal(
    await page.isDisabled('[data-testid="search-result-node/104"]'),
    true,
    'Outside-mosaic search result must be disabled'
  );

  // 3) Covered Hengelo Station must be enabled and clicking it moves/zooms camera
  await page.fill('[data-testid="search-panel-input"]', 'Station Hengelo');
  await page.waitForSelector('[data-testid="search-result-node/102"]', { timeout: 10000 });
  assert.equal(await page.isDisabled('[data-testid="search-result-node/102"]'), false);
  await page.click('[data-testid="search-result-node/102"]');
  await page.waitForTimeout(450);
  const afterSearchCam = await page.evaluate(() => (window as any).__M21_LAB__.getCameraState());
  assert.ok(
    afterSearchCam.zoom >= 1.5,
    `Clicking station result should zoom camera in >= 1.5x (got ${afterSearchCam.zoom})`
  );

  assert.deepEqual(consoleErrors, [], `Unexpected page errors: ${consoleErrors.join('; ')}`);
});
