---
id: TKT-008
title: M2.3-E2 Graph-Driven Road Rendering and Junction Geometry
type: feature
status: in_progress
priority: high
created: 2026-11-06
updated: 2026-11-06
---

# TKT-008: M2.3-E2 Graph-Driven Road Rendering and Junction Geometry

## Summary
Implement **Stage E2 (`M2.3-E2`)** of Milestone 2.3 (*Infrastructure Topology and Connectivity*) per accepted **[ADR-0002](../docs/decisions/ADR-0002-boundary-derived-road-junction-meshing.md)** and **[ADR-0009](../docs/decisions/ADR-0009-infrastructure-graph-topology.md)**: replace legacy, renderer-local road connectivity inference (`splitRoadsAtSharedInteriorNodes` and `TopologicalNodeIndex` in Stage 6A–C) with graph-driven construction of at-grade road ribbons, degree-2 continuity joins, and boundary-derived junction polygons (`src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`) when `roads: 'graph'` is selected, while preserving a 100% functional `'legacy'` road renderer and `'graph-preview'` validation mode.

## Context
Following project-owner acceptance of `M2.3-E1` (`TKT-007` closed with `145 / 145` passing tests), Stage E is partitioned into five independently reviewed stages:
- **E1 — Graph-to-renderer adapter and safe integration** (accepted and closed via `TKT-007`)
- **E2 — Graph-driven road rendering and intersections** (authorized now via `TKT-008`)
- **E3 — Graph-driven railway rendering and switches** (planned; requires separate project-owner approval)
- **E4 — Level crossings, bridges, and tunnels** (planned; requires separate project-owner approval)
- **E5 — Legacy cleanup and regression hardening** (planned; requires separate project-owner approval)

Stage E2 is the first stage of Milestone 2.3 where the new infrastructure topology produces visible 3D road and intersection geometry.

## Observed behavior
Prior to Stage E2:
1. `InfrastructureRenderOptions.roads` supports only `'legacy'` and `'graph-preview'`; even when `'graph-preview'` is selected, `GeometryBuilder.buildScene()` builds all road and junction geometry through legacy Stage 6A–C (`TopologicalNodeIndex` and `splitRoadsAtSharedInteriorNodes`).
2. Graph-level road topology (`RoadNodeRenderDescriptor` and `RoadEdgeRenderDescriptor`) is validated in `'graph-preview'` mode, but no dedicated graph-driven road geometry builder exists to generate at-grade road ribbons, degree-2 continuity miters, and boundary-derived junction polygons directly from `InfrastructureRenderDescriptorBundle`.

## Expected behavior
1. **Road Render Source Selection (`InfrastructureRenderOptions`)**:
   - Extend `roads` to `'legacy' | 'graph-preview' | 'graph'` (via `?topologyRoads=legacy|graph-preview|graph`), while keeping `railways` restricted to `'legacy' | 'graph-preview'` during E2 (`?topologyRailways=graph` resolves safely to `'legacy'`).
   - `'legacy'` remains the default and performs zero graph construction and zero adapter work when both domains are `'legacy'`.
   - `'graph-preview'` builds and validates `InfrastructureGraph` + `InfrastructureRenderDescriptorBundle` while keeping legacy road mesh output unchanged.
   - `'graph'` builds at-grade road ribbons, continuity joins, and junction polygons from `InfrastructureRenderDescriptorBundle` (`roadEdges`, `roadNodes`, `roadEdgesById`, `roadNodesById`, `gradeTransitions`, `roadFeatureLineage`).
2. **Graph-Driven At-Grade Road & Junction Builder (`src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`)**:
   - Consume `InfrastructureRenderDescriptorBundle` as the sole authority for at-grade road connectivity (`edge.isAtGradeBuildable === true`); never call `splitRoadsAtSharedInteriorNodes` or `TopologicalNodeIndex` when `roads === 'graph'`.
   - **Branching Vehicular Junctions (`requiresVehicularJunctionTrimming === true`)**: trim incident vehicular edges at boundary-derived portals (`RoadEndPortal`), compute CCW-ordered curb corners with acute crotch miter clamping (`maxTrimDists * 0.94`) and reflex outer beveling (`1.35 * maxWidth`), triangulate upward-facing (`+Y`) polygons at `ELEVATION_POLICY.ROAD_SURFACE` (`0.050 m`), and record `portalConnections: RoadPortalConnectionSpec[]` for watertight seam verification.
   - **Degree-2 Continuity Joins (`requiresVehicularContinuityMiter === true` and path degree-2 joins)**: evaluate angular deflection and width compatibility across the two incident half-edges, sharing exact mitered cross-section portal vertices at `node.position` (`0.0 mm` gap, zero overlap) without creating redundant junction polygons; handle width mismatches and sharp reversals cleanly without spikes or self-intersections.
   - **Cross-Tier & Path-Tier Handling**: ensure cross-tier-only footpath contacts (`isCrossTierOnlyInteraction === true`) never trigger vehicular asphalt junction trimming; subtract vehicular carriageway and junction footprints from overlapping path/cycleway/steps footprints via 2D Boolean clipping (`polygonClipping.difference`) with `cleanPolylineForClipping` and `buildSafeExteriorSubPolylines` fallback; support pure path-tier junctions (`requiresPathJunctionTrimming === true`) and raised transverse treads for `highway=steps`.
   - **Endpoint Caps & Grade-Transition Handoff**: suppress semicircular caps at boundary-clipped nodes, junctions, continuity miters, and grade-transition endpoints (`startGradeTransitionId` / `endGradeTransitionId` / `gradeTransitionCoords`); preserve legacy Stage 6D rendering of elevated bridges, tunnels, ramps, piers, parapets, and portals without duplicating or omitting road geometry at bridge/tunnel transitions.
   - **Multi-Segment Provenance & Inspection**: preserve `InspectableFeatureInfo` and `faceRanges` per constituent `EdgeSegmentProvenance` along simplified graph edges while maintaining continuous shared cross-section portals at internal segment boundaries, and report accurate `featureLineage` (`renderedSourceIds`, `deduplicatedCount`, `chainedCount`).
3. **Comprehensive Automated Verification (`src/world/GraphRoadRendering.test.ts`)**:
   - Cover all 20 required topological/geometric scenarios, `ZFightingValidator.validateRoadNetworkGeometry()` zero-overlap and zero-portal-gap invariants, multi-source simplified edge inspection, mode isolation (`legacy` vs `graph-preview` vs `graph`), 10-permutation determinism, and urban/real-extract performance benchmarks.

## Acceptance criteria
- [x] `tickets/TKT-007-m2-3-e1-graph-renderer-adapter.md` closed with project-owner acceptance recorded and `145 / 145` Stage E1 test baseline preserved.
- [x] `InfrastructureRenderAdapter.ts` updated so `roads` supports `'legacy' | 'graph-preview' | 'graph'` while `railways` remains `'legacy' | 'graph-preview'`.
- [x] `src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts` implemented and integrated into `GeometryBuilder.buildScene()` when `roads === 'graph'`, without using legacy `splitRoadsAtSharedInteriorNodes` or `TopologicalNodeIndex` for at-grade roads.
- [x] Elevated bridges, tunnels, portals, and grade-separated structures remain on Stage 6D without omission or duplication at grade transitions.
- [x] Comprehensive automated test suite (`src/world/GraphRoadRendering.test.ts`) passing via `npm test`, verifying all 20 topology cases, `ZFightingValidator` invariants, provenance/inspection across simplified edges, mode isolation, 10-permutation determinism, and benchmarks.
- [x] Documentation (`GEMINI.md`, `docs/STATUS.md`, `docs/architecture.md`, `docs/geometry-and-rendering.md`, `docs/testing-and-diagnostics.md`, and `docs/api-reference/`) updated to reflect `M2.3-E2`.
- [x] `npm test`, `npm run lint`, `npm run build`, and `npm run docs:api` executed and passing with zero errors.
- [ ] Project owner reviews Stage E2 implementation to close `TKT-008`.

## Implementation notes
- Stage E2 strictly excludes E3 (graph-driven railway rendering and switches), E4 (level crossings, bridge/tunnel transitions), and E5 (legacy cleanup).
- Stage B–D topology builders were not modified; `GraphRoadGeometryBuilder.ts` consumes `InfrastructureRenderDescriptorBundle` directly.

## Verification
- **Automated Tests (`npm test`)**: **155 / 155 passed, 0 failed** (`145` Stage E1 baseline tests + `10` new Stage E2 tests in `src/world/GraphRoadRendering.test.ts` covering all 20 required scenarios, `ZFightingValidator.validateRoadNetworkGeometry()` zero-overlap and zero-portal-gap invariants, multi-segment provenance inspection, source-of-truth isolation from `mapData.roads`, 10-permutation determinism, mode isolation, and benchmarks).
- **TypeScript Typecheck (`npm run lint`)**: **0 errors** (`tsc --noEmit`).
- **Production Build (`npm run build`)**: **Succeeded** (`vite build`).
- **API Documentation (`npm run docs:api`)**: **Succeeded** (`typedoc`).
- **Status**: `in_progress` pending project-owner review and acceptance.

## Related files and documentation
- Source: `src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`, `src/world/infrastructure/rendering/InfrastructureRenderAdapter.ts`, `src/world/GeometryBuilder.ts`, `typedoc.json`
- Tests: `src/world/GraphRoadRendering.test.ts`, `src/world/InfrastructureRenderAdapter.test.ts`
- Documentation: `docs/decisions/ADR-0002-boundary-derived-road-junction-meshing.md`, `docs/decisions/ADR-0009-infrastructure-graph-topology.md`, `docs/STATUS.md`, `docs/architecture.md`, `docs/geometry-and-rendering.md`, `docs/testing-and-diagnostics.md`, `GEMINI.md`

