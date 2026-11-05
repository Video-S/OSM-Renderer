# Current Project Status

## Product & Goalpost

- **Product**: Browser-based 3D OpenStreetMap Viewer
- **Active Goalpost**: **Goalpost 2: Infrastructure Topology, Railway Rendering, and Surface Markings** (Milestone 2.2 complete; awaiting approval for M2.3)
- **Architecture**: React 19 + TypeScript + Three.js r186 + React Three Fiber v9 + Tailwind CSS v4

---

## Implemented Capabilities (Verified)

1. **Map Ingestion & Processing**:
   - Ingestion of local GeoJSON datasets and live Overpass OSM API queries via `MapDataProvider`.
   - Strict separation between live multi-category OSM regional preset datasets (`/api/osm-data` in `server.ts`) and offline railway-only benchmark test extracts (`src/world/prototype/realOsmRailwayExtracts.json`).
   - WGS84 to local Euclidean metric Cartesian projection `(X, Y, Z)` anchored to the dataset origin.
   - Comprehensive diagnostic accounting tracking raw, classified, parsed, clipped, and rendered features.
2. **Procedural Geometry Synthesis**:
   - Uniform `ROAD_SURFACE = 0.050 m` at-grade road baseline with boundary-derived junction meshing and miter limits.
   - Carriageway-vs-path 2D Boolean clipping removing coplanar overlapping road surfaces.
   - Building prism vertical extrusions preserving complex 2D footprints and interior courtyard holes.
   - Hybrid multi-component railway geometry (`ADR-0008`, `TKT-001`, `TKT-002`) with crushed-stone ballast (`+0.060 m`), close-zoom (`> 4.5 CSS px/m`) 3D instanced sleepers (`+0.072 m`) and 3D extruded steel rails (`+0.085 m`), medium/far (`<= 4.5 CSS px/m`) derivative-filtered (`fwidth`) procedural UV-ribbons, elongated shared turnout bearers, multi-interval parallel-track sleeper clipping, and `128 m x 128 m` spatial chunking.
   - Grade-separated road and railway bridges rising to `+2.850 m` / `+2.860 m` with sloped approach ramps, concrete piers, and guardrail parapets.
   - Subterranean tunnels descending to `-2.000 m` with 3D entrance portals, recessed mouths, and dashed surface traces.
3. **Robust Geographic Boundary Clipping**:
   - Axis-aligned region bounding box clipping for polylines (Liang-Barsky) and polygons (Martínez-Rueda + topology-aware convex decomposition fallback).
   - MultiPolygon component separation for concave U-shaped polygons cut across the boundary.
4. **Isometric Camera Controls**:
   - Orthographic camera with isometric default tilt (55.4 degrees), 45 degrees view azimuth, and dynamic near/far plane calculation.
   - Full panning, orbiting, zooming, 45 degrees stepped rotation, and bounding-box reframing.
5. **Interactive Inspection & Styling**:
   - 4 built-in visual themes (`tactical`, `daylight`, `dusk`, `blueprint`) with in-place material updating.
   - Raycast feature inspection via `faceRanges` binary search and instanced sleeper `instanceInfos` mapping 3D faces/instances back to OSM tags.

---

## Known Limitations & Incomplete Capabilities

- **Single-Threaded Geometry Synthesis**: Large OSM queries (> 5,000 ways) execute polygon clipping and triangulation on the main browser thread; background web worker offloading is not yet implemented.
- **Local Metric Projection Range**: The equirectangular projection assumes a constant meridian radius and is optimized for neighborhood tiles up to ~5 km. Continental-scale streaming is out of scope.
- **Complex Multi-Level Stack Interchanges**: Highly skewed 5+ way junctions with overlapping flyover tiers rely on OSM layer tags; incomplete source tags can lead to flat road merges.

---

## Completed Milestones: M2.1 (`TKT-002` — `closed`) & M2.2 (`TKT-001` — `closed`)

- **Milestone 2.1 (`TKT-002` — Closed)**:
  - Benchmarked and validated **Candidate B** (Hybrid Close-Zoom 3D Instanced Sleepers & Extruded Rails + Medium/Far Procedural UV-Ribbons) across synthetic 65-way switchyard fixtures and real Overpass OSM extracts (**Station Hengelo** `67` ways and **Amsterdam Centraal** `160` ways).
  - Optimized Candidate B with `HostTrackSpatialIndex` (`8 m x 8 m` cells), `THREE.InstancedMesh` 3D sleepers, `128 m x 128 m` spatial chunking, adaptive bridge sampling, explicit `supportedTrackIds` turnout bearer tracking, and symmetric midpoint + multi-interval clipping (`subtractIntervalFromList`) for closely spaced parallel tracks.
  - Preserved historical Goalpost 1 baseline measurements as frozen evidence in `docs/m2-1-baseline-data.json`.
- **Milestone 2.2 (`TKT-001` — Closed)**:
  - Extracted the modular railway and UV-ribbon architecture into `src/world/infrastructure/rendering/UvRibbonBuilder.ts`, `src/world/infrastructure/rendering/InfrastructureShaderChunks.ts`, `src/world/infrastructure/railways/RailwayTopology.ts`, and `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`.
  - Integrated `buildRailwayInfrastructure` into `src/world/GeometryBuilder.ts` (Stage 5), removed obsolete railway-clipping heuristics from `GeometryBuilder.ts`, and wired camera-zoom LOD switching (`updateCameraZoom`) and 4-theme updates (`updateTheme`).
  - Separated offline railway benchmark extracts (`realOsmRailwayExtracts.json`) from general-purpose `osmCache` in `server.ts` so normal location presets load complete multi-category OSM regional datasets.
  - Strengthened automated regression coverage for railway bridges (substructure, piers, parapets, elevated ballast/sleeper/rail profiles), railway tunnels (subterranean track elevation profile, portals, mouths, traces), 4-theme material color updates, and resource disposal (`src/world/RailwayRendering.test.ts`).

---

## Verified Test & Build Results (2026-11-04)

| Verification Step | Command | Result |
| :--- | :--- | :--- |
| **Unit, Integration, M2.1 & M2.2 Tests** | `npm test` | **92 / 92 passed** (0 failures) |
| **TypeScript Typecheck** | `npm run lint` (`tsc --noEmit`) | **Clean** (0 errors) |
| **Production Build** | `npm run build` (`vite build`) | **Successful** (`dist/` generated) |
| **API Documentation** | `npm run docs:api` (`typedoc`) | **Generated** (`docs/api-reference/`) |

### Test Declaration Breakdown (Verified Source Declarations)

| Suite | Test declarations |
|---|---:|
| Core suites (WorldCoordinates, FeatureCoverage, GeometryBuilder, ElevationAndZIndex, JunctionAndTopology) | 66 |
| `PerformanceBaseline.test.ts` | 17 |
| `RailwayRendering.test.ts` | 9 |
| **Total** | **92** |

*(Verified by inspecting current source declarations; recorded test execution remains the 2026-11-04 verification result.)*


---

## Next Planned Milestones

1. **M2.3 Topological Road Graph & Intersection Trim Refinement**:
   - Planned Goalpost 2 road topology foundation prior to road surface markings (`M2.4`).


