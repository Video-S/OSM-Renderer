import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  inspectPolylineAtHorizontalSeam,
  closestPolylineSegment,
  parseCyclewaySeamArgs,
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
