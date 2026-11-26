# TKT-041 — Hierarchical Tile Streaming Validation & Benchmark Plan

- **Date:** 2026-11-26
- **Ticket:** [TKT-041](../../tickets/TKT-041-hierarchical-tile-streaming.md)
- **ADR:** [ADR-0015](../decisions/ADR-0015-hierarchical-tile-streaming.md)
- **Status:** Implemented and verified in sandbox on deterministic synthetic 3-resolution mosaics; **owner RTX 4060 Ti hardware benchmarks and interactive visual QA on the real full-Twente mosaics remain pending.**

---

## 1. Architecture Summary

`TKT-041` introduces **uniform-viewport hierarchical tile streaming** across existing baked `1,024 m`, `2,048 m`, and `4,096 m` `OSMTILE1` v1 mosaics without rewriting or duplicating geometry:

- **Single active resolution per frame:** Zero simultaneous multi-resolution geometry overlap and no cross-fading; incoming resolution tiles decode via the `TKT-040` `combined` worker pipeline and reconstruct off-scene (`prepared_inactive`) before swapping atomically at the frame boundary once 100% of required destination viewport tiles are ready.
- **Canonical UTM origin & picking parity:** All resolutions rebase onto one canonical UTM origin so buildings, roads, railways, and instanced foliage occupy identical world coordinates and produce identical feature attribution across resolutions.
- **Provisional hysteresis policy (viewport-width normalized to 1,280 px):**
  - `1,024 m ↔ 2,048 m`: zoom out `< 0.80` -> `2,048 m`; zoom in `> 1.00` -> `1,024 m`.
  - `2,048 m ↔ 4,096 m`: zoom out `< 0.26` -> `4,096 m`; zoom in `> 0.34` -> `2,048 m`.
  - Supports direct non-adjacent jumps (`1,024 m ↔ 4,096 m`) and physical-meter margins (`1,024 m` preload / `2,048 m` retain).
- **Bounded multi-resolution budgets:** Default `768 MiB` total measured budget, `192 MiB` / `48`-tile detached LRU inactive cache, `192 MiB` worker backpressure threshold, `0.35` transition reserve, and `4.5 ms/frame` time-aware commits, with a `deferred_budget` safeguard that never evicts active visible tiles.

---

## 2. Sandbox Synthetic Verification (SwiftShader — NOT RTX Hardware)

> **Important provenance boundary:** The development sandbox does not have access to the owner's baked Twente datasets or an RTX 4060 Ti GPU. The numbers below were measured on a **deterministic synthetic 4×4 (`4,096 m × 4,096 m`) 3-resolution mosaic set** (`1,024 m` consolidated to `2,048 m` and `4,096 m`) under **headless Chromium SwiftShader** (`ANGLE Vulkan 1.3.0 SwiftShader`). Frame intervals reflect software rasterization and **must not** be interpreted as RTX hardware performance.

### 2.1 Automated Unit & Integration Suite
- `npx tsx --test src/world/HierarchicalTileStreaming.test.ts`: **4/4 passed** (`2.49 s`), verifying:
  - Compatibility validation across 15 error codes (including resolution-aware `lodPolicyHash` checks matching `OfflineTileConsolidator`).
  - Hysteresis deadbands, viewport compensation, direct `1,024 ↔ 4,096` jumps, and URL overrides.
  - Multi-resolution Express HTTP handler (`/api/tiles-region/manifest`, `/r/:tileSizeMeters/:lod/:tx/:ty`, `400`/`404` rejection, shared LRU SQLite pool).
  - Zero overlap during gated preparation, zoom-reversal cancellation, rapid multi-crossing retargeting, failed-fetch blocking + retry, mid-transition camera panning, exact canonical building/foliage picking parity across `1,024 m` / `2,048 m` / `4,096 m`, LRU cache reuse, `deferred_budget` recovery, and backward compatibility with single-resolution mosaics.

### 2.2 Synthetic 3-Resolution Playwright Run (SwiftShader, `1280×720`, `foliage=on`, `--quick`)

Executed via `scripts/create-hierarchical-mosaic-descriptor.ts` + `benchmarks/hierarchicalStreamingRunner.ts --allow-software --foliage=on --quick`:

| Scenario | Transitions (start/done/cancel/defer) | Cache Hits / Evicts | Max Atomic Swap (ms) | Peak Measured CPU/BVH (MiB) | Peak Est. GPU (MiB) | Invariants |
|---|---|---:|---:|---:|---:|---|
| `zoom_sweep_1024_2048_4096_back` | `4 / 4 / 0 / 0` | `25 / 0` | `0.90` | `0.20` | `0.13` | Single-Res: **PASS** |
| `direct_jump_1024_4096` | `2 / 2 / 0 / 0` | `20 / 0` | `0.90` | `0.20` | `0.13` | Single-Res: **PASS** |
| `hysteresis_deadband_stability` | `0 / 0 / 0 / 0` | `0 / 0` | `0.90` | `0.20` | `0.13` | Single-Res: **PASS**, 0-osc: **PASS** |
| `pan_and_repeated_zoom_cycles` | `5 / 5 / 0 / 0` | `54 / 0` | `0.90` | `0.20` | `0.13` | Single-Res: **PASS** |

Auto vs. forced single-resolution draw-call/triangle sanity check on the synthetic 4×4 fixture (`foliage=on`):

| Pose (Zoom) | Mode | Active Res | Median Draw Calls | Median Triangles |
|---|---|---:|---:|---:|
| Street (`1.60`) | `auto` | `1,024 m` | `17` | `194` |
| Street (`1.60`) | `force_4096` | `4,096 m` | `23` | `20,354` |
| Mid (`0.55`) | `auto` | `2,048 m` | `22` | `4,034` |
| Regional (`0.18`) | `auto` | `4,096 m` | `21` | `5,314` |
| Regional (`0.18`) | `force_1024` | `1,024 m` | `33` | `5,314` |

---

## 3. Reproducible Owner Commands (Windows PowerShell — Full Twente)

Invoke the scripts directly with `npx tsx` (avoid `npm run ... --` forwarding on Windows PowerShell). Adjust paths if your local mosaic directories differ.

### Step 1 — Create the Lightweight Hierarchical Descriptor (No Geometry Duplication)

```powershell
npx tsx scripts/create-hierarchical-mosaic-descriptor.ts `
  --index-1024=data/osm/twente-full-1024m-foliage-fix/mosaic.json `
  --index-2048=data/osm/twente-full-2048m-foliage-fix/mosaic.json `
  --index-4096=data/osm/twente-full-4096m-foliage-fix/mosaic.json `
  --name=twente-full-hierarchical `
  --out=data/osm/twente-full-hierarchical.json
```

### Step 2 — Run the Hardware Benchmark Suite on RTX 4060 Ti

```powershell
npx tsx benchmarks/hierarchicalStreamingRunner.ts `
  --descriptor=data/osm/twente-full-hierarchical.json `
  --foliage=both `
  --out=benchmarks/results/tkt041-twente-rtx4060ti.json `
  --markdown-out=benchmarks/results/tkt041-twente-rtx4060ti.md
```

(Alternatively, you may pass `--index-1024=... --index-2048=... --index-4096=...` directly to `hierarchicalStreamingRunner.ts` to auto-generate a temporary descriptor for the run.)

### Step 3 — Launch Interactive Viewer with Hierarchical Streaming

```powershell
$env:OVERIJSSEL_HIERARCHICAL_MOSAIC_PATH="data/osm/twente-full-hierarchical.json"
npm run dev
```

Open the **Diagnostics** panel to inspect active/desired/pending resolution, transition state, swap latency, measured CPU/BVH vs. estimated GPU memory by resolution, switch between `Auto` / `1,024 m` / `2,048 m` / `4,096 m`, or tune hysteresis thresholds and total memory budget live.

---

## 4. Explicit Caveats & Open Tuning Items

1. **Directly measured vs. estimated memory:** `Measured CPU/BVH` directly sums JS typed-array vertex/index/instance buffers, serialized mesh BVHs, `InstancedSpatialIndex` typed arrays, queued decoded payloads, and detached inactive cache tiles. `Est. GPU` is an explicit upper-bound buffer estimate because WebGL does not expose actual driver VRAM allocation or eviction timing.
2. **First-render GPU upload spikes:** Atomic activation attaches pre-reconstructed meshes in `< 1 ms` on the CPU, but newly created WebGL buffers still undergo driver upload on their first rendered frame unless warm-cached. Hardware profiling on Twente is required to confirm whether first-render upload cost after swap stays within the `144 Hz` (`6.94 ms`) target.
3. **Provisional zoom thresholds:** The `0.80 / 1.00` (`1024↔2048`) and `0.26 / 0.34` (`2048↔4096`) hysteresis bands are initial defaults intended to be evaluated and refined against real full-Twente frame-time crossover curves on RTX 4060 Ti.
4. **Visual and interactive QA belongs to the owner:** No automated screenshot or LLM visual verification was performed.
