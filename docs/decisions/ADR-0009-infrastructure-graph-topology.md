# ADR-0009: Infrastructure Graph Topology, Domain Contracts, and Simplification Architecture

## Metadata

- **Decision ID**: `ADR-0009`
- **Status**: `Proposed` *(Stage A Architecture — Pending Project Owner Review prior to Stage B implementation)*
- **Date**: `2026-11-05`
- **Deciders**: Project Owner, Architecture & Rendering Engineering
- **Consulted**: OSMnx Conceptual Reference (`osmnx.simplification`, `osmnx.graph`), Goalpost 1 & M2.1/M2.2 Codebase Audit (`TKT-003`)

---

## Context and Problem

Milestone 2.3 (`M2.3: Infrastructure Topology and Connectivity`) establishes a clean, deterministic, pure-TypeScript infrastructure topology layer between GeoJSON feature parsing (`LocalGeoJsonProvider`) and 3D procedural geometry synthesis (`GeometryBuilder`, `RailwayGeometryBuilder`, and future `M2.4` surface markings).

### 1. Conceptual Distinction: Three Levels of Infrastructure Relationship

A core requirement of M2.3 is separating three distinct concepts that are currently conflated across ingestion and rendering heuristics:

1. **Geometric Intersection (2D Planimetric Crossing / Proximity)**:
   - Two polyline segments cross or pass near each other in the horizontal $(X, Z)$ plane (e.g., an elevated bridge passing over an at-grade street, a subterranean tunnel passing beneath a rail yard, or an unsplit footpath crossing a carriageway).
   - **Rule**: Planimetric crossing or spatial proximity alone **never** implies physical connectivity unless explicitly authorized by shared node topology or bounded fallback rules in the same domain and vertical scope.
2. **Physical / Topological Connectivity (M2.3 Primary Scope)**:
   - Two or more infrastructure segments share a physical junction, switch/turnout, grade-transition portal (`at_grade <-> bridge` or `at_grade <-> tunnel`), or at-grade road/rail level crossing.
   - Represented by explicit graph nodes (`RoadNode`, `RailwayNode`), simplified polyline edges (`RoadEdge`, `RailwayEdge`), and typed cross-infrastructure relations (`GradeTransitionRelation`, `LevelCrossingRelation`, `GradeSeparatedCrossingRelation`).
3. **Traversability / Movement Permissions (Downstream Metadata Only)**:
   - Legal routing rules (`oneway`, `access`, turn restrictions, signaling).
   - **Rule**: M2.3 preserves directional and lane attributes (`oneway`, `lanes`, `reversed`) on graph edges so downstream `M2.4` lane/arrow markings and future consumers have accurate orientation metadata, **without** implementing pathfinding, turn-restriction enforcement, traffic simulation, or agent movement.

---

### 2. Source Audit of Current Codebase (`M2.3-A` Step 1 Findings)

An exhaustive audit of the current codebase (`LocalGeoJsonProvider.ts`, `FeatureCatalogue.ts`, `TopologicalNodeIndex.ts`, `GeometryBuilder.ts`, `RailwayTopology.ts`, `RailwayGeometryBuilder.ts`, `BridgeAndTunnelBuilder.ts`, `ElevationPolicy.ts`, and `server.ts`) identified both reusable foundations and material architectural gaps:

#### 2.1 Reusable Foundations
- **`TopologicalNodeIndex` (`src/world/TopologicalNodeIndex.ts`)**:
  - Provides a fast $O(1)$ spatial grid (`cellSize = 0.15 m`, `DEFAULT_NODE_SNAP_TOLERANCE_METERS = 0.15`) and explicit OSM node ID registry (`${layerScope}|osm_${cleanId}` vs. fallback `tn_${layerScope}_${counter}`).
  - Enforces non-merging of distinct explicit OSM node IDs (`osm_A !== osm_B` even at distance `0.00 m`, lines 89–93).
  - Supports retroactive promotion of a fallback node (`tn_...`) to an explicit node (`osm_...`) when an explicit node arrives later within `0.15 m` in the same `layerScope`, recording aliases in `fallbackToExplicitAlias` and resolving them via `resolveCanonicalNodeId()`.
- **Source Provenance & Lineage Accounting (`ADR-0005`, `src/types/MapFeature.ts`, `src/world/LocalGeoJsonProvider.ts`)**:
  - `RoadFeature` and `RailwayFeature` preserve `id`, `sourceFeatureId`, `sourceFeatureIds: string[]`, and `nodeIds?: (string | number | undefined)[]`.
  - `diagnostics.featureLineage` records `deduplicatedMap` and `chainingMap` for end-to-end feature auditability.
- **Boundary-Derived Road Junction Trimming (`ADR-0002`, `src/world/GeometryBuilder.ts` Stage 6)**:
  - The geometric portal-trimming math (`computePolylineSubsegment`, adjacent boundary ray-cast intersection, radial miter clamping, and `RoadPortalConnectionSpec`) is mature and verified by 92 automated tests, but currently relies on an ad-hoc inline node-clustering and splitting pass inside `GeometryBuilder.ts`.
- **Railway Spatial Indexing & Phase Continuity (`ADR-0008`, `src/world/infrastructure/railways/RailwayTopology.ts`)**:
  - `HostTrackSpatialIndex` (`8 m x 8 m` spatial grid), `sortRailwaysMainlineFirst`, `computeContinuousTrackPhases`, and `isTurnoutThroatPair` provide proven geometric utilities for sleeper placement and clipping, but currently operate without a topological railway graph.

#### 2.2 Material Gaps Discovered in Source Audit

| # | Focus Area | Observed Source Behavior | Architectural Gap / Risk |
| :--- | :--- | :--- | :--- |
| **G1** | **Per-Vertex OSM Node ID Survival (`server.ts` & `LocalGeoJsonProvider.ts`)** | `LocalGeoJsonProvider.extractRawOsmNodeIds` (lines 401–406) reads `props.nodes`, `props.nodeIds`, or `props._nodeIds`. However, `server.ts` (lines 159, 182) calls `osmtogeojson(overpassJson)` with default options, which strips OSM way `nodes` arrays from output GeoJSON `LineString` properties. Additionally, `LocalGeoJsonProvider.ts` (lines 1041, 1441) drops `rawOsmNodes` whenever a `MultiLineString` has `rawLines.length > 1`. | Live Overpass datasets currently lose explicit per-vertex OSM node IDs and rely 100% on `0.15 m` coordinate fallback. `MultiLineString` features with per-part node arrays also lose explicit IDs. |
| **G2** | **Cross-Domain Contamination in Shared `TopologicalNodeIndex` (`LocalGeoJsonProvider.ts`)** | `LocalGeoJsonProvider.ts` (line 871) instantiates a **single** `topoNodeIndex` shared by both railways (line 1030) and roads (line 1480) using `partGradeScope = "${layer}|${isBridge}|${isTunnel}"`. | At-grade roads and railways sharing an OSM level-crossing vertex receive the **same** canonical node ID and increment `globalNodeDegree` in `chainContiguousRoads` (line 2149), coupling road chaining to railway vertices before domain separation. |
| **G3** | **Double-Scoping & Interior Splitting Bugs (`GeometryBuilder.ts`)** | `GeometryBuilder.ts` creates a second `TopologicalNodeIndex` (line 2583). In `splitRoadsAtSharedInteriorNodes` (lines 907–987): (a) splitting occurs only within `tierScope` (`veh` vs. `path`), so footpaths meeting vehicular roads at shared interior nodes never split the road; (b) `uniqueInRoad = new Set(keys)` (line 946) counts self-intersecting P-loops (`keys[0] === keys[i]`) only once (`nodeUsageCount === 1`), failing to split P-loops; (c) line 2636 prepends `veh_` to `road.nodeIds[0]` which already received `veh|` in `splitRoadsAtSharedInteriorNodes`, yielding `veh_veh|osm_...`. | Inconsistent node ID scoping between ingestion and rendering; unsplit P-loops; lack of cross-tier (`veh` vs. `path`) topological awareness. |
| **G4** | **Premature & Direction-Blind Road Chaining (`LocalGeoJsonProvider.ts`)** | `chainContiguousRoads` (lines 2084–2276) runs *before* graph construction, uses greedy array-order iteration (`while (pool.length > 0)`), omits `oneway` from `groupKey` (line 2131) despite documentation claiming otherwise, reverses `other.points` when `curEndKey === otherEndKey` or `curStartKey === otherStartKey` (lines 2226–2258) regardless of `oneway` tags, and retains only the first way's `osmTags`. | Corrupts one-way directionality when opposite one-way ways meet; loses per-segment `osmTags` (`lanes`, `surface`, `maxspeed`); depends on input feature ordering. |
| **G5** | **Ad-Hoc Railway & Grade-Transition Proximity Heuristics** | `RailwayTopology.ts` (`computeContinuousTrackPhases`, `isTurnoutThroatPair`) ignores `RailwayFeature.nodeIds` and relies on `<= 0.65 m` distance + `dot > 0.7`. Bridge/tunnel grade transitions in `GeometryBuilder.ts` (lines 2587–2613, 3595–3608) and `RailwayGeometryBuilder.ts` (lines 566–579) use raw `0.65 m` / `0.80 m` radius scans across all endpoints without checking shared node IDs, tangent alignment, or road class. | An unrelated cross-street or footpath endpoint within `0.80 m` of a bridge abutment falsely triggers `connectsStartAtGrade = true` or suppresses end-caps. |
| **G6** | **Point Crossing & Switch Nodes Discarded at Ingestion (`FeatureCatalogue.ts`)** | In `FeatureCatalogue.ts`, point features (`!isLine`) with `railway=level_crossing`, `railway=crossing`, `railway=switch`, or `highway=crossing` fall through to `category: 'unsupported'` (lines 546, 841) and are skipped in `LocalGeoJsonProvider.ts` (line 1009). | Zero point-level OSM crossing or switch tags (`railway=level_crossing`, `crossing=*`, `railway=switch`) survive into `ProcessedMapData`. |
| **G7** | **Boundary-Clipped Synthetic Endpoints (`LocalGeoJsonProvider.ts`)** | `clipPolylineToBox` (lines 117–236) pushes `undefined` into `osmNodes` at Liang-Barsky boundary cut points (lines 208, 219), which `topoNodeIndex` converts into synthetic fallback nodes `tn_...`. | Two converging roads or tracks cut near the same bounding-box corner within `0.15 m` snap together into a false synthetic junction on the region boundary. |

---

## Decision

We will implement a lightweight, deterministic, pure-TypeScript **Infrastructure Graph Architecture** under `src/world/infrastructure/topology/` using **OSMnx** (`osmnx.graph` and `osmnx.simplification`) as our conceptual and algorithmic reference, without introducing any external graph library dependencies.

### 1. Module Boundaries and File Layout

All new topology contracts and builders will live under `src/world/infrastructure/topology/`:

```text
src/world/infrastructure/topology/
├── types.ts                   # Pure TypeScript domain interfaces (Nodes, Edges, Provenance, Relations, Diagnostics)
├── InfrastructureGraph.ts     # Top-level orchestrator: buildInfrastructureGraph(mapData) -> InfrastructureGraph
├── RoadNetworkBuilder.ts      # Stage B: Road node/edge extraction, interior splitting, non-interstitial degree-2 simplification
├── RailwayNetworkBuilder.ts   # Stage C: Independent railway graph construction, turnout/switch & crossover classification
└── CrossModalAnalyzer.ts      # Stage D: Road/rail level crossings, grade transitions (at-grade <-> bridge/tunnel), overpasses
```

#### Relationship to Existing `TopologicalNodeIndex`
- `src/world/TopologicalNodeIndex.ts` is **retained and extended** as the foundational low-level spatial and explicit-ID canonicalizer rather than replaced or duplicated.
- It will be instantiated **per network domain** (`road` vs. `railway`) during graph construction so road and railway node degrees never cross-contaminate each other, while explicit OSM node IDs (`osmNodeId`) remain comparable across domains in `CrossModalAnalyzer` for shared level-crossing detection.

---

### 2. Proposed TypeScript Domain Contracts (`src/world/infrastructure/topology/types.ts`)

```typescript
import {
  RawGeoJsonProperties,
  RoadClass,
  RailwayType,
} from '../../../types/MapFeature';

export type InfrastructureNetworkKind = 'road' | 'railway';

export type RoadTier = 'vehicular' | 'path';

export type OneWayDirection = 'yes' | '-1' | 'no';

export type RoadNodeRole =
  | 'junction'          // True intersection (degree >= 3, or self-loop anchor)
  | 'dead_end'          // Terminal endpoint (degree === 1, not boundary-clipped)
  | 'boundary_clip'     // Synthetic endpoint created by Liang-Barsky bounding-box clipping
  | 'grade_transition'  // Portal boundary where at-grade meets bridge or tunnel
  | 'attribute_break'   // Degree-2 node preserved due to roadClass/width/oneway/layer change
  | 'level_crossing';   // Degree-2 road node preserved because it coincides with a railway level crossing

export type RailwayNodeRole =
  | 'junction'          // General multi-track node (degree >= 3)
  | 'switch'            // Turnout point (1 trunk edge splitting into 2 diverging branch edges: 1-to-2 tangent topology)
  | 'crossover'         // Diamond crossing or double-slip (degree >= 4 with 2-to-2 opposing tangent pairs)
  | 'dead_end'          // Buffer stop / terminal track end (degree === 1, not boundary-clipped)
  | 'boundary_clip'     // Synthetic endpoint created by Liang-Barsky bounding-box clipping
  | 'grade_transition'  // Portal boundary where at-grade track meets railway bridge or tunnel
  | 'attribute_break'   // Degree-2 node preserved due to railwayType/gauge/electrified/layer change
  | 'level_crossing';   // Degree-2 rail node preserved because it coincides with a road level crossing

/**
 * Provenance for a single unmerged constituent way segment inside a simplified graph edge.
 */
export interface EdgeSegmentProvenance {
  /** Original feature ID in ProcessedMapData (e.g. "way/12345-0"). */
  featureId: string;
  /** Original OSM way/feature ID prior to part splitting. */
  sourceFeatureId: string;
  /** Start arc-length (meters) along the simplified parent edge's polyline. */
  startArcLength: number;
  /** End arc-length (meters) along the simplified parent edge's polyline. */
  endArcLength: number;
  /** Start vertex index (inclusive) in the parent edge's `points` array. */
  startVertexIndex: number;
  /** End vertex index (inclusive) in the parent edge's `points` array. */
  endVertexIndex: number;
  /** True if the constituent feature's digitized point order was reversed when merged into this edge. */
  reversed: boolean;
  /** Preserved raw OSM tags of this constituent way segment. */
  osmTags?: RawGeoJsonProperties;
}

/**
 * Complete OSMnx-style lineage for a graph edge after degree-2 path simplification.
 */
export interface EdgeProvenance {
  /** Primary feature ID (deterministic canonical representative). */
  primaryFeatureId: string;
  /** Ordered list of all original ProcessedMapData feature IDs merged into this edge. */
  mergedFeatureIds: string[];
  /** Deduplicated list of all raw OSM sourceFeatureIds represented by this edge. */
  sourceFeatureIds: string[];
  /** Ordered per-segment provenance intervals covering [0, lengthMeters]. */
  segments: EdgeSegmentProvenance[];
}

export interface BaseInfrastructureNode<TRole extends string> {
  /** Deterministic domain-scoped canonical node ID (e.g., "road_node:0|0|0:osm_5001" or "road_node:0|0|0:pt_120_-45"). */
  id: string;
  /** Network domain ('road' | 'railway'). */
  network: InfrastructureNetworkKind;
  /** Explicit raw OSM node ID if known (e.g., "5001"), undefined for coordinate-fallback nodes. */
  osmNodeId?: string;
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
  /** True if this node was synthesized by region bounding-box clipping. */
  isBoundaryClipped: boolean;
  /** Topological degree (count of incident edge endpoints; self-loop contributes +2). */
  degree: number;
  /** Primary topological classification of this node. */
  role: TRole;
  /** Deterministically sorted IDs of all edges incident to this node. */
  incidentEdgeIds: string[];
  /** Optional point-level OSM tags if an OSM point feature (e.g. railway=switch, railway=level_crossing) matched this node. */
  osmTags?: RawGeoJsonProperties;
}

export interface RoadNode extends BaseInfrastructureNode<RoadNodeRole> {
  network: 'road';
  /** True if incident to both 'vehicular' and 'path' road edges. */
  isCrossTier: boolean;
}

export interface RailwayNode extends BaseInfrastructureNode<RailwayNodeRole> {
  network: 'railway';
  /** For 'switch' nodes: the trunk edge ID entering the switch throat, and the two diverging branch edge IDs. */
  turnoutTopology?: {
    trunkEdgeId: string;
    mainBranchEdgeId: string;
    divergingBranchEdgeId: string;
  };
}

export interface BaseInfrastructureEdge {
  /** Deterministic edge ID (supports parallel multi-edges via parallelIndex). */
  id: string;
  /** Network domain ('road' | 'railway'). */
  network: InfrastructureNetworkKind;
  /** Start topological node ID. */
  fromNodeId: string;
  /** End topological node ID. */
  toNodeId: string;
  /** Parallel multi-edge discriminator (0 for single edge between (fromNodeId, toNodeId), 1+ for parallel ways). */
  parallelIndex: number;
  /** Full 2D metric polyline geometry [x, z][] preserving all intermediate shape vertices. */
  points: [number, number][];
  /** Per-vertex canonical or raw OSM node IDs aligned 1:1 with `points` (preserved for diagnostics/crossings). */
  vertexOsmNodeIds: (string | undefined)[];
  /** Cumulative Euclidean arc-length in meters. */
  lengthMeters: number;
  /** Effective OSM vertical layer. */
  layer: number;
  /** True if edge is a bridge structure. */
  isBridge: boolean;
  /** True if edge is a tunnel structure. */
  isTunnel: boolean;
  /** True if fromNodeId === toNodeId. */
  isClosedLoop: boolean;
  /** True if the start vertex was created by region bounding-box clipping. */
  clippedAtStart: boolean;
  /** True if the end vertex was created by region bounding-box clipping. */
  clippedAtEnd: boolean;
  /** Unit tangent [dx, dz] pointing away from `fromNodeId` at the start of the edge. */
  startTangent: [number, number];
  /** Unit tangent [dx, dz] pointing away from `toNodeId` (into the edge) at the end of the edge. */
  endTangent: [number, number];
  /** Full OSMnx-style provenance and constituent segment mapping. */
  provenance: EdgeProvenance;
}

export interface RoadEdge extends BaseInfrastructureEdge {
  network: 'road';
  roadClass: RoadClass;
  tier: RoadTier;
  width: number;
  lanes?: number;
  oneway: OneWayDirection;
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
  /** True if classified as a siding/yard/spur/crossover secondary branch. */
  isSecondaryBranch: boolean;
  name?: string;
}

export interface InfrastructureNetwork<TNode, TEdge> {
  /** Map from canonical node ID to node record. */
  nodes: ReadonlyMap<string, TNode>;
  /** Map from canonical edge ID to edge record. */
  edges: ReadonlyMap<string, TEdge>;
  /** Map from ProcessedMapData feature ID to the simplified edge ID(s) that contain it. */
  featureToEdgeIds: ReadonlyMap<string, readonly string[]>;
}

export type RoadNetwork = InfrastructureNetwork<RoadNode, RoadEdge>;
export type RailwayNetwork = InfrastructureNetwork<RailwayNode, RailwayEdge>;

/**
 * Explicit portal connection between an at-grade edge and a bridge or tunnel edge
 * within the same network domain ('road' or 'railway').
 */
export interface GradeTransitionRelation {
  id: string;
  network: InfrastructureNetworkKind;
  transitionType: 'bridge_approach' | 'tunnel_portal';
  /** Shared world position [x, z] of the portal transition. */
  position: [number, number];
  /** Explicit OSM node ID if the at-grade and bridge/tunnel endpoints share an OSM node. */
  osmNodeId?: string;
  atGradeNodeId: string;
  atGradeEdgeId: string;
  atGradeEndpoint: 'start' | 'end';
  gradeSeparatedNodeId: string;
  gradeSeparatedEdgeId: string;
  gradeSeparatedEndpoint: 'start' | 'end';
  /** Cosine of the tangent alignment angle across the portal (1.0 = collinear). */
  tangentAlignmentDot: number;
  /** How the transition was established. */
  confidence: 'explicit_osm_node' | 'endpoint_snap_aligned';
}

/**
 * Explicit at-grade crossing between a RoadEdge and a RailwayEdge.
 */
export interface LevelCrossingRelation {
  id: string;
  /** World coordinates [x, z] of the crossing point. */
  position: [number, number];
  /** Shared explicit OSM node ID if tagged/connected in OSM. */
  osmNodeId?: string;
  roadEdgeId: string;
  /** Road node ID if the crossing occurs at a road graph node, or undefined if interior. */
  roadNodeId?: string;
  /** Arc-length in meters along `roadEdgeId` from `fromNodeId`. */
  roadArcLengthMeters: number;
  railwayEdgeId: string;
  /** Railway node ID if the crossing occurs at a railway graph node, or undefined if interior. */
  railwayNodeId?: string;
  /** Arc-length in meters along `railwayEdgeId` from `fromNodeId`. */
  railwayArcLengthMeters: number;
  /** Acute intersection angle in radians (0..pi/2] between road and rail tangents. */
  crossingAngleRad: number;
  /** Provenance of crossing detection. */
  confidence: 'explicit_osm_crossing_tag' | 'shared_osm_node' | 'coincident_at_grade_vertex';
  /** Point-level OSM tags (e.g., railway=level_crossing, crossing:barrier=yes) if available. */
  osmTags?: RawGeoJsonProperties;
}

/**
 * Planimetric crossing where two edges (road/road, rail/rail, or road/rail) cross in 2D (X, Z)
 * at different vertical scopes (bridge over at-grade, tunnel under at-grade, or distinct layers)
 * WITHOUT physical connectivity.
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
  railwaySwitchCount: number;
  railwayCrossoverCount: number;
  railwaySimplifiedDegree2Count: number;
  gradeTransitionCount: number;
  levelCrossingCount: number;
  gradeSeparatedCrossingCount: number;
  boundaryClippedNodeCount: number;
  /** Count of geometric 2D road/rail or same-layer crossings that lacked a shared node and were NOT connected. */
  unconnectedGeometricCrossingCount: number;
}

/**
 * Top-level immutable infrastructure topology product consumed by GeometryBuilder,
 * RailwayGeometryBuilder, and future M2.4 surface marking builders.
 */
export interface InfrastructureGraph {
  roads: RoadNetwork;
  railways: RailwayNetwork;
  gradeTransitions: readonly GradeTransitionRelation[];
  levelCrossings: readonly LevelCrossingRelation[];
  gradeSeparatedCrossings: readonly GradeSeparatedCrossingRelation[];
  diagnostics: TopologyDiagnostics;
}
```

#### Optional Metadata Extension on `ProcessedMapData` (`src/types/MapFeature.ts`)
To resolve **Gap G6** (discarded point-level OSM crossing and switch nodes), `ProcessedMapData` will gain an optional array populated during GeoJSON ingestion in Stage C/D:

```typescript
export interface InfrastructurePointMetadata {
  id: string;
  osmNodeId?: string;
  point: [number, number];
  kind: 'railway_level_crossing' | 'railway_crossing' | 'railway_switch' | 'highway_crossing';
  osmTags: RawGeoJsonProperties;
}
```

---

### 3. Graph Construction and Simplification Specification

#### 3.1 Ingestion & Explicit OSM Node ID Preservation (Addressing Gaps G1 & G6)
1. **Explicit Per-Vertex OSM Node IDs**:
   - When `props.nodes`, `props.nodeIds`, or `props._nodeIds` are present on a GeoJSON `LineString` (or per-part arrays on a `MultiLineString`), each vertex $i$ is associated with its explicit stringified OSM node ID `osmNodeId`.
   - For live Overpass queries in `server.ts`, Stage B will preserve way `nodes` arrays on GeoJSON feature properties (e.g., via a lightweight pre/post enrichment pass on `overpassJson.elements` before/after `osmtogeojson(overpassJson)`) so real OSM extracts carry authentic per-vertex OSM node IDs alongside their metric coordinates.
2. **Coordinate Fallback (`0.15 m`)**:
   - When `osmNodeId` is absent (`undefined`), vertex snapping falls back to `TopologicalNodeIndex` with `DEFAULT_NODE_SNAP_TOLERANCE_METERS = 0.15` (`15 cm`).
   - **Strict Non-Merging of Distinct Explicit IDs**: Two vertices with distinct explicit OSM node IDs (`osm_A !== osm_B`) are **never** merged into the same node, even if their 2D coordinates are identical (`0.00 m` apart).
   - **Fallback-to-Explicit Promotion**: A coordinate-only vertex within `0.15 m` of an explicit OSM node in the same domain and vertical scope resolves deterministically to that explicit node's canonical ID regardless of feature iteration order.

#### 3.2 Deterministic Pre-Sorting and Stable Canonical IDs
- To eliminate input-order sensitivity (`Gap G4`), input `RoadFeature[]` and `RailwayFeature[]` arrays are sorted canonically by `(layer, isBridge, isTunnel, id)` before indexing nodes or constructing raw edges.
- **Canonical Node ID Format**:
  - Explicit OSM node: `${network}_node:${layer}|${isBridge ? 1 : 0}|${isTunnel ? 1 : 0}:osm_${osmNodeId}`
  - Coordinate fallback node: `${network}_node:${layer}|${isBridge ? 1 : 0}|${isTunnel ? 1 : 0}:pt_${Math.round(x * 100)}_${Math.round(z * 100)}_${seq}`
- **Canonical Edge ID Format**:
  - `${network}_edge:${primaryFeatureId}:seg_${segmentIdx}:p_${parallelIndex}`

#### 3.3 Boundary-Clipped Endpoint Isolation (Addressing Gap G7)
- When `clipPolylineToBox` clips a polyline against `[-clipExtent, +clipExtent]`, any vertex synthesized by a Liang-Barsky boundary cut is marked as a boundary-clipped endpoint (`clippedAtStart` / `clippedAtEnd`).
- Boundary-clipped endpoints without an explicit `osmNodeId` are assigned isolated `role: 'boundary_clip'` nodes and **excluded from `0.15 m` coordinate fallback snapping with other ways**. This guarantees that two converging roads or tracks cut near the same bounding-box edge are never falsely merged into a synthetic boundary junction.

#### 3.4 Interior Node Splitting & Self-Loop / P-Loop Handling (Addressing Gap G3)
1. **True Network Nodes vs. Ordinary Polyline Shape Vertices**:
   - Every way vertex is registered in the domain's `TopologicalNodeIndex`.
   - A vertex is a **true topological split node** if and only if:
     - It is the start or end vertex of any way, **or**
     - Its total vertex occurrence count across all ways in the domain/vertical scope (counting multiple occurrences within the **same** way separately, fixing the `new Set(keys)` P-loop bug in `GeometryBuilder.ts` line 946) is $\ge 2$, **or**
     - It coincides with an explicit cross-modal level crossing or point switch node.
   - All other interior vertices (occurrence count $=== 1$ and not a way endpoint or crossing) remain **ordinary polyline shape vertices** embedded inside the edge's `points` array.
2. **Splitting at Shared Interior Nodes**:
   - Any way containing a true topological split node at interior vertex index $0 < i < N-1$ is split at index $i$ into contiguous sub-edges $[0 \dots i]$ and $[i \dots N-1]$, preserving sub-segment arc-length provenance.
3. **Closed Loops and P-Loops**:
   - **P-Loop** (endpoint meets an interior vertex of the same way): Because vertex occurrences are counted per vertex index rather than per unique set per way, the shared interior vertex has occurrence count $\ge 2$, splitting the P-loop into a stem edge and a closed-loop ring edge at a degree-3 junction node.
   - **Pure Closed Ring** (e.g., an isolated roundabout or loop track with `points[0] === points[N-1]` and no incident branches): If it has at least one junction with an external road, it splits at the external junction node(s). If it is completely isolated (all vertices have degree 2), a single deterministic anchor vertex (minimum lexicographical `osmNodeId` or minimum `(x, z)`) is retained with `role: 'junction'` so the closed ring remains a valid edge (`isClosedLoop: true`) rather than evaporating during degree-2 simplification.

#### 3.5 OSMnx-Style Non-Interstitial Degree-2 Simplification (Addressing Gap G4)
Instead of chaining roads *before* graph construction (`chainContiguousRoads` in `LocalGeoJsonProvider.ts`), raw edges are constructed first from unchained ways, split at interior junctions, and then simplified via **OSMnx-style degree-2 path simplification**:
- A node $v$ with topological degree $=== 2$ (incident to two distinct edges $e_1, e_2$) is contracted into a single simplified edge **if and only if** all compatibility invariants hold:
  1. $v$ is not a `grade_transition`, `level_crossing`, `switch`, or `boundary_clip` node.
  2. $e_1$ and $e_2$ belong to the same vertical scope (`layer`, `isBridge`, `isTunnel`).
  3. **For Roads**: $e_1$ and $e_2$ have identical `(roadClass, tier, Math.round(width * 10), isCulvert, nameKey)` **and** compatible `oneway` directionality:
     - If either edge has `oneway !== 'no'`, their directed traversal across $v$ must be continuous (`e1.toNodeId === v && e2.fromNodeId === v` for `oneway === 'yes'`). Two opposing one-way edges (`-> v <-` or `<- v ->`) or a `oneway=yes` meeting `oneway=no` are **never** merged (`v` is retained with `role: 'attribute_break'`).
  4. **For Railways**: $e_1$ and $e_2$ have identical `(railwayType, Math.round(width * 10), gauge, electrified, service, isSecondaryBranch)`.
- When contracted, the simplified edge concatenates the full `points` and `vertexOsmNodeIds` arrays and merges their `EdgeSegmentProvenance[]` lists in exact traversal order, preserving per-segment `osmTags` (`lanes`, `surface`, etc.) and `reversed` flags.

#### 3.6 Parallel Edges Between the Same Node Pair (MultiGraph Support)
- Following OSMnx's `MultiDiGraph` / `MultiGraph` model, two or more distinct edges connecting the exact same `(fromNodeId, toNodeId)` pair (e.g., a Crescent loop joining a main street at two junctions, or a railway passing loop parallel to a main track between two switches) are **both preserved** as distinct `InfrastructureEdge` records with `parallelIndex: 0`, `parallelIndex: 1`, etc.
- Simplification never collapses parallel edges into a single edge and never drops a degree-2 path if collapsing it would destroy distinct geometry; in fact, under OSMnx simplification, each branch between the two degree-3 junction nodes simplifies independently into its own curved `InfrastructureEdge` with distinct `parallelIndex` and full intermediate polyline geometry.

#### 3.7 Grade Transitions and Cross-Modal Relations (Addressing Gap G5)
1. **Grade Transitions (`GradeTransitionRelation`)**:
   - Built per network (`road` or `railway`) at endpoints where an at-grade edge (`!isBridge && !isTunnel`) meets a grade-separated edge (`isBridge || isTunnel`).
   - **Primary Match**: Shared explicit `osmNodeId` between the at-grade endpoint and the bridge/tunnel endpoint.
   - **Fallback Match**: Endpoint Euclidean distance $\le 0.15\text{ m}$ (or $\le 0.65\text{ m}$ only when both endpoints are terminal degree-1 endpoints in their respective scopes **and** their tangent vectors align with $|\text{dot}| \ge 0.707$, i.e. $\le 45^\circ$, **and** their `roadClass`/`tier` or `railwayType` are compatible). This eliminates false grade transitions triggered by perpendicular cross-streets or footpaths passing near bridge abutments.
2. **Road/Rail Level Crossings (`LevelCrossingRelation`)**:
   - A `LevelCrossingRelation` is created **only** when an at-grade `RoadEdge` and an at-grade `RailwayEdge` on the same `layer` either:
     - Share an explicit OSM node ID (`osmNodeId`) at a vertex, **or**
     - Intersect at a point matched within `0.50 m` of an ingested OSM point feature tagged `railway=level_crossing` or `railway=crossing`, **or**
     - Share a coincident vertex (`<= 0.15 m`) when neither way has explicit OSM node IDs.
   - Pure 2D segment crossings without a shared vertex or explicit OSM crossing node are recorded as `unconnectedGeometricCrossingCount` (or `GradeSeparatedCrossingRelation` if on different layers/structures) and **never** create false topological connectivity.

---

### 4. Renderer Integration Boundary (`ProcessedMapData -> InfrastructureGraph -> GeometryBuilder`)

1. **Where the Graph is Constructed**:
   - `buildInfrastructureGraph(mapData: ProcessedMapData): InfrastructureGraph` is a pure, deterministic domain function in `src/world/infrastructure/topology/InfrastructureGraph.ts`.
   - `ProcessedMapData` in `src/types/MapFeature.ts` may optionally cache `infrastructureGraph?: InfrastructureGraph` (computed at the end of `LocalGeoJsonProvider.parseGeoJson()` or lazily on first access in `GeometryBuilder`), while keeping `buildInfrastructureGraph` directly callable in unit tests on synthetic `ProcessedMapData` fixtures.
2. **What `GeometryBuilder` and `RailwayGeometryBuilder` Consume vs. Own**:
   - **Graph Owns (Topological Truth)**:
     - Which roads/tracks are connected at which junction/switch nodes (`RoadNode`, `RailwayNode`).
     - Simplified edge polylines (`RoadEdge.points`, `RailwayEdge.points`) already split at all interior junctions and P-loops.
     - Explicit portal pairings (`GradeTransitionRelation`) between at-grade roads/tracks and bridges/tunnels.
     - Validated railway switch throat/branch topology (`RailwayNode.turnoutTopology`) and level crossings (`LevelCrossingRelation`).
   - **Renderers Own (3D Metric & Visual Synthesis)**:
     - `GeometryBuilder`: 2D offset ribbon generation, boundary-derived junction polygon synthesis (`ADR-0002` portal trimming and miter clamping at `RoadNode`s), carriageway-vs-path 2D Boolean clipping, `ElevationPolicy` Y-coordinates, and 3D bridge/tunnel substructure meshes.
     - `RailwayGeometryBuilder`: 3D ballast, instanced sleeper placement/clipping (`HostTrackSpatialIndex`), extruded steel rails, close/far UV-ribbon LOD chunks (`ADR-0008`), and turnout bearer placement.
3. **Incremental Stage B–E Migration Without Regressing 92 Existing Tests**:
   - **Stage B (`RoadNetworkBuilder`)**: Build and unit-test `RoadNetwork` in isolation against synthetic and real fixtures. In `LocalGeoJsonProvider.ts`, retain `mapData.roads` compatibility so existing `GeometryBuilder` tests continue passing unchanged until Stage E.
   - **Stage C (`RailwayNetworkBuilder`)**: Build and unit-test `RailwayNetwork` (including turnout `1-to-2` switch role and crossover classification) in isolation without altering `RailwayGeometryBuilder` mesh output.
   - **Stage D (`CrossModalAnalyzer`)**: Build and unit-test `GradeTransitionRelation`, `LevelCrossingRelation`, and `GradeSeparatedCrossingRelation` (plus point crossing/switch metadata ingestion in `FeatureCatalogue.ts` / `LocalGeoJsonProvider.ts`).
   - **Stage E (`Renderer Integration`)**: Wire `GeometryBuilder` Stage 6 road junction trimming and bridge/tunnel portal detection (and `RailwayTopology` phase/turnout helpers where beneficial) to consume `InfrastructureGraph`, removing the redundant inline `splitRoadsAtSharedInteriorNodes` and raw `0.80 m` distance scans while verifying that all 92 existing tests + all new M2.3 topology tests pass with zero coplanar overlap or portal regressions.

---

## Alternatives Considered

1. **Adopt an External Graph Library (`graphology` or `ngraph.graph`)**:
   - *Description*: Install an npm graph package to store nodes, multi-edges, and attributes.
   - *Pros*: Built-in traversal helpers.
   - *Cons / Why Rejected*: Adds third-party runtime bundle weight and untyped generic attribute bags (`any`), whereas our domain requires strongly typed metric polyline geometry, per-segment OSM provenance intervals, vertical scope keys, and custom OSMnx-style degree-2 simplification rules that must be written in domain code anyway. Native TypeScript interfaces + `Map` and `Set` are faster, zero-dependency, and strictly typed.

2. **Perform Planar Subdivision at All 2D Segment Intersections**:
   - *Description*: Automatically split and connect any two roads or railways whose 2D line segments cross in $(X, Z)$ on the same `layer`.
   - *Pros*: Compensates for missing shared nodes in poorly digitized GeoJSON.
   - *Cons / Why Rejected*: Violates OSM topological semantics and OSMnx principles. In real OSM data, bridges lacking `layer` tags, service tunnels, or unsplit footpaths crossing carriageways would be falsely welded into 4-way intersections. Connectivity must require shared explicit OSM nodes or bounded (`0.15 m`) endpoint snapping within compatible scopes.

3. **Keep Road Chaining Inside `LocalGeoJsonProvider` Before Graph Construction**:
   - *Description*: Continue running `chainContiguousRoads` during GeoJSON parsing and build the graph afterward.
   - *Pros*: No change to `LocalGeoJsonProvider.ts`.
   - *Cons / Why Rejected*: `chainContiguousRoads` runs before interior junction splitting and before cross-modal level crossings are known, causing it to either merge across unsplit interior junctions or fail to chain across railway level crossings (Gap G2/G4). Moving degree-2 simplification into `RoadNetworkBuilder` *after* interior junction splitting matches OSMnx's exact algorithmic order.

---

## Consequences and Trade-Offs

### Positive
- Eliminates dual/inconsistent `TopologicalNodeIndex` scoping between `LocalGeoJsonProvider` and `GeometryBuilder`.
- Preserves full per-segment OSM tag provenance (`oneway`, `lanes`, `surface`, `sourceFeatureId`) across simplified degree-2 edges, directly enabling `M2.4` road surface markings (lane dividers, directional arrows, crosswalks, stop bars).
- Distinguishes true topological junctions, switches, grade transitions, and level crossings from accidental 2D geometric crossings and bounding-box clip cuts.
- Zero external runtime dependencies.

### Negative / Neutral
- Introducing `InfrastructureGraph` adds a fast $O(V + E)$ in-memory graph construction pass (~1–3 ms for typical 500–2,000 way neighborhood tiles).
- Deprecating or refactoring `chainContiguousRoads` in Stage E requires updating or preserving `diagnostics.featureLineage.chainingMap` so existing provenance diagnostic tests in `FeatureCoverage.test.ts` and `JunctionAndTopology.test.ts` continue to pass.

---

## Open Questions for Project Owner Approval (`Proposed` — Gate Before Stage B)

1. **`LocalGeoJsonProvider.roads` Output vs. `RoadNetwork` Simplification (Stage B vs. Stage E)**:
   - *Proposal*: During **Stage B**, `LocalGeoJsonProvider.parseGeoJson()` continues producing `mapData.roads` as today so all 92 existing tests remain untouched, while `RoadNetworkBuilder` constructs `InfrastructureGraph.roads` from the unchained pre-simplification ways (or splits/simplifies deterministically). In **Stage E**, `RoadNetworkBuilder`'s simplified edges populate `diagnostics.featureLineage.chainingMap` and drive `GeometryBuilder`.
2. **Live Overpass Per-Vertex Node ID Enrichment (`server.ts`)**:
   - *Proposal*: In **Stage B**, enrich the GeoJSON features produced by `osmtogeojson(overpassJson)` in `server.ts` with `properties._nodeIds` copied from `overpassJson.elements` (`type === 'way' -> element.nodes`) so live Overpass presets have 100% explicit OSM node IDs, while keeping the `0.15 m` coordinate fallback fully active for arbitrary local GeoJSON files without node arrays.
3. **Cross-Tier (`vehicular` vs. `path`) Interior Splitting Rule**:
   - *Proposal*: In `RoadNetwork`, when a `path`-tier way (`footway`, `cycleway`, `path`, `pedestrian`) shares an explicit OSM node with an interior vertex of a `vehicular` road, record the shared node in `RoadNetwork` (`isCrossTier: true`) so crosswalks/connections are topologically known for `M2.4`, **without** forcing Stage 6 vehicular asphalt junction polygon trimming (`ADR-0002`) to carve vehicular carriageways at narrow footpath connections (carriageway-vs-path 2D Boolean clipping continues handling visual layering).

---

## Related Source Modules

- `src/world/TopologicalNodeIndex.ts`
- `src/world/LocalGeoJsonProvider.ts`
- `src/world/FeatureCatalogue.ts`
- `src/world/GeometryBuilder.ts`
- `src/world/infrastructure/railways/RailwayTopology.ts`
- `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`
- `src/types/MapFeature.ts`
- `src/world/infrastructure/topology/*` *(planned for Stages B–E)*

---

## Tests and Evidence (Planned Acceptance Fixtures for Stages B–E)

All graph stages will be verified via deterministic `vitest` unit/integration tests without browser/WebGL dependencies:

1. **T-01 (`Degree-2 Simplification With Curved Polyline Geometry`)**: 3 collinear/curved ways sharing degree-2 nodes with identical road attributes merge into 1 `RoadEdge` whose `points` array preserves every intermediate curve vertex and whose `provenance.segments` maps all 3 original `sourceFeatureId`s.
2. **T-02 (`True T-Junction vs. Ordinary Bend Vertex`)**: A main road with 5 interior curve vertices where a side street connects only at vertex 2 splits *only* at vertex 2 (`degree === 3`, `role: 'junction'`), keeping vertices 1, 3, 4 as internal shape points on the two resulting main-road edges.
3. **T-03 (`4-Way Shared-Node Road Intersection`)**: Two roads sharing a central OSM node split into 4 incident `RoadEdge`s meeting at a single `RoadNode` with `degree === 4`, `role: 'junction'`.
4. **T-04 (`Unconnected 2D Geometric Crossing — Overpass / Unshared Crossing`)**: Two roads whose segments cross at `(0, 0)` without a shared OSM node (or on different layers `layer=0` vs. `layer=1`) produce 2 unsplit `RoadEdge`s, `0` shared junction nodes, and `1` `GradeSeparatedCrossingRelation` (or `unconnectedGeometricCrossingCount === 1`).
5. **T-05 (`Interior Node Split Where Side Road Meets Main Road Mid-Way`)**: Side road endpoint sharing explicit OSM node `osm_200` (or `<= 0.15 m` fallback) with interior vertex of main road splits main road into 2 edges and forms a degree-3 junction node.
6. **T-06 (`Parallel Edges Between Same Two Nodes — MultiGraph`)**: A main road and a crescent/loop road connecting at the exact same start and end junction nodes `(u, v)` produce 2 distinct `RoadEdge` records with `parallelIndex: 0` and `parallelIndex: 1`, preserving both full geometries.
7. **T-07 (`Self-Loop and P-Loop Handling`)**: A cul-de-sac P-loop where way endpoint `points[N-1]` reconnects to interior vertex `points[2]` splits at `points[2]` into 1 stem edge (`u -> v`) and 1 closed-loop edge (`v -> v`, `isClosedLoop: true`), with node `v` having `degree === 3`.
8. **T-08 (`Attribute Discontinuity Blocks Degree-2 Simplification`)**: Two contiguous ways meeting at a degree-2 node with different `roadClass` (`primary` vs. `residential`), different `width`, or incompatible `oneway` tags (`oneway=yes` vs. `oneway=no` or opposing `oneway=-1`) are **not** merged; the degree-2 node is retained with `role: 'attribute_break'`.
9. **T-09 (`Explicit OSM Node ID Precedence Over Coordinate Fallback`)**: Two vertices at identical coordinates `(10, 10)` with distinct explicit IDs `osm_1` and `osm_2` remain 2 separate nodes (`0` false merge), whereas a coordinate-only vertex at `(10.05, 10.05)` snaps to a nearby explicit node within `0.15 m` regardless of feature insertion order.
10. **T-10 (`Boundary-Clipped Endpoints Excluded From False Junction Snapping`)**: Two converging roads clipped by `clipPolylineToBox` within `0.10 m` of each other on the `+clipExtent` boundary receive distinct `role: 'boundary_clip'` nodes and are **not** snapped into a synthetic degree-2 or degree-3 junction.
11. **T-11 (`Independent Railway Network With Turnout 1-to-2 Switch Topology`)**: Mainline track and diverging siding sharing a turnout node `osm_900` split the mainline if interior and classify the shared `RailwayNode` as `role: 'switch'` (`degree === 3`) with populated `turnoutTopology: { trunkEdgeId, mainBranchEdgeId, divergingBranchEdgeId }`.
12. **T-12 (`Railway Diamond Crossover Topology`)**: Two tracks crossing at a shared OSM node `osm_950` split into 4 incident `RailwayEdge`s at a single `RailwayNode` with `degree === 4`, `role: 'crossover'`.
13. **T-13 (`At-Grade Road/Rail Level Crossing`)**: An at-grade road and at-grade railway sharing an explicit OSM node (or an ingested `railway=level_crossing` point node) remain in their separate `roads` and `railways` networks while generating a `LevelCrossingRelation` with exact arc-length offsets and crossing angle, and preserving the crossing node against degree-2 erasure.
14. **T-14 (`Road Overpass Above Railway — Grade-Separated Crossing`)**: A road with `bridge=yes, layer=1` crossing above an at-grade railway (`layer=0`) generates `0` `LevelCrossingRelation`s and `1` `GradeSeparatedCrossingRelation`.
15. **T-15 (`Bridge and Tunnel Approach Grade Transitions — No False Proximity Trigger`)**: An at-grade road connected to a bridge road via shared node (or collinear endpoint snap) generates `1` `GradeTransitionRelation`, whereas an unrelated perpendicular footpath or cross-street endpoint `0.50 m` from the bridge abutment generates `0` false grade transitions.
16. **T-16 (`Provenance Preservation & Stage E Renderer Non-Regression`)**: Across all simplified edges, `provenance.sourceFeatureIds` and `provenance.segments` account for 100% of constituent ways, and in Stage E all 92 existing tests (`JunctionAndTopology.test.ts`, `RailwayRendering.test.ts`, `ElevationAndZIndex.test.ts`, etc.) pass with zero coplanar triangle overlaps.

---

## Superseded or Related Decisions

- **Related to**:
  - [ADR-0002: Boundary-Derived Road Junction Polygon Synthesis and Coplanar Overlap Resolution](./ADR-0002-boundary-derived-road-junction-meshing.md) *(Stage E refines the topological node/edge input consumed by ADR-0002's portal trimmer)*
  - [ADR-0003: Loaded Region Boundary Clipping and Bounded Scene Sizing](./ADR-0003-loaded-region-boundary-clipping.md) *(Defines Liang-Barsky boundary cut points flagged as `boundary_clip` nodes)*
  - [ADR-0004: Grade-Separated Infrastructure, Elevation Policy, and Bridge/Culvert Disambiguation](./ADR-0004-grade-separated-infrastructure-and-elevation-policy.md) *(Defines vertical structure scopes connected via `GradeTransitionRelation`)*
  - [ADR-0005: Source-Feature Provenance Tracking and Diagnostic Accounting](./ADR-0005-source-feature-provenance-and-diagnostics.md) *(Extended by `EdgeProvenance` and `EdgeSegmentProvenance`)*
  - [ADR-0008: Hybrid Railway Rendering, Multi-Interval Turnout Support, and UV-Ribbon Architecture](./ADR-0008-hybrid-railway-rendering-and-uv-ribbon-architecture.md) *(Complemented by `RailwayNetwork` switch/crossover topology)*
