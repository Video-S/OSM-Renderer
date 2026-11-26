/**
 * Frame-Budgeted Streaming & Resolution Transition Configuration (TKT-041-F1)
 *
 * Provides separable feature flags and presets for evaluating:
 *  1. `tkt041_baseline`        — TKT-041 behavior (no shared F1 scheduler, no incremental GPU prep, sync disposal, 0 ms debounce)
 *  2. `scheduler_only`         — Shared time-aware streaming workload scheduler (configurable 1 / 2 / 4 ms frame budget)
 *  3. `incremental_gpu_only`   — Incremental offscreen GPU buffer preparation before atomic resolution activation
 *  4. `deferred_disposal_only` — Immediate detach + bounded deferred disposal queue across subsequent frames
 *  5. `debounce_reuse_only`    — Configurable transition debounce (100–250 ms) + destination preparation reuse & speculative suppression
 *  6. `combined`               — All TKT-041-F1 mechanisms active together
 *
 * Preserves TKT-040 `combined` worker preparation as default throughout.
 */

export type StreamingF1VariantId =
  | 'tkt041_baseline'
  | 'scheduler_only'
  | 'incremental_gpu_only'
  | 'deferred_disposal_only'
  | 'debounce_reuse_only'
  | 'combined'
  | 'combined_prewarm';

export interface StreamingFrameBudgetConfig {
  /** Enable the shared time-aware per-frame streaming workload scheduler. */
  sharedSchedulerEnabled: boolean;
  /** Target per-frame synchronous streaming work budget in milliseconds (experimental sweep: 1, 2, 4 ms). */
  frameStreamingBudgetMs: number;
  /** Enable incremental offscreen GPU resource preparation before atomic resolution activation. */
  incrementalGpuPrepEnabled: boolean;
  /** Maximum estimated GPU buffer bytes submitted per frame during incremental GPU preparation. */
  maxGpuUploadBytesPerFrame: number;
  /** Maximum mesh/instanced-batch upload units submitted per frame during incremental GPU preparation. */
  maxGpuUploadUnitsPerFrame: number;
  /** Enable bounded deferred disposal queue (immediate detach from rendering/picking, paced dispose()). */
  deferredDisposalEnabled: boolean;
  /** Maximum tiles physically disposed per frame under normal memory pressure. */
  maxDeferredDisposeTilesPerFrame: number;
  /** Pending-disposal byte cap above which disposal accelerates to reclaim memory faster. */
  maxPendingDisposalBytes: number;
  /** Short debounce in ms before starting a zoom-band resolution transition (experimental sweep: 100–250 ms; 0 disables). */
  transitionDebounceMs: number;
  /** Reuse valid destination preparation work and reprioritize instead of indiscriminately restarting during continuous movement. */
  reuseDestinationPreparation: boolean;
  /** Suppress speculative non-visible fetches when active viewport has missing visible coverage. */
  suppressSpeculativeDuringActiveCoverageGap: boolean;
  /** Defer tile-boundary overlay geometry rebuilds while the overlay is hidden until shown. */
  deferHiddenBoundaryOverlayRebuild: boolean;
  /**
   * Section 12: When a resolution transition is pending, prevent non-visible active preload
   * and speculative destination preload from contending for fetch/worker slots or worker
   * backpressure with required visible destination tiles (never starves active visible coverage).
   */
  prioritizeDestinationOverActivePreload: boolean;
  /**
   * Section 12: Evaluate preparing visible tiles of the approaching next resolution before
   * crossing its activation threshold, strictly subject to memory headroom and workload budgets.
   */
  predictivePrewarmEnabled: boolean;
  /**
   * Approach band factor (fraction of threshold distance, e.g. 0.25) within which predictive
   * pre-warming may prepare the adjacent resolution level.
   */
  predictivePrewarmBandFraction: number;
  /**
   * Minimum free memory headroom fraction of `totalMemoryBudgetBytes` required to permit
   * predictive pre-warming (default: 0.30).
   */
  predictivePrewarmMinHeadroomRatio: number;
}

const MIB = 1024 * 1024;

export const STREAMING_F1_VARIANTS: Readonly<
  Record<StreamingF1VariantId, StreamingFrameBudgetConfig>
> = {
  tkt041_baseline: {
    sharedSchedulerEnabled: false,
    frameStreamingBudgetMs: 4.0,
    incrementalGpuPrepEnabled: false,
    maxGpuUploadBytesPerFrame: 4 * MIB,
    maxGpuUploadUnitsPerFrame: 4,
    deferredDisposalEnabled: false,
    maxDeferredDisposeTilesPerFrame: 1,
    maxPendingDisposalBytes: 128 * MIB,
    transitionDebounceMs: 0,
    reuseDestinationPreparation: false,
    suppressSpeculativeDuringActiveCoverageGap: false,
    deferHiddenBoundaryOverlayRebuild: false,
    prioritizeDestinationOverActivePreload: false,
    predictivePrewarmEnabled: false,
    predictivePrewarmBandFraction: 0.25,
    predictivePrewarmMinHeadroomRatio: 0.3,
  },
  scheduler_only: {
    sharedSchedulerEnabled: true,
    frameStreamingBudgetMs: 2.0,
    incrementalGpuPrepEnabled: false,
    maxGpuUploadBytesPerFrame: 4 * MIB,
    maxGpuUploadUnitsPerFrame: 4,
    deferredDisposalEnabled: false,
    maxDeferredDisposeTilesPerFrame: 1,
    maxPendingDisposalBytes: 128 * MIB,
    transitionDebounceMs: 0,
    reuseDestinationPreparation: false,
    suppressSpeculativeDuringActiveCoverageGap: true,
    deferHiddenBoundaryOverlayRebuild: true,
    prioritizeDestinationOverActivePreload: true,
    predictivePrewarmEnabled: false,
    predictivePrewarmBandFraction: 0.25,
    predictivePrewarmMinHeadroomRatio: 0.3,
  },
  incremental_gpu_only: {
    sharedSchedulerEnabled: false,
    frameStreamingBudgetMs: 2.0,
    incrementalGpuPrepEnabled: true,
    maxGpuUploadBytesPerFrame: 4 * MIB,
    maxGpuUploadUnitsPerFrame: 4,
    deferredDisposalEnabled: false,
    maxDeferredDisposeTilesPerFrame: 1,
    maxPendingDisposalBytes: 128 * MIB,
    transitionDebounceMs: 0,
    reuseDestinationPreparation: false,
    suppressSpeculativeDuringActiveCoverageGap: false,
    deferHiddenBoundaryOverlayRebuild: false,
    prioritizeDestinationOverActivePreload: false,
    predictivePrewarmEnabled: false,
    predictivePrewarmBandFraction: 0.25,
    predictivePrewarmMinHeadroomRatio: 0.3,
  },
  deferred_disposal_only: {
    sharedSchedulerEnabled: false,
    frameStreamingBudgetMs: 2.0,
    incrementalGpuPrepEnabled: false,
    maxGpuUploadBytesPerFrame: 4 * MIB,
    maxGpuUploadUnitsPerFrame: 4,
    deferredDisposalEnabled: true,
    maxDeferredDisposeTilesPerFrame: 1,
    maxPendingDisposalBytes: 128 * MIB,
    transitionDebounceMs: 0,
    reuseDestinationPreparation: false,
    suppressSpeculativeDuringActiveCoverageGap: false,
    deferHiddenBoundaryOverlayRebuild: false,
    prioritizeDestinationOverActivePreload: false,
    predictivePrewarmEnabled: false,
    predictivePrewarmBandFraction: 0.25,
    predictivePrewarmMinHeadroomRatio: 0.3,
  },
  debounce_reuse_only: {
    sharedSchedulerEnabled: false,
    frameStreamingBudgetMs: 2.0,
    incrementalGpuPrepEnabled: false,
    maxGpuUploadBytesPerFrame: 4 * MIB,
    maxGpuUploadUnitsPerFrame: 4,
    deferredDisposalEnabled: false,
    maxDeferredDisposeTilesPerFrame: 1,
    maxPendingDisposalBytes: 128 * MIB,
    transitionDebounceMs: 150,
    reuseDestinationPreparation: true,
    suppressSpeculativeDuringActiveCoverageGap: true,
    deferHiddenBoundaryOverlayRebuild: true,
    prioritizeDestinationOverActivePreload: true,
    predictivePrewarmEnabled: false,
    predictivePrewarmBandFraction: 0.25,
    predictivePrewarmMinHeadroomRatio: 0.3,
  },
  combined: {
    sharedSchedulerEnabled: true,
    frameStreamingBudgetMs: 2.0,
    incrementalGpuPrepEnabled: true,
    maxGpuUploadBytesPerFrame: 4 * MIB,
    maxGpuUploadUnitsPerFrame: 4,
    deferredDisposalEnabled: true,
    maxDeferredDisposeTilesPerFrame: 1,
    maxPendingDisposalBytes: 128 * MIB,
    transitionDebounceMs: 150,
    reuseDestinationPreparation: true,
    suppressSpeculativeDuringActiveCoverageGap: true,
    deferHiddenBoundaryOverlayRebuild: true,
    prioritizeDestinationOverActivePreload: true,
    predictivePrewarmEnabled: false,
    predictivePrewarmBandFraction: 0.25,
    predictivePrewarmMinHeadroomRatio: 0.3,
  },
  combined_prewarm: {
    sharedSchedulerEnabled: true,
    frameStreamingBudgetMs: 2.0,
    incrementalGpuPrepEnabled: true,
    maxGpuUploadBytesPerFrame: 4 * MIB,
    maxGpuUploadUnitsPerFrame: 4,
    deferredDisposalEnabled: true,
    maxDeferredDisposeTilesPerFrame: 1,
    maxPendingDisposalBytes: 128 * MIB,
    transitionDebounceMs: 150,
    reuseDestinationPreparation: true,
    suppressSpeculativeDuringActiveCoverageGap: true,
    deferHiddenBoundaryOverlayRebuild: true,
    prioritizeDestinationOverActivePreload: true,
    predictivePrewarmEnabled: true,
    predictivePrewarmBandFraction: 0.25,
    predictivePrewarmMinHeadroomRatio: 0.3,
  },
};

/**
 * Default interactive app configuration (full TKT-041-F1 combined pipeline).
 * Note: Individual thresholds (`frameStreamingBudgetMs = 2.0`, `transitionDebounceMs = 150`)
 * are provisional starting points meant to be evaluated on hardware.
 */
export const DEFAULT_STREAMING_FRAME_BUDGET_CONFIG: StreamingFrameBudgetConfig = {
  ...STREAMING_F1_VARIANTS.combined,
};

/**
 * Default headless/direct TileStreamManager configuration when no explicit F1 config
 * is passed: enables the F1 frame-budgeted mechanics while keeping `transitionDebounceMs = 0`
 * so synchronous unit tests expecting immediate zoom-band transitions remain deterministic.
 */
export const DEFAULT_MANAGER_STREAMING_FRAME_BUDGET_CONFIG: StreamingFrameBudgetConfig = {
  ...STREAMING_F1_VARIANTS.combined,
  transitionDebounceMs: 0,
};

function clampFinite(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeStreamingFrameBudgetConfig(
  input?: Partial<StreamingFrameBudgetConfig>,
  base: StreamingFrameBudgetConfig = DEFAULT_STREAMING_FRAME_BUDGET_CONFIG
): StreamingFrameBudgetConfig {
  const src = input ?? {};
  return {
    sharedSchedulerEnabled:
      typeof src.sharedSchedulerEnabled === 'boolean'
        ? src.sharedSchedulerEnabled
        : base.sharedSchedulerEnabled,
    frameStreamingBudgetMs: clampFinite(
      src.frameStreamingBudgetMs,
      base.frameStreamingBudgetMs,
      0.25,
      50
    ),
    incrementalGpuPrepEnabled:
      typeof src.incrementalGpuPrepEnabled === 'boolean'
        ? src.incrementalGpuPrepEnabled
        : base.incrementalGpuPrepEnabled,
    maxGpuUploadBytesPerFrame: Math.round(
      clampFinite(
        src.maxGpuUploadBytesPerFrame,
        base.maxGpuUploadBytesPerFrame,
        64 * 1024,
        256 * MIB
      )
    ),
    maxGpuUploadUnitsPerFrame: Math.round(
      clampFinite(
        src.maxGpuUploadUnitsPerFrame,
        base.maxGpuUploadUnitsPerFrame,
        1,
        128
      )
    ),
    deferredDisposalEnabled:
      typeof src.deferredDisposalEnabled === 'boolean'
        ? src.deferredDisposalEnabled
        : base.deferredDisposalEnabled,
    maxDeferredDisposeTilesPerFrame: Math.round(
      clampFinite(
        src.maxDeferredDisposeTilesPerFrame,
        base.maxDeferredDisposeTilesPerFrame,
        1,
        64
      )
    ),
    maxPendingDisposalBytes: Math.round(
      clampFinite(
        src.maxPendingDisposalBytes,
        base.maxPendingDisposalBytes,
        1 * MIB,
        2048 * MIB
      )
    ),
    transitionDebounceMs: Math.round(
      clampFinite(src.transitionDebounceMs, base.transitionDebounceMs, 0, 2000)
    ),
    reuseDestinationPreparation:
      typeof src.reuseDestinationPreparation === 'boolean'
        ? src.reuseDestinationPreparation
        : base.reuseDestinationPreparation,
    suppressSpeculativeDuringActiveCoverageGap:
      typeof src.suppressSpeculativeDuringActiveCoverageGap === 'boolean'
        ? src.suppressSpeculativeDuringActiveCoverageGap
        : base.suppressSpeculativeDuringActiveCoverageGap,
    deferHiddenBoundaryOverlayRebuild:
      typeof src.deferHiddenBoundaryOverlayRebuild === 'boolean'
        ? src.deferHiddenBoundaryOverlayRebuild
        : base.deferHiddenBoundaryOverlayRebuild,
    prioritizeDestinationOverActivePreload:
      typeof src.prioritizeDestinationOverActivePreload === 'boolean'
        ? src.prioritizeDestinationOverActivePreload
        : base.prioritizeDestinationOverActivePreload,
    predictivePrewarmEnabled:
      typeof src.predictivePrewarmEnabled === 'boolean'
        ? src.predictivePrewarmEnabled
        : base.predictivePrewarmEnabled,
    predictivePrewarmBandFraction: clampFinite(
      src.predictivePrewarmBandFraction,
      base.predictivePrewarmBandFraction,
      0.05,
      1.0
    ),
    predictivePrewarmMinHeadroomRatio: clampFinite(
      src.predictivePrewarmMinHeadroomRatio,
      base.predictivePrewarmMinHeadroomRatio,
      0.05,
      0.9
    ),
  };
}

export function resolveStreamingFrameBudgetConfig(
  input?: StreamingF1VariantId | Partial<StreamingFrameBudgetConfig>,
  base: StreamingFrameBudgetConfig = DEFAULT_STREAMING_FRAME_BUDGET_CONFIG
): StreamingFrameBudgetConfig {
  if (!input) {
    return { ...base };
  }
  if (typeof input === 'string') {
    const preset = STREAMING_F1_VARIANTS[input];
    if (!preset) {
      throw new Error(`Unknown StreamingF1VariantId: "${input}"`);
    }
    return { ...preset };
  }
  return normalizeStreamingFrameBudgetConfig(input, base);
}

export function identifyStreamingF1Variant(
  config: StreamingFrameBudgetConfig
): StreamingF1VariantId | 'custom' {
  for (const [variantId, preset] of Object.entries(STREAMING_F1_VARIANTS) as Array<
    [StreamingF1VariantId, StreamingFrameBudgetConfig]
  >) {
    if (
      config.sharedSchedulerEnabled === preset.sharedSchedulerEnabled &&
      config.incrementalGpuPrepEnabled === preset.incrementalGpuPrepEnabled &&
      config.deferredDisposalEnabled === preset.deferredDisposalEnabled &&
      config.reuseDestinationPreparation === preset.reuseDestinationPreparation &&
      config.suppressSpeculativeDuringActiveCoverageGap ===
        preset.suppressSpeculativeDuringActiveCoverageGap &&
      config.deferHiddenBoundaryOverlayRebuild ===
        preset.deferHiddenBoundaryOverlayRebuild &&
      config.prioritizeDestinationOverActivePreload ===
        preset.prioritizeDestinationOverActivePreload &&
      config.predictivePrewarmEnabled === preset.predictivePrewarmEnabled &&
      (preset.transitionDebounceMs === 0
        ? config.transitionDebounceMs === 0
        : config.transitionDebounceMs > 0)
    ) {
      return variantId;
    }
  }
  return 'custom';
}

export function parseStreamingFrameBudgetFromSearch(
  search: string
): Partial<StreamingFrameBudgetConfig> | null {
  if (!search) return null;
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  let found = false;
  let result: Partial<StreamingFrameBudgetConfig> = {};

  const variantParam = params.get('streamingF1Variant');
  if (variantParam && variantParam in STREAMING_F1_VARIANTS) {
    result = { ...STREAMING_F1_VARIANTS[variantParam as StreamingF1VariantId] };
    found = true;
  }

  const budgetMs = params.get('frameStreamingBudgetMs');
  if (budgetMs !== null && Number.isFinite(Number(budgetMs))) {
    result.frameStreamingBudgetMs = Number(budgetMs);
    found = true;
  }

  const debounceMs = params.get('transitionDebounceMs');
  if (debounceMs !== null && Number.isFinite(Number(debounceMs))) {
    result.transitionDebounceMs = Number(debounceMs);
    found = true;
  }

  const gpuPrep = params.get('incrementalGpuPrep');
  if (gpuPrep === '0' || gpuPrep === 'false') {
    result.incrementalGpuPrepEnabled = false;
    found = true;
  } else if (gpuPrep === '1' || gpuPrep === 'true') {
    result.incrementalGpuPrepEnabled = true;
    found = true;
  }

  const deferredDispose = params.get('deferredDisposal');
  if (deferredDispose === '0' || deferredDispose === 'false') {
    result.deferredDisposalEnabled = false;
    found = true;
  } else if (deferredDispose === '1' || deferredDispose === 'true') {
    result.deferredDisposalEnabled = true;
    found = true;
  }

  const gpuBytesMb = params.get('maxGpuUploadMb');
  if (gpuBytesMb !== null && Number.isFinite(Number(gpuBytesMb))) {
    result.maxGpuUploadBytesPerFrame = Math.round(Number(gpuBytesMb) * MIB);
    found = true;
  }

  const prewarm = params.get('predictivePrewarm');
  if (prewarm === '0' || prewarm === 'false') {
    result.predictivePrewarmEnabled = false;
    found = true;
  } else if (prewarm === '1' || prewarm === 'true') {
    result.predictivePrewarmEnabled = true;
    found = true;
  }

  const destPriority = params.get('prioritizeDestination');
  if (destPriority === '0' || destPriority === 'false') {
    result.prioritizeDestinationOverActivePreload = false;
    found = true;
  } else if (destPriority === '1' || destPriority === 'true') {
    result.prioritizeDestinationOverActivePreload = true;
    found = true;
  }

  return found ? result : null;
}
