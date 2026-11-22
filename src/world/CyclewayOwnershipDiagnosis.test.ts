import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { DecodedTilePayload } from './tiling/TilePackContract';
import {
  analyzeJunctionCorridor,
  classifyJunctionOwner,
  planJunctionCenterlineCorridor,
  type OwnershipProbe,
  type OwnershipState,
} from '../../scripts/cycleway-junction-continuity';
import {
  roadOwnersAtUtm,
  parseCyclewayOwnershipArgs,
} from '../../scripts/inspect-cycleway-ownership';

test('TKT-033: decoded physical triangle owner is resolved by face lineage, not neighboring mesh metadata', () => {
  const tile = {
    tx: 344, ty: 5659, tileSizeMeters: 1024,
    featureInfos: [
      { id: 'road:0', sourceFeatureId: 'way/546666718',
        sourceFeatureIds: ['way/546666718'], primaryTag: 'highway=residential',
        subtype: 'residential', layer: 0, name: 'residential owner' },
      { id: 'road:1', sourceFeatureId: 'way/38892898',
        sourceFeatureIds: ['way/38892898'], primaryTag: 'highway=cycleway',
        subtype: 'cycleway', layer: 0, name: 'cycleway' },
    ],
    meshes: [{
      layer: 'roads', name: 'Roads_residential',
      localPositionOffset: [0, 0, 0],
      // Triangle covering tile center.
      positions: new Float32Array([-2, 0.05, -2, -2, 0.05, 2, 2, 0.05, -2]),
      indices: null, singleFeatureIdx: -1,
      faceRanges: [{ startFace: 0, endFace: 1, infoIdx: 0 }],
    }],
  } as unknown as DecodedTilePayload;
  const e = (tile.tx + 0.5) * 1024, n = (tile.ty + 0.5) * 1024;
  const here = roadOwnersAtUtm(tile, e - 0.2, n + 0.2);
  assert.equal(here.length, 1);
  assert.equal(here[0].sourceFeatureId, 'way/546666718');
  assert.equal(here[0].primaryTag, 'highway=residential');
  assert.equal(roadOwnersAtUtm(tile, e + 50, n).length, 0);
});

test('TKT-033: last ownership diagnostic cannot point at arbitrary SQLite or overwrite JSON', () => {
  const root = path.resolve('tkt033-fake-root');
  const opts = parseCyclewayOwnershipArgs([], root);
  assert.ok(opts.packPath.endsWith(path.join('first-pass', 'west-north-pair-2x2.sqlite')));
  assert.ok(opts.jsonPath.endsWith(path.join('first-pass', 'way-38892898-ownership-v1.json')));
  assert.ok(parseCyclewayOwnershipArgs(['--report-id=next'], root).jsonPath.endsWith('ownership-next.json'));
  assert.throws(() => parseCyclewayOwnershipArgs(['--report-id=../data/osm'], root), /Invalid/);
  assert.throws(() => parseCyclewayOwnershipArgs(['--pack-out=other.sqlite'], root), /Unknown/);
});

/** Exact first OSM segments and shared node from the 2026-11-22 source-backed report. */
const SOURCE_JUNCTION = {
  cycleway: [
    [352327.5513159529, 5794814.283447532],
    [352336.89187554375, 5794823.253808561],
  ] as const,
  residential: [
    [352327.5513159529, 5794814.283447532],
    [352321.17256146926, 5794821.720338032],
  ] as const,
  cyclewayNodeIds: ['462001787', '2446466303'],
  residentialNodeIds: ['462001787', '46014131'],
  seamEasting: 352329.339,
  seamNorthing: 5794816,
};

function ownershipEvidence(state: OwnershipState): OwnershipProbe {
  const source = state === 'residential' ? 'way/546666718'
    : state === 'cycleway' ? 'way/38892898'
    : state === 'other-road' ? 'way/unrelated' : null;
  return {
    cycleway: { status: state === 'cycleway' ? 'covered' : 'uncovered' },
    residential: { status: state === 'residential' ? 'covered' : 'uncovered' },
    anyRoad: { status: state === 'uncovered' ? 'uncovered'
      : state === 'unattributed' ? 'unattributed' : 'covered' },
    owners: source ? [{ sourceFeatureId: source, sourceFeatureIds: [source] }] : [],
  };
}

test('TKT-033: canonical cycleway junction follows the shared node across both decoded tile coordinates', () => {
  const plan = planJunctionCenterlineCorridor(SOURCE_JUNCTION);
  assert.equal(plan.status, 'ready');
  if (plan.status !== 'ready') return;
  assert.equal(plan.sharedNodeId, '462001787');
  assert.ok(plan.seamDistanceMeters > 2 && plan.seamDistanceMeters < 3);
  assert.ok(plan.sampledUntilMeters > plan.seamDistanceMeters + 5);
  assert.equal(plan.sampleStepMeters, 0.1);
  assert.ok(plan.points.length > 70);
  assert.deepEqual(new Set(plan.points.map(p => p.ty)), new Set([5658, 5659]));
  assert.ok(plan.points.every(p => p.tx === 344));
  for (const p of plan.points) {
    // Every check is on the source segment, unlike the old fixed-axis probes.
    const line = SOURCE_JUNCTION.cycleway;
    const dx = line[1][0] - line[0][0], dy = line[1][1] - line[0][1];
    assert.ok(Math.abs((p.easting - line[0][0]) * dy -
      (p.northing - line[0][1]) * dx) < 0.000001);
    assert.ok(Math.abs(p.northing - SOURCE_JUNCTION.seamNorthing) >= 0.005);
  }
  const report = analyzeJunctionCorridor(plan, p => ownershipEvidence(
    p.distanceMeters < plan.seamDistanceMeters ? 'residential' : 'cycleway'));
  assert.equal(report.status, 'consistent-sampled-ownership');
  if (report.status === 'inconclusive') assert.fail(report.reason);
  assert.ok('transition' in report && report.transition);
  assert.ok('counts' in report && report.counts.uncovered === 0);
});

test('TKT-033: corridor rejects physical gaps, alien ownership, and receding cycleway ownership', () => {
  const plan = planJunctionCenterlineCorridor(SOURCE_JUNCTION);
  assert.equal(plan.status, 'ready');
  if (plan.status !== 'ready') return;
  const baseline = (distance: number): OwnershipState =>
    distance < plan.seamDistanceMeters ? 'residential' : 'cycleway';
  for (const disruptive of ['uncovered', 'other-road', 'unattributed'] as const) {
    const report = analyzeJunctionCorridor(plan, p =>
      ownershipEvidence(p.distanceMeters > 1.0 && p.distanceMeters < 1.5
        ? disruptive : baseline(p.distanceMeters)));
    assert.equal(report.status, 'inconclusive', disruptive);
  }
  const reverting = analyzeJunctionCorridor(plan, p => ownershipEvidence(
    p.distanceMeters > plan.seamDistanceMeters + 3
      ? 'residential' : baseline(p.distanceMeters)));
  assert.equal(reverting.status, 'inconclusive');
  const wrongSide = analyzeJunctionCorridor(plan, p => ownershipEvidence(
    p.distanceMeters < plan.seamDistanceMeters + 3 ? 'residential' : 'cycleway'));
  assert.equal(wrongSide.status, 'inconclusive', 'Transition far beyond the seam is not accepted');
});

test('TKT-033: ambiguous joint ownership and bad OSM junction geometry cannot count as passing', () => {
  const both: OwnershipProbe = {
    cycleway: { status: 'covered' }, residential: { status: 'covered' },
    anyRoad: { status: 'covered' },
    owners: [
      { sourceFeatureId: 'way/546666718', sourceFeatureIds: ['way/546666718'] },
      { sourceFeatureId: 'way/38892898', sourceFeatureIds: ['way/38892898'] },
    ],
  };
  assert.equal(classifyJunctionOwner(both), 'other-road');
  assert.equal(planJunctionCenterlineCorridor({
    ...SOURCE_JUNCTION, residentialNodeIds: ['different', '46014131'],
  }).status, 'inconclusive');
  assert.equal(planJunctionCenterlineCorridor({
    ...SOURCE_JUNCTION,
    cyclewayNodeIds: ['462001787'],
  }).status, 'inconclusive');
  assert.equal(planJunctionCenterlineCorridor({
    ...SOURCE_JUNCTION,
    seamEasting: 352400,
  }).status, 'inconclusive');
});
