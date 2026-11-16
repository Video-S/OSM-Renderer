# OSM 3D Renderer — TKT-019 Hengelo S1–S5 Regional Scalability Assessment & Root-Cause Investigation

## 1. Executive Summary & Benchmark Provenance

This report records the project owner's verified Windows regional scaling benchmark across progressive real-world OpenStreetMap extracts around **Hengelo** (`S1` `250 × 250 m` through `S5` `4 × 4 km`, extracted from Geofabrik's `overijssel-261114.osm.pbf`) alongside the empirical root-cause investigation into the superlinear bottlenecks, planar validation violations, and benchmark measurement instrumentation.

### Reproducibility & Environment Metadata (`benchmarks/results/tkt019-hengelo-scaling.json`)

- **Primary Artifact**: `benchmarks/results/tkt019-hengelo-scaling.json` (Schema `1.0.0`, generated `2026-11-15T22:26:27.230Z`)
- **Host Platform**: `win32` (`10.0.26200`, `x64`), Node.js `v22.16.0` (V8 `12.4.254.21-node.26`)
- **CPU & System RAM**: `Intel(R) Core(TM) i7-14650HX` (`24` logical cores), `16,017 MB` (~16 GB) RAM
- **Git Provenance & Reproducibility Limitation**:
  - `gitCommitSha`: `dc422d200874` (`main`, `gitMetadataStatus: "available"`)
  - **`gitDirty: true`**: The Windows benchmark was executed with local uncommitted working-tree changes present (`gitDirty: true`), and with `--max-old-space-size-mb=2048` (`maxRssMB: 3072`, `timeoutMs: 120000`, `validatorMaxEdges: 250`). This `gitDirty: true` qualification is preserved in the JSON artifact and all project documentation.
  - **`gcExposed: false` / `gcInvokedBeforeRun: false`**: As detailed in Section 6, `tsx` CLI wrapper invocation did not forward `--expose-gc` to the inner V8 runtime, so `globalThis.gc` was unavailable (`false`) during both parent metadata collection and worker iterations. Deterministic `cpuBufferMemory` and `SceneResourceManager` lifecycle leak audits (`0` leaks across all completed workloads) are unaffected by V8 GC exposure.

---

## 2. Verified Windows Scaling Results (`S1`–`S5`)

### 2.1 Configuration Progression Summary

| Configuration | Highest Completed Level | Stopped At Level | Stop Reason | Completed / Skipped / Failed |
|---|---|---|---|---|
| **`production-legacy`** *(Legacy Roads + Candidate B Railways)* | **`S4`** (`2 × 2 km`, `4.0 km²`) | **`S5`** (`4 × 4 km`) | `failed_timeout`: Worker exceeded `timeoutMs=120000 ms` (last stage: `iter_1_scene_build`, `116.4 s` heartbeat) | `4` / `0` / `1` |
| **`graph-e2-e3`** *(E2 Graph Roads + E3-A2 Graph Switches)* | **`S3`** (`1 × 1 km`, `1.0 km²`) | **`S4`** (`2 × 2 km`) | `failed_timeout`: Worker exceeded `timeoutMs=120000 ms` (last stage: `iter_3_planar`, `96.5 s` heartbeat) | `3` / `1` / `1` |
| **`surface-first-e2plus-rplus`** *(E2+ Road Footprints + E3-B R+ Ballast)* | **`S3`** (`1 × 1 km`, `1.0 km²`) | **`S4`** (`2 × 2 km`) | `failed_timeout`: Worker exceeded `timeoutMs=120000 ms` (last stage: `iter_3_planar`, `98.3 s` heartbeat) | `3` / `1` / `1` |

### 2.2 Dataset Progression (`S1`–`S5`, Center `[6.7935, 52.2625]`)

| Level | Dataset ID | Extent | Area ($\text{km}^2$) | OSM Nodes / Ways / Rels | GeoJSON Features | Uncompressed / Gzip |
|---|---|---|---:|---:|---:|---:|
| **S1** | `hengelo-s1-250m` | `250 × 250 m` | `0.0625` | `3,998` / `374` / `5` (`4,377`) | `957` | `0.40 MB` / `66.8 KB` |
| **S2** | `hengelo-s2-500m` | `500 × 500 m` | `0.2500` | `10,611` / `1,166` / `9` (`11,786`) | `2,757` | `1.02 MB` / `167.3 KB` |
| **S3** | `hengelo-s3-1km` | `1,000 × 1,000 m` | `1.0000` | `34,093` / `4,318` / `13` (`38,424`) | `9,738` | `3.37 MB` / `512.1 KB` |
| **S4** | `hengelo-s4-2km` | `2,000 × 2,000 m` | `4.0000` | `134,951` / `18,794` / `18` (`153,763`) | `36,669` | `12.47 MB` / `1.73 MB` |
| **S5** | `hengelo-s5-4km` | `4,000 × 4,000 m` | `16.0000` | `358,552` / `52,142` / `67` (`410,761`) | `96,836` | `32.76 MB` / `4.56 MB` |

### 2.3 Stage Timing, Memory & Geometry Summary (Windows i7-14650HX)

Values show **median (p95)** across `3` measured iterations (`1` warmup iteration):

| Level | Config | Status | Parse (ms) | Graph + Adapter (ms) | Planar Surface (ms) | Road Gen (ms) | Rail Gen (ms) | Full Scene Build (ms) | Peak RSS (MB) | CPU Buffer (MB) | Meshes / Tris (w/ Inst) | Leaks |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **S1** | `production-legacy` | `completed` | `16.0` (`19.9`) | `null` | `31.6` (`32.4`) | `22.1` (`25.0`) | `16.2` (`35.4`) | **`86.4`** (`96.4`) | `256.8` | `1.072` | `49` / `20,516` (`57,156`) | `0` |
| **S1** | `graph-e2-e3` | `completed` | `15.3` (`19.4`) | `6.6` + `1.9` | `31.1` (`33.4`) | `46.7` (`48.1`) | `15.2` (`28.8`) | **`110.3`** (`113.6`) | `255.2` | `1.080` | `49` / `20,817` (`57,057`) | `0` |
| **S1** | `surface-first-e2plus-rplus` | `completed` | `17.4` (`20.1`) | `6.6` + `1.4` | `30.7` (`34.0`) | `72.5` (`72.8`) | `30.1` (`41.7`) | **`149.3`** (`154.8`) | `337.3` | `1.107` | `49` / `22,141` (`58,381`) | `0` |
| **S2** | `production-legacy` | `completed` | `37.7` (`47.0`) | `null` | `267.7` (`268.6`) | `95.5` (`96.0`) | `34.3` (`50.5`) | **`458.1`** (`460.3`) | `370.5` | `2.915` | `77` / `60,893` (`177,113`) | `0` |
| **S2** | `graph-e2-e3` | `completed` | `50.4` (`94.9`) | `33.2` + `8.0` | `472.8` (`690.9`) | `416.9` (`431.6`) | `78.3` (`84.4`) | **`1,320.8`** (`1,395.8`) | `391.9` | `2.971` | `77` / `62,605` (`180,925`) | `0` |
| **S2** | `surface-first-e2plus-rplus` | `completed` | `96.3` (`102.8`) | `35.9` + `10.2` | `613.0` (`651.0`) | `620.6` (`621.4`) | `178.2` (`201.9`) | **`1,543.1`** (`1,581.9`) | `396.4` | `3.125` | `74` / `69,216` (`187,536`) | `0` |
| **S3** | `production-legacy` | `completed` | `111.7` (`133.7`) | `null` | `2,297.6` (`2,379.2`) | `540.9` (`591.2`) | `98.6` (`108.3`) | **`3,131.7`** (`3,182.6`) | `650.4` | `9.434` | `133` / `189,332` (`584,922`) | `0` |
| **S3** | `graph-e2-e3` | `completed` | `103.0` (`310.3`) | `70.5` + `17.5` | `2,454.7` (`5,232.4`) | `688.9` (`704.2`) | `116.3` (`245.9`) | **`3,324.2`** (`5,676.2`) | `710.5` | `9.535` | `133` / `192,813` (`592,223`) | `0` |
| **S3** | `surface-first-e2plus-rplus` | `completed` | `295.0` (`311.0`) | `151.4` + `30.0` | `3,425.3` (`5,316.9`) | `2,166.1` (`2,339.9`) | `432.7` (`498.1`) | **`8,383.6`** (`8,931.0`) | `726.1` | `10.180` | `124` / `217,931` (`617,341`) | `0` |
| **S4** | `production-legacy` | `completed` | `419.0` (`428.1`) | `null` | **`11,020.2`** (`11,067.1`) | `2,867.8` (`2,876.5`) | `199.2` (`210.5`) | **`14,448.1`** (`14,675.7`) | **`1,106.1`** | `39.741` | `272` / `606,126` (`1,366,736`) | `0` |
| **S4** | `graph-e2-e3` | `failed_timeout` | — | — | — | — | — | — | — | — | — | — |
| **S4** | `surface-first-e2plus-rplus` | `failed_timeout` | — | — | — | — | — | — | — | — | — | — |
| **S5** | `production-legacy` | `failed_timeout` | — | — | — | — | — | — | — | — | — | — |
| **S5** | `graph-e2-e3` | `skipped` | — | — | — | — | — | — | — | — | — | — |
| **S5** | `surface-first-e2plus-rplus` | `skipped` | — | — | — | — | — | — | — | — | — | — |

---

## 3. Root-Cause Investigation 1: Why `resolveAndValidatePlanarPolygons` Scales Super-Linearly

### 3.1 Observed Scaling Trajectory (Confirmed)

Across `S1` $\to$ `S4` (`production-legacy` on Windows), planar surface resolution (`resolveAndValidatePlanarPolygons` in `src/world/PlanarLayerValidator.ts`) scales super-linearly with input polygon count $N$ and area $A$:

- **`S1`** ($N = 60$ polygons, $0.0625\text{ km}^2$): **`31.6 ms`** (`36.5%` of `86.4 ms` scene build)
- **`S2`** ($N = 271$ polygons, $0.25\text{ km}^2$, $4.52\times N$): **`267.7 ms`** ($8.48\times$ slower; `58.4%` of `458.1 ms` scene build)
- **`S3`** ($N = 857$ polygons, $1.00\text{ km}^2$, $3.16\times N$): **`2,297.6 ms`** ($8.58\times$ slower; `73.4%` of `3,131.7 ms` scene build)
- **`S4`** ($N = 2,102$ polygons, $4.00\text{ km}^2$, $2.45\times N$): **`11,020.2 ms`** ($4.80\times$ slower; **`76.3%`** of `14,448.1 ms` scene build; $349\times$ slower than `S1` for a $35\times$ increase in polygon count)

### 3.2 Exact Call-Site Breakdown Inside `resolveAndValidatePlanarPolygons` (Confirmed)

Instrumenting every `polygonClipping` call site (`intersection`, `difference`, `union`, `xor`) and non-Boolean operation inside `src/world/PlanarLayerValidator.ts` across `S1`–`S4` (single-iteration isolated profile) reveals **where** the time is actually spent:

| Call Site in `PlanarLayerValidator.ts` | Algorithmic Role | `S1` ($N=60$) Calls / Time (%) | `S2` ($N=271$) Calls / Time (%) | `S3` ($N=857$) Calls / Time (%) | `S4` ($N=2,102$) Calls / Time (%) | Avg Time / Call (`S1` $\to$ `S4`) |
|---|---|---:|---:|---:|---:|---:|
| **`intersection` @ L1394** (Stage 4 Validation) | Post-resolution $O(N^2)$ audit over carved `resolvedMultiPolygon` fills | `119` / `31.1 ms` (`16.8%`) | `655` / `390.4 ms` (`53.9%`) | `2,365` / `3,714.7 ms` (`69.7%`) | `5,751` / **`21,004.2 ms`** (**`85.6%`**) | `0.261 ms` $\to$ **`3.652 ms`** ($14.0\times$) |
| **`intersection` @ L1170** (Stage 2 Ownership) | Pairwise $O(N^2)$ overlap detection over pre-subtraction polygons | `133` / `40.1 ms` (`21.7%`) | `736` / `94.5 ms` (`13.1%`) | `2,467` / `629.4 ms` (`11.8%`) | `5,944` / **`1,187.9 ms`** (`4.8%`) | `0.302 ms` $\to$ `0.200 ms` |
| **`difference` @ L549** (`isGeometricallyContained` in Stage 2) | Called **twice** per overlapping pair (`isGeometricallyContained(a,b)` & `(b,a)` at L1182–1183) | `98` / `36.4 ms` (`19.6%`) | `452` / `74.1 ms` (`10.2%`) | `1,446` / `308.3 ms` (`5.8%`) | `3,370` / **`743.6 ms`** (`3.0%`) | `0.371 ms` $\to$ `0.221 ms` |
| **Non-Boolean CPU** (`computeDirectedBoundaryDistance` + ring conditioning) | `0.25 m` boundary step sampling (`L560`, `L621–622`) + `conditionRing` | — / `48.9 ms` (`26.4%`) | — / `120.2 ms` (`16.6%`) | — / `484.4 ms` (`9.1%`) | — / **`1,199.1 ms`** (`4.9%`) | — |
| **`difference` @ L1331** (Stage 3 Subtraction) | Actual Boolean subtraction (`node.mp - higherUnionMp`) | `13` / `4.2 ms` (`2.3%`) | `54` / `14.4 ms` (`2.0%`) | `134` / `48.9 ms` (`0.9%`) | `395` / **`185.6 ms`** (`0.8%`) | `0.326 ms` $\to$ `0.470 ms` |
| **`union` @ L1326** (Stage 3 Replacer Union) | Batch `polygonClipping.union(clipGeoms)` of higher-priority polygons | `6` / `3.3 ms` (`1.8%`) | `17` / `11.6 ms` (`1.6%`) | `45` / `52.0 ms` (`1.0%`) | `125` / **`139.8 ms`** (`0.6%`) | `0.557 ms` $\to$ `1.118 ms` |
| **`intersection` @ L1092** (Stage 1 Dedup/Union) | Same-category/subtype $O(N^2)$ overlap check | `20` / `8.2 ms` (`4.4%`) | `84` / `14.0 ms` (`1.9%`) | `300` / `88.9 ms` (`1.7%`) | `762` / **`80.0 ms`** (`0.3%`) | `0.411 ms` $\to$ `0.105 ms` |
| **`xor` @ L609 + `union` @ L1114** (Stage 1) | Duplicate confirmation & unnamed fragment union | `2` / `3.0 ms` (`1.6%`) | `6` / `1.6 ms` (`0.2%`) | `11` / `5.0 ms` (`0.1%`) | `14` / **`3.5 ms`** (`0.01%`) | — |

### 3.3 Four Compounding Mechanisms Behind the Superlinear Cost (Confirmed)

1. **Primary Bottleneck (`85.6%` of `S4` Planar Time): Stage 4 Post-Resolution Mutual-Exclusion Validation (`PlanarLayerValidator.ts` lines `1376–1421`)**:
   - Stage 3 actual Boolean subtraction (`union` at L1326 + `difference` at L1331) takes only **`325.4 ms` (`1.4%` of total time)** at `S4`!
   - By contrast, Stage 4 (`lines 1384–1421`) runs an unconditional $O(N^2)$ pairwise loop over all `activeResolved` polygons whose outer AABBs overlap (`5,751` pairs at `S4`), executing `polygonClipping.intersection(a.resolvedMultiPolygon, b.resolvedMultiPolygon)` (`line 1394`) inside the production `resolveAndValidatePlanarPolygons` path on every scene build.
   - **Why cost per intersection explodes $14\times$ (`0.261 ms` at `S1` $\to$ `3.652 ms` at `S4`)**: In Stage 3, macro landuse polygons have hundreds of smaller features (`parking`, `grass`, `flowerbed`, `playground`, `water`) carved out of them as interior holes:
     - At `S4`, `way/1156887567-0` (`landuse=residential`) is subtracted by **`434`** overlapping polygons, producing a single `resolvedMultiPolygon` with **`10` polygon components, `294` interior hole rings, and `4,060` vertices**.
     - `way/1279729432-0` (`landuse=retail`) is subtracted by **`247`** polygons, producing **`11` components, `111` hole rings, and `2,005` vertices**.
     - `way/1277818336-0` (`landuse=residential`) is subtracted by **`217`** polygons, producing **`9` components, `129` hole rings, and `1,942` vertices**.
   - Because the outer AABB of `way/1156887567-0` still spans the entire residential district, Stage 4's outer-AABB filter (`!doBoundingBoxesOverlap(a.bbox, b.bbox)` at `line 1388`) matches it against **all `434+` polygons inside its bounding box**. For each one, Martínez-Rueda sweep-line intersection (`polygonClipping.intersection`) must sweep all **`4,060` vertices and `294` hole rings** of the perforated residential MultiPolygon against the small feature—even though that small feature was *just* subtracted into an interior hole of `way/1156887567-0` in Stage 3!
2. **Secondary Bottleneck (`12.7%` of `S4` Planar Time): Stage 2 Unconditional Containment & Boundary-Step Checks (`lines 1158–1203` & `539–563`)**:
   - In Stage 2, for every pair $(a, b)$ whose outer AABBs overlap (`5,944` pairs at `S4`), after computing `inter = polygonClipping.intersection(a.mp, b.mp)` (`line 1170`, `1,187.9 ms`), lines `1182–1183` **unconditionally** call both:
     - `const aInB = isGeometricallyContained(a.mp, b.mp, a.area, b.area);`
     - `const bInA = isGeometricallyContained(b.mp, a.mp, b.area, a.area);`
   - Each call to `isGeometricallyContained` (`lines 539–563`) only checks `innerArea > outerArea * 1.001` (`line 546`) and **never checks whether `inner`'s AABB fits inside `outer`'s AABB** (note that `computeBBoxContainmentRatio` at `line 432` is defined in `PlanarLayerValidator.ts` but **never called anywhere**!). It then executes `polygonClipping.difference(inner, outer)` (`line 549`, `3,370` calls taking `743.6 ms` at `S4`) and, if small residual fragments remain, runs `computeDirectedBoundaryDistance(diffOut, outer, 0.25)` (`line 560`)—stepping every `0.25 m` along the boundary of `diffOut` and testing point-in-polygon + segment distance against every ring of `outer`.
   - Furthermore, `resolvePairwiseOutcome` (`lines 982–1035`) does not even use `aInB` or `bInA` when one polygon is `WATER_BODY` (`Rule 1`), when neither is `MACRO_LANDUSE` and classes differ (`Rules 3–4`), or when one polygon is larger than the other (`innerArea > outerArea`). Moreover, since `interArea = computeMultiPolygonArea(inter)` was *already* computed at `line 1175`, `a` can only be contained in `b` if `a.area - interArea <= 0.15`! Calling `polygonClipping.difference(a.mp, b.mp)` when `interArea < a.area - 0.15` is 100% redundant.
3. **Quadratic Outer-Loop Pair Selection (`lines 1080–1087`, `1158–1165`, `1384–1388`)**:
   - Stages 1, 2, and 4 each use $O(N^2)$ nested loops with AABB checks (`2,211,301` loop iterations per stage at `S4`) and Stage 3 recomputes `computeMultiPolygonBBox(wwMp)` inside the inner loop for every polygon × linear waterway pair (`line 1311`).
4. **In-Place MultiPolygon Mutation in Stage 1 (`lines 1113–1124`)**:
   - When two overlapping polygons have `bothUnnamedSameSubtype`, Stage 1 mutates `a.mp = unioned` and `a.bbox = computeMultiPolygonBBox(unioned)` in place during the $i, j$ scan, enlarging `a`'s bounding box and vertex count for all subsequent $j > i$ checks.

---

## 4. Root-Cause Investigation 2: Surface-First Road Candidate Blocker Search (`E2+`)

### 4.1 Observed Scaling Trajectory (Confirmed)

In `src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts` (`lines 3285–3295` and `2940–2958`), `surface-first-e2plus-rplus` (`roads: 'graph-surface'`) exhibits $O(R \cdot F)$ quadratic candidate blocker checks:

| Level | At-Grade Road Edges | Rendered Road Ribbons | `candidateBlockerCheckCount` | `overlappingBlockerCount` | Hit Rate (`Overlapping / Checked`) | `ownershipClippingTimeMs` (Windows Median) |
|---|---:|---:|---:|---:|---:|---:|
| **S1** (`250 m`) | `169` | `174` | `15,567` | `517` | `3.321%` (`96.68%` rejected) | `33.8 ms` |
| **S2** (`500 m`) | `627` | `633` | `203,206` | `2,015` | `0.992%` (`99.01%` rejected) | `299.0 ms` |
| **S3** (`1 km`) | `2,074` | `2,112` | **`2,254,714`** | **`6,523`** | **`0.289%`** (`99.71%` rejected) | **`1,118.1 ms`** |
| **S4** (`2 km`, isolated diagnostic) | `5,264` | `5,342` | **`14,418,060`** | **`15,888`** | **`0.110%`** (`99.89%` rejected) | **`3,074.0 ms`** (container) |

### 4.2 Code-Level Mechanics in `GraphRoadGeometryBuilder.ts` (Confirmed)

1. **Linear Scan Over All Previously Placed Footprints (`lines 3285–3295`)**:
   ```ts
   const ptsOnSurface = stroke.flatMap((polygon) => polygon.flat());
   const minX = Math.min(...ptsOnSurface.map((p) => p[0]));
   const maxX = Math.max(...ptsOnSurface.map((p) => p[0]));
   const minZ = Math.min(...ptsOnSurface.map((p) => p[1]));
   const maxZ = Math.max(...ptsOnSurface.map((p) => p[1]));
   const candidateBlockers = placedRoadFootprints.filter((fp) => {
     stats.candidateBlockerCheckCount++;
     return (
       fp.maxX > minX && fp.minX < maxX && fp.maxZ > minZ && fp.minZ < maxZ
     );
   });
   ```
   - Every at-grade road subsegment (processed in priority order: highest road class first, then `subId`) linearly scans the entire `placedRoadFootprints` array.
   - Note also lines `3285–3289`: for every subsegment, `stroke.flatMap((polygon) => polygon.flat())` allocates intermediate arrays and calls `Math.min(...ptsOnSurface.map(...))` four times (allocating 5 temporary arrays per subsegment and risking V8 call-stack overflow if a stroke ever exceeds ~65k vertices), instead of a single allocation-free `for` loop or using the AABB from `bufferSurfaceFirstRoadCenterline`.
   - At `line 3348`, `for (const poly of visible) registerRoadFootprint(sub.subId, isPath, [poly])` pushes one `PlacedRoadFootprint` entry per polygon component in `visible`.
2. **Breakdown of `ownershipClippingTimeMs` at `S3` and `S4` (Confirmed)**:
   - Profiling `ownershipClippingTimeMs` at `S3` (`1,059.6 ms` container) and `S4` (`2,888.9 ms` container) shows:
     - **`S3`**: `polygonClipping.difference` inside `clipSurfacePolygon` (`1,952` calls) takes **`917.0 ms` (`86.5%`)**, while the linear `placedRoadFootprints.filter` scan + `flatMap`/`Math.min` bbox computation (`2,254,714` checks) takes **`142.5 ms` (`13.5%`)**.
     - **`S4`**: `polygonClipping.difference` (`4,976` calls) takes **`2,300.2 ms` (`79.6%`)**, while the linear scan (`14,418,060` checks) takes **`588.8 ms` (`20.4%`)**.
3. **Spatial Hash / R-Tree Assessment (Confirmed Geometry & Provenance Invariance)**:
   - Because `candidateBlockers` is simply the subset of `placedRoadFootprints` satisfying the exact 2D AABB predicate `fp.maxX > minX && fp.minX < maxX && fp.maxZ > minZ && fp.minZ < maxZ`, indexing `placedRoadFootprints` in a deterministic 2D uniform spatial grid (e.g., `32 m × 32 m` cells, storing each footprint's monotonic insertion index `orderIdx` alongside its exact `minX, maxX, minZ, maxZ`) and sorting deduplicated candidate hits by `orderIdx` (or iterating `clipSurfacePolygon` over the exact same AABB-filtered set) is **mathematically guaranteed to return the exact same `candidateBlockers` array in the exact same insertion order**.
   - Consequently:
     1. Every call to `clipSurfacePolygon(stroke, candidateBlockers.map((b) => b.poly))` receives the **100% bit-identical argument list**.
     2. Output polygon rings, vertices, triangulated `BufferGeometry` buffers, `faceRanges` OSM provenance, and `diagnostics` counters remain **100% bit-for-bit identical**.
     3. Over `98%` of non-overlapping candidate checks are eliminated (`2,254,714` $\to$ `~25,000` at `S3`; `14,418,060` $\to$ `~75,000` at `S4`), saving `~140 ms` at `S3` and `~580 ms` at `S4` (and applying the same index to E2 ribbon clipping at `line 3443` and path-junction clipping at `line 3003`).

---

## 5. Root-Cause Investigation 3: Classification of Planar Validation Violations (`S2`: `3`, `S3`: `13`, `S4`: `46`)

### 5.1 Complete Violation Inventory & Distribution (Confirmed)

`resolveAndValidatePlanarPolygons` reports `0` violations at `S1`, **`3`** at `S2`, **`13`** at `S3`, and **`46`** at `S4`. All violations are emitted by Stage 4 (`PlanarLayerValidator.ts` line `1408`) when `residualArea > MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA` (`1e-4 m²` = `1.0 cm²`):

| Metric | `S1` (`250 m`) | `S2` (`500 m`) | `S3` (`1 km`) | `S4` (`2 km`) |
|---|---:|---:|---:|---:|
| **Total Violations (`> 0.000100 m²`)** | **`0`** | **`3`** | **`13`** | **`46`** |
| **Min Residual Overlap Area ($\text{m}^2$)** | — | `0.000156 m²` (`1.56 cm²`) | `0.000100 m²` (`1.00 cm²`) | `0.000100 m²` (`1.00 cm²`) |
| **Median Residual Overlap Area ($\text{m}^2$)** | — | `0.000205 m²` (`2.05 cm²`) | `0.000205 m²` (`2.05 cm²`) | `0.000222 m²` (`2.22 cm²`) |
| **Max Residual Overlap Area ($\text{m}^2$)** | `0.000088 m²` | `0.000343 m²` (`3.43 cm²`) | `0.001259 m²` (`12.59 cm²`) | `0.002057 m²` (`20.57 cm²`) |
| **Stage 3 `polygonClipping.difference` Exceptions (`catch` at L1337)** | `0` | `0` | `0` | `0` |

### 5.2 Exact Root-Cause Classification (Confirmed)

By comparing the raw output of `polygonClipping.difference(node.mp, higherUnionMp)` (`line 1331`) *before* and *after* `filterDegenerateBooleanArtifacts(diff)` (`line 1335`) across every violating pair in `S2`, `S3`, and `S4`, all violations classify deterministically into **two root-cause categories** (with **zero** unhandled Stage 3 Boolean exceptions):

#### Category A — Post-Difference Ring Conditioning & `0.1 mm` Grid Snapping Slivers (`3 / 3` at `S2`, `11 / 13` at `S3`, `41 / 46` at `S4`)

- **Mechanism**:
  1. In Stage 2, polygon $A$ (e.g., `way/1156887567-0` `residential` or `way/1279729432-0` `retail`) and polygon $B$ (e.g., `way/440413738-0` `parking`, `way/1442814651-0` `flowerbed`, `way/1444115789-0` `meadow`) are correctly identified as overlapping, and $B$ is added to $A$'s `higherOverlappingIds`.
  2. In Stage 3 (`line 1331`), `diff = polygonClipping.difference(node.mp, higherUnionMp)` cleanly subtracts $B$ from $A$.
     - **Verification**: For all `3/3` subtracted pairs in `S2`, all `11/11` subtracted pairs in `S3`, and `38/41` subtracted pairs in `S4`, the raw output `diff` of `polygonClipping.difference` has **`0.000000 m²`** overlap with $B$ (and for the remaining `3/41` in `S4` where `higherUnionMp` merged $27\text{–}217$ replacers at `line 1326`, `rawDiff` had `0.000060–0.000087 m²`, which is still **below** the `0.000100 m²` validator threshold!).
  3. Immediately after `polygonClipping.difference`, line `1335` runs `finalMp = filterDegenerateBooleanArtifacts(diff)`, which calls `conditionRing(ring)` (`lines 169–248`) on every outer and interior hole ring:
     - `conditionRing` snaps every vertex created by `polygonClipping.difference` to a `1e-4 m` (`0.1 mm`) grid (`snapCoord`) and iteratively strips vertices where either adjacent segment is `< 1e-3 m` (`1 mm`) or where the cross-product `|cross| < 1e-4 * lenPrev * lenNext` (`lines 213–221`).
     - When `conditionRing` drops a nearly-collinear vertex or snaps an intersection vertex along a `10–30 m` carved hole edge, that long edge shifts laterally by `0.05–0.15 mm` across the boundary of the replacer polygon $B$, creating a micro-sliver overlap of:
       $$\text{Area} \approx \frac{1}{2} \times (10\text{–}25\text{ m}) \times (0.05\text{–}0.15\text{ mm}) \approx 0.000100\text{–}0.002057\text{ m}^2\text{ (}1\text{–}20\text{ cm}^2\text{)}$$
- **Same-Elevation vs. Cross-Elevation Sub-Cases in Category A**:
  - **Sub-Case A1 (Same-Elevation Coplanar Landuse/Park Pairs: `2` at `S2`, `8` at `S3`, `35` at `S4`)**: Both polygons share `elevationY = 0.025 m` (`LANDUSE_BASE`). They represent real (though microscopic, $1\text{–}20\text{ cm}^2$) post-conditioning boundary-shift overlaps introduced by `conditionRing` after `polygonClipping.difference`.
  - **Sub-Case A2 (Cross-Elevation Land vs. Water Pairs: `1` at `S2`, `3` at `S3`, `6` at `S4`)**: e.g., `way/1156887567-0` (`residential`, `y = 0.025 m`) vs. `way/1444115733-0` (`stream`, `y = 0.015 m`) or `way/804746541-0` (`platform_area`, `y = 0.025 m`) vs. `way/628359149-0` (`water`, `y = 0.015 m`). Even though these layers have a full `10 mm` (`0.010 m`) vertical separation (`WATER_DEPRESSION = 0.015 m` vs. `LANDUSE_BASE = 0.025 m`), Stage 3 intentionally subtracts `WATER_BODY` from landuse so landuse does not roof over depressed water (`Rule 1`, `lines 982–990`), and Stage 4 enforces 2D fill mutual exclusion across all resolved polygons regardless of elevation.

#### Category B — Stage 2 Minimum Overlap Threshold vs. Stage 4 Validator Threshold Mismatch (`0` at `S2`, `2 / 13` at `S3`, `5 / 46` at `S4`)

- **All `2` instances at `S3` and all `5` instances at `S4`**:
  - `way/47150554-0` (`grass`, `y = 0.025 m`) vs. `way/1534926184-0` (`water`, `y = 0.015 m`): overlap = `0.000100 m²`
  - `way/1547763789-0` (`grass`, `y = 0.025 m`) vs. `way/1534926184-0` (`water`, `y = 0.015 m`): overlap = `0.000163 m²`
  - `way/47150592-0` (`grass`, `y = 0.025 m`) vs. `way/1177248247-0` (`water`, `y = 0.015 m`): overlap = `0.000396 m²` (`S4`)
  - `way/1443948012-0` (`grass`, `y = 0.025 m`) vs. `way/1465135475-0` (`water`, `y = 0.015 m`): overlap = `0.000150 m²` (`S4`)
  - `way/1576543385-0` (`grass`, `y = 0.025 m`) vs. `way/1576543384-0` (`water`, `y = 0.015 m`): overlap = `0.000160 m²` (`S4`)
- **Mechanism (Threshold Discrepancy in `PlanarLayerValidator.ts`)**:
  - In **Stage 2** (`line 1176`), two polygons are only considered overlapping if:
    $$\text{interArea} > \text{MIN\_OVERLAP\_AREA\_SQ\_METERS} = \mathbf{0.01\text{ m}^2}\text{ (line 138)}$$
    Because these adjacent riverbank `grass` and `water` polygons share a slightly grazed boundary of `0.000100–0.000396 m²` (`< 0.01 m²`), Stage 2 **skips** them (`if (interArea <= MIN_OVERLAP_AREA_SQ_METERS) continue;` at `line 1176`), so neither subtracts the other in Stage 3 (`aSubB = false, bSubA = false`).
  - However, in **Stage 4** (`line 1408`), the validator flags a violation whenever:
    $$\text{residualArea} > \text{MAX\_ALLOWED\_SURFACE\_FILL\_OVERLAP\_AREA} = \mathbf{0.0001\text{ m}^2}\text{ (line 144)}$$
  - Thus, **any** pair of source polygons whose raw 2D overlap falls in the $100\times$ gap $(0.0001\text{ m}^2, 0.01\text{ m}^2]$ is ignored by Stage 2 conflict resolution (`<= 0.01 m²`) and then unconditionally flagged as a failure by Stage 4 (`> 0.0001 m²`)!

---

## 6. Benchmark Measurement Reliability Audit

### 6.1 Duplicate Stage Execution Per Iteration in `benchmarks/scalingWorker.ts` (Confirmed)

- **Finding**: In `benchmarks/scalingWorker.ts` (`lines 366–426`), each measured iteration executes:
  1. Step 1 (`line 368`): `dataset.parseInput()`
  2. Step 2 (`line 375`): Standalone `resolveAndValidatePlanarPolygons(...)` to record `planarSurfaceResolutionMs`
  3. Step 3 (`line 388`): `prepareInfrastructureRenderPreview(...)`
  4. Step 4 (`line 398`): `dataset.parseInput()` + standalone `buildRailwayInfrastructure(...)` to record `railwayGeometryGenerationMs`
  5. Step 5 (`line 424`): `builder.buildScene(parsedData, theme)` — which internally calls **`resolveAndValidatePlanarPolygons` a second time** (`GeometryBuilder.ts` line `2106`) and **`buildRailwayInfrastructure` a second time** (`GeometryBuilder.ts` line `2259`)!
- **Impact**:
  - Every measured iteration executes `resolveAndValidatePlanarPolygons` **twice**, `buildRailwayInfrastructure` **twice**, and `dataset.parseInput()` **twice**.
  - Across `1` warmup + `3` measured iterations, `resolveAndValidatePlanarPolygons` runs **`7` times per workload** (`1` in warmup + `2 × 3 = 6` in measured iterations).
  - At `S4`, where a single planar call takes `11.02 s` and `fullSceneGeometryGenerationMs` takes `14.45 s` (legacy) or `~20–24 s` (`graph-e2-e3` / `surface-first-e2plus-rplus`), running planar resolution twice per iteration adds **`~33–45 s` of duplicate CPU work** to the worker's `120 s` wall-clock timeout budget. This directly explains why `graph-e2-e3` and `surface-first-e2plus-rplus` timed out during `iter_3_planar` (`96.5 s` and `98.3 s` last heartbeat) even though each individual scene build was under `25 s`!
- **Remediation**: Expose `planarSurfaceResolutionMs` and `railwayGeometryGenerationMs` directly on `GeometryBuilder.buildScene()` (just as `legacyRoadTimingMs` and `graphRoadTiming` are already recorded on `roadsGroup.userData`) so each measured iteration runs `parseInput()` once and `buildScene()` once.

### 6.2 Nested / Double-Counted Road Substage Accounting (`roadSubStagesMs`) (Confirmed)

- **Finding 1 (`surface-first` double-counting of `polygonUnionMs` inside `footprintConstructionMs`)**:
  - In `src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts` (`lines 3928–3931`):
    ```ts
    timing.primitiveConstructionTimeMs = bufferInstrumentation.primitiveConstructionTimeMs;
    timing.polygonUnionTimeMs = bufferInstrumentation.polygonUnionTimeMs;
    timing.footprintConstructionTimeMs =
      bufferInstrumentation.primitiveConstructionTimeMs + bufferInstrumentation.polygonUnionTimeMs;
    ```
  - Because `footprintConstructionTimeMs` is defined as the **sum** of `primitiveConstructionTimeMs + polygonUnionTimeMs`, while `roadSubStagesMs` (`benchmarks/scalingWorker.ts` lines `437–440`) emits both `footprintConstructionMs` and `polygonUnionMs` side-by-side without `primitiveConstructionMs`, summing the four reported sub-stages double-counts `polygonUnionTimeMs`!
  - **Evidence from Windows `S3` (`surface-first-e2plus-rplus`)**:
    - `footprintConstructionMs` median = `812.4 ms` (`primitiveConstructionTimeMs` + `polygonUnionTimeMs`)
    - `polygonUnionMs` median = `788.5 ms` (already included inside `812.4 ms`!)
    - `ownershipClippingMs` median = `1,118.1 ms`
    - `triangulationAndValidationMs` median = `144.9 ms`
    - Naive sum = `812.4 + 788.5 + 1,118.1 + 144.9 = 2,863.9 ms` vs. actual `roadGeometryGenerationMs = 2,166.1 ms` (`2,863.9 - 788.5 = 2,075.4 ms`, leaving `~90.7 ms` for edge filtering/portal setup).
- **Finding 2 (`graph-e2-e3` reports `0.0 ms` for all four `roadSubStagesMs` fields)**:
  - In `GraphRoadGeometryBuilder.ts`, `timing.footprintConstructionTimeMs`, `timing.polygonUnionTimeMs`, `timing.ownershipClippingTimeMs`, and `timing.triangulationAndValidationTimeMs` are only incremented inside the `if (surfaceFirst)` branch (`lines 3255–3388` and `3919–3931`).
  - When `roads === 'graph'` (`graph-e2-e3`), those timers remain initialized at `0`, so `scalingWorker.ts` records `[0, 0, 0]` for all four sub-stages instead of either timing the E2 junction/ribbon stages or marking `roadSubStagesMs` as `null` (`unsupportedMetrics`) for non-`graph-surface` modes.

### 6.3 Why `gcExposed: false` and `gcInvokedBeforeRun: false` Occurred (Confirmed)

- **Finding**:
  1. In `benchmarks/scalingRunner.ts` (`line 673`), `collectHostEnvironmentMetadata()` runs in the **parent** runner process (`npx tsx benchmarks/scalingRunner.ts`), which is invoked by the user without `--expose-gc`, so `environment.gcExposed` is `false`.
  2. In `runIsolatedScalingWorkload` (`benchmarks/scalingRunner.ts` lines `322–326`), the child worker is spawned via `spawn(process.execPath, ['--expose-gc', '--max-old-space-size=...', tsxCli, workerScriptPath, ...])`. Because `tsx`'s CLI entry point (`node_modules/tsx/dist/cli.mjs`) spawns its own inner Node child process to attach the ESM loader and only forwards V8 flags passed via `NODE_OPTIONS` (or after inspecting flags), passing `--expose-gc` to the outer wrapper process does not expose `global.gc` in the inner `scalingWorker.ts` process unless `NODE_OPTIONS="--expose-gc --max-old-space-size=..."` is also set in `env`.
- **Impact**: `workerV8Heap.gcInvokedBeforeRun` was `false` in all child workers, which also contributed to V8 heap-compaction pauses during measured iterations (see Section 6.4).

### 6.4 Timing Variability Across Measured Iterations (Confirmed)

- **Finding**: While `production-legacy` had very low timing variability (`CV = 1.5%–3.0%` for scene build across `S1`–`S4`), `graph-e2-e3` and `surface-first-e2plus-rplus` exhibited higher iteration-to-iteration variance at `S2` and `S3`:
  - e.g., `S3` `graph-e2-e3` `planarSurfaceResolutionMs` samples: `[5541.0 ms, 2454.7 ms, 2359.6 ms]` (`CV = 52.4%`);
  - `S3` `surface-first-e2plus-rplus` `roadGeometryGenerationMs` samples: `[917.1 ms, 2359.2 ms, 2166.1 ms]` (`CV = 43.2%`).
- **Root Causes**:
  1. Without `global.gc()` between iterations (`gcInvokedBeforeRun: false`) and with duplicate planar/railway executions per iteration allocating millions of short-lived array/vertex objects in `polygon-clipping`, major V8 Mark-Sweep-Compact garbage collection cycles land asynchronously inside individual stage timers.
  2. On `S4`, `--max-old-space-size-mb=2048` combined with duplicate stage runs pushed V8 near its old-space threshold during later iterations, increasing GC frequency.

### 6.5 Missing Partial Results from Timed-Out Workloads (Confirmed)

- **Finding**: In `benchmarks/scalingWorker.ts` (`lines 361–955`), the worker accumulates `parseSamples`, `planarSamples`, `fullSceneSamples`, etc. in local arrays across all `measuredIterations` (`i = 0, 1, 2`) and only sends a single `process.send({ type: 'result', result })` message **after** the loop finishes (`line 942`).
- **Impact**: When `S4` `graph-e2-e3` and `S4` `surface-first-e2plus-rplus` timed out at `120 s` during `iter_3_planar`, both workers had already **completed Warmup, Iteration 1, and Iteration 2** (including `2` full measured scene builds!), plus `iter_3_parse`. Because the parent killed the worker on timeout before `line 942`, all completed iteration timings (`timingsMs`) and memory snapshots from Iterations 1 and 2 were discarded (`null`).
- **Remediation**: Emit an IPC `iteration_completed` message at the end of each measured iteration (and run the lightweight geometry/operation counter capture on Iteration 1 so it is already available if Iteration 2 or 3 times out), allowing `scalingRunner.ts` to preserve partial iteration samples (`completedIterationsCount < measuredIterations`) whenever a timeout occurs.

---

## 7. Prioritized Follow-Up Optimization Proposal (`TKT-020`)

Based on the empirical evidence above, we do **not** need speculative streaming, tiling, or a broad renderer rewrite to unlock `S4` (`2 × 2 km`) across all configurations and drastically reduce `S3`/`S4` build times. Instead, we have filed **`TKT-020`** (*Planar Surface Resolution & Road Blocker Spatial Index Optimization*) as a narrowly scoped, geometry-preserving optimization ticket targeting the three highest-value bottlenecks discovered in `TKT-019`:

### Scope of `TKT-020` (`tickets/TKT-020-planar-surface-and-road-blocker-scaling-optimization.md`)

1. **Planar Surface Resolution (`src/world/PlanarLayerValidator.ts`) — Target `>75%` Reduction in `planarSurfaceResolutionMs` at `S3`–`S4`**:
   - **Precomputed Spatial Indexing**: Replace the quadratic $O(N^2)$ outer loops in Stages 1, 2, and 4 (and per-pair waterway AABB recomputation in Stage 3) with a deterministic 2D uniform spatial grid index (`64 m` cells) preserving canonical index order `(i, j)` with $i < j$.
   - **Stage 2 Fast Containment Guards**: Before calling `isGeometricallyContained(a.mp, b.mp)` (`polygonClipping.difference` + `0.25 m` boundary stepping), check:
     1. Whether `resolvePairwiseOutcome` actually depends on containment for `(a.semanticClass, b.semanticClass)` (skip containment when `WATER_BODY` is involved or when classes have fixed non-macro precedence).
     2. Whether `a.area - interArea <= CONTAINMENT_TOLERANCE_SQ_M` (`0.15 m²`) and whether `a.bbox` fits inside `b.bbox` (`computeBBoxContainmentRatio`). Since `interArea` is already computed at `line 1175`, this eliminates `>90%` of the `3,370` `polygonClipping.difference` calls in Stage 2 with **100% identical** `aInB`/`bInA` boolean outcomes!
   - **Stage 4 Post-Resolution Validation Option & Component-BBox Indexing**:
     1. Make Stage 4's expensive $O(N^2)$ post-resolution `polygonClipping.intersection` audit configurable (`validateResolvedFills?: boolean`, defaulting to `true` in unit tests / diagnostic audits or accelerated via component-level AABB indexing rather than perforated macro-polygon outer AABBs, and avoiding duplicate execution during scene build).
2. **Road Candidate Blocker Spatial Index (`src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`) — Target `>98%` Reduction in `candidateBlockerCheckCount`**:
   - Index `placedRoadFootprints` in a deterministic 2D uniform spatial grid (`32 m` cells) that returns overlapping footprints in exact insertion order, and replace `stroke.flatMap(...).map(...)` + `Math.min(...)` with a single-pass allocation-free bounding-box loop.
   - Reduces `S3` candidate checks from `2,254,714` to `~25,000` and `S4` candidate checks from `14,418,060` to `~75,000` while keeping `overlappingBlockerCount`, clipped polygons, triangles, and OSM provenance **100% bit-identical**.
3. **Scaling Benchmark Reliability Fixes (`benchmarks/scalingWorker.ts`, `benchmarks/scalingRunner.ts`)**:
   - Eliminate duplicate standalone executions of `resolveAndValidatePlanarPolygons` and `buildRailwayInfrastructure` per iteration in `scalingWorker.ts` by reading stage timings directly from `GeometryBuilder.buildScene()`.
   - Forward `--expose-gc` and `--max-old-space-size` via `NODE_OPTIONS` so `globalThis.gc` is genuinely exposed (`gcExposed: true`, `gcInvokedBeforeRun: true`).
   - Fix `roadSubStagesMs` accounting so `primitiveConstructionMs` and `polygonUnionMs` are not double-counted inside `footprintConstructionMs`, and mark `roadSubStagesMs` as `null` (`disabled_by_config`) when `roads === 'graph'`.
   - Stream completed iteration samples over IPC so partial results from completed iterations are preserved if a later iteration hits `timeoutMs`.

### Strict Geometry-Equivalence & Regression Requirements for `TKT-020`

- **100% Geometry & Provenance Equivalence**: Across `S1`, `S2`, and `S3` (and existing unit-test fixtures), `TKT-020` must produce the exact same `renderedFeaturesCount`, `constructedMeshesCount`, `totalVertices`, `totalTriangles`, `cpuBufferMemory.totalBytes`, `overlappingBlockerCount`, and `unattributedMeshFacesCount = 0`.
- **No Validator Suppression**: Do not weaken `MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA` (`1e-4 m²`) or silently hide the `S2` (`3`), `S3` (`13`), and `S4` (`46`) planar violations; track the Stage 2 (`0.01 m²`) vs. Stage 4 (`0.0001 m²`) threshold alignment and post-difference ring conditioning separately where geometry semantics would change.
