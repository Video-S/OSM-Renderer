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
import { TilePackSqliteStore } from './TilePackSqliteStore';

/**
 * The TKT-033 candidate is the owner-accepted Twente pilot for visual regression
 * checks. The original mosaic is preserved and remains selectable explicitly.
 */
export const DEFAULT_REGIONAL_MOSAIC_RELATIVE_PATH =
  'data/osm/twente-pilot-1024m-tkt033-candidate/mosaic.json';

/**
 * Upper bound on concurrently open per-shard SQLite read handles for a regional
 * mosaic. Interactive LOD0 streaming at regionalMinZoom >= 0.15 typically touches
 * 1–4 shards at once, so 16 handles provide high locality while preventing file-
 * descriptor exhaustion and excess SQLite page-cache memory on 120+ shard mosaics.
 */
export const DEFAULT_MAX_OPEN_SHARD_HANDLES = 16;

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
 *
 * Scale safety (TKT-034):
 * - Manifest loading opens each shard sequentially, extracts metadata/entries,
 *   and closes the SQLite handle immediately so startup does not hold 120+ open
 *   file descriptors.
 * - Tile payload serving uses a bounded LRU pool of shard controllers capped at
 *   `maxOpenShardHandles` (default 16).
 */
export function createRegionalMosaicHttpHandler(options: {
  indexPath: string;
  maxOpenShardHandles?: number;
}): {
  manifestHandler: (req: Request, res: Response) => Promise<void>;
  tilePayloadHandler: (req: Request, res: Response) => Promise<void>;
  getOpenShardHandleCount: () => number;
  close: () => void;
} {
  const indexPath = path.resolve(options.indexPath);
  const maxOpenShardHandles =
    typeof options.maxOpenShardHandles === 'number' &&
    Number.isSafeInteger(options.maxOpenShardHandles) &&
    options.maxOpenShardHandles >= 1
      ? options.maxOpenShardHandles
      : DEFAULT_MAX_OPEN_SHARD_HANDLES;

  let cached: {
    manifest: TilePackManifestHttpResponse;
    ownerByTileKey: Map<string, string>;
    shardPathById: Map<string, string>;
    snapshotId: string;
    sourceSha256: string;
    openControllers: Map<string, TilePackHttpController>;
  } | null = null;

  const close = (): void => {
    if (!cached) return;
    for (const controller of cached.openControllers.values()) {
      controller.close();
    }
    cached.openControllers.clear();
    cached = null;
  };

  const getOpenShardHandleCount = (): number => {
    return cached ? cached.openControllers.size : 0;
  };

  const acquireShardController = (
    state: NonNullable<typeof cached>,
    shardId: string
  ): TilePackHttpController => {
    const existing = state.openControllers.get(shardId);
    if (existing) {
      // Refresh LRU recency
      state.openControllers.delete(shardId);
      state.openControllers.set(shardId, existing);
      return existing;
    }

    const filepath = state.shardPathById.get(shardId);
    if (!filepath) {
      throw new Error(`Missing regional mosaic shard path ${shardId}`);
    }

    while (state.openControllers.size >= maxOpenShardHandles) {
      const oldestKey = state.openControllers.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestController = state.openControllers.get(oldestKey);
      state.openControllers.delete(oldestKey);
      oldestController?.close();
    }

    const controller = createTilePackHttpHandler({
      packPath: filepath,
      expectedSnapshotId: state.snapshotId,
      expectedSourceSha256: state.sourceSha256,
    });
    state.openControllers.set(shardId, controller);
    return controller;
  };

  const load = (): NonNullable<typeof cached> => {
    if (cached) return cached;
    if (!fs.existsSync(indexPath)) {
      throw new Error(
        `Regional mosaic index not found: ${indexPath}. Run npm run osm:bake-regional-pilot first.`
      );
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
    const shardPathById = new Map<string, string>();
    let totalDbSizeBytes = 0;

    // Scan each shard sequentially and close immediately so 120-shard manifests
    // never leave 120 open SQLite file handles pinned in memory.
    const inputs = index.shards.map((entry) => {
      if (
        !entry.id ||
        !entry.file ||
        path.isAbsolute(entry.file) ||
        !/^[a-zA-Z0-9._/-]+$/.test(entry.file) ||
        entry.file.split(/[\\/]/).includes('..')
      ) {
        throw new Error(`Unsafe regional mosaic shard file path: ${entry.file}`);
      }
      if (shardPathById.has(entry.id)) {
        throw new Error(`Duplicate regional shard id ${entry.id}`);
      }
      const filepath = path.resolve(path.dirname(indexPath), entry.file);
      shardPathById.set(entry.id, filepath);

      const store = new TilePackSqliteStore(filepath, {
        expectedSnapshotId: index.snapshotId,
        expectedSourceSha256: index.sourceSha256,
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

    const composed = composeRegionalMosaicManifest(plan, inputs);
    const manifest: TilePackManifestHttpResponse = {
      available: true,
      packPath: indexPath,
      dbSizeBytes: totalDbSizeBytes,
      metadata: composed.metadata,
      tiles: composed.tiles,
    };
    cached = {
      manifest,
      ownerByTileKey: composed.ownerByTileKey,
      shardPathById,
      snapshotId: index.snapshotId,
      sourceSha256: index.sourceSha256,
      openControllers: new Map(),
    };
    return cached;
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
      const state = load();
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
      const shardId = state.ownerByTileKey.get(`${lod}:${tx}:${ty}`);
      if (!shardId) {
        res.status(404).json({ error: 'Regional mosaic tile not found', code: 'TILE_NOT_FOUND' });
        return;
      }
      const shardController = acquireShardController(state, shardId);
      await shardController.tilePayloadHandler(req, res);
    } catch (err) {
      sendFailure(res, err);
    }
  };

  return { manifestHandler, tilePayloadHandler, getOpenShardHandleCount, close };
}
