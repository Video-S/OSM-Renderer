import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { DecodedTilePayload } from './tiling/TilePackContract';
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
