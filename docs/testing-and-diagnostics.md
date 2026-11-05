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
9. **`RailwayNetworkTopology.test.ts`** (`M2.3-C` / `TKT-005` Railway Network Graph, Turnout Semantics & Flat Crossings Suite — 16 tests):
   - **`T-11` (Conservative Railway Turnout Classification)**: Verifies `1-to-2` turnout throat confirmation (`status: 'confirmed'`, `trunkEdgeId`, `mainBranchEdgeId`, `divergingBranchEdgeId`, `turnoutSide`, `divergenceAngleRad`), symmetric Y-switch classification (`status: 'unresolved_main_vs_diverging'` when deflection gap $< 3^\circ$ and tags match, or `'confirmed'` when one branch is a secondary `siding`/`yard`/`spur`/`crossover`), and malformed non-throat degree-3 nodes (`status: 'unresolved_throat'`).
   - **`T-12` (Non-Interconnecting Flat Diamond Crossings & Ambiguous Degree-4 Meetings)**: Verifies both continuous ways sharing a crossing vertex (`T-12(a)`) and 4 segmented ways meeting at a tagged `railway=railway_crossing` node (`T-12(b)`), asserting `RailwayFlatCrossingRelation` emission (`trackAEdgeId`, `trackAArcLengthMeters`, `trackBEdgeId`, `trackBArcLengthMeters`, `crossingAngleRad`) and strict graph non-interchange between the two crossing tracks (`T-12(d)`), while flagging untagged degree-4 meetings as unresolved junctions (`T-12(c)`, `reason: 'missing_railway_crossing_tag_at_degree_4_node'`).
   - **Railway Graph Structural, Provenance & Isolation Tests**: Verifies interior shared-node splitting, curved intermediate shape-vertex preservation, degree-2 contraction with `reversedRelativeToSource` provenance, parallel tracks and passing loops (`parallelIndex: 0, 1`), self-loops and P-loops (`degree === incidentHalfEdges.length`), railway attribute breaks (`railwayType`, `width`, `gauge`, `electrified`, `service`, `usage`), bridge vs. at-grade scope isolation, boundary-clipped endpoint isolation, Overpass JSON / OSM XML / MultiLineString explicit node-ID preservation, semantic duplicate preservation vs. `1 mm` exact deduplication, feature-order determinism, strict input immutability, and byte-for-byte `GeometryBuilder` 3D railway mesh buffer equality before and after Stage C enrichment.
   - **Real OSM Extracts & Performance Benchmark**: Validates `buildRailwayNetwork` on real **Station Hengelo** (`67` railway parts, `23` confirmed switches, `3` flat diamond crossings) and **Amsterdam Centraal** (`325` in-bounds railway parts, `82` confirmed switches, `13` single-scope flat diamond crossings) extracts plus a synthetic 65-way switchyard.

### Recorded Verification Status (2026-11-05 — Stage C `M2.3-C` Verification)

| Verification | Recorded Result |
| :--- | :--- |
| `npm test` | **124 / 124 passed**, 0 failures (`66` core G1 tests across Suites 1–5 + `17` in `PerformanceBaseline.test.ts` + `9` in `RailwayRendering.test.ts` + `16` in `RoadNetworkTopology.test.ts` + `16` in `RailwayNetworkTopology.test.ts`) |
| `npm run lint` | **0 TypeScript errors** (`tsc --noEmit`) |
| `npm run build` | **Successful** (`vite build`) |
| `npm run docs:api` | **Successful** (`typedoc`) |

*(Historical baselines preserved: M2.3-B closeout on 2026-11-05: `108 / 108 passed` with `16` Stage B tests; M2.2 closeout on 2026-11-04: `92 / 92 passed`, `0` TypeScript errors, clean production build and API docs.)*

---

## 3. Geometry Validation Utilities

Geometry verification is performed by two dedicated validator modules:

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

## 6. How to Report Verification Results

When completing any implementation or bug-fix task, always report:
1. Exact commands run: `npm test`, `npm run lint`, `npm run build`, `npm run docs:api`.
2. Actual exit codes and execution summaries (e.g. `91 passed, 0 failed, 8.1s`).
3. If discretionary visual inspection was performed, briefly describe the observations. If visual inspection was not performed, simply state that it was not performed or omit visual claims. Never claim visual verification was performed when it was not.
