import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseOverijsselCliOptions,
  resolveOverijsselIndexPath,
  resolveOverijsselSearchIndexPath,
} from '../src/server/osm/overijsselConfig';
import {
  buildOverijsselSearchIndex,
  OverijsselSearchStore,
  type BuildOverijsselSearchIndexResult,
} from '../src/server/osm/OverijsselSearchIndex';

export function runBuildOverijsselSearchIndex(options?: {
  spatialIndexPath?: string;
  outSearchIndexPath?: string;
  expectedSha256?: string;
  expectedSnapshotId?: string;
  allowCustomSnapshot?: boolean;
  force?: boolean;
}): BuildOverijsselSearchIndexResult | null {
  const spatialIndexPath = path.resolve(
    options?.spatialIndexPath ?? resolveOverijsselIndexPath()
  );
  const outSearchIndexPath = path.resolve(
    options?.outSearchIndexPath ?? resolveOverijsselSearchIndexPath(spatialIndexPath)
  );

  if (!fs.existsSync(spatialIndexPath)) {
    throw new Error(
      `Overijssel SQLite spatial index not found at "${spatialIndexPath}". Run "npm run osm:setup-overijssel" first.`
    );
  }

  if (!options?.force && fs.existsSync(outSearchIndexPath)) {
    try {
      const store = new OverijsselSearchStore(outSearchIndexPath, spatialIndexPath, {
        expectedSha256: options?.expectedSha256,
        expectedSnapshotId: options?.expectedSnapshotId,
        allowCustomSnapshot: options?.allowCustomSnapshot,
      });
      const meta = store.getMetadata();
      store.close();
      console.log(
        `Existing Overijssel search index at ${outSearchIndexPath} is valid (` +
          `${meta.entryCount.toLocaleString()} entries, snapshot=${meta.snapshotId}, ` +
          `sha256=${meta.sourceSha256.slice(0, 12)}...). Pass --force to rebuild.`
      );
      return null;
    } catch (err: any) {
      console.warn(
        `Existing Overijssel search index at ${outSearchIndexPath} is incompatible or unreadable (${
          err?.message ?? err
        }); rebuilding...`
      );
    }
  }

  return buildOverijsselSearchIndex({
    spatialIndexPath,
    outSearchIndexPath,
    expectedSha256: options?.expectedSha256,
    expectedSnapshotId: options?.expectedSnapshotId,
    allowCustomSnapshot: options?.allowCustomSnapshot,
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

function readSpatialIndexArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--index=')) return arg.slice('--index='.length).trim();
    if (arg.startsWith('--spatial-index=')) {
      return arg.slice('--spatial-index='.length).trim();
    }
    if ((arg === '--index' || arg === '--spatial-index') && argv[i + 1]) {
      return argv[i + 1].trim();
    }
  }
  return undefined;
}

if (isMain) {
  const cli = parseOverijsselCliOptions();
  const spatialIndexPath = readSpatialIndexArg(process.argv.slice(2));
  try {
    runBuildOverijsselSearchIndex({
      spatialIndexPath,
      outSearchIndexPath: cli.outPath,
      expectedSha256: cli.expectedSha256,
      expectedSnapshotId: cli.snapshotId,
      allowCustomSnapshot: cli.allowCustomSnapshot,
      force: cli.force,
    });
  } catch (err: any) {
    console.error(
      'Error building Overijssel search index:',
      err?.message ?? err
    );
    process.exit(1);
  }
}
