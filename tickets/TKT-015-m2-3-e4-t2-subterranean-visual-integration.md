---
id: TKT-015
title: M2.3-E4-T2 Subterranean Visual Integration & Structural Context
type: feature
status: in_progress
priority: high
created: 2026-11-11
updated: 2026-11-11
---

# TKT-015: M2.3-E4-T2 Subterranean Visual Integration & Structural Context

## Summary
Improve the visual integration of tunnels, underpasses, and their supporting structures (especially retaining walls around railway underpasses such as Europatunnel / Spoorstraat in Hengelo) so that tunnels convincingly disappear underground rather than resembling surface infrastructure with entrance portals, and underground-associated retaining walls/barriers resolve to context-aware structural elevations rather than rendering above ground at `Y = +0.025 m`.

## Context
Parent milestone E4-T (`TKT-014`) established semantic placement classification (`InfrastructurePlacementClassifier.ts`) and continuous 3D underground road and railway geometry. Following inspection of the Europatunnel / Spoorstraat underpass in Hengelo (`6.79181065–6.79268090`, `52.26142465–52.26233994`), the project owner identified two critical visual integration problems:
1. **Tunnels do not convincingly disappear underground**:
   - Dashed underground alignment traces (`Tunnel_Underground_Trace` / `Railway_Tunnel_Traces`) are rendered on the surface at `Y = +0.053 m` in normal viewing mode, reinforcing a surface-level appearance.
   - Tunnel ramp descent at the portal entrance begins at `ROAD_SURFACE` (`+0.050 m`) and intersects/pokes through planar ground-cover polygons (`+0.025 m`) before reaching subterranean depth, while tunnel depth (`-2.0 m`) does not account for explicit clearance requirements (such as `maxheight=3.8` on Europatunnel) plus roof slab cover.
   - Deep underground road/railway meshes remain visible by default beneath opaque ground cover, generating avoidable draw calls.
2. **Underground-associated structures render above ground**:
   - In the Europatunnel DevTools bug report ("Above ground walls", exported November 11, 2026), retaining walls `way/375064982` (`barrier=retaining_wall, layer=-1`) and `way/375064983` (`barrier=retaining_wall, layer=-1`) are rendered at `Y = +0.025 m` (`ELEVATION_POLICY.PARKS`) because `LocalGeoJsonProvider.ts` does not extract vertex node IDs or vertical context for `barrier` features, and `GeometryBuilder.ts` extrudes all barriers from a hardcoded constant `ELEVATION_POLICY.PARKS` (`+0.025 m`) base.
3. **Conflicting vertical tags (`placement.hasConflict`)**:
   - Features with contradictory vertical tags (`unknown_or_conflicting`) were previously skipped in road/railway geometry builders, risking silent loss of source features from `renderedSourceIds`.

## Architectural & Implementation Plan

1. **Reproducible Europatunnel Hengelo Fixture (`src/world/prototype/EuropatunnelHengeloFixture.json`)**:
   - Capture the real OpenStreetMap GeoJSON for the Europatunnel / Spoorstraat bounding box (`6.79181065,52.26142465,6.79268090,52.26233994`) with enriched `_nodeIds` so automated tests and benchmarks deterministically validate `way/375064982`, `way/375064983`, approach walls `way/375047303` and `way/375064985`, Spoorstraat / Europatunnel road (`way/6671250`, `way/230163955`, `way/190592701`), cycleway (`way/532064936`), footway (`way/532064942`), and overhead Hengelo railway tracks (`way/375453820`, `way/375453821`, `way/375392713`, `way/375389977`, `way/375391883`).

2. **Centralized Underground Vertical Clearance & Depth Policy (`src/world/ElevationPolicy.ts`, `src/world/BridgeAndTunnelBuilder.ts`)**:
   - Add `resolveTunnelClearanceAndDepth` in `ElevationPolicy.ts` to compute minimum vertical clearance and subterranean floor depth from explicit `maxheight` tags, road vs. railway/electrified clearance requirements, roof/cover slab thickness below `GROUND_COVER_SURFACE` (`+0.025 m`), and negative OSM `layer` stacking.
   - Ensure graph-connected tunnel chains resolve to a continuous, harmonized subterranean floor elevation across internal tunnel continuations.

3. **Context-Aware Structural Elevation for Barriers & Retaining Walls (`src/world/StructuralContextResolver.ts`, `src/world/LocalGeoJsonProvider.ts`, `src/world/GeometryBuilder.ts`)**:
   - Preserve `nodeIds`, `layer`, and vertical OSM tags on `BarrierFeature` during ingestion.
   - Implement `resolveBarrierStructuralContexts` using shared OSM nodes with approach walls/corridors, compatible vertical tags (`layer < 0`, `tunnel=*`, `cutting=*`, `location=underground`), and a bounded spatial grid index over subterranean tunnels, open cuttings, and portal transition ramps (never using proximity alone or blind fixed negative-layer sinking).
   - Support per-vertex variable `[baseY, topY]` extrusion (`generateProfiledBarrierRibbon3D`):
     - **Enclosed subterranean retaining walls** (e.g., `way/375064982` and `way/375064983` with `barrier=retaining_wall, layer=-1` associated with the Europatunnel underpass): resolve to the subterranean corridor floor (`baseY <= -4.0 m`, `topY <= -0.4 m`) and assign to the subterranean structural layer (`Tunnel_Underground_Barriers`, hidden by default in normal surface viewing while retaining full inspectable metadata).
     - **Open cutting & portal approach walls**: vary `baseY` along the descending ramp/cutting floor while keeping `topY` aligned with surrounding ground (`+0.05 m - +0.075 m`) so the wall supports the open trench side.
     - **Unassociated negative-layer barriers**: preserve conservative surface elevation while recording explicit diagnostic uncertainty (`unassociatedNegativeLayerBarrierCount`).
     - **Ordinary surface walls, fences, hedges, and embankments**: remain unchanged at surface elevation.

4. **Convincing Subterranean Disappearance, Localized Portal Entrance Recess & Visibility Separation (`src/world/BridgeAndTunnelBuilder.ts`, `src/world/GeometryBuilder.ts`, `src/world/infrastructure/railways/RailwayGeometryBuilder.ts`, `src/world/infrastructure/rendering/InfrastructureRenderAdapter.ts`)**:
   - Disable surface dashed underground alignment traces by default (`showUndergroundTunnelTraces?: boolean`, default `false`).
   - Separate visible portal entrance ramp/recess geometry (`Tunnel_Portal_Recesses`, `Tunnel_Entrance_Ramps`) from buried subterranean corridor geometry (`Tunnel_Underground_Roads`, `Tunnel_Underground_Railway_*`, `Tunnel_Underground_Barriers`), setting `visible = false` by default on buried subterranean meshes (`showHiddenUndergroundGeometry?: boolean`, default `false`) so normal viewing avoids unnecessary draw calls while retaining complete source metadata (`faceRanges`) for queryability and cutaway inspection.
   - Construct a tightly bounded localized portal entrance recess and threshold transition so the descending road/railway ramp drops below `GROUND_COVER_SURFACE` (`+0.025 m`) within the portal hood footprint and carving a localized portal mouth opening in overlapping ground-cover polygons without creating large holes, cutting buildings/roads, or introducing z-fighting.

5. **Conservative Diagnosed Fallback for Conflicting Vertical Tags (`GeometryBuilder.ts`, `RailwayGeometryBuilder.ts`)**:
   - Route features with `placementClassification.hasConflict === true` (`unknown_or_conflicting`) to a conservative at-grade surface fallback that preserves source identity (`renderedSourceIds` and `faceRanges`) and records `conflictingPlacementFallbackCount` in diagnostics without fabricating portals, underground geometry, or bridge ramps.

## Acceptance Criteria
- [x] Reproducible Europatunnel Hengelo fixture (`EuropatunnelHengeloFixture.json`) added and verified against `way/375064982` and `way/375064983`.
- [x] `way/375064982` and `way/375064983` no longer render above ground at `Y = +0.025 m`; their structural context resolves to the Europatunnel subterranean corridor floor (`minY <= -4.0 m`, `maxY <= -0.4 m`).
- [x] Dashed underground alignment traces are disabled by default in physical 3D presentation and available only via explicit diagnostic option (`showUndergroundTunnelTraces: true`).
- [x] Tunnel entrances feature a localized portal recess/ramp transition that descends below ground cover inside the portal hood, while buried subterranean road, railway, and barrier meshes remain hidden by default (`visible = false`) with full inspectable metadata preserved.
- [x] Tunnel vertical depth and clearance respect explicit `maxheight` tags and road vs. railway clearance requirements in `ElevationPolicy.ts`.
- [x] Conflicting vertical tags (`unknown_or_conflicting`) use a conservative, explicitly diagnosed surface fallback without silently dropping source features.
- [x] All 15 required scenarios in `src/world/SubterraneanVisualIntegration.test.ts` pass, alongside all existing E2+, R+, E4-A, and E4-T regression suites.
- [x] `npm test`, `npm run lint`, `npm run build`, and `npm run docs:api` pass with 0 errors.
- [ ] Owner visual verification (pending project owner review).

## Verification Results (2026-11-11)
- Automated Test Suite: `280 / 280 passed` (31 suites, 0 failures, 25.4s duration).
  - `SubterraneanVisualIntegration.test.ts`: 15 / 15 passed in 3.05s.
  - Europatunnel Hengelo fixture: walls `way/375064982` and `way/375064983` classify as `subterranean_enclosed` at floor depth `Y = -4.20 m` inside `Tunnel_Underground_Barriers`, hidden by default. Approach walls `way/375047303` and `way/375064985` classify as `cutting_or_portal_approach` and span from depressed floor up to surface rim `Y = +0.075 m`.
  - Station Hengelo & Amsterdam Centraal benchmarks: zero regressions across 67-way Hengelo and 160-way Amsterdam Centraal fixtures.
- TypeScript Lint (`npm run lint` / `tsc --noEmit`): Clean (0 errors).
- Production Build (`npm run build` / `vite build`): Clean (0 errors, 4.30s).
- API Documentation (`npm run docs:api` / `typedoc`): 114 pages generated cleanly (0 errors).

## Follow-up architectural correction — unified surface visibility (2026-11-11)

The original TKT-015 implementation was functionally useful but left three gaps:
standalone tunnel ends produced speculative entrances, landuse cutouts were
generated before validating entrances, and individual renderers applied their
own visibility rules. This follow-up supersedes those portions of the
implementation plan above without changing the source OSM graph.

- **Canonical outdoor visibility:** `SurfaceVisibilityPolicy.ts` resolves a
  feature into surface, elevated, underground, concealed indoor, or conflicting
  placement. It reuses semantic placement classification; `layer` denotes
  relative stacking, `level` denotes a floor within an indoor/structural
  context, and `ele` represents physical elevation. A negative level only
  conceals the feature when there is supporting indoor/building context.
- **Verified entrances:** `VerifiedTunnelEntrances` indexes candidate exposed
  road/rail endpoints. Portal authorization requires an aligned endpoint
  connection with compatible transport type and, where present, matching raw
  OSM node identities. Isolated, internal, clipped, or ambiguous ends are
  closed. Decisions and source terminal positions are immutable across graph
  geometry snapping.
- **One mouth, one cutout:** Road and rail renderers and the ground-cover
  prepass consume the *same* entrance decisions. The prepass uses the pure
  `calculateTunnelPortalGroundCutouts` function, which shares physical mouth
  dimensions with the 3D portal builder and allocates no temporary Three.js
  geometry.
- **No buried production meshes:** The normal scene does not build underground
  road, railway or enclosed barrier meshes. An explicit
  `showHiddenUndergroundGeometry` inspection option enables geometry for
  cutaway debugging. Diagnostic tunnel traces are also allocated only when
  `showUndergroundTunnelTraces` is enabled. Source graph, feature tags and
  structural context remain available independently of scene meshes.
- **Regression contract:** Unit and integration fixtures cover negative
  `layer` versus negative `level`, isolated/deep tunnels, reverse-digitized
  links, coordinate/node-ID conflicts, modal separation, consistency of
  cutouts and portals, and debug-mode generation.

**Known limitation:** The entrance policy deliberately requires strong
evidence and can omit some real tunnel mouths if the OSM extract does not
include adjacent surface ways or if terminal geometry is unreliable. Its
strict default is preferable to inventing deep underground infrastructure.
Physical map correctness still requires project owner review; automated
tests alone do not establish visual correctness.
