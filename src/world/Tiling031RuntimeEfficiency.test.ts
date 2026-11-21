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
