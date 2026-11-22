---
id: TKT-033
title: Missing Road Geometry in Shared Road Renderer
type: correctness
status: implementation_in_progress
priority: backlog
created: 2026-11-22
updated: 2026-11-22
related_tickets:
  - TKT-032
  - TKT-029
---

# TKT-033 — Missing Road Geometry in Shared Road Renderer

## Status and decision

**Reopened by owner (2026-11-22).** Investigate and fix demonstrated shared road-renderer defects. Preserve the canonical bake while validating.

The owner visually checked the suspicious crossings identified during TKT-032 and confirmed that expected roads do **not** render at the inspected locations in the Twente regional viewer. The owner also recalls seeing roads disappear **before the tiled renderer existed**. This history points toward a possible shared road-generation problem, but does **not yet prove** these specific failures have the same cause as the older behavior.

Do **not** assume an individual shard boundary is responsible. Do **not** classify every v3 point-sample warning as a confirmed full-road gap. Preserve the verified canonical tile packs until a causal reproduction exists.

## Concrete evidence

- TKT-032's v3 read-only audit ran against the 16-shard/256-tile Twente pilot (OSM snapshot `overijssel-261114-8ae28196`), with all tile payloads passing integrity verification.
- Across 87 suspicious OSM road crossings probed for any road-layer triangle at two 25 cm insets: **53 both-sided**, **23 one-sided**, **11 neither-sided**. These are sample-level geometry witnesses, not complete geometric or topological verdicts.
- The owner manually inspected the **11 map locations** recommended from that report and reports expected roads missing in the 3D viewer. This is genuine human-observed rendering failure at the inspected locations; it does not isolate whether the geometry was never created, got baked incorrectly, was culled, or is hidden.
- Representative source-backed cases (UTM EPSG:25832):
  - `way/6666519` (primary), E 351822.700 / N 5790720.
  - `way/6661112` (residential), E 357376 / N 5791095.095 — no source-feature attribution and no sampled road mesh on either side.
  - `way/221267376` (service), E 357376 / N 5790237.696 and N 5790254.857 — two missing-road sample witnesses.
  - `way/546666718` (residential), E 352326.079 / N 5794816, and nearby `way/38892898` (cycleway), E 352329.339 / N 5794816.
- The v3 report and precise feature/tile coordinates are preserved under TKT-032's investigation. Source ID presence in a tile is **not** proof of geometry at a seam, while a source-ID absence is **not** proof that no road surface exists under another identity.

## Suggested investigation when reopened

1. Reproduce **one verified missing way** using the non-tiled/shared graph-road path if possible, with the same immutable OSM source snapshot. Distinguish a general road pipeline bug from a tile/shard-only bug before implementing fixes.
2. Trace original OSM highway geometry through ingestion, normalization, graph edge eligibility, chaining/deduplication, surface ownership/subtraction, triangulation, geometry validation, clipping (where applicable), and final scene visibility.
3. Pay particular attention to `src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts` and `src/world/GeometryBuilder.ts`:
   - Eligibility/placement/negative-layer rules; do not incorrectly show tunnels or underground roads.
   - Deduplicated graph feature lineage and genuinely overlapping roads/cycleways.
   - `polygonClipping.difference` and `fullySubtractedRoadIds` / occluded source reporting.
   - Buffered road geometry failures, empty shapes, rejected/degenerated triangles and `surfaceClipFailureCount`.
   - Whether emitted road meshes exist but are hidden/incorrectly positioned in the viewer.
   These are hypotheses to test, **not established root causes**.
4. Construct a **small deterministic failing fixture** from a proven case and add a regression test. Fix only the demonstrated failure stage, preserving existing road/cycleway ownership, picking identity, rails, bridge/tunnel grade separation and negative-layer invisibility.
5. Rebuild into a **disposable bounded test area** and ask the owner to visually verify the original missing locations and at least one control. No automatic LLM visual testing. Replacing the canonical 256-tile dataset or a province-wide rebake requires a separate decision.

## Acceptance criteria (when work resumes)

- [ ] At least one confirmed missing road reproduced deterministically with source-to-render evidence.
- [ ] Root cause isolated to a concrete stage; whether it is shard-specific or shared is established.
- [ ] Focused fix plus regression tests cover missing-road case and intentional surface-ownership/hidden-layer negative controls.
- [ ] Affected roads are physically present and correctly connected in bounded replacement output, with source feature inspection retained.
- [ ] Existing relevant automated tests, lint and build pass.
- [ ] Owner manually confirms representative formerly missing roads now appear.

## Explicit non-goals

**No work now.** No further global seam-audit iterations, no blanket changes to clipping tolerances or OSM layers, no all-region rebake, no unrelated renderer refactor, no gameplay or LOD work.

TKT-032 remains a separate regional continuity investigation. This ticket isolates the possible **shared, pre-tiling missing-road defect** for future prioritization.
