# System Architecture

## 1. System Overview

The 3D Map Viewer is a client-side WebGL application built on **React 19**, **TypeScript**, **Three.js (r186)**, and **React Three Fiber (v9)** with **Tailwind CSS**. It ingests vector geographic data from OpenStreetMap (OSM) via local GeoJSON bundles or remote Overpass API queries, transforms spherical coordinates to a local Euclidean Cartesian space (meters), synthesizes procedural 3D meshes for roads, junctions, buildings, railways, waterways, and land use, and displays them via an orthographic isometric camera with interactive navigation.

### Core Architectural Goals
- **High Visual Stability**: Eliminates z-fighting at ordinary at-grade intersections and coplanar ground surfaces using 2D Boolean clipping, boundary-derived junction meshing, and deterministic depth bias (`polygonOffset`).
- **Physical Elevation Model**: Establishes a uniform at-grade road baseline (`+0.050 m`) and reserves true geometric elevation changes for real grade-separated structures (bridges rising to `+2.850 m`, tunnels descending to `-2.0 m`).
- **Strict Bounded Region Pipeline**: Enforces axis-aligned bounding box clipping across all geometry types so geometry never bleeds beyond the queried geographic bounds.
- **Deterministic GPU Resource Lifecycle**: Centralizes geometry registration and disposal via `SceneResourceManager` to prevent memory leaks during camera reframing, theme changes, and region reloads.

---

## 2. Major Components & Responsibilities

| Subsystem | Primary Modules | Responsibilities |
| :--- | :--- | :--- |
| **Data Ingestion & Providers** | `src/world/MapDataProvider.ts`<br>`src/world/LocalGeoJsonProvider.ts`<br>`src/world/OsmApiProvider.ts` | Ingests GeoJSON or Overpass OSM data, clips polylines and polygons to the region bounding box, extracts raw OSM node IDs, and parses features into typed collections with provenance diagnostics. |
| **Feature Classification** | `src/types/MapFeature.ts`<br>`src/world/FeatureCatalogue.ts` | Defines data structures for roads, buildings, railways, waterways, parks, and land-use. Resolves ambiguous OSM tags into concrete rendering categories. |
| **Coordinate Projection** | `src/world/WorldCoordinates.ts` | Converts WGS84 coordinates `[lon, lat]` into local metric Euclidean coordinates `[x, z]` centered around the dataset origin `(lon0, lat0)`. Provides haversine distance and inverse projection. |
| **Topological Indexing** | `src/world/TopologicalNodeIndex.ts` | Clusters road endpoints within a 15 cm tolerance or resolves explicit OSM node IDs. Enforces `layerScope` isolation so bridges and tunnels do not merge with at-grade roads. |
| **Procedural Geometry Generation** | `src/world/GeometryBuilder.ts`<br>`src/world/BridgeAndTunnelBuilder.ts`<br>`src/world/ElevationPolicy.ts`<br>`src/world/infrastructure/railways/RailwayGeometryBuilder.ts`<br>`src/world/infrastructure/railways/RailwayTopology.ts`<br>`src/world/infrastructure/rendering/UvRibbonBuilder.ts`<br>`src/world/infrastructure/rendering/InfrastructureShaderChunks.ts` | Synthesizes road ribbons, boundary-derived junction polygons with miter limits, extruded building prisms with courtyard holes, hybrid 3D/UV-ribbon railways with turnout bearer support, bridges with approach ramps, and 3D tunnel portals. |
| **Scene & Resource Management** | `src/world/SceneResourceManager.ts`<br>`src/scene/MapScene.tsx` | Manages Three.js scene graphs, materials, instanced meshes, and immediate disposal of intermediate BufferGeometries during generation. |
| **Camera & Viewport Controls** | `src/scene/CameraController.tsx` | Controls the Three.js OrthographicCamera, computes bounding-box framing for rotated views, clamps near/far planes, and manages pan/zoom/tilt interactions. |
| **Geometry Validation & Diagnostics** | `src/world/ZFightingValidator.ts`<br>`src/world/PlanarLayerValidator.ts` | Validates triangle coplanarity, positive-area road-vs-road overlaps, junction portal continuity, and non-self-intersection. |
| **Application UI** | `src/App.tsx`<br>`src/components/AddressSearchModal.tsx`<br>`src/styles/mapThemes.ts` | Provides theme selectors (Tactical, Blueprint, Minimal, Dark), dataset location pickers, feature inspection popovers, and diagnostic badges. |

---

## 3. Runtime Data Flow

The runtime pipeline flows monotonically from geographic data ingestion to WebGL rendering:

```mermaid
flowchart TD
    A[OSM XML / GeoJSON Data] --> B[Data Provider: LocalGeoJsonProvider / OsmApiProvider]
    B --> C[WorldCoordinates Projection: WGS84 to Local Meters]
    C --> D[Region Boundary Clipping: Liang-Barsky & Topology-Aware Polygon Clip]
    D --> E[Feature Classification & Diagnostic Accounting]
    E --> F[TopologicalNodeIndex: OSM Node IDs & 15cm Spatial Snapping]
    F --> G[GeometryBuilder: Multi-Stage Procedural Synthesis]
    
    subgraph Geometry Synthesis
        G1[Ground Cover & Water Cutouts]
        G2[Road Ribbons & Trimmed Junction Portals]
        G3[Boundary-Derived Junction Polygon Meshing]
        G4[Railway Ballast, Sleepers & Rails]
        G5[Bridge Ramps, Piers & Tunnel Portals]
        G6[Building Footprint Holes & Extrusions]
        G --> G1 & G2 & G3 & G4 & G5 & G6
    end

    G1 & G2 & G3 & G4 & G5 & G6 --> H[BuiltSceneGeometry & SceneResourceManager]
    H --> I[MapScene: R3F Canvas & Three.js Groups]
    I --> J[CameraController: Projected Bounds Framing & MapControls]
```

---

## 4. State & Resource Ownership

### Application State vs. Scene State
- **React State (`App.tsx`)**: Owns the active `mapData` (of type `ProcessedMapData`), active `themeId`, camera reset/frame signals, search modal visibility, and inspectable feature popup state.
- **Three.js Scene State (`MapScene.tsx` & `GeometryBuilder.ts`)**: Owns WebGL resources including `BufferGeometry`, `Material`, `Group`, and `Mesh` instances.
- **Geometry Lifecycle (`BuiltSceneGeometry`)**:
  - `buildScene()` compiles `ProcessedMapData` into grouped Three.js meshes.
  - All intermediate temporary geometries created during merging (e.g., individual road segment strips or individual building prisms) are tracked by `SceneResourceManager.registerIntermediateGeometry()` and immediately freed via `releaseIntermediateGeometry()`.
  - When a dataset is reloaded or the component unmounts, `BuiltSceneGeometry.dispose()` performs a single-pass disposal of all retained scene geometries and materials.

---

## 5. Architectural Boundaries

1. **UI vs. Renderer Boundary**: React components (`App.tsx`, `AddressSearchModal.tsx`) never directly manipulate Three.js buffer attributes or mesh vertex arrays. Communication happens through props passed into `MapScene` and standard event handlers (`onInspectFeature`).
2. **Provider vs. Geometry Boundary**: `MapDataProvider` outputs purely mathematical and semantic representations (`ProcessedMapData` containing metric coordinate arrays, metadata tags, and bounding boxes). Providers do not create Three.js objects or materials.
3. **Geometry vs. Camera Boundary**: `GeometryBuilder` constructs world-space meshes positioned relative to the dataset origin `(0, 0, 0)`. It exposes bounding boxes (`bounds`) to `CameraController.tsx`, which uses purely projective math to adjust orthographic zoom and target offsets.

---

## 6. Known Architectural Constraints

- **Client-Side Single-Threaded Processing**: All polygon clipping (`polygon-clipping`), triangulation (`THREE.ShapeUtils.triangulateShape`), and ribbon generation run synchronously on the main JavaScript thread. Large queries (> 5,000 features) must be budgeted carefully to avoid frame drops.
- **Bounded Local Coordinate Frame**: Projections use an equirectangular flat-Earth projection tangent to the dataset center `(originLon, originLat)`. Metric accuracy degrades as distance from the origin exceeds ~25 km; the viewer is optimized for urban neighborhood tiles up to ~5 km across.
- **Goalpost 2 Scope Boundary**: The active project scope is Goalpost 2: Infrastructure Topology, Railway Rendering, and Surface Markings. The architecture includes OSM-derived infrastructure connectivity and topology, including road and railway networks (with M2.2 complete and M2.3 planned, requiring explicit project-owner approval before implementation begins). While infrastructure topology models connectivity that may provide a foundation for future pathfinding, this does not authorize implementation of gameplay movement, game-agent AI, physics, entity collision, or dynamic traffic simulation. Speculative streaming architectures and unrelated gameplay systems remain strictly out of scope.

