import type { UtmBox2D } from './TileGrid';
import type {
  RegionalMosaicConsolidationMetadata,
  RegionalMosaicIndex,
} from './RegionalMosaicPlan';
import {
  computeLodPolicyHash,
  type TileManifestEntry,
  type TilePackMetadata,
} from './TilePackContract';

export const HIERARCHICAL_MOSAIC_SCHEMA_TYPE =
  'hierarchical-regional-mosaic' as const;
export const HIERARCHICAL_MOSAIC_SCHEMA_VERSION = 1 as const;

export type HierarchicalCompatibilityErrorCode =
  | 'HIERARCHY_DESCRIPTOR_INVALID'
  | 'HIERARCHY_LEVEL_COUNT_INVALID'
  | 'HIERARCHY_DUPLICATE_RESOLUTION'
  | 'HIERARCHY_RESOLUTION_INVALID'
  | 'HIERARCHY_RESOLUTION_RATIO_INVALID'
  | 'HIERARCHY_SNAPSHOT_MISMATCH'
  | 'HIERARCHY_SOURCE_SHA_MISMATCH'
  | 'HIERARCHY_PROJECTION_MISMATCH'
  | 'HIERARCHY_SCHEMA_MISMATCH'
  | 'HIERARCHY_LOD_POLICY_MISMATCH'
  | 'HIERARCHY_COMPRESSION_MISMATCH'
  | 'HIERARCHY_GRID_ALIGNMENT_INVALID'
  | 'HIERARCHY_COVERAGE_DISJOINT'
  | 'HIERARCHY_CONSOLIDATION_MISMATCH'
  | 'HIERARCHY_TILE_BOUNDS_INVALID';

export class HierarchicalMosaicCompatibilityError extends Error {
  readonly code: HierarchicalCompatibilityErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: HierarchicalCompatibilityErrorCode,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(`[${code}] ${message}`);
    this.name = 'HierarchicalMosaicCompatibilityError';
    this.code = code;
    this.details = details;
  }
}

export interface HierarchicalMosaicLevelDescriptor {
  /** Tile width/height in meters (e.g. 1024, 2048, 4096). */
  tileSizeMeters: number;
  /** Path to an existing single-resolution RegionalMosaicIndex JSON, relative to descriptor directory. */
  indexPath: string;
  /** Optional display label (e.g. "1,024 m fine"). */
  label?: string;
}

export interface HierarchicalRegionalMosaicDescriptor {
  schemaType: typeof HIERARCHICAL_MOSAIC_SCHEMA_TYPE;
  schemaVersion: typeof HIERARCHICAL_MOSAIC_SCHEMA_VERSION;
  name: string;
  snapshotId: string;
  sourceSha256: string;
  projectionId: string;
  /**
   * Optional explicit canonical world origin in EPSG:25832 meters.
   * When omitted, the finest resolution level's `studyOriginEasting/Northing`
   * becomes the shared canonical world origin and coarser levels are rebased to it.
   */
  canonicalOrigin?: {
    easting: number;
    northing: number;
  };
  levels: HierarchicalMosaicLevelDescriptor[];
}

export interface HierarchicalMosaicLevelManifest {
  /** 0 = finest resolution (smallest tileSizeMeters), ascending toward coarsest. */
  levelIndex: number;
  tileSizeMeters: number;
  label: string;
  indexPath: string;
  dbSizeBytes: number;
  /** Metadata rebased to the shared canonical hierarchy origin. */
  metadata: TilePackMetadata;
  /** Tiles whose `tileCenterX` / `tileCenterZ` are rebased to the shared canonical hierarchy origin. */
  tiles: TileManifestEntry[];
  /** True when the constituent mosaic's native origin differed from the canonical origin and was rebased. */
  wasOriginRebased: boolean;
  /** Native study origin before rebasing. */
  nativeOriginEasting: number;
  nativeOriginNorthing: number;
  /** Absolute UTM bounds of this resolution level (may differ across levels due to padded consolidation). */
  boundsUtm: UtmBox2D;
  /** Number of non-empty tiles in this level. */
  nonEmptyTileCount: number;
  /** Number of explicitly empty tiles in this level. */
  emptyTileCount: number;
  /** Optional consolidation lineage from the constituent mosaic index. */
  consolidation: RegionalMosaicConsolidationMetadata | null;
}

export interface HierarchicalMosaicManifestExtension {
  schemaVersion: typeof HIERARCHICAL_MOSAIC_SCHEMA_VERSION;
  hierarchyName: string;
  descriptorPath: string;
  projectionId: string;
  canonicalOriginEasting: number;
  canonicalOriginNorthing: number;
  /** Union absolute UTM bounds across all constituent levels. */
  unionBoundsUtm: UtmBox2D;
  /** Intersection absolute UTM bounds covered by every constituent level. */
  sharedBoundsUtm: UtmBox2D;
  /** Sorted ascending tile resolutions in meters, e.g. [1024, 2048, 4096]. */
  resolutionsMeters: number[];
  /** Default resolution when starting without a zoom override. */
  defaultResolutionMeters: number;
  levels: HierarchicalMosaicLevelManifest[];
}

export interface HierarchicalLevelCompositionInput {
  descriptor: HierarchicalMosaicLevelDescriptor;
  resolvedIndexPath: string;
  dbSizeBytes: number;
  metadata: TilePackMetadata;
  tiles: TileManifestEntry[];
  consolidation?: RegionalMosaicConsolidationMetadata | null;
}

export interface ParsedHierarchicalTileKey {
  tileSizeMeters: number;
  lod: number;
  tx: number;
  ty: number;
}

/**
 * Formats a collision-free tile identity qualified by resolution (`tileSizeMeters`)
 * and internal payload LOD (`lod`, which may be `0` across independently consolidated mosaics).
 *
 * Example: `r2048:l0:tx_156_ty_2819`
 */
export function formatHierarchicalTileKey(
  tileSizeMeters: number,
  tx: number,
  ty: number,
  lod = 0
): string {
  return `r${tileSizeMeters}:l${lod}:tx_${tx}_ty_${ty}`;
}

/**
 * Formats the server-side routing lookup key for a resolution-qualified tile.
 */
export function formatHierarchicalRouteOwnerKey(
  tileSizeMeters: number,
  lod: number,
  tx: number,
  ty: number
): string {
  return `r${tileSizeMeters}:${lod}:${tx}:${ty}`;
}

const HIERARCHICAL_TILE_KEY_RE = /^r(\d+):l(\d+):tx_(-?\d+)_ty_(-?\d+)$/;

export function parseHierarchicalTileKey(
  tileKey: string
): ParsedHierarchicalTileKey | null {
  const m = HIERARCHICAL_TILE_KEY_RE.exec(tileKey);
  if (!m) return null;
  const tileSizeMeters = Number(m[1]);
  const lod = Number(m[2]);
  const tx = Number(m[3]);
  const ty = Number(m[4]);
  if (
    !Number.isSafeInteger(tileSizeMeters) ||
    tileSizeMeters <= 0 ||
    !Number.isSafeInteger(lod) ||
    lod < 0 ||
    !Number.isSafeInteger(tx) ||
    !Number.isSafeInteger(ty)
  ) {
    return null;
  }
  return { tileSizeMeters, lod, tx, ty };
}

/**
 * Type guard distinguishing a multi-resolution hierarchical descriptor JSON
 * from a single-resolution `RegionalMosaicIndex`.
 */
export function isHierarchicalRegionalMosaicDescriptor(
  value: unknown
): value is HierarchicalRegionalMosaicDescriptor {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<HierarchicalRegionalMosaicDescriptor>;
  return v.schemaType === HIERARCHICAL_MOSAIC_SCHEMA_TYPE;
}

/**
 * Type guard for a legacy single-resolution `RegionalMosaicIndex`.
 */
export function isSingleResolutionMosaicIndex(
  value: unknown
): value is RegionalMosaicIndex {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<RegionalMosaicIndex>;
  return (
    v.schemaVersion === 1 &&
    Array.isArray(v.shards) &&
    typeof v.config === 'object' &&
    v.config !== null
  );
}

/**
 * Computes canonical world-space `[minX, maxX, minZ, maxZ]` directly from a tile's
 * absolute EPSG:25832 UTM bounds and the hierarchy's shared canonical world origin.
 * Never depends on mosaic-local array indices or individual mosaic origins.
 */
export function utmBoundsToCanonicalWorldBounds(
  utmBounds: UtmBox2D,
  canonicalOriginEasting: number,
  canonicalOriginNorthing: number
): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
} {
  const minX = utmBounds.minEasting - canonicalOriginEasting;
  const maxX = utmBounds.maxEasting - canonicalOriginEasting;
  const minZ = canonicalOriginNorthing - utmBounds.maxNorthing;
  const maxZ = canonicalOriginNorthing - utmBounds.minNorthing;
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    centerX: (minX + maxX) * 0.5,
    centerZ: (minZ + maxZ) * 0.5,
  };
}

/**
 * Relates a tile in one resolution to overlapping tiles in another resolution strictly
 * via absolute EPSG:25832 projected coordinates (never via mosaic-local array indices).
 * Handles partial parent tiles, padded extents, and non-identical origins.
 */
export function findOverlappingTilesByAbsoluteUtm(
  sourceBounds: UtmBox2D,
  targetTiles: readonly TileManifestEntry[]
): TileManifestEntry[] {
  const overlapping: TileManifestEntry[] = [];
  for (let i = 0; i < targetTiles.length; i++) {
    const t = targetTiles[i];
    if (
      t.maxEasting > sourceBounds.minEasting &&
      t.minEasting < sourceBounds.maxEasting &&
      t.maxNorthing > sourceBounds.minNorthing &&
      t.minNorthing < sourceBounds.maxNorthing
    ) {
      overlapping.push(t);
    }
  }
  return overlapping;
}

/**
 * Validates compatibility across constituent regional mosaics and composes a single
 * canonically rebased hierarchical manifest without duplicating or rewriting baked geometry.
 */
export function validateAndComposeHierarchicalManifest(
  descriptor: HierarchicalRegionalMosaicDescriptor,
  descriptorPath: string,
  levelInputs: readonly HierarchicalLevelCompositionInput[]
): {
  hierarchy: HierarchicalMosaicManifestExtension;
  primaryMetadata: TilePackMetadata;
  primaryTiles: TileManifestEntry[];
  totalDbSizeBytes: number;
} {
  if (
    !descriptor ||
    descriptor.schemaType !== HIERARCHICAL_MOSAIC_SCHEMA_TYPE ||
    descriptor.schemaVersion !== HIERARCHICAL_MOSAIC_SCHEMA_VERSION
  ) {
    throw new HierarchicalMosaicCompatibilityError(
      'HIERARCHY_DESCRIPTOR_INVALID',
      `Invalid hierarchical mosaic descriptor schema at "${descriptorPath}".`
    );
  }
  if (!descriptor.name || typeof descriptor.name !== 'string') {
    throw new HierarchicalMosaicCompatibilityError(
      'HIERARCHY_DESCRIPTOR_INVALID',
      'Hierarchical mosaic descriptor requires a non-empty "name".'
    );
  }
  if (
    !descriptor.snapshotId ||
    !descriptor.sourceSha256 ||
    !descriptor.projectionId
  ) {
    throw new HierarchicalMosaicCompatibilityError(
      'HIERARCHY_DESCRIPTOR_INVALID',
      'Hierarchical mosaic descriptor requires snapshotId, sourceSha256, and projectionId.'
    );
  }
  if (!Array.isArray(levelInputs) || levelInputs.length < 2) {
    throw new HierarchicalMosaicCompatibilityError(
      'HIERARCHY_LEVEL_COUNT_INVALID',
      `Hierarchical mosaic requires at least 2 resolution levels, received ${levelInputs?.length ?? 0}.`
    );
  }

  // Sort levels ascending by tileSizeMeters (finest -> coarsest)
  const sortedInputs = [...levelInputs].sort(
    (a, b) => a.descriptor.tileSizeMeters - b.descriptor.tileSizeMeters
  );

  const seenResolutions = new Set<number>();
  for (const input of sortedInputs) {
    const res = input.descriptor.tileSizeMeters;
    if (!Number.isSafeInteger(res) || res <= 0) {
      throw new HierarchicalMosaicCompatibilityError(
        'HIERARCHY_RESOLUTION_INVALID',
        `Invalid resolution tileSizeMeters=${res} for level "${input.resolvedIndexPath}".`,
        { tileSizeMeters: res, indexPath: input.resolvedIndexPath }
      );
    }
    if (seenResolutions.has(res)) {
      throw new HierarchicalMosaicCompatibilityError(
        'HIERARCHY_DUPLICATE_RESOLUTION',
        `Duplicate resolution ${res} m declared in hierarchical mosaic descriptor.`,
        { tileSizeMeters: res }
      );
    }
    seenResolutions.add(res);
  }

  const finestRes = sortedInputs[0].descriptor.tileSizeMeters;
  for (let i = 1; i < sortedInputs.length; i++) {
    const res = sortedInputs[i].descriptor.tileSizeMeters;
    if (res % finestRes !== 0) {
      throw new HierarchicalMosaicCompatibilityError(
        'HIERARCHY_RESOLUTION_RATIO_INVALID',
        `Resolution ${res} m is not an integer multiple of finest resolution ${finestRes} m.`,
        { tileSizeMeters: res, finestResolutionMeters: finestRes }
      );
    }
  }

  const expectedSha = descriptor.sourceSha256.toLowerCase();
  const baselineMeta = sortedInputs[0].metadata;

  // Canonical world origin: explicit from descriptor, or finest level's study origin
  const canonicalOriginEasting =
    descriptor.canonicalOrigin &&
    Number.isFinite(descriptor.canonicalOrigin.easting)
      ? descriptor.canonicalOrigin.easting
      : baselineMeta.studyOriginEasting;
  const canonicalOriginNorthing =
    descriptor.canonicalOrigin &&
    Number.isFinite(descriptor.canonicalOrigin.northing)
      ? descriptor.canonicalOrigin.northing
      : baselineMeta.studyOriginNorthing;

  const levels: HierarchicalMosaicLevelManifest[] = [];
  let totalDbSizeBytes = 0;

  let unionMinE = Number.POSITIVE_INFINITY;
  let unionMaxE = Number.NEGATIVE_INFINITY;
  let unionMinN = Number.POSITIVE_INFINITY;
  let unionMaxN = Number.NEGATIVE_INFINITY;

  let sharedMinE = Number.NEGATIVE_INFINITY;
  let sharedMaxE = Number.POSITIVE_INFINITY;
  let sharedMinN = Number.NEGATIVE_INFINITY;
  let sharedMaxN = Number.POSITIVE_INFINITY;

  for (let levelIndex = 0; levelIndex < sortedInputs.length; levelIndex++) {
    const input = sortedInputs[levelIndex];
    const res = input.descriptor.tileSizeMeters;
    const meta = input.metadata;

    if (meta.tileSizeMeters !== res) {
      throw new HierarchicalMosaicCompatibilityError(
        'HIERARCHY_RESOLUTION_INVALID',
        `Level declared as ${res} m points to mosaic "${input.resolvedIndexPath}" with tileSizeMeters=${meta.tileSizeMeters}.`,
        {
          declaredTileSizeMeters: res,
          actualTileSizeMeters: meta.tileSizeMeters,
          indexPath: input.resolvedIndexPath,
        }
      );
    }
    if (meta.snapshotId !== descriptor.snapshotId) {
      throw new HierarchicalMosaicCompatibilityError(
        'HIERARCHY_SNAPSHOT_MISMATCH',
        `Level ${res} m snapshotId "${meta.snapshotId}" does not match hierarchy snapshotId "${descriptor.snapshotId}".`,
        {
          tileSizeMeters: res,
          expected: descriptor.snapshotId,
          actual: meta.snapshotId,
        }
      );
    }
    if (meta.sourceSha256.toLowerCase() !== expectedSha) {
      throw new HierarchicalMosaicCompatibilityError(
        'HIERARCHY_SOURCE_SHA_MISMATCH',
        `Level ${res} m sourceSha256 "${meta.sourceSha256}" does not match hierarchy sourceSha256 "${descriptor.sourceSha256}".`,
        {
          tileSizeMeters: res,
          expected: expectedSha,
          actual: meta.sourceSha256.toLowerCase(),
        }
      );
    }
    if (meta.projectionId !== descriptor.projectionId) {
      throw new HierarchicalMosaicCompatibilityError(
        'HIERARCHY_PROJECTION_MISMATCH',
        `Level ${res} m projectionId "${meta.projectionId}" does not match hierarchy projectionId "${descriptor.projectionId}".`,
        {
          tileSizeMeters: res,
          expected: descriptor.projectionId,
          actual: meta.projectionId,
        }
      );
    }
    if (meta.bakeSchemaVersion !== baselineMeta.bakeSchemaVersion) {
      throw new HierarchicalMosaicCompatibilityError(
        'HIERARCHY_SCHEMA_MISMATCH',
        `Level ${res} m bakeSchemaVersion "${meta.bakeSchemaVersion}" differs from finest level "${baselineMeta.bakeSchemaVersion}".`,
        {
          tileSizeMeters: res,
          expected: baselineMeta.bakeSchemaVersion,
          actual: meta.bakeSchemaVersion,
        }
      );
    }
    // `computeLodPolicyHash` includes `tileSizeMeters`, so consolidated 2,048 m and
    // 4,096 m mosaics legitimately carry a resolution-specific hash derived from the
    // same projection, collar, LOD0, and BVH policy as the finest level.
    const baselineWithBvhHash = computeLodPolicyHash({
      projectionId: baselineMeta.projectionId,
      tileSizeMeters: baselineMeta.tileSizeMeters,
      collarMeters: baselineMeta.collarMeters,
      lod: 0,
      includeBvh: true,
    });
    const baselineNoBvhHash = computeLodPolicyHash({
      projectionId: baselineMeta.projectionId,
      tileSizeMeters: baselineMeta.tileSizeMeters,
      collarMeters: baselineMeta.collarMeters,
      lod: 0,
      includeBvh: false,
    });
    let expectedLevelLodPolicyHash = baselineMeta.lodPolicyHash;
    if (baselineMeta.lodPolicyHash === baselineWithBvhHash) {
      expectedLevelLodPolicyHash = computeLodPolicyHash({
        projectionId: baselineMeta.projectionId,
        tileSizeMeters: res,
        collarMeters: baselineMeta.collarMeters,
        lod: 0,
        includeBvh: true,
      });
    } else if (baselineMeta.lodPolicyHash === baselineNoBvhHash) {
      expectedLevelLodPolicyHash = computeLodPolicyHash({
        projectionId: baselineMeta.projectionId,
        tileSizeMeters: res,
        collarMeters: baselineMeta.collarMeters,
        lod: 0,
        includeBvh: false,
      });
    }

    if (
      meta.lodPolicyHash !== expectedLevelLodPolicyHash &&
      meta.lodPolicyHash !== baselineMeta.lodPolicyHash
    ) {
      throw new HierarchicalMosaicCompatibilityError(
        'HIERARCHY_LOD_POLICY_MISMATCH',
        `Level ${res} m lodPolicyHash "${meta.lodPolicyHash}" is incompatible with finest level "${baselineMeta.lodPolicyHash}" (expected "${expectedLevelLodPolicyHash}").`,
        {
          tileSizeMeters: res,
          expected: expectedLevelLodPolicyHash,
          actual: meta.lodPolicyHash,
        }
      );
    }
    if (meta.compression !== baselineMeta.compression) {
      throw new HierarchicalMosaicCompatibilityError(
        'HIERARCHY_COMPRESSION_MISMATCH',
        `Level ${res} m compression "${meta.compression}" differs from finest level "${baselineMeta.compression}".`,
        {
          tileSizeMeters: res,
          expected: baselineMeta.compression,
          actual: meta.compression,
        }
      );
    }
    if (input.consolidation) {
      if (input.consolidation.targetTileSizeMeters !== res) {
        throw new HierarchicalMosaicCompatibilityError(
          'HIERARCHY_CONSOLIDATION_MISMATCH',
          `Level ${res} m consolidation metadata reports targetTileSizeMeters=${input.consolidation.targetTileSizeMeters}.`,
          {
            tileSizeMeters: res,
            consolidationTarget: input.consolidation.targetTileSizeMeters,
          }
        );
      }
      if (
        input.consolidation.consolidatedFromTileSizeMeters !== finestRes &&
        res % input.consolidation.consolidatedFromTileSizeMeters !== 0
      ) {
        throw new HierarchicalMosaicCompatibilityError(
          'HIERARCHY_CONSOLIDATION_MISMATCH',
          `Level ${res} m consolidation source resolution ${input.consolidation.consolidatedFromTileSizeMeters} m is incompatible with finest level ${finestRes} m.`,
          {
            tileSizeMeters: res,
            consolidatedFromTileSizeMeters:
              input.consolidation.consolidatedFromTileSizeMeters,
            finestResolutionMeters: finestRes,
          }
        );
      }
    }

    if (input.tiles.length === 0) {
      throw new HierarchicalMosaicCompatibilityError(
        'HIERARCHY_TILE_BOUNDS_INVALID',
        `Level ${res} m contains zero tiles.`
      );
    }

    let levelMinE = Number.POSITIVE_INFINITY;
    let levelMaxE = Number.NEGATIVE_INFINITY;
    let levelMinN = Number.POSITIVE_INFINITY;
    let levelMaxN = Number.NEGATIVE_INFINITY;
    let nonEmptyTileCount = 0;
    let emptyTileCount = 0;

    const rebasedTiles: TileManifestEntry[] = new Array(input.tiles.length);
    const seenTileCoords = new Set<string>();

    for (let i = 0; i < input.tiles.length; i++) {
      const tile = input.tiles[i];
      const expectedMinE = tile.tx * res;
      const expectedMaxE = (tile.tx + 1) * res;
      const expectedMinN = tile.ty * res;
      const expectedMaxN = (tile.ty + 1) * res;

      if (
        tile.minEasting !== expectedMinE ||
        tile.maxEasting !== expectedMaxE ||
        tile.minNorthing !== expectedMinN ||
        tile.maxNorthing !== expectedMaxN
      ) {
        throw new HierarchicalMosaicCompatibilityError(
          'HIERARCHY_GRID_ALIGNMENT_INVALID',
          `Tile (${tile.tx}, ${tile.ty}) at resolution ${res} m has UTM bounds [${tile.minEasting},${tile.maxEasting}]×[${tile.minNorthing},${tile.maxNorthing}] that do not align to ${res} m UTM grid multiples.`,
          { tileSizeMeters: res, tx: tile.tx, ty: tile.ty }
        );
      }

      const dedupKey = `${tile.lod}:${tile.tx}:${tile.ty}`;
      if (seenTileCoords.has(dedupKey)) {
        throw new HierarchicalMosaicCompatibilityError(
          'HIERARCHY_TILE_BOUNDS_INVALID',
          `Duplicate tile ${dedupKey} in level ${res} m.`
        );
      }
      seenTileCoords.add(dedupKey);

      if (tile.minEasting < levelMinE) levelMinE = tile.minEasting;
      if (tile.maxEasting > levelMaxE) levelMaxE = tile.maxEasting;
      if (tile.minNorthing < levelMinN) levelMinN = tile.minNorthing;
      if (tile.maxNorthing > levelMaxN) levelMaxN = tile.maxNorthing;

      if (tile.isEmpty) {
        emptyTileCount += 1;
      } else {
        nonEmptyTileCount += 1;
      }

      // Rebase tileCenterX / tileCenterZ directly from absolute UTM bounds to the
      // canonical hierarchy world origin so every resolution places geometry at
      // identical canonical world positions regardless of native mosaic padding.
      const canonicalCenterX =
        (tile.minEasting + tile.maxEasting) * 0.5 - canonicalOriginEasting;
      const canonicalCenterZ =
        canonicalOriginNorthing - (tile.minNorthing + tile.maxNorthing) * 0.5;

      rebasedTiles[i] = {
        ...tile,
        tileCenterX: canonicalCenterX,
        tileCenterZ: canonicalCenterZ,
      };
    }

    rebasedTiles.sort((a, b) => b.ty - a.ty || a.tx - b.tx);

    const boundsUtm: UtmBox2D = {
      minEasting: levelMinE,
      maxEasting: levelMaxE,
      minNorthing: levelMinN,
      maxNorthing: levelMaxN,
    };

    if (levelMinE < unionMinE) unionMinE = levelMinE;
    if (levelMaxE > unionMaxE) unionMaxE = levelMaxE;
    if (levelMinN < unionMinN) unionMinN = levelMinN;
    if (levelMaxN > unionMaxN) unionMaxN = levelMaxN;

    if (levelMinE > sharedMinE) sharedMinE = levelMinE;
    if (levelMaxE < sharedMaxE) sharedMaxE = levelMaxE;
    if (levelMinN > sharedMinN) sharedMinN = levelMinN;
    if (levelMaxN < sharedMaxN) sharedMaxN = levelMaxN;

    const wasOriginRebased =
      Math.abs(meta.studyOriginEasting - canonicalOriginEasting) > 1e-6 ||
      Math.abs(meta.studyOriginNorthing - canonicalOriginNorthing) > 1e-6;

    const rebasedMetadata: TilePackMetadata = {
      ...meta,
      studyOriginEasting: canonicalOriginEasting,
      studyOriginNorthing: canonicalOriginNorthing,
    };

    totalDbSizeBytes += input.dbSizeBytes;

    levels.push({
      levelIndex,
      tileSizeMeters: res,
      label: input.descriptor.label?.trim() || `${res.toLocaleString('en-US')} m`,
      indexPath: input.resolvedIndexPath,
      dbSizeBytes: input.dbSizeBytes,
      metadata: rebasedMetadata,
      tiles: rebasedTiles,
      wasOriginRebased,
      nativeOriginEasting: meta.studyOriginEasting,
      nativeOriginNorthing: meta.studyOriginNorthing,
      boundsUtm,
      nonEmptyTileCount,
      emptyTileCount,
      consolidation: input.consolidation ?? null,
    });
  }

  if (sharedMinE >= sharedMaxE || sharedMinN >= sharedMaxN) {
    throw new HierarchicalMosaicCompatibilityError(
      'HIERARCHY_COVERAGE_DISJOINT',
      'Constituent hierarchical mosaic levels do not share overlapping EPSG:25832 geographic coverage.',
      {
        levelBounds: levels.map((l) => ({
          tileSizeMeters: l.tileSizeMeters,
          boundsUtm: l.boundsUtm,
        })),
      }
    );
  }

  const resolutionsMeters = levels.map((l) => l.tileSizeMeters);
  const hierarchy: HierarchicalMosaicManifestExtension = {
    schemaVersion: HIERARCHICAL_MOSAIC_SCHEMA_VERSION,
    hierarchyName: descriptor.name,
    descriptorPath,
    projectionId: descriptor.projectionId,
    canonicalOriginEasting,
    canonicalOriginNorthing,
    unionBoundsUtm: {
      minEasting: unionMinE,
      maxEasting: unionMaxE,
      minNorthing: unionMinN,
      maxNorthing: unionMaxN,
    },
    sharedBoundsUtm: {
      minEasting: sharedMinE,
      maxEasting: sharedMaxE,
      minNorthing: sharedMinN,
      maxNorthing: sharedMaxN,
    },
    resolutionsMeters,
    defaultResolutionMeters: resolutionsMeters[0],
    levels,
  };

  return {
    hierarchy,
    primaryMetadata: levels[0].metadata,
    primaryTiles: levels[0].tiles,
    totalDbSizeBytes,
  };
}
