# ADR-0010: Surface-first road footprints as the preferred at-grade rendering architecture

## Metadata

- **Decision ID:** ADR-0010
- **Status:** **Accepted architectural direction; prototype still experimental** (no production-default switch or retirement of E2 authorized)
- **Date:** 2026-11-09
- **Deciders:** Project owner (direction based on visual evaluation); rendering engineering (implementation/design)
- **Related:** [ADR-0002](./ADR-0002-boundary-derived-road-junction-meshing.md), [ADR-0004](./ADR-0004-grade-separated-infrastructure-and-elevation-policy.md), [ADR-0005](./ADR-0005-source-feature-provenance-and-diagnostics.md), [ADR-0009](./ADR-0009-infrastructure-graph-topology.md)
- **Reference implementation:** [E2+ at d2455b7](https://github.com/Video-S/OSM-Renderer/commit/d2455b7b8c711e689cabfc827b7f44ae2428b2ab)

## Context and problem

The E2 graph-driven renderer solves many geometric constraints through node-specific junction construction: trimmed incoming road ribbons, computed junction portals, separate junction patches, and miter/continuity handling. Tests helped remove z-fighting and many defects, but real Hengelo path and vehicular intersections still exhibited missing areas, triangular wedges, fractured surfaces and inconsistent corners. Several fixes passed automated tests without adequately improving the project owner's visual evaluation.

A narrower fix allowing continuous full-width ribbons at certain pedestrian/cycleway junctions (commit [918c051](https://github.com/Video-S/OSM-Renderer/commit/918c051b78a99dc997d59621476af1063179140b)) successfully repaired the motivating examples. This led to the separately selectable **E2+** experiment: construct full-width, rounded road footprints directly from source centerlines and use 2D surface ownership to resolve their overlap.

After testing E2+ across multiple locations, the project owner reported a major and unusually consistent visual improvement and explicitly selected this method as the way forward. **This is strong human visual evidence, not a completed geometry/performance validation.**

## Decision

Prefer **surface-first at-grade road rendering**, subject to the validation gates below.

1. The infrastructure graph remains the authority for road identity, grade, topology, attributes and routing connectivity (ADR-0009). Geometric overlap alone does not create graph connectivity.
2. Build a polygonal road footprint from each graph edge/provenance subsegment: full-width centerline rectangles, rounded bend joins, and eligible rounded endpoint caps.
3. Partition the visible footprint union through deterministic priority-ordered Boolean subtraction. Earlier accepted surfaces own the overlap; later surfaces retain their visible difference. The implementation **does not create one global union of all roads**.
4. Triangulate the resulting non-overlapping polygons into 3D meshes at the existing at-grade elevation, preserving OSM provenance, road classes and inspectability (ADR-0005).
5. Avoid explicit junction patches, trim portals and node-specific mesh reconstruction for the ordinary E2+ at-grade path.
6. Keep E2 (`roads: 'graph'`), E2+ (`roads: 'graph-surface'`), Legacy and the independent railway mode selectable while the experiment is evaluated.

**Governing principle:** the graph describes **connectivity**; buffered footprints describe **occupied surface**. An intersection in a graph is not necessarily a separately modeled surface.

## Alternatives considered

| Option | Assessment |
| --- | --- |
| Continue E2 junction-first construction | Retains precise special handling, but complexity and visible defects persisted. Keep as a fallback/comparison, not the preferred direction for ordinary at-grade geometry. |
| Render overlapping strokes as 3D triangles | Easy to draw but creates positive-area coplanar overlap and z-fighting. |
| Union every road into one enormous polygon | Can cover the same area, but creates scalability, material ownership and source-attribution problems. |
| Assign arbitrary elevation per road class | Previously rejected: introduces false physical steps and hides geometric defects. |
| **Local rounded footprints + priority clipping** | **Selected**: reuses reliable graph, Boolean ownership, triangulation and provenance infrastructure while eliminating many junction-specific calculations. |

## Invariants that must survive migration

- Preserve explicit `width=*` and the existing road-width inference policy. Never increase road widths merely because `lanes=*` is larger.
- Preserve source-feature IDs, class, names, raw tags, lineage and `faceRanges` inspection after clipping/mesh aggregation.
- Preserve real grade separation; an XZ crossing of bridges, tunnels and at-grade roads is not automatically an at-grade junction.
- Emit no significant positive-area coplanar road overlaps, inverted or invalid horizontal triangles, or unowned duplicate road meshes.
- Keep deterministic surface ownership/material behavior and diagnose rejected or fully subtracted geometry.
- Retain E2 independently until the project owner signs off on E2+ across real-world edge cases.
- Keep human visual evaluation with the project owner; automated tests are necessary but not sufficient.

## Consequences and tradeoffs

**Benefits:** simpler and more general conceptual geometry; fewer coupled trimming/portal/junction computations; improved observed visual consistency; no need to discard the graph, OSM provenance or existing materials.

**Costs/risks:** more polygon unions and differences, potential O(N²) scanning of earlier surfaces before bbox filtering, many triangles on curved ways, round-corner approximations, abruptly changing source widths, uncertain behavior at complex grade handoffs and material boundaries. Full-city/Twente performance is unmeasured. The first prototype is an isolated branch within the shared E2 builder, not a fully independent new engine.

We have **not proven** whether dropping explicit junction patches or adding rounded buffering contributes more to the improvement. A controlled flat-vs-rounded comparison would isolate that question.

## Validation before promotion to production default

1. Reproduce the known Hengelo examples, acute forks, clustered junctions, width transitions, clipped region boundaries, loops, mixed vehicle/path surfaces and grade-separated crossings in both modes.
2. Audit coverage, holes, positive-area overlap, triangle winding, source attribution, widths, diagnostics and fallback/rejection counts. Avoid tests that merely codify the current visual shape.
3. Benchmark increasingly large Hengelo/Twente extracts: build time, memory, triangle count, polygon operations and rejected geometry. Determine budgets before optimization.
4. Compare E2, E2+ without rounded joins, and current rounded E2+ if the source of improvement remains important.
5. Obtain project-owner visual sign-off. Only then consider changing the default, extracting/removing E2 code, or moving work to workers/baked assets.

**No fresh test/build benchmark is claimed here.** The assistant did not run npm tests or browser visual checks on E2+; project-owner visual observations are recorded as observations, not quantitative measurements.

## Related implementation and documentation

- `src/world/infrastructure/roads/SurfaceFirstRoadFootprints.ts`
- `src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`
- `src/world/infrastructure/rendering/InfrastructureRenderAdapter.ts`
- `src/world/GeometryBuilder.ts` and `src/components/DevToolsPanel.tsx`
- `src/world/SurfaceFirstRoadRendering.test.ts` and `src/world/GraphRoadRendering.test.ts`
- [Full technical design](../e2-plus-surface-first-road-rendering.md)
- [Project history](../project-history.md)
- [Road-rendering roadmap](../road-rendering-roadmap.md)

**Relationship to ADR-0002:** ADR-0002 remains a valid record of the E2/Legacy intersection design and uniform elevation policy. This ADR replaces **the preferred direction for future at-grade junction geometry**, not the historical record or E2 runtime behavior.
