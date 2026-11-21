import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { resolveOverijsselDataDir } from '../osm/overijsselConfig';
import { decodeTileBinary } from '../../world/tiling/TileBinaryCodec';
import { DEFAULT_TILE_SIZE_METERS } from '../../world/tiling/TileGrid';
import {
  BAKE_SCHEMA_VERSION,
  CANONICAL_HENGELO_SNAPSHOT_ID,
  CANONICAL_HENGELO_SOURCE_SHA256,
  DEFAULT_PROJECTION_ID,
  DEFAULT_TILE_PACK_FILENAME,
  TilePackCorruptError,
  TilePackIncompatibleError,
  TilePackMissingError,
  type DecodedTilePayload,
  type TileBakeStatus,
  type TileCompressionAlgorithm,
  type TileManifestEntry,
  type TilePackMetadata,
} from '../../world/tiling/TilePackContract';
import { inflateTilePayload, sha256Hex } from './TileCompression';

export interface TilePackOpenOptions {
  expectedSourceSha256?: string;
  expectedSnapshotId?: string;
  expectedBakeSchemaVersion?: string;
  expectedProjectionId?: string;
  expectedLodPolicyHash?: string;
  allowCustomSnapshot?: boolean;
  verifyTileCount?: boolean;
}

export interface TileWriteBatchItem {
  manifest: TileManifestEntry;
  compressedPayload: Uint8Array;
}

export function resolveDefaultTilePackPath(repoRoot: string = process.cwd()): string {
  const custom = process.env.OVERIJSSEL_TILE_PACK_PATH?.trim();
  if (custom) {
    return path.resolve(repoRoot, custom);
  }
  return path.join(resolveOverijsselDataDir(repoRoot), DEFAULT_TILE_PACK_FILENAME);
}

/**
 * Resolves the offline SQLite tile pack path for a given LOD0 tile dimension without
 * overwriting the accepted 512 m default (`overijssel-tiles-261114-8ae28196.sqlite`).
 */
export function resolveTilePackPathForTileSize(
  tileSizeMeters: number = DEFAULT_TILE_SIZE_METERS,
  repoRoot: string = process.cwd()
): string {
  if (tileSizeMeters === DEFAULT_TILE_SIZE_METERS) {
    return resolveDefaultTilePackPath(repoRoot);
  }
  const envKey = `OVERIJSSEL_TILE_PACK_${tileSizeMeters}M_PATH`;
  const customForSize = process.env[envKey]?.trim();
  if (customForSize) {
    return path.resolve(repoRoot, customForSize);
  }
  const ext = path.extname(DEFAULT_TILE_PACK_FILENAME) || '.sqlite';
  const base = path.basename(DEFAULT_TILE_PACK_FILENAME, ext);
  return path.join(resolveOverijsselDataDir(repoRoot), `${base}-${tileSizeMeters}m${ext}`);
}

const SQLITE_SCHEMA_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tile_manifest (
  lod INTEGER NOT NULL,
  tx INTEGER NOT NULL,
  ty INTEGER NOT NULL,
  min_easting REAL NOT NULL,
  max_easting REAL NOT NULL,
  min_northing REAL NOT NULL,
  max_northing REAL NOT NULL,
  tile_center_x REAL NOT NULL,
  tile_center_z REAL NOT NULL,
  overhang_min_x REAL NOT NULL,
  overhang_max_x REAL NOT NULL,
  overhang_min_y REAL NOT NULL,
  overhang_max_y REAL NOT NULL,
  overhang_min_z REAL NOT NULL,
  overhang_max_z REAL NOT NULL,
  tri_count INTEGER NOT NULL,
  vertex_count INTEGER NOT NULL,
  feature_count INTEGER NOT NULL,
  is_empty INTEGER NOT NULL,
  has_bvh INTEGER NOT NULL,
  raw_bytes INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (lod, tx, ty)
);

CREATE TABLE IF NOT EXISTS tiles (
  lod INTEGER NOT NULL,
  tx INTEGER NOT NULL,
  ty INTEGER NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY (lod, tx, ty)
);

CREATE INDEX IF NOT EXISTS idx_tile_manifest_lod_tx_ty ON tile_manifest (lod, tx, ty);
CREATE INDEX IF NOT EXISTS idx_tiles_lod_tx_ty ON tiles (lod, tx, ty);
`;

export class TilePackSqliteWriter {
  private readonly db: DatabaseSync;
  private readonly stagingPath: string;
  private readonly targetPath: string;
  private readonly insertMetaStmt: StatementSync;
  private readonly insertManifestStmt: StatementSync;
  private readonly insertTileStmt: StatementSync;
  private closed = false;
  private committed = false;

  constructor(targetPath: string, initialMeta: Omit<TilePackMetadata, 'bakeStatus' | 'completedAtIso'>) {
    this.targetPath = path.resolve(targetPath);
    fs.mkdirSync(path.dirname(this.targetPath), { recursive: true });
    this.stagingPath = `${this.targetPath}.staging-${process.pid}-${Date.now()}.sqlite`;

    this.db = new DatabaseSync(this.stagingPath);
    this.db.exec(SQLITE_SCHEMA_DDL);

    this.insertMetaStmt = this.db.prepare(
      'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)'
    );
    this.insertManifestStmt = this.db.prepare(`
      INSERT OR REPLACE INTO tile_manifest (
        lod, tx, ty,
        min_easting, max_easting, min_northing, max_northing,
        tile_center_x, tile_center_z,
        overhang_min_x, overhang_max_x, overhang_min_y, overhang_max_y, overhang_min_z, overhang_max_z,
        tri_count, vertex_count, feature_count, is_empty, has_bvh,
        raw_bytes, compressed_bytes, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertTileStmt = this.db.prepare(
      'INSERT OR REPLACE INTO tiles (lod, tx, ty, payload) VALUES (?, ?, ?, ?)'
    );

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const entries: Array<[string, string]> = [
        ['snapshot_id', initialMeta.snapshotId],
        ['source_sha256', initialMeta.sourceSha256],
        ['projection_id', initialMeta.projectionId],
        ['bake_schema_version', initialMeta.bakeSchemaVersion],
        ['lod_policy_hash', initialMeta.lodPolicyHash],
        ['compression', initialMeta.compression],
        ['tile_size_meters', String(initialMeta.tileSizeMeters)],
        ['collar_meters', String(initialMeta.collarMeters)],
        ['study_origin_easting', String(initialMeta.studyOriginEasting)],
        ['study_origin_northing', String(initialMeta.studyOriginNorthing)],
        ['grid_cols', String(initialMeta.gridCols)],
        ['grid_rows', String(initialMeta.gridRows)],
        ['min_tx', String(initialMeta.minTx)],
        ['max_tx', String(initialMeta.maxTx)],
        ['min_ty', String(initialMeta.minTy)],
        ['max_ty', String(initialMeta.maxTy)],
        ['bake_status', 'in_progress'],
        ['created_at_iso', initialMeta.createdAtIso],
        ['completed_at_iso', ''],
      ];
      for (const [k, v] of entries) {
        this.insertMetaStmt.run(k, v);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      this.abort();
      throw err;
    }
  }

  writeTileBatch(items: readonly TileWriteBatchItem[]): void {
    if (this.closed || this.committed) {
      throw new Error('Cannot write batch after TilePackSqliteWriter finalized or aborted');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { manifest, compressedPayload } of items) {
        this.insertManifestStmt.run(
          manifest.lod,
          manifest.tx,
          manifest.ty,
          manifest.minEasting,
          manifest.maxEasting,
          manifest.minNorthing,
          manifest.maxNorthing,
          manifest.tileCenterX,
          manifest.tileCenterZ,
          manifest.overhangMinX,
          manifest.overhangMaxX,
          manifest.overhangMinY,
          manifest.overhangMaxY,
          manifest.overhangMinZ,
          manifest.overhangMaxZ,
          manifest.triCount,
          manifest.vertexCount,
          manifest.featureCount,
          manifest.isEmpty ? 1 : 0,
          manifest.hasBvh ? 1 : 0,
          manifest.rawBytes,
          manifest.compressedBytes,
          manifest.contentHash
        );
        this.insertTileStmt.run(manifest.lod, manifest.tx, manifest.ty, compressedPayload);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  finalize(completedAtIso = new Date().toISOString()): void {
    if (this.closed || this.committed) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.insertMetaStmt.run('bake_status', 'complete');
      this.insertMetaStmt.run('completed_at_iso', completedAtIso);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      this.abort();
      throw err;
    }

    // Flush WAL back into main SQLite file before atomic rename
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    this.db.exec('PRAGMA journal_mode = DELETE;');
    this.db.close();
    this.closed = true;
    this.committed = true;

    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(this.stagingPath + suffix)) {
        fs.rmSync(this.stagingPath + suffix, { force: true });
      }
      if (fs.existsSync(this.targetPath + suffix)) {
        fs.rmSync(this.targetPath + suffix, { force: true });
      }
    }
    fs.renameSync(this.stagingPath, this.targetPath);
  }

  abort(): void {
    if (!this.closed) {
      try {
        this.db.close();
      } catch {
        // Ignore close failure on abort
      }
      this.closed = true;
    }
    if (!this.committed) {
      for (const candidate of [
        this.stagingPath,
        `${this.stagingPath}-wal`,
        `${this.stagingPath}-shm`,
      ]) {
        if (fs.existsSync(candidate)) {
          fs.rmSync(candidate, { force: true });
        }
      }
    }
  }
}

export class TilePackSqliteStore {
  private readonly db: DatabaseSync;
  private readonly packPath: string;
  private readonly metadata: TilePackMetadata;
  private readonly getManifestStmt: StatementSync;
  private readonly getAllManifestsStmt: StatementSync;
  private readonly getTileStmt: StatementSync;
  private closed = false;

  constructor(packPath: string, options: TilePackOpenOptions = {}) {
    this.packPath = path.resolve(packPath);
    if (!fs.existsSync(this.packPath)) {
      throw new TilePackMissingError(
        `Tile pack SQLite database not found at "${this.packPath}"`,
        this.packPath
      );
    }

    this.db = new DatabaseSync(this.packPath, { readOnly: true });
    try {
      this.metadata = this.readAndValidateMetadata(options);
      this.getManifestStmt = this.db.prepare(
        'SELECT * FROM tile_manifest WHERE lod = ? AND tx = ? AND ty = ?'
      );
      this.getAllManifestsStmt = this.db.prepare(
        'SELECT * FROM tile_manifest WHERE lod = ? ORDER BY ty DESC, tx ASC'
      );
      this.getTileStmt = this.db.prepare(
        'SELECT payload FROM tiles WHERE lod = ? AND tx = ? AND ty = ?'
      );
    } catch (err) {
      this.db.close();
      this.closed = true;
      throw err;
    }
  }

  private readAndValidateMetadata(options: TilePackOpenOptions): TilePackMetadata {
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('metadata', 'tile_manifest', 'tiles')")
      .all() as Array<{ name: string }>;
    if (tables.length < 3) {
      throw new TilePackIncompatibleError(
        `Tile pack "${this.packPath}" is missing required tables (metadata, tile_manifest, tiles)`,
        this.packPath,
        'missing_tables'
      );
    }

    const rows = this.db.prepare('SELECT key, value FROM metadata').all() as Array<{
      key: string;
      value: string;
    }>;
    const kv = new Map(rows.map((r) => [r.key, r.value]));
    const req = (k: string): string => {
      const v = kv.get(k);
      if (v === undefined) {
        throw new TilePackIncompatibleError(
          `Tile pack "${this.packPath}" missing metadata key "${k}"`,
          this.packPath,
          'missing_metadata_key',
          k,
          undefined
        );
      }
      return v;
    };

    const bakeStatus = req('bake_status') as TileBakeStatus;
    if (bakeStatus !== 'complete') {
      throw new TilePackIncompatibleError(
        `Tile pack "${this.packPath}" has bake_status="${bakeStatus}" (interrupted or incomplete bake)`,
        this.packPath,
        'incomplete_bake',
        'complete',
        bakeStatus
      );
    }

    const bakeSchemaVersion = req('bake_schema_version');
    const expectedSchema = options.expectedBakeSchemaVersion ?? BAKE_SCHEMA_VERSION;
    if (bakeSchemaVersion !== expectedSchema) {
      throw new TilePackIncompatibleError(
        `Tile pack schema version "${bakeSchemaVersion}" does not match expected "${expectedSchema}"`,
        this.packPath,
        'schema_version_mismatch',
        expectedSchema,
        bakeSchemaVersion
      );
    }

    const projectionId = req('projection_id');
    const expectedProjection = options.expectedProjectionId ?? DEFAULT_PROJECTION_ID;
    if (projectionId !== expectedProjection) {
      throw new TilePackIncompatibleError(
        `Tile pack projection "${projectionId}" does not match expected "${expectedProjection}"`,
        this.packPath,
        'projection_mismatch',
        expectedProjection,
        projectionId
      );
    }

    const snapshotId = req('snapshot_id');
    const sourceSha256 = req('source_sha256').toLowerCase();
    const allowCustom = Boolean(options.allowCustomSnapshot);
    const expectedSha = (
      options.expectedSourceSha256 ?? (allowCustom ? '' : CANONICAL_HENGELO_SOURCE_SHA256)
    ).toLowerCase();

    if (expectedSha && sourceSha256 !== expectedSha) {
      throw new TilePackIncompatibleError(
        `Tile pack source_sha256 "${sourceSha256}" does not match expected "${expectedSha}"`,
        this.packPath,
        'source_sha256_mismatch',
        expectedSha,
        sourceSha256
      );
    }

    const expectedSnapshotId =
      options.expectedSnapshotId ?? (allowCustom ? undefined : CANONICAL_HENGELO_SNAPSHOT_ID);
    if (expectedSnapshotId && snapshotId !== expectedSnapshotId) {
      throw new TilePackIncompatibleError(
        `Tile pack snapshot_id "${snapshotId}" does not match expected "${expectedSnapshotId}"`,
        this.packPath,
        'snapshot_id_mismatch',
        expectedSnapshotId,
        snapshotId
      );
    }

    const lodPolicyHash = req('lod_policy_hash');
    if (options.expectedLodPolicyHash && lodPolicyHash !== options.expectedLodPolicyHash) {
      throw new TilePackIncompatibleError(
        `Tile pack lod_policy_hash "${lodPolicyHash}" does not match expected "${options.expectedLodPolicyHash}"`,
        this.packPath,
        'lod_policy_mismatch',
        options.expectedLodPolicyHash,
        lodPolicyHash
      );
    }

    const gridCols = Number(req('grid_cols'));
    const gridRows = Number(req('grid_rows'));
    if (options.verifyTileCount !== false) {
      const countRow = this.db
        .prepare('SELECT COUNT(*) AS cnt FROM tiles')
        .get() as { cnt: number };
      const manifestCountRow = this.db
        .prepare('SELECT COUNT(*) AS cnt FROM tile_manifest')
        .get() as { cnt: number };
      const expectedTiles = gridCols * gridRows;
      if (countRow.cnt !== expectedTiles || manifestCountRow.cnt !== expectedTiles) {
        throw new TilePackIncompatibleError(
          `Tile pack tile count mismatch (tiles=${countRow.cnt}, manifest=${manifestCountRow.cnt}, expected=${expectedTiles})`,
          this.packPath,
          'incomplete_tile_count',
          String(expectedTiles),
          `${countRow.cnt}/${manifestCountRow.cnt}`
        );
      }
    }

    return {
      snapshotId,
      sourceSha256,
      projectionId,
      bakeSchemaVersion,
      lodPolicyHash,
      compression: req('compression') as TileCompressionAlgorithm,
      tileSizeMeters: Number(req('tile_size_meters')),
      collarMeters: Number(req('collar_meters')),
      studyOriginEasting: Number(req('study_origin_easting')),
      studyOriginNorthing: Number(req('study_origin_northing')),
      gridCols,
      gridRows,
      minTx: Number(req('min_tx')),
      maxTx: Number(req('max_tx')),
      minTy: Number(req('min_ty')),
      maxTy: Number(req('max_ty')),
      bakeStatus,
      createdAtIso: req('created_at_iso'),
      completedAtIso: kv.get('completed_at_iso') || null,
    };
  }

  getMetadata(): TilePackMetadata {
    return { ...this.metadata };
  }

  getFileSizeBytes(): number {
    return fs.statSync(this.packPath).size;
  }

  getManifestEntry(lod: number, tx: number, ty: number): TileManifestEntry | null {
    const row = this.getManifestStmt.get(lod, tx, ty) as Record<string, unknown> | undefined;
    return row ? this.mapManifestRow(row) : null;
  }

  listManifestEntries(lod = 0): TileManifestEntry[] {
    const rows = this.getAllManifestsStmt.all(lod) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapManifestRow(r));
  }

  getTileCompressed(
    lod: number,
    tx: number,
    ty: number
  ): { manifest: TileManifestEntry; compressedPayload: Uint8Array } | null {
    const manifest = this.getManifestEntry(lod, tx, ty);
    if (!manifest) return null;
    const row = this.getTileStmt.get(lod, tx, ty) as { payload: Uint8Array } | undefined;
    if (!row) {
      throw new TilePackCorruptError(
        `Tile (${lod}:${tx}:${ty}) exists in manifest but missing from tiles table`,
        `${lod}:${tx}:${ty}`,
        'missing_tile_blob'
      );
    }
    const payload = new Uint8Array(row.payload.buffer, row.payload.byteOffset, row.payload.byteLength);
    if (payload.byteLength !== manifest.compressedBytes) {
      throw new TilePackCorruptError(
        `Tile (${lod}:${tx}:${ty}) compressed size mismatch (${payload.byteLength} != ${manifest.compressedBytes})`,
        `${lod}:${tx}:${ty}`,
        'compressed_size_mismatch'
      );
    }
    const actualHash = sha256Hex(payload);
    if (actualHash !== manifest.contentHash) {
      throw new TilePackCorruptError(
        `Tile (${lod}:${tx}:${ty}) SHA-256 mismatch (${actualHash} != ${manifest.contentHash})`,
        `${lod}:${tx}:${ty}`,
        'content_hash_mismatch'
      );
    }
    return { manifest, compressedPayload: payload };
  }

  getTileDecoded(lod: number, tx: number, ty: number): DecodedTilePayload | null {
    const entry = this.getTileCompressed(lod, tx, ty);
    if (!entry) return null;
    const keyHint = `${lod}:${tx}:${ty}`;
    const raw = inflateTilePayload(entry.compressedPayload, keyHint);
    if (raw.byteLength !== entry.manifest.rawBytes) {
      throw new TilePackCorruptError(
        `Tile (${keyHint}) inflated size mismatch (${raw.byteLength} != ${entry.manifest.rawBytes})`,
        keyHint,
        'raw_size_mismatch'
      );
    }
    return decodeTileBinary(raw, keyHint);
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private mapManifestRow(r: Record<string, unknown>): TileManifestEntry {
    return {
      lod: Number(r.lod),
      tx: Number(r.tx),
      ty: Number(r.ty),
      minEasting: Number(r.min_easting),
      maxEasting: Number(r.max_easting),
      minNorthing: Number(r.min_northing),
      maxNorthing: Number(r.max_northing),
      tileCenterX: Number(r.tile_center_x),
      tileCenterZ: Number(r.tile_center_z),
      overhangMinX: Number(r.overhang_min_x),
      overhangMaxX: Number(r.overhang_max_x),
      overhangMinY: Number(r.overhang_min_y),
      overhangMaxY: Number(r.overhang_max_y),
      overhangMinZ: Number(r.overhang_min_z),
      overhangMaxZ: Number(r.overhang_max_z),
      triCount: Number(r.tri_count),
      vertexCount: Number(r.vertex_count),
      featureCount: Number(r.feature_count),
      isEmpty: Number(r.is_empty) !== 0,
      hasBvh: Number(r.has_bvh) !== 0,
      rawBytes: Number(r.raw_bytes),
      compressedBytes: Number(r.compressed_bytes),
      contentHash: String(r.content_hash),
    };
  }
}
