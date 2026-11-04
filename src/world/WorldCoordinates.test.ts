import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorldCoordinates,
  projectToLocalMeters,
  unprojectToGeo,
  haversineDistanceMeters,
  WGS84_EQUATORIAL_RADIUS,
} from './WorldCoordinates';

test('projectToLocalMeters maps origin coordinate to (0, 0)', () => {
  const [x, z] = projectToLocalMeters(2.3488, 48.8530, 2.3488, 48.8530);
  assert.equal(Math.abs(x) < 1e-6, true, `x should be 0, got ${x}`);
  assert.equal(Math.abs(z) < 1e-6, true, `z should be 0, got ${z}`);
});

test('projectToLocalMeters correctly positions East and North offsets', () => {
  const originLon = 2.3488;
  const originLat = 48.8530;

  // 1 degree North (+lat) should produce negative Z in Three.js
  const northCoord = projectToLocalMeters(originLon, originLat + 0.001, originLon, originLat);
  assert.equal(northCoord[0], 0);
  assert.equal(northCoord[1] < 0, true, 'North coordinates should have negative Z');

  // 1 degree East (+lon) should produce positive X in Three.js
  const eastCoord = projectToLocalMeters(originLon + 0.001, originLat, originLon, originLat);
  assert.equal(eastCoord[0] > 0, true, 'East coordinates should have positive X');
  assert.equal(eastCoord[1], 0);
});

test('unprojectToGeo provides exact round-trip inverse transformation', () => {
  const originLon = 2.3488;
  const originLat = 48.8530;
  const targetLon = 2.3550;
  const targetLat = 48.8580;

  const [x, z] = projectToLocalMeters(targetLon, targetLat, originLon, originLat);
  const [roundLon, roundLat] = unprojectToGeo(x, z, originLon, originLat);

  assert.equal(Math.abs(roundLon - targetLon) < 1e-9, true);
  assert.equal(Math.abs(roundLat - targetLat) < 1e-9, true);
});

test('distance consistency: local euclidean distance closely matches haversine for 1km scale', () => {
  const originLon = 2.3488;
  const originLat = 48.8530;
  const targetLon = 2.3550;
  const targetLat = 48.8580;

  const [x, z] = projectToLocalMeters(targetLon, targetLat, originLon, originLat);
  const localDist = Math.hypot(x, z);
  const haversineDist = haversineDistanceMeters(originLon, originLat, targetLon, targetLat);

  // For a ~700m span, discrepancy between planar tangent projection and spherical haversine should be < 0.1% (< 1m)
  const diff = Math.abs(localDist - haversineDist);
  assert.equal(diff < 1.0, true, `Difference ${diff}m between local projection and haversine is too large`);
});

test('WorldCoordinates class instance transforms rings reliably', () => {
  const wc = new WorldCoordinates(2.3488, 48.8530);
  const ring: [number, number][] = [
    [2.3488, 48.8530],
    [2.3500, 48.8530],
    [2.3500, 48.8540],
    [2.3488, 48.8540],
  ];

  const localRing = wc.transformRing(ring);
  assert.equal(localRing.length, 4);
  assert.equal(Math.abs(localRing[0][0]) < 1e-6, true);
  assert.equal(Math.abs(localRing[0][1]) < 1e-6, true);
  assert.equal(localRing[1][0] > 0, true);
});
