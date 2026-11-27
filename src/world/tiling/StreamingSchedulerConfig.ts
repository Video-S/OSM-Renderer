/**
 * Frame-Budgeted Streaming, Throughput & Resolution Transition Configuration (TKT-041-F1 / TKT-041-F2)
 *
 * Provides separable feature flags and presets for evaluating:
 *  TKT-041-F1 variants:
 *   1. `tkt041_baseline`            — TKT-041 behavior (no shared F1 scheduler, no incremental GPU prep, sync disposal, 0 ms debounce)
 *   2. `scheduler_only`             — Shared time-aware streaming workload scheduler (configurable 1 / 2 / 4 ms frame budget)
 *   3. `incremental_gpu_only`       — Incremental offscreen GPU buffer preparation before atomic resolution activation
 *   4. `deferred_disposal_only`     — Immediate detach + bounded deferred disposal queue across subsequent frames
 *   5. `debounce_reuse_only`        — Configurable transition debounce (100–250 ms) + destination preparation reuse & speculative suppression
 *   6. `combined`                   — All TKT-041-F1 mechanisms active together (without predictive pre-warming)
 *   7. `combined_prewarm`           — TKT-041-F1 reference baseline with zoom-band predictive pre-warming
 *
 *  TKT-041-F2 staged throughput & transition-latency variants:
 *   8. `f2_independent_pipeline`    — Work Package B: Decoupled HTTP retrieval queue, bounded retrieved-payload byte queue,
 *                                     independent worker preparation queue, bounded prepared-payload byte queue, and
 *                                     oversized-payload (>160 MB) forward-progress admission
 *   9. `f2_destination_scheduling`  — Work Package B + C: 5-class priority scheduling, reserved destination fetch & worker slots,
 *                                     dynamic queue reprioritization without restart, age escalation, and tail-tile priority boost
 *  10. `f2_tuned_concurrency`       — Work Package B + C + D: Tuned HTTP retrieval concurrency (8), worker concurrency (4),
 *                                     compressed HTTP transfer (?compressed=1 + worker deflate), and time-governed transition GPU upload cap
 *  11. `f2_latency_aware_prewarm`   — Work Package B + C + E: Adaptive latency-aware preparation horizon using zoom/pan velocity,
 *                                     historical resolution preparation latency, predicted activation viewport intersection, and reversal retention
 *  12. `f2_combined`                — All TKT-041-F2 throughput & transition-latency improvements combined (production default)
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
  | 'combined_prewarm'
  | 'f2_independent_pipeline'
  | 'f2_destination_scheduling'
  | 'f2_tuned_concurrency'
  | 'f2_latency_aware_prewarm'
  | 'f2_combined';

export type StreamingF2VariantId =
  | 'combined_prewarm'
  | 'f2_independent_pipeline'
  | 'f2_destination_scheduling'
  | 'f2_tuned_concurrency'
  | 'f2_latency_aware_prewarm'
  | 'f2_combined';

export const STREAMING_F2_COMPARISON_VARIANTS: readonly StreamingF2VariantId[] = [
  'combined_prewarm',
  'f2_independent_pipeline',
  'f2_destination_scheduling',
  'f2_tuned_concurrency',
  'f2_latency_aware_prewarm',
  'f2_combined',
];

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

  // --- TKT-041-F2 Work Package B: Independent Bounded Pipeline Stages & Byte Backpressure ---
  /**
   * Decouple HTTP retrieval from worker decoding so HTTP fetch slots release immediately
   * upon `response.arrayBuffer()` completion into a bounded retrieved-payload byte queue.
   */
  independentPipelineStagesEnabled: boolean;
  /** Maximum concurrent in-flight HTTP tile payload retrievals (WP D sweep: 6, 8, 12). */
  maxConcurrentHttpRetrievals: number;
  /** Maximum concurrent Web Worker tile preparation jobs (WP D sweep: 2, 4). */
  workerConcurrency: number;
  /** Maximum reserved bytes for in-flight HTTP response retrieval. */
  maxInFlightHttpReservationBytes: number;
  /** Maximum bytes queued in the retrieved-payload queue awaiting worker dispatch. */
  maxRetrievedPayloadQueueBytes: number;
  /** Maximum estimated bytes concurrently undergoing Web Worker preparation. */
  maxWorkerPreparationBytes: number;
  /** Maximum estimated bytes queued in the prepared-payload queue awaiting main-thread reconstruction. */
  maxPreparedPayloadQueueBytes: number;
  /** Maximum estimated geometry bytes reconstructed and awaiting incremental GPU preparation. */
  maxReconstructedAwaitingGpuBytes: number;

  // --- TKT-041-F2 Work Package C: Destination Throughput, Fairness & Dynamic Reprioritization ---
  /** Reserved HTTP retrieval slots for required pending destination coverage during continuous movement. */
  reservedDestinationFetchSlots: number;
  /** Reserved Web Worker slots for required pending destination coverage during continuous movement. */
  reservedDestinationWorkerSlots: number;
  /** Dynamically reprioritize queued HTTP, retrieved-payload, and worker decode jobs on camera movement without restarting valid in-flight work. */
  dynamicQueueReprioritizationEnabled: boolean;
  /** Allow an already-running worker decode job to complete and populate inactive cache when beneficial and memory permits. */
  retainRunningWorkerJobOnDemotion: boolean;
  /** Prioritize the oldest/slowest remaining required destination tiles ("tail tiles") to complete atomic transitions earlier. */
  tailTilePriorityBoostEnabled: boolean;
  /** Age interval in ms per priority escalation step for waiting required destination tiles. */
  destinationAgeEscalationMs: number;

  // --- TKT-041-F2 Work Package D: Compressed Transfer & Time-Governed Transition Throughput ---
  /** Request deflate-compressed OSMTILE1 payloads (?compressed=1) over HTTP and inflate in parallel Web Workers. */
  useCompressedHttpTransfer: boolean;

  // --- TKT-041-F2 Work Package E: Adaptive Latency-Aware Preparation Horizon & Predicted Coverage ---
  /** Enable latency-aware adaptive preparation horizon based on zoom/pan velocity and historical resolution preparation latency. */
  adaptivePrewarmHorizonEnabled: boolean;
  /** Lead-time multiplier applied to historical resolution transition preparation latency when estimating adaptive horizon. */
  adaptivePrewarmLeadMultiplier: number;
  /** Retain pre-warmed destination tiles across brief zoom-direction reversals when memory budget permits. */
  retainPrewarmAcrossReversals: boolean;
}

const MIB = 1024 * 1024;

const F1_PIPELINE_DEFAULTS = {
  independentPipelineStagesEnabled: false,
  maxConcurrentHttpRetrievals: 6,
  workerConcurrency: 2,
  maxInFlightHttpReservationBytes: 256 * MIB,
  maxRetrievedPayloadQueueBytes: 256 * MIB,
  maxWorkerPreparationBytes: 384 * MIB,
  maxPreparedPayloadQueueBytes: 256 * MIB,
  maxReconstructedAwaitingGpuBytes: 384 * MIB,
  reservedDestinationFetchSlots: 0,
  reservedDestinationWorkerSlots: 0,
  dynamicQueueReprioritizationEnabled: false,
  retainRunningWorkerJobOnDemotion: false,
  tailTilePriorityBoostEnabled: false,
  destinationAgeEscalationMs: 250,
  useCompressedHttpTransfer: false,
  adaptivePrewarmHorizonEnabled: false,
  adaptivePrewarmLeadMultiplier: 1.35,
  retainPrewarmAcrossReversals: false,
} as const;

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
    ...F1_PIPELINE_DEFAULTS,
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
    ...F1_PIPELINE_DEFAULTS,
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
    ...F1_PIPELINE_DEFAULTS,
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
    ...F1_PIPELINE_DEFAULTS,
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
    ...F1_PIPELINE_DEFAULTS,
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
    ...F1_PIPELINE_DEFAULTS,
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
    ...F1_PIPELINE_DEFAULTS,
  },
  f2_independent_pipeline: {
    sharedSchedulerEnabled: true,
    frameStreamingBudgetMs: 2.0,
    incrementalGpuPrepEnabled: true,
    maxGpuUploadBytesPerFrame: 4 * MIB,
    maxGpuUploadUnitsPerFrame: 4,
    deferredDisposalEnabled: true,
    maxDeferredDisposeTilesPerFrame: 1,
    maxPendingDisposalBytes: 128 * MIB,
    transitionDebounceMs: 120,
    reuseDestinationPreparation: true,
    suppressSpeculativeDuringActiveCoverageGap: true,
    deferHiddenBoundaryOverlayRebuild: true,
    prioritizeDestinationOverActivePreload: true,
    predictivePrewarmEnabled: true,
    predictivePrewarmBandFraction: 0.25,
    predictivePrewarmMinHeadroomRatio: 0.3,
    ...F1_PIPELINE_DEFAULTS,
    independentPipelineStagesEnabled: true,
  },
  f2_destination_scheduling: {
    sharedSchedulerEnabled: true,
    frameStreamingBudgetMs: 2.0,
    incrementalGpuPrepEnabled: true,
    maxGpuUploadBytesPerFrame: 4 * MIB,
    maxGpuUploadUnitsPerFrame: 4,
    deferredDisposalEnabled: true,
    maxDeferredDisposeTilesPerFrame: 1,
    maxPendingDisposalBytes: 128 * MIB,
    transitionDebounceMs: 100,
    reuseDestinationPreparation: true,
    suppressSpeculativeDuringActiveCoverageGap: true,
    deferHiddenBoundaryOverlayRebuild: true,
    prioritizeDestinationOverActivePreload: true,
    predictivePrewarmEnabled: true,
    predictivePrewarmBandFraction: 0.25,
    predictivePrewarmMinHeadroomRatio: 0.3,
    ...F1_PIPELINE_DEFAULTS,
    independentPipelineStagesEnabled: true,
    reservedDestinationFetchSlots: 2,
    reservedDestinationWorkerSlots: 1,
    dynamicQueueReprioritizationEnabled: true,
    retainRunningWorkerJobOnDemotion: true,
    tailTilePriorityBoostEnabled: true,
    destinationAgeEscalationMs: 200,
  },
  f2_tuned_concurrency: {
    sharedSchedulerEnabled: true,
    frameStreamingBudgetMs: 2.0,
    incrementalGpuPrepEnabled: true,
    maxGpuUploadBytesPerFrame: 24 * MIB,
    maxGpuUploadUnitsPerFrame: 16,
    deferredDisposalEnabled: true,
    maxDeferredDisposeTilesPerFrame: 1,
    maxPendingDisposalBytes: 128 * MIB,
    transitionDebounceMs: 100,
    reuseDestinationPreparation: true,
    suppressSpeculativeDuringActiveCoverageGap: true,
    deferHiddenBoundaryOverlayRebuild: true,
    prioritizeDestinationOverActivePreload: true,
    predictivePrewarmEnabled: true,
    predictivePrewarmBandFraction: 0.25,
    predictivePrewarmMinHeadroomRatio: 0.3,
    ...F1_PIPELINE_DEFAULTS,
    independentPipelineStagesEnabled: true,
    maxConcurrentHttpRetrievals: 8,
    workerConcurrency: 4,
    maxInFlightHttpReservationBytes: 384 * MIB,
    maxRetrievedPayloadQueueBytes: 384 * MIB,
    maxWorkerPreparationBytes: 512 * MIB,
    maxPreparedPayloadQueueBytes: 384 * MIB,
    maxReconstructedAwaitingGpuBytes: 512 * MIB,
    reservedDestinationFetchSlots: 3,
    reservedDestinationWorkerSlots: 2,
    dynamicQueueReprioritizationEnabled: true,
    retainRunningWorkerJobOnDemotion: true,
    tailTilePriorityBoostEnabled: true,
    destinationAgeEscalationMs: 200,
    useCompressedHttpTransfer: true,
  },
  f2_latency_aware_prewarm: {
    sharedSchedulerEnabled: true,
    frameStreamingBudgetMs: 2.0,
    incrementalGpuPrepEnabled: true,
    maxGpuUploadBytesPerFrame: 12 * MIB,
    maxGpuUploadUnitsPerFrame: 10,
    deferredDisposalEnabled: true,
    maxDeferredDisposeTilesPerFrame: 1,
    maxPendingDisposalBytes: 128 * MIB,
    transitionDebounceMs: 100,
    reuseDestinationPreparation: true,
    suppressSpeculativeDuringActiveCoverageGap: true,
    deferHiddenBoundaryOverlayRebuild: true,
    prioritizeDestinationOverActivePreload: true,
    predictivePrewarmEnabled: true,
    predictivePrewarmBandFraction: 0.38,
    predictivePrewarmMinHeadroomRatio: 0.25,
    ...F1_PIPELINE_DEFAULTS,
    independentPipelineStagesEnabled: true,
    reservedDestinationFetchSlots: 2,
    reservedDestinationWorkerSlots: 1,
    dynamicQueueReprioritizationEnabled: true,
    retainRunningWorkerJobOnDemotion: true,
    tailTilePriorityBoostEnabled: true,
    destinationAgeEscalationMs: 200,
    adaptivePrewarmHorizonEnabled: true,
    adaptivePrewarmLeadMultiplier: 1.4,
    retainPrewarmAcrossReversals: true,
  },
  f2_combined: {
    sharedSchedulerEnabled: true,
    frameStreamingBudgetMs: 2.0,
    incrementalGpuPrepEnabled: true,
    maxGpuUploadBytesPerFrame: 24 * MIB,
    maxGpuUploadUnitsPerFrame: 16,
    deferredDisposalEnabled: true,
    maxDeferredDisposeTilesPerFrame: 1,
    maxPendingDisposalBytes: 128 * MIB,
    transitionDebounceMs: 100,
    reuseDestinationPreparation: true,
    suppressSpeculativeDuringActiveCoverageGap: true,
    deferHiddenBoundaryOverlayRebuild: true,
    prioritizeDestinationOverActivePreload: true,
    predictivePrewarmEnabled: true,
    predictivePrewarmBandFraction: 0.38,
    predictivePrewarmMinHeadroomRatio: 0.25,
    independentPipelineStagesEnabled: true,
    maxConcurrentHttpRetrievals: 8,
    workerConcurrency: 4,
    maxInFlightHttpReservationBytes: 384 * MIB,
    maxRetrievedPayloadQueueBytes: 384 * MIB,
    maxWorkerPreparationBytes: 512 * MIB,
    maxPreparedPayloadQueueBytes: 384 * MIB,
    maxReconstructedAwaitingGpuBytes: 512 * MIB,
    reservedDestinationFetchSlots: 3,
    reservedDestinationWorkerSlots: 2,
    dynamicQueueReprioritizationEnabled: true,
    retainRunningWorkerJobOnDemotion: true,
    tailTilePriorityBoostEnabled: true,
    destinationAgeEscalationMs: 200,
    useCompressedHttpTransfer: true,
    adaptivePrewarmHorizonEnabled: true,
    adaptivePrewarmLeadMultiplier: 1.4,
    retainPrewarmAcrossReversals: true,
  },
};

/**
 * Default interactive app configuration (full TKT-041-F2 combined throughput + frame-budgeted pipeline).
 */
export const DEFAULT_STREAMING_FRAME_BUDGET_CONFIG: StreamingFrameBudgetConfig = {
  ...STREAMING_F1_VARIANTS.f2_combined,
};

/**
 * Default headless/direct TileStreamManager configuration when no explicit F1/F2 config
 * is passed: enables the F1/F2 frame-budgeted + decoupled pipeline mechanics while keeping
 * `transitionDebounceMs = 0` and `predictivePrewarmEnabled = false` so synchronous unit
 * tests expecting immediate single-resolution zoom-band transitions remain deterministic.
 */
export const DEFAULT_MANAGER_STREAMING_FRAME_BUDGET_CONFIG: StreamingFrameBudgetConfig = {
  ...STREAMING_F1_VARIANTS.f2_combined,
  transitionDebounceMs: 0,
  predictivePrewarmEnabled: false,
  adaptivePrewarmHorizonEnabled: false,
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
  const maxHttp = Math.round(
    clampFinite(
      src.maxConcurrentHttpRetrievals,
      base.maxConcurrentHttpRetrievals,
      1,
      32
    )
  );
  const maxWork = Math.round(
    clampFinite(src.workerConcurrency, base.workerConcurrency, 1, 16)
  );
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
    independentPipelineStagesEnabled:
      typeof src.independentPipelineStagesEnabled === 'boolean'
        ? src.independentPipelineStagesEnabled
        : base.independentPipelineStagesEnabled,
    maxConcurrentHttpRetrievals: maxHttp,
    workerConcurrency: maxWork,
    maxInFlightHttpReservationBytes: Math.round(
      clampFinite(
        src.maxInFlightHttpReservationBytes,
        base.maxInFlightHttpReservationBytes,
        64,
        4096 * MIB
      )
    ),
    maxRetrievedPayloadQueueBytes: Math.round(
      clampFinite(
        src.maxRetrievedPayloadQueueBytes,
        base.maxRetrievedPayloadQueueBytes,
        64,
        4096 * MIB
      )
    ),
    maxWorkerPreparationBytes: Math.round(
      clampFinite(
        src.maxWorkerPreparationBytes,
        base.maxWorkerPreparationBytes,
        64,
        4096 * MIB
      )
    ),
    maxPreparedPayloadQueueBytes: Math.round(
      clampFinite(
        src.maxPreparedPayloadQueueBytes,
        base.maxPreparedPayloadQueueBytes,
        64,
        4096 * MIB
      )
    ),
    maxReconstructedAwaitingGpuBytes: Math.round(
      clampFinite(
        src.maxReconstructedAwaitingGpuBytes,
        base.maxReconstructedAwaitingGpuBytes,
        64,
        4096 * MIB
      )
    ),
    reservedDestinationFetchSlots: Math.round(
      clampFinite(
        src.reservedDestinationFetchSlots,
        base.reservedDestinationFetchSlots,
        0,
        Math.max(0, maxHttp - 1)
      )
    ),
    reservedDestinationWorkerSlots: Math.round(
      clampFinite(
        src.reservedDestinationWorkerSlots,
        base.reservedDestinationWorkerSlots,
        0,
        Math.max(0, maxWork - 1)
      )
    ),
    dynamicQueueReprioritizationEnabled:
      typeof src.dynamicQueueReprioritizationEnabled === 'boolean'
        ? src.dynamicQueueReprioritizationEnabled
        : base.dynamicQueueReprioritizationEnabled,
    retainRunningWorkerJobOnDemotion:
      typeof src.retainRunningWorkerJobOnDemotion === 'boolean'
        ? src.retainRunningWorkerJobOnDemotion
        : base.retainRunningWorkerJobOnDemotion,
    tailTilePriorityBoostEnabled:
      typeof src.tailTilePriorityBoostEnabled === 'boolean'
        ? src.tailTilePriorityBoostEnabled
        : base.tailTilePriorityBoostEnabled,
    destinationAgeEscalationMs: Math.round(
      clampFinite(
        src.destinationAgeEscalationMs,
        base.destinationAgeEscalationMs,
        25,
        5000
      )
    ),
    useCompressedHttpTransfer:
      typeof src.useCompressedHttpTransfer === 'boolean'
        ? src.useCompressedHttpTransfer
        : base.useCompressedHttpTransfer,
    adaptivePrewarmHorizonEnabled:
      typeof src.adaptivePrewarmHorizonEnabled === 'boolean'
        ? src.adaptivePrewarmHorizonEnabled
        : base.adaptivePrewarmHorizonEnabled,
    adaptivePrewarmLeadMultiplier: clampFinite(
      src.adaptivePrewarmLeadMultiplier,
      base.adaptivePrewarmLeadMultiplier,
      0.5,
      4.0
    ),
    retainPrewarmAcrossReversals:
      typeof src.retainPrewarmAcrossReversals === 'boolean'
        ? src.retainPrewarmAcrossReversals
        : base.retainPrewarmAcrossReversals,
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
      config.independentPipelineStagesEnabled ===
        preset.independentPipelineStagesEnabled &&
      config.dynamicQueueReprioritizationEnabled ===
        preset.dynamicQueueReprioritizationEnabled &&
      config.useCompressedHttpTransfer === preset.useCompressedHttpTransfer &&
      config.adaptivePrewarmHorizonEnabled ===
        preset.adaptivePrewarmHorizonEnabled &&
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

  const variantParam =
    params.get('streamingF2Variant') ?? params.get('streamingF1Variant');
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

  const independentPipeline = params.get('independentPipeline');
  if (independentPipeline === '0' || independentPipeline === 'false') {
    result.independentPipelineStagesEnabled = false;
    found = true;
  } else if (independentPipeline === '1' || independentPipeline === 'true') {
    result.independentPipelineStagesEnabled = true;
    found = true;
  }

  const maxHttp =
    params.get('maxHttpConcurrency') ??
    params.get('maxConcurrentHttpRetrievals');
  if (maxHttp !== null && Number.isFinite(Number(maxHttp))) {
    result.maxConcurrentHttpRetrievals = Math.round(Number(maxHttp));
    found = true;
  }

  const workerConc = params.get('workerConcurrency');
  if (workerConc !== null && Number.isFinite(Number(workerConc))) {
    result.workerConcurrency = Math.round(Number(workerConc));
    found = true;
  }

  const compressedTransfer = params.get('compressedTransfer');
  if (compressedTransfer === '0' || compressedTransfer === 'false') {
    result.useCompressedHttpTransfer = false;
    found = true;
  } else if (compressedTransfer === '1' || compressedTransfer === 'true') {
    result.useCompressedHttpTransfer = true;
    found = true;
  }

  const adaptivePrewarm = params.get('adaptivePrewarm');
  if (adaptivePrewarm === '0' || adaptivePrewarm === 'false') {
    result.adaptivePrewarmHorizonEnabled = false;
    found = true;
  } else if (adaptivePrewarm === '1' || adaptivePrewarm === 'true') {
    result.adaptivePrewarmHorizonEnabled = true;
    found = true;
  }

  return found ? result : null;
}

