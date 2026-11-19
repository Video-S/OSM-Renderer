---
id: TKT-028
title: Regional Tiling, Offline Baked Geometry, Streaming, and Orthographic LOD for Twente & Overijssel
type: feature
status: open
priority: high
created: 2026-11-19
updated: 2026-11-19
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

> **Current Status**: Planning / Architecture Proposal Only (`status: open`, pending project-owner approval of [`docs/regional-tiling-streaming-lod-proposal.md`](../docs/regional-tiling-streaming-lod-proposal.md) and Milestone M1 authorization). No implementation code has been written under `TKT-028`.

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
2. **Non-Scope**: No gameplay mechanics, combat, physics simulation, traffic/agent AI, or large ECS frameworks (`GEMINI.md` / `docs/architecture.md`).

## Proposed Phased Milestones

- **Milestone M1 (First Implementation Milestone — Foundation & Hengelo `4 × 4 km` PoC)**:
  - Implement regional conformal projection (`RegionalProjection`, ETRS89/UTM 32N or Overijssel Transverse Mercator), global `InfrastructureGraph` build for the Hengelo `4 × 4 km` PoC corridor (`8 × 8 = 64` `512 m × 512 m` LOD0 tiles with proposed `H = 64 m` collar + exact post-Boolean 2D tile-box clipping for surfaces and centroid ownership for 3D buildings/trees), `OSMTILE1` binary codec, shared `ThemeMaterialRegistry`, and automated seam-continuity & parity checks vs. single-scene `GeometryBuilder`.
- **Milestone M2 (Client Streaming Runtime, Floating Origin & Disposal)**:
  - Express `/api/tiles/...` endpoint with `TKT-027` `source_sha256` + `bake_schema_version` compatibility guards, Web Worker binary decoder, frustum + hysteresis `TileStreamManager` (`AbortController` cancellation + bounded per-frame GPU commit budget), camera-relative floating-origin rendering, IndexedDB cache, dynamic camera-target shadow frustum, and zero-leak `TileResourceHandle` disposal.
- **Milestone M3 (Orthographic Zoom-Driven LOD1–LOD3 & Regional Navigation)**:
  - Lower `CameraController` `minZoom` (`0.15` -> proposed `~0.015–0.02`), extend offline baker to `LOD1` (`1,024 m`), `LOD2` (`2,048 m`), and `LOD3` (`4,096 m`), and enforce atomic parent/child quadtree swaps (leaving coarse LOD visible until covering fine children commit).
- **Milestone M4 (Full Twente & Overijssel Scale-Out)**:
  - Partitioned/streaming province-wide graph construction and full `OVERIJSSEL_BBOX` tile pack baking (`npm run osm:bake-overijssel-tiles`), disk/memory telemetry, and regional browser benchmarks.

## Acceptance Criteria
- [ ] Architectural proposal (`docs/regional-tiling-streaming-lod-proposal.md`) reviewed and Milestone M1 authorized by project owner.
- [ ] **Seamless Boundaries**: `0` fake road rounded end-caps on tile splits; `0` positive-area coplanar overlaps across tile seams; `0` cut interior building walls or duplicated seam buildings; continuous railway sleeper phase and bridge/tunnel ramp elevations across tile boundaries.
- [ ] **Global Topology & Provenance Preservation**: `faceRanges`, `instanceInfos`, and OSM tags (`resolveInspectedFeature`) identify continuous multi-tile OSM ways cleanly across boundaries; global `InfrastructureGraph` topology preserves real OSM node connectivity.
- [ ] **Orthographic Zoom-Driven LOD & Camera Navigation**: Smooth pan/zoom from close-up (`>= 4.5 CSS px/m` 3D sleepers) out to regional Twente / Overijssel views (`minZoom ~ 0.015–0.02`) with zero blank-hole frames during parent/child swaps and responsive frame rates.
- [ ] **Memory, Precision, Shadows & Themes**: Sub-millimeter tile-local Float32 geometry + camera-relative floating origin across all of Overijssel; single shared `ThemeMaterialRegistry` swaps all 4 themes across loaded tiles in-place; dynamic directional shadows follow the camera target cleanly without shimmer; `0` WebGL/CPU/BVH disposal leaks across pan/eviction/reload cycles.
- [ ] **Integrity & Reproducibility (`TKT-027`)**: Tile packs validate against canonical `overijssel-261114-8ae28196` (`SHA-256: 8ae28196...`) + `bake_schema_version` (`HTTP 503` on mismatch), and all automated tests (`npm test`), TypeScript check (`npm run lint`), and production build (`npm run build`) pass.

## Verification
- Status: Unverified (`open` — architectural planning phase only; awaiting project-owner approval to begin Milestone M1).
- Proposed initial PoC checks (Milestone M1):
  - Focused seam-continuity & tile-codec unit/integration tests (`tsx --test`)
  - Hengelo `8 × 8` `512 m` LOD0 geometry parity & validator suite (`SurfaceFirstRoadValidator`, `ZFightingValidator`, `faceRanges` parity)
  - `npm run lint` & `npm run build`

## Related files and documentation
- Proposal: [`docs/regional-tiling-streaming-lod-proposal.md`](../docs/regional-tiling-streaming-lod-proposal.md)
- Related Docs: `docs/architecture.md`, `docs/camera-and-world-coordinates.md`, `docs/offline-overijssel-osm-dataset.md`, `docs/e2-plus-surface-first-road-rendering.md`, `docs/STATUS.md`
- Core Subsystems Referenced: `src/world/WorldCoordinates.ts`, `src/world/SceneResourceManager.ts`, `src/world/GeometryBuilder.ts`, `src/world/infrastructure/topology/InfrastructureGraph.ts`, `src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`, `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`, `src/scene/CameraController.tsx`, `src/scene/MapScene.tsx`, `src/server/osm/OverijsselOsmStore.ts`, `src/server/osm/overijsselBoundary.ts`
