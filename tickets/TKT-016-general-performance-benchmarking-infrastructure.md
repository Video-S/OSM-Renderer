---
id: TKT-016
title: General Performance Benchmarking Infrastructure
type: feature
status: closed
priority: high
created: 2026-11-13
updated: 2026-11-13
---

# TKT-016: General Performance Benchmarking Infrastructure

## Summary
Implement a reproducible, general-purpose performance benchmarking system (`benchmarks/`) for the OSM 3D Renderer measuring Node.js CPU pipeline stages, memory consumption, resource disposal, and real-world Playwright/Chromium WebGL rendering performance, with versioned JSON reporting and automated baseline comparison.

## Context
As OSM Renderer progresses toward larger regions (such as Twente) and evaluates topology-driven road (`E2` / `E2+`) and railway (`E3-A1` / `E3-A2` / `E3-B`) rendering pipelines, engineering decisions require a rigorous, repeatable measurement foundation rather than assumptions. Existing performance utilities (`PerformanceBaselineHarness.ts`, `scripts/run-production-benchmarks.ts`, `scripts/run-e2plus-baseline.ts`, and `MapScene.tsx` telemetry) provide useful subsystem hooks, but lack a unified, subsystem-independent `benchmarks/` architecture with frozen multi-scale datasets, direct stage timings, automated browser scenario runners, versioned JSON reports, and an automated baseline comparison CLI.

## Scope & Constraints
- **Measurement, not optimization**: Do not redesign the renderer, alter batching strategies, modify geometry generation algorithms, or introduce spatial tiling.
- **Offline determinism**: All benchmark datasets must be frozen locally with SHA-256 content hashes and must never depend on live OpenStreetMap / Overpass network calls.
- **Direct stage measurement**: Measure CPU pipeline stages directly rather than estimating subsystem cost by subtracting unrelated full-scene runs.
- **Honest WebGL telemetry**: Record actual `gl.info.render.calls` and `gl.info.render.triangles`, distinguish frame interval from CPU render call duration and GPU timer queries (`EXT_disjoint_timer_query_webgl2`), explicitly report unsupported/disjoint GPU timers without fabricating values, and clearly label software rendering (e.g., ANGLE/SwiftShader).

## Acceptance Criteria
- [x] Dedicated `benchmarks/` architecture separating datasets, scenario definitions, CPU benchmark execution, browser WebGL benchmark execution, statistical aggregation, JSON report serialization, and baseline comparison.
- [x] Single-command scripts in `package.json`: `npm run bench:cpu`, `npm run bench:browser`, and `npm run bench:compare`.
- [x] Frozen, reproducible offline benchmark datasets with recorded dataset IDs, SHA-256 content hashes, and feature counts (covering at minimum a small real-world OSM extract, a larger complex real-world extract, and a synthetic stress-test dataset).
- [x] Node.js CPU benchmark runner measuring GeoJSON parsing/classification, infrastructure graph construction, graph-to-renderer adaptation, planar surface resolution, road/railway geometry generation, full-scene geometry generation, scene resource disposal, and CPU/V8 memory consumption with warm-up iterations and median/p95 statistics.
- [x] Playwright + Chromium browser benchmark runner executing deterministic scenarios (static overview, static close zoom, automated camera pan, camera zoom/orbit sweep, and repeated scene load/unload) while suppressing HUD React state updates during measurement.
- [x] Browser runner collects median/p95/p99 frame intervals, CPU frame render times, actual WebGL draw calls (`gl.info.render.calls`), rendered triangles (`gl.info.render.triangles`), GPU timer queries (or explicit unsupported/disjoint status), WebGL driver resource counts, browser JS heap metrics, and scene initialization/first-render latency, clearly labeling hardware vs. software (SwiftShader) WebGL renderers.
- [x] Versioned, validated JSON report schema (`1.0.0`) and comparison tool (`npm run bench:compare`) computing absolute and percentage deltas, flagging incompatible datasets or configurations, handling missing/unsupported metrics explicitly, and supporting configurable regression thresholds.
- [x] Automated test suite (`src/world/BenchmarkInfrastructure.test.ts`) verifying statistical calculations, schema validation, dataset hashing, CPU runner execution, resource cleanup, baseline comparison, incompatible report detection, and unsupported metric handling.
- [x] Developer documentation (`docs/guides/benchmarking-and-profiling.md`, plus updates to `docs/guides/testing-and-diagnostics.md`, `docs/README.md`, and `docs/STATUS.md`) covering execution, metric definitions, memory/GPU measurement limitations, and Node.js / Chrome DevTools / WebGL profiling workflows.
- [x] Existing application behavior, geometry output, `npm test`, `npm run lint`, `npm run build`, and `npm run docs:api` pass without regressions.

## Implementation notes
- Reuses `SceneResourceManager.getCpuBufferMemoryStats()`, `computeGroupGeometryStats()`, `LocalGeoJsonProvider`, `buildInfrastructureGraph`, `adaptInfrastructureGraphToRenderDescriptors`, `resolveAndValidatePlanarPolygons`, `GeometryBuilder`, and `MapScene` WebGL telemetry.
- Adds `?benchmark=1` mode and `window.__BENCHMARK_HARNESS__` hooks in `src/app/App.tsx` and `src/scene/MapScene.tsx` to allow loading frozen datasets in-memory without live Overpass fetches and capturing per-frame telemetry without triggering React HUD re-renders during measurement windows.

## Verification
- Status: Passed & Verified (`2026-11-13`)
- Verification steps & results:
  - `npx tsx --test src/world/BenchmarkInfrastructure.test.ts`: Exit code `0` (`11 / 11 passed`, `6` suites)
  - Full test suite (`src/world/*.test.ts` across 24 test files): Exit code `0` (`331 / 331 passed`, `0` failures)
  - `npm run lint` (`tsc --noEmit`): Exit code `0` (`0` TypeScript errors)
  - `npm run build` (`vite build`): Exit code `0` (`dist/` generated)
  - `npm run docs:api` (`typedoc`): Exit code `0` (`docs/api-reference/` generated)
  - `npm run bench:cpu`: Exit code `0` (`benchmarks/baselines/cpu-baseline.json` generated across 4 datasets x 3 renderer configs, `0` resource leaks)
  - `npm run bench:browser -- --quick`: Exit code `0` (`benchmarks/baselines/browser-baseline.json` generated across 5 deterministic scenarios per workload, `isSoftwareRenderer: true` explicitly labeled for SwiftShader)
  - `npm run bench:compare -- benchmarks/baselines/cpu-baseline.json benchmarks/baselines/cpu-baseline.json`: Exit code `0` (`COMPATIBLE`, `0` regressions)
  - `npm run bench:compare -- benchmarks/baselines/browser-baseline.json benchmarks/baselines/browser-baseline.json`: Exit code `0` (`COMPATIBLE`, `0` regressions)

## Related files and documentation
- Source: `benchmarks/`, `src/world/prototype/PerformanceBaselineHarness.ts`, `src/scene/MapScene.tsx`, `src/app/App.tsx`
- Baselines: `benchmarks/baselines/cpu-baseline.json`, `benchmarks/baselines/browser-baseline.json`
- Tests: `src/world/BenchmarkInfrastructure.test.ts`, `src/world/PerformanceBaseline.test.ts`
- Documentation: `docs/guides/benchmarking-and-profiling.md`, `docs/guides/testing-and-diagnostics.md`, `docs/README.md`, `docs/STATUS.md`

