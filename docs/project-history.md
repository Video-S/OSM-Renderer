# Project History

**What this is:** a short account of how OSM Renderer got here. It explains the important changes and lessons, without trying to document every experiment or ticket. For what works **today**, see [Current Status](./STATUS.md). For technical decisions and evidence, see the [ADRs](./decisions/README.md) and [tickets](../tickets/).

## The story so far

### 1. A detailed map of one city (October 2026)

The project began as a browser-based 3D OpenStreetMap viewer with an isometric camera. We wanted convincing real-world roads, railways, buildings, and land use—not gameplay yet.

The first approach built an entire local scene from OSM data when the map loaded. It was a useful prototype, but large areas took too long to process. Roads and other surfaces also overlapped, causing visual artifacts.

### 2. Making roads and railways reliable (late October–19 November)

We tried explicitly constructing road junctions by trimming roads and joining their edges. This worked for simple intersections but broke down at tight corners, shallow forks, and dense footpath networks. Adding a road-network graph improved our understanding of connectivity, but did not make those junction shapes reliable by itself.

An investigation into reconstructing road surfaces from Dutch BGT data was **not adopted**: the extra geometric assumptions did not consistently improve the result when the OSM inputs lacked enough detail.

The turning point was **surface-first geometry**: construct road areas first and assign overlapping space to the correct surfaces, instead of trying to join individually trimmed junction pieces. This became **E2+ roads**. Railways developed into **R+**, with unified ballast surfaces and hybrid close-/far-view track rendering. The owner accepted E2+ and R+ as the production approaches on **19 November 2026**.

**Lesson:** a correct connectivity graph and a visually correct road surface are different problems. Both matter.

[Road decision](./decisions/ADR-0010-surface-first-road-rendering.md) · [Railway decision](./decisions/ADR-0008-hybrid-railway-rendering-and-uv-ribbon-architecture.md) · [Discarded BGT research](../research/road-surface-reconstruction/README.md)

### 3. From one scene to a streamed world (19–21 November)

Even good geometry was too expensive to rebuild as one enormous browser scene. We switched to **offline baking**: generate detailed map tiles in advance, store them in SQLite files, and load only the tiles needed by the camera.

We pinned a reproducible Overijssel OSM snapshot and introduced a shared regional coordinate grid. Tests and measurements led us to **1,024-metre detailed tiles** for the regional pilot. The browser gained tile streaming, eviction, and resource cleanup.

**Lesson:** large geographic coverage does not require all of its geometry in browser memory at once.

[Baked tiles and streaming](./decisions/ADR-0011-baked-tiles-and-runtime-streaming.md) · [Source data](../tickets/TKT-027-overijssel-snapshot-integrity.md)

### 4. First regional success—and a testing lesson (21–22 November)

We assembled a **16.4 × 16.4 km** Hengelo–Enschede pilot from **16 separately baked groups** containing **256 tiles**.

When investigating missing roads, we discovered that some checks were still viewing an *older* baked dataset. After explicitly loading the corrected candidate and inspecting the affected locations, the owner accepted the pilot's result.

That did **not** prove that every road, railway, or surface is continuous across all tile-group boundaries. That remains a separate correctness question.

**Lesson:** always verify which dataset is actually loaded before diagnosing renderer defects.

[Regional mosaics](./decisions/ADR-0012-bounded-regional-mosaics.md) · [Missing-road investigation](../tickets/TKT-033-missing-road-rendering.md)

### 5. Expanding to Twente (22 November onward)

The next target is a **49.2 × 41.0 km** rectangular map: **1,920 tiles** in **120 independently baked groups**. The first two groups—**32 tiles**—were successfully baked and integrity-verified on the owner's computer.

At the time of this record, the full bake, cross-boundary checks, performance assessment, and human visual acceptance are **not yet complete**. The source also covers Overijssel, not every area beyond its border.

[Full-Twente plan and validation](../tickets/TKT-034-full-twente-scale-out.md)

## Where this is going

The immediate product is still **the map renderer**. The priority is to finish regional correctness and performance work, then simplify and maintain the codebase. A large-scale zombie game is a possible later application, **not an implemented or currently approved feature**.

This history should change only when a meaningful new chapter occurs. Routine status updates belong in [STATUS.md](./STATUS.md); design rationale belongs in the [ADRs](./decisions/README.md).
