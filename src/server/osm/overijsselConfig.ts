import path from 'node:path';

export const OVERIJSSEL_SNAPSHOT_ID = 'overijssel-261114-8ae28196';
export const OVERIJSSEL_PBF_FILENAME = 'overijssel-261114.osm.pbf';
export const OVERIJSSEL_INDEX_FILENAME = 'overijssel-261114-8ae28196.sqlite';
export const OVERIJSSEL_PBF_URL =
  'https://download.geofabrik.de/europe/netherlands/overijssel-261114.osm.pbf';
export const OVERIJSSEL_POLY_URL =
  'https://download.geofabrik.de/europe/netherlands/overijssel.poly';
export const OVERIJSSEL_PBF_EXPECTED_SHA256 =
  '8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0';
export const OVERIJSSEL_PBF_EXPECTED_MD5 = '461949c7c40f7d90b4bbb695d0933f57';
export const OVERIJSSEL_PBF_EXPECTED_BYTES = 114_506_422;
export const OVERIJSSEL_OSM_TIMESTAMP_ISO = '2026-11-14T21:20:41.000Z';
export const OVERIJSSEL_ATTRIBUTION =
  '© OpenStreetMap contributors (ODbL 1.0) via Geofabrik Overijssel extract';
export const OVERIJSSEL_INDEX_SCHEMA_VERSION = '1.0.0';

/**
 * Historical snapshot identity recorded in benchmarks/datasets/hengelo-scaling/manifest.json (TKT-019)
 * and the initial TKT-022 build. Original raw bytes are not stored in the repository; retained solely
 * for provenance distinction and diagnostic identification.
 */
export const OVERIJSSEL_HISTORICAL_BENCHMARK_SNAPSHOT_ID = 'overijssel-261114';
export const OVERIJSSEL_HISTORICAL_BENCHMARK_SHA256 =
  '53d1f2d0b6c9461b4d752610c5c348bb48d1c1ac77838e75b934bf676a980243';

export type OverijsselSnapshotMode = 'canonical' | 'custom';

export function buildCustomOverijsselSnapshotId(pbfSha256: string): string {
  return `custom-${pbfSha256.slice(0, 12)}`;
}

export function resolveOverijsselDataDir(repoRoot: string = process.cwd()): string {
  const customDir = process.env.OVERIJSSEL_DATA_DIR?.trim();
  if (customDir) {
    return path.resolve(repoRoot, customDir);
  }
  return path.resolve(repoRoot, 'data', 'osm');
}

export function resolveOverijsselPbfPath(repoRoot: string = process.cwd()): string {
  const custom = process.env.OVERIJSSEL_PBF_PATH?.trim();
  if (custom) {
    return path.resolve(repoRoot, custom);
  }
  return path.join(resolveOverijsselDataDir(repoRoot), OVERIJSSEL_PBF_FILENAME);
}

export function resolveOverijsselIndexPath(repoRoot: string = process.cwd()): string {
  const custom = process.env.OVERIJSSEL_INDEX_PATH?.trim();
  if (custom) {
    return path.resolve(repoRoot, custom);
  }
  return path.join(resolveOverijsselDataDir(repoRoot), OVERIJSSEL_INDEX_FILENAME);
}

const TRUTHY_FLAGS = new Set(['1', 'true', 'yes', 'on']);
const FALSY_FLAGS = new Set(['0', 'false', 'no', 'off']);

function isEnvFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return TRUTHY_FLAGS.has(value.trim().toLowerCase());
}

export function isOverijsselAutoBootstrapDisabled(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv
): boolean {
  if (argv.includes('--no-overijssel-bootstrap')) {
    return true;
  }
  if (isEnvFlagEnabled(env.DISABLE_OVERIJSSEL_BOOTSTRAP)) {
    return true;
  }
  const autoFlag = env.OVERIJSSEL_AUTO_BOOTSTRAP?.trim().toLowerCase();
  if (autoFlag && FALSY_FLAGS.has(autoFlag)) {
    return true;
  }
  return false;
}

export interface OverijsselCliOptions {
  pbfPath?: string;
  fromLocalPath?: string;
  outPath?: string;
  url?: string;
  snapshotId?: string;
  expectedSha256?: string;
  force: boolean;
  allowCustomSnapshot: boolean;
  skipHashCheck: boolean;
}

/**
 * Parses CLI flags and environment overrides for Overijssel fetch/build/setup scripts.
 * Also honors OVERIJSSEL_* env vars and npm_config_* fallbacks so Windows PowerShell users
 * are unaffected when PowerShell strips `--` or npm intercepts CLI options.
 */
export function parseOverijsselCliOptions(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): OverijsselCliOptions {
  let pbfPath: string | undefined;
  let fromLocalPath: string | undefined;
  let outPath: string | undefined;
  let url: string | undefined;
  let snapshotId: string | undefined;
  let expectedSha256: string | undefined;
  let force =
    isEnvFlagEnabled(env.OVERIJSSEL_FORCE) || isEnvFlagEnabled(env.npm_config_force);
  let allowCustomSnapshot =
    isEnvFlagEnabled(env.OVERIJSSEL_ALLOW_CUSTOM_SNAPSHOT) ||
    isEnvFlagEnabled(env.npm_config_allow_custom_snapshot);
  let skipHashCheck =
    isEnvFlagEnabled(env.OVERIJSSEL_SKIP_HASH_CHECK) ||
    isEnvFlagEnabled(env.npm_config_skip_hash_check);

  const readOptionValue = (index: number, prefix: string): { value: string; nextIndex: number } => {
    const arg = argv[index];
    if (arg.startsWith(`${prefix}=`)) {
      return { value: arg.slice(prefix.length + 1).trim(), nextIndex: index };
    }
    const next = argv[index + 1];
    if (typeof next === 'string' && !next.startsWith('--')) {
      return { value: next.trim(), nextIndex: index + 1 };
    }
    return { value: '', nextIndex: index };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--pbf' || arg.startsWith('--pbf=')) {
      const res = readOptionValue(i, '--pbf');
      if (res.value) pbfPath = res.value;
      i = res.nextIndex;
    } else if (arg === '--from' || arg.startsWith('--from=')) {
      const res = readOptionValue(i, '--from');
      if (res.value) fromLocalPath = res.value;
      i = res.nextIndex;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const res = readOptionValue(i, '--out');
      if (res.value) outPath = res.value;
      i = res.nextIndex;
    } else if (arg === '--url' || arg.startsWith('--url=')) {
      const res = readOptionValue(i, '--url');
      if (res.value) url = res.value;
      i = res.nextIndex;
    } else if (arg === '--snapshot-id' || arg.startsWith('--snapshot-id=')) {
      const res = readOptionValue(i, '--snapshot-id');
      if (res.value) snapshotId = res.value;
      i = res.nextIndex;
    } else if (arg === '--expected-sha256' || arg.startsWith('--expected-sha256=')) {
      const res = readOptionValue(i, '--expected-sha256');
      if (res.value) expectedSha256 = res.value.toLowerCase();
      i = res.nextIndex;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--allow-custom-snapshot') {
      allowCustomSnapshot = true;
    } else if (arg === '--skip-hash-check') {
      skipHashCheck = true;
    }
  }

  if (!snapshotId && env.OVERIJSSEL_CUSTOM_SNAPSHOT_ID?.trim()) {
    snapshotId = env.OVERIJSSEL_CUSTOM_SNAPSHOT_ID.trim();
  }
  if (!fromLocalPath && env.npm_config_from?.trim()) {
    fromLocalPath = env.npm_config_from.trim();
  }
  if (!pbfPath && env.npm_config_pbf?.trim()) {
    pbfPath = env.npm_config_pbf.trim();
  }
  if (!outPath && env.npm_config_out?.trim()) {
    outPath = env.npm_config_out.trim();
  }

  return {
    pbfPath,
    fromLocalPath,
    outPath,
    url,
    snapshotId,
    expectedSha256,
    force,
    allowCustomSnapshot,
    skipHashCheck,
  };
}


