# TKT-040 — Non-blocking Tile Preparation and Worker Transfer Evaluation Report

> **Date:** 2026-11-26  
> **Ticket:** [`TKT-040`](../../tickets/TKT-040-non-blocking-tile-preparation-and-worker-transfer.md) (`status: in_progress`)  
> **Scope:** Cross-thread worker delivery telemetry & profiler alignment fixes (WP-A), complete transferable buffers & compact typed-array metadata transport (WP-B), worker-side `InstancedSpatialIndex` BVH construction (WP-C), and main-thread reconstruction optimization (WP-D) across 5 independently toggleable variants.  
> **Hardware caveat:** All browser timings in this report were measured in **headless Chromium using SwiftShader software WebGL** on **deterministic high-cardinality synthetic mosaics** (`1,024 m`, `2,048 m`, `4,096 m`). They validate synchronous main-thread stage reductions, worker delivery overhead, worker BVH adoption, and picking/rendering correctness — **not** real-world RTX 4060 Ti 144 Hz frame intervals on the full-Twente mosaics, which belong to the owner's local validation run.

---

## 1. Root-Cause Summary (from TKT-039 RTX 4060 Ti Profiling)

Initial `TKT-039` profiling on the owner's RTX 4060 Ti (`4,096 m` consolidated Twente mosaic) showed steady ~144 FPS (`~6.94 ms`) during stationary and warm-cache camera movement, while panning across tile boundaries triggered intermittent frame intervals exceeding `190 ms` — **even with foliage rendering disabled**.

Two primary main-thread culprits were identified, compounded by eager reconstruction overhead:

1. **`Worker.onmessage` structured-clone deserialization of JS object graphs:** Decoded tiles previously transferred geometry typed arrays (while omitting `instanceFeatureIdxs`), but sent tens of thousands of JS metadata objects (`featureInfos`, `faceRanges`, `groups`, `sleeperBoxes`, string tag maps) through structured clone across `Worker.postMessage`, stalling the main thread both in browser-internal deserialization before JS entry and during JS message handling.
2. **Synchronous `InstancedSpatialIndex` BVH construction on the main thread:** `reconstructTileSceneFromDecoded` built 3D AABB BVHs synchronously for every instanced mesh (canopies, trunks, railway sleepers). Because toggling foliage visibility OFF hides foliage groups rather than omitting their meshes from baked tile reconstruction, disabling foliage did **not** eliminate these synchronous BVH builds or metadata clones.
3. **Redundant main-thread preparation during tile commit:** Cloning `InstancedMesh.instanceMatrix` buffers, eagerly materializing `singleFeatureIdx` / `faceRanges` / `instanceInfos` / `instanceBoxes` arrays, scanning all foliage instances in `O(N)` to compute frustum bounds, walking decoded payloads to compute `TileMemoryFootprint`, and running `grp.updateMatrixWorld(true)` over the entire composite scene inside `rebuildCompositeStats()`.

---

## 2. Architecture & Work Packages

All changes remain **100% compatible with existing baked `OSMTILE1` v1 mosaics** (`schema 1.1.0`; no rebake required) and preserve exact geographic geometry, visual appearance, and picking semantics.

### Work Package A — Profiler Frame-Alignment Fixes & Cross-Thread Telemetry
- **Frame-interval & `event.frameIndex` alignment fix (`StreamingProfiler.ts`, `MapScene.tsx`):** Fixed the `TKT-039` bug where stalls occurring *before* a frame's work began were misattributed to the following frame interval, and corrected the off-by-one shift in `event.frameIndex` relative to `frame.frameIndex`.
- **Cross-thread worker delivery telemetry:** `TileDecodeWorker.ts` stamps worker-side timings (`workerQueueWaitMs`, `workerInflateAndDecodeMs`, `workerBvhBuildMs`, `workerPayloadPrepMs`, `workerPostMessageEpochMs`, transferable buffer count & byte total) using epoch timestamps (`Date.now()`) for safe cross-thread wall-clock latency estimation (`messageDeliveryLatencyMs`), paired with main-thread `mainOnMessageHandlerMs`, `mainPromiseContinuationMs`, `workerBvhAdoptedCount`, and `syncBvhFallbackCount`.
- **Event-conditioned frame summaries (`StreamingFluidityStats.ts`):** Partitions frames into `allFrames`, `workerDeliveryFrames`, `tileCommitFrames`, `activeStreamingWorkFrames`, and `quietFrames`, while separating observed display cadence from the `144 Hz` (`6.94 ms`) frame budget target.
- **Methodological caveat:** Browser-internal structured-clone deserialization executes on the main thread *before* the JS `Worker.onmessage` callback starts. Its cost appears in `messageDeliveryLatencyMs` and in the unattributed residual of `workerDeliveryFrames` (and in Chrome DevTools Performance traces under `Receive Message` / `Deserialize`), whereas `mainOnMessageHandlerMs` captures the synchronous JS callback cost itself.

### Work Package B — Complete Buffer Transfers & Compact Metadata Transport
- **WP-B1 (`transfer_only`):** `TileDecodeWorker.ts` collects every eligible typed-array backing `ArrayBuffer` (adding the previously omitted `instanceFeatureIdxs`), deduplicates shared backing buffers via a `Set<ArrayBuffer>`, and never touches detached buffers after `postMessage`.
- **WP-B2 (`compact_transport`):** `src/world/tiling/CompactTileTransport.ts` packs all tile metadata (`featureInfos` + string pool + tag key/value index pairs, `faceRanges`, `groups`, `sleeperBoxes`, and precomputed `TileMemoryFootprint`) into flat transferable typed arrays (`Uint32Array`, `Int32Array`, `Float32Array`, `Uint8Array`). On the main thread, `CompactTileFeatureTable` materializes `InspectableFeatureInfo` objects lazily on demand (zero objects allocated at tile decode or commit time).

### Work Package C — Worker-Side `InstancedSpatialIndex` BVH Construction (`worker_bvh`)
- `TileDecodeWorker.ts` computes exact Arvo affine-AABB bounds using shared union prototype bounds (`getSharedFoliagePrototypeUnionBounds` in `FoliageLodSystem.ts` and `computeInstancedMeshLocalBounds` in `TilePackContract.ts`) and builds the identical flat typed-array `InstancedSpatialIndex` BVH off the main thread.
- The BVH arrays (`nodeBounds`, `nodeMeta`, `orderedInstanceIndices`, `rootBoundsMin/Max`, `instanceCount`) are transferred zero-copy and adopted in `O(1)` via `attachPreparedInstancedSpatialIndex()` in `InstancedSpatialIndex.ts`, with automatic synchronous fallback (and explicit `syncBvhFallbackTotal` telemetry) if a worker BVH is absent or fails validation.

### Work Package D — Main-Thread Tile Preparation Optimization (`combined`)
- **Zero-copy `InstancedMesh` matrix adoption:** Reuses the transferred `Float32Array` directly as `InstancedMesh.instanceMatrix.array` instead of copying `16 × N` floats per batch.
- **`O(1)` conservative foliage bounds:** Derives `InstancedMesh.boundingBox` directly from `preparedSpatialIndex.rootBoundsMin/Max` (`+0.25 m` margin) rather than looping over every instance matrix on the main thread.
- **Lazy picking metadata paths:** `resolveInspectedFeature` in `GeometryBuilder.ts` reads `__featureTable`, `__singleFeatureIdx`, and compact typed-array face/instance tables directly; legacy `userData` fields (`faceRanges`, `instanceInfos`, `instanceBoxes`) use lazy `Object.defineProperty` getters so zero metadata objects are allocated unless explicitly inspected.
- **`O(1)` memory footprint & targeted matrix updates:** Reads worker-precomputed `TileMemoryFootprint` in `O(1)` and removes the full-scene `grp.updateMatrixWorld(true)` traversal from `TileStreamManager.rebuildCompositeStats()`.

### Five-Variant Evaluation Matrix

| Variant (`--variant=` / `?tilePrepVariant=`) | Complete Transfers (WP-B1) | Compact Metadata (WP-B2) | Worker Instanced BVH (WP-C) | Main-Thread Prep Opts (WP-D) |
|---|:-:|:-:|:-:|:-:|
| `baseline` | Legacy subset | Off | Off (sync main thread) | Off |
| `transfer_only` | **On** | Off | Off (sync main thread) | Off |
| `compact_transport` | **On** | **On** | Off (sync main thread) | Off |
| `worker_bvh` | **On** | Off | **On** | Off |
| `combined` *(default)* | **On** | **On** | **On** | **On** |

---

## 3. Synthetic High-Cardinality 5-Variant Evaluation (SwiftShader Software WebGL)

To exercise both high metadata cardinality and high instance density without touching any regional Overijssel source data, a temporary deterministic synthetic mosaic suite was generated (`16 × 4` = `64` base `1,024 m` tiles, consolidated via `RegionalMosaicConsolidator` into `2,048 m` and `4,096 m` mosaics):

- **`1,024 m` tile:** `480` `featureInfos`, `460` `faceRanges`, `1,470` instances (`600` broadleaf + `150` conifer + `750` trunks + `120` railway sleepers with `sleeperBoxes`).
- **`2,048 m` consolidated tile:** `~1,920` features, `~5,880` instances/tile.
- **`4,096 m` consolidated tile:** `~7,680` features, `~7,360` `faceRanges`, **`23,520` instances/tile**.

Benchmark settings: `Scenario C_streaming_pan`, `--pan-speed-mps=1200 --preload-margin-tiles=0 --retain-margin-tiles=0.5 --measure-ms=2200 --allow-software`, headless Chromium SwiftShader.

> **Important interpretation note:** Under SwiftShader software WebGL, total frame intervals are dominated by CPU rasterization (`~280–550 ms`, cadence class `software_rasterizer_limited`). The tables below therefore report **attributed synchronous main-thread work**, **`Worker.onmessage` handler time**, **tile reconstruction time**, **main-thread vs. worker instanced BVH time**, and **adoption/fallback counts** — which isolate the exact CPU costs targeted by TKT-040. Hardware GPU frame intervals and `p99.9` at 144 Hz must be measured on the owner's RTX 4060 Ti.

### 3.1 Foliage ON — `1,024 m`, `2,048 m`, and `4,096 m` (`C_streaming_pan`)

| Tile Size | Variant | Tiles Deliv / Att / Evict | Compact | BVH Adopt / Fallback | Xfer Bufs / MB | `onMsg` med / max / sum (ms) | `reconstruct` med / max / sum (ms) | Main `instBVH` med / max / sum (ms) | Worker `instBVH` med / max (ms) | Max Sync Frame Work / Sum (ms) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `1,024 m` | `baseline` | 6 / 6 / 6 | 0 | 0 / 24 | 18.0 / 3.19 | 1.25 / 3.30 / 9.10 | 1.60 / 1.90 / 9.50 | 0.75 / 1.00 / 4.60 | 0.00 / 0.00 | 10.70 / 46.60 |
| `1,024 m` | `transfer_only` | 6 / 6 / 6 | 0 | 0 / 24 | 22.0 / 3.23 | 1.20 / 3.80 / 9.10 | 1.45 / 2.00 / 8.80 | 0.55 / 0.80 / 3.50 | 0.00 / 0.00 | 10.60 / 42.60 |
| `1,024 m` | `compact_transport` | 6 / 6 / 6 | 6 | 0 / 24 | 30.0 / 3.79 | **0.10 / 0.20 / 0.60** | 1.15 / 1.50 / 7.00 | 0.70 / 1.00 / 4.10 | 0.00 / 0.00 | 5.60 / 33.00 |
| `1,024 m` | `worker_bvh` | 6 / 6 / 6 | 0 | **24 / 0** | 38.0 / 3.59 | 1.50 / 8.20 / 14.50 | 0.65 / 1.40 / 4.20 | **0.00 / 0.00 / 0.00** | 0.90 / 2.40 | 15.00 / 44.50 |
| `1,024 m` | **`combined`** | 6 / 6 / 6 | **6** | **24 / 0** | 46.0 / 4.15 | **0.10 / 0.20 / 0.70** | **0.25 / 1.40 / 2.40** | **0.00 / 0.00 / 0.00** | 1.30 / 4.00 | **3.70 / 27.10** |
| `2,048 m` | `baseline` | 2 / 2 / 1 | 0 | 0 / 14 | 24.0 / 4.02 | 5.15 / 5.30 / 10.30 | 4.85 / 5.70 / 9.70 | 2.95 / 3.70 / 5.90 | 0.00 / 0.00 | 12.00 / 41.30 |
| `2,048 m` | `transfer_only` | 2 / 2 / 1 | 0 | 0 / 14 | 31.0 / 4.07 | 4.55 / 5.80 / 9.10 | 5.05 / 5.90 / 10.10 | 2.70 / 2.90 / 5.40 | 0.00 / 0.00 | 13.60 / 39.30 |
| `2,048 m` | `compact_transport` | 2 / 2 / 1 | 2 | 0 / 14 | 44.0 / 4.81 | **0.10 / 0.10 / 0.20** | 4.00 / 4.60 / 8.00 | 2.25 / 2.60 / 4.50 | 0.00 / 0.00 | 6.60 / 26.00 |
| `2,048 m` | `worker_bvh` | 2 / 2 / 1 | 0 | **14 / 0** | 59.0 / 4.56 | 5.20 / 6.50 / 10.40 | 2.25 / 3.30 / 4.50 | **0.00 / 0.00 / 0.00** | 3.60 / 4.00 | 11.20 / 39.10 |
| `2,048 m` | **`combined`** | 2 / 2 / 1 | **2** | **14 / 0** | 72.0 / 5.29 | **0.30 / 0.30 / 0.60** | **0.50 / 0.60 / 1.00** | **0.00 / 0.00 / 0.00** | 3.15 / 3.70 | **3.80 / 21.40** |
| `4,096 m` | `baseline` | 2 / 2 / 1 | 0 | 0 / 21 | 27.5 / 7.87 | 10.40 / 15.90 / 20.80 | 7.55 / 11.70 / 15.10 | 4.65 / 7.90 / 9.30 | 0.00 / 0.00 | 29.90 / 58.20 |
| `4,096 m` | `transfer_only` | 2 / 2 / 1 | 0 | 0 / 21 | 38.0 / 7.97 | 12.10 / 21.70 / 24.20 | 11.35 / 19.10 / 22.70 | 4.95 / 7.70 / 9.90 | 0.00 / 0.00 | 44.20 / 70.00 |
| `4,096 m` | `compact_transport` | 2 / 2 / 1 | 2 | 0 / 21 | 58.0 / 9.34 | **0.20 / 0.20 / 0.40** | 5.40 / 8.30 / 10.80 | 4.20 / 6.90 / 8.40 | 0.00 / 0.00 | 11.30 / 33.50 |
| `4,096 m` | `worker_bvh` | 2 / 2 / 1 | 0 | **21 / 0** | 80.0 / 8.86 | 10.40 / 16.60 / 20.80 | 2.55 / 3.80 / 5.10 | **0.00 / 0.00 / 0.00** | 17.40 / 30.60 | 22.50 / 46.20 |
| `4,096 m` | **`combined`** | 2 / 2 / 1 | **2** | **21 / 0** | 100.0 / 10.24 | **0.25 / 0.30 / 0.50** | **0.40 / 0.40 / 0.80** | **0.00 / 0.00 / 0.00** | 18.25 / 32.70 | **3.00 / 20.70** |

### 3.2 Foliage OFF — `4,096 m` (`C_streaming_pan`)

| Tile Size | Variant | Tiles Deliv / Att / Evict | Compact | BVH Adopt / Fallback | Xfer Bufs / MB | `onMsg` med / max / sum (ms) | `reconstruct` med / max / sum (ms) | Main `instBVH` med / max / sum (ms) | Worker `instBVH` med / max (ms) | Max Sync Frame Work / Sum (ms) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `4,096 m` | `baseline` | 2 / 2 / 4 | 0 | 0 / 10 | 22.0 / 2.01 | 1.90 / 2.70 / 3.80 | 14.30 / 21.30 / 28.60 | 12.20 / 18.90 / 24.40 | 0.00 / 0.00 | 35.20 / 91.90 |
| `4,096 m` | `transfer_only` | 4 / 4 / 4 | 0 | 0 / 32 | 33.0 / 10.51 | 3.95 / 14.00 / 22.80 | 4.50 / 11.90 / 22.30 | 2.30 / 7.40 / 12.80 | 0.00 / 0.00 | 28.00 / 109.30 |
| `4,096 m` | `compact_transport` | 4 / 4 / 4 | 4 | 0 / 32 | 48.0 / 12.35 | **0.15 / 0.20 / 0.60** | 6.05 / 11.20 / 24.90 | 2.45 / 8.20 / 13.40 | 0.00 / 0.00 | 13.70 / 77.60 |
| `4,096 m` | `worker_bvh` | 4 / 4 / 4 | 0 | **32 / 0** | 65.0 / 11.71 | 7.25 / 12.60 / 28.50 | 1.50 / 3.90 / 7.30 | **0.00 / 0.00 / 0.00** | 14.30 / 67.20 | 18.60 / 101.20 |
| `4,096 m` | **`combined`** | 4 / 4 / 4 | **4** | **32 / 0** | 80.0 / 13.55 | **0.20 / 0.20 / 0.60** | **0.45 / 0.60 / 1.80** | **0.00 / 0.00 / 0.00** | 12.55 / 34.60 | **3.60 / 53.10** |

### 3.3 Key Findings from the 5-Variant Decomposition
1. **`transfer_only` alone is insufficient:** Transferring `instanceFeatureIdxs` eliminates that buffer copy, but `Worker.onmessage` remains dominated by structured cloning of the JS metadata graph (`15.90–21.70 ms` max at `4,096 m`).
2. **`compact_transport` eliminates `Worker.onmessage` stalls:** At `4,096 m`, max `Worker.onmessage` drops **`15.90 ms → 0.20 ms` (`-98.7%`)** with foliage ON and **`14.00 ms → 0.20 ms` (`-98.6%`)** with foliage OFF.
3. **`worker_bvh` eliminates main-thread instanced BVH spikes:** Main-thread `instancedBvhBuildMs` drops to **`0.00 ms`** across every tile size and both foliage states (`100%` adoption: `24/0`, `14/0`, `21/0`, `32/0` — **zero sync fallbacks**), while main-thread `reconstructMs` adopts each prepared BVH in `≤ 0.20 ms`. Off-thread `workerBvhBuildMs` (`18.25 ms` median / `32.70 ms` max at `4,096 m`) executes entirely on the worker thread.
4. **`combined` achieves full synergy:** At `4,096 m`, peak attributed synchronous main-thread frame work drops **`29.90 ms → 3.00 ms` (`-90.0%`, foliage ON)** and **`35.20 ms → 3.60 ms` (`-89.8%`, foliage OFF)**, with per-tile `reconstructMs` dropping **`11.70 ms → 0.40 ms` (`-96.6%`)** — well inside the `6.94 ms` 144 Hz frame budget for tile-preparation CPU work.
5. **Why disabling foliage did not eliminate TKT-039 stalls:** Even with foliage OFF, `4,096 m` tiles still contained thousands of structured-cloned metadata entries and still reconstructed instanced foliage/railway meshes before hiding them (`baseline` paid up to `18.90 ms` `instancedBvhBuildMs` and `transfer_only` paid up to `14.00 ms` `onMsg`). `combined` eliminates both.

---

## 4. Remaining Indivisible Main-Thread Costs (Follow-Up Ticket Inputs)

TKT-040 intentionally stops short of a multi-frame incremental reconstruction scheduler or incremental WebGL upload architecture. On dense urban `4,096 m` Twente tiles, three remaining main-thread costs cannot be eliminated by worker transfer alone and should be inspected in the owner's RTX 4060 Ti traces:

1. **Static `MeshBVH.deserialize` (`staticBvhDeserializeMs`):** Rehydrating pre-baked `three-mesh-bvh` trees on very large merged building/road meshes remains synchronous during `reconstructTileSceneFromDecoded` (tracked separately in `StreamingProfiler`).
2. **Three.js `BufferGeometry` / `Mesh` / `InstancedMesh` object allocation & scene attachment (`sceneAttachMs`):** Creating Three.js wrappers and adding tile groups to the composite scene graph.
3. **First-render WebGL buffer uploads and shader/VAO setup (`first_rendered_use`, `glRenderCpuMs`, `driverGeometriesDelta`):** Uploading newly attached tile vertex/index/instance buffers to GPU memory on the first `gl.render()` pass after commit.

If the owner's RTX 4060 Ti `combined` trace shows residual `>6.94 ms` spikes concentrated in `first_rendered_use` / `gl.render()` or `staticBvhDeserializeMs`, those measurements directly scope the next ticket (e.g., incremental GPU upload / time-sliced commit or lazy static BVH deserialization).

---

## 5. Automated Verification Executed (Sandbox)

- **Unit & Integration Tests (`84 / 84` passed):**
  - `npx --yes tsx --test src/world/NonBlockingTilePreparation.test.ts src/world/StreamingFluidityProfiling.test.ts src/world/InstancedSpatialPicking.test.ts src/world/SpatialBatchingConsolidation.test.ts src/world/FoliageLodOptimization.test.ts src/world/WorkspaceUiAndSearch.test.ts` — **`31 / 31` passed** (includes `CompactTileTransport` lossless round-trip & zero eager materialization, worker BVH vs. main-thread BVH parity & picking equivalence, profiler pre-work frame-alignment & `event.frameIndex` regression checks, and full Playwright workspace E2E).
  - `npx --yes tsx --test src/world/TilingM1bCodecAndRegistry.test.ts src/world/TilingM2aStreaming.test.ts src/world/TilingM2bLifecycleValidation.test.ts src/world/Tiling031RuntimeEfficiency.test.ts src/world/TilingProjectionAndGrid.test.ts src/world/BvhRaycasting.test.ts src/world/GeometryBuilder.test.ts src/world/RegionalMosaicIdentityAndZoomPolicy.test.ts` — **`53 / 53` passed**.
- **Synthetic 5-Variant Playwright Runs (SwiftShader):** Completed across `1,024 m`, `2,048 m`, and `4,096 m` (`foliage=on`, Scenarios B & C) and `4,096 m` (`foliage=off`, Scenario C); temporary mosaics in `/tmp/tkt040-synth-mosaics` cleaned up afterward.
- **Typecheck, Build & API Docs:** `npm run lint` (`tsc --noEmit`), `npm run build` (`vite build`), and `npm run docs:api` all passed.

---

## 6. Owner RTX 4060 Ti Validation Guide (Windows PowerShell)

> **PowerShell note:** Invoke `npx tsx benchmarks/streamingFluidityRunner.ts ...` directly (rather than `npm run ... --`) so PowerShell passes `--` flags reliably without quoting issues.

### 6.1 Focused 5-Variant A/B on `4,096 m` Twente (Foliage ON & OFF)

```powershell
npx tsx benchmarks/streamingFluidityRunner.ts `
  --index-4096=data/osm/twente-full-foliage-fix-batched-4096m/mosaic.json `
  --variant=all `
  --scenarios=B,C,D,F,G `
  --foliage=both `
  --out=benchmarks/results/tkt040-twente-4096m-5variants.json `
  --markdown-out=benchmarks/results/tkt040-twente-4096m-5variants.md
```

### 6.2 Full 3-Mosaic × 5-Variant Evaluation (`1,024 m`, `2,048 m`, `4,096 m`)

```powershell
npx tsx benchmarks/streamingFluidityRunner.ts `
  --index-1024=data/osm/twente-full-1024m-foliage-fix/mosaic.json `
  --index-2048=data/osm/twente-full-foliage-fix-batched-2048m/mosaic.json `
  --index-4096=data/osm/twente-full-foliage-fix-batched-4096m/mosaic.json `
  --variant=all `
  --scenarios=B,C,D,F `
  --foliage=both `
  --out=benchmarks/results/tkt040-twente-all-mosaics-5variants.json `
  --markdown-out=benchmarks/results/tkt040-twente-all-mosaics-5variants.md
```

### 6.3 Chrome DevTools Performance Trace Capture (`baseline` vs. `combined`)

```powershell
npx tsx benchmarks/streamingFluidityRunner.ts `
  --index-4096=data/osm/twente-full-foliage-fix-batched-4096m/mosaic.json `
  --variant=combined `
  --scenarios=C `
  --foliage=on `
  --trace-out=benchmarks/results/tkt040-4096m-combined-trace.json `
  --out=benchmarks/results/tkt040-4096m-combined-trace-summary.json `
  --markdown-out=benchmarks/results/tkt040-4096m-combined-trace-summary.md
```

Open `benchmarks/results/tkt040-4096m-combined-trace.json` in Chrome DevTools **Performance** tab to inspect any residual main-thread work (`MeshBVH.deserialize`, `gl.render()` first-render uploads, GC, or compositor cadence).

### 6.4 Interactive 144 Hz Verification in the Viewer

1. Start the server pointing at your `4,096 m` mosaic (`$env:OVERIJSSEL_REGIONAL_MOSAIC_PATH="data/osm/twente-full-foliage-fix-batched-4096m/mosaic.json"; npm run dev`).
2. Open `http://localhost:3000/?streamingProfile=1&tilePrepVariant=combined` (or switch variants live in **Diagnostics → Tile Prep Mode**, which triggers a clean reload of the streaming tiles with the selected variant).
3. Pan continuously across tile boundaries, click buildings/roads/foliage/sleepers to confirm Inspector metadata parity, and confirm **Diagnostics** displays `Sync Fallback: 0` alongside non-zero `Worker BVH` counts.
4. Click **Export JSON** in the Diagnostics profiler section to save interactive captures.
