# TKT-034 Full-Twente Regional Mosaic Baseline Record (`48 × 40` / `120` Shards / `1,920` Tiles)

> **Document Status (`2026-11-24`)**: **Full-Region Bake, Structural Integrity Verification, and Initial Owner Navigation Recorded; Full Visual, Cross-Shard Seam, and Performance Acceptance Pending**  
> **Ticket**: [`TKT-034`](../../tickets/TKT-034-full-twente-scale-out.md) (`in_progress`) · Related: [`TKT-032`](../../tickets/TKT-032-cross-shard-continuity.md), [`TKT-027`](../../tickets/TKT-027-overijssel-snapshot-integrity.md)  
> **Purpose**: Authoritative baseline reference for the completed `twente-full-1024m` LOD0 mosaic so future rendering, tiling, streaming, LOD, and performance changes can be evaluated against an exact, reproducible baseline.

---

## 1. Evidence Provenance & Acceptance Boundaries

To keep measured facts strictly separate from unmeasured properties and open acceptance gates:

1. **Automatically / CLI Verified (Project Owner's Local Windows Environment)**:
   - Completed the full **120-shard / 1,920-tile** resumable bake into `data/osm/twente-full-1024m/` (`1,754.4 s`, reusing the `2` previously verified experimental shards `r05-c07` and `r05-c08` from `2026-11-22` and baking `118` new shards).
   - Verified all `120` shards (`1,920` tiles, `1,609` non-empty) end-to-end via `verify-regional-mosaic.ts`, validating mosaic schema `1`, canonical snapshot identity and SHA-256, grid coverage, every tile's compressed SHA-256 digest, binary `OSMTILE1` decode, and tile-center metadata alignment.
2. **Initially Validated by Owner Human Runtime Exploration**:
   - Loaded `data/osm/twente-full-1024m/mosaic.json` in the live viewer (`OVERIJSSEL_REGIONAL_MOSAIC_PATH`) and confirmed navigable map rendering across **Hengelo, Almelo, Rijssen, and beyond**.
3. **Not Verified / Open Acceptance Gates (Do Not Claim Complete)**:
   - Formal cross-shard semantic and geometric continuity across the `218` shard interfaces and `99` four-way shard junctions (`TKT-032` / `scripts/audit-regional-seams.ts`).
   - Comprehensive visual QA of roads, junctions, bridges, tunnel portals, railways, railway sleeper/ribbon phase transitions, water/landuse multipolygons, and coplanar decal stability across the full `49.152 × 40.960 km` extent.
   - Hardware GPU/CPU frame-time, draw-call, streaming commit, and server startup/LRU handle-pool benchmarks under varied camera poses and panning trajectories at `120`-shard scale.

---

## 2. Verified Bake & Integrity Measurements

### 2.1 Full-Region Bake (`120` Shards / `1,920` Tiles)

**Exact command executed by project owner:**

```powershell
npx tsx scripts/bake-regional-pilot.ts --preset=twente-full
```

**Recorded output:**

```text
[regional] Complete in 1754.4s:
120 shards / 1920 tiles
covering 49.15 × 40.96 km.
Baked 118, reused 2, recovered 0,
total 648.28 MiB,
peak RSS 1744.29 MiB.
```

*(Note: `reused 2` reflects `inspectExistingRegionalShard()` validating and reusing shards `r05-c07.sqlite` and `r05-c08.sqlite` from the `2026-11-22` Stage 1–2 run: `r05-c07` took `70.6 s` / `28.38 MiB` SQLite, `r05-c08` took `22.0 s` / `6.12 MiB` SQLite, subtotal `92.7 s` / `34.50 MiB` SQLite / `1,422.11 MiB` peak RSS. Combining `92.7 s` with the `1,754.4 s` completion run gives an approximate cumulative wall time of `~1,847.1 s` across all `120` shards, while `1,754.4 s` is the exact elapsed time recorded for the `118`-baked + `2`-reused completion invocation. Per-shard timings and sizes for the individual `118` newly baked shards and host hardware specifications were not supplied.)*

### 2.2 Full-Region Structural Integrity Verification

**Exact command executed by project owner:**

```powershell
npx tsx scripts/verify-regional-mosaic.ts --index=data/osm/twente-full-1024m/mosaic.json
```

**Recorded output:**

```text
[regional:verify] OK:
120 shards,
1920 tiles (1609 non-empty),
642.22 MiB compressed
```

All `120` shards individually passed integrity verification before `verify-regional-mosaic.ts` composed and checked the full regional manifest.

### 2.3 Derived Storage & Density Summary

*(Calculated strictly from the recorded totals above; no per-shard or hardware claims beyond recorded numbers.)*

| Metric | Measured / Derived Value | Notes |
| --- | --- | --- |
| Total SQLite shard size on disk | `648.28 MiB` (`totalBakedDbBytes`) | Sum across all `120` `rXX-cYY.sqlite` shard files (`~5.40 MiB` mean per shard; includes SQLite B-tree, `metadata`, and `tile_manifest` tables). |
| Total compressed `OSMTILE1` payload size | `642.22 MiB` | Sum of `compressedBytes` across all `1,920` tiles (`~6.06 MiB` SQLite structural overhead across `120` files). |
| Non-empty / empty tiles | `1,609` non-empty / `311` empty | `83.8%` non-empty (`1,609 / 1,920`); `311` empty tiles reflect regions outside the Overijssel OSM extract (see Section 4). |
| Peak bake RSS | `1,744.29 MiB` | Single-shard sequential synthesis kept peak process memory under `1.75 GiB` across all `118` baked shards. |

---

## 3. Canonical Dataset & Source Snapshot Identity

Source snapshot enforcement is governed by [`src/server/osm/overijsselConfig.ts`](../../src/server/osm/overijsselConfig.ts), [`src/world/tiling/TilePackContract.ts`](../../src/world/tiling/TilePackContract.ts), and [the Overijssel offline dataset specification](../architecture/offline-overijssel-osm-dataset.md) (`TKT-027`).

| Property | Value |
| --- | --- |
| **Mosaic Name / Preset** | `twente-full-1024m` (`--preset=twente-full`, `TWENTE_FULL_CONFIG`) |
| **Output Directory & Index** | `data/osm/twente-full-1024m/mosaic.json` (`r00-c00.sqlite` .. `r09-c11.sqlite`) |
| **Canonical Snapshot ID** | `overijssel-261114-8ae28196` (`CANONICAL_HENGELO_SNAPSHOT_ID`) |
| **Authoritative OSM PBF** | `overijssel-261114.osm.pbf` (`114,506,422` bytes) |
| **Geofabrik Source URL** | `https://download.geofabrik.de/europe/netherlands/overijssel-261114.osm.pbf` |
| **Expected Source SHA-256** | `8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0` |
| **Expected Source MD5** | `461949c7c40f7d90b4bbb695d0933f57` |
| **OSM Base Timestamp** | `2026-11-14T21:20:41.000Z` |
| **Spatial OSM Index Path** | `data/osm/overijssel-261114-8ae28196.sqlite` (`OVERIJSSEL_INDEX_SCHEMA_VERSION = '1.0.0'`, env override `OVERIJSSEL_INDEX_PATH`) |

---

## 4. Projection, Grid Geometry & Geographic Coverage

Defined in [`src/world/tiling/RegionalMosaicPlan.ts`](../../src/world/tiling/RegionalMosaicPlan.ts) (`TWENTE_FULL_CONFIG`) and [`src/world/tiling/RegionalProjection.ts`](../../src/world/tiling/RegionalProjection.ts):

| Property | Specification |
| --- | --- |
| **Coordinate Reference System** | ETRS89 / UTM Zone 32N (`EPSG:25832`) with region-origin relative scene placement (`TileCenter` rebased per manifest) |
| **LOD Level & Tile Size** | `LOD0` only, `1,024 m × 1,024 m` (`tileSizeMeters = 1024`) |
| **Tile Grid Dimensions** | `48 × 40` (`1,920` tiles) |
| **Physical Rectangular Extent** | `49.152 km × 40.960 km` (`2,013.27 km²`; summary output rounds display to `49.15 × 40.96 km`) |
| **Aligned Tile Index Range** | `tx = 313..360` (`minTx % 4 === 1`), `ty = 5639..5678` (`minTy % 4 === 3`) |
| **UTM Bounds (`EPSG:25832`)** | Easting `320,512..369,664 m`, Northing `5,774,336..5,815,296 m` |
| **Grid Center (UTM / WGS84)** | `E 345,088 m, N 5,794,816 m` (`[6.729032°E, 52.281848°N]`) |
| **Approximate WGS84 Bounding Box** | SW `[6.379977°E, 52.090439°N]` to NE `[7.081108°E, 52.472246°N]` |
| **Shard Grid Layout** | `12 × 10` independent `4 × 4`-tile shards (`r00-c00` .. `r09-c11`, `shardDimension = 4`, `120` shards total) |
| **Shard Boundary Topology** | `218` internal shard interfaces and `99` four-way shard junctions |
| **Collar & Context Margins** | `64 m` physical tile collar (`collarMeters = 64`), `1,024 m` per-shard OSM query context (`contextMarginMeters = 1024`) |
| **Alignment with TKT-029 / TKT-033 Pilot** | All `16 / 16` pilot shards align `1:1` on identical tile and shard boundaries (`pilot r00-c00..r03-c03` $\equiv$ `full r04-c06..r07-c09`) |

### Overijssel Extract Coverage vs. Rectangular Footprint

Evaluated against `OVERIJSSEL_BOUNDARY_RING` (`src/server/osm/overijsselBoundary.ts`):

- **Covered Settlements Inside Grid & Overijssel Boundary**:
  - Cities: **Enschede** (`r06-c08`), **Hengelo** (`r05-c07`), **Almelo** (`r02-c04`), **Oldenzaal** (`r04-c09`).
  - Towns & rural belt: **Haaksbergen** (`r08-c06`), **Rijssen** (`r04-c02`), **Denekamp** (`r02-c10`), Borne, Delden, Goor, Wierden, Enter, Vriezenveen, Tubbergen, Ootmarsum, Losser, Overdinkel, Glanerbrug, De Lutte, Markelo, Diepenheim, Holten, Nijverdal, Vroomshoop, Lattrop, and Buurse.
- **Boundary Audit (`OVERIJSSEL_BOUNDARY_RING`) vs. Verified Non-Empty Tiles**:
  - Geometric footprint classification (`dry-run` / `TKT-034`): **`1,361` inside / `137` border / `422` outside** tiles (`74` inside / `31` border / `15` outside shards in Gelderland SW and Germany E/SE/NE).
  - Verified baked content: **`1,609` non-empty / `311` empty** tiles (`1,609 > 1,361 + 137 = 1,498` because Overijssel OSM ways/multipolygons extending past border vertices or clipped within the `1,024 m` query buffer overlap into adjacent border-adjacent tiles).
  - Empty or clipped edge tiles in those exterior Gelderland/German regions are an **expected boundary limitation of the Overijssel-only OSM snapshot**, not a renderer or streaming failure.

---

## 5. Tile Payload Format, Mosaic Index & Server Contract

Defined in [`src/world/tiling/TilePackContract.ts`](../../src/world/tiling/TilePackContract.ts), [`src/server/tiles/TilePackSqliteStore.ts`](../../src/server/tiles/TilePackSqliteStore.ts), and [`src/server/tiles/RegionalMosaicHttpHandler.ts`](../../src/server/tiles/RegionalMosaicHttpHandler.ts):

- **Binary Tile Payload**:
  - Magic / format version: `OSMTILE1` (`OSMTILE1_MAGIC`), format version `1` (`OSMTILE1_FORMAT_VERSION`).
  - Bake schema version: `1.1.0` (`BAKE_SCHEMA_VERSION`).
  - Compression: `deflate` (`TileCompressionAlgorithm = 'deflate'`), checksummed per tile via `content_hash` (SHA-256 of the compressed payload).
  - Embedded acceleration & provenance: `includeBvh: true` (`MeshBVH` serialization per mesh), `faceRanges`, `instanceInfos`, and inspectable OSM metadata, identified by deterministic `lodPolicyHash` (`computeLodPolicyHash`).
- **Shard SQLite Pack (`rXX-cYY.sqlite`)**:
  - Tables: `metadata` (snapshot ID, source SHA-256, `projectionId = 'EPSG:25832'`, `bakeSchemaVersion`, `lodPolicyHash`, `compression`, `tileSizeMeters`, `collarMeters`, shard origin Easting/Northing, `4×4` grid bounds, `bakeStatus = 'complete'`, timestamps), `tile_manifest` (tile bounds, local rebased centers, overhang bounds, triangle/vertex/feature counts, `is_empty`, `has_bvh`, `raw_bytes`, `compressed_bytes`, `content_hash`), and `tiles` (`payload` BLOBs).
- **Mosaic Index (`data/osm/twente-full-1024m/mosaic.json`)**:
  - JSON `RegionalMosaicIndex` (`schemaVersion: 1`, `config: TWENTE_FULL_CONFIG`, `snapshotId`, `sourceSha256`, ordered `shards` array `r00-c00.sqlite` .. `r09-c11.sqlite`).
- **Runtime Serving & Dataset Selection**:
  - Server default remains the owner-accepted TKT-033 pilot (`data/osm/twente-pilot-1024m-tkt033-candidate/mosaic.json`). Full Twente is activated explicitly via `OVERIJSSEL_REGIONAL_MOSAIC_PATH=data/osm/twente-full-1024m/mosaic.json`.
  - `RegionalMosaicHttpHandler` scans all `120` shard SQLite files sequentially during manifest load (closing each handle immediately) and serves `/api/tiles-region/:lod/:tx/:ty` through a bounded LRU SQLite pool (`DEFAULT_MAX_OPEN_SHARD_HANDLES = 16`).
  - Camera policy defaults to regional `minZoom = 0.15` (`CameraZoomPolicy` / [ADR-0013](../decisions/ADR-0013-regional-camera-zoom-policy.md)) to prevent accidental rendering of all `1,920` LOD0 tiles simultaneously; `?regionalMinZoom=...` is an explicit diagnostic override only.

---

## 6. Git Revision & Environment Provenance

| Provenance Field | Status / Value |
| --- | --- |
| **Current workspace Git `HEAD`** | **Unknown / unavailable** in this container environment (no `.git` directory is present in `/app/applet`; `git status` exits `128`). |
| **Implementation commit used to run the owner's local bake** | **Unknown / not recorded** in the owner-supplied bake output. Note that this workspace snapshot reflects documentation updates reconciled after the owner ran the local Windows bake; do not assume the current documentation commit equals the exact revision used on disk unless verified locally with `git rev-parse HEAD`. |
| **Owner local host environment** | Windows PowerShell (exact CPU, RAM, GPU model, OS build, and Node.js patch version were not supplied with the full bake output). |
| **Local generated artifacts** | `data/osm/twente-full-1024m/` and `data/osm/overijssel-261114-8ae28196.sqlite` exist only on the project owner's machine (`data/osm/` and `*.sqlite*` are gitignored) and are absent from this container. |

*(When maintaining this baseline in a Git checkout, run `git rev-parse HEAD` locally alongside the checksum commands in Section 8.5 if you want to record the exact code revision in local benchmark notes.)*

---

## 7. Known Limitations & Open Gates

1. **Cross-Shard Semantic Continuity (`TKT-032` Remains Blocked)**: Each `4 × 4` shard (`4,096 × 4,096 m`) queries OSM with a `1,024 m` context margin and `64 m` tile collar, rather than computing a region-wide global topology graph. Large multipolygons (`> 6 km` forests, water bodies, landuse), multi-shard grade-separated corridors with portals outside the `1 km` context buffer, and road/rail boundary merges across the `218` shared shard edges and `99` four-way junctions remain unverified.
2. **Per-Shard Railway Sleeper & Ribbon Phase**: `computeContinuousTrackPhases` anchors railway chain phases per shard rather than globally, so 3D sleeper spacing or UV ribbon dashes can step at cross-shard railway crossings.
3. **Overijssel Extract Boundary Truncation**: Along the German (`E/SE/NE`) and Gelderland (`SW`) edges of `OVERIJSSEL_BOUNDARY_RING`, ways and relations terminate at the province extract boundary, producing `311` empty tiles and sparse border tiles. These are expected coverage limits, not renderer defects.
4. **Large-Frustum Depth Resolution**: At `49.152 × 40.960 km` (`~74.6 km` orthographic diagonal), 24-bit depth resolution drops to `~4.45 mm/bit` (vs. `~1.43 mm/bit` on the `16 km` pilot). Coplanar surface decals (`PARKING_SPACE_SURFACE`, `PARKING_MARKINGS`, `PITCH_MARKINGS`) rely on `polygonOffset` and need visual spot-checking across the region.
5. **No Multi-Resolution Overview (`LOD1–LOD3`)**: Only `LOD0` (`1,024 m`) exists. Regional `minZoom = 0.15` remains a protective clamp rather than a multi-LOD overview solution; lowering zoom via `?regionalMinZoom=0.015` remains intentionally expensive.
6. **Hardware Runtime Telemetry Unmeasured**: 120-shard manifest latency on cold Windows disk, LRU shard-handle turnover during rapid panning, GPU frame times, and memory stability across long sessions remain to be measured in a hardware browser run.

---

## 8. Preservation & Reproducibility Instructions (Windows PowerShell)

### 8.1 Verify Canonical Source Availability

Confirm the canonical Overijssel spatial index exists and matches `overijssel-261114-8ae28196`:

```powershell
# Confirm files exist locally (paths are gitignored)
Test-Path data/osm/overijssel-261114-8ae28196.sqlite
Test-Path data/osm/twente-full-1024m/mosaic.json
```

If rebuilding the canonical source from scratch on a new machine, follow [the Overijssel dataset guide](../architecture/offline-overijssel-osm-dataset.md) (`npm run osm:setup-overijssel`) and verify that `overijssel-261114.osm.pbf` matches SHA-256 `8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0`.

### 8.2 Verify the Existing Completed Baseline Without Rebuilding

Re-run full integrity verification over the preserved mosaic without modifying any SQLite shard:

```powershell
npx tsx scripts/verify-regional-mosaic.ts --index=data/osm/twente-full-1024m/mosaic.json
```

Expected passing output confirms `120` shards, `1,920` tiles (`1,609` non-empty), `642.22 MiB` compressed payloads, canonical snapshot/SHA enforcement, valid per-tile compressed SHA-256 digests, and clean `OSMTILE1` decoding.

*(To run an automated non-visual seam audit across a specific shard boundary without mutating shards, use `scripts/audit-regional-seams.ts`, e.g., `--boundary=east-r05-c07-to-r05-c08`.)*

### 8.3 Load Full Twente in the Viewer & Confirm Active Dataset

Set `OVERIJSSEL_REGIONAL_MOSAIC_PATH` **before** starting the dev server (do not modify the server default, which stays on the accepted TKT-033 pilot):

```powershell
$env:OVERIJSSEL_REGIONAL_MOSAIC_PATH = "data/osm/twente-full-1024m/mosaic.json"
npm run dev
```

1. Open `http://localhost:3000/?m2a=1&region=twente-full&devtools=1`.
2. Confirm in **Developer Tools → Rendering → Active Mosaic**:
   - **Active Mosaic:** `twente-full-1024m`
   - **Source:** `overijssel-261114-8ae28196`
   - **Tiles:** `1920` · **Schema:** `1.1.0`
   - **Zoom-Out Cap:** `0.15`
3. Cross-check the live server manifest directly if switching datasets:

```powershell
(Invoke-RestMethod "http://localhost:3000/api/tiles-region/manifest").packPath
```

### 8.4 Reproduce Safely Without Overwriting the Accepted Baseline

To run a fresh comparison bake (for example after changing geometry, tiling, or baker logic), **always direct output to a separate `--out-dir`** so `data/osm/twente-full-1024m/` and `data/osm/twente-pilot-1024m-tkt033-candidate/` remain intact:

```powershell
# Optional dry-run plan check (writes no tiles)
npx tsx scripts/bake-regional-pilot.ts --preset=twente-full --dry-run

# Separate output directory for any reproduction or candidate experiment
$env:NODE_OPTIONS = "--expose-gc --max-old-space-size=6144"
npx tsx scripts/bake-regional-pilot.ts --preset=twente-full --out-dir=data/osm/twente-full-1024m-repro-candidate
npx tsx scripts/verify-regional-mosaic.ts --index=data/osm/twente-full-1024m-repro-candidate/mosaic.json
```

### 8.5 Local Artifact Fingerprinting (Outside Git)

Because `.gitignore` excludes `data/osm/`, `*.osm.pbf`, and `*.sqlite*`, generated shard packs (`~648.28 MiB`) **must never be committed to Git**. Keep a local checksum manifest beside backups or in external storage if archiving the baseline. Per-file SHA-256 hashes were **not** computed in this environment because the baked shards live only on the owner's workstation; generate them locally with:

```powershell
# Windows PowerShell: record mosaic.json + all 120 shard SQLite SHA-256 digests + byte sizes
Get-ChildItem data/osm/twente-full-1024m -Include mosaic.json,*.sqlite -Recurse |
  Sort-Object Name |
  ForEach-Object {
    $h = Get-FileHash $_.FullName -Algorithm SHA256
    [PSCustomObject]@{ File = $_.Name; Bytes = $_.Length; SHA256 = $h.Hash.ToLowerInvariant() }
  } | Export-Csv -NoTypeInformation -Path twente-full-1024m-checksums.csv
```

Or on Linux/macOS / Git Bash:

```bash
sha256sum data/osm/twente-full-1024m/mosaic.json data/osm/twente-full-1024m/r*.sqlite > twente-full-1024m-checksums.sha256
```

Remember that `OSMTILE1` shard SQLite files also embed per-tile `content_hash` (SHA-256 of every compressed tile payload), `metadata.source_sha256`, and `metadata.lod_policy_hash`, which `verify-regional-mosaic.ts` checks on every run.
