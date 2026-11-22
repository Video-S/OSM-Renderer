# E2+ Fully Subtracted Source Diagnostics Fix — Isolated Branch

**Development branch:** `fix/e2plus-full-subtraction-diagnostics` (integrated after the H01 pinched-ring geometry fix).

The `graph-surface` renderer already tracked per-provenance-segment fully subtracted events in `GraphRoadRenderStats.fullySubtractedCount`, and retained mixed edge/source/subsegment IDs in `fullySubtractedRoadIds`. It did not synchronize `ProcessedMapData.diagnostics.featuresFullySubtracted`.

This patch tracks only source IDs from E2+ fully occluded provenance subsegments. Once all road segments have been processed, it excludes any source IDs that still have visible output (`renderedSourceIds`), deduplicates and deterministically sorts the remaining IDs, and adds their count and up to ten samples to the diagnostics summary. Existing statistics and geometry output are unchanged; other renderer modes are untouched.

Tests extend the existing fully occluded footway fixture and add coverage for (a) multiple occluded subsegments sharing one source ID and (b) a partially visible source with one fully occluded segment.

**Post-integration verification:** Run `npx tsx --test src/world/SurfaceFirstRoadRendering.test.ts`, `npm test`, `npm run lint`, and `npm run build` on the integrated `main` branch. GitHub source comparisons were verified, but the Node test suite was not run by this assistant.

The H01 pinched-ring triangle overlap is deliberately outside this patch's scope.