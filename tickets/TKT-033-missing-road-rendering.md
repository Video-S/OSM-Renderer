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

## Owner canonical-source validation: **Boerrichterkamp FIXED before tiling** (2026-11-22)

Owner reran `npm run osm:diagnose-missing-road` after pulling `float32-sliver-pruning-v2`, and uploaded the new complete JSON. **Same immutable source SHA** `8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0`, same bounded 2×2 region, same target `way/6661112` at UTM 357376 / 5791095.095.

| Evidence | Before fix | After fix |
|---|---:|---:|
| Source-specific decision | `invalid-triangles` | **`emitted`** |
| Source rendered ID | `false` | **`true`** |
| Nearest source-attributed triangle | none within 40m | **0m (contains exact sample)** |
| Source triangle count | rejected 21-face geometry | **20 emitted faces** |
| Total E2+ rendered ribbons | 4,578 | **4,643 (+65)** |
| Total E2+ invalid-triangle rejections | 65 | **0** |
| Total E2+ emitted triangles | 112,704 | **114,087 (+1,383)** |
| Fully subtracted source count | 7 | 7 |
| Rounded buffer / surface clip failures | 0 / 0 | 0 / 0 |

**Conclusion:** The precision-aware pruning correction has now **restored the exact source road geometry at the previously visually absent location in a source-backed, pre-tiling graph plan**. The increase of 65 emitted ribbons coupled with 65 fewer invalid-triangle rejections suggests this was a systemic omission path in the local study, but does not prove all 65 are distinct OSM roads or physically continuous across the rendered region.

**Remaining gate:** this diagnostic produces a shared unclipped road plan, not a new baked tile or a viewer frame. The accepted 16-shard / 256-tile Twente mosaic is **still unchanged** and will still display its original missing roads. Next verify a **disposable, bounded tile bake** for the same source (plus a few known missing-road cases) and obtain **owner-only human visual acceptance** before changing canonical packs. TKT-033 stays in progress until this is done.

## Disposable encoded-tile gate prepared (2026-11-22)

The owner-confirmed pre-bake repair is no longer blocked on OSM triage. To distinguish an intact in-memory road plan from what is **actually baked into SQLite tiles**, added `scripts/bake-and-verify-missing-road.ts` and `npm run osm:bake-verify-missing-road` on draft PR #9.

- Builds a **separate 2×2 1,024m tile grid** centered/aligned exactly like the successfully repaired Boerrichterkamp diagnostic, using the immutable canonical source SHA and the **same 768m query margin**. It runs the actual offline TilePackSqliteWriter, binary codec and decode path, not a synthetic `GeometryBuilder` approximation.
- Output is strictly confined to `benchmarks/results/tkt033-disposable/` (e.g. `way-6661112-2x2.sqlite` and `way-6661112-2x2-report.json`). Existing files cause an error; **no `--force` override**, and production `data/osm` pack directories are forbidden as outputs.
- For each sample point, decodes the appropriate LOD0 tile by canonical `tx/ty`, filters to **visible, non-underground, `roads`-layer meshes**, and checks **source-attributed physical triangle coverage** plus any-road physical coverage.
- At E 357376, Boerrichterkamp lies exactly on a 1024m east-west tile border; requires **both ±25cm inset samples** on opposite sides to be covered. The exactly-on-border point is printed for information but excluded from the pass gate due to half-open ownership semantics.
- Writes a structured report with source SHA, tile counts, sampled physical coverage, and explicit limitations. No owner visual QA claimed until the test pack is reviewed in an actual renderer.
- Lightweight CI tests verify guardrails (cannot output into canonical `data/osm` paths, cannot overwrite files), supplied source-coordinate selection, and exclusion of invisible/underground/non-road meshes.

**Next owner command on the TKT-033 branch:**

```powershell
git pull --ff-only
npm run osm:bake-verify-missing-road
```

Upload only `benchmarks/results/tkt033-disposable/way-6661112-2x2-report.json`, **not the SQLite pack**. If `verified-sample-coverage`, the source-backed road survives tile bake, codec and decode on both sides of this test boundary. The existing 256-tile map remains unchanged. If it fails, use that targeted report to fix a specific packed-tile issue before any canonical repack.

## Encoded-tile gate: PASS on canonical OSM source (2026-11-22)

The owner ran `npm run osm:bake-verify-missing-road` and supplied the resulting **`way-6661112-2x2-report.json`**. The test wrote a **new, separate** four-tile SQLite pack under `benchmarks/results/tkt033-disposable`, using snapshot `overijssel-261114-8ae28196` with source SHA `8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0`. **No canonical regional tile packs were altered.**

- **`status=verified-sample-coverage`**; 4/4 tiles nonempty, 160,876 total triangles, 2,975,080 vertices and 4,099 referenced features (all layers combined).
- Original missing road `way/6661112` is physically **`covered`** by **visible, non-underground road-layer triangles** after SQLite bake, codec and decode at the exact original UTM point and all four 25cm insets.
- **Both required cross-tile insets pass:** west E 357375.75 within tile `348:5655`, east E 357376.25 within tile `349:5655`; both surface elevations are **+0.05m**.
- The exact-on-boundary sample also reported covered but is informational due to half-open tile ownership. The north/south insets reported covered in the same eastern tile.
- This verifies source identity and **sampled physical surface geometry in adjacent decoded tiles**. It does **not** prove every meter of the OSM way, full junction connectivity, independent regional-shard equality, nor actual viewer display. Do not mark visual acceptance as complete from probes.

### Manual visual QA using the existing viewer (no new server route or code needed)

The existing **1,024m tile experimental endpoint** can serve any explicitly supplied pack path via `OVERIJSSEL_TILE_PACK_1024M_PATH` (see `resolveTilePackPathForTileSize`, `server.ts`); the viewer's `?m2a=1&tileSize=1024` selects `/api/tiles-1024m` and frames the manifest's actual 2×2 extent.

From PowerShell in the project root, **stop any running dev server**, then run:

```powershell
git pull --ff-only
$env:OVERIJSSEL_TILE_PACK_1024M_PATH = "benchmarks/results/tkt033-disposable/way-6661112-2x2.sqlite"
npm run dev
```

Open `http://localhost:3000/?m2a=1&tileSize=1024`. This serves the **disposable four tiles, not the Twente mosaic**. The Boerrichterkamp sample lies about **375m south of the test grid's local origin** (E 357376, N 5791095.095). Pan/zoom in and confirm the road appears and crosses the vertical tile boundary without a gap; check neighboring road/cycleway priority and any unintended sliver artifacts. Manual visual QA is **owner only**; no LLM screenshot assertions.

To revert the temporary server override, stop the dev server, run `Remove-Item Env:OVERIJSSEL_TILE_PACK_1024M_PATH`, then restart `npm run dev`. The original regional viewer remains at `http://localhost:3000/?m2a=1&region=twente-pilot` and continues to serve the **old** regional mosaic until that mosaic is deliberately rebaked.

**TKT-033 state:** confirmed fix at source-plan stage and encoded-tile stage; waiting on owner-only actual viewer visual acceptance and any broader pilot-rebake decision. PR #9 remains draft.

## Owner visual acceptance — Boerrichterkamp restored (2026-11-22)

After the canonical-source and disposable **4-tile SQLite** source-attributed coverage gates passed, the owner loaded the disposable pack in the actual M2-A 1,024m viewer using the temporary `OVERIJSSEL_TILE_PACK_1024M_PATH` override (`?m2a=1&tileSize=1024`) and confirmed: **“Yeah, it's there!”** This is direct **human visual confirmation that `way/6661112` / Boerrichterkamp appears in the updated test-pack viewer**, resolving the previously observed complete absence at this location. The viewer was deliberately not tested via LLM screenshots.

**Acceptance for this specific case: PASS** — source ingestion → graph planning → precise winding fix → road triangles → disposable tile encode/decode → real viewer. The owner only confirmed the road's presence; do **not** claim that every metre, all junction connections, or the boundary seam was explicitly checked during visual QA.

**TKT-033 overall remains open:** the original 256-tile Twente regional mosaic still contains the old bake, other previously observed missing roads have not yet been separately rechecked, and the parent TKT-032 cross-shard gate remains distinct. This is one successfully verified root cause and repair, not blanket acceptance of the whole region. Avoid unnecessary additional manual QA until a focused follow-up on representative remaining source crossings is warranted.

## Remaining original missing-road events — grouped encoded-tile audit prepared (2026-11-22)

Owner approved checking the **other originally missing roads** after visually confirming Boerrichterkamp is back.

Revisited the full TKT-032 v3 canonical `tkt032-seam-audit-v3.json`: there were **11 road crossing events with no physical road triangle on either 25 cm seam inset**, spanning **10 distinct source OSM ways**. The visually fixed `way/6661112` accounts for one event. That leaves **10 crossing events across 9 distinct OSM way IDs** (including two events for `way/221267376`). These were previously human-observed missing roads but **the new geometry result has not yet been measured at those locations**.

Implemented `scripts/verify-remaining-missing-roads.ts`, exposed as **`npm run osm:verify-remaining-missing-roads`**. It uses exactly the ten source IDs, original UTM crossing points and seam axes from the TKT-032 v3 report, not invented locations. To minimize cost, the ten points are grouped into **five** geographically contiguous 2×2 study grids:

| Group | Source ways / events | Pack strategy |
|---|---|---|
| `central-east-existing` | `way/874072936`, `way/137733136`, `way/221267376` (twice): **4 events** | Reuse Boerrichterkamp's proven disposable pack, but first require the fixed `way/6661112` control road to be visibly covered at both boundary insets |
| `west-north-pair` | `way/38892898`, `way/546666718`: **2 events** | Fresh disposable 2×2 pack |
| `far-northeast` | `way/51932698`: **1 event** | Fresh disposable 2×2 pack |
| `west-middle-primary` | `way/6666519`: **1 event** | Fresh disposable 2×2 pack |
| `west-south-pair` | `way/6655700`, `way/14119316`: **2 events** | Fresh disposable 2×2 pack |

Each pack uses the **same immutable canonical OSM source SHA**, actual offline bake/SQLite codec/decoder, the fixed renderer, and the same **768m context margin** as the successfully verified case. For each crossing, query the actual decoded **visible non-underground road triangles** at the exact crossing and two distinct **±25cm seam-inset tile interiors**, with separate source-specific and source-independent physical coverage. Outcome is one of `source-covered-both`, `source-one-sided`, `other-road-covered-both` (possible legitimate priority ownership), or `physical-sample-gap`. Presence on one sampled point **is not** a complete road or full cross-shard topology proof.

The one-command script puts four **new** four-tile SQLite packs plus a single structured combined JSON under `benchmarks/results/tkt033-remaining/first-pass/`. It refuses to overwrite a prior run; `--run-id=second-pass` opts into a new run. The existing Boerrichterkamp pack is **opened read-only** and the canonical regional `data/osm/twente-pilot-1024m` directory remains untouched. Per-group errors are reported without aborting the other checks. CI tests pin all ten source events, geometry bounds/tile seams, safe output path semantics and classifications.

**Owner next:**

```powershell
git pull --ff-only
npm run osm:verify-remaining-missing-roads
```

Upload the **single** resulting `benchmarks/results/tkt033-remaining/first-pass/remaining-roads-report.json` (not any SQLite packs). Analyze specific uncovered or source-asymmetric locations before any larger bake or manual QA. If a group is not genuinely missing due to an OSM source-line displacement or legitimate cross-class ownership, do not misclassify it as a regression.

**No acceptance claimed** for these ten locations until the owner's actual report is reviewed. TKT-033 / PR #9 remain in progress; parent TKT-032 seam continuity is a separate gate.

### Batch checker CI validation

The grouped ten-event batch checker has passed **TypeScript/lint and production build**, **`RemainingMissingRoads.test.ts`**, and the unchanged disposable-bake safety tests in GitHub Actions run `45040202124`. The E2+ Boerrichterkamp precision/phantom-ownership regressions also pass. The combined suite still reports **exactly the four previously known `JunctionAndTopology.test.ts` failures**, reproduced on the parent branch; the total test matrix is **not** fully green.

The batch command itself cannot run in GitHub CI because the canonical source index and previously baked 2×2 control pack reside on the owner's machine. No claim of restored geometry for the ten outstanding crossings has been made yet.

## Owner grouped road coverage report — 8 recovered, 1 owned by another road, 1 physical inset gap (2026-11-22)

Owner ran `npm run osm:verify-remaining-missing-roads` using snapshot `overijssel-261114-8ae28196` and uploaded the full `benchmarks/results/tkt033-remaining/first-pass/remaining-roads-report.json`. The test reused the accepted Boerrichterkamp pack plus **four new disposable** 2×2 packs (no canonical pack modifications). All **10/10** requested crossing events were inspected with **0 group errors**:

- **8 source-covered-both:** `way/874072936` service, `way/137733136` cycleway, `way/221267376` service **twice**, `way/546666718` residential, `way/51932698` residential, `way/6666519` primary, and `way/6655700` residential. For each, the correct source ID owns visible road-layer triangles in **both** distinct adjacent tile interiors at ±25cm, height +0.05m.
- **1 other-road-covered-both:** `way/38892898` cycleway at E 352329.339, N 5794816. Source-specific samples are **uncovered** on both sides (matched source geometry metadata exists), but *other* visible road surfaces cover **both** insets at +0.05m. Nearby residential `way/546666718` is source-covered on both sides; probable overlapping/surface-ownership relationship, **not proven** from this report alone. Do not mark the cycleway's expected representation as resolved without checking graph ownership/position when needed.
- **1 physical-sample-gap:** `way/14119316` cycleway at E 352312.35, N 5786624 on a horizontal tile seam. The **exact center point is source-covered at +0.05m** (tile 344:5651), but north 25cm (tile 344:5651) and south 25cm (tile 344:5650) are **both uncovered by any visible road triangles**. Both source-specific and any-road tests fail on the insets; matched source mesh metadata exists in both tiles. This pattern does **not** establish an entire missing cycleway: it could be tangency to the source line, ribbon width/position, clipping, triangulation, or a narrow physical seam gap. Need to distinguish source geometry near the crossing before changing any tolerance or clipper.

**Interpretation:** The original absent-road witnesses are substantially improved after the Float32 winding fix: eight crossings now have direct source-attributed point coverage, one has physical surface coverage under another owner, and only one has a genuine missing *point sample* on both sides. These **small 2×2 query contexts differ from the original regional 4×4 shard inputs**, and tests do not prove continuous complete roads or owner visual quality across all sites. Boerrichterkamp remains the only owner visually accepted formerly missing road.

**Next targeted step:** inspect the existing `west-south-pair-2x2.sqlite` without rebaking: sample a dense north/south cross-section around `way/14119316`, compute physical nearest source/any-road triangle distance and compare against exact canonical OSM centerline orientation (crossing vs endpoint/tangent). If an actual gap remains on both sides along the *real source centerline*, build a focused regression. No province or regional bake.

### Cycleway seam cross-section: targeted no-rebake diagnostic ready

Added `scripts/inspect-cycleway-seam.ts` and `npm run osm:inspect-cycleway-seam` to resolve whether the remaining `way/14119316` is an OSM line **endpoint/tangency** or has an actual local mesh opening. The script reads the **already baked** `benchmarks/results/tkt033-remaining/first-pass/west-south-pair-2x2.sqlite` and immutable canonical OSM index **read-only**; it never runs the offline baker and cannot modify the Twente pack.

The report measures physical source-identified and any-road coverage at **17 north/south offsets from −4m to +4m** at E 352312.35 and additionally at points **along the actual closest OSM way segment**, when that segment spans the requested sample distances. It reports nearest actual road-triangle distances (not merely source metadata or presence of any mesh) in each relevant decoded tile. The source geometry analysis lists closest OSM segment, actual seam intersections and whether the way **properly crosses, ends at, or follows** the seam. That distinction is important because a source line that ends/touches a boundary could legitimately lack roads 25cm on either side.

**Owner action on TKT-033 branch:**

```powershell
git pull --ff-only
npm run osm:inspect-cycleway-seam
```

Upload only `benchmarks/results/tkt033-remaining/first-pass/way-14119316-cross-section-v1.json`. If the cycleway truly crosses the seam and uncovered samples lie **along** its centerline, investigate geometric clipping/ownership and build a source-backed regression. If its line only touches or ends on the seam and correctly visible triangles exist along the actual line, classify the original 25cm samples as false negatives; never alter clipping tolerances based solely on those probes. `way/38892898` remains a separate probable surface-ownership case.

## Cycleway `way/14119316`: **false positive**, not a seam defect (2026-11-22)

Owner supplied the full read-only `way-14119316-cross-section-v1.json` generated against the previously baked `west-south-pair-2x2.sqlite`, using the canonical OSM SHA. It identifies OSM `way/14119316`, **Hilgenhuesweg**, as `highway=cycleway`, `foot=yes`, `width="0.2 m"`, with **9 source nodes**. The source line **properly crosses** the horizontal tile seam N=5786624 at **E=352312.349776**, within 0.000224m of the audit point, making an angle of **39.3654° to the seam**.

The original TKT-032 + batch probe kept E=352312.35 fixed while moving ±0.25m in N. For this diagonal line that creates a **~0.193m perpendicular displacement** from the source centerline. A 0.2m-wide way has nominal **0.1m half-width**, so these probes are legitimately **outside** the drawn cycleway; they cannot establish a physical discontinuity.

**Direct decoded-pack evidence:** all **9** follow-up samples on the *actual OSM line*, at signed distances −2, −1, −0.5, −0.25, 0, +0.25, +0.5, +1, +2 metres, are **source-attributed `covered`**, at render elevation +0.05m and nearest source triangle distance **0m**. They include samples in both adjacent decoded tiles **344:5651** and **344:5650**, so the road is represented across the seam. Along the *wrong* fixed-axis transect, ±0.25m is uncovered with the nearest surface ~0.093m away, whereas ±0.1m is covered. This matches the expected behavior for a narrow diagonal way.

**Conclusion:** The previously reported `physical-sample-gap` for `way/14119316` is a **sampling-method false positive**, not a confirmed renderer or clipper defect. No geometry or tiling fix is warranted. The broader audit must use **tangent-aligned probes along the true OSM centerline** for linear roads/paths, not arbitrary axis-aligned offsets. For source curves crossing at OSM vertices or lying nearly parallel to a seam, classify the witness as inconclusive unless both offsets can reliably be sampled along its geometry.

**Regression correction:** added `tangentAlignedRoadSeamProbes()` and tests containing the exact real OSM segment that demonstrate the false positive: the fixed-axis 25cm probes lie >0.19m from the centerline while tangent-aligned 25cm probes are on-line in two different tiles. Renamed the grouped checker's misleading `physical-sample-gap` outcome to **`axis-inset-uncovered`**; the original immutable first-pass JSON retains historical names. The grouped checker still exposes axis-only metadata and is **not a substitute** for centerline-following source validation.

**Other unresolved observation:** `way/38892898` cycleway is not source-attributed at the original crossing, although visible road geometry from another owner covers both sample points (neighboring `way/546666718` residential is present). Investigate semantic ownership/offset if visual representation of this cycleway is required; do not conflate source attribution with absence of a road surface.

Of the original **11** neither-side road samples, **9 events** (`way/6661112` plus eight more) have new **source-attributed physical coverage** in disposable 2×2 packs; **one** is physically covered by a different road owner, and **one** is the proven axis-sampling false positive. This is strong evidence of improvement but **not** proof of correctness at every original 4×4 shard crossing, nor visual acceptance of the full regional map. The canonical **256-tile Twente mosaic is unchanged**.

### Remaining overlapping cycleway: read-only physical owner diagnosis

The only original neither-side sample not yet clearly attributable to its own intended source is `way/38892898` (cycleway) at UTM E=352329.339 / N=5794816. The physically visible road on both sampled sides might belong to nearby residential `way/546666718`; direct source attribution and placement semantics remain unproven.

Added `scripts/inspect-cycleway-ownership.ts` / `npm run osm:inspect-cycleway-ownership`, reading **only** the already generated `west-north-pair-2x2.sqlite` and immutable source index. It fetches both OSM centerlines/tags, distinguishes real seam contacts, samples **along each road's tangent** where possible, and resolves actual road triangle owners using each decoded mesh's `singleFeatureIdx` or `faceRanges` rather than assuming any nearby road is the cycleway. It prints original axis-probe owners and writes a small report; no baking or pack changes. Deterministic test exercises physical owner attribution on an explicit indexed feature range and prevents arbitrary pack/output paths.

**Next command:**
```powershell
git pull --ff-only
npm run osm:inspect-cycleway-ownership
```
Upload `benchmarks/results/tkt033-remaining/first-pass/way-38892898-ownership-v1.json` only. This will tell us whether the cycleway is physically rendered (possibly offset), legitimately masked by the residential road, or incorrectly suppressed. A separate cycleway surface may be semantically important even when there is no open ground hole; do not automatically count a residential carriageway as correct cycleway representation.

## Last original crossing: shared-node junction corridor (2026-11-22)

Owner's `way-38892898-ownership-v1.json` establishes that the originally
unattributed cycleway witness at E=352329.339, N=5794816 is **not physically empty**:
- Cycleway `way/38892898` and residential `way/546666718` share OSM node `462001787` at E=352327.5513159529, N=5794814.283447532.
- At the *actual cycleway tangent* roughly 0.25 m north of the crossing, `Roads_cycleway` from `way/38892898` owns the decoded triangle at +0.05 m.
- Roughly 0.25 m south along that tangent, `Roads_residential` from `way/546666718` owns the road triangle at +0.05 m.
- The original fixed-easting ±25 cm probes both hit residential, but are **not** valid evidence that the cycleway itself is absent.

The source builder gives at-grade residential surfaces priority over
cycleways and subtracts overlapping lower-priority polygons. This is a
plausible ownership transition at an intersection; a single pair of
tangent probes does **not** prove the entire junction is free of holes.

**Implemented final bounded check:** `npm run osm:inspect-cycleway-ownership -- --report-id=v2`
now also samples the **real OSM cycleway centerline from the shared node**,
at 10 cm intervals, through at least 5 m *past* the audited tile seam.
It reads only the existing immutable source index and previously baked
`west-north-pair-2x2.sqlite`. The report includes per-point decoded-tile
physical coverage, source IDs from triangle lineage, a bracketed
residential-to-cycleway transition, and explicit negative classifications
for missing, unrelated, or unattributed physical surfaces. The gate requires
one transition near the seam and no sampled gaps, including samples from
both adjacent tiles. It refuses to infer a transition from incomplete
OSM node IDs, ambiguous shared junctions, or incorrect source geometry.

A result `consistent-sampled-ownership` supports a **local sampled
junction-occlusion classification**, *not* complete continuous geometry
between 10 cm samples, off-centerline pavement semantics, visual acceptance,
or regional connectivity. Any `inconclusive` result requires inspecting
the recorded points before changing rendering. Deterministic regressions
use the **exact canonical first-segment UTM positions and shared OSM node**
from the owner report with synthetic decoded-owner outcomes, including gap,
alien-owner, reversion, and ambiguous-lineage negative controls.
The regression cannot replace a real canonical source/SQLite execution.

**Canonical owner gate: PASS (2026-11-22, read-only existing pack).**

The owner's `way-38892898-ownership-v2.json` uses canonical Overijssel
snapshot `overijssel-261114-8ae28196`, source SHA256
`8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0`.
The corridor status is **`consistent-sampled-ownership`**.

- Exactly **77** valid 10 cm-spaced centerline samples, extending from
  0.05 m to 7.65 m from OSM node `462001787`; the seam is 2.47817 m
  from that node. Tiles `344:5658` (25 probes) and `344:5659` (52 probes)
  are both represented.
- **27** samples have physical residential ownership from
  `way/546666718`; subsequent **50** samples have physical cycleway
  ownership from `way/38892898`. No uncovered, alien-owned or
  unattributed samples were observed.
- Residential ownership ends at **2.65 m** and cycleway ownership begins
  at **2.75 m** from the shared node (a 10 cm transition bracket), just
  beyond the seam. This is the expected surface-priority handoff.

**Disposition:** The last original suspected missing cycleway is a
*sampled-ownership false alarm*, consistent with valid residential-first
polygon subtraction at the shared-node junction. No renderer change or
additional disposable bake is indicated for this case. All 11 original
physically-absent crossing events now have a local explanation / pointwise
coverage witness; this is **not** regional connectivity or visual
sign-off. A 10 cm sample interval cannot exclude sub-interval gaps,
off-centerline issues, or visual-semantic problems. Maintain TKT-033 and
draft PR #9 pending the separate regional bake/acceptance decision.

**CLI correction:** On the owner's npm version,
`npm run osm:inspect-cycleway-ownership -- --report-id=v2` was
**incorrectly consumed as npm config**, so the script retried the existing
`v1` path. The successfully used direct invocation is:

```powershell
npx tsx scripts/inspect-cycleway-ownership.ts --report-id=v2
```

Do not overwrite existing reports. No further local rerun is necessary.

**CI at commit `c810f6f` (Actions run `45053856422`):**
TypeScript/build **PASS**; `CyclewayOwnershipDiagnosis.test.ts` **PASS**;
`CyclewaySeamDiagnosis.test.ts` and `RemainingMissingRoads.test.ts`
**PASS**. Full CI is **not** green (27 successful jobs, 3 failing
jobs): four existing `JunctionAndTopology.test.ts` failures recur,
with three failures in road/rail network topology tests and one
railway `ElevationAndZIndex.test.ts` failure in unrelated suites.
These additional failures were not modified by this junction diagnosis,
but their baseline equivalence is not established here. Review them
under the appropriate workstream; do not misrepresent CI as fully
passing.

**Next gate:** explicit decision whether to rebake the canonical
256-tile Twente region, then separate source-based and human-only
regional visual/continuity checks. No automatic LLM visual QA.

## Decision gate: owner authorizes full Twente candidate rebake (2026-11-22)

**Decision: APPROVED for an isolated, full 16-shard / 256-tile Twente
candidate rebake, NOT approved for replacement/promotion of the existing
regional mosaic.** Use the source-backed TKT-033 graph-road fixes. All
original 11 missing-crossing investigations are accounted for with bounded
evidence, but no 4×4 regional replacement pack has yet been produced. Human
visual and regional cross-shard acceptance remain open.

**Build provenance:** run on branch
`tkt-033-shared-road-geometry-correctness` (PR #9, stacked on TKT-032),
same immutable `overijssel-261114-8ae28196` source index / full SHA
`8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0`.
Use the unchanged Twente pilot config (16×16 tiles at 1024 m, 4×4 tile
shards, 64 m collars, 1024 m query context). The **existing**
`data/osm/twente-pilot-1024m/` must not be touched.

**Owner's PowerShell candidate bake (from repo root, server stopped):**

```powershell
git status --short
git branch --show-current
git pull --ff-only
$candidate = "data/osm/twente-pilot-1024m-tkt033-candidate"
if (Test-Path $candidate) { throw "Candidate directory already exists; do not reuse an unknown earlier bake" }
npx tsx scripts/bake-regional-pilot.ts "--out-dir=$candidate"
if ($LASTEXITCODE -ne 0) { throw "Candidate bake failed; do not promote" }
npx tsx scripts/verify-regional-mosaic.ts "--index=$candidate/mosaic.json"
if ($LASTEXITCODE -ne 0) { throw "Candidate integrity verification failed; do not promote" }
```

Before the command, the checkout should be on the named branch and have no
unrelated local modifications. `npx tsx` is deliberate: the owner's npm
consumes `--flag=value` arguments when passed through `npm run ... --`.
Never pass `--force`, `--max-shards`, reduced dimensions, or the old
canonical output directory. If interrupted, keep the partial candidate
for diagnosis; decide whether to resume or create a fresh named candidate
after inspecting the exact state. A different directory avoids implicit
reuse of old renderer-revision packs, because existing-shard reuse checks
source/schema, **not renderer commit revision**.

**Integrity gate before any human viewing:** the verifier must report
16 source-consistent complete shard packs, 256 decoded tiles, aligned
manifests and successful hash/decode checks. Size and triangle totals may
differ from the old 235.68 MiB compressed snapshot; a byte-for-byte match
is not required and does not prove correct geometry.

**Human-only visual gate, after pack verification:** stop any old dev server;
then in that same PowerShell process:

```powershell
$env:OVERIJSSEL_REGIONAL_MOSAIC_PATH = (Resolve-Path "$candidate/mosaic.json").Path
npm run dev
```

Open `http://localhost:3000/?m2a=1&region=twente-pilot`.
The environment variable changes the **source pack path**, not the URL.
Inspect original Boerrichterkamp missing segment, other TKT-032 missing-road
witnesses, road/cycleway ownership at Aaltje Noordewierstraat, narrow
Hilgenhuesweg, sample shard boundaries and controls, rail alignment,
bridge/tunnel visibility including negative layers, picking, fills and
streaming. Owner alone decides visual acceptance; no LLM screenshots.
After stopping the server, remove `Env:OVERIJSSEL_REGIONAL_MOSAIC_PATH`
and restart to view the original dataset.

**Broader regional source-to-output gate:** the TKT-032 seam auditor
can be run against the **candidate index** using distinct output files,
but its fixed-axis 25cm road probes are known to misclassify narrow diagonal
features. Compare actionable, source-aligned findings and named controls;
do not treat raw v3 warning totals as a binary pass/fail or as proof of
missing geometry. Regional acceptance additionally depends on unresolved
cross-shard road/rail/portal continuity and CI triage.

**CI caveat:** TKT-033 focused diagnostics, typecheck and build passed at
`c810f6f`; overall CI still has three failing jobs spanning four known
junction assertions and four other road/rail/elevation tests. Baseline
equivalence for the latter is unproven. These are **not** blockers to
generating an isolated diagnostic candidate, but production promotion
requires explicit severity/baseline review (or fixes) and separate
TKT-029/TKT-032 sign-off.

**Promotion: explicitly NOT authorized.** Do not delete, overwrite, swap,
or rename the old accepted 16-shard mosaic. Next evidence requested from
the owner: new bake completion console summary and `verify-regional-mosaic`
16-shard/256-tile output, then their human viewer assessment.
No regional rebake was executed by ChatGPT; the source index and pack
exist only on the owner's machine.

## Candidate bake: integrity PASS, western primary road visual FAIL (owner, 2026-11-22)

The owner completed a fresh, all-16-shard candidate bake on branch
`tkt-033-shared-road-geometry-correctness`, commit `9a8c43a`, at
`data/osm/twente-pilot-1024m-tkt033-candidate/`, **without reusing**
shards. The manifest/verifier reported 16/16 shard SQLite packs and
256/256 complete, nonempty tiles, **236.09 MiB compressed**, with the
pinned canonical source hash. The old mosaic was not overwritten.

**Human visual outcome:** Several previously broken locations appear
restored, but the owner supplied an actual candidate-viewer screenshot
showing that the expected **western primary road**
`way/6666519` remains visually discontinuous/missing at the originally
audited seam. This is **FAIL for candidate visual acceptance**, even
though payload integrity succeeded. The screenshot is human evidence of a
remaining discontinuity; its exact failure stage is not yet established.

Exact original source-backed witness: UTM EPSG:25832
**E=351822.700, N=5790720.000**. This northing is exactly the
horizontal **4×4 regional shard boundary**
`horizontal-r1-2-c1`, between `r01-c01` (north) and
`r02-c01` (south), decoded tiles `343:5655` and `343:5654`.
The previously passing `west-middle-primary` disposable **2×2**
pack is **not** evidence of correct behavior in either 4×4 regional
shard. A boundary coincidence is a strong location clue, **not yet proof**
of a shard-specific root cause; check clipped geometry, source attribution,
grade/layer, source planning, and viewer/streaming as distinct stages.

**Next owner action — read-only, no bake:**

```powershell
npx tsx scripts/audit-regional-seams.ts "--index=data/osm/twente-pilot-1024m-tkt033-candidate/mosaic.json" "--boundary=horizontal-r1-2-c1" "--feature=way/6666519" "--out=benchmarks/results/tkt033-primary-candidate-seam-v1.json" "--markdown-out=benchmarks/results/tkt033-primary-candidate-seam-v1.md"
```

Upload the JSON, not the shard SQLite packs. The existing TKT-032
auditor verifies all shard payloads read-only, then filters the candidate
source crossing and samples the decoded adjacent tiles. Its fixed-axis
25 cm samples are **triage only**, not a continuous geometric proof:
follow up with source-tangent alignment and actual triangle ownership
before fixing any code. If the report contains no crossing candidates,
that does **not** invalidate the visual evidence—next use an exact-UTM
targeted probe independent of the seam candidate enumerator.

**Decision:** Candidate is **NOT promoted/accepted**. Keep PR #9 draft,
TKT-033/TKT-032/TKT-029 open, and keep both original and candidate
mosaics untouched until the missing primary road has a causal
reproduction and a narrow fix verified in a bounded 4×4 replacement
candidate. Human-only visual sign-off remains mandatory.

## Acceptance criteria

- [ ] At least one confirmed missing road reproduced deterministically with source-to-render evidence.
- [ ] Root cause isolated to a concrete stage; whether it is shard-specific or shared is established.
- [ ] Focused fix plus regression tests cover missing-road case and intentional surface-ownership/hidden-layer negative controls.
- [ ] Affected roads are physically present and correctly connected in bounded replacement output, with source feature inspection retained.
- [ ] Existing relevant automated tests, lint and build pass.
- [x] Owner visually confirms Boerrichterkamp (`way/6661112`) now appears in disposable viewer; remaining originally missing roads and regional map are pending.

## Explicit non-goals

No further global seam-audit iterations, no blanket changes to clipping tolerances or OSM layers, no all-region rebake, no unrelated renderer refactor, no gameplay or LOD work. Restrict current work to the shared road correctness issue and source-backed regression diagnosis.

TKT-032 remains a separate regional continuity investigation. This ticket isolates the possible **shared, pre-tiling missing-road defect** for future prioritization.
