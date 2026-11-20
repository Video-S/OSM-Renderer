import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAP_THEMES } from '../src/styles/mapThemes';
import { OverijsselOsmStore, type OverijsselSnapshotMetadata } from '../src/server/osm/OverijsselOsmStore';
import {
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  OVERIJSSEL_SNAPSHOT_ID,
  resolveOverijsselIndexPath,
} from '../src/server/osm/overijsselConfig';
import {
  DEFAULT_COLLAR_METERS,
  DEFAULT_TILE_SIZE_METERS,
  createHengeloStudyGrid,
  type StudyGridSpec,
} from '../src/world/tiling/TileGrid';
import {
  buildSingleSceneReference,
  buildTiledStudyScenes,
  ingestCanonicalStudyGeoJson,
  type ProcessMemorySnapshot,
} from '../src/world/tiling/TiledStudyPipeline';
import {
  validateTiledSeamContinuity,
  type SeamValidationReport,
} from '../src/world/tiling/SeamValidator';
import {
  runDiagnosticAbcComparison,
  type DiagnosticAbcReport,
} from '../src/world/tiling/TiledDiagnostics';

export interface HengeloM1aVerificationOutput {
  generatedAtIso: string;
  indexPath: string;
  snapshotMetadata: OverijsselSnapshotMetadata;
  grid: {
    name: string;
    crs: string;
    tileSizeMeters: number;
    collarMeters: number;
    cols: number;
    rows: number;
    studyWidthMeters: number;
    studyDepthMeters: number;
    studyUtmBounds: StudyGridSpec['studyUtmBounds'];
    studyGeoBounds: StudyGridSpec['studyGeoBounds'];
    studyExpandedGeoBounds: StudyGridSpec['studyExpandedGeoBounds'];
  };
  sqliteQuery: {
    timings: {
      spatialQueryMs: number;
      osmtogeojsonMs: number;
      nodeIdEnrichMs: number;
    };
    counts: {
      nodes: number;
      ways: number;
      relations: number;
      features: number;
    };
  };
  timingsMs: {
    ingestMs: number;
    referenceBuildMs: number;
    tiledBuildTotalMs: number;
    tiledBuildMaxTileMs: number;
    tiledBuildAvgTileMs: number;
    seamValidationMs: number;
  };
  memoryMB: {
    afterIngest: ProcessMemorySnapshot;
    afterReferenceBuild: ProcessMemorySnapshot;
    peakDuringTiledBuild: ProcessMemorySnapshot;
    afterAllTiles: ProcessMemorySnapshot;
  };
  report: SeamValidationReport;
  diagnosticAbc?: DiagnosticAbcReport;
}

export interface HengeloM1aVerificationOptions {
  indexPath?: string;
  expectedSha256?: string;
  tileSizeMeters?: number;
  collarMeters?: number;
  jsonOutPath?: string;
  maxCaseSamples?: number;
  diagnoseAbc?: boolean;
}

export function runHengeloM1aVerification(
  options?: HengeloM1aVerificationOptions
): HengeloM1aVerificationOutput {
  const indexPath = options?.indexPath ?? resolveOverijsselIndexPath();
  const expectedSha256 = options?.expectedSha256 ?? OVERIJSSEL_PBF_EXPECTED_SHA256;
  const tileSizeMeters = options?.tileSizeMeters ?? DEFAULT_TILE_SIZE_METERS;
  const collarMeters = options?.collarMeters ?? DEFAULT_COLLAR_METERS;

  const grid = createHengeloStudyGrid(tileSizeMeters, collarMeters);
  const store = new OverijsselOsmStore(indexPath, { expectedSha256 });

  let reference: ReturnType<typeof buildSingleSceneReference> | null = null;
  let tiled: ReturnType<typeof buildTiledStudyScenes> | null = null;

  try {
    const queryRes = store.queryBBox({
      ...grid.studyExpandedGeoBounds,
      locationName: grid.name,
    });
    const snapshotMetadata = queryRes.snapshotMetadata;

    const ingested = ingestCanonicalStudyGeoJson(queryRes.geojson, grid);
    reference = buildSingleSceneReference(ingested, MAP_THEMES.daylight);
    tiled = buildTiledStudyScenes(ingested, MAP_THEMES.daylight);

    const tVal0 = performance.now();
    const report = validateTiledSeamContinuity({ reference, tiled });
    const seamValidationMs = Number((performance.now() - tVal0).toFixed(2));
    const diagnosticAbc = options?.diagnoseAbc
      ? runDiagnosticAbcComparison({ ingested, reference, tiled })
      : undefined;

    const output: HengeloM1aVerificationOutput = {
      generatedAtIso: new Date().toISOString(),
      indexPath,
      snapshotMetadata,
      grid: {
        name: grid.name,
        crs: grid.crs,
        tileSizeMeters: grid.tileSizeMeters,
        collarMeters: grid.collarMeters,
        cols: grid.cols,
        rows: grid.rows,
        studyWidthMeters: grid.studyLocalBounds.maxX - grid.studyLocalBounds.minX,
        studyDepthMeters: grid.studyLocalBounds.maxZ - grid.studyLocalBounds.minZ,
        studyUtmBounds: grid.studyUtmBounds,
        studyGeoBounds: grid.studyGeoBounds,
        studyExpandedGeoBounds: grid.studyExpandedGeoBounds,
      },
      sqliteQuery: {
        timings: queryRes.timings,
        counts: queryRes.counts,
      },
      timingsMs: {
        ingestMs: ingested.ingestTimeMs,
        referenceBuildMs: reference.buildTimeMs,
        tiledBuildTotalMs: tiled.totalBuildTimeMs,
        tiledBuildMaxTileMs: tiled.maxTileBuildTimeMs,
        tiledBuildAvgTileMs: tiled.avgTileBuildTimeMs,
        seamValidationMs,
      },
      memoryMB: {
        afterIngest: ingested.memoryAfterIngest,
        afterReferenceBuild: reference.memoryAfterBuild,
        peakDuringTiledBuild: tiled.peakMemory,
        afterAllTiles: tiled.memoryAfterAllTiles,
      },
      report,
      ...(diagnosticAbc ? { diagnosticAbc } : {}),
    };

    if (options?.jsonOutPath) {
      const maxCases = options.maxCaseSamples ?? 50;
      const serializableOutput: HengeloM1aVerificationOutput = {
        ...output,
        report: {
          ...output.report,
          collarAudit: {
            ...output.report.collarAudit,
            cases: output.report.collarAudit.cases.slice(0, maxCases),
          },
        },
        ...(output.diagnosticAbc
          ? {
              diagnosticAbc: {
                ...output.diagnosticAbc,
                aVsB: {
                  ...output.diagnosticAbc.aVsB,
                  collarAudit: {
                    ...output.diagnosticAbc.aVsB.collarAudit,
                    cases: [],
                  },
                },
              },
            }
          : {}),
      };
      const outPath = path.resolve(options.jsonOutPath);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(serializableOutput, null, 2), 'utf8');
    }

    return output;
  } finally {
    tiled?.dispose();
    reference?.dispose();
    store.close();
  }
}

function parseCliArgs(argv: readonly string[]): HengeloM1aVerificationOptions {
  const opts: HengeloM1aVerificationOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--index=')) {
      opts.indexPath = arg.slice('--index='.length);
    } else if (arg === '--index' && argv[i + 1]) {
      opts.indexPath = argv[++i];
    } else if (arg.startsWith('--json-out=')) {
      opts.jsonOutPath = arg.slice('--json-out='.length);
    } else if (arg === '--json-out' && argv[i + 1]) {
      opts.jsonOutPath = argv[++i];
    } else if (arg.startsWith('--collar=')) {
      opts.collarMeters = Number(arg.slice('--collar='.length));
    } else if (arg.startsWith('--tile-size=')) {
      opts.tileSizeMeters = Number(arg.slice('--tile-size='.length));
    } else if (arg === '--diagnose-abc') {
      opts.diagnoseAbc = true;
    }
  }
  return opts;
}

function formatSummary(res: HengeloM1aVerificationOutput): string {
  const { report } = res;
  const lines: string[] = [
    `=== TKT-028 M1a Hengelo 8x8 Canonical Verification ===`,
    `Snapshot: ${res.snapshotMetadata.snapshotId} (expected ${OVERIJSSEL_SNAPSHOT_ID})`,
    `SHA-256 : ${res.snapshotMetadata.sourceSha256}`,
    `Grid    : ${res.grid.cols}x${res.grid.rows} @ ${res.grid.tileSizeMeters}m (${res.grid.studyWidthMeters}m x ${res.grid.studyDepthMeters}m), CRS=${res.grid.crs}, collar=${res.grid.collarMeters}m`,
    `Query   : ${res.sqliteQuery.counts.features} GeoJSON features (${res.sqliteQuery.timings.spatialQueryMs.toFixed(1)}ms SQL, ${res.sqliteQuery.timings.osmtogeojsonMs.toFixed(1)}ms osmtogeojson, ${res.sqliteQuery.timings.nodeIdEnrichMs.toFixed(1)}ms nodeId)`,
    `Timings : ingest=${res.timingsMs.ingestMs}ms | ref=${res.timingsMs.referenceBuildMs}ms | tiledTotal=${res.timingsMs.tiledBuildTotalMs}ms (avg=${res.timingsMs.tiledBuildAvgTileMs}ms, max=${res.timingsMs.tiledBuildMaxTileMs}ms) | seamCheck=${res.timingsMs.seamValidationMs}ms`,
    `Memory  : refHeap=${res.memoryMB.afterReferenceBuild.heapUsedMB}MB | peakTileHeap=${res.memoryMB.peakDuringTiledBuild.heapUsedMB}MB | peakRss=${res.memoryMB.peakDuringTiledBuild.rssMB}MB`,
    `Tiles   : ${report.tilesProcessed} total (${report.nonEmptyTiles} non-empty, ${report.emptyTiles} empty), ${report.internalSeamsChecked} internal seams`,
    `Seam OK : ${report.isValid} (defects=${report.defects.length}, roadIntegrityFailures=${report.roadIntegrityFailures.length})`,
    `Bldgs   : ref=${report.buildingParity.refCount}, tiledUnique=${report.buildingParity.tiledUniqueCount}, emitted=${report.buildingParity.tiledTotalEmitted}, missing=${report.buildingParity.missingFromTiles.length}, dup=${report.buildingParity.duplicatedAcrossTiles.length}, triMismatch=${report.buildingParity.triangleMismatches.length}`,
    `Rail    : refSleepers=${report.railwayParity.refSleeperCount}, tiledSleepers=${report.railwayParity.tiledSleeperCount}, maxPhaseDisc=${report.railwayParity.maxPhaseDiscontinuityU}, maxRailDy=${report.railwayParity.maxRailElevationDiscontinuityM}m`,
    `Bridge  : maxDeckDy=${report.bridgeContinuity.maxDeckElevationDiscontinuityM}m`,
    `OSM IDs : ref=${report.provenanceParity.refSourceFeatureCount}, tiled=${report.provenanceParity.tiledSourceFeatureCount}, missing=${report.provenanceParity.missingSourceFeatureIds.length}, extra=${report.provenanceParity.extraSourceFeatureIds.length}`,
    `Collar  : proposed=${report.collarAudit.proposedCollarMeters}m sufficientWithoutGlobal=${report.collarAudit.isProposedCollarSufficientWithoutGlobalContext}, tilesWithInsufficiency=${report.collarAudit.tilesWithInsufficiency}/${report.collarAudit.totalTilesAudited}, totalCases=${report.collarAudit.totalInsufficiencyCases} (globalResolved=${report.collarAudit.resolvedByGlobalContextCount}, tileLocalCollar=${report.collarAudit.tileLocalCollarDependentCount}), maxRequiredCollar=${report.collarAudit.maxRequiredCollarMeters}m`,
    `CollarKinds: ${JSON.stringify(report.collarAudit.countsByKind)}`,
    `TreeBudget : ${report.collarAudit.sceneTreeBudgetAudit.note}`,
  ];
  if (res.diagnosticAbc) {
    const abc = res.diagnosticAbc;
    lines.push(
      `Diag ABC: aVsB.isValid=${abc.aVsB.isValid} (defects=${abc.aVsB.defects.length}), bVsC.isExactMatch=${abc.bVsC.isExactMatch} (geomExact=${abc.bVsC.isGeometryExactMatch}, geomDivTiles=${abc.bVsC.tilesWithGeometryDivergence}/${abc.bVsC.tilesCompared}, metaDivTiles=${abc.bVsC.tilesWithMetadataDivergence}/${abc.bVsC.tilesCompared})`
    );
  }
  if (report.defects.length > 0) {
    lines.push(`Defects (first 20):`);
    for (const d of report.defects.slice(0, 20)) {
      lines.push(`  - [${d.category}] ${d.detail}`);
    }
  }
  return lines.join('\n');
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  try {
    const cliOpts = parseCliArgs(process.argv.slice(2));
    const result = runHengeloM1aVerification(cliOpts);
    console.log(formatSummary(result));
    if (!result.report.isValid) {
      process.exitCode = 1;
    }
  } catch (err: any) {
    console.error(`Hengelo M1a verification failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}
