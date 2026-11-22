# Persistent Offline OSM Data Store — Overijssel (Including Twente)

Implemented for **TKT-022** and updated for **TKT-027**. Provides a persistent, spatially indexed local OpenStreetMap data store covering the **entire province of Overijssel (including Twente)** so all locations inside Overijssel load without contacting Overpass and survive server restarts.

---

## 1. Immutable Canonical Snapshot & Provenance Distinction

| Property | Value |
| :--- | :--- |
| **Canonical Snapshot ID** | `overijssel-261114-8ae28196` |
| **Authoritative PBF** | `overijssel-261114.osm.pbf` (`114,506,422` bytes) |
| **Geofabrik Source URL** | `https://download.geofabrik.de/europe/netherlands/overijssel-261114.osm.pbf` |
| **SHA-256 Checksum** | `8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0` |
| **MD5 Checksum (Geofabrik)** | `461949c7c40f7d90b4bbb695d0933f57` |
| **OSM Base Timestamp** | `2026-11-14T21:20:41.000Z` |
| **Attribution** | © OpenStreetMap contributors (ODbL 1.0) via Geofabrik Overijssel extract |
| **Update Policy** | Strictly immutable snapshot — no automatic updates, expiry, or background sync |

All nodes, ways, and relations from the snapshot are indexed without filtering out small features (`amenity=bench`, `amenity=waste_basket`, `highway=street_lamp`, `natural=tree`, etc.) or unfamiliar OSM categories.

### Historical Benchmark Provenance (`overijssel-261114`, SHA-256 `53d1f2d0...`)

- The frozen Hengelo scaling series (`benchmarks/datasets/hengelo-scaling/manifest.json`, **TKT-019**) and the initial **TKT-022** build (`11,929,711` nodes, `889,565` tagged nodes, `1,471,295` ways, `22,499` relations) recorded a different SHA-256 digest (`53d1f2d0b6c9461b4d752610c5c348bb48d1c1ac77838e75b934bf676a980243`) for a `114,506,422`-byte `overijssel-261114.osm.pbf` file originally cached in `/tmp/overijssel-261114.osm.pbf`.
- Repeated clean downloads from Geofabrik (`https://download.geofabrik.de/europe/netherlands/overijssel-261114.osm.pbf`, after HTTP 200 redirect) produce `114,506,422` bytes matching Geofabrik's published MD5 `461949c7c40f7d90b4bbb695d0933f57` and SHA-256 `8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0`.
- **Provenance uncertainty**: Because the raw bytes of the earlier `53d1f2d0...` file are no longer stored in the repository or available from Geofabrik, identical filename and byte size (`114,506,422` bytes) do **not** prove byte-for-byte or semantic equivalence between `53d1f2d0...` and `8ae28196...`. Therefore:
  - The verified Geofabrik download is given a distinct canonical snapshot identity (`overijssel-261114-8ae28196` and `data/osm/overijssel-261114-8ae28196.sqlite`).
  - `benchmarks/datasets/hengelo-scaling/manifest.json` (`overijssel-261114` / `53d1f2d0...`) is preserved untouched so historical `TKT-019`–`TKT-026` benchmark provenance stays accurate.
  - Legacy or mismatched SQLite indexes (`source_sha256 !== 8ae28196...` in canonical mode) are rejected cleanly with `OverijsselIndexIncompatibleError` (HTTP `503`) rather than silently served.

---

## 2. Storage & Spatial Indexing Architecture

- **Engine**: Built-in Node.js `node:sqlite` (`DatabaseSync`) with SQLite **R\*Tree** (`rtree` virtual tables). Zero C++ / `node-gyp` native build toolchains required on Windows, Linux, or macOS (requires **Node.js `>= 22.5.0`**).
- **Index File**: Self-contained single-file database `data/osm/overijssel-261114-8ae28196.sqlite` (`PRAGMA journal_mode = DELETE`, opened read-only at runtime). Both `data/osm/`, `*.osm.pbf`, and `*.sqlite*` are excluded in `.gitignore`.
- **Tables & Integrity Metadata**:
  - `metadata` — schema version, `snapshot_id` (`overijssel-261114-8ae28196` canonical or `custom-<12hex>` for custom PBFs), `snapshot_mode` (`'canonical' | 'custom'`), actual `source_sha256`, `source_md5`, `source_bytes`, timestamp, attribution, and element counts.
  - `nodes` (`id PRIMARY KEY`, `lon`, `lat`, `tags_json`) + `tagged_node_rtree` (`id`, `min_lon`, `max_lon`, `min_lat`, `max_lat`).
  - `ways` (`id PRIMARY KEY`, `refs_json`, `tags_json`) + `way_rtree`.
  - `relations` (`id PRIMARY KEY`, `members_json`, `tags_json`) + `relation_rtree`.
- **Integrity & Compatibility Enforcement (`TKT-027`)**:
  - `scripts/fetch-overijssel-pbf.ts` always verifies SHA-256 on both downloads (discarding temp files on mismatch) and existing local files unless `--skip-hash-check` or `--allow-custom-snapshot` is explicitly passed.
  - `scripts/build-overijssel-index.ts` computes the actual PBF SHA-256/MD5/byte count, refuses unapproved canonical mismatches, assigns a `custom-<12hex>` identity for custom PBFs, and never reuses an existing SQLite index whose `source_sha256`, `snapshot_mode`, or `snapshot_id` differs from the input PBF.
  - `OverijsselOsmStore` requires `schema_version`, `snapshot_id`, and `source_sha256` metadata and rejects any non-custom SQLite index whose `source_sha256` does not match `8ae28196...` with `OverijsselIndexIncompatibleError` (returning HTTP `503` without Overpass fallback).
- **Query Reconstruction (`src/server/osm/OverijsselOsmStore.ts`)**:
  - Queries `tagged_node_rtree`, `way_rtree`, and `relation_rtree` for `(minLon, minLat, maxLon, maxLat)` (padded by `1e-4` deg for 32-bit R\*Tree rounding safety, then exact-filtered on 64-bit coordinates).
  - Expands member closure for multipolygons, buildings, and physical structures so rings and courtyards spanning query boundaries reconstruct completely.
  - Fetches 100% of referenced nodes for every included way (including nodes outside the query bbox) so ways cross boundaries cleanly and `enrichGeoJsonWithOverpassNodeIds` attaches verified `_nodeIds` / `_nodeIdsByPart`.
  - Converts via `osmtogeojson` into the exact GeoJSON format expected by `LocalGeoJsonProvider` and `OsmApiProvider`.
- **Coverage Routing (`src/server/osm/overijsselBoundary.ts` & `osmDataHandler.ts`)**:
  - Evaluates `isPointInOverijssel(lat, lon)` against the exact 299-vertex Geofabrik `overijssel.poly` boundary.
  - **Covered locations**: served exclusively from the validated local SQLite store (`X-OSM-Source: overijssel-offline`, `X-OSM-Snapshot: overijssel-261114-8ae28196`) with `TKT-021` `Server-Timing` headers (`cache`, `upstream`, `osmtogeojson`, `enrich`, `total`). If the index is missing or incompatible, `/api/osm-data` returns **HTTP 503** with recovery instructions and **never falls back to Overpass**.
  - **External locations** (e.g., Amsterdam, Germany, Gelderland): continue using the existing Overpass / OSM 0.6 XML flow.

---

## 3. Setup Instructions (Windows PowerShell, Linux, and macOS)

### Standard One-Command Setup (Network Access Available)

Run in PowerShell, Command Prompt, or Bash (Node.js `>= 22.5.0`):

```bash
npm run osm:setup-overijssel
```

This runs two idempotent steps (can also be run individually):

1. `npm run osm:fetch-overijssel` — downloads `overijssel-261114.osm.pbf` into `data/osm/` and verifies SHA-256 `8ae28196...21c0` (MD5 `461949c7c40f7d90b4bbb695d0933f57`).
2. `npm run osm:build-overijssel-index` — verifies the PBF SHA-256 and preprocesses it into `data/osm/overijssel-261114-8ae28196.sqlite` (typically ~45–90 seconds, < 500 MB peak RAM).

### Passing Flags in Windows PowerShell (`--allow-custom-snapshot`, `--force`, `--from`)

Windows PowerShell consumes an unquoted `--` argument in `npm run <script> -- --flag`, causing `npm` to intercept unknown `--allow-custom-snapshot` flags. Use any of these PowerShell-safe forms:

```powershell
# Recommended: invoke the TypeScript script directly
npx tsx scripts/setup-overijssel.ts --allow-custom-snapshot --from="C:\path\to\custom.osm.pbf"
npx tsx scripts/setup-overijssel.ts --force

# Or pass OVERIJSSEL_* environment variables to npm
$env:OVERIJSSEL_ALLOW_CUSTOM_SNAPSHOT = "1"
npm run osm:setup-overijssel

# Or quote "--" so PowerShell forwards it literally to npm
npm run osm:setup-overijssel -- "--" --allow-custom-snapshot
```

> **Note:** `scripts/config` also honors `npm_config_*` fallbacks (`npm_config_allow_custom_snapshot`, `npm_config_force`, `npm_config_from`, etc.), and indexing with `--allow-custom-snapshot` assigns a separate `custom-<12hex>` snapshot ID while recording the real `source_sha256` and `source_md5` in SQLite `metadata`.

### Providing an Existing Local PBF or Prebuilt SQLite Index

```bash
# Option A: Install/verify from an existing local PBF path and build the canonical index
npx tsx scripts/setup-overijssel.ts --from=/path/to/overijssel-261114.osm.pbf

# Option B: Point the server directly at a prebuilt .sqlite index stored elsewhere
# (Add to .env or process environment; works cleanly on Windows paths too)
OVERIJSSEL_INDEX_PATH=C:\osm-data\overijssel-261114-8ae28196.sqlite
```

Restarting `npm run dev` or `npm start` reuses the existing validated SQLite index immediately with no re-indexing. To disable automatic server startup/request bootstrapping during tests or offline checks, set `DISABLE_OVERIJSSEL_BOOTSTRAP=1` (or `OVERIJSSEL_AUTO_BOOTSTRAP=false` / `--no-overijssel-bootstrap`).
