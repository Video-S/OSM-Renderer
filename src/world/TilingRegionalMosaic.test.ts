import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRegionalMosaicPlan,
  composeRegionalMosaicManifest,
  getRegionalShardQueryBounds,
  TWENTE_PILOT_CONFIG,
  type RegionalMosaicConfig,
  type RegionalMosaicPackInput,
} from './tiling/RegionalMosaicPlan';
import type { TileManifestEntry, TilePackMetadata } from './tiling/TilePackContract';

function mockInputs(
  config: RegionalMosaicConfig
): { plan: ReturnType<typeof createRegionalMosaicPlan>; inputs: RegionalMosaicPackInput[] } {
  const plan = createRegionalMosaicPlan(config);
  const inputs = plan.shards.map((shard): RegionalMosaicPackInput => {
    const metadata: TilePackMetadata = {
      snapshotId: 'overijssel-261114-8ae28196',
      sourceSha256: 'example-consistent-test-sha',
      projectionId: 'EPSG:25832',
      bakeSchemaVersion: '1.1.0',
      lodPolicyHash: 'identical-test-policy',
      compression: 'deflate',
      tileSizeMeters: shard.grid.tileSizeMeters,
      collarMeters: shard.grid.collarMeters,
      studyOriginEasting: shard.grid.projection.originEasting,
      studyOriginNorthing: shard.grid.projection.originNorthing,
      gridCols: shard.grid.cols,
      gridRows: shard.grid.rows,
      minTx: shard.grid.minTx,
      maxTx: shard.grid.maxTx,
      minTy: shard.grid.minTy,
      maxTy: shard.grid.maxTy,
      bakeStatus: 'complete',
      createdAtIso: '2026-11-21T00:00:00Z',
      completedAtIso: '2026-11-21T00:00:01Z',
    };
    const tiles = shard.grid.tiles.map((t): TileManifestEntry => ({
      lod: 0,
      tx: t.tx,
      ty: t.ty,
      minEasting: t.utmBounds.minEasting,
      maxEasting: t.utmBounds.maxEasting,
      minNorthing: t.utmBounds.minNorthing,
      maxNorthing: t.utmBounds.maxNorthing,
      tileCenterX: (t.localBounds.minX + t.localBounds.maxX) / 2,
      tileCenterZ: (t.localBounds.minZ + t.localBounds.maxZ) / 2,
      overhangMinX: -512,
      overhangMaxX: 512,
      overhangMinY: 0,
      overhangMaxY: 10,
      overhangMinZ: -512,
      overhangMaxZ: 512,
      triCount: 20,
      vertexCount: 60,
      featureCount: 3,
      isEmpty: false,
      hasBvh: true,
      rawBytes: 1024,
      compressedBytes: 200,
      contentHash: 'mock-hash',
    }));
    return { id: shard.id, metadata, tiles };
  });
  return { plan, inputs };
}

test('TKT-029: pilot grid covers 16.384km per side with 16 aligned independent 4x4 shards', () => {
  const plan = createRegionalMosaicPlan();
  assert.equal(plan.grid.cols, 16);
  assert.equal(plan.grid.rows, 16);
  assert.equal(plan.grid.tiles.length, 256);
  assert.equal(plan.shards.length, 16);
  assert.equal(plan.config.tileSizeMeters, 1024);
  assert.equal(plan.grid.studyLocalBounds.maxX - plan.grid.studyLocalBounds.minX, 16384);
  assert.equal(plan.grid.studyLocalBounds.maxZ - plan.grid.studyLocalBounds.minZ, 16384);

  const allKeys = new Set<string>();
  for (const shard of plan.shards) {
    assert.equal(shard.grid.tiles.length, 16);
    const query = getRegionalShardQueryBounds(shard, plan.config.contextMarginMeters);
    assert.ok(query.minLon < shard.grid.studyGeoBounds.minLon);
    assert.ok(query.maxLat > shard.grid.studyGeoBounds.maxLat);
    for (const tile of shard.grid.tiles) {
      const key = `${tile.tx}:${tile.ty}`;
      assert.ok(!allKeys.has(key), `Duplicate shard coverage ${key}`);
      allKeys.add(key);
    }
  }
  assert.deepEqual(allKeys, new Set(plan.grid.tiles.map((tile) => `${tile.tx}:${tile.ty}`)));
});

test('TKT-029: composing shard manifests rebases tile centers into regional study frame', () => {
  const { plan, inputs } = mockInputs({ ...TWENTE_PILOT_CONFIG, cols: 8, rows: 4 });
  const composed = composeRegionalMosaicManifest(plan, inputs);
  assert.equal(composed.metadata.gridCols, 8);
  assert.equal(composed.metadata.gridRows, 4);
  assert.equal(composed.tiles.length, 32);
  assert.equal(composed.ownerByTileKey.size, 32);
  assert.equal(composed.metadata.studyOriginEasting, plan.grid.projection.originEasting);
  assert.equal(composed.metadata.studyOriginNorthing, plan.grid.projection.originNorthing);

  for (const tile of composed.tiles) {
    const regionalX = (tile.minEasting + tile.maxEasting)/2 - composed.metadata.studyOriginEasting;
    const regionalZ = composed.metadata.studyOriginNorthing - (tile.minNorthing + tile.maxNorthing)/2;
    assert.ok(Math.abs(tile.tileCenterX - regionalX) < 1e-5);
    assert.ok(Math.abs(tile.tileCenterZ - regionalZ) < 1e-5);
    assert.equal(tile.overhangMinX, -512);
    assert.ok(composed.ownerByTileKey.has(`0:${tile.tx}:${tile.ty}`));
  }

  // The boundary between independent shards must map into the same regional
  // coordinate frame without gaps or overlapping tile centers.
  const row = plan.grid.maxTy;
  const west = composed.tiles.find((t) => t.ty === row && t.tx === plan.grid.minTx + 3)!;
  const east = composed.tiles.find((t) => t.ty === row && t.tx === plan.grid.minTx + 4)!;
  assert.equal(east.tileCenterX - west.tileCenterX, 1024);
  assert.equal(west.maxEasting, east.minEasting);
});

test('TKT-029: mosaic refuses missing, duplicate, conflicting-source or shifted shard packs', () => {
  const { plan, inputs } = mockInputs({ ...TWENTE_PILOT_CONFIG, cols: 8, rows: 4 });
  assert.throws(() => composeRegionalMosaicManifest(plan, inputs.slice(0, 1)), /incomplete/i);
  assert.throws(() => composeRegionalMosaicManifest(plan, [inputs[0], inputs[0]]), /Duplicate/);

  const badSource = structuredClone(inputs);
  badSource[1].metadata.sourceSha256 = 'a-different-snapshot';
  assert.throws(() => composeRegionalMosaicManifest(plan, badSource), /snapshot\/schema/i);

  const missingTile = structuredClone(inputs);
  missingTile[1].tiles.pop();
  assert.throws(() => composeRegionalMosaicManifest(plan, missingTile), /incomplete/i);

  const badCenter = structuredClone(inputs);
  badCenter[0].tiles[0].tileCenterX += 1024;
  assert.throws(() => composeRegionalMosaicManifest(plan, badCenter), /inconsistent coordinate origin/i);
});

test('TKT-029: configuration forbids partial shards and unbounded mosaic tile counts', () => {
  assert.throws(() => createRegionalMosaicPlan({ ...TWENTE_PILOT_CONFIG, cols: 15 }), /multiples/i);
  assert.throws(() => createRegionalMosaicPlan({ ...TWENTE_PILOT_CONFIG, cols: 128, rows: 128 }), /limit/i);
  assert.throws(() => createRegionalMosaicPlan({ ...TWENTE_PILOT_CONFIG, contextMarginMeters: 30 }), /context/i);
});
