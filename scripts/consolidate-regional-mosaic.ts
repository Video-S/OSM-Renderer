/**
 * Standalone Offline Tile Consolidation CLI (TKT-037)
 *
 * Consolidates an existing baked OSMTILE1 regional mosaic (e.g. 1,024 m) into
 * larger spatial rendering batches (2,048 m and/or 4,096 m) strictly offline,
 * without invoking GeometryBuilder or overwriting the source dataset.
 *
 * Example (Windows PowerShell):
 *   npx tsx scripts/consolidate-regional-mosaic.ts `
 *     --index=data/osm/twente-full-1024m-foliage-fix/mosaic.json `
 *     --target-tile-size=2048,4096 `
 *     --out-root=data/osm
 */
import path from 'node:path';
import {
  consolidateRegionalMosaic,
  type ConsolidationMosaicReport,
} from '../src/server/tiles/OfflineTileConsolidator';
import {
  parseSpatialSubBatchPolicy,
  type SpatialSubBatchPolicy,
} from '../src/world/tiling/TileConsolidator';

function readArg(args: string[], prefix: string): string | undefined {
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        'Usage: npx tsx scripts/consolidate-regional-mosaic.ts [options]',
        '',
        'Required:',
        '  --index=<path>                Source mosaic.json (e.g. data/osm/twente-full-1024m-foliage-fix/mosaic.json)',
        '  --target-tile-size=<sizes>    Target tile size(s) in meters, e.g. 2048 or 2048,4096',
        '',
        'Output (one of):',
        '  --out=<dir>                   Explicit output directory (when a single target size is requested)',
        '  --out-root=<dir>              Parent output directory (auto-creates <sourceDir>-<size>m subdirectories)',
        '',
        'Options:',
        '  --foliage-batch=<policy>      parent | child | <meters> (default: parent)',
        '  --sleeper-batch=<policy>      parent | child | <meters> (default: child)',
        '  --shard-cols=<n>              Optional explicit parent shard width in tiles',
        '  --shard-rows=<n>              Optional explicit parent shard height in tiles',
        '  --max-open-shards=<n>         Bounded source SQLite LRU cache size (default: 8)',
        '  --no-bvh                      Skip MeshBVH rebuild (not recommended for inspection)',
        '  --no-verify                   Skip post-consolidation shard integrity verification',
        '  --allow-custom-snapshot       Allow non-canonical synthetic snapshots',
      ].join('\n')
    );
    return;
  }

  const indexArg = readArg(args, '--index=');
  if (!indexArg) {
    throw new Error('Missing required --index=<path/to/mosaic.json>');
  }

  const targetSizesRaw = readArg(args, '--target-tile-size=') ?? '2048,4096';
  const targetSizes = targetSizesRaw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  if (targetSizes.length === 0) {
    throw new Error(`Invalid --target-tile-size="${targetSizesRaw}"`);
  }

  const explicitOut = readArg(args, '--out=');
  const outRoot = readArg(args, '--out-root=') ?? path.dirname(path.dirname(path.resolve(indexArg)));
  if (explicitOut && targetSizes.length > 1) {
    throw new Error('Use --out-root=<dir> instead of --out=<dir> when requesting multiple target tile sizes');
  }

  const foliageBatchMode: SpatialSubBatchPolicy = parseSpatialSubBatchPolicy(
    readArg(args, '--foliage-batch=') ?? 'parent'
  );
  const sleeperBatchMode: SpatialSubBatchPolicy = parseSpatialSubBatchPolicy(
    readArg(args, '--sleeper-batch=') ?? 'child'
  );
  const shardColsRaw = readArg(args, '--shard-cols=');
  const shardRowsRaw = readArg(args, '--shard-rows=');
  const maxOpenShardsRaw = readArg(args, '--max-open-shards=');
  const includeBvh = !args.includes('--no-bvh');
  const verifyOutput = !args.includes('--no-verify');
  const allowCustomSnapshot = args.includes('--allow-custom-snapshot');

  const sourceFolderName = path.basename(path.dirname(path.resolve(indexArg)));
  const strippedBase = sourceFolderName.replace(/-1024m(?=-|$)/i, '');

  const reports: ConsolidationMosaicReport[] = [];

  for (const targetSize of targetSizes) {
    const outDir = explicitOut
      ? path.resolve(explicitOut)
      : path.resolve(outRoot, `${strippedBase}-batched-${targetSize}m`);

    console.log(
      `[consolidate] Starting ${sourceFolderName} -> ${targetSize}m (foliage=${String(foliageBatchMode)}, sleeper=${String(sleeperBatchMode)}) -> ${outDir}`
    );

    let lastLoggedPct = -1;
    const report = consolidateRegionalMosaic({
      sourceIndexPath: indexArg,
      targetTileSizeMeters: targetSize,
      outputDir: outDir,
      policy: {
        foliageBatchMode,
        sleeperBatchMode,
        includeBvh,
      },
      shardCols: shardColsRaw ? Number(shardColsRaw) : undefined,
      shardRows: shardRowsRaw ? Number(shardRowsRaw) : undefined,
      maxOpenSourceShards: maxOpenShardsRaw ? Number(maxOpenShardsRaw) : 8,
      verifyOutput,
      allowCustomSnapshot,
      onProgress: ({ completedParentTiles, totalParentTiles, rssMiB }) => {
        const pct = Math.floor((completedParentTiles / Math.max(1, totalParentTiles)) * 100);
        if (pct >= lastLoggedPct + 10 || completedParentTiles === totalParentTiles) {
          lastLoggedPct = pct;
          console.log(
            `[consolidate:${targetSize}m] ${completedParentTiles}/${totalParentTiles} parent tiles (${pct}%) | RSS ${rssMiB.toFixed(1)} MiB`
          );
        }
      },
    });

    reports.push(report);

    const a = report.geometryAudit;
    const s = report.storage;
    console.log(
      [
        `[consolidate:${targetSize}m] DONE in ${(report.performance.elapsedMs / 1000).toFixed(2)}s (peak RSS ${report.performance.peakRssMiB.toFixed(1)} MiB)`,
        `  Grid: ${report.grid.parentCols}×${report.grid.parentRows} (${report.grid.parentTotalTiles} tiles, ${report.grid.parentNonEmptyTiles} non-empty, ${report.grid.parentPartialCoverageTiles} partial-edge) across ${report.grid.parentShardCount} shards`,
        `  Static meshes: ${a.sourceStaticMeshes} -> ${a.parentStaticMeshes} (-${a.staticMeshReductionPct}%)`,
        `  Multi-material groups: ${a.multiMaterialGroupsBefore} -> ${a.multiMaterialGroupsAfter}`,
        `  Total draw calls (resident): ${a.sourceTotalDrawCalls} -> ${a.parentTotalDrawCalls} (-${a.totalDrawCallReductionPct}%)`,
        `  Non-ground triangles delta: ${a.nonGroundTriangleDelta} | Instances delta: ${a.instanceCountDelta}`,
        `  Legacy stored header vs buffer-derived triangle discrepancy: ${a.legacyStoredHeaderDiscrepancyTriangles}`,
        `  Compressed storage: ${(s.sourceCompressedBytes / (1024 * 1024)).toFixed(2)} MiB -> ${(s.parentCompressedBytes / (1024 * 1024)).toFixed(2)} MiB (${s.compressedSizeDeltaPct >= 0 ? '+' : ''}${s.compressedSizeDeltaPct}%)`,
        `  Verified: ${report.verification.performed ? (report.verification.passed ? `OK (${report.verification.verifiedShards} shards)` : 'FAILED') : 'skipped'}`,
        `  Index: ${report.outputIndexPath}`,
      ].join('\n')
    );
  }
}

main();
