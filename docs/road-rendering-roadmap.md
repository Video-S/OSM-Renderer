# Road Rendering: Future Plans and E2+ Validation Roadmap

**Updated:** 2026-11-09. **Preferred direction:** E2+ surface-first geometry. **Current status:** Visual success reported by project owner; production promotion not yet justified by systematic metrics.

This plan focuses on reliable **map rendering and camera use** before future gameplay or simulations. Rendering Hengelo/Twente at scale is the meaningful target. Stored, precomputed/baked geometry is acceptable if reproducible and queryable.

## Phase 0 — Preserve the successful baseline

- Record E2+ reference implementation commit [d2455b7](https://github.com/Video-S/OSM-Renderer/commit/d2455b7b8c711e689cabfc827b7f44ae2428b2ab). This is a **reference commit**, not a Git tag.
- Keep Graph (E2), Graph (E2+) and Legacy selectable, and keep the exact visualization fixtures/repro imports.
- Avoid unrelated junction logic changes until the new geometric baseline is characterized.

**Done when:** a future developer can reproduce the starting state and compare modes on the same source data and camera pose.

## Phase 1 — Characterize remaining visual defects

- Inspect a representative matrix: ordinary cross/T/Y, acute forks, clustered nodes, roundabouts and other loops, mixed path/cycleway/vehicle intersections, steps, width changes, boundaries, culverts, bridges and tunnels.
- Capture the actual OSM features and stable repro configurations for defects. Use coordinates/node IDs only for fixtures, not production conditionals.
- Report which mode performs better and whether any E2 behavior is still necessary.

**Done when:** remaining failure categories are explicitly named, documented and reproducible rather than described only as sporadic artifacts.

## Phase 2 — Quantitative geometry invariants

- For identical source edges, compare expected buffered coverage with emitted triangles; test for gaps, unexpected extensions, and positive-area overlaps.
- Audit upward winding/normals, degenerate triangles, class ownership and source-feature metadata through `faceRanges`.
- Exercise source segments partially/fully subtracted by higher priority roads; verify diagnostics and deduplicated lineage counts.
- Run `npm run lint`, `npm test` and the E2+ fixture test; establish new measured baselines and avoid changing expected outputs merely to force green tests.
- If useful, compare E2 versus E2+ without round disks versus current rounded E2+ to isolate the causal effect of junction elimination and of rounding.

**Done when:** the recorded invariants pass on representative fixtures and human visual inspection finds no major regressions.

## Phase 3 — Benchmark Hengelo to Twente

For each fixed extract, measure:

| Signal | Why it matters |
| --- | --- |
| Stage-6 road build duration, total scene build duration, p50/p95 across runs | CPU/latency and main-thread responsiveness |
| Peak memory and allocated mesh buffers | Browser stability |
| Rectangle/disk pieces, Boolean unions/differences, rejected/fallback segments | Algorithm scaling and robustness |
| Road triangles, retained geometry bytes and draw calls | WebGL cost |
| Area covered, unintended overlap and source attribution | Correctness during optimization |

Include small fixtures, neighborhoods, dense Hengelo extracts, then larger Twente tiles. Compare E2/E2+ under identical options. Agree performance thresholds **after collecting** representative measurements rather than inventing budgets now.

**Potential optimizations, only if data justify them:** index accepted footprints spatially; chunk by geographic tile with seam reconciliation; reuse/deduplicate repeated disks; optimize polygon simplification and unions; move geometry work to web workers; or bake/cache validated geometry offline. If results can be stored and queried, runtime re-computation is not inherently necessary.

## Phase 4 — Architecture hardening and migration

- Improve module separation: E2+ should own footprint construction and the surface-ownership phase without relying on confusing E2-only portal state.
- Preserve source IDs, graph topology, width policy, bridge/tunnel semantics, class styling, deterministic outcomes and inspection.
- Write tests to prove E2/Legacy remain unaffected while switching modes.
- Only with owner sign-off consider making E2+ the default; retain E2 as an opt-in fallback until migration is complete and edge-case evidence supports deletion.
- Update `ADR-0002` cross-references and generated API docs when public types change. Record any new implementation decision rather than silently rewriting history.

## Deferred, not part of the E2+ commitment

- Full graph-driven railway rendering and crossing behavior remain separate milestones.
- Broad gameplay, zombies, crowds, fluid/agent simulations and traffic/pathfinding are outside current road rendering scope.
- Optional Dutch BGT or other country-specific reference data should never be a mandatory runtime dependency. Preserve robust fallback when reference data are absent.
- A whole-Twente renderer may use cached/baked outputs; this is a later optimization, not a prerequisite to validate E2+.

## Decision gates

1. **Remain experimental:** owner visual judgment is favorable but key metrics or edge-case coverage remain unknown. This is the current state.
2. **Candidate for default:** core geometry tests and representative visual regression matrix pass, benchmarks are acceptable, and owner approves the transition.
3. **Remove old solver:** only after default migration is stable and no unique E2 fallback behavior remains justified.

### Documentation links

- [ADR-0010](./decisions/ADR-0010-surface-first-road-rendering.md)
- [E2+ architecture and geometry design](./e2-plus-surface-first-road-rendering.md)
- [Project history](./project-history.md)
- [Experimental research README](../research/surface-first-road-rendering/README.md)
