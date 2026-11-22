import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import {
  CANONICAL_HENGELO_SNAPSHOT_ID,
  CANONICAL_HENGELO_SOURCE_SHA256,
} from '../../world/tiling/TilePackContract';
import {
  composeRegionalMosaicManifest,
  createRegionalMosaicPlan,
  type RegionalMosaicIndex,
} from '../../world/tiling/RegionalMosaicPlan';
import {
  createTilePackHttpHandler,
  type TilePackHttpController,
  type TilePackManifestHttpResponse,
} from './tilePackHttpHandler';

/**
 * The TKT-033 candidate is the owner-accepted Twente pilot for visual regression
 * checks. The original mosaic is preserved and remains selectable explicitly.
 */
export const DEFAULT_REGIONAL_MOSAIC_RELATIVE_PATH =
  'data/osm/twente-pilot-1024m-tkt033-candidate/mosaic.json';

/** Resolve the active regional index, retaining the explicit environment override. */
export function resolveRegionalMosaicIndexPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.resolve(
    env.OVERIJSSEL_REGIONAL_MOSAIC_PATH?.trim() ||
      DEFAULT_REGIONAL_MOSAIC_RELATIVE_PATH
  );
}

/**
 * Exposes one contiguous tile manifest over independently baked regional packs.
 * The original source-pack payloads remain immutable. Its tile-center offset in
 * the binary header is shard-local; the merged manifest supplies regional center
 * offsets, which TileStreamManager applies immediately before reconstruction.
 */
export function createRegionalMosaicHttpHandler(options: {
  indexPath: string;
}): {
  manifestHandler: (req: Request, res: Response) => Promise<void>;
  tilePayloadHandler: (req: Request, res: Response) => Promise<void>;
  close: () => void;
} {
  const indexPath = path.resolve(options.indexPath);
  let cached: {
    manifest: TilePackManifestHttpResponse;
    ownerByTileKey: Map<string, string>;
    controllers: Map<string, TilePackHttpController>;
  } | null = null;

  const close = (): void => {
    if (!cached) return;
    for (const controller of cached.controllers.values()) controller.close();
    cached = null;
  };

  const load = (): NonNullable<typeof cached> => {
    if (cached) return cached;
    if (!fs.existsSync(indexPath)) {
      throw new Error(`Regional mosaic index not found: ${indexPath}. Run npm run osm:bake-regional-pilot first.`);
    }
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as RegionalMosaicIndex;
    if (
      index.schemaVersion !== 1 ||
      index.snapshotId !== CANONICAL_HENGELO_SNAPSHOT_ID ||
      index.sourceSha256.toLowerCase() !== CANONICAL_HENGELO_SOURCE_SHA256
    ) {
      throw new Error('Regional mosaic index version or canonical OSM source snapshot mismatch');
    }
    const plan = createRegionalMosaicPlan(index.config);
    const controllers = new Map<string, TilePackHttpController>();
    try {
      const inputs = index.shards.map((entry) => {
        if (!entry.id || !entry.file || path.isAbsolute(entry.file) ||
            !/^[a-zA-Z0-9._/-]+$/.test(entry.file) || entry.file.split(/[\\/]/).includes('..')) {
          throw new Error(`Unsafe regional mosaic shard file path: ${entry.file}`);
        }
        const filepath = path.resolve(path.dirname(indexPath), entry.file);
        const controller = createTilePackHttpHandler({
          packPath: filepath,
          expectedSnapshotId: index.snapshotId,
          expectedSourceSha256: index.sourceSha256,
        });
        if (controllers.has(entry.id)) {
          controller.close();
          throw new Error(`Duplicate regional shard id ${entry.id}`);
        }
        controllers.set(entry.id, controller);
        const store = controller.getStore();
        return {
          id: entry.id,
          metadata: store.getMetadata(),
          tiles: store.listManifestEntries(0),
        };
      });
      const composed = composeRegionalMosaicManifest(plan, inputs);
      const manifest: TilePackManifestHttpResponse = {
        available: true,
        packPath: indexPath,
        dbSizeBytes: Array.from(controllers.values()).reduce(
          (sum, controller) => sum + controller.getStore().getFileSizeBytes(), 0
        ),
        metadata: composed.metadata,
        tiles: composed.tiles,
      };
      cached = {
        manifest,
        ownerByTileKey: composed.ownerByTileKey,
        controllers,
      };
      return cached;
    } catch (err) {
      for (const controller of controllers.values()) controller.close();
      throw err;
    }
  };

  const sendFailure = (res: Response, err: unknown): void => {
    close();
    res.status(503).json({
      available: false,
      code: 'REGIONAL_MOSAIC_UNAVAILABLE',
      error: err instanceof Error ? err.message : String(err),
    });
  };

  const manifestHandler = async (_req: Request, res: Response): Promise<void> => {
    try {
      const { manifest } = load();
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-OSM-Snapshot-Id', manifest.metadata.snapshotId);
      res.setHeader('X-Tile-Bake-Schema', manifest.metadata.bakeSchemaVersion);
      res.status(200).json(manifest);
    } catch (err) {
      sendFailure(res, err);
    }
  };

  const tilePayloadHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const { ownerByTileKey, controllers } = load();
      const parts = [req.params.lod, req.params.tx, req.params.ty].map(String);
      if (parts.some((part) => !/^-?\d+$/.test(part))) {
        res.status(400).json({ error: 'Invalid tile coordinates', code: 'TILE_INVALID_COORDINATES' });
        return;
      }
      const [lod, tx, ty] = parts.map(Number);
      if (lod !== 0 || !Number.isSafeInteger(tx) || !Number.isSafeInteger(ty)) {
        res.status(400).json({ error: 'Invalid LOD/tile coordinates', code: 'TILE_INVALID_COORDINATES' });
        return;
      }
      const shardId = ownerByTileKey.get(`${lod}:${tx}:${ty}`);
      if (!shardId) {
        res.status(404).json({ error: 'Regional mosaic tile not found', code: 'TILE_NOT_FOUND' });
        return;
      }
      const shardController = controllers.get(shardId);
      if (!shardController) throw new Error(`Missing regional mosaic shard controller ${shardId}`);
      await shardController.tilePayloadHandler(req, res);
    } catch (err) {
      sendFailure(res, err);
    }
  };

  return { manifestHandler, tilePayloadHandler, close };
}
