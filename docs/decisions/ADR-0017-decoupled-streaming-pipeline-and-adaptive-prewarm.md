# ADR-0017: Decoupled Multi-Stage Streaming Pipeline, Compressed Worker Transfer, Reserved Destination Fairness, and Latency-Aware Adaptive Prewarming (`TKT-041-F2`)

- **Status:** Accepted (`TKT-041-F2` closed 2026-11-27; `f2_combined` retained as accepted default foundation with documented limitations; further uniform full-detail transition optimization deferred pending dual-map exploration)
- **Date:** 2026-11-27
- **Related Tickets:** `TKT-041-F2` (`closed`), `TKT-041-F1`, `TKT-041`, `TKT-040`
- **Related ADRs:** [`ADR-0011`](ADR-0011-baked-tiles-and-runtime-streaming.md), [`ADR-0015`](ADR-0015-hierarchical-tile-streaming.md), [`ADR-0016`](ADR-0016-frame-budgeted-streaming-and-incremental-gpu-prep.md)

---

## 1. Context

`TKT-041` ([`ADR-0015`](ADR-0015-hierarchical-tile-streaming.md)) introduced uniform-viewport hierarchical tile streaming across `1,024 m`, `2,048 m`, and `4,096 m` `OSMTILE1` v1 mosaics. `TKT-041-F1` ([`ADR-0016`](ADR-0016-frame-budgeted-streaming-and-incremental-gpu-prep.md)) added a shared per-frame main-thread workload scheduler (`StreamingWorkloadScheduler`), offscreen 1×1 incremental GPU preparation (`IncrementalGpuPreparer`), bounded deferred geometry disposal (`DeferredDisposalQueue`), transition debouncing, and static threshold-band predictive prewarming.

Owner hardware validation on the full Twente dataset (`twente-full-hierarchical.json`, RTX 4060 Ti) confirmed that `TKT-041-F1` improved interactive frame-time consistency, but exposed a severe streaming throughput and transition-latency bottleneck when transitioning to coarse (`2,048 m` and `4,096 m`) tiles:

1. **Coupled Fetch-and-Decode Concurrency (`activeFetchCount`):** In `TKT-041` / `TKT-041-F1`, each `startTileFetchAndDecode` slot stayed occupied across the entire HTTP retrieval *plus* worker queue wait *plus* worker decode and BVH construction. When large `4,096 m` tiles (up to `>160 MB` raw decoded footprint) occupied the 2 Web Workers, HTTP retrieval slots stalled even when network/server bandwidth was idle.
2. **Synchronous Server Inflate & Large Uncompressed Local HTTP Transfers:** `tilePackHttpHandler.ts` synchronously inflated every SQLite blob (`inflateTilePayload`) on the Node.js event loop before sending the uncompressed `OSMTILE1` binary over HTTP (`3–5×` larger transfer volume), serializing concurrent multi-tile requests.
3. **Active-Preload Contention & Wasted Worker Work During Continuous Pan + Zoom:** During simultaneous panning and zooming, newly entering active-resolution preload tiles competed with required destination-resolution visible tiles for fetch and worker slots, while viewport shifts aborted already-running worker decodes or forced queue restarts.
4. **Static Prewarming Horizon Insufficient for Slow `4,096 m` Preparation:** A static `25%` hysteresis band fraction did not provide enough lead time when zooming out rapidly toward a `4,096 m` transition whose end-to-end preparation takes `1.5–3.0 s`.

---

## 2. Decision

We retain the uniform-viewport resolution invariant, atomic frame-boundary activation, `OSMTILE1` v1 dataset compatibility (zero rebaking or reconsolidation), `TKT-040` compact worker transport + worker BVH construction, and `TKT-041-F1` frame-budgeted main-thread scheduling, while upgrading the streaming pipeline with five coordinated architectural mechanisms:

### 2.1 Eight-Stage Decoupled Pipeline with Single-Owner Byte Accounting and Oversized-Payload Forward Progress

`TileStreamManager` decouples network retrieval from worker decoding into explicit, independently bounded stages:

1. **Stage 1 — Fetch Queue (`queued`):** Priority-ordered candidate tiles in `fetchSet`.
2. **Stage 2 — HTTP Retrieval (`fetching`):** Bounded by `maxConcurrentHttpRetrievals` (default `8` in `f2_combined`) and `maxInFlightHttpReservationBytes` (`384 MiB`). The HTTP concurrency slot and reservation are released **immediately** when `response.arrayBuffer()` resolves.
3. **Stage 3 — Retrieved-Payload Queue (`retrieved_queued`):** Holds the retrieved `ArrayBuffer` (`retrievedPayloadQueueBytes`, default cap `384 MiB`) until a worker slot and worker byte budget are available.
4. **Stage 4 — Worker Preparation (`decoding`):** Bounded by `workerConcurrency` (default `4` workers in `f2_combined`) and `maxWorkerPreparationBytes` (`512 MiB`). Performs deflate decompression (when transferred compressed), `OSMTILE1` compact binary decode, and worker-side `InstancedSpatialIndex` BVH construction.
5. **Stage 5 — Prepared-Payload Queue (`ready_to_commit`):** Bounded by `maxPreparedPayloadQueueBytes` (`384 MiB`), holding zero-copy transferred buffers awaiting main-thread reconstruction.
6. **Stage 6 — Scene Reconstruction (`prepared_inactive` / `loaded`):** Frame-budgeted `reconstructTileSceneFromDecoded` execution.
7. **Stage 7 — Incremental GPU Preparation:** Bounded by `maxReconstructedAwaitingGpuBytes` (`512 MiB`) and per-frame time/byte/unit slice limits (`24 MiB / 16 units` in `f2_combined`).
8. **Stage 8 — Atomic Activation:** Constant-time scene-group swap once 100% of required visible destination tiles are CPU- and GPU-ready.

**Single-Owner Byte Handoff:** When a payload moves from Stage 2 -> Stage 3 -> Stage 4 -> Stage 5 -> Stage 6, its byte accounting is atomically subtracted from the upstream stage before being added to the downstream stage, preventing artificial double-counting stalls.

**Oversized-Payload Forward-Progress Rule:** Because individual consolidated `4,096 m` tiles can exceed `160 MB`, any stage byte cap (`maxRetrievedPayloadQueueBytes`, `maxWorkerPreparationBytes`, `maxPreparedPayloadQueueBytes`) admits at least **1** oversized tile whenever that stage and its immediate downstream queue are completely drained (`oversizedPayloadAdmissionsTotal`). This guarantees deadlock-free forward progress without disabling bounded backpressure for multi-tile queues.

### 2.2 Optional Compressed HTTP Transfer (`?compressed=1`) and Worker-Side `DecompressionStream('deflate')`

- `tilePackHttpHandler.ts` supports `?compressed=1` alongside high-resolution timing headers (`X-Tile-Server-Sqlite-Ms`, `X-Tile-Server-Inflate-Ms`, `X-Tile-Server-Total-Ms`, `X-Tile-Transfer-Compressed`).
- When `useCompressedHttpTransfer` is enabled (`f2_tuned_concurrency`, `f2_combined`), the server bypasses `zlib.inflateSync` on the Node.js thread and streams the SQLite deflate-compressed blob directly (`X-Tile-Transfer-Compressed: 1`), while `TileDecodeWorker.ts` inflates the payload in parallel across worker threads using the Web standard `DecompressionStream('deflate')` API (automatically accepting both compressed deflate streams and raw `OSMTILE1` magic headers).

### 2.3 Reserved Destination Capacity, Dynamic Reprioritization, Running-Job Retention, and Tail-Tile Boost

- **Five Priority Classes:**
  1. Missing active visible coverage (`-4,000,000`)
  2. Required pending destination coverage (`-3,000,000` plus age escalation and tail-tile boost)
  3. Approaching-resolution prewarm coverage (`-2,400,000`)
  4. Active preload coverage (`-2,000,000`)
  5. Speculative destination preload (`-1,000,000`)
- **Reserved Destination Slots:** `reservedDestinationFetchSlots` (default `3` of `8`) and `reservedDestinationWorkerSlots` (default `2` of `4`) reserve dedicated capacity whenever required visible destination tiles are queued, ensuring continuous active-resolution panning cannot starve a pending transition.
- **Dynamic Queue Reprioritization:** Camera updates recompute `priorityScore` in place across `queued`, `retrieved_queued`, and queued `TileDecodeClient` jobs (`updateJobPriority`) without cancelling or restarting in-flight transfers.
- **Running-Worker-Job Retention on Demotion:** When `retainRunningWorkerJobOnDemotion` is enabled and memory headroom is healthy, a worker job that is already executing when demoted from visible to non-visible completes into `cached_inactive` (`runningWorkerJobsRetainedAfterDemotionTotal`) rather than wasting worker CPU time.
- **Age Escalation & Tail-Tile Boost:** Pending destination tiles escalate priority every `destinationAgeEscalationMs` (`200 ms`), and when `<= 2` required destination tiles (or `<= 50%` of visible destination coverage) remain unready, those tail tiles receive an additional `-250,000` priority boost.

### 2.4 Latency-Aware Adaptive Preparation Horizon and Predicted Activation Viewport

- `evaluateAdaptivePrewarmHorizon()` (`HierarchicalResolutionPolicy.ts`) combines the static hysteresis band fraction (`0.38` in `f2_combined`) with a velocity-and-latency horizon:
  $$\text{estimatedTimeToThresholdMs} = \frac{|\text{effectiveScale} - \text{threshold}|}{|\text{scaleVelocityPerSec}|} \times 1000$$
  $$\text{requiredLeadTimeMs} = \left(\text{historicalPrepLatencyMs}[r_{\text{target}}] + \text{queueOccupancyWaitMs}\right) \times \text{leadMultiplier}$$
  When the camera is zooming toward an adjacent resolution and $\text{estimatedTimeToThresholdMs} \le \text{requiredLeadTimeMs}$, prewarming begins immediately (subject to active visible coverage completeness and memory headroom).
- `predictViewportBoundsAtHorizon()` projects the ground-plane viewport along `(panVelocityXPerSec, panVelocityZPerSec)` and zoom expansion over the preparation horizon so destination and prewarm tiles moving into view are prioritized ahead of trailing tiles.

### 2.5 Streaming vs. Rendering Granularity Decision Gate

As documented in [`docs/reports/tkt041-f2-streaming-throughput-and-granularity.md`](../reports/tkt041-f2-streaming-throughput-and-granularity.md), we adopted **Candidate A** (`1,024 m / 2,048 m / 4,096 m` `OSMTILE1` v1 spatial batching and streaming granularity with pipeline decoupling, `?compressed=1` worker-side decompression, `8` HTTP × `4` workers, reserved destination fairness, and adaptive prewarming) as the zero-rebake implementation (`f2_combined` default). Following RTX 4060 Ti hardware validation and interactive testing (`2026-11-27`), the owner accepted **Candidate A (`f2_combined`)** with its remaining limitations as the current foundation and reference implementation, deferring **Candidate B** (`1,024 m`/`2,048 m` runtime sub-chunk assembly), **Candidate C**, and further optimization of uniform full-detail resolution transitions until exploring a dual-map architecture ([`docs/plans/colony-sim-design-discussion.md`](../plans/colony-sim-design-discussion.md)).

---

## 3. Consequences

### Positive
- Eliminates idle network slots during heavy worker decoding and eliminates synchronous Node.js `zlib.inflateSync` serialization when `?compressed=1` is active (with concurrent `DecompressionStream('deflate')` stream consumption in `TileDecodeWorker.ts` avoiding backpressure deadlocks on `>160 MiB` payloads).
- Guarantees deadlock-free loading for `>160 MB` `4,096 m` tiles while keeping multi-tile queues strictly memory-bounded.
- Prevents active-resolution preload traffic from starving destination transitions during simultaneous pan + zoom.
- Demonstrated substantial `4,096 m` transition-latency reductions on owner RTX 4060 Ti full-Twente validation (`combined_prewarm` -> `f2_combined`, foliage enabled, `1,536 MiB`): cold `1,024 -> 4,096 m` `6812.0 -> 2603.5 ms`, cold `2,048 -> 4,096 m` `3543.1 -> 2606.0 ms`, gradual zoom-out with panning `7551.0 -> 2715.1 ms`, and long-distance teleport `8319.6 -> 1022.5 ms`, with all single-resolution consistency checks, zero unfinished transitions, and sampled feature picking parity passing.
- Preserves 100% backward compatibility with existing baked `OSMTILE1` v1 SQLite packs and all `TKT-041-F1` / `TKT-041` / `TKT-040` presets for reproducible A/B hardware evaluation.

### Trade-offs, Constraints & Owner-Accepted Limitations (`TKT-041-F2` Closure)
- The provisional `>= 50%` latency reduction target was not achieved universally (`2,048 -> 4,096 m` improved ~`26.4%`).
- Frame-time consistency remained mixed on hardware, with regressions observed in some scenarios.
- Peak accounted memory consumption increased in several scenarios under concurrent `8` HTTP × `4` worker preparation (`maxRetrievedPayloadQueueBytes: 384 MiB`, `maxWorkerPreparationBytes: 512 MiB`, `1,536 MiB` total budget).
- The full staged variant matrix (`--variants=f2_all`) and concurrency matrix (`HTTP 6/8/12 × Worker 2/4`) were not executed on owner hardware.
- The existing hierarchy still relies on relatively large, indivisible `4,096 m` streaming payloads.
- All five limitations above are explicitly accepted by the owner for the current phase (`TKT-041-F2` closed `2026-11-27`) and must not be misrepresented as resolved; further optimization of uniform full-detail transitions is deferred in favor of exploring a detailed local renderer paired with a lightweight strategic regional view ([`docs/plans/colony-sim-design-discussion.md`](../plans/colony-sim-design-discussion.md)).
