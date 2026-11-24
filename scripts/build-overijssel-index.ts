import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCustomOverijsselSnapshotId,
  OVERIJSSEL_HISTORICAL_BENCHMARK_SHA256,
  OVERIJSSEL_PBF_EXPECTED_BYTES,
  OVERIJSSEL_PBF_EXPECTED_MD5,
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  OVERIJSSEL_SNAPSHOT_ID,
  parseOverijsselCliOptions,
  resolveOverijsselIndexPath,
  resolveOverijsselPbfPath,
} from '../src/server/osm/overijsselConfig';
import {
  buildOverijsselSpatialIndex,
  computePbfFileDigests,
  type OverijsselIndexBuildResult,
} from '../src/server/osm/OverijsselIndexBuilder';
import { OverijsselOsmStore } from '../src/server/osm/OverijsselOsmStore';
import { runBuildOverijsselSearchIndex } from './build-overijssel-search-index';

export async function runBuildOverijsselIndex(options?: {
  pbfPath?: string;
  outIndexPath?: string;
  snapshotId?: string;
  expectedSha256?: string;
  allowCustomSnapshot?: boolean;
  force?: boolean;
  skipSearchIndex?: boolean;
}): Promise<OverijsselIndexBuildResult | null> {
  const pbfPath = path.resolve(options?.pbfPath ?? resolveOverijsselPbfPath());
  const outIndexPath = path.resolve(options?.outIndexPath ?? resolveOverijsselIndexPath());

  if (!fs.existsSync(pbfPath)) {
    throw new Error(
      `OSM PBF snapshot file not found at: ${pbfPath}. Run "npm run osm:fetch-overijssel" (or "npm run osm:setup-overijssel") first.`
    );
  }

  const pbfDigests = await computePbfFileDigests(pbfPath);
  const expectedSha = (options?.expectedSha256 ?? OVERIJSSEL_PBF_EXPECTED_SHA256).toLowerCase();
  if (!options?.allowCustomSnapshot && expectedSha && pbfDigests.sha256 !== expectedSha) {
    const historicalHint =
      pbfDigests.sha256 === OVERIJSSEL_HISTORICAL_BENCHMARK_SHA256
        ? ' This digest matches the archived TKT-019/TKT-022 snapshot ("overijssel-261114"), not the verified Geofabrik snapshot.'
        : '';
    const canonicalHint =
      expectedSha === OVERIJSSEL_PBF_EXPECTED_SHA256
        ? ` (expected MD5 ${OVERIJSSEL_PBF_EXPECTED_MD5}, ${OVERIJSSEL_PBF_EXPECTED_BYTES.toLocaleString()} bytes)`
        : '';
    throw new Error(
      `Snapshot SHA-256 mismatch for "${pbfPath}" (${pbfDigests.bytes.toLocaleString()} bytes):\n` +
        `  Expected SHA-256: ${expectedSha}${canonicalHint}\n` +
        `  Actual SHA-256:   ${pbfDigests.sha256} (MD5 ${pbfDigests.md5})${historicalHint}\n` +
        `Recovery:\n` +
        `  - Replace with the verified canonical snapshot: npm run osm:setup-overijssel -- "--" --force (PowerShell) or npx tsx scripts/setup-overijssel.ts --force\n` +
        `  - Or index this custom PBF intentionally: npx tsx scripts/build-overijssel-index.ts --allow-custom-snapshot --pbf="${pbfPath}"`
    );
  }

  const matchesExpectedCanonical = Boolean(expectedSha) && pbfDigests.sha256 === expectedSha;
  const expectedSnapshotMode =
    options?.allowCustomSnapshot && !matchesExpectedCanonical ? 'custom' : 'canonical';
  const expectedSnapshotId =
    options?.snapshotId ??
    (expectedSnapshotMode === 'custom'
      ? buildCustomOverijsselSnapshotId(pbfDigests.sha256)
      : OVERIJSSEL_SNAPSHOT_ID);

  if (!options?.force && fs.existsSync(outIndexPath)) {
    try {
      const store = new OverijsselOsmStore(outIndexPath, {
        expectedSha256: pbfDigests.sha256,
        expectedSnapshotId,
        allowCustomSnapshot: options?.allowCustomSnapshot,
      });
      const meta = store.getSnapshotMetadata();
      store.close();
      if (meta.snapshotMode === expectedSnapshotMode && meta.sourceSha256 === pbfDigests.sha256) {
        console.log(
          `Existing persistent Overijssel spatial index at ${outIndexPath} is valid (` +
            `${meta.nodeCount.toLocaleString()} nodes, ${meta.wayCount.toLocaleString()} ways, ` +
            `${meta.relationCount.toLocaleString()} relations, snapshot=${meta.snapshotId}, ` +
            `sha256=${meta.sourceSha256.slice(0, 12)}...). Pass --force to rebuild.`
        );
        if (!options?.skipSearchIndex) {
          runBuildOverijsselSearchIndex({
            spatialIndexPath: outIndexPath,
            expectedSha256: pbfDigests.sha256,
            expectedSnapshotId,
            allowCustomSnapshot: options?.allowCustomSnapshot,
            force: false,
          });
        }
        return null;
      }
      console.warn(
        `Existing SQLite spatial index at ${outIndexPath} has snapshotMode="${meta.snapshotMode}" ` +
          `(expected "${expectedSnapshotMode}"); rebuilding from ${path.basename(pbfPath)}...`
      );
    } catch (err: any) {
      console.warn(
        `Existing SQLite spatial index at ${outIndexPath} is incompatible or unreadable (${
          err?.message ?? err
        }); rebuilding from ${path.basename(pbfPath)}...`
      );
    }
  }

  const result = await buildOverijsselSpatialIndex({
    pbfPath,
    outIndexPath,
    snapshotId: expectedSnapshotId,
    expectedSha256: expectedSha,
    allowCustomSnapshot: options?.allowCustomSnapshot,
  });

  console.log(
    `Spatial index ready: ${result.indexPath} (${result.nodeCount.toLocaleString()} nodes, ` +
      `${result.taggedNodeCount.toLocaleString()} tagged nodes, ` +
      `${result.wayCount.toLocaleString()} ways, ${result.relationCount.toLocaleString()} relations, ` +
      `snapshot=${result.snapshotId}, sha256=${result.pbfSha256.slice(0, 12)}...)`
  );
  if (!options?.skipSearchIndex) {
    runBuildOverijsselSearchIndex({
      spatialIndexPath: result.indexPath,
      expectedSha256: pbfDigests.sha256,
      expectedSnapshotId,
      allowCustomSnapshot: options?.allowCustomSnapshot,
      force: Boolean(options?.force),
    });
  }
  return result;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const cli = parseOverijsselCliOptions();
  runBuildOverijsselIndex({
    pbfPath: cli.pbfPath,
    outIndexPath: cli.outPath,
    snapshotId: cli.snapshotId,
    expectedSha256: cli.expectedSha256,
    allowCustomSnapshot: cli.allowCustomSnapshot,
    force: cli.force,
  }).catch((err) => {
    console.error('Error building Overijssel spatial index:', err?.message ?? err);
    process.exit(1);
  });
}

