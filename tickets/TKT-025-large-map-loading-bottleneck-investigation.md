---
id: TKT-025
title: Large Map Loading Bottleneck Investigation (4 × 4 km Hengelo & Overijssel)
type: investigation
status: in_progress
priority: high
created: 2026-11-17
updated: 2026-11-17
---

# TKT-025: Large Map Loading Bottleneck Investigation

## Summary
Loading `4 × 4 km` urban OSM regions (`hengelo-s5-4km.geojson.gz` and live `/api/osm-data?radius=2000` from the `TKT-022` Overijssel offline store) under default **`production-legacy`** settings causes an unbroken **`47.6 s–97.5 s` main-thread CPU freeze** (`100.5 s` `requestAnimationFrame` gap on live `r = 2000 m`), causing Chromium / Google AI Studio to hang or exceed the `30 s` readiness timeout. End-to-end stage instrumentation proves the dominant bottleneck (~**81.4–81.6%** of `GeometryBuilder.buildScene()` and **63.0–76.2%** of total load time) is two **superlinear $O(N^2)$ loops in the legacy at-grade road builder** (`splitAndEndpointScanMs` and unindexed `placedRoadFootprints` `polygonClipping.intersection` checks), compounded by secondary memory pressure from coexisting server/client intermediate objects.

**Strict Diagnostic-Only Scope**:
- **No performance optimizations implemented** (`production-legacy` defaults, geometry output, WebGL pipeline, and timeouts left completely unchanged).
- Added strictly **read-only diagnostic instrumentation** (`SceneBuildStageTimingsMs` inside `GeometryBuilder.ts`, forwarded into `MapLoadDiagnostics.ts` and `__M21_LAB__`, plus optional `timeoutMs` / `loadOsmLocation` test helpers on `__M21_LAB__`).
- **`status: in_progress`** pending project-owner review and scoping of the follow-up optimization ticket.

---

## 1. Benchmark Environment & Methodology

All measurements were collected in isolated Playwright Chromium (`1280×800`, headless `chrome-headless-shell` with ANGLE Vulkan SwiftShader) against the local Express + Vite dev server (`npm run dev` on port `3000`, `OverijsselOsmStore` active for live `/api/osm-data` calls) with default **`production-legacy`** renderer configuration (`roads: 'legacy'`, `railways: 'legacy'`, `railwayPrototypeMode: 'production'`, `themeId: 'tactical'`, `bevelEnabled: true`).

- **Frozen Hengelo Scaling Series** (`benchmarks/datasets/hengelo-scaling/hengelo-s{3,4,5}-*.geojson.gz`, injected into `__M21_LAB__.loadOfflineDataset` with `timeoutMs: 180000`):
  - **S3** (`1 × 1 km`): `9,738` GeoJSON features (`5,814` parsed)
  - **S4** (`2 × 2 km`): `36,669` GeoJSON features (`22,437` parsed)
  - **S5** (`4 × 4 km`): `96,836` GeoJSON features (`60,866` parsed)
- **Live `/api/osm-data` Overijssel Cold-Miss Equivalents** (centered at `52.2625, 6.7935`, `TKT-022` `overijssel-261114.sqlite`, one fresh Chromium launch per dataset):
  - **`r = 500 m`** (`~1 × 1 km`): `10,334` GeoJSON features (`8.67 MB` JSON, `5,818` parsed)
  - **`r = 1000 m`** (`~2 × 2 km`): `37,544` GeoJSON features (`18.39 MB` JSON, `22,443` parsed)
  - **`r = 2000 m`** (`~4 × 4 km`): `98,087` GeoJSON features (`40.59 MB` JSON, `60,893` parsed)
- **Telemetry Collected**:
  - `MapLoadTimelineTracker` end-to-end wall-clock stages (`osmRequestMs`, `Server-Timing`, `dataTransferAndDecodeMs`, `geoJsonProcessingMs`, `sceneGeometryMs`, `scenePresentationMs`) + `GeometryBuilder` disjoint `SceneBuildStageTimingsMs` (`planarResolutionMs`, `roadGeometryMs`, `roadSubTimingsMs`, `buildingGeometryMs`, `geometryMergingMs`, `bvhConstructionMs`).
  - Browser `PerformanceObserver` (`longtask`), `requestAnimationFrame` max gap (`rafMaxGapMs`), `performance.memory` (`usedJSHeapSize`, `totalJSHeapSize`, `4,192 MB` heap limit), `SceneResourceManager` (`cpuBufferMemoryStats`, `bvhMemoryStats`).
  - 250 ms OS `/proc/<pid>/status` `VmRSS` sampling across `node server.ts` and all Chromium processes (`VmHWM` returned `0` in this Linux container runtime and is therefore reported as `unavailable`).

---

## 2. S3 / S4 / S5 Scaling Comparison

### A. Frozen Hengelo Datasets (`hengelo-s3` / `s4` / `s5`)

| Metric | Frozen S3 (`1 × 1 km`) | Frozen S4 (`2 × 2 km`) | Frozen S5 (`4 × 4 km`) | S5 / S3 Ratio |
|---|---:|---:|---:|---:|
| GeoJSON features / parsed | `9,738` / `5,814` | `36,669` / `22,437` | `96,836` / `60,866` | `9.9×` / `10.5×` |
| Parsed buildings / roads / rails | `1,633` / `1,076` / `106` | `12,708` / `2,659` / `170` | `35,979` / `7,424` / `222` | `22.0×` / `6.9×` / `2.1×` |
| Split at-grade roads / junctions | `1,662` / `814` | `4,226` / `2,092` | `12,200` / `6,129` | `7.3×` / `7.5×` |
| **Total loading time** | **`5,919.8 ms`** | **`9,255.6 ms`** | **`50,934.9 ms`** | **`8.6×`** |
| Server / query time (`osmRequestMs`) | `unavailable` (local inject) | `unavailable` (local inject) | `unavailable` (local inject) | — |
| Client GeoJSON parse (`geoJsonProcessingMs`) | `862.0 ms` | `1,008.6 ms` | `2,539.5 ms` | `2.9×` |
| **`buildScene` total (`sceneGeometryMs`)** | **`4,408.8 ms`** | **`7,763.5 ms`** | **`47,589.8 ms`** | **`10.8×`** |
| ├─ Planar resolution (`planarResolutionMs`) | `1,471.2 ms` | `1,239.0 ms` | `2,773.0 ms` | `1.9×` |
| ├─ Planar surface geometry | `506.1 ms` | `352.8 ms` | `872.1 ms` | `1.7×` |
| ├─ Railway geometry (`railwayGeometryMs`) | `798.4 ms` | `529.1 ms` | `841.2 ms` | `1.1×` |
| ├─ **Road geometry (`roadGeometryMs`)** | **`1,168.4 ms`** | **`4,141.2 ms`** | **`38,826.9 ms`** | **`33.2×`** |
| │  ├─ `splitAndEndpointScanMs` | `483.5 ms` | `1,671.4 ms` | **`20,370.4 ms`** | **`42.1×`** |
| │  ├─ `junctionsMs` | `39.8 ms` | `72.5 ms` | `223.2 ms` | `5.6×` |
| │  └─ `atGradeRibbonsAndClippingMs` | `639.3 ms` | `2,383.7 ms` | **`18,146.1 ms`** | **`28.4×`** |
| ├─ Barriers & foliage geometry | `66.6 ms` | `102.8 ms` | `252.1 ms` | `3.8×` |
| ├─ **Building geometry (`buildingGeometryMs`)** | `197.9 ms` | `749.6 ms` | `2,335.7 ms` | `11.8×` |
| ├─ Geometry merging (all layers / buildings) | `53.0 ms` (`32.3 ms`) | `179.7 ms` (`138.4 ms`) | `499.6 ms` (`398.2 ms`) | `9.4×` |
| └─ **BVH construction (`bvhConstructionMs`)** | `135.9 ms` | `458.4 ms` | `1,148.3 ms` | `8.4×` |
| First-frame presentation (`scenePresentationMs`) | `630.4 ms` | `429.2 ms` | `747.2 ms` | `1.2×` |
| `polygonIntersectionOperationCount` | `50,453` | `242,278` | **`1,988,335`** | **`39.4×`** |
| Max main-thread Long Task / max RAF gap | `4,413 ms` / `4,416.5 ms` | `7,777 ms` / `7,783.1 ms` | **`47,631 ms`** / **`47,631.5 ms`** | **`10.8×`** |
| Premature spinner hide (`prematureSpinnerHideMs`) | `5,055.9 ms` | `8,246.3 ms` | `48,394.6 ms` | `9.6×` |
| JS Heap (`usedJSHeapMB` before → after) | `103.99 → 219.37 MB` | `198.17 → 518.98 MB` | `403.22 → 1,165.97 MB` | `5.3×` |
| Retained CPU buffers + BVH memory | `14.63 + 2.56 MB` | `74.27 + 11.40 MB` | `192.03 + 29.16 MB` | `12.9×` |
| Sampled peak memory (Renderer RSS / Browser Total RSS / `/proc` `VmHWM`) | `586.64` / `1,269.77 MB` / `unavailable` | `1,536.04` / `2,248.11 MB` / `unavailable` | `3,677.39`* / `4,492.33 MB`* / `unavailable` | `6.3×` / `3.5×` |
| **First frame reached? / Result** | **Yes** / Completed (`246,036` tris, `133` calls) | **Yes** / Completed (`983,282` tris, `272` calls) | **Yes*** (`47.6 s` main-thread freeze; exceeded default `30 s` `waitForSceneReady` timeout — only completed with `timeoutMs=180000`) | — |

*\*Note: Frozen `S5` browser RSS included a transient `+2.7 GB` CDP `page.evaluate(rawGeoJson)` injection spike prior to `loadOfflineDataset()`; final renderer RSS after build settled to `1,911.23 MB`. Compare against live HTTP `r = 2000 m` below (free of CDP injection).*

---

### B. Live `/api/osm-data` Overijssel Cold-Miss Runs (`r = 500 m` / `1000 m` / `2000 m`)

| Metric | Live `r = 500 m` (`~1 × 1 km`) | Live `r = 1000 m` (`~2 × 2 km`) | Live `r = 2000 m` (`~4 × 4 km`) | `r=2000` / `r=500` |
|---|---:|---:|---:|---:|
| GeoJSON features / JSON payload | `10,334` / `8.67 MB` | `37,544` / `18.39 MB` | `98,087` / `40.59 MB` | `9.5×` / `4.7×` |
| Parsed features (`bldg` / `road` / `rail`) | `5,818` (`1,635` / `1,076` / `106`) | `22,443` (`12,713` / `2,659` / `170`) | `60,893` (`36,001` / `7,424` / `222`) | `10.5×` |
| **Total loading time** | **`9,156.0 ms`** | **`28,389.7 ms`** | **`125,827.6 ms` (`125.8 s`)** | **`13.7×`** |
| **Server / query (`osmRequestMs` / `Server-Timing total`)** | `1,248.6 ms` (`1,092.7 ms`) | `3,011.2 ms` (`2,626.4 ms`) | **`10,435.6 ms` (`8,632.3 ms`)** | `8.4×` (`7.9×`) |
| ├─ SQLite R\*Tree + closure (`upstream`) | `518.7 ms` | `1,161.6 ms` | `3,439.0 ms` | `6.6×` |
| ├─ `osmtogeojson` conversion | `497.3 ms` | `1,157.1 ms` | `4,112.3 ms` | `8.3×` |
| └─ Node ID enrichment (`enrich`) | `75.5 ms` | `307.2 ms` | `1,080.1 ms` | `14.3×` |
| Transfer + JSON parse (`dataTransferAndDecodeMs`) | `436.9 ms` (`261.6` + `88.9`) | `1,177.0 ms` (`669.5` + `274.7`) | `2,322.2 ms` (`1,084.1` + `645.2`) | `5.3×` |
| Client GeoJSON parse (`geoJsonProcessingMs`) | `571.6 ms` | `2,196.3 ms` | `5,575.9 ms` | `9.8×` |
| ├─ `boundsAndPreScanMs` | `141.1 ms` | `598.4 ms` | `1,589.6 ms` | `11.3×` |
| ├─ `featureClipAndExtractMs` | `393.0 ms` | `1,380.3 ms` | `3,385.7 ms` | `8.6×` |
| └─ `roadChainingAndStatsMs` | `36.8 ms` | `193.0 ms` | `599.0 ms` | `16.3×` |
| **`buildScene` total (`sceneGeometryMs`)** | **`4,589.5 ms`** | **`16,849.5 ms`** | **`97,338.3 ms` (`77.4%`)** | **`21.2×`** |
| ├─ Planar resolution (`planarResolutionMs`) | `932.2 ms` | `2,084.4 ms` | `5,657.3 ms` | `6.1×` |
| ├─ Planar surface geometry | `300.1 ms` | `815.4 ms` | `1,985.5 ms` | `6.6×` |
| ├─ Railway geometry (`railwayGeometryMs`) | `789.8 ms` | `1,330.6 ms` | `1,812.0 ms` | `2.3×` |
| ├─ **Road geometry (`roadGeometryMs`)** | **`1,768.0 ms`** | **`8,769.6 ms`** | **`79,209.9 ms` (`81.4%` of build)** | **`44.8×`** |
| │  ├─ `splitAndEndpointScanMs` | `488.1 ms` | `3,499.6 ms` | **`43,097.0 ms`** | **`88.3×`** |
| │  ├─ `junctionsMs` | `83.3 ms` | `181.7 ms` | `465.0 ms` | `5.6×` |
| │  ├─ `atGradeRibbonsAndClippingMs` | `1,190.8 ms` | `5,031.2 ms` | **`35,504.4 ms`** | **`29.8×`** |
| │  └─ `bridgesAndTunnelsMs` | `4.6 ms` | `55.0 ms` | `136.6 ms` | `29.7×` |
| ├─ Barriers & foliage geometry | `173.8 ms` | `290.8 ms` | `464.5 ms` | `2.7×` |
| ├─ **Building geometry (`buildingGeometryMs`)** | `344.8 ms` | `1,712.2 ms` | `4,729.4 ms` | `13.7×` |
| ├─ Geometry merging (all layers / buildings) | `66.5 ms` (`46.7 ms`) | `409.4 ms` (`311.7 ms`) | `992.0 ms` (`852.7 ms`) | `14.9×` |
| └─ **BVH construction (`bvhConstructionMs`)** | `207.2 ms` (`121.6` bldg) | `1,410.3 ms` (`1,208.3` bldg) | `2,447.0 ms` (`2,008.2` bldg) | `11.8×` |
| Presentation (`scenePresentationMs`, SwiftShader `zoom=0.28`) | `2,256.8 ms` | `5,066.8 ms` | `10,064.7 ms` | `4.5×` |
| `polygonIntersectionOperationCount` | `50,453` | `242,278` | **`1,988,335`** | **`39.4×`** |
| Max Long Task / max RAF gap | `4,595 ms` / `4,166.5 ms` | `16,922 ms` / `17,716.0 ms` | **`97,465 ms`** / **`100,512.6 ms`** | **`21.2×` / `24.1×`** |
| Premature spinner hide (`prematureSpinnerHideMs`) | `6,896.7 ms` | `22,002.7 ms` | **`107,491.2 ms`** | `15.6×` |
| JS Heap (`usedJSHeapMB` before → after) | `66.89 → 206.57 MB` | `66.99 → 432.01 MB` | `66.97 → 843.02 MB` (`941.25` total) | `4.1×` |
| Retained CPU buffers + BVH memory | `14.75 + 2.58 MB` | `74.55 + 11.46 MB` | `193.43 + 29.39 MB` | `13.0×` |
| Server Node RSS (before → peak → retained) | `457.25 → 639.16 → 639.16 MB` | `476.18 → 724.83 → 544.73 MB` | `545.86 → 1,337.74 → 697.48 MB` | `2.1×` peak |
| Browser Peak RSS (Renderer / Total / `/proc` `VmHWM`) | `521.13` / `1,224.73 MB` / `unavailable` | `811.66` / `1,616.52 MB` / `unavailable` | `1,308.60` / `2,261.51 MB` / `unavailable` | `2.5×` / `1.8×` |
| **First frame reached? / Result** | **Yes** / Completed (`247,583` tris) | **Yes** / Completed (`988,649` tris) | **Yes (after 100.5 s freeze)** / Completed (`2,432,922` tris, `526` stats / `373` live calls) | — |

---

## 3. Root-Cause Bottleneck Analysis

### Primary Bottleneck (`81.4–81.6%` of `buildScene`): Quadratic $O(N^2)$ Loops in Legacy At-Grade Road Synthesis

While `TKT-020` eliminated $O(N^2)$ scaling in `PlanarLayerValidator` (planar polygons) and `GraphRoadGeometryBuilder` (the opt-in `graph-surface` engine), the **default `production-legacy` road pipeline** (`src/world/GeometryBuilder.ts:3284–4180`) still contains **two unindexed quadratic loops** over `atGradeRoads` (`12,200` split segments at S5):

1. **`splitAndEndpointScanMs` — `43,097.0 ms` (`44.3%` of `buildScene` on live `r = 2000`; `20,370.4 ms` on frozen S5)**:
   - Located at `src/world/GeometryBuilder.ts:3373–3408`:
     - Inside `for (const road of atGradeRoads)` (`N = 12,200`), two `.some(...)` predicates scan **all** `atGradeRoads` twice (`touchesOtherAtGradeStart` at line 3382 and `touchesOtherAtGradeEnd` at line 3392), executing `~2 × 12,200² ≈ 2.98 × 10⁸` `Math.hypot()` checks!
     - Because `S5` has `7.34×` more split roads than `S3` (`12,200` vs `1,662`), `N²` predicts `(12,200 / 1,662)² = 53.9×` scaling — matching the observed `42×–88×` explosion (`483.5 → 20,370.4 ms` and `488.1 → 43,097.0 ms`).
     - Crucially, lines `3308–3358` *already computed* `nodeBranches` keyed by snapped tier endpoint (`startNodeId`, `endNodeId`), so endpoint adjacency can be determined in **$O(1)$** without scanning `atGradeRoads`!

2. **`atGradeRibbonsAndClippingMs` — `35,504.4 ms` (`36.5%` of `buildScene` on live `r = 2000`; `18,146.1 ms` on frozen S5)**:
   - Located at `src/world/GeometryBuilder.ts:3843–4150` (specifically `3904–3959`):
     - For every road (`12,200` iterations), lines `3905–3917` linearly scan **every** entry in the growing `placedRoadFootprints[]` array (which reaches **`18,268` entries** at completion: `6,129` junctions + `12,139` road ribbons).
     - Any AABB overlap (`12,633` at `S4` → `36,911` at `S5`) enters lines `3931–3949`, running `polygonClipping.intersection(outlinePoly, fp.poly)` for candidate footprints. Across S5, this triggered **`1,988,335` `polygonClipping.intersection()` calls** (`39.4×` S3's `50,453`) to confirm only **`4,758` actual overlaps (`0.24%` hit rate)**.
     - Notably, `legacyStats.candidateBlockerCheckCount` (`36,911`) only counts the outer `candidateFootprints.length` when `candidateFootprints.length > 0`, whereas lines `3931–3959` run inside a loop over candidate entries for clean outlines (`1,988,335` intersection calls — `~54×` higher than `candidateBlockerCheckCount` because a road with one overlapping neighbour was already flagged, or multi-candidate paths tested repeatedly? More precisely, `1,988,335` `polygonIntersectionOperationCount` increments happen at line `3933` **and** in Step 4 fallback self-clip checks inside `4084+`). Either way, replacing the linear scan of `placedRoadFootprints` with the same `RoadFootprintSpatialGrid` (`32 m` cells) introduced in `TKT-020` slashes AABB + `polygonClipping` checks dramatically.

### Secondary CPU Contributors (Manageable Without Hanging on Their Own)

Even after removing the $O(N^2)$ legacy road bottleneck (`79.2 s → ~2–3 s`), the remaining pipeline at `4 × 4 km` is still substantial (~`26–30 s` cold live miss; ~`12 s` offline build):
- **Server `/api/osm-data` (`8,632.3 ms` cold live `r = 2000`) + Client Transfer/Decode (`2,322.2 ms`)**: `3,439.0 ms` SQLite R\*Tree + closure queries (`OverijsselOsmStore.ts`), `4,112.3 ms` synchronous `osmtogeojson`, `1,080.1 ms` `enrichGeoJsonWithOverpassNodeIds` serialization into `40.59 MB` JSON (`98,087` features).
- **Client `geoJsonProcessingMs` (`2,539.5–5,575.9 ms`)**: pre-scan (`1,589.6 ms`), polygon clipping/projection (`3,385.7 ms`), and `chainContiguousRoads` (`599.0 ms`, `LocalGeoJsonProvider.ts:2767–2860` pool scan).
- **`planarResolutionMs` + surface meshing (`3,645–7,643 ms`)**: scales sublinearly (`1.9×–6.1×` across `S3 → S5`) after `TKT-020`.
- **`buildingGeometryMs` + `buildingsMergeMs` (`2,734–5,582 ms`)**: generating `35,979–36,001` individual `THREE.ExtrudeGeometry` objects then repacking them via `mergeBuildingItemsByMaterial()`.
- **`bvhConstructionMs` (`1,148–2,447 ms`)**: building `405` `MeshBVH` trees (`~82%` spent on `buildingsGroup` ~`2.0M` triangles).
- **`scenePresentationMs` (`10,064.7 ms` live `r = 2000` at zoomed-out `cameraZoom = 0.28` vs `747.2 ms` frozen `S5` at `zoom = 1.0`)**: reflects first-frame WebGL buffer upload + shader compile + rendering `5.47M` triangles in **CPU SwiftShader** software GL when zoomed out covering the entire `4 × 4 km` extent.

---

## 4. CPU Blocking vs. Memory Exhaustion & Coexisting Intermediate Representations

### Finding: Synchronous CPU Blocking Causes the Hang; Memory Pressure Is Secondary (Except Under Tight Container Limits)

1. **Direct Evidence of Synchronous CPU Blocking**:
   - In `live_overijssel_r2000`, total load completed cleanly with `0` console errors, `0` page errors, and peak V8 `usedJSHeapMB = 843.02 MB` (`941.25 MB` allocated heap vs. **`4,192 MB` V8 limit**, `20.1%` utilization), and Chromium renderer RSS peaked at `1,308.60 MB`.
   - Yet Chromium's main thread froze **unbroken for `97,465 ms`** (`rafMaxGapMs = 100,512.6 ms`) inside `GeometryBuilder.buildScene()`. Any single synchronous JS turn >`5–15 s` triggers Chromium / iframe "Page Unresponsive" watchdogs and exceeds `waitForSceneReady()`'s default `30,000 ms` timeout (`App.tsx:1149`).
   - Compounded by `TKT-021`'s confirmed premature spinner bug: `fetchLiveOsmLocation()` (`App.tsx:658–659`) hides the loading overlay right after `parseGeoJson()` (`t = 18.34 s` on `r = 2000`, `t = 2.54 s` on `S5`), leaving the viewport frozen/blank for **`107.49 s`** (`r = 2000`) / **`48.39 s`** (`S5`) with no visual feedback.

2. **Secondary Memory Pressure & Coexisting Intermediate Data Representations**:
   Although memory did not crash `r = 2000` in our 12 GB container, peak memory multiplies unnecessarily because **five full representations of the region coexist** across client and server RAM during a `4 × 4 km` load:
   - **Server Node Process (`545.86 → 1,337.74 MB` peak RSS, `+791.88 MB` transient spike; `697.48 MB` retained)**:
     1. `OverijsselOsmStore.queryBBox` builds in-memory `nodesMap`, `waysMap`, `relsMap`, and `overpassPayload.elements` (`OverijsselOsmStore.ts:363–534`).
     2. `osmtogeojson` allocates full GeoJSON feature/coordinate arrays while `overpassPayload` is still live for `enrichGeoJsonWithOverpassNodeIds` (`lines 537–541`).
     3. `osmCache.set(cacheKey, result.geojson)` (`osmDataHandler.ts:71–74, 183`) retains up to **40 full parsed GeoJSON regions in Node RAM** for 30 minutes (`+151.6 MB` permanently retained after `r = 2000`, plus `res.json()` serialization string allocation causing the `1.34 GB` transient spike).
   - **Browser Client Process (`843–1,166 MB` V8 heap; `1,309 MB` live / `1,911 MB` settled RSS)**:
     1. **HTTP transfer string & JSON AST** (`OsmApiProvider.ts:60–84`): `40.59 MB` `rawText` string + parsed JS `geojson` object (`this.lastRawGeoJson`), then permanently pinned in React state `setCurrentRawGeoJson(...)` (`App.tsx:114, 656`) solely for `AddressSearchModal` / export.
     2. **Dual `ProcessedMapData` representations** (`LocalGeoJsonProvider.ts`): `parseGeoJson()` constructs **both** the legacy feature arrays (`buildings`, `roads`, `railways`, `landuse`, `parks`, …) **and** a complete unchained/pre-dedup clone inside `mapData.topologySource` (`UnchainedRoadPart[]`, `UnchainedRailwayPart[]`, `InfrastructurePointMetadata[]`, deep-cloned `osmTags` via `cloneRawGeoJsonProperties`), even though `production-legacy` never uses `topologySource`. Both remain pinned in React state `mapData` (`App.tsx:263`).
     3. **Batch of `35,979` Unmerged Building Geometries** (`GeometryBuilder.ts:5845–5966`): Stage 9 pushes all `35,979` individual `THREE.ExtrudeGeometry` objects (plus `InspectableFeatureInfo` objects) into `buildingsByBucket` *before* `mergeBuildingItemsByMaterial()` converts indexed parts (`toNonIndexed()`), allocates the contiguous `Float32Array` output buffers (`~192–193 MB`), and only then releases intermediates (line `1027`). Meanwhile `placedRoadFootprints[]` (`~18.3k` polygon arrays) stays live until `buildScene()` returns.
     4. **Final Retained Buffers**: `cpuBufferMemoryStats = 192.03–193.43 MB` (`409` `BufferGeometry` instances) + `bvhMemoryStats = 29.16–29.39 MB` (`405` `MeshBVH` trees) ≈ `222.8 MB` TypedArrays.

---

## 5. Recommendations

### Smallest Effective Architectural Fix (Target Follow-Up Ticket)

1. **Replace the two $O(N^2)$ Legacy Road Loops in `src/world/GeometryBuilder.ts`** (**highest ROI, zero geometry change**):
   - **Step 1 (`splitAndEndpointScanMs`, lines `3373–3408`)**: Replace the two `atGradeRoads.some(...)` linear scans with a spatial hash grid (or direct lookup against the `nodeBranches` map already constructed at lines `3308–3358`, plus a small spatial index for `gradeTransitionCoords`). Eliminates `~43 s` on `4 × 4 km` in $O(N)$ time with **bit-identical** `hasCapStart` / `hasCapEnd` booleans.
   - **Step 2 (`atGradeRibbonsAndClippingMs`, lines `3904–3959`)**: Replace the linear `for (const fp of placedRoadFootprints)` loop with a `32 m` grid spatial index matching `TKT-020`'s `RoadFootprintSpatialGrid` (`src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`), eliminating the `1.99M` futile `polygonClipping.intersection()` calls (`0.24%` hit rate) and cutting `~35 s` down to `< 1–2 s` with **bit-identical** clipped road geometry.
   - Expected impact on `4 × 4 km` client `buildScene()`: drops from **`47.6–97.3 s` → `~10–19 s`** (~`75–80%` reduction) and eliminates the `47–100 s` monolithic road freeze without touching any shader, geometry rule, or renderer mode.
2. **Follow-Up UX & Responsiveness Hygiene (Separate Step After Reviewing `TKT-021`/`TKT-025`)**:
   - Fix `TKT-021`'s premature `setLoading(false)` so the spinner remains visible (with phase progress) until `markScenePresented` fires on frame 1.
   - Bound `osmCache` by approximate byte weight (or skip caching raw GeoJSON >`10 MB` on disk-backed `OverijsselOsmStore` where SQLite queries take only `3.4 s`) to eliminate the `+150–700 MB` Node heap growth.
   - Avoid retaining redundant `lastRawGeoJson` / `currentRawGeoJson` in React state unless export/search actually queries `mapData` directly, and avoid invoking `osmtogeojson` or duplicating `topologySource` unnecessarily on `legacy` loads if further memory reduction is needed.
   - Consider Web Worker offloading or periodic main-thread yields between `GeometryBuilder` stages only *after* fixing the $O(N^2)$ road loop so a `4 × 4 km` build (`~10–18 s` remaining work) never triggers browser unresponsive-tab dialogs.

### Is Continuous Spatial Tiling Strictly Required First?

**No.** Continuous spatial tiling / chunk streaming is **not** required to solve the `4 × 4 km` loading freeze:
- Once loaded, `4 × 4 km` scenes render with only **`205–373` WebGL draw calls** (`TKT-023`) and sub-millisecond BVH hover raycasts (`TKT-024`), and retained V8 heap (`~843 MB`) + CPU/BVH buffers (`~222 MB`) sit well inside desktop browser limits (`4,192 MB` heap).
- Fixing the $O(N^2)$ legacy road bottleneck directly inside `GeometryBuilder.ts` removes `~81%` of `buildScene()` time in an isolated, bit-identical patch — whereas introducing world-space tiling/streaming would require redesigning `LocalGeoJsonProvider` origin projection, cross-tile planar clipping, cross-tile road/rail topology graphs, and incremental scene disposal.
- Spatial tiling should only be revisited if future product requirements expand loaded regions beyond `~4–5 km` or require `< 2 s` progressive first-frame interactivity on mobile / low-RAM (`< 2 GB`) devices.

---

## 6. Remaining Uncertainties & Environment Limitations

- **Headless Software GL (`SwiftShader`) vs. Hardware GPU**: Live `r = 2000` zoomed-out presentation (`cameraZoom = 0.28`, `5.47M` triangles across the full `4 × 4 km` viewport) took `10,064.7 ms` under CPU SwiftShader rasterization, whereas a discrete GPU (`RTX 4060 Ti` / laptop GPU) will present the same first frame substantially faster (`sceneGeometryMs` is CPU-bound and directly comparable).
- **OS Peak RSS (`VmHWM`)**: `/proc/<pid>/status` returned `VmHWM: 0` in this container environment; peak RSS numbers come from `250 ms` `VmRSS` polling, which can miss sub-250 ms native allocation spikes.
- **Container Single-Host Noise**: Both Express (`tsx server.ts`) and headless Chromium (`chrome-headless-shell` + SwiftShader threads) ran concurrently inside the same CPU container, which explains why live `r = 2000` `GeometryBuilder.buildScene()` (`97.3 s`) ran ~`2×` slower than CDP-injected `frozen_S5` (`47.6 s`) despite identical parsed road/intersection counts (`12,200` split roads, `1,988,335` intersection calls).
- **GPU Timer Query**: `gpuPassTimeMs` remained `null` on all sampled frames under headless SwiftShader (`mapLoadDiag` and `sceneStageTimingsMs` were unaffected).

---

## 7. Verification Status (Diagnostic Instrumentation)

- Status: Verified diagnostic instrumentation & end-to-end 4 km reproduction; ticket remains `in_progress` pending project-owner review.
- Focused unit/integration suites (`npx tsx --test src/world/MapLoadDiagnostics.test.ts src/world/GeometryBuilder.test.ts src/world/PlanarAndRoadSpatialIndex.test.ts src/world/BvhRaycasting.test.ts src/world/BuildingBatching.test.ts src/server/osm/OverijsselOfflineStore.test.ts`): **31 / 31 passed** (`0` failures; full `npm test` remains deferred under open `TKT-018`).
- TypeScript lint (`npm run lint`), production Vite build (`npm run build`), and API docs (`npm run docs:api`) executed cleanly after final edits.

## Related Files
- `src/world/GeometryBuilder.ts` (`SceneBuildStageTimingsMs`, legacy road loops lines `3373–3408`, `3904–3959`, building batching lines `844–1029`, `5845–5966`)
- `src/world/dev/MapLoadDiagnostics.ts` (`sceneStageTimingsMs` forwarding)
- `src/app/App.tsx` (`__M21_LAB__` diagnostic hooks, premature `setLoading(false)` at lines `658–659`, `waitForSceneReady` default `30000 ms` at line `1149`)
- `src/world/OsmApiProvider.ts` (`lastRawGeoJson`)
- `src/world/LocalGeoJsonProvider.ts` (`topologySource`, `chainContiguousRoads`)
- `src/server/osm/osmDataHandler.ts` (`osmCache`) & `src/server/osm/OverijsselOsmStore.ts` (`queryBBox`)
- `tickets/TKT-021-end-to-end-map-loading-performance-investigation.md`
