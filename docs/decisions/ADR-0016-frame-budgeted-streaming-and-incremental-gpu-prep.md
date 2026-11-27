# ADR-0016: Frame-Budgeted Streaming, Offscreen Incremental GPU Preparation, Deferred Disposal, and Transition Critical-Path Prioritization

- **Status:** Implemented and extended by [`ADR-0017`](ADR-0017-decoupled-streaming-pipeline-and-adaptive-prewarm.md) (`TKT-041-F2`, closed 2026-11-27); `combined_prewarm` validated on owner RTX 4060 Ti as F1 reference (`f2_combined` is now default foundation). [`TKT-041-F1`](../../tickets/TKT-041-F1-frame-budgeted-streaming.md) remains `in_progress` with dedicated budget/debounce sweeps and further uniform full-detail tuning deferred.
- **Date:** 2026-11-26
- **Related Tickets:** [`TKT-041`](../../tickets/TKT-041-hierarchical-tile-streaming.md), [`TKT-041-F1`](../../tickets/TKT-041-F1-frame-budgeted-streaming.md), [`TKT-040`](../../tickets/TKT-040-non-blocking-tile-preparation-and-worker-transfer.md), [`TKT-039`](../../tickets/TKT-039-camera-movement-and-streaming-frame-time-profiling.md)
- **Qualifies / Extends:** [`ADR-0006`](ADR-0006-gpu-resource-lifecycle-and-disposal.md), [`ADR-0011`](ADR-0011-baked-tiles-and-runtime-streaming.md), [`ADR-0015`](ADR-0015-hierarchical-tile-streaming.md)

---

## 1. Context and Problem Statement

`ADR-0015` (`TKT-041`) introduced uniform-viewport hierarchical tile streaming across `1,024 m`, `2,048 m`, and `4,096 m` `OSMTILE1` mosaics using off-scene worker preparation (`TKT-040` `combined`) and atomic frame-boundary resolution swaps.

Owner hardware validation on an NVIDIA RTX 4060 Ti demonstrated two remaining runtime challenges during continuous simultaneous panning and zooming:

1. **Main-thread and first-render frame spikes during active transitions:**
   - Even with worker-side `InstancedSpatialIndex` BVH construction and compact zero-copy buffer adoption (`TKT-040`), reconstructing multiple consolidated tiles, uploading all new destination vertex/index/instance buffers on the first rendered frame after atomic swap, rebuilding composite statistics and internal boundary wireframes, and synchronously calling `BufferGeometry.dispose()` on all outgoing active or evicted cache tiles could coincide in a single frame and exceed `16.67 ms` or `33.33 ms`.
   - Raising the desktop CPU memory budget from `768 MiB` to `1,536 MiB` eliminated `deferred_budget` transition stalls on full Twente, but did not eliminate multi-operation frame accumulation.
2. **Prolonged pending states when transitioning to `4,096 m` tiles (`TKT-041-F1` Section 12):**
   - During continuous panning while zooming out into the `4,096 m` band, pending transitions could remain in `preparing` for an extended period.
   - Root-cause analysis identified four interacting factors:
     - **Fetch & worker queue contention:** Non-visible active-resolution preload tiles (`1,024 m` or `2,048 m` ring preloads triggered by continuous panning) competed for the same 6 concurrent HTTP fetch slots and worker decode pool as required visible destination (`4,096 m`) tiles.
     - **FIFO worker dispatch:** `TileDecodeClient` previously dispatched queued worker decode jobs in FIFO arrival order rather than viewport/destination priority order.
     - **Moving-target destination coverage during continuous pan:** As the viewport pan crossed a `4,096 m` tile boundary while earlier `4,096 m` tiles were finishing preparation, newly uncovered `4,096 m` tiles entered the required visible set late (`tailTileEnteredLateMs` / `remainingCoverageWaitMs`).
     - **Rate-limiting vs. transition latency trade-off:** Naively throttling destination preparation to smooth frame times can starve pending transitions during continuous camera motion unless destination visible coverage is explicitly prioritized ahead of speculative active preload and optionally pre-warmed when approaching a zoom threshold.

---

## 2. Decision

We extend the `ADR-0015` uniform-viewport hierarchical streaming architecture with five coordinated mechanisms while preserving atomic resolution activation, `OSMTILE1` v1 payload compatibility, and canonical feature picking parity:

### 2.1 Provisional `1,536 MiB` Desktop CPU Budget Default

- `DEFAULT_HIERARCHICAL_RESOURCE_BUDGET` (`src/world/tiling/HierarchicalResourceBudget.ts`) raises `totalMemoryBudgetBytes` from `768 MiB` to `1,536 MiB` (`inactiveCacheBudgetBytes: 384 MiB`, `maxPendingDecodedBytes: 256 MiB`) so full-Twente `1,024 m <-> 2,048 m <-> 4,096 m` dual-coverage transitions do not prematurely enter `deferred_budget`, while retaining explicit runtime/CLI overrides (`?hierarchicalBudgetMb=...`, `--budget-mb=...`).
- Pending deferred-disposal memory (`pendingDisposalBytes`) is tracked explicitly inside `HierarchicalMemoryAccounting` and included in `totalMeasuredCpuBytes` so deferred geometry teardown never masks true CPU memory consumption.

### 2.2 Shared Priority-Ordered Frame Workload Scheduler (`StreamingWorkloadScheduler.ts`)

- `TileStreamManager.tick()` schedules main-thread streaming work under a shared per-frame time budget (`schedulerFrameBudgetMs`, default `2.0 ms`) across five strict priority classes:
  1. `active_visible_coverage` — reconstructing and attaching active-resolution visible tiles when the active viewport has a coverage gap (`hasActiveVisibleCoverageGap()`). A starvation-escape rule guarantees at least 1 critical active-visible unit executes per frame even if the frame budget is tight.
  2. `pending_transition_prepare` — reconstructing (`prepared_inactive`) and incrementally GPU-uploading required visible destination tiles for a pending resolution transition.
  3. `resolution_activation` — executing the atomic frame-boundary scene swap once all required visible destination tiles are reconstructed and GPU-prepared.
  4. `active_preload` — reconstructing active-resolution non-visible preload tiles and predictive pre-warm tiles.
  5. `deferred_disposal` — draining a bounded slice of `DeferredDisposalQueue`.
- When an indivisible work unit (such as reconstructing a single large `4,096 m` tile or executing the atomic resolution swap) exceeds the remaining frame budget, `StreamingWorkloadScheduler` records `overrunMs` and `indivisibleOverrunCount` transparently rather than hiding the cost.

### 2.3 Offscreen 1×1 Render-Target Incremental GPU Preparation (`IncrementalGpuPreparer.ts`)

- To prevent WebGL driver buffer creation and upload from spiking the first rendered frame after a resolution swap, destination tiles (`prepared_inactive`) and newly reconstructed active tiles are decomposed into per-mesh and per-`InstancedMesh` upload units (`GpuPrepUnit`).
- `ThreeWebGLOffscreenUploadAdapter` uses only supported public Three.js APIs (verified on Three.js `0.186.1`):
  - Maintains a dedicated 1×1 `THREE.WebGLRenderTarget` (no depth/stencil buffer) and a minimal `stagingScene` tagged with `userData[GPU_PREP_STAGING_SCENE_FLAG] = true` plus a dedicated `THREE.OrthographicCamera`.
  - For each slice (`maxGpuUploadUnitsPerFrame`, default `8` units; `maxGpuUploadBytesPerFrame`, default `8 MiB`), temporarily moves the mesh to `stagingScene` with identity transform and `frustumCulled = false`, disables color/depth/stencil writes on the WebGL context, invokes `renderer.render(stagingScene, stagingCamera)`, and restores the mesh's original parent, transform, and renderer state/counters.
  - This forces Three.js's `WebGLAttributes` and `WebGLGeometries` to allocate and upload VBOs, IBOs, and `InstancedBufferAttribute` matrices across multiple preparation frames **before** the destination resolution is attached to the visible `compositeScene`.
- **Honest CPU vs. GPU attribution:** `gpuUploadSubmitMs` measures synchronous CPU driver submission time (`gl.bufferData` / `gl.bufferSubData` via `renderer.render`), not asynchronous GPU DMA completion. `MapScene.tsx` bypasses main-pass profiler and GPU timer-query hooks whenever `scene.userData[GPU_PREP_STAGING_SCENE_FLAG]` is set.
- WebGL context-loss/restore events increment a context epoch so prepared markers are invalidated on context loss and cleanly re-uploaded after restoration.

### 2.4 Bounded Deferred Disposal Queue (`DeferredDisposalQueue.ts`)

- Qualifying `ADR-0006` for runtime tile eviction and resolution demotion: scene-graph detachment (`detachTileFromCompositeScene`) remains synchronous and immediate on the frame of eviction/transition so zero duplicate geometry or stale picking targets remain in the scene, while `ReconstructedTileSceneResult.dispose()` (`BufferGeometry.dispose()` and BVH release) is enqueued into `DeferredDisposalQueue`.
- The queue drains incrementally during Priority 5 of `TileStreamManager.tick()` (`maxDeferredDisposeTilesPerFrame = 2`, `maxDeferredDisposeGeometriesPerFrame = 24`) and enforces a hard `maxPendingDisposalBytes` (`256 MiB`) ceiling via synchronous emergency draining (`drainToTargetBytes`) whenever memory backpressure or `manager.dispose()` requires immediate reclamation.
- Shared materials (`TileMaterialRegistry`) and shared foliage prototypes (`FoliagePrototypeRegistry`) remain protected from per-tile disposal.

### 2.5 Transition Debounce, Destination Prioritization, Critical-Path Attribution, and Predictive Pre-Warming (Section 12)

- **Time-based transition debouncing (`transitionDebounceMs = 150 ms`):** Automatic zoom-band crossings enter a short `debouncing` state before allocating destination fetch/worker workloads. Elapsed debounce time advances during continuous camera motion (never requiring camera movement to pause). If zoom returns to the active band before the debounce window expires, the transition is avoided (`transitionsDebouncedAvoided`).
- **Destination prioritization over active preload (`prioritizeDestinationOverActivePreload`):** While a resolution transition is pending and active visible coverage has no gaps, `pumpFetchQueue()` suppresses non-visible active-resolution preload fetches so required visible destination tiles (`4,096 m`) claim available HTTP fetch slots immediately, and `TileDecodeClient` dispatches worker decode jobs in priority order (`priorityScore`) rather than FIFO order.
- **Complete 7-stage critical-path instrumentation (`TransitionCriticalPathRecord`, `TransitionBlockerSnapshot`):** Every tile records `fetchQueueWaitMs`, `payloadRetrievalMs`, `workerQueueWaitMs`, `workerDecodeAndBvhMs`, `mainThreadReconstructWaitMs`, `reconstructMs`, `gpuPrepWaitMs`, `gpuPrepSubmitMs`, plus transition-level `remainingCoverageWaitMs` and `tailTileEnteredLateMs`. `DiagnosticsPanel` and the benchmark runner expose the live `currentTransitionBlocker`, `slowestOutstandingTile`, and completed/cancelled/deferred transition critical-path history independently from frame-time distributions.
- **Optional trend-aware predictive pre-warming (`combined_prewarm`):** When `predictivePrewarmEnabled` is enabled and camera zoom moves toward an adjacent threshold within `25%` of the hysteresis band under `< 75%` memory budget utilization and full active visible coverage, visible tiles of the approaching resolution are prepared off-scene (`prepared_inactive`) ahead of threshold crossing and reused on transition (`prewarmReusedOnTransition`).

---

## 3. Consequences

### Benefits
- Spreads destination GPU buffer uploads and outgoing tile geometry disposal across frames while keeping uniform-viewport atomic activation intact.
- Eliminates fetch-slot and worker-queue starvation of `4,096 m` destination tiles by non-visible active preload tiles during continuous panning + zooming.
- Provides exact, non-overlapping per-frame (`streamTickMs`, `gpuUploadSubmitMs`, `resolutionActivationMs`, `boundaryOverlayRebuildMs`, `deferredDisposeMs`) and per-transition critical-path attribution so frame-time smoothness and transition latency are evaluated independently.

### Trade-offs and Boundaries
- Offscreen 1×1 render-target preparation triggers WebGL attribute buffer uploads and shader program binding via public Three.js APIs; while `colorMask(false, false, false, false)` makes rasterization a 1-pixel no-op, driver submission still incurs small bounded CPU slices (`gpuUploadSubmitMs`) across preparation frames.
- Individual consolidated `4,096 m` tile reconstruction remains an atomic synchronous call (`reconstructTileScene`); if a single tile's reconstruction exceeds `schedulerFrameBudgetMs`, it is recorded as an `indivisibleOverrunCount` rather than split mid-tile.
- Real-data frame-time percentiles and transition latencies on full Twente (`data/osm/twente-full-hierarchical.json`) must be validated on the owner's RTX 4060 Ti before closing `TKT-041` or `TKT-041-F1`.
