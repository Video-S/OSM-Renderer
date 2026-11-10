---
id: TKT-012
title: M2.3-E3-B Experimental Surface-First Railway Ballast (R+)
type: experiment
status: closed
priority: medium
created: 2026-11-10
updated: 2026-11-10
---

# TKT-012: M2.3-E3-B Experimental Surface-First Railway Ballast (R+)

## Summary
Implement and evaluate an experimental **surface-first railway ballast renderer (R+)** under an opt-in mode (`?topologyRailways=graph-R+` / `railwayBallastStrategy: 'surface-first'`), unifying overlapping at-grade crushed-stone ballast footprints into planar 2D polygons while keeping rails, sleepers, turnout switch semantics, and bridge/tunnel profiles completely unchanged.

## Context
Following the acceptance of Stage E3-A2 (`TKT-011`), railway rendering is in a solid state with graph-informed switch semantics. The project priority is completing a convincing, navigable 3D map of Hengelo. This experiment evaluates whether unifying overlapping ballast footprints produces cleaner visuals and geometry without introducing unacceptable complexity, performance costs, or regressions.

## Investigation of Initial Overlap Benefit
Measured overlapping positive-area ballast across benchmark datasets with $3.5\text{ m}$ standard track beds:
- **Synthetic Switchyard (65 ways)**: $1,636.5\text{ m}²$ redundant overlap ($14.49\%$ of individual ballast area), 153 overlapping pairs across switches and yard tracks.
- **Station Hengelo (67 ways)**: $7,719.9\text{ m}²$ redundant overlap ($16.89\%$ of individual ballast area), 209 overlapping pairs at crossovers and station throat.
- **Amsterdam Centraal (144 at-grade ways)**: $6,661.7\text{ m}²$ redundant overlap ($17.88\%$ of individual at-grade ballast area), 280 overlapping pairs.
Standard parallel tracks spaced at $3.8\text{–}4.2\text{ m}$ centers do not overlap; overlaps occur predominantly at switches, crossovers, and converging throats. Consolidating overlapping footprints into unified planar surfaces eliminates all coplanar self-intersection.

## Implementation Details

1. **SurfaceFirstRailwayBallast (`src/world/infrastructure/railways/SurfaceFirstRailwayBallast.ts`)**:
   - `buildAtGradeBallastFootprints`: filters to at-grade tracks (`layer === 0 && !isBridge && !isTunnel`), generating 2D buffered footprints using `bufferSurfaceFirstRoadCenterline` with rounded endpoint caps.
   - `groupBallastConnectedComponents`: partitions footprints into disjoint connected components via Disjoint Set Union (DSU) using AABB pruning and exact 2D planar polygon intersection. Computes 2D Boolean union per component via `polygon-clipping` (`polygonClipping.union`) and filters degenerate slivers.
   - `buildSurfaceFirstRailwayBallastGeometries`: triangulates union polygons into 3D BufferGeometries via `createShapesFromMultiPolygon` and `THREE.ShapeGeometry`, normalizes normals to `[0, 1, 0]`, offsets to `ballastElevationY` ($+0.060\text{ m}$), assigns planar UVs and switch attributes for `BufferGeometryUtils.mergeGeometries` compatibility, and attaches rich multi-source `InspectableFeatureInfo`.

2. **Integration into Railway Engine (`RailwayGeometryBuilder.ts`)**:
   - Extended `BuildRailwayPrototypeOptions` and `RailwayPrototypeStats` with `ballastStrategy`, `ballastFootprintCount`, `ballastComponentCount`, `ballastBooleanUnionCount`, and `ballastTriangles`.
   - In `buildRailwayGroupInternal`, conditionally generates R+ ballast for at-grade tracks while strictly preserving ribbon ballast for elevated bridges and tunnels.
   - Rails, 3D instanced sleepers, turnout bearers, switch blade tapering, and bridge/tunnel geometries remain 100% identical to Candidate B.
   - Provides safe fallback to ribbon ballast if 0 geometries are produced.

3. **Adapter & DevTools (`InfrastructureRenderAdapter.ts`, `GeometryBuilder.ts`, `DevToolsPanel.tsx`)**:
   - Added `'graph-R+'` to `RailwayInfrastructureRenderSource` and `RailwayBallastStrategy` (`'ribbon' | 'surface-first'`).
   - Wired URL query param support (`?topologyRailways=graph-R+` / `railwayBallastStrategy=surface-first`).
   - Added interactive `Graph + R+ (E3-B)` switch button to `DevToolsPanel.tsx`.

## Comparative Benchmark & Performance Measurements

| Metric | Synthetic Switchyard (65 ways) | Station Hengelo (67 ways) | Amsterdam Centraal (325 ways) |
| :--- | :--- | :--- | :--- |
| **Ribbon: Ballast Triangles** | 1,154 | 3,364 | 9,988 |
| **R+: Ballast Triangles** | **636** (-45%) | **1,959** (-42%) | **4,077** (-59%) |
| **Redundant Overlap Eliminated** | **1,636.5 m²** (100%) | **7,719.9 m²** (100%) | **6,661.7 m²** (100%) |
| **Coplanar Overlaps in Ballast** | 0.00 m² | 0.00 m² | 0.00 m² |
| **Ribbon: Total Triangles** | 11,550 | 32,970 | 141,694 |
| **R+: Total Triangles** | 11,032 | 31,633 | 140,237 |
| **Ribbon: Draw Calls** | 36 | 60 | 155 |
| **R+: Draw Calls** | **33** | **50** | **154** |
| **Ribbon: CPU Buffer Memory** | 0.693 MB | 1.895 MB | 7.320 MB |
| **R+: CPU Buffer Memory** | **0.662 MB** | **1.821 MB** | **7.241 MB** |
| **3D Sleeper Boxes (Both Modes)** | 4,004 (Identical) | 11,697 (Identical) | 24,408 (Identical) |
| **Turnout Bearers (Both Modes)** | 5 (Identical) | 921 (Identical) | 2,024 (Identical) |
| **Ribbon: Total Build Time** | 207.7 ms | 213.5 ms | 584.8 ms |
| **R+: Total Build Time** | 260.3 ms (+52.6 ms) | 332.4 ms (+118.9 ms) | 756.3 ms (+171.5 ms) |

## Stopping Gate Evaluation & Recommendation

We evaluated the four prescribed stopping gate outcomes:
- **Outcome A (Adopt R+ for All At-Grade Ballast)**: Technically feasible and cleanly working, but default promotion requires project owner visual sign-off.
- **Outcome B (Hybrid Selection: R+ only where overlaps detected)**: Unnecessary complexity since R+ connected-component clustering naturally isolates non-overlapping tracks with 0 Boolean union cost.
- **Outcome C (Retain Ribbon Ballast; Archive R+)**: Valid if project owner prefers ribbon simplicity, but misses out on 42–59% ballast triangle reduction and complete elimination of Z-fighting in station yards.
- **Outcome D (Defer R+ and Prioritize E4 Bridges/Tunnels) — RECOMMENDED**:
  - Keep `topologyRailways='legacy'` as default production renderer.
  - Keep `graph-R+` (`railwayBallastStrategy: 'surface-first'`) available in developer tools and search params for visual inspection.
  - Stop at E3-B for project-owner review without executing unauthorized stages E3-C, E3-D, or E4.

## Acceptance Criteria
- [x] Measure and document existing ballast ribbon overlap across Switchyard, Hengelo, and Amsterdam Centraal.
- [x] Implement `src/world/infrastructure/railways/SurfaceFirstRailwayBallast.ts` constructing 2D footprints, grouping connected components, computing 2D unions, and triangulating ballast surfaces.
- [x] Support opt-in `graph-R+` render source and `railwayBallastStrategy: 'ribbon' | 'surface-first'` in `InfrastructureRenderAdapter.ts` and `RailwayGeometryBuilder.ts`.
- [x] Provide observable switch and toggle in `DevToolsPanel.tsx`.
- [x] Add automated test suite validating non-overlapping ballast, connected components, provenance preservation, determinism, bridge/tunnel isolation, and resource disposal.
- [x] Measure comparative performance and geometry metrics (Ribbon vs. R+) across all three benchmark datasets.
- [x] Deliver recommendation among the four stopping gate outcomes (Outcome D recommended).
- [x] Verify `npm test`, `npm run lint`, `npm run build`, and `npm run docs:api` pass cleanly.

## Verification
- `npm test`: **235 / 235 passed** (28 test suites, 0 failures, 8 new Stage E3-B tests).
- `npm run lint`: Clean (0 errors).
- `npm run build`: Successful (`dist/` generated).
- `npm run docs:api`: Generated cleanly.
