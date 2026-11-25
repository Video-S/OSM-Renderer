# Current Project Status

> **Updated: 2026-11-25.** This page is the living summary of *current implementation and verified outcomes*. Ticket records retain their own statuses and acceptance gates. Historical milestone-by-milestone status text is preserved in [the 2026-11-22 status archive](history/status-before-regional-reconciliation-2026-11-22.md); earlier plans are not live status declarations.

## Product and current priorities

**Product today:** a browser-based, isometric 3D OpenStreetMap renderer and camera/navigation system, using React 19, TypeScript, Three.js, React Three Fiber and Node/Express. There is **no game** yet. The near-term goal is robust regional OSM visualization; a zombie game is a possible later product, not authorized current work.

**Priorities:** finish full-Twente LOD0 bake and owner validation (TKT-034); establish scalable road/rail/surface continuity and measured runtime behavior; consolidate documentation and technical debt before gameplay. LOD1–LOD3 and province-wide rendering remain future decisions.

## Implemented and accepted

| Area | Current implementation and evidence | Acceptance boundary |
| --- | --- | --- |
| Infrastructure renderer | **E2+ surface-first roads** (`roads: 'graph-surface'`) and **R+ surface-first railways** (`railways: 'graph-R+'`) are the **sole production** paths after TKT-026. Graph topology, grade transitions, materials, feature provenance and inspection are retained. | Owner accepted E2+/R+ on 2026-11-19. |
| Canonical source | Frozen Geofabrik Overijssel source snapshot `overijssel-261114-8ae28196`, with strict SHA/source identity and SQLite index validation (TKT-027). | Source/index integrity is distinct from road/rail visual correctness. |
| Baked tiles and streaming | `OSMTILE1` schema `1.1.0`, UTM `EPSG:25832` grid, offline SQLite baked packs, worker-based tile decoding, viewport streaming/eviction, shared materials and resource disposal (TKT-028). Local/live data continues to use its own rendering/projection path. | M1a/M1b and runtime M2-A accepted; full performance and LOD milestones remain distinct. |
| Regional pilot | **16 × 16** LOD0 tiles × **1,024 m** = 16.384 × 16.384 km, in **16 independently baked 4 × 4 shards**, owner-accepted TKT-033 candidate. | Owner visually checked previously missing-road locations **after confirming the active candidate mosaic**. This is not blanket cross-shard sign-off (TKT-032). |
| Mosaic identity and camera guard | `WorldPanel` and `DiagnosticsPanel` report identity/coverage strictly from the **actually loaded manifest**; server defaults to `data/osm/twente-pilot-1024m-tkt033-candidate/mosaic.json` when available. Larger regions default to `minZoom=0.15` with validated explicit `regionalMinZoom` overrides. | Owner smoke-tested zoom and identified the correct served bake. An override can still render costly LOD0 overviews. |
| Regional map workspace & offline search (`TKT-035`) | Three-region map-first workspace (`NavigationSidebar`, `Canvas`, `ContextSidebar` across `Search`, `Layers`, `Appearance`, `Inspector`, `Performance`, `Diagnostics`, `World`), floating `CameraToolbar`, direct regional startup, and local SQLite FTS5 search (`*.search.sqlite`, `/api/search*`) replacing `/api/geocode` and external Photon/Overpass UI presets. | Unit, HTTP, TypeScript, Vite build, and headless Playwright SwiftShader E2E passed on synthetic temp mosaic/SQLite; owner evaluation on live `overijssel-261114-8ae28196.sqlite` & Twente mosaics pending. |
| Runtime foliage LOD & culling (`TKT-036`) | Runtime-only zoom-dependent canopy prototypes (`lod0`/`lod1`/`lod2` with hysteresis), screen-space trunk suppression, shared 7-geometry `FoliagePrototypeRegistry`, conservative affine-AABB `InstancedMesh` frustum culling, `DiagnosticsPanel` / `PerformancePanel` controls & telemetry, and 5-variant `npm run bench:foliage` runner (`OSMTILE1` schema `1.1.0` unchanged; no rebake). | Unit, streaming/eviction, build, lint, and SwiftShader 5-variant Playwright evaluation passed on a synthetic 4×4 forest mosaic (`-75.0%` to `-93.4%` submitted foliage triangles across poses); hardware GPU timings and visual QA on Twente mosaics pending owner acceptance. |

Source: [architecture](architecture/overview.md), [ADRs 0011–0013](decisions/README.md), [TKT-028](../tickets/TKT-028-regional-tiling-streaming-lod.md), [TKT-029](../tickets/TKT-029-regional-mosaic-pilot.md), [TKT-033](../tickets/TKT-033-missing-road-rendering.md), [TKT-035](../tickets/TKT-035-regional-map-workspace-ui-overhaul.md), [TKT-036](../tickets/TKT-036-runtime-foliage-lod-rendering-optimization.md).

## In progress: Full Twente (TKT-034)

- **Footprint & dataset identity:** `twente-full-1024m`, **48 × 40** LOD0 tiles at **1,024 m** = **49.152 × 40.960 km**, **1,920 tiles**, **120 shards**, aligned `1:1` with the 16-shard pilot (`overijssel-261114-8ae28196`). The full grid is not an exact Twente administrative boundary; **422** planned tiles fall outside the Overijssel-only extract and **137** straddle its border (`311` baked tiles are empty). See [TKT-034](../tickets/TKT-034-full-twente-scale-out.md) and the [full-Twente baseline report](reports/tkt034-full-twente-baseline.md).
- **Completed:**
  - Owner executed the full resumable bake (`--preset=twente-full`), producing **120 shards / 1,920 tiles** (`118` baked + `2` reused from the `2026-11-22` `r05-c07`/`r05-c08` run), **648.28 MiB** SQLite disk footprint, **1,744.29 MiB** peak RSS in **1,754.4 s**.
  - Owner executed full integrity verification (`verify-regional-mosaic.ts`), passing **120 / 120 shards** and **1,920 / 1,920 tiles** (`1,609` non-empty, **642.22 MiB** compressed `OSMTILE1` payloads).
  - Owner loaded `data/osm/twente-full-1024m/mosaic.json` in the viewer and confirmed navigable exploration around **Hengelo, Almelo, Rijssen, and beyond**.
- **Still outstanding (keeps `TKT-034` `in_progress`):**
  - Formal cross-shard semantic/geometric continuity validation across the **218** shard interfaces and **99** junctions (`TKT-032` / `scripts/audit-regional-seams.ts`).
  - Comprehensive visual QA of roads, bridges, tunnels, railways, sleeper/ribbon phases, multipolygons, and coplanar decals across the full extent.
  - Hardware runtime performance, server startup latency, and LRU handle-pool characterization at 120-shard scale.
- Authoritative metrics, provenance boundaries, and safe non-destructive reproduction steps live in the [full-Twente baseline report](reports/tkt034-full-twente-baseline.md).

## Open questions and known risks

- **Cross-shard correctness (TKT-032):** 1,024 m context reduces but does not prove semantic continuity at 4 × 4 shard boundaries. Long road/rail/bridge/tunnel corridors, water/land-use relations and sleeper phases need targeted deterministic checks and owner visual confirmation. The known-road TKT-033 candidate passed owner inspection; ticket closure/status requires separate reconciliation.
- **Large overview cost (TKT-031):** full 16 km LOD0 overview measured roughly **7,373 draw calls and 42.6 ms GPU** on the owner's RTX 4060 Ti, while close views were materially lighter. Default zoom-out clamping is an **interim safety guard**, not LOD.
- **Full Twente server memory and file handles:** TKT-034 implements sequential shard manifest scanning and a bounded SQLite LRU open-handle pool; synthetic tests passed, but 120-shard startup and full-region navigation on the owner's PC remain unmeasured.
- **Source boundaries:** the Overijssel OSM source does not supply complete geometry outside its extract. Empty edge tiles are a data-coverage limitation, not necessarily a renderer defect.
- **No multi-LOD overview or game engine:** LOD1–LOD3, globally shared graph synthesis, navigation/pathfinding, agents, physics and gameplay are outside the currently implemented scope.

## Ticket and documentation truth

These are **ticket file statuses as currently recorded**, which may lag owner decisions and require explicit reconciliation; do not silently close them:

- `TKT-026`, `TKT-027`: **closed**.
- `TKT-028`, `TKT-028-F1`, `TKT-029`: **in_progress** despite implementation/owner acceptance of important subcomponents.
- `TKT-030`: `audit_executed_pending_report_review`; `TKT-031`: `implementation_in_progress`.
- `TKT-032`: **blocked**, broader cross-shard gate unfinished.
- `TKT-033`: `implementation_in_progress`, although owner accepted the corrected candidate at previously affected locations.
- `TKT-034`: **in_progress**, full 120-shard bake & structural verifier passed + initial owner exploration; seams, performance, and full visual acceptance remain open.
- `TKT-035`: **in_progress**, Regional Map Workspace UI & offline SQLite FTS5 search implemented and verified in sandbox (lint, build, 38 focused tests including headless Playwright E2E on synthetic data); owner visual & live-dataset review pending.
- `TKT-036`: **in_progress**, Runtime Foliage LOD, trunk suppression, shared prototype pooling, conservative frustum culling, UI controls/telemetry, and `npm run bench:foliage` implemented and verified in sandbox ([evaluation report](reports/tkt036-foliage-lod-optimization.md)); owner accepted visual results and recorded RTX 4060 Ti baseline (`-90%` triangles, flat frame time / 4,539 draw calls at `zoom 0.15`), motivating TKT-037.
- `TKT-037`: **closed**, Spatial Batching Feasibility & Performance Evaluation — owner consolidated `data/osm/twente-full-1024m-foliage-fix/mosaic.json` into `2,048 m` and `4,096 m` mosaics and ran RTX 4060 Ti benchmarking (`36.50 ms -> 4.00 ms` regional CPU render time at `4,096 m`); picking penalty on large foliage batches (`40.7 ms` street / `21.4 ms` regional) spun out to `TKT-038`.
- `TKT-038`: **in_progress**, Spatially Accelerated Instanced Feature Picking ([`ADR-0014`](decisions/ADR-0014-spatially-accelerated-instanced-feature-picking.md)) — mesh-local flat typed-array 3D instance AABB BVH (`InstancedSpatialIndex.ts`) with union LOD bounds, strict hierarchy visibility skipping, exact narrow-phase `Mesh.raycast`, developer toggle + diagnostics (`DiagnosticsPanel.tsx`, `?instancedPicking=...`), and multi-mosaic benchmark runner (`npm run bench:instanced-picking`) implemented and synthetically verified; owner RTX 4060 Ti benchmark and interactive QA on Twente mosaics pending.

Historic benchmarks, acceptance snapshots, proposals and investigation detail are retained in [the archived status](history/status-before-regional-reconciliation-2026-11-22.md), [regional proposal](plans/regional-tiling-streaming-lod-proposal.md) and [tickets](../tickets/). **Do not treat historical proposal wording as current runtime behavior.**

## Verification policy

Automated checks are valuable but separate from owner visual QA. The TKT-034 baseline remains recorded in [the full-Twente baseline report](reports/tkt034-full-twente-baseline.md). For TKT-035, automated sandbox checks verified `npm run lint`, `npm run build`, `OverijsselSearchIndex.test.ts`, and `WorkspaceUiAndSearch.test.ts` (Playwright SwiftShader against a temporary baked mosaic and SQLite search DB); live `overijssel-261114-8ae28196.sqlite` search indexing and hardware visual QA belong to the owner. For TKT-036, automated sandbox checks verified `FoliageLodOptimization.test.ts`, tiling/workspace regressions, `npm run lint`, `npm run build`, and a 5-variant SwiftShader Playwright evaluation on a synthetic 4×4 forest mosaic ([TKT-036 report](reports/tkt036-foliage-lod-optimization.md)); hardware GPU measurements on Twente confirmed `-90%` triangle reduction with nearly flat frame time. For TKT-037, owner local consolidation and RTX 4060 Ti benchmarking on Twente confirmed regional CPU render time improvement (`36.50 ms -> 4.00 ms` at `4,096 m`), closing `TKT-037` ([TKT-037 report](reports/tkt037-spatial-batching-feasibility.md)). For TKT-038, automated sandbox checks verified `InstancedSpatialPicking.test.ts`, tiling/foliage/BVH regressions, `npm run lint`, `npm run build`, and an end-to-end SwiftShader Playwright evaluation of `benchmarks/instancedPickingRunner.ts` on a synthetic 4×4 `1,024 m -> 2,048 m -> 4,096 m` mosaic set ([TKT-038 report](reports/tkt038-instanced-feature-picking.md)); hardware GPU picking benchmarking and interactive QA on Twente mosaics belong to the owner.

For code changes run `npm test`, `npm run lint`, `npm run build`; run `npm run docs:api` when exported TypeScript API documentation changes. See [testing and diagnostics](guides/testing-and-diagnostics.md).
