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

- **[ADR Template (ADR-TEMPLATE.md)](ADR-TEMPLATE.md)**

---

## Index of Architectural Decisions

These ADRs span historic Goalpost 1 decisions and current regional architecture. Original decisions are preserved; later ADRs may qualify their scope. For current implementation status see [../STATUS.md](../STATUS.md).

- **[ADR-0001: Geographic Coordinates, Projection, and Local World Coordinates](ADR-0001-geographic-coordinates-and-local-projection.md)**  
  Local/live equirectangular projection (+X East, +Y Up, +Z South); offline regional tiling uses UTM EPSG:25832 as recorded in ADR-0011.

- **[ADR-0002: Boundary-Derived Road Junction Polygon Synthesis and Coplanar Overlap Resolution](ADR-0002-boundary-derived-road-junction-meshing.md)**  
  Historical, superseded road strategy: trimmed roads and explicit junction polygons. Production roads use E2+ (ADR-0010).

- **[ADR-0003: Loaded Region Boundary Clipping and Bounded Scene Sizing](ADR-0003-loaded-region-boundary-clipping.md)**  
  Strict metric bounding box clipping using Liang-Barsky line clipping and a topology-aware convex decomposition polygon fallback for concave and holed shapes.

- **[ADR-0004: Grade-Separated Infrastructure, Elevation Policy, and Bridge/Culvert Disambiguation](ADR-0004-grade-separated-infrastructure-and-elevation-policy.md)**  
  Physical clearance for bridges (`+2.850 m`) and tunnels (`-2.000 m`), approach ramp profiles ($\min(12\text{ m}, 30\%)$), abutment headwalls, and strict culvert disambiguation.

- **[ADR-0005: Source-Feature Provenance Tracking and Diagnostic Accounting](ADR-0005-source-feature-provenance-and-diagnostics.md)**  
  End-to-end feature identity preservation through merged buffer geometries via `faceRanges` binary search and exhaustive diagnostic metric counters.

- **[ADR-0006: GPU Resource Lifecycle and Deterministic Intermediate Geometry Disposal](ADR-0006-gpu-resource-lifecycle-and-disposal.md)**  
  Centralized GPU allocation tracking via `SceneResourceManager` with immediate intermediate buffer disposal and single-pass idempotent scene cleanup.

- **[ADR-0007: Isometric Orthographic Camera Framing and Region Navigation](ADR-0007-orthographic-camera-framing-and-navigation.md)**  
  Isometric orthographic camera math with projected bounds framing, 0.78 octagonal inscribed ratio, and dynamic frustum plane calculation.

- **[ADR-0008: Hybrid Railway Rendering, Multi-Interval Turnout Support, and UV-Ribbon Architecture](ADR-0008-hybrid-railway-rendering-and-uv-ribbon-architecture.md)**  
  Hybrid railway rendering architecture combining close-zoom (`> 4.5 px/m`) 3D instanced sleepers and extruded steel rails with medium/far procedural `fwidth` UV-ribbons, multi-interval turnout/parallel sleeper clipping, and `128 m x 128 m` spatial chunking.

- **[ADR-0009: Infrastructure Graph Topology, Domain Contracts, and Simplification Architecture](ADR-0009-infrastructure-graph-topology.md)**  
  OSMnx-referenced pure-TypeScript infrastructure topology graph (`RoadNetwork`, `RailwayNetwork`, `GradeTransitionRelation`, `RailwayFlatCrossingRelation`, `LevelCrossingRelation`, `GradeSeparatedCrossingRelation`), non-destructive pre-deduplication/pre-chaining `TopologySourceData` handoff, non-interstitial degree-2 simplification with per-segment provenance, and staged renderer integration plan.

- **[ADR-0010: Surface-First At-Grade Road Rendering (`E2+` / `roads: 'graph-surface'`)](ADR-0010-surface-first-road-rendering.md)**  
  Selection and completed `TKT-026` production promotion (owner-approved 2026-11-19) of surface-first rounded 2D edge-stroke buffering and priority-ordered Boolean ownership subtraction (`SurfaceFirstRoadFootprints.ts`) as the sole production at-grade road renderer, retiring Legacy and E2 (`ADR-0002` / `solveBoundaryDerivedJunctionNode`).

- **[ADR-0011: Baked Geometry Tiles, Regional Projection, and Runtime Streaming](ADR-0011-baked-tiles-and-runtime-streaming.md)**  
  Accepted implemented LOD0 offline `OSMTILE1` packs, UTM regional alignment, tile decoding/eviction, themes and provenance; clarifies the separate local/live projection.

- **[ADR-0012: Bounded Offline Shards and Manifest-Based Regional Mosaics](ADR-0012-bounded-regional-mosaics.md)**  
  Accepted pilot 4 × 4 shards, manifest rebasing, resumable baking, default candidate, bounded SQLite handles; 120-shard full Twente remains pending validation.

- **[ADR-0013: Regional Orthographic Zoom-Out Safety Policy](ADR-0013-regional-camera-zoom-policy.md)**  
  Accepted LOD0 `minZoom=0.15` guard, validated developer overrides and explicit benchmark overview; not LOD1–LOD3.

- **[ADR-0014: Spatially Accelerated Instanced Feature Picking (Mesh-Local Flat Typed-Array BVH)](ADR-0014-spatially-accelerated-instanced-feature-picking.md)**  
  Decouples instanced feature picking (`O(log N + k)`) from rendering batch granularity via a mesh-local flat typed-array 3D AABB BVH with union LOD bounds, strict hierarchy visibility rejection, exact narrow-phase `Mesh.raycast`, and deterministic disposal (`TKT-038`).

- **[ADR-0015: Uniform-Viewport Hierarchical Tile Streaming (1,024 m / 2,048 m / 4,096 m)](ADR-0015-hierarchical-tile-streaming.md)**  
  Zoom-dependent uniform-viewport resolution selection with hysteresis deadbands, lightweight non-duplicating hierarchical mosaic descriptors, shared bounded SQLite LRU handle pooling, off-scene worker preparation, atomic frame-boundary swaps, bounded multi-resolution budgets with `deferred_budget` safeguards, and active-resolution-only picking parity (`TKT-041`; extended by `ADR-0016` and `ADR-0017` as accepted foundation).

- **[ADR-0016: Frame-Budgeted Streaming, Offscreen Incremental GPU Preparation, Deferred Disposal, and Transition Critical-Path Prioritization](ADR-0016-frame-budgeted-streaming-and-incremental-gpu-prep.md)**  
  `1,536 MiB` desktop CPU budget default, shared priority-ordered per-frame streaming scheduler (`StreamingWorkloadScheduler`), public-API offscreen 1×1 `WebGLRenderTarget` incremental GPU upload (`IncrementalGpuPreparer`), bounded deferred geometry disposal (`DeferredDisposalQueue`), time-based transition debouncing (`150 ms`), destination-over-preload fetch/worker priority, 7-stage transition critical-path attribution, and optional predictive pre-warming (`TKT-041-F1`; `combined_prewarm` validated on hardware as F1 reference).

- **[ADR-0017: Decoupled Multi-Stage Streaming Pipeline, Compressed Worker Transfer, Reserved Destination Fairness, and Latency-Aware Adaptive Prewarming](ADR-0017-decoupled-streaming-pipeline-and-adaptive-prewarm.md)**  
  Accepted foundation (`TKT-041-F2` closed 2026-11-27; `f2_combined` default). Decouples HTTP retrieval from worker decoding into 8 bounded pipeline stages with immediate HTTP slot release, single-owner byte transfer, and oversized-payload (`>160 MB`) forward-progress admission; adds reserved destination slots, dynamic reprioritization, tail-tile boost, running-worker-job retention, `?compressed=1` deflate transfer + concurrent worker `DecompressionStream('deflate')`, latency-aware adaptive prewarming, and Candidate A/B/C granularity study (further uniform full-detail optimization deferred pending dual-map exploration).

## Decision record status convention

An ADR may be accepted for one implemented scope while a broader application remains experimental. Keep historical decisions and dates intact. For a new execution path, cross-reference earlier decisions rather than incorrectly marking them globally superseded.

