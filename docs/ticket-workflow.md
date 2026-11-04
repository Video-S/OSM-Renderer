# Ticket Workflow & Lifecycle Guide

This document defines the authoritative workflow and operational lifecycle for tracking, implementing, and verifying issues using the repository-local Markdown ticket system located in [`tickets/`](../tickets/).

Both human developers and AI assistants (Gemini) must follow these procedures to maintain consistency, auditability, and software quality.

---

## 1. Core Principles

1. **Repository Native**: Tickets are version-controlled Markdown files stored directly in `tickets/`. No third-party trackers, external APIs, databases, or runtime dependencies are required.
2. **Git-Backed Traceability**: Git history records all updates, discussions, diffs, and transitions over time.
3. **User Control**: Gemini never autonomously picks up and resolves unrequested tickets. Work is undertaken only when directed or approved by the user.
4. **Honest Verification**: A ticket is never marked `closed` without verifying that every acceptance criterion has passed through executed tests, builds, and visual verification. Note: Automated tests and build commands only need to be executed when code changes are made; filing a ticket, updating documentation, or maintaining ticket files does not require this step.

---

## 2. Directory Structure and Naming Standards

```text
tickets/
├── README.md                  # Quick-reference overview of the ticket system
├── TEMPLATE.md                # Base template for all new tickets
└── TKT-NNN-<kebab-title>.md   # Individual ticket files (e.g., TKT-001-building-clipping.md)
```

### Identifier Format (`TKT-NNN`)
- **Format**: `TKT-` followed by a three-digit (or more once exceeding 999) zero-padded sequential number: `TKT-001`, `TKT-002`, `TKT-010`.
- **Filename**: `TKT-NNN-<short-descriptive-title>.md` (all lowercase, hyphen-separated).
- **ID Stability**: The numeric ID remains fixed forever once assigned. If the ticket title changes, the ID must not be changed or reassigned.
- **No ID Reuse**: Never reuse an ID from a closed, cancelled, or rejected ticket.
- **Handling Discrepancies**: If existing ticket files or references show inconsistent numbering or filenames, identify and report the discrepancy clearly rather than silently renaming files or breaking links.

---

## 3. Metadata Specification

Every ticket starts with YAML frontmatter conforming to this schema:

```yaml
---
id: TKT-001
title: Concise, descriptive title of the issue or feature
type: bug
status: open
priority: medium
created: 2026-10-27
updated: 2026-10-27
---
```

### Allowed Values

| Field | Allowed Values | Description |
| :--- | :--- | :--- |
| `id` | `TKT-NNN` | Unique sequential identifier. |
| `title` | String | Brief title summarizing the problem or goal. |
| `type` | `bug` | Defects, visual errors, logic bugs, crashes, or regressions. |
| | `feature` | New user-facing functionality, UI elements, or controls. |
| | `tech_debt` | Code refactoring, performance improvements, or test expansion. |
| | `docs` | Architectural documentation, ADRs, or API references. |
| `status` | `open` | Initial state; ready to be scheduled and worked on. |
| | `in_progress` | Active development is underway in the current session. |
| | `blocked` | Progress cannot continue due to an explicit external barrier. |
| | `closed` | All acceptance criteria met and verified; work complete. |
| `priority` | `low` | Minor polish, non-critical debt, or cosmetic items. |
| | `medium` | Standard bugs, regular features, or typical backlog tasks. |
| | `high` | Severe visual defects, broken workflows, or notable slowdowns. |
| | `critical` | Application crashes, build breaks, or severe regressions. |
| `created` | `YYYY-MM-DD` | Date the ticket was originally authored. |
| `updated` | `YYYY-MM-DD` | Date of the latest meaningful update or state transition. |

---

## 4. Lifecycle & Procedures

### Phase A: Creating Tickets
Tickets are created when a bug is detected, a feature is scoped, technical debt is identified, or documentation gaps are found.

1. **Allocate the Next ID**:
   - Inspect the `tickets/` directory.
   - Determine the highest existing numeric ID (e.g., if `TKT-004` is highest, use `TKT-005`). If no tickets exist, start with `TKT-001`.
2. **Instantiate from Template**:
   - Copy `tickets/TEMPLATE.md` to `tickets/TKT-NNN-<title>.md`.
   - Update frontmatter fields (`id`, `title`, `type`, `status: open`, `priority`, `created`, `updated`).
3. **Draft Core Content**:
   - **Summary**: Concise explanation of the problem or objective.
   - **Context**: Where the issue was found, affected components, and why it matters.
   - **Observed Behavior vs. Expected Behavior**: Concrete description of the discrepancy (can be omitted for pure documentation or new feature tasks).
   - **Reproduction Steps**: Clear steps or test scenarios allowing another engineer or AI session to reproduce the defect without prior conversation context.
   - **Acceptance Criteria**: Concrete, testable, and observable conditions that must all be satisfied before the ticket can be closed.
   - **Related Files**: Relative Markdown links to source code (`src/...`), test files (`src/...test.ts`), and architecture docs (`docs/...`).
4. **Pragmatic Scope**:
   - One ticket per distinct problem or coherent work item. Do not bundle multiple unrelated defects into a single ticket.
   - Proposed implementation solutions are optional at creation time; describing the problem and criteria accurately is sufficient.
5. **No Test Execution for Ticket Authoring**:
   - Creating, filing, updating, or maintaining tickets and documentation files does not modify application code and therefore does not require running tests, linter, or build commands. Verification commands are only required when application code changes are made.

### Phase B: Selecting Tickets for Work
1. **User Control**: Gemini must not autonomously start working through open tickets unless explicitly instructed by the user.
2. **Reviewing the Backlog**: When requested to inspect open tickets:
   - Read and summarize open tickets by priority and type.
   - Identify dependencies between tickets (e.g., refactoring that must precede a feature).
   - Flag overlapping tickets that address the same underlying root cause to avoid redundant implementation efforts.
3. **Starting Work**: When a ticket is selected with user approval:
   - Transition `status` to `in_progress` in the ticket frontmatter.
   - Update the `updated` date.

### Phase C: Working on a Ticket
Before modifying code or creating assets, execute these pre-implementation steps:

1. **Read the Ticket**: Thoroughly read the entire ticket specification and acceptance criteria.
2. **Read Project Context & Rules**: Consult [`GEMINI.md`](../GEMINI.md), [`docs/README.md`](./README.md), and relevant domain specifications (e.g., [`docs/architecture.md`](./architecture.md), [`docs/geometry-and-rendering.md`](./geometry-and-rendering.md)).
3. **Inspect Existing Code & Tests**: Review the targeted source files and tests to understand existing contracts.
4. **Confirm the Issue**: Validate that the observed behavior reproduces or still applies in the current codebase. If the issue is already resolved or obsolete, document that finding rather than making unnecessary changes.
5. **Architectural Alignment**: Ensure the proposed solution respects existing architectural decisions. If an ADR change is necessary, document the rationale.
6. **Maintain Notes**: Add technical findings, key design decisions, or edge cases to `## Implementation notes` as work progresses.

### Phase D: Handling Blocked Work
If work cannot proceed due to an environmental limitation, missing dependency, upstream API failure, or unresolved design ambiguity:

1. Update frontmatter: `status: blocked` and update `updated: YYYY-MM-DD`.
2. Document the blocker clearly in the ticket under `## Implementation notes`:
   - What specific condition prevents progress.
   - What was investigated and what partial progress was made.
   - What exact decision, input, or external fix is required to unblock.
3. **Never mark a blocked ticket `closed`**. A ticket that cannot be finished must remain open or blocked.

### Phase E: Verifying and Closing Tickets
A ticket may only be moved to `closed` when all acceptance criteria have been satisfied and verified.

#### Six Mandatory Pre-Closure Steps:
1. **Criteria Checklist**: Check off every acceptance criterion in the checklist and confirm each is met.
2. **Automated Verification**: Execute the required project verification commands:
   - `npm test`: Automated unit and integration tests.
   - `npm run lint`: Typecheck (`tsc --noEmit`) and syntax checks.
   - `npm run build`: Production bundle compilation.
   - `npm run docs:api`: API documentation generator (when public interfaces change).
3. **Visual & Interactive Verification**: If the ticket affects 3D rendering, shaders, materials, camera controls, or UI, perform visual checks in the running environment and confirm absence of visual artifacts (e.g., z-fighting, clipping errors).
4. **Document Verification**: Update the `## Verification` section of the ticket with:
   - Actual commands executed and exit codes.
   - Summary of test results.
   - Observations from visual verification.
5. **Acknowledge Limitations**: If any non-critical limitation remains, explicitly record it in the ticket notes.
6. **Set Closed Status**: Change frontmatter `status` to `closed` and update `updated` to the current date.

> **Strict Truthfulness Rule**:
> - Never claim a check passed if it was not actually executed.
> - Never conceal test failures by modifying acceptance criteria after writing code.
> - If an environment prevents running a specific verification step, state the limitation openly and do not close the ticket without user confirmation.

### Phase F: Updating Metadata
- Whenever any ticket content, notes, or status changes, set `updated: YYYY-MM-DD` to the current date.
- Rely on Git for detailed change logs and diffs rather than creating redundant changelogs inside the ticket body.

### Phase G: Relating Tickets to Documentation
- **Tickets**: Track discrete, temporal units of work, bugs, and tasks.
- **Documentation (`docs/`)**: Represents persistent, stable architectural truth and system specifications.
- When resolving a ticket modifies an architectural contract or interface:
  1. Update the appropriate file in `docs/` or write an ADR in `docs/decisions/`.
  2. Reference the updated documentation in the ticket's `## Related files and documentation` section.
  3. Never duplicate entire architectural explanations inside a ticket.

---

## 5. Practical Conventions Summary

- **One Ticket, One Problem**: Keep tickets focused and atomic.
- **Observable Criteria**: Frame criteria as verifiable facts (e.g., "Road junction triangles do not overlap at elevation y=0.04m" rather than "Road looks good").
- **Relative Markdown Links**: Always use relative paths when referencing repository files (e.g., `[GeometryBuilder.ts](../src/world/GeometryBuilder.ts)`).
- **Supporting Assets**: Visual screenshots or logs should be placed in appropriate asset directories and linked as supporting evidence, accompanied by written explanations.
- **No Secrets**: Never commit tokens, credentials, or sensitive data in tickets or attachments.
- **Summary Reporting**: In AI assistant turn completions, always explicitly state the ticket IDs that were worked on, closed, blocked, or remain open.
