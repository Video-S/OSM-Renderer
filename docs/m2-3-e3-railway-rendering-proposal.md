# Implementation Proposal: Milestone 2.3-E3 — Graph-Driven Railway Rendering & Surface-First Ballast (R+)

- **Target Milestone**: Milestone 2.3 Stage E3 (`M2.3-E3`)
- **Status**: Proposal / Draft Specification (Planning Only — No implementation authorized)
- **Author**: Core Infrastructure & Rendering Engineering
- **Date**: 2026-11-09
- **Governing ADRs**: 
  - [`ADR-0008: Hybrid Railway Rendering and UV-Ribbon Architecture`](../docs/decisions/ADR-0008-hybrid-railway-rendering-and-uv-ribbon-architecture.md) (Authoritative for Candidate B production railway renderer)
  - [`ADR-0009: Infrastructure Graph Topology`](../docs/decisions/ADR-0009-infrastructure-graph-topology.md) (Authoritative for railway graph, switches, and flat crossings)
  - [`ADR-0010: Surface-First At-Grade Road Rendering (E2+)`](../docs/decisions/ADR-0010-surface-first-road-rendering.md) (Preferred architectural pattern for planar surface occupancy)

---

## Executive Summary

Following the success of **E2+** (`roads: 'graph-surface'`) in eliminating junction patch fragility and achieving zero coverage defects and zero coplanar overlap across all 12 benchmark datasets, this proposal evaluates applying graph-driven descriptor consumption and surface-first footprint principles to the railway domain in **Milestone 2.3-E3**.

**Core Principle**: Railway rendering encompasses fundamentally different physical layers that must not be treated as a single uniform geometric problem:
1. **Steel Rails**: Physical 1D extrusion / track-aligned continuous ribbons governed strictly by **topological track continuity**, switch-blade tapering, and precise geometric gauge ($1.435\text{ m}$ inner / $1.635\text{ m}$ visual center-to-center). Planar 2D Boolean subtraction must **never** be applied to rails.
2. **Sleepers / Bearers**: Discrete track-perpendicular beams with longitudinal phase coherence, transverse extensions across turnout throats ($2.5\text{ m} \to 4.9\text{ m}$), and multi-interval parallel track clipping. Sleepers are governed by spatial clearance and phase matching, not 2D polygon clipping.
3. **Ballast Bed (Crushed Stone)**: A continuous planar gravel substrate ($Y = +0.060\text{ m}$) supporting tracks and coalescing into station-throat yard aprons. **Only the ballast bed is a genuine candidate for E2+-style surface-first 2D footprint buffering and union (R+)**.
4. **Grade-Separated Bridges & Tunnels**: 3D sloped approach ramps, concrete piers, parapets, and recessed subterranean portals governed by 3D vertical elevation profiles ($Y = +2.860\text{ m}$ / $Y = -2.000\text{ m}$). Planar 2D Booleans cannot represent 3D grade transitions.

We propose a **4-stage decoupled plan (E3-A through E3-D)** that preserves the validated Candidate B production railway renderer ([`ADR-0008`](../docs/decisions/ADR-0008-hybrid-railway-rendering-and-uv-ribbon-architecture.md)) while testing surface-first ballast (`R+`) as an isolated, opt-in hypothesis with strict fallback.

---

## 1. Current-State Audit: Existing vs. Missing Capabilities

### 1.1 What Already Exists and Is Reusable (Zero Duplication)
1. **Stage C Railway Graph Topology (`M2.3-C` / `TKT-005` in `RailwayNetworkBuilder.ts`)**:
   - `buildRailwayNetwork()` produces `RailwayNode` and `RailwayEdge` instances with strict degree invariants, P-loop/self-loop handling, degree-2 chain simplification with attribute breaks (`railwayType`, `width`, `gauge`, `electrified`, `service`, `usage`), exact $1\text{ mm}$ deduplication, and non-destructive `ProcessedMapData.topologySource.railwayParts` handoff.
   - Conservative `1-to-2` turnout classification (`confirmed`, `unresolved_main_vs_diverging`, `unresolved_throat`) and non-interconnecting flat diamond crossings (`RailwayFlatCrossingRelation`).
2. **Stage E1 Adapter Contracts (`M2.3-E1` / `TKT-007` in `InfrastructureRenderAdapter.ts`)**:
   - `InfrastructureRenderDescriptorBundle` already includes complete, validated `railwayNodes`, `railwayEdges`, and `railwayFlatCrossings`:
     - `RailwayEdgeRenderDescriptor`: Ordered metric polyline `points`, `lengthMeters`, `railwayType`, `width`, `gauge`, `electrified`, `service`, `usage`, `isSecondaryBranch`, `layer`, `isBridge`, `isTunnel`, `isClosedLoop`, `clippedAtStart`/`clippedAtEnd`, `startInwardTangent`/`endInwardTangent`, `hasConfirmedSwitchAtStart`/`hasConfirmedSwitchAtEnd`, `startTurnoutStatus`/`endTurnoutStatus`, complete `EdgeProvenance` (`provenance.segments`), `flatCrossingIds`, `gradeTransitionIds`, `levelCrossingIds`, and `gradeSeparatedCrossingIds`.
     - `RailwayNodeRenderDescriptor`: `position`, `degree`, `primaryRole`, `roles`, `turnoutStatus`, `turnoutTopology` (`trunkEdgeId`, `mainBranchEdgeId`, `divergingBranchEdgeId`, `turnoutSide`, `divergenceAngleRad`), and `flatCrossingIds`.
     - `RailwayFlatCrossingRenderDescriptor`: Track A/B edge IDs, crossing arc-lengths, crossing angle, and strict `allowsBranchInterchange: false`.
   - Feature lineage maps: `sourceFeatureToRailwayEdgeIds`, `railwayFeatureLineage.chainingMap`, `railwayFeatureLineage.deduplicatedMap`.
3. **Production Candidate B Renderer (`ADR-0008` in `RailwayGeometryBuilder.ts`)**:
   - Continuous arc-length UV ribbons (`UvRibbonBuilder.ts`) with derivative-filtered analytical `fwidth` box shaders (`InfrastructureShaderChunks.ts`).
   - Zoom-based hybrid LOD switching at `zoom = 4.5 CSS px/m`: 3D instanced sleeper boxes (`THREE.InstancedMesh`) + 3D extruded steel rails at close zoom; continuous UV ribbons at medium/overview zoom.
   - Mainline-first sorting (`sortRailwaysMainlineFirst`) and continuous phase propagation (`computeContinuousTrackPhases`).
   - Elongated shared turnout bearers ($2.5\text{ m} \to 4.9\text{ m}$) via `HostTrackSpatialIndex` ($8\text{ m} \times 8\text{ m}$ cells) and multi-interval Minkowski clipping (`subtractIntervalFromList`).
   - $128\text{ m} \times 128\text{ m}$ spatial chunking for frustum culling.
   - 3D bridge structure synthesis (`buildBridgeProfile3D`, piers, parapets) and 3D tunnel portals/traces.
   - Complete `faceRanges` and `instanceInfos` OSM raycasting metadata.

### 1.2 Discrepancies Between Current Code and Previous Planning Docs
- **Discrepancy 1: `topologyRailways=graph` resolution**:
  - `docs/goalpost-2-plan.md` implied `graph` mode would be wired during Stage E2. In reality, `InfrastructureRenderAdapter.ts` lines 57–60 and line 108 explicitly state:
    > "Graph-driven railway rendering `'graph'` remains deferred to Stage E3; setting `topologyRailways=graph` in Stage E2 resolves safely to `'legacy'`."
  - Therefore, the runtime engine currently runs `buildRailwayInfrastructure` directly on `data.railways` (the unsimplified, chained GeoJSON array). The graph descriptors created in E1 are validated in `InfrastructureRenderAdapter.test.ts` but are **not yet consumed by the 3D scene builder**.
- **Discrepancy 2: Geometric switch-blade tapering vs. Graph switch confirmation**:
  - `RailwayGeometryBuilder.ts` currently detects turnout branches using purely geometric coordinate proximity (`isTurnoutThroatPair`: distance $< 0.55\text{ m}$ and $\cos\theta > 0.86$). It does not check whether the switch was confirmed by `RailwayNetworkBuilder` (`hasConfirmedSwitchAtStart` / `turnoutStatus === 'confirmed'`).
- **Discrepancy 3: Ballast overlaps in station throats**:
  - The current renderer generates a separate $3.5\text{ m}$-wide UV ribbon for every track's ballast bed. In dense station throats (e.g. Amsterdam Centraal, Station Hengelo), parallel tracks at $3.8\text{ m}$–$4.2\text{ m}$ centers leave overlapping ballast ribbon edges ($0.5\text{ m}$–$0.7\text{ m}$ overlap), causing coplanar triangle redundancy and micro-z-fighting at low tilt angles.

---

## 2. Recommended Architecture

### 2.1 Domain Separation & Data Flow

```
                      ProcessedMapData
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
      data.topologySource                data.railways
            │                                 │
            ▼                                 │
   buildInfrastructureGraph()                 │
            │                                 │
            ▼                                 │
InfrastructureRenderDescriptorBundle          │
            │                                 │
            ▼                                 ▼
  ┌───────────────────────┐         ┌──────────────────┐
  │ Stage E3 Graph Engine │         │ Legacy Engine    │
  │ (topologyRailways =   │         │ (default)        │
  │  'graph' | 'graph-R+')│         └──────────────────┘
  └───────────┬───────────┘
              │
    ┌─────────┴─────────────────────────────────┐
    ▼                                           ▼
At-Grade Rails & Sleepers               Ballast Strategy Dispatch
- Steel Rails (UvRibbon3D / Extrusion)  - 'legacy' / 'graph':
- Sleepers (InstancedMesh / Bearers)      Continuous Track UV Ribbons
  Consumes confirmed switch topology    - 'graph-R+' (Surface-First):
  from RailwayEdgeRenderDescriptor.       Rounded footprint union per
                                          provenance segment + planar
                                          mesh consolidation
```

### 2.2 Preserving ADR-0008: What Must NOT Change
To preserve Candidate B's proven performance and visual stability:
1. **Steel rails are NEVER clipped by 2D Booleans**: Rails remain $1.635\text{ m}$ center-to-center continuous ribbons/extrusions.
2. **Sleeper placement remains longitudinal & track-aligned**: Sleepers are placed at $0.725\text{ m}$ (close zoom) along track tangents, with phase synchronization and Minkowski lateral clipping.
3. **Turnout bearers remain specialized 3D boxes**: Elongated bearers ($2.5\text{ m} \to 4.9\text{ m}$) under switches are driven by `HostTrackSpatialIndex` and informed by confirmed graph switch nodes.
4. **Spatial chunking ($128\text{ m} \times 128\text{ m}$) is preserved**: Output geometries are partitioned into chunks to maintain frustum culling.
5. **Theme updates & resource disposal remain idempotent**: In-place color updates on materials without buffer reallocation.

---

## 3. Surface-First Railway Ballast (R+): Feasibility Assessment

### 3.1 Physical Nature of Ballast vs. Road Carriageways
Unlike roads—which feature distinct material classes (`primary` asphalt vs. `cycleway` paving stones vs. `footway` concrete) with hierarchical right-of-way ownership—railway ballast is an **undifferentiated, single-material aggregate** (granite/basalt crushed stone at $Y = +0.060\text{ m}$) across all connected tracks:
- In open corridors, each track has an individual $3.5\text{ m}$ shoulder-tapered bed.
- In multi-track corridors and station throats, adjacent ballast beds coalesce physically into a **single continuous ballast apron**.
- At turnout switches, the diverging track's ballast merges seamlessly into the mainline bed.

### 3.2 Evaluation of Architectural Options

| Strategy | Description | Pros | Cons / Risks | Recommendation |
| :--- | :--- | :--- | :--- | :--- |
| **Option 1: Direct reuse of E2+ `bufferSurfaceFirstRoadCenterline`** | Buffer each railway edge into rectangles + 16-gon disks, then use class-ordered difference clipping. | Reuses code directly. | **Flawed fit**: Railways have no road-class hierarchy. Subtracting track B from track A based on arbitrary edge ID creates artificial internal boundary cuts in an otherwise homogeneous ballast yard. | **Reject** |
| **Option 2: Continuous Ballast Apron Union (`R+`)** | Buffer at-grade track centerlines into $3.5\text{ m}$ (or $2.5\text{ m}$ tram) rounded-corner footprints, **union all overlapping same-layer ballast beds** into a single consolidated multi-polygon per connected component, and triangulate via `earcut`. | Eliminates 100% of internal ballast overlaps in station throats; produces seamless yards; reduces triangle count; no false internal seams. | Loss of 1:1 track faceRanges unless provenance is re-attributed to nearest track centerline via spatial tagging. | **Adopt as experimental opt-in (`topologyRailways: 'graph-R+'`)** |
| **Option 3: Retain existing UV-ribbon ballast** | Each track emits an independent $3.5\text{ m}$ quad strip. | Zero risk; already works; exact 1:1 track provenance. | Redundant coplanar triangles ($0.5\text{ m}$–$0.7\text{ m}$ overlap) in multi-track corridors. | **Retain as default & fallback** |

### 3.3 Boundary Conditions & Constraints for Surface-First Ballast
1. **Vertical Isolation**:
   - `R+` planar union applies **only to at-grade railways** (`layer === 0 && !isBridge && !isTunnel`).
   - Elevated bridges ($+2.860\text{ m}$) and subterranean tunnels ($-2.000\text{ m}$) remain strictly separate 3D profiles. Planar Booleans are never evaluated across layers.
2. **Track End Caps**:
   - Buffer tracks with round end-caps at dead ends / buffer stops (`degree === 1`).
   - Suppress caps at boundary clips (`clippedAtStart`/`clippedAtEnd`) and at grade-transition portals where tracks hand off to bridges/tunnels.
3. **Internal Provenance Boundaries**:
   - Where simplified graph edges join chained OSM ways of equal width, no internal join disks are needed. Where widths transition (e.g. tram $2.5\text{ m}$ meeting heavy rail $3.5\text{ m}$), a single deterministic transition disk is placed.
4. **Provenance Attribution for Consolidated Ballast**:
   - Since `polygonClipping.union` merges adjacent track footprints, triangle faces in the merged ballast mesh must be attributed to tracks. Because ballast is non-interactive in normal inspection (users click rails or sleepers to inspect track data), the merged ballast mesh can either maintain `faceRanges` via centroid-to-nearest-centerline association or assign ownership to the primary mainline track.

---

## 4. Graph-Driven Railway Rendering Specification (Stage E3)

### 4.1 Consuming Railway Descriptors
In `buildGraphRailwayGeometries()`:
1. **Input**: `descriptors: InfrastructureRenderDescriptorBundle`.
2. **Filtering**:
   - At-grade buildable tracks: `edge.layer === 0 && !edge.isBridge && !edge.isTunnel`.
   - Bridges: `edge.isBridge || edge.layer > 0`.
   - Tunnels: `edge.isTunnel || edge.layer < 0`.
3. **Switch Geometry Optimization via Confirmed Graph Topology**:
   - Currently, `isTurnoutThroatPair` runs $O(N^2)$ spatial proximity queries to find switch toes.
   - With `RailwayNodeRenderDescriptor`:
     - Nodes where `turnoutStatus === 'confirmed'` explicitly name `trunkEdgeId`, `mainBranchEdgeId`, and `divergingBranchEdgeId`.
     - The diverging branch edge receives `hasConfirmedSwitchAtStart` (or end).
     - Switch-blade tapering (`aSwitchTaper` from $0.32\text{ m} \to 1.0\text{ m}$ over $3.2\text{ m}$) is triggered **deterministically from the verified graph node**, completely eliminating geometric false positives on colinear chained tracks!
4. **Unresolved Switch Topology**:
   - Where a degree-3 node has `turnoutStatus === 'unresolved_main_vs_diverging'` or `'unresolved_throat'`, both branches are rendered with standard continuous rails without blade tapering, and `diagnostics.unresolvedRailwaySwitchNodeIds` is populated. No broken geometry is emitted.
5. **Flat Diamond Crossings (`RailwayFlatCrossingRenderDescriptor`)**:
   - Explicitly enforces `allowsBranchInterchange: false`.
   - Both track centerlines pass through the crossing continuously.
   - Rails cross at physical angle $\theta$.
   - Sleepers under both tracks are clipped via existing multi-interval clipping (`subtractIntervalFromList`), preserving both left and right sleeper ears without creating a solid timber floor.

### 4.2 Independent Renderer Selection & Fallback

Extend `InfrastructureRenderOptions`:
```typescript
export type RailwayInfrastructureRenderSource =
  | 'legacy'          // Production default: unsimplified data.railways via Candidate B
  | 'graph-preview'  // Stage E1: build descriptors alongside legacy renderer
  | 'graph'          // Stage E3: graph-driven rails/sleepers + ribbon ballast
  | 'graph-R+';       // Stage E3 experimental: graph-driven rails/sleepers + surface-first ballast
```

In-app selection via DevTools and URL parameters:
- `?topologyRailways=legacy`
- `?topologyRailways=graph-preview`
- `?topologyRailways=graph`
- `?topologyRailways=graph-R+`

Safe fallback: If descriptor consumption fails or yields empty geometry, the builder falls back to the legacy track representation and logs a diagnostic code.

---

## 5. Staged Implementation Plan

We propose structuring Milestone 2.3-E3 into 4 sequential stages:

```
┌─────────────────────────────────────────────────────────────┐
│ E3-A: Graph-Driven Railway Integration                      │
│ - Wire RailwayEdge/NodeRenderDescriptors into renderer      │
│ - Replace geometric switch detection with confirmed graph   │
│ - Retain UV-ribbon ballast; verify bit-for-bit regression   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ E3-B: Experimental Surface-First Ballast (R+)               │
│ - Implement RailwayBallastFootprints.ts                     │
│ - Opt-in 'graph-R+' mode for at-grade ballast               │
│ - Preserve bridges/tunnels on 3D profile pipeline           │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ E3-C: Geometry Validation & Performance Baseline            │
│ - SurfaceFirstRailwayValidator.ts (overlap, coverage, gauge)│
│ - Benchmark across Switchyard, Hengelo, Amsterdam Centraal  │
│ - Measure memory, build time, and draw calls                │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ E3-D: Review & Decision Gate                                │
│ - Compare R+ vs. ribbon ballast across all metrics          │
│ - Project owner visual sign-off                             │
│ - Determine whether to adopt, refine, or reject R+          │
└─────────────────────────────────────────────────────────────┘
```

### Stage E3-A: Graph-Driven Railway Integration
- **Objective**: Feed `descriptors.railwayEdges`, `descriptors.railwayNodes`, and `descriptors.railwayFlatCrossings` into `RailwayGeometryBuilder.ts`.
- **Key Changes**:
  - Add `buildGraphRailwayGeometries()` function in `RailwayGeometryBuilder.ts`.
  - Drive switch-blade taper from `edge.hasConfirmedSwitchAtStart/End` instead of fuzzy proximity.
  - Map multi-segment provenance (`#seg0`, `#seg1`) to track `InspectableFeatureInfo`.
  - Wire `?topologyRailways=graph`.
- **Acceptance Criteria**:
  - `npm test` passes without regression.
  - Station Hengelo and Amsterdam Centraal render identical rail/sleeper geometry to Candidate B baseline.
  - Switch-blade tapering verified on confirmed switches; suppressed on colinear chained tracks.
- **Estimated Complexity**: Medium (2–3 engineering days).

### Stage E3-B: Experimental Surface-First Ballast (R+)
- **Objective**: Implement continuous consolidated ballast footprint generation for at-grade tracks under `roads: 'graph-R+'`.
- **Key Changes**:
  - Create `src/world/infrastructure/railways/RailwayBallastFootprints.ts`.
  - Buffer at-grade track centerlines with radius $w/2$ ($1.75\text{ m}$ for rail, $1.25\text{ m}$ for tram).
  - Apply round caps at terminal dead ends; suppress at boundary clips and grade transitions.
  - Union overlapping footprints per connected component via `polygonClipping.union` and condition via `conditionRing`.
  - Triangulate via `THREE.ShapeGeometry` at $Y = +0.060\text{ m}$.
  - Leave rails, sleepers, bridges, and tunnels completely on their existing pipelines.
- **Acceptance Criteria**:
  - In multi-track corridors, adjacent ballast beds coalesce into a single non-overlapping mesh.
  - Zero coplanar overlap between adjacent ballast beds.
  - Fallback to ribbon ballast if union fails.
- **Estimated Complexity**: Medium (2–3 engineering days).

### Stage E3-C: Geometry Validation & Performance Baseline
- **Objective**: Implement automated validation checks and collect performance instrumentation.
- **Key Changes**:
  - Create `src/world/infrastructure/railways/SurfaceFirstRailwayValidator.ts`:
    - Ballast coplanar overlap check ($< 1\text{ mm}^2$ tolerance).
    - Ballast coverage of track centerlines (analytical corridor check).
    - Rail gauge and centerline continuity verification.
    - Sleeper support coverage ($100\%$ of rails supported by sleeper/bearer boxes).
    - Provenance attribution audit.
  - Instrument `GraphRailwayRenderStats` and `GraphRailwayGenerationTiming`.
  - Create `scripts/run-railway-baseline.ts` benchmarking Synthetic Switchyard, Station Hengelo, and Amsterdam Centraal across `legacy`, `graph`, and `graph-R+`.
- **Acceptance Criteria**:
  - Measurable comparison table generated in `research/railway-rendering/baseline-results.json`.
  - Zero degenerate triangles, zero inverted winding, and zero unhandled exceptions.
- **Estimated Complexity**: Medium (2 engineering days).

### Stage E3-D: Review & Decision Gate
- **Objective**: Formal evaluation of R+ against production requirements.
- **Possible Outcomes**:
  1. *Adopt R+*: Demonstrable improvement in visuals and reduction in redundant triangles without performance degradation.
  2. *Hybrid Adoption*: Keep R+ for complex station throats; keep ribbon ballast for isolated open lines.
  3. *Reject R+*: Retain graph-driven Candidate B ribbon ballast if Boolean union overhead exceeds visual benefit.
- **Estimated Complexity**: 1 engineering day (reporting and sign-off).

---

## 6. Specific File-Level Changes

### 6.1 Existing Files to Modify
1. `src/world/infrastructure/rendering/InfrastructureRenderAdapter.ts`:
   - Expand `RailwayInfrastructureRenderSource` to `'legacy' | 'graph-preview' | 'graph' | 'graph-R+'`.
   - Update `parseRailwayInfrastructureRenderSource()` to accept `'graph'` and `'graph-R+'`.
2. `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`:
   - Add `buildGraphRailwayInfrastructure()` entry point accepting `InfrastructureRenderDescriptorBundle`.
   - Connect confirmed switch descriptors to rail tapering.
   - Dispatch ballast generation based on `options.ballastMode ('ribbon' | 'surface-first')`.
3. `src/world/GeometryBuilder.ts`:
   - Update Stage 5 dispatch: pass `infrastructureRenderPreview` to `buildRailwayInfrastructure` when `topologyRailways !== 'legacy'`.
4. `src/components/DevToolsPanel.tsx`:
   - Add `Graph (E3)` and `Graph Surface (R+)` options to the Railway Engine selector.
5. `docs/STATUS.md`, `docs/road-rendering-roadmap.md`, `docs/architecture.md`:
   - Update milestone progress and documentation.

### 6.2 New Files Genuinely Required
1. `src/world/infrastructure/railways/RailwayBallastFootprints.ts` (~250 lines):
   - Ballast centerline footprint buffering, terminal cap logic, and connected-component Boolean union.
2. `src/world/infrastructure/railways/SurfaceFirstRailwayValidator.ts` (~500 lines):
   - Automated non-circular ballast coverage, coplanar overlap, rail gauge, and sleeper support validation.
3. `src/world/GraphRailwayRendering.test.ts` (~800 lines):
   - Comprehensive unit and integration test suite covering Stages E3-A, E3-B, and E3-C.
4. `scripts/run-railway-baseline.ts` (~400 lines):
   - Automated benchmark script measuring build timings, triangle counts, and memory across test extracts.
5. `research/railway-rendering/baseline-results.json` & `README.md`:
   - Recorded benchmark baseline data and analysis.

---

## 7. Validation Strategy & Automated Criteria

### 7.1 Automated Validation Suite (`SurfaceFirstRailwayValidator.ts`)
1. **Ballast Surface Coverage (A1)**:
   - Independent analytical corridor check: Every track centerline must be covered by ballast out to $|v| \le \text{ballastWidth}/2 - 0.05\text{ m}$.
   - Detects missing ballast, unintended interior voids, or gaps at switches.
2. **Coplanar Overlap (A2)**:
   - Reuses `ZFightingValidator` at $Y = +0.060\text{ m}$.
   - For `graph-R+`: Asserts **`0` positive-area coplanar overlaps** ($> 1\text{ mm}^2$) across all at-grade ballast beds.
3. **Rail Geometry & Gauge Integrity (A3)**:
   - Verifies inner gauge ($1.435\text{ m} \pm 0.005\text{ m}$) along rail polylines.
   - Verifies vertical rail elevation profile ($Y = +0.085\text{ m}$ at-grade).
   - Verifies switch-blade taper length ($3.2\text{ m}$) at confirmed switches.
4. **Sleeper Support Coverage (A4)**:
   - Samples rails at $0.15\text{ m}$ intervals; asserts $100\%$ support by sleeper/bearer boxes with maximum unsupported span $\le 1.65\text{ m}$.
   - Asserts `0` inter-track sleeper OBB overlaps via SAT.
5. **Source-Feature Provenance (A5)**:
   - Verifies that raycasting against rails and sleepers returns correct `sourceFeatureId`, `sourceFeatureIds`, `subtype`, and `osmTags`.
6. **Determinism (A6)**:
   - Shuffling input GeoJSON feature order must produce bit-for-bit identical vertex and index arrays.

---

## 8. Performance Baseline Strategy

### 8.1 Metrics to Measure
1. **Execution Time (CPU Wall-Clock)**:
   - `totalRailwayGenerationTimeMs`
   - `ballastConstructionTimeMs` (buffering vs. union vs. triangulation)
   - `sleeperPlacementTimeMs`
   - `railExtrusionTimeMs`
   - `spatialChunkingTimeMs`
2. **Geometric Output**:
   - Total railway triangles and vertices.
   - Triangle count breakdown by component: Ballast, Sleepers (3D / UV), Rails (3D / UV), Structures.
   - Number of draw calls and `THREE.InstancedMesh` instances.
3. **Memory & Lifecycle**:
   - Peak GPU buffer memory.
   - Idempotent disposal check: `0` leaked geometries or materials after 5 scene rebuild cycles.

### 8.2 Benchmark Datasets
1. **Synthetic Switchyard (65 ways)**:
   - Dense turnouts, parallel tracks, ladder crossovers, and scissors crossing.
2. **Station Hengelo (67 ways)**:
   - Real Dutch regional station throat with mixed mainline, sidings, and platform tracks.
3. **Amsterdam Centraal (160 ways)**:
   - Dense multi-track urban terminal throat with high crossover complexity.

---

## 9. Risks and Unresolved Questions

1. **Risk 1: Boolean Union Overhead on Dense Rail Yards**:
   - *Risk*: `polygonClipping.union` on 160 track footprints in Amsterdam Centraal could take several seconds if evaluated globally.
   - *Mitigation*: Partition tracks into connected spatial clusters (connected components) using `HostTrackSpatialIndex` bounding boxes before unioning. Never pass the entire city's tracks into a single monolithic union.
2. **Risk 2: Ballast FaceRange Provenance Loss**:
   - *Risk*: Unioning two parallel track ballast beds merges their polygons, losing individual track IDs.
   - *Mitigation*: Raycasting against ballast can attribute to the nearest track centerline, or users can inspect rails/sleepers (which retain 100% distinct track identity).
3. **Risk 3: Grade-Separation Boundary Artifacts**:
   - *Risk*: Tracks transitioning to bridges or tunnels might create seams with at-grade ballast.
   - *Mitigation*: Strictly isolate at-grade tracks from bridge/tunnel profiles. Suppress ballast end-caps at grade-transition portal nodes so bridge ballast abutments meet at-grade ballast flush.
4. **Risk 4: Tram vs. Heavy Rail Width Mismatches**:
   - *Risk*: Where a $2.5\text{ m}$ tram track meets a $3.5\text{ m}$ railway track, unioning could create narrow pinch points.
   - *Mitigation*: Condition polygon rings with `conditionRing` (which already handles sub-millimeter fold-backs).

---

## 10. Suggested Ticket Breakdown

Following [`docs/ticket-workflow.md`](../docs/ticket-workflow.md), this milestone naturally maps to four sequential tickets:

1. **`TKT-010` (Stage E3-A): Graph-Driven Railway Renderer Integration**:
   - Wire `RailwayEdgeRenderDescriptor`, `RailwayNodeRenderDescriptor`, and `RailwayFlatCrossingRenderDescriptor` into `RailwayGeometryBuilder.ts`.
   - Replace heuristic turnout detection with confirmed graph switch topology.
   - Expose `?topologyRailways=graph`.
   - Verify legacy regression equivalence.
2. **`TKT-011` (Stage E3-B): Experimental Surface-First Ballast Footprints (R+)**:
   - Implement `RailwayBallastFootprints.ts` for at-grade track union.
   - Expose `?topologyRailways=graph-R+`.
   - Verify non-interference with bridges, tunnels, rails, and sleepers.
3. **`TKT-012` (Stage E3-C): Railway Geometry Validation & Performance Baseline**:
   - Implement `SurfaceFirstRailwayValidator.ts` and automated regression suite `src/world/GraphRailwayRendering.test.ts`.
   - Build `scripts/run-railway-baseline.ts` and generate `research/railway-rendering/baseline-results.json`.
4. **`TKT-013` (Stage E3-D): Railway Renderer Review & Production Promotion Gate**:
   - Review baseline data with project owner.
   - Evaluate whether R+ should be promoted to default, kept as opt-in, or rejected in favor of Candidate B ribbon ballast.

---

## 11. Smallest Useful First Implementation Task

When implementation is authorized, the **smallest useful first implementation task** should be:

> **Stage E3-A: Consume `RailwayEdgeRenderDescriptor` in `RailwayGeometryBuilder.ts` under `topologyRailways='graph'` with unchanged UV-ribbon ballast.**

### Why This Must Be First:
1. **Zero Geometry Risk**: It verifies that graph-driven descriptors can power Candidate B's existing rail, sleeper, and ballast meshes with **zero changes to visual output**.
2. **Decouples Topology from Surface Booleans**: If graph consumption introduces a defect in rail placement or switch blade tapering, it will be caught immediately without confusing it with polygon clipping bugs.
3. **Establishes the Clean Baseline**: Stage E3-B (`R+` surface-first ballast) requires a stable graph-driven railway pipeline to test against. Building R+ directly on raw GeoJSON would recreate the coupling errors of earlier milestones.
4. **Immediate Value**: It connects verified switch nodes (`hasConfirmedSwitchAtStart`) to switch-blade tapering, eliminating the geometric false positives of the current fuzzy proximity check.
