import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_THEMES } from '../styles/mapThemes';
import {
  TileStreamManager,
  INACTIVE_MOSAIC_IDENTITY,
  createErrorMosaicIdentity,
  createLoadingMosaicIdentity,
  createMosaicIdentityFromDiagnostics,
  deriveActiveMosaicNameFromPackPath,
} from './tiling/TileStreamManager';
import {
  BENCHMARK_REGIONAL_OVERVIEW_MIN_ZOOM,
  DEFAULT_REGIONAL_MIN_ZOOM,
  STANDARD_MAX_ZOOM,
  STANDARD_MIN_ZOOM,
  clampCameraZoom,
  interpolateClampedCameraZoom,
  parseRegionalMinZoomFromSearch,
  resolveCameraResetOrFrameTarget,
  resolveCameraZoomPolicy,
  validateRegionalMinZoomOverride,
} from '../scene/cameraZoomPolicy';
import { computeProjectedBoundsFraming } from '../scene/CameraController';

function makeManifestPayload(overrides: {
  packPath?: string | null;
  snapshotId?: string;
  bakeSchemaVersion?: string;
  gridCols?: number;
  gridRows?: number;
  tileSizeMeters?: number;
  available?: boolean;
}) {
  const gridCols = overrides.gridCols ?? 16;
  const gridRows = overrides.gridRows ?? 16;
  const tileSizeMeters = overrides.tileSizeMeters ?? 1024;
  const originEasting = 349467.85;
  const originNorthing = 5792561.78;
  const halfW = (gridCols * tileSizeMeters) / 2;
  const halfH = (gridRows * tileSizeMeters) / 2;
  const tiles = [];
  for (let ty = 0; ty < gridRows; ty++) {
    for (let tx = 0; tx < gridCols; tx++) {
      const minX = -halfW + tx * tileSizeMeters;
      const maxX = minX + tileSizeMeters;
      const minZ = -halfH + ty * tileSizeMeters;
      const maxZ = minZ + tileSizeMeters;
      tiles.push({
        tx,
        ty,
        minEasting: originEasting + minX,
        maxEasting: originEasting + maxX,
        minNorthing: originNorthing - maxZ,
        maxNorthing: originNorthing - minZ,
        tileCenterX: (minX + maxX) / 2,
        tileCenterZ: (minZ + maxZ) / 2,
        overhangMinX: -tileSizeMeters / 2,
        overhangMaxX: tileSizeMeters / 2,
        overhangMinZ: -tileSizeMeters / 2,
        overhangMaxZ: tileSizeMeters / 2,
        payloadByteLength: 1024,
        meshCount: 2,
        triangleCount: 100,
        featureCount: 10,
        contentHash: `hash_${tx}_${ty}`,
      });
    }
  }
  return {
    available: overrides.available ?? true,
    packPath: overrides.packPath === null ? undefined : (overrides.packPath ?? '/data/twente-pilot-1024m-tkt033-candidate/mosaic.json'),
    metadata: {
      snapshotId: overrides.snapshotId ?? 'overijssel-261114-8ae28196',
      bakeSchemaVersion: overrides.bakeSchemaVersion ?? '1.1.0',
      projection: 'EPSG:32632',
      studyOriginEasting: originEasting,
      studyOriginNorthing: originNorthing,
      tileSizeMeters,
      collarMeters: 64,
      gridCols,
      gridRows,
      geometryUnits: 'meters',
      rendererVersion: 'test',
      createdAt: '2026-11-14T00:00:00Z',
    },
    tiles,
  };
}

test('deriveActiveMosaicNameFromPackPath distinguishes baseline and candidate regional mosaics', () => {
  assert.equal(
    deriveActiveMosaicNameFromPackPath(
      '/srv/osm/data/mosaics/twente-pilot-1024m/mosaic.json'
    ),
    'twente-pilot-1024m'
  );
  assert.equal(
    deriveActiveMosaicNameFromPackPath(
      '/srv/osm/data/mosaics/twente-pilot-1024m-tkt033-candidate/mosaic.json'
    ),
    'twente-pilot-1024m-tkt033-candidate'
  );
  assert.equal(
    deriveActiveMosaicNameFromPackPath(
      'C:\\osm\\mosaics\\twente-pilot-1024m-tkt033-candidate\\mosaic.json'
    ),
    'twente-pilot-1024m-tkt033-candidate'
  );
  assert.equal(
    deriveActiveMosaicNameFromPackPath('/srv/osm/data/hengelo-tiles-512m.sqlite'),
    'hengelo-tiles-512m'
  );
  assert.equal(deriveActiveMosaicNameFromPackPath(null), null);
  assert.equal(deriveActiveMosaicNameFromPackPath(undefined), null);
  assert.equal(deriveActiveMosaicNameFromPackPath('   '), null);
});

test('TileStreamManager derives active mosaic identity strictly from the loaded manifest', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      assert.equal(url, '/api/tiles-region/manifest');
      return new Response(
        JSON.stringify(
          makeManifestPayload({
            packPath: '/var/data/twente-pilot-1024m-tkt033-candidate/mosaic.json',
            snapshotId: 'overijssel-261114-8ae28196',
            bakeSchemaVersion: '1.1.0',
            gridCols: 16,
            gridRows: 16,
            tileSizeMeters: 1024,
          })
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const manager = new TileStreamManager({
      apiBaseUrl: '/api/tiles-region',
      initialTheme: MAP_THEMES.tactical,
    });

    // Before initialize(), no mosaic is active
    const idleDiag = manager.getDiagnostics();
    assert.equal(idleDiag.manifestStatus, 'idle');
    assert.equal(idleDiag.activeMosaicName, null);
    assert.equal(idleDiag.packPath, null);

    await manager.initialize();

    const loadedDiag = manager.getDiagnostics();
    assert.equal(loadedDiag.manifestStatus, 'loaded');
    assert.equal(loadedDiag.activeMosaicName, 'twente-pilot-1024m-tkt033-candidate');
    assert.equal(
      loadedDiag.packPath,
      '/var/data/twente-pilot-1024m-tkt033-candidate/mosaic.json'
    );
    assert.equal(loadedDiag.snapshotId, 'overijssel-261114-8ae28196');
    assert.equal(loadedDiag.totalGridTiles, 256);
    assert.equal(loadedDiag.bakeSchemaVersion, '1.1.0');

    const identity = createMosaicIdentityFromDiagnostics(loadedDiag, true);
    assert.equal(identity.status, 'loaded');
    assert.equal(identity.mosaicName, 'twente-pilot-1024m-tkt033-candidate');
    assert.equal(identity.snapshotId, 'overijssel-261114-8ae28196');
    assert.equal(identity.tileCount, 256);
    assert.equal(identity.bakeSchemaVersion, '1.1.0');
    assert.equal(
      identity.packPath,
      '/var/data/twente-pilot-1024m-tkt033-candidate/mosaic.json'
    );

    manager.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Dataset switching and failed manifest requests clear stale active mosaic identity', async () => {
  const originalFetch = globalThis.fetch;
  let phase: 'baseline' | 'candidate' | 'fail_http' | 'fail_unavailable' | 'fail_build' = 'baseline';

  try {
    globalThis.fetch = (async () => {
      if (phase === 'baseline') {
        return new Response(
          JSON.stringify(
            makeManifestPayload({
              packPath: '/var/data/twente-pilot-1024m/mosaic.json',
              snapshotId: 'overijssel-old-0001',
              bakeSchemaVersion: '1.0.0',
            })
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (phase === 'candidate') {
        return new Response(
          JSON.stringify(
            makeManifestPayload({
              packPath: '/var/data/twente-pilot-1024m-tkt033-candidate/mosaic.json',
              snapshotId: 'overijssel-261114-8ae28196',
              bakeSchemaVersion: '1.1.0',
            })
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (phase === 'fail_build') {
        // HTTP manifest is valid, but one malformed tile crashes after other
        // tile records have already been inserted into the manager's map.
        const payload = makeManifestPayload({
          packPath: '/var/data/twente-pilot-1024m-tkt033-candidate/mosaic.json',
        });
        return new Response(
          JSON.stringify({ ...payload, tiles: [...payload.tiles, null] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (phase === 'fail_unavailable') {
        return new Response(
          JSON.stringify({
            available: false,
            error: 'Regional mosaic not found on disk',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ error: 'Regional mosaic offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const manager = new TileStreamManager({
      apiBaseUrl: '/api/tiles-region',
      initialTheme: MAP_THEMES.tactical,
    });

    // 1. Load original mosaic
    await manager.initialize();
    assert.equal(manager.activeMosaicName, 'twente-pilot-1024m');
    assert.equal(manager.getDiagnostics().snapshotId, 'overijssel-old-0001');

    // 2. Loading transition helper must clear all prior mosaic fields immediately
    const loadingIdentity = createLoadingMosaicIdentity(true);
    assert.equal(loadingIdentity.status, 'loading');
    assert.equal(loadingIdentity.mosaicName, null);
    assert.equal(loadingIdentity.packPath, null);
    assert.equal(loadingIdentity.snapshotId, null);
    assert.equal(loadingIdentity.tileCount, null);

    // 3. Re-initialize against a failing HTTP 503 manifest: stale identity MUST NOT persist
    phase = 'fail_http';
    await assert.rejects(() => manager.initialize(), /Regional mosaic offline/);
    const errDiag = manager.getDiagnostics();
    assert.equal(errDiag.manifestStatus, 'error');
    assert.equal(errDiag.activeMosaicName, null);
    assert.equal(errDiag.packPath, null);
    assert.equal(errDiag.snapshotId, 'uninitialized');
    assert.equal(errDiag.totalGridTiles, 0);
    assert.ok(errDiag.manifestError && errDiag.manifestError.includes('Regional mosaic offline'));

    const errIdentity = createMosaicIdentityFromDiagnostics(errDiag, true);
    assert.equal(errIdentity.status, 'error');
    assert.equal(errIdentity.mosaicName, null);
    assert.equal(errIdentity.packPath, null);
    assert.equal(errIdentity.snapshotId, null);

    // 4. Switch to candidate mosaic
    phase = 'candidate';
    await manager.initialize();
    assert.equal(manager.activeMosaicName, 'twente-pilot-1024m-tkt033-candidate');
    assert.equal(manager.getDiagnostics().snapshotId, 'overijssel-261114-8ae28196');

    // 5. A successful HTTP response can still fail during tile/overlay setup.
    // Neither the candidate identity nor partially populated tile records may survive.
    phase = 'fail_build';
    await assert.rejects(() => manager.initialize(), /minEasting|Cannot read properties/i);
    const buildFailureDiag = manager.getDiagnostics();
    assert.equal(buildFailureDiag.manifestStatus, 'error');
    assert.equal(buildFailureDiag.activeMosaicName, null);
    assert.equal(buildFailureDiag.packPath, null);
    assert.equal(buildFailureDiag.snapshotId, 'uninitialized');
    assert.equal(buildFailureDiag.totalGridTiles, 0);
    assert.ok(buildFailureDiag.manifestError);

    // 6. Reinitialize successfully after setup failure, then test unavailable manifest.
    phase = 'candidate';
    await manager.initialize();
    assert.equal(manager.activeMosaicName, 'twente-pilot-1024m-tkt033-candidate');

    phase = 'fail_unavailable';
    await assert.rejects(() => manager.initialize(), /not found on disk|unavailable/i);
    assert.equal(manager.activeMosaicName, null);
    assert.equal(manager.packPath, null);
    assert.equal(manager.currentManifestStatus, 'error');

    // 7. Explicit error & inactive identity helpers never retain stale mosaic names
    const explicitErr = createErrorMosaicIdentity(true, 'Network error');
    assert.equal(explicitErr.status, 'error');
    assert.equal(explicitErr.mosaicName, null);
    assert.equal(INACTIVE_MOSAIC_IDENTITY.status, 'inactive');
    assert.equal(INACTIVE_MOSAIC_IDENTITY.mosaicName, null);

    // 8. Dispose clears loaded state completely
    phase = 'candidate';
    await manager.initialize();
    assert.equal(manager.activeMosaicName, 'twente-pilot-1024m-tkt033-candidate');
    manager.dispose();
    assert.equal(manager.activeMosaicName, null);
    assert.equal(manager.packPath, null);
    assert.equal(manager.currentManifestStatus, 'idle');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Regional zoom-out policy applies conservative 0.15 default and preserves maxZoom 16.0', () => {
  const policy = resolveCameraZoomPolicy({
    isRegionalStreaming: true,
    urlOverride: parseRegionalMinZoomFromSearch('?m2a=1&region=twente-pilot'),
  });

  assert.equal(policy.minZoom, DEFAULT_REGIONAL_MIN_ZOOM);
  assert.equal(policy.minZoom, 0.15);
  assert.equal(policy.maxZoom, STANDARD_MAX_ZOOM);
  assert.equal(policy.maxZoom, 16.0);
  assert.equal(policy.source, 'regional_default');
  assert.equal(policy.invalidOverrideRejected, false);
});

test('Regional zoom-out policy supports valid URL overrides and explicit benchmark opt-in', () => {
  const urlOverride05 = resolveCameraZoomPolicy({
    isRegionalStreaming: true,
    urlOverride: parseRegionalMinZoomFromSearch(
      '?m2a=1&region=twente-pilot&regionalMinZoom=0.05'
    ),
  });
  assert.equal(urlOverride05.minZoom, 0.05);
  assert.equal(urlOverride05.maxZoom, 16.0);
  assert.equal(urlOverride05.source, 'url_override');
  assert.equal(urlOverride05.invalidOverrideRejected, false);

  const benchmarkPolicy = resolveCameraZoomPolicy({
    isRegionalStreaming: true,
    urlOverride: parseRegionalMinZoomFromSearch(
      `?m2a=1&region=twente-pilot&regionalMinZoom=${BENCHMARK_REGIONAL_OVERVIEW_MIN_ZOOM}`
    ),
  });
  assert.equal(benchmarkPolicy.minZoom, 0.015);
  assert.equal(benchmarkPolicy.maxZoom, 16.0);
  assert.equal(benchmarkPolicy.source, 'url_override');

  const programmaticPolicy = resolveCameraZoomPolicy({
    isRegionalStreaming: true,
    programmaticOverride: BENCHMARK_REGIONAL_OVERVIEW_MIN_ZOOM,
  });
  assert.equal(programmaticPolicy.minZoom, 0.015);
  assert.equal(programmaticPolicy.source, 'programmatic_override');

  // Boundary valid values
  assert.equal(validateRegionalMinZoomOverride(0.01).isValid, true);
  assert.equal(validateRegionalMinZoomOverride(4.0).isValid, true);
});

test('Regional zoom-out policy rejects invalid, non-finite, zero, negative, and unreasonable overrides', () => {
  const badRawValues = [
    '',
    '   ',
    'abc',
    '0.05px',
    'NaN',
    'Infinity',
    '-Infinity',
    '0',
    '-0.05',
    '0.001',
    '0.009',
    '4.5',
    '10',
    '16',
    '100',
  ];

  for (const raw of badRawValues) {
    const parsed = parseRegionalMinZoomFromSearch(
      `?m2a=1&region=twente-pilot&regionalMinZoom=${encodeURIComponent(raw)}`
    );
    assert.notEqual(parsed.reason, 'absent', `Expected parameter presence for raw="${raw}"`);
    assert.equal(parsed.isValid, false, `Expected raw="${raw}" to be rejected`);

    const policy = resolveCameraZoomPolicy({
      isRegionalStreaming: true,
      urlOverride: parsed,
    });
    assert.equal(
      policy.minZoom,
      DEFAULT_REGIONAL_MIN_ZOOM,
      `Expected raw="${raw}" to fall back to ${DEFAULT_REGIONAL_MIN_ZOOM}`
    );
    assert.equal(policy.maxZoom, STANDARD_MAX_ZOOM);
    assert.equal(policy.source, 'fallback_invalid_override');
    assert.equal(policy.invalidOverrideRejected, true);
  }

  // Non-finite numeric programmatic overrides also fall back safely
  for (const badNum of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 0.001, 20]) {
    const policy = resolveCameraZoomPolicy({
      isRegionalStreaming: true,
      programmaticOverride: badNum,
    });
    assert.equal(policy.minZoom, DEFAULT_REGIONAL_MIN_ZOOM);
    assert.equal(policy.source, 'fallback_invalid_override');
    assert.equal(policy.invalidOverrideRejected, true);
  }
});

test('Non-regional maps and smaller Hengelo fixtures keep standard minZoom 0.15 regardless of regionalMinZoom param', () => {
  const parsedUrl = parseRegionalMinZoomFromSearch('?regionalMinZoom=0.02');
  assert.equal(parsedUrl.isValid, true);

  const nonRegionalPolicy = resolveCameraZoomPolicy({
    isRegionalStreaming: false,
    urlOverride: parsedUrl,
    programmaticOverride: 0.015,
  });

  assert.equal(nonRegionalPolicy.mode, 'standard');
  assert.equal(nonRegionalPolicy.minZoom, STANDARD_MIN_ZOOM);
  assert.equal(nonRegionalPolicy.minZoom, 0.15);
  assert.equal(nonRegionalPolicy.maxZoom, STANDARD_MAX_ZOOM);
  assert.equal(nonRegionalPolicy.maxZoom, 16.0);
  assert.equal(nonRegionalPolicy.source, 'standard_default');
  assert.equal(nonRegionalPolicy.invalidOverrideRejected, false);
});

test('Camera framing, explicit poses, reset targets, and animations all respect minZoom and maxZoom', () => {
  // 16 x 16 km Twente regional pilot bounds: unconstrained fit would be ~0.04 on 1280x720
  const regionalBounds = {
    minX: -8192,
    maxX: 8192,
    minZ: -8192,
    maxZ: 8192,
    widthMeters: 16384,
    depthMeters: 16384,
  };

  // Default regional cap (0.15) prevents full-region framing from zooming out past 0.15
  const framingDefault = computeProjectedBoundsFraming(
    regionalBounds,
    1280,
    720,
    undefined,
    undefined,
    undefined,
    0.15,
    16.0
  );
  assert.equal(framingDefault.zoom, 0.15);

  // Explicit 0.015 benchmark override allows full-region framing below 0.15
  const framingBenchmark = computeProjectedBoundsFraming(
    regionalBounds,
    1280,
    720,
    undefined,
    undefined,
    undefined,
    0.015,
    16.0
  );
  assert.ok(
    framingBenchmark.zoom >= 0.015 && framingBenchmark.zoom < 0.15,
    `Expected regional overview framing between 0.015 and 0.15, got ${framingBenchmark.zoom}`
  );

  // Explicit pose clamping enforces minZoom and maxZoom (and handles invalid inputs)
  assert.equal(clampCameraZoom(0.02, 0.15, 16.0), 0.15);
  assert.equal(clampCameraZoom(0.05, 0.05, 16.0), 0.05);
  assert.equal(clampCameraZoom(24.0, 0.15, 16.0), 16.0);
  assert.equal(clampCameraZoom(8.5, 0.15, 16.0), 8.5);
  assert.equal(clampCameraZoom(Number.NaN, 0.15, 16.0), 0.15);

  // Camera reset / frame-region targets never escape minZoom
  const resetTarget = resolveCameraResetOrFrameTarget({
    boundsFraming: {
      position: [100, 100, 100],
      target: [0, 0, 0],
      zoom: 0.04,
    },
    fallbackPosition: [200, 200, 200],
    fallbackTarget: [0, 0, 0],
    fallbackZoom: 0.85,
    minZoom: 0.15,
    maxZoom: 16.0,
  });
  assert.equal(resetTarget.zoom, 0.15);

  const resetTargetWithOverride = resolveCameraResetOrFrameTarget({
    boundsFraming: {
      position: [100, 100, 100],
      target: [0, 0, 0],
      zoom: 0.04,
    },
    fallbackPosition: [200, 200, 200],
    fallbackTarget: [0, 0, 0],
    fallbackZoom: 0.85,
    minZoom: 0.05,
    maxZoom: 16.0,
  });
  assert.equal(resetTargetWithOverride.zoom, 0.05);

  const resetFallbackClamped = resolveCameraResetOrFrameTarget({
    boundsFraming: null,
    fallbackPosition: [200, 200, 200],
    fallbackTarget: [0, 0, 0],
    fallbackZoom: 0.02,
    minZoom: 0.15,
    maxZoom: 16.0,
  });
  assert.equal(resetFallbackClamped.zoom, 0.15);

  // Camera reset animation interpolation stays clamped at every animation progress step
  for (const progress of [0, 0.1, 0.5, 0.9, 1.0]) {
    const z = interpolateClampedCameraZoom(0.02, 0.15, progress, 0.15, 16.0);
    assert.ok(
      z >= 0.15 && z <= 16.0,
      `Animation zoom ${z} escaped [0.15, 16.0] at progress=${progress}`
    );
  }
  const highZoomAnim = interpolateClampedCameraZoom(25.0, 12.0, 0.25, 0.15, 16.0);
  assert.ok(highZoomAnim >= 0.15 && highZoomAnim <= 16.0);
});
