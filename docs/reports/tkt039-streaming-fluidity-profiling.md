# TKT-039 Report — Camera Movement & Streaming Frame-Time Profiling

- **Date:** 2026-11-25
- **Ticket:** [`TKT-039`](../../tickets/TKT-039-camera-movement-and-streaming-frame-time-profiling.md) (`status: in_progress`)
- **Scope:** Opt-in, zero/low-overhead per-frame main-thread stage profiling, timestamped tile-streaming lifecycle logging, browser `LongTask` / `LoAF` observation, first-render upload proxy correlation, real pointer-drag profiling, and a reproducible multi-mosaic Playwright runner (`npm run bench:streaming-fluidity`) targeting a 144 Hz (`6.94 ms`) frame budget. **No runtime optimizations were implemented in this ticket.**
- **Acceptance Status:** Profiling infrastructure, deterministic unit/integration tests (`src/world/StreamingFluidityProfiling.test.ts`), regression suite (`npm test`), and end-to-end SwiftShader Playwright pipeline verification (`1,024 m → 2,048 m → 4,096 m` synthetic mosaics + CDP trace capture) are complete. **Hardware RTX 4060 Ti profiling runs on the three real Twente mosaics (`1,024 m`, `2,048 m`, `4,096 m`) remain open for the project owner.**

---

## 1. Existing Instrumentation Audit vs. TKT-039 Additions

Before adding instrumentation, existing telemetry paths were audited to reuse proven hooks and avoid duplicate timing overhead:

| Existing Facility | What It Already Measured | Gaps for Frame-Time Stutter Attribution | TKT-039 Addition |
|---|---|---|---|
| `TileStreamManager.getDiagnostics()` | Rolling `avg/p95/max` for `fetch`, `decode`, `reconstruct`, `commit`, and `tileInstancedIndexBuildMsTotal` | No per-frame correlation, no timestamped sequence (`attach → first_rendered_use → evict`), no byte sizes on reconstruct, no `sceneAttachMs` vs `rebuildCompositeStatsMs` split | Added `StreamingProfiler` opt-in lifecycle event ring (`fetch_start/complete`, `decode_start/complete`, `ready_to_commit`, `reconstruct_start/complete`, `attach`, `first_rendered_use`, `evict`, `cancel`, `error`) + `viewportUpdateMs` / `streamTickMs` / `reconstructMs` stage breakdown |
| `MapScene.tsx` `BenchmarkFrameTelemetry` (`__BENCHMARK_FRAME_COLLECTOR__`) | `frameIntervalMs`, `cpuRenderTimeMs` (`gl.render()`), `renderCalls`, `renderTriangles`, `driver.geometries`, `EXT_disjoint_timer_query_webgl2` | Recorded only while `__BENCHMARK_ACTIVE__`, no per-frame streaming/camera/picking/React breakdown, no `p99.9` or slow-frame streaks | Reused pre/post `gl.render()` hook and GPU timer state cleanly inside `StreamingProfiler.finishRenderFrame()` while preserving `__BENCHMARK_FRAME_COLLECTOR__` unchanged for disabled-leg overhead checks |
| `CameraController.tsx` | `MapControls.update()`, orthographic frustum clipping, orientation callback | No per-frame timing for `MapControls.update()` or frustum callbacks | Opt-in timing (`controlsUpdateMs`, `cameraFrustumMs`, `cameraOrientationCallbackMs`) gated by `if (prof.enabled)` |
| `DiagnosticsPanel.tsx` / `PerformancePanel.tsx` | Cumulative streaming telemetry & picking diagnostics | No live opt-in profiler toggle or JSON export | Added `Streaming Fluidity Profiler (TKT-039)` REC toggle, bounded sample/event counts, and JSON export button; `?streamingProfile=1` URL opt-in |

---

## 2. Synchronous Stage Nesting & Attribution Model

Every profiled frame divides synchronous main-thread work into **9 mutually exclusive top-level buckets** summed into `attributedSyncMainThreadMs`:

```text
attributedSyncMainThreadMs
 ├── 1. cameraUseFrameMs
 │    ├── controlsUpdateMs              (MapControls.update)
 │    ├── cameraFrustumMs               (projection / zoom frustum math)
 │    └── cameraOrientationCallbackMs   (React orientation throttled callback)
 ├── 2. mapSceneUseFrameOtherMs         (shadowFollowMs, railwayIndexRebuildMs, remaining MapScene loop)
 ├── 3. zoomPropagationMs               (updateCameraZoom across loaded tiles)
 ├── 4. viewportUpdateMs                (TileStreamManager.updateFromCamera + updateViewport)
 │    ├── viewportBoundsMs              (computeViewportGroundBoundsForCamera)
 │    ├── zoomSyncMs                    (sync camera zoom into stream manager)
 │    ├── tileScanMs                    (grid AABB visibility / fetch / keep scan)
 │    ├── cancelInFlightMs              (AbortController cancellations)
 │    ├── evictDisposeMs                (dispose reconstructed geometries, BVHs & spatial indices)
 │    ├── evictRebuildStatsMs           (rebuildCompositeStats after eviction)
 │    ├── evictEmitDiagnosticsMs        (emitDiagnostics snapshot & callbacks after eviction)
 │    └── pumpFetchQueueMs              (queue priority sort & HTTP fetch dispatch)
 ├── 5. streamTickMs                    (TileStreamManager.tick)
 │    ├── readyScanAndSortMs            (ready_to_commit scan & priority sort)
 │    ├── reconstructMs                 (reconstructTileSceneFromDecoded)
 │    │    ├── instancedBvhBuildMs      (InstancedSpatialIndex BVH build)
 │    │    └── staticBvhDeserializeMs   (MeshBVH.deserialize for static meshes)
 │    ├── sceneAttachMs                 (attachTileToCompositeScene)
 │    ├── commitRebuildStatsMs          (rebuildCompositeStats + scene matrixWorld propagation)
 │    └── commitEmitDiagnosticsMs       (emitDiagnostics snapshot & callbacks after commit)
 ├── 6. telemetryHudMs                  (live telemetry aggregation & HUD dispatch)
 ├── 7. pickingRaycasterMs              (THREE.Raycaster.prototype.intersectObjects/Object while enabled)
 ├── 8. reactCommitMs                   (permanent <React.Profiler id="MapWorkspace"> actualDuration)
 └── 9. glRenderCpuMs                   (CPU wall-clock around gl.render(); may include driver sync)
```

`verifyFrameStageNesting()` enforces at test and verification time that child stages never exceed their parent bucket (`epsilon = 0.05 ms`) and are never double-counted in `attributedSyncMainThreadMs`. Any remaining difference `unattributedMs = max(0, frameIntervalMs - attributedSyncMainThreadMs)` highlights GC pauses, V8 compilation, CSS/layout/compositor work, browser `LoAF` scripts, or VSync idle wait.

---

## 3. Methodological Limitations & Caveats

1. **`gl.render()` Driver Sync Caveat:** `glRenderCpuMs` measures synchronous JavaScript CPU wall-clock around `WebGLRenderer.render()`. Depending on the browser ANGLE/driver queue, first-time VAO/VBO uploads, shader program linking, or GPU fence stalls may appear inside `glRenderCpuMs` rather than cleanly separating CPU submission from GPU execution.
2. **First-Render Upload Proxy vs. Direct GPU Upload Timing:** WebGL2 does not expose per-buffer GPU upload durations to JavaScript. Instead, the profiler records `first_rendered_use` lifecycle events (linking `attach` to the first `gl.render()` pass) alongside `newlyAttachedTriangles`, `newlyAttachedMeshes`, and `driverGeometriesDelta` (`gl.info.memory.geometries` delta across `gl.render()`). **These are correlative proxies, not direct measurements of GPU upload duration.**
3. **Observed Refresh Cadence vs. Workload Stalls:** Desktop browsers synchronize `requestAnimationFrame` to display refresh (e.g., ~`16.67 ms` on a 60 Hz monitor vs. ~`6.94 ms` on a 144 Hz monitor). `assessObservedRefreshCadence()` uses stationary baseline intervals and `attributedSyncMainThreadMs` ratios to distinguish `refresh_limited_steady` from `workload_induced_stalls`, `mixed`, or `software_rasterizer_limited`.
4. **Software WebGL Rasterizer:** Headless sandbox Chromium executes on Vulkan SwiftShader, which rasterizes frames on CPU (`~20–50+ ms`) and introduces scheduler variance that masks millisecond-level profiling overhead. Hardware GPU conclusions must come from the owner's RTX 4060 Ti run.

---

## 4. Sandbox Verification Results

### 4.1 Unit & Integration Tests (`src/world/StreamingFluidityProfiling.test.ts`)

Passed `7 / 7` tests (`npx tsx --test src/world/StreamingFluidityProfiling.test.ts`):

- Extended frame distribution statistics (`p99.9`, `[6.94, 13.89, 16.67, 33.33, 50.0] ms` exceedances, and longest consecutive slow-frame streaks).
- Observed cadence classifier (`refresh_limited_steady` vs. `workload_induced_stalls` vs. `software_rasterizer_limited`).
- `StreamingProfiler` disabled zero-op guard, bounded circular buffer drop counters (`totalInserted` vs. retained capacity), dynamic `THREE.Raycaster` prototype wrap/unwrap lifecycle, and strict nested stage conservation (`verifyFrameStageNesting`).
- Live `TileStreamManager` + `StreamingProfiler` integration verifying exact compressed payload byte capture (prior to worker transfer), decoded raw footprint, BVH sub-stage timing, `fetch_start → fetch_complete → decode_start → decode_complete → ready_to_commit → reconstruct_start → reconstruct_complete → attach → first_rendered_use → evict → cancel` lifecycle sequence.
- Scenario B warm-cache violation detection, Scenario D reverse-traversal reuse ratio, `attributeWorstFrames` spike attribution, UTM-to-local projection (`utmToLocalTarget`), CLI parsing, and Markdown report generation.

### 4.2 End-to-End Playwright Verification (Synthetic SwiftShader)

Executed `runStreamingFluidityBenchmark()` (`--quick --allow-software --foliage=on --picking=accelerated --scenarios=A,B,C,D,E,F,G,overhead --trace-out=...`) on a temporary `8 × 4` `1,024 m` mosaic consolidated to `2,048 m` (`5 × 3`) and `4,096 m` (`3 × 2`):

- **Renderer:** `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` (`isSoftwareRenderer: true`).
- **Scenario Coverage:** Produced `18` interactive scenario records (Scenarios A–E + G across all 3 tile sizes), `3` isolated teleportation records (Scenario F), `3` profiler overhead comparisons, and a `20,991`-event Chrome DevTools CDP trace JSON (`trace.json`).
- **Verified Behaviors:** Scenario B (`B_warm_cache_pan`) passed `warm_cache_clean` (`0` streaming events) across all three mosaics; Scenario C (`C_streaming_pan`) triggered real fetch/decode/reconstruct/attach/`first_rendered_use`/evict sequences on `1,024 m` (`f=4, r=4, a=4, u=4, e=8`); Scenario G (`G_pointer_drag_pan`) executed real Playwright pointer drags (`inputPath: 'real_pointer_drag'`).

---

## 5. Hardware Benchmarking & Chrome Trace Guide (Project Owner — Windows PowerShell)

### 5.1 Primary Full-Twente Comparison (`1,024 m` vs. `2,048 m` vs. `4,096 m`, Foliage ON & OFF)

Run directly against your three existing full-Twente mosaics at identical physical EPSG:25832 UTM coordinates (refuses software WebGL unless `--allow-software` is explicitly passed):

```powershell
npm run bench:streaming-fluidity -- `
  --index-1024=data/osm/twente-full-1024m-foliage-fix/mosaic.json `
  --index-2048=data/osm/twente-full-foliage-fix-batched-2048m/mosaic.json `
  --index-4096=data/osm/twente-full-foliage-fix-batched-4096m/mosaic.json `
  --foliage=both `
  --picking=accelerated `
  --scenarios=all `
  --pan-speed-mps=350 `
  --warm-pan-distance-m=120 `
  --warmup-ms=800 `
  --measure-ms=4000 `
  --runs=2 `
  --out=benchmarks/results/tkt039-streaming-fluidity.json `
  --markdown-out=benchmarks/results/tkt039-streaming-fluidity.md
```

### 5.2 Focused `4,096 m` Deep-Dive + Chrome DevTools CDP Trace Capture

To capture a full Chrome DevTools Performance trace during `C_streaming_pan` alongside the worst-frame attribution report:

```powershell
npm run bench:streaming-fluidity -- `
  --index-4096=data/osm/twente-full-foliage-fix-batched-4096m/mosaic.json `
  --foliage=both `
  --picking=both `
  --scenarios=A,B,C,D,E,F,G,overhead `
  --measure-ms=5000 `
  --runs=2 `
  --trace-out=benchmarks/results/tkt039-4096m-trace.json `
  --out=benchmarks/results/tkt039-4096m-deepdive.json `
  --markdown-out=benchmarks/results/tkt039-4096m-deepdive.md
```

Load `benchmarks/results/tkt039-4096m-trace.json` in Chrome DevTools → **Performance** → **Load profile...** (or `chrome://tracing`) to inspect main-thread JS tasks, V8 GC pauses, worker decode threads, GPU process stalls, and compositor frame pacing side-by-side with `tkt039-4096m-deepdive.md`.

### 5.3 Interactive Profiling in the Live Viewer

1. Launch with the `4,096 m` mosaic:
   ```powershell
   $env:OVERIJSSEL_REGIONAL_MOSAIC_PATH = "data/osm/twente-full-foliage-fix-batched-4096m/mosaic.json"
   npm run dev
   ```
2. Open **Diagnostics** → **Streaming Fluidity Profiler (TKT-039)** and click **Start Recording** (or launch directly with `?streamingProfile=1`), pan/zoom across Twente, then export the bounded JSON trace via **Export JSON**.
