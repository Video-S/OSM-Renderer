# E2+ Surface-First At-Grade Road Rendering (`roads: 'graph-surface'`)

> **Status**: Experimental — Preferred Architectural Direction (`ADR-0010`). Opt-in via `?topologyRoads=graph-surface` or the Developer Tools panel (`Roads: E2+ Surface-First`). Production default remains `'legacy'`.

## 1. Overview

**E2+** (`roads: 'graph-surface'`) is a surface-first OpenStreetMap road renderer that replaces Stage E2's explicit junction-cutting and portal-patching solver with continuous rounded-stroke footprints and priority-ordered 2D Boolean surface ownership clipping.

While E2+ shares the complete upstream topology graph (`M2.3-B/C/D`) and render descriptor adapter (`M2.3-E1`) with E2 (`roads: 'graph'`), it changes how at-grade road and path polygons are synthesized in `buildGraphAtGradeRoadGeometries`:

1. **No Centerline Trimming or Junction Patches**:
   - Topological node trimming (`trimmedEndpoints`), degree-2 continuity miter portals, and boundary-derived junction polygons (`junction-*`, `path-junction-*`) are skipped (`if (surfaceFirst) continue;`).
   - Every eligible at-grade road edge (or provenance sub-segment) retains its full centerline span.
2. **Local Rounded-Stroke Footprint Construction (`bufferSurfaceFirstRoadCenterline`)**:
   - Implemented in `src/world/infrastructure/roads/SurfaceFirstRoadFootprints.ts`.
   - Deduplicates consecutive centerline vertices closer than `0.02 m` and snaps primitive coordinates to a `1e-4 m` (`0.1 mm`) grid.
   - Emits a full-width rectangle ring (`width = edge.width * roadWidthMultiplier`) for every centerline segment longer than `0.02 m`.
   - Emits a 16-sided disk polygon of radius `width / 2` at every interior bend where the cosine of the turn angle is `< 0.9986` (`> ~3.0°`).
   - Emits 16-sided endpoint cap disks according to cap rules:
     - `capStart` is enabled on the first provenance sub-segment (`sub === subSegments[0]`) when the edge is not a closed loop (`!edge.isClosedLoop`), not clipped at the dataset boundary (`!edge.clippedAtStart && !startNode?.isBoundaryClipped`), and does not touch a grade transition (`!hasGradeStart`).
     - `capEnd` is enabled on the last provenance sub-segment (`sub === subSegments[subSegments.length - 1]`) under the symmetric conditions at `toNodeId`.
     - Closed loops (`clean.length >= 4` and endpoint distance `< 0.05 m`) receive a closing disk at `clean[0]`.
   - Unions all rectangle and disk primitives for that stroke via `filterDegenerateBooleanArtifacts(polygonClipping.union(...))`.
   - If the rounded buffer throws or yields an empty polygon, falls back to a flat ribbon outline (`buildRoadRibbonOutlineRing`) and records `e2plus_rounded_buffer_failed` / `e2plus_flat_ribbon_fallback`.
3. **Deterministic Priority-Ordered 2D Ownership Clipping**:
   - Buildable edges are sorted in deterministic ownership order:
     1. Vehicular tier before path tier (`isPath`).
     2. Higher `ROAD_CLASS_PRIORITY` before lower.
     3. Canonical code-unit ID order (`compareStringsCodeUnit(a.id, b.id)`).
   - For each stroke, already-placed footprints (`placedRoadFootprints`) whose bounding boxes overlap the stroke and which are eligible blockers (`isPath || !fp.isPath`) are subtracted via `filterDegenerateBooleanArtifacts(polygonClipping.difference(stroke, ...blockers))`.
   - If the visible remainder is empty (`visible.length === 0`), the segment is recorded in `fullySubtractedRoadIds` and `stats.fullySubtractedCount`.
   - Otherwise, `visible` is converted to `THREE.Shape` instances (`createShapesFromMultiPolygon`), triangulated via `THREE.ShapeGeometry`, rotated onto the horizontal `XZ` plane at `roadElevation` (`+0.050 m`), validated/pruned via `validateAndPruneHorizontalGeometry`, and registered in `placedRoadFootprints` (`registerRoadFootprint(sub.subId, isPath, visible)`).

---

## 2. Automated Geometry Correctness Validation (`SurfaceFirstRoadValidator.ts`)

`validateSurfaceFirstRoadGeometry(scene, data, options)` in `src/world/infrastructure/roads/SurfaceFirstRoadValidator.ts` audits E2+ (and E2) road meshes against four complementary verification categories without modifying geometry generation:

### A1. Surface Coverage (`SurfaceFirstCoverageValidationReport`)
- **Non-Circular Analytical Reference**: Independently constructs 24-gon analytical road corridors (`buildIndependentAnalyticalRoadCorridor`) directly from source/descriptor centerlines and widths rather than comparing `bufferSurfaceFirstRoadCenterline` against itself.
- **Legitimate Ownership Accounting**: For each eligible at-grade edge, subtracts overlapping higher-priority emitted triangles first (`occludedByHigherPriorityAreaM2`) and then subtracts the edge's own emitted triangles (`ownEmittedAreaM2`). Only unexplained uncovered area exceeding discretization tolerance (`max(0.05 m², 4% of corridor area)`) is flagged as `missing_road_surface_area` or `omitted_road_feature`.
- **Topological Node & Provenance Split Continuity**:
  - Verifies that every connected at-grade topological road node (`>= 2` incident buildable edges, non-clipped, non-grade-transition) is covered by emitted road triangles (`connected_node_gap`).
  - Probes the exterior angle bisector at internal provenance split vertices (`#seg0 -> #seg1`) where a simplified multi-way edge bends (`dot < 0.996`), detecting `provenance_split_bend_gap`.
- **Unintended Interior Hole Detection**: Unions all emitted at-grade road triangles and flags any interior hole ring (`1e-4 m² < area <= 2.0 m²`) that does not correspond to a genuine closed loop in the analytical reference (`unintended_interior_hole`).

### A2. Coplanar Overlap Validation (`SurfaceFirstOverlapValidationReport`)
- Reuses `validateRoadNetworkGeometry(scene)` from `src/world/ZFightingValidator.ts` (`COPLANAR_OVERLAP_AREA_TOLERANCE_M2 = 1e-3 m²`) and categorizes any positive-area coplanar overlaps into:
  - `cross_class_vehicular`
  - `same_class_road`
  - `path_or_cycleway`
  - `multi_provenance_segment`
  - `intra_feature_self_overlap`
- Shared 1D boundaries (`<= 1e-3 m²`) and grade-separated features (bridges, tunnels, raised step treads at `+0.056 m`) are excluded.

### A3. Mesh Integrity (`SurfaceFirstMeshIntegrityValidationReport`)
- Reuses `auditGraphRoadMeshIntegrity(scene.roadsGroup)` to verify counter-clockwise upward normals (`geomNormal.y > 0.99`), vertex-normal agreement (`dot > 0.99`), finite coordinates, and zero degenerate triangles (`area <= 1e-6 m²`).
- Verifies physical elevation consistency (`Y = 0.050 m ± 1e-4 m` for horizontal road meshes; `0.056 m ± 1e-4 m` for step treads) and checks for tiny disconnected feature fragments (`< 1e-3 m²`).

### A4. Source-Feature Provenance (`SurfaceFirstProvenanceValidationReport`)
- Verifies every triangle face on every `Roads_*` mesh resolves via `resolveInspectedFeature` to a valid `InspectableFeatureInfo` with a known `sourceFeatureId`, complete `sourceFeatureIds` (including deduplicated OSM ways), matching `RoadClass`, preserved primitive `osmTags`, and spatial containment within the source way's bounding envelope.

---

## 3. Performance Instrumentation (`GraphRoadRenderStats` & `GraphRoadGenerationTiming`)

Lightweight instrumentation is collected on every scene build and reset per rebuild:

- **Deterministic Counters (`roadsGroup.userData.graphRoadStats: GraphRoadRenderStats`)**:
  - `inputRoadNodeCount`, `inputRoadEdgeCount`, `atGradeRoadEdgeCount`
  - `processedProvenanceSegmentCount`, `provenanceSplitSegmentCount`
  - `generatedRectanglePrimitiveCount`, `generatedBendDiskPrimitiveCount`, `generatedCapDiskPrimitiveCount`, `generatedDiskPrimitiveCount`, `generatedTotalPrimitiveCount`
  - `polygonUnionOperationCount`, `polygonDifferenceOperationCount`
  - `candidateBlockerCheckCount`, `overlappingBlockerCount`
  - `renderedRoadRibbonCount`, `outputPolygonCount`, `outputHoleRingCount`, `outputTriangleCount`
  - `fullySubtractedCount`, `rejectedOrDegenerateCount`
  - `roundedBufferFailureCount`, `flatRibbonFallbackCount`, `surfaceClipFailureCount`, `emptyShapeCount`, `invalidTriangleGeometryCount`
- **Wall-Clock Timings (`roadsGroup.userData.graphRoadTiming: GraphRoadGenerationTiming`)**:
  - `totalRoadGenerationTimeMs`
  - `footprintConstructionTimeMs` (`primitiveConstructionTimeMs + polygonUnionTimeMs`)
  - `primitiveConstructionTimeMs`
  - `polygonUnionTimeMs`
  - `ownershipClippingTimeMs`
  - `triangulationAndValidationTimeMs`
  - Stored separately from `graphRoadStats` so deterministic counter snapshots remain bit-for-bit invariant across runs.


## Architecture and measurement cautions

- **Ownership order is vehicle/path tier, descending road-class priority, then edge ID. Width is not an additional tie-breaker.** Visible geometry is registered as an ownership blocker **after** successful triangulation and validation.
- **End caps** are conditional on the first/last provenance subsegment, boundary clipping, closed-loop and grade-transition rules; there is no explicit graph-degree test.
- The independent 24-gon reference uses a different buffer implementation than E2+'s 16-gon generator, but is still a **polygonal approximation** with declared tolerances, not ground-truth surveyed road geometry.
- **Timing units are not fully comparable across the table**: Legacy rows use **scene-build** medians under "Road Gen Med", whereas graph/E2+ rows use **graph-road generation** medians. Compare full-scene-to-full-scene data before making relative speed claims.
- The H01 data explicitly contain **0.0312 m² of coplanar triangle overlap**. High aggregate coverage percentages do not rule out localized gaps or self-overlaps.
- E2+ still shares the builder with E2; it bypasses, but does not remove, E2's junction solver. Grade-separated and railway geometry remain separately rendered, and true connectivity still comes from the graph.

Full-Hengelo and Twente performance remain **unmeasured**. Spatial indexing, chunking, web workers and precomputed/baked queryable geometry are possible later strategies, not justifications for changing the currently successful geometry prematurely.
