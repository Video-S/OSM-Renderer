---
id: TKT-034
title: Full Twente Scale-Out (48x40 Aligned 1,024 m Regional Mosaic)
type: feature
status: in_progress
priority: high
created: 2026-11-22
updated: 2026-11-22
---

# TKT-034 — Full Twente Scale-Out

## Summary

Expand the owner-accepted 16 km Twente pilot (`data/osm/twente-pilot-1024m-tkt033-candidate/mosaic.json`, 16 shards / 256 tiles) into a complete Twente regional dataset (`data/osm/twente-full-1024m/`, 120 shards / 1,920 tiles) by reusing the existing offline, resumable, shard-based baker and fixing concrete scale blockers discovered at 120-shard scale.

This ticket remains **`in_progress`** pending the project owner's local staged experimental bake (1–2 shards), full resumable bake, complete shard/tile integrity verification, targeted seam checks, and human visual inspection on the local Overijssel OSM SQLite dataset.

---

## 1. Geographical Footprint Specification (`TWENTE_FULL_CONFIG`)

Defined in `src/world/tiling/RegionalMosaicPlan.ts` (`TWENTE_FULL_CONFIG`, preset `twente-full`):

| Property | Value |
| --- | --- |
| Config / Mosaic Name | `twente-full-1024m` |
| Output Directory | `data/osm/twente-full-1024m/` (leaves `twente-pilot-1024m` and `twente-pilot-1024m-tkt033-candidate` untouched) |
| Tile Grid | `48 × 40` tiles of `1,024 m` LOD0 (**1,920 tiles**) |
| Shard Grid | `12 × 10` independent `4 × 4` shards (**120 shards**) |
| Physical Rectangular Extent | `49.152 km × 40.960 km` (`2,013.27 km²`) |
| Aligned Tile Index Range | `tx = 313..360` (`minTx % 4 === 1`), `ty = 5639..5678` (`minTy % 4 === 3`) |
| UTM EPSG:25832 Bounds | Easting `320,512..369,664 m`, Northing `5,774,336..5,815,296 m` |
| Grid Center (UTM / WGS84) | `E 345,088 m`, `N 5,794,816 m` (`[6.729032, 52.281848]`, between Delden, Borne, and Almelo) |
| Approx. WGS84 Bounding Box | SW `[6.379977, 52.090439]` to NE `[7.081108, 52.472246]` |
| Collar / Query Context Margin | `64 m` tile collar / `1,024 m` per-shard OSM query context |
| Internal Shard Topology | `218` shared shard edges, `99` four-way shard junctions |
| Alignment with TKT-029/TKT-033 Pilot | **16 / 16 pilot shards align 1:1** on identical tile & shard boundaries (`pilot r00-c00..r03-c03` == `full r04-c06..r07-c09`) |

### Settlement Coverage & Overijssel OSM Extract Availability

Evaluated against `OVERIJSSEL_BOUNDARY_RING` (`src/server/osm/overijsselBoundary.ts`, canonical snapshot `overijssel-261114-8ae28196`):

- **All target Twente cities, towns, and surrounding rural/border settlements lie inside both the 48 × 40 grid AND `OVERIJSSEL_BOUNDARY_RING`:**
  - Core cities: **Enschede** (`r06-c08`), **Hengelo** (`r05-c07`), **Almelo** (`r02-c04`), **Oldenzaal** (`r04-c09`).
  - Key towns: **Haaksbergen** (`r08-c06`), **Rijssen** (`r04-c02`), **Denekamp** (`r02-c10`), Borne (`r04-c06`), Delden (`r05-c05`), Goor (`r06-c03`), Wierden (`r02-c03`), Enter (`r04-c03`), Vriezenveen (`r01-c04`), Tubbergen (`r01-c07`), Ootmarsum (`r01-c08`), Losser (`r05-c10`).
  - Border/rural coverage: Overdinkel (`r06-c11`), Glanerbrug (`r06-c10`), De Lutte (`r04-c10`), Markelo (`r06-c02`), Diepenheim (`r07-c03`), Holten (`r04-c00`), Nijverdal (`r02-c01`), Vroomshoop (`r00-c03`), Lattrop (`r01-c10`), Buurse (`r08-c07`).
- **Rectangular grid coverage vs. actual Overijssel OSM data availability:**
  - **Tiles (1,920 total):** `1,361` fully inside Overijssel (`70.9%`), `137` straddling the province/country boundary (`7.1%`), and `422` completely outside the Overijssel extract (`22.0%` — Gelderland to the SW and Germany to the E/SE/NE).
  - **Shards (120 total):** `74` fully inside Overijssel, `31` straddling the boundary, and `15` completely outside (`r00-c11`, `r07-c00`, `r07-c11`, `r08-c00`, `r08-c01`, `r08-c02`, `r08-c10`, `r08-c11`, `r09-c00`, `r09-c01`, `r09-c02`, `r09-c03`, `r09-c09`, `r09-c10`, `r09-c11`). Those 15 outside shards (and the exterior portion of border shards) will legitimately produce empty or near-empty tiles from the Overijssel-only OSM snapshot.
  - **Rationale for keeping 48 × 40:** Aligns 1:1 with the 16 pilot shards (`minTx % 4 === 1`, `minTy % 4 === 3`), covers every requested Twente city/town and rural buffer from Holten/Nijverdal/Rijssen/Markelo in the west to Denekamp/Losser/Overdinkel in the east and Haaksbergen/Buurse in the south to Vroomshoop/Tubbergen/Ootmarsum/Lattrop in the north. Only ~40 m of uninhabited Dinkel borderland at the extreme NE tip (`52.47259°N` vs `52.47225°N`) lies north of `ty=5678`, which does not justify expanding the grid by an extra 4 rows (+48 tiles / +12 shards).

---

## 2. Scale-Specific Investigation & Concrete Fixes Implemented

1. **Unbounded SQLite file handles in `RegionalMosaicHttpHandler.ts` (Fixed):**
   - Previously, `load()` opened and retained one permanent `TilePackHttpController` / `DatabaseSync` connection for every shard in `mosaic.json`. At 120 shards this would pin 120 open read-only SQLite handles and 120× SQLite page caches for the lifetime of the server.
   - **Fix:** `load()` now scans shards sequentially, extracts metadata/manifest entries/file sizes, and closes each SQLite store immediately in `finally` (0 handles held after manifest load). Tile payload requests are served through a bounded LRU pool capped at `DEFAULT_MAX_OPEN_SHARD_HANDLES = 16` (configurable via `maxOpenShardHandles`), closing evicted handles cleanly and releasing all handles on `close()`.
2. **Shard reuse validation, corruption recovery, and orphaned staging cleanup in `scripts/bake-regional-pilot.ts` (Fixed):**
   - Previously, `validateExistingShard()` only checked shard metadata headers, crashed uncaught on corrupt/truncated SQLite files, and did not verify compressed tile SHA-256 blobs or clean up orphaned `*.staging-*` files left by killed processes.
   - **Fix:** Added `inspectExistingRegionalShard()` (verifies snapshot/SHA/schema/grid bounds AND compressed SHA-256 of every tile blob), `cleanupOrphanedShardStagingFiles()`, and `--recover-corrupt`. Valid shards from an incompatible grid/snapshot remain strictly fatal even with `--recover-corrupt` so unrelated datasets can never be clobbered.
3. **Multi-shard OSM index reuse & per-shard memory/timing telemetry (`OfflineHengeloTileBaker.ts`, `scripts/bake-regional-pilot.ts`) (Fixed):**
   - `bakeHengeloTilesFromStore` now accepts an optional caller-owned `store?: OverijsselOsmStore` so a 120-shard run reuses one read-only spatial index connection instead of reopening and re-validating the 1+ GB index 120 times.
   - `scripts/bake-regional-pilot.ts` adds `--preset=twente-full`, `--dry-run` (`--report-out`, `--markdown-out`), `--shards=<id1,id2>` for bounded 1–2 shard experimental checks, optional `globalThis.gc?.()` between shards when launched with `--expose-gc`, and per-shard timing/RSS/heap/size logging. Partial runs (`--shards` or `--max-shards`) never publish `mosaic.json`.
4. **Partial experimental shard verification (`scripts/verify-regional-mosaic.ts`) (Fixed):**
   - Previously, `verifyRegionalMosaic` only verified completed mosaics with a published `mosaic.json`.
   - **Fix:** Added `verifyPartialRegionalShards` (`--shards-dir=... --preset=twente-full [--shards=...]`) to verify bounded 1–2 shard experimental outputs (metadata, planned shard coordinates, compressed SHA-256, and full `OSMTILE1` binary decode) before authorizing a full 120-shard bake.
5. **Browser regional streaming aliases & envelope labeling (`src/app/App.tsx`) (Fixed):**
   - Added `?region=twente-full` and `?region=twente` aliases alongside `?region=twente-pilot` (all routing to `/api/tiles-region` with the conservative `0.15` regional zoom-out cap intact) and updated the loaded envelope label to reflect the active mosaic name and actual `gridCols×gridRows` dimensions.

---

## 3. Dry-Run Summary & Clearly Labeled Resource Estimates

Executed locally via `npx tsx scripts/bake-regional-pilot.ts --preset=twente-full --dry-run`:

- **Grid:** `48 × 40` (`1,920` tiles, `120` shards of `4 × 4`) = `49.152 × 40.960 km` (`2,013.27 km²`)
- **Tile range:** `tx=313..360, ty=5639..5678` | **UTM:** `E=320512..369664, N=5774336..5815296`
- **Overijssel coverage:** `1,361` inside / `137` border / `422` outside tiles (`74` inside / `31` border / `15` outside shards)
- **Pilot 1:1 shard matches:** `16/16`

> **ESTIMATES ONLY (non-measured projections — NOT factual measurements):**
> Grounded in the recorded 16-shard dense-urban TKT-032 pilot baseline (`235.68 MiB` compressed across 16 shards, `~14.73 MiB/shard`), adjusted for rural farmland density and 15 outside-Overijssel shards:
> - **Estimated compressed SQLite total:** `~582 – 1,322 MiB` (midpoint `~939 MiB`)
> - **Estimated full bake wall-clock time:** `~27 – 133 minutes` (midpoint `~61 minutes`, hardware-dependent)
> - **Estimated per-shard peak RSS:** `~900 – 2,800 MiB` (only one `4 × 4` shard ingested at a time)
> - **Action required:** Record actual wall-clock time, peak RSS, and SQLite disk size from Stage 1–2 before committing to Stage 3.

---

## 4. Staged Local Validation & Execution Commands (Windows PowerShell)

All commands preserve `data/osm/twente-pilot-1024m-tkt033-candidate/` and target `data/osm/twente-full-1024m/`.

### Stage 0 — Reproducible Dry-Run Plan (no synthesis, no writes to `data/osm/twente-full-1024m/`)
```powershell
npx tsx scripts/bake-regional-pilot.ts --preset=twente-full --dry-run --report-out=benchmarks/results/tkt034-twente-full-dry-run.json --markdown-out=benchmarks/results/tkt034-twente-full-dry-run.md
```

### Stage 1 — Bounded 2-Shard Experimental Bake (Hengelo `r05-c07` + adjacent Almelo/rural `r02-c04` or Enschede seam pair `r05-c07,r05-c08`)
```powershell
$env:NODE_OPTIONS = "--expose-gc --max-old-space-size=6144"
npx tsx scripts/bake-regional-pilot.ts --preset=twente-full --shards=r05-c07,r05-c08
```
*(Does NOT publish `mosaic.json`. Inspect actual per-shard seconds, triangles, MiB on disk, and RSS/heap output before continuing.)*

### Stage 2 — Integrity Verification of Experimental Output
```powershell
npx tsx scripts/verify-regional-mosaic.ts --shards-dir=data/osm/twente-full-1024m --preset=twente-full --shards=r05-c07,r05-c08
```

### Stage 3 — Resumable Full Twente Bake (owner-authorized only after Stage 1–2 checks pass)
```powershell
$env:NODE_OPTIONS = "--expose-gc --max-old-space-size=6144"
npx tsx scripts/bake-regional-pilot.ts --preset=twente-full
```
*(Safe to interrupt and resume: already verified shards are reused automatically. If a power loss or kill leaves an incomplete/corrupt shard file, resume with `--recover-corrupt`:)*
```powershell
npx tsx scripts/bake-regional-pilot.ts --preset=twente-full --recover-corrupt
```

### Stage 4 — Complete Integrity Verification (all 120 shards / 1,920 tiles)
```powershell
npx tsx scripts/verify-regional-mosaic.ts --index=data/osm/twente-full-1024m/mosaic.json
```

### Stage 5 — Targeted Seam Checks & Local Viewer Launch
Targeted seam audit on representative urban/rail interfaces (example: Hengelo–Enschede / Almelo–Borne shard boundaries):
```powershell
npx tsx scripts/audit-regional-seams.ts --index=data/osm/twente-full-1024m/mosaic.json --boundary=east-r05-c07-to-r05-c08 --out=benchmarks/results/tkt034-seam-r05-c07-c08.json --markdown-out=benchmarks/results/tkt034-seam-r05-c07-c08.md
```
Start the viewer against Full Twente without changing the default accepted pilot:
```powershell
$env:OVERIJSSEL_REGIONAL_MOSAIC_PATH = "data/osm/twente-full-1024m/mosaic.json"
npm run dev
```
Open:
- `http://localhost:3000/?m2a=1&region=twente-full&devtools=1`
- Confirm in Developer Tools: **Active Mosaic:** `twente-full-1024m`, **Tiles:** `1920`, **Schema:** `1.1.0`, **Zoom-Out Cap:** `0.15`.

---

## 5. Explicit Remaining Correctness & Performance Risks

1. **1,024 m shard query context is NOT global topology parity:** Across `218` internal shard interfaces and `99` four-way shard junctions, features whose topological/geometric continuity depends on context beyond `1,024 m` (e.g., very large forest/landuse/water multipolygons spanning > 6 km, long grade-separated corridors with portals > 1 km away, or cross-shard road/rail merges) can still exhibit seam discontinuities.
2. **Railway sleeper & ribbon phase continuity:** `computeContinuousTrackPhases` anchors continuous chain starts per shard, not to a global regional coordinate frame, so 3D sleepers and rail dash/ballast transitions can still show phase steps at cross-shard railway crossings.
3. **Overijssel boundary edge truncation:** Along the German (E/SE/NE) and Gelderland (SW) edges of `OVERIJSSEL_BOUNDARY_RING`, Geofabrik extract clipping truncates ways and relations abruptly; the 15 exterior shards and exterior halves of 31 border shards will be empty or sparse.
4. **Orthographic frustum depth-buffer precision at 49.152 × 40.960 km:** `computeSceneFrustumPlanes` derives `[near, far]` from the full expanded scene bounds (`~74.6 km` depth span → `~4.45 mm/bit` in a 24-bit depth buffer, compared to `~1.43 mm/bit` on the 16 km pilot). Coplanar surface decals (`PARKING_SPACE_SURFACE` +3 mm, `PARKING_MARKINGS` / `PITCH_MARKINGS` +4 mm) rely heavily on `polygonOffset` and should be visually inspected during Stage 5.
5. **Manifest payload size & startup parsing:** A 1,920-tile manifest JSON is ~7.5× larger than the 256-tile pilot (~600–850 KB uncompressed). First-load sequential scanning of 120 SQLite headers on the server is fast on SSDs (< 1 s in synthetic tests) but should be observed on local Windows storage during Stage 4–5.
6. **Unmeasured local Overijssel bake timings & memory:** The canonical Overijssel SQLite index (`overijssel-261114-8ae28196.sqlite`) is local to the project owner's machine and absent in the sandbox container; real-dataset shard timings, peak RSS, storage totals, seam audit results, and human visual checks remain to be measured locally.

---

## 6. Verification Record

- **Sandbox environment note:** `data/osm/` contains no Overijssel OSM SQLite index or baked mosaics in this container; automated verification used synthetic SQLite packs (including a full 120-shard / 1,920-tile mosaic) and the read-only dry-run CLI. No full Twente bake was executed and no human visual inspection was claimed.
- Automated checks recorded at implementation closeout (see final turn summary for exact exit codes and outputs).
