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

## Investigation approach

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

## Investigation and first correctness fix (2026-11-22)

Owner reopened this ticket. Work is isolated on branch `tkt-033-shared-road-geometry-correctness`, stacked on the TKT-032 branch in **draft PR #9**. We have **not** modified the canonical Twente SQLite data.

### Demonstrable shared-builder defect

In `src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`, the E2+ surface owner `registerRoadFootprint()` was called **as soon as Boolean subtraction returned a nonempty polygon**, *before* `createShapesFromMultiPolygon()`, `THREE.ShapeGeometry`, upward-winding/degenerate triangle validation or tile clipping could reject the geometry.

If a high-priority road failed after the premature registration, its unrendered footprint continued to subtract lower-priority roads. This is an actual phantom-occluder logic defect independent of regional tiling; it can erase a road without creating a visible replacement. The correction commits footprint ownership **only after a validated geometry is registered and emitted**. Retain legitimate priority subtraction when the first road actually renders.

Regression: the existing E2+ synthetic test suite now has a **controlled late-triangulation-rejection** test: reject a primary road and assert that a lower-priority overlapping residential road remains rendered, while the normal no-rejection case still correctly subtracts that residential road. The optional test-only rejection hook is never populated by production code.

**Limit:** the synthetic regression establishes the lifecycle defect and the validity of its fix; it does not establish that this lifecycle defect caused any particular canonical `way/...` failure.

### Targeted canonical-source diagnosis (no bake)

Added `scripts/diagnose-missing-roads.ts` and `npm run osm:diagnose-missing-road`. This creates a disposable **2×2 1,024 m study from the canonical immutable source index**, with configurable query context and no tile clipping, pack encoding, or viewer streaming. It reports, for a specific OSM way and UTM point:

- Source GeoJSON existence/tags and `ProcessedMapData` parsed road count.
- Road `topologySource` parts and graph descriptor identity/class/layer/grade eligibility.
- Whether the non-tiled global road plan emitted the source, marked it fully subtracted, and its aggregate rejection diagnostics.
- **Distance from the exact missing point to the nearest *source-attributed* emitted triangle and to *any* emitted road triangle**, plus nearest neighboring geometry owners and classes.

Run one discriminating case from the project root with the canonical `overijssel-261114-8ae28196.sqlite` index already installed:

```powershell
git fetch origin
git switch --track origin/tkt-033-shared-road-geometry-correctness
npm run osm:diagnose-missing-road
```

Default test case: `way/6661112` at EPSG:25832 E 357376 / N 5791095.095. Output `benchmarks/results/tkt033-shared-road-diagnosis.json`. To target the primary road instead:

```powershell
npx tsx scripts/diagnose-missing-roads.ts --feature=way/6666519 --out=benchmarks/results/tkt033-primary-diagnosis.json
```

**Interpretation:** this is a *shared* graph rendering experiment, not a canonical shard reproduction. A missing source/descriptor/triangle at this stage implicates the shared pipeline, whereas success here and failure in the accepted pack narrows the problem to context/tiling/codec/viewer. The independent 2×2 query has different surrounding context from the original 4×4 shard, so results need follow-up before claiming an exact root cause.

Once the source-backed output exists, determine whether the phantom-occluder fix actually affects those OSM ways; address any distinct defect separately. Do not overwrite or rebake the accepted region until an isolated regression and owner review justify it.

### CI validation and baseline comparison

After initial correction and targeted diagnostic tests:

- **Passed on TKT-033:** TypeScript `lint` / production build; `MissingRoadDiagnosis.test.ts`; the complete E2+ `SurfaceFirstRoadRendering.test.ts` suite, **including the new fault-injection test**.
- **Pre-existing failures (not caused by TKT-033):** the four assertions in `JunctionAndTopology.test.ts` (provenance count, bow-tie clipping diagnostics, portal-gap validation and explicit-node junction count) fail on **both** the parent branch at commit `953249342cbb39205232b13ac3cdc255be33b36b` (GitHub Actions run `45030566400`) and the TKT-033 PR #9 branch (run `45032070443`) with matching expected/actual outcomes. These are separate existing test issues; do not silently claim a fully green CI suite or expand the missing-road fix to unrelated behavior.
- **Not run in CI:** the canonical `overijssel-261114-8ae28196.sqlite` analysis, because the source index lives on the owner's machine, not in the repo. This prevents asserting that the fix restores specific Twente ways without follow-up evidence.

## Owner canonical-source diagnostic result — `way/6661112` (2026-11-22)

Owner executed the new `npm run osm:diagnose-missing-road` on their local immutable Overijssel source index. Report was successfully written to `benchmarks/results/tkt033-shared-road-diagnosis.json`. The **console output** establishes:

- Source GeoJSON features found: **1**; parsed roads: **1**; graph edges: **1**.
- Source-attributed *pre-tile* generated triangle within the diagnostic's 40 m search radius at UTM E 357376 / N 5791095.095: **none** (printed `absent`). This result means *no surface in the local 40 m neighborhood*, not necessarily no emitted triangle anywhere in the 2×2 study.
- Nearest generated road triangle from *any* source: **19.9513 m** away.
- Diagnostic does not apply tile clip, binary codec, or viewer streaming; canonical tile packs remain unchanged.

**Interpretation:** This reproduces a source-backed road geometry absence near the specified OSM crossing *before* tile encoding and streaming, in a separately queried 2×2 study. It supports a shared road-plan issue, but the query context differs from the original 4×4 shard, and the exact cause is not yet known. The already-fixed premature-footprint bug is **not yet demonstrated** to be the cause of this way's failure.

**Necessary next evidence:** inspect the newly generated full JSON (not yet supplied) for `inventory.graphEdges[].isAtGradeBuildable` / placement, `plan.renderedSourceId`, `plan.fullySubtractedSourceId`, rejected/buffer/clip counters, and nearest geometry owners; use that to select a specific stage for a bounded regression rather than guessing at width, clipping, layer or triangulation policy.

## Canonical JSON inspected — root cause not yet established (2026-11-22)

Owner uploaded the entire `tkt033-shared-road-diagnosis.json`. This is the actual immutable source snapshot `overijssel-261114-8ae28196` (SHA256 prefix `8ae28196`), not synthetic data:

- OSM source: **`way/6661112` / Boerrichterkamp**, `highway=residential`, `maxspeed=30`, three vertices, three OSM node IDs.
- Canonically parsed road: `way/6661112-0`, width **5.4 m**, `layer=0`, `isBridge=false`, `isTunnel=false`; one topology part.
- One graph descriptor: `road_edge:way/6661112-0:seg_0:p_0`, 3 points, `isAtGradeBuildable=true`, `placement=surface_open`, `rendersOnSurface=true`, `hasConflict=false`.
- Shared **pre-tile** at-grade plan: `renderedSourceId=false` and `fullySubtractedSourceId=false`, no source-attributed road surface within 40 m; nearest **other** road class is `path` `way/177903617`, **19.9513 m** away. The nearest distinct residential road is `way/6661117`, over **32 m** away. This is substantive, not merely a missing source-ID label on an otherwise nearby road ribbon.
- Overall 2×2 analysis processed 4,650 subsegments and reported **65 `invalidTriangleGeometryCount`**, **7 fully subtracted**, **0 rounded-buffer failures**, **0 flat-ribbon fallbacks**, **0 `surfaceClipFailureCount`**, **0 empty shapes**. Aggregate 65 failures do **not** prove this particular source suffered a triangle failure; it is the leading explanation remaining after eligibility and total-subtraction checks.

**Trace enhancement committed:** the optional, source-filtered `roadGeometryTrace` records for the selected way *each concrete builder decision* (`emitted`, `invalid-triangles`, `fully-subtracted`, exception, etc.). When validation rejects triangles it records the first failing face, area, geometric normal Y, and vertex positions (without mutating geometry). It passes through `ingestCanonicalStudyGeoJson` to the same pre-tile builder, is read-only, and does not collect events for unrelated thousands of ways. A regression verifies trace behavior under normal and artificially failed geometry.

**Next run on the existing TKT-033 branch:**

```powershell
git pull --ff-only
npm run osm:diagnose-missing-road
```

Upload the **overwritten** `benchmarks/results/tkt033-shared-road-diagnosis.json`. Its `roadGeometryTrace` contains the missing decisive per-way stage. If `invalid-triangles` is confirmed, repair the exact ring/winding/triangulation cause with an OSM-coordinate-derived regression, not a blanket polygon-clipping fallback; retain the strict upward winding and surface ownership tests. If an exception or other stage is found, fix that stage instead. **No canonical rebake or claimed visual fix yet.**

## Canonical per-face rejection confirmed and precision fix (2026-11-22)

Owner uploaded v2 `benchmarks/results/tkt033-shared-road-diagnosis.json` (source snapshot `overijssel-261114-8ae28196`): **`way/6661112` / Boerrichterkamp** has exactly one tracked road-builder decision, **`stage=invalid-triangles`**, despite valid `surface_open` 5.4m residential OSM/graph data. The polygon Boolean difference returned **1 visible polygon** against **2 blockers**; `THREE.ShapeGeometry` generated **21 faces**, but face **19** was downward (`normalY=-1`) with microscopic area **6.967457011342049 × 10⁻⁶ m²**. Sampled face vertices in local meters:

```json
[
  [-17.274599075317383, 0.05000000074505806, -387.07470703125],
  [-17.290800094604492, 0.05000000074505806, -387.04339599609375],
  [-19.740299224853516, 0.05000000074505806, -382.3102111816406]
]
```

The longest edge is ~**5.365m**, making this triangle only **2.60 micrometres** high relative to that edge. **Float32 spacing** at local Z≈−387m is ~**30.52 micrometres**, more than 10× the altitude. The triangle's signed winding is **not numerically reliable** at the storage precision. The previous validation rule rejected the **entire 21-face road** for *any* nondegenerate downward-facing triangle (area >1e-6m²). **This is now a confirmed specific cause of the Boerrichterkamp omission in the shared pre-tile road plan.**

### Targeted fix on PR #9

`src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts` now treats a non-upward triangle as a **Float32-unresolvable sliver** only if its minimum altitude `2 × area / maxEdgeLength` is at most **2× the Float32 ULP** at the local vertex-coordinate scale. It **prunes that face only**, preserving other valid triangles. Geometry still fails if a face with reliably resolvable inverted winding exists or if *no* valid triangles remain. We do not invert indices, relax layer/tunnel policy, remove Boolean priority ownership, or convert rejected big triangles into visible surfaces. Existing area-based true degeneracy filtering is unchanged.

Tests use the **exact offending three Float32 vertices** from the owner's real trace, plus a good face, and assert that the tiny inverted face is pruned and the rest survives; a visible **12.5m² inverted face still rejects the entire geometry**, and an all-sliver mesh is still rejected. The earlier phantom-occluder lifecycle fix and its fault-injection test are retained.

**CI run `45035372928` on code commit `07720e2f9caaff66564a55b8c553c675287dba3c`:** TypeScript/build **passed**, `MissingRoadDiagnosis.test.ts` **passed**, **new canonical-face sliver tests passed**, earlier ownership lifecycle regression **passed**, rest of the E2+ road test suite **passed**. The combined test job still has exactly **4 pre-existing `JunctionAndTopology.test.ts` failures** matching the parent branch; do not say all CI is green.

### Next decisive check (owner's immutable source index)

```powershell
git pull --ff-only
npm run osm:diagnose-missing-road
```

**Expected but not yet observed:** `roadGeometryTrace` for `way/6661112` switches from `invalid-triangles` to `emitted`, `plan.renderedSourceId` becomes `true`, and `nearestSourceGeometryMeters` approaches **0m** at the selected OSM crossing. If a second reliably inverted face still rejects it, the new trace reports the next exact face for investigation. Upload this overwritten JSON before assuming the real road is restored.

The accepted 16×16 regional tiles have **not** been rebaked. Once pre-tile geometry is confirmed, use a **disposable small-area bake** and **owner-only visual QA** before considering replacement of canonical packs or sign-off.

## Second owner run still reports face 19 — diagnostic trace corrected (2026-11-22)

Owner uploaded another 7,142-byte `tkt033-shared-road-diagnosis.json` from the same source snapshot. Its reported fields are **unchanged**: `renderedSourceId=false`, `stage=invalid-triangles`, `faceIndex=19`, `normalY=-1`, `area=6.967457e-6 m²`; 65 overall `invalidTriangleGeometryCount`, nearest any-road distance 19.9513m.

**Important diagnostic ambiguity discovered in source inspection:** `findFirstInvalidRoadTriangle()` was implemented **independently** of the validator and returned the first downward-facing face **even if `validateAndPruneHorizontalGeometry()` had correctly pruned that specific Float32-unresolvable face**. Thus the unchanged `faceIndex=19` does **not prove** the precision fix failed. Two plausible explanations remain: (a) owner's local code/report is stale, or (b) face 19 was skipped correctly but a **later reliably inverted face** still rejected the 21-face geometry, while the old trace misleadingly pointed to face 19. Earlier text that suggested only stale source was too strong.

**Diagnostic fix:** the new `inspectRoadTriangleFaces()` applies the **exact same area and Float32 winding rules** as production validation and reports bounded per-face outcomes `pruned-degenerate`, `pruned-float32-sliver`, `fatal-nonfinite`, `fatal-non-upward`, plus summary counts of valid, pruned and fatal triangles and the **actual first fatal** face. Source-backed JSON and console now include marker `roadTriangleValidatorRevision: "float32-sliver-pruning-v2"`, allowing an unambiguous check that the current code was run. Regression test deliberately places the known source face 19 before a large inverted triangle, asserts the trace skips the harmless face and identifies the subsequent fatal one, and verifies the validator rejects the genuine inversion.

**Next evidence needed:** re-run on the TKT-033 branch after `git pull --ff-only`, check that console explicitly prints `triangle validator: float32-sliver-pruning-v2`, and inspect/upload the regenerated JSON `roadGeometryTrace[].triangleAudit`. Do **not** rebake canonical packs or claim Boerrichterkamp now renders until `renderedSourceId=true` in a source-backed run and the owner visually verifies disposable baked output.

## Acceptance criteria

- [ ] At least one confirmed missing road reproduced deterministically with source-to-render evidence.
- [ ] Root cause isolated to a concrete stage; whether it is shard-specific or shared is established.
- [ ] Focused fix plus regression tests cover missing-road case and intentional surface-ownership/hidden-layer negative controls.
- [ ] Affected roads are physically present and correctly connected in bounded replacement output, with source feature inspection retained.
- [ ] Existing relevant automated tests, lint and build pass.
- [ ] Owner manually confirms representative formerly missing roads now appear.

## Explicit non-goals

No further global seam-audit iterations, no blanket changes to clipping tolerances or OSM layers, no all-region rebake, no unrelated renderer refactor, no gameplay or LOD work. Restrict current work to the shared road correctness issue and source-backed regression diagnosis.

TKT-032 remains a separate regional continuity investigation. This ticket isolates the possible **shared, pre-tiling missing-road defect** for future prioritization.
