# Current Project Status

## Product & Goalpost

- **Product**: Browser-based 3D OpenStreetMap Viewer
- **Active Goalpost**: **Goalpost 2: Infrastructure Topology, Railway Rendering, and Surface Markings** (Milestones 2.1 & 2.2 complete; Milestone 2.3 Stage A `M2.3-A` / `TKT-003`, Stage B `M2.3-B` / `TKT-004`, & Stage C `M2.3-C` / `TKT-005` complete & closed; Stage D `M2.3-D` / `TKT-006` implemented & `in_progress` pending project-owner review; Stage `E` requires explicit approval)
- **Architecture**: React 19 + TypeScript + Three.js r186 + React Three Fiber v9 + Tailwind CSS v4

---

## Implemented Capabilities (Verified)

1. **Map Ingestion & Processing**:
   - Ingestion of local GeoJSON datasets and live Overpass OSM API queries via `MapDataProvider`.
   - Strict separation between live multi-category OSM regional preset datasets (`/api/osm-data` in `server.ts`) and offline railway-only benchmark test extracts (`src/world/prototype/realOsmRailwayExtracts.json`).
   - Verified per-vertex OSM node ID preservation (`OsmNodeIdEnricher.ts`) across live Overpass JSON (`way.nodes`), OSM 0.6 XML (`<nd ref>`), and local GeoJSON (`nodes`, `nodeIds`, `_nodeIds`, `_nodeIdsByPart`) when way identity and 1:1 coordinate alignment are verified.
   - Non-destructive pre-deduplication and pre-chaining road, railway, and point-level infrastructure topology handoff (`ProcessedMapData.topologySource.roadParts`, `ProcessedMapData.topologySource.railwayParts`, and all five `InfrastructurePointKind` categories in `ProcessedMapData.topologySource.infrastructurePoints`: `railway_switch`, `railway_crossing_flat`, `railway_level_crossing`, `railway_ped_crossing`, and `highway_crossing`) alongside unchanged renderer-facing `mapData.roads` and `mapData.railways`.
   - WGS84 to local Euclidean metric Cartesian projection `(X, Y, Z)` anchored to the dataset origin.
   - Comprehensive diagnostic accounting tracking raw, classified, parsed, clipped, and rendered features.
2. **Infrastructure Topology — Road, Railway & Cross-Modal Graphs (`ADR-0009`, `M2.3-B` / `TKT-004`, `M2.3-C` / `TKT-005`, `M2.3-D` / `TKT-006`)**:
   - Pure-TypeScript OSMnx-style `RoadNetworkBuilder`, `RailwayNetworkBuilder`, `CrossModalAnalyzer`, and top-level `buildInfrastructureGraph` orchestrator (`src/world/infrastructure/topology/`) with zero React, Three.js, renderer, or WebGL dependencies.
   - Domain- and vertical-scope-isolated topological nodes (`road_node:${layer}|${isBridge}|${isTunnel}:*` and `rail_node:${layer}|${isBridge}|${isTunnel}:*`) with explicit OSM node precedence over `0.15 m` coordinate fallback and boundary-clipped endpoint isolation.
   - Interior OSM junction splitting, self-loops / P-loops, isolated closed loops (`loop_anchor`), parallel multi-edges (`parallelIndex`), `incidentHalfEdges` vs. `incidentEdgeIds` degree invariants, non-interstitial degree-2 simplification with road/railway attribute and one-way guards, pre-simplification protection of confirmed crossing and portal nodes, per-segment provenance (`reversedRelativeToSource`), and strict `1 mm` vertex-by-vertex duplicate detection.
   - Conservative railway turnout (`1-to-2` throat) classification (`confirmed`, `unresolved_main_vs_diverging`, `unresolved_throat`), non-interconnecting flat diamond crossing (`RailwayFlatCrossingRelation`) resolution with strict non-interchange between crossing tracks, complete unresolved four-arm railway crossing diagnostics across all three 4-arm arrangements (`2` interior occurrences, `1` interior + `2` endpoints, `4` endpoints, including `'ambiguous_railway_crossing_track_pairing'`), and conservative point-annotation matching (`diagnostics.unresolvedInfrastructurePoints`).
   - Cross-modal and vertical connectivity analysis (`CrossModalAnalyzer.ts`, `buildInfrastructureGraph`): confirmed vs. unresolved road/rail level crossings (`LevelCrossingRelation` for `road_rail_level_crossing` and `pedestrian_rail_crossing`, rejecting untagged 2D intersections and point-tag/tier conflicts), road crosswalk preservation (`highway_crossing` role), same-domain road and railway grade transitions (`GradeTransitionRelation` across Tier 1 explicit OSM portal nodes and Tier 2 `0.15 m` terminal collinear coordinate fallback, plus `0.80 m` diagnostic horizon in `UnresolvedGradeTransitionCandidate`), and grade-separated overpasses/underpasses (`GradeSeparatedCrossingRelation`).
3. **Procedural Geometry Synthesis**:
   - Uniform `ROAD_SURFACE = 0.050 m` at-grade road baseline with boundary-derived junction meshing and miter limits.
   - Carriageway-vs-path 2D Boolean clipping removing coplanar overlapping road surfaces.
   - Building prism vertical extrusions preserving complex 2D footprints and interior courtyard holes.
   - Hybrid multi-component railway geometry (`ADR-0008`, `TKT-001`, `TKT-002`) with crushed-stone ballast (`+0.060 m`), close-zoom (`> 4.5 CSS px/m`) 3D instanced sleepers (`+0.072 m`) and 3D extruded steel rails (`+0.085 m`), medium/far (`<= 4.5 CSS px/m`) derivative-filtered (`fwidth`) procedural UV-ribbons, elongated shared turnout bearers, multi-interval parallel-track sleeper clipping, and `128 m x 128 m` spatial chunking.
   - Grade-separated road and railway bridges rising to `+2.850 m` / `+2.860 m` with sloped approach ramps, concrete piers, and guardrail parapets.
   - Subterranean tunnels descending to `-2.000 m` with 3D entrance portals, recessed mouths, and dashed surface traces.
4. **Robust Geographic Boundary Clipping**:
   - Axis-aligned region bounding box clipping for polylines (Liang-Barsky with `clippedAtStart` / `clippedAtEnd` provenance) and polygons (Martínez-Rueda + topology-aware convex decomposition fallback).
   - MultiPolygon component separation for concave U-shaped polygons cut across the boundary.
5. **Isometric Camera Controls**:
   - Orthographic camera with isometric default tilt (55.4 degrees), 45 degrees view azimuth, and dynamic near/far plane calculation.
   - Full panning, orbiting, zooming, 45 degrees stepped rotation, and bounding-box reframing.
6. **Interactive Inspection & Styling**:
   - 4 built-in visual themes (`tactical`, `daylight`, `dusk`, `blueprint`) with in-place material updating.
   - Raycast feature inspection via `faceRanges` binary search and instanced sleeper `instanceInfos` mapping 3D faces/instances back to OSM tags.

---

## Known Limitations & Incomplete Capabilities

- **Single-Threaded Geometry Synthesis**: Large OSM queries (> 5,000 ways) execute polygon clipping and triangulation on the main browser thread; background web worker offloading is not yet implemented.
- **Local Metric Projection Range**: The equirectangular projection assumes a constant meridian radius and is optimized for neighborhood tiles up to ~5 km. Continental-scale streaming is out of scope.
- **Complex Multi-Level Stack Interchanges**: Highly skewed 5+ way junctions with overlapping flyover tiers rely on OSM layer tags; incomplete source tags can lead to flat road merges.

---

## Completed Milestones: M2.1 (`TKT-002` — `closed`), M2.2 (`TKT-001` — `closed`), M2.3-A (`TKT-003` — `closed`), M2.3-B (`TKT-004` — `closed`), & M2.3-C (`TKT-005` — `closed`)

- **Milestone 2.1 (`TKT-002` — Closed)**:
   - Benchmarked and validated **Candidate B** (Hybrid Close-Zoom 3D Instanced Sleepers & Extruded Rails + Medium/Far Procedural UV-Ribbons) across synthetic 65-way switchyard fixtures and real Overpass OSM extracts (**Station Hengelo** `67` ways and **Amsterdam Centraal** `160` ways).
   - Optimized Candidate B with `HostTrackSpatialIndex` (`8 m x 8 m` cells), `THREE.InstancedMesh` 3D sleepers, `128 m x 128 m` spatial chunking, adaptive bridge sampling, explicit `supportedTrackIds` turnout bearer tracking, and symmetric midpoint + multi-interval clipping (`subtractIntervalFromList`) for closely spaced parallel tracks.
   - Preserved historical Goalpost 1 baseline measurements as frozen evidence in `docs/m2-1-baseline-data.json`.
- **Milestone 2.2 (`TKT-001` — Closed)**:
   - Extracted the modular railway and UV-ribbon architecture into `src/world/infrastructure/rendering/UvRibbonBuilder.ts`, `src/world/infrastructure/rendering/InfrastructureShaderChunks.ts`, `src/world/infrastructure/railways/RailwayTopology.ts`, and `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`.
   - Integrated `buildRailwayInfrastructure` into `src/world/GeometryBuilder.ts` (Stage 5), removed obsolete railway-clipping heuristics from `GeometryBuilder.ts`, and wired camera-zoom LOD switching (`updateCameraZoom`) and 4-theme updates (`updateTheme`).
   - Separated offline railway benchmark extracts (`realOsmRailwayExtracts.json`) from general-purpose `osmCache` in `server.ts` so normal location presets load complete multi-category OSM regional datasets.
   - Strengthened automated regression coverage for railway bridges (substructure, piers, parapets, elevated ballast/sleeper/rail profiles), railway tunnels (subterranean track elevation profile, portals, mouths, traces), 4-theme material color updates, and resource disposal (`src/world/RailwayRendering.test.ts`).
- **Milestone 2.3 — Stage A (`M2.3-A` / `TKT-003` — Closed)**:
   - Completed source audit and accepted **[ADR-0009](./decisions/ADR-0009-infrastructure-graph-topology.md)** (*Infrastructure Graph Topology and Cross-Infrastructure Connectivity*), including all three recommended architectural resolutions.
- **Milestone 2.3 — Stage B (`M2.3-B` / `TKT-004` — Closed)**:
   - Implemented non-destructive `ProcessedMapData.topologySource` capture before `seenRoadSegments` and `chainContiguousRoads`, verified per-vertex OSM node ID enrichment (`OsmNodeIdEnricher.ts`) with strict renderer metadata isolation, pure-TypeScript `RoadNetworkBuilder` (`src/world/infrastructure/topology/`), and `16` automated tests in `src/world/RoadNetworkTopology.test.ts` (`108 / 108` Stage B baseline).
- **Milestone 2.3 — Stage C (`M2.3-C` / `TKT-005` — Closed)**:
   - Implemented non-destructive `ProcessedMapData.topologySource.railwayParts` and railway-only `infrastructurePoints` (`railway=switch`, `railway=railway_crossing`), pure-TypeScript `RailwayNetworkBuilder` (`src/world/infrastructure/topology/RailwayNetworkBuilder.ts`) with conservative turnout (`1-to-2` throat) classification, non-interconnecting flat diamond crossing (`RailwayFlatCrossingRelation`) support, complete unresolved 4-arm crossing diagnostics, conservative point-annotation matching (`diagnostics.unresolvedInfrastructurePoints`), and `18` automated tests in `src/world/RailwayNetworkTopology.test.ts` (`126 / 126` Stage C baseline).

---

## Verified Test & Build Results (2026-11-05 — Stage D `M2.3-D` Verification)

| Verification Step | Command | Result |
| :--- | :--- | :--- |
| **Unit, Integration, M2.1, M2.2, M2.3-B, M2.3-C & M2.3-D Tests** | `npm test` | **135 / 135 passed** (0 failures) |
| **TypeScript Typecheck** | `npm run lint` (`tsc --noEmit`) | **Clean** (0 errors) |
| **Production Build** | `npm run build` (`vite build`) | **Successful** (`dist/` generated) |
| **API Documentation** | `npm run docs:api` (`typedoc`) | **Generated** (`docs/api-reference/`) |

*(Historical baselines preserved: M2.3-C closeout on 2026-11-05: `126 / 126 passed` with `18` Stage C tests; M2.3-B closeout on 2026-11-05: `108 / 108 passed` with `16` Stage B tests; M2.2 closeout on 2026-11-04: `92 / 92 passed`, `0` lint errors, clean production build and API docs.)*

### Test Declaration Breakdown (Verified Source Declarations)

| Suite | Test declarations |
|---|---:|
| Core suites (WorldCoordinates, FeatureCoverage, GeometryBuilder, ElevationAndZIndex, JunctionAndTopology) | 66 |
| `PerformanceBaseline.test.ts` | 17 |
| `RailwayRendering.test.ts` | 9 |
| `RoadNetworkTopology.test.ts` (`M2.3-B`) | 16 |
| `RailwayNetworkTopology.test.ts` (`M2.3-C`) | 18 |
| `CrossModalTopology.test.ts` (`M2.3-D`) | 9 |
| **Total** | **135** |

---

## Active & Planned Milestones

1. **Milestone 2.3: Infrastructure Topology and Connectivity (`Active — Stage D Implemented, Pending Owner Review`)**:
   - **Stage A (`M2.3-A` / `TKT-003` — `closed`)**: Source audit completed and **[ADR-0009](./decisions/ADR-0009-infrastructure-graph-topology.md)** (`Accepted`) approved by project owner.
   - **Stage B (`M2.3-B` / `TKT-004` — `closed`)**: Implemented non-destructive `ProcessedMapData.topologySource` road capture, verified per-vertex OSM node ID enrichment (`OsmNodeIdEnricher.ts`), pure-TypeScript `RoadNetworkBuilder` (`src/world/infrastructure/topology/`), and `16` automated tests in `src/world/RoadNetworkTopology.test.ts` (`108 / 108` Stage B baseline).
   - **Stage C (`M2.3-C` / `TKT-005` — `closed`)**: Implemented non-destructive `ProcessedMapData.topologySource.railwayParts` and railway-only `infrastructurePoints`, pure-TypeScript `RailwayNetworkBuilder` (`src/world/infrastructure/topology/RailwayNetworkBuilder.ts`), and `18` automated tests in `src/world/RailwayNetworkTopology.test.ts` (`126 / 126` Stage C baseline).
   - **Stage D (`M2.3-D` / `TKT-006` — `in_progress`, pending project-owner review)**: Completed point-level infrastructure capture across all 5 `InfrastructurePointKind` categories (`railway_switch`, `railway_crossing_flat`, `railway_level_crossing`, `railway_ped_crossing`, `highway_crossing`), implemented `CrossModalAnalyzer` (`src/world/infrastructure/topology/CrossModalAnalyzer.ts`) and `buildInfrastructureGraph` (`src/world/infrastructure/topology/InfrastructureGraph.ts`) for confirmed vs. unresolved road/rail level crossings (`LevelCrossingRelation`), same-domain road/railway grade transitions (`GradeTransitionRelation`), and grade-separated crossings (`GradeSeparatedCrossingRelation`), protected crossing and portal nodes against degree-2 simplification, and added `9` comprehensive automated test suites in `src/world/CrossModalTopology.test.ts` (`135 / 135` total tests).
   - **Stage E (`M2.3-E` — Planned, requires explicit approval)**: Renderer integration (`GeometryBuilder` road junction trimming and portal transition consumption) with full regression preservation.
2. **Milestone 2.4: Road Surface Markings (`Planned`)**:
   - Goalpost 2 procedural road surface markings (lane dividers, directional arrows, crosswalks, stop bars) consuming `InfrastructureGraph` topology and per-segment provenance.

