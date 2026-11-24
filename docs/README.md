# OSM Renderer Documentation

This directory separates **current information**, **engineering references**, **proposals**, **measured results**, and **research**. Start with the three documents below; the detailed material is grouped by purpose.

## Start here

- [Current project status](./STATUS.md) — what is implemented, verified, blocked or not yet approved
- [Project history](./project-history.md) — a readable timeline of major developments and lessons
- [Repository setup](../README.md) — run the application and offline data pipeline

## Browse by topic

| Folder | What belongs here |
| --- | --- |
| [Architecture](./architecture/README.md) | Implemented system design, coordinate models, OSM pipeline and renderer behavior |
| [Guides](./guides/README.md) | Verification, profiling and ticket workflow instructions |
| [Decisions](./decisions/README.md) | ADRs: why major technical choices were made, including what they supersede |
| [Plans](./plans/README.md) | Historical proposals, roadmaps and work not necessarily approved or implemented |
| [Reports](./reports/README.md) | Benchmarks, experiment results and reproducible measurement artifacts |
| [Research](./research/README.md) | Exploratory algorithms, evaluation code, source fixtures and original figures |
| [History](./history/README.md) | Archived status snapshots for provenance |
| [Generated API reference](./api-reference/README.md) | TypeDoc-generated symbols and TypeScript API details |

Active work and verification gates are tracked in the [repository ticket system](../tickets/README.md), rather than mixed into the documentation folders.

## How to interpret these files

**Code and tests** describe actual runtime behavior. [STATUS.md](./STATUS.md) summarizes verified progress and gaps; [architecture/](./architecture/README.md) documents implemented structure; [decisions/](./decisions/README.md) explains why it exists. An old proposal or report is **not** proof that a feature has shipped. Visual acceptance belongs to the project owner.

The accepted regional pilot contains 256 detailed tiles. The 1,920-tile full-Twente bake and structural integrity baseline are recorded in [the TKT-034 baseline report](./reports/tkt034-full-twente-baseline.md), while cross-shard continuity, performance, and full visual acceptance remain pending under [TKT-034](../tickets/TKT-034-full-twente-scale-out.md).

## Maintaining the documentation

Keep this root intentionally small. Add new material to the folder matching its purpose, update nearby links, and avoid duplicating information between ADRs, status reports and history. Generate the code reference with `npm run docs:api`; do not hand-edit the generated pages.
