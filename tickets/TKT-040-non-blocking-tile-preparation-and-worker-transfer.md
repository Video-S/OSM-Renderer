---
id: TKT-040
title: Non-blocking Tile Preparation and Worker Transfer
type: perf
status: in_progress
priority: high
created: 2026-11-26
updated: 2026-11-26
---

# TKT-040: Non-blocking Tile Preparation and Worker Transfer

## Summary

Eliminate intermittent main-thread streaming stalls (`>190 ms` observed on the owner's RTX 4060 Ti in `TKT-039`, even with foliage disabled) by correcting profiler frame-alignment bugs, replacing large structured-cloned JS metadata graphs across the worker boundary with compact zero-copy transferable typed arrays, offloading `InstancedSpatialIndex` BVH construction to `TileDecodeWorker`, and removing redundant per-tile main-thread preparation work — without altering geographic geometry, rendering appearance, picking accuracy, or `OSMTILE1` v1 baked mosaics.

All four work packages (`WP-A` through `WP-D`) are independently toggleable across five evaluation variants (`baseline`, `transfer_only`, `compact_transport`, `worker_bvh`, `combined`), with `combined` enabled by default.

## Context

`TKT-039` hardware profiling on the owner's RTX 4060 Ti (`4,096 m` consolidated Twente mosaic) showed steady ~144 FPS during stationary and warm-cache camera movement, while tile streaming introduced intermittent frame intervals exceeding `190 ms` regardless of foliage visibility:

1. **Expensive `Worker.onmessage` delivery:** Decoded `OSMTILE1` payloads previously transferred only a subset of typed-array buffers (omitting `instanceFeatureIdxs`) while sending tens of thousands of JS objects (`featureInfos`, `faceRanges`, `groups`, `sleeperBoxes`, `String` tags) via structured clone across `postMessage`.
2. **Synchronous `InstancedSpatialIndex` BVH construction:** Every instanced mesh (foliage canopies, trunks, railway sleepers) built its 3D AABB BVH synchronously on the main thread during `reconstructTileSceneFromDecoded` — even when foliage display was toggled OFF (because tile meshes are still reconstructed and visibility-toggled).
3. **Eager main-thread reconstruction & stats work:** `reconstructTileSceneFromDecoded` eagerly cloned `InstancedMesh.instanceMatrix` buffers, allocated `instanceInfos` / `instanceBoxes` / `faceRanges` / `singleFeatureIdx` metadata objects, computed foliage bounding boxes via `O(N)` loops, walked full payloads to estimate memory footprint, and `rebuildCompositeStats()` called `grp.updateMatrixWorld(true)` across all loaded tiles on every commit/eviction.
4. **Profiler frame-alignment bugs from `TKT-039`:** Stalls occurring before a frame's work began were misattributed to the wrong frame interval, and `event.frameIndex` had an off-by-one shift against `frame.frameIndex`.

## Scope & Work Packages

- **Work Package A — Profiler Alignment Fixes & Cross-Thread Telemetry:**
  - Fixed pre-work frame-interval attribution and off-by-one `event.frameIndex` alignment in `StreamingProfiler.ts` and `MapScene.tsx`.
  - Added cross-thread worker delivery telemetry (`workerQueueWaitMs`, `workerInflateAndDecodeMs`, `workerBvhBuildMs`, `workerPayloadPrepMs`, `messageDeliveryLatencyMs`, `mainOnMessageHandlerMs`, `mainPromiseContinuationMs`, transferable buffer counts/bytes, worker BVH adopted vs. sync fallback counts) and event-conditioned frame summaries (`allFrames`, `workerDeliveryFrames`, `tileCommitFrames`, `activeStreamingWorkFrames`, `quietFrames`) in `StreamingFluidityStats.ts`.
  - Separated observed display refresh cadence from the 144 Hz (`6.94 ms`) latency target.
- **Work Package B — Complete Buffer Transfers & Compact Metadata Transport (`transfer_only`, `compact_transport`):**
  - Updated `TileDecodeWorker.ts` to transfer all eligible typed-array backing buffers (including `instanceFeatureIdxs`) with deduplicated `ArrayBuffer` collection and zero post-transfer reads.
  - Added `src/world/tiling/CompactTileTransport.ts` encoding `featureInfos`, `faceRanges`, `groups`, `sleeperBoxes`, UTF-8 string pool, and precomputed `TileMemoryFootprint` into flat transferable typed arrays with `CompactTileFeatureTable` lazy on-demand `InspectableFeatureInfo` materialization (100% compatible with existing `OSMTILE1` v1 mosaics).
- **Work Package C — Worker-Side `InstancedSpatialIndex` BVH Construction (`worker_bvh`):**
  - Built flat typed-array `InstancedSpatialIndex` BVHs inside `TileDecodeWorker.ts` using exact Arvo affine-AABB transforms and `FoliageLodSystem.ts` union prototype local bounds (`getSharedFoliagePrototypeUnionBounds` + `computeInstancedMeshLocalBounds`), transferred zero-copy and adopted in `O(1)` via `attachPreparedInstancedSpatialIndex()` in `InstancedSpatialIndex.ts` with automatic synchronous fallback if absent or invalid.
- **Work Package D — Main-Thread Preparation Optimization (`combined`):**
  - Zero-copy `InstancedMesh` matrix buffer adoption (`instanceMatrix.array` directly from transferred `Float32Array`).
  - `O(1)` conservative `InstancedMesh.boundingBox` derivation from `preparedSpatialIndex.rootBoundsMin/Max` (`+0.25 m` margin).
  - Lazy picking metadata lookups (`resolveInspectedFeature` reading `__featureTable`, `__singleFeatureIdx`, compact face ranges, and lazy `Object.defineProperty` compatibility getters without eager per-mesh allocations).
  - `O(1)` precomputed `TileMemoryFootprint` from worker metadata; removed full-scene `grp.updateMatrixWorld(true)` walk from `TileStreamManager.rebuildCompositeStats()`.
- **Five-Variant Evaluation & UI/Harness Wiring:**
  - `src/world/tiling/TilePreparationConfig.ts`: `'baseline' | 'transfer_only' | 'compact_transport' | 'worker_bvh' | 'combined'` (default `'combined'`), `?tilePrepVariant=...`, `__BENCHMARK_HARNESS__.{getTilePreparationOptions, setTilePreparationOptions}`, `DiagnosticsPanel.tsx` Tile Prep Mode selector & worker BVH / ready-MB readout, and `benchmarks/streamingFluidityRunner.ts --variant=...`.

## Out of scope

- Hierarchical LOD1–LOD3 streaming, prefetching/cache policy redesign, full multi-frame incremental reconstruction scheduler, or incremental WebGL buffer-upload architecture (remaining indivisible costs — `MeshBVH.deserialize`, Three.js object allocation, and first-render WebGL uploads — are documented in the evaluation report for the follow-up ticket).
- Regional OSM rebaking, `OSMTILE1` v1 schema changes, or geographic geometry/appearance modifications.
- Speculative LLM visual QA or fabricated hardware GPU measurements.

## Acceptance criteria

- [x] **WP-A:** Pre-work frame-interval attribution and off-by-one `event.frameIndex` bugs fixed; cross-thread worker delivery telemetry and event-conditioned frame summaries implemented and unit-tested (`NonBlockingTilePreparation.test.ts`, `StreamingFluidityProfiling.test.ts`).
- [x] **WP-B:** All eligible typed-array buffers transferred cleanly with deduplication; `CompactTileTransport.ts` encodes/decodes metadata losslessly with zero eager `InspectableFeatureInfo` materialization during tile reconstruction and full backward compatibility with `OSMTILE1` v1 mosaics.
- [x] **WP-C:** Worker-built `InstancedSpatialIndex` BVHs match main-thread BVH topology/bounds/picking identically, adopt in `O(1)` with `syncBvhFallbackTotal === 0`, and fall back cleanly when unavailable.
- [x] **WP-D:** Zero-copy `InstancedMesh` matrix buffer adoption, `O(1)` foliage bounds, lazy metadata lookups, `O(1)` memory footprint, and removal of full-scene `updateMatrixWorld(true)` in `rebuildCompositeStats()` implemented with zero picking or rendering regression.
- [x] **5-Variant Support & Automated Verification:** All 5 variants (`baseline`, `transfer_only`, `compact_transport`, `worker_bvh`, `combined`) verified via `NonBlockingTilePreparation.test.ts` + 13-file regression suite (`84/84` passing), `npm run lint` (`tsc --noEmit`), `npm run build`, `npm run docs:api`, and end-to-end synthetic high-cardinality Playwright SwiftShader benchmarking across `1,024 m`, `2,048 m`, and `4,096 m` (`foliage=on`) plus `4,096 m` (`foliage=off`).
- [x] **Evaluation Report:** Published [`docs/reports/tkt040-non-blocking-tile-preparation.md`](../docs/reports/tkt040-non-blocking-tile-preparation.md) with synthetic 5-variant measurements, remaining indivisible cost analysis, and direct Windows PowerShell RTX 4060 Ti reproduction commands.
- [ ] **Owner hardware GPU benchmarking & interactive QA:** Project owner runs the 5-variant real-data benchmark on the RTX 4060 Ti across `1,024 m`, `2,048 m`, and `4,096 m` Twente mosaics (foliage ON and OFF), confirms elimination of `Worker.onmessage` / sync BVH stalls and picking/visual parity, and decides next steps for remaining indivisible costs (`MeshBVH.deserialize` / WebGL uploads).

## References

- Evaluation & benchmark guide: [`docs/reports/tkt040-non-blocking-tile-preparation.md`](../docs/reports/tkt040-non-blocking-tile-preparation.md)
- Preceding profiling ticket: [`TKT-039`](TKT-039-camera-movement-and-streaming-frame-time-profiling.md), [`docs/reports/tkt039-streaming-fluidity-profiling.md`](../docs/reports/tkt039-streaming-fluidity-profiling.md)
- Core implementation: `src/world/tiling/TilePreparationConfig.ts`, `src/world/tiling/CompactTileTransport.ts`, `src/world/tiling/TileDecodeWorker.ts`, `src/world/tiling/TileDecodeClient.ts`, `src/world/tiling/TileSceneReconstructor.ts`, `src/world/InstancedSpatialIndex.ts`, `src/world/FoliageLodSystem.ts`, `src/world/GeometryBuilder.ts`, `src/world/tiling/StreamingProfiler.ts`, `src/world/tiling/StreamingFluidityStats.ts`, `src/world/tiling/TileStreamManager.ts`, `src/scene/MapScene.tsx`
- Tests & benchmark runner: `src/world/NonBlockingTilePreparation.test.ts`, `src/world/StreamingFluidityProfiling.test.ts`, `benchmarks/streamingFluidityRunner.ts`
