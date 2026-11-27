# TKT-041-F2 — Streaming Throughput, Transition Latency, and Streaming Granularity Feasibility Report

- **Date:** 2026-11-27
- **Ticket:** [`TKT-041-F2`](../../tickets/TKT-041-F2-streaming-throughput-and-transition-latency.md) (`in_progress` pending owner RTX 4060 Ti hardware validation)
- **ADR:** [`ADR-0017`](../decisions/ADR-0017-decoupled-streaming-pipeline-and-adaptive-prewarm.md)
- **Related Reports:** [`tkt041-hierarchical-tile-streaming.md`](tkt041-hierarchical-tile-streaming.md), [`tkt041-f1-frame-budgeted-streaming.md`](tkt041-f1-frame-budgeted-streaming.md), [`tkt040-non-blocking-tile-preparation.md`](tkt040-non-blocking-tile-preparation.md)

---

## 1. Executive Summary & Problem Statement

Owner hardware validation of `TKT-041-F1` on the full Twente dataset (`data/osm/twente-full-hierarchical.json`, RTX 4060 Ti) confirmed that frame-budgeted scheduling (`StreamingWorkloadScheduler`), offscreen 1×1 incremental GPU preparation (`IncrementalGpuPreparer`), deferred geometry disposal (`DeferredDisposalQueue`), transition debouncing, and `combined_prewarm` substantially improved interactive frame pacing, but revealed a remaining streaming throughput and transition-latency bottleneck:

- **Stepped zoom sweep transition to `4,096 m`:** ~**3.0 seconds**.
- **Direct transition to `4,096 m` (`combined`):** ~**7.5 seconds**.
- **Continuous pan + zoom sweeps:** frequently failed to complete transitions to `4,096 m` before the desired resolution changed again.
- **Root bottlenecks identified in `TKT-041-F1` critical-path telemetry:**
  1. **Coupled HTTP-and-Worker Slots (`activeFetchCount`):** HTTP retrieval slots were held until worker decode and BVH construction finished, starving network retrieval whenever large `2,048 m` or `4,096 m` tiles occupied the worker pool.
  2. **Synchronous Server-Side `zlib.inflateSync` & Uncompressed HTTP Payloads:** The Node/Express tile endpoint inflated every tile synchronously on the server thread before transferring raw uncompressed `OSMTILE1` bytes (`3–5×` larger over HTTP, with individual `4,096 m` tiles exceeding `160 MB` raw).
  3. **Active-Preload Contention & Worker Starvation:** Active-resolution preload tiles competed with required visible destination tiles for HTTP and worker capacity during simultaneous pan + zoom.
  4. **Static Prewarming Lead Time:** A static hysteresis band fraction (`0.25`) began prewarming too late during rapid zoom-out sweeps toward `4,096 m`.

`TKT-041-F2` addresses these bottlenecks without rebaking or reconsolidating any existing `OSMTILE1` v1 SQLite packs, targeting a **provisional >= 50% reduction in comparable cold-transition latency** while preserving `TKT-041-F1` frame-time consistency and establishing the hardware throughput ceiling.

---

## 2. Work Package A — Nine-Stage Throughput Ceiling Instrumentation

To separate genuine processing limits from artificial queueing/serialization delays, `TKT-041-F2` instruments all 9 stages of the tile preparation critical path independently and under concurrency:

| Stage | Instrumentation Location | Exported / Diagnostic Metrics |
| --- | --- | --- |
| **1. Server retrieval** | `src/server/tiles/tilePackHttpHandler.ts` | `X-Tile-Server-Sqlite-Ms` (SQLite lookup), `X-Tile-Server-Inflate-Ms` (zlib inflate if uncompressed transfer), `X-Tile-Server-Total-Ms`, `X-Tile-Transfer-Compressed` (`'1'` or `'0'`), aggregated as `avgServerSqliteLookupMs`, `avgServerInflateMs`, `avgServerTotalMs` |
| **2. HTTP transfer** | `TileStreamManager.startHttpRetrievalOnly` | `totalNetworkTransferBytes`, `payloadRetrievalMs`, `sustainedHttpTransferMibPerSec`, `inFlightHttpReservationBytes`, `httpRetrievingCount` |
| **3. Browser retrieval & Retrieved Queue** | `TileStreamManager` (`retrieved_queued`) | `retrievedQueuedCount`, `retrievedPayloadQueueBytes`, `retrievedQueueWaitMs`, `avgRetrievedQueueWaitMs` |
| **4. Worker queue** | `TileDecodeClient.ts` | `workerClientQueueWaitMs`, `workerThreadQueueWaitMs`, `busyWorkerCount`, `idleWorkerCount`, `queuedDecodeCount`, `activeDestinationWorkerCount` |
| **5. Worker preparation** | `TileDecodeWorker.ts` (`prepareTileInWorker`) | `workerInflateMs` (`DecompressionStream('deflate')`), `workerDecodeOnlyMs` (`decodeTileBinaryCompact`), `workerBvhBuildMs` (`buildInstancedSpatialIndexData`), `workerPayloadPrepMs`, `sustainedDecodeRawMibPerSec`, `sustainedTilesDecodedPerSec` |
| **6. Worker delivery** | `TileDecodeWorker.ts` -> `TileDecodeClient.ts` | `messageDeliveryLatencyMs`, `mainOnMessageHandlerMs`, `mainPromiseContinuationMs`, `transferableBufferCount`, `transferableBytes` |
| **7. Scene reconstruction** | `TileStreamManager.commitSingleReadyTile` | `preparedQueuedCount`, `preparedPayloadQueueBytes`, `mainThreadReconstructWaitMs`, `reconstructMs` |
| **8. GPU preparation** | `IncrementalGpuPreparer.ts` | `reconstructedAwaitingGpuBytes`, `gpuPrepWaitMs`, `gpuPrepSubmitMs`, `gpuPrepSliceCount`, `uploadedEstimatedBytes` |
| **9. Atomic activation** | `TileStreamManager.activatePendingResolutionAtomic` | `remainingCoverageWaitMs`, `tailTileEnteredLateMs`, `activationSwapMs`, `desiredToActivationMs`, `prewarmLeadTimeMs` |

Additionally, wasted work from camera reversals and demotions is explicitly tracked:
- `wastedNetworkBytes`: bytes downloaded for tiles cancelled before worker completion.
- `wastedWorkerTimeMs`: worker decode CPU milliseconds spent on tiles aborted or discarded.
- `wastedPrewarmBytes` & `discardedPreparedTilesTotal`: prewarmed/prepared off-scene tiles evicted before activation.
- `runningWorkerJobsRetainedAfterDemotionTotal`: running worker jobs salvaged into `cached_inactive` on demotion.

---

## 3. Work Packages B, C, D & E — Pipeline Architecture & Staged Improvements

### 3.1 Work Package B — Decoupled 8-Stage Pipeline & Oversized-Payload Forward Progress (`f2_independent_pipeline`)

- **Immediate HTTP Slot Release:** `startHttpRetrievalOnly` releases its HTTP concurrency slot (`activeFetchCount`) and byte reservation (`inFlightHttpReservationBytes`) immediately after `await response.arrayBuffer()`, placing the binary payload into `retrieved_queued` (`retrievedPayloadQueueBytes`) and immediately pumping the next queued HTTP fetch.
- **Single-Owner Byte Handoff:** Each payload's byte footprint is owned by exactly one stage at a time (`inFlightHttpReservationBytes` -> `retrievedPayloadQueueBytes` -> `inFlightWorkerPreparationBytes` -> `preparedPayloadQueueBytes` -> `reconstructedAwaitingGpuBytes`), eliminating double-counting stalls during transitions.
- **Oversized-Payload Forward-Progress Rule (Section 5.2):** Because individual `4,096 m` tiles can exceed `160 MB`, any stage byte cap (`maxRetrievedPayloadQueueBytes`, `maxWorkerPreparationBytes`, `maxPreparedPayloadQueueBytes`) admits at least **1** oversized payload whenever that stage and its immediate downstream buffer are empty (`oversizedPayloadAdmissionsTotal`).

### 3.2 Work Package C — Destination Fairness, Reserved Slots, Dynamic Reprioritization & Job Retention (`f2_destination_scheduling`)

- **5-Tier Priority Model:**
  1. Missing active visible coverage (`-4,000,000`)
  2. Required pending destination coverage (`-3,000,000`)
  3. Approaching-resolution prewarm coverage (`-2,400,000`)
  4. Active preload coverage (`-2,000,000`)
  5. Speculative destination preload (`-1,000,000`)
- **Reserved Destination Capacity:** Reserves dedicated HTTP fetch slots (`reservedDestinationFetchSlots`: `2` in `f2_destination_scheduling`, `3` in `f2_combined`) and worker decode slots (`reservedDestinationWorkerSlots`: `1` in `f2_destination_scheduling`, `2` in `f2_combined`) whenever required visible destination tiles are waiting.
- **Dynamic Queue Reprioritization:** Recomputes tile priorities in place across `queued`, `retrieved_queued`, and queued `TileDecodeClient` worker jobs (`updateJobPriority`) on every viewport update without restarting in-flight HTTP transfers or running worker decodes (`dynamicReprioritizationsTotal`).
- **Running-Worker-Job Retention on Demotion:** When a tile currently decoding in a Web Worker is demoted from visible to non-visible (or across a brief zoom reversal) and memory headroom is healthy, the worker job finishes into `cached_inactive` (`runningWorkerJobsRetainedAfterDemotionTotal`) instead of discarding almost-finished worker work.
- **Age Escalation & Tail-Tile Boost:** Pending destination tiles escalate priority every `200 ms` (`destinationAgeEscalationMs`), and when `<= 2` required destination tiles (or `<= 50%` of visible destination tiles) remain unready, those tail tiles receive an additional `-250,000` priority boost.

### 3.3 Work Package D — Concurrency Tuning, Compressed HTTP Transfer & Transition GPU Upload Cap (`f2_tuned_concurrency`)

- **Configurable Concurrency Matrix:**
  - HTTP retrieval concurrency (`maxConcurrentHttpRetrievals` / `?maxHttpConcurrency=...`): supports `6`, `8` (default in `f2_tuned_concurrency` / `f2_combined`), and `12`.
  - Worker pool concurrency (`workerConcurrency` / `?workerConcurrency=...`): supports `2` and `4` (default in `f2_tuned_concurrency` / `f2_combined`).
- **Compressed HTTP Transfer (`?compressed=1`) + Worker `DecompressionStream('deflate')`:**
  - Server skips synchronous `zlib.inflateSync` on the Node.js event loop and streams the compact deflate-compressed SQLite blob directly (`X-Tile-Transfer-Compressed: 1`).
  - Reduces HTTP transfer volume by `~3–5×` and parallelizes decompression across the 4 Web Workers via `DecompressionStream('deflate')`.
- **Transition GPU Upload Cap:** Increases per-frame offscreen GPU upload slice limits during transitions to `24 MiB / 16 units` while remaining governed by the shared per-frame time budget (`2.0 ms`).

### 3.4 Work Package E — Latency-Aware Adaptive Preparation Horizon (`f2_latency_aware_prewarm` & `f2_combined`)

- **`evaluateAdaptivePrewarmHorizon()` (`HierarchicalResolutionPolicy.ts`):** Uses the exponential moving average preparation latency of each resolution (`historicalPrepLatencyByResMs`), current queue wait (`queueOccupancyWaitMs`), and camera scale velocity (`scaleVelocityPerSec`) to trigger predictive prewarming as soon as estimated time-to-threshold falls within `requiredLeadTimeMs * 1.4`, plus an expanded static prewarm band (`0.38`).
- **`predictViewportBoundsAtHorizon()`:** Extrapolates the viewport along `(panVelocityXPerSec, panVelocityZPerSec)` and zoom expansion over the preparation horizon so approaching tiles along the camera trajectory are fetched and decoded first.

---

## 4. Work Package F — Streaming vs. Rendering Granularity Feasibility Study & Decision Gate

A central architectural question raised by `TKT-041-F1` hardware profiling is whether **`4,096 m` is an appropriate render-batching granularity (verified by `TKT-037`: `36.50 ms -> 4.00 ms` stationary CPU render time) but too coarse as an atomic network/worker streaming unit** (where a single `4,096 m` tile can exceed `160 MB` raw decoded payload and serialize tail activation).

Below is the structured evaluation of **Candidate A**, **Candidate B**, and **Candidate C** across all 10 required dimensions.

### 4.1 Ten-Dimension Candidate Comparison Matrix

| Dimension | Candidate A: Identical Streaming & Spatial Batching (`1,024 m / 2,048 m / 4,096 m` `OSMTILE1` v1 + F2 Pipeline) | Candidate B: Sub-Chunked Streaming (`1,024 m` or `2,048 m` Streaming Units -> Runtime Assembly into `2,048 m / 4,096 m` Batches) | Candidate C: Revised Resolution Hierarchy (e.g., `1,024 m -> 2,048 m -> 3,072 m` or Adjusted Thresholds) |
| --- | --- | --- | --- |
| **1. Expected transition latency reduction** | **High (50–70% expected):** Decoupled HTTP/worker queues, `8` HTTP × `4` workers, zero server `inflateSync` (`?compressed=1`), reserved destination slots, tail boost, and velocity-adaptive prewarming eliminate queue starvation and parallelize multi-tile `4,096 m` preparation. Bounded by the single largest `4,096 m` tile decode time (~`350–650 ms` on 1 worker). | **Very High (65–80% expected):** Eliminates single-tile `>160 MB` worker tail serialization by streaming 4× `2,048 m` (or 16× `1,024 m`) chunks across all 4 workers in parallel and reusing already-loaded finer tiles during zoom-out transitions. | **Moderate (25–45% expected):** A `3,072 m` top tier reduces worst-case single-tile payload by `~44%` (`9/16` area of `4,096 m`), or lower zoom thresholds delay `4,096 m` entry until fewer tiles are visible, but does not eliminate monolithic tile decoding. |
| **2. Stationary rendering performance** | **Optimal (Preserves TKT-037 baseline):** Exact `4,096 m` consolidated draw-call count and `4.00 ms` RTX 4060 Ti regional CPU render time. | **Optimal if merged into identical `4,096 m` buffers; Slightly degraded if only grouped:** Runtime buffer concatenation + BVH merge reproduces `4,096 m` draw calls (`4.00 ms`), whereas mere scene-group parenting without geometry merge would revert toward `1,024 m` draw-call counts (`36.50 ms`). | **Slightly degraded at regional overview:** `3,072 m` tiles increase regional draw calls by `~1.78×` compared to `4,096 m` (`16/9` tile count ratio). |
| **3. Frame-time consistency during transitions** | **High:** Zero main-thread geometry merging; worker-built BVHs adopted in `O(1)`; offscreen 1×1 GPU uploads sliced at `<= 2.0 ms/frame`. | **Moderate risk:** Assembling 4× `2,048 m` or 16× `1,024 m` vertex/index/matrix buffers and rebuilding merged `MeshBVH` / `InstancedSpatialIndex` on the main thread (or in a secondary assembly worker pass) introduces extra buffer copy and BVH construction spikes unless staged through a dedicated assembly worker. | **High:** Same `O(1)` main-thread adoption and incremental GPU upload path as Candidate A, with slightly smaller per-tile buffer sizes. |
| **4. Memory overhead** | **Low / Bounded (`1,536 MiB` budget):** Single copy of active resolution + pending destination resolution; compressed HTTP queue holds compact deflate bytes (`~3–5×` smaller). | **Higher (`+25%` to `+45%` during assembly):** Requires holding constituent sub-chunks *and* the newly concatenated `4,096 m` target buffers simultaneously during runtime batch assembly unless sub-chunks are immediately discarded after merge. | **Low / Bounded (`1,536 MiB` budget):** Slightly lower peak single-tile allocation than `4,096 m`. |
| **5. Feature picking compatibility** | **100% Exact Parity:** Zero changes to `faceRanges`, `singleFeatureIdx`, `instanceFeatureIdxs`, or worker-built `InstancedSpatialIndex` / `MeshBVH`. | **High Complexity:** Runtime geometry concatenation must rebase `faceRanges`, `groups`, `featureTable` indices, local mesh offsets, and rebuild unified `MeshBVH` and `InstancedSpatialIndex` trees per `4,096 m` cell. | **100% Exact Parity:** Uses standard `OfflineTileConsolidator` `OSMTILE1` v1 provenance and BVH structures. |
| **6. Compatibility with existing baked datasets** | **100% Compatible (Zero Rebake):** Runs directly on the owner's existing `twente-full-1024m-foliage-fix`, `twente-full-2048m`, `twente-full-4096m`, and `twente-full-hierarchical.json`. | **Compatible with existing `1,024 m` / `2,048 m` SQLite packs if assembled at runtime**, or requires a new sub-chunked `OSMTILE1` container index if pre-split. | **Requires Reconsolidation:** Adding a `3,072 m` tier requires running `consolidateRegionalMosaic` to generate a new `twente-full-3072m` SQLite pack (~15–25 minutes offline). Threshold-only changes require zero rebake. |
| **7. Implementation complexity** | **Low–Moderate (Completed in `TKT-041-F2`):** Self-contained in `TileStreamManager`, `TileDecodeClient`, `TileDecodeWorker`, `tilePackHttpHandler`, and `HierarchicalResolutionPolicy`. | **High:** Requires a runtime (or worker-side) tile batch assembler duplicating `OfflineTileConsolidator` logic (coordinate rebasing, material slot grouping, `faceRanges` merging, static `MeshBVH` + `InstancedSpatialIndex` rebuilding) inside the browser streaming loop. | **Low:** `OfflineTileConsolidator` already supports integer multiples of `1,024 m` (`3,072 m = 3 × 3`), and `HierarchicalResolutionPolicy` supports arbitrary resolution arrays. |
| **8. Maintenance burden** | **Low:** Preserves a single unified `OSMTILE1` v1 decode -> reconstruct -> GPU prep pipeline across all resolutions. | **High:** Two parallel consolidation codepaths (offline `OfflineTileConsolidator.ts` vs runtime browser batch assembler) that must stay in lockstep for E2+/R+ materials, foliage LODs, and picking metadata. | **Low:** Uses the existing pipeline unchanged. |
| **9. Peak single-tile bottleneck sensitivity** | **Subject to single largest `4,096 m` tile:** A dense urban `4,096 m` tile (`>160 MB` raw) still decodes on a single worker thread (though no longer blocked by server `inflateSync` or other tiles). | **Eliminated:** Splits any `4,096 m` urban tile into 4× `2,048 m` or 16× `1,024 m` worker jobs that decode concurrently across all 4 workers. | **Reduced by ~44% (`3,072 m`)** compared to `4,096 m`. |
| **10. Zoom-out cache reuse across levels** | **Level-independent:** Zooming `1,024 m -> 2,048 m -> 4,096 m` fetches the target resolution's consolidated tiles (mitigated by adaptive prewarming and LRU inactive cache). | **Direct upward reuse possible:** Already-loaded `1,024 m` or `2,048 m` tiles in the viewport can be fed directly into the runtime batch assembler without re-fetching from the server. | **Level-independent:** Same as Candidate A. |

### 4.2 Recommendation & Explicit Decision Gate

1. **Immediate Recommendation — Execute and Validate Candidate A First (`TKT-041-F2` Implemented):**
   - Candidate A requires **zero rebaking or reconsolidation**, preserves **100% of `TKT-037`'s `4.00 ms` stationary rendering performance** and **`TKT-038`/`TKT-040` worker BVH picking parity**, and directly removes the four primary bottlenecks observed in `TKT-041-F1`:
     - Synchronous server-side `zlib.inflateSync` is eliminated via `?compressed=1` + parallel worker `DecompressionStream('deflate')`.
     - Coupled fetch/decode slot starvation is eliminated via the 8-stage pipeline and `retrieved_queued`.
     - Active-preload contention is eliminated via reserved destination fetch/worker slots, dynamic queue reprioritization, running-job retention, and tail-tile boost.
     - Late transition start is mitigated via velocity- and latency-aware adaptive prewarming (`evaluateAdaptivePrewarmHorizon`).
2. **Explicit Quantitative Decision Gate After Owner RTX 4060 Ti Validation of Candidate A:**
   - **Pass Gate (Close Granularity Question on Candidate A):** If `f2_combined` reduces cold transition latency (`cold_direct_1024_to_4096` and `zoom_sweep_1024_2048_4096_back`) by **>= 50%** compared to `TKT-041-F1` (`7.5 s -> <= 3.75 s` direct cold jump, and `3.0 s -> <= 1.5 s` stepped zoom sweep) while keeping `p95` frame time and `>33.3 ms` frame ratio within `TKT-041-F1` bounds, **retain Candidate A as the production architecture**.
   - **Trigger Gate for Candidate C (Zero-Code / Offline Reconsolidation Experiment):** If multi-tile queue wait is eliminated (`avgRetrievedQueueWaitMs < 150 ms`) but a single dense urban `4,096 m` tile (`>160 MB` raw) dominates `workerDecodeAndBvhMs > 1,200 ms`, first test **Candidate C** by adjusting the `2,048 m -> 4,096 m` zoom threshold (`?z2048To4096=0.28`) or consolidating a `3,072 m` top level.
   - **Trigger Gate for Candidate B (Follow-Up Ticket `TKT-041-F3`):** Authorize **Candidate B** (worker-side assembly of `2,048 m` streaming sub-chunks into `4,096 m` render batches) **only if** owner hardware profiling of `f2_combined` demonstrates that single-tile `4,096 m` worker decode serialization (`workerDecodeAndBvhMs` on the critical-path tile) still keeps stepped transitions `> 1,500 ms` or direct transitions `> 3,500 ms` after HTTP/worker concurrency tuning (`8–12` HTTP × `4` workers).

---

## 5. Synthetic Sandbox Verification Results (`2026-11-27`)

> **Environment Provenance Note:** Per `GEMINI.md`, the sandbox environment does not have the owner's 648 MiB full-Twente SQLite dataset or hardware GPU. The results below verify functional contracts, stage decoupling, byte accounting, oversized-payload forward progress, fairness, and leak-free cancellation on deterministic synthetic 3-resolution (`1,024 m / 2,048 m / 4,096 m`) `OSMTILE1` v1 fixtures.

### 5.1 Unit & Integration Test Suite (`23 / 23` Passed)

Executed via:
```bash
npx tsx --test src/world/StreamingThroughputAndLatency.test.ts src/world/FrameBudgetedStreaming.test.ts src/world/HierarchicalTileStreaming.test.ts src/world/NonBlockingTilePreparation.test.ts
```

| Test Suite | Subtests | Result | Verified Contracts |
| --- | --- | --- | --- |
| `src/world/StreamingThroughputAndLatency.test.ts` | `7 / 7` | **PASS** | 1. Staged F2 presets (`f2_independent_pipeline`, `f2_destination_scheduling`, `f2_tuned_concurrency`, `f2_latency_aware_prewarm`, `f2_combined`), URL parameter parsing (`?maxHttpConcurrency=12&workerConcurrency=4&compressedTransfer=1&adaptivePrewarm=1`), and `f2_combined` default.<br>2. Server `?compressed=1` deflate passthrough (`X-Tile-Transfer-Compressed: 1`, `X-Tile-Server-Inflate-Ms: 0`) vs uncompressed default (`X-Tile-Transfer-Compressed: 0`) and timing headers.<br>3. Decoupled HTTP slot release into `retrieved_queued` while worker decode is held, plus Section 5.2 oversized-payload forward-progress admission (`oversizedPayloadAdmissionsTotal >= 1`) when stage byte caps (`128 B`) are smaller than individual payloads.<br>4. Dynamic queue reprioritization (`dynamicReprioritizationsTotal > 0`) on camera focus shift without restarting in-flight transfers.<br>5. Velocity- and latency-aware adaptive prewarming horizon (`evaluateAdaptivePrewarmHorizon`) and predicted activation viewport bounds (`predictViewportBoundsAtHorizon`).<br>6. Continuous active-resolution panning during a `1,024 m -> 4,096 m` transition: verifies steady destination progress, uniform viewport resolution invariant (`attachedResolutions.size <= 1`), atomic activation, and canonical building feature picking parity.<br>7. Rapid multi-resolution zoom reversal (`1.5 -> 0.5 -> 0.18 -> 1.5 -> 0.5 -> 1.5`) verifying leak-free cleanup (`inFlightHttpReservationBytes === 0`, `retrievedPayloadQueueBytes === 0`, `inFlightWorkerPreparationBytes === 0`). |
| `src/world/FrameBudgetedStreaming.test.ts` | `6 / 6` | **PASS** | All `TKT-041-F1` scheduler, offscreen incremental GPU prep, deferred disposal, debounce, and Section 12 predictive prewarm contracts. |
| `src/world/HierarchicalTileStreaming.test.ts` | `4 / 4` | **PASS** | All `TKT-041` resolution-qualified keys, hysteresis deadbands, atomic swaps, LRU cache, `deferred_budget` safeguard, and single-resolution backward compatibility. |
| `src/world/NonBlockingTilePreparation.test.ts` | `6 / 6` | **PASS** | All `TKT-040` compact worker transport, worker-built `InstancedSpatialIndex` BVH, zero-copy buffer adoption, and profiler frame-alignment contracts. |

---

## 6. Owner Hardware Reproduction & Benchmark Plan (Windows PowerShell)

All commands below use direct `npx tsx` invocation (compatible with Windows PowerShell) and point directly to `data/osm/twente-full-hierarchical.json`.

### 6.1 Staged 6-Variant Throughput & Transition Latency Matrix (Work Package G)

Runs `combined_prewarm` (the `TKT-041-F1` baseline) against all 5 staged `TKT-041-F2` configurations (`f2_independent_pipeline`, `f2_destination_scheduling`, `f2_tuned_concurrency`, `f2_latency_aware_prewarm`, `f2_combined`) across all 8 Work Package G scenarios (`cold_direct_1024_to_4096`, `cold_stepped_1024_2048_4096`, `warm_reverse_4096_2048_1024`, `continuous_pan_plus_zoom_out`, `continuous_pan_plus_zoom_in`, `rapid_zoom_reversal_under_load`, `sustained_pan_at_2048`, `sustained_pan_at_4096`, plus `zoom_sweep_1024_2048_4096_back`):

```powershell
npx tsx benchmarks/hierarchicalStreamingRunner.ts --mosaic=data/osm/twente-full-hierarchical.json --f2-matrix --headed --out=docs/reports/tkt041-f2-hardware-staged-matrix.json
```

### 6.2 Focused Transition-Latency Comparison (`combined_prewarm` vs `f2_combined`)

For a fast side-by-side hardware run on the primary transition-latency scenarios (`cold_direct_1024_to_4096`, `cold_stepped_1024_2048_4096`, `continuous_pan_plus_zoom_out`, `rapid_zoom_reversal_under_load`):

```powershell
npx tsx benchmarks/hierarchicalStreamingRunner.ts --mosaic=data/osm/twente-full-hierarchical.json --f1-variants=combined_prewarm,f2_combined --scenarios=cold_direct_1024_to_4096,cold_stepped_1024_2048_4096,continuous_pan_plus_zoom_out,rapid_zoom_reversal_under_load --headed --out=docs/reports/tkt041-f2-hardware-ab.json
```

### 6.3 Work Package D Concurrency Matrix (`HTTP 6 / 8 / 12` × `Worker 2 / 4`)

You can test specific HTTP and worker concurrency combinations interactively or in the benchmark viewer using URL query parameters:

- `http://localhost:3000/?streamingVariant=f2_combined&maxHttpConcurrency=6&workerConcurrency=2&compressedTransfer=1`
- `http://localhost:3000/?streamingVariant=f2_combined&maxHttpConcurrency=8&workerConcurrency=4&compressedTransfer=1` (Default `f2_combined`)
- `http://localhost:3000/?streamingVariant=f2_combined&maxHttpConcurrency=12&workerConcurrency=4&compressedTransfer=1`

To start the interactive viewer against the full-Twente hierarchical descriptor in Windows PowerShell:

```powershell
$env:OVERIJSSEL_HIERARCHICAL_MOSAIC_PATH="data/osm/twente-full-hierarchical.json"
npx tsx server.ts
```
