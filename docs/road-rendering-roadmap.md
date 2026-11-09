# Road Rendering Validation & Migration Roadmap

## 1. Current State & Renderer Modes

The 3D OpenStreetMap viewer currently supports three runtime road rendering engines selectable via `InfrastructureRenderOptions.roads` (`?topologyRoads=...` or **Dev Tools → Rendering → Road Infrastructure Engine**):

| Mode | Selector | Status | Description |
| :--- | :--- | :--- | :--- |
| **Legacy** | `'legacy'` | **Current Production Default** | Pre-M2.3-E2 polyline ribbon & `TopologicalNodeIndex` junction synthesizer (`ADR-0002`). |
| **Graph (E2)** | `'graph'` | **Implemented (`TKT-008`)** | Graph-driven ribbon & boundary-derived portal-chord junction solver (`solveBoundaryDerivedJunctionNode`). |
| **Graph Surface (E2+)** | `'graph-surface'` | **Preferred Direction (`ADR-0010`)** | Surface-first rounded 2D stroke union + priority-ordered Boolean ownership clipping (`SurfaceFirstRoadFootprints.ts`). |

*(Note: `'graph-preview'` remains available as the Stage E1 diagnostic mode that builds and validates `InfrastructureRenderDescriptorBundle` while delegating mesh synthesis to `'legacy'`.)*

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
   - Stage-separated wall-clock timings (`GraphRoadGenerationTiming` on `roadsGroup.userData.graphRoadTiming`) and deterministic geometry/Boolean counters (`GraphRoadRenderStats` on `roadsGroup.userData.graphRoadStats`), surfaced in `DevToolsPanel.tsx`, `window.__M21_LAB__.getSnapshot()`, and `research/surface-first-road-rendering/baseline-results.json`.

---

## 3. Phase 2: Targeted Geometry Defect Resolution (In Progress Before Default Promotion)

Automated validation in Phase 1 identified three concrete issues in E2+, both geometry defects of which are now resolved while one diagnostic counter item remains open before promoting `roads: 'graph-surface'` to the default renderer:

1. **Internal Provenance-Split Bend Disk Placement (`provenance_split_bend_gap`) — Resolved**:
   - **Root Cause**: When a simplified graph edge consisted of multiple chained OSM ways (`edge.provenance.segments.length > 1`), `capStart` was only enabled on `subSegments[0]` and `capEnd` was only enabled on `subSegments[subSegments.length - 1]`, leaving an unrounded wedge gap on the outside of bends occurring at an internal provenance split.
   - **Implemented Fix**: `resolveInternalProvenanceBoundaryCaps` (`SurfaceFirstRoadFootprints.ts`) inspects adjacent provenance subsegments (`#seg0 -> #seg1` and multi-segment closed-loop seams). Straight equal-width boundaries (`dot >= 0.9986` and `|wA - wB| <= 1e-3 m`) emit no additional disk, whereas angled bends (`dot < 0.9986`) or width transitions (`|wA - wB| > 1e-3 m`) deterministically assign a single 16-sided rounding disk to one adjacent provenance subsegment (wider subsegment first, longer millimeter-rounded cleaned arc length second, lexical `partId`/`sourceFeatureId` tie-breaker third). Verified with `0` `provenance_split_bend_gap` defects across `H06`, `A02`, `A01`, `A05`, and `H01`.
2. **Diagnostic Counter Synchronization on Full Subtraction — Open**:
   - **Root Cause**: In `GraphRoadGeometryBuilder.ts` (lines 3276–3282), when an E2+ stroke is completely covered by higher-priority road surfaces (`visible.length === 0`), `stats.fullySubtractedCount` and `fullySubtractedRoadIds` are updated, but `diagnostics.featuresFullySubtracted` is not incremented (unlike E2 at line 3551).
   - **Planned Fix**: Reconcile source-level versus provenance-segment accounting and only count a source as fully subtracted **once all of its parts are occluded**; avoid inflating the count for partially visible sources.

---

## 4. Phase 3: Promotion Criteria for Production Default

`roads: 'graph-surface'` (E2+) will be promoted to the default road renderer (`DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS.roads = 'graph-surface'`) once:
1. All three documented issues (provenance split bends, full-subtraction counter, H01 pinched-ring overlap) are resolved or explicitly dispositioned with regression evidence.
2. Automated validation confirms `0` positive-area coplanar overlaps (`> 1e-3 m²`), `0` winding/normal/degenerate triangle defects, and `100%` provenance attribution across the regression suite.
3. Project owner signs off on the Phase 2 fix and authorizes default promotion and Stage E5 legacy cleanup.


## 5. Third Defect — H01 Pinched-Ring Coplanar Overlap (Resolved)

- **Root Cause**: In `H01` (Utrecht Vredenburg), `road_edge:way/1576579935-0:seg_0:p_0#seg1` (`footway`, width `2.2 m`) was subtracted against higher-priority Nobelstraat cycleways (`way/1375802578`, `way/7010264`), adjacent footways (`way/1374152347`, `way/1576579934`), and its sibling provenance segment `#seg0` (`way/1576579935`). Because `#seg0`'s and `way/1576579934`'s cut vertices had been snapped to the `0.1 mm` (`1e-4 m`) grid by `conditionRing`, their cut boundaries diverged from adjacent blockers by `6.35 µm` and `23 µm`, forming two dead-end needle cracks (`0.224 m` and `0.073 m` long). When `polygonClipping.difference` subtracted those blockers from `#seg1`, its raw contour traced into both cracks without crossing itself, and `conditionRing` then snapped the `6.35 µm` crack's tip by `~35 µm` across the entry edge while failing to strip the `180°` fold-back spike (`cross = hPerp / len > 1e-4` after grid snapping). `THREE.ShapeGeometry` (`earcut`) triangulated the resulting self-crossing contour into overlapping triangles (`0.0295 m²` intra-feature + `0.0017 m²` multi-provenance overlap = `0.0312 m²`).
- **Implemented Fix**: `conditionRing` in `src/world/PlanarLayerValidator.ts` now iteratively deduplicates consecutive vertices (`< 1 mm`) and strips `180°` sub-millimeter fold-back needle spikes (`dot < -0.999` with perpendicular excursion `hPerp <= 0.5 mm`), preserving legitimate narrow wedges while eliminating sub-millimeter grid-snap fold-backs. Verified with `0` positive-area coplanar overlaps (`0.0000 m²`) in `H01` and across all 12 benchmark datasets.

## 6. Required Scaling Evidence — Hengelo and Twente

The existing samples are small (the synthetic stress case has 197 road ways); they **do not** validate whole-city costs. Before production promotion, benchmark representative complete Hengelo data and increasingly large Twente tiles. Record **full scene** and **road-only** times separately, CPU/memory, unions/differences, candidate blocker checks, triangle counts, skipped segments, provenance coverage and tile boundary seams.

Consider spatial indexing, workers, chunking and **baked/queryable geometry** only when the measured workload justifies them. A working renderer should not be refactored merely to optimize theoretical costs. Preserve E2 and Legacy until owner visual sign-off and adequate metrics. Railway ballast experiments, although potentially compatible with surface-first ideas, are separate from this road milestone.

