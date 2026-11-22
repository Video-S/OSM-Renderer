---
id: TKT-027
title: Resolve Overijssel Snapshot Checksum Mismatch and Strengthen Index Provenance
type: bug
status: closed
priority: high
created: 2026-11-19
updated: 2026-11-19
---

# TKT-027: Resolve Overijssel Snapshot Checksum Mismatch and Strengthen Index Provenance

## Summary
Resolved the reproducible SHA-256 checksum failure preventing `npm run osm:setup-overijssel` from installing the Geofabrik `overijssel-261114.osm.pbf` dataset on clean machines, while preserving strict SHA-256 verification, keeping canonical vs. historical benchmark snapshot identities separate, enforcing SQLite `source_sha256` compatibility checks, and supporting Windows PowerShell-safe flag handling.

## Context & Provenance Investigation
Local Windows setup revealed a reproducible integrity-check mismatch when downloading `https://download.geofabrik.de/europe/netherlands/overijssel-261114.osm.pbf`:
- **Previously pinned value (`TKT-022`)**:
  - Snapshot ID: `overijssel-261114`
  - Expected SHA-256: `53d1f2d0b6c9461b4d752610c5c348bb48d1c1ac77838e75b934bf676a980243`
  - Expected size: `114,506,422` bytes
- **Verified live Geofabrik download (HTTP 200 after redirect to `/europe/netherlands/overijssel/`)**:
  - Size: `114,506,422` bytes
  - Geofabrik-published & locally computed MD5: `461949c7c40f7d90b4bbb695d0933f57`
  - Locally computed SHA-256 (independently repeated): `8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0`

### Findings
1. **Not a manual typo in config**: Inspection of `benchmarks/datasets/hengelo-scaling/manifest.json`, `benchmarks/results/tkt019-hengelo-scaling.json`, `benchmarks/prepareHengeloScalingDatasets.ts`, and `tickets/TKT-022-persistent-offline-osm-overijssel.md` shows `53d1f2d0...` was programmatically hashed from `/tmp/overijssel-261114.osm.pbf` on `2026-11-15` (TKT-019) and `2026-11-16` (TKT-022).
2. **Original `53d1f2d0...` bytes unavailable (unresolved equivalence)**: The raw `.osm.pbf` file hashed under `TKT-019`/`TKT-022` is not stored in the repository and is no longer returned by Geofabrik. Because matching filename (`overijssel-261114.osm.pbf`) and identical byte length (`114,506,422` bytes) do **not** prove identical bytes or identical OSM contents (compressed PBF stream differences vs. underlying OSM changes cannot be ruled out without the original file), both snapshots must retain distinct identities.
3. **Additional workflow defects uncovered during audit**:
   - `scripts/build-overijssel-index.ts` skipped rebuilding whenever `--allow-custom-snapshot` was passed, even when the underlying PBF changed.
   - `OverijsselOsmStore.ts` never checked `source_sha256` against the configured canonical digest, allowing stale/legacy SQLite files to be served silently.
   - `server.ts` (`ensureOverijsselReady`) treated any existing file at `indexPath` as valid without validating store compatibility.
   - Windows PowerShell consumes unquoted `--` in `npm run osm:setup-overijssel -- --allow-custom-snapshot`, causing `npm` to intercept `--allow-custom-snapshot` instead of forwarding it to `process.argv`.

## Observed behavior
- Running `npm run osm:setup-overijssel` fails SHA-256 verification after downloading the legitimate Geofabrik `overijssel-261114.osm.pbf` file (`8ae28196...` vs. pinned `53d1f2d0...`).
- Passing `--allow-custom-snapshot` via `npm run osm:setup-overijssel -- --allow-custom-snapshot` in Windows PowerShell fails/drops flags because PowerShell strips bare `--`.
- Existing SQLite databases built from incompatible PBFs could be reused silently.

## Expected behavior
- `npm run osm:setup-overijssel` succeeds cleanly against the verified Geofabrik download (`8ae28196...` / MD5 `461949c7c40f7d90b4bbb695d0933f57`) under a distinct canonical snapshot identity (`overijssel-261114-8ae28196` / `data/osm/overijssel-261114-8ae28196.sqlite`).
- Strict SHA-256 verification remains enforced (corrupted/mismatched downloads are discarded and rejected with expected/actual SHA-256, MD5, file path, and PowerShell-safe recovery steps).
- Historical benchmark provenance (`benchmarks/datasets/hengelo-scaling/manifest.json` -> `overijssel-261114` / `53d1f2d0...`) stays intact.
- Custom PBF snapshots (`--allow-custom-snapshot`) receive a distinct `custom-<12hex>` snapshot ID, write actual `source_sha256` / `source_md5` / `source_bytes` metadata, and force SQLite rebuilds whenever the source PBF hash changes.
- `OverijsselOsmStore` and `server.ts` detect and reject incompatible canonical/legacy SQLite indexes (`OverijsselIndexIncompatibleError`, HTTP `503` without Overpass fallback).

## Acceptance criteria
- [x] Canonical Overijssel configuration updated to verified Geofabrik `overijssel-261114.osm.pbf` (`SHA-256: 8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0`, `MD5: 461949c7c40f7d90b4bbb695d0933f57`, `114,506,422` bytes) with distinct canonical identity `overijssel-261114-8ae28196` and index filename `overijssel-261114-8ae28196.sqlite`.
- [x] Historical `benchmarks/datasets/hengelo-scaling/manifest.json` (`53d1f2d0...`) and archived `TKT-019`/`TKT-022` records preserved untouched.
- [x] Strict SHA-256 verification enforced on both download and index build (mismatched downloads discarded; actionable error output includes expected vs. actual SHA-256, MD5, byte count, affected path, and recovery commands).
- [x] SQLite `metadata` records `snapshot_mode` (`'canonical' | 'custom'`), distinct `snapshot_id`, `source_sha256`, `source_md5`, and `source_bytes`; `build-overijssel-index.ts`, `OverijsselOsmStore.ts`, and `server.ts` prevent reusing incompatible SQLite indexes.
- [x] Custom snapshot workflow and Windows PowerShell invocations (`npx tsx scripts/setup-overijssel.ts ...`, `OVERIJSSEL_*` env vars, quoted `"--"`, and `npm_config_*` fallbacks) work and are documented in `docs/architecture/offline-overijssel-osm-dataset.md`.
- [x] Focused synthetic-fixture verification (`OverijsselOfflineStore.test.ts` + `npm run lint`) passes without downloading/indexing the full Overijssel dataset inside AI Studio; `TKT-026` remains untouched (`in_progress` pending owner visual approval).

## Implementation notes
- **`src/server/osm/overijsselConfig.ts`**: Defined `OVERIJSSEL_SNAPSHOT_ID = 'overijssel-261114-8ae28196'`, `OVERIJSSEL_INDEX_FILENAME = 'overijssel-261114-8ae28196.sqlite'`, `OVERIJSSEL_PBF_EXPECTED_SHA256 = '8ae28196...'`, `OVERIJSSEL_PBF_EXPECTED_MD5 = '461949c7c40f7d90b4bbb695d0933f57'`, preserved `OVERIJSSEL_HISTORICAL_BENCHMARK_*` constants, added `buildCustomOverijsselSnapshotId`, and added `parseOverijsselCliOptions` (supporting `=`, space-separated args, `OVERIJSSEL_*` env vars, and `npm_config_*` PowerShell fallbacks).
- **`src/server/osm/OverijsselIndexBuilder.ts`**: Added single-pass `computePbfFileDigests` (SHA-256, MD5, bytes), detailed mismatch diagnostics, and `snapshot_mode` / `source_sha256` / `source_md5` / `source_bytes` SQLite metadata persistence.
- **`src/server/osm/OverijsselOsmStore.ts`**: Added `OverijsselIndexIncompatibleError` (extending `OverijsselIndexMissingError` so `/api/osm-data` serves HTTP `503` without Overpass fallback), enforced required metadata keys, and rejected non-custom or legacy indexes whose `source_sha256` differs from `OVERIJSSEL_PBF_EXPECTED_SHA256` (or explicit `expectedSha256` / `expectedSnapshotId`).
- **`scripts/fetch-overijssel-pbf.ts`**, **`scripts/build-overijssel-index.ts`**, **`scripts/setup-overijssel.ts`**, **`server.ts`**: Wired shared digest verification, detailed mismatch reporting, cache-invalidation on PBF/mode/ID mismatch (even when `allowCustomSnapshot` is enabled), and store compatibility check inside `ensureOverijsselReady`.

## Verification
- **Focused synthetic-fixture tests** (`DISABLE_OVERIJSSEL_BOOTSTRAP=1 npx tsx --test src/world/OverijsselOfflineStore.test.ts`, `2026-11-19`): **8 / 8 passed**, **0 failed**, **1 skipped** (optional on-disk full Overijssel `.sqlite` test skipped since dataset is not present in AI Studio). Duration: `1.85 s`.
- **TypeScript typecheck** (`npm run lint`, `tsc --noEmit`, `2026-11-19`): **Passed** (exit code `0`).
- **Owner follow-up on local Windows**: Run `npm run osm:setup-overijssel` on the local Windows workstation to download and index `overijssel-261114.osm.pbf` (`8ae28196...`) into `data/osm/overijssel-261114-8ae28196.sqlite`.

## Related files and documentation
- Source: `src/server/osm/overijsselConfig.ts`, `src/server/osm/OverijsselIndexBuilder.ts`, `src/server/osm/OverijsselOsmStore.ts`, `server.ts`, `.env.example`
- Scripts: `scripts/fetch-overijssel-pbf.ts`, `scripts/build-overijssel-index.ts`, `scripts/setup-overijssel.ts`
- Tests: `src/world/OverijsselOfflineStore.test.ts`
- Documentation: `docs/architecture/offline-overijssel-osm-dataset.md`, `docs/STATUS.md`, `benchmarks/datasets/hengelo-scaling/manifest.json`
