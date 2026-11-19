import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOverijsselCliOptions } from '../src/server/osm/overijsselConfig';
import { fetchOverijsselPbf } from './fetch-overijssel-pbf';
import { runBuildOverijsselIndex } from './build-overijssel-index';

async function main(): Promise<void> {
  const cli = parseOverijsselCliOptions();

  const fetched = await fetchOverijsselPbf({
    outPath: cli.pbfPath,
    fromLocalPath: cli.fromLocalPath,
    url: cli.url,
    expectedSha256: cli.expectedSha256,
    force: cli.force,
    skipHashCheck: cli.skipHashCheck || cli.allowCustomSnapshot,
  });

  await runBuildOverijsselIndex({
    pbfPath: fetched.pbfPath,
    outIndexPath: cli.outPath,
    snapshotId: cli.snapshotId,
    expectedSha256: cli.expectedSha256,
    allowCustomSnapshot: cli.allowCustomSnapshot,
    force: cli.force,
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    console.error('Overijssel offline dataset setup failed:', err?.message ?? err);
    process.exit(1);
  });
}

