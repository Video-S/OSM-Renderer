# Regional Renderer History

> **Recorded 2026-11-22.** This is a chronological account, not a live acceptance checklist. For current status and outstanding gates use [STATUS.md](./STATUS.md); for the history of road/junction algorithms see [project-history.md](./project-history.md). Ticket measurements preserve their original hardware and methodology.

## From local geometry to a regional renderer

### October–November 2026: geometry and topology foundations

Initial neighborhood-scale renderer work used local equirectangular coordinates, explicit boundary-derived road junctions and full synchronous scene builds. Those strategies are preserved in earlier ADRs and benchmark records for historical comparison. The infrastructure graph and provenance contracts enabled the later production E2+ road and R+ railway implementations. On **2026-11-19** the project owner accepted the E2+/R+ production promotion and legacy renderer retirement ([TKT-026](../tickets/TKT-026-promote-e2plus-rplus-retire-legacy-renderers.md), [ADR-0010](./decisions/ADR-0010-surface-first-road-rendering.md)).

### 19–21 November: source integrity, offline tiles and runtime streaming

The project pinned the reproducible Geofabrik Overijssel snapshot **`overijssel-261114-8ae28196`**, verified the source hash, and built a persistent SQLite spatial index ([TKT-027](../tickets/TKT-027-overijssel-snapshot-integrity.md)). TKT-028 introduced UTM-aligned `OSMTILE1` offline baked geometry, source/manifest contracts, worker decoding, tile streaming and deterministic resource disposal. The project owner accepted the initial 1,024 m tiled streaming behavior after testing. The 512 m versus 1,024 m comparison and matched physical-margin experiment ([TKT-028-F1](../tickets/TKT-028-F1-physical-margin-parity.md)) motivated the **1,024 m regional LOD0** choice; this did not implement higher LODs.

### 21–22 November: the 16 km pilot and correctness investigation

[TKT-029](../tickets/TKT-029-regional-mosaic-pilot.md) combined **16 separately baked 4 × 4 shards** into a logical **16 × 16** / 1,024 m mosaic. TKT-031 measured the high cost of showing all detailed LOD0 tiles at once, motivating an interim zoom-out cap rather than inventing LOD1–LOD3.

[TKT-032](../tickets/TKT-032-cross-shard-continuity.md) and [TKT-033](../tickets/TKT-033-missing-road-rendering.md) investigated road gaps and shard continuity. The owner later established that some previously failing views had loaded the **old mosaic** rather than the new TKT-033 candidate. After selecting the candidate and checking the previously problematic road sites, the owner reported those locations correct. This was a meaningful **bounded visual acceptance**, **not global seam parity**. The server now defaults to the accepted candidate, and Developer Tools reports identity from the actual loaded manifest.

### 22 November: TKT-034 full-Twente scale-out begins

The next scale test is a **48 × 40** rectangular grid of **1,024 m tiles**, totaling **1,920 tiles / 120 shards** across **49.152 × 40.960 km**. The rectangle is larger than the Overijssel-only source polygon in some directions, so exterior and border tiles cannot represent complete neighboring German or Gelderland data.

The owner locally baked `r05-c07` and `r05-c08` in **92.7 s**, with peak **1,422.11 MiB RSS** and **34.50 MiB SQLite**; the partial integrity verifier passed **32/32 tiles**. The owner then authorized proceeding with a resumable full bake. At the time of this record, **full bake completion, full mosaic verification, targeted seams, hardware navigation and human visual acceptance remain unreported**. See [TKT-034](../tickets/TKT-034-full-twente-scale-out.md).

## Architectural lessons retained

- Always distinguish the **active server mosaic** from the dataset a URL label suggests; verify `manifest.packPath`.
- Data integrity, deterministic local geometry tests, seam audits and **human visual acceptance** are different kinds of evidence.
- Bounded baking and viewport streaming keep large worlds feasible, but a very wide LOD0 camera footprint still incurs high GPU work.
- Independent shard context does not prove a global road/rail graph is consistent across every shard boundary.
- The ultimate zombie-game direction is a *possible future use* of the renderer, not evidence that gameplay features are implemented.

See [ADR-0011](./decisions/ADR-0011-baked-tiles-and-runtime-streaming.md), [ADR-0012](./decisions/ADR-0012-bounded-regional-mosaics.md) and [ADR-0013](./decisions/ADR-0013-regional-camera-zoom-policy.md) for decisions behind these steps.
