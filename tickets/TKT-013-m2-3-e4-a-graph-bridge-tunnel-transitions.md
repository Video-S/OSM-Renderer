---
id: TKT-013
title: M2.3-E4-A Graph-Driven Bridge & Tunnel Transitions
type: feature
status: closed
priority: high
created: 2026-11-10
updated: 2026-11-11
---

# TKT-013: M2.3-E4-A Graph-Driven Bridge & Tunnel Transitions

## Summary
Implement Stage E4-A of Goalpost 2: replace ad-hoc Euclidean `<= 0.8 m` endpoint proximity heuristics with authoritative infrastructure graph relationships (`GradeTransitionRenderDescriptor`, `RoadNodeRenderDescriptor`, `RailwayNodeRenderDescriptor`, and `UnresolvedGradeTransitionCandidate`) for road and railway bridges and tunnels. Eliminate the structural defect where complex railway and road bridges end abruptly at vertical cliffs instead of connecting naturally to adjacent infrastructure, while conservatively handling boundary-clipped, unresolved, and standalone endpoints.

## Context
With E2+ (`graph-surface` roads), E3-A2 (`graph-switches` railways), and E3-B (`graph-R+` surface-first railway ballast) accepted by the project owner, the most significant remaining structural defect in Hengelo and urban railway corridors is that complex railway and road bridges sometimes terminate abruptly at vertical cliffs instead of connecting naturally to adjacent at-grade or elevated infrastructure.

## Root-Cause Investigation of the 7 Defect Classes

1. **Valid bridge-to-at-grade transitions missed or overridden by proximity heuristics**:
   - In `RailwayGeometryBuilder.ts` and `GeometryBuilder.ts`, `connectsStartAtGrade`, `connectsEndAtGrade`, `connectsStartBridge`, and `connectsEndBridge` relied on `<= 0.8 m` 2D Euclidean proximity checks across raw vertices.
   - When two bridge tracks converge toward a switch or portal near a bridge abutment (within `0.8 m` of each other, as occurs on 10 real railway bridges in `amsterdamCentraal`, e.g., `way/513172703`, `way/513172765`, `way/513172068`, `way/513172069`, `way/1009641791`, `way/1009641792`), `connectsBridge` falsely triggered (`true`) because the neighboring track's portal was within `0.8 m`.
   - In `BridgeAndTunnelBuilder.ts`, `wantsInSpanStartRamp = !connectsStartBridge && ...` allowed the false-positive `connectsBridge = true` to override `connectsAtGrade = true`, completely suppressing the approach ramp and creating a $2.80\text{ m}$ vertical cliff at the confirmed grade transition portal.
   - Additionally, when a railway bridge or road bridge lands directly at an explicit OSM switch or Y-junction node whose turnout branches have a small angle difference ($\Delta \cos < 0.10$, e.g., standard $1:9$ or $1:12$ railway turnouts with $\Delta \cos \approx 0.0046$), Tier 1 `CrossModalAnalyzer` rejected the explicit OSM transition as `'ambiguous_multiple_candidates'`.

2. **Consecutive bridge segments and multi-segment bridge chains**:
   - When a bridge is split into multiple edges (for example, at a switch on a bridge deck such as `way/1009641791` ($2.41\text{ m}$) + `way/780373882` ($22.04\text{ m}$), or `way/547532273` ($3.32\text{ m}$) + `way/513172595` ($62.45\text{ m}$), or at a degree-2 attribute break), a short portal bridge edge ($< 5.0\text{ m}$) that connects to at-grade on one end and continues onto an elevated bridge edge on the other end hit the isolated `mappedBridgeLength < MIN_RAMPED_BRIDGE_SPAN_METERS (5.0 m)` guard.
   - That guard forced `rampStartLength = 0, rampEndLength = 0, rampMode = 'abutment_headwall'`, while the continuing $22\text{–}62\text{ m}$ bridge edge saw `connectsBridge = true` at the shared switch/continuation node and also stayed flat at $+2.860\text{ m}$. Consequently, neither edge ramped down, leaving a $2.80\text{ m}$ vertical cliff at the bridge abutment.
   - Similarly, when two consecutive bridge edges with different `layer` tags (e.g., `layer=1` at $+2.85\text{ m}$ meeting `layer=2` at $+4.25\text{ m}$) meet at a shared explicit OSM node, they sat in separate layer scopes with an uninterpolated $1.40\text{ m}$ vertical step.

3. **Bridges ending at dataset clipping boundaries**:
   - When a bridge is clipped at the region boundary (`clippedAtStart` / `clippedAtEnd` or `isBoundaryClipped`), there is no continuation outside the clipped region, so `!connectsAtGrade && !connectsBridge` (`isStandalone = true`).
   - `buildBridgeProfile3D` treated `isStandalone = true` by synthesizing an external $12\text{ m}$ ramp outside the boundary descending to ground level, rather than preserving the elevated deck height conservatively at the clipped boundary.

4. **Bridges connecting at switches, junctions, or multi-way nodes**:
   - A bridge portal meeting an at-grade railway switch (2 diverging branches sharing the explicit OSM portal node) or a bridge switch (`degree >= 3` on the bridge deck) near the portal caused either Tier 1 runner-up rejection (`TIER_1_RUNNER_UP_MARGIN = 0.1` too large for railway turnout angles) or cross-track `connectsBridge` false positives.

5. **Reversed way orientation**:
   - When consecutive or connected OSM ways have opposite digitization directions, transition matching and endpoint tangent alignment must be strictly invariant to way vertex order (`fromNodeId` vs `toNodeId`).

6. **Bridges shorter than `MIN_RAMPED_BRIDGE_SPAN_METERS` ($5.0\text{ m}$)**:
   - Standalone or double-ended ultra-short spans ($< 5.0\text{ m}$) intentionally use `'abutment_headwall'`. However, when a $< 5.0\text{ m}$ bridge edge is part of a connected multi-edge bridge chain (`confirmed_transition` on one end and `confirmed_elevated_continuation` on the other, or part of a multi-edge bridge whose total connected span is $\ge 5.0\text{ m}$), treating the short edge in isolation as an `'abutment_headwall'` creates a false cliff.

7. **Source segmentation mismatch between `GeometryBuilder` and `InfrastructureGraph`**:
   - In `GeometryBuilder.ts`, Stage 6D iterated over legacy `data.roads` even when `roads: 'graph'` or `'graph-surface'` was active, while Stage 6A–C rendered at-grade roads from `descriptors.roadEdges`.
   - Furthermore, `generateTunnelPortalAndTraceGeometries` emitted 3D masonry portal arches at both ends of every tunnel segment, even at internal tunnel-to-tunnel continuation nodes (`confirmed_elevated_continuation` / tunnel continuation) and boundary-clipped tunnel ends (`boundary_clipped_continuation`).

## Implementation Summary

1. **Cross-Modal Grade Transition Disambiguation at Railway Switches (`src/world/infrastructure/topology/CrossModalAnalyzer.ts`)**:
   - Refined Tier 1 and Tier 2 candidate selection in `analyzeDomainGradeTransitions` so railway bridges/tunnels meeting railway turnouts/switches at portals disambiguate straight vs. diverging branches via alignment margin ($\text{dot} \ge 0.98$ and $\Delta \text{dot} \ge 10^{-3}$) or `isSecondaryBranch` metadata, and allow confirmed railway switch nodes (`roles.includes('switch')`) in Tier 2 while preserving all existing Stage D road and railway test contracts.

2. **Authoritative Graph-Driven Grade-Separation Resolver (`src/world/BridgeAndTunnelBuilder.ts`)**:
   - Implemented `resolveGraphGradeSeparatedPlans(descriptors, network, getTargetDeckElevation)` producing `GraphGradeSeparatedResolutionResult` and `GradeTransitionRenderDiagnostics`.
   - Explicitly classifies every bridge and tunnel edge endpoint into one of 5 mutually exclusive states:
     - `'confirmed_transition'`: endpoint anchored by a confirmed `GradeTransitionRenderDescriptor` (`startGradeTransitionId` / `endGradeTransitionId`).
     - `'confirmed_elevated_continuation'`: endpoint sharing a graph node with one or more continuing bridge/tunnel edges (including degree-2 continuations, bridge/tunnel switch nodes, and cross-scope/cross-layer explicit OSM node continuations such as `layer=1|isBridge=true` $\leftrightarrow$ `layer=1|isBridge=false` or `layer=1` $\leftrightarrow$ `layer=2`).
     - `'boundary_clipped_continuation'`: endpoint truncated at the geographic bounding box (`clippedAtStart` / `clippedAtEnd` or `isBoundaryClipped`).
     - `'unresolved_connection'`: endpoint flagged by `UnresolvedGradeTransitionCandidate` or `hasUnresolvedSwitchConfiguration`.
     - `'intentionally_standalone'`: unclipped, non-continuing degree-1 endpoint with no confirmed or unresolved transition.
   - Solves connected bridge component spans and Dijkstra shortest portal distances (`startPortalDistanceMeters`, `endPortalDistanceMeters`, `componentRampLengthMeters`) across multi-edge bridge chains and bridge deck switches.
   - Computes target deck elevations at cross-layer elevated joints as the mean of adjacent strata so `layer=1` ($+2.85\text{ m}$) and `layer=2` ($+4.25\text{ m}$) bridge edges meet smoothly at $+3.55\text{ m}$ without vertical cliffs.
   - Tracks `correctedPortalDiscontinuitiesCount` whenever a bridge/tunnel or at-grade endpoint is snapped ($> 10^{-4}\text{ m}$) to `GradeTransitionRenderDescriptor.position`.

3. **3D Bridge Profile, Substructure & Tunnel Portal Control (`src/world/BridgeAndTunnelBuilder.ts`)**:
   - Updated `buildBridgeProfile3D` to evaluate $d(s) = \min(d_0 + s,\; d_1 + (L_e - s))$ when graph-driven component ramp parameters are provided, guaranteeing exact 3D elevation continuity at all confirmed portals and interior multi-segment/switch nodes while never synthesizing external approach extensions in graph mode.
   - Updated `generateBridgeStructureGeometries` with `BridgeStructureGenerationOptions` (`suppressStartAbutmentHeadwall`, `suppressEndAbutmentHeadwall`, `minElevatedDeckY`) so internal elevated continuations and boundary-clipped continuations never emit vertical concrete abutment headwalls down to `groundY`.
   - Updated `generateTunnelPortalAndTraceGeometries` with `TunnelPortalGenerationOptions` (`emitStartPortal`, `emitEndPortal`) so internal tunnel-to-tunnel continuations and boundary-clipped tunnel ends suppress surface masonry portal arches while continuing the underground alignment trace.

4. **Railway & Road Renderer Integration (`RailwayGeometryBuilder.ts`, `SurfaceFirstRailwayBallast.ts`, `GraphRoadGeometryBuilder.ts`, `GeometryBuilder.ts`)**:
   - Wired `resolveGraphGradeSeparatedPlans` into `RailwayGeometryBuilder.ts` for all graph modes (`graph`, `graph-switches`, `graph-R+`), snapping portal coordinates, suppressing R+ ballast round caps (`endpointCapPolicy`) at confirmed transitions and clipped boundaries, and attaching `gradeTransitionDiagnostics`.
   - Wired `resolveGraphGradeSeparatedPlans` into `GeometryBuilder.ts` Stage 6D and `GraphRoadGeometryBuilder.ts` when `roads: 'graph' | 'graph-surface'`, rendering road bridges and tunnels directly from graph `RoadEdgeRenderDescriptor`s with full component ramp continuity, abutment/portal suppression, and source feature lineage preservation.

## Benchmark & Diagnostic Comparison

| Fixture | Mode | Total Build (ms) | Bridge/Tunnel Build (ms) | Triangles | Draw Calls | CPU Buffer (MB) | Confirmed Transitions | Confirmed Continuations | Unresolved | Clipped | Standalone | Legacy Fallbacks |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Synthetic Switchyard** (65 rail ways) | `legacy` | 209.09 | 0.01 | 11,550 | 36 | 0.666 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Synthetic Switchyard** (65 rail ways) | `graph` | 153.39 | 0.04 | 11,550 | 36 | 0.675 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Synthetic Switchyard** (65 rail ways) | `graph-switches` | 173.78 | 0.04 | 11,550 | 36 | 0.693 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Synthetic Switchyard** (65 rail ways) | `graph-R+` | 260.05 | 0.05 | 11,032 | 33 | 0.662 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Station Hengelo** (67 rail ways) | `legacy` | 206.84 | 0.01 | 33,650 | 60 | 1.896 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Station Hengelo** (67 rail ways) | `graph` | 168.64 | 0.03 | 32,270 | 60 | 1.850 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Station Hengelo** (67 rail ways) | `graph-switches` | 208.75 | 0.04 | 32,970 | 60 | 1.895 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Station Hengelo** (67 rail ways) | `graph-R+` | 352.14 | 0.04 | 31,633 | 50 | 1.821 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Amsterdam Centraal** (325 rail ways, 181 elevated) | `legacy` | 619.65 | 111.91 | 145,334 | 163 | 7.386 | 0 | 0 | 0 | 0 | 0 | 181 |
| **Amsterdam Centraal** (325 rail ways, 181 elevated) | `graph` | 608.73 | 65.09 | 147,410 | 152 | 7.479 | 58 | 307 | 0 | 0 | 13 | 0 |
| **Amsterdam Centraal** (325 rail ways, 181 elevated) | `graph-switches` | 698.28 | 74.51 | 147,244 | 152 | 7.537 | 58 | 307 | 0 | 0 | 13 | 0 |
| **Amsterdam Centraal** (325 rail ways, 181 elevated) | `graph-R+` | 911.36 | 66.46 | 145,394 | 151 | 7.440 | 58 | 307 | 0 | 0 | 13 | 0 |
| **Holdout OSM** (192 features, 13 road bridges/tunnels) | `legacy` | 252.95 | 8.15 | 6,415 | 16 | 0.278 | 0 | 0 | 0 | 0 | 0 | 13 |
| **Holdout OSM** (192 features, 13 road bridges/tunnels) | `graph` | 347.31 | 5.81 | 6,603 | 16 | 0.283 | 23 | 0 | 0 | 0 | 3 | 0 |
| **Holdout OSM** (192 features, 13 road bridges/tunnels) | `graph-surface` | 345.47 | 3.48 | 9,999 | 16 | 0.375 | 23 | 0 | 0 | 0 | 3 | 0 |

## Acceptance Criteria
- [x] All 7 bridge-cliff defect classes investigated and covered by reproducible tests.
- [x] Authoritative graph-driven grade-transition and endpoint state resolution (`confirmed_transition`, `confirmed_elevated_continuation`, `boundary_clipped_continuation`, `unresolved_connection`, `intentionally_standalone`) implemented for roads and railways.
- [x] Horizontal ($< 0.01\text{ m}$ gap) and vertical continuity at confirmed road and railway bridge/tunnel portals.
- [x] Conservative handling of boundary-clipped, unresolved, and standalone endpoints (never synthesizing an approach ramp to ground on boundary-clipped or unresolved endpoints).
- [x] Existing road (`legacy`, `graph`, `graph-surface`) and railway (`legacy`, `graph`, `graph-switches`, `graph-R+`) rendering modes preserved with `legacy` remaining the production default.
- [x] Comprehensive automated tests in `src/world/GradeTransitionRendering.test.ts` covering all 13 required scenarios.
- [x] Performance and diagnostic instrumentation added and benchmarked.
- [x] Automated test, lint, build, and API documentation checks passing (`npm test`, `npm run lint`, `npm run build`, `npm run docs:api`).
- [x] Owner visual verification (visually accepted by project owner; remaining Amsterdam Centraal multi-level complexity noted).

