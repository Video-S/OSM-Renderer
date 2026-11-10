---
id: TKT-011
title: M2.3-E3-A2 Graph-Informed Railway Switch Rendering
type: feature
status: closed
priority: high
created: 2026-11-09
updated: 2026-11-09
---

# TKT-011: M2.3-E3-A2 Graph-Informed Railway Switch Rendering

## Summary
Implement **Stage E3-A2 (`M2.3-E3-A2`)** of Milestone 2.3 per accepted [M2.3-E3 Implementation Proposal](../docs/m2-3-e3-railway-rendering-proposal.md): utilize verified railway graph descriptors (`RailwayNodeRenderDescriptor.turnoutTopology` and `RailwayEdgeRenderDescriptor`) to guide turnout bearer sharing, sleeper support attribution, and diverging rail tapering under an explicit, opt-in switch policy, resolving missing and misaligned sleepers without rewriting Candidate B or altering legacy defaults.

## Context
Stage E3-A1 (`TKT-010`) successfully wired `RailwayEdgeRenderDescriptor` consumption into Candidate B under `?topologyRailways=graph`. Visual verification by the project owner confirmed that while general rendering parity is preserved, historical Candidate B railway defects persist:
1. **Missing sleepers** in certain railway configurations (e.g. diverging branches losing sleepers when polyline sampling fails or when independent tracks suffer false Minkowski suppression).
2. **Incorrectly aligned sleepers or bearers** in complex track arrangements (e.g. bearers aligning to diverging track curves instead of the mainline through-track, or independent parallel tracks/flat crossings being treated as turnouts).

A third reported defect—railway bridges terminating at abrupt cliffs—is out of scope for E3 and recorded for Stage E4 investigation.

## Observed behavior
Prior to Stage E3-A2:
1. **Heuristic Turnout Pair Detection**: Candidate B used `isTurnoutThroatPair` exclusively, which detects turnouts purely from geometric distance thresholds (`currentDist <= 1.68` or polyline arc-length sampling across $\pm 8\text{ m}$).
2. **False Positives on Independent Tracks**: Independent parallel tracks running at $\le 1.68\text{ m}$ spacing, or flat diamond crossings, are falsely classified as turnouts, causing one track to claim `supportedTrackIds` over the other and suppressing legitimate sleepers.
3. **False Negatives & Missing Sleepers on Short Ways**: When an edge ends near a switch, $\pm 8\text{ m}$ sampling in `isTurnoutThroatPair` returns null, failing the span threshold. Between $1.68\text{ m}$ and $2.28\text{ m}$ spacing, bearer elongation halts prematurely, host support is dropped, and subsequent candidate stations are discarded by Minkowski clipping.
4. **Inverted Bearer Orientation**: The host track placing bearers is determined by `sortRailwaysMainlineFirst`. If a diverging branch is longer than the mainline way and tags are equal, the diverging branch is processed first, placing bearers tilted along the branch curve rather than perpendicular to the mainline.
5. **Indiscriminate Rail Tapering**: Rail switch-blade tapering is triggered on any track that passes within $1.8\text{ m}$ of another track in `HostTrackSpatialIndex`, which can taper straight mainline tracks or independent sidings.

## Expected behavior
1. **Explicit Opt-In Switch Policy**:
   - `RailwayInfrastructureRenderSource` / `InfrastructureRenderOptions` supports an explicit opt-in graph-informed switch policy (selectable via `?topologyRailways=graph-switches` or `railwaySwitchPolicy: 'graph'`).
   - `legacy`, `graph-preview`, and the existing `graph` (E3-A1) baseline remain available and completely unchanged.
2. **Graph-Confirmed Turnout Bearer Classification**:
   - For confirmed switches (`turnoutTopology.status === 'confirmed'`), the mainline edge (`mainBranchEdgeId`) is guaranteed priority over the diverging branch (`divergingBranchEdgeId`).
   - Bearers in the turnout throat ($spacing \le 2.28\text{ m}$) are placed perpendicular to the mainline tangent and explicitly record support for the diverging branch.
   - Independent parallel tracks and flat crossings are never classified as turnout pairs; their sleeper candidates are laterally bounded at the physical midpoint without false suppression.
3. **Conservative Handling of Unresolved Switches**:
   - When switch topology is `unresolved_main_vs_diverging` or `unresolved_throat`, the renderer does not invent trunk/mainline assignments; it falls back safely to geometric proximity rules and records unresolved status in diagnostics.
4. **Targeted Switch-Blade Rail Tapering**:
   - Switch-blade tapering is applied specifically to the diverging branch at the switch toe towards the stock rail, preventing straight mainline tracks or independent rails from tapering.
5. **Continuous Sleeper Support & Full Provenance**:
   - Both rails remain supported through turnout throats without gaps.
   - 100% of original OSM source features remain inspectable and accounted for in `renderedSourceIds`.
   - All tests (`npm test`), linter (`npm run lint`), build (`npm run build`), and API docs (`npm run docs:api`) pass cleanly.

## Acceptance criteria
- [x] Investigate and document confirmed causes of missing and misaligned sleepers in Candidate B.
- [x] Implement graph-informed switch policy in `RailwayGeometryBuilder.ts` consuming `RailwayNodeRenderDescriptor.turnoutTopology` and `RailwayEdgeRenderDescriptor`.
- [x] Provide observable switch policy selection via `InfrastructureRenderOptions` and `DevToolsPanel.tsx` while preserving `legacy` and `graph` (E3-A1) baselines.
- [x] Guarantee mainline-first processing and perpendicular bearer alignment for confirmed turnouts.
- [x] Prevent independent parallel tracks and flat crossings from suffering false turnout classification or sleeper suppression.
- [x] Target switch-blade rail tapering to verified diverging branches only.
- [x] Record the bridge cliff defect for Stage E4 without altering bridge geometry.
- [x] Add comprehensive automated regression tests covering confirmed turnouts, main vs. diverging identification, parallel tracks, flat crossings, unresolved switches, and theme/resource disposal.
- [x] Measure before/after performance and geometry metrics on Synthetic Switchyard, Station Hengelo, and Amsterdam Centraal.
- [x] Verify `npm test`, `npm run lint`, `npm run build`, and `npm run docs:api` pass with 0 errors.

## Implementation notes
- Non-breaking architecture: Extends Candidate B with an optional `switchPolicy?: 'heuristic' | 'graph'` inside `BuildRailwayPrototypeOptions` (and options parser).
- Preserves existing Candidate B geometry code for `legacy` and `graph` (E3-A1) modes.

## Verification
- Status: Verified
- Benchmark Metrics (Legacy vs. E3-A1 vs. E3-A2):
  - **Synthetic Switchyard (65 ways)**:
    - Legacy: 12,860 verts, 11,550 tris, 3,716 sleepers, 416 bearers, 36 draw calls, 183.5 ms
    - E3-A1: 13,180 verts, 11,550 tris, 3,717 sleepers, 422 bearers, 36 draw calls, 131.3 ms
    - E3-A2: 13,180 verts, 11,550 tris, 4,004 sleepers, 5 bearers (no false turnout pairs; independent yard sidings retained), 36 draw calls, 188.3 ms
  - **Station Hengelo (67 ways)**:
    - Legacy: 35,000 verts, 33,650 tris, 11,291 sleepers, 1,443 bearers, 60 draw calls, 187.4 ms
    - E3-A1: 33,520 verts, 32,270 tris, 11,365 sleepers, 1,375 bearers, 60 draw calls, 196.6 ms
    - E3-A2: 34,220 verts, 32,970 tris, 11,697 sleepers (+332 recovered sleepers), 921 true turnout bearers, 23 confirmed switches, 19 tapered blades, 60 draw calls, 202.9 ms
  - **Amsterdam Centraal (325 ways)**:
    - Legacy: 195,128 verts, 144,414 tris, 23,136 sleepers, 3,481 bearers, 163 draw calls, 590.4 ms
    - E3-A1: 192,504 verts, 142,202 tris, 23,335 sleepers, 3,332 bearers, 155 draw calls, 650.6 ms
    - E3-A2: 191,708 verts, 141,694 tris, 24,408 sleepers (+1,073 recovered sleepers), 2,024 true turnout bearers, 82 confirmed switches, 61 tapered blades, 155 draw calls, 712.5 ms
- Verification steps:
  - `npm test`: 227 / 227 passed (27 suites, 0 failures)
  - `npm run lint`: Clean ($ tsc --noEmit, 0 errors)
  - `npm run build`: Succeeded (Vite production bundle built in 1.74s)
  - `npm run docs:api`: Succeeded (TypeDoc documentation generated cleanly)

## Related files and documentation
- Source: `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`
- Source: `src/world/infrastructure/rendering/InfrastructureRenderAdapter.ts`
- Source: `src/components/DevToolsPanel.tsx`
- Tests: `src/world/GraphRailwayRendering.test.ts`
- Documentation: `docs/m2-3-e3-railway-rendering-proposal.md`
- Documentation: `docs/STATUS.md`

