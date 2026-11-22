import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseDisposableRoadBakeArgs, visibleRoadOnlyTile } from '../../scripts/bake-and-verify-missing-road';
import {
  TILE_MESH_FLAG_VISIBLE,
  TILE_MESH_FLAG_HIDDEN_UNDERGROUND,
  type DecodedTilePayload,
} from './tiling/TilePackContract';

test('TKT-033: disposable source-backed bake defaults to safe separate 2x2 pack', () => {
  const root = path.resolve('tkt033-nonexistent-test-root');
  const parsed = parseDisposableRoadBakeArgs([], root);
  assert.equal(parsed.target.sourceId, 'way/6661112');
  assert.equal(parsed.target.easting, 357376);
  assert.equal(parsed.target.northing, 5791095.095);
  assert.ok(parsed.packPath.startsWith(path.join(root, 'benchmarks/results/tkt033-disposable') + path.sep));
  assert.ok(parsed.packPath.endsWith(path.join('tkt033-disposable', 'way-6661112-2x2.sqlite')));
  assert.ok(parsed.jsonPath.endsWith(path.join('tkt033-disposable', 'way-6661112-2x2-report.json')));
});

test('TKT-033: other confirmed roads resolve source coordinates but cannot write canonical packs', () => {
  const root = path.resolve('tkt033-nonexistent-test-root');
  const parsed = parseDisposableRoadBakeArgs(['--feature=way/6666519'], root);
  assert.equal(parsed.target.easting, 351822.7);
  assert.equal(parsed.target.northing, 5790720);
  assert.ok(parsed.packPath.endsWith('way-6666519-2x2.sqlite'));
  assert.throws(() => parseDisposableRoadBakeArgs([
    '--pack-out=data/osm/twente-pilot-1024m/r00-c00.sqlite',
  ], root), /must remain/);
  assert.throws(() => parseDisposableRoadBakeArgs([
    '--pack-out=../somewhere.sqlite',
  ], root), /must remain/);
  assert.throws(() => parseDisposableRoadBakeArgs([
    '--json-out=benchmarks/results/tkt033-disposable/replay.sqlite',
  ], root), /distinct/);
  assert.throws(() => parseDisposableRoadBakeArgs([
    '--out-pack=benchmarks/results/tkt033-disposable/file.sqlite',
  ], root), /Unknown/);
});

test('TKT-033: explicit coordinates and noncanonical diagnostic filenames remain supported', () => {
  const root = path.resolve('tkt033-nonexistent-test-root');
  const args = [
    '--feature=way/custom',
    '--easting=357376',
    '--northing=5791095.095',
    '--context-meters=1024',
    '--pack-out=benchmarks/results/tkt033-disposable/custom-repro.sqlite',
    '--json-out=benchmarks/results/tkt033-disposable/custom-repro.json',
  ];
  const parsed = parseDisposableRoadBakeArgs(args, root);
  assert.equal(parsed.target.sourceId, 'way/custom');
  assert.equal(parsed.target.contextMeters, 1024);
  assert.equal(path.basename(parsed.packPath), 'custom-repro.sqlite');
  assert.equal(path.basename(parsed.jsonPath), 'custom-repro.json');
});

test('TKT-033: only physically visible road meshes qualify as packed coverage', () => {
  const tile = {
    meshes: [
      { layer: 'roads', name: 'real road', flags: TILE_MESH_FLAG_VISIBLE },
      { layer: 'roads', name: 'invisible road', flags: 0 },
      { layer: 'roads', name: 'hidden underground', flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_HIDDEN_UNDERGROUND },
      { layer: 'landuse', name: 'not a road', flags: TILE_MESH_FLAG_VISIBLE },
    ],
  } as unknown as DecodedTilePayload;
  const filtered = visibleRoadOnlyTile(tile);
  assert.deepEqual(filtered.meshes.map(m => m.name), ['real road']);
  assert.equal(tile.meshes.length, 4, 'The original decoded payload remains untouched');
});
