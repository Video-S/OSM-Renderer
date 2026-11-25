# TKT-038 Report — Spatially Accelerated Instanced Feature Picking

- **Date:** 2026-11-25
- **Ticket:** [`TKT-038`](../../tickets/TKT-038-spatially-accelerated-instanced-feature-picking.md) (`status: in_progress`)
- **ADR:** [`ADR-0014`](../decisions/ADR-0014-spatially-accelerated-instanced-feature-picking.md)
- **Scope:** Decouple `THREE.InstancedMesh` feature picking (`O(log N + k)`) from rendering batch granularity (`1,024 m`, `2,048 m`, `4,096 m`), preserve `TKT-037` rendering performance and exact picking attribution, expose developer toggle + diagnostics, and provide a reproducible multi-mosaic picking benchmark (`npm run bench:instanced-picking`).
- **Acceptance Status:** Implementation, deterministic unit/differential/scaling tests (`src/world/InstancedSpatialPicking.test.ts`), regression suite (`53/53` tests), and SwiftShader Playwright E2E benchmark verification (`900` rays, `0` visible mismatches) are complete. **Hardware RTX 4060 Ti benchmarking and interactive QA on the real Twente mosaics remain open for the project owner.**

---

## 1. Root Cause Analysis

Following `TKT-037` closure, the project owner's RTX 4060 Ti benchmarks confirmed that consolidating `1,024 m` tiles into `4,096 m` spatial batches reduced regional CPU render time from **`36.50 ms` to `4.00 ms`**, while exposing a linear picking penalty on large foliage batches:

| Pose | Tile size | Foliage enabled (median) | Foliage disabled (median) |
|---|---:|---:|---:|
| Street (`zoom 6.5`) | 1,024 m | 8.1 ms | 0.3 ms |
| Street (`zoom 6.5`) | 2,048 m | 11.6 ms | 0.3 ms |
| Street (`zoom 6.5`) | 4,096 m | **40.7 ms** | 0.4 ms |
| Regional (`zoom 0.15`) | 1,024 m | 13.0 ms | 6.6 ms |
| Regional (`zoom 0.15`) | 2,048 m | 20.8 ms | 2.2 ms |
| Regional (`zoom 0.15`) | 4,096 m | **21.4 ms** | 0.9 ms |

Direct inspection of `three@0.186.1` (`THREE.InstancedMesh.prototype.raycast`) and `@react-three/fiber@9.0.0` event traversal identified four compounding causes:

1. **Linear O(N) instance loop:** Every ray intersecting an `InstancedMesh`'s `boundingSphere` linearly transforms and raycasts all `0..count-1` instances (`matrixWorld * instanceMatrix` → `Mesh.prototype.raycast`).
2. **Coarse spherical broad phase:** A flat `4,096 m × 4,096 m` tile has a `boundingSphere` radius of ~`2,896 m`, so cursor rays in neighboring tiles frequently fail to reject the batch.
3. **`firstHitOnly` ignored:** Unlike `three-mesh-bvh`'s `acceleratedRaycast` on static meshes, `InstancedMesh.prototype.raycast` ignores `raycaster.firstHitOnly = true` and inspects every instance even after finding a nearer hit.
4. **Hidden-batch traversal leak:** `THREE.Raycaster.intersectObject(root, true)` invokes `.raycast()` on objects with `visible === false` and descendants of `visible === false` groups, and vanilla `InstancedMesh.prototype.raycast` does not check `this.visible`. Consequently, regional picking at `zoom = 0.15` still linearly scanned 100% of suppressed `ProceduralForest_Trunks` and hidden `Railway_Sleepers_3D`.

---

## 2. Architecture & Candidate Evaluation

| Candidate | Pros | Cons / Why Chosen or Rejected |
|---|---|---|
| **Flat Typed-Array Mesh-Local 3D Instance AABB BVH (`InstancedSpatialIndex.ts`)** | `O(log N + k)`, ~39 B/instance, zero JS node objects, zero rebuild on zoom LOD swaps (union prototype bounds), zero refit on parent rebasing, exact `Mesh.raycast` narrow phase, O(depth) hierarchy visibility skip, built-in diagnostics | **Selected.** Requires one-time build (~0.4 ms per 1,000 instances) at tile reconstruction / scene build. |
| `three-mesh-bvh` `ObjectBVH` (`v0.9.18`) | Already installed | Computes bounds from current `geometry.boundingBox` (breaks on `lod2 → lod0` zoom unless rebuilt), bakes `matrixWorld` at build time, ignores `near`/`far` during node traversal, checks only `object.visible` at leaves, has `// TODO` stubs, no diagnostics. **Rejected.** |
| Uniform 2D Spatial Grid | Simple cell lookup | Wastes memory on sparse `4,096 m` tiles, degrades inside dense forests/vertical stacks, weaker fit for oblique 3D rays and mixed canopy sizes. **Rejected.** |
| Split Rendering Batches | Smaller linear scans | Re-introduces WebGL draw calls and reverses `TKT-037`'s `36.50 ms → 4.00 ms` render win. **Rejected.** |

### Key Implementation Guarantees

- **Zero rendering impact:** Draw calls, GPU buffers, `OSMTILE1` v1 schema (`1.1.0`), and `GeometryBuilder` geometry outputs are completely unchanged.
- **Exact world-space distance & tie-breaking:** Transforming world rays into mesh-local space without normalizing the local direction vector preserves exact world-space `t` under arbitrary parent transforms; equal-distance ties resolve deterministically to the lowest `instanceId`.
- **Union LOD bounds:** `FoliagePrototypeRegistry.getUnionLocalBounds()` encloses `lod0`, `lod1`, and `lod2` prototypes plus `0.05 m` margin, eliminating zoom-transition index rebuilds.
- **Dev toggle & telemetry:** `DiagnosticsPanel` exposes a live `BVH (ON)` / `LINEAR (REF)` toggle (`?instancedPicking=accelerated|unaccelerated`) alongside resident index memory, build time, and last-raycast broad/narrow-phase counters.

---

## 3. Sandbox Verification Results

### 3.1 CPU Unit, Differential & Synthetic Scaling Tests (`InstancedSpatialPicking.test.ts`)

All 4 deterministic test suites passed (`npx tsx --test src/world/InstancedSpatialPicking.test.ts`), and the full 9-file regression suite passed **53 / 53** tests:

1. **Edge cases:** Empty batch (`count = 0`), single rotated/non-uniformly scaled instance, exact vertical (`dx=0, dz=0`), horizontal, oblique, `near`/`far`-clipped rays, 64 stacked coincident-centroid instances (bounded depth `<= 48`, deterministic tie-breaking, all-hits parity), static/instanced occlusion, and hidden parent group rejection (`0` candidates, `0` exact tests).
2. **Randomized differential parity:** `500` seeded rays × `lod0`/`lod1`/`lod2` × `firstHitOnly = true/false` under a translated/rotated rebased parent transform — **0 hit/miss, distance (`<= 1e-4 m`), `instanceId`, or `resolveInspectedFeature` mismatches**.
3. **Lifecycle, LOD & disposal:** Verified zero index rebuild across `lod0 → lod1 → lod2 → lod0`, hidden trunk batch skipping at `lod2`, live `GeometryBuilder` attachment, and deterministic cleanup (`idx.disposed === true`, `mesh.raycast` restored) on `dispose()`.
4. **Synthetic 4 km × 4 km scaling benchmark (32,000 foliage instances across dense clusters + sparse areas, 120 rays):**

| Configuration | Indexed Instances | Index Memory | Build Time | Unaccel med / p95 / max | Accel med / p95 / max | Speedup | Queried → Exact Tests | Mismatches |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `1024m` (16 tiles) | 32,000 | 1.22 MB | 10.23 ms | 0.559 / 0.984 / 2.179 ms | 0.060 / 0.180 / 0.483 ms | **9.3×** | 3,658 → 1.0 | 0 |
| `2048m` (4 tiles) | 32,000 | 1.22 MB | 13.96 ms | 1.960 / 3.419 / 13.375 ms | 0.026 / 0.088 / 1.780 ms | **75.7×** | 12,755 → 0.9 | 0 |
| `4096m` (1 tile) | 32,000 | 1.22 MB | 14.48 ms | 4.329 / 5.362 / 23.252 ms | 0.024 / 0.105 / 0.568 ms | **180.4×** | 32,000 → 0.9 | 0 |

### 3.2 End-to-End Playwright Verification (`benchmarks/instancedPickingRunner.ts`, SwiftShader)

Executed on **2026-11-25** across a synthetic 4×4 mosaic (`25,600` instanced foliage elements + buildings) consolidated to `1,024 m`, `2,048 m`, and `4,096 m`, running `5 × 5` (`25`) NDC rays × (`1` warmup + `2` measured passes) across all 4 camera zooms (`6.5`, `1.2`, `0.65`, `0.15`) × 2 foliage modes × `full_scene` and `foliage_only`:

> **Software Renderer Caveat:** Ran on `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` with `--allow-software`. Browser `performance.now()` is quantized to `0.1 ms`. Picking parity, candidate/test reduction, index memory/build overhead, and draw-call parity are deterministic; WebGL frame/GPU timings are **not** representative of RTX 4060 Ti hardware.

- **Overall Parity:** **900 rays across 36 scope comparisons — 0 visible mismatches**.
- **Full-Scene Picking (Foliage Enabled, `4,096 m`):**
  - Street (`6.5`): `7.50 ms` med (`14.50 ms` max) → **`< 0.10 ms`** med (`0.10 ms` max); avg queried instances **`24,000 → 0.3`** exact tests.
  - Default (`1.2`): `7.40 ms` med (`8.60 ms` max) → **`< 0.10 ms`** med; avg queried **`23,616 → 0.7`** exact tests.
  - City (`0.65`): `7.30 ms` med (`11.80 ms` max) → **`< 0.10 ms`** med; avg queried **`21,408 → 0.8`** exact tests.
  - Regional (`0.15`): `6.30 ms` p95 (`10.50 ms` max) → **`< 0.10 ms`** med (`0.10 ms` p95/max); avg queried **`5,116 → 0.1`** exact tests.
- **Resident Index Footprint (`4,096 m`):** `12` indexed batches, `25,600` instances, `9,252` BVH nodes, **`0.97 MB`** total memory, **`13.70 ms`** total build time (`5.30 ms` avg tile reconstruction).
- **Rendering Regression Guard:** `GL Calls` (`14` street, `13` regional at `4,096 m`) and `GL Tris` remained strictly identical.

---

## 4. Hardware Benchmarking & Interactive Verification (Project Owner — Windows PowerShell)

Run the multi-mosaic picking benchmark directly against your three existing full-Twente mosaics (non-destructive; takes ~2–4 minutes depending on pass count):

```powershell
npm run bench:instanced-picking -- `
  --index-1024=data/osm/twente-full-1024m-foliage-fix/mosaic.json `
  --index-2048=data/osm/twente-full-foliage-fix-batched-2048m/mosaic.json `
  --index-4096=data/osm/twente-full-foliage-fix-batched-4096m/mosaic.json `
  --grid-size=7 `
  --warmup-passes=1 `
  --passes=3 `
  --out=benchmarks/results/tkt038-instanced-picking.json `
  --markdown-out=benchmarks/results/tkt038-instanced-picking.md
```

Optional focused run targeting a specific dense Twente forest UTM coordinate (e.g., Enschede/Hengelo woodland):

```powershell
npm run bench:instanced-picking -- `
  --index-1024=data/osm/twente-full-1024m-foliage-fix/mosaic.json `
  --index-2048=data/osm/twente-full-foliage-fix-batched-2048m/mosaic.json `
  --index-4096=data/osm/twente-full-foliage-fix-batched-4096m/mosaic.json `
  --target-easting=<UTM_E> `
  --target-northing=<UTM_N>
```

### Interactive Visual & Picking QA Checklist

Start the viewer against the `4,096 m` consolidated mosaic:

```powershell
$env:OVERIJSSEL_REGIONAL_MOSAIC_PATH = "data/osm/twente-full-foliage-fix-batched-4096m/mosaic.json"
npm run dev
```

1. Open **Diagnostics** in the right context sidebar and locate **Instanced Feature Picking (TKT-038)**.
2. Verify `BVH (ON)` (`accelerated`) shows resident index memory, indexed instances, and sub-millisecond hover raycast diagnostics across dense woodland, scattered urban trees, roads, buildings, and railways at zooms `6.5`, `1.2`, `0.65`, and `0.15`.
3. Toggle **Instanced Feature Picking** to `LINEAR (REF)` (`unaccelerated`) — or append `?instancedPicking=unaccelerated` — to confirm identical tree/feature selection while observing the linear baseline latency directly in the panel.
4. Inspect `benchmarks/results/tkt038-instanced-picking.md` for `0` visible parity mismatches across all poses and mosaics.
