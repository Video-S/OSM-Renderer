import {
  computeQuantileFromSorted,
  computeSampleStatistics,
} from '../../../benchmarks/stats';
import type { SampleStatistics } from '../../../benchmarks/types';
import type {
  BrowserLoafSample,
  BrowserLongTaskSample,
  FrameStageProfileSample,
  StreamingLifecycleEvent,
} from './StreamingProfiler';

export const STREAMING_FLUIDITY_BUDGET_THRESHOLDS_MS = [
  6.94, // ~144 Hz
  13.89, // 2x 144 Hz frame miss (~72 Hz)
  16.67, // ~60 Hz
  33.33, // ~30 Hz
  50.0, // major hitch
] as const;

export interface BudgetExceedanceStat {
  thresholdMs: number;
  label: string;
  count: number;
  pct: number;
  maxConsecutiveFrames: number;
}

export interface StreamingFrameDistribution {
  sampleCount: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  p99: number;
  p999: number;
  stdDev: number;
  iqr: number;
  coefficientOfVariation: number;
  thresholdExceedances: BudgetExceedanceStat[];
  rawValuesMs: number[];
}

export type RefreshCadenceClassification =
  | 'refresh_limited_steady'
  | 'workload_induced_stalls'
  | 'software_rasterizer_limited'
  | 'mixed';

export interface ObservedCadenceAssessment {
  sampleCount: number;
  observedMedianIntervalMs: number;
  estimatedRefreshHz: number;
  cadencePeriodMs: number;
  medianCpuRenderMs: number;
  medianSyncMainThreadMs: number;
  p99IntervalMs: number;
  maxIntervalMs: number;
  exceedsObservedCadenceCount: number;
  exceeds144HzTargetCount: number;
  classification: RefreshCadenceClassification;
  explanation: string;
}

export type StreamingFluidityScenarioId =
  | 'A_stationary_baseline'
  | 'B_warm_cache_pan'
  | 'C_streaming_pan'
  | 'D_reverse_traversal'
  | 'E_continuous_zoom'
  | 'F_teleportation'
  | 'G_pointer_drag_pan';

export interface ScenarioEventCounts {
  fetchStart: number;
  fetchComplete: number;
  decodeStart: number;
  workerMessageReceived: number;
  decodeComplete: number;
  readyToCommit: number;
  reconstructStart: number;
  reconstructComplete: number;
  attach: number;
  firstRenderedUse: number;
  evict: number;
  cancel: number;
  error: number;
  uniqueTilesFetched: number;
  uniqueTilesReconstructed: number;
  uniqueTilesAttached: number;
  uniqueTilesEvicted: number;
}

export interface ScenarioCacheClassificationResult {
  scenarioId: StreamingFluidityScenarioId;
  classificationValid: boolean;
  classification:
    | 'stationary_settled'
    | 'warm_cache_clean'
    | 'warm_cache_violated_streaming_occurred'
    | 'streaming_active'
    | 'insufficient_streaming_activity'
    | 'reverse_traversal_evaluated'
    | 'continuous_zoom_evaluated'
    | 'teleportation_evaluated';
  reason: string;
  eventCounts: ScenarioEventCounts;
  reverseReuseSummary?: {
    forwardAttachedTiles: number;
    forwardEvictedTiles: number;
    reverseReusedLoadedTiles: number;
    reverseRefetchedTiles: number;
    reverseReconstructedTiles: number;
    reverseReuseHitRatePct: number | null;
  };
}

export type SpikePrimarySuspect =
  | 'sync_tile_commit_reconstruct'
  | 'instanced_bvh_build'
  | 'worker_delivery_onmessage'
  | 'gpu_upload_submit'
  | 'resolution_activation'
  | 'eviction_disposal'
  | 'gl_render_first_use_proxy'
  | 'gl_render_cpu'
  | 'picking_raycast'
  | 'react_commit'
  | 'camera_or_viewport_scan'
  | 'browser_unattributed_or_gc_loaf'
  | 'vsync_or_idle_cadence';

export interface FrameSpikeAttributionRecord {
  rank: number;
  frameIndex: number;
  windowStartMs: number;
  windowEndMs: number;
  frameIntervalMs: number;
  attributedSyncMainThreadMs: number;
  unattributedMs: number;
  cameraMovingState: {
    targetDeltaMeters: number;
    zoomDelta: number;
    cameraZoom: number;
  };
  syncStagesMs: {
    cameraUseFrameMs: number;
    mapSceneUseFrameOtherMs: number;
    zoomPropagationMs: number;
    viewportUpdateMs: number;
    streamTickMs: number;
    reconstructMs: number;
    instancedBvhBuildMs: number;
    instancedBvhAdoptMs: number;
    staticBvhDeserializeMs: number;
    sceneAttachMs: number;
    commitRebuildStatsMs: number;
    evictDisposeMs: number;
    gpuUploadSubmitMs?: number;
    resolutionActivationMs?: number;
    boundaryOverlayRebuildMs?: number;
    deferredDisposeMs?: number;
    pickingRaycasterMs: number;
    reactCommitMs: number;
    workerOnMessageMs: number;
    workerContinuationMs: number;
    glRenderCpuMs: number;
    telemetryHudMs: number;
  };
  tilesCommittedCount: number;
  tilesEvictedCount: number;
  workerDeliveriesCount: number;
  workerBvhAdoptedCount: number;
  syncBvhFallbackCount: number;
  firstRenderUploadProxy: {
    tileKeys: string[];
    tileCount: number;
    triangles: number;
    meshes: number;
    driverGeometriesDelta: number;
  };
  gpuPassTimeMs: number | null;
  gpuTimerStatus: string;
  syncMainThreadEvents: StreamingLifecycleEvent[];
  asyncOverlappingEvents: StreamingLifecycleEvent[];
  overlappingLongTasks: BrowserLongTaskSample[];
  overlappingLoafs: BrowserLoafSample[];
  primarySuspect: SpikePrimarySuspect;
  suspectRationale: string;
}

export interface EventConditionedFrameSummary {
  allFrames: StreamingFrameDistribution;
  workerDeliveryFrames: StreamingFrameDistribution;
  tileCommitFrames: StreamingFrameDistribution;
  activeStreamingWorkFrames: StreamingFrameDistribution;
  quietFrames: StreamingFrameDistribution;
}

export interface WorkerDeliverySummary {
  deliveryCount: number;
  usedWebWorkerCount: number;
  usedCompactTransportCount: number;
  transferableBufferCountMean: number;
  transferableBytesTotal: number;
  workerBvhAdoptedTotal: number;
  syncBvhFallbackTotal: number;
  workerQueueWaitMs: SampleStatistics;
  workerInflateAndDecodeMs: SampleStatistics;
  workerBvhBuildMs: SampleStatistics;
  workerPayloadPrepMs: SampleStatistics;
  messageDeliveryLatencyMs: SampleStatistics;
  mainOnMessageHandlerMs: SampleStatistics;
  mainPromiseContinuationMs: SampleStatistics;
  reconstructTotalMs: SampleStatistics;
  mainInstancedBvhBuildMs: SampleStatistics;
  mainInstancedBvhAdoptMs: SampleStatistics;
  tileReadinessLatencyMs: SampleStatistics;
  tilesPerSecond: number;
}

export interface StageTimingSummaryEntry {
  stageKey: string;
  label: string;
  nestingLevel: 'top_level' | 'child_of_camera' | 'child_of_viewport' | 'child_of_tick' | 'child_of_reconstruct';
  stats: SampleStatistics;
  totalMs: number;
}

export interface FrameNestingValidationResult {
  valid: boolean;
  violations: string[];
}

function roundNum(val: number, digits = 3): number {
  if (!Number.isFinite(val)) return 0;
  return Number(val.toFixed(digits));
}

function thresholdLabel(ms: number): string {
  if (ms === 6.94) return '>6.94ms (144Hz miss)';
  if (ms === 13.89) return '>13.89ms (2x 144Hz)';
  if (ms === 16.67) return '>16.67ms (60Hz miss)';
  if (ms === 33.33) return '>33.33ms (30Hz miss)';
  if (ms === 50) return '>50.00ms (major hitch)';
  return `>${ms}ms`;
}

/**
 * Computes frame-time percentiles including p99.9, budget exceedance counts/percentages,
 * and longest consecutive slow-frame streaks.
 */
export function computeStreamingFrameDistribution(
  rawIntervalsMs: readonly number[],
  thresholdsMs: readonly number[] = STREAMING_FLUIDITY_BUDGET_THRESHOLDS_MS
): StreamingFrameDistribution {
  const valid = rawIntervalsMs
    .filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    .map((v) => roundNum(v, 3));

  const base = computeSampleStatistics(valid, 3);
  const sorted = [...valid].sort((a, b) => a - b);
  const p999 = sorted.length > 0 ? roundNum(computeQuantileFromSorted(sorted, 0.999), 3) : 0;

  const thresholdExceedances: BudgetExceedanceStat[] = thresholdsMs.map((thresholdMs) => {
    let count = 0;
    let currentStreak = 0;
    let maxStreak = 0;
    for (let i = 0; i < valid.length; i++) {
      if (valid[i] > thresholdMs) {
        count += 1;
        currentStreak += 1;
        if (currentStreak > maxStreak) {
          maxStreak = currentStreak;
        }
      } else {
        currentStreak = 0;
      }
    }
    return {
      thresholdMs,
      label: thresholdLabel(thresholdMs),
      count,
      pct: valid.length > 0 ? roundNum((count / valid.length) * 100, 2) : 0,
      maxConsecutiveFrames: maxStreak,
    };
  });

  return {
    sampleCount: base.sampleCount,
    min: base.min,
    max: base.max,
    mean: base.mean,
    median: base.median,
    p95: base.p95,
    p99: base.p99,
    p999,
    stdDev: base.stdDev,
    iqr: base.iqr,
    coefficientOfVariation: base.coefficientOfVariation,
    thresholdExceedances,
    rawValuesMs: valid,
  };
}

/**
 * Distinguishes display/VSync refresh cadence limits from workload-induced frame stalls
 * or software rasterization bottlenecks.
 */
export function assessObservedRefreshCadence(params: {
  frameIntervalsMs: readonly number[];
  cpuRenderMs: readonly number[];
  syncMainThreadMs: readonly number[];
  isSoftwareRenderer: boolean;
  stationaryReferenceMedianMs?: number;
}): ObservedCadenceAssessment {
  const intervalStats = computeSampleStatistics(params.frameIntervalsMs, 3);
  const cpuStats = computeSampleStatistics(params.cpuRenderMs, 3);
  const syncStats = computeSampleStatistics(params.syncMainThreadMs, 3);

  const cadencePeriodMs =
    typeof params.stationaryReferenceMedianMs === 'number' &&
    Number.isFinite(params.stationaryReferenceMedianMs) &&
    params.stationaryReferenceMedianMs > 1
      ? params.stationaryReferenceMedianMs
      : Math.max(1, intervalStats.median || 16.667);

  const estimatedRefreshHz = roundNum(1000 / cadencePeriodMs, 1);
  const cadenceAllowanceMs = cadencePeriodMs * 1.25;
  let exceedsObservedCadenceCount = 0;
  let exceeds144HzTargetCount = 0;
  for (let i = 0; i < params.frameIntervalsMs.length; i++) {
    const v = params.frameIntervalsMs[i];
    if (v > cadenceAllowanceMs) exceedsObservedCadenceCount += 1;
    if (v > 6.94) exceeds144HzTargetCount += 1;
  }

  if (params.isSoftwareRenderer) {
    return {
      sampleCount: intervalStats.sampleCount,
      observedMedianIntervalMs: intervalStats.median,
      estimatedRefreshHz,
      cadencePeriodMs: roundNum(cadencePeriodMs, 3),
      medianCpuRenderMs: cpuStats.median,
      medianSyncMainThreadMs: syncStats.median,
      p99IntervalMs: intervalStats.p99,
      maxIntervalMs: intervalStats.max,
      exceedsObservedCadenceCount,
      exceeds144HzTargetCount,
      classification: 'software_rasterizer_limited',
      explanation: `Software WebGL renderer active (median frame ${intervalStats.median.toFixed(2)} ms, CPU render ${cpuStats.median.toFixed(2)} ms). Timings reflect CPU rasterization rather than hardware GPU.`,
    };
  }

  const stallThreshold = Math.max(cadencePeriodMs * 1.5, 20);
  const hasSignificantStalls =
    intervalStats.p99 > stallThreshold || intervalStats.max > cadencePeriodMs * 2.0;
  const medianWorkRatio = syncStats.median / Math.max(1, cadencePeriodMs);

  let classification: RefreshCadenceClassification;
  let explanation: string;

  if (!hasSignificantStalls && medianWorkRatio < 0.65) {
    classification = 'refresh_limited_steady';
    explanation = `Steady ~${estimatedRefreshHz} Hz observed display cadence (${cadencePeriodMs.toFixed(2)} ms median interval, NOT computational overhead) with low synchronous main-thread work (${syncStats.median.toFixed(2)} ms median vs 6.94 ms 144 Hz budget, p99 ${intervalStats.p99.toFixed(2)} ms).`;
  } else if (hasSignificantStalls && medianWorkRatio < 0.65) {
    classification = 'workload_induced_stalls';
    explanation = `Median interval sits near ~${estimatedRefreshHz} Hz display cadence (${intervalStats.median.toFixed(2)} ms), but tail stalls reach p99 ${intervalStats.p99.toFixed(2)} ms / max ${intervalStats.max.toFixed(2)} ms (${exceedsObservedCadenceCount} frame(s) exceeded ${cadenceAllowanceMs.toFixed(1)} ms cadence allowance).`;
  } else {
    classification = 'mixed';
    explanation = `Synchronous CPU workload (${syncStats.median.toFixed(2)} ms median) is high relative to ~${estimatedRefreshHz} Hz cadence (${cadencePeriodMs.toFixed(2)} ms), with p99 ${intervalStats.p99.toFixed(2)} ms and max ${intervalStats.max.toFixed(2)} ms.`;
  }

  return {
    sampleCount: intervalStats.sampleCount,
    observedMedianIntervalMs: intervalStats.median,
    estimatedRefreshHz,
    cadencePeriodMs: roundNum(cadencePeriodMs, 3),
    medianCpuRenderMs: cpuStats.median,
    medianSyncMainThreadMs: syncStats.median,
    p99IntervalMs: intervalStats.p99,
    maxIntervalMs: intervalStats.max,
    exceedsObservedCadenceCount,
    exceeds144HzTargetCount,
    classification,
    explanation,
  };
}

export function summarizeStreamingEvents(
  events: readonly StreamingLifecycleEvent[]
): ScenarioEventCounts {
  const uniqueFetch = new Set<string>();
  const uniqueRecon = new Set<string>();
  const uniqueAttach = new Set<string>();
  const uniqueEvict = new Set<string>();

  const counts: ScenarioEventCounts = {
    fetchStart: 0,
    fetchComplete: 0,
    decodeStart: 0,
    workerMessageReceived: 0,
    decodeComplete: 0,
    readyToCommit: 0,
    reconstructStart: 0,
    reconstructComplete: 0,
    attach: 0,
    firstRenderedUse: 0,
    evict: 0,
    cancel: 0,
    error: 0,
    uniqueTilesFetched: 0,
    uniqueTilesReconstructed: 0,
    uniqueTilesAttached: 0,
    uniqueTilesEvicted: 0,
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    switch (e.eventType) {
      case 'fetch_start':
        counts.fetchStart += 1;
        uniqueFetch.add(e.tileKey);
        break;
      case 'fetch_complete':
        counts.fetchComplete += 1;
        break;
      case 'decode_start':
        counts.decodeStart += 1;
        break;
      case 'worker_message_received':
        counts.workerMessageReceived += 1;
        break;
      case 'decode_complete':
        counts.decodeComplete += 1;
        break;
      case 'ready_to_commit':
        counts.readyToCommit += 1;
        break;
      case 'reconstruct_start':
        counts.reconstructStart += 1;
        break;
      case 'reconstruct_complete':
        counts.reconstructComplete += 1;
        uniqueRecon.add(e.tileKey);
        break;
      case 'attach':
        counts.attach += 1;
        uniqueAttach.add(e.tileKey);
        break;
      case 'first_rendered_use':
        counts.firstRenderedUse += 1;
        break;
      case 'evict':
        counts.evict += 1;
        uniqueEvict.add(e.tileKey);
        break;
      case 'cancel':
        counts.cancel += 1;
        break;
      case 'error':
        counts.error += 1;
        break;
    }
  }

  counts.uniqueTilesFetched = uniqueFetch.size;
  counts.uniqueTilesReconstructed = uniqueRecon.size;
  counts.uniqueTilesAttached = uniqueAttach.size;
  counts.uniqueTilesEvicted = uniqueEvict.size;
  return counts;
}

/**
 * Validates that Scenario B stayed truly warm-cache (0 streaming activity) and that Scenario C
 * actually triggered streaming boundary crossings (fetches, reconstructions, attachments).
 */
export function classifyScenarioCacheBehavior(params: {
  scenarioId: StreamingFluidityScenarioId;
  events: readonly StreamingLifecycleEvent[];
  forwardEvents?: readonly StreamingLifecycleEvent[];
  reverseEvents?: readonly StreamingLifecycleEvent[];
  initiallyResidentTileKeys?: readonly string[];
}): ScenarioCacheClassificationResult {
  const counts = summarizeStreamingEvents(params.events);

  if (params.scenarioId === 'A_stationary_baseline') {
    const clean =
      counts.fetchStart === 0 &&
      counts.reconstructComplete === 0 &&
      counts.attach === 0 &&
      counts.evict === 0;
    return {
      scenarioId: params.scenarioId,
      classificationValid: clean,
      classification: clean
        ? 'stationary_settled'
        : 'warm_cache_violated_streaming_occurred',
      reason: clean
        ? 'Zero tile fetches, reconstructions, attachments, or evictions during settled stationary baseline.'
        : `Unexpected streaming activity during stationary baseline (fetches=${counts.fetchStart}, reconstructs=${counts.reconstructComplete}, attaches=${counts.attach}, evicts=${counts.evict}).`,
      eventCounts: counts,
    };
  }

  if (
    params.scenarioId === 'B_warm_cache_pan' ||
    params.scenarioId === 'G_pointer_drag_pan'
  ) {
    const anyStreaming =
      counts.fetchStart > 0 ||
      counts.decodeComplete > 0 ||
      counts.reconstructComplete > 0 ||
      counts.attach > 0 ||
      counts.evict > 0 ||
      counts.cancel > 0;
    if (params.scenarioId === 'B_warm_cache_pan') {
      return {
        scenarioId: params.scenarioId,
        classificationValid: !anyStreaming,
        classification: anyStreaming
          ? 'warm_cache_violated_streaming_occurred'
          : 'warm_cache_clean',
        reason: anyStreaming
          ? `Warm-cache constraint violated: panning triggered streaming (fetches=${counts.fetchStart}, decodes=${counts.decodeComplete}, reconstructs=${counts.reconstructComplete}, attaches=${counts.attach}, evicts=${counts.evict}, cancels=${counts.cancel}). Reclassified as streaming-contaminated.`
          : 'Confirmed warm-cache pan: zero fetches, decodes, reconstructions, attachments, evictions, or cancellations occurred.',
        eventCounts: counts,
      };
    }
    return {
      scenarioId: params.scenarioId,
      classificationValid: true,
      classification: anyStreaming ? 'streaming_active' : 'warm_cache_clean',
      reason: anyStreaming
        ? `Pointer drag triggered streaming (${counts.fetchStart} fetches, ${counts.attach} attaches, ${counts.evict} evictions).`
        : 'Pointer drag remained within already-loaded cache.',
      eventCounts: counts,
    };
  }

  if (params.scenarioId === 'C_streaming_pan') {
    const valid =
      counts.fetchStart > 0 && counts.reconstructComplete > 0 && counts.attach > 0;
    return {
      scenarioId: params.scenarioId,
      classificationValid: valid,
      classification: valid
        ? 'streaming_active'
        : 'insufficient_streaming_activity',
      reason: valid
        ? `Confirmed streaming pan across tile boundaries (${counts.fetchStart} fetches, ${counts.reconstructComplete} reconstructs, ${counts.attach} attaches, ${counts.evict} evictions).`
        : `Streaming pan did not trigger new tile loads (fetches=${counts.fetchStart}, reconstructs=${counts.reconstructComplete}, attaches=${counts.attach}). Check pan distance vs. tile size and preload margin.`,
      eventCounts: counts,
    };
  }

  if (params.scenarioId === 'D_reverse_traversal') {
    const fwdCounts = summarizeStreamingEvents(params.forwardEvents ?? []);
    const revCounts = summarizeStreamingEvents(params.reverseEvents ?? []);
    const resident = new Set(params.initiallyResidentTileKeys ?? []);
    for (const e of params.forwardEvents ?? []) {
      if (e.eventType === 'attach') resident.add(e.tileKey);
      if (e.eventType === 'evict') resident.delete(e.tileKey);
    }
    const forwardLoadedAtTurnaround = resident.size;
    const revRefetchKeys = new Set(
      (params.reverseEvents ?? [])
        .filter((e) => e.eventType === 'fetch_start')
        .map((e) => e.tileKey)
    );
    const totalNeededOnReturnEstimate =
      resident.size + revRefetchKeys.size;
    const reuseHitRatePct =
      totalNeededOnReturnEstimate > 0
        ? roundNum(
            (resident.size / totalNeededOnReturnEstimate) * 100,
            1
          )
        : null;

    return {
      scenarioId: params.scenarioId,
      classificationValid:
        fwdCounts.fetchStart > 0 || revCounts.fetchStart > 0 || resident.size > 0,
      classification: 'reverse_traversal_evaluated',
      reason: `Forward leg: ${fwdCounts.attach} attached / ${fwdCounts.evict} evicted (${forwardLoadedAtTurnaround} resident at turnaround). Return leg: ${revCounts.fetchStart} refetched, ${revCounts.reconstructComplete} reconstructed, ${revCounts.evict} evicted.`,
      eventCounts: counts,
      reverseReuseSummary: {
        forwardAttachedTiles: fwdCounts.attach,
        forwardEvictedTiles: fwdCounts.evict,
        reverseReusedLoadedTiles: resident.size,
        reverseRefetchedTiles: revCounts.fetchStart,
        reverseReconstructedTiles: revCounts.reconstructComplete,
        reverseReuseHitRatePct: reuseHitRatePct,
      },
    };
  }

  if (params.scenarioId === 'E_continuous_zoom') {
    return {
      scenarioId: params.scenarioId,
      classificationValid: true,
      classification: 'continuous_zoom_evaluated',
      reason: `Continuous zoom sweep recorded ${counts.fetchStart} fetches, ${counts.reconstructComplete} reconstructs, ${counts.attach} attaches, and ${counts.evict} evictions.`,
      eventCounts: counts,
    };
  }

  return {
    scenarioId: params.scenarioId,
    classificationValid: counts.attach > 0 || counts.fetchStart > 0 || counts.firstRenderedUse > 0,
    classification: 'teleportation_evaluated',
    reason: `Teleportation recorded ${counts.fetchStart} fetches, ${counts.reconstructComplete} reconstructs, ${counts.attach} attaches, and ${counts.evict} evictions.`,
    eventCounts: counts,
  };
}

const SYNC_MAIN_THREAD_EVENTS = new Set<string>([
  'worker_message_received',
  'reconstruct_start',
  'reconstruct_complete',
  'gpu_upload_batch',
  'attach',
  'first_rendered_use',
  'resolution_transition_activate',
  'boundary_overlay_rebuild',
  'deferred_dispose_enqueue',
  'deferred_dispose_complete',
  'evict',
  'cancel',
  'fetch_start',
]);

/**
 * Attributes the worst N frames to synchronous main-thread stages, concurrent streaming
 * events, first-render upload proxies, browser LongTasks / LoAFs, and unattributed residual time.
 */
export function attributeWorstFrames(params: {
  frames: readonly FrameStageProfileSample[];
  events: readonly StreamingLifecycleEvent[];
  longTasks: readonly BrowserLongTaskSample[];
  loafs: readonly BrowserLoafSample[];
  topN?: number;
}): FrameSpikeAttributionRecord[] {
  const { frames, events, longTasks, loafs } = params;
  if (frames.length === 0) return [];
  const topN = Math.max(1, Math.floor(params.topN ?? 15));

  const indexed = frames.map((f, i) => ({ frame: f, pos: i }));
  indexed.sort((a, b) => b.frame.frameIntervalMs - a.frame.frameIntervalMs);
  const selected = indexed.slice(0, topN);

  return selected.map(({ frame, pos }, rankIdx) => {
    const prevFrame = pos > 0 ? frames[pos - 1] : null;
    const windowStartMs =
      typeof frame.intervalStartMs === 'number' && frame.intervalStartMs > 0
        ? frame.intervalStartMs
        : prevFrame
          ? prevFrame.frameTimestampMs
          : Math.max(0, frame.frameTimestampMs - frame.frameIntervalMs);
    const windowEndMs =
      typeof frame.intervalEndMs === 'number' && frame.intervalEndMs > 0
        ? frame.intervalEndMs
        : frame.frameTimestampMs;

    const targetDeltaMeters = prevFrame
      ? roundNum(
          Math.hypot(
            frame.cameraTargetX - prevFrame.cameraTargetX,
            frame.cameraTargetZ - prevFrame.cameraTargetZ
          ),
          2
        )
      : 0;
    const zoomDelta = prevFrame
      ? roundNum(frame.cameraZoom - prevFrame.cameraZoom, 3)
      : 0;

    const unattributedMs = roundNum(
      Math.max(0, frame.frameIntervalMs - frame.attributedSyncMainThreadMs),
      3
    );

    const overlappingEvents = events.filter(
      (e) =>
        e.frameIndex === frame.frameIndex ||
        (e.timestampMs >= windowStartMs - 0.5 && e.timestampMs <= windowEndMs + 0.5)
    );
    const syncMainThreadEvents = overlappingEvents.filter((e) =>
      SYNC_MAIN_THREAD_EVENTS.has(e.eventType)
    );
    const asyncOverlappingEvents = overlappingEvents.filter(
      (e) => !SYNC_MAIN_THREAD_EVENTS.has(e.eventType)
    );

    const overlappingLongTasks = longTasks.filter((lt) => {
      const ltEnd = lt.startTimeMs + lt.durationMs;
      return ltEnd >= windowStartMs && lt.startTimeMs <= windowEndMs;
    });
    const overlappingLoafs = loafs.filter((lf) => {
      const lfEnd = lf.startTimeMs + lf.durationMs;
      return lfEnd >= windowStartMs && lf.startTimeMs <= windowEndMs;
    });

    const { suspect, rationale } = classifyFramePrimarySuspect(
      frame,
      unattributedMs,
      overlappingLoafs
    );

    return {
      rank: rankIdx + 1,
      frameIndex: frame.frameIndex,
      windowStartMs: roundNum(windowStartMs, 3),
      windowEndMs: roundNum(windowEndMs, 3),
      frameIntervalMs: frame.frameIntervalMs,
      attributedSyncMainThreadMs: frame.attributedSyncMainThreadMs,
      unattributedMs,
      cameraMovingState: {
        targetDeltaMeters,
        zoomDelta,
        cameraZoom: frame.cameraZoom,
      },
      syncStagesMs: {
        cameraUseFrameMs: frame.cameraUseFrameMs,
        mapSceneUseFrameOtherMs: frame.mapSceneUseFrameOtherMs,
        zoomPropagationMs: frame.zoomPropagationMs,
        viewportUpdateMs: frame.viewportUpdateMs,
        streamTickMs: frame.streamTickMs,
        reconstructMs: frame.reconstructMs,
        instancedBvhBuildMs: frame.instancedBvhBuildMs,
        instancedBvhAdoptMs: frame.instancedBvhAdoptMs ?? 0,
        staticBvhDeserializeMs: frame.staticBvhDeserializeMs,
        sceneAttachMs: frame.sceneAttachMs,
        commitRebuildStatsMs: frame.commitRebuildStatsMs,
        evictDisposeMs: frame.evictDisposeMs,
        gpuUploadSubmitMs: frame.gpuUploadSubmitMs ?? 0,
        resolutionActivationMs: frame.resolutionActivationMs ?? 0,
        boundaryOverlayRebuildMs: frame.boundaryOverlayRebuildMs ?? 0,
        deferredDisposeMs: frame.deferredDisposeMs ?? 0,
        pickingRaycasterMs: frame.pickingRaycasterMs,
        reactCommitMs: frame.reactCommitMs,
        workerOnMessageMs: frame.workerOnMessageMs ?? 0,
        workerContinuationMs: frame.workerContinuationMs ?? 0,
        glRenderCpuMs: frame.glRenderCpuMs,
        telemetryHudMs: frame.telemetryHudMs,
      },
      tilesCommittedCount: frame.tilesCommittedCount,
      tilesEvictedCount: frame.tilesEvictedCount,
      workerDeliveriesCount: frame.workerDeliveriesCount ?? 0,
      workerBvhAdoptedCount: frame.workerBvhAdoptedCount ?? 0,
      syncBvhFallbackCount: frame.syncBvhFallbackCount ?? 0,
      firstRenderUploadProxy: {
        tileKeys: frame.newlyAttachedTileKeys,
        tileCount: frame.newlyAttachedTilesCount,
        triangles: frame.newlyAttachedTriangles,
        meshes: frame.newlyAttachedMeshes,
        driverGeometriesDelta: frame.driverGeometriesDelta,
      },
      gpuPassTimeMs: frame.gpuPassTimeMs,
      gpuTimerStatus: frame.gpuTimerStatus,
      syncMainThreadEvents,
      asyncOverlappingEvents,
      overlappingLongTasks,
      overlappingLoafs,
      primarySuspect: suspect,
      suspectRationale: rationale,
    };
  });
}

function classifyFramePrimarySuspect(
  frame: FrameStageProfileSample,
  unattributedMs: number,
  overlappingLoafs: readonly BrowserLoafSample[]
): { suspect: SpikePrimarySuspect; rationale: string } {
  if (frame.frameIntervalMs <= 18 && frame.attributedSyncMainThreadMs < 6) {
    return {
      suspect: 'vsync_or_idle_cadence',
      rationale: `Frame (${frame.frameIntervalMs.toFixed(2)} ms) falls within VSync/idle cadence with low main-thread work (${frame.attributedSyncMainThreadMs.toFixed(2)} ms).`,
    };
  }

  const workerDeliveryTotalMs =
    (frame.workerOnMessageMs ?? 0) + (frame.workerContinuationMs ?? 0);
  const gpuUploadSubmitMs = frame.gpuUploadSubmitMs ?? 0;
  const resolutionActivationMs = frame.resolutionActivationMs ?? 0;
  const deferredDisposeMs = frame.deferredDisposeMs ?? 0;
  const nonBvhTickMs = Math.max(
    0,
    frame.streamTickMs -
      frame.instancedBvhBuildMs -
      gpuUploadSubmitMs -
      resolutionActivationMs -
      deferredDisposeMs
  );
  const candidates: Array<{ key: SpikePrimarySuspect; val: number; note: string }> = [
    {
      key: 'instanced_bvh_build',
      val: frame.instancedBvhBuildMs,
      note: `Synchronous main-thread InstancedSpatialIndex BVH build took ${frame.instancedBvhBuildMs.toFixed(2)} ms (inside reconstructMs=${frame.reconstructMs.toFixed(2)} ms across ${frame.tilesCommittedCount} committed tile(s); fallbackBatches=${frame.syncBvhFallbackCount ?? 0}).`,
    },
    {
      key: 'worker_delivery_onmessage',
      val: workerDeliveryTotalMs,
      note: `Main-thread worker delivery took ${workerDeliveryTotalMs.toFixed(2)} ms across ${frame.workerDeliveriesCount ?? 0} message(s) (onmessage=${(frame.workerOnMessageMs ?? 0).toFixed(2)} ms, continuation=${(frame.workerContinuationMs ?? 0).toFixed(2)} ms, maxDeliveryLatency=${(frame.workerDeliveryLatencyMaxMs ?? 0).toFixed(2)} ms).`,
    },
    {
      key: 'gpu_upload_submit',
      val: gpuUploadSubmitMs,
      note: `Incremental offscreen GPU upload submission took ${gpuUploadSubmitMs.toFixed(2)} ms (${frame.gpuUploadedMeshCount ?? 0} mesh unit(s), ${((frame.gpuUploadedBytes ?? 0) / (1024 * 1024)).toFixed(2)} MiB estimated; CPU submit time only).`,
    },
    {
      key: 'resolution_activation',
      val: resolutionActivationMs,
      note: `Atomic resolution activation took ${resolutionActivationMs.toFixed(2)} ms (boundaryOverlayRebuild=${(frame.boundaryOverlayRebuildMs ?? 0).toFixed(2)} ms).`,
    },
    {
      key: 'sync_tile_commit_reconstruct',
      val: nonBvhTickMs,
      note: `Synchronous tile commit/reconstruction (excl. sync instanced BVH, GPU prep, activation, deferred dispose) took ${nonBvhTickMs.toFixed(2)} ms (${frame.tilesCommittedCount} tile(s), reconstruct=${frame.reconstructMs.toFixed(2)} ms, bvhAdopt=${(frame.instancedBvhAdoptMs ?? 0).toFixed(2)} ms, attach=${frame.sceneAttachMs.toFixed(2)} ms, stats=${frame.commitRebuildStatsMs.toFixed(2)} ms).`,
    },
    {
      key: 'eviction_disposal',
      val: frame.evictDisposeMs + frame.evictRebuildStatsMs + deferredDisposeMs,
      note: `Eviction & GPU/BVH resource disposal took ${(frame.evictDisposeMs + frame.evictRebuildStatsMs + deferredDisposeMs).toFixed(2)} ms (syncEvict=${frame.evictDisposeMs.toFixed(2)} ms, deferredDispose=${deferredDisposeMs.toFixed(2)} ms across ${frame.deferredDisposedTilesCount ?? 0} tile(s)).`,
    },
    {
      key:
        frame.newlyAttachedTilesCount > 0
          ? 'gl_render_first_use_proxy'
          : 'gl_render_cpu',
      val: frame.glRenderCpuMs,
      note:
        frame.newlyAttachedTilesCount > 0
          ? `gl.render CPU wall time reached ${frame.glRenderCpuMs.toFixed(2)} ms on the first frame rendering ${frame.newlyAttachedTilesCount} newly attached tile(s) (${frame.newlyAttachedTriangles.toLocaleString()} tris, driverGeoms delta=${frame.driverGeometriesDelta}) — possible WebGL buffer upload/driver sync.`
          : `gl.render CPU wall time reached ${frame.glRenderCpuMs.toFixed(2)} ms (${frame.renderCalls} draw calls, ${frame.renderTriangles.toLocaleString()} tris).`,
    },
    {
      key: 'picking_raycast',
      val: frame.pickingRaycasterMs,
      note: `Raycaster / pointer picking took ${frame.pickingRaycasterMs.toFixed(2)} ms across ${frame.pickingCallsCount} call(s).`,
    },
    {
      key: 'react_commit',
      val: frame.reactCommitMs,
      note: `React reconciliation/commit took ${frame.reactCommitMs.toFixed(2)} ms across ${frame.reactCommitsCount} commit(s).`,
    },
    {
      key: 'camera_or_viewport_scan',
      val:
        frame.cameraUseFrameMs +
        Math.max(0, frame.viewportUpdateMs - frame.evictDisposeMs) +
        frame.zoomPropagationMs,
      note: `Camera/viewport/zoom scan took ${(frame.cameraUseFrameMs + frame.viewportUpdateMs + frame.zoomPropagationMs).toFixed(2)} ms.`,
    },
  ];

  // Include unattributed time when frame clearly exceeded budget and unattributed dominates
  if (frame.frameIntervalMs > 18) {
    const loafHint =
      overlappingLoafs.length > 0 && overlappingLoafs[0].topScripts.length > 0
        ? ` Top LoAF script: ${overlappingLoafs[0].topScripts[0].invoker || overlappingLoafs[0].topScripts[0].sourceFunctionName || 'unknown'} (${overlappingLoafs[0].topScripts[0].durationMs.toFixed(1)} ms).`
        : '';
    const workerDeserHint =
      (frame.workerDeliveriesCount ?? 0) > 0
        ? ` Note: ${frame.workerDeliveriesCount} worker message(s) delivered in this window (max cross-thread delivery latency ${(frame.workerDeliveryLatencyMaxMs ?? 0).toFixed(1)} ms); browser-internal structured-clone deserialization before JS onmessage entry may account for residual time.`
        : '';
    candidates.push({
      key:
        (frame.workerDeliveriesCount ?? 0) > 0 &&
        overlappingLoafs.some((lf) =>
          lf.topScripts.some((s) => /Worker\.onmessage/i.test(s.invoker))
        )
          ? 'worker_delivery_onmessage'
          : 'browser_unattributed_or_gc_loaf',
      val: unattributedMs,
      note: `Unattributed interval residual is ${unattributedMs.toFixed(2)} ms (exceeds measured sync work ${frame.attributedSyncMainThreadMs.toFixed(2)} ms; suggests browser structured-clone deserialization, GC, compositor/driver stall, style/layout, or rAF scheduling delay).${workerDeserHint}${loafHint}`,
    });
  }

  candidates.sort((a, b) => b.val - a.val);
  const top = candidates[0];
  return { suspect: top.key, rationale: top.note };
}

/**
 * Summarizes every tracked synchronous stage (median, p95, p99, max, cumulative total).
 */
export function summarizeStageTimings(
  frames: readonly FrameStageProfileSample[]
): StageTimingSummaryEntry[] {
  const defs: Array<{
    stageKey: string;
    label: string;
    nestingLevel: StageTimingSummaryEntry['nestingLevel'];
    pick: (f: FrameStageProfileSample) => number;
  }> = [
    { stageKey: 'attributedSyncMainThreadMs', label: 'Total Attributed Sync Main-Thread', nestingLevel: 'top_level', pick: (f) => f.attributedSyncMainThreadMs },
    { stageKey: 'glRenderCpuMs', label: 'gl.render() CPU Wall Time', nestingLevel: 'top_level', pick: (f) => f.glRenderCpuMs },
    { stageKey: 'workerOnMessageMs', label: 'Worker.onmessage Handler (sync JS)', nestingLevel: 'top_level', pick: (f) => f.workerOnMessageMs ?? 0 },
    { stageKey: 'workerContinuationMs', label: 'Worker Post-Decode Promise Continuation', nestingLevel: 'top_level', pick: (f) => f.workerContinuationMs ?? 0 },
    { stageKey: 'streamTickMs', label: 'Streaming Commit Tick (tile commit)', nestingLevel: 'top_level', pick: (f) => f.streamTickMs },
    { stageKey: 'reconstructMs', label: '  Tile Reconstruct (inside tick)', nestingLevel: 'child_of_tick', pick: (f) => f.reconstructMs },
    { stageKey: 'instancedBvhBuildMs', label: '    InstancedSpatialIndex Sync BVH Build (inside reconstruct)', nestingLevel: 'child_of_reconstruct', pick: (f) => f.instancedBvhBuildMs },
    { stageKey: 'instancedBvhAdoptMs', label: '    InstancedSpatialIndex Worker BVH Adopt (inside reconstruct)', nestingLevel: 'child_of_reconstruct', pick: (f) => f.instancedBvhAdoptMs ?? 0 },
    { stageKey: 'staticBvhDeserializeMs', label: '    Static MeshBVH Deserialize (inside reconstruct)', nestingLevel: 'child_of_reconstruct', pick: (f) => f.staticBvhDeserializeMs },
    { stageKey: 'sceneAttachMs', label: '  Composite Scene Attach (inside tick)', nestingLevel: 'child_of_tick', pick: (f) => f.sceneAttachMs },
    { stageKey: 'gpuUploadSubmitMs', label: '  Incremental GPU Upload Submit (inside tick)', nestingLevel: 'child_of_tick', pick: (f) => f.gpuUploadSubmitMs ?? 0 },
    { stageKey: 'resolutionActivationMs', label: '  Atomic Resolution Activation (inside tick)', nestingLevel: 'child_of_tick', pick: (f) => f.resolutionActivationMs ?? 0 },
    { stageKey: 'boundaryOverlayRebuildMs', label: '    Tile Boundary Overlay Rebuild', nestingLevel: 'child_of_tick', pick: (f) => f.boundaryOverlayRebuildMs ?? 0 },
    { stageKey: 'deferredDisposeMs', label: '  Deferred Resource Disposal (inside tick)', nestingLevel: 'child_of_tick', pick: (f) => f.deferredDisposeMs ?? 0 },
    { stageKey: 'commitRebuildStatsMs', label: '  Commit rebuildCompositeStats (inside tick)', nestingLevel: 'child_of_tick', pick: (f) => f.commitRebuildStatsMs },
    { stageKey: 'commitEmitDiagnosticsMs', label: '  Commit emitDiagnostics Callback (inside tick)', nestingLevel: 'child_of_tick', pick: (f) => f.commitEmitDiagnosticsMs },
    { stageKey: 'viewportUpdateMs', label: 'Viewport Streaming Evaluation', nestingLevel: 'top_level', pick: (f) => f.viewportUpdateMs },
    { stageKey: 'tileScanMs', label: '  Tile Grid Scan & Priority (inside viewport)', nestingLevel: 'child_of_viewport', pick: (f) => f.tileScanMs },
    { stageKey: 'evictDisposeMs', label: '  Eviction & Resource Dispose (inside viewport)', nestingLevel: 'child_of_viewport', pick: (f) => f.evictDisposeMs },
    { stageKey: 'cameraUseFrameMs', label: 'CameraController useFrame', nestingLevel: 'top_level', pick: (f) => f.cameraUseFrameMs },
    { stageKey: 'controlsUpdateMs', label: '  MapControls.update() (inside camera)', nestingLevel: 'child_of_camera', pick: (f) => f.controlsUpdateMs },
    { stageKey: 'cameraFrustumMs', label: '  Camera Frustum & Projection (inside camera)', nestingLevel: 'child_of_camera', pick: (f) => f.cameraFrustumMs },
    { stageKey: 'cameraOrientationCallbackMs', label: '  Orientation React Callback (inside camera)', nestingLevel: 'child_of_camera', pick: (f) => f.cameraOrientationCallbackMs },
    { stageKey: 'zoomPropagationMs', label: 'Zoom Propagation (all loaded tiles)', nestingLevel: 'top_level', pick: (f) => f.zoomPropagationMs },
    { stageKey: 'pickingRaycasterMs', label: 'Picking / Pointer Raycaster', nestingLevel: 'top_level', pick: (f) => f.pickingRaycasterMs },
    { stageKey: 'reactCommitMs', label: 'React <Profiler> Commit Duration', nestingLevel: 'top_level', pick: (f) => f.reactCommitMs },
    { stageKey: 'telemetryHudMs', label: 'Telemetry / HUD Loop Work', nestingLevel: 'top_level', pick: (f) => f.telemetryHudMs },
    { stageKey: 'mapSceneUseFrameOtherMs', label: 'MapScene Other useFrame (shadow/railway)', nestingLevel: 'top_level', pick: (f) => f.mapSceneUseFrameOtherMs },
  ];

  return defs.map((d) => {
    const vals = frames.map(d.pick);
    const stats = computeSampleStatistics(vals, 3);
    const totalMs = roundNum(vals.reduce((a, b) => a + b, 0), 3);
    return {
      stageKey: d.stageKey,
      label: d.label,
      nestingLevel: d.nestingLevel,
      stats,
      totalMs,
    };
  });
}

/**
 * Separates frame-interval distributions across event-conditioned subsets so
 * worker-delivery and tile-commit stalls are never hidden behind quiet VSync frames.
 */
export function summarizeEventConditionedFrames(
  frames: readonly FrameStageProfileSample[]
): EventConditionedFrameSummary {
  const all: number[] = [];
  const workerDelivery: number[] = [];
  const tileCommit: number[] = [];
  const activeStreamingWork: number[] = [];
  const quiet: number[] = [];

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    all.push(f.frameIntervalMs);
    const hasDelivery = (f.workerDeliveriesCount ?? 0) > 0;
    const hasCommit = f.tilesCommittedCount > 0;
    const hasEvict = f.tilesEvictedCount > 0 || (f.deferredDisposedTilesCount ?? 0) > 0;
    const hasGpuPrep = (f.gpuUploadedMeshCount ?? 0) > 0;
    const hasActivation = (f.resolutionActivationMs ?? 0) > 0;
    if (hasDelivery) workerDelivery.push(f.frameIntervalMs);
    if (hasCommit) tileCommit.push(f.frameIntervalMs);
    if (hasDelivery || hasCommit || hasEvict || hasGpuPrep || hasActivation) {
      activeStreamingWork.push(f.frameIntervalMs);
    } else {
      quiet.push(f.frameIntervalMs);
    }
  }

  return {
    allFrames: computeStreamingFrameDistribution(all),
    workerDeliveryFrames: computeStreamingFrameDistribution(workerDelivery),
    tileCommitFrames: computeStreamingFrameDistribution(tileCommit),
    activeStreamingWorkFrames: computeStreamingFrameDistribution(activeStreamingWork),
    quietFrames: computeStreamingFrameDistribution(quiet),
  };
}

/**
 * Summarizes cross-thread worker decode, BVH build/adopt, delivery latency,
 * tile readiness latency (`fetch_start` -> `first_rendered_use`), and streaming throughput.
 */
export function summarizeWorkerDeliveryMetrics(
  events: readonly StreamingLifecycleEvent[],
  frames: readonly FrameStageProfileSample[]
): WorkerDeliverySummary {
  const queueWaits: number[] = [];
  const inflateDecodes: number[] = [];
  const workerBvhs: number[] = [];
  const payloadPreps: number[] = [];
  const deliveryLatencies: number[] = [];
  const mainOnMessages: number[] = [];
  const mainContinuations: number[] = [];
  const reconTotals: number[] = [];
  const mainBvhBuilds: number[] = [];
  const mainBvhAdopts: number[] = [];
  const readinessLatencies: number[] = [];

  let usedWebWorkerCount = 0;
  let usedCompactTransportCount = 0;
  let totalTransferableCount = 0;
  let transferableBytesTotal = 0;
  let workerBvhAdoptedTotal = 0;
  let syncBvhFallbackTotal = 0;

  const fetchStartByTile = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.eventType === 'fetch_start') {
      fetchStartByTile.set(e.tileKey, e.timestampMs);
    } else if (e.eventType === 'worker_message_received' && e.detail) {
      if (e.detail.usedWebWorker) usedWebWorkerCount += 1;
      if (e.detail.usedCompactTransport) usedCompactTransportCount += 1;
      if (typeof e.detail.workerQueueWaitMs === 'number') {
        queueWaits.push(e.detail.workerQueueWaitMs);
      }
      if (typeof e.detail.workerInflateAndDecodeMs === 'number') {
        inflateDecodes.push(e.detail.workerInflateAndDecodeMs);
      }
      if (typeof e.detail.workerBvhBuildMs === 'number') {
        workerBvhs.push(e.detail.workerBvhBuildMs);
      }
      if (typeof e.detail.workerPayloadPrepMs === 'number') {
        payloadPreps.push(e.detail.workerPayloadPrepMs);
      }
      if (typeof e.detail.messageDeliveryLatencyMs === 'number') {
        deliveryLatencies.push(e.detail.messageDeliveryLatencyMs);
      }
      if (typeof e.detail.mainOnMessageHandlerMs === 'number') {
        mainOnMessages.push(e.detail.mainOnMessageHandlerMs);
      }
      if (typeof e.detail.transferableBufferCount === 'number') {
        totalTransferableCount += e.detail.transferableBufferCount;
      }
      if (typeof e.detail.transferableBytes === 'number') {
        transferableBytesTotal += e.detail.transferableBytes;
      }
    } else if (e.eventType === 'decode_complete' && e.detail) {
      if (typeof e.detail.mainPromiseContinuationMs === 'number') {
        mainContinuations.push(e.detail.mainPromiseContinuationMs);
      }
    } else if (e.eventType === 'reconstruct_complete') {
      if (typeof e.durationMs === 'number') {
        reconTotals.push(e.durationMs);
      }
      if (e.detail) {
        if (typeof e.detail.instancedBvhBuildMs === 'number') {
          mainBvhBuilds.push(e.detail.instancedBvhBuildMs);
        }
        if (typeof e.detail.instancedBvhAdoptMs === 'number') {
          mainBvhAdopts.push(e.detail.instancedBvhAdoptMs);
        }
        if (typeof e.detail.workerBvhAdoptedCount === 'number') {
          workerBvhAdoptedTotal += e.detail.workerBvhAdoptedCount;
        }
        if (typeof e.detail.syncBvhFallbackCount === 'number') {
          syncBvhFallbackTotal += e.detail.syncBvhFallbackCount;
        }
      }
    } else if (e.eventType === 'first_rendered_use') {
      const startMs = fetchStartByTile.get(e.tileKey);
      if (typeof startMs === 'number' && e.timestampMs >= startMs) {
        readinessLatencies.push(e.timestampMs - startMs);
        fetchStartByTile.delete(e.tileKey);
      }
    }
  }

  const spanSec =
    frames.length >= 2
      ? Math.max(
          0.001,
          (frames[frames.length - 1].frameTimestampMs - frames[0].frameTimestampMs) /
            1000
        )
      : 0;
  const tilesPerSecond =
    spanSec > 0 ? roundNum(reconTotals.length / spanSec, 2) : 0;

  return {
    deliveryCount: deliveryLatencies.length,
    usedWebWorkerCount,
    usedCompactTransportCount,
    transferableBufferCountMean:
      deliveryLatencies.length > 0
        ? roundNum(totalTransferableCount / deliveryLatencies.length, 1)
        : 0,
    transferableBytesTotal,
    workerBvhAdoptedTotal,
    syncBvhFallbackTotal,
    workerQueueWaitMs: computeSampleStatistics(queueWaits, 3),
    workerInflateAndDecodeMs: computeSampleStatistics(inflateDecodes, 3),
    workerBvhBuildMs: computeSampleStatistics(workerBvhs, 3),
    workerPayloadPrepMs: computeSampleStatistics(payloadPreps, 3),
    messageDeliveryLatencyMs: computeSampleStatistics(deliveryLatencies, 3),
    mainOnMessageHandlerMs: computeSampleStatistics(mainOnMessages, 3),
    mainPromiseContinuationMs: computeSampleStatistics(mainContinuations, 3),
    reconstructTotalMs: computeSampleStatistics(reconTotals, 3),
    mainInstancedBvhBuildMs: computeSampleStatistics(mainBvhBuilds, 3),
    mainInstancedBvhAdoptMs: computeSampleStatistics(mainBvhAdopts, 4),
    tileReadinessLatencyMs: computeSampleStatistics(readinessLatencies, 2),
    tilesPerSecond,
  };
}

/**
 * Verifies the documented stage-nesting invariants so top-level `attributedSyncMainThreadMs`
 * never double-counts child stages.
 */
export function verifyFrameStageNesting(
  frame: FrameStageProfileSample,
  epsilonMs = 0.05
): FrameNestingValidationResult {
  const violations: string[] = [];

  const expectedTopSum =
    frame.cameraUseFrameMs +
    frame.mapSceneUseFrameOtherMs +
    frame.zoomPropagationMs +
    frame.viewportUpdateMs +
    frame.streamTickMs +
    frame.telemetryHudMs +
    frame.pickingRaycasterMs +
    frame.reactCommitMs +
    (frame.workerOnMessageMs ?? 0) +
    (frame.workerContinuationMs ?? 0) +
    frame.glRenderCpuMs;

  if (Math.abs(frame.attributedSyncMainThreadMs - expectedTopSum) > epsilonMs) {
    violations.push(
      `attributedSyncMainThreadMs (${frame.attributedSyncMainThreadMs}) !== sum of top-level stages (${expectedTopSum.toFixed(4)})`
    );
  }

  const camChildren =
    frame.controlsUpdateMs +
    frame.cameraFrustumMs +
    frame.cameraOrientationCallbackMs;
  if (camChildren > frame.cameraUseFrameMs + epsilonMs) {
    violations.push(
      `camera child stages (${camChildren.toFixed(4)}) exceed cameraUseFrameMs (${frame.cameraUseFrameMs})`
    );
  }

  const reconChildren =
    frame.instancedBvhBuildMs +
    (frame.instancedBvhAdoptMs ?? 0) +
    frame.staticBvhDeserializeMs;
  if (reconChildren > frame.reconstructMs + epsilonMs) {
    violations.push(
      `reconstruct child stages (${reconChildren.toFixed(4)}) exceed reconstructMs (${frame.reconstructMs})`
    );
  }

  const tickChildren =
    frame.readyScanAndSortMs +
    frame.reconstructMs +
    frame.sceneAttachMs +
    (frame.gpuUploadSubmitMs ?? 0) +
    (frame.resolutionActivationMs ?? 0) +
    (frame.deferredDisposeMs ?? 0) +
    frame.commitRebuildStatsMs +
    frame.commitEmitDiagnosticsMs;
  if (tickChildren > frame.streamTickMs + epsilonMs) {
    violations.push(
      `streamTick child stages (${tickChildren.toFixed(4)}) exceed streamTickMs (${frame.streamTickMs})`
    );
  }

  const viewportChildren =
    frame.viewportBoundsMs +
    frame.zoomSyncMs +
    frame.tileScanMs +
    frame.cancelInFlightMs +
    frame.evictDisposeMs +
    frame.evictRebuildStatsMs +
    frame.evictEmitDiagnosticsMs +
    frame.pumpFetchQueueMs;
  if (viewportChildren > frame.viewportUpdateMs + epsilonMs) {
    violations.push(
      `viewport child stages (${viewportChildren.toFixed(4)}) exceed viewportUpdateMs (${frame.viewportUpdateMs})`
    );
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Converts shared physical EPSG:25832 UTM coordinates to local study-world [x, 0, z]
 * for any mosaic manifest origin (`+X = East, +Z = South`).
 */
export function utmToLocalTarget(
  easting: number,
  northing: number,
  originEasting: number,
  originNorthing: number
): [number, number, number] {
  const x = easting - originEasting;
  const z = originNorthing - northing;
  return [x === 0 ? 0 : x, 0, z === 0 ? 0 : z];
}
