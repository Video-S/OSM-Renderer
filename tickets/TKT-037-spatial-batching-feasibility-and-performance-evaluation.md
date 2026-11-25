---
id: TKT-037
title: Spatial Batching Feasibility & Performance Evaluation
type: investigation
status: in_progress
priority: high
created: 2026-11-25
updated: 2026-11-25
---

# TKT-037: Spatial Batching Feasibility & Performance Evaluation

## Summary

Evaluate whether consolidating existing offline-baked `1,024 m` `OSMTILE1` tiles into **`2,048 m` (2×2)** and **`4,096 m` (4×4)** spatial rendering batches significantly reduces regional rendering overhead (draw calls, scene traversal, CPU render time, GPU pass time) — strictly offline without changing geographic geometry, invoking `GeometryBuilder`, or rebaking the full-Twente dataset.

## Context

In `TKT-036`, zoom-dependent canopy simplification, trunk suppression, and conservative instanced frustum culling reduced submitted triangles by ~90% on the owner's RTX 4060 Ti at regional `zoom = 0.15` (`75,912,022 → 7,556,900` tris), yet frame performance remained nearly flat:

| Metric (RTX 4060 Ti, zoom 0.15) | Baseline | TKT-036 Optimized |
|---|---:|---:|
| Submitted triangles | 75,912,022 | 7,556,900 |
| Draw calls | 4,951 | 4,539 |
| CPU render time | 38.80 ms | 38.10 ms |
| GPU pass time | 22.84 ms | 23.73 ms |
| Frame interval | 40.05 ms | 39.55 ms |

The leading hypothesis is that per-object scene traversal, material/state switching, and draw-call submission across many `1,024 m` tiles dominate regional frame cost. Before committing to hierarchical streaming or multi-LOD generation, this ticket builds the tooling and benchmark harness to measure `1,024 m` vs. `2,048 m` vs. `4,096 m` spatial batching cleanly on real Twente hardware data.

## Out of scope

- Dynamic runtime tile-size switching or hierarchical streaming (LOD1–LOD3).
- Geographic simplification, building/road/rail geometry changes, or further foliage simplification.
- Camera zoom range changes (`minZoom = 0.15` unchanged) or shadow pipeline changes.
- Rebaking Twente from Overijssel OSM data or modifying/overwriting existing baked datasets.
- Cross-shard geographic seam repair (`TKT-032`).
- Speculative LLM screenshot comparisons or fabricating hardware GPU timings.

## Implementation details

### 1. Triangle statistics correction (`GeometryBuilder.ts`, `TileGeometryStats.ts`)

- Exported `getTriangleCount(geom)` in `src/world/GeometryBuilder.ts` handling both indexed (`Math.floor(index.count / 3)`) and non-indexed (`Math.floor(position.count / 3)`) `BufferGeometry` objects, replacing all 13 legacy `(geo.index?.count || 0) / 3` sites (including non-indexed `IcosahedronGeometry` broadleaf canopies).
- Added `src/world/tiling/TileGeometryStats.ts` to derive authoritative static and instanced triangle, vertex, and draw-call counts directly from decoded buffers (`computeDecodedTileGeometryStats`) and compare them against stored header metadata (`compareStoredVsComputedTileStats`), staying 100% compatible with existing baked `OSMTILE1` packs without requiring rebaking.
- Extended benchmark telemetry (`MapScene.tsx`) to report `totalSceneObjects`, `residentBufferTriangles`, `visibleBufferTriangles`, `residentGeometries`, and `residentTextures` alongside WebGL submitted triangles (`renderer.info.render.triangles`).

### 2. Standalone offline tile consolidation (`TileConsolidator.ts`, `OfflineTileConsolidator.ts`, `scripts/consolidate-regional-mosaic.ts`)

- Pure deterministic consolidation (`consolidateChildTilePayloads`) operating strictly on decoded `OSMTILE1` v1 payloads — **never invokes `GeometryBuilder` or re-runs OSM processing**.
- Rebases every child mesh vertex and instanced transform matrix into the parent tile's local frame using exact double-precision UTM offsets (`dx = childCenterEasting - parentCenterEasting`, `dz = parentCenterNorthing - childCenterNorthing`) before writing `Float32Array` coordinates.
- Groups static meshes by strict compatibility key: `(layer, canonicalBaseName, materialSlotKeys, renderOrder, effectiveFlags, attributeSignature)` — preserving UVs, `aSwitchAttr`, vertex colors, underground hidden/trace flags, and zoom-dependent railway meshes (`Railway_Rails`, `Railway_Rails_3D`, `Railway_Sleepers_3D`).
- Consolidates multi-material geometries (e.g., building roof + wall slot arrays) by sorting triangles per material slot into **at most 1 contiguous group per material slot** while remapping and coalescing `faceRanges` and rebuilding fresh indirect `MeshBVH` trees.
- Promotes mixed indexed + non-indexed compatible inputs cleanly into a single indexed buffer (`Uint16Array` or `Uint32Array` when `> 65,535` vertices).
- Emits one clean parent-sized `GroundPlane` (2 triangles) per non-empty parent tile.
- Supports configurable instanced spatial sub-batch policies (`--foliage-batch=parent|child|<meters>`, `--sleeper-batch=parent|child|<meters>`) to evaluate draw-call reduction vs. frustum-culling granularity trade-offs.
- `OfflineTileConsolidator` uses a bounded SQLite LRU cache (`maxOpenSourceShards`, default `8`), writes atomic per-shard `OSMTILE1` v1 SQLite packs (`RegionalMosaicPlan.ts` extended with optional rectangular `shardCols`/`shardRows` to support `25×21` @ 2,048 m and `13×11` @ 4,096 m full-Twente grids), refuses to write into or overlap the source mosaic directory, verifies every output shard, and writes `consolidation-report.json`.
- Output mosaics reuse `OSMTILE1` v1 unchanged so `RegionalMosaicHttpHandler` and `TileStreamManager` serve and render them with zero server or streaming protocol changes.

### 3. Reproducible spatial batching benchmark runner (`benchmarks/spatialBatchingRunner.ts`)

- CLI (`npm run bench:spatial-batching`) mounts `1,024 m`, `2,048 m`, and `4,096 m` mosaics on one ephemeral Express + Vite server under separate API routes.
- Locks a single shared absolute UTM `(easting, northing)` camera target across all tile sizes (compensating for UTM parent-grid origin shifts such as the `+1,024 m E / -1,024 m N` shift on full-Twente `4,096 m`).
- Measures 4 stationary zoom poses (`6.5`, `1.2`, `0.65`, `0.15`) × 2 foliage modes (**TKT-036 enabled** vs. **foliage disabled**), repeated runs with warmup, continuous pan streaming across tile boundaries, and 25-point BVH feature-pick raycasting (`measureFeaturePickRaycast`).
- Probes the active WebGL2 `UNMASKED_RENDERER_WEBGL` directly from the canvas, refuses software renderers by default unless `--allow-software` is explicitly passed, and labels SwiftShader output with prominent methodology warnings.

## Acceptance criteria

- [x] `GeometryBuilder` and `TileGeometryStats` accurately count indexed, non-indexed, and instanced triangles without breaking existing baked tiles.
- [x] Standalone offline consolidator produces verified `2,048 m` and `4,096 m` `OSMTILE1` v1 mosaics from existing `1,024 m` mosaics without `GeometryBuilder` or mutating the source mosaic.
- [x] Deterministic synthetic test suite (`SpatialBatchingConsolidation.test.ts`) verifies triangle/instance conservation, world-space precision, multi-material group consolidation, mixed indexed/non-indexed promotion, attribute/flag preservation, BVH raycast + courtyard hole fidelity, zoom switching, partial-border coverage, non-destructive guard, byte determinism, and HTTP serving.
- [x] End-to-end Playwright WebGL verification of `benchmarks/spatialBatchingRunner.ts` passes on a synthetic 4×4 mosaic set (`1,024 m` → `2,048 m` → `4,096 m`), confirming exact triangle conservation and major draw-call reduction.
- [x] `npm run lint`, `npm run build`, targeted regression suites, and `npm run docs:api` pass.
- [x] Feasibility report and exact Windows PowerShell instructions documented in `docs/reports/tkt037-spatial-batching-feasibility.md`.
- [ ] **Owner local consolidation:** Project owner runs `scripts/consolidate-regional-mosaic.ts` against `data/osm/twente-full-1024m-foliage-fix/mosaic.json` to generate local `2,048 m` and `4,096 m` mosaics and reviews consolidation runtime, peak RSS, and storage size.
- [ ] **Owner hardware GPU benchmark:** Project owner runs `benchmarks/spatialBatchingRunner.ts` on RTX 4060 Ti comparing `1,024 m`, `2,048 m`, and `4,096 m` (foliage enabled & disabled, stationary + pan + raycast pick).
- [ ] **Owner visual QA & architectural decision gate:** Project owner inspects `2,048 m` / `4,096 m` interactively for visual parity, streaming feel, and picking responsiveness, then decides whether to adopt larger static batches, proceed to hierarchical multi-LOD streaming, or investigate another bottleneck.

## References

- Evaluation & methodology report: [`docs/reports/tkt037-spatial-batching-feasibility.md`](../docs/reports/tkt037-spatial-batching-feasibility.md)
- Prior foliage optimization baseline: [`TKT-036`](./TKT-036-runtime-foliage-lod-rendering-optimization.md), [`docs/reports/tkt036-foliage-lod-optimization.md`](../docs/reports/tkt036-foliage-lod-optimization.md)
- Full-Twente baseline: [`TKT-034`](./TKT-034-full-twente-scale-out.md), [`docs/reports/tkt034-full-twente-baseline.md`](../docs/reports/tkt034-full-twente-baseline.md)
