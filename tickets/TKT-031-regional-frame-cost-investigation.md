---
id: TKT-031
title: Regional Frame-Cost Attribution and Low-Risk Runtime Efficiency
type: performance-investigation
status: implementation_in_progress
priority: high
created: 2026-11-21
updated: 2026-11-21
related_tickets:
  - TKT-028-F1
  - TKT-029
  - TKT-030
---

# TKT-031 — Regional Frame-Cost Attribution & Low-Risk Runtime Efficiency

## Objective

Determine **why the detailed OSM renderer slows down at large camera footprints**, then implement only small, measurable improvements to redundant runtime work. Preserve existing OSM feature fidelity, E2+/R+ road and railway surfaces, tile layouts and camera freedom.

The owner has accepted the visual quality and close-range responsiveness of the 1,024 m tile candidate. The remaining unknown is the performance of a 16.384 km Hengelo–Enschede overview and the relative cost of **draw submissions, geometry/overdraw, scene traversal, tile selection, streaming/commit spikes and diagnostics**. Do **not** infer an overall rendering limit from the read-only TKT-030 result.

**Decision at the end:** Which measured bottleneck is worth addressing next? It is acceptable to conclude that the current detailed rendering is sufficient at intended gameplay zoom, or that a separately designed offline overview/LOD tier is needed. This ticket does not implement LOD.

## Existing evidence and code touchpoints

- **TKT-028-F1 canonical Hengelo (Windows RTX 4060 Ti, matched 512 m preload / 1,024 m retention, 1,024 m tiles):** far-overview ~1,224 WebGL draw calls and ~16.38 ms median frame interval (two-run aggregate). The owner's interactive 1,024 m experience was described as smooth, though visible tile loading remains. The 4 km results are **not** a 16 km benchmark.
- **TKT-029:** opt-in 16 x 16 grid of 1,024 m LOD0 tiles split across 16 SQLite shards, `?m2a=1&region=twente-pilot`. Its canonical regional bake, data verification, seam QA and hardware performance checks are independent outstanding gates. Do not claim this data is available unless verified.
- **TKT-030:** 16 canonical 1,024 m Hengelo tiles: 1,118 static mesh records / 150 existing instanced batches. A strict 256 m *post-merge* compatibility audit predicts only three fewer mesh submissions (~0.2%). This does not measure GPU performance or the gains of changing renderer architecture. Existing `GeometryBuilder.ts` already merges road classes, planar subtypes and building material buckets, and instances foliage / sleepers.
- `src/scene/MapScene.tsx`: per-frame viewport callback; normal HUD telemetry sorts frame intervals and samples railway visibility on every frame. Frame benchmark collector already captures CPU and GPU/render telemetry.
- `src/app/App.tsx`: forwards camera updates to `tileStreamManagerRef.current?.updateFromCamera(cam)`.
- `src/world/tiling/TileStreamManager.ts`: `updateFromCamera()` invokes zoom update, full `updateViewport()` tile scan, then `tick()` each frame. `pumpFetchQueue()` and `tick()` scan tile states; loading is asynchronous and must continue even if the camera is stationary.
- `src/world/tiling/ThemeMaterialRegistry.ts`: `setCameraZoom()` continues updating railway shader controls when the zoom has not changed.
- `src/world/GeometryBuilder.ts`: foliage `InstancedMesh` groups are deliberately flagged `frustumCulled=false`. `TileSceneReconstructor.ts` restores recorded flags and bounding volumes. Treat changing this as a controlled experiment, **not** a presumed safe fix.
- `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`: existing 128 m spatial chunks and alternative close/far railway geometry. Chunk-size changes are explicitly deferred here.

## Work packages (ordered)

### A — Establish a reliable baseline before any optimization

1. Extend `benchmarks/tileStreamingRunner.ts` / shared benchmark helpers, **reusing current frame telemetry**, to support the **regional pilot** only if the complete, verified TKT-029 `mosaic.json` and packs are present. Existing canonical Hengelo datasets and benchmark modes must remain functional.
2. Run canonical 1,024 m Hengelo first, then the verified regional 16 km dataset on the owner's hardware. If the regional pack is absent, record a **blocked regional measurement**, not a synthetic replacement or an invented result. Do not rebake data as a side effect of the benchmark.
3. Capture fixed, reproducible camera positions for: street close-up, neighborhood/city view, entire 4 km Hengelo overview (comparison), 16 km regional overview, active pan, and settled post-pan. Preserve the user's existing unrestricted zoom controls. Report the exact pose, zoom, viewport, DPR, shadows, theme, GPU/backend, measured/warmup frames, tile size and physical preload/retention margins.
4. Collect for each scenario: median/p95/p99 frame intervals, CPU `gl.render()` time, GPU timer status + timing only when actually supported, WebGL calls and triangles, material-group submissions versus mesh counts, loaded/visible/cullable objects by layer, loaded tiles and geometry/BVH memory, frame spikes during decode/reconstruction/commit, and telemetry overhead. Distinguish first-load spikes from steady state.
5. Record at least **three independent, paired** baseline / candidate measurements for each experiment under identical settings. Do not mistake a change in frame cap, VSync, resolution, shadows, tile residency or warm caches for an optimization.

### B — Attribution: identify where real rendering work goes

1. Add **benchmark-only** analysis to separate draw work from:
   - static mesh and existing instanced-batch submissions;
   - multi-material geometry groups (notably roof/wall);
   - tiles/layers (roads, parks/landuse, railways, buildings, foliage, etc.);
   - main color rendering versus other passes, especially shadow passes, where supported by instrumentation.
2. Reconcile any attributed counts with `renderer.info.render.calls`. Where exact attribution is not possible without intrusive instrumentation, label the values **estimated** and document the mismatch. Do not claim per-layer WebGL draw calls based only on visible mesh counts or the bake header's `totalDrawCalls`.
3. Separate **main-thread frame work** (viewport selection, queue scans, shader updates, telemetry, reconstruction/commit) from `gl.render()`. Keep profiling overhead opt-in and measurable. If additional instrumentation distorts a benchmark, compare instrumented and uninstrumented runs, and rely on the latter for FPS conclusions.
4. Produce a **ranked cost attribution** for close, city and regional views. Note where GPU timers are unavailable, rather than substituting fabricated GPU numbers.

### C — Isolated low-risk experiments, one change at a time

All candidate changes must have **disabled/default-baseline behavior for A/B testing** until measurements and tests justify enabling them.

1. **Avoid redundant viewport selection:** gate `TileStreamManager.updateViewport()` on meaningfully changed projected ground bounds/focus/zoom/streaming policy, rather than doing a full tile scan for identical camera state. **Do not gate `tick()`, completed fetch/decode handling, queued requests, priority changes, cancellation or eviction when needed.** Correctness at tile boundaries, after camera resize/rotation, across fast pans, and when a tile finishes asynchronously is mandatory.
2. **Avoid redundant zoom propagation:** prevent unchanged zoom values from retraversing loaded tiles and re-updating railway material controls. Preserve new-tile initialization at the current zoom, thresholds around 4.5 px/m, theme changes, and any newly registered shader controls. Test zoom-in/zoom-out cycles, including exact threshold crossings.
3. **Reduce non-benchmark HUD overhead:** measure and, if justified, throttle the normal `MapScene.tsx` telemetry percentile sorting and railway visibility sampling, preserving dashboard accuracy at its advertised update cadence. Keep benchmark frame collection semantics stable and avoid introducing React or per-frame allocations just to count overhead.
4. **Optional, separately gated foliage culling experiment:** only if baseline shows meaningful foliage submission cost, validate `InstancedMesh` bounds and world transformations (including regional tile offsets and shadow passes) and try batch-level frustum culling. Do not enable it by default until synthetic visibility-boundary tests and human inspection demonstrate no missing trunks/canopies. This is **batch-level**, not per-tree, culling. If evidence is weak, skip this experiment.

For every candidate: capture before/after timing, WebGL calls, visible geometry and memory where relevant. **Revert a candidate that only adds complexity or causes a material regression without reproducible benefit.** Keep useful telemetry tooling independent of unproven tweaks.

### D — Correctness and acceptance

Automated tests must cover:

- Stationary viewport still processes async fetch completion and commits; queued/newly ready tiles are not starved.
- Tiny camera changes within a tile and camera changes crossing tile/overhang bounds; resize, camera direction/tilt and rapid teleports still select/cancel/evict the correct tiles.
- Repeated pan/zoom and tile reload do not leak geometry/BVHs/instances; preserve existing lifecycle assertions and render/inspection metadata.
- Railway close/far zoom switching, surface/underground flags, material/theme state and shader control registration work unchanged.
- Optional foliage frustum culling cannot remove geometrically visible instances, including near tile edges and with regional coordinate rebasing.
- TKT-029 shard continuity and E2+/R+ surface/portal/railway invariants are unaffected. **No LLM visual testing.** The project owner performs final human visual QA.

Required engineering gates: `npm run lint`, relevant targeted Node tests, `npm run build`, existing streaming lifecycle tests and canonical E2+/R+ regression tests. The ticket must document **exact runnable commands** and output paths after the harness is extended.

### E — Deliverables and decision gate

- A reproducible **JSON + Markdown performance report** under `benchmarks/results/`, with provenance, full input flags, run-by-run results, and median/p95/p99 comparison. Commit methodology/small summaries; large owner hardware artifacts may remain local but must be provided for review.
- A table of actual major costs, evidence confidence (measured vs estimated), and measured benefit/regression for each individual experiment.
- Explicit comparison: **static close-up vs regional overview** and **active streaming vs settled frame**. Do not mix them into one FPS headline.
- Owner-facing recommendation with one of three outcomes:
  1. Runtime cleanup is sufficient for the intended camera scale — stop.
  2. An identified draw/CPU/culling hotspot justifies a separate *specific* follow-up ticket (e.g. railway chunk-size A/B).
  3. Complete-region overview is fundamentally wasteful at LOD0 at the required zoom — propose a **new offline overview/LOD design ticket**, not an implementation in TKT-031.
- Keep TKT-029 regional validation/visual sign-off independent of this performance work.

## Hard non-goals

- **No** LOD1–LOD3, geometry simplification, reduced OSM fidelity, gameplay/zoom restrictions, tile-size retuning, baked format changes, or new generic mesh batching.
- **No** visual design or shadow policy decision. Shadows must be held constant between A/B tests; distinguish their pass cost if measured, but do not optimize by silently disabling them.
- **No** automatic PR promotion or claims of regional production readiness without the 256-tile dataset verification and owner hardware results.
- **No** inference that the 0.2% TKT-030 post-merge result is an upper bound on rendering improvements.

## First implementation pass (2026-11-21)

**Branch:** `tkt-031-regional-frame-cost-investigation`, stacked on TKT-030. First implementation only: no canonical regional frame-cost findings are claimed.

### Implementation

- `src/world/tiling/RenderWorkAttribution.ts` is a pure material-group submission estimator, called only by the existing benchmark scene snapshot. It distinguishes static/instanced meshes and groups. It is a main-camera color-pass proxy; actual shadow draw calls are not attributed.
- `TileStreamManager.ts` has separately **opt-in** `experimentSkipUnchangedViewport` / `experimentSkipUnchangedZoom` gates. The unchanged viewport gate uses exact projected bounds + focus + zoom equality, retains `tick()` on every frame, resets on manifest reload, and forces re-evaluation after failed async tile fetches. Counters record scans, skips and zoom skips.
- `App.tsx` permits visual `perfViewportGate=1` and `perfZoomGate=1` URL flags and benchmark-harness equivalents. The ordinary renderer remains unchanged.
- `benchmarks/tileStreamingRunner.ts` supports `--experiment-skip-unchanged-viewport` and `--experiment-skip-unchanged-zoom`, preserves these flags in report provenance, and records material-group estimates/counters.
- `benchmarks/regionalFrameCostRunner.ts` is a dedicated, opt-in **actual 16 km** hardware benchmark. It requires an already-baked complete TKT-029 mosaic (verifies every shard/tile), checks the served API against the canonical snapshot, reuses the existing browser harness, and measures street/city/whole-region, active teleport and settled post-teleport phases. `--compare=viewport`, `--compare=zoom` or `--compare=both` includes baseline and alternates order across runs. **Teleport is not a smooth-pan workload.**
- `src/world/Tiling031RuntimeEfficiency.test.ts` covers pure group counts, instancing, exact viewport equality, CLI options and a stationary-camera HTTP-error retry fixture.

### Commands — Windows PowerShell

Terminal A, project checkout:

    git fetch origin
    git switch --track origin/tkt-031-regional-frame-cost-investigation
    npm run lint
    npx tsx --test src/world/Tiling031RuntimeEfficiency.test.ts
    npm run build
    npm run dev

Terminal B, after the 256-tile regional dataset exists (the server from terminal A must be running):

    npm run osm:verify-regional-mosaic
    npx tsx benchmarks/regionalFrameCostRunner.ts --compare=none --runs=3

For isolated, paired comparisons:

    npx tsx benchmarks/regionalFrameCostRunner.ts --compare=viewport --runs=3 --out=benchmarks/results/tkt031-viewport.json --markdown-out=benchmarks/results/tkt031-viewport.md
    npx tsx benchmarks/regionalFrameCostRunner.ts --compare=zoom --runs=3 --out=benchmarks/results/tkt031-zoom.json --markdown-out=benchmarks/results/tkt031-zoom.md

On the owner's npm/PowerShell setup, `npm run bench:regional -- --compare=viewport --runs=3` did **not** forward options. npm emitted `Unknown cli config` and the actual benchmark report declared `compare=none`. Invoke `npx tsx` directly as shown above and verify the report's `protocol.compare` is `viewport` or `zoom`. Do not interpret repeated baseline-only runs as an A/B result.

Output defaults:

- `benchmarks/results/tkt031-regional-frame-cost.json`
- `benchmarks/results/tkt031-regional-frame-cost.md`

Set distinct `--out=...` and `--markdown-out=...` for each comparison so one run does not overwrite another. Hardware WebGL2 is required by default; `--allow-software` permits a **non-hardware** smoke test only.

Existing 4 km Hengelo benchmark:

    npm run bench:tiles -- --dataset=canonical-hengelo --tile-size=1024 --match-physical-margins --modes=m2a_streaming --scenarios=closeup_station,medium_navigation,far_overview --runs=3 --require-hardware

Add one of the opt-in experiment flags above, capture a separate output path, and compare against an unchanged baseline.

### Uncompleted

- The owner has verified the actual regional SQLite mosaic and recorded a 3-run hardware **baseline** on an RTX 4060 Ti. GitHub CI typecheck/build passed on the implementation branch; targeted tests/other acceptance gates need separate confirmation. No *optimized variant* has yet been measured, and human visual QA is still outstanding.
- Exact draw/pass attribution beyond material-group proxy is not implemented. Improve it only if measured costs justify its intrusion.
- HUD telemetry throttling and foliage culling remain deferred pending baseline evidence.
- TKT-029 cross-shard geometry continuity and human visual sign-off are separate gates. The mosaic verifier validates binary/manifest integrity, not visual or graph parity.

### Owner's regional hardware baseline (2026-11-21)

Attached owner outputs: `tkt031-regional-frame-cost.json` and `tkt031-regional-frame-cost.md` (generated at 22:45Z). Source is the complete 16×16 1024m pilot mosaic: 16 verified shards, 256/256 nonempty tiles, 235.68 MiB compressed; renderer ANGLE/D3D11 NVIDIA RTX 4060 Ti, 1440×900×1. The report says **`protocol.compare=none` and all 3 experiments `baseline`**; therefore no viewport-gating speedup, safety or regression has been established.

Repeated **measured** steady-state results (range of 3 run medians):

| Pose | Loaded tiles | WebGL calls/frame | Main-camera material-group proxy | Frame median | CPU gl.render median | GPU pass median |
|---|---:|---:|---:|---:|---:|---:|
| Street | 16 | 366 | 162 | 16.60–16.65 ms | 2.05–2.50 ms | 3.60–3.93 ms |
| City | 36 | 802 | 506 | 16.60–16.70 ms | 3.40–3.50 ms | 6.29–6.46 ms |
| Region overview | 256 | 7,373 | 6,593 | 42.60 ms (~23.5 FPS) | 42.10–42.20 ms | 42.29–42.46 ms |

The regional overview submitted **229.7 million triangles per measured frame** (driver/renderer-reported, includes instances and multiple passes; **not** distinct map geometry) with ~15.9 million loaded unique/source triangles. The ~42 ms GPU timer and `gl.render()` measurements implicate render workload/driver/GPU activity rather than proving that tile membership scans dominate. The proxy is **not** precise per-pass attribution and cannot by itself determine the contribution of shadow passes.

**TKT-030 separate canonical Hengelo 16-tile pack audit**: 1,351 submission proxy; at 256 m bounded batching only 3 submissions potentially saved (0.2%), whole-tile unbounded just 7 (0.5%). This is not an upper bound on *all* batch strategies or region-wide opportunities, but is poor justification for implementing the currently conservative batching candidate.

**Immediate next gate**: rerun `npx tsx benchmarks/regionalFrameCostRunner.ts --compare=viewport --runs=3 ...` and confirm both `baseline` and `viewport` rows and nonzero viewport skip counters. Keep the 16km view separately in the report because its workload is substantially different from ordinary street/city zoom. If viewport gating does not materially change overall frame/GPU timing, prioritize pass-aware rendering diagnostics (e.g., shadow-versus-color and instanced workloads) rather than more stream-manager changes. Keep shadows unchanged in the first A/B tests.

## Completion checklist

- [ ] Existing canonical 1,024 m Hengelo baseline reproduced with exact settings.
- [x] Regional pilot dataset existence/validation confirmed (16 shard/256 tile integrity verification).
- [x] Hardware baseline for street/city/16 km overview and teleport/settled state recorded; **not** an optimization comparison.
- [ ] Actual draw-work and frame-work attribution delivered, with estimates clearly differentiated.
- [ ] Each approved low-risk change A/B tested in isolation; regressions removed.
- [ ] Relevant Node, typecheck, build and lifecycle/E2+/R+ checks pass.
- [ ] Owner human visual QA covers railway thresholds, hover inspection, tile transitions, and any culling change.
- [ ] Final next-step decision supported by the measurements, with no premature LOD or batching implementation.

**Implementation constraint:** Treat this as an investigation with optional isolated fixes, not a general renderer rewrite. The first merged deliverable should be trustworthy instrumentation and an unchanged baseline.
