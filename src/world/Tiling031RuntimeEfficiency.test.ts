import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  addLayerDrawWork,
  emptyLayerDrawWork,
  estimateMainPassSubmissions,
} from './tiling/RenderWorkAttribution';
import {
  equalTileViewportBounds,
  type TileViewportGroundBounds,
} from './tiling/TileStreamManager';
import { parseTileStreamingCliArgs } from '../../benchmarks/tileStreamingRunner';
import { parseRegionalFrameCostCli } from '../../benchmarks/regionalFrameCostRunner';
import { createAlignedStudyGrid } from './tiling/TileGrid';
import { TileStreamManager, type TilePackManifestPayload } from './tiling/TileStreamManager';

const viewport: TileViewportGroundBounds = {
  minX: -80, maxX: 80, minZ: -60, maxZ: 60,
  focusX: 0, focusZ: 0, cameraZoom: 1.8,
};

test('TKT-031: exact viewport footprint equality detects every selection/priority input', () => {
  assert.equal(equalTileViewportBounds(null, viewport), false);
  assert.equal(equalTileViewportBounds({ ...viewport }, viewport), true);
  const fields = ['minX', 'maxX', 'minZ', 'maxZ', 'focusX', 'focusZ', 'cameraZoom'] as const;
  for (const field of fields) {
    assert.equal(equalTileViewportBounds({
      ...viewport,
      [field]: viewport[field]! + 0.001,
    }, viewport), false, field);
  }
});

test('TKT-031: estimated submissions count compatible material groups and draw ranges', () => {
  const box = new THREE.BoxGeometry(1, 1, 1); // six per-face material groups
  const materials = Array.from({ length: 6 }, () => new THREE.MeshBasicMaterial());
  const mesh = new THREE.Mesh(box, materials);
  try {
    assert.equal(estimateMainPassSubmissions(mesh), 6);
    materials[2].visible = false;
    assert.equal(estimateMainPassSubmissions(mesh), 5);
    box.setDrawRange(0, 6);
    assert.equal(estimateMainPassSubmissions(mesh), 1);
    box.setDrawRange(0, 0);
    assert.equal(estimateMainPassSubmissions(mesh), 0);
    box.setDrawRange(0, Infinity);
    mesh.material = new THREE.MeshBasicMaterial();
    assert.equal(estimateMainPassSubmissions(mesh), 1);
    mesh.castShadow = true;
    const estimate = emptyLayerDrawWork();
    addLayerDrawWork(estimate, mesh);
    assert.deepEqual(estimate, {
      drawableMeshes: 1,
      mainPassSubmissions: 1,
      mainFrustumShadowCasterSubmissions: 1,
      instancedMeshes: 0,
    });
    (mesh.material as THREE.Material).dispose();
  } finally {
    box.dispose();
    for (const material of materials) material.dispose();
  }
});

test('TKT-031: existing instance batch counts as one main-pass candidate, never per instance', () => {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial();
  const inst = new THREE.InstancedMesh(geo, mat, 30);
  try {
    assert.equal(estimateMainPassSubmissions(inst), 1);
    inst.count = 0;
    assert.equal(estimateMainPassSubmissions(inst), 0);
    inst.count = 30;
    const estimate = emptyLayerDrawWork();
    addLayerDrawWork(estimate, inst);
    assert.equal(estimate.mainPassSubmissions, 1);
    assert.equal(estimate.instancedMeshes, 1);
  } finally {
    geo.dispose();
    mat.dispose();
  }
});

test('TKT-031: existing benchmark CLI gates are opt-in and mutually independent', () => {
  const baseline = parseTileStreamingCliArgs(['--no-save']);
  assert.equal(baseline.experimentSkipUnchangedViewport, false);
  assert.equal(baseline.experimentSkipUnchangedZoom, false);

  const vp = parseTileStreamingCliArgs([
    '--experiment-skip-unchanged-viewport', '--no-save',
  ]);
  assert.equal(vp.experimentSkipUnchangedViewport, true);
  assert.equal(vp.experimentSkipUnchangedZoom, false);

  const zoom = parseTileStreamingCliArgs([
    '--experiment-skip-unchanged-zoom', '--no-save',
  ]);
  assert.equal(zoom.experimentSkipUnchangedViewport, false);
  assert.equal(zoom.experimentSkipUnchangedZoom, true);
});


test('TKT-031: regional benchmark validates CLI flags without opening or modifying packs', () => {
  const defaults = parseRegionalFrameCostCli([]);
  assert.equal(defaults.compare, 'none');
  assert.equal(defaults.runs, 3);
  assert.equal(defaults.requireHardware, true);
  assert.ok(defaults.mosaicIndex.endsWith('mosaic.json'));

  const paired = parseRegionalFrameCostCli([
    '--compare=viewport',
    '--runs=4',
    '--warmup-frames=8',
    '--measured-frames=80',
    '--allow-software',
    '--url=http://localhost:3000',
  ]);
  assert.equal(paired.compare, 'viewport');
  assert.equal(paired.runs, 4);
  assert.equal(paired.warmupFrames, 8);
  assert.equal(paired.measuredFrames, 80);
  assert.equal(paired.requireHardware, false);
  assert.equal(paired.serverUrl, 'http://localhost:3000');

  assert.throws(() => parseRegionalFrameCostCli(['--compare=something']), /compare must/);
  assert.throws(() => parseRegionalFrameCostCli(['--runs=-1']), /integer/);
  assert.throws(() => parseRegionalFrameCostCli(['--index=']), /Empty/);
  assert.throws(() => parseRegionalFrameCostCli(['--url=file:\/\/\/tmp\/x']), /HTTP/);
  assert.throws(() => parseRegionalFrameCostCli(['--unknown=1']), /Unknown/);
});


test('TKT-031: stationary camera skips selection, but async HTTP failure triggers retry', async () => {
  const grid = createAlignedStudyGrid({
    name: 'TKT-031 gate retry',
    centerLonLat: [6.7935, 52.2625],
    cols: 1,
    rows: 1,
    tileSizeMeters: 512,
    collarMeters: 32,
  });
  const tile = grid.tiles[0];
  const manifest: TilePackManifestPayload = {
    metadata: {
      snapshotId: 'tkt031-fake',
      sourceSha256: 'f'.repeat(64),
      projectionId: 'EPSG:25832',
      bakeSchemaVersion: '1.1.0',
      lodPolicyHash: 'test',
      compression: 'deflate',
      tileSizeMeters: 512,
      collarMeters: 32,
      studyOriginEasting: grid.projection.originEasting,
      studyOriginNorthing: grid.projection.originNorthing,
      gridCols: 1,
      gridRows: 1,
      minTx: grid.minTx,
      maxTx: grid.maxTx,
      minTy: grid.minTy,
      maxTy: grid.maxTy,
      bakeStatus: 'complete',
      createdAtIso: '2026-11-21T00:00:00.000Z',
      completedAtIso: '2026-11-21T00:00:00.000Z',
    },
    tiles: [{
      lod: 0,
      tx: tile.tx,
      ty: tile.ty,
      minEasting: tile.utmBounds.minEasting,
      maxEasting: tile.utmBounds.maxEasting,
      minNorthing: tile.utmBounds.minNorthing,
      maxNorthing: tile.utmBounds.maxNorthing,
      tileCenterX: (tile.localBounds.minX + tile.localBounds.maxX) / 2,
      tileCenterZ: (tile.localBounds.minZ + tile.localBounds.maxZ) / 2,
      overhangMinX: -256,
      overhangMaxX: 256,
      overhangMinY: 0,
      overhangMaxY: 10,
      overhangMinZ: -256,
      overhangMaxZ: 256,
      triCount: 0, vertexCount: 0, featureCount: 0,
      isEmpty: true, hasBvh: false, rawBytes: 0, compressedBytes: 0,
      contentHash: 'test',
    }],
  };

  let attempts = 0;
  const manager = new TileStreamManager({
    experimentSkipUnchangedViewport: true,
    experimentSkipUnchangedZoom: true,
    initialCameraZoom: 1.8,
    maxConcurrentFetches: 1,
    fetchFn: async () => {
      attempts++;
      return new Response('synthetic HTTP error', { status: 503 });
    },
  });
  try {
    await manager.initialize(manifest);
    const cam = new THREE.OrthographicCamera(-350, 350, 350, -350, 1, 5000);
    cam.position.set(0, 700, 700);
    cam.lookAt(0, 0, 0);
    cam.zoom = 1.8;
    cam.updateProjectionMatrix();

    manager.updateFromCamera(cam);
    assert.equal(manager.getDiagnostics().viewportSelectionPasses, 1);
    manager.updateFromCamera(cam);
    assert.equal(manager.getDiagnostics().viewportSelectionSkips, 1);
    assert.ok(manager.getDiagnostics().zoomPropagationSkips >= 2);
    // The async 503 moves the tile to 'error' after the first frame.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(manager.getTileState(manager.getDiagnostics().visibleTileKeys[0]), 'error');
    manager.updateFromCamera(cam);
    assert.equal(manager.getDiagnostics().viewportSelectionPasses, 2);
    assert.equal(attempts, 2);
    // Camera changes still trigger immediate viewport recomputation.
    cam.position.x += 10;
    manager.updateFromCamera(cam);
    assert.equal(manager.getDiagnostics().viewportSelectionPasses, 3);
  } finally {
    manager.dispose();
  }
});
