import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  inspectPolylineAtHorizontalSeam,
  closestPolylineSegment,
  parseCyclewaySeamArgs,
  tangentAlignedRoadSeamProbes,
} from '../../scripts/inspect-cycleway-seam';

test('TKT-033: OSM geometry distinguishes full crossing from endpoint touch or seam parallelism', () => {
  const seam = 5786624;
  const crossing = inspectPolylineAtHorizontalSeam(
    [[352312, seam - 4], [352314, seam + 4]], seam, 352313,
  );
  assert.equal(crossing.length, 1);
  assert.equal(crossing[0].disposition, 'proper-crossing');
  assert.equal(crossing[0].easting, 352313);
  assert.ok(crossing[0].angleToSeamDegrees > 70);

  const endpoint = inspectPolylineAtHorizontalSeam(
    [[352300, seam + 3], [352313, seam]], seam, 352313,
  );
  assert.equal(endpoint.length, 1);
  assert.equal(endpoint[0].disposition, 'endpoint-touch');

  const parallel = inspectPolylineAtHorizontalSeam(
    [[352310, seam], [352320, seam]], seam, 352313,
  );
  assert.equal(parallel.length, 1);
  assert.equal(parallel[0].disposition, 'on-seam-segment');

  const never = inspectPolylineAtHorizontalSeam(
    [[352310, seam + 10], [352320, seam + 10]], seam, 352313,
  );
  assert.deepEqual(never, []);
});

test('TKT-033: source tangent diagnostic identifies physical nearest point and ending segment', () => {
  const nearest = closestPolylineSegment([[0, 0], [10, 0]], 15, 1);
  assert.ok(nearest);
  assert.equal(nearest.t, 1);
  assert.deepEqual(nearest.closest, [10, 0]);
  assert.ok(Math.abs(nearest.distanceMeters - Math.sqrt(26)) < 1e-10);
  assert.equal(closestPolylineSegment([[0, 0]], 0, 0), null);
});

test('TKT-033: seam inspector only reads known disposable pack and protects prior JSON', () => {
  const root = path.resolve('tkt033-test-sandbox-nonexistent');
  const d = parseCyclewaySeamArgs([], root);
  assert.ok(d.packPath.endsWith(path.join('first-pass', 'west-south-pair-2x2.sqlite')));
  assert.ok(d.jsonPath.endsWith(path.join('first-pass', 'way-14119316-cross-section-v1.json')));
  const second = parseCyclewaySeamArgs(['--report-id=second'], root);
  assert.ok(second.jsonPath.endsWith('way-14119316-cross-section-second.json'));
  for (const bad of ['..', 'folder/name', '', 'C:\\secrets']) {
    assert.throws(() => parseCyclewaySeamArgs(['--report-id=' + bad], root),
      /Invalid/);
  }
  assert.throws(() => parseCyclewaySeamArgs(['--pack=../../data/osm/tiles.sqlite'], root),
    /Unknown/);
});

test('TKT-033: real 0.2m diagonal Hilgenhuesweg is not an axis-inset seam gap', () => {
  // Exact canonical EPSG:25832 OSM segment from owner report, 2026-11-22.
  const a: [number, number] = [352280.52381045616, 5786650.10995161];
  const b: [number, number] = [352345.105216966, 5786597.127508704];
  const seamNorthing = 5786624;
  const aligned = tangentAlignedRoadSeamProbes(a, b, 'northing', seamNorthing);
  assert.ok(aligned, 'The OSM line crosses the seam away from its endpoints');
  assert.equal(aligned.positiveSide[1] > seamNorthing, true);
  assert.equal(aligned.negativeSide[1] < seamNorthing, true);
  // Old method held easting constant and shifted +/- 25cm north-south,
  // nearly 19.3cm away from the true line: OUTSIDE a 0.2m-wide cycleway.
  for (const sign of [-1, 1]) {
    const mislocated = closestPolylineSegment(
      [a, b], aligned.crossing[0], seamNorthing + sign * 0.25);
    assert.ok(mislocated && mislocated.distanceMeters > 0.19,
      'Axis-only probe misses the OSM ribbon even when geometry is correct');
  }
  // Correct probes move 25cm ALONG the tangent, retaining central attribution
  // while landing in both adjacent encoded tiles.
  for (const alignedPoint of [aligned.negativeSide, aligned.positiveSide]) {
    const onLine = closestPolylineSegment([a, b], alignedPoint[0], alignedPoint[1]);
    assert.ok(onLine && onLine.distanceMeters < 1e-6);
  }
  assert.notEqual(
    Math.floor(aligned.negativeSide[1] / 1024),
    Math.floor(aligned.positiveSide[1] / 1024),
    'Aligned probes must represent opposite 1024m tile interiors');
});

test('TKT-033: tangent alignment explicitly rejects endpoints and on-seam directions', () => {
  assert.equal(
    tangentAlignedRoadSeamProbes([0, 0], [2, 0], 'northing', 0), null);
  assert.equal(
    tangentAlignedRoadSeamProbes([0, 0], [0, 2], 'northing', 0), null);
  assert.equal(
    tangentAlignedRoadSeamProbes([0, -0.1], [0, 3], 'northing', 0), null);
  const valid = tangentAlignedRoadSeamProbes([0, -3], [0, 3], 'northing', 0);
  assert.ok(valid);
  assert.ok(valid.negativeSide[1] < 0 && valid.positiveSide[1] > 0);
});
