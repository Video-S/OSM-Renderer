import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OverijsselOsmStore } from '../src/server/osm/OverijsselOsmStore';
import {
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  resolveOverijsselIndexPath,
} from '../src/server/osm/overijsselConfig';
import { TilePackSqliteStore } from '../src/server/tiles/TilePackSqliteStore';
import { CANONICAL_HENGELO_SNAPSHOT_ID, type DecodedTilePayload }
  from '../src/world/tiling/TilePackContract';
import { geoToUtm32N } from '../src/world/tiling/RegionalProjection';
import { utmBoundsToGeoBounds } from '../src/world/tiling/TileGrid';
import {
  probeSourceSurfaceAtUtm, probeAnyRoadSurfaceAtUtm,
} from '../src/world/tiling/RegionalSeamAudit';
import { visibleRoadOnlyTile } from './bake-and-verify-missing-road';
import { roadOwnersAtUtm } from './inspect-cycleway-ownership';
import { planPrimaryRoadCorridor, type UTM } from './primary-regional-seam-corridor';

const DEFAULT_WAY_ID = 'way/6666519';
const DEFAULT_WITNESS = { easting: 351822.700, northing: 5790720.000 };
const NORTH_SHARD = 'r01-c01';
const SOUTH_SHARD = 'r02-c01';
const TILE_SIZE = 1024;
const DEFAULT_MOSAIC =
  'data/osm/twente-pilot-1024m-tkt033-candidate/mosaic.json';

/**
 * Analyze only the source road's original horizontal shard crossing, using
 * the existing full 4x4 regional packs. Never bake or change packs.
 */
export function parsePrimaryRegionalSeamArgs(argv: readonly string[] = process.argv.slice(2),
  root = process.cwd()) {
  let indexPath = path.resolve(root, DEFAULT_MOSAIC);
  let reportId = 'v1';
  let sourceId = DEFAULT_WAY_ID;
  let easting = DEFAULT_WITNESS.easting;
  let providedSourceId = false;
  let providedEasting = false;
  for (const arg of argv) {
    if (arg.startsWith('--index=')) {
      indexPath = path.resolve(root, arg.slice('--index='.length));
    } else if (arg.startsWith('--report-id=')) {
      reportId = arg.slice('--report-id='.length);
    } else if (arg.startsWith('--source-id=')) {
      sourceId = arg.slice('--source-id='.length);
      providedSourceId = true;
    } else if (arg.startsWith('--easting=')) {
      easting = Number(arg.slice('--easting='.length));
      providedEasting = true;
    } else {
      throw Error('Unknown option ' + arg +
        '; supported: --index=PATH --report-id=NAME --source-id=way/ID --easting=UTM');
    }
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(reportId)) {
    throw Error('Invalid report id');
  }
  if (providedSourceId !== providedEasting) {
    throw Error('Specify --source-id and --easting together to avoid testing the wrong road');
  }
  if (!/^way\/[1-9][0-9]{0,15}$/.test(sourceId)) {
    throw Error('Invalid source way ID');
  }
  if (!Number.isFinite(easting) || easting < 100000 || easting > 900000) {
    throw Error('Invalid UTM easting');
  }
  const filename = sourceId === DEFAULT_WAY_ID
    ? 'tkt033-primary-candidate-corridor-' + reportId + '.json'
    : 'tkt033-paired-candidate-corridor-' +
      sourceId.replace('/', '-') + '-' + reportId + '.json';
  return {
    indexPath, sourceId,
    witness: { easting, northing: DEFAULT_WITNESS.northing },
    sourceIndexPath: resolveOverijsselIndexPath(root),
    reportPath: path.resolve(root, 'benchmarks/results/' + filename),
  };
}

export function inspectPrimaryRegionalSeam(
  opts: ReturnType<typeof parsePrimaryRegionalSeamArgs>
) {
  if (fs.existsSync(opts.reportPath)) throw Error('Report exists; use another --report-id');
  const WAY_ID = opts.sourceId;
  const WITNESS = opts.witness;
  if (!fs.existsSync(opts.indexPath)) throw Error('Candidate mosaic index missing: ' + opts.indexPath);
  const index = JSON.parse(fs.readFileSync(opts.indexPath, 'utf8')) as {
    schemaVersion: number;
    snapshotId: string;
    sourceSha256: string;
    config: { tileSizeMeters: number; shardDimension: number };
    shards: Array<{ id: string; file: string }>;
  };
  if (index.schemaVersion !== 1 ||
      index.snapshotId !== CANONICAL_HENGELO_SNAPSHOT_ID ||
      index.sourceSha256.toLowerCase() !== OVERIJSSEL_PBF_EXPECTED_SHA256 ||
      index.config.tileSizeMeters !== TILE_SIZE ||
      index.config.shardDimension !== 4) {
    throw Error('Candidate mosaic has unexpected pinned-source or 4x4 configuration');
  }
  const filenameFor = (shardId: string) => {
    const entries = index.shards.filter(s => s.id === shardId);
    if (entries.length !== 1 || entries[0].file !== shardId + '.sqlite') {
      throw Error('Missing or unexpected shard entry: ' + shardId);
    }
    return path.resolve(path.dirname(opts.indexPath), entries[0].file);
  };

  const north = new TilePackSqliteStore(filenameFor(NORTH_SHARD), {
    expectedSnapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
    expectedSourceSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
  });
  let south: TilePackSqliteStore | undefined;
  let osm: OverijsselOsmStore | undefined;
  try {
    south = new TilePackSqliteStore(filenameFor(SOUTH_SHARD), {
      expectedSnapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
      expectedSourceSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
    });
    osm = new OverijsselOsmStore(opts.sourceIndexPath, {
      expectedSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
    });
    const bbox = utmBoundsToGeoBounds({
      minEasting: WITNESS.easting - 100,
      maxEasting: WITNESS.easting + 100,
      minNorthing: WITNESS.northing - 100,
      maxNorthing: WITNESS.northing + 100,
    });
    const query = osm.queryBBox({
      ...bbox, locationName: 'tkt033-primary-region-shard-seam',
    });
    const features = (query.geojson.features ?? []).filter((f: any) =>
      String(f.id ?? f.properties?.['@id'] ?? f.properties?.id ?? '') === WAY_ID);
    const tags = features.map((f: any) => f.properties?.tags ?? f.properties);
    const lines: UTM[][] = [];
    for (const feature of features) {
      const geom: any = feature.geometry;
      const rawLines: unknown[] = geom?.type === 'LineString'
        ? [geom.coordinates] : geom?.type === 'MultiLineString' ? geom.coordinates : [];
      for (const raw of rawLines) {
        if (!Array.isArray(raw) || raw.some(p =>
          !Array.isArray(p) || p.length < 2 ||
          !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) continue;
        lines.push(raw.map((p: number[]) => geoToUtm32N(p[0], p[1]) as UTM));
      }
    }
    const plan = planPrimaryRoadCorridor({
      lines, easting: WITNESS.easting, northing: WITNESS.northing,
    });
    const tileCache = new Map<string, DecodedTilePayload>();
    const sample = (p: { signedMeters: number; easting: number; northing: number }) => {
      const shardId = p.northing > WITNESS.northing ? NORTH_SHARD : SOUTH_SHARD;
      const store = shardId === NORTH_SHARD ? north : south!;
      const tx = Math.floor(p.easting / TILE_SIZE);
      const ty = Math.floor(p.northing / TILE_SIZE);
      const key = shardId + ':' + tx + ':' + ty;
      let tile = tileCache.get(key);
      if (!tile) {
        const raw = store.getTileDecoded(0, tx, ty);
        if (!raw) throw Error('Missing candidate shard tile: ' + key);
        tile = visibleRoadOnlyTile(raw);
        tileCache.set(key, tile);
      }
      const centerE = (tx + 0.5) * TILE_SIZE;
      const centerN = (ty + 0.5) * TILE_SIZE;
      const source = probeSourceSurfaceAtUtm(
        tile, centerE, centerN, WAY_ID, p.easting, p.northing);
      const anyRoad = probeAnyRoadSurfaceAtUtm(
        tile, centerE, centerN, p.easting, p.northing);
      return {
        ...p, shardId, tx, ty, source, anyRoad,
        // Resolve actual triangle lineage only for surprising coverage
        // rather than repeatedly scanning all road faces at every point.
        anomalyOwners: source.status !== 'covered' && anyRoad.status === 'covered'
          ? roadOwnersAtUtm(tile, p.easting, p.northing) : [],
      };
    };
    const samples = plan.status === 'ready' ? plan.points.map(sample) : [];
    const sides = [NORTH_SHARD, SOUTH_SHARD].map(shardId => {
      const subset = samples.filter(s => s.shardId === shardId);
      return {
        shardId,
        count: subset.length,
        coveredByTarget: subset.filter(s => s.source.status === 'covered').length,
        coveredByOtherRoadOnly: subset.filter(s =>
          s.source.status !== 'covered' && s.anyRoad.status === 'covered').length,
        uncoveredByAnyRoad: subset.filter(s => s.anyRoad.status !== 'covered').length,
      };
    });
    const issues = samples.filter(s => s.source.status !== 'covered');
    const report = {
      ticket: 'TKT-033',
      purpose: 'Read-only selected OSM road centerline coverage in adjacent original 4x4 candidate shards',
      snapshotId: query.snapshotMetadata.snapshotId,
      sourceSha256: query.snapshotMetadata.sourceSha256,
      mosaicIndex: opts.indexPath,
      sourceWayId: WAY_ID,
      witness: WITNESS,
      shardBoundary: { id: 'horizontal-r1-2-c1',
        northShard: NORTH_SHARD, southShard: SOUTH_SHARD,
        northTileAtWitness: '0:343:5655', southTileAtWitness: '0:343:5654' },
      sourceFeatureCount: features.length,
      tags,
      plan,
      summary: {
        samples: samples.length,
        sides,
        sourceNotCovered: issues.length,
        issues: issues.map(s => ({
          signedMeters: s.signedMeters, easting: s.easting, northing: s.northing,
          shardId: s.shardId, sourceStatus: s.source.status,
          anyRoadStatus: s.anyRoad.status,
        })),
      },
      samples,
      limitations: [
        'Along-line point samples only; not a proof of continuous geometry between samples.',
        'Negative/positive signed offsets mean source OSM vertex-order, not necessarily north/south.',
        'A change in source feature ID along the roadway can be legitimate; off-centerline pavement is not tested.',
        'This inspects baked visible triangle coverage, not actual camera placement, streaming, shadows, or human visual semantics.',
        'No regional or local tile pack was changed and no bake was performed.',
      ],
    };
    fs.mkdirSync(path.dirname(opts.reportPath), { recursive: true });
    fs.writeFileSync(opts.reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log('[tkt033:primary-corridor] ' + plan.status +
      ', source line features=' + features.length + ', sampled=' + samples.length);
    console.log('[tkt033:primary-corridor] north/south summary:', JSON.stringify(sides));
    if (plan.status === 'inconclusive') {
      console.log('[tkt033:primary-corridor] reason: ' + plan.reason);
    } else if (issues.length) {
      console.log('[tkt033:primary-corridor] uncovered source samples: ' + issues.length);
    } else {
      console.log('[tkt033:primary-corridor] all sampled source centerline positions physically covered');
    }
    console.log('[tkt033:primary-corridor] report: ' + opts.reportPath);
    console.log('[tkt033:primary-corridor] unchanged original and candidate mosaics');
    return report;
  } finally {
    osm?.close();
    south?.close();
    north.close();
  }
}

const isEntrypoint = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  try {
    inspectPrimaryRegionalSeam(parsePrimaryRegionalSeamArgs());
  } catch (err) {
    console.error('[tkt033:primary-corridor] ' +
      (err instanceof Error ? err.stack : String(err)));
    process.exitCode = 1;
  }
}
