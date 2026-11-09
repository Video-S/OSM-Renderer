# Project Documentation Index

Welcome to the 3D Map Viewer documentation. This repository implements a high-fidelity, browser-based 3D map viewer using OpenStreetMap data, React, TypeScript, Three.js, and React Three Fiber.

## Documentation Structure

This documentation is organized into two distinct categories:

1. **Manually Maintained Architecture & Specification Documents**: Authored and maintained by developers to capture design intent, system architecture, geometry rules, coordinate systems, and architectural decisions.
2. **Generated API Reference (`docs/api-reference/`)**: Generated automatically from TypeScript source code annotations using TypeDoc and `typedoc-plugin-markdown`.

---

## Manually Maintained Documents

**Current road-rendering direction (2026-11-09):** [ADR-0010](./decisions/ADR-0010-surface-first-road-rendering.md) selects E2+ surface-first rendering as the preferred architecture, based on strong owner visual evaluation. It is **not yet the production default**; full geometry and performance validation remain outstanding.

- **[Project History](./project-history.md)** — Goals, junction-rendering evolution, E2 to E2+ turning point, and evidence.
- **[E2+ Architecture & Geometry Design](./e2-plus-surface-first-road-rendering.md)** — Exact buffer algorithm, priority clipping, meshes/provenance, mode integration, limits.
- **[Road-Rendering Future Plans / Validation Roadmap](./road-rendering-roadmap.md)** — Baseline, regression matrix, scaling benchmarks, staged migration gates.
- **[E2+ Research Prototype](../research/surface-first-road-rendering/README.md)** — User-facing mode selection and experimental usage.


- **[Current Project Status (STATUS.md)](./STATUS.md)**  
  Tracks the active goalpost and implementation milestone (Goalpost 2: M2.1 & M2.2 complete, M2.3 Stage A active), verified test/build status, known limitations, and next steps.

- **[System Architecture (architecture.md)](./architecture.md)**  
  High-level system overview, component responsibilities, runtime data flow, module relationships, and architectural boundaries.

- **[Data Pipeline & Feature Support (data-pipeline-and-feature-support.md)](./data-pipeline-and-feature-support.md)**  
  OSM data ingestion, GeoJSON parsing, feature classification, bounding box clipping, coordinate conversion, and diagnostics.

- **[Geometry & Rendering Rules (geometry-and-rendering.md)](./geometry-and-rendering.md)**  
  Elevation policy, ground layering, road ribbons, boundary-derived junction meshing, bridges, tunnels, building footprints, and z-fighting prevention.

- **[Camera & World Coordinates (camera-and-world-coordinates.md)](./camera-and-world-coordinates.md)**  
  Local meter coordinate projection, orthographic camera configuration, viewport framing, zoom/pan/tilt controls, and bounds containment.

- **[Testing & Diagnostics (testing-and-diagnostics.md)](./testing-and-diagnostics.md)**  
  Unit/integration test suite, coplanar triangle overlap validators, junction portal continuity checks, feature counters, and regression verification.

- **[Architectural Decision Records (decisions/README.md)](./decisions/README.md)**  
  Index of formal architectural decision records (ADRs) and guidelines on recording decisions.
  - **[ADR Template (decisions/ADR-TEMPLATE.md)](./decisions/ADR-TEMPLATE.md)**: Reusable template for proposing and documenting architectural decisions.

- **[Ticket Workflow & Lifecycle (ticket-workflow.md)](./ticket-workflow.md)**  
  Authoritative guide for tracking, developing, verifying, and closing issues in the repository-local [Ticket Tracker](../tickets/).

- **[Exploratory Research & Experiments](../research/road-surface-reconstruction/README.md)**  
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
