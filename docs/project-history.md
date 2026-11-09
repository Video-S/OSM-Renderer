# OSM Renderer — Project History and Architectural Turning Points

**Updated:** 2026-11-09. This is a concise engineering history, not an exhaustive commit log.

## Product direction

The current product is a navigable **3D renderer of real OpenStreetMap geography**, initially tested around Hengelo and Twente. Geometry quality, camera control, source-data fidelity and scalability take precedence over gameplay. A possible later simulation/game inspired by Atom Zombie Smasher is **not** part of the current renderer milestones. Precomputed/baked geometry is acceptable if it improves consistency and supports queryable outputs.

The project uses a TypeScript/Three.js client, source-based map geometry, graph-derived road/rail metadata, and a uniform at-grade elevation. The project owner performs **human visual testing**; automated tests check code/geometry invariants.

## Timeline (selected decisions and observations)

| Period | Event | What we learned |
| --- | --- | --- |
| **2026-10-23 onward** | Refined real-world map viewer as first product. Early visuals revealed missing feature categories (including railways) and severe overlap/z-fighting. | Source coverage, physical elevations and coplanar ownership matter independently of gameplay. |
| **Late Oct 2026** | Ground-cover ownership and road/rail 2D clipping strategies developed; parking-space stripes exposed location-specific missing-geometry issues. | Passing tests and low z-fighting counts are necessary but do not guarantee full feature coverage. |
| **Late Oct – early Nov** | E2 road graph and explicit junction/portal/trim solver evolved with many bug fixes for forks, continuity and close-spaced intersections. | Correct topology is valuable, but detailed junction construction can still create unnecessary geometric failure modes. |
| **2026-11-04 to 2026-11-08** | Real junction regressions: fragmented paths, pizza-slice wedges and awkward corner shapes. Two useful Hengelo repros identified: Nieuwstraat–Stationsplein pedestrian T-junction and closely spaced mixed cycleway/footway junctions. | Tests reproduced many numerical invariants without resolving visual discontinuities. Treat the project owner’s visual verdict as independent evidence. |
| **2026-11-08** | Junction-specific fixes and polygon-corner smoothing improved some local edges without yielding continuous junction surfaces ([8c10afe](https://github.com/Video-S/OSM-Renderer/commit/8c10afe4c5054f43f0d5b7bc14ac522910542f9c), [998d33a](https://github.com/Video-S/OSM-Renderer/commit/998d33a0a6c10ff3ea9d301da25e1b3fad380b3a)). | Solving the shape of the extra junction polygon was not always solving the actual continuity problem. |
| **2026-11-09** | E2 skipped explicit patches in selected homogeneous path junctions and let full-width ribbons continue ([918c051](https://github.com/Video-S/OSM-Renderer/commit/918c051b78a99dc997d59621476af1063179140b)). Owner confirmed it fixed the motivating junction problem. | Strong signal that artificial patch/trim boundaries were a source of fragmentation. |
| **2026-11-09** | **E2+** introduced as an independently selectable **surface-first** prototype: rounded full-width segment footprints + priority-ordered Boolean surface ownership ([5106b14](https://github.com/Video-S/OSM-Renderer/commit/5106b14918ff81025b3ddf64a0725491066ac108)); regression tests and documentation followed ([d2455b7](https://github.com/Video-S/OSM-Renderer/commit/d2455b7b8c711e689cabfc827b7f44ae2428b2ab)). | An ordinary road can be modeled as an occupied area, and intersection coverage can emerge without explicitly meshing a junction. |
| **2026-11-09** | Owner tested additional locations and reported a **dramatic and broadly consistent visual improvement**, selecting E2+ as the way forward. | Adopt surface-first as the preferred architecture, with E2 retained until correctness/performance are validated. |

## The distinction that changed the architecture

**E2 junction-first:**
1. Detect a graph junction.
2. Derive cutbacks, portals, miters and a separate junction polygon.
3. Fit remaining ribbons against that patch and prevent overlaps.

**E2+ surface-first:**
1. Preserve the graph and original road width/centerline.
2. Derive each road's buffered planar footprint.
3. Subtract already-owned surface areas and triangulate the remainder.

The important surviving investment from E2 is the **graph, provenance, elevation model, class priority, and geometric clipping**. E2+ changes the way the first road surface polygons are constructed, not the entire map architecture.

## Separate research that should not be conflated

Earlier experimental Python/Shapely road-surface reconstruction compared inferred geometry against Dutch BGT datasets ([research/road-surface-reconstruction](../research/road-surface-reconstruction/README.md)). That separate exploration was closed as **not adopted**. It did **not** become the TypeScript E2+ implementation and does not supply E2+'s rendering algorithm. E2+ is based on local source-line buffering and the project's existing Boolean ownership pipeline.

The goal remains robust rendering throughout Hengelo/Twente. NL-only enrichment datasets are optional, must have a general fallback, and are not a prerequisite for E2+.

## Evidence and limits

- **Observed:** The owner repeatedly evaluated real scenes, confirmed E2+ is significantly more consistent, and endorsed it as the architectural direction.
- **Code-grounded:** E2+ has its own selectable branch, rounded buffer implementation and regression fixtures. E2 remains unchanged and selectable.
- **Not yet established:** Formal error rates, complete source coverage, performance at full-region scale, whether junction-patch removal or rounded joins produced most of the improvement, and production-readiness.

This history records the reasoning so future changes do not reintroduce unnecessary junction constructions merely because they appear more geometrically sophisticated.

See [ADR-0010](./decisions/ADR-0010-surface-first-road-rendering.md), [technical design](./e2-plus-surface-first-road-rendering.md), and [roadmap](./road-rendering-roadmap.md).
