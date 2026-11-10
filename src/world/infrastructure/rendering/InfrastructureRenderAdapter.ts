import {
  ProcessedMapData,
  RailwayFeature,
  RailwayType,
  RawGeoJsonProperties,
  RoadClass,
} from '../../../types/MapFeature';
import {
  buildInfrastructureGraph,
  compareStringsCodeUnit,
  EdgeProvenance,
  EdgeSegmentProvenance,
  GradeSeparatedCrossingRelation,
  GradeTransitionRelation,
  IncidentHalfEdge,
  InfrastructureGraph,
  InfrastructureNetworkKind,
  LevelCrossingRelation,
  NodeIdOrigin,
  NormalizedOneWay,
  RailwayEdge,
  RailwayFlatCrossingRelation,
  RailwayNode,
  RailwayNodeRole,
  RoadEdge,
  RoadNode,
  RoadNodeRole,
  RoadTier,
  TopologyDiagnostics,
  TopologySourceData,
  TurnoutClassificationStatus,
  TurnoutTopologySpec,
  UnresolvedCrossingCandidate,
  UnresolvedGradeTransitionCandidate,
  UnresolvedInfrastructurePointCandidate,
} from '../topology/InfrastructureGraph';

/**
 * Selects the data source mode for road infrastructure rendering in Milestone 2.3 Stage E2.
 *
 * - `'legacy'`: Default production mode. Uses existing `ProcessedMapData.roads`
 *   with zero graph construction or adapter overhead when both domains are `'legacy'`.
 * - `'graph-preview'`: Stage E1 preview mode. Builds and validates graph-backed render descriptors
 *   from a single shared `InfrastructureGraph` alongside the legacy road renderer without altering
 *   existing 3D mesh generation.
 * - `'graph'`: Stage E2 graph-driven road rendering mode. Builds and validates `InfrastructureGraph`
 *   and `InfrastructureRenderDescriptorBundle`, then constructs at-grade road ribbons, degree-2
 *   continuity joins, and boundary-derived junction polygons directly from the road render descriptors.
 * - `'graph-surface'`: E2+ experiment: rounded centerline buffers with planar ownership, no junction cuts.
 */
export type RoadInfrastructureRenderSource = 'legacy' | 'graph-preview' | 'graph' | 'graph-surface';

/**
 * Selects the data source mode for railway infrastructure rendering in Milestone 2.3 Stage E1–E3.
 *
 * - `'legacy'`: Default production mode. Uses existing `ProcessedMapData.railways`.
 * - `'graph-preview'`: Builds and validates railway render descriptors alongside the legacy railway renderer.
 * - `'graph'`: Stage E3-A1 graph-driven railway rendering mode. Adapts `RailwayEdgeRenderDescriptor`s
 *   into Candidate B inputs preserving baseline heuristic switch geometry.
 * - `'graph-switches'`: Stage E3-A2 graph-informed switch rendering mode. Uses verified
 *   `turnoutTopology` descriptors to govern bearer sharing, sleeper support, and blade tapering.
 * - `'graph-R+'`: Stage E3-B experimental surface-first railway ballast mode. Uses consolidated 2D
 *   ballast footprints while preserving graph-informed rails, sleepers, and switch semantics.
 */
export type RailwayInfrastructureRenderSource =
  | 'legacy'
  | 'graph-preview'
  | 'graph'
  | 'graph-switches'
  | 'graph-R+';

/**
 * Switch policy governing railway turnout bearer sharing and blade tapering (Stage E3-A2).
 *
 * - `'heuristic'`: Historical Candidate B behavior using `isTurnoutThroatPair` proximity detection.
 * - `'graph'`: Graph-informed behavior consuming `RailwayNodeRenderDescriptor.turnoutTopology`.
 */
export type RailwaySwitchPolicy = 'heuristic' | 'graph';

/**
 * Strategy governing at-grade railway ballast surface construction (Stage E3-B).
 *
 * - `'ribbon'`: Candidate B continuous track-aligned UV ribbons with overlapping parallel/switch footprints.
 * - `'surface-first'`: Stage E3-B consolidated 2D polygonal ballast footprints unioned per connected component.
 */
export type RailwayBallastStrategy = 'ribbon' | 'surface-first';

export type InfrastructureRenderSource =
  | RoadInfrastructureRenderSource
  | RailwayInfrastructureRenderSource;

/**
 * Independent developer configuration switches for road and railway topology-to-renderer modes.
 */
export interface InfrastructureRenderOptions {
  roads: RoadInfrastructureRenderSource;
  railways: RailwayInfrastructureRenderSource;
  railwaySwitchPolicy?: RailwaySwitchPolicy;
  railwayBallastStrategy?: RailwayBallastStrategy;
}

/**
 * Default infrastructure render configuration (both domains use `'legacy'`).
 */
export const DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS: Readonly<InfrastructureRenderOptions> =
  Object.freeze({
    roads: 'legacy',
    railways: 'legacy',
  });

/**
 * Parses a raw string value into a valid `RoadInfrastructureRenderSource` (`'legacy' | 'graph-preview' | 'graph'`),
 * resolving any absent or unrecognized value safely to `'legacy'`.
 */
export function parseRoadInfrastructureRenderSource(
  raw: string | null | undefined
): RoadInfrastructureRenderSource {
  if (typeof raw !== 'string') return 'legacy';
  const normalized = raw.trim();
  if (normalized === 'graph-preview' || normalized === 'graph' || normalized === 'graph-surface') {
    return normalized;
  }
  return 'legacy';
}

/**
 * Parses a raw string value into a valid `RailwayInfrastructureRenderSource` (`'legacy' | 'graph-preview' | 'graph' | 'graph-switches'`),
 * resolving any absent or unrecognized value safely to `'legacy'`.
 */
export function parseRailwayInfrastructureRenderSource(
  raw: string | null | undefined
): RailwayInfrastructureRenderSource {
  if (typeof raw !== 'string') return 'legacy';
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'graph-preview') return 'graph-preview';
  if (lower === 'graph') return 'graph';
  if (lower === 'graph-switches') return 'graph-switches';
  if (lower === 'graph-r+' || lower === 'graph-r ' || lower === 'graph-r') return 'graph-R+';
  return 'legacy';
}

/**
 * Parses a raw string value into a valid `RailwaySwitchPolicy` (`'heuristic' | 'graph'`).
 */
export function parseRailwaySwitchPolicy(
  raw: string | null | undefined,
  renderSource?: RailwayInfrastructureRenderSource
): RailwaySwitchPolicy {
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'graph') return 'graph';
    if (normalized === 'heuristic' || normalized === 'legacy') return 'heuristic';
  }
  if (renderSource === 'graph-switches' || renderSource === 'graph-R+') {
    return 'graph';
  }
  return 'heuristic';
}

/**
 * Parses a raw string value into a valid `RailwayBallastStrategy` (`'ribbon' | 'surface-first'`).
 */
export function parseRailwayBallastStrategy(
  raw: string | null | undefined,
  renderSource?: RailwayInfrastructureRenderSource
): RailwayBallastStrategy {
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (
      normalized === 'surface-first' ||
      normalized === 'surface' ||
      normalized === 'r+' ||
      normalized === 'r ' ||
      normalized === 'r'
    ) {
      return 'surface-first';
    }
    if (normalized === 'ribbon' || normalized === 'legacy') return 'ribbon';
  }
  if (renderSource === 'graph-R+') {
    return 'surface-first';
  }
  return 'ribbon';
}

/**
 * Adapts Stage E1/E3 railway edge render descriptors into `RailwayFeature` records
 * consumed by Candidate B (`RailwayGeometryBuilder.ts`) in Milestone 2.3 Stage E3-A1.
 *
 * Preserves:
 * - Edge ID and canonical points polyline `[x, z][]`
 * - Track gauge, widths, layers, and bridge/tunnel profile flags
 * - Primary source feature ID and complete constituent `sourceFeatureIds` (retaining full OSM provenance)
 * - Raw OSM node IDs and original tags
 * - Railway classifications (`railwayType`, `service`, `usage`)
 */
export function adaptRailwayEdgeDescriptorsToFeatures(
  edges: readonly RailwayEdgeRenderDescriptor[]
): RailwayFeature[] {
  return edges.map((edge) => {
    const sids =
      edge.sourceFeatureIds && edge.sourceFeatureIds.length > 0
        ? [...edge.sourceFeatureIds]
        : [edge.sourceFeatureId || edge.id];

    return {
      id: edge.id,
      sourceFeatureId: edge.sourceFeatureId || sids[0],
      sourceFeatureIds: sids,
      type: 'railway',
      name: edge.name,
      points: edge.points.map((p) => [p[0], p[1]] as [number, number]),
      nodeIds: edge.vertexRawOsmNodeIds.map((nid) => nid ?? ''),
      railwayType: edge.railwayType,
      width: edge.width,
      isBridge: edge.isBridge,
      isTunnel: edge.isTunnel,
      layer: edge.layer,
      gauge: edge.gauge ? Number(edge.gauge) : undefined,
      electrified: edge.electrified ? edge.electrified !== 'no' : undefined,
      cartoLabel: edge.name || `Railway (${edge.railwayType})`,
      primaryTag: `railway=${edge.railwayType}`,
      osmTags: {
        ...edge.primaryOsmTags,
        ...(edge.service ? { service: edge.service } : {}),
        ...(edge.usage ? { usage: edge.usage } : {}),
        ...(edge.gauge ? { gauge: edge.gauge } : {}),
        ...(edge.electrified ? { electrified: edge.electrified } : {}),
      },
    };
  });
}

/**
 * Parses a raw string value into a valid `InfrastructureRenderSource` for the specified domain
 * (defaults to `'roads'`), resolving any absent or unrecognized value safely to `'legacy'`.
 */
export function parseInfrastructureRenderSource(
  raw: string | null | undefined,
  domain: 'roads' | 'railways' = 'roads'
): InfrastructureRenderSource {
  if (domain === 'railways') {
    return parseRailwayInfrastructureRenderSource(raw);
  }
  return parseRoadInfrastructureRenderSource(raw);
}

/**
 * Normalizes partial or undefined `InfrastructureRenderOptions` so `roads` is guaranteed to be
 * `'legacy' | 'graph-preview' | 'graph'` and `railways` is guaranteed to be `'legacy' | 'graph-preview'`.
 */
export function normalizeInfrastructureRenderOptions(
  options?: {
    roads?: string | null;
    railways?: string | null;
    railwaySwitchPolicy?: string | null;
    railwayBallastStrategy?: string | null;
  } | null
): InfrastructureRenderOptions {
  if (!options) {
    return {
      roads: DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS.roads,
      railways: DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS.railways,
    };
  }
  const railways = parseRailwayInfrastructureRenderSource(options.railways);
  const result: InfrastructureRenderOptions = {
    roads: parseRoadInfrastructureRenderSource(options.roads),
    railways,
  };
  if (
    options.railwaySwitchPolicy !== undefined ||
    railways === 'graph-switches' ||
    railways === 'graph-R+'
  ) {
    result.railwaySwitchPolicy = parseRailwaySwitchPolicy(options.railwaySwitchPolicy, railways);
  }
  if (options.railwayBallastStrategy !== undefined || railways === 'graph-R+') {
    result.railwayBallastStrategy = parseRailwayBallastStrategy(
      options.railwayBallastStrategy,
      railways
    );
  }
  return result;
}

/**
 * Parses independent `topologyRoads` and `topologyRailways` developer switches
 * from a URL query string (e.g. `?topologyRoads=graph&topologyRailways=legacy`)
 * or `URLSearchParams` instance. Invalid or missing parameters resolve to `'legacy'`.
 */
export function parseInfrastructureRenderOptionsFromSearch(
  search: string | URLSearchParams | null | undefined
): InfrastructureRenderOptions {
  if (!search) {
    return {
      roads: 'legacy',
      railways: 'legacy',
    };
  }
  const params =
    typeof search === 'string'
      ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
      : search;
  const railways = parseRailwayInfrastructureRenderSource(params.get('topologyRailways'));
  const rawPolicy = params.get('railwaySwitchPolicy') ?? params.get('railwaySwitches');
  const rawBallast = params.get('railwayBallastStrategy') ?? params.get('railwayBallast');
  const result: InfrastructureRenderOptions = {
    roads: parseRoadInfrastructureRenderSource(params.get('topologyRoads')),
    railways,
  };
  if (rawPolicy !== null || railways === 'graph-switches' || railways === 'graph-R+') {
    result.railwaySwitchPolicy = parseRailwaySwitchPolicy(rawPolicy, railways);
  }
  if (rawBallast !== null || railways === 'graph-R+') {
    result.railwayBallastStrategy = parseRailwayBallastStrategy(rawBallast, railways);
  }
  return result;
}

/**
 * Returns `true` if at least one domain (`roads` or `railways`) requires `InfrastructureGraph`
 * and `InfrastructureRenderDescriptorBundle` construction (i.e. `'graph-preview'` or `'graph'`).
 * When both domains are `'legacy'`, callers must skip `buildInfrastructureGraph` and adapter execution.
 */
export function requiresInfrastructureGraphPreview(
  options?: { roads?: string | null; railways?: string | null } | null
): boolean {
  const normalized = normalizeInfrastructureRenderOptions(options);
  return normalized.roads !== 'legacy' || normalized.railways !== 'legacy';
}

/**
 * Render-ready descriptor for a topological road node (Stage E2 handoff contract).
 *
 * Distinguishes vehicular vs. path incident half-edges so that cross-tier contacts
 * (e.g. a footpath meeting or crossing a vehicular road at an explicit OSM node)
 * never trigger false vehicular carriageway asphalt junction trimming (`ADR-0002`, `ADR-0009` Resolution 3).
 */
export interface RoadNodeRenderDescriptor {
  /** Canonical road node ID (e.g. `"road_node:0|0|0:osm_5001"`). */
  id: string;
  /** Verified raw unprefixed OSM node ID if grounded in explicit OSM data. */
  rawOsmNodeId?: string;
  /** Provenance of node identity (`'explicit_osm' | 'coordinate_fallback' | 'boundary_clip'`). */
  nodeIdOrigin: NodeIdOrigin;
  /** World coordinates `[x, z]` in local meters. */
  position: readonly [number, number];
  /** Effective vertical OSM layer. */
  layer: number;
  /** True if node belongs to a bridge vertical scope. */
  isBridge: boolean;
  /** True if node belongs to a tunnel vertical scope. */
  isTunnel: boolean;
  /** True if synthesized at the loaded region clipping boundary. */
  isBoundaryClipped: boolean;
  /** Total attached half-edge count (`incidentHalfEdges.length`). */
  degree: number;
  /** Primary topological role selected by precedence. */
  primaryRole: RoadNodeRole;
  /** Non-exclusive canonically sorted list of all topological roles on this node. */
  roles: readonly RoadNodeRole[];
  /** True if incident to both `'vehicular'` and `'path'` road edges. */
  isCrossTier: boolean;
  /** Number of attached half-edges belonging to `'vehicular'` road edges. */
  vehicularHalfEdgeCount: number;
  /** Number of attached half-edges belonging to `'path'` road edges. */
  pathHalfEdgeCount: number;
  /** Attached half-edges belonging exclusively to `'vehicular'` road edges. */
  vehicularIncidentHalfEdges: readonly IncidentHalfEdge[];
  /** Attached half-edges belonging exclusively to `'path'` road edges. */
  pathIncidentHalfEdges: readonly IncidentHalfEdge[];
  /**
   * True when this node is cross-tier (`isCrossTier === true`) and has at most 2 vehicular half-edges
   * (i.e. a path contacts a terminating vehicular way [1 vehicular arm] or a continuous through-road
   * [2 vehicular arms] without a vehicular-to-vehicular branch intersection).
   * E2 must NOT perform vehicular carriageway junction trimming for path branches.
   */
  isCrossTierOnlyInteraction: boolean;
  /**
   * True when at-grade (`layer === 0 && !isBridge && !isTunnel`), not cross-tier-only, and
   * `vehicularHalfEdgeCount >= 3` (or an explicit multi-way vehicular branching junction),
   * indicating that E2 full-width vehicular carriageway junction trimming and intersection asphalt
   * synthesis applies across `vehicularIncidentHalfEdges`.
   */
  requiresVehicularJunctionTrimming: boolean;
  /**
   * True when at-grade (`layer === 0 && !isBridge && !isTunnel`) and `vehicularHalfEdgeCount === 2`,
   * indicating that E2 degree-2 road continuity and miter join synthesis applies across the two
   * continuous vehicular half-edges (as a separate concern from full-width branching junction trimming).
   */
  requiresVehicularContinuityMiter: boolean;
  /**
   * True when at-grade (`layer === 0 && !isBridge && !isTunnel`), `vehicularHalfEdgeCount === 0`,
   * and `pathHalfEdgeCount >= 2`.
   */
  requiresPathJunctionTrimming: boolean;
  /** Deduplicated, canonically sorted unique incident road edge IDs. */
  incidentEdgeIds: readonly string[];
  /** All attached road half-edges (`incidentHalfEdges.length === degree`). */
  incidentHalfEdges: readonly IncidentHalfEdge[];
  /** Point-level OSM tags if an ingested `InfrastructurePointMetadata` feature matched this node. */
  pointOsmTags?: RawGeoJsonProperties;
  /** Confirmed `GradeTransitionRelation.id`s anchored at this road node. */
  gradeTransitionIds: readonly string[];
  /** Confirmed `LevelCrossingRelation.id`s anchored at this road node. */
  levelCrossingIds: readonly string[];
}

/**
 * Render-ready descriptor for a topological road edge (Stage E2 & M2.4 handoff contract).
 *
 * Preserves canonical edge/node IDs, ordered metric polyline geometry, road class/tier,
 * width, lanes, one-way orientation, surface, culvert/bridge/tunnel flags, boundary clipping,
 * endpoint tangents/roles, complete per-segment provenance, and crossing/portal relations.
 */
export interface RoadEdgeRenderDescriptor {
  /** Canonical road edge ID. */
  id: string;
  /** Start road node ID (`points[0]`). */
  fromNodeId: string;
  /** End road node ID (`points[points.length - 1]`). */
  toNodeId: string;
  /** Zero-based parallel multi-edge index between `{fromNodeId, toNodeId}`. */
  parallelIndex: number;
  /** Ordered 2D metric polyline vertices `[x, z][]` in `fromNodeId -> toNodeId` order. */
  points: readonly [number, number][];
  /** Verified raw OSM node IDs aligned 1:1 with `points` (`undefined` where untagged or clipped). */
  vertexRawOsmNodeIds: readonly (string | undefined)[];
  /** Cumulative Euclidean arc-length in meters. */
  lengthMeters: number;
  /** Classified OSM road class. */
  roadClass: RoadClass;
  /** Road tier (`'vehicular' | 'path'`). */
  tier: RoadTier;
  /** Unscaled road width in meters. */
  width: number;
  /** Parsed lane count if present in OSM tags. */
  lanes?: number;
  /** Normalized one-way direction relative to `fromNodeId -> toNodeId`. */
  normalizedOneway: NormalizedOneWay;
  /** Verbatim raw `oneway` tag value from OSM if present. */
  rawOnewayTag?: string;
  /** Normalized surface material tag if present (e.g. `'asphalt'`, `'paving_stones'`). */
  surface?: string;
  /** Road name if present. */
  name?: string;
  /** Effective vertical OSM layer. */
  layer: number;
  /** True if road edge is a bridge structure. */
  isBridge: boolean;
  /** True if road edge is a tunnel structure. */
  isTunnel: boolean;
  /** True if road edge is an at-grade culvert crossing. */
  isCulvert: boolean;
  /** True if rendered in the at-grade road surface pass (`(layer === 0 && !isBridge && !isTunnel) || isCulvert`). */
  isAtGradeBuildable: boolean;
  /** True if `fromNodeId === toNodeId`. */
  isClosedLoop: boolean;
  /** True if `points[0]` was synthesized by region bounding-box clipping. */
  clippedAtStart: boolean;
  /** True if `points[points.length - 1]` was synthesized by region bounding-box clipping. */
  clippedAtEnd: boolean;
  /** Unit tangent `[dx, dz]` at `points[0]` pointing inward along the edge (`fromNodeId -> points[1]`). */
  startInwardTangent: readonly [number, number];
  /** Unit tangent `[dx, dz]` at `points[N-1]` pointing inward along the edge (`toNodeId -> points[N-2]`). */
  endInwardTangent: readonly [number, number];
  /** Topological roles held by `fromNodeId`. */
  startNodeRoles: readonly RoadNodeRole[];
  /** Topological roles held by `toNodeId`. */
  endNodeRoles: readonly RoadNodeRole[];
  /** True if `fromNodeId` is a cross-tier node (`vehicular` + `path`). */
  startNodeIsCrossTier: boolean;
  /** True if `toNodeId` is a cross-tier node (`vehicular` + `path`). */
  endNodeIsCrossTier: boolean;
  /** Primary original OSM source feature ID (`provenance.segments[0].sourceFeatureId`). */
  sourceFeatureId: string;
  /** Canonically sorted list of all original OSM source feature IDs contributing to this edge. */
  sourceFeatureIds: readonly string[];
  /** Canonically sorted list of exact-duplicate feature IDs merged into this edge's segments. */
  deduplicatedFeatureIds: readonly string[];
  /** Cloned OSM tags from the primary constituent segment for `InspectableFeatureInfo` construction. */
  primaryOsmTags: RawGeoJsonProperties;
  /** Complete per-segment OSMnx-style provenance covering `[0, lengthMeters]`. */
  provenance: EdgeProvenance;
  /** Confirmed `GradeTransitionRelation.id` at the `'start'` (`fromNodeId`) endpoint, if any. */
  startGradeTransitionId?: string;
  /** Confirmed `GradeTransitionRelation.id` at the `'end'` (`toNodeId`) endpoint, if any. */
  endGradeTransitionId?: string;
  /** All confirmed `GradeTransitionRelation.id`s attached to this road edge. */
  gradeTransitionIds: readonly string[];
  /** All confirmed `LevelCrossingRelation.id`s along this road edge, ordered by `roadArcLengthMeters`. */
  levelCrossingIds: readonly string[];
  /** All `GradeSeparatedCrossingRelation.id`s where this road edge is the upper or lower way. */
  gradeSeparatedCrossingIds: readonly string[];
}

/**
 * Render-ready descriptor for a topological railway node (Stage E3 handoff contract).
 *
 * Explicitly separates confirmed turnout switches (`turnoutStatus === 'confirmed'`)
 * from unresolved switches (`'unresolved_main_vs_diverging' | 'unresolved_throat'`)
 * and non-interchanging flat crossings (`roles.includes('railway_crossing')`).
 */
export interface RailwayNodeRenderDescriptor {
  /** Canonical railway node ID. */
  id: string;
  /** Verified raw unprefixed OSM node ID if grounded in explicit OSM data. */
  rawOsmNodeId?: string;
  /** Provenance of node identity (`'explicit_osm' | 'coordinate_fallback' | 'boundary_clip'`). */
  nodeIdOrigin: NodeIdOrigin;
  /** World coordinates `[x, z]` in local meters. */
  position: readonly [number, number];
  /** Effective vertical OSM layer. */
  layer: number;
  /** True if node belongs to a bridge vertical scope. */
  isBridge: boolean;
  /** True if node belongs to a tunnel vertical scope. */
  isTunnel: boolean;
  /** True if synthesized at the loaded region clipping boundary. */
  isBoundaryClipped: boolean;
  /** Total attached half-edge count (`incidentHalfEdges.length`). */
  degree: number;
  /** Primary topological role selected by precedence. */
  primaryRole: RailwayNodeRole;
  /** Non-exclusive canonically sorted list of all topological roles on this node. */
  roles: readonly RailwayNodeRole[];
  /** Deduplicated, canonically sorted unique incident railway edge IDs. */
  incidentEdgeIds: readonly string[];
  /** All attached railway half-edges (`incidentHalfEdges.length === degree`). */
  incidentHalfEdges: readonly IncidentHalfEdge[];
  /** Turnout classification status (`'none'` when node is not a candidate switch). */
  turnoutStatus: 'none' | TurnoutClassificationStatus;
  /** True iff `turnoutStatus === 'confirmed'`. */
  isConfirmedSwitch: boolean;
  /** True iff `turnoutStatus === 'unresolved_main_vs_diverging' || turnoutStatus === 'unresolved_throat'`. */
  isUnresolvedSwitch: boolean;
  /** Full turnout branch specification when `turnoutTopology` is present on the graph node. */
  turnoutTopology?: TurnoutTopologySpec;
  /** Point-level OSM tags if an ingested `InfrastructurePointMetadata` feature matched this node. */
  pointOsmTags?: RawGeoJsonProperties;
  /** Confirmed `RailwayFlatCrossingRelation.id`s associated with this node. */
  flatCrossingIds: readonly string[];
  /** Confirmed `GradeTransitionRelation.id`s anchored at this railway node. */
  gradeTransitionIds: readonly string[];
  /** Confirmed `LevelCrossingRelation.id`s anchored at this railway node. */
  levelCrossingIds: readonly string[];
}

/**
 * Render-ready descriptor for a topological railway edge (Stage E3 handoff contract).
 */
export interface RailwayEdgeRenderDescriptor {
  /** Canonical railway edge ID. */
  id: string;
  /** Start railway node ID (`points[0]`). */
  fromNodeId: string;
  /** End railway node ID (`points[points.length - 1]`). */
  toNodeId: string;
  /** Zero-based parallel multi-edge index between `{fromNodeId, toNodeId}`. */
  parallelIndex: number;
  /** Ordered 2D metric polyline vertices `[x, z][]` in `fromNodeId -> toNodeId` order. */
  points: readonly [number, number][];
  /** Verified raw OSM node IDs aligned 1:1 with `points` (`undefined` where untagged or clipped). */
  vertexRawOsmNodeIds: readonly (string | undefined)[];
  /** Cumulative Euclidean arc-length in meters. */
  lengthMeters: number;
  /** Classified OSM railway type (`'rail'`, `'tram'`, `'light_rail'`, `'subway'`, etc.). */
  railwayType: RailwayType;
  /** Track bed width in meters. */
  width: number;
  /** Raw gauge string from OSM tags if present (e.g. `'1435'`). */
  gauge?: string;
  /** Raw electrification tag from OSM if present (e.g. `'contact_line'`, `'no'`). */
  electrified?: string;
  /** Raw railway service tag if present (e.g. `'siding'`, `'yard'`, `'spur'`, `'crossover'`). */
  service?: string;
  /** Raw railway usage tag if present (e.g. `'main'`, `'branch'`). */
  usage?: string;
  /** Railway line/track name if present. */
  name?: string;
  /** True if classified as a secondary branch (`service=siding|yard|spur|crossover` or `usage=industrial|military`). */
  isSecondaryBranch: boolean;
  /** Effective vertical OSM layer. */
  layer: number;
  /** True if railway edge is a bridge structure. */
  isBridge: boolean;
  /** True if railway edge is a tunnel structure. */
  isTunnel: boolean;
  /** True if `fromNodeId === toNodeId`. */
  isClosedLoop: boolean;
  /** True if `points[0]` was synthesized by region bounding-box clipping. */
  clippedAtStart: boolean;
  /** True if `points[points.length - 1]` was synthesized by region bounding-box clipping. */
  clippedAtEnd: boolean;
  /** Unit tangent `[dx, dz]` at `points[0]` pointing inward along the edge (`fromNodeId -> points[1]`). */
  startInwardTangent: readonly [number, number];
  /** Unit tangent `[dx, dz]` at `points[N-1]` pointing inward along the edge (`toNodeId -> points[N-2]`). */
  endInwardTangent: readonly [number, number];
  /** Topological roles held by `fromNodeId`. */
  startNodeRoles: readonly RailwayNodeRole[];
  /** Topological roles held by `toNodeId`. */
  endNodeRoles: readonly RailwayNodeRole[];
  /** Turnout classification status at `fromNodeId`. */
  startTurnoutStatus: 'none' | TurnoutClassificationStatus;
  /** Turnout classification status at `toNodeId`. */
  endTurnoutStatus: 'none' | TurnoutClassificationStatus;
  /** True iff `fromNodeId` has a confirmed turnout switch (`startTurnoutStatus === 'confirmed'`). */
  hasConfirmedSwitchAtStart: boolean;
  /** True iff `toNodeId` has a confirmed turnout switch (`endTurnoutStatus === 'confirmed'`). */
  hasConfirmedSwitchAtEnd: boolean;
  /** Primary original OSM source feature ID (`provenance.segments[0].sourceFeatureId`). */
  sourceFeatureId: string;
  /** Canonically sorted list of all original OSM source feature IDs contributing to this edge. */
  sourceFeatureIds: readonly string[];
  /** Canonically sorted list of exact-duplicate feature IDs merged into this edge's segments. */
  deduplicatedFeatureIds: readonly string[];
  /** Cloned OSM tags from the primary constituent segment for `InspectableFeatureInfo` construction. */
  primaryOsmTags: RawGeoJsonProperties;
  /** Complete per-segment OSMnx-style provenance covering `[0, lengthMeters]`. */
  provenance: EdgeProvenance;
  /** Confirmed `RailwayFlatCrossingRelation.id`s crossing this railway edge, ordered by arc-length. */
  flatCrossingIds: readonly string[];
  /** Confirmed `GradeTransitionRelation.id` at the `'start'` (`fromNodeId`) endpoint, if any. */
  startGradeTransitionId?: string;
  /** Confirmed `GradeTransitionRelation.id` at the `'end'` (`toNodeId`) endpoint, if any. */
  endGradeTransitionId?: string;
  /** All confirmed `GradeTransitionRelation.id`s attached to this railway edge. */
  gradeTransitionIds: readonly string[];
  /** All confirmed `LevelCrossingRelation.id`s along this railway edge, ordered by `railwayArcLengthMeters`. */
  levelCrossingIds: readonly string[];
  /** All `GradeSeparatedCrossingRelation.id`s where this railway edge is the upper or lower way. */
  gradeSeparatedCrossingIds: readonly string[];
}

/**
 * Render-ready descriptor for a confirmed rail-over-rail flat diamond crossing (`railway=railway_crossing`, Stage E3 handoff).
 *
 * Enforces `allowsBranchInterchange: false` so E3 never confuses a flat diamond crossing
 * with a turnout switch or slip switch.
 */
export interface RailwayFlatCrossingRenderDescriptor {
  id: string;
  position: readonly [number, number];
  rawOsmNodeId?: string;
  trackAEdgeId: string;
  trackAArcLengthMeters: number;
  trackASourceFeatureIds: readonly string[];
  trackBEdgeId: string;
  trackBArcLengthMeters: number;
  trackBSourceFeatureIds: readonly string[];
  crossingAngleRad: number;
  confidence: 'explicit_railway_crossing_tag' | 'shared_osm_node_flat_crossing';
  /** Always `false`: flat diamond crossings do not permit branch switching between `trackA` and `trackB`. */
  allowsBranchInterchange: false;
  pointOsmTags?: RawGeoJsonProperties;
}

/**
 * Render-ready descriptor for a confirmed road/rail or pedestrian/rail level crossing (Stage E4 handoff).
 */
export interface LevelCrossingRenderDescriptor {
  id: string;
  crossingKind: 'road_rail_level_crossing' | 'pedestrian_rail_crossing';
  position: readonly [number, number];
  rawOsmNodeId?: string;
  roadEdgeId: string;
  roadNodeId?: string;
  roadArcLengthMeters: number;
  roadClass: RoadClass;
  roadTier: RoadTier;
  roadSourceFeatureIds: readonly string[];
  railwayEdgeId: string;
  railwayNodeId?: string;
  railwayArcLengthMeters: number;
  railwayType: RailwayType;
  railwaySourceFeatureIds: readonly string[];
  crossingAngleRad: number;
  confidence: 'explicit_osm_crossing_tag' | 'shared_explicit_osm_node';
  pointOsmTags?: RawGeoJsonProperties;
}

/**
 * Render-ready descriptor for a confirmed same-domain grade transition (`bridge_approach` or `tunnel_portal`, Stage E4 handoff).
 */
export interface GradeTransitionRenderDescriptor {
  id: string;
  network: InfrastructureNetworkKind;
  transitionType: 'bridge_approach' | 'tunnel_portal';
  position: readonly [number, number];
  rawOsmNodeId?: string;
  atGradeNodeId: string;
  atGradeEdgeId: string;
  atGradeEndpoint: 'start' | 'end';
  atGradeSourceFeatureIds: readonly string[];
  gradeSeparatedNodeId: string;
  gradeSeparatedEdgeId: string;
  gradeSeparatedEndpoint: 'start' | 'end';
  gradeSeparatedSourceFeatureIds: readonly string[];
  /** Unit tangent exiting the at-grade edge toward the portal (`-inwardTangent(atGrade)`). */
  atGradeOutwardTangent: readonly [number, number];
  /** Unit tangent entering the bridge/tunnel edge from the portal (`+inwardTangent(gradeSeparated)`). */
  gradeSeparatedInwardTangent: readonly [number, number];
  /** Unit vector pointing in the continuous traversal direction from the at-grade way into the bridge/tunnel structure. */
  atGradeToStructureDirection: readonly [number, number];
  /** Cosine of continuous traversal alignment (`dot(atGradeOutwardTangent, gradeSeparatedInwardTangent)`). */
  continuousTraversalDot: number;
  confidence: 'explicit_osm_node' | 'coordinate_fallback_confirmed';
}

/**
 * Render-ready descriptor for a confirmed grade-separated overpass/underpass crossing (Stage E4 handoff).
 */
export interface GradeSeparatedCrossingRenderDescriptor {
  id: string;
  position: readonly [number, number];
  upperNetwork: InfrastructureNetworkKind;
  upperEdgeId: string;
  upperLayer: number;
  upperIsBridge: boolean;
  upperSourceFeatureIds: readonly string[];
  lowerNetwork: InfrastructureNetworkKind;
  lowerEdgeId: string;
  lowerLayer: number;
  lowerIsTunnel: boolean;
  lowerSourceFeatureIds: readonly string[];
}

/**
 * Unresolved candidates and diagnostic records preserved strictly separate from confirmed render descriptors.
 */
export interface InfrastructureRenderUnresolvedDiagnostics {
  unresolvedCrossings: readonly UnresolvedCrossingCandidate[];
  unresolvedGradeTransitions: readonly UnresolvedGradeTransitionCandidate[];
  unresolvedInfrastructurePoints: readonly UnresolvedInfrastructurePointCandidate[];
  /** Canonical IDs of `RailwayNode`s whose turnout classification is `'unresolved_main_vs_diverging'` or `'unresolved_throat'`. */
  unresolvedRailwaySwitchNodeIds: readonly string[];
  /** Canonical IDs of `RailwayNode`s holding `'junction'` role without confirmed `'switch'` or `'railway_crossing'` classification. */
  unresolvedRailwayJunctionNodeIds: readonly string[];
  /** Cloned aggregate topology diagnostics from `InfrastructureGraph.diagnostics`. */
  topologyDiagnostics: TopologyDiagnostics;
}

/**
 * Pre-computed source-feature lineage maps derived from `EdgeProvenance` for downstream E2/E3 diagnostic accounting.
 */
export interface InfrastructureFeatureLineageSummary {
  /** Maps simplified multi-segment `edge.id` to the ordered list of constituent `sourceFeatureId`s. */
  chainingMap: Record<string, string[]>;
  /** Maps canonical `sourceFeatureId` to exact-duplicate `sourceFeatureId`s collapsed into it. */
  deduplicatedMap: Record<string, string[]>;
}

/**
 * Complete immutable bundle of render-ready domain descriptors produced from an `InfrastructureGraph`.
 */
export interface InfrastructureRenderDescriptorBundle {
  /** Normalized render source options active when this bundle was prepared. */
  options: InfrastructureRenderOptions;
  /** Canonically ordered road edge descriptors (for E2). */
  roadEdges: readonly RoadEdgeRenderDescriptor[];
  /** Canonically ordered road node descriptors (for E2). */
  roadNodes: readonly RoadNodeRenderDescriptor[];
  /** Fast lookup map from canonical `RoadEdge.id` to `RoadEdgeRenderDescriptor`. */
  roadEdgesById: ReadonlyMap<string, RoadEdgeRenderDescriptor>;
  /** Fast lookup map from canonical `RoadNode.id` to `RoadNodeRenderDescriptor`. */
  roadNodesById: ReadonlyMap<string, RoadNodeRenderDescriptor>;
  /** Canonically ordered railway edge descriptors (for E3). */
  railwayEdges: readonly RailwayEdgeRenderDescriptor[];
  /** Canonically ordered railway node descriptors (for E3). */
  railwayNodes: readonly RailwayNodeRenderDescriptor[];
  /** Fast lookup map from canonical `RailwayEdge.id` to `RailwayEdgeRenderDescriptor`. */
  railwayEdgesById: ReadonlyMap<string, RailwayEdgeRenderDescriptor>;
  /** Fast lookup map from canonical `RailwayNode.id` to `RailwayNodeRenderDescriptor`. */
  railwayNodesById: ReadonlyMap<string, RailwayNodeRenderDescriptor>;
  /** Canonically ordered confirmed flat railway diamond crossings (for E3). */
  railwayFlatCrossings: readonly RailwayFlatCrossingRenderDescriptor[];
  /** Canonically ordered confirmed road/rail and pedestrian/rail level crossings (for E4). */
  levelCrossings: readonly LevelCrossingRenderDescriptor[];
  /** Canonically ordered confirmed same-domain road and railway grade transitions (for E4). */
  gradeTransitions: readonly GradeTransitionRenderDescriptor[];
  /** Canonically ordered grade-separated overpass/underpass crossings (for E4). */
  gradeSeparatedCrossings: readonly GradeSeparatedCrossingRenderDescriptor[];
  /**
   * Maps every original OSM road `sourceFeatureId`, exact-duplicate `deduplicatedFeatureId`,
   * and unchained `partId` back to the canonically sorted `RoadEdgeRenderDescriptor.id`s containing it.
   */
  sourceFeatureToRoadEdgeIds: ReadonlyMap<string, readonly string[]>;
  /**
   * Maps every original OSM railway `sourceFeatureId`, exact-duplicate `deduplicatedFeatureId`,
   * and unchained `partId` back to the canonically sorted `RailwayEdgeRenderDescriptor.id`s containing it.
   */
  sourceFeatureToRailwayEdgeIds: ReadonlyMap<string, readonly string[]>;
  /** Pre-computed road feature lineage summary (`chainingMap` and `deduplicatedMap`). */
  roadFeatureLineage: InfrastructureFeatureLineageSummary;
  /** Pre-computed railway feature lineage summary (`chainingMap` and `deduplicatedMap`). */
  railwayFeatureLineage: InfrastructureFeatureLineageSummary;
  /** Unresolved candidates and diagnostics kept strictly separate from confirmed descriptors. */
  unresolvedDiagnostics: InfrastructureRenderUnresolvedDiagnostics;
}

/**
 * Contract validation report produced by `validateInfrastructureRenderDescriptors`.
 */
export interface InfrastructureRenderValidationReport {
  isValid: boolean;
  errors: readonly string[];
  roadEdgeCount: number;
  roadNodeCount: number;
  railwayEdgeCount: number;
  railwayNodeCount: number;
  confirmedSwitchCount: number;
  flatCrossingCount: number;
  levelCrossingCount: number;
  gradeTransitionCount: number;
  gradeSeparatedCrossingCount: number;
}

/**
 * Timing breakdown for Stage E1 preview preparation.
 */
export interface InfrastructureRenderPreviewTiming {
  graphBuildTimeMs: number;
  adapterBuildTimeMs: number;
  validationTimeMs: number;
  totalPreviewTimeMs: number;
}

/**
 * Result returned by `prepareInfrastructureRenderPreview`.
 * When both `options.roads` and `options.railways` are `'legacy'`, `graph`, `descriptors`, and `validation` are `null`.
 */
export interface InfrastructureRenderPreviewResult {
  options: InfrastructureRenderOptions;
  graph: InfrastructureGraph | null;
  descriptors: InfrastructureRenderDescriptorBundle | null;
  validation: InfrastructureRenderValidationReport | null;
  timing: InfrastructureRenderPreviewTiming;
}

/**
 * Recursively deep-clones JSON-compatible metadata (objects, arrays, primitives)
 * to ensure descriptor metadata is completely decoupled and isolated from
 * `InfrastructureGraph`, edge provenance, and source `ProcessedMapData`.
 */
export function cloneDescriptorOsmTags(
  tags?: RawGeoJsonProperties
): RawGeoJsonProperties {
  if (!tags) return {};
  return deepCloneDescriptorMetadata(tags);
}

function deepCloneDescriptorMetadata<T>(val: T): T {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => deepCloneDescriptorMetadata(item)) as unknown as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    copy[k] = deepCloneDescriptorMetadata(v);
  }
  return copy as T;
}

function clonePoint2D(pt: readonly [number, number]): [number, number] {
  return [pt[0], pt[1]];
}

function clonePolyline2D(pts: readonly [number, number][]): [number, number][] {
  return pts.map((pt) => [pt[0], pt[1]]);
}

function cloneIncidentHalfEdge(he: IncidentHalfEdge): IncidentHalfEdge {
  return {
    edgeId: he.edgeId,
    endpoint: he.endpoint,
    inwardTangent: [he.inwardTangent[0], he.inwardTangent[1]],
  };
}

function cloneSegmentProvenance(seg: EdgeSegmentProvenance): EdgeSegmentProvenance {
  return {
    partId: seg.partId,
    sourceFeatureId: seg.sourceFeatureId,
    deduplicatedFeatureIds: [...seg.deduplicatedFeatureIds],
    startArcLength: seg.startArcLength,
    endArcLength: seg.endArcLength,
    startVertexIndex: seg.startVertexIndex,
    endVertexIndex: seg.endVertexIndex,
    sourceStartVertexIndex: seg.sourceStartVertexIndex,
    sourceEndVertexIndex: seg.sourceEndVertexIndex,
    reversedRelativeToSource: seg.reversedRelativeToSource,
    osmTags: cloneDescriptorOsmTags(seg.osmTags),
  };
}

function cloneEdgeProvenance(prov: EdgeProvenance): EdgeProvenance {
  return {
    primaryPartId: prov.primaryPartId,
    mergedPartIds: [...prov.mergedPartIds],
    sourceFeatureIds: [...prov.sourceFeatureIds],
    segments: prov.segments.map(cloneSegmentProvenance),
  };
}

function cloneTurnoutTopology(spec?: TurnoutTopologySpec): TurnoutTopologySpec | undefined {
  if (!spec) return undefined;
  return {
    status: spec.status,
    trunkEdgeId: spec.trunkEdgeId,
    mainBranchEdgeId: spec.mainBranchEdgeId,
    divergingBranchEdgeId: spec.divergingBranchEdgeId,
    turnoutSide: spec.turnoutSide,
    divergenceAngleRad: spec.divergenceAngleRad,
    candidateEdgeIds: [...spec.candidateEdgeIds],
  };
}

function cloneUnresolvedCrossing(c: UnresolvedCrossingCandidate): UnresolvedCrossingCandidate {
  return {
    kind: c.kind,
    position: [c.position[0], c.position[1]],
    edgeAId: c.edgeAId,
    edgeBId: c.edgeBId,
    reason: c.reason,
  };
}

function cloneUnresolvedGradeTransition(
  c: UnresolvedGradeTransitionCandidate
): UnresolvedGradeTransitionCandidate {
  return {
    network: c.network,
    position: [c.position[0], c.position[1]],
    gradeSeparatedEdgeId: c.gradeSeparatedEdgeId,
    gradeSeparatedEndpoint: c.gradeSeparatedEndpoint,
    candidateAtGradeEdgeIds: [...c.candidateAtGradeEdgeIds],
    distanceMeters: c.distanceMeters,
    continuousTraversalDot: c.continuousTraversalDot,
    reason: c.reason,
  };
}

function cloneUnresolvedInfrastructurePoint(
  p: UnresolvedInfrastructurePointCandidate
): UnresolvedInfrastructurePointCandidate {
  return {
    pointId: p.pointId,
    rawOsmNodeId: p.rawOsmNodeId,
    kind: p.kind,
    position: [p.position[0], p.position[1]],
    candidateNodeIds: [...p.candidateNodeIds],
    reason: p.reason,
    osmTags: cloneDescriptorOsmTags(p.osmTags),
  };
}

function collectDeduplicatedFeatureIds(prov: EdgeProvenance): string[] {
  const set = new Set<string>();
  for (const seg of prov.segments) {
    for (const dupId of seg.deduplicatedFeatureIds) {
      if (dupId) set.add(dupId);
    }
  }
  return [...set].sort(compareStringsCodeUnit);
}

function collectAllSourceFeatureIds(prov: EdgeProvenance, fallbackId: string): string[] {
  const set = new Set<string>();
  for (const sid of prov.sourceFeatureIds) {
    if (sid) set.add(sid);
  }
  for (const seg of prov.segments) {
    if (seg.sourceFeatureId) set.add(seg.sourceFeatureId);
    for (const dupId of seg.deduplicatedFeatureIds) {
      if (dupId) set.add(dupId);
    }
  }
  if (set.size === 0 && fallbackId) {
    set.add(fallbackId);
  }
  return [...set].sort(compareStringsCodeUnit);
}

function buildFeatureLineageAndEdgeLookup<
  TEdge extends { id: string; provenance: EdgeProvenance },
>(
  edges: readonly TEdge[],
  graphFeatureToEdgeIds: ReadonlyMap<string, readonly string[]>
): {
  sourceFeatureToEdgeIds: ReadonlyMap<string, readonly string[]>;
  lineage: InfrastructureFeatureLineageSummary;
} {
  const index = new Map<string, Set<string>>();
  const chainingMap: Record<string, string[]> = {};
  const deduplicatedSetMap = new Map<string, Set<string>>();

  const addMapping = (key: string | undefined, edgeId: string) => {
    if (!key) return;
    let bucket = index.get(key);
    if (!bucket) {
      bucket = new Set<string>();
      index.set(key, bucket);
    }
    bucket.add(edgeId);
  };

  for (const [featureKey, edgeIds] of graphFeatureToEdgeIds.entries()) {
    for (const edgeId of edgeIds) {
      addMapping(featureKey, edgeId);
    }
  }

  for (const edge of edges) {
    const prov = edge.provenance;
    addMapping(prov.primaryPartId, edge.id);
    for (const partId of prov.mergedPartIds) {
      addMapping(partId, edge.id);
    }
    for (const sid of prov.sourceFeatureIds) {
      addMapping(sid, edge.id);
    }

    if (prov.segments.length > 1) {
      const orderedConstituentIds: string[] = [];
      for (const seg of prov.segments) {
        if (
          orderedConstituentIds.length === 0 ||
          orderedConstituentIds[orderedConstituentIds.length - 1] !== seg.sourceFeatureId
        ) {
          orderedConstituentIds.push(seg.sourceFeatureId);
        }
      }
      chainingMap[edge.id] = orderedConstituentIds;
    }

    for (const seg of prov.segments) {
      addMapping(seg.partId, edge.id);
      addMapping(seg.sourceFeatureId, edge.id);
      for (const dupId of seg.deduplicatedFeatureIds) {
        addMapping(dupId, edge.id);
        let dupSet = deduplicatedSetMap.get(seg.sourceFeatureId);
        if (!dupSet) {
          dupSet = new Set<string>();
          deduplicatedSetMap.set(seg.sourceFeatureId, dupSet);
        }
        dupSet.add(dupId);
      }
    }
  }

  const sortedLookup = new Map<string, readonly string[]>();
  const sortedKeys = [...index.keys()].sort(compareStringsCodeUnit);
  for (const k of sortedKeys) {
    const edgeIds = [...index.get(k)!].sort(compareStringsCodeUnit);
    sortedLookup.set(k, edgeIds);
  }

  const deduplicatedMap: Record<string, string[]> = {};
  const sortedCanonicalIds = [...deduplicatedSetMap.keys()].sort(compareStringsCodeUnit);
  for (const cid of sortedCanonicalIds) {
    deduplicatedMap[cid] = [...deduplicatedSetMap.get(cid)!].sort(compareStringsCodeUnit);
  }

  return {
    sourceFeatureToEdgeIds: sortedLookup,
    lineage: {
      chainingMap,
      deduplicatedMap,
    },
  };
}

/**
 * Pure, deterministic Graph-to-Renderer Adapter (`ADR-0009`, Milestone 2.3 Stage E1).
 *
 * Converts an `InfrastructureGraph` into render-ready road, railway, and cross-domain
 * descriptors without Three.js, React, or WebGL dependencies and without mutating inputs.
 */
export function buildInfrastructureRenderDescriptors(
  graph: InfrastructureGraph,
  options?: Partial<InfrastructureRenderOptions> | null
): InfrastructureRenderDescriptorBundle {
  const normalizedOptions = normalizeInfrastructureRenderOptions(options);

  // Pre-index relations by node and edge IDs for O(1) attachment
  const roadNodeGradeTransitions = new Map<string, string[]>();
  const roadNodeLevelCrossings = new Map<string, string[]>();
  const roadEdgeStartGradeTransition = new Map<string, string>();
  const roadEdgeEndGradeTransition = new Map<string, string>();
  const roadEdgeGradeTransitions = new Map<string, string[]>();
  const roadEdgeLevelCrossings = new Map<string, Array<{ id: string; arc: number }>>();
  const roadEdgeGradeSeparated = new Map<string, string[]>();

  const railNodeGradeTransitions = new Map<string, string[]>();
  const railNodeLevelCrossings = new Map<string, string[]>();
  const railNodeFlatCrossings = new Map<string, string[]>();
  const railEdgeStartGradeTransition = new Map<string, string>();
  const railEdgeEndGradeTransition = new Map<string, string>();
  const railEdgeGradeTransitions = new Map<string, string[]>();
  const railEdgeLevelCrossings = new Map<string, Array<{ id: string; arc: number }>>();
  const railEdgeFlatCrossings = new Map<string, Array<{ id: string; arc: number }>>();
  const railEdgeGradeSeparated = new Map<string, string[]>();

  const pushToMapList = <K, V>(map: Map<K, V[]>, key: K | undefined, val: V) => {
    if (key === undefined) return;
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push(val);
  };

  const sortedGradeTransitions = [...graph.gradeTransitions].sort((a, b) =>
    compareStringsCodeUnit(a.id, b.id)
  );
  for (const gt of sortedGradeTransitions) {
    if (gt.network === 'road') {
      pushToMapList(roadNodeGradeTransitions, gt.atGradeNodeId, gt.id);
      pushToMapList(roadNodeGradeTransitions, gt.gradeSeparatedNodeId, gt.id);
      pushToMapList(roadEdgeGradeTransitions, gt.atGradeEdgeId, gt.id);
      pushToMapList(roadEdgeGradeTransitions, gt.gradeSeparatedEdgeId, gt.id);
      if (gt.atGradeEndpoint === 'start') {
        roadEdgeStartGradeTransition.set(gt.atGradeEdgeId, gt.id);
      } else {
        roadEdgeEndGradeTransition.set(gt.atGradeEdgeId, gt.id);
      }
      if (gt.gradeSeparatedEndpoint === 'start') {
        roadEdgeStartGradeTransition.set(gt.gradeSeparatedEdgeId, gt.id);
      } else {
        roadEdgeEndGradeTransition.set(gt.gradeSeparatedEdgeId, gt.id);
      }
    } else {
      pushToMapList(railNodeGradeTransitions, gt.atGradeNodeId, gt.id);
      pushToMapList(railNodeGradeTransitions, gt.gradeSeparatedNodeId, gt.id);
      pushToMapList(railEdgeGradeTransitions, gt.atGradeEdgeId, gt.id);
      pushToMapList(railEdgeGradeTransitions, gt.gradeSeparatedEdgeId, gt.id);
      if (gt.atGradeEndpoint === 'start') {
        railEdgeStartGradeTransition.set(gt.atGradeEdgeId, gt.id);
      } else {
        railEdgeEndGradeTransition.set(gt.atGradeEdgeId, gt.id);
      }
      if (gt.gradeSeparatedEndpoint === 'start') {
        railEdgeStartGradeTransition.set(gt.gradeSeparatedEdgeId, gt.id);
      } else {
        railEdgeEndGradeTransition.set(gt.gradeSeparatedEdgeId, gt.id);
      }
    }
  }

  const sortedLevelCrossings = [...graph.levelCrossings].sort((a, b) =>
    compareStringsCodeUnit(a.id, b.id)
  );
  for (const lc of sortedLevelCrossings) {
    pushToMapList(roadNodeLevelCrossings, lc.roadNodeId, lc.id);
    pushToMapList(railNodeLevelCrossings, lc.railwayNodeId, lc.id);
    pushToMapList(roadEdgeLevelCrossings, lc.roadEdgeId, {
      id: lc.id,
      arc: lc.roadArcLengthMeters,
    });
    pushToMapList(railEdgeLevelCrossings, lc.railwayEdgeId, {
      id: lc.id,
      arc: lc.railwayArcLengthMeters,
    });
  }

  const sortedFlatCrossings = [...graph.railwayFlatCrossings].sort((a, b) =>
    compareStringsCodeUnit(a.id, b.id)
  );
  for (const fc of sortedFlatCrossings) {
    pushToMapList(railEdgeFlatCrossings, fc.trackAEdgeId, {
      id: fc.id,
      arc: fc.trackAArcLengthMeters,
    });
    pushToMapList(railEdgeFlatCrossings, fc.trackBEdgeId, {
      id: fc.id,
      arc: fc.trackBArcLengthMeters,
    });
    if (fc.rawOsmNodeId) {
      for (const rNode of graph.railways.nodes.values()) {
        if (rNode.rawOsmNodeId === fc.rawOsmNodeId && rNode.roles.includes('railway_crossing')) {
          pushToMapList(railNodeFlatCrossings, rNode.id, fc.id);
        }
      }
    }
  }

  const sortedGradeSeparated = [...graph.gradeSeparatedCrossings].sort((a, b) =>
    compareStringsCodeUnit(a.id, b.id)
  );
  for (const gsc of sortedGradeSeparated) {
    if (gsc.upperNetwork === 'road') {
      pushToMapList(roadEdgeGradeSeparated, gsc.upperEdgeId, gsc.id);
    } else {
      pushToMapList(railEdgeGradeSeparated, gsc.upperEdgeId, gsc.id);
    }
    if (gsc.lowerNetwork === 'road') {
      pushToMapList(roadEdgeGradeSeparated, gsc.lowerEdgeId, gsc.id);
    } else {
      pushToMapList(railEdgeGradeSeparated, gsc.lowerEdgeId, gsc.id);
    }
  }

  // 1. Build Road Node Descriptors
  const sortedRawRoadNodes = [...graph.roads.nodes.values()].sort((a, b) =>
    compareStringsCodeUnit(a.id, b.id)
  );
  const roadNodes: RoadNodeRenderDescriptor[] = [];
  const roadNodesById = new Map<string, RoadNodeRenderDescriptor>();

  for (const node of sortedRawRoadNodes) {
    const vehicularIncidentHalfEdges: IncidentHalfEdge[] = [];
    const pathIncidentHalfEdges: IncidentHalfEdge[] = [];

    for (const he of node.incidentHalfEdges) {
      const clonedHe = cloneIncidentHalfEdge(he);
      const edge = graph.roads.edges.get(he.edgeId);
      if (edge?.tier === 'path') {
        pathIncidentHalfEdges.push(clonedHe);
      } else {
        vehicularIncidentHalfEdges.push(clonedHe);
      }
    }

    const vehicularHalfEdgeCount = vehicularIncidentHalfEdges.length;
    const pathHalfEdgeCount = pathIncidentHalfEdges.length;
    const isAtGradeScope = node.layer === 0 && !node.isBridge && !node.isTunnel;
    const isCrossTierOnlyInteraction = node.isCrossTier && vehicularHalfEdgeCount <= 2;
    const requiresVehicularJunctionTrimming =
      isAtGradeScope && !isCrossTierOnlyInteraction && vehicularHalfEdgeCount >= 3;
    const requiresVehicularContinuityMiter = isAtGradeScope && vehicularHalfEdgeCount === 2;
    const requiresPathJunctionTrimming =
      isAtGradeScope && vehicularHalfEdgeCount === 0 && pathHalfEdgeCount >= 2;

    const desc: RoadNodeRenderDescriptor = {
      id: node.id,
      rawOsmNodeId: node.rawOsmNodeId,
      nodeIdOrigin: node.nodeIdOrigin,
      position: [node.x, node.z],
      layer: node.layer,
      isBridge: node.isBridge,
      isTunnel: node.isTunnel,
      isBoundaryClipped: node.isBoundaryClipped,
      degree: node.degree,
      primaryRole: node.primaryRole,
      roles: [...node.roles],
      isCrossTier: node.isCrossTier,
      vehicularHalfEdgeCount,
      pathHalfEdgeCount,
      vehicularIncidentHalfEdges,
      pathIncidentHalfEdges,
      isCrossTierOnlyInteraction,
      requiresVehicularJunctionTrimming,
      requiresVehicularContinuityMiter,
      requiresPathJunctionTrimming,
      incidentEdgeIds: [...node.incidentEdgeIds],
      incidentHalfEdges: node.incidentHalfEdges.map(cloneIncidentHalfEdge),
      pointOsmTags: node.pointOsmTags ? cloneDescriptorOsmTags(node.pointOsmTags) : undefined,
      gradeTransitionIds: [...new Set(roadNodeGradeTransitions.get(node.id) ?? [])].sort(
        compareStringsCodeUnit
      ),
      levelCrossingIds: [...new Set(roadNodeLevelCrossings.get(node.id) ?? [])].sort(
        compareStringsCodeUnit
      ),
    };
    roadNodes.push(desc);
    roadNodesById.set(desc.id, desc);
  }

  // 2. Build Road Edge Descriptors
  const sortedRawRoadEdges = [...graph.roads.edges.values()].sort((a, b) =>
    compareStringsCodeUnit(a.id, b.id)
  );
  const roadEdges: RoadEdgeRenderDescriptor[] = [];
  const roadEdgesById = new Map<string, RoadEdgeRenderDescriptor>();

  for (const edge of sortedRawRoadEdges) {
    const startNode = graph.roads.nodes.get(edge.fromNodeId);
    const endNode = graph.roads.nodes.get(edge.toNodeId);
    const clonedProv = cloneEdgeProvenance(edge.provenance);
    const primarySeg = clonedProv.segments[0];
    const sourceFeatureId =
      primarySeg?.sourceFeatureId ?? clonedProv.sourceFeatureIds[0] ?? edge.id;
    const sourceFeatureIds = collectAllSourceFeatureIds(clonedProv, sourceFeatureId);
    const deduplicatedFeatureIds = collectDeduplicatedFeatureIds(clonedProv);
    const primaryOsmTags = primarySeg ? cloneDescriptorOsmTags(primarySeg.osmTags) : {};

    const orderedLcIds = [...(roadEdgeLevelCrossings.get(edge.id) ?? [])]
      .sort((a, b) => a.arc - b.arc || compareStringsCodeUnit(a.id, b.id))
      .map((item) => item.id);

    const desc: RoadEdgeRenderDescriptor = {
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      parallelIndex: edge.parallelIndex,
      points: clonePolyline2D(edge.points),
      vertexRawOsmNodeIds: [...edge.vertexRawOsmNodeIds],
      lengthMeters: edge.lengthMeters,
      roadClass: edge.roadClass,
      tier: edge.tier,
      width: edge.width,
      lanes: edge.lanes,
      normalizedOneway: edge.normalizedOneway,
      rawOnewayTag: edge.rawOnewayTag,
      surface: edge.surface,
      name: edge.name,
      layer: edge.layer,
      isBridge: edge.isBridge,
      isTunnel: edge.isTunnel,
      isCulvert: edge.isCulvert,
      isAtGradeBuildable: (edge.layer === 0 && !edge.isBridge && !edge.isTunnel) || edge.isCulvert,
      isClosedLoop: edge.isClosedLoop,
      clippedAtStart: edge.clippedAtStart,
      clippedAtEnd: edge.clippedAtEnd,
      startInwardTangent: [edge.startInwardTangent[0], edge.startInwardTangent[1]],
      endInwardTangent: [edge.endInwardTangent[0], edge.endInwardTangent[1]],
      startNodeRoles: startNode ? [...startNode.roles] : [],
      endNodeRoles: endNode ? [...endNode.roles] : [],
      startNodeIsCrossTier: Boolean(startNode?.isCrossTier),
      endNodeIsCrossTier: Boolean(endNode?.isCrossTier),
      sourceFeatureId,
      sourceFeatureIds,
      deduplicatedFeatureIds,
      primaryOsmTags,
      provenance: clonedProv,
      startGradeTransitionId: roadEdgeStartGradeTransition.get(edge.id),
      endGradeTransitionId: roadEdgeEndGradeTransition.get(edge.id),
      gradeTransitionIds: [...new Set(roadEdgeGradeTransitions.get(edge.id) ?? [])].sort(
        compareStringsCodeUnit
      ),
      levelCrossingIds: [...new Set(orderedLcIds)],
      gradeSeparatedCrossingIds: [...new Set(roadEdgeGradeSeparated.get(edge.id) ?? [])].sort(
        compareStringsCodeUnit
      ),
    };
    roadEdges.push(desc);
    roadEdgesById.set(desc.id, desc);
  }

  // 3. Build Railway Node Descriptors
  const sortedRawRailwayNodes = [...graph.railways.nodes.values()].sort((a, b) =>
    compareStringsCodeUnit(a.id, b.id)
  );
  const railwayNodes: RailwayNodeRenderDescriptor[] = [];
  const railwayNodesById = new Map<string, RailwayNodeRenderDescriptor>();
  const unresolvedRailwaySwitchNodeIds: string[] = [];
  const unresolvedRailwayJunctionNodeIds: string[] = [];

  for (const node of sortedRawRailwayNodes) {
    const clonedTurnout = cloneTurnoutTopology(node.turnoutTopology);
    const turnoutStatus: 'none' | TurnoutClassificationStatus = clonedTurnout
      ? clonedTurnout.status
      : 'none';
    const isConfirmedSwitch = turnoutStatus === 'confirmed';
    const isUnresolvedSwitch =
      turnoutStatus === 'unresolved_main_vs_diverging' || turnoutStatus === 'unresolved_throat';

    if (isUnresolvedSwitch) {
      unresolvedRailwaySwitchNodeIds.push(node.id);
    }
    if (
      node.roles.includes('junction') &&
      !node.roles.includes('switch') &&
      !node.roles.includes('railway_crossing')
    ) {
      unresolvedRailwayJunctionNodeIds.push(node.id);
    }

    const desc: RailwayNodeRenderDescriptor = {
      id: node.id,
      rawOsmNodeId: node.rawOsmNodeId,
      nodeIdOrigin: node.nodeIdOrigin,
      position: [node.x, node.z],
      layer: node.layer,
      isBridge: node.isBridge,
      isTunnel: node.isTunnel,
      isBoundaryClipped: node.isBoundaryClipped,
      degree: node.degree,
      primaryRole: node.primaryRole,
      roles: [...node.roles],
      incidentEdgeIds: [...node.incidentEdgeIds],
      incidentHalfEdges: node.incidentHalfEdges.map(cloneIncidentHalfEdge),
      turnoutStatus,
      isConfirmedSwitch,
      isUnresolvedSwitch,
      turnoutTopology: clonedTurnout,
      pointOsmTags: node.pointOsmTags ? cloneDescriptorOsmTags(node.pointOsmTags) : undefined,
      flatCrossingIds: [...new Set(railNodeFlatCrossings.get(node.id) ?? [])].sort(
        compareStringsCodeUnit
      ),
      gradeTransitionIds: [...new Set(railNodeGradeTransitions.get(node.id) ?? [])].sort(
        compareStringsCodeUnit
      ),
      levelCrossingIds: [...new Set(railNodeLevelCrossings.get(node.id) ?? [])].sort(
        compareStringsCodeUnit
      ),
    };
    railwayNodes.push(desc);
    railwayNodesById.set(desc.id, desc);
  }

  // 4. Build Railway Edge Descriptors
  const sortedRawRailwayEdges = [...graph.railways.edges.values()].sort((a, b) =>
    compareStringsCodeUnit(a.id, b.id)
  );
  const railwayEdges: RailwayEdgeRenderDescriptor[] = [];
  const railwayEdgesById = new Map<string, RailwayEdgeRenderDescriptor>();

  for (const edge of sortedRawRailwayEdges) {
    const startNode = railwayNodesById.get(edge.fromNodeId);
    const endNode = railwayNodesById.get(edge.toNodeId);
    const clonedProv = cloneEdgeProvenance(edge.provenance);
    const primarySeg = clonedProv.segments[0];
    const sourceFeatureId =
      primarySeg?.sourceFeatureId ?? clonedProv.sourceFeatureIds[0] ?? edge.id;
    const sourceFeatureIds = collectAllSourceFeatureIds(clonedProv, sourceFeatureId);
    const deduplicatedFeatureIds = collectDeduplicatedFeatureIds(clonedProv);
    const primaryOsmTags = primarySeg ? cloneDescriptorOsmTags(primarySeg.osmTags) : {};

    const orderedFcIds = [...(railEdgeFlatCrossings.get(edge.id) ?? [])]
      .sort((a, b) => a.arc - b.arc || compareStringsCodeUnit(a.id, b.id))
      .map((item) => item.id);
    const orderedLcIds = [...(railEdgeLevelCrossings.get(edge.id) ?? [])]
      .sort((a, b) => a.arc - b.arc || compareStringsCodeUnit(a.id, b.id))
      .map((item) => item.id);

    const startTurnoutStatus = startNode?.turnoutStatus ?? 'none';
    const endTurnoutStatus = endNode?.turnoutStatus ?? 'none';

    const desc: RailwayEdgeRenderDescriptor = {
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      parallelIndex: edge.parallelIndex,
      points: clonePolyline2D(edge.points),
      vertexRawOsmNodeIds: [...edge.vertexRawOsmNodeIds],
      lengthMeters: edge.lengthMeters,
      railwayType: edge.railwayType,
      width: edge.width,
      gauge: edge.gauge,
      electrified: edge.electrified,
      service: edge.service,
      usage: edge.usage,
      name: edge.name,
      isSecondaryBranch: edge.isSecondaryBranch,
      layer: edge.layer,
      isBridge: edge.isBridge,
      isTunnel: edge.isTunnel,
      isClosedLoop: edge.isClosedLoop,
      clippedAtStart: edge.clippedAtStart,
      clippedAtEnd: edge.clippedAtEnd,
      startInwardTangent: [edge.startInwardTangent[0], edge.startInwardTangent[1]],
      endInwardTangent: [edge.endInwardTangent[0], edge.endInwardTangent[1]],
      startNodeRoles: startNode ? [...startNode.roles] : [],
      endNodeRoles: endNode ? [...endNode.roles] : [],
      startTurnoutStatus,
      endTurnoutStatus,
      hasConfirmedSwitchAtStart: startTurnoutStatus === 'confirmed',
      hasConfirmedSwitchAtEnd: endTurnoutStatus === 'confirmed',
      sourceFeatureId,
      sourceFeatureIds,
      deduplicatedFeatureIds,
      primaryOsmTags,
      provenance: clonedProv,
      flatCrossingIds: [...new Set(orderedFcIds)],
      startGradeTransitionId: railEdgeStartGradeTransition.get(edge.id),
      endGradeTransitionId: railEdgeEndGradeTransition.get(edge.id),
      gradeTransitionIds: [...new Set(railEdgeGradeTransitions.get(edge.id) ?? [])].sort(
        compareStringsCodeUnit
      ),
      levelCrossingIds: [...new Set(orderedLcIds)],
      gradeSeparatedCrossingIds: [...new Set(railEdgeGradeSeparated.get(edge.id) ?? [])].sort(
        compareStringsCodeUnit
      ),
    };
    railwayEdges.push(desc);
    railwayEdgesById.set(desc.id, desc);
  }

  // 5. Build Railway Flat-Crossing Descriptors
  const railwayFlatCrossings: RailwayFlatCrossingRenderDescriptor[] = sortedFlatCrossings.map(
    (fc) => {
      const trackA = railwayEdgesById.get(fc.trackAEdgeId);
      const trackB = railwayEdgesById.get(fc.trackBEdgeId);
      return {
        id: fc.id,
        position: clonePoint2D(fc.position),
        rawOsmNodeId: fc.rawOsmNodeId,
        trackAEdgeId: fc.trackAEdgeId,
        trackAArcLengthMeters: fc.trackAArcLengthMeters,
        trackASourceFeatureIds: trackA ? [...trackA.sourceFeatureIds] : [],
        trackBEdgeId: fc.trackBEdgeId,
        trackBArcLengthMeters: fc.trackBArcLengthMeters,
        trackBSourceFeatureIds: trackB ? [...trackB.sourceFeatureIds] : [],
        crossingAngleRad: fc.crossingAngleRad,
        confidence: fc.confidence,
        allowsBranchInterchange: false,
        pointOsmTags: fc.pointOsmTags ? cloneDescriptorOsmTags(fc.pointOsmTags) : undefined,
      };
    }
  );

  // 6. Build Cross-Domain Level-Crossing Descriptors
  const levelCrossings: LevelCrossingRenderDescriptor[] = sortedLevelCrossings.map((lc) => {
    const roadEdge = roadEdgesById.get(lc.roadEdgeId);
    const railEdge = railwayEdgesById.get(lc.railwayEdgeId);
    return {
      id: lc.id,
      crossingKind: lc.crossingKind,
      position: clonePoint2D(lc.position),
      rawOsmNodeId: lc.rawOsmNodeId,
      roadEdgeId: lc.roadEdgeId,
      roadNodeId: lc.roadNodeId,
      roadArcLengthMeters: lc.roadArcLengthMeters,
      roadClass: roadEdge?.roadClass ?? 'unclassified',
      roadTier: roadEdge?.tier ?? 'vehicular',
      roadSourceFeatureIds: roadEdge ? [...roadEdge.sourceFeatureIds] : [],
      railwayEdgeId: lc.railwayEdgeId,
      railwayNodeId: lc.railwayNodeId,
      railwayArcLengthMeters: lc.railwayArcLengthMeters,
      railwayType: railEdge?.railwayType ?? 'rail',
      railwaySourceFeatureIds: railEdge ? [...railEdge.sourceFeatureIds] : [],
      crossingAngleRad: lc.crossingAngleRad,
      confidence: lc.confidence,
      pointOsmTags: lc.pointOsmTags ? cloneDescriptorOsmTags(lc.pointOsmTags) : undefined,
    };
  });

  // 7. Build Grade-Transition Descriptors
  const gradeTransitions: GradeTransitionRenderDescriptor[] = sortedGradeTransitions.map((gt) => {
    const atGradeEdge =
      gt.network === 'road'
        ? roadEdgesById.get(gt.atGradeEdgeId)
        : railwayEdgesById.get(gt.atGradeEdgeId);
    const gsEdge =
      gt.network === 'road'
        ? roadEdgesById.get(gt.gradeSeparatedEdgeId)
        : railwayEdgesById.get(gt.gradeSeparatedEdgeId);

    const agInward =
      atGradeEdge !== undefined
        ? gt.atGradeEndpoint === 'start'
          ? atGradeEdge.startInwardTangent
          : atGradeEdge.endInwardTangent
        : ([1, 0] as const);
    const atGradeOutwardTangent: [number, number] = [-agInward[0], -agInward[1]];

    const gsInward =
      gsEdge !== undefined
        ? gt.gradeSeparatedEndpoint === 'start'
          ? gsEdge.startInwardTangent
          : gsEdge.endInwardTangent
        : atGradeOutwardTangent;
    const gradeSeparatedInwardTangent: [number, number] = [gsInward[0], gsInward[1]];

    const sumX = atGradeOutwardTangent[0] + gradeSeparatedInwardTangent[0];
    const sumZ = atGradeOutwardTangent[1] + gradeSeparatedInwardTangent[1];
    const sumLen = Math.hypot(sumX, sumZ);
    const atGradeToStructureDirection: [number, number] =
      sumLen > 1e-6
        ? [sumX / sumLen, sumZ / sumLen]
        : [gradeSeparatedInwardTangent[0], gradeSeparatedInwardTangent[1]];

    return {
      id: gt.id,
      network: gt.network,
      transitionType: gt.transitionType,
      position: clonePoint2D(gt.position),
      rawOsmNodeId: gt.rawOsmNodeId,
      atGradeNodeId: gt.atGradeNodeId,
      atGradeEdgeId: gt.atGradeEdgeId,
      atGradeEndpoint: gt.atGradeEndpoint,
      atGradeSourceFeatureIds: atGradeEdge ? [...atGradeEdge.sourceFeatureIds] : [],
      gradeSeparatedNodeId: gt.gradeSeparatedNodeId,
      gradeSeparatedEdgeId: gt.gradeSeparatedEdgeId,
      gradeSeparatedEndpoint: gt.gradeSeparatedEndpoint,
      gradeSeparatedSourceFeatureIds: gsEdge ? [...gsEdge.sourceFeatureIds] : [],
      atGradeOutwardTangent,
      gradeSeparatedInwardTangent,
      atGradeToStructureDirection,
      continuousTraversalDot: gt.continuousTraversalDot,
      confidence: gt.confidence,
    };
  });

  // 8. Build Grade-Separated Crossing Descriptors
  const gradeSeparatedCrossings: GradeSeparatedCrossingRenderDescriptor[] =
    sortedGradeSeparated.map((gsc) => {
      const upperEdge =
        gsc.upperNetwork === 'road'
          ? roadEdgesById.get(gsc.upperEdgeId)
          : railwayEdgesById.get(gsc.upperEdgeId);
      const lowerEdge =
        gsc.lowerNetwork === 'road'
          ? roadEdgesById.get(gsc.lowerEdgeId)
          : railwayEdgesById.get(gsc.lowerEdgeId);

      return {
        id: gsc.id,
        position: clonePoint2D(gsc.position),
        upperNetwork: gsc.upperNetwork,
        upperEdgeId: gsc.upperEdgeId,
        upperLayer: gsc.upperLayer,
        upperIsBridge: gsc.upperIsBridge,
        upperSourceFeatureIds: upperEdge ? [...upperEdge.sourceFeatureIds] : [],
        lowerNetwork: gsc.lowerNetwork,
        lowerEdgeId: gsc.lowerEdgeId,
        lowerLayer: gsc.lowerLayer,
        lowerIsTunnel: gsc.lowerIsTunnel,
        lowerSourceFeatureIds: lowerEdge ? [...lowerEdge.sourceFeatureIds] : [],
      };
    });

  // 9. Build Source-Feature Lineage & Lookup Maps
  const roadLineageResult = buildFeatureLineageAndEdgeLookup(
    roadEdges,
    graph.roads.featureToEdgeIds
  );
  const railwayLineageResult = buildFeatureLineageAndEdgeLookup(
    railwayEdges,
    graph.railways.featureToEdgeIds
  );

  // 10. Clone Unresolved Diagnostics (strictly isolated from confirmed descriptors)
  const unresolvedCrossings = graph.diagnostics.unresolvedCrossings.map(cloneUnresolvedCrossing);
  const unresolvedGradeTransitions = graph.diagnostics.unresolvedGradeTransitions.map(
    cloneUnresolvedGradeTransition
  );
  const unresolvedInfrastructurePoints = (
    graph.diagnostics.unresolvedInfrastructurePoints ?? []
  ).map(cloneUnresolvedInfrastructurePoint);

  const unresolvedDiagnostics: InfrastructureRenderUnresolvedDiagnostics = {
    unresolvedCrossings,
    unresolvedGradeTransitions,
    unresolvedInfrastructurePoints,
    unresolvedRailwaySwitchNodeIds,
    unresolvedRailwayJunctionNodeIds,
    topologyDiagnostics: {
      ...graph.diagnostics,
      unresolvedCrossings,
      unresolvedGradeTransitions,
      unresolvedInfrastructurePoints,
    },
  };

  return {
    options: normalizedOptions,
    roadEdges,
    roadNodes,
    roadEdgesById,
    roadNodesById,
    railwayEdges,
    railwayNodes,
    railwayEdgesById,
    railwayNodesById,
    railwayFlatCrossings,
    levelCrossings,
    gradeTransitions,
    gradeSeparatedCrossings,
    sourceFeatureToRoadEdgeIds: roadLineageResult.sourceFeatureToEdgeIds,
    sourceFeatureToRailwayEdgeIds: railwayLineageResult.sourceFeatureToEdgeIds,
    roadFeatureLineage: roadLineageResult.lineage,
    railwayFeatureLineage: railwayLineageResult.lineage,
    unresolvedDiagnostics,
  };
}

/**
 * Alias for `buildInfrastructureRenderDescriptors`.
 */
export const adaptInfrastructureGraphToRenderDescriptors = buildInfrastructureRenderDescriptors;

/**
 * Validates structural and semantic invariants of an `InfrastructureRenderDescriptorBundle`.
 */
export function validateInfrastructureRenderDescriptors(
  bundle: InfrastructureRenderDescriptorBundle,
  graph?: InfrastructureGraph
): InfrastructureRenderValidationReport {
  const errors: string[] = [];

  for (const edge of bundle.roadEdges) {
    if (!bundle.roadNodesById.has(edge.fromNodeId)) {
      errors.push(`RoadEdge ${edge.id} missing fromNodeId ${edge.fromNodeId}`);
    }
    if (!bundle.roadNodesById.has(edge.toNodeId)) {
      errors.push(`RoadEdge ${edge.id} missing toNodeId ${edge.toNodeId}`);
    }
    if (edge.provenance.segments.length === 0) {
      errors.push(`RoadEdge ${edge.id} has empty provenance segments`);
    }
    for (const sid of edge.sourceFeatureIds) {
      const mapped = bundle.sourceFeatureToRoadEdgeIds.get(sid);
      if (!mapped || !mapped.includes(edge.id)) {
        errors.push(`RoadEdge ${edge.id} sourceFeatureId ${sid} missing from lookup map`);
      }
    }
  }

  for (const node of bundle.roadNodes) {
    if (node.isCrossTierOnlyInteraction && node.requiresVehicularJunctionTrimming) {
      errors.push(
        `RoadNode ${node.id} cannot require vehicular junction trimming when isCrossTierOnlyInteraction is true`
      );
    }
    if (node.vehicularHalfEdgeCount < 3 && node.requiresVehicularJunctionTrimming) {
      errors.push(
        `RoadNode ${node.id} requiresVehicularJunctionTrimming with vehicularHalfEdgeCount=${node.vehicularHalfEdgeCount}`
      );
    }
    if (node.requiresVehicularContinuityMiter && node.vehicularHalfEdgeCount !== 2) {
      errors.push(
        `RoadNode ${node.id} requiresVehicularContinuityMiter with vehicularHalfEdgeCount=${node.vehicularHalfEdgeCount}`
      );
    }
    if (node.requiresVehicularContinuityMiter && node.requiresVehicularJunctionTrimming) {
      errors.push(
        `RoadNode ${node.id} cannot require both vehicular continuity miter and junction trimming`
      );
    }
    if (
      node.requiresVehicularContinuityMiter &&
      (node.layer !== 0 || node.isBridge || node.isTunnel)
    ) {
      errors.push(
        `RoadNode ${node.id} requiresVehicularContinuityMiter on non-at-grade node (layer=${node.layer}, bridge=${node.isBridge}, tunnel=${node.isTunnel})`
      );
    }
  }

  for (const edge of bundle.railwayEdges) {
    if (!bundle.railwayNodesById.has(edge.fromNodeId)) {
      errors.push(`RailwayEdge ${edge.id} missing fromNodeId ${edge.fromNodeId}`);
    }
    if (!bundle.railwayNodesById.has(edge.toNodeId)) {
      errors.push(`RailwayEdge ${edge.id} missing toNodeId ${edge.toNodeId}`);
    }
    if (edge.provenance.segments.length === 0) {
      errors.push(`RailwayEdge ${edge.id} has empty provenance segments`);
    }
    for (const sid of edge.sourceFeatureIds) {
      const mapped = bundle.sourceFeatureToRailwayEdgeIds.get(sid);
      if (!mapped || !mapped.includes(edge.id)) {
        errors.push(`RailwayEdge ${edge.id} sourceFeatureId ${sid} missing from lookup map`);
      }
    }
  }

  for (const node of bundle.railwayNodes) {
    if (node.isConfirmedSwitch) {
      const tt = node.turnoutTopology;
      if (!tt || !tt.trunkEdgeId || !tt.mainBranchEdgeId || !tt.divergingBranchEdgeId) {
        errors.push(
          `Confirmed switch RailwayNode ${node.id} missing trunk/main/diverging branch IDs`
        );
      }
      if (bundle.unresolvedDiagnostics.unresolvedRailwaySwitchNodeIds.includes(node.id)) {
        errors.push(`Confirmed switch RailwayNode ${node.id} listed in unresolved switches`);
      }
    }
  }

  for (const fc of bundle.railwayFlatCrossings) {
    if (fc.allowsBranchInterchange !== false) {
      errors.push(`RailwayFlatCrossing ${fc.id} must have allowsBranchInterchange === false`);
    }
    if (fc.trackAEdgeId === fc.trackBEdgeId) {
      errors.push(`RailwayFlatCrossing ${fc.id} references identical trackA and trackB edge IDs`);
    }
    if (
      !bundle.railwayEdgesById.has(fc.trackAEdgeId) ||
      !bundle.railwayEdgesById.has(fc.trackBEdgeId)
    ) {
      errors.push(`RailwayFlatCrossing ${fc.id} references missing railway edge`);
    }
  }

  for (const lc of bundle.levelCrossings) {
    if (!bundle.roadEdgesById.has(lc.roadEdgeId)) {
      errors.push(`LevelCrossing ${lc.id} references missing roadEdgeId ${lc.roadEdgeId}`);
    }
    if (!bundle.railwayEdgesById.has(lc.railwayEdgeId)) {
      errors.push(`LevelCrossing ${lc.id} references missing railwayEdgeId ${lc.railwayEdgeId}`);
    }
  }

  for (const gt of bundle.gradeTransitions) {
    if (gt.network === 'road') {
      if (
        !bundle.roadEdgesById.has(gt.atGradeEdgeId) ||
        !bundle.roadEdgesById.has(gt.gradeSeparatedEdgeId)
      ) {
        errors.push(`Road GradeTransition ${gt.id} references missing road edge`);
      }
    } else {
      if (
        !bundle.railwayEdgesById.has(gt.atGradeEdgeId) ||
        !bundle.railwayEdgesById.has(gt.gradeSeparatedEdgeId)
      ) {
        errors.push(`Railway GradeTransition ${gt.id} references missing railway edge`);
      }
    }
  }

  if (graph) {
    if (bundle.roadEdges.length !== graph.roads.edges.size) {
      errors.push(
        `Road edge count mismatch: descriptor=${bundle.roadEdges.length}, graph=${graph.roads.edges.size}`
      );
    }
    if (bundle.railwayEdges.length !== graph.railways.edges.size) {
      errors.push(
        `Railway edge count mismatch: descriptor=${bundle.railwayEdges.length}, graph=${graph.railways.edges.size}`
      );
    }
  }

  const confirmedSwitchCount = bundle.railwayNodes.filter((n) => n.isConfirmedSwitch).length;

  return {
    isValid: errors.length === 0,
    errors,
    roadEdgeCount: bundle.roadEdges.length,
    roadNodeCount: bundle.roadNodes.length,
    railwayEdgeCount: bundle.railwayEdges.length,
    railwayNodeCount: bundle.railwayNodes.length,
    confirmedSwitchCount,
    flatCrossingCount: bundle.railwayFlatCrossings.length,
    levelCrossingCount: bundle.levelCrossings.length,
    gradeTransitionCount: bundle.gradeTransitions.length,
    gradeSeparatedCrossingCount: bundle.gradeSeparatedCrossings.length,
  };
}

/**
 * Prepares the Stage E1 infrastructure render preview for a dataset.
 *
 * - When both `options.roads` and `options.railways` are `'legacy'` (the default),
 *   returns immediately with `graph: null, descriptors: null` and zero CPU overhead.
 * - When either `options.roads` or `options.railways` is `'graph-preview'`,
 *   builds **one shared `InfrastructureGraph`** for the dataset, adapts it into
 *   `InfrastructureRenderDescriptorBundle`, and validates its contracts.
 */
export function prepareInfrastructureRenderPreview(
  input: ProcessedMapData | TopologySourceData,
  options?: Partial<InfrastructureRenderOptions> | null
): InfrastructureRenderPreviewResult {
  const normalizedOptions = normalizeInfrastructureRenderOptions(options);
  if (!requiresInfrastructureGraphPreview(normalizedOptions)) {
    return {
      options: normalizedOptions,
      graph: null,
      descriptors: null,
      validation: null,
      timing: {
        graphBuildTimeMs: 0,
        adapterBuildTimeMs: 0,
        validationTimeMs: 0,
        totalPreviewTimeMs: 0,
      },
    };
  }

  const tStart = performance.now();

  const tGraph0 = performance.now();
  const graph = buildInfrastructureGraph(input);
  const graphBuildTimeMs = Number((performance.now() - tGraph0).toFixed(3));

  const tAdapt0 = performance.now();
  const descriptors = buildInfrastructureRenderDescriptors(graph, normalizedOptions);
  const adapterBuildTimeMs = Number((performance.now() - tAdapt0).toFixed(3));

  const tVal0 = performance.now();
  const validation = validateInfrastructureRenderDescriptors(descriptors, graph);
  const validationTimeMs = Number((performance.now() - tVal0).toFixed(3));

  const totalPreviewTimeMs = Number((performance.now() - tStart).toFixed(3));

  return {
    options: normalizedOptions,
    graph,
    descriptors,
    validation,
    timing: {
      graphBuildTimeMs,
      adapterBuildTimeMs,
      validationTimeMs,
      totalPreviewTimeMs,
    },
  };
}
