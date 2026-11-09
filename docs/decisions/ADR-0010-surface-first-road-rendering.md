# ADR-0010: Surface-First At-Grade Road Rendering (E2+)

- **Status**: Accepted (Experimental — Preferred Architectural Direction; Pending Production Promotion)
- **Date**: 2026-11-09
- **Supersedes (for preferred at-grade road geometry strategy)**: [`ADR-0002`](./ADR-0002-junction-patching-and-ribbon-trimming.md), [`ADR-0009`](./ADR-0009-graph-driven-infrastructure-rendering.md) (at-grade junction trimming/patching subsections)

## Context

Stage E2 (`roads: 'graph'`, documented in `ADR-0009`) replaced Legacy pairwise centerline splitting with topological road graph nodes, degree-2 continuity miter portals, and boundary-derived `N`-way junction patches (`solveBoundaryDerivedJunctionNode`). While E2 improved provenance attribution and eliminated many Legacy overlap defects, extensive real-world testing across Dutch urban extracts (Hengelo, Amsterdam, Utrecht) exposed fundamental geometric fragility in explicit junction trimming and portal-handoff patching:

1. **Multi-way acute forks and carriage splits** (`Prins Hendrikkade`, `Veloursstraat`, `Parallelweg`): Trimming ribbons back by `sStart`/`sEnd` and bridging them with a localized node patch creates artificial kinks, pinched portals, or self-intersecting ribbon outlines when branch angles are acute or adjacent junctions are closely spaced.
2. **Closely spaced path and service intersections** (`Nieuwstraat–Stationsplein`, `Hengelo` pedestrian/cycleway crossings, `Prinses Beatrixstraat` parking aisles): Separate junction patches introduce material-owned wedges ("pizza-slice corners") and require growing special-case heuristics (`directRibbonFork`, `useContinuousRibbons`, portal relaxation fallbacks) to avoid visual artifacts.
3. **Solver complexity vs. visual consistency**: Treating junctions as distinct geometric primitives that must meet trimmed ribbon portals along 1D line segments couples every road's shape to local portal-angle solver heuristics.

## Decision

We adopt **Surface-First Road Rendering (`E2+`, `roads: 'graph-surface'`)** as the **preferred architectural direction** for at-grade road and path surface generation:

1. **Continuous Rounded-Stroke Buffering**:
   - Every eligible at-grade road edge (or provenance sub-segment) is buffered directly along its untrimmed centerline via `bufferSurfaceFirstRoadCenterline(points, width, { capStart, capEnd })` in `src/world/infrastructure/roads/SurfaceFirstRoadFootprints.ts`.
   - Each stroke is constructed as the 2D Boolean union (`polygonClipping.union`) of full-width segment rectangles, 16-sided round join disks at interior bends (`dot < 0.9986`, `> ~3°`), and 16-sided round endpoint cap disks.
   - Endpoint caps are enabled at topological road junctions and dead ends so meeting strokes naturally form smooth round joins, and are suppressed only at closed loops (`isClosedLoop`), dataset boundary clips (`clippedAtStart`/`clippedAtEnd`), grade transitions (`hasGradeStart`/`hasGradeEnd`), and internal provenance split boundaries.
2. **Emergent Junctions via Priority-Ordered 2D Ownership Clipping**:
   - Explicit junction trimming (`trimmedEndpoints`), degree-2 miter portals, and separate `junction-*` / `path-junction-*` meshes are eliminated in `graph-surface` mode (`renderedJunctionCount === 0`).
   - Road and path strokes are emitted in deterministic priority order: vehicular before non-vehicular (`tier === 'path'`), higher `ROAD_CLASS_PRIORITY` before lower, and lexicographical `compareStringsCodeUnit(a.id, b.id)` for ties.
   - Each stroke subtracts already-placed higher-priority road footprints (`polygonClipping.difference`) and registers its resulting visible `MultiPolygonCoords` (`registerRoadFootprint`) before triangulating via `THREE.ShapeGeometry` and `validateAndPruneHorizontalGeometry`.
3. **Preserved Graph Topology, Provenance, and Elevation Contracts**:
   - E2+ consumes the exact same `InfrastructureRenderDescriptorBundle` (`M2.3-B/C/D/E1`), canonical road widths, elevation policy (`Y = +0.050 m` at-grade plane), multi-way chaining provenance splits (`#seg0`, `#seg1`), deduplication lineage, and `FaceFeatureRange` inspection metadata as E2.
4. **Controlled Experimental Rollout**:
   - E2+ is exposed via `roads: 'graph-surface'` (`?topologyRoads=graph-surface` and the Developer Tools panel).
   - `'legacy'` remains the production default (`DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS`) until all E2+ geometry validation gates and known edge-case follow-ups are closed.

## Consequences

- **Positive**:
  - Eliminates portal-pinch, acute-fork shoulder kinks, and "pizza-slice" junction patch artifacts across tested urban extracts without per-topology special cases.
  - Maintains zero positive-area coplanar overlaps (`> 1e-3 m²`) and 100% upward-facing (`+Y`) non-degenerate triangles across all benchmarked datasets.
  - Simplifies the at-grade road pipeline by replacing ~1,500 lines of junction-trimming and portal-reconciliation solver logic with a 85-line local stroke buffer + priority clipper.
- **Negative / Trade-offs**:
  - Increases `polygonClipping.union` invocations (one local union per buffered provenance segment) compared with direct quad-strip ribbon extrusion.
  - Multi-segment simplified edges that bend at an internal provenance split boundary (`#seg0` -> `#seg1`) currently suppress endpoint disks on both sides of the internal split (`capStart = false`, `capEnd = false`), which can leave a small outer-corner wedge gap at angled provenance split vertices (documented and reproduced by `validateSurfaceFirstRoadGeometry`).
