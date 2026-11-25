---
id: TKT-036
title: Runtime Foliage LOD & Rendering Optimization
type: tech_debt
status: in_progress
priority: high
created: 2026-11-25
updated: 2026-11-25
---

# TKT-036: Runtime Foliage LOD & Rendering Optimization

## Summary

Reduce the GPU rendering cost of 3D instanced foliage through zoom-dependent canopy prototype simplification, screen-space trunk suppression, shared runtime prototype geometry pooling, and conservative batch-level frustum culling — without rebaking existing regional tiles (`OSMTILE1` schema `1.1.0`), altering tree placement/density, or degrading close-up visual quality.

## Context

In the offline tiled regional renderer (`TKT-028`, `TKT-034`), baked tiles store per-tree instance transforms and prototype identifiers (`tree_trunk`, `tree_broadleaved`, `tree_needleleaved`), while the runtime reconstructs prototype `BufferGeometry` meshes. Previously:

1. Every tile reconstructed full-detail foliage prototypes (`24` tris/trunk, `240` tris/broadleaf canopy, `42` tris/conifer canopy) regardless of zoom level.
2. Each reconstructed tile allocated its own prototype `BufferGeometry` instances instead of sharing them across tiles.
3. All foliage `InstancedMesh` batches forced `frustumCulled = false`, causing every resident tile (including prefetch-ring tiles outside the camera frustum) to submit 100% of its foliage instances to WebGL.
4. Trunks remained rendered even when projected below sub-pixel width at zoomed-out city and regional views.

This ticket implements a self-contained runtime optimization that works transparently on already-baked regional mosaics (`twente-pilot-1024m-tkt033-candidate`, `twente-full-1024m`) and on live single-scene builds (`GeometryBuilder`).

## Out of scope

- Hierarchical tiling, tile size changes, or camera zoom range changes (`minZoom = 0.15` unchanged).
- Tree placement, forest density, or forest polygon generalization changes.
- Hiding canopies at zoomed-out levels or introducing billboards/impostors.
- Road, rail, building, or shadow LOD changes.
- Rebaking regional tile packs or modifying the `OSMTILE1` schema `1.1.0` format.

## Implementation details

### 1. Foliage prototype geometry & triangle budgets (`src/world/FoliageLodSystem.ts`)

| Prototype | `lod0` (Close) | `lod1` (Medium) | `lod2` (Far) |
|---|---:|---:|---:|
| `tree_trunk` | 24 tris (6-sided closed cylinder) | 24 tris (or hidden via `visible = false`) | 24 tris (or hidden via `visible = false`) |
| `tree_broadleaved` | 240 tris (3 × `IcosahedronGeometry(r, 1)`) | 60 tris (`-75.0%`, 3 × `IcosahedronGeometry(r, 0)`) | 20 tris (`-91.7%`, 1 × oblate `IcosahedronGeometry(1.95, 0)`) |
| `tree_needleleaved` | 42 tris (3 × 7-sided closed cones) | 15 tris (`-64.3%`, 3 × 5-sided open-ended cones) | 5 tris (`-88.1%`, 1 × 5-sided open-ended cone) |

- **Broadleaf `lod1` design note:** Three `detail=0` icosahedra (`60` tris) were selected over a single `detail=1` icosahedron (`80` tris) because they save more triangles (`-75.0%` vs `-66.7%`) while preserving the characteristic 3-lobe broadleaf crown silhouette across `lod0 → lod1`.
- **Shared prototype pool:** `FoliagePrototypeRegistry` allocates exactly **7** shared `BufferGeometry` instances across all streamed tiles (1 trunk + 3 broadleaf LODs + 3 conifer LODs) plus per-prototype union local AABBs spanning `lod0..lod2`. Disposing individual tiles never disposes shared prototypes; `TileStreamManager.dispose()` and live `BuiltSceneGeometry.dispose()` release them deterministically.

### 2. Provisional screen-space thresholds with hysteresis

Under the orthographic camera (`pixels = meters × zoom`), using `canopyReferenceMeters = 4.0` and `trunkReferenceMeters = 0.64`:

- **`lod0 ↔ lod1`:** enter `lod1` below `7.2 px` (`zoom < 1.80`), return to `lod0` above `8.4 px` (`zoom > 2.10`).
- **`lod1 ↔ lod2`:** enter `lod2` below `3.0 px` (`zoom < 0.75`), return to `lod1` above `3.6 px` (`zoom > 0.90`).
- **Trunk suppression:** hide trunks below `0.50 px` (`zoom < ~0.78`), restore above `0.60 px` (`zoom > ~0.94`).

### 3. Conservative instanced bounding volumes & frustum culling

- `computeConservativeInstancedBounds` transforms each prototype's `lod0..lod2` union local AABB by every instance's full 3×3 affine basis (Arvo method, zero heap allocations per instance), expands by a `0.25 m` safety margin, and assigns exact `boundingBox` and circumscribed `boundingSphere` on the `InstancedMesh` so `frustumCulled = true` never pops trees at frustum edges or across LOD transitions.
- **Bake-flag safety:** `GeometryBuilder` preserves `lod0`, `visible = true`, and `frustumCulled = false` whenever `tileClipBounds` is active (offline baking mode) so `TileBinaryCodec` never bakes suppressed trunks or altered runtime flags into `OSMTILE1` packs.
- **Pre-existing non-indexed broadleaf bake stat note:** `GeometryBuilder.ts` computes legacy bake-header triangle estimates via `index?.count` (adding 0 for non-indexed broadleaf canopies). This was intentionally left unchanged to preserve baked tile header parity; runtime foliage telemetry in `FoliageLodSystem` counts exact triangles for both indexed and non-indexed geometries.

### 4. Controls, telemetry, and benchmark runner

- **DiagnosticsPanel:** Added compact **Foliage LOD & Culling** section (master toggle, `Auto`/`LOD0`/`LOD1`/`LOD2` override, trunk suppression toggle, frustum culling toggle, live submitted/resident readout) plus URL query overrides (`?foliageOpt=0`, `?foliageLod=lod0|lod1|lod2|auto`, `?foliageTrunks=0`, `?foliageCull=0`).
- **PerformancePanel & Harness:** Added live resident vs. submitted foliage batches, culled batches, instances, triangles, active LOD, trunk state, and `% vs LOD0` reduction to `MapScene`, `PerformancePanel`, and `window.__BENCHMARK_HARNESS__`.
- **Reproducible 5-variant benchmark runner:** `benchmarks/foliageOptimizationRunner.ts` (`npm run bench:foliage`) isolates `baseline`, `canopy_lod_only`, `trunk_suppression_only`, `frustum_culling_only`, and `combined` on identical streamed tile sets and camera poses, labeling software WebGL (SwiftShader) honestly.

## Acceptance criteria

- [x] Zoom-dependent `lod0` / `lod1` / `lod2` runtime canopy prototypes implemented with hysteresis and no tile rebaking (`OSMTILE1` schema `1.1.0` compatible).
- [x] Screen-space trunk suppression implemented without hiding canopies or altering tree placement.
- [x] Shared `FoliagePrototypeRegistry` avoids per-tile prototype geometry duplication and disposes cleanly without leaks across streaming/eviction cycles.
- [x] Conservative `InstancedMesh` bounding boxes/spheres enable safe `frustumCulled = true` without edge popping across rotations, scales, and LOD swaps.
- [x] Raycast feature inspection (`resolveInspectedFeature`), layer visibility toggles (`showFoliage`), and offline baking mode remain intact.
- [x] Compact Diagnostics controls, Performance telemetry, and reproducible 5-variant evaluation runner (`npm run bench:foliage`) implemented and verified.
- [x] Automated unit, integration, regression, Playwright UI/benchmark verification, `npm run lint`, and `npm run build` pass.
- [ ] **Owner visual QA:** Project owner verifies close-up parity, LOD transition smoothness, trunk suppression, and edge-popping freedom on `data/osm/twente-full-1024m/mosaic.json` (and/or accepted pilot).
- [ ] **Owner hardware GPU measurement:** Project owner runs `npm run bench:foliage` on a hardware GPU against a real Twente mosaic and confirms frame/GPU impact.

## Verification

- **Status:** Automated sandbox verification passed (`2026-11-25`); **owner visual QA and hardware GPU benchmarking remain open** (ticket kept `in_progress`).
- **Commands executed (2026-11-25):**
  - `npx tsx --test --test-concurrency=1 src/world/FoliageLodOptimization.test.ts src/world/TilingM1bCodecAndRegistry.test.ts src/world/TilingM2aStreaming.test.ts src/world/TilingM2bLifecycleValidation.test.ts src/world/TilingRegionalMosaic.test.ts src/world/WorkspaceUiAndSearch.test.ts` → **28/28 passed** (exit 0).
  - Ephemeral 4×4 synthetic forest mosaic (`3,840` trees: `2,560` broadleaf + `1,280` conifer across 16 `OSMTILE1` tiles) via `runFoliageOptimizationBenchmark` + Playwright Chromium (SwiftShader) UI check → **passed**, 0 page errors; deterministic submitted foliage triangle reductions: `-75.0%` at zoom `6.5` (culling only, LOD0 preserved), `-82.6%` at zoom `1.2` (`lod1` + culling), `-93.4%` at zoom `0.65` (`lod2` + trunk suppression + culling), `-92.4%` at zoom `0.15` (`lod2` + trunk suppression). Full numbers recorded in [`docs/reports/tkt036-foliage-lod-optimization.md`](../docs/reports/tkt036-foliage-lod-optimization.md).
  - `npm run lint` and `npm run build` → recorded in final build check.

## Related files and documentation

- Source:
  - `src/world/FoliageLodSystem.ts`
  - `src/world/tiling/TileSceneReconstructor.ts`
  - `src/world/tiling/TileStreamManager.ts`
  - `src/world/GeometryBuilder.ts`
  - `src/scene/MapScene.tsx`
  - `src/world/prototype/PerformanceBaselineHarness.ts`
  - `src/components/workspace/panels/DiagnosticsPanel.tsx`
  - `src/components/workspace/panels/PerformancePanel.tsx`
  - `src/app/App.tsx`
- Benchmark: `benchmarks/foliageOptimizationRunner.ts` (`npm run bench:foliage`)
- Tests: `src/world/FoliageLodOptimization.test.ts`
- Report & Status:
  - `docs/reports/tkt036-foliage-lod-optimization.md`
  - `docs/STATUS.md`
