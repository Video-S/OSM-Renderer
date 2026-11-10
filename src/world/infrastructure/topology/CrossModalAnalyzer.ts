import { RawGeoJsonProperties } from '../../../types/MapFeature';
import { DEFAULT_NODE_SNAP_TOLERANCE_METERS } from '../../TopologicalNodeIndex';
import {
  cloneOsmTags,
  compareStringsCodeUnit,
  computeCumulativeLengths,
} from './RoadNetworkBuilder';
import {
  BaseInfrastructureEdge,
  BaseInfrastructureNode,
  CrossModalAnalysisInput,
  CrossModalAnalysisResult,
  GradeSeparatedCrossingRelation,
  GradeTransitionRelation,
  InfrastructureNetworkKind,
  InfrastructurePointMetadata,
  LevelCrossingRelation,
  RailwayEdge,
  RailwayFlatCrossingRelation,
  RailwayNetwork,
  RailwayNode,
  RoadEdge,
  RoadNetwork,
  RoadNode,
  UnresolvedCrossingCandidate,
  UnresolvedGradeTransitionCandidate,
  UnresolvedInfrastructurePointCandidate,
  UnresolvedInfrastructurePointReason,
} from './types';

export const GRADE_TRANSITION_DIAGNOSTIC_RADIUS_METERS = 0.8;
const COS_60_DEG = 0.5; // Tier 1 explicit OSM node portal tangent threshold
const COS_30_DEG = Math.cos((30 * Math.PI) / 180); // ~0.8660254 Tier 2 coordinate fallback portal tangent threshold
const TIER_1_RUNNER_UP_MARGIN = 0.1;

interface IndexedSegment<TEdge extends BaseInfrastructureEdge> {
  edge: TEdge;
  segmentIndex: number;
  p0: [number, number];
  p1: [number, number];
  startArcLength: number;
  segmentLength: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/**
 * Uniform 2D spatial grid indexing polyline segments for O(1) local cell queries.
 */
class SegmentSpatialIndex<TEdge extends BaseInfrastructureEdge> {
  private readonly cellSize: number;
  private readonly cells = new Map<string, IndexedSegment<TEdge>[]>();
  readonly allSegments: IndexedSegment<TEdge>[] = [];

  constructor(edges: Iterable<TEdge>, cellSize: number = 16.0) {
    this.cellSize = cellSize;
    for (const edge of edges) {
      const pts = edge.points;
      if (pts.length < 2) continue;
      const cum = computeCumulativeLengths(pts);
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        const segLen = cum[i + 1] - cum[i];
        if (segLen <= 1e-9) continue;
        const minX = Math.min(p0[0], p1[0]);
        const maxX = Math.max(p0[0], p1[0]);
        const minZ = Math.min(p0[1], p1[1]);
        const maxZ = Math.max(p0[1], p1[1]);
        const item: IndexedSegment<TEdge> = {
          edge,
          segmentIndex: i,
          p0: [p0[0], p0[1]],
          p1: [p1[0], p1[1]],
          startArcLength: cum[i],
          segmentLength: segLen,
          minX,
          minZ,
          maxX,
          maxZ,
        };
        this.allSegments.push(item);

        const cMinX = Math.floor(minX / this.cellSize);
        const cMaxX = Math.floor(maxX / this.cellSize);
        const cMinZ = Math.floor(minZ / this.cellSize);
        const cMaxZ = Math.floor(maxZ / this.cellSize);
        for (let cx = cMinX; cx <= cMaxX; cx++) {
          for (let cz = cMinZ; cz <= cMaxZ; cz++) {
            const key = `${cx},${cz}`;
            let bucket = this.cells.get(key);
            if (!bucket) {
              bucket = [];
              this.cells.set(key, bucket);
            }
            bucket.push(item);
          }
        }
      }
    }
  }

  queryBox(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number
  ): IndexedSegment<TEdge>[] {
    const cMinX = Math.floor(minX / this.cellSize);
    const cMaxX = Math.floor(maxX / this.cellSize);
    const cMinZ = Math.floor(minZ / this.cellSize);
    const cMaxZ = Math.floor(maxZ / this.cellSize);

    const seen = new Set<IndexedSegment<TEdge>>();
    const result: IndexedSegment<TEdge>[] = [];
    for (let cx = cMinX; cx <= cMaxX; cx++) {
      for (let cz = cMinZ; cz <= cMaxZ; cz++) {
        const bucket = this.cells.get(`${cx},${cz}`);
        if (!bucket) continue;
        for (const seg of bucket) {
          if (seen.has(seg)) continue;
          if (
            seg.maxX < minX ||
            seg.minX > maxX ||
            seg.maxZ < minZ ||
            seg.minZ > maxZ
          ) {
            continue;
          }
          seen.add(seg);
          result.push(seg);
        }
      }
    }
    return result;
  }

  queryRadius(x: number, z: number, radius: number): IndexedSegment<TEdge>[] {
    return this.queryBox(x - radius, z - radius, x + radius, z + radius);
  }
}

/**
 * Uniform 2D spatial grid for point / endpoint lookups.
 */
class PointSpatialIndex<TItem> {
  private readonly cellSize: number;
  private readonly cells = new Map<string, Array<{ x: number; z: number; item: TItem }>>();

  constructor(cellSize: number = 2.0) {
    this.cellSize = cellSize;
  }

  insert(x: number, z: number, item: TItem): void {
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    const key = `${cx},${cz}`;
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push({ x, z, item });
  }

  queryRadius(x: number, z: number, radius: number): Array<{ x: number; z: number; distance: number; item: TItem }> {
    const cMinX = Math.floor((x - radius) / this.cellSize);
    const cMaxX = Math.floor((x + radius) / this.cellSize);
    const cMinZ = Math.floor((z - radius) / this.cellSize);
    const cMaxZ = Math.floor((z + radius) / this.cellSize);

    const result: Array<{ x: number; z: number; distance: number; item: TItem }> = [];
    for (let cx = cMinX; cx <= cMaxX; cx++) {
      for (let cz = cMinZ; cz <= cMaxZ; cz++) {
        const bucket = this.cells.get(`${cx},${cz}`);
        if (!bucket) continue;
        for (const entry of bucket) {
          const dist = Math.hypot(entry.x - x, entry.z - z);
          if (dist <= radius) {
            result.push({ x: entry.x, z: entry.z, distance: dist, item: entry.item });
          }
        }
      }
    }
    return result;
  }
}

function stripNodePrefix(raw?: string): string | undefined {
  if (!raw) return undefined;
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

interface ExplicitPointVerticalScope {
  hasExplicitScope: boolean;
  layer?: number;
  isBridge?: boolean;
  isTunnel?: boolean;
}

function extractPointExplicitVerticalScope(
  osmTags?: RawGeoJsonProperties
): ExplicitPointVerticalScope {
  if (!osmTags) {
    return { hasExplicitScope: false };
  }

  const rawBridge =
    osmTags.bridge !== undefined && osmTags.bridge !== null
      ? String(osmTags.bridge).trim().toLowerCase()
      : '';
  const hasBridgeTag = rawBridge.length > 0;
  const isBridge = hasBridgeTag ? !['no', 'false', '0'].includes(rawBridge) : undefined;

  const rawTunnel =
    osmTags.tunnel !== undefined && osmTags.tunnel !== null
      ? String(osmTags.tunnel).trim().toLowerCase()
      : '';
  const rawCovered =
    osmTags.covered !== undefined && osmTags.covered !== null
      ? String(osmTags.covered).trim().toLowerCase()
      : '';
  const hasTunnelTag = rawTunnel.length > 0 || rawCovered.length > 0;
  const isTunnel = hasTunnelTag
    ? (rawTunnel.length > 0 && !['no', 'false', '0'].includes(rawTunnel)) ||
      (rawCovered.length > 0 && !['no', 'false', '0'].includes(rawCovered))
    : undefined;

  const rawLayer =
    osmTags.layer !== undefined && osmTags.layer !== null ? String(osmTags.layer).trim() : '';
  const parsedLayer = rawLayer.length > 0 ? Number(rawLayer) : Number.NaN;
  const hasLayerTag = Number.isFinite(parsedLayer);

  let layer: number | undefined;
  if (hasLayerTag) {
    layer = Math.trunc(parsedLayer);
  } else if (isBridge === true) {
    layer = 1;
  } else if (isTunnel === true) {
    layer = -1;
  }

  return {
    hasExplicitScope: hasBridgeTag || hasTunnelTag || hasLayerTag,
    layer,
    isBridge,
    isTunnel,
  };
}

function isEdgeCompatibleWithPointScope(
  edge: BaseInfrastructureEdge,
  ptScope: ExplicitPointVerticalScope
): boolean {
  if (!ptScope.hasExplicitScope) return true;
  if (ptScope.isBridge !== undefined && edge.isBridge !== ptScope.isBridge) return false;
  if (ptScope.isTunnel !== undefined && edge.isTunnel !== ptScope.isTunnel) return false;
  if (ptScope.layer !== undefined && edge.layer !== ptScope.layer) return false;
  return true;
}

interface ClosestPointOnEdgeResult {
  point: [number, number];
  distanceMeters: number;
  arcLengthMeters: number;
  tangent: [number, number];
  nearestVertexIndex: number;
  nearestVertexDistanceMeters: number;
  nearestVertexRawOsmNodeId?: string;
}

function projectPointOntoEdge(
  pt: readonly [number, number],
  edge: BaseInfrastructureEdge
): ClosestPointOnEdgeResult {
  const pts = edge.points;
  const cum = computeCumulativeLengths(pts);

  let bestDist = Infinity;
  let bestProj: [number, number] = [pts[0][0], pts[0][1]];
  let bestArc = 0;
  let bestTangent: [number, number] = edge.startInwardTangent;

  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0];
    const az = pts[i][1];
    const bx = pts[i + 1][0];
    const bz = pts[i + 1][1];
    const vx = bx - ax;
    const vz = bz - az;
    const segLen = cum[i + 1] - cum[i];
    if (segLen <= 1e-9) continue;

    const t = Math.max(0, Math.min(1, ((pt[0] - ax) * vx + (pt[1] - az) * vz) / (segLen * segLen)));
    const projX = ax + t * vx;
    const projZ = az + t * vz;
    const d = Math.hypot(pt[0] - projX, pt[1] - projZ);
    if (d < bestDist - 1e-9) {
      bestDist = d;
      bestProj = [projX, projZ];
      bestArc = cum[i] + t * segLen;
      bestTangent = [vx / segLen, vz / segLen];
    }
  }

  let nearestVertexIndex = 0;
  let nearestVertexDistanceMeters = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const vd = Math.hypot(pt[0] - pts[i][0], pt[1] - pts[i][1]);
    if (vd < nearestVertexDistanceMeters) {
      nearestVertexDistanceMeters = vd;
      nearestVertexIndex = i;
    }
  }

  const rawOsm = stripNodePrefix(edge.vertexRawOsmNodeIds[nearestVertexIndex]);

  return {
    point: bestProj,
    distanceMeters: bestDist,
    arcLengthMeters: bestArc,
    tangent: bestTangent,
    nearestVertexIndex,
    nearestVertexDistanceMeters,
    nearestVertexRawOsmNodeId: rawOsm,
  };
}

function computeAcuteCrossingAngleRad(
  tA: readonly [number, number],
  tB: readonly [number, number]
): number {
  const absDot = Math.min(1, Math.max(0, Math.abs(tA[0] * tB[0] + tA[1] * tB[1])));
  return Math.acos(absDot);
}

interface SegmentIntersection2D {
  point: [number, number];
  s: number;
  t: number;
  arcLengthA: number;
  arcLengthB: number;
  tangentA: [number, number];
  tangentB: [number, number];
}

function intersectIndexedSegments2D<
  TEdgeA extends BaseInfrastructureEdge,
  TEdgeB extends BaseInfrastructureEdge,
>(
  segA: IndexedSegment<TEdgeA>,
  segB: IndexedSegment<TEdgeB>
): SegmentIntersection2D | undefined {
  const ax0 = segA.p0[0];
  const az0 = segA.p0[1];
  const ax1 = segA.p1[0];
  const az1 = segA.p1[1];

  const bx0 = segB.p0[0];
  const bz0 = segB.p0[1];
  const bx1 = segB.p1[0];
  const bz1 = segB.p1[1];

  const dax = ax1 - ax0;
  const daz = az1 - az0;
  const dbx = bx1 - bx0;
  const dbz = bz1 - bz0;

  const denom = dax * dbz - daz * dbx;
  if (Math.abs(denom) < 1e-10) {
    return undefined;
  }

  const s = ((bx0 - ax0) * dbz - (bz0 - az0) * dbx) / denom;
  const t = ((bx0 - ax0) * daz - (bz0 - az0) * dax) / denom;

  const eps = 1e-5;
  if (s < -eps || s > 1 + eps || t < -eps || t > 1 + eps) {
    return undefined;
  }

  const clampedS = Math.max(0, Math.min(1, s));
  const clampedT = Math.max(0, Math.min(1, t));

  const ix = ax0 + clampedS * dax;
  const iz = az0 + clampedS * daz;

  return {
    point: [ix, iz],
    s: clampedS,
    t: clampedT,
    arcLengthA: segA.startArcLength + clampedS * segA.segmentLength,
    arcLengthB: segB.startArcLength + clampedT * segB.segmentLength,
    tangentA: [dax / segA.segmentLength, daz / segA.segmentLength],
    tangentB: [dbx / segB.segmentLength, dbz / segB.segmentLength],
  };
}

const MIN_LEVEL_CROSSING_ANGLE_RAD = (10 * Math.PI) / 180;
const SAME_PAIR_EVENT_DEDUP_TOLERANCE_METERS = 0.02;

function findRetainedNodeAtEdgeLocation<TNode extends BaseInfrastructureNode<string>>(
  edge: BaseInfrastructureEdge,
  nodes: ReadonlyMap<string, TNode>,
  position: readonly [number, number],
  rawOsmNodeId?: string
): TNode | undefined {
  const fromNode = nodes.get(edge.fromNodeId);
  const toNode = nodes.get(edge.toNodeId);
  const normOsm = stripNodePrefix(rawOsmNodeId);

  if (normOsm !== undefined) {
    if (
      fromNode &&
      stripNodePrefix(fromNode.rawOsmNodeId) === normOsm &&
      Math.hypot(fromNode.x - position[0], fromNode.z - position[1]) <=
        DEFAULT_NODE_SNAP_TOLERANCE_METERS
    ) {
      return fromNode;
    }
    if (
      toNode &&
      stripNodePrefix(toNode.rawOsmNodeId) === normOsm &&
      Math.hypot(toNode.x - position[0], toNode.z - position[1]) <=
        DEFAULT_NODE_SNAP_TOLERANCE_METERS
    ) {
      return toNode;
    }
    return undefined;
  }

  const fromDist = fromNode
    ? Math.hypot(fromNode.x - position[0], fromNode.z - position[1])
    : Infinity;
  const toDist = toNode
    ? Math.hypot(toNode.x - position[0], toNode.z - position[1])
    : Infinity;

  if (fromDist <= DEFAULT_NODE_SNAP_TOLERANCE_METERS && fromDist <= toDist) {
    return fromNode;
  }
  if (toDist <= DEFAULT_NODE_SNAP_TOLERANCE_METERS) {
    return toNode;
  }

  return undefined;
}

/**
 * Checks whether the candidate edges in a single domain at a crossing represent
 * one unambiguous continuous infrastructure line (either a single edge, or two
 * collinear edges split at the retained degree-2 crossing node).
 */
function isUnambiguousWayGroupAtCrossing<
  TNode extends BaseInfrastructureNode<string>,
  TEdge extends BaseInfrastructureEdge,
>(
  candidates: readonly { edge: TEdge; proj: ClosestPointOnEdgeResult }[],
  retainedNode?: TNode
): boolean {
  if (candidates.length === 0) return false;
  if (candidates.length === 1) {
    if (retainedNode && retainedNode.degree > 2) {
      return false;
    }
    return true;
  }
  if (candidates.length === 2 && retainedNode !== undefined) {
    if (retainedNode.degree !== 2) return false;
    const e0 = candidates[0].edge;
    const e1 = candidates[1].edge;
    if (e0.id === e1.id) return false;
    const e0Incident = e0.fromNodeId === retainedNode.id || e0.toNodeId === retainedNode.id;
    const e1Incident = e1.fromNodeId === retainedNode.id || e1.toNodeId === retainedNode.id;
    if (!e0Incident || !e1Incident) return false;

    const t0 = e0.fromNodeId === retainedNode.id ? e0.startInwardTangent : e0.endInwardTangent;
    const t1 = e1.fromNodeId === retainedNode.id ? e1.startInwardTangent : e1.endInwardTangent;
    const dot = t0[0] * t1[0] + t0[1] * t1[1];
    return dot <= -COS_60_DEG;
  }
  return false;
}

interface LocalGroupCrossingHit {
  point: [number, number];
  crossingAngleRad: number;
  distanceToRef: number;
}

/**
 * Verifies that the road edge(s) and railway edge(s) genuinely intersect in 2D
 * within `maxDistanceMeters` of `refPoint` with an acute crossing angle >= 10 deg
 * (rejecting parallel or non-intersecting ways that merely pass near a point).
 */
function findAllLocalEdgeGroupIntersections2D(
  roadEdgesGroup: readonly RoadEdge[],
  railEdgesGroup: readonly RailwayEdge[],
  refPoint: readonly [number, number],
  maxDistanceMeters: number
): LocalGroupCrossingHit[] {
  const hits: LocalGroupCrossingHit[] = [];

  for (const rEdge of roadEdgesGroup) {
    const rPts = rEdge.points;
    for (let i = 0; i < rPts.length - 1; i++) {
      const ax0 = rPts[i][0];
      const az0 = rPts[i][1];
      const ax1 = rPts[i + 1][0];
      const az1 = rPts[i + 1][1];
      const dax = ax1 - ax0;
      const daz = az1 - az0;
      const lenA = Math.hypot(dax, daz);
      if (lenA <= 1e-9) continue;
      const tA: [number, number] = [dax / lenA, daz / lenA];

      for (const rlEdge of railEdgesGroup) {
        const rlPts = rlEdge.points;
        for (let j = 0; j < rlPts.length - 1; j++) {
          const bx0 = rlPts[j][0];
          const bz0 = rlPts[j][1];
          const bx1 = rlPts[j + 1][0];
          const bz1 = rlPts[j + 1][1];
          const dbx = bx1 - bx0;
          const dbz = bz1 - bz0;
          const lenB = Math.hypot(dbx, dbz);
          if (lenB <= 1e-9) continue;
          const tB: [number, number] = [dbx / lenB, dbz / lenB];

          const denom = dax * dbz - daz * dbx;
          if (Math.abs(denom) < 1e-10) continue;

          const s = ((bx0 - ax0) * dbz - (bz0 - az0) * dbx) / denom;
          const t = ((bx0 - ax0) * daz - (bz0 - az0) * dax) / denom;
          const eps = 1e-5;
          if (s < -eps || s > 1 + eps || t < -eps || t > 1 + eps) continue;

          const cs = Math.max(0, Math.min(1, s));
          const ix = ax0 + cs * dax;
          const iz = az0 + cs * daz;
          const dist = Math.hypot(ix - refPoint[0], iz - refPoint[1]);
          if (dist > maxDistanceMeters) continue;

          const angle = computeAcuteCrossingAngleRad(tA, tB);
          if (angle < MIN_LEVEL_CROSSING_ANGLE_RAD) continue;

          // Deduplicate hits that represent the exact same physical crossing point (within 0.01 m)
          if (
            !hits.some(
              (h) => Math.hypot(h.point[0] - ix, h.point[1] - iz) <= 0.01
            )
          ) {
            hits.push({
              point: [ix, iz],
              crossingAngleRad: angle,
              distanceToRef: dist,
            });
          }
        }
      }
    }
  }

  return hits;
}

function findLocalEdgeGroupIntersection2D(
  roadEdgesGroup: readonly RoadEdge[],
  railEdgesGroup: readonly RailwayEdge[],
  refPoint: readonly [number, number],
  maxDistanceMeters: number
): LocalGroupCrossingHit | undefined {
  const all = findAllLocalEdgeGroupIntersections2D(
    roadEdgesGroup,
    railEdgesGroup,
    refPoint,
    maxDistanceMeters
  );
  if (all.length === 0) return undefined;
  all.sort((a, b) => a.distanceToRef - b.distanceToRef);
  return all[0];
}

/**
 * Selects the canonical representative edge among collinear halves of a split way at a retained node,
 * preferring the incoming segment (`toNodeId === node.id`) so `arcLengthMeters` reflects positive
 * cumulative distance along the way where available.
 */
function pickCanonicalEdgeForNodeCrossing<TEdge extends BaseInfrastructureEdge>(
  candidates: readonly { edge: TEdge; proj: ClosestPointOnEdgeResult }[],
  retainedNodeId?: string
): { edge: TEdge; proj: ClosestPointOnEdgeResult } {
  const sorted = [...candidates].sort((a, b) => {
    if (retainedNodeId !== undefined) {
      const aEndsAtNode = a.edge.toNodeId === retainedNodeId && a.edge.fromNodeId !== retainedNodeId ? 0 : 1;
      const bEndsAtNode = b.edge.toNodeId === retainedNodeId && b.edge.fromNodeId !== retainedNodeId ? 0 : 1;
      if (aEndsAtNode !== bEndsAtNode) return aEndsAtNode - bEndsAtNode;
    }
    return compareStringsCodeUnit(a.edge.id, b.edge.id);
  });
  return sorted[0];
}

/**
 * Evaluates whether two crossing edges have a reliable vertical separation (`upper` vs `lower`),
 * or whether their vertical tags are identical or contradictory.
 */
function classifyVerticalSeparation(
  edgeA: BaseInfrastructureEdge,
  edgeB: BaseInfrastructureEdge
):
  | { status: 'same_scope' }
  | { status: 'contradictory' }
  | {
      status: 'separated';
      upper: BaseInfrastructureEdge;
      lower: BaseInfrastructureEdge;
    } {
  if (
    edgeA.layer === edgeB.layer &&
    edgeA.isBridge === edgeB.isBridge &&
    edgeA.isTunnel === edgeB.isTunnel
  ) {
    return { status: 'same_scope' };
  }

  // Internally contradictory flags on a single edge
  if ((edgeA.isBridge && edgeA.isTunnel) || (edgeB.isBridge && edgeB.isTunnel)) {
    return { status: 'contradictory' };
  }

  const rankA = edgeA.isBridge ? 1 : edgeA.isTunnel ? -1 : 0;
  const rankB = edgeB.isBridge ? 1 : edgeB.isTunnel ? -1 : 0;

  // Contradictory tag on an individual edge relative to an at-grade 0-layer counterpart
  const isSelfContradictoryEdge = (e: BaseInfrastructureEdge): boolean =>
    (e.isTunnel && e.layer > 0) || (e.isBridge && e.layer < 0);

  if (isSelfContradictoryEdge(edgeA) || isSelfContradictoryEdge(edgeB)) {
    return { status: 'contradictory' };
  }

  if (edgeA.layer !== edgeB.layer) {
    const higher = edgeA.layer > edgeB.layer ? edgeA : edgeB;
    const lower = edgeA.layer > edgeB.layer ? edgeB : edgeA;
    const higherRank = higher.isBridge ? 1 : higher.isTunnel ? -1 : 0;
    const lowerRank = lower.isBridge ? 1 : lower.isTunnel ? -1 : 0;

    // If the higher-layer way is a tunnel while the lower-layer way is a bridge (or at-grade),
    // or the lower-layer way is a bridge while the higher-layer way is at-grade/tunnel,
    // the layer and bridge/tunnel tags contradict one another.
    if (higherRank < lowerRank) {
      return { status: 'contradictory' };
    }

    return {
      status: 'separated',
      upper: higher,
      lower,
    };
  }

  // Same numeric layer, but distinct bridge/tunnel status
  if (rankA !== rankB) {
    return {
      status: 'separated',
      upper: rankA > rankB ? edgeA : edgeB,
      lower: rankA > rankB ? edgeB : edgeA,
    };
  }

  return { status: 'same_scope' };
}

interface EndpointEntry<
  TNode extends BaseInfrastructureNode<string>,
  TEdge extends BaseInfrastructureEdge,
> {
  node: TNode;
  edge: TEdge;
  endpoint: 'start' | 'end';
  inwardTangent: [number, number];
  isClipped: boolean;
}

function analyzeDomainGradeTransitions<
  TNode extends BaseInfrastructureNode<string>,
  TEdge extends BaseInfrastructureEdge,
>(
  networkKind: InfrastructureNetworkKind,
  network: { nodes: ReadonlyMap<string, TNode>; edges: ReadonlyMap<string, TEdge> },
  segmentIndex: SegmentSpatialIndex<TEdge>,
  isCompatibleDomainEdgePair: (atGrade: TEdge, gradeSeparated: TEdge) => boolean
): {
  gradeTransitions: GradeTransitionRelation[];
  unresolvedGradeTransitions: UnresolvedGradeTransitionCandidate[];
} {
  const gradeTransitions: GradeTransitionRelation[] = [];
  const unresolvedGradeTransitions: UnresolvedGradeTransitionCandidate[] = [];

  const atGradeEndpoints: EndpointEntry<TNode, TEdge>[] = [];
  const structureEndpoints: EndpointEntry<TNode, TEdge>[] = [];

  const atGradeByOsmId = new Map<string, EndpointEntry<TNode, TEdge>[]>();
  const atGradePointIndex = new PointSpatialIndex<EndpointEntry<TNode, TEdge>>(2.0);

  // Track which nodes have continuing edges in the same vertical scope
  const sameScopeHalfEdgeCount = new Map<string, number>();
  for (const edge of network.edges.values()) {
    sameScopeHalfEdgeCount.set(
      edge.fromNodeId,
      (sameScopeHalfEdgeCount.get(edge.fromNodeId) ?? 0) + 1
    );
    sameScopeHalfEdgeCount.set(
      edge.toNodeId,
      (sameScopeHalfEdgeCount.get(edge.toNodeId) ?? 0) + 1
    );
  }

  const sortedEdges = [...network.edges.values()].sort((a, b) =>
    compareStringsCodeUnit(a.id, b.id)
  );

  for (const edge of sortedEdges) {
    const startNode = network.nodes.get(edge.fromNodeId);
    const endNode = network.nodes.get(edge.toNodeId);
    const isGradeSeparated = edge.isBridge || edge.isTunnel;
    const isAtGrade = !edge.isBridge && !edge.isTunnel;

    if (startNode) {
      const entry: EndpointEntry<TNode, TEdge> = {
        node: startNode,
        edge,
        endpoint: 'start',
        inwardTangent: edge.startInwardTangent,
        isClipped: edge.clippedAtStart || startNode.isBoundaryClipped,
      };
      if (isAtGrade) {
        atGradeEndpoints.push(entry);
        atGradePointIndex.insert(startNode.x, startNode.z, entry);
        const osmId = stripNodePrefix(startNode.rawOsmNodeId);
        if (osmId) {
          let list = atGradeByOsmId.get(osmId);
          if (!list) {
            list = [];
            atGradeByOsmId.set(osmId, list);
          }
          list.push(entry);
        }
      } else if (isGradeSeparated) {
        structureEndpoints.push(entry);
      }
    }

    if (endNode) {
      const entry: EndpointEntry<TNode, TEdge> = {
        node: endNode,
        edge,
        endpoint: 'end',
        inwardTangent: edge.endInwardTangent,
        isClipped: edge.clippedAtEnd || endNode.isBoundaryClipped,
      };
      if (isAtGrade) {
        atGradeEndpoints.push(entry);
        atGradePointIndex.insert(endNode.x, endNode.z, entry);
        const osmId = stripNodePrefix(endNode.rawOsmNodeId);
        if (osmId) {
          let list = atGradeByOsmId.get(osmId);
          if (!list) {
            list = [];
            atGradeByOsmId.set(osmId, list);
          }
          list.push(entry);
        }
      } else if (isGradeSeparated) {
        structureEndpoints.push(entry);
      }
    }
  }

  const processedStructurePortalKeys = new Set<string>();

  for (const structEntry of structureEndpoints) {
    const structNode = structEntry.node;
    const structEdge = structEntry.edge;
    const structOsmId = stripNodePrefix(structNode.rawOsmNodeId);
    const structDegree = sameScopeHalfEdgeCount.get(structNode.id) ?? structNode.degree;

    // Skip boundary-clipped synthetic endpoints
    if (structEntry.isClipped) {
      continue;
    }

    // If two bridge/tunnel segments meet mid-structure (structDegree >= 2) and no at-grade
    // endpoint shares rawOsmNodeId or lies within 0.80 m, it is an internal structure vertex, not a portal.
    const explicitAtGradeMatches = structOsmId ? (atGradeByOsmId.get(structOsmId) ?? []) : [];
    const nearbyAtGradeEntries = atGradePointIndex
      .queryRadius(structNode.x, structNode.z, GRADE_TRANSITION_DIAGNOSTIC_RADIUS_METERS)
      .filter((r) => !r.item.isClipped);

    if (structDegree > 1 && explicitAtGradeMatches.length === 0 && nearbyAtGradeEntries.length === 0) {
      continue;
    }

    const portalKey = `${structEdge.id}:${structEntry.endpoint}`;
    if (processedStructurePortalKeys.has(portalKey)) {
      continue;
    }
    processedStructurePortalKeys.add(portalKey);

    const transitionType: GradeTransitionRelation['transitionType'] = structEdge.isBridge
      ? 'bridge_approach'
      : 'tunnel_portal';

    // Tier 1: Shared Explicit OSM Node ID (`rawOsmNodeId`)
    if (structOsmId !== undefined && explicitAtGradeMatches.length > 0) {
      const compatibleMatches: Array<{
        entry: EndpointEntry<TNode, TEdge>;
        dot: number;
      }> = [];
      let hadClassMismatch = false;
      let bestMisalignedDot: number | undefined;
      const allCandidateEdgeIds = [
        ...new Set(explicitAtGradeMatches.map((m) => m.edge.id)),
      ].sort(compareStringsCodeUnit);

      for (const cand of explicitAtGradeMatches) {
        if (!isCompatibleDomainEdgePair(cand.edge, structEdge)) {
          hadClassMismatch = true;
          continue;
        }
        const dot = -(
          cand.inwardTangent[0] * structEntry.inwardTangent[0] +
          cand.inwardTangent[1] * structEntry.inwardTangent[1]
        );
        if (dot >= COS_60_DEG) {
          compatibleMatches.push({ entry: cand, dot });
        } else if (bestMisalignedDot === undefined || dot > bestMisalignedDot) {
          bestMisalignedDot = dot;
        }
      }

      compatibleMatches.sort((a, b) => {
        if (Math.abs(b.dot - a.dot) > 1e-9) return b.dot - a.dot;
        return compareStringsCodeUnit(a.entry.edge.id, b.entry.edge.id);
      });

      if (compatibleMatches.length >= 1) {
        const best = compatibleMatches[0];
        const runnerUp = compatibleMatches.length >= 2 ? compatibleMatches[1] : undefined;
        const isRailwayTurnoutWinner =
          Boolean(runnerUp) &&
          networkKind === 'railway' &&
          ((best.dot >= 0.98 && best.dot - runnerUp!.dot >= 1e-3) ||
            ('isSecondaryBranch' in best.entry.edge &&
              'isSecondaryBranch' in runnerUp!.entry.edge &&
              (best.entry.edge as unknown as RailwayEdge).isSecondaryBranch === false &&
              (runnerUp!.entry.edge as unknown as RailwayEdge).isSecondaryBranch === true));
        if (
          !runnerUp ||
          best.dot - runnerUp.dot >= TIER_1_RUNNER_UP_MARGIN - 1e-9 ||
          isRailwayTurnoutWinner
        ) {
          const relId = `grade_transition:${networkKind}:${structEdge.id}:${structEntry.endpoint}->${best.entry.edge.id}:${best.entry.endpoint}`;
          gradeTransitions.push({
            id: relId,
            network: networkKind,
            transitionType,
            position: [structNode.x, structNode.z],
            rawOsmNodeId: structOsmId,
            atGradeNodeId: best.entry.node.id,
            atGradeEdgeId: best.entry.edge.id,
            atGradeEndpoint: best.entry.endpoint,
            gradeSeparatedNodeId: structNode.id,
            gradeSeparatedEdgeId: structEdge.id,
            gradeSeparatedEndpoint: structEntry.endpoint,
            continuousTraversalDot: best.dot,
            confidence: 'explicit_osm_node',
          });
          continue;
        } else {
          unresolvedGradeTransitions.push({
            network: networkKind,
            position: [structNode.x, structNode.z],
            gradeSeparatedEdgeId: structEdge.id,
            gradeSeparatedEndpoint: structEntry.endpoint,
            candidateAtGradeEdgeIds: compatibleMatches
              .map((m) => m.entry.edge.id)
              .sort(compareStringsCodeUnit),
            distanceMeters: 0,
            continuousTraversalDot: best.dot,
            reason: 'ambiguous_multiple_candidates',
          });
          continue;
        }
      } else {
        unresolvedGradeTransitions.push({
          network: networkKind,
          position: [structNode.x, structNode.z],
          gradeSeparatedEdgeId: structEdge.id,
          gradeSeparatedEndpoint: structEntry.endpoint,
          candidateAtGradeEdgeIds: allCandidateEdgeIds,
          distanceMeters: 0,
          continuousTraversalDot: bestMisalignedDot,
          reason: hadClassMismatch ? 'incompatible_class_or_tier' : 'misaligned_tangent',
        });
        continue;
      }
    }

    // Tier 2: Coordinate Fallback within 0.15 m (and diagnostic horizon up to 0.80 m)
    const withinSnap = nearbyAtGradeEntries.filter(
      (r) => r.distance <= DEFAULT_NODE_SNAP_TOLERANCE_METERS
    );

    if (withinSnap.length > 0) {
      // Evaluate each candidate within 0.15 m
      const eligibleTier2: Array<{
        entry: EndpointEntry<TNode, TEdge>;
        distance: number;
        dot: number;
      }> = [];

      let sawDistinctOsmId = false;
      const structIsRailSwitch =
        networkKind === 'railway' &&
        (structNode.roles as readonly string[]).includes('switch');
      let sawNonTerminal = structDegree !== 1 && !structIsRailSwitch;
      let sawIncompatibleClass = false;
      let sawMisalignedTangent = false;
      let bestDiagnosticDot: number | undefined;
      let minSnapDistance = Infinity;

      for (const cand of withinSnap) {
        if (cand.distance < minSnapDistance) {
          minSnapDistance = cand.distance;
        }
        const candNode = cand.item.node;
        const candEdge = cand.item.edge;
        const candOsmId = stripNodePrefix(candNode.rawOsmNodeId);
        const candDegree = sameScopeHalfEdgeCount.get(candNode.id) ?? candNode.degree;
        const candIsRailSwitch =
          networkKind === 'railway' &&
          (candNode.roles as readonly string[]).includes('switch');

        const dot = -(
          cand.item.inwardTangent[0] * structEntry.inwardTangent[0] +
          cand.item.inwardTangent[1] * structEntry.inwardTangent[1]
        );
        if (bestDiagnosticDot === undefined || dot > bestDiagnosticDot) {
          bestDiagnosticDot = dot;
        }

        if (structOsmId !== undefined && candOsmId !== undefined && structOsmId !== candOsmId) {
          sawDistinctOsmId = true;
          continue;
        }
        if ((structDegree !== 1 && !structIsRailSwitch) || (candDegree !== 1 && !candIsRailSwitch)) {
          sawNonTerminal = true;
          continue;
        }
        if (!isCompatibleDomainEdgePair(candEdge, structEdge)) {
          sawIncompatibleClass = true;
          continue;
        }
        if (dot < COS_30_DEG) {
          sawMisalignedTangent = true;
          continue;
        }

        eligibleTier2.push({
          entry: cand.item,
          distance: cand.distance,
          dot,
        });
      }

      eligibleTier2.sort((a, b) => {
        if (Math.abs(b.dot - a.dot) > 1e-9) return b.dot - a.dot;
        return compareStringsCodeUnit(a.entry.edge.id, b.entry.edge.id);
      });

      const tier2Best = eligibleTier2[0];
      const tier2RunnerUp = eligibleTier2.length >= 2 ? eligibleTier2[1] : undefined;
      const tier2IsRailwayTurnoutWinner =
        Boolean(tier2Best && tier2RunnerUp) &&
        networkKind === 'railway' &&
        ((tier2Best.dot >= 0.98 && tier2Best.dot - tier2RunnerUp!.dot >= 1e-3) ||
          ('isSecondaryBranch' in tier2Best.entry.edge &&
            'isSecondaryBranch' in tier2RunnerUp!.entry.edge &&
            (tier2Best.entry.edge as unknown as RailwayEdge).isSecondaryBranch === false &&
            (tier2RunnerUp!.entry.edge as unknown as RailwayEdge).isSecondaryBranch === true));

      if (eligibleTier2.length === 1 || tier2IsRailwayTurnoutWinner) {
        const chosen = eligibleTier2[0];
        const relId = `grade_transition:${networkKind}:${structEdge.id}:${structEntry.endpoint}->${chosen.entry.edge.id}:${chosen.entry.endpoint}`;
        gradeTransitions.push({
          id: relId,
          network: networkKind,
          transitionType,
          position: [structNode.x, structNode.z],
          rawOsmNodeId: structOsmId ?? stripNodePrefix(chosen.entry.node.rawOsmNodeId),
          atGradeNodeId: chosen.entry.node.id,
          atGradeEdgeId: chosen.entry.edge.id,
          atGradeEndpoint: chosen.entry.endpoint,
          gradeSeparatedNodeId: structNode.id,
          gradeSeparatedEdgeId: structEdge.id,
          gradeSeparatedEndpoint: structEntry.endpoint,
          continuousTraversalDot: chosen.dot,
          confidence: 'coordinate_fallback_confirmed',
        });
        continue;
      }

      const candidateEdgeIds = [
        ...new Set(withinSnap.map((w) => w.item.edge.id)),
      ].sort(compareStringsCodeUnit);

      let reason: UnresolvedGradeTransitionCandidate['reason'];
      if (eligibleTier2.length > 1) {
        reason = 'ambiguous_multiple_candidates';
      } else if (sawDistinctOsmId) {
        reason = 'distinct_explicit_osm_nodes';
      } else if (sawIncompatibleClass) {
        reason = 'incompatible_class_or_tier';
      } else if (sawNonTerminal) {
        reason = 'non_terminal_endpoint';
      } else if (sawMisalignedTangent) {
        reason = 'misaligned_tangent';
      } else {
        reason = 'ambiguous_multiple_candidates';
      }

      unresolvedGradeTransitions.push({
        network: networkKind,
        position: [structNode.x, structNode.z],
        gradeSeparatedEdgeId: structEdge.id,
        gradeSeparatedEndpoint: structEntry.endpoint,
        candidateAtGradeEdgeIds: candidateEdgeIds,
        distanceMeters: Number.isFinite(minSnapDistance) ? minSnapDistance : 0,
        continuousTraversalDot: bestDiagnosticDot,
        reason,
      });
      continue;
    }

    // Check 0.15 m < d <= 0.80 m endpoint candidates
    if (nearbyAtGradeEntries.length > 0) {
      let minDist = Infinity;
      let bestDot: number | undefined;
      for (const cand of nearbyAtGradeEntries) {
        if (cand.distance < minDist) {
          minDist = cand.distance;
        }
        const dot = -(
          cand.item.inwardTangent[0] * structEntry.inwardTangent[0] +
          cand.item.inwardTangent[1] * structEntry.inwardTangent[1]
        );
        if (bestDot === undefined || dot > bestDot) {
          bestDot = dot;
        }
      }
      const candidateEdgeIds = [
        ...new Set(nearbyAtGradeEntries.map((w) => w.item.edge.id)),
      ].sort(compareStringsCodeUnit);

      unresolvedGradeTransitions.push({
        network: networkKind,
        position: [structNode.x, structNode.z],
        gradeSeparatedEdgeId: structEdge.id,
        gradeSeparatedEndpoint: structEntry.endpoint,
        candidateAtGradeEdgeIds: candidateEdgeIds,
        distanceMeters: minDist,
        continuousTraversalDot: bestDot,
        reason: 'exceeds_snap_tolerance',
      });
      continue;
    }

    // Check if an at-grade edge polyline passes within 0.80 m of the unconnected terminal portal
    // (e.g. a continuous perpendicular cross-street passing 0.50 m from a bridge portal)
    if (structDegree === 1) {
      const nearbySegs = segmentIndex
        .queryRadius(structNode.x, structNode.z, GRADE_TRANSITION_DIAGNOSTIC_RADIUS_METERS)
        .filter((s) => !s.edge.isBridge && !s.edge.isTunnel);

      if (nearbySegs.length > 0) {
        const candidateEdgesMap = new Map<
          string,
          { edge: TEdge; proj: ClosestPointOnEdgeResult }
        >();
        for (const seg of nearbySegs) {
          if (candidateEdgesMap.has(seg.edge.id)) continue;
          const proj = projectPointOntoEdge([structNode.x, structNode.z], seg.edge);
          if (proj.distanceMeters <= GRADE_TRANSITION_DIAGNOSTIC_RADIUS_METERS) {
            candidateEdgesMap.set(seg.edge.id, { edge: seg.edge, proj });
          }
        }

        if (candidateEdgesMap.size > 0) {
          const candidates = [...candidateEdgesMap.values()].sort(
            (a, b) => a.proj.distanceMeters - b.proj.distanceMeters
          );
          const closest = candidates[0];
          const alignDot = Math.abs(
            closest.proj.tangent[0] * structEntry.inwardTangent[0] +
              closest.proj.tangent[1] * structEntry.inwardTangent[1]
          );
          const reason: UnresolvedGradeTransitionCandidate['reason'] =
            alignDot < COS_30_DEG
              ? 'misaligned_tangent'
              : closest.proj.distanceMeters > DEFAULT_NODE_SNAP_TOLERANCE_METERS
              ? 'exceeds_snap_tolerance'
              : 'non_terminal_endpoint';

          unresolvedGradeTransitions.push({
            network: networkKind,
            position: [structNode.x, structNode.z],
            gradeSeparatedEdgeId: structEdge.id,
            gradeSeparatedEndpoint: structEntry.endpoint,
            candidateAtGradeEdgeIds: candidates
              .map((c) => c.edge.id)
              .sort(compareStringsCodeUnit),
            distanceMeters: closest.proj.distanceMeters,
            continuousTraversalDot: alignDot,
            reason,
          });
        }
      }
    }
  }

  gradeTransitions.sort((a, b) => compareStringsCodeUnit(a.id, b.id));
  unresolvedGradeTransitions.sort((a, b) => {
    const netCmp = compareStringsCodeUnit(a.network, b.network);
    if (netCmp !== 0) return netCmp;
    const edgeCmp = compareStringsCodeUnit(a.gradeSeparatedEdgeId, b.gradeSeparatedEdgeId);
    if (edgeCmp !== 0) return edgeCmp;
    return compareStringsCodeUnit(a.gradeSeparatedEndpoint, b.gradeSeparatedEndpoint);
  });

  return { gradeTransitions, unresolvedGradeTransitions };
}

/**
 * Pure, deterministic Stage D cross-modal connectivity, level crossing, grade transition,
 * and grade-separated crossing analyzer (`ADR-0009`).
 */
export function analyzeCrossModal(input: CrossModalAnalysisInput): CrossModalAnalysisResult {
  const { roads, railways } = input;
  const rawPoints = input.infrastructurePoints ?? [];

  const roadEdges = [...roads.edges.values()].sort((a, b) =>
    compareStringsCodeUnit(a.id, b.id)
  );
  const railEdges = [...railways.edges.values()].sort((a, b) =>
    compareStringsCodeUnit(a.id, b.id)
  );

  const roadSegmentIndex = new SegmentSpatialIndex<RoadEdge>(roadEdges, 16.0);
  const railSegmentIndex = new SegmentSpatialIndex<RailwayEdge>(railEdges, 16.0);

  const levelCrossings: LevelCrossingRelation[] = [];
  const gradeSeparatedCrossings: GradeSeparatedCrossingRelation[] = [];
  const unresolvedCrossings: UnresolvedCrossingCandidate[] = [
    ...(input.railwayUnresolvedCrossings ?? []).map((u) => ({
      ...u,
      position: [u.position[0], u.position[1]] as [number, number],
    })),
  ];
  const unresolvedInfrastructurePoints: UnresolvedInfrastructurePointCandidate[] = [
    ...(input.roadUnresolvedInfrastructurePoints ?? []).map((p) => ({
      ...p,
      position: [p.position[0], p.position[1]] as [number, number],
      candidateNodeIds: [...p.candidateNodeIds],
      osmTags: cloneOsmTags(p.osmTags),
    })),
    ...(input.railwayUnresolvedInfrastructurePoints ?? []).map((p) => ({
      ...p,
      position: [p.position[0], p.position[1]] as [number, number],
      candidateNodeIds: [...p.candidateNodeIds],
      osmTags: cloneOsmTags(p.osmTags),
    })),
  ];

  const confirmedRoadLevelCrossingNodeTags = new Map<string, RawGeoJsonProperties>();
  const confirmedRailwayLevelCrossingNodeTags = new Map<string, RawGeoJsonProperties>();

  // Extract rail crossing points (`railway=level_crossing` and `railway=crossing`)
  const railCrossingPoints = rawPoints
    .filter(
      (pt) =>
        pt &&
        (pt.kind === 'railway_level_crossing' || pt.kind === 'railway_ped_crossing') &&
        Array.isArray(pt.point) &&
        pt.point.length >= 2 &&
        Number.isFinite(pt.point[0]) &&
        Number.isFinite(pt.point[1])
    )
    .map((pt) => ({
      id: String(pt.id),
      hasExplicitSourceId: Boolean(pt.hasExplicitSourceId),
      rawOsmNodeId:
        stripNodePrefix(pt.rawOsmNodeId) ??
        (pt.hasExplicitSourceId ? stripNodePrefix(String(pt.id)) : undefined),
      point: [Number(pt.point[0]), Number(pt.point[1])] as [number, number],
      kind: pt.kind,
      osmTags: cloneOsmTags(pt.osmTags),
    }))
    .sort((a, b) => compareStringsCodeUnit(a.id, b.id));

  const crossingPointByOsmId = new Map<string, InfrastructurePointMetadata>();
  const crossingPointSpatialIndex = new PointSpatialIndex<InfrastructurePointMetadata>(2.0);
  for (const pt of railCrossingPoints) {
    if (pt.rawOsmNodeId && !crossingPointByOsmId.has(pt.rawOsmNodeId)) {
      crossingPointByOsmId.set(pt.rawOsmNodeId, pt);
    }
    crossingPointSpatialIndex.insert(pt.point[0], pt.point[1], pt);
  }
  const consumedCrossingPointIds = new Set<string>();

  const recordUnresolvedPoint = (
    ptMeta: InfrastructurePointMetadata,
    candidateNodeIds: readonly string[],
    reason: UnresolvedInfrastructurePointReason
  ) => {
    unresolvedInfrastructurePoints.push({
      pointId: ptMeta.id,
      rawOsmNodeId: ptMeta.rawOsmNodeId,
      kind: ptMeta.kind,
      position: [ptMeta.point[0], ptMeta.point[1]],
      candidateNodeIds: [...new Set(candidateNodeIds)].sort(compareStringsCodeUnit),
      reason,
      osmTags: cloneOsmTags(ptMeta.osmTags),
    });
  };

  // Event-specific tracking of confirmed or diagnosed road-rail crossings keyed by `(roadEdgeId, railEdgeId, layer)`
  // so that separate crossings on different edge pairs within 0.225 m or separate crossings on the same edge pair
  // at distinct locations are never suppressed.
  const handledRoadRailPairEvents = new Map<string, Array<[number, number]>>();

  const markRoadRailPairEventHandled = (
    roadEdgeIds: readonly string[],
    railEdgeIds: readonly string[],
    layer: number,
    position: readonly [number, number]
  ) => {
    for (const rId of roadEdgeIds) {
      for (const rlId of railEdgeIds) {
        const key = `${rId}||${rlId}|${layer}`;
        let list = handledRoadRailPairEvents.get(key);
        if (!list) {
          list = [];
          handledRoadRailPairEvents.set(key, list);
        }
        if (
          !list.some(
            (existing) =>
              Math.hypot(existing[0] - position[0], existing[1] - position[1]) <=
              SAME_PAIR_EVENT_DEDUP_TOLERANCE_METERS
          )
        ) {
          list.push([position[0], position[1]]);
        }
      }
    }
  };

  const isRoadRailPairEventAlreadyHandled = (
    roadEdgeId: string,
    railEdgeId: string,
    layer: number,
    pos: readonly [number, number]
  ): boolean => {
    const key = `${roadEdgeId}||${railEdgeId}|${layer}`;
    const list = handledRoadRailPairEvents.get(key);
    if (!list) return false;
    return list.some(
      (existing) =>
        Math.hypot(existing[0] - pos[0], existing[1] - pos[1]) <=
        SAME_PAIR_EVENT_DEDUP_TOLERANCE_METERS
    );
  };

  // Event-specific deduplication for unresolved crossings keyed by `(kind, u, v)`
  const unresolvedLocationsByPairKey = new Map<string, Array<[number, number]>>();
  for (const existing of unresolvedCrossings) {
    const u = existing.edgeAId <= existing.edgeBId ? existing.edgeAId : existing.edgeBId;
    const v = existing.edgeAId <= existing.edgeBId ? existing.edgeBId : existing.edgeAId;
    const pairKey = `${existing.kind}:${u}||${v}`;
    let list = unresolvedLocationsByPairKey.get(pairKey);
    if (!list) {
      list = [];
      unresolvedLocationsByPairKey.set(pairKey, list);
    }
    list.push([existing.position[0], existing.position[1]]);
  }

  const addUnresolvedCrossingOnce = (cand: UnresolvedCrossingCandidate) => {
    const u = cand.edgeAId <= cand.edgeBId ? cand.edgeAId : cand.edgeBId;
    const v = cand.edgeAId <= cand.edgeBId ? cand.edgeBId : cand.edgeAId;
    const pairKey = `${cand.kind}:${u}||${v}`;
    let list = unresolvedLocationsByPairKey.get(pairKey);
    if (!list) {
      list = [];
      unresolvedLocationsByPairKey.set(pairKey, list);
    }
    if (
      list.some(
        (existing) =>
          Math.hypot(existing[0] - cand.position[0], existing[1] - cand.position[1]) <=
          SAME_PAIR_EVENT_DEDUP_TOLERANCE_METERS
      )
    ) {
      return;
    }
    list.push([cand.position[0], cand.position[1]]);
    unresolvedCrossings.push(cand);
  };

  // Event-specific deduplication for grade-separated crossings keyed by `(upper.id, lower.id)`
  const gradeSeparatedLocationsByPairKey = new Map<string, Array<[number, number]>>();

  const addGradeSeparatedCrossingOnce = (
    upper: BaseInfrastructureEdge,
    lower: BaseInfrastructureEdge,
    position: [number, number]
  ) => {
    const pairKey = `${upper.id}->${lower.id}`;
    let list = gradeSeparatedLocationsByPairKey.get(pairKey);
    if (!list) {
      list = [];
      gradeSeparatedLocationsByPairKey.set(pairKey, list);
    }
    if (
      list.some(
        (existing) =>
          Math.hypot(existing[0] - position[0], existing[1] - position[1]) <=
          SAME_PAIR_EVENT_DEDUP_TOLERANCE_METERS
      )
    ) {
      return;
    }
    list.push([position[0], position[1]]);

    const id = `grade_separated:${upper.id}__over__${lower.id}@${Math.round(position[0] * 1000)},${Math.round(position[1] * 1000)}`;
    gradeSeparatedCrossings.push({
      id,
      position: [position[0], position[1]],
      upperNetwork: upper.network,
      upperEdgeId: upper.id,
      upperLayer: upper.layer,
      upperIsBridge: upper.isBridge,
      lowerNetwork: lower.network,
      lowerEdgeId: lower.id,
      lowerLayer: lower.layer,
      lowerIsTunnel: lower.isTunnel,
    });
  };

  // ---------------------------------------------------------------------------
  // 1A. Confirmed Level Crossings via Shared Explicit OSM Node ID (`rawOsmNodeId`)
  // ---------------------------------------------------------------------------
  interface EdgeVertexRef<TEdge extends BaseInfrastructureEdge> {
    edge: TEdge;
    vertexIndex: number;
    point: [number, number];
  }

  const atGradeRoadVerticesByOsmId = new Map<string, EdgeVertexRef<RoadEdge>[]>();
  for (const roadEdge of roadEdges) {
    if (roadEdge.isBridge || roadEdge.isTunnel) continue;
    for (let i = 0; i < roadEdge.points.length; i++) {
      const osmId = stripNodePrefix(roadEdge.vertexRawOsmNodeIds[i]);
      if (!osmId) continue;
      let list = atGradeRoadVerticesByOsmId.get(osmId);
      if (!list) {
        list = [];
        atGradeRoadVerticesByOsmId.set(osmId, list);
      }
      list.push({ edge: roadEdge, vertexIndex: i, point: roadEdge.points[i] });
    }
  }

  const atGradeRailVerticesByOsmId = new Map<string, EdgeVertexRef<RailwayEdge>[]>();
  for (const railEdge of railEdges) {
    if (railEdge.isBridge || railEdge.isTunnel) continue;
    for (let i = 0; i < railEdge.points.length; i++) {
      const osmId = stripNodePrefix(railEdge.vertexRawOsmNodeIds[i]);
      if (!osmId) continue;
      let list = atGradeRailVerticesByOsmId.get(osmId);
      if (!list) {
        list = [];
        atGradeRailVerticesByOsmId.set(osmId, list);
      }
      list.push({ edge: railEdge, vertexIndex: i, point: railEdge.points[i] });
    }
  }

  const sharedOsmIds = [...atGradeRoadVerticesByOsmId.keys()]
    .filter((id) => atGradeRailVerticesByOsmId.has(id))
    .sort(compareStringsCodeUnit);

  for (const osmId of sharedOsmIds) {
    const roadRefs = atGradeRoadVerticesByOsmId.get(osmId)!;
    const railRefs = atGradeRailVerticesByOsmId.get(osmId)!;
    const pos = roadRefs[0].point;

    // Match compatible layer
    const sameLayerRoadRefs = roadRefs.filter((r) =>
      railRefs.some(
        (rr) =>
          rr.edge.layer === r.edge.layer &&
          Math.hypot(rr.point[0] - r.point[0], rr.point[1] - r.point[1]) <=
            DEFAULT_NODE_SNAP_TOLERANCE_METERS
      )
    );
    if (sameLayerRoadRefs.length === 0) continue;

    const targetLayer = sameLayerRoadRefs[0].edge.layer;
    const layerRailRefs = railRefs.filter((rr) => rr.edge.layer === targetLayer);

    // Find matching crossing point metadata if present (must share verified rawOsmNodeId === osmId)
    let matchedPt = crossingPointByOsmId.get(osmId);
    if (!matchedPt) {
      const nearbyPts = crossingPointSpatialIndex
        .queryRadius(pos[0], pos[1], DEFAULT_NODE_SNAP_TOLERANCE_METERS)
        .filter(
          (p) => !consumedCrossingPointIds.has(p.item.id) && p.item.rawOsmNodeId === osmId
        );
      if (nearbyPts.length === 1) {
        matchedPt = nearbyPts[0].item;
      }
    }

    if (matchedPt) {
      consumedCrossingPointIds.add(matchedPt.id);
    }

    const roadNode = findRetainedNodeAtEdgeLocation(
      sameLayerRoadRefs[0].edge,
      roads.nodes,
      pos,
      osmId
    );
    const railNode = findRetainedNodeAtEdgeLocation(
      layerRailRefs[0].edge,
      railways.nodes,
      pos,
      osmId
    );

    const uniqueRoadEdges = [
      ...new Map(sameLayerRoadRefs.map((ref) => [ref.edge.id, ref.edge])).values(),
    ];
    const uniqueRailEdges = [
      ...new Map(layerRailRefs.map((ref) => [ref.edge.id, ref.edge])).values(),
    ];

    const roadCandidates = uniqueRoadEdges.map((edge) => ({
      edge,
      proj: projectPointOntoEdge(pos, edge),
    }));
    const railCandidates = uniqueRailEdges.map((edge) => ({
      edge,
      proj: projectPointOntoEdge(pos, edge),
    }));

    const candidateNodeIds: string[] = [];
    if (roadNode) candidateNodeIds.push(roadNode.id);
    if (railNode) candidateNodeIds.push(railNode.id);

    if (
      !isUnambiguousWayGroupAtCrossing(roadCandidates, roadNode) ||
      !isUnambiguousWayGroupAtCrossing(railCandidates, railNode)
    ) {
      if (matchedPt) {
        recordUnresolvedPoint(
          matchedPt,
          candidateNodeIds,
          'ambiguous_multiple_candidate_nodes'
        );
      }
      continue;
    }

    const crossingHit = findLocalEdgeGroupIntersection2D(
      uniqueRoadEdges,
      uniqueRailEdges,
      pos,
      DEFAULT_NODE_SNAP_TOLERANCE_METERS
    );
    if (!crossingHit) {
      if (matchedPt) {
        recordUnresolvedPoint(
          matchedPt,
          candidateNodeIds,
          'insufficient_topological_evidence'
        );
      }
      continue;
    }

    const chosenRoad = pickCanonicalEdgeForNodeCrossing(roadCandidates, roadNode?.id);
    const chosenRail = pickCanonicalEdgeForNodeCrossing(railCandidates, railNode?.id);

    // Check for material conflict between point tag and road tier
    if (matchedPt) {
      const ptScope = extractPointExplicitVerticalScope(matchedPt.osmTags);
      if (
        !isEdgeCompatibleWithPointScope(chosenRoad.edge, ptScope) ||
        !isEdgeCompatibleWithPointScope(chosenRail.edge, ptScope)
      ) {
        recordUnresolvedPoint(matchedPt, candidateNodeIds, 'vertical_scope_mismatch');
        continue;
      }

      const tierConflict =
        (matchedPt.kind === 'railway_level_crossing' && chosenRoad.edge.tier !== 'vehicular') ||
        (matchedPt.kind === 'railway_ped_crossing' && chosenRoad.edge.tier !== 'path');

      if (tierConflict) {
        recordUnresolvedPoint(
          matchedPt,
          candidateNodeIds,
          'conflicting_crossing_tag_and_road_tier'
        );
        addUnresolvedCrossingOnce({
          kind: chosenRoad.edge.tier === 'path' ? 'pedestrian_rail' : 'road_rail',
          position: [pos[0], pos[1]],
          edgeAId: chosenRoad.edge.id,
          edgeBId: chosenRail.edge.id,
          reason: 'conflicting_crossing_tag_and_road_tier',
        });
        markRoadRailPairEventHandled(
          uniqueRoadEdges.map((e) => e.id),
          uniqueRailEdges.map((e) => e.id),
          targetLayer,
          crossingHit.point
        );
        continue;
      }
    }

    const crossingKind: LevelCrossingRelation['crossingKind'] =
      chosenRoad.edge.tier === 'path'
        ? 'pedestrian_rail_crossing'
        : 'road_rail_level_crossing';
    const confidence: LevelCrossingRelation['confidence'] = matchedPt
      ? 'explicit_osm_crossing_tag'
      : 'shared_explicit_osm_node';
    const crossingAngleRad = crossingHit.crossingAngleRad;

    const relId = `level_crossing:${chosenRoad.edge.id}__${chosenRail.edge.id}:osm_${osmId}`;
    const pointOsmTags = matchedPt ? cloneOsmTags(matchedPt.osmTags) : undefined;

    levelCrossings.push({
      id: relId,
      crossingKind,
      position: [pos[0], pos[1]],
      rawOsmNodeId: osmId,
      roadEdgeId: chosenRoad.edge.id,
      roadNodeId: roadNode?.id,
      roadArcLengthMeters: chosenRoad.proj.arcLengthMeters,
      railwayEdgeId: chosenRail.edge.id,
      railwayNodeId: railNode?.id,
      railwayArcLengthMeters: chosenRail.proj.arcLengthMeters,
      crossingAngleRad,
      confidence,
      pointOsmTags,
    });

    if (roadNode && pointOsmTags) {
      confirmedRoadLevelCrossingNodeTags.set(roadNode.id, pointOsmTags);
    }
    if (railNode && pointOsmTags) {
      confirmedRailwayLevelCrossingNodeTags.set(railNode.id, pointOsmTags);
    }

    markRoadRailPairEventHandled(
      uniqueRoadEdges.map((e) => e.id),
      uniqueRailEdges.map((e) => e.id),
      targetLayer,
      crossingHit.point
    );
  }

  // ---------------------------------------------------------------------------
  // 1B. Confirmed Level Crossings via Point Metadata (`railway=level_crossing` / `railway=crossing`)
  // ---------------------------------------------------------------------------
  for (const ptMeta of railCrossingPoints) {
    if (consumedCrossingPointIds.has(ptMeta.id)) continue;

    const ptScope = extractPointExplicitVerticalScope(ptMeta.osmTags);
    const nearbyRoadSegs = roadSegmentIndex.queryRadius(
      ptMeta.point[0],
      ptMeta.point[1],
      DEFAULT_NODE_SNAP_TOLERANCE_METERS
    );
    const nearbyRailSegs = railSegmentIndex.queryRadius(
      ptMeta.point[0],
      ptMeta.point[1],
      DEFAULT_NODE_SNAP_TOLERANCE_METERS
    );

    const roadProjByEdge = new Map<string, { edge: RoadEdge; proj: ClosestPointOnEdgeResult }>();
    for (const seg of nearbyRoadSegs) {
      if (roadProjByEdge.has(seg.edge.id)) continue;
      const proj = projectPointOntoEdge(ptMeta.point, seg.edge);
      if (proj.distanceMeters <= DEFAULT_NODE_SNAP_TOLERANCE_METERS) {
        roadProjByEdge.set(seg.edge.id, { edge: seg.edge, proj });
      }
    }

    const railProjByEdge = new Map<string, { edge: RailwayEdge; proj: ClosestPointOnEdgeResult }>();
    for (const seg of nearbyRailSegs) {
      if (railProjByEdge.has(seg.edge.id)) continue;
      const proj = projectPointOntoEdge(ptMeta.point, seg.edge);
      if (proj.distanceMeters <= DEFAULT_NODE_SNAP_TOLERANCE_METERS) {
        railProjByEdge.set(seg.edge.id, { edge: seg.edge, proj });
      }
    }

    if (roadProjByEdge.size === 0 && railProjByEdge.size === 0) {
      recordUnresolvedPoint(ptMeta, [], 'no_candidate_node_within_snap_tolerance');
      continue;
    }

    const gatherCandidateNodeIds = (): string[] => {
      const ids: string[] = [];
      for (const { edge } of roadProjByEdge.values()) {
        const rn = findRetainedNodeAtEdgeLocation(edge, roads.nodes, ptMeta.point);
        if (rn) ids.push(rn.id);
      }
      for (const { edge } of railProjByEdge.values()) {
        const rln = findRetainedNodeAtEdgeLocation(edge, railways.nodes, ptMeta.point);
        if (rln) ids.push(rln.id);
      }
      return ids;
    };

    if (roadProjByEdge.size === 0 || railProjByEdge.size === 0) {
      recordUnresolvedPoint(
        ptMeta,
        gatherCandidateNodeIds(),
        'insufficient_topological_evidence'
      );
      continue;
    }

    // Filter to at-grade scope-compatible road and rail edges
    const atGradeRoads = [...roadProjByEdge.values()].filter(
      ({ edge }) =>
        !edge.isBridge && !edge.isTunnel && isEdgeCompatibleWithPointScope(edge, ptScope)
    );
    const atGradeRails = [...railProjByEdge.values()].filter(
      ({ edge }) =>
        !edge.isBridge && !edge.isTunnel && isEdgeCompatibleWithPointScope(edge, ptScope)
    );

    if (atGradeRoads.length === 0 || atGradeRails.length === 0) {
      recordUnresolvedPoint(ptMeta, gatherCandidateNodeIds(), 'vertical_scope_mismatch');
      continue;
    }

    // Pair road and rail on the same layer
    const sameLayerPairs: Array<{
      road: { edge: RoadEdge; proj: ClosestPointOnEdgeResult };
      rail: { edge: RailwayEdge; proj: ClosestPointOnEdgeResult };
    }> = [];

    for (const r of atGradeRoads) {
      for (const rl of atGradeRails) {
        if (r.edge.layer === rl.edge.layer) {
          sameLayerPairs.push({ road: r, rail: rl });
        }
      }
    }

    if (sameLayerPairs.length === 0) {
      recordUnresolvedPoint(ptMeta, gatherCandidateNodeIds(), 'vertical_scope_mismatch');
      continue;
    }

    const distinctLayers = new Set(sameLayerPairs.map((p) => p.road.edge.layer));
    if (distinctLayers.size !== 1) {
      recordUnresolvedPoint(
        ptMeta,
        gatherCandidateNodeIds(),
        'ambiguous_multiple_candidate_nodes'
      );
      continue;
    }

    const targetLayer = sameLayerPairs[0].road.edge.layer;
    const layerRoads = atGradeRoads.filter((r) => r.edge.layer === targetLayer);
    const layerRails = atGradeRails.filter((rl) => rl.edge.layer === targetLayer);

    // ADR-0009 Section 6.2: Point-based confirmation requires a verified rawOsmNodeId on the point
    if (ptMeta.rawOsmNodeId === undefined) {
      recordUnresolvedPoint(
        ptMeta,
        gatherCandidateNodeIds(),
        'insufficient_topological_evidence'
      );
      continue;
    }

    // Check for conflicting explicit OSM node IDs on nearby vertices and verify at least one way matches ptMeta.rawOsmNodeId
    let hasConflict = false;
    let matchesRoadVertexOsmId = false;
    let matchesRailVertexOsmId = false;

    for (const r of layerRoads) {
      for (let i = 0; i < r.edge.points.length; i++) {
        const vd = Math.hypot(
          r.edge.points[i][0] - ptMeta.point[0],
          r.edge.points[i][1] - ptMeta.point[1]
        );
        if (vd <= DEFAULT_NODE_SNAP_TOLERANCE_METERS) {
          const vOsm = stripNodePrefix(r.edge.vertexRawOsmNodeIds[i]);
          if (vOsm !== undefined && vOsm !== ptMeta.rawOsmNodeId) {
            hasConflict = true;
          } else if (vOsm === ptMeta.rawOsmNodeId) {
            matchesRoadVertexOsmId = true;
          }
        }
      }
    }

    for (const rl of layerRails) {
      for (let i = 0; i < rl.edge.points.length; i++) {
        const vd = Math.hypot(
          rl.edge.points[i][0] - ptMeta.point[0],
          rl.edge.points[i][1] - ptMeta.point[1]
        );
        if (vd <= DEFAULT_NODE_SNAP_TOLERANCE_METERS) {
          const vOsm = stripNodePrefix(rl.edge.vertexRawOsmNodeIds[i]);
          if (vOsm !== undefined && vOsm !== ptMeta.rawOsmNodeId) {
            hasConflict = true;
          } else if (vOsm === ptMeta.rawOsmNodeId) {
            matchesRailVertexOsmId = true;
          }
        }
      }
    }

    if (hasConflict) {
      recordUnresolvedPoint(
        ptMeta,
        gatherCandidateNodeIds(),
        'conflicting_explicit_osm_node_id'
      );
      const chosenRoad = pickCanonicalEdgeForNodeCrossing(layerRoads);
      const chosenRail = pickCanonicalEdgeForNodeCrossing(layerRails);
      addUnresolvedCrossingOnce({
        kind: chosenRoad.edge.tier === 'path' ? 'pedestrian_rail' : 'road_rail',
        position: [ptMeta.point[0], ptMeta.point[1]],
        edgeAId: chosenRoad.edge.id,
        edgeBId: chosenRail.edge.id,
        reason: 'conflicting_explicit_osm_node_id',
      });
      // Do not allow an unverified conflicting annotation position to suppress a distinct actual geometric crossing
      continue;
    }

    if (!matchesRoadVertexOsmId && !matchesRailVertexOsmId) {
      // Point OSM node ID matches neither the road nor the railway vertices
      recordUnresolvedPoint(
        ptMeta,
        gatherCandidateNodeIds(),
        'insufficient_topological_evidence'
      );
      continue;
    }

    // Determine the verified anchor vertex position for the matching way
    let anchorVertexPos: readonly [number, number] | undefined;
    if (matchesRoadVertexOsmId) {
      for (const r of layerRoads) {
        for (let i = 0; i < r.edge.points.length; i++) {
          if (
            stripNodePrefix(r.edge.vertexRawOsmNodeIds[i]) === ptMeta.rawOsmNodeId &&
            Math.hypot(r.edge.points[i][0] - ptMeta.point[0], r.edge.points[i][1] - ptMeta.point[1]) <=
              DEFAULT_NODE_SNAP_TOLERANCE_METERS
          ) {
            anchorVertexPos = r.edge.points[i];
            break;
          }
        }
        if (anchorVertexPos) break;
      }
    }
    if (!anchorVertexPos && matchesRailVertexOsmId) {
      for (const rl of layerRails) {
        for (let i = 0; i < rl.edge.points.length; i++) {
          if (
            stripNodePrefix(rl.edge.vertexRawOsmNodeIds[i]) === ptMeta.rawOsmNodeId &&
            Math.hypot(rl.edge.points[i][0] - ptMeta.point[0], rl.edge.points[i][1] - ptMeta.point[1]) <=
              DEFAULT_NODE_SNAP_TOLERANCE_METERS
          ) {
            anchorVertexPos = rl.edge.points[i];
            break;
          }
        }
        if (anchorVertexPos) break;
      }
    }

    const roadNode = matchesRoadVertexOsmId
      ? findRetainedNodeAtEdgeLocation(
          layerRoads[0].edge,
          roads.nodes,
          anchorVertexPos ?? ptMeta.point,
          ptMeta.rawOsmNodeId
        )
      : undefined;
    const railNode = matchesRailVertexOsmId
      ? findRetainedNodeAtEdgeLocation(
          layerRails[0].edge,
          railways.nodes,
          anchorVertexPos ?? ptMeta.point,
          ptMeta.rawOsmNodeId
        )
      : undefined;

    if (
      !isUnambiguousWayGroupAtCrossing(layerRoads, roadNode) ||
      !isUnambiguousWayGroupAtCrossing(layerRails, railNode)
    ) {
      recordUnresolvedPoint(
        ptMeta,
        gatherCandidateNodeIds(),
        'ambiguous_multiple_candidate_nodes'
      );
      continue;
    }

    const anchorRefPoint = anchorVertexPos ?? ptMeta.point;
    const allHits = findAllLocalEdgeGroupIntersections2D(
      layerRoads.map((r) => r.edge),
      layerRails.map((rl) => rl.edge),
      ptMeta.point,
      DEFAULT_NODE_SNAP_TOLERANCE_METERS
    );
    if (allHits.length === 0) {
      recordUnresolvedPoint(
        ptMeta,
        gatherCandidateNodeIds(),
        'insufficient_topological_evidence'
      );
      continue;
    }

    // Sort hits by proximity to the verified anchor vertex (or ptMeta.point fallback)
    const hitsNearAnchor = allHits
      .map((h) => ({
        ...h,
        distToAnchor: Math.hypot(h.point[0] - anchorRefPoint[0], h.point[1] - anchorRefPoint[1]),
      }))
      .sort((a, b) => a.distToAnchor - b.distToAnchor);

    const closestHit = hitsNearAnchor[0];
    if (hitsNearAnchor.length > 1) {
      const runnerUp = hitsNearAnchor[1];
      // If multiple intersections cannot be associated unambiguously with the verified anchor (e.g. equidistant within tolerance), emit an unresolved diagnostic
      if (Math.abs(closestHit.distToAnchor - runnerUp.distToAnchor) <= 0.02) {
        recordUnresolvedPoint(
          ptMeta,
          gatherCandidateNodeIds(),
          'ambiguous_multiple_candidate_nodes'
        );
        continue;
      }
    }

    const crossingHit: LocalGroupCrossingHit = {
      point: closestHit.point,
      crossingAngleRad: closestHit.crossingAngleRad,
      distanceToRef: closestHit.distanceToRef,
    };

    const chosenRoad = pickCanonicalEdgeForNodeCrossing(layerRoads, roadNode?.id);
    const chosenRail = pickCanonicalEdgeForNodeCrossing(layerRails, railNode?.id);

    // Check tier compatibility
    const tierConflict =
      (ptMeta.kind === 'railway_level_crossing' && chosenRoad.edge.tier !== 'vehicular') ||
      (ptMeta.kind === 'railway_ped_crossing' && chosenRoad.edge.tier !== 'path');

    if (tierConflict) {
      recordUnresolvedPoint(
        ptMeta,
        gatherCandidateNodeIds(),
        'conflicting_crossing_tag_and_road_tier'
      );
      addUnresolvedCrossingOnce({
        kind: chosenRoad.edge.tier === 'path' ? 'pedestrian_rail' : 'road_rail',
        position: [crossingHit.point[0], crossingHit.point[1]],
        edgeAId: chosenRoad.edge.id,
        edgeBId: chosenRail.edge.id,
        reason: 'conflicting_crossing_tag_and_road_tier',
      });
      markRoadRailPairEventHandled(
        layerRoads.map((r) => r.edge.id),
        layerRails.map((rl) => rl.edge.id),
        targetLayer,
        crossingHit.point
      );
      continue;
    }

    const crossingKind: LevelCrossingRelation['crossingKind'] =
      ptMeta.kind === 'railway_ped_crossing'
        ? 'pedestrian_rail_crossing'
        : 'road_rail_level_crossing';
    const roadProjAtCrossing = projectPointOntoEdge(crossingHit.point, chosenRoad.edge);
    const railProjAtCrossing = projectPointOntoEdge(crossingHit.point, chosenRail.edge);
    const crossingAngleRad = crossingHit.crossingAngleRad;
    const pointOsmTags = cloneOsmTags(ptMeta.osmTags);
    const relId = `level_crossing:${chosenRoad.edge.id}__${chosenRail.edge.id}:pt_${ptMeta.id}`;

    levelCrossings.push({
      id: relId,
      crossingKind,
      position: [crossingHit.point[0], crossingHit.point[1]],
      rawOsmNodeId: ptMeta.rawOsmNodeId,
      roadEdgeId: chosenRoad.edge.id,
      roadNodeId: roadNode?.id,
      roadArcLengthMeters: roadProjAtCrossing.arcLengthMeters,
      railwayEdgeId: chosenRail.edge.id,
      railwayNodeId: railNode?.id,
      railwayArcLengthMeters: railProjAtCrossing.arcLengthMeters,
      crossingAngleRad,
      confidence: 'explicit_osm_crossing_tag',
      pointOsmTags,
    });

    if (roadNode) {
      confirmedRoadLevelCrossingNodeTags.set(roadNode.id, pointOsmTags);
    }
    if (railNode) {
      confirmedRailwayLevelCrossingNodeTags.set(railNode.id, pointOsmTags);
    }

    markRoadRailPairEventHandled(
      layerRoads.map((r) => r.edge.id),
      layerRails.map((rl) => rl.edge.id),
      targetLayer,
      crossingHit.point
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Grade Transitions (`GradeTransitionRelation[]` & `UnresolvedGradeTransitionCandidate[]`)
  // ---------------------------------------------------------------------------
  const roadGradeResult = analyzeDomainGradeTransitions<RoadNode, RoadEdge>(
    'road',
    roads,
    roadSegmentIndex,
    (atGrade, gradeSeparated) => atGrade.tier === gradeSeparated.tier
  );

  const railGradeResult = analyzeDomainGradeTransitions<RailwayNode, RailwayEdge>(
    'railway',
    railways,
    railSegmentIndex,
    (atGrade, gradeSeparated) => atGrade.railwayType === gradeSeparated.railwayType
  );

  const gradeTransitions: GradeTransitionRelation[] = [
    ...roadGradeResult.gradeTransitions,
    ...railGradeResult.gradeTransitions,
  ].sort((a, b) => compareStringsCodeUnit(a.id, b.id));

  const unresolvedGradeTransitions: UnresolvedGradeTransitionCandidate[] = [
    ...roadGradeResult.unresolvedGradeTransitions,
    ...railGradeResult.unresolvedGradeTransitions,
  ];

  // Build set of edge pairs connected at confirmed grade transitions so portal junctions
  // are never mistaken for grade-separated overpass crossings
  const gradeTransitionEdgePairs = new Set<string>();
  for (const gt of gradeTransitions) {
    const u = gt.atGradeEdgeId;
    const v = gt.gradeSeparatedEdgeId;
    gradeTransitionEdgePairs.add(u <= v ? `${u}||${v}` : `${v}||${u}`);
  }

  // ---------------------------------------------------------------------------
  // 3A. Cross-Modal Road x Railway 2D Segment Intersections & Coincident Vertices
  //     (Unresolved At-Grade Crossings & Grade-Separated Crossings)
  // ---------------------------------------------------------------------------
  for (const roadSeg of roadSegmentIndex.allSegments) {
    const pad = DEFAULT_NODE_SNAP_TOLERANCE_METERS;
    const candidateRailSegs = railSegmentIndex.queryBox(
      roadSeg.minX - pad,
      roadSeg.minZ - pad,
      roadSeg.maxX + pad,
      roadSeg.maxZ + pad
    );

    for (const railSeg of candidateRailSegs) {
      const roadEdge = roadSeg.edge;
      const railEdge = railSeg.edge;
      const vertSep = classifyVerticalSeparation(roadEdge, railEdge);

      if (vertSep.status === 'separated') {
        const hit = intersectIndexedSegments2D(roadSeg, railSeg);
        if (hit) {
          addGradeSeparatedCrossingOnce(vertSep.upper, vertSep.lower, hit.point);
        }
        continue;
      }

      if (vertSep.status === 'contradictory') {
        const hit = intersectIndexedSegments2D(roadSeg, railSeg);
        if (hit) {
          addUnresolvedCrossingOnce({
            kind: roadEdge.tier === 'path' ? 'pedestrian_rail' : 'road_rail',
            position: hit.point,
            edgeAId: roadEdge.id,
            edgeBId: railEdge.id,
            reason: 'geometric_intersection_without_shared_node',
          });
        }
        continue;
      }

      // Same vertical scope: check for unconfirmed at-grade road x rail crossings
      if (roadEdge.isBridge || roadEdge.isTunnel || railEdge.isBridge || railEdge.isTunnel) {
        continue;
      }

      // Check coincident segment vertices within 0.15 m first
      const roadVers: Array<{ pt: [number, number]; idx: number }> = [
        { pt: roadSeg.p0, idx: roadSeg.segmentIndex },
        { pt: roadSeg.p1, idx: roadSeg.segmentIndex + 1 },
      ];
      const railVers: Array<{ pt: [number, number]; idx: number }> = [
        { pt: railSeg.p0, idx: railSeg.segmentIndex },
        { pt: railSeg.p1, idx: railSeg.segmentIndex + 1 },
      ];

      let foundCoincidentVertex = false;
      for (const rv of roadVers) {
        for (const rlv of railVers) {
          const d = Math.hypot(rv.pt[0] - rlv.pt[0], rv.pt[1] - rlv.pt[1]);
          if (d <= DEFAULT_NODE_SNAP_TOLERANCE_METERS) {
            foundCoincidentVertex = true;
            const midPt: [number, number] = [
              (rv.pt[0] + rlv.pt[0]) * 0.5,
              (rv.pt[1] + rlv.pt[1]) * 0.5,
            ];
            if (
              !isRoadRailPairEventAlreadyHandled(
                roadEdge.id,
                railEdge.id,
                roadEdge.layer,
                midPt
              )
            ) {
              addUnresolvedCrossingOnce({
                kind: roadEdge.tier === 'path' ? 'pedestrian_rail' : 'road_rail',
                position: midPt,
                edgeAId: roadEdge.id,
                edgeBId: railEdge.id,
                reason: 'coincident_vertex_without_osm_id',
              });
            }
          }
        }
      }

      if (foundCoincidentVertex) {
        continue;
      }

      const hit = intersectIndexedSegments2D(roadSeg, railSeg);
      if (
        hit &&
        !isRoadRailPairEventAlreadyHandled(
          roadEdge.id,
          railEdge.id,
          roadEdge.layer,
          hit.point
        )
      ) {
        addUnresolvedCrossingOnce({
          kind: roadEdge.tier === 'path' ? 'pedestrian_rail' : 'road_rail',
          position: hit.point,
          edgeAId: roadEdge.id,
          edgeBId: railEdge.id,
          reason: 'geometric_intersection_without_shared_node',
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Same-Domain Road x Road & Railway x Railway 2D Crossings (T-04 & Overpasses)
  // ---------------------------------------------------------------------------
  const analyzeSameDomainPairings = <
    TNode extends BaseInfrastructureNode<string>,
    TEdge extends BaseInfrastructureEdge,
  >(
    domainKind: 'road_road' | 'rail_rail',
    network: { nodes: ReadonlyMap<string, TNode>; edges: ReadonlyMap<string, TEdge> },
    segIndex: SegmentSpatialIndex<TEdge>,
    confirmedFlatCrossings: readonly RailwayFlatCrossingRelation[]
  ) => {
    for (const segA of segIndex.allSegments) {
      const candidates = segIndex.queryBox(segA.minX, segA.minZ, segA.maxX, segA.maxZ);
      for (const segB of candidates) {
        if (compareStringsCodeUnit(segA.edge.id, segB.edge.id) >= 0) continue;

        const edgeA = segA.edge;
        const edgeB = segB.edge;
        const pairKey = `${edgeA.id}||${edgeB.id}`;
        if (gradeTransitionEdgePairs.has(pairKey)) continue;

        const hit = intersectIndexedSegments2D(segA, segB);
        if (!hit) continue;

        const vertSep = classifyVerticalSeparation(edgeA, edgeB);
        if (vertSep.status === 'separated') {
          // Ensure the intersection is not simply at a shared portal endpoint coordinates
          const aStartDist = Math.hypot(
            hit.point[0] - edgeA.points[0][0],
            hit.point[1] - edgeA.points[0][1]
          );
          const aEndDist = Math.hypot(
            hit.point[0] - edgeA.points[edgeA.points.length - 1][0],
            hit.point[1] - edgeA.points[edgeA.points.length - 1][1]
          );
          const bStartDist = Math.hypot(
            hit.point[0] - edgeB.points[0][0],
            hit.point[1] - edgeB.points[0][1]
          );
          const bEndDist = Math.hypot(
            hit.point[0] - edgeB.points[edgeB.points.length - 1][0],
            hit.point[1] - edgeB.points[edgeB.points.length - 1][1]
          );
          const isSharedEndpointTouch =
            Math.min(aStartDist, aEndDist) <= DEFAULT_NODE_SNAP_TOLERANCE_METERS &&
            Math.min(bStartDist, bEndDist) <= DEFAULT_NODE_SNAP_TOLERANCE_METERS;
          if (!isSharedEndpointTouch) {
            addGradeSeparatedCrossingOnce(vertSep.upper, vertSep.lower, hit.point);
          }
          continue;
        }

        // Same vertical scope (or contradictory): check if the intersection is already represented by a shared node
        const sharedNodeIds = [edgeA.fromNodeId, edgeA.toNodeId].filter(
          (nid) => nid === edgeB.fromNodeId || nid === edgeB.toNodeId
        );
        let isAtSharedTopologicalNode = false;
        for (const nid of sharedNodeIds) {
          const node = network.nodes.get(nid);
          if (
            node &&
            Math.hypot(node.x - hit.point[0], node.z - hit.point[1]) <=
              DEFAULT_NODE_SNAP_TOLERANCE_METERS * 2
          ) {
            isAtSharedTopologicalNode = true;
            break;
          }
        }
        if (isAtSharedTopologicalNode) continue;

        // For rail_rail, check if already resolved as a Stage C RailwayFlatCrossingRelation on this edge pair
        if (domainKind === 'rail_rail') {
          const isConfirmedFlat = confirmedFlatCrossings.some((fc) => {
            const matchesPair =
              (fc.trackAEdgeId === edgeA.id && fc.trackBEdgeId === edgeB.id) ||
              (fc.trackAEdgeId === edgeB.id && fc.trackBEdgeId === edgeA.id);
            return (
              matchesPair &&
              Math.hypot(fc.position[0] - hit.point[0], fc.position[1] - hit.point[1]) <=
                DEFAULT_NODE_SNAP_TOLERANCE_METERS * 2
            );
          });
          if (isConfirmedFlat) continue;
        }

        addUnresolvedCrossingOnce({
          kind: domainKind,
          position: hit.point,
          edgeAId: edgeA.id,
          edgeBId: edgeB.id,
          reason: 'geometric_intersection_without_shared_node',
        });
      }
    }
  };

  analyzeSameDomainPairings('road_road', roads, roadSegmentIndex, []);
  analyzeSameDomainPairings(
    'rail_rail',
    railways,
    railSegmentIndex,
    input.railwayFlatCrossings ?? []
  );

  // Canonical sorting of all output collections
  levelCrossings.sort((a, b) => compareStringsCodeUnit(a.id, b.id));
  gradeSeparatedCrossings.sort((a, b) => compareStringsCodeUnit(a.id, b.id));
  unresolvedCrossings.sort((a, b) => {
    const kCmp = compareStringsCodeUnit(a.kind, b.kind);
    if (kCmp !== 0) return kCmp;
    const aCmp = compareStringsCodeUnit(a.edgeAId, b.edgeAId);
    if (aCmp !== 0) return aCmp;
    const bCmp = compareStringsCodeUnit(a.edgeBId, b.edgeBId);
    if (bCmp !== 0) return bCmp;
    const rCmp = compareStringsCodeUnit(a.reason, b.reason);
    if (rCmp !== 0) return rCmp;
    if (Math.abs(a.position[0] - b.position[0]) > 1e-6) {
      return a.position[0] - b.position[0];
    }
    return a.position[1] - b.position[1];
  });
  unresolvedInfrastructurePoints.sort((a, b) => compareStringsCodeUnit(a.pointId, b.pointId));

  return {
    levelCrossings,
    gradeTransitions,
    gradeSeparatedCrossings,
    unresolvedCrossings,
    unresolvedGradeTransitions,
    unresolvedInfrastructurePoints,
    confirmedRoadLevelCrossingNodeTags,
    confirmedRailwayLevelCrossingNodeTags,
  };
}
