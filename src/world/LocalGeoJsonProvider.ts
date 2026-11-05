import * as THREE from 'three';
import polygonClipping from 'polygon-clipping';
import {
  BarrierFeature,
  BarrierType,
  BuildingFeature,
  InfrastructurePointKind,
  InfrastructurePointMetadata,
  LanduseFeature,
  LanduseType,
  LandmarkType,
  LinearWaterwayFeature,
  MapFeatureDiagnostics,
  ParkFeature,
  PointLandmarkFeature,
  ProcessedMapData,
  RawGeoJsonProperties,
  RailwayFeature,
  RailwayType,
  RoadClass,
  RoadFeature,
  TopologySourceData,
  UnchainedRailwayPart,
  UnchainedRoadPart,
  WaterBodyFeature,
  WaterBodyType,
  WaterwayType,
} from '../types/MapFeature';
import { WorldCoordinates } from './WorldCoordinates';
import { MapDataProvider, MapRegionQuery } from './MapDataProvider';
import { classifyGeoJsonFeature, ROAD_CLASS_WIDTHS } from './FeatureCatalogue';
import {
  TopologicalNodeIndex,
  DEFAULT_NODE_SNAP_TOLERANCE_METERS,
} from './TopologicalNodeIndex';

export { TopologicalNodeIndex, DEFAULT_NODE_SNAP_TOLERANCE_METERS };

/**
 * Exact 2D segment-segment intersection test in [x, z].
 * When `excludeSharedEndpoints` is true, shared or near-shared endpoints (< 0.5m) are ignored.
 */
function segmentsIntersect2D(
  a0: [number, number],
  a1: [number, number],
  b0: [number, number],
  b1: [number, number],
  excludeSharedEndpoints: boolean = true
): boolean {
  if (excludeSharedEndpoints) {
    const eps = 0.5;
    if (
      Math.hypot(a0[0] - b0[0], a0[1] - b0[1]) < eps ||
      Math.hypot(a0[0] - b1[0], a0[1] - b1[1]) < eps ||
      Math.hypot(a1[0] - b0[0], a1[1] - b0[1]) < eps ||
      Math.hypot(a1[0] - b1[0], a1[1] - b1[1]) < eps
    ) {
      return false;
    }
  }

  const dax = a1[0] - a0[0];
  const daz = a1[1] - a0[1];
  const dbx = b1[0] - b0[0];
  const dbz = b1[1] - b0[1];

  const denom = dax * dbz - daz * dbx;
  if (Math.abs(denom) < 1e-8) return false;

  const s = ((b0[0] - a0[0]) * dbz - (b0[1] - a0[1]) * dbx) / denom;
  const t = ((b0[0] - a0[0]) * daz - (b0[1] - a0[1]) * dax) / denom;

  return s >= -0.02 && s <= 1.02 && t >= -0.02 && t <= 1.02;
}

function pointToSegmentDist2D(
  p: [number, number],
  s0: [number, number],
  s1: [number, number]
): number {
  const dx = s1[0] - s0[0];
  const dz = s1[1] - s0[1];
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-8) return Math.hypot(p[0] - s0[0], p[1] - s0[1]);
  const t = Math.min(Math.max(((p[0] - s0[0]) * dx + (p[1] - s0[1]) * dz) / lenSq, 0), 1);
  return Math.hypot(p[0] - (s0[0] + t * dx), p[1] - (s0[1] + t * dz));
}

function polylinesCross2D(
  lineA: [number, number][],
  lineB: [number, number][],
  excludeSharedEndpoints: boolean = true,
  proximityToleranceMeters: number = 0
): boolean {
  for (let i = 0; i < lineA.length - 1; i++) {
    const a0 = lineA[i];
    const a1 = lineA[i + 1];
    for (let j = 0; j < lineB.length - 1; j++) {
      const b0 = lineB[j];
      const b1 = lineB[j + 1];
      if (segmentsIntersect2D(a0, a1, b0, b1, excludeSharedEndpoints)) {
        return true;
      }
      if (proximityToleranceMeters > 0) {
        if (
          pointToSegmentDist2D(a0, b0, b1) <= proximityToleranceMeters ||
          pointToSegmentDist2D(a1, b0, b1) <= proximityToleranceMeters
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Clips a 2D polyline to an axis-aligned bounding box [minX, minZ, maxX, maxZ] using Liang-Barsky.
 * Preserves per-vertex OSM node IDs for unclipped original vertices and sets `undefined` on
 * newly interpolated boundary intersection endpoints, recording `clippedAtStart` and `clippedAtEnd`.
 */
export function clipPolylineToBox(
  points: [number, number][],
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  rawOsmNodes?: Array<string | number>
): {
  lines: Array<{
    points: [number, number][];
    osmNodes?: Array<string | number | undefined>;
    clippedAtStart?: boolean;
    clippedAtEnd?: boolean;
  }>;
  wasClipped: boolean;
} {
  if (!points || points.length < 2) {
    return { lines: [], wasClipped: false };
  }

  let allInside = true;
  for (const [x, z] of points) {
    if (x < minX || x > maxX || z < minZ || z > maxZ) {
      allInside = false;
      break;
    }
  }
  if (allInside) {
    return {
      lines: [
        {
          points,
          osmNodes:
            rawOsmNodes && rawOsmNodes.length === points.length ? [...rawOsmNodes] : undefined,
          clippedAtStart: false,
          clippedAtEnd: false,
        },
      ],
      wasClipped: false,
    };
  }

  const hasValidNodes = Boolean(rawOsmNodes && rawOsmNodes.length === points.length);
  const result: Array<{
    points: [number, number][];
    osmNodes?: Array<string | number | undefined>;
    clippedAtStart?: boolean;
    clippedAtEnd?: boolean;
  }> = [];

  let curPts: [number, number][] = [];
  let curNodes: Array<string | number | undefined> = [];
  let curClippedAtStart = false;
  let curClippedAtEnd = false;

  const flushCurrent = () => {
    if (curPts.length >= 2) {
      result.push({
        points: curPts,
        osmNodes: hasValidNodes ? curNodes : undefined,
        clippedAtStart: curClippedAtStart,
        clippedAtEnd: curClippedAtEnd,
      });
    }
    curPts = [];
    curNodes = [];
    curClippedAtStart = false;
    curClippedAtEnd = false;
  };

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const dx = p1[0] - p0[0];
    const dz = p1[1] - p0[1];

    let t0 = 0.0;
    let t1 = 1.0;

    const clipTest = (p: number, q: number): boolean => {
      if (Math.abs(p) < 1e-12) {
        return q >= 0;
      }
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
      return true;
    };

    if (
      clipTest(-dx, p0[0] - minX) &&
      clipTest(dx, maxX - p0[0]) &&
      clipTest(-dz, p0[1] - minZ) &&
      clipTest(dz, maxZ - p0[1])
    ) {
      if (t0 > 0) {
        flushCurrent();
        curPts.push([p0[0] + t0 * dx, p0[1] + t0 * dz]);
        curNodes.push(undefined);
        curClippedAtStart = true;
      } else if (curPts.length === 0) {
        curPts.push(p0);
        curNodes.push(hasValidNodes ? rawOsmNodes![i] : undefined);
        curClippedAtStart = false;
      }

      if (t1 < 1) {
        const exitPt: [number, number] = [p0[0] + t1 * dx, p0[1] + t1 * dz];
        const prev = curPts[curPts.length - 1];
        if (!prev || Math.hypot(exitPt[0] - prev[0], exitPt[1] - prev[1]) > 1e-3) {
          curPts.push(exitPt);
          curNodes.push(undefined);
        } else if (curNodes.length > 0) {
          curNodes[curNodes.length - 1] = undefined;
        }
        curClippedAtEnd = true;
        flushCurrent();
      } else {
        const prev = curPts[curPts.length - 1];
        if (!prev || Math.hypot(p1[0] - prev[0], p1[1] - prev[1]) > 1e-3) {
          curPts.push(p1);
          curNodes.push(hasValidNodes ? rawOsmNodes![i + 1] : undefined);
        }
      }
    } else {
      flushCurrent();
    }
  }

  flushCurrent();
  return { lines: result, wasClipped: true };
}

/**
 * Sutherland-Hodgman polygon ring clipper against an axis-aligned rectangle [minX, minZ, maxX, maxZ].
 */
function clipRingSutherlandHodgman(
  ring: [number, number][],
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number
): [number, number][] {
  const clipEdge = (
    pts: [number, number][],
    inside: (p: [number, number]) => boolean,
    intersect: (a: [number, number], b: [number, number]) => [number, number]
  ): [number, number][] => {
    const out: [number, number][] = [];
    if (pts.length === 0) return out;
    for (let i = 0; i < pts.length; i++) {
      const curr = pts[i];
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const currIn = inside(curr);
      const prevIn = inside(prev);
      if (currIn) {
        if (!prevIn) out.push(intersect(prev, curr));
        out.push(curr);
      } else if (prevIn) {
        out.push(intersect(prev, curr));
      }
    }
    return out;
  };

  let poly =
    ring.length > 1 &&
    Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 1e-5
      ? ring.slice(0, -1)
      : [...ring];

  poly = clipEdge(
    poly,
    (p) => p[0] >= minX,
    (a, b) => [minX, a[1] + ((minX - a[0]) / (b[0] - a[0] || 1e-9)) * (b[1] - a[1])]
  );
  poly = clipEdge(
    poly,
    (p) => p[0] <= maxX,
    (a, b) => [maxX, a[1] + ((maxX - a[0]) / (b[0] - a[0] || 1e-9)) * (b[1] - a[1])]
  );
  poly = clipEdge(
    poly,
    (p) => p[1] >= minZ,
    (a, b) => [a[0] + ((minZ - a[1]) / (b[1] - a[1] || 1e-9)) * (b[0] - a[0]), minZ]
  );
  poly = clipEdge(
    poly,
    (p) => p[1] <= maxZ,
    (a, b) => [a[0] + ((maxZ - a[1]) / (b[1] - a[1] || 1e-9)) * (b[0] - a[0]), maxZ]
  );

  if (poly.length >= 3) {
    poly.push([poly[0][0], poly[0][1]]);
  }
  return poly.length >= 4 ? poly : [];
}

export function computeRingArea2D(ring: [number, number][]): number {
  if (!ring || ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const p0 = ring[i];
    const p1 = ring[(i + 1) % ring.length];
    sum += p0[0] * p1[1] - p1[0] * p0[1];
  }
  return Math.abs(sum) * 0.5;
}

export function hasPolygonRingSelfIntersection(ring: [number, number][]): boolean {
  if (!ring || ring.length < 3) return true;
  const deduped: [number, number][] = [];
  for (const pt of ring) {
    if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) return true;
    if (
      deduped.length === 0 ||
      Math.hypot(
        pt[0] - deduped[deduped.length - 1][0],
        pt[1] - deduped[deduped.length - 1][1]
      ) > 1e-4
    ) {
      deduped.push(pt);
    }
  }
  if (
    deduped.length > 1 &&
    Math.hypot(
      deduped[0][0] - deduped[deduped.length - 1][0],
      deduped[0][1] - deduped[deduped.length - 1][1]
    ) <= 1e-4
  ) {
    deduped.pop();
  }
  const n = deduped.length;
  if (n < 3) return true;

  for (let i = 0; i < n; i++) {
    const prev = deduped[(i - 1 + n) % n];
    const curr = deduped[i];
    const next = deduped[(i + 1) % n];
    const v1x = curr[0] - prev[0];
    const v1z = curr[1] - prev[1];
    const v2x = next[0] - curr[0];
    const v2z = next[1] - curr[1];
    const l1 = Math.hypot(v1x, v1z);
    const l2 = Math.hypot(v2x, v2z);
    if (l1 > 1e-4 && l2 > 1e-4) {
      const cosAngle = (v1x * v2x + v1z * v2z) / (l1 * l2);
      if (cosAngle < -0.995) return true;
    }
  }

  const ccw = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) =>
    (cz - az) * (bx - ax) - (bz - az) * (cx - ax);

  for (let i = 0; i < n; i++) {
    const a1 = deduped[i];
    const a2 = deduped[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const b1 = deduped[j];
      const b2 = deduped[(j + 1) % n];
      const d1 = ccw(a1[0], a1[1], a2[0], a2[1], b1[0], b1[1]);
      const d2 = ccw(a1[0], a1[1], a2[0], a2[1], b2[0], b2[1]);
      const d3 = ccw(b1[0], b1[1], b2[0], b2[1], a1[0], a1[1]);
      const d4 = ccw(b1[0], b1[1], b2[0], b2[1], a2[0], a2[1]);
      if (
        ((d1 > 1e-7 && d2 < -1e-7) || (d1 < -1e-7 && d2 > 1e-7)) &&
        ((d3 > 1e-7 && d4 < -1e-7) || (d3 < -1e-7 && d4 > 1e-7))
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasNonFiniteCoordinates(coords: any): boolean {
  if (!Array.isArray(coords) || coords.length === 0) return true;
  if (typeof coords[0] === 'number' || coords[0] === null || coords[0] === undefined) {
    if (coords.length < 2) return true;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    return (
      typeof coords[0] !== 'number' ||
      typeof coords[1] !== 'number' ||
      !Number.isFinite(lon) ||
      !Number.isFinite(lat)
    );
  }
  for (const item of coords) {
    if (hasNonFiniteCoordinates(item)) return true;
  }
  return false;
}

function extractTopologyRawOsmNodeIds(props: RawGeoJsonProperties): Array<string | number> | undefined {
  if (Array.isArray(props._nodeIds)) return props._nodeIds;
  if (Array.isArray(props.nodes)) return props.nodes;
  if (Array.isArray(props.nodeIds)) return props.nodeIds;
  return undefined;
}

function extractLegacyRawOsmNodeIds(props: RawGeoJsonProperties): Array<string | number> | undefined {
  if (Array.isArray(props.nodes)) return props.nodes;
  if (Array.isArray(props.nodeIds)) return props.nodeIds;
  return undefined;
}

/**
 * Extracts verified per-part explicit OSM node IDs for M2.3 topology graph construction.
 * Reads _nodeIdsByPart, _nodeIds, nodes, and nodeIds.
 */
function extractVerifiedTopologyPartOsmNodeIds(
  props: RawGeoJsonProperties,
  partIndex: number,
  totalParts: number,
  expectedVertexCount: number
): Array<string | number> | undefined {
  if (expectedVertexCount < 2) return undefined;

  if (Array.isArray(props._nodeIdsByPart) && props._nodeIdsByPart.length === totalParts) {
    const partNodes = props._nodeIdsByPart[partIndex];
    if (Array.isArray(partNodes) && partNodes.length === expectedVertexCount) {
      return [...partNodes];
    }
    return undefined;
  }

  const raw = extractTopologyRawOsmNodeIds(props);
  if (!raw) return undefined;

  if (totalParts === 1 && raw.length === expectedVertexCount && !Array.isArray(raw[0])) {
    return [...raw];
  }

  if (
    raw.length === totalParts &&
    Array.isArray(raw[partIndex]) &&
    (raw[partIndex] as unknown as Array<string | number>).length === expectedVertexCount
  ) {
    return [...(raw[partIndex] as unknown as Array<string | number>)];
  }

  return undefined;
}

/**
 * Extracts legacy explicit OSM node IDs (only props.nodes and props.nodeIds from synthetic test fixtures).
 * Deliberately excludes server-side live enrichment (_nodeIds, _nodeIdsByPart) so that legacy
 * renderer-facing chaining (chainContiguousRoads) and GeometryBuilder junction building remain 100%
 * isolated and byte-for-byte identical until Stage E.
 */
function extractLegacyPartOsmNodeIds(
  props: RawGeoJsonProperties,
  partIndex: number,
  totalParts: number,
  expectedVertexCount: number
): Array<string | number> | undefined {
  if (expectedVertexCount < 2) return undefined;

  const raw = extractLegacyRawOsmNodeIds(props);
  if (!raw) return undefined;

  if (totalParts === 1 && raw.length === expectedVertexCount && !Array.isArray(raw[0])) {
    return [...raw];
  }

  if (
    raw.length === totalParts &&
    Array.isArray(raw[partIndex]) &&
    (raw[partIndex] as unknown as Array<string | number>).length === expectedVertexCount
  ) {
    return [...(raw[partIndex] as unknown as Array<string | number>)];
  }

  return undefined;
}

function cloneRawGeoJsonProperties(props: RawGeoJsonProperties): RawGeoJsonProperties {
  const copy: RawGeoJsonProperties = { ...props };
  if (Array.isArray(copy.nodes)) {
    copy.nodes = [...copy.nodes];
  }
  if (Array.isArray(copy.nodeIds)) {
    copy.nodeIds = [...copy.nodeIds];
  }
  if (Array.isArray(copy._nodeIds)) {
    copy._nodeIds = [...copy._nodeIds];
  }
  if (Array.isArray(copy._nodeIdsByPart)) {
    copy._nodeIdsByPart = copy._nodeIdsByPart.map((part) =>
      Array.isArray(part) ? [...part] : part
    );
  }
  return copy;
}

/**
 * Strips server-side live topology enrichment properties (_nodeIds, _nodeIdsByPart) from
 * legacy renderer-facing features so that legacy mapData.roads and mapData.railways
 * metadata (including osmTags) remain 100% equivalent before and after enrichment.
 */
function cleanLegacyOsmTags(props: RawGeoJsonProperties): RawGeoJsonProperties {
  const copy: RawGeoJsonProperties = { ...props };
  delete copy._nodeIds;
  delete copy._nodeIdsByPart;
  if (Array.isArray(copy.nodes)) {
    copy.nodes = [...copy.nodes];
  }
  if (Array.isArray(copy.nodeIds)) {
    copy.nodeIds = [...copy.nodeIds];
  }
  return copy;
}

const SECONDARY_RAILWAY_SERVICE_VALUES = new Set<string>(['siding', 'yard', 'spur', 'crossover']);
const SECONDARY_RAILWAY_USAGE_VALUES = new Set<string>([
  'branch',
  'industrial',
  'military',
  'test',
  'tourism',
]);

function isSecondaryRailwayBranch(service?: string, usage?: string): boolean {
  if (service && SECONDARY_RAILWAY_SERVICE_VALUES.has(service.trim().toLowerCase())) {
    return true;
  }
  if (usage && SECONDARY_RAILWAY_USAGE_VALUES.has(usage.trim().toLowerCase())) {
    return true;
  }
  return false;
}

function normalizeExtractedOsmNodeId(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^feat-\d+(?:-\d+)?$/i.test(trimmed)) return undefined;
  if (trimmed.startsWith('node/')) {
    const rest = trimmed.slice(5).trim();
    if (!rest || /^feat-\d+(?:-\d+)?$/i.test(rest)) return undefined;
    return rest;
  }
  if (trimmed.startsWith('osm_')) {
    const rest = trimmed.slice(4).trim();
    if (!rest || /^feat-\d+(?:-\d+)?$/i.test(rest)) return undefined;
    return rest;
  }
  return trimmed;
}

function classifyInfrastructurePointKind(
  props: RawGeoJsonProperties
): InfrastructurePointKind | undefined {
  const railwayTag = String(props.railway || '').trim().toLowerCase();
  if (railwayTag === 'switch') return 'railway_switch';
  if (railwayTag === 'railway_crossing') return 'railway_crossing_flat';
  if (railwayTag === 'level_crossing') return 'railway_level_crossing';
  if (railwayTag === 'crossing') return 'railway_ped_crossing';

  const highwayTag = String(props.highway || '').trim().toLowerCase();
  if (highwayTag === 'crossing') return 'highway_crossing';

  return undefined;
}

function extractPointRawOsmNodeId(
  props: RawGeoJsonProperties,
  id: string,
  hasExplicitSourceId: boolean
): string | undefined {
  if ((props as any).rawOsmNodeId !== undefined && (props as any).rawOsmNodeId !== null) {
    const norm = normalizeExtractedOsmNodeId(String((props as any).rawOsmNodeId));
    if (norm) return norm;
  }
  if (Array.isArray(props._nodeIds) && props._nodeIds.length > 0 && props._nodeIds[0] !== undefined) {
    const norm = normalizeExtractedOsmNodeId(String(props._nodeIds[0]));
    if (norm) return norm;
  }
  if (Array.isArray(props.nodes) && props.nodes.length > 0 && props.nodes[0] !== undefined) {
    const norm = normalizeExtractedOsmNodeId(String(props.nodes[0]));
    if (norm) return norm;
  }
  if (Array.isArray(props.nodeIds) && props.nodeIds.length > 0 && props.nodeIds[0] !== undefined) {
    const norm = normalizeExtractedOsmNodeId(String(props.nodeIds[0]));
    if (norm) return norm;
  }
  if (hasExplicitSourceId) {
    const trimmedId = id.trim();
    if (/^feat-\d+(?:-\d+)?$/i.test(trimmedId)) {
      return undefined;
    }
    if (trimmedId.startsWith('node/')) {
      const rest = trimmedId.slice(5).trim();
      if (rest.length > 0 && !/^feat-\d+(?:-\d+)?$/i.test(rest)) return rest;
    } else if (trimmedId.startsWith('osm_')) {
      const rest = trimmedId.slice(4).trim();
      if (rest.length > 0 && !/^feat-\d+(?:-\d+)?$/i.test(rest)) return rest;
    } else if (!trimmedId.startsWith('way/') && !trimmedId.startsWith('relation/')) {
      return trimmedId;
    }
  }
  return undefined;
}

export interface ClipBoxOptions {
  forceFallback?: boolean;
}

export interface ClippedPolygonResult {
  polygons: [number, number][][][];
  wasClipped: boolean;
  fallbackUsed?: boolean;
}

/**
 * Topology-aware fallback for polygon-to-box clipping.
 * Decomposes concave and holed polygons into convex planar triangles via THREE.ShapeUtils.triangulateShape,
 * clips each triangle against the axis-aligned box with exact convex Sutherland-Hodgman clipping,
 * and reconstructs disjoint connected components into clean MultiPolygon parts via Boolean union.
 * Never collapses multiple disconnected components into a single malformed polygon.
 * If valid geometry cannot be guaranteed (e.g. self-intersecting un-triangulable input),
/**
 * Ensures a ring has identical first and last vertices if it has at least 3 points.
 */
function ensureClosedRing(ring: [number, number][]): [number, number][] {
  if (!ring || ring.length < 3) return ring || [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-4) {
    return [...ring, [first[0], first[1]]];
  }
  return ring;
}

/**
 * Extracts distinct vertex sequence without redundant closing point for ShapeUtils triangulation.
 */
function toDistinctVertices2D(ring: [number, number][]): THREE.Vector2[] {
  if (!ring || ring.length < 3) return [];
  const isClosed =
    ring.length > 1 &&
    Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 1e-4;
  const pts = isClosed ? ring.slice(0, -1) : ring;
  return pts.map(([x, z]) => new THREE.Vector2(x, z));
}

/**
 * Topology-aware fallback for polygon-to-box clipping.
 * Decomposes concave and holed polygons into convex planar triangles via THREE.ShapeUtils.triangulateShape,
 * clips each triangle against the axis-aligned box with exact convex Sutherland-Hodgman clipping,
 * and reconstructs disjoint connected components into clean MultiPolygon parts via Boolean union.
 * 
 * Safe for direct callers: accepts either open or closed rings.
 * If an interior hole is a sliver (< 0.05 m²), degenerate, or self-intersecting, the offending hole is
 * dropped rather than discarding the entire polygon. If the outer boundary itself cannot produce valid
 * geometry, returns an empty array ([]).
 */
export function clipPolygonWithTopologyAwareFallback(
  rings: [number, number][][],
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number
): [number, number][][][] {
  if (!rings || rings.length === 0 || rings[0].length < 3) return [];

  const closedOuter = ensureClosedRing(rings[0]);
  if (computeRingArea2D(closedOuter) < 0.05 || hasPolygonRingSelfIntersection(closedOuter)) {
    return [];
  }

  // Filter holes: drop tiny sliver (< 0.05 m²) or self-intersecting holes instead of rejecting the whole polygon
  const validHoles: [number, number][][] = [];
  for (let i = 1; i < rings.length; i++) {
    const rawHole = rings[i];
    if (!rawHole || rawHole.length < 3) continue;
    const closedHole = ensureClosedRing(rawHole);
    if (
      closedHole.length >= 4 &&
      computeRingArea2D(closedHole) >= 0.05 &&
      !hasPolygonRingSelfIntersection(closedHole)
    ) {
      validHoles.push(closedHole);
    }
  }

  // 1. Prepare 2D contour and holes for triangulation
  const contourPts = toDistinctVertices2D(closedOuter);
  if (contourPts.length < 3) return [];
  if (THREE.ShapeUtils.isClockWise(contourPts)) {
    contourPts.reverse();
  }

  const holePtsList: THREE.Vector2[][] = [];
  for (const h of validHoles) {
    const h2d = toDistinctVertices2D(h);
    if (h2d.length >= 3) {
      if (!THREE.ShapeUtils.isClockWise(h2d)) {
        h2d.reverse();
      }
      holePtsList.push(h2d);
    }
  }

  let triIndices: number[][];
  try {
    triIndices = THREE.ShapeUtils.triangulateShape(contourPts, holePtsList);
  } catch {
    return [];
  }

  if (!triIndices || triIndices.length === 0) return [];

  const allVertices: THREE.Vector2[] = [...contourPts];
  for (const h of holePtsList) {
    allVertices.push(...h);
  }

  // 2. Clip each convex triangle against the axis-aligned box with Sutherland-Hodgman
  const clippedConvexPieces: [number, number][][][] = [];
  for (const [i0, i1, i2] of triIndices) {
    if (i0 >= allVertices.length || i1 >= allVertices.length || i2 >= allVertices.length) continue;
    const triRing: [number, number][] = [
      [allVertices[i0].x, allVertices[i0].y],
      [allVertices[i1].x, allVertices[i1].y],
      [allVertices[i2].x, allVertices[i2].y],
      [allVertices[i0].x, allVertices[i0].y],
    ];
    const clipped = clipRingSutherlandHodgman(triRing, minX, minZ, maxX, maxZ);
    if (clipped.length >= 4 && computeRingArea2D(clipped) >= 1e-4) {
      clippedConvexPieces.push([clipped]);
    }
  }

  if (clippedConvexPieces.length === 0) return [];

  // 3. Union adjacent convex pieces back into connected MultiPolygon components
  try {
    const firstGeom = clippedConvexPieces[0] as unknown as polygonClipping.Geom;
    const restGeoms = clippedConvexPieces.slice(1) as unknown as polygonClipping.Geom[];
    const rawUnion = (
      restGeoms.length > 0
        ? polygonClipping.union(firstGeom, ...restGeoms)
        : polygonClipping.union(firstGeom)
    ) as unknown as [number, number][][][];

    const valid = rawUnion
      .map((poly) =>
        poly.filter((ring, idx) =>
          idx === 0
            ? ring.length >= 4 && computeRingArea2D(ring) >= 0.05 && !hasPolygonRingSelfIntersection(ring)
            : ring.length >= 4 && computeRingArea2D(ring) >= 0.05 && !hasPolygonRingSelfIntersection(ring)
        )
      )
      .filter((poly) => poly.length > 0 && poly[0].length >= 4 && computeRingArea2D(poly[0]) >= 0.05);

    return valid;
  } catch {
    return [];
  }
}

/**
 * Clips a polygon `[outerRing, ...holes]` to `[minX, minZ, maxX, maxZ]`.
 * Uses primary Martínez-Rueda polygonClipping, with a topology-aware convex decomposition fallback
 * that guarantees disconnected components are emitted as distinct MultiPolygon parts, and that
 * boundary-crossing holes or invalid degenerate geometries are never silently returned as a single
 * malformed self-intersecting polygon.
 */
export function clipPolygonRingsToBox(
  rings: [number, number][][],
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  options?: ClipBoxOptions
): ClippedPolygonResult {
  if (!rings || rings.length === 0 || rings[0].length < 3) {
    return { polygons: [], wasClipped: false };
  }

  let rMinX = Infinity,
    rMaxX = -Infinity,
    rMinZ = Infinity,
    rMaxZ = -Infinity;
  for (const [x, z] of rings[0]) {
    if (x < rMinX) rMinX = x;
    if (x > rMaxX) rMaxX = x;
    if (z < rMinZ) rMinZ = z;
    if (z > rMaxZ) rMaxZ = z;
  }

  if (!options?.forceFallback && rMinX >= minX && rMaxX <= maxX && rMinZ >= minZ && rMaxZ <= maxZ) {
    return { polygons: [rings], wasClipped: false };
  }

  if (rMaxX <= minX || rMinX >= maxX || rMaxZ <= minZ || rMinZ >= maxZ) {
    return { polygons: [], wasClipped: true };
  }

  const closedRings: [number, number][][] = rings.map((r) => {
    if (r.length < 3) return r;
    const first = r[0];
    const last = r[r.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      return [...r, [first[0], first[1]]];
    }
    return r;
  });

  const boxPoly: [number, number][][] = [
    [
      [minX, minZ],
      [maxX, minZ],
      [maxX, maxZ],
      [minX, maxZ],
      [minX, minZ],
    ],
  ];

  if (!options?.forceFallback) {
    try {
      const clipped = polygonClipping.intersection(
        closedRings as unknown as polygonClipping.Geom,
        boxPoly as unknown as polygonClipping.Geom
      ) as unknown as [number, number][][][];
      const valid = clipped
        .map((poly) =>
          poly.filter((ring, idx) =>
            idx === 0
              ? ring.length >= 4 && computeRingArea2D(ring) >= 0.05 && !hasPolygonRingSelfIntersection(ring)
              : ring.length >= 4 && computeRingArea2D(ring) >= 0.05 && !hasPolygonRingSelfIntersection(ring)
          )
        )
        .filter((poly) => poly.length > 0 && poly[0].length >= 4 && computeRingArea2D(poly[0]) >= 0.05);
      return { polygons: valid, wasClipped: true, fallbackUsed: false };
    } catch {
      // Proceed to topology-aware fallback below
    }
  }

  // Topology-aware clipping fallback
  const fallbackResult = clipPolygonWithTopologyAwareFallback(
    closedRings,
    minX,
    minZ,
    maxX,
    maxZ
  );

  return {
    polygons: fallbackResult,
    wasClipped: true,
    fallbackUsed: true,
  };
}

export interface LocalGeoJsonProviderOptions {
  sourceUrl?: string;
  defaultBuildingHeight?: number;
  levelHeightMeters?: number;
}

export class LocalGeoJsonProvider implements MapDataProvider {
  readonly id = 'local-geojson';
  readonly name = 'Local GeoJSON Provider';

  private sourceUrl: string;
  private defaultBuildingHeight: number;
  private levelHeightMeters: number;

  constructor(options: LocalGeoJsonProviderOptions = {}) {
    this.sourceUrl = options.sourceUrl || '';
    this.defaultBuildingHeight = options.defaultBuildingHeight || 12.0;
    this.levelHeightMeters = options.levelHeightMeters || 3.2;
  }

  async loadRegion(query?: MapRegionQuery): Promise<ProcessedMapData> {
    const url = query?.sourceUrl || this.sourceUrl;
    if (!url) {
      throw new Error('No GeoJSON source URL provided to LocalGeoJsonProvider.loadRegion()');
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load GeoJSON dataset from ${url}: ${response.statusText}`);
    }
    const json = await response.json();
    return this.parseGeoJson(
      json,
      query?.locationName,
      query?.centerLon !== undefined && query?.centerLat !== undefined
        ? [query.centerLon, query.centerLat]
        : undefined,
      query?.radiusMeters
    );
  }

  /**
   * Parses a GeoJSON object into ProcessedMapData with strict, unambiguous diagnostic accounting.
   */
  parseGeoJson(
    geojson: any,
    explicitRegionName?: string,
    explicitCenter?: [number, number],
    clipRadiusMeters?: number
  ): ProcessedMapData {
    if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
      throw new Error('Invalid GeoJSON: Expected a FeatureCollection with features array');
    }

    const rawFeatures = geojson.features;

    // Initialize comprehensive diagnostics
    const diagnostics: MapFeatureDiagnostics = {
      sourceFeaturesReceived: rawFeatures.length,
      sourceFeaturesClassified: 0,
      totalFeaturesParsed: 0,
      sourceFeaturesRendered: 0,
      constructedMeshesCount: 0,
      parsedByCategory: {
        buildings: 0,
        roads: 0,
        railways: 0,
        waterBodies: 0,
        linearWaterways: 0,
        parks: 0,
        landuse: 0,
        barriers: 0,
        landmarks: 0,
      },
      parsedFeatureParts: {
        total: 0,
        byCategory: {
          buildings: 0,
          roads: 0,
          railways: 0,
          waterBodies: 0,
          linearWaterways: 0,
          parks: 0,
          landuse: 0,
          barriers: 0,
          landmarks: 0,
        },
      },
      geometryPartsGenerated: {
        total: 0,
        byCategory: {
          buildings: 0,
          roads: 0,
          railways: 0,
          waterBodies: 0,
          linearWaterways: 0,
          parks: 0,
          landuse: 0,
          barriers: 0,
          landmarks: 0,
        },
      },
      featuresClippedByBoundary: {
        clippedCount: 0,
        omittedOutsideCount: 0,
        sampleIds: [],
      },
      featuresFullySubtracted: {
        count: 0,
        sampleIds: [],
      },
      clippingFailures: {
        count: 0,
        sampleIds: [],
      },
      cartoSubtypesCount: {},
      skippedUnsupported: {
        total: 0,
        byTag: {},
      },
      rejectedInvalid: {
        total: 0,
        byReason: {},
      },
      featureLineage: {
        retainedCount: 0,
        chainedGroupsCount: 0,
        chainedFeaturesCount: 0,
        deduplicatedCount: 0,
        chainingMap: {},
        deduplicatedMap: {},
      },
      byGeometryType: {
        Point: 0,
        MultiPoint: 0,
        LineString: 0,
        MultiLineString: 0,
        Polygon: 0,
        MultiPolygon: 0,
        GeometryCollection: 0,
        Unknown: 0,
      },
      // Backward compatibility aliases:
      totalFeaturesReceived: rawFeatures.length,
      totalFeaturesRendered: 0,
    };

    const recordClipped = (id: string, omitted: boolean) => {
      if (!diagnostics.featuresClippedByBoundary) return;
      if (omitted) {
        diagnostics.featuresClippedByBoundary.omittedOutsideCount++;
      } else {
        diagnostics.featuresClippedByBoundary.clippedCount++;
      }
      if (diagnostics.featuresClippedByBoundary.sampleIds.length < 8) {
        diagnostics.featuresClippedByBoundary.sampleIds.push(id);
      }
    };

    const recordSkipped = (tag: string, id: string) => {
      diagnostics.skippedUnsupported.total++;
      if (!diagnostics.skippedUnsupported.byTag[tag]) {
        diagnostics.skippedUnsupported.byTag[tag] = { count: 0, sampleIds: [] };
      }
      diagnostics.skippedUnsupported.byTag[tag].count++;
      if (diagnostics.skippedUnsupported.byTag[tag].sampleIds.length < 5) {
        diagnostics.skippedUnsupported.byTag[tag].sampleIds.push(id);
      }
    };

    const recordRejected = (reason: string, id: string) => {
      diagnostics.rejectedInvalid.total++;
      if (!diagnostics.rejectedInvalid.byReason[reason]) {
        diagnostics.rejectedInvalid.byReason[reason] = { count: 0, sampleIds: [] };
      }
      diagnostics.rejectedInvalid.byReason[reason].count++;
      if (diagnostics.rejectedInvalid.byReason[reason].sampleIds.length < 5) {
        diagnostics.rejectedInvalid.byReason[reason].sampleIds.push(id);
      }
    };

    const recordCartoSubtype = (label: string) => {
      if (!diagnostics.cartoSubtypesCount) diagnostics.cartoSubtypesCount = {};
      diagnostics.cartoSubtypesCount[label] = (diagnostics.cartoSubtypesCount[label] || 0) + 1;
    };

    // 1. Compute geographic bounds to establish world origin (centroid)
    let minLon = Infinity;
    let maxLon = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;

    const inspectCoord = (lon: number, lat: number) => {
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    };

    for (const f of rawFeatures) {
      if (!f.geometry || !f.geometry.coordinates) continue;
      const p: RawGeoJsonProperties = { ...(f.properties || {}) };
      if (!p.id && f.id) p.id = String(f.id);
      const c = classifyGeoJsonFeature(p, f.geometry?.type || '');
      if (c.category !== 'unsupported') {
        this.traverseCoordinates(f.geometry.coordinates, inspectCoord);
      }
    }

    if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) {
      for (const f of rawFeatures) {
        if (!f.geometry || !f.geometry.coordinates) continue;
        this.traverseCoordinates(f.geometry.coordinates, inspectCoord);
      }
    }

    if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) {
      minLon = 4.900;
      maxLon = 4.900;
      minLat = 52.378;
      maxLat = 52.378;
    }

    const centerLon = explicitCenter ? explicitCenter[0] : (minLon + maxLon) / 2;
    const centerLat = explicitCenter ? explicitCenter[1] : (minLat + maxLat) / 2;
    const coords = new WorldCoordinates(centerLon, centerLat);

    // Region clipping box when an explicit live tile center or clip radius is provided
    const shouldClipToRegion = Boolean(explicitCenter || clipRadiusMeters !== undefined);
    const clipExtent = clipRadiusMeters !== undefined ? Math.max(clipRadiusMeters, 1) : 380;

    // Pre-scan narrow streams/ditches/drains vs major obstacle ways (at-grade roads, railways, rivers/canals)
    // so short bridges (< 15m) are only treated as culverts when justified by OSM tags or narrow stream crossings.
    const narrowStreamLines: [number, number][][] = [];
    const majorObstacleLines: Array<{ id: string; points: [number, number][] }> = [];

    for (let idx = 0; idx < rawFeatures.length; idx++) {
      const rf = rawFeatures[idx];
      if (!rf.geometry || !rf.geometry.coordinates) continue;
      const rProps: RawGeoJsonProperties = { ...(rf.properties || {}) };
      const rRawId = rProps.id ?? rf.id ?? rProps['@id'];
      const rId =
        rRawId !== undefined && rRawId !== null && String(rRawId).trim() !== ''
          ? String(rRawId)
          : `feat-${idx + 1}`;
      rProps.id = rId;
      const ww = String(rProps.waterway || '').toLowerCase();
      if (ww === 'stream' || ww === 'ditch' || ww === 'drain') {
        const lines = this.extractLineStrings(rf.geometry, coords);
        for (const l of lines) {
          if (l.length >= 2) narrowStreamLines.push(l);
        }
        continue;
      }
      const cls = classifyGeoJsonFeature(rProps, rf.geometry.type || '');
      if (
        (cls.category === 'road' && !cls.isBridge && !cls.isTunnel) ||
        cls.category === 'railway' ||
        (cls.category === 'water_line' && (cls.subtype === 'river' || cls.subtype === 'canal'))
      ) {
        const lines = this.extractLineStrings(rf.geometry, coords);
        for (const l of lines) {
          if (l.length >= 2) majorObstacleLines.push({ id: rId, points: l });
        }
      }
    }

    const isAtGradeCulvertSpan = (
      roadId: string,
      props: RawGeoJsonProperties,
      classification: ReturnType<typeof classifyGeoJsonFeature>,
      line: [number, number][],
      totalLen: number
    ): boolean => {
      const bridgeTag = String(props.bridge || '').toLowerCase();
      const tunnelTag = String(props.tunnel || '').toLowerCase();
      const culvertTag = String(props.culvert || '').toLowerCase();
      const manMadeTag = String(props.man_made || '').toLowerCase();

      if (
        tunnelTag === 'culvert' ||
        culvertTag === 'yes' ||
        bridgeTag === 'culvert' ||
        manMadeTag === 'culvert' ||
        bridgeTag === 'low_water_crossing'
      ) {
        return true;
      }

      if (classification.isTunnel || !classification.isBridge) return false;
      if (totalLen >= 15.0) return false;
      if (bridgeTag !== 'yes' && bridgeTag !== 'boardwalk') return false;

      // Never demote a short bridge that crosses an at-grade road, railway, river, or canal
      for (const obs of majorObstacleLines) {
        if (obs.id === roadId) continue;
        if (polylinesCross2D(line, obs.points, true, 0)) {
          return false;
        }
      }

      // Only treat a short unmarked bridge as an at-grade culvert if it crosses/straddles a narrow stream/ditch/drain
      for (const streamLine of narrowStreamLines) {
        if (polylinesCross2D(line, streamLine, false, 3.5)) {
          return true;
        }
      }

      return false;
    };

    const buildings: BuildingFeature[] = [];
    const roads: RoadFeature[] = [];
    const topologyRoadParts: UnchainedRoadPart[] = [];
    const railways: RailwayFeature[] = [];
    const topologyRailwayParts: UnchainedRailwayPart[] = [];
    const topologyInfrastructurePoints: InfrastructurePointMetadata[] = [];
    const waterBodies: WaterBodyFeature[] = [];
    const linearWaterways: LinearWaterwayFeature[] = [];
    const parks: ParkFeature[] = [];
    const landuse: LanduseFeature[] = [];
    const barriers: BarrierFeature[] = [];
    const landmarks: PointLandmarkFeature[] = [];

    // Topological node index for grouping and snapping endpoints with 0.15m tolerance
    const topoNodeIndex = new TopologicalNodeIndex(0.15);

    // Track road segment endpoints to filter and record duplicate/reverse overlapping ways in OSM
    const seenRoadSegments = new Map<string, string>(); // key -> canonical sourceFeatureId

    let featureIndex = 0;

    for (const f of rawFeatures) {
      featureIndex++;
      const geom = f.geometry;
      const geomType = geom?.type || 'Unknown';

      if (geomType in diagnostics.byGeometryType) {
        (diagnostics.byGeometryType as any)[geomType]++;
      } else {
        diagnostics.byGeometryType.Unknown++;
      }

      if (!geom || !geom.coordinates) {
        recordRejected('missing_geometry_or_coordinates', String(f.id || featureIndex));
        continue;
      }

      const props: RawGeoJsonProperties = { ...(f.properties || {}) };
      const rawExplicitId = props.id ?? f.id ?? props['@id'];
      const hasExplicitSourceId =
        rawExplicitId !== undefined &&
        rawExplicitId !== null &&
        String(rawExplicitId).trim() !== '';
      const id = hasExplicitSourceId ? String(rawExplicitId) : `feat-${featureIndex}`;
      props.id = id;

      const classification = classifyGeoJsonFeature(props, geomType);

      if (geomType === 'Point' || geomType === 'MultiPoint') {
        const infraPointKind = classifyInfrastructurePointKind(props);
        if (infraPointKind) {
          const rawPts = this.extractPoints(geom, coords);
          const retainedPts = shouldClipToRegion
            ? rawPts.filter(([x, z]) => Math.abs(x) <= clipExtent && Math.abs(z) <= clipExtent)
            : rawPts;
          for (let ptIdx = 0; ptIdx < retainedPts.length; ptIdx++) {
            const pointId = retainedPts.length === 1 ? id : `${id}-${ptIdx}`;
            const rawOsmNodeId =
              retainedPts.length === 1
                ? extractPointRawOsmNodeId(props, id, hasExplicitSourceId)
                : undefined;
            topologyInfrastructurePoints.push({
              id: pointId,
              hasExplicitSourceId,
              rawOsmNodeId,
              point: [retainedPts[ptIdx][0], retainedPts[ptIdx][1]],
              kind: infraPointKind,
              osmTags: cloneRawGeoJsonProperties(props),
            });
          }
        }
      }

      if (classification.category === 'unsupported') {
        recordSkipped(classification.primaryTag, id);
        continue;
      }

      diagnostics.sourceFeaturesClassified++;

      // A. Category: Railways & Aerialways
      if (classification.category === 'railway') {
        const rawLines = this.extractLineStrings(geom, coords);
        if (rawLines.length === 0) {
          recordRejected('degenerate_railway_linestring (< 2 points)', id);
          continue;
        }

        const railGradeScope = `${classification.layer}|${classification.isBridge}|${classification.isTunnel}`;
        const railwayType = (classification.subtype as RailwayType) || 'rail';
        const width = classification.defaultWidth || 4.8;
        const rawGauge =
          props.gauge !== undefined && props.gauge !== null && String(props.gauge).trim() !== ''
            ? String(props.gauge).trim()
            : undefined;
        const rawElectrified =
          props.electrified !== undefined &&
          props.electrified !== null &&
          String(props.electrified).trim() !== ''
            ? String(props.electrified).trim()
            : undefined;
        const rawService =
          props.service !== undefined &&
          props.service !== null &&
          String(props.service).trim() !== ''
            ? String(props.service).trim()
            : undefined;
        const rawUsage =
          props.usage !== undefined && props.usage !== null && String(props.usage).trim() !== ''
            ? String(props.usage).trim()
            : undefined;
        const isSecondaryBranch = isSecondaryRailwayBranch(rawService, rawUsage);

        const candidateLines: Array<{
          points: [number, number][];
          topologyOsmNodes?: Array<string | number | undefined>;
          legacyOsmNodes?: Array<string | number | undefined>;
          clippedAtStart?: boolean;
          clippedAtEnd?: boolean;
        }> = [];
        let wasFeatureClipped = false;

        for (let i = 0; i < rawLines.length; i++) {
          const partTopologyOsmNodes = extractVerifiedTopologyPartOsmNodeIds(
            props,
            i,
            rawLines.length,
            rawLines[i].length
          );
          const partLegacyOsmNodes = extractLegacyPartOsmNodeIds(
            props,
            i,
            rawLines.length,
            rawLines[i].length
          );
          if (shouldClipToRegion) {
            const clipped = clipPolylineToBox(
              rawLines[i],
              -clipExtent,
              -clipExtent,
              clipExtent,
              clipExtent,
              partTopologyOsmNodes
            );
            if (clipped.wasClipped) wasFeatureClipped = true;

            let legacyClippedNodes: Array<Array<string | number | undefined> | undefined> = [];
            if (partLegacyOsmNodes) {
              const legacyClipped = clipPolylineToBox(
                rawLines[i],
                -clipExtent,
                -clipExtent,
                clipExtent,
                clipExtent,
                partLegacyOsmNodes
              );
              legacyClippedNodes = legacyClipped.lines.map((l) => l.osmNodes);
            }

            for (let cIdx = 0; cIdx < clipped.lines.length; cIdx++) {
              const cl = clipped.lines[cIdx];
              candidateLines.push({
                points: cl.points,
                topologyOsmNodes: cl.osmNodes,
                legacyOsmNodes: legacyClippedNodes[cIdx],
                clippedAtStart: cl.clippedAtStart,
                clippedAtEnd: cl.clippedAtEnd,
              });
            }
          } else {
            candidateLines.push({
              points: rawLines[i],
              topologyOsmNodes: partTopologyOsmNodes,
              legacyOsmNodes: partLegacyOsmNodes,
              clippedAtStart: false,
              clippedAtEnd: false,
            });
          }
        }

        if (shouldClipToRegion && candidateLines.length === 0) {
          recordClipped(id, true);
          continue;
        }
        if (wasFeatureClipped) {
          recordClipped(id, false);
        }

        let addedAny = false;
        for (let partIdx = 0; partIdx < candidateLines.length; partIdx++) {
          const {
            points: line,
            topologyOsmNodes,
            legacyOsmNodes,
            clippedAtStart,
            clippedAtEnd,
          } = candidateLines[partIdx];
          if (line.length >= 2) {
            let totalLen = 0;
            for (let j = 0; j < line.length - 1; j++) {
              totalLen += Math.hypot(line[j + 1][0] - line[j][0], line[j + 1][1] - line[j][1]);
            }
            if (totalLen < 0.2) continue;

            topologyRailwayParts.push({
              id: `${id}-${partIdx}`,
              sourceFeatureId: id,
              hasExplicitSourceId,
              partIndex: partIdx,
              name: props.name,
              points: line.map((pt) => [pt[0], pt[1]] as [number, number]),
              rawOsmNodeIds: line.map((_, vIdx) =>
                topologyOsmNodes &&
                topologyOsmNodes[vIdx] !== undefined &&
                topologyOsmNodes[vIdx] !== null
                  ? String(topologyOsmNodes[vIdx])
                  : undefined
              ),
              clippedAtStart: Boolean(clippedAtStart),
              clippedAtEnd: Boolean(clippedAtEnd),
              railwayType,
              width,
              isBridge: classification.isBridge,
              isTunnel: classification.isTunnel,
              layer: classification.layer,
              gauge: rawGauge,
              electrified: rawElectrified,
              service: rawService,
              usage: rawUsage,
              isSecondaryBranch,
              osmTags: cloneRawGeoJsonProperties(props),
            });

            const nodeIds = topoNodeIndex.resolveWayNodeIds(
              line,
              railGradeScope,
              legacyOsmNodes as Array<string | number> | undefined
            );
            railways.push({
              id: `${id}-${partIdx}`,
              sourceFeatureId: id,
              sourceFeatureIds: [id],
              type: 'railway',
              name: props.name,
              points: line.map((pt) => [pt[0], pt[1]] as [number, number]),
              nodeIds,
              railwayType,
              width,
              isBridge: classification.isBridge,
              isTunnel: classification.isTunnel,
              layer: classification.layer,
              gauge: props.gauge ? parseFloat(String(props.gauge)) : undefined,
              electrified: Boolean(props.electrified && props.electrified !== 'no'),
              cartoLabel: classification.cartoLabel,
              primaryTag: classification.primaryTag,
              osmTags: cleanLegacyOsmTags(props),
            });
            diagnostics.parsedFeatureParts!.byCategory.railways++;
            diagnostics.parsedFeatureParts!.total++;
            if (diagnostics.featureLineage) {
              diagnostics.featureLineage.retainedCount++;
            }
            addedAny = true;
          }
        }

        if (addedAny) {
          diagnostics.parsedByCategory.railways++;
          diagnostics.totalFeaturesParsed++;
          recordCartoSubtype(classification.cartoLabel);
        } else {
          recordRejected('degenerate_railway_segment (< 2 points)', id);
        }
        continue;
      }

      // B. Category: Linear Waterways (rivers, streams, canals, drains)
      if (classification.category === 'water_line') {
        const rawLines = this.extractLineStrings(geom, coords);
        if (rawLines.length === 0) {
          recordRejected('degenerate_waterway_linestring (< 2 points)', id);
          continue;
        }

        const lines: [number, number][][] = [];
        let wasFeatureClipped = false;
        for (const rl of rawLines) {
          if (shouldClipToRegion) {
            const clipped = clipPolylineToBox(rl, -clipExtent, -clipExtent, clipExtent, clipExtent);
            if (clipped.wasClipped) wasFeatureClipped = true;
            for (const cl of clipped.lines) lines.push(cl.points);
          } else {
            lines.push(rl);
          }
        }

        if (shouldClipToRegion && lines.length === 0) {
          recordClipped(id, true);
          continue;
        }
        if (wasFeatureClipped) {
          recordClipped(id, false);
        }

        let addedAny = false;
        for (let partIdx = 0; partIdx < lines.length; partIdx++) {
          const line = lines[partIdx];
          if (line.length >= 2) {
            linearWaterways.push({
              id: `${id}-${partIdx}`,
              sourceFeatureId: id,
              type: 'waterway',
              name: props.name,
              points: line,
              waterwayType: (classification.subtype as WaterwayType) || 'river',
              width: classification.defaultWidth || 12.0,
              isBridge: classification.isBridge,
              isTunnel: classification.isTunnel,
              layer: classification.layer,
              intermittent: Boolean(props.intermittent && props.intermittent !== 'no'),
              cartoLabel: classification.cartoLabel,
              primaryTag: classification.primaryTag,
              osmTags: cleanLegacyOsmTags(props),
            });
            diagnostics.parsedFeatureParts!.byCategory.linearWaterways++;
            diagnostics.parsedFeatureParts!.total++;
            addedAny = true;
          }
        }

        if (addedAny) {
          diagnostics.parsedByCategory.linearWaterways++;
          diagnostics.totalFeaturesParsed++;
          recordCartoSubtype(classification.cartoLabel);
        } else {
          recordRejected('degenerate_waterway_segment (< 2 points)', id);
        }
        continue;
      }

      // C. Category: Polygonal Water Bodies
      if (classification.category === 'water_polygon') {
        const rawRings = this.extractPolygonRings(geom, coords);
        if (rawRings.length === 0) {
          recordRejected('degenerate_water_polygon (< 3 points)', id);
          continue;
        }

        const rings: [number, number][][][] = [];
        let wasFeatureClipped = false;
        for (const rr of rawRings) {
          if (shouldClipToRegion) {
            const clipped = clipPolygonRingsToBox(rr, -clipExtent, -clipExtent, clipExtent, clipExtent);
            if (clipped.wasClipped) wasFeatureClipped = true;
            rings.push(...clipped.polygons);
          } else {
            rings.push(rr);
          }
        }

        if (shouldClipToRegion && rings.length === 0) {
          recordClipped(id, true);
          continue;
        }
        if (wasFeatureClipped) {
          recordClipped(id, false);
        }

        let addedAny = false;
        for (let partIdx = 0; partIdx < rings.length; partIdx++) {
          const ring = rings[partIdx];
          if (ring.length > 0 && ring[0].length >= 3) {
            waterBodies.push({
              id: `${id}-${partIdx}`,
              sourceFeatureId: id,
              type: 'water',
              name: props.name,
              polygon: ring,
              waterType: (classification.subtype as WaterBodyType) || 'water',
              isBridge: classification.isBridge,
              isTunnel: classification.isTunnel,
              layer: classification.layer,
              intermittent: Boolean(props.intermittent && props.intermittent !== 'no'),
              cartoLabel: classification.cartoLabel,
              primaryTag: classification.primaryTag,
              osmTags: cleanLegacyOsmTags(props),
            });
            diagnostics.parsedFeatureParts!.byCategory.waterBodies++;
            diagnostics.parsedFeatureParts!.total++;
            addedAny = true;
          }
        }

        if (addedAny) {
          diagnostics.parsedByCategory.waterBodies++;
          diagnostics.totalFeaturesParsed++;
          recordCartoSubtype(classification.cartoLabel);
        } else {
          recordRejected('degenerate_water_ring (< 3 points)', id);
        }
        continue;
      }

      // D. Category: Parks, Forests, Wetlands, Nature & Sports Areas
      if (classification.category === 'park') {
        const rawRings = this.extractPolygonRings(geom, coords);
        if (rawRings.length === 0) {
          recordRejected('degenerate_park_polygon (< 3 points)', id);
          continue;
        }

        const rings: [number, number][][][] = [];
        let wasFeatureClipped = false;
        for (const rr of rawRings) {
          if (shouldClipToRegion) {
            const clipped = clipPolygonRingsToBox(rr, -clipExtent, -clipExtent, clipExtent, clipExtent);
            if (clipped.wasClipped) wasFeatureClipped = true;
            rings.push(...clipped.polygons);
          } else {
            rings.push(rr);
          }
        }

        if (shouldClipToRegion && rings.length === 0) {
          recordClipped(id, true);
          continue;
        }
        if (wasFeatureClipped) {
          recordClipped(id, false);
        }

        let addedAny = false;
        for (let partIdx = 0; partIdx < rings.length; partIdx++) {
          const ring = rings[partIdx];
          if (ring.length > 0 && ring[0].length >= 3) {
            parks.push({
              id: `${id}-${partIdx}`,
              sourceFeatureId: id,
              type: 'park',
              name: props.name,
              polygon: ring,
              subtype: classification.subtype || 'park',
              has3DFoliage: classification.has3DFoliage,
              leafType: classification.leafType,
              cartoLabel: classification.cartoLabel,
              primaryTag: classification.primaryTag,
              osmTags: cleanLegacyOsmTags(props),
            });
            diagnostics.parsedFeatureParts!.byCategory.parks++;
            diagnostics.parsedFeatureParts!.total++;
            addedAny = true;
          }
        }

        if (addedAny) {
          diagnostics.parsedByCategory.parks++;
          diagnostics.totalFeaturesParsed++;
          recordCartoSubtype(classification.cartoLabel);
        } else {
          recordRejected('degenerate_park_ring (< 3 points)', id);
        }
        continue;
      }

      // E. Category: Buildings
      if (classification.category === 'building') {
        if (hasNonFiniteCoordinates(geom.coordinates)) {
          recordRejected('invalid_non_finite_building_coordinates', id);
          continue;
        }

        const rawRings = this.extractPolygonRings(geom, coords);
        if (rawRings.length === 0) {
          recordRejected('degenerate_building_polygon (< 3 points)', id);
          continue;
        }

        const validRawRings: [number, number][][][] = [];
        let lastRejectionReason = 'degenerate_building_polygon (< 3 points or zero area)';
        for (const polyRings of rawRings) {
          const outer = polyRings[0];
          if (!outer || outer.length < 3 || computeRingArea2D(outer) < 0.05) {
            lastRejectionReason = 'degenerate_building_polygon (< 3 points or zero area)';
            continue;
          }
          if (hasPolygonRingSelfIntersection(outer)) {
            lastRejectionReason = 'invalid_self_intersecting_building_polygon';
            continue;
          }
          const validHoles: [number, number][][] = [];
          for (let h = 1; h < polyRings.length; h++) {
            const hole = polyRings[h];
            if (
              hole &&
              hole.length >= 3 &&
              !hasPolygonRingSelfIntersection(hole) &&
              computeRingArea2D(hole) >= 0.02
            ) {
              validHoles.push(hole);
            }
          }
          validRawRings.push([outer, ...validHoles]);
        }

        if (validRawRings.length === 0) {
          recordRejected(lastRejectionReason, id);
          continue;
        }

        const rings: [number, number][][][] = [];
        let wasFeatureClipped = false;
        for (const rr of validRawRings) {
          if (shouldClipToRegion) {
            const clipped = clipPolygonRingsToBox(
              rr,
              -clipExtent,
              -clipExtent,
              clipExtent,
              clipExtent
            );
            if (clipped.wasClipped) wasFeatureClipped = true;
            rings.push(...clipped.polygons);
          } else {
            rings.push(rr);
          }
        }

        if (shouldClipToRegion && rings.length === 0) {
          recordClipped(id, true);
          continue;
        }
        if (wasFeatureClipped) {
          recordClipped(id, false);
        }

        const height = this.parseHeight(props);
        const minHeight = this.parseMinHeight(props);
        const levels = this.parseLevels(props);

        let addedAny = false;
        for (let partIdx = 0; partIdx < rings.length; partIdx++) {
          const ring = rings[partIdx];
          if (ring.length > 0 && ring[0].length >= 3 && computeRingArea2D(ring[0]) >= 0.05) {
            buildings.push({
              id: `${id}-${partIdx}`,
              sourceFeatureId: id,
              type: 'building',
              name: props.name,
              footprint: ring,
              height: Math.max(height, 2.5),
              minHeight,
              levels,
              buildingType: String(props.building || classification.subtype || 'yes'),
              buildingArchetype: classification.buildingArchetype,
              isRoofOnly: classification.isRoofOnly,
              amenity: props.amenity ? String(props.amenity) : undefined,
              cartoLabel: classification.cartoLabel,
              primaryTag: classification.primaryTag,
              osmTags: cleanLegacyOsmTags(props),
            });
            diagnostics.parsedFeatureParts!.byCategory.buildings++;
            diagnostics.parsedFeatureParts!.total++;
            addedAny = true;
          }
        }

        if (addedAny) {
          diagnostics.parsedByCategory.buildings++;
          diagnostics.totalFeaturesParsed++;
          recordCartoSubtype(classification.cartoLabel);
        } else {
          recordRejected('degenerate_building_ring (< 3 points)', id);
        }
        continue;
      }

      // F. Category: Roads, Ways & Linear Infrastructure
      if (classification.category === 'road') {
        const rawLines = this.extractLineStrings(geom, coords);
        if (rawLines.length === 0) {
          recordRejected('degenerate_road_linestring (< 2 points)', id);
          continue;
        }

        const roadClass = (classification.subtype as RoadClass) || 'residential';
        const width = classification.defaultWidth || this.getRoadWidth(roadClass, props);

        const candidateLines: Array<{
          points: [number, number][];
          topologyOsmNodes?: Array<string | number | undefined>;
          legacyOsmNodes?: Array<string | number | undefined>;
          clippedAtStart?: boolean;
          clippedAtEnd?: boolean;
        }> = [];
        let wasFeatureClipped = false;

        for (let i = 0; i < rawLines.length; i++) {
          const partTopologyOsmNodes = extractVerifiedTopologyPartOsmNodeIds(
            props,
            i,
            rawLines.length,
            rawLines[i].length
          );
          const partLegacyOsmNodes = extractLegacyPartOsmNodeIds(
            props,
            i,
            rawLines.length,
            rawLines[i].length
          );
          if (shouldClipToRegion) {
            const clipped = clipPolylineToBox(
              rawLines[i],
              -clipExtent,
              -clipExtent,
              clipExtent,
              clipExtent,
              partTopologyOsmNodes
            );
            if (clipped.wasClipped) wasFeatureClipped = true;

            let legacyClippedNodes: Array<Array<string | number | undefined> | undefined> = [];
            if (partLegacyOsmNodes) {
              const legacyClipped = clipPolylineToBox(
                rawLines[i],
                -clipExtent,
                -clipExtent,
                clipExtent,
                clipExtent,
                partLegacyOsmNodes
              );
              legacyClippedNodes = legacyClipped.lines.map((l) => l.osmNodes);
            }

            for (let cIdx = 0; cIdx < clipped.lines.length; cIdx++) {
              const cl = clipped.lines[cIdx];
              candidateLines.push({
                points: cl.points,
                topologyOsmNodes: cl.osmNodes,
                legacyOsmNodes: legacyClippedNodes[cIdx],
                clippedAtStart: cl.clippedAtStart,
                clippedAtEnd: cl.clippedAtEnd,
              });
            }
          } else {
            candidateLines.push({
              points: rawLines[i],
              topologyOsmNodes: partTopologyOsmNodes,
              legacyOsmNodes: partLegacyOsmNodes,
              clippedAtStart: false,
              clippedAtEnd: false,
            });
          }
        }

        if (shouldClipToRegion && candidateLines.length === 0) {
          recordClipped(id, true);
          continue;
        }
        if (wasFeatureClipped) {
          recordClipped(id, false);
        }

        let addedAny = false;
        for (let partIdx = 0; partIdx < candidateLines.length; partIdx++) {
          const {
            points: line,
            topologyOsmNodes,
            legacyOsmNodes,
            clippedAtStart,
            clippedAtEnd,
          } = candidateLines[partIdx];
          if (line.length >= 2) {
            let totalLen = 0;
            for (let j = 0; j < line.length - 1; j++) {
              totalLen += Math.hypot(line[j + 1][0] - line[j][0], line[j + 1][1] - line[j][1]);
            }
            const isShortCulvert = isAtGradeCulvertSpan(
              id,
              props,
              classification,
              line,
              totalLen
            );
            const effectiveIsBridge = isShortCulvert ? false : classification.isBridge;
            const effectiveIsTunnel = isShortCulvert ? false : classification.isTunnel;
            const effectiveLayer = isShortCulvert ? 0 : classification.layer;
            const partGradeScope = `${effectiveLayer}|${effectiveIsBridge}|${effectiveIsTunnel}`;

            // Capture unchained, undeduplicated road part for M2.3 topology construction
            // before legacy heuristic seenRoadSegments deduplication and before chainContiguousRoads.
            topologyRoadParts.push({
              id: `${id}-${partIdx}`,
              sourceFeatureId: id,
              hasExplicitSourceId,
              partIndex: partIdx,
              name: props.name,
              points: line.map((pt) => [pt[0], pt[1]] as [number, number]),
              rawOsmNodeIds: line.map((_, vIdx) =>
                topologyOsmNodes &&
                topologyOsmNodes[vIdx] !== undefined &&
                topologyOsmNodes[vIdx] !== null
                  ? String(topologyOsmNodes[vIdx])
                  : undefined
              ),
              clippedAtStart: Boolean(clippedAtStart),
              clippedAtEnd: Boolean(clippedAtEnd),
              roadClass,
              width,
              isBridge: effectiveIsBridge,
              isTunnel: effectiveIsTunnel,
              isCulvert: isShortCulvert,
              layer: effectiveLayer,
              osmTags: cloneRawGeoJsonProperties(props),
            });

            const nodeIds = topoNodeIndex.resolveWayNodeIds(
              line,
              partGradeScope,
              legacyOsmNodes as Array<string | number> | undefined
            );

            const p0 = line[0];
            const pn = line[line.length - 1];
            let sumX = 0;
            let sumZ = 0;
            for (let j = 0; j < line.length; j++) {
              sumX += line[j][0];
              sumZ += line[j][1];
            }
            const midKey = `${Math.round((sumX / line.length) * 2)},${Math.round((sumZ / line.length) * 2)}`;

            const lenKey = Math.round(totalLen * 2); // 0.5m resolution
            const k1 = `${partGradeScope}_${Math.round(p0[0] * 2)},${Math.round(p0[1] * 2)}_${midKey}_${Math.round(pn[0] * 2)},${Math.round(pn[1] * 2)}_${lenKey}_${roadClass}`;
            const k2 = `${partGradeScope}_${Math.round(pn[0] * 2)},${Math.round(pn[1] * 2)}_${midKey}_${Math.round(p0[0] * 2)},${Math.round(p0[1] * 2)}_${lenKey}_${roadClass}`;

            if (seenRoadSegments.has(k1) || seenRoadSegments.has(k2)) {
              const canonicalId = (seenRoadSegments.get(k1) || seenRoadSegments.get(k2))!;
              if (diagnostics.featureLineage) {
                if (!diagnostics.featureLineage.deduplicatedMap[canonicalId]) {
                  diagnostics.featureLineage.deduplicatedMap[canonicalId] = [];
                }
                diagnostics.featureLineage.deduplicatedMap[canonicalId].push(id);
                diagnostics.featureLineage.deduplicatedCount++;
              }
              addedAny = true;
              continue;
            }
            seenRoadSegments.set(k1, id);
            seenRoadSegments.set(k2, id);

            roads.push({
              id: `${id}-${partIdx}`,
              sourceFeatureId: id,
              sourceFeatureIds: [id],
              type: 'road',
              name: props.name,
              points: line.map((pt) => [pt[0], pt[1]] as [number, number]),
              nodeIds,
              roadClass,
              subtype: classification.subtype,
              width,
              isBridge: effectiveIsBridge,
              isTunnel: effectiveIsTunnel,
              layer: effectiveLayer,
              cartoLabel: classification.cartoLabel,
              primaryTag: classification.primaryTag,
              osmTags: cleanLegacyOsmTags(props),
            });
            diagnostics.parsedFeatureParts!.byCategory.roads++;
            diagnostics.parsedFeatureParts!.total++;
            if (diagnostics.featureLineage) {
              diagnostics.featureLineage.retainedCount++;
            }
            addedAny = true;
          }
        }

        if (addedAny) {
          diagnostics.parsedByCategory.roads++;
          diagnostics.totalFeaturesParsed++;
          recordCartoSubtype(classification.cartoLabel);
        } else {
          recordRejected('degenerate_road_segment (< 2 points)', id);
        }
        continue;
      }

      // G. Category: Landuse, Agriculture, Civic & Transport Areas
      if (classification.category === 'landuse') {
        const rawRings = this.extractPolygonRings(geom, coords);
        if (rawRings.length === 0) {
          recordRejected('degenerate_landuse_polygon (< 3 points)', id);
          continue;
        }

        const rings: [number, number][][][] = [];
        let wasFeatureClipped = false;
        for (const rr of rawRings) {
          if (shouldClipToRegion) {
            const clipped = clipPolygonRingsToBox(rr, -clipExtent, -clipExtent, clipExtent, clipExtent);
            if (clipped.wasClipped) wasFeatureClipped = true;
            rings.push(...clipped.polygons);
          } else {
            rings.push(rr);
          }
        }

        if (shouldClipToRegion && rings.length === 0) {
          recordClipped(id, true);
          continue;
        }
        if (wasFeatureClipped) {
          recordClipped(id, false);
        }

        let addedAny = false;
        for (let partIdx = 0; partIdx < rings.length; partIdx++) {
          const ring = rings[partIdx];
          if (ring.length > 0 && ring[0].length >= 3) {
            landuse.push({
              id: `${id}-${partIdx}`,
              sourceFeatureId: id,
              type: 'landuse',
              name: props.name,
              polygon: ring,
              landuseType: (classification.subtype as LanduseType) || 'landuse',
              subtype: classification.subtype,
              cartoLabel: classification.cartoLabel,
              primaryTag: classification.primaryTag,
              osmTags: cleanLegacyOsmTags(props),
            });
            diagnostics.parsedFeatureParts!.byCategory.landuse++;
            diagnostics.parsedFeatureParts!.total++;
            addedAny = true;
          }
        }

        if (addedAny) {
          diagnostics.parsedByCategory.landuse++;
          diagnostics.totalFeaturesParsed++;
          recordCartoSubtype(classification.cartoLabel);
        } else {
          recordRejected('degenerate_landuse_ring (< 3 points)', id);
        }
        continue;
      }

      // H. Category: Linear Barriers, Walls, Hedges & Tree Rows
      if (classification.category === 'barrier') {
        const rawLines = this.extractLineStrings(geom, coords);
        if (rawLines.length === 0) {
          recordRejected('degenerate_barrier_linestring (< 2 points)', id);
          continue;
        }

        const lines: [number, number][][] = [];
        let wasFeatureClipped = false;
        for (const rl of rawLines) {
          if (shouldClipToRegion) {
            const clipped = clipPolylineToBox(rl, -clipExtent, -clipExtent, clipExtent, clipExtent);
            if (clipped.wasClipped) wasFeatureClipped = true;
            for (const cl of clipped.lines) lines.push(cl.points);
          } else {
            lines.push(rl);
          }
        }

        if (shouldClipToRegion && lines.length === 0) {
          recordClipped(id, true);
          continue;
        }
        if (wasFeatureClipped) {
          recordClipped(id, false);
        }

        let addedAny = false;
        for (let partIdx = 0; partIdx < lines.length; partIdx++) {
          const line = lines[partIdx];
          if (line.length >= 2) {
            barriers.push({
              id: `${id}-${partIdx}`,
              sourceFeatureId: id,
              type: 'barrier',
              name: props.name,
              points: line,
              barrierType: (classification.subtype as BarrierType) || 'wall',
              width: classification.defaultWidth || 0.5,
              height: classification.defaultHeight || 1.6,
              cartoLabel: classification.cartoLabel,
              primaryTag: classification.primaryTag,
              osmTags: cleanLegacyOsmTags(props),
            });
            diagnostics.parsedFeatureParts!.byCategory.barriers =
              (diagnostics.parsedFeatureParts!.byCategory.barriers || 0) + 1;
            diagnostics.parsedFeatureParts!.total++;
            addedAny = true;
          }
        }

        if (addedAny) {
          diagnostics.parsedByCategory.barriers = (diagnostics.parsedByCategory.barriers || 0) + 1;
          diagnostics.totalFeaturesParsed++;
          recordCartoSubtype(classification.cartoLabel);
        } else {
          recordRejected('degenerate_barrier_segment (< 2 points)', id);
        }
        continue;
      }

      // I. Category: 3D Point Landmarks, Trees & POIs
      if (classification.category === 'landmark') {
        const rawPts = this.extractPoints(geom, coords);
        if (rawPts.length === 0) {
          recordRejected('degenerate_point_coordinates', id);
          continue;
        }

        const points = shouldClipToRegion
          ? rawPts.filter(([x, z]) => Math.abs(x) <= clipExtent && Math.abs(z) <= clipExtent)
          : rawPts;

        if (shouldClipToRegion && points.length === 0) {
          recordClipped(id, true);
          continue;
        }

        const customHeight = props.height ? parseFloat(String(props.height)) : undefined;
        const height =
          customHeight && !isNaN(customHeight) && customHeight > 0
            ? customHeight
            : classification.defaultHeight || 8.0;

        let addedAny = false;
        for (let partIdx = 0; partIdx < points.length; partIdx++) {
          landmarks.push({
            id: `${id}-${partIdx}`,
            sourceFeatureId: id,
            type: 'landmark',
            name: props.name,
            position: points[partIdx],
            landmarkType: (classification.subtype as LandmarkType) || 'poi',
            height,
            leafType: classification.leafType,
            cartoLabel: classification.cartoLabel,
            primaryTag: classification.primaryTag,
            osmTags: cleanLegacyOsmTags(props),
          });
          diagnostics.parsedFeatureParts!.byCategory.landmarks =
            (diagnostics.parsedFeatureParts!.byCategory.landmarks || 0) + 1;
          diagnostics.parsedFeatureParts!.total++;
          addedAny = true;
        }

        if (addedAny) {
          diagnostics.parsedByCategory.landmarks = (diagnostics.parsedByCategory.landmarks || 0) + 1;
          diagnostics.totalFeaturesParsed++;
          recordCartoSubtype(classification.cartoLabel);
        }
        continue;
      }
    }

    // Canonicalize all way nodeIds in case a coordinate-only way was registered before an explicit-node way at the same point
    for (const r of roads) {
      if (r.nodeIds) {
        r.nodeIds = r.nodeIds.map((nid) => topoNodeIndex.resolveCanonicalNodeId(String(nid)));
      }
    }
    for (const rw of railways) {
      if (rw.nodeIds) {
        rw.nodeIds = rw.nodeIds.map((nid) => topoNodeIndex.resolveCanonicalNodeId(String(nid)));
      }
    }

    // Chain contiguous road segments that belong to the same roadway before generating geometries.
    const chainedRoads = this.chainContiguousRoads(roads, diagnostics);

    // Metric bounds computed directly from the retained/clipped features so bounds, ground plane,
    // rendered 3D geometry, and camera framing match 100%.
    let minX = Infinity,
      maxX = -Infinity;
    let minZ = Infinity,
      maxZ = -Infinity;

    const updateBounds = (x: number, z: number) => {
      if (Number.isFinite(x) && Number.isFinite(z)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    };

    for (const b of buildings) {
      for (const ring of b.footprint) {
        for (const pt of ring) updateBounds(pt[0], pt[1]);
      }
    }
    for (const r of chainedRoads) {
      for (const pt of r.points) updateBounds(pt[0], pt[1]);
    }
    for (const r of railways) {
      for (const pt of r.points) updateBounds(pt[0], pt[1]);
    }
    for (const w of waterBodies) {
      for (const ring of w.polygon) {
        for (const pt of ring) updateBounds(pt[0], pt[1]);
      }
    }
    for (const lw of linearWaterways) {
      for (const pt of lw.points) updateBounds(pt[0], pt[1]);
    }
    for (const p of parks) {
      for (const ring of p.polygon) {
        for (const pt of ring) updateBounds(pt[0], pt[1]);
      }
    }
    for (const l of landuse) {
      for (const ring of l.polygon) {
        for (const pt of ring) updateBounds(pt[0], pt[1]);
      }
    }
    for (const bar of barriers) {
      for (const pt of bar.points) updateBounds(pt[0], pt[1]);
    }
    for (const lm of landmarks) {
      updateBounds(lm.position[0], lm.position[1]);
    }

    if (!Number.isFinite(minX)) {
      if (shouldClipToRegion) {
        minX = -clipExtent;
        maxX = clipExtent;
        minZ = -clipExtent;
        maxZ = clipExtent;
      } else {
        const [mX, mZ2] = coords.toLocal(minLon, minLat);
        const [mX2, mZ] = coords.toLocal(maxLon, maxLat);
        minX = Math.min(mX, mX2);
        maxX = Math.max(mX, mX2);
        minZ = Math.min(mZ, mZ2);
        maxZ = Math.max(mZ, mZ2);
      }
    }

    const widthMeters = Math.max(Math.abs(maxX - minX), 50);
    const depthMeters = Math.max(Math.abs(maxZ - minZ), 50);

    const topologySource: TopologySourceData = {
      roadParts: topologyRoadParts,
      railwayParts: topologyRailwayParts,
      infrastructurePoints: topologyInfrastructurePoints,
    };

    return {
      regionName: explicitRegionName || geojson.name || 'OpenStreetMap Region',
      centerLonLat: [centerLon, centerLat],
      bounds: {
        minX,
        maxX,
        minZ,
        maxZ,
        widthMeters,
        depthMeters,
      },
      buildings,
      roads: chainedRoads,
      railways,
      waterBodies,
      linearWaterways,
      water: waterBodies, // for backward compatibility
      parks,
      landuse,
      barriers,
      landmarks,
      diagnostics,
      topologySource,
      stats: {
        totalBuildings: buildings.length,
        totalRoads: chainedRoads.length,
        totalRoadSegments: chainedRoads.reduce((sum, r) => sum + r.points.length - 1, 0),
        totalRailways: railways.length,
        totalRailwaySegments: railways.reduce((sum, r) => sum + r.points.length - 1, 0),
        totalWaterPolygons: waterBodies.length,
        totalLinearWaterways: linearWaterways.length,
        totalParkPolygons: parks.length,
        totalLandusePolygons: landuse.length,
        totalBarriers: barriers.length,
        totalLandmarks: landmarks.length,
        areaKm2: (widthMeters * depthMeters) / 1000000,
      },
    };
  }

  private traverseCoordinates(coords: any, cb: (lon: number, lat: number) => void) {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      cb(coords[0], coords[1]);
    } else {
      for (const item of coords) {
        this.traverseCoordinates(item, cb);
      }
    }
  }

  private extractPoints(geom: any, coords: WorldCoordinates): [number, number][] {
    const result: [number, number][] = [];
    if (geom.type === 'Point') {
      if (Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
        const [lon, lat] = geom.coordinates;
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
          result.push(coords.toLocal(lon, lat));
        }
      }
    } else if (geom.type === 'MultiPoint') {
      for (const pt of geom.coordinates) {
        if (Array.isArray(pt) && pt.length >= 2) {
          const [lon, lat] = pt;
          if (Number.isFinite(lon) && Number.isFinite(lat)) {
            result.push(coords.toLocal(lon, lat));
          }
        }
      }
    } else if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
      for (const g of geom.geometries) {
        result.push(...this.extractPoints(g, coords));
      }
    }
    return result;
  }

  private extractPolygonRings(geom: any, coords: WorldCoordinates): [number, number][][][] {
    const result: [number, number][][][] = [];

    if (geom.type === 'Polygon') {
      const rings: [number, number][][] = [];
      for (const ring of geom.coordinates) {
        if (Array.isArray(ring) && ring.length >= 3) {
          rings.push(coords.transformRing(ring as [number, number][]));
        }
      }
      if (rings.length > 0 && rings[0].length >= 3) {
        result.push(rings);
      }
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        const rings: [number, number][][] = [];
        for (const ring of poly) {
          if (Array.isArray(ring) && ring.length >= 3) {
            rings.push(coords.transformRing(ring as [number, number][]));
          }
        }
        if (rings.length > 0 && rings[0].length >= 3) {
          result.push(rings);
        }
      }
    } else if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
      for (const g of geom.geometries) {
        result.push(...this.extractPolygonRings(g, coords));
      }
    }

    return result;
  }

  private extractLineStrings(geom: any, coords: WorldCoordinates): [number, number][][] {
    const result: [number, number][][] = [];

    if (geom.type === 'LineString') {
      if (Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
        result.push(coords.transformLine(geom.coordinates as [number, number][]));
      }
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates) {
        if (Array.isArray(line) && line.length >= 2) {
          result.push(coords.transformLine(line as [number, number][]));
        }
      }
    } else if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
      for (const g of geom.geometries) {
        result.push(...this.extractLineStrings(g, coords));
      }
    }

    return result;
  }

  private parseHeight(props: RawGeoJsonProperties): number {
    if (props.height) {
      const parsed = parseFloat(String(props.height));
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }

    const levels = this.parseLevels(props);
    if (levels) {
      return levels * this.levelHeightMeters;
    }

    const bType = String(props.building || props.man_made || props.historic || props.aeroway || '').toLowerCase();
    switch (bType) {
      case 'cathedral':
      case 'church':
      case 'mosque':
      case 'temple':
      case 'synagogue':
        return 28.0;
      case 'tower':
      case 'communications_tower':
      case 'water_tower':
      case 'chimney':
        return 45.0;
      case 'windmill':
      case 'lighthouse':
        return 24.0;
      case 'castle':
      case 'palace':
      case 'fort':
        return 20.0;
      case 'commercial':
      case 'office':
      case 'hotel':
        return 22.0;
      case 'apartments':
      case 'dormitory':
      case 'hospital':
      case 'university':
        return 18.0;
      case 'train_station':
      case 'terminal':
      case 'transportation':
      case 'public':
      case 'civic':
      case 'school':
      case 'college':
      case 'retail':
      case 'supermarket':
      case 'industrial':
      case 'warehouse':
      case 'hangar':
      case 'silo':
        return 13.0;
      case 'house':
      case 'detached':
      case 'semidetached_house':
      case 'terrace':
      case 'residential':
      case 'farm':
      case 'barn':
      case 'storage_tank':
        return 8.0;
      case 'bungalow':
      case 'cabin':
      case 'kiosk':
      case 'greenhouse':
      case 'bunker':
        return 4.8;
      case 'garage':
      case 'garages':
      case 'carport':
      case 'shed':
      case 'hut':
      case 'roof':
        return 4.0;
      default:
        return this.defaultBuildingHeight;
    }
  }

  private parseMinHeight(props: RawGeoJsonProperties): number {
    if (props.min_height) {
      const parsed = parseFloat(String(props.min_height));
      if (!isNaN(parsed) && parsed >= 0) return parsed;
    }
    if (props['building:min_level']) {
      const minLevel = parseInt(String(props['building:min_level']), 10);
      if (!isNaN(minLevel) && minLevel > 0) {
        return minLevel * this.levelHeightMeters;
      }
    }
    return 0;
  }

  private parseLevels(props: RawGeoJsonProperties): number | undefined {
    if (props['building:levels']) {
      const parsed = parseInt(String(props['building:levels']), 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return undefined;
  }

  private getRoadWidth(roadClass: RoadClass, props: RawGeoJsonProperties): number {
    const hw = String(props.highway || '').toLowerCase();
    const isLink = hw.endsWith('_link');
    const isOneWay =
      props.oneway === 'yes' ||
      props.oneway === '1' ||
      props.oneway === '-1' ||
      props.junction === 'roundabout';

    const base = ROAD_CLASS_WIDTHS[roadClass] || 5.4;

    if (isLink) {
      return Math.min(Math.max(base * 0.55, 3.6), 5.0);
    }

    // Subordinated service ways (driveways, parking aisles) are narrower
    if (roadClass === 'service' && (props.service === 'parking_aisle' || props.service === 'driveway')) {
      return 3.0;
    }

    const nominal = isOneWay ? Math.max(base * 0.62, 3.6) : base;

    if (props.width) {
      const parsed = parseFloat(String(props.width));
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return nominal;
  }

  /**
   * Chains contiguous road segments belonging to the same physical roadway.
   */
  private chainContiguousRoads(
    roads: RoadFeature[],
    diagnostics?: MapFeatureDiagnostics
  ): RoadFeature[] {
    if (roads.length <= 1) return roads;

    const getNodeKey = (road: RoadFeature, endpoint: 'start' | 'end'): string => {
      if (road.nodeIds && road.nodeIds.length > 0) {
        return String(
          endpoint === 'start'
            ? road.nodeIds[0]
            : road.nodeIds[road.nodeIds.length - 1]
        );
      }
      const pt = endpoint === 'start' ? road.points[0] : road.points[road.points.length - 1];
      return `${Math.round(pt[0] * 10)},${Math.round(pt[1] * 10)}`;
    };

    const getPtNodeKey = (road: RoadFeature, idx: number): string => {
      if (road.nodeIds && road.nodeIds[idx] !== undefined) {
        return String(road.nodeIds[idx]);
      }
      const pt = road.points[idx];
      return `${Math.round(pt[0] * 10)},${Math.round(pt[1] * 10)}`;
    };

    // Compute global node usage across ALL roads in the same elevation/structure layer
    // so main roads are never chained straight through a cross-street or T-junction.
    const globalNodeDegree = new Map<string, number>();
    for (const r of roads) {
      const layerPrefix = `${r.layer}|${r.isBridge}|${r.isTunnel}|`;
      for (let idx = 0; idx < r.points.length; idx++) {
        const k = `${layerPrefix}${getPtNodeKey(r, idx)}`;
        globalNodeDegree.set(k, (globalNodeDegree.get(k) || 0) + 1);
      }
    }

    const groups = new Map<string, RoadFeature[]>();
    for (const r of roads) {
      const nameKey = (r.name || '').trim().toLowerCase();
      const groupKey = `${r.roadClass}|${r.layer}|${r.isBridge}|${r.isTunnel}|${nameKey}|${Math.round(r.width * 10)}`;
      let grp = groups.get(groupKey);
      if (!grp) {
        grp = [];
        groups.set(groupKey, grp);
      }
      grp.push(r);
    }

    const chainedResult: RoadFeature[] = [];

    for (const [_, groupRoads] of groups) {
      if (groupRoads.length <= 1) {
        chainedResult.push(...groupRoads);
        continue;
      }

      const endpointDegree = new Map<string, number>();
      for (const r of groupRoads) {
        const layerPrefix = `${r.layer}|${r.isBridge}|${r.isTunnel}|`;
        const kStart = getNodeKey(r, 'start');
        const kEnd = getNodeKey(r, 'end');
        endpointDegree.set(kStart, globalNodeDegree.get(`${layerPrefix}${kStart}`) || 1);
        endpointDegree.set(kEnd, globalNodeDegree.get(`${layerPrefix}${kEnd}`) || 1);
      }

      const pool = [...groupRoads];
      const mergedInGroup: RoadFeature[] = [];

      while (pool.length > 0) {
        let current = pool.shift()!;
        if (!current.sourceFeatureIds) {
          current.sourceFeatureIds = current.sourceFeatureId ? [current.sourceFeatureId] : [current.id];
        }

        let extended = true;

        while (extended) {
          extended = false;
          const curStart = current.points[0];
          const curEnd = current.points[current.points.length - 1];
          const curStartKey = getNodeKey(current, 'start');
          const curEndKey = getNodeKey(current, 'end');

          for (let i = 0; i < pool.length; i++) {
            const other = pool[i];
            if (!other.sourceFeatureIds) {
              other.sourceFeatureIds = other.sourceFeatureId ? [other.sourceFeatureId] : [other.id];
            }

            const otherStart = other.points[0];
            const otherEnd = other.points[other.points.length - 1];
            const otherStartKey = getNodeKey(other, 'start');
            const otherEndKey = getNodeKey(other, 'end');
            const bothHaveNodeIds = Boolean(
              current.nodeIds &&
                current.nodeIds.length > 0 &&
                other.nodeIds &&
                other.nodeIds.length > 0
            );

            if (
              curEndKey === otherStartKey ||
              (!bothHaveNodeIds &&
                Math.hypot(curEnd[0] - otherStart[0], curEnd[1] - otherStart[1]) < 0.20)
            ) {
              if ((endpointDegree.get(curEndKey) || 0) <= 2) {
                current.points = [...current.points, ...other.points.slice(1)];
                if (current.nodeIds && other.nodeIds) {
                  current.nodeIds = [...current.nodeIds, ...other.nodeIds.slice(1)];
                }
                current.sourceFeatureIds = [...current.sourceFeatureIds, ...other.sourceFeatureIds];
                current.id = `${current.id}+${other.id}`;
                pool.splice(i, 1);
                extended = true;
                break;
              }
            }

            if (
              otherEndKey === curStartKey ||
              (!bothHaveNodeIds &&
                Math.hypot(otherEnd[0] - curStart[0], otherEnd[1] - curStart[1]) < 0.20)
            ) {
              if ((endpointDegree.get(curStartKey) || 0) <= 2) {
                current.points = [...other.points, ...current.points.slice(1)];
                if (current.nodeIds && other.nodeIds) {
                  current.nodeIds = [...other.nodeIds, ...current.nodeIds.slice(1)];
                }
                current.sourceFeatureIds = [...other.sourceFeatureIds, ...current.sourceFeatureIds];
                current.id = `${other.id}+${current.id}`;
                pool.splice(i, 1);
                extended = true;
                break;
              }
            }

            if (
              curEndKey === otherEndKey ||
              (!bothHaveNodeIds &&
                Math.hypot(curEnd[0] - otherEnd[0], curEnd[1] - otherEnd[1]) < 0.20)
            ) {
              if ((endpointDegree.get(curEndKey) || 0) <= 2) {
                const reversedPoints = [...other.points].reverse();
                current.points = [...current.points, ...reversedPoints.slice(1)];
                if (current.nodeIds && other.nodeIds) {
                  const reversedNodeIds = [...other.nodeIds].reverse();
                  current.nodeIds = [...current.nodeIds, ...reversedNodeIds.slice(1)];
                }
                current.sourceFeatureIds = [...current.sourceFeatureIds, ...other.sourceFeatureIds];
                current.id = `${current.id}+${other.id}`;
                pool.splice(i, 1);
                extended = true;
                break;
              }
            }

            if (
              curStartKey === otherStartKey ||
              (!bothHaveNodeIds &&
                Math.hypot(curStart[0] - otherStart[0], curStart[1] - otherStart[1]) < 0.20)
            ) {
              if ((endpointDegree.get(curStartKey) || 0) <= 2) {
                const reversedPoints = [...other.points].reverse();
                current.points = [...reversedPoints, ...current.points.slice(1)];
                if (current.nodeIds && other.nodeIds) {
                  const reversedNodeIds = [...other.nodeIds].reverse();
                  current.nodeIds = [...reversedNodeIds, ...current.nodeIds.slice(1)];
                }
                current.sourceFeatureIds = [...other.sourceFeatureIds, ...current.sourceFeatureIds];
                current.id = `${other.id}+${current.id}`;
                pool.splice(i, 1);
                extended = true;
                break;
              }
            }
          }
        }

        if (diagnostics?.featureLineage && current.sourceFeatureIds.length > 1) {
          diagnostics.featureLineage.chainingMap[current.id] = [...current.sourceFeatureIds];
          diagnostics.featureLineage.chainedFeaturesCount += current.sourceFeatureIds.length;
          diagnostics.featureLineage.chainedGroupsCount++;
        }

        mergedInGroup.push(current);
      }

      chainedResult.push(...mergedInGroup);
    }

    return chainedResult;
  }
}
