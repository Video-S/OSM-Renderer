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

## Full JSON/Markdown triage and probe calibration (2026-11-22)

Owner provided the complete generated `tkt032-seam-audit.json` (schema v1, 4,404 crossing events, 24/24 shard interfaces, 9/9 four-way corners, four same-shard controls) and Markdown. All 16 original packs still passed integrity. Exact **per-event** classifications:

| Reason | Cross-shard (4,240 events) | Same-shard control (164 events) | Total |
|---|---:|---:|---:|
| No review | 1,476 | 44 | 1,520 |
| Polygon/line inset source-surface asymmetry | 2,645 | 118 | **2,763** |
| One-sided emitted feature ID | 55 | 0 | **55** |
| Source feature ID absent from both emitted sides | 64 | 2 | **66** |
| Layer/bridge/tunnel metadata disagreement | 0 | 0 | **0** |

**Critical false-positive explanation**: 2,618/2,763 (94.8%) surface-asymmetry warnings are landuse polygon crossings; 125 are water, only 20 road. The old probe tests 25 cm on both sides of an **OSM polygon boundary** intersecting the shard line, so one side being within the polygon and the other outside can be perfectly correct. Same-shard control landuse warnings (116/123 source crossings) reinforce this calibration error. A source-attributed polygon on just one side must **not** be construed as a terrain hole without checking which side the original polygon covers. Roughly 1,150/1,206 cross-shard road crossings had no review, but this is not a network connectivity proof.

**Road/railway and semantic priorities**:

- **55 one-sided emitted-ID crossing events** (43 distinct original `way/` IDs): **35 road events from 34 distinct OSM ways**, 20 landuse events; **none among the four ordinary tile-seam controls**. The real sample is larger and not directly comparable in frequency to four controls, but the road cases warrant focused investigation. Initial examples: `way/44844082` (UTM 348591.719, 5794816, `horizontal-r0-1-c0`, only-B); `way/51932698` (357376, 5798521.137, `vertical-r0-c2-3`, only-B); `way/6655700` (353280, 5786626.158, `vertical-r2-c1-2`, only-B; also crosses an adjacent horizontal shard border). **An emitted ID somewhere in a tile is not proof of coverage at the seam**; missing IDs likewise may reflect graph chaining/source attribution rather than missing roads.
- All **24 detected cross-shard railway source crossings** have IDs emitted on both sides, and **zero observed layer/bridge/tunnel metadata disagreements** across categories. Railway sleepers were counted near crossings but their 3D phase, geometry, turnout matching and hidden underground behavior were **not** compared.
- **66 absent-both crossing events**: 52 water, 13 landuse, **one road** (`way/6661112`, UTM 357376, 5791095.095, `vertical-r1-c2-3`). **40** missing events reference OSM relations; **36/40** have a different emitted source feature of the *same category at the same crossing coordinate* (within ~0.2 m), strongly suggesting alternate way/relation ownership for many cases. This is not yet proof of equivalent render geometry. Several absent `way/` water crossings are tagged `layer=-1` and `tunnel=culvert`, so *hidden subterranean policy* is a plausible intentional omission needing deliberate validation; never force-render negative-layer geometry just to silence the audit.
- Raw `source-crossings` count includes multiple crossings per feature, and an OSM relation can share geometry with member ways. **Do not treat warning counts as unique broken features.**

### Audit calibration implemented (schema v2; rerun required)

`RegionalSeamAudit.ts` now records each source polygon's expected **A/B interior membership** at precisely the same ±0.25 m positions as the decoded triangle probes. `audit-regional-seams.ts` evaluates polygon-emission mismatches **against source interior**, instead of flagging any legitimate one-sided polygon boundary as `surface-coverage-asymmetry`. The result is a more specific `source-polygon-coverage-mismatch` candidate, still **not** automatic proof of a bug because landuse/ground-cover ownership and portal policies may intentionally override raw OSM polygon occupancy. Ordinary road line probes retain their symmetric-coverage diagnostics. Reason labels are now separated in console output; JSON schema incremented to v2, with explicit expected polygon membership and mismatch counts. Synthetic source-polygon tests include diagonal ring crossings in both orientations, negative expected mismatches, and source polygon holes.

After pulling latest PR #8 branch, rerun the unchanged canonical data through:

```powershell
git pull --ff-only
npx tsx --test src/world/TilingRegionalMosaic.test.ts src/world/TilingRegionalSeams.test.ts
npx tsx scripts/audit-regional-seams.ts --out=benchmarks/results/tkt032-seam-audit-v2.json --markdown-out=benchmarks/results/tkt032-seam-audit-v2.md
```

Then investigate selected **one-sided road** cases with the canonical source and decoded adjacent meshes/graph identities. Do not change baker logic or sign off TKT-029 before classifying real geometry and sleeper-phase continuity.

## Owner schema-v2 complete audit — console results (2026-11-22)

Owner pulled `8b6a0bd` and reran the read-only `scripts/audit-regional-seams.ts` against the **unchanged, verified** real Twente mosaic: all **16 packs / 256 non-empty tiles**, 235.68 MiB compressed, passed. All **24 internal shard interfaces, 9 four-way junctions and 4 same-shard controls** were covered. No bake, tile, renderer or OSM source mutation occurred.

The counts below are recomputed by summing the owner's full **console output**, not by inspecting a v2 JSON file (which has not yet been supplied):

| Review class | Shard interfaces (4,240 crossing events) | Same-shard controls (164 crossing events) | All 4,404 events |
|---|---:|---:|---:|
| `source-polygon-coverage-mismatch` | 161 | 2 | **163** |
| `asymmetric-geometry-attribution` | 55 | 0 | **55** |
| `source-missing-output` | 64 | 2 | **66** |
| `surface-coverage-asymmetry` | 14 | 0 | **14** |
| **Total review events** | **294** | **4** | **298** |

Old v1 review events: `2,763` naive surface + `55` one-sided + `66` absent = **2,884** (120 of these in four same-shard controls). Calibrated v2: **298**, or **89.7% fewer**; ordinary controls fell **120→4**. This validates that the earlier broad surface-asymmetry classification was misleading. It does **not** establish all polygons render correctly: 163 mismatches against raw source-polygon interior remain and can be caused by semantic ownership/overrides or true omissions.

The **55 one-sided attribution** and **66 absent-both** event counts did not change, as expected from a polygon-probe-only correction. The **14 nonpolygon surface warnings** are concentrated on shard boundaries and deserve specific source/mesh examination. These are *crossing events*, not unique broken features.

**Next data required:** owner-generated `benchmarks/results/tkt032-seam-audit-v2.json` (Markdown optional) to inspect all **163** polygon expected-vs-emitted coverage pairs, **14** other surface witnesses, **55** attribution cases, and **66** absent-both cases. Prioritize road/rail/negative-layer semantics and source-backed ownership. Deduplicate by source ID, crossing location and feature category. Do not use aggregate warning counts as a go/no-go criterion or modify baker data without a failing narrowed reproduction. Human visual acceptance and railway sleeper/graph continuity are still pending; TKT-029 **not signed off**.

## Owner v2 JSON — source-backed residual analysis (2026-11-22)

**Inputs reviewed:** complete owner-uploaded `tkt032-seam-audit-v2.json` (schema v2, 4.285 MB) and Markdown. This supersedes inferences from the console alone; no canonical SQLite packs or original source index were available to this analysis. All figures below are derived from the supplied JSON. The current auditor is **source-to-emitted-feature triage**, not proof of tile/shard continuity.

### Exact distribution and impact

- **4,404 source crossing events:** 1,241 road, 24 rail, 285 water, 2,854 landuse. 4,106 have no `review`; 298 have a review reason. The 298 review events may contain repeat intersections of the same source way.
- **35 one-sided road attribution events represent 34 different source way IDs** (one way crosses two nearby shard boundaries). Another **20 one-sided attribution events are landuse**. A feature ID being present in a tile indicates emitted geometry exists *somewhere in the tile*, not at the border.
- **14 source-attributed road surface coverage asymmetries represent 13 different roads**. All 14 have matching source feature identities emitted on both sides and an actual decoded triangle sample covering the point on **exactly one** side. The covered triangles were at `+0.05 m`; the other side's sample was uncovered. These are the strongest directly measured road-surface leads, but could still be due to winding centerlines, offsets, clipping, alternate ownership, and/or sample placement.
- **One road source ID absent from both sides:** `way/6661112`, at global UTM **(357376, 5791095.095)**, `vertical-r1-c2-3`, between `0:348:5655` and `0:349:5655`. This does not yet establish whether *other* road triangles cover its source crossing.
- **24 railway crossing events, 24 matching emitted source IDs both sides**; all have nonzero recorded nearby sleeper-box counts, but no sleeper position/spacing/phase, hidden/tunnel portal or switch continuity comparison has been performed.
- **Zero layer/bridge/tunnel metadata disagreements; zero >0.75 m sampled surface height-step candidates**. This is a useful negative result but does not verify all bridge/tunnel geometry or underground rendering.
- **66 absent-both events** consist of 40 water relations, 12 water ways, 13 landuse ways and one road. 14 events explicitly have `sourceLayer=-1`; eight have `sourceTunnel=culvert` (not necessarily disjoint). This supports checking intentional underground-hiding and way/relation identity before any proposed bake fix.

### Polygon ownership diagnosis

**163 `source-polygon-coverage-mismatch` events represent 125 distinct IDs**. At both 25 cm inset probes their observed source-attributed statuses are:

| Source expected vs. emitted | Events |
|---|---:|
| Source expects one side, emitted source ID covers **neither** side | **148** |
| Source expects one side, emitted source ID covers **both** sides | **9** |
| One sample `unattributed` and the other uncovered | **4** |
| Inverted one-side coverage | **2** |

For **68 of these 163 events**, at least one *other* source-attributed feature at the **same seam interface and within 0.25 m** of the crossing has a sampled emitted surface covering the side which the first polygon's source expects: **47 water**, **21 landuse**. This is evidence for semantic ownership / overlapping source features in a significant subset, **not** proof that the actual rendered world is gap-free (mesh layer, render visibility, elevation and override policy still matter). The first v1 near-total warning volume was misleading; v2 is more selective, but still compares raw source polygon identity to intentionally resolved semantic ownership.

### Targeted road investigations — do not rebake yet

Choose a deliberately varied set, not a random 55-way visual tour:

| Priority and hypothesis | Source and UTM coordinate | Where to reproduce |
|---|---|---|
| **P1: missing road ID both tiles** — verify original `highway` tag/support, locate all `roads` mesh triangles and their owners | `way/6661112`; **357376 / 5791095.095** | `vertical-r1-c2-3`; `0:348:5655` vs `0:349:5655` |
| **P1: measured two-sided road sample mismatch, repeated for same ID** — determine true road coverage/width vs 25 cm point | `way/971925458`; **353280 / 5792169.591** and **353280 / 5792209.889** | `vertical-r1-c1-2`; `0:344:5656` vs `0:345:5656` |
| **P1: crossed two shard interfaces near four-way corner** — possible special corner, topology, or provenance | `way/6655700`; **353280 / 5786626.158** and **353278.783 / 5786624** | `vertical-r2-c1-2` and `horizontal-r2-3-c1` |
| **P2: one-sided source ID not near any other recorded source crossing (~66m)** — assess whether cross-shard graph/way provenance changed | `way/51932698`; **357376 / 5798521.137** | `vertical-r0-c2-3`; `0:348:5662` vs `0:349:5662` |
| **P2: another road crosses within 0.51m** — test alternate attribution / parallel road | `way/285573560`; **353238.613 / 5790720** | `horizontal-r1-2-c1`; `0:344:5655` vs `0:344:5654` |

**Recommended next scoped diagnostic**: On only these adjacent tile pairs, interrogate the original source tags and decoded `roads` layer **regardless of feature ID**, sampling small spatial offsets on each side of the seam; report actual road-triangle coverage, emitted owners/face ranges, elevations and expected OSM centerline trajectory. This is the key missing evidence distinguishing a discontinuity from alternative attribution. Include within-shard controls. No general-purpose rendering changes or another 256-tile bake without a proven reproduction.

Only after road diagnosis should we interpret raw source polygon mismatches via the renderer's semantic ownership/picking behavior and address railway ribbon vs 3D sleeper-phase / junction parity. Human visual QA belongs to the owner, not LLM automation. TKT-029 remains open.

## Owner's full v2 JSON analysis and physical road diagnosis (2026-11-22)

Owner provided `tkt032-seam-audit-v2.json` (**4,404 events**, canonical snapshot `overijssel-261114-8ae28196`), plus Markdown. Independently inspected the full structured record rather than relying on console aggregates. All **24 cross-shard side interfaces, 9 four-way junctions and 4 same-shard controls** covered.

**Detailed classification:**

- **55** one-sided feature-ID events = **35 roads (34 distinct `way/` IDs)** and **20 landuse events (9 distinct IDs)**. **None occurred in same-shard controls.** 30 `only-a`, 25 `only-b`. These measure metadata attached to emitted geometry *somewhere in each tile*, not physical road presence at crossing. Asymmetric road examples: `way/44844082` at UTM (348591.719, 5794816); `way/51932698` at (357376, 5798521.137); `way/6655700` crosses two shard interfaces within metres of the (353280, 5786624) four-way junction.
- **66** source-ID absent-both events, **38 distinct source IDs** (52 water, 13 landuse, **1 road**: `way/6661112`, UTM 357376 / 5791095.095). 40 of these events are relations; previous spatial matching observed alternate same-category features at many exact points. Missing source ID does not automatically imply omitted geometry.
- **163** source-polygon expected/interior coverage warnings, **125 distinct landuse features**. **152** samples have `uncovered/uncovered` despite polygon geometry expecting one-sided coverage; **9** `covered/covered`, **2** reversed side. Many can be explained by semantic ground ownership, incomplete ring/context processing, or a local probe near a clipped boundary. The current source polygon vs same-feature render mismatch does not prove a visible hole; any source-independent coverage probe must respect surface ownership.
- **14** nonpolygon source-attributed road surface asymmetry events (**13 distinct ways**), all cross-shard, no same-shard controls. They have emitted attribution in *both* tiles but the 25 cm inset samples are `covered/uncovered` or `uncovered/covered`. Their covered surface height is consistently +0.05 m; the uncovered side often finds nearby candidate triangles but no containing face. Examples: `way/434725829` (348413.445 / 5794816), `way/737394825` (351797.163 / 5794816), `way/971925458` has two crossings on `vertical-r1-c1-2`.
- **Important previously unreported blind spot:** there are **37 nonpolygon road events** (**35 distinct way IDs**) where both emitted tiles attribute the source, but **neither** 25 cm source-attributed inset probe is covered; v2 reports `review=none` since it only detects one-sided difference. Also **6 polygon-road events** had expected correct one-sided polygon-interior coverage and should **not** be conflated with the 14 warnings. Of **1,205 both-attributed road crossings**, 1,148 have two covered source-attributed road probes, 14 have a flagged one-sided absence, 37 are uncovered on both, and 6 polygon-way cases have correctly expected one-sided geometry.
- **24 railway crossing events** have source IDs on both adjacent sides and nearby sleeper counts on both; the counts are not a phase/alignment test. **0** observed *cross-tile* layer, bridge or tunnel metadata disagreements and **0** height-step warnings. Only 19 crossing events in the source inventory have explicit `layer` tags, 2 have `bridge=yes`, and 8 `tunnel=culvert`. No claim that all negative-layer portals were actually checked or that source-vs-render metadata is equal in all cases.

**Code inspection and diagnosis:** `collectTileFeatureEvidence()` accepts a feature ID if present in *any* emitted mesh/face-range in the tile. `probeSourceSurfaceAtUtm()` checks only triangles attributed to that exact source way. `GeometryBuilder.ts` has distinct graph-road lineage/deduplication, clipped precomputed at-grade plans and grade-separated handling. Therefore: an ID discrepancy may reflect attribution rather than missing physical coverage; a same-ID absence at one point may conceal a geometry gap or another road surface rendered under a different ID. The current v2 report cannot discriminate those conditions.

### Targeted v3 instrumentation in this branch (source-independent road physical witness)

- Added **`probeAnyRoadSurfaceAtUtm()`** to `RegionalSeamAudit.ts`: geometrically tests *any* emitted road-layer triangle at the same 25 cm UTM point, regardless of source ID. This is deliberately a **second probe**; it cannot establish that the matching triangle belongs to the same road, is visible, or is graph-connected.
- For **suspicious nonpolygon road crossings only** (one-/no-side source attribution; either-side source surface gap; both-side source surface absence), `audit-regional-seams.ts` records the physical road coverage pair plus separately retained source-attribution classification. Metadata includes source `highway`, `landuse`, and `waterway` tags for semantic filtering. JSON schema bumped to **v3**; Markdown adds a physical-road triage table; totals separate road-physical one-sided, road-physical neither, and road-source uncovered-both counts.
- Existing canonical packs remain untouched. Synthetic regression tests explicitly demonstrate that another emitted road can cover a point even when the requested source ID is unavailable, and that an unrelated landuse layer must not count as road coverage.

**Owner follow-up** (after this PR's focused CI passes, no rebake):

```powershell
git pull --ff-only
npx tsx --test src/world/TilingRegionalMosaic.test.ts src/world/TilingRegionalSeams.test.ts
npx tsx scripts/audit-regional-seams.ts --out=benchmarks/results/tkt032-seam-audit-v3.json --markdown-out=benchmarks/results/tkt032-seam-audit-v3.md
```

Review v3 physical-road summaries **before** proposing any baker fix. Prioritize actual road-layer gaps, especially `way/6661112` and the ~14 original asymmetry cases, then refine geometry comparison using OSM line topology / bounded reference at any remaining suspects. Road connections, sleeper-phase and owner visual review remain open; this is **not** a TKT-029 pass.

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
