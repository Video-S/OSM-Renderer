# TKT-036 Report — Runtime Foliage LOD & Rendering Optimization

- **Date:** 2026-11-25
- **Ticket:** [`TKT-036`](../../tickets/TKT-036-runtime-foliage-lod-rendering-optimization.md) (`status: in_progress`)
- **Scope:** Runtime-only optimization for 3D instanced foliage (`OSMTILE1` schema `1.1.0` unchanged; **no regional rebake required**).
- **Acceptance Status:** Automated unit, streaming/lifecycle, build, lint, and SwiftShader Playwright evaluations passed. **Hardware GPU frame timings and visual QA on the Twente mosaics remain open for the project owner.**

---

## 1. Architecture Summary

Baked regional tiles already store per-tree instance transforms and prototype identifiers (`tree_trunk`, `tree_broadleaved`, `tree_needleleaved`), while runtime code reconstructs the prototype meshes. TKT-036 exploits that separation in four parts:

1. **Shared Runtime Prototype Pool (`src/world/FoliageLodSystem.ts` — `FoliagePrototypeRegistry`)**
   - Allocates **7 shared `BufferGeometry` objects total** across all loaded tiles (`1` trunk + `3` broadleaf LODs + `3` conifer LODs), eliminating per-tile prototype duplication.
   - Precomputes per-prototype union local AABBs spanning `lod0..lod2`.
   - `TileStreamManager` owns a single shared registry and disposes it cleanly on teardown; individual tile disposal destroys `InstancedMesh` wrappers without touching shared geometries.

2. **Zoom-Dependent Canopy Prototypes with Hysteresis**
   - Under the orthographic camera (`projectedPx = referenceMeters × zoom`, `canopyReferenceMeters = 4.0`, `trunkReferenceMeters = 0.64`):
     - `lod0 → lod1` below `7.2 px` (`zoom < 1.80`), `lod1 → lod0` above `8.4 px` (`zoom > 2.10`).
     - `lod1 → lod2` below `3.0 px` (`zoom < 0.75`), `lod2 → lod1` above `3.6 px` (`zoom > 0.90`).
   - Switching LOD swaps `mesh.geometry` on each resident canopy `InstancedMesh` in O(loaded tiles) with zero buffer reallocations or GPU re-uploads.

3. **Screen-Space Trunk Suppression**
   - Hides `tree_trunk` `InstancedMesh` batches (`mesh.visible = false`) when projected trunk width drops below `0.50 px` (`zoom < ~0.78`) and restores them above `0.60 px` (`zoom > ~0.94`).
   - Canopies are never hidden and tree positions/density never change.

4. **Conservative Batch-Level Frustum Culling**
   - `computeConservativeInstancedBounds` transforms each prototype's union local AABB through every instance's affine matrix (Arvo method, zero per-instance allocations), pads by a `0.25 m` margin, and populates exact `boundingBox` and circumscribed `boundingSphere` on every foliage `InstancedMesh`.
   - Enables `frustumCulled = true` safely across rotations, scales, regional tile offsets, and LOD transitions without frustum-edge popping.
   - During offline baking (`tileClipBounds` present in `GeometryBuilder`), foliage remains pinned to `lod0`, `visible = true`, and `frustumCulled = false` so `TileBinaryCodec` never bakes runtime culling/suppression flags into tile packs.

---

## 2. Per-Instance Prototype Triangle Budget

Verified directly from `buildFoliagePrototypeGeometry()` and `FOLIAGE_PROTOTYPE_TRIANGLE_COUNTS`:

| Prototype | `lod0` (Baseline / Close) | `lod1` (Medium) | `lod2` (Far) |
|---|---:|---:|---:|
| `tree_trunk` | 24 tris (6-sided closed cylinder) | 24 tris (visible until `< 0.50 px`) | 0 submitted (suppressed via `visible = false`) |
| `tree_broadleaved` | 240 tris (3 × `IcosahedronGeometry(r, 1)`) | **60 tris (`-75.0%`)** (3 × `IcosahedronGeometry(r, 0)`) | **20 tris (`-91.7%`)** (1 × oblate `IcosahedronGeometry(1.95, 0)`) |
| `tree_needleleaved` | 42 tris (3 × 7-sided closed cones) | **15 tris (`-64.3%`)** (3 × 5-sided open-ended cones) | **5 tris (`-88.1%`)** (1 × 5-sided open-ended cone) |
| **Broadleaf tree total (canopy + trunk)** | **264 tris** | **84 tris (`-68.2%`)** | **20 tris (`-92.4%`)** *(trunk suppressed)* |
| **Conifer tree total (canopy + trunk)** | **66 tris** | **39 tris (`-40.9%`)** | **5 tris (`-92.4%`)** *(trunk suppressed)* |

**Design note on `tree_broadleaved` `lod1`:** Three `detail=0` icosahedra (`60` tris) were chosen over a single `detail=1` icosahedron (`80` tris) because they save an extra 20 triangles per instance (`-75.0%` vs `-66.7%`) while retaining the 3-lobe organic silhouette of `lod0`.

**Note on legacy bake-header triangle counter:** `GeometryBuilder.ts` estimates legacy bake-header triangle counts using `index?.count`, which adds `0` for non-indexed `IcosahedronGeometry` broadleaf canopies. That pre-existing counter was intentionally left untouched so baked tile header checksums/stats remain unchanged; runtime foliage telemetry in `FoliageLodSystem.ts` reports exact triangle counts for both indexed and non-indexed geometries.

---

## 3. Isolated 5-Variant Evaluation (Synthetic 4×4 Forest Mosaic, Software WebGL)

Executed on **2026-11-25** via `runFoliageOptimizationBenchmark` against a temporary baked 4×4-tile (`4,096 × 4,096 m`) `OSMTILE1` mosaic containing **3,840 trees** (`2,560` broadleaved + `1,280` needleleaved, 240 trees/tile, 48 resident foliage instanced batches) plus 1 reference road and 1 building.

> **Renderer Warning (SwiftShader):** Measured under headless Chromium software WebGL (`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`). **Frame and CPU timings below do NOT reflect hardware GPU performance.** Only exact geometry counts, draw calls (`renderer.info.render.calls`), driver geometries (`renderer.info.memory.geometries`), and frustum-culled batch counts are authoritative here.

### Pose 1: Close street (`zoom = 6.5`, 16 loaded / 4 visible tiles)

| Variant | Active LOD | Trunks | Foliage Batches (Sub/Res, Culled) | Foliage Tris (Sub / Res) | vs LOD0 | Total GL Tris (med) | GL Calls (med) | Driver Geos |
|---|---|---|---:|---:|---:|---:|---:|---:|
| `baseline` | `lod0` | Visible | 48/48 (0) | 760,320 / 760,320 | -0.0% | 760,342 | 50 | 10 |
| `canopy_lod_only` | `lod0` | Visible | 48/48 (0) | 760,320 / 760,320 | -0.0% | 760,342 (0.0%) | 50 | 10 |
| `trunk_suppression_only` | `lod0` | Visible | 48/48 (0) | 760,320 / 760,320 | -0.0% | 760,342 (0.0%) | 50 | 10 |
| `frustum_culling_only` | `lod0` | Visible | 12/48 (36) | 190,080 / 760,320 | **-75.0%** | 190,102 (-75.0%) | **14** | 10 |
| `combined` | `lod0` | Visible | 12/48 (36) | 190,080 / 760,320 | **-75.0%** | 190,102 (-75.0%) | **14** | 10 |

*Takeaway:* At close street zoom, full `lod0` canopies and trunks are completely preserved (`0%` visual loss), while conservative frustum culling removes 36 out-of-frustum resident batches (`-75.0%` triangles, `-36` draw calls).

### Pose 2: Default startup (`zoom = 1.2`, 16 loaded / 4 visible tiles)

| Variant | Active LOD | Trunks | Foliage Batches (Sub/Res, Culled) | Foliage Tris (Sub / Res) | vs LOD0 | Total GL Tris (med) | GL Calls (med) | Driver Geos |
|---|---|---|---:|---:|---:|---:|---:|---:|
| `baseline` | `lod0` | Visible | 48/48 (0) | 760,320 / 760,320 | -0.0% | 760,374 | 53 | 10 |
| `canopy_lod_only` | `lod1` | Visible | 48/48 (0) | 264,960 / 264,960 | **-65.2%** | 265,014 (-65.1%) | 53 | 10 |
| `trunk_suppression_only` | `lod0` | Visible | 48/48 (0) | 760,320 / 760,320 | -0.0% | 760,374 (0.0%) | 53 | 10 |
| `frustum_culling_only` | `lod0` | Visible | 24/48 (24) | 380,160 / 760,320 | **-50.0%** | 380,214 (-50.0%) | **29** | 10 |
| `combined` | `lod1` | Visible | 24/48 (24) | 132,480 / 264,960 | **-82.6%** | 132,534 (-82.6%) | **29** | 10 |

### Pose 3: City zoom-out (`zoom = 0.65`, 16 loaded / 16 visible tiles)

| Variant | Active LOD | Trunks | Foliage Batches (Sub/Res, Culled) | Foliage Tris (Sub / Res) | vs LOD0 | Total GL Tris (med) | GL Calls (med) | Driver Geos |
|---|---|---|---:|---:|---:|---:|---:|---:|
| `baseline` | `lod0` | Visible | 48/48 (0) | 760,320 / 760,320 | -0.0% | 760,374 | 53 | 12 |
| `canopy_lod_only` | `lod2` | Visible | 48/48 (0) | 149,760 / 149,760 | **-80.3%** | 149,814 (-80.3%) | 53 | 12 |
| `trunk_suppression_only` | `lod0` | Hidden | 32/48 (0) | 668,160 / 760,320 | **-12.1%** | 668,214 (-12.1%) | **37** | 12 |
| `frustum_culling_only` | `lod0` | Visible | 42/48 (6) | 665,280 / 760,320 | **-12.5%** | 665,334 (-12.5%) | 47 | 12 |
| `combined` | `lod2` | Hidden | 28/48 (4) | 50,400 / 149,760 | **-93.4%** | 50,454 (-93.4%) | **33** | 12 |

### Pose 4: Regional minZoom (`zoom = 0.15`, 16 loaded / 16 visible tiles)

| Variant | Active LOD | Trunks | Foliage Batches (Sub/Res, Culled) | Foliage Tris (Sub / Res) | vs LOD0 | Total GL Tris (med) | GL Calls (med) | Driver Geos |
|---|---|---|---:|---:|---:|---:|---:|---:|
| `baseline` | `lod0` | Visible | 48/48 (0) | 760,320 / 760,320 | -0.0% | 760,374 | 53 | 12 |
| `canopy_lod_only` | `lod2` | Visible | 48/48 (0) | 149,760 / 149,760 | **-80.3%** | 149,814 (-80.3%) | 53 | 12 |
| `trunk_suppression_only` | `lod0` | Hidden | 32/48 (0) | 668,160 / 760,320 | **-12.1%** | 668,214 (-12.1%) | **37** | 12 |
| `frustum_culling_only` | `lod0` | Visible | 48/48 (0) | 760,320 / 760,320 | -0.0% | 760,374 (0.0%) | 53 | 12 |
| `combined` | `lod2` | Hidden | 32/48 (0) | 57,600 / 149,760 | **-92.4%** | 57,654 (-92.4%) | **37** | 12 |

*Note:* On this small 4×4 synthetic mosaic, all 16 tiles fit inside the viewport at `zoom = 0.15` (so `0` batches are frustum-culled there). On the 48×40 full-Twente mosaic, out-of-frustum resident prefetch tiles will also be culled at `zoom = 0.15`.

---

## 4. Local Testing & Hardware Benchmark Instructions (Project Owner)

### A. Visual inspection in the viewer

1. Start the dev server pointing at the full-Twente mosaic (or the accepted TKT-033 pilot):
   ```powershell
   $env:OVERIJSSEL_REGIONAL_MOSAIC_PATH = "data/osm/twente-full-1024m/mosaic.json"
   npm run dev
   ```
2. Open `http://localhost:3000/` and open the **Diagnostics** panel (left rail) to locate **Foliage LOD & Culling**:
   - Toggle **Foliage Optimization** ON/OFF at close (`zoom > 2.1`), medium (`zoom ~ 1.2`), and wide (`zoom 0.15–0.65`) views to verify close-up visual parity and acceptable medium/far silhouettes.
   - Click `auto`, `lod0`, `lod1`, `lod2` to compare each prototype directly at the same camera pose.
   - Toggle **Trunk Suppress** and **Frustum Cull** independently while panning/rotating near dense woodland edges to confirm zero edge popping.
   - Open the **Performance** panel to observe live `Foliage` active LOD, submitted vs. resident batches/triangles, and `% vs LOD0` reduction.
   - Click individual trees to confirm feature inspection (`Inspector` panel) still resolves OSM tags, and toggle **Foliage** in **Layers** to confirm visibility toggling still works cleanly.

### B. Hardware GPU 5-variant benchmark

With `npm run dev` running against `twente-full-1024m/mosaic.json` (or `twente-pilot-1024m-tkt033-candidate/mosaic.json`):

```powershell
npm run bench:foliage
```

Optional flags:
- `--include-overview-005` — adds an explicit `zoom = 0.05` overview pose (`regionalMinZoom=0.04`).
- `--target-x=<m> --target-z=<m>` — centers all poses over a specific wooded area (e.g., Enschede/Hengelo/Rijssen forest).
- `--output=<path.json> --markdown=<path.md>` — custom report output paths (defaults to `benchmarks/results/tkt036-foliage-lod.json` and `.md`).
- Hardware WebGL is required by default (`--allow-software` overrides for non-GPU debugging).
