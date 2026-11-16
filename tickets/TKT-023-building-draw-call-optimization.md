---
id: TKT-023
title: Building Draw-Call Optimization via Per-Bucket Material-Group Consolidation
type: tech_debt
status: closed
priority: high
created: 2026-11-16
updated: 2026-11-16
---

# TKT-023: Building Draw-Call Optimization via Per-Bucket Material-Group Consolidation

## Summary
Eliminate the `O(buildings)` WebGL draw-call explosion caused by per-building interleaved `BufferGeometry.groups` inside merged `Buildings_${bucketKey}` meshes (`73,806` draw calls reported by the project owner on a ~2 km dense urban map; `51,058` draw calls measured on Hengelo S4 `2 × 2 km`), reducing building-related WebGL draw calls by **99.945%** (`50,886` $\to$ `28` draw calls across shadow + main passes on Hengelo S4) while preserving 100% of building geometry, roof/wall/archetype/landmark materials, bevels, open-air canopy pillars, shadow casting/receiving, theme updates, resource disposal, and per-building `faceRanges` raycast inspection.

## Context
During real-world testing of a dense ~2 km urban map on Windows (`Microsoft Edge`, `NVIDIA GeForce RTX 4060 Ti`), the project owner observed severe rendering degradation whenever the **Buildings** layer was enabled:

| Metric (Owner Windows RTX 4060 Ti Report) | Buildings Enabled | Buildings Disabled | Delta |
| :--- | ---: | ---: | ---: |
| **FPS** | `25` | `144` | `+119` FPS |
| **Frame Interval** | `39.3 ms` | `6.7 ms` | `-32.6 ms` (`-83.0%`) |
| **GPU Render Time** | `35.855 ms` | `2.463 ms` | `-33.392 ms` (`-93.1%`) |
| **WebGL Draw Calls (`gl.info.render.calls`)** | **`73,806`** | **`176`** | **`-73,630` (`-99.76%`)** |
| **Scene Triangles (Static HUD Metric)** | `1,230,698` | `1,230,698` | `0` |
| **Driver Geometries (`gl.info.memory.geometries`)** | `172` | `166` | `-6` |

Toggling off just `6` building bucket geometries eliminated `73,630` WebGL draw calls and reduced GPU frame time by `93.1%`.

## Confirmed Root Cause
1. In `src/world/GeometryBuilder.ts` (Stage 9), buildings are grouped into at most `7–8` visual material buckets (`default`, `landmark`, `arch_industrial`, `arch_commercial`, `arch_civic`, `arch_religious`, `arch_transit`, `arch_historic`), where each bucket creates a single `THREE.Mesh(mergedBldgGeo, [roofMat, wallMat])` with `castShadow = true` and `receiveShadow = true`.
2. Each individual building's `THREE.ExtrudeGeometry` emits 2 material groups (`materialIndex: 0` for roof/bottom caps, `materialIndex: 1` for walls and bevels), and `generateOpenAirRoofWithPillars()` emits 3 material groups (`0` for roof cap, `1` for fascia, `1` for cylindrical support pillars).
3. Previously, Stage 9 merged each bucket using `mergeWithFaceRanges(items, resourceManager)`. `mergeWithFaceRanges()` calls `mergeGeometries(geos, false)` and appends **every individual building's `geom.groups` in original building order**:
   ```text
   [B0.roof(0), B0.wall(1), B1.roof(0), B1.wall(1), ..., BN.roof(0), BN.wall(1)]
   ```
4. When a `THREE.Mesh` uses an array of materials (`[roofMat, wallMat]`) and has `geometry.groups`, Three.js `WebGLRenderer` iterates through `geometry.groups` and issues **one separate `gl.drawArrays` call per group** in **both** the directional shadow-map pass (`castShadow = true`) and the main camera pass:
   $$\text{Building WebGL Draw Calls} = 2 \times \sum_{b} \text{groups}(b) \approx 4 \times N_{\text{buildings}}$$
5. On the frozen `hengelo-s4-2km.geojson.gz` dataset (`2 × 2 km`, `12,708` parsed buildings across `7` bucket meshes):
   - Total `geometry.groups` across the `7` building meshes was **`25,443`** (`Buildings_default`: `23,850` groups for `11,925` buildings; `Buildings_arch_industrial`: `1,069` groups for `528` buildings; `Buildings_arch_commercial`: `434`; `Buildings_landmark`: `52`; `Buildings_arch_civic`: `24`; `Buildings_arch_religious`: `10`; `Buildings_arch_transit`: `4`).
   - Across the shadow pass + main pass, those `7` meshes caused **`50,886` WebGL draw calls per frame** (`51,058` total scene draw calls with buildings ON vs. `172` with buildings OFF).
   - Meanwhile, `scene.stats.totalDrawCalls` (`drawCalls++`) only incremented once per `THREE.Mesh` (`272`), masking the per-group submission explosion until `gl.info.render.calls` was inspected.

## Expected Behavior
- Consolidate building triangles within each `buildingsByBucket` mesh contiguously by `materialIndex` so each bucket mesh contains at most **one `BufferGeometry` group per active material slot** (`<= 2` groups per bucket mesh: group `0` = all roof/cap triangles, group `1` = all wall/bevel/pillar triangles).
- Reduce building WebGL draw calls by **$\ge 95\%$** (achieving **99.945%** on Hengelo S4: `50,886` $\to$ `28` draw calls) while keeping `1` mesh per bucket (`Buildings_${bucketKey}`), preserving `[roofMat, wallMat]`, `castShadow`, `receiveShadow`, `updateTheme()`, wireframe toggling, `SceneResourceManager` disposal, and full per-building `faceRanges` binary-search inspection.
- Leave `mergeWithFaceRanges()` completely unchanged for all non-building layers.

## Acceptance Criteria
- [x] Root cause confirmed via direct material-group and WebGL draw-call measurement before code changes.
- [x] Building-related WebGL draw calls reduced by at least `95%` (`50,886` $\to$ `28`, **`-99.945%`** on Hengelo S4 `2 × 2 km`).
- [x] Every building feature, roof, wall, bevel, courtyard hole, and open-air canopy + pillar structure renders with identical vertex/triangle counts and materials (`default`, `landmark`, and all archetype palettes).
- [x] Individual building hover and click inspection (`resolveInspectedFeature` via `faceIndex` binary search over `faceRanges`) resolves the exact OSM feature (`id`, `sourceFeatureId`, `name`, `height`, `levels`, `osmTags`) across both roof (`materialIndex: 0`) and wall/pillar (`materialIndex: 1`) triangles.
- [x] `mergeWithFaceRanges()` remains untouched for non-building layers (`roads`, `railways`, `water`, `parks`, `landuse`, `barriers`, `landmarks`).
- [x] Zero resource leaks (`ownedGeometriesCount === 0`, `ownedMaterialsCount === 0` after `dispose()`).
- [x] Focused automated tests, `npm run lint`, `npm run build`, and `npm run docs:api` pass.

## Implementation Notes
- Added `mergeBuildingItemsByMaterial(items, resourceManager)` in `src/world/GeometryBuilder.ts` and wired Stage 9 (`buildingsByBucket.forEach`) to call it instead of `mergeWithFaceRanges()`.
- `mergeBuildingItemsByMaterial()`:
  1. Normalizes any indexed input geometry via `.toNonIndexed()` (disposing temporary conversions and releasing registered intermediate geometries via `SceneResourceManager.releaseIntermediateGeometry()`).
  2. Partition-slices each building's triangle ranges by `materialIndex` (defaulting ungrouped geometries to `materialIndex: 0`).
  3. Allocates contiguous TypedArrays for all common vertex attributes (`position`, `normal`, `uv`) and copies all `materialIndex = 0` slices followed by all `materialIndex = 1` slices.
  4. Emits one consolidated `merged.addGroup(groupStart, groupCount, matIdx)` per present `materialIndex` (`<= 2` groups per bucket mesh).
  5. Reconstructs monotonically ordered, gap-free `faceRanges: FaceFeatureRange[]` across the consolidated buffer so `resolveInspectedFeature()` binary search maps every triangle index in both material sections back to its exact `InspectableFeatureInfo`.
- Keeping a single `THREE.Mesh` per bucket with `[roofMat, wallMat]` also preserves `FeatureCoverage.test.ts` expectations (`scene.buildingsGroup.children[0]` containing both ground-level `Y <= 0.05` pillar vertices and elevated `Y >= 5.0` canopy vertices), wireframe traversal in `MapScene.tsx`, and single-feature `userData` fallback when `items.length === 1`.

## Benchmark Comparison (`hengelo-s4-2km.geojson.gz`, `2 × 2 km`, `12,708` Buildings)

Measured on the frozen `benchmarks/datasets/hengelo-scaling/hengelo-s4-2km.geojson.gz` dataset (`centerLonLat: [6.7935, 52.2625]`, `clipRadiusMeters: 1000`, `bevelEnabled: true`, `zoom: 1.0`, `1440×900` viewport, Playwright headless Chromium with SwiftShader software WebGL rasterizer in container; note: hardware GPU timer queries `EXT_disjoint_timer_query_webgl2` are unsupported on SwiftShader):

| Metric (`hengelo-s4-2km`, `12,708` Buildings) | Before (Buildings ON) | Before (Buildings OFF) | After (Buildings ON) | After (Buildings OFF) | Building Reduction (Before $\to$ After) |
| :--- | ---: | ---: | ---: | ---: | ---: |
| **Building Bucket Meshes (`buildingsGroup.children`)** | `7` | `0` (hidden) | `7` | `0` (hidden) | Unchanged (`7` meshes) |
| **Total Building `BufferGeometry.groups`** | **`25,443`** | `0` (hidden) | **`14`** (`2` per bucket) | `0` (hidden) | **`-25,429` (`-99.945%`)** |
| **Building WebGL Draw Calls (`gl.info.render.calls` delta)** | **`50,886`** | `0` | **`28`** (`14` shadow + `14` main) | `0` | **`-50,858` (`-99.945%`)** |
| **Total Scene WebGL Draw Calls (`gl.info.render.calls`)** | **`51,058`** | `172` | **`200`** | `172` | **`-50,858` (`-99.61%`)** |
| **CPU Frame Render Time Median (`cpuRenderTimeMs`)** | **`81.4 ms`** | `1.8 ms` | **`2.6 ms`** | `2.0 ms` | **`-78.8 ms` (`-96.8%` / `31.3×` faster)** |
| **Frame Interval Median (`frameIntervalMs`)** | **`89.3 ms` (`11.2 FPS`)** | `17.0 ms` (`58.8 FPS`) | **`17.1 ms` (`58.5 FPS`)** | `17.0 ms` (`58.8 FPS`) | **`-72.2 ms` (`-80.9%` / `5.2×` higher FPS)** |
| **Rendered WebGL Triangles (`gl.info.render.triangles`)** | `2,798,962` | `1,382,082` | `2,798,962` | `1,382,082` | **100% identical** |
| **Building Vertices / Triangles** | `2,125,320` / `708,440` | `2,125,320` / `708,440` | `2,125,320` / `708,440` | `2,125,320` / `708,440` | **100% identical** |
| **Total Scene Vertices / Triangles** | `4,125,985` / `983,282` | `4,125,985` / `983,282` | `4,125,985` / `983,282` | `4,125,985` / `983,282` | **100% identical** |
| **Driver Geometries / Programs** | `164` / `8` | `157` / `8` | `164` / `8` | `164` / `8` | **100% identical** |
| **Disposal Leaks (`ownedGeometries` / `ownedMaterials`)** | `0` / `0` | `0` / `0` | `0` / `0` | `0` / `0` | **`0` leaks** |

### Per-Bucket Group Breakdown (`hengelo-s4-2km.geojson.gz`)

| Bucket Mesh | Buildings | Triangles | Groups Before | Groups After | `faceRanges` Entries |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `Buildings_default` | `11,925` | `649,244` | `23,850` | `2` | `23,850` |
| `Buildings_arch_industrial` | `528` | `25,552` | `1,069` | `2` | `1,056` |
| `Buildings_arch_commercial` | `217` | `23,892` | `434` | `2` | `434` |
| `Buildings_landmark` | `19` | `2,348` | `52` | `2` | `38` |
| `Buildings_arch_civic` | `12` | `4,264` | `24` | `2` | `24` |
| `Buildings_arch_religious` | `5` | `2,764` | `10` | `2` | `10` |
| `Buildings_arch_transit` | `2` | `376` | `4` | `2` | `4` |
| **Total** | **`12,708`** | **`708,440`** | **`25,443`** | **`14`** | **`25,416`** (`0` gaps) |

## Verification
- Status: Verified (`2026-11-16`)
- Verification steps:
  - `npx tsx --test src/world/BuildingBatching.test.ts src/world/GeometryBuilder.test.ts src/world/FeatureCoverage.test.ts src/world/ElevationAndZIndex.test.ts src/world/BenchmarkInfrastructure.test.ts src/world/BenchmarkReliability.test.ts src/world/MapLoadDiagnostics.test.ts` — exit code `0` (`69/69` tests passed across `16` suites)
  - `npx tsx --test src/world/SubterraneanVisualIntegration.test.ts` — exit code `0` (`15/15` tests passed)
  - `npx tsx --test --test-concurrency=1 src/world/JunctionAndTopology.test.ts src/world/PerformanceBaseline.test.ts` — exit code `0` (`37/37` tests passed)
  - `npm run bench:cpu -- --quick --no-save` — exit code `0` (`4/4` workloads completed, `0` disposal leaks)
  - `npx tsx benchmarks/browserRunner.ts --datasets small-real-europatunnel --configs production-legacy --scenarios repeated_scene_reload --swiftshader --no-save` — exit code `0` (`43` draw calls, `0` WebGL resource leaks)
  - `npm run lint` (`tsc --noEmit`) — exit code `0` (`0` errors)
  - `npm run build` (`vite build`) — exit code `0` (`dist/` built cleanly)
  - `npm run docs:api` (`typedoc`) — exit code `0`

## Related files and documentation
- Source: `src/world/GeometryBuilder.ts` (`mergeBuildingItemsByMaterial`, Stage 9 `buildingsByBucket`)
- Tests: `src/world/BuildingBatching.test.ts`, `src/world/FeatureCoverage.test.ts`, `src/world/GeometryBuilder.test.ts`
- Documentation: `docs/geometry-and-rendering.md`, `docs/STATUS.md`
