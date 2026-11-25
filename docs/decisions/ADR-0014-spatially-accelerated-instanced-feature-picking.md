# ADR-0014: Spatially Accelerated Instanced Feature Picking (Mesh-Local Flat Typed-Array BVH)

- **Status:** Implemented (synthetic CPU & Playwright E2E verified; owner RTX 4060 Ti hardware benchmark & interactive QA pending under `TKT-038`)
- **Date:** 2026-11-25
- **Ticket:** [`TKT-038`](../../tickets/TKT-038-spatially-accelerated-instanced-feature-picking.md)
- **Related ADRs:** [`ADR-0005`](ADR-0005-source-feature-provenance-and-diagnostics.md), [`ADR-0006`](ADR-0006-gpu-resource-lifecycle-and-disposal.md), [`ADR-0011`](ADR-0011-baked-tiles-and-runtime-streaming.md)

## Context

In `TKT-037`, consolidating `1,024 m` baked tiles into `4,096 m` spatial batches reduced regional CPU render time on the owner's RTX 4060 Ti from **`36.50 ms` to `4.00 ms`**. However, larger `THREE.InstancedMesh` foliage batches introduced a severe feature-picking regression:

| Pose | Tile size | Foliage enabled (median) | Foliage disabled (median) |
|---|---:|---:|---:|
| Street (`zoom 6.5`) | 1,024 m | 8.1 ms | 0.3 ms |
| Street (`zoom 6.5`) | 2,048 m | 11.6 ms | 0.3 ms |
| Street (`zoom 6.5`) | 4,096 m | 40.7 ms | 0.4 ms |
| Regional (`zoom 0.15`) | 1,024 m | 13.0 ms | 6.6 ms |
| Regional (`zoom 0.15`) | 2,048 m | 20.8 ms | 2.2 ms |
| Regional (`zoom 0.15`) | 4,096 m | 21.4 ms | 0.9 ms |

Direct inspection of `three@0.186.1` (`InstancedMesh.prototype.raycast`) and `@react-three/fiber@9.0.0` identified four root causes:

1. **Linear O(N) instance traversal:** `THREE.InstancedMesh.prototype.raycast()` linearly loops over all `0..count-1` instances, recomputing `matrixWorld * instanceMatrix` and invoking `Mesh.prototype.raycast` on every instance.
2. **Coarse bounding-sphere broad phase:** Batch rejection tests only `InstancedMesh.boundingSphere` (radius ~`2,896 m` for a flat `4,096 m × 4,096 m` tile), causing rays over neighboring tiles to pass broad-phase rejection.
3. **No `firstHitOnly` pruning:** Vanilla `InstancedMesh.prototype.raycast()` ignores `raycaster.firstHitOnly = true` and evaluates every instance regardless of closer hits.
4. **Hidden-batch visibility leak:** `THREE.Raycaster.intersectObject(root, true)` invokes `.raycast()` on objects with `visible === false` and children of `visible === false` groups, and vanilla `InstancedMesh.prototype.raycast()` does not check visibility. At regional zoom (`0.15`), picking linearly scanned 100% of suppressed `ProceduralForest_Trunks` and hidden `Railway_Sleepers_3D`.

Splitting rendering batches back down to smaller chunks would undo the draw-call reduction proven in `TKT-037`. Picking granularity must be **decoupled from rendering batch granularity**.

## Options Considered

### Option A: Flat Typed-Array Mesh-Local 3D Instance AABB BVH (**Chosen**)
- Build one compact 3D AABB BVH per `InstancedMesh` in **mesh-local coordinates** at tile reconstruction (`TileSceneReconstructor.ts`) and live scene build (`GeometryBuilder.ts`), using only flat TypedArrays (`Float32Array`, `Int32Array`, `Uint32Array`; ~39 bytes/instance, zero per-node JS heap objects).
- Compute each instance's conservative local AABB via Arvo's exact affine-box transform using the **union local bounding box across all foliage LOD prototypes (`lod0..lod2`)** plus a `0.05 m` metric margin so zoom-driven LOD geometry swaps require **zero BVH rebuilds**.
- Transform the incoming world ray into mesh-local space **without renormalizing the local direction vector**, so slab parameter `t` equals exact world-space distance under arbitrary parent rebasing/rotation/scale without refitting the BVH.
- Perform front-to-back traversal with `firstHitOnly` `effectiveFar` pruning, deterministic equal-distance tie-breaking by lowest `instanceId`, exact `THREE.Mesh.prototype.raycast` narrow-phase testing against the active `mesh.geometry` LOD prototype, and O(depth) `isObjectHierarchyVisible(mesh)` rejection.

### Option B: `three-mesh-bvh` `ObjectBVH` (Rejected)
- Installed `three-mesh-bvh@0.9.18` ships an experimental `ObjectBVH`, but inspecting its source revealed critical limitations for this renderer:
  - Bounds are derived from current `object.geometry.boundingBox`, causing false negatives whenever `FoliageLodSystem` swaps `lod2 -> lod0` unless the BVH is rebuilt on every zoom transition.
  - Bakes `matrixWorld` at build time, breaking under tile parent rebasing unless explicitly refit.
  - Ignores `raycaster.near` / `raycaster.far` during node traversal and checks `object.visible` only at leaf level (not ancestor visibility).
  - Contains unfinished `// TODO` API alignment stubs and provides no broad-phase/narrow-phase diagnostic instrumentation.

### Option C: Uniform 2D Spatial Grid (Rejected)
- Wastes memory on sparse `4,096 m` tiles (e.g., `256 × 256 = 65,536` cells even for 10 scattered trees).
- Degrades to linear scans inside dense forest pockets or tall vertical stacks, and handles oblique 3D rays and varying tree crown sizes less cleanly than a 3D AABB hierarchy.

### Option D: Split Rendering Batches into Smaller `InstancedMesh` Chunks (Rejected)
- Re-introduces draw calls and scene-graph traversal overhead, directly regressing the `TKT-037` `36.50 ms -> 4.00 ms` regional rendering improvement.

## Decision

Adopt **Option A: Mesh-Local Flat Typed-Array 3D Instance AABB BVH** (`src/world/InstancedSpatialIndex.ts`), attached automatically to all instanced foliage batches (`ProceduralForest_Trunks`, `ProceduralForest_BroadleavedCanopy`, `ProceduralForest_NeedleleavedCanopy`) and 3D railway sleeper batches (`Railway_Sleepers_3D`) in both the offline tiled path (`TileSceneReconstructor.ts`) and the live/local path (`GeometryBuilder.ts`).

Key invariants:

1. **Zero rendering overhead:** Rendering draw calls, scene object counts, GPU buffers, `OSMTILE1` v1 schema (`1.1.0`), and `GeometryBuilder` geometry outputs remain completely unchanged.
2. **Zero rebuild on zoom/LOD swaps or rebasing:** Union prototype bounds cover `lod0`/`lod1`/`lod2`; mesh-local coordinates remain valid under any parent transform.
3. **Exact narrow-phase geometry & provenance:** Every candidate leaf intersection invokes `THREE.Mesh.prototype.raycast` against the active `mesh.geometry`, returning the exact original `instanceId`, `object = mesh`, and world-space hit point/distance so `resolveInspectedFeature()` remains unchanged.
4. **Strict visibility semantics:** `isObjectHierarchyVisible(mesh)` skips hidden batches (`visible = false` on the mesh or any ancestor) in O(depth) with zero candidate tests, preventing phantom hits on suppressed trunks or hidden 3D sleepers.
5. **Deterministic disposal & dev fallback:** `disposeInstancedSpatialIndex(mesh)` releases all TypedArrays and restores `THREE.InstancedMesh.prototype.raycast` on tile eviction and scene disposal (`ADR-0006`). A developer toggle (`DiagnosticsPanel` + `?instancedPicking=accelerated|unaccelerated` + per-raycaster override) allows direct A/B verification against vanilla linear raycasting.

## Consequences

- **Positive:** Picking cost scales as `O(log N + k)` independent of rendering tile/batch size (`1,024 m`, `2,048 m`, `4,096 m`), enabling large `4,096 m` rendering batches without picking stalls.
- **Positive:** Eliminates hidden-batch linear scans and phantom hits on suppressed trunks and hidden 3D sleepers.
- **Trade-off / Cost:** Adds ~39 bytes of CPU memory per resident instance (~`1.22 MB` for 32,000 instances) and ~`0.4 ms` per 1,000 instances at tile reconstruction time (one-time per tile load, never during zoom or pan).
- **Constraint:** Static meshes continue to use `three-mesh-bvh`'s `acceleratedRaycast` unchanged (`TilePackVerifier.ts` asserts `mesh.raycast === acceleratedRaycast` on static meshes).
- **Future note:** If dynamic runtime instance transforms are ever introduced (e.g., animated or removable trees), the affected batch's `InstancedSpatialIndex` must be refit or rebuilt on mutation.
