# TKT-041-F1 — Frame-Budgeted Streaming and Resolution Transitions

## Status

- **ID:** `TKT-041-F1`
- **Status:** `in_progress` (sandbox implementation, unit/integration suite, and 7-variant SwiftShader Playwright evaluation complete; pending owner real-data RTX 4060 Ti hardware benchmarks and visual acceptance on `data/osm/twente-full-hierarchical.json`)
- **Parent Ticket:** [`TKT-041`](TKT-041-hierarchical-tile-streaming.md)
- **Related ADRs:** [`ADR-0014`](../docs/decisions/ADR-0014-spatially-accelerated-instanced-feature-picking.md), [`ADR-0015`](../docs/decisions/ADR-0015-hierarchical-tile-streaming.md), [`ADR-0016`](../docs/decisions/ADR-0016-frame-budgeted-streaming-and-incremental-gpu-prep.md)
- **Evaluation Report:** [`docs/reports/tkt041-f1-frame-budgeted-streaming.md`](../docs/reports/tkt041-f1-frame-budgeted-streaming.md)

---

## 1. Motivation & Problem Statement

Owner hardware validation of `TKT-041` on the RTX 4060 Ti confirmed that hierarchical tile streaming (`1,024 m / 2,048 m / 4,096 m`) improves stationary and single-resolution FPS stability, and that raising the CPU-side memory budget from `768 MiB` to `1,536 MiB` eliminates transition deferrals (`deferred_budget`). However, two distinct issues persisted during interactive exploration:

1. **Interactive frame-time stuttering during simultaneous zooming and panning:** Reconstruction, destination GPU buffer upload, atomic resolution activation, scene statistics/boundary overlay rebuilds, and inactive tile disposal could still accumulate into individual frames (`> 16.67 ms` and `> 33.33 ms`).
2. **Prolonged pending states when transitioning to `4,096 m` tiles (Section 12):** During continuous panning + zooming out toward `4,096 m`, destination transitions experienced prolonged `preparing` durations before atomic activation.

The objective of `TKT-041-F1` is to distribute expensive main-thread and GPU-upload streaming operations across frames for frame-time consistency **and** eliminate/diagnose prolonged transition pending states — measuring **transition latency independently from frame-time consistency** so smoother frame pacing is never achieved by allowing transitions to remain pending indefinitely.

---

## 2. Architectural Scope & Invariants Preserved

- **Uniform viewport resolution & atomic activation (`ADR-0015`):** A single active resolution (`1,024 m`, `2,048 m`, or `4,096 m`) renders across the entire viewport at any instant; destination tiles are prepared and GPU-uploaded off-scene (`prepared_inactive`) and swapped atomically at frame boundaries.
- **TKT-040 `combined` worker preparation:** Compact zero-copy worker transport and worker-side `InstancedSpatialIndex` BVH construction remain the default preparation path.
- **No rebaking or schema changes:** Existing `OSMTILE1` v1 SQLite packs, consolidated `2,048 m` / `4,096 m` mosaics, and single-resolution mosaics remain 100% compatible.
- **Provisional `1,536 MiB` desktop CPU budget (`HierarchicalResourceBudget.ts`):** Default `totalMemoryBudgetBytes` is raised to `1,536 MiB` (`inactiveCacheBudgetBytes: 384 MiB`, `maxPendingDecodedBytes: 256 MiB`) with explicit CLI/URL overrides (`?hierarchicalBudgetMb=...`, `--budget-mb=...`).

---

## 3. Implemented Components

### 3.1 Shared Streaming Workload Scheduler (`src/world/tiling/StreamingWorkloadScheduler.ts`, `StreamingSchedulerConfig.ts`)

- Coordinates per-frame main-thread streaming work under a shared time budget (`schedulerFrameBudgetMs`, default `2.0 ms`, configurable `1.0 / 2.0 / 4.0 ms`) in strict priority order:
  1. `active_visible_coverage` — active-resolution visible tiles when the viewport has a coverage gap (starvation escape allows 1 critical unit even when budget is exhausted).
  2. `pending_transition_prepare` — pending-resolution visible tiles required for atomic transition readiness (reconstruction + incremental GPU upload).
  3. `resolution_activation` — atomic frame-boundary resolution swap when destination coverage and GPU preparation are complete.
  4. `active_preload` — active-resolution non-visible preload tiles and predictive pre-warming tiles.
  5. `deferred_disposal` — background incremental geometry/BVH disposal from `DeferredDisposalQueue`.
- Tracks `schedulerBudgetMs`, `schedulerUsedMs`, `schedulerOverrunMs`, and `indivisibleOverrunCount` when a single indivisible unit (e.g., reconstructing one consolidated `4,096 m` tile or executing an atomic scene-group swap) exceeds the remaining slice budget.
- Exposes 7 isolated and combined experimental presets (`?f1Variant=...`, `--variants=...`):
  - `tkt041_baseline`
  - `scheduler_only`
  - `incremental_gpu_only`
  - `deferred_disposal_only`
  - `debounce_reuse_only`
  - `combined` (default production configuration)
  - `combined_prewarm` (`combined` + Section 12 trend-aware predictive pre-warming)

### 3.2 Incremental Off-Scene GPU Preparation (`src/world/tiling/IncrementalGpuPreparer.ts`, `src/scene/MapScene.tsx`)

- Eliminates first-rendered-frame WebGL buffer upload spikes when activating a new resolution or attaching large consolidated tiles.
- Decomposes each reconstructed tile into individual mesh and `InstancedMesh` upload units (`GpuPrepUnit`).
- Uses only public Three.js APIs (`ThreeWebGLOffscreenUploadAdapter`): temporarily attaches each mesh unit to a minimal tagged `stagingScene` (`userData.__isIncrementalGpuPrepStagingScene = true`) with identity transform and `frustumCulled = false`, renders into a tiny 1×1 `WebGLRenderTarget` with color/depth/stencil writes disabled, and restores the renderer's previous render target, viewport, scissor, and `WebGLInfo` counters.
- `MapScene.tsx` detects `GPU_PREP_STAGING_SCENE_FLAG` at the top of its `gl.render` wrapper so offscreen 1×1 staging uploads bypass main-pass profiler and EXT_disjoint_timer_query hooks and are attributed strictly to `gpuUploadSubmitMs`.
- Tracks WebGL context-loss epochs (`webglcontextlost` / `webglcontextrestored`) to invalidate stale upload markers and safely re-prepare tiles without leaking resources.

### 3.3 Deferred Disposal Queue (`src/world/tiling/DeferredDisposalQueue.ts`)

- Decouples immediate scene-graph detachment (`detachTileFromCompositeScene`) from CPU/WebGL `BufferGeometry.dispose()` and BVH teardown.
- Evicted active tiles and demoted inactive tiles are detached immediately on the frame of eviction/transition so zero duplicate resolutions ever render, then enqueued into `DeferredDisposalQueue` with duplicate-tile-key protection.
- Drains incrementally within the shared frame budget (`maxDeferredDisposeTilesPerFrame`, `maxDeferredDisposeGeometriesPerFrame`) and synchronously emergency-drains (`drainToTargetBytes`) whenever `pendingDisposalBytes` exceeds `maxPendingDisposalBytes` (`256 MiB`) or total memory pressure requires immediate reclamation.
- Preserves shared materials (`TileMaterialRegistry`) and shared foliage prototypes (`FoliagePrototypeRegistry`).

### 3.4 Resolution Transition Debouncing, Reversal Reuse & Boundary Overlay Gating (`TileStreamManager.ts`)

- Adds configurable time-based transition debouncing (`transitionDebounceMs`, default `150 ms` in `auto` mode) so brief zoom threshold oscillations do not trigger heavy replacement cascades (`transitionsDebouncedAvoided`).
- **Never requires camera movement to stop:** elapsed debounce time advances while the camera is continuously panning and zooming.
- When `reuseDestinationPreparation` is enabled (`debounce_reuse_only`, `combined`, `combined_prewarm`), already-reconstructed and GPU-prepared destination tiles (`prepared_inactive`) are retained across viewport shifts or brief reversals (`destinationPrepReused`).
- Skips rebuilding the `M1a_InternalTileSeams` tile-boundary wireframe overlay when `showM2aTileBoundaries` is hidden (`boundaryOverlaySkippedWhenHidden`), rebuilding immediately when toggled on.

### 3.5 Section 12 — Transition Critical-Path Instrumentation, Contention Elimination & Predictive Pre-Warming

- **Per-tile 7-stage pipeline instrumentation (`TilePipelineTimings`):**
  1. `fetchQueueWaitMs` (time spent `queued` before an HTTP fetch slot opens)
  2. `payloadRetrievalMs` (HTTP fetch + `arrayBuffer()` read)
  3. `workerQueueWaitMs` (`workerClientQueueWaitMs` + `workerThreadQueueWaitMs`)
  4. `workerDecodeAndBvhMs` (`workerInflateAndDecodeMs` + `workerBvhBuildMs` + `workerPayloadPrepMs`)
  5. `mainThreadReconstructWaitMs` + `reconstructMs`
  6. `gpuPrepWaitMs` + `gpuPrepSubmitMs`
  7. `remainingCoverageWaitMs` + `tailTileEnteredLateMs` (new destination tiles entering the viewport during continuous panning while earlier destination tiles are already prepared)
- **Live Transition Blocker & History (`TransitionBlockerSnapshot`, `TransitionCriticalPathRecord`):**
  - Exposes `currentTransitionBlocker` (active blocker category, human-readable reason, queue breakdown, contention metrics, and `slowestOutstandingTile` with per-stage elapsed times) and `lastCompletedTransition` / `transitionHistory` in `DiagnosticsPanel` and exported benchmark JSON/Markdown.
- **Destination vs. Active-Preload Contention Elimination (`prioritizeDestinationOverActivePreload`):**
  - When a resolution transition is pending and active visible coverage has no gaps, non-visible active-resolution preload tiles (`fetchSet \ visibleSet`) are suppressed in `pumpFetchQueue()` and deprioritized in `TileDecodeClient`'s priority queue so destination visible tiles (`4,096 m`) are never starved behind speculative `1,024 m` / `2,048 m` ring preloads.
- **Trend-Aware Predictive Pre-Warming (`resolveApproachingResolutionForPrewarm`, `combined_prewarm`):**
  - When `predictivePrewarmEnabled` is active and camera zoom approaches a resolution threshold in the direction of `zoomTrend` (`zooming_out` or `zooming_in`) within `predictivePrewarmBandFraction` (`25%` of the hysteresis band) under healthy memory headroom (`< 75%` budget used) and zero active coverage gaps, visible destination tiles are pre-fetched, decoded, reconstructed, and GPU-prepared off-scene ahead of threshold crossing (`prewarmTilesPrepared`, `prewarmReusedOnTransition`).

---

## 4. Verification Summary (Sandbox vs. Owner Hardware Gate)

### Verified in Sandbox
- `src/world/FrameBudgetedStreaming.test.ts` (`6/6` subtests pass):
  - Preset/URL parsing and `1,536 MiB` provisional budget defaults.
  - `StreamingWorkloadScheduler` priority ordering, frame budget enforcement, cancellation, and starvation escape.
  - `IncrementalGpuPreparer` multi-frame slicing, prepared-unit reuse, WebGL context-loss epoch invalidation, and clean disposal.
  - `DeferredDisposalQueue` immediate scene detachment, paced geometry disposal, duplicate guard, and shared material preservation.
  - End-to-end `TileStreamManager` incremental GPU preparation, deferred disposal, transition debounce (`150 ms` during continuous pan), zero duplicate attached resolutions, canonical feature picking parity, Section 12 `TransitionCriticalPathRecord`, and `verifyFrameStageNesting` validation.
  - Section 12 predictive pre-warming (`resolveApproachingResolutionForPrewarm`, `prewarmTilesPrepared`, `prewarmReusedOnTransition`).
- Full 10-suite world/tiling regression test run (`49/49` tests pass across `FrameBudgetedStreaming`, `HierarchicalTileStreaming`, `NonBlockingTilePreparation`, `InstancedSpatialPicking`, `StreamingFluidityProfiling`, `TilingM2aStreaming`, `TilingM2bLifecycleValidation`, `FoliageLodOptimization`, `TileConsolidation`, `RegionalMosaicIdentityAndZoomPolicy`).
- Synthetic 7-variant Playwright benchmark verification (`benchmarks/hierarchicalStreamingRunner.ts`) across continuous elapsed-time simultaneous pan+zoom scenarios (`simultaneous_pan_zoom_cold`, `simultaneous_pan_zoom_warm`, `rapid_zoom_reversal_pan`, `repeated_resolution_transitions_pan`) with independent frame-time and transition-latency reporting.
- `npm run docs:api`, `npm run lint`, and `npm run build` pass cleanly.

### Open Acceptance Gates (Owner Local Hardware & Visual QA)
- Execute `benchmarks/hierarchicalStreamingRunner.ts` on the owner's RTX 4060 Ti against `data/osm/twente-full-hierarchical.json` across the 7 F1 variants, frame-budget sweep (`1.0 / 2.0 / 4.0 ms`), and debounce sweep (`100 / 150 / 250 ms`).
- Confirm interactive panning + zooming fluidity (`p95`, `p99`, `max`, `% > 6.94 / 8.33 / 16.67 / 33.33 ms`, longest slow-frame streak) and Section 12 `1,024 m -> 2,048 m -> 4,096 m` transition latency (`p50`, `p95`, `max`, critical-path stage breakdown) on full Twente.
- Owner interactive visual acceptance confirming zero missing/duplicate tiles, zero flash/pop regression, and responsive feature picking during continuous pan+zoom transitions.
