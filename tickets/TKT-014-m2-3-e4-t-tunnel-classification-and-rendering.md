---
id: TKT-014
title: M2.3-E4-T Tunnel Classification & Rendering
type: feature
status: in_progress
priority: high
created: 2026-11-11
updated: 2026-11-11
---

# TKT-014: M2.3-E4-T Tunnel Classification & Rendering

## Summary
Improve tunnel classification and 3D rendering for roads, footpaths, and railways by establishing an explicit, reusable infrastructure placement classifier (`surface_open`, `elevated`, `open_cutting`, `covered_passage`, `underground_tunnel`, `unknown_or_conflicting`), decoupling relative OSM `layer < 0` stacking order and covered/depressed ways from genuine subterranean tunnels, and generating coherent portal transitions and continuous 3D underground road and railway geometry.

## Context
Following project-owner visual acceptance of Stage E4-A (`TKT-013`), Stage E4-T is authorized to resolve five verified defects in the current tunnel pipeline:
1. `classifyGeoJsonFeature` in `src/world/FeatureCatalogue.ts` treats `covered=*` (`covered=yes|arcade|colonnade`), `tunnel=building_passage`, `tunnel=culvert`, and any negative `layer < 0` value as equivalent to `isTunnel = true`.
2. `ElevationPolicy.ts`, `GeometryBuilder.ts`, `RailwayGeometryBuilder.ts`, and `BridgeAndTunnelBuilder.ts` also use `layer < 0` to route open surface or depressed infrastructure into tunnel rendering.
3. `BridgeAndTunnelBuilder.ts` primarily generates surface portal boxes and dashed underground traces rather than continuous 3D underground road or railway geometry.
4. Underground road and railway geometry is not modeled consistently as continuous 3D infrastructure at subterranean elevation.
5. Portal structures are generic and were emitted even at unconfirmed or contradictory endpoints.

## Architectural & Implementation Plan

1. **Centralized Semantic Infrastructure Placement Classifier (`src/world/InfrastructurePlacementClassifier.ts`)**:
   - Define `InfrastructurePlacementKind` (`'surface_open' | 'elevated' | 'open_cutting' | 'covered_passage' | 'underground_tunnel' | 'unknown_or_conflicting'`), `InfrastructureVerticalRelation`, `InfrastructureEnclosureKind`, `TunnelConstructionSubtype`, and `InfrastructurePlacementClassification`.
   - Separate semantic classification from 3D geometry generation so the classifier can be reused directly in future offline mesh baking.
   - Apply conservative OSM evidence rules:
     - `tunnel=yes|railway|underpass|subway`: Explicit physical tunnel (`underground_tunnel`).
     - `location=underground|underwater`: Underground placement (`underground_tunnel`).
     - `tunnel=building_passage|passage|corridor`: Passage through a building (`covered_passage`, rendered at-grade unless `location=underground`).
     - `covered=yes|arcade|colonnade|booth` or `tunnel=avalanche_protector|covered|gallery`: Covered surface infrastructure (`covered_passage`).
     - `cutting=yes|left|right|both` or `embankment=cutting`: Open excavation (`open_cutting`).
     - `layer < 0`: Relative vertical ordering only (`verticalRelation: 'relative_layer_only'`, not automatically subterranean).
     - `railway=subway`: Service type only; no automatic underground inference without physical placement tags.
     - `tunnel=no|false|0`: Explicit negative tunnel evidence.
     - `incline=*`, `ele=*`, `level=*`, `maxheight=*`: Optional supporting evidence parsed according to actual tag semantics.
     - Culverts (`tunnel=culvert`, `culvert=yes`, `bridge=culvert`, `man_made=culvert`) handled separately from ordinary road and railway tunnels.
     - Contradictory vertical tags (e.g., `bridge=yes` + `tunnel=yes`, `tunnel=yes` + `layer > 0`, `bridge=yes` + `layer < 0`, or unrecognized `tunnel=*` values) classified as `unknown_or_conflicting` with `canGenerateUndergroundGeometry = false`.

2. **Pipeline Migration (`FeatureCatalogue.ts`, `LocalGeoJsonProvider.ts`, `ElevationPolicy.ts`, Topology & Render Descriptors)**:
   - Propagate `placementClassification` across `ClassificationResult`, `RoadFeature`, `RailwayFeature`, `UnchainedRoadPart`, `UnchainedRailwayPart`, `RoadEdge`, `RailwayEdge`, `RoadEdgeRenderDescriptor`, and `RailwayEdgeRenderDescriptor`.
   - Ensure `isTunnel` on road and railway features reflects genuine subterranean tunnel placement (`placement === 'underground_tunnel'`) while preserving backward compatibility for synthetic test fixtures.
   - Remove `layer < 0` tunnel promotion from `ElevationPolicy.ts`, `GeometryBuilder.ts`, `RailwayGeometryBuilder.ts`, and `BridgeAndTunnelBuilder.ts`.

3. **Improved Tunnel Portals, Threshold Transitions & Continuous 3D Underground Geometry (`BridgeAndTunnelBuilder.ts`, `GeometryBuilder.ts`, `RailwayGeometryBuilder.ts`)**:
   - Scale tunnel portal structures, recessed dark openings, wing walls, and short portal threshold ramps appropriately to road width and railway type (`rail`, `subway`, `light_rail`, `tram`, vehicular road, footway/cycleway), respecting `maxheight` when tagged.
   - In graph mode, emit portals only at confirmed transitions (`confirmed_transition`) or valid unclipped standalone entrances (`intentionally_standalone` when not conflicting), never at internal tunnel continuations (`confirmed_elevated_continuation`), clipped boundaries (`boundary_clipped_continuation`), or unresolved/contradictory endpoints (`unresolved_connection` / `unknown_or_conflicting`).
   - Build continuous 3D underground road (`Tunnel_Underground_Roads`) and railway (`Tunnel_Underground_Railway_Ballast`, `Tunnel_Underground_Railway_Sleepers`, `Tunnel_Underground_Railway_Rails`) geometry along confirmed `underground_tunnel` alignments at subterranean depth (`ELEVATION_POLICY.TUNNEL_DEPTH = -2.0 m` and layer-stepped depths), sloping smoothly down from confirmed portal entrances over the short portal transition zone while keeping surface ground-cover continuous overhead.

4. **Diagnostics & Automated Validation (`src/world/TunnelClassificationAndRendering.test.ts`)**:
   - Record placement classification counts, tunnel portal counts, underground geometry counts, construction time, and memory use.
   - Validate all 16 required tunnel classification and rendering scenarios.

## Acceptance Criteria
- [x] Centralized semantic placement classifier (`InfrastructurePlacementClassifier.ts`) implemented and propagated through ingestion, graph topology, and render descriptors.
- [x] `covered=*`, `tunnel=building_passage`, `cutting=*`, `railway=subway` (without underground tags), `tunnel=no`, and bare `layer < 0` are not misclassified or rendered as subterranean tunnels.
- [x] Coherent portal transitions and continuous 3D underground road and railway geometry generated for valid `underground_tunnel` features without breaking planar ground-cover continuity.
- [x] Contradictory vertical tags (`unknown_or_conflicting`) do not generate misleading underground geometry or portals.
- [x] All 16 required automated test scenarios (plus placement diagnostic unit test and real-world Station Hengelo & Amsterdam Centraal benchmark evaluation — 18 tests total) passing in `src/world/TunnelClassificationAndRendering.test.ts`.
- [x] `npm test`, `npm run lint`, `npm run build`, and `npm run docs:api` passing with 0 errors.
- [ ] Owner visual verification (pending project owner review).

## Verification Record (2026-11-11)
- `npm test`: **264 / 264 passed** (`30` test suites, `0` failures, including `18 / 18` in `src/world/TunnelClassificationAndRendering.test.ts`).
- `npm run lint`: **0 errors** (`tsc --noEmit`).
- `npm run build`: **Succeeded** (`vite build`).
- `npm run docs:api`: **Succeeded** (`typedoc`).

