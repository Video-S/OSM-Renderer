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
Complete **Stage A (`M2.3-A`)** of Milestone 2.3 (*Infrastructure Topology and Connectivity*): audit the existing road and railway ingestion/rendering codebase, author the architectural proposal and TypeScript domain contracts in `ADR-0009`, define the 16-scenario automated test specification, and plan the incremental Stage B–E implementation sequence for project-owner review.

## Context
Goalpost 1, Milestone 2.1 (`TKT-002`), and Milestone 2.2 (`TKT-001`) are complete and closed. The project owner has approved starting **Milestone 2.3: Infrastructure Topology and Connectivity** in five deliberate stages:
- **Stage A (`M2.3-A`)**: Architecture, source audit, domain contracts, and implementation planning only *(authorized in this task)*.
- **Stage B (`M2.3-B`)**: Road network graph construction (`RoadNetworkBuilder`).
- **Stage C (`M2.3-C`)**: Independent railway network graph construction (`RailwayNetworkBuilder`).
- **Stage D (`M2.3-D`)**: Crossings and grade transitions (`CrossModalAnalyzer` + point crossing/switch metadata survival).
- **Stage E (`M2.3-E`)**: Renderer integration (`GeometryBuilder` junction trimming and portal transition consumption).

Stage A deliberately stops before writing application code or modifying tests so the project owner can review and approve the proposed `ADR-0009` contracts and open architectural questions first.

## Observed behavior
Audit of the current codebase (`LocalGeoJsonProvider.ts`, `FeatureCatalogue.ts`, `TopologicalNodeIndex.ts`, `GeometryBuilder.ts`, `RailwayTopology.ts`, `RailwayGeometryBuilder.ts`, and `server.ts`) revealed seven concrete architectural gaps that must be addressed across Stages B–E:
1. **Per-Vertex OSM Node ID Loss on Live Overpass & MultiLineStrings**: `server.ts` invokes `osmtogeojson(overpassJson)` with default options, which does not attach way `nodes` arrays to GeoJSON `LineString` properties; and `LocalGeoJsonProvider.ts` (lines 1041, 1441) drops `rawOsmNodes` when `rawLines.length > 1`.
2. **Cross-Domain Contamination in Shared `TopologicalNodeIndex`**: `LocalGeoJsonProvider.ts` uses a single `topoNodeIndex` across both railways and roads with `partGradeScope = "${layer}|${isBridge}|${isTunnel}"`, causing shared road/rail level-crossing nodes to inflate `globalNodeDegree` during road chaining.
3. **Double-Scoping & Self-Loop Splitting Bugs in `GeometryBuilder.ts`**: `splitRoadsAtSharedInteriorNodes` (lines 907–987) only splits within `tierScope` (`veh` vs. `path`), uses `new Set(keys)` (line 946) which fails to split self-intersecting P-loops (`nodeUsageCount === 1`), and double-prefixes `veh_veh|osm_...` in line 2636.
4. **Premature, Direction-Blind Road Chaining**: `chainContiguousRoads` in `LocalGeoJsonProvider.ts` (lines 2084–2276) runs before interior junction splitting, depends on greedy array order, omits `oneway` from `groupKey` (contradicting `docs/data-pipeline-and-feature-support.md`), reverses opposite ways regardless of `oneway` tags, and discards secondary way `osmTags`.
5. **Ad-Hoc Railway & Grade-Transition Proximity Scans**: `RailwayTopology.ts` ignores `RailwayFeature.nodeIds`, and bridge/tunnel approach detection in `GeometryBuilder.ts` (lines 2587–2613, 3595–3608) and `RailwayGeometryBuilder.ts` (lines 566–579) relies on raw `0.65 m` / `0.80 m` Euclidean distance checks that can be falsely triggered by unrelated nearby paths or cross-streets.
6. **Point Crossing & Switch Features Discarded**: `FeatureCatalogue.ts` (lines 546, 841) classifies point features (`!isLine`) with `railway=level_crossing`, `railway=crossing`, `railway=switch`, or `highway=crossing` as `'unsupported'`, causing `LocalGeoJsonProvider.ts` to skip them completely.
7. **Boundary-Clipped Synthetic Endpoints**: `clipPolylineToBox` (`LocalGeoJsonProvider.ts` lines 208, 219) pushes `undefined` into `osmNodes` at Liang-Barsky boundary cut points, allowing `topoNodeIndex` to snap unrelated ways cut within `0.15 m` of the same boundary corner into a false junction.

## Expected behavior
A formal, source-verified architectural specification (`ADR-0009`, marked `Proposed`) defines:
- Pure-TypeScript domain contracts (`InfrastructureGraph`, `RoadNetwork`, `RailwayNetwork`, `RoadNode`, `RoadEdge`, `RailwayNode`, `RailwayEdge`, `EdgeProvenance`, `GradeTransitionRelation`, `LevelCrossingRelation`, `GradeSeparatedCrossingRelation`, `TopologyDiagnostics`) under `src/world/infrastructure/topology/`.
- OSMnx-referenced graph construction and degree-2 simplification rules preserving intermediate curve geometry, parallel multi-edges, one-way/attribute discontinuities, P-loops, boundary-clip endpoint isolation, and per-segment source feature provenance.
- Clear distinction between 2D geometric crossing, physical/topological connectivity, and traversability metadata.
- A 16-scenario deterministic automated test matrix and a staged implementation plan (Stages B–E) that preserves all 92 existing tests.

## Acceptance criteria
- [x] Source audit completed across `TopologicalNodeIndex.ts`, `LocalGeoJsonProvider.ts`, `FeatureCatalogue.ts`, `GeometryBuilder.ts`, `RailwayTopology.ts`, `RailwayGeometryBuilder.ts`, `BridgeAndTunnelBuilder.ts`, `ElevationPolicy.ts`, `MapFeature.ts`, `JunctionAndTopology.test.ts`, and `RailwayRendering.test.ts`.
- [x] `docs/decisions/ADR-0009-infrastructure-graph-topology.md` created with status `Proposed`, documenting the source audit, TypeScript domain contracts, construction/simplification rules, renderer integration boundary, 16-test specification, and open questions for project-owner sign-off.
- [x] `tickets/TKT-003-m2-3-infrastructure-graph-architecture.md` created and populated using `tickets/TEMPLATE.md`.
- [x] `docs/STATUS.md`, `GEMINI.md`, `docs/README.md`, and `docs/decisions/README.md` updated accurately while preserving the recorded 2026-11-04 verification results (`92 / 92 passed`).
- [x] Zero application source files (`src/**`), test files (`src/**/*.test.ts`), generated API docs (`docs/api-reference/**`), benchmark artifacts, or closed tickets (`TKT-001`, `TKT-002`) modified during Stage A.
- [ ] Project owner reviews and approves `ADR-0009` (and resolves open questions) to close `TKT-003` and authorize Stage B (`M2.3-B`).

## Implementation notes
- **Ticket Status**: Set to `in_progress` because all Stage A documentation and architectural deliverables are complete, and closure awaits the project owner's architectural review and sign-off on `ADR-0009` prior to Stage B.
- **Planned Stage B–E Sequence**:
  1. **Stage B (`M2.3-B` — Road Network Graph)**: Implement `src/world/infrastructure/topology/types.ts` and `RoadNetworkBuilder.ts` (plus per-vertex node ID survival in `server.ts` / `LocalGeoJsonProvider.ts` and boundary-clip endpoint flags) and verify road topology tests `T-01` through `T-10`.
  2. **Stage C (`M2.3-C` — Railway Network Graph)**: Implement `RailwayNetworkBuilder.ts` (independent railway graph, turnout `1-to-2` switch role and trunk/branch classification, diamond crossovers, parallel passing loops) and verify tests `T-11` and `T-12`.
  3. **Stage D (`M2.3-D` — Crossings & Grade Transitions)**: Preserve point infrastructure metadata (`railway=level_crossing`, `railway=crossing`, `railway=switch`, `highway=crossing`) during ingestion, implement `CrossModalAnalyzer.ts` and `InfrastructureGraph.ts` (`GradeTransitionRelation`, `LevelCrossingRelation`, `GradeSeparatedCrossingRelation`), and verify tests `T-13` through `T-15`.
  4. **Stage E (`M2.3-E` — Renderer Integration)**: Wire `GeometryBuilder.ts` road junction trimming and bridge/tunnel portal detection (and `RailwayTopology.ts` where appropriate) to consume `InfrastructureGraph`, verify provenance/non-regression test `T-16`, and confirm all 92 existing tests + new M2.3 suite pass.

## Verification
- Status: Unverified (Documentation & Architecture Stage A only — no application code or test files were modified, so automated test/build commands were not required or executed for this stage per `GEMINI.md` Section 4).
- Verification steps (to be executed in Stages B–E when code changes occur):
  - `npm test`
  - `npm run lint`
  - `npm run build`
  - `npm run docs:api`

## Related files and documentation
- Source (audited, unchanged): `src/world/TopologicalNodeIndex.ts`, `src/world/LocalGeoJsonProvider.ts`, `src/world/FeatureCatalogue.ts`, `src/world/GeometryBuilder.ts`, `src/world/infrastructure/railways/RailwayTopology.ts`, `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`, `src/world/BridgeAndTunnelBuilder.ts`, `src/world/ElevationPolicy.ts`, `src/types/MapFeature.ts`, `server.ts`
- Tests (audited, unchanged): `src/world/JunctionAndTopology.test.ts`, `src/world/RailwayRendering.test.ts`
- Documentation: `docs/decisions/ADR-0009-infrastructure-graph-topology.md`, `docs/decisions/README.md`, `docs/STATUS.md`, `docs/README.md`, `GEMINI.md`
