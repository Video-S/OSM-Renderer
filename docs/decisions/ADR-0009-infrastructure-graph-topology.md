# ADR-0009: Infrastructure Graph Topology, Domain Contracts, and Simplification Architecture

## Metadata

- **Decision ID**: `ADR-0009`
- **Status**: `Proposed` *(Stage A Architecture — Pending Project Owner Review prior to Stage B implementation)*
- **Date**: `2026-11-05`
- **Deciders**: Project Owner, Architecture & Rendering Engineering
- **Consulted**: OSMnx Conceptual Reference (`osmnx.simplification`, `osmnx.graph`), Goalpost 1 & M2.1/M2.2 Codebase Audit (`TKT-003`)

---

## Context and Problem

Milestone 2.3 (`M2.3: Infrastructure Topology and Connectivity`) establishes a deterministic, pure-TypeScript infrastructure topology layer between GeoJSON feature ingestion (`LocalGeoJsonProvider`) and 3D procedural geometry synthesis (`GeometryBuilder`, `RailwayGeometryBuilder`, and future `M2.4` surface markings).

### 1. Conceptual Distinction: Three Levels of Infrastructure Relationship

M2.3 enforces a strict separation between three concepts that must never be conflated:

1. **Geometric Intersection (2D Planimetric Crossing or Proximity)**:
   - Two polyline segments cross or pass near each other in the horizontal $(X, Z)$ plane (e.g., an elevated bridge passing over an at-grade street, a subterranean tunnel beneath a rail yard, two non-interconnecting railway tracks crossing at a flat diamond, or an unsplit footpath crossing a carriageway).
   - **Rule**: Planimetric crossing or spatial proximity alone **never** creates a topological junction node or edge split.
2. **Physical / Topological Connectivity (M2.3 Primary Scope)**:
   - Two or more infrastructure segments share a verified physical connection: a road intersection, a railway turnout switch (`railway=switch`), a validated grade-transition portal (`at_grade <-> bridge` or `at_grade <-> tunnel`), or an explicit cross-infrastructure crossing relation (`railway=level_crossing`, `railway=crossing`, `railway=railway_crossing`, `highway=crossing`).
   - Represented by domain-isolated graph nodes (`RoadNode`, `RailwayNode`), simplified polyline edges (`RoadEdge`, `RailwayEdge`), and typed crossing/transition relations (`GradeTransitionRelation`, `LevelCrossingRelation`, `RailwayFlatCrossingRelation`, `GradeSeparatedCrossingRelation`).
   - Where spatial proximity suggests a possible transition or crossing but explicit topological evidence is missing or ambiguous, the relationship is recorded as an **unresolved diagnostic candidate** (`UnresolvedGradeTransitionCandidate`, `UnresolvedCrossingCandidate`, `unresolvedSwitchCount`) rather than silently promoted into network connectivity.
3. **Traversability / Movement Permissions (Downstream Metadata Only)**:
   - Legal routing rules (`oneway`, `access`, turn restrictions, signaling).
   - **Rule**: M2.3 preserves raw and normalized directional/lane attributes (`rawOnewayTag`, `normalizedOneway`, `lanes`, `reversedRelativeToSource`) on graph edges so downstream `M2.4` lane/arrow markings have faithful orientation metadata, **without** implementing pathfinding, turn-restriction enforcement, switching simulation, or traffic movement.

---

### 2. Source Audit of Current Codebase (`M2.3-A` Step 1 Findings)

An audit of `LocalGeoJsonProvider.ts`, `FeatureCatalogue.ts`, `TopologicalNodeIndex.ts`, `GeometryBuilder.ts`, `RailwayTopology.ts`, `RailwayGeometryBuilder.ts`, `BridgeAndTunnelBuilder.ts`, `ElevationPolicy.ts`, and `server.ts` established the reusable foundations and current architectural gaps.

#### 2.1 Reusable Foundations
- **`TopologicalNodeIndex` (`src/world/TopologicalNodeIndex.ts`)**:
  - Implements a spatial grid (`cellSize = 0.15 m`, `DEFAULT_NODE_SNAP_TOLERANCE_METERS = 0.15`) and explicit OSM node ID registry (`${layerScope}|osm_${cleanId}` vs. coordinate fallback `tn_${layerScope}_${counter}`).
  - Enforces non-merging of distinct explicit OSM node IDs (`osm_A !== osm_B` even at `0.00 m` distance, lines 89–93).
  - Supports retroactive promotion of a fallback node (`tn_...`) to an explicit node (`osm_...`) when an explicit node arrives later within `0.15 m` in the same `layerScope`, recording aliases in `fallbackToExplicitAlias` and resolving them via `resolveCanonicalNodeId()`.
- **Source Provenance & Lineage Accounting (`ADR-0005`, `src/types/MapFeature.ts`, `src/world/LocalGeoJsonProvider.ts`)**:
  - `RoadFeature` and `RailwayFeature` carry `id`, `sourceFeatureId`, `sourceFeatureIds: string[]`, and `nodeIds?: (string | number | undefined)[]`.
  - `diagnostics.featureLineage` records `deduplicatedMap` and `chainingMap`.
- **Boundary-Derived Road Junction Trimming (`ADR-0002`, `src/world/GeometryBuilder.ts` Stage 6)**:
  - Polyline arc-length trimming (`computePolylineSubsegment`), adjacent boundary ray-cast intersection, radial miter clamping, and `RoadPortalConnectionSpec` remain the geometric meshing foundation in `GeometryBuilder`.
- **Railway Spatial Indexing & Phase Continuity (`ADR-0008`, `src/world/infrastructure/railways/RailwayTopology.ts`)**:
  - `HostTrackSpatialIndex` (`8 m x 8 m` cells), `sortRailwaysMainlineFirst`, `computeContinuousTrackPhases`, and `isTurnoutThroatPair` provide geometric utilities for sleeper placement and clipping.

#### 2.2 Confirmed Source Facts vs. Architectural Risks

To keep confirmed implementation behavior strictly separate from architectural risks, the table below distinguishes exact source facts from their downstream consequences:

| # | Area | Confirmed Source Fact (Current Implementation) | Architectural Risk / Gap for M2.3 |
| :--- | :--- | :--- | :--- |
| **G1** | **Destructive Pre-Chaining of `mapData.roads` (`LocalGeoJsonProvider.ts`)** | `LocalGeoJsonProvider.parseGeoJson()` calls `chainContiguousRoads(roads, diagnostics)` at line 1742 *before* returning `ProcessedMapData`. Inside `chainContiguousRoads` (lines 2153–2268), `current` is mutated in place: `current.id` becomes `${current.id}+${other.id}`, `current.points` and `current.nodeIds` are concatenated, `other.points` may be reversed (lines 2227, 2244), and `other.osmTags` is discarded (`current.osmTags` retains only the first way's tags). | A graph builder that only receives `mapData.roads` cannot recover original unchained way boundaries, secondary way `osmTags` (`lanes`, `surface`, `oneway`), or original per-way digitization direction. Graph construction requires a non-destructive pre-chaining input handoff. |
| **G2** | **Per-Vertex OSM Node ID Survival (`server.ts` & `LocalGeoJsonProvider.ts`)** | `LocalGeoJsonProvider.extractRawOsmNodeIds` (lines 401–406) reads `props.nodes`, `props.nodeIds`, or `props._nodeIds`. In `server.ts` (lines 159, 182), `osmtogeojson` is invoked with default options on Overpass JSON and OSM 0.6 XML fallback documents, which does not copy way `nodes` / `<nd ref>` lists onto output GeoJSON `LineString` `properties`. Additionally, `LocalGeoJsonProvider.ts` (lines 1041, 1441) passes `rawLines.length === 1 ? rawOsmNodes : undefined` to `clipPolylineToBox`. | Live `/api/osm-data` responses currently lack explicit per-vertex OSM node IDs and rely entirely on `0.15 m` coordinate fallback. `MultiLineString` features (`rawLines.length > 1`) also drop `rawOsmNodes`. |
| **G3** | **Shared `topoNodeIndex` & Unprotected Level Crossings (`LocalGeoJsonProvider.ts`)** | `LocalGeoJsonProvider.ts` (line 871) instantiates one `topoNodeIndex` shared by railways (line 1030) and roads (line 1480) using `partGradeScope = "${layer}|${isBridge}|${isTunnel}"`. Later, `chainContiguousRoads` (lines 2112–2119) computes `globalNodeDegree` by iterating **only over `roads`** (`for (const r of roads)`), not `railways`. | (1) Sharing `topoNodeIndex` couples road and railway coordinate-fallback centroids and aliases within `0.15 m` on the same `partGradeScope`. (2) Because `globalNodeDegree` only counts `roads`, a degree-2 road node that is also a shared road/rail level crossing has `globalNodeDegree === 2` and gets chained *through* by `chainContiguousRoads`, demoting the crossing node to an interior vertex. |
| **G4** | **Interior Splitting & Node Prefixing (`GeometryBuilder.ts`)** | In `splitRoadsAtSharedInteriorNodes` (`GeometryBuilder.ts`, lines 907–987): (a) vertices are scoped by `tierScope = isPath ? 'path' : 'veh'` (line 919); (b) line 946 computes `const uniqueInRoad = new Set(keys)` before incrementing `nodeUsageCount`; (c) line 942 writes `canonicalNodeIds` (`veh|osm_...`) back to `r.nodeIds`, and line 2636 prepends `tierPrefix` (`veh_`) again, producing `startNodeId = "veh_veh|osm_..."`. | (a) Cross-tier (`veh` vs. `path`) shared interior nodes are not linked topologically. (b) Confirmed bug for self-intersecting single-way P-loops: `new Set(keys)` counts a repeated vertex within the same way only once (`nodeUsageCount === 1`), so an isolated P-loop way does not split at its own self-junction. (c) The `veh_veh|osm_...` double prefix is an internal naming-consistency defect (not a functional connectivity bug, since all branches in the same tier receive the same prefix). |
| **G5** | **One-Way Handling in `chainContiguousRoads` (`LocalGeoJsonProvider.ts`)** | `chainContiguousRoads` (line 2124) groups roads by `${roadClass}|${layer}|${isBridge}|${isTunnel}|${nameKey}|${Math.round(width * 10)}` (omitting `oneway`, contrary to `docs/data-pipeline-and-feature-support.md` Section 6) and merges `other` via point reversal when `curEndKey === otherEndKey` or `curStartKey === otherStartKey` (lines 2226–2258). | Two ways with incompatible `oneway` tags (e.g., `oneway=yes` meeting `oneway=no` or opposing `oneway` segments) can be chained together and have their vertex order reversed. |
| **G6** | **Proximity-Based Grade Transitions & Railway Topology (`GeometryBuilder.ts`, `RailwayTopology.ts`, `RailwayGeometryBuilder.ts`)** | `RailwayTopology.ts` (`computeContinuousTrackPhases`, `isTurnoutThroatPair`) checks `<= 0.65 m` endpoint distance + `dot > 0.7` without consulting `RailwayFeature.nodeIds`. Bridge/tunnel portal checks in `GeometryBuilder.ts` (lines 2587–2613, 3595–3608) and `RailwayGeometryBuilder.ts` (lines 566–579) scan all endpoints within `0.65 m` or `0.80 m` Euclidean distance. | Unrelated nearby or parallel roads/paths within `0.65 m`–`0.80 m` of a bridge/tunnel portal can falsely trigger `connectsStartAtGrade` or suppress end-caps. Railway diamond crossings (`railway=railway_crossing`) are not distinguished from switches (`railway=switch`). |
| **G7** | **Point Crossing & Switch Features Skipped (`FeatureCatalogue.ts`)** | In `FeatureCatalogue.ts`, point features (`!isLine`) with `railway=level_crossing`, `railway=crossing`, `railway=railway_crossing`, `railway=switch`, or `highway=crossing` hit lines 546 or 841 (`category: 'unsupported'`) and are skipped in `LocalGeoJsonProvider.ts` (line 1009). | Point-level OSM tags on switches, flat rail crossings, road/rail level crossings, and pedestrian crossings do not survive into `ProcessedMapData`. |
| **G8** | **Boundary-Clipped Endpoints (`LocalGeoJsonProvider.ts`)** | `clipPolylineToBox` (lines 208, 219) pushes `undefined` into `osmNodes` at Liang-Barsky boundary cut points, and does not record which endpoints were created by boundary clipping. | Coordinate-only boundary cut endpoints within `0.15 m` of another way's boundary cut on the same `partGradeScope` can be snapped together into a synthetic boundary node by `topoNodeIndex`. |

---

## Decision

We will implement a deterministic, pure-TypeScript **Infrastructure Graph Architecture** under `src/world/infrastructure/topology/` using **OSMnx** (`osmnx.graph` and `osmnx.simplification`) as our conceptual reference, with zero external graph library dependencies.

### 1. Module Boundaries and File Layout

```text
src/world/infrastructure/topology/
├── types.ts                   # Pure TypeScript domain contracts (Source handoff, Nodes, Edges, Provenance, Relations, Diagnostics)
├── InfrastructureGraph.ts     # Top-level pure orchestrator: buildInfrastructureGraph(input) -> InfrastructureGraph
├── RoadNetworkBuilder.ts      # Stage B: Road node/edge extraction, interior/P-loop splitting, non-interstitial degree-2 simplification
├── RailwayNetworkBuilder.ts   # Stage C: Independent railway graph construction, turnout switch & flat diamond crossing semantics
└── CrossModalAnalyzer.ts      # Stage D: Confirmed vs. candidate grade transitions, level crossings, pedestrian crossings, overpasses
```

- `src/world/TopologicalNodeIndex.ts` is retained and instantiated **separately per network domain** (`road` vs. `railway`) so road and railway coordinate-fallback clustering and node degrees never cross-contaminate each other.

---

### 2. Non-Destructive Ingestion-to-Graph Data Handoff (`TopologySourceData`)

To resolve **Gap G1** without breaking `GeometryBuilder` or any of the 92 existing tests during Stages B–D:

1. **Why `mapData.roads` Alone Is Insufficient**:
   - `LocalGeoJsonProvider.parseGeoJson()` currently mutates and chains `RoadFeature` objects inside `chainContiguousRoads()` before returning `ProcessedMapData`. Once chained, secondary way `osmTags`, original per-way vertex directions, and unchained part boundaries are irreversibly lost.
2. **Minimal Non-Destructive Handoff Contract (`ProcessedMapData.topologySource`)**:
   - During `LocalGeoJsonProvider.parseGeoJson()`, immediately after `clipPolylineToBox` and exact-segment deduplication (`seenRoadSegments`)—and **before** `chainContiguousRoads` runs—`LocalGeoJsonProvider` records an immutable `topologySource: TopologySourceData` field on `ProcessedMapData`.
   - `chainContiguousRoads` then operates on shallow-cloned `RoadFeature` records to produce the legacy `mapData.roads` array expected by `GeometryBuilder` during Stages B–D.
   - `buildInfrastructureGraph(input: ProcessedMapData | TopologySourceData)` reads `input.topologySource` when passed a `ProcessedMapData` object (with a fallback adapter converting `mapData.roads` / `mapData.railways` into `UnchainedRoadPart` / `UnchainedRailwayPart` records only for legacy unit tests that construct synthetic `ProcessedMapData` literals directly without calling `LocalGeoJsonProvider`).

```typescript
import {
  RawGeoJsonProperties,
  RoadClass,
  RailwayType,
} from '../../../types/MapFeature';

export type InfrastructurePointKind =
  | 'railway_switch'          // railway=switch
  | 'railway_crossing_flat'   // railway=railway_crossing (rail-over-rail flat diamond crossing)
  | 'railway_level_crossing'  // railway=level_crossing (vehicular road across rail)
  | 'railway_ped_crossing'    // railway=crossing (pedestrian/path across rail)
  | 'highway_crossing';       // highway=crossing (pedestrian crosswalk on road)

/**
 * Point-level OSM infrastructure node metadata preserved during GeoJSON ingestion.
 */
export interface InfrastructurePointMetadata {
  /** Feature ID from GeoJSON (e.g. "node/98765"). */
  id: string;
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
 * Non-destructive, pre-chaining road way part captured after bounding-box clipping
 * and exact-segment deduplication, prior to `chainContiguousRoads`.
 */
export interface UnchainedRoadPart {
  /** Unique part ID (e.g. "way/100-0"). */
  id: string;
  /** Original unsplit feature ID (e.g. "way/100"). */
  sourceFeatureId: string;
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
 * Non-destructive railway way part captured after bounding-box clipping.
 */
export interface UnchainedRailwayPart {
  id: string;
  sourceFeatureId: string;
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
 * Non-destructive topology input attached to `ProcessedMapData.topologySource`.
 */
export interface TopologySourceData {
  roadParts: readonly UnchainedRoadPart[];
  railwayParts: readonly UnchainedRailwayPart[];
  infrastructurePoints: readonly InfrastructurePointMetadata[];
  /** Maps canonical retained part/source ID -> array of deduplicated duplicate feature IDs. */
  deduplicatedRoadMap: Readonly<Record<string, readonly string[]>>;
}
```

---

### 3. Proposed TypeScript Graph Domain Contracts (`src/world/infrastructure/topology/types.ts`)

```typescript
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
  | 'junction'          // Topological intersection (degree >= 3, or degree >= 2 with distinct branches)
  | 'dead_end'          // Terminal unclipped road endpoint (degree === 1)
  | 'boundary_clip'     // Synthetic endpoint created by Liang-Barsky bounding-box clipping
  | 'grade_transition'  // Confirmed portal boundary where at-grade road meets bridge or tunnel
  | 'attribute_break'   // Degree-2 node retained due to roadClass/width/oneway/layer/culvert change
  | 'level_crossing'    // Confirmed road/rail level crossing (`railway=level_crossing` or `railway=crossing`)
  | 'highway_crossing'  // Pedestrian crosswalk node (`highway=crossing`)
  | 'cross_tier'        // Shared node between 'vehicular' and 'path' road tiers
  | 'loop_anchor';      // Deterministic anchor node retained on an isolated closed ring (`isClosedLoop`)

/**
 * Non-exclusive topological roles that a RailwayNode may hold simultaneously.
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
  /** Original OSM feature ID (e.g. "way/100") plus any exact duplicates mapped to it. */
  sourceFeatureId: string;
  /** Additional duplicate feature IDs merged into this segment during exact deduplication. */
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
  /** Point-level OSM tags if an ingested `InfrastructurePointMetadata` feature matched this node. */
  pointOsmTags?: RawGeoJsonProperties;
}

export interface RoadNode extends BaseInfrastructureNode<RoadNodeRole> {
  network: 'road';
  /** True if incident to both 'vehicular' and 'path' road edges (`roles.includes('cross_tier')`). */
  isCrossTier: boolean;
}

export type TurnoutClassificationStatus =
  | 'confirmed'                    // Unambiguous 1-to-2 throat with identified trunk, main continuation, and diverging branch
  | 'unresolved_main_vs_diverging' // Valid 1-to-2 throat (`trunkEdgeId` known), but symmetric branches/tags prevent distinguishing main vs. diverging
  | 'unresolved_throat';           // Degree-3+ geometry or conflicting tags do not form a valid 1-to-2 turnout throat

export interface TurnoutTopologySpec {
  status: TurnoutClassificationStatus;
  /** Defined when `status === 'confirmed'` or `'unresolved_main_vs_diverging'`. */
  trunkEdgeId?: string;
  /** Defined only when `status === 'confirmed'`. */
  mainBranchEdgeId?: string;
  /** Defined only when `status === 'confirmed'`. */
  divergingBranchEdgeId?: string;
  /** All incident branch edge IDs at the switch node. */
  candidateEdgeIds: readonly string[];
}

export interface RailwayNode extends BaseInfrastructureNode<RailwayNodeRole> {
  network: 'railway';
  /** Populated when `roles.includes('switch')` or `degree === 3`. */
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
   * Note: Forward traversal tangent at `toNodeId` is `[-endInwardTangent[0], -endInwardTangent[1]]`.
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
 * Confirmed portal connection between an at-grade edge and a bridge or tunnel edge
 * within the same network domain ('road' or 'railway').
 */
export interface GradeTransitionRelation {
  id: string;
  network: InfrastructureNetworkKind;
  transitionType: 'bridge_approach' | 'tunnel_portal';
  /** Shared world position [x, z] of the portal transition. */
  position: [number, number];
  /** Explicit raw OSM node ID if the at-grade and bridge/tunnel endpoints share an OSM node. */
  rawOsmNodeId?: string;
  atGradeNodeId: string;
  atGradeEdgeId: string;
  atGradeEndpoint: 'start' | 'end';
  gradeSeparatedNodeId: string;
  gradeSeparatedEdgeId: string;
  gradeSeparatedEndpoint: 'start' | 'end';
  /**
   * Cosine of the continuous traversal angle across the portal:
   * `dot(-inwardTangent(atGrade), inwardTangent(gradeSeparated))` where `1.0` = perfectly collinear continuation.
   */
  continuousTraversalDot: number;
  /** Provenance of how the transition was confirmed. */
  confidence: 'explicit_osm_node' | 'coordinate_fallback_confirmed';
}

/**
 * Diagnostic record when a potential grade transition is rejected or ambiguous
 * (never silently promoted to `GradeTransitionRelation`).
 */
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

/**
 * Confirmed non-interconnecting rail-over-rail flat crossing (`railway=railway_crossing`
 * or two distinct railway tracks crossing at grade without switching capability).
 */
export interface RailwayFlatCrossingRelation {
  id: string;
  position: [number, number];
  rawOsmNodeId?: string;
  trackAEdgeId: string;
  trackAArcLengthMeters: number;
  trackBEdgeId: string;
  trackBArcLengthMeters: number;
  /** Acute crossing angle in radians (0..pi/2]. */
  crossingAngleRad: number;
  confidence: 'explicit_railway_crossing_tag' | 'shared_osm_node_flat_crossing';
  pointOsmTags?: RawGeoJsonProperties;
}

/**
 * Confirmed at-grade crossing between a RoadEdge (vehicular or pedestrian path) and a RailwayEdge.
 */
export interface LevelCrossingRelation {
  id: string;
  /** Distinguishes vehicular `railway=level_crossing` from pedestrian/path `railway=crossing`. */
  crossingKind: 'road_rail_level_crossing' | 'pedestrian_rail_crossing';
  position: [number, number];
  rawOsmNodeId?: string;
  roadEdgeId: string;
  roadNodeId?: string;
  roadArcLengthMeters: number;
  railwayEdgeId: string;
  railwayNodeId?: string;
  railwayArcLengthMeters: number;
  /** Acute intersection angle in radians (0..pi/2]. */
  crossingAngleRad: number;
  confidence: 'explicit_osm_crossing_tag' | 'shared_explicit_osm_node';
  pointOsmTags?: RawGeoJsonProperties;
}

/**
 * Diagnostic record for unconfirmed/candidate crossings inferred only from coordinate proximity
 * or 2D geometric segment intersection without shared OSM node identity or crossing tags.
 */
export interface UnresolvedCrossingCandidate {
  kind: 'road_rail' | 'pedestrian_rail' | 'rail_rail' | 'road_road';
  position: [number, number];
  edgeAId: string;
  edgeBId: string;
  reason:
    | 'coincident_vertex_without_osm_id'
    | 'geometric_intersection_without_shared_node'
    | 'missing_railway_crossing_tag_at_degree_4_node';
}

/**
 * Planimetric 2D crossing where two edges cross at different vertical scopes
 * (bridge over at-grade, tunnel under at-grade, or distinct layers) WITHOUT physical connectivity.
 */
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
}

/**
 * Top-level immutable infrastructure topology product consumed by GeometryBuilder,
 * RailwayGeometryBuilder, and future M2.4 surface marking builders.
 */
export interface InfrastructureGraph {
  roads: RoadNetwork;
  railways: RailwayNetwork;
  gradeTransitions: readonly GradeTransitionRelation[];
  railwayFlatCrossings: readonly RailwayFlatCrossingRelation[];
  levelCrossings: readonly LevelCrossingRelation[];
  gradeSeparatedCrossings: readonly GradeSeparatedCrossingRelation[];
  diagnostics: TopologyDiagnostics;
}
```

---

### 4. Graph Construction, Semantics, and Simplification Specification

#### 4.1 Determinism Across Input Reordering & Node Identity Rules
1. **Canonical Input Sorting**:
   - Before registering vertices in `TopologicalNodeIndex` or creating edges, `roadParts` and `railwayParts` are sorted deterministically by:
     1. Vertical scope key `(layer, isBridge ? 1 : 0, isTunnel ? 1 : 0)`,
     2. `sourceFeatureId` (standard UTF-16 code-unit comparison),
     3. `partIndex` (ascending integer),
     4. Initial vertex coordinates `(points[0][0], points[0][1], points[1][0], points[1][1])`.
   - **Guarantee**: Reordering the input `GeoJSON.features` array produces the exact same canonical node IDs, fallback node centroids, simplified edge orientations, `parallelIndex` assignments, and provenance arrays.
2. **Three-Part Node Identity Separation**:
   - **Explicit OSM Node (`nodeIdOrigin: 'explicit_osm'`)**: Has a defined `rawOsmNodeId` (e.g. `"5001"`) and canonical ID `${network}_node:${scope}:osm_${rawOsmNodeId}`. Two vertices with distinct `rawOsmNodeId` values (`"5001" !== "5002"`) **never** merge, even at `0.00 m` distance.
   - **Coordinate Fallback Node (`nodeIdOrigin: 'coordinate_fallback'`)**: Created when `rawOsmNodeId` is `undefined` and no existing node in the same domain and vertical scope lies within `DEFAULT_NODE_SNAP_TOLERANCE_METERS = 0.15` (`15 cm`). Assigned canonical ID `${network}_node:${scope}:fb_${seq}` (deterministic because inputs are canonically sorted prior to registration). If an explicit OSM node in the same domain and vertical scope lies within `0.15 m`, the coordinate-only vertex resolves to that explicit node's canonical ID (`nodeIdOrigin: 'explicit_osm'`). If multiple distinct explicit OSM nodes lie within `0.15 m` of a coordinate-only vertex, it snaps to the strictly closest one, breaking exact distance ties by lexicographically smallest `rawOsmNodeId`.
   - **Boundary-Clipped Node (`nodeIdOrigin: 'boundary_clip'`)**: Any endpoint where `clippedAtStart` or `clippedAtEnd` is `true` and `rawOsmNodeId` is `undefined` receives a unique, non-snapping node ID `${network}_node:${scope}:clip_${partId}_${endpoint}`. It is never merged with any other way's boundary-clipped or fallback node.

#### 4.2 Interior Node Splitting, Self-Loops, and Multi-Edge Adjacency
1. **True Network Split Nodes vs. Ordinary Polyline Shape Vertices**:
   - Within each domain (`road` vs. `railway`) and vertical scope, a vertex is a **topological split node** if and only if:
     - It is the start (`0`) or end (`N - 1`) vertex of any part, **or**
     - Its total vertex occurrence count across all parts in the domain/vertical scope—counting multiple occurrences within the **same** part separately—is $\ge 2$, **or**
     - It matches an explicit cross-infrastructure node (`railway=level_crossing`, `railway=crossing`, `railway=railway_crossing`, `railway=switch`, or `highway=crossing`).
   - All other interior vertices (occurrence count $=== 1$ and not a way endpoint or tagged infrastructure node) remain **ordinary polyline shape vertices** inside their edge's `points` array.
2. **P-Loops and Isolated Closed Loops**:
   - **P-Loop**: Because repeated vertices within the same way part are counted per occurrence (`occurrenceCount >= 2` rather than deduplicated via `new Set(keys)`), a way whose endpoint meets one of its own interior vertices splits at that shared vertex into a stem edge (`u -> v`) and a closed-loop edge (`v -> v`, `isClosedLoop: true`), giving node `v` `degree === 3`.
   - **Isolated Closed Ring**: If a closed ring (`points[0] === points[N - 1]`) has no incident external branches (all vertices have degree 2), a single deterministic anchor vertex (the vertex with the lexicographically smallest `rawOsmNodeId`, or minimum `(x, z)` if untagged) is retained with role `'loop_anchor'` so the closed loop is preserved as a single `isClosedLoop: true` edge (`degree === 2` at the anchor node) rather than discarded.
3. **Multi-Edge Adjacency & Self-Loop Degree Invariant**:
   - Every `RoadNode` and `RailwayNode` maintains both:
     - `incidentHalfEdges: readonly IncidentHalfEdge[]` — contains one entry per attached edge endpoint (`'start'` or `'end'`). A closed self-loop edge (`fromNodeId === toNodeId`) contributes **two** entries to `incidentHalfEdges` (`endpoint: 'start'` and `endpoint: 'end'`) and therefore contributes **`+2` to `node.degree`** (`node.degree === node.incidentHalfEdges.length`).
     - `incidentEdgeIds: readonly string[]` — deduplicated, canonically sorted unique edge IDs. A self-loop edge ID appears **once** in `incidentEdgeIds`.

#### 4.3 OSMnx-Style Degree-2 Simplification, One-Way Preservation, and Provenance
1. **When a Degree-2 Node Is Simplified vs. Retained**:
   - A node $v$ with `degree === 2` incident to two distinct edges $e_1 \neq e_2$ is contracted into a single simplified edge if and only if:
     - $v$ does **not** hold any of the roles `'grade_transition'`, `'level_crossing'`, `'highway_crossing'`, `'switch'`, `'railway_crossing'`, `'boundary_clip'`, or `'loop_anchor'`.
     - $e_1$ and $e_2$ share identical vertical scope (`layer`, `isBridge`, `isTunnel`).
     - **For Roads**: $e_1$ and $e_2$ have identical `(roadClass, tier, Math.round(width * 10), isCulvert, nameKey, lanes)` **and** compatible one-way semantics:
       - If both edges are `'bidirectional'` and have identical `rawOnewayTag` (both `undefined` or both `'no'`), they may be concatenated (reversing one part's vertex order if they meet start-to-start or end-to-end, while setting `reversedRelativeToSource: true` on its `EdgeSegmentProvenance`).
       - If either edge has `normalizedOneway !== 'bidirectional'`, they may be merged **only** if both have the exact same `rawOnewayTag` and `normalizedOneway`, **and** their directed flow across $v$ is continuous without reversing either edge (`e1.toNodeId === v && e2.fromNodeId === v`). Otherwise $v$ is retained and assigned role `'attribute_break'`.
     - **For Railways**: $e_1$ and $e_2$ have identical `(railwayType, Math.round(width * 10), gauge, electrified, service, usage, isSecondaryBranch)`.
2. **Unambiguous Segment Provenance After Reversal and Simplification**:
   - Each simplified edge orientates its `fromNodeId -> toNodeId` direction deterministically (preserving directed flow for one-way edges; for bidirectional edges, orienting from the lexicographically smaller endpoint node ID to the larger endpoint node ID, or by initial tangent angle for self-loops).
   - Every `EdgeSegmentProvenance` entry in `edge.provenance.segments` records:
     - `startVertexIndex`, `endVertexIndex`, `startArcLength`, `endArcLength` in the **parent simplified edge's** `fromNodeId -> toNodeId` coordinate order ($0 = \text{segments}[0].\text{startArcLength} < \dots < \text{segments}[k-1].\text{endArcLength} = \text{edge.lengthMeters}$).
     - `sourceStartVertexIndex`, `sourceEndVertexIndex` in the **original `UnchainedRoadPart` / `UnchainedRailwayPart`**, along with `reversedRelativeToSource: boolean` (`true` iff `sourceStartVertexIndex > sourceEndVertexIndex`).
3. **Parallel Multi-Edges (`parallelIndex`)**:
   - Distinct simplified edges connecting the same unordered node pair `{u, v}` are never collapsed together. They are sorted deterministically by `(min(sourceFeatureIds), startInwardTangentAngle, lengthMeters, primaryPartId)` and assigned `parallelIndex = 0, 1, ..., k - 1`.

---

### 5. Railway Crossing and Switch Semantics (`Stage C` & `Stage D`)

M2.3 explicitly distinguishes all five OSM crossing and switch concepts without implementing train routing or switch simulation:

| OSM Tag / Concept | Network Scope | Meaning & Graph Representation in M2.3 |
| :--- | :--- | :--- |
| **`railway=switch`** | `RailwayNetwork` | Physical railway turnout allowing a branch relationship (`1-to-2` throat topology). Represented as a `RailwayNode` with role `'switch'` and a `TurnoutTopologySpec`. |
| **`railway=railway_crossing`** | `RailwayNetwork` + `railwayFlatCrossings` | Rail-over-rail flat diamond crossing **without** switching capability (`2-to-2` non-interconnecting tracks). Does **not** create a switch or interchangeable branch junction. |
| **`railway=level_crossing`** | `RoadNetwork` $\times$ `RailwayNetwork` (`levelCrossings`) | At-grade **vehicular road** crossing a railway (`crossingKind: 'road_rail_level_crossing'`). Road and railway remain in their separate networks; linked via `LevelCrossingRelation`. |
| **`railway=crossing`** | `RoadNetwork` $\times$ `RailwayNetwork` (`levelCrossings`) | At-grade **pedestrian/path/cycleway** crossing a railway (`crossingKind: 'pedestrian_rail_crossing'`). Linked via `LevelCrossingRelation`. |
| **`highway=crossing`** | `RoadNetwork` | Pedestrian crosswalk node on a road (`RoadNode` role `'highway_crossing'` with preserved `pointOsmTags`, e.g. `crossing=zebra`, `crossing:markings=*`). |

#### 5.1 Representing Non-Interconnecting Railway Crossings (`railway=railway_crossing`)
A degree-4 railway node must **never** automatically be treated as an interchangeable junction or double-slip switch:
1. **Shared Interior Vertex on Two Crossing Railway Ways**:
   - When two railway ways share a common interior OSM vertex that is either tagged `railway=railway_crossing` or consists of two collinear through-tracks crossing at an angle ($|\vec{t}_A \cdot \vec{t}_B| < \cos(10^\circ)$) without a `railway=switch` (`railway:switch=double_slip | single_slip`) tag:
   - The two tracks are **not** welded into an interchangeable 4-branch junction node. Each track remains continuous across its own through-path (receiving its own track-scoped node or remaining unsplit if degree-2 compatible along its own track), and a **`RailwayFlatCrossingRelation`** is emitted recording `rawOsmNodeId`, `position`, `trackAEdgeId`, `trackAArcLengthMeters`, `trackBEdgeId`, `trackBArcLengthMeters`, and `crossingAngleRad`.
2. **Four Separate Railway Way Endpoints Meeting at One Node**:
   - If 4 separate railway way parts terminate at a shared OSM node:
     - If tagged `railway=railway_crossing`, opposite collinear pairs `(A1, A2)` and `(B1, B2)` ($\vec{t}_{\text{inward}, 1} \cdot \vec{t}_{\text{inward}, 2} \le -\cos(15^\circ)$) are paired along their respective continuous tracks, the node is assigned role `'railway_crossing'` (not `'switch'`), and a `RailwayFlatCrossingRelation` is recorded.
     - If untagged or tagged with complex slip-switch tags where branch interchange cannot be disambiguated from a flat crossing, the node is retained in `RailwayNetwork` with `primaryRole: 'junction'` (`roles: ['junction']`) and counted in `diagnostics.railwayUnresolvedJunctionCount` + `diagnostics.unresolvedCrossings` (`reason: 'missing_railway_crossing_tag_at_degree_4_node'`).

#### 5.2 Conservative Turnout (`railway=switch`) Trunk / Main / Diverging Inference
At a degree-3 `RailwayNode` (with half-edges $h_0, h_1, h_2$ and inward unit tangents $\vec{t}_0, \vec{t}_1, \vec{t}_2$):
1. **Throat Verification (`1-to-2` Split)**:
   - A degree-3 node forms a valid `1-to-2` turnout throat if and only if exactly one half-edge $h_{\text{trunk}}$ opposes both other half-edges $h_a, h_b$ ($\vec{t}_{\text{trunk}} \cdot \vec{t}_a \le -\cos(45^\circ) \approx -0.707$ and $\vec{t}_{\text{trunk}} \cdot \vec{t}_b \le -0.707$), while $h_a$ and $h_b$ point into the same forward hemisphere ($\vec{t}_a \cdot \vec{t}_b \ge \cos(60^\circ) = 0.5$).
   - If this geometric throat invariant fails, `turnoutTopology` is set to `{ status: 'unresolved_throat', candidateEdgeIds }` and `diagnostics.railwayUnresolvedSwitchCount` is incremented.
2. **Main vs. Diverging Branch Disambiguation**:
   - Given a verified `trunkEdgeId`, let $\delta_a = \arccos(\text{clamp}(-\vec{t}_{\text{trunk}} \cdot \vec{t}_a, -1, 1))$ and $\delta_b = \arccos(\text{clamp}(-\vec{t}_{\text{trunk}} \cdot \vec{t}_b, -1, 1))$ be the deflection angles of branches $a$ and $b$ from the straight trunk continuation:
     - If one branch is a mainline (`!isSecondaryBranch`) and the other is a secondary branch (`isSecondaryBranch`, e.g. `service=siding|yard|spur|crossover`), and the mainline branch deflection does not exceed the secondary branch deflection by more than $5^\circ$, the mainline is `mainBranchEdgeId` and the secondary branch is `divergingBranchEdgeId` (`status: 'confirmed'`).
     - Otherwise, if $|\delta_a - \delta_b| \ge 3^\circ$ ($0.052\text{ rad}$), the straighter branch ($\min(\delta_a, \delta_b)$) is `mainBranchEdgeId` and the more deflected branch is `divergingBranchEdgeId` (`status: 'confirmed'`).
     - If both branches have identical secondary/main rank and nearly symmetric deflection ($|\delta_a - \delta_b| < 3^\circ$, a symmetric Y-switch without distinguishing tags), `turnoutTopology` is set to `{ status: 'unresolved_main_vs_diverging', trunkEdgeId, candidateEdgeIds }` and `diagnostics.railwayUnresolvedSwitchCount` is incremented.

---

### 6. Tightened Grade-Transition and Level-Crossing Inference (`Stage D`)

#### 6.1 Grade-Transition Matching (`GradeTransitionRelation` vs. `UnresolvedGradeTransitionCandidate`)
Grade transitions connect an at-grade edge endpoint (`!isBridge && !isTunnel`) and a bridge or tunnel edge endpoint (`isBridge || isTunnel`) within the same network domain (`road` or `railway`).

1. **Explicit Directed Tangent Definition**:
   - For any edge endpoint $p \in \{\text{'start'}, \text{'end'}\}$, let $\vec{t}_{\text{inward}}(e, p)$ be the unit tangent pointing from the endpoint **into the interior of edge $e$** (`startInwardTangent` for `'start'`, `endInwardTangent` for `'end'`).
   - Across a valid portal between an at-grade edge $(e_{\text{ag}}, p_{\text{ag}})$ and a grade-separated structure edge $(e_{\text{gs}}, p_{\text{gs}})$, continuous travel exits one edge and enters the other, so their inward tangents must point in **opposite** directions. Define:
     $$\text{continuousTraversalDot} = (-\vec{t}_{\text{inward}}(e_{\text{ag}}, p_{\text{ag}})) \cdot \vec{t}_{\text{inward}}(e_{\text{gs}}, p_{\text{gs}}) = -(\vec{t}_{\text{inward}}(e_{\text{ag}}, p_{\text{ag}}) \cdot \vec{t}_{\text{inward}}(e_{\text{gs}}, p_{\text{gs}}))$$
   - A collinear continuation has $\text{continuousTraversalDot} \approx +1.0$, whereas a parallel loopback / adjacent U-turn road entering from the same side has $\text{continuousTraversalDot} \approx -1.0$ and is **rejected** (unlike an unsigned $|\text{dot}|$ check).
2. **Tier 1 — Explicit Shared OSM Node (`confidence: 'explicit_osm_node'`)**:
   - Both $(e_{\text{ag}}, p_{\text{ag}})$ and $(e_{\text{gs}}, p_{\text{gs}})$ have the exact same defined `rawOsmNodeId`, compatible domain/tier (`RoadTier` for roads; `RailwayType` for railways), and $\text{continuousTraversalDot} \ge \cos(60^\circ) = 0.5$.
   - If multiple at-grade branches share that explicit OSM node (e.g., an intersection directly at the foot of a bridge), the at-grade edge with the maximum $\text{continuousTraversalDot} \ge 0.5$ is linked, provided the best match exceeds any runner-up by at least $0.10$; otherwise it is recorded as `UnresolvedGradeTransitionCandidate` (`reason: 'ambiguous_multiple_candidates'`).
3. **Tier 2 — Conservative `0.15 m` Coordinate Fallback (`confidence: 'coordinate_fallback_confirmed'`)**:
   - Considered **only** when at least one of the two endpoints lacks a `rawOsmNodeId` (if both have distinct `rawOsmNodeId`s, they are immediately rejected with `reason: 'distinct_explicit_osm_nodes'`).
   - Uses only the existing `DEFAULT_NODE_SNAP_TOLERANCE_METERS = 0.15` (`15 cm`) threshold—no `0.65 m` or `0.80 m` automatic connection radius is permitted.
   - All of the following guards must hold simultaneously:
     1. Euclidean distance $d \le 0.15\text{ m}$.
     2. Both endpoints are unclipped **terminal (`degree === 1`)** nodes within their respective scopes (`!isBoundaryClipped`).
     3. Compatible domain and tier/class (`e_ag.tier === e_gs.tier` for roads).
     4. Directed tangent alignment $\text{continuousTraversalDot} \ge \cos(30^\circ) \approx 0.866$.
     5. **Uniqueness (No Arbitrary Tie-Breaking)**: Exactly **one** candidate endpoint satisfies rules (1)–(4) within `0.15 m`. If $\ge 2$ candidates exist within `0.15 m`, none is connected and an `UnresolvedGradeTransitionCandidate` (`reason: 'ambiguous_multiple_candidates'`) is emitted.
   - Any unshared endpoint pair with $0.15\text{ m} < d \le 0.80\text{ m}$ (the legacy renderer scan radius) is never connected; it is logged as an `UnresolvedGradeTransitionCandidate` (`reason: 'exceeds_snap_tolerance'`) for diagnostic visibility.

#### 6.2 Confirmed vs. Candidate Road/Rail Crossings
1. **Confirmed `LevelCrossingRelation`**:
   - Created **only** when an at-grade `RoadEdge` and an at-grade `RailwayEdge` on the same `layer` share:
     - The same explicit `rawOsmNodeId` at a vertex (`confidence: 'shared_explicit_osm_node'`, upgraded to `'explicit_osm_crossing_tag'` if an ingested `railway=level_crossing` or `railway=crossing` point feature also matches that `rawOsmNodeId`), **or**
     - An ingested `railway=level_crossing` or `railway=crossing` point feature whose `rawOsmNodeId` matches a vertex on one way and whose position lies within `0.15 m` of the other way (`confidence: 'explicit_osm_crossing_tag'`).
   - Classified as `crossingKind: 'pedestrian_rail_crossing'` when `roadEdge.tier === 'path'` or the point tag is `railway=crossing`, and `'road_rail_level_crossing'` when `roadEdge.tier === 'vehicular'` or tagged `railway=level_crossing`.
2. **Unconfirmed `UnresolvedCrossingCandidate`**:
   - If an at-grade road and at-grade railway on the same `layer` intersect geometrically in 2D $(X, Z)$ or share a `0.15 m` coordinate-only vertex **without** a shared `rawOsmNodeId` or explicit OSM crossing point feature, they do **not** produce a `LevelCrossingRelation`. Instead, an `UnresolvedCrossingCandidate` is recorded in `diagnostics.unresolvedCrossings`.

---

### 7. Renderer Integration Boundary (`Stage E`)

1. **Stages B–D Isolation**:
   - Stages B, C, and D construct and unit-test `InfrastructureGraph` from `ProcessedMapData.topologySource` without altering `GeometryBuilder.ts`, `RailwayGeometryBuilder.ts`, or `mapData.roads`.
2. **Stage E Renderer Migration**:
   - In Stage E, `GeometryBuilder` Stage 6 road junction trimming and bridge/tunnel portal matching consume `InfrastructureGraph.roads` and `InfrastructureGraph.gradeTransitions` (and `diagnostics.featureLineage.chainingMap` is populated from `RoadEdge.provenance`), while `RoadNode`s whose only multi-edge interaction is `isCrossTier: true` (`vehicular` vs. `path`) do not trigger vehicular carriageway asphalt trimming (preserving `ADR-0002` and 2D carriageway-vs-path Boolean clipping).

---

## Alternatives Considered

1. **Build the Graph Directly From Already-Chained `mapData.roads`**:
   - *Description*: Pass the existing `ProcessedMapData.roads` array (after `chainContiguousRoads`) into `RoadNetworkBuilder`.
   - *Pros*: Zero changes to `LocalGeoJsonProvider.ts`.
   - *Cons / Why Rejected*: `chainContiguousRoads` destructively mutates `RoadFeature`s in place—reversing point arrays across opposing one-way ways, dropping secondary way `osmTags`, chaining across shared road/rail level-crossing nodes, and erasing per-part boundary-clip provenance. Capturing `ProcessedMapData.topologySource` prior to `chainContiguousRoads` is minimal and non-destructive.

2. **Treat Every Degree-4 Railway Node as an Interchangeable Switch / Crossover**:
   - *Description*: Classify any degree-4 node in `RailwayNetwork` as a switchable crossover.
   - *Pros*: Simple degree check.
   - *Cons / Why Rejected*: Confuses non-interconnecting flat diamond crossings (`railway=railway_crossing`) with switches (`railway=switch`), creating false track-to-track connectivity where rails only cross physically at grade.

3. **Retain the Legacy `0.65 m` / `0.80 m` Proximity Radius for Automatic Grade Transitions**:
   - *Description*: Automatically connect any at-grade road/rail endpoint within `0.65 m` or `0.80 m` of a bridge/tunnel endpoint using `|dot| >= 0.7`.
   - *Pros*: Tolerates large coordinate gaps in hand-edited GeoJSON.
   - *Cons / Why Rejected*: Falsely connects nearby cross-streets, parallel footpaths, or U-turn loopbacks (`dot <= -0.7` when unsigned). Restricting automatic fallback to `0.15 m` with signed `continuousTraversalDot >= 0.866`, terminal `degree === 1` endpoints, and uniqueness checks prevents false connections while surfacing wider gaps in `diagnostics.unresolvedGradeTransitions`.

---

## Consequences and Trade-Offs

### Positive
- Preserves 100% of pre-chaining per-way `osmTags`, `oneway` directionality, and boundary-clipping provenance via `ProcessedMapData.topologySource` without regressing legacy `mapData.roads` consumers during Stages B–D.
- Accurately distinguishes `railway=switch`, `railway=railway_crossing`, `railway=level_crossing`, `railway=crossing`, and `highway=crossing`.
- Replaces silent proximity guesses with explicit confidence levels and diagnostic candidate queues (`UnresolvedGradeTransitionCandidate`, `UnresolvedCrossingCandidate`, `TurnoutClassificationStatus`).
- Zero external runtime dependencies.

### Negative / Neutral
- Adding `topologySource` to `ProcessedMapData` requires shallow-cloning `RoadFeature` records before `chainContiguousRoads` runs in `LocalGeoJsonProvider.parseGeoJson()`.
- Graph construction has $O(V \log V + E)$ complexity (dominated by canonical input sorting and grid-indexed lookup); actual execution time must be measured via reproducible benchmarks against the repository's synthetic and real OSM fixtures (`Station Hengelo`, `Amsterdam Centraal`) during Stages B–E rather than assumed from unmeasured estimates.

---

## Recommended Resolutions to Open Questions (`Proposed` — Pending Project-Owner Sign-Off)

1. **Non-Destructive Pre-Chaining Input vs. Legacy `mapData.roads` (Stages B–D vs. Stage E)**:
   - *Recommended Resolution*: Preserve `LocalGeoJsonProvider.parseGeoJson()`'s existing `mapData.roads` output unchanged during Stages B–D so all 92 existing tests remain untouched, and attach a separate, non-destructive `mapData.topologySource: TopologySourceData` collection captured prior to `chainContiguousRoads` for `buildInfrastructureGraph`.
2. **Explicit Per-Vertex OSM Node ID Preservation in `server.ts` and `LocalGeoJsonProvider.ts`**:
   - *Recommended Resolution*: Preserve explicit per-vertex OSM node IDs for live Overpass JSON (`way.nodes`) and OSM 0.6 XML fallback (`<nd ref="...">`) responses when the node reference count aligns 1:1 with the extracted geometry coordinates. Handle `MultiLineString` and `clipPolylineToBox` split parts carefully by propagating vertex node IDs only where vertex alignment is exact, without claiming 100% ID recovery a priori, and keep the conservative `0.15 m` coordinate fallback when explicit IDs are absent.
3. **Cross-Tier (`vehicular` vs. `path`) Road/Path Topology**:
   - *Recommended Resolution*: Represent shared nodes between `vehicular` and `path` ways in `RoadNetwork` (`roles` containing `'cross_tier'`, `isCrossTier: true`, and `'highway_crossing'` where tagged) without automatically altering Stage 6 vehicular asphalt junction polygon trimming (`ADR-0002`), leaving carriageway-vs-path 2D Boolean clipping responsible for visual surface layering.

---

## Related Source Modules

- `src/world/TopologicalNodeIndex.ts`
- `src/world/LocalGeoJsonProvider.ts`
- `src/world/FeatureCatalogue.ts`
- `src/world/GeometryBuilder.ts`
- `src/world/infrastructure/railways/RailwayTopology.ts`
- `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`
- `src/types/MapFeature.ts`
- `server.ts`
- `src/world/infrastructure/topology/*` *(planned for Stages B–E)*

---

## Tests and Evidence (Planned Acceptance Fixtures for Stages B–E)

All graph stages will be verified using Node's built-in test runner via `tsx --test` (`npm test`), plus a reproducible graph-construction benchmark across synthetic and real OSM extracts:

1. **T-01 (`Degree-2 Simplification With Curved Polyline & Reversed Segment Provenance`)**: 3 contiguous curved road ways (with the middle way digitized in reverse order and `oneway` omitted/`bidirectional`) simplify into 1 `RoadEdge` preserving all intermediate curve vertices, where `provenance.segments[1]` has `reversedRelativeToSource === true`, unambiguous `startArcLength`/`endArcLength`, and preserved per-segment `osmTags`.
2. **T-02 (`True T-Junction vs. Ordinary Bend Vertex`)**: A main road with 5 interior curve vertices where a side street connects only at vertex 2 splits *only* at vertex 2 (`degree === 3`, `roles: ['junction']`), keeping vertices 1, 3, 4 as internal shape vertices.
3. **T-03 (`4-Way Shared-Node Road Intersection & Multi-Role Node`)**: Two roads sharing a central OSM node that is also tagged `highway=crossing` split into 4 incident `RoadEdge`s at a single `RoadNode` with `degree === 4` and non-exclusive `roles: ['highway_crossing', 'junction']`.
4. **T-04 (`Unconnected 2D Geometric Crossing — Overpass & Unshared Same-Layer Crossing`)**: Two roads crossing at `(0, 0)` on `layer=0` vs. `layer=1` produce `1` `GradeSeparatedCrossingRelation`; two same-layer roads crossing in 2D without a shared vertex produce `0` junction nodes and `1` `UnresolvedCrossingCandidate` (`reason: 'geometric_intersection_without_shared_node'`).
5. **T-05 (`Interior Node Split Where Side Road Meets Main Road Mid-Way`)**: Side road endpoint sharing explicit `rawOsmNodeId: "200"` with an interior vertex of a main road splits the main road into 2 edges at a degree-3 junction node.
6. **T-06 (`Parallel Edges Between Same Two Nodes & Input-Order Determinism`)**: A main road and a crescent loop connecting the same nodes `(u, v)` produce 2 distinct `RoadEdge`s with `parallelIndex: 0` and `parallelIndex: 1`; shuffling the input feature array produces identical node IDs, edge IDs, and `parallelIndex` assignments.
7. **T-07 (`Self-Loop and P-Loop Handling — Half-Edge Degree Invariant`)**: A P-loop where way endpoint `points[N-1]` reconnects to interior vertex `points[2]` splits into 1 stem edge (`u -> v`) and 1 closed-loop edge (`v -> v`, `isClosedLoop: true`), where node `v` has `degree === 3`, `incidentHalfEdges.length === 3`, and `incidentEdgeIds.length === 2`. An isolated closed loop retains a deterministic `'loop_anchor'` node (`degree === 2`, `incidentEdgeIds.length === 1`, `incidentHalfEdges.length === 2`).
8. **T-08 (`Attribute & One-Way Discontinuity Blocks Degree-2 Simplification`)**: Contiguous ways meeting at a degree-2 node with different `roadClass`, different `width`, opposing `oneway` directions (`oneway=yes` meeting `oneway=-1`), or unusual `oneway=reversible` tags are **not** merged (`roles: ['attribute_break']`), and `rawOnewayTag` is preserved verbatim.
9. **T-09 (`Explicit OSM Node ID Precedence Over Coordinate Fallback`)**: Two vertices at `(10, 10)` with distinct `rawOsmNodeId` `"1"` and `"2"` remain 2 separate nodes (`nodeIdOrigin: 'explicit_osm'`), whereas an untagged vertex at `(10.05, 10.05)` within `0.15 m` resolves deterministically to `"1"`.
10. **T-10 (`Boundary-Clipped Endpoints Excluded From False Junction Snapping`)**: Two converging roads clipped by `clipPolylineToBox` within `0.10 m` of each other on the `+clipExtent` boundary receive distinct `nodeIdOrigin: 'boundary_clip'` nodes and never merge.
11. **T-11 (`Confirmed Railway Turnout Switch vs. Ambiguous Y-Split`)**: A mainline and siding meeting at `railway=switch` (`rawOsmNodeId: "900"`) with a clear `1-to-2` throat produces a `RailwayNode` with `roles: ['switch']` and `turnoutTopology.status === 'confirmed'` (`trunkEdgeId`, `mainBranchEdgeId`, `divergingBranchEdgeId`). A symmetric untagged Y-split produces `turnoutTopology.status === 'unresolved_main_vs_diverging'` and increments `diagnostics.railwayUnresolvedSwitchCount`.
12. **T-12 (`Railway Diamond Flat Crossing Without Switching Capability`)**: Two railway tracks sharing an interior node tagged `railway=railway_crossing` (`rawOsmNodeId: "950"`) produce `1` `RailwayFlatCrossingRelation` and `0` switch nodes, without allowing branch interchange between the two crossing tracks. An untagged degree-4 endpoint meeting is flagged in `diagnostics.railwayUnresolvedJunctionCount`.
13. **T-13 (`Vehicular Road/Rail Level Crossing vs. Pedestrian/Rail Crossing vs. Unconfirmed Proximity`)**:
    - Vehicular road + rail sharing `rawOsmNodeId: "700"` (tagged `railway=level_crossing`) $\to$ `LevelCrossingRelation` with `crossingKind: 'road_rail_level_crossing'`, preserving the crossing node against degree-2 simplification (`roles` includes `'level_crossing'`).
    - Footpath (`highway=footway`) + rail sharing `rawOsmNodeId: "701"` (tagged `railway=crossing`) $\to$ `LevelCrossingRelation` with `crossingKind: 'pedestrian_rail_crossing'`.
    - Coincident untagged road and rail vertices without shared `rawOsmNodeId` $\to$ `0` `LevelCrossingRelation`s and `1` `UnresolvedCrossingCandidate` (`reason: 'coincident_vertex_without_osm_id'`).
14. **T-14 (`Road Overpass Above Railway — Grade-Separated Crossing`)**: A road with `bridge=yes, layer=1` crossing above an at-grade railway (`layer=0`) generates `0` `LevelCrossingRelation`s and `1` `GradeSeparatedCrossingRelation`.
15. **T-15 (`Conservative Grade Transitions — Directed Tangents, Ambiguity & Proximity Rejection`)**:
    - Shared `rawOsmNodeId` between collinear at-grade and bridge road endpoints $\to$ `1` `GradeTransitionRelation` (`confidence: 'explicit_osm_node'`).
    - Untagged terminal endpoints `0.10 m` apart with $\text{continuousTraversalDot} \ge 0.866$ and unique match $\to$ `1` `GradeTransitionRelation` (`confidence: 'coordinate_fallback_confirmed'`).
    - Parallel loopback edge (`continuousTraversalDot <= -0.866`), perpendicular cross-street `0.50 m` away, or two ambiguous parallel candidates within `0.15 m` $\to$ `0` `GradeTransitionRelation`s and `1` `UnresolvedGradeTransitionCandidate`.
16. **T-16 (`Pre-Chaining Handoff & Stage E Renderer Non-Regression`)**: Verifies that `ProcessedMapData.topologySource` preserves unchained parts while `mapData.roads` remains compatible during Stages B–D, and in Stage E all 92 existing tests pass with zero coplanar overlap or portal regressions.

---

## Superseded or Related Decisions

- **Related to**:
  - [ADR-0002: Boundary-Derived Road Junction Polygon Synthesis and Coplanar Overlap Resolution](./ADR-0002-boundary-derived-road-junction-meshing.md)
  - [ADR-0003: Loaded Region Boundary Clipping and Bounded Scene Sizing](./ADR-0003-loaded-region-boundary-clipping.md)
  - [ADR-0004: Grade-Separated Infrastructure, Elevation Policy, and Bridge/Culvert Disambiguation](./ADR-0004-grade-separated-infrastructure-and-elevation-policy.md)
  - [ADR-0005: Source-Feature Provenance Tracking and Diagnostic Accounting](./ADR-0005-source-feature-provenance-and-diagnostics.md)
  - [ADR-0008: Hybrid Railway Rendering, Multi-Interval Turnout Support, and UV-Ribbon Architecture](./ADR-0008-hybrid-railway-rendering-and-uv-ribbon-architecture.md)
