import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  resolveOverijsselIndexPath,
} from '../src/server/osm/overijsselConfig';
import { resolveDefaultTilePackPath } from '../src/server/tiles/TilePackSqliteStore';
import { verifyHengeloTilePackFromStore } from '../src/server/tiles/TilePackVerifier';

interface VerifyCliArgs {
  indexPath?: string;
  packPath?: string;
  jsonOutPath?: string;
  checkDeterminism: boolean;
}

function parseArgs(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): VerifyCliArgs {
  const args: VerifyCliArgs = {
    indexPath: env.OVERIJSSEL_INDEX_PATH?.trim() || env.npm_config_index?.trim() || undefined,
    packPath: env.OVERIJSSEL_TILE_PACK_PATH?.trim() || env.npm_config_pack?.trim() || undefined,
    jsonOutPath: env.npm_config_json_out?.trim() || undefined,
    checkDeterminism:
      argv.includes('--check-determinism') || env.npm_config_check_determinism === 'true',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--index=')) {
      args.indexPath = arg.slice('--index='.length);
    } else if (arg === '--index' && argv[i + 1]) {
      args.indexPath = argv[++i];
    } else if (arg.startsWith('--pack=')) {
      args.packPath = arg.slice('--pack='.length);
    } else if (arg === '--pack' && argv[i + 1]) {
      args.packPath = argv[++i];
    } else if (arg.startsWith('--json-out=')) {
      args.jsonOutPath = arg.slice('--json-out='.length);
    } else if (arg === '--json-out' && argv[i + 1]) {
      args.jsonOutPath = argv[++i];
    }
  }
  return args;
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  try {
    const cli = parseArgs();
    const indexPath = cli.indexPath ?? resolveOverijsselIndexPath();
    const packPath = cli.packPath ?? resolveDefaultTilePackPath();

    const report = verifyHengeloTilePackFromStore({
      indexPath,
      packPath,
      expectedSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
      checkDeterminism: cli.checkDeterminism,
      jsonOutPath: cli.jsonOutPath,
    });

    const fmtMB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    const fmtMem = (v: number | null) => (v !== null ? `${v} MB` : 'unavailable');
    const themeSummary = report.themeSwapChecks
      .map((t) => `${t.themeId}:${t.passed ? 'OK' : 'FAIL'}`)
      .join(', ');

    const lines = [
      `=== TKT-028 M1b Offline Tile Pack Verification ===`,
      `Pack    : ${report.packPath} (${fmtMB(report.dbSizeBytes)})`,
      `Meta    : snapshot=${report.metadata.snapshotId}, schema=${report.metadata.bakeSchemaVersion}, proj=${report.metadata.projectionId}, status=${report.metadata.bakeStatus}`,
      `Decode  : ${report.decodeStats.tilesDecoded} tiles | raw=${fmtMB(report.decodeStats.totalRawBytes)}, compressed=${fmtMB(report.decodeStats.totalCompressedBytes)} | decode=${report.timingsMs.decodeAllTilesMs}ms (${report.decodeStats.avgDecodeMsPerTile}ms/tile) | recon=${report.timingsMs.reconstructAllTilesMs}ms (${report.decodeStats.avgReconstructMsPerTile}ms/tile)`,
      `Seam OK : ${report.seamReport.isValid} (defects=${report.seamReport.defects.length}, seams=${report.seamReport.internalSeamsChecked}, bldgs=${report.seamReport.buildingParity.tiledUniqueCount}/${report.seamReport.buildingParity.refCount}, sleepers=${report.seamReport.railwayParity.tiledSleeperCount}/${report.seamReport.railwayParity.refSleeperCount})`,
      `Themes  : ${themeSummary} (sharedMaterials=${report.attributeAndInstanceChecks.sharedMaterialCount})`,
      `BVH/Attr: raySamples=${report.bvhInspectionCheck.samplesPassed}/${report.bvhInspectionCheck.samplesAttempted}, railAttrs=${report.attributeAndInstanceChecks.railwayUvAndSwitchAttrPresent}, sleepersInstanced=${report.attributeAndInstanceChecks.sleeperInstancedParity}`,
      `Determ. : checked=${report.determinismCheck.checked}, passed=${report.determinismCheck.passed}`,
      `Memory  : peakHeap=${fmtMem(report.memoryMB.peakDuringVerify.heapUsedMB)}, peakRSS=${fmtMem(report.memoryMB.peakDuringVerify.rssMB)}`,
      `Valid   : ${report.isValid} (failures=${report.failures.length})`,
    ];
    if (report.failures.length > 0) {
      lines.push(`Failures (first 20):`);
      for (const f of report.failures.slice(0, 20)) {
        lines.push(`  - ${f}`);
      }
      process.exitCode = 1;
    }
    console.log(lines.join('\n'));
  } catch (err: unknown) {
    console.error(`Hengelo M1b verification failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
