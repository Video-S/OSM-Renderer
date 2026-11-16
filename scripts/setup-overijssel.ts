import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchOverijsselPbf } from './fetch-overijssel-pbf';
import { runBuildOverijsselIndex } from './build-overijssel-index';

async function main(): Promise<void> {
  let pbfPath: string | undefined;
  let fromLocalPath: string | undefined;
  let outIndexPath: string | undefined;
  let force = false;
  let allowCustomSnapshot = false;

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--pbf=')) pbfPath = arg.slice('--pbf='.length).trim();
    else if (arg.startsWith('--from=')) fromLocalPath = arg.slice('--from='.length).trim();
    else if (arg.startsWith('--out=')) outIndexPath = arg.slice('--out='.length).trim();
    else if (arg === '--force') force = true;
    else if (arg === '--allow-custom-snapshot') allowCustomSnapshot = true;
  }

  const fetched = await fetchOverijsselPbf({
    outPath: pbfPath,
    fromLocalPath,
    force,
    skipHashCheck: allowCustomSnapshot,
  });

  await runBuildOverijsselIndex({
    pbfPath: fetched.pbfPath,
    outIndexPath,
    allowCustomSnapshot,
    force,
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
