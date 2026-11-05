import {
  RawGeoJsonProperties,
  RoadClass,
  RailwayType,
} from '../../../types/MapFeature';

export type InfrastructureNetworkKind = 'road' | 'railway';

export type RoadTier = 'vehicular' | 'path';

/**
 * Normalized directionality relative to an edge's `fromNodeId -> toNodeId` vertex order.
 * - 'forward': one-way traversal permitted in `fromNodeId -> toNodeId` direction (`oneway=yes|1|true`)
 * - 'reverse': one-way traversal permitted in `toNodeId -> fromNodeId` direction (`oneway=-1|reverse`)
 * - 'bidirectional': two-way (`oneway=no|0|false` or default when omitted)
 * - 'unknown': unusual/conditional OSM value (`oneway=reversible|alternating|<custom>`); preserved verbatim in `rawOnewayTag`
 */
export type NormalizedOneWay = 'forward' | 'reverse' | 'bidirectional' | 'unknown';

/**
 * Origin of a graph node's identity.
 */
export type NodeIdOrigin =
  | 'explicit_osm'         // Grounded in an explicit OSM node ID (`rawOsmNodeId` is defined)
  | 'coordinate_fallback'  // Synthesized by 0.15 m spatial clustering of coordinate-only vertices
  | 'boundary_clip';       // Isolated synthetic endpoint created by region bounding-box clipping

/**
 * Non-exclusive topological roles that a RoadNode may hold simultaneously.
 * A single RoadNode can be e.g. both `'junction'` and `'level_crossing'`, or `'grade_transition'` and `'attribute_break'`.
 */
export type RoadNodeRole =
  | 'junction'          // Topological intersection (degree >= 3, or degree >= 2 with distinct parallel branches)
  | 'dead_end'          // Terminal unclipped road endpoint (degree === 1)
  | 'boundary_clip'     // Synthetic endpoint created by Liang-Barsky bounding-box clipping
  | 'grade_transition'  // Confirmed portal boundary where at-grade road meets bridge or tunnel (Stage D)
  | 'attribute_break'   // Degree-2 node retained due to roadClass/width/oneway/layer/culvert/lanes/name change
  | 'level_crossing'    // Confirmed road/rail level crossing (`railway=level_crossing` or `railway=crossing`, Stage D)
  | 'highway_crossing'  // Pedestrian crosswalk node (`highway=crossing`, Stage D)
  | 'cross_tier'        // Shared node between 'vehicular' and 'path' road tiers
  | 'loop_anchor';      // Deterministic anchor node retained on an isolated closed ring (`isClosedLoop`)

/**
 * Non-exclusive topological roles that a RailwayNode may hold simultaneously (Stage C/D).
 */
export type RailwayNodeRole =
  | 'switch'            // Turnout allowing branch divergence (`railway=switch` or verified 1-to-2 throat topology)
  | 'railway_crossing'  // Non-interconnecting flat rail-over-rail crossing (`railway=railway_crossing`)
  | 'junction'          // Multi-track node (degree >= 3) where switch/flat-crossing semantics are unresolved
  | 'dead_end'          // Terminal track end / buffer stop (degree === 1, not boundary-clipped)
  | 'boundary_clip'     // Synthetic endpoint created by Liang-Barsky bounding-box clipping
  | 'grade_transition'  // Confirmed portal boundary where at-grade track meets bridge or tunnel
  | 'attribute_break'   // Degree-2 node retained due to railwayType/gauge/electrified/service change
  | 'level_crossing'    // Confirmed road/rail or pedestrian/rail crossing on this track
  | 'loop_anchor';      // Deterministic anchor node retained on an isolated closed track loop

export type InfrastructurePointKind =
  | 'railway_switch'          // railway=switch
  | 'railway_crossing_flat'   // railway=railway_crossing (rail-over-rail flat diamond crossing)
  | 'railway_level_crossing'  // railway=level_crossing (vehicular road across rail)
  | 'railway_ped_crossing'    // railway=crossing (pedestrian/path across rail)
  | 'highway_crossing';       // highway=crossing (pedestrian crosswalk on road)

/**
 * Point-level OSM infrastructure node metadata preserved during GeoJSON ingestion (populated in Stage D).
 */
export interface InfrastructurePointMetadata {
  /** Feature ID from GeoJSON (e.g. "node/98765"). */
  id: string;
  /** True if `id` came from an explicit source feature ID (`f.id`, `props.id`, or `props['@id']`), false if synthetic `feat-${featureIndex}`. */
  hasExplicitSourceId: boolean;
  /** Explicit raw OSM node ID if extractable (e.g. "98765"), otherwise undefined. */
  rawOsmNodeId?: string;
  /** Local metric world coordinates [x, z]. */
  point: [number, number];
  /** Classified point infrastructure role. */
  kind: InfrastructurePointKind;
  /** Original raw OSM tags on the point feature (`crossing=*`, `railway:switch=*`, `turnout_side=*`, etc.). */
  osmTags: RawGeoJsonProperties;
}

/**
 * Non-destructive, pre-deduplication and pre-chaining road way part captured immediately
 * after bounding-box clipping (`clipPolylineToBox`) and culvert/layer classification,
 * BEFORE `seenRoadSegments` heuristic deduplication and BEFORE `chainContiguousRoads`.
 */
export interface UnchainedRoadPart {
  /** Unique part ID (e.g. "way/100-0"). */
  id: string;
  /** Original unsplit feature ID (e.g. "way/100", or synthetic "feat-1" when the input feature lacked an ID). */
  sourceFeatureId: string;
  /**
   * True when `sourceFeatureId` came from an explicit ID in the input GeoJSON (`f.id`, `props.id`, or `props['@id']`);
   * false when synthesized as `feat-${featureIndex}`.
   */
  hasExplicitSourceId: boolean;
  /** Zero-based index of this clipped/multi-line part within `sourceFeatureId`. */
  partIndex: number;
  /** Ordered 2D metric vertices [x, z][] in original digitized way orientation. */
  points: readonly [number, number][];
  /**
   * Raw unprefixed OSM node IDs aligned 1:1 with `points` where verified,
   * or `undefined` at vertices lacking an explicit OSM node ID (including boundary cuts).
   */
  rawOsmNodeIds: readonly (string | undefined)[];
  /** True if `points[0]` was synthesized by Liang-Barsky bounding-box clipping. */
  clippedAtStart: boolean;
  /** True if `points[points.length - 1]` was synthesized by Liang-Barsky bounding-box clipping. */
  clippedAtEnd: boolean;
  roadClass: RoadClass;
  width: number;
  layer: number;
  isBridge: boolean;
  isTunnel: boolean;
  isCulvert: boolean;
  name?: string;
  /** Original unmodified OSM tags for this specific way. */
  osmTags: RawGeoJsonProperties;
}

/**
 * Non-destructive railway way part captured immediately after bounding-box clipping (Stage C).
 */
export interface UnchainedRailwayPart {
  id: string;
  sourceFeatureId: string;
  hasExplicitSourceId: boolean;
  partIndex: number;
  points: readonly [number, number][];
  rawOsmNodeIds: readonly (string | undefined)[];
  clippedAtStart: boolean;
  clippedAtEnd: boolean;
  railwayType: RailwayType;
  width: number;
  layer: number;
  isBridge: boolean;
  isTunnel: boolean;
  name?: string;
  gauge?: string;
  electrified?: string;
  service?: string;
  usage?: string;
  isSecondaryBranch: boolean;
  osmTags: RawGeoJsonProperties;
}

/**
 * Non-destructive topology input attached to `ProcessedMapData.topologySource`,
 * captured prior to heuristic road deduplication and prior to road chaining.
 */
export interface TopologySourceData {
  roadParts: readonly UnchainedRoadPart[];
  railwayParts: readonly UnchainedRailwayPart[];
  infrastructurePoints: readonly InfrastructurePointMetadata[];
}

/**
 * Represents a single attached edge endpoint (half-edge) at a node.
 * For a closed self-loop edge (`fromNodeId === toNodeId`), two IncidentHalfEdge entries
 * exist at the anchor node (one with `endpoint: 'start'`, one with `endpoint: 'end'`),
 * while `incidentEdgeIds` contains the unique edge ID once.
 */
export interface IncidentHalfEdge {
  edgeId: string;
  endpoint: 'start' | 'end';
  /** Unit tangent [dx, dz] pointing from the node into the interior of the edge along this half-edge. */
  inwardTangent: [number, number];
}

/**
 * Provenance for a single constituent unchained source part inside a simplified graph edge.
 */
export interface EdgeSegmentProvenance {
  /** Unchained part ID (e.g. "way/100-0"). */
  partId: string;
  /** Original OSM feature ID (e.g. "way/100"). */
  sourceFeatureId: string;
  /** Additional duplicate feature IDs merged into this segment during strict 1 mm exact deduplication. */
  deduplicatedFeatureIds: readonly string[];
  /** Start arc-length (meters) along the parent simplified edge in `fromNodeId -> toNodeId` order. */
  startArcLength: number;
  /** End arc-length (meters) along the parent simplified edge in `fromNodeId -> toNodeId` order. */
  endArcLength: number;
  /** Start vertex index (inclusive) in the parent simplified edge's `points` array. */
  startVertexIndex: number;
  /** End vertex index (inclusive) in the parent simplified edge's `points` array (`startVertexIndex < endVertexIndex`). */
  endVertexIndex: number;
  /** Corresponding vertex index in the original `UnchainedRoadPart` / `UnchainedRailwayPart` at `startVertexIndex`. */
  sourceStartVertexIndex: number;
  /** Corresponding vertex index in the original `UnchainedRoadPart` / `UnchainedRailwayPart` at `endVertexIndex`. */
  sourceEndVertexIndex: number;
  /**
   * True if this constituent part's traversal along the parent edge (`fromNodeId -> toNodeId`)
   * runs opposite to its original digitized point order (`sourceStartVertexIndex > sourceEndVertexIndex`).
   */
  reversedRelativeToSource: boolean;
  /** Original unmodified OSM tags for this constituent way segment. */
  osmTags: RawGeoJsonProperties;
}

/**
 * Complete OSMnx-style lineage for a simplified graph edge.
 */
export interface EdgeProvenance {
  /** Deterministic primary part ID (`segments[0].partId`). */
  primaryPartId: string;
  /** Ordered list of unchained part IDs along `fromNodeId -> toNodeId`. */
  mergedPartIds: readonly string[];
  /** Deduplicated, canonically sorted list of all raw OSM `sourceFeatureId`s (including exact duplicates). */
  sourceFeatureIds: readonly string[];
  /** Contiguous, non-overlapping segment intervals covering `[0, lengthMeters]` in parent edge traversal order. */
  segments: readonly EdgeSegmentProvenance[];
}

export interface BaseInfrastructureNode<TRole extends string> {
  /** Deterministic domain-and-scope canonical node ID (e.g. "road_node:0|0|0:osm_5001" or "road_node:0|0|0:fb_1"). */
  id: string;
  /** Network domain ('road' | 'railway'). */
  network: InfrastructureNetworkKind;
  /** Explicit raw unprefixed OSM node ID if grounded in OSM data (e.g. "5001"); `undefined` for coordinate fallback or boundary clip. */
  rawOsmNodeId?: string;
  /** Explicit provenance of how this node's identity was established. */
  nodeIdOrigin: NodeIdOrigin;
  /** Local East-West world coordinate in meters (+X East). */
  x: number;
  /** Local North-South world coordinate in meters (+Z South). */
  z: number;
  /** Effective vertical OSM layer tag (default 0). */
  layer: number;
  /** True if node belongs to a bridge structure scope. */
  isBridge: boolean;
  /** True if node belongs to a tunnel/underpass structure scope. */
  isTunnel: boolean;
  /** True if synthesized by region bounding-box clipping (`nodeIdOrigin === 'boundary_clip'`). */
  isBoundaryClipped: boolean;
  /**
   * Topological degree: exact count of attached edge endpoints (`incidentHalfEdges.length`).
   * An ordinary incident edge contributes +1; a closed self-loop edge attaches both endpoints and contributes +2.
   */
  degree: number;
  /** Primary role selected by deterministic precedence rules for summary inspection. */
  primaryRole: TRole;
  /**
   * Non-exclusive, canonically sorted list of all topological roles held by this node
   * (e.g. `['junction', 'level_crossing']` or `['attribute_break', 'grade_transition']`).
   */
  roles: readonly TRole[];
  /**
   * Deduplicated, canonically sorted list of unique incident edge IDs.
   * A closed self-loop edge appears once in `incidentEdgeIds` and twice in `incidentHalfEdges`.
   */
  incidentEdgeIds: readonly string[];
  /** All attached half-edges (`incidentHalfEdges.length === degree`). */
  incidentHalfEdges: readonly IncidentHalfEdge[];
  /** Point-level OSM tags if an ingested `InfrastructurePointMetadata` feature matched this node (Stage D). */
  pointOsmTags?: RawGeoJsonProperties;
}

export interface RoadNode extends BaseInfrastructureNode<RoadNodeRole> {
  network: 'road';
  /** True if incident to both 'vehicular' and 'path' road edges (`roles.includes('cross_tier')`). */
  isCrossTier: boolean;
}

export type TurnoutClassificationStatus =
  | 'confirmed'
  | 'unresolved_main_vs_diverging'
  | 'unresolved_throat';

export interface TurnoutTopologySpec {
  status: TurnoutClassificationStatus;
  trunkEdgeId?: string;
  mainBranchEdgeId?: string;
  divergingBranchEdgeId?: string;
  turnoutSide?: 'left' | 'right';
  divergenceAngleRad?: number;
  candidateEdgeIds: readonly string[];
}

export interface RailwayNode extends BaseInfrastructureNode<RailwayNodeRole> {
  network: 'railway';
  turnoutTopology?: TurnoutTopologySpec;
}

export interface BaseInfrastructureEdge {
  /** Deterministic canonical edge ID. */
  id: string;
  /** Network domain ('road' | 'railway'). */
  network: InfrastructureNetworkKind;
  /** Start topological node ID (`points[0]`). */
  fromNodeId: string;
  /** End topological node ID (`points[points.length - 1]`). */
  toNodeId: string;
  /**
   * Zero-based parallel multi-edge index among all edges sharing the unordered node pair `{fromNodeId, toNodeId}`
   * (`0` when unique, `0..k-1` when multiple distinct parallel edges connect the same two nodes).
   */
  parallelIndex: number;
  /** Full 2D metric polyline geometry [x, z][] preserving all intermediate curve/shape vertices. */
  points: readonly [number, number][];
  /**
   * Raw unprefixed OSM node IDs aligned 1:1 with `points` (`undefined` where a vertex had no explicit OSM node ID).
   */
  vertexRawOsmNodeIds: readonly (string | undefined)[];
  /** Cumulative Euclidean arc-length in meters. */
  lengthMeters: number;
  /** Effective OSM vertical layer. */
  layer: number;
  /** True if edge is a bridge structure. */
  isBridge: boolean;
  /** True if edge is a tunnel structure. */
  isTunnel: boolean;
  /** True if `fromNodeId === toNodeId`. */
  isClosedLoop: boolean;
  /** True if `points[0]` was synthesized by region bounding-box clipping. */
  clippedAtStart: boolean;
  /** True if `points[points.length - 1]` was synthesized by Liang-Barsky bounding-box clipping. */
  clippedAtEnd: boolean;
  /**
   * Unit tangent [dx, dz] at `points[0]` pointing INWARD along the edge (`fromNodeId -> points[1]`).
   */
  startInwardTangent: [number, number];
  /**
   * Unit tangent [dx, dz] at `points[N-1]` pointing INWARD along the edge (`toNodeId -> points[N-2]`).
   */
  endInwardTangent: [number, number];
  /** Complete per-segment OSM provenance and arc-length mapping. */
  provenance: EdgeProvenance;
}

export interface RoadEdge extends BaseInfrastructureEdge {
  network: 'road';
  roadClass: RoadClass;
  tier: RoadTier;
  width: number;
  lanes?: number;
  /** Normalized directionality relative to `fromNodeId -> toNodeId`. */
  normalizedOneway: NormalizedOneWay;
  /** Exact raw `oneway` tag value from OSM if present (e.g. "yes", "-1", "reversible"), or `undefined`. */
  rawOnewayTag?: string;
  name?: string;
  surface?: string;
  isCulvert: boolean;
}

export interface RailwayEdge extends BaseInfrastructureEdge {
  network: 'railway';
  railwayType: RailwayType;
  width: number;
  gauge?: string;
  electrified?: string;
  service?: string;
  usage?: string;
  isSecondaryBranch: boolean;
  name?: string;
}

export interface InfrastructureNetwork<TNode, TEdge> {
  /** Map from canonical node ID to node record. */
  nodes: ReadonlyMap<string, TNode>;
  /** Map from canonical edge ID to edge record. */
  edges: ReadonlyMap<string, TEdge>;
  /** Map from original `sourceFeatureId` (or unchained part ID) to the simplified edge ID(s) containing it. */
  featureToEdgeIds: ReadonlyMap<string, readonly string[]>;
}

export type RoadNetwork = InfrastructureNetwork<RoadNode, RoadEdge>;
export type RailwayNetwork = InfrastructureNetwork<RailwayNode, RailwayEdge>;

/**
 * Diagnostics produced by Stage B road network graph construction.
 */
export interface RoadNetworkDiagnostics {
  inputPartCount: number;
  exactDeduplicatedCount: number;
  roadNodeCount: number;
  roadEdgeCount: number;
  roadSimplifiedDegree2Count: number;
  roadInteriorSplitCount: number;
  roadParallelEdgePairCount: number;
  boundaryClippedNodeCount: number;
  crossTierNodeCount: number;
  closedLoopEdgeCount: number;
  unresolvedInfrastructurePoints?: readonly UnresolvedInfrastructurePointCandidate[];
}

/**
 * Optional configuration for `buildRoadNetwork` (Stage D cross-modal node protection & highway_crossing ingestion).
 */
export interface RoadNetworkBuildOptions {
  /** Point-level infrastructure metadata (`highway=crossing`, etc.) to match against road nodes. */
  infrastructurePoints?: readonly InfrastructurePointMetadata[];
  /** Explicit raw OSM node IDs (`rawOsmNodeId`) that must be preserved as topological nodes and never contracted at degree 2. */
  protectedRawOsmNodeIds?: ReadonlySet<string>;
  /** Specific `(partId, vertexIndex)` pairs that must be split at interior vertices and never contracted at degree 2. */
  protectedPartVertices?: ReadonlyMap<string, ReadonlySet<number>>;
  /** Additional topological roles to attach to retained road nodes keyed by `rawOsmNodeId`. */
  additionalNodeRolesByOsmId?: ReadonlyMap<string, readonly RoadNodeRole[]>;
}

/**
 * Stage B result returned by `buildRoadNetwork`.
 */
export interface RoadNetworkBuildResult {
  roads: RoadNetwork;
  diagnostics: RoadNetworkDiagnostics;
}

/**
 * Optional configuration for `buildRailwayNetwork` (Stage C/D point ingestion & cross-modal node protection).
 */
export interface RailwayNetworkBuildOptions {
  /** Point-level infrastructure metadata (`railway=switch`, `railway=railway_crossing`, etc.). */
  infrastructurePoints?: readonly InfrastructurePointMetadata[];
  /** Explicit raw OSM node IDs (`rawOsmNodeId`) that must be preserved as topological nodes and never contracted at degree 2. */
  protectedRawOsmNodeIds?: ReadonlySet<string>;
  /** Specific `(partId, vertexIndex)` pairs that must be split at interior vertices and never contracted at degree 2. */
  protectedPartVertices?: ReadonlyMap<string, ReadonlySet<number>>;
  /** Additional topological roles to attach to retained railway nodes keyed by `rawOsmNodeId`. */
  additionalNodeRolesByOsmId?: ReadonlyMap<string, readonly RailwayNodeRole[]>;
}

export interface GradeTransitionRelation {
  id: string;
  network: InfrastructureNetworkKind;
  transitionType: 'bridge_approach' | 'tunnel_portal';
  position: [number, number];
  rawOsmNodeId?: string;
  atGradeNodeId: string;
  atGradeEdgeId: string;
  atGradeEndpoint: 'start' | 'end';
  gradeSeparatedNodeId: string;
  gradeSeparatedEdgeId: string;
  gradeSeparatedEndpoint: 'start' | 'end';
  continuousTraversalDot: number;
  confidence: 'explicit_osm_node' | 'coordinate_fallback_confirmed';
}

export interface UnresolvedGradeTransitionCandidate {
  network: InfrastructureNetworkKind;
  position: [number, number];
  gradeSeparatedEdgeId: string;
  gradeSeparatedEndpoint: 'start' | 'end';
  candidateAtGradeEdgeIds: readonly string[];
  distanceMeters: number;
  continuousTraversalDot?: number;
  reason:
    | 'ambiguous_multiple_candidates'
    | 'misaligned_tangent'
    | 'non_terminal_endpoint'
    | 'incompatible_class_or_tier'
    | 'distinct_explicit_osm_nodes'
    | 'exceeds_snap_tolerance';
}

export interface RailwayFlatCrossingRelation {
  id: string;
  position: [number, number];
  rawOsmNodeId?: string;
  trackAEdgeId: string;
  trackAArcLengthMeters: number;
  trackBEdgeId: string;
  trackBArcLengthMeters: number;
  crossingAngleRad: number;
  confidence: 'explicit_railway_crossing_tag' | 'shared_osm_node_flat_crossing';
  pointOsmTags?: RawGeoJsonProperties;
}

export interface LevelCrossingRelation {
  id: string;
  crossingKind: 'road_rail_level_crossing' | 'pedestrian_rail_crossing';
  position: [number, number];
  rawOsmNodeId?: string;
  roadEdgeId: string;
  roadNodeId?: string;
  roadArcLengthMeters: number;
  railwayEdgeId: string;
  railwayNodeId?: string;
  railwayArcLengthMeters: number;
  crossingAngleRad: number;
  confidence: 'explicit_osm_crossing_tag' | 'shared_explicit_osm_node';
  pointOsmTags?: RawGeoJsonProperties;
}

export interface UnresolvedCrossingCandidate {
  kind: 'road_rail' | 'pedestrian_rail' | 'rail_rail' | 'road_road';
  position: [number, number];
  edgeAId: string;
  edgeBId: string;
  reason:
    | 'coincident_vertex_without_osm_id'
    | 'geometric_intersection_without_shared_node'
    | 'missing_railway_crossing_tag_at_degree_4_node'
    | 'ambiguous_railway_crossing_track_pairing'
    | 'conflicting_crossing_tag_and_road_tier'
    | 'conflicting_explicit_osm_node_id';
}

export type UnresolvedInfrastructurePointReason =
  | 'no_candidate_node_within_snap_tolerance'
  | 'conflicting_explicit_osm_node_id'
  | 'ambiguous_multiple_candidate_nodes'
  | 'vertical_scope_mismatch'
  | 'insufficient_topological_evidence'
  | 'conflicting_crossing_tag_and_road_tier';

export interface UnresolvedInfrastructurePointCandidate {
  pointId: string;
  rawOsmNodeId?: string;
  kind: InfrastructurePointKind;
  position: [number, number];
  candidateNodeIds: readonly string[];
  reason: UnresolvedInfrastructurePointReason;
  osmTags: RawGeoJsonProperties;
}

export interface RailwayNetworkDiagnostics {
  inputPartCount: number;
  exactDeduplicatedCount: number;
  railwayNodeCount: number;
  railwayEdgeCount: number;
  railwayConfirmedSwitchCount: number;
  railwayUnresolvedSwitchCount: number;
  railwayFlatCrossingCount: number;
  railwayUnresolvedJunctionCount: number;
  railwaySimplifiedDegree2Count: number;
  railwayInteriorSplitCount: number;
  railwayParallelEdgePairCount: number;
  boundaryClippedNodeCount: number;
  closedLoopEdgeCount: number;
  unresolvedCrossings: readonly UnresolvedCrossingCandidate[];
  unresolvedInfrastructurePoints: readonly UnresolvedInfrastructurePointCandidate[];
}

export interface RailwayNetworkBuildResult {
  railways: RailwayNetwork;
  railwayFlatCrossings: readonly RailwayFlatCrossingRelation[];
  diagnostics: RailwayNetworkDiagnostics;
}

export interface GradeSeparatedCrossingRelation {
  id: string;
  position: [number, number];
  upperNetwork: InfrastructureNetworkKind;
  upperEdgeId: string;
  upperLayer: number;
  upperIsBridge: boolean;
  lowerNetwork: InfrastructureNetworkKind;
  lowerEdgeId: string;
  lowerLayer: number;
  lowerIsTunnel: boolean;
}

export interface CrossModalAnalysisInput {
  roads: RoadNetwork;
  railways: RailwayNetwork;
  infrastructurePoints?: readonly InfrastructurePointMetadata[];
  railwayFlatCrossings?: readonly RailwayFlatCrossingRelation[];
  railwayUnresolvedCrossings?: readonly UnresolvedCrossingCandidate[];
  roadUnresolvedInfrastructurePoints?: readonly UnresolvedInfrastructurePointCandidate[];
  railwayUnresolvedInfrastructurePoints?: readonly UnresolvedInfrastructurePointCandidate[];
}

export interface CrossModalAnalysisResult {
  levelCrossings: readonly LevelCrossingRelation[];
  gradeTransitions: readonly GradeTransitionRelation[];
  gradeSeparatedCrossings: readonly GradeSeparatedCrossingRelation[];
  unresolvedCrossings: readonly UnresolvedCrossingCandidate[];
  unresolvedGradeTransitions: readonly UnresolvedGradeTransitionCandidate[];
  unresolvedInfrastructurePoints: readonly UnresolvedInfrastructurePointCandidate[];
  confirmedRoadLevelCrossingNodeTags: ReadonlyMap<string, RawGeoJsonProperties>;
  confirmedRailwayLevelCrossingNodeTags: ReadonlyMap<string, RawGeoJsonProperties>;
}

export interface TopologyDiagnostics {
  roadNodeCount: number;
  roadEdgeCount: number;
  roadSimplifiedDegree2Count: number;
  roadInteriorSplitCount: number;
  roadParallelEdgePairCount: number;
  railwayNodeCount: number;
  railwayEdgeCount: number;
  railwayConfirmedSwitchCount: number;
  railwayUnresolvedSwitchCount: number;
  railwayFlatCrossingCount: number;
  railwayUnresolvedJunctionCount: number;
  railwaySimplifiedDegree2Count: number;
  gradeTransitionCount: number;
  unresolvedGradeTransitionCount: number;
  levelCrossingCount: number;
  pedestrianRailCrossingCount: number;
  unresolvedCrossingCount: number;
  gradeSeparatedCrossingCount: number;
  boundaryClippedNodeCount: number;
  unresolvedGradeTransitions: readonly UnresolvedGradeTransitionCandidate[];
  unresolvedCrossings: readonly UnresolvedCrossingCandidate[];
  unresolvedInfrastructurePoints?: readonly UnresolvedInfrastructurePointCandidate[];
}

export interface InfrastructureGraph {
  roads: RoadNetwork;
  railways: RailwayNetwork;
  gradeTransitions: readonly GradeTransitionRelation[];
  railwayFlatCrossings: readonly RailwayFlatCrossingRelation[];
  levelCrossings: readonly LevelCrossingRelation[];
  gradeSeparatedCrossings: readonly GradeSeparatedCrossingRelation[];
  diagnostics: TopologyDiagnostics;
}
