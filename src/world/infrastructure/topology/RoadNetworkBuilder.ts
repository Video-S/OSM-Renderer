import {
  ProcessedMapData,
  RawGeoJsonProperties,
  RoadClass,
} from '../../../types/MapFeature';
import {
  DEFAULT_NODE_SNAP_TOLERANCE_METERS,
  TopologicalNodeIndex,
} from '../../TopologicalNodeIndex';
import {
  resolveOnewayOrientation,
  resolveOsmLaneCounts,
  resolveSegmentCrossSectionProfile,
} from '../../OsmRoadCrossSection';
import {
  EdgeProvenance,
  EdgeSegmentProvenance,
  IncidentHalfEdge,
  InfrastructurePointMetadata,
  NodeIdOrigin,
  NormalizedOneWay,
  RoadEdge,
  RoadNetwork,
  RoadNetworkBuildOptions,
  RoadNetworkBuildResult,
  RoadNetworkDiagnostics,
  RoadNode,
  RoadNodeRole,
  RoadTier,
  TopologySourceData,
  UnchainedRoadPart,
  UnresolvedInfrastructurePointCandidate,
  UnresolvedInfrastructurePointReason,
} from './types';

export const EXACT_DUPLICATE_VERTEX_TOLERANCE_METERS = 1e-3; // 1 mm

const NON_VEHICULAR_ROAD_CLASSES = new Set<string>([
  'footway',
  'path',
  'cycleway',
  'bridleway',
  'steps',
  'pedestrian',
  'platform',
  'pier',
  'corridor',
]);

/**
 * Classifies a `RoadClass` into `'vehicular'` or `'path'` tier.
 */
export function getRoadTier(roadClass: RoadClass): RoadTier {
  return NON_VEHICULAR_ROAD_CLASSES.has(String(roadClass).toLowerCase()) ? 'path' : 'vehicular';
}

/**
 * Extracts the verbatim raw `oneway` tag if present and non-empty.
 */
export function extractRawOnewayTag(osmTags?: RawGeoJsonProperties): string | undefined {
  if (!osmTags || osmTags.oneway === undefined || osmTags.oneway === null) {
    return undefined;
  }
  const str = String(osmTags.oneway).trim();
  return str.length > 0 ? str : undefined;
}

/**
 * Normalizes a raw `oneway` tag value into `'forward' | 'reverse' | 'bidirectional' | 'unknown'`
 * without fabricating traversal rules for unusual values.
 */
export function normalizeOnewayTag(rawOnewayTag?: string): NormalizedOneWay {
  if (rawOnewayTag === undefined) {
    return 'bidirectional';
  }
  const lower = rawOnewayTag.toLowerCase();
  if (lower === 'yes' || lower === '1' || lower === 'true') {
    return 'forward';
  }
  if (lower === '-1' || lower === 'reverse') {
    return 'reverse';
  }
  if (lower === 'no' || lower === '0' || lower === 'false') {
    return 'bidirectional';
  }
  return 'unknown';
}

function parseLanesTag(osmTags?: RawGeoJsonProperties): number | undefined {
  if (!osmTags) {
    return undefined;
  }
  if (osmTags.lanes !== undefined && osmTags.lanes !== null) {
    const num = Number(osmTags.lanes);
    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }
  const oneway = resolveOnewayOrientation(osmTags);
  const resolved = resolveOsmLaneCounts(osmTags, oneway.isOneWay, oneway.isReverseOneWay);
  return resolved.totalLanes;
}

function parseSurfaceTag(osmTags?: RawGeoJsonProperties): string | undefined {
  if (!osmTags || osmTags.surface === undefined || osmTags.surface === null) {
    return undefined;
  }
  const str = String(osmTags.surface).trim();
  return str.length > 0 ? str : undefined;
}

export function computeStartInwardTangent(points: readonly [number, number][]): [number, number] {
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[0][0];
    const dz = points[i][1] - points[0][1];
    const len = Math.hypot(dx, dz);
    if (len > 1e-9) {
      return [dx / len, dz / len];
    }
  }
  return [1, 0];
}

export function computeEndInwardTangent(points: readonly [number, number][]): [number, number] {
  const lastIdx = points.length - 1;
  for (let i = lastIdx - 1; i >= 0; i--) {
    const dx = points[i][0] - points[lastIdx][0];
    const dz = points[i][1] - points[lastIdx][1];
    const len = Math.hypot(dx, dz);
    if (len > 1e-9) {
      return [dx / len, dz / len];
    }
  }
  return [-1, 0];
}

export function computeCumulativeLengths(points: readonly [number, number][]): number[] {
  const cum: number[] = [0];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    cum.push(total);
  }
  return cum;
}

export function cloneOsmTags(tags?: RawGeoJsonProperties): RawGeoJsonProperties {
  if (!tags) return {};
  const copy: RawGeoJsonProperties = { ...tags };
  if (Array.isArray(tags.nodes)) copy.nodes = [...tags.nodes];
  if (Array.isArray(tags.nodeIds)) copy.nodeIds = [...tags.nodeIds];
  if (Array.isArray(tags._nodeIds)) copy._nodeIds = [...tags._nodeIds];
  return copy;
}

function extractInputRoadParts(
  input: ProcessedMapData | TopologySourceData | readonly UnchainedRoadPart[]
): UnchainedRoadPart[] {
  let rawParts: readonly UnchainedRoadPart[];

  if (Array.isArray(input)) {
    rawParts = input;
  } else if ('roadParts' in input && Array.isArray((input as TopologySourceData).roadParts)) {
    rawParts = (input as TopologySourceData).roadParts;
  } else {
    const mapData = input as ProcessedMapData;
    if (mapData.topologySource && Array.isArray(mapData.topologySource.roadParts)) {
      rawParts = mapData.topologySource.roadParts;
    } else {
      // Fallback adapter for synthetic ProcessedMapData literals constructed directly in tests
      rawParts = (mapData.roads || []).map((r, idx) => {
        const sourceId = r.sourceFeatureId || r.id || `feat-${idx + 1}`;
        const hasExplicit = !/^feat-\d+$/.test(sourceId);
        const rawNodeIds: (string | undefined)[] = r.points.map((_, pIdx) => {
          const nid = r.nodeIds && pIdx < r.nodeIds.length ? r.nodeIds[pIdx] : undefined;
          if (nid === undefined || nid === null) return undefined;
          const s = String(nid).trim();
          if (!s || s.startsWith('tn_')) return undefined;
          if (s.includes('|osm_')) return s.split('|osm_').pop();
          if (s.startsWith('osm_')) return s.slice(4);
          return s;
        });
        return {
          id: r.id || `${sourceId}-0`,
          sourceFeatureId: sourceId,
          hasExplicitSourceId: hasExplicit,
          partIndex: 0,
          points: r.points.map((pt) => [pt[0], pt[1]] as [number, number]),
          rawOsmNodeIds: rawNodeIds,
          clippedAtStart: false,
          clippedAtEnd: false,
          roadClass: r.roadClass,
          width: r.width,
          layer: r.layer ?? 0,
          isBridge: Boolean(r.isBridge),
          isTunnel: Boolean(r.isTunnel),
          isCulvert: false,
          name: r.name,
          osmTags: cloneOsmTags(r.osmTags),
        };
      });
    }
  }

  // Deep-clone all parts so graph construction never mutates caller structures
  return rawParts
    .filter((p) => Array.isArray(p.points) && p.points.length >= 2)
    .map((p) => {
      const pts: [number, number][] = p.points.map((pt) => [Number(pt[0]), Number(pt[1])]);
      const rawNodes: (string | undefined)[] = pts.map((_, idx) => {
        const val = p.rawOsmNodeIds && idx < p.rawOsmNodeIds.length ? p.rawOsmNodeIds[idx] : undefined;
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
      return {
        ...p,
        points: pts,
        rawOsmNodeIds: rawNodes,
        osmTags: cloneOsmTags(p.osmTags),
      };
    });
}

export function compareStringsCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function comparePointArraysMillimeter(
  a: readonly [number, number][],
  b: readonly [number, number][]
): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    const dx = Math.round(a[i][0] * 1000) - Math.round(b[i][0] * 1000);
    if (dx !== 0) return dx;
    const dz = Math.round(a[i][1] * 1000) - Math.round(b[i][1] * 1000);
    if (dz !== 0) return dz;
  }
  return 0;
}

const EXCLUDED_TAG_KEYS = new Set<string>([
  'id',
  '@id',
  'osm_id',
  'sourceFeatureId',
  'partIndex',
  'nodes',
  'nodeIds',
  '_nodeIds',
  '_nodeIdsByPart',
  '_topologyNodeIds',
  '_topologyNodeIdsByPart',
]);

/**
 * Returns a canonical, sorted string representation of meaningful OSM tags for a road part,
 * excluding only identity and node-enrichment bookkeeping keys.
 */
export function getCanonicalMeaningfulOsmTagsString(tags?: RawGeoJsonProperties): string {
  if (!tags) return '';
  const entries: [string, string][] = [];
  for (const [key, rawVal] of Object.entries(tags)) {
    if (EXCLUDED_TAG_KEYS.has(key)) continue;
    if (rawVal === undefined || rawVal === null) continue;
    const strVal = String(rawVal).trim();
    if (strVal.length === 0) continue;
    entries.push([key, strVal]);
  }
  entries.sort((a, b) => compareStringsCodeUnit(a[0], b[0]));
  return entries.map(([k, v]) => `${k}=${v}`).join(';;');
}

function compareRoadPartsCanonically(a: UnchainedRoadPart, b: UnchainedRoadPart): number {
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

  const clsCmp = compareStringsCodeUnit(String(a.roadClass), String(b.roadClass));
  if (clsCmp !== 0) return clsCmp;

  const wCmp = Math.round(a.width * 10) - Math.round(b.width * 10);
  if (wCmp !== 0) return wCmp;

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

interface DeduplicatedRoadPart {
  part: UnchainedRoadPart;
  canonicalOrder: number;
  deduplicatedFeatureIds: string[];
  mutablePoints: [number, number][];
  mutableRawOsmNodeIds: (string | undefined)[];
}

export function areVerticesAndNodeIdsEqual(
  ptsA: readonly [number, number][],
  nodesA: readonly (string | undefined)[],
  ptsB: readonly [number, number][],
  nodesB: readonly (string | undefined)[],
  reverseB: boolean
): boolean {
  const n = ptsA.length;
  if (n !== ptsB.length) return false;

  for (let i = 0; i < n; i++) {
    const j = reverseB ? n - 1 - i : i;
    const dist = Math.hypot(ptsA[i][0] - ptsB[j][0], ptsA[i][1] - ptsB[j][1]);
    if (dist > EXACT_DUPLICATE_VERTEX_TOLERANCE_METERS) {
      return false;
    }
    const idA = nodesA[i];
    const idB = nodesB[j];
    if (idA !== undefined && idB !== undefined && idA !== idB) {
      return false;
    }
  }
  return true;
}

interface InternalNodeRecord {
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
  isProtectedNode: boolean;
  highwayCrossingPointMeta?: InfrastructurePointMetadata;
  additionalRoles: Set<RoadNodeRole>;
}

function stripRoadNodePrefix(raw?: string): string | undefined {
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

function isRoadNodeCompatibleWithPointScope(
  node: InternalNodeRecord,
  ptScope: ExplicitPointVerticalScope
): boolean {
  if (!ptScope.hasExplicitScope) return true;
  if (ptScope.isBridge !== undefined && node.isBridge !== ptScope.isBridge) return false;
  if (ptScope.isTunnel !== undefined && node.isTunnel !== ptScope.isTunnel) return false;
  if (ptScope.layer !== undefined && node.layer !== ptScope.layer) return false;
  return true;
}

function distancePointToPolyline2D(
  pt: readonly [number, number],
  polyline: readonly [number, number][]
): number {
  if (polyline.length === 0) return Infinity;
  if (polyline.length === 1) {
    return Math.hypot(pt[0] - polyline[0][0], pt[1] - polyline[0][1]);
  }
  let minDist = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const ax = polyline[i][0];
    const az = polyline[i][1];
    const bx = polyline[i + 1][0];
    const bz = polyline[i + 1][1];
    const vx = bx - ax;
    const vz = bz - az;
    const lenSq = vx * vx + vz * vz;
    let t = 0;
    if (lenSq > 1e-12) {
      t = Math.max(0, Math.min(1, ((pt[0] - ax) * vx + (pt[1] - az) * vz) / lenSq));
    }
    const projX = ax + t * vx;
    const projZ = az + t * vz;
    const d = Math.hypot(pt[0] - projX, pt[1] - projZ);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

function extractInputHighwayCrossingPoints(
  input: ProcessedMapData | TopologySourceData | readonly UnchainedRoadPart[],
  optionsOrPoints?: RoadNetworkBuildOptions | readonly InfrastructurePointMetadata[]
): InfrastructurePointMetadata[] {
  let rawPoints: readonly InfrastructurePointMetadata[] = [];
  if (Array.isArray(optionsOrPoints)) {
    rawPoints = optionsOrPoints;
  } else if (optionsOrPoints && 'infrastructurePoints' in optionsOrPoints && Array.isArray(optionsOrPoints.infrastructurePoints)) {
    rawPoints = optionsOrPoints.infrastructurePoints;
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
        pt.kind === 'highway_crossing' &&
        Array.isArray(pt.point) &&
        pt.point.length >= 2 &&
        Number.isFinite(pt.point[0]) &&
        Number.isFinite(pt.point[1])
    )
    .map((pt) => ({
      id: String(pt.id),
      hasExplicitSourceId: Boolean(pt.hasExplicitSourceId),
      rawOsmNodeId: pt.rawOsmNodeId ? String(pt.rawOsmNodeId).trim() : undefined,
      point: [Number(pt.point[0]), Number(pt.point[1])] as [number, number],
      kind: pt.kind,
      osmTags: cloneOsmTags(pt.osmTags),
    }))
    .sort((a, b) => {
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
    });
}

interface DraftRoadEdge {
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
  roadClass: RoadClass;
  tier: RoadTier;
  width: number;
  lanes?: number;
  normalizedOneway: NormalizedOneWay;
  rawOnewayTag?: string;
  name?: string;
  surface?: string;
  isCulvert: boolean;
  segments: EdgeSegmentProvenance[];
}

function reverseDraftRoadEdge(edge: DraftRoadEdge): DraftRoadEdge {
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

  let reversedOneway = edge.normalizedOneway;
  if (edge.normalizedOneway === 'forward') {
    reversedOneway = 'reverse';
  } else if (edge.normalizedOneway === 'reverse') {
    reversedOneway = 'forward';
  }

  return {
    ...edge,
    fromNodeId: edge.toNodeId,
    toNodeId: edge.fromNodeId,
    points: reversedPoints,
    vertexRawOsmNodeIds: reversedNodeIds,
    clippedAtStart: edge.clippedAtEnd,
    clippedAtEnd: edge.clippedAtStart,
    normalizedOneway: reversedOneway,
    segments: reversedSegments,
  };
}

function concatenateDraftRoadEdges(left: DraftRoadEdge, right: DraftRoadEdge): DraftRoadEdge {
  const arcOffset = left.lengthMeters;
  const vertexOffset = left.points.length - 1;

  const combinedPoints: [number, number][] = [
    ...left.points,
    ...right.points.slice(1),
  ];
  const combinedRawOsmNodeIds: (string | undefined)[] = [
    ...left.vertexRawOsmNodeIds,
    ...right.vertexRawOsmNodeIds.slice(1),
  ];

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

function isDirectedOneway(norm: NormalizedOneWay): boolean {
  return norm === 'forward' || norm === 'reverse';
}

function edgeFlowsIntoNode(edge: DraftRoadEdge, nodeId: string): boolean {
  if (edge.fromNodeId === edge.toNodeId) return false;
  if (edge.normalizedOneway === 'forward') return edge.toNodeId === nodeId;
  if (edge.normalizedOneway === 'reverse') return edge.fromNodeId === nodeId;
  return false;
}

function edgeFlowsOutOfNode(edge: DraftRoadEdge, nodeId: string): boolean {
  if (edge.fromNodeId === edge.toNodeId) return false;
  if (edge.normalizedOneway === 'forward') return edge.fromNodeId === nodeId;
  if (edge.normalizedOneway === 'reverse') return edge.toNodeId === nodeId;
  return false;
}

function areParallelDraftEdges(e1: DraftRoadEdge, e2: DraftRoadEdge): boolean {
  return (
    (e1.fromNodeId === e2.fromNodeId && e1.toNodeId === e2.toNodeId) ||
    (e1.fromNodeId === e2.toNodeId && e1.toNodeId === e2.fromNodeId)
  );
}

function haveCompatibleRoadAttributesAndFlow(
  node: InternalNodeRecord,
  e1: DraftRoadEdge,
  e2: DraftRoadEdge
): boolean {
  // Vertical scope guard
  if (
    e1.layer !== e2.layer ||
    e1.isBridge !== e2.isBridge ||
    e1.isTunnel !== e2.isTunnel
  ) {
    return false;
  }

  // Road attribute guards
  if (
    e1.roadClass !== e2.roadClass ||
    e1.tier !== e2.tier ||
    Math.round(e1.width * 10) !== Math.round(e2.width * 10) ||
    e1.isCulvert !== e2.isCulvert ||
    (e1.name ?? '').trim().toLowerCase() !== (e2.name ?? '').trim().toLowerCase() ||
    e1.lanes !== e2.lanes ||
    (e1.surface ?? '').trim().toLowerCase() !== (e2.surface ?? '').trim().toLowerCase()
  ) {
    return false;
  }

  // Accepted ADR-0009 Section 4.3 strictly requires identical rawOnewayTag
  if (e1.rawOnewayTag !== e2.rawOnewayTag) {
    return false;
  }

  // Never contract unknown/conditional oneway tags (e.g. oneway=reversible)
  if (e1.normalizedOneway === 'unknown' || e2.normalizedOneway === 'unknown') {
    return false;
  }

  // Bidirectional vs directed one-way cannot merge
  if (e1.normalizedOneway === 'bidirectional' || e2.normalizedOneway === 'bidirectional') {
    if (e1.normalizedOneway !== 'bidirectional' || e2.normalizedOneway !== 'bidirectional') {
      return false;
    }
    return haveCompatibleCrossSectionAtNode(node.id, e1, e2);
  }

  // Both e1 and e2 are directed one-way ('forward' | 'reverse') with identical rawOnewayTag:
  // Traffic must flow continuously through `node` (one enters `node`, the other leaves `node`)
  // without reversing either edge.
  const e1InE2Out = edgeFlowsIntoNode(e1, node.id) && edgeFlowsOutOfNode(e2, node.id);
  const e2InE1Out = edgeFlowsIntoNode(e2, node.id) && edgeFlowsOutOfNode(e1, node.id);
  if (!e1InE2Out && !e2InE1Out) {
    return false;
  }
  return haveCompatibleCrossSectionAtNode(node.id, e1, e2);
}

function haveCompatibleCrossSectionAtNode(
  nodeId: string,
  e1: DraftRoadEdge,
  e2: DraftRoadEdge
): boolean {
  if (e1.segments.length === 0 || e2.segments.length === 0) {
    return true;
  }
  const e1EntersAtEnd = e1.toNodeId === nodeId;
  const seg1 = e1EntersAtEnd ? e1.segments[e1.segments.length - 1] : e1.segments[0];
  const rev1 = e1EntersAtEnd ? seg1.reversedRelativeToSource : !seg1.reversedRelativeToSource;

  const e2LeavesFromStart = e2.fromNodeId === nodeId;
  const seg2 = e2LeavesFromStart ? e2.segments[0] : e2.segments[e2.segments.length - 1];
  const rev2 = e2LeavesFromStart ? seg2.reversedRelativeToSource : !seg2.reversedRelativeToSource;

  const p1 = String(seg1.osmTags?.placement ?? '').trim().toLowerCase();
  const p2 = String(seg2.osmTags?.placement ?? '').trim().toLowerCase();
  if (p1 === 'transition' || p2 === 'transition') {
    return true;
  }

  const prof1 = resolveSegmentCrossSectionProfile(e1.width, e1.roadClass, seg1.osmTags, {
    reversedRelativeToSource: rev1,
  });
  const prof2 = resolveSegmentCrossSectionProfile(e2.width, e2.roadClass, seg2.osmTags, {
    reversedRelativeToSource: rev2,
  });

  return (
    Math.abs(prof1.endLeftOffset - prof2.startLeftOffset) <= 1e-3 &&
    Math.abs(prof1.endRightOffset - prof2.startRightOffset) <= 1e-3
  );
}

function canContractDegree2RoadNode(
  node: InternalNodeRecord,
  e1: DraftRoadEdge,
  e2: DraftRoadEdge
): boolean {
  if (node.isBoundaryClipped || node.isProtectedNode || node.highwayCrossingPointMeta !== undefined) {
    return false;
  }
  if (e1.draftId === e2.draftId) return false;
  if (e1.fromNodeId === e1.toNodeId || e2.fromNodeId === e2.toNodeId) return false;

  // Never contract two parallel multi-edges connecting the same pair of nodes into a self-loop
  if (areParallelDraftEdges(e1, e2)) {
    return false;
  }

  return haveCompatibleRoadAttributesAndFlow(node, e1, e2);
}

function compareAnchorCandidateNodes(a: InternalNodeRecord, b: InternalNodeRecord): number {
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

const ROAD_ROLE_PRIORITY: readonly RoadNodeRole[] = [
  'junction',
  'grade_transition',
  'level_crossing',
  'highway_crossing',
  'attribute_break',
  'loop_anchor',
  'boundary_clip',
  'dead_end',
  'cross_tier',
];

function selectPrimaryRoadNodeRole(roles: readonly RoadNodeRole[]): RoadNodeRole {
  for (const candidate of ROAD_ROLE_PRIORITY) {
    if (roles.includes(candidate)) {
      return candidate;
    }
  }
  return roles[0] ?? 'junction';
}

/**
 * Pure, deterministic Stage B Road Network Graph builder (`ADR-0009`).
 * Constructs `RoadNetwork` and `RoadNetworkDiagnostics` without mutating inputs
 * and with zero React, Three.js, renderer, or WebGL dependencies.
 */
export function buildRoadNetwork(
  input: ProcessedMapData | TopologySourceData | readonly UnchainedRoadPart[],
  optionsOrPoints?: RoadNetworkBuildOptions | readonly InfrastructurePointMetadata[]
): RoadNetworkBuildResult {
  const extractedParts = extractInputRoadParts(input);
  const extractedHighwayCrossingPoints = extractInputHighwayCrossingPoints(input, optionsOrPoints);
  const options: RoadNetworkBuildOptions | undefined =
    optionsOrPoints && !Array.isArray(optionsOrPoints)
      ? (optionsOrPoints as RoadNetworkBuildOptions)
      : undefined;

  const unresolvedInfrastructurePoints: UnresolvedInfrastructurePointCandidate[] = [];
  const diagnostics: RoadNetworkDiagnostics = {
    inputPartCount: extractedParts.length,
    exactDeduplicatedCount: 0,
    roadNodeCount: 0,
    roadEdgeCount: 0,
    roadSimplifiedDegree2Count: 0,
    roadInteriorSplitCount: 0,
    roadParallelEdgePairCount: 0,
    boundaryClippedNodeCount: 0,
    crossTierNodeCount: 0,
    closedLoopEdgeCount: 0,
    unresolvedInfrastructurePoints,
  };

  if (extractedParts.length === 0) {
    for (const ptMeta of extractedHighwayCrossingPoints) {
      unresolvedInfrastructurePoints.push({
        pointId: ptMeta.id,
        rawOsmNodeId: ptMeta.rawOsmNodeId,
        kind: ptMeta.kind,
        position: [ptMeta.point[0], ptMeta.point[1]],
        candidateNodeIds: [],
        reason: 'no_candidate_node_within_snap_tolerance',
        osmTags: cloneOsmTags(ptMeta.osmTags),
      });
    }
    return {
      roads: {
        nodes: new Map(),
        edges: new Map(),
        featureToEdgeIds: new Map(),
      },
      diagnostics,
    };
  }

  // 1. Canonical pre-sorting of input parts
  const sortedParts = [...extractedParts].sort(compareRoadPartsCanonically);

  // 2. Strict geometric (1 mm) and semantic duplicate detection
  const dedupBuckets = new Map<string, DeduplicatedRoadPart[]>();
  const retainedParts: DeduplicatedRoadPart[] = [];

  for (let idx = 0; idx < sortedParts.length; idx++) {
    const part = sortedParts[idx];
    const tier = getRoadTier(part.roadClass);
    const rawOneway = extractRawOnewayTag(part.osmTags);
    const normOneway = normalizeOnewayTag(rawOneway);
    const lanes = parseLanesTag(part.osmTags);
    const nameKey = (part.name ?? '').trim().toLowerCase();
    const canonicalTagsKey = getCanonicalMeaningfulOsmTagsString(part.osmTags);

    const bucketKey = [
      part.layer,
      part.isBridge ? 1 : 0,
      part.isTunnel ? 1 : 0,
      part.roadClass,
      tier,
      Math.round(part.width * 10),
      part.isCulvert ? 1 : 0,
      nameKey,
      lanes ?? '',
      rawOneway ?? '',
      part.points.length,
      canonicalTagsKey,
    ].join('|');

    const bucket = dedupBuckets.get(bucketKey);
    let matchedExisting: DeduplicatedRoadPart | undefined;
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
          normOneway === 'bidirectional' &&
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
      // Enrich any missing rawOsmNodeIds on the canonical part from the verified duplicate
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

    const record: DeduplicatedRoadPart = {
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
  const internalNodes = new Map<string, InternalNodeRecord>();
  const topoKeyToCanonicalId = new Map<string, string>();
  let fallbackSeq = 0;

  const getScopeKey = (p: UnchainedRoadPart): string =>
    `${p.layer}|${p.isBridge ? 1 : 0}|${p.isTunnel ? 1 : 0}`;

  // Pass 3A: Register all explicit OSM node IDs first so coordinate-fallback points
  // always snap deterministically to explicit nodes regardless of feature order.
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
        const clipNodeId = `road_node:${scopeKey}:clip_${part.id}_${endpointLabel}`;
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
            isProtectedNode: false,
            additionalRoles: new Set<RoadNodeRole>(),
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
          canonicalNodeId = `road_node:${scopeKey}:osm_${rawOsm}`;
        } else {
          fallbackSeq++;
          canonicalNodeId = `road_node:${scopeKey}:fb_${fallbackSeq}`;
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
          isProtectedNode: false,
          additionalRoles: new Set<RoadNodeRole>(),
        });
      }

      resolvedIds.push(canonicalNodeId);
    }

    partVertexNodeIds.set(part.id, resolvedIds);
  }

  // 4. Clean consecutive identical-node zero-length duplicate vertices and count total node occurrences
  const nodeOccurrenceCount = new Map<string, number>();

  for (const item of retainedParts) {
    const { part, mutablePoints, mutableRawOsmNodeIds } = item;
    const nodeIds = partVertexNodeIds.get(part.id)!;

    // Strip consecutive duplicate vertices that resolved to the exact same node at ~0 distance
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

    for (let i = 0; i < nodeIds.length; i++) {
      const nid = nodeIds[i];
      nodeOccurrenceCount.set(nid, (nodeOccurrenceCount.get(nid) ?? 0) + 1);
    }
  }

  // 4B. Associate `highway=crossing` point features and cross-modal protected node options
  const allInternalNodesList = [...internalNodes.values()].filter((n) =>
    nodeOccurrenceCount.has(n.id)
  );

  const recordUnresolvedHighwayCrossingPoint = (
    ptMeta: InfrastructurePointMetadata,
    candidateNodeIds: readonly string[],
    reason: UnresolvedInfrastructurePointReason
  ) => {
    unresolvedInfrastructurePoints.push({
      pointId: ptMeta.id,
      rawOsmNodeId: ptMeta.rawOsmNodeId,
      kind: ptMeta.kind,
      position: [ptMeta.point[0], ptMeta.point[1]],
      candidateNodeIds: [...candidateNodeIds].sort(compareStringsCodeUnit),
      reason,
      osmTags: cloneOsmTags(ptMeta.osmTags),
    });
  };

  for (const ptMeta of extractedHighwayCrossingPoints) {
    const ptNormOsmId =
      stripRoadNodePrefix(ptMeta.rawOsmNodeId) ??
      (ptMeta.hasExplicitSourceId ? stripRoadNodePrefix(ptMeta.id) : undefined);
    const ptScope = extractPointExplicitVerticalScope(ptMeta.osmTags);

    let targetNode: InternalNodeRecord | undefined;

    const exactIdNodes =
      ptNormOsmId !== undefined
        ? allInternalNodesList.filter((n) => stripRoadNodePrefix(n.rawOsmNodeId) === ptNormOsmId)
        : [];

    if (exactIdNodes.length > 0) {
      const scopeCompatibleExact = exactIdNodes.filter((n) =>
        isRoadNodeCompatibleWithPointScope(n, ptScope)
      );
      if (scopeCompatibleExact.length !== 1) {
        recordUnresolvedHighwayCrossingPoint(
          ptMeta,
          exactIdNodes.map((n) => n.id),
          'vertical_scope_mismatch'
        );
        continue;
      }
      targetNode = scopeCompatibleExact[0];
    } else {
      const nearbyNodes = allInternalNodesList.filter(
        (n) =>
          !n.isBoundaryClipped &&
          Math.hypot(n.x - ptMeta.point[0], n.z - ptMeta.point[1]) <=
            DEFAULT_NODE_SNAP_TOLERANCE_METERS
      );

      if (nearbyNodes.length === 0) {
        recordUnresolvedHighwayCrossingPoint(
          ptMeta,
          [],
          'no_candidate_node_within_snap_tolerance'
        );
        continue;
      }

      const conflictingIdNodes =
        ptNormOsmId !== undefined
          ? nearbyNodes.filter(
              (n) =>
                n.rawOsmNodeId !== undefined &&
                stripRoadNodePrefix(n.rawOsmNodeId) !== ptNormOsmId
            )
          : [];

      if (conflictingIdNodes.length > 0) {
        recordUnresolvedHighwayCrossingPoint(
          ptMeta,
          nearbyNodes.map((n) => n.id),
          'conflicting_explicit_osm_node_id'
        );
        continue;
      }

      const scopeCompatibleNearby = nearbyNodes.filter((n) =>
        isRoadNodeCompatibleWithPointScope(n, ptScope)
      );

      if (scopeCompatibleNearby.length === 0) {
        recordUnresolvedHighwayCrossingPoint(
          ptMeta,
          nearbyNodes.map((n) => n.id),
          'vertical_scope_mismatch'
        );
        continue;
      }

      if (!ptScope.hasExplicitScope) {
        const nearbyVerticalScopes = new Set<string>();
        for (const n of nearbyNodes) {
          nearbyVerticalScopes.add(`${n.layer}|${n.isBridge ? 1 : 0}|${n.isTunnel ? 1 : 0}`);
        }
        for (const item of retainedParts) {
          const scopeKey = getScopeKey(item.part);
          if (nearbyVerticalScopes.has(scopeKey)) continue;
          if (
            distancePointToPolyline2D(ptMeta.point, item.mutablePoints) <=
            DEFAULT_NODE_SNAP_TOLERANCE_METERS
          ) {
            nearbyVerticalScopes.add(scopeKey);
          }
        }
        if (nearbyVerticalScopes.size > 1) {
          recordUnresolvedHighwayCrossingPoint(
            ptMeta,
            nearbyNodes.map((n) => n.id),
            'vertical_scope_mismatch'
          );
          continue;
        }
      }

      if (scopeCompatibleNearby.length > 1) {
        recordUnresolvedHighwayCrossingPoint(
          ptMeta,
          scopeCompatibleNearby.map((n) => n.id),
          'ambiguous_multiple_candidate_nodes'
        );
        continue;
      }

      targetNode = scopeCompatibleNearby[0];
    }

    if (targetNode && !targetNode.highwayCrossingPointMeta) {
      targetNode.highwayCrossingPointMeta = ptMeta;
      targetNode.isProtectedNode = true;
      targetNode.additionalRoles.add('highway_crossing');
    }
  }

  if (options?.protectedRawOsmNodeIds && options.protectedRawOsmNodeIds.size > 0) {
    for (const node of internalNodes.values()) {
      const normOsm = stripRoadNodePrefix(node.rawOsmNodeId);
      if (normOsm && options.protectedRawOsmNodeIds.has(normOsm)) {
        node.isProtectedNode = true;
      }
    }
  }

  if (options?.additionalNodeRolesByOsmId && options.additionalNodeRolesByOsmId.size > 0) {
    for (const node of internalNodes.values()) {
      const normOsm = stripRoadNodePrefix(node.rawOsmNodeId);
      if (normOsm) {
        const extra = options.additionalNodeRolesByOsmId.get(normOsm);
        if (extra) {
          for (const r of extra) {
            node.additionalRoles.add(r);
          }
        }
      }
    }
  }

  if (options?.protectedPartVertices && options.protectedPartVertices.size > 0) {
    for (const item of retainedParts) {
      const protectedIndices = options.protectedPartVertices.get(item.part.id);
      if (!protectedIndices) continue;
      const nodeIds = partVertexNodeIds.get(item.part.id)!;
      for (const vIdx of protectedIndices) {
        if (vIdx >= 0 && vIdx < nodeIds.length) {
          const nodeRec = internalNodes.get(nodeIds[vIdx]);
          if (nodeRec) {
            nodeRec.isProtectedNode = true;
          }
        }
      }
    }
  }

  // 5. Split parts at shared interior nodes (including self-loops, P-loops, highway_crossing, and protected level crossings)
  const draftEdges = new Map<number, DraftRoadEdge>();
  let nextDraftId = 1;

  for (const item of retainedParts) {
    const { part, canonicalOrder, deduplicatedFeatureIds, mutablePoints, mutableRawOsmNodeIds } =
      item;
    const nodeIds = partVertexNodeIds.get(part.id)!;
    const n = mutablePoints.length;
    if (n < 2) continue;

    const protectedIndices = options?.protectedPartVertices?.get(part.id);
    const splitIndices: number[] = [0];
    for (let i = 1; i < n - 1; i++) {
      const nid = nodeIds[i];
      const nodeRec = internalNodes.get(nid);
      if (
        (nodeOccurrenceCount.get(nid) ?? 0) >= 2 ||
        nodeRec?.isProtectedNode === true ||
        nodeRec?.highwayCrossingPointMeta !== undefined ||
        protectedIndices?.has(i) === true
      ) {
        splitIndices.push(i);
      }
    }
    splitIndices.push(n - 1);

    if (splitIndices.length > 2) {
      diagnostics.roadInteriorSplitCount += splitIndices.length - 2;
    }

    const cumLengths = computeCumulativeLengths(mutablePoints);
    const tier = getRoadTier(part.roadClass);
    const rawOnewayTag = extractRawOnewayTag(part.osmTags);
    const normalizedOneway = normalizeOnewayTag(rawOnewayTag);
    const lanes = parseLanesTag(part.osmTags);
    const surface = parseSurfaceTag(part.osmTags);

    for (let s = 0; s < splitIndices.length - 1; s++) {
      const startIdx = splitIndices[s];
      const endIdx = splitIndices[s + 1];
      const subPoints = mutablePoints.slice(startIdx, endIdx + 1).map((pt) => [pt[0], pt[1]] as [number, number]);
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
        roadClass: part.roadClass,
        tier,
        width: part.width,
        lanes,
        normalizedOneway,
        rawOnewayTag,
        name: part.name,
        surface,
        isCulvert: part.isCulvert,
        segments: [initialSegment],
      });
    }
  }

  // 6. OSMnx-style non-interstitial degree-2 path simplification
  // Build node -> incident draft edge IDs (counting self-loops twice for degree)
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
      // Single closed self-loop edge anchored at a degree-2 node
      node.isLoopAnchor = true;
      continue;
    }
    const e1 = draftEdges.get(id1)!;
    const e2 = draftEdges.get(id2)!;
    if (canContractDegree2RoadNode(node, e1, e2)) {
      contractibleDegree2Nodes.add(nodeId);
    } else if (!node.isBoundaryClipped && !areParallelDraftEdges(e1, e2)) {
      if (!haveCompatibleRoadAttributesAndFlow(node, e1, e2)) {
        node.isAttributeBreak = true;
      }
    }
  }

  // Detect any pure closed cycles composed entirely of contractibleDegree2Nodes
  // and pin a single deterministic loop_anchor node per cycle so the cycle contracts
  // into 1 closed-loop edge rather than disappearing.
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
        compareAnchorCandidateNodes(internalNodes.get(a)!, internalNodes.get(b)!)
      );
      const anchorNodeId = componentNodes[0];
      contractibleDegree2Nodes.delete(anchorNodeId);
      internalNodes.get(anchorNodeId)!.isLoopAnchor = true;
    }
  }

  // Contract remaining contractible degree-2 chains deterministically
  // Walk maximal chains between non-contractible endpoints
  if (contractibleDegree2Nodes.size > 0) {
    const consumedEdgeIds = new Set<number>();
    const currentAdj = buildNodeIncidentDrafts();

    // Find all maximal chains passing through contractibleDegree2Nodes
    const chains: Array<{
      edgeIds: number[];
      startNodeId: string;
      endNodeId: string;
    }> = [];

    for (const edge of draftEdges.values()) {
      if (consumedEdgeIds.has(edge.draftId)) continue;
      const uContractible = contractibleDegree2Nodes.has(edge.fromNodeId);
      const vContractible = contractibleDegree2Nodes.has(edge.toNodeId);
      if (!uContractible && !vContractible) {
        continue;
      }

      // Walk backwards from edge.fromNodeId while contractible
      const backwardEdges: number[] = [];
      let currNode = edge.fromNodeId;
      let prevEdgeId = edge.draftId;
      while (contractibleDegree2Nodes.has(currNode)) {
        const inc = currentAdj.get(currNode)!;
        const nextEdgeId = inc[0] === prevEdgeId ? inc[1] : inc[0];
        if (nextEdgeId === edge.draftId || consumedEdgeIds.has(nextEdgeId)) break;
        backwardEdges.unshift(nextEdgeId);
        const nextEdge = draftEdges.get(nextEdgeId)!;
        currNode = nextEdge.fromNodeId === currNode ? nextEdge.toNodeId : nextEdge.fromNodeId;
        prevEdgeId = nextEdgeId;
      }
      const chainStartNode = currNode;

      // Walk forwards from edge.toNodeId while contractible
      const forwardEdges: number[] = [];
      currNode = edge.toNodeId;
      prevEdgeId = edge.draftId;
      while (contractibleDegree2Nodes.has(currNode)) {
        const inc = currentAdj.get(currNode)!;
        const nextEdgeId = inc[0] === prevEdgeId ? inc[1] : inc[0];
        if (nextEdgeId === edge.draftId || consumedEdgeIds.has(nextEdgeId)) break;
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
      });
    }

    for (const chain of chains) {
      if (chain.edgeIds.length <= 1) continue;
      const firstEdge = draftEdges.get(chain.edgeIds[0])!;
      const lastEdge = draftEdges.get(chain.edgeIds[chain.edgeIds.length - 1])!;

      // Decide chain traversal direction deterministically:
      // For one-way edges ('forward' | 'reverse'), keep original edge orientation without reversing.
      // For bidirectional edges, start from the end whose incident edge has the smaller canonicalOrder.
      let orderedEdgeIds = [...chain.edgeIds];
      let cursorNodeId = chain.startNodeId;

      if (isDirectedOneway(firstEdge.normalizedOneway)) {
        // If all edges in the chain share the exact same normalizedOneway ('forward' or 'reverse'),
        // preserve their shared digitization direction; otherwise orient along forward traffic flow.
        const allSameOnewayMode = chain.edgeIds.every(
          (eid) => draftEdges.get(eid)!.normalizedOneway === firstEdge.normalizedOneway
        );
        if (allSameOnewayMode) {
          if (firstEdge.toNodeId === chain.startNodeId) {
            orderedEdgeIds.reverse();
            cursorNodeId = chain.endNodeId;
          }
        } else {
          // Mixed 'forward' and 'reverse' encodings of the same physical one-way flow:
          // start at the chain endpoint where traffic flows OUT OF the endpoint into the chain.
          if (edgeFlowsIntoNode(firstEdge, chain.startNodeId)) {
            orderedEdgeIds.reverse();
            cursorNodeId = chain.endNodeId;
          }
        }
      } else if (lastEdge.canonicalOrder < firstEdge.canonicalOrder) {
        orderedEdgeIds.reverse();
        cursorNodeId = chain.endNodeId;
      }

      let mergedEdge = draftEdges.get(orderedEdgeIds[0])!;
      if (mergedEdge.fromNodeId !== cursorNodeId) {
        mergedEdge = reverseDraftRoadEdge(mergedEdge);
      }
      cursorNodeId = mergedEdge.toNodeId;

      for (let i = 1; i < orderedEdgeIds.length; i++) {
        let nextEdge = draftEdges.get(orderedEdgeIds[i])!;
        if (nextEdge.fromNodeId !== cursorNodeId) {
          nextEdge = reverseDraftRoadEdge(nextEdge);
        }
        mergedEdge = concatenateDraftRoadEdges(mergedEdge, nextEdge);
        cursorNodeId = mergedEdge.toNodeId;
      }

      for (const oldId of orderedEdgeIds) {
        draftEdges.delete(oldId);
      }
      draftEdges.set(mergedEdge.draftId, mergedEdge);
      diagnostics.roadSimplifiedDegree2Count += orderedEdgeIds.length - 1;
    }
  }

  // 7. Assign parallelIndex, canonical edge IDs, and build final RoadEdge & RoadNode maps
  const pairGroups = new Map<string, DraftRoadEdge[]>();
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

  const finalEdgesList: RoadEdge[] = [];

  for (const group of pairGroups.values()) {
    if (group.length >= 2) {
      diagnostics.roadParallelEdgePairCount++;
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
        segments: d.segments,
      };

      const startSegAnchor = Math.min(
        firstSeg.sourceStartVertexIndex,
        firstSeg.sourceEndVertexIndex
      );
      const edgeId = `road_edge:${primaryPartId}:seg_${startSegAnchor}:p_${pIdx}`;
      const isClosedLoop = d.fromNodeId === d.toNodeId;
      if (isClosedLoop) {
        diagnostics.closedLoopEdgeCount++;
      }

      finalEdgesList.push({
        id: edgeId,
        network: 'road',
        fromNodeId: d.fromNodeId,
        toNodeId: d.toNodeId,
        parallelIndex: pIdx,
        points: d.points,
        vertexRawOsmNodeIds: d.vertexRawOsmNodeIds,
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
        roadClass: d.roadClass,
        tier: d.tier,
        width: d.width,
        lanes: d.lanes,
        normalizedOneway: d.normalizedOneway,
        rawOnewayTag: d.rawOnewayTag,
        name: d.name,
        surface: d.surface,
        isCulvert: d.isCulvert,
      });
    }
  }

  finalEdgesList.sort((a, b) => compareStringsCodeUnit(a.id, b.id));

  const edgesMap = new Map<string, RoadEdge>();
  const featureToEdgesTemp = new Map<string, Set<string>>();
  const nodeHalfEdgesMap = new Map<string, IncidentHalfEdge[]>();
  const nodeTiersMap = new Map<string, Set<RoadTier>>();

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

    // Attach start half-edge to `fromNodeId`
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

    // Attach end half-edge to `toNodeId` (for self-loop, attaches a second half-edge to the same node)
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

    let fromTiers = nodeTiersMap.get(edge.fromNodeId);
    if (!fromTiers) {
      fromTiers = new Set<RoadTier>();
      nodeTiersMap.set(edge.fromNodeId, fromTiers);
    }
    fromTiers.add(edge.tier);

    let toTiers = nodeTiersMap.get(edge.toNodeId);
    if (!toTiers) {
      toTiers = new Set<RoadTier>();
      nodeTiersMap.set(edge.toNodeId, toTiers);
    }
    toTiers.add(edge.tier);
  }

  const nodesMap = new Map<string, RoadNode>();
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

    const tiers = nodeTiersMap.get(nodeId);
    const isCrossTier = Boolean(tiers && tiers.has('vehicular') && tiers.has('path'));

    const rolesSet = new Set<RoadNodeRole>();
    if (rec.isBoundaryClipped) {
      rolesSet.add('boundary_clip');
      diagnostics.boundaryClippedNodeCount++;
    }
    if (degree === 1 && !rec.isBoundaryClipped) {
      rolesSet.add('dead_end');
    }
    if (degree >= 3) {
      rolesSet.add('junction');
    }
    if (rec.isLoopAnchor) {
      rolesSet.add('loop_anchor');
    }
    if (rec.isAttributeBreak) {
      rolesSet.add('attribute_break');
    }
    if (rec.highwayCrossingPointMeta !== undefined) {
      rolesSet.add('highway_crossing');
    }
    for (const extraRole of rec.additionalRoles) {
      rolesSet.add(extraRole);
    }
    if (isCrossTier) {
      rolesSet.add('cross_tier');
      diagnostics.crossTierNodeCount++;
    }
    if (rolesSet.size === 0) {
      // e.g. degree-2 node where two parallel edges meet between two endpoints
      rolesSet.add('junction');
    }

    const roles = [...rolesSet].sort((a, b) => compareStringsCodeUnit(a, b));
    const primaryRole = selectPrimaryRoadNodeRole(roles);

    nodesMap.set(nodeId, {
      id: nodeId,
      network: 'road',
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
      isCrossTier,
      pointOsmTags: rec.highwayCrossingPointMeta?.osmTags
        ? cloneOsmTags(rec.highwayCrossingPointMeta.osmTags)
        : undefined,
    });
  }

  const featureToEdgeIds = new Map<string, readonly string[]>();
  for (const [featId, set] of [...featureToEdgesTemp.entries()].sort((a, b) =>
    compareStringsCodeUnit(a[0], b[0])
  )) {
    featureToEdgeIds.set(featId, [...set].sort(compareStringsCodeUnit));
  }

  diagnostics.roadNodeCount = nodesMap.size;
  diagnostics.roadEdgeCount = edgesMap.size;

  return {
    roads: {
      nodes: nodesMap,
      edges: edgesMap,
      featureToEdgeIds,
    },
    diagnostics,
  };
}
