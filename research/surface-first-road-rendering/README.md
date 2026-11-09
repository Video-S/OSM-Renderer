# E2+ — Surface-First Road Rendering (`roads: 'graph-surface'`)

- **Status**: Selected as the **preferred architectural direction** for at-grade road rendering ([`ADR-0010`](../../docs/decisions/ADR-0010-surface-first-road-rendering.md)), undergoing validation and targeted edge-case refinement before promotion to the production default (`'legacy'` remains the default).
- **Pipeline Specification**: [`docs/e2-plus-surface-first-road-rendering.md`](../../docs/e2-plus-surface-first-road-rendering.md)
- **Historical Context**: [`docs/project-history.md`](../../docs/project-history.md)
- **Validation & Migration Roadmap**: [`docs/road-rendering-roadmap.md`](../../docs/road-rendering-roadmap.md)

---

## 1. Selecting E2+ in the Application

1. **In-App Developer Tools**: Open **Dev Tools → Rendering → Road Infrastructure Engine** and select **`Graph (E2+)`** (`graph-surface`).
   - Selecting `Graph (E2)` (`graph`) restores the explicit boundary-derived junction solver (`TKT-008`).
   - Selecting `Legacy (Production)` (`legacy`) restores the pre-M2.3-E2 renderer.
2. **URL Query Parameters**:
   - `?topologyRoads=graph-surface` — select E2+ directly.
   - `?topologyRoads=graph` — select E2 directly.
   - `?topologyRoads=legacy` — select Legacy directly.
   - Railways remain independently controlled via `?topologyRailways=legacy|graph-preview`.

---

## 2. Algorithm Summary

1. **Shared Topology & Adapter**: Reuses the same `InfrastructureGraph` (`ADR-0009`) and `InfrastructureRenderDescriptorBundle` (`M2.3-E1`) as E2.
2. **Per-Provenance-Segment Rounded 2D Stroke Buffering (`SurfaceFirstRoadFootprints.ts`)**:
   - Each at-grade road edge is split into its constituent OSM provenance segments (`#seg0`, `#seg1`, …) when simplified edges span multiple OSM ways.
   - Each segment polyline is buffered at its physical width $w$ by unioning oriented segment rectangles with 16-sided round disks ($r = w/2$) at interior bend vertices and eligible first/last provenance endpoints (except closed loops, clipped boundaries and grade-transition handoffs).
3. **Deterministic Ownership Resolution (`GraphRoadGeometryBuilder.ts`)**:
   - Candidate strokes are sorted in descending ownership priority (`vehicular` tier before `path` tier, higher `RoadClass` priority first, lexical edge-ID tie-breaker).
   - Higher-priority strokes are subtracted from lower-priority strokes via 2D Boolean difference (`polygonClipping.difference`), accelerated by 2D AABB bounding-box rejection.
4. **Triangulation & Provenance Attribution**:
   - Remaining visible `MultiPolygon` regions (with interior holes preserved) are triangulated via `THREE.ShapeUtils.triangulateShape` (`earcut`) at `ELEVATION_POLICY.ROAD_SURFACE` (`0.050 m`) and merged by `RoadClass` with complete `FaceFeatureRange` provenance (`sourceFeatureId`, `sourceFeatureIds`, `osmTags`).
5. **Grade-Separated Isolation**:
   - Bridges (`+2.850 m`), tunnels (`-2.000 m`), and railway geometry remain untouched.

---

## 3. Automated Geometry Validation (`SurfaceFirstRoadValidator.ts`)

`validateSurfaceFirstRoadGeometry(scene, mapData, options)` verifies four independent correctness dimensions without circular self-comparison:

- **A1. Non-Circular Surface Coverage**:
  - Builds an independent 24-gon analytical corridor (`buildIndependentAnalyticalRoadCorridor`) from source centerlines and widths.
  - Subtracts higher-priority emitted road triangles (`occludedByHigherPriorityAreaM2`) and measures unexplained missing area (`missing_road_surface_area`, `omitted_road_feature`, `connected_node_gap`, `unintended_interior_hole`, and `provenance_split_bend_gap`).
- **A2. Coplanar Overlap Validation**:
  - Reuses `ZFightingValidator.validateRoadNetworkGeometry(scene)` (`COPLANAR_OVERLAP_AREA_TOLERANCE_M2 = 1e-3 m²` / `10 cm²`) and categorizes overlaps into `cross_class_vehicular`, `same_class_road`, `path_or_cycleway`, `multi_provenance_segment`, and `intra_feature_self_overlap`.
- **A3. Mesh Integrity & Physical Elevation**:
  - Reuses `auditGraphRoadMeshIntegrity(scene.roadsGroup)` (`0` inverted winding, `0` normal mismatches, `0` non-finite vertices, `0` degenerate triangles `<= 1e-6 m²`) plus physical elevation checks (`0.050 m ± 1e-4 m`, `+0.056 m` for `highway=steps` treads) and tiny disconnected fragment detection (`< 1e-3 m²`).
- **A4. Source-Feature Provenance**:
  - Verifies 100% face attribution via `resolveInspectedFeature`, valid `sourceFeatureId` / `sourceFeatureIds` across both `data.roads` and pre-chaining `data.topologySource.roadParts`, `RoadClass` subtype matching, preserved primitive `osmTags`, spatial bounding-box containment, deduplicated feature lineage, and `fullySubtractedRoadIds`.

---

## 4. Performance Instrumentation

### Timing Metrics (`roadsGroup.userData.graphRoadTiming: GraphRoadGenerationTiming`)
Separated from `scene.infrastructureRenderPreview.timing` (`graphBuildTimeMs`, `adapterBuildTimeMs`) and `scene.stats.cpuBuildTimeMs`:
- `totalRoadGenerationTimeMs`: Total CPU time inside `buildGraphAtGradeRoadGeometries`.
- `footprintConstructionTimeMs`: Total time inside `bufferSurfaceFirstRoadCenterline`.
  - `primitiveConstructionTimeMs`: Generating oriented segment rectangles and 16-gon bend/cap disks.
  - `polygonUnionTimeMs`: Local per-stroke `polygonClipping.union` calls.
- `ownershipClippingTimeMs`: Bounding-box blocker selection and priority-ordered Boolean difference.
- `triangulationAndValidationTimeMs`: Per-piece triangulation and validation, excluding later scene merging.

### Deterministic Operation Counters (`roadsGroup.userData.graphRoadStats: GraphRoadRenderStats`)
- **Input & Provenance**: `inputRoadNodeCount`, `inputRoadEdgeCount`, `atGradeRoadEdgeCount`, `processedProvenanceSegmentCount`, `provenanceSplitSegmentCount`.
- **Primitives & Booleans**: `generatedRectanglePrimitiveCount`, `generatedBendDiskPrimitiveCount`, `generatedCapDiskPrimitiveCount`, `generatedDiskPrimitiveCount`, `generatedTotalPrimitiveCount`, `polygonUnionOperationCount`, `polygonDifferenceOperationCount`, `candidateBlockerCheckCount`, `overlappingBlockerCount`.
- **Output & Fallbacks**: `renderedRoadRibbonCount`, `outputPolygonCount`, `outputHoleRingCount`, `outputTriangleCount`, `fullySubtractedCount`, `rejectedOrDegenerateCount`, `roundedBufferFailureCount`, `flatRibbonFallbackCount`, `surfaceClipFailureCount`, `emptyShapeCount`, `invalidTriangleGeometryCount`.

All metrics are reset cleanly on every scene rebuild and surfaced in **Dev Tools → Rendering → Road Geometry & Perf** and `window.__M21_LAB__.getSnapshot()`.

---

## 5. Reproducible 12-Dataset Baseline (`baseline-results.json`)

To regenerate the full 12-dataset comparison (`legacy` vs. `graph` E2 vs. `graph-surface` E2+, 2 warm-up runs + 7 measured runs per mode):

```bash
npx tsx scripts/run-e2plus-baseline.ts
```

### Summary of Measured Results (`research/surface-first-road-rendering/baseline-results.json`)

| Dataset | Mode | Ways | Road Gen Med (ms) | Buffer / Union (ms) | Clip (ms) | Tri (ms) | Unions / Diffs | Road Tris | Overlaps (`>10cm²`) | Winding / Deg | Cov Ratio | Coverage Defects |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `repro-nieuwstraat` | `legacy` | 6 | 3.78 *(scene)* | — | — | — | — | 63 | 0 (`0m²`) | 0/0 | — | — |
| `repro-nieuwstraat` | `graph` | 6 | 8.18 | — | 0.00 | 0.00 | 0/0 | 103 | 0 (`0m²`) | 0/0 | 99.5% | 0 |
| `repro-nieuwstraat` | `graph-surface` | 6 | 5.64 | 1.94 / 1.77 | 1.86 | 0.80 | 6/5 | 127 | 0 (`0m²`) | 0/0 | 100.0% | **0** |
| `repro-hengelo-corners` | `legacy` | 4 | 1.22 *(scene)* | — | — | — | — | 72 | 0 (`0m²`) | 0/0 | — | — |
| `repro-hengelo-corners` | `graph` | 4 | 3.51 | — | 0.00 | 0.00 | 0/0 | 61 | 0 (`0m²`) | 0/0 | 99.4% | 0 |
| `repro-hengelo-corners` | `graph-surface` | 4 | 4.99 | 1.75 / 1.62 | 2.04 | 0.62 | 7/5 | 131 | 0 (`0m²`) | 0/0 | 99.8% | **0** |
| `repro-prins-hendrikkade-fork` | `legacy` | 3 | 2.30 *(scene)* | — | — | — | — | 95 | 0 (`0m²`) | 0/0 | — | — |
| `repro-prins-hendrikkade-fork` | `graph` | 3 | 2.15 | — | 0.00 | 0.00 | 0/0 | 91 | 0 (`0m²`) | 0/0 | 100.0% | 0 |
| `repro-prins-hendrikkade-fork` | `graph-surface` | 3 | 8.71 | 3.49 / 3.39 | 1.81 | 0.44 | 3/2 | 204 | 0 (`0m²`) | 0/0 | 100.0% | **0** |
| `repro-veloursstraat-split` | `legacy` | 5 | 1.11 *(scene)* | — | — | — | — | 76 | 0 (`0m²`) | 0/0 | — | — |
| `repro-veloursstraat-split` | `graph` | 5 | 4.47 | — | 0.00 | 0.00 | 0/0 | 109 | 0 (`0m²`) | 0/0 | 100.0% | 0 |
| `repro-veloursstraat-split` | `graph-surface` | 5 | 7.37 | 3.98 / 3.87 | 1.60 | 0.59 | 5/4 | 177 | 0 (`0m²`) | 0/0 | 99.9% | **0** |
| `repro-parallelweg-4arm` | `legacy` | 4 | 1.06 *(scene)* | — | — | — | — | 73 | 2 (`2.08m²`) | 0/0 | — | — |
| `repro-parallelweg-4arm` | `graph` | 4 | 3.53 | — | 0.00 | 0.00 | 0/0 | 89 | 0 (`0m²`) | 0/0 | 100.0% | 0 |
| `repro-parallelweg-4arm` | `graph-surface` | 4 | 4.63 | 2.70 / 2.61 | 1.13 | 0.45 | 4/3 | 150 | 0 (`0m²`) | 0/0 | 99.9% | **0** |
| `H06` (Hengelo Center) | `legacy` | 21 | 23.61 *(scene)* | — | — | — | — | 408 | 3 (`19.44m²`) | 0/0 | — | — |
| `H06` (Hengelo Center) | `graph` | 21 | 28.21 | — | 0.00 | 0.00 | 0/0 | 459 | 1 (`0.001m²`) | 0/0 | 98.0% | 7 `missing_road_surface_area` |
| `H06` (Hengelo Center) | `graph-surface` | 21 | 48.08 | 27.38 / 22.41 | 18.04 | 3.87 | 39/36 | 1221 | **0 (`0m²`)** | 0/0 | **99.9%** | 1 `provenance_split_bend_gap` |
| `A02` (Amsterdam Centraal) | `legacy` | 24 | 5.66 *(scene)* | — | — | — | — | 554 | 13 (`7.40m²`) | 1/0 | — | — |
| `A02` (Amsterdam Centraal) | `graph` | 24 | 15.84 | — | 0.00 | 0.00 | 0/0 | 303 | 2 (`1.18m²`) | 0/0 | 100.0% | 0 |
| `A02` (Amsterdam Centraal) | `graph-surface` | 24 | 30.47 | 12.91 / 12.52 | 13.84 | 1.69 | 28/24 | 746 | **0 (`0m²`)** | 0/0 | **100.0%** | 2 `provenance_split_bend_gap` |
| `A01` (Amsterdam Rozengracht) | `legacy` | 28 | 9.20 *(scene)* | — | — | — | — | 382 | 16 (`8.51m²`) | 1/0 | — | — |
| `A01` (Amsterdam Rozengracht) | `graph` | 28 | 16.08 | — | 0.00 | 0.00 | 0/0 | 415 | 3 (`1.96m²`) | 0/0 | 99.9% | 0 |
| `A01` (Amsterdam Rozengracht) | `graph-surface` | 28 | 38.06 | 15.66 / 15.15 | 13.74 | 1.99 | 32/26 | 921 | **0 (`0m²`)** | 0/0 | **99.9%** | 1 `provenance_split_bend_gap` |
| `A05` (Amsterdam Overtoom) | `legacy` | 10 | 1.87 *(scene)* | — | — | — | — | 159 | 1 (`0.001m²`) | 0/0 | — | — |
| `A05` (Amsterdam Overtoom) | `graph` | 10 | 4.47 | — | 0.00 | 0.00 | 0/0 | 159 | 0 (`0m²`) | 0/0 | 100.0% | 0 |
| `A05` (Amsterdam Overtoom) | `graph-surface` | 10 | 13.13 | 6.81 / 6.71 | 4.31 | 0.69 | 16/13 | 359 | **0 (`0m²`)** | 0/0 | **99.9%** | 3 `provenance_split_bend_gap` |
| `H01` (Utrecht Vredenburg) | `legacy` | 38 | 26.44 *(scene)* | — | — | — | — | 667 | 21 (`46.64m²`) | 0/0 | — | — |
| `H01` (Utrecht Vredenburg) | `graph` | 38 | 45.87 | — | 0.00 | 0.00 | 0/0 | 810 | 0 (`0m²`) | 0/0 | 95.9% | 5 `missing_road_surface_area` |
| `H01` (Utrecht Vredenburg) | `graph-surface` | 38 | 90.69 | 29.87 / 29.10 | 56.05 | 3.75 | 92/85 | 1904 | 2 (`0.0312m²`) | 0/0 | **100.0%** | 4 `provenance_split_bend_gap` |
| `H02` (Rotterdam Coolsingel) | `legacy` | 18 | 6.41 *(scene)* | — | — | — | — | 584 | 0 (`0m²`) | 0/0 | — | — |
| `H02` (Rotterdam Coolsingel) | `graph` | 18 | 8.66 | — | 0.00 | 0.00 | 0/0 | 275 | 0 (`0m²`) | 0/0 | 99.6% | 1 `missing_road_surface_area` |
| `H02` (Rotterdam Coolsingel) | `graph-surface` | 18 | 22.72 | 10.65 / 10.49 | 7.40 | 1.39 | 24/20 | 612 | **0 (`0m²`)** | 0/0 | **100.0%** | **0** |
| `stress-urban-grid-270` | `legacy` | 197 | 42.63 *(scene)* | — | — | — | — | 1342 | 28 (`14.45m²`) | 0/0 | — | — |
| `stress-urban-grid-270` | `graph` | 197 | 66.85 | — | 0.00 | 0.00 | 0/0 | 1226 | 0 (`0m²`) | 0/0 | 99.6% | 6 `missing_road_surface_area` |
| `stress-urban-grid-270` | `graph-surface` | 197 | 103.38 | 29.75 / 28.99 | 62.89 | 7.60 | 197/192 | 1734 | **0 (`0m²`)** | 0/0 | **100.0%** | **0** |

---

## 6. Discovered E2+ Geometry Defects (Documented & Reproduced, Unmodified per Scope)

1. **Internal Provenance-Split Bend Gap (`provenance_split_bend_gap`)**:
   - **Location**: `GraphRoadGeometryBuilder.ts` lines 3080–3083 (`capStart = sub === subSegments[0] && ...`, `capEnd = sub === subSegments[subSegments.length - 1] && ...`).
   - **Behavior**: When a simplified road edge chains two or more OSM ways (`edge.provenance.segments.length > 1`) that meet at a non-collinear bend (`#seg0 -> #seg1`), neither `#seg0` nor `#seg1` places a 16-sided disk cap at their shared internal join vertex, leaving an unrounded outer-corner wedge gap. Observed in `H06` (`1`), `A02` (`2`), `A01` (`1`), `A05` (`3`), `H01` (`4`), and reproduced in `src/world/SurfaceFirstRoadRendering.test.ts` (Test 5).
2. **`diagnostics.featuresFullySubtracted` Desynchronization**:
   - **Location**: `GraphRoadGeometryBuilder.ts` lines 3121–3127.
   - **Behavior**: When an E2+ stroke is completely occluded (`visible.length === 0`), `stats.fullySubtractedCount` and `fullySubtractedRoadIds` are populated, but `diagnostics.featuresFullySubtracted` is not incremented (unlike E2 at line 3383).
3. **Minor Pinched-Ring `earcut` Overlap After Multi-Stroke Subtraction (`H01` Utrecht Vredenburg)**:
   - **Location**: `H01` (`road_edge:way/1576579935-0:seg_0:p_0#seg1` on `Roads_footway`).
   - **Behavior**: After sequential `polygonClipping.difference` operations on a short (`2.52 m`) footway crossing/sidewalk edge, a near-collinear pinched spike in the subtracted contour produces a `0.0295 m²` intra-feature triangle overlap and a `0.0017 m²` adjacent provenance-segment overlap (`0.0312 m²` total across `6,233.94 m²` of road surface).

---

## 7. Verification Commands

```bash
npx tsx --test src/world/SurfaceFirstRoadRendering.test.ts
npm test
npm run lint
npm run build
npm run docs:api
```


## 8. Interpreting the Baseline

The JSON records one Linux/Node 22 benchmark environment with 2 warm-up and 7 measured runs. Legacy's "Road Gen Med" values represent **full scene construction**; graph/E2+ values represent **graph road-generation** time. Do not treat the two as a direct road-only speed comparison. H01 has **two nonzero coplanar overlaps totaling 0.0312 m²**. Several extracts have internal provenance-split bend gaps despite high overall coverage percentages.

This baseline is a reference for correctness investigation, **not proof of whole-Hengelo or Twente scalability**.
