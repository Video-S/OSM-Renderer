# Architectural Decision Records (ADRs)

## Purpose of an ADR

An Architectural Decision Record (ADR) captures significant architectural, algorithmic, or structural design decisions made in this project. It documents the context, the trade-offs considered, the decision itself, and the consequences for future implementation and maintenance.

Recording ADRs prevents repeating past investigations, clarifies why specific solutions were chosen over naive alternatives, and provides an authoritative reference for human engineers and AI coding assistants.

---

## When to Create an ADR

Create a new ADR when introducing or changing:

1. **Elevation & Stacking Rules**: Changes to physical elevation baselines, layering tiers, or z-index conventions.
2. **Procedural Geometry Algorithms**: Road junction synthesis, polygon clipping, triangulation, miter clamping, or bridge ramp profiles.
3. **Data Pipeline & Topology**: How OSM nodes, ways, and relations are indexed, grouped, chained, or snapped.
4. **Scene & Resource Lifecycle**: GPU buffer disposal, instancing, or Three.js scene graph management.
5. **Camera & Projection Systems**: Coordinate conversions, camera projection mode (orthographic vs. perspective), or framing math.

---

## Updating or Superseding Decisions

- Architectural decisions must not be silently rewritten or abandoned.
- If a subsequent requirement or performance issue requires changing an accepted decision, create a new ADR that explicitly references and marks the previous ADR as `Superseded by ADR-XXXX`.
- If an ADR undergoes minor non-breaking clarification, update its status notes while preserving the historical context.

---

## Template

All ADRs must be structured using the reusable template:

- **[ADR Template (ADR-TEMPLATE.md)](./ADR-TEMPLATE.md)**

---

## Index of Architectural Decisions

The following architectural decisions have been accepted and represent the established architecture across Goalpost 1 and Goalpost 2 (M2.1–M2.3):

- **[ADR-0001: Geographic Coordinates, Projection, and Local World Coordinates](./ADR-0001-geographic-coordinates-and-local-projection.md)**  
  Local equirectangular metric projection centered at dataset origin $(0, 0, 0)$ with metric axes (+X East, +Y Up, +Z South).

- **[ADR-0002: Boundary-Derived Road Junction Polygon Synthesis and Coplanar Overlap Resolution](./ADR-0002-boundary-derived-road-junction-meshing.md)**  
  Elimination of road intersection z-fighting via true polyline arc-length trimming and synthesized coplanar junction polygons at uniform baseline `0.050 m`.

- **[ADR-0003: Loaded Region Boundary Clipping and Bounded Scene Sizing](./ADR-0003-loaded-region-boundary-clipping.md)**  
  Strict metric bounding box clipping using Liang-Barsky line clipping and a topology-aware convex decomposition polygon fallback for concave and holed shapes.

- **[ADR-0004: Grade-Separated Infrastructure, Elevation Policy, and Bridge/Culvert Disambiguation](./ADR-0004-grade-separated-infrastructure-and-elevation-policy.md)**  
  Physical clearance for bridges (`+2.850 m`) and tunnels (`-2.000 m`), approach ramp profiles ($\min(12\text{ m}, 30\%)$), abutment headwalls, and strict culvert disambiguation.

- **[ADR-0005: Source-Feature Provenance Tracking and Diagnostic Accounting](./ADR-0005-source-feature-provenance-and-diagnostics.md)**  
  End-to-end feature identity preservation through merged buffer geometries via `faceRanges` binary search and exhaustive diagnostic metric counters.

- **[ADR-0006: GPU Resource Lifecycle and Deterministic Intermediate Geometry Disposal](./ADR-0006-gpu-resource-lifecycle-and-disposal.md)**  
  Centralized GPU allocation tracking via `SceneResourceManager` with immediate intermediate buffer disposal and single-pass idempotent scene cleanup.

- **[ADR-0007: Isometric Orthographic Camera Framing and Region Navigation](./ADR-0007-orthographic-camera-framing-and-navigation.md)**  
  Isometric orthographic camera math with projected bounds framing, 0.78 octagonal inscribed ratio, and dynamic frustum plane calculation.

- **[ADR-0008: Hybrid Railway Rendering, Multi-Interval Turnout Support, and UV-Ribbon Architecture](./ADR-0008-hybrid-railway-rendering-and-uv-ribbon-architecture.md)**  
  Hybrid railway rendering architecture combining close-zoom (`> 4.5 px/m`) 3D instanced sleepers and extruded steel rails with medium/far procedural `fwidth` UV-ribbons, multi-interval turnout/parallel sleeper clipping, and `128 m x 128 m` spatial chunking.

- **[ADR-0009: Infrastructure Graph Topology, Domain Contracts, and Simplification Architecture](./ADR-0009-infrastructure-graph-topology.md)**  
  OSMnx-referenced pure-TypeScript infrastructure topology graph (`RoadNetwork`, `RailwayNetwork`, `GradeTransitionRelation`, `RailwayFlatCrossingRelation`, `LevelCrossingRelation`, `GradeSeparatedCrossingRelation`), non-destructive pre-deduplication/pre-chaining `TopologySourceData` handoff, non-interstitial degree-2 simplification with per-segment provenance, and staged renderer integration plan.

- **[ADR-0010: Surface-First At-Grade Road Rendering (`E2+` / `roads: 'graph-surface'`)](./ADR-0010-surface-first-road-rendering.md)**  
  Selection of surface-first rounded 2D edge-stroke buffering and priority-ordered Boolean ownership subtraction (`SurfaceFirstRoadFootprints.ts`) as the preferred architectural direction for at-grade road rendering, superseding explicit boundary-derived junction polygon synthesis (`ADR-0002` / E2 `solveBoundaryDerivedJunctionNode`) as the target default strategy pending final validation.

