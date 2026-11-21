import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import * as THREE from 'three';
import { MAP_THEMES } from '../styles/mapThemes';
import {
  bakeStudyRegionTilesToSqlite,
  disposeIngestedStudyRegionPlans,
} from '../server/tiles/OfflineHengeloTileBaker';
import {
  createTilePackHttpHandler,
  type TilePackManifestHttpResponse,
} from '../server/tiles/tilePackHttpHandler';
import { resolveInspectedFeature } from './GeometryBuilder';
import {
  createAlignedStudyGrid,
  formatTileId,
  type StudyGridSpec,
} from './tiling/TileGrid';
import { ingestCanonicalStudyGeoJson } from './tiling/TiledStudyPipeline';
import { decodeTileBinary } from './tiling/TileBinaryCodec';
import { createTileDecodeClient } from './tiling/TileDecodeClient';
import { collectDecodedTileTransferables } from './tiling/TileDecodeWorker';
import {
  computeViewportGroundBoundsForCamera,
  TileStreamManager,
} from './tiling/TileStreamManager';
import { BAKE_SCHEMA_VERSION } from './tiling/TilePackContract';

function buildStreamingStudyGeoJson(grid: StudyGridSpec) {
  const toLonLat = (x: number, z: number): [number, number] =>
    grid.projection.toGeo(x, z);
  const ringToLonLat = (pts: Array<[number, number]>) => [
    pts.map(([x, z]) => toLonLat(x, z)),
  ];

  return {
    type: 'FeatureCollection',
    features: [
      // Central residential landuse spanning center 4 tiles
      {
        type: 'Feature',
        id: 'way/landuse-res',
        properties: {
          id: 'way/landuse-res',
          landuse: 'residential',
          name: 'Centrum',
        },
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
      // NW corner building in tile (-1024..-512, -1024..-512)
      {
        type: 'Feature',
        id: 'way/bldg-nw-corner',
        properties: {
          id: 'way/bldg-nw-corner',
          building: 'industrial',
          name: 'NW Depot',
          height: '16',
        },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [-800, -800],
            [-760, -800],
            [-760, -760],
            [-800, -760],
            [-800, -800],
          ]),
        },
      },
      // SE corner building in tile (512..1024, 512..1024)
      {
        type: 'Feature',
        id: 'way/bldg-se-corner',
        properties: {
          id: 'way/bldg-se-corner',
          building: 'office',
          name: 'SE Hub',
          height: '22',
        },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [740, 740],
            [780, 740],
            [780, 780],
            [740, 780],
            [740, 740],
          ]),
        },
      },
      // Center seam-crossing building
      {
        type: 'Feature',
        id: 'way/bldg-seam-owner',
        properties: {
          id: 'way/bldg-seam-owner',
          building: 'commercial',
          name: 'Seam Mall',
          height: '14',
        },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [-12, -130],
            [12, -130],
            [12, -110],
            [-12, -110],
            [-12, -130],
          ]),
        },
      },
      // Primary road crossing W -> E across 4 tiles
      {
        type: 'Feature',
        id: 'way/road-primary-w',
        properties: {
          id: 'way/road-primary-w',
          highway: 'primary',
          name: 'Enschedesestraat',
        },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-850, -20), toLonLat(0, -20), toLonLat(850, -20)],
        },
      },
      // Railway crossing W -> E with turnout
      {
        type: 'Feature',
        id: 'way/rail-main-1',
        properties: {
          id: 'way/rail-main-1',
          railway: 'rail',
          electrified: 'contact_line',
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            toLonLat(-800, -185),
            toLonLat(-20, -185),
            toLonLat(800, -185),
          ],
        },
      },
      {
        type: 'Feature',
        id: 'way/rail-turnout',
        properties: {
          id: 'way/rail-turnout',
          railway: 'rail',
          service: 'siding',
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            toLonLat(-20, -185),
            toLonLat(-5, -187.5),
            toLonLat(40, -195),
            toLonLat(150, -195),
          ],
        },
      },
      // Water pond
      {
        type: 'Feature',
        id: 'way/water-cross',
        properties: {
          id: 'way/water-cross',
          natural: 'water',
          water: 'pond',
        },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [-70, 110],
            [70, 110],
            [70, 170],
            [-70, 170],
            [-70, 110],
          ]),
        },
      },
    ],
  };
}

async function startTestTileServer(
  options: Parameters<typeof createTilePackHttpHandler>[0]
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
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
  const baseUrl = `http://127.0.0.1:${addr.port}/api/tiles`;

  return {
    baseUrl,
    close: async () => {
      controller.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

test('Express tilePackHttpHandler serves manifest and OSMTILE1 binary payloads with strict validation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-m2a-http-'));
  const packPath = path.join(tmpDir, 'm2a-tiles.sqlite');

  const grid = createAlignedStudyGrid({
    name: 'synthetic-4x4-m2a-http',
    centerLonLat: [6.7935, 52.2625],
    cols: 4,
    rows: 4,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const ingested = ingestCanonicalStudyGeoJson(
    buildStreamingStudyGeoJson(grid),
    grid
  );
  const snapshotId = 'synthetic-m2a-snapshot';
  const sourceSha256 = 'b'.repeat(64);

  try {
    bakeStudyRegionTilesToSqlite({
      ingested,
      outPath: packPath,
      snapshotId,
      sourceSha256,
      batchDimension: 2,
      includeBvh: true,
      theme: MAP_THEMES.tactical,
    });
    disposeIngestedStudyRegionPlans(ingested);

    const srv = await startTestTileServer({
      packPath,
      expectedSnapshotId: snapshotId,
      expectedSourceSha256: sourceSha256,
      allowCustomSnapshot: true,
    });

    try {
      // 1. Fetch manifest
      const manifestRes = await fetch(`${srv.baseUrl}/manifest`);
      assert.equal(manifestRes.status, 200);
      assert.equal(manifestRes.headers.get('x-osm-snapshot-id'), snapshotId);
      assert.equal(
        manifestRes.headers.get('x-tile-bake-schema'),
        BAKE_SCHEMA_VERSION
      );
      const manifestJson =
        (await manifestRes.json()) as TilePackManifestHttpResponse;
      assert.equal(manifestJson.available, true);
      assert.equal(manifestJson.metadata.snapshotId, snapshotId);
      assert.equal(manifestJson.tiles.length, 16);

      // 2. Fetch a non-empty tile payload and decode it via decodeTileBinary
      const nonEmptyEntry = manifestJson.tiles.find((t) => !t.isEmpty);
      assert.ok(nonEmptyEntry, 'Expected at least one non-empty tile');
      const tileKey = formatTileId(nonEmptyEntry.tx, nonEmptyEntry.ty);

      const tileRes = await fetch(
        `${srv.baseUrl}/${nonEmptyEntry.lod}/${nonEmptyEntry.tx}/${nonEmptyEntry.ty}`
      );
      assert.equal(tileRes.status, 200);
      assert.equal(
        tileRes.headers.get('content-type'),
        'application/octet-stream'
      );
      assert.equal(tileRes.headers.get('x-tile-key'), tileKey);
      assert.equal(
        tileRes.headers.get('x-tile-content-hash'),
        nonEmptyEntry.contentHash
      );

      const arrayBuffer = await tileRes.arrayBuffer();
      assert.equal(arrayBuffer.byteLength, nonEmptyEntry.rawBytes);
      const decoded = decodeTileBinary(new Uint8Array(arrayBuffer), tileKey);
      assert.equal(decoded.tileKey, tileKey);
      assert.ok(decoded.meshes.length > 0);
      const transferables = collectDecodedTileTransferables(decoded);
      assert.ok(transferables.length > 0);

      // 3. Conditional ETag request returns 304 Not Modified
      const etag = tileRes.headers.get('etag');
      assert.ok(etag);
      const notModifiedRes = await fetch(
        `${srv.baseUrl}/${nonEmptyEntry.lod}/${nonEmptyEntry.tx}/${nonEmptyEntry.ty}`,
        { headers: { 'If-None-Match': etag } }
      );
      assert.equal(notModifiedRes.status, 304);

      // 4. Snapshot + schema route succeeds when matching, returns 409 on mismatch
      const versionedOk = await fetch(
        `${srv.baseUrl}/${snapshotId}/${BAKE_SCHEMA_VERSION}/${nonEmptyEntry.lod}/${nonEmptyEntry.tx}/${nonEmptyEntry.ty}`
      );
      assert.equal(versionedOk.status, 200);

      const badSnapshotRes = await fetch(
        `${srv.baseUrl}/wrong-snapshot/${BAKE_SCHEMA_VERSION}/${nonEmptyEntry.lod}/${nonEmptyEntry.tx}/${nonEmptyEntry.ty}`
      );
      assert.equal(badSnapshotRes.status, 409);

      const badSchemaRes = await fetch(
        `${srv.baseUrl}/${snapshotId}/9.9.9/${nonEmptyEntry.lod}/${nonEmptyEntry.tx}/${nonEmptyEntry.ty}`
      );
      assert.equal(badSchemaRes.status, 409);

      // 5. Invalid coordinates -> 400; out-of-range coordinates -> 404
      const invalidCoordsRes = await fetch(`${srv.baseUrl}/0/notanumber/10`);
      assert.equal(invalidCoordsRes.status, 400);

      const missingTileRes = await fetch(`${srv.baseUrl}/0/999999/999999`);
      assert.equal(missingTileRes.status, 404);
    } finally {
      await srv.close();
    }

    // 6. Missing pack -> 503
    const missingSrv = await startTestTileServer({
      packPath: path.join(tmpDir, 'nonexistent.sqlite'),
    });
    try {
      const res = await fetch(`${missingSrv.baseUrl}/manifest`);
      assert.equal(res.status, 503);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, 'TILE_PACK_MISSING');
    } finally {
      await missingSrv.close();
    }

    // 7. Incompatible bake schema version -> 503
    const badSchemaSrv = await startTestTileServer({
      packPath,
      expectedSnapshotId: snapshotId,
      expectedSourceSha256: sourceSha256,
      expectedBakeSchemaVersion: '0.0.1-legacy',
      allowCustomSnapshot: true,
    });
    try {
      const res = await fetch(`${badSchemaSrv.baseUrl}/manifest`);
      assert.equal(res.status, 503);
      const body = (await res.json()) as { code?: string; reason?: string };
      assert.equal(body.code, 'TILE_PACK_INCOMPATIBLE');
      assert.equal(body.reason, 'schema_version_mismatch');
    } finally {
      await badSchemaSrv.close();
    }

    // 8. Corrupted tile payload hash -> 503
    const db = new DatabaseSync(packPath);
    const firstRow = db
      .prepare('SELECT lod, tx, ty FROM tiles WHERE is_empty = 0 LIMIT 1')
      .get() as { lod: number; tx: number; ty: number };
    db.prepare(
      'UPDATE tile_manifest SET content_hash = ? WHERE lod = ? AND tx = ? AND ty = ?'
    ).run('f'.repeat(64), firstRow.lod, firstRow.tx, firstRow.ty);
    db.close();

    const corruptSrv = await startTestTileServer({
      packPath,
      expectedSnapshotId: snapshotId,
      expectedSourceSha256: sourceSha256,
      allowCustomSnapshot: true,
    });
    try {
      const res = await fetch(
        `${corruptSrv.baseUrl}/${firstRow.lod}/${firstRow.tx}/${firstRow.ty}`
      );
      assert.equal(res.status, 503);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, 'TILE_PACK_CORRUPT');
    } finally {
      await corruptSrv.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TileStreamManager streams viewport tiles, preserves BVH raycasting, themes, wireframe, and railway zoom', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-m2a-stream-'));
  const packPath = path.join(tmpDir, 'm2a-stream-tiles.sqlite');

  const grid = createAlignedStudyGrid({
    name: 'synthetic-4x4-m2a-stream',
    centerLonLat: [6.7935, 52.2625],
    cols: 4,
    rows: 4,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const ingested = ingestCanonicalStudyGeoJson(
    buildStreamingStudyGeoJson(grid),
    grid
  );
  const snapshotId = 'synthetic-m2a-stream';
  const sourceSha256 = 'c'.repeat(64);

  try {
    bakeStudyRegionTilesToSqlite({
      ingested,
      outPath: packPath,
      snapshotId,
      sourceSha256,
      batchDimension: 2,
      includeBvh: true,
      theme: MAP_THEMES.tactical,
    });
    disposeIngestedStudyRegionPlans(ingested);

    const srv = await startTestTileServer({
      packPath,
      expectedSnapshotId: snapshotId,
      expectedSourceSha256: sourceSha256,
      allowCustomSnapshot: true,
    });

    const decodeClient = createTileDecodeClient({ forceInline: true });
    const manager = new TileStreamManager({
      apiBaseUrl: srv.baseUrl,
      preloadMarginTiles: 1,
      retainMarginTiles: 1,
      maxConcurrentFetches: 4,
      maxCommitsPerFrame: 2,
      initialTheme: MAP_THEMES.tactical,
      initialCameraZoom: 2.0,
      decodeClient,
    });

    try {
      const meta = await manager.initialize();
      assert.equal(meta.snapshotId, snapshotId);
      assert.equal(meta.gridCols * meta.gridRows, 16);

      // Focus camera tightly on the NW corner tile [-900..-600, -900..-600]
      // Visible: 1 tile (NW corner, index [0,0]). Preload margin 1 tile: 2x2 = 4 tiles in NW quadrant.
      manager.updateViewport({
        minX: -900,
        maxX: -600,
        minZ: -900,
        maxZ: -600,
        focusX: -750,
        focusZ: -750,
        cameraZoom: 2.5,
      });

      await manager.waitForIdle();
      const nwDiag = manager.getDiagnostics();
      assert.equal(nwDiag.visibleTiles, 1);
      assert.equal(nwDiag.fetchTargetTiles, 4);
      assert.equal(nwDiag.loadedTiles, 4);
      assert.equal(nwDiag.loadingTiles, 0);
      assert.equal(nwDiag.failedTiles, 0);

      // Now pan to center [-200..200, -200..200] where the central 2x2 tiles are visible
      manager.updateViewport({
        minX: -200,
        maxX: 200,
        minZ: -200,
        maxZ: 200,
        focusX: 0,
        focusZ: 0,
        cameraZoom: 2.0,
      });
      await manager.waitForIdle();

      const centerDiag = manager.getDiagnostics();
      assert.equal(centerDiag.visibleTiles, 4);
      assert.equal(centerDiag.loadedTiles, 16);
      assert.ok(centerDiag.loadedTriangles > 0);
      assert.ok(centerDiag.activeTileGeometries > 0);
      assert.ok(centerDiag.activeTileBvhs > 0);

      // Verify BVH raycasting + resolveInspectedFeature on streamed scene
      const raycaster = new THREE.Raycaster();
      (raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly =
        true;

      // 1. Raycast straight down onto 'way/bldg-seam-owner' at (0, 50, -120)
      raycaster.set(
        new THREE.Vector3(0, 50, -120),
        new THREE.Vector3(0, -1, 0)
      );
      const bldgHits = raycaster.intersectObjects(
        manager.scene.buildingsGroup.children,
        true
      );
      assert.ok(bldgHits.length > 0, 'Expected BVH raycast hit on streamed building');
      const bldgFeature = resolveInspectedFeature(bldgHits[0]);
      assert.ok(bldgFeature);
      assert.equal(bldgFeature.sourceFeatureId, 'way/bldg-seam-owner');
      assert.equal(bldgFeature.osmTags?.name, 'Seam Mall');

      // 2. Raycast straight down onto 'way/road-primary-w' at (-100, 10, -20)
      raycaster.set(
        new THREE.Vector3(-100, 10, -20),
        new THREE.Vector3(0, -1, 0)
      );
      const roadHits = raycaster.intersectObjects(
        manager.scene.roadsGroup.children,
        true
      );
      assert.ok(roadHits.length > 0, 'Expected BVH raycast hit on streamed road');
      const roadFeature = resolveInspectedFeature(roadHits[0]);
      assert.ok(roadFeature);
      assert.equal(roadFeature.sourceFeatureId, 'way/road-primary-w');

      // 3. Verify railway camera-zoom threshold (> 4.5 shows 3D sleepers/rails, <= 4.5 shows UV ribbon)
      const countVisibleByName = (root: THREE.Object3D, name: string): number => {
        let count = 0;
        root.traverse((obj) => {
          if (obj.name === name && obj.visible) {
            count += 1;
          }
        });
        return count;
      };

      manager.updateCameraZoom(8.0);
      assert.ok(
        countVisibleByName(manager.scene.railwaysGroup, 'Railway_Sleepers_3D') > 0,
        'Expected 3D sleepers visible at zoom 8.0'
      );
      assert.ok(
        countVisibleByName(manager.scene.railwaysGroup, 'Railway_Rails_3D') > 0,
        'Expected 3D rails visible at zoom 8.0'
      );
      assert.equal(
        countVisibleByName(manager.scene.railwaysGroup, 'Railways_Track'),
        0,
        'Expected UV track ribbons hidden at zoom 8.0'
      );

      manager.updateCameraZoom(1.5);
      assert.equal(
        countVisibleByName(manager.scene.railwaysGroup, 'Railway_Sleepers_3D'),
        0,
        'Expected 3D sleepers hidden at zoom 1.5'
      );
      assert.ok(
        countVisibleByName(manager.scene.railwaysGroup, 'Railways_Track') > 0,
        'Expected UV track ribbons visible at zoom 1.5'
      );

      // 4. Verify theme switching across all 4 themes & wireframe mode without recreating materials
      const materialCountBefore = manager.sharedMaterialRegistry.materialCount;
      for (const themeKey of ['daylight', 'dusk', 'blueprint', 'tactical'] as const) {
        manager.updateTheme(MAP_THEMES[themeKey]);
        assert.equal(
          manager.sharedMaterialRegistry.materialCount,
          materialCountBefore
        );
      }
      manager.setWireframe(true);
      assert.equal(
        (manager.sharedMaterialRegistry.getMaterial('buildings') as THREE.MeshStandardMaterial)
          .wireframe,
        true
      );
      manager.setWireframe(false);
      assert.equal(
        (manager.sharedMaterialRegistry.getMaterial('buildings') as THREE.MeshStandardMaterial)
          .wireframe,
        false
      );

      // 5. Verify computeViewportGroundBoundsForCamera helper with OrthographicCamera
      const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, 1, 5000);
      cam.position.set(200, 300, 200);
      cam.lookAt(0, 0, 0);
      cam.zoom = 2.0;
      const camBounds = computeViewportGroundBoundsForCamera(cam, {
        x: 0,
        z: 0,
      });
      assert.ok(camBounds.minX < 0 && camBounds.maxX > 0);
      assert.ok(camBounds.minZ < 0 && camBounds.maxZ > 0);
      assert.equal(camBounds.cameraZoom, 2.0);
    } finally {
      manager.dispose();
      decodeClient.dispose();
      await srv.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TileStreamManager handles rapid camera movement, request cancellation, deduplication, and zero-leak tile eviction', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-m2a-rapid-'));
  const packPath = path.join(tmpDir, 'm2a-rapid-tiles.sqlite');

  const grid = createAlignedStudyGrid({
    name: 'synthetic-4x4-m2a-rapid',
    centerLonLat: [6.7935, 52.2625],
    cols: 4,
    rows: 4,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const ingested = ingestCanonicalStudyGeoJson(
    buildStreamingStudyGeoJson(grid),
    grid
  );
  const snapshotId = 'synthetic-m2a-rapid';
  const sourceSha256 = 'd'.repeat(64);

  try {
    bakeStudyRegionTilesToSqlite({
      ingested,
      outPath: packPath,
      snapshotId,
      sourceSha256,
      batchDimension: 2,
      includeBvh: true,
      theme: MAP_THEMES.tactical,
    });
    disposeIngestedStudyRegionPlans(ingested);

    const srv = await startTestTileServer({
      packPath,
      expectedSnapshotId: snapshotId,
      expectedSourceSha256: sourceSha256,
      allowCustomSnapshot: true,
    });

    // Inject a controlled artificial network delay on tile payload fetches so
    // rapid camera movement occurs while HTTP fetches are actively in-flight
    const delayedFetch: typeof fetch = async (input, init) => {
      const urlStr = String(input);
      if (!urlStr.endsWith('/manifest')) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              const abortErr = new Error('The operation was aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            },
            { once: true }
          );
        });
      }
      return fetch(input, init);
    };

    const manager = new TileStreamManager({
      apiBaseUrl: srv.baseUrl,
      preloadMarginTiles: 0,
      retainMarginTiles: 0,
      maxConcurrentFetches: 2,
      maxCommitsPerFrame: 1,
      fetchFn: delayedFetch,
    });

    try {
      await manager.initialize();

      // Step 1: Start loading NW corner tile [-900..-600, -900..-600]
      manager.updateViewport({
        minX: -900,
        maxX: -600,
        minZ: -900,
        maxZ: -600,
        focusX: -750,
        focusZ: -750,
      });

      // Step 2: Duplicate viewport update while NW fetch is still in flight
      manager.updateViewport({
        minX: -890,
        maxX: -610,
        minZ: -890,
        maxZ: -610,
        focusX: -750,
        focusZ: -750,
      });
      assert.ok(
        manager.getDiagnostics().duplicateRequestsSkippedTotal >= 1,
        'Expected duplicate in-flight request to be skipped'
      );

      // Step 3: Immediately jump camera to SE corner [600..900, 600..900] before NW completes
      manager.updateViewport({
        minX: 600,
        maxX: 900,
        minZ: 600,
        maxZ: 900,
        focusX: 750,
        focusZ: 750,
      });

      const midDiag = manager.getDiagnostics();
      assert.ok(
        midDiag.cancelledRequestsTotal >= 1,
        'Expected obsolete NW in-flight tile request to be cancelled via AbortController'
      );

      await manager.waitForIdle();
      const seDiag = manager.getDiagnostics();
      assert.equal(seDiag.visibleTiles, 1);
      assert.equal(seDiag.loadedTiles, 1);
      assert.equal(seDiag.loadingTiles, 0);
      assert.equal(seDiag.failedTiles, 0);

      const seGeometries = seDiag.activeTileGeometries;
      const seBvhs = seDiag.activeTileBvhs;
      const seBytes = seDiag.tileCpuGeometryBytes;
      assert.ok(seGeometries > 0);
      assert.ok(seBvhs > 0);

      // Step 4: Repeated pan NW <-> SE across 3 full cycles to verify strict tile eviction
      // and zero CPU/GPU geometry or BVH resource leaks
      for (let cycle = 0; cycle < 3; cycle++) {
        // Pan to NW corner -> evicts SE tile
        manager.updateViewport({
          minX: -900,
          maxX: -600,
          minZ: -900,
          maxZ: -600,
          focusX: -750,
          focusZ: -750,
        });
        await manager.waitForIdle();
        const diagNw = manager.getDiagnostics();
        assert.equal(diagNw.loadedTiles, 1);
        assert.equal(
          manager.scene.buildingsGroup.children.length,
          1,
          'Expected evicted tile building group removed from scene'
        );

        // Pan back to SE corner -> evicts NW tile
        manager.updateViewport({
          minX: 600,
          maxX: 900,
          minZ: 600,
          maxZ: 900,
          focusX: 750,
          focusZ: 750,
        });
        await manager.waitForIdle();
        const diagSe = manager.getDiagnostics();
        assert.equal(diagSe.loadedTiles, 1);
        assert.equal(diagSe.activeTileGeometries, seGeometries);
        assert.equal(diagSe.activeTileBvhs, seBvhs);
        assert.equal(diagSe.tileCpuGeometryBytes, seBytes);
        assert.equal(
          manager.sharedMaterialRegistry.disposed,
          false,
          'Shared ThemeMaterialRegistry must not be disposed on tile eviction'
        );
      }

      const finalDiag = manager.getDiagnostics();
      assert.ok(
        finalDiag.evictedTilesTotal >= 6,
        `Expected >= 6 evicted tiles across 3 pan cycles, got ${finalDiag.evictedTilesTotal}`
      );

      // Step 5: Full disposal releases all remaining tile resources and shared materials
      manager.dispose();
      const postDisposeDiag = manager.getDiagnostics();
      assert.equal(postDisposeDiag.loadedTiles, 0);
      assert.equal(postDisposeDiag.activeTileGeometries, 0);
      assert.equal(postDisposeDiag.activeTileBvhs, 0);
      assert.equal(manager.sharedMaterialRegistry.disposed, true);
    } finally {
      manager.dispose();
      await srv.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
