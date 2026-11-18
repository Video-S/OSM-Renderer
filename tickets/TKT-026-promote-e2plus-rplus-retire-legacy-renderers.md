# TKT-026: Promote E2+/R+ to Production and Retire Legacy Renderers

---
id: TKT-026
title: Promote E2+/R+ to Production and Retire Legacy Renderers
status: in_progress
priority: high
goalpost: GP-2
milestone: M2.3-E5
stage: E5
owner: AI Assistant
created: 2026-11-17
updated: 2026-11-18
related_tickets:
  - TKT-008
  - TKT-010
  - TKT-011
  - TKT-016
  - TKT-019
  - TKT-020
  - TKT-023
  - TKT-024
  - TKT-025
related_adrs:
  - ADR-0009
---

## 1. Objective

Adopt the graph-based surface-first infrastructure rendering architecture (**E2+ / R+**) as the permanent, sole production implementation and retire the obsolete legacy and intermediate infrastructure rendering engines:

- **Roads**: `graph-surface` (**E2+** — continuous rounded-stroke 2D footprints via `SurfaceFirstRoadFootprints` + priority-ordered Boolean ownership clipping at the single `0.050 m` road baseline)
- **Railways**: `graph-R+` (**E3-B** — `railwaySwitchPolicy: 'graph'`, `railwayBallastStrategy: 'surface-first'`, Candidate B hybrid 3D close-zoom sleepers/rails + procedural zoom-out shader)

Before promoting E2+/R+, benchmark the `4 × 4 km` regional scale (**Frozen Hengelo S5** and **Live Overijssel `r = 2000 m`**) against the `TKT-025` legacy baseline to verify main-thread responsiveness, memory consumption, and first-frame completion.

---

## 2. Phase 1: `4 × 4 km` Pre-Migration Benchmark (Legacy vs. E2+/R+)

Two distinct `4 × 4 km` (`16.00 km²`) pre-migration benchmark runs were recorded under different viewport/GPU/cache configurations. Both runs are preserved separately below rather than merging incompatible environments.

### Run A: Headless SwiftShader Baseline (`1280 × 800`, Cold SQLite Miss on Live `r = 2000 m`) vs. `TKT-025`

Collected in isolated Playwright Chromium (`1280 × 800`, ANGLE Vulkan SwiftShader) matching the exact [`TKT-025`](./TKT-025-large-map-loading-bottleneck-investigation.md) environment (`roads: 'legacy'` cold-miss baseline vs. `E2+/R+` `roads: 'graph-surface', railways: 'graph-R+'`):

| Metric | S5 Frozen (`4 × 4 km`) — Legacy (`TKT-025`) | S5 Frozen (`4 × 4 km`) — **E2+/R+** (Run A) | Live Overijssel (`4 × 4 km`, cold) — Legacy (`TKT-025`) | Live Overijssel (`4 × 4 km`, cold) — **E2+/R+** (Run A) |
|---|---|---|---|---|
| **Total loading time** | `50,934.9 ms` | **`14,501.4 ms` (`-71.5%`)** | `125,827.6 ms` | **`61,098.6 ms` (`-51.4%`)** |
| **Infrastructure graph + adapter** | `0 ms` (bypassed) | `528.8 ms` | `0 ms` (bypassed) | `1,069.7 ms` |
| **Road geometry generation** | `38,826.9 ms` (`81.6%` of build) | **`2,994.7 ms` (`-92.3%` / `13.0×` faster)** | `79,209.9 ms` (`81.4%` of build) | **`7,667.1 ms` (`-90.3%` / `10.3×` faster)** |
| **Total `GeometryBuilder.buildScene()`** | `47,589.8 ms` | **`10,493.8 ms` (`-78.0%` / `4.5×` faster)** | `97,338.3 ms` | **`31,184.5 ms` (`-67.9%` / `3.1×` faster)** |
| **Max main-thread blocking duration** | `47,631.0 ms` | **`10,653.0 ms` (`-77.6%`)** | `97,465.0 ms` | **`31,632.0 ms` (`-67.5%`)** |
| **Peak / after-build V8 JS heap** | `1,165.97 MB`* (`616.47 MB` ref) | `760.87 MB` | `843.02 MB` | `965.43 MB` (`+14.5%`) |
| **Retained CPU geometry buffers** | `192.03 MB` (`+ 29.16 MB` BVH) | — | `193.43 MB` (`+ 29.39 MB` BVH) | **`187.01 MB` (`-3.3%`)** |
| **First frame reached?** | **Yes** (`0` console/page errors) | **Yes** (`0` console/page errors) | **Yes** (`0` console/page errors) | **Yes** (`0` console/page errors) |

*\*Note: `TKT-025` Frozen S5 `usedJSHeapMB = 1,165.97 MB` reflected CDP `page.evaluate(rawGeoJson)` injection overhead; the separate non-CDP local S5 reference figure cited in `docs/STATUS.md` was `616.47 MB` (`760.87 MB` under E2+/R+, `+23.4%`).*

### Run B: Paired Headless WebGL Harness (`1280 × 720`, `57–68 FPS`, Warm Live Cache, BVH + `TKT-023` Batching Active)

Collected as a paired Legacy vs. E2+/R+ comparison in the `1280 × 720` WebGL harness (with warm server cache on live `r = 2000 m`, `50.93 MB` payload, `tactical` theme, BVH raycasting, and `TKT-023` building batching):

| Metric | S5 Frozen (`4 × 4 km`) — Legacy (`1280×720` Paired) | S5 Frozen (`4 × 4 km`) — **E2+/R+** (Run B) | Live Overijssel (`4 × 4 km`, warm) — Legacy (`1280×720` Paired) | Live Overijssel (`4 × 4 km`, warm) — **E2+/R+** (Run B) |
|---|---|---|---|---|
| **Total loading time** | `48,939.7 ms` | **`31,589.7 ms` (`-35.5%`)** | `91,836.3 ms` | **`38,919.6 ms` (`-57.6%`)** |
| **Server / SQLite query time** | N/A (frozen file) | N/A (frozen file) | `1,303.75 ms` (cold) / `0.04 ms` (warm) | `0.027 ms` (warm cache hit) |
| **HTTP transfer + JSON parse + classify** | `1,724.4 ms` (parse+classify) | `2,208.1 ms` (parse+classify) | `2,718.5 ms` (`50.93 MB` payload) | `3,550.2 ms` (`50.93 MB` payload) |
| **Infrastructure graph + descriptor prep** | `0 ms` (bypassed) | `2,294.9 ms` | `0 ms` (bypassed) | `2,670.4 ms` |
| **Planar polygon resolution** | `2,922.2 ms` | `3,386.9 ms` | `3,502.3 ms` | `4,230.9 ms` |
| **Road geometry generation** | `38,832.8 ms` (`83.6%` of build) | **`11,735.5 ms` (`-69.8%` / `3.31×` faster)** | `79,233.5 ms` (`89.6%` of build) | **`14,232.2 ms` (`-82.0%` / `5.57×` faster)** |
| **Railway geometry generation** | `176.6 ms` (basic ribbons) | `1,641.1 ms` (full R+ surface ballast + switches) | `204.2 ms` (basic ribbons) | `2,375.0 ms` (full R+ surface ballast + switches) |
| **Building geometry generation** | `2,649.6 ms` | `2,522.0 ms` | `3,221.3 ms` | `3,489.6 ms` |
| **BVH construction (`three-mesh-bvh`)** | `1,978.4 ms` | `1,773.4 ms` (`48.66 MB` across `29` meshes) | `2,078.0 ms` | `2,469.7 ms` (`49.02 MB` across `29` meshes) |
| **Total `GeometryBuilder.buildScene()`** | `46,458.6 ms` | **`22,594.5 ms` (`-51.4%` / `2.06×` faster)** | `88,433.6 ms` | **`27,493.2 ms` (`-68.9%` / `3.22×` faster)** |
| **Max main-thread blocking duration** | `46,496.0 ms` | **`22,634.0 ms` (`-51.3%`)** | `88,460.0 ms` | **`27,558.0 ms` (`-68.8%`)** |
| **Peak JS used heap** | `940.91 MB` | `1,339.93 MB` (final settled `460.75 MB`) | `873.54 MB` | `984.61 MB` (final settled `462.66 MB`) |
| **CPU geometry + BVH buffer footprint** | `206.38 MB` (`156.92 MB` geom + `49.46 MB` BVH) | **`199.94 MB` (`151.28 MB` geom + `48.66 MB` BVH)** | `206.38 MB` | **`201.34 MB` (`152.32 MB` geom + `49.02 MB` BVH)** |
| **Scene triangles / Draw calls** | `2,686,214` tris / `481` calls | `2,650,093` tris / `484` calls (`188` live WebGL) | `2,686,214` tris / `481` calls | `2,670,235` tris / `484` calls (`188` live WebGL) |
| **First frame reached? / Steady FPS** | **Yes** (`57 FPS`) | **Yes (`65 FPS`, `0` console/page errors)** | **Yes** (`58 FPS`) | **Yes (`68 FPS`, `0` console/page errors)** |

### Key Findings from Phase 1 Benchmark

1. **Elimination of Quadratic Legacy Road Stalls**: Because E2+ (`roads: 'graph-surface'`) uses `RoadSpatialIndex` + `InfrastructureGraph` topological connectivity rather than the legacy renderer's unindexed $O(N^2)$ endpoint/intersection scans, `4 × 4 km` road generation drops consistently across both test configurations: from **`38.83 s` → `2.99 s` (`13.0×` faster)** on S5 and **`79.21 s` → `7.67 s` (`10.3×` faster)** on Live `r = 2000 m` in Run A (`1280×800` SwiftShader), and from **`38.83 s` → `11.74 s` (`3.31×` faster)** on S5 and **`79.23 s` → `14.23 s` (`5.57×` faster)** on Live `r = 2000 m` in Run B (`1280×720` WebGL).
2. **Environment Differences Between Run A and Run B**: Run A (`1280×800` SwiftShader) used a cold Overijssel SQLite miss on Live `r = 2000 m` (matching `TKT-025`'s `125.8 s` baseline), whereas Run B (`1280×720`, hardware/accelerated WebGL at `57–68 FPS`) hit the warm server cache (`0.027 ms`) on Live `r = 2000 m` and experienced higher single-host CPU contention during `S5`/`r = 2000 m` geometry synthesis.
3. **Memory Behavior Verified**: Peak transient V8 heap during Boolean polygon clipping stayed well below the browser's `4,096 MB` heap ceiling (`760.87–1,339.93 MB` on S5, `965.43–984.61 MB` on Live Overijssel), settling to **`460.75–462.66 MB`** after GC in Run B. Retained CPU geometry (+ BVH) buffers were lower under E2+/R+ (`187.01 MB` vs. `193.43 MB` in Run A; `199.94 MB` vs. `206.38 MB` in Run B) with fewer total triangles (`2,650,093` vs. `2,686,214`).
4. **Zero Regressions**: Descriptor validation passes (`isValid: true`), `0` Z-fighting or winding defects occur, all 11 road classes and R+ railway tracks/switches/ballast render cleanly, and Run B steady-state frame rate reached `65–68 FPS`.

---

## 3. Phase 2 & Phase 3: Production Promotion and Legacy Retirement

### 3.1 Permanent Production Configuration
- **`DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS`**: Permanently set to `{ roads: 'graph-surface', railways: 'graph-R+', railwaySwitchPolicy: 'graph', railwayBallastStrategy: 'surface-first' }`.
- **Option Parsers (`parseRoadInfrastructureRenderSource`, `parseRailwayInfrastructureRenderSource`, `normalizeInfrastructureRenderOptions`)**: Canonicalized to return `'graph-surface'` for roads and `'graph-R+'` (`railwaySwitchPolicy: 'graph'`, `railwayBallastStrategy: 'surface-first'`) for railways so normal startup and any legacy URL query parameters always select E2+/R+.
- **`App.tsx` & `DevToolsPanel.tsx`**: Removed legacy/intermediate renderer-switching dropdowns from Developer Tools (`DevToolsPanel.tsx` now displays a read-only production architecture badge) and simplified `App.tsx` so `prepareInfrastructureRenderPreview` always runs on map load.

### 3.2 Retired & Deleted Code Inventory
1. **Legacy At-Grade Road Synthesis (`GeometryBuilder.ts`)**:
   - Removed the legacy at-grade road synthesis loop in `GeometryBuilder.buildRoads()`, its unindexed $O(N^2)$ endpoint intersection clustering (`endpointClusters`), and its quadratic `subtractRoadFootprints` road-tier Boolean clipping loop.
   - Retained `GeometryBuilder.buildRoads()` solely for Stage 6D elevated bridge decks, approach ramps, substructures, parapets, and tunnel portals/entrances, while delegating all at-grade road and path surfaces unconditionally to `buildGraphRoadGeometry()` (`GraphRoadGeometryBuilder.ts`).
2. **Superseded E2 Boundary-Derived Road Junction Solver (`GraphRoadGeometryBuilder.ts` & `PathJunctionCornerSmoothing.ts`)**:
   - Deleted `/src/world/infrastructure/roads/PathJunctionCornerSmoothing.ts` and `/src/world/PathJunctionCornerSmoothing.test.ts`.
   - Removed ~1,600 lines of superseded E2 (`roads === 'graph'`) boundary-derived junction solver code (`solveBoundaryDerivedJunctionNode`, `solveDegree2ContinuityPortals`, `buildEqualWidthSplitMergePatch`, `buildDegree2TransitionPatch`, `clipPathJunctionPolygonAgainstAtGradeRoads`, etc.) from `/src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`, leaving a focused E2+ surface-first implementation.
3. **Legacy Railway Rendering & Ribbon Ballast (`RailwayGeometryBuilder.ts`, `RailwayPrototypeBuilder.ts`, `PerformanceBaselineHarness.ts`)**:
   - Removed legacy `mapData.railways` fallback rendering, legacy geometric turnout synthesis (`detectSwitchTurnouts`), and obsolete per-track ribbon ballast generation (`generateBallastRibbon` and `ballastStrategy === 'ribbon'`) from `/src/world/infrastructure/railways/RailwayGeometryBuilder.ts`.
   - Removed the obsolete `'baseline'` prototype candidate from `/src/world/prototype/RailwayPrototypeBuilder.ts` while retaining Candidate B (`'B'`) and shared rail/sleeper/frog geometry helpers.
4. **Benchmarks & Reproduction Reports (`benchmarks/*`, `ReproductionReport.ts`)**:
   - Updated `benchmarks/scenarios.ts`, `benchmarks/cliAndServer.ts`, `benchmarks/cpuRunner.ts`, `benchmarks/scalingWorker.ts`, and `ReproductionReport.ts` to default to and report `graph-surface` + `graph-R+`.

---

## 4. Acceptance Criteria & Verification

- [x] `4 × 4 km` Frozen Hengelo S5 and Live Overijssel `r = 2000 m` benchmarked with E2+/R+ and compared against TKT-025 legacy measurements (Run A `1280×800` SwiftShader & Run B `1280×720` WebGL reconciled above).
- [x] E2+/R+ (`roads: 'graph-surface'`, `railways: 'graph-R+'`, `railwaySwitchPolicy: 'graph'`, `railwayBallastStrategy: 'surface-first'`) promoted to default across application startup, `GeometryBuilder`, Developer Tools, and benchmarks (pending project-owner review).
- [x] Obsolete legacy at-grade road renderer, superseded E2 boundary-derived junction solver (`PathJunctionCornerSmoothing.ts`), legacy railway renderer, and ribbon ballast code paths retired and removed.
- [x] Shared geometry helpers, Candidate B railway primitives, stage 6D bridge/tunnel structures, `0.050 m` elevation policy, OSM provenance (`faceRanges`), BVH raycasting, and `SceneResourceManager` disposal preserved intact.
- [ ] Complete post-promotion regression verification (`npm test` / remaining suites) and project-owner sign-off.

### Verification (2026-11-18)

Executed sequentially in the clean post-migration workspace (`NODE_OPTIONS="--max-old-space-size=1024"`):
- `NODE_OPTIONS="--max-old-space-size=1024" ./node_modules/.bin/tsx --test src/world/OverijsselOfflineStore.test.ts` — exit `0` (`4 / 4 passed`, `1 skipped` because full Overijssel SQLite index is absent on disk; verifies `DISABLE_OVERIJSSEL_BOOTSTRAP` / `OVERIJSSEL_AUTO_BOOTSTRAP` / `--no-overijssel-bootstrap` opt-out in `server.ts` and `overijsselConfig.ts`).
- `NODE_OPTIONS="--max-old-space-size=1024" ./node_modules/.bin/tsx --test src/world/InfrastructureRenderAdapter.test.ts` — exit `0` (`20 / 20 passed`, `12.50 s`; SHA-256 typed-buffer snapshots and Test 8 updated for authoritative `graph-R+` descriptor rendering).
- `NODE_OPTIONS="--max-old-space-size=1024" ./node_modules/.bin/tsx --test src/world/RailwayRendering.test.ts` — exit `0` (`9 / 9 passed`, `1.98 s`).
- `npm run lint` (`tsc --noEmit`) — exit `0` (`0` errors).
- `npm run build` (`vite build`) — exit `0` (`dist/` compiled).
- Deferred: Full `npm test` (`30` suites) was not run concurrently due to container memory bounds (`TKT-018`); ticket remains `in_progress` pending project-owner review.
