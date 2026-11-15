# Performance Benchmarking & Developer Profiling Guide

This document describes the reproducible performance benchmarking infrastructure (`benchmarks/`) introduced in `TKT-016`, how to execute CPU and WebGL browser benchmarks, how to compare baseline and candidate reports, and how to profile CPU, memory, and WebGL bottlenecks.

---

## 1. Architecture Overview

The benchmarking system is organized under `/benchmarks/` and is decoupled from individual renderer subsystems:

| Module | Responsibility |
| :--- | :--- |
| `benchmarks/types.ts` | Versioned JSON report schema (`schemaVersion: "1.0.0"`), workload descriptors, statistical types, and comparison report contracts. |
| `benchmarks/datasets.ts` | Frozen, deterministic offline benchmark datasets with SHA-256 content hashes (`contentHashSha256`) and per-category feature counts. |
| `benchmarks/scenarios.ts` | Renderer configurations (`production-legacy`, `graph-e2-e3`, `surface-first-e2plus-rplus`) and deterministic browser camera/lifecycle scenarios. |
| `benchmarks/stats.ts` | Quantile (`median`, `p95`, `p99`), mean, standard deviation, interquartile range (`iqr`), coefficient of variation (`cv`), and threshold-based regression evaluation. |
| `benchmarks/environment.ts` | Git commit/branch/dirty state, OS/CPU/RAM metadata, browser/GPU driver strings, hardware vs. software WebGL detection (`SwiftShader` / `llvmpipe`), and canonical metric definitions. |
| `benchmarks/cpuRunner.ts` | Node.js CPU benchmark runner (`npm run bench:cpu`) measuring direct pipeline stages, deterministic typed-array memory, V8 heap snapshots, and `SceneResourceManager` disposal verification. |
| `benchmarks/browserRunner.ts` | Playwright + Chromium WebGL benchmark runner (`npm run bench:browser`) measuring real rendering frame intervals, CPU `gl.render()` time, GPU timer queries, actual `gl.info.render.calls`, `gl.info.render.triangles`, and scene reload lifecycle leaks. |
| `benchmarks/serializer.ts` | Schema validation (`validateBenchmarkReport`), JSON serialization, and human-readable terminal table formatting. |
| `benchmarks/compare.ts` | Automated baseline vs. candidate comparison engine (`npm run bench:compare`) with compatibility validation and configurable regression thresholds. |

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

Runs in Node.js without requiring a browser or GPU. Directly measures each pipeline stage with warm-up iterations, multiple measured iterations, and explicit resource disposal verification after every run:

```bash
# Run full CPU benchmark suite across all frozen datasets and renderer configs
# Saves report to benchmarks/baselines/cpu-baseline.json
npm run bench:cpu

# Run a fast subset (e.g. during iterative development)
npm run bench:cpu -- --quick --out benchmarks/results/cpu-candidate.json

# Filter specific datasets, renderer configurations, or sample counts
npm run bench:cpu -- \
  --datasets=small-real-europatunnel,large-real-amsterdam-centraal \
  --configs=production-legacy,surface-first-e2plus-rplus \
  --warmup=2 \
  --iterations=7 \
  --out=benchmarks/results/cpu-custom.json
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

Launches headless Chromium via Playwright, starts or connects to the local application server (`/?benchmark=1&dock=collapsed`), blocks external network requests, and executes deterministic camera and lifecycle scenarios through the real Three.js / React Three Fiber rendering pipeline:

```bash
# Run full Browser/WebGL benchmark suite and save to benchmarks/baselines/browser-baseline.json
npm run bench:browser

# Run a quick verification pass across representative datasets
npm run bench:browser -- --quick --out benchmarks/results/browser-candidate.json

# Filter specific datasets, configs, or scenarios
npm run bench:browser -- \
  --datasets=small-real-europatunnel,large-real-amsterdam-centraal \
  --configs=production-legacy,surface-first-e2plus-rplus \
  --scenarios=static_overview,automated_pan_sweep,repeated_scene_reload \
  --warmup-frames=5 \
  --measured-frames=24 \
  --out=benchmarks/results/browser-candidate.json
```

**Deterministic Browser Scenarios (`BrowserScenarioId`):**
1. `static_overview`: Static orthographic overview camera framing `[0, 0, 0]` at `zoom = 1.0`, `azimuth = 45°`.
2. `static_close_junction`: Close-up static inspection at `zoom = 7.5` over dense junction/switch geometry.
3. `automated_pan_sweep`: Deterministic linear camera pan sweep across the map extent at `zoom = 4.5`.
4. `zoom_and_orbit_sweep`: Simultaneous zoom (`1.5` to `7.0`) and `360°` azimuth orbit sweep exercising LOD transitions and frustum culling.
5. `repeated_scene_reload`: Repeatedly unloads and reloads the dataset on the same WebGL2 context and audits `gl.info.memory.geometries` and `gl.info.memory.textures` for GPU resource leaks (`reloadLifecycleAudit`).

### 3.3 Comparing Baseline and Candidate Reports (`npm run bench:compare`)

Compares two JSON benchmark reports (`cpu` vs. `cpu` or `browser` vs. `browser`), verifies dataset hash and environment compatibility, computes absolute and percentage deltas, and flags regressions exceeding both the percentage threshold and the minimum absolute noise floor:

```bash
# Compare two reports and print a human-readable summary table
npm run bench:compare -- \
  benchmarks/baselines/cpu-baseline.json \
  benchmarks/results/cpu-candidate.json

# Save structured JSON comparison report and exit non-zero on regression or incompatibility
npm run bench:compare -- \
  benchmarks/baselines/cpu-baseline.json \
  benchmarks/results/cpu-candidate.json \
  --out=benchmarks/results/cpu-comparison.json \
  --fail-on-regression
```

---

## 4. Metric Definitions & Measurement Limitations

### 4.1 Frame Interval vs. FPS vs. CPU Render Time vs. GPU Time
Do not conflate these four distinct measurements:
- **`frameIntervalMs` (`ms`, lower is better)**: Wall-clock time elapsed between consecutive `requestAnimationFrame` callbacks during active rendering. Includes browser compositor scheduling, React Three Fiber `useFrame` hooks, and synchronous WebGL command submission.
- **`effectiveMedianFps` (`fps`, higher is better)**: Derived strictly as `1000 / frameIntervalMs.median`.
- **`cpuFrameRenderTimeMs` (`ms`, lower is better)**: Synchronous CPU wall-clock duration of `gl.render(scene, camera)` inside `MapScene.tsx` (scene traversal, frustum culling, uniform updates, and WebGL driver command submission). Does **not** include asynchronous GPU rasterization or VSync wait time.
- **`gpuFrameRenderTimeMs` (`ms`, lower is better)**: Asynchronous hardware GPU execution duration measured via WebGL2 `EXT_disjoint_timer_query_webgl2` (`TIME_ELAPSED_EXT`). When the extension is unavailable (such as on SwiftShader or restricted drivers) or reports `GPU_DISJOINT_EXT`, `gpuFrameRenderTimeMs.status` is explicitly recorded as `'unsupported'`, `'disjoint'`, or `'unavailable'` with `statistics: null`. Fabricated values are never substituted.

### 4.2 Actual Draw Calls vs. Construction-Time Mesh Estimates
- **`webglDrawCallsPerFrame`** and **`renderedTrianglesPerFrame`** come directly from `gl.info.render.calls` and `gl.info.render.triangles` captured immediately after `gl.render(scene, camera)` completes for that frame.
- They reflect frustum culling, layer visibility, and instanced rendering (`THREE.InstancedMesh` submits 1 draw call for $N$ instances), whereas construction-time mesh counts (`BuiltSceneGeometry.stats.totalDrawCalls`) only count allocated scene-graph objects.

### 4.3 Deterministic CPU Buffer Memory vs. JS V8 Heap Snapshots
- **`cpuBufferMemory` (`totalBytes` / `totalMB`)**: Deterministic sum of all typed-array (`Float32Array`, `Uint16Array`, `Uint32Array`) vertex attributes, index buffers, and instance matrices tracked by `SceneResourceManager`. This metric is **100% deterministic** for a fixed dataset and algorithm and serves as the primary memory regression gate (`cpuBufferMemoryPct: 5%`).
- **`v8HeapMemory` / `browserMemoryMB`**: Collected via `process.memoryUsage()` in Node.js (calling `global.gc()` between runs when `--expose-gc` is enabled) and `performance.memory` in Chromium. Because V8 garbage collection is generational and asynchronous, `heapUsedDeltaMB` and `usedJSHeapSizeMB` are **advisory** and subject to background GC timing.

### 4.4 Hardware GPU vs. Software Rasterization (`SwiftShader`)
- Headless Linux CI/container environments without a physical display server or hardware GPU use Chromium's software WebGL2 rasterizer (`ANGLE (..., SwiftShader driver)`).
- The benchmark report records `environment.browser.isSoftwareRenderer: true` and adds an explicit warning note whenever SwiftShader or `llvmpipe` is active.
- `compareBenchmarkReports` rejects comparisons that mix hardware GPU baselines with software-rendered candidates (`compatible: false`). Always compare hardware-to-hardware or software-to-software on the same host class.

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
   On machines with a discrete or integrated GPU where Chrome exposes `EXT_disjoint_timer_query_webgl2`, `liveWebGL.gpuFrameTimeMs` reports the exact hardware GPU rasterization duration in milliseconds. If `gpuTimerSupported` is `false`, launch local Chrome with `--enable-dawn-features=allow_unsafe_apis` or inspect GPU passes with **Spector.js**.
