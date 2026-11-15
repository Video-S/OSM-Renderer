# Performance Benchmarking & Developer Profiling Guide

This document describes the reproducible performance benchmarking infrastructure (`benchmarks/`) introduced in `TKT-016` and hardened in `TKT-017`, how to execute CPU and WebGL browser benchmarks across Windows, Linux, and macOS, how to compare baseline and candidate reports, and how to profile CPU, memory, and WebGL bottlenecks.

---

## 1. Architecture Overview & Prerequisites

### 1.1 Runtime Prerequisites & Clean Installation
- **Node.js**: `>= 22.12.0` (required by Vite 8).
- **Clean Install (Windows / macOS / Linux)**:
  ```bash
  npm install
  npx playwright install chromium
  ```
  - Do **not** use `--force` or `--legacy-peer-deps`. (`esbuild@^0.28.0` and `playwright` are declared in `package.json`, and stale Linux-only lockfiles are excluded so npm resolves platform-specific native packages such as `@rolldown/binding-win32-x64-msvc` and `@tailwindcss/oxide-win32-x64-msvc` cleanly on Windows.)
  - `benchmarks/cliAndServer.ts` spawns the local `tsx` entrypoint directly via `process.execPath` (`node.exe` on Windows) without calling `npx`, preventing `spawn npx ENOENT` failures.
  - **CLI Argument Passing Note (`npx tsx` vs. `npm run`)**: Zero-argument defaults work via `npm run bench:cpu` and `npm run bench:browser`. Whenever passing CLI flags (especially on **Windows PowerShell**, where unquoted `--` is consumed by PowerShell as an end-of-parameters token causing `npm` to swallow `--out` and other flags), invoke `npx tsx` directly (`npx tsx benchmarks/cpuRunner.ts ...`, `npx tsx benchmarks/browserRunner.ts ...`, `npx tsx benchmarks/compare.ts ...`).

### 1.2 Module Responsibilities

The benchmarking system is organized under `/benchmarks/` (with the shared browser telemetry contract in `src/types/BenchmarkTelemetry.ts`) and is decoupled from individual renderer subsystems:

| Module | Responsibility |
| :--- | :--- |
| `src/types/BenchmarkTelemetry.ts` | Shared typed contract between `MapScene.tsx` / `App.tsx` and `benchmarks/browserRunner.ts`, GPU timer state machine (`resolveGpuFrameTelemetryState`), consecutive frame interval helpers, railway sampling schedule (`RAILWAY_VISIBILITY_SAMPLING_STRIDE = 4`), and scene-readiness validation (`validateSceneReadinessSnapshot`). |
| `src/world/prototype/BenchmarkRailwayTelemetry.ts` | Zero-traversal `CachedRailwayIndex` built on scene commit and O(1)-allocation frustum-visibility evaluator for railway telemetry. |
| `benchmarks/types.ts` | Versioned JSON report schema (`schemaVersion: "1.1.0"`), workload descriptors, statistical types, and comparison report contracts. |
| `benchmarks/datasets.ts` | Frozen, deterministic offline benchmark datasets with SHA-256 content hashes (`contentHashSha256`) and per-category feature counts. |
| `benchmarks/scenarios.ts` | Renderer configurations (`production-legacy`, `graph-e2-e3`, `surface-first-e2plus-rplus`) and deterministic browser camera/lifecycle scenarios. |
| `benchmarks/cliAndServer.ts` | Cross-platform CLI flag parser (handling Bash, PowerShell comma splitting, repeated flags, and `--iterations`) and direct Node-to-`tsx` local server process lifecycle management. |
| `benchmarks/stats.ts` | Quantile (`median`, `p95`, `p99`), mean, standard deviation, interquartile range (`iqr`), coefficient of variation (`cv`), and threshold-based regression evaluation. |
| `benchmarks/environment.ts` | Git commit/branch/dirty state, OS/CPU/RAM metadata, browser/GPU driver strings, hardware vs. software WebGL detection (`SwiftShader` / `llvmpipe`), and canonical metric definitions. |
| `benchmarks/cpuRunner.ts` | Node.js CPU benchmark runner (`npm run bench:cpu`) measuring direct pipeline stages, deterministic typed-array memory, V8 heap snapshots, and `SceneResourceManager` disposal verification. |
| `benchmarks/browserRunner.ts` | Playwright + Chromium WebGL benchmark runner (`npm run bench:browser`) measuring post-`gl.render()` frame intervals, CPU `gl.render()` time, async GPU timer queries, actual `gl.info.render.calls` / `triangles`, static & sampled railway visibility, and scene reload lifecycle leaks. |
| `benchmarks/serializer.ts` | Schema validation (`validateBenchmarkReport` supporting `1.0.0` & `1.1.0`), JSON serialization, and human-readable terminal table formatting. |
| `benchmarks/compare.ts` | Automated baseline vs. candidate comparison engine (`npm run bench:compare`) with schema/dataset/GPU parity checks and configurable regression thresholds. |

---

## 2. Frozen Benchmark Datasets

All benchmark datasets are stored locally in the repository and verified via SHA-256 content hashes. Benchmark execution never queries live OpenStreetMap / Overpass / Nominatim endpoints; in browser mode, Playwright actively blocks all external network requests.

| Dataset ID | Tier | Source | Description |
| :--- | :--- | :--- | :--- |
| `small-real-europatunnel` | `small-real` | `src/world/prototype/EuropatunnelHengeloFixture.json` | Small real-world extract around Europatunnel (Hengelo) with multi-lane roads, cycleways, railway overpasses, and tunnel approaches. |
| `medium-real-hengelo-station` | `medium-real` | `public/sample-map.geojson` | Medium real-world extract covering Station Hengelo (`400m` clip radius) with buildings, station throat tracks, roads, parks, and barriers. |
| `large-real-amsterdam-centraal` | `large-real` | `src/world/RealWorldFixtures.json` (`amsterdam`) | Larger, high-density real-world extract around Amsterdam Centraal (`420m` clip radius) with dense railway switches, canals, bridges, tunnels, and urban blocks. |
| `synthetic-stress-urban-switchyard` | `synthetic-stress` | `createRailwayPrototypeFixtureData()` | Deterministic high-density synthetic stress workload (`60` railway tracks, switches, crossovers, bridges, tunnels, plus dense urban buildings and roads). |

---

## 3. Running Benchmarks

### 3.1 CPU Benchmarks (`npm run bench:cpu`)

Runs in Node.js without requiring a browser or GPU. Directly measures each pipeline stage with warm-up iterations, multiple measured iterations, and explicit resource disposal verification after every run.

**Bash / macOS / Linux:**
```bash
# Run full CPU benchmark suite across all frozen datasets and renderer configs
# Saves report to benchmarks/baselines/cpu-baseline.json
npm run bench:cpu

# Run a fast subset with explicit flags via direct tsx execution
npx tsx benchmarks/cpuRunner.ts --quick --out=benchmarks/results/cpu-candidate.json

# Filter specific datasets, renderer configurations, or sample counts
npx tsx benchmarks/cpuRunner.ts \
  --datasets=small-real-europatunnel,large-real-amsterdam-centraal \
  --configs=production-legacy,surface-first-e2plus-rplus \
  --warmup=2 \
  --iterations=7 \
  --out=benchmarks/results/cpu-custom.json
```

**Windows PowerShell:**
```powershell
# Default full CPU suite (no CLI flags)
npm run bench:cpu

# Passing flags on Windows PowerShell (use direct npx tsx execution so PowerShell/npm do not swallow flags)
npx tsx benchmarks/cpuRunner.ts "--out=benchmarks/results/tkt017-cpu.json"

# Quick CPU subset
npx tsx benchmarks/cpuRunner.ts --quick "--out=benchmarks/results/cpu-candidate.json"
```

**Measured CPU Stages (`CpuPipelineStageTimings`):**
- `geojsonParseAndClassifyMs`: Direct execution time of `LocalGeoJsonProvider.parseGeoJson(...)`.
- `infrastructureGraphBuildMs`: Direct execution time of `buildInfrastructureGraph(...)` (reported when `roads !== 'legacy'` or `railways !== 'legacy'`; `null` in pure legacy mode).
- `graphToRendererAdapterMs`: Direct execution time of `buildInfrastructureRenderDescriptors(...)` (`null` in pure legacy mode).
- `planarSurfaceResolutionMs`: Direct execution time of `resolveRoadSurfaceNetwork(...)` for `surface` mode or `buildGraphRoadRenderData(...)` for `graph` mode (`null` in legacy road mode).
- `roadGeometryGenerationMs`: Direct execution time of `GeometryBuilder.generateRoads(...)`.
- `railwayGeometryGenerationMs`: Direct execution time of `GeometryBuilder.generateRailways(...)`.
- `fullSceneGeometryGenerationMs`: Direct end-to-end execution time of `GeometryBuilder.buildScene(...)` across all scene layers.
- `sceneResourceDisposalMs`: Direct execution time of `BuiltSceneGeometry.dispose()` via `SceneResourceManager`.

### 3.2 Browser & WebGL Benchmarks (`npm run bench:browser`)

Launches Chromium via Playwright, starts or connects to the local application server (`/?benchmark=1&dock=collapsed`), blocks external network requests, waits for deterministic WebGL scene readiness (`validateSceneReadinessSnapshot`), and executes deterministic camera and lifecycle scenarios through the real Three.js / React Three Fiber rendering pipeline.

GPU backend selection (`resolveChromiumLaunchArgs` in `benchmarks/browserRunner.ts`):
- **`--gpu-backend=auto` (default)**: On **Windows (`win32`)**, selects ANGLE Direct3D 11 (`--use-gl=angle`, `--use-angle=d3d11`) so hardware GPUs (NVIDIA/AMD/Intel) are used reliably instead of falling back to SwiftShader. On **Linux and macOS**, applies no Windows-specific ANGLE flags so native hardware WebGL drivers are used when available.
- **Explicit backends**: Pass `--gpu-backend=<auto|d3d11|vulkan|opengl|metal|swiftshader|default>` (or set `BENCH_GPU_BACKEND`) to test a specific backend or `default` (unmodified Chromium default).
- **Explicit software fallback**: Pass `--swiftshader` (or `--gpu-backend=swiftshader`) to force SwiftShader software rendering in headless CI. Cannot be combined with `--require-hardware`.

**Bash / macOS / Linux:**
```bash
# Run full Browser/WebGL benchmark suite and save to benchmarks/baselines/browser-baseline.json
npm run bench:browser

# Run a quick verification pass with hardware GPU required (fails if Chromium falls back to software)
npx tsx benchmarks/browserRunner.ts --quick --require-hardware --out=benchmarks/results/hardware-gpu.json

# Explicitly force SwiftShader software rasterization (useful in headless CI containers)
npx tsx benchmarks/browserRunner.ts --quick --swiftshader --no-save

# Run headed (visible browser window) and filter specific datasets, configs, or scenarios
npx tsx benchmarks/browserRunner.ts \
  --headed \
  --datasets=small-real-europatunnel,large-real-amsterdam-centraal \
  --configs=production-legacy,surface-first-e2plus-rplus \
  --scenarios=static_overview,automated_pan_sweep,repeated_scene_reload \
  --warmup-frames=8 \
  --measured-frames=36 \
  --out=benchmarks/results/browser-candidate.json
```

**Windows PowerShell:**
> Note: Use direct `npx tsx` execution when passing flags in PowerShell (do not use `npm run bench:browser -- --out ...`, because PowerShell consumes unquoted `--` before `npm` sees it). PowerShell also splits unquoted comma-separated tokens, so quote comma lists (`"a,b"`) or use space-separated values / repeated flags.

```powershell
# Hardware GPU smoke test on Windows (uses ANGLE Direct3D 11 by default)
npx tsx benchmarks/browserRunner.ts --datasets=synthetic-stress-urban-switchyard --configs=production-legacy --scenarios=static_overview --warmup-frames=10 --measured-frames=60 --require-hardware "--out=benchmarks/results/hardware-smoke.json"

# Quick hardware GPU validation run on Windows (RTX / Intel / AMD GPU)
npx tsx benchmarks/browserRunner.ts --quick --require-hardware "--out=benchmarks/results/hardware-rtx4060ti.json"

# Filter datasets and scenarios (quoted comma list OR space-separated) and optionally override backend
npx tsx benchmarks/browserRunner.ts --datasets "small-real-europatunnel,synthetic-stress-urban-switchyard" --scenarios static_overview automated_pan_sweep --gpu-backend=d3d11 --require-hardware "--out=benchmarks/results/browser-ps.json"
```

**Deterministic Browser Scenarios (`BrowserScenarioKind`):**
1. `static_overview`: Static orthographic overview camera framing `[0, 0, 0]` at `zoom = 1.0`, `azimuth = 45°`.
2. `static_close_junction`: Close-up static inspection at `zoom = 8.0` over dense junction/switch geometry.
3. `automated_pan_sweep`: Deterministic linear camera pan sweep across the map extent at `zoom = 5.5` (driven imperatively via `CameraController` without triggering React state re-renders).
4. `zoom_and_orbit_sweep`: Simultaneous zoom (`1.2` to `8.5`) and `270°` azimuth orbit sweep exercising LOD transitions (`4.5 CSS px/m`) and frustum culling.
5. `repeated_scene_reload`: Repeatedly unloads and reloads the dataset on the same WebGL2 context and audits `gl.info.memory.geometries` and `gl.info.memory.textures` for GPU resource leaks (`reloadLifecycleAudit`).

### 3.3 Comparing Baseline and Candidate Reports (`npx tsx benchmarks/compare.ts`)

Compares two JSON benchmark reports (`cpu` vs. `cpu` or `browser` vs. `browser`), verifies dataset hash and environment compatibility, computes absolute and percentage deltas, and flags regressions exceeding both the percentage threshold and the minimum absolute noise floor:

```bash
# Compare two reports and print a human-readable summary table
npx tsx benchmarks/compare.ts \
  benchmarks/baselines/cpu-baseline.json \
  benchmarks/results/cpu-candidate.json

# Save structured JSON comparison report and exit non-zero on regression or incompatibility
npx tsx benchmarks/compare.ts \
  benchmarks/baselines/cpu-baseline.json \
  benchmarks/results/cpu-candidate.json \
  --out=benchmarks/results/cpu-comparison.json \
  --fail-on-regression
```

---

## 4. Metric Definitions & Measurement Limitations (Schema v1.1.0)

### 4.1 Frame Interval vs. FPS vs. CPU Render Time vs. GPU Time
Do not conflate these four distinct measurements:
- **`frameIntervalMs` (`ms`, lower is better)**: Wall-clock interval elapsed between consecutive **completed `gl.render(scene, camera)` calls** (`computeConsecutiveFrameIntervalsMs` anchored on the final warmup frame). Telemetry is emitted strictly post-render (`emitPostRenderTelemetry` in `MapScene.tsx`), never pre-render inside R3F `useFrame`.
- **`effectiveMedianFps` (`fps`, higher is better)**: Derived strictly as `1000 / frameIntervalMs.median`.
- **`cpuFrameRenderTimeMs` (`ms`, lower is better)**: Synchronous CPU wall-clock duration of `gl.render(scene, camera)` inside `MapScene.tsx` (scene traversal, frustum culling, uniform updates, and WebGL driver command submission). Does **not** include asynchronous GPU rasterization or VSync wait time.
- **`gpuFrameRenderTimeMs` (`ms`, lower is better)**: Asynchronous hardware GPU execution duration measured via WebGL2 `EXT_disjoint_timer_query_webgl2` (`TIME_ELAPSED_EXT`). Uses a strict state machine (`resolveGpuFrameTelemetryState`) tracking per-frame `sampleCounts` (`totalFrames`, `valid`, `pending`, `disjoint`, `unsupported`):
  - Only frames whose asynchronous query resolved non-disjointly are counted under `valid` (`0 ms` inclusive).
  - Pending frames record `null` (`gpuTimerStatus: 'pending'`)—never stale cached values from earlier frames and never substituted CPU time.
  - When unsupported (`SwiftShader` / restricted driver) or disjoint (`GPU_DISJOINT_EXT`), `gpuFrameRenderTimeMs.status` is explicitly `'unsupported'`, `'disjoint'`, or `'unavailable'` with `statistics: null`.
- **`instrumentationOverheadMs` (`ms`, lower is better)**: Measured CPU bookkeeping duration of the post-render collector callback itself per frame.

### 4.2 Scene Readiness, Draw Calls & Railway Visibility Telemetry
- **Deterministic Post-Load Readiness (`validateSceneReadinessSnapshot`)**: After `loadOfflineDataset()`, the harness waits until React commits the target `sceneRevision`, `MapScene` completes at least one WebGL `gl.render()` for that revision (`webglFramesRenderedForRevision >= 1`), and non-empty datasets report non-idle geometry (`constructedMeshesCount > 1`). Static counts (`staticSceneGeometry`) never capture pre-commit `{ 1, 4, 2 }` idle ground geometry.
- **Actual Draw Calls & Triangles**: `webglDrawCallsPerFrame` and `renderedTrianglesPerFrame` come directly from `gl.info.render.calls` and `gl.info.render.triangles` captured immediately after `gl.render(scene, camera)` finishes for that frame.
- **Static vs. Sampled Railway Telemetry (`BenchmarkRailwayTelemetry.ts`)**:
  - `staticRailwayMeshes` and `staticRailwayTriangles` are computed once from `CachedRailwayIndex` upon scene/prototype commit.
  - During benchmark scenarios, per-frame frustum visibility (`activeRailwayMeshes`, `frustumCulledRailwayMeshes`, `frustumVisibleRailwayTriangles`) is evaluated without scene traversal over `CachedRailwayIndex` at deterministic stride `RAILWAY_VISIBILITY_SAMPLING_STRIDE = 4` (plus frame `0` and the final frame).
  - Missing/unavailable railway telemetry is explicitly reported as `null` with `railwayVisibilityStatus: 'unavailable'`—never as `0`. Genuine `0` values appear only when railways are disabled (`'disabled_by_config'`) or the scene contains `0` railway meshes.

### 4.3 Deterministic CPU Buffer Memory vs. JS V8 Heap Snapshots
- **`cpuBufferMemory` (`totalBytes` / `totalMB`)**: Deterministic sum of all typed-array (`Float32Array`, `Uint16Array`, `Uint32Array`) vertex attributes, index buffers, and instance matrices tracked by `SceneResourceManager`. This metric is **100% deterministic** for a fixed dataset and algorithm and serves as the primary memory regression gate (`cpuBufferMemoryPct: 5%`).
- **`v8HeapMemory` / `browserMemoryMB`**: Collected via `process.memoryUsage()` in Node.js (calling `global.gc()` between runs when `--expose-gc` is enabled) and `performance.memory` in Chromium. Because V8 garbage collection is generational and asynchronous, `heapUsedDeltaMB` and `usedJSHeapSizeMB` are **advisory** and subject to background GC timing.

### 4.4 Hardware GPU vs. Software Rasterization (`SwiftShader`) & Reproducibility Metadata
- On Windows (`win32`), `--gpu-backend=auto` (default) launches Chromium with `--use-gl=angle --use-angle=d3d11` so discrete/integrated GPUs are selected cleanly; Linux and macOS use native Chromium defaults unless overridden via `--gpu-backend=<d3d11|vulkan|opengl|metal|swiftshader|default>`.
- In headless Linux CI/container environments without a hardware GPU driver, Chromium automatically falls back to SwiftShader (`ANGLE (..., SwiftShader driver)`). Pass `--require-hardware` on GPU machines to guarantee that software fallback fails loudly rather than silently producing invalid GPU conclusions.
- `compareBenchmarkReports` rejects comparisons that mix schema versions (`1.0.0` vs `1.1.0`) or hardware GPU baselines with software-rendered candidates (`compatible: false`), and emits a warning if two hardware runs use different GPU models. Always compare matching hardware baselines on the same GPU host class.
- **Git Reproducibility Metadata (`resolveGitState`)**: Captures `gitCommitSha`, `gitDirty`, `gitBranch`, `gitMetadataStatus`, and `gitMetadataReason`. When `.git` metadata is absent (`not_a_git_repository`), `HEAD` has no commits yet (`unborn_head`), `git` is missing (`git_unavailable`), or Windows `safe.directory` triggers (`dubious_ownership`), the exact status and diagnostic reason are recorded without ever fabricating a commit hash (falling back to validated `GITHUB_SHA` / `CI_COMMIT_SHA` only when present as `ci_env_only`).

---

## 5. Adding New Datasets or Scenarios

- **Adding a Dataset**: Register a new entry in `benchmarks/datasets.ts` inside `loadBenchmarkDatasets()` pointing to a frozen local GeoJSON fixture, with a stable `id`, `tier`, `centerLonLat`, and optional `clipRadiusMeters`. `computeGeoJsonContentHash` automatically computes its SHA-256 hash and `parseGeoJson` records its feature breakdown. No changes to `cpuRunner.ts`, `browserRunner.ts`, or `compare.ts` are required.
- **Adding a Renderer Configuration**: Add a `RendererConfigurationDescriptor` to `BENCHMARK_RENDERER_CONFIGS` in `benchmarks/scenarios.ts`.
- **Adding a Browser Scenario**: Add a `BrowserScenarioDefinition` to `BROWSER_BENCHMARK_SCENARIOS` in `benchmarks/scenarios.ts` and define its camera trajectory in `benchmarks/browserRunner.ts`.

---

## 6. Developer Profiling Guide

When `npm run bench:compare` flags a regression, use the following workflows to pinpoint the root cause.

### 6.1 Profiling Node.js CPU & Memory Bottlenecks

1. **Generate a V8 CPU Profile (`.cpuprofile`)**:
   ```bash
   node --cpu-prof --cpu-prof-dir=./profiles ./node_modules/.bin/tsx benchmarks/cpuRunner.ts \
     --datasets=large-real-amsterdam-centraal \
     --configs=surface-first-e2plus-rplus \
     --warmup=1 --iterations=5 --no-save
   ```
2. **Inspect Flamegraphs**:
   - Open Chrome DevTools -> **Performance** panel -> click **Load profile...** and select the generated `CPU.*.cpuprofile` file (or open it in [speedscope.app](https://www.speedscope.app/)).
   - Switch to the **Bottom-Up** or **Call Tree** tab and filter by module (`LocalGeoJsonProvider`, `RoadNetworkBuilder`, `RoadSurfaceSolver`, `RoadGeometryBuilder`, `RailwayGeometryBuilder`, `polygon-clipping`).
3. **Generate a V8 Heap Profile (`.heapprofile`)**:
   ```bash
   node --heap-prof --heap-prof-dir=./profiles ./node_modules/.bin/tsx benchmarks/cpuRunner.ts \
     --datasets=large-real-amsterdam-centraal \
     --configs=surface-first-e2plus-rplus \
     --warmup=1 --iterations=3 --no-save
   ```
   Load the resulting `.heapprofile` in Chrome DevTools -> **Memory** panel to inspect allocation call stacks.

### 6.2 Profiling Browser Frame Times in Chrome DevTools

1. Start the dev server (`npm run dev`) and open `http://localhost:3000/?benchmark=1&dock=collapsed` in Chrome.
2. In the DevTools Console, load a frozen dataset deterministically:
   ```js
   await window.__BENCHMARK_HARNESS__.loadHengelo([0, 0, 0], 1.0, 45);
   ```
3. Open the **Performance** panel, click **Record**, and run a deterministic camera scenario from the Console:
   ```js
   await window.__BENCHMARK_HARNESS__.runCameraScenario('combined_sweep', 60, 0);
   ```
4. Stop recording and inspect the **Main** thread flamechart:
   - Compare `MapScene` `useFrame` execution time against `gl.render(scene, camera)`.
   - Look for yellow **Scripting** spikes (e.g., accidental per-frame raycasting or React state updates) or purple **Rendering/Layout** spikes.

### 6.3 Auditing WebGL Draw Calls, Triangles, and Resource Leaks

1. **Live Telemetry Inspection**:
   In the browser console, inspect the current snapshot at any time:
   ```js
   console.table(window.__BENCHMARK_HARNESS__.getSnapshot().liveWebGL);
   ```
   Check `renderCalls`, `renderTriangles`, `cpuRenderTimeMs`, `driverGeometries`, `driverTextures`, and `driverPrograms`.
2. **Verifying Scene Unload / Reload Disposal**:
   Run the following in the DevTools Console to verify that unloading or reloading a dataset leaves zero leaked Three.js geometries or textures on the WebGL context:
   ```js
   const before = window.__BENCHMARK_HARNESS__.getSnapshot().liveWebGL.driverGeometries;
   await window.__BENCHMARK_HARNESS__.unloadDataset();
   const unloaded = window.__BENCHMARK_HARNESS__.getSnapshot().liveWebGL.driverGeometries;
   console.log({ before, unloaded });
   ```
3. **Hardware GPU Timer Queries**:
   On machines with a discrete or integrated GPU where Chrome exposes `EXT_disjoint_timer_query_webgl2`, `liveWebGL.gpuPassTimeMs` reports the exact hardware GPU rasterization duration in milliseconds whenever `liveWebGL.gpuTimerQuerySupported` is `true` and queries resolve without `gpuDisjointOccurred`. If `gpuTimerQuerySupported` is `false`, launch local Chrome with `--enable-dawn-features=allow_unsafe_apis` or inspect GPU passes with **Spector.js**.
