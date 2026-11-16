---
id: TKT-019
title: Regional Rendering Scalability Assessment (Hengelo S1–S5 to Twente)
type: tech_debt
status: closed
priority: high
created: 2026-11-15
updated: 2026-11-15
---

# TKT-019: Regional Rendering Scalability Assessment (Hengelo S1–S5 to Twente)

## Summary
Empirically measure CPU pipeline performance, memory footprint, resource cleanup, data completeness, topology resolution, and geometry correctness across a deterministic progression of real-world OpenStreetMap extracts around **Hengelo** (`S1` `250 × 250 m` through `S5` `4 × 4 km`, toward eventual **Twente** regional targets) under all three renderer configurations (`production-legacy`, `graph-e2-e3`, `surface-first-e2plus-rplus`), and perform an empirical root-cause investigation of the measured bottlenecks and planar validation violations.

**Scope Constraint**: Measurement, instrumentation, root-cause investigation, and architectural assessment only — **no** speculative renderer optimizations, **no** geometry redesign, **no** E2+ default promotion, and **no** legacy path removal.

## Objectives

1. **Progressive Real-World Hengelo Dataset Series (`S1`–`S5`)**:
   - Constructed deterministically from real Geofabrik Overijssel OSM PBF data (`overijssel-261114.osm.pbf`, centered at `[6.7935, 52.2625]`):
     - `S1` (`hengelo-s1-250m`): `250 × 250 m` (`0.0625 km²`, `957` features)
     - `S2` (`hengelo-s2-500m`): `500 × 500 m` (`0.25 km²`, `2,757` features)
     - `S3` (`hengelo-s3-1km`): `1 × 1 km` (`1.0 km²`, `9,738` features)
     - `S4` (`hengelo-s4-2km`): `2 × 2 km` (`4.0 km²`, `36,669` features)
     - `S5` (`hengelo-s5-4km`): `4 × 4 km` (`16.0 km²`, `96,836` features, executed only if earlier stages pass within resource limits)
   - Preserves original OSM element identities, multi-category features, multipolygon relation closure, per-vertex `_nodeIds`, bounding boxes, ODbL attribution, OSM base timestamp, and SHA-256 hashes in `benchmarks/datasets/hengelo-scaling/manifest.json`.
   - Zero live Overpass queries during benchmark execution.
2. **Extended CPU Scalability Infrastructure (`benchmarks/scaling*.ts`)**:
   - Extended `benchmarks/` with `scalingDatasets.ts`, `scalingWorker.ts`, `scalingRunner.ts`, and `scalingReport.ts`.
   - Measured parse/classification, graph build, graph-to-renderer adapter, planar surface resolution, road generation + sub-stages (`legacy` + `graph` + `graph-surface`), railway generation + sub-stages (`Ballast`, `Sleepers`, `Rails`, `BridgesAndTunnels`, `SpatialChunking`), full scene build, disposal time & leak audit, peak RSS, V8 heap, deterministic `cpuBufferMemory`, polygon Boolean operation counts, candidate blocker checks, and skipped/unsupported geometry (`null` + explicit reason, never invented `0`).
3. **Data Completeness, Topology & Geometry Correctness Metrics**:
   - Tracked raw OSM elements vs. parsed GeoJSON features, parsed vs. rendered counts across all categories, legitimate boundary clipping/filtering, unsupported OSM tags, deduplication/chaining lineage, `featuresFullySubtracted`, clipping failures, fallbacks, provenance completeness (`faceRanges` / `instanceInfos`), unresolved switches/crossings/grade transitions, planar layer validation, and complexity-guarded road coverage/overlap checks.
4. **Resource-Safe Execution for 16 GB Windows Systems**:
   - Never invoked full `npm test` (`TKT-018`).
   - Executed every `(dataset, config)` workload in an isolated sequential child Node worker (`concurrency = 1`, explicit `--max-old-space-size`, configurable RSS limit & wall-clock timeout, active OS/IPC RSS polling, clean Windows `taskkill` / POSIX signal teardown).
5. **Root-Cause Investigation & Follow-Up Optimization Specification (`TKT-020`)**:
   - Preserved the project owner's verified Windows S1–S5 benchmark artifact (`benchmarks/results/tkt019-hengelo-scaling.json`, noting its `gitDirty: true` reproducibility limitation).
   - Identified exact superlinear bottlenecks in `resolveAndValidatePlanarPolygons` and `GraphRoadGeometryBuilder.ts`, classified all `S2` (`3`), `S3` (`13`), and `S4` (`46`) planar validation violations, audited benchmark measurement reliability, and proposed `TKT-020` for targeted optimization.

## Acceptance Criteria
- [x] Deterministic offline Hengelo `S1`–`S5` real OSM dataset extraction tool (`benchmarks/prepareHengeloScalingDatasets.ts`) and committed `S1`–`S5` datasets with `manifest.json` (bboxes, ODbL attribution, OSM timestamp, SHA-256 hashes).
- [x] Read-only instrumentation on `GeometryBuilder.ts` exposing `legacyRoadStats`, `legacyRoadTimingMs`, and `planarValidationReport` without altering any rendered geometry.
- [x] Resource-bounded scaling runner (`benchmarks/scalingRunner.ts`, `benchmarks/scalingWorker.ts`, `benchmarks/scalingDatasets.ts`, `benchmarks/scalingReport.ts`) with isolated child processes, Windows/POSIX RSS & timeout enforcement, progression cutoff, and Windows PowerShell CLI compatibility.
- [x] Reproducible Hengelo `S1`–`S5` scaling JSON (`benchmarks/results/tkt019-hengelo-scaling.json`) + Markdown analysis report (`docs/tkt019-hengelo-scaling-report.md`) incorporating the project owner's Windows S1–S5 hardware/host measurements and root-cause analysis.
- [x] Focused automated regression tests (`src/world/RegionalScalabilityBenchmark.test.ts`), updated docs (`docs/benchmarking-and-profiling.md`, `docs/STATUS.md`), clean `tsc --noEmit`, `vite build`, and `npm run docs:api`.
- [x] Narrowly scoped follow-up optimization ticket (`tickets/TKT-020-planar-surface-and-road-blocker-scaling-optimization.md`) filed with baseline comparisons, geometry-equivalence requirements, and regression test contracts.

## Key Verified Findings (`benchmarks/results/tkt019-hengelo-scaling.json` & `docs/tkt019-hengelo-scaling-report.md`)

1. **Owner Windows Scaling Progression (`Intel Core i7-14650HX`, 16 GB RAM, `commit dc422d200874`, `gitDirty: true`)**:
   - **`production-legacy`**: Completed **`S1` (`86.4 ms`)**, **`S2` (`458.1 ms`)**, **`S3` (`3,131.7 ms`, `650.4 MB` peak RSS)**, and **`S4` (`14,448.1 ms` median scene build, `11,020.2 ms` planar resolution, `1,106.1 MB` / `1.11 GB` peak RSS, `39.74 MB` `cpuBufferMemory`, `272` meshes, `606,126` base / `1,366,736` instanced triangles)**. Halted at **`S5` (`4 × 4 km`)** due to `120 s` wall-clock timeout during `iter_1_scene_build`.
   - **`graph-e2-e3`**: Completed **`S1` (`110.3 ms`)**, **`S2` (`1,320.8 ms`)**, and **`S3` (`3,324.2 ms`, `710.5 MB` peak RSS)**. Timed out at **`S4`** (`120 s`) during `iter_3_planar` (`96.5 s` last heartbeat).
   - **`surface-first-e2plus-rplus`**: Completed **`S1` (`149.3 ms`)**, **`S2` (`1,543.1 ms`)**, and **`S3` (`8,383.6 ms`, `726.1 MB` peak RSS)**. Timed out at **`S4`** (`120 s`) during `iter_3_planar` (`98.3 s` last heartbeat).
   - **Zero Resource Leaks**: All `10` completed workloads across `S1`–`S4` passed `SceneResourceManager` disposal verification with **`0` leaked geometries and `0` leaked materials**, and **`0` unattributed mesh faces or NaN vertices**.
2. **Root Cause of `resolveAndValidatePlanarPolygons` Superlinear Scaling (`11.02 s` / `76.3%` of `S4` Legacy Build)**:
   - Actual Stage 3 Boolean subtraction (`polygonClipping.union` + `polygonClipping.difference`) takes only **`1.4%`** of `S4` planar resolution time (`~325 ms`).
   - **`85.6%`** of `S4` planar time is spent in **Stage 4 post-resolution validation** (`PlanarLayerValidator.ts` line `1394`: `5,751` calls to `polygonClipping.intersection(a.resolvedMultiPolygon, b.resolvedMultiPolygon)`), because carved macro-landuse polygons (such as `way/1156887567-0` with **`294` interior holes and `4,060` vertices**, and `way/1279729432-0` with **`111` holes and `2,005` vertices**) retain their full district-wide outer AABB and are repeatedly intersected against every small feature carved out of their interior.
   - Another **`12.7%`** is spent in Stage 2 (`5,944` `intersection` calls + `3,370` unconditional `isGeometricallyContained` `difference` calls + `0.25 m` boundary step sampling), which fails to pre-check `a.area - interArea <= 0.15` or `computeBBoxContainmentRatio`.
3. **Root Cause of Surface-First Road Candidate Blocker Search (`2,254,714` Checks at `S3`, `14,418,060` at `S4`)**:
   - `GraphRoadGeometryBuilder.ts` (`lines 3285–3295`) linearly filters `placedRoadFootprints` for every subsegment (`0.289%` hit rate at `S3` with `6,523` overlaps; `0.110%` hit rate at `S4` with `15,888` overlaps) and allocates `5` temporary arrays per stroke via `stroke.flatMap(...).map(...)` + `Math.min(...)`.
   - Indexing `placedRoadFootprints` in a deterministic 2D spatial grid (`32 m` cells) while preserving insertion order eliminates `>98%` of non-overlapping checks (`~142 ms` saved at `S3`, `~589 ms` saved at `S4` in container profiling) with **100% bit-identical** blocker lists, geometry, and OSM provenance.
4. **Classification of Planar Validation Violations (`3` at `S2`, `13` at `S3`, `46` at `S4`)**:
   - **Zero** Stage 3 `polygonClipping.difference` exceptions occurred (`stage3CatchCount = 0`).
   - **Category A (`3/3` at `S2`, `11/13` at `S3`, `41/46` at `S4`)**: Post-difference ring conditioning (`filterDegenerateBooleanArtifacts` / `conditionRing` `0.1 mm` grid snapping and `< 1 mm` / `< 1e-4` collinear vertex removal at `line 1335`) shifts long carved hole edges by `0.05–0.15 mm` after `polygonClipping.difference` (whose raw output had `0.000000 m²` overlap!), creating $1\text{–}20\text{ cm}^2$ (`0.000100–0.002057 m²`) boundary-sliver overlaps above Stage 4's `0.0001 m²` threshold.
   - **Category B (`0/3` at `S2`, `2/13` at `S3`, `5/46` at `S4`)**: Threshold mismatch between Stage 2 (`MIN_OVERLAP_AREA_SQ_METERS = 0.01 m²` at `line 1176`) and Stage 4 (`MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA = 0.0001 m²` at `line 1408`). Adjacent `grass` (`y=0.025m`) and `water` (`y=0.015m`) polygons whose raw overlap is `0.000100–0.000396 m²` are skipped by Stage 2 (`<= 0.01 m²`) and then flagged as violations by Stage 4 (`> 0.0001 m²`).
5. **Benchmark Measurement Reliability Findings**:
   - `scalingWorker.ts` runs `resolveAndValidatePlanarPolygons` and `buildRailwayInfrastructure` standalone **and** a second time inside `GeometryBuilder.buildScene()` on every measured iteration (doubling planar execution count to `7` calls per workload and causing `S4` `graph-e2-e3` and `surface-first-e2plus-rplus` to hit the `120 s` timeout during `iter_3_planar` after completing 2 full measured iterations).
   - `roadSubStagesMs` double-counts `polygonUnionMs` inside `footprintConstructionMs` (`GraphRoadGeometryBuilder.ts` line `3931`) for `graph-surface` and reports `0.0 ms` for `graph`.
   - `--expose-gc` was not forwarded through `tsx` CLI wrapper to the inner child process (`gcExposed: false`, `gcInvokedBeforeRun: false`).
   - Completed iteration samples (`iter_1`, `iter_2`) are lost when `iter_3` times out because IPC results are only sent after all iterations complete.

## Verification
- Status: **Closed — Verified (`26/26` Focused Benchmark Tests + Owner Windows S1–S5 Run + Root-Cause Diagnostics)**
- Automated tests & build checks executed in development environment:
  - `npx tsx --test --test-concurrency=1 src/world/BenchmarkInfrastructure.test.ts src/world/BenchmarkReliability.test.ts src/world/RegionalScalabilityBenchmark.test.ts`: exit `0` — **`26 / 26` passed** (`0` failures)
  - `npm run lint` (`tsc --noEmit`): exit `0` (`0` errors)
  - `npm run build` (`vite build`): exit `0` (`dist/` generated cleanly)
  - `npm run docs:api`: exit `0`

## Related Files and Documentation
- Extraction & Infrastructure: `benchmarks/prepareHengeloScalingDatasets.ts`, `benchmarks/scalingDatasets.ts`, `benchmarks/scalingWorker.ts`, `benchmarks/scalingRunner.ts`, `benchmarks/scalingReport.ts`, `benchmarks/types.ts`, `benchmarks/datasets/hengelo-scaling/manifest.json`
- Benchmark Artifact & Analysis Report: `benchmarks/results/tkt019-hengelo-scaling.json`, `docs/tkt019-hengelo-scaling-report.md`
- Follow-Up Optimization Ticket: `tickets/TKT-020-planar-surface-and-road-blocker-scaling-optimization.md`
- Source Instrumentation: `src/world/GeometryBuilder.ts`
- Tests: `src/world/RegionalScalabilityBenchmark.test.ts`
