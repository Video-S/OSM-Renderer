---
id: TKT-038
title: Spatially Accelerated Instanced Feature Picking
type: tech_debt
status: in_progress
priority: high
created: 2026-11-25
updated: 2026-11-25
---

# TKT-038: Spatially Accelerated Instanced Feature Picking

## Summary

Significantly reduce the CPU cost of instanced feature picking (`THREE.InstancedMesh`) across `1,024 m`, `2,048 m`, and `4,096 m` regional tile batches while preserving `TKT-037` rendering performance, exact geometric narrow-phase intersection accuracy, original `instanceId`s, feature metadata attribution, and layer visibility semantics.

## Context

In [`TKT-037`](./TKT-037-spatial-batching-feasibility-and-performance-evaluation.md), offline consolidation to `4,096 m` tiles reduced regional CPU render time on the project owner's RTX 4060 Ti from **`36.50 ms` to `4.00 ms`**. However, larger foliage `InstancedMesh` batches introduced a severe feature-picking regression:

| Pose | Tile size | Foliage enabled (median) | Foliage disabled (median) |
|---|---:|---:|---:|
| Street | 1,024 m | 8.1 ms | 0.3 ms |
| Street | 2,048 m | 11.6 ms | 0.3 ms |
| Street | 4,096 m | 40.7 ms | 0.4 ms |
| Regional | 1,024 m | 13.0 ms | 6.6 ms |
| Regional | 2,048 m | 20.8 ms | 2.2 ms |
| Regional | 4,096 m | 21.4 ms | 0.9 ms |

Direct investigation of `three@0.186.1` (`InstancedMesh.prototype.raycast`) and `@react-three/fiber@9.0.0` confirmed four root causes:

1. Vanilla `THREE.InstancedMesh.prototype.raycast()` linearly tests all `N` instances (`O(N)` per ray).
2. Batch broad-phase rejection tests only `InstancedMesh.boundingSphere` (radius ~`2,896 m` on a flat `4,096 m × 4,096 m` tile).
3. Vanilla `InstancedMesh.prototype.raycast()` ignores `raycaster.firstHitOnly = true`.
4. `THREE.Raycaster.intersectObject(root, true)` calls `.raycast()` on `visible === false` meshes/descendants and vanilla `InstancedMesh.prototype.raycast()` does not check visibility, causing regional picking to scan 100% of suppressed trunks (`ProceduralForest_Trunks`) and hidden 3D sleepers (`Railway_Sleepers_3D`).

## Out of scope

- Hierarchical tile streaming, dynamic runtime tile-size switching, or LOD1–LOD3 overview generation.
- Changing foliage rendering batch size, tree density, canopy geometry, or `GeometryBuilder` geometry outputs.
- Camera zoom range changes (`minZoom = 0.15` unchanged).
- Regional rebaking or `OSMTILE1` v1 schema changes (`1.1.0` unchanged).
- Speculative LLM visual testing or fabricating hardware GPU timings.

## Implementation details

See [`ADR-0014`](../docs/decisions/ADR-0014-spatially-accelerated-instanced-feature-picking.md) for the architectural decision and candidate evaluation.

1. **Flat Typed-Array Mesh-Local 3D Instance AABB BVH (`src/world/InstancedSpatialIndex.ts`):**
   - Stores nodes and leaf-ordered instance bounds exclusively in flat TypedArrays (`Float32Array`, `Int32Array`, `Uint32Array`; ~39 bytes/instance, zero per-node JS objects).
   - Uses Arvo exact affine-box transforms with **union prototype bounds across `lod0..lod2`** + `0.05 m` margin so zoom-driven foliage LOD swaps require **zero BVH rebuilds**.
   - Transforms world rays into mesh-local space with unnormalized local direction so slab parameter `t` equals exact world-space distance under arbitrary parent rebasing/rotation/scale without refitting.
   - NaN-safe slab tests (vertical/axis-aligned rays), front-to-back traversal with `firstHitOnly` `effectiveFar` pruning, deterministic equal-distance tie-breaking by lowest `instanceId`, exact `THREE.Mesh.prototype.raycast` narrow-phase testing against active `mesh.geometry`, and `O(depth)` `isObjectHierarchyVisible(mesh)` rejection.
   - Zero-allocation per-ray diagnostics (`resetInstancedRaycastDiagnostics`, `getLastInstancedRaycastDiagnostics`) and developer toggle (`accelerated` vs. `unaccelerated` vanilla Three.js reference).
2. **Tiled & Live Path Integration (`TileSceneReconstructor.ts`, `GeometryBuilder.ts`, `TileStreamManager.ts`):**
   - Automatically attaches `InstancedSpatialIndex` to all instanced foliage batches and 3D railway sleeper batches at tile reconstruction / scene build time, and disposes every spatial index deterministically on tile eviction or scene disposal (`ADR-0006`).
   - Tracks `tileInstancedIndexBytes`, `tileInstancedIndexCount`, `tileInstancedIndexInstances`, and `tileInstancedIndexBuildMsTotal` in `TileStreamDiagnosticsSnapshot`.
3. **Developer Controls & Benchmark Harness (`MapScene.tsx`, `DiagnosticsPanel.tsx`, `App.tsx`, `benchmarks/instancedPickingRunner.ts`):**
   - Added developer toggle (`BVH (ON)` / `LINEAR (REF)`) and live spatial index / last-raycast counters in `DiagnosticsPanel` plus URL query parameter `?instancedPicking=accelerated|unaccelerated`.
   - Extended `__BENCHMARK_MEASURE_FEATURE_PICK__` and added `npm run bench:instanced-picking` (`benchmarks/instancedPickingRunner.ts`) comparing accelerated vs. unaccelerated across `1,024 m`, `2,048 m`, and `4,096 m` mosaics, zooms `6.5 / 1.2 / 0.65 / 0.15`, foliage enabled/disabled, `full_scene` and `foliage_only` scopes, hit/miss timing, per-ray parity, index overhead, and rendering regression guards.

## Acceptance criteria

- [x] Spatial acceleration (`InstancedSpatialIndex`) implemented and attached across tiled (`TileSceneReconstructor.ts`) and live (`GeometryBuilder.ts`) instanced batches without altering rendering draw calls, GPU buffers, or `OSMTILE1` schema.
- [x] Developer A/B toggle (`accelerated` vs. `unaccelerated`) and lightweight picking diagnostics exposed in `DiagnosticsPanel`, URL parameter, and benchmark harness.
- [x] Deterministic edge-case, randomized differential (`500` rays × 3 LODs × `firstHitOnly` true/false × rebased parent), lifecycle/disposal, and multi-tile-size synthetic scaling tests (`src/world/InstancedSpatialPicking.test.ts`) pass with zero visible-hit parity mismatches.
- [x] Reproducible multi-mosaic picking benchmark runner (`benchmarks/instancedPickingRunner.ts`, `npm run bench:instanced-picking`) verified end-to-end via Playwright on a synthetic `1,024 m` → `2,048 m` → `4,096 m` mosaic set.
- [x] Targeted regression suites, `npm run lint`, `npm run build`, and `npm run docs:api` pass.
- [x] Architectural decision (`ADR-0014`) and evaluation report (`docs/reports/tkt038-instanced-feature-picking.md`) published with exact owner reproduction commands.
- [ ] **Owner hardware benchmark on real Twente mosaics:** Project owner runs `npm run bench:instanced-picking` on the RTX 4060 Ti against `data/osm/twente-full-1024m-foliage-fix/mosaic.json`, `data/osm/twente-full-foliage-fix-batched-2048m/mosaic.json`, and `data/osm/twente-full-foliage-fix-batched-4096m/mosaic.json` and confirms interactive picking latency and zero rendering regression.
- [ ] **Owner interactive QA & acceptance:** Project owner interactively hovers/clicks dense forests, individual trees, roads, buildings, and railways across street-to-regional zooms on `4,096 m` batches and signs off on picking responsiveness and accuracy.

## References

- Architecture decision: [`docs/decisions/ADR-0014-spatially-accelerated-instanced-feature-picking.md`](../docs/decisions/ADR-0014-spatially-accelerated-instanced-feature-picking.md)
- Evaluation & benchmark report: [`docs/reports/tkt038-instanced-feature-picking.md`](../docs/reports/tkt038-instanced-feature-picking.md)
- Core implementation: `src/world/InstancedSpatialIndex.ts`, `src/world/tiling/TileSceneReconstructor.ts`, `src/world/GeometryBuilder.ts`, `src/scene/MapScene.tsx`
- Tests & benchmark: `src/world/InstancedSpatialPicking.test.ts`, `benchmarks/instancedPickingRunner.ts`
- Prior spatial batching decision: [`TKT-037`](./TKT-037-spatial-batching-feasibility-and-performance-evaluation.md)
