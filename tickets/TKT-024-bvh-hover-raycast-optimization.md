---
id: TKT-024
title: Optimize Hover Raycasting with BVH
type: tech_debt
status: closed
priority: high
created: 2026-11-16
updated: 2026-11-16
---

# TKT-024: Optimize Hover Raycasting with BVH

## Summary
Eliminate severe pointer-move FPS degradation on large 3D OpenStreetMap scenes (`2–4 km` regions) by accelerating Three.js / React Three Fiber raycasting with precomputed indirect Bounding Volume Hierarchies (`three-mesh-bvh`). On the frozen Hengelo S4 (`2 × 2 km`, `983,282` triangles, `708,440` building triangles) dataset, full-scene raycast CPU time drops from **`61.248 ms` median (`83.862 ms` p95)** per ray to **`0.694 ms` median (`1.623 ms` p95)** — an **88.3× speedup** overall and a **2,358× speedup** on `buildingsGroup` (`49.522 ms` $\to$ `0.021 ms`) — while preserving 100% identical `faceIndex` $\to$ `faceRanges` $\to$ `InspectableFeatureInfo` mapping across buildings, roads, railways, parks, landuse, water, barriers, and instanced objects.

## 1. Confirmed Root Cause

### React Three Fiber Pointer Pipeline Inspection (`src/scene/MapScene.tsx`)
1. `<group name="MapRoot" onPointerMove={handlePointerMove} onPointerOut={handlePointerOut} onClick={handleClick}>` registers `MapRoot` in React Three Fiber's `state.internal.interaction`.
2. On every DOM `pointermove` event on the WebGL `<canvas>`, React Three Fiber's event system (`events-e51d7528.esm.js`) synchronously invokes `state.raycaster.intersectObject(MapRoot, true)` **before** calling `handlePointerMove(e)`.
3. Consequently:
   - The `if (now - lastHoverTimeRef.current < 16) return;` throttle at `MapScene.tsx:688` runs **after** R3F's synchronous full-scene raycast has already completed.
   - Previously, `lastHoverRaycastMsRef.current` inside `handlePointerMove` only timed `resolveInspectedFeature(e)` (`~0.002 ms` binary search) rather than R3F's `raycaster.intersectObject(MapRoot, true)` call.
4. After `TKT-023` consolidated `12,708` Hengelo S4 buildings into `7` large non-indexed bucket meshes (`708,440` building triangles; `560,124` triangles in `Buildings_default` alone), each bucket mesh's bounding sphere encompasses the entire `2 × 2 km` map. Without spatial acceleration, `THREE.Mesh.prototype.raycast` brute-force tests every triangle in every bucket mesh whose bounding sphere intersects the ray (`708,440` building triangles per `pointermove` event).

### Diagnostic Confirmation on Hengelo S4 (`hengelo-s4-2km.geojson.gz`)
- **Temporarily Disabling Hover Raycasting (Playwright Chromium `1440×900`, `500 m` / `2 km` scenes)**:
  - Stationary mouse: **`16.50 ms`** median frame interval (**`60.6 FPS`**), `0.00 ms` pointer-event overhead.
  - Moving mouse with hover raycasting disabled (capture-phase `stopImmediatePropagation`): **`16.90 ms`** median frame interval (**`59.2 FPS`**), `0.00 ms` (`0.20 ms` p95) pointer-event overhead.
  - Moving mouse with unaccelerated hover raycasting enabled on Hengelo S4 (`2 × 2 km`, `2` pointer events/frame): **`114.40 ms` median (`160.80 ms` p95)** synchronous main-thread CPU time per frame spent in `pointermove` raycasting alone.

## 2. Implementation (`three-mesh-bvh`)

1. **One-Time Indirect BVH Construction (`src/world/SceneResourceManager.ts`, `src/world/GeometryBuilder.ts`)**:
   - Added `SceneResourceManager.enableMeshBvh(mesh)` and `SceneResourceManager.enableGroupBvh(root)` using `MeshBVH` and `acceleratedRaycast` from `three-mesh-bvh`.
   - Constructed BVHs **once** at the end of `GeometryBuilder.buildScene()` across `groundMesh` and all static scene groups (`buildingsGroup`, `roadsGroup`, `railwaysGroup`, `waterGroup`, `parksGroup`, `landuseGroup`, `barriersGroup`, `foliageGroup`), plus `railwayGroupOverride` in `MapScene.tsx` when active.
   - Built all `MeshBVH` instances with `{ indirect: true }`:
     - Leaves non-indexed geometries (`Buildings_*`) non-indexed (`geometry.index === null`) and leaves indexed geometries' `geometry.index` arrays completely untouched.
     - Preserves original triangle order (`0 .. triCount - 1`) so `hit.faceIndex` maps 1:1 to `faceRanges` binary search in `resolveInspectedFeature()`.
   - For single-material meshes (`!Array.isArray(mesh.material)`), temporarily clears `geometry.groups` during `new MeshBVH(geo, { indirect: true })` and immediately restores `geometry.groups` afterwards. This ensures `three-mesh-bvh`'s `getRootPrimitiveRanges()` builds a single unified BVH root covering 100% of triangles even when `mergeWithFaceRanges()` merges grouped `ShapeGeometry` items (such as road junction caps) alongside ungrouped ribbon `BufferGeometry` items.
2. **Accurate Raycast Telemetry & `firstHitOnly` (`src/scene/MapScene.tsx`)**:
   - Enabled `(raycaster as any).firstHitOnly = true` on the R3F raycaster so `three-mesh-bvh` uses `raycastFirst` traversal per mesh.
   - Wrapped top-level `raycaster.intersectObject` / `raycaster.intersectObjects` in `MapScene.tsx` so `hoverRaycastTimeMs` measures the actual R3F raycast execution time plus `resolveInspectedFeature()` lookup time.
3. **BVH Memory Accounting & Disposal (`src/world/SceneResourceManager.ts`)**:
   - Added `SceneResourceManager.getBvhMemoryStats()` reporting `{ bvhCount, rootBytes, indirectBufferBytes, totalBytes, totalMB }` across all active owned geometries.
   - Updated `releaseIntermediateGeometry()` and `dispose()` to clear and delete `geometry.boundsTree` so BVH buffers are released immediately on scene replacement.

## 3. Verification & Before/After Benchmark (`hengelo-s4-2km.geojson.gz`)

### Full-Scene CPU Raycast Benchmark (`100` Viewport Rays across Hengelo S4 `2 × 2 km`, `983,282` Triangles)

| Metric | Before (`THREE.Mesh.prototype.raycast`) | After (`MeshBVH` `{ indirect: true }`, `firstHitOnly = false`) | After (`MeshBVH` `{ indirect: true }`, `firstHitOnly = true`) | Improvement |
| :--- | ---: | ---: | ---: | ---: |
| **Median Raycast CPU Time / Ray** | **`61.248 ms`** | **`0.809 ms`** | **`0.694 ms`** | **`-98.87%` (`88.3×` faster)** |
| **95th Percentile Raycast CPU Time / Ray** | **`83.862 ms`** | **`1.769 ms`** | **`1.623 ms`** | **`-98.06%` (`51.7×` faster)** |
| **`buildingsGroup` Raycast Time (`708,440` tris)** | **`49.522 ms`** | **`0.021 ms`** | **`0.021 ms`** | **`-99.96%` (`2,358×` faster)** |
| **`roadsGroup` Raycast Time** | `4.429 ms` | `0.027 ms` | `0.027 ms` | `-99.39%` (`164×` faster) |
| **`parksGroup` Raycast Time** | `2.999 ms` | `0.035 ms` | `0.035 ms` | `-98.83%` (`85.7×` faster) |
| **`landuseGroup` Raycast Time** | `2.548 ms` | `0.074 ms` | `0.074 ms` | `-97.10%` (`34.4×` faster) |
| **`barriersGroup` Raycast Time** | `1.119 ms` | `0.010 ms` | `0.010 ms` | `-99.11%` (`112×` faster) |
| **`railwaysGroup` Raycast Time** | `0.292 ms` | `0.160 ms` | `0.160 ms` | `-45.21%` (`1.8×` faster) |
| **`waterGroup` Raycast Time** | `0.260 ms` | `0.003 ms` | `0.003 ms` | `-98.85%` (`86.7×` faster) |
| **Feature & `faceIndex` Parity (`100 / 100` rays)** | Baseline | **`0` mismatches (`100%`)** | **`0` mismatches (`100%`)** | **100% identical** |

### Browser Pointer-Move & Frame-Rate Comparison (`1440 × 900` Viewport)

| Scenario | Before BVH | After BVH | Notes |
| :--- | ---: | ---: | :--- |
| **Synchronous `pointermove` Event Duration on Hengelo S4 (`2 × 2 km`)** | **`114.40 ms` median (`160.80 ms` p95)** | **`2.70 ms` median (`8.90 ms` p95)** | **`42.4×` reduction** in main-thread pointer-move blocking time (includes R3F event dispatch + React hover state update) |
| **Interactive Frame Rate — Mouse Stationary (`60 Hz` budget)** | `60.6 FPS` (`16.50 ms` frame interval) | `60.6 FPS` (`16.50 ms` frame interval) | Unchanged stationary baseline |
| **Interactive Frame Rate — Continuous Mouse Movement (`2` moves/frame on `2.5 ms` GPU render budget)** | `~8.0–15.7 FPS` (`63.7–125.0 ms` blocked by CPU raycast) | **`60.0 FPS`** (`< 1.4 ms` CPU raycast per frame; well inside `16.67 ms` frame budget) | Eliminates raycast-induced frame drops during continuous mouse movement |

### BVH Build Time & Memory Overhead on Hengelo S4 (`2 × 2 km`, `237` Meshes, `983,282` Triangles)
- **One-Time BVH Build Time**: `519.2–581.3 ms` total across all `237` static scene meshes (`434.4 ms` for the `7` building bucket meshes containing `708,440` triangles; `6.6 ms` for roads; `30.9 ms` for landuse; `21.7 ms` for railways; `9.3 ms` for parks).
- **BVH Memory Overhead (`SceneResourceManager.getBvhMemoryStats()`)**:
  - `bvhCount`: `237` meshes
  - `rootBytes`: `8,909,216` bytes (`8.496 MB`)
  - `indirectBufferBytes`: `3,192,822` bytes (`3.045 MB`)
  - **`totalBytes`: `12,102,038` bytes (`11.541 MB`)** (`15.38%` of the scene's `75.041 MB` CPU vertex/index buffers; `9.43 MB` for `buildingsGroup`), immediately freed to `0 bytes` on `scene.dispose()`.

## 4. Acceptance Criteria
- [x] Root cause of pointer-move FPS drops confirmed via R3F pointer pipeline inspection and hover-raycast disable test.
- [x] `three-mesh-bvh` indirect BVH constructed once at geometry generation time (`SceneResourceManager.enableMeshBvh` / `enableGroupBvh`), never rebuilt on mouse movement.
- [x] Accurate `faceIndex` $\to$ `faceRanges` $\to$ `InspectableFeatureInfo` mapping preserved with `0` mismatches across indexed and non-indexed geometries, multi-material building buckets, single-material sparse-group road meshes, railways, parks, landuse, water, barriers, and instanced meshes.
- [x] Geometry attributes, index buffers, `geometry.groups`, materials, and rendering output remain 100% unaltered.
- [x] BVH acceleration structures (`boundsTree`) are disposed cleanly when scenes are replaced (`0` retained bytes after `scene.dispose()`).
- [x] Focused automated tests (`src/world/BvhRaycasting.test.ts`, `src/world/BuildingBatching.test.ts`, `src/world/FeatureCoverage.test.ts`, `src/world/BenchmarkInfrastructure.test.ts`, `src/world/RegionalScalabilityBenchmark.test.ts`), `npm run lint`, `npm run build`, and `npm run docs:api` pass.
