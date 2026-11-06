# AI Assistant Developer Guidelines

This repository contains a browser-based 3D OpenStreetMap viewer built with React, TypeScript, Three.js, and React Three Fiber.

When working on this codebase, adhere strictly to the following instructions:

## Workflow & Documentation Discipline

1. **Consult Documentation First**:
   - Read `docs/README.md` before starting any substantial task.
   - Read `docs/STATUS.md` and the relevant domain documents (`docs/architecture.md`, `docs/geometry-and-rendering.md`, `docs/data-pipeline-and-feature-support.md`, `docs/camera-and-world-coordinates.md`, `docs/testing-and-diagnostics.md`, and `docs/decisions/`).
   - If this development environment does not automatically load `GEMINI.md`, you must consult it explicitly.

2. **Source of Truth Hierarchy**:
   - **Source Code**: Authority for current implementation behavior.
   - **Tests**: Executable behavioral expectations and regression contracts.
   - **Documentation**: Description of intended behavior, geometry specifications, and architectural decisions.
   - **Discrepancy Rule**: If the source code, automated tests, and documentation contradict one another, identify and report the discrepancy clearly rather than silently picking one.

3. **Architecture Preservation**:
   - Preserve established architectural decisions unless there is an explicit, justified reason to alter them.
   - When a significant architectural decision or interface contract changes, update the corresponding documentation files and Architectural Decision Records (`docs/decisions/`).

4. **Verification & Honesty**:
   - Running the relevant automated tests and build commands (`npm test`, `npm run lint`, `npm run build`, `npm run docs:api`) remains mandatory whenever making application code changes. Filing a ticket, updating documentation, or maintaining ticket files does not need this step.
   - Manual browser-based visual verification is optional unless explicitly requested by the project owner or an individual ticket. Screenshot capture and review are not required for ticket or milestone closeout.
   - Report actual commands executed, exit codes, and output.
   - **Never claim** that tests, compilation, or visual verification were performed or succeeded unless they were actually executed in the environment.

5. **Scope Boundary**:
   - The active project scope is **Goalpost 2: Infrastructure Topology, Railway Rendering, and Surface Markings**.
   - Work only on milestones, stages, and tasks explicitly approved by the project owner; an active goalpost or milestone does not automatically authorize implementation of every planned milestone or stage.
   - Milestones 2.1 (`M2.1`), 2.2 (`M2.2`), Milestone 2.3 Stage A (`M2.3-A` / `TKT-003`, `ADR-0009`), Milestone 2.3 Stage B (`M2.3-B` / `TKT-004`: Road Network Graph Construction), Milestone 2.3 Stage C (`M2.3-C` / `TKT-005`: Railway Network Graph Construction), Milestone 2.3 Stage D (`M2.3-D` / `TKT-006`: Cross-Modal Connectivity, Level Crossings, and Grade Transitions), and Milestone 2.3 Stage E1 (`M2.3-E1` / `TKT-007`: Graph-to-Renderer Adapter and Safe Integration) are complete and accepted. Milestone 2.3 Stage E2 (`M2.3-E2` / `TKT-008`: Graph-Driven Road Rendering and Junction Geometry) is authorized; Stages `E3` (graph-driven railway rendering and switches), `E4` (level crossings, bridges, and tunnels), and `E5` (legacy cleanup and regression hardening) remain unauthorized pending separate project-owner review and approval.
   - Do not introduce gameplay, combat, zombie simulation, physics simulations, backend databases, or speculative streaming architectures.

6. **Ticket System & Workflow**:
   - Follow the procedures detailed in [`docs/ticket-workflow.md`](docs/ticket-workflow.md) and [`tickets/README.md`](tickets/README.md).
   - When asked to work on a ticket, read the complete ticket before making changes.
   - When asked for outstanding tickets, inspect `tickets/` and summarize relevant open items.
   - Do not automatically take unrelated tickets into scope; work only on user-approved items.
   - Keep ticket statuses and verification records accurate.
   - Update relevant documentation when an implementation changes a documented architectural contract.
   - Never mark a ticket closed without satisfying and verifying its acceptance criteria.
   - Report the ticket IDs completed, blocked, or left open in the final implementation summary.

