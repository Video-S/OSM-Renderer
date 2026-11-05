---
id: TKT-006
title: M2.3-D Cross-Modal Connectivity, Level Crossings, Grade Transitions, and InfrastructureGraph Orchestration
type: feature
status: in_progress
priority: high
created: 2026-11-05
updated: 2026-11-05
---

# TKT-006: M2.3-D Cross-Modal Connectivity, Level Crossings, Grade Transitions, and InfrastructureGraph Orchestration

## Summary
Implement **Stage D (`M2.3-D`)** of Milestone 2.3 (*Infrastructure Topology and Connectivity*) per accepted **[ADR-0009](../docs/decisions/ADR-0009-infrastructure-graph-topology.md)**: complete point-level infrastructure ingestion (`railway=level_crossing`, `railway=crossing`, `highway=crossing` alongside `railway=switch` and `railway=railway_crossing`), implement `CrossModalAnalyzer` (`src/world/infrastructure/topology/CrossModalAnalyzer.ts`) and top-level `buildInfrastructureGraph` orchestration (`src/world/infrastructure/topology/InfrastructureGraph.ts`) for confirmed vs. unresolved road/rail level crossings (`LevelCrossingRelation`), same-domain road and railway grade transitions (`GradeTransitionRelation`), grade-separated overpasses/underpasses (`GradeSeparatedCrossingRelation`), and crossing-node preservation across degree-2 simplification, verified via `src/world/CrossModalTopology.test.ts`.

## Context
Following project-owner acceptance of `M2.3-C` (`TKT-005` closed with `126 / 126` passing tests), `M2.3-D` is authorized to complete cross-modal topology and grade-transition analysis and expose `buildInfrastructureGraph(input)` without modifying `GeometryBuilder.ts`, `RailwayGeometryBuilder.ts`, `RailwayTopology.ts`, or implementing Stage E (renderer integration).

## Observed behavior
Prior to Stage D:
1. `ProcessedMapData.topologySource.infrastructurePoints` only captures `railway=switch` and `railway=railway_crossing`, omitting `railway=level_crossing`, `railway=crossing`, and `highway=crossing`.
2. No `CrossModalAnalyzer` exists to derive `LevelCrossingRelation`, `GradeTransitionRelation`, `GradeSeparatedCrossingRelation`, `UnresolvedCrossingCandidate` (cross-modal / same-domain unshared crossings), or `UnresolvedGradeTransitionCandidate`.
3. `InfrastructureGraph.ts` only re-exports types and Stage B/C builders without a top-level `buildInfrastructureGraph` orchestrator that protects confirmed crossing/grade-transition nodes during simplification and aggregates `TopologyDiagnostics`.

## Expected behavior
1. **Complete Point-Level Infrastructure Ingestion (`LocalGeoJsonProvider.ts`)**:
   - Capture all five `InfrastructurePointKind` categories in `ProcessedMapData.topologySource.infrastructurePoints`:
     - `railway=switch` $\to$ `'railway_switch'`
     - `railway=railway_crossing` $\to$ `'railway_crossing_flat'`
     - `railway=level_crossing` $\to$ `'railway_level_crossing'`
     - `railway=crossing` $\to$ `'railway_ped_crossing'`
     - `highway=crossing` $\to$ `'highway_crossing'`
   - Preserve original source ID, `hasExplicitSourceId`, verified `rawOsmNodeId` (never promoting synthetic `feat-*` IDs to `rawOsmNodeId`), local metric coordinates, point category, and cloned `osmTags` (including `crossing=*`, `crossing:markings=*`, layer/bridge/tunnel tags) with bounding-box filtering and zero impact on `mapData.roads`, `mapData.railways`, `mapData.landmarks`, or legacy `diagnostics`.
2. **`CrossModalAnalyzer` (`src/world/infrastructure/topology/CrossModalAnalyzer.ts`)**:
   - Pure, spatially indexed analyzer producing `LevelCrossingRelation[]`, `GradeTransitionRelation[]`, `GradeSeparatedCrossingRelation[]`, `UnresolvedCrossingCandidate[]`, `UnresolvedGradeTransitionCandidate[]`, and `UnresolvedInfrastructurePointCandidate[]` without mutating inputs or merging road and railway networks.
3. **Level Crossings & Crossing-Node Preservation (`ADR-0009` Section 6.2 & `T-13`)**:
   - Confirm `LevelCrossingRelation` only when at-grade road and railway edges share the same vertical scope (`layer`, `!isBridge`, `!isTunnel`) and either share a verified explicit `rawOsmNodeId` (`confidence: 'shared_explicit_osm_node'`, upgraded to `'explicit_osm_crossing_tag'` when a matching point tag is present) or match an explicit `railway=level_crossing` / `railway=crossing` point within `0.15 m` (`confidence: 'explicit_osm_crossing_tag'`).
   - Distinguish `road_rail_level_crossing` (`vehicular` road + `railway=level_crossing` or untagged shared node) from `pedestrian_rail_crossing` (`path` road + `railway=crossing` or untagged shared node), and reject material point-tag vs. road-tier conflicts (`railway=level_crossing` on a footpath or `railway=crossing` on a vehicular road) as unresolved diagnostics.
   - Preserve `highway=crossing` on `RoadNode` (`roles` includes `'highway_crossing'`, `pointOsmTags` preserved) without creating a rail crossing.
   - Protect confirmed crossing nodes against degree-2 contraction so `RoadNode` and `RailwayNode` retain `'level_crossing'` (or `'highway_crossing'`) roles and exact arc-length offsets.
   - Emit `UnresolvedCrossingCandidate` (`'coincident_vertex_without_osm_id'` or `'geometric_intersection_without_shared_node'`) for unconfirmed 2D at-grade intersections or coordinate-only coincidences.
4. **Grade-Transition Inference (`ADR-0009` Section 6.1 & `T-15`)**:
   - Evaluate `continuousTraversalDot = -dot(atGradeInwardTangent, structureInwardTangent)` for both `road` and `railway` domains.
   - Confirm Tier 1 (`confidence: 'explicit_osm_node'`) when endpoints share a verified `rawOsmNodeId`, compatible tier/class, valid at-grade $\leftrightarrow$ bridge/tunnel boundary, `continuousTraversalDot >= cos(60°) = 0.5`, and lead over any runner-up $\ge 0.10$.
   - Confirm Tier 2 (`confidence: 'coordinate_fallback_confirmed'`) only when at least one endpoint lacks `rawOsmNodeId`, distance $\le 0.15\text{ m}$, neither endpoint is boundary-clipped, both endpoints have `degree === 1`, tier/class is compatible, `continuousTraversalDot >= cos(30°) \approx 0.866`, and the candidate is unique within `0.15 m`.
   - Record rejected or ambiguous portals within the `0.80 m` diagnostic horizon in `UnresolvedGradeTransitionCandidate` (`'ambiguous_multiple_candidates'`, `'misaligned_tangent'`, `'non_terminal_endpoint'`, `'incompatible_class_or_tier'`, `'distinct_explicit_osm_nodes'`, `'exceeds_snap_tolerance'`).
5. **Grade-Separated Crossings (`ADR-0009` `T-14`)**:
   - Emit `GradeSeparatedCrossingRelation` for 2D planimetric crossings (road/rail, road/road, rail/rail) with reliable vertical separation (`bridge`, `tunnel`, or distinct `layer`), recording `upperNetwork`, `upperEdgeId`, `upperLayer`, `upperIsBridge`, `lowerNetwork`, `lowerEdgeId`, `lowerLayer`, `lowerIsTunnel`, and world `position`.
   - Never fabricate vertical ordering when two edges share identical vertical scope or have contradictory vertical tags without layer separation.
6. **Top-Level `buildInfrastructureGraph` Orchestration (`src/world/infrastructure/topology/InfrastructureGraph.ts`)**:
   - Orchestrate road and railway graph construction (protecting confirmed crossing/portal nodes prior to simplification), preserve Stage C `railwayFlatCrossings`, run `CrossModalAnalyzer`, annotate node roles (`'level_crossing'`, `'highway_crossing'`, `'grade_transition'`), and aggregate deterministic `TopologyDiagnostics`.

## Acceptance criteria
- [x] `LocalGeoJsonProvider.parseGeoJson()` captures all 5 `InfrastructurePointKind` categories (`railway_switch`, `railway_crossing_flat`, `railway_level_crossing`, `railway_ped_crossing`, `highway_crossing`) in `ProcessedMapData.topologySource.infrastructurePoints` without altering legacy `mapData.roads`, `mapData.railways`, `mapData.landmarks`, `diagnostics`, or rendered 3D scene geometry.
- [x] `CrossModalAnalyzer.ts` and `buildInfrastructureGraph` (`InfrastructureGraph.ts`) implemented in pure TypeScript with spatial indexing, deterministic IDs/ordering, and zero input mutation.
- [x] Confirmed vs. unresolved level crossings (`T-13`), grade-separated crossings (`T-14`), and road/railway grade transitions (`T-15`) implemented per `ADR-0009` Sections 6.1 and 6.2, including protection of crossing nodes against degree-2 simplification and `highway=crossing` role preservation (`T-03`).
- [x] Comprehensive automated test suite (`src/world/CrossModalTopology.test.ts`) passing via `npm test`, covering `T-03`, `T-04`, `T-13`, `T-14`, `T-15`, `T-17`, all 5 infrastructure point categories, MultiLineString/clipping provenance, Stage C flat-diamond non-interchange preservation, diagnostic aggregation, determinism, immutability, and `GeometryBuilder` mesh-buffer invariance.
- [x] Reproducible performance benchmark recorded on synthetic and real Station Hengelo / Amsterdam Centraal OSM extracts (`parseGeoJson`, road graph, railway graph, cross-modal/grade-transition analysis, and total `buildInfrastructureGraph` time).
- [x] `npm test`, `npm run lint`, `npm run build`, and `npm run docs:api` executed and passing with zero errors.
- [ ] Project owner reviews Stage D implementation to close `TKT-006`.

## Implementation notes
- Stage D strictly excludes Stage E (`GeometryBuilder.ts`, `RailwayGeometryBuilder.ts`, `RailwayTopology.ts` renderer integration).
- `TKT-006` remains `in_progress` pending project-owner review and acceptance.

## Verification
- Status: Implemented and verified (`134 / 134` tests passing); `in_progress` pending project-owner review.
- Verification steps:
  - `npm test` — `134 / 134 passed` (`0` failures), including `8 / 8` in `src/world/CrossModalTopology.test.ts`.
  - `npm run lint` (`tsc --noEmit`) — `0` errors.
  - `npm run build` (`vite build`) — clean production build (`dist/`).
  - `npm run docs:api` (`typedoc`) — generated API documentation (`docs/api-reference/`).
- Recorded Stage D Performance Benchmarks:
  - **Station Hengelo Real OSM Extract**: `parseGeoJson = 4.02 ms`, `buildRoadNetwork = 0.02 ms`, `buildRailwayNetwork = 10.35 ms`, `analyzeCrossModal = 2.71 ms`, total `buildInfrastructureGraph = 9.90 ms` (`railNodes: 48`, `railEdges: 62`, `railwayConfirmedSwitchCount: 23`, `railwayFlatCrossingCount: 3`, `unresolvedCrossings: 9`, `unresolvedInfrastructurePoints: 1`).
  - **Amsterdam Centraal Real OSM Extract**: `parseGeoJson = 17.68 ms`, `buildRoadNetwork = 0.71 ms`, `buildRailwayNetwork = 78.51 ms`, `analyzeCrossModal = 12.35 ms`, total `buildInfrastructureGraph = 71.93 ms` (`roadNodes: 6`, `roadEdges: 3`, `railNodes: 331`, `railEdges: 314`, `gradeTransitionCount: 70`, `gradeSeparatedCrossingCount: 114`, `unresolvedCrossings: 31`, `unresolvedInfrastructurePoints: 31`).
  - **Synthetic Cross-Modal Dataset (`60` roads $\times$ `20` railways)**: `buildRoadNetwork = 2.89 ms`, `buildRailwayNetwork = 1.30 ms`, `analyzeCrossModal = 32.93 ms`, total `buildInfrastructureGraph = 29.32 ms` (`levelCrossingCount: 1`, `gradeSeparatedCrossingCount: 400`).

## Related files and documentation
- Source: `src/world/infrastructure/topology/types.ts`, `src/world/infrastructure/topology/CrossModalAnalyzer.ts`, `src/world/infrastructure/topology/InfrastructureGraph.ts`, `src/world/infrastructure/topology/RoadNetworkBuilder.ts`, `src/world/infrastructure/topology/RailwayNetworkBuilder.ts`, `src/world/LocalGeoJsonProvider.ts`
- Tests: `src/world/CrossModalTopology.test.ts`
- Documentation: `docs/decisions/ADR-0009-infrastructure-graph-topology.md`, `docs/STATUS.md`, `docs/architecture.md`, `docs/data-pipeline-and-feature-support.md`, `docs/testing-and-diagnostics.md`
