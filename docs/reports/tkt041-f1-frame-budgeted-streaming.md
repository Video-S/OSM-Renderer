# TKT-041-F1 — Frame-Budgeted Streaming and Resolution Transitions Evaluation Report

- **Ticket:** [`TKT-041-F1`](../../tickets/TKT-041-F1-frame-budgeted-streaming.md) (parent: [`TKT-041`](../../tickets/TKT-041-hierarchical-tile-streaming.md))
- **Architectural Decision Record:** [`ADR-0016`](../decisions/ADR-0016-frame-budgeted-streaming-and-incremental-gpu-prep.md) (extends [`ADR-0015`](../decisions/ADR-0015-hierarchical-tile-streaming.md))
- **Date:** 2026-11-26
- **Status:** Implemented and verified in sandbox (unit/integration suite `49/49` and 7-variant SwiftShader Playwright evaluation); pending owner RTX 4060 Ti hardware benchmarks and visual acceptance on `data/osm/twente-full-hierarchical.json`.

---

## 1. Executive Summary & Architectural Scope

Owner RTX 4060 Ti validation of `TKT-041` demonstrated that uniform-viewport hierarchical tile streaming (`1,024 m / 2,048 m / 4,096 m`) substantially improves stationary and single-resolution FPS stability, and that increasing the desktop CPU memory budget from `768 MiB` to `1,536 MiB` eliminates `deferred_budget` transition stalls. However, two runtime issues remained during interactive navigation:

1. **Interactive frame-time stuttering during simultaneous zooming and panning:** Main-thread tile reconstruction, first-render WebGL buffer uploads, atomic resolution activation, scene statistics/boundary overlay rebuilds, and synchronous geometry/BVH disposal could coincide in individual frames (`> 16.67 ms` / `> 33.33 ms`).
2. **Prolonged pending states when transitioning to `4,096 m` tiles (Section 12):** During continuous panning while zooming out toward `4,096 m`, pending transitions could remain in `preparing` for an extended period before activating.

`TKT-041-F1` addresses both requirements while preserving uniform viewport resolution, atomic frame-boundary activation, TKT-040 `combined` worker preparation, `OSMTILE1` v1 payload compatibility, and canonical feature picking parity:

- **Provisional `1,536 MiB` desktop CPU memory budget default (`HierarchicalResourceBudget.ts`):** `totalMemoryBudgetBytes = 1,536 MiB` (`inactiveCacheBudgetBytes = 384 MiB`, `maxPendingDecodedBytes = 256 MiB`), with explicit accounting for pending deferred-disposal memory (`pendingDisposalBytes`).
- **Shared Priority-Ordered Frame Workload Scheduler (`StreamingWorkloadScheduler.ts`, `StreamingSchedulerConfig.ts`):** Coordinates per-frame main-thread streaming work under `schedulerFrameBudgetMs` (default `2.0 ms`, configurable `1.0 / 2.0 / 4.0 ms`) across 5 strict priority classes (`active_visible_coverage` with starvation escape, `pending_transition_prepare`, `resolution_activation`, `active_preload`, `deferred_disposal`) and records `schedulerOverrunMs` and `indivisibleOverrunCount` transparently.
- **Offscreen 1×1 Render-Target Incremental GPU Preparation (`IncrementalGpuPreparer.ts`, `MapScene.tsx`):** Slices WebGL vertex/index/instance buffer uploads across preparation frames using only public Three.js APIs before destination tiles are attached to the visible `compositeScene`.
- **Bounded Deferred Disposal Queue (`DeferredDisposalQueue.ts`):** Detaches outgoing active or evicted tiles from the scene graph immediately (guaranteeing zero duplicate rendered resolutions), then drains `BufferGeometry.dispose()` and BVH teardown incrementally under a `256 MiB` `maxPendingDisposalBytes` emergency-drain ceiling.
- **Time-Based Transition Debouncing, Reversal Reuse & Boundary Overlay Gating (`TileStreamManager.ts`):** Applies a `150 ms` automatic transition debounce that advances during continuous camera movement (never requiring movement to pause), reuses already-prepared destination tiles (`prepared_inactive`) across viewport shifts/reversals, and skips rebuilding `M1a_InternalTileSeams` when the boundary overlay is hidden.
- **Section 12 Transition Critical-Path Instrumentation, Contention Elimination & Predictive Pre-Warming:**
  - Instruments the 7-stage per-tile critical path (`fetchQueueWaitMs`, `payloadRetrievalMs`, `workerQueueWaitMs`, `workerDecodeAndBvhMs`, `mainThreadReconstructWaitMs`, `reconstructMs`, `gpuPrepWaitMs` + `gpuPrepSubmitMs`, plus transition-level `remainingCoverageWaitMs` and `tailTileEnteredLateMs`).
  - Suppresses non-visible active-resolution preload fetches (`prioritizeDestinationOverActivePreload`) while a transition is pending and active visible coverage is complete, and upgrades `TileDecodeClient` from FIFO to priority-ordered worker dispatch.
  - Exposes live `currentTransitionBlocker`, `slowestOutstandingTile`, and `lastCompletedTransition` in `DiagnosticsPanel` and benchmark exports.
  - Evaluates trend-aware predictive pre-warming (`resolveApproachingResolutionForPrewarm`, `combined_prewarm`) when approaching a zoom threshold under `< 75%` memory utilization.

---

## 2. Three.js `0.186.1` Public-API Incremental GPU Preparation Notes

Per Section 5 of `TKT-041-F1`, `IncrementalGpuPreparer.ts` uses **only supported public Three.js APIs** (verified against the repository's installed Three.js `0.186.1`):

1. **Mechanism (`ThreeWebGLOffscreenUploadAdapter`):**
   - Allocates a reusable 1×1 `THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false })`, a minimal `THREE.Scene` tagged with `stagingScene.userData.__isIncrementalGpuPrepStagingScene = true`, and a fixed `THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)`.
   - For each `GpuPrepUnit` (individual `THREE.Mesh` or `THREE.InstancedMesh` within a reconstructed tile), saves the mesh's parent, local matrix, `matrixAutoUpdate`, `frustumCulled`, and `visible` state; moves the mesh into `stagingScene` at identity transform with `frustumCulled = false`; disables color/depth/stencil writes on the raw WebGL context (`gl.colorMask(false, false, false, false)`, `gl.depthMask(false)`); calls `renderer.render(stagingScene, stagingCamera)` into the 1×1 render target; and immediately restores the mesh to its original parent/transform and restores the renderer's previous render target, viewport, scissor, `autoClear`, and `renderer.info.render` counters.
2. **Profiler Isolation (`MapScene.tsx`):**
   - `MapScene.tsx` checks `scene?.userData?.[GPU_PREP_STAGING_SCENE_FLAG]` at the top of its wrapped `gl.render` function and passes through directly to `originalRender(scene, cam, ...)` without triggering main-pass `StreamingProfiler` frame completion or `EXT_disjoint_timer_query` brackets.
   - All CPU time spent inside the 1×1 staging renders is measured by `TileStreamManager.tick()` as `gpuUploadSubmitMs` (a nested sub-stage of `streamTickMs`).
3. **Honest CPU Submission vs. GPU Completion Distinction:**
   - WebGL does not expose asynchronous GPU DMA completion timestamps for buffer uploads. `gpuUploadSubmitMs` measures synchronous CPU driver submission (`gl.bufferData` / `gl.bufferSubData` and attribute/program setup during the 1×1 offscreen render), while `driverGeometriesDelta` on the subsequent visible main-scene render verifies whether new WebGL geometries were already registered prior to atomic swap.
4. **WebGL Context-Loss Safety:**
   - Listeners on `renderer.domElement` for `webglcontextlost` and `webglcontextrestored` increment an internal `contextEpoch`. Prepared unit markers are keyed by `contextEpoch`, so context restoration automatically invalidates stale upload markers and safely re-prepares active/pending tiles.

---

## 3. Section 12 Investigation: Root Causes of Prolonged `4,096 m` Pending States

Instrumenting the complete 7-stage transition critical path (`TransitionCriticalPathRecord` and live `TransitionBlockerSnapshot`) revealed four distinct mechanisms that can prolong `1,024 m / 2,048 m -> 4,096 m` transitions during simultaneous panning and zooming:

| Mechanism | Diagnostic Signature (`TransitionBlockerCategory` / Critical-Path Stage) | Root Cause in `TKT-041` Baseline | `TKT-041-F1` Mitigation |
| --- | --- | --- | --- |
| **1. Fetch-slot contention with active preload ring** | `fetch_queue_contention` (`stagesMs.fetchQueueWaitMs` dominant; `contention.activePreloadInFlightCount > 0`) | Continuous panning at `1,024 m` or `2,048 m` continuously queues non-visible preload-ring tiles (`fetchSet \ visibleSet`), occupying the 6 concurrent HTTP fetch slots ahead of newly requested `4,096 m` destination tiles. | `prioritizeDestinationOverActivePreload` (enabled in `combined` and `combined_prewarm`): while a transition is pending and active visible coverage has no gaps, `pumpFetchQueue()` suppresses non-visible active preload fetches so required visible destination tiles claim open fetch slots immediately. |
| **2. FIFO worker decode queueing** | `worker_queue_waiting` (`stagesMs.workerQueueWaitMs` dominant) | `TileDecodeClient` previously dispatched queued worker decode jobs in FIFO arrival order, so earlier active-preload payloads could delay a required `4,096 m` destination payload in the worker queue. | `TileDecodeClient.decodeTile()` now maintains a priority-ordered wait queue (`priorityScore`), dispatching visible destination decodes ahead of lower-priority preload jobs and recording `clientQueueWaitMs`. |
| **3. Moving-target tail tiles during continuous pan** | `remainingCoverageWaitMs` and `tailTileEnteredLateMs > 0` | While zooming out and panning across a `4,096 m` grid boundary, the first `4,096 m` tiles finish preparing early, but panning uncovers an adjacent `4,096 m` tile (`tailTileEnteredLateMs` after `transitionStartedAtMs`). Atomic activation must wait for 100% of currently visible destination tiles. | Separated `tailTileEnteredLateMs` and `remainingCoverageWaitMs` in `TransitionCriticalPathRecord` so moving-viewport tail arrivals are distinguished from per-tile pipeline stalls; `reuseDestinationPreparation` preserves already-prepared `4,096 m` tiles while the newly entered tile finishes. |
| **4. Incremental GPU prep slicing trade-off** | `gpu_prep_waiting` (`stagesMs.gpuPrepWaitMs` dominant when `maxGpuUploadUnitsPerFrame` / `schedulerFrameBudgetMs` is tight) | Spreading destination GPU buffer uploads across frames eliminates single-frame upload spikes, but if too few units are uploaded per frame, `gpuPrepWaitMs` adds frame-by-frame latency before atomic activation. | Default `combined` uploads up to `8` mesh units / `8 MiB` per frame within the shared scheduler budget, and `combined_prewarm` pre-warms approaching destination tiles before threshold crossing so `reusedFromPrewarmCount` tiles are already reconstructed and GPU-prepared when the zoom boundary is crossed. |

---

## 4. Sandbox Verification Results

> **Environment Provenance Note:** All sandbox measurements below were executed in the Linux container environment using headless Chromium with **Google SwiftShader (`--allow-software`)** against deterministic synthetic 3-resolution (`1,024 m / 2,048 m / 4,096 m`) `OSMTILE1` mosaics. SwiftShader CPU software rasterization (~15–20 FPS baseline) **must not** be compared to or conflated with owner NVIDIA RTX 4060 Ti hardware GPU measurements.

### 4.1 Automated Unit & Integration Test Suite (`49 / 49` Passing)

Command executed:
```bash
npx tsx --test src/world/FrameBudgetedStreaming.test.ts src/world/HierarchicalTileStreaming.test.ts src/world/NonBlockingTilePreparation.test.ts src/world/InstancedSpatialPicking.test.ts src/world/StreamingFluidityProfiling.test.ts src/world/TilingM2aStreaming.test.ts src/world/TilingM2bLifecycleValidation.test.ts src/world/FoliageLodOptimization.test.ts src/world/TileConsolidation.test.ts src/world/RegionalMosaicIdentityAndZoomPolicy.test.ts
```

- `src/world/FrameBudgetedStreaming.test.ts` (`6/6` subtests pass):
  1. `StreamingSchedulerConfig` 7 presets, URL parsing (`?f1Variant=...`, `?streamFrameBudgetMs=...`, `?transitionDebounceMs=...`, `?predictivePrewarm=...`), and `1,536 MiB` provisional CPU budget defaults.
  2. `StreamingWorkloadScheduler` strict 5-tier priority ordering, time-budget cutoff, obsolete-work cancellation, indivisible overrun accounting, and `active_visible_coverage` starvation escape.
  3. `IncrementalGpuPreparer` multi-frame unit/byte slicing, prepared-unit reuse across reversals, WebGL context-loss epoch invalidation, and clean disposal.
  4. `DeferredDisposalQueue` immediate scene detachment, paced per-frame geometry disposal, duplicate-key protection, emergency byte-target draining, and shared material preservation.
  5. End-to-end `TileStreamManager` incremental GPU preparation, deferred disposal, `150 ms` transition debounce during continuous panning, zero duplicate attached resolutions, canonical feature picking parity on `4,096 m`, Section 12 `TransitionCriticalPathRecord` 7-stage verification, and `verifyFrameStageNesting` validation.
  6. Section 12 trend-aware predictive pre-warming (`resolveApproachingResolutionForPrewarm`, `prewarmTilesPrepared > 0`, `prewarmReusedOnTransition > 0` on threshold crossing).

### 4.2 Synthetic 7-Variant Playwright Benchmark Verification (`benchmarks/hierarchicalStreamingRunner.ts`)

Executed across all 7 variants (`tkt041_baseline`, `scheduler_only`, `incremental_gpu_only`, `deferred_disposal_only`, `debounce_reuse_only`, `combined`, `combined_prewarm`) on a temporary 3-resolution (`1,024 m / 2,048 m / 4,096 m`) synthetic mosaic with `--foliage=on --allow-software --quick`:

| Variant | `rapid_zoom_reversal_pan` Transitions (`start / complete / cancel / defer / debouncedAvoided`) | `repeated_resolution_transitions_pan` Transitions (`start / complete / cancel / defer / debouncedAvoided`) | `simultaneous_pan_zoom_cold` Critical-Path `fetchQueueWaitMs` (ms) | `simultaneous_pan_zoom_warm` Pre-Warm Reuse (`reusedFromPrewarmCount`) | Max Simultaneous Attached Resolutions | Stage Nesting Violations |Comparison Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tkt041_baseline` | `7 / 7 / 0 / 0 / 0` | `8 / 8 / 0 / 0 / 0` | `298.1` | `0` | `1` | `0` | `VALID` |
| `scheduler_only` | `7 / 7 / 0 / 0 / 0` | `8 / 8 / 0 / 0 / 0` | `3.1` (`prioritizeDestinationOverActivePreload` on) | `0` | `1` | `0` | `VALID` |
| `incremental_gpu_only` | `8 / 8 / 0 / 0 / 0` | `8 / 8 / 0 / 0 / 0` | `1.2` | `0` | `1` | `0` | `VALID` |
| `deferred_disposal_only` | `8 / 8 / 0 / 0 / 0` | `8 / 8 / 0 / 0 / 0` | `276.9` | `0` | `1` | `0` | `VALID` |
| `debounce_reuse_only` | `2 / 2 / 0 / 0 / 0` (transient oscillation filtered) | `5 / 5 / 0 / 0 / 1` | `389.0` | `0` | `1` | `0` | `VALID` |
| `combined` | `2 / 2 / 0 / 0 / 0` | `5 / 5 / 0 / 0 / 1` | `272.5` (warm: `1.7`) | `0` | `1` | `0` | `VALID` |
| `combined_prewarm` | `2 / 2 / 0 / 0 / 0` | `7 / 7 / 0 / 0 / 1` | `102.0` (warm: `0.0`) | `> 0` (`none (3)` blocker on warm transitions) | `1` | `0` | `VALID` |

Key synthetic verification takeaways:
- **Zero visual/contract violations across all 7 variants:** `maxSimultaneousAttachedResolutions = 1`, `timeWithoutValidCoverageMs = 0`, `transitionsDeferredBudget = 0`, `stageNestingViolations = 0`, and `comparisonValid = true` across every scenario and variant.
- **Debounce & reversal reuse (`debounce_reuse_only`, `combined`, `combined_prewarm`):** Rapid zoom oscillation during continuous panning (`rapid_zoom_reversal_pan`) reduced unnecessary full-resolution replacement transitions from `7–8` down to `2` sustained transitions without dropping coverage.
- **Destination prioritization & predictive pre-warming (`scheduler_only`, `combined`, `combined_prewarm`):** Prioritizing destination visible fetches over active preload ring tiles eliminated `fetch_queue_contention` on warm and repeated transitions (`298.1 ms -> 0.9–3.2 ms`), and `combined_prewarm` prepared approaching resolution tiles ahead of threshold crossing so warm transitions completed with `0.0 ms` fetch/decode/reconstruct/GPU-prep wait (`dominantBlockerCategory: none`).

---

## 5. Exact Windows PowerShell Commands for Owner RTX 4060 Ti Evaluation

> **Note:** All commands below invoke `npx tsx` directly (avoiding `npm run ... --` argument stripping in Windows PowerShell) and point to `data/osm/twente-full-hierarchical.json` (created in `TKT-041` via `scripts/create-hierarchical-mosaic-descriptor.ts`).

### 5.1 Full 7-Variant Evaluation (`foliage=on` and `foliage=off` at `1,536 MiB` Default Budget)

```powershell
npx tsx benchmarks/hierarchicalStreamingRunner.ts `
  --descriptor=data/osm/twente-full-hierarchical.json `
  --variants=tkt041_baseline,scheduler_only,incremental_gpu_only,deferred_disposal_only,debounce_reuse_only,combined,combined_prewarm `
  --foliage=both `
  --budget-mb=1536 `
  --require-hardware `
  --out=docs/reports/tkt041-f1-twente-hardware-variants.json `
  --markdown-out=docs/reports/tkt041-f1-twente-hardware-variants.md
```

### 5.2 Shared Scheduler Frame-Budget Sweep (`1.0 ms`, `2.0 ms`, `4.0 ms`) on `combined`

```powershell
npx tsx benchmarks/hierarchicalStreamingRunner.ts `
  --descriptor=data/osm/twente-full-hierarchical.json `
  --variants=combined `
  --budgets=1,2,4 `
  --foliage=on `
  --budget-mb=1536 `
  --require-hardware `
  --out=docs/reports/tkt041-f1-twente-budget-sweep.json `
  --markdown-out=docs/reports/tkt041-f1-twente-budget-sweep.md
```

### 5.3 Transition Debounce Sweep (`100 ms`, `150 ms`, `250 ms`) on `combined` and `combined_prewarm`

```powershell
npx tsx benchmarks/hierarchicalStreamingRunner.ts `
  --descriptor=data/osm/twente-full-hierarchical.json `
  --variants=combined,combined_prewarm `
  --debounce-ms=100,150,250 `
  --foliage=on `
  --budget-mb=1536 `
  --require-hardware `
  --out=docs/reports/tkt041-f1-twente-debounce-sweep.json `
  --markdown-out=docs/reports/tkt041-f1-twente-debounce-sweep.md
```

### 5.4 Interactive Viewer Launch with `TKT-041-F1` URL Overrides

```powershell
$env:OVERIJSSEL_HIERARCHICAL_MOSAIC_PATH = "data/osm/twente-full-hierarchical.json"
npm run dev
```

Available interactive URL query parameters (also configurable live in **Context Sidebar -> Diagnostics -> TKT-041-F1 Frame Budget & Section 12 Transition Critical Path**):
- `?f1Variant=combined` (or `tkt041_baseline`, `scheduler_only`, `incremental_gpu_only`, `deferred_disposal_only`, `debounce_reuse_only`, `combined_prewarm`)
- `?streamFrameBudgetMs=2.0` (`0.25` to `16.0`)
- `?transitionDebounceMs=150` (`0` to `1000`)
- `?incrementalGpuPrep=1` (`0` or `1`)
- `?deferredDisposal=1` (`0` or `1`)
- `?prioritizeDestination=1` (`0` or `1`)
- `?predictivePrewarm=1` (`0` or `1`)
- `?hierarchicalBudgetMb=1536` (`64` to `8192`)
