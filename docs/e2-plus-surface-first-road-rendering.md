# E2+ Surface-First Road Rendering — Architecture and Geometry Design

**Scope:** As implemented in the [E2+ reference commit d2455b7](https://github.com/Video-S/OSM-Renderer/commit/d2455b7b8c711e689cabfc827b7f44ae2428b2ab), 2026-11-09.  
**Decision:** [ADR-0010](./decisions/ADR-0010-surface-first-road-rendering.md).  
**Standing:** Preferred direction, still experimental; E2 remains an independent selectable renderer.

## 1. Why the design changed

E2 is **junction-first**: discover a graph junction, calculate cutback distances and portal boundaries, synthesize a new junction polygon, trim each road, then reconcile seams. Any inconsistent trim/portal/patch calculation can leave a visible wedge, gap, corner discontinuity or seam.

E2+ is **surface-first**: derive each road's physical 2D footprint from its unchanged centerline and width, then resolve overlapping footprints with Boolean geometry. **No explicit intersection polygon is required.** Junction appearance is an emergent property of overlapping valid footprints.

This resembles cartographic line-stroke buffering, but it produces **non-overlapping 3D mesh surfaces**, not overlapping painted pixels.

## 2. Placement in the pipeline

~~~text
OSM / Overpass / GeoJSON
  → LocalGeoJsonProvider / metric projection / clipping
  → ProcessedMapData.topologySource
  → InfrastructureGraph (connectivity, grade, provenance)
  → InfrastructureRenderAdapter (roadEdges/roadNodes descriptors)
  → GeometryBuilder.buildScene
      ├── Legacy: original road geometry
      ├── E1: graph preview, legacy visuals
      ├── E2: GraphRoadGeometryBuilder junction patches + trimmed ribbons
      └── E2+: GraphRoadGeometryBuilder surfaceFirst branch
                 → SurfaceFirstRoadFootprints (rectangles + round disks)
                 → class/tier/ID-ordered Boolean ownership
                 → THREE.ShapeGeometry, correct elevation/normal
                 → merged Roads_* meshes + faceRanges
~~~

Mode value is `roads: 'graph-surface'`, URL `?topologyRoads=graph-surface`, in **Dev Tools → Rendering → Road Infrastructure Engine → Graph (E2+)**. The original E2 value is `roads: 'graph'`. Both consume the same descriptor data. Railways are independently selectable.

| Concern | Module |
| --- | --- |
| Option and graph adapter | `src/world/infrastructure/rendering/InfrastructureRenderAdapter.ts` |
| Selection UI | `src/components/DevToolsPanel.tsx` |
| Scene dispatch, resources, style, lineage | `src/world/GeometryBuilder.ts` |
| E2/E2+ per-edge processing and ownership | `src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts` |
| New local road buffering algorithm | `src/world/infrastructure/roads/SurfaceFirstRoadFootprints.ts` |
| Polygon area/degenerate cleanup | `src/world/PlanarLayerValidator.ts` |
| Tests | `src/world/SurfaceFirstRoadRendering.test.ts` and E2 regression suites |

## 3. Buffering a road into an area

For a clean centerline polyline P and physical width w, E2+ constructs a polygonal approximation to a Minkowski-sum line buffer with radius `r = w / 2`.

**Actual implementation details (important when debugging):**

1. Reject non-finite coordinates and nonpositive widths. Drop consecutive points separated by no more than **0.02 m**.
2. For each segment A→B, compute the normal `(-dz, dx) / length`. Offset A and B by `±r` to create a full-width quadrilateral.
3. At interior bends with normalized incoming/outgoing dot product below **0.9986**, add a disk centered at the bend. Each disk is a **16-vertex polygon**. Nearly collinear bends get no extra disk.
4. Add a disk at eligible original edge endpoints. Suppress endpoint disks at a clipped region boundary, a graph-confirmed grade-transition handoff, or an internal source-provenance split. A closed loop gets a closure disk.
5. Snap coordinates to **0.0001 m**; union the segment rectangles/disks using the existing `polygon-clipping` library; filter degenerate results.
6. Return `MultiPolygonCoords` (possibly multiple components/holes). This is a *candidate footprint*, not yet an accepted visible surface.

The result is a **polygonal** round join/cap, not an exact circle. Full disks at connected endpoints fill the missing regions that flat-cut ribbons can produce between incident roads. Very gentle bends can still have tiny unrounded outer corners; the bend threshold is an optimization/quality tradeoff.

**No new Clipper2 dependency was installed.** E2+ uses existing `polygon-clipping` and Three.js infrastructure.

## 4. How overlapping roads become a valid surface

For two candidate footprints A and B at the same grade, the desired coverage is `A ∪ B`. To keep attribution and prevent coplanar z-fighting, E2+ renders **A**, then **B minus A**, instead of rendering both polygons or constructing a third junction patch.

**Current deterministic order:**

- Vehicle-tier road edges precede path/nonvehicular-tier edges.
- Within a tier, higher `ROAD_CLASS_PRIORITY` claims geometry first.
- An edge-ID string comparison breaks remaining ties.
- Each edge may be split into constituent OSM provenance subsegments; each retains its tags and source identities.
- The builder scans previously accepted polygon footprints and filters candidates by overlapping bounding boxes before running `polygonClipping.difference`.
- Paths can be clipped by existing vehicle and path footprints. Vehicular surfaces are not clipped by path-tier footprints.

An intersection's apparent geometric union is achieved as **a partition into disjoint visible pieces**. This is not a single whole-map polygon union. The class that owns the overlap determines its visible material; the road graph still determines actual connectivity.

**Key invariant:** register **only the successfully triangulated, accepted remainder** as an occupied footprint for subsequent road clipping. Geometry that fails validation is not allowed to overlap the already accepted mesh as a fallback.

## 5. What happens for each accepted piece

The graph builder already splits simplified road edges by `EdgeSegmentProvenance`, carrying `sourceFeatureId`, `sourceFeatureIds`, `osmTags` and `roadClass`. In E2+ the junction-processing loop is skipped, so there are no E2 trim states or dedicated junction meshes.

For each provenance subsegment:

1. Build rounded footprint. If buffering throws or yields no polygon, attempt the existing validated **flat ribbon-outline** fallback.
2. Compute candidate bounds and locate earlier blocking surfaces of the appropriate tier.
3. Subtract earlier footprints with `polygonClipping.difference` and clean degenerate artifacts; fully consumed segments are recorded as subtracted.
4. Convert visible polygons via `createShapesFromMultiPolygon` into `THREE.ShapeGeometry`, rotate into XZ and translate to `roadElevation` (ordinary roads typically `+0.050 m`).
5. Validate and prune invalid horizontal geometry; register it in `SceneResourceManager`.
6. Register its **visible** 2D footprint for subsequent clipping, and its feature metadata for merged `Roads_*` groups and `faceRanges` inspection.
7. `highway=steps` still receives step treads from the existing component, positioned above the base road surface.

On irrecoverable clipping, invalid shapes or geometry rejection, E2+ records a diagnostic and **skips that segment**. That may create a missing patch, but it avoids silently drawing new coplanar overlaps.

## 6. Unchanged constraints and contracts

- **Topology:** OSM node identities, graph degree, source lineage and grade-transition relationships are not rebuilt by the new geometry branch. A visual crossing is not automatically a connected road graph node.
- **Width:** E2+ uses the existing source/tag-driven edge width multiplied by the scene's road-width multiplier; it does not infer physical width from lane count alone.
- **Elevation:** At-grade roads remain on the same physical plane according to `ElevationPolicy`. Bridges/tunnels/grade-separated segments stay in their existing Stage 6D pipeline, not in the at-grade buffer union.
- **Materials:** Road classes, theme materials and source inspection remain in the existing renderer.
- **Scene/lifecycle:** Mesh registration, grouping, resource disposal, diagnostic and geometry-audit systems are reused.
- **Rollback/comparison:** E2 and Legacy remain selectable. E2+ is currently **one branch in the existing graph builder**, not yet a fully independent module boundary.

## 7. Observed results versus unproven claims

| Statement | Status |
| --- | --- |
| E2+ skips the E2 node-patch constructor | Verified by code path; tests assert zero emitted junction patches |
| Uses segment rectangles, selected 16-vertex bend/endpoint disks and local polygon unions | Verified by source |
| Uses deterministic tier/class/ID ownership, retains OSM lineage | Verified by design/code path; broader provenance audits outstanding |
| Junction consistency improves dramatically across real map locations | **Project owner's repeated visual observation** |
| Whether removing junction patches or adding rounding caused most of the improvement | **Not isolated** |
| Fully correct geometry for every case | **Not established** |
| Acceptable CPU/memory at whole-Twente scale | **Not measured** |

Tests were added to the prototype, but no assistant-run `npm test`, `npm run lint` or browser visual validation occurred at that commit. Do not conflate source assertions with an executed green test suite.

## 8. Risks and precise follow-up questions

- **Scale:** The builder performs a local union for each provenance section and scans prior accepted footprints before bbox filtering. Worst-case CPU work can grow substantially; consider a spatial index, chunking, worker processing or offline baking **after benchmarking**.
- **Geometry:** Disks are full 16-gons; rounded junctions may overshoot intended curb shapes. Width transitions are not smoothed by E2's taper logic. Tight folds, micro-segments and loops deserve adversarial tests.
- **Floating precision:** 0.0001 m snapping and sub-centimeter remnants may introduce degenerate artifacts; audit, rather than assume absence.
- **Material semantics:** The owner of overlapping visible areas is priority-dependent. Verify mixed cycleway/footway and vehicle/path areas with ground-truth inspection.
- **Attribution:** A source's segment can be fully subtracted while another segment survives; check aggregate `fullySubtractedRoadIds` and lineage accounting for partial cases.
- **Failure modes:** Every buffer fallback, skipped segment, and clipping exception should be counted and visually inspected.
- **Causality:** A three-way comparison (E2; E2+ without rounded join disks; E2+ current rounded) would determine which design change contributes most.

## 9. Safe development workflow

- Treat commit [d2455b7](https://github.com/Video-S/OSM-Renderer/commit/d2455b7b8c711e689cabfc827b7f44ae2428b2ab) as a **reference**; this does not imply a Git tag was created.
- Make fixture-backed, small geometric changes; never add location- or OSM-ID-specific production conditionals.
- Run `npm run lint` and `npm test`, including `SurfaceFirstRoadRendering.test.ts`, `GraphRoadRendering.test.ts`, and the previous Hengelo regression fixtures.
- Measure area coverage, overlap, mesh winding/normals, width and attribution. Keep source data and camera pose constant for E2 vs E2+ visual comparisons.
- Project owner conducts the visual checks; AI/browser-generated visual verdicts are not a substitute.
- Do not change defaults, delete E2 code, or generalize to all Twente until the [road-rendering roadmap](./road-rendering-roadmap.md) gates are satisfied.
