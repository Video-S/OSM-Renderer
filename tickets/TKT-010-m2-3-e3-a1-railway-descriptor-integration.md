---
id: TKT-010
title: M2.3-E3-A1 Railway Graph Descriptor Integration
type: feature
status: closed
priority: high
created: 2026-11-09
updated: 2026-11-09
closed: 2026-11-09
---

# TKT-010: M2.3-E3-A1 Railway Graph Descriptor Integration

## Summary
Implement **Stage E3-A1 (`M2.3-E3-A1`)** of Milestone 2.3 per accepted [M2.3-E3 Implementation Proposal](../docs/m2-3-e3-railway-rendering-proposal.md): allow the verified Candidate B railway renderer (`RailwayGeometryBuilder.ts`) to consume `RailwayEdgeRenderDescriptor` data under `?topologyRailways=graph`, while retaining `?topologyRailways=legacy` as the production default and fallback, strictly preserving existing Candidate B geometry generation rules.

## Context
Following project-owner acceptance of Stage E1 (`TKT-007`) and Stage E2 (`TKT-008`), Stage E3 addresses graph-driven railway rendering. The project owner has authorized Stage E3-A1 (Descriptor Integration), while deferring graph-informed switch changes (E3-A2), surface-first ballast (E3-B), and later stages.

In Stage E3-A1, Candidate B's geometry synthesis pipeline is adapted to consume simplified `RailwayEdgeRenderDescriptor` inputs without changing how Candidate B synthesizes physical geometry:
- Steel rails remain continuous 1D track ribbons / extrusions (never clipped by 2D Booleans).
- Sleeper placement, clearance, and Minkowski multi-interval clipping are preserved.
- Turnout detection preserves the existing `isTurnoutThroatPair` proximity heuristic.
- Ballast UV ribbons are preserved.
- Bridges and tunnels retain their 3D vertical elevation profiles.
- OSM provenance is strictly preserved across chained and deduplicated features.
- Legacy rendering (`?topologyRailways=legacy`) remains the production default with zero regression.

## Observed behavior
Prior to Stage E3-A1:
1. `InfrastructureRenderAdapter.ts` resolved `topologyRailways=graph` to `'legacy'`. The railway graph descriptors constructed in Stage E1 were validated in unit tests but were never consumed by `RailwayGeometryBuilder.ts`.
2. `RailwayGeometryBuilder.ts` operated exclusively on `data.railways` (unchained/unsimplified GeoJSON feature arrays).
3. `DevToolsPanel.tsx` lacked a toggle to select graph-driven railway rendering.

## Expected behavior
1. **Renderer Selection**:
   - `RailwayInfrastructureRenderSource` extends to `'legacy' | 'graph-preview' | 'graph'`.
   - `?topologyRailways=graph` activates graph descriptor consumption.
   - `?topologyRailways=legacy` remains the default.
2. **Adapter & Descriptor Consumption**:
   - `adaptRailwayEdgeDescriptorsToFeatures` transforms `RailwayEdgeRenderDescriptor`s into track feature representations preserving track centerline coordinates, gauge, widths, layers, bridge/tunnel flags, and OSM tags.
   - `RailwayGeometryBuilder.ts` consumes these adapted descriptors when `renderSource === 'graph'`.
   - Feature provenance is preserved: `InspectableFeatureInfo.sourceFeatureId` and `sourceFeatureIds` retain all original OSM constituent feature IDs across degree-2 simplified chains.
3. **Graceful Fallback Contract**:
   - If descriptors are unavailable, empty, or corrupted when `topologyRailways='graph'` is selected, the renderer gracefully falls back to `data.railways`, logs a diagnostic warning, and sets `diagnostics.railwayRendererFallback = 'legacy_due_to_missing_descriptors'` without crashing, duplicating meshes, or leaking resources.
4. **Preservation of Candidate B Geometry Rules**:
   - No changes to `isTurnoutThroatPair`, switch taper equations, or sleeper placement rules in Stage E3-A1.
5. **Automated Verification**:
   - Regression test suite compares Legacy Candidate B vs. Graph Candidate B across synthetic switchyards, Station Hengelo, Amsterdam Centraal, chained ways, reversed ways, parallel tracks, turnouts, flat crossings, bridges, and tunnels.
   - Initial performance baseline recorded.

## Acceptance criteria
- [x] `docs/m2-3-e3-railway-rendering-proposal.md` updated with project-owner architectural corrections.
- [x] `RailwayInfrastructureRenderSource` extended to `'legacy' | 'graph-preview' | 'graph'` in `InfrastructureRenderAdapter.ts`.
- [x] `adaptRailwayEdgeDescriptorsToFeatures` implemented and exported in `InfrastructureRenderAdapter.ts`.
- [x] `RailwayGeometryBuilder.ts` updated to accept `renderSource`, `descriptors`, and `diagnostics` in `BuildRailwayPrototypeOptions`, routing to adapted graph descriptors when `renderSource === 'graph'` with observable fallback.
- [x] `GeometryBuilder.ts` Stage 5 wired to pass `renderSource: infrastructureRenderOptions.railways` and memoized descriptors.
- [x] `DevToolsPanel.tsx` updated with a toggle for `Graph (E3-A1)`.
- [x] Automated regression test suite `src/world/GraphRailwayRendering.test.ts` passing via `npm test`.
- [x] Legacy Candidate B verified unchanged under `topologyRailways='legacy'`.
- [x] Performance baseline measurements recorded for Legacy vs. Graph modes.
- [x] `npm test`, `npm run lint`, `npm run build`, and `npm run docs:api` passing with zero errors.

## Verification
- **Automated Test Suite**:
  - `npm test`: **221 / 221 tests passed** (26 suites, 0 failures, 0 skipped).
  - `src/world/GraphRailwayRendering.test.ts`: **17 / 17 tests passed** (11 sub-suites) covering:
    1. Descriptor parsing and adapter transformation preserving geometry, gauge, width, layers, and provenance.
    2. Graceful fallback on missing/corrupted descriptors setting `diagnostics.railwayRendererFallback = 'legacy_due_to_missing_descriptors'` without leaks or duplicate meshes.
    3. Synthetic switchyard (65 ways) feature parity: 100% source way representation in `renderedSourceIds`, equivalent vertex and sleeper count.
    4. Station Hengelo (67 ways) real extract: 100% source way representation (67/67), degree-2 chain contraction from 67 ways to 52 graph edges, eliminating cut artifacts and phase discontinuities.
    5. Amsterdam Centraal (160 ways) complex throat: 100% source way representation (160/160), 133 graph edges.
    6. Chained colinear ways and reversed orientations: continuous rail extrusions without tangent-flip artifacts.
    7. Parallel tracks (>= 3.8m spacing) independent ballast ribbons, preserved turnout throat proximity detection.
    8. Bridges (piers, parapets, elevated rails/sleepers) and tunnels (portals, subterranean profile).
    9. Determinism across input permutations, in-place 4-theme updates, and GPU resource disposal.
    10. `GeometryBuilder.ts` Stage 5 full-scene wiring.
- **Typecheck & Linter**:
  - `npm run lint` (`tsc --noEmit`): Clean (0 errors).
- **Production Build**:
  - `npm run build` (`vite build`): Succeeded in 2.03s.
- **Documentation**:
  - `npm run docs:api` (`typedoc`): Generated cleanly.
- **Performance Baseline**:
  - **Synthetic Switchyard (65 ways)**:
    - Legacy: ~309 ms, 65 rendered ways, 532 sleeper boxes, 64 turnout bearers.
    - Graph: ~312 ms, 65 graph edges, 532 sleeper boxes, 64 turnout bearers.
  - **Station Hengelo (67 ways)**:
    - Legacy: ~325 ms, 67 rendered ways, 7,370 sleeper boxes.
    - Graph: ~330 ms, 52 graph edges (15 degree-2 contractions, 100% provenance preserved), 7,314 sleeper boxes.
  - **Amsterdam Centraal (160 ways)**:
    - Legacy: ~1,075 ms, 160 rendered ways, 21,556 sleeper boxes.
    - Graph: ~1,082 ms, 133 graph edges (27 degree-2 contractions, 100% provenance preserved), 21,498 sleeper boxes.
