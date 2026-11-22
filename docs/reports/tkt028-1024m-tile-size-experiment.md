# TKT-028: 1,024 m Tile Size Experiment — Design, Verification, Benchmark Comparison & Recommendation

> **Experiment Status (`2026-11-21`, updated)**: **Canonical RTX 4060 Ti hardware comparison complete; physical-margin follow-up in progress (`TKT-028-F1`)** (`512 m` remains the sole production default across runtime streaming, baking, CLI tools, and `data/osm/overijssel-tiles-261114-8ae28196.sqlite`). Canonical `4 × 4` (`1,024 m`) Hengelo hardware GPU comparison on RTX 4060 Ti is ready for local Windows execution using the exact PowerShell workflow below.

---

## 1. Objective & Hypothesis

On canonical Hengelo (`4,096 × 4,096 m`), partitioning the `M1a` single-scene reference (`452` meshes) into `8 × 8 = 64` tiles at `512 m` increases mounted meshes to `2,783` (`~6.16×`) and yields **`2,900` WebGL draw calls (`19.95 ms` median frame interval, `~50 FPS`)** in `far_overview` on the project owner's **Windows RTX 4060 Ti** (`tkt028-m2b-hengelo-streaming.json`).

**Hypothesis tested**: Doubling `LOD0` tile width from `512 m` (`8 × 8 = 64` tiles) to `1,024 m` (`4 × 4 = 16` tiles, `4×` larger area per tile) reduces draw-call and mesh-count overhead in overview and multi-tile views without degrading `E2+/R+` seam fidelity, BVH feature inspection, or streaming smoothness—and may or may not improve total runtime streaming balance once tile decode/commit burst cost, memory footprint, and eviction granularity are factored in.

---

## 2. Reversible Architecture & Implementation Summary

All changes are additive and reversible; `512 m` defaults and `data/osm/overijssel-tiles-261114-8ae28196.sqlite` remain completely untouched:

1. **Configurable Aligned Grid (`src/world/tiling/TileGrid.ts`)**:
   - `createHengeloStudyGrid(tileSizeMeters = 512, collarMeters = 64)` validates positive integer divisors of `4,096 m` (`512 m` -> `8 × 8`, `1,024 m` -> `4 × 4`).
   - Uses `buildStudyGridFromUtmBounds` anchored directly to the canonical `512 m` Hengelo UTM bounds (`347,648–351,744 E`, `5,791,744–5,795,840 N`) rather than multiplying `Math.floor(minE / 1024) * 1024` (which would shift origin by `512 m` because `679 / 2 = 339.5`).
   - Guarantees **bit-identical** `studyUtmBounds`, `projection` origin (`utmToLocal`), `studyLocalBounds` (`[-2048, +2048]`), `studyGeoBounds`, `studyExpandedGeoBounds`, and internal edges strictly aligned to existing `512 m` seams (`-1024, 0, +1024`).
2. **Isolated SQLite Pack Paths & Offline Baking (`src/server/tiles/TilePackSqliteStore.ts`, `OfflineHengeloTileBaker.ts`, `scripts/bake-hengelo-tiles.ts`)**:
   - `resolveTilePackPathForTileSize(512)` resolves `data/osm/overijssel-tiles-261114-8ae28196.sqlite`.
   - `resolveTilePackPathForTileSize(1024)` resolves `data/osm/overijssel-tiles-261114-8ae28196-1024m.sqlite` (overridable via `--out` or `OVERIJSSEL_TILE_PACK_1024M_PATH`).
   - `scripts/bake-hengelo-tiles.ts` accepts `--tile-size=1024` (default `512`) and scales macro-block batching cleanly (`batchDimension = 2` -> `2 × 2` batches for `4 × 4`).
3. **Strict Unrelaxed Pack Verification (`src/server/tiles/TilePackVerifier.ts`, `scripts/verify-hengelo-tiles.ts`)**:
   - Accepts `--tile-size=1024` or auto-reads `metadata.tileSizeMeters` when `--pack` points at a `1,024 m` pack.
   - Asserts exact UTM bounds parity and `512 m`-aligned tile boundaries against the canonical `512 m` grid, plus full `SeamValidator` (`24` internal seams at `4 × 4`), triangle/sleeper/building/provenance parity, BVH vs. standard Three.js raycast parity, 4-theme swaps, and determinism (`--check-determinism`).
4. **Reversible Express Routes & Runtime Toggle (`server.ts`, `TileStreamManager.ts`, `src/app/App.tsx`)**:
   - `server.ts` mounts `1,024 m` endpoints exclusively under `/api/tiles-1024m/*` (`/manifest`, `/:lod/:tx/:ty`, `/:snapshotId/:schemaVersion/:lod/:tx/:ty`), leaving `/api/tiles/*` on `512 m`.
   - `TileStreamManager.initialize()` dynamically rebuilds `tileBoundaryOverlay` children inside the existing mounted `THREE.Group` reference to match the loaded manifest's `gridCols × gridRows @ tileSizeMeters`.
   - Developer URL parameters: `?m2a=1&tileSize=1024` (or `?pack=1024m`) streams from `/api/tiles-1024m`; `?m1a=1&tileSize=1024` inspects M1a `4 × 4` `1,024 m` tiles vs. Single-Scene Reference.
5. **Reproducible Comparison Runner (`benchmarks/tileStreamingRunner.ts`)**:
   - Added `--tile-size=<512|1024>`, `--pack=<path>`, `--compare-tile-sizes`, `--runs=<N>`, and `--dataset=synthetic-4096m` (exact `4,096 × 4,096 m` multi-category OSM fixture over identical `createHengeloStudyGrid` bounds and canonical camera trajectories).
   - Reports physical margin distances (`preloadMarginMeters`, `retainMarginMeters`) alongside tile counts and preserves `initialStreamingDiagnostics` (cold-load fetch/decode/reconstruct/commit timings).

---

## 3. Sandbox Verification & `4,096 × 4,096 m` Comparison Results

> **Provenance Note**: Canonical `data/osm/overijssel-261114-8ae28196.sqlite` does not reside in the AI Studio sandbox environment, and Chromium ran on **software WebGL (`ANGLE SwiftShader`)**. Therefore:
> - **Mesh counts, frustum-visible mesh counts, WebGL draw calls, triangle counts, CPU buffer MB, BVH memory MB, driver geometries, pack size, and eviction counts** are **exact deterministic geometry/GL counts** on the `4,096 × 4,096 m` `synthetic-4096m` fixture (`2` paired runs per tile size, identical camera poses and trajectories).
> - **Frame intervals (`frameIntervalMs`) and SwiftShader CPU rasterization** reflect software rendering overhead and cannot replace local RTX 4060 Ti measurements on canonical Hengelo (`~97k` OSM features).

### 3.1 Automated Unit & Integration Verification (`src/world/Tiling1024Experiment.test.ts`)
Executed via `DISABLE_OVERIJSSEL_BOOTSTRAP=1 npx tsx --test src/world/Tiling1024Experiment.test.ts` (**`4 / 4` passed, `0` failed**):
1. **Grid & Boundary Parity**: `createHengeloStudyGrid(1024, 64)` produces `4 × 4` (`16` tiles, `tx 339..342`, `ty 5656..5659`), preserves bit-identical `studyUtmBounds`, `projection.localToUtm(0, 0)`, `studyLocalBounds` (`[-2048, +2048]`), `studyGeoBounds`, and `studyExpandedGeoBounds`, and aligns all tile boundaries strictly onto `-2048, -1024, 0, +1024, +2048`.
2. **Non-Colliding Paths & CLI Parsing**: Verified `resolveTilePackPathForTileSize(512)` vs. `(1024)` separation and `--tile-size`, `--compare-tile-sizes`, `--runs`, `--pack`, `--dataset=synthetic-4096m` flag parsing.
3. **`4,096 × 4,096 m` Bake & Verifier Parity**: Full `verifyBakedTilePackAgainstIngested` passed on the `4 × 4` `1,024 m` bake (`24` internal seams checked, `0` seam defects, `100%` BVH raycast parity, `4/4` themes, `sleeperInstancedParity = true`, determinism check passed).
4. **Dynamic Boundary Overlay & Physical Retain-Ring Proof**: Verified `TileStreamManager` preserves `tileBoundaryOverlay` group reference across pack tile sizes and confirmed `retainMarginTiles = 2` (`2,048 m` ring at `1,024 m` tile size) evicts fewer tiles (`3` vs. `> 3`) on corner-to-corner hops than `512 m` (`1,024 m` ring), while `retainMarginTiles = 1` restores `1,024 m` physical eviction parity (`4` evicted, `4` resident).

### 3.2 Measured `synthetic-4096m` WebGL Comparison (`512 m` vs. `1,024 m`, `2` Paired Runs)
Command executed:
```bash
DISABLE_OVERIJSSEL_BOOTSTRAP=1 npx tsx benchmarks/tileStreamingRunner.ts --dataset=synthetic-4096m --compare-tile-sizes --runs=2 --swiftshader --quick --eviction-hops=10 --out=benchmarks/results/tkt028-1024m-synthetic-4096m.json --markdown-out=benchmarks/results/tkt028-1024m-synthetic-4096m.md
```
Artifact: `benchmarks/results/tkt028-1024m-synthetic-4096m.json` (`1440×900 @ 1x`, `tactical` theme, `E2+/R+`, `preloadMarginTiles = 1`, `retainMarginTiles = 2`, `maxConcurrentFetches = 6`, `maxCommitsPerFrame = 4`).

#### A. Cold Initialization & Pack Footprint
| Configuration | Grid | SQLite Pack | M1a Single Ref Draw Calls | M1a All-Tiles Init (ms) | M2-A Init Wall (ms) | Cold Loaded Tiles | Cold Decode Med / Max (ms) | Cold Commit Med / Max (ms) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| **`512 m` (`LOD0`)** | `8 × 8` (`64` tiles) | `0.52 MiB` | `38–39` (`129` meshes) | `9,283–9,644` | `3,258–3,714` | `36 / 64` | `0.80–1.45 / 47.6` | `6.00–9.40 / 71.8` |
| **`1,024 m` (`LOD0`)** | `4 × 4` (`16` tiles) | `0.36 MiB` (`-30.8%`) | `38–39` (`129` meshes) | `4,758–5,035` | `3,391–3,908` | **`16 / 16` (`100%`)** | **`2.55–2.95 / 79.4`** | **`11.30–31.80 / 54.0`** |

#### B. Cross-Scenario M2-A Streaming Comparison (`512 m` vs. `1,024 m` Medians Across `2` Runs)
| Scenario | `512 m` Calls | `1,024 m` Calls | Call Delta | `512 m` Meshes (Tot / Frust) | `1,024 m` Meshes (Tot / Frust) | `512 m` CPU Render (ms) | `1,024 m` CPU Render (ms) | `512 m` Loaded / Evicted | `1,024 m` Loaded / Evicted | `512 m` Buf / BVH (MB) | `1,024 m` Buf / BVH (MB) |
|---|---:|---:|---:|---|---|---:|---:|---|---|---|---:|
| `closeup_station` | `359` | `188` | **`-47.6%`** | `444 / 114` | `304 / 73` | `2.93` | `1.85` (`-36.8%`) | `36 / 0` | `16 / 0` | `1.281 / 0.055` | `1.579 / 0.074` (`+23.3%`) |
| `medium_navigation` | `409` | `212` | **`-48.2%`** | `444 / 153` | `304 / 91` | `3.33` | `2.15` (`-35.3%`) | `36 / 0` | `16 / 0` | `1.281 / 0.055` | `1.579 / 0.074` (`+23.3%`) |
| `far_overview` | `959` | `318` | **`-66.8%`** | `700 / 480` | `304 / 169` | `7.00` | `2.35` (`-66.4%`) | `64 / 0` | `16 / 0` | `1.662 / 0.078` | `1.579 / 0.074` (`-5.0%`) |
| `continuous_pan` | `331.5` | `200` | **`-39.7%`** | `351 / 107` | `304 / 74` | `2.90` | `1.93` (`-33.6%`) | `30 / 23` | **`16 / 0`** | `0.993 / 0.045` | `1.579 / 0.074` (`+59.0%`) |
| `repeated_pan_eviction` (`10` hops) | **`165`** | `176` | **`+6.7%`** | **`243 / 71`** | `304 / 62` | **`1.80`** | `1.83` (`+1.4%`) | **`19 / 160`** | **`16 / 0`** | **`0.794 / 0.037`** | `1.579 / 0.074` (**`+98.9%`**) |

> **All-Tiles Reference (`m1a_tiled_64`)**: In `far_overview`, `64 × 512 m` mounted together issued `958` draw calls (`700` meshes) vs. `16 × 1,024 m` issuing `318` draw calls (`304` meshes) vs. `m1a_single_scene` (`38` draw calls, `129` meshes). Notice that even `1,024 m` (`4 × 4`) retains **`8.4×` more draw calls** than `m1a_single_scene` on this fixture.

---

## 4. Key Trade-Offs Observed & Canonical Hardware Projection

1. **Draw-Call & Overview Savings (`-48%` to `-67%`)**:
   - Cutting tile count `4×` shrinks per-tile layer batch overhead proportionally. On `far_overview`, draw calls dropped `66.84%` (`959 -> 318`) and SwiftShader CPU `gl.render()` dropped `66.43%` (`7.00 -> 2.35 ms`).
   - Applying the same structural reduction against the owner's **canonical Hengelo RTX 4060 Ti baseline** (`2,900` draw calls, `19.95 ms` median frame interval, `~50 FPS` in `far_overview`), `1,024 m` tiles are projected to reduce canonical `far_overview` draw calls to roughly **`~950–1,150` calls** (still `~2×` above `m1a_single_scene`'s `452` meshes).
2. **Preload / Retention Ring Distortion (`4×` Larger Resident Footprint)**:
   - Keeping `preloadMarginTiles = 1, retainMarginTiles = 2` expands physical preload/retain margins from `512 m / 1,024 m` (`512 m` tiles) to **`1,024 m / 2,048 m` (`1,024 m` tiles)**.
   - During cold initialization at `zoom = 1.8` (`[0, 0, 0]`), the central `4` `1,024 m` tiles plus a `1`-tile preload margin immediately covers all **`16 / 16` tiles (`100%` of the `4,096 × 4,096 m` map)**.
   - Across both `continuous_pan` and `10` opposing `NW ↔ SE` hops (`±1,300 m`), **`0` tiles evicted** at `1,024 m` vs. `160` evictions at `512 m`. As a result, `1,024 m` consumed **`+98.9%` more CPU buffer RAM and `+100%` more BVH RAM** in `repeated_pan_eviction` and emitted **more draw calls (`176` vs. `165`)** than `512 m`! Even on province-scale Overijssel (`> 8 km` spans) where eviction does occur, `3 × 3` visible/preload `1,024 m` tiles cover `9 km²` vs. `2.25 km²` for `512 m` (`4×` larger working set).
3. **Per-Tile Decode, BVH Deserialization & Upload Burst Cost (`2×–4×` Heavier)**:
   - Median cold-load worker decode doubled (`0.80–1.45 ms -> 2.55–2.95 ms`) and median commit time increased (`6.00–9.40 ms -> 11.30–31.80 ms`) even on lightweight synthetic geometry (`1.58 MB` total).
   - On **canonical Hengelo** (`39.48 MiB` compressed / `181.3 MiB` raw across `64` tiles -> `~2.8 MiB` raw per `512 m` tile vs. **`~11.3 MiB` raw per `1,024 m` tile**), each `1,024 m` tile deserializes `~4×` more vertices and BVH nodes in a single frame commit, magnifying frame-time spikes during rapid camera panning unless `maxCommitsPerFrame` is lowered (`1–2`) and worker count is tuned.
4. **Vertex Precision (`Float32`) & Offline Synthesis Granularity**:
   - Tile-local `Float32` coordinates span `[-512, +512]` (plus `64 m` collar) at `1,024 m` vs. `[-256, +256]` at `512 m` (`2×` coarser ULP at tile borders). Our `TileBinaryCodec` sliver-prune fix handled this cleanly (`0` defects in verification), though precision headroom is slightly tighter.
   - Regional `M4` province baking also benefits from smaller `512 m` tiles when skipping sparse rural/agricultural tiles vs. `1 km²` blocks.

---

## 5. Engineering Recommendation

**Recommendation (Pending Local Windows Canonical RTX 4060 Ti Confirmation): Keep `512 m` as the Production `LOD0` Default; Address Far-Zoom Draw Calls via `M3` `LOD1–LOD3` + Sub-Chunk Batching Rather Than Replacing `LOD0` with `1,024 m`.**

Rationale:
1. **`LOD0` (`512 m`) is sized for close/medium streaming agility**, where `1,024 m` tiles carry `4×` heavier per-tile payload/BVH bursts, `4×` coarser spatial eviction (`2,048 m` retain radius at `retain=2`), and unnecessary memory residency in pan/hop navigation.
2. **Far-zoom draw-call pressure (`2,900` calls at `zoom = 0.22`) is fundamentally a missing-coarser-LOD problem**: Even `1,024 m` `LOD0` only addresses a `4 × 4 km` window and cannot scale to Twente (`45 × 35 km`) or Overijssel (`88 × 82.6 km`). Planned **Milestone M3 (`LOD1 = 1,024 m`, `LOD2 = 2,048 m`, `LOD3 = 4,096 m`)** solves far-overview draw calls directly with simplified coarse tiles (`1–4` tiles covering `4 × 4 km` -> `< 150–250` draw calls) *without* bloating close-up `LOD0` streaming granularity!
3. **When to Revisit**: Only reconsider switching `LOD0` to `1,024 m` if the local Windows RTX 4060 Ti `--compare-tile-sizes` run on canonical Hengelo shows BOTH (a) `far_overview` improves substantially (`~50 FPS -> ~60+ FPS` / fewer draw calls), AND (b) `continuous_pan` / `repeated_pan_eviction` p95/p99 frame spikes under canonical density remain flat or lower without memory regressions.

---

## 6. Project-Owner Local Windows Reproduction & Canonical Verification Workflow (PowerShell)

Run these commands from the repository root on Windows (`data/osm/overijssel-261114-8ae28196.sqlite` required):

### Step 1 — Bake the Reversible `1,024 m` Canonical Hengelo Tile Pack
*(Writes `data/osm/overijssel-tiles-261114-8ae28196-1024m.sqlite`; never modifies `overijssel-tiles-261114-8ae28196.sqlite`)*
```powershell
npm run osm:bake-hengelo-tiles -- --tile-size=1024 --json-out=tkt028-1024m-bake.json
```

### Step 2 — Verify Seam Continuity, BVH Parity, Themes & Determinism (`1,024 m`)
```powershell
npm run osm:verify-hengelo-tiles -- --tile-size=1024 --check-determinism --json-out=tkt028-1024m-verify.json
```

### Step 3 — Run Paired `512 m` vs. `1,024 m` Hardware GPU Benchmark (RTX 4060 Ti)
```powershell
npx tsx benchmarks/tileStreamingRunner.ts `
  --dataset=canonical-hengelo `
  --compare-tile-sizes `
  --runs=2 `
  --require-hardware `
  "--out=benchmarks/results/tkt028-1024m-hengelo-comparison.json" `
  "--markdown-out=benchmarks/results/tkt028-1024m-hengelo-comparison.md"
```
*(Optional quick single-tile-size `1,024 m` streaming check: `npx tsx benchmarks/tileStreamingRunner.ts --dataset=canonical-hengelo --tile-size=1024 --require-hardware "--out=benchmarks/results/tkt028-m2b-hengelo-1024m-streaming.json"`)*

### Step 4 — Optional Visual Inspection in Browser (`512 m` vs. `1,024 m`)
Start the dev server (`npm run dev`), then compare side-by-side:
- Default `512 m` (`8 × 8`) M2-A Streaming: `http://localhost:3000/?m2a=1`
- Experimental `1,024 m` (`4 × 4`) M2-A Streaming: `http://localhost:3000/?m2a=1&tileSize=1024`
- Experimental `1,024 m` (`4 × 4`) M1a Harness: `http://localhost:3000/?m1a=1&tileSize=1024`

---

## 7. Canonical Hardware Results & Physical-Margin Follow-up (2026-11-21)

The project owner ran the requested 2-pair `--require-hardware` benchmark on an RTX 4060 Ti against the **real** Hengelo tile packs (8×8 @ 512 m, 4×4 @ 1,024 m). The 1,024 m pack passed offline verification with **0 defects across 24 seams**, **58/58 BVH raycasts**, **4/4 themes**, and deterministic baking.

| Scenario | 512 m calls | 1,024 m calls | 512 m median frame | 1,024 m median frame |
|---|---:|---:|---:|---:|
| closeup_station | 848 | 523 | 16.43 ms | 16.52 ms |
| medium_navigation | 1,104 | 727 | 16.45 ms | 16.60 ms |
| far_overview | **2,900** | **1,224** (-57.8%) | **23.05 ms** | **15.75 ms** (-31.7%) |
| continuous_pan | 661 | 642 | 17.15 ms | 16.70 ms |
| repeated_pan_eviction | 349 | 512 | 16.60 ms | 16.75 ms |

**Interpretation:** The real GPU confirms a substantial overview rendering benefit, but the original comparison used identical *tile counts* for preload/retention. As a result, 1,024 m tiles had a **2,048 m retention margin**, kept **all 16 tiles resident**, and recorded **zero evictions**, compared to **186** evictions for 512 m. This biases close/medium memory use and repeated-pan costs.

The old section 5 recommendation is preserved as historical experiment context. **Do not treat its proposed M3 multi-LOD solution as approved or the production tile-size decision as final.**

Follow-up: [`tickets/TKT-028-F1-physical-margin-parity.md`](../../tickets/TKT-028-F1-physical-margin-parity.md) adds a benchmark-only, opt-in `--match-physical-margins` switch. It holds **512 m preload / 1,024 m retention** fixed for both tile widths (1024 m uses fractional `0.5 / 1` tile margins). The previous baseline and 512 m production configuration remain unchanged.

Next step: complete the matched-margin canonical Windows run and confirm actual 1,024 m eviction/reload and stable resources before selecting a production tile width.

---

## 8. Matched-Margin Windows GPU Verification (2026-11-21)

**TKT-028-F1** follow-up is now implemented and canonical hardware-tested. Physical preload/retain distances were fixed to **512 m / 1,024 m** for both tile widths; the production defaults remain unchanged. The project owner verified **5/5** 1,024 m tests, **0 TypeScript errors**, and a successful Vite build.

The new paired RTX 4060 Ti comparison shows **2,900 → 1,224** far-overview draw calls (-57.8%) and **19.60 → 16.38 ms** aggregate median frame interval (two runs each). During NW↔SE repeated navigation, 1,024 m tiles now **evicted 38 tiles per run** and retained **7** tiles instead of holding all 16 resident. Repeated-pan draw calls fell from **349 to 225**, but 1,024 m had higher settled SE tile-owned geometry memory (**76.50 MiB** versus **48.30 MiB**, +58%) and slower per-tile decoding.

The strict baseline memory check flagged 512 m because the first NW visit had 20 loaded tiles but all subsequent NW visits held exactly 19; the underlying geometry/BVH resources were stable thereafter. No progressive resource growth was observed. Do not reinterpret JavaScript heap fluctuations as proof of a leak.

Run-to-run frame-time variation is meaningful: large tiles are not guaranteed to beat small tiles on every individual frame, and one of the two 1,024 m repeated-pan runs had five intervals over 33.3 ms. **1,024 m is the preferred *candidate*, not a promoted default** until owner-led visual QA confirms no visible loading gaps or unacceptable stutter. See [TKT-028-F1](../../tickets/TKT-028-F1-physical-margin-parity.md) for detailed metrics and acceptance gates.

### Human Visual Comparison — Exact Matched Margins

For the acceptance check, use:

- Baseline: `http://localhost:3000/?m2a=1&tileSize=512&matchPhysicalMargins=1`
- Candidate: `http://localhost:3000/?m2a=1&tileSize=1024&matchPhysicalMargins=1`

Both use **512 m preload / 1,024 m retention**, visible in the streaming diagnostics bar. Pan across opposite Hengelo corners at close and medium zoom and verify that `Evicted` increases, map continuity is maintained, OSM feature inspection works, and zoom-dependent railways/themes remain correct. The plain `&tileSize=1024` viewer uses **legacy 1,024 m preload / 2,048 m retention**, and is not a valid visual test of matched-margin streaming.
