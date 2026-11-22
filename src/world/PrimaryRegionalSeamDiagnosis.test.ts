import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePrimaryRegionalSeamArgs } from '../../scripts/inspect-primary-regional-seam';
import {
  planPrimaryRoadCorridor, roadPerpendicularSample, PRIMARY_ROAD_SAMPLE_OFFSETS,
  type UTM,
} from '../../scripts/primary-regional-seam-corridor';

const E = 351822.7;
const N = 5790720;

test('TKT-033: primary road source-arc probes follow actual OSM centerline across 4x4 shard seam', () => {
  const line: UTM[] = [
    [E - 1.8, N - 100],
    [E, N],
    [E + 5.4, N + 120],
  ];
  const plan = planPrimaryRoadCorridor({ lines: [line], easting: E, northing: N });
  assert.equal(plan.status, 'ready');
  if (plan.status !== 'ready') return;
  assert.ok(plan.closestDistanceMeters < 0.00001);
  assert.ok(plan.points.length > 20);
  assert.ok(plan.points.some(p => p.northing < N && p.signedMeters < 0));
  assert.ok(plan.points.some(p => p.northing > N && p.signedMeters > 0));
  const south = plan.points.find(p => p.signedMeters === -0.25);
  const north = plan.points.find(p => p.signedMeters === 0.25);
  assert.ok(south && north);
  assert.equal(Math.floor(south.northing / 1024), 5654);
  assert.equal(Math.floor(north.northing / 1024), 5655);
  assert.equal(PRIMARY_ROAD_SAMPLE_OFFSETS.includes(0), false);
  assert.equal(plan.sourceLineVertices, 3);
});

test('TKT-033: angled source road probes are true arc-length offsets, not fixed-easting seam probes', () => {
  const line: UTM[] = [
    [E - 30, N - 60],
    [E + 30, N + 60],
  ];
  const plan = planPrimaryRoadCorridor({ lines: [line], easting: E, northing: N });
  assert.equal(plan.status, 'ready');
  if (plan.status !== 'ready') return;
  const south = plan.points.find(p => p.signedMeters === -0.25)!;
  const north = plan.points.find(p => p.signedMeters === 0.25)!;
  assert.ok(north.easting > south.easting);
  assert.ok(north.northing > south.northing);
  assert.ok(Math.abs(Math.hypot(north.easting - south.easting,
    north.northing - south.northing) - 0.5) < 1e-5);
});

test('TKT-033: reject source tangent or endpoint instead of declaring a missing shard road', () => {
  const tangent: UTM[] = [
    [E - 10, N - 5], [E, N], [E + 10, N - 5],
  ];
  const endpoint: UTM[] = [[E, N], [E + 10, N + 5]];
  for (const line of [tangent, endpoint]) {
    const plan = planPrimaryRoadCorridor({ lines: [line], easting: E, northing: N });
    assert.equal(plan.status, 'inconclusive');
  }
});

test('TKT-033: reject unrelated or ambiguous geometry instead of emitting misleading coverage samples', () => {
  const near: UTM[] = [[E, N - 10], [E, N + 10]];
  const far: UTM[] = [[E + 8, N - 10], [E + 8, N + 10]];
  assert.equal(planPrimaryRoadCorridor({
    lines: [far], easting: E, northing: N,
  }).status, 'inconclusive');
  assert.equal(planPrimaryRoadCorridor({
    lines: [near, near], easting: E, northing: N,
  }).status, 'inconclusive');
  assert.equal(planPrimaryRoadCorridor({
    lines: [near], easting: E, northing: N, offsets: [-2],
  }).status, 'inconclusive');
});


test('TKT-033: paired-way arguments require explicit identity and exact witness', () => {
  const parsed = parsePrimaryRegionalSeamArgs(
    ['--source-id=way/140066819', '--easting=351809.454'],
    '/tmp/tkt033-tests');
  assert.equal(parsed.sourceId, 'way/140066819');
  assert.equal(parsed.witness.easting, 351809.454);
  assert.equal(parsed.witness.northing, 5790720);
  assert.match(parsed.reportPath, /tkt033-paired-candidate-corridor-way-140066819-v1\.json$/);
  assert.throws(() => parsePrimaryRegionalSeamArgs(
    ['--source-id=way/140066819'], '/tmp/tkt033-tests'), /together/);
  assert.throws(() => parsePrimaryRegionalSeamArgs(
    ['--easting=351809.454'], '/tmp/tkt033-tests'), /together/);
  assert.throws(() => parsePrimaryRegionalSeamArgs(
    ['--source-id=way/not-a-way', '--easting=351809.454'], '/tmp/tkt033-tests'), /Invalid source/);
  assert.throws(() => parsePrimaryRegionalSeamArgs(
    ['--source-id=way/140066819', '--easting=NaN'], '/tmp/tkt033-tests'), /Invalid UTM/);
});

test('TKT-033: cross-road samples move perpendicular to source tangent on both sides', () => {
  const line: UTM[] = [[E, N - 10], [E, N + 10]];
  const left = roadPerpendicularSample([line], [E, N], -3);
  const right = roadPerpendicularSample([line], [E, N], 3);
  assert.deepEqual(left, [E + 3, N]);
  assert.deepEqual(right, [E - 3, N]);
  assert.equal(roadPerpendicularSample([line], [E + 2, N], 1), null);
  assert.equal(roadPerpendicularSample([], [E, N], 1), null);
});
