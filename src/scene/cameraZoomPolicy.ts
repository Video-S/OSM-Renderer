/**
 * Centralized camera zoom policy for ordinary maps, local tile fixtures, and
 * regional baked tile mosaics.
 *
 * Regional LOD0 mosaics span hundreds of tiles without LOD1–LOD3 yet; the
 * conservative `DEFAULT_REGIONAL_MIN_ZOOM` (`0.15`) prevents accidental
 * full-region zoom-outs from overwhelming the GPU while allowing explicit,
 * validated developer and benchmark overrides (e.g. `?regionalMinZoom=0.05` or
 * `BENCHMARK_REGIONAL_OVERVIEW_MIN_ZOOM = 0.015`).
 */

/** Minimum orthographic zoom for ordinary maps and small (<= 64-tile) Hengelo fixtures. */
export const STANDARD_MIN_ZOOM = 0.15;

/** Maximum orthographic zoom preserved across all rendering modes. */
export const STANDARD_MAX_ZOOM = 16.0;

/**
 * Initial conservative minimum zoom for regional tiled streaming (> 64 tiles).
 * Interim safety cap until regional LOD1–LOD3 tiers are implemented.
 */
export const DEFAULT_REGIONAL_MIN_ZOOM = 0.15;

/**
 * Legacy full-region overview minimum zoom preserved for explicit benchmark opt-in
 * when measuring full-region LOD0 rendering cost.
 */
export const BENCHMARK_REGIONAL_OVERVIEW_MIN_ZOOM = 0.015;

/** Grid tile count above which a streamed tile pack is treated as a regional mosaic. */
export const REGIONAL_MIN_ZOOM_TILE_THRESHOLD = 64;

/** Minimum allowed value for an explicit `regionalMinZoom` developer/benchmark override. */
export const MIN_ALLOWED_REGIONAL_MIN_ZOOM = 0.01;

/** Maximum allowed value for an explicit `regionalMinZoom` developer/benchmark override. */
export const MAX_ALLOWED_REGIONAL_MIN_ZOOM = 4.0;

/** URL query parameter name for overriding the regional zoom-out limit. */
export const REGIONAL_MIN_ZOOM_QUERY_PARAM = 'regionalMinZoom';

export type RegionalMinZoomOverrideReason =
  | 'absent'
  | 'valid'
  | 'invalid_format'
  | 'out_of_range';

export interface ParsedRegionalMinZoomOverride {
  rawValue: string | null;
  overrideMinZoom: number | null;
  isValid: boolean;
  reason: RegionalMinZoomOverrideReason;
}

export type CameraZoomPolicySource =
  | 'standard_default'
  | 'regional_default'
  | 'url_override'
  | 'programmatic_override'
  | 'fallback_invalid_override';

export interface CameraZoomPolicy {
  mode: 'standard' | 'regional';
  minZoom: number;
  maxZoom: number;
  source: CameraZoomPolicySource;
  requestedOverrideRaw: string | null;
  invalidOverrideRejected: boolean;
}

export interface ResolveCameraZoomPolicyOptions {
  /** True when regional tiled streaming (e.g. > 64 tiles or `/api/tiles-region`) is active. */
  isRegionalStreaming: boolean;
  /** Optional parsed URL override from `parseRegionalMinZoomFromSearch`. */
  urlOverride?: ParsedRegionalMinZoomOverride | null;
  /** Optional programmatic override (e.g. benchmark harness requesting `0.015`). */
  programmaticOverride?: number | null;
}

const STRICT_NUMERIC_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Validates an explicit `regionalMinZoom` override supplied via URL query string
 * or programmatic benchmark call.
 *
 * Rejects non-finite, zero, negative, malformed, or unreasonable values
 * outside `[MIN_ALLOWED_REGIONAL_MIN_ZOOM, MAX_ALLOWED_REGIONAL_MIN_ZOOM]`.
 */
export function validateRegionalMinZoomOverride(
  value: number | string | null | undefined
): ParsedRegionalMinZoomOverride {
  if (value === null || value === undefined) {
    return {
      rawValue: null,
      overrideMinZoom: null,
      isValid: false,
      reason: 'absent',
    };
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0 || !STRICT_NUMERIC_PATTERN.test(trimmed)) {
      return {
        rawValue: value,
        overrideMinZoom: null,
        isValid: false,
        reason: 'invalid_format',
      };
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return {
        rawValue: value,
        overrideMinZoom: null,
        isValid: false,
        reason: 'invalid_format',
      };
    }
    if (
      parsed <= 0 ||
      parsed < MIN_ALLOWED_REGIONAL_MIN_ZOOM ||
      parsed > MAX_ALLOWED_REGIONAL_MIN_ZOOM
    ) {
      return {
        rawValue: value,
        overrideMinZoom: null,
        isValid: false,
        reason: 'out_of_range',
      };
    }
    return {
      rawValue: value,
      overrideMinZoom: parsed,
      isValid: true,
      reason: 'valid',
    };
  }

  if (typeof value === 'number') {
    const rawValue = String(value);
    if (!Number.isFinite(value)) {
      return {
        rawValue,
        overrideMinZoom: null,
        isValid: false,
        reason: 'invalid_format',
      };
    }
    if (
      value <= 0 ||
      value < MIN_ALLOWED_REGIONAL_MIN_ZOOM ||
      value > MAX_ALLOWED_REGIONAL_MIN_ZOOM
    ) {
      return {
        rawValue,
        overrideMinZoom: null,
        isValid: false,
        reason: 'out_of_range',
      };
    }
    return {
      rawValue,
      overrideMinZoom: value,
      isValid: true,
      reason: 'valid',
    };
  }

  return {
    rawValue: String(value),
    overrideMinZoom: null,
    isValid: false,
    reason: 'invalid_format',
  };
}

/**
 * Parses and validates `?regionalMinZoom=<number>` from a URL search string.
 */
export function parseRegionalMinZoomFromSearch(
  search: string
): ParsedRegionalMinZoomOverride {
  const params = new URLSearchParams(search);
  if (!params.has(REGIONAL_MIN_ZOOM_QUERY_PARAM)) {
    return {
      rawValue: null,
      overrideMinZoom: null,
      isValid: false,
      reason: 'absent',
    };
  }
  return validateRegionalMinZoomOverride(
    params.get(REGIONAL_MIN_ZOOM_QUERY_PARAM)
  );
}

/**
 * Resolves the effective camera zoom policy for the active scene mode.
 *
 * Non-regional modes (ordinary OSM maps, fixtures, and <= 64-tile Hengelo packs)
 * always receive `STANDARD_MIN_ZOOM = 0.15` and `STANDARD_MAX_ZOOM = 16.0`,
 * unaffected by regional overrides.
 */
export function resolveCameraZoomPolicy(
  options: ResolveCameraZoomPolicyOptions
): CameraZoomPolicy {
  if (!options.isRegionalStreaming) {
    return {
      mode: 'standard',
      minZoom: STANDARD_MIN_ZOOM,
      maxZoom: STANDARD_MAX_ZOOM,
      source: 'standard_default',
      requestedOverrideRaw: null,
      invalidOverrideRejected: false,
    };
  }

  // Programmatic override (e.g. benchmark harness) takes precedence when provided.
  if (
    options.programmaticOverride !== undefined &&
    options.programmaticOverride !== null
  ) {
    const validated = validateRegionalMinZoomOverride(
      options.programmaticOverride
    );
    if (validated.isValid && validated.overrideMinZoom !== null) {
      return {
        mode: 'regional',
        minZoom: validated.overrideMinZoom,
        maxZoom: STANDARD_MAX_ZOOM,
        source: 'programmatic_override',
        requestedOverrideRaw: validated.rawValue,
        invalidOverrideRejected: false,
      };
    }
    return {
      mode: 'regional',
      minZoom: DEFAULT_REGIONAL_MIN_ZOOM,
      maxZoom: STANDARD_MAX_ZOOM,
      source: 'fallback_invalid_override',
      requestedOverrideRaw: validated.rawValue,
      invalidOverrideRejected: true,
    };
  }

  const urlOverride = options.urlOverride;
  if (urlOverride && urlOverride.reason !== 'absent') {
    if (urlOverride.isValid && urlOverride.overrideMinZoom !== null) {
      return {
        mode: 'regional',
        minZoom: urlOverride.overrideMinZoom,
        maxZoom: STANDARD_MAX_ZOOM,
        source: 'url_override',
        requestedOverrideRaw: urlOverride.rawValue,
        invalidOverrideRejected: false,
      };
    }
    return {
      mode: 'regional',
      minZoom: DEFAULT_REGIONAL_MIN_ZOOM,
      maxZoom: STANDARD_MAX_ZOOM,
      source: 'fallback_invalid_override',
      requestedOverrideRaw: urlOverride.rawValue,
      invalidOverrideRejected: true,
    };
  }

  return {
    mode: 'regional',
    minZoom: DEFAULT_REGIONAL_MIN_ZOOM,
    maxZoom: STANDARD_MAX_ZOOM,
    source: 'regional_default',
    requestedOverrideRaw: null,
    invalidOverrideRejected: false,
  };
}

/**
 * Clamps any candidate camera zoom value into the active `[minZoom, maxZoom]` range.
 * Non-finite inputs safely fall back to `minZoom`.
 */
export function clampCameraZoom(
  zoom: number,
  minZoom: number = STANDARD_MIN_ZOOM,
  maxZoom: number = STANDARD_MAX_ZOOM
): number {
  const safeMax =
    Number.isFinite(maxZoom) && maxZoom > 0 ? maxZoom : STANDARD_MAX_ZOOM;
  const safeMin =
    Number.isFinite(minZoom) && minZoom > 0
      ? Math.min(minZoom, safeMax)
      : Math.min(STANDARD_MIN_ZOOM, safeMax);
  if (!Number.isFinite(zoom)) {
    return safeMin;
  }
  return Math.max(safeMin, Math.min(safeMax, zoom));
}

/**
 * Resolves the target camera framing for a reset or "Frame Region" operation,
 * ensuring the resulting zoom never escapes `[minZoom, maxZoom]`.
 */
export function resolveCameraResetOrFrameTarget(options: {
  boundsFraming: {
    position: [number, number, number];
    target: [number, number, number];
    zoom: number;
  } | null;
  fallbackPosition: [number, number, number];
  fallbackTarget: [number, number, number];
  fallbackZoom: number;
  minZoom: number;
  maxZoom: number;
}): {
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
} {
  const base = options.boundsFraming ?? {
    position: options.fallbackPosition,
    target: options.fallbackTarget,
    zoom: options.fallbackZoom,
  };
  return {
    position: base.position,
    target: base.target,
    zoom: clampCameraZoom(base.zoom, options.minZoom, options.maxZoom),
  };
}

/**
 * Interpolates between `startZoom` and `destZoom` along eased progress `t ∈ [0, 1]`
 * while clamping both endpoints and the interpolated result to `[minZoom, maxZoom]`
 * so transition animations cannot transiently escape the zoom cap.
 */
export function interpolateClampedCameraZoom(
  startZoom: number,
  destZoom: number,
  t: number,
  minZoom: number,
  maxZoom: number
): number {
  const clampedStart = clampCameraZoom(startZoom, minZoom, maxZoom);
  const clampedDest = clampCameraZoom(destZoom, minZoom, maxZoom);
  const clampedT = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 1;
  return clampCameraZoom(
    clampedStart + (clampedDest - clampedStart) * clampedT,
    minZoom,
    maxZoom
  );
}
