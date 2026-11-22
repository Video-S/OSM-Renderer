export type TileManifestLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

export type ActiveMosaicStatus = 'inactive' | 'loading' | 'loaded' | 'error';

/**
 * Pure diagnostic representation of the currently active baked tile pack or
 * regional mosaic, derived strictly from the manifest actually loaded by
 * `TileStreamManager` (never from URL parameters or environment variables).
 */
export interface ActiveMosaicIdentity {
  status: ActiveMosaicStatus;
  /** True when regional mosaic streaming (e.g. `/api/tiles-region` or > 64 tiles) is active or being loaded. */
  isRegionalStreaming: boolean;
  /** Human-readable dataset/mosaic name derived from the loaded manifest's `packPath`. */
  mosaicName: string | null;
  /** Full filesystem path reported in the loaded manifest's `packPath`. */
  packPath: string | null;
  /** Source OSM snapshot ID from the loaded manifest metadata. */
  snapshotId: string | null;
  /** Total number of tiles listed in the loaded manifest. */
  tileCount: number | null;
  /** Bake schema version from the loaded manifest metadata. */
  bakeSchemaVersion: string | null;
  /** Tile width/height in meters from the loaded manifest metadata. */
  tileSizeMeters: number | null;
  /** Error message when `status === 'error'`. */
  errorMessage: string | null;
}

export const INACTIVE_MOSAIC_IDENTITY: ActiveMosaicIdentity = Object.freeze({
  status: 'inactive',
  isRegionalStreaming: false,
  mosaicName: null,
  packPath: null,
  snapshotId: null,
  tileCount: null,
  bakeSchemaVersion: null,
  tileSizeMeters: null,
  errorMessage: null,
});

const GENERIC_MOSAIC_FILENAMES = new Set(['mosaic.json', 'index.json']);

/**
 * Derives a concise, readable mosaic or tile-pack identifier from the manifest's
 * `packPath` field (supporting both POSIX `/` and Windows `\` path separators).
 *
 * Examples:
 * - `.../data/osm/twente-pilot-1024m/mosaic.json` -> `twente-pilot-1024m`
 * - `C:\repo\data\osm\twente-pilot-1024m-tkt033-candidate\mosaic.json` -> `twente-pilot-1024m-tkt033-candidate`
 * - `.../data/osm/overijssel-tiles-261114-8ae28196.sqlite` -> `overijssel-tiles-261114-8ae28196`
 */
export function deriveActiveMosaicNameFromPackPath(
  packPath: string | null | undefined
): string | null {
  if (typeof packPath !== 'string') return null;
  const trimmed = packPath.trim();
  if (trimmed.length === 0) return null;

  const segments = trimmed.split(/[/\\]+/).filter((seg) => seg.length > 0);
  if (segments.length === 0) return null;

  const last = segments[segments.length - 1];
  const lastLower = last.toLowerCase();

  if (GENERIC_MOSAIC_FILENAMES.has(lastLower) && segments.length >= 2) {
    const parent = segments[segments.length - 2];
    // Guard against bare Windows drive roots like "C:"
    if (parent && !/^[a-zA-Z]:$/.test(parent)) {
      return parent;
    }
  }

  // Strip common pack/index extensions for non-generic filenames (e.g. .sqlite, .json)
  const stripped = last.replace(/\.(sqlite3?|db|json)$/i, '');
  return stripped.length > 0 ? stripped : last;
}

export function createLoadingMosaicIdentity(
  isRegionalStreaming: boolean
): ActiveMosaicIdentity {
  return {
    status: 'loading',
    isRegionalStreaming,
    mosaicName: null,
    packPath: null,
    snapshotId: null,
    tileCount: null,
    bakeSchemaVersion: null,
    tileSizeMeters: null,
    errorMessage: null,
  };
}

export function createErrorMosaicIdentity(
  isRegionalStreaming: boolean,
  errorMessage: string
): ActiveMosaicIdentity {
  return {
    status: 'error',
    isRegionalStreaming,
    mosaicName: null,
    packPath: null,
    snapshotId: null,
    tileCount: null,
    bakeSchemaVersion: null,
    tileSizeMeters: null,
    errorMessage: errorMessage.trim() || 'Tile manifest unavailable',
  };
}

export interface LoadedManifestIdentitySource {
  manifestStatus: TileManifestLoadStatus;
  manifestError: string | null;
  activeMosaicName: string | null;
  packPath: string | null;
  snapshotId: string;
  bakeSchemaVersion: string;
  tileSizeMeters: number;
  totalGridTiles: number;
}

/**
 * Builds an `ActiveMosaicIdentity` from `TileStreamManager` diagnostics.
 * If the manifest is not in the `'loaded'` state, any stale dataset fields are
 * guaranteed to be cleared (`null`).
 */
export function createMosaicIdentityFromDiagnostics(
  diagnostics: LoadedManifestIdentitySource | null | undefined,
  isRegionalStreaming: boolean
): ActiveMosaicIdentity {
  if (!diagnostics || diagnostics.manifestStatus === 'idle') {
    return INACTIVE_MOSAIC_IDENTITY;
  }
  if (diagnostics.manifestStatus === 'loading') {
    return createLoadingMosaicIdentity(isRegionalStreaming);
  }
  if (diagnostics.manifestStatus === 'error') {
    return createErrorMosaicIdentity(
      isRegionalStreaming,
      diagnostics.manifestError ?? 'Failed to load tile manifest'
    );
  }
  return {
    status: 'loaded',
    isRegionalStreaming,
    mosaicName:
      diagnostics.activeMosaicName ??
      deriveActiveMosaicNameFromPackPath(diagnostics.packPath),
    packPath: diagnostics.packPath,
    snapshotId:
      diagnostics.snapshotId && diagnostics.snapshotId !== 'uninitialized'
        ? diagnostics.snapshotId
        : null,
    tileCount: Number.isFinite(diagnostics.totalGridTiles)
      ? diagnostics.totalGridTiles
      : null,
    bakeSchemaVersion:
      diagnostics.bakeSchemaVersion &&
      diagnostics.bakeSchemaVersion !== 'uninitialized'
        ? diagnostics.bakeSchemaVersion
        : null,
    tileSizeMeters: Number.isFinite(diagnostics.tileSizeMeters)
      ? diagnostics.tileSizeMeters
      : null,
    errorMessage: null,
  };
}
