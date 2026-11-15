---
id: TKT-017
title: Benchmark Infrastructure Reliability & Windows Compatibility
type: bug
status: in_progress
priority: high
created: 2026-11-15
updated: 2026-11-15
---

# TKT-017: Benchmark Infrastructure Reliability & Windows Compatibility

## Summary
Make the CPU and WebGL browser benchmarking infrastructure (`benchmarks/`, `src/types/BenchmarkTelemetry.ts`, `src/scene/MapScene.tsx`, `src/app/App.tsx`, `src/scene/CameraController.tsx`, `package.json`) reliable, reproducible, and usable out-of-the-box on Windows hardware without manual source-code edits or npm dependency workarounds.

**Constraint**: Measurement reliability and cross-platform compatibility only — no renderer optimization, geometry redesign, or production default changes.

## Confirmed Defects & Root Causes

1. **P0 — GPU Telemetry Field Mismatch & Stale Query Caching**:
   - `MapScene.tsx` emitted `gpuPassTimeMs`, `gpuTimerQuerySupported`, and `gpuDisjointOccurred`, while `benchmarks/browserRunner.ts` read `gpuFrameTimeMs`, `gpuTimerSupported`, and `gpuTimerDisjoint`.
   - Async `EXT_disjoint_timer_query_webgl2` queries could also return stale cached durations while a new query was pending.
2. **P0 — Railway Telemetry Always Zero During Benchmarks**:
   - `MapScene.tsx` returned early in `useFrame` whenever `__BENCHMARK_ACTIVE__` was `true` before computing railway frustum visibility, and the benchmark collector omitted railway fields so `browserRunner.ts` defaulted them to `0`.
3. **P1 — Stale `{ 1, 4, 2, 0 }` Static Scene Statistics**:
   - `loadOfflineDataset()` resolved after two `requestAnimationFrame` ticks rather than waiting for React state commit, `GeometryBuilder.buildScene`, and the first WebGL `gl.render()`, so `getSnapshot()` read stale `benchmark_idle` ground-only geometry and stale React closure refs.
   - Additionally, `browserRunner.ts` silently reused `http://127.0.0.1:3000` when active, risking benchmarking a stale `DISABLE_HMR=true` server instead of current workspace files.
4. **P1 — R3F Frame Timing Order & React State Overhead**:
   - `useFrame(..., 0)` runs *before* `gl.render(scene, camera)` (observing `k-1` render stats), and sweep scenarios triggered `setExplicitPose` React state updates per frame.
5. **P2 — Software Rasterizer Forced by Default & Windows Compatibility Failures**:
   - Chromium always launched with `--use-gl=angle` and `--use-angle=swiftshader`.
   - `package.json` had `"esbuild": "^0.25.0"` conflicting with `vite@^8.3.0` (`^0.27.0 || ^0.28.0`), omitted `playwright`, and retained a Linux-only `package-lock.json` that dropped Windows optional bindings (`@rolldown/binding-win32-x64-msvc`, `@tailwindcss/oxide-win32-x64-msvc`).
   - `browserRunner.ts` spawned `npx tsx server.ts` (`ENOENT` on Windows), and PowerShell split unquoted comma-separated CLI arguments.

## Changes Implemented

- **Shared Telemetry Contract (`src/types/BenchmarkTelemetry.ts`)**:
  - Defined canonical `BenchmarkFrameTelemetry`, `BenchmarkHarnessSnapshot`, `SceneRevisionConfigMeta`, and `ExpectedSceneReadinessSpec`.
  - Implemented pure helpers `resolveGpuFrameTelemetryState` (`'valid' | 'pending' | 'disjoint' | 'unsupported'`, accepting `0 ms`, never returning stale cached values or substituting CPU time), `shouldSampleRailwayVisibilityForFrame` (`RAILWAY_VISIBILITY_SAMPLING_STRIDE = 4`, plus frame `0` and final frame), `computeConsecutiveFrameIntervalsMs`, and `validateSceneReadinessSnapshot`.
- **Zero-Traversal Railway Telemetry (`src/world/prototype/BenchmarkRailwayTelemetry.ts`)**:
  - Added `buildCachedRailwayIndex` (computed once on scene/prototype commit) and `evaluateCachedRailwayVisibility` (zero `.traverse()`, zero per-frame allocations), distinguishing `'measured'`, `'unsampled'`, `'unavailable'` (`null`), and `'disabled_by_config'` (`0`).
- **Post-Render Telemetry, Imperative Pose Updates & Readiness (`src/scene/MapScene.tsx`, `src/scene/CameraController.tsx`, `src/app/App.tsx`)**:
  - Moved `__BENCHMARK_FRAME_COLLECTOR__` emission strictly after `origRender(scene, renderCamera)` (`emitPostRenderTelemetry`) and fixed async GPU query polling (`resolvedNsThisFrame` reset per frame, `__BENCHMARK_RESET_GPU_TIMERS__` cleanup hook).
  - Registered an imperative camera pose setter (`onRegisterImperativePoseSetter`) updating Three.js camera/controls directly with `invalidate()` and zero React re-renders during sweeps.
  - Added monotonic `transitionRevisionRef`, `scene.groundMesh.userData.__sceneMeta`, live ref-backed `buildLiveHarnessSnapshot()`, and deterministic `waitForSceneReady()` gating `loadOfflineDataset()` / `unloadDataset()`.
- **Cross-Platform CLI, Server Lifecycle & Schema `v1.1.0` (`benchmarks/`)**:
  - Created `benchmarks/cliAndServer.ts` handling Bash, Windows PowerShell space/comma-split lists, repeated flags, `--iterations`, `--swiftshader`, `--require-hardware`, `--headed`, unknown flag errors, direct `spawn(process.execPath, [tsxCli, serverTs], { shell: false, env: { NODE_ENV: 'development', DISABLE_HMR: 'true', PORT } })` (zero `npx`), and cross-platform process-tree teardown (`taskkill` on Windows).
  - Removed forced SwiftShader flags from default Chromium launch arguments (`resolveChromiumLaunchArgs`), always spawning a fresh local server unless `--url` is passed, and added Chromium fallback only when default Playwright executable is absent.
  - Bumped `BENCHMARK_SCHEMA_VERSION` to `'1.1.0'` (`SUPPORTED_BENCHMARK_SCHEMA_VERSIONS: ['1.0.0', '1.1.0']`) with GPU `sampleCounts`, static vs. sampled railway metrics (`null` when unavailable), and `instrumentationOverheadMs`.
- **Dependency & Lockfile Fixes (`package.json`, `bun.lock`, removed `package-lock.json`)**:
  - Upgraded `esbuild` to `^0.28.0`, added `playwright` to `devDependencies`, updated `bun.lock`, and deleted stale Linux-only `package-lock.json`.
- **Automated Regression Tests (`src/world/BenchmarkReliability.test.ts`)**:
  - Added 9 tests covering producer/consumer field compatibility, GPU query state machine & aggregation, scene readiness & idle-geometry rejection, stale snapshot rejection across dataset/config transitions, consecutive frame cadence & FPS math, missing vs. zero railway metrics & cached frustum evaluation, PowerShell/POSIX CLI parsing, and `process.execPath` server spawn + default GPU flags.

## Acceptance Criteria
- [x] Single typed telemetry contract aligning `MapScene.tsx` and `browserRunner.ts` with zero field mismatches.
- [x] Async GPU timer state machine distinguishes `unsupported`, `pending`, `disjoint`, and `valid` (including `0 ms`) without caching stale values or substituting CPU time.
- [x] Non-zero static railway counts and stride-sampled frustum visibility metrics without per-frame `.traverse()`; missing telemetry uses `null` + `'unavailable'`.
- [x] Deterministic scene-readiness validation rejects stale `{ 1, 4, 2 }` or mismatched revision/config snapshots across transitions.
- [x] Post-`gl.render()` consecutive frame intervals and imperative camera sweeps eliminate `k-1` frame skew and per-frame React re-renders.
- [x] Hardware GPU enabled by default (`--swiftshader` opt-in, `--require-hardware` strict enforcement).
- [x] Clean `npm install` / `bun install` compatibility and Windows-safe `tsx` spawning + PowerShell CLI argument parsing.
- [x] Automated tests pass in `BenchmarkInfrastructure.test.ts` + `BenchmarkReliability.test.ts` (`20 / 20`) and headless SwiftShader baselines (`v1.1.0`) regenerate cleanly.
- [ ] **Pending hardware validation**: Execute `npm run bench:browser -- --quick --require-hardware --out benchmarks/results/hardware-rtx4060ti.json` on the target Windows NVIDIA RTX 4060 Ti machine and verify real hardware `gpuFrameRenderTimeMs` (`EXT_disjoint_timer_query_webgl2`) before closing.

## Verification
- Status: **In Progress** (Code, TypeScript lint, benchmark unit tests, and container SwiftShader baselines verified; Windows hardware GPU run & full local test run pending user execution)
- Executed in container (`2026-11-15`):
  - `npx tsx --test --test-concurrency=1 src/world/BenchmarkInfrastructure.test.ts src/world/BenchmarkReliability.test.ts`: Exit code `0` (`20 / 20 passed`, `15` suites)
  - `npx tsx --test --test-concurrency=1 src/world/WorldCoordinates.test.ts src/world/FeatureCoverage.test.ts src/world/GeometryBuilder.test.ts src/world/ElevationAndZIndex.test.ts src/world/JunctionAndTopology.test.ts`: Exit code `0` (`66 / 66 passed`)
  - `npx tsx --test --test-concurrency=1 src/world/PerformanceBaseline.test.ts src/world/RailwayRendering.test.ts src/world/RoadNetworkTopology.test.ts src/world/RailwayNetworkTopology.test.ts src/world/CrossModalTopology.test.ts`: Exit code `0` (`69 / 69 passed`)
  - `npm run bench:cpu`: Exit code `0` (`benchmarks/baselines/cpu-baseline.json`, Schema `v1.1.0`, `0` resource leaks)
  - `npm run bench:browser -- --quick`: Exit code `0` (`benchmarks/baselines/browser-baseline.json`, Schema `v1.1.0`, SwiftShader fallback explicitly labeled `isSoftwareRenderer: true`, valid static geometry e.g. `38` meshes / `27,579` verts / `5,143` tris on `small-real-europatunnel`, real railway visibility e.g. `13/6/33` on switchyard close-zoom)
  - `npm run bench:browser -- --datasets=small-real-europatunnel --configs=production-legacy --scenarios=static_overview --no-save --require-hardware`: Exit code `1` (correctly aborted on SwiftShader with clear diagnostic)
  - `npm run bench:compare -- benchmarks/baselines/cpu-baseline.json benchmarks/baselines/cpu-baseline.json` and `browser-baseline.json`: Exit code `0` (`COMPATIBLE`, `0` regressions)
- Pending on Windows hardware (left `in_progress` intentionally):
  - Clean `npm install` + `npx playwright install chromium` + `npm test` + `npm run bench:browser -- --quick --require-hardware --out benchmarks/results/hardware-rtx4060ti.json`

## Related Files and Documentation
- Source: `src/types/BenchmarkTelemetry.ts`, `src/world/prototype/BenchmarkRailwayTelemetry.ts`, `src/scene/CameraController.tsx`, `src/scene/MapScene.tsx`, `src/app/App.tsx`, `benchmarks/cliAndServer.ts`, `benchmarks/browserRunner.ts`, `benchmarks/cpuRunner.ts`, `benchmarks/compare.ts`, `benchmarks/serializer.ts`, `benchmarks/types.ts`, `benchmarks/environment.ts`, `package.json`
- Baselines: `benchmarks/baselines/cpu-baseline.json`, `benchmarks/baselines/browser-baseline.json` (`v1.1.0`)
- Tests: `src/world/BenchmarkReliability.test.ts`, `src/world/BenchmarkInfrastructure.test.ts`
- Documentation: `docs/benchmarking-and-profiling.md`, `docs/testing-and-diagnostics.md`, `docs/STATUS.md`, `docs/README.md`
