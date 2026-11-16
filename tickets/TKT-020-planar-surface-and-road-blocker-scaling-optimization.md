---
id: TKT-020
title: Planar Surface Resolution, Road Blocker Spatial Indexing & Scaling Benchmark Reliability
type: tech_debt
status: open
priority: high
created: 2026-11-15
updated: 2026-11-15
---

# TKT-020: Planar Surface Resolution, Road Blocker Spatial Indexing & Scaling Benchmark Reliability

## Summary
Eliminate the superlinear CPU bottlenecks in `resolveAndValidatePlanarPolygons` (`src/world/PlanarLayerValidator.ts`), replace the quadratic $O(R \cdot F)$ road candidate blocker scan in `buildGraphAtGradeRoadGeometries` (`src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`) with a deterministic 2D spatial grid index, and fix the duplicate stage execution and substage timer accounting in `benchmarks/scalingWorker.ts` — while guaranteeing **100% bit-for-bit geometry, vertex, triangle, and OSM provenance equivalence**.

**Depends on**: `TKT-019` — Regional Rendering Scalability Assessment (Hengelo S1–S5 to Twente)

**Strict Scope Boundaries**:
- **Do not** alter geometry semantics, polygon ownership rules, or weaken planar/road validation thresholds.
- **Do not** promote `E2+` (`graph-surface`) to the production default.
- **Do not** introduce spatial tiling, streaming, multi-LOD rewriting, or web worker offloading in this ticket.
- **Do not** run the uncontrolled full test suite (`npm test`); verify via focused test suites and bounded `bench:scaling` runs.

---

## 1. Context & Measured Baseline (`TKT-019` Windows & Container Evidence)

The `TKT-019` Hengelo `S1`–`S5` scaling experiment (`benchmarks/results/tkt019-hengelo-scaling.json`, `docs/tkt019-hengelo-scaling-report.md`) established three concrete, high-leverage findings:

1. **Planar Surface Resolution Dominates Regional Build Time (`76.3%` at `S4` Legacy)**:
   - On Windows (`Intel Core i7-14650HX`), `planarSurfaceResolutionMs` scales from `31.6 ms` (`S1`, $N=60$) to `267.7 ms` (`S2`, $N=271$), `2,297.6 ms` (`S3`, $N=857$), and **`11,020.2 ms` (`S4`, $N=2,102$)** out of `14,448.1 ms` total scene generation.
   - Line-level profiling of `PlanarLayerValidator.ts` shows that actual Stage 3 Boolean subtraction (`polygonClipping.union` at L1326 + `polygonClipping.difference` at L1331) accounts for only **`1.4%`** (`~325 ms`) of `S4` planar time:
     - **`85.6%`** (`5,751` calls at `S4`) is spent in **Stage 4 post-resolution validation** (`polygonClipping.intersection(a.resolvedMultiPolygon, b.resolvedMultiPolygon)` at `line 1394`), where perforated macro-landuse polygons (`way/1156887567-0` with `294` holes and `4,060` vertices; `way/1279729432-0` with `111` holes and `2,005` vertices) retain their district-wide outer AABB and run full Martínez-Rueda sweep-line intersections against every small feature carved out of their interior in Stage 3.
     - **`12.7%`** (`5,944` `intersection` calls + `3,370` `isGeometricallyContained` `difference` calls + `0.25 m` boundary step sampling) is spent in **Stage 2 pairwise ownership classification** (`lines 1158–1203`), which calls `isGeometricallyContained` twice per overlapping pair without checking whether `resolvePairwiseOutcome` even uses containment for that semantic-class pair, whether `a.area - interArea <= 0.15`, or whether `a.bbox` is contained in `b.bbox` (`computeBBoxContainmentRatio` at `line 432` is currently unused).
2. **Surface-First Road Candidate Blocker Search Performs `99.7%–99.9%` Redundant AABB Checks**:
   - In `GraphRoadGeometryBuilder.ts` (`lines 3285–3295`), every road subsegment linearly scans `placedRoadFootprints` and allocates 5 temporary arrays via `stroke.flatMap((polygon) => polygon.flat())` + `Math.min(...map)`:
     - **`S1`**: `15,567` checks $\to$ `517` overlaps (`3.321%` hit rate)
     - **`S2`**: `203,206` checks $\to$ `2,015` overlaps (`0.992%` hit rate)
     - **`S3`**: **`2,254,714` checks** $\to$ **`6,523` overlaps** (`0.289%` hit rate; `~142.5 ms` pure scan overhead in container)
     - **`S4`**: **`14,418,060` checks** $\to$ **`15,888` overlaps** (`0.110%` hit rate; `~588.8 ms` pure scan overhead in container)
3. **Scaling Benchmark Worker Executes Planar & Railway Stages Twice Per Iteration**:
   - `benchmarks/scalingWorker.ts` (`lines 375–425`) runs standalone `resolveAndValidatePlanarPolygons` and `buildRailwayInfrastructure` **and** then calls `GeometryBuilder.buildScene()`, which runs both stages a second time. At `S4`, this doubled planar executions to `7` per workload and caused `graph-e2-e3` and `surface-first-e2plus-rplus` to time out at `120 s` during `iter_3_planar` after already completing Warmup, Iteration 1, and Iteration 2.
   - Additionally, `roadSubStagesMs` double-counts `polygonUnionMs` inside `footprintConstructionMs`, `tsx` wrapper invocation drops `--expose-gc` (`gcExposed: false`), and timed-out workers discard completed iteration samples (`iter_1`, `iter_2`).

---

## 2. Required Changes

### Part A — Geometry-Equivalent Planar Resolution Optimization (`src/world/PlanarLayerValidator.ts`)

1. **Precomputed 2D Spatial Grid Index for Polygon Pair Selection**:
   - Replace the $O(N^2)$ nested loops in Stage 1 (`line 1080`) and Stage 2 (`line 1158`), and the per-pair `computeMultiPolygonBBox(wwMp)` recomputation in Stage 3 (`line 1311`), with a deterministic 2D uniform spatial grid (`64 m` cell size) that yields candidate pairs `(i, j)` with $i < j$ in exact lexicographical `(i, j)` order.
2. **Stage 2 Exact Short-Circuit Containment Guards (`lines 1180–1187` & `539–563`)**:
   - Only evaluate `aInB` / `bInA` when `resolvePairwiseOutcome` can actually branch on containment (i.e., skip when `a.semanticClass === 'WATER_BODY' || b.semanticClass === 'WATER_BODY'`, or when `a.semanticClass !== b.semanticClass && a.semanticClass !== 'MACRO_LANDUSE' && b.semanticClass !== 'MACRO_LANDUSE'`).
   - Since `interArea = computeMultiPolygonArea(inter)` is already computed at `line 1175` before `isGeometricallyContained(inner, outer, innerArea, outerArea)` is called:
     - If `innerArea - interArea > CONTAINMENT_TOLERANCE_SQ_M` (`0.15 m²`), `difference(inner, outer)` is mathematically guaranteed to have area `>= innerArea - interArea > 0.15 m²` and therefore **cannot** be contained (`return false` immediately without calling `polygonClipping.difference`!).
     - Also check `computeBBoxContainmentRatio(innerBBox, outerBBox)` (or `0.25 m`-expanded AABB containment) before invoking `polygonClipping.difference`.
   - **Invariant**: For every pair `(i, j)`, `(aInB, bInA)` and `resolvePairwiseOutcome` must return the **exact same result** as the unoptimized code across all `S1`–`S4` datasets.
3. **Stage 4 Post-Resolution Validation Acceleration & Option (`lines 1376–1421`)**:
   - Add an optional `options?: { runPostResolutionAudit?: boolean }` parameter to `resolveAndValidatePlanarPolygons` (defaulting to `true` so all existing unit tests and diagnostic callers continue to run the full Stage 4 audit by default).
   - Accelerate Stage 4 when `runPostResolutionAudit` is `true` by:
     1. Indexing individual polygon **components** (`poly` in `resolvedMultiPolygon`) with their component AABBs in the 2D spatial grid rather than testing the monolithic district-wide outer AABB of multi-component `resolvedMultiPolygon`s.
     2. Skipping pairs `(a, b)` that never overlapped in Stage 2 (`interArea === 0` before subtraction), since Stage 3 subtraction only shrinks polygons (`resolvedMultiPolygon` $\subseteq$ `node.mp`) up to `0.1 mm` ring-conditioning tolerance.
   - **Invariant**: Must preserves the exact `violations` count (`0` at `S1`, `3` at `S2`, `13` at `S3`, `46` at `S4`) and `maxResidualFillOverlapSqMeters` without suppressing or altering any violation.

### Part B — Deterministic Spatial Grid for Road Candidate Blockers (`src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`)

1. **Spatial Grid Index Over `placedRoadFootprints`**:
   - Maintain a deterministic 2D uniform spatial grid (`32 m` cell size) alongside `placedRoadFootprints` whenever `registerRoadFootprint` (`line 2940`) inserts a footprint, recording each footprint's monotonic insertion index.
   - Use the spatial grid to query candidate blockers in:
     - Surface-first (`E2+`) stroke clipping (`line 3290`)
     - Graph (`E2`) ribbon clipping (`line 3443`)
     - Path-junction clipping (`line 3003`)
   - Deduplicate grid cell hits via a monotonic `queryId` stamp array (zero `Set` allocation per query) and sort matching candidates by insertion index so `candidateBlockers` has **100% identical elements and ordering** to `placedRoadFootprints.filter(...)`.
2. **Allocation-Free Stroke Bounding Box**:
   - Replace `stroke.flatMap((polygon) => polygon.flat())` and the four `Math.min/max(...ptsOnSurface.map(...))` calls (`lines 3285–3289`) with a direct nested `for` loop over `stroke` rings.

### Part C — Scaling Benchmark Measurement Reliability (`benchmarks/scalingWorker.ts`, `benchmarks/scalingRunner.ts`, `src/world/GeometryBuilder.ts`)

1. **Single Execution Per Measured Iteration**:
   - Record `planarSurfaceResolutionMs` and `railwayGeometryGenerationMs` directly during `GeometryBuilder.buildScene()` (exposed on `landuseGroup.userData.planarResolutionTimingMs` and `railwaysGroup.userData.railwayGenerationTimingMs`) and remove the duplicate standalone Step 2 (`resolveAndValidatePlanarPolygons`) and Step 4 (`buildRailwayInfrastructure`) calls from `benchmarks/scalingWorker.ts`.
2. **Accurate `roadSubStagesMs` Accounting**:
   - Report non-overlapping sub-stages (`primitiveConstructionMs` vs. `polygonUnionMs`, or clearly document `footprintConstructionMs` as their parent) and emit `roadSubStagesMs: null` (`disabled_by_config` in `unsupportedMetrics`) when `roads === 'graph'`.
3. **Reliable V8 GC Exposure & Partial Timeout Recovery**:
   - Pass `--expose-gc` and `--max-old-space-size` via `NODE_OPTIONS` in `scalingRunner.ts` (and document `--expose-gc` for parent runner invocation) so `gcInvokedBeforeRun` is `true`.
   - Stream per-iteration timing/memory samples from `scalingWorker.ts` to `scalingRunner.ts` over IPC at the end of each measured iteration so that if a workload times out on a later iteration (e.g., `iter_3`), the completed samples from `iter_1`..`iter_{k-1}` are preserved in the report.

---

## 3. Acceptance Criteria

- [ ] **Planar Resolution Speedup**: `planarSurfaceResolutionMs` on `S3` and `S4` is reduced by `>= 75%` compared to the `TKT-019` baseline (`2,297.6 ms` at `S3` and `11,020.2 ms` at `S4` on Windows; `~5,045 ms` at `S3` and `~23,338 ms` at `S4` in container).
- [ ] **Planar Output & Violation Equivalence**: Across `S1`, `S2`, `S3`, and `S4`, `resolveAndValidatePlanarPolygons` produces the **exact same** `conflictsResolved`, `deduplicatedCount`, `unionedCount`, `booleanSubtractionsCount`, `violationsCount` (`0`, `3`, `13`, `46`), `maxResidualFillOverlapSqMeters`, and `resolvedMultiPolygon` areas/vertex counts as before.
- [ ] **Road Blocker Check Reduction & Bit-Identical Geometry**: On `S3` (`surface-first-e2plus-rplus`), `candidateBlockerCheckCount` drops from `2,254,714` by `>= 98%` (to `< 45,000`), while `overlappingBlockerCount` (`6,523` at `S3`, `15,888` at `S4`), `outputPolygonCount` (`2,185`), `outputHoleRingCount` (`3`), `outputTriangleCount` (`48,045`), `cpuBufferMemory.totalBytes`, and `renderedFeaturesCount` remain **100% bit-identical**.
- [ ] **Single-Pass Iteration Measurement & Partial Timeout Capture**: `scalingWorker.ts` runs `buildScene()` once per measured iteration without duplicate standalone planar/railway runs, exposes `gcInvokedBeforeRun: true`, fixes `roadSubStagesMs`, and preserves completed iteration samples when a later iteration times out.
- [ ] **Automated Regression Tests**: Dedicated regression tests in `src/world/RegionalScalabilityBenchmark.test.ts` (or `src/world/PlanarAndRoadSpatialIndex.test.ts`) verifying geometry equivalence, violation preservation, spatial index ordering, and partial timeout sample preservation.

## Related Files and Documentation
- Source: `src/world/PlanarLayerValidator.ts`, `src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`, `src/world/GeometryBuilder.ts`, `benchmarks/scalingWorker.ts`, `benchmarks/scalingRunner.ts`, `benchmarks/types.ts`
- Baseline & Analysis: `benchmarks/results/tkt019-hengelo-scaling.json`, `docs/tkt019-hengelo-scaling-report.md`, `tickets/TKT-019-regional-rendering-scalability.md`
