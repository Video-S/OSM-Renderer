---
id: TKT-003
title: M2.3-A Infrastructure Graph Architecture, Source Audit, and Domain Contracts
type: docs
status: in_progress
priority: high
created: 2026-11-05
updated: 2026-11-05
---

# TKT-003: M2.3-A Infrastructure Graph Architecture, Source Audit, and Domain Contracts

## Summary
Complete **Stage A (`M2.3-A`)** of Milestone 2.3 (*Infrastructure Topology and Connectivity*): audit the existing road and railway ingestion/rendering codebase, author and refine the architectural proposal and TypeScript domain contracts in `ADR-0009`, define the 16-scenario automated test specification, and plan the incremental Stage B–E implementation sequence for project-owner review.

## Context
Goalpost 1, Milestone 2.1 (`TKT-002`), and Milestone 2.2 (`TKT-001`) are complete and closed. The project owner has approved starting **Milestone 2.3: Infrastructure Topology and Connectivity** in five deliberate stages:
- **Stage A (`M2.3-A`)**: Architecture, source audit, domain contracts, and implementation planning only *(authorized in this task)*.
- **Stage B (`M2.3-B`)**: Road network graph construction (`RoadNetworkBuilder`).
- **Stage C (`M2.3-C`)**: Independent railway network graph construction (`RailwayNetworkBuilder`).
- **Stage D (`M2.3-D`)**: Crossings and grade transitions (`CrossModalAnalyzer` + point crossing/switch metadata survival).
- **Stage E (`M2.3-E`)**: Renderer integration (`GeometryBuilder` junction trimming and portal transition consumption).

Stage A deliberately stops before writing application code or modifying tests so the project owner can review and approve the proposed `ADR-0009` contracts and recommended resolutions first.

## Observed behavior
Audit of the current codebase (`LocalGeoJsonProvider.ts`, `FeatureCatalogue.ts`, `TopologicalNodeIndex.ts`, `GeometryBuilder.ts`, `RailwayTopology.ts`, `RailwayGeometryBuilder.ts`, and `server.ts`) confirmed eight concrete source facts and associated architectural gaps for M2.3:
1. **Destructive Pre-Chaining of `mapData.roads` (`LocalGeoJsonProvider.ts`)**: `LocalGeoJsonProvider.parseGeoJson()` invokes `chainContiguousRoads(roads, diagnostics)` at line 1742 *before* returning `ProcessedMapData`. Because `chainContiguousRoads` mutates `RoadFeature` records in place (concatenating `points` and `nodeIds`, reversing `other.points` when matched backwards, and discarding `other.osmTags`), building a graph solely from `mapData.roads` cannot recover original unchained way parts, secondary way `osmTags`, or original per-way digitization directions.
2. **Per-Vertex OSM Node ID Loss on Live Overpass/XML & `MultiLineString`s**: `server.ts` (lines 159, 182) calls `osmtogeojson` with default options on Overpass JSON and OSM 0.6 XML responses, which omits way `nodes` / `<nd ref>` lists from GeoJSON `LineString` properties; and `LocalGeoJsonProvider.ts` (lines 1041, 1441) drops `rawOsmNodes` when `rawLines.length > 1`.
3. **Shared `topoNodeIndex` & Unprotected Level Crossings (`LocalGeoJsonProvider.ts`)**: `LocalGeoJsonProvider.ts` (line 871) shares a single `topoNodeIndex` across railways (line 1030) and roads (line 1480) on `partGradeScope = "${layer}|${isBridge}|${isTunnel}"`, coupling fallback node centroids/aliases within `0.15 m`. Meanwhile, `globalNodeDegree` in `chainContiguousRoads` (lines 2112–2119) iterates *only* over `roads` (not `railways`), so a degree-2 road node that is also a shared road/rail level crossing has `globalNodeDegree === 2` and gets chained straight through.
4. **Interior Splitting, P-Loops, and Node Prefixing (`GeometryBuilder.ts`)**: In `splitRoadsAtSharedInteriorNodes` (lines 907–987): (a) splitting occurs only within `tierScope` (`veh` vs. `path`); (b) `const uniqueInRoad = new Set(keys)` (line 946) counts a repeated vertex within a single-way P-loop only once (`nodeUsageCount === 1`), failing to split P-loops; and (c) line 942 stores `veh|osm_...` on `r.nodeIds` which line 2636 prefixes again as `veh_veh|osm_...` (an internal naming-consistency defect rather than a functional connectivity failure).
5. **Direction-Blind Road Chaining (`LocalGeoJsonProvider.ts`)**: `chainContiguousRoads` (line 2124) omits `oneway` from `groupKey` (contradicting `docs/data-pipeline-and-feature-support.md` Section 6) and reverses `other.points` regardless of `oneway` tags.
6. **Proximity-Based Grade Transitions & Undifferentiated Rail Crossings**: `RailwayTopology.ts` ignores `RailwayFeature.nodeIds` and does not distinguish `railway=switch` from non-interconnecting `railway=railway_crossing` flat diamond crossings. Bridge/tunnel approach detection in `GeometryBuilder.ts` (lines 2587–2613, 3595–3608) and `RailwayGeometryBuilder.ts` (lines 566–579) relies on `0.65 m` / `0.80 m` Euclidean distance checks across all endpoints.
7. **Point Crossing & Switch Features Skipped**: `FeatureCatalogue.ts` (lines 546, 841) classifies point features (`!isLine`) with `railway=switch`, `railway=railway_crossing`, `railway=level_crossing`, `railway=crossing`, or `highway=crossing` as `'unsupported'`, causing `LocalGeoJsonProvider.ts` to skip them.
8. **Boundary-Clipped Synthetic Endpoints**: `clipPolylineToBox` (`LocalGeoJsonProvider.ts` lines 208, 219) pushes `undefined` into `osmNodes` at Liang-Barsky boundary cut points without flagging them as boundary-clipped endpoints, allowing `topoNodeIndex` to snap unrelated ways cut within `0.15 m` of the same boundary edge.

## Expected behavior
A formal, source-verified architectural specification (`ADR-0009`, marked `Proposed`) defines:
- A minimal, non-destructive pre-chaining data handoff (`ProcessedMapData.topologySource: TopologySourceData`) preserving `UnchainedRoadPart[]`, `UnchainedRailwayPart[]`, `InfrastructurePointMetadata[]`, and `deduplicatedRoadMap` while keeping legacy `mapData.roads` unchanged during Stages B–D.
- Pure-TypeScript domain contracts (`InfrastructureGraph`, `RoadNetwork`, `RailwayNetwork`, `RoadNode`, `RoadEdge`, `RailwayNode`, `RailwayEdge`, `EdgeProvenance`, `GradeTransitionRelation`, `RailwayFlatCrossingRelation`, `LevelCrossingRelation`, `GradeSeparatedCrossingRelation`, `UnresolvedGradeTransitionCandidate`, `UnresolvedCrossingCandidate`, `TopologyDiagnostics`) under `src/world/infrastructure/topology/`.
- Explicit distinction between `railway=switch` (turnout with verified `1-to-2` throat and `TurnoutClassificationStatus`), `railway=railway_crossing` (non-interconnecting flat diamond crossing via `RailwayFlatCrossingRelation`), `railway=level_crossing` (`road_rail_level_crossing`), `railway=crossing` (`pedestrian_rail_crossing`), and `highway=crossing`.
- Non-exclusive node `roles` arrays, three-part node identity separation (`rawOsmNodeId`, canonical `id`, `nodeIdOrigin`), `incidentHalfEdges` vs. `incidentEdgeIds` degree invariants, verbatim `rawOnewayTag` + `normalizedOneway`, and unambiguous `reversedRelativeToSource` segment provenance.
- Conservative `0.15 m` fallback rules with signed `continuousTraversalDot` orientation and explicit diagnostic candidate states whenever evidence is ambiguous or insufficient.

## Acceptance criteria
- [x] Source audit completed across `TopologicalNodeIndex.ts`, `LocalGeoJsonProvider.ts`, `FeatureCatalogue.ts`, `GeometryBuilder.ts`, `RailwayTopology.ts`, `RailwayGeometryBuilder.ts`, `BridgeAndTunnelBuilder.ts`, `ElevationPolicy.ts`, `MapFeature.ts`, `JunctionAndTopology.test.ts`, and `RailwayRendering.test.ts`, separating confirmed source facts from architectural risks.
- [x] `docs/decisions/ADR-0009-infrastructure-graph-topology.md` authored and revised with status `Proposed`, specifying the non-destructive `TopologySourceData` handoff, railway crossing/switch semantics, tightened grade-transition/crossing inference, clarified node/edge/provenance contracts, 16-test specification (`tsx --test`), and recommended resolutions for owner sign-off.
- [x] `tickets/TKT-003-m2-3-infrastructure-graph-architecture.md` created and maintained in sync with `ADR-0009`.
- [x] `docs/STATUS.md`, `GEMINI.md`, `docs/README.md`, and `docs/decisions/README.md` updated accurately while preserving the recorded 2026-11-04 verification results (`92 / 92 passed`).
- [x] Zero application source files (`src/**`), test files (`src/**/*.test.ts`), generated API docs (`docs/api-reference/**`), benchmark artifacts, or closed tickets (`TKT-001`, `TKT-002`) modified during Stage A.
- [ ] Project owner reviews and approves `ADR-0009` (and signs off on the recommended resolutions) to close `TKT-003` and authorize Stage B (`M2.3-B`).

## Implementation notes
- **Ticket Status**: Remains `in_progress` pending project-owner approval of `ADR-0009`.
- **Planned Stage B–E Sequence**:
  1. **Stage B (`M2.3-B` — Road Network Graph)**: Populate non-destructive `ProcessedMapData.topologySource` in `LocalGeoJsonProvider.ts` (preserving legacy `mapData.roads` via cloned objects), enrich per-vertex OSM node IDs where aligned, implement `src/world/infrastructure/topology/types.ts` and `RoadNetworkBuilder.ts`, and verify road topology tests `T-01` through `T-10` via `npm test` (`tsx --test`).
  2. **Stage C (`M2.3-C` — Railway Network Graph)**: Implement `RailwayNetworkBuilder.ts` (independent railway graph, `railway=switch` `1-to-2` throat/branch classification with `TurnoutClassificationStatus`, `railway=railway_crossing` non-interconnecting `RailwayFlatCrossingRelation`, parallel passing loops) and verify tests `T-11` and `T-12`.
  3. **Stage D (`M2.3-D` — Crossings & Grade Transitions)**: Preserve point infrastructure metadata (`railway=switch`, `railway=railway_crossing`, `railway=level_crossing`, `railway=crossing`, `highway=crossing`) during ingestion, implement `CrossModalAnalyzer.ts` and `InfrastructureGraph.ts` (`GradeTransitionRelation`, `LevelCrossingRelation`, `GradeSeparatedCrossingRelation`, plus `UnresolvedGradeTransitionCandidate` and `UnresolvedCrossingCandidate` diagnostics), and verify tests `T-13` through `T-15`.
  4. **Stage E (`M2.3-E` — Renderer Integration & Benchmarking)**: Wire `GeometryBuilder.ts` road junction trimming and bridge/tunnel portal detection to consume `InfrastructureGraph`, verify `T-16` non-regression, record reproducible graph-construction benchmarks on synthetic and real OSM extracts (`Station Hengelo`, `Amsterdam Centraal`), and run `npm test`, `npm run lint`, `npm run build`, and `npm run docs:api`.

## Verification
- Status: Unverified (Documentation & Architecture Stage A only — no application code or test files were modified, so automated test/build commands were not required or executed for this stage per `GEMINI.md` Section 4).
- Verification steps (to be executed in Stages B–E when code changes occur):
  - `npm test` (`tsx --test`)
  - `npm run lint` (`tsc --noEmit`)
  - `npm run build` (`vite build`)
  - `npm run docs:api` (`typedoc`)

## Related files and documentation
- Source (audited, unchanged): `src/world/TopologicalNodeIndex.ts`, `src/world/LocalGeoJsonProvider.ts`, `src/world/FeatureCatalogue.ts`, `src/world/GeometryBuilder.ts`, `src/world/infrastructure/railways/RailwayTopology.ts`, `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`, `src/world/BridgeAndTunnelBuilder.ts`, `src/world/ElevationPolicy.ts`, `src/types/MapFeature.ts`, `server.ts`
- Tests (audited, unchanged): `src/world/JunctionAndTopology.test.ts`, `src/world/RailwayRendering.test.ts`
- Documentation: `docs/decisions/ADR-0009-infrastructure-graph-topology.md`, `docs/decisions/README.md`, `docs/STATUS.md`, `docs/README.md`, `GEMINI.md`
