import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  bakeHengeloTilesFromStore,
} from '../src/server/tiles/OfflineHengeloTileBaker';
import { TilePackSqliteStore } from '../src/server/tiles/TilePackSqliteStore';
import {
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  resolveOverijsselIndexPath,
} from '../src/server/osm/overijsselConfig';
import {
  CANONICAL_HENGELO_SNAPSHOT_ID,
} from '../src/world/tiling/TilePackContract';
import {
  createRegionalMosaicPlan,
  TWENTE_PILOT_CONFIG,
  type RegionalMosaicConfig,
  type RegionalMosaicIndex,
  type RegionalMosaicShard,
} from '../src/world/tiling/RegionalMosaicPlan';

export interface RegionalPilotBakeCliOptions {
  config: RegionalMosaicConfig;
  outDir: string;
  indexPath: string;
  force: boolean;
  maxShards?: number;
}

function getNumber(raw: string | undefined, name: string): number {
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
}

export function parseRegionalPilotBakeArgs(
  argv: readonly string[] = process.argv.slice(2)
): RegionalPilotBakeCliOptions {
  const config: RegionalMosaicConfig = {
    ...TWENTE_PILOT_CONFIG,
    centerLonLat: [...TWENTE_PILOT_CONFIG.centerLonLat],
  };
  let outDir = path.resolve('data/osm/twente-pilot-1024m');
  let force = false;
  let maxShards: number | undefined;
  for (const arg of argv) {
    if (arg === '--force') { force = true; continue; }
    const pivot = arg.indexOf('=');
    if (pivot < 0 || !arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg} (expected --key=value)`);
    }
    const key = arg.slice(2, pivot);
    const raw = arg.slice(pivot + 1);
    switch (key) {
      case 'out-dir': outDir = path.resolve(raw); break;
      case 'cols': config.cols = getNumber(raw, key); break;
      case 'rows': config.rows = getNumber(raw, key); break;
      case 'center-lon': config.centerLonLat[0] = getNumber(raw, key); break;
      case 'center-lat': config.centerLonLat[1] = getNumber(raw, key); break;
      case 'shard-dimension': config.shardDimension = getNumber(raw, key); break;
      case 'context-meters': config.contextMarginMeters = getNumber(raw, key); break;
      case 'max-shards': maxShards = getNumber(raw, key); break;
      default: throw new Error(`Unknown argument: --${key}`);
    }
  }
  return {
    config,
    outDir,
    indexPath: resolveOverijsselIndexPath(),
    force,
    maxShards,
  };
}

function validateExistingShard(
  filepath: string,
  shard: RegionalMosaicShard,
  sourceSha256: string
): boolean {
  if (!fs.existsSync(filepath)) return false;
  const pack = new TilePackSqliteStore(filepath, {
    expectedSnapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
    expectedSourceSha256: sourceSha256,
  });
  try {
    const meta = pack.getMetadata();
    if (
      meta.gridCols !== shard.grid.cols || meta.gridRows !== shard.grid.rows ||
      meta.minTx !== shard.grid.minTx || meta.maxTx !== shard.grid.maxTx ||
      meta.minTy !== shard.grid.minTy || meta.maxTy !== shard.grid.maxTy ||
      meta.tileSizeMeters !== shard.grid.tileSizeMeters ||
      meta.collarMeters !== shard.grid.collarMeters
    ) throw new Error(`Existing regional shard ${filepath} has incorrect grid coordinates`);
    return true;
  } finally {
    pack.close();
  }
}

/**
 * Progressive, resumable **offline** region bake.
 * Only one 4x4-tile shard's OSM is ingested at a time (never the full region).
 * A manifest is published atomically only after all packs are complete.
 *
 * IMPORTANT: each shard computes topology/plans independently with a context
 * margin. Cross-shard graph and railway-phase continuity must be validated
 * before calling the region production-quality. This is a scale pilot.
 */
export async function bakeRegionalPilot(
  options: RegionalPilotBakeCliOptions
): Promise<RegionalMosaicIndex | null> {
  const plan = createRegionalMosaicPlan(options.config);
  fs.mkdirSync(options.outDir, { recursive: true });
  const allShards = plan.shards;
  const toBake = options.maxShards === undefined
    ? allShards
    : allShards.slice(0, Math.max(0, Math.floor(options.maxShards)));
  let baked = 0;
  let reused = 0;
  for (const shard of toBake) {
    const outfile = path.join(options.outDir, `${shard.id}.sqlite`);
    if (!options.force && validateExistingShard(outfile, shard, OVERIJSSEL_PBF_EXPECTED_SHA256)) {
      reused++;
      console.log(`[regional] ${shard.id} already verified; reusing (${reused} reused)`);
      continue;
    }
    const step = baked + reused + 1;
    console.log(`[regional] ${step}/${allShards.length} baking ${shard.id} (${shard.grid.cols}×${shard.grid.rows} tiles)`);
    const { report } = bakeHengeloTilesFromStore({
      indexPath: options.indexPath,
      expectedSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
      grid: shard.grid,
      outPath: outfile,
      tileSizeMeters: options.config.tileSizeMeters,
      collarMeters: options.config.collarMeters,
      queryContextMarginMeters: options.config.contextMarginMeters,
      batchDimension: Math.min(4, options.config.shardDimension),
    });
    if (report.tileCounts.totalTiles !== shard.grid.tiles.length) {
      throw new Error(`Regional shard ${shard.id} wrote an incomplete tile count`);
    }
    baked++;
    console.log(`[regional] ${shard.id} complete: ${report.tileCounts.nonEmptyTiles} non-empty, ${report.tileCounts.totalTriangles} tris, ${(report.dbSizeBytes/1048576).toFixed(2)} MiB`);
  }
  if (toBake.length < allShards.length) {
    console.log(`[regional] Stopped after ${toBake.length}/${allShards.length} shards by --max-shards. No complete mosaic index published.`);
    return null;
  }
  const index: RegionalMosaicIndex = {
    schemaVersion: 1,
    config: plan.config,
    snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
    sourceSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
    shards: allShards.map((s) => ({ id: s.id, file: `${s.id}.sqlite` })),
  };
  const tmpPath = path.join(options.outDir, `mosaic.json.staging-${process.pid}`);
  fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, path.join(options.outDir, 'mosaic.json'));
  console.log(`[regional] Complete: ${allShards.length} shards / ${plan.grid.tiles.length} tiles covering ${(plan.grid.cols * plan.config.tileSizeMeters / 1000).toFixed(2)} × ${(plan.grid.rows * plan.config.tileSizeMeters / 1000).toFixed(2)} km. Baked ${baked}, reused ${reused}.`);
  return index;
}

const isEntrypoint = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  bakeRegionalPilot(parseRegionalPilotBakeArgs()).catch((err) => {
    console.error(`[regional] Bake failed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
