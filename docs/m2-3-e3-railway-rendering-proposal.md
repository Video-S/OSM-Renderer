# Implementation Proposal: Milestone 2.3-E3 — Graph-Driven Railway Rendering & Surface-First Ballast (R+)

- **Target Milestone**: Milestone 2.3 Stage E3 (`M2.3-E3`)
- **Status**: Proposal / Specification (Approved Architectural Direction; Stage E3-A1 Authorized)
- **Author**: Core Infrastructure & Rendering Engineering
- **Date**: 2026-11-09 (Updated with Project Owner Corrections)
- **Governing ADRs**: 
  - [`ADR-0008: Hybrid Railway Rendering and UV-Ribbon Architecture`](../docs/decisions/ADR-0008-hybrid-railway-rendering-and-uv-ribbon-architecture.md) (Authoritative for Candidate B production railway renderer)
  - [`ADR-0009: Infrastructure Graph Topology`](../docs/decisions/ADR-0009-infrastructure-graph-topology.md) (Authoritative for railway graph, switches, and flat crossings)
  - [`ADR-0010: Surface-First At-Grade Road Rendering (E2+)`](../docs/decisions/ADR-0010-surface-first-road-rendering.md) (Preferred architectural pattern for planar surface occupancy)

---

## Executive Summary

Following the success of **E2+** (`roads: 'graph-surface'`) in eliminating junction patch fragility and achieving zero coverage defects and zero coplanar overlap across all 12 benchmark datasets, this proposal evaluates applying graph-driven descriptor consumption and surface-first footprint principles to the railway domain in **Milestone 2.3-E3**.

### Core Architectural Axiom: Physical Component Separation

Railway rendering encompasses fundamentally different physical layers that must **not** be treated as a single uniform geometric problem:

1. **Steel Rails ($Y = +0.180\text{ m}$)**: Physical 1D extrusion / track-aligned continuous ribbons governed strictly by **topological track continuity**, switch-blade tapering, and precise geometric gauge ($1.435\text{ m}$ inner / $1.635\text{ m}$ visual center-to-center). **Steel rails must NEVER be subject to 2D Boolean clipping.**
2. **Sleepers / Bearers ($Y = +0.075\text{ m}$)**: Discrete track-perpendicular beams with longitudinal phase coherence, transverse extensions across turnout throats ($2.5\text{ m} \to 4.9\text{ m}$), and multi-interval parallel track clipping. Sleepers are governed by spatial clearance and phase matching, not 2D polygon clipping.
3. **Ballast Bed (Crushed Stone, $Y = +0.060\text{ m}$)**: An undifferentiated granular aggregate substrate supporting tracks. **Only the ballast bed is a genuine candidate for surface-first 2D footprint buffering and union (R+)**.
4. **Grade-Separated Bridges & Tunnels ($Y = +2.860\text{ m}$ / $Y = -2.000\text{ m}$)**: 3D sloped approach ramps, concrete piers, parapets, and recessed subterranean portals governed by 3D vertical elevation profiles. Planar 2D Booleans cannot represent 3D grade transitions.

### Guiding Principles & Scope Decoupling

- **Topology determines connectivity.** Geometry determines physical representation. **Surface occupancy does not create topology.**
- Two tracks can have overlapping ballast despite having zero graph connection (e.g. parallel tracks or yard sidings). Spatial footprint overlap must **never** synthesize an edge in the railway graph.
- Stage E3 is decoupled into five phased stages: **E3-A1** (Descriptor Integration), **E3-A2** (Graph-Informed Switch Semantics), **E3-B** (Experimental Surface-First Ballast R+), **E3-C** (Comprehensive Validation & Benchmarks), and **E3-D** (Review & Decision Gate).
- Candidate B (`ADR-0008`) remains the verified production default (`topologyRailways='legacy'`). Graph-driven railway rendering is introduced under `topologyRailways='graph'` and experimental surface-first ballast under `topologyRailways='graph-R+'`.

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

### 1.2 Discrepancies and Clarifications Between Code and Plans

- **Discrepancy 1: `topologyRailways=graph` resolution**:
  - `docs/goalpost-2-plan.md` implied `graph` mode would be wired during Stage E2. In reality, `InfrastructureRenderAdapter.ts` explicitly deferred graph railway rendering:
    > "Graph-driven railway rendering `'graph'` remains deferred to Stage E3; setting `topologyRailways=graph` in Stage E2 resolves safely to `'legacy'`."
  - Therefore, the runtime engine currently runs `buildRailwayInfrastructure` directly on `data.railways` (the unsimplified, chained GeoJSON array). The graph descriptors created in E1 are validated in tests but are **not yet consumed by the 3D scene builder**.
- **Discrepancy 2: Geometric switch-blade tapering vs. Graph switch confirmation**:
  - `RailwayGeometryBuilder.ts` currently detects turnout branches using purely geometric coordinate proximity (`isTurnoutThroatPair`: distance $< 0.55\text{ m}$ and $\cos\theta > 0.86$).
  - In Stage E3-A1, this existing proximity heuristic is intentionally preserved to maintain exact geometry generation parity.
  - In Stage E3-A2, confirmed graph switch topology (`RailwayNodeRenderDescriptor.turnoutTopology`) will be introduced to unambiguously designate trunk, main, and diverging branches.
- **Discrepancy 3: Ballast Spacing and Overlap Realities**:
  - A previous assumption asserted that $3.5\text{ m}$ ballast beds on tracks spaced $3.8\text{ m}$–$4.2\text{ m}$ apart overlap by $0.5\text{ m}$–$0.7\text{ m}$.
  - **Correction**: With constant-width $3.5\text{ m}$ beds, parallel tracks at standard Dutch $3.8\text{ m}$–$4.2\text{ m}$ centers actually leave a $0.3\text{ m}$–$0.7\text{ m}$ inter-track gap. Overlaps do **not** occur on regular parallel open-line tracks.
  - Overlaps *do* occur at turnouts, crossovers, scissors crossings, flat diamond crossings, and closely spaced tracks ($< 3.5\text{ m}$ center-to-center spacing, such as converging station throats or yard sidings).
  - The actual prevalence of coplanar ballast overlap must be empirically measured across benchmark extracts. Potential reductions in triangle count, CPU time, or draw calls under R+ remain working hypotheses that require rigorous benchmarking in Stage E3-C.

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
    buildInfrastructureGraph()                │
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
  Stage E3-A1: Existing rules             - 'graph-R+' (Surface-First):
  Stage E3-A2: Confirmed switch topology   Spatial footprint union per
  from RailwayNodeRenderDescriptor.        connected component + planar
                                           triangulation with provenance
```

### 2.2 Preserving ADR-0008: What Must NOT Change
To preserve Candidate B's proven performance and visual stability:
1. **Steel rails are NEVER clipped by 2D Booleans**: Rails remain $1.635\text{ m}$ center-to-center continuous ribbons/extrusions.
2. **Sleeper placement remains longitudinal & track-aligned**: Sleepers are placed at $0.725\text{ m}$ (close zoom) along track tangents, with phase synchronization and Minkowski lateral clipping.
3. **Turnout bearers remain specialized 3D boxes**: Elongated bearers ($2.5\text{ m} \to 4.9\text{ m}$) under switches are driven by `HostTrackSpatialIndex`.
4. **Spatial chunking ($128\text{ m} \times 128\text{ m}$) is preserved**: Output geometries are partitioned into chunks to maintain frustum culling.
5. **Theme updates & resource disposal remain idempotent**: In-place color updates on materials without buffer reallocation.

---

## 3. Surface-First Railway Ballast (R+): Feasibility Assessment

### 3.1 Physical Nature of Ballast vs. Road Carriageways

Unlike roads—which feature distinct material classes (`primary` asphalt vs. `cycleway` paving stones vs. `footway` concrete) with hierarchical right-of-way ownership—railway ballast is an **undifferentiated, single-material aggregate** (granite/basalt crushed stone at $Y = +0.060\text{ m}$) across all connected tracks:
- In open corridors, each track has an individual $3.5\text{ m}$ shoulder-tapered bed.
- In converging station throats, crossovers, and tight sidings, adjacent ballast beds coalesce physically into a continuous ballast apron.
- At turnout switches, the diverging track's ballast merges seamlessly into the mainline bed.

### 3.2 Evaluation of Architectural Options

| Strategy | Description | Pros | Cons / Risks | Recommendation |
| :--- | :--- | :--- | :--- | :--- |
| **Option 1: Direct reuse of E2+ `bufferSurfaceFirstRoadCenterline` with class clipping** | Buffer each railway edge into rectangles + 16-gon disks, then use class-ordered difference clipping. | Reuses code directly. | **Flawed fit**: Railways have no road-class hierarchy. Subtracting track B from track A based on arbitrary edge ID creates artificial internal boundary cuts in an otherwise homogeneous ballast yard. | **Reject** |
| **Option 2: Continuous Ballast Apron Union (`R+`) via Spatial Intersection** | Buffer at-grade track centerlines into $3.5\text{ m}$ (or $2.5\text{ m}$ tram) rounded footprints, group by spatial footprint intersection into connected components, union overlapping same-layer footprints via `polygonClipping.union`, and triangulate via `earcut`. | Eliminates redundant coplanar overlap where tracks converge; produces seamless yards; no false internal seams. | Additional Boolean union time; potential triangle count changes must be benchmarked; requires robust multi-source provenance attribution. | **Adopt as experimental opt-in (`topologyRailways: 'graph-R+'`)** |
| **Option 3: Retain existing UV-ribbon ballast** | Each track emits an independent $3.5\text{ m}$ quad strip. | Zero risk; already works; exact 1:1 track provenance. | Coplanar triangle overlap at turnouts, crossovers, and tracks $< 3.5\text{ m}$ apart. | **Retain as default & fallback** |

### 3.3 Boundary Conditions & Provenance Attribution for Surface-First Ballast

1. **Separation of Ballast Connectivity from Railway Topology**:
   - Two tracks can have overlapping ballast despite having zero graph connection.
   - Union candidates are determined **purely through spatial footprint intersection** (e.g., bounding-box spatial index overlap), while preserving vertical layer and grade separation boundaries (`layer === 0 && !isBridge && !isTunnel`).
   - The railway graph is used for switches, track continuity, and traversal semantics—**never create graph connections merely because ballast footprints intersect**.
2. **Vertical Isolation**:
   - `R+` planar union applies **only to at-grade railways** (`layer === 0 && !isBridge && !isTunnel`).
   - Elevated bridges ($+2.860\text{ m}$) and subterranean tunnels ($-2.000\text{ m}$) remain strictly separate 3D profiles. Planar Booleans are never evaluated across layers.
3. **Deterministic OSM Provenance Attribution**:
   - An anonymous unioned ballast mesh is unacceptable. Two attribution strategies must be supported:
     - **Spatial Partitioning (Voronoi / Mid-Perpendicular Clipping)**: In non-overlapping sections, faces carry single-track source attribution. In overlapping zones, faces are partitioned along the medial axis between track centerlines.
     - **Multi-Source Attribution**: Overlapping ballast triangles carry an array of contributing source feature IDs in `InspectableFeatureInfo.sourceFeatureIds`, allowing raycasting to highlight all co-located track lines.
   - Rails and sleepers retain 100% individual track attribution regardless of ballast merging.

---

## 4. Staged Implementation Plan (Decoupled E3-A1 through E3-D)

```
┌─────────────────────────────────────────────────────────────┐
│ E3-A1: Descriptor Integration (AUTHORIZED)                  │
│ - Wire RailwayEdgeRenderDescriptor into Candidate B         │
│ - Preserve existing turnout detection, sleepers, ballast    │
│ - Retain UV-ribbon ballast; verify strict regression parity │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ E3-A2: Graph-Informed Switch Semantics (UNAUTHORIZED)       │
│ - Consume RailwayNodeRenderDescriptor.turnoutTopology       │
│ - Identify trunk, main, and diverging branches              │
│ - Handle unresolved switches conservatively; test semantics │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ E3-B: Experimental Surface-First Ballast R+ (UNAUTHORIZED)  │
│ - Implement RailwayBallastFootprints.ts via spatial union   │
│ - Opt-in 'graph-R+' mode; multi-source provenance           │
│ - Ballast-specific geometry and provenance unit tests       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ E3-C: Comprehensive Validation & Benchmarks (UNAUTHORIZED)  │
│ - SurfaceFirstRailwayValidator.ts across all suites         │
│ - Benchmark Switchyard, Hengelo, Amsterdam Centraal         │
│ - Measure memory, build time, draw calls, triangle counts   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ E3-D: Review & Decision Gate (UNAUTHORIZED)                 │
│ - Formal review of R+ vs. ribbon ballast data               │
│ - Project owner visual sign-off                             │
│ - Decide whether to adopt, refine, or reject R+             │
└─────────────────────────────────────────────────────────────┘
```

### Stage E3-A1: Descriptor Integration (Current Active Scope)
- **Objective**: Adapt `descriptors.railwayEdges` into the Candidate B railway renderer under `topologyRailways='graph'`, preserving existing geometry synthesis rules.
- **Scope Limits**:
  - Keep existing `isTurnoutThroatPair` proximity detection.
  - Keep existing sleeper placement, ballast UV ribbons, and rail-taper behavior.
  - Do NOT modify switch semantics, change road rendering, or introduce surface-first ballast.
- **Verification**:
  - Regression suite comparing Legacy vs. Graph Candidate B outputs.
  - Verifies continuity, gauge, sleeper support, bridge/tunnel profiles, and provenance.
  - Initial baseline timing and geometry counters.

### Stage E3-A2: Graph-Informed Switch Semantics (Requires Separate Authorization)
- **Objective**: Replace proximity-based switch detection (`isTurnoutThroatPair`) with confirmed graph topology from `RailwayNodeRenderDescriptor.turnoutTopology`.
- **Key Concepts**:
  - `hasConfirmedSwitchAtStart/End` only identifies a confirmed switch node; `turnoutTopology` identifies which edge is the diverging branch versus main branch.
  - Taper only the diverging branch blade ($0.32\text{ m} \to 1.0\text{ m}$ over $3.2\text{ m}$).
  - Define conservative fallback for unresolved nodes (`unresolved_main_vs_diverging`, `unresolved_throat`).
- **Verification**: Switch-specific unit and integration tests.

### Stage E3-B: Experimental Surface-First Ballast (R+) (Requires Separate Authorization)
- **Objective**: Implement continuous consolidated ballast footprint generation for at-grade tracks under `topologyRailways='graph-R+'`.
- **Key Concepts**:
  - Spatial footprint intersection grouping; 2D planar union; earcut triangulation at $Y = +0.060\text{ m}$.
  - Multi-source provenance attribution and spatial ownership partitioning.
  - Independent from railway graph connectivity.
- **Verification**: Ballast coplanar overlap and provenance unit tests.

### Stage E3-C: Comprehensive Geometry Validation & Performance Baseline (Requires Separate Authorization)
- **Objective**: Execute comprehensive validation suite across all suites and measure empirical performance.
- **Key Concepts**:
  - `SurfaceFirstRailwayValidator.ts`: non-circular ballast coverage, coplanar overlap ($< 1\text{ mm}^2$), rail gauge ($1.435\text{ m} \pm 0.005\text{ m}$), sleeper support ($100\%$).
  - Measure triangle counts, CPU time, and draw calls across Synthetic Switchyard, Station Hengelo, and Amsterdam Centraal.

### Stage E3-D: Review & Decision Gate (Requires Separate Authorization)
- **Objective**: Project owner visual inspection and decision on whether to adopt, refine, or reject R+.

---

## 5. Renderer Selection & Diagnostics

Extend `RailwayInfrastructureRenderSource` in `src/world/infrastructure/rendering/InfrastructureRenderAdapter.ts`:

```typescript
export type RailwayInfrastructureRenderSource =
  | 'legacy'          // Production default: unsimplified data.railways via Candidate B
  | 'graph-preview'  // Stage E1: build descriptors alongside legacy renderer
  | 'graph'          // Stage E3-A1: graph-driven rails/sleepers + ribbon ballast
  | 'graph-R+';       // Stage E3-B experimental: graph-driven rails/sleepers + surface-first ballast
```

URL parameters and DevTools options:
- `?topologyRailways=legacy`
- `?topologyRailways=graph-preview`
- `?topologyRailways=graph`
- `?topologyRailways=graph-R+`

### Safe Fallback Contract
If graph descriptors are missing, corrupted, or empty when `topologyRailways='graph'` is selected:
1. Fall back gracefully to Candidate B with unsimplified `data.railways`.
2. Populate `diagnostics.railwayRendererFallback = 'legacy_due_to_missing_descriptors'`.
3. Never crash or silently leave an empty railway scene.
4. Guarantee zero duplicate meshes and idempotent disposal.

---

## 6. Ticket Breakdown

1. **`TKT-010` (Stage E3-A1): Railway Graph Descriptor Integration** (Active)
2. **`TKT-011` (Stage E3-A2): Graph-Informed Switch Semantics** (Planned)
3. **`TKT-012` (Stage E3-B): Experimental Surface-First Ballast Footprints (R+)** (Planned)
4. **`TKT-013` (Stage E3-C): Comprehensive Railway Validation & Benchmarks** (Planned)
5. **`TKT-014` (Stage E3-D): Railway Renderer Review & Promotion Gate** (Planned)
