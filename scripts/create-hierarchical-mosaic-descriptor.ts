import fs from 'node:fs';
import path from 'node:path';
import {
  HIERARCHICAL_MOSAIC_SCHEMA_TYPE,
  HIERARCHICAL_MOSAIC_SCHEMA_VERSION,
  validateAndComposeHierarchicalManifest,
  type HierarchicalLevelCompositionInput,
  type HierarchicalRegionalMosaicDescriptor,
} from '../src/world/tiling/HierarchicalMosaicContract';
import {
  composeRegionalMosaicManifest,
  createRegionalMosaicPlan,
  type RegionalMosaicIndex,
} from '../src/world/tiling/RegionalMosaicPlan';
import { TilePackSqliteStore } from '../src/server/tiles/TilePackSqliteStore';

export interface CreateHierarchicalDescriptorOptions {
  name: string;
  outPath: string;
  levelIndexPaths: readonly string[];
  allowCustomSnapshot?: boolean;
}

/**
 * Generates and validates a lightweight hierarchical regional mosaic descriptor JSON
 * referencing existing single-resolution `mosaic.json` manifests without copying or
 * rewriting any baked SQLite tile payloads.
 */
export function buildAndWriteHierarchicalDescriptor(
  options: CreateHierarchicalDescriptorOptions
): {
  descriptorPath: string;
  descriptor: HierarchicalRegionalMosaicDescriptor;
  resolutionsMeters: number[];
  canonicalOrigin: { easting: number; northing: number };
} {
  const outPath = path.resolve(options.outPath);
  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });

  if (options.levelIndexPaths.length < 2) {
    throw new Error('At least 2 constituent mosaic.json paths are required.');
  }

  const levelDescriptors: HierarchicalRegionalMosaicDescriptor['levels'] = [];
  const levelInputs: HierarchicalLevelCompositionInput[] = [];
  let baselineSnapshotId: string | null = null;
  let baselineSourceSha256: string | null = null;
  let baselineProjectionId: string | null = null;

  for (const rawPath of options.levelIndexPaths) {
    const absPath = path.resolve(rawPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Constituent mosaic index not found: ${absPath}`);
    }
    const relPath = path.relative(outDir, absPath).split(path.sep).join('/');
    if (!relPath || path.isAbsolute(relPath) || relPath.startsWith('..')) {
      throw new Error(
        `Constituent mosaic "${absPath}" must live inside the descriptor directory "${outDir}" (place the descriptor in a shared parent directory such as data/osm/twente-full-hierarchical.json).`
      );
    }

    const index = JSON.parse(
      fs.readFileSync(absPath, 'utf-8')
    ) as RegionalMosaicIndex;
    const plan = createRegionalMosaicPlan(index.config);
    const indexDir = path.dirname(absPath);
    let totalDbSizeBytes = 0;

    const shardInputs = index.shards.map((entry) => {
      const shardPath = path.resolve(indexDir, entry.file);
      const store = new TilePackSqliteStore(shardPath, {
        expectedSnapshotId: index.snapshotId,
        expectedSourceSha256: index.sourceSha256,
        allowCustomSnapshot: options.allowCustomSnapshot,
      });
      try {
        totalDbSizeBytes += store.getFileSizeBytes();
        return {
          id: entry.id,
          metadata: store.getMetadata(),
          tiles: store.listManifestEntries(0),
        };
      } finally {
        store.close();
      }
    });

    const composed = composeRegionalMosaicManifest(plan, shardInputs);
    baselineSnapshotId ??= index.snapshotId;
    baselineSourceSha256 ??= index.sourceSha256;
    baselineProjectionId ??= composed.metadata.projectionId;

    const levelDesc = {
      tileSizeMeters: composed.metadata.tileSizeMeters,
      indexPath: relPath,
      label: `${composed.metadata.tileSizeMeters.toLocaleString('en-US')} m`,
    };
    levelDescriptors.push(levelDesc);
    levelInputs.push({
      descriptor: levelDesc,
      resolvedIndexPath: absPath,
      dbSizeBytes: totalDbSizeBytes,
      metadata: composed.metadata,
      tiles: composed.tiles,
      consolidation: index.consolidation ?? null,
    });
  }

  levelDescriptors.sort((a, b) => a.tileSizeMeters - b.tileSizeMeters);

  const descriptor: HierarchicalRegionalMosaicDescriptor = {
    schemaType: HIERARCHICAL_MOSAIC_SCHEMA_TYPE,
    schemaVersion: HIERARCHICAL_MOSAIC_SCHEMA_VERSION,
    name: options.name,
    snapshotId: baselineSnapshotId!,
    sourceSha256: baselineSourceSha256!,
    projectionId: baselineProjectionId!,
    levels: levelDescriptors,
  };

  // Validate full cross-resolution compatibility before writing to disk
  const validated = validateAndComposeHierarchicalManifest(
    descriptor,
    outPath,
    levelInputs
  );

  descriptor.canonicalOrigin = {
    easting: validated.hierarchy.canonicalOriginEasting,
    northing: validated.hierarchy.canonicalOriginNorthing,
  };

  fs.writeFileSync(outPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf-8');
  return {
    descriptorPath: outPath,
    descriptor,
    resolutionsMeters: validated.hierarchy.resolutionsMeters,
    canonicalOrigin: descriptor.canonicalOrigin,
  };
}

function parseCliArgs(argv: string[]): {
  name: string;
  outPath: string;
  levelIndexPaths: string[];
  allowCustomSnapshot: boolean;
} {
  let name = 'twente-full-hierarchical';
  let outPath = 'data/osm/twente-full-hierarchical.json';
  const levelIndexPaths: string[] = [];
  let allowCustomSnapshot = false;

  for (const arg of argv) {
    if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length).trim();
    } else if (arg.startsWith('--out=')) {
      outPath = arg.slice('--out='.length).trim();
    } else if (
      arg.startsWith('--index-1024=') ||
      arg.startsWith('--index-2048=') ||
      arg.startsWith('--index-4096=') ||
      arg.startsWith('--index=')
    ) {
      const val = arg.slice(arg.indexOf('=') + 1).trim();
      if (val) levelIndexPaths.push(val);
    } else if (arg === '--allow-custom-snapshot') {
      allowCustomSnapshot = true;
    }
  }

  return { name, outPath, levelIndexPaths, allowCustomSnapshot };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(new URL(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.levelIndexPaths.length < 2) {
    console.error(
      'Usage: npx tsx scripts/create-hierarchical-mosaic-descriptor.ts ' +
        '--index-1024=<path> --index-2048=<path> --index-4096=<path> ' +
        '--out=data/osm/twente-full-hierarchical.json [--name=twente-full-hierarchical]'
    );
    process.exit(1);
  }
  const result = buildAndWriteHierarchicalDescriptor(parsed);
  console.log(
    `[create-hierarchical-mosaic-descriptor] Validated and wrote ${result.descriptorPath}`
  );
  console.log(
    `  Resolutions: ${result.resolutionsMeters.join(' m, ')} m | Canonical UTM origin: E ${result.canonicalOrigin.easting}, N ${result.canonicalOrigin.northing}`
  );
}
