---
id: TKT-009
title: Unified Developer Tools Interface and Reproduction Reporting
type: feature
status: closed
priority: high
created: 2026-11-07
updated: 2026-11-07
---

# TKT-009: Unified Developer Tools Interface and Reproduction Reporting

## Summary
Implement a discoverable, centralized Developer Tools interface replacing manual URL-parameter debugging (`?topologyRoads=...`, `?prototype=...`, `?fixture=...`, `?zone=...`, `?zoom=...`, `?azimuth=...`). Provide in-app runtime switching for road and railway rendering technologies, interactive geometry and junction inspection, spatial bounding-box selection with visual highlighting, self-contained JSON reproduction package export/import with original OSM context and graph metadata, and one-click loading of existing development fixtures.

## Context
As Milestone 2.3 progresses through Stage E, developers and the project owner frequently need to switch between legacy and graph-driven road renderers, inspect railway prototypes and topology previews, navigate to canonical fixtures (such as the southern Prins Hendrikkade acute cycleway fork and the M2.1 Switchyard), and capture isolated bug repros. Previously, this required manual URL string construction and browser reloads, which was error-prone, fragile, and difficult to manage.

## Observed behavior
Prior to this ticket:
1. Switching road or railway rendering modes (`topologyRoads=legacy|graph-preview|graph`, `prototype=disabled|production|candidateA|candidateB`) required manually editing the browser URL query string and reloading the page.
2. Development fixtures (`fixture=switchyard`, `fixture=prins-fork`, `zone=...`) could only be loaded via initial URL parameters.
3. Feature inspection was limited to individual raycast hovering/clicking on single meshes without interactive multi-feature spatial box selection, without topological junction or graph connectivity drill-down, and with no way to export a portable bug report.
4. Reporting a malformed junction required manual coordinate extraction, JSON file trimming, and ad-hoc communication.

## Expected behavior
1. **Centralized Developer State & In-App Drawer / Panel**:
   - Centralize developer configuration into explicit, unified application state (`DevToolsConfig` / `DevToolsState`).
   - Accessible via a discoverable Developer Tools button / panel in the UI without requiring page reloads or manual URL edits.
2. **Runtime Rendering Controls**:
   - Road renderer selector: `'legacy'` vs `'graph'` (plus `'graph-preview'`).
   - Railway renderer selector: clearly distinguishes production Candidate B from prototype modes (`candidateA`, `candidateB`, `disabled`) and graph topology preview (`graph-preview`), with accurate capability labels (no E3–E5 speculation).
   - Relevant diagnostic overlays (e.g., wireframe, topological graph nodes/edges overlay, boundary clip limits).
   - Instant in-memory reconstruction without page reload or losing camera position.
3. **Geometry & Junction Inspection with Highlighting**:
   - Click to inspect any road, railway, or junction, displaying OSM IDs, tags, coordinates, inferred physical widths, graph connectivity, and renderer provenance.
   - Interactive spatial bounding-box / area selection tool on the map canvas.
   - Distinct 3D visual highlighting overlay for selected feature(s) and incident graph elements.
4. **Issue Reporting & Self-Contained Reproduction Package**:
   - Provide a report creation UI with Title, Description, Expected Behavior, and Severity/Category.
   - Bundle selected OSM features, connected incident context (connected ways sharing OSM nodes within tolerance), relevant graph connectivity and render descriptors, active renderer configuration, camera pose, and developer notes into a self-contained `.json` package.
   - Export via instant file download and support importing previously saved `.json` reproduction packages to faithfully recreate the scenario.
   - Ensure extraction preserves original OSM node identities and does not create synthetic or false junctions.
5. **Fixture Library**:
   - Provide 1-click loading for existing fixtures (`M2.3-E2 Prins Hendrikkade Acute Fork`, `M2.1 Railway Switchyard Benchmark`, `Station Hengelo`, `Amsterdam Centraal`) directly from the panel.
6. **URL Compatibility**:
   - Maintain backward compatibility for existing URL parameters for automated testing while transitioning primary interactive usage to the UI.

## Acceptance criteria
- [x] Centralized developer configuration state managing rendering engines, fixtures, diagnostic overlays, inspection, and issue reporting without independent fractured states.
- [x] Runtime road rendering selector (`legacy` / `graph` / `graph-preview`) and railway mode selector updating the active 3D scene in-place without page reloads.
- [x] 1-click development fixture switcher for `prins-fork`, `switchyard` (with zone camera presets), `hengelo`, and `amsterdam`.
- [x] Interactive click inspection and spatial area selection highlighting selected geometry in 3D and displaying source OSM IDs, tags, inferred widths, and graph connectivity.
- [x] Self-contained JSON reproduction export and import reconstructing scene data, camera pose, configuration, and notes without manual URL editing.
- [x] Automated regression tests verifying configuration switching, selection/extraction, and report package export/import round-tripping.
- [x] `npm test`, `npm run lint`, `npm run build`, and `npm run docs:api` execute cleanly with zero errors.

## Implementation notes
- Strictly developer-only tooling; production rendering defaults remain unchanged.
- Railway controls reflect actual implemented capabilities (`production`, `candidateA`, `candidateB`, `disabled`, and `graph-preview` adapter preview), strictly excluding E3–E5 functionality.
- The reproduction export preserves `_nodeIds` and coordinates so when imported via `LocalGeoJsonProvider`, `RoadNetworkBuilder` and `GeometryBuilder` reproduce the exact same topological graph and geometry.
- Area Selection (Spatial Box Tool) disables `CameraController` / `MapControls` (`enabled={false}`, `enablePan={false}`, `enableRotate={false}`) while active, enabling smooth pointer click-and-drag raycasting on the metric ground plane ($Y=0$) with a live amber drag preview and cyan committed boundary box. Feature hover and individual clicks are suppressed during area selection.

## Verification
- Status: Closed / Verified
- Automated test command: `npm test` -> 181 passing tests (0 failures, 9 suites).
- Targeted test suite: `npx tsx --test src/world/DevToolsAndReproduction.test.ts` -> 8 passing tests (0 failures, 5 suites).
- Linting: `npm run lint` (`tsc --noEmit`) -> exit code 0 (clean).
- Build: `npm run build` (`vite build`) -> exit code 0 (clean).
- API Documentation: `npm run docs:api` (`typedoc`) -> exit code 0 (markdown generated at `./docs/api-reference`).

## Related files and documentation
- Source: `src/app/App.tsx`, `src/scene/CameraController.tsx`, `src/scene/MapScene.tsx`, `src/components/DevToolsPanel.tsx`, `src/world/dev/ReproductionReport.ts`, `src/world/GeometryBuilder.ts`
- Tests: `src/world/DevToolsAndReproduction.test.ts`
- Documentation: `docs/architecture.md`, `docs/testing-and-diagnostics.md`, `GEMINI.md`

