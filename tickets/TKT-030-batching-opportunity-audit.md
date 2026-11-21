---
id: TKT-030
title: Read-only OSM-derived mesh batching opportunity audit
type: research
status: audit_executed_pending_report_review
priority: high
created: 2026-11-21
updated: 2026-11-21
related_tickets:
  - TKT-028
  - TKT-029
---

# TKT-030 — OSM-Derived Batching Opportunity Audit

## Decision being investigated

Before implementing offline mesh batching, measure how much our actual baked OSM geometry can be grouped within each streaming tile, without changing tile sizes, renderer behavior, or source packs.

The goal is to understand **where mesh submissions come from**, **which material/render-state groups offer opportunities**, and **how much spatially bounded grouping costs relative to whole-tile grouping**.

This research does **not** implement batching. It deliberately retains the working OSMTILE1 packs, 1,024 m streaming default candidate, BVHs, feature inspection, and semantic surface rules unchanged.

## Existing empirical motivation

The owner's matched-margin 1,024 m Hengelo benchmark on RTX 4060 Ti measured:

- Far overview: **1,224 WebGL draw calls**, **844 frustum-visible meshes**.
- Frustum-visible meshes: **roads 210**, **parks 152**, **landuse 130**, **railways 123**, **foliage 94**, **buildings 75**, **other 60**.
- These are per-layer **mesh counts**, NOT per-layer draw-call counts. More than one GPU submission per mesh is possible (e.g. multiple material groups). The new audit measures the baked record structure, not actual per-layer driver submissions.
- This benchmark came from TKT-028-F1, before the regional pilot. No current 16 km GPU metrics are claimed.

## What the read-only audit computes

1. Stream each tile in a local **1,024 m or 512 m SQLite tile pack**, or each shard in a regional mosaic index, using the existing verified decoder. Do not rebake or write geometry.
2. Count tile-local source mesh records, one-or-more-material submission proxies, **already instanced** batches and their instance counts, triangles and OSM feature categories.
3. Identify **technical compatibility candidates**, matching:
   - Source streaming tile identity; no cross-tile merges.
   - OSM/rendered layer and **one identical material slot key**.
   - Exact render order, flags (including visibility, shadow, BVH, underground state) and vertex attribute/index layout.
   - No ground, railway zoom/chunk system, multi-material geometry, extra material groups, or semantic chunk parent.
4. Compare scenarios:
   - **Whole-tile unbounded**: compatible candidates may merge regardless of spatial extent within the tile, a deliberately aggressive upper bound.
   - **128 m / 256 m / 512 m cells**: existing mesh bounding boxes must be **wholly contained** in a cell. Crossing meshes remain unchanged. No clipping or new geometry is required for this *analysis*.
5. Report potential reduction in static mesh-submission proxies, grouping opportunities by layer/material and the most promising tiles. Count OSM features with bridge/tunnel/layer tags and high-risk layers as requiring further semantic review.
6. Export human-readable Markdown and JSON for future comparison.

## Interpretation: non-negotiable limitations

- **A candidate is not an approved or visually validated merge.** Two materials/render states may look compatible but depend on traversal order, stencil writes, local frustum culling, geometry transforms or shadow behavior.
- **Submission proxy is not measured WebGL draw calls**. The report covers all serialized mesh records, including currently hidden railway variants, while actual draw calls depend on runtime zoom, visibility, frustum, material groups and shadow rendering. The report separately identifies the serialized-visible proxy.
- **Material compatibility is necessary, not sufficient.** Roads, parks, water, landuse and buildings are flagged for semantic review; all batches need feature picking and E2+/R+ correctness regression tests.
- **No mesh splitting and no runtime geometry rebuilding** are performed. A mesh crossing a proposed cell is excluded from that bounded merge.
- **Already-instanced geometry is not double-counted** as possible static batching savings.
- OSM feature categories are **tile-local metadata record counts**, not counts of unique OSM features across the map.
- No FPS, frame-time, memory-usage, bake-time or GPU improvement is inferred from the proxy calculations.

## Run (Windows PowerShell, repository checkout)

After switching to branch tkt-030-batch-opportunity-audit:

    npm run lint
    npx tsx --test src/world/TilingBatchOpportunityAudit.test.ts
    npm run build

Analyze the existing **1,024 m canonical Hengelo tile pack** (default path comes from the existing tile pack resolver):

    npm run osm:audit-tile-batching

The audit writes:

- benchmarks/results/tkt030-batching-hengelo-1024m.json
- benchmarks/results/tkt030-batching-hengelo-1024m.md

For the **16 km regional mosaic** (if its bake has completed):

    npm run osm:audit-tile-batching -- --region-index=data/osm/twente-pilot-1024m/mosaic.json

For an alternative 512 m pack, specify the correct path and applicable cell sizes:

    npm run osm:audit-tile-batching -- --pack=data/osm/overijssel-tiles-261114-8ae28196.sqlite --cell-meters=128,256,512

For a quick regional probe, use --max-tiles=16. This is an **ordered sample, not a representative random sample**; full analysis is required for conclusions.

**Owner action:** Return the generated Markdown and JSON. We will inspect actual per-material candidates and compare whole-tile with bounded-cell savings before selecting any batching implementation. Keep the PR as a draft until test and data validation complete.

## First Windows Run and Fix (2026-11-21)

The project owner's first Windows run reached the audit CLI but **did not generate a dataset report**: `tsc --noEmit`, the focused Node test loader, and the audit command all stopped at a missing closing quote in `scripts/audit-tile-batching.ts:253`. Vite's production build still passed because it does not bundle this Node-side script.

The formatting syntax was corrected on the same branch, and a Markdown formatter regression test was added. **The corrected commit still requires local test/typecheck and actual SQLite execution**; no analysis results are claimed yet.

## Canonical Hengelo Audit — Owner Windows Results (2026-11-21)

After fixing the Markdown formatter, the owner reran the audit on Windows using Node.js v22.16.0:

- `npm run lint`: **passed** (`tsc --noEmit`, no diagnostics).
- Focused `npx tsx --test src/world/TilingBatchOpportunityAudit.test.ts`: **8/8 passed**.
- `npm run osm:audit-tile-batching`: **completed**, reading all **16** LOD0 tiles from `overijssel-tiles-261114-8ae28196-1024m.sqlite`.
- Reported **1,118 static mesh records**, **150 existing instanced batches**.
- **256 m bounded scenario: 3 theoretical fewer mesh submissions (0.2%)**.
- Generated `benchmarks/results/tkt030-batching-hengelo-1024m.json` and `.md` in the owner's local checkout; **their contents have not yet been supplied for review**.
- The rerun did **not** include `npm run build`; an earlier Vite build succeeded before the syntax fix, but the final branch build is not newly verified in this run.
- Node emitted an experimental SQLite API warning; tests and audit passed regardless.

**Preliminary decision:** The conservative 256 m cell approach alone offers negligible *structural submission* reduction on the Hengelo 1,024 m pack, so **do not implement it based on this result**. The complete Markdown/JSON reports are needed to compare 128/512 m and whole-tile profiles, inspect exclusions, material/feature hotspots, and separate existing batching from overly restrictive candidate rules. The 0.2% estimate is **not** measured WebGL draw-call or FPS improvement. No change to rendering or tile-size decisions is indicated.

## Code-Level Architecture Review: What the First Audit Missed

The first 0.2% result is **correct only for the audit's restricted question**: how much can be saved by merging *existing* meshes in the same source tile, with exactly matching rendering flags/material/attribute state, and contained wholly within the same 256 m cell? It is **not** an estimate of the possible global rendering optimization or even all possible batching opportunities.

### Already implemented during geometry generation

The source geometry pipeline already performs extensive merging before OSMTILE1 serialization:

| Source | Existing mechanism | Significance |
| --- | --- | --- |
| `src/world/GeometryBuilder.ts` `mergeWithFaceRanges()` | Combines geometry into one mesh while preserving per-feature triangle ranges | Existing roads, parks, landuse and barriers are already merged by semantic buckets |
| `GeometryBuilder.ts` road grouping | `roadsByClass` yields one merged mesh per class per build tile | The post-bake audit will rarely find another compatible road mesh of the same class within that same tile |
| `GeometryBuilder.ts` planar grouping | `landuseBySubtype`, `parksBySubtype` and merged water | Spatial cell-based post-merging cannot improve much on already grouped bucket meshes |
| `GeometryBuilder.ts` `mergeBuildingItemsByMaterial()` | Consolidates building faces into material-contiguous groups, preserving inspection metadata | Already avoids many material-group draws for individual buildings |
| `GeometryBuilder.ts` trees and `RailwayGeometryBuilder.ts` sleepers | Hardware instancing | No one-draw-per-tree/sleeper problem to solve |
| `RailwayGeometryBuilder.ts` `buildRailwayInfrastructure()` | Defaults to **128 m railway chunks** | These intentional meshes are deliberately excluded from the audit, but are plausible draw-call/culling tradeoffs |

See `src/world/GeometryBuilder.ts` around 775–1021, 2380–2409, 2804–2829, 3550–3607, 4097–4256 and 4589–4607; `src/world/infrastructure/railways/RailwayGeometryBuilder.ts` around 2298–2381 and 2954–2972.

### A more important draw-call accounting issue

`GeometryBuilder.ts` uses `drawCalls++` once for a newly built building bucket mesh, even though `mergeBuildingItemsByMaterial()` can put **multiple material groups** (roof/wall) inside that one mesh. The same estimate is serialized in the tile header and reused by `TileSceneReconstructor.ts` and `TileStreamManager.getDiagnostics().loadedDrawCallsEstimate`.

Thus **the builder's estimated draw calls are not necessarily real render submissions**. The main WebGL frame counter includes visibility, material groups and potentially additional render passes (e.g. shadows). The prior 1,224 WebGL calls and 844 frustum-visible meshes must not be naively compared or attributed by dividing the audit's 1,118 static records and 150 instanced batches.

The next instrumentation should attribute **actual** frame render work by layer, material group and pass, then compare with an exact serialized-visible *main-pass* estimator. A source-mesh count alone cannot prove what limits the frame.

### Genuine code-level opportunities

1. **Railway chunk-size A/B, not generic mesh merging.** Production currently hardcodes 128 m default railway chunks; 256/512 m tests could reduce batch count at city scale, but may increase overdraw/culling costs at street scale. This requires a new bake-policy identity and equivalent geometry/feature tests. Do not merge independent source tiles or remove rail zoom alternatives.
2. **Cull already-instanced foliage batches when offscreen.** `GeometryBuilder.ts` builds trunks/leaf canopies as `InstancedMesh` with `frustumCulled=false`, which is serialized and restored by `TileSceneReconstructor.ts`. The decoder already provides instance batch bounding boxes/spheres. Evaluate setting **per-batch** frustum culling true only once valid bounds are verified, with rotation, tiling overhang, shadows and hover tests. This does not provide per-tree culling, but is a low-risk candidate.
3. **Stop repeated streaming/zoom/diagnostic scans.** `TileStreamManager.updateFromCamera()` calls `updateViewport()` and `tick()` every frame; `updateViewport()`, `tick()` and `updateCameraZoom()` all traverse tile records in different ways. `ThemeMaterialRegistry.setCameraZoom()` does not early-return on unchanged zoom if railway controls are present. `MapScene.tsx` ordinary telemetry sorts frame samples and evaluates cached railway visibility every frame. This is CPU overhead; measure before claiming it causes far-zoom GPU degradation.
4. **Material/pass consolidation** is a different, higher-risk class of optimization. Shared colors/material slots for road classes, landuse subtypes and building wall/roof pairs could reduce per-tile draw groups, but render order, depth and stencil rules from E2+/R+ are hard constraints. It may require shader/vertex attribute changes, not merely buffer concatenation.
5. **Spatial culling granularity.** The already-merged per-class/per-subtype planar meshes may span an entire 1,024 m tile, so they are efficient in draw calls but coarse for sub-tile culling. Splitting them into 256 m chunks could **increase** calls at city overview while reducing vertex work at street zoom. This must be evaluated as a culling tradeoff, not mislabeled as batching savings.

### Decision revised

**Do not implement the naive post-bake 256 m merge pass** (3 hypothetical submissions / 0.2% on the existing 16-tile 1,024 m Hengelo pack). This does **not** mean no optimization remains, nor does it justify implementing untested larger railway chunks, foliage culling, changing tile sizes or switching materials now.

Prioritize a **render-work attribution diagnostic** and **specific isolated experiments** (railway chunk size, instanced tree batch culling, CPU work gating). Compare actual frame times and WebGL draw calls at street, city and regional overview at identical scene/camera positions; preserve inspectability, scene layering and visual parity. The user's full generated JSON/Markdown can improve category-specific prioritization, but the architectural conclusions above already follow from the repository source.

## Acceptance gates

- [x] Read-only audit over OSMTILE1 SQLite packs and regional mosaics.
- [x] Per-layer, per-material, per-spatial-cell structural compatibility analysis.
- [x] Existing instancing excluded from new batching candidates.
- [x] Synthetic tests for matching state, feature references, spatial boundaries, tile isolation, and CLI.
- [x] Actual existing Hengelo hardware counts recorded for context (not confused with audit estimates).
- [x] Local typecheck and 8/8 synthetic tests pass; latest Vite build not rerun after syntax fix.
- [x] Canonical 1,024 m Hengelo SQLite audit completed (16/16 LOD0 tiles).
- [ ] Generated detailed Markdown/JSON reports supplied and reviewed.
- [ ] 512 m audit compared where useful.
- [ ] Optional regional sample and full 256-tile audit.
- [ ] Decision on whether an opt-in batched-pack implementation is warranted and which layers to tackle first.

## Future implementation decision (not part of this ticket)

If the audit reveals worthwhile opportunities, implement **offline, tile-local, material-aware, spatially bounded batching** using a new bake policy hash. Preserve scene order, raycast triangle-to-feature mapping, per-tile resource ownership, and rebuild BVH after combining geometry. Run canonical E2+/R+ acceptance tests and fair paired GPU tests before enabling it by default. Re-baking 512 m or 1,024 m tiles should use the same batching algorithm.
