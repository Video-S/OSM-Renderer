# OSM Renderer

A browser-based, isometric **3D OpenStreetMap renderer** built with React, TypeScript, Three.js, React Three Fiber and a Node/Express development server. The current product is a **map renderer and camera/navigation system**, not a game. A future large-scale game is a possible downstream use, not an implemented feature.

## Current state (24 November 2026)

- **Production infrastructure geometry:** E2+ surface-first roads and R+ surface-first railways, with bridges, tunnels, buildings, terrain/land use and feature inspection.
- **Accepted regional pilot:** 16 × 16 tiles at 1,024 m (16.384 km per side), assembled from 16 independently baked 4 × 4 SQLite shards. The owner-accepted TKT-033 candidate is the **server default** when present.
- **Full Twente expansion, TKT-034:** a 48 × 40 tile rectangular mosaic (1,920 LOD0 tiles, 120 shards, 49.152 × 40.960 km). The owner has completed the full 120-shard bake, full structural integrity verification (`1,609` non-empty tiles), and initial navigation around Hengelo, Almelo, and Rijssen ([baseline report](docs/reports/tkt034-full-twente-baseline.md)). Formal regional seams, runtime performance, and full visual QA remain **open**.
- **Not implemented:** multi-resolution LOD1–LOD3, province-wide coverage, gameplay or zombie simulation.

The Twente rectangle overlaps neighboring areas outside the **Overijssel-only** OSM extract; coverage is not the same as an administrative Twente boundary. See [current project status](docs/STATUS.md) for the latest verified state and limitations.

## Run locally

From the repository root, with a Node.js version supporting `node:sqlite` (Node 22+ recommended):

```powershell
npm install
npm run dev
```

Open **http://localhost:3000/**. The regional pilot shortcut is:

- **http://localhost:3000/?m2a=1&region=twente-pilot&devtools=1**

The regional server defaults to `data/osm/twente-pilot-1024m-tkt033-candidate/mosaic.json`. This is a **local generated artifact**, not a guaranteed repository download. If it is missing, the regional manifest returns an error rather than silently substituting the old bake. The Overijssel PBF and its SQLite index are also local/generated data; see [offline dataset setup](docs/architecture/offline-overijssel-osm-dataset.md). Initial setup or large baking jobs can consume substantial disk space and time.

To select a different completed mosaic, start the server with an explicit path **before** running `npm run dev`:

```powershell
$env:OVERIJSSEL_REGIONAL_MOSAIC_PATH = "data/osm/twente-full-1024m/mosaic.json"
npm run dev
```

The URL `region=twente-full` is only a viewer alias; **it does not select the dataset on the server**. Check `(Invoke-RestMethod "http://localhost:3000/api/tiles-region/manifest").packPath` or Developer Tools for the actual loaded mosaic. Restart after changing the environment variable. Only select `twente-full-1024m` on machines where that mosaic has been generated and verified with `verify-regional-mosaic.ts`.

The default regional zoom-out floor is `0.15`. Developers can explicitly use `?regionalMinZoom=0.015` for a costly full-region LOD0 overview; this is **not** a replacement for future overview LODs.

## Offline regional baking

The [TKT-034 runbook](tickets/TKT-034-full-twente-scale-out.md) documents dry run, bounded experimental shards, integrity verification, resumable full baking and seam audits. Do **not** start a full bake as part of normal development setup or automated tests. The large output remains outside the code/documentation workflow.

## Quality checks

```powershell
npm test
npm run lint
npm run build
```

`npm run lint` currently runs `tsc --noEmit`. `npm run docs:api` regenerates TypeDoc output when exported APIs change. Automated geometry/pack checks cannot replace the owner's browser-based visual acceptance.

## Documentation

Start with [documentation index](docs/README.md), [current status](docs/STATUS.md), [architecture](docs/architecture/overview.md), [ADR index](docs/decisions/README.md) and [tickets](tickets/README.md). Historical proposals and benchmarks remain in the repository for provenance; **current code/tests and the current-status document take precedence over old plans**.

AI coding assistants should consult [GEMINI.md](GEMINI.md) and preserve the scope of the explicitly authorized task.
