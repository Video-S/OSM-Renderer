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
   - Each segment polyline is buffered at its physical width $w$ by unioning oriented segment rectangles with 16-sided round disks ($r = w/2$) at interior bend vertices, eligible first/last provenance endpoints (except closed loops, clipped boundaries and grade-transition handoffs), and angled or width-transitioning internal provenance split boundaries (`resolveInternalProvenanceBoundaryCaps`, deterministically assigned to a single adjacent subsegment while straight equal-width splits emit no extra disk).
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
| `repro-nieuwstraat` | `legacy` | 6 | 4.01 *(scene)* | — | — | — | — | 63 | 0 (`0m²`) | 0/0 | — | — |
| `repro-nieuwstraat` | `graph` | 6 | 7.55 | — | 0.00 | 0.00 | 0/0 | 103 | 0 (`0m²`) | 0/0 | 99.5% | 0 |
| `repro-nieuwstraat` | `graph-surface` | 6 | 5.41 | 2.52 / 2.25 | 1.74 | 0.75 | 6/5 | 127 | 0 (`0m²`) | 0/0 | 100.0% | **0** |
| `repro-hengelo-corners` | `legacy` | 4 | 1.01 *(scene)* | — | — | — | — | 72 | 0 (`0m²`) | 0/0 | — | — |
| `repro-hengelo-corners` | `graph` | 4 | 4.26 | — | 0.00 | 0.00 | 0/0 | 61 | 0 (`0m²`) | 0/0 | 99.4% | 0 |
| `repro-hengelo-corners` | `graph-surface` | 4 | 4.92 | 2.56 / 2.41 | 2.18 | 0.76 | 7/5 | 131 | 0 (`0m²`) | 0/0 | 99.8% | **0** |
| `repro-prins-hendrikkade-fork` | `legacy` | 3 | 2.87 *(scene)* | — | — | — | — | 95 | 0 (`0m²`) | 0/0 | — | — |
| `repro-prins-hendrikkade-fork` | `graph` | 3 | 2.11 | — | 0.00 | 0.00 | 0/0 | 91 | 0 (`0m²`) | 0/0 | 100.0% | 0 |
| `repro-prins-hendrikkade-fork` | `graph-surface` | 3 | 7.25 | 5.58 / 5.47 | 1.58 | 0.55 | 3/2 | 204 | 0 (`0m²`) | 0/0 | 100.0% | **0** |
| `repro-veloursstraat-split` | `legacy` | 5 | 1.33 *(scene)* | — | — | — | — | 76 | 0 (`0m²`) | 0/0 | — | — |
| `repro-veloursstraat-split` | `graph` | 5 | 3.20 | — | 0.00 | 0.00 | 0/0 | 109 | 0 (`0m²`) | 0/0 | 100.0% | 0 |
| `repro-veloursstraat-split` | `graph-surface` | 5 | 4.02 | 2.38 / 2.30 | 1.13 | 0.38 | 5/4 | 177 | 0 (`0m²`) | 0/0 | 99.9% | **0** |
| `repro-parallelweg-4arm` | `legacy` | 4 | 0.89 *(scene)* | — | — | — | — | 73 | 2 (`2.08m²`) | 0/0 | — | — |
| `repro-parallelweg-4arm` | `graph` | 4 | 2.53 | — | 0.00 | 0.00 | 0/0 | 89 | 0 (`0m²`) | 0/0 | 100.0% | 0 |
| `repro-parallelweg-4arm` | `graph-surface` | 4 | 3.62 | 2.05 / 1.95 | 1.03 | 0.38 | 4/3 | 150 | 0 (`0m²`) | 0/0 | 99.9% | **0** |
| `H06` (Hengelo Center) | `legacy` | 21 | 12.81 *(scene)* | — | — | — | — | 408 | 3 (`19.44m²`) | 0/0 | — | — |
| `H06` (Hengelo Center) | `graph` | 21 | 19.96 | — | 0.00 | 0.00 | 0/0 | 459 | 1 (`0.001m²`) | 0/0 | 98.0% | 7 `missing_road_surface_area` |
| `H06` (Hengelo Center) | `graph-surface` | 21 | 41.35 | 21.00 / 20.28 | 16.45 | 3.94 | 39/36 | 1225 | **0 (`0m²`)** | 0/0 | **100.0%** | **0** *(was 1 `provenance_split_bend_gap`)* |
| `A02` (Amsterdam Centraal) | `legacy` | 24 | 6.67 *(scene)* | — | — | — | — | 554 | 13 (`7.40m²`) | 1/0 | — | — |
| `A02` (Amsterdam Centraal) | `graph` | 24 | 16.54 | — | 0.00 | 0.00 | 0/0 | 303 | 2 (`1.18m²`) | 0/0 | 100.0% | 0 |
| `A02` (Amsterdam Centraal) | `graph-surface` | 24 | 29.79 | 12.88 / 12.48 | 13.39 | 1.54 | 28/24 | 783 | **0 (`0m²`)** | 0/0 | **100.0%** | **0** *(was 2 `provenance_split_bend_gap`)* |
| `A01` (Amsterdam Rozengracht) | `legacy` | 28 | 7.52 *(scene)* | — | — | — | — | 382 | 16 (`8.51m²`) | 1/0 | — | — |
| `A01` (Amsterdam Rozengracht) | `graph` | 28 | 19.11 | — | 0.00 | 0.00 | 0/0 | 415 | 3 (`1.96m²`) | 0/0 | 99.9% | 0 |
| `A01` (Amsterdam Rozengracht) | `graph-surface` | 28 | 28.41 | 12.90 / 12.48 | 13.16 | 1.47 | 32/26 | 939 | **0 (`0m²`)** | 0/0 | **100.0%** | **0** *(was 1 `provenance_split_bend_gap`)* |
| `A05` (Amsterdam Overtoom) | `legacy` | 10 | 1.86 *(scene)* | — | — | — | — | 159 | 1 (`0.001m²`) | 0/0 | — | — |
| `A05` (Amsterdam Overtoom) | `graph` | 10 | 4.54 | — | 0.00 | 0.00 | 0/0 | 159 | 0 (`0m²`) | 0/0 | 100.0% | 0 |
| `A05` (Amsterdam Overtoom) | `graph-surface` | 10 | 12.02 | 4.49 / 4.33 | 5.94 | 0.63 | 16/13 | 365 | **0 (`0m²`)** | 0/0 | **100.0%** | **0** *(was 3 `provenance_split_bend_gap`)* |
| `H01` (Utrecht Vredenburg) | `legacy` | 38 | 20.39 *(scene)* | — | — | — | — | 663 | 21 (`46.64m²`) | 0/0 | — | — |
| `H01` (Utrecht Vredenburg) | `graph` | 38 | 52.70 | — | 0.00 | 0.00 | 0/0 | 807 | 0 (`0m²`) | 0/0 | 95.9% | 5 `missing_road_surface_area` |
| `H01` (Utrecht Vredenburg) | `graph-surface` | 38 | 78.87 | 27.14 / 26.48 | 43.85 | 4.03 | 92/85 | 1924 | **0 (`0m²`)** *(was 2 / `0.0312m²`)* | 0/0 | **100.0%** | **0** *(was 4 `provenance_split_bend_gap`)* |
| `H02` (Rotterdam Coolsingel) | `legacy` | 18 | 5.21 *(scene)* | — | — | — | — | 584 | 0 (`0m²`) | 0/0 | — | — |
| `H02` (Rotterdam Coolsingel) | `graph` | 18 | 7.18 | — | 0.00 | 0.00 | 0/0 | 275 | 0 (`0m²`) | 0/0 | 99.6% | 1 `missing_road_surface_area` |
| `H02` (Rotterdam Coolsingel) | `graph-surface` | 18 | 15.93 | 8.13 / 7.97 | 5.98 | 0.94 | 24/20 | 601 | **0 (`0m²`)** | 0/0 | **100.0%** | **0** |
| `stress-urban-grid-270` | `legacy` | 197 | 44.04 *(scene)* | — | — | — | — | 1342 | 28 (`14.45m²`) | 0/0 | — | — |
| `stress-urban-grid-270` | `graph` | 197 | 59.63 | — | 0.00 | 0.00 | 0/0 | 1226 | 0 (`0m²`) | 0/0 | 99.6% | 6 `missing_road_surface_area` |
| `stress-urban-grid-270` | `graph-surface` | 197 | 79.82 | 24.81 / 24.14 | 45.99 | 3.96 | 197/192 | 1734 | **0 (`0m²`)** | 0/0 | **100.0%** | **0** |

---

## 6. Discovered E2+ Geometry Defects (Status)

1. **Internal Provenance-Split Bend Gap (`provenance_split_bend_gap`) — Resolved**:
   - **Resolution**: `resolveInternalProvenanceBoundaryCaps` in `SurfaceFirstRoadFootprints.ts` and `GraphRoadGeometryBuilder.ts` inspects adjacent provenance subsegments (`#seg0 -> #seg1`, plus multi-segment closed-loop seams). Straight equal-width connections (`dot >= 0.9986` and `|wA - wB| <= 1e-3 m`) emit no additional disk, whereas angled bends (`dot < 0.9986`) or width transitions (`|wA - wB| > 1e-3 m`) assign a single 16-sided rounding disk to at most one adjacent subsegment using a deterministic ownership rule (wider subsegment first, longer millimeter-rounded cleaned arc length second, lexical `partId`/`sourceFeatureId` tie-breaker third). All `11` previously detected `provenance_split_bend_gap` defects across `H06` (`1 -> 0`), `A02` (`2 -> 0`), `A01` (`1 -> 0`), `A05` (`3 -> 0`), and `H01` (`4 -> 0`) are eliminated with `0` new coplanar overlaps.
2. **`diagnostics.featuresFullySubtracted` Desynchronization — Open**:
   - **Location**: `GraphRoadGeometryBuilder.ts` lines 3276–3282.
   - **Behavior**: When an E2+ stroke is completely occluded (`visible.length === 0`), `stats.fullySubtractedCount` and `fullySubtractedRoadIds` are populated, but `diagnostics.featuresFullySubtracted` is not incremented (unlike E2 at line 3551).
3. **Pinched-Ring `earcut` Overlap After Multi-Stroke Subtraction (`H01` Utrecht Vredenburg) — Resolved**:
   - **Location**: `H01` (`road_edge:way/1576579935-0:seg_0:p_0#seg1` on `Roads_footway`).
   - **Root Cause & Resolution**: When `#seg0` and adjacent footway blockers were conditioned after Boolean subtraction, `0.1 mm` (`COORDINATE_SNAP_QUANTUM`) coordinate grid snapping shifted their cut boundaries by `6.35 µm`–`23 µm`, creating two dead-end needle cracks (`0.073 m` and `0.224 m` long). Subsequent `polygonClipping.difference` on `#seg1` traced into those sub-`0.1 mm` cracks (`0` edge crossings in the raw difference output), and `conditionRing` in `PlanarLayerValidator.ts` snapped the crack tip by `~35 µm` across the entry edge without removing the fold-back spike (because `cross = hPerp / len` exceeded `1e-4` after grid snapping and spike removal was non-iterative), causing `THREE.ShapeGeometry` (`earcut`) to emit folded overlapping triangles (`+0.0312 m²` excess area: `0.0295 m²` intra-feature + `0.0017 m²` multi-provenance overlap). `conditionRing` now iteratively deduplicates consecutive vertices (`< 1 mm`) and removes `180°` sub-millimeter fold-back needle spikes (`dot < -0.999` and perpendicular excursion `hPerp <= 0.5 mm`), eliminating the self-crossing spike and reducing `H01` positive-area coplanar overlaps from `0.0312 m²` to **`0.0000 m²`** (`0` overlaps across all 12 benchmark datasets).

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

The JSON records one Linux/Node 22 benchmark environment with 2 warm-up and 7 measured runs. Legacy's "Road Gen Med" values represent **full scene construction**; graph/E2+ values represent **graph road-generation** time. Do not treat the two as a direct road-only speed comparison. Following the internal provenance-split bend fix (`resolveInternalProvenanceBoundaryCaps`) and the `conditionRing` sub-millimeter fold-back needle cleanup, all 12 benchmark datasets now report **0 positive-area coplanar overlaps (`0 m²`), 0 coverage defects, and 0 winding/degenerate triangle defects** in `graph-surface` mode.

This baseline is a reference for correctness investigation, **not proof of whole-Hengelo or Twente scalability**.

