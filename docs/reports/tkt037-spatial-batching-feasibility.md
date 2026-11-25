# TKT-037 Report — Spatial Batching Feasibility & Performance Evaluation

- **Date:** 2026-11-25
- **Ticket:** [`TKT-037`](../../tickets/TKT-037-spatial-batching-feasibility-and-performance-evaluation.md) (`status: in_progress`)
- **Scope:** Standalone offline `OSMTILE1` tile consolidation (`1,024 m → 2,048 m` and `4,096 m`), triangle statistics accuracy fix, deterministic validation suite, and reproducible multi-mosaic hardware benchmark harness.
- **Acceptance Status:** Implementation, unit/integration verification, lint, build, and SwiftShader Playwright E2E verification on a synthetic 4×4 mosaic are complete. **Local consolidation of `data/osm/twente-full-1024m-foliage-fix/mosaic.json`, RTX 4060 Ti hardware GPU benchmarking, visual inspection, and the architectural decision gate remain open for the project owner.**

---

## 1. Background & Hypothesis

Following `TKT-036`, the project owner accepted visual results for runtime foliage LOD and measured full-Twente performance on an **RTX 4060 Ti** at `zoom = 0.15`:

| Metric (RTX 4060 Ti, `zoom = 0.15`) | Baseline | TKT-036 Optimized | Delta |
|---|---:|---:|---:|
| Submitted triangles | 75,912,022 | 7,556,900 | **-90.0%** |
| Draw calls | 4,951 | 4,539 | -8.3% |
| CPU render time | 38.80 ms | 38.10 ms | -1.8% |
| GPU pass time | 22.84 ms | 23.73 ms | +3.9% |
| Frame interval | 40.05 ms | 39.55 ms | -1.2% |

Removing ~90% of submitted triangles barely changed CPU render time, GPU pass time, or frame interval, while draw calls stayed above **4,500**. The primary hypothesis tested by `TKT-037` is that per-object scene traversal, material/buffer state binding, and WebGL draw-call submission across many `1,024 m` tiles dominate regional frame cost.

Rather than rebaking Twente or immediately committing to hierarchical multi-LOD streaming (`LOD1–LOD3`), `TKT-037` evaluates consolidating already-baked `1,024 m` `OSMTILE1` tiles into **`2,048 m` (2×2)** and **`4,096 m` (4×4)** spatial rendering batches with **zero geographic geometry changes**.

---

## 2. Technical Architecture

### 2.1 Triangle Statistics Correction (`GeometryBuilder.ts`, `TileGeometryStats.ts`)

Previously, 13 sites in `src/world/GeometryBuilder.ts` computed `(geo.index?.count || 0) / 3`, which silently added **`0` triangles** for non-indexed geometries such as `IcosahedronGeometry` broadleaf tree canopies (`240` tris/tree at `lod0`).

- **Bake-time fix:** Exported `getTriangleCount(geom)` in `src/world/GeometryBuilder.ts` using `geom.index ? Math.floor(geom.index.count / 3) : Math.floor((geom.attributes.position?.count || 0) / 3)` across all 13 geometry layers.
- **Backward-compatible buffer audit (`src/world/tiling/TileGeometryStats.ts`):** `computeDecodedTileGeometryStats(payload, foliageLod)` derives authoritative static and instanced triangle, vertex, and draw-call counts directly from decoded buffers and prototype definitions, and `compareStoredVsComputedTileStats()` reports the exact discrepancy against legacy stored header counters without requiring any existing mosaic to be rebaked.
- **Telemetry separation (`MapScene.tsx`, `spatialBatchingRunner.ts`):** Reports distinguish clearly between:
  1. **Stored tile header metadata** (`OSMTILE1` header),
  2. **Buffer-derived resident geometry** (`residentBufferTriangles`, `visibleBufferTriangles`, `residentSceneObjects`, `driverGeometries`), and
  3. **Actual WebGL submitted work** (`renderer.info.render.calls`, `renderer.info.render.triangles`).

### 2.2 Standalone Offline Tile Consolidation (`TileConsolidator.ts`, `OfflineTileConsolidator.ts`)

The consolidator operates **strictly on decoded `OSMTILE1` v1 SQLite shard packs** and **never invokes `GeometryBuilder`**, never queries OSM SQLite data, and refuses to write into or overlap the source mosaic directory.

| Aspect | Implementation |
|---|---|
| **Grid & UTM alignment** | Derives exact UTM-aligned parent indices (`parentMinTx = floor(minE / targetSize)`, `parentMaxTx = ceil(maxE / targetSize) - 1`, same for `ty`). On `twente-full` (`48×40` @ `1,024 m`, `minTx=313, minTy=5639`), this produces `25×21` @ `2,048 m` and `13×11` @ `4,096 m`, including partial-border parent tiles with `< 4` or `< 16` source children. |
| **Rectangular shard layout** | `RegionalMosaicPlan.ts` supports optional `shardCols` / `shardRows` (preserving strict square-shard validation when omitted) so prime/non-multiple parent dimensions (`25×21` → `5×7` shards of `5×3` tiles; `13×11` → `1×1` shard of `13×11` tiles, or user-configured divisors) remain cleanly sharded. |
| **Coordinate rebasing** | Computes double-precision UTM offsets `dx = childCenterE - parentCenterE` and `dz = parentCenterN - childCenterN`, bakes child `localPositionOffset + (dx, 0, dz)` into vertex positions and instance matrix columns `(m[12], m[14])`, and resets static mesh `localPositionOffset` to `[0, 0, 0]`. Sub-millimeter Float32 precision (`<= 0.25 mm` at `±2,048 m` local coordinates). |
| **Static compatibility key** | Merges only meshes matching `(layer, canonicalBaseName, materialSlotKeys, renderOrder, effectiveFlags, attributeSignature)` — keeping UVs, `aSwitchAttr`, vertex colors, underground hidden/trace flags, and zoom-dependent railway meshes (`Railway_Rails`, `Railway_Rails_3D`) strictly separated and intact. |
| **Multi-material group consolidation** | Sorts triangles across merged children by `materialIndex`, emitting **at most 1 contiguous group per material slot** (e.g., 4 child building meshes × 2 roof/wall groups = 8 draw calls → 2 draw calls) while remapping and coalescing `faceRanges` for exact feature inspection. |
| **Mixed index promotion** | When compatible meshes mix indexed and non-indexed buffers, non-indexed triangles are promoted losslessly into the shared index buffer (`Uint16Array`, auto-promoting to `Uint32Array` above `65,535` vertices). |
| **GroundPlane** | Emits a single clean 2-triangle `GroundPlane` sized to the parent tile (`2,048 m` or `4,096 m`), replacing 4 or 16 child ground planes. |
| **Fresh indirect MeshBVH** | Rebuilds a fresh indirect `MeshBVH` on every consolidated static mesh (`buildTileLocalBvh`) so hover/click raycasting and courtyard holes remain accurate. |
| **Instanced spatial sub-batching** | Independently configurable via `--foliage-batch=parent|child|<meters>` (default `parent`) and `--sleeper-batch=parent|child|<meters>` (default `child`). Recomputes conservative affine-AABB bounds via `computeConservativeInstancedBounds` for safe frustum culling. |
| **Bounded memory & verification** | Uses a bounded LRU cache over source SQLite shard handles (`--max-open-shards=8`), writes output shards atomically via `TilePackSqliteWriter`, runs full post-write decode/CRC32/manifest verification (`--no-verify` optional), and records `consolidation-report.json`. |
| **Runtime compatibility** | Output packs use unmodified `OSMTILE1` v1 (`schema 1.1.0`), so `RegionalMosaicHttpHandler` and `TileStreamManager` serve and stream `2,048 m` and `4,096 m` mosaics without runtime protocol changes. |

### 2.3 Reproducible Multi-Mosaic Benchmark Runner (`benchmarks/spatialBatchingRunner.ts`)

- Mounts all provided mosaics (`--index-1024`, `--index-2048`, `--index-4096`) simultaneously on one ephemeral Express + Vite server under separate API routes.
- Locks **one identical absolute UTM `(targetEasting, targetNorthing)` coordinate** across all tile sizes, converting into each mosaic's `studyOriginEasting/Northing` (essential because full-Twente `4,096 m` shifts the mosaic center by `+1,024 m E, -1,024 m N` relative to `1,024 m`).
- Benchmarks 4 stationary zoom poses (`6.5`, `1.2`, `0.65`, `0.15`) × 2 foliage configurations (**TKT-036 enabled** vs. **foliage disabled**) across repeated passes with warmup, plus a continuous pan streaming pass (`zoom = 0.55`) and 25-point BVH feature-pick raycast timing (`measureFeaturePickRaycast`).
- Probes `UNMASKED_RENDERER_WEBGL` directly from the active WebGL2 canvas and aborts if a software renderer is detected unless `--allow-software` is explicitly passed.

---

## 3. Sandbox Verification & Synthetic Playwright Results

### 3.1 Automated Unit & Integration Tests

- `src/world/SpatialBatchingConsolidation.test.ts` (**4/4 passed**):
  1. Indexed, non-indexed, and instanced foliage triangle counting (`GeometryBuilder` + `TileGeometryStats` + legacy header discrepancy detection).
  2. Core consolidation of 2×2 children (including empty child, overhanging building, courtyard hole multi-material building, mixed indexed/non-indexed roads, bridges, hidden underground tunnels + trace, railways with UVs + `aSwitchAttr` + 3D sleepers, broadleaf/coniferous foliage): verified `0` non-ground triangle delta, `0` instance delta, multi-material group reduction (`12 → 4`), byte-for-byte determinism, `OSMTILE1` round-trip, sub-cm world-space vertex precision, BVH raycast + courtyard hole miss, railway zoom switching (`0.15` vs `6.5`), and finite `boundingSphere` on all meshes.
  3. Offline SQLite mosaic consolidation (`4×4` `1,024 m` → `2,048 m` and `4,096 m`) with partial-border alignment, non-destructive source-directory guard, post-write integrity verification, and `RegionalMosaicHttpHandler` HTTP 200 manifest + tile serving.
  4. `spatialBatchingRunner` CLI parsing and SwiftShader warning formatting.

### 3.2 End-to-End Playwright WebGL Verification (Synthetic 4×4 Mosaic, SwiftShader)

Executed on **2026-11-25** using `GeometryBuilder` → `TilePackSqliteWriter` (16 `1,024 m` tiles across 4 shards containing courtyard buildings, roads, railways with 3D sleepers, water, landuse, barriers, and broadleaf/coniferous forests) → `consolidateRegionalMosaic` (`foliageBatchMode='parent'`, `sleeperBatchMode='child'`) → `runSpatialBatchingBenchmark` (`1440×900`, `daylight`, `--allow-software`).

> **Software Renderer Caveat:** Executed on `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`. **Frame and CPU timings under SwiftShader do NOT represent RTX 4060 Ti hardware performance.** Only deterministic geometry counts, WebGL draw calls (`GL Calls`), submitted triangles (`GL Tris`), resident buffer triangles, scene object counts, driver geometries, and raycast resolution counts are authoritative here.

#### Offline Consolidation Audit (Synthetic 4×4 Mosaic)

| Mosaic | Grid | Total Tiles | Elapsed | Compressed Size | Resident Draw Calls (Audit) | Non-Ground Tri Delta | Instance Delta |
|---|---|---:|---:|---:|---:|---:|---:|
| `1024m` (baseline) | 4 × 4 | 16 | baseline | 0.74 MiB | 352 | 0 | 0 |
| `2048m` (2×2) | 3 × 3 | 9 | 0.31 s | 0.70 MiB (-4.99%) | **142 (-59.66%)** | **0** | **0** |
| `4096m` (4×4) | 2 × 2 | 4 | 0.27 s | 0.66 MiB (-10.31%) | **72 (-79.55%)** | **0** | **0** |

#### Stationary WebGL Measurements (Foliage Enabled — TKT-036 Optimized)

| Pose | Tile Size | Loaded / Vis Tiles | Scene Objs | Driver Geos | GL Calls (med) | GL Tris (med) | Resident Buf Tris | Pick Resolved |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Close (`6.5`) | `1024 m` | 16 / 4 | 537 | 74 | 36 | 36,562 | 2,267,778 | 0/25 |
| Close (`6.5`) | `2048 m` | 9 / 1 | 214 | 58 | 37 (+2.8%) | 1,005,778 | 2,267,778 | 0/25 |
| Close (`6.5`) | `4096 m` | 4 / 1 | 109 | 41 | 38 (+5.6%) | 1,956,514 | 2,267,778 | 0/25 |
| Default (`1.2`) | `1024 m` | 16 / 4 | 537 | 74 | 76 | 170,228 | 925,122 | 16/25 |
| Default (`1.2`) | `2048 m` | 9 / 1 | 214 | 60 | **62 (-18.4%)** | 418,406 | 925,122 | 16/25 |
| Default (`1.2`) | `4096 m` | 4 / 1 | 109 | 43 | **38 (-50.0%)** | 655,324 | 925,122 | 16/25 |
| City (`0.65`) | `1024 m` | 16 / 16 | 537 | 121 | 127 | 94,352 | 616,002 | 16/25 |
| City (`0.65`) | `2048 m` | 9 / 9 | 214 | 69 | **66 (-48.0%)** | 117,100 | 616,002 | 16/25 |
| City (`0.65`) | `4096 m` | 4 / 4 | 109 | 45 | **35 (-72.4%)** | 146,284 | 616,002 | 16/25 |
| Regional (`0.15`) | `1024 m` | 16 / 16 | 537 | 155 | 177 | **156,034** | 616,002 | 12/25 |
| Regional (`0.15`) | `2048 m` | 9 / 9 | 214 | 95 | **100 (-43.5%)** | **156,034** | 616,002 | 12/25 |
| Regional (`0.15`) | `4096 m` | 4 / 4 | 109 | 53 | **45 (-74.6%)** | **156,034** | 616,002 | 12/25 |

#### Stationary WebGL Measurements (Foliage Disabled)

| Pose | Tile Size | Loaded / Vis Tiles | Scene Objs | Driver Geos | GL Calls (med) | GL Tris (med) | Pick Resolved |
|---|---|---:|---:|---:|---:|---:|---:|
| Close (`6.5`) | `1024 m` | 16 / 4 | 537 | 155 | 33 | 274 | 0/25 |
| Close (`6.5`) | `2048 m` | 9 / 1 | 214 | 95 | 31 (-6.1%) | 43,138 | 0/25 |
| Close (`6.5`) | `4096 m` | 4 / 1 | 109 | 53 | 29 (-12.1%) | 43,834 | 0/25 |
| City (`0.65`) | `1024 m` | 16 / 16 | 537 | 155 | 111 | 1,112 | 16/25 |
| City (`0.65`) | `2048 m` | 9 / 9 | 214 | 95 | **56 (-49.5%)** | 1,180 | 16/25 |
| City (`0.65`) | `4096 m` | 4 / 4 | 109 | 53 | **29 (-73.9%)** | 1,384 | 16/25 |
| Regional (`0.15`) | `1024 m` | 16 / 16 | 537 | 155 | 145 | **1,474** | 12/25 |
| Regional (`0.15`) | `2048 m` | 9 / 9 | 214 | 95 | **82 (-43.4%)** | **1,474** | 12/25 |
| Regional (`0.15`) | `4096 m` | 4 / 4 | 109 | 53 | **37 (-74.5%)** | **1,474** | 12/25 |

**Key deterministic findings already visible on synthetic data:**

1. **Exact geometry conservation:** At `zoom = 0.15`, submitted WebGL triangles match down to the single triangle across all three tile sizes (`156,034` foliage-enabled; `1,474` foliage-disabled), resident buffer triangles match identically at every zoom, and all 25-point raycast hit counts match (`0/25`, `16/25`, `16/25`, `12/25`), confirming zero geometric drift across coordinate rebasing.
2. **Large draw-call & scene-graph reductions at city/regional zoom:** At `zoom = 0.15`, `2,048 m` cut WebGL draw calls by **-43.5%** and `4,096 m` by **-74.6%** (with scene objects down **-60.1%** and **-79.7%**, and WebGL geometries down **-38.7%** and **-65.8%**). Because this 4×4 synthetic test had partial-edge parent tiles (`3×3` and `2×2`), full-Twente interior tiles (true 4-child and 16-child merges) are expected to achieve even higher reductions (approaching ~65–75% at `2,048 m` and ~85–90% at `4,096 m`).
3. **Coarser frustum culling & instanced raycast trade-off at close zoom:** With `foliageBatchMode='parent'`, merging foliage into a single `4,096 m` `InstancedMesh` caused all trees in the `4,096 m` tile to submit at close zoom (`36,562 → 1,956,514` tris) and slowed raycasting against `InstancedMesh` (Three.js iterates all instances linearly when raycasting an `InstancedMesh`). By contrast, keeping `sleeperBatchMode='child'` (the default) reduced close-zoom sleeper triangle over-submission by **-79.4%** (`213,274 → 43,834` tris) and cut foliage-disabled close-zoom raycast pick latency from `5.20 ms` to `0.40 ms` (**-92.3%**), while preserving the full `-74.6%` regional draw-call reduction. Testing `--foliage-batch=child` or `--foliage-batch=2048` on Twente is supported out of the box if close-zoom picking or culling overhead shows up on real data.

---

## 4. Known Limitations, Risks & Trade-Offs

1. **Coarser frustum culling & memory retention at close zoom:** Larger tiles keep more out-of-frustum geometry resident (`retainMarginTiles = 1` means a `4,096 m` tile retains a 12 km × 12 km buffer around the viewport vs. 3 km × 3 km for `1,024 m`). Watch `estimatedGeometryMemoryMB`, `jsHeapMB`, and close-zoom submitted triangles in the hardware report.
2. **Larger streaming bursts during panning:** A single `4,096 m` tile aggregates up to 16 child tiles into one binary blob + BVH. While total compressed storage is slightly smaller (better cross-tile DEFLATE redundancy), individual tile fetch/decode/reconstruct spikes (`maxCommitMs` and `pan` p95/max frame time) will be heavier when crossing a `4,096 m` tile boundary.
3. **InstancedMesh raycast cost:** Three.js `InstancedMesh.raycast` tests instances linearly (no per-instance BVH). Merging tens of thousands of trees into one `4,096 m` `InstancedMesh` can noticeably increase hover/click raycast latency; if `Raycast Pick (med ms)` degrades on Twente, compare `--foliage-batch=child` or `--foliage-batch=1024`.
4. **Partial border tiles & origin shift:** Because `twente-full` (`48×40` @ `1,024 m`) starts at odd UTM indices (`minTx=313, minTy=5639`), its `2,048 m` (`25×21`) and `4,096 m` (`13×11`) grids include partial border tiles and shift the mosaic center slightly. `spatialBatchingRunner.ts` compensates automatically via shared absolute UTM target coordinates.
5. **No LOD1–LOD3 or geographic simplification:** Consolidated tiles still contain full LOD0 detail (all buildings, roads, rails, canopies). Spatial batching tests whether **draw-call/scene-traversal overhead** is the dominant bottleneck; if GPU pass time remains high even at `~500–800` draw calls, geometric simplification / multi-LOD overview tiles will be needed next.

---

## 5. Local Execution & Hardware Benchmarking Instructions (Project Owner — Windows PowerShell)

All commands below are **non-destructive**: they read `data/osm/twente-full-1024m-foliage-fix/mosaic.json` read-only and write consolidated mosaics into separate folders.

### Step 1 — Consolidate the full-Twente mosaic to `2,048 m` and `4,096 m`

```powershell
npx tsx scripts/consolidate-regional-mosaic.ts `
  --index=data/osm/twente-full-1024m-foliage-fix/mosaic.json `
  --target-tile-size=2048,4096 `
  --out-root=data/osm
```

This creates two independent mosaics alongside the untouched source:
- `data/osm/twente-full-foliage-fix-batched-2048m/mosaic.json` (plus `consolidation-report.json`)
- `data/osm/twente-full-foliage-fix-batched-4096m/mosaic.json` (plus `consolidation-report.json`)

*(Optional experiment if you also want to test finer foliage frustum culling / faster tree picking at `4,096 m`:)*
```powershell
npx tsx scripts/consolidate-regional-mosaic.ts `
  --index=data/osm/twente-full-1024m-foliage-fix/mosaic.json `
  --target-tile-size=4096 `
  --foliage-batch=child `
  --out=data/osm/twente-full-foliage-fix-batched-4096m-child-foliage
```

### Step 2 — Run the reproducible RTX 4060 Ti hardware benchmark across all 3 tile sizes

```powershell
npx tsx benchmarks/spatialBatchingRunner.ts `
  --index-1024=data/osm/twente-full-1024m-foliage-fix/mosaic.json `
  --index-2048=data/osm/twente-full-foliage-fix-batched-2048m/mosaic.json `
  --index-4096=data/osm/twente-full-foliage-fix-batched-4096m/mosaic.json `
  --runs=2 `
  --warmup-frames=12 `
  --measured-frames=45 `
  --out=benchmarks/results/tkt037-twente-rtx4060ti.json `
  --markdown-out=benchmarks/results/tkt037-twente-rtx4060ti.md
```

This automatically verifies a hardware WebGL2 GPU (refusing SwiftShader), locks the exact same UTM target across all three mosaics, measures all 4 zoom poses (`6.5`, `1.2`, `0.65`, `0.15`) × both foliage modes (**TKT-036 enabled** and **foliage disabled**), runs continuous panning and 25-point BVH raycast picking, and writes both JSON and Markdown summary tables.

### Step 3 — Interactive visual & streaming inspection (optional)

Inspect `2,048 m`:
```powershell
$env:OVERIJSSEL_REGIONAL_MOSAIC_PATH = "data/osm/twente-full-foliage-fix-batched-2048m/mosaic.json"
npm run dev
```

Inspect `4,096 m`:
```powershell
$env:OVERIJSSEL_REGIONAL_MOSAIC_PATH = "data/osm/twente-full-foliage-fix-batched-4096m/mosaic.json"
npm run dev
```

Confirm in the **World** and **Diagnostics** panels that the active mosaic name and tile size match (`2048 m` / `4096 m`), check roads/railways/bridges/tunnels/courtyard buildings/foliage across Hengelo, Enschede, and Almelo, and test clicking features to verify `Inspector` attribution.

### Step 4 — Decision Gate Criteria

Use the generated `benchmarks/results/tkt037-twente-rtx4060ti.md` report to evaluate:
- **Did draw calls drop substantially (`4,539 → ~1,100–1,400` at `2,048 m` and `~350–600` at `4,096 m`)?**
- **Did RTX 4060 Ti `CPU render time`, `GPU pass time`, and `Frame interval` at `zoom = 0.15` drop proportionally?**
  - If **yes** and pan/pick/memory trade-offs are acceptable: spatial batching confirms draw-call/object overhead is the dominant bottleneck and directly informs choosing `2,048 m` or hierarchical `1,024 m + 4,096 m` batches.
  - If **CPU render drops sharply while GPU pass time stays > 20 ms**: vertex/fragment work (e.g., shadow pass, overdraw, or dense LOD0 geometry) is the remaining GPU bottleneck rather than draw-call submission.
  - If **pan spikes (`maxCommitMs`) or close-zoom memory/culling regress at `4,096 m` while `2,048 m` stays smooth**: `2,048 m` (or hierarchical streaming using `1,024 m` close + `4,096 m` far) is indicated over flat `4,096 m`.
