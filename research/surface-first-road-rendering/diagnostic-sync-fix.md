# E2+ Fully Subtracted Source Diagnostics Fix — Isolated Branch

**Branch:** `fix/e2plus-full-subtraction-diagnostics` (not merged into `main`).

The `graph-surface` renderer already tracked per-provenance-segment fully subtracted events in `GraphRoadRenderStats.fullySubtractedCount`, and retained mixed edge/source/subsegment IDs in `fullySubtractedRoadIds`. It did not synchronize `ProcessedMapData.diagnostics.featuresFullySubtracted`.

This patch tracks only source IDs from E2+ fully occluded provenance subsegments. Once all road segments have been processed, it excludes any source IDs that still have visible output (`renderedSourceIds`), deduplicates and deterministically sorts the remaining IDs, and adds their count and up to ten samples to the diagnostics summary. Existing statistics and geometry output are unchanged; other renderer modes are untouched.

Tests extend the existing fully occluded footway fixture and add coverage for (a) multiple occluded subsegments sharing one source ID and (b) a partially visible source with one fully occluded segment.

**Verification:** Review and run `npx tsx --test src/world/SurfaceFirstRoadRendering.test.ts`, `npm test`, `npm run lint`, and `npm run build` after checking out this branch. This GitHub-connected environment cannot execute the repository's Node toolchain, so test execution is not claimed.

The H01 pinched-ring triangle overlap is deliberately outside this patch's scope.