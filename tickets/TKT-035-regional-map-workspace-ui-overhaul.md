---
id: TKT-035
title: Regional Map Workspace — Complete UI Overhaul & Offline Local Search
type: feature
status: in_progress
priority: high
created: 2026-11-24
updated: 2026-11-24
---

# TKT-035: Regional Map Workspace — Complete UI Overhaul & Offline Local Search

## Summary

Replace the legacy location-preset/worldwide-search/floating-card UI (`AddressSearchModal.tsx`, `DevToolsPanel.tsx`, bottom dock, top header, fixture presets) with a map-first 3-region engineering workspace that boots directly into the active baked regional mosaic (`/api/tiles-region`) and replaces external Photon/Overpass geocoding with a local offline SQLite FTS5 search index derived from `OverijsselOsmStore`.

## Context

Following completion of the offline baked regional pilot (`TKT-033`) and full-Twente mosaic bake baseline (`TKT-034`), the application architecture is a persistent offline regional world renderer rather than a live-OSM location fetcher. The prior UI surfaced obsolete worldwide presets, `/api/geocode` network calls, overlapping tool panels, and mixed developer controls.

## Acceptance criteria

- [x] Boot directly into the configured baked regional mosaic (`/api/tiles-region/manifest`) with a coherent missing-mosaic error/retry screen when absent (no live-OSM or external geocoder fallback).
- [x] Implement 3-region workspace layout: collapsible/compact/hidden left `NavigationSidebar` (`Search`, `Layers`, `Appearance`, `Inspector`, `Performance`, `Diagnostics`, `World`), central WebGL `flex-1` viewport without `<Canvas>` remounts or camera resets on UI toggles, and scrollable `340px` right `ContextSidebar` (one panel open at a time, persisted in `localStorage`).
- [x] Provide floating viewport `CameraToolbar` (rotate left/right 45°, live compass orientation, zoom in/out clamped to `cameraZoomPolicy`, reset, frame world, hide toolbar) and accessible restore control in immersive/hidden mode.
- [x] Remove obsolete `AddressSearchModal.tsx`, `DevToolsPanel.tsx`, `/api/geocode`, live OSM presets, GeoJSON upload/export buttons, and `"Live OSM Carto"` branding while preserving URL test/benchmark flags (`?benchmark=1`, `?fixture=...`, `?m1a=1`, `?m2a=1`, `?dock=collapsed`, `?tab=...`) and `window.__M21_LAB__` / `window.__BENCHMARK_HARNESS__`.
- [x] Implement local offline SQLite FTS5 search index (`*.search.sqlite`), CLI (`npm run osm:build-search-index`), HTTP API (`/api/search`, `/api/search/status`, `/api/search/build`), mosaic coverage checking (`covered`, `empty_tile`, `outside_mosaic`, `unknown`), and `SearchPanel`.
- [x] Pass TypeScript lint (`tsc --noEmit`), Vite production build (`npm run build`), unit/HTTP search tests, and automated headless Playwright E2E workspace tests against a synthetic temp mosaic and SQLite store.
- [ ] Owner runtime & visual evaluation on hardware against the real `overijssel-261114-8ae28196.sqlite` search build and `twente-pilot` / `twente-full` mosaics.

## Implementation notes

- **Workspace Shell & Panels (`src/components/workspace/`):**
  - `workspaceTypes.ts`: pure state transitions, legacy `?tab=` mapping, `localStorage` persistence (`osm-renderer-workspace-prefs-v1`), search/repro session types.
  - `NavigationSidebar.tsx`: `expanded` (`200px`), `compact` (`48px`), `hidden` states; camera toolbar visibility toggle; `Hide All UI` immersive mode.
  - `ContextSidebar.tsx` + `panels/`: `SearchPanel.tsx`, `LayersPanel.tsx`, `AppearancePanel.tsx` (locks pre-baked geometry multipliers in `OSMTILE1` mode), `InspectorPanel.tsx`, `PerformancePanel.tsx` (gates `trackTelemetry` / `trackFps`), `DiagnosticsPanel.tsx` (overlays, E2+/R+ stats, load diagnostics, repro package export/import), `WorldPanel.tsx` (derives mosaic identity, `TileManifestCoverageSummary`, UTM/Geo bounds, populated vs empty tile counts, and `cameraZoomPolicy` strictly from the loaded `TileStreamManager` manifest).
  - Non-destructive viewport picking: clicking 3D features updates selection without switching or opening panels, revealing a bottom-left `viewport-selection-chip` when Inspector is closed.
- **Offline SQLite FTS5 Search (`src/server/osm/OverijsselSearchIndex.ts`, `searchDataHandler.ts`, `scripts/build-overijssel-search-index.ts`):**
  - Tokenizes with `unicode61 remove_diacritics 2`, verifies parent spatial DB SHA-256 & snapshot provenance, deduplicates split street segments within ~1.5 km grid cells / ~2 km visible cells while keeping identical street names in separate settlements distinct, fills missing locality labels from nearest OSM settlement, and evaluates mosaic tile coverage via `RegionalMosaicHttpHandler.getCoverageSnapshot()`.

## Verification

- **Executed & Passed (Sandbox Synthetic / Temp Fixture Verification — 2026-11-24):**
  - `npm run lint` (`tsc --noEmit`): exit 0, 0 errors.
  - `npm run build` (`vite build` / `compile_applet`): exit 0, compiled cleanly.
  - `npx tsx --test src/world/OverijsselSearchIndex.test.ts`: **3 / 3 passed** (index build, FTS5 exact/prefix/diacritic/punctuation ranking, split-street dedup, provenance mismatch rejection, mosaic coverage statuses, HTTP endpoints).
  - `npx tsx --test src/world/WorkspaceUiAndSearch.test.ts`: **3 / 3 passed** (pure workspace state helpers, obsolete file/route removal checks, and headless Playwright Chromium SwiftShader E2E test against a real baked temp 4×4 `OSMTILE1` mosaic + temp FTS5 SQLite DB verifying direct regional boot, zero `/api/geocode`/external requests, `<Canvas>` identity preservation across UI collapses, `localStorage` persistence across reload, compass/zoom-out clamping at `0.15x`, and disabled `empty_tile`/`outside_mosaic` search items vs navigable `covered` navigation).
  - `npx tsx --test --test-concurrency=1 src/world/OverijsselSearchIndex.test.ts src/world/WorkspaceUiAndSearch.test.ts src/world/RegionalMosaicIdentityAndZoomPolicy.test.ts src/world/TilingRegionalMosaic.test.ts src/world/OverijsselOfflineStore.test.ts src/world/DevToolsAndReproduction.test.ts`: **38 passed, 0 failed, 1 skipped** (full Overijssel snapshot test skipped because `overijssel-261114-8ae28196.sqlite` is absent in sandbox).
- **Not Executed / Pending Owner Hardware Verification:**
  - Indexing the full canonical `overijssel-261114-8ae28196.sqlite` into `overijssel-261114-8ae28196.search.sqlite` (`npm run osm:build-search-index`) and interactive visual/UX acceptance with live `twente-pilot-1024m-tkt033-candidate` and `twente-full-1024m` mosaics on the owner's machine.

## Related files and documentation

- Source: `src/app/App.tsx`, `src/components/workspace/*`, `src/scene/CameraController.tsx`, `src/scene/MapScene.tsx`, `src/world/tiling/TileStreamManager.ts`, `src/server/osm/OverijsselSearchIndex.ts`, `src/server/osm/searchDataHandler.ts`, `src/server/osm/overijsselConfig.ts`, `src/server/tiles/RegionalMosaicHttpHandler.ts`, `server.ts`, `scripts/build-overijssel-search-index.ts`
- Tests: `src/world/OverijsselSearchIndex.test.ts`, `src/world/WorkspaceUiAndSearch.test.ts`
- Documentation: [docs/STATUS.md](../docs/STATUS.md), [docs/architecture/overview.md](../docs/architecture/overview.md), [docs/architecture/offline-overijssel-osm-dataset.md](../docs/architecture/offline-overijssel-osm-dataset.md), [docs/guides/testing-and-diagnostics.md](../docs/guides/testing-and-diagnostics.md), [README.md](../README.md)
