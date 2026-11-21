---
id: TKT-028-F1
title: Fair Physical-Margin Validation of 512 m vs 1,024 m Streaming
type: experiment
status: in_progress
priority: high
created: 2026-11-21
updated: 2026-11-21
related_tickets:
  - TKT-028
---

# TKT-028-F1: Fair Physical-Margin Validation of 512 m vs 1,024 m Streaming

## Decision / Motivation

The project owner's canonical Hengelo RTX 4060 Ti benchmark (2026-11-21, 2 paired runs per tile size) verified that 1,024 m tiles reduce **far-overview draw calls from 2,900 to 1,224** (-57.8%) and **median frame interval from 23.05 to 15.75 ms**. However, the legacy tile-count margins unintentionally compare different physical policies:

| Tile width | Preload tiles / metres | Retain tiles / metres | Repeated-hop evictions |
|---|---|---|---:|
| 512 m | 1 / 512 m | 2 / 1,024 m | 186 |
| 1,024 m | 1 / 1,024 m | 2 / 2,048 m | **0** |

This means the existing 1,024 m run **did not test tile unload/reload behavior**. Keeping all 16 tiles resident artificially increases near-view memory and changes repeated-pan draw-call comparisons. Reducing tile count still improves far-zoom rendering, but we cannot adopt the new default on that evidence alone.

## Implementation Scope

1. Add opt-in `--match-physical-margins` to `benchmarks/tileStreamingRunner.ts`.
   - Default / legacy policy is unchanged.
   - Matched policy uses **512 m preload and 1,024 m retention for both tile widths**.
   - At 512 m: **1 preload tile, 2 retain tiles**.
   - At 1,024 m: **0.5 preload tile, 1 retain tile**. Fractional margins are valid because `TileStreamManager` expands an AABB in metres, not by integer tile rings.
2. Apply those numbers to the actual browser-side `loadM2aStreaming` invocation rather than only updating report labels.
3. Record physical margins in both per-mode JSON and paired Markdown/JSON. Warn explicitly when a matched-margins benchmark still produces no 1,024 m evictions.
4. Expand synthetic, deterministic lifecycle tests to validate CLI policy/default preservation, actual loading/eviction, settled geometry/BVH/mesh resource invariance over repeated NW↔SE hops, and cleanup.
5. Keep original 512 m production pack/default, separate 1,024 m pack, `OSMTILE1`, E2+/R+ fidelity, camera zoom limits, and feature inspection unchanged.
6. **No multi-LOD hierarchy or batching optimization** in this ticket.

## Acceptance Criteria

- [x] Opt-in matched margins wired into the actual benchmark streaming manager (default remains legacy).
- [x] Exact 512 m / 1,024 m margins reported for both variants, with fractional 1,024 m margin support.
- [x] New deterministic unit/integration assertions authored for repeated evictions, resource stability, and disposal.
- [x] Windows verification: 5/5 focused tests passed, `npm run lint` / `tsc --noEmit` passed, `npm run build` passed (Vite emitted only its existing native-loader warning).
- [x] Windows RTX 4060 Ti canonical 512 m vs 1,024 m comparison rerun with `--match-physical-margins`, `--runs=2`, `--require-hardware`; JSON/Markdown supplied by the project owner.
- [x] Confirmed active 1,024 m evictions and reloads: 38 repeated-hop evictions in **each** run, 7 settled tiles; stable 7-tile working set/geometry/BVH across six NW/SE cycles in both runs; p95/p99 frame timing, decode/commit, and memory recorded in canonical benchmark JSON.
- [ ] Project-owner visual check for continuity and loading during actual navigation.
- [ ] Project-owner accepts 512 m or 1,024 m as the production default (or requests follow-up).

## Windows Validation Feedback (2026-11-21)

The project owner ran the first validation pass:

- **5 tests:** 4 passed, 1 failed. The matched-margins CLI test and repeated-eviction/reload lifecycle test **passed**.
- **TypeScript:** 2 unrelated errors in the 1,024 m experiment implementation: nonexistent `seamReport.tileCount` and an update to `readonly boundaryOverlayResult`.
- **Vite build:** passed.
- **Follow-up fixes committed on this PR branch:** cross-platform CLI pack-path expectation, metadata-derived verifier tile count, mutable boundary overlay result field. Pending re-run of Node tests and `npm run lint`.

None of these findings imply a streaming performance or memory regression; they were test portability / type correctness issues and have been addressed without changing production tiling behavior.

## Matched-Margin Canonical Hardware Results (2026-11-21)

**Provenance:** Project owner, Windows + RTX 4060 Ti (ANGLE D3D11), Chromium 159, canonical 4,096 × 4,096 m Hengelo, two runs per tile width, 1× DPR 1440×900, 512 m physical preload / 1,024 m physical retention for both variants. Input: `benchmarks/results/tkt028-f1-matched-margins-hengelo.json` and corresponding Markdown generated locally, supplied in chat (not committed due to benchmark size).

| Scenario | 512 m calls | 1,024 m calls | 512 m median frame | 1,024 m median frame |
|---|---:|---:|---:|---:|
| Close-up | 848 | 523 (-38.3%) | 16.80 ms | 16.65 ms |
| Medium | 1,104 | 727 (-34.1%) | 16.23 ms | 15.85 ms |
| Far overview | 2,900 | 1,224 (-57.8%) | 19.60 ms | 16.38 ms |
| Continuous pan | 720 | 456 (-36.7%) | 17.08 ms | 16.95 ms |
| Repeated NW↔SE | 349 | 225 (-35.7%) | 16.40 ms | 16.60 ms |

- **Actual streaming:** Repeated NW↔SE hops evicted **186–187** 512 m tiles versus **38** 1,024 m tiles per run (different number of reloadable tiles, not a normalized eviction rate). The 1,024 m layout went from the original **0 evictions** to **38** under matched margins.
- **Memory trade-off:** settled SE repeated-pan geometry buffers **48.296 MiB** at 512 m versus **76.497 MiB** at 1,024 m (+58%); BVH **6.427 MiB** versus **10.736 MiB** (+67%). Close-up at study center retained all 16 larger tiles (137.53 MiB geometry) versus 36 small tiles (106.945 MiB): the finite 4×4 study area and intersecting retention AABB still drive a larger near-view working set.
- **Decode:** repeated-pan median tile decode times: **11.6/13.5 ms** (512 m) vs **39.85/22.5 ms** (1,024 m), for runs 1/2 respectively. Larger payloads are slower per tile; tile count is lower.
- **Jank variability:** repeated-pan p95 frame interval 512 m **27.33/25.72 ms**, 1,024 m **32.03/24.00 ms** (run 1/run 2). Run 1 1,024 m had five frames above 33.3 ms, versus one at 512 m; run 2 had zero versus two. This is not strong enough evidence of a persistent regression, but human navigation QA matters.
- **Reference variability:** far-overview medians varied between runs (512 m: **22.65 / 16.55 ms**; 1,024 m: **15.60 / 17.15 ms**). The aggregate favors 1,024 m, but a two-run sample should not be treated as a guaranteed 16.4% speedup on every run. Draw-call reduction is deterministic and more robust.

### Initial-Cycle Resource-Check Interpretation

The existing browser benchmark's `cleanResourceStabilizationVerified` is **false for 512 m** and **true for 1,024 m** in both runs. Inspection of every raw hop reveals why:

- At 512 m, the **first** NW visit has **20 loaded tiles / 43.97 MiB geometry**, while every later NW visit has exactly **19 loaded tiles / 40.30 MiB**. All SE visits have exactly **19 loaded tiles / 48.296 MiB**. BVH bytes show the same stable pattern after the first NW.
- At 1,024 m all six NW visits retain exactly **7 tiles / 70.99 MiB**, and all six SE visits exactly **7 tiles / 76.497 MiB**.
- The raw validator compares the *first* NW to the *final* NW, so a one-time settling change from the previous scenario is flagged as unequal. **This is not evidence of progressive resource growth or a leak.** Keep the recorded strict/raw result, but evaluate steady-state cycles independently; improve the checker in a narrowly scoped benchmarking follow-up if needed.
- Do not equate fluctuating V8 heap snapshots with leaks. Actual tile-owned geometry/BVH footprints and the Node lifecycle disposal tests give stronger evidence.

**Recommendation:** 1,024 m LOD0 is the preferred **candidate**, contingent on human visual inspection of real pan/zoom streaming and willingness to accept the measured close-up geometry-memory cost. No M3 LOD or new batching is justified by these results alone.

## Owner Visual Feedback — 2026-11-21

The project owner tested the 1,024 m matched-margin implementation interactively and reported **"a great improvement"** and **"buttery smooth 144fps"**. Tiles are still **visibly loading into view**, although the owner described their appearance as **"still really fast"**.

Interpretation: interactive responsiveness is positively accepted; **visible tile pop-in is a confirmed remaining polish issue**, not a claim of zero visual loading disruptions. This is an owner-reported observation rather than the hardware benchmark's measured median FPS. Do not claim that inspection, all themes, seam transitions, or long-distance traversal have received comprehensive visual sign-off unless separately confirmed.

Next action: keep 1,024 m as the preferred LOD0 candidate and investigate conservative, camera-direction-aware prefetch improvements without increasing far-view draw calls or changing geometry. Preserve the existing 512 m production default until the promotion decision.

## Visual QA on the Matched Policy

The normal URL `?m2a=1&tileSize=1024` still uses **legacy** 1/2-tile preload/retention and does **not** replicate the matched benchmark. An opt-in visual parameter now uses the **exact 512 m/1,024 m physical policy**, for either tile width:

- **512 m baseline:** `http://localhost:3000/?m2a=1&tileSize=512&matchPhysicalMargins=1`
- **1,024 m candidate:** `http://localhost:3000/?m2a=1&tileSize=1024&matchPhysicalMargins=1`

The streaming HUD displays effective preload/retention distances in metres. Pan from the northwest edge to the southeast edge and back at medium/close zoom, observing the **Evicted** counter (must increase), any gaps/pops/stutters, and the **Tile Mem** counter. Also compare far zoom, rail detail transition, feature inspector, and theme changes. This is human visual QA, not an LLM-judged visual test.

The query setting affects only startup when explicitly supplied; normal production defaults and tile packs are untouched.

## Reproduction (Windows PowerShell, repository root)

Both canonical SQLite packs must already exist; the 1,024 m pack was previously baked and verified.

```powershell
npx tsx benchmarks/tileStreamingRunner.ts `
  --dataset=canonical-hengelo `
  --compare-tile-sizes `
  --match-physical-margins `
  --runs=2 `
  --require-hardware `
  "--out=benchmarks/results/tkt028-f1-matched-margins-hengelo.json" `
  "--markdown-out=benchmarks/results/tkt028-f1-matched-margins-hengelo.md"
```

Synthetic fallback (clearly **not** hardware evidence):

```powershell
$env:DISABLE_OVERIJSSEL_BOOTSTRAP="1"
npx tsx --test src/world/Tiling1024Experiment.test.ts
npx tsx benchmarks/tileStreamingRunner.ts --dataset=synthetic-4096m --compare-tile-sizes --match-physical-margins --runs=1 --swiftshader --quick --eviction-hops=10 --out=benchmarks/results/tkt028-f1-matched-margins-synthetic.json
Remove-Item Env:DISABLE_OVERIJSSEL_BOOTSTRAP
```

## Decision Rule

Favor 1,024 m **only if** the draw-call and far-zoom gains persist with physically matched margins, repeated navigation truly evicts/reloads without stutter or uncontrolled working-set growth, and geometry/feature inspection remain valid. If close-up streaming suffers, consider alternative margins or targeted batching before introducing M3 coarse LOD.

**Status:** Engineering validation complete on canonical Windows hardware. The remaining acceptance gates are project-owner visual navigation QA and a separate decision whether to promote 1,024 m tiles to production. No production default has changed.
