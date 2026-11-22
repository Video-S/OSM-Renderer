# System Architecture — Current Implementation

> **Reconciled: 2026-11-22.** This describes the **implemented** renderer. The older [regional LOD proposal](../plans/regional-tiling-streaming-lod-proposal.md) is retained as an architectural docs/research/roadmap document, **not** a list of already delivered capabilities. See [current status](../STATUS.md) and [ADRs](../decisions/README.md).

## 1. Product and execution paths

The OSM Renderer is a browser-based isometric 3D geographic viewer (React 19, TypeScript, Three.js r186, React Three Fiber v9, Tailwind, Node/Express). Its scope is **rendering map content and navigating it**; gameplay, agents and physics have not been implemented.

There are **two supported data/geometry paths**, sharing production E2+/R+ infrastructure semantics:

| Path | Source and coordinate model | Geometry work | Typical use |
| --- | --- | --- | --- |
| **Live/local map** | Local GeoJSON / Overpass via `LocalGeoJsonProvider.ts` and `OsmApiProvider.ts`; local equirectangular `WorldCoordinates.ts` | `GeometryBuilder.ts` synthesizes meshes for the requested bounded region at runtime | Smaller city extracts, fixtures, reproduction packages |
| **Offline baked regional streaming** | Canonical indexed Overijssel OSM; aligned UTM `EPSG:25832` grid from `RegionalProjection.ts` / `TileGrid.ts` | Offline `OfflineHengeloTileBaker.ts` generates compressed `OSMTILE1` SQLite shards; browser fetches/decodes/reconstructs **only relevant tiles** | 1,024 m LOD0 Hengelo/Twente mosaic and scale experiments |

**Important:** The offline regional projection **extends** the local projection decision in ADR-0001 rather than replacing every live/local query. Neither path currently has multi-resolution LOD1–LOD3.

## 2. Production feature geometry

- **Roads:** E2+ / `graph-surface`, using `InfrastructureGraph` render descriptors, rounded full-width 2D footprints in `SurfaceFirstRoadFootprints.ts`, deterministic priority-ordered Boolean surface ownership and triangulation. The earlier legacy/E2 explicit junction solver is not a production choice (TKT-026; ADR-0010).
- **Railways:** R+ / `graph-R+`, graph-informed topology, surface-first ballast and hybrid instanced/UV-rendered sleepers and rails. Source provenance, verified graph relationships, bridge/at-grade/tunnel transitions and railway crossing semantics remain separate from mere 2D intersections.
- **Other layers:** water, land use, ground cover, building extrusion, bridges and tunnels are built using `GeometryBuilder.ts`, `BridgeAndTunnelBuilder.ts`, `ElevationPolicy.ts` and relevant layer processors. Semantic 2D ownership and physical Y elevation are distinct; `polygonOffset` mitigates some depth conflicts.
- **Feature inspection and themes:** `faceRanges`, `instanceInfos`, BVH metadata and `ThemeMaterialRegistry.ts` preserve inspection and fast theme updates in the baked path.

References: [ADR-0008](../decisions/ADR-0008-hybrid-railway-rendering-and-uv-ribbon-architecture.md), [ADR-0009](../decisions/ADR-0009-infrastructure-graph-topology.md), [ADR-0010](../decisions/ADR-0010-surface-first-road-rendering.md).

## 3. Offline source, baking and manifest pipeline

```text
Canonical overijssel-261114-8ae28196 OSM snapshot
  -> OverijsselOsmStore / spatial SQLite index (source SHA checked)
  -> RegionalMosaicPlan: aligned 1,024 m grid, 4 x 4-tile shards
  -> OfflineHengeloTileBaker: bounded per-shard OSM query and E2+/R+ synthesis
  -> OSMTILE1 schema 1.1.0 + tile metadata/BVHs -> SQLite shard files
  -> complete, verified mosaic.json (never for a partial bake)
  -> RegionalMosaicHttpHandler: one manifest, rebased tile origins, tile endpoints
  -> TileStreamManager: viewport request/worker decode/tile reconstruction/disposal
  -> MapScene + CameraController: scene, inspection, camera controls
```

The region is a **single logical mosaic**, not a single in-memory geometry scene. Shard builds use a 1,024 m OSM query context margin and a 64 m tile collar. These are **local mitigations** and are not equivalent to a globally computed infrastructure graph. Full cross-shard semantic/geometry parity remains an explicit validation gate (TKT-032).

The accepted **16 × 16** pilot has 16 independently baked shards (256 tiles). The **48 × 40** full-Twente plan has 120 shards (1,920 tiles). The new scale-out implementation scans shard metadata sequentially when creating the manifest and uses an LRU pool of at most **16 open SQLite shard handles** for payload requests; it supports resumable baking and partial verification. The full output is **still awaiting completion and owner acceptance** (TKT-034).

### Dataset selection and truth

- Regional routes: `/api/tiles-region/manifest`, `/api/tiles-region/:lod/:tx/:ty` (plus versioned forms).
- Server default: `data/osm/twente-pilot-1024m-tkt033-candidate/mosaic.json`, provided it exists.
- Explicit override: `OVERIJSSEL_REGIONAL_MOSAIC_PATH` set **before restarting the server**; unavailable/mismatched data returns a clear manifest error, not a fallback to an unverified bake.
- `?region=twente-pilot`, `?region=twente` and `?region=twente-full` are **viewer aliases** to the same regional API. They **do not** override the server mosaic selection.
- Developer Tools derives the displayed **Active Mosaic** name, `packPath`, snapshot, tile count and schema from the *successfully loaded manifest*. Loading/errors/dataset switches clear stale active-mosaic state.

## 4. Runtime streaming, ownership and camera

| Component | Responsibility |
| --- | --- |
| `src/app/App.tsx` | Application mode, dataset lifecycle, active mosaic diagnostics, tile manager disposal/switch token, camera policy and UI state |
| `src/world/tiling/TileStreamManager.ts` | Manifest/metadata lifecycle; viewport tile selection, fetch, worker decode, load/eviction diagnostics, tile-owned cleanup |
| `src/world/tiling/TileDecodeClient.ts` | Worker-based compressed tile decode |
| `src/world/tiling/TileSceneReconstructor.ts` | Reconstructs tile-local scene geometry and provenance from decoded payload |
| `src/world/tiling/ThemeMaterialRegistry.ts` and `src/world/SceneResourceManager.ts` | Share thematic materials and dispose scene/geometry/BVH allocations |
| `src/scene/MapScene.tsx` | Three.js/R3F scene presentation and inspection |
| `src/scene/CameraController.tsx` and `src/scene/cameraZoomPolicy.ts` | Orthographic projection, pan/tilt, projected bounds framing, camera limits and transitions |
| `src/components/DevToolsPanel.tsx` | Active mosaic/zoom-source readout, performance counters and reproducible diagnostics |

A `TileStreamManager` manifest is reported **loaded only after tile records/overlays initialize successfully**. Errors clear partial tiles and the active identity. The **accepted regional zoom-out floor** is `0.15` for datasets larger than 64 tiles, with an explicit validated `regionalMinZoom` escape hatch; `maxZoom=16.0`. Smaller maps retain standard zoom policy. See [ADR-0013](../decisions/ADR-0013-regional-camera-zoom-policy.md).

**Ownership boundary:** source providers/graph construction return typed data; the geometry layer produces Three.js resources; streaming and scene lifecycle managers own resource disposal. UI code does not manually manipulate tile vertex buffers. Tile source and manifest identity must not be guessed from URL aliases.

## 5. Accuracy and performance constraints

1. **No global topology parity claim:** independent shard synthesis can disagree at boundaries for long ways/relations, bridges/tunnels, waterways and sleeper phase. TKT-032 is still blocked as a broader continuity gate; accepting a small set of corrected TKT-033 roads does not resolve every seam.
2. **LOD0 overview GPU cost:** the complete 16 km detailed overview was around 7,373 draw calls and 42.6 ms GPU on one RTX 4060 Ti test. Defaults restrict zoom-out to prevent accidental all-tile render; this is not an overview LOD system.
3. **OSM extract boundaries:** the full-Twente rectangle crosses outside the Overijssel data source, leaving missing exterior map geometry. This must not be misdiagnosed as a stream failure.
4. **Large-region coordinate and depth precision:** UTM coordinates are rebased locally, but large full-region frustums can still degrade depth-buffer resolution. Visual checks remain necessary for coplanar markings and portal details.
5. **Verification layers are different:** checksum/manifest/decode tests establish pack integrity, seam audits sample local correctness, and the **project owner** performs final visual acceptance. None implies the others automatically.

## 6. Decision records and longer-term options

- [ADR-0011](../decisions/ADR-0011-baked-tiles-and-runtime-streaming.md): offline baked tiles, projection, data format and runtime streaming.
- [ADR-0012](../decisions/ADR-0012-bounded-regional-mosaics.md): bounded shard baking, manifest gateway, dataset selection and seam risks.
- [ADR-0013](../decisions/ADR-0013-regional-camera-zoom-policy.md): zoom safety cap and benchmark overrides.

**Not yet implemented / separately scoped:** global precomputed topology/geometry plans, multi-LOD1–LOD3 overview rendering, full Overijssel streaming, gameplay, routing agents or simulation. The [regional tiling proposal](../plans/regional-tiling-streaming-lod-proposal.md) and [Goalpost 2 plan](../plans/goalpost-2-plan.md) preserve the historical design rationale without implying current authorization or implementation.
