import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  MISSING_ROAD_CASES,
  parseMissingRoadArgs,
  nearestRoadTriangleDistance,
  pointToTriangleDistance,
  pointToSegmentDistance,
} from '../../scripts/diagnose-missing-roads';

test('TKT-033: known visual-absence locations are deterministic and source backed', () => {
  assert.equal(MISSING_ROAD_CASES.length, 6);
  assert.ok(MISSING_ROAD_CASES.every((c) => c.sourceId.startsWith('way/')));
  const chosen = parseMissingRoadArgs(['--feature=way/6666519']);
  assert.equal(chosen.easting, 351822.7);
  assert.equal(chosen.northing, 5790720);
  assert.equal(chosen.sourceId, 'way/6666519');
  assert.throws(() => parseMissingRoadArgs(['--feature=way/unknown']), /coordinates/);
  assert.throws(() => parseMissingRoadArgs(['--easting=351822']), /together/);
  assert.throws(() => parseMissingRoadArgs(['--context-meters=0']), /context-meters/);
  const explicit = parseMissingRoadArgs([
    '--feature=way/custom', '--easting=351822', '--northing=5790720',
    '--context-meters=1024',
  ]);
  assert.equal(explicit.contextMeters, 1024);
});

test('TKT-033: finite 2D distance from a point to a triangulated road (indexed + nonindexed)', () => {
  const triangle = [
    { x: 0, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 10 },
  ] as const;
  assert.equal(pointToTriangleDistance({ x: 2, z: 2 }, ...triangle), 0);
  assert.equal(pointToTriangleDistance({ x: -2, z: 2 }, ...triangle), 2);
  assert.ok(Math.abs(pointToTriangleDistance({ x: 8, z: 8 }, ...triangle) - Math.sqrt(18)) < 1e-9);
  assert.equal(pointToSegmentDistance({ x: 5, z: 1 }, { x: 0, z: 0 }, { x: 10, z: 0 }), 1);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0.05, 0, 10, 0.05, 0, 0, 0.05, 10,
  ], 3));
  try {
    assert.equal(nearestRoadTriangleDistance(geo, { x: 2, z: 2 }), 0);
    assert.equal(nearestRoadTriangleDistance(geo, { x: -2, z: 2 }), 2);
    assert.equal(nearestRoadTriangleDistance(geo, { x: -100, z: 2 }), Infinity);
    geo.setIndex([0, 1, 2]);
    assert.equal(nearestRoadTriangleDistance(geo, { x: 2, z: 2 }), 0);
    assert.equal(nearestRoadTriangleDistance(geo, { x: 10, z: 10 }), Math.sqrt(50));
  } finally {
    geo.dispose();
  }
});
