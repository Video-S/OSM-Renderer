# AI Assistant Developer Guidelines — OSM Renderer

This repository contains a **3D OpenStreetMap renderer and camera/navigation system** built with React, TypeScript, Three.js, React Three Fiber and a Node/Express server. **It is not yet a game.**

## Read before making changes

1. Start with [`docs/README.md`](docs/README.md), [`docs/STATUS.md`](docs/STATUS.md), [`docs/architecture.md`](docs/architecture.md), the [ADR index](docs/decisions/README.md), and the specific ticket under [`tickets/`](tickets/). Consult renderer-specific documents where relevant.
2. **Source of truth:** current source code explains behavior; tests define executable contracts; **`docs/STATUS.md`** describes current accepted and pending milestones; ADRs record architectural rationale; tickets define per-task acceptance. Historical plans, proposed architectures, outdated snapshots and benchmarks must not be mistaken for the current implementation.
3. Report discrepancies among source, tests, current docs and old tickets explicitly rather than papering over them.

## Current implementation and scope (2026-11-22)

- **E2+ surface-first roads and R+ surface-first railways are the only production infrastructure renderers** (TKT-026 closed, ADR-0010). Previous legacy and intermediate renderers are retired; do not re-introduce them.
- **Canonical Overijssel source** `overijssel-261114-8ae28196` with strict identity checks (TKT-027).
- **Offline tiled LOD0 map rendering is implemented:** UTM `EPSG:25832` grid, `OSMTILE1` SQLite packs, 1,024 m regional tiles, 4 × 4-tile bounded shards, runtime viewport streaming, material sharing, worker decode, eviction and on-demand tile loading (ADRs 0011–0012).
- The **16 km / 256-tile regional pilot** has an owner-accepted TKT-033 candidate. The server defaults to that local mosaic; `OVERIJSSEL_REGIONAL_MOSAIC_PATH` overrides it. The viewer's `?region=...` parameter **does not select a server dataset**.
- **TKT-034 48 × 40 / 1,920-tile Twente scale-out is in progress**: two test shards / 32 tiles passed owner verification; whole-region integrity, seams, performance and visual acceptance remain outstanding.
- Orthographic regional **minZoom `0.15`** is the conservative LOD0 safeguard; developer/benchmark override is explicit (ADR-0013).
- **Not implemented or automatically approved:** LOD1–LOD3, global cross-shard graph plans, whole-Overijssel bake, gameplay, physics, zombies, pathfinding agents or unrelated infrastructure.

Historical Goalpost 2 planning documents and ADRs remain relevant to the *why*, not necessarily to today's feature availability.

## Scope, architecture and documentation discipline

1. Work **only** on explicitly authorized changes. Do not autonomously start another ticket or a full regional bake. Unless specifically authorized, do not merge unrelated cleanup, change renderer geometry, alter accepted data assets, or introduce gameplay/LOD work.
2. Distinguish the **live/local** `WorldCoordinates.ts` / runtime geometry path from the **offline regional** `RegionalProjection.ts` / tiled `TileStreamManager.ts` path (ADR-0001 + ADR-0011).
3. Preserve source provenance, E2+/R+ semantics, grade separation, tile/resource ownership and deterministic validation. Do not claim cross-shard visual parity from manifest/hash checks alone.
4. Update `docs/STATUS.md`, relevant domain documentation, and `docs/decisions/` when changing an accepted architectural or user-visible contract. **Create a new ADR** when introducing a substantive architectural decision; preserve original historical decisions and mark replacements/qualified scopes explicitly.
5. Maintain a clear distinction in docs between **implemented**, **owner-accepted**, **tested in a synthetic harness**, **unverified locally**, and **proposed**. Preserve benchmark provenance and owner-measured numbers; do not invent run results or dates.
6. When modifying documentation-only files, verify links and internal consistency. Do not claim application build/tests were rerun if they were not. For application code changes, execute relevant tests and `npm run lint`, `npm run build`, and `npm run docs:api` when exported API documentation changes. Report exact commands and results.
7. **Visual testing belongs to the project owner.** Do not substitute speculative LLM screenshot comparisons or claim owner acceptance without explicit evidence.

## Ticket workflow and repository hygiene

Follow [`docs/ticket-workflow.md`](docs/ticket-workflow.md) and [`tickets/README.md`](tickets/README.md). Read the complete ticket before implementation. Keep status and verification notes accurate, but do **not** silently close a ticket simply because some subcomponents passed. TKT-032 has outstanding broader shard-seam validation; TKT-034 remains in progress until the full region is independently checked.

Use `main` only when the owner explicitly authorizes direct changes; Google AI Studio's checkout limitation is not permission to merge or change branches without direction.

Report changed files, what was verified, what could not be verified, and which acceptance gates remain open.
