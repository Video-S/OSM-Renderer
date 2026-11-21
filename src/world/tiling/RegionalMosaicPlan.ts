import {
  createAlignedStudyGrid,
  utmBoundsToGeoBounds,
  type StudyGridSpec,
} from './TileGrid';
import { utm32NToGeo } from './RegionalProjection';
import type { TileManifestEntry, TilePackMetadata } from './TilePackContract';

export interface RegionalMosaicConfig {
  name: string;
  centerLonLat: [number, number];
  cols: number;
  rows: number;
  tileSizeMeters: number;
  shardDimension: number;
  collarMeters: number;
  /** Query context outside each bounded synthesis shard. This is NOT a substitute for global graph parity. */
  contextMarginMeters: number;
}

export const TWENTE_PILOT_CONFIG: RegionalMosaicConfig = {
  name: 'twente-hengelo-enschede-pilot',
  centerLonLat: [6.845, 52.25],
  cols: 16,
  rows: 16,
  tileSizeMeters: 1024,
  shardDimension: 4,
  collarMeters: 64,
  contextMarginMeters: 1024,
};

export interface RegionalMosaicShard {
  id: string;
  row: number;
  col: number;
  grid: StudyGridSpec;
}

export interface RegionalMosaicPlan {
  config: RegionalMosaicConfig;
  grid: StudyGridSpec;
  shards: RegionalMosaicShard[];
}

export interface RegionalMosaicIndex {
  schemaVersion: 1;
  config: RegionalMosaicConfig;
  snapshotId: string;
  sourceSha256: string;
  shards: Array<{ id: string; file: string }>;
}

function positiveInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Regional mosaic ${name} must be a positive safe integer, got ${value}`);
  }
}

/**
 * Tiles are laid out in one globally aligned UTM region but synthesized in
 * bounded and independently disposable study shards.
 *
 * The shard projection origin differs from the regional origin. The server
 * MUST rebase each shard's tile-center manifest offsets; the stream manager
 * MUST use those manifest offsets when reconstructing decoded shard payloads.
 */
export function createRegionalMosaicPlan(
  config: RegionalMosaicConfig = TWENTE_PILOT_CONFIG
): RegionalMosaicPlan {
  positiveInt(config.cols, 'cols');
  positiveInt(config.rows, 'rows');
  positiveInt(config.tileSizeMeters, 'tileSizeMeters');
  positiveInt(config.shardDimension, 'shardDimension');
  if (
    !Number.isFinite(config.collarMeters) || config.collarMeters < 0 ||
    !Number.isFinite(config.contextMarginMeters) ||
    config.contextMarginMeters < config.collarMeters
  ) {
    throw new Error('Regional mosaic requires finite contextMarginMeters >= collarMeters >= 0');
  }
  if (config.cols % config.shardDimension || config.rows % config.shardDimension) {
    throw new Error('Regional mosaic rows/cols must be multiples of shardDimension');
  }
  if (config.cols * config.rows > 10000) {
    throw new Error('Regional mosaic tile-count safety limit exceeded (10,000)');
  }

  const grid = createAlignedStudyGrid({
    name: config.name,
    centerLonLat: config.centerLonLat,
    cols: config.cols,
    rows: config.rows,
    tileSizeMeters: config.tileSizeMeters,
    collarMeters: config.collarMeters,
  });
  const shards: RegionalMosaicShard[] = [];
  const d = config.shardDimension;
  const shardCountX = config.cols / d;
  const shardCountZ = config.rows / d;
  for (let row = 0; row < shardCountZ; row++) {
    for (let col = 0; col < shardCountX; col++) {
      const minE = grid.studyUtmBounds.minEasting + col * d * config.tileSizeMeters;
      const maxN = grid.studyUtmBounds.maxNorthing - row * d * config.tileSizeMeters;
      const [lon, lat] = utm32NToGeo(
        minE + d * config.tileSizeMeters / 2,
        maxN - d * config.tileSizeMeters / 2
      );
      const subgrid = createAlignedStudyGrid({
        name: `${config.name}-r${String(row).padStart(2, '0')}-c${String(col).padStart(2, '0')}`,
        centerLonLat: [lon, lat],
        cols: d,
        rows: d,
        tileSizeMeters: config.tileSizeMeters,
        collarMeters: config.collarMeters,
      });
      if (
        subgrid.minTx !== grid.minTx + col * d ||
        subgrid.maxTy !== grid.maxTy - row * d
      ) {
        throw new Error(`Regional mosaic shard ${row}:${col} lost aligned tile coordinates`);
      }
      shards.push({ id: `r${String(row).padStart(2, '0')}-c${String(col).padStart(2, '0')}`, row, col, grid: subgrid });
    }
  }
  return { config, grid, shards };
}

export function getRegionalShardQueryBounds(
  shard: RegionalMosaicShard,
  contextMarginMeters: number
): ReturnType<typeof utmBoundsToGeoBounds> {
  const b = shard.grid.studyUtmBounds;
  return utmBoundsToGeoBounds({
    minEasting: b.minEasting - contextMarginMeters,
    maxEasting: b.maxEasting + contextMarginMeters,
    minNorthing: b.minNorthing - contextMarginMeters,
    maxNorthing: b.maxNorthing + contextMarginMeters,
  });
}

export interface RegionalMosaicPackInput {
  id: string;
  metadata: TilePackMetadata;
  tiles: TileManifestEntry[];
}

export function composeRegionalMosaicManifest(
  plan: RegionalMosaicPlan,
  inputs: readonly RegionalMosaicPackInput[]
): {
  metadata: TilePackMetadata;
  tiles: TileManifestEntry[];
  ownerByTileKey: Map<string, string>;
} {
  if (inputs.length !== plan.shards.length) {
    throw new Error(`Regional mosaic incomplete: expected ${plan.shards.length} shard packs, received ${inputs.length}`);
  }
  const byId = new Map<string, RegionalMosaicPackInput>();
  for (const input of inputs) {
    if (byId.has(input.id)) throw new Error(`Duplicate regional mosaic shard ${input.id}`);
    byId.set(input.id, input);
  }
  const expectedKeys = new Set(plan.grid.tiles.map((t) => `0:${t.tx}:${t.ty}`));
  const ownerByTileKey = new Map<string, string>();
  const tiles: TileManifestEntry[] = [];
  const regionOrigin = plan.grid.projection;
  let baseline: TilePackMetadata | null = null;

  for (const shard of plan.shards) {
    const input = byId.get(shard.id);
    if (!input) throw new Error(`Missing regional mosaic shard ${shard.id}`);
    const meta = input.metadata;
    if (
      meta.bakeStatus !== 'complete' ||
      meta.tileSizeMeters !== plan.config.tileSizeMeters ||
      meta.collarMeters !== plan.config.collarMeters ||
      meta.gridCols !== shard.grid.cols ||
      meta.gridRows !== shard.grid.rows ||
      meta.minTx !== shard.grid.minTx ||
      meta.maxTx !== shard.grid.maxTx ||
      meta.minTy !== shard.grid.minTy ||
      meta.maxTy !== shard.grid.maxTy ||
      input.tiles.length !== shard.grid.tiles.length
    ) {
      throw new Error(`Incompatible grid/extent or incomplete tile pack in shard ${shard.id}`);
    }
    if (baseline && (
      meta.snapshotId !== baseline.snapshotId ||
      meta.sourceSha256 !== baseline.sourceSha256 ||
      meta.projectionId !== baseline.projectionId ||
      meta.bakeSchemaVersion !== baseline.bakeSchemaVersion ||
      meta.lodPolicyHash !== baseline.lodPolicyHash ||
      meta.compression !== baseline.compression
    )) {
      throw new Error(`Regional mosaic shard ${shard.id} differs in snapshot/schema/LOD policy`);
    }
    baseline ??= meta;
    const offsetX = meta.studyOriginEasting - regionOrigin.originEasting;
    const offsetZ = regionOrigin.originNorthing - meta.studyOriginNorthing;
    for (const tile of input.tiles) {
      const key = `${tile.lod}:${tile.tx}:${tile.ty}`;
      if (!expectedKeys.has(key) || ownerByTileKey.has(key)) {
        throw new Error(`Unexpected or duplicate regional mosaic tile ${key}`);
      }
      if (tile.tx < meta.minTx || tile.tx > meta.maxTx ||
          tile.ty < meta.minTy || tile.ty > meta.maxTy) {
        throw new Error(`Tile ${key} outside declared shard ${shard.id}`);
      }
      const size = plan.config.tileSizeMeters;
      if (
        tile.minEasting !== tile.tx * size ||
        tile.maxEasting !== (tile.tx + 1) * size ||
        tile.minNorthing !== tile.ty * size ||
        tile.maxNorthing !== (tile.ty + 1) * size
      ) {
        throw new Error(`Regional mosaic tile ${key} has misaligned absolute UTM bounds`);
      }
      const expectedX = (tile.minEasting + tile.maxEasting) / 2 - regionOrigin.originEasting;
      const expectedZ = regionOrigin.originNorthing - (tile.minNorthing + tile.maxNorthing) / 2;
      const newX = tile.tileCenterX + offsetX;
      const newZ = tile.tileCenterZ + offsetZ;
      if (Math.abs(newX - expectedX) > 0.01 || Math.abs(newZ - expectedZ) > 0.01) {
        throw new Error(`Regional mosaic tile ${key} has inconsistent coordinate origin`);
      }
      tiles.push({ ...tile, tileCenterX: newX, tileCenterZ: newZ });
      ownerByTileKey.set(key, shard.id);
    }
  }
  if (!baseline || tiles.length !== expectedKeys.size) {
    throw new Error('Regional mosaic does not cover the full expected tile grid');
  }
  const metadata: TilePackMetadata = {
    ...baseline,
    studyOriginEasting: regionOrigin.originEasting,
    studyOriginNorthing: regionOrigin.originNorthing,
    gridCols: plan.grid.cols,
    gridRows: plan.grid.rows,
    minTx: plan.grid.minTx,
    maxTx: plan.grid.maxTx,
    minTy: plan.grid.minTy,
    maxTy: plan.grid.maxTy,
  };
  tiles.sort((a, b) => b.ty - a.ty || a.tx - b.tx);
  return { metadata, tiles, ownerByTileKey };
}
