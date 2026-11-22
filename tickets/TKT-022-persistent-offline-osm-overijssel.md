---
id: TKT-022
title: Persistent Offline OSM Data Store for Overijssel (Including Twente)
type: feature
status: closed
priority: high
created: 2026-11-16
updated: 2026-11-16
---

# TKT-022: Persistent Offline OSM Data Store for Overijssel (Including Twente)

## Summary
Implement a persistent, locally stored, spatially indexed OpenStreetMap data store covering the entire province of Overijssel (including Twente) from the immutable November 14, 2026 Geofabrik PBF snapshot (`overijssel-261114.osm.pbf`), eliminating live Overpass requests inside Overijssel while preserving all mapped OSM features, small street furniture/nature details, multipolygons, and verified node-ID topology across server restarts.

## Context
Live Overpass requests from `/api/osm-data` frequently stall or time out (5–25s+ cold wait, and `overpass-api.de` times out at 15s from restricted environments), and larger radii dropped node-level details in Overpass fallback queries. Because Overijssel (including Hengelo and Twente) is the primary study region, serving Overijssel deterministically from a persistent local SQLite + R\*Tree index removes upstream Overpass latency/flakiness completely without altering the 3D renderer or GeoJSON ingestion pipeline.

## Acceptance Criteria
- [x] Uses the immutable Geofabrik Overijssel snapshot (`overijssel-261114.osm.pbf`, SHA-256 `53d1f2d0b6c9461b4d752610c5c348bb48d1c1ac77838e75b934bf676a980243`, timestamp `2026-11-14T21:20:41.000Z`) with source attribution and snapshot metadata retained and zero automatic update/expiry mechanisms.
- [x] Indexes 100% of mapped OSM nodes (`11,929,711` total, `889,565` tagged), ways (`1,471,295`), and relations (`22,499`) with zero feature or tag filtering (preserving benches, waste baskets, street lamps, trees, and unfamiliar tags) plus full node-ID enrichment (`_nodeIds`/`_nodeIdsByPart`) and multipolygon member closure.
- [x] Persistent SQLite + R\*Tree spatial store (`node:sqlite` + SQLite `rtree`) queries arbitrary `(lat, lon, radiusMeters)` regions directly on disk without reading the whole PBF per request, without holding the province in server RAM, and survives server restarts with zero C++ native build toolchains on Windows/Linux/macOS.
- [x] `/api/osm-data` routes Overijssel coordinates (`isPointInOverijssel(lat, lon)` against the exact Geofabrik `overijssel.poly` boundary) exclusively to the local store (`X-OSM-Source: overijssel-offline`), never silently falling back to Overpass when missing/failing (returns explicit HTTP 503 with setup instructions), while non-Overijssel coordinates continue using Overpass.
- [x] Emits `TKT-021`-compatible `Server-Timing`, `X-OSM-Cache`, `X-OSM-Source`, `X-OSM-Snapshot`, and `X-OSM-Feature-Count` headers (`MapLoadDiagnostics` recognizes `'overijssel-offline'`).
- [x] Cross-platform setup scripts (`npm run osm:fetch-overijssel`, `npm run osm:build-overijssel-index`, `npm run osm:setup-overijssel`), `.gitignore` exclusions for generated PBF/SQLite artifacts, `.env.example` overrides, and documentation (`docs/architecture/offline-overijssel-osm-dataset.md`) are in place.
- [x] Smoke-tested on live `/api/osm-data` after server restart across Station Hengelo, Enschede Centrum, and Zwolle Station with small details, infrastructure, persistence, and `TKT-021` timing breakdown verified.

## Implementation Notes
- **Modules**:
  - `src/server/osm/overijsselConfig.ts` — immutable snapshot metadata and `OVERIJSSEL_DATA_DIR` / `OVERIJSSEL_PBF_PATH` / `OVERIJSSEL_INDEX_PATH` resolvers.
  - `src/server/osm/overijsselBoundary.ts` — embedded 299-vertex Geofabrik `overijssel.poly` boundary + `isPointInOverijssel(lat, lon)`.
  - `src/server/osm/OsmPbfReader.ts` — zero-dependency streaming OSM PBF reader.
  - `src/server/osm/OverijsselIndexBuilder.ts` — streaming SQLite + R\*Tree index builder using a ~190 MB typed-array node coordinate directory during build and finalizing a self-contained single-file `DELETE`-mode SQLite DB.
  - `src/server/osm/OverijsselOsmStore.ts` — read-only spatial query engine with R\*Tree float32 safety padding + exact 64-bit coordinate filtering, multipolygon/physical-relation member closure, full boundary-crossing way node resolution, `osmtogeojson` conversion, and `enrichGeoJsonWithOverpassNodeIds`.
  - `src/server/osm/osmDataHandler.ts` & `server.ts` — `/api/osm-data` integration with strict non-fallback for Overijssel and clean shutdown.
  - `src/world/dev/MapLoadDiagnostics.ts` — added `'overijssel-offline'` `upstreamSource` recognition.
- **No renderer changes**: `LocalGeoJsonProvider`, `FeatureCatalogue`, and `GeometryBuilder` remain unchanged.

## Verification
- **Real Snapshot Build (`npm run osm:build-overijssel-index`)**:
  - Verified SHA-256 `53d1f2d0b6c9461b4d752610c5c348bb48d1c1ac77838e75b934bf676a980243` for `data/osm/overijssel-261114.osm.pbf`.
  - Indexed `11,929,711` nodes (`889,565` tagged), `1,471,295` ways, and `22,499` relations in `67.75 s` into `data/osm/overijssel-261114.sqlite` (`907.6 MiB`).
- **Live Server `/api/osm-data` + `OsmApiProvider` + `GeometryBuilder` Smoke Tests (after `restart_dev_server`)**:
  - **Station Hengelo (`52.2625, 6.7935`, `r=400 m`) Cold Offline Miss**: `HTTP 200`, `X-OSM-Source: overijssel-offline`, server `upstream=256.8 ms`, `osmtogeojson=404.0 ms`, `enrich=89.3 ms`, `totalServer=751.2 ms`; client `osmRequest=910.2 ms`, `transferAndDecode=226.6 ms` (`7.39 MB`, `6,977` features), `geoJsonProcessing=450.2 ms`, `sceneGeometry=2274.8 ms`; small details verified (`78` benches, `40` waste baskets, `734` trees; `3,395` rendered features).
  - **Station Hengelo Warm Cache Hit**: `HTTP 200`, `X-OSM-Cache: HIT`, `X-OSM-Source: cache`, `totalServer=0.026 ms`, `osmRequest=130.1 ms`, `geoJsonProcessing=247.0 ms`, `sceneGeometry=1774.3 ms`.
  - **Enschede Centrum (`52.2215, 6.8937`, `r=400 m`) Cold Offline Miss**: `HTTP 200`, `X-OSM-Source: overijssel-offline`, `totalServer=618.7 ms` (`upstream=243.5 ms`, `osmtogeojson=321.5 ms`, `enrich=53.3 ms`), `8,946` features (`74` benches, `83` waste baskets, `703` trees), `3,432` rendered features.
  - **Zwolle Station (`52.5047, 6.0919`, `r=400 m`) Cold Offline Miss**: `HTTP 200`, `X-OSM-Source: overijssel-offline`, `totalServer=723.5 ms`, `7,102` features (`90` benches, `59` waste baskets, `52` street lamps, `861` trees), `3,641` rendered features.
- **Focused Automated Test Suite** (`npx tsx --test src/world/OverijsselOfflineStore.test.ts src/world/MapLoadDiagnostics.test.ts src/world/GeometryBuilder.test.ts src/world/FeatureCoverage.test.ts src/world/PlanarAndRoadSpatialIndex.test.ts`): **35 / 35 passed** (`0` failures; full `npm test` deferred while `TKT-018` remains open).
- **Typecheck, Production Build & API Docs**: Verified cleanly at closeout (`tsc --noEmit`, `vite build`, `npm run docs:api`).

## Related Files and Documentation
- Source: `src/server/osm/overijsselConfig.ts`, `src/server/osm/overijsselBoundary.ts`, `src/server/osm/OsmPbfReader.ts`, `src/server/osm/OverijsselIndexBuilder.ts`, `src/server/osm/OverijsselOsmStore.ts`, `src/server/osm/osmDataHandler.ts`, `server.ts`, `src/world/dev/MapLoadDiagnostics.ts`
- Scripts: `scripts/fetch-overijssel-pbf.ts`, `scripts/build-overijssel-index.ts`, `scripts/setup-overijssel.ts`
- Tests: `src/world/OverijsselOfflineStore.test.ts`
- Documentation: `docs/architecture/offline-overijssel-osm-dataset.md`, `docs/STATUS.md`
