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
  - **Branching Vehicular Junctions (`requiresVehicularJunctionTrimming === true`)**: `solveBoundaryDerivedJunctionNode` and `validateAndTriangulateJunctionRing` construct localized road-footprint junction polygons using 100% full-width strictly orthogonal portals (`RoadEndPortal`), unclamped arc-length stub polylines (`extractPolylineSpan`), and curved local curb chains (`activeRightChain`, `activeLeftChain` with `polygonClipping.union` fallback) so roads never narrow near junctions or stretch into long triangular chord wedges. When a short or tightly curved arm's `trimDist` is clamped by edge length, 2D Boolean difference (`polygonClipping.difference`) subtracts `junctionMultiPoly` from the connecting ribbon and synchronizes `portalConnections` via `resolveEffectivePortalOnJunctionBoundary` (`<= 0.02 m` seam continuity, zero positive-area overlap).
   - **Degree-2 Continuity Joins (`requiresVehicularContinuityMiter === true` and path degree-2 joins)**: `applyDegree2SharedContinuityPortal` computes shared mitered cross-section portals (`halfW = (b0.width + b1.width) * 0.25 * miterScale`) without clamping portal width down by `firstSegmentLength * 0.75`, preserving full road width across curved ways with closely spaced vertices while validating against quad inversion.
   - **Cross-Tier & Path-Tier Handling**: ensure cross-tier-only footpath contacts (`isCrossTierOnlyInteraction === true`) never trigger vehicular asphalt junction trimming; subtract vehicular carriageway and junction footprints (including semicircular dead-end caps via `buildGraphRibbonPolygonRing`) from overlapping path/cycleway/steps footprints via 2D Boolean clipping (`polygonClipping.difference`) with `cleanPolylineForClipping` and `buildSafeExteriorSubPolylines` fallback; support pure path-tier junctions (`requiresPathJunctionTrimming === true`) and upward-wound (`+Y`) raised transverse treads (`generateGraphStepTreads`) for `highway=steps`.
   - **Authoritative Endpoint Caps & Grade-Transition Handoff**: suppress semicircular caps at boundary-clipped nodes, junctions, continuity miters, and authoritative graph grade-transition endpoints (`startGradeTransitionId`, `endGradeTransitionId`, `node.gradeTransitionIds`, or shared topological node with a non-at-grade road edge) — never via arbitrary coordinate proximity to unconnected bridges or tunnels.
   - **Multi-Segment Provenance, Curve-Preserving Ribbon Sanitization & Mesh Integrity Audit**: preserve `InspectableFeatureInfo` and `faceRanges` per constituent `EdgeSegmentProvenance` along simplified graph edges; preserve interior curve bends unless a vertex physically crosses behind the portal overhang (`segLen0 <= portalOverhang + bendOverhang + 0.05` in `sanitizeSubSegmentPolylineAndPortals`); verify upward `+Y` geometric face normals across all horizontal road, path, step-tread, and junction triangles via `validateAndPruneHorizontalGeometry` and `auditGraphRoadMeshIntegrity(roadsRoot)`.
3. **Comprehensive Automated Verification (`src/world/GraphRoadRendering.test.ts` — 16 tests)**:
   - Cover all 20 required topological/geometric scenarios, `auditGraphRoadMeshIntegrity()` upward geometric face normal and stored-normal agreement checks (including deliberate negative tests for reversed triangle indices with `+Y` vertex normals, crossed ribbon portals, and malformed/inverted junction triangles), edge-case junctions (15° acute Y-fork, unequal widths, 6-arm star junction, 4.5m short connector, P-loop, curved cross-tier road, nearby unconnected dead-end cap near bridge portal), transactional junction rejection, localized road-footprint regressions (straight road width preservation, curved road bend/width preservation, acute unequal-width Y-junction without exaggerated wedges, short inter-junction road, and strict exterior vertex invariance when adding a side road), 270-way dense urban road network benchmark (`102 / 102` junctions rendered, `0` rejected), `ZFightingValidator.validateRoadNetworkGeometry()`, mode isolation, and 10-permutation determinism.

## Acceptance criteria
- [x] `tickets/TKT-007-m2-3-e1-graph-renderer-adapter.md` closed with project-owner acceptance recorded and `145 / 145` Stage E1 test baseline preserved.
- [x] `InfrastructureRenderAdapter.ts` updated so `roads` supports `'legacy' | 'graph-preview' | 'graph'` while `railways` remains `'legacy' | 'graph-preview'`.
- [x] `src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts` implemented and integrated into `GeometryBuilder.buildScene()` when `roads === 'graph'`, without using legacy `splitRoadsAtSharedInteriorNodes` or `TopologicalNodeIndex` for at-grade roads.
- [x] Dedicated graph-road mesh integrity audit (`auditGraphRoadMeshIntegrity`) implemented, verifying actual indexed triangle winding (`cross(v1 - v0, v2 - v0)`), stored-normal agreement, and degenerate triangle separation, with deliberate negative tests proving detection of reversed indices, crossed portals, and inverted junction faces.
- [x] Localized road-footprint junction polygon synthesis (`solveBoundaryDerivedJunctionNode`, `extractPolylineSpan`, 100% full-width orthogonal portals, curved local curb chains, and 2D Boolean difference on clamped-trim approaches), non-pinching degree-2 continuity joins (`applyDegree2SharedContinuityPortal`), curve-preserving ribbon sanitization (`sanitizeSubSegmentPolylineAndPortals`), upward-wound step treads (`generateGraphStepTreads`), semicircular cap 2D clipping footprints (`buildGraphRibbonPolygonRing`), and authoritative graph-only grade-transition cap suppression implemented.
- [x] Elevated bridges, tunnels, portals, and grade-separated structures remain on Stage 6D without omission or duplication at grade transitions.
- [x] Comprehensive automated test suite (`src/world/GraphRoadRendering.test.ts` — `16` tests) passing via `npm test`, verifying all 20 topology cases, edge-case junctions, deliberate negative audit tests, localized road-footprint and curve/width preservation regressions, 270-way road-heavy urban benchmark, `ZFightingValidator` invariants, provenance/inspection across simplified edges, mode isolation, and 10-permutation determinism.
- [x] Documentation (`GEMINI.md`, `docs/STATUS.md`, `docs/architecture.md`, `docs/geometry-and-rendering.md`, `docs/testing-and-diagnostics.md`, and `docs/api-reference/`) updated to reflect `M2.3-E2`.
- [x] `npm test`, `npm run lint`, `npm run build`, and `npm run docs:api` executed and passing with zero errors.
- [ ] Project owner reviews Stage E2 implementation to close `TKT-008`.

## Implementation notes
- Stage E2 strictly excludes E3 (graph-driven railway rendering and switches), E4 (level crossings, bridge/tunnel transitions), and E5 (legacy cleanup).
- Stage B–D topology builders were not modified; `GraphRoadGeometryBuilder.ts` consumes `InfrastructureRenderDescriptorBundle` directly.
- During the E2 Geometry Stabilization pass, `auditGraphRoadMeshIntegrity` uncovered a genuine downward-wound (`-Y`) triangle bug in `highway=steps` tread quads (`appendFlatLineQuad` wound vertices `left0 -> right0 -> right1 -> left1` while storing `+Y` vertex normals); `generateGraphStepTreads` in `GraphRoadGeometryBuilder.ts` winds step-tread quads counter-clockwise (`+Y` geometric normal) so geometric and stored normals agree.
- Removed the `0.65 m` proximity heuristic against `allGradeTransitionCoords` from `touchesGradeTransitionStart` and `touchesGradeTransitionEnd` in `GraphRoadGeometryBuilder.ts` so nearby unconnected dead-end roads near bridge or tunnel portals keep their semicircular dead-end caps.
- Replaced warped junction portal pinching and aggressive curve-vertex deletion with localized road-footprint junction synthesis:
  1. `solveBoundaryDerivedJunctionNode` cuts each incident road arm at a localized `trimDist` (`localRadiusCap = Math.max(bBranch.width, maxBranchWidth) * 1.65`) using a 100% full-width strictly orthogonal portal (`leftPortal`, `rightPortal`) and extracts unclamped arc-length stub polylines (`extractPolylineSpan`) and curved curb chains (`activeRightChain`, `activeLeftChain`) along `[0, trimDist]`.
  2. `applyDegree2SharedContinuityPortal` no longer clamps `halfW` by `firstSegmentLength * 0.75`, preventing road narrowing on curved roads with closely spaced vertices.
  3. `sanitizeSubSegmentPolylineAndPortals` only removes an interior vertex if it physically crosses behind the portal overhang (`segLen0 <= portalOverhang + bendOverhang + 0.05`) instead of deleting all curve bends within `maxOverhang + width * 0.25`.

## Verification
- **Automated Tests (`npm test`)**: **161 / 161 passed, 0 failed** (`145` Stage E1 baseline tests + `16` Stage E2 tests in `src/world/GraphRoadRendering.test.ts` covering all 20 required scenarios, `auditGraphRoadMeshIntegrity()` upward geometric face normal and stored-normal agreement audit, deliberate negative winding/portal/junction audit tests, edge-case junction and short-segment stabilization, transactional junction rejection, localized road-footprint junction synthesis, straight/curved width & bend preservation, acute unequal-width Y-junctions without wedges, strict exterior vertex locality when adding a side road, authoritative grade-transition cap preservation, 270-way dense urban road network benchmark with `2,380` audited upward triangles, `102` rendered junctions, and `0` defects, `ZFightingValidator.validateRoadNetworkGeometry()` zero-overlap and zero-portal-gap invariants, multi-segment provenance inspection, source-of-truth isolation from `mapData.roads`, 10-permutation determinism, and mode isolation).
- **TypeScript Typecheck (`npm run lint`)**: **0 errors** (`tsc --noEmit`).
- **Production Build (`npm run build`)**: **Succeeded** (`vite build`).
- **API Documentation (`npm run docs:api`)**: **Succeeded** (`typedoc`).
- **Status**: `in_progress` pending project-owner review and acceptance.

### 2026-11-06 — Cycleway fork/crossing rendering correction (pending verification)
- Investigated the project-owner's annotated browser screenshot: green cycleway surfaces show remaining throat gaps and clipping around road crossings. The E2 builder only clips at-grade road surfaces, so an elevated bridge is not assumed to have caused the subtraction.
- Graph road rendering now also synthesizes path-only junctions at shared cross-tier nodes with at least two path half-edges; this does not create a vehicular junction.
- Vehicular junctions and ribbons are emitted first. Path junction patches are then clipped against actually emitted at-grade vehicular footprints, before path ribbons are built. Only successfully emitted junctions are registered for subsequent clipping.
- Added GraphRoadRendering.test.ts test 18 for a cycleway fork crossed by an unrelated at-grade road, a cross-tier path fork, and an elevated bridge, including path-surface coverage and provenance.
- Verification pending: These changes were committed through GitHub, but the npm commands cannot be executed in this environment. Previously recorded passing test counts predate the correction; they are not evidence of post-change success. TKT-008 remains in_progress.

### 2026-11-06 — Unequal-width two-arm connection correction (pending verification)
- Following owner feedback that cycleway connections still form square shoulders, corrected the concrete degree-2 width mismatch: `applyDegree2SharedContinuityPortal` no longer averages widths. Equal-width arms retain the existing miter; different-width arms use a graph-confirmed local junction patch.
- For nearly opposite through-arms with sufficient edge length, in either two-arm joins or three-arm forks, the patch contains a bounded local taper between the independently full-width orthogonal portals. At a three-arm fork the remaining branch is joined through a local Boolean union. Non-collinear or short cases retain the existing complete footprint union; widths outside the local transition remain unchanged.
- Added `GraphRoadRendering.test.ts` tests 19 and 20: a 6m-to-2m cycleway width transition and an unequal-width three-arm cycleway fork, checking full-width external approaches, local transition coverage without square shoulders, and source provenance.
- **Verification pending:** GitHub file-edit access cannot run `npm test`, `npm run lint`, `npm run build`, or `npm run docs:api` in the current environment. All earlier passing test totals predate this correction. Ticket remains `in_progress`; no owner sign-off recorded.

### 2026-11-06 — Post-quota regression recovery (pending execution)
- The latest agent test logs reported `164` total tests with `162` passing and `2` failing: E2 test 4's old three-junction expectation (a fourth width-transition patch is now correctly present), and E2 test 10's invalid road-network geometry in a large dataset. These outcomes were observed in Gemini's environment, not reproduced independently here.
- Reverted the later agent changes that weakened the overlap assertion, registered only the first polygon ring (discarding additional components and holes), and emitted path patches before vehicular road ribbons. The source now again clips against complete MultiPolygon footprints and respects vehicular-first path-clipping order.
- Constrained three-arm tapers to path-tier forks until their vehicular behavior is verified. Two-arm unequal-width transitions remain supported.
- Updated test 4 to recognize and inspect the width-transition patch; restored test 18, which the later agent had deleted. Test 18 checks visible cycleway surface coverage and source lineage without demanding a patch where another road completely occludes it.
- **Pending verification:** Run the focused `npx tsx --test src/world/GraphRoadRendering.test.ts` then `npm test`, `npm run lint`, `npm run build`, and `npm run docs:api`. No post-fix pass counts are claimed. TKT-008 stays `in_progress`.

## Related files and documentation
- Source: `src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`, `src/world/infrastructure/rendering/InfrastructureRenderAdapter.ts`, `src/world/GeometryBuilder.ts`, `typedoc.json`
- Tests: `src/world/GraphRoadRendering.test.ts`, `src/world/InfrastructureRenderAdapter.test.ts`
- Documentation: `docs/decisions/ADR-0002-boundary-derived-road-junction-meshing.md`, `docs/decisions/ADR-0009-infrastructure-graph-topology.md`, `docs/STATUS.md`, `docs/architecture.md`, `docs/geometry-and-rendering.md`, `docs/testing-and-diagnostics.md`, `GEMINI.md`
