---
id: TKT-007
title: M2.3-E1 Graph-to-Renderer Adapter and Safe Integration
type: feature
status: in_progress
priority: high
created: 2026-11-06
updated: 2026-11-06
---

# TKT-007: M2.3-E1 Graph-to-Renderer Adapter and Safe Integration

## Summary
Implement **Stage E1 (`M2.3-E1`)** of Milestone 2.3 (*Infrastructure Topology and Connectivity*) per accepted **[ADR-0009](../docs/decisions/ADR-0009-infrastructure-graph-topology.md)**: create a pure, deterministic graph-to-renderer adapter (`src/world/infrastructure/rendering/InfrastructureRenderAdapter.ts`) that transforms an `InfrastructureGraph` into render-ready road, railway, and cross-domain descriptors; provide independent `'legacy' | 'graph-preview'` developer switches (`?topologyRoads=...&topologyRailways=...`); and prove 100% legacy renderer invariance (`src/world/InfrastructureRenderAdapter.test.ts`).

## Context
Following project-owner acceptance of `M2.3-D` (`TKT-006` closed with `135 / 135` passing tests), Stage E is partitioned into five independently reviewed stages:
- **E1 — Graph-to-renderer adapter and safe integration** (authorized now)
- **E2 — Graph-driven road rendering and intersections** (planned; requires separate project-owner approval)
- **E3 — Graph-driven railway rendering and switches** (planned; requires separate project-owner approval)
- **E4 — Level crossings, bridges, and tunnels** (planned; requires separate project-owner approval)
- **E5 — Legacy cleanup and regression hardening** (planned; requires separate project-owner approval)

Stage E1 establishes the pure adapter contract, lineage preservation, independent preview switches, and strict legacy renderer parity verification without altering any rendered 3D vertex or mesh in legacy mode.

## Observed behavior
Prior to Stage E1:
1. `InfrastructureGraph` (`src/world/infrastructure/topology/InfrastructureGraph.ts`) constructs topological road and railway networks and cross-modal relations, but no rendering adapter exists to translate graph nodes, edges, provenance, and relations into render-ready domain descriptors with documented E2–E4 handoff contracts.
2. No independent developer configuration switches (`InfrastructureRenderOptions` / `?topologyRoads=...&topologyRailways=...`) exist to exercise and validate graph-backed render descriptors alongside the legacy renderer.

## Expected behavior
1. **Pure Graph-to-Renderer Adapter (`src/world/infrastructure/rendering/InfrastructureRenderAdapter.ts`)**:
   - Convert an `InfrastructureGraph` into deterministic, immutable render-ready descriptors (`InfrastructureRenderDescriptorBundle`) with zero Three.js, React, WebGL, or application-state dependencies and zero mutation of `InfrastructureGraph` or `ProcessedMapData`.
   - **Road Descriptors (`RoadEdgeRenderDescriptor`, `RoadNodeRenderDescriptor`)**: preserve canonical IDs, ordered metric polylines, `roadClass`, `tier` (`'vehicular' | 'path'`), `width`, `lanes`, `normalizedOneway`, `rawOnewayTag`, `surface`, `name`, `layer`, `isBridge`, `isTunnel`, `isCulvert`, boundary-clip flags, incident half-edge tangents, node roles, cross-tier junction flags (`isCrossTier`, `isCrossTierOnlyInteraction`, `requiresVehicularJunctionTrimming` so cross-tier path contacts never trigger false vehicular asphalt trimming), complete source-feature lineage and per-segment provenance (`reversedRelativeToSource`, `deduplicatedFeatureIds`), and grade-transition / level-crossing associations.
   - **Railway Descriptors (`RailwayEdgeRenderDescriptor`, `RailwayNodeRenderDescriptor`, `RailwayFlatCrossingRenderDescriptor`)**: preserve canonical IDs, ordered metric polylines, `railwayType`, `width`, `gauge`, `electrified`, `service`, `usage`, `name`, `isSecondaryBranch`, `layer`, `isBridge`, `isTunnel`, boundary-clip flags, confirmed vs. unresolved turnout topology (`turnoutStatus`, `turnoutTopology`), flat diamond crossings with strict non-interchange (`allowsBranchInterchange: false`), per-segment OSM provenance, and grade-transition / level-crossing associations.
   - **Cross-Domain Descriptors (`LevelCrossingRenderDescriptor`, `GradeTransitionRenderDescriptor`, `GradeSeparatedCrossingRenderDescriptor`, `InfrastructureRenderUnresolvedDiagnostics`)**: preserve confirmed level crossings (kinds, confidence, positions, exact arc-length offsets), grade-separated crossings (upper/lower identities), grade transitions (endpoint IDs, confidence, traversal direction), and unresolved candidates/diagnostics strictly separated from confirmed infrastructure.
   - Preserve `sourceFeatureId`, `sourceFeatureIds`, `deduplicatedFeatureIds`, `sourceFeatureToRoadEdgeIds`, `sourceFeatureToRailwayEdgeIds`, and pre-computed `roadFeatureLineage` / `railwayFeatureLineage` maps so downstream E2/E3 rendering preserves `InspectableFeatureInfo` and `faceRanges`.
2. **Independent Road & Railway Preview Switches (`InfrastructureRenderOptions`)**:
   - Support `roads: 'legacy' | 'graph-preview'` and `railways: 'legacy' | 'graph-preview'` (both defaulting to `'legacy'`), selectable independently via URL query parameters `?topologyRoads=graph-preview&topologyRailways=legacy`.
   - Invalid or absent values resolve to `'legacy'`.
   - When both are `'legacy'`, perform zero graph construction and zero adapter work.
   - When either is `'graph-preview'`, build one shared `InfrastructureGraph` per dataset (memoized across camera frames, theme updates, hover events, and railway prototype mode switches) and validate the resulting render descriptors while keeping all existing 3D mesh generation on the legacy pipeline during E1.
3. **Strict Legacy Renderer Invariance & Verification (`src/world/InfrastructureRenderAdapter.test.ts`)**:
   - Prove exact equality of legacy `mapData.roads` and `mapData.railways`, scene group hierarchies, mesh counts, transforms, render order, all `BufferGeometry` attribute and index arrays, `InstancedMesh` counts and instance matrices, `faceRanges`, inspection provenance, `userData`, scene statistics, camera zoom/LOD updates, and resource disposal between baseline scenes and scenes created with `'graph-preview'` enabled across synthetic fixtures, Station Hengelo, and Amsterdam Centraal extracts.

## Acceptance criteria
- [x] `tickets/TKT-006-m2-3-d-cross-modal-connectivity.md` closed with project-owner acceptance recorded and `135 / 135` Stage D baseline preserved.
- [x] Pure TypeScript `InfrastructureRenderAdapter.ts` implemented under `src/world/infrastructure/rendering/` exposing road, railway, and cross-domain render descriptors, lineage maps, contract validation, and preview preparation.
- [x] Independent `InfrastructureRenderOptions` (`roads` and `railways`: `'legacy' | 'graph-preview'`) wired with URL query parameter parsing (`topologyRoads`, `topologyRailways`), zero redundant work in `'legacy'` mode, single shared `InfrastructureGraph` build when either preview mode is active, and full compatibility with `railwayPrototypeMode` and `railwayGroupOverride`.
- [x] Comprehensive automated test suite (`src/world/InfrastructureRenderAdapter.test.ts`) passing via `npm test`, covering adapter determinism, road/railway/cross-domain descriptor accuracy, source lineage, immutability, preview switch parsing, legacy renderer buffer/provenance invariance, and performance benchmarks.
- [x] Documentation (`GEMINI.md`, `docs/STATUS.md`, `docs/architecture.md`, `docs/geometry-and-rendering.md`, `docs/data-pipeline-and-feature-support.md`, `docs/testing-and-diagnostics.md`, and `docs/api-reference/`) updated to document E1 and planned stages E2–E5.
- [x] `npm test`, `npm run lint`, `npm run build`, and `npm run docs:api` executed and passing with zero errors.
- [ ] Project owner reviews Stage E1 implementation to close `TKT-007`.

## Implementation notes
- Stage E1 strictly excludes E2 (graph-driven road rendering and intersections), E3 (graph-driven railway rendering and switches), E4 (level crossings, bridges, and tunnels), and E5 (legacy cleanup).
- In E1, `'graph-preview'` builds and validates graph-backed render descriptors alongside the existing renderer without altering mesh generation.

## Verification
- Status: In progress (all technical verification criteria satisfied; pending project-owner review to close `TKT-007`).
- Executed commands & results (2026-11-06):
  - `npm test` — Exit code `0` (**144 / 144 passed**, `0` failures; includes `9 / 9` new tests in `src/world/InfrastructureRenderAdapter.test.ts` plus `135 / 135` preserved baseline tests).
  - `npm run lint` (`tsc --noEmit`) — Exit code `0` (`0` TypeScript errors).
  - `npm run build` (`vite build`) — Exit code `0` (`dist/` bundle built cleanly).
  - `npm run docs:api` (`typedoc`) — Exit code `0` (`docs/api-reference/` generated with `InfrastructureRenderAdapter.ts` included).
- Performance & Lifecycle Benchmarks (`InfrastructureRenderAdapter.test.ts`):
  - **Synthetic M2.3-E1 (`13` roads, `8` railways)**: `buildInfrastructureGraph = 1.51 ms`, `buildInfrastructureRenderDescriptors = 0.33 ms`, `GeometryBuilder.buildScene (legacy) = 9.82 ms`, total `'graph-preview'` preparation overhead `= 1.84 ms` (`0.00 ms` in default `'legacy'` mode).
  - **Station Hengelo (`67` railways)**: `buildInfrastructureGraph = 10.96 ms`, `buildInfrastructureRenderDescriptors = 0.64 ms`, `GeometryBuilder.buildScene (legacy) = 150.55 ms`, total `'graph-preview'` preparation overhead `= 11.60 ms` (`0.00 ms` in default `'legacy'` mode).
  - **Amsterdam Centraal (`3` roads, `325` railways)**: `buildInfrastructureGraph = 54.04 ms`, `buildInfrastructureRenderDescriptors = 6.72 ms`, `GeometryBuilder.buildScene (legacy) = 595.21 ms`, total `'graph-preview'` preparation overhead `= 60.76 ms` (`0.00 ms` in default `'legacy'` mode).

## Related files and documentation
- Source: `src/world/infrastructure/rendering/InfrastructureRenderAdapter.ts`, `src/world/GeometryBuilder.ts`, `src/app/App.tsx`, `typedoc.json`
- Tests: `src/world/InfrastructureRenderAdapter.test.ts`
- Documentation: `docs/decisions/ADR-0009-infrastructure-graph-topology.md`, `docs/STATUS.md`, `docs/architecture.md`, `docs/geometry-and-rendering.md`, `docs/data-pipeline-and-feature-support.md`, `docs/testing-and-diagnostics.md`, `GEMINI.md`
