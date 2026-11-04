---
id: TKT-001
title: Fix railway overlap brightness accumulation via idempotent rendering and restore sleeper generation
type: bug
status: closed
priority: high
created: 2026-10-30
updated: 2026-11-03
---

# TKT-001: Fix railway overlap brightness accumulation via idempotent rendering and restore sleeper generation

## Summary
When railway tracks (`Railway_Rails` and `Railway_Sleepers`) overlap, converge at switches/turnouts, or cross in the 3D WebGL view, their rendered brightness increases as if additive blending were active. Previous attempts to fix this via CPU overlap-avoidance/culling logic (`deduplicateRailwaySegments`, `SleeperSpatialIndex`, and polyline trimming) caused cross-tie sleepers to be suppressed or cut gaps into rails. A subsequent 2-hour implementation attempt (involving clearance-based rail clipping, screen-space width clamping, and stencil write-once configuration) did not result in a proper fix and was reverted on 2026-10-31 because the problem hit an architectural dead end in the current rendering pipeline.

This ticket logs the exhaustive architectural root causes, the four traps that caused previous attempts to fail, the synergy with the planned road surface markings feature, and the completed Milestone 2.2 (`M2.2`) production implementation following the Milestone 2.1 (`TKT-002`) prototype evaluation.

## Context & The 4 Architectural Traps (Why Obvious Fixes Hit a Dead End)

### Trap 1: The Discontinuous Geometry Trap (Why road-style trimming fails)
- **Roads** in this codebase work cleanly because a road is a **single solid polygon** (carriageway). When two roads intersect, `GeometryBuilder` can trim incoming polylines at curb lines and synthesize a non-overlapping planar `JunctionPolygon` to bridge the gap.
- **Railways are not solid polygons.** A railway consists of two razor-thin steel rails separated by 1.435m of inner gauge space, resting on perpendicular cross-tie sleepers spaced every 1.45m.
- Trimming railway polylines at topological nodes stops rails and sleepers 3 meters before the switch, producing empty voids and floating track gaps (`public/assets/aistudio/image_7033bed5.png` and `image_35190200.png`). In real life, steel rails physically cross each other at switch frogs; they cannot simply be cut away without destroying track continuity.

### Trap 2: The Single-Mesh Batching Trap (Why GPU Stencil and Depth tricks fail)
- In `GeometryBuilder.ts`, all rails across the entire map are merged into a **single BufferGeometry** (`mergedRails`) and rendered in **one single draw call** (`new THREE.Mesh(mergedRails, railsMat)`).
- GPU stencil masking and layer-locking passes (which 2D engines like Mapbox GL use across separate layer passes) do not automatically solve topology when applied naively across whole-track ribbons, and vertex-space min-screen-width expansion causes adjacent tracks in station throats to merge into a bright solid band.
- Because all rail triangles share the exact same depth elevation (`Y = 0.085m`), standard depth testing (`LessEqual`) lets overlapping triangles rasterize unless properly layered by physical component (`Ballast < SleeperZone < Rails`) and filtered in fragment space.

### Trap 3: The Spatial Density & HDR Tone-Mapping Trap (Why it blooms even when opaque)
- Even with 100% opaque materials (`transparent: false`) and zero shader blending, two tracks converging at a 5-degree switch pack **four bright steel rails** and **two interleaved sets of cross-ties** into a narrow 10-to-20 pixel screen corridor.
- Under `ACESFilmicToneMapping` with directional lighting (intensity 1.1 to 1.5) over a very dark ballast (`#1e293b`), doubling the number of bright white/silver pixels in that corridor **doubles the integrated luminance** in that patch of screen space.
- The human visual system and the ACES tone-mapping curve perceive this sudden spatial concentration of luminance against dark ballast as an intense glowing white bloom (`public/assets/aistudio/image_ca17bef9.png` and `image_3eef0cd4.png`).

### Trap 4: The Proximity Culling Trap (Why sleepers disappear)
- Attempting to prevent this density doubling by culling sleepers via spatial proximity (`SleeperSpatialIndex`, `canPlaceSleeper`, or corridor pitch protection) fails because **real railway switches legitimately share ground within 0.5m to 1.0m over 20 to 50 meters**.
- A spatial hash cannot distinguish between a main track and a diverging siding. It ends up suppressing sleepers along the branching track, leaving bare rails floating over bare ballast without ties.

---

## Synergy with Planned Road Surface Markings

Road surface markings (lane centerlines, dashed lane dividers, crosswalks, bike lane stripes) are planned for Goalpost 2 (`M2.4`).

Both railway elements (rails + sleepers) and road markings share the exact same underlying rendering challenge:
- They require rendering thin, repeating patterns (lines and dashes) along and across wide planar corridors (ballast or asphalt).
- Generating thousands of discrete 3D geometric boxes/quads in world space causes geometry explosion, sub-pixel rasterization artifacts, z-fighting, and overlap blooming at intersections and merges.
- Solving this via a unified, modular UV-ribbon and derivative-filtering architecture serves both railway tracks (`M2.2`) and road markings (`M2.4`).

---

## Implemented Architecture (Milestone 2.2 — Post-TKT-002 Decision Gate)

Following the approval and closure of **Milestone 2.1 (`TKT-002`)** selecting **Candidate B** (`useSpatialGridIndex: true`, `adaptiveBridgeSampling: true`, `multiIntervalClip: true`, `sleeper3DMode: 'instanced'`, `spatialChunkSizeMeters: 128`, `zoomThreshold = 4.5 CSS px/m`), `TKT-001` implements **Milestone 2.2**:

1. **Supporting Railway Architecture Extraction (`src/world/infrastructure/`)**:
   - `src/world/infrastructure/rendering/UvRibbonBuilder.ts`: Extracted continuous arc-length UV-parameterized (`u = arcLengthMeters`, `v = signedLateralOffsetMeters`) 2D/3D ribbon generation with sharp-corner subdivision (`subdivideSharpPolylineCorners2D`) and miter beveling.
   - `src/world/infrastructure/rendering/InfrastructureShaderChunks.ts`: Extracted derivative-filtered (`fwidth`) procedural sleeper and dual-rail shaders with energy-conserving coverage attenuation (`1.0 / sqrt(coverageBoost)`).
   - `src/world/infrastructure/railways/RailwayTopology.ts`: Extracted `RAILWAY_DIMENSION_SPEC`, mainline-first topological sorting (`sortRailwaysMainlineFirst`), continuous arc-length phase propagation (`computeContinuousTrackPhases`), `8 m x 8 m` `HostTrackSpatialIndex`, turnout-throat pair classification (`isTurnoutThroatPair`), and multi-interval Minkowski clipping (`subtractIntervalFromList`).
   - `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`: Extracted `buildRailwayInfrastructure` and `buildRailwayGroupInternal` implementing the Candidate B hybrid 3D + UV-ribbon railway renderer with explicit `supportedTrackIds` turnout bearer tracking, symmetric parallel-track midpoint clamping, `THREE.InstancedMesh` 3D sleepers, switch-blade inner-rail width tapering (`0.32 -> 1.0` over `4.2 m`), and `128 m x 128 m` spatial chunking.
   - `src/world/prototype/RailwayPrototypeBuilder.ts`: Updated to delegate directly to the extracted production modules without duplicating Candidate B logic.
2. **Production Integration & Obsolete Code Removal (`src/world/GeometryBuilder.ts`)**:
   - Integrated `buildRailwayInfrastructure` into `GeometryBuilder.buildScene()` (Stage 5).
   - Removed ~860 lines of obsolete railway-specific heuristics from `GeometryBuilder.ts` (`RailClearanceSpatialIndex`, `resolveRailPolylineClearance`, `sortRailwaysMainlineFirst`, `computeRailwaySleeperPhases`, `attachRibbonOffsetAttribute`, `applyRibbonMinScreenWidthShader`).
   - Wired `updateCameraZoom(zoom)` and `updateTheme(newTheme)` across `GeometryBuilder.ts`, `MapScene.tsx`, and `App.tsx`.
   - Preserved `faceRanges` and `instanceInfos` feature inspection provenance and `SceneResourceManager` GPU lifecycle management.
3. **Documentation & ADR Synchronization**:
   - Created `docs/decisions/ADR-0008-hybrid-railway-rendering-and-uv-ribbon-architecture.md` and indexed it in `docs/decisions/README.md`.
   - Updated `docs/geometry-and-rendering.md`, `docs/architecture.md`, `docs/testing-and-diagnostics.md`, and `docs/STATUS.md`.

---

## Observed Behavior (Pre-Fix)
- Overlapping railway tracks and switches in the 3D WebGL view displayed an intense brightness increase / bloom.
- Cross-tie sleepers were suppressed or missing along converging switch throats and closely spaced parallel tracks due to spatial culling thresholds.
- Polylines under tie-spacing lengths dropped sleepers entirely, and sub-pixel sleepers shimmered at overview zoom.

## Expected Behavior & Acceptance Criteria (M2.2)
- [x] Overlapping and converging railway tracks (single turnouts, scissors crossovers, and multi-track station throats) maintain uniform luminance and material shading consistent with isolated tracks across Close (`zoom = 8.0`), Medium (`zoom = 3.0`), and Overview (`zoom = 0.85–1.0`) zoom levels.
- [x] Cross-tie sleepers render continuously along all tracks, chained short ways (`< 1.2 m`), turnouts, crossovers, and closely spaced parallel tracks (`2.1 m–2.5 m`) without voids, gravel trenches, or interleaved wood clutter.
- [x] Supporting railway architecture is cleanly separated and unit-tested (`src/world/RailwayRendering.test.ts`), and obsolete railway-clipping heuristics are removed from `GeometryBuilder.ts`.
- [x] Hover/click `faceRanges` and `instanceInfos` railway feature inspection and in-place theme switching (`tactical`, `daylight`, `dusk`, `blueprint`) work without regression.
- [x] All automated tests (`npm test`), linter (`npm run lint`), production build (`npm run build`), and API docs (`npm run docs:api`) pass.

## Status & Verification Record
- **Status**: `closed`
- **Verification**:
  - `npm test`: **87 / 87 passed** (including all 5 new production unit/integration tests in `src/world/RailwayRendering.test.ts` and all 14 M2.1 benchmark/geometric regression tests in `src/world/PerformanceBaseline.test.ts`).
  - `npm run lint`: **0 errors** (`tsc --noEmit`).
  - `npm run build`: **Succeeded** (`vite build`).
  - `npm run docs:api`: **Succeeded** (`typedoc`).

## Related Files and Documentation
- Related Tickets: [`tickets/TKT-002-m2-1-performance-baseline-and-railway-prototype.md`](TKT-002-m2-1-performance-baseline-and-railway-prototype.md)
- Source: [`src/world/GeometryBuilder.ts`](../src/world/GeometryBuilder.ts), [`src/world/infrastructure/railways/RailwayGeometryBuilder.ts`](../src/world/infrastructure/railways/RailwayGeometryBuilder.ts), [`src/world/infrastructure/railways/RailwayTopology.ts`](../src/world/infrastructure/railways/RailwayTopology.ts), [`src/world/infrastructure/rendering/UvRibbonBuilder.ts`](../src/world/infrastructure/rendering/UvRibbonBuilder.ts), [`src/world/infrastructure/rendering/InfrastructureShaderChunks.ts`](../src/world/infrastructure/rendering/InfrastructureShaderChunks.ts)
- Tests: [`src/world/RailwayRendering.test.ts`](../src/world/RailwayRendering.test.ts), [`src/world/PerformanceBaseline.test.ts`](../src/world/PerformanceBaseline.test.ts), [`src/world/ElevationAndZIndex.test.ts`](../src/world/ElevationAndZIndex.test.ts), [`src/world/FeatureCoverage.test.ts`](../src/world/FeatureCoverage.test.ts)
- Documentation: [`docs/decisions/ADR-0008-hybrid-railway-rendering-and-uv-ribbon-architecture.md`](../docs/decisions/ADR-0008-hybrid-railway-rendering-and-uv-ribbon-architecture.md), [`docs/geometry-and-rendering.md`](../docs/geometry-and-rendering.md), [`docs/STATUS.md`](../docs/STATUS.md)

