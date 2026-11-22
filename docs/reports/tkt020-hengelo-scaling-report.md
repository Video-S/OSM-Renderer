# Regional Rendering Scalability Assessment (Hengelo S1–S5)

- **Generated**: 2026-11-16T18:43:38.613Z
- **Dataset Source**: overijssel-261114.osm.pbf (OSM base timestamp: `2026-11-14T21:20:41.000Z`)
- **OSM Attribution**: © OpenStreetMap contributors (ODbL 1.0) via Geofabrik Overijssel extract
- **Environment**: Node v22.23.2 on linux (x64), unknown (4 logical cores), System RAM: 12,288 MB
- **Git Metadata**: `unknown` (status: `not_a_git_repository`, dirty: `false` — No .git repository metadata was found in the workspace (e.g., archive/snapshot export); commit SHA is unavailable.)
- **Resource Guardrails**: sequential child worker (`concurrency = 1`), `maxRss = 3072 MB`, `--max-old-space-size=2048 MB`, `timeout = 120 s`, `validatorMaxEdges = 250`, `warmup = 1`, `iterations = 3`

> **TKT-020 Post-Optimization Summary (`12/12` `S1`–`S4` Workloads Completed, `gcInvokedBeforeRun: true`, `0` Disposal Leaks)**:
> - **Planar Surface Resolution (`PlanarLayerValidator.ts`)**: `planarSurfaceResolutionMs` dropped in container from `5,078.6 ms` (`S3`) / `23,242.0 ms` (`S4`) to **`496.3–558.4 ms` (`S3`, `-89.0%` to `-90.2%`)** and **`1,108.2–1,160.4 ms` (`S4`, `-95.0%` to `-95.2%`)** — also **`-75.7%` (`S3`)** and **`-89.5%` (`S4`)** faster even when compared against the `TKT-019` Windows `i7-14650HX` `production-legacy` baseline (`2,297.6 ms` / `11,020.2 ms`), while preserving **100% identical** MultiPolygon geometries, SHA-256 checksums, `conflictsResolved`, `unionedCount`, `booleanSubtractionsCount`, and residual overlap violations (`0` / `3` / `13` / `46`; `8.80e-5` / `3.43e-4` / `1.26e-3` / `2.06e-3 m²`).
> - **Road Blocker Spatial Grid (`GraphRoadGeometryBuilder.ts`)**: `surface-first-e2plus-rplus` `candidateBlockerCheckCount` dropped from `2,254,714` to **`18,139` at `S3` (`-99.20%`)** and from `14,418,060` to **`40,196` at `S4` (`-99.72%`)**, keeping **100% bit-identical** `BufferGeometry` buffers, `faceRanges`, `overlappingBlockerCount` (`517`, `2,015`, `6,523`, `15,888`), polygons, holes, and triangles (`2,185` polys / `3` holes / `48,045` tris at `S3`).
> - **End-to-End Unblocking of `S4` E2 & E2+**: Both `graph-e2-e3` and `surface-first-e2plus-rplus` previously timed out at `120 s` during `S4` (`TKT-019`); with `TKT-020`, `S4` completes in **`5,442.7 ms`** (`graph-e2-e3`) and **`8,669.7 ms`** (`surface-first-e2plus-rplus`, faster than `production-legacy`'s `9,771.0 ms`). `S5` was intentionally omitted (`--max-scale=S4`) per ticket scope; `TKT-019` historical artifacts remain untouched.

## 1. Progressive Hengelo Real-World Dataset Series

| Level | Extent | Area (km²) | Raw GeoJSON | OSM Nodes / Ways / Rels | Parsed Total | Roads | Railways | Buildings | Landuse + Parks | Water | Barriers | Landmarks | SHA-256 (gzip prefix) |
| :--- | :--- | ---: | ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| S1 | 250 × 250 m | 0.0625 | 957 | 3,998 / 374 / 5 | 456 | 122 | 22 | 67 | 58 | 6 | 20 | 161 | `5e0a8198254b` |
| S2 | 500 × 500 m | 0.2500 | 2,757 | 10,611 / 1,166 / 9 | 1,589 | 365 | 46 | 252 | 260 | 23 | 82 | 561 | `9b08ccab2249` |
| S3 | 1000 × 1000 m | 1.0000 | 9,738 | 34,093 / 4,318 / 13 | 5,814 | 1,166 | 106 | 1,632 | 830 | 53 | 302 | 1,725 | `9177e6c5b277` |
| S4 | 2000 × 2000 m | 4.0000 | 36,669 | 134,951 / 18,794 / 18 | 22,437 | 2,880 | 170 | 12,700 | 2,039 | 147 | 535 | 3,966 | `a7064d39851e` |

## 2. Progression Summary by Renderer Configuration

| Configuration | Highest Completed Level | Stopped At | Completed / Failed / Skipped | Stop Reason |
| :--- | :--- | :--- | :--- | :--- |
| `production-legacy` | S4 | — | 4 / 0 / 0 | All attempted scales completed within limits |
| `graph-e2-e3` | S4 | — | 4 / 0 / 0 | All attempted scales completed within limits |
| `surface-first-e2plus-rplus` | S4 | — | 4 / 0 / 0 | All attempted scales completed within limits |

## 3. Pipeline Stage Timings, Memory & Geometry Scaling

| Level | Config | Status | Full Scene | Parse | Graph + Adapter | Planar | Roads (Sub-stages) | Railway | Peak RSS (Worker / Polled) | CpuBuf MB | Tris (w/ Inst) | Meshes | Disposal Leaks |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| S1 | `production-legacy` | `completed` | 262.7 ms | 53.4 ms | N/A (legacy) | 67.7 ms | 52.1 ms | 95.3 ms | 241.7 / 241.7 MB | 1.07 | 57,156 | 49 | 0 (OK) |
| S2 | `production-legacy` | `completed` | 669.0 ms | 111.0 ms | N/A (legacy) | 205.4 ms | 217.1 ms | 119.5 ms | 270.3 / 270.3 MB | 2.92 | 177,113 | 77 | 0 (OK) |
| S3 | `production-legacy` | `completed` | 2333.3 ms | 276.7 ms | N/A (legacy) | 558.4 ms | 1205.2 ms | 207.3 ms | 417.9 / 417.9 MB | 9.43 | 584,922 | 133 | 0 (OK) |
| S4 | `production-legacy` | `completed` | 9771.0 ms | 843.0 ms | N/A (legacy) | 1160.4 ms | 7046.3 ms | 422.3 ms | 856.2 / 856.2 MB | 39.74 | 1,366,736 | 272 | 0 (OK) |
| S1 | `graph-e2-e3` | `completed` | 406.0 ms | 71.0 ms | 20.0 ms + 11.6 ms | 82.7 ms | 166.4 ms | 94.4 ms | 232.7 / 232.7 MB | 1.08 | 57,057 | 49 | 0 (OK) |
| S2 | `graph-e2-e3` | `completed` | 780.3 ms | 129.9 ms | 57.3 ms + 14.3 ms | 182.2 ms | 350.9 ms | 129.4 ms | 293.9 / 293.9 MB | 2.97 | 180,925 | 77 | 0 (OK) |
| S3 | `graph-e2-e3` | `completed` | 2094.5 ms | 297.2 ms | 166.5 ms + 30.2 ms | 511.9 ms | 1015.4 ms | 207.3 ms | 502.1 / 502.1 MB | 9.54 | 592,223 | 133 | 0 (OK) |
| S4 | `graph-e2-e3` | `completed` | 5442.7 ms | 857.5 ms | 396.6 ms + 89.1 ms | 1108.2 ms | 2537.0 ms | 417.8 ms | 1057.9 / 1057.9 MB | 39.97 | 1,378,929 | 272 | 0 (OK) |
| S1 | `surface-first-e2plus-rplus` | `completed` | 364.9 ms | 47.8 ms | 13.4 ms + 6.7 ms | 65.4 ms | 141.2 ms (prim 2.4 ms, un 55.0 ms, cl 66.3 ms, tri 10.2 ms) | 105.1 ms | 292.5 / 292.5 MB | 1.11 | 58,381 | 49 | 0 (OK) |
| S2 | `surface-first-e2plus-rplus` | `completed` | 1091.4 ms | 116.2 ms | 68.2 ms + 13.1 ms | 193.9 ms | 570.8 ms (prim 9.3 ms, un 221.9 ms, cl 277.1 ms, tri 31.1 ms) | 195.3 ms | 309.6 / 309.6 MB | 3.13 | 187,536 | 74 | 0 (OK) |
| S3 | `surface-first-e2plus-rplus` | `completed` | 3058.1 ms | 305.6 ms | 170.1 ms + 33.0 ms | 496.3 ms | 1763.7 ms (prim 21.6 ms, un 662.1 ms, cl 896.3 ms, tri 103.1 ms) | 428.7 ms | 516.2 / 516.2 MB | 10.18 | 617,341 | 124 | 0 (OK) |
| S4 | `surface-first-e2plus-rplus` | `completed` | 8669.7 ms | 838.5 ms | 418.7 ms + 84.9 ms | 1141.2 ms | 4990.8 ms (prim 48.2 ms, un 1885.7 ms, cl 2537.3 ms, tri 301.1 ms) | 960.7 ms | 1159.2 / 1159.2 MB | 41.77 | 1,446,528 | 254 | 0 (OK) |

## 4. Boolean Operation Counts & Geometry Workload Indicators

| Level | Config | Planar Check / Conflicts / Union / Diff | Road Blocker Checks / Overlaps | Road Union / Inter / Diff | Road Reject / Sub / ClipFail | Rail Ballast Unions | Rail Spatial Index Queries / Entries |
| :--- | :--- | :--- | :--- | :--- | :--- | ---: | :--- |
| S1 | `production-legacy` | 49 / 50 / 1 / 13 | 289 / 41 | N/A / 1,755 / 31 | N/A / 0 / 2 | N/A | 492 cells / 196 segs |
| S2 | `production-legacy` | 226 / 216 / 2 / 54 | 1,423 / 178 | N/A / 7,351 / 121 | N/A / 2 / 3 | N/A | 946 cells / 416 segs |
| S3 | `production-legacy` | 723 / 713 / 3 / 134 | 5,044 / 610 | N/A / 50,453 / 394 | N/A / 6 / 8 | N/A | 2,016 cells / 1,184 segs |
| S4 | `production-legacy` | 1,685 / 1,676 / 4 / 395 | 12,633 / 1,669 | N/A / 242,278 / 1,075 | N/A / 40 / 23 | N/A | 5,774 cells / 2,302 segs |
| S1 | `graph-e2-e3` | 49 / 50 / 1 / 13 | 0 / 0 | 0 / N/A / 0 | 1 / 2 / 0 | N/A | 492 cells / 196 segs |
| S2 | `graph-e2-e3` | 226 / 216 / 2 / 54 | 0 / 0 | 0 / N/A / 0 | 6 / 4 / 0 | N/A | 946 cells / 416 segs |
| S3 | `graph-e2-e3` | 723 / 713 / 3 / 134 | 0 / 0 | 0 / N/A / 0 | 38 / 16 / 0 | N/A | 2,016 cells / 1,184 segs |
| S4 | `graph-e2-e3` | 1,685 / 1,676 / 4 / 395 | 0 / 0 | 0 / N/A / 0 | 144 / 41 / 0 | N/A | 5,774 cells / 2,302 segs |
| S1 | `surface-first-e2plus-rplus` | 49 / 50 / 1 / 13 | 1,626 / 517 | 178 / N/A / 155 | 0 / 4 / 0 | 2 | 492 cells / 196 segs |
| S2 | `surface-first-e2plus-rplus` | 226 / 216 / 2 / 54 | 6,133 / 2,015 | 639 / N/A / 583 | 0 / 6 / 0 | 1 | 946 cells / 416 segs |
| S3 | `surface-first-e2plus-rplus` | 723 / 713 / 3 / 134 | 18,139 / 6,523 | 2,130 / N/A / 1,952 | 5 / 13 / 0 | 3 | 2,016 cells / 1,184 segs |
| S4 | `surface-first-e2plus-rplus` | 1,685 / 1,676 / 4 / 395 | 40,196 / 15,888 | 5,391 / N/A / 4,976 | 29 / 21 / 0 | 9 | 5,774 cells / 2,302 segs |

## 5. Data Completeness, Topology & Geometry Correctness

| Level | Config | Classified -> Rendered (Ratio) | Unsupported / Rejected | Clipped / Omitted | Unresolved Switch / Grade / Cross / Pt | Unattrib Faces / Inst / NaN Verts | Planar Overlap m² | Mesh Winding / Degenerate | Road Overlap & Coverage Guard |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | ---: | :--- | :--- |
| S1 | `production-legacy` | 520 -> 399 (76.7%) | 437 / 0 | 115 / 64 | 0 / 0 / 0 / 0 | 0f / 0i / 0 | 8.80e-5 | 167w / 0d | RoadVal Executed (ov=61, cont=13) |
| S2 | `production-legacy` | 1,639 -> 1,404 (85.7%) | 1,118 / 0 | 188 / 50 | 0 / 0 / 5 / 0 | 0f / 0i / 0 | 3.43e-4 | 197w / 1d | skipped_due_to_complexity_guard |
| S3 | `production-legacy` | 5,855 -> 5,346 (91.3%) | 3,883 / 0 | 331 / 41 | 2 / 2 / 9 / 0 | 0f / 0i / 0 | 1.26e-3 | 424w / 3d | skipped_due_to_complexity_guard |
| S4 | `production-legacy` | 22,475 -> 21,692 (96.5%) | 14,194 / 2 | 560 / 36 | 7 / 6 / 10 / 0 | 0f / 0i / 0 | 2.06e-3 | 799w / 11d | skipped_due_to_complexity_guard |
| S1 | `graph-e2-e3` | 520 -> 399 (76.7%) | 437 / 0 | 115 / 64 | 0 / 0 / 0 / 0 | 0f / 0i / 0 | 8.80e-5 | 0w / 0d | RoadVal Executed (ov=3, cont=0) |
| S2 | `graph-e2-e3` | 1,639 -> 1,405 (85.7%) | 1,118 / 0 | 188 / 50 | 0 / 0 / 5 / 0 | 0f / 0i / 0 | 3.43e-4 | 0w / 0d | skipped_due_to_complexity_guard |
| S3 | `graph-e2-e3` | 5,855 -> 5,346 (91.3%) | 3,883 / 0 | 331 / 41 | 2 / 2 / 9 / 0 | 0f / 0i / 0 | 1.26e-3 | 0w / 0d | skipped_due_to_complexity_guard |
| S4 | `graph-e2-e3` | 22,475 -> 21,693 (96.5%) | 14,194 / 2 | 560 / 36 | 7 / 6 / 10 / 0 | 0f / 0i / 0 | 2.06e-3 | 0w / 0d | skipped_due_to_complexity_guard |
| S1 | `surface-first-e2plus-rplus` | 520 -> 398 (76.5%) | 437 / 0 | 115 / 64 | 0 / 0 / 0 / 0 | 0f / 0i / 0 | 8.80e-5 | 0w / 0d | Executed (ov=0, covDef=0, ratio=0.9994) |
| S2 | `surface-first-e2plus-rplus` | 1,639 -> 1,403 (85.6%) | 1,118 / 0 | 188 / 50 | 0 / 0 / 5 / 0 | 0f / 0i / 0 | 3.43e-4 | 0w / 0d | skipped_due_to_complexity_guard |
| S3 | `surface-first-e2plus-rplus` | 5,855 -> 5,343 (91.3%) | 3,883 / 0 | 331 / 41 | 2 / 2 / 9 / 0 | 0f / 0i / 0 | 1.26e-3 | 0w / 0d | skipped_due_to_complexity_guard |
| S4 | `surface-first-e2plus-rplus` | 22,475 -> 21,684 (96.5%) | 14,194 / 2 | 560 / 36 | 7 / 6 / 10 / 0 | 0f / 0i / 0 | 2.06e-3 | 0w / 0d | skipped_due_to_complexity_guard |

## 6. Empirical Scaling Observations & Bottleneck Analysis

- **`production-legacy` (S1 → S4)**: Area scaled **64×** and parsed features **49.2×**, while `fullSceneGeometryGenerationMs` median scaled **37.2×** (262.7 ms → 9771.0 ms) and worker peak RSS increased by **+614.6 MB** (to 856.2 MB). Largest measured scene sub-stage at S4: `roadGeometryGeneration` (7046.3 ms, 72% of scene build).
- **`graph-e2-e3` (S1 → S4)**: Area scaled **64×** and parsed features **49.2×**, while `fullSceneGeometryGenerationMs` median scaled **13.4×** (406.0 ms → 5442.7 ms) and worker peak RSS increased by **+825.1 MB** (to 1057.9 MB). Largest measured scene sub-stage at S4: `roadGeometryGeneration` (2537.0 ms, 47% of scene build).
- **`surface-first-e2plus-rplus` (S1 → S4)**: Area scaled **64×** and parsed features **49.2×**, while `fullSceneGeometryGenerationMs` median scaled **23.8×** (364.9 ms → 8669.7 ms) and worker peak RSS increased by **+866.8 MB** (to 1159.2 MB). Largest measured scene sub-stage at S4: `roadGeometryGeneration` (4990.8 ms, 58% of scene build).

## 7. Architectural Implications Toward Twente (~Regional Scale)

- **Offline / Prebaked Geometry vs. Runtime Client Generation**: Runtime in-browser polygon Boolean resolution (`polygon-clipping`), triangulation, and 3D sleeper synthesis already take multiple seconds even on a single 2×2–4×4 km Hengelo tile; whole-Twente geometry (~1,500 km², ~100×–375× the area of `S4`/`S5`) cannot be built synchronously on a browser main thread from raw GeoJSON.
- **Spatial Tiling & Chunk Boundary Effects**: Fixed 2D Euclidean projection with square/radial clipping introduces `clippedAtStart`/`clippedAtEnd` boundary cuts (`boundaryClippedNodeCount`) and portal discontinuity risks if tiles are built independently without canonical OSM IDs or deterministic tile-overlap halos + shared edge ownership rules.
- **Spatial Indexing Before Polygon Clipping / Proximity Checks**: Stages whose runtime grows super-linearly with feature density (pairwise polygon ownership/planar checks, unindexed road blocker sweeps, or dense `polygonClipping.union` cascades) exhibit super-linear growth across `S1` -> `S5`; grid/R-tree spatial indexing and tile-scoped bounding reduce candidate checks from quadratic to near-linear per tile.
- **Multi-LOD & On-Demand Loading**: Full 3D instanced sleepers (`sleeperInstancesCount`), detailed building extrusions, and minor street-furniture landmarks (`waste_basket`, `bench`, `tree`) should be streamed by zoom-appropriate tile LOD rather than materialized across an entire region simultaneously.
- **Web Workers**: Even inside a single interactive neighborhood tile (`S3`/`S4`), moving `LocalGeoJsonProvider`, `buildInfrastructureGraph`, `resolveAndValidatePlanarPolygons`, and road/railway Boolean triangulation off the UI thread prevents multi-second main-thread freezes.

## 8. Recommended Next Milestone & First Measured Bottleneck

- **First Measured Scaling Bottleneck**: At the largest completed extent (`S4`, 4 km²), `roadGeometryGeneration` in `production-legacy` accounted for **7046.3 ms** (see Section 3 & Section 4 for Boolean/candidate op counts across configurations).
- **Recommended Next Milestone**: Before attempting Twente-wide scenes, introduce **spatially indexed / tiled scene synthesis** (bounding candidate polygons and road blockers via a uniform spatial hash / R-tree per tile, and partitioning datasets into bounded tile extents with off-main-thread Web Worker / prebaked tile support), guided directly by the measured stage timings and Boolean operation counts recorded in this report.

