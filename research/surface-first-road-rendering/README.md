# E2+ — Surface-first road rendering experiment

Status: **experimental implementation, preferred architectural direction** after project-owner visual evaluation (2026-11-09). E2 remains selectable and E2+ is not yet the production default. See [ADR-0010](../../docs/decisions/ADR-0010-surface-first-road-rendering.md), [architecture/design](../../docs/e2-plus-surface-first-road-rendering.md), [project history](../../docs/project-history.md) and [roadmap](../../docs/road-rendering-roadmap.md).

## Select

Open Dev Tools → Rendering → Road Infrastructure Engine and choose Graph (E2+).
Graph (E2) retains all of its current junction and continuity behavior.
Use ?topologyRoads=graph-surface for a direct URL selection; use ?topologyRoads=graph to restore E2.
Railways use their existing independent selection. The DevTools repro config records this setting.

## Algorithm

1. Reuse the same topology graph and road render descriptors as E2.
2. Form a rounded 2D stroke from each edge's actual width: union segment rectangles, round bends, and eligible endpoint discs.
3. Resolve overlapping at-grade footprints with the existing deterministic road-class and path/vehicle priority order.
4. Triangulate the visible polygons at the existing road elevation, retaining original OSM source-feature metadata.
5. Leave grade-separated road/railway rendering and renderer materials untouched.

E2+ does not construct explicit at-grade junction patches or alter OSM graph connectivity.
It performs local per-edge Boolean unions, not a city-wide polygon merge.

## Known risks / evaluation

Width transitions and special split/merge junctions do not use the dedicated E2 solver, so inspect those carefully.
The rounded buffers may increase CPU time and polygon count on long, highly curved OSM ways.
Use browser visual comparisons at Nieuwstraat/Stationsplein and the original footway/cycleway pizza slices.
Also compare previously verified vehicular T-junctions, acute forks, grade transitions and wider Hengelo extracts.
Assess surface coverage, material boundaries, holes, width correctness and performance.

Run npx tsx --test src/world/SurfaceFirstRoadRendering.test.ts, npm test, and npm run lint.
These automated tests do not replace project-owner visual inspection.
Do not promote E2+ to the production default without further regression and performance evidence.
