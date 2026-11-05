import {
  ProcessedMapData,
  RawGeoJsonProperties,
  RailwayType,
} from '../../../types/MapFeature';
import {
  DEFAULT_NODE_SNAP_TOLERANCE_METERS,
  TopologicalNodeIndex,
} from '../../TopologicalNodeIndex';
import {
  areVerticesAndNodeIdsEqual,
  cloneOsmTags,
  comparePointArraysMillimeter,
  compareStringsCodeUnit,
  computeCumulativeLengths,
  computeEndInwardTangent,
  computeStartInwardTangent,
  getCanonicalMeaningfulOsmTagsString,
} from './RoadNetworkBuilder';
import {
  EdgeProvenance,
  EdgeSegmentProvenance,
  IncidentHalfEdge,
  InfrastructurePointMetadata,
  NodeIdOrigin,
  RailwayEdge,
  RailwayFlatCrossingRelation,
  RailwayNetwork,
  RailwayNetworkBuildResult,
  RailwayNetworkDiagnostics,
  RailwayNode,
  RailwayNodeRole,
  TopologySourceData,
  TurnoutTopologySpec,
  UnchainedRailwayPart,
  UnresolvedCrossingCandidate,
} from './types';

const SECONDARY_SERVICE_SET = new Set<string>(['siding', 'yard', 'spur', 'crossover']);
const SECONDARY_USAGE_SET = new Set<string>([
  'branch',
  'industrial',
  'military',
  'test',
  'tourism',
]);

// Angular thresholds from ADR-0009 Section 5.1 & 5.2
const COS_15_DEG = Math.cos((15 * Math.PI) / 180); // ~0.9659258 (flat crossing collinearity)
const MIN_TAGGED_FLAT_CROSSING_ANGLE_RAD = (1.5 * Math.PI) / 180; // 1.5 deg minimum for explicit railway=railway_crossing (1:9 to 1:18 crossovers)
const MIN_UNTAGGED_FLAT_CROSSING_ANGLE_RAD = (10 * Math.PI) / 180; // 10 deg minimum for untagged shared-OSM-node diamond crossings
const COS_45_DEG = Math.cos((45 * Math.PI) / 180); // ~0.7071068 (turnout heel-facing hemisphere)
const COS_60_DEG = Math.cos((60 * Math.PI) / 180); // 0.5 (turnout forward toe cone)
const MAX_SECONDARY_MAINLINE_OVERSHOOT_RAD = (5 * Math.PI) / 180; // 5 deg
const MIN_ASYMMETRIC_TURNOUT_DIFF_RAD = (3 * Math.PI) / 180; // 3 deg main vs diverging deflection gap

/**
 * Classifies whether a railway track is a secondary branch (`service=siding|yard|spur|crossover`
 * or `usage=branch|industrial|military|test|tourism`) per ADR-0009 Section 5.2.
 */
export function isSecondaryRailwayBranch(service?: string, usage?: string): boolean {
  if (service && SECONDARY_SERVICE_SET.has(service.trim().toLowerCase())) {
    return true;
  }
  if (usage && SECONDARY_USAGE_SET.has(usage.trim().toLowerCase())) {
    return true;
  }
  return false;
}

function normalizeOptionalString(val: unknown): string | undefined {
  if (val === undefined || val === null) return undefined;
  const trimmed = String(val).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripNodePrefix(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('node/')) {
    const rest = trimmed.slice(5).trim();
    return rest.length > 0 ? rest : undefined;
  }
  if (trimmed.startsWith('osm_')) {
    const rest = trimmed.slice(4).trim();
    return rest.length > 0 ? rest : undefined;
  }
  return trimmed;
}

function extractInputRailwayParts(
  input: ProcessedMapData | TopologySourceData | readonly UnchainedRailwayPart[]
): UnchainedRailwayPart[] {
  let rawParts: readonly UnchainedRailwayPart[];

  if (Array.isArray(input)) {
    rawParts = input;
  } else if ('railwayParts' in input && Array.isArray((input as TopologySourceData).railwayParts)) {
    rawParts = (input as TopologySourceData).railwayParts;
  } else {
    const mapData = input as ProcessedMapData;
    if (
      mapData.topologySource &&
      Array.isArray(mapData.topologySource.railwayParts) &&
      (mapData.topologySource.railwayParts.length > 0 || (mapData.railways || []).length === 0)
    ) {
      rawParts = mapData.topologySource.railwayParts;
    } else {
      // Fallback adapter for synthetic ProcessedMapData literals constructed directly in tests
      rawParts = (mapData.railways || []).map((rw, idx) => {
        const sourceId = rw.sourceFeatureId || rw.id || `feat-${idx + 1}`;
        const hasExplicit = !/^feat-\d+$/.test(sourceId);
        const rawNodeIds: (string | undefined)[] = rw.points.map((_, pIdx) => {
          const nid = rw.nodeIds && pIdx < rw.nodeIds.length ? rw.nodeIds[pIdx] : undefined;
          if (nid === undefined || nid === null) return undefined;
          const s = String(nid).trim();
          if (!s || s.startsWith('tn_')) return undefined;
          if (s.includes('|osm_')) return s.split('|osm_').pop();
          if (s.startsWith('osm_')) return s.slice(4);
          return s;
        });
        const tags = cloneOsmTags(rw.osmTags);
        const gauge =
          normalizeOptionalString(tags.gauge) ??
          (rw.gauge !== undefined ? String(rw.gauge) : undefined);
        const electrified =
          normalizeOptionalString(tags.electrified) ??
          (rw.electrified !== undefined ? (rw.electrified ? 'yes' : 'no') : undefined);
        const service = normalizeOptionalString(tags.service);
        const usage = normalizeOptionalString(tags.usage);
        return {
          id: rw.id || `${sourceId}-0`,
          sourceFeatureId: sourceId,
          hasExplicitSourceId: hasExplicit,
          partIndex: 0,
          points: rw.points.map((pt) => [pt[0], pt[1]] as [number, number]),
          rawOsmNodeIds: rawNodeIds,
          clippedAtStart: false,
          clippedAtEnd: false,
          railwayType: rw.railwayType,
          width: rw.width,
          layer: rw.layer ?? 0,
          isBridge: Boolean(rw.isBridge),
          isTunnel: Boolean(rw.isTunnel),
          name: rw.name,
          gauge,
          electrified,
          service,
          usage,
          isSecondaryBranch: isSecondaryRailwayBranch(service, usage),
          osmTags: tags,
        };
      });
    }
  }

  return rawParts
    .filter((p) => Array.isArray(p.points) && p.points.length >= 2)
    .map((p) => {
      const pts: [number, number][] = p.points.map((pt) => [Number(pt[0]), Number(pt[1])]);
      const rawNodes: (string | undefined)[] = pts.map((_, idx) => {
        const val =
          p.rawOsmNodeIds && idx < p.rawOsmNodeIds.length ? p.rawOsmNodeIds[idx] : undefined;
        if (val === undefined || val === null) return undefined;
        const trimmed = String(val).trim();
        return trimmed.length > 0 ? trimmed : undefined;
      });
      if (p.clippedAtStart && rawNodes.length > 0) {
        rawNodes[0] = undefined;
      }
      if (p.clippedAtEnd && rawNodes.length > 0) {
        rawNodes[rawNodes.length - 1] = undefined;
      }
      const tags = cloneOsmTags(p.osmTags);
      const gauge = normalizeOptionalString(p.gauge ?? tags.gauge);
      const electrified = normalizeOptionalString(p.electrified ?? tags.electrified);
      const service = normalizeOptionalString(p.service ?? tags.service);
      const usage = normalizeOptionalString(p.usage ?? tags.usage);
      const isSecondary =
        typeof p.isSecondaryBranch === 'boolean'
          ? p.isSecondaryBranch
          : isSecondaryRailwayBranch(service, usage);

      return {
        ...p,
        points: pts,
        rawOsmNodeIds: rawNodes,
        gauge,
        electrified,
        service,
        usage,
        isSecondaryBranch: isSecondary,
        osmTags: tags,
      };
    });
}

function extractInputInfrastructurePoints(
  input: ProcessedMapData | TopologySourceData | readonly UnchainedRailwayPart[],
  explicitPoints?: readonly InfrastructurePointMetadata[]
): InfrastructurePointMetadata[] {
  let rawPoints: readonly InfrastructurePointMetadata[] = [];
  if (Array.isArray(explicitPoints)) {
    rawPoints = explicitPoints;
  } else if (!Array.isArray(input)) {
    if ('infrastructurePoints' in input && Array.isArray(input.infrastructurePoints)) {
      rawPoints = input.infrastructurePoints;
    } else if (
      'topologySource' in input &&
      input.topologySource &&
      Array.isArray(input.topologySource.infrastructurePoints)
    ) {
      rawPoints = input.topologySource.infrastructurePoints;
    }
  }

  return rawPoints
    .filter(
      (pt) =>
        pt &&
        (pt.kind === 'railway_switch' || pt.kind === 'railway_crossing_flat') &&
        Array.isArray(pt.point) &&
        pt.point.length >= 2 &&
        Number.isFinite(pt.point[0]) &&
        Number.isFinite(pt.point[1])
    )
    .map((pt) => ({
      id: String(pt.id),
      hasExplicitSourceId: Boolean(pt.hasExplicitSourceId),
      rawOsmNodeId: normalizeOptionalString(pt.rawOsmNodeId),
      point: [Number(pt.point[0]), Number(pt.point[1])] as [number, number],
      kind: pt.kind,
      osmTags: cloneOsmTags(pt.osmTags),
    }))
    .sort(compareInfrastructurePointsCanonically);
}

function compareInfrastructurePointsCanonically(
  a: InfrastructurePointMetadata,
  b: InfrastructurePointMetadata
): number {
  const kindCmp = compareStringsCodeUnit(a.kind, b.kind);
  if (kindCmp !== 0) return kindCmp;
  const aExp = a.hasExplicitSourceId ? 0 : 1;
  const bExp = b.hasExplicitSourceId ? 0 : 1;
  if (aExp !== bExp) return aExp - bExp;
  const osmCmp = compareStringsCodeUnit(a.rawOsmNodeId ?? '', b.rawOsmNodeId ?? '');
  if (osmCmp !== 0) return osmCmp;
  const dx = Math.round(a.point[0] * 1000) - Math.round(b.point[0] * 1000);
  if (dx !== 0) return dx;
  const dz = Math.round(a.point[1] * 1000) - Math.round(b.point[1] * 1000);
  if (dz !== 0) return dz;
  return compareStringsCodeUnit(a.id, b.id);
}

function compareRailwayPartsCanonically(a: UnchainedRailwayPart, b: UnchainedRailwayPart): number {
  if (a.layer !== b.layer) return a.layer - b.layer;
  const aBridge = a.isBridge ? 1 : 0;
  const bBridge = b.isBridge ? 1 : 0;
  if (aBridge !== bBridge) return aBridge - bBridge;
  const aTunnel = a.isTunnel ? 1 : 0;
  const bTunnel = b.isTunnel ? 1 : 0;
  if (aTunnel !== bTunnel) return aTunnel - bTunnel;

  const aExp = a.hasExplicitSourceId ? 0 : 1;
  const bExp = b.hasExplicitSourceId ? 0 : 1;
  if (aExp !== bExp) return aExp - bExp;

  if (a.hasExplicitSourceId && b.hasExplicitSourceId) {
    const idCmp = compareStringsCodeUnit(a.sourceFeatureId, b.sourceFeatureId);
    if (idCmp !== 0) return idCmp;
    if (a.partIndex !== b.partIndex) return a.partIndex - b.partIndex;
  }

  const geomCmp = comparePointArraysMillimeter(a.points, b.points);
  if (geomCmp !== 0) return geomCmp;

  const typeCmp = compareStringsCodeUnit(String(a.railwayType), String(b.railwayType));
  if (typeCmp !== 0) return typeCmp;

  const wCmp = Math.round(a.width * 10) - Math.round(b.width * 10);
  if (wCmp !== 0) return wCmp;

  const gaugeCmp = compareStringsCodeUnit(a.gauge ?? '', b.gauge ?? '');
  if (gaugeCmp !== 0) return gaugeCmp;

  const elecCmp = compareStringsCodeUnit(a.electrified ?? '', b.electrified ?? '');
  if (elecCmp !== 0) return elecCmp;

  const srvCmp = compareStringsCodeUnit(a.service ?? '', b.service ?? '');
  if (srvCmp !== 0) return srvCmp;

  const usgCmp = compareStringsCodeUnit(a.usage ?? '', b.usage ?? '');
  if (usgCmp !== 0) return usgCmp;

  const tagCmp = compareStringsCodeUnit(
    getCanonicalMeaningfulOsmTagsString(a.osmTags),
    getCanonicalMeaningfulOsmTagsString(b.osmTags)
  );
  if (tagCmp !== 0) return tagCmp;

  const srcCmp = compareStringsCodeUnit(a.sourceFeatureId, b.sourceFeatureId);
  if (srcCmp !== 0) return srcCmp;
  if (a.partIndex !== b.partIndex) return a.partIndex - b.partIndex;
  return compareStringsCodeUnit(a.id, b.id);
}

interface DeduplicatedRailwayPart {
  part: UnchainedRailwayPart;
  canonicalOrder: number;
  deduplicatedFeatureIds: string[];
  mutablePoints: [number, number][];
  mutableRawOsmNodeIds: (string | undefined)[];
}

interface InternalRailwayNodeRecord {
  id: string;
  rawOsmNodeId?: string;
  nodeIdOrigin: NodeIdOrigin;
  x: number;
  z: number;
  layer: number;
  isBridge: boolean;
  isTunnel: boolean;
  isBoundaryClipped: boolean;
  isAttributeBreak: boolean;
  isLoopAnchor: boolean;
  isDecoupledFlatCrossingTrackNode: boolean;
  switchPointMeta?: InfrastructurePointMetadata;
  flatCrossingPointMeta?: InfrastructurePointMetadata;
}

interface DraftRailwayEdge {
  draftId: number;
  canonicalOrder: number;
  fromNodeId: string;
  toNodeId: string;
  points: [number, number][];
  vertexRawOsmNodeIds: (string | undefined)[];
  lengthMeters: number;
  layer: number;
  isBridge: boolean;
  isTunnel: boolean;
  clippedAtStart: boolean;
  clippedAtEnd: boolean;
  railwayType: RailwayType;
  width: number;
  gauge?: string;
  electrified?: string;
  service?: string;
  usage?: string;
  isSecondaryBranch: boolean;
  name?: string;
  segments: EdgeSegmentProvenance[];
}

function reverseDraftRailwayEdge(edge: DraftRailwayEdge): DraftRailwayEdge {
  const totalLen = edge.lengthMeters;
  const maxVertexIdx = edge.points.length - 1;
  const reversedPoints = [...edge.points].reverse();
  const reversedNodeIds = [...edge.vertexRawOsmNodeIds].reverse();

  const reversedSegments: EdgeSegmentProvenance[] = [...edge.segments]
    .reverse()
    .map((seg) => ({
      partId: seg.partId,
      sourceFeatureId: seg.sourceFeatureId,
      deduplicatedFeatureIds: seg.deduplicatedFeatureIds,
      startArcLength: Math.max(0, totalLen - seg.endArcLength),
      endArcLength: Math.min(totalLen, totalLen - seg.startArcLength),
      startVertexIndex: maxVertexIdx - seg.endVertexIndex,
      endVertexIndex: maxVertexIdx - seg.startVertexIndex,
      sourceStartVertexIndex: seg.sourceEndVertexIndex,
      sourceEndVertexIndex: seg.sourceStartVertexIndex,
      reversedRelativeToSource: !seg.reversedRelativeToSource,
      osmTags: seg.osmTags,
    }));

  return {
    ...edge,
    fromNodeId: edge.toNodeId,
    toNodeId: edge.fromNodeId,
    points: reversedPoints,
    vertexRawOsmNodeIds: reversedNodeIds,
    clippedAtStart: edge.clippedAtEnd,
    clippedAtEnd: edge.clippedAtStart,
    segments: reversedSegments,
  };
}

function concatenateDraftRailwayEdges(
  left: DraftRailwayEdge,
  right: DraftRailwayEdge
): DraftRailwayEdge {
  const arcOffset = left.lengthMeters;
  const vertexOffset = left.points.length - 1;

  const combinedPoints: [number, number][] = [...left.points, ...right.points.slice(1)];
  const combinedRawOsmNodeIds: (string | undefined)[] = [
    ...left.vertexRawOsmNodeIds,
    ...right.vertexRawOsmNodeIds.slice(1),
  ];
  if (
    combinedRawOsmNodeIds[vertexOffset] === undefined &&
    right.vertexRawOsmNodeIds[0] !== undefined
  ) {
    combinedRawOsmNodeIds[vertexOffset] = right.vertexRawOsmNodeIds[0];
  }

  const shiftedRightSegments: EdgeSegmentProvenance[] = right.segments.map((seg) => ({
    ...seg,
    startArcLength: arcOffset + seg.startArcLength,
    endArcLength: arcOffset + seg.endArcLength,
    startVertexIndex: vertexOffset + seg.startVertexIndex,
    endVertexIndex: vertexOffset + seg.endVertexIndex,
  }));

  return {
    ...left,
    toNodeId: right.toNodeId,
    points: combinedPoints,
    vertexRawOsmNodeIds: combinedRawOsmNodeIds,
    lengthMeters: left.lengthMeters + right.lengthMeters,
    clippedAtEnd: right.clippedAtEnd,
    canonicalOrder: Math.min(left.canonicalOrder, right.canonicalOrder),
    segments: [...left.segments, ...shiftedRightSegments],
  };
}

function areParallelDraftRailwayEdges(e1: DraftRailwayEdge, e2: DraftRailwayEdge): boolean {
  return (
    (e1.fromNodeId === e2.fromNodeId && e1.toNodeId === e2.toNodeId) ||
    (e1.fromNodeId === e2.toNodeId && e1.toNodeId === e2.fromNodeId)
  );
}

function haveIdenticalRailwayAttributes(e1: DraftRailwayEdge, e2: DraftRailwayEdge): boolean {
  return (
    e1.layer === e2.layer &&
    e1.isBridge === e2.isBridge &&
    e1.isTunnel === e2.isTunnel &&
    e1.railwayType === e2.railwayType &&
    Math.round(e1.width * 10) === Math.round(e2.width * 10) &&
    (e1.gauge ?? '').trim().toLowerCase() === (e2.gauge ?? '').trim().toLowerCase() &&
    (e1.electrified ?? '').trim().toLowerCase() === (e2.electrified ?? '').trim().toLowerCase() &&
    (e1.service ?? '').trim().toLowerCase() === (e2.service ?? '').trim().toLowerCase() &&
    (e1.usage ?? '').trim().toLowerCase() === (e2.usage ?? '').trim().toLowerCase() &&
    e1.isSecondaryBranch === e2.isSecondaryBranch &&
    (e1.name ?? '').trim().toLowerCase() === (e2.name ?? '').trim().toLowerCase()
  );
}

function getEdgeInwardTangentAtNode(
  edge: { fromNodeId: string; toNodeId: string; points: readonly [number, number][] },
  nodeId: string,
  endpointHint?: 'start' | 'end'
): [number, number] {
  if (endpointHint === 'start' || (endpointHint === undefined && edge.fromNodeId === nodeId)) {
    return computeStartInwardTangent(edge.points);
  }
  return computeEndInwardTangent(edge.points);
}

function canContractDegree2RailwayNode(
  node: InternalRailwayNodeRecord,
  e1: DraftRailwayEdge,
  e2: DraftRailwayEdge
): boolean {
  if (node.isBoundaryClipped || node.isLoopAnchor) {
    return false;
  }
  if (e1.draftId === e2.draftId) {
    return false;
  }
  if (e1.fromNodeId === e1.toNodeId || e2.fromNodeId === e2.toNodeId) {
    return false;
  }
  if (areParallelDraftRailwayEdges(e1, e2)) {
    return false;
  }
  if (node.switchPointMeta !== undefined) {
    return false;
  }
  // Preserve standalone flat-crossing point annotations on a single track,
  // but allow decoupled flat-crossing track nodes to merge collinear segmented through-tracks.
  if (node.flatCrossingPointMeta !== undefined && !node.isDecoupledFlatCrossingTrackNode) {
    return false;
  }

  return haveIdenticalRailwayAttributes(e1, e2);
}

function compareRailwayAnchorCandidateNodes(
  a: InternalRailwayNodeRecord,
  b: InternalRailwayNodeRecord
): number {
  const aExp = a.nodeIdOrigin === 'explicit_osm' ? 0 : 1;
  const bExp = b.nodeIdOrigin === 'explicit_osm' ? 0 : 1;
  if (aExp !== bExp) return aExp - bExp;
  if (a.rawOsmNodeId !== undefined && b.rawOsmNodeId !== undefined) {
    const osmCmp = compareStringsCodeUnit(a.rawOsmNodeId, b.rawOsmNodeId);
    if (osmCmp !== 0) return osmCmp;
  }
  const dx = Math.round(a.x * 1000) - Math.round(b.x * 1000);
  if (dx !== 0) return dx;
  const dz = Math.round(a.z * 1000) - Math.round(b.z * 1000);
  if (dz !== 0) return dz;
  return compareStringsCodeUnit(a.id, b.id);
}

const RAILWAY_ROLE_PRIORITY: readonly RailwayNodeRole[] = [
  'switch',
  'railway_crossing',
  'junction',
  'grade_transition',
  'level_crossing',
  'pedestrian_crossing',
  'attribute_break',
  'loop_anchor',
  'boundary_clip',
  'buffer_stop',
];

function selectPrimaryRailwayNodeRole(roles: readonly RailwayNodeRole[]): RailwayNodeRole {
  for (const candidate of RAILWAY_ROLE_PRIORITY) {
    if (roles.includes(candidate)) {
      return candidate;
    }
  }
  return roles[0] ?? 'junction';
}

interface PartVertexOccurrence {
  partRecord: DeduplicatedRailwayPart;
  vertexIndex: number;
  isInterior: boolean;
}

interface TrackArm {
  partRecord: DeduplicatedRailwayPart;
  vertexIndex: number;
  direction: 'prev' | 'next';
  tangent: [number, number];
}

function computeArmTangent(
  points: readonly [number, number][],
  vertexIndex: number,
  direction: 'prev' | 'next'
): [number, number] {
  const origin = points[vertexIndex];
  if (direction === 'next') {
    for (let i = vertexIndex + 1; i < points.length; i++) {
      const dx = points[i][0] - origin[0];
      const dz = points[i][1] - origin[1];
      const len = Math.hypot(dx, dz);
      if (len > 1e-9) return [dx / len, dz / len];
    }
    return [1, 0];
  } else {
    for (let i = vertexIndex - 1; i >= 0; i--) {
      const dx = points[i][0] - origin[0];
      const dz = points[i][1] - origin[1];
      const len = Math.hypot(dx, dz);
      if (len > 1e-9) return [dx / len, dz / len];
    }
    return [-1, 0];
  }
}

function computeForwardTrackTangent(arm1: TrackArm, arm2: TrackArm): [number, number] {
  const dx = arm2.tangent[0] - arm1.tangent[0];
  const dz = arm2.tangent[1] - arm1.tangent[1];
  const len = Math.hypot(dx, dz);
  if (len > 1e-9) {
    return [dx / len, dz / len];
  }
  return arm2.tangent;
}

function computeCrossingAngleRad(tA: [number, number], tB: [number, number]): number {
  const absDot = Math.min(1, Math.max(0, Math.abs(tA[0] * tB[0] + tA[1] * tB[1])));
  return Math.acos(absDot);
}

interface PendingConfirmedFlatCrossing {
  originalNodeId: string;
  rawOsmNodeId?: string;
  position: [number, number];
  layer: number;
  confidence: 'explicit_railway_crossing_tag' | 'shared_osm_node_flat_crossing';
  pointOsmTags?: RawGeoJsonProperties;
  trackAPartIds: Set<string>;
  trackBPartIds: Set<string>;
  trackATangent: [number, number];
  trackBTangent: [number, number];
}

interface PendingUntaggedDegree4Candidate {
  nodeId: string;
  position: [number, number];
  trackAPartIds: Set<string>;
  trackBPartIds: Set<string>;
}

/**
 * Evaluates conservative turnout (1-to-2 switch) topology at a degree-3 railway node
 * per ADR-0009 Section 5.2.
 */
function evaluateDegree3TurnoutTopology(
  node: InternalRailwayNodeRecord,
  halfEdges: readonly IncidentHalfEdge[],
  finalEdges: ReadonlyMap<string, RailwayEdge>,
  incidentEdgeIds: readonly string[]
): TurnoutTopologySpec {
  if (halfEdges.length !== 3) {
    return { status: 'unresolved_throat', candidateEdgeIds: incidentEdgeIds };
  }

  const items = halfEdges.map((he) => {
    const edge = finalEdges.get(he.edgeId)!;
    return { halfEdge: he, edge, tangent: he.inwardTangent };
  });

  // ADR-0009 Section 5.2.1: A degree-3 node forms a valid 1-to-2 turnout throat iff
  // exactly one half-edge h_trunk opposes both other half-edges h_a, h_b
  // (t_trunk . t_a <= -cos(45 deg) and t_trunk . t_b <= -cos(45 deg)), while h_a and h_b
  // point into the same forward hemisphere (t_a . t_b >= cos(60 deg) = 0.5).
  const candidateHeelIndices: number[] = [];

  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const k = (i + 2) % 3;
    const ti = items[i].tangent;
    const tj = items[j].tangent;
    const tk = items[k].tangent;

    const dij = ti[0] * tj[0] + ti[1] * tj[1];
    const dik = ti[0] * tk[0] + ti[1] * tk[1];
    const djk = tj[0] * tk[0] + tj[1] * tk[1];

    const bothHeelFacing = dij <= -COS_45_DEG && dik <= -COS_45_DEG;
    const toesInForwardCone = djk >= COS_60_DEG;

    if (bothHeelFacing && toesInForwardCone) {
      candidateHeelIndices.push(i);
    }
  }

  if (candidateHeelIndices.length !== 1) {
    return { status: 'unresolved_throat', candidateEdgeIds: incidentEdgeIds };
  }

  const heelIdx = candidateHeelIndices[0];
  const jIdx = (heelIdx + 1) % 3;
  const kIdx = (heelIdx + 2) % 3;

  const heelItem = items[heelIdx];
  const itemJ = items[jIdx];
  const itemK = items[kIdx];

  const dij = Math.max(
    -1,
    Math.min(1, heelItem.tangent[0] * itemJ.tangent[0] + heelItem.tangent[1] * itemJ.tangent[1])
  );
  const dik = Math.max(
    -1,
    Math.min(1, heelItem.tangent[0] * itemK.tangent[0] + heelItem.tangent[1] * itemK.tangent[1])
  );

  // Deflection angle from straight continuation of trunk (0 rad = perfectly straight 180 deg)
  const deflectionJ = Math.acos(Math.max(-1, Math.min(1, -dij)));
  const deflectionK = Math.acos(Math.max(-1, Math.min(1, -dik)));
  const deflectionDiff = Math.abs(deflectionJ - deflectionK);

  let throughItem: typeof itemJ | undefined;
  let divergingItem: typeof itemJ | undefined;

  const jSec = itemJ.edge.isSecondaryBranch;
  const kSec = itemK.edge.isSecondaryBranch;

  // ADR-0009 Section 5.2.2:
  // 1. Secondary-branch vs mainline disambiguation (provided mainline deflection does not exceed secondary by > 5 deg)
  if (jSec !== kSec) {
    const mainCand = !jSec ? itemJ : itemK;
    const secCand = !jSec ? itemK : itemJ;
    const mainDefl = !jSec ? deflectionJ : deflectionK;
    const secDefl = !jSec ? deflectionK : deflectionJ;
    if (mainDefl <= secDefl + MAX_SECONDARY_MAINLINE_OVERSHOOT_RAD) {
      throughItem = mainCand;
      divergingItem = secCand;
    }
  }

  // 2. Angular deflection disambiguation (|delta_a - delta_b| >= 3 deg)
  if (!throughItem || !divergingItem) {
    if (deflectionDiff >= MIN_ASYMMETRIC_TURNOUT_DIFF_RAD) {
      if (deflectionJ <= deflectionK) {
        throughItem = itemJ;
        divergingItem = itemK;
      } else {
        throughItem = itemK;
        divergingItem = itemJ;
      }
    } else {
      return {
        status: 'unresolved_main_vs_diverging',
        trunkEdgeId: heelItem.edge.id,
        candidateEdgeIds: incidentEdgeIds,
      };
    }
  }

  const tThrough = throughItem.tangent;
  const tDiv = divergingItem.tangent;
  const divDot = Math.max(-1, Math.min(1, tThrough[0] * tDiv[0] + tThrough[1] * tDiv[1]));
  const divergenceAngleRad = Math.acos(divDot);

  // Check explicit OSM switch side tag first, otherwise compute geometrically in local [x=East, z=South]
  let turnoutSide: 'left' | 'right' | undefined;
  const switchTags = node.switchPointMeta?.osmTags;
  if (switchTags) {
    const rawSide = String(switchTags['railway:switch'] ?? switchTags.turnout_side ?? '')
      .trim()
      .toLowerCase();
    if (rawSide === 'left' || rawSide === 'right') {
      turnoutSide = rawSide;
    }
  }
  if (!turnoutSide) {
    const cross = tThrough[0] * tDiv[1] - tThrough[1] * tDiv[0];
    turnoutSide = cross < 0 ? 'left' : 'right';
  }

  return {
    status: 'confirmed',
    trunkEdgeId: heelItem.edge.id,
    mainBranchEdgeId: throughItem.edge.id,
    divergingBranchEdgeId: divergingItem.edge.id,
    turnoutSide,
    divergenceAngleRad,
    candidateEdgeIds: incidentEdgeIds,
  };
}

/**
 * Pure, deterministic Stage C Railway Network Graph builder (`ADR-0009`).
 * Constructs `RailwayNetwork`, `RailwayFlatCrossingRelation[]`, and `RailwayNetworkDiagnostics`
 * without mutating inputs and with zero React, Three.js, renderer, or WebGL dependencies.
 */
export function buildRailwayNetwork(
  input: ProcessedMapData | TopologySourceData | readonly UnchainedRailwayPart[],
  infrastructurePoints?: readonly InfrastructurePointMetadata[]
): RailwayNetworkBuildResult {
  const extractedParts = extractInputRailwayParts(input);
  const extractedPoints = extractInputInfrastructurePoints(input, infrastructurePoints);

  const unresolvedCrossings: UnresolvedCrossingCandidate[] = [];
  const diagnostics: RailwayNetworkDiagnostics = {
    inputPartCount: extractedParts.length,
    exactDeduplicatedCount: 0,
    railwayNodeCount: 0,
    railwayEdgeCount: 0,
    railwayConfirmedSwitchCount: 0,
    railwayUnresolvedSwitchCount: 0,
    railwayFlatCrossingCount: 0,
    railwayUnresolvedJunctionCount: 0,
    railwaySimplifiedDegree2Count: 0,
    railwayInteriorSplitCount: 0,
    railwayParallelEdgePairCount: 0,
    boundaryClippedNodeCount: 0,
    closedLoopEdgeCount: 0,
    unresolvedCrossings,
  };

  if (extractedParts.length === 0) {
    return {
      railways: {
        nodes: new Map(),
        edges: new Map(),
        featureToEdgeIds: new Map(),
      },
      railwayFlatCrossings: [],
      diagnostics,
    };
  }

  // 1. Canonical pre-sorting of input parts
  const sortedParts = [...extractedParts].sort(compareRailwayPartsCanonically);

  // 2. Strict geometric (1 mm) and semantic duplicate detection
  const dedupBuckets = new Map<string, DeduplicatedRailwayPart[]>();
  const retainedParts: DeduplicatedRailwayPart[] = [];

  for (let idx = 0; idx < sortedParts.length; idx++) {
    const part = sortedParts[idx];
    const canonicalTagsKey = getCanonicalMeaningfulOsmTagsString(part.osmTags);

    const bucketKey = [
      part.layer,
      part.isBridge ? 1 : 0,
      part.isTunnel ? 1 : 0,
      part.railwayType,
      Math.round(part.width * 10),
      (part.gauge ?? '').trim().toLowerCase(),
      (part.electrified ?? '').trim().toLowerCase(),
      (part.service ?? '').trim().toLowerCase(),
      (part.usage ?? '').trim().toLowerCase(),
      part.isSecondaryBranch ? 1 : 0,
      (part.name ?? '').trim().toLowerCase(),
      part.points.length,
      canonicalTagsKey,
    ].join('|');

    const bucket = dedupBuckets.get(bucketKey);
    let matchedExisting: DeduplicatedRailwayPart | undefined;
    let matchedReverse = false;

    if (bucket) {
      for (const candidate of bucket) {
        const forwardMatch =
          candidate.part.clippedAtStart === part.clippedAtStart &&
          candidate.part.clippedAtEnd === part.clippedAtEnd &&
          areVerticesAndNodeIdsEqual(
            candidate.mutablePoints,
            candidate.mutableRawOsmNodeIds,
            part.points,
            part.rawOsmNodeIds,
            false
          );

        if (forwardMatch) {
          matchedExisting = candidate;
          matchedReverse = false;
          break;
        }

        const reverseMatch =
          candidate.part.clippedAtStart === part.clippedAtEnd &&
          candidate.part.clippedAtEnd === part.clippedAtStart &&
          areVerticesAndNodeIdsEqual(
            candidate.mutablePoints,
            candidate.mutableRawOsmNodeIds,
            part.points,
            part.rawOsmNodeIds,
            true
          );

        if (reverseMatch) {
          matchedExisting = candidate;
          matchedReverse = true;
          break;
        }
      }
    }

    if (matchedExisting) {
      diagnostics.exactDeduplicatedCount++;
      if (
        part.sourceFeatureId !== matchedExisting.part.sourceFeatureId &&
        !matchedExisting.deduplicatedFeatureIds.includes(part.sourceFeatureId)
      ) {
        matchedExisting.deduplicatedFeatureIds.push(part.sourceFeatureId);
      }
      const n = matchedExisting.mutableRawOsmNodeIds.length;
      for (let i = 0; i < n; i++) {
        const srcIdx = matchedReverse ? n - 1 - i : i;
        if (
          matchedExisting.mutableRawOsmNodeIds[i] === undefined &&
          part.rawOsmNodeIds[srcIdx] !== undefined
        ) {
          matchedExisting.mutableRawOsmNodeIds[i] = part.rawOsmNodeIds[srcIdx];
        }
      }
      continue;
    }

    const record: DeduplicatedRailwayPart = {
      part,
      canonicalOrder: idx,
      deduplicatedFeatureIds: [],
      mutablePoints: part.points.map((pt) => [pt[0], pt[1]]),
      mutableRawOsmNodeIds: [...part.rawOsmNodeIds],
    };

    if (!bucket) {
      dedupBuckets.set(bucketKey, [record]);
    } else {
      bucket.push(record);
    }
    retainedParts.push(record);
  }

  // 3. Domain- and scope-isolated node registration using TopologicalNodeIndex
  const topoIndex = new TopologicalNodeIndex(DEFAULT_NODE_SNAP_TOLERANCE_METERS);
  const internalNodes = new Map<string, InternalRailwayNodeRecord>();
  const topoKeyToCanonicalId = new Map<string, string>();
  let fallbackSeq = 0;

  const getScopeKey = (p: UnchainedRailwayPart): string =>
    `${p.layer}|${p.isBridge ? 1 : 0}|${p.isTunnel ? 1 : 0}`;

  // Pass 3A: Register all explicit OSM node IDs first
  for (const item of retainedParts) {
    const { part, mutablePoints, mutableRawOsmNodeIds } = item;
    const scopeKey = getScopeKey(part);
    for (let i = 0; i < mutablePoints.length; i++) {
      const osmId = mutableRawOsmNodeIds[i];
      if (osmId !== undefined) {
        const pt = mutablePoints[i];
        topoIndex.getOrCreateNode(pt[0], pt[1], scopeKey, osmId);
      }
    }
  }

  // Pass 3B: Resolve canonical node IDs for every vertex of every retained part
  const partVertexNodeIds = new Map<string, string[]>();

  for (const item of retainedParts) {
    const { part, mutablePoints, mutableRawOsmNodeIds } = item;
    const scopeKey = getScopeKey(part);
    const n = mutablePoints.length;
    const resolvedIds: string[] = [];

    for (let i = 0; i < n; i++) {
      const pt = mutablePoints[i];
      const osmId = mutableRawOsmNodeIds[i];
      const isClippedStart = i === 0 && part.clippedAtStart && osmId === undefined;
      const isClippedEnd = i === n - 1 && part.clippedAtEnd && osmId === undefined;

      if (isClippedStart || isClippedEnd) {
        const endpointLabel = isClippedStart ? 'start' : 'end';
        const clipNodeId = `rail_node:${scopeKey}:clip_${part.id}_${endpointLabel}`;
        if (!internalNodes.has(clipNodeId)) {
          internalNodes.set(clipNodeId, {
            id: clipNodeId,
            rawOsmNodeId: undefined,
            nodeIdOrigin: 'boundary_clip',
            x: pt[0],
            z: pt[1],
            layer: part.layer,
            isBridge: part.isBridge,
            isTunnel: part.isTunnel,
            isBoundaryClipped: true,
            isAttributeBreak: false,
            isLoopAnchor: false,
            isDecoupledFlatCrossingTrackNode: false,
          });
        }
        resolvedIds.push(clipNodeId);
        continue;
      }

      const rawTopoKey = topoIndex.getOrCreateNode(pt[0], pt[1], scopeKey, osmId);
      const resolvedTopoKey = topoIndex.resolveCanonicalNodeId(rawTopoKey);

      let canonicalNodeId = topoKeyToCanonicalId.get(resolvedTopoKey);
      if (!canonicalNodeId) {
        const isExplicit = topoIndex.isExplicitNode(resolvedTopoKey);
        const rawOsm = isExplicit ? topoIndex.extractRawOsmNodeId(resolvedTopoKey) : undefined;
        if (isExplicit && rawOsm !== undefined) {
          canonicalNodeId = `rail_node:${scopeKey}:osm_${rawOsm}`;
        } else {
          fallbackSeq++;
          canonicalNodeId = `rail_node:${scopeKey}:fb_${fallbackSeq}`;
        }
        topoKeyToCanonicalId.set(resolvedTopoKey, canonicalNodeId);

        const pos = topoIndex.getNodePosition(resolvedTopoKey) ?? pt;
        internalNodes.set(canonicalNodeId, {
          id: canonicalNodeId,
          rawOsmNodeId: rawOsm,
          nodeIdOrigin: isExplicit && rawOsm !== undefined ? 'explicit_osm' : 'coordinate_fallback',
          x: pos[0],
          z: pos[1],
          layer: part.layer,
          isBridge: part.isBridge,
          isTunnel: part.isTunnel,
          isBoundaryClipped: false,
          isAttributeBreak: false,
          isLoopAnchor: false,
          isDecoupledFlatCrossingTrackNode: false,
        });
      }

      resolvedIds.push(canonicalNodeId);
    }

    partVertexNodeIds.set(part.id, resolvedIds);
  }

  // 4. Strip consecutive identical-node zero-length duplicate vertices
  for (const item of retainedParts) {
    const { part, mutablePoints, mutableRawOsmNodeIds } = item;
    const nodeIds = partVertexNodeIds.get(part.id)!;

    if (mutablePoints.length > 2) {
      for (let i = mutablePoints.length - 2; i >= 1; i--) {
        if (
          nodeIds[i] === nodeIds[i - 1] &&
          Math.hypot(
            mutablePoints[i][0] - mutablePoints[i - 1][0],
            mutablePoints[i][1] - mutablePoints[i - 1][1]
          ) < 1e-4
        ) {
          mutablePoints.splice(i, 1);
          mutableRawOsmNodeIds.splice(i, 1);
          nodeIds.splice(i, 1);
        }
      }
    }
  }

  // 4B. Associate railway point metadata (`railway=switch` and `railway=railway_crossing`) with internal nodes
  const allInternalNodesList = [...internalNodes.values()];
  for (const ptMeta of extractedPoints) {
    const ptNormOsmId =
      stripNodePrefix(ptMeta.rawOsmNodeId) ??
      (ptMeta.hasExplicitSourceId ? stripNodePrefix(ptMeta.id) : undefined);

    let matchedNodes: InternalRailwayNodeRecord[] = [];
    if (ptNormOsmId !== undefined) {
      matchedNodes = allInternalNodesList.filter(
        (n) => stripNodePrefix(n.rawOsmNodeId) === ptNormOsmId
      );
    }

    if (matchedNodes.length === 0) {
      // Coordinate fallback matching within 0.15 m when explicit OSM node IDs do not conflict
      let bestNode: InternalRailwayNodeRecord | undefined;
      let bestDist = DEFAULT_NODE_SNAP_TOLERANCE_METERS;
      for (const n of allInternalNodesList) {
        if (ptNormOsmId !== undefined && n.rawOsmNodeId !== undefined) {
          continue;
        }
        const dist = Math.hypot(n.x - ptMeta.point[0], n.z - ptMeta.point[1]);
        if (
          dist <= bestDist - 1e-9 ||
          (Math.abs(dist - bestDist) <= 1e-9 && bestNode && n.id < bestNode.id)
        ) {
          bestDist = dist;
          bestNode = n;
        }
      }
      if (bestNode) {
        matchedNodes = [bestNode];
      }
    }

    for (const targetNode of matchedNodes) {
      if (ptMeta.kind === 'railway_switch' && !targetNode.switchPointMeta) {
        targetNode.switchPointMeta = ptMeta;
      } else if (ptMeta.kind === 'railway_crossing_flat' && !targetNode.flatCrossingPointMeta) {
        targetNode.flatCrossingPointMeta = ptMeta;
      }
    }
  }

  // 4C. Detect and decouple flat diamond crossings (ADR-0009 Section 5.1)
  const occurrencesByNode = new Map<string, PartVertexOccurrence[]>();
  for (const item of retainedParts) {
    const nodeIds = partVertexNodeIds.get(item.part.id)!;
    const len = nodeIds.length;
    for (let i = 0; i < len; i++) {
      const nid = nodeIds[i];
      let list = occurrencesByNode.get(nid);
      if (!list) {
        list = [];
        occurrencesByNode.set(nid, list);
      }
      list.push({
        partRecord: item,
        vertexIndex: i,
        isInterior: i > 0 && i < len - 1,
      });
    }
  }

  const pendingConfirmedFlatCrossings: PendingConfirmedFlatCrossing[] = [];
  const pendingUntaggedDegree4Candidates: PendingUntaggedDegree4Candidate[] = [];
  let flatCrossingDecoupleSeq = 0;

  for (const [nid, occs] of occurrencesByNode.entries()) {
    const node = internalNodes.get(nid);
    if (!node) continue;

    const interiorOccs = occs.filter((o) => o.isInterior);
    const endpointOccs = occs.filter((o) => !o.isInterior);
    const totalArms = interiorOccs.length * 2 + endpointOccs.length;

    if (totalArms !== 4) continue;

    const hasExplicitFlatCrossingTag =
      node.flatCrossingPointMeta !== undefined ||
      occs.some(
        (o) =>
          String(o.partRecord.part.osmTags?.railway ?? '')
            .trim()
            .toLowerCase() === 'railway_crossing'
      );

    // Case A: Two continuous railway ways sharing interior vertex `nid`
    if (interiorOccs.length === 2 && endpointOccs.length === 0) {
      const occA = interiorOccs[0];
      const occB = interiorOccs[1];
      const aPrev: TrackArm = {
        partRecord: occA.partRecord,
        vertexIndex: occA.vertexIndex,
        direction: 'prev',
        tangent: computeArmTangent(occA.partRecord.mutablePoints, occA.vertexIndex, 'prev'),
      };
      const aNext: TrackArm = {
        partRecord: occA.partRecord,
        vertexIndex: occA.vertexIndex,
        direction: 'next',
        tangent: computeArmTangent(occA.partRecord.mutablePoints, occA.vertexIndex, 'next'),
      };
      const bPrev: TrackArm = {
        partRecord: occB.partRecord,
        vertexIndex: occB.vertexIndex,
        direction: 'prev',
        tangent: computeArmTangent(occB.partRecord.mutablePoints, occB.vertexIndex, 'prev'),
      };
      const bNext: TrackArm = {
        partRecord: occB.partRecord,
        vertexIndex: occB.vertexIndex,
        direction: 'next',
        tangent: computeArmTangent(occB.partRecord.mutablePoints, occB.vertexIndex, 'next'),
      };

      const dotA = aPrev.tangent[0] * aNext.tangent[0] + aPrev.tangent[1] * aNext.tangent[1];
      const dotB = bPrev.tangent[0] * bNext.tangent[0] + bPrev.tangent[1] * bNext.tangent[1];
      const tA = computeForwardTrackTangent(aPrev, aNext);
      const tB = computeForwardTrackTangent(bPrev, bNext);
      const crossAngle = computeCrossingAngleRad(tA, tB);

      const minCrossingAngleRad = hasExplicitFlatCrossingTag
        ? MIN_TAGGED_FLAT_CROSSING_ANGLE_RAD
        : MIN_UNTAGGED_FLAT_CROSSING_ANGLE_RAD;
      const isCollinearDiamond =
        dotA <= -COS_15_DEG && dotB <= -COS_15_DEG && crossAngle >= minCrossingAngleRad;

      if (
        isCollinearDiamond &&
        node.switchPointMeta === undefined &&
        (hasExplicitFlatCrossingTag || node.nodeIdOrigin === 'explicit_osm')
      ) {
        flatCrossingDecoupleSeq++;
        const nodeIdA = `${nid}:fc_${flatCrossingDecoupleSeq}_a`;
        const nodeIdB = `${nid}:fc_${flatCrossingDecoupleSeq}_b`;

        internalNodes.set(nodeIdA, {
          ...node,
          id: nodeIdA,
          isDecoupledFlatCrossingTrackNode: true,
        });
        internalNodes.set(nodeIdB, {
          ...node,
          id: nodeIdB,
          isDecoupledFlatCrossingTrackNode: true,
        });

        partVertexNodeIds.get(occA.partRecord.part.id)![occA.vertexIndex] = nodeIdA;
        partVertexNodeIds.get(occB.partRecord.part.id)![occB.vertexIndex] = nodeIdB;

        pendingConfirmedFlatCrossings.push({
          originalNodeId: nid,
          rawOsmNodeId: node.rawOsmNodeId ?? node.flatCrossingPointMeta?.rawOsmNodeId,
          position: [node.x, node.z],
          layer: node.layer,
          confidence: hasExplicitFlatCrossingTag
            ? 'explicit_railway_crossing_tag'
            : 'shared_osm_node_flat_crossing',
          pointOsmTags: node.flatCrossingPointMeta?.osmTags
            ? cloneOsmTags(node.flatCrossingPointMeta.osmTags)
            : undefined,
          trackAPartIds: new Set([occA.partRecord.part.id]),
          trackBPartIds: new Set([occB.partRecord.part.id]),
          trackATangent: tA,
          trackBTangent: tB,
        });
      }
      continue;
    }

    // Case B: One continuous way + two endpoint segments meeting at `nid`
    if (interiorOccs.length === 1 && endpointOccs.length === 2) {
      const occA = interiorOccs[0];
      const end1 = endpointOccs[0];
      const end2 = endpointOccs[1];

      const aPrev: TrackArm = {
        partRecord: occA.partRecord,
        vertexIndex: occA.vertexIndex,
        direction: 'prev',
        tangent: computeArmTangent(occA.partRecord.mutablePoints, occA.vertexIndex, 'prev'),
      };
      const aNext: TrackArm = {
        partRecord: occA.partRecord,
        vertexIndex: occA.vertexIndex,
        direction: 'next',
        tangent: computeArmTangent(occA.partRecord.mutablePoints, occA.vertexIndex, 'next'),
      };
      const bArm1: TrackArm = {
        partRecord: end1.partRecord,
        vertexIndex: end1.vertexIndex,
        direction: end1.vertexIndex === 0 ? 'next' : 'prev',
        tangent: computeArmTangent(
          end1.partRecord.mutablePoints,
          end1.vertexIndex,
          end1.vertexIndex === 0 ? 'next' : 'prev'
        ),
      };
      const bArm2: TrackArm = {
        partRecord: end2.partRecord,
        vertexIndex: end2.vertexIndex,
        direction: end2.vertexIndex === 0 ? 'next' : 'prev',
        tangent: computeArmTangent(
          end2.partRecord.mutablePoints,
          end2.vertexIndex,
          end2.vertexIndex === 0 ? 'next' : 'prev'
        ),
      };

      const dotA = aPrev.tangent[0] * aNext.tangent[0] + aPrev.tangent[1] * aNext.tangent[1];
      const dotB = bArm1.tangent[0] * bArm2.tangent[0] + bArm1.tangent[1] * bArm2.tangent[1];
      const tA = computeForwardTrackTangent(aPrev, aNext);
      const tB = computeForwardTrackTangent(bArm1, bArm2);
      const crossAngle = computeCrossingAngleRad(tA, tB);

      const isCollinearDiamond =
        dotA <= -COS_15_DEG &&
        dotB <= -COS_15_DEG &&
        crossAngle >= MIN_TAGGED_FLAT_CROSSING_ANGLE_RAD;

      if (isCollinearDiamond && node.switchPointMeta === undefined && hasExplicitFlatCrossingTag) {
        flatCrossingDecoupleSeq++;
        const nodeIdA = `${nid}:fc_${flatCrossingDecoupleSeq}_a`;
        const nodeIdB = `${nid}:fc_${flatCrossingDecoupleSeq}_b`;

        internalNodes.set(nodeIdA, {
          ...node,
          id: nodeIdA,
          isDecoupledFlatCrossingTrackNode: true,
        });
        internalNodes.set(nodeIdB, {
          ...node,
          id: nodeIdB,
          isDecoupledFlatCrossingTrackNode: true,
        });

        partVertexNodeIds.get(occA.partRecord.part.id)![occA.vertexIndex] = nodeIdA;
        partVertexNodeIds.get(end1.partRecord.part.id)![end1.vertexIndex] = nodeIdB;
        partVertexNodeIds.get(end2.partRecord.part.id)![end2.vertexIndex] = nodeIdB;

        pendingConfirmedFlatCrossings.push({
          originalNodeId: nid,
          rawOsmNodeId: node.rawOsmNodeId ?? node.flatCrossingPointMeta?.rawOsmNodeId,
          position: [node.x, node.z],
          layer: node.layer,
          confidence: 'explicit_railway_crossing_tag',
          pointOsmTags: node.flatCrossingPointMeta?.osmTags
            ? cloneOsmTags(node.flatCrossingPointMeta.osmTags)
            : undefined,
          trackAPartIds: new Set([occA.partRecord.part.id]),
          trackBPartIds: new Set([end1.partRecord.part.id, end2.partRecord.part.id]),
          trackATangent: tA,
          trackBTangent: tB,
        });
      }
      continue;
    }

    // Case C: Four segmented way endpoints meeting at `nid`
    if (interiorOccs.length === 0 && endpointOccs.length === 4) {
      const arms: TrackArm[] = endpointOccs.map((o) => {
        const dir = o.vertexIndex === 0 ? 'next' : 'prev';
        return {
          partRecord: o.partRecord,
          vertexIndex: o.vertexIndex,
          direction: dir,
          tangent: computeArmTangent(o.partRecord.mutablePoints, o.vertexIndex, dir),
        };
      });

      const partitions: Array<[number, number, number, number]> = [
        [0, 1, 2, 3],
        [0, 2, 1, 3],
        [0, 3, 1, 2],
      ];

      const validPartitions: Array<{
        p1: [number, number];
        p2: [number, number];
        tA: [number, number];
        tB: [number, number];
      }> = [];

      const minCrossingAngleRad = hasExplicitFlatCrossingTag
        ? MIN_TAGGED_FLAT_CROSSING_ANGLE_RAD
        : MIN_UNTAGGED_FLAT_CROSSING_ANGLE_RAD;

      for (const [i1, i2, j1, j2] of partitions) {
        const dot1 =
          arms[i1].tangent[0] * arms[i2].tangent[0] + arms[i1].tangent[1] * arms[i2].tangent[1];
        const dot2 =
          arms[j1].tangent[0] * arms[j2].tangent[0] + arms[j1].tangent[1] * arms[j2].tangent[1];
        if (dot1 <= -COS_15_DEG && dot2 <= -COS_15_DEG) {
          const tA = computeForwardTrackTangent(arms[i1], arms[i2]);
          const tB = computeForwardTrackTangent(arms[j1], arms[j2]);
          if (computeCrossingAngleRad(tA, tB) >= minCrossingAngleRad) {
            validPartitions.push({ p1: [i1, i2], p2: [j1, j2], tA, tB });
          }
        }
      }

      if (validPartitions.length === 1 && node.switchPointMeta === undefined) {
        const chosen = validPartitions[0];
        const occA1 = endpointOccs[chosen.p1[0]];
        const occA2 = endpointOccs[chosen.p1[1]];
        const occB1 = endpointOccs[chosen.p2[0]];
        const occB2 = endpointOccs[chosen.p2[1]];

        if (hasExplicitFlatCrossingTag) {
          flatCrossingDecoupleSeq++;
          const nodeIdA = `${nid}:fc_${flatCrossingDecoupleSeq}_a`;
          const nodeIdB = `${nid}:fc_${flatCrossingDecoupleSeq}_b`;

          internalNodes.set(nodeIdA, {
            ...node,
            id: nodeIdA,
            isDecoupledFlatCrossingTrackNode: true,
          });
          internalNodes.set(nodeIdB, {
            ...node,
            id: nodeIdB,
            isDecoupledFlatCrossingTrackNode: true,
          });

          partVertexNodeIds.get(occA1.partRecord.part.id)![occA1.vertexIndex] = nodeIdA;
          partVertexNodeIds.get(occA2.partRecord.part.id)![occA2.vertexIndex] = nodeIdA;
          partVertexNodeIds.get(occB1.partRecord.part.id)![occB1.vertexIndex] = nodeIdB;
          partVertexNodeIds.get(occB2.partRecord.part.id)![occB2.vertexIndex] = nodeIdB;

          pendingConfirmedFlatCrossings.push({
            originalNodeId: nid,
            rawOsmNodeId: node.rawOsmNodeId ?? node.flatCrossingPointMeta?.rawOsmNodeId,
            position: [node.x, node.z],
            layer: node.layer,
            confidence: 'explicit_railway_crossing_tag',
            pointOsmTags: node.flatCrossingPointMeta?.osmTags
              ? cloneOsmTags(node.flatCrossingPointMeta.osmTags)
              : undefined,
            trackAPartIds: new Set([occA1.partRecord.part.id, occA2.partRecord.part.id]),
            trackBPartIds: new Set([occB1.partRecord.part.id, occB2.partRecord.part.id]),
            trackATangent: chosen.tA,
            trackBTangent: chosen.tB,
          });
        } else {
          pendingUntaggedDegree4Candidates.push({
            nodeId: nid,
            position: [node.x, node.z],
            trackAPartIds: new Set([occA1.partRecord.part.id, occA2.partRecord.part.id]),
            trackBPartIds: new Set([occB1.partRecord.part.id, occB2.partRecord.part.id]),
          });
        }
      } else if (!hasExplicitFlatCrossingTag) {
        pendingUntaggedDegree4Candidates.push({
          nodeId: nid,
          position: [node.x, node.z],
          trackAPartIds: new Set([endpointOccs[0].partRecord.part.id]),
          trackBPartIds: new Set([endpointOccs[1].partRecord.part.id]),
        });
      }
    }
  }

  // Recompute node occurrence counts after flat-crossing track decoupling
  const nodeOccurrenceCount = new Map<string, number>();
  for (const item of retainedParts) {
    const nodeIds = partVertexNodeIds.get(item.part.id)!;
    for (let i = 0; i < nodeIds.length; i++) {
      const nid = nodeIds[i];
      nodeOccurrenceCount.set(nid, (nodeOccurrenceCount.get(nid) ?? 0) + 1);
    }
  }

  // 5. Split parts at shared interior nodes (including self-loops and P-loops)
  const draftEdges = new Map<number, DraftRailwayEdge>();
  let nextDraftId = 1;

  for (const item of retainedParts) {
    const { part, canonicalOrder, deduplicatedFeatureIds, mutablePoints, mutableRawOsmNodeIds } =
      item;
    const nodeIds = partVertexNodeIds.get(part.id)!;
    const n = mutablePoints.length;
    if (n < 2) continue;

    const splitIndices: number[] = [0];
    for (let i = 1; i < n - 1; i++) {
      const nid = nodeIds[i];
      const nodeRec = internalNodes.get(nid);
      if (
        (nodeOccurrenceCount.get(nid) ?? 0) >= 2 ||
        nodeRec?.switchPointMeta !== undefined ||
        (nodeRec?.flatCrossingPointMeta !== undefined && !nodeRec.isDecoupledFlatCrossingTrackNode)
      ) {
        splitIndices.push(i);
      }
    }
    splitIndices.push(n - 1);

    if (splitIndices.length > 2) {
      diagnostics.railwayInteriorSplitCount += splitIndices.length - 2;
    }

    const cumLengths = computeCumulativeLengths(mutablePoints);

    for (let s = 0; s < splitIndices.length - 1; s++) {
      const startIdx = splitIndices[s];
      const endIdx = splitIndices[s + 1];
      const subPoints = mutablePoints
        .slice(startIdx, endIdx + 1)
        .map((pt) => [pt[0], pt[1]] as [number, number]);
      const subRawOsmIds = mutableRawOsmNodeIds.slice(startIdx, endIdx + 1);
      const segLen = cumLengths[endIdx] - cumLengths[startIdx];
      if (segLen <= 1e-6) continue;

      const draftId = nextDraftId++;
      const initialSegment: EdgeSegmentProvenance = {
        partId: part.id,
        sourceFeatureId: part.sourceFeatureId,
        deduplicatedFeatureIds: [...deduplicatedFeatureIds],
        startArcLength: 0,
        endArcLength: segLen,
        startVertexIndex: 0,
        endVertexIndex: endIdx - startIdx,
        sourceStartVertexIndex: startIdx,
        sourceEndVertexIndex: endIdx,
        reversedRelativeToSource: false,
        osmTags: cloneOsmTags(part.osmTags),
      };

      draftEdges.set(draftId, {
        draftId,
        canonicalOrder: canonicalOrder * 10000 + s,
        fromNodeId: nodeIds[startIdx],
        toNodeId: nodeIds[endIdx],
        points: subPoints,
        vertexRawOsmNodeIds: subRawOsmIds,
        lengthMeters: segLen,
        layer: part.layer,
        isBridge: part.isBridge,
        isTunnel: part.isTunnel,
        clippedAtStart: startIdx === 0 ? part.clippedAtStart : false,
        clippedAtEnd: endIdx === n - 1 ? part.clippedAtEnd : false,
        railwayType: part.railwayType,
        width: part.width,
        gauge: part.gauge,
        electrified: part.electrified,
        service: part.service,
        usage: part.usage,
        isSecondaryBranch: part.isSecondaryBranch,
        name: part.name,
        segments: [initialSegment],
      });
    }
  }

  // 6. OSMnx-style non-interstitial degree-2 path simplification
  const buildNodeIncidentDrafts = () => {
    const adj = new Map<string, number[]>();
    for (const edge of draftEdges.values()) {
      let fromList = adj.get(edge.fromNodeId);
      if (!fromList) {
        fromList = [];
        adj.set(edge.fromNodeId, fromList);
      }
      fromList.push(edge.draftId);

      let toList = adj.get(edge.toNodeId);
      if (!toList) {
        toList = [];
        adj.set(edge.toNodeId, toList);
      }
      toList.push(edge.draftId);
    }
    return adj;
  };

  const initialAdj = buildNodeIncidentDrafts();
  const contractibleDegree2Nodes = new Set<string>();

  for (const [nodeId, edgeIds] of initialAdj.entries()) {
    if (edgeIds.length !== 2) continue;
    const node = internalNodes.get(nodeId)!;
    const [id1, id2] = edgeIds;
    if (id1 === id2) {
      node.isLoopAnchor = true;
      continue;
    }
    const e1 = draftEdges.get(id1)!;
    const e2 = draftEdges.get(id2)!;
    if (canContractDegree2RailwayNode(node, e1, e2)) {
      contractibleDegree2Nodes.add(nodeId);
    } else if (!node.isBoundaryClipped && !areParallelDraftRailwayEdges(e1, e2)) {
      if (!haveIdenticalRailwayAttributes(e1, e2)) {
        node.isAttributeBreak = true;
      }
    }
  }

  // Detect pure closed cycles composed entirely of contractibleDegree2Nodes and pin 1 deterministic loop_anchor node
  const visitedContractible = new Set<string>();
  for (const startNodeId of contractibleDegree2Nodes) {
    if (visitedContractible.has(startNodeId)) continue;
    const componentNodes: string[] = [];
    const queue: string[] = [startNodeId];
    visitedContractible.add(startNodeId);
    let touchesNonContractible = false;

    while (queue.length > 0) {
      const curr = queue.shift()!;
      componentNodes.push(curr);
      const incident = initialAdj.get(curr) || [];
      for (const eid of incident) {
        const edge = draftEdges.get(eid);
        if (!edge) continue;
        const neighbor = edge.fromNodeId === curr ? edge.toNodeId : edge.fromNodeId;
        if (!contractibleDegree2Nodes.has(neighbor)) {
          touchesNonContractible = true;
        } else if (!visitedContractible.has(neighbor)) {
          visitedContractible.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (!touchesNonContractible && componentNodes.length > 0) {
      componentNodes.sort((a, b) =>
        compareRailwayAnchorCandidateNodes(internalNodes.get(a)!, internalNodes.get(b)!)
      );
      const anchorNodeId = componentNodes[0];
      contractibleDegree2Nodes.delete(anchorNodeId);
      internalNodes.get(anchorNodeId)!.isLoopAnchor = true;
    }
  }

  // Contract maximal degree-2 chains deterministically
  if (contractibleDegree2Nodes.size > 0) {
    const consumedEdgeIds = new Set<number>();
    const currentAdj = buildNodeIncidentDrafts();

    const chains: Array<{
      edgeIds: number[];
      startNodeId: string;
      endNodeId: string;
      contractedNodeIds: string[];
    }> = [];

    for (const edge of draftEdges.values()) {
      if (consumedEdgeIds.has(edge.draftId)) continue;
      const uContractible = contractibleDegree2Nodes.has(edge.fromNodeId);
      const vContractible = contractibleDegree2Nodes.has(edge.toNodeId);
      if (!uContractible && !vContractible) {
        continue;
      }

      const backwardEdges: number[] = [];
      const backwardNodes: string[] = [];
      let currNode = edge.fromNodeId;
      let prevEdgeId = edge.draftId;
      while (contractibleDegree2Nodes.has(currNode)) {
        const inc = currentAdj.get(currNode)!;
        const nextEdgeId = inc[0] === prevEdgeId ? inc[1] : inc[0];
        if (nextEdgeId === edge.draftId || consumedEdgeIds.has(nextEdgeId)) break;
        backwardNodes.unshift(currNode);
        backwardEdges.unshift(nextEdgeId);
        const nextEdge = draftEdges.get(nextEdgeId)!;
        currNode = nextEdge.fromNodeId === currNode ? nextEdge.toNodeId : nextEdge.fromNodeId;
        prevEdgeId = nextEdgeId;
      }
      const chainStartNode = currNode;

      const forwardEdges: number[] = [];
      const forwardNodes: string[] = [];
      currNode = edge.toNodeId;
      prevEdgeId = edge.draftId;
      while (contractibleDegree2Nodes.has(currNode)) {
        const inc = currentAdj.get(currNode)!;
        const nextEdgeId = inc[0] === prevEdgeId ? inc[1] : inc[0];
        if (nextEdgeId === edge.draftId || consumedEdgeIds.has(nextEdgeId)) break;
        forwardNodes.push(currNode);
        forwardEdges.push(nextEdgeId);
        const nextEdge = draftEdges.get(nextEdgeId)!;
        currNode = nextEdge.fromNodeId === currNode ? nextEdge.toNodeId : nextEdge.fromNodeId;
        prevEdgeId = nextEdgeId;
      }
      const chainEndNode = currNode;

      const fullChainEdgeIds = [...backwardEdges, edge.draftId, ...forwardEdges];
      for (const cid of fullChainEdgeIds) {
        consumedEdgeIds.add(cid);
      }

      chains.push({
        edgeIds: fullChainEdgeIds,
        startNodeId: chainStartNode,
        endNodeId: chainEndNode,
        contractedNodeIds: [...backwardNodes, ...forwardNodes],
      });
    }

    for (const chain of chains) {
      if (chain.edgeIds.length <= 1) continue;
      const firstEdge = draftEdges.get(chain.edgeIds[0])!;
      const lastEdge = draftEdges.get(chain.edgeIds[chain.edgeIds.length - 1])!;

      const orderedEdgeIds = [...chain.edgeIds];
      let cursorNodeId = chain.startNodeId;

      if (lastEdge.canonicalOrder < firstEdge.canonicalOrder) {
        orderedEdgeIds.reverse();
        cursorNodeId = chain.endNodeId;
      }

      let mergedEdge = draftEdges.get(orderedEdgeIds[0])!;
      if (mergedEdge.fromNodeId !== cursorNodeId) {
        mergedEdge = reverseDraftRailwayEdge(mergedEdge);
      }
      cursorNodeId = mergedEdge.toNodeId;

      for (let i = 1; i < orderedEdgeIds.length; i++) {
        let nextEdge = draftEdges.get(orderedEdgeIds[i])!;
        if (nextEdge.fromNodeId !== cursorNodeId) {
          nextEdge = reverseDraftRailwayEdge(nextEdge);
        }
        mergedEdge = concatenateDraftRailwayEdges(mergedEdge, nextEdge);
        cursorNodeId = mergedEdge.toNodeId;
      }

      for (const oldId of orderedEdgeIds) {
        draftEdges.delete(oldId);
      }
      draftEdges.set(mergedEdge.draftId, mergedEdge);

      for (const contractedNid of chain.contractedNodeIds) {
        const rec = internalNodes.get(contractedNid);
        if (!rec?.isDecoupledFlatCrossingTrackNode) {
          diagnostics.railwaySimplifiedDegree2Count++;
        }
      }
    }
  }

  // 7. Assign parallelIndex, canonical edge IDs, and build final RailwayEdge & RailwayNode maps
  const pairGroups = new Map<string, DraftRailwayEdge[]>();
  for (const draft of draftEdges.values()) {
    const u = draft.fromNodeId;
    const v = draft.toNodeId;
    const pairKey = u <= v ? `${u}||${v}` : `${v}||${u}`;
    let grp = pairGroups.get(pairKey);
    if (!grp) {
      grp = [];
      pairGroups.set(pairKey, grp);
    }
    grp.push(draft);
  }

  const finalEdgesList: RailwayEdge[] = [];
  const partIdToFinalEdgeIds = new Map<string, string[]>();

  for (const group of pairGroups.values()) {
    if (group.length >= 2) {
      diagnostics.railwayParallelEdgePairCount++;
      group.sort((a, b) => {
        if (a.canonicalOrder !== b.canonicalOrder) {
          return a.canonicalOrder - b.canonicalOrder;
        }
        const lenDiff = Math.round(a.lengthMeters * 1000) - Math.round(b.lengthMeters * 1000);
        if (lenDiff !== 0) return lenDiff;
        return comparePointArraysMillimeter(a.points, b.points);
      });
    }

    for (let pIdx = 0; pIdx < group.length; pIdx++) {
      const d = group[pIdx];
      const firstSeg = d.segments[0];
      const primaryPartId = firstSeg.partId;
      const mergedPartIds = d.segments.map((s) => s.partId);
      const sourceFeatureSet = new Set<string>();
      for (const s of d.segments) {
        sourceFeatureSet.add(s.sourceFeatureId);
        for (const dupId of s.deduplicatedFeatureIds) {
          sourceFeatureSet.add(dupId);
        }
      }
      const sourceFeatureIds = [...sourceFeatureSet].sort(compareStringsCodeUnit);

      const provenance: EdgeProvenance = {
        primaryPartId,
        mergedPartIds,
        sourceFeatureIds,
        segments: d.segments.map((seg) => ({
          ...seg,
          deduplicatedFeatureIds: [...seg.deduplicatedFeatureIds],
          osmTags: cloneOsmTags(seg.osmTags),
        })),
      };

      const startSegAnchor = Math.min(
        firstSeg.sourceStartVertexIndex,
        firstSeg.sourceEndVertexIndex
      );
      const edgeId = `rail_edge:${primaryPartId}:seg_${startSegAnchor}:p_${pIdx}`;
      const isClosedLoop = d.fromNodeId === d.toNodeId;
      if (isClosedLoop) {
        diagnostics.closedLoopEdgeCount++;
      }

      finalEdgesList.push({
        id: edgeId,
        network: 'railway',
        fromNodeId: d.fromNodeId,
        toNodeId: d.toNodeId,
        parallelIndex: pIdx,
        points: d.points.map((pt) => [pt[0], pt[1]] as [number, number]),
        vertexRawOsmNodeIds: [...d.vertexRawOsmNodeIds],
        lengthMeters: d.lengthMeters,
        layer: d.layer,
        isBridge: d.isBridge,
        isTunnel: d.isTunnel,
        isClosedLoop,
        clippedAtStart: d.clippedAtStart,
        clippedAtEnd: d.clippedAtEnd,
        startInwardTangent: computeStartInwardTangent(d.points),
        endInwardTangent: computeEndInwardTangent(d.points),
        provenance,
        railwayType: d.railwayType,
        width: d.width,
        gauge: d.gauge,
        electrified: d.electrified,
        service: d.service,
        usage: d.usage,
        isSecondaryBranch: d.isSecondaryBranch,
        name: d.name,
      });

      for (const partId of mergedPartIds) {
        let pList = partIdToFinalEdgeIds.get(partId);
        if (!pList) {
          pList = [];
          partIdToFinalEdgeIds.set(partId, pList);
        }
        if (!pList.includes(edgeId)) {
          pList.push(edgeId);
        }
      }
    }
  }

  finalEdgesList.sort((a, b) => compareStringsCodeUnit(a.id, b.id));

  const edgesMap = new Map<string, RailwayEdge>();
  const featureToEdgesTemp = new Map<string, Set<string>>();
  const nodeHalfEdgesMap = new Map<string, IncidentHalfEdge[]>();

  for (const edge of finalEdgesList) {
    edgesMap.set(edge.id, edge);

    for (const srcId of edge.provenance.sourceFeatureIds) {
      let set = featureToEdgesTemp.get(srcId);
      if (!set) {
        set = new Set<string>();
        featureToEdgesTemp.set(srcId, set);
      }
      set.add(edge.id);
    }
    for (const partId of edge.provenance.mergedPartIds) {
      let set = featureToEdgesTemp.get(partId);
      if (!set) {
        set = new Set<string>();
        featureToEdgesTemp.set(partId, set);
      }
      set.add(edge.id);
    }

    let startHalfList = nodeHalfEdgesMap.get(edge.fromNodeId);
    if (!startHalfList) {
      startHalfList = [];
      nodeHalfEdgesMap.set(edge.fromNodeId, startHalfList);
    }
    startHalfList.push({
      edgeId: edge.id,
      endpoint: 'start',
      inwardTangent: edge.startInwardTangent,
    });

    let endHalfList = nodeHalfEdgesMap.get(edge.toNodeId);
    if (!endHalfList) {
      endHalfList = [];
      nodeHalfEdgesMap.set(edge.toNodeId, endHalfList);
    }
    endHalfList.push({
      edgeId: edge.id,
      endpoint: 'end',
      inwardTangent: edge.endInwardTangent,
    });
  }

  const nodesMap = new Map<string, RailwayNode>();
  const activeNodeIds = [...nodeHalfEdgesMap.keys()].sort(compareStringsCodeUnit);

  for (const nodeId of activeNodeIds) {
    const rec = internalNodes.get(nodeId)!;
    const halfEdges = nodeHalfEdgesMap.get(nodeId)!;
    halfEdges.sort((a, b) => {
      const c = compareStringsCodeUnit(a.edgeId, b.edgeId);
      if (c !== 0) return c;
      return a.endpoint === 'start' ? -1 : 1;
    });

    const degree = halfEdges.length;
    const uniqueEdgeIdsSet = new Set<string>();
    for (const he of halfEdges) {
      uniqueEdgeIdsSet.add(he.edgeId);
    }
    const incidentEdgeIds = [...uniqueEdgeIdsSet].sort(compareStringsCodeUnit);

    const rolesSet = new Set<RailwayNodeRole>();
    let turnoutTopology: TurnoutTopologySpec | undefined;

    if (rec.isBoundaryClipped) {
      rolesSet.add('boundary_clip');
      diagnostics.boundaryClippedNodeCount++;
    } else if (degree === 1) {
      rolesSet.add('buffer_stop');
    }

    if (rec.isLoopAnchor) {
      rolesSet.add('loop_anchor');
    }
    if (rec.isAttributeBreak) {
      rolesSet.add('attribute_break');
    }
    if (rec.flatCrossingPointMeta !== undefined) {
      rolesSet.add('railway_crossing');
    }

    if (degree === 3) {
      turnoutTopology = evaluateDegree3TurnoutTopology(
        rec,
        halfEdges,
        edgesMap,
        incidentEdgeIds
      );
      if (turnoutTopology.status === 'confirmed') {
        diagnostics.railwayConfirmedSwitchCount++;
        rolesSet.add('switch');
      } else {
        diagnostics.railwayUnresolvedSwitchCount++;
        if (rec.switchPointMeta !== undefined) {
          rolesSet.add('switch');
        }
        rolesSet.add('junction');
      }
    } else if (degree >= 4) {
      diagnostics.railwayUnresolvedJunctionCount++;
      if (rec.switchPointMeta !== undefined) {
        rolesSet.add('switch');
      }
      rolesSet.add('junction');
    } else if (rec.switchPointMeta !== undefined) {
      rolesSet.add('switch');
    }

    if (rolesSet.size === 0) {
      rolesSet.add('junction');
    }

    const roles = [...rolesSet].sort((a, b) => compareStringsCodeUnit(a, b));
    const primaryRole = selectPrimaryRailwayNodeRole(roles);
    const pointMeta = rec.switchPointMeta ?? rec.flatCrossingPointMeta;

    nodesMap.set(nodeId, {
      id: nodeId,
      network: 'railway',
      rawOsmNodeId: rec.rawOsmNodeId,
      nodeIdOrigin: rec.nodeIdOrigin,
      x: rec.x,
      z: rec.z,
      layer: rec.layer,
      isBridge: rec.isBridge,
      isTunnel: rec.isTunnel,
      isBoundaryClipped: rec.isBoundaryClipped,
      degree,
      primaryRole,
      roles,
      incidentEdgeIds,
      incidentHalfEdges: halfEdges,
      pointOsmTags: pointMeta?.osmTags ? cloneOsmTags(pointMeta.osmTags) : undefined,
      turnoutTopology,
    });
  }

  // 8. Resolve final RailwayFlatCrossingRelation records and untagged degree-4 UnresolvedCrossingCandidates
  const findBestEdgeAndArcLengthForTrack = (
    partIds: ReadonlySet<string>,
    pos: [number, number]
  ): { edgeId: string; arcLengthMeters: number } | undefined => {
    const candidateEdgeIds = new Set<string>();
    for (const pid of partIds) {
      const eids = partIdToFinalEdgeIds.get(pid);
      if (eids) {
        for (const eid of eids) candidateEdgeIds.add(eid);
      }
    }

    let bestEdgeId: string | undefined;
    let bestArcLength = 0;
    let bestDist = Infinity;

    for (const eid of candidateEdgeIds) {
      const edge = edgesMap.get(eid);
      if (!edge) continue;
      let cum = 0;
      for (let i = 0; i < edge.points.length; i++) {
        if (i > 0) {
          cum += Math.hypot(
            edge.points[i][0] - edge.points[i - 1][0],
            edge.points[i][1] - edge.points[i - 1][1]
          );
        }
        const dist = Math.hypot(edge.points[i][0] - pos[0], edge.points[i][1] - pos[1]);
        if (
          dist < bestDist - 1e-9 ||
          (Math.abs(dist - bestDist) <= 1e-9 && bestEdgeId && eid < bestEdgeId)
        ) {
          bestDist = dist;
          bestEdgeId = eid;
          bestArcLength = cum;
        }
      }
    }

    if (bestEdgeId === undefined) return undefined;
    return { edgeId: bestEdgeId, arcLengthMeters: bestArcLength };
  };

  const railwayFlatCrossings: RailwayFlatCrossingRelation[] = [];

  for (const pending of pendingConfirmedFlatCrossings) {
    const resolvedA = findBestEdgeAndArcLengthForTrack(pending.trackAPartIds, pending.position);
    const resolvedB = findBestEdgeAndArcLengthForTrack(pending.trackBPartIds, pending.position);
    if (!resolvedA || !resolvedB) continue;

    const swap =
      compareStringsCodeUnit(resolvedA.edgeId, resolvedB.edgeId) > 0 ||
      (resolvedA.edgeId === resolvedB.edgeId &&
        resolvedA.arcLengthMeters > resolvedB.arcLengthMeters);

    const trackA = swap ? resolvedB : resolvedA;
    const trackB = swap ? resolvedA : resolvedB;
    const crossingAngleRad = computeCrossingAngleRad(
      pending.trackATangent,
      pending.trackBTangent
    );

    railwayFlatCrossings.push({
      id: '',
      rawOsmNodeId: pending.rawOsmNodeId,
      position: [pending.position[0], pending.position[1]],
      trackAEdgeId: trackA.edgeId,
      trackAArcLengthMeters: trackA.arcLengthMeters,
      trackBEdgeId: trackB.edgeId,
      trackBArcLengthMeters: trackB.arcLengthMeters,
      crossingAngleRad,
      confidence: pending.confidence,
      pointOsmTags: pending.pointOsmTags,
    });
  }

  railwayFlatCrossings.sort((a, b) => {
    const edgeCmpA = compareStringsCodeUnit(a.trackAEdgeId, b.trackAEdgeId);
    if (edgeCmpA !== 0) return edgeCmpA;
    const edgeCmpB = compareStringsCodeUnit(a.trackBEdgeId, b.trackBEdgeId);
    if (edgeCmpB !== 0) return edgeCmpB;
    const dx = Math.round(a.position[0] * 1000) - Math.round(b.position[0] * 1000);
    if (dx !== 0) return dx;
    return Math.round(a.position[1] * 1000) - Math.round(b.position[1] * 1000);
  });

  for (let i = 0; i < railwayFlatCrossings.length; i++) {
    railwayFlatCrossings[i] = {
      ...railwayFlatCrossings[i],
      id: `rail_flat_crossing:${i + 1}`,
    };
  }

  for (const cand of pendingUntaggedDegree4Candidates) {
    const resolvedA = findBestEdgeAndArcLengthForTrack(cand.trackAPartIds, cand.position);
    const resolvedB = findBestEdgeAndArcLengthForTrack(cand.trackBPartIds, cand.position);
    if (!resolvedA || !resolvedB) continue;

    const edgeAId =
      compareStringsCodeUnit(resolvedA.edgeId, resolvedB.edgeId) <= 0
        ? resolvedA.edgeId
        : resolvedB.edgeId;
    const edgeBId =
      compareStringsCodeUnit(resolvedA.edgeId, resolvedB.edgeId) <= 0
        ? resolvedB.edgeId
        : resolvedA.edgeId;

    unresolvedCrossings.push({
      kind: 'rail_rail',
      position: [cand.position[0], cand.position[1]],
      edgeAId,
      edgeBId,
      reason: 'missing_railway_crossing_tag_at_degree_4_node',
    });
  }

  const featureToEdgeIds = new Map<string, readonly string[]>();
  for (const [featId, set] of [...featureToEdgesTemp.entries()].sort((a, b) =>
    compareStringsCodeUnit(a[0], b[0])
  )) {
    featureToEdgeIds.set(featId, [...set].sort(compareStringsCodeUnit));
  }

  diagnostics.railwayNodeCount = nodesMap.size;
  diagnostics.railwayEdgeCount = edgesMap.size;
  diagnostics.railwayFlatCrossingCount = railwayFlatCrossings.length;

  return {
    railways: {
      nodes: nodesMap,
      edges: edgesMap,
      featureToEdgeIds,
    },
    railwayFlatCrossings,
    diagnostics,
  };
}
