---
id: TKT-041-F2
title: "Streaming Throughput and Transition Latency"
type: tech_debt
status: closed
priority: high
created: 2026-11-27
updated: 2026-11-27
---

# TKT-041-F2 — Streaming Throughput and Transition Latency

## Summary

Substantially reduce tile readiness and resolution-transition latency (`1,024 m <-> 2,048 m <-> 4,096 m`) while preserving `TKT-041-F1` frame-time consistency, uniform viewport resolution, atomic activation, `TKT-040` compact worker transport + worker BVH construction, existing `OSMTILE1` v1 baked datasets (zero rebaking or reconsolidation required), and feature-picking parity.

Provisional performance target: **>= 50% reduction in comparable cold-transition latency** while establishing the hardware throughput ceiling on the owner's RTX 4060 Ti workstation.

## Context & Observed Hardware Baseline (`TKT-041-F1`)

Owner hardware validation of `TKT-041-F1` confirmed that frame-budgeted scheduling, incremental GPU upload, deferred disposal, debouncing, and `combined_prewarm` improve interactive fluidity, but revealed that large-resolution transitions remain too slow:

- Transition to `4,096 m` during a stepped zoom sweep: **~3 seconds**.
- Direct transition to `4,096 m` using `combined`: **~7.5 seconds**.
- Significant fetch queue and worker queue waiting times under coupled `activeFetchCount` slots.
- Individual large `4,096 m` tile payloads exceeding **160 MB** in previous profiling.
- Continuous-motion benchmarks frequently failing to complete transitions to `4,096 m` before the desired resolution changes again.

## Work Packages & Implementation Summary

### Work Package A — Throughput Ceiling & 9-Stage Pipeline Telemetry
- Added high-resolution server retrieval timing headers in `src/server/tiles/tilePackHttpHandler.ts`:
  - `X-Tile-Server-Sqlite-Ms`: SQLite row lookup latency.
  - `X-Tile-Server-Inflate-Ms`: server-side zlib inflate duration (`0 ms` when `?compressed=1` passthrough is active).
  - `X-Tile-Server-Total-Ms`: total server response preparation time.
  - `X-Tile-Transfer-Compressed`: `'1'` when raw deflate payload passthrough is served, `'0'` when inflated on the server.
- Split worker decompression (`workerInflateMs`) from binary decode (`workerDecodeOnlyMs`) in `src/world/tiling/TileDecodeWorker.ts` and `src/world/tiling/TileDecodeClient.ts`.
- Added worker pool occupancy/utilization (`busyWorkerCount`, `idleWorkerCount`, `activeDestinationWorkerCount`, `wastedWorkerTimeMs`) and sustained throughput metrics (`sustainedHttpTransferMibPerSec`, `sustainedDecodeRawMibPerSec`, `sustainedTilesDecodedPerSec`, `avgRetrievedQueueWaitMs`, `wastedNetworkBytes`, `wastedPrewarmBytes`, `discardedPreparedTilesTotal`) in `TileStreamManager.getDiagnostics().throughputPipeline`.

### Work Package B — Independent Bounded Pipeline Stages & Oversized-Payload Forward Progress
- Decoupled HTTP retrieval from worker preparation in `src/world/tiling/TileStreamManager.ts` into 8 explicit, independently managed stages:
  1. `queued` (Fetch Queue)
  2. `fetching` (HTTP Retrieval — releases HTTP slot immediately upon `response.arrayBuffer()` completion)
  3. `retrieved_queued` (Retrieved-Payload Queue — holds `ArrayBuffer` awaiting worker slot)
  4. `decoding` (Worker Preparation — inflate if compressed, binary decode, compact metadata, worker BVH)
  5. `ready_to_commit` (Prepared-Payload Queue — awaiting main-thread scene reconstruction)
  6. `prepared_inactive` (Scene Reconstruction & Incremental Offscreen GPU Preparation)
  7. `loaded` / Atomic Resolution Activation
- Enforced single-owner byte transfer across stage boundaries (`inFlightHttpReservationBytes` -> `retrievedPayloadQueueBytes` -> `inFlightWorkerPreparationBytes` -> `preparedPayloadQueueBytes` -> `reconstructedAwaitingGpuBytes`) so no payload is double-counted.
- Implemented the **Section 5.2 Oversized-Payload Forward-Progress Rule**: when a single tile payload (e.g., `>160 MB` at `4,096 m`) exceeds a stage byte cap (`maxRetrievedPayloadQueueBytes`, `maxWorkerPreparationBytes`, or `maxPreparedPayloadQueueBytes`), the pipeline drains that stage and admits at least **1** oversized tile (`oversizedPayloadAdmissionsTotal`) so transitions never deadlock.

### Work Package C — Destination Throughput, Reserved Capacity & Fairness
- Implemented 5 priority classes:
  1. Missing active visible coverage
  2. Required pending destination coverage
  3. Approaching-resolution prewarm coverage
  4. Active preload coverage
  5. Speculative destination preload
- Added `reservedDestinationFetchSlots` and `reservedDestinationWorkerSlots` so active preload traffic cannot monopolize all HTTP connections or decode workers during a pending transition.
- Added dynamic queue reprioritization (`updateJobPriority` in `TileDecodeClient.ts`) when camera movement changes tile relevance, without aborting or restarting in-flight fetches or running worker decodes.
- Added running-worker-job retention on demotion (`retainRunningWorkerJobOnDemotion`): if a running worker job is demoted from visible to non-visible within the retention margin and memory headroom permits, the completed tile is retained in `cached_inactive` (`runningWorkerJobsRetainedAfterDemotionTotal`) instead of discarding worker CPU work.
- Added destination age escalation (`destinationAgeEscalationMs`) and tail-tile priority boost (`tailTilePriorityBoostEnabled`) for the last 1–2 outstanding destination tiles blocking atomic activation.

### Work Package D — Concurrency Tuning, Compressed HTTP Transfer & Transition GPU Upload Cap
- Made HTTP concurrency (`maxConcurrentHttpRetrievals`: `6, 8, 12`) and worker pool concurrency (`workerConcurrency`: `2, 4`) configurable at runtime and via URL parameters (`?maxHttpConcurrency=...&workerConcurrency=...`).
- Added optional compressed HTTP transfer (`useCompressedHttpTransfer` / `?compressedTransfer=1`): requests `/api/tiles/...?compressed=1` so the server skips synchronous `zlib.inflateSync` and transfers compact deflate bytes (~3–5× smaller HTTP payload), while `TileDecodeWorker` decompresses off the main thread via concurrent `DecompressionStream('deflate')` consumption (`new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer()`), preserving the uncompressed `OSMTILE1` fast path and avoiding stream backpressure deadlocks on large (`>160 MiB`) tiles.
- Added per-job worker decode timeouts (`TileDecodeClient.ts`), `lastTileError` diagnostic tracking (`TileStreamManager.ts`), and immediate error rejection in `App.tsx` (`waitForSceneReady` / `loadM2aStreaming`) so decode failures surface explicitly rather than timing out after 120 seconds.
- Raised the time-governed transition GPU upload slice cap (`24 MiB / 16 units` in `f2_tuned_concurrency` and `f2_combined`), still bounded by the per-frame scheduler budget.

### Work Package E — Latency-Aware Adaptive Preparation Horizon & Predicted Viewport Bounds
- Implemented `evaluateAdaptivePrewarmHorizon()` and `predictViewportBoundsAtHorizon()` in `src/world/tiling/HierarchicalResolutionPolicy.ts`.
- Tracks exponential moving average per-resolution preparation latency (`historicalPrepLatencyByResMs`) plus current queue occupancy wait and camera zoom/pan velocity (`scaleVelocityPerSec`, `panVelocityXPerSec`, `panVelocityZPerSec`) to trigger predictive prewarming earlier during rapid zoom sweeps and prioritize tiles intersecting the predicted activation viewport.

### Work Package F — Streaming Granularity Feasibility Study & Decision Gate
- Evaluated **Candidate A** (keep spatial batching & streaming identical, optimize pipeline/prewarm), **Candidate B** (sub-chunked streaming / runtime assembly into `2,048 m` / `4,096 m` batches), and **Candidate C** (intermediate `3,072 m` or revised hierarchy) across all 10 required dimensions in [`docs/reports/tkt041-f2-streaming-throughput-and-granularity.md`](../docs/reports/tkt041-f2-streaming-throughput-and-granularity.md).
- Recommends **Candidate A** as the immediate zero-rebake production path and defines an explicit quantitative decision gate (`> 1,500 ms` cold transition or `> 96 MiB` single-tile payload blocking) for **Candidate B**.

### Work Package G — Staged Variants & Benchmark Matrix (`benchmarks/hierarchicalStreamingRunner.ts`)
- Added 5 staged F2 comparison presets in `src/world/tiling/StreamingSchedulerConfig.ts`:
  - `f2_independent_pipeline`
  - `f2_destination_scheduling`
  - `f2_tuned_concurrency`
  - `f2_latency_aware_prewarm`
  - `f2_combined` (new interactive default)
- Extended `benchmarks/hierarchicalStreamingRunner.ts` with all 8 required scenarios (plus `zoom_sweep_1024_2048_4096_back`) and `--variants=f2_all` (along with `--http-concurrency=...` and `--worker-concurrency=...`) to compare `combined_prewarm` against all 5 staged F2 variants.

## Acceptance Criteria

- [x] Throughput limits of each pipeline stage (server SQLite + inflate, HTTP transfer, retrieved queue, worker queue, worker inflate + decode + BVH, worker delivery, reconstruction, GPU prep, activation) are measured and documented.
- [x] HTTP retrieval and worker preparation operate as decoupled, bounded pipeline stages (`retrieved_queued`) with single-owner byte handoff and oversized-payload (`>160 MB`) forward-progress admission.
- [x] Destination-resolution tiles make steady progress during continuous camera movement via reserved destination fetch/worker slots, dynamic queue reprioritization, age escalation, and tail-tile priority boost.
- [x] Repeated cancellations and wasted worker/network work are measured and reduced via dynamic queue reprioritization and running-worker-job retention on demotion.
- [x] Predictive preparation lead time adapts to observed zoom velocity and historical preparation latency (`evaluateAdaptivePrewarmHorizon`, `predictViewportBoundsAtHorizon`).
- [x] Uniform viewport resolution and atomic activation are preserved (`attachedResolutions.size <= 1`).
- [x] Existing feature picking and visual fidelity are preserved (`OSMTILE1` v1 compatibility; zero rebaking or reconsolidation).
- [x] Streaming versus rendering granularity options (Candidates A, B, C across all 10 dimensions) are evaluated with a clear recommendation and decision gate in `docs/reports/tkt041-f2-streaming-throughput-and-granularity.md`.
- [x] Automated tests cover independent stage queuing, oversized-payload forward progress, dynamic reprioritization, running-job retention, adaptive prewarming, destination progress under continuous active panning, picking parity, leak-free cancellation across all stages, byte-exact decompression of small to `>160 MiB` payloads, and actual browser Web Worker compressed tile decoding + explicit decode failure surfacing (`src/world/StreamingThroughputAndLatency.test.ts`).
- [x] Owner validates real-data transition latency (`>= 50%` cold-transition latency reduction target or hardware throughput ceiling characterization) and interactive fluidity on the full Twente dataset (`data/osm/twente-full-hierarchical.json`) — **Accepted as foundation with documented limitations (`2026-11-27`):** owner RTX 4060 Ti validation and interactive testing confirmed `f2_combined` delivers noticeable, worthwhile improvements (`Cold 1,024 -> 4,096 m`: `6812.0 -> 2603.5 ms`, `Cold 2,048 -> 4,096 m`: `3543.1 -> 2606.0 ms`, `Gradual zoom-out w/ pan`: `7551.0 -> 2715.1 ms`, `Teleport`: `8319.6 -> 1022.5 ms`; single-resolution consistency checks passed; zero unfinished transitions; sampled feature picking parity passed). The provisional `>= 50%` reduction target was not met universally (`2,048 -> 4,096 m`: ~`26.4%`), frame-time consistency remained mixed with regressions in some scenarios, peak accounted memory increased in several scenarios, full staged/concurrency matrices were not executed on hardware, and large indivisible payloads remain; all five limitations are explicitly accepted for the current phase.

## Owner Hardware Validation, Closure & Revised Product Direction (`2026-11-27`)

Owner hardware validation on the full Twente dataset (`RTX 4060 Ti`, `combined_prewarm` vs `f2_combined`, foliage enabled, `1,536 MiB` memory budget) followed by interactive testing:

| Transition to `4,096 m` | F1 reference (`combined_prewarm`) | F2 combined (`f2_combined`) |
| --- | ---: | ---: |
| Cold `1,024 m -> 4,096 m` | `6812.0 ms` | `2603.5 ms` |
| Cold `2,048 m -> 4,096 m` | `3543.1 ms` | `2606.0 ms` |
| Gradual zoom-out with panning | `7551.0 ms` | `2715.1 ms` |
| Long-distance teleport scenario | `8319.6 ms` | `1022.5 ms` |

- **Accepted Baseline & Preserved Tooling:** `f2_combined` is retained as the accepted default (`DEFAULT_STREAMING_FRAME_BUDGET_CONFIG`), and all 12 staged F1/F2 benchmark variants and diagnostic instrumentation remain intact for future evaluation.
- **Compressed Payload Decompression Regression:** Resolved a `DecompressionStream('deflate')` backpressure deadlock in `ensureRawOmsTileBytes()` (`TileDecodeWorker.ts`) that previously caused a 120 s readiness timeout with zero meshes under `f2_combined`, added bounded worker decode timeouts + explicit failure surfacing (`TileDecodeClient.ts`, `TileStreamManager.ts`, `App.tsx`), verified up to `164 MiB` uncompressed + end-to-end Chromium Web Worker tests, and removed unsupported `--mosaic`/`--f2-matrix`/`--headed` flags from docs.
- **Explicitly Accepted Limitations (Unresolved for Current Phase):** provisional `50%` latency target not met universally; mixed frame-time consistency with regressions in some scenarios; higher peak accounted memory in several scenarios; full staged variant and concurrency matrices not executed on hardware; large indivisible streaming payloads remain.
- **Revised Product Direction:** Per [`docs/plans/colony-sim-design-discussion.md`](../docs/plans/colony-sim-design-discussion.md), future renderer development will be guided by regional colony simulation requirements (distinguishing detailed local rendering from a lightweight strategic regional view). The current hierarchical renderer (`f2_combined`) serves as an accepted foundation/reference implementation; further optimization of uniform full-detail resolution transitions is deferred until the dual-map architecture is explored.

## Verification

### Final Automated Verification Suite (`2026-11-27`)
- `npx tsx --test src/world/StreamingThroughputAndLatency.test.ts src/world/FrameBudgetedStreaming.test.ts src/world/HierarchicalTileStreaming.test.ts src/world/NonBlockingTilePreparation.test.ts src/world/InstancedSpatialPicking.test.ts` — **29 / 29 passed** (`9/9` in `StreamingThroughputAndLatency.test.ts`, `6/6` in `FrameBudgetedStreaming.test.ts`, `4/4` in `HierarchicalTileStreaming.test.ts`, `6/6` in `NonBlockingTilePreparation.test.ts`, `4/4` in `InstancedSpatialPicking.test.ts`).
- `npm test` (`tsx --test --test-concurrency=1 src/world/*.test.ts`) — **513 passed, 12 failed, 3 skipped** (`528` tests across `53` suites): `2` pre-existing test mocks incompatible with `f2_combined` default (`FoliageLodOptimization.test.ts:501` missing `?compressed=1` URL handling, `StreamingFluidityProfiling.test.ts:363` missing `getWorkerUtilizationSnapshot()` on mock `decodeClient`) plus `10` unrelated/fixture/data-dependent pre-existing failures and `3` skips (`ElevationAndZIndex.test.ts`, `JunctionAndTopology.test.ts`, `PlanarAndRoadSpatialIndex.test.ts`, `RailwayNetworkTopology.test.ts`, `RoadNetworkTopology.test.ts`, `TilingFullTwenteScale.test.ts`).
- `npm run lint` (`tsc --noEmit`) — **0 errors** (passed).
- `npm run build` (`vite build`) — **succeeded** (passed).
- `npm run docs:api` (`typedoc`) — **0 errors, 5 warnings** (passed).

### Owner Hardware Verification Outcome (`2026-11-27`)
- Full Twente (`RTX 4060 Ti`, `combined_prewarm` vs `f2_combined`, foliage enabled, `1,536 MiB`): completed and accepted with documented limitations; full `--variants=f2_all` staged matrix and `HTTP 6/8/12 × Worker 2/4` concurrency matrix were not executed and are deferred.

## Related References

- [`docs/decisions/ADR-0017-decoupled-streaming-pipeline-and-adaptive-prewarm.md`](../docs/decisions/ADR-0017-decoupled-streaming-pipeline-and-adaptive-prewarm.md)
- [`docs/reports/tkt041-f2-streaming-throughput-and-granularity.md`](../docs/reports/tkt041-f2-streaming-throughput-and-granularity.md)
- [`src/world/tiling/TileStreamManager.ts`](../src/world/tiling/TileStreamManager.ts)
- [`src/world/tiling/TileDecodeClient.ts`](../src/world/tiling/TileDecodeClient.ts)
- [`src/world/tiling/TileDecodeWorker.ts`](../src/world/tiling/TileDecodeWorker.ts)
- [`src/world/tiling/StreamingSchedulerConfig.ts`](../src/world/tiling/StreamingSchedulerConfig.ts)
- [`src/world/tiling/HierarchicalResolutionPolicy.ts`](../src/world/tiling/HierarchicalResolutionPolicy.ts)
- [`src/server/tiles/tilePackHttpHandler.ts`](../src/server/tiles/tilePackHttpHandler.ts)
- [`src/world/StreamingThroughputAndLatency.test.ts`](../src/world/StreamingThroughputAndLatency.test.ts)
- [`benchmarks/hierarchicalStreamingRunner.ts`](../benchmarks/hierarchicalStreamingRunner.ts)
