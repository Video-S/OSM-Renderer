# Geographic Data Pipeline & Feature Support

## 1. Data Sources and Provider Implementations

The data pipeline ingests OpenStreetMap vector geographic data through two concrete implementations of the `MapDataProvider` interface (`src/world/MapDataProvider.ts`):

1. **`LocalGeoJsonProvider` (`src/world/LocalGeoJsonProvider.ts`)**:
   - Ingests pre-bundled GeoJSON files or fixture datasets (e.g. Amsterdam, Paris, London, Manhattan samples).
   - Operates offline and serves as the primary engine for reproducible automated unit and regression testing.
   - Accepts options for `defaultBuildingHeight` (default `12.0 m`) and `levelHeightMeters` (default `3.2 m`).
2. **`OsmApiProvider` (`src/world/OsmApiProvider.ts`)**:
   - Fetches live bounding-box data from the public OpenStreetMap Overpass API using `osmtogeojson` to convert raw OSM XML/JSON to standard GeoJSON FeatureCollections.
   - Enforces query timeout limits and handles geographic bounding box queries.

---

## 2. Coordinate Conversion & Local World Origin

The pipeline converts spherical WGS84 coordinates `(longitude, latitude)` into metric Cartesian coordinates `(X, Y, Z)` in meters via `src/world/WorldCoordinates.ts`:

- **Origin Anchor**: Tangent to the dataset center `(originLon, originLat)`.
- **Projection Equations**:
  $$X = R_{\text{WGS84}} \cdot (\text{lon} - \text{originLon}) \cdot \frac{\pi}{180} \cdot \cos(\text{originLat} \cdot \frac{\pi}{180})$$
  $$Z = -R_{\text{WGS84}} \cdot (\text{lat} - \text{originLat}) \cdot \frac{\pi}{180}$$
  where $R_{\text{WGS84}} = 6,378,137.0\text{ m}$.
- **Axes Convention**:
  - `+X`: East (meters).
  - `+Y`: Up / Elevation (meters).
  - `+Z`: South (meters), so North points along `-Z`.

---

## 3. Geographic Boundary Clipping

To prevent geometry from bleeding beyond requested viewport bounds, all geographic features are clipped against the axis-aligned bounding box `[-clipRadius, -clipRadius, +clipRadius, +clipRadius]` in meters:

### Polyline Clipping (`clipPolylineToBox`)
- Implemented using the **Liang-Barsky** parametric line-clipping algorithm.
- Clips line segments to box boundaries, preserving contiguous polyline sub-segments and splitting crossing lines into distinct segments.
- Preserves raw OSM node IDs at surviving original vertices while clearing raw node IDs (`undefined`) on newly interpolated boundary intersection points and setting explicit `clippedAtStart` and `clippedAtEnd` flags.

### Polygon Clipping (`clipPolygonRingsToBox`)
- Primary pass: Evaluates polygon intersection using Martínez-Rueda boolean clipping via `polygon-clipping.intersection()`.
- **Topology-Aware Fallback (`clipPolygonWithTopologyAwareFallback`)**:
  - Activated if the primary boolean library throws an error or when `options.forceFallback` is set.
  - Decomposes concave contours and interior holes into planar convex triangles using `THREE.ShapeUtils.triangulateShape`.
  - Clips each convex triangle against the bounding box using Sutherland–Hodgman clipping.
  - Reconstructs clean MultiPolygon parts via `polygonClipping.union()`.
  - Ensures concave polygons (e.g. U-shaped footprints) cut by the boundary emit distinct MultiPolygon components (`polygons.length > 1`) instead of malformed bridge-connected loops.
  - Prunes boundary-crossing holes from interior status and turns them into boundary indentations.
  - Drops sliver holes (`< 0.05 m²`) or self-intersecting holes while preserving the valid outer ring. Rejects un-triangulable outer boundaries returning `[]`.

---

## 4. Feature Classification & Support Matrix

The pipeline classifies OSM tags into strongly typed categories defined in `src/types/MapFeature.ts` and styled in `src/world/FeatureCatalogue.ts`:

| Feature Category | Significant OSM Tags | Parsing Support | 3D Rendering Support | Details |
| :--- | :--- | :--- | :--- | :--- |
| **Highways & Roads** | `highway=*` (`motorway`, `primary`, `secondary`, `residential`, `service`, `footway`, `cycleway`, `path`, etc.) | **Full** | **Full** | Rendered as 3D ribbons with boundary-derived junction meshing and miter limits at uniform `ROAD_SURFACE = 0.050 m`. |
| **Railways** | `railway=rail`, `light_rail`, `subway`, `tram` | **Full** | **Full** | Multi-tier procedural tracks: ballast at `+0.060 m`, sleepers at `+0.072 m`, rails at `+0.085 m`. |
| **Buildings** | `building=*`, `building:levels=*`, `height=*` | **Full** | **Full** | 2D footprint polygon with interior courtyard holes, extruded vertically into 3D prisms. Defaults to 12.0m or 3.2m per level. |
| **Bridges** | `bridge=yes`, `bridge:movable=*`, `layer > 0` | **Full** | **Full** | Elevated road decks at `+2.850 m` with sloped approach ramps (`min(12m, 30%)`), concrete parapets, and pier pillars. |
| **Tunnels** | `tunnel=yes`, `covered=yes`, `layer < 0` | **Full** | **Full** | Subterranean paths at `-2.0 m`, 3D dark entrance portals, approach ramps, and dashed underground surface traces. |
| **Water Bodies** | `natural=water`, `water=*`, `landuse=basin`, `reservoir` | **Full** | **Full** | Depressed basins at `WATER_SURFACE = +0.015 m`, cut out of overlapping ground-cover polygons. |
| **Linear Waterways**| `waterway=river`, `canal`, `stream`, `ditch` | **Full** | **Full** | Ribbon strips at `+0.015 m`. Narrow streams under roads (`< 15 m`) remain continuous as culverts. |
| **Parks & Green Space**| `leisure=park`, `garden`, `pitch`, `landuse=grass`, `forest` | **Full** | **Full** | Ground-cover surfaces at `GROUND_COVER_SURFACE = +0.025 m`. Tree instancing on forest areas. |
| **Land-Use Zones** | `landuse=residential`, `commercial`, `industrial`, `retail` | **Full** | **Full** | Flush planar fills at `+0.025 m` with mutually exclusive 2D Boolean subtraction. |
| **Parking Facilities** | `amenity=parking`, `parking=*`, `amenity=parking_space` | **Full** | **Full** | Paved lot fills at `+0.025 m`, parking spaces at `+0.028 m`, painted stall stripes at `+0.029 m`. |
| **Barriers & Fences** | `barrier=wall`, `fence`, `hedge` | **Full** | **Partial** | Linear ribbons or extrusions at ground level. |
| **Point Landmarks** | `amenity=fountain`, `historic=monument`, `natural=tree` | **Partial** | **Partial** | Instanced geometric markers (trees, benches, monuments). |

---

## 5. Topology, Node Indexing & Road/Railway/Cross-Modal Graphs (`ADR-0009`)

The topological networks of roads, railways, and linear paths are managed by `TopologicalNodeIndex` (`src/world/TopologicalNodeIndex.ts`), `OsmNodeIdEnricher` (`src/world/infrastructure/topology/OsmNodeIdEnricher.ts`), `RoadNetworkBuilder` (`src/world/infrastructure/topology/RoadNetworkBuilder.ts`), `RailwayNetworkBuilder` (`src/world/infrastructure/topology/RailwayNetworkBuilder.ts`), `CrossModalAnalyzer` (`src/world/infrastructure/topology/CrossModalAnalyzer.ts`), and `buildInfrastructureGraph` (`src/world/infrastructure/topology/InfrastructureGraph.ts`):

- **Verified Per-Vertex OSM Node ID Enrichment (`OsmNodeIdEnricher.ts`)**:
  - In `server.ts`, immediately after `osmtogeojson` converts Overpass JSON (`way.nodes`) or OSM 0.6 XML (`<nd ref>`), `enrichGeoJsonWithOverpassNodeIds` and `enrichGeoJsonWithOsmXmlNodeIds` attach `properties._nodeIds` (for `LineString`) or `properties._nodeIdsByPart` (for `MultiLineString`) **only** when way identity and 1:1 per-vertex coordinate alignment (`<= 1e-5` deg) against the OSM node table are verified.
- **Explicit Node ID Precedence & 15 cm Coordinate Fallback**:
  - `TopologicalNodeIndex` preserves explicit OSM node IDs (`nodes`, `nodeIds`, `_nodeIds`, `_nodeIdsByPart`) across ways; two distinct explicit OSM node IDs never merge even if their coordinates coincide.
  - When explicit IDs are omitted, endpoints within a **15 cm** (`0.15 m`) radius are clustered into a shared topological node with deterministic tie-breaking.
- **Boundary-Clipped Endpoint Isolation**:
  - Synthetic endpoints created by `clipPolylineToBox` (`clippedAtStart` / `clippedAtEnd`) receive isolated `boundary_clip` node identities in `RoadNetworkBuilder` and `RailwayNetworkBuilder` so two unrelated ways clipped near the same bounding-box edge never snap into a false junction.
- **Layer-Scoped Isolation (`layerScope`)**: Node lookups are partitioned by `${layer}|${isBridge}|${isTunnel}`. A grade-separated bridge or subterranean tunnel passing over an at-grade road or railway at identical $(X, Z)$ coordinates is strictly isolated and never generates a spurious 4-way intersection.

---

## 6. Non-Destructive Topology Source vs. Legacy Feature Chaining

To satisfy both the current 3D renderer and the `ADR-0009` infrastructure graph:
- **Non-Destructive Topology Capture (`ProcessedMapData.topologySource`)**:
  - Immediately after metric projection, `clipPolylineToBox`, and culvert/grade classification—and **before** `seenRoadSegments` heuristic deduplication and **before** `chainContiguousRoads`—`LocalGeoJsonProvider` captures cloned `UnchainedRoadPart` records into `ProcessedMapData.topologySource.roadParts` and cloned `UnchainedRailwayPart` records into `ProcessedMapData.topologySource.railwayParts`.
  - Point features inside the clipped bounds matching any of the five `InfrastructurePointKind` categories (`railway=switch` $\to$ `'railway_switch'`, `railway=railway_crossing` $\to$ `'railway_crossing_flat'`, `railway=level_crossing` $\to$ `'railway_level_crossing'`, `railway=crossing` $\to$ `'railway_ped_crossing'`, and `highway=crossing` $\to$ `'highway_crossing'`) are captured in `ProcessedMapData.topologySource.infrastructurePoints` (`InfrastructurePointMetadata[]`) without altering `mapData.landmarks` or skipped-feature diagnostics.
- **`RoadNetworkBuilder`, `RailwayNetworkBuilder`, `CrossModalAnalyzer` & `buildInfrastructureGraph` (`src/world/infrastructure/topology/`)**:
  - `RoadNetworkBuilder` consumes `topologySource.roadParts` and `highway=crossing` points to construct `RoadNetwork` (`nodes`, `edges`, `featureToEdgeIds`), performing strict `1 mm` (`1e-3 m`) vertex-by-vertex duplicate detection, interior OSM junction splitting, P-loop and isolated closed-loop (`loop_anchor`) preservation, parallel multi-edge indexing (`parallelIndex`), and OSMnx-style degree-2 simplification with road attribute, one-way, and crossing/portal protection guards plus full per-segment provenance (`reversedRelativeToSource`).
  - `RailwayNetworkBuilder` consumes `topologySource.railwayParts` and railway `topologySource.infrastructurePoints` to construct `RailwayNetwork` and `RailwayFlatCrossingRelation[]`, enforcing railway attribute and crossing/portal simplification guards, conservative turnout (`1-to-2` throat) classification (`confirmed`, `unresolved_main_vs_diverging`, `unresolved_throat`), and non-interconnecting flat diamond crossing decoupling.
  - `CrossModalAnalyzer` and `buildInfrastructureGraph` derive `LevelCrossingRelation[]` (`road_rail_level_crossing` and `pedestrian_rail_crossing`), `GradeTransitionRelation[]` (Tier 1 explicit OSM portal nodes and Tier 2 `0.15 m` terminal collinear coordinate fallback), `GradeSeparatedCrossingRelation[]` (overpasses and underpasses across road and railway domains), and deterministic `TopologyDiagnostics`.
- **Graph-to-Renderer Adapter (`src/world/infrastructure/rendering/InfrastructureRenderAdapter.ts`, `M2.3-E1`)**:
  - Converts `InfrastructureGraph` into deterministic, deeply cloned `InfrastructureRenderDescriptorBundle` records (`roadEdges`, `roadNodes`, `railwayEdges`, `railwayNodes`, `railwayFlatCrossings`, `levelCrossings`, `gradeTransitions`, `gradeSeparatedCrossings`, and `unresolvedDiagnostics`).
  - Reconstructs full source-feature lineage (`sourceFeatureToRoadEdgeIds`, `sourceFeatureToRailwayEdgeIds`, `roadFeatureLineage.chainingMap`, `roadFeatureLineage.deduplicatedMap`, `railwayFeatureLineage.chainingMap`, and `railwayFeatureLineage.deduplicatedMap`) from `EdgeProvenance.segments` so every simplified or deduplicated OSM feature ID remains traceable.
- **Renderer-Facing Legacy Pipelines (`mapData.roads` & `mapData.railways`)**:
  - Through Milestone 2.3 Stage E1, `LocalGeoJsonProvider` continues to populate `mapData.roads` and `mapData.railways` with zero behavioral changes for `GeometryBuilder` and `RailwayGeometryBuilder`, and `'legacy'` remains the default `InfrastructureRenderSource` for both domains until Stages E2–E5 are separately authorized.

---

## 7. Diagnostic Accounting & Error Handling

Every parsing run records exhaustive diagnostic metrics in `MapFeatureDiagnostics`:
- `sourceFeaturesReceived`: Raw feature count from GeoJSON input.
- `sourceFeaturesClassified`: Successfully mapped features.
- `parsedByCategory`: Breakdown across buildings, roads, railways, water, etc.
- `rejectedInvalid`: Rejected degenerate geometries with reason codes:
  - `invalid_self_intersecting_building_polygon`
  - `degenerate_building_polygon (< 3 points or zero area)`
  - `degenerate_path_clipping_failure`
- `sourceFeaturesRendered` & `constructedMeshesCount`: Metrics for rendered geometry parts.

---

## 8. Limitations & Source Data Edge Cases

- **Self-Intersecting Polygons**: Bowtie or figure-8 building polygons violate simple polygon topology. The pipeline detects self-intersections and rejects them to avoid corrupted ear-clipping triangulation.
- **Unclosed Outer Rings**: Open polygon rings are automatically closed if the endpoint gap is within tolerance, or rejected if degenerate.
- **Complex Multi-Polygon Relations**: Relations with multiple nested outer and inner boundaries rely on `osmtogeojson` preprocessing; ambiguous boundary definitions can occasionally omit inner cutouts.
