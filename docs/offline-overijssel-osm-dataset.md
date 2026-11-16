# Persistent Offline OSM Data Store — Overijssel (Including Twente)

Implemented for **TKT-022**. Provides a persistent, spatially indexed local OpenStreetMap data store covering the **entire province of Overijssel (including Twente)** so all locations inside Overijssel load without contacting Overpass and survive server restarts.

---

## 1. Immutable Source Snapshot & Attribution

| Property | Value |
| :--- | :--- |
| **Snapshot ID** | `overijssel-261114` |
| **Authoritative PBF** | `overijssel-261114.osm.pbf` (`114,506,422` bytes) |
| **Geofabrik Source URL** | `https://download.geofabrik.de/europe/netherlands/overijssel-261114.osm.pbf` |
| **SHA-256 Checksum** | `53d1f2d0b6c9461b4d752610c5c348bb48d1c1ac77838e75b934bf676a980243` |
| **OSM Base Timestamp** | `2026-11-14T21:20:41.000Z` |
| **Attribution** | © OpenStreetMap contributors (ODbL 1.0) via Geofabrik Overijssel extract |
| **Update Policy** | Strictly immutable snapshot — no automatic updates, expiry, or background sync |

All `11,929,711` nodes (`889,565` tagged nodes), `1,471,295` ways, and `22,499` relations from the snapshot are indexed without filtering out small features (`amenity=bench`, `amenity=waste_basket`, `highway=street_lamp`, `natural=tree`, etc.) or unfamiliar OSM categories.

---

## 2. Storage & Spatial Indexing Architecture

- **Engine**: Built-in Node.js `node:sqlite` (`DatabaseSync`) with SQLite **R\*Tree** (`rtree` virtual tables). Zero C++ / `node-gyp` native build toolchains required on Windows, Linux, or macOS (requires **Node.js `>= 22.5.0`**).
- **Index File**: Self-contained single-file database `data/osm/overijssel-261114.sqlite` (~`907.6 MiB`, `PRAGMA journal_mode = DELETE`, opened read-only at runtime). Both `data/osm/`, `*.osm.pbf`, and `*.sqlite*` are excluded in `.gitignore`.
- **Tables**:
  - `metadata` — schema version, snapshot ID, PBF SHA-256, timestamp, attribution, and element counts.
  - `nodes` (`id PRIMARY KEY`, `lon`, `lat`, `tags_json`) + `tagged_node_rtree` (`id`, `min_lon`, `max_lon`, `min_lat`, `max_lat`).
  - `ways` (`id PRIMARY KEY`, `refs_json`, `tags_json`) + `way_rtree`.
  - `relations` (`id PRIMARY KEY`, `members_json`, `tags_json`) + `relation_rtree`.
- **Query Reconstruction (`src/server/osm/OverijsselOsmStore.ts`)**:
  - Queries `tagged_node_rtree`, `way_rtree`, and `relation_rtree` for `(minLon, minLat, maxLon, maxLat)` (padded by `1e-4` deg for 32-bit R\*Tree rounding safety, then exact-filtered on 64-bit coordinates).
  - Expands member closure for multipolygons, buildings, and physical structures so rings and courtyards spanning query boundaries reconstruct completely.
  - Fetches 100% of referenced nodes for every included way (including nodes outside the query bbox) so ways cross boundaries cleanly and `enrichGeoJsonWithOverpassNodeIds` attaches verified `_nodeIds` / `_nodeIdsByPart`.
  - Converts via `osmtogeojson` into the exact GeoJSON format expected by `LocalGeoJsonProvider` and `OsmApiProvider`.
- **Coverage Routing (`src/server/osm/overijsselBoundary.ts` & `osmDataHandler.ts`)**:
  - Evaluates `isPointInOverijssel(lat, lon)` against the exact 299-vertex Geofabrik `overijssel.poly` boundary.
  - **Covered locations**: served exclusively from `overijssel-261114.sqlite` (`X-OSM-Source: overijssel-offline`, `X-OSM-Snapshot: overijssel-261114`) with `TKT-021` `Server-Timing` headers (`cache`, `upstream`, `osmtogeojson`, `enrich`, `total`). If the index is missing or invalid, `/api/osm-data` returns **HTTP 503** with setup instructions and **never falls back to Overpass**.
  - **External locations** (e.g., Amsterdam, Germany, Gelderland): continue using the existing Overpass / OSM 0.6 XML flow.

---

## 3. Setup Instructions (Windows, Linux, macOS, and Google AI Studio)

### Standard One-Command Setup (Network Access Available)

Run in PowerShell, Command Prompt, or Bash (Node.js `>= 22.5.0`):

```bash
npm run osm:setup-overijssel
```

This runs two idempotent steps (can also be run individually):

1. `npm run osm:fetch-overijssel` — downloads `overijssel-261114.osm.pbf` into `data/osm/` and verifies SHA-256 `53d1f2d0...980243`.
2. `npm run osm:build-overijssel-index` — preprocesses the PBF into `data/osm/overijssel-261114.sqlite` (typically ~45–90 seconds, < 500 MB peak RAM).

### Providing an Existing Local PBF or Moving Datasets Across Environments

If the `.osm.pbf` was downloaded separately (or mounted/uploaded in an offline container or Google AI Studio workspace):

```bash
# Option A: Install/verify from an existing local PBF path and build the index
npx tsx scripts/setup-overijssel.ts --from=/path/to/overijssel-261114.osm.pbf

# Option B: Point the server directly at a prebuilt .sqlite index stored elsewhere
# (Add to .env or process environment; works cleanly on Windows paths too)
OVERIJSSEL_INDEX_PATH=C:\osm-data\overijssel-261114.sqlite
```

Restarting `npm run dev` or `npm start` reuses the existing `data/osm/overijssel-261114.sqlite` immediately with no re-indexing.
