# TKT-041 — Hierarchical Tile Streaming

- **Status:** `in_progress` (Core architecture, multi-resolution HTTP server, atomic transition manager, bounded resource budgets, UI controls/diagnostics, automated test suite, and synthetic SwiftShader Playwright validation completed; owner RTX 4060 Ti real-data benchmarks and interactive visual QA on full Twente pending)
- **Date Opened:** 2026-11-26
- **Owner:** Project Owner
- **Related ADRs:** [ADR-0011](../docs/decisions/ADR-0011-baked-tiles-and-runtime-streaming.md), [ADR-0012](../docs/decisions/ADR-0012-bounded-regional-mosaics.md), [ADR-0013](../docs/decisions/ADR-0013-regional-camera-zoom-policy.md), [ADR-0014](../docs/decisions/ADR-0014-spatially-accelerated-instanced-feature-picking.md), [ADR-0015](../docs/decisions/ADR-0015-hierarchical-tile-streaming.md)
- **Evaluation Report:** [TKT-041 Hierarchical Tile Streaming Report](../docs/reports/tkt041-hierarchical-tile-streaming.md)

---

## 1. Objective

Unify the independently baked and consolidated `1,024 m`, `2,048 m`, and `4,096 m` `OSMTILE1` v1 regional mosaics into an automatic, zoom-dependent, uniform-viewport hierarchical streaming architecture that preserves:

- Continuous geographic coverage with zero simultaneous multi-resolution overlap.
- Identical canonical world coordinates and consistent rendering appearance across resolutions.
- Active-resolution-only feature picking with cross-resolution attribution parity.
- Bounded memory, bounded SQLite file handles, and time-aware main-thread commits.
- Reliable asynchronous preparation, cancellation, retargeting, and budget deferral.
- Full backward compatibility with existing single-resolution mosaics and the `TKT-040` `combined` preparation pipeline as default.

---

## 2. Implemented Scope

1. **Multi-Resolution Contract & Descriptor Utility**
   - `src/world/tiling/HierarchicalMosaicContract.ts`: `HierarchicalRegionalMosaicDescriptor` schema (`schemaVersion: 1`), 15 compatibility validation error codes (including resolution-aware `lodPolicyHash` derivation matching `OfflineTileConsolidator`), resolution-qualified tile keys (`r${tileSizeMeters}:l${lod}:tx_${tx}_ty_${ty}`), absolute UTM overlap checks, and canonical UTM origin rebasing.
   - `scripts/create-hierarchical-mosaic-descriptor.ts`: Non-destructive CLI utility that validates existing `1,024 m`, `2,048 m`, and `4,096 m` `mosaic.json` files and emits a lightweight descriptor JSON without duplicating SQLite geometry.
2. **Server & HTTP Route Layer**
   - `src/server/tiles/RegionalMosaicHttpHandler.ts` & `src/server/tiles/tilePackHttpHandler.ts`: Auto-detection of single-resolution and hierarchical descriptors via `OVERIJSSEL_HIERARCHICAL_MOSAIC_PATH` (then `OVERIJSSEL_REGIONAL_MOSAIC_PATH`, then pilot default), strict relative-path confinement, one shared bounded LRU SQLite shard handle pool across all resolutions, and strict integer validation on `/api/tiles-region/r/:tileSizeMeters/:lod/:tx/:ty` and `/r/:tileSizeMeters/:snapshotId/:schemaVersion/:lod/:tx/:ty`.
   - `server.ts` & `.env.example`: Mounted resolution-qualified routes ahead of legacy routes and documented `OVERIJSSEL_HIERARCHICAL_MOSAIC_PATH`.
3. **Zoom Selection Policy & Resource Budgeting**
   - `src/world/tiling/HierarchicalResolutionPolicy.ts`: `auto` / `force_1024` / `force_2048` / `force_4096` modes, provisional hysteresis bands (`1024↔2048`: `out < 0.80 / in > 1.00`; `2048↔4096`: `out < 0.26 / in > 0.34`), orthographic viewport-width compensation, direct `1,024 ↔ 4,096` jumps, physical-meter preload/retain margins (`1,024 m` / `2,048 m`), and URL query overrides.
   - `src/world/tiling/HierarchicalResourceBudget.ts`: Configurable total measured budget (`768 MiB`), bounded inactive LRU cache (`192 MiB` / `48` tiles), worker backpressure (`192 MiB`), transition reserve (`0.35`), time-aware frame commit budget (`4.5 ms/frame`), and explicit separation of directly measured CPU/BVH/instanced-index/queued/inactive bytes vs. estimated GPU VRAM.
4. **Runtime Streaming Engine, Atomic Activation, Diagnostics & UI**
   - `src/world/tiling/TileStreamManager.ts` & `src/world/tiling/StreamingProfiler.ts`: Multi-resolution `levelsByResolution`, 4-tier priority queue, off-scene `prepared_inactive` reconstruction, atomic frame-boundary activation (`activatePendingResolutionAtomic`), cancellation/retargeting/mid-transition pan handling, `deferred_budget` safeguard preserving active visible coverage, and hierarchical profiler events.
   - `src/app/App.tsx` & `src/components/workspace/panels/DiagnosticsPanel.tsx`: Live mode switching, editable hysteresis & budget controls, budget-deferral banner, per-resolution measured vs. estimated memory breakdown table, and `window.__BENCHMARK_HARNESS__` APIs.
5. **Automated Tests & Reproducible Benchmark Runner**
   - `src/world/HierarchicalTileStreaming.test.ts`: End-to-end deterministic tests covering contract validation, zoom/hysteresis policy, HTTP multi-resolution server, atomic transitions, zero overlap, canonical world & picking parity, interruptions, LRU cache reuse, impossible-budget deferral + recovery, and single-resolution backward compatibility.
   - `benchmarks/hierarchicalStreamingRunner.ts`: Reproducible Playwright benchmark & validation runner supporting `--descriptor=...` or `--index-1024=... --index-2048=... --index-4096=...`.

---

## 3. Verification Status

### Completed (Sandbox — Synthetic Fixtures & SwiftShader)
- `npx tsx --test src/world/HierarchicalTileStreaming.test.ts`: **4/4 passed**.
- Existing tiling, consolidation, picking, profiling, non-blocking prep, zoom policy, and UI regression suites: verified (see report).
- End-to-end synthetic 3-resolution (`1,024 m` / `2,048 m` / `4,096 m`) descriptor generation (`scripts/create-hierarchical-mosaic-descriptor.ts`) and Playwright SwiftShader run (`benchmarks/hierarchicalStreamingRunner.ts --allow-software --foliage=on --quick`): verified `0` hysteresis oscillation transitions, `100%` single-resolution attachment invariant, direct `1,024 ↔ 4,096` jumps, warm LRU cache hits, and bounded memory accounting.
- `npm run lint`, `npm run build`, and `npm run docs:api`: verified.

### Open Acceptance Gates (Owner — Real Full-Twente Mosaics & RTX 4060 Ti)
- [ ] Generate hierarchical descriptor against the owner's real Twente `1,024 m`, `2,048 m`, and `4,096 m` mosaics using `scripts/create-hierarchical-mosaic-descriptor.ts`.
- [ ] Execute `benchmarks/hierarchicalStreamingRunner.ts` on the RTX 4060 Ti with `--foliage=both` (no `--allow-software`) and review frame-time distributions, atomic swap times, picking latency/parity, and peak memory on full Twente.
- [ ] Perform interactive visual & navigation QA in the browser (continuous scroll-wheel zoom sweeps, rapid street↔regional jumps, panning during transitions, feature picking across resolutions, and tuning of provisional hysteresis thresholds if needed).
- [ ] Owner explicit sign-off to close `TKT-041`.
