---
id: TKT-002
title: M2.1 — Reproducible performance baseline and isolated railway-rendering prototype
type: tech_debt
status: closed
priority: high
created: 2026-10-31
updated: 2026-11-03
---

# TKT-002: M2.1 — Reproducible performance baseline and isolated railway-rendering prototype

## Summary
Establish a reproducible Goalpost 1 performance baseline across standardized datasets and build an isolated railway-rendering prototype to experimentally compare **Candidate A (Pure Procedural Multi-Layer UV Ribbons)** against **Candidate B (Hybrid Close-Zoom 3D Extruded Geometry + Medium/Far Procedural Ribbons)** across straight/curved tracks, single turnouts, scissors crossovers, dense multi-track station throats, and real OpenStreetMap railway extracts (`Station Hengelo` and `Amsterdam Centraal`) before any Milestone 2.2 (`TKT-001`) production integration decision.

## Context & Motivation
As documented in [`docs/goalpost-2-plan.md`](../docs/goalpost-2-plan.md) and [`TKT-001`](TKT-001-railway-overlap-brightness-and-sleeper-regression.md), the Goalpost 1 railway renderer suffers from luminance blooming in station throats, suppressed sleepers at turnouts and short chained ways, and sub-pixel moiré at overview zoom.

Before refactoring `src/world/GeometryBuilder.ts` or selecting a final railway rendering architecture for `TKT-001`, Milestone 2.1 (`M2.1`) requires:
1. Recording reproducible Goalpost 1 performance and memory baselines from a single raw JSON source of truth ([`docs/m2-1-baseline-data.json`](../docs/m2-1-baseline-data.json)) with explicit separation of cold vs. warm runs (`N = 5`, median and min–max spread), Node vs. browser builds, WebGL draw calls (`renderer.info.render.calls`) vs. `constructedMeshesCount`, vertex/triangle counts, CPU typed-array byte footprint, estimated GPU driver memory, and warmed-up baseline resource lifecycle verification.
2. Implementing an isolated railway prototype (`src/world/prototype/`) comparing **Candidate A** and **Candidate B** side-by-side without altering production `src/world/GeometryBuilder.ts` behavior.
3. Resolving Candidate B's missing sleepers around switches and crossings via topology-aware turnout bearer elongation (`absDist <= 2.28 m` at shallow turnout divergence angles `cosAngle > 0.86`) and exact 2D Minkowski interval clipping (`subtractLateralInterval` and `subtractIntervalFromList`) accelerated by a spatial hash grid, plus evaluating close-zoom sleeper densities (`0.60 m` physical spec, `0.725 m` half-harmonic default, and `1.45 m` sparse procedural period).
4. Enforcing geometric acceptance tests in [`src/world/PerformanceBaseline.test.ts`](../src/world/PerformanceBaseline.test.ts) verifying sleeper support beneath every rail ($\le 1.65\text{ m}$ max unsupported span, `0` unsupported rails), zero 2D OBB inter-track sleeper overlaps, shared turnout bearer geometry (`416` turnout bearers and `3,716` sleeper boxes in the 65-way switchyard), continuous rail geometry through crossings, and switch-blade taper without false pinching at colinear chained nodes.
5. Testing real OpenStreetMap railway extracts from **Station Hengelo** (`67` railway ways) and **Amsterdam Centraal** (`160` and `383` railway ways) alongside idealized synthetic fixtures.
6. Investigating and resolving Candidate B runtime performance on large real-world terminal networks under the architectural assumption of **pre-baked static maps**:
   - Evaluated 4 isolated configurations on Amsterdam Centraal (`420m` radius, `383` railways).
   - Validated Candidate B optimizations: 8m uniform spatial grid index, adaptive bridge deck sampling, multi-interval sleeper clipping, `THREE.InstancedMesh` 3D sleepers, 128m static spatial chunking with 59.4% frustum culling, and camera-drag raycast suppression.
   - Succeeded in reducing Amsterdam Centraal railway offline build time from **29,002 ms → 673 ms** (43.1× speedup) and buffer memory from **63.68 MB → 7.75 MB** (87.8% reduction).
   - Validated runtime smoothness: user manual observation confirms Amsterdam Central runs smoothly at **~144 FPS** on their machine (144 Hz display). Candidate B runtime performance is therefore no longer a blocker for M2.1.
   - Documented deferred finding: non-railway building draw-call amplification (2,537 WebGL draw calls per frame in Configuration A due to 1,226 ExtrudeGeometry groups preserved in `mergeWithFaceRanges()`), reserved for a separate future optimization task outside M2.1.
7. Investigating and resolving competing sleeper placement between closely spaced tracks (`1.85 m <= D <= 2.50 m`) in `src/world/prototype/RailwayPrototypeBuilder.ts`:
   - Distinguished genuine converging/diverging turnout throats (`isTurnoutThroatPair`) from independent closely spaced parallel tracks so parallel tracks never steal/suppress each other's sleepers via false turnout bearers.
   - Added explicit structural track association (`supportedTrackIds`) on `SleeperBearerBox3D` so adjacent parallel sleepers are never counted as support for another track's rails.
   - Implemented order-independent symmetric midpoint bounding ($D/2 - \text{gap}$), nearest-station host resolution (`minDAlong <= period * 0.62`), 3-track throat midpoint capping, and per-rail phase-nudge fallback (`±0.18 m, ±0.32 m`), verified by deterministic regression tests across straight, concentric curved, and short-chained parallel tracks (including normalized placement order-independence), a 5-track competing corridor, and a 3-track turnout + parallel throat, plus real-OSM integration/smoke verification (`6,549` sleeper boxes / `1,250` turnout bearers on Station Hengelo; `9,569` sleeper boxes / `1,322` turnout bearers on Amsterdam Centraal 180m; `22,470` sleeper boxes / `4,256` turnout bearers on Amsterdam Centraal 420m).

## Acceptance Criteria
- [x] Reproducible Goalpost 1, Candidate A, and Candidate B baseline measurements are recorded in a single source-of-truth JSON file ([`docs/m2-1-baseline-data.json`](../docs/m2-1-baseline-data.json)) with cold/warm runs (`N = 5`), medians, spreads, and hardware/driver/runtime metadata ([`docs/m2-1-railway-prototype-report.md`](../docs/m2-1-railway-prototype-report.md)).
- [x] All 7 performance/resource metrics are distinctly measured, including warmed-up baseline resource disposal checks ([`src/world/PerformanceBaseline.test.ts`](../src/world/PerformanceBaseline.test.ts), [`src/world/SceneResourceManager.ts`](../src/world/SceneResourceManager.ts), [`src/world/prototype/PerformanceBaselineHarness.ts`](../src/world/prototype/PerformanceBaselineHarness.ts)).
- [x] Candidate B's missing sleepers around switches, crossings, and closely spaced parallel tracks are resolved via topology-aware shared turnout bearers (`isTurnoutThroatPair`), order-independent symmetric midpoint bounding, and multi-interval Minkowski clipping (`subtractIntervalFromList`), verified by automated geometric acceptance and closely spaced track regression tests (`0` unsupported rails across `130` rails, max unsupported interval `1.200 m <= 1.65 m`, `0` overlapping 2D inter-track OBB pairs, `416` shared turnout bearers, and per-rail structural support + normalized order-independence across straight, curved, and chained 2-track corridors, 5-track competing corridors, and 3-track turnout throats).
- [x] Close-zoom sleeper densities (`0.60 m`, `0.725 m`, `1.45 m`), `HostTrackSpatialIndex` spatial-grid vs linear-scan costs, `THREE.InstancedMesh` with variable-length bearers, 128m static spatial chunks with 59.4% frustum culling, close-zoom stencil/depth behavior, and continuous zoom `4.3..4.7` LOD transitions are quantified and documented.
- [x] Controlled 4-configuration runtime comparison on full Amsterdam Centraal (`420m`) isolates non-railway map costs from railway geometry; Candidate B runtime performance is validated as smooth at ~144 FPS (user manual runtime observation).
- [x] Both candidates are visually tested and captured in the browser (`playwright-cli`) with `1:1` and `3x` crops across single turnouts, scissors crossovers, station throats, and short chained segments at `1.0x`, `3.0x`, `8.0x`, and `16.0x` zoom, plus all 4 themes (`tactical`, `daylight`, `dusk`, `blueprint`), and verified against real OSM data from Station Hengelo and Amsterdam Centraal.
- [x] M2.1 Decision Gate review sign-off by user before starting M2.2 (`TKT-001`).

## Verification Record
- **Automated Tests (`npm test`)**: Executed `tsx --test src/world/*.test.ts` — exit code `0`, **`82` tests passed** (`66` core Goalpost 1 tests + `16` M2.1 baseline, geometric acceptance, closely spaced track regression, density sweep, and real OSM integration/smoke verification tests in `src/world/PerformanceBaseline.test.ts`), `0` failed.
- **Single-Source Benchmark JSON (`npx tsx scripts/generate-baseline-json.ts`)**: Generated `docs/m2-1-baseline-data.json` (`N = 5` runs per configuration: 1 cold + 4 warm runs).
- **TypeScript Lint (`npm run lint`)**: Executed `tsc --noEmit` — exit code `0`.
- **Production Build (`npm run build`)**: Executed `vite build` — exit code `0`.
- **API Documentation (`npm run docs:api`)**: Executed `typedoc` — exit code `0`.
- **Browser Visual & Telemetry Verification (`playwright-cli`)**: Captured full-viewport screenshots, `1:1` and `3x` comparison crops (including Candidate B before/after fix crops), `16.0x` extreme-zoom views, 4-theme comparisons, and `zoom = 4.3..4.7` LOD transition frames in `/public/assets/m2-1-prototype/`.

## Related Files and Documentation
- M2.1 Deliverable Report: [`docs/m2-1-railway-prototype-report.md`](../docs/m2-1-railway-prototype-report.md)
- Single-Source Benchmark Data: [`docs/m2-1-baseline-data.json`](../docs/m2-1-baseline-data.json)
- Real OSM Railway Extracts: [`src/world/prototype/realOsmRailwayExtracts.json`](../src/world/prototype/realOsmRailwayExtracts.json)
- Plan: [`docs/goalpost-2-plan.md`](../docs/goalpost-2-plan.md)
- Related Ticket: [`tickets/TKT-001-railway-overlap-brightness-and-sleeper-regression.md`](TKT-001-railway-overlap-brightness-and-sleeper-regression.md)
