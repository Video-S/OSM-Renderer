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

> **Current Status (`2026-11-20`)**: **`in_progress` — Milestone M1a Remaining 20 Canonical Defects & A/B/C Diagnostic Failures Resolved (Pending Project-Owner Local Windows Canonical Verification)**.
> Milestone **M1a** (ETRS89 / UTM Zone 32N `EPSG:25832` regional projection, deterministic `512 m` aligned Hengelo `8 × 8` tile grid, 3D tile-box triangle clipping over precomputed regional geometry plans, same-source single-scene reference parity & seam validation, explicit `64 m` collar sufficiency auditing, `A/B/C` diagnostic conservation (`TiledDiagnostics.ts`), and resolution of both the initial 68 defects and the remaining 20 canonical verification defects + `A -> B` / `B -> C` diagnostic discrepancies) is updated in the workspace.
> **M1b** (`OSMTILE1` binary codec, `overijssel-tiles-261114-8ae28196.sqlite` persistence, `ThemeMaterialRegistry`), **M2** (streaming runtime / `/api/tiles` / Workers / floating origin), **M3** (LOD1–LOD3 & `CameraController` `minZoom`), and **M4** (province-wide graph & bake) remain **unapproved / not implemented**.

## Context
- **E2+/R+ Sole Production Baseline (`TKT-026`, Closed)**: E2+ surface-first roads (`roads: 'graph-surface'`) and R+ railways (`railways: 'graph-R+'`) are formally approved and promoted across production, with `4 × 4 km` (`16 km²`, `96,836–98,087` features) producing `~2.65–2.67M` triangles, `~187–201 MB` retained CPU+BVH geometry buffers, and `10.49–31.18 s` synchronous `GeometryBuilder.buildScene()` builds (Run A/B).
- **Immutable Canonical Province Dataset (`TKT-027`, Closed)**: Geofabrik `overijssel-261114.osm.pbf` (`SHA-256: 8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0`) is verified and indexed offline in `data/osm/overijssel-261114-8ae28196.sqlite`. Because the province dataset is frozen, expensive topology construction, `E2+`/`R+` Boolean polygon clipping, and triangulation can be performed **offline once and stored/queried** instead of recomputed synchronously at runtime.
- **Why Single-Scene Loading Cannot Scale**: Loading Twente or full Overijssel into one `GeometryBuilder` scene exceeds browser heap/blocking limits, exhibits ~`1.7%` horizontal scale drift across `82.6 km` N–S under single-origin tangent equirectangular projection (`WorldCoordinates.ts`), degrades WebGL `Float32` precision far from `(0, 0, 0)`, hits `CameraController.tsx`'s `minZoom = 0.15` floor, and leaves regions outside `MapScene.tsx`'s hardcoded `±1,500 m` shadow frustum unshadowed.

## Scope & Architectural Decisions
1. **Baked-First Hybrid Architecture** (see full specification in [`docs/regional-tiling-streaming-lod-proposal.md`](../docs/regional-tiling-streaming-lod-proposal.md)):
   - Offline Stage A constructs a global `InfrastructureGraph` from `overijssel-261114-8ae28196.sqlite`, preserving OSM `way`/`node` provenance and cross-tile connectivity without artificial viewport splits.
   - Offline Stage B pre-bakes tile-local `Float32` binary geometry (`OSMTILE1`) in bounded regional synthesis macro-blocks (`e.g. 4 × 4` or `8 × 8` tiles + collar, triangulated once and clipped per `512 m` tile in 3D via `clipBufferGeometryToBoxXZ`) with canonical `materialSlotKey` draw groups, `faceRanges`, `instanceInfos`, interned OSM tags, and optional LOD0 `MeshBVH` blobs into `overijssel-tiles-261114-8ae28196.sqlite`.
   - Runtime streams viewport tiles incrementally via `/api/tiles/...`, Web Worker decode, IndexedDB LRU cache, camera-relative floating-origin group transforms, a single shared `ThemeMaterialRegistry` (zero-rebuild 4-theme switching), texel-snapped target-tracking directional shadows, and `SceneResourceManager` disposal.
   - Live Overpass queries outside Overijssel and `DevToolsPanel` synthetic multiplier previews remain on the existing live single-region `GeometryBuilder` pipeline.
2. **M1a Key Findings — Projection, Footprint & `64 m` Collar Hypothesis**:
   - **Aligned Regional Grid vs. Legacy S5 Footprint**: M1a fixes **ETRS89 / UTM Zone 32N (`EPSG:25832`)** (`geoToUtm32N` / `utm32NToGeo` via 4th-order Krüger/Karney series, `< 1e-6 m` round-trip) with a shifted local origin (`+X` East, `+Y` Up, `+Z` South). The Hengelo M1a study grid (`8 × 8` aligned `512 m` tiles = **`4,096 m × 4,096 m`**) is explicitly distinct in extent and projection from the legacy `TKT-026` S5 `4,000 m` tangent-equirectangular benchmark footprint.
   - **`64 m` Collar Hypothesis Validated with Explicit Insufficiency Reporting (`CollarAudit.ts`)**: M1a treats the proposed `64 m` collar as a testable hypothesis rather than an assumed guarantee. Both synthetic stress testing and `CollarAudit` confirm that a raw `64 m` spatial collar **alone** is **insufficient without global/precomputed context** for:
     - macro planar polygons (`landuse`, `parks`, `waterBodies`) and large courtyard buildings extending `> 64 m` across tile borders (`planar_polygon_extends_beyond_collar`, `building_extends_beyond_collar`);
     - grade-separated bridge/tunnel ramp components exceeding `64 m` (`bridge_or_tunnel_component_exceeds_collar`);
     - global railway continuous track-phase propagation (`computeContinuousTrackPhases` across multi-tile connected components), at-grade railway densification near chamfered host tracks, and long road/barrier contexts (`railway_phase_or_switch_exceeds_collar`, `road_edge_or_blocker_exceeds_collar`, `barrier_structural_context_exceeds_collar`);
     - `GeometryBuilder`'s `MAX_SCENE_TREES = 2200` single-scene cap (`SceneTreeBudgetAudit`), which truncates large multi-tile forests globally while per-tile budgets do not.
   - **Initial Canonical `8 × 8` Hengelo Root Causes Fixed (`68` -> `20` defects)**:
     1. *48 building `-1` triangle mismatches*: Fixed half-open `[startFace, endFace)` accounting in `SeamValidator` and `MeshBoxClipper` (`0` building triangle mismatches on rerun).
     2. *Road seam vertex proximity false positives*: Replaced raw vertex proximity in `SeamValidator` Check D with symmetric seam-aligned boundary-edge interval coverage + elevation continuity.
     3. *Curved railway bridge UV phase drift*: Replaced tile-dependent `hostIndex` sampling on curved bridges with pure geometric curvature sampling and corrected `visualSleeperPeriodMeters` modulo arithmetic (`39,650 / 39,650` sleeper parity).
     4. *Extra forest trees (`13,973` vs `13,961`)*: Precomputed global `planarResolution` in `ingestCanonicalStudyGeoJson` (`0` tree count mismatches on rerun).
     5. *Reporting bugs*: Fixed `TiledStudyPipeline.peakMemory` per-field `Math.max` and `CollarAudit` `finiteOrZero` portal distance sanitization.
   - **Second-Pass Canonical `8 × 8` Hengelo & `--diagnose-abc` Root Causes Fixed (`20` `A ↔ C` defects, `12` `A → B` defects, `64/64` `B → C` tile flags)**:
     1. **Phase 1 — `A → B` (`12` defects: `-132,163.164 m²` water area loss, `7` road class area differences, `3` missing buildings, `1` provenance mismatch)**:
        - *Stale partial `geom.groups` on merged single-material meshes*: `THREE.ShapeGeometry` creates `geom.groups = [{ start: 0, count: N, materialIndex: 0 }]`, whereas ribbon/extrusion meshes (`LinearWaterway`, bridge decks, step treads) have `geom.groups = []`, and `validateAndPruneHorizontalGeometry` mutates `geo.index` without updating `geo.groups[0].count`. When `mergeWithFaceRanges` concatenated `WaterBody` (`ShapeGeometry`) + `LinearWaterway` (ribbons) into `WaterSurfaces` (or mixed road meshes into `Roads_*`), `merged.groups` covered only the `ShapeGeometry` prefix, so `clipBufferGeometryToBoxXZ` dropped all `LinearWaterway` and ungrouped road triangles (`-132,163.164 m²`). Fixed by calling `merged.clearGroups()` in `GeometryBuilder.mergeWithFaceRanges`, `RailwayGeometryBuilder.mergeItemsWithFaceRanges`, and `GraphRoadGeometryBuilder.validateAndPruneHorizontalGeometry`, and updating `clipBufferGeometryToBoxXZ` to use explicit `geom.groups` only when multiple material groups cover the entire triangle buffer (`coveredTris >= totalTriCount`).
        - *3 missing buildings in `B`*: `TiledDiagnostics.partitionBuildingsIntoTiles` computed the 3D extruded vertex average (`sumX / vertCount`), whereas `sliceStudyInputsForTile` used the 2D outer footprint ring bbox midpoint (`getRingsBBoxCentroid(b.footprint)`). For asymmetric buildings near a tile border, the 3D vertex centroid fell across the border from the 2D footprint bbox centroid. Fixed `partitionBuildingsIntoTiles` to look up the canonical 2D footprint bbox midpoint from `ingested.data.buildings` by `sourceFeatureId`.
     2. **Phase 2 — `B → C` (`64/64` tiles flagged with ~13,500 missing IDs/tile & 26 MB JSON output)**:
        - *Whole-scene `faceRanges` fallback in `cloneStaticGroupWithClip`*: `GeometryBuilder` stores `faceRanges` on `mesh.userData.faceRanges` (not `geometry.userData.faceRanges`). `cloneStaticGroupWithClip` did not pass `mesh.userData.faceRanges` into `clipBufferGeometryToBoxXZ` and fell back to `clipped.userData.faceRanges ?? mesh.userData.faceRanges`, attaching all ~13,500 whole-scene `faceRanges` to every tile in `B`. Fixed by passing `srcFaceRangesOverride = mesh.userData?.faceRanges` into `clipBufferGeometryToBoxXZ` and assigning only the remapped surviving `faceRanges` (plus preserving `srcFaceRanges` on the bbox-inside fast path).
        - *Point-owned static meshes in `foliageGroup` (`PointLandmarks_3D`, `StreetFurniture_*`)*: In `C`, `GeometryBuilder` assigns point landmarks (cooling towers, windmills, masts) and street furniture (shelters, benches, fountains) by half-open point ownership (`pointInHalfOpenBox(lm.position, tileClipBounds)`), whereas `cloneStaticGroupWithClip` previously clipped `foliageGroup` triangles at the tile box. Added `partitionPointOwnedFoliageMeshesIntoTiles` in `TiledDiagnostics.ts` so `PointLandmarks_3D` and `StreetFurniture_*` are partitioned by anchor point in `B` matching `C`.
        - *Compact diagnostic reporting*: Separated `hasGeometryDivergence` vs `hasMetadataDivergence` (`isGeometryExactMatch`, `tilesWithGeometryDivergence`, `tilesWithMetadataDivergence`) in `bVsC`, and bounded per-tile ID lists and `--json-out` collar audit cases to summary counts + up to 10 representative samples per tile.
     3. **Phase 3 — `A ↔ C` (`20` defects: `-173,656.857 m²` Residential Landuse, `-1,572.120 m²` Forest, `11` road seam edges, `5` road area mismatches, `4` extra `sourceFeatureIds`, `1` railway UV phase mismatch `0.075829`)**:
        - *Unioned planar polygon drop & 2D-vs-3D triangulation conservation (`-173,656.857 m²` Residential Landuse, `-1,572.120 m²` Forest)*: `resolveAndValidatePlanarPolygons` merges touching same-kind unnamed polygons (`mergeTouchingSameKindUnnamedPolygons`) into the first item's ID (`resolved.bbox` spans all merged partners, while `item.polygon` only spans the original seed ring). `sliceStudyInputsForTile` previously filtered `landuse`/`parks`/`waterBodies` only by `item.polygon` bbox, dropping the unioned polygon from tiles where only merged partner polygons overlapped the collar; furthermore, 2D per-tile `clipMultiPolygonToBox2D` + independent `earcut` triangulation does not form an exact `Float32` partition of unity across 64 tiles. Resolved by filtering tile planar inputs by `resolved.bbox`, precomputing unclipped `ShapeGeometry` in `planarResolution.unclippedGeometriesById`, and clipping in 3D via `clipBufferGeometryToBoxXZ`.
        - *Asymmetric per-tile Earcut rejection on at-grade roads (`11` road seam edges, `5` road area differences, `4` extra `sourceFeatureIds`)*: When a road polygon's `visible` MultiPolygon was clipped in 2D per tile before `ShapeGeometry` + `validateAndPruneHorizontalGeometry`, a road polygon with a degenerate Earcut micro-triangle in Tile 1 failed validation as a whole in `A` and in Tile 1 of `C`, but its clipped sub-polygon in Tile 2 of `C` had no degenerate triangle and succeeded — adding an extra `sourceFeatureId`, extra road area, and an unmatched road boundary edge at the Tile 1/Tile 2 seam. Resolved by always triangulating and validating the unclipped road `visible` polygon first (`buildGraphAtGradeRoadGeometries` + `precomputedGlobalPlans.atGradeRoadPlan`) and clipping the validated 3D triangle mesh per tile via `clipBufferGeometryToBoxXZ`.
        - *At-grade railway densification near chamfered host tracks (`0.075829` UV phase mismatch at `V_tx_684_ty_11314__tx_685_ty_11314`)*: In `RailwayGeometryBuilder.ts:1257-1273`, at-grade railway tracks query `hostIndex` (`6.0 m` search radius) to subdivide segments (`<= 2.0 m`) near chamfered parallel bends, slightly changing polyline arc length and UV `v` phase when a neighboring track is absent or clipped differently in an adjacent tile. Resolved by precomputing `railwayDensifiedPointsByEdgeId` (`computeRailwayDensifiedPointsMap`) globally in `ingestCanonicalStudyGeoJson` and passing it via `precomputedGlobalPlans`.
     4. **Final `B → C` Diagnostic Cleanup (`7aa3b2e` Canonical Run: `A ↔ C` 0 defects, `A → B` 0 defects; `B → C` 4 sleeper transfer tiles & 12 ballast metadata tiles)**:
        - *`+1/-1` and `+2/-2` sleeper count transfers across 2 adjacent tile pairs (`4` tiles)*: In `C`, `RailwayGeometryBuilder.ts:2135` assigns each `SleeperBearerBox3D` to a tile by its canonical Float64 **track-centerline station point** `pointInHalfOpenBox(box.cx, box.cz, tileClipBounds)`. However, for asymmetric sleepers — elongated turnout bearers or laterally clipped sleepers where `halfWidthLeft !== halfWidthRight` (`midOffset = (halfWidthLeft - halfWidthRight) * 0.5 !== 0`) — `buildInstancedSleepersMesh` writes the `InstancedMesh` matrix translation (`te[12], te[14]`) at the **shifted 3D box geometric center** `(box.cx + box.nx * midOffset, box.cz + box.nz * midOffset)` in `Float32`. When a turnout or parallel track runs within `~0.5 m` of a tile seam, `box.cx` and `box.cx + nx * midOffset` fall on opposite sides of the seam. Fixed by storing `instanceBoxes` on `instancedMesh.userData` (`RailwayGeometryBuilder.ts`) and updating `TiledDiagnostics.countInstancedWithinBox` to partition sleeper instances in `B` by their canonical Float64 station center `(box.cx, box.cz)`.
        - *Additional railway `sourceFeatureIds` in `B` (`12` tiles)*: `SurfaceFirstRailwayBallast.ts` unions all overlapping at-grade track ballast footprints in a connected switchyard into a single `SurfaceFirstBallastComponent` whose `comp.sourceFeatureIds` lists every track in the entire yard component. When `A` built the study-wide unioned ballast component and `B` clipped `Railway_Ballast` into tiles, every tile touching any corner of the yard inherited the `sourceFeatureIds` of all tracks in the yard (including yard tracks hundred of meters away in other tiles), whereas `C` only unioned tracks within each tile's `64 m` collar. Fixed by filtering `effectiveSourceFeatureIds` per tile in `SurfaceFirstRailwayBallast.buildSurfaceFirstRailwayBallastGeometries` (when `tileClipBounds` is active) and `TiledDiagnostics.normalizeBallastFaceRangesForTile` (in `B`) to only those tracks whose individual ballast footprint (`fp.geometry`) overlaps `tile.localBounds`.
3. **Non-Scope**: No gameplay mechanics, combat, physics simulation, traffic/agent AI, or large ECS frameworks (`GEMINI.md` / `docs/architecture.md`).

## Phased Milestones (M1 Split Into M1a & M1b)

- **Milestone M1a (Projection, Tile Grid, Seam Continuity & `64 m` Collar Validation — Implemented, Pending Owner Verification)**:
  - `src/world/tiling/RegionalProjection.ts`, `TileGrid.ts`, `MeshBoxClipper.ts`, `CollarAudit.ts`, `TiledStudyPipeline.ts`, `SeamValidator.ts`, `TiledDiagnostics.ts`, backward-compatible `tileClipBounds` / `precomputedGlobalPlans` hooks on `LocalGeoJsonProvider.ts`, `GeometryBuilder.ts`, `GraphRoadGeometryBuilder.ts`, `RailwayGeometryBuilder.ts`, and `SurfaceFirstRailwayBallast.ts`.
  - Tests & CLI: `src/world/TilingProjectionAndGrid.test.ts` (`7`), `src/world/TilingSeamContinuity.test.ts` (`8`), `src/world/TilingHengeloIntegration.test.ts` (disk-gated), and `scripts/verify-hengelo-m1a.ts` (with `--diagnose-abc`).
- **Milestone M1b (Offline Tile Baker, `OSMTILE1` Codec & `ThemeMaterialRegistry` — Unapproved / Future)**:
  - Incorporate M1a findings: synthesize continuous surfaces in bounded regional macro-blocks (`e.g. 4 × 4` or `8 × 8` tiles + collar), clip in 3D via `clipBufferGeometryToBoxXZ`, apply tile-local `Float32` transform, serialize `OSMTILE1` binary payloads into `overijssel-tiles-261114-8ae28196.sqlite`, and provide shared `ThemeMaterialRegistry`.
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
- [x] **Seamless Boundaries, A/B/C Conservation & Same-Source Reference Parity (Synthetic `2 × 2` Stress Suite)**: `0` fake road rounded end-caps on tile splits; `0` positive-area coplanar overlaps (`<= 1e-4 m²`); `0` cut/duplicated/missing seam buildings (`1:1` 2D footprint centroid parity); `0` railway 3D sleeper count mismatches; `<= 1e-3` railway UV phase discontinuity; `<= 1e-3 m` road/bridge/rail elevation discontinuity; `100%` OSM `sourceFeatureId` parity; `A -> B` (`0` defects) and `B -> C` (`0` geometry or metadata divergent tiles) exact conservation.
- [x] **Explicit `64 m` Collar Hypothesis Audit**: `CollarAudit` detects and reports `> 64 m` planar/building/bridge/tunnel/railway-phase/road/barrier boundary dependencies and `MAX_SCENE_TREES = 2200` cap divergence instead of silently truncating.
- [ ] **Owner Canonical Hengelo `8 × 8` SQLite Verification & M1a Review**: Project owner verified `Seam OK: true` (`0` defects across 64 tiles / 112 seams) and `A -> B` (`0` defects) on commit `7aa3b2e`; final `B -> C` diagnostic check pending local Windows rerun and formal M1a approval.

### Milestones M1b–M4 (Future / Unapproved)
- [ ] **M1b Offline Binary Tile Codec & Shared Material Registry**: `OSMTILE1` codec, `overijssel-tiles-261114-8ae28196.sqlite`, `ThemeMaterialRegistry` 4-theme swap parity.
- [ ] **M2 Streaming Runtime, Floating Origin & Disposal**: `/api/tiles/...`, Worker decode, IndexedDB LRU, texel-snapped tracking shadows, `0` WebGL/CPU/BVH disposal leaks.
- [ ] **M3 Orthographic Zoom-Driven LOD & Camera Navigation**: `minZoom ~ 0.015–0.02`, `LOD1`–`LOD3`, atomic parent/child swaps with zero blank-hole frames.
- [ ] **M4 Regional Twente & Overijssel Rollout**: Province-wide graph + tile-pack bake validating against `overijssel-261114-8ae28196` (`SHA-256: 8ae28196...`).

## Verification
- **AI Studio Sandbox Verification (`2026-11-20`)**:
  - Sequential tiling suite (`DISABLE_OVERIJSSEL_BOOTSTRAP=1 npx tsx --test --test-concurrency=1 src/world/TilingProjectionAndGrid.test.ts src/world/TilingSeamContinuity.test.ts`): `15` passed (`7` in `TilingProjectionAndGrid.test.ts` + `8` in `TilingSeamContinuity.test.ts`), `0` failed.
  - Sequential railway regression suite (`DISABLE_OVERIJSSEL_BOOTSTRAP=1 npx tsx --test --test-concurrency=1 src/world/RailwayRendering.test.ts src/world/GraphRailwayRendering.test.ts`): `38` passed, `0` failed.
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
