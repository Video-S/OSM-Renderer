import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRegionalMosaicPlan,
  TWENTE_PILOT_CONFIG,
} from './tiling/RegionalMosaicPlan';
import { utm32NToGeo } from './tiling/RegionalProjection';
import {
  collectTileFeatureEvidence,
  compareFeatureEvidence,
  enumerateRegionalShardSeams,
  extractSourceCrossings,
  getCrossingPairIndex,
  probeSourceSurfaceAtUtm,
  type ShardSideInterface,
} from './tiling/RegionalSeamAudit';
import type { DecodedTilePayload } from './tiling/TilePackContract';
import { parseRegionalSeamAuditArgs } from '../../scripts/audit-regional-seams';

function lineFeature(
  id: string, tags: Record<string, string>,
  points: [number, number][]
) {
  return {
    type: 'Feature',
    id,
    properties: tags,
    geometry: { type: 'LineString', coordinates: points.map(([e, n]) => utm32NToGeo(e, n)) },
  };
}
function polygonFeature(
  id: string, tags: Record<string, string>,
  rings: Array<Array<[number, number]>>
) {
  return {
    type: 'Feature',
    id,
    properties: tags,
    geometry: {
      type: 'Polygon',
      coordinates: rings.map((r) => r.map(([e, n]) => utm32NToGeo(e, n))),
    },
  };
}
function crossingLine(side: ShardSideInterface, at: number, id: string, tags: Record<string, string>) {
  return lineFeature(id, tags, side.axis === 'easting'
    ? [[side.at - 20, at - 8], [side.at + 20, at + 8]]
    : [[at - 8, side.at - 20], [at + 8, side.at + 20]]);
}
function tileWithEmission(
  ids: Array<{ id: string; layer?: number; bridge?: boolean; tunnel?: boolean }>,
  hasMesh: boolean
): DecodedTilePayload {
  return {
    featureInfos: ids.map((x) => ({
      id: 'rendered-' + x.id,
      sourceFeatureId: x.id,
      category: 'Road & Way',
      subtype: 'primary',
      primaryTag: 'highway=primary',
      cartoLabel: 'Road',
      osmTags: {},
      layer: x.layer,
      isBridge: x.bridge,
      isTunnel: x.tunnel,
    })),
    meshes: hasMesh
      ? [{
        positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 0, 2]),
        singleFeatureIdx: ids.length ? 0 : -1,
        faceRanges: ids.slice(1).map((_, i) => ({
          startFace: i, endFace: i + 1, infoIdx: i + 1,
        })),
      }] : [],
    instancedBatches: [],
  } as unknown as DecodedTilePayload;
}

test('TKT-032: complete default 24 side interfaces + 9 four-way intersections', () => {
  const plan = createRegionalMosaicPlan(TWENTE_PILOT_CONFIG);
  const { sides, junctions } = enumerateRegionalShardSeams(plan);
  assert.equal(sides.length, 24);
  assert.equal(junctions.length, 9);
  assert.equal(new Set(sides.map((s) => s.id)).size, 24);
  assert.equal(new Set(junctions.map((s) => s.id)).size, 9);
  for (const s of sides) {
    assert.equal(s.pairs.length, 4);
    assert.equal(s.to - s.from, 4096);
    for (const p of s.pairs) {
      assert.equal(p.to - p.from, 1024);
      if (s.axis === 'easting') {
        assert.equal(p.b.tx - p.a.tx, 1);
        assert.equal(p.b.ty, p.a.ty);
        assert.equal(p.a.tx * 1024 + 1024, s.at);
        assert.equal(p.from, p.a.ty * 1024);
      } else {
        assert.equal(p.a.tx, p.b.tx);
        assert.equal(p.a.ty - p.b.ty, 1);
        assert.equal(p.b.ty * 1024 + 1024, s.at);
        assert.equal(p.from, p.a.tx * 1024);
      }
    }
  }
  for (const j of junctions) {
    assert.equal(new Set(j.shards).size, 4);
    assert.equal(j.easting % 1024, 0);
    assert.equal(j.northing % 1024, 0);
  }
});

test('TKT-032: source crossing inventory checks vertical and horizontal lines and rejects mere touches', () => {
  const { sides } = enumerateRegionalShardSeams();
  for (const axis of ['easting', 'northing'] as const) {
    const side = sides.find((s) => s.axis === axis)!;
    const mid = side.pairs[1].from + 512;
    const road = crossingLine(side, mid, 'way/123', { highway: 'primary', layer: '-1', tunnel: 'yes' });
    const rail = crossingLine(side, mid + 5, 'way/456', { railway: 'rail', bridge: 'yes', layer: '1' });
    const onlyTouch = lineFeature('way/tangent', { highway: 'service' }, axis === 'easting'
      ? [[side.at - 10, mid], [side.at, mid], [side.at - 20, mid + 4]]
      : [[mid, side.at - 10], [mid, side.at], [mid + 4, side.at - 20]]);
    const nonCrossing = lineFeature('way/elsewhere', { highway: 'primary' }, axis === 'easting'
      ? [[side.at - 50, mid], [side.at - 30, mid + 1]]
      : [[mid, side.at - 50], [mid + 1, side.at - 30]]);
    const out = extractSourceCrossings(side, { features: [road, rail, onlyTouch, nonCrossing] });
    assert.deepEqual(out.map((x) => x.sourceId), ['way/123', 'way/456']);
    assert.equal(out[0].pairIndex, 1);
    assert.equal(out[0].category, 'road');
    assert.equal(out[1].category, 'rail');
    assert.equal(getCrossingPairIndex(side,
      out[0].easting, out[0].northing), 1);
  }
});

test('TKT-032: crossing through an explicit seam vertex counts, but tangent does not', () => {
  const { sides } = enumerateRegionalShardSeams();
  for (const side of sides.filter((s) => s.axis === 'easting' || s.axis === 'northing').slice(0, 2)) {
    const at = side.pairs[0].from + 100;
    const crossing = lineFeature('way/via-node', { highway: 'primary' }, side.axis === 'easting'
      ? [[side.at - 10, at], [side.at, at], [side.at + 10, at]]
      : [[at, side.at - 10], [at, side.at], [at, side.at + 10]]);
    const tangent = lineFeature('way/tangent', { highway: 'primary' }, side.axis === 'easting'
      ? [[side.at - 10, at], [side.at, at], [side.at - 10, at]]
      : [[at, side.at - 10], [at, side.at], [at, side.at - 10]]);
    const matches = extractSourceCrossings(side, { features: [crossing, tangent] });
    assert.deepEqual(matches.map((x) => x.sourceId), ['way/via-node']);
  }
});

test('TKT-032: long water/landuse polygon contains border even without edge intersection', () => {
  const side = enumerateRegionalShardSeams().sides.find((s) => s.axis === 'easting')!;
  const mid = (side.from + side.to) / 2;
  const polygon = polygonFeature('way/water', { natural: 'water' }, [[
    [side.at - 100, side.from - 100],
    [side.at + 100, side.from - 100],
    [side.at + 100, side.to + 100],
    [side.at - 100, side.to + 100],
    [side.at - 100, side.from - 100],
  ]]);
  const out = extractSourceCrossings(side, { features: [polygon] });
  assert.equal(out.length, 1);
  assert.equal(out[0].sourceId, 'way/water');
  assert.equal(out[0].mode, 'polygon-interior');
  assert.ok(Math.abs(out[0].northing - mid) < 0.01);
});

test('TKT-032: feature presence counts only geometrically emitted metadata, not unused tile features', () => {
  const ignored = collectTileFeatureEvidence(
    tileWithEmission([{ id: 'way/10' }], false), 500000, 5800000);
  assert.equal(ignored.featureIds.has('way/10'), false);
  const first = collectTileFeatureEvidence(
    tileWithEmission([{ id: 'way/10', layer: -3, tunnel: true }], true), 500000, 5800000);
  const second = collectTileFeatureEvidence(
    tileWithEmission([{ id: 'way/10', layer: 0, tunnel: false }], true), 500000, 5800000);
  assert.equal(compareFeatureEvidence('way/10', first, ignored).classification, 'only-a');
  const matched = compareFeatureEvidence('way/10', first, second);
  assert.equal(matched.classification, 'both');
  assert.equal(matched.layerMismatch, true);
  assert.equal(matched.tunnelMismatch, true);
  assert.equal(compareFeatureEvidence('way/404', first, second).classification, 'neither');
});

test('TKT-032: tile-local sleeper centers rebase into global easting/northing with north-positive Y', () => {
  const tile = tileWithEmission([], false);
  tile.instancedBatches.push({
    instanceCount: 1,
    instanceFeatureIdxs: new Int32Array([-1]),
    sleeperBoxes: [{
      cx: 10, cz: 20, trackId: 'rail/1',
      yBottom: 0.2, yTop: 0.3,
    }],
  } as unknown as DecodedTilePayload['instancedBatches'][number]);
  const ev = collectTileFeatureEvidence(tile, 500000, 5800000);
  assert.deepEqual(ev.sleeperBoxes[0], {
    trackId: 'rail/1', easting: 500010, northing: 5799980,
    elevation: 0.25,
  });
});

test('TKT-032: audit CLI is read-only by default and rejects ambiguous filters', () => {
  const opt = parseRegionalSeamAuditArgs([]);
  assert.ok(opt.indexPath.endsWith('mosaic.json'));
  assert.equal(opt.bandMeters, 32);
  assert.equal(opt.boundaryId, undefined);
  const filtered = parseRegionalSeamAuditArgs([
    '--boundary=vertical-r0-c0-1', '--feature=way/123',
    '--band-meters=48', '--out=benchmarks/results/test.json',
  ]);
  assert.equal(filtered.boundaryId, 'vertical-r0-c0-1');
  assert.equal(filtered.featureId, 'way/123');
  assert.equal(filtered.bandMeters, 48);
  assert.throws(() => parseRegionalSeamAuditArgs(['--band-meters=0']), /band-meters/);
  assert.throws(() => parseRegionalSeamAuditArgs(['--unknown=1']), /Unknown/);
});


test('TKT-032: source-attributed triangle inset probe measures coverage and height', () => {
  const payload = tileWithEmission([{ id: 'way/road' }], true);
  payload.meshes[0] = {
    ...payload.meshes[0],
    layer: 'roads',
    localPositionOffset: [0, 1.25, 0],
    positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 0, 2]),
    indices: new Uint16Array([0, 1, 2]),
    faceRanges: [],
    singleFeatureIdx: 0,
  };
  const covered = probeSourceSurfaceAtUtm(payload, 500000, 5800000,
    'way/road', 500000.25, 5799999.75);
  assert.equal(covered.status, 'covered');
  assert.deepEqual(covered.heights, [1.25]);
  assert.equal(covered.matchedMeshes, 1);
  const outside = probeSourceSurfaceAtUtm(payload, 500000, 5800000,
    'way/road', 500003, 5799997);
  assert.equal(outside.status, 'uncovered');
  const wrongSource = probeSourceSurfaceAtUtm(payload, 500000, 5800000,
    'way/different', 500000.25, 5799999.75);
  assert.equal(wrongSource.status, 'unattributed');
});

test('TKT-032: face-range metadata prevents another overlapping feature from masking omissions', () => {
  const payload = tileWithEmission([{ id: 'way/alpha' }, { id: 'way/bravo' }], true);
  payload.meshes[0] = {
    ...payload.meshes[0],
    layer: 'roads',
    localPositionOffset: [0, 0, 0],
    singleFeatureIdx: -1,
    positions: new Float32Array([
      0, 0, 0, 2, 0, 0, 0, 0, 2,
      0, 3, 0, 2, 3, 0, 0, 3, 2,
    ]),
    indices: null,
    faceRanges: [
      { startFace: 0, endFace: 1, infoIdx: 0 },
      { startFace: 1, endFace: 2, infoIdx: 1 },
    ],
  };
  const p = [500000.4, 5799999.6] as const;
  assert.deepEqual(probeSourceSurfaceAtUtm(payload, 500000, 5800000,
    'way/alpha', ...p).heights, [0]);
  assert.deepEqual(probeSourceSurfaceAtUtm(payload, 500000, 5800000,
    'way/bravo', ...p).heights, [3]);
  assert.equal(probeSourceSurfaceAtUtm(payload, 500000, 5800000,
    'way/unknown', ...p).status, 'unattributed');
});
