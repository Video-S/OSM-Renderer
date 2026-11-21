---
id: TKT-032
title: Cross-Shard Geometry and Topology Continuity Validation
type: correctness-validation
status: implementation_in_progress
priority: high
created: 2026-11-22
updated: 2026-11-22
related_tickets:
  - TKT-029
  - TKT-028-F1
  - TKT-031
---

# TKT-032 — Cross-Shard Geometry & Topology Continuity

## Goal

Close the outstanding **TKT-029 regional fidelity gate**: determine whether independently baked 4×4-tile shard packs form a semantically and geometrically continuous 16.384 km Hengelo–Enschede world; repair **proven** defects without destabilizing our accepted E2+/R+ renderer; establish a reusable validation method before considering an Overijssel-wide bake.

This is **not** a new renderer, LOD, camera, or performance effort. Do not assume seams are defective just because topology is computed per shard.

## Verified starting point and code

- Owner's canonical `data/osm/twente-pilot-1024m/mosaic.json` passed `npm run osm:verify-regional-mosaic`: 16 shard SQLite packs, 256 nonempty 1,024 m tiles, 235.68 MiB compressed. This establishes source/payload consistency, **not** render correctness.
- `src/world/tiling/RegionalMosaicPlan.ts`: 16×16 global tiles; independent 4×4-tile shards; 64 m collars and 1,024 m external query context. The 4×4 shard grid contains **24 internal side interfaces** (12 vertical, 12 horizontal), each 4,096 m long, and **9 internal four-shard junctions**. All are in scope.
- `scripts/bake-regional-pilot.ts` queries/preprocesses each shard independently through `bakeHengeloTilesFromStore()`. `src/server/tiles/OfflineHengeloTileBaker.ts` passes shard-specific infrastructure descriptors and precomputed global plans to per-tile `GeometryBuilder`. Context overlap mitigates but cannot establish graph/planar parity.
- `src/world/TilingRegionalMosaic.test.ts` checks grid alignment, coverage and manifest rebasing; `scripts/verify-regional-mosaic.ts` checks compressed payload hashes and binary identities. Neither compares connectivity, boundary surfaces or railway sleeper phase.
- Available read-only audit data: `TilePackSqliteStore.getTileDecoded()`; decoded mesh positions/material slots/flags/face ranges, instance batches and sleeper boxes, feature infos, UTM bounds and the composed manifest's rebased tile centers.

## Work A — Bounded, reproducible seam audit

1. Derive **all** 24 interfaces and 9 four-way junctions from `createRegionalMosaicPlan()` and the composed manifest, not hard-coded coordinates. Capture shard IDs, adjoining tile keys, global UTM seam geometry, orientation and a bounded inspection band. Include some **within-shard tile seams as control cases**.
2. Independently query the **immutable canonical Overijssel OSM SQLite** in each bounded band to enumerate roads/cycleways/footways, rails, switches, bridges, tunnels/portals, water, landuse/parks, and other relevant crossings. Retain source way/relation IDs and tags (including `layer`, `bridge`, `tunnel`). Do **not** discover crossings solely from baked meshes: missing features on *both sides* must be detectable.
3. Load only neighboring existing shard payloads via `TilePackSqliteStore`, validate canonical snapshot and policy, and transform decoded geometry into one common UTM/regional coordinate frame with manifest rebasing. Account for tile-relative offsets, overhang/collars and intended clipping. Release decoded buffers between boundaries; **never ingest/reconstruct all 256 detailed tiles simultaneously**.
4. Implement a read-only CLI, proposed `scripts/audit-regional-seams.ts`, with `--index=...`, `--out=...`, optionally `--boundary=...` / `--feature=...` to reproduce a failure. Export deterministic **JSON and Markdown** evidence under `benchmarks/results/`: source/projection/hash, all checked boundaries, candidate IDs, measurable differences, seriousness, reproduction coordinates, and explicit empty/no-crossing cases.
5. Don't overwrite, rebake or mutate the accepted SQLite packs or `mosaic.json` during auditing. Fail clearly when the canonical source index is unavailable rather than substituting made-up reference data.

## Work B — Test real semantic continuity

For each crossing, compare adjacent shard outputs in a bounded band. Where uncertain, build an **independent bounded seam-centered reference** from the same source OSM snapshot. Do **not** require identical triangle ordering or whole-region reference synthesis. Establish feature-specific tolerances based on actual geometry encoding/quantization rather than one arbitrary universal epsilon.

- **Roads, paths, cycleways and intersections:** correct connectivity, width/class/priority, surfaces/markings, no context-induced gap, duplicate overlap, or abrupt junction/cycleway change.
- **Rails:** continuous track alignments, parallel/turnout rules, rails/ballast visibility, accurate sleeper spacing/phase across shards in both ribbon and 3D close-up variants; detect unwanted reset, duplicate or missing sleepers using decoded boxes/instances and track identities. Real switches/termini are explicit exceptions based on OSM.
- **Bridges, tunnels, portals:** consistent vertical height and semantic `layer`/`bridge`/`tunnel` flags. Avoid false junctions where ways only cross in 2D; detect exposed negative-layer underground geometry, wrong portal placement and orphan entrances.
- **Planar ownership:** water, long landuse polygons, parks, parking/markings and road/cycleway ground cover must not exhibit context-dependent holes, duplicate fills, spurious z-fighting or sudden ownership/elevation changes.
- **Inspection/render metadata:** original OSM IDs, face ranges/instance attribution, material slots, render order and visibility agree across borders. Never "fix" continuity by replacing detailed geometry with uninspectable approximations.

Classify each failure by **source data, query/context, graph preprocessing, per-tile geometry/clipping, binary codec/rebasing, or scene reconstruction**. Log concrete evidence, not screenshots as automated proof.

## Work C — Deterministic tests and minimal corrections

1. Add `src/world/TilingRegionalSeams.test.ts` (proposed) with vertical, horizontal and four-way junction fixtures: straight/angled roads, parallel tracks/turnout and sleeper phase, a bridge across another way, a negative-layer tunnel/portal, and a long polygon extending beyond query context.
2. Include negative cases (legitimate OSM way termination, grade-separated crossing, intentionally clipped geometry) and **same-shard tile boundary controls** so ordinary clipping defects aren't incorrectly blamed on shard preprocessing.
3. Run the audit on the owner's existing pilot packs; make a prioritized defect register with exact shard pairs/UTM points/source IDs and minimal reproducible fixtures.
4. For **confirmed** issues, make a narrow, generalizable correction plus a failing-then-passing regression test. Prefer stable feature identity, anchored railway phase and bounded-context reconciliation when sufficient. If true cross-shard shared graph context is necessary, write a scoped design with memory limits rather than introducing full-region preprocessing ad hoc.
5. Rebake **only impacted shards**, into a **separate experimental output directory**. Do not use `--force` against the accepted canonical pack as a convenient test path. If a fix requires global schema/context migration, explicitly document scope and re-verification needs.

## Work D — Gates and deliverables

- **Automated coverage:** all 24 interfaces and 9 junctions checked on the real pilot, including crossing inventory from OSM independent of baked output. The report has **zero unexplained high-severity discrepancies**; lower-severity items and known source-data exceptions are enumerated with feature ID, location and justification. Failure/warning thresholds must be documented.
- **Regression commands:** `npm run osm:verify-regional-mosaic`, `npx tsx --test src/world/TilingRegionalMosaic.test.ts`, new targeted seam tests, relevant existing E2+/R+ road/rail/portal checks, `npm run lint` and `npm run build`. Provide exact actual commands and outcomes. Keep expensive regional audit opt-in, not implicitly part of every unrelated test.
- **Owner-only visual QA:** with `npm run dev` and `http://localhost:3000/?m2a=1&region=twente-pilot`, supply a small location/feature checklist covering crossings in both directions, rail sleeper alignment close/far, bridges and tunnels (negative layers), terrain/planar fills, picking, themes, shadow transitions, 9 shard junctions, and Hengelo–Enschede traversal. **No LLM visual testing or visual sign-off.**
- **Artifact:** reproducible JSON/Markdown seam report plus a decision section (passed, specific defects fixed, or blocked by a named architectural requirement); compare control seams. Local large artifacts need not be committed, but summary and test fixtures must be reviewable.
- **Sign-off:** TKT-029 regional continuity acceptance only after automated gate and the owner's human visual approval. An Overijssel-wide bake is a **separate future decision**, not the success criterion of TKT-032.

## Implementation progress — initial bounded audit (2026-11-22)

**This PR is the first correctness-audit implementation, not an accepted seam parity result.** No owner SQLite pack is available in GitHub CI; the 256-tile mosaic must be audited on the owner's Windows checkout. No renderer or baker behavior has been changed.

Current implementation:

- `src/world/tiling/RegionalSeamAudit.ts` enumerates all internal shard interfaces and four-way junctions without fixed coordinates, classifies source crossings, and measures emitted source-ID, `layer` / `bridge` / `tunnel` metadata. Includes conservative, source-attributed triangle coverage/height probes at ±0.25 m from a seam; ignores unrelated overlapping geometry.
- `scripts/audit-regional-seams.ts` queries the original canonical OSM spatial index near each boundary and separately loads only adjacent SQLite tile payloads. Reports both-sided/one-sided/absent-both attribution, metadata mismatches, local surface coverage/height candidates and railway sleeper proximity counts. Audits all 24 interfaces, 9 junctions and 4 same-shard tile controls, with optional filters. Writes reproducible JSON/Markdown; packs are read-only.
- `src/world/TilingRegionalSeams.test.ts` covers complete boundary/junction enumeration, road/rail crossings and tangential negative controls in both orientations, long polygons with no ring crossing, negative-layer tunnel metadata disagreement, emitted-vs-unused feature metadata, tile-center sleeper coordinate rebasing, and per-feature triangle probes. Existing regional layout tests added to CI together with these tests.

Run after pulling this branch, with the canonical Overijssel SQLite source index and the previously verified Twente mosaic already present:

```powershell
npm run lint
npx tsx --test src/world/TilingRegionalMosaic.test.ts src/world/TilingRegionalSeams.test.ts
npm run build
npx tsx scripts/audit-regional-seams.ts
```

Outputs:

- `benchmarks/results/tkt032-seam-audit.json`
- `benchmarks/results/tkt032-seam-audit.md`

For focused reproduction (invoke TSX directly because npm has consumed `--name=value` args on the owner's PowerShell/npm version):

```powershell
npx tsx scripts/audit-regional-seams.ts --boundary=vertical-r0-c0-1 --out=benchmarks/results/tkt032-focus.json --markdown-out=benchmarks/results/tkt032-focus.md
```

**What is NOT yet proven:** graph topology equivalence, complete road/polygon seam coverage, deterministic ribbon/3D sleeper phase, exact bridge/portal transitions, render-order/picking behavior and the owner's human visual QA. An emitted feature ID can exist in a tile even if its mesh ends away from the seam. Local coverage and height probes are *suspected discrepancy indicators*, not automatic pass/fail verdicts. Any identified candidates require a minimal source/geometry reproduction before fixing baking logic.

Do not mark TKT-029 continuity approved on the basis of this preliminary audit alone. Keep full-Overijssel baking deferred until the geometric/semantic findings are classified and the owner signs off.

## Owner's first full regional audit — preliminary result (2026-11-22)

Owner ran `npm run osm:audit-regional-seams` successfully against the canonical pilot. Every shard verified: **16 packs, 256 non-empty tiles, 235.68 MiB compressed**. The console confirms **24/24 shard interfaces, 9/9 four-way junctions, and four same-shard controls** processed. It reports **55 asymmetric feature attribution candidates** across the checked interfaces/controls; without the generated JSON, their feature/category/location distribution is still unknown.

**Crucial calibration finding:** 24 cross-shard sides contained 4,240 reported OSM crossing events with 2,764 generic "metadata candidates" (65.2%), while four *within-shard control seams* contained 164 crossing events with 120 candidates (73.2%). These figures count crossing events and heterogeneous `review != 'none'` reasons, **not unique defective OSM features**, and not necessarily actual metadata disagreements. The current script logs "metadata candidates" for source-missing-output, asymmetry, surface coverage/height warnings **and** real metadata differences. A higher flagged fraction in same-shard controls means the raw count is **not evidence of shard-specific geometry defects**.

**Next investigation (no baker changes yet):**
1. Obtain and classify the existing owner-generated `benchmarks/results/tkt032-seam-audit.json` and `.md`. Count each distinct review reason by interface vs same-shard controls; split out `neither` from `only-a/only-b`, geometry probe results and actual `layer/bridge/tunnel` disagreements. Deduplicate source features crossing a seam multiple times and distinguish unsupported features from absent supported ones.
2. Examine representative candidates with the original OSM geometry and emitted face ranges in both adjacent packs; establish whether candidate inflation comes from attribution/normalization, intentionally unsupported categories, tile clipping, or actual shard graph errors.
3. Tighten the audit's **specificity and presentation** using controls and regression fixtures before treating anything as a high-severity defect. Keep full geometry and sleeper-phase parity open.
4. Owner human visual checks remain separate. TKT-029 continuity **not approved**.

## Completion checklist

- [ ] Audit all 24 internal interfaces and 9 four-way junctions with bounded memory and provenance.
- [ ] Find expected OSM seam crossings independently of baked geometry and identify missing-on-both-sides failures.
- [ ] Compare road/path, rail/turnout/sleeper, portal/grade, planar ownership and feature picking semantics with justified tolerances.
- [ ] Deterministic edge/corner/same-shard controls pass; zero unexplained high-severity defects remain.
- [ ] Any corrections have regression tests and independent experimental shard bakes; canonical accepted packs stay safe.
- [ ] Canonical verifier, relevant E2+/R+ Node tests, lint and build pass.
- [ ] Owner completes and records human visual acceptance.
- [ ] TKT-029 correctness gate is explicitly signed off or left blocked with precise evidence.

## Hard non-goals

No province-wide bake, generic batching, detailed whole-region render optimization, offline LOD, strategic/map-on-map UI, camera limits, gameplay, new tile size, or broad redesign. Preserve the existing detailed renderer and its source-backed semantics.

**Principle:** Establish whether the world we already built is continuous before extending its geographic footprint.
