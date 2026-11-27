# ADR-0015: Uniform-Viewport Hierarchical Tile Streaming (1,024 m / 2,048 m / 4,096 m)

- **Status:** Accepted architecture; deployed on full Twente and extended by [`ADR-0016`](ADR-0016-frame-budgeted-streaming-and-incremental-gpu-prep.md) (`TKT-041-F1`) and [`ADR-0017`](ADR-0017-decoupled-streaming-pipeline-and-adaptive-prewarm.md) (`TKT-041-F2`, closed 2026-11-27 as current foundation). `TKT-041` remains `in_progress` for its unexecuted `--foliage=both` matrix sweep and explicit closure sign-off.
- **Date:** 2026-11-26
- **Related ADRs:** [ADR-0001](ADR-0001-geographic-coordinates-and-local-projection.md), [ADR-0006](ADR-0006-gpu-resource-lifecycle-and-disposal.md), [ADR-0011](ADR-0011-baked-tiles-and-runtime-streaming.md), [ADR-0012](ADR-0012-bounded-regional-mosaics.md), [ADR-0013](ADR-0013-regional-camera-zoom-policy.md), [ADR-0014](ADR-0014-spatially-accelerated-instanced-feature-picking.md)
- **Related Ticket:** [TKT-041](../../tickets/TKT-041-hierarchical-tile-streaming.md)

---

## 1. Context

Following `TKT-037` (offline spatial batching consolidation into `2,048 m` and `4,096 m` mosaics), `TKT-038` (mesh-local flat typed-array BVH instanced picking), and `TKT-040` (compact zero-copy worker transfer, worker-side BVH prebuilding, and main-thread reconstruction optimization), the renderer operates across three independently usable `OSMTILE1` v1 regional mosaics covering the same geographic region at `1,024 m`, `2,048 m`, and `4,096 m` tile resolutions.

Each resolution has distinct runtime trade-offs:
- **`1,024 m`** provides fine spatial culling and smaller per-tile streaming footprints at street/neighborhood zoom, minimizing wasted off-screen triangles and per-tile commit latency.
- **`2,048 m`** balances draw-call count against spatial culling at intermediate city/district zoom.
- **`4,096 m`** minimizes draw calls and scene traversal cost at regional zoom (`zoom 0.15` CPU render time dropped from `36.50 ms` to `4.00 ms` on RTX 4060 Ti in `TKT-037`).

Serving only one fixed resolution forces either excessive draw calls at regional zoom (`1,024 m`) or unnecessarily coarse spatial granularity and large per-tile streaming footprints at street zoom (`4,096 m`).

---

## 2. Decision

Implement **uniform-viewport hierarchical tile streaming** across `1,024 m`, `2,048 m`, and `4,096 m` mosaics with the following architectural invariants:

### 2.1 Uniform Viewport Resolution (Single Active Resolution)
- Exactly **one** tile resolution is attached to the active Three.js composite scene at any rendered frame.
- **No distance-dependent mixed-resolution rendering** and **no cross-fading duplicate geometry** are permitted. Because the viewer uses an orthographic camera (ADR-0007), geographic objects share an approximately uniform screen-space scale across the viewport, making uniform viewport resolution both visually consistent and structurally simple.
- **No geographic geometry simplification (`LOD1–LOD3`)** is introduced; all resolutions reference existing `OSMTILE1` v1 LOD0 SQLite mosaics without rewriting or duplicating baked geometry.

### 2.2 Lightweight Hierarchical Descriptor & Shared Server Infrastructure
- A lightweight JSON descriptor (`HierarchicalRegionalMosaicDescriptor`, `schemaType: "hierarchical-regional-mosaic"`, `schemaVersion: 1`) references existing `mosaic.json` indexes by relative path (`scripts/create-hierarchical-mosaic-descriptor.ts`), selected via `OVERIJSSEL_HIERARCHICAL_MOSAIC_PATH` (taking precedence over `OVERIJSSEL_REGIONAL_MOSAIC_PATH` and the pilot default).
- Strict compatibility validation (`HierarchicalMosaicContract.ts`) verifies matching `snapshotId`, `sourceSha256`, `projectionId` (`EPSG:25832`), `bakeSchemaVersion`, `collarMeters`, `compression`, `bakeStatus: 'complete'`, non-zero UTM coverage overlap, and resolution-aware `lodPolicyHash` equivalence (accounting for `tileSizeMeters` included in `computeLodPolicyHash` during `OfflineTileConsolidator` consolidation).
- `RegionalMosaicHttpHandler.ts` auto-detects both legacy single-resolution `RegionalMosaicIndex` and multi-resolution `HierarchicalRegionalMosaicDescriptor`, sharing **one bounded LRU SQLite shard handle pool** across all resolutions (keys `r${tileSizeMeters}:${shardId}`) and serving resolution-qualified routes (`/api/tiles-region/r/:tileSizeMeters/:lod/:tx/:ty` and `/r/:tileSizeMeters/:snapshotId/:schemaVersion/:lod/:tx/:ty`) with strict integer validation and path confinement (`resolveSafeRelativeFile`).
- All resolution manifests are rebased onto one canonical UTM origin (`canonicalOriginEasting`, `canonicalOriginNorthing`), guaranteeing exact world-space coordinate alignment and cross-resolution feature picking parity.

### 2.3 Collision-Free Tile Identity & Zoom Hysteresis Policy
- In hierarchical mode, runtime tile keys are resolution-qualified (`r${tileSizeMeters}:l${lod}:tx_${tx}_ty_${ty}`), preventing collisions between tile coordinates across resolutions; single-resolution mode preserves legacy `tx_${tx}_ty_${ty}` keys for full backward compatibility.
- Zoom-to-resolution mapping (`HierarchicalResolutionPolicy.ts`) applies orthographic viewport-width compensation (`sqrt(1280 / viewportWidthPx)` clamped to `[0.75, 1.35]`, configurable) and provisional hysteresis deadbands:
  - `1,024 m ↔ 2,048 m`: zoom out `< 0.80` switches to `2,048 m`; zoom in `> 1.00` switches back to `1,024 m`.
  - `2,048 m ↔ 4,096 m`: zoom out `< 0.26` switches to `4,096 m`; zoom in `> 0.34` switches back to `2,048 m`.
- Direct non-adjacent jumps (`1,024 m ↔ 4,096 m`) are supported without intermediate activation stops.
- Preload (`1,024 m`) and retention (`2,048 m`) margins are expressed in physical ground meters rather than tile counts so off-screen fetch/keep spans do not quadruple at `4,096 m`.

### 2.4 Non-Blocking Background Preparation & Atomic Frame-Boundary Swap
- Incoming destination resolution tiles are fetched, decoded via the TKT-040 `combined` worker pipeline, and reconstructed off-scene in `prepared_inactive` state while the outgoing active resolution remains uninterruptedly visible and pickable.
- Activation occurs **atomically** at the frame boundary (`TileStreamManager.tick() -> activatePendingResolutionAtomic()`) only once **every** destination tile intersecting the current viewport is reconstructed (`prepared_inactive`, `cached_inactive`, or manifest `isEmpty`). Failed fetches (`error`) never count as ready.
- Pending transitions cleanly cancel on zoom reversal, retarget on rapid multi-band jumps, and recompute destination readiness dynamically if the camera pans mid-transition.
- Feature picking automatically restricts raycasts to the single attached active resolution scene graph.

### 2.5 Bounded Multi-Resolution Resource Budgets & Accounting
- `HierarchicalResourceBudget.ts` enforces a configurable total measured budget (default `768 MiB`), a bounded detached LRU inactive tile cache (default `192 MiB` / `48` tiles) for fast reverse-zoom reuse, worker decode backpressure (`192 MiB`), transition reserve suppression (`0.35`), and time-aware main-thread commits (`4.5 ms/frame`, minimum 1 tile per tick to prevent starvation).
- **Impossible-budget safeguard:** if active visible coverage plus destination replacement coverage exceeds `totalMemoryBudgetBytes` even after evicting cached inactive and non-visible preload tiles, the manager enters `deferred_budget`, cancels pending work, surfaces a diagnostic explanation, and **never evicts active visible coverage**.
- Resource telemetry strictly separates **directly measured** CPU/typed-array/BVH/instanced-index/queued/inactive bytes from explicitly labeled **estimated** GPU buffer VRAM (`estimatedGpuBytes`) and worker prep buffer estimates.

---

## 3. Consequences

### Positive
- Seamless zoom transitions across street (`1,024 m`), mid (`2,048 m`), and regional (`4,096 m`) scales without duplicating existing baked SQLite files or changing `OSMTILE1` v1 payloads.
- Zero visual double-rendering overlap and exact canonical world-coordinate & picking parity across resolutions.
- Bounded memory, bounded SQLite file handles, and fast reverse-zoom reuse via the detached LRU inactive cache.
- Full backward compatibility for existing single-resolution `mosaic.json` deployments.

### Trade-offs & Open Tuning
- Provisional hysteresis bands (`0.80/1.00`, `0.26/0.34`), default `768 MiB` total budget, and `192 MiB` inactive cache limits are initial engineering defaults and require validation/tuning on the owner's full Twente dataset with RTX 4060 Ti hardware.
- Atomic full-viewport swap requires temporarily holding active visible coverage plus destination visible coverage in memory during transitions; tight user-configured budgets may intentionally defer transitions (`deferred_budget`) rather than introduce blank holes.
- WebGL does not expose exact driver VRAM usage; GPU figures remain upper-bound buffer estimates.
