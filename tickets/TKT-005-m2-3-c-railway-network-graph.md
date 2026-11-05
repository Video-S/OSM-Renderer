---
id: TKT-005
title: M2.3-C Railway Network Graph Construction, Turnout Semantics, and Flat Crossings
type: feature
status: in_progress
priority: high
created: 2026-11-05
updated: 2026-11-05
---

# TKT-005: M2.3-C Railway Network Graph Construction, Turnout Semantics, and Flat Crossings

## Summary
Implement **Stage C (`M2.3-C`)** of Milestone 2.3 (*Infrastructure Topology and Connectivity*) per accepted **[ADR-0009](../docs/decisions/ADR-0009-infrastructure-graph-topology.md)**: populate non-destructive pre-rendering railway topology inputs (`ProcessedMapData.topologySource.railwayParts`) and railway switch/crossing point annotations (`railway=switch`, `railway=railway_crossing` in `ProcessedMapData.topologySource.infrastructurePoints`), implement pure-TypeScript `RailwayNetworkBuilder` (`src/world/infrastructure/topology/RailwayNetworkBuilder.ts`) with conservative turnout (`1-to-2` throat) classification and non-interconnecting flat diamond crossing (`RailwayFlatCrossingRelation`) support, and verify via `src/world/RailwayNetworkTopology.test.ts`.

## Context
Following project-owner acceptance of `M2.3-B` (`TKT-004` closed), `M2.3-C` is authorized to construct the authoritative `RailwayNetwork` topology layer in isolation without modifying `RailwayTopology.ts` (rendering helper), `RailwayGeometryBuilder.ts`, `GeometryBuilder.ts`, `RoadNetworkBuilder.ts`, or implementing Stages D–E (`CrossModalAnalyzer`, `LevelCrossingRelation`, `GradeTransitionRelation`, or renderer integration).

## Observed behavior
Prior to Stage C:
1. `ProcessedMapData.topologySource.railwayParts` and `ProcessedMapData.topologySource.infrastructurePoints` are empty arrays (`[]`).
2. Point features with `railway=switch` and `railway=railway_crossing` are skipped during `LocalGeoJsonProvider.parseGeoJson()` without preserving their metadata for railway topology analysis.
3. No standalone, pure-TypeScript `RailwayNetworkBuilder` exists under `src/world/infrastructure/topology/` to build `RailwayNetwork`, classify `1-to-2` turnouts (`TurnoutTopologySpec`), or distinguish non-interconnecting flat diamond crossings (`RailwayFlatCrossingRelation`) from switchable junctions.

## Expected behavior
1. **Non-Destructive `topologySource.railwayParts` and Railway Point Capture**:
   - `LocalGeoJsonProvider.parseGeoJson()` populates `ProcessedMapData.topologySource.railwayParts` (`UnchainedRailwayPart[]`) after metric projection and region bounding-box clipping, preserving original feature/part IDs, `hasExplicitSourceId`, ordered metric polyline coordinates, verified per-vertex raw OSM node IDs (`_nodeIds`, `_nodeIdsByPart`, `nodes`, `nodeIds`), synthetic boundary-cut flags (`clippedAtStart`, `clippedAtEnd`), `railwayType`, `width`, raw string `gauge`, raw string `electrified`, `service`, `usage`, `name`, `isSecondaryBranch`, vertical scope (`layer`, `isBridge`, `isTunnel`), and deep-cloned `osmTags`.
   - `LocalGeoJsonProvider.parseGeoJson()` captures point features with `railway=switch` (`kind: 'railway_switch'`) and `railway=railway_crossing` (`kind: 'railway_crossing_flat'`) in `ProcessedMapData.topologySource.infrastructurePoints` (`InfrastructurePointMetadata[]`) without altering legacy `mapData.railways`, `mapData.landmarks`, skipped-feature diagnostics, or rendered 3D scene geometry.
2. **Pure-TypeScript `RailwayNetworkBuilder` (`src/world/infrastructure/topology/RailwayNetworkBuilder.ts`)**:
   - Exposes `buildRailwayNetwork(input: ProcessedMapData | TopologySourceData | readonly UnchainedRailwayPart[]): RailwayNetworkBuildResult` with zero React, Three.js, renderer, or WebGL dependencies.
   - Enforces domain-isolated node IDs (`railway_node:${layer}|${isBridge ? 1 : 0}|${isTunnel ? 1 : 0}:*`), explicit OSM node ID precedence over `0.15 m` coordinate fallback, boundary-clipped endpoint isolation, interior junction splitting, parallel tracks (`parallelIndex`), passing loops, self-loops and P-loops (`incidentHalfEdges` vs. `incidentEdgeIds` degree invariants), non-interstitial degree-2 simplification with railway attribute guards (`railwayType`, `width`, `gauge`, `electrified`, `service`, `usage`, `isSecondaryBranch`, and `osmTags`), strict `1 mm` exact duplicate detection, and input immutability.
3. **Conservative Turnout Classification (`ADR-0009` Section 5.2)**:
   - At degree-3 railway nodes, evaluates `1-to-2` throat geometry ($\vec{t}_{\text{trunk}} \cdot \vec{t}_a \le -\cos(45^\circ)$, $\vec{t}_{\text{trunk}} \cdot \vec{t}_b \le -\cos(45^\circ)$, $\vec{t}_a \cdot \vec{t}_b \ge \cos(60^\circ) = 0.5$) and disambiguates `mainBranchEdgeId` vs. `divergingBranchEdgeId` using `isSecondaryBranch` rank and deflection angles ($\ge 3^\circ$ difference).
   - Emits `status: 'confirmed'` only when unambiguous; emits `'unresolved_main_vs_diverging'` for symmetric Y-switches and `'unresolved_throat'` when no valid `1-to-2` throat exists, preserving shared-node connectivity and incrementing `railwayUnresolvedSwitchCount`.
4. **Non-Interconnecting Flat Diamond Crossings & Complete 4-Arm Diagnostics (`ADR-0009` Section 5.1)**:
   - Handles all three four-arm railway arrangements: (a) two continuous interior-through-way occurrences, (b) one interior-through-way occurrence plus two terminating way endpoints, and (c) four terminating way endpoints meeting at a node (`\vec{t}_{\text{inward},1} \cdot \vec{t}_{\text{inward},2} \le -\cos(15^\circ)`).
   - Preserves each confirmed diamond crossing track's independent through-continuity without creating a graph path that allows turning from one crossing track onto the other, and emits a `RailwayFlatCrossingRelation` with both track edge IDs, crossing position, arc-length offsets, and acute crossing angle.
   - Retains untagged or ambiguous four-arm railway meetings across all three arrangements as unresolved junctions (`primaryRole: 'junction'`, `roles: ['junction']`, `turnoutTopology: undefined`, counted in `railwayUnresolvedJunctionCount`), emitting a deterministic `UnresolvedCrossingCandidate` in `diagnostics.unresolvedCrossings` with `'coincident_vertex_without_osm_id'`, `'missing_railway_crossing_tag_at_degree_4_node'`, or `'ambiguous_railway_crossing_track_pairing'`.
5. **Conservative Point Annotation Matching (`railway=switch`, `railway=railway_crossing`)**:
   - Matches `InfrastructurePointMetadata` by verified raw OSM node ID first (`4B.1`), rejects conflicting explicit OSM node IDs by proximity (`'conflicting_explicit_osm_node_id'`), requires sufficient topological evidence (`totalArms >= 3` for `railway_switch`, `totalArms === 4` for `railway_crossing_flat`; otherwise `'insufficient_topological_evidence'`), rejects multiple candidate nodes within `0.15 m` without picking the nearest (`'ambiguous_multiple_candidate_nodes'`), enforces vertical-scope compatibility and rejects multi-scope ambiguity (`'vertical_scope_mismatch'`), and records all unmatched or ambiguous points in `diagnostics.unresolvedInfrastructurePoints`.

## Acceptance criteria
- [x] `LocalGeoJsonProvider.parseGeoJson()` populates `ProcessedMapData.topologySource.railwayParts` and railway-only `infrastructurePoints` (`railway=switch`, `railway=railway_crossing`) with zero shared mutable references and zero changes to legacy `mapData.railways`, `diagnostics`, or rendered geometry.
- [x] `RailwayNetworkBuilder.ts` implemented in pure TypeScript under `src/world/infrastructure/topology/` with `RailwayNetworkBuildResult` and `RailwayNetworkDiagnostics`, without modifying `RailwayTopology.ts` or implementing Stage D/E features.
- [x] Conservative turnout classification (`confirmed`, `unresolved_main_vs_diverging`, `unresolved_throat`), non-interconnecting flat diamond crossing (`RailwayFlatCrossingRelation` with strict non-interchange between crossing tracks), complete unresolved four-arm crossing diagnostics across all three 4-arm arrangements (`'coincident_vertex_without_osm_id'`, `'missing_railway_crossing_tag_at_degree_4_node'`, `'ambiguous_railway_crossing_track_pairing'`), and conservative point annotation matching (`diagnostics.unresolvedInfrastructurePoints`) implemented per `ADR-0009` Sections 5.1 and 5.2.
- [x] Comprehensive automated test suite (`src/world/RailwayNetworkTopology.test.ts` — `18` tests) passing via `npm test`, covering `T-11` (confirmed & ambiguous turnouts), `T-12` (continuous and 4-segment flat diamond crossings with non-interchange assertions, plus unresolved 4-arm diagnostics across 2-interior, 1-interior+2-endpoint, and 4-endpoint arrangements), conservative point annotation matching (unique coordinate fallback, multiple nearby nodes, conflicting explicit IDs, vertical-scope isolation), interior shared nodes, curved shape vertices, parallel tracks & passing loops, self-loops & P-loops, degree-2 simplification with reversed provenance, railway attribute breaks, bridge vs. at-grade isolation, boundary-clipped endpoints, Overpass JSON / OSM XML / MultiLineString node-ID preservation, semantic duplicate preservation, determinism, input immutability, and renderer isolation.
- [x] Reproducible parser vs. railway-graph performance benchmark recorded on synthetic railway networks and real Station Hengelo / Amsterdam Centraal OSM extracts.
- [x] `npm test`, `npm run lint`, `npm run build`, and `npm run docs:api` executed and passing with zero errors.
- [ ] Project owner reviews Stage C implementation to close `TKT-005`.

## Implementation notes
- Stage C scope strictly excludes Stage D (`CrossModalAnalyzer`, `LevelCrossingRelation`, `GradeTransitionRelation`, `highway=crossing`, `railway=level_crossing`, `railway=crossing`) and Stage E (renderer integration).
- `RailwayNetworkBuilder` decouples confirmed flat diamond crossings (`railway=railway_crossing` or shared explicit interior OSM nodes with crossing angle $\ge 10^\circ$) into independent track-scoped nodes prior to splitting and degree-2 simplification so crossing tracks remain topologically non-interconnecting while emitting `RailwayFlatCrossingRelation` records with exact arc-length offsets and acute crossing angles.
- Unresolved 4-arm meetings across all three arrangements (`2` interior occurrences, `1` interior + `2` endpoint occurrences, and `4` endpoint occurrences) remain undecoupled (`degree === 4`, `primaryRole: 'junction'`, `roles: ['junction']`, `turnoutTopology: undefined`), increment `railwayUnresolvedJunctionCount`, and record `UnresolvedCrossingCandidate` entries in `diagnostics.unresolvedCrossings`.
- Point annotations (`railway=switch`, `railway=railway_crossing`) never split a 2-arm interior way or cross vertical scopes (`layer`, `isBridge`, `isTunnel`); unmatched or ambiguous points are recorded in `diagnostics.unresolvedInfrastructurePoints`.
- `TKT-005` remains `in_progress` pending project-owner review and acceptance.

## Verification
- Status: Verified (`126 / 126` automated tests passing, including `18 / 18` Stage C tests in `src/world/RailwayNetworkTopology.test.ts`; pending project-owner review)
- Verification steps:
  - `npm test`: `126 passed, 0 failed`
  - `npm run lint`: `0 errors` (`tsc --noEmit`)
  - `npm run build`: `vite build` succeeded
  - `npm run docs:api`: `typedoc` API documentation generated cleanly

## Related files and documentation
- Source: `src/world/infrastructure/topology/types.ts`, `src/world/infrastructure/topology/RoadNetworkBuilder.ts`, `src/world/infrastructure/topology/RailwayNetworkBuilder.ts`, `src/world/infrastructure/topology/InfrastructureGraph.ts`, `src/world/LocalGeoJsonProvider.ts`
- Tests: `src/world/RailwayNetworkTopology.test.ts`
- Documentation: `docs/decisions/ADR-0009-infrastructure-graph-topology.md`, `docs/STATUS.md`, `docs/architecture.md`, `docs/data-pipeline-and-feature-support.md`, `docs/testing-and-diagnostics.md`

