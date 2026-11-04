# ADR-0008: Hybrid Railway Rendering, Multi-Interval Turnout Support, and UV-Ribbon Architecture

## Metadata

- **Decision ID**: `ADR-0008`
- **Status**: `Accepted`
- **Date**: `2026-11-03`
- **Deciders**: `Core Engineering (M2.1 / M2.2 Decision Gate)`
- **Consulted**: `TKT-001, TKT-002, M2.1 Prototype Benchmark & Real-OSM Evaluation`

---

## Context and Problem

In the initial Goalpost 1 railway renderer (`src/world/GeometryBuilder.ts`), railways were synthesized as flat 2D ribbons with discrete rectangular sleeper quads and heuristic polyline clearance clipping (`RailClearanceSpatialIndex`, `resolveRailPolylineClearance`, `applyRibbonMinScreenWidthShader`). On complex railway topologies—including single turnouts, scissors crossovers, chained short OSM ways (`< 1.2 m`), and dense multi-track station throats such as Station Hengelo (`67` ways) and Amsterdam Centraal (`160` ways)—this approach exhibited four severe failure modes documented in `TKT-001`:

1. **Discontinuous Geometry Trap**: Trimming railway polylines at switch nodes or clearance boundaries cut voids into rails or introduced dogleg kinks.
2. **Single-Mesh Stencil & Min-Width Blooming Trap**: Expanding vertex screen-space widths caused adjacent rails in station throats to merge into a solid bright band.
3. **Spatial Density & HDR Tone-Mapping Blooming**: Packing overlapping cross-ties and bright rails into narrow switch corridors doubled screen-space luminance under `ACESFilmicToneMapping`.
4. **Proximity Culling Sleeper Dropouts**: Naive spatial proximity hashes (`SleeperSpatialIndex`) could not distinguish between a shared turnout throat and independent closely spaced parallel tracks (`2.1 m–2.5 m` centerline spacing), suppressing sleepers under one of the tracks and leaving bare rails floating over ballast.

Under Milestone 2.1 (`TKT-002`), two candidate architectures were prototyped and benchmarked in isolation against the Goalpost 1 baseline across synthetic 65-way switchyard fixtures and real Overpass OSM extracts (Station Hengelo and Amsterdam Centraal).

---

## Decision

We adopt **Candidate B (Hybrid Close-Zoom 3D Instanced Sleepers & Extruded Rails + Medium/Far Procedural UV-Ribbons)** as the production railway rendering architecture and extract its modular components into `src/world/infrastructure/`:

1. **Modular Infrastructure Extraction**:
   - `src/world/infrastructure/rendering/UvRibbonBuilder.ts`: Generates continuous arc-length UV-parameterized (`u = arcLengthMeters`, `v = signedLateralOffsetMeters`) 2D and 3D ribbons with sharp-corner subdivision (`subdivideSharpPolylineCorners2D`) and miter beveling.
   - `src/world/infrastructure/rendering/InfrastructureShaderChunks.ts`: Configures derivative-filtered (`fwidth`) procedural sleeper and dual-rail shaders with energy-conserving coverage attenuation (`1.0 / sqrt(coverageBoost)`) at medium and overview zoom levels.
   - `src/world/infrastructure/railways/RailwayTopology.ts`: Defines canonical `RAILWAY_DIMENSION_SPEC` (`1.435 m` clear inner gauge, `0.20 m` rail width, `1.635 m` center-to-center rail spacing, `+0.012 m` sleeper step, `+0.013 m` rail step), mainline-first topological chaining (`sortRailwaysMainlineFirst`), continuous arc-length phase propagation (`computeContinuousTrackPhases`), `8 m x 8 m` spatial indexing (`HostTrackSpatialIndex`), turnout-throat pair classification (`isTurnoutThroatPair`), and multi-interval Minkowski clipping (`subtractIntervalFromList`).
   - `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`: Synthesizes the complete hybrid railway scene graph (`buildRailwayInfrastructure`) and delegates Stage 5 of `GeometryBuilder.buildScene()`.

2. **Two-Pass Sleeper Placement & Explicit Track Support (`supportedTrackIds`)**:
   - **Pass 1 (Mainline & Turnout Shared Bearers)**: Generates sleepers along mainline tracks (`branchCount === 0`). Where a track lies within a genuine turnout throat (`isTurnoutThroatPair`: shared topological switch node or minimum polyline approach `< 0.55 m` at shallow angle `cosAngle > 0.86`), the bearer laterally expands (`[uMin, uMax]`, capped at `4.90 m`) across both tracks and records both track IDs in `supportedTrackIds`.
   - **Pass 2 (Branching & Parallel Track Sleepers)**: Before skipping a candidate sleeper because its center falls inside an existing sleeper footprint, verifies `existing.supportedTrackIds.has(trackIdx)`. For closely spaced independent parallel tracks (`centerDist < tieWidth`), symmetrically bounds the lateral interval at the inter-track midpoint (`0.5 * centerDist - 0.02 m`) and applies exact multi-interval clipping (`subtractIntervalFromList`) against existing foreign sleepers so both left and right remainders around diamond crossings are preserved.

3. **Camera-Zoom Hybrid LOD Switching (`zoomThreshold = 4.5 CSS px/m`)**:
   - **Close Zoom (`zoom > 4.5`)**: Renders 3D instanced timber/concrete sleeper boxes (`THREE.InstancedMesh` in `Railway_Sleepers_3D`) and 3D extruded twin steel rails (`Railway_Rails_3D`) with switch-blade inner-rail width tapering (`0.32 -> 1.0` over `4.2 m`) at genuine turnout toes.
   - **Medium / Overview Zoom (`zoom <= 4.5`)**: Switches to flat continuous UV-ribbons (`Railway_Sleepers` and `Railway_Rails`) shaded via analytic `fwidth` derivative box-filtering.

4. **Static Spatial Chunking (`128 m x 128 m`) & Adaptive Bridge Profile Sampling**:
   - Partitions railway geometry and instanced sleeper meshes into `128 m x 128 m` spatial chunks under their respective layer groups (`Railway_Ballast`, `Railway_Sleepers`, `Railway_Rails`, `Railway_Sleepers_3D`, `Railway_Rails_3D`) to accelerate frustum culling and raycast bounding-sphere rejection while preserving aggregated `userData.faceRanges` and `userData.instanceInfos` on the parent layer group.
   - Adaptively skips redundant `buildBridgeProfile3D` resamples on interior colinear segments far from bridge ramps (`adaptiveBridgeSampling: true`).

---

## Alternatives Considered

1. **Goalpost 1 Baseline (Discrete FlatSleeper Quads + Polyline Clearance Clipping)**:
   - *Description*: CPU clearance clipping (`resolveRailPolylineClearance`) + vertex-space screen-width clamping (`applyRibbonMinScreenWidthShader`).
   - *Pros*: Simple flat ribbon meshes.
   - *Cons / Why Rejected*: Suffered from switch luminance blooming, 3m rail gaps when trimmed, and missing sleepers along converging turnouts and parallel tracks (`TKT-001`).

2. **Candidate A (Pure Procedural Multi-Layer UV-Ribbons at All Zooms)**:
   - *Description*: Uses flat UV-parameterized ribbons with `fwidth` procedural shaders across all zoom levels (`0.85` to `8.0+`).
   - *Pros*: Lowest vertex count (`48,370` vertices on the 65-way switchyard) and fastest build time (`193 ms` on Amsterdam Centraal).
   - *Cons / Why Rejected*: Lacks true 3D volumetric sleeper depth, 3D rail vertical side walls, and elongated shared physical turnout bearers when inspected at close zoom (`zoom = 8.0`).

3. **Unoptimized Candidate B (Merged BufferGeometry 3D Sleepers without Spatial Grid)**:
   - *Description*: Merged every 3D sleeper box into a single `BufferGeometry` using $O(N_{\text{sleepers}} \times N_{\text{ways}})$ brute-force conflict checks.
   - *Pros*: Identical close-zoom visual fidelity to optimized Candidate B.
   - *Cons / Why Rejected*: Required `29,002 ms` build time and `63.68 MB` buffer memory on Amsterdam Centraal. Replacing brute-force scans with `HostTrackSpatialIndex` (`8 m x 8 m` cells), `THREE.InstancedMesh` sleepers, adaptive bridge sampling, and `128 m` spatial chunking reduced Amsterdam Centraal railway build time to `705.9 ms` (`41.1x` speedup) and buffer memory to `8.09 MB` (`87.3%` reduction).

---

## Consequences and Trade-Offs

### Positive
- **Complete Rail Support**: Every rail across complex turnouts, crossovers, and closely spaced parallel tracks (`2.1 m–2.5 m`) receives continuous physical sleeper support (`<= 1.65 m` maximum unsupported span; `100%` support coverage verified on synthetic and real OSM datasets).
- **Zero Duplicate / Interleaved Sleeper Clutter**: Separating Axis Theorem (SAT) 2D OBB checks confirm `0` overlapping inter-track sleeper boxes while synthesizing `383` elongated shared turnout bearers on the 65-way switchyard (`1,227` on Hengelo, `867` on Amsterdam Centraal).
- **High Runtime & Build Efficiency**: On Amsterdam Centraal (`160` ways), railway build time is `~706 ms`, railway GPU buffer memory is `8.09 MB`, Node-side `railwaysGroup` raycast inspection takes `3.50 ms`, and manual interactive browser observation confirms smooth `~144 FPS` rendering.
- **Clean Separation of Concerns**: `GeometryBuilder.ts` is reduced by over `850` lines of railway-specific heuristics, delegating railway synthesis to `src/world/infrastructure/railways/RailwayGeometryBuilder.ts` while reusing `UvRibbonBuilder` and `InfrastructureShaderChunks` for future Goalpost 2 road markings (`M2.4`).

### Negative / Neutral
- **Slightly Higher Build Time & Memory than Candidate A**: Optimized Candidate B uses `8.09 MB` vs Candidate A's `1.12 MB` on Amsterdam Centraal to store 3D extruded rail ribbons and `9,569` instanced 3D sleeper matrices, which is well within offline/static map preparation and GPU memory budgets.
- **Chunked Group Hierarchy**: When `spatialChunkSizeMeters: 128` is enabled, each railway sub-layer inside `railwaysGroup` is a `THREE.Group` containing per-chunk `THREE.Mesh` / `THREE.InstancedMesh` children, with aggregated `faceRanges` and `instanceInfos` attached to both the parent layer group and individual chunk meshes.

---

## Related Source Modules

- `src/world/infrastructure/rendering/UvRibbonBuilder.ts`
- `src/world/infrastructure/rendering/InfrastructureShaderChunks.ts`
- `src/world/infrastructure/railways/RailwayTopology.ts`
- `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`
- `src/world/GeometryBuilder.ts`
- `src/world/prototype/RailwayPrototypeBuilder.ts`

---

## Tests and Evidence

- `src/world/RailwayRendering.test.ts`: Production unit and integration tests covering `UvRibbonBuilder`, `RailwayTopology`, turnout/parallel sleeper support, zoom LOD switching (`zoom = 8.0` vs `zoom = 1.0`), `faceRanges` / `instanceInfos` provenance, 4-theme updates, and `SceneResourceManager` disposal.
- `src/world/PerformanceBaseline.test.ts`: 14 benchmark and geometric regression tests covering the 65-way switchyard, closely spaced parallel tracks (`2.1 m–2.5 m`), turnout-to-parallel transitions, Station Hengelo (`67` ways), and Amsterdam Centraal (`160` ways).
- `docs/m2-1-railway-prototype-report.md` & `docs/m2-1-baseline-data.json`: Recorded M2.1 evaluation report and single-source benchmark dataset.

---

## Superseded or Related Decisions

- Related to `ADR-0004` (Grade-Separated Infrastructure & Elevation Policy), `ADR-0005` (Source-Feature Provenance Tracking), and `ADR-0006` (GPU Resource Lifecycle and Disposal).
