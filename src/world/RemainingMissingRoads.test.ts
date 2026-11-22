import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  REMAINING_MISSING_ROAD_GROUPS,
  gridForRemainingRoadGroup,
  samplesForRemainingRoadWitness,
  classifyRemainingRoadCoverage,
  parseRemainingRoadCheckArgs,
} from '../../scripts/verify-remaining-missing-roads';

test('TKT-033: all 10 not-yet-fixed TKT-032 physical-neither witnesses are retained once', () => {
  const all = REMAINING_MISSING_ROAD_GROUPS.flatMap(g => g.cases);
  assert.equal(REMAINING_MISSING_ROAD_GROUPS.length, 5);
  assert.equal(all.length, 10);
  assert.equal(new Set(all.map(c => c.sourceId)).size, 9);
  assert.ok(!all.some(c => c.sourceId === 'way/6661112'));
  assert.deepEqual(all.map(c => c.sourceId).sort(), [
    'way/137733136', 'way/14119316', 'way/221267376', 'way/221267376',
    'way/38892898', 'way/51932698', 'way/546666718',
    'way/6655700', 'way/6666519', 'way/874072936',
  ]);
});

test('TKT-033: group coordinates and seam insets fit in exactly 5 aligned grids', () => {
  let reused = 0;
  for (const group of REMAINING_MISSING_ROAD_GROUPS) {
    const grid = gridForRemainingRoadGroup(group);
    assert.equal(grid.tiles.length, 4);
    assert.equal(grid.tileSizeMeters, 1024);
    if (group.reuseBoerrichterkamp) {
      reused++;
      assert.equal(group.id, 'central-east-existing');
      assert.equal(grid.minTx, 348);
      assert.equal(grid.maxTx, 349);
      assert.equal(grid.minTy, 5654);
      assert.equal(grid.maxTy, 5655);
      assert.equal(group.cases.length, 4);
    }
    const b = grid.studyUtmBounds;
    for (const witness of group.cases) {
      const samples = samplesForRemainingRoadWitness(witness);
      assert.equal(samples.length, 3);
      for (const sample of samples) {
        assert.ok(sample.easting >= b.minEasting && sample.easting < b.maxEasting,
          group.id + ' east out of bounds: ' + witness.sourceId);
        assert.ok(sample.northing >= b.minNorthing && sample.northing < b.maxNorthing,
          group.id + ' north out of bounds: ' + witness.sourceId);
      }
      // All source points in the original audit lie on a 1024m tile
      // boundary, so 25cm insets must use distinct tiles.
      const a = samples[1], c = samples[2];
      const tileA = Math.floor(a.easting/1024) + ':' + Math.floor(a.northing/1024);
      const tileB = Math.floor(c.easting/1024) + ':' + Math.floor(c.northing/1024);
      assert.notEqual(tileA, tileB, 'Expected opposite-side tile samples for ' + witness.sourceId);
    }
  }
  assert.equal(reused, 1);
});

test('TKT-033: classification separates true source geometry from other-road ownership', () => {
  const src = (status: 'covered' | 'uncovered' | 'unattributed',
    any: 'covered' | 'uncovered' | 'unattributed') =>
      ({ source: { status }, anyRoad: { status: any } });
  assert.equal(classifyRemainingRoadCoverage(
    src('covered', 'covered'), src('covered', 'covered')), 'source-covered-both');
  assert.equal(classifyRemainingRoadCoverage(
    src('covered', 'covered'), src('uncovered', 'covered')), 'source-one-sided');
  assert.equal(classifyRemainingRoadCoverage(
    src('unattributed', 'covered'), src('uncovered', 'covered')), 'other-road-covered-both');
  assert.equal(classifyRemainingRoadCoverage(
    src('uncovered', 'uncovered'), src('uncovered', 'covered')), 'axis-inset-uncovered');
});

test('TKT-033: output run IDs cannot escape disposable benchmark directory', () => {
  const root = path.resolve('tkt033-source-probe-root');
  const a = parseRemainingRoadCheckArgs([], root);
  assert.equal(a.runId, 'first-pass');
  assert.equal(a.outDir, path.resolve(root, 'benchmarks/results/tkt033-remaining/first-pass'));
  assert.ok(a.existingPackPath.endsWith(
    path.join('tkt033-disposable', 'way-6661112-2x2.sqlite')));
  const b = parseRemainingRoadCheckArgs(['--run-id=retry-2'], root);
  assert.ok(b.outDir.endsWith(path.join('tkt033-remaining', 'retry-2')));
  for (const bad of ['../data/osm', '.', 'other/path', '', 'a b', 'C:\\windows']) {
    assert.throws(() => parseRemainingRoadCheckArgs(['--run-id=' + bad], root),
      /Run ID/);
  }
  assert.throws(() => parseRemainingRoadCheckArgs(['--out-dir=../../data/osm'], root),
    /Unexpected flag/);
});
