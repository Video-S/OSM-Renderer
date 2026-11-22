import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as THREE from 'three';
import { OverijsselOsmStore } from '../src/server/osm/OverijsselOsmStore';
import {
  OVERIJSSEL_PBF_EXPECTED_SHA256, resolveOverijsselIndexPath,
} from '../src/server/osm/overijsselConfig';
import { disposeIngestedStudyRegionPlans } from '../src/server/tiles/OfflineHengeloTileBaker';
import { ingestCanonicalStudyGeoJson } from '../src/world/tiling/TiledStudyPipeline';
import { createAlignedStudyGrid, utmBoundsToGeoBounds } from '../src/world/tiling/TileGrid';
import { utm32NToGeo } from '../src/world/tiling/RegionalProjection';

/**
 * TKT-033 source-backed diagnostic in the SHARED road pipeline, before tile
 * encoding or viewer streaming. This only builds a small disposable scene in
 * memory. It never modifies any SQLite, baked shard pack or mosaic manifest.
 */
export const MISSING_ROAD_CASES = [
  { sourceId: 'way/6666519', easting: 351822.7, northing: 5790720, roadClass: 'primary' },
  { sourceId: 'way/6661112', easting: 357376, northing: 5791095.095, roadClass: 'residential' },
  { sourceId: 'way/221267376', easting: 357376, northing: 5790237.696, roadClass: 'service' },
  { sourceId: 'way/221267376', easting: 357376, northing: 5790254.857, roadClass: 'service' },
  { sourceId: 'way/546666718', easting: 352326.079, northing: 5794816, roadClass: 'residential' },
  { sourceId: 'way/38892898', easting: 352329.339, northing: 5794816, roadClass: 'cycleway' },
] as const;

export interface RoadDiagnosisOptions {
  sourceId: string;
  easting: number;
  northing: number;
  sourceIndex: string;
  outPath: string;
  contextMeters: number;
}
export function parseMissingRoadArgs(args: readonly string[] = process.argv.slice(2)): RoadDiagnosisOptions {
  const defaults = MISSING_ROAD_CASES[1];
  const out: RoadDiagnosisOptions = {
    sourceId: defaults.sourceId,
    easting: defaults.easting,
    northing: defaults.northing,
    sourceIndex: resolveOverijsselIndexPath(),
    outPath: path.resolve('benchmarks/results/tkt033-shared-road-diagnosis.json'),
    contextMeters: 768,
  };
  let hasE = false, hasN = false;
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq < 3) throw Error('Expected --key=value, got: ' + arg);
    const key = arg.slice(2, eq), val = arg.slice(eq + 1);
    if (!val) throw Error('Empty --' + key);
    if (key === 'feature') out.sourceId = val;
    else if (key === 'easting') { out.easting = Number(val); hasE = true; }
    else if (key === 'northing') { out.northing = Number(val); hasN = true; }
    else if (key === 'source-index') out.sourceIndex = path.resolve(val);
    else if (key === 'out') out.outPath = path.resolve(val);
    else if (key === 'context-meters') out.contextMeters = Number(val);
    else throw Error('Unknown --' + key);
  }
  if (!(out.sourceId.startsWith('way/') || out.sourceId.startsWith('relation/'))) {
    throw Error('--feature must be an OSM way/... or relation/... ID');
  }
  if (hasE !== hasN) throw Error('Use --easting and --northing together');
  if (!hasE && !hasN && out.sourceId !== defaults.sourceId) {
    const found = MISSING_ROAD_CASES.find((c) => c.sourceId === out.sourceId);
    if (!found) throw Error('Unknown feature coordinates; supply --easting and --northing');
    out.easting = found.easting;
    out.northing = found.northing;
  }
  if (!Number.isFinite(out.easting) || !Number.isFinite(out.northing)) {
    throw Error('UTM easting/northing must be finite');
  }
  if (!Number.isFinite(out.contextMeters) || out.contextMeters < 128 || out.contextMeters > 2048) {
    throw Error('--context-meters must be 128..2048');
  }
  return out;
}

interface LocalPoint { x: number; z: number }
export function pointToSegmentDistance(
  p: LocalPoint, a: LocalPoint, b: LocalPoint
): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const d2 = dx * dx + dz * dz;
  if (d2 < 1e-12) return Math.hypot(p.x - a.x, p.z - a.z);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / d2));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}
export function pointToTriangleDistance(
  p: LocalPoint, a: LocalPoint, b: LocalPoint, c: LocalPoint
): number {
  const cross = (u: LocalPoint, v: LocalPoint, w: LocalPoint) =>
    (v.x - u.x) * (w.z - u.z) - (v.z - u.z) * (w.x - u.x);
  const d = cross(a, b, c);
  if (Math.abs(d) > 1e-10) {
    const p1 = cross(a, b, p) / d;
    const p2 = cross(b, c, p) / d;
    const p3 = cross(c, a, p) / d;
    if (p1 >= -1e-7 && p2 >= -1e-7 && p3 >= -1e-7) return 0;
  }
  return Math.min(
    pointToSegmentDistance(p, a, b),
    pointToSegmentDistance(p, b, c),
    pointToSegmentDistance(p, c, a)
  );
}
export function nearestRoadTriangleDistance(
  geometry: THREE.BufferGeometry, p: LocalPoint, cutoff = 40
): number {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || p.x < box.min.x - cutoff || p.x > box.max.x + cutoff ||
      p.z < box.min.z - cutoff || p.z > box.max.z + cutoff) return Infinity;
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return Infinity;
  const idx = geometry.getIndex();
  const count = Math.floor((idx?.count ?? pos.count) / 3);
  let best = cutoff;
  for (let face = 0; face < count; face++) {
    const indices = [0, 1, 2].map((j) =>
      idx ? idx.getX(face * 3 + j) : face * 3 + j);
    const [a, b, c] = indices.map((j) => ({ x: pos.getX(j), z: pos.getZ(j) }));
    const minX = Math.min(a.x, b.x, c.x), maxX = Math.max(a.x, b.x, c.x);
    const minZ = Math.min(a.z, b.z, c.z), maxZ = Math.max(a.z, b.z, c.z);
    if (p.x < minX - best || p.x > maxX + best ||
        p.z < minZ - best || p.z > maxZ + best) continue;
    best = Math.min(best, pointToTriangleDistance(p, a, b, c));
    if (best === 0) break;
  }
  return best;
}

interface RoadSurfaceWitness {
  sourceFeatureId: string;
  sourceFeatureIds: string[];
  roadClass: string;
  distanceMeters: number;
}
export function diagnoseMissingRoad(opts: RoadDiagnosisOptions) {
  const [lon, lat] = utm32NToGeo(opts.easting, opts.northing);
  const grid = createAlignedStudyGrid({
    name: 'tkt033-shared-road-' + opts.sourceId.replace('/', '-'),
    centerLonLat: [lon, lat], cols: 2, rows: 2,
    tileSizeMeters: 1024, collarMeters: 64,
  });
  const store = new OverijsselOsmStore(opts.sourceIndex, {
    expectedSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
  });
  const extent = grid.studyUtmBounds;
  const bounds = utmBoundsToGeoBounds({
    minEasting: extent.minEasting - opts.contextMeters,
    maxEasting: extent.maxEasting + opts.contextMeters,
    minNorthing: extent.minNorthing - opts.contextMeters,
    maxNorthing: extent.maxNorthing + opts.contextMeters,
  });
  let query: ReturnType<OverijsselOsmStore['queryBBox']>;
  try {
    query = store.queryBBox({ ...bounds, locationName: grid.name });
  } finally {
    store.close();
  }
  let region: ReturnType<typeof ingestCanonicalStudyGeoJson> | null = null;
  try {
    region = ingestCanonicalStudyGeoJson(query.geojson, grid);
    const match = (value: string | undefined, values?: readonly string[]) =>
      value === opts.sourceId || values?.includes(opts.sourceId) === true;
    const original = (query.geojson.features ?? []).filter((f: any) =>
      String(f.id ?? f.properties?.['@id'] ?? f.properties?.id ?? '') === opts.sourceId
    ).map((f: any) => ({
      geometryType: f.geometry?.type,
      coordinateCount: Array.isArray(f.geometry?.coordinates) ? f.geometry.coordinates.length : 0,
      tags: f.properties?.tags ?? f.properties,
    }));
    const parsed = region.data.roads.filter((r) =>
      match(r.sourceFeatureId, r.sourceFeatureIds));
    const sourceParts = region.data.topologySource?.roadParts?.filter((part) =>
      part.sourceFeatureId === opts.sourceId) ?? [];
    const edges = region.descriptors?.roadEdges.filter((edge) =>
      match(edge.sourceFeatureId, edge.sourceFeatureIds) ||
      edge.provenance.segments.some((seg) =>
        match(seg.sourceFeatureId, seg.deduplicatedFeatureIds))
    ) ?? [];
    const [x, z] = grid.projection.utmToLocal(opts.easting, opts.northing);
    const plan = region.precomputedGlobalPlans.atGradeRoadPlan;
    const p = { x, z };
    const surfaces: RoadSurfaceWitness[] = [];
    if (plan) for (const [roadClass, items] of plan.roadsByClass) {
      for (const item of items) {
        const distance = nearestRoadTriangleDistance(item.geom, p);
        if (distance < 40) surfaces.push({
          sourceFeatureId: item.info.sourceFeatureId ?? '',
          sourceFeatureIds: item.info.sourceFeatureIds ?? [],
          roadClass,
          distanceMeters: Number(distance.toFixed(4)),
        });
      }
    }
    surfaces.sort((a, b) =>
      a.distanceMeters - b.distanceMeters ||
      a.sourceFeatureId.localeCompare(b.sourceFeatureId));
    const sourceSurfaces = surfaces.filter((s) => match(s.sourceFeatureId, s.sourceFeatureIds));
    const result = {
      ticket: 'TKT-033',
      purpose: 'Source-backed shared road generation before tile clipping, codec and streaming',
      snapshotId: query.snapshotMetadata.snapshotId,
      sourceSha256: query.snapshotMetadata.sourceSha256,
      selected: { sourceId: opts.sourceId, easting: opts.easting, northing: opts.northing },
      local: { x, z },
      grid: { ...grid.studyUtmBounds, contextMeters: opts.contextMeters },
      inventory: {
        sourceFeatures: original,
        parsedRoadCount: parsed.length,
        parsedRoads: parsed.map((r) => ({
          id: r.id, sourceFeatureId: r.sourceFeatureId, roadClass: r.roadClass,
          width: r.width, layer: r.layer, isBridge: r.isBridge, isTunnel: r.isTunnel,
          points: r.points.length,
        })),
        topologyPartCount: sourceParts.length,
        graphEdgeCount: edges.length,
        graphEdges: edges.map((e) => ({
          id: e.id, sourceFeatureIds: e.sourceFeatureIds, roadClass: e.roadClass,
          width: e.width, layer: e.layer, isBridge: e.isBridge, isTunnel: e.isTunnel,
          isAtGradeBuildable: e.isAtGradeBuildable, pointCount: e.points.length,
          placement: e.placementClassification,
        })),
      },
      plan: plan ? {
        renderedSourceId: plan.renderedSourceIds.has(opts.sourceId),
        fullySubtractedSourceId: plan.fullySubtractedRoadIds.has(opts.sourceId),
        outputStats: plan.stats,
        diagnostics: region.data.diagnostics?.featuresFullySubtracted,
        nearestSourceGeometryMeters: sourceSurfaces[0]?.distanceMeters ?? null,
        nearestAnyRoadGeometryMeters: surfaces[0]?.distanceMeters ?? null,
        nearestRoads: surfaces.slice(0, 12),
      } : null,
      interpretationLimits: [
        'This is a bounded 2x2 tile study generated without tile clipping, encoding or viewer streaming.',
        'Independent query/graph context may differ from the original 4x4 regional shard.',
        'Distance to a road polygon cannot prove source attribution, correct connectivity or visible scene parity.',
        'Only a zero distance proves that this exact UTM point lies inside an emitted plan triangle.',
        'A missing surface on the original OSM centerline may be legitimate due to graph junction adjustments.',
      ],
    };
    fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
    fs.writeFileSync(opts.outPath, JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    if (region) disposeIngestedStudyRegionPlans(region);
  }
}

const entrypoint = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (entrypoint) {
  try {
    const opts = parseMissingRoadArgs();
    const result = diagnoseMissingRoad(opts);
    console.log('[tkt033] wrote ' + opts.outPath);
    console.log('[tkt033] source/parsed/graph:', result.inventory.sourceFeatures.length,
      result.inventory.parsedRoadCount, result.inventory.graphEdgeCount);
    console.log('[tkt033] source triangle distance (m):',
      result.plan?.nearestSourceGeometryMeters ?? 'absent');
    console.log('[tkt033] any-road triangle distance (m):',
      result.plan?.nearestAnyRoadGeometryMeters ?? 'absent');
    console.log('[tkt033] canonical packs unchanged; read JSON for detailed stage inventory');
  } catch (error) {
    console.error('[tkt033] ' + (error instanceof Error ? error.stack : String(error)));
    process.exitCode = 1;
  }
}
