import type { Request, Response } from 'express';
import {
  resolveDefaultTilePackPath,
  TilePackSqliteStore,
} from './TilePackSqliteStore';
import { inflateTilePayload } from './TileCompression';
import {
  BAKE_SCHEMA_VERSION,
  CANONICAL_HENGELO_SNAPSHOT_ID,
  CANONICAL_HENGELO_SOURCE_SHA256,
  TilePackCorruptError,
  TilePackIncompatibleError,
  TilePackMissingError,
  type TileManifestEntry,
  type TilePackMetadata,
} from '../../world/tiling/TilePackContract';
import { formatTileId } from '../../world/tiling/TileGrid';
import type { HierarchicalMosaicManifestExtension } from '../../world/tiling/HierarchicalMosaicContract';

export interface TilePackHttpHandlerOptions {
  /** Path to the baked SQLite tile pack (`overijssel-tiles-261114-8ae28196.sqlite`). */
  packPath?: string;
  /** Expected source SHA-256 (`CANONICAL_HENGELO_SOURCE_SHA256` by default). */
  expectedSourceSha256?: string;
  /** Expected snapshot ID (`overijssel-261114-8ae28196` by default). */
  expectedSnapshotId?: string;
  /** Expected bake schema version (`BAKE_SCHEMA_VERSION` by default). */
  expectedBakeSchemaVersion?: string;
  /** Allow custom snapshot IDs/hashes in unit tests. */
  allowCustomSnapshot?: boolean;
}

export interface TilePackManifestHttpResponse {
  available: true;
  packPath: string;
  dbSizeBytes: number;
  metadata: TilePackMetadata;
  tiles: TileManifestEntry[];
  /** Present when serving a validated multi-resolution hierarchical regional mosaic (TKT-041). */
  hierarchy?: HierarchicalMosaicManifestExtension;
}

export interface TilePackHttpController {
  manifestHandler: (req: Request, res: Response) => Promise<void>;
  tilePayloadHandler: (req: Request, res: Response) => Promise<void>;
  getStore: () => TilePackSqliteStore;
  close: () => void;
}

/**
 * Express HTTP handler factory for serving pre-baked `OSMTILE1` tiles and
 * manifest metadata from `TilePackSqliteStore`.
 *
 * Enforces snapshot identity, bake schema version, and tile integrity (SHA-256
 * compressed payload hash, compressed/raw byte lengths, and immutable ETag).
 * Never runs `GeometryBuilder` or synthesizes geometry in the request path.
 */
export function createTilePackHttpHandler(
  options: TilePackHttpHandlerOptions = {}
): TilePackHttpController {
  const packPath =
    options.packPath ?? resolveDefaultTilePackPath();
  const expectedSnapshotId =
    options.expectedSnapshotId ?? CANONICAL_HENGELO_SNAPSHOT_ID;
  const expectedSourceSha256 =
    options.expectedSourceSha256 ?? CANONICAL_HENGELO_SOURCE_SHA256;
  const expectedBakeSchemaVersion =
    options.expectedBakeSchemaVersion ?? BAKE_SCHEMA_VERSION;
  const allowCustomSnapshot = Boolean(options.allowCustomSnapshot);

  let cachedStore: TilePackSqliteStore | null = null;

  const getStore = (): TilePackSqliteStore => {
    if (!cachedStore) {
      cachedStore = new TilePackSqliteStore(packPath, {
        expectedSourceSha256,
        expectedSnapshotId,
        expectedBakeSchemaVersion,
        allowCustomSnapshot,
      });
    }
    const meta = cachedStore.getMetadata();
    if (!allowCustomSnapshot && meta.snapshotId !== expectedSnapshotId) {
      throw new TilePackIncompatibleError(
        `Tile pack snapshot_id mismatch: expected "${expectedSnapshotId}", found "${meta.snapshotId}".`,
        packPath,
        'snapshot_id_mismatch',
        expectedSnapshotId,
        meta.snapshotId
      );
    }
    if (meta.bakeSchemaVersion !== expectedBakeSchemaVersion) {
      throw new TilePackIncompatibleError(
        `Tile pack bake_schema_version mismatch: expected "${expectedBakeSchemaVersion}", found "${meta.bakeSchemaVersion}".`,
        packPath,
        'schema_version_mismatch',
        expectedBakeSchemaVersion,
        meta.bakeSchemaVersion
      );
    }
    return cachedStore;
  };

  const sendStoreError = (res: Response, err: unknown): void => {
    if (err instanceof TilePackMissingError) {
      res.status(503).json({
        available: false,
        error: err.message,
        code: 'TILE_PACK_MISSING',
        packPath: err.packPath,
      });
      return;
    }
    if (err instanceof TilePackIncompatibleError) {
      res.status(503).json({
        available: false,
        error: err.message,
        code: 'TILE_PACK_INCOMPATIBLE',
        reason: err.reason,
        packPath: err.packPath,
        expected: err.expected,
        actual: err.actual,
      });
      return;
    }
    if (err instanceof TilePackCorruptError) {
      res.status(503).json({
        available: false,
        error: err.message,
        code: 'TILE_PACK_CORRUPT',
        reason: err.reason,
        packPath,
        tileKey: err.tileKey,
      });
      return;
    }
    const message =
      err instanceof Error ? err.message : 'Unexpected tile pack server error';
    res.status(500).json({
      available: false,
      error: message,
      code: 'TILE_PACK_INTERNAL_ERROR',
      packPath,
    });
  };

  const manifestHandler = async (_req: Request, res: Response): Promise<void> => {
    try {
      const store = getStore();
      const metadata = store.getMetadata();
      const tiles = store.listManifestEntries(0);
      const payload: TilePackManifestHttpResponse = {
        available: true,
        packPath,
        dbSizeBytes: store.getFileSizeBytes(),
        metadata,
        tiles,
      };
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-OSM-Snapshot-Id', metadata.snapshotId);
      res.setHeader('X-Tile-Bake-Schema', metadata.bakeSchemaVersion);
      res.status(200).json(payload);
    } catch (err) {
      cachedStore?.close();
      cachedStore = null;
      sendStoreError(res, err);
    }
  };

  const tilePayloadHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const store = getStore();
      const metadata = store.getMetadata();

      const snapshotParam = req.params.snapshotId;
      if (
        typeof snapshotParam === 'string' &&
        snapshotParam.length > 0 &&
        snapshotParam !== metadata.snapshotId
      ) {
        res.status(409).json({
          error: `Requested snapshot "${snapshotParam}" does not match active tile pack snapshot "${metadata.snapshotId}".`,
          code: 'TILE_SNAPSHOT_MISMATCH',
          expected: metadata.snapshotId,
          actual: snapshotParam,
        });
        return;
      }

      const schemaParam = req.params.schemaVersion;
      if (
        typeof schemaParam === 'string' &&
        schemaParam.length > 0 &&
        schemaParam !== metadata.bakeSchemaVersion
      ) {
        res.status(409).json({
          error: `Requested schema version "${schemaParam}" does not match active tile pack schema "${metadata.bakeSchemaVersion}".`,
          code: 'TILE_SCHEMA_MISMATCH',
          expected: metadata.bakeSchemaVersion,
          actual: schemaParam,
        });
        return;
      }

      const lod = Number.parseInt(String(req.params.lod ?? ''), 10);
      const tx = Number.parseInt(String(req.params.tx ?? ''), 10);
      const ty = Number.parseInt(String(req.params.ty ?? ''), 10);

      if (
        !Number.isInteger(lod) ||
        !Number.isInteger(tx) ||
        !Number.isInteger(ty) ||
        lod < 0
      ) {
        res.status(400).json({
          error: 'Invalid tile coordinates: lod, tx, and ty must be valid integers.',
          code: 'TILE_INVALID_COORDINATES',
        });
        return;
      }

      const tileRecord = store.getTileCompressed(lod, tx, ty);
      if (!tileRecord) {
        res.status(404).json({
          error: `Tile lod=${lod} tx=${tx} ty=${ty} not found in baked pack.`,
          code: 'TILE_NOT_FOUND',
          lod,
          tx,
          ty,
        });
        return;
      }

      const { manifest, compressedPayload } = tileRecord;
      const tileKey = formatTileId(manifest.tx, manifest.ty);
      const etag = `"${manifest.contentHash}"`;
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch === etag || ifNoneMatch === manifest.contentHash) {
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.status(304).end();
        return;
      }

      // Inflate compressed blob and verify exact raw byte length before serving
      // raw OSMTILE1 binary bytes to the browser Web Worker decoder.
      const rawPayload = inflateTilePayload(compressedPayload, tileKey);
      if (rawPayload.byteLength !== manifest.rawBytes) {
        throw new TilePackCorruptError(
          `Tile ${tileKey} inflated byte length mismatch (expected ${manifest.rawBytes}, got ${rawPayload.byteLength}).`,
          tileKey,
          'raw_bytes_mismatch'
        );
      }

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(rawPayload.byteLength));
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-OSM-Snapshot-Id', metadata.snapshotId);
      res.setHeader('X-Tile-Bake-Schema', metadata.bakeSchemaVersion);
      res.setHeader('X-Tile-Key', tileKey);
      res.setHeader('X-Tile-Content-Hash', manifest.contentHash);
      res.setHeader('X-Tile-Raw-Bytes', String(manifest.rawBytes));
      res.setHeader('X-Tile-Compressed-Bytes', String(manifest.compressedBytes));
      res.setHeader('X-Tile-Is-Empty', manifest.isEmpty ? '1' : '0');

      res.status(200).send(
        Buffer.from(
          rawPayload.buffer,
          rawPayload.byteOffset,
          rawPayload.byteLength
        )
      );
    } catch (err) {
      cachedStore?.close();
      cachedStore = null;
      sendStoreError(res, err);
    }
  };

  return {
    manifestHandler,
    tilePayloadHandler,
    getStore,
    close: () => {
      cachedStore?.close();
      cachedStore = null;
    },
  };
}
