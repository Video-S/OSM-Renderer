export type HierarchicalResolutionMode =
  | 'auto'
  | 'force_1024'
  | 'force_2048'
  | 'force_4096';

/**
 * Hysteresis transition band between an adjacent pair of spatial resolutions.
 *
 * All threshold values are expressed in effective orthographic screen-space scale
 * (`px / m`, equivalent to `camera.zoom` at the reference viewport width).
 */
export interface HierarchicalThresholdBand {
  fineResolutionMeters: number;
  coarseResolutionMeters: number;
  /** Provisional center threshold (engineering starting point, e.g. 0.9 or 0.3). */
  nominalZoom: number;
  /** Switch fine -> coarse when effective scale drops strictly below this value. */
  zoomOutThreshold: number;
  /** Switch coarse -> fine when effective scale rises strictly above this value. */
  zoomInThreshold: number;
}

export interface HierarchicalResolutionPolicyConfig {
  /** Automatic zoom-dependent selection or forced single resolution for development/testing. */
  mode: HierarchicalResolutionMode;
  /**
   * Ordered hysteresis bands from finest boundary to coarsest boundary.
   * Defaults to provisional engineering starting points from TKT-041 Section 7:
   * - 1,024 m <-> 2,048 m: nominal 0.9, zoomOut < 0.80, zoomIn > 1.00
   * - 2,048 m <-> 4,096 m: nominal 0.3, zoomOut < 0.26, zoomIn > 0.34
   */
  bands: HierarchicalThresholdBand[];
  /**
   * When true and viewport width is known, adjusts effective scale by
   * `clamp(sqrt(referenceViewportWidthPx / viewportWidthPx), minViewportScaleFactor, maxViewportScaleFactor)`
   * so wider viewports that cover more physical meters transition to coarser batching earlier.
   */
  viewportScaleCompensationEnabled: boolean;
  /** Reference CSS viewport width in pixels where `effectiveScale === cameraZoom` (default: 1280). */
  referenceViewportWidthPx: number;
  /** Lower clamp for viewport compensation multiplier (default: 0.75). */
  minViewportScaleFactor: number;
  /** Upper clamp for viewport compensation multiplier (default: 1.35). */
  maxViewportScaleFactor: number;
  /**
   * Physical preload margin around the visible viewport in meters (Section 10).
   * Avoids blindly applying identical tile-count margins to 1,024 m vs 4,096 m tiles.
   */
  preloadMarginMeters: number;
  /**
   * Physical retention margin around the visible viewport in meters (Section 10).
   * Always >= preloadMarginMeters.
   */
  retainMarginMeters: number;
}

export const DEFAULT_HIERARCHICAL_THRESHOLD_BANDS: ReadonlyArray<HierarchicalThresholdBand> =
  Object.freeze([
    Object.freeze({
      fineResolutionMeters: 1024,
      coarseResolutionMeters: 2048,
      nominalZoom: 0.9,
      zoomOutThreshold: 0.8,
      zoomInThreshold: 1.0,
    }),
    Object.freeze({
      fineResolutionMeters: 2048,
      coarseResolutionMeters: 4096,
      nominalZoom: 0.3,
      zoomOutThreshold: 0.26,
      zoomInThreshold: 0.34,
    }),
  ]);

export const DEFAULT_HIERARCHICAL_RESOLUTION_POLICY: Readonly<HierarchicalResolutionPolicyConfig> =
  Object.freeze({
    mode: 'auto',
    bands: DEFAULT_HIERARCHICAL_THRESHOLD_BANDS.map((b) => ({ ...b })),
    viewportScaleCompensationEnabled: true,
    referenceViewportWidthPx: 1280,
    minViewportScaleFactor: 0.75,
    maxViewportScaleFactor: 1.35,
    preloadMarginMeters: 1024,
    retainMarginMeters: 2048,
  });

export interface HierarchicalScaleEvaluation {
  rawCameraZoom: number;
  effectiveScalePxPerMeter: number;
  viewportScaleFactor: number;
  viewportWidthPx: number | null;
  viewportHeightPx: number | null;
  desiredResolutionMeters: number;
  reason: string;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function normalizeHierarchicalResolutionMode(
  mode: unknown
): HierarchicalResolutionMode {
  if (
    mode === 'auto' ||
    mode === 'force_1024' ||
    mode === 'force_2048' ||
    mode === 'force_4096'
  ) {
    return mode;
  }
  if (mode === '1024' || mode === 1024) return 'force_1024';
  if (mode === '2048' || mode === 2048) return 'force_2048';
  if (mode === '4096' || mode === 4096) return 'force_4096';
  return 'auto';
}

export function normalizeHierarchicalResolutionPolicy(
  partial?: Partial<HierarchicalResolutionPolicyConfig> | null
): HierarchicalResolutionPolicyConfig {
  const base = DEFAULT_HIERARCHICAL_RESOLUTION_POLICY;
  const rawBands =
    Array.isArray(partial?.bands) && partial.bands.length > 0
      ? partial.bands
      : base.bands;

  const bands: HierarchicalThresholdBand[] = rawBands
    .map((b) => {
      const fine = Math.max(1, Math.round(Number(b.fineResolutionMeters) || 1024));
      const coarse = Math.max(fine + 1, Math.round(Number(b.coarseResolutionMeters) || fine * 2));
      const rawOut = Number(b.zoomOutThreshold);
      const rawIn = Number(b.zoomInThreshold);
      const rawNom = Number(b.nominalZoom);
      const zoomOut = Number.isFinite(rawOut) && rawOut > 0 ? rawOut : 0.26;
      const zoomIn =
        Number.isFinite(rawIn) && rawIn >= zoomOut ? rawIn : Math.max(zoomOut, rawNom || zoomOut);
      const nominal =
        Number.isFinite(rawNom) && rawNom > 0 ? rawNom : (zoomOut + zoomIn) * 0.5;
      return {
        fineResolutionMeters: fine,
        coarseResolutionMeters: coarse,
        nominalZoom: Number(nominal.toFixed(4)),
        zoomOutThreshold: Number(zoomOut.toFixed(4)),
        zoomInThreshold: Number(zoomIn.toFixed(4)),
      };
    })
    .sort((a, b) => a.fineResolutionMeters - b.fineResolutionMeters);

  const preloadMarginMeters =
    typeof partial?.preloadMarginMeters === 'number' &&
    Number.isFinite(partial.preloadMarginMeters) &&
    partial.preloadMarginMeters >= 0
      ? partial.preloadMarginMeters
      : base.preloadMarginMeters;
  const retainMarginMeters =
    typeof partial?.retainMarginMeters === 'number' &&
    Number.isFinite(partial.retainMarginMeters) &&
    partial.retainMarginMeters >= preloadMarginMeters
      ? partial.retainMarginMeters
      : Math.max(preloadMarginMeters, base.retainMarginMeters);

  const referenceViewportWidthPx =
    typeof partial?.referenceViewportWidthPx === 'number' &&
    Number.isFinite(partial.referenceViewportWidthPx) &&
    partial.referenceViewportWidthPx >= 320
      ? partial.referenceViewportWidthPx
      : base.referenceViewportWidthPx;

  const minViewportScaleFactor =
    typeof partial?.minViewportScaleFactor === 'number' &&
    Number.isFinite(partial.minViewportScaleFactor) &&
    partial.minViewportScaleFactor > 0.25 &&
    partial.minViewportScaleFactor <= 1.0
      ? partial.minViewportScaleFactor
      : base.minViewportScaleFactor;

  const maxViewportScaleFactor =
    typeof partial?.maxViewportScaleFactor === 'number' &&
    Number.isFinite(partial.maxViewportScaleFactor) &&
    partial.maxViewportScaleFactor >= 1.0 &&
    partial.maxViewportScaleFactor <= 3.0
      ? partial.maxViewportScaleFactor
      : base.maxViewportScaleFactor;

  return {
    mode: normalizeHierarchicalResolutionMode(partial?.mode ?? base.mode),
    bands,
    viewportScaleCompensationEnabled:
      typeof partial?.viewportScaleCompensationEnabled === 'boolean'
        ? partial.viewportScaleCompensationEnabled
        : base.viewportScaleCompensationEnabled,
    referenceViewportWidthPx,
    minViewportScaleFactor,
    maxViewportScaleFactor,
    preloadMarginMeters,
    retainMarginMeters,
  };
}

/**
 * Computes effective orthographic screen-space scale (`px / m`) accounting for
 * viewport width relative to the reference width (`1,280 px`).
 *
 * Wider viewports expose more physical meters across the screen at the same `camera.zoom`,
 * so their effective scale is gently lowered (`sqrt(refWidth / actualWidth)`), nudging
 * batching transitions earlier to keep visible tile counts bounded.
 */
export function computeEffectiveOrthographicScale(
  cameraZoom: number,
  viewportWidthPx: number | null | undefined,
  policy: HierarchicalResolutionPolicyConfig
): { effectiveScalePxPerMeter: number; viewportScaleFactor: number } {
  const safeZoom =
    Number.isFinite(cameraZoom) && cameraZoom > 0 ? cameraZoom : 1.0;
  if (
    !policy.viewportScaleCompensationEnabled ||
    typeof viewportWidthPx !== 'number' ||
    !Number.isFinite(viewportWidthPx) ||
    viewportWidthPx <= 0
  ) {
    return {
      effectiveScalePxPerMeter: safeZoom,
      viewportScaleFactor: 1.0,
    };
  }
  const rawFactor = Math.sqrt(
    policy.referenceViewportWidthPx / Math.max(320, viewportWidthPx)
  );
  const factor = clamp(
    rawFactor,
    policy.minViewportScaleFactor,
    policy.maxViewportScaleFactor
  );
  return {
    effectiveScalePxPerMeter: safeZoom * factor,
    viewportScaleFactor: Number(factor.toFixed(4)),
  };
}

function findBandForBoundary(
  fineRes: number,
  coarseRes: number,
  bands: readonly HierarchicalThresholdBand[]
): HierarchicalThresholdBand {
  const exact = bands.find(
    (b) =>
      b.fineResolutionMeters === fineRes && b.coarseResolutionMeters === coarseRes
  );
  if (exact) return exact;
  // Synthesize a geometric midpoint band for non-standard resolution pairs (e.g., direct 1024 <-> 4096)
  const matching = bands.filter(
    (b) =>
      b.fineResolutionMeters >= fineRes && b.coarseResolutionMeters <= coarseRes
  );
  if (matching.length > 0) {
    const outAvg =
      matching.reduce((s, b) => s + b.zoomOutThreshold, 0) / matching.length;
    const inAvg =
      matching.reduce((s, b) => s + b.zoomInThreshold, 0) / matching.length;
    const nomAvg =
      matching.reduce((s, b) => s + b.nominalZoom, 0) / matching.length;
    return {
      fineResolutionMeters: fineRes,
      coarseResolutionMeters: coarseRes,
      nominalZoom: nomAvg,
      zoomOutThreshold: outAvg,
      zoomInThreshold: inAvg,
    };
  }
  // Fallback proportional to 1024 m -> 0.9 px/m
  const nominal = 0.9 * (1024 / fineRes);
  return {
    fineResolutionMeters: fineRes,
    coarseResolutionMeters: coarseRes,
    nominalZoom: nominal,
    zoomOutThreshold: nominal * 0.88,
    zoomInThreshold: nominal * 1.12,
  };
}

function forcedResolutionFromMode(mode: HierarchicalResolutionMode): number | null {
  if (mode === 'force_1024') return 1024;
  if (mode === 'force_2048') return 2048;
  if (mode === 'force_4096') return 4096;
  return null;
}

/**
 * Resolves the target tile resolution (uniform across the viewport) using
 * orthographic screen-space scale and per-boundary hysteresis.
 *
 * Supports direct multi-step jumps (e.g. `1,024 m -> 4,096 m` or `4,096 m -> 1,024 m`)
 * when rapid zooming crosses multiple thresholds in a single step, without requiring
 * intermediate transitions to complete.
 */
export function resolveDesiredHierarchicalResolution(params: {
  availableResolutionsMeters: readonly number[];
  currentResolutionMeters: number | null;
  cameraZoom: number;
  viewportWidthPx?: number | null;
  viewportHeightPx?: number | null;
  policy: HierarchicalResolutionPolicyConfig;
}): HierarchicalScaleEvaluation {
  const sorted = [...params.availableResolutionsMeters].sort((a, b) => a - b);
  if (sorted.length === 0) {
    throw new Error('resolveDesiredHierarchicalResolution requires at least one resolution');
  }

  const { effectiveScalePxPerMeter, viewportScaleFactor } =
    computeEffectiveOrthographicScale(
      params.cameraZoom,
      params.viewportWidthPx,
      params.policy
    );

  const viewportWidthPx =
    typeof params.viewportWidthPx === 'number' &&
    Number.isFinite(params.viewportWidthPx)
      ? params.viewportWidthPx
      : null;
  const viewportHeightPx =
    typeof params.viewportHeightPx === 'number' &&
    Number.isFinite(params.viewportHeightPx)
      ? params.viewportHeightPx
      : null;

  // 1. Forced developer override mode
  const forced = forcedResolutionFromMode(params.policy.mode);
  if (forced !== null) {
    // Choose exact match if available, otherwise nearest available resolution
    let chosen = sorted[0];
    let bestDiff = Math.abs(chosen - forced);
    for (let i = 1; i < sorted.length; i++) {
      const diff = Math.abs(sorted[i] - forced);
      if (diff < bestDiff) {
        bestDiff = diff;
        chosen = sorted[i];
      }
    }
    return {
      rawCameraZoom: params.cameraZoom,
      effectiveScalePxPerMeter: Number(effectiveScalePxPerMeter.toFixed(4)),
      viewportScaleFactor,
      viewportWidthPx,
      viewportHeightPx,
      desiredResolutionMeters: chosen,
      reason: `forced_${params.policy.mode}`,
    };
  }

  if (sorted.length === 1) {
    return {
      rawCameraZoom: params.cameraZoom,
      effectiveScalePxPerMeter: Number(effectiveScalePxPerMeter.toFixed(4)),
      viewportScaleFactor,
      viewportWidthPx,
      viewportHeightPx,
      desiredResolutionMeters: sorted[0],
      reason: 'single_available_resolution',
    };
  }

  // Build boundary bands for each adjacent available resolution pair
  const boundaryBands: HierarchicalThresholdBand[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    boundaryBands.push(
      findBandForBoundary(sorted[i], sorted[i + 1], params.policy.bands)
    );
  }

  // 2. Initial selection (no active resolution yet): use nominal thresholds cleanly
  const currentIdx =
    params.currentResolutionMeters !== null
      ? sorted.indexOf(params.currentResolutionMeters)
      : -1;

  if (currentIdx === -1) {
    let targetIdx = 0;
    for (let i = 0; i < boundaryBands.length; i++) {
      if (effectiveScalePxPerMeter < boundaryBands[i].nominalZoom) {
        targetIdx = i + 1;
      } else {
        break;
      }
    }
    return {
      rawCameraZoom: params.cameraZoom,
      effectiveScalePxPerMeter: Number(effectiveScalePxPerMeter.toFixed(4)),
      viewportScaleFactor,
      viewportWidthPx,
      viewportHeightPx,
      desiredResolutionMeters: sorted[targetIdx],
      reason: 'initial_nominal_scale',
    };
  }

  // 3. Hysteresis-aware stepping from currentIdx (supports multi-step direct jumps!)
  let targetIdx = currentIdx;

  // Step coarser while scale is strictly below the zoom-out threshold of the next boundary
  while (
    targetIdx < boundaryBands.length &&
    effectiveScalePxPerMeter < boundaryBands[targetIdx].zoomOutThreshold
  ) {
    targetIdx += 1;
  }

  // If we didn't step coarser, check if scale rose strictly above the zoom-in threshold(s)
  if (targetIdx === currentIdx) {
    while (
      targetIdx > 0 &&
      effectiveScalePxPerMeter > boundaryBands[targetIdx - 1].zoomInThreshold
    ) {
      targetIdx -= 1;
    }
  }

  const reason =
    targetIdx === currentIdx
      ? 'hysteresis_hold'
      : targetIdx > currentIdx
        ? targetIdx - currentIdx > 1
          ? 'direct_zoom_out_jump'
          : 'zoom_out_threshold'
        : currentIdx - targetIdx > 1
          ? 'direct_zoom_in_jump'
          : 'zoom_in_threshold';

  return {
    rawCameraZoom: params.cameraZoom,
    effectiveScalePxPerMeter: Number(effectiveScalePxPerMeter.toFixed(4)),
    viewportScaleFactor,
    viewportWidthPx,
    viewportHeightPx,
    desiredResolutionMeters: sorted[targetIdx],
    reason,
  };
}

/**
 * Computes effective physical preload and retention margins (in meters) for a given
 * resolution level, preventing oversized retention zones on 4,096 m tiles while
 * preserving smooth lookahead at 1,024 m.
 */
export function resolvePhysicalMarginsForResolution(
  tileSizeMeters: number,
  policy: HierarchicalResolutionPolicyConfig,
  override?: {
    preloadMarginMeters?: number;
    retainMarginMeters?: number;
  }
): {
  preloadMarginMeters: number;
  retainMarginMeters: number;
  effectivePreloadMarginTiles: number;
  effectiveRetainMarginTiles: number;
} {
  const preloadMeters =
    typeof override?.preloadMarginMeters === 'number' &&
    Number.isFinite(override.preloadMarginMeters) &&
    override.preloadMarginMeters >= 0
      ? override.preloadMarginMeters
      : policy.preloadMarginMeters;
  const retainMeters =
    typeof override?.retainMarginMeters === 'number' &&
    Number.isFinite(override.retainMarginMeters) &&
    override.retainMarginMeters >= preloadMeters
      ? override.retainMarginMeters
      : Math.max(preloadMeters, policy.retainMarginMeters);

  const safeTileSize = Math.max(1, tileSizeMeters);
  return {
    preloadMarginMeters: preloadMeters,
    retainMarginMeters: retainMeters,
    effectivePreloadMarginTiles: Number((preloadMeters / safeTileSize).toFixed(3)),
    effectiveRetainMarginTiles: Number((retainMeters / safeTileSize).toFixed(3)),
  };
}

/**
 * Parses developer URL query overrides for hierarchical tile streaming without recompilation:
 * - `?hierarchicalMode=auto|1024|2048|4096|force_1024|force_2048|force_4096`
 * - `?hierarchicalThresholds=out1024,in1024,out2048,in2048` (e.g. `0.8,1.0,0.26,0.34`)
 * - `?hierarchicalViewportComp=0|1`
 * - `?hierarchicalPreloadMeters=1024`
 * - `?hierarchicalRetainMeters=2048`
 */
export function parseHierarchicalPolicyFromSearch(
  search: string
): Partial<HierarchicalResolutionPolicyConfig> | null {
  if (!search) return null;
  const params = new URLSearchParams(search);
  const partial: Partial<HierarchicalResolutionPolicyConfig> = {};
  let hasAny = false;

  const modeRaw = params.get('hierarchicalMode')?.trim();
  if (modeRaw) {
    partial.mode = normalizeHierarchicalResolutionMode(modeRaw);
    hasAny = true;
  }

  const thresholdsRaw = params.get('hierarchicalThresholds')?.trim();
  if (thresholdsRaw) {
    const nums = thresholdsRaw.split(',').map((s) => Number(s.trim()));
    if (
      nums.length === 4 &&
      nums.every((n) => Number.isFinite(n) && n > 0) &&
      nums[0] <= nums[1] &&
      nums[2] <= nums[3]
    ) {
      partial.bands = [
        {
          fineResolutionMeters: 1024,
          coarseResolutionMeters: 2048,
          nominalZoom: (nums[0] + nums[1]) * 0.5,
          zoomOutThreshold: nums[0],
          zoomInThreshold: nums[1],
        },
        {
          fineResolutionMeters: 2048,
          coarseResolutionMeters: 4096,
          nominalZoom: (nums[2] + nums[3]) * 0.5,
          zoomOutThreshold: nums[2],
          zoomInThreshold: nums[3],
        },
      ];
      hasAny = true;
    }
  }

  const compRaw = params.get('hierarchicalViewportComp')?.trim();
  if (compRaw === '0' || compRaw === 'false') {
    partial.viewportScaleCompensationEnabled = false;
    hasAny = true;
  } else if (compRaw === '1' || compRaw === 'true') {
    partial.viewportScaleCompensationEnabled = true;
    hasAny = true;
  }

  const preloadRaw = params.get('hierarchicalPreloadMeters')?.trim();
  if (preloadRaw) {
    const val = Number(preloadRaw);
    if (Number.isFinite(val) && val >= 0) {
      partial.preloadMarginMeters = val;
      hasAny = true;
    }
  }

  const retainRaw = params.get('hierarchicalRetainMeters')?.trim();
  if (retainRaw) {
    const val = Number(retainRaw);
    if (Number.isFinite(val) && val >= 0) {
      partial.retainMarginMeters = val;
      hasAny = true;
    }
  }

  return hasAny ? partial : null;
}
