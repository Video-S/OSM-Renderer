import fs from 'node:fs';
import { MAP_THEMES } from '../../styles/mapThemes';
import type { MapStyleTheme } from '../../types/MapFeature';
import {
  GeometryBuilder,
  type BuiltSceneGeometry,
} from '../../world/GeometryBuilder';
import type { InfrastructureRenderPreviewResult } from '../../world/infrastructure/rendering/InfrastructureRenderAdapter';
import { encodeBuiltTileToBinary } from '../../world/tiling/TileBinaryCodec';
import {
  DEFAULT_COLLAR_METERS,
  DEFAULT_TILE_SIZE_METERS,
  createHengeloStudyGrid,
  utmBoundsToGeoBounds,
  type StudyGridSpec,
  type TileDescriptor,
} from '../../world/tiling/TileGrid';
import {
  BAKE_SCHEMA_VERSION,
  CANONICAL_HENGELO_SNAPSHOT_ID,
  DEFAULT_PROJECTION_ID,
  computeLodPolicyHash,
  type TileManifestEntry,
} from '../../world/tiling/TilePackContract';
import {
  captureProcessMemorySnapshot,
  ingestCanonicalStudyGeoJson,
  mergeProcessMemoryPeak,
  sliceStudyInputsForTile,
  type IngestedStudyRegion,
  type ProcessMemorySnapshot,
} from '../../world/tiling/TiledStudyPipeline';
import {
  OverijsselOsmStore,
  type OverijsselSnapshotMetadata,
} from '../osm/OverijsselOsmStore';
import {
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  resolveOverijsselIndexPath,
} from '../osm/overijsselConfig';
import { deflateTilePayload, sha256Hex } from './TileCompression';
import {
  TilePackSqliteWriter,
  resolveDefaultTilePackPath,
  resolveTilePackPathForTileSize,
  type TileWriteBatchItem,
} from './TilePackSqliteStore';

export interface TileBakeMacroBlockSummary {
  blockRow: number;
  blockCol: number;
  tileCount: number;
  nonEmptyTileCount: number;
  rawBytes: number;
  compressedBytes: number;
  bakeAndEncodeMs: number;
  sqliteCommitMs: number;
}

export interface TileBakeReport {
  generatedAtIso: string;
  outPath: string;
  dbSizeBytes: number;
  snapshotId: string;
  sourceSha256: string;
  projectionId: string;
  bakeSchemaVersion: string;
  lodPolicyHash: string;
  lod: number;
  includeBvh: boolean;
  batchDimension: number;
  grid: {
    name: string;
    cols: number;
    rows: number;
    tileSizeMeters: number;
    collarMeters: number;
    minTx: number;
    maxTx: number;
    minTy: number;
    maxTy: number;
  };
  tileCounts: {
    totalTiles: number;
    nonEmptyTiles: number;
    emptyTiles: number;
    totalTriangles: number;
    totalVertices: number;
    totalFeatures: number;
  };
  sizeStats: {
    totalRawBytes: number;
    totalCompressedBytes: number;
    compressionRatio: number;
    avgRawBytesPerTile: number;
    avgCompressedBytesPerTile: number;
    maxRawBytesTile: { id: string; bytes: number };
    maxCompressedBytesTile: { id: string; bytes: number };
  };
  timingsMs: {
    sqliteQueryMs: number;
    ingestMs: number;
    tileSynthesisAndEncodeMs: number;
    compressionMs: number;
    sqliteWriteMs: number;
    tileBakePhaseMs: number;
    totalEndToEndMs: number;
    totalBakeMs: number;
    avgTileSynthAndEncodeMs: number;
    avgTileBakeMs: number;
    maxTileBakeMs: number;
  };
  memoryMB: {
    afterIngest: ProcessMemorySnapshot;
    peakDuringBake: ProcessMemorySnapshot;
    afterFinalize: ProcessMemorySnapshot;
  };
  macroBlocks: TileBakeMacroBlockSummary[];
}

export interface BakeStudyRegionOptions {
  ingested: IngestedStudyRegion;
  outPath: string;
  snapshotId: string;
  sourceSha256: string;
  lod?: number;
  includeBvh?: boolean;
  batchDimension?: number;
  theme?: MapStyleTheme;
  initialCameraZoom?: number;
  maxSceneTreesPerTile?: number;
  sqliteQueryMs?: number;
  endToEndStartMs?: number;
}

export interface BakeHengeloFromStoreOptions {
  indexPath?: string;
  expectedSha256?: string;
  outPath?: string;
  tileSizeMeters?: number;
  collarMeters?: number;
  batchDimension?: number;
  includeBvh?: boolean;
  maxSceneTreesPerTile?: number;
  /** Optional pre-aligned shard grid, instead of the fixed 4km Hengelo study. */
  grid?: StudyGridSpec;
  /** Additional OSM query context around shard bounds, in meters. */
  queryContextMarginMeters?: number;
  /** Optional caller-owned OverijsselOsmStore reused across multiple shards. */
  store?: OverijsselOsmStore;
}

export function disposeIngestedStudyRegionPlans(ingested: IngestedStudyRegion): void {
  const unclipped = ingested.precomputedGlobalPlans.planarResolution?.unclippedGeometriesById;
  if (unclipped) {
    for (const geo of unclipped.values()) {
      geo.dispose();
    }
    unclipped.clear();
  }
  const roadPlan = ingested.precomputedGlobalPlans.atGradeRoadPlan;
  if (roadPlan) {
    roadPlan.roadsByClass.forEach((items) => {
      for (const item of items) {
        item.geom.dispose();
      }
    });
  }
}

function readOverhangFromHeader(rawBytes: Uint8Array): {
  min: [number, number, number];
  max: [number, number, number];
  tileCenterX: number;
  tileCenterZ: number;
} {
  const dv = new DataView(rawBytes.buffer, rawBytes.byteOffset, 112);
  return {
    tileCenterX: dv.getFloat64(64, true),
    tileCenterZ: dv.getFloat64(72, true),
    min: [dv.getFloat32(88, true), dv.getFloat32(92, true), dv.getFloat32(96, true)],
    max: [dv.getFloat32(100, true), dv.getFloat32(104, true), dv.getFloat32(108, true)],
  };
}

function partitionTilesIntoMacroBlocks(
  grid: StudyGridSpec,
  batchDimension: number
): Array<{ blockRow: number; blockCol: number; tiles: TileDescriptor[] }> {
  const safeDim = Math.max(1, Math.floor(batchDimension));
  const blockCols = Math.ceil(grid.cols / safeDim);
  const blockRows = Math.ceil(grid.rows / safeDim);
  const byBlock = new Map<string, TileDescriptor[]>();

  for (const tile of grid.tiles) {
    const br = Math.floor(tile.gridRow / safeDim);
    const bc = Math.floor(tile.gridCol / safeDim);
    const key = `${br}:${bc}`;
    let list = byBlock.get(key);
    if (!list) {
      list = [];
      byBlock.set(key, list);
    }
    list.push(tile);
  }

  const blocks: Array<{ blockRow: number; blockCol: number; tiles: TileDescriptor[] }> = [];
  for (let br = 0; br < blockRows; br++) {
    for (let bc = 0; bc < blockCols; bc++) {
      const list = byBlock.get(`${br}:${bc}`);
      if (list && list.length > 0) {
        blocks.push({ blockRow: br, blockCol: bc, tiles: list });
      }
    }
  }
  return blocks;
}

export function bakeStudyRegionTilesToSqlite(options: BakeStudyRegionOptions): TileBakeReport {
  const tBakePhase0 = performance.now();
  const {
    ingested,
    outPath,
    snapshotId,
    sourceSha256,
    lod = 0,
    includeBvh = true,
    batchDimension = 4,
    theme = MAP_THEMES.tactical,
    initialCameraZoom = 1.0,
    maxSceneTreesPerTile = 50000,
  } = options;

  const { grid } = ingested;
  const projectionId = DEFAULT_PROJECTION_ID;
  const lodPolicyHash = computeLodPolicyHash({
    projectionId,
    tileSizeMeters: grid.tileSizeMeters,
    collarMeters: grid.collarMeters,
    lod,
    includeBvh,
  });

  const [originEasting, originNorthing] = grid.projection.localToUtm(0, 0);
  const createdAtIso = new Date().toISOString();

  const writer = new TilePackSqliteWriter(outPath, {
    snapshotId,
    sourceSha256: sourceSha256.toLowerCase(),
    projectionId,
    bakeSchemaVersion: BAKE_SCHEMA_VERSION,
    lodPolicyHash,
    compression: 'deflate',
    tileSizeMeters: grid.tileSizeMeters,
    collarMeters: grid.collarMeters,
    studyOriginEasting: originEasting,
    studyOriginNorthing: originNorthing,
    gridCols: grid.cols,
    gridRows: grid.rows,
    minTx: grid.minTx,
    maxTx: grid.maxTx,
    minTy: grid.minTy,
    maxTy: grid.maxTy,
    createdAtIso,
  });

  let peakMemory = mergeProcessMemoryPeak(
    ingested.memoryAfterIngest,
    captureProcessMemorySnapshot()
  );

  let nonEmptyTiles = 0;
  let emptyTiles = 0;
  let totalTriangles = 0;
  let totalVertices = 0;
  let totalFeatures = 0;
  let totalRawBytes = 0;
  let totalCompressedBytes = 0;
  let maxRawBytesTile = { id: '', bytes: 0 };
  let maxCompressedBytesTile = { id: '', bytes: 0 };
  let tileSynthesisAndEncodeMs = 0;
  let compressionMs = 0;
  let sqliteWriteMs = 0;
  let maxTileBakeMs = 0;
  const macroBlocks: TileBakeMacroBlockSummary[] = [];

  try {
    const blocks = partitionTilesIntoMacroBlocks(grid, batchDimension);

    for (const block of blocks) {
      const tBlock0 = performance.now();
      const batchItems: TileWriteBatchItem[] = [];
      let blockNonEmpty = 0;
      let blockRawBytes = 0;
      let blockCompressedBytes = 0;
      let blockCompMs = 0;

      for (const tile of block.tiles) {
        const tTile0 = performance.now();
        const { tileData, tileDescriptors } = sliceStudyInputsForTile(ingested, tile);
        const preview: InfrastructureRenderPreviewResult | null = tileDescriptors
          ? {
              options: ingested.infrastructureRenderOptions,
              graph: ingested.previewMeta.graph,
              descriptors: tileDescriptors,
              validation: ingested.previewMeta.validation,
              timing: ingested.previewMeta.timing,
            }
          : null;

        const builder = new GeometryBuilder({
          initialCameraZoom,
          infrastructureRenderOptions: ingested.infrastructureRenderOptions,
          infrastructureRenderPreview: preview,
          tileClipBounds: tile.localBounds,
          maxSceneTrees: maxSceneTreesPerTile,
          precomputedGlobalPlans: ingested.precomputedGlobalPlans,
        });

        let scene: BuiltSceneGeometry | null = null;
        let rawBytes: Uint8Array;
        let statsSnapshot: BuiltSceneGeometry['stats'];

        try {
          scene = builder.buildScene(tileData, theme);
          statsSnapshot = { ...scene.stats };
          rawBytes = encodeBuiltTileToBinary({
            tile,
            scene,
            lod,
            includeBvh,
          });
        } finally {
          scene?.dispose();
          scene = null;
        }

        const headerInfo = readOverhangFromHeader(rawBytes);
        const tComp0 = performance.now();
        const compressedPayload = deflateTilePayload(rawBytes, 6);
        const contentHash = sha256Hex(compressedPayload);
        const tCompEnd = performance.now();
        const tileCompMs = tCompEnd - tComp0;
        compressionMs += tileCompMs;
        blockCompMs += tileCompMs;

        const isEmpty =
          statsSnapshot.renderedFeaturesCount === 0 && statsSnapshot.totalTriangles <= 2;
        if (isEmpty) {
          emptyTiles++;
        } else {
          nonEmptyTiles++;
          blockNonEmpty++;
        }

        totalTriangles += statsSnapshot.totalTriangles;
        totalVertices += statsSnapshot.totalVertices;
        totalFeatures += statsSnapshot.renderedFeaturesCount;
        totalRawBytes += rawBytes.byteLength;
        totalCompressedBytes += compressedPayload.byteLength;
        blockRawBytes += rawBytes.byteLength;
        blockCompressedBytes += compressedPayload.byteLength;

        if (rawBytes.byteLength > maxRawBytesTile.bytes) {
          maxRawBytesTile = { id: tile.id, bytes: rawBytes.byteLength };
        }
        if (compressedPayload.byteLength > maxCompressedBytesTile.bytes) {
          maxCompressedBytesTile = { id: tile.id, bytes: compressedPayload.byteLength };
        }

        const manifest: TileManifestEntry = {
          lod,
          tx: tile.tx,
          ty: tile.ty,
          minEasting: tile.utmBounds.minEasting,
          maxEasting: tile.utmBounds.maxEasting,
          minNorthing: tile.utmBounds.minNorthing,
          maxNorthing: tile.utmBounds.maxNorthing,
          tileCenterX: headerInfo.tileCenterX,
          tileCenterZ: headerInfo.tileCenterZ,
          overhangMinX: headerInfo.min[0],
          overhangMaxX: headerInfo.max[0],
          overhangMinY: headerInfo.min[1],
          overhangMaxY: headerInfo.max[1],
          overhangMinZ: headerInfo.min[2],
          overhangMaxZ: headerInfo.max[2],
          triCount: statsSnapshot.totalTriangles,
          vertexCount: statsSnapshot.totalVertices,
          featureCount: statsSnapshot.renderedFeaturesCount,
          isEmpty,
          hasBvh: includeBvh,
          rawBytes: rawBytes.byteLength,
          compressedBytes: compressedPayload.byteLength,
          contentHash,
        };

        batchItems.push({ manifest, compressedPayload });

        const tileElapsed = tCompEnd - tTile0;
        if (tileElapsed > maxTileBakeMs) {
          maxTileBakeMs = tileElapsed;
        }
      }

      const tEncodeEnd = performance.now();
      const blockTotalEncodeMs = tEncodeEnd - tBlock0;
      const blockPureSynthMs = Math.max(0, blockTotalEncodeMs - blockCompMs);
      tileSynthesisAndEncodeMs += blockPureSynthMs;

      const tSql0 = performance.now();
      writer.writeTileBatch(batchItems);
      const blockSqlMs = performance.now() - tSql0;
      sqliteWriteMs += blockSqlMs;

      peakMemory = mergeProcessMemoryPeak(peakMemory, captureProcessMemorySnapshot());

      macroBlocks.push({
        blockRow: block.blockRow,
        blockCol: block.blockCol,
        tileCount: block.tiles.length,
        nonEmptyTileCount: blockNonEmpty,
        rawBytes: blockRawBytes,
        compressedBytes: blockCompressedBytes,
        bakeAndEncodeMs: Number(blockPureSynthMs.toFixed(2)),
        sqliteCommitMs: Number(blockSqlMs.toFixed(2)),
      });
    }

    const tFin0 = performance.now();
    writer.finalize(new Date().toISOString());
    sqliteWriteMs += performance.now() - tFin0;
  } catch (err) {
    writer.abort();
    throw err;
  }

  const tDone = performance.now();
  const dbSizeBytes = fs.statSync(outPath).size;
  const tileBakePhaseMs = Number((tDone - tBakePhase0).toFixed(2));
  const sqliteQueryMs = Number((options.sqliteQueryMs ?? 0).toFixed(2));
  const ingestMs = Number(ingested.ingestTimeMs.toFixed(2));
  const totalEndToEndMs =
    typeof options.endToEndStartMs === 'number'
      ? Number(Math.max(tDone - options.endToEndStartMs, sqliteQueryMs + ingestMs + tileBakePhaseMs).toFixed(2))
      : Number((sqliteQueryMs + ingestMs + tileBakePhaseMs).toFixed(2));
  const tileCount = grid.tiles.length;
  const afterFinalize = captureProcessMemorySnapshot();
  peakMemory = mergeProcessMemoryPeak(peakMemory, afterFinalize);

  return {
    generatedAtIso: new Date().toISOString(),
    outPath,
    dbSizeBytes,
    snapshotId,
    sourceSha256: sourceSha256.toLowerCase(),
    projectionId,
    bakeSchemaVersion: BAKE_SCHEMA_VERSION,
    lodPolicyHash,
    lod,
    includeBvh,
    batchDimension,
    grid: {
      name: grid.name,
      cols: grid.cols,
      rows: grid.rows,
      tileSizeMeters: grid.tileSizeMeters,
      collarMeters: grid.collarMeters,
      minTx: grid.minTx,
      maxTx: grid.maxTx,
      minTy: grid.minTy,
      maxTy: grid.maxTy,
    },
    tileCounts: {
      totalTiles: tileCount,
      nonEmptyTiles,
      emptyTiles,
      totalTriangles,
      totalVertices,
      totalFeatures,
    },
    sizeStats: {
      totalRawBytes,
      totalCompressedBytes,
      compressionRatio:
        totalRawBytes > 0 ? Number((totalCompressedBytes / totalRawBytes).toFixed(4)) : 1,
      avgRawBytesPerTile: tileCount > 0 ? Math.round(totalRawBytes / tileCount) : 0,
      avgCompressedBytesPerTile: tileCount > 0 ? Math.round(totalCompressedBytes / tileCount) : 0,
      maxRawBytesTile,
      maxCompressedBytesTile,
    },
    timingsMs: {
      sqliteQueryMs,
      ingestMs,
      tileSynthesisAndEncodeMs: Number(tileSynthesisAndEncodeMs.toFixed(2)),
      compressionMs: Number(compressionMs.toFixed(2)),
      sqliteWriteMs: Number(sqliteWriteMs.toFixed(2)),
      tileBakePhaseMs,
      totalEndToEndMs,
      totalBakeMs: totalEndToEndMs,
      avgTileSynthAndEncodeMs:
        tileCount > 0 ? Number((tileSynthesisAndEncodeMs / tileCount).toFixed(2)) : 0,
      avgTileBakeMs: tileCount > 0 ? Number((tileBakePhaseMs / tileCount).toFixed(2)) : 0,
      maxTileBakeMs: Number(maxTileBakeMs.toFixed(2)),
    },
    memoryMB: {
      afterIngest: ingested.memoryAfterIngest,
      peakDuringBake: peakMemory,
      afterFinalize,
    },
    macroBlocks,
  };
}

export function bakeHengeloTilesFromStore(options: BakeHengeloFromStoreOptions = {}): {
  report: TileBakeReport;
  snapshotMetadata: OverijsselSnapshotMetadata;
  sqliteQueryTimings: {
    spatialQueryMs: number;
    osmtogeojsonMs: number;
    nodeIdEnrichMs: number;
  };
} {
  const tEndToEnd0 = performance.now();
  const indexPath = options.indexPath ?? resolveOverijsselIndexPath();
  const expectedSha256 = options.expectedSha256 ?? OVERIJSSEL_PBF_EXPECTED_SHA256;
  const tileSizeMeters = options.tileSizeMeters ?? DEFAULT_TILE_SIZE_METERS;
  const collarMeters = options.collarMeters ?? DEFAULT_COLLAR_METERS;
  const outPath = options.outPath ?? resolveTilePackPathForTileSize(tileSizeMeters);
  const batchDimension =
    options.batchDimension ?? Math.min(4, Math.max(1, Math.round(2048 / tileSizeMeters)));

  const grid = options.grid ?? createHengeloStudyGrid(tileSizeMeters, collarMeters);
  if (grid.tileSizeMeters !== tileSizeMeters || grid.collarMeters !== collarMeters) {
    throw new Error('Baker grid tile size/collar must match bake options');
  }
  const queryContextMarginMeters = options.queryContextMarginMeters ?? collarMeters;
  if (!Number.isFinite(queryContextMarginMeters) || queryContextMarginMeters < collarMeters) {
    throw new Error('Baker context margin must be finite and at least the collar width');
  }
  const b = grid.studyUtmBounds;
  const queryGeoBounds = queryContextMarginMeters === collarMeters
    ? grid.studyExpandedGeoBounds
    : utmBoundsToGeoBounds({
        minEasting: b.minEasting - queryContextMarginMeters,
        maxEasting: b.maxEasting + queryContextMarginMeters,
        minNorthing: b.minNorthing - queryContextMarginMeters,
        maxNorthing: b.maxNorthing + queryContextMarginMeters,
      });
  const ownsStore = !options.store;
  const store = options.store ?? new OverijsselOsmStore(indexPath, { expectedSha256 });
  let ingested: IngestedStudyRegion | null = null;

  try {
    const queryRes = store.queryBBox({
      ...queryGeoBounds,
      locationName: grid.name,
    });
    const sqliteQueryTotalMs =
      queryRes.timings.spatialQueryMs +
      queryRes.timings.osmtogeojsonMs +
      queryRes.timings.nodeIdEnrichMs;
    ingested = ingestCanonicalStudyGeoJson(queryRes.geojson, grid);

    const report = bakeStudyRegionTilesToSqlite({
      ingested,
      outPath,
      snapshotId: queryRes.snapshotMetadata.snapshotId || CANONICAL_HENGELO_SNAPSHOT_ID,
      sourceSha256: queryRes.snapshotMetadata.sourceSha256,
      lod: 0,
      includeBvh: options.includeBvh ?? true,
      batchDimension,
      maxSceneTreesPerTile: options.maxSceneTreesPerTile ?? 50000,
      sqliteQueryMs: sqliteQueryTotalMs,
      endToEndStartMs: tEndToEnd0,
    });

    return {
      report,
      snapshotMetadata: queryRes.snapshotMetadata,
      sqliteQueryTimings: queryRes.timings,
    };
  } finally {
    if (ingested) {
      disposeIngestedStudyRegionPlans(ingested);
    }
    if (ownsStore) {
      store.close();
    }
  }
}
