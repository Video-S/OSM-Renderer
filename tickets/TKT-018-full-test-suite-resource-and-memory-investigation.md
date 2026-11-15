---
id: TKT-018
title: Full Test Suite Resource Usage and Memory Investigation
type: tech_debt
status: open
priority: high
created: 2026-11-15
updated: 2026-11-15
---

# TKT-018: Full Test Suite Resource Usage and Memory Investigation

## Summary
Running `npm test` (`tsx --test --test-concurrency=1 src/world/*.test.ts`) makes a 16 GB RAM Windows workstation virtually unresponsive even though `--test-concurrency=1` is already enabled. Investigate the root cause of excessive memory, swap, or CPU/process pressure during full-suite execution, establish per-file resource profiling, add bounded test isolation and a lightweight smoke-test script, without modifying production geometry algorithms merely to speed up tests.

## Context
- `package.json` defines `"test": "tsx --test --test-concurrency=1 src/world/*.test.ts"`, which executes 25 test files (`330+` test cases) including real-world Amsterdam Centraal, Station Hengelo, and 12-dataset E2+ geometric validation suites.
- During `TKT-017` local validation on a 16 GB RAM Windows host, running `npm test` drove the machine to near-unresponsiveness despite `--test-concurrency=1`, whereas running focused test files (`BenchmarkInfrastructure.test.ts` + `BenchmarkReliability.test.ts`) and batched CI runs (`.github/workflows/validation.yml`) completed smoothly.
- Because `--test-concurrency=1` is already present, the bottleneck cannot be assumed to be uncontrolled parallel file execution alone; potential factors include Node.js `node:test` child-process accumulation, per-file `tsx` TypeScript transpilation/source-map overhead, retained scene/TypedArray buffers across long-lived subtests within heavy test files, or GC/swap pressure on 16 GB Windows systems.

## Observed Behavior
- Executing `npm test` across all `src/world/*.test.ts` files on a 16 GB RAM Windows machine makes the OS virtually unresponsive.
- Executing focused test files individually (e.g., `npx tsx --test --test-concurrency=1 src/world/BenchmarkInfrastructure.test.ts src/world/BenchmarkReliability.test.ts`) or in isolated CI matrix slices (`.github/workflows/validation.yml`) runs reliably within normal memory bounds.

## Expected Behavior
- Full test suite execution has documented, bounded peak RSS and heap behavior across both Linux CI and 16 GB RAM Windows workstations.
- Developers have a fast, low-memory smoke-test command (`npm run test:smoke` or equivalent) for routine local checks alongside a safe, isolated full-suite runner (`npm test` / batched runner) that does not exhaust 16 GB RAM.

## Reproduction Steps
1. On a 16 GB RAM Windows machine, install dependencies (`npm install`).
2. Run `npm test` (`tsx --test --test-concurrency=1 src/world/*.test.ts`) while monitoring peak process RSS, V8 heap, and system commit charge.

## Acceptance Criteria
- [ ] Profile peak RSS, V8 heap usage, execution duration, and process spawning behavior across all 25 test files in `src/world/*.test.ts` (identifying top memory/CPU contributors without modifying geometry synthesis algorithms).
- [ ] Document the established root cause(s) of Windows 16 GB RAM exhaustion in `## Implementation notes` (e.g., whether driven by specific heavy test files, retained buffers, `node:test` isolation, or `tsx` loader overhead).
- [ ] Add explicit memory limits, cleanup/disposal hygiene where tests retain large scenes unnecessarily, and isolated sequential/batched execution if required so full test execution remains responsive on 16 GB hosts.
- [ ] Introduce a dedicated lightweight smoke-test script (e.g., `npm run test:smoke`) covering core invariants and benchmark/infrastructure reliability without triggering heavy multi-city sweeps.
- [ ] Ensure `.github/workflows/validation.yml` and `docs/testing-and-diagnostics.md` reflect the updated test commands and isolation guarantees.
- [ ] Verify `npm run lint`, `npm run build`, smoke tests, and isolated test batches pass cleanly.

## Implementation Notes
- **Constraint**: Do **not** alter road or railway geometry algorithms or weaken geometric assertions merely to reduce test execution time.
- Focus `TKT-017` separately on benchmark reliability; do not run uncontrolled full-suite `npm test` stress runs on the 16 GB Windows machine prior to `TKT-018` profiling.

## Verification
- Status: Unverified
- Verification steps:
  - Per-file RSS & duration profiling across `src/world/*.test.ts`
  - Lightweight smoke-test script execution on Windows & Linux
  - `npm run lint`
  - `npm run build`

## Related Files and Documentation
- Scripts & CI: `package.json`, `.github/workflows/validation.yml`
- Test Suite: `src/world/*.test.ts`
- Documentation: `docs/testing-and-diagnostics.md`, `docs/STATUS.md`
- Predecessor: `tickets/TKT-017-benchmark-infrastructure-reliability.md`
