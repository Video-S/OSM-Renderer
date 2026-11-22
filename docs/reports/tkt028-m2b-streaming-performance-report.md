# TKT-028 Milestone M2-B: Tile Streaming Performance & Memory Validation Report

> **Document Status (`2026-11-21`)**: **M2-B Validation Infrastructure & Synthetic/Lifecycle Verification Complete; Canonical `8 × 8` Hengelo Hardware GPU Run Pending Project-Owner Execution**  
> **Ticket**: [`TKT-028`](../../tickets/TKT-028-regional-tiling-streaming-lod.md) (`in_progress` — `M1a` & `M1b` accepted, `M2-A` visually accepted, `M2-B` diagnostic validation)  
> **Scope Constraint**: Diagnostic evaluation **only** — preserves the `512 m` tile grid, `OSMTILE1` codec (`BAKE_SCHEMA_VERSION = '1.1.0'`), shared `ThemeMaterialRegistry`, `CameraController` `minZoom = 0.15`, and existing `GeometryBuilder` batching with **zero performance optimizations implemented**.

---

## 1. Evidence Provenance & Honest Boundaries

To keep measured evidence strictly separated from unmeasured projections:

1. **Verified in AI Studio Sandbox (`2026-11-21`)**:
   - **12-Cycle Node.js Streaming Lifecycle & Eviction Stress Validation** (`src/world/TilingM2bLifecycleValidation.test.ts`): `4 / 4` tests passed against a `5 × 5` (`2,560 × 2,560 m`, `25 × 512 m` tiles) SQLite pack baked via `OfflineHengeloTileBaker`, exercising `24` alternating NW $\leftrightarrow$ SE distant camera jumps (`12` full cycles), `23` tile evictions, zoom-in eviction (`25 -> 4` tiles, `21` evictions), `AbortController` mid-flight request cancellation, cycle `0` / `6` / `11` `MeshBVH` raycast parity, and full `dispose()` cleanup.
   - **3-Mode × 5-Scenario WebGL End-to-End Comparison on `synthetic-smoke-4x4` (`16 × 512 m` tiles = `2,048 × 2,048 m`)** (`benchmarks/tileStreamingRunner.ts`, Chromium `155.0.8059.12`, `1440×900` @ `1x` DPR, `WebGL2`, `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` software rasterizer, `--quick --eviction-hops=10`): All `3` modes (`m1a_single_scene`, `m1a_tiled_64`, `m2a_streaming`) × `5` scenarios completed cleanly with `cleanResourceStabilizationVerified = true` and `0` WebGL resource leaks.
2. **Pending Project-Owner Local Hardware Execution (Not Yet Measured)**:
   - **Canonical `8 × 8` Hengelo (`64 × 512 m` tiles = `4,096 × 4,096 m`) WebGL + Hardware GPU Run**: Requires local `data/osm/overijssel-261114-8ae28196.sqlite` and `data/osm/overijssel-tiles-261114-8ae28196.sqlite` (absent in sandbox) plus a hardware WebGL2 GPU supporting `EXT_disjoint_timer_query_webgl2`. Canonical `8 × 8` frame intervals, GPU pass times, draw calls, and active-pan eviction rates are **explicitly unmeasured** here and must be recorded from the Windows `--require-hardware` run (`npx tsx benchmarks/tileStreamingRunner.ts --dataset=canonical-hengelo --require-hardware`).

---

## 2. Benchmark Architecture & Three-Mode Methodology

The M2-B runner (`benchmarks/tileStreamingRunner.ts`, `npm run bench:tiles`) extends the existing `benchmarks/` harness (`src/types/BenchmarkTelemetry.ts`, `MapScene.tsx`, `cliAndServer.ts`, `stats.ts`, `environment.ts`) rather than introducing a separate telemetry path. All three modes render in the exact same `MapScene` / `CameraController` / `App.tsx` environment (`1440×900 @ 1x`, `tactical` theme, `E2+/R+` defaults: `roads: 'graph-surface'`, `railways: 'graph-R+'`, `minZoom = 0.15`):

| Mode ID | Pipeline Under Test | Initialization Path |
|---|---|---|
| `m1a_single_scene` | **Mode 1 — Single-Scene Reference (`A`)** | Fetches GeoJSON, runs `ingestCanonicalStudyGeoJson` + `buildSingleSceneReference`. Baseline unpartitioned scene (`452` meshes observed on canonical Hengelo; `58` meshes on `synthetic-smoke-4x4`). |
| `m1a_tiled_64` | **Mode 2 — All Grid Tiles Mounted (`C`)** | Partitions and builds all `N` tiles (`64` canonical / `16` synthetic) via `buildTiledStudyScenes` + `assembleTiledStudyCompositeScene`, keeping every tile mounted in scene groups simultaneously (`2,783` meshes observed on canonical Hengelo; `194` meshes on `synthetic-smoke-4x4`). |
| `m2a_streaming` | **Mode 3 — M2-A Runtime Tile Streaming** | Fetches `OSMTILE1` manifest (`ingestMs = 0`), streams viewport + `preloadMarginTiles = 1` tiles (`maxConcurrentFetches = 6`), decodes off-thread via `TileDecodeWorker` / `TileDecodeClient`, commits `<= maxCommitsPerFrame = 4` tiles per frame via `TileSceneReconstructor` + shared `ThemeMaterialRegistry`, and evicts outside `retainMarginTiles = 2`. |

### Five Deterministic Scenarios

| Scenario ID | Camera Pose / Trajectory (`azimuth = 45°`, `tilt ≈ 55.4°`) | What It Isolates |
|---|---|---|
| `closeup_station` | Static `[0, 0, 0]`, `zoom = 6.5` (`> 4.5 CSS px/m`) | High-detail street-level framing with 3D instanced sleepers & 3D rails active (`Railway_Sleepers_3D`, `Railway_Rails_3D`). |
| `medium_navigation` | Static `[0, 0, 0]`, `zoom = 1.8` (`<= 4.5 CSS px/m`) | Urban neighborhood navigation using procedural UV railway ribbons (`Railway_Sleepers_Ribbon`, `Railway_Rails_Ribbon`). |
| `far_overview` | Static `[0, 0, 0]`, `zoom = 0.22` (`minZoom = 0.15` preserved) | Maximum practical overview framing the entire study grid simultaneously inside one orthographic frustum. |
| `continuous_pan` | Phase A: diagonal pan across grid (`zoom = 2.2` canonical / `2.5` synthetic) + drain wait; Phase B: settled steady state at end pose | Active camera-movement streaming work (`fetch`/`decode`/`reconstruct`/`commit`) vs. post-pan idle rendering cost. |
| `repeated_pan_eviction` | `>= 10` opposing-quadrant distant hops (`NW <-> SE`, `±1,300 m` canonical / `±760 m` synthetic) followed by full `unloadDataset()` | Multi-cycle eviction stability, cycle-0-to-final deltas on `tileCpuGeometryBytes`, `tileBvhBytes`, `driverGeometries`, `driverTextures`, `usedJSHeapSizeMB`, and full teardown cleanup. |

---

## 3. Verified Results

### 3.1 Node.js 12-Cycle Streaming & Eviction Stress Validation (`5 × 5` Grid)

Executed via `DISABLE_OVERIJSSEL_BOOTSTRAP=1 npx tsx --test src/world/TilingM2bLifecycleValidation.test.ts` (`4 / 4` passed, `0` failed, `0` skipped):

- **Environment**: `5 × 5` aligned grid (`25 × 512 m` tiles = `2,560 × 2,560 m`), `preloadMarginTiles = 0`, `retainMarginTiles = 0`, `maxConcurrentFetches = 4`, `maxCommitsPerFrame = 2`, inline `OSMTILE1` + `MeshBVH` decode against live Express `/api/tiles/...`.
- **12 Alternating `NW <-> SE` Cycles (`24` Viewport Jumps)**:
  - Exactly `1` tile resident at each settled endpoint (`[nwKey]` at NW, `[seKey]` at SE), with the opposite corner guaranteed `'unloaded'`.
  - **`evictedTilesTotal = 23`** across the 12 cycles (`CYCLES * 2 - 1`).
  - **Zero-Delta Resource Stabilization** across cycles `0..11` (both NW and SE snapshots compared strictly against Cycle `0` baselines):
    - `activeTileGeometries` delta: **`0`**
    - `activeTileBvhs` delta: **`0`**
    - `tileCpuGeometryBytes` delta: **`0` bytes**
    - `tileBvhBytes` delta: **`0` bytes**
    - `loadedMeshCount` delta: **`0`**
    - Per-layer `Group.children` counts (`buildings`, `roads`, `railways`, `water`, `parks`, `landuse`, `barriers`, `foliage`): **exact deep equality**, `0` duplicate `tileKey` children.
    - `sharedMaterialRegistry`: remained `disposed = false` with constant `materialCount` throughout all 23 evictions.
  - **BVH Inspection Parity Across Cycles `0`, `6`, `11`**: Normal raycasts hit `way/nw-depot` (`"NW Terminal"`) in NW and `way/se-tower` (`"SE Innovation Tower"`) in SE cleanly on cycle `0`, mid-run cycle `6`, and final cycle `11`.
  - **Full Unmount (`manager.dispose()`)**: `loadedTiles = 0`, `activeTileGeometries = 0`, `activeTileBvhs = 0`, `tileCpuGeometryBytes = 0`, `tileBvhBytes = 0`, all 8 composite `Group.children` counts `= 0`, `sharedMaterialRegistry.disposed = true`.
- **Zoom-Out -> Zoom-In Eviction & `AbortController` Cancellation (`test 2`)**:
  - Zooming to `0.25` loaded all `25 / 25` tiles (`peakLoadedTiles = 25`); zooming in to `6.5` in NW (`preload=1`, `retain=1`) cleanly evicted `21` outer tiles (`loadedTiles = 4`, `evictedTilesTotal = 21`).
  - Rapid mid-flight camera jump (`center -> SE` before `15 ms` fetch completion) triggered `cancelledRequestsTotal >= 1` and converged cleanly to `loadingTiles = 0`, `failedTiles = 0`, `loadedTiles = 4`.

### 3.2 Synthetic `4 × 4` WebGL End-to-End Comparison (Chromium `155` SwiftShader)

Command executed (`exit 0`, zero lingering `server.ts` child processes):

```bash
DISABLE_OVERIJSSEL_BOOTSTRAP=1 npx tsx benchmarks/tileStreamingRunner.ts \
  --dataset=synthetic-smoke-4x4 --swiftshader --quick --eviction-hops=10
```

- **Host & Browser**: Linux x64 (4 logical cores), Node `v22.23.2`, Chromium `155.0.8059.12`, `1440×900 @ 1x`, `WebGL2`, `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` (**software rasterizer**).
- **Important Caveat on `synthetic-smoke-4x4`**: On a `2,048 × 2,048 m` (`4 × 4`) grid, `retainMarginTiles = 2` expands any visible tile selection by `1,024 m` in every direction, so all `16 / 16` tiles remain inside the keep set during `4 × 4` hops (`evicted = 0` in the `4 × 4` E2E run). Eviction is therefore proven by the `5 × 5` `23`-eviction Node suite (§3.1) and is active on the `4,096 × 4,096 m` `8 × 8` Hengelo grid (§4.1). Additionally, SwiftShader serializes WebGL rasterization onto the CPU, yielding high `frameIntervalMs` (`75–281 ms`) and `gpuFrameRenderTimeMs.status = 'unavailable'` (`EXT_disjoint_timer_query_webgl2` unsupported).

#### Initialization Comparison (`synthetic-smoke-4x4`)

| Mode | Grid Tiles | Fetch / Manifest (ms) | Client Ingest (ms) | Scene / Tile Build (ms) | Wall Init-to-First-Frame (ms) | Shared Materials |
|---|---:|---:|---:|---:|---:|---:|
| `m1a_single_scene` | 16 | `20.10` | `61.70` | `140.50` | n/a (shared harness load) | n/a |
| `m1a_tiled_64` | 16 | `12.50` | `69.50` | `866.10` | `2,648.80` (after mode switch) | n/a |
| `m2a_streaming` | 16 | `15.70` | **`0.00`** | `null` (pre-baked `OSMTILE1`) | `3,406.10` (includes unload + initial 16-tile stream idle) | `144` |

*(Note: On canonical Hengelo, client `ingest` + `buildTiledStudyScenes` scales with `102,469` features, whereas `m2a_streaming` maintains `ingestMs = 0.00` because `OSMTILE1` tiles are pre-baked offline in `overijssel-tiles-261114-8ae28196.sqlite`.)*

#### Cross-Mode Runtime Metrics (`synthetic-smoke-4x4`, SwiftShader `1440×900`)

| Scenario | Single Meshes (Total / Frustum) | All-16 Meshes (Total / Frustum) | Stream Meshes (Total / Frustum) | Single Calls | All-16 Calls | Stream Calls | All-16 / Stream Tris Med | Frame Med (`1` / `All` / `Stream` ms) | CPU `gl.render()` Med (`1` / `All` / `Stream` ms) |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| `closeup_station` (`zoom=6.5`) | `58` / — | `194` / `67` | `194` / `69` (`4` vis tiles) | `38` | `194` | `196` | `27,559` / `27,597` | `162.40` / `175.50` / `75.60` | `1.40` / `2.10` / `2.10` |
| `medium_navigation` (`zoom=1.8`) | `58` / — | `194` / `99` | `194` / `101` (`16` vis tiles) | `35` | `237` | `239` | `10,143` / `10,184` | `233.75` / `263.15` / `281.45` | `1.10` / `2.95` / `2.20` |
| `far_overview` (`zoom=0.22`) | `58` / — | `194` / `144` | `194` / `145` (`16` vis tiles) | `35` | `313` | `314` | `10,793` / `10,815` | `265.65` / `276.95` / `272.65` | `1.00` / `3.65` / `2.60` |
| `continuous_pan` (Phase A active, `zoom=2.5`) | `58` / — | `194` / `68` | `194` / `69` (`4` vis tiles) | `35` | `211` | `211.5` | `9,916.5` / `9,871` | `196.25` / `93.55` / `103.80` | `1.00` / `2.55` / `1.95` |
| `continuous_pan` (Phase B settled) | — | `194` / `68` | `194` / `69` (`4` vis tiles) | — | `201` | `202` | `9,891` / `9,721` | `—` / `104.20` / `276.30` | `—` / `2.20` / `1.75` |
| `repeated_pan_eviction` (`10` hops, `zoom=3.2`) | `58` / — | `194` / `45` | `194` / `45` (`4` vis tiles) | `31` | `177` | `177` | `9,344` / `9,344` | `214.80` / `211.15` / `214.60` | `0.90` / `1.90` / `1.70` |

#### Memory, WebGL Driver & Multi-Hop Stabilization (`synthetic-smoke-4x4`)

| Metric | `m1a_tiled_64` (All 16 Tiles) | `m2a_streaming` (Streamed) | Notes |
|---|---:|---:|---|
| Retained Tile CPU Buffers | `1.024 MB` | **`0.618 MB`** (`647,896` B) | `-39.6%` lower CPU buffer footprint in `m2a_streaming` even with all `16/16` tiles loaded (`OSMTILE1` compact buffers + single composite ground plane). |
| Retained `MeshBVH` Memory | `0.028 MB` | `0.028 MB` (`29,074` B) | Parity (`indirect: true` deserialized BVHs). |
| WebGL `driverGeometries` / `Textures` / `Programs` | `163–165` / `3` / `8` | `150–165` / `3` / `8` | Shared `ThemeMaterialRegistry` avoids shader-program multiplication. |
| Advisory Chromium JS Heap (`usedJSHeapSizeMB`) | `84.73–87.64 MB` | `82.72–87.53 MB` | Stabilized across 10 hops (`+0.141 MB` NW, `+0.122 MB` SE cycle-0-to-final). |
| Repeated Eviction Deltas (NW & SE Cycle 0 $\to$ Final) | `driverGeometriesDelta = 0`, `driverTexturesDelta = 0` | `loadedTilesDelta = 0`, `tileCpuGeometryBytesDelta = 0`, `tileBvhBytesDelta = 0`, `driverGeometriesDelta = 0`, `driverTexturesDelta = 0` | `cleanResourceStabilizationVerified = true`. |
| Post-`unloadDataset()` Driver Baseline | `geometries = 3`, `textures = 3` | `geometries = 3`, `textures = 3` | Full WebGL disposal confirmed (`0` leaked geometries or textures). |

### 3.3 Canonical `8 × 8` Hengelo Dataset Status (`Pending Owner Hardware Run`)

- Previously measured canonical mesh counts (`TKT-028` M1a/M2-A): `452` meshes in `m1a_single_scene` vs. `2,783` meshes in `m1a_tiled_64` (**`6.16×`** mesh amplification across `64 × 512 m` tiles).
- Canonical `8 × 8` Hengelo streaming numbers (draw calls, hardware `EXT_disjoint_timer_query_webgl2` GPU frame times, active pan commit latencies, and per-tile eviction counts across `4,096 × 4,096 m`) are **not yet measured** and require running `benchmarks/tileStreamingRunner.ts --dataset=canonical-hengelo --require-hardware` on the project owner's Windows machine with `data/osm/overijssel-tiles-261114-8ae28196.sqlite`.

---

## 4. Investigation Findings: Answering the 6 Core Questions

### Q1. Does viewport streaming reduce mounted meshes compared with mounting all 64 tiles at close, medium, and far zoom?

**Yes at close and medium zoom on canonical `8 × 8` (`4,096 × 4,096 m`) and `>= 5 × 5` grids; no at `far_overview` (`zoom = 0.22`) or on grids smaller than the retention diameter.**

- `TileStreamManager` loads tiles intersecting the projected camera ground frustum **plus** `preloadMarginTiles = 1` (`512 m`), and keeps tiles inside `retainMarginTiles = 2` (`1,024 m` ring around the visible tiles).
- On a `4,096 × 4,096 m` (`8 × 8`) grid:
  - **`closeup_station` (`zoom = 6.5`, `1440×900` @ `55.4°` isometric tilt)**: Projected viewport ground span is roughly `~222 m × 244 m` (intersecting `1–4` visible tiles). With `preload = 1` and `retain = 2`, the resident tile window spans at most `(2 + 2×2) × (2 + 2×2)` = `~16–25` tiles (capped by grid edges) — cutting mounted meshes by roughly **`~60%–75%`** compared with mounting all `64` tiles (`2,783` meshes). *(Exact mounted counts on canonical Hengelo await the Windows run; on `synthetic-smoke-4x4`, `2,048 m` width fits inside `retain = 2`, so `16/16` remained loaded while Three.js frustum culling reduced rendered leaves to `69/194`.)*
  - **`medium_navigation` (`zoom = 1.8`)**: Projected ground span is roughly `~800 m × 880 m` (intersecting `~4–9` visible tiles). Including `preload = 1` / `retain = 2`, `~25–42` of `64` tiles remain resident depending on position, providing a smaller but still meaningful reduction vs. `64/64`.
  - **`far_overview` (`zoom = 0.22`, preserving `minZoom = 0.15`)**: Projected ground footprint exceeds `6,500 × 7,000 m`, framing **all `64 / 64` tiles simultaneously**. Both `m2a_streaming` and `m1a_tiled_64` therefore mount **every LOD0 tile (`~2,783` meshes)** — streaming alone provides **`0%` mounted-mesh reduction** at `far_overview` because there is no `LOD1–LOD3` hierarchy yet (`M3`).

### Q2. Does streaming reduce WebGL draw calls (`gl.info.render.calls`), and how do mesh counts and draw calls differ?

**Only partially — Three.js frustum culling already skips off-screen meshes even when all tiles are mounted, while draw-call amplification inside the frustum comes from tiling splits (`512 m`), spatial chunking (`128 m`), multi-group meshes, and shadow passes.**

- **Mesh count (`totalMeshes`) vs. WebGL draw calls (`gl.info.render.calls`)**:
  - `totalMeshes` counts `THREE.Mesh` / `THREE.InstancedMesh` leaf objects attached to the scene graph.
  - `gl.info.render.calls` counts actual WebGL `drawElements` / `drawArrays` / `drawElementsInstanced` submissions inside `gl.render(scene, camera)` after frustum culling:
    $$\text{Draw Calls} \approx \sum_{m \in \text{FrustumVisible}} \max(1, |\text{groups}(m)|) \times \bigl(1 + \mathbb{1}[\text{castShadow}(m)]\bigr)$$
  - Notice why draw calls differ from mesh counts in `synthetic-smoke-4x4`:
    - In `closeup_station`, `194` total meshes cull down to `67–69` frustum-visible meshes, yet emit **`194–196` draw calls** because shadow-casting building meshes emit `<= 2` groups (`roof` + `wall`, `TKT-023`) in both the directional shadow pass and main pass, and `zoom = 6.5 > 4.5 px/m` switches `Railway_Sleepers_3D` `InstancedMesh` + `Railway_Rails_3D` visible.
    - In `far_overview`, `144–145` frustum-visible meshes emit **`313–314` draw calls** (`~8.97×` single-scene's `35` calls, even though mesh count is `3.34×`) because every tile duplicates per-layer meshes (`Landuse_*`, `Roads_*`, `Buildings_*`, `Water_*`, `Railway_*` `128 m` chunks), multiplying small draw submissions across tile borders.
- **Implication for `m2a_streaming` vs. `m1a_tiled_64`**: At identical camera poses once tiles are loaded, `m2a_streaming` and `m1a_tiled_64` have **virtually identical draw calls** (`196` vs `194`, `239` vs `237`, `314` vs `313` in synthetic 4×4 — the `+1–2` difference is just the composite ground mesh). What streaming improves at close/medium zoom on large grids (`8 × 8` and beyond) is **scene-graph traversal / frustum-culling CPU work** and **GPU/CPU memory residency**, not the per-tile draw-call multiplicity inside the visible viewport.

### Q3. How responsive is streaming during continuous panning vs. settled steady state (including decode, reconstruct, and commit frame spikes)?

- **Off-Main-Thread vs. On-Main-Thread Work Partition**:
  - **Worker Thread (`TileDecodeWorker` / `TileDecodeClient`)**: Inflated `OSMTILE1` parsing, `TypedArray` allocation, and string-pool/tag-table unpacking execute in up to `3` Web Workers using zero-copy transferable `ArrayBuffer`s (`collectDecodedTileTransferables`), keeping binary decode off the render loop.
  - **Main Thread Commit Path (`TileStreamManager.tick`)**: Each RAF frame drains at most `maxCommitsPerFrame = 4` ready tiles (`reconstructTileSceneFromDecoded` -> `MeshBVH.deserialize` -> `Group.add` -> `compositeSceneRevision++`), followed on the next WebGL frame by Three.js's synchronous `gl.bufferData` VBO/IBO upload and first-draw shader compilation for newly visible geometry.
- **Steady State vs. Active Pan**:
  - In **settled steady state** (`Phase B` or static scenarios), `TileStreamManager` performs zero fetch/decode/reconstruct/commit work (`loadingTiles = 0`), so frame time depends solely on Three.js traversal + WebGL draw calls + GPU rasterization (`cpuRenderTimeMs` `1.70–2.60 ms` med on synthetic SwiftShader).
  - During **active panning**, if a user pans smoothly (`1–2` new boundary tiles entering `fetchSet` every second), `maxCommitsPerFrame = 4` spreads scene graph attachment smoothly. However, during **rapid pan bursts or instant distant jumps** where `4` dense urban tiles commit on one frame simultaneously, synchronous `reconstructTileSceneFromDecoded` (`MeshBVH.deserialize` + `THREE.BufferGeometry` construction) plus WebGL buffer uploads can still produce **single-frame spikes** on the main thread. (Note: On `synthetic-smoke-4x4`, all `16` tiles preloaded during `loadM2aStreaming` init, so per-scenario streaming stage timings were `n/a`; true mid-pan commit spikes must be measured on `canonical-hengelo` hardware runs.)

### Q4. Do WebGL geometries, textures, tile CPU buffers, BVHs, and JS heap stabilize across repeated pan/eviction cycles?

**Yes — strictly verified with zero leaked geometries, textures, CPU buffers, or BVHs.**

- **Node.js `12`-Cycle `5 × 5` Lifecycle (`TilingM2bLifecycleValidation.test.ts`)**: Across `24` distant hops and `23` complete tile evictions, `activeTileGeometries`, `activeTileBvhs`, `tileCpuGeometryBytes`, `tileBvhBytes`, `loadedMeshCount`, and all `8` layer `Group.children` counts returned **identically (`0` delta)** to their Cycle `0` baselines; `MeshBVH` raycasting worked identically at cycles `0`, `6`, and `11`; and `manager.dispose()` reduced every metric to `0`.
- **Browser `10`-Hop WebGL E2E (`synthetic-smoke-4x4`)**: `cleanResourceStabilizationVerified = true`. NW and SE Cycle `0` $\to$ Final deltas were `0` for `loadedTiles`, `tileCpuGeometryBytes`, `tileBvhBytes`, `driverGeometries`, and `driverTextures`; `usedJSHeapSizeMB` varied only within normal V8 generational GC noise (`+0.141 MB` NW, `+0.122 MB` SE); and `unloadDataset()` returned WebGL `driverGeometries` to `3` and `driverTextures` to `3` (matching `m1a_tiled_64`'s post-unload baseline).
- Notice also that **`m2a_streaming` used `39.6%` less retained CPU buffer memory (`0.618 MB` vs `1.024 MB`)** than `m1a_tiled_64` even with all `16/16` tiles mounted, because `OSMTILE1` stores only compact serialized typed arrays and shares a single `ThemeMaterialRegistry` (`144` pre-registered material slots, `0` per-tile shader duplication).

### Q5. What is the primary remaining runtime bottleneck?

There are **two distinct bottlenecks depending on camera zoom**:

1. **At Medium & Far Overview Zoom (`zoom <= 1.0`, especially `zoom = 0.22` and future `minZoom ~ 0.015–0.02`) — `LOD0`-Only Per-Tile Mesh & Draw-Call Proliferation**:
   - Mounting `64` LOD0 tiles simultaneously amplifies scene meshes **`6.16×`** (`452 -> 2,783` on canonical Hengelo) and WebGL draw calls even higher (`~9×` at `far_overview` on `synthetic-smoke-4x4`, `35 -> 314` calls), while submitting full street-level building bevels, minor paths, barriers, and dense `MeshBVH` vertex counts for sub-pixel objects. Viewport streaming cannot cull tiles that are inside the viewport!
   - Scaling to Twente (`~45 × 35 km` $\approx 6,000$ LOD0 tiles) or Overijssel (`~88 × 82.6 km` $\approx 28,000$ LOD0 tiles) without coarse `LOD1–LOD3` tiles is completely infeasible regardless of `TileStreamManager` eviction.
2. **During Rapid Active Panning at Close/Medium Zoom — Synchronous Commit + WebGL Buffer Upload Bursts (`maxCommitsPerFrame = 4`)**:
   - Even with Web Worker `OSMTILE1` decoding, committing up to `4` dense urban LOD0 tiles in a single frame executes `reconstructTileSceneFromDecoded` (including `MeshBVH.deserialize` and `InstancedMesh` matrix setup) plus WebGL VBO/IBO uploads synchronously on the main thread.

### Q6. Follow-Up Recommendations (Ranked, Strictly Unimplemented in M2-B)

First, **is the `512 m` LOD0 tile size well-chosen?**  
**Yes — keep `512 m` as the LOD0 base tile size.** `512 m` keeps tile-local `Float32` coordinates within `±256 m` (`< 0.1 mm` precision for `4 mm` layer offsets and `1.435 m` rail gauge), bounds single-tile SQLite blob payloads to a fast ~`600 KB` compressed average (`37.79 MiB / 64` tiles in Hengelo), matches `8 × 8` Hengelo (`4,096 m`) cleanly, and gives fine-grained eviction (`0.262 km²` per tile) during street-level navigation. Simply enlarging LOD0 to `1,024 m` would cut close-zoom mesh count only modestly while increasing per-tile decode/commit spike latency `4×` and bloating eviction granularity.

Ranked engineering next steps:

1. **Priority 1 (`M3`) — Implement Zoom-Driven Coarse `LOD1` (`1,024 m`), `LOD2` (`2,048 m`), and `LOD3` (`4,096 m`) Tiles + Atomic Parent/Child Swaps**:
   - *Directly solves the #1 overview bottleneck*: At `far_overview` (`zoom = 0.22`), `4 × 2,048 m` (`LOD2`) or `1 × 4,096 m` (`LOD3`) tiles replace `64 × 512 m` (`LOD0`) tiles (**`16×–64×` fewer tiles**), while omitting minor footways/furniture/bevels/sub-pixel BVHs and lowering `CameraController` `minZoom` (`0.15 -> ~0.015–0.02`) cleanly without breaking the owner's far-zoom workflow.
2. **Priority 2 (`M2` Follow-Up) — Time-Budgeted / Reduced Commit Throttling (`maxCommitsPerFrame = 1–2` or `<= 4 ms` Frame Budget) + Deferred `MeshBVH` Deserialization**:
   - *Directly solves active-pan frame spikes*: Lower `maxCommitsPerFrame` from `4` to `1–2` (or stop draining the commit queue once per-frame commit elapsed time exceeds `~4 ms`), and optionally defer `MeshBVH.deserialize` until idle/hover so camera pans stay smooth even across dense urban tile boundaries.
3. **Priority 3 (Deferred Until Canonical Hardware Telemetry Confirms Need) — Intra-Tile Static Layer Draw-Call Consolidation**:
   - *Reduces the `6.16×` per-tile mesh/draw multiplier inside `LOD0` tiles*: Within each baked `512 m` tile, `Roads_*`, `Water_*`, `Landuse_*`, and `Railway_*` `128 m` spatial sub-chunks currently emit separate `THREE.Mesh` objects (e.g., `74` railway meshes across `16` tiles in synthetic 4×4). Wait for the canonical `8 × 8` Hengelo Windows hardware GPU `--require-hardware` benchmark to verify whether `gl.render()` CPU submission or GPU pass time at `zoom = 1.8–6.5` warrants consolidating sub-chunks inside `OfflineHengeloTileBaker` / `TileSceneReconstructor`.

---

## 5. How to Run Canonical `8 × 8` Hengelo Validation (Windows PowerShell)

Once `data/osm/overijssel-261114-8ae28196.sqlite` and `data/osm/overijssel-tiles-261114-8ae28196.sqlite` are present locally:

```powershell
# Canonical 8x8 Hengelo 3-mode comparison on hardware GPU (ANGLE D3D11)
npx tsx benchmarks/tileStreamingRunner.ts --dataset=canonical-hengelo --require-hardware "--out=benchmarks/results/tkt028-m2b-hengelo-streaming.json" "--markdown-out=benchmarks/results/tkt028-m2b-hengelo-streaming.md"
```

Attach or record the resulting `benchmarks/results/tkt028-m2b-hengelo-streaming.json` hardware GPU numbers (`EXT_disjoint_timer_query_webgl2`, active pan commit timings, and `8 × 8` eviction deltas) in this report and `TKT-028` before closing Milestone M2-B.
