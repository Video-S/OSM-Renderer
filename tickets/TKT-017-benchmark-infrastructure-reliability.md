---
id: TKT-017
title: Benchmark Infrastructure Reliability & Windows Compatibility
type: bug
status: closed
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
5. **P2 — Software Rasterizer Forced by Default, Windows GPU Backend Selection & Compatibility Failures**:
   - Chromium always launched with `--use-gl=angle` and `--use-angle=swiftshader`. Removing those flags allowed Windows Chromium to still fall back to SwiftShader unless ANGLE Direct3D 11 (`--use-gl=angle`, `--use-angle=d3d11`) is explicitly selected on Windows.
   - `package.json` had `"esbuild": "^0.25.0"` conflicting with `vite@^8.3.0` (`^0.27.0 || ^0.28.0`), omitted `playwright`, and retained a Linux-only `package-lock.json` that dropped Windows optional bindings (`@rolldown/binding-win32-x64-msvc`, `@tailwindcss/oxide-win32-x64-msvc`).
   - `browserRunner.ts` spawned `npx tsx server.ts` (`ENOENT` on Windows), PowerShell split unquoted comma-separated CLI arguments, and PowerShell consumed unquoted `--` in `npm run bench:cpu -- --out ...` before `npm` executed.
   - `resolveGitState` returned `"gitCommitSha": "unknown"` silently without explaining missing `.git` directories, unborn `HEAD`, missing `git` binary, or `safe.directory` errors.

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
- **Cross-Platform GPU Backends, CLI, Server Lifecycle & Git Metadata (`benchmarks/`)**:
  - Updated `resolveChromiumLaunchArgs()` in `benchmarks/browserRunner.ts` with configurable `--gpu-backend=<auto|d3d11|vulkan|opengl|metal|swiftshader|default>` (plus `BENCH_GPU_BACKEND`): `'auto'` defaults to `--use-gl=angle --use-angle=d3d11` on Windows (`win32`), leaves Linux and macOS unmodified, and preserves `--swiftshader` and `--require-hardware` strict enforcement.
  - Created `benchmarks/cliAndServer.ts` handling Bash, Windows PowerShell space/comma-split lists, repeated flags, `--iterations`, `--gpu-backend`, `--swiftshader`, `--require-hardware`, `--headed`, unknown flag errors, direct `spawn(process.execPath, [tsxCli, serverTs], { shell: false, env: { NODE_ENV: 'development', DISABLE_HMR: 'true', PORT } })` (zero `npx`), and cross-platform process-tree teardown (`taskkill` on Windows).
  - Standardized documentation and usage messages on direct `npx tsx benchmarks/...` execution when passing CLI flags (avoiding PowerShell's `--` consumption with `npm run ... --`).
  - Enhanced `resolveGitState()` in `benchmarks/environment.ts` to separate `git status --porcelain`, `HEAD` branch, and `HEAD` SHA checks and report explicit `gitMetadataStatus` (`available`, `ci_env_only`, `unborn_head`, `not_a_git_repository`, `git_unavailable`, `dubious_ownership`, `error`) and `gitMetadataReason` without fabricating metadata.
  - Bumped `BENCHMARK_SCHEMA_VERSION` to `'1.1.0'` (`SUPPORTED_BENCHMARK_SCHEMA_VERSIONS: ['1.0.0', '1.1.0']`) with GPU `sampleCounts`, static vs. sampled railway metrics (`null` when unavailable), and `instrumentationOverheadMs`.
- **Dependency & Lockfile Fixes (`package.json`, `bun.lock`, removed `package-lock.json`)**:
  - Upgraded `esbuild` to `^0.28.0`, added `playwright` to `devDependencies`, updated `bun.lock`, and deleted stale Linux-only `package-lock.json`.
- **Automated Regression Tests (`src/world/BenchmarkReliability.test.ts`)**:
  - Added 10 lightweight unit tests across 9 suites covering producer/consumer field compatibility, GPU query state machine & aggregation, scene readiness & idle-geometry rejection, stale snapshot rejection across dataset/config transitions, consecutive frame cadence & FPS math, missing vs. zero railway metrics & cached frustum evaluation, PowerShell/POSIX CLI parsing, `process.execPath` server spawn, Windows/Linux/macOS/SwiftShader/configurable GPU launch flags, and Git reproducibility metadata resolution.
- **Full Test-Suite Resource Isolation (`tickets/TKT-018-full-test-suite-resource-and-memory-investigation.md`)**:
  - Kept `TKT-017` tests lightweight (`~0.2 s`, zero large dataset allocations) and isolated in `.github/workflows/validation.yml`; filed `TKT-018` separately to profile and bound full `npm test` RAM usage on 16 GB Windows machines without modifying geometry algorithms.

## Acceptance Criteria
- [x] Single typed telemetry contract aligning `MapScene.tsx` and `browserRunner.ts` with zero field mismatches.
- [x] Async GPU timer state machine distinguishes `unsupported`, `pending`, `disjoint`, and `valid` (including `0 ms`) without caching stale values or substituting CPU time.
- [x] Non-zero static railway counts and stride-sampled frustum visibility metrics without per-frame `.traverse()`; missing telemetry uses `null` + `'unavailable'`.
- [x] Deterministic scene-readiness validation rejects stale `{ 1, 4, 2 }` or mismatched revision/config snapshots across transitions.
- [x] Post-`gl.render()` consecutive frame intervals and imperative camera sweeps eliminate `k-1` frame skew and per-frame React re-renders.
- [x] Hardware GPU enabled by default (`--use-gl=angle --use-angle=d3d11` on Windows via `--gpu-backend=auto`, native defaults on Linux/macOS, configurable `--gpu-backend`, opt-in `--swiftshader`, strict `--require-hardware`).
- [x] Clean `npm install` / `bun install` compatibility, Windows-safe `tsx` spawning, direct `npx tsx` flag-passing guidance for PowerShell, and honest `resolveGitState` diagnostics.
- [x] Automated benchmark tests pass (`BenchmarkInfrastructure.test.ts` + `BenchmarkReliability.test.ts`) and headless SwiftShader baselines (`v1.1.0`) regenerate cleanly.
- [x] **Windows hardware smoke test verified by owner (`2026-11-15`)**: NVIDIA GeForce RTX 4060 Ti (ANGLE Direct3D 11, `isSoftwareRenderer: false`), `59.88 FPS` median, `0.5 ms` CPU render, `0.607 ms` GPU render (`60/60` valid timer samples), `58` constructed meshes, `36` static / `21` sampled active railway meshes, `0` errors; CPU suite completed all 12 workloads with `0` errors and `0` leaks.
- [x] **Windows hardware verification (`--quick`) completed by project owner (`2026-11-15`, commit `ea5848e52e51`, `gitDirty: true`)**: Verified `NVIDIA GeForce RTX 4060 Ti` with ANGLE Direct3D 11 (`isSoftwareRenderer: false`, SwiftShader disabled), `20/20` browser scenarios completed (`--quick` subset: `2` datasets × `2` configs × `5` scenarios; not the exhaustive hardware matrix), `238/240` valid GPU timer samples + `2` `pending` frames, `0` benchmark errors, `0` unsupported metrics, `4` scene-reload lifecycle audits passed with `0` WebGL resource leaks, `12/12` CPU workloads completed with `0` errors and `0` disposal leaks, and `21/21` focused benchmark tests passing.

## Verification
- Status: **Closed — Verified (`--quick` Windows Hardware + Full CPU Suite + Focused Tests)**
- Owner Windows RTX 4060 Ti hardware verification (commit `ea5848e52e51`, `gitDirty: true`, `2026-11-15`):
  - **GPU / Backend**: `NVIDIA GeForce RTX 4060 Ti`, ANGLE Direct3D 11 (`isSoftwareRenderer: false`, SwiftShader disabled)
  - **Browser `--quick` suite** (`npx tsx benchmarks/browserRunner.ts --quick --require-hardware ...`): `20/20` scenarios completed (`--quick` coverage: `small-real-europatunnel` and `synthetic-stress-urban-switchyard` across `production-legacy` and `surface-first-e2plus-rplus`; exhaustive multi-dataset hardware matrix not run in `--quick` mode), `238/240` valid GPU timer samples (`2` correctly classified as `pending`), `0` benchmark errors, `0` unsupported metrics, `4` scene-reload lifecycle audits passed with `0` detected WebGL resource leaks
  - **Initial hardware smoke test**: `59.88 FPS` median, `0.5 ms` median CPU render, `0.607 ms` median GPU render (`60/60` valid GPU timer samples), `58` constructed meshes, `36` static / `21` sampled active railway meshes, `0` errors
  - **CPU suite**: `12/12` workloads completed with `0` errors and `0` resource-disposal failures
- Container verification (Linux, headless SwiftShader fallback for WebGL, `2026-11-15`):
  - `npx tsx --test --test-concurrency=1 src/world/BenchmarkInfrastructure.test.ts src/world/BenchmarkReliability.test.ts`: exit `0` — `21/21` passed across `16` suites (`0` failed, `0` skipped)
  - `npm run lint` (`tsc --noEmit`) & `npm run build` (`vite build`): exit `0` (`0` TypeScript or bundle errors)
  - `npm run bench:cpu`: exit `0` — `12/12` CPU workloads completed, `0` leaks, schema `v1.1.0`, `benchmarks/baselines/cpu-baseline.json` updated (`gitMetadataStatus: "not_a_git_repository"`)
  - `npx tsx benchmarks/browserRunner.ts --quick --swiftshader`: exit `0` — `4` workloads × `5` scenarios (`20/20` scenarios), `isSoftwareRenderer: true`, `gpuBackendRequested: "swiftshader"`, `0` errors
  - Schema load + `npx tsx benchmarks/compare.ts` self-comparison on `benchmarks/baselines/cpu-baseline.json` and `benchmarks/baselines/browser-baseline.json`: exit `0` (`COMPATIBLE`, `0` regressions)

## Related Files and Documentation
- Source: `src/types/BenchmarkTelemetry.ts`, `src/world/prototype/BenchmarkRailwayTelemetry.ts`, `src/scene/CameraController.tsx`, `src/scene/MapScene.tsx`, `src/app/App.tsx`, `benchmarks/cliAndServer.ts`, `benchmarks/browserRunner.ts`, `benchmarks/cpuRunner.ts`, `benchmarks/compare.ts`, `benchmarks/serializer.ts`, `benchmarks/types.ts`, `benchmarks/environment.ts`, `package.json`
- Baselines: `benchmarks/baselines/cpu-baseline.json`, `benchmarks/baselines/browser-baseline.json` (`v1.1.0`)
- Tests & Follow-Up: `src/world/BenchmarkReliability.test.ts`, `src/world/BenchmarkInfrastructure.test.ts`, `tickets/TKT-018-full-test-suite-resource-and-memory-investigation.md`
- Documentation: `docs/benchmarking-and-profiling.md`, `docs/testing-and-diagnostics.md`, `docs/STATUS.md`, `docs/README.md`
