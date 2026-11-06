# Geometry and Rendering Rules

## 1. Physical Elevation Policy & Stacking Conventions

The 3D map viewer enforces a single, authoritative, physically grounded elevation model defined in `src/world/ElevationPolicy.ts`.

### Core Architectural Principles
1. **Separation of 2D Semantic Ownership and 3D Physical Elevation**:
   - Mutually exclusive ground-cover fills (land-use, subzoning, parks, paved lots, sports pitches) are resolved in 2D via batch MultiPolygon Boolean subtraction (`polygon-clipping`). Because their footprints are strictly disjoint, all ground-cover surfaces share a single flush elevation plane (`GROUND_COVER_SURFACE = +0.025 m`), producing seamless 0.0 mm flush boundaries without z-fighting.
2. **Uniform At-Grade Road Baseline (`ROAD_SURFACE = +0.050 m`)**:
   - All ordinary at-grade roads, residential streets, footpaths, and cycleways share the agreed physical elevation baseline of **`+0.050 m`**.
   - Ordinary roads of different classes (`primary`, `residential`, `footway`, `cycleway`) **never** receive arbitrary physical elevation tiers or feature-ID micro-offsets. Micro-offsets conceal defects rather than fixing them and create stepped seams at intersections.
   - Coplanar road overlaps at intersections are eliminated geometrically in 2D via boundary-derived junction meshing and Boolean carriageway subtraction.
3. **Multi-Tiered Surface Constants**:

| Physical Layer | Elevation (Y) | Description |
| :--- | :--- | :--- |
| `WATER_BOTTOM` | `-0.040 m` | Depression bed for lakes, rivers, and canals |
| `GROUND` | `-0.015 m` | Base canvas plane beneath all mapped ground cover |
| `LANDUSE` | `-0.005 m` | Substrate reference plane |
| `WATER_SURFACE` | `+0.015 m` | Water surface level within carved ground cutouts |
| `GROUND_COVER_SURFACE` | `+0.025 m` | Uniform flush ground plane for parks, grass, land-use, and paved lots |
| `PARKING_SPACE_SURFACE`| `+0.028 m` | Mapped individual parking stall decal (+3 mm above host lot) |
| `PARKING_MARKINGS` | `+0.029 m` | Unioned painted stall stripes (+4 mm above host lot) |
| `PITCH_MARKINGS` | `+0.029 m` | Unioned white sports pitch lines (+4 mm above host pitch) |
| **`ROAD_SURFACE`** | **`+0.050 m`** | **Agreed baseline for all ordinary at-grade roads and paths** |
| `RAILWAY_BALLAST` | `+0.060 m` | Crushed stone railway ballast bed (+10 mm above road grade) |
| `RAILWAY_SLEEPERS` | `+0.072 m` | Perpendicular wooden/concrete cross-ties |
| `RAILWAY_RAILS` | `+0.085 m` | Twin steel rail extrusions |
| **`BRIDGE_ROAD_DECK`** | **`+2.850 m`** | Standard layer-1 bridge road deck (`ROAD_SURFACE + 2.8 m`) |
| **`TUNNEL_DEPTH`** | **`-2.000 m`** | Subterranean corridor floor for underground ways |

---

## 2. Road Ribbons & Boundary-Derived Junction Meshing

Roads are generated in `src/world/GeometryBuilder.ts` through a multi-stage procedural meshing pipeline:

```
[OSM Road Centerlines] 
       │
       ▼
1. Detect Topological Junctions (TopologicalNodeIndex)
       │
       ▼
2. Calculate Per-Road Trim Distances (Half-width of widest intersecting road / sin(θ))
       │
       ▼
3. Trim Incoming Road Polyline Ends (trimPolylineByArcLength)
       │
       ▼
4. Generate Trimmed Road Ribbons with Orthogonal Portals (generateRoadRibbon)
       │
       ▼
5. Collect Portal Boundary Edges & Synthesize Coplanar Junction Polygon
       │
       ▼
6. Apply Miter Clamping on Acute Turns (Limit = 2.0x width)
```

### Road Ribbon Construction (`generateRoadRibbon`)
- Takes a centerline polyline and road width.
- Computes tangent vectors between consecutive points and perpendicular normal vectors `(-tz, tx)` in the horizontal $XZ$ plane.
- Clamps miter lengths on sharp corners to prevent acute spikes (`miterScale <= 2.0`).
- Generates orthogonal end portals connecting left and right ribbon edges where roads meet junctions, preventing jagged diagonal seams.

### Boundary-Derived Junction Polygon Meshing
- Ordinary intersections are not formed by blindly stacking overlapping road ribbons.
- When $N \ge 2$ roads meet at a topological node, incoming road ribbons are trimmed back along their arc length based on the intersection envelope.
- The junction polygon is synthesized directly from the ordered boundary vertices of the connecting road portals.
- The resulting flat polygon sits exactly at `ROAD_SURFACE = 0.050 m` with zero gap and zero positive-area overlap.

---

## 3. 2D Path vs. Carriageway Boolean Clipping

When non-vehicular paths (`footway`, `cycleway`, `path`) cross or run alongside vehicular carriageways (`motorway`, `primary`, `secondary`, `residential`):
- The 2D outline of vehicular carriageways is subtracted from the path ribbon geometry using `polygonClipping.difference()`.
- If Boolean clipping fails on degenerate input, the system records a diagnostic error (`degenerate_path_clipping_failure`) and drops the overlapping segment rather than silently falling back to a duplicate coplanar surface.

---

## 4. Building Footprints, Holes & Extrusion

Buildings are synthesized in Stage 8 of `GeometryBuilder.ts`:
1. **Footprint & Hole Extraction**: Outer boundary rings and interior hole rings (e.g., open-air courtyards, lightwells) are extracted from GeoJSON Polygons/MultiPolygons.
2. **Region-Boundary Clipping**: Intersecting buildings are clipped against `[-clipRadius, +clipRadius]` using `clipPolygonRingsToBox()`.
3. **Vertical Prism Extrusion**:
   - The 2D shape with interior holes is converted to a Three.js `ShapeGeometry` via `THREE.ShapeUtils.triangulateShape`.
   - Vertical wall quads are extruded upwards from `y = 0.0 m` to `y = height`.
   - Roof caps are positioned at `y = height` with flat horizontal normals `(0, 1, 0)`.
4. **Height Resolution**:
   - Explicit `height` tag in meters.
   - Estimated from `building:levels` tag: $\text{height} = \text{levels} \times 3.2\text{ m}$.
   - Fallback: `defaultBuildingHeight = 12.0 m`.

---

## 5. Grade-Separated Bridges & Approach Ramps

Bridges are constructed via `src/world/BridgeAndTunnelBuilder.ts`:
- **Deck Elevation**: Elevated road decks sit at `ROAD_SURFACE + BRIDGE_BASE_CLEARANCE = 2.850 m` for layer 1 (`+1.4 m` per additional layer).
- **Approach Ramp Profiles (`buildBridgeProfile3D`)**:
  - Transition length: $\min(12.0\text{ m}, 30\% \text{ of span})$.
  - Central deck clearance: At least $40\%$ (`MIN_CENTRAL_DECK_FRACTION = 0.40`) of the bridge length remains flat at full clearance height over crossed roads or water bodies.
- **Short Bridge Handling**:
  - Bridges shorter than $5.0\text{ m}$ (`MIN_RAMPED_BRIDGE_SPAN_METERS`) use vertical abutment headwalls (`rampMode = 'abutment_headwall'`) at full `2.850 m` elevation to maintain underpass clearance.
  - Short bridges over water or roads are **never** reclassified as at-grade culverts based solely on length.
- **Substructure & Parapets**:
  - Vertical concrete pier pillars are generated under the deck at span intervals.
  - Protective parapets/guardrails rise `+0.85 m` along outer deck edges.

---

## 6. Subterranean Tunnels & 3D Portals

Tunnels descend below grade via `generateTunnelPortalAndTraceGeometries`:
- **Subterranean Depth**: Floor sits at `TUNNEL_DEPTH = -2.000 m` ($-1.0\text{ m}$ per negative layer).
- **3D Entrance Portals**: Horseshoe/trapezoidal masonry arch portals placed at the entrance and exit endpoints.
- **Recessed Dark Approach Ramps**: Sloped transition cutting from ground level into the portal opening.
- **Surface Traces**: Dashed, translucent surface indicator lines showing underground route continuity.

---

## 7. Railways

Railways are synthesized via the modular railway rendering subsystem (`src/world/infrastructure/railways/RailwayGeometryBuilder.ts`, `src/world/infrastructure/railways/RailwayTopology.ts`, `src/world/infrastructure/rendering/UvRibbonBuilder.ts`, and `src/world/infrastructure/rendering/InfrastructureShaderChunks.ts`) using the **Hybrid Close-Zoom 3D + Medium/Far Procedural UV-Ribbon Architecture** (`ADR-0008`):

- **Canonical Dimensions (`RAILWAY_DIMENSION_SPEC`)**:
  - Standard clear inner gauge: `1.435 m` (`0.20 m` visual rail width; `1.635 m` rail center-to-center spacing; `0.16 m` visual rail width for tramways).
  - Standard ballast width: `3.45 m` (`2.60 m` for tram/light-rail; `1.80 m` for miniature/narrow-gauge).
  - Standard sleeper dimensions: `2.55 m` width (`2.20 m` tram), `0.26 m` longitudinal thickness, `0.09 m` height, spaced at `0.725 m` close-zoom intervals (`1.45 m` procedural medium/far period).
- **Physical Vertical Stacking (`ElevationPolicy`)**:
  - **Ballast Bed (`Railway_Ballast`)**: Crushed-stone UV-ribbon bed at `RAILWAY_BASE = +0.060 m` (`renderOrder = 14`, `polygonOffset: -3.0`).
  - **Cross-Tie Sleepers (`Railway_Sleepers` / `Railway_Sleepers_3D`)**: Sleeper zone at `+0.072 m` (`+0.012 m` step above ballast, `renderOrder = 15`, `polygonOffset: -3.5`).
  - **Twin Steel Rails (`Railway_Rails` / `Railway_Rails_3D`)**: Steel rails at `+0.085 m` (`+0.025 m` above ballast, `renderOrder = 16`, `polygonOffset: -4.0`).

### Hybrid Zoom-Based LOD & Derivative-Filtered Shaders
1. **Close Zoom (`cameraZoom > 4.5 CSS px/m`)**:
   - Enables `Railway_Sleepers_3D` (`THREE.InstancedMesh` 3D sleeper/bearer boxes) and `Railway_Rails_3D` (3D extruded twin steel rail ribbons with `0.11 m` vertical profile height).
   - At genuine turnout toes (`hasSwitchAtStart` / `hasSwitchAtEnd`), inner diverging switch blades smoothly taper in width from `0.32` to `1.0` over `4.2 m` while colinear chained ways maintain full `1.0` rail width.
2. **Medium & Overview Zoom (`cameraZoom <= 4.5 CSS px/m`)**:
   - Switches visibility to `Railway_Sleepers` and `Railway_Rails` flat continuous UV-ribbons (`u = continuousArcLengthMeters`, `v = signedLateralOffsetMeters`).
   - `configureProceduralSleeperMaterial` and `configureProceduralRailMaterial` (`InfrastructureShaderChunks.ts`) apply screen-space `fwidth` analytic box-filtering and energy-conserving coverage attenuation (`1.0 / sqrt(coverageBoost)`) so converging tracks neither shimmer at sub-pixel zoom nor bloom in luminance at station throats.

### Topological Phase Propagation, Shared Turnout Bearers & Multi-Interval Clipping
1. **Mainline-First Ordering & Continuous Phase Chaining (`RailwayTopology.ts`)**:
   - `sortRailwaysMainlineFirst` prioritizes continuous through-tracks (`branchCount = 0`) ahead of single-ended turnouts (`branchCount = 1`) and crossovers (`branchCount = 2`).
   - `computeContinuousTrackPhases` propagates cumulative arc-length phase (`uOffsetMeters`) across colinear way joints so chained short OSM ways (`< 1.2 m`) receive uninterrupted sleeper placement.
2. **Two-Pass Sleeper Placement & Explicit Track Association (`supportedTrackIds`)**:
   - `HostTrackSpatialIndex` indexes track segments in an `8 m x 8 m` uniform spatial grid.
   - **Pass 1 (Mainlines & Shared Turnout Bearers)**: Along genuine turnout throats identified by `isTurnoutThroatPair` (shared topological switch node or minimum polyline approach `< 0.55 m` at shallow angle `cosAngle > 0.86`), sleepers elongate laterally (`[uMin, uMax]`, up to `4.90 m`) into shared timber turnout bearers supporting both tracks and recording both track indices in `supportedTrackIds`.
   - **Pass 2 (Branching & Parallel Tracks)**: Candidate sleepers check `existing.supportedTrackIds.has(trackIdx)` before treating an overlapping bearer as support for the current track. Closely spaced independent parallel tracks (`2.1 m–2.5 m` centerline separation) clamp their lateral extent symmetrically at the inter-track midpoint (`0.5 * centerDist - 0.02 m`) and clip remaining foreign overlaps via `subtractIntervalFromList`, preserving both left and right sleeper segments around diamond crossings with zero 2D OBB overlaps.
3. **Static Spatial Chunking (`128 m x 128 m`) & Adaptive Bridge Sampling**:
   - Railway sub-layers are partitioned into `128 m x 128 m` spatial chunk meshes inside their respective layer groups (`Railway_Ballast`, `Railway_Sleepers`, `Railway_Rails`, `Railway_Sleepers_3D`, `Railway_Rails_3D`) while exposing aggregated `faceRanges` and `instanceInfos` on the layer group for raycast inspection.

---

## 8. Geometry Validation & Z-Fighting Elimination

Z-fighting is audited programmatically by `src/world/ZFightingValidator.ts`:
- **Positive-Area Overlap Detection**: Triangle pairs sharing coplanar elevations are projected to 2D; overlapping intersections $> 0.05\text{ m²}$ are flagged as conflicts.
- **Same-Feature Self-Overlap Check**: Detects self-intersecting loops or overlapping quads within single road ribbons.
- **Junction Portal Continuity**: Compares the boundary edges of trimmed roads against the synthesized junction polygon boundary; gaps $> 0.02\text{ m}$ are flagged as defects.
- **Depth Bias (`polygonOffset`)**: Material depth offsets (`DEPTH_OFFSET_CONFIG`) provide secondary hardware depth buffer separation for intentional overlays (decals, markings) without substituting for geometric clipping.

---

## 9. Resource Lifecycle & GPU Memory Management

- **BufferGeometry Merging (`mergeGeometries`)**: Road ribbons and building walls of the same material are batched into single DrawCalls to maximize WebGL throughput.
- **Face Feature Range Tracking (`faceRanges`)**: Merged geometries maintain index ranges mapping face indices to `InspectableFeatureInfo` for raycasting.
- **Immediate Intermediate Disposal**: Temporary geometries created during intermediate clipping are tracked by `SceneResourceManager.registerIntermediateGeometry()` and immediately freed via `releaseIntermediateGeometry()`.
- **Idempotent Cleanup**: `BuiltSceneGeometry.dispose()` disposes all GPU buffers, index arrays, materials, and textures in a single pass and clears any retained `infrastructureRenderPreview` reference.

---

## 10. Graph-to-Renderer Adapter & Safe Preview Integration (`M2.3-E1` / `TKT-007`)

`src/world/infrastructure/rendering/InfrastructureRenderAdapter.ts` provides a pure-TypeScript translation layer between `InfrastructureGraph` (`ADR-0009`) and the 3D geometry pipeline:

1. **Independent Road & Railway Render Source Switches (`InfrastructureRenderOptions`)**:
   - `roads: 'legacy' | 'graph-preview' | 'graph'` and `railways: 'legacy' | 'graph-preview'` (both defaulting to `'legacy'`).
   - Selectable via URL query parameters `?topologyRoads=legacy|graph-preview|graph&topologyRailways=legacy|graph-preview` (`parseInfrastructureRenderOptionsFromSearch`). Invalid or absent values (including `?topologyRailways=graph` during Stage E2) resolve safely to `'legacy'`.
   - When both domains are `'legacy'`, zero graph construction and zero adapter work occur.
   - When either domain is `'graph-preview'` or `'graph'`, `prepareInfrastructureRenderPreview` builds one shared `InfrastructureGraph` and one `InfrastructureRenderDescriptorBundle` per dataset (memoized across camera frames, theme updates, hover events, and `railwayPrototypeMode` transitions).
2. **Domain Descriptor Handoff Contracts**:
   - **Road Descriptors (`RoadEdgeRenderDescriptor`, `RoadNodeRenderDescriptor` — consumed in Stage E2)**: Preserve canonical IDs, ordered metric polylines, `roadClass`, `tier` (`'vehicular' | 'path'`), `width`, `lanes`, `normalizedOneway`, `rawOnewayTag`, `surface`, `isCulvert`, boundary-clip flags, incident half-edge tangents, and explicit cross-tier contact flags (`isCrossTier`, `isCrossTierOnlyInteraction`, `requiresVehicularJunctionTrimming`, `requiresVehicularContinuityMiter`, `requiresPathJunctionTrimming`) so path contacts never trigger full-width vehicular carriageway junction trimming (`ADR-0002`, `ADR-0009` Resolution 3).
   - **Railway Descriptors (`RailwayEdgeRenderDescriptor`, `RailwayNodeRenderDescriptor`, `RailwayFlatCrossingRenderDescriptor` — for planned Stage E3)**: Preserve canonical IDs, polylines, `railwayType`, `gauge`, `electrified`, `service`, `usage`, `isSecondaryBranch`, confirmed vs. unresolved turnout topology (`turnoutStatus`, `turnoutTopology`), and flat diamond crossings with `allowsBranchInterchange: false`.
   - **Cross-Domain Descriptors (`LevelCrossingRenderDescriptor`, `GradeTransitionRenderDescriptor`, `GradeSeparatedCrossingRenderDescriptor`, `InfrastructureRenderUnresolvedDiagnostics` — for planned Stage E4)**: Preserve confirmed level crossings, grade-separated crossings, bridge/tunnel portal transitions (`atGradeToStructureDirection`, `continuousTraversalDot`), and unresolved diagnostics strictly separated from confirmed descriptors.
   - **Source Lineage**: Preserve `sourceFeatureId`, `sourceFeatureIds`, `deduplicatedFeatureIds`, `sourceFeatureToRoadEdgeIds`, `sourceFeatureToRailwayEdgeIds`, and `roadFeatureLineage` / `railwayFeatureLineage` (`chainingMap`, `deduplicatedMap`) for `InspectableFeatureInfo` and `faceRanges`.

---

## 11. Graph-Driven At-Grade Road & Junction Rendering (`M2.3-E2` / `TKT-008`)

When `infrastructureRenderOptions.roads === 'graph'`, Stage 6A–C of `GeometryBuilder.buildScene()` delegates at-grade road and junction meshing to `buildGraphAtGradeRoadGeometries` in `src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`:

1. **Authoritative Graph Topology Consumption**:
   - Consumes `InfrastructureRenderDescriptorBundle` (`roadNodes`, `roadEdges`, `gradeTransitions`, `roadFeatureLineage`) directly without invoking legacy `splitRoadsAtSharedInteriorNodes` or `TopologicalNodeIndex`.
   - Filters `edge.isAtGradeBuildable === true` (including `isCulvert === true`, which remains at `ROAD_SURFACE = 0.050 m`), while elevated bridges (`isBridge || layer > 0`) and subterranean tunnels (`isTunnel || layer < 0`) continue through Stage 6D.
2. **Localized Road-Footprint Junction Synthesis & Non-Pinching Continuity Joins**:
   - **Branching Vehicular Junctions (`requiresVehicularJunctionTrimming === true`, `vehicularHalfEdgeCount >= 3`)**: `solveBoundaryDerivedJunctionNode` constructs junctions around the actual road footprints rather than deforming or pinching incoming road widths:
     - Each incident road arm is cut at a localized `trimDist` (bounded by `localRadiusCap = Math.max(bBranch.width, maxBranchWidth) * 1.65` and the edge's available length budget, without clamping to the first polyline segment) using a **100% full-width strictly orthogonal portal** (`RoadEndPortal`), guaranteeing that roads never narrow as they approach a junction.
     - Unclamped arc-length stub polylines (`extractPolylineSpan`) and their full-width curved curb chains (`activeRightChain`, `activeLeftChain`) are extracted along `[0, trimDist]` for each arm and combined into a localized road-footprint contour (with `polygonClipping.union` fallback over the arm footprint strips and central core polygon) so unequal-width or acute intersections follow the true road curbs instead of stretching long triangular chord wedges across free space.
     - Candidate rings are validated by `validateAndTriangulateJunctionRing` for finite coordinates, `>= 3` unique vertices, zero fold-back spikes, zero ring self-intersections (`!hasRingSelfIntersection`), positive signed area `>= 0.05 m²`, positive portal widths on every arm, and upward-only (`+Y`) earcut triangles. Endpoint trim distances and portals are committed to `trimmedEndpoints` **transactionally** only after validation succeeds.
     - When a short or tightly curved approach arm has a clamped `trimDist` whose ribbon still overlaps the unioned junction footprint, 2D Boolean subtraction (`polygonClipping.difference`) trims the ribbon cleanly against `junctionMultiPoly` and synchronizes `portalConnections` via `resolveEffectivePortalOnJunctionBoundary` (`<= 0.02 m` seam continuity, zero positive-area coplanar overlap).
   - **Degree-2 Continuity Joins (`requiresVehicularContinuityMiter === true` and degree-2 path joins)**: Matching-width arms use a single bounded miter portal at `node.position` without first-segment width clamping. When the widths differ, the shared-miter approach is not used: nearly collinear two-arm joins instead bridge two full-width orthogonal cut portals with a bounded, triangulated local taper. Short or sharply bent approaches fall back to the localized full-width footprint union rather than averaging both widths into a pinched portal.
   - **Cross-Tier Contacts (`isCrossTierOnlyInteraction === true`)**: Through-roads contacted by footpaths keep continuous vehicular ribbons without vehicular junction trimming, while overlapping path/cycleway/steps footprints are subtracted against vehicular carriageways and junctions via 2D Boolean difference (`polygonClipping.difference`) using `buildGraphRibbonPolygonRing` (which includes semicircular start/end cap geometry when caps are active).
   - **Path-Tier Junctions & Steps**: Pure path intersections and cross-tier nodes with `>= 2` path half-edges may synthesize `path-junction-${node.id}` polygons at `ROAD_SURFACE` without creating vehicular junctions. These path patches are emitted after vehicular ribbons and clipped against their actual at-grade footprints before path ribbons are built. `highway=steps` edges emit both a base ramp (`0.050 m`) and upward-wound (`+Y`) treads (`+0.006 m`).
3. **Multi-Segment Provenance, Curve-Preserving Ribbon Sanitization & Authoritative Endpoint Cap Rules**:
   - Simplified multi-way edges (`provenanceSegments.length > 1`) are split at each constituent `startVertexIndex .. endVertexIndex` boundary using shared cross-section portals so each constituent OSM way receives its own `FaceFeatureRange` and `InspectableFeatureInfo` (`sourceFeatureId`, `osmTags`, `name`).
   - `sanitizeSubSegmentPolylineAndPortals` preserves interior curve vertices unless a vertex physically crosses behind the portal plane (`segLen0 <= portalOverhang + bendOverhang + 0.05`), ensuring curved roads retain their shape right up to junctions; `validateAndPruneHorizontalGeometry` verifies that every emitted horizontal road, path, step-tread, and junction triangle has strictly upward (`+Y`) geometric winding (`cross(v1 - v0, v2 - v0)`).
   - Semicircular dead-end caps are suppressed at grade transitions **only** when the graph edge or its topological node has an authoritative grade transition (`edge.startGradeTransitionId` / `edge.endGradeTransitionId`, `node.gradeTransitionIds.length > 0`) or connects to a non-at-grade road edge at that shared node — never via arbitrary coordinate proximity to unconnected bridges or tunnels.
4. **Geometric Triangle Winding & Normal Audit (`auditGraphRoadMeshIntegrity`)**:
   - `auditGraphRoadMeshIntegrity(roadsRoot)` reads actual indexed triangle positions, computes geometric face normals via `cross(v1 - v0, v2 - v0)`, verifies that every non-degenerate (`area > 1e-6 m²`) horizontal at-grade road, path, step-tread, and junction triangle faces upward (`geomNormal.y > 0.99`) and agrees with stored vertex normals (`dot > 0.99`), reports degenerate triangles separately, and attributes any defect to `meshName`, `faceIndex`, `featureId`, `sourceFeatureId`, and world-space `vertices`.

