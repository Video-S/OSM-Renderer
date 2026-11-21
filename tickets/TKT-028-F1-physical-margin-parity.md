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
- [ ] Test suite / typecheck / build executed successfully in a dependency-equipped checkout.
- [ ] Windows RTX 4060 Ti paired canonical comparison rerun with physical margins matched.
- [ ] Confirm 1,024 m actually evicts and reloads tiles, and measure p95/p99 pan spikes, decode/commit latencies, geometry/BVH memory, draw calls, and far-overview frame time.
- [ ] Project-owner visual check for continuity and loading during actual navigation.
- [ ] Project-owner accepts 512 m or 1,024 m as the production default (or requests follow-up).

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

**Status:** Implementation prepared for review. Runtime / local GPU validation and production tile-size promotion are **not** claimed complete.
