import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bakeHengeloTilesFromStore } from '../src/server/tiles/OfflineHengeloTileBaker';
import { TilePackSqliteStore } from '../src/server/tiles/TilePackSqliteStore';
import { OVERIJSSEL_PBF_EXPECTED_SHA256 } from '../src/server/osm/overijsselConfig';
import {
  CANONICAL_HENGELO_SNAPSHOT_ID,
  TILE_MESH_FLAG_VISIBLE,
  TILE_MESH_FLAG_HIDDEN_UNDERGROUND,
  type DecodedTilePayload,
} from '../src/world/tiling/TilePackContract';
import { createAlignedStudyGrid } from '../src/world/tiling/TileGrid';
import { utm32NToGeo } from '../src/world/tiling/RegionalProjection';
import { probeAnyRoadSurfaceAtUtm, probeSourceSurfaceAtUtm } from '../src/world/tiling/RegionalSeamAudit';
import { parseMissingRoadArgs, type RoadDiagnosisOptions } from './diagnose-missing-roads';

/**
 * TKT-033: physical, source-attributed decoded tile witnesses of repaired
 * road geometry, beyond the pre-bake in-memory shared road plan.
 *
 * Only writes under benchmarks/results/tkt033-disposable. No production
 * Hengelo/Twente tile pack or mosaic index is opened for writing.
 */
export interface DisposableRoadBakeOptions {
  target: RoadDiagnosisOptions;
  packPath: string;
  jsonPath: string;
}

function isUnderDirectory(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function parseDisposableRoadBakeArgs(
  argv: readonly string[] = process.argv.slice(2),
  root: string = process.cwd()
): DisposableRoadBakeOptions {
  const diagnosticArgs: string[] = [];
  let explicitPack: string | undefined;
  let explicitJson: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith('--pack-out=')) {
      explicitPack = arg.slice('--pack-out='.length);
      if (!explicitPack) throw Error('Empty --pack-out');
    } else if (arg.startsWith('--json-out=')) {
      explicitJson = arg.slice('--json-out='.length);
      if (!explicitJson) throw Error('Empty --json-out');
    } else {
      diagnosticArgs.push(arg);
    }
  }
  const target = parseMissingRoadArgs(diagnosticArgs);
  const name = target.sourceId.replace(/[^a-zA-Z0-9-]/g, '-');
  const baseDir = path.resolve(root, 'benchmarks/results/tkt033-disposable');
  const packPath = path.resolve(root, explicitPack ?? path.join(baseDir, name + '-2x2.sqlite'));
  const jsonPath = path.resolve(root, explicitJson ?? path.join(baseDir, name + '-2x2-report.json'));
  if (!isUnderDirectory(packPath, baseDir) || !isUnderDirectory(jsonPath, baseDir)) {
    throw Error('TKT-033 output paths must remain under benchmarks/results/tkt033-disposable');
  }
  if (!packPath.endsWith('.sqlite') || !jsonPath.endsWith('.json') || packPath === jsonPath) {
    throw Error('Expected distinct .sqlite pack and .json report outputs');
  }
  if (fs.existsSync(packPath) || fs.existsSync(jsonPath)) {
    throw Error('Disposable output already exists; choose new --pack-out/--json-out names. Never overwrite an existing bake.');
  }
  return { target, packPath, jsonPath };
}

/** Report only physically emitted, visibly enabled road triangles. */
export function visibleRoadOnlyTile(tile: DecodedTilePayload): DecodedTilePayload {
  return {
    ...tile,
    meshes: tile.meshes.filter(m =>
      m.layer === 'roads' &&
      (m.flags & TILE_MESH_FLAG_VISIBLE) !== 0 &&
      (m.flags & TILE_MESH_FLAG_HIDDEN_UNDERGROUND) === 0
    ),
  };
}

export interface DisposableRoadSample {
  label: string;
  easting: number;
  northing: number;
  tx: number;
  ty: number;
  source: ReturnType<typeof probeSourceSurfaceAtUtm>;
  anyRoad: ReturnType<typeof probeAnyRoadSurfaceAtUtm>;
}

/**
 * Retains a new throwaway SQLite pack even when coverage fails. That way
 * source evidence can be inspected without another bake or file mutation.
 */
export function verifyDisposableRoadBake(opts: DisposableRoadBakeOptions) {
  const { target, packPath, jsonPath } = opts;
  if (fs.existsSync(packPath) || fs.existsSync(jsonPath)) {
    throw Error('Disposable output exists; refusing to overwrite a previous diagnostic.');
  }
  const [lon, lat] = utm32NToGeo(target.easting, target.northing);
  const tileSizeMeters = 1024;
  const grid = createAlignedStudyGrid({
    name: 'tkt033-disposable-' + target.sourceId.replace('/', '-'),
    centerLonLat: [lon, lat], cols: 2, rows: 2, tileSizeMeters, collarMeters: 64,
  });
  fs.mkdirSync(path.dirname(packPath), { recursive: true });
  const { report, snapshotMetadata } = bakeHengeloTilesFromStore({
    indexPath: target.sourceIndex,
    expectedSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
    grid, outPath: packPath, tileSizeMeters, collarMeters: 64,
    queryContextMarginMeters: target.contextMeters,
    includeBvh: true, batchDimension: 2,
  });
  const pack = new TilePackSqliteStore(packPath, {
    expectedSourceSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
    expectedSnapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
  });
  const points = [
    { label: 'center', easting: target.easting, northing: target.northing },
    { label: 'west-25cm', easting: target.easting - 0.25, northing: target.northing },
    { label: 'east-25cm', easting: target.easting + 0.25, northing: target.northing },
    { label: 'north-25cm', easting: target.easting, northing: target.northing + 0.25 },
    { label: 'south-25cm', easting: target.easting, northing: target.northing - 0.25 },
  ];
  const samples: DisposableRoadSample[] = [];
  try {
    for (const p of points) {
      const tx = Math.floor(p.easting / tileSizeMeters);
      const ty = Math.floor(p.northing / tileSizeMeters);
      const decoded = pack.getTileDecoded(0, tx, ty);
      if (!decoded) throw Error('Disposable pack omitted tile ' + tx + ':' + ty + ' at ' + p.label);
      const tile = visibleRoadOnlyTile(decoded);
      samples.push({
        ...p, tx, ty,
        source: probeSourceSurfaceAtUtm(
          tile, (tx + 0.5) * tileSizeMeters, (ty + 0.5) * tileSizeMeters,
          target.sourceId, p.easting, p.northing,
        ),
        anyRoad: probeAnyRoadSurfaceAtUtm(
          tile, (tx + 0.5) * tileSizeMeters, (ty + 0.5) * tileSizeMeters,
          p.easting, p.northing,
        ),
      });
    }
  } finally {
    pack.close();
  }
  const onVerticalEdge = Math.abs(target.easting / tileSizeMeters -
    Math.round(target.easting / tileSizeMeters)) < 1e-8;
  const onHorizontalEdge = Math.abs(target.northing / tileSizeMeters -
    Math.round(target.northing / tileSizeMeters)) < 1e-8;
  // A point on a seam belongs to a single half-open tile even if the road
  // crosses both. Use the two 25cm interior probes for authoritative coverage.
  // The on-seam center is retained as informational evidence only.
  const requiredLabels = [
    ...(!onVerticalEdge && !onHorizontalEdge ? ['center'] : []),
    ...(onVerticalEdge ? ['west-25cm', 'east-25cm'] : []),
    ...(onHorizontalEdge ? ['north-25cm', 'south-25cm'] : []),
  ];
  const required = samples.filter(s => requiredLabels.includes(s.label));
  const passed = required.every(s => s.source.status === 'covered');
  const output = {
    ticket: 'TKT-033',
    schemaVersion: 1,
    purpose: 'Disposable source-attributed road coverage after SQLite bake, codec and decode',
    status: passed ? 'verified-sample-coverage' : 'sample-coverage-failure',
    sourceSha256: snapshotMetadata.sourceSha256,
    snapshotId: snapshotMetadata.snapshotId,
    selected: { sourceId: target.sourceId, easting: target.easting, northing: target.northing },
    sourceContextMeters: target.contextMeters,
    outputPack: packPath,
    tileCounts: report.tileCounts,
    grid: grid.studyUtmBounds,
    probes: samples,
    requiredLabels,
    interpretationLimits: [
      'Sample points do not prove full road-edge topology or cross-shard parity.',
      'The diagnostic 2x2 query context differs from the original 4x4 regional shard.',
      'The original 256-tile Twente mosaic remains unchanged.',
      'Only owner visual inspection of the viewer can approve visible road quality.',
    ],
  };
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2) + '\n');
  console.log('[tkt033:bake] wrote disposable pack ' + packPath + ' (' + report.tileCounts.totalTiles + ' tiles)');
  for (const sample of samples) {
    console.log('[tkt033:bake] ' + sample.label + ' tile ' + sample.tx + ':' + sample.ty +
      ' source=' + sample.source.status + ' any-road=' + sample.anyRoad.status);
  }
  console.log('[tkt033:bake] result: ' + output.status);
  console.log('[tkt033:bake] report: ' + jsonPath);
  console.log('[tkt033:bake] canonical 256-tile mosaic untouched');
  if (!passed) process.exitCode = 1;
  return output;
}

const isEntrypoint = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  try {
    verifyDisposableRoadBake(parseDisposableRoadBakeArgs());
  } catch (err) {
    console.error('[tkt033:bake] ' + (err instanceof Error ? err.stack : String(err)));
    process.exitCode = 1;
  }
}
