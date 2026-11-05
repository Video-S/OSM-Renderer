---
id: TKT-003
title: M2.3-A Infrastructure Graph Architecture, Source Audit, and Domain Contracts
type: docs
status: closed
priority: high
created: 2026-11-05
updated: 2026-11-05
---

# TKT-003: M2.3-A Infrastructure Graph Architecture, Source Audit, and Domain Contracts

## Summary
Complete **Stage A (`M2.3-A`)** of Milestone 2.3 (*Infrastructure Topology and Connectivity*): audit the existing road and railway ingestion/rendering codebase, author and refine the architectural proposal and TypeScript domain contracts in `ADR-0009`, define the 17-scenario automated test specification, and plan the incremental Stage B–E implementation sequence for project-owner review.

## Context
Goalpost 1, Milestone 2.1 (`TKT-002`), and Milestone 2.2 (`TKT-001`) are complete and closed. The project owner has approved starting **Milestone 2.3: Infrastructure Topology and Connectivity** in five deliberate stages:
- **Stage A (`M2.3-A`)**: Architecture, source audit, domain contracts, and implementation planning only *(completed and approved)*.
- **Stage B (`M2.3-B`)**: Road network graph construction (`RoadNetworkBuilder`).
- **Stage C (`M2.3-C`)**: Independent railway network graph construction (`RailwayNetworkBuilder`).
- **Stage D (`M2.3-D`)**: Crossings and grade transitions (`CrossModalAnalyzer` + point crossing/switch metadata survival).
- **Stage E (`M2.3-E`)**: Renderer integration (`GeometryBuilder` junction trimming and portal transition consumption).

Stage A deliberately stopped before writing application code or modifying tests so the project owner could review and approve the `ADR-0009` contracts and recommended resolutions first.

## Observed behavior
Audit of the current codebase (`LocalGeoJsonProvider.ts`, `FeatureCatalogue.ts`, `TopologicalNodeIndex.ts`, `GeometryBuilder.ts`, `RailwayTopology.ts`, `RailwayGeometryBuilder.ts`, and `server.ts`) confirmed eight concrete source facts and associated architectural gaps for M2.3:
1. **Heuristic Deduplication & Destructive Pre-Chaining of `mapData.roads` (`LocalGeoJsonProvider.ts`)**: `LocalGeoJsonProvider.parseGeoJson()` first filters road parts through `seenRoadSegments` (lines 1487–1515), which hashes rounded `0.5 m` endpoints, averaged vertex coordinates, `0.5 m` total length, `partGradeScope`, and `roadClass` (a coarse heuristic that can drop distinct geometries sharing the same endpoints, average vertex centroid, and length). It then invokes `chainContiguousRoads(roads, diagnostics)` at line 1742 *before* returning `ProcessedMapData`, mutating `RoadFeature` records in place (concatenating `points` and `nodeIds`, reversing `other.points` when matched backwards, and discarding `other.osmTags`). Additionally, features lacking an explicit ID (`f.id`, `props.id`, `props['@id']`) receive an index-dependent fallback ID `feat-${featureIndex}` at line 883.
2. **Per-Vertex OSM Node ID Loss on Live Overpass/XML & `MultiLineString`s**: `server.ts` (lines 159, 182) calls `osmtogeojson` with default options on Overpass JSON and OSM 0.6 XML responses, which omits way `nodes` / `<nd ref>` lists from GeoJSON `LineString` properties; and `LocalGeoJsonProvider.ts` (lines 1041, 1441) drops `rawOsmNodes` when `rawLines.length > 1`.
3. **Shared `topoNodeIndex` & Unprotected Level Crossings (`LocalGeoJsonProvider.ts`)**: `LocalGeoJsonProvider.ts` (line 871) shares a single `topoNodeIndex` across railways (line 1030) and roads (line 1480) on `partGradeScope = "${layer}|${isBridge}|${isTunnel}"`, coupling fallback node centroids/aliases within `0.15 m`. Meanwhile, `globalNodeDegree` in `chainContiguousRoads` (lines 2112–2119) iterates *only* over `roads` (not `railways`), so a degree-2 road node that is also a shared road/rail level crossing has `globalNodeDegree === 2` and gets chained straight through.
4. **Interior Splitting, P-Loops, and Node Prefixing (`GeometryBuilder.ts`)**: In `splitRoadsAtSharedInteriorNodes` (lines 907–987): (a) splitting occurs only within `tierScope` (`veh` vs. `path`); (b) `const uniqueInRoad = new Set(keys)` (line 946) counts a repeated vertex within a single-way P-loop only once (`nodeUsageCount === 1`), failing to split P-loops; and (c) line 942 stores `veh|osm_...` on `r.nodeIds` which line 2636 prefixes again as `veh_veh|osm_...` (an internal naming-consistency defect rather than a functional connectivity failure).
5. **Direction-Blind Road Chaining (`LocalGeoJsonProvider.ts`)**: `chainContiguousRoads` (line 2124) omits `oneway` from `groupKey` (contradicting `docs/data-pipeline-and-feature-support.md` Section 6) and reverses `other.points` regardless of `oneway` tags.
6. **Proximity-Based Grade Transitions & Undifferentiated Rail Crossings**: `RailwayTopology.ts` ignores `RailwayFeature.nodeIds` and does not distinguish `railway=switch` from non-interconnecting `railway=railway_crossing` flat diamond crossings. Bridge/tunnel approach detection in `GeometryBuilder.ts` (lines 2587–2613, 3595–3608) and `RailwayGeometryBuilder.ts` (lines 566–579) relies on `0.65 m` / `0.80 m` Euclidean distance checks across all endpoints.
7. **Point Crossing & Switch Features Skipped**: `FeatureCatalogue.ts` (lines 546, 841) classifies point features (`!isLine`) with `railway=switch`, `railway=railway_crossing`, `railway=level_crossing`, `railway=crossing`, or `highway=crossing` as `'unsupported'`, causing `LocalGeoJsonProvider.ts` to skip them.
8. **Boundary-Clipped Synthetic Endpoints**: `clipPolylineToBox` (`LocalGeoJsonProvider.ts` lines 208, 219) pushes `undefined` into `osmNodes` at Liang-Barsky boundary cut points without flagging them as boundary-clipped endpoints, allowing `topoNodeIndex` to snap unrelated ways cut within `0.15 m` of the same boundary edge.

## Expected behavior
A formal, source-verified architectural specification (`ADR-0009`, `Accepted`) defines:
- A minimal, non-destructive data handoff (`ProcessedMapData.topologySource: TopologySourceData`) capturing `UnchainedRoadPart[]` **before heuristic `seenRoadSegments` deduplication and before `chainContiguousRoads`** (alongside `UnchainedRailwayPart[]` and `InfrastructurePointMetadata[]`), while keeping the legacy `mapData.roads` pipeline unchanged during Stages B–D.
- Strict geometric (`<= 1 mm` at every vertex, matching vertex count and non-conflicting `rawOsmNodeIds`) and semantic equality rules for exact duplicate detection inside the graph builder so distinct parallel or S-curved ways sharing approximate endpoint/centroid/length keys are never dropped.
- Qualified input-order determinism: graph structure, node coordinates, edge geometries, and `parallelIndex` ordering are invariant across input permutations for all inputs, while full stability of `sourceFeatureId`-derived string identifiers holds when input features carry explicit IDs (`hasExplicitSourceId: true`, as opposed to `feat-${featureIndex}`).
- Pure-TypeScript domain contracts (`InfrastructureGraph`, `RoadNetwork`, `RailwayNetwork`, `RoadNode`, `RoadEdge`, `RailwayNode`, `RailwayEdge`, `EdgeProvenance`, `GradeTransitionRelation`, `RailwayFlatCrossingRelation`, `LevelCrossingRelation`, `GradeSeparatedCrossingRelation`, `UnresolvedGradeTransitionCandidate`, `UnresolvedCrossingCandidate`, `TopologyDiagnostics`) under `src/world/infrastructure/topology/`.
- Explicit distinction between `railway=switch` (turnout with verified `1-to-2` throat and `TurnoutClassificationStatus`), `railway=railway_crossing` (non-interconnecting flat diamond crossing via `RailwayFlatCrossingRelation`), `railway=level_crossing` (`road_rail_level_crossing`), `railway=crossing` (`pedestrian_rail_crossing`), and `highway=crossing`.
- Non-exclusive node `roles` arrays, three-part node identity separation (`rawOsmNodeId`, canonical `id`, `nodeIdOrigin`), `incidentHalfEdges` vs. `incidentEdgeIds` degree invariants, verbatim `rawOnewayTag` + `normalizedOneway`, and unambiguous `reversedRelativeToSource` segment provenance.
- Conservative `0.15 m` fallback rules with signed `continuousTraversalDot` orientation and explicit diagnostic candidate states whenever evidence is ambiguous or insufficient.

## Acceptance criteria
- [x] Source audit completed across `TopologicalNodeIndex.ts`, `LocalGeoJsonProvider.ts`, `FeatureCatalogue.ts`, `GeometryBuilder.ts`, `RailwayTopology.ts`, `RailwayGeometryBuilder.ts`, `BridgeAndTunnelBuilder.ts`, `ElevationPolicy.ts`, `MapFeature.ts`, `JunctionAndTopology.test.ts`, and `RailwayRendering.test.ts`, separating confirmed source facts from architectural risks.
- [x] `docs/decisions/ADR-0009-infrastructure-graph-topology.md` authored, revised, and accepted (`Status: Accepted`), specifying the pre-deduplication/pre-chaining `TopologySourceData` handoff, strict duplicate detection, qualified input-order determinism, railway crossing/switch semantics, tightened grade-transition/crossing inference, clarified node/edge/provenance contracts, 17-test specification (`tsx --test`), and accepted resolutions.
- [x] `tickets/TKT-003-m2-3-infrastructure-graph-architecture.md` created and maintained in sync with `ADR-0009`.
- [x] `docs/STATUS.md`, `GEMINI.md`, `docs/README.md`, and `docs/decisions/README.md` updated accurately while preserving the recorded 2026-11-04 verification results (`92 / 92 passed`).
- [x] Zero application source files (`src/**`), test files (`src/**/*.test.ts`), generated API docs (`docs/api-reference/**`), benchmark artifacts, or closed tickets (`TKT-001`, `TKT-002`) modified during Stage A.
- [x] Project owner reviewed and approved `ADR-0009` (including the three recommended resolutions) on 2026-11-05, closing `TKT-003` and authorizing Stage B (`M2.3-B` / `TKT-004`).

## Implementation notes
- **Ticket Status**: `closed` — Project owner reviewed and approved the `ADR-0009` architecture and all three recommended resolutions on 2026-11-05. Stage B (`M2.3-B`) is tracked separately in `tickets/TKT-004-m2-3-b-road-network-graph.md`.

## Verification
- Status: Verified by Project-Owner Architectural Review (2026-11-05).
- Notes: Stage A (`TKT-003`) was strictly an architecture, source-audit, and documentation task with zero application code or test changes; per `GEMINI.md` Section 4 and `docs/ticket-workflow.md` Section 4.A.5, no automated test or build commands were required or executed during Stage A.

## Related files and documentation
- Source (audited, unchanged in Stage A): `src/world/TopologicalNodeIndex.ts`, `src/world/LocalGeoJsonProvider.ts`, `src/world/FeatureCatalogue.ts`, `src/world/GeometryBuilder.ts`, `src/world/infrastructure/railways/RailwayTopology.ts`, `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`, `src/world/BridgeAndTunnelBuilder.ts`, `src/world/ElevationPolicy.ts`, `src/types/MapFeature.ts`, `server.ts`
- Tests (audited, unchanged in Stage A): `src/world/JunctionAndTopology.test.ts`, `src/world/RailwayRendering.test.ts`
- Documentation: `docs/decisions/ADR-0009-infrastructure-graph-topology.md`, `docs/decisions/README.md`, `docs/STATUS.md`, `docs/README.md`, `GEMINI.md`
