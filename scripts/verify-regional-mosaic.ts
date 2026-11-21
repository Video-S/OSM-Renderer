import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CANONICAL_HENGELO_SNAPSHOT_ID,
  CANONICAL_HENGELO_SOURCE_SHA256,
} from '../src/world/tiling/TilePackContract';
import {
  composeRegionalMosaicManifest,
  createRegionalMosaicPlan,
  type RegionalMosaicIndex,
  type RegionalMosaicPackInput,
} from '../src/world/tiling/RegionalMosaicPlan';
import { TilePackSqliteStore } from '../src/server/tiles/TilePackSqliteStore';

/**
 * Validate completed regional mosaic metadata, tile coverage, source integrity,
 * every tile's compressed SHA-256 and binary decode identity.
 *
 * This is NOT a cross-shard E2+/R+ graph/seam equivalence proof. It deliberately
 * avoids expensive whole-region reference synthesis.
 */
export function verifyRegionalMosaic(indexPath = path.resolve('data/osm/twente-pilot-1024m/mosaic.json')): {
  shards: number;
  tiles: number;
  nonEmptyTiles: number;
  compressedBytes: number;
} {
  const sourceFile = path.resolve(indexPath);
  const index = JSON.parse(fs.readFileSync(sourceFile, 'utf8')) as RegionalMosaicIndex;
  if (index.schemaVersion !== 1 ||
      index.snapshotId !== CANONICAL_HENGELO_SNAPSHOT_ID ||
      index.sourceSha256.toLowerCase() !== CANONICAL_HENGELO_SOURCE_SHA256) {
    throw new Error('Regional mosaic index is not the canonical snapshot');
  }
  const plan = createRegionalMosaicPlan(index.config);
  const inputs: RegionalMosaicPackInput[] = [];
  let count = 0;
  let nonEmpty = 0;
  let compressedBytes = 0;
  for (const shardIndex of index.shards) {
    if (!shardIndex.id || !shardIndex.file || path.isAbsolute(shardIndex.file) ||
      shardIndex.file.split(/[\\/]/).includes('..')) {
      throw new Error('Unsafe or invalid regional mosaic shard file');
    }
    const filepath = path.resolve(path.dirname(sourceFile), shardIndex.file);
    const store = new TilePackSqliteStore(filepath, {
      expectedSnapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
      expectedSourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
    });
    try {
      const metadata = store.getMetadata();
      const tiles = store.listManifestEntries(0);
      for (const tile of tiles) {
        const decoded = store.getTileDecoded(tile.lod, tile.tx, tile.ty);
        if (!decoded) throw new Error(`Missing decoded tile ${tile.tx}:${tile.ty}`);
        if (
          decoded.tx !== tile.tx || decoded.ty !== tile.ty ||
          decoded.tileSizeMeters !== metadata.tileSizeMeters ||
          Math.abs(decoded.tileCenterX - tile.tileCenterX) > 0.01 ||
          Math.abs(decoded.tileCenterZ - tile.tileCenterZ) > 0.01
        ) throw new Error(`Tile binary and shard manifest mismatch at ${tile.tx}:${tile.ty}`);
        count++;
        if (!tile.isEmpty) nonEmpty++;
        compressedBytes += tile.compressedBytes;
      }
      inputs.push({ id: shardIndex.id, metadata, tiles });
      console.log(`[regional:verify] ${shardIndex.id}: ${tiles.length} tiles valid`);
    } finally {
      store.close();
    }
  }
  const composed = composeRegionalMosaicManifest(plan, inputs);
  if (count !== plan.grid.tiles.length || count !== composed.tiles.length) {
    throw new Error('Regional mosaic final tile-count mismatch');
  }
  console.log(`[regional:verify] OK: ${inputs.length} shards, ${count} tiles (${nonEmpty} non-empty), ${(compressedBytes/1048576).toFixed(2)} MiB compressed`);
  console.log('[regional:verify] NOTE: Cross-shard E2+/R+ geometry and sleeper-phase seam parity still need human/targeted tests.');
  return { shards: inputs.length, tiles: count, nonEmptyTiles: nonEmpty, compressedBytes };
}

const isEntrypoint = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  try {
    const args = process.argv.slice(2);
    const arg = args.find((x) => x.startsWith('--index='));
    const indexPath = arg ? path.resolve(arg.slice('--index='.length)) : undefined;
    if (args.some((x) => !x.startsWith('--index='))) {
      throw new Error('Supported flag: --index=path/to/mosaic.json');
    }
    verifyRegionalMosaic(indexPath);
  } catch (err) {
    console.error('[regional:verify] Failed:', err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  }
}
