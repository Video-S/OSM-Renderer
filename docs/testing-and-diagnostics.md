# Testing and Diagnostics

## 1. Available Verification Scripts

The following npm scripts defined in `package.json` constitute the official verification pipeline:

| Command | Tooling | Purpose |
| :--- | :--- | :--- |
| `npm test` | `tsx --test src/world/*.test.ts` | Runs the full automated unit and regression test suite using Node's native test runner. |
| `npm run lint` | `tsc --noEmit` | Validates TypeScript types across the entire codebase with zero file emission. |
| `npm run build` | `vite build` | Compiles the production bundle and validates asset bundling. |
| `npm run docs:api` | `typedoc` | Generates the Markdown API reference under `docs/api-reference/` using `typedoc-plugin-markdown`. |

> **When to Run Verification**: Automated tests, linting, build checks, and API documentation generation only need to be executed when code changes are made. Pure documentation updates, filing tickets, or maintaining ticket files do not require running tests or builds.

---

## 2. Test Suite Organization

Automated tests reside under `src/world/` and cover specific behavioral contracts:

1. **`WorldCoordinates.test.ts`**:
   - Origin mapping `(originLon, originLat) -> (0, 0)`.
   - Metric axis offsets (East = `+X`, South = `+Z`, North = `-Z`).
   - Round-trip projection consistency (`unprojectToGeo(projectToLocalMeters) == input`).
   - Haversine distance equivalence within +/- 0.1% across 1 km spans.
2. **`FeatureCoverage.test.ts`**:
   - Exhaustive tag classification across all OSM highway, railway, water, building, and leisure tags.
   - Theme styling resolution across all 4 built-in visual themes (`tactical`, `daylight`, `dusk`, `blueprint`).
3. **`GeometryBuilder.test.ts`**:
   - Procedural road ribbon synthesis from polyline centerlines.
   - Building wall quad generation and roof cap normal alignment.
   - Face range mapping (`faceRanges`) for raycast hit testing.
   - `SceneResourceManager` idempotent disposal and intermediate geometry release.
4. **`ElevationAndZIndex.test.ts`**:
   - Uniform `ROAD_SURFACE = 0.050 m` baseline across all road classes.
   - Zero micro-tiering steps (`MICRO_TIER_STEP = 0.0`).
   - Physical grade separation offsets for bridges (`+2.850 m`) and tunnels (`-2.000 m`).
5. **`JunctionAndTopology.test.ts`**:
   - 15 cm topological endpoint clustering in `TopologicalNodeIndex`.
   - Boundary-derived junction meshing and miter limit clamping.
   - Bridge ramp profiles (min(12m, 30%)) and short-bridge clearance preservation.
   - 3D tunnel entrance portals and recessed approach ramps.
   - Bounded-region clipping across all 8 spatial boundary cases (inside, crossing, outside, corner, holed, multipolygon, degenerate).
   - Topology-aware convex decomposition fallback for concave polygons with disconnected components and boundary-crossing holes.
6. **`PerformanceBaseline.test.ts`** (`M2.1` / `M2.2` Benchmark & Geometric Regression Suite — 17 tests in source):
   - Reproducible 7-metric performance and lifecycle benchmark across the Urban Corridor and 65-way Switchyard fixtures using the four active benchmark modes (`disabled`, `production`, `candidateA`, `candidateB`), plus 5-cycle warmed-up `SceneResourceManager` disposal verification (`0` net leaked geometries/materials). Here, `production` benchmarks the integrated Candidate B production railway renderer.
   - Explicit rejection of the legacy `baseline` mode: `baseline` represents the superseded Goalpost 1 railway renderer, whose implementation is not available in the current project source or Git history and therefore cannot be dynamically regenerated. Historical Goalpost 1 measurements remain preserved as frozen evidence in `docs/m2-1-baseline-data.json`.
   - Canonical `RAILWAY_DIMENSION_SPEC` verification (`1.435 m` clear inner gauge, `1.635 m` visual rail center-to-center spacing, `0.012 m` sleeper step, `0.013 m` rail step).
   - Continuous arc-length UV phase propagation across 18 chained `< 1.2 m` ways and LOD switching at `zoom = 4.5`.
   - **Geometric Acceptance 1 (Rail Support Coverage)**: Samples every rail polyline (`left` and `right` rails at `±0.8175 m` lateral offset across all `130` rails on `65` switchyard ways) at `0.15 m` steps, verifying that every rail is supported by 3D sleeper/bearer footprints with maximum unsupported longitudinal span $\le 1.65\text{ m}$ (`1.200 m` actual at `0.725 m` spacing) and `>= 0.08 m` lateral seat margin beyond the outer rail center.
   - **Geometric Acceptance 2 (Zero Duplicate/Interleaved Sleepers & Shared Turnout Bearers)**: Uses a 2D Separating Axis Theorem (SAT) oriented-bounding-box intersection test across all `3,693` 3D sleeper/bearer boxes (shrunk by `0.02 m` boundary touch tolerance), verifying `0` inter-track 2D OBB overlaps and confirming `383` elongated shared turnout bearers (`width > 2.65 m`, up to `4.90 m`).
   - **Geometric Acceptance 3 & 4 (Rail Continuity & Blade Taper)**: Verifies continuous non-degenerate rail ribbons through turnouts and diamond crossings, switch-blade inner-rail width taper (`0.32 -> 1.0` over `4.2 m`) at genuine turnout toes (`hasSwitchAtStart` / `hasSwitchAtEnd`), and full `1.0` (`0.20 m`) rail width across colinear chained way joints (`z1_chained_short_1..18`).
   - **Parallel Track & Turnout-Transition Regression Tests (3 tests)**: Verifies per-rail sleeper support, normalized placement order-independence, multi-interval clipping, and overlap prevention across closely spaced parallel tracks (`2.1 m–2.5 m`), 5-track competing phase corridors, and 3-track turnout throats.
   - **Close-Zoom Sleeper Density Sweep, Instancing/Chunking & Real OSM Verification**: Benchmarks `0.60 m`, `0.725 m`, and `1.45 m` close-zoom sleeper periods, verifies `THREE.InstancedMesh` 3D sleepers and `128 m` spatial chunking (`frustumCulled = true`, tight bounding spheres), and verifies Candidate A and Candidate B on real Overpass OSM railway extracts from **Station Hengelo** (`67` railway ways) and **Amsterdam Centraal** (`160` railway ways).
7. **`RailwayRendering.test.ts`** (`M2.2` / `TKT-001` Production Railway Architecture Suite — 9 tests):
   - Unit tests for `UvRibbonBuilder` (`subdivideSharpPolylineCorners2D`, `buildUvRibbonGeometry2D`, `buildUvRibbonGeometry3D` monotonic arc-length `u` and signed lateral `v`).
   - Unit tests for `RailwayTopology` (`sortRailwaysMainlineFirst`, `computeContinuousTrackPhases`, `HostTrackSpatialIndex`, `isTurnoutThroatPair`, `subtractIntervalFromList`) and `InfrastructureShaderChunks` (`configureProceduralSleeperMaterial`, `configureProceduralRailMaterial` in-place uniform updates).
   - Production `GeometryBuilder` and `RailwayGeometryBuilder` integration tests for hybrid zoom-based LOD visibility switching (`zoom = 8.0` 3D instanced sleepers & extruded rails vs `zoom = 1.0` procedural UV-ribbons), closely spaced parallel track (`2.25 m`) and turnout branch 3D sleeper placement, `faceRanges` & `instanceInfos` feature inspection provenance, 4-theme updates, and `SceneResourceManager` disposal.
   - **Production Railway Bridge Regression**: Verifies deck/abutment substructure, support pier generation and vertex bounds (`ELEVATION_POLICY.GROUND` to deck soffit), parapets, elevated track profile across all components (`Railway_Ballast`, `Railway_Sleepers` UV-ribbon, `Railway_Rails` UV-ribbon, `Railway_Sleepers_3D` instanced matrices, and `Railway_Rails_3D` extruded rails), absence of duplicate bridge geometry in `roadsGroup`, `resolveInspectedFeature` provenance, and deterministic disposal.
   - **Production Railway Tunnel Regression**: Verifies subterranean track elevation profiles (`getRailwayElevations` for `layer = -1` and `layer = -2`), `Railway_Tunnel_Portals` (portal structure and recessed mouth), `Railway_Tunnel_Traces`, absence of surface ballast/rail meshes for subterranean tunnel spans, `resolveInspectedFeature` provenance (including subterranean `elevation = -2.0 m`), and deterministic disposal.
   - **Bridge & Tunnel 4-Theme Updates & Disposal**: Verifies in-place `.material.color` updates across all four themes (`tactical`, `daylight`, `dusk`, `blueprint`) on bridge substructure, parapets, tunnel portals, tunnel traces, ballast, 3D sleepers, and 3D rails without geometry buffer reallocation, followed by deterministic disposal.
   - **OSM Preset & Cache Separation Regression**: Verifies that `server.ts` never seeds the general-purpose `osmCache` with `realOsmRailwayExtracts.json`, ensuring railway-only benchmark extracts cannot contaminate normal regional OSM preset data.
8. **`RoadNetworkTopology.test.ts`** (`M2.3-B` / `TKT-004` Road Network Graph & Non-Destructive Topology Suite — 16 tests):
   - **`T-01` through `T-10`**: Verifies curved degree-2 chain simplification and reversed middle segment provenance (`reversedRelativeToSource === true`), true T-junctions (`degree === 3`) vs. interior curve vertices, 4-way shared-node intersections (`degree === 4`), unconnected 2D geometric crossings and grade-separated bridge overpasses (`0` shared junction nodes), interior OSM junction splitting (explicit node ID and `0.15 m` coordinate fallback) and cross-tier (`vehicular` + `path`) node tagging, parallel multi-edges (`parallelIndex: 0, 1`) and qualified input-order determinism, P-loops (`degree === 3`, `incidentHalfEdges.length === 3`, `incidentEdgeIds.length === 2`) and isolated closed loops (`loop_anchor`), road attribute and one-way (`oneway=yes`, `oneway=-1`, `oneway=reversible` $\to$ `'unknown'`) simplification guards (plus surface-material breaks), explicit OSM node ID precedence over `0.15 m` proximity, and boundary-clipped endpoint isolation (`nodeIdOrigin: 'boundary_clip'`).
   - **`T-16` (Heuristic Hash Collision Survival vs. Exact `1 mm` Deduplication)**: Verifies that distinct mirror S-curve geometries colliding under legacy `seenRoadSegments` survive in `ProcessedMapData.topologySource` and remain `2` distinct `RoadEdge`s, while forward and bidirectional-reverse `<= 1 mm` exact duplicates collapse and record `deduplicatedFeatureIds`.
   - **`T-17` (Stage B Pre-Chaining Survival, Immutability & Renderer Regression)**: Verifies pre-chaining road part capture, `@id` support, zero mutation of `topologySource` during graph construction or `mapData.roads` mutation, and byte-for-byte identical `GeometryBuilder.buildScene()` output before and after live server node-ID enrichment.
   - **Offline Overpass JSON & OSM 0.6 XML Node-ID Enrichment**: Verifies `enrichGeoJsonWithOverpassNodeIds` and `enrichGeoJsonWithOsmXmlNodeIds` on valid 1:1 coordinate-aligned ways, rejection on vertex count or coordinate misalignment, `MultiLineString` `_nodeIdsByPart` propagation, and `server.ts` preset/cache separation.
   - **Parser vs. Road-Graph Performance Benchmark**: Measures and logs `LocalGeoJsonProvider.parseGeoJson` vs. `buildRoadNetwork` construction times across a 270-way synthetic urban road grid, Station Hengelo real OSM + urban roads, and Amsterdam Centraal real OSM + urban roads.
9. **`RailwayNetworkTopology.test.ts`** (`M2.3-C` / `TKT-005` Railway Network Graph, Turnout Semantics & Flat Crossings Suite — 18 tests):
   - **`T-11` (Conservative Railway Turnout Classification)**: Verifies `1-to-2` turnout throat confirmation (`status: 'confirmed'`, `trunkEdgeId`, `mainBranchEdgeId`, `divergingBranchEdgeId`, `turnoutSide`, `divergenceAngleRad`), symmetric Y-switch classification (`status: 'unresolved_main_vs_diverging'` when deflection gap $< 3^\circ$ and tags match, or `'confirmed'` when one branch is a secondary `siding`/`yard`/`spur`/`crossover`), and malformed non-throat degree-3 nodes (`status: 'unresolved_throat'`).
   - **`T-12` (Non-Interconnecting Flat Diamond Crossings & Ambiguous Degree-4 Meetings)**: Verifies both continuous ways sharing a crossing vertex (`T-12(a)`) and 4 segmented ways meeting at a tagged `railway=railway_crossing` node (`T-12(b)`), asserting `RailwayFlatCrossingRelation` emission (`trackAEdgeId`, `trackAArcLengthMeters`, `trackBEdgeId`, `trackBArcLengthMeters`, `crossingAngleRad`) and strict graph non-interchange between the two crossing tracks (`T-12(d)`), while flagging untagged or ambiguous degree-4 meetings across all three 4-arm arrangements (`2` interior occurrences, `1` interior + `2` endpoints, `4` endpoints) as unresolved junctions (`T-12(c)`, `reason: 'coincident_vertex_without_osm_id'`, `'missing_railway_crossing_tag_at_degree_4_node'`, or `'ambiguous_railway_crossing_track_pairing'`).
   - **Conservative Point Annotation Matching (`railway=switch`, `railway=railway_crossing`)**: Verifies verified explicit OSM node ID precedence, unique valid coordinate fallback when topological evidence is sufficient (`totalArms >= 3` for switches, `totalArms === 4` for flat crossings), rejection of conflicting explicit OSM node IDs (`'conflicting_explicit_osm_node_id'`), rejection of multiple candidate nodes within `0.15 m` (`'ambiguous_multiple_candidate_nodes'`), rejection of insufficient topological evidence (`'insufficient_topological_evidence'`), and strict vertical-scope isolation (`'vertical_scope_mismatch'`) recorded in `diagnostics.unresolvedInfrastructurePoints`.
   - **Railway Graph Structural, Provenance & Isolation Tests**: Verifies interior shared-node splitting, curved intermediate shape-vertex preservation, degree-2 contraction with `reversedRelativeToSource` provenance, parallel tracks and passing loops (`parallelIndex: 0, 1`), self-loops and P-loops (`degree === incidentHalfEdges.length`), railway attribute breaks (`railwayType`, `width`, `gauge`, `electrified`, `service`, `usage`), bridge vs. at-grade scope isolation, boundary-clipped endpoint isolation, Overpass JSON / OSM XML / MultiLineString explicit node-ID preservation, semantic duplicate preservation vs. `1 mm` exact deduplication, feature-order determinism, strict input immutability, and byte-for-byte `GeometryBuilder` 3D railway mesh buffer equality before and after Stage C enrichment.
   - **Real OSM Extracts & Performance Benchmark**: Validates `buildRailwayNetwork` on real **Station Hengelo** (`67` railway parts, `23` confirmed switches, `3` flat diamond crossings, `9` unresolved degree-4 crossing candidates) and **Amsterdam Centraal** (`325` in-bounds railway parts, `82` confirmed switches, `13` single-scope flat diamond crossings, `34` unresolved degree-4 crossing candidates, `6` unresolved infrastructure point candidates) extracts plus a synthetic 65-way switchyard.
10. **`CrossModalTopology.test.ts`** (`M2.3-D` / `TKT-006` Cross-Modal Connectivity, Level Crossings & Grade Transitions Suite — 9 tests):
   - **Point-Level Infrastructure Ingestion**: Verifies `LocalGeoJsonProvider` capture of all 5 `InfrastructurePointKind` categories (`railway_switch`, `railway_crossing_flat`, `railway_level_crossing`, `railway_ped_crossing`, `highway_crossing`), verified `rawOsmNodeId` extraction (rejecting synthetic `feat-*` fallback IDs), cloned `osmTags`, bounding-box clipping, and zero impact on `mapData.roads`, `mapData.railways`, `mapData.landmarks`, or legacy `diagnostics`.
   - **`T-13` (Authoritative Level Crossings & Pedestrian Rail Crossings)**: Verifies confirmed `LevelCrossingRelation` for shared explicit OSM node IDs (`confidence: 'shared_explicit_osm_node'` / `'explicit_osm_crossing_tag'`) and point-tagged `railway=level_crossing` / `railway=crossing` within `0.15 m` matching a verified `rawOsmNodeId` on at least one intersecting way, preservation of crossing nodes against degree-2 simplification (`RoadNode` and `RailwayNode` retain `'level_crossing'` role and exact arc-length offsets), rejection of points matching neither way (`'insufficient_topological_evidence'`), parallel/non-intersecting ways near points, conflicting explicit OSM node IDs (`'conflicting_explicit_osm_node_id'`), ambiguous candidate pairs (`'ambiguous_multiple_candidate_nodes'`), untagged coordinate-only coincidences (`'coincident_vertex_without_osm_id'`), unshared 2D intersections (`'geometric_intersection_without_shared_node'`), conflicting crossing tag vs. road tier (`'conflicting_crossing_tag_and_road_tier'`), and preservation of `highway=crossing` as a road-only `'highway_crossing'` role.
   - **`T-03`, `T-04` & `T-15` (Road & Railway Grade Transitions & Same-Grade Separation)**: Verifies Tier 1 explicit OSM portal transitions (`confidence: 'explicit_osm_node'`, `continuousTraversalDot >= 0.5`, Y-junction lead `>= 0.10`), Tier 2 coordinate fallback (`confidence: 'coordinate_fallback_confirmed'`, distance `<= 0.15 m`, `degree === 1`, `continuousTraversalDot >= cos(30°)`), perpendicular cross-street rejection (`'misaligned_tangent'`), all 6 `UnresolvedGradeTransitionReason` codes within the `0.80 m` diagnostic horizon, and `T-04` unshared 2D road-road crossing rejection.
   - **`T-14` (Grade-Separated Crossings & Contradictory Vertical Tag Rejection)**: Verifies `GradeSeparatedCrossingRelation` across road-over-rail, rail-over-road, and road-over-tunnel crossings (`upperNetwork`, `upperLayer`, `upperIsBridge`, `lowerNetwork`, `lowerLayer`, `lowerIsTunnel`, `position`), while rejecting contradictory vertical tags without layer separation.
   - **MultiLineString / Boundary Clipping Provenance, Stage C Flat-Diamond Non-Interchange, `T-17` Determinism & Renderer Isolation**: Verifies `_nodeIdsByPart` and `boundary_clip` isolation, Stage C flat-diamond non-interchange preservation, 10 seeded input permutations producing identical `InfrastructureGraph` outputs with zero input mutation, byte-for-byte `GeometryBuilder` mesh-buffer invariance, diagnostic count invariants, and performance benchmarks across Synthetic, Station Hengelo, and Amsterdam Centraal datasets.
   - **Event-Specific Crossing Deduplication**: Verifies that distinct crossings $< 0.225\text{ m}$ apart (e.g. `0.10 m` apart on different edge pairs) remain separate, multiple crossings between the same edge pair (e.g. `0.20 m` apart) emit distinct events, shared interior polyline vertices are deduplicated to single events, confirmed and unresolved representations never double-emit, and output ordering remains 100% deterministic under permutations.
11. **`InfrastructureRenderAdapter.test.ts`** (`M2.3-E1` / `TKT-007` Graph-to-Renderer Adapter & Legacy Renderer Invariance Suite — 10 tests):
   - **Preview-Switch Defaults & Independent URL Query Parsing**: Verifies `'legacy'` default for both `roads` and `railways`, independent parsing of `?topologyRoads=...&topologyRailways=...`, safe fallback of invalid/missing values to `'legacy'`, and `requiresInfrastructureGraphPreview`.
   - **Deterministic Descriptor Ordering**: Verifies bit-for-bit identical `InfrastructureRenderDescriptorBundle` outputs across 10 seeded permutations of shuffled `TopologySourceData`.
   - **Road Node & Edge Descriptors**: Verifies endpoint and node-role mapping, road junctions, cross-tier footway/road contacts (`isCrossTier`, `isCrossTierOnlyInteraction === true`, `requiresVehicularJunctionTrimming === false`, `requiresVehicularContinuityMiter`), parallel multi-edges (`parallelIndex`), isolated closed loops and P-loops (`isClosedLoop`), width/class/lanes/one-way (`bidirectional`, `forward`, `reverse`, `unknown` + `rawOnewayTag`)/surface/culvert preservation, and boundary-clipping flags.
   - **Railway Node, Edge, Turnout & Flat-Crossing Descriptors**: Verifies confirmed vs. unresolved turnout switches (`trunkEdgeId`, `mainBranchEdgeId`, `divergingBranchEdgeId`, `turnoutSide`, `divergenceAngleRad`), flat diamond crossings with `allowsBranchInterchange === false` and decoupled track identity, and gauge/electrified/service/usage/secondary-branch preservation.
   - **Cross-Domain Descriptors & Unresolved Diagnostics Separation**: Verifies confirmed level crossings (`crossingKind`, `roadArcLengthMeters`, `railwayArcLengthMeters`, `confidence`), grade transitions (`atGradeNodeId`, `gradeSeparatedNodeId`, `atGradeToStructureDirection`, `continuousTraversalDot`), grade-separated crossings (`upperNetwork`, `lowerNetwork`), and strict separation of unresolved candidates in `unresolvedDiagnostics`.
   - **Source-Feature Lineage & Immutability**: Verifies `sourceFeatureId`, `sourceFeatureIds`, `deduplicatedFeatureIds`, `sourceFeatureToRoadEdgeIds`, `sourceFeatureToRailwayEdgeIds`, `roadFeatureLineage` / `railwayFeatureLineage`, and strict immutability of `ProcessedMapData` and `InfrastructureGraph`.
   - **Primary E1 Acceptance — Legacy Renderer Invariance**: Across Synthetic, M2.1 Switchyard, Station Hengelo, and Amsterdam Centraal datasets, verifies exact equality of `mapData.roads` & `mapData.railways`, scene group hierarchies, mesh counts, transforms, `renderOrder`, all `BufferGeometry` attribute and index arrays, `InstancedMesh` counts and instance matrices, `faceRanges`, `instanceInfos`, `resolveInspectedFeature` provenance, scene stats, camera zoom/LOD (`updateCameraZoom`), theme updates (`updateTheme`), `railwayPrototypeMode` compatibility (`production`, `candidateA`, `candidateB`, `disabled`), and resource disposal (`0` leaked GPU buffers or retained preview references).
   - **Cross-Tier Degree-2 Continuity vs. Branching Junction Classification**: Verifies 2 vehicular half-edges + 1 or 2 footpaths (`isCrossTierOnlyInteraction === true`, `requiresVehicularJunctionTrimming === false`, `requiresVehicularContinuityMiter === true`), 3 vehicular half-edges + 1 footpath (`requiresVehicularJunctionTrimming === true`), 1 vehicular arm + 2 footpaths, pure vehicular junctions, and pure vehicular degree-2 continuity nodes.
12. **`GraphRoadRendering.test.ts`** (`M2.3-E2` / `TKT-008` Graph-Driven Road Rendering, Junction Geometry & Mesh Integrity Suite — 16 tests):
   - **Mode Selection & Scope Guards**: Verifies `roads: 'legacy' | 'graph-preview' | 'graph'` and `railways: 'legacy' | 'graph-preview'` parsing (`?topologyRailways=graph` safely resolves to `'legacy'`).
   - **20 Topological & Geometric Scenarios (Suites 2–7 & 10)**: Covers isolated single-way roads (`Scenario 1`), cul-de-sacs (`Scenario 2`), 3-way T-junctions (`Scenario 3`), 4-way crossroads (`Scenario 4`), skewed/acute Y-junctions (`Scenario 5`), 5-way multi-arm junctions (`Scenario 6`), width mismatches across degree-2 and branching junctions (`Scenario 7`), one-way and reversed-way connections (`Scenario 8`), roundabouts, P-loops, and isolated closed loops (`Scenario 9`), degree-2 bends and attribute breaks (`Scenario 10`), cross-tier footway contacts with through-roads (`Scenario 11`), cross-tier footway contacts at 3-arm vehicular junctions (`Scenario 12`), pure path-tier junctions and `highway=steps` raised treads (`Scenario 13`), boundary-clipped endpoints (`Scenario 14`), grade-separated bridge overpasses (`Scenario 15`), road-to-bridge/tunnel portal transitions (`Scenario 16`), exact duplicate suppression and full carriageway subtraction (`Scenario 17`), simplified multi-way edges with per-segment provenance (`Scenario 18`), culvert at-grade roads (`Scenario 19`), and a 270-way dense urban road network / real OSM extracts (`Scenario 20`).
   - **Geometric Triangle Winding & Z-Fighting Invariants**: Executes `auditGraphRoadMeshIntegrity(scene.roadsGroup)` (verifying actual indexed triangle winding via `cross(v1 - v0, v2 - v0)`, `0` negatively wound triangles, `0` stored-normal mismatches, and `0` degenerate triangles) alongside `ZFightingValidator.validateRoadNetworkGeometry(scene)` (`0` overlap conflicts, `0` portal continuity defects, `isValid === true`) across every scenario.
   - **Deliberate Negative Audit Verification (Suite 11)**: Proves `auditGraphRoadMeshIntegrity` catches reversed triangle indices with unchanged `+Y` vertex normals, crossed ribbon portal quads, malformed/inverted junction triangles, and zero-area degenerate triangles with full mesh/face/feature/source attribution.
   - **Edge-Case Stabilization & Transactional Junction Rejection (Suites 12 & 13)**: Verifies 15° acute Y-forks with unequal widths, 14m-to-6m-to-5m unequal-width T-junctions, 6-arm star junctions, 4.5m short segments between T-junctions, P-loops, curved cross-tier through-roads, preservation of dead-end caps on unconnected roads `0.40 m` from a bridge transition, and transactional rejection of malformed duplicate-ray junctions without leaving connected ribbons trimmed.
   - **Localized Road-Footprint Junction & Curve/Width Preservation Regressions (Suites 14, 15 & 16)**: Verifies that straight roads retain 100% of their intended width at junction portals when side roads join (`Suite 14`), curved roads retain all intermediate curve bends and full width near junctions and across short-segment degree-2 continuity joins (`Suite 14`), acute unequal-width Y-junctions (`14.0 m` trunk + `5.5 m` slip road at `22°`) follow localized road footprints without exaggerated triangular chord wedges and short roads between two junctions retain full width (`Suite 15`), and adding a side road at a junction node leaves main-road vertex geometry outside the local junction region 100% invariant (`Suite 16`).
   - **Strict Source-of-Truth Isolation, 10-Permutation Determinism & Mode Isolation**: Proves that scrambling or clearing `mapData.roads` has zero effect on `roads: 'graph'` output, verifies bit-for-bit identical geometry across 10 seeded permutations of input feature order, exact `legacy` vs. `graph-preview` parity, `railwaysGroup` invariance when `roads === 'graph'`, 4-theme updates, and zero leaked GPU resources on `dispose()`.
13. **`DevToolsAndReproduction.test.ts`** (`TKT-009` Developer Tools, Multi-Selection & Reproduction Reporting Suite — 11 tests):
   - **Configuration & Mode Switching**: Verifies `normalizeInfrastructureRenderOptions` and legacy URL parameter compatibility (`?topologyRoads=...&topologyRailways=...`).
   - **Connected OSM Feature Extraction & Transit Route Filtering**: Verifies extraction of selected road features and connected ways sharing OSM node IDs (`_nodeIds`), spatial bounding-box extraction, and strict exclusion of non-physical route relations (`route=bus`, `route=bicycle`, `type=route`) and distant unrelated streets so municipal bus routes do not bloat exported packages.
   - **Hengelo Junction Real-World Regressions (`way/230163945`, `way/230163947`, `way/532064931`, `node/45928009`, `node/45929045`)**: Verifies raycast pass-through inside an active spatial selection rectangle (`raycast={() => null}` on `DevTools_SpatialSelectionBox` so clicks inside the rectangle pick `way/230163945`), multi-object selection and individual deselection synchronization, distinction between `selectedObjects` and `connectedContextFeatureCount`, preservation of `selectedArea` and `graphContext`, and full export/import round-trip topological invariance.

### Recorded Verification Status (2026-11-07 — Stage E2 & Developer Tools `TKT-009` Verification)

| Verification | Recorded Result |
| :--- | :--- |
| `npm test` | **184 / 184 passed**, 0 failures (`66` core G1 tests across Suites 1–5 + `17` in `PerformanceBaseline.test.ts` + `9` in `RailwayRendering.test.ts` + `16` in `RoadNetworkTopology.test.ts` + `18` in `RailwayNetworkTopology.test.ts` + `9` in `CrossModalTopology.test.ts` + `10` in `InfrastructureRenderAdapter.test.ts` + `28` in `GraphRoadRendering.test.ts` + `11` in `DevToolsAndReproduction.test.ts`) |
| `npm run lint` | **0 TypeScript errors** (`tsc --noEmit`) |
| `npm run build` | **Successful** (`vite build`) |
| `npm run docs:api` | **Successful** (`typedoc`) |

*(Historical baselines preserved: M2.3-E2 width audit on 2026-11-06: `170 / 170 passed`; initial M2.3-E2 stabilization on 2026-11-06: `158 / 158 passed`; M2.3-E1 closeout on 2026-11-06: `145 / 145 passed` with `10` Stage E1 tests; M2.3-D closeout on 2026-11-06: `135 / 135 passed` with `9` Stage D tests; M2.3-C closeout on 2026-11-05: `126 / 126 passed` with `18` Stage C tests; M2.3-B closeout on 2026-11-05: `108 / 108 passed` with `16` Stage B tests; M2.2 closeout on 2026-11-04: `92 / 92 passed`, `0` TypeScript errors, clean production build and API docs.)*


---

## 3. Geometry Validation Utilities

Geometry verification is performed by three dedicated validator utilities:

### `auditGraphRoadMeshIntegrity` (`src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`)
- **Geometric Face Normal & Winding Audit**:
  - Reads actual indexed triangle vertex positions from horizontal at-grade road, path, step-tread, and junction meshes in `roadsGroup` and computes geometric face normals via `cross(v1 - v0, v2 - v0)`.
  - Verifies that every non-degenerate (`area > 1e-6 m²`) horizontal triangle faces upward (`geomNormal.y > 0.99`) and agrees with its stored vertex normals (`dot > 0.99`), catching flipped index winding even when stored vertex normals remain `(0, 1, 0)`.
  - Reports zero-area or sliver triangles (`area <= 1e-6 m²`) separately in `degenerateTriangles` and attributes every defect to `meshName`, `faceIndex`, `featureId`, `sourceFeatureId`, and world-space `vertices`.

### `ZFightingValidator` (`src/world/ZFightingValidator.ts`)
- **Coplanar Triangle Overlap Check**:
  - Extracts upward-facing surface triangles from rendered scene meshes.
  - Groups triangles by coplanar elevation layers.
  - Computes 2D polygon intersection area using Martínez-Rueda boolean clipping.
  - Flags any positive-area coplanar intersection $> 0.05\text{ m²}$ as an overlap defect.
- **Same-Feature Self-Overlap Check**:
  - Validates that complex road ribbons (e.g., self-crossing loops) do not overlap their own quads.
- **Junction Portal Continuity Check**:
  - Compares the portal boundary segments of trimmed incoming roads against the matching boundary segment of the synthesized junction polygon.
  - Detects portal gaps $> 0.02\text{ m}$ or missing connections.

### `PlanarLayerValidator` (`src/world/PlanarLayerValidator.ts`)
- Validates 2D planar ground fills (parks, land-use, paved parking lots).
- Verifies that mutually exclusive ground-cover polygons have non-overlapping interiors after boolean subtraction.

---

## 4. Source-Feature Diagnostics & Counters

`LocalGeoJsonProvider` and `GeometryBuilder` track strict feature accounting in `MapFeatureDiagnostics`:

```typescript
export interface MapFeatureDiagnostics {
  sourceFeaturesReceived: number;    // Raw input count
  sourceFeaturesClassified: number;  // Successfully mapped
  totalFeaturesParsed: number;       // Parsed into collections
  sourceFeaturesRendered: number;    // Rendered into 3D meshes
  constructedMeshesCount: number;    // Three.js Mesh instances created
  parsedByCategory: Record<string, number>;
  rejectedInvalid: {
    total: number;
    byReason: Record<string, { count: number; sampleIds: string[] }>;
  };
}
```

### Diagnostic Reasons for Rejected Features
- `invalid_self_intersecting_building_polygon`: Bowtie or self-crossing polygon ring.
- `degenerate_building_polygon (< 3 points or zero area)`: Collinear points or area $< 0.05\text{ m²}$.
- `degenerate_path_clipping_failure`: Failed boolean difference with invalid path polyline.

---

## 5. Optional Browser-Based Visual Sanity Checks

Automated tests and measurable regression checks are the primary and default verification mechanism for the project. Manual browser-based visual inspection remains available as an optional debugging and sanity-check tool when working on complex rendering features.

Visual inspection is discretionary and is not a mandatory ticket acceptance criterion by default. Screenshot capture and screenshot-based review are not required for ticket or milestone closure.

For targeted visual sanity checks, the following inspection points may be useful:

1. **At-Grade Intersections**:
   - Observe road junctions at glancing tilt angles ($72^\circ$). Road surfaces should appear solid and crisp without shimmering, flickering, or visible seam gaps.
2. **Bridges & Flyovers**:
   - Check that bridges rise via sloped approach ramps and pass over crossed roads/waterways with adequate clearance. Check that piers meet ground and parapets follow deck edges.
3. **Tunnel Portals**:
   - Check that tunnels enter recessed 3D portal structures, with surface traces indicating underground routes.
4. **Building Courtyards**:
   - Verify that doughnut-shaped or courtyard buildings show open sky through their interior courtyards.
5. **Boundary Framing**:
   - Verify that the framed map fits comfortably within the canvas without edge clipping when rotating $360^\circ$.

---

### E2 isolated Prins Hendrikkade junction visual fixture

Open `?fixture=prins-fork` to load three original OSM cycleways from the project owner's Amsterdam export at shared node `6387677253` (the **southern**, acute-angle fork), centered on that junction at approximately 8 CSS px/m. This developer fixture runs the regular application scene and defaults roads to `graph` unless an explicit `topologyRoads` query is provided. It performs no Overpass request and does not modify normal map presets.

- `?fixture=prins-fork&topologyRoads=graph&zoom=8` — E2 graph road geometry.
- `?fixture=prins-fork&topologyRoads=legacy&zoom=8` — legacy geometry A/B reference.
- `&azimuth=0` or `&azimuth=45` — reproducible rotation for side-by-side screenshots.

Fixture source: `src/world/prototype/PrinsHendrikkadeForkFixture.json`. It preserves original OSM coordinates, way IDs `682105412`, `682105414`, and `1068343582`, per-vertex node IDs, and meaningful tags. All three southern-fork cycleways use the 2.4m default width; the earlier northern 3.5m width-transition fixture was replaced. The source is clipped to 60m around the junction during ingestion. `GraphRoadRendering.test.ts` checks that the correct three-way graph node and widths survive parsing and reach the production graph renderer. This fixture is for diagnosing junction geometry, not a reference for whole-Amsterdam rendering.

### 5.1 In-App Developer Tools & Self-Contained Reproduction Reporting (`TKT-009`)

To eliminate error-prone manual URL parameter editing and page reloads, a centralized Developer Tools panel (`src/components/DevToolsPanel.tsx`, `src/world/dev/ReproductionReport.ts`) is available via the **Dev Tools** button in the top navigation bar or programmatically via `window.__DEV_TOOLS__`:

1. **Runtime Rendering Controls**:
   - **Road Engine**: Switch between `Legacy (Pre-M2.3-E2)` and `Graph-Driven (M2.3-E2)` rendering, or view `Graph Adapter Topology Preview (E1)`. Switching takes effect immediately in-memory without reloading the page or losing camera focus.
   - **Railway Engine**: Select `Production (Candidate B)` or isolated prototypes (`Candidate A (Dynamic Multi-LOD)`, `Disabled`), or view `Graph Adapter Topology Preview`. (Railway controls strictly reflect implemented capabilities; E3–E5 are unauthorized).
   - **Overlays**: Toggle scene wireframe and visual 3D topological graph nodes (`#f59e0b` junction, `#a855f7` cross-tier, `#ef4444` dead-end, `#06b6d4` intermediate/curve).

2. **Geometry & Junction Inspection with Highlighting**:
   - Click any road, railway, or building to view its OSM IDs, tags, coordinates, inferred physical widths, graph connectivity, and renderer provenance.
   - Activate **Spatial Box Select** to drag a bounding box directly on the map canvas. Selected geometry is highlighted in 3D with a cyan boundary plane and accent ring.

3. **Self-Contained Reproduction Export & Import**:
   - Fill in a concise issue report (Title, Category, Severity, Expected Behavior, Description).
   - Click **Export Repro Package (.json)** to generate a self-contained bundle containing:
     - The minimal GeoJSON `FeatureCollection` including primary selected features and directly connected incident context sharing verified OSM node IDs (preserving original OSM node identities without fabricating synthetic junctions).
     - Active rendering configuration (`infrastructureRenderOptions`, `railwayPrototypeMode`, `themeId`, `roadWidthMultiplier`).
     - Camera pose (`target`, `zoom`, `azimuthDeg`).
     - Selected feature diagnostics and developer notes.
   - Click **Import Reproduction Package** or drop a `.json` file to instantly load the scenario, set the camera pose, apply the exact rendering engine, and reproduce the defect without manual URL configuration.

4. **Fixture Library**:
   - 1-click loading for canonical test fixtures: `Prins Hendrikkade South Fork (M2.3-E2)`, `Railway Switchyard & Throat (M2.1)`, `Station Hengelo Live`, and `Amsterdam Centraal Live`.

## 6. How to Report Verification Results

When completing any implementation or bug-fix task, always report:
1. Exact commands run: `npm test`, `npm run lint`, `npm run build`, `npm run docs:api`.
2. Actual exit codes and execution summaries (e.g. `91 passed, 0 failed, 8.1s`).
3. If discretionary visual inspection was performed, briefly describe the observations. If visual inspection was not performed, simply state that it was not performed or omit visual claims. Never claim visual verification was performed when it was not.
