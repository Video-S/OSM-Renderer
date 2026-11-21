---
id: TKT-030
title: Read-only OSM-derived mesh batching opportunity audit
type: research
status: implementation_ready_for_local_validation
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

## Acceptance gates

- [x] Read-only audit over OSMTILE1 SQLite packs and regional mosaics.
- [x] Per-layer, per-material, per-spatial-cell structural compatibility analysis.
- [x] Existing instancing excluded from new batching candidates.
- [x] Synthetic tests for matching state, feature references, spatial boundaries, tile isolation, and CLI.
- [x] Actual existing Hengelo hardware counts recorded for context (not confused with audit estimates).
- [ ] Local typecheck, synthetic tests and build pass.
- [ ] Canonical 1,024 m Hengelo SQLite data audited and reports reviewed.
- [ ] 512 m audit compared where useful.
- [ ] Optional regional sample and full 256-tile audit.
- [ ] Decision on whether an opt-in batched-pack implementation is warranted and which layers to tackle first.

## Future implementation decision (not part of this ticket)

If the audit reveals worthwhile opportunities, implement **offline, tile-local, material-aware, spatially bounded batching** using a new bake policy hash. Preserve scene order, raycast triangle-to-feature mapping, per-tile resource ownership, and rebuild BVH after combining geometry. Run canonical E2+/R+ acceptance tests and fair paired GPU tests before enabling it by default. Re-baking 512 m or 1,024 m tiles should use the same batching algorithm.
