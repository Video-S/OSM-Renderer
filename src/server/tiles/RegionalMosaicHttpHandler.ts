import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import {
  CANONICAL_HENGELO_SNAPSHOT_ID,
  CANONICAL_HENGELO_SOURCE_SHA256,
  type TileManifestEntry,
  type TilePackMetadata,
} from '../../world/tiling/TilePackContract';
import {
  composeRegionalMosaicManifest,
  createRegionalMosaicPlan,
  type RegionalMosaicConsolidationMetadata,
  type RegionalMosaicIndex,
} from '../../world/tiling/RegionalMosaicPlan';
import {
  formatHierarchicalRouteOwnerKey,
  formatHierarchicalTileKey,
  HierarchicalMosaicCompatibilityError,
  isHierarchicalRegionalMosaicDescriptor,
  validateAndComposeHierarchicalManifest,
  type HierarchicalLevelCompositionInput,
  type HierarchicalRegionalMosaicDescriptor,
} from '../../world/tiling/HierarchicalMosaicContract';
import {
  createTilePackHttpHandler,
  type TilePackHttpController,
  type TilePackManifestHttpResponse,
} from './tilePackHttpHandler';
import { TilePackSqliteStore } from './TilePackSqliteStore';
import { deriveActiveMosaicNameFromPackPath } from '../../world/tiling/ActiveMosaicIdentity';
import type { ActiveMosaicCoverageContext } from '../osm/OverijsselSearchIndex';

/**
 * The TKT-033 candidate is the owner-accepted Twente pilot for visual regression
 * checks. The original mosaic is preserved and remains selectable explicitly.
 */
export const DEFAULT_REGIONAL_MOSAIC_RELATIVE_PATH =
  'data/osm/twente-pilot-1024m-tkt033-candidate/mosaic.json';

/**
 * Upper bound on concurrently open per-shard SQLite read handles for a regional
 * or hierarchical mosaic. Interactive LOD0 streaming typically touches 1–4 shards
 * at once (up to ~6–8 during a resolution transition), so 16 handles provide high
 * locality across resolutions while preventing file-descriptor exhaustion and
 * excess SQLite page-cache memory on 120+ shard mosaics.
 */
export const DEFAULT_MAX_OPEN_SHARD_HANDLES = 16;

/**
 * Resolve the active regional index (single-resolution `mosaic.json` or
 * multi-resolution `hierarchical-regional-mosaic` descriptor JSON), retaining
 * explicit environment overrides.
 */
export function resolveRegionalMosaicIndexPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.resolve(
    env.OVERIJSSEL_HIERARCHICAL_MOSAIC_PATH?.trim() ||
      env.OVERIJSSEL_REGIONAL_MOSAIC_PATH?.trim() ||
      DEFAULT_REGIONAL_MOSAIC_RELATIVE_PATH
  );
}

/**
 * Normalizes a relative descriptor/shard path and verifies strict confinement
 * inside `baseDir` (rejecting absolute paths, `..` traversal, unsafe characters,
 * or escapes outside `baseDir + path.sep`).
 */
function resolveSafeRelativeFile(
  baseDir: string,
  relativeFile: string,
  kindLabel: string
): string {
  if (
    !relativeFile ||
    typeof relativeFile !== 'string' ||
    path.isAbsolute(relativeFile) ||
    !/^[a-zA-Z0-9._/-]+$/.test(relativeFile) ||
    relativeFile.split(/[\\/]/).includes('..')
  ) {
    throw new Error(`Unsafe ${kindLabel} path: ${String(relativeFile)}`);
  }
  const normalizedBase = path.resolve(baseDir);
  const resolved = path.resolve(normalizedBase, relativeFile);
  if (
    resolved !== normalizedBase &&
    !resolved.startsWith(normalizedBase + path.sep)
  ) {
    throw new Error(
      `${kindLabel} path "${relativeFile}" escapes base directory "${normalizedBase}".`
    );
  }
  return resolved;
}

interface LoadedSingleMosaicState {
  metadata: TilePackMetadata;
  tiles: TileManifestEntry[];
  ownerByTileKey: Map<string, string>;
  shardPathById: Map<string, string>;
  totalDbSizeBytes: number;
  snapshotId: string;
  sourceSha256: string;
  consolidation: RegionalMosaicConsolidationMetadata | null;
}

function loadSingleResolutionMosaic(
  mosaicIndexPath: string,
  allowCustomSnapshot: boolean
): LoadedSingleMosaicState {
  if (!fs.existsSync(mosaicIndexPath)) {
    throw new Error(
      `Regional mosaic index not found: ${mosaicIndexPath}. Run npm run osm:bake-regional-pilot first.`
    );
  }
  const index = JSON.parse(
    fs.readFileSync(mosaicIndexPath, 'utf-8')
  ) as RegionalMosaicIndex;
  if (index.schemaVersion !== 1 || !index.config || !Array.isArray(index.shards)) {
    throw new Error(
      `Regional mosaic index "${mosaicIndexPath}" has invalid schema version or structure.`
    );
  }
  if (
    !allowCustomSnapshot &&
    (index.snapshotId !== CANONICAL_HENGELO_SNAPSHOT_ID ||
      index.sourceSha256.toLowerCase() !== CANONICAL_HENGELO_SOURCE_SHA256)
  ) {
    throw new Error(
      'Regional mosaic index version or canonical OSM source snapshot mismatch'
    );
  }

  const plan = createRegionalMosaicPlan(index.config);
  const shardPathById = new Map<string, string>();
  const indexDir = path.dirname(mosaicIndexPath);
  let totalDbSizeBytes = 0;

  // Scan each shard sequentially and close immediately so 120-shard manifests
  // never leave 120 open SQLite file handles pinned in memory.
  const inputs = index.shards.map((entry) => {
    if (!entry.id) {
      throw new Error(`Missing regional mosaic shard id in "${mosaicIndexPath}"`);
    }
    const filepath = resolveSafeRelativeFile(
      indexDir,
      entry.file,
      'regional mosaic shard file'
    );
    if (shardPathById.has(entry.id)) {
      throw new Error(`Duplicate regional shard id ${entry.id}`);
    }
    shardPathById.set(entry.id, filepath);

    const store = new TilePackSqliteStore(filepath, {
      expectedSnapshotId: index.snapshotId,
      expectedSourceSha256: index.sourceSha256,
      allowCustomSnapshot,
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
  return {
    metadata: composed.metadata,
    tiles: composed.tiles,
    ownerByTileKey: composed.ownerByTileKey,
    shardPathById,
    totalDbSizeBytes,
    snapshotId: index.snapshotId,
    sourceSha256: index.sourceSha256,
    consolidation: index.consolidation ?? null,
  };
}

/**
 * Exposes one contiguous tile manifest over independently baked regional packs,
 * supporting both single-resolution `RegionalMosaicIndex` files and multi-resolution
 * `HierarchicalRegionalMosaicDescriptor` descriptors (TKT-041).
 *
 * Original source-pack payloads remain immutable; constituent mosaics are never
 * duplicated or rewritten. When serving a hierarchical descriptor:
 * - Cross-resolution compatibility (snapshot, SHA-256, projection, bake schema,
 *   LOD policy, compression, grid alignment, and overlapping UTM coverage) is
 *   validated before activation.
 * - All resolution levels are rebased to one shared canonical UTM world origin.
 * - Tiles are routed via resolution-qualified keys (`/r/:tileSizeMeters/:lod/:tx/:ty`)
 *   to eliminate collisions when internal baked `lod === 0` across resolutions.
 * - All resolutions share one bounded LRU pool of open SQLite shard handles.
 */
export function createRegionalMosaicHttpHandler(options: {
  indexPath: string;
  maxOpenShardHandles?: number;
  allowCustomSnapshot?: boolean;
}): {
  manifestHandler: (req: Request, res: Response) => Promise<void>;
  tilePayloadHandler: (req: Request, res: Response) => Promise<void>;
  getOpenShardHandleCount: () => number;
  getCoverageSnapshot: () => ActiveMosaicCoverageContext | null;
  close: () => void;
} {
  const indexPath = path.resolve(options.indexPath);
  const allowCustomSnapshot = Boolean(options.allowCustomSnapshot);
  const maxOpenShardHandles =
    typeof options.maxOpenShardHandles === 'number' &&
    Number.isSafeInteger(options.maxOpenShardHandles) &&
    options.maxOpenShardHandles >= 1
      ? options.maxOpenShardHandles
      : DEFAULT_MAX_OPEN_SHARD_HANDLES;

  let cached: {
    manifest: TilePackManifestHttpResponse;
    isHierarchical: boolean;
    defaultResolutionMeters: number;
    availableResolutions: Set<number>;
    /** Resolution-qualified key `r{res}:{lod}:{tx}:{ty}` -> global shard controller key `r{res}:{shardId}`. */
    ownerByHierarchicalKey: Map<string, string>;
    /** Global shard controller key `r{res}:{shardId}` -> resolved SQLite filepath. */
    shardPathByGlobalKey: Map<string, string>;
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
    globalShardKey: string
  ): TilePackHttpController => {
    const existing = state.openControllers.get(globalShardKey);
    if (existing) {
      // Refresh LRU recency
      state.openControllers.delete(globalShardKey);
      state.openControllers.set(globalShardKey, existing);
      return existing;
    }

    const filepath = state.shardPathByGlobalKey.get(globalShardKey);
    if (!filepath) {
      throw new Error(`Missing regional mosaic shard path for ${globalShardKey}`);
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
      allowCustomSnapshot,
    });
    state.openControllers.set(globalShardKey, controller);
    return controller;
  };

  const load = (): NonNullable<typeof cached> => {
    if (cached) return cached;
    if (!fs.existsSync(indexPath)) {
      throw new Error(
        `Regional mosaic index not found: ${indexPath}. Run npm run osm:bake-regional-pilot first.`
      );
    }
    const rawJson = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as unknown;

    if (isHierarchicalRegionalMosaicDescriptor(rawJson)) {
      const descriptor: HierarchicalRegionalMosaicDescriptor = rawJson;
      if (
        !allowCustomSnapshot &&
        (descriptor.snapshotId !== CANONICAL_HENGELO_SNAPSHOT_ID ||
          descriptor.sourceSha256.toLowerCase() !==
            CANONICAL_HENGELO_SOURCE_SHA256)
      ) {
        throw new HierarchicalMosaicCompatibilityError(
          'HIERARCHY_SNAPSHOT_MISMATCH',
          `Hierarchical mosaic descriptor snapshot/SHA does not match canonical Overijssel source "${CANONICAL_HENGELO_SNAPSHOT_ID}".`
        );
      }

      const descriptorDir = path.dirname(indexPath);
      const levelInputs: HierarchicalLevelCompositionInput[] = [];
      const ownerByHierarchicalKey = new Map<string, string>();
      const shardPathByGlobalKey = new Map<string, string>();
      const availableResolutions = new Set<number>();

      if (!Array.isArray(descriptor.levels) || descriptor.levels.length < 2) {
        throw new HierarchicalMosaicCompatibilityError(
          'HIERARCHY_LEVEL_COUNT_INVALID',
          'Hierarchical mosaic descriptor must declare at least 2 resolution levels.'
        );
      }

      for (const levelDesc of descriptor.levels) {
        const resolvedLevelIndexPath = resolveSafeRelativeFile(
          descriptorDir,
          levelDesc.indexPath,
          'hierarchical mosaic level index'
        );
        const loadedLevel = loadSingleResolutionMosaic(
          resolvedLevelIndexPath,
          allowCustomSnapshot
        );
        const res = levelDesc.tileSizeMeters;
        availableResolutions.add(res);

        for (const [shardId, shardFilePath] of loadedLevel.shardPathById.entries()) {
          shardPathByGlobalKey.set(`r${res}:${shardId}`, shardFilePath);
        }
        for (const [legacyKey, shardId] of loadedLevel.ownerByTileKey.entries()) {
          // legacyKey is `${lod}:${tx}:${ty}`
          ownerByHierarchicalKey.set(`r${res}:${legacyKey}`, `r${res}:${shardId}`);
        }

        levelInputs.push({
          descriptor: levelDesc,
          resolvedIndexPath: resolvedLevelIndexPath,
          dbSizeBytes: loadedLevel.totalDbSizeBytes,
          metadata: loadedLevel.metadata,
          tiles: loadedLevel.tiles,
          consolidation: loadedLevel.consolidation,
        });
      }

      const composed = validateAndComposeHierarchicalManifest(
        descriptor,
        indexPath,
        levelInputs
      );

      const manifest: TilePackManifestHttpResponse = {
        available: true,
        packPath: indexPath,
        dbSizeBytes: composed.totalDbSizeBytes,
        metadata: composed.primaryMetadata,
        tiles: composed.primaryTiles,
        hierarchy: composed.hierarchy,
      };

      cached = {
        manifest,
        isHierarchical: true,
        defaultResolutionMeters: composed.hierarchy.defaultResolutionMeters,
        availableResolutions,
        ownerByHierarchicalKey,
        shardPathByGlobalKey,
        snapshotId: descriptor.snapshotId,
        sourceSha256: descriptor.sourceSha256,
        openControllers: new Map(),
      };
      return cached;
    }

    // Legacy / single-resolution RegionalMosaicIndex
    const loaded = loadSingleResolutionMosaic(indexPath, allowCustomSnapshot);
    const res = loaded.metadata.tileSizeMeters;
    const ownerByHierarchicalKey = new Map<string, string>();
    const shardPathByGlobalKey = new Map<string, string>();

    for (const [shardId, shardFilePath] of loaded.shardPathById.entries()) {
      shardPathByGlobalKey.set(`r${res}:${shardId}`, shardFilePath);
    }
    for (const [legacyKey, shardId] of loaded.ownerByTileKey.entries()) {
      ownerByHierarchicalKey.set(`r${res}:${legacyKey}`, `r${res}:${shardId}`);
    }

    const manifest: TilePackManifestHttpResponse = {
      available: true,
      packPath: indexPath,
      dbSizeBytes: loaded.totalDbSizeBytes,
      metadata: loaded.metadata,
      tiles: loaded.tiles,
    };

    cached = {
      manifest,
      isHierarchical: false,
      defaultResolutionMeters: res,
      availableResolutions: new Set([res]),
      ownerByHierarchicalKey,
      shardPathByGlobalKey,
      snapshotId: loaded.snapshotId,
      sourceSha256: loaded.sourceSha256,
      openControllers: new Map(),
    };
    return cached;
  };

  const sendFailure = (res: Response, err: unknown): void => {
    close();
    if (err instanceof HierarchicalMosaicCompatibilityError) {
      res.status(503).json({
        available: false,
        code: err.code,
        error: err.message,
        details: err.details,
      });
      return;
    }
    res.status(503).json({
      available: false,
      code: 'REGIONAL_MOSAIC_UNAVAILABLE',
      error: err instanceof Error ? err.message : String(err),
    });
  };

  const manifestHandler = async (_req: Request, res: Response): Promise<void> => {
    try {
      const { manifest, isHierarchical } = load();
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-OSM-Snapshot-Id', manifest.metadata.snapshotId);
      res.setHeader('X-Tile-Bake-Schema', manifest.metadata.bakeSchemaVersion);
      if (isHierarchical && manifest.hierarchy) {
        res.setHeader('X-Tile-Hierarchy', '1');
        res.setHeader(
          'X-Tile-Resolutions',
          manifest.hierarchy.resolutionsMeters.join(',')
        );
      }
      res.status(200).json(manifest);
    } catch (err) {
      sendFailure(res, err);
    }
  };

  const tilePayloadHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const state = load();

      let resolutionMeters = state.defaultResolutionMeters;
      const rawResParam = req.params.tileSizeMeters;
      if (rawResParam !== undefined) {
        const resStr = String(rawResParam);
        if (!/^\d+$/.test(resStr)) {
          res.status(400).json({
            error: 'Invalid tile resolution parameter',
            code: 'TILE_INVALID_RESOLUTION',
          });
          return;
        }
        resolutionMeters = Number(resStr);
        if (
          !Number.isSafeInteger(resolutionMeters) ||
          resolutionMeters <= 0
        ) {
          res.status(400).json({
            error: 'Invalid tile resolution parameter',
            code: 'TILE_INVALID_RESOLUTION',
          });
          return;
        }
        if (!state.availableResolutions.has(resolutionMeters)) {
          res.status(404).json({
            error: `Tile resolution ${resolutionMeters} m is not available in active mosaic (available: ${Array.from(state.availableResolutions).join(', ')} m).`,
            code: 'TILE_RESOLUTION_NOT_FOUND',
          });
          return;
        }
      }

      const parts = [req.params.lod, req.params.tx, req.params.ty].map(String);
      if (parts.some((part) => !/^-?\d+$/.test(part))) {
        res.status(400).json({
          error: 'Invalid tile coordinates',
          code: 'TILE_INVALID_COORDINATES',
        });
        return;
      }
      const [lod, tx, ty] = parts.map(Number);
      if (lod !== 0 || !Number.isSafeInteger(tx) || !Number.isSafeInteger(ty)) {
        res.status(400).json({
          error: 'Invalid LOD/tile coordinates',
          code: 'TILE_INVALID_COORDINATES',
        });
        return;
      }

      const routeOwnerKey = formatHierarchicalRouteOwnerKey(
        resolutionMeters,
        lod,
        tx,
        ty
      );
      const globalShardKey = state.ownerByHierarchicalKey.get(routeOwnerKey);
      if (!globalShardKey) {
        res.status(404).json({
          error: `Regional mosaic tile ${routeOwnerKey} not found`,
          code: 'TILE_NOT_FOUND',
        });
        return;
      }

      res.setHeader('X-Tile-Resolution-Meters', String(resolutionMeters));
      res.setHeader(
        'X-Tile-Hierarchical-Key',
        formatHierarchicalTileKey(resolutionMeters, tx, ty, lod)
      );

      const shardController = acquireShardController(state, globalShardKey);
      await shardController.tilePayloadHandler(req, res);
    } catch (err) {
      sendFailure(res, err);
    }
  };

  const getCoverageSnapshot = (): ActiveMosaicCoverageContext | null => {
    try {
      const state = load();
      return {
        mosaicName: state.manifest.hierarchy
          ? state.manifest.hierarchy.hierarchyName
          : deriveActiveMosaicNameFromPackPath(state.manifest.packPath),
        packPath: state.manifest.packPath ?? null,
        metadata: state.manifest.metadata,
        tiles: state.manifest.tiles,
      };
    } catch {
      return null;
    }
  };

  return {
    manifestHandler,
    tilePayloadHandler,
    getOpenShardHandleCount,
    getCoverageSnapshot,
    close,
  };
}
