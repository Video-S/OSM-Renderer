# Project History: Evolution of Road Surface & Junction Rendering

## 1. Goalpost 1: Boundary-Derived Junction Synthesis (`legacy` Mode, `ADR-0002`)

During Goalpost 1, road rendering transitioned from naive overlapping polyline ribbons to **boundary-derived junction polygon synthesis** (`ADR-0002`):
- **Approach**: Cluster road endpoints within a `0.15 m` radial tolerance (`TopologicalNodeIndex`), compute pairwise miter intersections between adjacent sorted incident arms around each node (`degree >= 2`), trim incoming road polylines back to their computed portal chords, and triangulate an explicit 2D junction polygon connecting the portal corners at a uniform `ROAD_SURFACE = 0.050 m` elevation.
- **Strengths**: Eliminated gross coplanar z-fighting at well-spaced orthogonal 3-way and 4-way street intersections without resorting to vertical micro-tiering.
- **Weaknesses**: Relied on heuristic coordinate clustering (`0.15 m`) and post-deduplication/post-chaining polylines, and struggled when acute angles or short segments caused miter points to project past adjacent vertices.

---

## 2. Exploratory Research: Independent BGT Road-Surface Reconstruction (`Closed / Not Adopted`)

Before integrating road rendering with the Stage B–D infrastructure graph, an offline Python/Shapely exploratory study (`research/road-surface-reconstruction/`) investigated whether variable lateral carriageway offsets $(w_L(s), w_R(s))$ and quadratic Bézier corner fillets could reconstruct physical Dutch BGT road surfaces directly from OSM centerlines:
- **Outcome**: Across 6 Amsterdam development sites (`A01`–`A06`) and 6 holdout sites (`H01`–`H06`), complex junction synthesis degraded IoU relative to simpler buffered baselines whenever OSM lacked explicit lane/width/kerb geometry.
- **Decision**: Closed as **Not Adopted** (`2026-11-08`). Zero code from the Python experiment entered production.

---

## 3. Milestone 2.3 Stage E2 (`roads: 'graph'`): Graph-Driven Explicit Junction Solver (`TKT-008`)

Following the completion of the pure-TypeScript infrastructure topology graph (`M2.3-A` through `M2.3-E1`, `ADR-0009`), Stage E2 (`src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`, `roads: 'graph'`) replaced `TopologicalNodeIndex` with graph-driven road rendering:
- **Approach**: Consumed `InfrastructureRenderDescriptorBundle` directly, keeping degree-2 continuity nodes as continuous mitered ribbons while running `solveBoundaryDerivedJunctionNode` at branching junctions (`degree >= 3`).
- **Observed Failures in Real Urban Extracts**:
  1. **Pedestrian Plazas & Cycleway Crossings (Hengelo Nieuwstraat / Stationsplein)**: Multi-way pedestrian and cycleway nodes with mixed widths and shallow incidence angles produced pinched portal chords, missing triangular corner wedges, or rejected junction patches.
  2. **Closely Spaced Path & Footway Corners (Hengelo Sidewalk/Crossing Nodes)**: When two junctions occurred within `< 3 m` (e.g., sidewalk-to-crosswalk splits), portal trimming from both ends consumed the connecting segment or left pizza-slice corner notches.
  3. **Acute Y-Forks & Dual-Carriageway Splits (Amsterdam Prins Hendrikkade, Hengelo Veloursstraat, Parallelweg)**: Shallow-angle forks (`15°–25°`) required aggressive miter clamping and fallback heuristics to prevent interior bowties or giant chord webs across the fork throat.

---

## 4. Adoption of E2+ (`roads: 'graph-surface'`, `ADR-0010`): Surface-First Road Rendering

To resolve the brittleness of explicit portal-chord junction solvers on irregular OSM topology, **E2+** (`roads: 'graph-surface'`, `src/world/infrastructure/roads/SurfaceFirstRoadFootprints.ts`) inverted the at-grade road geometry paradigm:
- **Core Insight**: A road network's 2D surface is the **Boolean union of its buffered edge strokes**, resolved by deterministic road-class and tier ownership subtraction (`polygon-clipping`).
- **Mechanism**:
  1. Every at-grade road provenance segment is buffered into a rounded 2D stroke by unioning per-segment oriented rectangles (`width = w`) with 16-sided bend disks (`radius = w/2`) at interior vertices and eligible endpoint caps (first/last provenance boundaries, excluding boundary clips, grade transitions and closed loops).
  2. Overlapping strokes are resolved in descending priority order (`vehicular > path`, higher road class first, then lexical edge ID tie-breaker) using 2D Boolean difference (`polygonClipping.difference`) accelerated by 2D AABB spatial pre-filtering.
  3. Remaining visible `MultiPolygon` regions (with interior holes preserved) are triangulated via `THREE.ShapeUtils.triangulateShape` (`earcut`) at `ELEVATION_POLICY.ROAD_SURFACE` (`0.050 m`) with full source-feature provenance (`sourceFeatureId`, `sourceFeatureIds`, `osmTags`, `faceRanges`).
- **Architectural Selection (`ADR-0010`)**: Extensive visual testing by the project owner across Hengelo and Amsterdam extracts confirmed a dramatic improvement in geometric consistency and corner continuity over E2. E2+ is now the **preferred architectural direction** for at-grade road rendering, undergoing automated geometry validation and performance baseline verification prior to promotion as the production default.


## Product goal and the lesson to preserve

The near-term deliverable is a high-fidelity, navigable OSM map renderer, initially for **Hengelo** and ultimately **Twente**; gameplay and large-agent simulation are later possibilities, not the current work. Precomputed/baked geometry is acceptable if it remains queryable.

The architectural lesson is **not that the E2 graph was wrong**. Its topology, width/grade policies, OSM lineage and Boolean ownership made E2+ possible. Rather, independently constructing a junction patch and reconciling trimmed road portals proved fragile. A [targeted continuous-path fix](https://github.com/Video-S/OSM-Renderer/commit/918c051b78a99dc997d59621476af1063179140b) preceded [E2+](https://github.com/Video-S/OSM-Renderer/commit/5106b14918ff81025b3ddf64a0725491066ac108).

The unrelated Dutch BGT/Shapely reconstruction experiment was **not adopted** into E2+. Optional local reference datasets should not become mandatory runtime dependencies. The first [automated E2+ baseline](../research/surface-first-road-rendering/baseline-results.json) found a few residual defects, despite the project owner's strong visual findings.
