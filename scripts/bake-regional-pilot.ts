import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  bakeHengeloTilesFromStore,
} from '../src/server/tiles/OfflineHengeloTileBaker';
import { OverijsselOsmStore } from '../src/server/osm/OverijsselOsmStore';
import { TilePackSqliteStore } from '../src/server/tiles/TilePackSqliteStore';
import {
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  resolveOverijsselIndexPath,
} from '../src/server/osm/overijsselConfig';
import {
  CANONICAL_HENGELO_SNAPSHOT_ID,
  TilePackCorruptError,
  TilePackIncompatibleError,
} from '../src/world/tiling/TilePackContract';
import {
  createRegionalMosaicPlan,
  getRegionalMosaicPreset,
  TWENTE_PILOT_CONFIG,
  type RegionalMosaicConfig,
  type RegionalMosaicIndex,
  type RegionalMosaicShard,
} from '../src/world/tiling/RegionalMosaicPlan';
import {
  buildRegionalMosaicDryRunReport,
  formatRegionalMosaicDryRunMarkdown,
  type RegionalMosaicDryRunReport,
} from '../src/world/tiling/RegionalMosaicDryRun';
import {
  captureProcessMemorySnapshot,
  mergeProcessMemoryPeak,
} from '../src/world/tiling/TiledStudyPipeline';

export interface RegionalPilotBakeCliOptions {
  config: RegionalMosaicConfig;
  outDir: string;
  indexPath: string;
  force: boolean;
  recoverCorrupt: boolean;
  dryRun: boolean;
  reportOut?: string;
  markdownOut?: string;
  maxShards?: number;
  shardIds?: string[];
}

export type ExistingShardValidationResult =
  | { status: 'missing' }
  | { status: 'valid'; tileCount: number }
  | { status: 'corrupt_or_incomplete'; reason: string }
  | { status: 'incompatible_grid_or_source'; reason: string };

const RECOVERABLE_INCOMPATIBLE_REASONS = new Set([
  'incomplete_bake',
  'incomplete_tile_count',
  'missing_tables',
  'missing_metadata_key',
]);

function getNumber(raw: string | undefined, name: string): number {
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
}

export function parseRegionalPilotBakeArgs(
  argv: readonly string[] = process.argv.slice(2)
): RegionalPilotBakeCliOptions {
  // Pre-scan for --preset so explicit overrides always win regardless of flag order.
  let presetArg: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith('--preset=')) {
      presetArg = arg.slice('--preset='.length);
    }
  }

  let config: RegionalMosaicConfig = {
    ...TWENTE_PILOT_CONFIG,
    centerLonLat: [...TWENTE_PILOT_CONFIG.centerLonLat],
  };
  let outDir = path.resolve('data/osm/twente-pilot-1024m');
  if (presetArg) {
    const preset = getRegionalMosaicPreset(presetArg);
    config = preset.config;
    outDir = path.resolve(preset.defaultOutDir);
  }

  let indexPath = resolveOverijsselIndexPath();
  let force = false;
  let recoverCorrupt = false;
  let dryRun = false;
  let reportOut: string | undefined;
  let markdownOut: string | undefined;
  let maxShards: number | undefined;
  let shardIds: string[] | undefined;

  for (const arg of argv) {
    if (arg === '--force') { force = true; continue; }
    if (arg === '--recover-corrupt') { recoverCorrupt = true; continue; }
    if (arg === '--dry-run') { dryRun = true; continue; }
    const pivot = arg.indexOf('=');
    if (pivot < 0 || !arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg} (expected --key=value)`);
    }
    const key = arg.slice(2, pivot);
    const raw = arg.slice(pivot + 1);
    switch (key) {
      case 'preset': break; // already applied
      case 'out-dir': outDir = path.resolve(raw); break;
      case 'index-path': indexPath = path.resolve(raw); break;
      case 'cols': config.cols = getNumber(raw, key); break;
      case 'rows': config.rows = getNumber(raw, key); break;
      case 'center-lon': config.centerLonLat[0] = getNumber(raw, key); break;
      case 'center-lat': config.centerLonLat[1] = getNumber(raw, key); break;
      case 'shard-dimension': config.shardDimension = getNumber(raw, key); break;
      case 'context-meters': config.contextMarginMeters = getNumber(raw, key); break;
      case 'max-shards': maxShards = getNumber(raw, key); break;
      case 'shards': {
        const parsed = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (parsed.length === 0) {
          throw new Error('Invalid --shards: expected comma-separated shard IDs (e.g. r05-c07,r05-c08)');
        }
        shardIds = Array.from(new Set(parsed));
        break;
      }
      case 'report-out': reportOut = path.resolve(raw); break;
      case 'markdown-out': markdownOut = path.resolve(raw); break;
      default: throw new Error(`Unknown argument: --${key}`);
    }
  }

  return {
    config,
    outDir,
    indexPath,
    force,
    recoverCorrupt,
    dryRun,
    reportOut,
    markdownOut,
    maxShards,
    shardIds,
  };
}

/**
 * Removes orphaned `.staging-*` temporary files belonging to a specific shard
 * left behind by a previously interrupted or killed bake process.
 */
export function cleanupOrphanedShardStagingFiles(
  outDir: string,
  shardId: string
): string[] {
  if (!fs.existsSync(outDir)) return [];
  const prefix = `${shardId}.sqlite.staging-`;
  const removed: string[] = [];
  for (const name of fs.readdirSync(outDir)) {
    if (name.startsWith(prefix)) {
      fs.rmSync(path.join(outDir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}

/**
 * Inspects an existing shard SQLite pack before reusing it on resume.
 *
 * Verifies:
 * 1. Snapshot/source SHA-256, schema version, projection, and exact shard tile bounds.
 * 2. Complete tile count and compressed SHA-256 payload integrity for every tile.
 *
 * Clearly distinguishes incompatible grid/source packs (always fatal so a user
 * cannot silently overwrite another dataset) from corrupt/incomplete packs
 * (recoverable when --recover-corrupt is explicitly passed).
 */
export function inspectExistingRegionalShard(
  filepath: string,
  shard: RegionalMosaicShard,
  sourceSha256: string,
  expectedSnapshotId: string = CANONICAL_HENGELO_SNAPSHOT_ID
): ExistingShardValidationResult {
  if (!fs.existsSync(filepath)) return { status: 'missing' };

  let pack: TilePackSqliteStore;
  try {
    pack = new TilePackSqliteStore(filepath, {
      expectedSnapshotId,
      expectedSourceSha256: sourceSha256,
    });
  } catch (err) {
    if (err instanceof TilePackIncompatibleError) {
      if (RECOVERABLE_INCOMPATIBLE_REASONS.has(err.reason)) {
        return {
          status: 'corrupt_or_incomplete',
          reason: `${err.reason}: ${err.message}`,
        };
      }
      return {
        status: 'incompatible_grid_or_source',
        reason: `${err.reason}: ${err.message}`,
      };
    }
    // SQLite disk corruption, truncated header, or non-SQLite junk file
    return {
      status: 'corrupt_or_incomplete',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const meta = pack.getMetadata();
    if (
      meta.gridCols !== shard.grid.cols ||
      meta.gridRows !== shard.grid.rows ||
      meta.minTx !== shard.grid.minTx ||
      meta.maxTx !== shard.grid.maxTx ||
      meta.minTy !== shard.grid.minTy ||
      meta.maxTy !== shard.grid.maxTy ||
      meta.tileSizeMeters !== shard.grid.tileSizeMeters ||
      meta.collarMeters !== shard.grid.collarMeters
    ) {
      return {
        status: 'incompatible_grid_or_source',
        reason: `Existing regional shard ${filepath} has mismatched grid coordinates (expected tx=${shard.grid.minTx}..${shard.grid.maxTx}, ty=${shard.grid.minTy}..${shard.grid.maxTy}; found tx=${meta.minTx}..${meta.maxTx}, ty=${meta.minTy}..${meta.maxTy})`,
      };
    }

    // Verify every expected tile blob exists and matches its compressed SHA-256 hash.
    for (const tile of shard.grid.tiles) {
      const record = pack.getTileCompressed(0, tile.tx, tile.ty);
      if (!record) {
        return {
          status: 'corrupt_or_incomplete',
          reason: `Shard ${shard.id} missing expected tile 0:${tile.tx}:${tile.ty}`,
        };
      }
    }

    return { status: 'valid', tileCount: shard.grid.tiles.length };
  } catch (err) {
    if (err instanceof TilePackCorruptError) {
      return {
        status: 'corrupt_or_incomplete',
        reason: `${err.reason}: ${err.message}`,
      };
    }
    return {
      status: 'corrupt_or_incomplete',
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    pack.close();
  }
}

function removeShardAndSidecars(filepath: string): void {
  for (const candidate of [filepath, `${filepath}-wal`, `${filepath}-shm`]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { force: true });
    }
  }
}

export function runRegionalMosaicDryRun(
  options: Pick<
    RegionalPilotBakeCliOptions,
    'config' | 'outDir' | 'shardIds' | 'reportOut' | 'markdownOut'
  >
): RegionalMosaicDryRunReport {
  const plan = createRegionalMosaicPlan(options.config);
  if (options.shardIds && options.shardIds.length > 0) {
    const validIds = new Set(plan.shards.map((s) => s.id));
    for (const id of options.shardIds) {
      if (!validIds.has(id)) {
        throw new Error(`Unknown shard ID "${id}" for ${plan.config.name}`);
      }
    }
  }
  const report = buildRegionalMosaicDryRunReport(plan, {
    outDir: options.outDir,
    selectedShardIds: options.shardIds,
  });

  if (options.reportOut) {
    fs.mkdirSync(path.dirname(options.reportOut), { recursive: true });
    fs.writeFileSync(options.reportOut, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  if (options.markdownOut) {
    fs.mkdirSync(path.dirname(options.markdownOut), { recursive: true });
    fs.writeFileSync(options.markdownOut, formatRegionalMosaicDryRunMarkdown(report), 'utf8');
  }

  const g = report.grid;
  const ov = report.overijsselSourceCoverage;
  console.log(`[regional:dry-run] ${report.configName}`);
  console.log(
    `[regional:dry-run] Grid: ${g.cols}×${g.rows} (${g.totalTiles} tiles, ${g.totalShards} shards of ${g.shardDimension}×${g.shardDimension}) = ${g.widthKm.toFixed(3)} × ${g.heightKm.toFixed(3)} km (${g.rectangularAreaKm2.toFixed(2)} km²)`
  );
  console.log(
    `[regional:dry-run] Tile range: tx=${g.minTx}..${g.maxTx}, ty=${g.minTy}..${g.maxTy} | UTM E=${g.utmBounds.minEasting}..${g.utmBounds.maxEasting}, N=${g.utmBounds.minNorthing}..${g.utmBounds.maxNorthing}`
  );
  console.log(
    `[regional:dry-run] Center: [${g.centerLonLat[0]}, ${g.centerLonLat[1]}] | Pilot 1:1 shard matches: ${report.pilotAlignment.exactShardMatches}/${report.pilotAlignment.pilotShardCount}`
  );
  console.log(
    `[regional:dry-run] Overijssel extract coverage: ${ov.tiles.insideOverijssel} inside / ${ov.tiles.straddlesBoundary} border / ${ov.tiles.outsideOverijssel} outside tiles (${ov.shards.insideOverijssel} inside / ${ov.shards.straddlesBoundary} border / ${ov.shards.outsideOverijssel} outside shards)`
  );
  console.log(
    `[regional:dry-run] Existing output scan (${options.outDir}): ${report.existingOutputScan.existingShardFiles}/${g.totalShards} shard files present, ${report.existingOutputScan.orphanedStagingFiles.length} orphaned staging files`
  );
  console.log(
    `[regional:dry-run] ESTIMATES ONLY (non-measured): ~${report.estimates.estimatedCompressedStorageMiB.low}-${report.estimates.estimatedCompressedStorageMiB.high} MiB compressed, ~${report.estimates.estimatedWallTimeMinutes.low}-${report.estimates.estimatedWallTimeMinutes.high} min wall time`
  );
  if (options.shardIds && options.shardIds.length > 0) {
    console.log(`[regional:dry-run] Selected experimental shards (${options.shardIds.length}): ${options.shardIds.join(', ')}`);
  }
  return report;
}

/**
 * Progressive, resumable **offline** region bake.
 * Only one 4x4-tile shard's OSM is ingested at a time (never the full region).
 * A manifest is published atomically only after all planned shards are complete.
 *
 * IMPORTANT: each shard computes topology/plans independently with a context
 * margin. Cross-shard graph and railway-phase continuity must be validated
 * before calling the region production-quality.
 */
export async function bakeRegionalPilot(
  options: RegionalPilotBakeCliOptions
): Promise<RegionalMosaicIndex | null> {
  if (options.dryRun) {
    runRegionalMosaicDryRun(options);
    return null;
  }

  const plan = createRegionalMosaicPlan(options.config);
  fs.mkdirSync(options.outDir, { recursive: true });
  const allShards = plan.shards;

  let toBake: RegionalMosaicShard[] = allShards;
  if (options.shardIds && options.shardIds.length > 0) {
    const byId = new Map(allShards.map((s) => [s.id, s]));
    toBake = options.shardIds.map((id) => {
      const shard = byId.get(id);
      if (!shard) {
        throw new Error(`Unknown shard ID "${id}" for ${plan.config.name}`);
      }
      return shard;
    });
  }
  if (options.maxShards !== undefined) {
    toBake = toBake.slice(0, Math.max(0, Math.floor(options.maxShards)));
  }

  const tRunStart = performance.now();
  let peakMemory = captureProcessMemorySnapshot();
  let sharedStore: OverijsselOsmStore | null = null;
  let baked = 0;
  let reused = 0;
  let recovered = 0;
  let totalBakedDbBytes = 0;

  try {
    for (const shard of toBake) {
      const outfile = path.join(options.outDir, `${shard.id}.sqlite`);
      const removedOrphans = cleanupOrphanedShardStagingFiles(options.outDir, shard.id);
      if (removedOrphans.length > 0) {
        console.log(
          `[regional] Cleaned ${removedOrphans.length} orphaned staging file(s) for ${shard.id}`
        );
      }

      if (!options.force) {
        const validation = inspectExistingRegionalShard(
          outfile,
          shard,
          OVERIJSSEL_PBF_EXPECTED_SHA256
        );
        if (validation.status === 'valid') {
          reused++;
          totalBakedDbBytes += fs.statSync(outfile).size;
          console.log(`[regional] ${shard.id} already verified; reusing (${reused} reused)`);
          continue;
        }
        if (validation.status === 'incompatible_grid_or_source') {
          throw new Error(
            `Refusing to reuse or overwrite incompatible shard ${shard.id}: ${validation.reason}`
          );
        }
        if (validation.status === 'corrupt_or_incomplete') {
          if (!options.recoverCorrupt) {
            throw new Error(
              `Existing shard ${shard.id} is corrupt or incomplete (${validation.reason}). Re-run with --recover-corrupt (or --force) to rebuild it cleanly.`
            );
          }
          console.warn(
            `[regional] Recovering corrupt/incomplete shard ${shard.id}: ${validation.reason}`
          );
          removeShardAndSidecars(outfile);
          recovered++;
        }
      }

      if (!sharedStore) {
        sharedStore = new OverijsselOsmStore(options.indexPath, {
          expectedSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
        });
      }

      const step = baked + reused + 1;
      const tShard0 = performance.now();
      console.log(
        `[regional] ${step}/${toBake.length} (plan ${allShards.length}) baking ${shard.id} (${shard.grid.cols}×${shard.grid.rows} tiles)`
      );
      const { report } = bakeHengeloTilesFromStore({
        store: sharedStore,
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

      const maybeGc = (globalThis as { gc?: () => void }).gc;
      if (typeof maybeGc === 'function') {
        maybeGc();
      }
      const memNow = captureProcessMemorySnapshot();
      peakMemory = mergeProcessMemoryPeak(peakMemory, report.memoryMB.peakDuringBake);
      peakMemory = mergeProcessMemoryPeak(peakMemory, memNow);

      baked++;
      totalBakedDbBytes += report.dbSizeBytes;
      const shardSec = ((performance.now() - tShard0) / 1000).toFixed(1);
      console.log(
        `[regional] ${shard.id} complete in ${shardSec}s: ${report.tileCounts.nonEmptyTiles} non-empty, ${report.tileCounts.totalTriangles} tris, ${(report.dbSizeBytes / 1048576).toFixed(2)} MiB (RSS ${memNow.rssMB ?? '?'} MiB, heap ${memNow.heapUsedMB ?? '?'} MiB)`
      );
    }
  } finally {
    sharedStore?.close();
    sharedStore = null;
  }

  const runSec = ((performance.now() - tRunStart) / 1000).toFixed(1);
  const isPartialSubset =
    toBake.length < allShards.length ||
    (options.shardIds !== undefined && options.shardIds.length < allShards.length);
  if (isPartialSubset) {
    console.log(
      `[regional] Partial run finished (${toBake.length}/${allShards.length} shards; baked=${baked}, reused=${reused}, recovered=${recovered}) in ${runSec}s, peak RSS=${peakMemory.rssMB ?? '?'} MiB, subset size=${(totalBakedDbBytes / 1048576).toFixed(2)} MiB. No complete mosaic.json published.`
    );
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
  console.log(
    `[regional] Complete in ${runSec}s: ${allShards.length} shards / ${plan.grid.tiles.length} tiles covering ${((plan.grid.cols * plan.config.tileSizeMeters) / 1000).toFixed(2)} × ${((plan.grid.rows * plan.config.tileSizeMeters) / 1000).toFixed(2)} km. Baked ${baked}, reused ${reused}, recovered ${recovered}, total ${(totalBakedDbBytes / 1048576).toFixed(2)} MiB, peak RSS ${peakMemory.rssMB ?? '?'} MiB.`
  );
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
