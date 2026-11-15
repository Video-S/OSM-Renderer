---
id: TKT-019
title: Regional Rendering Scalability Assessment (Hengelo S1–S5 to Twente)
type: tech_debt
status: in_progress
priority: high
created: 2026-11-15
updated: 2026-11-15
---

# TKT-019: Regional Rendering Scalability Assessment (Hengelo S1–S5 to Twente)

## Summary
Empirically measure CPU pipeline performance, memory footprint, resource cleanup, data completeness, topology resolution, and geometry correctness across a deterministic progression of real-world OpenStreetMap extracts around **Hengelo** (`S1` `250 × 250 m` through `S5` `4 × 4 km`, toward eventual **Twente** regional targets) under all three renderer configurations (`production-legacy`, `graph-e2-e3`, `surface-first-e2plus-rplus`).

**Scope Constraint**: Measurement, instrumentation, and architectural assessment only — **no** speculative renderer optimizations, **no** geometry redesign, **no** E2+ default promotion, and **no** legacy path removal.

## Objectives

1. **Progressive Real-World Hengelo Dataset Series (`S1`–`S5`)**:
   - Constructed deterministically from real Geofabrik Overijssel OSM PBF data (`overijssel-261114.osm.pbf`, centered at `[6.7935, 52.2625]`):
     - `S1` (`hengelo-s1-250m`): `250 × 250 m` (`0.0625 km²`)
     - `S2` (`hengelo-s2-500m`): `500 × 500 m` (`0.25 km²`)
     - `S3` (`hengelo-s3-1km`): `1 × 1 km` (`1.0 km²`)
     - `S4` (`hengelo-s4-2km`): `2 × 2 km` (`4.0 km²`)
     - `S5` (`hengelo-s5-4km`): `4 × 4 km` (`16.0 km²`, executed only if earlier stages pass within resource limits)
   - Preserves original OSM element identities, multi-category features, multipolygon relation closure, per-vertex `_nodeIds`, bounding boxes, ODbL attribution, OSM base timestamp, and SHA-256 hashes in `benchmarks/datasets/hengelo-scaling/manifest.json`.
   - Zero live Overpass queries during benchmark execution.
2. **Extended CPU Scalability Infrastructure (`benchmarks/scaling*.ts`)**:
   - Extend `benchmarks/` rather than introducing an independent benchmarking framework.
   - Measure parse/classification, graph build, graph-to-renderer adapter, planar surface resolution, road generation + sub-stages (`legacy` + `graph` + `graph-surface`), railway generation + sub-stages (`Ballast`, `Sleepers`, `Rails`, `BridgesAndTunnels`, `SpatialChunking`), full scene build, disposal time & leak audit, peak RSS, V8 heap, deterministic `cpuBufferMemory`, polygon Boolean operation counts, candidate blocker checks, and skipped/unsupported geometry (`null` + explicit reason, never invented `0`).
3. **Data Completeness, Topology & Geometry Correctness Metrics**:
   - Track raw OSM elements vs. parsed GeoJSON features, parsed vs. rendered counts across all categories, legitimate boundary clipping/filtering, unsupported OSM tags, deduplication/chaining lineage, `featuresFullySubtracted`, clipping failures, fallbacks, provenance completeness (`faceRanges` / `instanceInfos`), unresolved switches/crossings/grade transitions, planar layer validation, and complexity-guarded road coverage/overlap checks.
4. **Resource-Safe Execution for 16 GB Windows Systems**:
   - Never invoke full `npm test` (`TKT-018`).
   - Run every `(dataset, config)` workload in an isolated sequential child Node worker (`concurrency = 1`, explicit `--max-old-space-size`, configurable RSS limit & wall-clock timeout, active OS/IPC RSS polling, clean Windows `taskkill` / POSIX signal teardown).
   - Record timeouts, memory-limit aborts, crashes, and skipped stages clearly; halt larger-scale progression for a config once resource limits are exceeded; never auto-attempt whole Twente.
5. **Reproducible JSON & Markdown Scaling Report**:
   - Generate machine-readable JSON results and a concise, evidence-backed Markdown scaling analysis identifying bottleneck stages, comparing `production-legacy` vs. `graph-e2-e3` vs. `surface-first-e2plus-rplus`, evaluating regional architecture paths (offline prebaked geometry, spatial tiling/chunks, on-demand loading, multi-LOD, web workers, spatial indexing), and recommending the next milestone and first measured bottleneck.

## Acceptance Criteria
- [x] Deterministic offline Hengelo `S1`–`S5` real OSM dataset extraction tool (`benchmarks/prepareHengeloScalingDatasets.ts`) and committed `S1`–`S5` datasets with `manifest.json` (bboxes, ODbL attribution, OSM timestamp, SHA-256 hashes).
- [ ] Read-only instrumentation on `GeometryBuilder.ts` exposing `legacyRoadStats`, `legacyRoadTimingMs`, and `planarValidationReport` without altering any rendered geometry.
- [ ] Resource-bounded scaling runner (`benchmarks/scalingRunner.ts`, `benchmarks/scalingWorker.ts`, `benchmarks/scalingDatasets.ts`, `benchmarks/scalingReport.ts`) with isolated child processes, Windows/POSIX RSS & timeout enforcement, progression cutoff, and Windows PowerShell CLI compatibility.
- [ ] Reproducible Hengelo `S1`–`S5` scaling JSON + Markdown analysis report generated from real benchmark runs in this environment.
- [ ] Focused automated regression tests (`src/world/RegionalScalabilityBenchmark.test.ts`), updated docs (`docs/benchmarking-and-profiling.md`, `docs/STATUS.md`), clean `tsc --noEmit`, `vite build`, and `npm run docs:api`.

## Implementation Notes
- Overpass API mirrors timed out or were geo-restricted in the build container; Geofabrik's regional Overijssel OSM PBF (`overijssel-261114.osm.pbf`, SHA-256 recorded in `manifest.json`) provided complete, authentic OSM data without synthetic duplication.
- Quadratic $O(N^2)$ overlap/coverage validators (`validateRoadNetworkGeometry`, `validateSurfaceFirstRoadGeometry`) are strictly gated via `--validator-max-edges` (default `250`) and record explicit execution status (`'executed' | 'skipped_due_to_complexity_guard' | 'failed'`) so large urban scales do not hang inside post-hoc validation while linear $O(T)$ provenance/mesh/planar/topology checks run unconditionally at all scales.

## Verification
- Status: In progress — pending runner implementation, bounded benchmark execution, and verification.

## Related Files and Documentation
- Extraction & Infrastructure: `benchmarks/prepareHengeloScalingDatasets.ts`, `benchmarks/scalingDatasets.ts`, `benchmarks/scalingWorker.ts`, `benchmarks/scalingRunner.ts`, `benchmarks/scalingReport.ts`, `benchmarks/types.ts`, `benchmarks/datasets/hengelo-scaling/manifest.json`
- Source Instrumentation: `src/world/GeometryBuilder.ts`
- Tests: `src/world/RegionalScalabilityBenchmark.test.ts`
- Documentation & Reports: `docs/benchmarking-and-profiling.md`, `docs/STATUS.md`, `docs/tkt019-hengelo-scaling-report.md`
