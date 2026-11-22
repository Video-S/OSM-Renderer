# Current Project Status

> **Updated: 2026-11-22.** This page is the living summary of *current implementation and verified outcomes*. Ticket records retain their own statuses and acceptance gates. Historical milestone-by-milestone status text is preserved in [the 2026-11-22 status archive](history/status-before-regional-reconciliation-2026-11-22.md); earlier plans are not live status declarations.

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
| Mosaic identity and camera guard | Developer Tools reports identity from the **actually loaded manifest**; server defaults to `data/osm/twente-pilot-1024m-tkt033-candidate/mosaic.json` when available. Larger regions default to `minZoom=0.15` with validated explicit `regionalMinZoom` overrides. | Owner smoke-tested zoom and identified the correct served bake. An override can still render costly LOD0 overviews. |

Source: [architecture](architecture/overview.md), [ADRs 0011–0013](decisions/README.md), [TKT-028](../tickets/TKT-028-regional-tiling-streaming-lod.md), [TKT-029](../tickets/TKT-029-regional-mosaic-pilot.md), [TKT-033](../tickets/TKT-033-missing-road-rendering.md).

## In progress: Full Twente (TKT-034)

- **Planned rectangular footprint:** 48 × 40 tiles at 1,024 m = **49.152 × 40.960 km**, **1,920 tiles**, **120 shards**. The full grid is not an exact Twente administrative boundary.
- **Source coverage limitation:** 422 planned tiles fall entirely outside the **Overijssel-only extract**; 137 intersect its border. These will not contain complete German/Gelderland surroundings. See [TKT-034](../tickets/TKT-034-full-twente-scale-out.md) for the footprint audit.
- **Owner's measured partial bake (2026-11-22):** `r05-c07` and `r05-c08`, both 4 × 4 shards, finished in **70.6 s + 22.0 s**, total **92.7 s**; observed peak process **RSS 1,422.11 MiB**, combined SQLite **34.50 MiB**. Partial verifier confirmed **2/120 shards and 32/32 tiles** (all 32 non-empty), **34.37 MiB** compressed. These are measurements, **not extrapolated full-Twente results**.
- **Full bake status:** owner initiated/approved proceeding with the resumable full bake; **no completed 120-shard result or full verification has been supplied at the time of this update**. Do not claim full Twente is rendered, seamless or accepted until full verification, targeted seams, camera navigation and owner visual inspection.
- Current experimental CLI supports `--preset=twente-full`, `--shards=...`, `--dry-run` and `--recover-corrupt`. Complete bake and verification instructions live in [TKT-034](../tickets/TKT-034-full-twente-scale-out.md).

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
- `TKT-034`: **in_progress**, awaiting full bake/QA.

Historic benchmarks, acceptance snapshots, proposals and investigation detail are retained in [the archived status](history/status-before-regional-reconciliation-2026-11-22.md), [regional proposal](plans/regional-tiling-streaming-lod-proposal.md) and [tickets](../tickets/). **Do not treat historical proposal wording as current runtime behavior.**

## Verification policy

Automated checks are valuable but separate from owner visual QA. The TKT-034 implementation handoff reported **32 focused tests passed, TypeScript/lint passed and Vite build passed** in Gemini's environment. The owner's independent local **two-shard bake + verifier passed** with the results above. This documentation-only reconciliation **does not claim that test/build commands were re-run**.

For code changes run `npm test`, `npm run lint`, `npm run build`; run `npm run docs:api` when exported TypeScript API documentation changes. See [testing and diagnostics](guides/testing-and-diagnostics.md).
