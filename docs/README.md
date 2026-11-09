# Project Documentation Index

Welcome to the 3D Map Viewer documentation. This repository implements a high-fidelity, browser-based 3D map viewer using OpenStreetMap data, React, TypeScript, Three.js, and React Three Fiber.

## Documentation Structure

This documentation is organized into two distinct categories:

1. **Manually Maintained Architecture & Specification Documents**: Authored and maintained by developers to capture design intent, system architecture, geometry rules, coordinate systems, and architectural decisions.
2. **Generated API Reference (`docs/api-reference/`)**: Generated automatically from TypeScript source code annotations using TypeDoc and `typedoc-plugin-markdown`.

---

## Manually Maintained Documents

- **[Current Project Status (STATUS.md)](./STATUS.md)**  
  Tracks the active goalpost and implementation milestone (Goalpost 2: M2.1 & M2.2 complete, M2.3 Stage A active), verified test/build status, known limitations, and next steps.

- **[System Architecture (architecture.md)](./architecture.md)**  
  High-level system overview, component responsibilities, runtime data flow, module relationships, and architectural boundaries.

- **[Data Pipeline & Feature Support (data-pipeline-and-feature-support.md)](./data-pipeline-and-feature-support.md)**  
  OSM data ingestion, GeoJSON parsing, feature classification, bounding box clipping, coordinate conversion, and diagnostics.

- **[Geometry & Rendering Rules (geometry-and-rendering.md)](./geometry-and-rendering.md)**  
  Elevation policy, ground layering, road ribbons, boundary-derived junction meshing, bridges, tunnels, building footprints, and z-fighting prevention.

- **[E2+ Surface-First Road Rendering Pipeline (e2-plus-surface-first-road-rendering.md)](./e2-plus-surface-first-road-rendering.md)**  
  Detailed specification of the E2+ (`roads: 'graph-surface'`) rounded 2D stroke buffering, priority-ordered Boolean ownership subtraction, triangulation, non-circular geometry validation (`SurfaceFirstRoadValidator.ts`), and performance instrumentation.

- **[Project History: Road Surface & Junction Rendering (project-history.md)](./project-history.md)**  
  Chronological evolution from Goalpost 1 boundary-derived junctions (`ADR-0002`) and Stage E2 (`TKT-008`) to the E2+ surface-first road renderer (`ADR-0010`).

- **[Road Rendering Validation & Migration Roadmap (road-rendering-roadmap.md)](./road-rendering-roadmap.md)**  
  Validation architecture, discovered geometry edge cases, and promotion criteria for migrating E2+ (`roads: 'graph-surface'`) to the production default.

- **[Camera & World Coordinates (camera-and-world-coordinates.md)](./camera-and-world-coordinates.md)**  
  Local meter coordinate projection, orthographic camera configuration, viewport framing, zoom/pan/tilt controls, and bounds containment.

- **[Testing & Diagnostics (testing-and-diagnostics.md)](./testing-and-diagnostics.md)**  
  Unit/integration test suite, coplanar triangle overlap validators, junction portal continuity checks, E2+ surface-first geometry validator & performance counters, and regression verification.

- **[Architectural Decision Records (decisions/README.md)](./decisions/README.md)**  
  Index of formal architectural decision records (ADRs) and guidelines on recording decisions.
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
