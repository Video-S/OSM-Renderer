---
id: TKT-039
title: Camera Movement and Streaming Frame-Time Profiling
type: perf
status: in_progress
priority: high
created: 2026-11-25
updated: 2026-11-25
---

# TKT-039: Camera Movement and Streaming Frame-Time Profiling

## Summary

Establish opt-in, zero/low-overhead frame-time instrumentation, nested synchronous main-thread stage attribution, bounded tile-streaming lifecycle logging, browser LongTask / Long Animation Frame (`LoAF`) correlation, and a reproducible Playwright benchmark runner (`npm run bench:streaming-fluidity`) to identify and quantify the causes of stuttering during camera movement toward a 144 Hz (`6.94 ms`) frame budget.

**This is strictly a profiling and diagnostic task.** No rendering optimizations, commit-budget changes, worker refactors, eviction-policy changes, or geometry edits were introduced.

## Context

Following `TKT-036` through `TKT-038`, stationary rendering on the owner's RTX 4060 Ti using the consolidated `4,096 m` Twente mosaic reaches ~`144 FPS` (~`6.94 ms`), while noticeable stuttering persists during camera panning and zooming even when foliage is disabled.

Candidate contributors identified for direct measurement (not pre-judged):

- Synchronous main-thread tile reconstruction (`reconstructTileSceneFromDecoded`), static `MeshBVH` deserialization, and `InstancedSpatialIndex` BVH building.
- Scene attachment (`attachTileToCompositeScene`), `rebuildCompositeStats()`, `updateMatrixWorld(true)`, and tile eviction disposal (`dispose()`).
- Viewport evaluation (`updateFromCamera`, bounds unprojection, tile grid scan, priority sorting, cancellation, fetch queue pumping) and zoom propagation (`updateCameraZoom`).
- First-render WebGL uploads / driver sync inside `gl.render()` (tracked via `first_rendered_use` + `driverGeometriesDelta` proxy telemetry).
- Camera controls (`MapControls.update()`), React reconciliation (`<React.Profiler>`), R3F pointer/Raycaster picking during drag, and browser GC / `LongTask` / `LoAF` stalls.

## Out of scope

- Any runtime optimization (e.g., worker BVH offloading, frame-time-budgeted commits, prefetch/cache policy changes, geometry LOD1–LOD3).
- Regional rebaking or `OSMTILE1` v1 schema changes.
- Speculative LLM visual QA or fabricated hardware timings.

## Implementation details

1. **Opt-In Bounded Profiler (`src/world/tiling/StreamingProfiler.ts`):**
   - Disabled by default (`enabled === false`) with immediate early-return fast paths and zero active `PerformanceObserver` or `THREE.Raycaster` wrappers when off.
   - Bounded circular rings (`16,384` frames, `8,192` lifecycle events, `1,024` browser entries) with dropped-entry counters.
   - Mutually exclusive 9-bucket synchronous stage nesting (`attributedSyncMainThreadMs = cameraUseFrameMs + mapSceneUseFrameOtherMs + zoomPropagationMs + viewportUpdateMs + streamTickMs + telemetryHudMs + pickingRaycasterMs + reactCommitMs + glRenderCpuMs`) with child sub-stages explicitly nested (`controlsUpdateMs`, `reconstructMs`, `instancedBvhBuildMs`, `staticBvhDeserializeMs`, `sceneAttachMs`, `commitRebuildStatsMs`, `evictDisposeMs`, `tileScanMs`, etc.).
   - Timestamped streaming lifecycle events (`fetch_start/complete`, `decode_start/complete`, `ready_to_commit`, `reconstruct_start/complete`, `attach`, `first_rendered_use`, `evict`, `cancel`, `error`) recording tile key, tile size, compressed byte length (captured before worker buffer transfer), decoded raw byte footprint, duration, and queue depths.
   - Dynamic `PerformanceObserver` (`longtask` and `long-animation-frame`) and `THREE.Raycaster.prototype.{intersectObjects,intersectObject}` timing wrappers installed only while enabled.
2. **Runtime Wiring (`TileSceneReconstructor.ts`, `TileStreamManager.ts`, `CameraController.tsx`, `MapScene.tsx`, `App.tsx`, `DiagnosticsPanel.tsx`):**
   - Permanent `<React.Profiler id="MapWorkspace">` wrapper prevents unmounting/remounting `<Canvas>` when toggling the profiler on/off.
   - URL query parameter `?streamingProfile=1`, `DiagnosticsPanel` live **Streaming Fluidity Profiler (TKT-039)** toggle + JSON export button, and `__BENCHMARK_HARNESS__.{setStreamingProfilerEnabled, getStreamingProfilerEnabled, resetStreamingProfiler, getStreamingProfilerSnapshot}` APIs.
3. **Analysis & Multi-Mosaic Runner (`src/world/tiling/StreamingFluidityStats.ts`, `benchmarks/streamingFluidityRunner.ts`):**
   - `p99.9` and `[6.94, 13.89, 16.67, 33.33, 50.0] ms` exceedance counts + max consecutive slow-frame streaks.
   - Refresh cadence classification (`refresh_limited_steady`, `workload_induced_stalls`, `software_rasterizer_limited`, `mixed`).
   - Strict Scenario B warm-cache verification (reclassifies if any streaming events occur), Scenario C streaming boundary verification, Scenario D reverse-traversal reuse rate, isolated Scenario F teleportation, real Playwright pointer-drag Scenario G (`inputPath: 'real_pointer_drag'`), profiling overhead check, and optional Chrome DevTools trace export (`--trace-out`).

## Acceptance criteria

- [x] Opt-in, zero-overhead-when-disabled `StreamingProfiler` implemented with bounded circular buffers, non-double-counted nested synchronous stages, streaming lifecycle events, first-render upload proxies, LongTask/LoAF observers, and conditional `Raycaster` wrapping.
- [x] Runtime wiring preserves default renderer behavior, never unmounts `<Canvas>` on toggle, and exposes `?streamingProfile=1`, `DiagnosticsPanel` REC/export controls, and `__BENCHMARK_HARNESS__` APIs.
- [x] Statistical attribution engine (`StreamingFluidityStats.ts`) computes `p99.9`, 144/72/60/30Hz + 50 ms budget exceedances & streaks, cadence classification, warm-cache vs. streaming validation, and per-spike attribution separating sync stages, concurrent streaming events, and unattributed residual.
- [x] Reproducible multi-mosaic Playwright runner (`benchmarks/streamingFluidityRunner.ts`, `npm run bench:streaming-fluidity`) supports `1,024 m`, `2,048 m`, and `4,096 m` mosaics at shared UTM coordinates across Scenarios A–G, profiling overhead verification, and optional CDP Chrome traces (`--trace-out`).
- [x] Deterministic unit/integration suite (`src/world/StreamingFluidityProfiling.test.ts`), end-to-end synthetic Playwright verification (`--allow-software`), 9-file tiling/foliage/picking/UI regression suite (`46/46`), `npm run lint`, `npm run build`, and `npm run docs:api` pass.
- [x] Evaluation report (`docs/reports/tkt039-streaming-fluidity-profiling.md`) published with methodological caveats, Chrome DevTools trace instructions, and Windows PowerShell reproduction commands for all three Twente mosaics.
- [ ] **Owner hardware profiling run on real Twente mosaics:** Project owner runs `npm run bench:streaming-fluidity` on the RTX 4060 Ti against `data/osm/twente-full-1024m-foliage-fix/mosaic.json`, `data/osm/twente-full-foliage-fix-batched-2048m/mosaic.json`, and `data/osm/twente-full-foliage-fix-batched-4096m/mosaic.json` (both foliage ON and OFF) and inspects the ranked worst-frame attribution and optional `--trace-out` trace to select the next optimization ticket.

## References

- Evaluation & benchmark guide: [`docs/reports/tkt039-streaming-fluidity-profiling.md`](../docs/reports/tkt039-streaming-fluidity-profiling.md)
- Core implementation: `src/world/tiling/StreamingProfiler.ts`, `src/world/tiling/StreamingFluidityStats.ts`, `src/world/tiling/TileStreamManager.ts`, `src/world/tiling/TileSceneReconstructor.ts`, `src/scene/CameraController.tsx`, `src/scene/MapScene.tsx`
- Tests & runner: `src/world/StreamingFluidityProfiling.test.ts`, `benchmarks/streamingFluidityRunner.ts`
