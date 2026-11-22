# ADR-0011: Baked Geometry Tiles, Regional Projection, and Runtime Streaming

## Metadata

- **Decision ID**: `ADR-0011`
- **Status**: **Accepted for the implemented LOD0 tiled renderer**; multi-level LOD remains proposed
- **Date recorded**: 2026-11-22 (retrospective record of TKT-027/TKT-028 implementation and owner acceptance)
- **Evidence**: TKT-027, TKT-028, TKT-028-F1, TKT-029, TKT-031

## Context and problem

The synchronous single-scene OSM geometry builder works for bounded local areas but cannot be scaled naively to a whole region: parsing, surface Boolean operations, mesh generation, WebGL submission and residency would grow with the entire map. Local equirectangular coordinates from [ADR-0001](ADR-0001-geographic-coordinates-and-local-projection.md) are useful for live/local queries but are not the common grid used by large offline mosaics.

## Decision

1. **Use the frozen OSM source snapshot for offline baking.** The canonical Overijssel source identity is `overijssel-261114-8ae28196` (TKT-027). Offline source data is indexed in SQLite. Input and output compatibility must be checked, not assumed from filenames.
2. **Use a common metric regional grid.** `RegionalProjection.ts` and `TileGrid.ts` use ETRS89 / UTM zone 32N (`EPSG:25832`), integer metric tile coordinates, deterministic aligned bounds and a local scene origin. Geometry placement is tile-local / origin-relative rather than passing large absolute UTM coordinates directly to GPU vertices. The live/local `WorldCoordinates.ts` path remains supported.
3. **Bake reusable, theme-independent LOD0 payloads.** `OfflineHengeloTileBaker.ts`, `TilePackSqliteStore.ts`, `TilePackContract.ts`, and the `OSMTILE1` codec store mesh geometry, material references, feature provenance and BVH metadata. Current bake schema is `1.1.0`. Retain source-feature inspection and all four themes.
4. **Stream viewport-relevant tiles rather than reconstructing the whole region.** `TileStreamManager.ts` fetches a manifest, selects/requests tiles, decodes payloads with a worker, reconstructs Three.js objects, and evicts/disposes distant tile-owned resources. `ThemeMaterialRegistry` shares materials; `SceneResourceManager` owns geometry cleanup. The actual manifest `packPath` determines Developer Tools dataset identity.
5. **Use 1,024 m LOD0 tiles for the accepted regional pilot.** Smaller 512 m Hengelo packs/experiments remain valid separate configurations; this decision does not change their format or assert 1,024 m is universally optimal. Performance evidence under TKT-028-F1 is specific to measured hardware and preload/retain margins.

## Alternatives and trade-offs

- Building every regional scene synchronously from live OSM overloads the browser at scale.
- A wholly static, theme-specific scene would weaken runtime theme switching and inspection.
- A global graph and precomputed multi-resolution LOD may improve cross-shard fidelity and overview performance but **have not been implemented as assumed prerequisites** for current regional LOD0 baking.

The present design shifts costly synthesis offline and bounds browser residency, but retained tile mesh count, WebGL draw calls, overdraw and GPU cost still depend on viewport size. A 16 km LOD0 overview was expensive on the owner's RTX 4060 Ti (TKT-031); this is not evidence that all close-range gameplay views are slow.

## Related implementation and evidence

- `src/world/tiling/{RegionalProjection,TileGrid,TilePackContract,TileStreamManager}.ts`
- `src/server/tiles/{OfflineHengeloTileBaker,TilePackSqliteStore}.ts`
- `src/world/tiling/TileSceneReconstructor.ts` (streamed scene reconstruction)
- `tickets/TKT-028-regional-tiling-streaming-lod.md`, `tickets/TKT-028-F1-physical-margin-parity.md`
- `src/world/TilingM2aStreaming.test.ts`, `src/world/TilingRegionalMosaic.test.ts`

## Scope and related decisions

Complements, **does not wholly supersede**, [ADR-0001](ADR-0001-geographic-coordinates-and-local-projection.md): equirectangular is the local/live path; UTM is the offline tiled path. Related to [ADR-0005](ADR-0005-source-feature-provenance-and-diagnostics.md), [ADR-0006](ADR-0006-gpu-resource-lifecycle-and-disposal.md), [ADR-0009](ADR-0009-infrastructure-graph-topology.md), [ADR-0010](ADR-0010-surface-first-road-rendering.md) and [ADR-0012](ADR-0012-bounded-regional-mosaics.md).
