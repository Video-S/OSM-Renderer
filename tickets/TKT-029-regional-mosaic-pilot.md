---
id: TKT-029
title: Bounded Regional Mosaic Pilot — Hengelo to Enschede
type: feature
status: in_progress
priority: high
created: 2026-11-21
updated: 2026-11-21
related_tickets:
  - TKT-028
  - TKT-028-F1
---

# TKT-029 — Bounded Regional Mosaic Pilot

## Goal

See the accepted E2+/R+ renderer operating **across a region**, not merely the 4,096 m Hengelo study, while preserving the smooth, 1,024 m LOD0 on-demand rendering established in TKT-028-F1.

**Pilot footprint:** a 16 × 16 grid of 1,024 m tiles (16.384 × 16.384 km, 256 total) centered near Hengelo–Enschede at [6.845, 52.25]. The grid is a *bounding square pilot*, not an administrative Twente boundary and not yet all of Twente. It includes both city centers. A later regional expansion could cover roughly 48 × 40 km / 1,875 tiles, but only after the pilot is validated.

## Architecture and Implementation

- **No whole-region ingestion:** split the pilot grid into **16 independent 4 × 4 tile shards** (16 LOD0 tiles each). Query the immutable Overijssel SQLite index separately for each shard, with an initial 1,024 m spatial/topology context margin; ingest, precompute and bake the shard; dispose plans; continue. Support resuming finished validated shards.
- Each shard writes a **separate OSMTILE1 SQLite pack** using the existing 1.1.0 codec, BVH, E2+/R+ geometry, materials and feature metadata. Never overwrite either accepted Hengelo pack.
- **Manifest gateway** exposes `/api/tiles-region/manifest` and `/api/tiles-region/:lod/:tx/:ty`. Validate snapshot, schema, LOD policy, full grid coverage, duplicates, coordinates and pack hashes. Publish `mosaic.json` only when all 16 shards are available.
- **Coordinate placement:** each shard's encoded geometry is local to its tile, but the header tile center is expressed relative to the *shard* frame. Rebase its manifest tile center to the *regional* frame and let the streamer apply the manifest center to the decoded tile payload before reconstruction. Keep the byte-identical shard payload, its CRC, SHA, and ETag.
- **Viewer:** opt in with `?m2a=1&region=twente-pilot`. Maintain 1,024 m tiles with a 512 m preload / 1,024 m physical retention policy; resize ground plane to actual pack bounds; widen the regional camera zoom range without restricting deep zoom; reposition the directional shadow light around the camera's local ground target (same-size 3 km shadow frustum).
- Reuse streaming worker, tile cancellation, commit budget, material registry, raycasting and theme switching. No gameplay or new LOD tiers.

## Critical Fidelity Risk

The pilot deliberately computes road/rail graph and planar preprocessing **independently per shard**. The extra context is a mitigation, **not** proof of global topology consistency. Crossing the 4 × 4 shard boundaries might reveal railway sleeper-phase discontinuities, road priority/seam differences, long landuse polygons or transitions whose defining context lies outside the 1 km query margin.

**Do not claim feature parity, seam equivalence or production-ready region-scale fidelity until tested.** The cheap mosaic verifier validates stored data/coordinate integrity; it does not compare cross-shard geometry. Human visual inspection and a targeted cross-shard E2+/R+ seam test are separate acceptance gates. If significant defects occur, implement shared/global graph context or bounded-context overlap reconciliation before scaling further.

## Work Items

- [x] Aligned pilot and shard-grid plan with strict manifest coverage/rebasing.
- [x] Bounded per-shard offline OSM ingestion and resumable bake CLI.
- [x] Lazy regional manifest and tile HTTP gateway.
- [x] Streamer regional-coordinate placement and full-area ground plane.
- [x] Regional opt-in viewer URL and camera-relative local directional shadow.
- [x] Pure mosaic grid/manifest mismatch tests.
- [x] Payload/metadata verifier for every shard/tile.
- [ ] Local `npm run lint`, new tests, `npm run build` all pass.
- [ ] Pilot dataset baked locally from the canonical Overijssel index.
- [ ] Entire 256-tile manifest and every payload verified.
- [ ] Targeted cross-shard road/rail/planar/portal continuity test and repair of any discovered defects.
- [ ] Human visual acceptance: move between Hengelo and Enschede, review seams, close-up rail phase, shadows, feature inspection and themes.
- [ ] Hardware performance check: panning (loaded tiles, memory, draw calls, FPS, frame spikes); do not promise 144 FPS at a 16 km whole-region overview without additional LOD.

## Run (Windows PowerShell)

From the `tkt-029-regional-mosaic-pilot` branch, with canonical Overijssel SQLite already available:

```powershell
npm run lint
npx tsx --test src/world/TilingRegionalMosaic.test.ts
npm run build
npm run osm:bake-regional-pilot
npm run osm:verify-regional-mosaic
npm run dev
```

Navigate to: `http://localhost:3000/?m2a=1&region=twente-pilot`

The output directory is `data/osm/twente-pilot-1024m/`, holding 16 independently baked SQLite files and a `mosaic.json` index. The bake resumes already verified shard packs by default; `--force` rebuilds them. The default parameters are intentionally fixed to a bounded pilot, rather than attempting full Twente untested.

For a **single-shard experimental probe**, use `npx tsx scripts/bake-regional-pilot.ts --max-shards=1`; this does **not** publish a complete mosaic and therefore cannot be viewed as a full region.

## Deferred Idea (Not In Scope)

Directional tile prefetch and masking of tile pop-in. The owner explicitly deprioritized it because current 1,024 m interactive performance is excellent and loading is fast enough. Reconsider only after the pilot demonstrates a practical need; preserve rendering responsiveness and memory.

## Status

Code prepared in a stacked draft PR based on the current TKT-028-F1 branch. **No canonical regional bake, full test-suite pass, or human visual approval is claimed.** Do not merge into production or present this as an accepted Twente release yet.
