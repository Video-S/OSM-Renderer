---
id: TKT-004
title: M2.3-B Road Network Graph Construction and Non-Destructive Topology Input
type: feature
status: in_progress
priority: high
created: 2026-11-05
updated: 2026-11-05
---

# TKT-004: M2.3-B Road Network Graph Construction and Non-Destructive Topology Input

## Summary
Implement **Stage B (`M2.3-B`)** of Milestone 2.3 (*Infrastructure Topology and Connectivity*) per accepted **[ADR-0009](../docs/decisions/ADR-0009-infrastructure-graph-topology.md)**: preserve non-destructive pre-deduplication/pre-chaining road topology inputs (`ProcessedMapData.topologySource`), preserve explicit per-vertex OSM node IDs across live Overpass/XML conversion and region clipping where vertex alignment is verified, and implement pure-TypeScript road network graph construction (`RoadNetworkBuilder`) with comprehensive automated tests (`T-01` through `T-10`, `T-16`, and Stage B of `T-17`).

## Context
Following project-owner approval of `ADR-0009` and closure of `TKT-003` (`M2.3-A`), Stage B (`M2.3-B`) is authorized to build the road topology layer in isolation without altering `GeometryBuilder`'s current road junction rendering or implementing Stages C–E (`RailwayNetworkBuilder`, `CrossModalAnalyzer`, renderer integration).

## Observed behavior
Prior to Stage B:
1. `LocalGeoJsonProvider.parseGeoJson()` applies heuristic `seenRoadSegments` deduplication and destructive `chainContiguousRoads()` in-place mutation before returning `ProcessedMapData`, discarding original unchained way boundaries, secondary way `osmTags`, and per-part boundary-clip flags.
2. Live Overpass JSON and OSM 0.6 XML conversions via `osmtogeojson` in `server.ts` do not preserve way node ID lists (`way.nodes` / `<nd ref>`) on converted GeoJSON features, and `LocalGeoJsonProvider` drops `rawOsmNodes` on `MultiLineString` geometries.
3. No standalone, OSMnx-style `RoadNetwork` graph builder exists under `src/world/infrastructure/topology/`.

## Expected behavior
1. **Non-Destructive `TopologySourceData` Handoff**:
   - `ProcessedMapData.topologySource` captures immutable `UnchainedRoadPart` records after metric projection, `clipPolylineToBox`, and culvert/grade classification—**before** `seenRoadSegments` heuristic deduplication and **before** `chainContiguousRoads`.
   - `mapData.roads` and legacy renderer behavior remain 100% unchanged, with zero shared mutable references between `topologySource` and `mapData.roads`.
2. **Verified Per-Vertex OSM Node ID Preservation**:
   - Live Overpass JSON (`way.nodes`), OSM 0.6 XML fallback (`<nd ref>`), and local GeoJSON properties (`nodes`, `nodeIds`, `_nodeIds`) preserve per-vertex raw OSM node IDs when way identity and vertex coordinate alignment are verified.
   - `clipPolylineToBox` propagates raw OSM node IDs only on surviving original vertices while marking synthetic boundary-cut endpoints (`clippedAtStart`, `clippedAtEnd`) with `undefined` raw OSM node IDs.
3. **Pure-TypeScript `RoadNetworkBuilder` (`src/world/infrastructure/topology/`)**:
   - Builds `RoadNetwork` (`nodes: ReadonlyMap<string, RoadNode>`, `edges: ReadonlyMap<string, RoadEdge>`, `featureToEdgeIds`) with domain-and-scope-isolated node IDs, reusing/extending `TopologicalNodeIndex`.
   - Supports explicit OSM node precedence, `0.15 m` coordinate fallback, boundary-clipped endpoint isolation, interior junction splitting, self-loops / P-loops, isolated closed loops (`loop_anchor`), parallel multi-edges (`parallelIndex`), `incidentHalfEdges` vs. `incidentEdgeIds` degree invariants, non-interstitial degree-2 simplification with road attribute and one-way guards, per-segment provenance (`reversedRelativeToSource`), strict `1 mm` vertex-by-vertex duplicate detection, and qualified input-order determinism.

## Acceptance criteria
- [x] `TopologySourceData`, `UnchainedRoadPart`, `RoadNode`, `RoadEdge`, `RoadNetwork`, `EdgeProvenance`, and Stage B topology contracts implemented under `src/world/infrastructure/topology/` and wired onto `ProcessedMapData.topologySource`.
- [x] `LocalGeoJsonProvider` captures `UnchainedRoadPart` records before `seenRoadSegments` and before `chainContiguousRoads` with no shared mutable references and zero changes to legacy `mapData.roads` output.
- [x] Reliable per-vertex OSM node ID preservation implemented for Overpass JSON, OSM 0.6 XML, and local GeoJSON (`LineString`, `MultiLineString`, and `clipPolylineToBox` boundary-cut flags) only where vertex alignment is verified.
- [x] `RoadNetworkBuilder` implemented in pure TypeScript with zero React, Three.js, renderer, or WebGL dependencies, and without implementing Stages C, D, or E.
- [x] Automated test suite (`src/world/RoadNetworkTopology.test.ts`) passing via `npm test` (`tsx --test`), covering fixtures `T-01` through `T-10`, `T-16`, Stage B of `T-17`, clipping node-ID propagation, forward/reverse `1 mm` duplicate detection, input immutability, offline Overpass/XML node-ID enrichment (valid and invalid alignment), and M2.2 preset/cache separation.
- [x] Reproducible parser vs. road-graph construction performance measurements recorded on synthetic and real OSM extracts.
- [x] `npm test`, `npm run lint`, `npm run build`, and `npm run docs:api` executed and passing with zero errors.
- [ ] Project owner reviews Stage B implementation to close `TKT-004`.

## Implementation notes
- Implemented `src/world/infrastructure/topology/types.ts`, `OsmNodeIdEnricher.ts`, `RoadNetworkBuilder.ts`, and `InfrastructureGraph.ts` with zero React, Three.js, renderer, or WebGL imports.
- Updated `TopologicalNodeIndex.ts` with deterministic distance tie-breaking and explicit OSM node helpers (`isExplicitNode`, `extractRawOsmNodeId`).
- Updated `LocalGeoJsonProvider.ts` so `clipPolylineToBox` records `clippedAtStart` / `clippedAtEnd` and clears node IDs on boundary exit cuts, `extractVerifiedPartOsmNodeIds` validates per-part node ID lengths for `LineString` and `MultiLineString`, `@id` is supported alongside `props.id` and `f.id`, and `ProcessedMapData.topologySource.roadParts` is populated with deep-cloned `UnchainedRoadPart` records prior to `seenRoadSegments` and `chainContiguousRoads`.
- Wired `enrichGeoJsonWithOverpassNodeIds` and `enrichGeoJsonWithOsmXmlNodeIds` into `server.ts` immediately after `osmtogeojson`.
- Targeted Correctness & Regression Fixes (post-review):
  1. *Enforced accepted one-way simplification semantics*: In `RoadNetworkBuilder.ts`, `canContractDegree2RoadNode` strictly enforces identical `rawOnewayTag` per ADR-0009 Section 4.3 (blocking e.g. `oneway=yes` + `oneway=-1`, and omitted `oneway` + explicit `oneway=no`), along with continuous traffic flow. Updated `T-08` with 6 explicit positive and negative one-way cases.
  2. *Prevented semantic data loss during duplicate detection*: Exported `getCanonicalMeaningfulOsmTagsString` (excluding only internal node-enrichment and identity keys: `nodes`, `nodeIds`, `_nodeIds`, `_nodeIdsByPart`, `id`, `@id`), incorporated canonical tags into `compareRoadPartsCanonically` pre-sorting, and included the canonical tags string in `bucketKey`. Added test coverage in `T-16` proving identical geometries with different `surface`, `turn:lanes`, or directional attributes remain distinct graph edges.
  3. *Verified renderer isolation for live node-ID enrichment*: In `LocalGeoJsonProvider.ts`, separated legacy node extraction (`extractLegacyPartOsmNodeIds`, reading only legacy `nodes` / `nodeIds`) from topology node extraction (`extractVerifiedTopologyPartOsmNodeIds`, reading `_nodeIdsByPart` / `_nodeIds` / `nodes` / `nodeIds`). Guaranteed byte-for-byte identical legacy `mapData.roads`, `mapData.railways`, chained geometries, and `GeometryBuilder` scene meshes between raw and enriched GeoJSON.
  4. *Tightened coordinate-alignment verification*: Set `COORD_ALIGNMENT_TOLERANCE_DEG = 1e-7` (~1.1 cm, matching OSM 7-decimal-place precision and strictly below the 15 cm snap radius). Tested Overpass JSON and XML rejection for displaced coordinates (`1e-6` deg and `0.01` deg).
- Per project instructions, `TKT-004` remains `in_progress` pending project-owner review.

## Verification
- Status: Implemented and verified (2026-11-05); awaiting project-owner review to close.
- Executed verification commands:
  - `npm test` (`tsx --test src/world/*.test.ts`): Exit code `0` — **107 / 107 tests passed** (`0` failures), including all Stage B tests in `src/world/RoadNetworkTopology.test.ts`.
  - `npm run lint` (`tsc --noEmit`): Exit code `0` — `0` TypeScript errors.
  - `npm run build` (`vite build`): Exit code `0` — production bundle generated cleanly.
  - `npm run docs:api` (`typedoc`): Exit code `0` — API documentation generated in `docs/api-reference/`.
- Recorded Stage B performance benchmark runs (`src/world/RoadNetworkTopology.test.ts`):
  - **Run 1 (initial run)**:
    - 270-Way Synthetic Urban Road Grid: `parseGeoJson = 12.61 ms`, `buildRoadNetwork = 11.85 ms` (`parts = 270`, `nodes = 100`, `edges = 180`, `simplified = 90`).
    - Station Hengelo Real OSM + Urban Roads (282 features): `parseGeoJson = 7.52 ms`, `buildRoadNetwork = 6.41 ms` (`parts = 120`, `nodes = 14`, `edges = 7`, `simplified = 113`).
    - Amsterdam Centraal Real OSM + Urban Roads (1041 features): `parseGeoJson = 27.78 ms`, `buildRoadNetwork = 10.50 ms` (`parts = 273`, `nodes = 106`, `edges = 183`, `simplified = 90`).
  - **Run 2 (post-fix verification run)**:
    - 270-Way Synthetic Urban Road Grid: `parseGeoJson = 11.63 ms`, `buildRoadNetwork = 11.03 ms` (`parts = 270`, `nodes = 100`, `edges = 180`, `simplified = 90`).
    - Station Hengelo Real OSM + Urban Roads (282 features): `parseGeoJson = 12.10 ms`, `buildRoadNetwork = 6.11 ms` (`parts = 120`, `nodes = 14`, `edges = 7`, `simplified = 113`).
    - Amsterdam Centraal Real OSM + Urban Roads (1041 features): `parseGeoJson = 40.26 ms`, `buildRoadNetwork = 14.68 ms` (`parts = 273`, `nodes = 106`, `edges = 183`, `simplified = 90`).

## Related files and documentation
- Source: `src/world/infrastructure/topology/types.ts`, `src/world/infrastructure/topology/OsmNodeIdEnricher.ts`, `src/world/infrastructure/topology/RoadNetworkBuilder.ts`, `src/world/infrastructure/topology/InfrastructureGraph.ts`, `src/world/TopologicalNodeIndex.ts`, `src/world/LocalGeoJsonProvider.ts`, `src/types/MapFeature.ts`, `server.ts`
- Tests: `src/world/RoadNetworkTopology.test.ts`, `src/world/JunctionAndTopology.test.ts`
- Documentation: `docs/decisions/ADR-0009-infrastructure-graph-topology.md`, `docs/STATUS.md`, `docs/architecture.md`, `docs/data-pipeline-and-feature-support.md`, `docs/testing-and-diagnostics.md`

