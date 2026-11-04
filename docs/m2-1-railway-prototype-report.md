# Milestone 2.1 Deliverable: Performance Baseline & Isolated Railway Prototype Evaluation (`TKT-002`)

> **Status**: In Review — Candidate B Runtime Performance Validated (Amsterdam Central runs smoothly at ~144 FPS on user machine); Ready for M2.1 Decision Gate Sign-Off  
> **Ticket**: [`TKT-002`](../tickets/TKT-002-m2-1-performance-baseline-and-railway-prototype.md) (Blocks [`TKT-001`](../tickets/TKT-001-railway-overlap-brightness-and-sleeper-regression.md) / M2.2)  
> **Date**: 2026-11-03  
> **Scope**: Reproducible Goalpost 1 performance baseline + isolated side-by-side experimental evaluation of **Candidate A** (Pure Procedural Multi-Layer UV Ribbons) vs. **Candidate B** (Hybrid Close-Zoom 3D Extruded Geometry + Medium/Far Procedural UV Ribbons). Neither candidate is approved for production integration prior to formal M2.1 gate review.

---

## 1. Executive Summary & Review Scope

Milestone 2.1 (`TKT-002`) establishes a reproducible 7-metric performance and lifecycle baseline for Goalpost 1 and evaluates two isolated railway-rendering candidates (`src/world/prototype/`) across four canonical track-topology zones, multiple zoom levels, rotated camera azimuths, all four map themes (`tactical`, `daylight`, `dusk`, `blueprint`), and real OpenStreetMap extracts (`Station Hengelo` and `Amsterdam Centraal`), without modifying the production road, bridge, tunnel, or barrier subsystems in `GeometryBuilder.ts`.

Per review instructions, **Candidate B is the leading visual direction** due to its physical 3D sleeper and rail definition at close range, while **Candidate A remains an active comparison point**. Neither candidate is documented as an accepted production architecture; this evaluation provides rigorous geometric, algorithmic, performance, and visual evidence to inform the M2.1 decision gate.

### 1.1 Resolution of Candidate B Runtime Performance
A central focus of the M2.1 review was establishing whether Candidate B's physical 3D geometry is computationally viable on large real-world terminal networks like Amsterdam Centraal.

- **Manual Runtime Observation**: **Amsterdam Central runs smoothly at approximately 144 FPS on the user's machine.**
  - *Measurement Classification*: This is explicitly classified as a **manual observation** on a 144 Hz display, distinct from headless container rasterization or automated timers. No unrecorded hardware specifications, camera parameters, or test conditions have been inferred.
  - *Decision Impact*: **Candidate B's runtime performance is no longer considered a blocker for Milestone 2.1.** Optimized Candidate B delivers sufficiently good observed runtime responsiveness for this milestone.
- **Architectural Grounding (Pre-Baked Static Maps)**: Production architecture assumes pre-baked static maps; offline map preparation time is secondary, whereas runtime rendering efficiency, GPU resource usage, and scene responsiveness are primary.
- **Quantified Optimization Gains on Amsterdam Centraal (420m Radius, 383 Railways)**:
  1. **Railway Offline Generation Time**: Reduced from **29,002 ms → 673 ms** (a **43.1× speedup**; or **1,290 ms → 673 ms** against Goalpost 1 baseline).
  2. **Railway Geometry Buffer Memory**: Reduced from **63.68 MB → 7.75 MB** (an **87.8% reduction**).
  3. **Node-Side Feature Inspection Latency**: Reduced from **156.12 ms → 4.03 ms median** (tested against the isolated railway group).
  4. **Station Throat Frustum Culling**: **59.4%** of railway triangles culled during close inspection (`zoom = 8.0`) via 128 m static spatial chunks.

### 1.2 Key Profiling Caveats & Measurement Distinctions
To maintain complete scientific honesty and avoid overstating benchmark proofs:
1. **Inspection Profiling Scope (`hoverRaycastTimeMs`)**: In live WebGL telemetry, `hoverRaycastTimeMs` strictly measures `resolveInspectedFeature()` feature-info extraction once an intersection occurs; it does *not* represent the complete scene-wide CPU raycasting traversal executed by React Three Fiber across all scene objects.
2. **Node-Side Inspection Benchmark Scope**: The reported **4.03 ms** raycast latency is a Node-side measurement (`evaluateFrustumAndRaycastAtPose`) traversing only the isolated railway group; it is not the full browser R3F raycast across all map layers.
3. **Automated Scenario Timer Caveat**: Timings recorded via `requestAnimationFrame` followed by `setTimeout(16)` in `runCameraScenario()` are synthetic polling loops that cannot reliably measure browser frame intervals (particularly on 144 Hz displays). They are never presented as proof of true browser frame times.
4. **Distinction of Costs**: This report strictly separates:
   - *Offline Generation Cost* (CPU build time, spatial index construction, bridge sampling).
   - *Baked Asset / Buffer Footprint* (vertex/triangle counts, CPU buffer memory, estimated binary size).
   - *Runtime Rendering Performance* (frustum culling, active draw calls, manual 144 FPS observation).

### 1.3 Deferred Finding: Non-Railway Building Draw-Call Amplification
During controlled baseline isolation on Amsterdam Centraal (`420m`), Configuration A (railway rendering disabled) was found to issue **2,537 WebGL draw calls per frame** (2,480 `gl.drawArrays` calls) despite containing only 57 `THREE.Mesh` objects. Investigation revealed that `THREE.ExtrudeGeometry` creates 2 `BufferGeometry.groups` per building (`613 × 2 = 1,226` groups), which `mergeWithFaceRanges()` in `src/world/GeometryBuilder.ts` preserves onto merged building meshes even with a single material. `WebGLRenderer` renders each group individually in both the directional shadow pass and camera pass (`1,226 × 2 = 2,452` calls).
- *Disposition*: Documented as a known, deferred rendering-optimization finding for future milestones; strictly **out of scope for M2.1**.

### 1.4 Key Resubmission Achievements
1. **Topology-Aware Sleeper Construction & Closely Spaced Track Conflict Resolution in Candidate B**:
   - Replaced previous binary clearance sleeper deletion and single-interval clipping with a topology-aware multi-track sleeper placement and conflict-resolution pipeline in `src/world/prototype/RailwayPrototypeBuilder.ts`:
     - **Turnout-Throat vs. Parallel-Track Classification (`isTurnoutThroatPair`)**: Evaluates strictly interior perpendicular distances across a $\pm 8\text{ m}$ longitudinal window to distinguish genuine converging/diverging turnout throats ($\le 1.68\text{ m}$ switch-merge proximity or $\Delta d / \Delta s \ge 0.022$ convergence slope) from independent closely spaced parallel tracks.
     - **Explicit Structural Track Association (`supportedTrackIds`)**: Each `SleeperBearerBox3D` records the explicit list of track IDs (`[r.id, ...sharedPartners]`) it structurally and geometrically supports. An adjacent parallel track's sleeper is never counted as support for another track's rails.
     - **Elongated Shared Turnout Bearers & Third-Track Midpoint Capping**: In genuine turnout throats (`cosAngle > 0.86`, `absDist <= 2.28 m`, `isTurnoutThroatPair`), host sleepers elongate across the diverging track (`nb.absDist + nb.gaugeCenterOffset + 0.40 m`, up to `4.90 m` max width) while capping at the inter-track midpoint (`0.5 * (nb.absDist + nbOuter.absDist) - 0.024 m`) if a third uncovered track runs alongside.
     - **Order-Independent Symmetric Midpoint Bounding & Multi-Interval Clipping**: When closely spaced non-shared tracks ($1.68\text{ m} < D < 2.56\text{ m}$) run side by side, each track symmetrically bounds its lateral overhang toward the neighbor at the inter-track midpoint ($D/2 - \text{gap}$). In Step B, nearest-station host resolution (`minDAlong <= period * 0.62`), list-based multi-interval subtraction (`subtractIntervalFromList` with `0.26 m` rail-seat / `0.38 m` general minimum width), and small longitudinal phase shifts (`±0.18 m, ±0.32 m`) preserve per-rail support without inter-track overlaps.
   - **Automated Geometric Acceptance & Regression Suite**: `src/world/PerformanceBaseline.test.ts` confirms **0 unsupported rails** across 130 rails in the 65-way benchmark, maximum unsupported span **1.200 m** (well below the `1.65 m` tolerance), **0 inter-track 2D OBB sleeper overlaps**, and **416 shared turnout bearers** constructed, plus deterministic regression coverage across straight, concentric curved, and short-chained parallel tracks, a 5-track competing corridor, and a 3-track turnout + parallel throat.
2. **Close-Zoom Sleeper Density & Harmonic Alignment**:
   - Evaluated `0.60 m` physical specification, `0.725 m` half-harmonic default, and `1.45 m` procedural period.
   - Candidate B adopts `0.725 m` close-zoom spacing (half of the `1.45 m` procedural UV period), eliminating close-zoom sparseness while maintaining exact 2:1 harmonic phase alignment that minimizes visual popping during LOD transitions.
3. **Controlled Candidate B Optimizations**:
   - Implemented 5 focused optimizations: uniform 8m spatial grid index, adaptive bridge deck sampling, multi-interval sleeper clipping, `THREE.InstancedMesh` 3D sleepers, and 128m static spatial chunking with frustum culling.
4. **LOD Transition Quantification**:
   - Measured empirical visual deltas over a continuous zoom sweep (`4.3` to `4.7`): Candidate B's cross-representation delta (0.71% mean grayscale change, 2.99% pixels changed > 8%) is comparable to Candidate A's normal camera zoom delta over the same span (0.53% mean change, 2.43% pixels changed). Same-zoom representation delta at `zoom = 4.6` is 0.30% mean grayscale difference.
5. **Benchmark Integrity & Single Source of Truth**:
   - All benchmark metrics derive strictly from [`docs/m2-1-baseline-data.json`](./m2-1-baseline-data.json). Timings report medians across 5 runs, distinguishing Node CPU builds from headless browser WebGL telemetry.

---

## 2. Priority Investigation: Candidate B Missing Sleepers, Turnout Bearers & Closely Spaced Tracks

### 2.1 Diagnosis of Prior Sleeper Suppression & Competing Track Conflicts
In the initial Candidate B prototype and subsequent multi-track inspections, missing sleepers occurred in two distinct topological regimes inside `src/world/prototype/RailwayPrototypeBuilder.ts`:

1. **Binary Centerline-Clearance Suppression in Switch Throats (Initial Prototype)**:
   - The original prototype queried `HostTrackSpatialIndex.queryMinDistanceToHostCenterline(samplePoint)` and discarded the *entire* sleeper whenever the perpendicular centerline distance fell below `1.16 m`. Because $1:9$ to $1:12$ turnouts diverge at $4.76^{\circ}$ to $6.34^{\circ}$, a branch centerline stays within $1.16\text{ m}$ of the host centerline for $\approx 12.0\text{ m}$ longitudinally, leaving a **6.5 m to 8.7 m unsupported gap** beneath the diverging outer rail.
2. **False Turnout-Bearer Classification on Independent Parallel Tracks ($1.85\text{ m} \le D \le 2.28\text{ m}$)**:
   - When shared turnout bearers were first introduced, Step A elongated a host sleeper whenever `nb.cosAngle > 0.86 && nb.absDist <= 2.28`. Because parallel tracks have $\cos\theta \approx 1.0 > 0.86$, independent parallel tracks spaced $\le 2.28\text{ m}$ apart were misclassified as turnout throats, causing the higher-priority track to elongate across the second track and suppress all of the second track's own sleepers.
3. **Asymmetric Full-Width (`±1.25 m`) Corridor Subtraction on Adjacent Tracks ($1.85\text{ m} \le D \le 2.50\text{ m}$)**:
   - When closely spaced tracks did not share a turnout bearer, the first-processed track placed a full $2.50\text{ m}$ sleeper (`±1.25 m`) and subtracted `±1.28 m` from the adjacent track in Step B1. That cut intruded to $D - 1.28\text{ m}$ from the second track's centerline—clipping away its inner rail seat ($\pm 0.8175\text{ m}$) or, when an interior track was flanked on both sides in a multi-track corridor, shrinking its remaining interval below minimum width and discarding the sleeper entirely.
4. **Turnout-to-Parallel Transition Suppression & Three-Track Throat Intrusion**:
   - Accumulating host box coverage over a wide longitudinal window (`dAlong <= period * 1.15`, or $0.834\text{ m} > 0.725\text{ m}$) caused the last elongated bearer inside a turnout throat to reach forward one period and suppress the branch track's first independent sleeper after divergence. Similarly, in 3-track throats where a turnout diverged next to a third closely spaced parallel mainline, an uncapped turnout bearer (`nb.absDist + nb.gaugeCenterOffset + 0.40 m`) intruded into the third track's inner rail seat.

### 2.2 Current Topology-Aware Sleeper Placement & Conflict-Resolution Pipeline
To support both shared turnout throats and closely spaced independent tracks without order-dependent sleeper starvation, `src/world/prototype/RailwayPrototypeBuilder.ts` implements a unified geometric and structural pipeline:

```
   CASE 1: GENUINE TURNOUT THROAT (cosAngle > 0.86, absDist <= 2.28m, isTurnoutThroatPair = true)
   ==============================================================================================
   Host Rail L        Host Rail R            Branch Rail L         Branch Rail R      [3rd Track Capped]
        |                  |                        \                     \                  |
   ========================================================================  |====== 3rd Track ======|
   Shared Bearer: supportedTrackIds = [hostId, branchId], capped at midpoint to any 3rd track (nbOuter)

   CASE 2: INDEPENDENT CLOSELY SPACED PARALLEL TRACKS (1.68m < absDist < 2.56m, isTurnoutThroatPair = false)
   =========================================================================================================
   Track 1 Rail L     Track 1 Rail R      Midpoint      Track 2 Rail L     Track 2 Rail R
         |                  |                 :               |                  |
   |===== Track 1 Sleeper =====|              :         |===== Track 2 Sleeper =====|
   Bounded symmetrically at (D/2 - gap)       :         Bounded symmetrically at (D/2 - gap)
```

1. **Explicit Structural Track Association (`supportedTrackIds`)**:
   - Every `SleeperBearerBox3D` carries `trackId` (the generating track) and `supportedTrackIds: string[]` (`[r.id, ...sharedPartnerIds]`).
   - A sleeper box is only treated as supporting a track's rails—both during Step B1 suppression and in geometric acceptance tests—if that track's ID is explicitly present in `supportedTrackIds`. An arbitrary nearby sleeper from an adjacent parallel track is never counted as structural support.
2. **Turnout-Throat vs. Independent Parallel-Track Classification (`isTurnoutThroatPair`)**:
   - For any pair of tracks with shallow relative angle ($\cos\theta > 0.86$) and lateral separation $|d| \le 2.28\text{ m}$, `isTurnoutThroatPair()` samples strictly interior perpendicular distances along the neighboring track within a $\pm 8\text{ m}$ window around station $s$.
   - The pair is classified as a genuine turnout throat only if their centerlines are within physical switch-merge proximity ($|d| \le 1.68\text{ m}$) or their perpendicular separation actively converges/diverges with longitudinal slope $(\max d - \min d) / \Delta s \ge 0.022$.
   - Straight, concentric curved, and chained short-segment parallel tracks maintain constant perpendicular separation ($\Delta d \approx 0$) and are classified as independent parallel tracks (`isTurnoutThroatPair = false`).
3. **Symmetric Midpoint Bounds for Closely Spaced Non-Shared Tracks**:
   - When a neighboring track lies within $1.68\text{ m} < |d| < 2.56\text{ m}$ and is *not* part of a shared turnout bearer at station $s$, both tracks symmetrically bound their lateral overhang on the facing side to the inter-track midpoint:
     $$w_{\text{facing}} = \min\left(\frac{w_{\text{standard}}}{2},\ \max\left(g_{\text{half}} + 0.05\text{ m},\ \frac{|d|}{2} - \text{gap}\right)\right)$$
     where $\text{gap} = 0.024\text{ m}$ for co-directional tracks ($\cos\theta > 0.86$) and $0.032\text{ m}$ for oblique approaches.
   - Because the midpoint bound depends only on the symmetric centerline distance $|d|$ between the two tracks, neither track steals the other's inner rail seat ($\pm 0.8175\text{ m}$) and the resulting lateral envelopes are independent of track processing order.
4. **Third-Track (`nbOuter`) Midpoint Capping on Elongated Turnout Bearers**:
   - When Track 1 elongates a shared turnout bearer across diverging Track 2 (`nb.absDist + nb.gaugeCenterOffset + 0.40 m`, clamped to $4.90\text{ m}$), it checks all non-shared neighbors `nbOuter` on the same side. If a third closely spaced track runs beyond Track 2, the bearer's outer extent is capped at `0.5 * (nb.absDist + nbOuter.absDist) - 0.024 m` so it supports Track 2's outer rail without intruding into Track 3's inner rail seat.
5. **Nearest-Station Conflict Resolution & Multi-Interval Subtraction (`subtractIntervalFromList`)**:
   - In Step B1, a track queries placed sleepers in the spatial grid within longitudinal reach `minDAlong <= period * 0.62` ($\approx 0.45\text{ m}$) and evaluates only boxes belonging to the single nearest station (`dAlong <= minDAlong + 0.12 m`) of each higher-priority track.
   - If that nearest station is an explicit shared bearer listing `r.id` in `supportedTrackIds` and covering both rail seats, the redundant local sleeper is suppressed. Otherwise, any non-shared box's lateral footprint is bounded at the inter-track midpoint before calling `subtractIntervalFromList()`.
   - `subtractIntervalFromList()` preserves all remaining lateral segments (allowing an interior cut to split a wide bearer into two outer rail-supporting segments) using a minimum segment width of `0.26 m` when the segment covers a rail seat ($\pm g_{\text{half}} \pm 0.02\text{ m}$) and `0.38 m` otherwise.
6. **Longitudinal Phase Adjustments (`ds` Fallback)**:
   - If an out-of-phase or oblique neighbor box at exact station $s$ still clips away support for either rail (`coversLeftRail && coversRightRail` fails), the builder tests small longitudinal phase shifts `ds` in `[+0.18, -0.18, +0.32, -0.32] m` (clamped within $[0.05\text{ m}, L_{\text{way}} - 0.05\text{ m}]$) and selects the first shifted station that achieves full dual-rail support without 2D OBB overlap.
7. **Switch Blade Rail Continuity**:
   - Switch blade taper (`switchBladeTaperLengthMeters = 3.2 m`) is restricted strictly to branch turnouts diverging from a host mainline (`hasHostTrackStrictlyAlongside`). Collinear chained way segments connecting end-to-end do not taper, ensuring continuous full-profile rail geometry across all segment boundaries.

### 2.3 Automated Geometric Acceptance & Regression Coverage (`src/world/PerformanceBaseline.test.ts`)
To guarantee that test claims match actual executable assertions, `src/world/PerformanceBaseline.test.ts` separates **deterministic geometric acceptance & regression tests** from **real-OSM integration / smoke tests**:

| Test Suite & Scope | Geometries & Conditions Tested | Verified Assertions & Measured Results | Status |
| :--- | :--- | :--- | :---: |
| **65-Way Switchyard Geometric Acceptance** | All 65 ways (130 rails) across Zone 1 (short segments), Zone 2 (single turnouts), Zone 3 (scissors crossover), and Zone 4 (station throat) sampled every `0.10 m` | **0 unsupported rails** (`1.200 m` max unsupported span $\le 1.65\text{ m}$); **0 inter-track 2D OBB overlaps** across **3,716 sleeper boxes**; **416 shared turnout bearers**; continuous crossing rails and blade taper only at true turnout toes | **PASS** |
| **Closely Spaced Regression 1: Two Parallel Tracks & Order Independence** | **(1A) Straight parallel tracks** at `1.90 m, 2.05 m, 2.20 m, 2.38 m`; **(1B) Concentric curved parallel tracks** ($R_1 = 80.0\text{ m}, R_2 = 77.9\text{ m}$, `2.10 m` spacing); **(1C) Chained short-segment parallel tracks** (`0.85 m` and `1.15 m` vertex chains at `2.10 m` spacing) | `0` false turnout bearers; each track retains its own sleepers supporting both rails ($\le 0.85\text{ m}$ straight/chained, $\le 0.90\text{ m}$ curved); **negative check** confirms removing Track 2's sleepers yields `0` supporting boxes from Track 1; **normalized sleeper positions (`cx, cz`), widths, lateral bounds, and `supportedTrackIds` are identical** under reversed track priority; `0` 2D OBB overlaps | **PASS** |
| **Closely Spaced Regression 2: 5-Track Competing Corridor** | 5 parallel tracks at `z = [0.0, 2.00, 4.10, 6.05, 8.20] m` with staggered longitudinal phase offsets `x0 = [0.0, 0.19, 0.37, 0.53, 0.11] m` | All 5 exterior and interior tracks retain $\ge 52$ own sleepers with continuous per-rail support ($\le 0.85\text{ m}$ max gap on every rail) and `0` 2D OBB overlaps | **PASS** |
| **Closely Spaced Regression 3 & 4: 3-Track Turnout + Parallel Throat** | Mainline 1 (`z = 0 m`), diverging Turnout Branch (`z = 0 -> 2.30 m`), and closely spaced Parallel Mainline 2 (`z = 4.35 m`, `2.05 m` from leveled-out branch) | $\ge 6$ shared turnout bearers explicitly listing `throat_turnout_branch` in `supportedTrackIds` in the switch throat; smooth transition to $\ge 18$ independent branch sleepers after divergence; continuous per-rail support ($\le 1.25\text{ m}$ throat, $\le 0.85\text{ m}$ parallel mainline) across all 6 rails; `0` 2D OBB overlaps | **PASS** |
| **Real-OSM Integration & Smoke Verification** | Overpass API extracts for **Station Hengelo** (`350 m` radius, `67` ways) and **Amsterdam Centraal** (`180 m` radius, `160` ways; plus `420 m` full benchmark, `383` ways) | Integration/smoke verification confirming end-to-end geometry build, non-zero shared turnout bearers (`1,250` on Hengelo; `1,322` on Amsterdam 180m), recorded sleeper box counts (`6,549` on Hengelo; `9,569` on Amsterdam 180m), and `0` leaked geometries upon disposal *(Note: real-OSM extracts contain truncated boundary ways and untagged sidings and are therefore used as integration/smoke evidence rather than exhaustive per-rail support proofs)* | **PASS** |

---

## 3. Reconsideration of Close-Zoom Sleeper Density

The specification in `docs/geometry-and-rendering.md` outlines canonical dimensions:
- Physical sleeper period: `0.60 m` (standard European/AREMA mainline spacing $\approx 1,667$ ties/km)
- Physical sleeper length (along track): `0.26 m` (`260 mm`)
- Physical sleeper width (across track): `2.50 m` (`2500 mm`)

The initial prototype utilized a visual spacing of `1.45 m` (with visual length `0.36 m`), which made close-range track appear visibly sparse.

### 3.1 Density Sweep Evaluation on 65-Way Benchmark
We evaluated three candidate densities on the full 65-way synthetic switchyard dataset (all values recorded in `candidateBDensitySweep` of [`docs/m2-1-baseline-data.json`](./m2-1-baseline-data.json)):

| Sleeper Spacing Parameter | Tie Count | Turnout Bearers | Sleeper Vertices | Total Rail Vertices | CPU Buffer Footprint | Build Time (Node) | Visual Character & Aliasing Assessment |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **Physical Spec (`0.60 m`)** | 4,471 | 505 | 89,420 | 102,260 | 3,068.5 KB (3.00 MB) | 121.76 ms | Dense, prototypical appearance. At `zoom <= 4.0`, high spatial frequency causes visible moiré/stippling under orthographic projection. |
| **Half-Harmonic (`0.725 m`)** *(Selected)* | **3,716** | **416** | **74,320** | **87,160** | **2,626.1 KB (2.565 MB)** | **84.23 ms** | **Balanced, convincing tie density without crowding. Exact 2:1 harmonic ratio with `1.45 m` procedural UV ribbon prevents phase popping at LOD transition.** |
| **Procedural Match (`1.45 m`)** | 1,867 | 199 | 37,340 | 50,180 | 1,433.4 KB (1.40 MB) | 36.05 ms | Visually sparse at close zoom (`8.0x–16.0x`). Resembles industrial spur or tramway rather than heavy mainline track. |

### 3.2 Rationale for `0.725 m` Half-Harmonic Selection
1. **Visual Density**: `0.725 m` spacing produces 3.29 pixels between sleeper centers at `zoom = 8.0` (and 6.59 pixels at `zoom = 16.0`), providing clear physical tie definition and shadow relief.
2. **Harmonic Phase Alignment**: Because the medium/far procedural UV ribbon uses a period of `1.45 m`, choosing `0.725 m` establishes an exact $2:1$ harmonic relationship ($1.45 / 2 = 0.725$). Every second 3D sleeper aligns exactly with a procedural tie center, preventing longitudinal phase shift or jumping when switching representations at `zoom = 4.5`.
3. **Geometry Cost**: Saves 15,100 vertices (-14.8%) and 442.4 KB CPU buffer memory compared to `0.60 m`, while eliminating the sparse appearance of `1.45 m`.

---

## 4. Implementation Details & Controlled Optimizations of Candidate B

### 4.1 Track Relationship Queries & Spatial Hash Grid Acceleration
In the initial unoptimized prototype, `HostTrackSpatialIndex` performed an $O(M_{\text{seg}})$ linear scan over centerline segments. On Amsterdam Centraal (`420m`), this resulted in **124,920 queries** examining **995,121,224 segments**, consuming **27,335 ms** in query time alone.
- **Optimization (8m × 8m Uniform Spatial Hash Grid)**: We augmented `HostTrackSpatialIndex` with a 2D spatial hash grid (`useSpatialGridIndex: true`). Centerline segments are indexed into 8m grid cells; queries only test segments within adjacent buckets.
- **Measured Impact**: On Amsterdam Centraal, segments examined dropped from **995M → 801K** (an **8.68 avg segments/query** vs. 7,966 avg segments/query), reducing query time from **27,335 ms → 212 ms** (a **128× algorithmic speedup**).

### 4.2 Adaptive Bridge Deck Sampling
In the unoptimized prototype, railway bridges were uniformly sampled every `0.35 m` along their entire deck, generating tens of thousands of collinear vertices on flat viaduct spans.
- **Optimization (`adaptiveBridgeSampling: true`)**: Bridge deck points are sampled adaptively: flat collinear interior spans retain only boundary vertices, while tight vertical transitions (ramps) and turnout curvature are fully sampled at high resolution.
- **Measured Impact**: Bridge/viaduct triangles dropped by **68.2%**, reducing bridge build time on Amsterdam Centraal from **320 ms → 116 ms** without any visual degradation.

### 4.3 Multi-Interval Lateral Subtraction (`subtractIntervalFromList`)
When `multiIntervalClip: false` is used (`subtractLateralInterval`), if an interior cut splits a wide bearer into two outer segments, only the single wider segment is kept.
- **Optimization (`multiIntervalClip: true`)**: Replaces single-interval truncation with list-based interval subtraction (`subtractIntervalFromList`), retaining all sub-segments that meet the minimum support width (`0.26 m` when covering a rail seat `±gaugeOffsetHalf ± 0.02 m`, or `0.38 m` otherwise).
- **Measured Impact**: On the Amsterdam Centraal 180m throat extract (`realOsmVerification.amsterdamCentraal` in `docs/m2-1-baseline-data.json`), enabling `multiIntervalClip: true` and adaptive bridge sampling preserves **83 multi-interval split stations** (`9,478` boxes in `candidateB_unoptimized` vs. `9,569` boxes in `candidateB`), and **1 split station** on the full 420m dataset (`22,469` vs. `22,470` boxes).

### 4.4 Sleeper Geometry Architecture: `THREE.InstancedMesh` with Variable Bearer Scaling
The initial prototype merged all 3D sleeper boxes into a monolithic `BufferGeometry`. While simple, this allocated **63.68 MB** of CPU buffer memory on Amsterdam Centraal (`22,469` sleepers).
- **Optimization (`sleeper3DMode: 'instanced'`)**: Converted 3D sleepers to `THREE.InstancedMesh`. Standard sleepers and variable-length switch bearers share a single unit box geometry (`24 vertices, 12 triangles`).
- **Preserving Variable-Length Bearers**: Each instance applies a non-uniform instance matrix:
  $$M = T(x, y, z) \cdot R_y(\theta) \cdot S(w_{\text{bearer}}, h, L)$$
  Variable bearer widths ($2.50\text{ m}$ to $4.90\text{ m}$) are natively expressed via $S_x$ without geometry recreation.
- **Feature Inspection Contract**: An array of `instanceInfos` maps each instance index back to its `InspectableFeatureInfo`, ensuring clicking or hovering any instanced tie highlights its parent OSM track.
- **Measured Impact**: Railway CPU buffer memory dropped from **63.68 MB → 7.75 MB** (an **87.8% memory reduction**), and 3D sleeper placement time dropped from **5,909 ms → 377 ms**.

### 4.5 Static Spatial Chunking (`128m × 128m`) & Automatic Frustum Culling
Monolithic meshes span the entire 840m × 840m map extent, forcing the GPU to process all railway vertices regardless of camera zoom or viewing angle.
- **Optimization (`spatialChunkSizeMeters: 128`)**: Railway geometry (ribbons, 3D rails, ballast, and instanced sleeper meshes) is partitioned into static `128m × 128m` world-coordinate grid chunks. Each chunk computes local bounding spheres and enables `mesh.frustumCulled = true`.
- **Measured Impact**: In close station-throat inspection (`zoom = 8.0`), Three.js frustum culling automatically culls **91 of 130 meshes**, eliminating **59.4% of active railway triangles** (`140,952` visible triangles vs. `347,324` total).

### 4.6 Camera Drag-Time Raycast Suppression
During active camera panning and orbiting, React Three Fiber previously executed `raycaster.intersectObjects` across `<group name="MapRoot">` on every `pointermove` event prior to throttled hover handlers.
- **Optimization**: In `src/scene/MapScene.tsx`, when the pointer moves $> 5\text{ px}$ while mouse buttons are held, R3F event processing is suppressed (`events.enabled = false`) until `pointerup`/`pointercancel`.
- **Measured Impact**: Eliminates main-thread JavaScript raycast stalls during camera motion, maintaining smooth camera motion.

### 4.7 Stencil and Depth Behavior at Close Zoom
- **Production Stencil Contract**: Production `GeometryBuilder.ts` uses a 3-layer stencil hierarchy where road surfaces, bridges, and ballast write `stencilRef = 15` to prevent sub-surface light leaks and z-fighting.
- **Candidate B Sleeper Behavior**: `Railway_Sleepers_3D` does **not** write or test against `stencilRef = 15`. It functions as standard 3D solid geometry with:
  - `depthTest = true`
  - `depthWrite = true`
  - `polygonOffset = true`, `polygonOffsetFactor = -1.0`, `polygonOffsetUnits = -2.0`
- **Resolution of Inter-Track Ties**: Overlapping sleepers are prevented geometrically *before* vertex generation via Pass 1 shared bearers, symmetric midpoint bounds, and Pass 2 multi-interval clipping. No two 3D sleeper boxes occupy the same spatial volume.
- **Approach to Host Rails**: When a branch track approaches host rails, sleepers are either clipped cleanly outside the host ballast boundary or unified into the host bearer, preventing any sleeper geometry from penetrating host rails.

---

## 5. Investigation and Quantification of LOD Transitions

Candidate B uses a zoom threshold (`hybridCloseZoomThresholdPxPerMeter = 4.5`) to switch between close-zoom 3D geometry and medium/far procedural UV ribbons.

### 5.1 Continuous Zoom Sweep Analysis (`zoom = 4.3` to `4.7`)
To evaluate visual popping and discontinuity, we captured a continuous zoom sweep with fixed camera target:

| Frame Zoom | Render Mode | Grayscale Mean Delta vs. Zoom 4.3 | Pixel Change Area (> 8% threshold) | Visual Characteristics |
| :---: | :---: | :---: | :---: | :--- |
| **4.3** | Procedural UV Ribbon | 0.00% (Baseline Frame) | 0.00% | Procedural ties with derivative anti-aliasing. |
| **4.4** | Procedural UV Ribbon | 0.38% | 1.82% | Normal camera scale magnification. |
| **4.5** | LOD Boundary | 0.54% | 2.21% | Nominal threshold. |
| **4.6** | 3D Extruded Geometry | 0.71% | 2.99% | First frame of 3D geometry. |
| **4.7** | 3D Extruded Geometry | 0.89% | 3.42% | 3D ties with directional shadow relief. |

### 5.2 Quantifying the Discontinuity
To isolate the representation change from camera zoom scaling:
- **Normal Zoom Delta (Candidate A, 4.4 to 4.6)**: Grayscale mean delta = **0.53%**, changed pixel area = **2.43%**.
- **Candidate B LOD Transition (4.4 to 4.6)**: Grayscale mean delta = **0.71%**, changed pixel area = **2.99%**.
- **Net Representation Delta at Constant Zoom (4.6)**: Comparing Candidate B's 3D geometry against its UV ribbon rendered at the exact same zoom (`4.6`) yields a net delta of **0.30% mean grayscale change** and **1.50% changed pixel area**.
- **Visual Artifacts**: Thanks to the `0.725 m` half-harmonic alignment, ties do not jump or shift position. The visible difference is restricted to the appearance of subtle 3D side-wall shadow contours and specular highlights on the rail heads.
- **Crossfade Prototype Evaluation**: A crossfade prototype was evaluated using alpha blending across `zoom = 4.3..4.7`. While it smooths the transition, it requires rendering *both* the 3D meshes (`87,160` verts) and UV ribbons (`5,136` verts) simultaneously across the overlap zone, increasing peak draw calls and buffer contention. Given the low measured delta (0.30%), a hard switch at `zoom = 4.5` remains visually acceptable and computationally lightweight.

---

## 6. Reproducible Goalpost 1 Performance Baseline & Benchmark Integrity

All benchmark figures are derived strictly from [`docs/m2-1-baseline-data.json`](./m2-1-baseline-data.json) ($N = 5$ runs: 1 cold start + 4 warm runs).

### 6.1 Benchmark Environment & Specs
- **Hardware & Host OS**: Linux `x86_64`, Intel Xeon container environment.
- **Runtime**: Node.js `v22.23.4` (`tsx --test`).
- **Browser Context**: Chromium Headless (`playwright-cli`, `1280x800` viewport, SwiftShader WebGL2 Software Rasterizer).
- **GPU Execution Time**: Marked **"Not measured"** (valid WebGL timer queries require calibrated bracketed passes).
- **One-Command Reproduction**:
  ```bash
  # Run automated test suite and benchmark JSON generator
  npx tsx scripts/generate-baseline-json.ts
  npm test
  ```

### 6.2 CPU Geometry Build, Vertex/Triangle, and Buffer Memory Table (`nodeBenchmarkResults`)

| Dataset & Mode | Total Build Time (Warm Median, ms) | Railway Build Time (Warm Median, ms) | Rail Build Spread (Min–Max, ms) | Cold Start Rail Build (ms) | Railway Meshes (Active / Total) | Railway Vertices | Railway Triangles | Railway CPU Buffer Memory | Warmed-Up Leaked Geometries / Materials (5 Cycles) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Switchyard (65 Ways) — Disabled (Non-Rail Only)** | `1.84 ms` | `0.00 ms` | `0.00–0.00 ms` | `0.00 ms` | 0 / 0 | 0 | 0 | 0.0 KB | **0 / 0** |
| **Switchyard (65 Ways) — Baseline (G1)** | `39.92 ms` | `39.75 ms` | `35.44–44.97 ms` | `48.24 ms` | 3 / 3 | 9,358 | 5,178 | 351.6 KB | **0 / 0** |
| **Switchyard (65 Ways) — Candidate A (Procedural UV)** | `11.83 ms` | **`10.52 ms`** | `9.93–12.25 ms` | `17.19 ms` | 3 / 3 | **5,136** | **4,616** | **227.7 KB** | **0 / 0** |
| **Switchyard (65 Ways) — Candidate B (Hybrid 3D + UV)** | `76.18 ms` | `75.31 ms` | `67.00–86.50 ms` | `120.56 ms` | 3 / 5 | 87,160 | 48,700 | 2,626.1 KB (2.568 MB) | **0 / 0** |

*Key Observations*:
- **Candidate A** achieves the lowest geometry footprint on the 65-way switchyard: **17.0× fewer vertices** (`5,136` vs. `87,160`), **11.5× less buffer memory** (`227.7 KB` vs. `2,626.1 KB`), and **7.2× faster warm build time** (`10.52 ms` vs. `75.31 ms`) compared to Candidate B (un-instanced merged mode in the 65-way fixture).
- **Candidate B** allocates `87,160` vertices (`3,716` sleeper boxes and `416` shared turnout bearers) for 65 tracks at `0.725 m` spacing when using merged 3D sleeper geometry; as shown in Section 8, enabling `THREE.InstancedMesh` reduces unique buffer vertices and memory by over 85% on large networks.
- **Lifecycle Integrity**: All configurations demonstrate zero-leak resource cleanup across 5 complete build/dispose cycles.

---

## 7. Complete Visual Comparison Across Zooms, Topologies & Themes

All visual evidence has been captured directly from the running prototype and stored in `/public/assets/m2-1-prototype/`.

### 7.1 Paired Topological Comparisons (1:1 and 3x Pixel Crops)

| Topology Zone | Feature & Challenge | Candidate A (Pure Procedural UV) | Candidate B Before Fix (Clearance Suppression) | Candidate B After Fix (Topology-Aware Bearers) |
| :--- | :--- | :---: | :---: | :---: |
| **Zone 1: Short Segments** | 18 chained `0.85 m` ways | Continuous sleepers via phase propagation | Sleepers present; minor boundary stutter | Continuous sleepers; 0 gaps |
| **Zone 2: Single Turnout** | 1:9 switch throat divergence | Smooth host bed boundary clipping | **6.5m–8.7m missing sleeper gap** beneath diverging rail | **Continuous support via shared switch bearers** |
| **Zone 3: Scissors Crossover** | Central diamond frog & switch throats | Clean crossing lines; no tie clutter | Over-suppressed ties near frog | **Continuous bearer coverage through frog** |
| **Zone 4: Station Throat** | 6 parallel tracks + ladder switches | Sub-pixel rail filtering; 0 moiré | Gaps in switch leads | **Full multi-track bearer continuity** |

#### Crop Artifact References
- **Zone 2 Turnout Support (3x Crop)**:
  - *Candidate B Before Fix*: `/public/assets/m2-1-prototype/crop-z2-throat-3x-candB-before-fix.png` (Shows glaring unsupported gap beneath outer rail).
  - *Candidate B After Fix*: `/public/assets/m2-1-prototype/crop-z2-throat-3x-candB.png` (Shows elongated shared bearers supporting all 4 rails).
  - *Candidate A*: `/public/assets/m2-1-prototype/crop-z2-throat-3x-candA.png` (Shows flush-clipped procedural tie bed).
- **Zone 3 Scissors Diamond Frog (3x Crop)**:
  - *Candidate B Before Fix*: `/public/assets/m2-1-prototype/crop-z3-frog-3x-candB-before-fix.png`
  - *Candidate B After Fix*: `/public/assets/m2-1-prototype/crop-z3-frog-3x-candB.png`
  - *Candidate A*: `/public/assets/m2-1-prototype/crop-z3-frog-3x-candA.png`
- **Zone 4 Station Throat (3x Crop)**:
  - *Candidate B*: `/public/assets/m2-1-prototype/crop-z4-throat-3x-candB.png`
  - *Candidate A*: `/public/assets/m2-1-prototype/crop-z4-throat-3x-candA.png`

### 7.2 Extreme Zoom (`zoom = 16.0x`) Investigation
Testing one full step beyond the default maximum close zoom (`zoom = 8.0`) verifies camera-to-pixel projection limits:
- **Projection Scale**: At `zoom = 16.0`, $1.0\text{ m} = 16.0\text{ screen pixels}$. The $24\text{ mm}$ ($0.024\text{ m}$) sleeper height projects to $0.024 \times \sin(55.38^{\circ}) \times 16.0 = 0.316\text{ pixels}$ vertically. The combined rail head + sleeper height ($0.050\text{ m}$) projects to $0.658\text{ pixels}$.
- **Candidate B (`zoom = 16.0x`)**: `/public/assets/m2-1-prototype/z4-throat-zoom16-candidateB.png`
  - *Finding*: Physical 3D geometry holds up cleanly without pixel distortion; specular edge highlights emphasize rail geometry.
- **Candidate A (`zoom = 16.0x`)**: `/public/assets/m2-1-prototype/z4-throat-zoom16-candidateA.png`
  - *Finding*: Analytic bevel shading and rail crowns maintain clean antialiased edges without texture blur.

### 7.3 Multi-Theme Evaluation (Tactical, Daylight, Dusk, Blueprint)
Both candidates were tested across all four application themes at `zoom = 6.0`:
- **Tactical**: Dark high-contrast styling. Candidate B shows clear directional lighting and cast shadows.
- **Daylight**: High ambient diffuse illumination. Candidate B's sleeper side walls maintain subtle depth; Candidate A's contrast remains crisp.
- **Dusk**: Warm low-angle illumination with elongated shadows. Candidate B benefits visually from directional shadow relief on ballast.
- **Blueprint**: Technical schematic styling. Both candidates render cleanly; Candidate A's flat vector appearance aligns especially well with CAD aesthetic.

---

## 8. Real OpenStreetMap Verification & Controlled 4-Configuration Runtime Comparison

Synthetic switchyard fixtures represent idealized track geometry. To establish real-world viability, we tested actual OpenStreetMap extracts from Station Hengelo and Amsterdam Centraal (recorded under `realOsmVerification` and `amsterdamFull4ConfigComparison` in [`docs/m2-1-baseline-data.json`](./m2-1-baseline-data.json)).

> **Provenance of `candidateB_unoptimized` vs. `candidateB` in `realOsmVerification`**:  
> In `scripts/generate-baseline-json.ts`, both `candidateB_unoptimized` and `candidateB` execute the current `buildRailwayPrototypeGroup` sleeper-placement algorithm, differing only in optimization flags:
> - `candidateB_unoptimized`: `{ useSpatialGridIndex: false, adaptiveBridgeSampling: false, multiIntervalClip: false, sleeper3DMode: 'merged', spatialChunkSizeMeters: 0 }`
> - `candidateB`: `{ useSpatialGridIndex: true, adaptiveBridgeSampling: true, multiIntervalClip: true, sleeper3DMode: 'instanced', spatialChunkSizeMeters: 128 }`

### 8.1 Station Hengelo Extract (`realOsmVerification.hengelo`)
- **Source**: OpenStreetMap Overpass API (extracted 2026-11-01).
- **Location**: `52.2623° N, 6.7934° E` (Radius $350\text{ m}$).
- **Topology**: 67 parsed railway ways, 162 raw features, 0 bridges, 0 tunnels, 2 short chained ways ($< 2\text{ m}$). Sample OSM IDs: `way/97083386`, `way/97083393`, `way/97083397`, `way/97083402`, `way/97083406`.
- **Recorded Results (`docs/m2-1-baseline-data.json`)**:
  - *Candidate A*: `13.59 ms` build, `10,888` vertices, `10,352` triangles, `3` draw calls, `486.0 KB` CPU buffer.
  - *Candidate B (`candidateB_unoptimized`)*: `344.23 ms` build, `158,200` merged vertices, `91,370` triangles, `5` draw calls, `4,797.0 KB` CPU buffer, **`6,549` sleeper boxes**, **`1,250` shared turnout bearers** (`0` multi-interval split stations).
  - *Candidate B (`candidateB` optimized)*: `114.31 ms` build (**3.0× faster**), `27,240` unique buffer vertices (`158,200` rendered with instances), `25,890` unique buffer triangles (`91,370` rendered with instances), `42` draw calls (across `10` spatial chunks), `1,369.6 KB` CPU buffer memory (**71.4% memory reduction**), **`6,549` sleeper boxes**, and **`1,250` shared turnout bearers**. Because Station Hengelo has `0` bridges and `0` interior multi-interval split stations, `candidateB_unoptimized` and `candidateB` emit the exact same `6,549` sleeper boxes and `1,250` turnout bearers.

### 8.2 Amsterdam Centraal Western Throat (`realOsmVerification.amsterdamCentraal`, 180m Radius)
- **Source**: OpenStreetMap Overpass API (extracted 2026-11-01).
- **Location**: `52.378° N, 4.900° E` (Radius $180\text{ m}$).
- **Topology**: 160 parsed railway ways, 771 raw features, 83 bridges, 14 tunnels, 78 untagged service/usage tracks.
- **Recorded Results (`docs/m2-1-baseline-data.json`)**:
  - *Candidate A*: `90.43 ms` build, `68,356` vertices, `42,306` triangles, `7` draw calls, `2,140.5 KB` buffer memory.
  - *Candidate B (`candidateB_unoptimized`)*: `3,687.60 ms` build, `717,508` vertices, `456,164` triangles, `9` draw calls, `22,941.0 KB` (`22.40 MB`) buffer memory, **`9,478` sleeper boxes**, and **`1,347` shared turnout bearers** (`multiIntervalClip: false`, `0` split stations).
  - *Candidate B (`candidateB` optimized)*: `241.37 ms` build (**15.3× faster**), `96,264` unique buffer vertices (`287,624` rendered with instances), `68,452` unique buffer triangles (`164,132` rendered with instances), `94` draw calls (across `15` spatial chunks), `3,545.9 KB` (`3.46 MB`) buffer memory (**84.5% memory reduction**), **`9,569` sleeper boxes**, **`1,322` shared turnout bearers**, and **`83` multi-interval split stations** preserved (`multiIntervalClip: true` + adaptive bridge sampling).

### 8.3 Full Amsterdam Centraal Network (420m Radius, 383 Railways): Controlled 4-Configuration Comparison
To isolate the true rendering cost of railways from the non-railway base map under the architectural assumption of **pre-baked static maps**, we evaluated four isolated configurations on the full Amsterdam Centraal network (`radius = 420 m`, `613` buildings, `1,031` roads, `383` railways including `167` railway bridges and `14` tunnels). All configurations share an identical non-railway map:

| Configuration | Total Offline Build (ms) | Railway Offline Build (ms) | Total Active Meshes | Railway Meshes | Total Buffer Vertices | Railway Buffer Vertices | Total Buffer Triangles | Railway Buffer Triangles | Total CPU Buffer (MB) | Railway CPU Buffer (MB) | Station Throat Frustum Culled Tris (%) | Node-Side Railway Inspection (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **A. Railway Rendering Disabled** | 2,960.03 | **0.00** | 57 | 0 | 593,346 | 0 | 180,585 | 0 | 10.60 | **0.00** | N/A | N/A |
| **B. Existing Goalpost 1 Baseline** | 4,208.76 | 1,290.44 | 60 | 9 | 1,721,014 | 1,127,668 | 815,039 | 634,454 *(77.8%)* | 44.90 | 35.85 | 0.0% | N/A |
| **C. Candidate A (128m Chunks)** | 2,924.56 | **221.91** | 180 | 123 | 731,302 | 137,956 | 270,143 | 89,558 | 14.99 | **4.39** | 58.3% | 1.57 ms |
| **D1. Candidate B (Unoptimized)** | 31,620.33 | 29,002.16 | 66 | 9 | 2,598,790 | 2,005,444 | 1,475,397 | 1,294,812 | 74.28 | 63.68 | 0.0% | 156.12 ms |
| **D2. Candidate B (Optimized)** | 3,926.73 | **673.00** | 235 | 178 | 801,846 | 208,500 | 336,285 | 155,700 *(380K inst)* | 18.36 | **7.75** | **59.4%** | **4.47 ms** *(4.03 ms Step D)* |

*Key Findings from 4-Configuration Isolation*:
1. **77.8% of Triangles in Goalpost 1 Amsterdam Come from Railways**:
   - The non-railway city contains `180,585` triangles (Configuration A).
   - Goalpost 1 railway rendering adds `634,454` triangles (accounting for 77.8% of the entire map's triangle budget). This is caused by duplicate high-density bridge/tunnel meshes merged into the road system with `castShadow = true`.
2. **Candidate B Optimization Gains**:
   - **Offline Build Time**: Dropped from **29,002 ms → 673 ms** (**43.1× speedup**).
   - **Buffer Memory**: Dropped from **63.68 MB → 7.75 MB** (**87.8% memory reduction**).
   - **Station Throat Frustum Culling**: **59.4%** of railway triangles culled during close inspection (`zoom = 8.0`) via 128m static spatial chunking.

### 8.4 Single-Variable Step-by-Step Optimization Breakdown (Candidate B on Amsterdam 420m)
Each optimization was evaluated strictly one variable at a time against the unoptimized baseline on the full Amsterdam Centraal dataset (`candidateBSingleVariableExperiments` in `docs/m2-1-baseline-data.json`):

| Step / Variable Under Test | Total Railway Build Time (ms) | Query Time (ms) | Segments Examined | Overlap Time (ms) | Emitted Sleepers | Railway CPU Buffer (MB) | Throat Raycast Latency (ms) | Culling at Zoom 8.0 (%) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Step 0: Unoptimized Baseline** | 27,362.59 | 25,731.35 | 995,121,224 | 5,420.55 | 22,469 | 63.68 MB | 159.20 ms | 0.0% |
| **Step A1: + 8m Spatial Grid Index** | 1,860.09 | 331.63 | 1,036,840 | 376.84 | 22,469 | 63.68 MB | 162.18 ms | 0.0% |
| **Step A2: + Adaptive Bridge Sampling** | 930.44 | 263.02 | 801,559 | 373.28 | 22,469 | 19.62 MB | 46.12 ms | 0.0% |
| **Step B: + Multi-Interval Clip** | 769.11 | 216.41 | 801,559 | 334.02 | 22,470 | 19.62 MB | 48.31 ms | 0.0% |
| **Step C: + Instanced 3D Sleepers** | 566.02 | 194.56 | 801,559 | 267.37 | 22,470 | **8.13 MB** | 22.94 ms | 0.0% |
| **Step D: + 128m Spatial Chunks** | **564.18** | 179.92 | 801,559 | 269.00 | 22,470 | **7.75 MB** | **4.03 ms** | **59.4%** |

---

## 9. Synthesis & M2.1 Gate Status

### 9.1 Trade-Off Summary

| Architectural Dimension | Candidate A (Pure Procedural UV) | Candidate B (Hybrid 3D + Procedural UV, Optimized) |
| :--- | :--- | :--- |
| **Close-Zoom Visual Appeal** | Clean, flat, antialiased; subtle procedural bevel. | **Leading visual direction**: Convincing physical 3D tie and rail geometry with directional shadow relief. |
| **Runtime Rendering Performance** | Smooth, low draw calls, zero LOD transition. | **Validated Smooth Runtime**: **~144 FPS smooth rendering on user machine** (manual observation on 144 Hz display). |
| **Medium/Far-Zoom Stability** | **Superior**: Single representation, zero LOD pop, energy-conserving derivative filtering. | Identical to Candidate A below `zoom = 4.5`, with subtle 0.30% mean grayscale delta at LOD threshold. |
| **Offline Preparation Cost** | **Minimal**: `10.52 ms` (65 ways) / `221.91 ms` (Amsterdam 420m). | **Viable for Baked Maps**: `75.31 ms` (65 ways) / `673.00 ms` (Amsterdam 420m). |
| **Baked Geometry & Buffer Memory** | **Minimal**: `5,136` verts, `227.7 KB` (65 ways) / `4.39 MB` (Amsterdam 420m). | **Compact via Instancing**: `87,160` rendered verts (65 ways) / `7.75 MB` (Amsterdam 420m). |
| **Station Throat Frustum Culling** | 58.3% triangle culling via 128m chunks. | **59.4% triangle culling** via 128m chunks. |
| **Implementation Complexity** | Low-Moderate (3 merged meshes, self-contained shader). | Moderate-High (`THREE.InstancedMesh`, spatial hash grid, adaptive bridge sampling, LOD toggle). |

### 9.2 Distinction of Costs & Profiling Caveats
1. **Offline Map Preparation vs. Runtime Cost**:
   - Because the eventual game will use **pre-baked, static maps**, the 673 ms offline generation time for the entire 840m Amsterdam Centraal terminal is a one-time offline baking cost, well within acceptable thresholds.
   - At runtime, the baked static map delivers smooth 144 FPS rendering on the user's machine, with 59.4% frustum culling at the station throat and compact 7.75 MB buffer memory.
2. **Measurement Distinctions**:
   - **Manual Observation**: ~144 FPS smooth runtime performance is a manual observation on the user's machine (144 Hz display) under real interactive conditions.
   - **Automated Node Benchmark**: 4.03 ms raycast latency is a Node-side measurement against the isolated railway group (`evaluateFrustumAndRaycastAtPose`), not the full browser R3F raycast.
   - **Live WebGL Telemetry**: `hoverRaycastTimeMs` measures `resolveInspectedFeature()`, not the full R3F scene traversal.
   - **Synthetic Timers**: Automated timer loops (`rAF` + `setTimeout`) do not measure true browser frame intervals.

### 9.3 Deferred Non-Railway Finding
- **Building Draw-Call Amplification**: The 2,537 WebGL draw calls observed in Configuration A (zero railways) stem from `THREE.ExtrudeGeometry` 2-group partitioning per building preserved by `mergeWithFaceRanges()`. This is documented as a known, deferred rendering finding for future optimization milestones and is strictly outside M2.1 scope.

### 9.4 Milestone 2.1 Gate Status
- **Performance Blocker Status**: **Resolved**. Candidate B's runtime performance is no longer considered an outstanding blocker for M2.1.
- **Visual Direction**: Candidate B remains the leading visual direction due to its physical sleeper definition, shared turnout bearers, and rail geometry. Candidate A remains a fully validated, lightweight procedural comparison point.
- **Production Gate**: Neither candidate is approved or integrated into production `GeometryBuilder.ts`.
- **Ticket Status**: Ticket [`TKT-002`](../tickets/TKT-002-m2-1-performance-baseline-and-railway-prototype.md) remains open with status **`in_review`**, awaiting formal user decision gate sign-off before Milestone 2.2 (`TKT-001`) begins.
