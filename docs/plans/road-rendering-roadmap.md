# Road Rendering Validation & Migration Roadmap

## 1. Current State & Renderer Mode (`TKT-026` — Closed 2026-11-19)

As of `TKT-026` (closed `2026-11-19` following project-owner visual approval), **E2+ Surface-First Road Rendering (`roads: 'graph-surface'`)** and **R+ Surface-First Ballast Railway Rendering (`railways: 'graph-R+'`, `railwaySwitchPolicy: 'graph'`, `railwayBallastStrategy: 'surface-first'`)** have been promoted as the sole production infrastructure rendering architecture (`DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS`). The obsolete `'legacy'`, `'graph-preview'`, and intermediate `'graph'` (E2) road rendering branches have been retired.

| Mode | Selector | Status | Description |
| :--- | :--- | :--- | :--- |
| **Graph Surface (E2+)** | `'graph-surface'` | **Permanent Production Architecture (`ADR-0010`, `TKT-026`)** | Surface-first rounded 2D stroke union + spatially indexed priority-ordered Boolean ownership clipping (`SurfaceFirstRoadFootprints.ts`, `GraphRoadGeometryBuilder.ts`). |
| **Legacy / Graph (E2)** | *(Retired in `TKT-026`)* | **Retired** | Pre-M2.3-E2 polyline ribbon & E2 portal-chord junction solvers removed after E2+ promotion. |

---

## 2. Phase 1: Automated Geometry Integrity & Performance Baseline (Complete)

Implemented in this milestone without altering E2+'s geometry generation algorithm:
1. **Non-Circular Surface Coverage Validation (`SurfaceFirstRoadValidator.ts` — Task A1)**:
   - Evaluates emitted at-grade road triangles against an independent 24-gon analytical centerline buffer reference (`buildIndependentAnalyticalRoadCorridor`).
   - Distinguishes genuine missing-surface defects (`completely_omitted_road_feature`, `missing_road_surface_area`, `unintended_footprint_hole`, `disconnected_segment_gap`, `provenance_split_bend_gap`) from legitimate higher-priority road occlusion (`occludedByHigherPriorityAreaM2`, `fullySubtractedRoadIds`), grade-separated bridges/tunnels, and boundary-clipped endpoints.
2. **Coplanar Overlap Validation (Task A2)**:
   - Reuses `ZFightingValidator.validateRoadNetworkGeometry(scene)` with a documented `1e-3 m²` (`10 cm²`) positive-area tolerance and categorizes conflicts by pair type (`cross_class_vehicular`, `same_class_road`, `path_or_cycleway`, `multi_provenance_segment`, `intra_feature_self_overlap`).
3. **Mesh Integrity & Elevation Verification (Task A3)**:
   - Reuses `auditGraphRoadMeshIntegrity(scene.roadsGroup)` (upward `+Y` winding, normal agreement, finite coordinates, zero degenerate triangles `<= 1e-6 m²`) and adds physical elevation checks (`0.050 m ± 1e-4 m`, `+0.056 m` for step treads) and tiny disconnected polygon detection (`< 1e-3 m²`).
4. **Source-Feature Provenance Verification (Task A4)**:
   - Audits `faceRanges`, `sourceFeatureId`, `sourceFeatureIds`, `RoadClass` subtype, preserved `osmTags`, spatial bounding envelope containment across provenance splits (`#seg0`, `#seg1`), deduplication lineage, and `fullySubtractedRoadIds`.
5. **Lightweight Performance Instrumentation (Tasks B1–B3)**:
   - Stage-separated wall-clock timings (`GraphRoadGenerationTiming` on `roadsGroup.userData.graphRoadTiming`) and deterministic geometry/Boolean counters (`GraphRoadRenderStats` on `roadsGroup.userData.graphRoadStats`), surfaced in `DevToolsPanel.tsx`, `window.__M21_LAB__.getSnapshot()`, and `docs/research/surface-first-road-rendering/baseline-results.json`.

---

## 3. Phase 2: Targeted Geometry Defect Resolution (In Progress Before Default Promotion)

Automated validation in Phase 1 identified three concrete issues in E2+, whose two geometry defects and E2+ diagnostic counter mismatch are now addressed in the code, with broader real-world and performance validation still required before promoting `roads: 'graph-surface'` to the default renderer:

1. **Internal Provenance-Split Bend Disk Placement (`provenance_split_bend_gap`) — Resolved**:
   - **Root Cause**: When a simplified graph edge consisted of multiple chained OSM ways (`edge.provenance.segments.length > 1`), `capStart` was only enabled on `subSegments[0]` and `capEnd` was only enabled on `subSegments[subSegments.length - 1]`, leaving an unrounded wedge gap on the outside of bends occurring at an internal provenance split.
   - **Implemented Fix**: `resolveInternalProvenanceBoundaryCaps` (`SurfaceFirstRoadFootprints.ts`) inspects adjacent provenance subsegments (`#seg0 -> #seg1` and multi-segment closed-loop seams). Straight equal-width boundaries (`dot >= 0.9986` and `|wA - wB| <= 1e-3 m`) emit no additional disk, whereas angled bends (`dot < 0.9986`) or width transitions (`|wA - wB| > 1e-3 m`) deterministically assign a single 16-sided rounding disk to one adjacent provenance subsegment (wider subsegment first, longer millimeter-rounded cleaned arc length second, lexical `partId`/`sourceFeatureId` tie-breaker third). Verified with `0` `provenance_split_bend_gap` defects across `H06`, `A02`, `A01`, `A05`, and `H01`.
2. **Diagnostic Counter Synchronization on Full Subtraction — Resolved (Source-Level Accounting)**:
   - **Original Defect**: The E2+ `visible.length === 0` path updated the per-segment `fullySubtractedCount` and mixed `fullySubtractedRoadIds` but never synchronized source-level `diagnostics.featuresFullySubtracted`.
   - **Implemented Fix**: Record source IDs from fully occluded provenance segments, then after all E2+ roads are processed exclude any IDs with visible geometry, deduplicate, sort deterministically and add the remaining unique OSM source IDs to `diagnostics.featuresFullySubtracted` (at most ten sample IDs). `stats.fullySubtractedCount` remains the number of occluded segments. The change does not modify emitted geometry, and E2/Legacy accounting remains unchanged. Covered by the existing full-occlusion fixture and a multi-part/partially-visible source regression test.

---

## 4. Phase 3: Promotion to Production Default (`TKT-026` — Closed 2026-11-19)

`roads: 'graph-surface'` (E2+) and `railways: 'graph-R+'` (`railwaySwitchPolicy: 'graph'`, `railwayBallastStrategy: 'surface-first'`, R+) have been promoted to the sole production defaults (`DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS`) and formally approved visually by the project owner on `2026-11-19` (`10,000 m` camera-distance check verifying visibility of loaded map and boundaries, close/distant visual consistency, good performance, and zero regressions), following:
1. Resolution of all three Phase 2 issues (provenance split bends, full-subtraction counter synchronization, and H01 pinched-ring overlap).
2. Spatial indexing (`32 m` `RoadFootprintSpatialGrid`, `TKT-020`) and `4 × 4 km` pre-migration benchmark runs (`TKT-026`, Run A & Run B preserved separately with provenance notes because raw `.json` files were not saved in `benchmarks/results/`): in the `1280×800` SwiftShader run (`Run A`) vs. the `TKT-025` legacy baseline, frozen Hengelo S5 road generation dropped **`92.3%`** (`38,826.9 ms` $\to$ `2,994.7 ms`) and live Overijssel `r = 2000 m` road generation dropped **`90.3%`** (`79,209.9 ms` $\to$ `7,667.1 ms`); in a separate paired `1280×720` WebGL run (`Run B`, `57–68 FPS`, warm live cache), S5 road generation dropped **`69.8%`** (`38,832.8 ms` $\to$ `11,735.5 ms`) and live `r = 2000 m` dropped **`82.0%`** (`79,233.5 ms` $\to$ `14,232.2 ms`).
3. Retirement of obsolete Legacy and intermediate E2 road/railway rendering paths (`TKT-026`) and local Windows verification on commit `6436b7e` (`RailwayRendering` `9/9`, `InfrastructureRenderAdapter` `20/20`, `npm run lint`, `npm run build`).


## 5. Third Defect — H01 Pinched-Ring Coplanar Overlap (Resolved)

- **Root Cause**: In `H01` (Utrecht Vredenburg), `road_edge:way/1576579935-0:seg_0:p_0#seg1` (`footway`, width `2.2 m`) was subtracted against higher-priority Nobelstraat cycleways (`way/1375802578`, `way/7010264`), adjacent footways (`way/1374152347`, `way/1576579934`), and its sibling provenance segment `#seg0` (`way/1576579935`). Because `#seg0`'s and `way/1576579934`'s cut vertices had been snapped to the `0.1 mm` (`1e-4 m`) grid by `conditionRing`, their cut boundaries diverged from adjacent blockers by `6.35 µm` and `23 µm`, forming two dead-end needle cracks (`0.224 m` and `0.073 m` long). When `polygonClipping.difference` subtracted those blockers from `#seg1`, its raw contour traced into both cracks without crossing itself, and `conditionRing` then snapped the `6.35 µm` crack's tip by `~35 µm` across the entry edge while failing to strip the `180°` fold-back spike (`cross = hPerp / len > 1e-4` after grid snapping). `THREE.ShapeGeometry` (`earcut`) triangulated the resulting self-crossing contour into overlapping triangles (`0.0295 m²` intra-feature + `0.0017 m²` multi-provenance overlap = `0.0312 m²`).
- **Implemented Fix**: `conditionRing` in `src/world/PlanarLayerValidator.ts` now iteratively deduplicates consecutive vertices (`< 1 mm`) and strips `180°` sub-millimeter fold-back needle spikes (`dot < -0.999` with perpendicular excursion `hPerp <= 0.5 mm`), preserving legitimate narrow wedges while eliminating sub-millimeter grid-snap fold-backs. Verified with `0` positive-area coplanar overlaps (`0.0000 m²`) in `H01` and across all 12 benchmark datasets.

## 6. Required Scaling Evidence — Hengelo and Twente

The existing samples are small (the synthetic stress case has 197 road ways); they **do not** validate whole-city costs. Before production promotion, benchmark representative complete Hengelo data and increasingly large Twente tiles. Record **full scene** and **road-only** times separately, CPU/memory, unions/differences, candidate blocker checks, triangle counts, skipped segments, provenance coverage and tile boundary seams.

Consider spatial indexing, workers, chunking and **baked/queryable geometry** only when the measured workload justifies them. A working renderer should not be refactored merely to optimize theoretical costs. Preserve E2 and Legacy until owner visual sign-off and adequate metrics. Railway ballast experiments, although potentially compatible with surface-first ideas, are separate from this road milestone.

