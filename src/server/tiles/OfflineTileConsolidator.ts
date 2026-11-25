import fs from 'node:fs';
import path from 'node:path';
import {
  computeLodPolicyHash,
  type TileManifestEntry,
  type TilePackMetadata,
} from '../../world/tiling/TilePackContract';
import {
  composeRegionalMosaicManifest,
  createRegionalMosaicPlan,
  type RegionalMosaicConfig,
  type RegionalMosaicIndex,
  type RegionalMosaicPackInput,
} from '../../world/tiling/RegionalMosaicPlan';
import { utm32NToGeo } from '../../world/tiling/RegionalProjection';
import {
  encodeDecodedTilePayloadToBinary,
} from '../../world/tiling/TileBinaryCodec';
import {
  consolidateChildTilePayloads,
  DEFAULT_TILE_CONSOLIDATION_POLICY,
  formatSpatialSubBatchPolicy,
  type ChildTileConsolidationInput,
  type TileConsolidationPolicy,
} from '../../world/tiling/TileConsolidator';
import {
  TilePackSqliteStore,
  TilePackSqliteWriter,
} from './TilePackSqliteStore';
import { deflateTilePayload, sha256Hex } from './TileCompression';

export const OFFLINE_TILE_CONSOLIDATOR_VERSION = 'tkt037-v1';

export interface ConsolidateRegionalMosaicOptions {
  /** Path to source regional mosaic index JSON (e.g. data/osm/twente-full-1024m-foliage-fix/mosaic.json). */
  sourceIndexPath: string;
  /** Target consolidated tile edge size in meters (e.g. 2048 or 4096; integer multiple >= 2 of source tile size). */
  targetTileSizeMeters: number;
  /** Separate output directory for the consolidated mosaic. Must never equal or overlap the source directory. */
  outputDir: string;
  /** Optional custom mosaic name (defaults to `<sourceName>-<targetSize>m`). */
  mosaicName?: string;
  /** Spatial sub-batching and BVH consolidation policy. */
  policy?: Partial<TileConsolidationPolicy>;
  /** Optional explicit shard width in parent tiles (must divide parent grid cols). */
  shardCols?: number;
  /** Optional explicit shard height in parent tiles (must divide parent grid rows). */
  shardRows?: number;
  /** Maximum open source SQLite shard handles in LRU cache (default 8). */
  maxOpenSourceShards?: number;
  /** Whether to verify every output shard pack after consolidation (default true). */
  verifyOutput?: boolean;
  /** Allow custom/synthetic snapshots (default false for production, true in synthetic unit tests). */
  allowCustomSnapshot?: boolean;
  /** Optional progress callback invoked per completed parent tile. */
  onProgress?: (info: {
    completedParentTiles: number;
    totalParentTiles: number;
    shardId: string;
    tx: number;
    ty: number;
    rssMiB: number;
  }) => void;
}

export interface ConsolidationMosaicReport {
  toolVersion: string;
  consolidatedAtIso: string;
  sourceIndexPath: string;
  outputIndexPath: string;
  sourceMosaicName: string;
  outputMosaicName: string;
  snapshotId: string;
  sourceSha256: string;
  sourceTileSizeMeters: number;
  targetTileSizeMeters: number;
  consolidationFactor: number;
  policy: {
    foliageBatchMode: string;
    sleeperBatchMode: string;
    includeBvh: boolean;
  };
  grid: {
    sourceCols: number;
    sourceRows: number;
    sourceTotalTiles: number;
    sourceNonEmptyTiles: number;
    parentCols: number;
    parentRows: number;
    parentTotalTiles: number;
    parentNonEmptyTiles: number;
    parentPartialCoverageTiles: number;
    parentShardCols: number;
    parentShardRows: number;
    parentShardCount: number;
  };
  geometryAudit: {
    sourceStaticMeshes: number;
    parentStaticMeshes: number;
    staticMeshReductionPct: number;
    sourceInstancedBatches: number;
    parentInstancedBatches: number;
    sourceStaticDrawCalls: number;
    parentStaticDrawCalls: number;
    sourceInstancedDrawCalls: number;
    parentInstancedDrawCalls: number;
    sourceTotalDrawCalls: number;
    parentTotalDrawCalls: number;
    totalDrawCallReductionPct: number;
    multiMaterialGroupsBefore: number;
    multiMaterialGroupsAfter: number;
    sourceNonGroundTriangles: number;
    parentNonGroundTriangles: number;
    nonGroundTriangleDelta: number;
    sourceGroundTriangles: number;
    parentGroundTriangles: number;
    sourceInstancedTrianglesLod0: number;
    parentInstancedTrianglesLod0: number;
    sourceStoredHeaderTriangles: number;
    sourceBufferDerivedTotalTriangles: number;
    legacyStoredHeaderDiscrepancyTriangles: number;
    sourceTotalInstances: number;
    parentTotalInstances: number;
    instanceCountDelta: number;
    mixedIndexPromotions: number;
  };
  storage: {
    sourceRawBytes: number;
    sourceCompressedBytes: number;
    parentRawBytes: number;
    parentCompressedBytes: number;
    compressedSizeDeltaPct: number;
  };
  performance: {
    elapsedMs: number;
    peakRssMiB: number;
  };
  verification: {
    performed: boolean;
    passed: boolean;
    verifiedShards: number;
  };
}

function chooseBalancedDivisor(total: number, preferredMax: number): number {
  if (total <= preferredMax) return total;
  for (let d = preferredMax; d >= 2; d--) {
    if (total % d === 0) return d;
  }
  // Prime dimension > preferredMax (e.g., 13 or 11): use single shard along that axis
  return total;
}

class BoundedSourceShardCache {
  private readonly readers = new Map<string, TilePackSqliteStore>();
  private readonly accessOrder: string[] = [];

  constructor(
    private readonly fileByShardId: Map<string, string>,
    private readonly maxOpen: number,
    private readonly openOpts: {
      expectedSnapshotId: string;
      expectedSourceSha256: string;
      allowCustomSnapshot: boolean;
    }
  ) {}

  get(shardId: string): TilePackSqliteStore {
    const existing = this.readers.get(shardId);
    if (existing) {
      const idx = this.accessOrder.indexOf(shardId);
      if (idx >= 0) {
        this.accessOrder.splice(idx, 1);
        this.accessOrder.push(shardId);
      }
      return existing;
    }

    const filePath = this.fileByShardId.get(shardId);
    if (!filePath) {
      throw new Error(`Unknown source shard "${shardId}"`);
    }

    while (this.readers.size >= this.maxOpen && this.accessOrder.length > 0) {
      const oldest = this.accessOrder.shift()!;
      const reader = this.readers.get(oldest);
      if (reader) {
        reader.close();
        this.readers.delete(oldest);
      }
    }

    const opened = new TilePackSqliteStore(filePath, {
      expectedSnapshotId: this.openOpts.expectedSnapshotId,
      expectedSourceSha256: this.openOpts.expectedSourceSha256,
      allowCustomSnapshot: this.openOpts.allowCustomSnapshot,
      verifyTileCount: true,
    });
    this.readers.set(shardId, opened);
    this.accessOrder.push(shardId);
    return opened;
  }

  closeAll(): void {
    for (const reader of this.readers.values()) {
      try {
        reader.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    this.readers.clear();
    this.accessOrder.length = 0;
  }
}

/**
 * Consolidates an existing baked OSMTILE1 regional mosaic into larger spatial
 * rendering batches (e.g. 2,048 m or 4,096 m) strictly offline, without invoking
 * GeometryBuilder, rebaking OSM data, or mutating the source mosaic.
 */
export function consolidateRegionalMosaic(
  options: ConsolidateRegionalMosaicOptions
): ConsolidationMosaicReport {
  const tStart = performance.now();
  let peakRssBytes = process.memoryUsage().rss;
  const sampleRss = () => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) peakRssBytes = rss;
    return rss;
  };

  const resolvedSourceIndex = path.resolve(options.sourceIndexPath);
  const resolvedSourceDir = path.dirname(resolvedSourceIndex);
  const resolvedOutputDir = path.resolve(options.outputDir);

  if (
    resolvedOutputDir === resolvedSourceDir ||
    resolvedOutputDir.startsWith(resolvedSourceDir + path.sep) ||
    resolvedSourceDir.startsWith(resolvedOutputDir + path.sep)
  ) {
    throw new Error(
      `Refusing to write consolidated mosaic into source directory or nested/parent overlap: source="${resolvedSourceDir}", output="${resolvedOutputDir}"`
    );
  }

  if (!fs.existsSync(resolvedSourceIndex)) {
    throw new Error(`Source mosaic index not found: ${resolvedSourceIndex}`);
  }

  const sourceIndex = JSON.parse(
    fs.readFileSync(resolvedSourceIndex, 'utf8')
  ) as RegionalMosaicIndex;

  if (sourceIndex.schemaVersion !== 1 || !sourceIndex.config || !Array.isArray(sourceIndex.shards)) {
    throw new Error(`Invalid regional mosaic index format: ${resolvedSourceIndex}`);
  }

  const sourceTileSize = sourceIndex.config.tileSizeMeters;
  const targetTileSize = options.targetTileSizeMeters;
  if (
    !Number.isSafeInteger(targetTileSize) ||
    targetTileSize <= sourceTileSize ||
    targetTileSize % sourceTileSize !== 0
  ) {
    throw new Error(
      `targetTileSizeMeters (${targetTileSize}) must be an integer multiple >= 2 of source tileSizeMeters (${sourceTileSize})`
    );
  }
  const factor = targetTileSize / sourceTileSize;

  const policy: TileConsolidationPolicy = {
    foliageBatchMode:
      options.policy?.foliageBatchMode ?? DEFAULT_TILE_CONSOLIDATION_POLICY.foliageBatchMode,
    sleeperBatchMode:
      options.policy?.sleeperBatchMode ?? DEFAULT_TILE_CONSOLIDATION_POLICY.sleeperBatchMode,
    includeBvh: options.policy?.includeBvh ?? DEFAULT_TILE_CONSOLIDATION_POLICY.includeBvh,
  };

  const sourcePlan = createRegionalMosaicPlan(sourceIndex.config);
  const fileBySourceShardId = new Map<string, string>();
  const packInputs: RegionalMosaicPackInput[] = [];
  let sourceRawBytes = 0;
  let sourceCompressedBytes = 0;

  for (const shardRef of sourceIndex.shards) {
    const filePath = path.resolve(resolvedSourceDir, shardRef.file);
    fileBySourceShardId.set(shardRef.id, filePath);
    const reader = new TilePackSqliteStore(filePath, {
      expectedSnapshotId: sourceIndex.snapshotId,
      expectedSourceSha256: sourceIndex.sourceSha256,
      allowCustomSnapshot: Boolean(options.allowCustomSnapshot),
      verifyTileCount: true,
    });
    try {
      const metadata = reader.getMetadata();
      const tiles = reader.listManifestEntries();
      for (const t of tiles) {
        sourceRawBytes += t.rawBytes;
        sourceCompressedBytes += t.compressedBytes;
      }
      packInputs.push({ id: shardRef.id, metadata, tiles });
    } finally {
      reader.close();
    }
  }

  const composedSource = composeRegionalMosaicManifest(sourcePlan, packInputs);
  const sourceMeta = composedSource.metadata;
  const sourceTileByCoord = new Map<string, TileManifestEntry>();
  let sourceNonEmptyTiles = 0;

  for (const tile of composedSource.tiles) {
    sourceTileByCoord.set(`${tile.tx}:${tile.ty}`, tile);
    if (!tile.isEmpty) sourceNonEmptyTiles++;
  }

  // Derive exact UTM-aligned parent grid covering the entire source extent
  const sourceBounds = sourcePlan.grid.studyUtmBounds;
  const parentMinTx = Math.floor(sourceBounds.minEasting / targetTileSize);
  const parentMaxTx = Math.ceil(sourceBounds.maxEasting / targetTileSize) - 1;
  const parentMinTy = Math.floor(sourceBounds.minNorthing / targetTileSize);
  const parentMaxTy = Math.ceil(sourceBounds.maxNorthing / targetTileSize) - 1;

  const parentCols = parentMaxTx - parentMinTx + 1;
  const parentRows = parentMaxTy - parentMinTy + 1;
  const parentCenterE = ((parentMinTx + parentMaxTx + 1) * targetTileSize) / 2;
  const parentCenterN = ((parentMinTy + parentMaxTy + 1) * targetTileSize) / 2;
  const parentCenterLonLat = utm32NToGeo(parentCenterE, parentCenterN);

  const shardCols = options.shardCols ?? chooseBalancedDivisor(parentCols, 8);
  const shardRows = options.shardRows ?? chooseBalancedDivisor(parentRows, 8);
  if (parentCols % shardCols !== 0 || parentRows % shardRows !== 0) {
    throw new Error(
      `Parent shard dimensions (${shardCols}×${shardRows}) must evenly divide parent grid (${parentCols}×${parentRows})`
    );
  }

  const outputMosaicName =
    options.mosaicName?.trim() || `${sourceIndex.config.name}-batched-${targetTileSize}m`;

  const parentConfig: RegionalMosaicConfig = {
    name: outputMosaicName,
    centerLonLat: parentCenterLonLat,
    cols: parentCols,
    rows: parentRows,
    tileSizeMeters: targetTileSize,
    shardDimension: Math.max(shardCols, shardRows),
    shardCols,
    shardRows,
    collarMeters: sourceIndex.config.collarMeters,
    contextMarginMeters: sourceIndex.config.contextMarginMeters,
  };

  const parentPlan = createRegionalMosaicPlan(parentConfig);
  if (
    parentPlan.grid.minTx !== parentMinTx ||
    parentPlan.grid.maxTx !== parentMaxTx ||
    parentPlan.grid.minTy !== parentMinTy ||
    parentPlan.grid.maxTy !== parentMaxTy
  ) {
    throw new Error(
      `Parent grid UTM alignment mismatch: expected tx=[${parentMinTx}..${parentMaxTx}] ty=[${parentMinTy}..${parentMaxTy}], got tx=[${parentPlan.grid.minTx}..${parentPlan.grid.maxTx}] ty=[${parentPlan.grid.minTy}..${parentPlan.grid.maxTy}]`
    );
  }

  fs.mkdirSync(resolvedOutputDir, { recursive: true });
  const shardsDir = path.join(resolvedOutputDir, 'shards');
  fs.mkdirSync(shardsDir, { recursive: true });

  const parentLodPolicyHash = computeLodPolicyHash({
    projectionId: sourceMeta.projectionId,
    tileSizeMeters: targetTileSize,
    collarMeters: parentConfig.collarMeters,
    lod: 0,
    includeBvh: policy.includeBvh,
  });

  const sourceShardCache = new BoundedSourceShardCache(
    fileBySourceShardId,
    Math.max(1, options.maxOpenSourceShards ?? 8),
    {
      expectedSnapshotId: sourceIndex.snapshotId,
      expectedSourceSha256: sourceIndex.sourceSha256,
      allowCustomSnapshot: Boolean(options.allowCustomSnapshot),
    }
  );

  // Aggregate geometry & storage audit counters
  let totalParentTilesDone = 0;
  const totalParentTiles = parentCols * parentRows;
  let parentNonEmptyTiles = 0;
  let parentPartialCoverageTiles = 0;
  let totalSourceStaticMeshes = 0;
  let totalParentStaticMeshes = 0;
  let totalSourceInstancedBatches = 0;
  let totalParentInstancedBatches = 0;
  let totalSourceStaticDrawCalls = 0;
  let totalParentStaticDrawCalls = 0;
  let totalSourceInstancedDrawCalls = 0;
  let totalParentInstancedDrawCalls = 0;
  let totalMultiMaterialGroupsBefore = 0;
  let totalMultiMaterialGroupsAfter = 0;
  let totalSourceNonGroundTriangles = 0;
  let totalParentNonGroundTriangles = 0;
  let totalSourceGroundTriangles = 0;
  let totalParentGroundTriangles = 0;
  let totalSourceInstancedTrianglesLod0 = 0;
  let totalParentInstancedTrianglesLod0 = 0;
  let totalSourceStoredHeaderTriangles = 0;
  let totalSourceInstances = 0;
  let totalParentInstances = 0;
  let totalMixedIndexPromotions = 0;
  let parentRawBytes = 0;
  let parentCompressedBytes = 0;

  const outputShardRefs: Array<{ id: string; file: string }> = [];
  const createdAtIso = new Date().toISOString();

  try {
    for (const shard of parentPlan.shards) {
      const shardRelFile = `shards/${shard.id}.sqlite`;
      const shardAbsPath = path.join(resolvedOutputDir, shardRelFile);
      const shardOrigin = shard.grid.projection;

      const shardMetaInit: Omit<TilePackMetadata, 'bakeStatus' | 'completedAtIso'> = {
        snapshotId: sourceMeta.snapshotId,
        sourceSha256: sourceMeta.sourceSha256,
        projectionId: sourceMeta.projectionId,
        bakeSchemaVersion: sourceMeta.bakeSchemaVersion,
        lodPolicyHash: parentLodPolicyHash,
        compression: sourceMeta.compression,
        tileSizeMeters: targetTileSize,
        collarMeters: parentConfig.collarMeters,
        studyOriginEasting: shardOrigin.originEasting,
        studyOriginNorthing: shardOrigin.originNorthing,
        gridCols: shard.grid.cols,
        gridRows: shard.grid.rows,
        minTx: shard.grid.minTx,
        maxTx: shard.grid.maxTx,
        minTy: shard.grid.minTy,
        maxTy: shard.grid.maxTy,
        createdAtIso,
      };

      const writer = new TilePackSqliteWriter(shardAbsPath, shardMetaInit);
      try {
        for (const parentTile of shard.grid.tiles) {
          const childStartTx = parentTile.tx * factor;
          const childStartTy = parentTile.ty * factor;
          const childInputs: ChildTileConsolidationInput[] = [];
          let availableChildCount = 0;

          for (let cy = 0; cy < factor; cy++) {
            for (let cx = 0; cx < factor; cx++) {
              const ctx = childStartTx + cx;
              const cty = childStartTy + cy;
              const childManifest = sourceTileByCoord.get(`${ctx}:${cty}`);
              if (!childManifest) continue;
              availableChildCount++;

              const ownerShardId = composedSource.ownerByTileKey.get(`0:${ctx}:${cty}`);
              if (!ownerShardId) {
                throw new Error(`Missing source shard owner for child tile 0:${ctx}:${cty}`);
              }
              const reader = sourceShardCache.get(ownerShardId);
              const decoded = reader.getTileDecoded(0, ctx, cty);
              if (!decoded) {
                throw new Error(
                  `Missing decoded payload for source tile 0:${ctx}:${cty} in shard ${ownerShardId}`
                );
              }
              childInputs.push({
                payload: decoded,
                childCenterEasting: (childManifest.minEasting + childManifest.maxEasting) * 0.5,
                childCenterNorthing: (childManifest.minNorthing + childManifest.maxNorthing) * 0.5,
                tx: ctx,
                ty: cty,
              });
            }
          }

          if (availableChildCount > 0 && availableChildCount < factor * factor) {
            parentPartialCoverageTiles++;
          }

          const parentCenterEasting =
            (parentTile.utmBounds.minEasting + parentTile.utmBounds.maxEasting) * 0.5;
          const parentCenterNorthing =
            (parentTile.utmBounds.minNorthing + parentTile.utmBounds.maxNorthing) * 0.5;
          const shardTileCenterX =
            (parentTile.localBounds.minX + parentTile.localBounds.maxX) * 0.5;
          const shardTileCenterZ =
            (parentTile.localBounds.minZ + parentTile.localBounds.maxZ) * 0.5;

          const consolidated = consolidateChildTilePayloads(
            childInputs,
            {
              lod: 0,
              tx: parentTile.tx,
              ty: parentTile.ty,
              tileSizeMeters: targetTileSize,
              parentCenterEasting,
              parentCenterNorthing,
              tileCenterX: shardTileCenterX,
              tileCenterZ: shardTileCenterZ,
            },
            policy
          );

          const rawBytes = encodeDecodedTilePayloadToBinary(consolidated.payload);
          const compressedPayload = deflateTilePayload(rawBytes);
          const contentHash = sha256Hex(compressedPayload);

          const hdr = consolidated.payload;
          const manifestEntry: TileManifestEntry = {
            lod: 0,
            tx: parentTile.tx,
            ty: parentTile.ty,
            minEasting: parentTile.utmBounds.minEasting,
            maxEasting: parentTile.utmBounds.maxEasting,
            minNorthing: parentTile.utmBounds.minNorthing,
            maxNorthing: parentTile.utmBounds.maxNorthing,
            tileCenterX: shardTileCenterX,
            tileCenterZ: shardTileCenterZ,
            overhangMinX: hdr.overhangBoundsMin[0],
            overhangMaxX: hdr.overhangBoundsMax[0],
            overhangMinY: hdr.overhangBoundsMin[1],
            overhangMaxY: hdr.overhangBoundsMax[1],
            overhangMinZ: hdr.overhangBoundsMin[2],
            overhangMaxZ: hdr.overhangBoundsMax[2],
            triCount: hdr.totalTriangles,
            vertexCount: hdr.totalVertices,
            featureCount: hdr.renderedFeaturesCount,
            isEmpty: consolidated.isEmpty,
            hasBvh: consolidated.payload.meshes.some((m) => m.bvh !== null),
            rawBytes: rawBytes.byteLength,
            compressedBytes: compressedPayload.byteLength,
            contentHash,
          };

          writer.writeTileBatch([{ manifest: manifestEntry, compressedPayload }]);

          // Accumulate audits
          const a = consolidated.audit;
          if (!consolidated.isEmpty) parentNonEmptyTiles++;
          totalSourceStaticMeshes += a.sourceStaticMeshes;
          totalParentStaticMeshes += a.parentStaticMeshes;
          totalSourceInstancedBatches += a.sourceInstancedBatches;
          totalParentInstancedBatches += a.parentInstancedBatches;
          totalSourceStaticDrawCalls += a.sourceStaticDrawCalls;
          totalParentStaticDrawCalls += a.parentStaticDrawCalls;
          totalSourceInstancedDrawCalls += a.sourceInstancedDrawCalls;
          totalParentInstancedDrawCalls += a.parentInstancedDrawCalls;
          totalMultiMaterialGroupsBefore += a.multiMaterialGroupsBefore;
          totalMultiMaterialGroupsAfter += a.multiMaterialGroupsAfter;
          totalSourceNonGroundTriangles += a.sourceNonGroundTriangles;
          totalParentNonGroundTriangles += a.parentNonGroundTriangles;
          totalSourceGroundTriangles += a.sourceGroundTriangles;
          totalParentGroundTriangles += a.parentGroundTriangles;
          totalSourceInstancedTrianglesLod0 += a.sourceInstancedTrianglesLod0;
          totalParentInstancedTrianglesLod0 += a.parentInstancedTrianglesLod0;
          totalSourceStoredHeaderTriangles += a.sourceStoredHeaderTriangles;
          totalSourceInstances += a.sourceTotalInstances;
          totalParentInstances += a.parentTotalInstances;
          totalMixedIndexPromotions += a.mixedIndexPromotions;
          parentRawBytes += rawBytes.byteLength;
          parentCompressedBytes += compressedPayload.byteLength;

          totalParentTilesDone++;
          const rssBytes = sampleRss();
          options.onProgress?.({
            completedParentTiles: totalParentTilesDone,
            totalParentTiles,
            shardId: shard.id,
            tx: parentTile.tx,
            ty: parentTile.ty,
            rssMiB: Number((rssBytes / (1024 * 1024)).toFixed(2)),
          });
        }

        writer.finalize(new Date().toISOString());
        outputShardRefs.push({ id: shard.id, file: shardRelFile });
      } catch (err) {
        writer.abort();
        throw err;
      }
    }
  } finally {
    sourceShardCache.closeAll();
  }

  const consolidatedAtIso = new Date().toISOString();
  const outputIndex: RegionalMosaicIndex = {
    schemaVersion: 1,
    config: parentConfig,
    snapshotId: sourceIndex.snapshotId,
    sourceSha256: sourceIndex.sourceSha256,
    shards: outputShardRefs,
    consolidation: {
      consolidatedFromTileSizeMeters: sourceTileSize,
      targetTileSizeMeters: targetTileSize,
      consolidationFactor: factor,
      sourceMosaicName: sourceIndex.config.name,
      sourceTileCount: composedSource.tiles.length,
      sourceNonEmptyTileCount: sourceNonEmptyTiles,
      foliageBatchMode: formatSpatialSubBatchPolicy(policy.foliageBatchMode),
      sleeperBatchMode: formatSpatialSubBatchPolicy(policy.sleeperBatchMode),
      consolidatedAtIso,
      toolVersion: OFFLINE_TILE_CONSOLIDATOR_VERSION,
    },
  };

  const outputIndexPath = path.join(resolvedOutputDir, 'mosaic.json');
  const tempIndexPath = `${outputIndexPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempIndexPath, `${JSON.stringify(outputIndex, null, 2)}\n`, 'utf8');
  fs.renameSync(tempIndexPath, outputIndexPath);

  let verifiedShards = 0;
  let verificationPassed = false;
  const performVerify = options.verifyOutput !== false;
  if (performVerify) {
    const outPackInputs: RegionalMosaicPackInput[] = [];
    for (const shardRef of outputShardRefs) {
      const shardFile = path.join(resolvedOutputDir, shardRef.file);
      const reader = new TilePackSqliteStore(shardFile, {
        expectedSnapshotId: sourceIndex.snapshotId,
        expectedSourceSha256: sourceIndex.sourceSha256,
        expectedLodPolicyHash: parentLodPolicyHash,
        allowCustomSnapshot: Boolean(options.allowCustomSnapshot),
        verifyTileCount: true,
      });
      try {
        const meta = reader.getMetadata();
        const tiles = reader.listManifestEntries();
        for (const t of tiles) {
          const decoded = reader.getTileDecoded(t.lod, t.tx, t.ty);
          if (!decoded) {
            throw new Error(
              `Consolidated shard ${shardRef.id} missing decoded payload for tile ${t.lod}:${t.tx}:${t.ty}`
            );
          }
          if (decoded.tx !== t.tx || decoded.ty !== t.ty) {
            throw new Error(
              `Consolidated shard ${shardRef.id} header coordinate mismatch for tile ${t.lod}:${t.tx}:${t.ty}`
            );
          }
        }
        outPackInputs.push({
          id: shardRef.id,
          metadata: meta,
          tiles,
        });
        verifiedShards++;
      } finally {
        reader.close();
      }
    }
    composeRegionalMosaicManifest(parentPlan, outPackInputs);
    verificationPassed = true;
  }

  const elapsedMs = Number((performance.now() - tStart).toFixed(2));
  sampleRss();
  const peakRssMiB = Number((peakRssBytes / (1024 * 1024)).toFixed(2));

  const sourceTotalDrawCalls = totalSourceStaticDrawCalls + totalSourceInstancedDrawCalls;
  const parentTotalDrawCalls = totalParentStaticDrawCalls + totalParentInstancedDrawCalls;
  const sourceBufferDerivedTotalTriangles =
    totalSourceNonGroundTriangles +
    totalSourceGroundTriangles +
    totalSourceInstancedTrianglesLod0;

  const report: ConsolidationMosaicReport = {
    toolVersion: OFFLINE_TILE_CONSOLIDATOR_VERSION,
    consolidatedAtIso,
    sourceIndexPath: resolvedSourceIndex,
    outputIndexPath,
    sourceMosaicName: sourceIndex.config.name,
    outputMosaicName,
    snapshotId: sourceIndex.snapshotId,
    sourceSha256: sourceIndex.sourceSha256,
    sourceTileSizeMeters: sourceTileSize,
    targetTileSizeMeters: targetTileSize,
    consolidationFactor: factor,
    policy: {
      foliageBatchMode: formatSpatialSubBatchPolicy(policy.foliageBatchMode),
      sleeperBatchMode: formatSpatialSubBatchPolicy(policy.sleeperBatchMode),
      includeBvh: policy.includeBvh,
    },
    grid: {
      sourceCols: sourceIndex.config.cols,
      sourceRows: sourceIndex.config.rows,
      sourceTotalTiles: composedSource.tiles.length,
      sourceNonEmptyTiles,
      parentCols,
      parentRows,
      parentTotalTiles: totalParentTiles,
      parentNonEmptyTiles,
      parentPartialCoverageTiles,
      parentShardCols: shardCols,
      parentShardRows: shardRows,
      parentShardCount: outputShardRefs.length,
    },
    geometryAudit: {
      sourceStaticMeshes: totalSourceStaticMeshes,
      parentStaticMeshes: totalParentStaticMeshes,
      staticMeshReductionPct:
        totalSourceStaticMeshes > 0
          ? Number(
              (
                ((totalSourceStaticMeshes - totalParentStaticMeshes) /
                  totalSourceStaticMeshes) *
                100
              ).toFixed(2)
            )
          : 0,
      sourceInstancedBatches: totalSourceInstancedBatches,
      parentInstancedBatches: totalParentInstancedBatches,
      sourceStaticDrawCalls: totalSourceStaticDrawCalls,
      parentStaticDrawCalls: totalParentStaticDrawCalls,
      sourceInstancedDrawCalls: totalSourceInstancedDrawCalls,
      parentInstancedDrawCalls: totalParentInstancedDrawCalls,
      sourceTotalDrawCalls,
      parentTotalDrawCalls,
      totalDrawCallReductionPct:
        sourceTotalDrawCalls > 0
          ? Number(
              (
                ((sourceTotalDrawCalls - parentTotalDrawCalls) / sourceTotalDrawCalls) *
                100
              ).toFixed(2)
            )
          : 0,
      multiMaterialGroupsBefore: totalMultiMaterialGroupsBefore,
      multiMaterialGroupsAfter: totalMultiMaterialGroupsAfter,
      sourceNonGroundTriangles: totalSourceNonGroundTriangles,
      parentNonGroundTriangles: totalParentNonGroundTriangles,
      nonGroundTriangleDelta:
        totalParentNonGroundTriangles - totalSourceNonGroundTriangles,
      sourceGroundTriangles: totalSourceGroundTriangles,
      parentGroundTriangles: totalParentGroundTriangles,
      sourceInstancedTrianglesLod0: totalSourceInstancedTrianglesLod0,
      parentInstancedTrianglesLod0: totalParentInstancedTrianglesLod0,
      sourceStoredHeaderTriangles: totalSourceStoredHeaderTriangles,
      sourceBufferDerivedTotalTriangles,
      legacyStoredHeaderDiscrepancyTriangles:
        sourceBufferDerivedTotalTriangles - totalSourceStoredHeaderTriangles,
      sourceTotalInstances: totalSourceInstances,
      parentTotalInstances: totalParentInstances,
      instanceCountDelta: totalParentInstances - totalSourceInstances,
      mixedIndexPromotions: totalMixedIndexPromotions,
    },
    storage: {
      sourceRawBytes,
      sourceCompressedBytes,
      parentRawBytes,
      parentCompressedBytes,
      compressedSizeDeltaPct:
        sourceCompressedBytes > 0
          ? Number(
              (
                ((parentCompressedBytes - sourceCompressedBytes) /
                  sourceCompressedBytes) *
                100
              ).toFixed(2)
            )
          : 0,
    },
    performance: {
      elapsedMs,
      peakRssMiB,
    },
    verification: {
      performed: performVerify,
      passed: verificationPassed,
      verifiedShards,
    },
  };

  const reportPath = path.join(resolvedOutputDir, 'consolidation-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return report;
}
