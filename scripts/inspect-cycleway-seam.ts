import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OverijsselOsmStore } from '../src/server/osm/OverijsselOsmStore';
import {
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  resolveOverijsselIndexPath,
} from '../src/server/osm/overijsselConfig';
import { TilePackSqliteStore } from '../src/server/tiles/TilePackSqliteStore';
import {
  CANONICAL_HENGELO_SNAPSHOT_ID,
  type DecodedTilePayload,
} from '../src/world/tiling/TilePackContract';
import { utmBoundsToGeoBounds } from '../src/world/tiling/TileGrid';
import { geoToUtm32N } from '../src/world/tiling/RegionalProjection';
import {
  probeSourceSurfaceAtUtm,
  probeAnyRoadSurfaceAtUtm,
} from '../src/world/tiling/RegionalSeamAudit';
import { pointToTriangleDistance } from './diagnose-missing-roads';
import { visibleRoadOnlyTile } from './bake-and-verify-missing-road';

const SOURCE_ID = 'way/14119316';
const POINT = { easting: 352312.35, northing: 5786624 };
const OFFSETS = [-4, -2, -1, -0.5, -0.25, -0.1, -0.05, -0.01,
  0, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 4] as const;

type EN = readonly [number, number];

interface ClosestSegment {
  segment: number;
  t: number;
  distanceMeters: number;
  lengthMeters: number;
  start: EN;
  end: EN;
  closest: EN;
}

/** Closest source centerline segment; also tells if the original way ends here. */
export function closestPolylineSegment(
  polyline: readonly EN[],
  easting: number,
  northing: number
): ClosestSegment | null {
  let result: ClosestSegment | null = null;
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1], b = polyline[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], squared = dx * dx + dy * dy;
    if (squared <= 1e-10) continue;
    const t = Math.max(0, Math.min(1,
      ((easting - a[0]) * dx + (northing - a[1]) * dy) / squared));
    const closest: EN = [a[0] + t * dx, a[1] + t * dy];
    const dist = Math.hypot(easting - closest[0], northing - closest[1]);
    if (!result || dist < result.distanceMeters) {
      result = {
        segment: i - 1, t, lengthMeters: Math.sqrt(squared), start: a,
        end: b, closest, distanceMeters: dist,
      };
    }
  }
  return result;
}

export interface SourceSeamContact {
  segment: number;
  easting: number;
  northing: number;
  distanceToAuditPointMeters: number;
  disposition: 'proper-crossing' | 'endpoint-touch' | 'on-seam-segment';
  angleToSeamDegrees: number;
}

/** Distinguishes a real source-line crossing from an endpoint or tangent. */
export function inspectPolylineAtHorizontalSeam(
  polyline: readonly EN[],
  seamNorthing: number,
  probeEasting: number
): SourceSeamContact[] {
  const contacts: SourceSeamContact[] = [];
  for (let i = 1; i < polyline.length; i++) {
    const [ae, an] = polyline[i - 1], [be, bn] = polyline[i];
    const dn = bn - an, de = be - ae;
    if (Math.abs(dn) < 1e-8) {
      if (Math.abs(an - seamNorthing) < 1e-7) {
        const easting = Math.max(Math.min(ae, be), Math.min(probeEasting, Math.max(ae, be)));
        contacts.push({
          segment: i - 1, easting, northing: seamNorthing,
          distanceToAuditPointMeters: Math.abs(easting - probeEasting),
          disposition: 'on-seam-segment', angleToSeamDegrees: 0,
        });
      }
      continue;
    }
    const t = (seamNorthing - an) / dn;
    if (t < -1e-8 || t > 1 + 1e-8) continue;
    const easting = ae + t * de;
    contacts.push({
      segment: i - 1, easting, northing: seamNorthing,
      distanceToAuditPointMeters: Math.abs(easting - probeEasting),
      disposition: t < 1e-7 || t > 1 - 1e-7 ? 'endpoint-touch' : 'proper-crossing',
      angleToSeamDegrees: Number((Math.atan2(Math.abs(dn), Math.abs(de)) * 180 / Math.PI).toFixed(4)),
    });
  }
  return contacts.sort((a, b) => a.distanceToAuditPointMeters - b.distanceToAuditPointMeters);
}

function getSourceLines(feature: any): EN[][] {
  const g = feature?.geometry;
  const lines: any[] = g?.type === 'LineString'
    ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
  return lines.map(line => line
    .filter((v: any) => Array.isArray(v) && v.length >= 2)
    .map((v: any) => geoToUtm32N(Number(v[0]), Number(v[1])) as EN));
}

function infoMatches(tile: DecodedTilePayload, idx: number, sourceId: string): boolean {
  const info = tile.featureInfos[idx];
  return !!info && (info.sourceFeatureId === sourceId ||
    info.sourceFeatureIds?.includes(sourceId) === true);
}

function nearestTriangleDistanceInDecodedTile(
  tile: DecodedTilePayload,
  easting: number,
  northing: number,
  sourceId: string | null,
  radiusMeters = 20
) {
  // Positions are mesh-local around the LOD0 tile center, with additional
  // per-mesh offsets; y is intentionally irrelevant to horizontal coverage.
  const localX = easting - (tile.tx + 0.5) * 1024;
  const localZ = (tile.ty + 0.5) * 1024 - northing;
  const pt = { x: localX, z: localZ };
  let minDistance = radiusMeters;
  let closestMesh: string | null = null;
  let matchedFaces = 0;
  for (const mesh of tile.meshes) {
    const positions = mesh.positions;
    const indices = mesh.indices;
    const faceCount = Math.floor((indices?.length ?? positions.length / 3) / 3);
    const direct = sourceId !== null && infoMatches(tile, mesh.singleFeatureIdx, sourceId);
    const ranges = sourceId === null || direct
      ? [{ startFace: 0, endFace: faceCount }]
      : mesh.faceRanges.filter(range => infoMatches(tile, range.infoIdx, sourceId));
    if (ranges.length === 0) continue;
    for (const range of ranges) {
      for (let face = Math.max(0, range.startFace); face < Math.min(faceCount, range.endFace); face++) {
        const indices3 = [0, 1, 2].map(j =>
          (indices ? indices[face * 3 + j] : face * 3 + j) * 3);
        if (indices3.some(i => i + 2 >= positions.length)) continue;
        const vertices = indices3.map(idx => ({
          x: positions[idx] + mesh.localPositionOffset[0],
          z: positions[idx + 2] + mesh.localPositionOffset[2],
        }));
        const minX = Math.min(...vertices.map(v => v.x));
        const maxX = Math.max(...vertices.map(v => v.x));
        const minZ = Math.min(...vertices.map(v => v.z));
        const maxZ = Math.max(...vertices.map(v => v.z));
        if (pt.x < minX - minDistance || pt.x > maxX + minDistance ||
            pt.z < minZ - minDistance || pt.z > maxZ + minDistance) continue;
        matchedFaces++;
        const distance = pointToTriangleDistance(pt, vertices[0], vertices[1], vertices[2]);
        if (distance < minDistance) {
          minDistance = distance;
          closestMesh = mesh.name;
          if (distance === 0) break;
        }
      }
      if (minDistance === 0) break;
    }
    if (minDistance === 0) break;
  }
  return {
    nearestMeters: closestMesh === null ? null : Number(minDistance.toFixed(5)),
    meshName: closestMesh, inspectedNearbyFaces: matchedFaces,
    searchRadiusMeters: radiusMeters,
  };
}

export interface CyclewaySeamDiagnosticOptions {
  packPath: string;
  indexPath: string;
  jsonPath: string;
}
export function parseCyclewaySeamArgs(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd()
): CyclewaySeamDiagnosticOptions {
  let reportId = 'v1';
  for (const arg of argv) {
    if (arg.startsWith('--report-id=')) reportId = arg.slice('--report-id='.length);
    else throw Error('Unknown option: ' + arg);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(reportId)) throw Error('Invalid --report-id');
  const outputRoot = path.resolve(root, 'benchmarks/results/tkt033-remaining/first-pass');
  return {
    packPath: path.resolve(outputRoot, 'west-south-pair-2x2.sqlite'),
    indexPath: resolveOverijsselIndexPath(root),
    jsonPath: path.resolve(outputRoot, 'way-14119316-cross-section-' + reportId + '.json'),
  };
}

export function inspectMissingCyclewaySeam(opts: CyclewaySeamDiagnosticOptions) {
  if (!fs.existsSync(opts.packPath)) throw Error('Missing existing disposable west-south pack; run grouped verification first.');
  if (fs.existsSync(opts.jsonPath)) throw Error('Output report exists; use --report-id=another-id');
  const pack = new TilePackSqliteStore(opts.packPath, {
    expectedSourceSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
    expectedSnapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
  });
  const osm = new OverijsselOsmStore(opts.indexPath, {
    expectedSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
  });
  let output: any;
  try {
    const bbox = utmBoundsToGeoBounds({
      minEasting: POINT.easting - 80, maxEasting: POINT.easting + 80,
      minNorthing: POINT.northing - 80, maxNorthing: POINT.northing + 80,
    });
    const query = osm.queryBBox({ ...bbox, locationName: 'tkt033-cycleway-seam-source' });
    const source = (query.geojson.features ?? []).filter((feature: any) =>
      String(feature.id ?? feature.properties?.['@id'] ?? feature.properties?.id ?? '') === SOURCE_ID);
    const lines = source.flatMap((feature: any) => getSourceLines(feature));
    const contact = lines.flatMap(line =>
      inspectPolylineAtHorizontalSeam(line, POINT.northing, POINT.easting))
      .sort((a, b) => a.distanceToAuditPointMeters - b.distanceToAuditPointMeters);
    const nearestSegments = lines.map(line =>
      closestPolylineSegment(line, POINT.easting, POINT.northing))
      .filter((value): value is ClosestSegment => value !== null)
      .sort((a, b) => a.distanceMeters - b.distanceMeters);
    const cached = new Map<string, DecodedTilePayload>();
    const checkPoint = (label: string, easting: number, northing: number) => {
      const tx = Math.floor(easting / 1024), ty = Math.floor(northing / 1024);
      const key = tx + ':' + ty;
      let tile = cached.get(key);
      if (!tile) {
        const decoded = pack.getTileDecoded(0, tx, ty);
        if (!decoded) throw Error('Original disposable pack is missing tile ' + key);
        tile = visibleRoadOnlyTile(decoded);
        cached.set(key, tile);
      }
      const centerE = (tx + 0.5) * 1024, centerN = (ty + 0.5) * 1024;
      return {
        label, easting, northing, tx, ty,
        source: probeSourceSurfaceAtUtm(tile, centerE, centerN, SOURCE_ID, easting, northing),
        anyRoad: probeAnyRoadSurfaceAtUtm(tile, centerE, centerN, easting, northing),
        nearestSource: nearestTriangleDistanceInDecodedTile(tile, easting, northing, SOURCE_ID),
        nearestAnyRoad: nearestTriangleDistanceInDecodedTile(tile, easting, northing, null),
      };
    };
    const seamCrossSection = OFFSETS.map(offset =>
      checkPoint('northing-offset-' + offset + 'm',
        POINT.easting, POINT.northing + offset));
    const alongSource: ReturnType<typeof checkPoint>[] = [];
    const nearest = nearestSegments[0];
    if (nearest && nearest.distanceMeters < 5) {
      const dx = nearest.end[0] - nearest.start[0], dn = nearest.end[1] - nearest.start[1];
      const eUnit = dx / nearest.lengthMeters, nUnit = dn / nearest.lengthMeters;
      for (const signed of [-2, -1, -0.5, -0.25, 0, 0.25, 0.5, 1, 2]) {
        const t = nearest.t + signed / nearest.lengthMeters;
        if (t < 0 || t > 1) continue;
        alongSource.push(checkPoint('along-source-' + signed + 'm',
          nearest.closest[0] + signed * eUnit,
          nearest.closest[1] + signed * nUnit));
      }
    }
    output = {
      ticket: 'TKT-033',
      purpose: 'Read-only cycleway seam cross-section in previously baked SQLite + canonical source geometry',
      sourceId: SOURCE_ID,
      sourceSnapshotId: query.snapshotMetadata.snapshotId,
      sourceSha256: query.snapshotMetadata.sourceSha256,
      crossingUTM: POINT,
      packPath: opts.packPath,
      geometry: {
        sourceFeatureCount: source.length,
        sourceTags: source.map((feature: any) => feature.properties?.tags ?? feature.properties),
        lineVertexCounts: lines.map(line => line.length),
        closestSegment: nearest ?? null,
        seamContacts: contact.slice(0, 10),
      },
      seamCrossSection,
      alongSource,
      limitations: [
        'A few probe points are not a full-width or end-to-end connectivity proof.',
        'Source OSM touching the seam at an endpoint differs from a road that geometrically crosses it.',
        'No tile rebake, no pack mutation, and no LLM visual testing performed.',
      ],
    };
  } finally {
    osm.close();
    pack.close();
  }
  fs.writeFileSync(opts.jsonPath, JSON.stringify(output, null, 2) + '\n');
  console.log('[tkt033:cycleway] source geometry: ' + output.geometry.sourceFeatureCount +
    ' feature(s), ' + output.geometry.lineVertexCounts.join('/') + ' vertices');
  console.log('[tkt033:cycleway] nearest source segment: ' +
    (output.geometry.closestSegment?.distanceMeters ?? 'none') + 'm');
  console.log('[tkt033:cycleway] closest seam contact: ' +
    JSON.stringify(output.geometry.seamContacts[0] ?? null));
  for (const sample of output.seamCrossSection) {
    if ([-1, -0.25, -0.05, 0, 0.05, 0.25, 1].includes(sample.northing - POINT.northing)) {
      console.log('[tkt033:cycleway] north ' +
        Number((sample.northing - POINT.northing).toFixed(2)) + 'm: source=' +
        sample.source.status + ' any=' + sample.anyRoad.status +
        ' nearest-source=' + (sample.nearestSource.nearestMeters ?? '>20') + 'm');
    }
  }
  console.log('[tkt033:cycleway] wrote ' + opts.jsonPath);
  console.log('[tkt033:cycleway] canonical packs untouched');
  return output;
}

const entrypoint = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (entrypoint) {
  try {
    inspectMissingCyclewaySeam(parseCyclewaySeamArgs());
  } catch (err) {
    console.error('[tkt033:cycleway] ' + (err instanceof Error ? err.stack : String(err)));
    process.exitCode = 1;
  }
}
