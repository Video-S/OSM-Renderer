import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  resolveOverijsselIndexPath,
  resolveOverijsselPbfPath,
} from '../src/server/osm/overijsselConfig';
import { buildOverijsselSpatialIndex } from '../src/server/osm/OverijsselIndexBuilder';
import { OverijsselOsmStore } from '../src/server/osm/OverijsselOsmStore';

export async function runBuildOverijsselIndex(options?: {
  pbfPath?: string;
  outIndexPath?: string;
  allowCustomSnapshot?: boolean;
  force?: boolean;
}): Promise<void> {
  const pbfPath = path.resolve(options?.pbfPath ?? resolveOverijsselPbfPath());
  const outIndexPath = path.resolve(options?.outIndexPath ?? resolveOverijsselIndexPath());

  if (!options?.force && fs.existsSync(outIndexPath)) {
    try {
      const store = new OverijsselOsmStore(outIndexPath);
      const meta = store.getSnapshotMetadata();
      store.close();
      if (options?.allowCustomSnapshot || meta.sourceSha256 === OVERIJSSEL_PBF_EXPECTED_SHA256) {
        console.log(
          `Existing persistent Overijssel spatial index at ${outIndexPath} is valid (` +
            `${meta.nodeCount.toLocaleString()} nodes, ${meta.wayCount.toLocaleString()} ways, ` +
            `${meta.relationCount.toLocaleString()} relations, snapshot=${meta.snapshotId}). Pass --force to rebuild.`
        );
        return;
      }
    } catch {
      // Rebuild if existing index is invalid or unreadable
    }
  }

  const result = await buildOverijsselSpatialIndex({
    pbfPath,
    outIndexPath,
    allowCustomSnapshot: options?.allowCustomSnapshot,
  });

  console.log(
    `Spatial index ready: ${result.indexPath} (${result.nodeCount.toLocaleString()} nodes, ` +
      `${result.taggedNodeCount.toLocaleString()} tagged nodes, ` +
      `${result.wayCount.toLocaleString()} ways, ${result.relationCount.toLocaleString()} relations)`
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  let pbfPath: string | undefined;
  let outIndexPath: string | undefined;
  let allowCustomSnapshot = false;
  let force = false;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--pbf=')) pbfPath = arg.slice('--pbf='.length).trim();
    else if (arg.startsWith('--out=')) outIndexPath = arg.slice('--out='.length).trim();
    else if (arg === '--allow-custom-snapshot') allowCustomSnapshot = true;
    else if (arg === '--force') force = true;
  }

  runBuildOverijsselIndex({ pbfPath, outIndexPath, allowCustomSnapshot, force }).catch((err) => {
    console.error('Error building Overijssel spatial index:', err?.message ?? err);
    process.exit(1);
  });
}
