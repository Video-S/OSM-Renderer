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
  getRegionalMosaicPreset,
  TWENTE_PILOT_CONFIG,
  type RegionalMosaicConfig,
  type RegionalMosaicIndex,
  type RegionalMosaicPackInput,
} from '../src/world/tiling/RegionalMosaicPlan';
import { TilePackSqliteStore } from '../src/server/tiles/TilePackSqliteStore';

export interface PartialShardVerifyOptions {
  shardsDir: string;
  config: RegionalMosaicConfig;
  shardIds?: readonly string[];
}

export interface PartialShardVerifySummary {
  partial: true;
  verifiedShards: number;
  plannedShards: number;
  verifiedShardIds: string[];
  tiles: number;
  nonEmptyTiles: number;
  compressedBytes: number;
  dbSizeBytes: number;
  orphanedStagingFiles: string[];
}

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

/**
 * Validates a bounded 1–N shard experimental bake before `mosaic.json` exists.
 * Checks canonical snapshot/SHA, schema, planned shard coordinates, every tile's
 * compressed SHA-256, and full binary `OSMTILE1` decode identity.
 */
export function verifyPartialRegionalShards(
  options: PartialShardVerifyOptions
): PartialShardVerifySummary {
  const shardsDir = path.resolve(options.shardsDir);
  if (!fs.existsSync(shardsDir)) {
    throw new Error(`Regional shards directory not found: ${shardsDir}`);
  }
  const plan = createRegionalMosaicPlan(options.config);
  const shardById = new Map(plan.shards.map((s) => [s.id, s]));

  let targetShardIds: string[];
  if (options.shardIds && options.shardIds.length > 0) {
    targetShardIds = Array.from(new Set(options.shardIds));
    for (const id of targetShardIds) {
      if (!shardById.has(id)) {
        throw new Error(`Shard "${id}" is not part of planned mosaic ${plan.config.name}`);
      }
    }
  } else {
    targetShardIds = fs
      .readdirSync(shardsDir)
      .filter((name) => /^r\d+-c\d+\.sqlite$/.test(name))
      .map((name) => name.slice(0, -'.sqlite'.length))
      .sort();
    if (targetShardIds.length === 0) {
      throw new Error(`No shard SQLite files (rXX-cYY.sqlite) found in ${shardsDir}`);
    }
  }

  const orphanedStagingFiles = fs
    .readdirSync(shardsDir)
    .filter((name) => name.includes('.staging-'))
    .sort();

  let tilesVerified = 0;
  let nonEmptyTiles = 0;
  let compressedBytes = 0;
  let dbSizeBytes = 0;
  let baselineLodPolicyHash: string | null = null;

  for (const shardId of targetShardIds) {
    const plannedShard = shardById.get(shardId);
    if (!plannedShard) {
      throw new Error(`Unexpected shard file "${shardId}.sqlite" outside plan ${plan.config.name}`);
    }
    const filepath = path.join(shardsDir, `${shardId}.sqlite`);
    const store = new TilePackSqliteStore(filepath, {
      expectedSnapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
      expectedSourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
    });
    try {
      const metadata = store.getMetadata();
      if (
        metadata.tileSizeMeters !== plannedShard.grid.tileSizeMeters ||
        metadata.collarMeters !== plannedShard.grid.collarMeters ||
        metadata.gridCols !== plannedShard.grid.cols ||
        metadata.gridRows !== plannedShard.grid.rows ||
        metadata.minTx !== plannedShard.grid.minTx ||
        metadata.maxTx !== plannedShard.grid.maxTx ||
        metadata.minTy !== plannedShard.grid.minTy ||
        metadata.maxTy !== plannedShard.grid.maxTy
      ) {
        throw new Error(
          `Shard ${shardId} grid bounds do not match plan ${plan.config.name} (expected tx=${plannedShard.grid.minTx}..${plannedShard.grid.maxTx}, ty=${plannedShard.grid.minTy}..${plannedShard.grid.maxTy})`
        );
      }
      if (baselineLodPolicyHash && metadata.lodPolicyHash !== baselineLodPolicyHash) {
        throw new Error(`Shard ${shardId} lodPolicyHash differs from earlier verified shards`);
      }
      baselineLodPolicyHash ??= metadata.lodPolicyHash;

      const tiles = store.listManifestEntries(0);
      if (tiles.length !== plannedShard.grid.tiles.length) {
        throw new Error(
          `Shard ${shardId} manifest tile count mismatch (${tiles.length} != ${plannedShard.grid.tiles.length})`
        );
      }
      const expectedTileKeys = new Set(plannedShard.grid.tiles.map((t) => `0:${t.tx}:${t.ty}`));
      for (const tile of tiles) {
        const key = `${tile.lod}:${tile.tx}:${tile.ty}`;
        if (!expectedTileKeys.has(key)) {
          throw new Error(`Shard ${shardId} contains unexpected tile ${key}`);
        }
        const decoded = store.getTileDecoded(tile.lod, tile.tx, tile.ty);
        if (!decoded) throw new Error(`Missing decoded tile ${tile.tx}:${tile.ty} in ${shardId}`);
        if (
          decoded.tx !== tile.tx ||
          decoded.ty !== tile.ty ||
          decoded.tileSizeMeters !== metadata.tileSizeMeters ||
          Math.abs(decoded.tileCenterX - tile.tileCenterX) > 0.01 ||
          Math.abs(decoded.tileCenterZ - tile.tileCenterZ) > 0.01
        ) {
          throw new Error(`Tile binary and shard manifest mismatch at ${shardId} (${tile.tx}:${tile.ty})`);
        }
        tilesVerified++;
        if (!tile.isEmpty) nonEmptyTiles++;
        compressedBytes += tile.compressedBytes;
      }
      const shardBytes = store.getFileSizeBytes();
      dbSizeBytes += shardBytes;
      console.log(
        `[regional:verify:partial] ${shardId}: ${tiles.length} tiles valid (${(shardBytes / 1048576).toFixed(2)} MiB SQLite)`
      );
    } finally {
      store.close();
    }
  }

  console.log(
    `[regional:verify:partial] PARTIAL / EXPERIMENTAL OK: ${targetShardIds.length}/${plan.shards.length} shards verified, ${tilesVerified} tiles (${nonEmptyTiles} non-empty), ${(compressedBytes / 1048576).toFixed(2)} MiB compressed, ${(dbSizeBytes / 1048576).toFixed(2)} MiB SQLite on disk.`
  );
  if (orphanedStagingFiles.length > 0) {
    console.warn(
      `[regional:verify:partial] WARNING: ${orphanedStagingFiles.length} orphaned staging file(s) found in ${shardsDir}: ${orphanedStagingFiles.join(', ')}`
    );
  }

  return {
    partial: true,
    verifiedShards: targetShardIds.length,
    plannedShards: plan.shards.length,
    verifiedShardIds: targetShardIds,
    tiles: tilesVerified,
    nonEmptyTiles,
    compressedBytes,
    dbSizeBytes,
    orphanedStagingFiles,
  };
}

function parseNumberArg(raw: string, key: string): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) throw new Error(`Invalid --${key}: ${raw}`);
  return n;
}

const isEntrypoint = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  try {
    const args = process.argv.slice(2);
    const hasShardsDir = args.some((x) => x.startsWith('--shards-dir='));
    const hasIndex = args.some((x) => x.startsWith('--index='));
    if (hasShardsDir && hasIndex) {
      throw new Error('Specify either --index=<mosaic.json> OR --shards-dir=<dir>, not both');
    }

    if (hasShardsDir) {
      let presetArg: string | undefined;
      for (const a of args) {
        if (a.startsWith('--preset=')) presetArg = a.slice('--preset='.length);
      }
      let config: RegionalMosaicConfig = presetArg
        ? getRegionalMosaicPreset(presetArg).config
        : { ...TWENTE_PILOT_CONFIG, centerLonLat: [...TWENTE_PILOT_CONFIG.centerLonLat] };
      let shardsDir = '';
      let shardIds: string[] | undefined;

      for (const arg of args) {
        const pivot = arg.indexOf('=');
        if (pivot < 0 || !arg.startsWith('--')) {
          throw new Error(`Unexpected argument: ${arg}`);
        }
        const key = arg.slice(2, pivot);
        const raw = arg.slice(pivot + 1);
        switch (key) {
          case 'preset': break;
          case 'shards-dir': shardsDir = path.resolve(raw); break;
          case 'shards':
            shardIds = raw.split(',').map((s) => s.trim()).filter(Boolean);
            break;
          case 'cols': config.cols = parseNumberArg(raw, key); break;
          case 'rows': config.rows = parseNumberArg(raw, key); break;
          case 'center-lon': config.centerLonLat[0] = parseNumberArg(raw, key); break;
          case 'center-lat': config.centerLonLat[1] = parseNumberArg(raw, key); break;
          case 'shard-dimension': config.shardDimension = parseNumberArg(raw, key); break;
          case 'context-meters': config.contextMarginMeters = parseNumberArg(raw, key); break;
          default:
            throw new Error(`Unknown flag for --shards-dir verification: --${key}`);
        }
      }
      verifyPartialRegionalShards({ shardsDir, config, shardIds });
    } else {
      const arg = args.find((x) => x.startsWith('--index='));
      const indexPath = arg ? path.resolve(arg.slice('--index='.length)) : undefined;
      if (args.some((x) => !x.startsWith('--index='))) {
        throw new Error(
          'Supported flags: --index=path/to/mosaic.json OR --shards-dir=dir --preset=twente-full [--shards=r05-c07,r05-c08]'
        );
      }
      verifyRegionalMosaic(indexPath);
    }
  } catch (err) {
    console.error('[regional:verify] Failed:', err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  }
}
