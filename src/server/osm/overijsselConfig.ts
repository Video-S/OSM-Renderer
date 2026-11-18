import path from 'node:path';

export const OVERIJSSEL_SNAPSHOT_ID = 'overijssel-261114';
export const OVERIJSSEL_PBF_FILENAME = 'overijssel-261114.osm.pbf';
export const OVERIJSSEL_INDEX_FILENAME = 'overijssel-261114.sqlite';
export const OVERIJSSEL_PBF_URL =
  'https://download.geofabrik.de/europe/netherlands/overijssel-261114.osm.pbf';
export const OVERIJSSEL_POLY_URL =
  'https://download.geofabrik.de/europe/netherlands/overijssel.poly';
export const OVERIJSSEL_PBF_EXPECTED_SHA256 =
  '53d1f2d0b6c9461b4d752610c5c348bb48d1c1ac77838e75b934bf676a980243';
export const OVERIJSSEL_OSM_TIMESTAMP_ISO = '2026-11-14T21:20:41.000Z';
export const OVERIJSSEL_ATTRIBUTION =
  '© OpenStreetMap contributors (ODbL 1.0) via Geofabrik Overijssel extract';
export const OVERIJSSEL_INDEX_SCHEMA_VERSION = '1.0.0';

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

export function isOverijsselAutoBootstrapDisabled(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv
): boolean {
  if (argv.includes('--no-overijssel-bootstrap')) {
    return true;
  }
  const disableFlag = env.DISABLE_OVERIJSSEL_BOOTSTRAP?.trim().toLowerCase();
  if (disableFlag && TRUTHY_FLAGS.has(disableFlag)) {
    return true;
  }
  const autoFlag = env.OVERIJSSEL_AUTO_BOOTSTRAP?.trim().toLowerCase();
  if (autoFlag && FALSY_FLAGS.has(autoFlag)) {
    return true;
  }
  return false;
}

