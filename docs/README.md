# Project Documentation Index

Welcome to the 3D Map Viewer documentation. This repository implements a high-fidelity, browser-based 3D map viewer using OpenStreetMap data, React, TypeScript, Three.js, and React Three Fiber.

## Start here: current information

1. [Repository overview and local setup](../README.md)
2. [Current implementation and verification status](./STATUS.md)
3. [Implemented architecture](./architecture.md)
4. [Architectural decision records](./decisions/README.md) — especially [ADR-0011](./decisions/ADR-0011-baked-tiles-and-runtime-streaming.md), [ADR-0012](./decisions/ADR-0012-bounded-regional-mosaics.md), and [ADR-0013](./decisions/ADR-0013-regional-camera-zoom-policy.md)
5. [TKT-034 full-Twente staged bake and acceptance](../tickets/TKT-034-full-twente-scale-out.md)

**Interpretation:** source/tests explain behavior, the status/architecture documents describe current implementation and acceptance, ADRs explain decisions, and tickets carry the task gates. Older proposals, milestone snapshots and benchmark notes are retained as history, not as authoritative current feature descriptions. The 16 km pilot is accepted; **full Twente remains unverified**.

---

## Documentation Structure

This documentation is organized into two distinct categories:

1. **Manually Maintained Architecture & Specification Documents**: Authored and maintained by developers to capture design intent, system architecture, geometry rules, coordinate systems, and architectural decisions.
2. **Generated API Reference (`docs/api-reference/`)**: Generated automatically from TypeScript source code annotations using TypeDoc and `typedoc-plugin-markdown`.

---

## Manually Maintained Documents

- **[Current Project Status (STATUS.md)](./STATUS.md)**  
  Authoritative status: E2+/R+ production, accepted 16 km pilot, in-progress TKT-034 full-Twente bake, verification boundaries, current risks and next steps. Earlier status snapshots are archived.

- **[System Architecture (architecture.md)](./architecture.md)**  
  High-level system overview, component responsibilities, runtime data flow, module relationships, and architectural boundaries.

- **[Data Pipeline & Feature Support (data-pipeline-and-feature-support.md)](./data-pipeline-and-feature-support.md)**  
  OSM data ingestion, GeoJSON parsing, feature classification, bounding box clipping, coordinate conversion, and diagnostics.

- **[Geometry & Rendering Rules (geometry-and-rendering.md)](./geometry-and-rendering.md)**  
  Elevation policy, ground layering, road ribbons, boundary-derived junction meshing, bridges, tunnels, building footprints, and z-fighting prevention.

- **[E2+ Surface-First Road Rendering Pipeline (e2-plus-surface-first-road-rendering.md)](./e2-plus-surface-first-road-rendering.md)**  
  Detailed specification of the E2+ (`roads: 'graph-surface'`) rounded 2D stroke buffering, priority-ordered Boolean ownership subtraction, triangulation, non-circular geometry validation (`SurfaceFirstRoadValidator.ts`), and performance instrumentation.

- **[Project History (project-history.md)](./project-history.md)**  
  A short, plain-language timeline from the first city map to production E2+/R+ rendering, baked regional tiles and the Twente expansion. Detailed decisions and verification remain in ADRs and tickets.

- **[Road Rendering Validation & Migration Roadmap (road-rendering-roadmap.md)](./road-rendering-roadmap.md)**  
  Validation architecture, discovered geometry edge cases, and production promotion record for E2+ (`roads: 'graph-surface'`) and R+ (`railways: 'graph-R+'`) under `TKT-026`.

- **[Camera & World Coordinates (camera-and-world-coordinates.md)](./camera-and-world-coordinates.md)**  
  Local meter coordinate projection, orthographic camera configuration, viewport framing, zoom/pan/tilt controls, and bounds containment.

- **[Persistent Offline Overijssel OSM Dataset (offline-overijssel-osm-dataset.md)](./offline-overijssel-osm-dataset.md)**  
  Immutable canonical Geofabrik Overijssel snapshot (`overijssel-261114-8ae28196`), SQLite + R\*Tree spatial storage, strict `source_sha256` verification, and PowerShell setup guide (`TKT-022`, `TKT-027`).

- **[Regional Tiling, Streaming, Offline Baking & Orthographic LOD Proposal (`TKT-028`) (regional-tiling-streaming-lod-proposal.md)](./regional-tiling-streaming-lod-proposal.md)**  
  Historical proposal and future options, **not** a current feature inventory. LOD0 baked-first UTM tiling is implemented; global topology parity and LOD1–LOD3 remain proposed. Consult ADR-0011/0012 and current status.

- **[Testing & Diagnostics (testing-and-diagnostics.md)](./testing-and-diagnostics.md)**  
  Unit/integration test suite, coplanar triangle overlap validators, junction portal continuity checks, E2+ surface-first geometry validator & performance counters, and regression verification.

- **[Performance Benchmarking & Developer Profiling (benchmarking-and-profiling.md)](./benchmarking-and-profiling.md)**  
  Reproducible Node.js CPU (`npm run bench:cpu`) and Playwright + Chromium WebGL (`npm run bench:browser`) benchmarking infrastructure, frozen offline datasets, versioned JSON reports, baseline comparison (`npm run bench:compare`), metric definitions, and step-by-step CPU/memory/WebGL profiling guides (`TKT-016`, `TKT-017`).

- **[Architectural Decision Records (decisions/README.md)](./decisions/README.md)**  
  Index of architectural decision records, **including regional ADR-0011/0012/0013**, with guidance on historical versus currently applicable decisions.
  - **[ADR Template (decisions/ADR-TEMPLATE.md)](./decisions/ADR-TEMPLATE.md)**: Reusable template for proposing and documenting architectural decisions.

- **[Ticket Workflow & Lifecycle (ticket-workflow.md)](./ticket-workflow.md)**  
  Authoritative guide for tracking, developing, verifying, and closing issues in the repository-local [Ticket Tracker](../tickets/).

- **[E2+ Surface-First Road Rendering Experiment & Baseline (`research/surface-first-road-rendering/`)](../research/surface-first-road-rendering/README.md)**  
  Evaluation guide, reproduction commands, and reproducible 12-dataset geometry integrity and performance baseline (`baseline-results.json`) comparing `legacy`, `graph` (E2), and `graph-surface` (E2+).

- **[Archived Exploratory Research (`research/road-surface-reconstruction/`)](../research/road-surface-reconstruction/README.md)**  
  Archived exploratory research evaluating independent road-surface and junction reconstruction algorithms against external ground truth (BGT). Closed and not adopted for production.


---


## Generated API Reference

- **[API Reference (`docs/api-reference/`)](./api-reference/)**  
  Detailed Markdown reference of core types, interfaces, classes, and exported functions.

### Regenerating API Documentation

To regenerate the API documentation from the current TypeScript sources, run:

```bash
npm run docs:api
```

> **Note**: Always inspect the generated reference under `docs/api-reference/` after making changes to exported types, functions, or classes. Generated files should remain committed to the repository for AI coding tool accessibility, and should never overwrite manually maintained documentation files.
