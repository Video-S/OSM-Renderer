# Repository Ticket System

Welcome to the repository-local issue tracking system. This directory hosts Git-backed tickets for tracking outstanding bugs, feature enhancements, technical debt, and documentation tasks without requiring external databases or third-party project management services.

---

## Quick Reference

- **Template**: [`TEMPLATE.md`](./TEMPLATE.md)
- **Detailed Workflow Guide**: [`docs/ticket-workflow.md`](../docs/ticket-workflow.md)
- **Ticket ID Format**: `TKT-NNN` (e.g., `TKT-001`, `TKT-002`)
- **Ticket Filename Format**: `TKT-NNN-<kebab-case-title>.md` (e.g., `TKT-001-building-boundary-clipping.md`)

---

## 1. Creating a Ticket

1. **Find Next ID**: Inspect the existing files in `tickets/`. Find the highest numeric ID and allocate the next unused sequential number (e.g., if highest is `TKT-003`, next is `TKT-004`). If no tickets exist yet, start with `TKT-001`.
2. **Copy Template**: Copy [`TEMPLATE.md`](./TEMPLATE.md) to a new file named `tickets/TKT-NNN-<short-descriptive-title>.md`.
3. **Fill Frontmatter**: Update YAML frontmatter with the assigned ID, concise title, appropriate type, initial status (`open`), priority, and today's date (`YYYY-MM-DD`).
4. **Complete Sections**: Provide clear summary, context, observed vs. expected behavior, reproduction steps, and observable acceptance criteria.
5. **Commit**: Commit the new ticket file to Git alongside related branch work or as an independent task.

> **Note**: Never reuse an ID, even if a previous ticket was closed, rejected, or deleted. Keep the ID stable throughout the ticket's lifecycle even if the title evolves.

---

## 2. Classification Reference

### Type (`type`)
- `bug`: Defects, visual artifacts, calculation errors, regression failures, or crashes.
- `feature`: New user-facing capabilities, controls, or rendering features within scope.
- `tech_debt`: Refactoring, performance optimization, structural cleanup, or test coverage expansion.
- `docs`: Documentation updates, ADR drafts, architecture corrections, or API doc additions.

### Priority (`priority`)
- `low`: Minor cosmetic issues, non-blocking debt, or nice-to-have documentation polish.
- `medium`: Normal bugs, standard feature improvements, or typical non-urgent tasks.
- `high`: Major visual defects, noticeable performance drops, or broken key features.
- `critical`: Application crashes, data corruption, blocking build failures, or severe regressions.

### Status (`status`)
- `open`: Ready to be prioritized and worked on.
- `in_progress`: Actively being worked on in the current session.
- `blocked`: Cannot proceed due to an explicit external blocker, missing prerequisite, or dependency.
- `closed`: Acceptance criteria fully satisfied, verified by tests/builds, and documented.

---

## 3. What Information Belongs in a Ticket

A good ticket is self-contained so that any future human or AI development session can immediately understand the task without requiring conversation context from the session where it was originally logged.

- **Clear Summary & Context**: What is the issue and where does it occur?
- **Observed vs. Expected**: Concrete difference between current behavior and desired behavior (can be omitted for pure docs/feature tasks if not applicable).
- **Reproduction**: Minimal steps or test scenario to see the defect.
- **Acceptance Criteria**: Checkbox list of specific, observable, testable outcomes required to close the ticket.
- **Verification Plan & Results**: Empty when created; filled with actual automated command outputs and test passes prior to closing, with optional visual check notes where applicable.
- **Related References**: Links to source files (`src/...`), test files (`src/...test.ts`), and architectural docs (`docs/...`).

Do not include API keys, credentials, personal secrets, or full dumps of unrelated logs.

---

## 4. How Gemini / AI Assistants Interact With Tickets

1. **Read First**: When instructed to address a ticket, read the entire ticket file and all referenced documentation/code before writing or editing code.
2. **User in Control**: Gemini must **never** unilaterally begin working through every open ticket in the repository. Gemini works only on tickets requested or prioritized by the user.
3. **Inspect When Requested**: When asked to review outstanding work, Gemini inspects `tickets/`, summarizes open tickets grouped by priority/type, and highlights blockers or dependencies.
4. **Track Active Work**: Set `status: in_progress` and update `updated: YYYY-MM-DD` when starting implementation.
5. **Honest Verification**:
   - Run tests (`npm test`), type check / linter (`npm run lint`), build (`npm run build`), and API docs if applicable (`npm run docs:api`). Automated regression tests are the default verification method.
   - Manual browser-based visual inspection is optional, not mandatory for ticket acceptance or closure. Screenshot capture and screenshot indexes are not required for milestone or ticket closure.
   - Record actual commands and exit status in the ticket's `## Verification` section.
   - **Never claim** that visual verification or tests were performed when they were not.
   - **Never** mark a ticket `closed` if any acceptance criterion is unmet or if required automated checks were not executed. If a check could not be run, document the limitation honestly and leave the ticket `open` or `blocked`.
6. **Closing**: Set `status: closed` and update the `updated` date only after all criteria are met and verified.
7. **Reporting**: Clearly report the ticket ID(s) completed, blocked, or left open in the final turn summary.

---

## 5. Relationship to Git and Documentation

- **Git Commits**: Reference ticket IDs in commit messages (e.g., `fix(roads): resolve junction triangle z-fighting (TKT-002)`).
- **Architecture Docs & ADRs**: Tickets track transient, discrete tasks. In contrast, `docs/` and `docs/decisions/` describe persistent architectural rules and system design. If a ticket implementation requires modifying an established architectural contract or introduces a new pattern, update the corresponding documentation in `docs/` and link to it in the ticket.
