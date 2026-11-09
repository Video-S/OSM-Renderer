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

## 3. Phase 2: Targeted Geometry Defect Resolution (Next Step Before Default Promotion)

Automated validation in Phase 1 identified three concrete defects in the current E2+ implementation that should be resolved in a dedicated follow-up ticket before promoting `roads: 'graph-surface'` to the default renderer:

1. **Internal Provenance-Split Bend Disk Placement (`provenance_split_bend_gap`)**:
   - **Root Cause**: In `GraphRoadGeometryBuilder.ts` (lines 3080–3083), when a simplified graph edge consists of multiple chained OSM ways (`edge.provenance.segments.length > 1`), `capStart` is only enabled on `subSegments[0]` and `capEnd` is only enabled on `subSegments[subSegments.length - 1]`. Internal boundary vertices between `#seg0` and `#seg1` receive neither a start cap nor an end cap, leaving an unrounded wedge gap on the outside of bends that occur at an internal provenance split.
   - **Planned Fix**: Enable a round disk cap (`radius = w/2`) at internal provenance-split vertices whenever the meeting angle between consecutive provenance segments is non-collinear (or unconditionally at internal provenance joints, since overlapping same-edge provenance strokes are subsequently clipped against each other in priority/lexical order).
2. **Diagnostic Counter Synchronization on Full Subtraction**:
   - **Root Cause**: In `GraphRoadGeometryBuilder.ts` (lines 3121–3127), when an E2+ stroke is completely covered by higher-priority road surfaces (`visible.length === 0`), `stats.fullySubtractedCount` and `fullySubtractedRoadIds` are updated, but `diagnostics.featuresFullySubtracted` is not incremented (unlike E2 at line 3383).
   - **Planned Fix**: Reconcile source-level versus provenance-segment accounting and only count a source as fully subtracted **once all of its parts are occluded**; avoid inflating the count for partially visible sources.

---

## 4. Phase 3: Promotion Criteria for Production Default

`roads: 'graph-surface'` (E2+) will be promoted to the default road renderer (`DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS.roads = 'graph-surface'`) once:
1. All three documented issues (provenance split bends, full-subtraction counter, H01 pinched-ring overlap) are resolved or explicitly dispositioned with regression evidence.
2. Automated validation confirms `0` positive-area coplanar overlaps (`> 1e-3 m²`), `0` winding/normal/degenerate triangle defects, and `100%` provenance attribution across the regression suite.
3. Project owner signs off on the Phase 2 fix and authorizes default promotion and Stage E5 legacy cleanup.


## 5. Third Known Defect: H01 Pinched-Ring Coplanar Overlap

The H01 Utrecht Vredenburg benchmark reports **0.0312 m² positive-area overlap** after Boolean subtraction/triangulation of a short footway region. This is not a zero-overlap result. Reproduce the exact polygon in a small deterministic fixture before changing contour cleanup. A near-collinear spike cleanup must preserve legitimate narrow features and should never modify E2 or Legacy geometry unintentionally.

## 6. Required Scaling Evidence — Hengelo and Twente

The existing samples are small (the synthetic stress case has 197 road ways); they **do not** validate whole-city costs. Before production promotion, benchmark representative complete Hengelo data and increasingly large Twente tiles. Record **full scene** and **road-only** times separately, CPU/memory, unions/differences, candidate blocker checks, triangle counts, skipped segments, provenance coverage and tile boundary seams.

Consider spatial indexing, workers, chunking and **baked/queryable geometry** only when the measured workload justifies them. A working renderer should not be refactored merely to optimize theoretical costs. Preserve E2 and Legacy until owner visual sign-off and adequate metrics. Railway ballast experiments, although potentially compatible with surface-first ideas, are separate from this road milestone.
