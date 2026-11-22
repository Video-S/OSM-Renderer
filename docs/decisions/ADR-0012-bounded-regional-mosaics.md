# ADR-0012: Bounded Offline Shards and Manifest-Based Regional Mosaics

## Metadata

- **Decision ID**: `ADR-0012`
- **Status**: **Accepted for the 16 × 16 regional pilot**; 120-shard full-Twente scale-out remains under validation
- **Date recorded**: 2026-11-22 (retrospective TKT-029/TKT-032/TKT-033; new TKT-034 work)
- **Evidence**: TKT-029, TKT-032, TKT-033, TKT-034

## Context and problem

A single offline synthesis of all of Twente would exceed practical CPU/memory budgets. Independently baked tiles can be resumed and verified, but building OSM topology and planar surfaces independently across shard boundaries can introduce different geometric decisions. The original 16 km pilot was also vulnerable to loading an older mosaic after a candidate bake had already passed visual checks.

## Decision

1. **Partition the regional grid into independently baked 4 × 4-tile shards.** The pilot has 16 shards / 256 tiles of 1,024 m; the TKT-034 full-Twente rectangular plan has 120 shards / 1,920 tiles. Each shard queries the canonical Overijssel store with a **1,024 m context margin** and a **64 m tile collar**; no whole-Twente geometry scene is built as one unit.
2. **Persist separate SQLite `OSMTILE1` packs and a completed mosaic index.** Reuse is permitted only for compatible, validated shard packs. Interrupted work can resume; the new baker distinguishes incompatible packs from corrupt/incomplete packs and requires explicit `--recover-corrupt` for the latter. A partial run does **not** publish `mosaic.json`.
3. **Present one logical region through a manifest gateway.** `RegionalMosaicHttpHandler.ts` merges shard metadata and rebases shard-local tile-center offsets into the region's common projection origin. It validates source identity and manifest coverage. For larger mosaics, manifest assembly scans shard stores sequentially, while tile serving uses a **bounded open-shard SQLite handle pool** (default maximum 16).
4. **Keep datasets explicit.** The owner's accepted TKT-033 candidate at `data/osm/twente-pilot-1024m-tkt033-candidate/mosaic.json` is the server default. `OVERIJSSEL_REGIONAL_MOSAIC_PATH` overrides it. The viewer's `?region=twente-pilot`, `?region=twente` and `?region=twente-full` are aliases to the same API, **not dataset switches**. The active manifest's `packPath` is visible in Developer Tools.
5. **Validate incrementally.** Distinguish manifest/source/hash/decode checks from semantic 3D geometry parity. Use targeted boundary audits and owner-led visual inspection for roads, railways, tunnel/bridge portals, land use, water and markings.

## Accepted evidence and unresolved risks

The project owner visually accepted the TKT-033 pilot **after** confirming the application was actually serving the candidate mosaic; missing-road locations previously checked against the wrong active pack were then verified. This does **not** close the broader TKT-032 cross-shard continuity gate or establish global graph equivalence.

On 2026-11-22, two adjacent TKT-034 experimental shards (`r05-c07`, `r05-c08`) were baked and **32/32 tiles passed the local partial integrity verifier**. Measured run: 92.7 seconds, 34.50 MiB SQLite disk usage, 1,422.11 MiB peak RSS. The entire 120-shard mosaic, full integrity verification, seam review and visual acceptance remain **unconfirmed** as of this record.

The planned footprint is a **rectangle**, not the Twente administrative boundary. The Overijssel-only extract leaves 422 of its 1,920 planned tiles outside the source polygon; border/exterior data can be empty or clipped. Per-shard topology context is a mitigation, **not a global continuity proof**; large multipolygons, railway sleeper phase and long grade-separated corridors remain risks.

## Alternatives and consequences

- A single global synthesis could simplify some continuity semantics, but defeats current bounded resource use.
- A global precomputed infrastructure graph with tile-local clipping is an attractive *future* alternative; it must not be described as implemented for the current mosaic pipeline.
- Bounded shards increase verification surface and require explicit source/manifest provenance; they make large bakes resumable and amenable to targeted experiments.

## Related implementation

- `src/world/tiling/{RegionalMosaicPlan,RegionalMosaicDryRun}.ts`
- `scripts/{bake-regional-pilot,verify-regional-mosaic,audit-regional-seams}.ts`
- `src/server/tiles/RegionalMosaicHttpHandler.ts`
- `src/world/TilingFullTwenteScale.test.ts`, `src/world/TilingRegionalMosaic.test.ts`
- [ADR-0011](ADR-0011-baked-tiles-and-runtime-streaming.md), [ADR-0009](ADR-0009-infrastructure-graph-topology.md)

Do not promote the TKT-034 implementation to fully accepted before its outstanding owner-controlled checks complete.
