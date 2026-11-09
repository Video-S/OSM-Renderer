# ADR-0010: Surface-First At-Grade Road Rendering (E2+)

- **Status**: Accepted (Experimental — Preferred Architectural Direction; Pending Production Promotion)
- **Date**: 2026-11-09
- **Supersedes (for preferred at-grade road geometry strategy)**: [`ADR-0002`](./ADR-0002-boundary-derived-road-junction-meshing.md). **Related, not superseded:** [`ADR-0009`](./ADR-0009-infrastructure-graph-topology.md) (topology and source-data contracts remain authoritative)

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
   - Endpoint caps are enabled at topological road junctions and dead ends so meeting strokes naturally form smooth round joins, and are suppressed at closed loops (`isClosedLoop`), dataset boundary clips (`clippedAtStart`/`clippedAtEnd`), grade transitions (`hasGradeStart`/`hasGradeEnd`), and straight equal-width internal provenance split boundaries (`resolveInternalProvenanceBoundaryCaps`). When an internal provenance split bends (`dot < 0.9986`) or changes width (`|wA - wB| > 1e-3 m`), a single 16-sided rounding disk is deterministically assigned to one adjacent provenance sub-segment.
2. **Emergent Junctions via Priority-Ordered 2D Ownership Clipping**:
   - Explicit junction trimming (`trimmedEndpoints`), degree-2 miter portals, and separate `junction-*` / `path-junction-*` meshes are eliminated in `graph-surface` mode (`renderedJunctionCount === 0`).
   - Road and path strokes are emitted in deterministic priority order: vehicular before non-vehicular (`tier === 'path'`), higher `ROAD_CLASS_PRIORITY` before lower, and lexicographical `compareStringsCodeUnit(a.id, b.id)` for ties.
   - Each stroke subtracts already-placed higher-priority road footprints (`polygonClipping.difference`) then triangulates the visible `MultiPolygonCoords` using `THREE.ShapeGeometry` and `validateAndPruneHorizontalGeometry`. **Only validated geometry** becomes a blocking surface through `registerRoadFootprint`.
3. **Preserved Graph Topology, Provenance, and Elevation Contracts**:
   - E2+ consumes the exact same `InfrastructureRenderDescriptorBundle` (`M2.3-B/C/D/E1`), canonical road widths, elevation policy (`Y = +0.050 m` at-grade plane), multi-way chaining provenance splits (`#seg0`, `#seg1`), deduplication lineage, and `FaceFeatureRange` inspection metadata as E2.
4. **Controlled Experimental Rollout**:
   - E2+ is exposed via `roads: 'graph-surface'` (`?topologyRoads=graph-surface` and the Developer Tools panel).
   - `'legacy'` remains the production default (`DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS`) until all E2+ geometry validation gates and known edge-case follow-ups are closed.

## Consequences

- **Positive**:
  - Eliminates portal-pinch, acute-fork shoulder kinks, and "pizza-slice" junction patch artifacts across tested urban extracts without per-topology special cases.
  - The 12-dataset baseline reports **zero coverage defects** (`0` `provenance_split_bend_gap`, `0` missing road surfaces), zero winding or degenerate triangle defects, and no significant overlap in **11 of 12 E2+ datasets**. The **H01 Utrecht** dataset still has two detected overlaps totaling **0.0312 m²**.
  - Simplifies the **active E2+ geometry path** by bypassing the E2 junction-trimming/portal solver. The older solver remains implemented and selectable, not deleted.
- **Negative / Trade-offs**:
  - Increases `polygonClipping.union` invocations (one local union per buffered provenance segment) compared with direct quad-strip ribbon extrusion.


## Validation evidence and architectural boundaries

The graph describes **connectivity**, while buffered 2D footprints describe **occupied surface**. The unchanged infrastructure graph, source widths, OSM provenance, grade semantics, physical elevation and road-class materials are retained. A crossing in map coordinates does not establish a traversable graph intersection. The alternative of rendering overlapping strokes risks z-fighting; a single anonymous global road union would compromise source ownership, materials and scaling. E2+ instead partitions locally buffered footprints into attributed visible pieces.

The project owner repeatedly reports substantially improved real-world visuals. The automated 24-gon corridor reference is **independently implemented but still an approximation**, not a measured kerb outline or proof of complete real-world correctness.

**Resolved issue:** (1) internal provenance-split bend gaps (`provenance_split_bend_gap`) are resolved via `resolveInternalProvenanceBoundaryCaps` (`0` coverage defects across all 12 benchmark datasets). **Two remaining unresolved issues:** (2) desynchronized `diagnostics.featuresFullySubtracted` accounting for E2+ full subtraction; (3) **H01 0.0312 m² coplanar overlap** after pinched contour triangulation. The first E2+ prototype changed both junction patching and rounded buffers, so their independent contribution has **not been isolated**.

Legacy remains the default. Before switching defaults: resolve or document the remaining two cases with regression fixtures; verify geometry and source attribution; benchmark whole-Hengelo and progressively larger Twente tiles; obtain owner visual approval. The initial benchmark does not prove Twente-scale performance.

Related: [technical design](../e2-plus-surface-first-road-rendering.md), [history](../project-history.md), [roadmap](../road-rendering-roadmap.md), [benchmark](../../research/surface-first-road-rendering/baseline-results.json).
