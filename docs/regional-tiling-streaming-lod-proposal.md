# Architectural Proposal: Regional Tiling, Streaming, Offline Baking, and Orthographic LOD (`TKT-028`)

> **Status (`2026-11-20`)**: **Milestone M1a Implemented (Pending Owner Windows Verification & Review)**; Milestones **M1b–M4** Remain Proposed / Unapproved  
> **Tracking Ticket**: [`TKT-028`](../tickets/TKT-028-regional-tiling-streaming-lod.md) (`in_progress`)  
> **Prerequisites Closed**: [`TKT-026`](../tickets/TKT-026-promote-e2plus-rplus-retire-legacy-renderers.md) (E2+/R+ Sole Production Renderer), [`TKT-027`](../tickets/TKT-027-overijssel-snapshot-integrity.md) (Canonical Snapshot `overijssel-261114-8ae28196`)

---

## 1. Executive Summary & Architectural Goals

With **E2+/R+** promoted and verified as the sole production infrastructure renderer (`TKT-026`) and the immutable Geofabrik Overijssel snapshot locked under canonical integrity checks (`TKT-027`: `overijssel-261114-8ae28196`), the next step is enabling seamless, responsive exploration across **Twente** (~`45 × 35 km`, anchored around Hengelo–Enschede–Almelo–Oldenzaal) and ultimately **all of Overijssel** (`OVERIJSSEL_BBOX`: `lon 5.7768..7.0751` ≈ `88 km` E–W × `lat 52.1135..52.8554` ≈ `82.6 km` N–S, ~`3,420 km²`).

Current single-scene loading cannot scale directly to that footprint:
- Recorded `TKT-026` (`4 × 4 km` / `16 km²`, `96,836–98,087` features) runs require **`10,493.8–31,184.5 ms`** in synchronous `GeometryBuilder.buildScene()` (Run A/B), generate **`~2.65–2.67M` triangles**, and retain **`~187–201 MB`** of CPU geometry and BVH buffers for `16 km²` alone.
- Scaling that pipeline linearly into one scene for Twente or all of Overijssel (`> 200×` the area of S5) would block the main browser thread, exhaust browser V8/WebGL memory, break local flat-Earth metric assumptions (`WorldCoordinates.ts`), and introduce Float32 vertex precision jitter tens of kilometers from origin.

**Recommended Strategy (Baked-First Hybrid Architecture)**:
1. **Build the global `InfrastructureGraph` once offline** from the frozen canonical SQLite index (`overijssel-261114-8ae28196.sqlite`), preserving true cross-tile OSM road/railway/bridge/tunnel topology and provenance.
2. **Pre-bake tile-local Float32 geometry packs offline** across a quadtree (`512 m` LOD0 base up to `4,096 m` LOD3) using a **`64 m` synthesis collar + exact 2D tile-box clipping** for continuous surface layers (`E2+` roads, `R+` ballast, planar ground/landuse/water) and **deterministic centroid ownership** for discrete 3D structures (buildings, trees, furniture).
3. **Stream only viewport-relevant tiles at runtime** inside an orthographic zoom-driven LOD hierarchy using camera-relative **floating-origin placement**, a single shared **`ThemeMaterialRegistry`**, a target-tracking **texel-snapped directional shadow frustum**, and bounded **`SceneResourceManager` disposal** (`0` leaks).

> **Planning Note**: All tile dimensions, collar margins, camera zoom cutoffs, concurrency limits, and memory budgets in this document are **architectural proposals** pending Phase 1 proof-of-concept measurement. Existing non-Overijssel live Overpass queries and `DevToolsPanel` synthetic geometry overrides remain on the single-region runtime `GeometryBuilder` path.

---

## 2. Current System Constraints Driving the Design

Inspection of the current codebase identifies six concrete technical constraints that shape this proposal:

1. **Local Tangent Equirectangular Drift (`src/world/WorldCoordinates.ts`)**:
   - `WorldCoordinates` projects WGS84 around a per-dataset `(originLon, originLat)` using constant `cos(originLat)`. Across Overijssel's ~`82.6 km` N–S span (`52.1135°` to `52.8554°`), `cos(lat)` shifts from `0.6141` to `0.6038` (~`1.7%` horizontal scale drift). A province-wide tile grid must use a single conformal regional projection so tile borders stay orthogonal in meters everywhere.
2. **Float32 Sub-Centimeter Precision (`src/world/ElevationPolicy.ts`)**:
   - At-grade surface layering relies on `0.004 m` vertical separations (`ROAD_SURFACE = 0.050 m`, `RAILWAY_BALLAST = 0.060 m`, `RAILWAY_SLEEPERS = 0.072 m`) and `1.435 m` rail gauges. Vertices stored directly in WebGL `Float32` `30–60 km` from `(0, 0, 0)` lose `3–5 mm` precision, causing Z-fighting and rail gauge wobble.
3. **Orthographic Camera Scaling & `minZoom` Clamp (`src/scene/CameraController.tsx`)**:
   - Under `OrthographicCamera`, screen projection size depends exclusively on `camera.zoom` (`CSS px/m`), **not** Euclidean distance from target (`CameraController.tsx:108,201` currently clamps `minZoom = 0.15`, `maxZoom = 16.0`). Regional exploration requires lowering `minZoom` (proposed `~0.015–0.02`) and driving LOD switching strictly from `camera.zoom`.
4. **Hardcoded Directional Shadow Frustum (`src/scene/MapScene.tsx`)**:
   - `MapScene.tsx:834-837` fixes the directional shadow camera frustum to `[-1500, +1500]` around `(0, 0, 0)`. Moving across a `45–88 km` region leaves areas outside `±1.5 km` unshadowed unless the shadow frustum tracks the quantized camera target (or floating origin).
5. **Runtime Theme Switching & BVH Raycast Provenance (`GeometryBuilder.ts`, `SceneResourceManager.ts`, `MapScene.tsx`)**:
   - `GeometryBuilder.updateTheme()` mutates existing material colors and `RailwayGeometryBuilder.updateCameraZoom()` / `updateTheme()` update shader uniforms **in place without rebuilding `BufferGeometry`**.
   - `resolveInspectedFeature()` (`MapScene.tsx:751`) relies on per-mesh `userData.faceRanges`, `instanceInfos`, and `MeshBVH` (`{ indirect: true }`). Both theme swapping and feature inspection must remain lossless on streamed tiles.
6. **Whole-Feature Topology Dependencies (`RoadNetworkBuilder`, `BridgeAndTunnelBuilder`, `SurfaceFirstRoadFootprints`)**:
   - `E2+` end-cap suppression, priority-ordered Boolean subtraction, `R+` ballast union, continuous `computeContinuousTrackPhases`, and `35–60 m` bridge/tunnel ramp interpolation break visually if geometry is partitioned naively by bounding box prior to topology and surface synthesis.

---

## 3. Architecture Options Comparison

| Dimension | Option A: Runtime Query & Build per Tile | Option B: Fully Static Pre-Baked Meshes | Option C: **Baked-First Hybrid (Recommended)** |
|---|---|---|---|
| **What happens offline** | Nothing beyond current `TKT-027` OSM SQLite index | Everything including fixed colors/materials/baked shader states | Build global `InfrastructureGraph` + pre-bake tile-local `BufferGeometry`, `groups` (by `materialSlotKey`), `faceRanges`, `instanceInfos`, and optional `MeshBVH` |
| **Runtime tile load work** | GeoJSON reconstruction + `buildInfrastructureGraph` + `E2+`/`R+` clipping + triangulation + BVH | Buffer upload only | HTTP/IndexedDB binary fetch → Worker decode → register material slots from `ThemeMaterialRegistry` → scene attach |
| **Pan / zoom main-thread risk** | **High** — dense `512 m` urban tiles still run `polygon-clipping`, triangulation, and BVH build dynamically on pan | **Very Low** — minimal CPU decode | **Very Low** — bounded worker decode + `<= 2` GPU commits/frame; zero `polygon-clipping` or triangulation on main thread |
| **4-Theme Switching (`tactical`, `daylight`, `dusk`, `blueprint`)** | Preserved | **Broken / Expensive** — either freezes one theme into vertex colors or duplicates `4×` tile packs | **Preserved cleanly** — single central `ThemeMaterialRegistry` mutates shared materials in $O(1)$ without re-baking or duplicating geometry |
| **OSM Hover / Click Inspection & Provenance** | Preserved | Hard unless sidecars retained | **Preserved cleanly** — serialized compact `faceRanges` + string-interned OSM tags + LOD0 `MeshBVH` |
| **Graph Continuity Across Borders** | Fragile if queried per tile (`clippedAtStart`/`End` artifacts) | Preserved if built from global graph | **Guaranteed** — derived from one global Overijssel `InfrastructureGraph` + `64 m` collar |
| **Disk / Offline Bake Cost** | Minimal extra disk | High if multiplied per theme | Moderate — one theme-agnostic binary tile pack (`SQLite` + compressed blobs) |
| **Live Overpass Outside Overijssel** | Same path | Incompatible | Existing live `GeometryBuilder` retained unchanged for non-Overijssel regions and synthetic `DevToolsPanel` tweaks |

**Decision**: **Option C (Baked-First Hybrid)** aligns directly with the frozen snapshot policy (`TKT-027`), maximizes pan/zoom smoothness, keeps all four themes zero-cost at runtime, preserves `resolveInspectedFeature` + `E2+`/`R+` fidelity, and avoids touching non-Overijssel live Overpass mode.

---

## 4. Recommended System Architecture (8 Core Design Areas)

### 4.1 Spatial Partitioning & Regional Coordinate System

1. **Canonical Regional Conformal Projection (`RegionalProjection` — Implemented in M1a)**:
   - Standardized for tiled Overijssel assets on **ETRS89 / UTM Zone 32N (`EPSG:25832`)** using 4th-order Krüger/Karney ellipsoidal Transverse Mercator series (`src/world/tiling/RegionalProjection.ts`, `< 1e-6 m` forward/inverse round-trip precision).
   - Axes match Three.js conventions (`+X` East, `+Y` Up, `+Z` South so North is `-Z`) shifted to a deterministic Float64 study/grid origin while keeping `WorldCoordinates.ts` untouched for standalone live Overpass datasets.
   - *Rationale*: `EPSG:25832` provides standardized European conformal metric coordinates across the entire `88 × 83 km` province without external datum grid downloads (`RDTRANS`), avoiding the `~1.7%` N–S horizontal scale drift of single-origin tangent equirectangular math.

2. **Quadtree Grid & Proposed Initial Tile Sizes**:
   - Anchor the grid in integer `tileSizeMeters` (`512 m` at LOD0) cells in `EPSG:25832` easting/northing (`tx = floor(E / 512)`, `ty = floor(N / 512)`), using deterministic half-open ownership `[minX, maxX) × [minZ, maxZ)` on internal boundaries (`TileGrid.ts`).
   - **Proposed Quadtree Levels**:

| LOD Tier | Tile Edge Length | Tile Area | Tiles Covering `8 × 8` Hengelo (`4,096 m`) | Proposed Use |
|---|---:|---:|---:|---|
| **LOD0** | `512 m × 512 m` | `0.262 km²` | `64` tiles (`8 × 8`) | Street-level & neighborhood exploration; full E2+/R+ + BVH |
| **LOD1** | `1,024 m × 1,024 m` | `1.049 km²` | `16` tiles (`4 × 4`) | District view; simplified bends, UV-ribbon rail, no micro-furniture |
| **LOD2** | `2,048 m × 2,048 m` | `4.194 km²` | `4` tiles (`2 × 2`) | City / corridor view; arterial+residential roads, merged massing |
| **LOD3** | `4,096 m × 4,096 m` | `16.777 km²` | `1` tile | Twente & Overijssel regional overview; highways, rail trunks, urban blocks |

   - *Note on Study Footprint*: An aligned `8 × 8` `512 m` LOD0 grid covers **`4,096 m × 4,096 m` (`16.78 km²`)**, which is intentionally distinct in both projection (`EPSG:25832`) and extent from the historical `TKT-026` S5 (`4,000 m × 4,000 m` tangent-equirectangular) benchmark footprint.

3. **Synthesis Collar Margin (`H = 64 m` Hypothesis — Audited in M1a)**:
   - The `64 m` collar hypothesis was explicitly audited in M1a (`CollarAudit.ts`) rather than assumed unconditionally sufficient. While `64 m` comfortably covers road stroke widths (`~24–32 m`) and adjacent parallel ballast envelopes, `CollarAudit` proves that **raw `64 m` spatial bbox slicing alone is NOT sufficient without global/precomputed context** for:
     1. large planar `landuse`/`parks`/`waterBodies` polygons (deduplication, Boolean priority subtraction, and tunnel portal cutouts) and `> 64 m` buildings straddling tile borders;
     2. `> 64 m` grade-separated bridge/tunnel approach ramp components;
     3. global railway continuous sleeper/rail UV phase propagation (`computeContinuousTrackPhases` across connected track components) and at-grade track segment densification near chamfered host tracks; and
     4. `GeometryBuilder`'s `MAX_SCENE_TREES = 2200` global cap (`SceneTreeBudgetAudit`).
   - `CollarAudit` explicitly separates cases into `resolved_by_global_context` (resolved deterministically via precomputed global topology, grade-separated plans, at-grade road plans, barrier resolutions, track phases/densification, and `planarResolution`) versus `tile_local_collar` dependencies, sanitizing unbounded portal distances (`finiteOrZero`) so audit JSON remains strictly finite.
   - Consequently, M1a resolves cross-border continuity by pairing **precomputed batch/region unclipped 3D geometry plans + exact 3D tile triangle clipping (`clipBufferGeometryToBoxXZ`)** with deterministic half-open centroid ownership (`TiledStudyPipeline.ts`), verified cleanly via `TiledDiagnostics.runDiagnosticAbcComparison` (`--diagnose-abc`) — directly informing M1b offline baker architecture (see §4.5.1 below).

---

### 4.2 Offline Preprocessing, Baking & Storage Layout

```text
overijssel-261114.osm.pbf (SHA-256 8ae28196...)
        │
        ▼ (TKT-027 verified store)
overijssel-261114-8ae28196.sqlite
        │
        ├──► Stage A (Global Topology Pass — pure Node.js)
        │      • Extract road/rail/point ways & nodes into RegionalProjection Float64
        │      • Build global InfrastructureGraph (Road + Railway + CrossModal + Bridges/Tunnels)
        │      • Persist overijssel-graph-261114-8ae28196.sqlite
        │
        └──► Stage B (Multi-LOD Tile Baker — worker pool / Node.js)
               • Process in bounded regional synthesis batches (e.g. 4×4 = 2,048 m macro-blocks + collar):
                   1. Fetch batch + collar descriptors & features from global InfrastructureGraph
                   2. Run E2+ / R+ / Planar / Building / Foliage / Bridge synthesis once per batch
                   3. Clip continuous 3D surface meshes per 512 m tile via clipBufferGeometryToBoxXZ
                   4. Assign discrete 3D buildings, trees, landmarks & street furniture by half-open centroid
                   5. Convert vertex XY/Z to tile-local Float32 (center = 0,0,0)
                   6. Pack canonical materialSlotKey groups + faceRanges + interned tags (+ LOD0 BVH)
                   7. Compress (zstd / brotli / gzip) & write blob
               • Persist overijssel-tiles-261114-8ae28196.sqlite
```

- **Storage Format (`overijssel-tiles-261114-8ae28196.sqlite`)**:
  - Single-file SQLite (`node:sqlite` `DatabaseSync`, zero C++ native deps matching `TKT-022`/`TKT-027` Windows-friendly design):
    - `metadata`: `snapshot_id`, `source_sha256`, `projection_id`, `bake_schema_version`, `lod_policy_hash`, `grid_origin_x`, `grid_origin_z`, `base_tile_meters`, `created_at`.
    - `tile_manifest` (`lod`, `tx`, `ty`, `content_hash`, `byte_length`, `tri_count`, `feature_count`, `min_y`, `max_y`, `pad_x`, `pad_z`, `is_empty`). Empty rural cells record `is_empty = 1` or sparse presence bitmap so the client never requests waterless empty voids.
    - `tiles` (`lod`, `tx`, `ty`, `payload_blob` compressed binary).
- **Binary Tile Payload (`OSMTILE1`, Proposed Structure)**:
  - Fixed little-endian header: magic (`OSMTILE1`), schema version, `(lod, tx, ty)`, tile center `[cx, cz]` in Float64, padded 3D AABB `[minX, minY, minZ, maxX, maxY, maxZ]`.
  - Section 1 (`TagTable`): Deduplicated UTF-8 string pool + `featureEntries[]` (`osmType`, `osmId`, `featureKind`, compact tag slice) so repeated properties (`building=yes`, `highway=residential`) store once per tile.
  - Section 2 (`Meshes`): Each layer bucket (`Ground`, `Landuse`, `Parks`, `Water`, `Roads`, `Railways_Ballast`, `Railways_UvRibbon`, `Railways_Rails`, `Buildings`, `Bridges`, `Tunnels`) stores:
    - Typed Float32 `position`, `normal` (optional packed `Int8`), `uv` (where used by railway/ribbon shaders), `Uint32` `index`
    - `groups[]`: `{ start, count, materialSlotKeyIndex }` (referencing canonical `ThemeMaterialRegistry` keys, e.g. `roads:primary`, `buildings:roof:residential`, `railway:ballast`)
    - `faceRanges[]`: `{ startFace, endFace, featureIdx }` (for sub-millisecond hover lookup)
    - Optional serialized `MeshBVH` (`MeshBVH.serialize` / static bounds tree buffer) for LOD0 meshes to avoid client-side BVH build spikes.
  - Section 3 (`InstancedMeshes`): Precomputed per-tile instance matrices (tile-local Float32 `Matrix4`, e.g., LOD0 sleepers, trees, lamps) + `instanceInfos[]` (`featureIdx`) + prototype geometry key.

---

### 4.3 Incremental Loading, Streaming & Eviction Lifecycle

```text
Camera Pose Change (target, zoom, azimuth, tilt, viewport W×H)
   │
   ▼
1. Compute desiredLOD = selectLodForZoom(camera.zoom)
2. Project viewport corners onto ground plane (y ∈ [-4, 65]) -> ground AABB
3. Enumerate intersecting fetchSet (tiles in ground AABB + 1-tile prefetch ring)
   and keepSet (fetchSet + 1-tile hysteresis margin)
   │
   ├──► Evict cached GPU tiles ∉ keepSet (subject to min residency cooldown & active fallback rule)
   ├──► Abort in-flight HTTP fetches ∉ fetchSet via AbortController
   └──► Score missing tiles ∈ fetchSet:
           priority = centerDistanceMeters + panVelocityBias + lodGapPenalty
```

1. **Priority Queue & Non-Blocking Decode**:
   - Up to `4` concurrent fetches (configurable) sorted by screen-center proximity and pan-direction lead.
   - Coarser fallback priority: if a user zooms quickly into an uncached area, request covering `LOD2`/`LOD3` tile before or alongside `LOD0` cells so no blank skybox/ground void appears while high-detail tiles finish decoding.
   - Decompression + `OSMTILE1` parsing + typed-array construction + `MeshBVH.deserialize` execute inside a **Web Worker pool** (`1–2` workers using transferable `ArrayBuffer`s) so the main render loop never parses blobs synchronously.
2. **Bounded GPU Commit Budget**:
   - Main thread consumes ready decoded tile payloads from a commit queue with a **frame budget (proposed: `<= 2` tile uploads or `<= 4 ms` upload work per RAF tick)** so rapid panning stays visually fluid (`CameraController` / `MapControls` uninterrupted).
3. **Zero-Hole Quadtree Replacement Rule (Parent/Child Atomic Swap)**:
   - A loaded coarse `LOD(k)` tile stays visible until **all 4** covering `LOD(k-1)` child tiles (within the viewport) are decoded and committed (or marked empty), then swaps visibility atomically on the same frame — preventing seam flickering or transient holes during zoom transitions.
4. **Hysteresis & Thrashing Prevention**:
   - Unload radius strictly exceeds fetch radius (`keepMargin = fetchMargin + 1 tile`), plus a short `~3 s` LRU cooldown before disposing recently exited neighbor tiles.

---

### 4.4 Orthographic Zoom-Driven LOD Strategy

Because `MapScene` renders via `THREE.OrthographicCamera`, an object's pixel footprint equals **`worldSizeMeters × camera.zoom` (`CSS px/m`)** regardless of camera distance. Distance-based 3D perspective LOD (`Vector3.distanceTo(camera.position)`) is invalid here and would degrade zoom consistency.

1. **Camera Controller Updates Needed (Implementation Phase)**:
   - Lower `CameraController.tsx` `minZoom` (`currently 0.15` at lines `108` and `201`) to a proposed **`0.015–0.02 CSS px/m`**:
     - At `1280 × 720` viewport and isometric `45°`/`55.4°` projection, `zoom = 0.02` frames **`~50–65 km`**, spanning all of Twente (`Hengelo`–`Enschede`–`Almelo`–`Oldenzaal`) or most of Overijssel interactively.
   - `computeSceneFrustumPlanes` dynamically tracks the active visible ground envelope around the floating-origin target so near/far planes never clip tilted regional mountains/buildings or waste 24-bit depth precision.

2. **Proposed LOD Tier Specification by Feature Domain (`camera.zoom` Thresholds)**:

| Feature Domain | **LOD0** (`zoom >= 1.0`, `512 m`) | **LOD1** (`0.35 <= zoom < 1.0`, `1,024 m`) | **LOD2** (`0.12 <= zoom < 0.35`, `2,048 m`) | **LOD3** (`zoom < 0.12`, `4,096 m`) |
|---|---|---|---|---|
| **Roads (`E2+`)** | All 11 road classes + paths; 16-seg rounded bends; full priority subtraction | Drop minor unnamed `footway`/`steps`/`path` (`< 1.2 m`); 6-seg bends | `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `residential` corridors; simplified 1.5 m polyline tolerance | Regional highways only (`motorway`, `trunk`, `primary`, `secondary`); bold cartographic stroke |
| **Railways (`R+`)** | Full R+ ballast union + switches; R+ shader (`> 4.5 px/m` 3D instanced sleepers/rails, `<= 4.5 px/m` UV-ribbon) | R+ ballast union + shader UV-ribbon only (zero 3D sleeper/rail geometry uploaded) | Merged mainline/yard track ribbons (`1` unified ballast band per corridor) | Major rail trunk lines only (single-stroke corridor) |
| **Bridges & Tunnels** | Full Stage 6D ramps, piers, parapets, portals, subterranean tunnels | Ramps, decks & portal openings (omit small piers/parapet thickness) | Simplified elevated deck bands for major bridges; omit underground meshes | Highway/rail bridge deck highlights only |
| **Buildings** | Full extruded prisms, courtyard holes, bevels, canopies; `<= 2` groups/bucket; `castShadow` | Full extrusions; omit subtle roof bevels & tiny courtyards `< 4 m²`; `castShadow` | Exterior block massing (Douglas-Peucker `~2 m`, merged silhouettes, `castShadow = false`) | Aggregated urban block/landuse mass or simplified large footprints (`>= 200 m²`), `castShadow = false` |
| **Ground, Water, Parks, Landuse** | Full planar polygons with cutouts (`PlanarLayerValidator`) | Simplified boundary tolerance `~0.5 m` | Simplified `~2–4 m`; drop tiny micro-patches (`< 25 m²`) | Major rivers/canals, lakes, forests & built-up landuse blocks (`~8 m` tol) |
| **Foliage & Street Furniture** | Trees (`InstancedMesh`), benches, lamps, bollards, barriers | Trees (thinned / merged crown clusters); omit street furniture | Aggregate forest cover polygons only | Forest cover polygons only |
| **Hover Inspection (`MeshBVH`)** | Prebuilt/deserialized `MeshBVH` + `faceRanges` active | Optional lazy BVH or coarse road/building hit | Optional coarse hit / disabled at macro zoom | Disabled (saves BVH RAM) |

   - *Coexistence with Existing R+ Shader*: `RailwayGeometryBuilder.ts`'s `> 4.5 CSS px/m` procedural-vs-3D crossfade shader already lives cleanly inside LOD0 (`zoom >= 1.0`), so close-up 3D sleepers & rails fade seamlessly into UV-ribbons without adding an extra tile boundary threshold.

---

### 4.5 Seamless Tile Boundaries (Zero Gaps, Overlaps, or Seam Artifacts)

Naive spatial bounding-box querying followed by per-tile `GeometryBuilder` introduces six fatal visual defects at tile borders:
1. **Fake rounded end-caps** on cut roads (`SurfaceFirstRoadFootprints.ts` applies `capStart`/`capEnd` at clipped road endpoints).
2. **Asymmetric priority clipping** when a higher-priority `primary` road runs `4 m` outside Tile A while its `12 m` stroke penetrates Tile A's border.
3. **Broken bridge/tunnel ramps** when a `35–60 m` approach ramp (`BridgeAndTunnelBuilder`) straddles a tile border and misses its opposite abutment or portal node.
4. **Fake cut exterior building walls** when a `Polygon` building is split along a tile edge before `ExtrudeGeometry`.
5. **Rail sleeper phase & turnout bearer discontinuities** when sleeper spacing resets to `s = 0` at every tile border.
6. **Seam cracks, area drift, or partial rejection** when adjacent ground/landuse/road polygons clip in 2D prior to Earcut triangulation and `validateAndPruneHorizontalGeometry`.

**Deterministic Boundary Guarantees by Geometry Class**:

| Geometry Class | Boundary Ownership Rule | Why Seam Artifacts Cannot Occur |
|---|---|---|
| **At-grade Surfaces (`E2+` Roads, `R+` Ballast, Ground, Landuse, Parks, Water)** | **Pre-Triangulated Surface Synthesis + Exact 3D Tile-Box Triangle Clip (`clipBufferGeometryToBoxXZ`)**: Synthesize Boolean surface polygons (`visible` road footprints, resolved `landuse`/`parks`/`waterBodies` polygons) and run `THREE.ShapeGeometry` + `validateAndPruneHorizontalGeometry` **before** tile-box clipping, then clip the validated 3D triangle mesh against exact `[tileMinX, tileMaxX] × [tileMinZ, tileMaxZ]` via Sutherland-Hodgman `clipBufferGeometryToBoxXZ`. | Sutherland-Hodgman 3D triangle clipping against half-open/adjacent tile boxes forms a mathematical partition of unity in `Float32` (`0.0000 m²` area drift across 64 tiles) and prevents asymmetric per-tile Earcut rejection when one tile's 2D-clipped piece contains a degenerate micro-triangle while the neighboring tile's piece succeeds. |
| **Discrete 3D Extruded / Point Objects (Buildings, Trees, Barriers, Point Landmarks, Street Furniture)** | **Deterministic Half-Open Centroid Ownership**: Assign each building (`getRingsBBoxCentroid(b.footprint)`), tree, point landmark (`PointLandmarks_3D`), and street furniture item (`StreetFurniture_*`) uniquely to `pointInHalfOpenBox(position, tile.localBounds)`. Bake full unclipped 3D geometry inside its owning tile and inflate the tile's culling AABB by its max protrusion (`pad_x`, `pad_z`). | Zero interior cut facade walls on cross-border buildings or cooling towers/shelters, zero duplicate faces rendered twice across neighbors, and exact 1:1 triangle/provenance conservation between partitioned reference (`B`) and tiled build (`C`). |
| **Continuous 3D Bridges, Tunnels & Rail Sleepers/Rails** | **Global Arc-Length Parameterization & Precomputed Densification**: Compute `totalLength`, bridge elevation curve `y(s)`, ramp zones, `computeContinuousTrackPhases`, and at-grade track densification (`computeRailwayDensifiedPointsMap`) once on the **global** `InfrastructureGraph`; slice extruded decks/rails cleanly at `x = tileEdge` or `z = tileEdge` via `clipBufferGeometryToBoxXZ` (preserving linearly interpolated UV `v` phase) and assign each sleeper/pier/bearer by midpoint centroid. | Adjacent bridge decks, rails, and UV ribbons meet at identical elevation `y(s_edge)` and identical interpolated UV phase (`0.000000` seam delta); sleepers maintain continuous uniform spacing across tile seams without doubling or jumping. |

#### 4.5.1 M1a Empirical Findings: Bounded Regional Batch Synthesis + 3D Tile Clipping vs. Independent 512 m 2D Synthesis

During canonical `8 × 8` Hengelo (`4,096 × 4,096 m`, `102,469` features) verification with `--diagnose-abc` (`A` = single-scene reference, `B` = reference partitioned directly into 64 tiles, `C` = tiled build), three fundamental lessons emerged that directly govern M1b/M2 offline baking:

1. **Why 2D Per-Tile Polygon Clipping Before Earcut Fails Conservation (`A ↔ C`)**:
   - *Asymmetric Earcut validation on at-grade roads (`11` unmatched road seam edges, `5` road area differences, `4` extra `sourceFeatureIds`)*: When a road polygon's `visible` MultiPolygon was clipped in 2D per tile via `clipMultiPolygonToBox2D` before `ShapeGeometry` + `validateAndPruneHorizontalGeometry`, a complex road polygon containing a near-collinear vertex in Tile 1 failed `validateAndPruneHorizontalGeometry` as a whole in `A` and in Tile 1 of `C`, but its clipped sub-polygon in Tile 2 of `C` had no degenerate triangle and succeeded — creating an extra `sourceFeatureId`, extra road area in `C`, and an unmatched road boundary edge along the Tile 1/Tile 2 seam.
   - *2D MultiPolygon clipping + independent Earcut triangulation on large unioned planar surfaces (`-173,656.857 m²` Residential Landuse, `-1,572.120 m²` Forest)*: First, `resolveAndValidatePlanarPolygons` merges touching same-kind unnamed polygons (`mergeTouchingSameKindUnnamedPolygons`) into the first item's ID; slicing tile inputs only by the pre-union `item.polygon` bbox dropped canonical unioned polygons from tiles where only deduplicated partner polygons overlapped the collar. Second, even with unioned bbox filtering, clipping complex MultiPolygons in 2D into 64 tiles and running `ShapeGeometry` (`earcut`) independently per tile does not form an exact `Float32` partition of unity. Triangulating each resolved planar polygon and at-grade road polygon once into an unclipped `ShapeGeometry` and clipping its 3D triangles per tile via `clipBufferGeometryToBoxXZ` guarantees exact area, seam-edge, and provenance parity (`0` defects).
2. **Why `mergeWithFaceRanges` Must Clear Partial Child Material Groups (`A → B`)**:
   - `THREE.ShapeGeometry` populates `geom.groups = [{ start: 0, count: N, materialIndex: 0 }]`, whereas ribbon/extrusion builders (`LinearWaterway`, bridge decks, road steps) leave `geom.groups = []`, and `validateAndPruneHorizontalGeometry` rewrites `geo.index` without updating `geo.groups[0].count`. When `mergeBufferGeometries` concatenated mixed items into a single-material mesh (`WaterSurfaces`, `Roads_*`), `merged.groups` covered only the subset of triangles originating from `ShapeGeometry`, causing `clipBufferGeometryToBoxXZ` to drop `-132,163.164 m²` of `LinearWaterway` triangles and `7` road class subsets. Calling `merged.clearGroups()` on all single-material merged meshes (and requiring `coveredTris >= totalTriCount` before `clipBufferGeometryToBoxXZ` uses explicit multi-material groups) restores 100% triangle conservation.
3. **Architectural Recommendation for M1b/M2 Offline Baking**:
   - **Do not** run independent 512 m 2D polygon synthesis at runtime or per isolated 512 m tile in the offline baker.
   - Instead, the **M1b offline baker** should synthesize continuous surface layers (`E2+` roads, `R+` railways, planar `landuse`/`parks`/`waterBodies`, barriers) over **bounded regional synthesis macro-blocks** (e.g., `4 × 4` = `2,048 × 2,048 m` or `8 × 8` = `4,096 × 4,096 m` study blocks with an outer collar, matching `ingestCanonicalStudyGeoJson`'s `precomputedGlobalPlans`), triangulate and validate each surface polygon once, and **partition into `512 m` LOD0 tiles via 3D `clipBufferGeometryToBoxXZ` and half-open centroid ownership**.
   - This architecture keeps peak Node.js baker memory strictly bounded (`~4–16 km²` per macro-block rather than `3,420 km²` for all of Overijssel at once) while guaranteeing mathematically exact 3D triangle conservation (`A = B = C`) across every `512 m` tile seam.

---

### 4.6 Global Graph Topology & OSM Feature Identity Across Tiles

1. **Global Overijssel Topology Build (`overijssel-graph-261114-8ae28196.sqlite`)**:
   - `RoadNetworkBuilder`, `RailwayNetworkBuilder`, `CrossModalAnalyzer`, and `buildInfrastructureGraph` (`src/world/infrastructure/topology/`) already have zero React, Three.js, or DOM dependencies and operate deterministically using explicit OSM node IDs (`_nodeIds`).
   - Build the topology graph globally (or in overlapping geographic strips merged deterministically on canonical OSM `node/<id>` + topological coordinate keys if peak Node RAM needs bounding) from `overijssel-261114-8ae28196.sqlite`.
   - Crucially, ways passing between neighborhoods **never** receive synthetic `boundary_clipped_continuation` splits; cross-tile junctions, degree-2 chains, roundabout rings, level crossings, railway turnouts, and grade transitions resolve once across real OSM connectivity.
2. **Feature Inspection & Provenance Continuity**:
   - Every `faceRanges` entry and `instanceInfos` record in a baked tile points to its local `TagTable` entry (`osmType`, `osmId`, `tags`). Hovering or clicking on two adjacent tiles along the same motorway or canal resolves cleanly to the same `way/<id>` and full OSM tag payload.
   - `DevToolsPanel` synthetic multiplier sliders and non-Overijssel live Overpass queries continue routing through the existing runtime `LocalGeoJsonProvider` -> `buildInfrastructureGraph` -> `GeometryBuilder` pipeline untouched.

---

### 4.7 Memory, Disposal, Shadows & Large-World Precision

1. **Camera-Relative Floating-Origin Rendering**:
   - Vertex positions inside every tile are baked as **tile-local `Float32`** offsets relative to `[tileCenterX, 0, tileCenterZ]` (bounded to `±256 m` at LOD0, preserving `< 0.1 mm` precision everywhere across Overijssel).
   - At runtime, maintain the active camera target `[targetWorldX, 0, targetWorldZ]` in **Float64** world meters (snapped/re-anchored whenever the target drifts `> 2,048 m` from the current floating origin, or updated directly per camera target anchor):
     ```text
     tileGroup.position.set(
       tileCenterX - renderOriginX,
       0,
       tileCenterZ - renderOriginZ
     )
     ```
   - Keeps WebGL view-model transforms near `(0, 0, 0)` in Float32, eliminating camera jitter and Z-fighting even `60 km` away from Hengelo while UI coordinates display true WGS84 `(lat, lon)` via inverse `RegionalProjection`.

2. **Central Shared `ThemeMaterialRegistry`**:
   - Current `GeometryBuilder` creates distinct `MeshStandardMaterial` / shader instances per scene. Under tiling, **64 active tiles** must **not** own `64×` duplicate materials.
   - All streamed tiles reference shared materials owned by a single `ThemeMaterialRegistry` (grouped by canonical `materialSlotKey`, e.g. `roads:primary`, `buildings:roof`, `buildings:wall`, `railway:ballast`, `railway:uv-ribbon`). Switching themes (`tactical` ↔ `blueprint`) or `uCameraZoom` updates ~35 shared materials in `< 0.2 ms` across all loaded tiles simultaneously.

3. **Target-Following Texel-Snapped Directional Shadow Frustum**:
   - Replace the static `[-1500, +1500]` world-origin shadow bounds in `MapScene.tsx:834-837` with a dynamic shadow frustum centered on the camera's active look-at target (relative to floating origin), sized proportionally to closeup zoom (`e.g. ±400 m` to `±1,000 m`), quantized to `(2 * halfSpan) / shadowMapResolution` world-space shadow-texel increments to prevent shadow-edge swimming during panning.
   - Set `castShadow = false` on `LOD2`/`LOD3` overview tiles (where sub-pixel shadow maps add draw cost with zero visual gain).

4. **Strict Scoped Disposal & Active Memory Budgets**:
   - Track every active tile through an isolated `TileResourceHandle` wrapping `SceneResourceManager` cleanup so evicting a tile disposes every tile-owned `BufferGeometry` and `MeshBVH` (`boundsTree`) without touching shared `ThemeMaterialRegistry` materials.
   - **Proposed Active Runtime Budgets (Target Guardrails for PoC Validation)**:
     - Active rendered tiles across viewport + hysteresis ring: `~16–48` tiles depending on zoom/aspect.
     - Target active GPU+CPU+BVH tile cache footprint: `<= 250 MB` (`LOD0`–`LOD3` combined).
     - Target concurrent scene draw calls across active tiles: `<= 350` draw calls (leveraging `<= 2`-group building bucket merging from `TKT-023` + merged per-bucket layer meshes per tile).

---

### 4.8 Caching, Invalidation & Reproducibility (`TKT-027` Contract)

1. **Snapshot-Locked Validation**:
   - `overijssel-tiles-261114-8ae28196.sqlite` inherits `TKT-027`'s strict provenance rules: the `metadata` table records `snapshot_id`, `source_sha256` (`8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0`), `projection_id`, `bake_schema_version`, and `lod_policy_hash`.
   - `server.ts` refuses to serve tiles from any pack whose `source_sha256` or `bake_schema_version` mismatches the server's expected configuration (`HTTP 503` diagnostic error, matching `OverijsselIndexIncompatibleError` discipline — zero silent stale tiles).
2. **HTTP & Client IndexedDB Caching**:
   - Endpoint `/api/tiles/:snapshotId/:bakeSchema/:lod/:tx/:ty` sets immutable cache headers (`Cache-Control: public, max-age=31536000, immutable`) and `ETag` matching `tile_manifest.content_hash`.
   - Browser caches compressed `OSMTILE1` blobs in an IndexedDB LRU store (`overijssel-tile-cache`, proposed cap `~512 MB`) keyed by `${snapshotId}:${bakeSchema}:${lod}:${tx}:${ty}` so changing `snapshot_id` or `bake_schema_version` cleanly isolates/evicts old tiles automatically.

---

## 5. Phased Implementation Plan (Small, Independently Verifiable Milestones)

To protect E2+/R+ stability and avoid huge unverified changes, `TKT-028` is structured into separately reviewed milestones (splitting Milestone 1 into **M1a** Geometry Continuity PoC and **M1b** Binary Baking & Material Registry):

| Milestone | Scope | Key Deliverables | Independent Verification |
|---|---|---|---|
| **M1a — Projection, Tile Grid, Seam Continuity & `64 m` Collar Validation *(Implemented — Pending Owner Review)*** | `EPSG:25832` projection, deterministic `512 m` grid (`8 × 8` Hengelo `4,096 m`), exact 2D/3D clipping, shared global plans/phases, `64 m` collar audit, synthetic + canonical Hengelo seam checks | `RegionalProjection.ts`, `TileGrid.ts`, `MeshBoxClipper.ts`, `CollarAudit.ts`, `TiledStudyPipeline.ts`, `SeamValidator.ts`, `scripts/verify-hengelo-m1a.ts`, `TilingProjectionAndGrid.test.ts`, `TilingSeamContinuity.test.ts`, `TilingHengeloIntegration.test.ts` | Synthetic `2 × 2` stress test + unit suite verified (`0` seam defects, exact parity vs. same-source single-scene reference); canonical `8 × 8` SQLite verification ready via `npx tsx scripts/verify-hengelo-m1a.ts` on owner Windows checkout |
| **M1b — Offline Tile Baker, `OSMTILE1` Codec & `ThemeMaterialRegistry` *(Unapproved / Future)*** | Tile-local `Float32` transform, `OSMTILE1` binary codec, `overijssel-tiles-261114-8ae28196.sqlite` persistence, shared `ThemeMaterialRegistry` (`4` themes), `MeshBVH` serialization | `TileBinaryCodec.ts`, `ThemeMaterialRegistry.ts`, offline LOD0 tile-pack baker for Hengelo `8 × 8`, consuming M1a global plan/phase & collar findings | Byte-size, bake speed, worker decode, 4-theme swap parity, `OSMTILE1` BVH inspection parity |
| **M2 — Streaming Runtime, Floating Origin & Disposal *(Unapproved / Future)*** | `/api/tiles/...` Express route, Web Worker `OSMTILE1` decoder, `TileStreamManager` (hysteresis + `AbortController` + bounded GPU commits), floating origin, IndexedDB cache, `TileResourceHandle` disposal | `server.ts` tile endpoint, `TileStreamManager.ts`, `TileDecodeWorker.ts`, `MapScene.tsx` tiled group + target-tracking shadow frustum | Automated load/pan/eviction/reload lifecycle tests: `0` WebGL/CPU/BVH leaks on tile eviction & full unmount, 4-theme live swap across active tiles, hover inspection continuity across tile boundaries |
| **M3 — Orthographic Zoom-Driven LOD1–LOD3 & Wide Navigation *(Unapproved / Future)*** | Lower `CameraController` `minZoom` (`0.15` -> `0.015–0.02`), offline baker extensions for LOD1/LOD2/LOD3, atomic quadtree parent/child replacement | Multi-LOD tile generation (`512` / `1,024` / `2,048` / `4,096 m`), `CameraController.tsx` regional zoom & dynamic frustum updates | Interactive & automated zoom-sweep tests (close-up `5 px/m` -> regional `0.02 px/m` -> pan -> zoom-in): zero holes during LOD swap, responsive frame times, `> 4.5 px/m` R+ sleeper continuity |
| **M4 — Twente & Full Overijssel Scale-Out *(Unapproved / Future)*** | Streaming/partitioned province-wide `InfrastructureGraph` generation, full Twente & Overijssel SQLite bake, CLI setup script & benchmarking | `npm run osm:bake-overijssel-tiles`, progress/disk-size reporting, Twente corridor & Overijssel scaling benchmark report | End-to-end province coverage test (`Hengelo`, `Enschede`, `Almelo`, `Zwolle`, `Deventer`, rural boundaries), bounded memory/RSS & disk verification under owner Windows testing |

---

## 6. Proof-of-Concept Scope: Hengelo `8 × 8` Tiled Grid (Milestone M1a / M1b)

Before baking all of Overijssel, **Milestone M1a** proves geometric & topological continuity across **Hengelo** (`centerLonLat = [6.7935, 52.2625]`):

1. **Grid**: `8 × 8 = 64` aligned `512 m × 512 m` cells (**`4,096 m × 4,096 m`** in `EPSG:25832`, `112` internal seams) queried from canonical `data/osm/overijssel-261114-8ae28196.sqlite` (`SHA-256: 8ae28196...`) with an outer study collar (`studyExpandedGeoBounds`). Note that this aligned `4,096 m` UTM footprint differs intentionally from the legacy `TKT-026` S5 `4,000 m` tangent-equirectangular footprint; M1a validates tiled scenes directly against a **same-source single-scene reference** in identical `EPSG:25832` coordinates.
2. **Focus in M1a**: Same-source reference vs. tiled `GeometryBuilder` output parity (roads, railways, ballast, 3D sleepers, UV phases, bridges/tunnels, buildings, water, parks, landuse, trees, barriers, `sourceFeatureId` provenance) and empirical validation of the `64 m` collar hypothesis (`CollarAudit.ts`).
3. **Follow-On in M1b**: Binary `OSMTILE1` serialization, compressed SQLite tile storage, serialized `MeshBVH`, and `ThemeMaterialRegistry`.

---

## 7. Proposed Measurable Acceptance Criteria for `TKT-028` (Full Feature Rollout)

- **Seam Continuity (`E2+` & `R+` Fidelity)**: `0` fake rounded road end-caps (`capStart`/`capEnd`) on tile-boundary splits; `0` positive-area coplanar overlaps across tile borders; `0` missing or doubled buildings along tile seams; continuous railway track phase and bridge/ramp elevations across all internal tile borders.
- **Interactive Camera & Streaming Responsiveness**: Smooth pan and zoom from close-up (`>= 4.5 CSS px/m` 3D sleepers) out to full Twente / regional view (`minZoom ~ 0.015–0.02`); zero main-thread triangulation/`polygon-clipping` stalls during tiled Overijssel exploration; atomic LOD swap with zero empty void frames when covered by coarser LOD.
- **Resource & Memory Safety**: Zero WebGL `BufferGeometry` / `MeshBVH` / material leaks across tile eviction and scene unmounts; shared `ThemeMaterialRegistry` updates all 4 themes across loaded tiles in-place without reloading geometry.
- **Feature & Precision Parity**: Float32 vertex precision preserved sub-millimeter anywhere in Overijssel via tile-local coordinates + camera-relative floating origin; OSM hover/click (`resolveInspectedFeature`), directional shadows following camera target, and live non-Overijssel Overpass fallback preserved intact.
- **Reproducibility & Integrity (`TKT-027`)**: Tile packs validate `source_sha256` against canonical `overijssel-261114-8ae28196` (`8ae28196...`) cleanly rejecting mismatched packs (`HTTP 503`), and all code passes `npm test`, `npm run lint`, and `npm run build` per milestone.
