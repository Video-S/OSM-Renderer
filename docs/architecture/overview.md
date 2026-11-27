# System Architecture — Current Implementation

> **Reconciled: 2026-11-27.** This describes the **implemented** renderer. The older [regional LOD proposal](../plans/regional-tiling-streaming-lod-proposal.md) and the exploratory [regional colony simulation design discussion](../plans/colony-sim-design-discussion.md) record design context and future direction, **not** already delivered capabilities. See [current status](../STATUS.md) and [ADRs](../decisions/README.md).

## 1. Product and execution paths

The OSM Renderer is a browser-based isometric 3D geographic viewer (React 19, TypeScript, Three.js r186, React Three Fiber v9, Tailwind, Node/Express). Its scope is **rendering map content and navigating it**; gameplay, agents and physics have not been implemented.

There are **two supported data/geometry paths**, sharing production E2+/R+ infrastructure semantics:

| Path | Source and coordinate model | Geometry work | Typical use |
| --- | --- | --- | --- |
| **Live/local map** | Local GeoJSON / Overpass via `LocalGeoJsonProvider.ts` and `OsmApiProvider.ts`; local equirectangular `WorldCoordinates.ts` | `GeometryBuilder.ts` synthesizes meshes for the requested bounded region at runtime | Smaller city extracts, fixtures, reproduction packages |
| **Offline baked regional streaming** | Canonical indexed Overijssel OSM; aligned UTM `EPSG:25832` grid from `RegionalProjection.ts` / `TileGrid.ts` | Offline `OfflineHengeloTileBaker.ts` generates compressed `OSMTILE1` SQLite shards (`1,024 m`), optionally consolidated offline via `OfflineTileConsolidator.ts` into `2,048 m` and `4,096 m` `OSMTILE1` packs; browser fetches/decodes/reconstructs **only relevant tiles** across a single active resolution per frame | Regional Hengelo/Twente mosaics (`1,024 m` single-res or `1,024 m / 2,048 m / 4,096 m` hierarchical streaming) |

**Important:** The offline regional projection **extends** the local projection decision in ADR-0001 rather than replacing every live/local query. Neither path currently implements geometric LOD1–LOD3 simplification; hierarchical streaming switches uniform-viewport spatial batching granularity across existing LOD0 `OSMTILE1` packs (`ADR-0015`).

## 2. Production feature geometry

- **Roads:** E2+ / `graph-surface`, using `InfrastructureGraph` render descriptors, rounded full-width 2D footprints in `SurfaceFirstRoadFootprints.ts`, deterministic priority-ordered Boolean surface ownership and triangulation. The earlier legacy/E2 explicit junction solver is not a production choice (TKT-026; ADR-0010).
- **Railways:** R+ / `graph-R+`, graph-informed topology, surface-first ballast and hybrid instanced/UV-rendered sleepers and rails. Source provenance, verified graph relationships, bridge/at-grade/tunnel transitions and railway crossing semantics remain separate from mere 2D intersections.
- **Other layers & runtime foliage LOD:** water, land use, ground cover, building extrusion, bridges and tunnels are built using `GeometryBuilder.ts`, `BridgeAndTunnelBuilder.ts`, `ElevationPolicy.ts` and relevant layer processors; `FoliageLodSystem.ts` swaps shared canopy prototypes (`lod0`/`lod1`/`lod2`), suppresses trunks by zoom, and applies conservative affine-AABB frustum culling (`TKT-036`). Semantic 2D ownership and physical Y elevation are distinct; `polygonOffset` mitigates some depth conflicts.
- **Feature inspection and themes:** `CompactTileTransport.ts` lazy typed-array metadata (`faceRanges`, `singleFeatureIdx`, feature tables), worker-built `InstancedSpatialIndex.ts` BVHs (`ADR-0014`), static `MeshBVH` deserialization, and `ThemeMaterialRegistry.ts` preserve picking parity and fast theme updates across all resolutions in the baked path.

References: [ADR-0008](../decisions/ADR-0008-hybrid-railway-rendering-and-uv-ribbon-architecture.md), [ADR-0009](../decisions/ADR-0009-infrastructure-graph-topology.md), [ADR-0010](../decisions/ADR-0010-surface-first-road-rendering.md), [ADR-0014](../decisions/ADR-0014-spatially-accelerated-instanced-feature-picking.md).

## 3. Offline source, baking and manifest pipeline

```text
Canonical overijssel-261114-8ae28196 OSM snapshot
  -> OverijsselOsmStore / spatial SQLite index (source SHA checked)
  -> RegionalMosaicPlan: aligned 1,024 m grid, 4 x 4-tile shards
  -> OfflineHengeloTileBaker: bounded per-shard OSM query and E2+/R+ synthesis
  -> OSMTILE1 schema 1.1.0 + tile metadata/BVHs -> SQLite shard files
  -> complete, verified mosaic.json (never for a partial bake)
  -> Optional OfflineTileConsolidator (2,048 m / 4,096 m) + HierarchicalRegionalMosaicDescriptor
  -> RegionalMosaicHttpHandler + tilePackHttpHandler: single/multi-res manifest, shared 16-handle SQLite LRU pool, ?compressed=1 deflate passthrough
  -> TileStreamManager + TileDecodeClient/Worker: 8-stage decoupled pipeline, frame-budgeted scheduling, incremental GPU prep, atomic swaps
  -> MapScene + CameraController: scene, accelerated picking, camera controls
```

The region is a **single logical mosaic**, not a single in-memory geometry scene. Shard builds use a 1,024 m OSM query context margin and a 64 m tile collar. These are **local mitigations** and are not equivalent to a globally computed infrastructure graph. Full cross-shard semantic/geometry parity remains an explicit validation gate (TKT-032).

The accepted **16 × 16** pilot has 16 independently baked shards (256 tiles). The **48 × 40** full-Twente mosaic has 120 shards (1,920 tiles). The scale-out implementation scans shard metadata sequentially when creating the manifest and uses **one shared LRU pool of at most 16 open SQLite shard handles** across single-resolution or multi-resolution (`1,024 m / 2,048 m / 4,096 m`) payload requests; it supports resumable baking and partial verification. The full 120-shard bake, full structural integrity check, and initial owner navigation are recorded in the [TKT-034 baseline report](../reports/tkt034-full-twente-baseline.md), while formal cross-shard seam checks (`TKT-032`), full runtime performance characterization, and complete visual acceptance remain open.

### Dataset selection and truth

- Regional routes: `/api/tiles-region/manifest`, `/api/tiles-region/:lod/:tx/:ty`, and resolution-qualified `/api/tiles-region/r/:tileSizeMeters/:lod/:tx/:ty` (plus versioned forms and optional `?compressed=1` deflate passthrough).
- Server default: `data/osm/twente-pilot-1024m-tkt033-candidate/mosaic.json`, provided it exists.
- Explicit override: `OVERIJSSEL_HIERARCHICAL_MOSAIC_PATH` (takes precedence for multi-resolution descriptors) or `OVERIJSSEL_REGIONAL_MOSAIC_PATH` set **before restarting the server**; unavailable/mismatched data returns a clear manifest error, not a fallback to an unverified bake.
- `?region=twente-pilot`, `?region=twente` and `?region=twente-full` are **viewer aliases** to the same regional API. They **do not** override the server mosaic selection.
- The workspace `World` and `Diagnostics` panels derive the displayed **Active Mosaic** name, `packPath`, snapshot, tile count, populated/empty tile coverage and schema from the *successfully loaded manifest*. Loading/errors/dataset switches clear stale active-mosaic state.

## 4. Runtime streaming, ownership, search and workspace UI

| Component | Responsibility |
| --- | --- |
| `src/app/App.tsx` | Regional-first startup (`/api/tiles-region`), dataset lifecycle, active mosaic diagnostics, tile manager disposal/switch token, immediate tile failure surfacing, camera policy and 3-region workspace state |
| `src/world/tiling/TileStreamManager.ts` | Single/multi-resolution (`1,024 / 2,048 / 4,096 m`) decoupled 8-stage pipeline (`queued -> fetching -> retrieved_queued -> decoding -> ready_to_commit -> prepared_inactive -> GPU prep -> atomic activation`), single-owner byte handoff, oversized-payload forward progress, reserved destination slots, `1,536 MiB` default resource budget (`HierarchicalResourceBudget.ts`), `deferred_budget` safeguard, LRU inactive cache, and `f2_combined` default scheduling (`StreamingSchedulerConfig.ts`) |
| `src/world/tiling/HierarchicalResolutionPolicy.ts` | Viewport-compensated zoom hysteresis (`1024<->2048` / `2048<->4096`), transition debouncing, and velocity-/latency-aware adaptive prewarming horizon (`evaluateAdaptivePrewarmHorizon`, `predictViewportBoundsAtHorizon`) |
| `src/world/tiling/StreamingWorkloadScheduler.ts`, `IncrementalGpuPreparer.ts`, `DeferredDisposalQueue.ts` | Priority-ordered per-frame main-thread budget (`2.0 ms` default), public-API offscreen `1×1` WebGL buffer pre-upload, and bounded deferred `BufferGeometry`/BVH disposal |
| `src/world/tiling/TileDecodeClient.ts` & `TileDecodeWorker.ts` | Priority-queued 4-worker pool (`f2_combined` default) with bounded decode timeouts, concurrent `DecompressionStream('deflate')` inflation, compact zero-copy buffer transfer (`CompactTileTransport.ts`), and worker-side `InstancedSpatialIndex` BVH construction |
| `src/world/tiling/TileSceneReconstructor.ts`, `StreamingProfiler.ts` | `O(1)` worker-BVH and compact metadata adoption, opt-in zero-overhead-when-disabled frame/stage/transition critical-path profiling (`?streamingProfile=1`) |
| `src/world/tiling/ThemeMaterialRegistry.ts` and `src/world/SceneResourceManager.ts` | Share thematic materials and dispose scene/geometry/BVH allocations |
| `src/scene/MapScene.tsx` | Three.js/R3F scene presentation, gated frame telemetry (`trackTelemetry`), staging-scene isolation, and spatially accelerated feature picking (`InstancedSpatialIndex.ts`) |
| `src/scene/CameraController.tsx` and `src/scene/cameraZoomPolicy.ts` | Orthographic projection, pan/tilt, projected bounds framing, camera limits, compass orientation updates and transitions |
| `src/components/workspace/` | Three-region workspace shell (`NavigationSidebar`, viewport `CameraToolbar`, `ContextSidebar` across `Search`, `Layers`, `Appearance`, `Inspector`, `Performance`, `Diagnostics`, `World`) |
| `src/server/osm/OverijsselSearchIndex.ts` & `searchDataHandler.ts` | Offline SQLite FTS5 local search (`*.search.sqlite`, `/api/search*`) over `OverijsselOsmStore` with mosaic tile coverage attribution |

A `TileStreamManager` manifest is reported **loaded only after tile records/overlays initialize successfully**. Errors clear partial tiles and the active identity. The **accepted regional zoom-out floor** is `0.15` for datasets larger than 64 tiles, with an explicit validated `regionalMinZoom` escape hatch; `maxZoom=16.0`. Smaller maps retain standard zoom policy. See [ADR-0013](../decisions/ADR-0013-regional-camera-zoom-policy.md).

**Ownership boundary:** source providers/graph construction return typed data; the geometry layer produces Three.js resources; streaming and scene lifecycle managers own resource disposal. UI code does not manually manipulate tile vertex buffers. Tile source and manifest identity must not be guessed from URL aliases.

## 5. Accuracy and performance constraints

1. **No global topology parity claim:** independent shard synthesis can disagree at boundaries for long ways/relations, bridges/tunnels, waterways and sleeper phase. TKT-032 is still blocked as a broader continuity gate; accepting a small set of corrected TKT-033 roads does not resolve every seam.
2. **Hierarchical LOD0 batching vs. true LOD1–LOD3:** `4,096 m` spatial consolidation reduced regional overview CPU render time from `36.50 ms` to `4.00 ms` on RTX 4060 Ti (`TKT-037`), and `TKT-041` / `TKT-041-F1` / `TKT-041-F2` (`f2_combined` default, `TKT-041-F2` closed `2026-11-27`) provide an owner-accepted foundation for `1,024 m / 2,048 m / 4,096 m` hierarchical transitions (`1.0–2.7 s` to `4,096 m` on RTX 4060 Ti). However, consolidated `4,096 m` tiles remain large indivisible streaming payloads, frame-time consistency is mixed across scenarios, and peak accounted memory increased under concurrent worker preparation. Further uniform full-detail transition optimization is deferred until exploring a lightweight strategic regional representation paired with detailed local views ([`colony-sim-design-discussion.md`](../plans/colony-sim-design-discussion.md)).
3. **OSM extract boundaries:** the full-Twente rectangle crosses outside the Overijssel data source, leaving missing exterior map geometry. This must not be misdiagnosed as a stream failure.
4. **Large-region coordinate and depth precision:** UTM coordinates are rebased locally, but large full-region frustums can still degrade depth-buffer resolution. Visual checks remain necessary for coplanar markings and portal details.
5. **Verification layers are different:** checksum/manifest/decode tests establish pack integrity, seam audits sample local correctness, and the **project owner** performs final visual acceptance. None implies the others automatically.

## 6. Decision records and longer-term options

- [ADR-0011](../decisions/ADR-0011-baked-tiles-and-runtime-streaming.md): offline baked tiles, projection, data format and runtime streaming.
- [ADR-0012](../decisions/ADR-0012-bounded-regional-mosaics.md): bounded shard baking, manifest gateway, dataset selection and seam risks.
- [ADR-0013](../decisions/ADR-0013-regional-camera-zoom-policy.md): zoom safety cap and benchmark overrides.
- [ADR-0014](../decisions/ADR-0014-spatially-accelerated-instanced-feature-picking.md): mesh-local flat typed-array BVH instanced picking.
- [ADR-0015](../decisions/ADR-0015-hierarchical-tile-streaming.md): uniform-viewport `1,024 m / 2,048 m / 4,096 m` hierarchical streaming and atomic swaps.
- [ADR-0016](../decisions/ADR-0016-frame-budgeted-streaming-and-incremental-gpu-prep.md): frame-budgeted streaming scheduler, offscreen 1×1 incremental GPU preparation, deferred disposal, and `1,536 MiB` default budget.
- [ADR-0017](../decisions/ADR-0017-decoupled-streaming-pipeline-and-adaptive-prewarm.md): decoupled 8-stage pipeline, compressed worker transfer, reserved destination slots, adaptive prewarming, and `f2_combined` default (`TKT-041-F2` closed `2026-11-27`).

**Not yet implemented / separately scoped:** global precomputed topology/geometry plans, multi-LOD1–LOD3 overview rendering, lightweight dual-map strategic regional representation, full Overijssel streaming, gameplay, routing agents or simulation. The [regional colony simulation design discussion](../plans/colony-sim-design-discussion.md), [regional tiling proposal](../plans/regional-tiling-streaming-lod-proposal.md), and [Goalpost 2 plan](../plans/goalpost-2-plan.md) record design context and future direction without implying current implementation or ticket authorization.
