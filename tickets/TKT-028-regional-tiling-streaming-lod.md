---
id: TKT-028
title: Regional Tiling, Offline Baked Geometry, Streaming, and Orthographic LOD for Twente & Overijssel
type: feature
status: in_progress
priority: high
created: 2026-11-19
updated: 2026-11-20
related_tickets:
  - TKT-022
  - TKT-023
  - TKT-024
  - TKT-025
  - TKT-026
  - TKT-027
related_adrs:
  - ADR-0008
  - ADR-0009
  - ADR-0010
---

# TKT-028: Regional Tiling, Offline Baked Geometry, Streaming, and Orthographic LOD for Twente & Overijssel

## Summary
Design and incrementally implement a **baked-first hybrid** regional tiling, viewport streaming, and orthographic zoom-driven LOD architecture allowing seamless interactive exploration of **Twente** (~`45 × 35 km`) and eventually the entire province of **Overijssel** (`~88 × 82.6 km`) without loading the entire province into one scene or sacrificing E2+/R+ surface continuity, OSM feature provenance, or responsive camera navigation.

> **Current Status (`2026-11-20`)**: **`in_progress` — Milestone M1a Seam/Parity Fixes & A/B/C Diagnostics Implemented (Pending Project-Owner Local Windows Canonical Verification)**.
> Milestone **M1a** (ETRS89 / UTM Zone 32N `EPSG:25832` regional projection, deterministic `512 m` aligned Hengelo `8 × 8` tile grid, 2D/3D tile-box clipping, same-source single-scene reference parity & seam validation, explicit `64 m` collar sufficiency auditing, `A/B/C` diagnostic separation (`TiledDiagnostics.ts`), and resolution of all 68 canonical Hengelo verification defects + reporting bugs) is updated in the workspace.
> **M1b** (`OSMTILE1` binary codec, `overijssel-tiles-261114-8ae28196.sqlite` persistence, `ThemeMaterialRegistry`), **M2** (streaming runtime / `/api/tiles` / Workers / floating origin), **M3** (LOD1–LOD3 & `CameraController` `minZoom`), and **M4** (province-wide graph & bake) remain **unapproved / not implemented**.

## Context
- **E2+/R+ Sole Production Baseline (`TKT-026`, Closed)**: E2+ surface-first roads (`roads: 'graph-surface'`) and R+ railways (`railways: 'graph-R+'`) are formally approved and promoted across production, with `4 × 4 km` (`16 km²`, `96,836–98,087` features) producing `~2.65–2.67M` triangles, `~187–201 MB` retained CPU+BVH geometry buffers, and `10.49–31.18 s` synchronous `GeometryBuilder.buildScene()` builds (Run A/B).
- **Immutable Canonical Province Dataset (`TKT-027`, Closed)**: Geofabrik `overijssel-261114.osm.pbf` (`SHA-256: 8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0`) is verified and indexed offline in `data/osm/overijssel-261114-8ae28196.sqlite`. Because the province dataset is frozen, expensive topology construction, `E2+`/`R+` Boolean polygon clipping, and triangulation can be performed **offline once and stored/queried** instead of recomputed synchronously at runtime.
- **Why Single-Scene Loading Cannot Scale**: Loading Twente or full Overijssel into one `GeometryBuilder` scene exceeds browser heap/blocking limits, exhibits ~`1.7%` horizontal scale drift across `82.6 km` N–S under single-origin tangent equirectangular projection (`WorldCoordinates.ts`), degrades WebGL `Float32` precision far from `(0, 0, 0)`, hits `CameraController.tsx`'s `minZoom = 0.15` floor, and leaves regions outside `MapScene.tsx`'s hardcoded `±1,500 m` shadow frustum unshadowed.

## Scope & Architectural Decisions
1. **Baked-First Hybrid Architecture** (see full specification in [`docs/regional-tiling-streaming-lod-proposal.md`](../docs/regional-tiling-streaming-lod-proposal.md)):
   - Offline Stage A constructs a global `InfrastructureGraph` from `overijssel-261114-8ae28196.sqlite`, preserving OSM `way`/`node` provenance and cross-tile connectivity without artificial viewport splits.
   - Offline Stage B pre-bakes tile-local `Float32` binary geometry (`OSMTILE1`) with canonical `materialSlotKey` draw groups, `faceRanges`, `instanceInfos`, interned OSM tags, and optional LOD0 `MeshBVH` blobs into `overijssel-tiles-261114-8ae28196.sqlite`.
   - Runtime streams viewport tiles incrementally via `/api/tiles/...`, Web Worker decode, IndexedDB LRU cache, camera-relative floating-origin group transforms, a single shared `ThemeMaterialRegistry` (zero-rebuild 4-theme switching), texel-snapped target-tracking directional shadows, and `SceneResourceManager` disposal.
   - Live Overpass queries outside Overijssel and `DevToolsPanel` synthetic multiplier previews remain on the existing live single-region `GeometryBuilder` pipeline.
2. **M1a Key Findings — Projection, Footprint & `64 m` Collar Hypothesis**:
   - **Aligned Regional Grid vs. Legacy S5 Footprint**: M1a fixes **ETRS89 / UTM Zone 32N (`EPSG:25832`)** (`geoToUtm32N` / `utm32NToGeo` via 4th-order Krüger/Karney series, `< 1e-6 m` round-trip) with a shifted local origin (`+X` East, `+Y` Up, `+Z` South). The Hengelo M1a study grid (`8 × 8` aligned `512 m` tiles = **`4,096 m × 4,096 m`**) is explicitly distinct in extent and projection from the legacy `TKT-026` S5 `4,000 m` tangent-equirectangular benchmark footprint.
   - **`64 m` Collar Hypothesis Validated with Explicit Insufficiency Reporting (`CollarAudit.ts`)**: M1a treats the proposed `64 m` collar as a testable hypothesis rather than an assumed guarantee. Both synthetic stress testing and `CollarAudit` confirm that a raw `64 m` spatial collar **alone** is **insufficient without global/precomputed context** for:
     - macro planar polygons (`landuse`, `parks`, `waterBodies`) and large courtyard buildings extending `> 64 m` across tile borders (`planar_polygon_extends_beyond_collar`, `building_extends_beyond_collar`);
     - grade-separated bridge/tunnel ramp components exceeding `64 m` (`bridge_or_tunnel_component_exceeds_collar`);
     - global railway continuous track-phase propagation (`computeContinuousTrackPhases` across multi-tile connected components) and long road/barrier contexts (`railway_phase_or_switch_exceeds_collar`, `road_edge_or_blocker_exceeds_collar`, `barrier_structural_context_exceeds_collar`);
     - `GeometryBuilder`'s `MAX_SCENE_TREES = 2200` single-scene cap (`SceneTreeBudgetAudit`), which truncates large multi-tile forests globally while per-tile budgets do not.
    - **Seam Continuity & Canonical Defect Resolution in M1a**: Passing precomputed global `InfrastructureGraph` descriptors, `roadGradeSeparatedPlans`, `railwayGradeSeparatedPlans`, `railwayTrackPhases`, `tunnelEntrances`, `existingParkingSpaceBoxes`, and **precomputed global `planarResolution`** (`resolvedById` with global tunnel-portal cutouts + `polygonRingsById`) alongside hardened 2D/3D `MeshBoxClipper` (`[startFace, endFace)` half-open ranges, `Float32` horizontal triangle sliver preservation) and `GraphRoadGeometryBuilder` unconditional `registerRoadFootprint` + 3D `clipBufferGeometryToBoxXZ` fallback eliminates fake road end-caps, road area drops, coplanar overlaps, building `-1` parity mismatches, railway curved-bridge UV phase drift, and duplicate-forest tree/provenance drift while preserving 100% backward compatibility with non-tiled `GeometryBuilder` execution.
    - **Canonical `8 × 8` Hengelo Root Causes Fixed (`68` defects + `2` reporting bugs)**:
      1. *48 building `-1` triangle mismatches*: `SeamValidator.extractBuildingStatsFromScene` and `extractUpwardTrianglesXZ` treated half-open `[startFace, endFace)` ranges (`GeometryBuilder.mergeWithFaceRanges`) as inclusive (`endFace - startFace + 1`), inflating reference counts by `+1` wherever single-building tile buckets merged 2 material groups into 1 contiguous `FaceFeatureRange`. `MeshBoxClipper` also had an inclusive `faceIdx <= endFace` check fixed to half-open `<`.
      2. *6 road class area mismatches & 12 unmatched road seam vertex reports*: `GraphRoadGeometryBuilder` skipped `registerRoadFootprint` and discarded entire road segments when 2D-clipped `renderPolygons` produced empty Earcut shapes or `Float32`-degenerate horizontal triangles under `validateAndPruneHorizontalGeometry` (resolved via unconditional `registerRoadFootprint` + 3D `ShapeGeometry` -> `clipBufferGeometryToBoxXZ` fallback); `SeamValidator` Check D used asymmetric raw vertex proximity (flagging non-crossing cul-de-sacs and Earcut Steiner differences along shared seam edges), replaced with symmetric seam-aligned boundary-edge interval coverage + elevation continuity.
      3. *1 railway UV phase mismatch (`0.075829`)*: `RailwayGeometryBuilder` curved bridge adaptive sampling queried tile-dependent `hostIndex`, altering `profile3D` arc length across tiles (replaced with pure geometric curvature sampling; `SeamValidator` Check E also corrected from `% 1.0` to `visualSleeperPeriodMeters` `1.45 m` / `1.65 m` with exact-coordinate tie-breaking).
      4. *`+12` extra forest trees & `+6` extra `sourceFeatureIds`*: Per-tile `resolveAndValidatePlanarPolygons` lost global deduplication/subtraction context beyond `64 m` collars (resolved by precomputing `planarResolution` once in `ingestCanonicalStudyGeoJson` and adding `extraSourceFeatureIds` parity check in `SeamValidator`).
      5. *Reporting bugs*: `TiledStudyPipeline.peakMemory` updated on `heapUsedMB` alone (`rssMB` peak < `afterAllTiles`, fixed via per-field `Math.max` including `afterAllTiles`), and `CollarAudit` serialized `Infinity` tunnel portal distances as JSON `null` (sanitized via `finiteOrZero` and classified into `resolved_by_global_context` vs `tile_local_collar`).
      6. *Diagnostic A/B/C separation*: Added `TiledDiagnostics.runDiagnosticAbcComparison` (`--diagnose-abc` in `scripts/verify-hengelo-m1a.ts`) comparing **(A)** single-scene reference, **(B)** reference partitioned/clipped directly into 64 tiles, and **(C)** independently built M1a tiles.
3. **Non-Scope**: No gameplay mechanics, combat, physics simulation, traffic/agent AI, or large ECS frameworks (`GEMINI.md` / `docs/architecture.md`).

## Phased Milestones (M1 Split Into M1a & M1b)

- **Milestone M1a (Projection, Tile Grid, Seam Continuity & `64 m` Collar Validation — Implemented, Pending Owner Verification)**:
  - `src/world/tiling/RegionalProjection.ts`, `TileGrid.ts`, `MeshBoxClipper.ts`, `CollarAudit.ts`, `TiledStudyPipeline.ts`, `SeamValidator.ts`, `TiledDiagnostics.ts`, backward-compatible `tileClipBounds` / `precomputedGlobalPlans` hooks on `LocalGeoJsonProvider.ts`, `GeometryBuilder.ts`, `GraphRoadGeometryBuilder.ts`, `RailwayGeometryBuilder.ts`, and `SurfaceFirstRailwayBallast.ts`.
  - Tests & CLI: `src/world/TilingProjectionAndGrid.test.ts` (`7`), `src/world/TilingSeamContinuity.test.ts` (`5`), `src/world/TilingHengeloIntegration.test.ts` (disk-gated), and `scripts/verify-hengelo-m1a.ts` (with `--diagnose-abc`).
- **Milestone M1b (Offline Tile Baker, `OSMTILE1` Codec & `ThemeMaterialRegistry` — Unapproved / Future)**:
  - Incorporate M1a `CollarAudit` requirements (precomputed global graph/plans/phases + tile-local `Float32` transform + `OSMTILE1` binary serialization + `overijssel-tiles-261114-8ae28196.sqlite` + shared `ThemeMaterialRegistry` prototype).
- **Milestone M2 (Client Streaming Runtime, Floating Origin & Disposal — Unapproved / Future)**:
  - Express `/api/tiles/...` endpoint with `TKT-027` `source_sha256` + `bake_schema_version` compatibility guards, Web Worker binary decoder, frustum + hysteresis `TileStreamManager` (`AbortController` cancellation + bounded per-frame GPU commit budget), camera-relative floating-origin rendering, IndexedDB cache, dynamic camera-target shadow frustum, and zero-leak `TileResourceHandle` disposal.
- **Milestone M3 (Orthographic Zoom-Driven LOD1–LOD3 & Regional Navigation — Unapproved / Future)**:
  - Lower `CameraController` `minZoom` (`0.15` -> proposed `~0.015–0.02`), extend offline baker to `LOD1` (`1,024 m`), `LOD2` (`2,048 m`), and `LOD3` (`4,096 m`), and enforce atomic parent/child quadtree swaps (leaving coarse LOD visible until covering fine children commit).
- **Milestone M4 (Full Twente & Overijssel Scale-Out — Unapproved / Future)**:
  - Partitioned/streaming province-wide graph construction and full `OVERIJSSEL_BBOX` tile pack baking (`npm run osm:bake-overijssel-tiles`), disk/memory telemetry, and regional browser benchmarks.

## Acceptance Criteria
### Milestone M1a (Current Scope)
- [x] **Architecture Proposal Reviewed & M1a Scope Defined**: `M1a` projection, grid, seam continuity, and `64 m` collar validation separated cleanly from `M1b` binary baking and runtime streaming (`M2–M4`).
- [x] **EPSG:25832 Conformal Projection & Aligned Grid**: `RegionalProjection` implements exact 4th-order Krüger/Karney `EPSG:25832` projection (`< 1e-6 m` round-trip) with shifted Float64 origin (`+X` East, `+Y` Up, `+Z` South) and deterministic `8 × 8` `512 m` Hengelo study grid (`4,096 m × 4,096 m`) + half-open boundary ownership.
- [x] **Seamless Boundaries & Same-Source Reference Parity (Synthetic `2 × 2` Stress Suite)**: `0` fake road rounded end-caps on tile splits; `0` positive-area coplanar overlaps (`<= 1e-4 m²`); `0` cut/duplicated/missing seam buildings (`1:1` centroid parity); `0` railway 3D sleeper count mismatches; `<= 1e-3` railway UV phase discontinuity; `<= 1e-3 m` road/bridge/rail elevation discontinuity; `100%` OSM `sourceFeatureId` parity.
- [x] **Explicit `64 m` Collar Hypothesis Audit**: `CollarAudit` detects and reports `> 64 m` planar/building/bridge/tunnel/railway-phase/road/barrier boundary dependencies and `MAX_SCENE_TREES = 2200` cap divergence instead of silently truncating.
- [ ] **Owner Canonical Hengelo `8 × 8` SQLite Verification & M1a Review**: Project owner runs `npx tsx scripts/verify-hengelo-m1a.ts` (or disk-gated `TilingHengeloIntegration.test.ts`) locally on Windows against canonical `data/osm/overijssel-261114-8ae28196.sqlite` (`SHA-256: 8ae28196...`) and approves M1a.

### Milestones M1b–M4 (Future / Unapproved)
- [ ] **M1b Offline Binary Tile Codec & Shared Material Registry**: `OSMTILE1` codec, `overijssel-tiles-261114-8ae28196.sqlite`, `ThemeMaterialRegistry` 4-theme swap parity.
- [ ] **M2 Streaming Runtime, Floating Origin & Disposal**: `/api/tiles/...`, Worker decode, IndexedDB LRU, texel-snapped tracking shadows, `0` WebGL/CPU/BVH disposal leaks.
- [ ] **M3 Orthographic Zoom-Driven LOD & Camera Navigation**: `minZoom ~ 0.015–0.02`, `LOD1`–`LOD3`, atomic parent/child swaps with zero blank-hole frames.
- [ ] **M4 Regional Twente & Overijssel Rollout**: Province-wide graph + tile-pack bake validating against `overijssel-261114-8ae28196` (`SHA-256: 8ae28196...`).

## Verification
- **AI Studio Sandbox Verification (`2026-11-20`)**:
  - Sequential tiling suite (`DISABLE_OVERIJSSEL_BOOTSTRAP=1 npx tsx --test --test-concurrency=1 src/world/TilingProjectionAndGrid.test.ts src/world/TilingSeamContinuity.test.ts src/world/TilingHengeloIntegration.test.ts`): `12` passed, `0` failed, `1` skipped (`TilingHengeloIntegration.test.ts` skipped cleanly because `data/osm/overijssel-261114-8ae28196.sqlite` is absent on disk in the sandbox).
  - Sequential E2+ / R+ regression suite (`DISABLE_OVERIJSSEL_BOOTSTRAP=1 npx tsx --test --test-concurrency=1 src/world/GraphRoadRendering.test.ts src/world/RailwayRendering.test.ts`): `40` passed (`31` road + `9` railway), `0` failed.
  - TypeScript check (`npm run lint` / `tsc --noEmit`) & Production build (`npm run build` / `vite build`): verified clean (see final co-execution record).
- **Pending Project-Owner Local Windows Canonical Verification (PowerShell, Requires `data/osm/overijssel-261114-8ae28196.sqlite`)**:
  - Canonical Hengelo `8 × 8` CLI benchmark, A/B/C diagnostics & seam audit:
    ```powershell
    $env:DISABLE_OVERIJSSEL_BOOTSTRAP="1"
    npx tsx scripts/verify-hengelo-m1a.ts --diagnose-abc --json-out=benchmarks/results/tkt028-m1a-hengelo.json
    ```
  - Disk-gated integration test:
    ```powershell
    $env:DISABLE_OVERIJSSEL_BOOTSTRAP="1"
    npx tsx --test --test-concurrency=1 src/world/TilingHengeloIntegration.test.ts
    ```

## Related files and documentation
- Proposal: [`docs/regional-tiling-streaming-lod-proposal.md`](../docs/regional-tiling-streaming-lod-proposal.md)
- M1a Modules: `src/world/tiling/RegionalProjection.ts`, `src/world/tiling/TileGrid.ts`, `src/world/tiling/MeshBoxClipper.ts`, `src/world/tiling/CollarAudit.ts`, `src/world/tiling/TiledStudyPipeline.ts`, `src/world/tiling/SeamValidator.ts`, `src/world/tiling/TiledDiagnostics.ts`
- M1a Verification & Tests: `scripts/verify-hengelo-m1a.ts`, `src/world/TilingProjectionAndGrid.test.ts`, `src/world/TilingSeamContinuity.test.ts`, `src/world/TilingHengeloIntegration.test.ts`
- Related Docs: `docs/architecture.md`, `docs/camera-and-world-coordinates.md`, `docs/offline-overijssel-osm-dataset.md`, `docs/e2-plus-surface-first-road-rendering.md`, `docs/STATUS.md`
- Core Subsystems Referenced: `src/world/WorldCoordinates.ts`, `src/world/LocalGeoJsonProvider.ts`, `src/world/SceneResourceManager.ts`, `src/world/GeometryBuilder.ts`, `src/world/infrastructure/topology/InfrastructureGraph.ts`, `src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`, `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`, `src/world/infrastructure/railways/SurfaceFirstRailwayBallast.ts`, `src/scene/CameraController.tsx`, `src/scene/MapScene.tsx`, `src/server/osm/OverijsselOsmStore.ts`, `src/server/osm/overijsselBoundary.ts`
