import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  resolveOverijsselIndexPath,
} from '../src/server/osm/overijsselConfig';
import { OverijsselOsmStore } from '../src/server/osm/OverijsselOsmStore';
import { TilePackSqliteStore } from '../src/server/tiles/TilePackSqliteStore';
import {
  CANONICAL_HENGELO_SNAPSHOT_ID, type DecodedTilePayload,
} from '../src/world/tiling/TilePackContract';
import { utmBoundsToGeoBounds } from '../src/world/tiling/TileGrid';
import { geoToUtm32N } from '../src/world/tiling/RegionalProjection';
import {
  probeSourceSurfaceAtUtm, probeAnyRoadSurfaceAtUtm,
} from '../src/world/tiling/RegionalSeamAudit';
import { pointToTriangleDistance } from './diagnose-missing-roads';
import { visibleRoadOnlyTile } from './bake-and-verify-missing-road';
import {
  closestPolylineSegment,
  inspectPolylineAtHorizontalSeam,
  tangentAlignedRoadSeamProbes,
} from './inspect-cycleway-seam';

const CYCLEWAY_ID = 'way/38892898';
const RESIDENTIAL_ID = 'way/546666718';
const ORIGINAL = { easting: 352329.339, northing: 5794816 };
type EN = readonly [number, number];

export interface RoadSurfaceOwner {
  mesh: string;
  id: string | null;
  sourceFeatureId: string | null;
  sourceFeatureIds: string[];
  primaryTag: string | null;
  subtype: string | null;
  name: string | null;
  layer: number | null;
}

/** Actual visible triangle ownership at a point, not merely any road nearby. */
export function roadOwnersAtUtm(
  tile: DecodedTilePayload,
  easting: number,
  northing: number,
  pointToleranceMeters = 0.001
): RoadSurfaceOwner[] {
  const localX = easting - (tile.tx + 0.5) * tile.tileSizeMeters;
  const localZ = (tile.ty + 0.5) * tile.tileSizeMeters - northing;
  const p = { x: localX, z: localZ };
  const owners = new Map<string, RoadSurfaceOwner>();
  for (const mesh of tile.meshes) {
    if (mesh.layer !== 'roads') continue;
    const pos = mesh.positions, idx = mesh.indices;
    const totalFaces = Math.floor((idx?.length ?? pos.length / 3) / 3);
    for (let face = 0; face < totalFaces; face++) {
      const v = [0, 1, 2].map(j => {
        const offset = (idx ? idx[face * 3 + j] : face * 3 + j) * 3;
        return { x: pos[offset] + mesh.localPositionOffset[0],
          z: pos[offset + 2] + mesh.localPositionOffset[2] };
      });
      if (v.some(vertex => !Number.isFinite(vertex.x) || !Number.isFinite(vertex.z))) continue;
      if (p.x < Math.min(...v.map(q => q.x)) - pointToleranceMeters ||
          p.x > Math.max(...v.map(q => q.x)) + pointToleranceMeters ||
          p.z < Math.min(...v.map(q => q.z)) - pointToleranceMeters ||
          p.z > Math.max(...v.map(q => q.z)) + pointToleranceMeters) continue;
      if (pointToTriangleDistance(p, v[0], v[1], v[2]) > pointToleranceMeters) continue;
      const refs = mesh.singleFeatureIdx >= 0 ? [mesh.singleFeatureIdx]
        : mesh.faceRanges
          .filter(range => face >= range.startFace && face < range.endFace)
          .map(range => range.infoIdx);
      for (const ref of refs.length ? refs : [-1]) {
        const info = tile.featureInfos[ref];
        const owner: RoadSurfaceOwner = {
          mesh: mesh.name, id: info?.id ?? null,
          sourceFeatureId: info?.sourceFeatureId ?? null,
          sourceFeatureIds: info?.sourceFeatureIds ?? [],
          primaryTag: info?.primaryTag ?? null,
          subtype: info?.subtype ?? null,
          name: info?.name ?? null, layer: info?.layer ?? null,
        };
        const key = owner.mesh + ':' + (owner.id ?? '<none>');
        owners.set(key, owner);
      }
    }
  }
  return [...owners.values()];
}

export function parseCyclewayOwnershipArgs(argv: readonly string[] = process.argv.slice(2),
  root = process.cwd()) {
  let reportId = 'v1';
  for (const arg of argv) {
    if (arg.startsWith('--report-id=')) reportId = arg.slice('--report-id='.length);
    else throw Error('Unknown option: ' + arg);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(reportId)) throw Error('Invalid --report-id');
  const outRoot = path.resolve(root, 'benchmarks/results/tkt033-remaining/first-pass');
  return {
    packPath: path.resolve(outRoot, 'west-north-pair-2x2.sqlite'),
    jsonPath: path.resolve(outRoot, 'way-38892898-ownership-' + reportId + '.json'),
    indexPath: resolveOverijsselIndexPath(root),
  };
}

/** Compare two real OSM ways and the actual owners on the already-baked road surface. */
export function inspectCyclewaySurfaceOwnership(
  opts: ReturnType<typeof parseCyclewayOwnershipArgs>
) {
  if (!fs.existsSync(opts.packPath)) throw Error('Missing original west-north pair pack; no rebake is performed');
  if (fs.existsSync(opts.jsonPath)) throw Error('Report exists; provide --report-id=another-id');
  const osm = new OverijsselOsmStore(opts.indexPath, { expectedSha256: OVERIJSSEL_PBF_EXPECTED_SHA256 });
  const pack = new TilePackSqliteStore(opts.packPath, {
    expectedSourceSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
    expectedSnapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
  });
  try {
    const [e, n] = [ORIGINAL.easting, ORIGINAL.northing];
    const bbox = utmBoundsToGeoBounds({
      minEasting: e - 100, maxEasting: e + 100,
      minNorthing: n - 100, maxNorthing: n + 100,
    });
    const query = osm.queryBBox({ ...bbox, locationName: 'tkt033-cycleway-ownership' });
    const tiles = new Map<string, DecodedTilePayload>();
    const sample = (label: string, easting: number, northing: number) => {
      const tx = Math.floor(easting / 1024), ty = Math.floor(northing / 1024);
      const key = tx + ':' + ty;
      let tile = tiles.get(key);
      if (!tile) {
        const raw = pack.getTileDecoded(0, tx, ty);
        if (!raw) throw Error('Pack is missing tile ' + key);
        tile = visibleRoadOnlyTile(raw);
        tiles.set(key, tile);
      }
      const ce = (tx + 0.5) * 1024, cn = (ty + 0.5) * 1024;
      return {
        label, easting, northing, tx, ty,
        cycleway: probeSourceSurfaceAtUtm(tile, ce, cn, CYCLEWAY_ID, easting, northing),
        residential: probeSourceSurfaceAtUtm(tile, ce, cn, RESIDENTIAL_ID, easting, northing),
        anyRoad: probeAnyRoadSurfaceAtUtm(tile, ce, cn, easting, northing),
        owners: roadOwnersAtUtm(tile, easting, northing),
      };
    };
    const sourceWays = [CYCLEWAY_ID, RESIDENTIAL_ID].map(sourceId => {
      const features = (query.geojson.features ?? []).filter((f: any) =>
        String(f.id ?? f.properties?.['@id'] ?? f.properties?.id ?? '') === sourceId);
      const lines: EN[][] = features.flatMap((f: any) => {
        const g = f.geometry;
        const parts = g?.type === 'LineString' ? [g.coordinates]
          : g?.type === 'MultiLineString' ? g.coordinates : [];
        return parts.map((coords: number[][]) =>
          coords.map(v => geoToUtm32N(v[0], v[1]) as EN));
      });
      const nearest = lines.map(line => closestPolylineSegment(line, e, n))
        .filter((v): v is NonNullable<typeof v> => v != null)
        .sort((a, b) => a.distanceMeters - b.distanceMeters)[0] ?? null;
      const contacts = lines.flatMap(line => inspectPolylineAtHorizontalSeam(line, n, e))
        .sort((a, b) => a.distanceToAuditPointMeters - b.distanceToAuditPointMeters);
      const cross = contacts.find(c => c.disposition === 'proper-crossing' && c.distanceToAuditPointMeters < 12);
      const nearestLine = lines.find(line => cross &&
        line[cross.segment] && line[cross.segment + 1] &&
        Math.abs(line[cross.segment][1] - n) <= 100 &&
        Math.abs(line[cross.segment + 1][1] - n) <= 100);
      const tangent = cross && nearestLine ?
        tangentAlignedRoadSeamProbes(
          nearestLine[cross.segment], nearestLine[cross.segment + 1], 'northing', n) : null;
      const samples = tangent ? [
        sample(sourceId + '-tangent-north', tangent.positiveSide[0], tangent.positiveSide[1]),
        sample(sourceId + '-tangent-south', tangent.negativeSide[0], tangent.negativeSide[1]),
      ] : [];
      return {
        sourceId, featureCount: features.length,
        tags: features.map((f: any) => f.properties?.tags ?? f.properties),
        nearestSegment: nearest, seamContacts: contacts.slice(0, 8),
        tangentSamples: samples, tangentAvailable: !!tangent,
      };
    });
    const result = {
      ticket: 'TKT-033',
      purpose: 'Read-only original cycleway vs residential priority ownership in decoded source-backed tiles',
      snapshotId: query.snapshotMetadata.snapshotId,
      sourceSha256: query.snapshotMetadata.sourceSha256,
      crossingUTM: ORIGINAL,
      originalAxisSamples: [
        sample('north-original-25cm', e, n + 0.25),
        sample('south-original-25cm', e, n - 0.25),
      ],
      sourceWays,
      limitations: [
        'Owning physical road triangles are recorded, but semantic visual distinction of the cycleway may require owner review.',
        'Source geometry sampled along its true centerline; a distinct offset/buffered cycleway could be rendered elsewhere.',
        'Uses existing disposable 2x2 pack; no bake, pack mutation, or LLM visual inspection.',
      ],
    };
    fs.writeFileSync(opts.jsonPath, JSON.stringify(result, null, 2) + '\n');
    console.log('[tkt033:ownership] original sampled road owners:');
    for (const s of result.originalAxisSamples) {
      console.log(' ',s.label, s.owners.map(x=>x.sourceFeatureId+':'+x.mesh).join(', ') || 'none');
    }
    for (const s of sourceWays) {
      console.log('[tkt033:ownership] ' + s.sourceId + ': OSM features=' + s.featureCount +
        ', nearest source point=' + (s.nearestSegment?.distanceMeters ?? 'none') + 'm');
      for(const sample of s.tangentSamples) {
        console.log(' ',sample.label, 'cycleway='+sample.cycleway.status,
          'residential='+sample.residential.status,
          'owners='+sample.owners.map(x=>x.sourceFeatureId+':'+x.mesh).join(','));
      }
    }
    console.log('[tkt033:ownership] report: ' + opts.jsonPath);
    console.log('[tkt033:ownership] canonical regional packs unchanged');
    return result;
  } finally {
    pack.close();
    osm.close();
  }
}
const entrypoint = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (entrypoint) {
  try {
    inspectCyclewaySurfaceOwnership(parseCyclewayOwnershipArgs());
  } catch (error) {
    console.error('[tkt033:ownership] ' + (error instanceof Error ? error.stack : String(error)));
    process.exitCode = 1;
  }
}
