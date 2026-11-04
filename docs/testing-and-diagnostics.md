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
6. **`PerformanceBaseline.test.ts`** (`M2.1` / `TKT-002` Baseline & Railway Prototype Suite — 14 tests):
   - Reproducible 7-metric performance baseline across Urban Corridor and 65-way Switchyard fixtures (`baseline`, `candidateA`, `candidateB`), plus 5-cycle warmed-up `SceneResourceManager` disposal verification (`0` net leaked geometries/materials).
   - Canonical `RAILWAY_DIMENSION_SPEC` verification (`1.435 m` clear inner gauge, `1.635 m` visual rail center-to-center spacing, `0.012 m` sleeper step, `0.013 m` rail step).
   - Continuous arc-length UV phase propagation across 18 chained `< 1.2 m` ways and LOD switching at `zoom = 4.5`.
   - **Geometric Acceptance 1 (Rail Support Coverage)**: Samples every rail polyline (`left` and `right` rails at `±0.8175 m` lateral offset across all `130` rails on `65` switchyard ways) at `0.15 m` steps, verifying that every rail is supported by 3D sleeper/bearer footprints with maximum unsupported longitudinal span $\le 1.65\text{ m}$ (`1.200 m` actual at `0.725 m` spacing) and `>= 0.08 m` lateral seat margin beyond the outer rail center.
   - **Geometric Acceptance 2 (Zero Duplicate/Interleaved Sleepers & Shared Turnout Bearers)**: Uses a 2D Separating Axis Theorem (SAT) oriented-bounding-box intersection test across all `3,693` 3D sleeper/bearer boxes (shrunk by `0.02 m` boundary touch tolerance), verifying `0` inter-track 2D OBB overlaps and confirming `383` elongated shared turnout bearers (`width > 2.65 m`, up to `4.90 m`).
   - **Geometric Acceptance 3 & 4 (Rail Continuity & Blade Taper)**: Verifies continuous non-degenerate rail ribbons through turnouts and diamond crossings, switch-blade inner-rail width taper (`0.32 -> 1.0` over `4.2 m`) at genuine turnout toes (`hasSwitchAtStart` / `hasSwitchAtEnd`), and full `1.0` (`0.20 m`) rail width across colinear chained way joints (`z1_chained_short_1..18`).
   - **Parallel Track & Turnout-Transition Regression Tests**: Verifies `100%` sleeper support coverage and `0` 2D OBB overlaps across closely spaced parallel tracks (`2.1 m–2.5 m`) and turnout-to-parallel transitions.
   - **Close-Zoom Sleeper Density Sweep & Real OSM Verification**: Benchmarks `0.60 m`, `0.725 m`, and `1.45 m` close-zoom sleeper periods and verifies both Candidate A and Candidate B on real Overpass OSM extracts from **Station Hengelo** (`67` railway ways) and **Amsterdam Centraal** (`160` railway ways).
7. **`RailwayRendering.test.ts`** (`M2.2` / `TKT-001` Production Railway Architecture Suite — 5 tests):
   - Unit tests for `UvRibbonBuilder` (`subdivideSharpPolylineCorners2D`, `buildUvRibbonGeometry2D`, `buildUvRibbonGeometry3D` monotonic arc-length `u` and signed lateral `v`).
   - Unit tests for `RailwayTopology` (`sortRailwaysMainlineFirst`, `computeContinuousTrackPhases`, `HostTrackSpatialIndex`, `isTurnoutThroatPair`, `subtractIntervalFromList`).
   - Production `GeometryBuilder` integration tests for turnout shared bearers and closely spaced parallel track (`2.20 m`) sleeper support (`0` unsupported rail spans `> 1.65 m`).
   - Production zoom-based LOD visibility switching (`zoom = 8.0` 3D instanced sleepers & extruded rails vs `zoom = 1.0` procedural UV-ribbons), `faceRanges` & `instanceInfos` feature inspection provenance, 4-theme in-place material updates (`tactical`, `daylight`, `dusk`, `blueprint`), and `SceneResourceManager` disposal (`0` leaked geometries/materials).

*(As of 2026-11-03, all 87 automated tests are passing.)*

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

## 5. Browser-Based Visual Verification Checklist

Automated tests verify numerical contracts, but visual correctness must also be confirmed in the browser:

1. **At-Grade Intersections**:
   - Observe road junctions at glancing tilt angles ($72^\circ$). Road surfaces must remain solid and crisp without shimmering, flickering, or visible seam gaps.
2. **Bridges & Flyovers**:
   - Verify that bridges rise smoothly via sloped approach ramps and pass cleanly over crossed roads/waterways with full clearance. Check that piers touch ground and parapets track deck edges.
3. **Tunnel Portals**:
   - Check that tunnels enter dark recessed 3D portal structures, with dashed traces indicating underground routes.
4. **Building Courtyards**:
   - Verify that doughnut-shaped or courtyard buildings show open sky through their interior courtyards.
5. **Boundary Framing**:
   - Verify that the framed map fits comfortably within the canvas without edge bleeding when rotating $360^\circ$.

---

## 6. How to Report Verification Results

When completing any implementation or bug-fix task, always report:
1. Exact commands run: `npm test`, `npm run lint`, `npm run build`, `npm run docs:api`.
2. Actual exit codes and execution summaries (e.g. `63 passed, 0 failed, 5.4s`).
3. Confirmation of whether visual verification was performed. Never claim visual verification succeeded unless actually inspected in the browser.
