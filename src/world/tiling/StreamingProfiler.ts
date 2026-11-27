import * as THREE from 'three';
import type { GpuTimerQueryStatus } from '../../types/BenchmarkTelemetry';

export type StreamingLifecycleEventType =
  | 'fetch_start'
  | 'fetch_complete'
  | 'decode_start'
  | 'worker_message_received'
  | 'decode_complete'
  | 'ready_to_commit'
  | 'reconstruct_start'
  | 'reconstruct_complete'
  | 'attach'
  | 'first_rendered_use'
  | 'evict'
  | 'cancel'
  | 'error'
  | 'resolution_transition_start'
  | 'resolution_transition_activate'
  | 'resolution_transition_cancel'
  | 'resolution_transition_defer_budget'
  | 'transition_debounce_start'
  | 'transition_debounce_avoided'
  | 'transition_prep_reused'
  | 'gpu_upload_batch'
  | 'deferred_dispose_enqueue'
  | 'deferred_dispose_complete'
  | 'boundary_overlay_rebuild'
  | 'cache_hit'
  | 'cache_evict';

export interface StreamingQueueDepths {
  queued: number;
  fetching: number;
  decoding: number;
  readyToCommit: number;
  loaded: number;
  visible: number;
}

export interface StreamingLifecycleEvent {
  seq: number;
  timestampMs: number;
  frameIndex: number;
  eventType: StreamingLifecycleEventType;
  tileKey: string;
  tileSizeMeters: number;
  lod: number;
  payloadCompressedBytes: number | null;
  payloadRawBytes: number | null;
  durationMs: number | null;
  queueDepths: StreamingQueueDepths;
  detail?: {
    instancedBvhBuildMs?: number;
    instancedBvhAdoptMs?: number;
    workerBvhAdoptedCount?: number;
    syncBvhFallbackCount?: number;
    staticBvhDeserializeMs?: number;
    instancedBatchCount?: number;
    indexedInstances?: number;
    meshCount?: number;
    triangleCount?: number;
    usedWebWorker?: boolean;
    usedCompactTransport?: boolean;
    transferAllTypedArrays?: boolean;
    workerInstanceBvhEnabled?: boolean;
    workerQueueWaitMs?: number;
    workerInflateMs?: number;
    workerDecodeOnlyMs?: number;
    workerInflateAndDecodeMs?: number;
    workerBvhBuildMs?: number;
    workerPayloadPrepMs?: number;
    messageDeliveryLatencyMs?: number;
    mainOnMessageHandlerMs?: number;
    mainPromiseContinuationMs?: number;
    transferableBufferCount?: number;
    transferableBytes?: number;
    workerBvhBatchCount?: number;
    workerBvhInstanceCount?: number;
    reason?: string;
    driverGeometriesDelta?: number;
    fromResolutionMeters?: number;
    toResolutionMeters?: number;
    transitionGeneration?: number;
    requiredDestinationTiles?: number;
    readyDestinationTiles?: number;
    activationDurationMs?: number;
    gpuUploadedUnits?: number;
    gpuUploadedBytes?: number;
    deferredDisposePendingTiles?: number;
    deferredDisposePendingBytes?: number;
  };
}

/**
 * Explicitly nested synchronous main-thread stage timings for a single WebGL frame.
 *
 * Canonical frame window: `[intervalStartMs, intervalEndMs]` spans post-render of frame
 * `N - 1` to post-render of frame `N`, so every inter-frame callback (`worker.onmessage`,
 * promise continuations, picking, React commits), every `useFrame` callback, and `gl.render()`
 * executing during frame `N` fall strictly inside frame `N`'s `frameIntervalMs`.
 *
 * Non-overlapping top-level main-thread buckets summed into `attributedSyncMainThreadMs`:
 *   1. cameraUseFrameMs (parent of controlsUpdateMs, cameraFrustumMs, cameraOrientationCallbackMs)
 *   2. mapSceneUseFrameOtherMs (shadowFollowMs, railwayIndexRebuildMs, remaining MapScene useFrame logic)
 *   3. zoomPropagationMs (updateCameraZoom across active tiles + callback)
 *   4. viewportUpdateMs (parent of viewportBoundsMs, zoomSyncMs, tileScanMs, cancelInFlightMs,
 *      evictDisposeMs, evictRebuildStatsMs, evictEmitDiagnosticsMs, pumpFetchQueueMs)
 *   5. streamTickMs (parent of readyScanAndSortMs, reconstructMs [parent of instancedBvhBuildMs,
 *      instancedBvhAdoptMs, staticBvhDeserializeMs], sceneAttachMs, commitRebuildStatsMs,
 *      commitEmitDiagnosticsMs)
 *   6. telemetryHudMs (PerformancePanel live HUD computation & callback)
 *   7. pickingRaycasterMs (Raycaster.intersectObjects + pointer hover/click handler overhead in window)
 *   8. reactCommitMs (React <Profiler> actualDuration committed during this frame window)
 *   9. workerOnMessageMs (synchronous JS duration inside TileDecodeClient worker.onmessage handlers)
 *  10. workerContinuationMs (synchronous JS duration inside TileStreamManager post-decode continuations)
 *  11. glRenderCpuMs (CPU wall-clock around gl.render(); may include WebGL driver sync/uploads)
 *
 * Child stages MUST NEVER be added to their parent when computing `attributedSyncMainThreadMs`.
 */
export interface FrameStageProfileSample {
  frameIndex: number;
  intervalStartMs: number;
  intervalEndMs: number;
  rafStartMs: number;
  frameTimestampMs: number;
  frameIntervalMs: number;

  // Top-level mutually exclusive synchronous main-thread buckets
  cameraUseFrameMs: number;
  mapSceneUseFrameOtherMs: number;
  zoomPropagationMs: number;
  viewportUpdateMs: number;
  streamTickMs: number;
  telemetryHudMs: number;
  pickingRaycasterMs: number;
  reactCommitMs: number;
  workerOnMessageMs: number;
  workerContinuationMs: number;
  glRenderCpuMs: number;
  attributedSyncMainThreadMs: number;

  // Nested children of cameraUseFrameMs
  controlsUpdateMs: number;
  cameraFrustumMs: number;
  cameraOrientationCallbackMs: number;

  // Nested children of mapSceneUseFrameOtherMs
  shadowFollowMs: number;
  railwayIndexRebuildMs: number;

  // Nested children of viewportUpdateMs
  viewportBoundsMs: number;
  zoomSyncMs: number;
  tileScanMs: number;
  cancelInFlightMs: number;
  evictDisposeMs: number;
  evictRebuildStatsMs: number;
  evictEmitDiagnosticsMs: number;
  pumpFetchQueueMs: number;

  // Nested children of streamTickMs
  readyScanAndSortMs: number;
  reconstructMs: number;
  instancedBvhBuildMs: number;
  instancedBvhAdoptMs: number;
  staticBvhDeserializeMs: number;
  sceneAttachMs: number;
  commitRebuildStatsMs: number;
  commitEmitDiagnosticsMs: number;
  tilesCommittedCount: number;
  tilesEvictedCount: number;
  tilesCancelledCount: number;
  workerBvhAdoptedCount: number;
  syncBvhFallbackCount: number;

  // TKT-041-F1 nested children of streamTickMs (NOT added to attributedSyncMainThreadMs)
  gpuUploadSubmitMs: number;
  gpuUploadedBytes: number;
  gpuUploadedMeshCount: number;
  resolutionActivationMs: number;
  boundaryOverlayRebuildMs: number;
  deferredDisposeMs: number;
  deferredDisposedTilesCount: number;
  schedulerBudgetMs: number;
  schedulerUsedMs: number;
  schedulerOverrunMs: number;
  indivisibleOverrunCount: number;
  hasValidViewportCoverage: boolean;

  // Worker delivery summary inside this frame window
  workerDeliveriesCount: number;
  workerDeliveryLatencyMaxMs: number;
  workerBvhBuildMsTotal: number;
  transferableBytesTotal: number;
  usedCompactTransportCount: number;

  // Nested picking/react details
  pickingCallsCount: number;
  reactCommitsCount: number;

  // First-render proxy telemetry (NOT a direct measurement of GPU upload time)
  newlyAttachedTilesCount: number;
  newlyAttachedTileKeys: string[];
  newlyAttachedTriangles: number;
  newlyAttachedMeshes: number;
  driverGeometriesBeforeRender: number;
  driverGeometriesAfterRender: number;
  driverGeometriesDelta: number;

  // Render & GPU state
  renderCalls: number;
  renderTriangles: number;
  driverGeometries: number;
  driverTextures: number;
  driverPrograms: number;
  gpuTimerQuerySupported: boolean;
  gpuTimerStatus: GpuTimerQueryStatus;
  gpuDisjointOccurred: boolean;
  gpuPassTimeMs: number | null;

  // Snapshot metadata
  cameraTargetX: number;
  cameraTargetZ: number;
  cameraZoom: number;
  cameraAzimuthDeg: number;
  queueDepths: StreamingQueueDepths;
}

export interface BrowserLongTaskSample {
  seq: number;
  startTimeMs: number;
  durationMs: number;
  name: string;
  attributionName: string | null;
  containerType: string | null;
  containerName: string | null;
}

export interface BrowserLoafScriptSample {
  invoker: string;
  invokerType: string;
  sourceURL: string;
  sourceFunctionName: string;
  durationMs: number;
  forcedStyleAndLayoutDurationMs: number;
}

export interface BrowserLoafSample {
  seq: number;
  startTimeMs: number;
  durationMs: number;
  blockingDurationMs: number;
  renderStartMs: number;
  styleAndLayoutStartMs: number;
  firstUIEventTimestampMs: number;
  topScripts: BrowserLoafScriptSample[];
}

export interface PendingFirstRenderTileInfo {
  tileKey: string;
  tileSizeMeters: number;
  lod: number;
  triangles: number;
  meshes: number;
  compressedBytes: number | null;
  rawBytes: number | null;
  attachTimestampMs: number;
}

export interface StreamingProfilerOptions {
  maxFrames?: number;
  maxEvents?: number;
  maxBrowserEntries?: number;
  installBrowserObservers?: boolean;
  instrumentRaycaster?: boolean;
}

export interface StreamingProfilerSnapshot {
  enabled: boolean;
  sessionLabel: string | null;
  sessionStartMs: number;
  sessionEndMs: number;
  totalFramesRecorded: number;
  droppedFramesCount: number;
  totalEventsRecorded: number;
  droppedEventsCount: number;
  browserObservers: {
    longTaskSupported: boolean;
    loafSupported: boolean;
    longTaskCount: number;
    loafCount: number;
  };
  frames: FrameStageProfileSample[];
  events: StreamingLifecycleEvent[];
  longTasks: BrowserLongTaskSample[];
  loafs: BrowserLoafSample[];
}

function roundMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Number(value.toFixed(4));
}

function emptyQueueDepths(): StreamingQueueDepths {
  return {
    queued: 0,
    fetching: 0,
    decoding: 0,
    readyToCommit: 0,
    loaded: 0,
    visible: 0,
  };
}

interface MutableFrameAccumulator {
  frameIndex: number;
  rafStartMs: number;
  frameIntervalMs: number;

  cameraUseFrameMs: number;
  controlsUpdateMs: number;
  cameraFrustumMs: number;
  cameraOrientationCallbackMs: number;

  mapSceneUseFrameTotalMs: number;
  shadowFollowMs: number;
  zoomPropagationMs: number;
  viewportFrameUpdateMs: number;
  railwayIndexRebuildMs: number;
  telemetryHudMs: number;

  viewportUpdateMs: number;
  viewportBoundsMs: number;
  zoomSyncMs: number;
  tileScanMs: number;
  cancelInFlightMs: number;
  evictDisposeMs: number;
  evictRebuildStatsMs: number;
  evictEmitDiagnosticsMs: number;
  pumpFetchQueueMs: number;

  streamTickMs: number;
  readyScanAndSortMs: number;
  reconstructMs: number;
  instancedBvhBuildMs: number;
  instancedBvhAdoptMs: number;
  staticBvhDeserializeMs: number;
  sceneAttachMs: number;
  commitRebuildStatsMs: number;
  commitEmitDiagnosticsMs: number;
  tilesCommittedCount: number;
  tilesEvictedCount: number;
  tilesCancelledCount: number;
  workerBvhAdoptedCount: number;
  syncBvhFallbackCount: number;

  gpuUploadSubmitMs: number;
  gpuUploadedBytes: number;
  gpuUploadedMeshCount: number;
  resolutionActivationMs: number;
  boundaryOverlayRebuildMs: number;
  deferredDisposeMs: number;
  deferredDisposedTilesCount: number;
  schedulerBudgetMs: number;
  schedulerUsedMs: number;
  schedulerOverrunMs: number;
  indivisibleOverrunCount: number;
  hasValidViewportCoverage: boolean;

  pickingRaycasterMs: number;
  pickingCallsCount: number;
  reactCommitMs: number;
  reactCommitsCount: number;

  pendingFirstRenderTiles: PendingFirstRenderTileInfo[];
  driverGeometriesBeforeRender: number;

  cameraTargetX: number;
  cameraTargetZ: number;
  cameraZoom: number;
  cameraAzimuthDeg: number;
  queueDepths: StreamingQueueDepths;
}

function createEmptyAccumulator(frameIndex: number): MutableFrameAccumulator {
  return {
    frameIndex,
    rafStartMs: 0,
    frameIntervalMs: 0,
    cameraUseFrameMs: 0,
    controlsUpdateMs: 0,
    cameraFrustumMs: 0,
    cameraOrientationCallbackMs: 0,
    mapSceneUseFrameTotalMs: 0,
    shadowFollowMs: 0,
    zoomPropagationMs: 0,
    viewportFrameUpdateMs: 0,
    railwayIndexRebuildMs: 0,
    telemetryHudMs: 0,
    viewportUpdateMs: 0,
    viewportBoundsMs: 0,
    zoomSyncMs: 0,
    tileScanMs: 0,
    cancelInFlightMs: 0,
    evictDisposeMs: 0,
    evictRebuildStatsMs: 0,
    evictEmitDiagnosticsMs: 0,
    pumpFetchQueueMs: 0,
    streamTickMs: 0,
    readyScanAndSortMs: 0,
    reconstructMs: 0,
    instancedBvhBuildMs: 0,
    instancedBvhAdoptMs: 0,
    staticBvhDeserializeMs: 0,
    sceneAttachMs: 0,
    commitRebuildStatsMs: 0,
    commitEmitDiagnosticsMs: 0,
    tilesCommittedCount: 0,
    tilesEvictedCount: 0,
    tilesCancelledCount: 0,
    workerBvhAdoptedCount: 0,
    syncBvhFallbackCount: 0,
    gpuUploadSubmitMs: 0,
    gpuUploadedBytes: 0,
    gpuUploadedMeshCount: 0,
    resolutionActivationMs: 0,
    boundaryOverlayRebuildMs: 0,
    deferredDisposeMs: 0,
    deferredDisposedTilesCount: 0,
    schedulerBudgetMs: 0,
    schedulerUsedMs: 0,
    schedulerOverrunMs: 0,
    indivisibleOverrunCount: 0,
    hasValidViewportCoverage: true,
    pickingRaycasterMs: 0,
    pickingCallsCount: 0,
    reactCommitMs: 0,
    reactCommitsCount: 0,
    pendingFirstRenderTiles: [],
    driverGeometriesBeforeRender: 0,
    cameraTargetX: 0,
    cameraTargetZ: 0,
    cameraZoom: 1,
    cameraAzimuthDeg: 45,
    queueDepths: emptyQueueDepths(),
  };
}

class BoundedRing<T> {
  private readonly capacity: number;
  private buffer: T[] = [];
  private writePos = 0;
  public totalInserted = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  push(item: T): void {
    this.totalInserted += 1;
    if (this.buffer.length < this.capacity) {
      this.buffer.push(item);
      if (this.buffer.length === this.capacity) {
        this.writePos = 0;
      }
      return;
    }
    this.buffer[this.writePos] = item;
    this.writePos = (this.writePos + 1) % this.capacity;
  }

  get droppedCount(): number {
    return Math.max(0, this.totalInserted - this.buffer.length);
  }

  get length(): number {
    return this.buffer.length;
  }

  toArray(): T[] {
    if (this.buffer.length < this.capacity) {
      return [...this.buffer];
    }
    if (this.writePos === 0) {
      return [...this.buffer];
    }
    return [
      ...this.buffer.slice(this.writePos),
      ...this.buffer.slice(0, this.writePos),
    ];
  }

  clear(): void {
    this.buffer.length = 0;
    this.writePos = 0;
    this.totalInserted = 0;
  }
}

/**
 * Opt-in, bounded-memory profiler capturing per-frame nested main-thread stages,
 * tile streaming lifecycle events, first-render attachment proxies, Raycaster work,
 * React commits, and browser LongTask / Long Animation Frame entries.
 *
 * When `enabled === false`, all hot-path methods return immediately with zero allocations
 * and zero browser observers attached.
 */
export class StreamingProfiler {
  private _enabled = false;
  private sessionLabel: string | null = null;
  private sessionStartMs = 0;
  private sessionEndMs = 0;
  private frameSeq = 0;
  private eventSeq = 0;
  private longTaskSeq = 0;
  private loafSeq = 0;

  private readonly framesRing: BoundedRing<FrameStageProfileSample>;
  private readonly eventsRing: BoundedRing<StreamingLifecycleEvent>;
  private readonly longTasksRing: BoundedRing<BrowserLongTaskSample>;
  private readonly loafsRing: BoundedRing<BrowserLoafSample>;

  private currentAcc: MutableFrameAccumulator;
  private lastFinishedFrameEndMs = 0;
  private interFramePickingMs = 0;
  private interFramePickingCalls = 0;
  private interFrameReactCommitMs = 0;
  private interFrameReactCommits = 0;
  private interFrameWorkerOnMessageMs = 0;
  private interFrameWorkerContinuationMs = 0;
  private interFrameWorkerDeliveriesCount = 0;
  private interFrameWorkerDeliveryLatencyMaxMs = 0;
  private interFrameWorkerBvhBuildMsTotal = 0;
  private interFrameTransferableBytesTotal = 0;
  private interFrameUsedCompactTransportCount = 0;
  private pendingFirstRenderTiles: PendingFirstRenderTileInfo[] = [];

  private readonly installBrowserObserversOpt: boolean;
  private readonly instrumentRaycasterOpt: boolean;
  private longTaskSupported = false;
  private loafSupported = false;
  private longTaskObserver: PerformanceObserver | null = null;
  private loafObserver: PerformanceObserver | null = null;

  private origRaycasterIntersectObjects:
    | typeof THREE.Raycaster.prototype.intersectObjects
    | null = null;
  private origRaycasterIntersectObject:
    | typeof THREE.Raycaster.prototype.intersectObject
    | null = null;
  private raycasterCallDepth = 0;

  constructor(options: StreamingProfilerOptions = {}) {
    this.framesRing = new BoundedRing<FrameStageProfileSample>(
      options.maxFrames ?? 16384
    );
    this.eventsRing = new BoundedRing<StreamingLifecycleEvent>(
      options.maxEvents ?? 8192
    );
    this.longTasksRing = new BoundedRing<BrowserLongTaskSample>(
      options.maxBrowserEntries ?? 1024
    );
    this.loafsRing = new BoundedRing<BrowserLoafSample>(
      options.maxBrowserEntries ?? 1024
    );
    this.installBrowserObserversOpt = options.installBrowserObservers ?? true;
    this.instrumentRaycasterOpt = options.instrumentRaycaster ?? true;
    this.currentAcc = createEmptyAccumulator(0);
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get currentFrameIndex(): number {
    return this.frameSeq;
  }

  setEnabled(enabled: boolean, sessionLabel?: string | null): void {
    const next = Boolean(enabled);
    if (next === this._enabled) {
      if (next && sessionLabel !== undefined) {
        this.sessionLabel = sessionLabel;
      }
      return;
    }
    this._enabled = next;
    if (next) {
      this.sessionLabel = sessionLabel ?? this.sessionLabel;
      this.sessionStartMs = performance.now();
      this.sessionEndMs = 0;
      if (this.installBrowserObserversOpt) {
        this.startBrowserObservers();
      }
      if (this.instrumentRaycasterOpt) {
        this.installRaycasterHook();
      }
    } else {
      this.sessionEndMs = performance.now();
      this.stopBrowserObservers();
      this.uninstallRaycasterHook();
    }
  }

  reset(sessionLabel?: string | null): void {
    this.frameSeq = 0;
    this.eventSeq = 0;
    this.longTaskSeq = 0;
    this.loafSeq = 0;
    this.framesRing.clear();
    this.eventsRing.clear();
    this.longTasksRing.clear();
    this.loafsRing.clear();
    this.currentAcc = createEmptyAccumulator(0);
    this.lastFinishedFrameEndMs = 0;
    this.interFramePickingMs = 0;
    this.interFramePickingCalls = 0;
    this.interFrameReactCommitMs = 0;
    this.interFrameReactCommits = 0;
    this.interFrameWorkerOnMessageMs = 0;
    this.interFrameWorkerContinuationMs = 0;
    this.interFrameWorkerDeliveriesCount = 0;
    this.interFrameWorkerDeliveryLatencyMaxMs = 0;
    this.interFrameWorkerBvhBuildMsTotal = 0;
    this.interFrameTransferableBytesTotal = 0;
    this.interFrameUsedCompactTransportCount = 0;
    this.pendingFirstRenderTiles = [];
    this.sessionLabel = sessionLabel ?? null;
    this.sessionStartMs = this._enabled ? performance.now() : 0;
    this.sessionEndMs = 0;
  }

  dispose(): void {
    this.setEnabled(false);
    this.reset();
  }

  recordCameraUseFrame(stats: {
    totalMs: number;
    controlsUpdateMs: number;
    frustumMs: number;
    orientationCallbackMs: number;
    targetX?: number;
    targetZ?: number;
    zoom?: number;
    azimuthDeg?: number;
  }): void {
    if (!this._enabled) return;
    const acc = this.currentAcc;
    acc.cameraUseFrameMs += stats.totalMs;
    acc.controlsUpdateMs += stats.controlsUpdateMs;
    acc.cameraFrustumMs += stats.frustumMs;
    acc.cameraOrientationCallbackMs += stats.orientationCallbackMs;
    if (typeof stats.targetX === 'number') acc.cameraTargetX = stats.targetX;
    if (typeof stats.targetZ === 'number') acc.cameraTargetZ = stats.targetZ;
    if (typeof stats.zoom === 'number') acc.cameraZoom = stats.zoom;
    if (typeof stats.azimuthDeg === 'number') {
      acc.cameraAzimuthDeg = stats.azimuthDeg;
    }
  }

  recordViewportFrameStart(rafStartMs: number, frameIntervalMs?: number): void {
    if (!this._enabled) return;
    this.currentAcc.rafStartMs = rafStartMs;
    if (typeof frameIntervalMs === 'number' && Number.isFinite(frameIntervalMs)) {
      this.currentAcc.frameIntervalMs = frameIntervalMs;
    }
  }

  recordViewportUpdate(stats: {
    totalMs: number;
    viewportBoundsMs?: number;
    zoomSyncMs?: number;
    tileScanMs: number;
    cancelInFlightMs: number;
    evictDisposeMs: number;
    evictRebuildStatsMs: number;
    evictEmitDiagnosticsMs: number;
    pumpFetchQueueMs: number;
    tilesEvictedCount?: number;
    tilesCancelledCount?: number;
  }): void {
    if (!this._enabled) return;
    const acc = this.currentAcc;
    acc.viewportUpdateMs += stats.totalMs;
    acc.viewportBoundsMs += stats.viewportBoundsMs ?? 0;
    acc.zoomSyncMs += stats.zoomSyncMs ?? 0;
    acc.tileScanMs += stats.tileScanMs;
    acc.cancelInFlightMs += stats.cancelInFlightMs;
    acc.evictDisposeMs += stats.evictDisposeMs;
    acc.evictRebuildStatsMs += stats.evictRebuildStatsMs;
    acc.evictEmitDiagnosticsMs += stats.evictEmitDiagnosticsMs;
    acc.pumpFetchQueueMs += stats.pumpFetchQueueMs;
    acc.tilesEvictedCount += stats.tilesEvictedCount ?? 0;
    acc.tilesCancelledCount += stats.tilesCancelledCount ?? 0;
  }

  recordViewportBoundsDuration(boundsMs: number, zoomSyncMs: number): void {
    if (!this._enabled) return;
    this.currentAcc.viewportBoundsMs += boundsMs;
    this.currentAcc.zoomSyncMs += zoomSyncMs;
    this.currentAcc.viewportUpdateMs += boundsMs + zoomSyncMs;
  }

  recordStreamTick(stats: {
    totalMs: number;
    readyScanAndSortMs: number;
    reconstructMs: number;
    instancedBvhBuildMs: number;
    instancedBvhAdoptMs?: number;
    workerBvhAdoptedCount?: number;
    syncBvhFallbackCount?: number;
    staticBvhDeserializeMs: number;
    sceneAttachMs: number;
    commitRebuildStatsMs: number;
    commitEmitDiagnosticsMs: number;
    tilesCommittedCount: number;
    gpuUploadSubmitMs?: number;
    gpuUploadedBytes?: number;
    gpuUploadedMeshCount?: number;
    resolutionActivationMs?: number;
    boundaryOverlayRebuildMs?: number;
    deferredDisposeMs?: number;
    deferredDisposedTilesCount?: number;
    schedulerBudgetMs?: number;
    schedulerUsedMs?: number;
    schedulerOverrunMs?: number;
    indivisibleOverrunCount?: number;
    hasValidViewportCoverage?: boolean;
  }): void {
    if (!this._enabled) return;
    const acc = this.currentAcc;
    acc.streamTickMs += stats.totalMs;
    acc.readyScanAndSortMs += stats.readyScanAndSortMs;
    acc.reconstructMs += stats.reconstructMs;
    acc.instancedBvhBuildMs += stats.instancedBvhBuildMs;
    acc.instancedBvhAdoptMs += stats.instancedBvhAdoptMs ?? 0;
    acc.workerBvhAdoptedCount += stats.workerBvhAdoptedCount ?? 0;
    acc.syncBvhFallbackCount += stats.syncBvhFallbackCount ?? 0;
    acc.staticBvhDeserializeMs += stats.staticBvhDeserializeMs;
    acc.sceneAttachMs += stats.sceneAttachMs;
    acc.commitRebuildStatsMs += stats.commitRebuildStatsMs;
    acc.commitEmitDiagnosticsMs += stats.commitEmitDiagnosticsMs;
    acc.tilesCommittedCount += stats.tilesCommittedCount;
    acc.gpuUploadSubmitMs += stats.gpuUploadSubmitMs ?? 0;
    acc.gpuUploadedBytes += stats.gpuUploadedBytes ?? 0;
    acc.gpuUploadedMeshCount += stats.gpuUploadedMeshCount ?? 0;
    acc.resolutionActivationMs += stats.resolutionActivationMs ?? 0;
    acc.boundaryOverlayRebuildMs += stats.boundaryOverlayRebuildMs ?? 0;
    acc.deferredDisposeMs += stats.deferredDisposeMs ?? 0;
    acc.deferredDisposedTilesCount += stats.deferredDisposedTilesCount ?? 0;
    if (typeof stats.schedulerBudgetMs === 'number') {
      acc.schedulerBudgetMs = stats.schedulerBudgetMs;
    }
    acc.schedulerUsedMs += stats.schedulerUsedMs ?? 0;
    acc.schedulerOverrunMs += stats.schedulerOverrunMs ?? 0;
    acc.indivisibleOverrunCount += stats.indivisibleOverrunCount ?? 0;
    if (typeof stats.hasValidViewportCoverage === 'boolean') {
      acc.hasValidViewportCoverage =
        acc.hasValidViewportCoverage && stats.hasValidViewportCoverage;
    }
  }

  recordMapSceneUseFrame(stats: {
    totalMs: number;
    shadowFollowMs: number;
    zoomPropagationMs: number;
    viewportFrameUpdateMs: number;
    railwayIndexRebuildMs: number;
    telemetryHudMs: number;
  }): void {
    if (!this._enabled) return;
    const acc = this.currentAcc;
    acc.mapSceneUseFrameTotalMs += stats.totalMs;
    acc.shadowFollowMs += stats.shadowFollowMs;
    acc.zoomPropagationMs += stats.zoomPropagationMs;
    acc.viewportFrameUpdateMs += stats.viewportFrameUpdateMs;
    acc.railwayIndexRebuildMs += stats.railwayIndexRebuildMs;
    acc.telemetryHudMs += stats.telemetryHudMs;
  }

  recordQueueDepths(depths: StreamingQueueDepths): void {
    if (!this._enabled) return;
    this.currentAcc.queueDepths = { ...depths };
  }

  recordPickingDuration(durationMs: number): void {
    if (!this._enabled) return;
    this.interFramePickingMs += Math.max(0, durationMs);
    this.interFramePickingCalls += 1;
  }

  recordReactCommit(actualDurationMs: number): void {
    if (!this._enabled) return;
    this.interFrameReactCommitMs += Math.max(0, actualDurationMs);
    this.interFrameReactCommits += 1;
  }

  recordWorkerOnMessage(stats: {
    durationMs: number;
    deliveryLatencyMs?: number;
    workerBvhBuildMs?: number;
    transferableBytes?: number;
    usedCompactTransport?: boolean;
  }): void {
    if (!this._enabled) return;
    this.interFrameWorkerOnMessageMs += Math.max(0, stats.durationMs);
    this.interFrameWorkerDeliveriesCount += 1;
    if (
      typeof stats.deliveryLatencyMs === 'number' &&
      stats.deliveryLatencyMs > this.interFrameWorkerDeliveryLatencyMaxMs
    ) {
      this.interFrameWorkerDeliveryLatencyMaxMs = stats.deliveryLatencyMs;
    }
    if (typeof stats.workerBvhBuildMs === 'number' && stats.workerBvhBuildMs > 0) {
      this.interFrameWorkerBvhBuildMsTotal += stats.workerBvhBuildMs;
    }
    if (typeof stats.transferableBytes === 'number' && stats.transferableBytes > 0) {
      this.interFrameTransferableBytesTotal += stats.transferableBytes;
    }
    if (stats.usedCompactTransport) {
      this.interFrameUsedCompactTransportCount += 1;
    }
  }

  recordWorkerContinuation(durationMs: number): void {
    if (!this._enabled) return;
    this.interFrameWorkerContinuationMs += Math.max(0, durationMs);
  }

  markTilePendingFirstRender(info: PendingFirstRenderTileInfo): void {
    if (!this._enabled) return;
    this.pendingFirstRenderTiles.push(info);
  }

  markBeforeGlRender(driverGeometries: number): void {
    if (!this._enabled) return;
    this.currentAcc.driverGeometriesBeforeRender = driverGeometries;
  }

  recordEvent(params: {
    eventType: StreamingLifecycleEventType;
    tileKey: string;
    tileSizeMeters: number;
    lod: number;
    timestampMs?: number;
    frameIndex?: number;
    payloadCompressedBytes?: number | null;
    payloadRawBytes?: number | null;
    durationMs?: number | null;
    queueDepths: StreamingQueueDepths;
    detail?: StreamingLifecycleEvent['detail'];
  }): void {
    if (!this._enabled) return;
    // Events emitted while frame `this.frameSeq + 1` is accumulating belong to frame `this.frameSeq + 1`.
    const effectiveFrameIndex =
      typeof params.frameIndex === 'number' ? params.frameIndex : this.frameSeq + 1;
    const evt: StreamingLifecycleEvent = {
      seq: ++this.eventSeq,
      timestampMs: roundMs(params.timestampMs ?? performance.now()),
      frameIndex: effectiveFrameIndex,
      eventType: params.eventType,
      tileKey: params.tileKey,
      tileSizeMeters: params.tileSizeMeters,
      lod: params.lod,
      payloadCompressedBytes: params.payloadCompressedBytes ?? null,
      payloadRawBytes: params.payloadRawBytes ?? null,
      durationMs:
        params.durationMs !== undefined && params.durationMs !== null
          ? roundMs(params.durationMs)
          : null,
      queueDepths: { ...params.queueDepths },
      ...(params.detail ? { detail: params.detail } : {}),
    };
    this.eventsRing.push(evt);
  }

  finishRenderFrame(params: {
    intervalStartMs?: number;
    frameTimestampMs: number;
    frameIntervalMs: number;
    glRenderCpuMs: number;
    renderCalls: number;
    renderTriangles: number;
    driverGeometries: number;
    driverTextures: number;
    driverPrograms: number;
    gpuTimerQuerySupported: boolean;
    gpuTimerStatus: GpuTimerQueryStatus;
    gpuDisjointOccurred: boolean;
    gpuPassTimeMs: number | null;
    cameraTargetX?: number;
    cameraTargetZ?: number;
    cameraZoom?: number;
    cameraAzimuthDeg?: number;
  }): FrameStageProfileSample | null {
    if (!this._enabled) return null;

    const acc = this.currentAcc;
    const frameIndex = ++this.frameSeq;

    const intervalEndMs = params.frameTimestampMs;
    const intervalStartMs =
      typeof params.intervalStartMs === 'number' &&
      Number.isFinite(params.intervalStartMs)
        ? params.intervalStartMs
        : this.lastFinishedFrameEndMs > 0
          ? this.lastFinishedFrameEndMs
          : Math.max(0, intervalEndMs - Math.max(0, params.frameIntervalMs));
    const effectiveFrameIntervalMs =
      typeof params.intervalStartMs === 'number' &&
      Number.isFinite(params.intervalStartMs)
        ? Math.max(0, intervalEndMs - intervalStartMs)
        : params.frameIntervalMs > 0
          ? params.frameIntervalMs
          : acc.frameIntervalMs;
    this.lastFinishedFrameEndMs = intervalEndMs;

    // Combine explicit viewportUpdateMs + streamTickMs cleanly (nested inside viewportFrameUpdateMs)
    const viewportPlusTickMs = acc.viewportUpdateMs + acc.streamTickMs;
    const mapSceneUseFrameOtherMs = Math.max(
      0,
      acc.mapSceneUseFrameTotalMs -
        acc.zoomPropagationMs -
        Math.max(acc.viewportFrameUpdateMs, viewportPlusTickMs) -
        acc.telemetryHudMs
    );

    const pickingRaycasterMs = this.interFramePickingMs;
    const pickingCallsCount = this.interFramePickingCalls;
    const reactCommitMs = this.interFrameReactCommitMs;
    const reactCommitsCount = this.interFrameReactCommits;
    const workerOnMessageMs = this.interFrameWorkerOnMessageMs;
    const workerContinuationMs = this.interFrameWorkerContinuationMs;
    const workerDeliveriesCount = this.interFrameWorkerDeliveriesCount;
    const workerDeliveryLatencyMaxMs = this.interFrameWorkerDeliveryLatencyMaxMs;
    const workerBvhBuildMsTotal = this.interFrameWorkerBvhBuildMsTotal;
    const transferableBytesTotal = this.interFrameTransferableBytesTotal;
    const usedCompactTransportCount = this.interFrameUsedCompactTransportCount;

    this.interFramePickingMs = 0;
    this.interFramePickingCalls = 0;
    this.interFrameReactCommitMs = 0;
    this.interFrameReactCommits = 0;
    this.interFrameWorkerOnMessageMs = 0;
    this.interFrameWorkerContinuationMs = 0;
    this.interFrameWorkerDeliveriesCount = 0;
    this.interFrameWorkerDeliveryLatencyMaxMs = 0;
    this.interFrameWorkerBvhBuildMsTotal = 0;
    this.interFrameTransferableBytesTotal = 0;
    this.interFrameUsedCompactTransportCount = 0;

    const newlyAttached = this.pendingFirstRenderTiles.splice(
      0,
      this.pendingFirstRenderTiles.length
    );
    let newlyAttachedTriangles = 0;
    let newlyAttachedMeshes = 0;
    const newlyAttachedTileKeys: string[] = [];
    const driverGeometriesDelta =
      params.driverGeometries - acc.driverGeometriesBeforeRender;

    for (let i = 0; i < newlyAttached.length; i++) {
      const tile = newlyAttached[i];
      newlyAttachedTriangles += tile.triangles;
      newlyAttachedMeshes += tile.meshes;
      newlyAttachedTileKeys.push(tile.tileKey);
      this.recordEvent({
        eventType: 'first_rendered_use',
        tileKey: tile.tileKey,
        tileSizeMeters: tile.tileSizeMeters,
        lod: tile.lod,
        timestampMs: intervalEndMs,
        frameIndex,
        payloadCompressedBytes: tile.compressedBytes,
        payloadRawBytes: tile.rawBytes,
        durationMs: intervalEndMs - tile.attachTimestampMs,
        queueDepths: acc.queueDepths,
        detail: {
          meshCount: tile.meshes,
          triangleCount: tile.triangles,
          driverGeometriesDelta,
        },
      });
    }

    const attributedSyncMainThreadMs =
      acc.cameraUseFrameMs +
      mapSceneUseFrameOtherMs +
      acc.zoomPropagationMs +
      acc.viewportUpdateMs +
      acc.streamTickMs +
      acc.telemetryHudMs +
      pickingRaycasterMs +
      reactCommitMs +
      workerOnMessageMs +
      workerContinuationMs +
      params.glRenderCpuMs;

    const sample: FrameStageProfileSample = {
      frameIndex,
      intervalStartMs: roundMs(intervalStartMs),
      intervalEndMs: roundMs(intervalEndMs),
      rafStartMs: roundMs(acc.rafStartMs || intervalEndMs),
      frameTimestampMs: roundMs(intervalEndMs),
      frameIntervalMs: roundMs(effectiveFrameIntervalMs),

      cameraUseFrameMs: roundMs(acc.cameraUseFrameMs),
      mapSceneUseFrameOtherMs: roundMs(mapSceneUseFrameOtherMs),
      zoomPropagationMs: roundMs(acc.zoomPropagationMs),
      viewportUpdateMs: roundMs(acc.viewportUpdateMs),
      streamTickMs: roundMs(acc.streamTickMs),
      telemetryHudMs: roundMs(acc.telemetryHudMs),
      pickingRaycasterMs: roundMs(pickingRaycasterMs),
      reactCommitMs: roundMs(reactCommitMs),
      workerOnMessageMs: roundMs(workerOnMessageMs),
      workerContinuationMs: roundMs(workerContinuationMs),
      glRenderCpuMs: roundMs(params.glRenderCpuMs),
      attributedSyncMainThreadMs: roundMs(attributedSyncMainThreadMs),

      controlsUpdateMs: roundMs(acc.controlsUpdateMs),
      cameraFrustumMs: roundMs(acc.cameraFrustumMs),
      cameraOrientationCallbackMs: roundMs(acc.cameraOrientationCallbackMs),

      shadowFollowMs: roundMs(acc.shadowFollowMs),
      railwayIndexRebuildMs: roundMs(acc.railwayIndexRebuildMs),

      viewportBoundsMs: roundMs(acc.viewportBoundsMs),
      zoomSyncMs: roundMs(acc.zoomSyncMs),
      tileScanMs: roundMs(acc.tileScanMs),
      cancelInFlightMs: roundMs(acc.cancelInFlightMs),
      evictDisposeMs: roundMs(acc.evictDisposeMs),
      evictRebuildStatsMs: roundMs(acc.evictRebuildStatsMs),
      evictEmitDiagnosticsMs: roundMs(acc.evictEmitDiagnosticsMs),
      pumpFetchQueueMs: roundMs(acc.pumpFetchQueueMs),

      readyScanAndSortMs: roundMs(acc.readyScanAndSortMs),
      reconstructMs: roundMs(acc.reconstructMs),
      instancedBvhBuildMs: roundMs(acc.instancedBvhBuildMs),
      instancedBvhAdoptMs: roundMs(acc.instancedBvhAdoptMs),
      staticBvhDeserializeMs: roundMs(acc.staticBvhDeserializeMs),
      sceneAttachMs: roundMs(acc.sceneAttachMs),
      commitRebuildStatsMs: roundMs(acc.commitRebuildStatsMs),
      commitEmitDiagnosticsMs: roundMs(acc.commitEmitDiagnosticsMs),
      tilesCommittedCount: acc.tilesCommittedCount,
      tilesEvictedCount: acc.tilesEvictedCount,
      tilesCancelledCount: acc.tilesCancelledCount,
      workerBvhAdoptedCount: acc.workerBvhAdoptedCount,
      syncBvhFallbackCount: acc.syncBvhFallbackCount,

      gpuUploadSubmitMs: roundMs(acc.gpuUploadSubmitMs),
      gpuUploadedBytes: acc.gpuUploadedBytes,
      gpuUploadedMeshCount: acc.gpuUploadedMeshCount,
      resolutionActivationMs: roundMs(acc.resolutionActivationMs),
      boundaryOverlayRebuildMs: roundMs(acc.boundaryOverlayRebuildMs),
      deferredDisposeMs: roundMs(acc.deferredDisposeMs),
      deferredDisposedTilesCount: acc.deferredDisposedTilesCount,
      schedulerBudgetMs: roundMs(acc.schedulerBudgetMs),
      schedulerUsedMs: roundMs(acc.schedulerUsedMs),
      schedulerOverrunMs: roundMs(acc.schedulerOverrunMs),
      indivisibleOverrunCount: acc.indivisibleOverrunCount,
      hasValidViewportCoverage: acc.hasValidViewportCoverage,

      workerDeliveriesCount,
      workerDeliveryLatencyMaxMs: roundMs(workerDeliveryLatencyMaxMs),
      workerBvhBuildMsTotal: roundMs(workerBvhBuildMsTotal),
      transferableBytesTotal,
      usedCompactTransportCount,

      pickingCallsCount,
      reactCommitsCount,

      newlyAttachedTilesCount: newlyAttached.length,
      newlyAttachedTileKeys,
      newlyAttachedTriangles,
      newlyAttachedMeshes,
      driverGeometriesBeforeRender: acc.driverGeometriesBeforeRender,
      driverGeometriesAfterRender: params.driverGeometries,
      driverGeometriesDelta,

      renderCalls: params.renderCalls,
      renderTriangles: params.renderTriangles,
      driverGeometries: params.driverGeometries,
      driverTextures: params.driverTextures,
      driverPrograms: params.driverPrograms,
      gpuTimerQuerySupported: params.gpuTimerQuerySupported,
      gpuTimerStatus: params.gpuTimerStatus,
      gpuDisjointOccurred: params.gpuDisjointOccurred,
      gpuPassTimeMs: params.gpuPassTimeMs,

      cameraTargetX: roundMs(params.cameraTargetX ?? acc.cameraTargetX),
      cameraTargetZ: roundMs(params.cameraTargetZ ?? acc.cameraTargetZ),
      cameraZoom: roundMs(params.cameraZoom ?? acc.cameraZoom),
      cameraAzimuthDeg: Math.round(params.cameraAzimuthDeg ?? acc.cameraAzimuthDeg),
      queueDepths: { ...acc.queueDepths },
    };

    this.framesRing.push(sample);
    this.currentAcc = createEmptyAccumulator(frameIndex);
    return sample;
  }

  getSnapshot(): StreamingProfilerSnapshot {
    return {
      enabled: this._enabled,
      sessionLabel: this.sessionLabel,
      sessionStartMs: roundMs(this.sessionStartMs),
      sessionEndMs: roundMs(
        this._enabled ? performance.now() : this.sessionEndMs
      ),
      totalFramesRecorded: this.framesRing.totalInserted,
      droppedFramesCount: this.framesRing.droppedCount,
      totalEventsRecorded: this.eventsRing.totalInserted,
      droppedEventsCount: this.eventsRing.droppedCount,
      browserObservers: {
        longTaskSupported: this.longTaskSupported,
        loafSupported: this.loafSupported,
        longTaskCount: this.longTasksRing.length,
        loafCount: this.loafsRing.length,
      },
      frames: this.framesRing.toArray(),
      events: this.eventsRing.toArray(),
      longTasks: this.longTasksRing.toArray(),
      loafs: this.loafsRing.toArray(),
    };
  }

  private startBrowserObservers(): void {
    if (typeof PerformanceObserver === 'undefined') {
      this.longTaskSupported = false;
      this.loafSupported = false;
      return;
    }
    const supported = Array.isArray(PerformanceObserver.supportedEntryTypes)
      ? PerformanceObserver.supportedEntryTypes
      : [];

    if (!this.longTaskObserver && supported.includes('longtask')) {
      try {
        this.longTaskObserver = new PerformanceObserver((list) => {
          if (!this._enabled) return;
          for (const entry of list.getEntries()) {
            const lt = entry as PerformanceEntry & {
              attribution?: Array<{
                name?: string;
                containerType?: string;
                containerName?: string;
              }>;
            };
            const attr = Array.isArray(lt.attribution) && lt.attribution.length > 0
              ? lt.attribution[0]
              : undefined;
            this.longTasksRing.push({
              seq: ++this.longTaskSeq,
              startTimeMs: roundMs(entry.startTime),
              durationMs: roundMs(entry.duration),
              name: entry.name || 'longtask',
              attributionName: attr?.name ?? null,
              containerType: attr?.containerType ?? null,
              containerName: attr?.containerName ?? null,
            });
          }
        });
        this.longTaskObserver.observe({ entryTypes: ['longtask'] });
        this.longTaskSupported = true;
      } catch {
        this.longTaskObserver = null;
        this.longTaskSupported = false;
      }
    }

    if (!this.loafObserver && supported.includes('long-animation-frame')) {
      try {
        this.loafObserver = new PerformanceObserver((list) => {
          if (!this._enabled) return;
          for (const entry of list.getEntries()) {
            const loaf = entry as PerformanceEntry & {
              blockingDuration?: number;
              renderStart?: number;
              styleAndLayoutStart?: number;
              firstUIEventTimestamp?: number;
              scripts?: Array<{
                invoker?: string;
                invokerType?: string;
                sourceURL?: string;
                sourceFunctionName?: string;
                duration?: number;
                forcedStyleAndLayoutDuration?: number;
              }>;
            };
            const scripts = Array.isArray(loaf.scripts) ? loaf.scripts : [];
            const topScripts = [...scripts]
              .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
              .slice(0, 3)
              .map((s) => ({
                invoker: s.invoker ?? '',
                invokerType: s.invokerType ?? '',
                sourceURL: s.sourceURL ?? '',
                sourceFunctionName: s.sourceFunctionName ?? '',
                durationMs: roundMs(s.duration ?? 0),
                forcedStyleAndLayoutDurationMs: roundMs(
                  s.forcedStyleAndLayoutDuration ?? 0
                ),
              }));
            this.loafsRing.push({
              seq: ++this.loafSeq,
              startTimeMs: roundMs(entry.startTime),
              durationMs: roundMs(entry.duration),
              blockingDurationMs: roundMs(loaf.blockingDuration ?? 0),
              renderStartMs: roundMs(loaf.renderStart ?? 0),
              styleAndLayoutStartMs: roundMs(loaf.styleAndLayoutStart ?? 0),
              firstUIEventTimestampMs: roundMs(loaf.firstUIEventTimestamp ?? 0),
              topScripts,
            });
          }
        });
        this.loafObserver.observe({ entryTypes: ['long-animation-frame'] });
        this.loafSupported = true;
      } catch {
        this.loafObserver = null;
        this.loafSupported = false;
      }
    }
  }

  private stopBrowserObservers(): void {
    if (this.longTaskObserver) {
      try {
        this.longTaskObserver.disconnect();
      } catch {
        // ignore
      }
      this.longTaskObserver = null;
    }
    if (this.loafObserver) {
      try {
        this.loafObserver.disconnect();
      } catch {
        // ignore
      }
      this.loafObserver = null;
    }
  }

  private installRaycasterHook(): void {
    if (this.origRaycasterIntersectObjects) return;
    const proto = THREE.Raycaster.prototype;
    const origObjects = proto.intersectObjects;
    const origObject = proto.intersectObject;
    this.origRaycasterIntersectObjects = origObjects;
    this.origRaycasterIntersectObject = origObject;
    const profiler = this;

    proto.intersectObjects = function patchedIntersectObjects(
      this: THREE.Raycaster,
      objects: THREE.Object3D[],
      recursive?: boolean,
      intersects?: THREE.Intersection[]
    ) {
      if (!profiler._enabled) {
        return origObjects.call(this, objects, recursive, intersects);
      }
      const isTop = profiler.raycasterCallDepth === 0;
      profiler.raycasterCallDepth += 1;
      const t0 = isTop ? performance.now() : 0;
      try {
        return origObjects.call(this, objects, recursive, intersects);
      } finally {
        profiler.raycasterCallDepth -= 1;
        if (isTop) {
          profiler.recordPickingDuration(performance.now() - t0);
        }
      }
    };

    proto.intersectObject = function patchedIntersectObject(
      this: THREE.Raycaster,
      object: THREE.Object3D,
      recursive?: boolean,
      intersects?: THREE.Intersection[]
    ) {
      if (!profiler._enabled) {
        return origObject.call(this, object, recursive, intersects);
      }
      const isTop = profiler.raycasterCallDepth === 0;
      profiler.raycasterCallDepth += 1;
      const t0 = isTop ? performance.now() : 0;
      try {
        return origObject.call(this, object, recursive, intersects);
      } finally {
        profiler.raycasterCallDepth -= 1;
        if (isTop) {
          profiler.recordPickingDuration(performance.now() - t0);
        }
      }
    };
  }

  private uninstallRaycasterHook(): void {
    if (this.origRaycasterIntersectObjects) {
      THREE.Raycaster.prototype.intersectObjects =
        this.origRaycasterIntersectObjects;
      this.origRaycasterIntersectObjects = null;
    }
    if (this.origRaycasterIntersectObject) {
      THREE.Raycaster.prototype.intersectObject =
        this.origRaycasterIntersectObject;
      this.origRaycasterIntersectObject = null;
    }
    this.raycasterCallDepth = 0;
  }
}

let globalStreamingProfiler: StreamingProfiler | null = null;

export function getGlobalStreamingProfiler(): StreamingProfiler {
  if (!globalStreamingProfiler) {
    globalStreamingProfiler = new StreamingProfiler();
  }
  return globalStreamingProfiler;
}
