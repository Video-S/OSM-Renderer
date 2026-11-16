---
id: TKT-021
title: End-to-End Map Loading Performance Investigation & Pipeline Instrumentation
type: investigation
status: in_progress
priority: high
created: 2026-11-16
updated: 2026-11-16
---

# TKT-021: End-to-End Map Loading Performance Investigation & Pipeline Instrumentation

## Summary
Although `TKT-020` drastically accelerated `GeometryBuilder.buildScene()` (e.g., `"2. Offline Build"` reporting **527.7 ms** in Google AI Studio), perceived map loading time in the live browser application remains noticeably slow. This ticket tracks the diagnostic investigation and request-scoped end-to-end timing instrumentation from initial load initiation (or user selection) until the **first rendered WebGL frame** of the requested scene.

**Strict Scope Boundaries**:
- **Diagnostic & instrumentation only** — do not optimize performance, add new caching layers, redesign the request pipeline, introduce web workers/tiling, or alter geometry/OSM output semantics in this ticket.
- **Keep `status: in_progress`** until an actual end-to-end browser measurement from Google AI Studio / local live OSM load has been captured and reviewed.
- **Preserve existing loading UI behavior** (do not fix the premature `setLoading(false)` bug yet — measure and document it first).

---

## 1. Confirmed Structural & Pipeline Findings

Static trace of `src/app/App.tsx`, `src/world/OsmApiProvider.ts`, `src/world/LocalGeoJsonProvider.ts`, `src/world/GeometryBuilder.ts`, `src/scene/MapScene.tsx`, `server.ts`, and `src/components/DevToolsPanel.tsx` establishes why `"2. Offline Build"` (`527.7 ms`) captures only a fraction of real perceived latency:

1. **`"2. Offline Build"` Measures Only `GeometryBuilder.buildScene()`**:
   - `cpuBuildTimeMs` in `src/app/App.tsx` wraps only `builder.buildScene(sceneData, currentTheme)`.
   - Every stage **before** `buildScene()` and **after** `setBuiltGeometry(scene)` is completely omitted from the `"2. Offline Build"` stat:
     1. `/api/osm-data` server request + cold Overpass API query (`https://overpass-api.de/api/interpreter` or OSM 0.6 XML fallback for `radius <= 600`) + synchronous server `osmtogeojson` conversion + synchronous `enrichGeoJsonWithOverpassNodeIds` + server JSON serialization (`server.ts`).
     2. HTTP response transfer & browser `JSON.parse()` decoding (`src/world/OsmApiProvider.ts`).
     3. Client synchronous `LocalGeoJsonProvider.parseGeoJson(...)`: coordinate projection, polygon & polyline clipping, stream/obstacle pre-scan, `TopologicalNodeIndex` endpoint snapping, legacy `chainContiguousRoads`, and `TopologySourceData` capture.
     4. Synchronous `console.group` + `console.table` diagnostics call on every live OSM load (`src/app/App.tsx`).
     5. Synchronous React render `useMemo` running `prepareInfrastructureRenderPreview(...)` when graph/E2/E2+/E3 modes are active (`src/app/App.tsx`).
     6. Post-`setBuiltGeometry` scene presentation cost: React reconciliation + Three.js `<Canvas>` / `MapScene` mount (on cold start) + `buildCachedRailwayIndex` in `useLayoutEffect` + WebGL vertex/index buffer uploads + WebGL shader program compilation + first `gl.render()` pass.

2. **Confirmed Defect — Loading Overlay Deactivates Prematurely (Documented, Not Fixed Yet)**:
   - `fetchLiveOsmLocation` (`src/app/App.tsx`) calls `setMapData(parsedData)` and immediately calls `setLoading(false)` **right after `parseGeoJson()` completes** — **before**:
     - `infrastructureRenderPreview` (`useMemo`)
     - `GeometryBuilder.buildScene()` (`useEffect`)
     - `buildRailwayPrototypeGroup()` (when active)
     - React `<Canvas>` mount & Three.js scene commit
     - WebGL buffer uploads, shader compilation, and first rendered frame (`gl.render()`).
   - The exact same premature `setLoading(false)` timing occurs in `loadSwitchyardFixture`, `loadPrinsHendrikkadeForkFixture`, `handleImportReproductionPackage`, and `handleFileUpload`.
   - User impact: the spinner overlay vanishes while the viewport is still dark/blank or frozen on the main thread during geometry build and WebGL shader compilation, making perceived load behavior confusing and hiding expensive client build/render stalls behind a blank canvas.

3. **Duplicate StrictMode Initial Mount Protection**:
   - While `src/main.tsx` currently renders `<App />` without `<React.StrictMode>`, `App.tsx` had no mount guard on its initial `useEffect(..., [])`. Adding an `initialMountLoadStartedRef` guard ensures instrumentation never logs duplicate startup requests if StrictMode is enabled later.

4. **Missing Server Timing & Cold/Warm Cache Visibility**:
   - `server.ts` maintains a 30-minute bounded LRU `osmCache`, meaning a second request for the same `(lat, lon, radius)` skips Overpass/XML completely, while the first request waits on external Overpass API + `osmtogeojson` + enrichment. Previously no `Server-Timing` or `X-OSM-Cache` headers were emitted, making cold vs. warm runs indistinguishable client-side.

---

## 2. Implemented Instrumentation (`TKT-021`)

- **`src/world/dev/MapLoadDiagnostics.ts`**:
  - Request-scoped monotonic `MapLoadTimelineTracker` assigning unique `requestId`s, tracking:
    - `osmRequestMs` (HTTP request wait to headers)
    - `dataTransferAndDecodeMs` (`responseTransferMs` via `res.text()` + `jsonDecodeMs` via `JSON.parse()`)
    - `geoJsonProcessingMs` (plus `boundsAndPreScanMs`, `featureClipAndExtractMs`, `roadChainingAndStatsMs`)
    - `consoleDiagnosticsMs`
    - `infrastructurePreparationMs` (`0 ms` in default `legacy` mode)
    - `sceneGeometryMs` (`GeometryBuilder.buildScene()` + optional prototype railway build)
    - `scenePresentationMs` (commit -> first `MapScene` `gl.render()` for that exact `sceneRevision` where `webglFramesRendered === 1`)
    - `reactSchedulingGapMs` & `unaccountedOverheadMs` (exact delta `totalLoadingMs - accountedMs` so `accounted + unaccounted === total`)
    - `spinner.spinnerHiddenAtMs` and `spinner.prematureSpinnerHideMs` quantifying how long the spinner hid before the first WebGL frame
    - Cold (`cold_miss`) vs. warm (`warm_hit`) vs. `not_applicable` server cache status + parsed `Server-Timing` breakdown + payload byte sizes & ResourceTiming sizes when exposed.
  - Handles superseded overlapping requests (`status: 'superseded'`), failures (`status: 'failed'`), bounded history (`MAX_MAP_LOAD_HISTORY = 10`), and ignores subsequent slider/theme/mode re-renders on an already-presented `requestId`.
- **`server.ts`**: Emits `Server-Timing` (`cache`, `upstream`, `osmtogeojson`, `enrich`, `total`), `X-OSM-Cache` (`HIT` / `MISS`), `X-OSM-Source` (`cache` / `overpass` / `osm-xml`), and `X-OSM-Feature-Count` headers on `/api/osm-data` without changing the JSON response body.
- **`src/world/OsmApiProvider.ts` & `src/world/LocalGeoJsonProvider.ts`**: Capture transfer/decode/parse metrics and sub-stage timings cleanly without changing `ProcessedMapData`.
- **`src/app/App.tsx`**: Wires all load entrypoints (`fetchLiveOsmLocation`, presets, address search, `loadSwitchyardFixture`, `loadPrinsHendrikkadeForkFixture`, `handleFileUpload`, `handleImportReproductionPackage`, `__M21_LAB__.loadOfflineDataset`) plus `handleSceneRevisionRendered`. Exposes `window.__M21_LAB__.getMapLoadDiagnostics()`.
- **`src/components/DevToolsPanel.tsx`**: Adds **End-to-End Load Diagnostics** inside the `Rendering` tab with **Copy Diagnostics** (structured JSON clipboard copy) so measurements from Google AI Studio or local Windows browsers can be pasted cleanly.

---

## 3. Verification Record

- **Focused tests** (`npx tsx --test src/world/MapLoadDiagnostics.test.ts src/world/GeometryBuilder.test.ts src/world/PlanarAndRoadSpatialIndex.test.ts benchmarks/BenchmarkReliability.test.ts`): **25/25 passed** (`fail 0`, `src/world/MapLoadDiagnostics.test.ts` verified `Server-Timing` / `X-OSM-Cache` header parsing, superseded/failed request lifecycle, bounded history cap of 10, real local HTTP `/api/osm-data` cold miss vs. warm hit separation with separated transfer/decode/parse timings, `< 2 ms` instrumentation overhead, and identical `ProcessedMapData` & `GeometryBuilder` scene output).
- **TypeScript check & build & lint**: `npx tsc --noEmit`, `compile_applet` (Vite production build), and `lint_applet` passed cleanly with 0 errors.
- **API documentation check**: `npm run docs:api` (`typedoc`) generated `./docs/api-reference` with 0 errors (2 benign warnings referencing internal type aliases in `src/world/dev/MapLoadDiagnostics.ts`).
- **Container network/browser limits**:
  - Headless Playwright browser launch could not run in this container because the Chromium binary is not installed at `/ms-playwright/`.
  - Direct probe to local `http://localhost:3000/api/osm-data` timed out at 15s waiting on external `overpass-api.de` from the sandboxed container.
  - Because no live end-to-end browser capture against real OSM data has been reviewed yet, **`TKT-021` remains `in_progress`**.

---

## 4. Open Items & Next Steps

1. Collect real end-to-end diagnostic JSON from Google AI Studio (cold initial load + warm repeat load) and local Windows dev server via **Dev Tools -> Rendering -> End-to-End Load Diagnostics -> Copy Diagnostics**.
2. Review which stage(s) dominate the real-world total wait (e.g., cold Overpass upstream API vs. server conversion vs. network transfer vs. WebGL first-frame shader compile vs. React overhead).
3. Only after reviewing measured end-to-end data, scope follow-up optimization/UX fix tickets (including fixing the premature `setLoading(false)` timing).
