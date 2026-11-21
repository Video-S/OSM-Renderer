import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bakeHengeloTilesFromStore } from '../src/server/tiles/OfflineHengeloTileBaker';
import { resolveTilePackPathForTileSize } from '../src/server/tiles/TilePackSqliteStore';
import { DEFAULT_TILE_SIZE_METERS } from '../src/world/tiling/TileGrid';
import {
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  resolveOverijsselIndexPath,
} from '../src/server/osm/overijsselConfig';

interface BakeCliArgs {
  indexPath?: string;
  outPath?: string;
  tileSizeMeters: number;
  batchSize?: number;
  includeBvh: boolean;
  jsonOutPath?: string;
}

function parseTileSizeArg(raw: string | undefined): number {
  if (!raw) return DEFAULT_TILE_SIZE_METERS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --tile-size "${raw}". Expected positive integer meters (e.g. 512 or 1024).`);
  }
  return parsed;
}

function parseArgs(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): BakeCliArgs {
  const envTileSize =
    env.OVERIJSSEL_TILE_SIZE_METERS?.trim() || env.npm_config_tile_size?.trim();
  const args: BakeCliArgs = {
    indexPath: env.OVERIJSSEL_INDEX_PATH?.trim() || env.npm_config_index?.trim() || undefined,
    outPath: env.npm_config_out?.trim() || undefined,
    tileSizeMeters: parseTileSizeArg(envTileSize),
    includeBvh: !(env.npm_config_no_bvh === 'true' || argv.includes('--no-bvh')),
    jsonOutPath: env.npm_config_json_out?.trim() || undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--index=')) {
      args.indexPath = arg.slice('--index='.length);
    } else if (arg === '--index' && argv[i + 1]) {
      args.indexPath = argv[++i];
    } else if (arg.startsWith('--out=')) {
      args.outPath = arg.slice('--out='.length);
    } else if (arg === '--out' && argv[i + 1]) {
      args.outPath = argv[++i];
    } else if (arg.startsWith('--tile-size=')) {
      args.tileSizeMeters = parseTileSizeArg(arg.slice('--tile-size='.length));
    } else if (arg === '--tile-size' && argv[i + 1]) {
      args.tileSizeMeters = parseTileSizeArg(argv[++i]);
    } else if (arg.startsWith('--batch-size=')) {
      args.batchSize = Number(arg.slice('--batch-size='.length));
    } else if (arg === '--batch-size' && argv[i + 1]) {
      args.batchSize = Number(argv[++i]);
    } else if (arg.startsWith('--json-out=')) {
      args.jsonOutPath = arg.slice('--json-out='.length);
    } else if (arg === '--json-out' && argv[i + 1]) {
      args.jsonOutPath = argv[++i];
    } else if (arg === '--no-bvh') {
      args.includeBvh = false;
    }
  }
  return args;
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  try {
    const cli = parseArgs();
    const indexPath = cli.indexPath ?? resolveOverijsselIndexPath();
    const outPath = cli.outPath ?? resolveTilePackPathForTileSize(cli.tileSizeMeters);

    const { report, sqliteQueryTimings } = bakeHengeloTilesFromStore({
      indexPath,
      expectedSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
      outPath,
      tileSizeMeters: cli.tileSizeMeters,
      ...(cli.batchSize !== undefined ? { batchDimension: cli.batchSize } : {}),
      includeBvh: cli.includeBvh,
    });

    if (cli.jsonOutPath) {
      const resolvedJson = path.resolve(cli.jsonOutPath);
      fs.mkdirSync(path.dirname(resolvedJson), { recursive: true });
      fs.writeFileSync(resolvedJson, JSON.stringify(report, null, 2), 'utf8');
    }

    const fmtMem = (v: number | null) => (v !== null ? `${v} MB` : 'unavailable');
    console.log(
      [
        `=== TKT-028 M1b Offline Hengelo Tile Bake ===`,
        `Source  : ${indexPath}`,
        `Output  : ${report.outPath} (${formatMB(report.dbSizeBytes)}, ${report.dbSizeBytes} bytes)`,
        `Snapshot: ${report.snapshotId} (sha256=${report.sourceSha256.slice(0, 12)}..., schema=${report.bakeSchemaVersion})`,
        `Grid    : ${report.grid.cols}x${report.grid.rows} (${report.tileCounts.totalTiles} tiles: ${report.tileCounts.nonEmptyTiles} non-empty, ${report.tileCounts.emptyTiles} empty) @ ${report.grid.tileSizeMeters}m, batch=${report.batchDimension}x${report.batchDimension}, BVH=${report.includeBvh}`,
        `Query   : SQL=${sqliteQueryTimings.spatialQueryMs.toFixed(1)}ms, osmtogeojson=${sqliteQueryTimings.osmtogeojsonMs.toFixed(1)}ms, nodeId=${sqliteQueryTimings.nodeIdEnrichMs.toFixed(1)}ms`,
        `Payload : raw=${formatMB(report.sizeStats.totalRawBytes)}, compressed=${formatMB(report.sizeStats.totalCompressedBytes)} (ratio=${report.sizeStats.compressionRatio}), avgCompressed=${(report.sizeStats.avgCompressedBytesPerTile / 1024).toFixed(1)} KB/tile, maxTile=${report.sizeStats.maxCompressedBytesTile.id} (${(report.sizeStats.maxCompressedBytesTile.bytes / 1024).toFixed(1)} KB)`,
        `Geometry: ${report.tileCounts.totalTriangles.toLocaleString()} tris, ${report.tileCounts.totalVertices.toLocaleString()} verts, ${report.tileCounts.totalFeatures.toLocaleString()} rendered feature refs`,
        `Timings : endToEnd=${report.timingsMs.totalEndToEndMs}ms | query=${report.timingsMs.sqliteQueryMs}ms | ingest=${report.timingsMs.ingestMs}ms | tileBakePhase=${report.timingsMs.tileBakePhaseMs}ms (synth+encode=${report.timingsMs.tileSynthesisAndEncodeMs}ms [avg=${report.timingsMs.avgTileSynthAndEncodeMs}ms/tile], deflate=${report.timingsMs.compressionMs}ms, sqlite=${report.timingsMs.sqliteWriteMs}ms, avgTile=${report.timingsMs.avgTileBakeMs}ms, maxTile=${report.timingsMs.maxTileBakeMs}ms)`,
        `Memory  : afterIngestHeap=${fmtMem(report.memoryMB.afterIngest.heapUsedMB)}, peakHeap=${fmtMem(report.memoryMB.peakDuringBake.heapUsedMB)}, peakRSS=${fmtMem(report.memoryMB.peakDuringBake.rssMB)}`,
      ].join('\n')
    );
  } catch (err: unknown) {
    console.error(`Hengelo M1b tile bake failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
