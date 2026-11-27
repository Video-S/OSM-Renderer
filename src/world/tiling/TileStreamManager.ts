import * as THREE from 'three';
import type { MapStyleTheme } from '../../types/MapFeature';
import { MAP_THEMES } from '../../styles/mapThemes';
import {
  SceneResourceManager,
  type BuiltSceneGeometry,
} from '../GeometryBuilder';
import {
  equalFoliageOptimizationConfig,
  FoliagePrototypeRegistry,
  normalizeFoliageOptimizationConfig,
  resolveFoliageRuntimeState,
  type FoliageLodLevel,
  type FoliageOptimizationConfig,
  type FoliageRuntimeState,
} from '../FoliageLodSystem';
import { DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS } from '../infrastructure/rendering/InfrastructureRenderAdapter';
import {
  createM1aTileBoundaryOverlay,
  type M1aTileBoundaryOverlayResult,
} from './M1aVisualHarness';
import { ThemeMaterialRegistry } from './ThemeMaterialRegistry';
import {
  createTileDecodeClient,
  type TileDecodeClient,
} from './TileDecodeClient';
import {
  reconstructTileSceneFromDecoded,
  type ReconstructedTileSceneResult,
} from './TileSceneReconstructor';
import {
  type AnyDecodedTilePayload,
} from './CompactTileTransport';
import {
  type TileLayerKind,
  type TileManifestEntry,
  type TilePackMetadata,
} from './TilePackContract';
import {
  identifyTilePreparationVariant,
  resolveTilePreparationOptions,
  type TilePreparationOptions,
  type TilePreparationVariantId,
} from './TilePreparationConfig';
import {
  createHengeloStudyGrid,
  formatTileId,
  type StudyGridSpec,
} from './TileGrid';
import {
  deriveActiveMosaicNameFromPackPath,
  type TileManifestLoadStatus,
} from './ActiveMosaicIdentity';
import { utm32NToGeo } from './RegionalProjection';
import {
  getGlobalStreamingProfiler,
  type StreamingProfiler,
  type StreamingQueueDepths,
} from './StreamingProfiler';
import {
  formatHierarchicalTileKey,
  type HierarchicalMosaicLevelManifest,
  type HierarchicalMosaicManifestExtension,
} from './HierarchicalMosaicContract';
import {
  computeEffectiveOrthographicScale,
  DEFAULT_HIERARCHICAL_RESOLUTION_POLICY,
  evaluateAdaptivePrewarmHorizon,
  normalizeHierarchicalResolutionPolicy,
  predictViewportBoundsAtHorizon,
  resolveApproachingResolutionForPrewarm,
  resolveDesiredHierarchicalResolution,
  resolvePhysicalMarginsForResolution,
  type AdaptivePrewarmHorizonEvaluation,
  type HierarchicalResolutionMode,
  type HierarchicalResolutionPolicyConfig,
  type HierarchicalScaleEvaluation,
} from './HierarchicalResolutionPolicy';
import {
  createEmptyResolutionAccounting,
  normalizeHierarchicalResourceBudget,
  type HierarchicalResourceAccountingSnapshot,
  type HierarchicalResourceBudgetConfig,
  type ResolutionResourceAccounting,
} from './HierarchicalResourceBudget';
import {
  DEFAULT_MANAGER_STREAMING_FRAME_BUDGET_CONFIG,
  identifyStreamingF1Variant,
  resolveStreamingFrameBudgetConfig,
  type StreamingF1VariantId,
  type StreamingFrameBudgetConfig,
} from './StreamingSchedulerConfig';
import {
  StreamingWorkloadScheduler,
  type ScheduledWorkUnit,
  type StreamingSchedulerCumulativeStats,
} from './StreamingWorkloadScheduler';
import {
  IncrementalGpuPreparer,
  type GpuPrepUploadAdapter,
  type IncrementalGpuPreparerStats,
} from './IncrementalGpuPreparer';
import {
  DeferredDisposalQueue,
  type DeferredDisposalAccountingSnapshot,
} from './DeferredDisposalQueue';

export {
  deriveActiveMosaicNameFromPackPath,
  createLoadingMosaicIdentity,
  createErrorMosaicIdentity,
  createMosaicIdentityFromDiagnostics,
  INACTIVE_MOSAIC_IDENTITY,
  type ActiveMosaicIdentity,
  type ActiveMosaicStatus,
  type TileManifestLoadStatus,
} from './ActiveMosaicIdentity';

export type TileStreamLifecycleState =
  | 'unloaded'
  | 'queued'
  | 'fetching'
  | 'retrieved_queued'
  | 'decoding'
  | 'ready_to_commit'
  | 'prepared_inactive'
  | 'loaded'
  | 'cached_inactive'
  | 'error';

export type HierarchicalTransitionState =
  | 'idle'
  | 'debouncing'
  | 'preparing'
  | 'ready_to_activate'
  | 'deferred_budget';

export interface TileViewportGroundBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  focusX: number;
  focusZ: number;
  cameraZoom?: number;
  /** Optional orthographic CSS viewport width in pixels for scale compensation. */
  viewportWidthPx?: number;
  /** Optional orthographic CSS viewport height in pixels. */
  viewportHeightPx?: number;
}

export interface TileMemoryFootprint {
  cpuGeometryBytes: number;
  bvhBytes: number;
  /** Portion of `bvhBytes` originating from worker-prepared instanced spatial indices (avoids double-counting). */
  preparedInstancedBvhBytes?: number;
  meshCount: number;
  instancedBatchCount: number;
  bvhCount: number;
  triangleCount: number;
  vertexCount: number;
}

export interface TileTimingSummaryStats {
  count: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
}

/**
 * TKT-041-F2 Work Package A/B/C/D/E: Stage-by-stage throughput, queue capacity,
 * byte-reservation, worker utilization, and prediction effectiveness snapshot.
 */
export interface StreamingThroughputPipelineSnapshot {
  independentPipelineStagesEnabled: boolean;
  useCompressedHttpTransfer: boolean;
  maxConcurrentHttpRetrievals: number;
  workerConcurrency: number;
  reservedDestinationFetchSlots: number;
  reservedDestinationWorkerSlots: number;
  fetchQueuedCount: number;
  httpRetrievingCount: number;
  retrievedQueuedCount: number;
  workerDecodingCount: number;
  preparedQueuedCount: number;
  inFlightHttpReservationBytes: number;
  retrievedPayloadQueueBytes: number;
  inFlightWorkerPreparationBytes: number;
  preparedPayloadQueueBytes: number;
  reconstructedAwaitingGpuBytes: number;
  busyWorkerCount: number;
  idleWorkerCount: number;
  activeDestinationFetchCount: number;
  activeDestinationWorkerCount: number;
  totalNetworkTransferBytes: number;
  totalRawPayloadBytesDecoded: number;
  sustainedHttpTransferMibPerSec: number;
  sustainedDecodeRawMibPerSec: number;
  sustainedTilesDecodedPerSec: number;
  avgRetrievedQueueWaitMs: number;
  avgServerSqliteLookupMs: number;
  avgServerInflateMs: number;
  avgServerTotalMs: number;
  dynamicReprioritizationsTotal: number;
  tailTileBoostsAppliedTotal: number;
  ageEscalationsAppliedTotal: number;
  oversizedPayloadAdmissionsTotal: number;
  runningWorkerJobsRetainedAfterDemotionTotal: number;
  discardedPreparedTilesTotal: number;
  wastedNetworkBytes: number;
  wastedWorkerTimeMs: number;
  wastedPrewarmBytes: number;
  prewarmedTilesActivatedTotal: number;
  lastPreparationLeadTimeMs: number;
  historicalPrepLatencyByResMs: Record<number, number>;
}

export interface TileStreamDiagnosticsSnapshot {
  manifestStatus: TileManifestLoadStatus;
  manifestError: string | null;
  activeMosaicName: string | null;
  packPath: string | null;
  apiBaseUrl: string;
  snapshotId: string;
  bakeSchemaVersion: string;
  tileSizeMeters: number;
  preloadMarginTiles: number;
  retainMarginTiles: number;
  totalGridCols: number;
  totalGridRows: number;
  totalGridTiles: number;
  visibleTiles: number;
  fetchTargetTiles: number;
  keepTargetTiles: number;
  loadedTiles: number;
  peakLoadedTiles: number;
  emptyLoadedTiles: number;
  loadingTiles: number;
  peakLoadingTiles: number;
  queuedTiles: number;
  fetchingTiles: number;
  retrievedQueuedTiles: number;
  decodingTiles: number;
  readyToCommitTiles: number;
  failedTiles: number;
  lastTileError: string | null;
  evictedTilesTotal: number;
  cancelledRequestsTotal: number;
  duplicateRequestsSkippedTotal: number;
  completedLoadsTotal: number;
  loadedMeshCount: number;
  visibleMeshCount: number;
  loadedTriangles: number;
  loadedVertices: number;
  loadedDrawCallsEstimate: number;
  activeTileGeometries: number;
  activeTileBvhs: number;
  sharedMaterialCount: number;
  tileCpuGeometryBytes: number;
  tileBvhBytes: number;
  compositeSceneRevision: number;
  lastManifestLoadMs: number;
  avgFetchMs: number;
  avgDecodeMs: number;
  avgReconstructMs: number;
  lastCommitMs: number;
  maxCommitMs: number;
  fetchMsStats: TileTimingSummaryStats | null;
  decodeMsStats: TileTimingSummaryStats | null;
  reconstructMsStats: TileTimingSummaryStats | null;
  commitMsStats: TileTimingSummaryStats | null;
  viewportBounds: TileViewportGroundBounds | null;
  loadedTileKeys: string[];
  visibleTileKeys: string[];
  loadingTileKeys: string[];
  /** TKT-031 opt-in experiment: viewport selection work since last counter reset. */
  viewportSelectionPasses: number;
  viewportSelectionSkips: number;
  /** TKT-031 opt-in experiment: unchanged zoom propagation skips. */
  zoomPropagationSkips: number;
  /** TKT-036 runtime foliage LOD & culling diagnostics. */
  activeFoliageLod: FoliageLodLevel;
  foliageTrunksVisible: boolean;
  foliageFrustumCullingEnabled: boolean;
  sharedFoliagePrototypeCount: number;
  /** TKT-038 instanced spatial picking index diagnostics across resident loaded tiles. */
  tileInstancedIndexBytes: number;
  tileInstancedIndexCount: number;
  tileInstancedIndexInstances: number;
  tileInstancedIndexBuildMsTotal: number;
  /** TKT-040 non-blocking tile preparation & worker transfer diagnostics. */
  tilePreparationVariant: TilePreparationVariantId | 'custom';
  workerBvhAdoptedTotal: number;
  syncBvhFallbackTotal: number;
  pendingReadyTileBytes: number;
  /** TKT-041-F1 frame-budgeted streaming, GPU prep, deferred disposal, and debounce telemetry. */
  frameBudget: StreamingFrameBudgetDiagnosticsSnapshot;
  /** TKT-041-F2 stage-by-stage throughput, decoupled queues, byte backpressure, and adaptive prewarm snapshot. */
  throughputPipeline: StreamingThroughputPipelineSnapshot;
  /** TKT-041 hierarchical multi-resolution streaming diagnostics (null for single-resolution packs). */
  hierarchical: HierarchicalStreamingDiagnosticsSnapshot | null;
}

export interface StreamingFrameBudgetDiagnosticsSnapshot {
  config: StreamingFrameBudgetConfig;
  variant: StreamingF1VariantId | 'custom';
  scheduler: StreamingSchedulerCumulativeStats;
  gpuPreparer: IncrementalGpuPreparerStats;
  deferredDisposal: DeferredDisposalAccountingSnapshot;
  pendingDebounceTargetResolution: number | null;
  pendingDebounceElapsedMs: number;
  transitionsDebouncedAvoided: number;
  destinationPrepReused: number;
  hasValidViewportCoverage: boolean;
  boundaryOverlayDirty: boolean;
  boundaryOverlayRebuildMsTotal: number;
}

export type TransitionBlockerCategory =
  | 'none'
  | 'debounce_waiting'
  | 'active_coverage_gap'
  | 'fetch_queue_contention'
  | 'network_fetching'
  | 'retrieved_queue_waiting'
  | 'worker_queue_waiting'
  | 'worker_decoding'
  | 'main_thread_reconstruct_waiting'
  | 'gpu_prep_waiting'
  | 'memory_backpressure'
  | 'budget_deferred'
  | 'error_or_missing';

export interface TransitionOutstandingTileSnapshot {
  tileKey: string;
  resolutionMeters: number;
  state: TileStreamLifecycleState;
  currentStage:
    | 'queued'
    | 'fetching'
    | 'retrieved_queued'
    | 'worker_queue_or_decoding'
    | 'reconstruct_waiting'
    | 'gpu_prep_waiting'
    | 'error'
    | 'unloaded';
  ageSinceTransitionStartMs: number;
  currentStageElapsedMs: number;
  fetchQueueWaitMs: number;
  payloadRetrievalMs: number;
  retrievedQueueWaitMs?: number;
  workerQueueWaitMs: number;
  workerDecodeAndBvhMs: number;
  mainThreadReconstructWaitMs: number;
  reconstructMs: number;
  gpuPrepWaitMs: number;
  gpuPrepSubmitMs: number;
  gpuPrepRemainingUnits: number;
  payloadCompressedBytes: number | null;
  payloadRawBytes: number | null;
  lastError: string | null;
}

export interface TransitionBlockerSnapshot {
  active: boolean;
  blockerCategory: TransitionBlockerCategory;
  blockerReason: string;
  fromResolutionMeters: number | null;
  toResolutionMeters: number | null;
  transitionGeneration: number;
  elapsedMs: number;
  requiredVisibleCount: number;
  readyCount: number;
  destinationCoverageReadinessRatio: number;
  newlyRequiredDestinationTilesCount: number;
  queuedCount: number;
  fetchingCount: number;
  retrievedQueuedCount: number;
  decodingCount: number;
  reconstructWaitingCount: number;
  gpuPrepWaitingCount: number;
  failedCount: number;
  slowestOutstandingTile: TransitionOutstandingTileSnapshot | null;
  oldestOutstandingTile: TransitionOutstandingTileSnapshot | null;
  contention: {
    activeVisibleInFlightCount: number;
    activePreloadInFlightCount: number;
    pendingDestinationVisibleInFlightCount: number;
    pendingDestinationSpeculativeInFlightCount: number;
    fetchSlotsUsed: number;
    fetchSlotsMax: number;
    retrievedQueueCount: number;
    retrievedQueueBytes: number;
    workerPendingDecodes: number;
    workerPoolSize: number;
    workerBackpressureActive: boolean;
    speculativeBackpressureActive: boolean;
    memoryHeadroomBytes: number;
    pendingDecodedBytes: number;
    pendingDecodedCapBytes: number;
    cancellationsDuringTransition: number;
  };
}

export interface TransitionCriticalPathRecord {
  transitionGeneration: number;
  outcome: 'completed' | 'cancelled' | 'deferred_budget';
  fromResolutionMeters: number;
  toResolutionMeters: number;
  startedAtMs: number;
  finishedAtMs: number;
  totalDurationMs: number;
  debounceWaitMs: number;
  /** Desired-resolution-change to activation latency (`debounceWaitMs + totalDurationMs`). */
  desiredToActivationMs: number;
  /** Prewarm lead time before transition start (ms) if tiles were pre-warmed. */
  prewarmLeadTimeMs: number;
  activationSwapMs: number;
  requiredTileCount: number;
  reusedFromCacheCount: number;
  reusedFromPrewarmCount: number;
  newlyRequiredTilesDuringTransitionCount: number;
  cancellationsDuringTransition: number;
  dominantBlockerCategory: TransitionBlockerCategory;
  criticalPathTileKey: string | null;
  stagesMs: {
    fetchQueueWaitMs: number;
    payloadRetrievalMs: number;
    retrievedQueueWaitMs: number;
    workerQueueWaitMs: number;
    workerInflateMs: number;
    workerDecodeOnlyMs: number;
    workerInflateAndDecodeMs: number;
    workerBvhBuildMs: number;
    workerDecodeAndBvhMs: number;
    mainThreadReconstructWaitMs: number;
    reconstructMs: number;
    gpuPrepWaitMs: number;
    gpuPrepSubmitMs: number;
    gpuPrepTotalMs: number;
    remainingCoverageWaitMs: number;
    tailTileEnteredLateMs: number;
    activationSwapMs: number;
  };
  cancelOrDeferReason: string | null;
}

export interface HierarchicalStreamingDiagnosticsSnapshot {
  enabled: boolean;
  hierarchyName: string;
  availableResolutionsMeters: number[];
  resolutionMode: HierarchicalResolutionMode;
  desiredResolutionMeters: number;
  activeResolutionMeters: number;
  pendingResolutionMeters: number | null;
  prewarmTargetResolutionMeters: number | null;
  transitionState: HierarchicalTransitionState;
  transitionGeneration: number;
  transitionElapsedMs: number;
  budgetDeferralReason: string | null;
  requiredDestinationTiles: number;
  readyDestinationTiles: number;
  gpuPreparedDestinationTiles: number;
  destinationCoverageReadinessRatio: number;
  activeVisibleTiles: number;
  activeLoadedTiles: number;
  pendingPreparedTiles: number;
  rawCameraZoom: number;
  effectiveScalePxPerMeter: number;
  viewportScaleFactor: number;
  viewportWidthPx: number | null;
  viewportHeightPx: number | null;
  selectionReason: string;
  policy: HierarchicalResolutionPolicyConfig;
  preloadMarginMeters: number;
  retainMarginMeters: number;
  resources: HierarchicalResourceAccountingSnapshot;
  pendingQueues: {
    queued: number;
    fetching: number;
    retrievedQueued: number;
    decoding: number;
    readyToCommit: number;
  };
  counters: {
    transitionsStarted: number;
    transitionsCompleted: number;
    transitionsCancelled: number;
    transitionsDeferredBudget: number;
    transitionsDebouncedAvoided: number;
    destinationPrepReused: number;
    prewarmTilesPrepared: number;
    prewarmReusedOnTransition: number;
    cacheHits: number;
    cacheEvictions: number;
  };
  timings: {
    lastTransitionTotalMs: number;
    lastActivationSwapMs: number;
    maxActivationSwapMs: number;
    activationSwapMsStats: TileTimingSummaryStats | null;
    transitionDurationMsStats: TileTimingSummaryStats | null;
  };
  currentTransitionBlocker: TransitionBlockerSnapshot;
  lastCompletedTransition: TransitionCriticalPathRecord | null;
  recentTransitions: TransitionCriticalPathRecord[];
  frameBudget: StreamingFrameBudgetDiagnosticsSnapshot;
  throughputPipeline: StreamingThroughputPipelineSnapshot;
}

export interface TilePackManifestPayload {
  available?: boolean;
  packPath?: string;
  dbSizeBytes?: number;
  metadata: TilePackMetadata;
  tiles: TileManifestEntry[];
  /** Optional TKT-041 multi-resolution hierarchy descriptor and canonically rebased levels. */
  hierarchy?: HierarchicalMosaicManifestExtension;
}

export interface TileManifestCoverageSummary {
  totalTiles: number;
  nonEmptyTiles: number;
  emptyTiles: number;
  gridCols: number;
  gridRows: number;
  tileSizeMeters: number;
  studyOriginEasting: number;
  studyOriginNorthing: number;
  boundsUtm: {
    minEasting: number;
    maxEasting: number;
    minNorthing: number;
    maxNorthing: number;
  } | null;
  boundsGeo: {
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
  } | null;
  minTx: number | null;
  maxTx: number | null;
  minTy: number | null;
  maxTy: number | null;
  shardCountEstimate: number | null;
  compression: string;
  projection: string;
  createdAt: string;
}

export interface TileStreamManagerOptions {
  /** Base URL for tile API (default: `/api/tiles`). */
  apiBaseUrl?: string;
  /** Surrounding margin in tiles to preload around the visible viewport (default: 1 = 512 m). */
  preloadMarginTiles?: number;
  /** Surrounding margin in tiles to retain before unloading (default: 2 = 1,024 m). */
  retainMarginTiles?: number;
  /** Maximum concurrent tile HTTP requests + worker decodes (default: 6). */
  maxConcurrentFetches?: number;
  /** Maximum decoded tiles reconstructed and mounted per tick (default: 4). */
  maxCommitsPerFrame?: number;
  /** Initial map theme (default: `MAP_THEMES.tactical`). */
  initialTheme?: MapStyleTheme;
  /** Initial camera zoom in CSS px/m (default: 1.0). */
  initialCameraZoom?: number;
  /** Optional pre-configured shared `ThemeMaterialRegistry`. */
  materialRegistry?: ThemeMaterialRegistry;
  /** Optional pre-configured shared `FoliagePrototypeRegistry`. */
  foliagePrototypeRegistry?: FoliagePrototypeRegistry;
  /** Optional initial runtime foliage LOD & culling configuration. */
  foliageOptimizationConfig?: Partial<FoliageOptimizationConfig>;
  /** Optional pre-configured `TileDecodeClient`. */
  decodeClient?: TileDecodeClient;
  /** Optional custom `fetch` implementation for tests. */
  fetchFn?: typeof fetch;
  /** TKT-031: A/B only. Avoid identical viewport-selection work; never skip tick(). */
  experimentSkipUnchangedViewport?: boolean;
  /** TKT-031: A/B only. Avoid propagating identical zoom values to loaded tiles. */
  experimentSkipUnchangedZoom?: boolean;
  /** Optional callback fired whenever diagnostics or loaded tiles change. */
  onDiagnosticsChange?: (diagnostics: TileStreamDiagnosticsSnapshot) => void;
  /** Optional opt-in frame/streaming profiler (defaults to global singleton; zero overhead when disabled). */
  profiler?: StreamingProfiler | null;
  /** TKT-040: Tile preparation variant or explicit optimization flags (default: 'combined'). */
  tilePreparationOptions?: TilePreparationVariantId | Partial<TilePreparationOptions>;
  /** TKT-041: Hierarchical resolution selection, hysteresis, and physical margin policy. */
  hierarchicalPolicy?: Partial<HierarchicalResolutionPolicyConfig>;
  /** TKT-041: Hierarchical memory budget, inactive LRU cache, and time-aware commit limits. */
  hierarchicalBudget?: Partial<HierarchicalResourceBudgetConfig>;
  /** TKT-041-F1 / TKT-041-F2: Frame-budgeted streaming scheduler, decoupled pipeline, incremental GPU prep, deferred disposal, and debounce config. */
  streamingFrameBudget?: StreamingF1VariantId | Partial<StreamingFrameBudgetConfig>;
  /** Optional custom GPU upload adapter (for deterministic headless unit tests). */
  gpuUploadAdapter?: GpuPrepUploadAdapter | null;
  /** Optional monotonic clock override (milliseconds) for deterministic debounce/scheduler tests. */
  nowFn?: () => number;
}

interface TilePipelineTimings {
  queuedAtMs: number | null;
  fetchStartAtMs: number | null;
  fetchCompleteAtMs: number | null;
  retrievedQueuedAtMs: number | null;
  decodeStartAtMs: number | null;
  decodeCompleteAtMs: number | null;
  reconstructStartAtMs: number | null;
  reconstructCompleteAtMs: number | null;
  gpuPrepFirstSliceAtMs: number | null;
  gpuPrepCompleteAtMs: number | null;
  readyAtMs: number | null;
  fetchQueueWaitMs: number;
  payloadRetrievalMs: number;
  retrievedQueueWaitMs: number;
  serverSqliteLookupMs: number;
  serverInflateMs: number;
  serverTotalMs: number;
  workerClientQueueWaitMs: number;
  workerThreadQueueWaitMs: number;
  workerInflateMs: number;
  workerDecodeOnlyMs: number;
  workerInflateAndDecodeMs: number;
  workerBvhBuildMs: number;
  workerPayloadPrepMs: number;
  workerDeliveryLatencyMs: number;
  mainThreadReconstructWaitMs: number;
  reconstructMs: number;
  gpuPrepWaitMs: number;
  gpuPrepSubmitMs: number;
  gpuPrepSliceCount: number;
  reusedFromCache: boolean;
  preparedByPrewarm: boolean;
  enteredDuringActiveTransitionAtMs: number | null;
}

function createEmptyTilePipelineTimings(): TilePipelineTimings {
  return {
    queuedAtMs: null,
    fetchStartAtMs: null,
    fetchCompleteAtMs: null,
    retrievedQueuedAtMs: null,
    decodeStartAtMs: null,
    decodeCompleteAtMs: null,
    reconstructStartAtMs: null,
    reconstructCompleteAtMs: null,
    gpuPrepFirstSliceAtMs: null,
    gpuPrepCompleteAtMs: null,
    readyAtMs: null,
    fetchQueueWaitMs: 0,
    payloadRetrievalMs: 0,
    retrievedQueueWaitMs: 0,
    serverSqliteLookupMs: 0,
    serverInflateMs: 0,
    serverTotalMs: 0,
    workerClientQueueWaitMs: 0,
    workerThreadQueueWaitMs: 0,
    workerInflateMs: 0,
    workerDecodeOnlyMs: 0,
    workerInflateAndDecodeMs: 0,
    workerBvhBuildMs: 0,
    workerPayloadPrepMs: 0,
    workerDeliveryLatencyMs: 0,
    mainThreadReconstructWaitMs: 0,
    reconstructMs: 0,
    gpuPrepWaitMs: 0,
    gpuPrepSubmitMs: 0,
    gpuPrepSliceCount: 0,
    reusedFromCache: false,
    preparedByPrewarm: false,
    enteredDuringActiveTransitionAtMs: null,
  };
}

interface ManagedTileRecord {
  tileKey: string;
  /** Resolution level in meters (`tileSizeMeters`) that owns this record. */
  resolutionMeters: number;
  manifest: TileManifestEntry;
  /** Ownership study-world AABB [minX, maxX, minZ, maxZ] */
  worldBounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    centerX: number;
    centerZ: number;
  };
  /** Overhang study-world AABB [minX, maxX, minZ, maxZ] */
  overhangWorldBounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
  state: TileStreamLifecycleState;
  isVisibleInViewport: boolean;
  isInFetchSet: boolean;
  isInKeepSet: boolean;
  priorityScore: number;
  abortController: AbortController | null;
  requestGeneration: number;
  /** TKT-041-F2 Work Package B: Retrieved binary payload awaiting worker decode dispatch. */
  retrievedBuffer: ArrayBuffer | null;
  /** TKT-041-F2 Work Package B: Active byte reservation while HTTP fetch is in flight. */
  reservedHttpBytes: number;
  /** TKT-041-F2 Work Package B: Active estimated byte reservation while worker preparation is in flight. */
  reservedWorkerBytes: number;
  decodedPayload: AnyDecodedTilePayload | null;
  decodedFootprint: TileMemoryFootprint | null;
  reconstructed: ReconstructedTileSceneResult | null;
  lastError: string | null;
  lastCompressedBytes?: number | null;
  /** Monotonic timestamp for LRU eviction in `cached_inactive`. */
  lastUsedAtMs: number;
  /** TKT-041-F1 / TKT-041-F2 per-tile pipeline stage timings. */
  pipeline: TilePipelineTimings;
}

interface ResolutionLevelState {
  tileSizeMeters: number;
  metadata: TilePackMetadata;
  levelManifest: HierarchicalMosaicLevelManifest | null;
  tilesByKey: Map<string, ManagedTileRecord>;
}

const STREAMED_LAYER_KINDS: ReadonlyArray<Exclude<TileLayerKind, 'ground'>> = [
  'buildings',
  'roads',
  'railways',
  'water',
  'parks',
  'landuse',
  'barriers',
  'foliage',
];

const MAX_TIMING_SAMPLES = 256;

function pushBoundedSample(samples: number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  samples.push(value);
  if (samples.length > MAX_TIMING_SAMPLES) {
    samples.shift();
  }
}

function summarizeTimingSamples(
  samples: readonly number[]
): TileTimingSummaryStats | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < sorted.length; i++) {
    sum += sorted[i];
  }
  const p95Idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(0.95 * (sorted.length - 1)))
  );
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) * 0.5;
  return {
    count: sorted.length,
    minMs: Number(sorted[0].toFixed(3)),
    medianMs: Number(median.toFixed(3)),
    p95Ms: Number(sorted[p95Idx].toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
    avgMs: Number((sum / sorted.length).toFixed(3)),
  };
}

export function computeDecodedTileMemoryFootprint(
  decoded: AnyDecodedTilePayload
): TileMemoryFootprint {
  if (decoded.precomputedFootprint) {
    let preparedInstancedBvhBytes = 0;
    for (const b of decoded.instancedBatches) {
      if (b.preparedSpatialIndex) {
        preparedInstancedBvhBytes += b.preparedSpatialIndex.estimatedMemoryBytes;
      }
    }
    return {
      ...decoded.precomputedFootprint,
      preparedInstancedBvhBytes,
    };
  }
  let cpuGeometryBytes = 0;
  let bvhBytes = 0;
  let preparedInstancedBvhBytes = 0;
  let meshCount = 0;
  let bvhCount = 0;

  for (const m of decoded.meshes) {
    if (m.layer !== 'ground') {
      meshCount += 1;
    }
    cpuGeometryBytes += m.positions.byteLength;
    cpuGeometryBytes += m.normals?.byteLength ?? 0;
    cpuGeometryBytes += m.uvs?.byteLength ?? 0;
    cpuGeometryBytes += m.switchAttrs?.byteLength ?? 0;
    cpuGeometryBytes += m.colors?.byteLength ?? 0;
    cpuGeometryBytes += m.indices?.byteLength ?? 0;

    if (m.bvh) {
      bvhCount += 1;
      for (const root of m.bvh.roots) {
        bvhBytes += root.byteLength;
      }
      bvhBytes += m.bvh.indirectBuffer?.byteLength ?? 0;
    }
  }

  for (const b of decoded.instancedBatches) {
    meshCount += 1;
    cpuGeometryBytes += b.matrices.byteLength;
    cpuGeometryBytes += b.instanceColors?.byteLength ?? 0;
    if (b.preparedSpatialIndex) {
      bvhBytes += b.preparedSpatialIndex.estimatedMemoryBytes;
      preparedInstancedBvhBytes += b.preparedSpatialIndex.estimatedMemoryBytes;
    }
  }

  return {
    cpuGeometryBytes,
    bvhBytes,
    preparedInstancedBvhBytes,
    meshCount,
    instancedBatchCount: decoded.instancedBatches.length,
    bvhCount,
    triangleCount: decoded.totalTriangles,
    vertexCount: decoded.totalVertices,
  };
}

/**
 * Projects the current OrthographicCamera frustum onto the horizontal study-world ground
 * envelope (`y ∈ [-4, 65]`) so tile selection accounts for both ground surfaces and tall
 * elevated structures near screen edges.
 */
export function computeViewportGroundBoundsForCamera(
  camera: THREE.OrthographicCamera,
  target?: { x: number; y?: number; z: number }
): TileViewportGroundBounds {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const focusX = target?.x ?? camera.position.x;
  const focusZ = target?.z ?? camera.position.z;
  const zoom = Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;

  const ndcCorners: ReadonlyArray<[number, number]> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const sampleHeights = [-4, 0, 65];

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let validIntersections = 0;

  const pNear = new THREE.Vector3();
  const pFar = new THREE.Vector3();
  const dir = new THREE.Vector3();

  for (const [ndcX, ndcY] of ndcCorners) {
    pNear.set(ndcX, ndcY, -1).unproject(camera);
    pFar.set(ndcX, ndcY, 1).unproject(camera);
    dir.subVectors(pFar, pNear);

    if (Math.abs(dir.y) > 1e-5) {
      for (const h of sampleHeights) {
        const t = (h - pNear.y) / dir.y;
        const ix = pNear.x + t * dir.x;
        const iz = pNear.z + t * dir.z;
        if (Number.isFinite(ix) && Number.isFinite(iz)) {
          minX = Math.min(minX, ix);
          maxX = Math.max(maxX, ix);
          minZ = Math.min(minZ, iz);
          maxZ = Math.max(maxZ, iz);
          validIntersections++;
        }
      }
    }
  }

  if (validIntersections === 0 || !Number.isFinite(minX)) {
    const halfWidth = Math.abs(camera.right - camera.left) / (2 * zoom);
    const halfHeight = Math.abs(camera.top - camera.bottom) / (2 * zoom);
    const radius = Math.max(halfWidth, halfHeight, 256);
    minX = focusX - radius;
    maxX = focusX + radius;
    minZ = focusZ - radius;
    maxZ = focusZ + radius;
  }

  const viewportWidthPx = Math.abs(camera.right - camera.left);
  const viewportHeightPx = Math.abs(camera.top - camera.bottom);

  return {
    minX,
    maxX,
    minZ,
    maxZ,
    focusX,
    focusZ,
    cameraZoom: zoom,
    viewportWidthPx:
      Number.isFinite(viewportWidthPx) && viewportWidthPx > 0
        ? viewportWidthPx
        : undefined,
    viewportHeightPx:
      Number.isFinite(viewportHeightPx) && viewportHeightPx > 0
        ? viewportHeightPx
        : undefined,
  };
}

/**
 * Strict equality avoids accepting stale tile membership near a cell boundary.
 * We compare the derived ground-plane footprint, not just camera position/zoom:
 * rotating, resizing or changing target alters one or more of these values.
 */
export function equalTileViewportBounds(
  a: TileViewportGroundBounds | null,
  b: TileViewportGroundBounds
): boolean {
  return a !== null &&
    a.minX === b.minX && a.maxX === b.maxX &&
    a.minZ === b.minZ && a.maxZ === b.maxZ &&
    a.focusX === b.focusX && a.focusZ === b.focusZ &&
    a.cameraZoom === b.cameraZoom &&
    a.viewportWidthPx === b.viewportWidthPx &&
    a.viewportHeightPx === b.viewportHeightPx;
}

function aabbIntersects2D(
  aMinX: number,
  aMaxX: number,
  aMinZ: number,
  aMaxZ: number,
  bMinX: number,
  bMaxX: number,
  bMinZ: number,
  bMaxZ: number
): boolean {
  return aMinX <= bMaxX && aMaxX >= bMinX && aMinZ <= bMaxZ && aMaxZ >= bMinZ;
}

/**
 * Runtime tile streaming controller for M2-A.
 *
 * Determines required 512 m tiles from the camera viewport, preloads a surrounding
 * margin, decodes `OSMTILE1` binary payloads via `TileDecodeClient` (Web Worker),
 * reconstructs tile scenes on a bounded per-frame budget using `TileSceneReconstructor`
 * and a single shared `ThemeMaterialRegistry`, and strictly disposes tile-owned
 * CPU/GPU geometries and BVHs when distant tiles are unloaded.
 */
export class TileStreamManager {
  private readonly apiBaseUrl: string;
  private readonly preloadMarginTiles: number;
  private readonly retainMarginTiles: number;
  private readonly maxConcurrentFetches: number;
  private readonly maxCommitsPerFrame: number;
  private readonly experimentSkipUnchangedViewport: boolean;
  private readonly experimentSkipUnchangedZoom: boolean;
  private readonly materialRegistry: ThemeMaterialRegistry;
  private readonly ownsMaterialRegistry: boolean;
  private readonly foliagePrototypeRegistry: FoliagePrototypeRegistry;
  private readonly ownsFoliagePrototypeRegistry: boolean;
  private readonly decodeClient: TileDecodeClient;
  private readonly ownsDecodeClient: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly onDiagnosticsChange?: (
    diagnostics: TileStreamDiagnosticsSnapshot
  ) => void;
  private profiler: StreamingProfiler | null;

  private readonly regionalResources = new SceneResourceManager();
  private readonly compositeScene: BuiltSceneGeometry;
  // Rebuilt after loading a pack manifest while retaining the mounted THREE.Group identity.
  private boundaryOverlayResult: M1aTileBoundaryOverlayResult;
  private readonly groundMesh: THREE.Mesh;
  /**
   * Global tile map.
   * - Single-resolution packs: keyed by legacy `formatTileId(tx, ty)` (`tx_..._ty_...`).
   * - Hierarchical packs: contains all records across every resolution keyed by
   *   collision-free `formatHierarchicalTileKey(tileSizeMeters, tx, ty, lod)`.
   */
  private readonly tilesByKey = new Map<string, ManagedTileRecord>();
  /** Per-resolution tile maps keyed by `tileSizeMeters` (size 1 for single-resolution packs). */
  private readonly levelsByResolution = new Map<number, ResolutionLevelState>();
  private hierarchy: HierarchicalMosaicManifestExtension | null = null;
  private hierarchicalPolicy: HierarchicalResolutionPolicyConfig;
  private hierarchicalBudget: HierarchicalResourceBudgetConfig;
  private activeResolutionMeters: number | null = null;
  private desiredResolutionMeters: number | null = null;
  private pendingResolutionMeters: number | null = null;
  private transitionState: HierarchicalTransitionState = 'idle';
  private transitionGeneration = 0;
  private transitionStartedAtMs: number | null = null;
  private budgetDeferralReason: string | null = null;
  private lastDeferredViewportSignature: string | null = null;
  private lastDeferredBudgetBytes: number | null = null;
  private currentViewportWidthPx: number | null = null;
  private currentViewportHeightPx: number | null = null;
  private lastScaleEval: HierarchicalScaleEvaluation | null = null;
  private speculativeBackpressureActive = false;
  private workerBackpressureActive = false;

  // TKT-041-F1 subsystems & debounce/overlay state
  private readonly nowFn: () => number;
  private streamingFrameBudget: StreamingFrameBudgetConfig;
  private readonly workloadScheduler: StreamingWorkloadScheduler;
  private readonly gpuPreparer: IncrementalGpuPreparer;
  private readonly deferredDisposalQueue: DeferredDisposalQueue;
  private pendingDebounceTargetResolution: number | null = null;
  private pendingDebounceStartedAtMs: number | null = null;
  private transitionsDebouncedAvoidedTotal = 0;
  private destinationPrepReusedTotal = 0;
  private boundaryOverlayVisible = false;
  private boundaryOverlayDirty = false;
  private boundaryOverlayRebuildMsTotal = 0;
  private lastActivationBoundaryOverlayRebuildMs = 0;

  // Section 12: Transition critical-path instrumentation & predictive pre-warming
  private prewarmTargetResolutionMeters: number | null = null;
  private previousCameraZoomForTrend: number | null = null;
  private zoomTrend: 'zooming_out' | 'zooming_in' | 'steady' = 'steady';
  private currentTransitionDebounceWaitMs = 0;
  private currentTransitionCancellations = 0;
  private prewarmTilesPreparedTotal = 0;
  private prewarmReusedOnTransitionTotal = 0;
  private readonly recentTransitions: TransitionCriticalPathRecord[] = [];
  private lastCompletedTransition: TransitionCriticalPathRecord | null = null;

  // TKT-041-F2: Throughput, decoupled pipeline reservations, adaptive prewarm & fairness state
  private readonly explicitMaxConcurrentFetches: number | null;
  private inFlightHttpReservationBytes = 0;
  private retrievedPayloadQueueBytes = 0;
  private inFlightWorkerPreparationBytes = 0;
  private oversizedPayloadAdmissionsTotal = 0;
  private totalNetworkTransferBytes = 0;
  private totalRawPayloadBytesDecoded = 0;
  private totalTilesDecoded = 0;
  private totalHttpRetrievalDurationMs = 0;
  private totalWorkerActiveDurationMs = 0;
  private totalServerSqliteLookupMs = 0;
  private totalServerInflateMs = 0;
  private totalServerTotalMs = 0;
  private serverHeaderSamples = 0;
  private totalFetchQueueWaitMs = 0;
  private totalRetrievedQueueWaitMs = 0;
  private totalWorkerClientQueueWaitMs = 0;
  private totalWorkerThreadQueueWaitMs = 0;
  private totalWorkerInflateMs = 0;
  private totalWorkerDecodeOnlyMs = 0;
  private totalWorkerBvhBuildMs = 0;
  private totalWorkerPayloadPrepMs = 0;
  private totalWorkerDeliveryLatencyMs = 0;
  private totalReconstructQueueWaitMs = 0;
  private totalGpuPrepQueueWaitMs = 0;
  private totalGpuPrepSubmitMs = 0;
  private gpuPrepCompletedTileSamples = 0;
  private dynamicReprioritizationsTotal = 0;
  private runningWorkerJobsRetainedAfterDemotionTotal = 0;
  private wastedNetworkBytes = 0;
  private wastedWorkerTimeMs = 0;
  private discardedPreparedTilesTotal = 0;
  private wastedPrewarmBytes = 0;
  private prewarmedTilesActivatedTotal = 0;
  private currentPrewarmStartedAtMs: number | null = null;
  private lastPreparationLeadTimeMs = 0;
  private lastZoomSampleAtMs: number | null = null;
  private lastScalePxPerMeterSample: number | null = null;
  private scaleVelocityPerSec = 0;
  private lastFocusSampleAtMs: number | null = null;
  private panVelocityXPerSec = 0;
  private panVelocityZPerSec = 0;
  private lastAdaptivePrewarmEval: AdaptivePrewarmHorizonEvaluation | null = null;
  private readonly historicalPrepLatencyByResMs: Record<number, number> = {
    1024: 260,
    2048: 580,
    4096: 1250,
  };
  private currentTransitionNewlyRequiredTilesCount = 0;

  // Hierarchical telemetry counters & timings
  private transitionsStartedTotal = 0;
  private transitionsCompletedTotal = 0;
  private transitionsCancelledTotal = 0;
  private transitionsDeferredBudgetTotal = 0;
  private cacheHitsTotal = 0;
  private cacheEvictionsTotal = 0;
  private lastTransitionTotalMs = 0;
  private lastActivationSwapMs = 0;
  private maxActivationSwapMs = 0;
  private readonly activationSwapMsRing: number[] = [];
  private readonly transitionDurationMsRing: number[] = [];

  private metadata: TilePackMetadata | null = null;
  private manifestStatus: TileManifestLoadStatus = 'idle';
  private manifestPackPath: string | null = null;
  private manifestError: string | null = null;
  private currentTheme: MapStyleTheme;
  private currentCameraZoom: number;
  private foliageConfig: FoliageOptimizationConfig;
  private foliageRuntimeState: FoliageRuntimeState;
  private tilePrepOptions: TilePreparationOptions;
  private currentWireframe = false;
  private currentViewport: TileViewportGroundBounds | null = null;
  private previousFocus: { x: number; z: number } | null = null;
  private panLeadVector: { x: number; z: number } = { x: 0, z: 0 };

  private activeFetchCount = 0;
  private activeDestinationFetchCount = 0;
  private activeDecodeCount = 0;
  private tailTileBoostsAppliedTotal = 0;
  private ageEscalationsAppliedTotal = 0;
  private lastTileError: string | null = null;
  private requestGenerationCounter = 1;
  private isDisposed = false;

  // Cumulative telemetry counters
  private evictedTilesTotal = 0;
  private cancelledRequestsTotal = 0;
  private duplicateRequestsSkippedTotal = 0;
  private completedLoadsTotal = 0;
  private workerBvhAdoptedTotal = 0;
  private syncBvhFallbackTotal = 0;
  private peakLoadedTiles = 0;
  private peakLoadingTiles = 0;
  private compositeSceneRevision = 0;
  /** Failed fetches may require viewport re-evaluation even if the camera remains still. */
  private needsViewportRefresh = false;
  private viewportSelectionPasses = 0;
  private viewportSelectionSkips = 0;
  private zoomPropagationSkips = 0;
  private lastManifestLoadMs = 0;
  private totalFetchMs = 0;
  private fetchSamples = 0;
  private totalDecodeMs = 0;
  private decodeSamples = 0;
  private totalReconstructMs = 0;
  private reconstructSamples = 0;
  private lastCommitMs = 0;
  private maxCommitMs = 0;
  private readonly fetchMsRing: number[] = [];
  private readonly decodeMsRing: number[] = [];
  private readonly reconstructMsRing: number[] = [];
  private readonly commitMsRing: number[] = [];

  // Idle synchronization waiters
  private idleWaiters: Array<() => void> = [];

  constructor(options: TileStreamManagerOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? '/api/tiles').replace(/\/+$/, '');
    this.preloadMarginTiles = Math.max(0, options.preloadMarginTiles ?? 1);
    this.retainMarginTiles = Math.max(
      this.preloadMarginTiles,
      options.retainMarginTiles ?? this.preloadMarginTiles + 1
    );
    this.explicitMaxConcurrentFetches =
      typeof options.maxConcurrentFetches === 'number' &&
      Number.isFinite(options.maxConcurrentFetches)
        ? Math.max(1, Math.floor(options.maxConcurrentFetches))
        : null;
    this.maxConcurrentFetches = this.explicitMaxConcurrentFetches ?? 6;
    this.maxCommitsPerFrame = Math.max(1, options.maxCommitsPerFrame ?? 4);
    this.experimentSkipUnchangedViewport = options.experimentSkipUnchangedViewport === true;
    this.experimentSkipUnchangedZoom = options.experimentSkipUnchangedZoom === true;
    this.currentTheme = options.initialTheme ?? MAP_THEMES.tactical;
    this.currentCameraZoom = options.initialCameraZoom ?? 1.0;
    this.foliageConfig = normalizeFoliageOptimizationConfig(
      options.foliageOptimizationConfig
    );
    this.foliageRuntimeState = resolveFoliageRuntimeState(
      this.currentCameraZoom,
      null,
      this.foliageConfig
    );
    this.tilePrepOptions = resolveTilePreparationOptions(
      options.tilePreparationOptions
    );
    this.hierarchicalPolicy = normalizeHierarchicalResolutionPolicy(
      options.hierarchicalPolicy
    );
    this.hierarchicalBudget = normalizeHierarchicalResourceBudget(
      options.hierarchicalBudget
    );
    this.nowFn = options.nowFn ?? (() => performance.now());
    this.streamingFrameBudget = resolveStreamingFrameBudgetConfig(
      options.streamingFrameBudget,
      DEFAULT_MANAGER_STREAMING_FRAME_BUDGET_CONFIG
    );
    this.workloadScheduler = new StreamingWorkloadScheduler(this.nowFn);
    this.gpuPreparer = new IncrementalGpuPreparer({
      adapter: options.gpuUploadAdapter ?? null,
      nowFn: this.nowFn,
    });
    this.deferredDisposalQueue = new DeferredDisposalQueue(this.nowFn);

    if (options.materialRegistry) {
      this.materialRegistry = options.materialRegistry;
      this.ownsMaterialRegistry = false;
    } else {
      this.materialRegistry = new ThemeMaterialRegistry(
        this.currentTheme,
        this.currentCameraZoom
      );
      this.ownsMaterialRegistry = true;
    }

    if (options.foliagePrototypeRegistry) {
      this.foliagePrototypeRegistry = options.foliagePrototypeRegistry;
      this.ownsFoliagePrototypeRegistry = false;
    } else {
      this.foliagePrototypeRegistry = new FoliagePrototypeRegistry();
      this.ownsFoliagePrototypeRegistry = true;
    }

    this.profiler =
      options.profiler === undefined
        ? getGlobalStreamingProfiler()
        : options.profiler;

    if (options.decodeClient) {
      this.decodeClient = options.decodeClient;
      this.ownsDecodeClient = false;
      if (typeof this.decodeClient.getPreparationOptions === 'function') {
        this.tilePrepOptions = this.decodeClient.getPreparationOptions();
      }
      if (typeof this.decodeClient.setMaxWorkerConcurrency === 'function') {
        this.decodeClient.setMaxWorkerConcurrency(
          this.streamingFrameBudget.workerConcurrency,
          this.streamingFrameBudget.reservedDestinationWorkerSlots
        );
      }
    } else {
      this.decodeClient = createTileDecodeClient({
        workerCount: Math.max(4, this.streamingFrameBudget.workerConcurrency),
        maxConcurrentWorkers: this.streamingFrameBudget.workerConcurrency,
        reservedDestinationWorkerSlots:
          this.streamingFrameBudget.reservedDestinationWorkerSlots,
        preparationOptions: this.tilePrepOptions,
        onWorkerMessageDelivered: (info) => {
          const prof =
            this.profiler && this.profiler.enabled ? this.profiler : null;
          if (!prof) return;
          prof.recordWorkerOnMessage({
            durationMs: info.handlerDurationMs,
            deliveryLatencyMs: info.timings.messageDeliveryLatencyMs,
            workerBvhBuildMs: info.timings.workerBvhBuildMs,
            transferableBytes: info.timings.transferableBytes,
            usedCompactTransport: info.timings.usedCompactTransport,
          });
          const rec = this.tilesByKey.get(info.tileKey);
          prof.recordEvent({
            eventType: 'worker_message_received',
            tileKey: info.tileKey,
            tileSizeMeters:
              rec?.resolutionMeters ?? this.metadata?.tileSizeMeters ?? 1024,
            lod: rec?.manifest.lod ?? 0,
            timestampMs: info.onMessageEndMs,
            payloadCompressedBytes: rec?.lastCompressedBytes ?? null,
            durationMs: info.handlerDurationMs,
            queueDepths: this.getQueueDepthSnapshot(),
            detail: {
              usedWebWorker: info.timings.usedWebWorker,
              usedCompactTransport: info.timings.usedCompactTransport,
              transferAllTypedArrays: info.timings.transferAllTypedArrays,
              workerInstanceBvhEnabled: info.timings.workerInstanceBvhEnabled,
              workerQueueWaitMs: info.timings.workerQueueWaitMs,
              workerInflateAndDecodeMs: info.timings.workerInflateAndDecodeMs,
              workerBvhBuildMs: info.timings.workerBvhBuildMs,
              workerPayloadPrepMs: info.timings.workerPayloadPrepMs,
              messageDeliveryLatencyMs: info.timings.messageDeliveryLatencyMs,
              mainOnMessageHandlerMs: info.timings.mainOnMessageHandlerMs,
              transferableBufferCount: info.timings.transferableBufferCount,
              transferableBytes: info.timings.transferableBytes,
              workerBvhBatchCount: info.timings.workerBvhBatchCount,
              workerBvhInstanceCount: info.timings.workerBvhInstanceCount,
            },
          });
        },
      });
      this.ownsDecodeClient = true;
    }

    this.fetchFn =
      options.fetchFn ??
      ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.onDiagnosticsChange = options.onDiagnosticsChange;

    // Top-level composite layer groups mounted by MapScene.tsx
    const buildingsGroup = new THREE.Group();
    buildingsGroup.name = 'Buildings';
    const roadsGroup = new THREE.Group();
    roadsGroup.name = 'Roads';
    const railwaysGroup = new THREE.Group();
    railwaysGroup.name = 'Railways';
    const waterGroup = new THREE.Group();
    waterGroup.name = 'Water';
    waterGroup.renderOrder = 2;
    const parksGroup = new THREE.Group();
    parksGroup.name = 'Parks';
    parksGroup.renderOrder = 3;
    const landuseGroup = new THREE.Group();
    landuseGroup.name = 'Landuse';
    landuseGroup.renderOrder = 1;
    const barriersGroup = new THREE.Group();
    barriersGroup.name = 'Barriers';
    const foliageGroup = new THREE.Group();
    foliageGroup.name = 'Foliage';

    const grid = createHengeloStudyGrid();
    const spanX = grid.cols * grid.tileSizeMeters;
    const spanZ = grid.rows * grid.tileSizeMeters;
    const groundGeo = this.regionalResources.registerGeometry(
      new THREE.PlaneGeometry(spanX + 1024, spanZ + 1024, 1, 1)
    );
    groundGeo.rotateX(-Math.PI / 2);
    this.groundMesh = new THREE.Mesh(
      groundGeo,
      this.materialRegistry.getMaterial('ground')
    );
    this.groundMesh.name = 'GroundPlane_M2A_Regional';
    this.groundMesh.position.set(0, -0.015, 0);
    this.groundMesh.receiveShadow = true;

    this.boundaryOverlayResult = createM1aTileBoundaryOverlay(grid);
    this.boundaryOverlayResult.group.visible = true;

    railwaysGroup.userData.railwayStats = {
      sleeper3DBoxCount: 0,
      railwayRenderSource: 'graph_extrusion',
    };
    railwaysGroup.userData.updateCameraZoom = (zoom: number) =>
      this.updateCameraZoom(zoom);
    foliageGroup.userData.getFoliageRuntimeState = () =>
      this.foliageRuntimeState;
    foliageGroup.userData.getFoliageOptimizationConfig = () =>
      this.foliageConfig;
    foliageGroup.userData.getFoliagePrototypeRegistry = () =>
      this.foliagePrototypeRegistry;
    foliageGroup.userData.setFoliageOptimizationConfig = (
      partial: Partial<FoliageOptimizationConfig>
    ) => this.setFoliageOptimizationConfig(partial);

    this.compositeScene = {
      buildingsGroup,
      roadsGroup,
      railwaysGroup,
      waterGroup,
      parksGroup,
      landuseGroup,
      barriersGroup,
      foliageGroup,
      groundMesh: this.groundMesh,
      interactiveMeshes: {
        buildings: [],
      },
      stats: {
        totalVertices: 0,
        totalTriangles: 0,
        totalDrawCalls: 0,
        renderedFeaturesCount: 0,
        forestTreesCount: 0,
      },
      resources: this.regionalResources,
      infrastructureRenderOptions: { ...DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS },
      infrastructureRenderPreview: null,
      dispose: () => this.dispose(),
      updateTheme: (newTheme: MapStyleTheme) => this.updateTheme(newTheme),
      updateCameraZoom: (zoom: number) => this.updateCameraZoom(zoom),
    };
  }

  get scene(): BuiltSceneGeometry {
    return this.compositeScene;
  }

  get isHierarchical(): boolean {
    return this.hierarchy !== null;
  }

  private getEffectiveMaxConcurrentHttpRetrievals(): number {
    if (this.explicitMaxConcurrentFetches !== null) {
      return this.explicitMaxConcurrentFetches;
    }
    return this.streamingFrameBudget.independentPipelineStagesEnabled
      ? this.streamingFrameBudget.maxConcurrentHttpRetrievals
      : this.maxConcurrentFetches;
  }

  getTilePreparationOptions(): TilePreparationOptions {
    return { ...this.tilePrepOptions };
  }

  setTilePreparationOptions(
    next: TilePreparationVariantId | Partial<TilePreparationOptions>
  ): TilePreparationOptions {
    this.tilePrepOptions = resolveTilePreparationOptions(next);
    this.decodeClient.setPreparationOptions(this.tilePrepOptions);
    this.emitDiagnostics();
    return { ...this.tilePrepOptions };
  }

  getHierarchicalPolicyConfig(): HierarchicalResolutionPolicyConfig {
    return {
      ...this.hierarchicalPolicy,
      bands: this.hierarchicalPolicy.bands.map((b) => ({ ...b })),
    };
  }

  setHierarchicalPolicyConfig(
    partial: Partial<HierarchicalResolutionPolicyConfig>
  ): HierarchicalResolutionPolicyConfig {
    if (this.isDisposed) {
      return this.getHierarchicalPolicyConfig();
    }
    this.hierarchicalPolicy = normalizeHierarchicalResolutionPolicy({
      ...this.hierarchicalPolicy,
      ...partial,
      bands: partial.bands ?? this.hierarchicalPolicy.bands,
    });
    if (this.hierarchy && this.manifestStatus === 'loaded') {
      if (this.transitionState === 'deferred_budget') {
        this.transitionState = 'preparing';
        this.budgetDeferralReason = null;
        this.lastDeferredViewportSignature = null;
      }
      this.evaluateDesiredResolutionInternal();
      this.needsViewportRefresh = true;
      if (this.currentViewport) {
        this.updateViewport(this.currentViewport);
      } else {
        this.emitDiagnostics();
      }
    } else {
      this.emitDiagnostics();
    }
    return this.getHierarchicalPolicyConfig();
  }

  getHierarchicalBudgetConfig(): HierarchicalResourceBudgetConfig {
    return { ...this.hierarchicalBudget };
  }

  setHierarchicalBudgetConfig(
    partial: Partial<HierarchicalResourceBudgetConfig>
  ): HierarchicalResourceBudgetConfig {
    if (this.isDisposed) {
      return this.getHierarchicalBudgetConfig();
    }
    const mergedBudget: Partial<HierarchicalResourceBudgetConfig> = {
      ...this.hierarchicalBudget,
      ...partial,
    };
    // When totalMemoryBudgetBytes changes without explicit dependent overrides,
    // recompute derived defaults so a prior tight budget clamp does not stick.
    if (partial.totalMemoryBudgetBytes !== undefined) {
      if (partial.inactiveCacheBudgetBytes === undefined) {
        delete mergedBudget.inactiveCacheBudgetBytes;
      }
      if (partial.maxPendingDecodedBytes === undefined) {
        delete mergedBudget.maxPendingDecodedBytes;
      }
    }
    this.hierarchicalBudget = normalizeHierarchicalResourceBudget(mergedBudget);
    if (this.hierarchy && this.manifestStatus === 'loaded') {
      if (this.transitionState === 'deferred_budget') {
        this.transitionState = 'preparing';
        this.budgetDeferralReason = null;
        this.lastDeferredViewportSignature = null;
        this.lastDeferredBudgetBytes = null;
      }
      this.enforceResourceBudgets();
      this.needsViewportRefresh = true;
      if (this.currentViewport) {
        this.updateViewport(this.currentViewport);
      } else {
        this.emitDiagnostics();
      }
    } else {
      this.emitDiagnostics();
    }
    return this.getHierarchicalBudgetConfig();
  }

  getHierarchicalDiagnostics(): HierarchicalStreamingDiagnosticsSnapshot | null {
    return this.getDiagnostics().hierarchical;
  }

  getStreamingFrameBudgetConfig(): StreamingFrameBudgetConfig {
    return { ...this.streamingFrameBudget };
  }

  setStreamingFrameBudgetConfig(
    input: StreamingF1VariantId | Partial<StreamingFrameBudgetConfig>
  ): StreamingFrameBudgetConfig {
    if (this.isDisposed) {
      return { ...this.streamingFrameBudget };
    }
    this.streamingFrameBudget = resolveStreamingFrameBudgetConfig(
      input,
      this.streamingFrameBudget
    );
    if (typeof this.decodeClient.setMaxWorkerConcurrency === 'function') {
      this.decodeClient.setMaxWorkerConcurrency(
        this.streamingFrameBudget.workerConcurrency,
        this.streamingFrameBudget.reservedDestinationWorkerSlots
      );
    }
    if (!this.streamingFrameBudget.deferredDisposalEnabled) {
      this.deferredDisposalQueue.flushAll();
    }
    if (this.streamingFrameBudget.transitionDebounceMs <= 0 && this.pendingDebounceTargetResolution !== null) {
      this.evaluateDesiredResolutionInternal();
    }
    if (this.hierarchy && this.manifestStatus === 'loaded') {
      this.needsViewportRefresh = true;
      if (this.currentViewport) {
        this.updateViewport(this.currentViewport);
      } else {
        this.emitDiagnostics();
      }
    } else {
      this.emitDiagnostics();
    }
    return { ...this.streamingFrameBudget };
  }

  attachRenderer(renderer: THREE.WebGLRenderer | null): void {
    if (this.isDisposed) return;
    this.gpuPreparer.attachRenderer(renderer);
  }

  setGpuUploadAdapter(adapter: GpuPrepUploadAdapter | null): void {
    if (this.isDisposed) return;
    this.gpuPreparer.setAdapter(adapter);
  }

  invalidateGpuPrepForContextLoss(lost = false): void {
    if (this.isDisposed) return;
    this.gpuPreparer.invalidateAllForContextLoss(lost);
  }

  setBoundaryOverlayVisible(visible: boolean): void {
    if (this.isDisposed) return;
    const next = Boolean(visible);
    this.boundaryOverlayVisible = next;
    this.boundaryOverlayResult.group.visible = next;
    if (next && this.boundaryOverlayDirty && this.metadata) {
      const activeLevel = this.getActiveLevelState();
      this.rebuildBoundaryOverlayFromManifest(
        this.metadata,
        activeLevel ? activeLevel.tilesByKey : this.tilesByKey
      );
    }
  }

  getDeferredDisposalAccounting(): DeferredDisposalAccountingSnapshot {
    return this.deferredDisposalQueue.getAccountingSnapshot();
  }

  getGpuPreparerStats(): IncrementalGpuPreparerStats {
    return this.gpuPreparer.getStats();
  }

  getSchedulerStats(): StreamingSchedulerCumulativeStats {
    return this.workloadScheduler.getStats();
  }

  get tileBoundaryOverlay(): THREE.Group {
    return this.boundaryOverlayResult.group;
  }

  get sharedMaterialRegistry(): ThemeMaterialRegistry {
    return this.materialRegistry;
  }

  get sharedFoliagePrototypeRegistry(): FoliagePrototypeRegistry {
    return this.foliagePrototypeRegistry;
  }

  setProfiler(profiler: StreamingProfiler | null): void {
    this.profiler = profiler;
  }

  private getActiveLevelState(): ResolutionLevelState | null {
    if (this.activeResolutionMeters === null) return null;
    return this.levelsByResolution.get(this.activeResolutionMeters) ?? null;
  }

  private getPendingLevelState(): ResolutionLevelState | null {
    if (this.pendingResolutionMeters === null) return null;
    return this.levelsByResolution.get(this.pendingResolutionMeters) ?? null;
  }

  private getQueueDepthSnapshot(): StreamingQueueDepths {
    let queued = 0;
    let fetching = 0;
    let decoding = 0;
    let readyToCommit = 0;
    let loaded = 0;
    let visible = 0;
    for (const r of this.tilesByKey.values()) {
      if (r.resolutionMeters === this.activeResolutionMeters && r.isVisibleInViewport) {
        visible += 1;
      }
      if (r.state === 'queued') queued += 1;
      else if (r.state === 'fetching') fetching += 1;
      else if (r.state === 'retrieved_queued' || r.state === 'decoding') decoding += 1;
      else if (r.state === 'ready_to_commit') readyToCommit += 1;
      else if (r.state === 'loaded') loaded += 1;
    }
    return { queued, fetching, decoding, readyToCommit, loaded, visible };
  }

  getFoliageOptimizationConfig(): FoliageOptimizationConfig {
    return { ...this.foliageConfig };
  }

  getFoliageRuntimeState(): FoliageRuntimeState {
    return { ...this.foliageRuntimeState };
  }

  setFoliageOptimizationConfig(
    partial: Partial<FoliageOptimizationConfig>
  ): FoliageRuntimeState {
    if (this.isDisposed) {
      return { ...this.foliageRuntimeState };
    }
    const nextConfig = normalizeFoliageOptimizationConfig({
      ...this.foliageConfig,
      ...partial,
    });
    if (equalFoliageOptimizationConfig(this.foliageConfig, nextConfig)) {
      return { ...this.foliageRuntimeState };
    }
    this.foliageConfig = nextConfig;
    const nextState = resolveFoliageRuntimeState(
      this.currentCameraZoom,
      null,
      this.foliageConfig
    );
    this.foliageRuntimeState = nextState;
    for (const record of this.tilesByKey.values()) {
      if (record.state === 'loaded' && record.reconstructed) {
        record.reconstructed.applyFoliageRuntimeState(nextState);
      }
    }
    this.emitDiagnostics();
    return { ...nextState };
  }

  get packMetadata(): TilePackMetadata | null {
    return this.metadata;
  }

  get packPath(): string | null {
    return this.manifestPackPath;
  }

  get activeMosaicName(): string | null {
    if (this.hierarchy) {
      return this.hierarchy.hierarchyName;
    }
    return deriveActiveMosaicNameFromPackPath(this.manifestPackPath);
  }

  get currentManifestStatus(): TileManifestLoadStatus {
    return this.manifestStatus;
  }

  getManifestCoverageSummary(): TileManifestCoverageSummary | null {
    if (this.manifestStatus !== 'loaded' || !this.metadata) {
      return null;
    }
    const activeLevel = this.getActiveLevelState();
    const recordSource = activeLevel ? activeLevel.tilesByKey : this.tilesByKey;
    let nonEmptyTiles = 0;
    let emptyTiles = 0;
    let minE = Number.POSITIVE_INFINITY;
    let maxE = Number.NEGATIVE_INFINITY;
    let minN = Number.POSITIVE_INFINITY;
    let maxN = Number.NEGATIVE_INFINITY;
    let minTx = Number.POSITIVE_INFINITY;
    let maxTx = Number.NEGATIVE_INFINITY;
    let minTy = Number.POSITIVE_INFINITY;
    let maxTy = Number.NEGATIVE_INFINITY;

    for (const record of recordSource.values()) {
      const m = record.manifest;
      if (m.isEmpty) {
        emptyTiles += 1;
      } else {
        nonEmptyTiles += 1;
      }
      if (m.minEasting < minE) minE = m.minEasting;
      if (m.maxEasting > maxE) maxE = m.maxEasting;
      if (m.minNorthing < minN) minN = m.minNorthing;
      if (m.maxNorthing > maxN) maxN = m.maxNorthing;
      if (m.tx < minTx) minTx = m.tx;
      if (m.ty < minTy) minTy = m.ty;
      if (m.tx > maxTx) maxTx = m.tx;
      if (m.ty > maxTy) maxTy = m.ty;
    }

    const hasBounds = Number.isFinite(minE) && Number.isFinite(maxE) && Number.isFinite(minN) && Number.isFinite(maxN);
    let boundsGeo: TileManifestCoverageSummary['boundsGeo'] = null;
    if (hasBounds) {
      const sw = utm32NToGeo(minE, minN);
      const nw = utm32NToGeo(minE, maxN);
      const se = utm32NToGeo(maxE, minN);
      const ne = utm32NToGeo(maxE, maxN);
      boundsGeo = {
        minLon: Math.min(sw[0], nw[0], se[0], ne[0]),
        maxLon: Math.max(sw[0], nw[0], se[0], ne[0]),
        minLat: Math.min(sw[1], nw[1], se[1], ne[1]),
        maxLat: Math.max(sw[1], nw[1], se[1], ne[1]),
      };
    }

    const cols = this.metadata.gridCols;
    const rows = this.metadata.gridRows;
    const shardCountEstimate =
      cols >= 4 && rows >= 4 && cols % 4 === 0 && rows % 4 === 0
        ? (cols / 4) * (rows / 4)
        : null;

    return {
      totalTiles: recordSource.size,
      nonEmptyTiles,
      emptyTiles,
      gridCols: cols,
      gridRows: rows,
      tileSizeMeters: this.metadata.tileSizeMeters,
      studyOriginEasting: this.metadata.studyOriginEasting,
      studyOriginNorthing: this.metadata.studyOriginNorthing,
      boundsUtm: hasBounds
        ? { minEasting: minE, maxEasting: maxE, minNorthing: minN, maxNorthing: maxN }
        : null,
      boundsGeo,
      minTx: Number.isFinite(minTx) ? minTx : this.metadata.minTx ?? null,
      maxTx: Number.isFinite(maxTx) ? maxTx : this.metadata.maxTx ?? null,
      minTy: Number.isFinite(minTy) ? minTy : this.metadata.minTy ?? null,
      maxTy: Number.isFinite(maxTy) ? maxTy : this.metadata.maxTy ?? null,
      shardCountEstimate,
      compression: this.metadata.compression ?? 'deflate',
      projection: this.metadata.projectionId,
      createdAt: this.metadata.createdAtIso,
    };
  }


  /**
   * Clears any currently loaded tiles and manifest metadata so a reload or
   * failed manifest fetch can never report a previous dataset as active.
   */
  private resetLoadedManifestState(): void {
    let detachedAny = false;
    for (const record of this.tilesByKey.values()) {
      record.requestGeneration = this.requestGenerationCounter++;
      if (record.abortController) {
        record.abortController.abort();
        record.abortController = null;
      }
      this.releaseRecordStageReservations(record);
      if (record.reconstructed) {
        this.detachTileFromCompositeScene(record);
        record.reconstructed.dispose();
        record.reconstructed = null;
        detachedAny = true;
      }
      record.retrievedBuffer = null;
      record.decodedPayload = null;
      record.decodedFootprint = null;
      record.state = 'unloaded';
    }
    this.inFlightHttpReservationBytes = 0;
    this.retrievedPayloadQueueBytes = 0;
    this.inFlightWorkerPreparationBytes = 0;
    this.tilesByKey.clear();
    this.levelsByResolution.clear();
    this.hierarchy = null;
    this.activeResolutionMeters = null;
    this.desiredResolutionMeters = null;
    this.pendingResolutionMeters = null;
    this.prewarmTargetResolutionMeters = null;
    this.currentPrewarmStartedAtMs = null;
    this.pendingDebounceTargetResolution = null;
    this.pendingDebounceStartedAtMs = null;
    this.currentTransitionDebounceWaitMs = 0;
    this.currentTransitionCancellations = 0;
    this.currentTransitionNewlyRequiredTilesCount = 0;
    this.recentTransitions.length = 0;
    this.lastCompletedTransition = null;
    this.transitionState = 'idle';
    this.transitionGeneration += 1;
    this.transitionStartedAtMs = null;
    this.budgetDeferralReason = null;
    this.lastDeferredViewportSignature = null;
    this.lastDeferredBudgetBytes = null;
    this.lastScaleEval = null;
    this.speculativeBackpressureActive = false;
    this.workerBackpressureActive = false;
    this.deferredDisposalQueue.flushAll();
    this.metadata = null;
    this.manifestPackPath = null;
    this.currentViewport = null;
    this.needsViewportRefresh = false;
    this.previousFocus = null;
    this.panLeadVector = { x: 0, z: 0 };
    if (detachedAny) {
      this.rebuildCompositeStats();
    }
  }

  private buildTileRecord(
    entry: TileManifestEntry,
    tileKey: string,
    resolutionMeters: number,
    originEasting: number,
    originNorthing: number
  ): ManagedTileRecord {
    const minX = entry.minEasting - originEasting;
    const maxX = entry.maxEasting - originEasting;
    const minZ = originNorthing - entry.maxNorthing;
    const maxZ = originNorthing - entry.minNorthing;

    const ovMinX = entry.tileCenterX + entry.overhangMinX;
    const ovMaxX = entry.tileCenterX + entry.overhangMaxX;
    const ovMinZ = entry.tileCenterZ + entry.overhangMinZ;
    const ovMaxZ = entry.tileCenterZ + entry.overhangMaxZ;

    return {
      tileKey,
      resolutionMeters,
      manifest: entry,
      worldBounds: {
        minX,
        maxX,
        minZ,
        maxZ,
        centerX: (minX + maxX) * 0.5,
        centerZ: (minZ + maxZ) * 0.5,
      },
      overhangWorldBounds: {
        minX: Math.min(minX, ovMinX),
        maxX: Math.max(maxX, ovMaxX),
        minZ: Math.min(minZ, ovMinZ),
        maxZ: Math.max(maxZ, ovMaxZ),
      },
      state: 'unloaded',
      isVisibleInViewport: false,
      isInFetchSet: false,
      isInKeepSet: false,
      priorityScore: Number.POSITIVE_INFINITY,
      abortController: null,
      requestGeneration: 0,
      retrievedBuffer: null,
      reservedHttpBytes: 0,
      reservedWorkerBytes: 0,
      decodedPayload: null,
      decodedFootprint: null,
      reconstructed: null,
      lastError: null,
      lastCompressedBytes: null,
      lastUsedAtMs: 0,
      pipeline: createEmptyTilePipelineTimings(),
    };
  }

  /**
   * Initializes the stream manager from `/api/tiles/manifest` or a pre-loaded manifest payload.
   * Supports both single-resolution mosaics and multi-resolution hierarchical manifests.
   */
  async initialize(
    manifestOverride?: TilePackManifestPayload
  ): Promise<TilePackMetadata> {
    if (this.isDisposed) {
      throw new Error('TileStreamManager has been disposed.');
    }
    const t0 = performance.now();
    this.resetLoadedManifestState();
    this.manifestStatus = 'loading';
    this.manifestError = null;
    this.emitDiagnostics();

    let payload: TilePackManifestPayload;
    try {
      if (manifestOverride) {
        payload = manifestOverride;
      } else {
        const response = await this.fetchFn(`${this.apiBaseUrl}/manifest`);
        if (!response.ok) {
          let errorMessage = `Failed to load tile manifest (HTTP ${response.status})`;
          try {
            const errJson = (await response.json()) as { error?: string };
            if (errJson?.error) {
              errorMessage = errJson.error;
            }
          } catch {
            // ignore
          }
          throw new Error(errorMessage);
        }
        payload = (await response.json()) as TilePackManifestPayload;
      }

      if (
        !payload ||
        payload.available === false ||
        !payload.metadata ||
        !Array.isArray(payload.tiles)
      ) {
        throw new Error('Tile manifest response is unavailable or malformed.');
      }
    } catch (err) {
      this.resetLoadedManifestState();
      this.manifestStatus = 'error';
      this.manifestError = err instanceof Error ? err.message : String(err);
      this.emitDiagnostics();
      throw err;
    }

    if (this.isDisposed) {
      throw new Error('TileStreamManager has been disposed.');
    }

    // A valid HTTP manifest is not enough: tile and overlay setup can still fail.
    // Keep diagnostics in the loading state until the complete setup succeeds.
    try {
      this.lastManifestLoadMs = performance.now() - t0;
      this.manifestPackPath =
        typeof payload.packPath === 'string' && payload.packPath.trim().length > 0
          ? payload.packPath.trim()
          : null;
      this.tilesByKey.clear();
      this.levelsByResolution.clear();
      this.currentViewport = null;
      this.needsViewportRefresh = false;
      this.previousFocus = null;
      this.panLeadVector = { x: 0, z: 0 };

      const hasHierarchy =
        Boolean(payload.hierarchy) &&
        Array.isArray(payload.hierarchy?.levels) &&
        payload.hierarchy!.levels.length >= 2;

      if (hasHierarchy && payload.hierarchy) {
        const h = payload.hierarchy;
        this.hierarchy = h;

        const originEasting = h.canonicalOriginEasting;
        const originNorthing = h.canonicalOriginNorthing;

        for (const levelManifest of h.levels) {
          const levelTiles = new Map<string, ManagedTileRecord>();
          for (const entry of levelManifest.tiles) {
            const tileKey = formatHierarchicalTileKey(
              levelManifest.tileSizeMeters,
              entry.tx,
              entry.ty,
              entry.lod
            );
            const record = this.buildTileRecord(
              entry,
              tileKey,
              levelManifest.tileSizeMeters,
              originEasting,
              originNorthing
            );
            levelTiles.set(tileKey, record);
            this.tilesByKey.set(tileKey, record);
          }
          this.levelsByResolution.set(levelManifest.tileSizeMeters, {
            tileSizeMeters: levelManifest.tileSizeMeters,
            metadata: levelManifest.metadata,
            levelManifest,
            tilesByKey: levelTiles,
          });
        }

        const initialEval = resolveDesiredHierarchicalResolution({
          availableResolutionsMeters: h.resolutionsMeters,
          currentResolutionMeters: null,
          cameraZoom: this.currentCameraZoom,
          viewportWidthPx: this.currentViewportWidthPx,
          viewportHeightPx: this.currentViewportHeightPx,
          policy: this.hierarchicalPolicy,
        });
        this.lastScaleEval = initialEval;
        this.activeResolutionMeters = initialEval.desiredResolutionMeters;
        this.desiredResolutionMeters = initialEval.desiredResolutionMeters;
        this.pendingResolutionMeters = null;
        this.transitionState = 'idle';
        this.budgetDeferralReason = null;

        const activeLevel = this.levelsByResolution.get(this.activeResolutionMeters)!;
        this.metadata = activeLevel.metadata;

        // Size ground plane from the union UTM coverage across all resolutions.
        const unionSpanX = h.unionBoundsUtm.maxEasting - h.unionBoundsUtm.minEasting;
        const unionSpanZ = h.unionBoundsUtm.maxNorthing - h.unionBoundsUtm.minNorthing;
        const maxTileSize = h.resolutionsMeters[h.resolutionsMeters.length - 1] ?? 4096;
        this.groundMesh.userData.__regionalStreamingWidthMeters = unionSpanX;
        if (unionSpanX > 0 && unionSpanZ > 0) {
          const oldGeometry = this.groundMesh.geometry;
          const groundGeometry = this.regionalResources.registerGeometry(
            new THREE.PlaneGeometry(
              unionSpanX + maxTileSize * 2,
              unionSpanZ + maxTileSize * 2,
              1,
              1
            )
          );
          groundGeometry.rotateX(-Math.PI / 2);
          this.groundMesh.geometry = groundGeometry;
          oldGeometry.dispose();
        }

        this.rebuildBoundaryOverlayFromManifest(
          activeLevel.metadata,
          activeLevel.tilesByKey
        );
      } else {
        this.hierarchy = null;
        this.metadata = payload.metadata;
        this.activeResolutionMeters = payload.metadata.tileSizeMeters;
        this.desiredResolutionMeters = payload.metadata.tileSizeMeters;
        this.pendingResolutionMeters = null;
        this.transitionState = 'idle';
        this.budgetDeferralReason = null;

        // The original 4km study ground plane is insufficient for larger baked regions.
        // Keep the same scene/mesh identity while resizing only its geometry.
        const regionWidth = payload.metadata.gridCols * payload.metadata.tileSizeMeters;
        const regionDepth = payload.metadata.gridRows * payload.metadata.tileSizeMeters;
        this.groundMesh.userData.__regionalStreamingWidthMeters = regionWidth;
        if (regionWidth > 0 && regionDepth > 0) {
          const oldGeometry = this.groundMesh.geometry;
          const groundGeometry = this.regionalResources.registerGeometry(
            new THREE.PlaneGeometry(regionWidth + 1024, regionDepth + 1024, 1, 1)
          );
          groundGeometry.rotateX(-Math.PI / 2);
          this.groundMesh.geometry = groundGeometry;
          oldGeometry.dispose();
        }

        const originEasting = payload.metadata.studyOriginEasting;
        const originNorthing = payload.metadata.studyOriginNorthing;

        for (const entry of payload.tiles) {
          const tileKey = formatTileId(entry.tx, entry.ty);
          const record = this.buildTileRecord(
            entry,
            tileKey,
            payload.metadata.tileSizeMeters,
            originEasting,
            originNorthing
          );
          this.tilesByKey.set(tileKey, record);
        }

        this.levelsByResolution.set(payload.metadata.tileSizeMeters, {
          tileSizeMeters: payload.metadata.tileSizeMeters,
          metadata: payload.metadata,
          levelManifest: null,
          tilesByKey: this.tilesByKey,
        });

        this.rebuildBoundaryOverlayFromManifest(payload.metadata, this.tilesByKey);
      }

      // Only advertise an active mosaic once all tile records and overlays exist.
      this.manifestStatus = 'loaded';
      this.manifestError = null;
      this.emitDiagnostics();
      return this.metadata!;
    } catch (err) {
      this.resetLoadedManifestState();
      this.manifestStatus = 'error';
      this.manifestError = err instanceof Error ? err.message : String(err);
      this.emitDiagnostics();
      throw err;
    }
  }

  private rebuildBoundaryOverlayFromManifest(
    metadata: TilePackMetadata,
    levelTiles: Map<string, ManagedTileRecord> = this.tilesByKey
  ): number {
    const t0 = this.nowFn();
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const record of levelTiles.values()) {
      if (record.worldBounds.minX < minX) minX = record.worldBounds.minX;
      if (record.worldBounds.maxX > maxX) maxX = record.worldBounds.maxX;
      if (record.worldBounds.minZ < minZ) minZ = record.worldBounds.minZ;
      if (record.worldBounds.maxZ > maxZ) maxZ = record.worldBounds.maxZ;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
      const halfSpanX = (metadata.gridCols * metadata.tileSizeMeters) / 2;
      const halfSpanZ = (metadata.gridRows * metadata.tileSizeMeters) / 2;
      minX = -halfSpanX;
      maxX = halfSpanX;
      minZ = -halfSpanZ;
      maxZ = halfSpanZ;
    }

    const prevGroup = this.boundaryOverlayResult.group;
    const wasVisible = prevGroup.visible;
    this.boundaryOverlayResult.dispose();
    prevGroup.clear();

    const syntheticGridSpec = {
      cols: metadata.gridCols,
      rows: metadata.gridRows,
      tileSizeMeters: metadata.tileSizeMeters,
      studyLocalBounds: {
        minX,
        maxX,
        minZ,
        maxZ,
        includeMaxEdgeX: true,
        includeMaxEdgeZ: true,
      },
      tiles: new Array(levelTiles.size),
    } as unknown as StudyGridSpec;

    const nextOverlay = createM1aTileBoundaryOverlay(syntheticGridSpec);
    while (nextOverlay.group.children.length > 0) {
      const child = nextOverlay.group.children[0];
      nextOverlay.group.remove(child);
      prevGroup.add(child);
    }
    prevGroup.visible = wasVisible;

    this.boundaryOverlayResult = {
      group: prevGroup,
      tileCount: nextOverlay.tileCount,
      internalSeamCount: nextOverlay.internalSeamCount,
      dispose: nextOverlay.dispose,
    };
    this.boundaryOverlayDirty = false;
    const elapsedMs = Math.max(0, this.nowFn() - t0);
    this.boundaryOverlayRebuildMsTotal += elapsedMs;
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    if (prof) {
      prof.recordEvent({
        eventType: 'boundary_overlay_rebuild',
        tileKey: `overlay:${metadata.tileSizeMeters}`,
        tileSizeMeters: metadata.tileSizeMeters,
        lod: 0,
        durationMs: elapsedMs,
        queueDepths: this.getQueueDepthSnapshot(),
      });
    }
    return elapsedMs;
  }

  /**
   * Updates the active viewport from an OrthographicCamera and pumps fetch/commit queues.
   */
  updateFromCamera(
    camera: THREE.OrthographicCamera,
    target?: { x: number; y?: number; z: number }
  ): void {
    if (this.isDisposed || !this.metadata) return;
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;

    const tBounds0 = prof ? performance.now() : 0;
    const bounds = computeViewportGroundBoundsForCamera(camera, target);
    const boundsMs = prof ? performance.now() - tBounds0 : 0;

    if (bounds.viewportWidthPx !== undefined) {
      this.currentViewportWidthPx = bounds.viewportWidthPx;
    }
    if (bounds.viewportHeightPx !== undefined) {
      this.currentViewportHeightPx = bounds.viewportHeightPx;
    }

    let zoomSyncMs = 0;
    if (bounds.cameraZoom !== undefined) {
      const tZoom0 = prof ? performance.now() : 0;
      this.updateCameraZoom(bounds.cameraZoom);
      if (prof) zoomSyncMs = performance.now() - tZoom0;
    }
    if (prof) {
      prof.recordViewportBoundsDuration(boundsMs, zoomSyncMs);
    }

    if (this.experimentSkipUnchangedViewport &&
        !this.needsViewportRefresh &&
        equalTileViewportBounds(this.currentViewport, bounds)) {
      this.viewportSelectionSkips++;
    } else {
      this.updateViewport(bounds);
    }
    // Keep draining completed worker decodes even when the camera is stationary.
    this.tick();
    if (prof) {
      prof.recordQueueDepths(this.getQueueDepthSnapshot());
    }
  }

  private getViewportSignature(viewport: TileViewportGroundBounds): string {
    return `${viewport.minX.toFixed(1)},${viewport.maxX.toFixed(1)},${viewport.minZ.toFixed(1)},${viewport.maxZ.toFixed(1)},${(viewport.cameraZoom ?? this.currentCameraZoom).toFixed(4)},${viewport.viewportWidthPx ?? 0}`;
  }

  private releaseRecordStageReservations(record: ManagedTileRecord): void {
    if (record.reservedHttpBytes > 0) {
      this.inFlightHttpReservationBytes = Math.max(
        0,
        this.inFlightHttpReservationBytes - record.reservedHttpBytes
      );
      record.reservedHttpBytes = 0;
    }
    if (record.retrievedBuffer !== null) {
      this.retrievedPayloadQueueBytes = Math.max(
        0,
        this.retrievedPayloadQueueBytes - record.retrievedBuffer.byteLength
      );
      record.retrievedBuffer = null;
    }
    if (record.reservedWorkerBytes > 0) {
      this.inFlightWorkerPreparationBytes = Math.max(
        0,
        this.inFlightWorkerPreparationBytes - record.reservedWorkerBytes
      );
      record.reservedWorkerBytes = 0;
    }
  }

  private cancelPendingTransition(reason: string): void {
    if (this.pendingResolutionMeters === null) return;
    const prevPendingRes = this.pendingResolutionMeters;
    const pendingLevel = this.levelsByResolution.get(prevPendingRes);
    const now = this.nowFn();
    this.recordTransitionCriticalPath({
      outcome: 'cancelled',
      fromResolutionMeters: this.activeResolutionMeters ?? prevPendingRes,
      toResolutionMeters: prevPendingRes,
      pendingLevel: pendingLevel ?? null,
      finishedAtMs: now,
      activationSwapMs: 0,
      cancelOrDeferReason: reason,
    });
    if (pendingLevel) {
      for (const record of pendingLevel.tilesByKey.values()) {
        if (
          record.state === 'queued' ||
          record.state === 'fetching' ||
          record.state === 'retrieved_queued' ||
          record.state === 'decoding' ||
          record.state === 'ready_to_commit'
        ) {
          this.cancelInFlightTile(record);
        } else if (record.state === 'prepared_inactive') {
          this.gpuPreparer.cancelTile(record.tileKey, record.reconstructed, false);
          if (
            record.reconstructed &&
            this.hierarchicalBudget.maxInactiveCachedTiles > 0 &&
            this.hierarchicalBudget.inactiveCacheBudgetBytes > 0
          ) {
            record.state = 'cached_inactive';
            record.lastUsedAtMs = now;
          } else {
            this.discardedPreparedTilesTotal += 1;
            this.disposeReconstructedTile(record, false);
          }
        }
        record.isVisibleInViewport = false;
        record.isInFetchSet = false;
        record.isInKeepSet = false;
      }
    }

    const elapsedMs =
      this.transitionStartedAtMs !== null
        ? Math.max(0, now - this.transitionStartedAtMs)
        : 0;
    const prevGen = this.transitionGeneration;
    this.pendingResolutionMeters = null;
    this.pendingDebounceTargetResolution = null;
    this.pendingDebounceStartedAtMs = null;
    this.currentTransitionDebounceWaitMs = 0;
    this.currentTransitionCancellations = 0;
    this.currentTransitionNewlyRequiredTilesCount = 0;
    this.transitionState = 'idle';
    this.transitionStartedAtMs = null;
    this.budgetDeferralReason = null;
    this.transitionGeneration += 1;
    this.transitionsCancelledTotal += 1;
    this.needsViewportRefresh = true;

    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    if (prof) {
      prof.recordEvent({
        eventType: 'resolution_transition_cancel',
        tileKey: `transition:${this.activeResolutionMeters ?? 0}->${prevPendingRes}`,
        tileSizeMeters: prevPendingRes,
        lod: 0,
        durationMs: elapsedMs,
        queueDepths: this.getQueueDepthSnapshot(),
        detail: {
          reason,
          fromResolutionMeters: this.activeResolutionMeters ?? undefined,
          toResolutionMeters: prevPendingRes,
          transitionGeneration: prevGen,
        },
      });
    }
  }

  private deferPendingTransitionForBudget(reason: string): void {
    if (this.pendingResolutionMeters === null) return;
    const pendingRes = this.pendingResolutionMeters;
    const pendingLevel = this.levelsByResolution.get(pendingRes);
    const now = this.nowFn();
    this.recordTransitionCriticalPath({
      outcome: 'deferred_budget',
      fromResolutionMeters: this.activeResolutionMeters ?? pendingRes,
      toResolutionMeters: pendingRes,
      pendingLevel: pendingLevel ?? null,
      finishedAtMs: now,
      activationSwapMs: 0,
      cancelOrDeferReason: reason,
    });
    if (pendingLevel) {
      for (const record of pendingLevel.tilesByKey.values()) {
        if (
          record.state === 'queued' ||
          record.state === 'fetching' ||
          record.state === 'retrieved_queued' ||
          record.state === 'decoding' ||
          record.state === 'ready_to_commit'
        ) {
          this.cancelInFlightTile(record);
        } else if (record.state === 'prepared_inactive') {
          this.discardedPreparedTilesTotal += 1;
          this.disposeReconstructedTile(record, false, true);
        }
      }
    }
    this.transitionState = 'deferred_budget';
    this.budgetDeferralReason = reason;
    this.lastDeferredViewportSignature = this.currentViewport
      ? this.getViewportSignature(this.currentViewport)
      : null;
    this.lastDeferredBudgetBytes = this.hierarchicalBudget.totalMemoryBudgetBytes;
    this.transitionsDeferredBudgetTotal += 1;

    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    if (prof) {
      prof.recordEvent({
        eventType: 'resolution_transition_defer_budget',
        tileKey: `transition:${this.activeResolutionMeters ?? 0}->${pendingRes}`,
        tileSizeMeters: pendingRes,
        lod: 0,
        queueDepths: this.getQueueDepthSnapshot(),
        detail: {
          reason,
          fromResolutionMeters: this.activeResolutionMeters ?? undefined,
          toResolutionMeters: pendingRes,
          transitionGeneration: this.transitionGeneration,
        },
      });
    }
    this.emitDiagnostics();
    this.checkIdleWaiters();
  }

  private evaluateDesiredResolutionInternal(): boolean {
    if (!this.hierarchy || this.activeResolutionMeters === null) return false;

    const now = this.nowFn();
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    const evalBasisRes =
      this.pendingResolutionMeters ?? this.activeResolutionMeters;
    const evalResult = resolveDesiredHierarchicalResolution({
      availableResolutionsMeters: this.hierarchy.resolutionsMeters,
      currentResolutionMeters: evalBasisRes,
      cameraZoom: this.currentCameraZoom,
      viewportWidthPx: this.currentViewportWidthPx,
      viewportHeightPx: this.currentViewportHeightPx,
      policy: this.hierarchicalPolicy,
    });
    this.lastScaleEval = evalResult;
    const nextDesired = evalResult.desiredResolutionMeters;
    this.desiredResolutionMeters = nextDesired;

    const debounceMs =
      this.hierarchicalPolicy.mode === 'auto'
        ? this.streamingFrameBudget.transitionDebounceMs
        : 0;

    if (nextDesired === this.activeResolutionMeters) {
      if (this.pendingDebounceTargetResolution !== null) {
        const avoidedTarget = this.pendingDebounceTargetResolution;
        const avoidedElapsed =
          this.pendingDebounceStartedAtMs !== null
            ? Math.max(0, now - this.pendingDebounceStartedAtMs)
            : 0;
        this.pendingDebounceTargetResolution = null;
        this.pendingDebounceStartedAtMs = null;
        this.transitionsDebouncedAvoidedTotal += 1;
        if (this.pendingResolutionMeters === null) {
          this.transitionState = 'idle';
        }
        if (prof) {
          prof.recordEvent({
            eventType: 'transition_debounce_avoided',
            tileKey: `debounce:${this.activeResolutionMeters}->${avoidedTarget}`,
            tileSizeMeters: avoidedTarget,
            lod: 0,
            durationMs: avoidedElapsed,
            queueDepths: this.getQueueDepthSnapshot(),
            detail: {
              reason: 'reverted_before_debounce_elapsed',
              fromResolutionMeters: this.activeResolutionMeters,
              toResolutionMeters: avoidedTarget,
            },
          });
        }
      }
      if (this.pendingResolutionMeters !== null) {
        this.cancelPendingTransition('zoom_reversed_to_active');
        this.updatePredictivePrewarmTarget();
        return true;
      }
      this.updatePredictivePrewarmTarget();
      return false;
    }

    if (this.pendingResolutionMeters === nextDesired) {
      // Returned to already-pending destination during a transient dip
      if (this.pendingDebounceTargetResolution !== null) {
        this.pendingDebounceTargetResolution = null;
        this.pendingDebounceStartedAtMs = null;
        this.transitionsDebouncedAvoidedTotal += 1;
      }
      this.prewarmTargetResolutionMeters = null;
      return false;
    }

    // Apply short configurable debounce for automatic zoom-band transitions so transient
    // crossings do not immediately trigger expensive replacement workloads.
    // Never requires camera movement to stop: elapsed time advances during continuous panning/zooming.
    let debounceElapsedMs = 0;
    if (debounceMs > 0) {
      if (this.pendingDebounceTargetResolution !== nextDesired) {
        this.pendingDebounceTargetResolution = nextDesired;
        this.pendingDebounceStartedAtMs = now;
        if (this.pendingResolutionMeters === null) {
          this.transitionState = 'debouncing';
        }
        if (prof) {
          prof.recordEvent({
            eventType: 'transition_debounce_start',
            tileKey: `debounce:${this.activeResolutionMeters}->${nextDesired}`,
            tileSizeMeters: nextDesired,
            lod: 0,
            queueDepths: this.getQueueDepthSnapshot(),
            detail: {
              reason: `debounceMs=${debounceMs}`,
              fromResolutionMeters: this.activeResolutionMeters,
              toResolutionMeters: nextDesired,
            },
          });
        }
        return false;
      }
      debounceElapsedMs =
        this.pendingDebounceStartedAtMs !== null
          ? Math.max(0, now - this.pendingDebounceStartedAtMs)
          : 0;
      if (debounceElapsedMs < debounceMs) {
        if (this.pendingResolutionMeters === null) {
          this.transitionState = 'debouncing';
        }
        return false;
      }
    }

    // Debounce elapsed (or disabled / forced mode): start the transition!
    if (
      this.prewarmTargetResolutionMeters === nextDesired &&
      this.currentPrewarmStartedAtMs !== null
    ) {
      this.lastPreparationLeadTimeMs = Math.max(
        0,
        now - this.currentPrewarmStartedAtMs
      );
    } else {
      this.lastPreparationLeadTimeMs = 0;
    }
    this.pendingDebounceTargetResolution = null;
    this.pendingDebounceStartedAtMs = null;
    this.prewarmTargetResolutionMeters = null;
    this.currentPrewarmStartedAtMs = null;

    if (this.pendingResolutionMeters !== null) {
      this.cancelPendingTransition('retargeted_to_new_resolution');
    }
    this.pendingResolutionMeters = nextDesired;
    this.transitionGeneration += 1;
    this.transitionStartedAtMs = now;
    this.currentTransitionDebounceWaitMs = debounceElapsedMs;
    this.currentTransitionCancellations = 0;
    this.currentTransitionNewlyRequiredTilesCount = 0;
    this.transitionState = 'preparing';
    this.budgetDeferralReason = null;
    this.lastDeferredViewportSignature = null;
    this.lastDeferredBudgetBytes = null;
    this.transitionsStartedTotal += 1;
    this.needsViewportRefresh = true;

    if (prof) {
      prof.recordEvent({
        eventType: 'resolution_transition_start',
        tileKey: `transition:${this.activeResolutionMeters}->${nextDesired}`,
        tileSizeMeters: nextDesired,
        lod: 0,
        queueDepths: this.getQueueDepthSnapshot(),
        detail: {
          reason: evalResult.reason,
          fromResolutionMeters: this.activeResolutionMeters,
          toResolutionMeters: nextDesired,
          transitionGeneration: this.transitionGeneration,
        },
      });
    }
    return true;
  }

  private getPrewarmLevelState(): ResolutionLevelState | null {
    if (
      !this.hierarchy ||
      this.prewarmTargetResolutionMeters === null ||
      this.pendingResolutionMeters !== null
    ) {
      return null;
    }
    return this.levelsByResolution.get(this.prewarmTargetResolutionMeters) ?? null;
  }

  private updatePredictivePrewarmTarget(): void {
    if (
      !this.hierarchy ||
      this.activeResolutionMeters === null ||
      this.pendingResolutionMeters !== null ||
      !this.streamingFrameBudget.predictivePrewarmEnabled ||
      this.hierarchicalPolicy.mode !== 'auto'
    ) {
      this.prewarmTargetResolutionMeters = null;
      this.currentPrewarmStartedAtMs = null;
      this.lastAdaptivePrewarmEval = null;
      return;
    }

    // Never prewarm when active viewport has missing visible coverage or tight memory headroom
    if (this.hasActiveVisibleCoverageGap() || this.speculativeBackpressureActive) {
      this.prewarmTargetResolutionMeters = null;
      this.currentPrewarmStartedAtMs = null;
      return;
    }

    const totalMeasured = this.computeTotalMeasuredMemoryBytes();
    const headroomRatio =
      this.hierarchicalBudget.totalMemoryBudgetBytes > 0
        ? Math.max(
            0,
            (this.hierarchicalBudget.totalMemoryBudgetBytes - totalMeasured) /
              this.hierarchicalBudget.totalMemoryBudgetBytes
          )
        : 0;
    if (headroomRatio < this.streamingFrameBudget.predictivePrewarmMinHeadroomRatio) {
      this.prewarmTargetResolutionMeters = null;
      this.currentPrewarmStartedAtMs = null;
      return;
    }

    let nextPrewarmTarget: number | null = null;
    if (this.streamingFrameBudget.adaptivePrewarmHorizonEnabled) {
      const queueOccupancyWaitMs =
        this.decodeClient.getQueuedDecodeCount() * 90 +
        this.activeFetchCount * 25;
      const adaptiveEval = evaluateAdaptivePrewarmHorizon({
        availableResolutionsMeters: this.hierarchy.resolutionsMeters,
        activeResolutionMeters: this.activeResolutionMeters,
        cameraZoom: this.currentCameraZoom,
        viewportWidthPx: this.currentViewportWidthPx,
        policy: this.hierarchicalPolicy,
        bandFraction: this.streamingFrameBudget.predictivePrewarmBandFraction,
        zoomTrend: this.zoomTrend,
        scaleVelocityPerSec: this.scaleVelocityPerSec,
        historicalPrepLatencyMs: this.historicalPrepLatencyByResMs,
        queueBacklogMs: queueOccupancyWaitMs,
        leadMultiplier: this.streamingFrameBudget.adaptivePrewarmLeadMultiplier,
      });
      this.lastAdaptivePrewarmEval = adaptiveEval;
      nextPrewarmTarget = adaptiveEval.targetResolutionMeters;
    } else {
      const res = resolveApproachingResolutionForPrewarm({
        availableResolutionsMeters: this.hierarchy.resolutionsMeters,
        activeResolutionMeters: this.activeResolutionMeters,
        cameraZoom: this.currentCameraZoom,
        viewportWidthPx: this.currentViewportWidthPx,
        policy: this.hierarchicalPolicy,
        bandFraction: this.streamingFrameBudget.predictivePrewarmBandFraction,
        zoomTrend: this.zoomTrend,
      });
      this.lastAdaptivePrewarmEval = {
        targetResolutionMeters: res.targetResolutionMeters,
        reason: res.reason,
        estimatedTimeToThresholdMs: null,
        requiredLeadTimeMs: null,
        distanceToThresholdScale: null,
        triggeredByVelocityHorizon: false,
      };
      nextPrewarmTarget = res.targetResolutionMeters;
    }

    if (nextPrewarmTarget !== null) {
      if (this.prewarmTargetResolutionMeters !== nextPrewarmTarget) {
        this.currentPrewarmStartedAtMs = this.nowFn();
      }
      this.prewarmTargetResolutionMeters = nextPrewarmTarget;
    } else {
      this.prewarmTargetResolutionMeters = null;
      this.currentPrewarmStartedAtMs = null;
    }
  }

  private computeTotalMeasuredMemoryBytes(): number {
    let total = this.deferredDisposalQueue.totalPendingBytes;
    for (const record of this.tilesByKey.values()) {
      total += this.computeRecordFootprintBreakdown(record).totalMeasuredBytes;
    }
    return total;
  }

  private hasActiveVisibleCoverageGap(): boolean {
    const activeLevel = this.getActiveLevelState();
    const records = activeLevel ? activeLevel.tilesByKey : this.tilesByKey;
    for (const record of records.values()) {
      if (!record.isVisibleInViewport) continue;
      if (record.manifest.isEmpty) continue;
      if (record.state !== 'loaded' || record.reconstructed === null) {
        return true;
      }
    }
    return false;
  }

  private evaluateLevelForViewport(
    level: ResolutionLevelState,
    viewport: TileViewportGroundBounds,
    isPendingDestination: boolean,
    leadFocusX: number,
    leadFocusZ: number,
    prof: StreamingProfiler | null,
    isPredictivePrewarm = false
  ): {
    anyEvictedOrCancelled: boolean;
    anyAttachedFromCache: boolean;
    cancelInFlightMs: number;
    evictDisposeMs: number;
    tilesEvictedCount: number;
    tilesCancelledCount: number;
  } {
    const tileSize = level.tileSizeMeters;
    let fetchMarginMeters: number;
    let keepMarginMeters: number;
    if (isPredictivePrewarm) {
      // Predictive pre-warming prepares visible tiles (plus predicted horizon coverage when adaptive horizon is enabled)
      fetchMarginMeters = 0;
      keepMarginMeters = Math.min(tileSize, this.hierarchicalPolicy.retainMarginMeters);
    } else if (this.hierarchy) {
      const margins = resolvePhysicalMarginsForResolution(
        tileSize,
        this.hierarchicalPolicy
      );
      fetchMarginMeters = margins.preloadMarginMeters;
      keepMarginMeters = margins.retainMarginMeters;
    } else {
      fetchMarginMeters = this.preloadMarginTiles * tileSize;
      keepMarginMeters = this.retainMarginTiles * tileSize;
    }

    const fetchMinX = viewport.minX - fetchMarginMeters;
    const fetchMaxX = viewport.maxX + fetchMarginMeters;
    const fetchMinZ = viewport.minZ - fetchMarginMeters;
    const fetchMaxZ = viewport.maxZ + fetchMarginMeters;

    const keepMinX = viewport.minX - keepMarginMeters;
    const keepMaxX = viewport.maxX + keepMarginMeters;
    const keepMinZ = viewport.minZ - keepMarginMeters;
    const keepMaxZ = viewport.maxZ + keepMarginMeters;

    // Work Package E: Predict viewport bounds at estimated activation horizon so destination
    // or prewarm tiles moving into view get prioritized ahead of trailing tiles.
    const usePredictedViewport =
      this.streamingFrameBudget.adaptivePrewarmHorizonEnabled &&
      (isPendingDestination || isPredictivePrewarm);
    const estHorizonMs = usePredictedViewport
      ? (this.historicalPrepLatencyByResMs[tileSize] ?? 850)
      : 0;
    const predictedBounds = usePredictedViewport
      ? predictViewportBoundsAtHorizon({
          currentBounds: {
            minX: viewport.minX,
            maxX: viewport.maxX,
            minZ: viewport.minZ,
            maxZ: viewport.maxZ,
            centerX: (viewport.minX + viewport.maxX) * 0.5,
            centerZ: (viewport.minZ + viewport.maxZ) * 0.5,
          },
          panVelocityXPerSec: this.panVelocityXPerSec,
          panVelocityZPerSec: this.panVelocityZPerSec,
          horizonSeconds: estHorizonMs / 1000,
        })
      : null;

    // Work Package C: Tail-tile awareness for pending destination transitions
    let unreadyVisibleDestinationCount = 0;
    let totalVisibleDestinationCount = 0;
    if (isPendingDestination && this.streamingFrameBudget.tailTilePriorityBoostEnabled) {
      const requireGpu = this.isIncrementalGpuPrepActive();
      for (const rec of level.tilesByKey.values()) {
        const ob = rec.overhangWorldBounds;
        const vis = aabbIntersects2D(
          ob.minX,
          ob.maxX,
          ob.minZ,
          ob.maxZ,
          viewport.minX,
          viewport.maxX,
          viewport.minZ,
          viewport.maxZ
        );
        if (!vis) continue;
        totalVisibleDestinationCount += 1;
        if (rec.manifest.isEmpty) continue;
        const cpuReady =
          (rec.state === 'prepared_inactive' ||
            rec.state === 'cached_inactive' ||
            rec.state === 'loaded') &&
          rec.reconstructed !== null;
        const gpuReady =
          cpuReady && (!requireGpu || this.gpuPreparer.isTilePrepared(rec.reconstructed!));
        if (!gpuReady) {
          unreadyVisibleDestinationCount += 1;
        }
      }
    }
    const isTailPhase =
      isPendingDestination &&
      this.streamingFrameBudget.tailTilePriorityBoostEnabled &&
      unreadyVisibleDestinationCount > 0 &&
      (unreadyVisibleDestinationCount <= 2 ||
        unreadyVisibleDestinationCount <= Math.ceil(totalVisibleDestinationCount * 0.5));

    let anyEvictedOrCancelled = false;
    let anyAttachedFromCache = false;
    let cancelInFlightMs = 0;
    let evictDisposeMs = 0;
    let tilesEvictedCount = 0;
    let tilesCancelledCount = 0;
    const now = this.nowFn();

    for (const record of level.tilesByKey.values()) {
      const wb = record.worldBounds;
      const ob = record.overhangWorldBounds;

      const isVisible = aabbIntersects2D(
        ob.minX,
        ob.maxX,
        ob.minZ,
        ob.maxZ,
        viewport.minX,
        viewport.maxX,
        viewport.minZ,
        viewport.maxZ
      );
      const intersectsPredicted =
        predictedBounds !== null &&
        aabbIntersects2D(
          ob.minX,
          ob.maxX,
          ob.minZ,
          ob.maxZ,
          predictedBounds.minX,
          predictedBounds.maxX,
          predictedBounds.minZ,
          predictedBounds.maxZ
        );
      const isInFetch = isPredictivePrewarm
        ? isVisible || intersectsPredicted
        : isVisible ||
          aabbIntersects2D(
            wb.minX,
            wb.maxX,
            wb.minZ,
            wb.maxZ,
            fetchMinX,
            fetchMaxX,
            fetchMinZ,
            fetchMaxZ
          );
      const isInKeep =
        isInFetch ||
        aabbIntersects2D(
          wb.minX,
          wb.maxX,
          wb.minZ,
          wb.maxZ,
          keepMinX,
          keepMaxX,
          keepMinZ,
          keepMaxZ
        );

      record.isVisibleInViewport = isVisible;
      record.isInFetchSet = isInFetch;
      record.isInKeepSet = isInKeep;

      const distToFocus = Math.hypot(
        wb.centerX - leadFocusX,
        wb.centerZ - leadFocusZ
      );

      const prevPriority = record.priorityScore;
      if (this.hierarchy) {
        // Work Package C 5-tier priority model:
        // 1. Missing active visible coverage (-4,000,000)
        // 2. Required pending destination coverage (-3,000,000, escalated with age & tail phase)
        // 3. Approaching-resolution prewarm coverage (-2,400,000 when adaptive/fairness enabled, else -500,000)
        // 4. Active preload coverage (-2,000,000)
        // 5. Speculative destination preload (-1,000,000)
        let tierOffset: number;
        if (isPredictivePrewarm) {
          tierOffset = this.streamingFrameBudget.reservedDestinationFetchSlots > 0
            ? -2_400_000
            : -500_000;
        } else if (isPendingDestination) {
          tierOffset = isVisible ? -3_000_000 : -1_000_000;
        } else {
          tierOffset = isVisible ? -4_000_000 : -2_000_000;
        }

        let dynamicBoost = 0;
        if (intersectsPredicted) {
          dynamicBoost -= 150_000;
        }
        if (isPendingDestination && isVisible) {
          if (isTailPhase) {
            dynamicBoost -= 250_000;
          }
          const ageStart =
            record.pipeline.queuedAtMs ??
            this.transitionStartedAtMs ??
            now;
          const ageMs = Math.max(0, now - ageStart);
          const escStep = Math.max(100, this.streamingFrameBudget.destinationAgeEscalationMs);
          const steps = Math.min(12, Math.floor(ageMs / escStep));
          dynamicBoost -= steps * 60_000;
        }
        record.priorityScore = tierOffset + dynamicBoost + distToFocus;
      } else {
        // Visible tiles get a -1,000,000 priority boost so they always load before preload margin tiles
        record.priorityScore = (isVisible ? -1_000_000 : 0) + distToFocus;
      }

      // Work Package C: Dynamically reprioritize queued worker jobs when camera movement changes relevance
      if (
        isInKeep &&
        this.streamingFrameBudget.dynamicQueueReprioritizationEnabled &&
        Math.abs(record.priorityScore - prevPriority) > 1 &&
        (record.state === 'queued' ||
          record.state === 'retrieved_queued' ||
          record.state === 'decoding')
      ) {
        this.dynamicReprioritizationsTotal += 1;
        if (
          record.state === 'decoding' &&
          typeof this.decodeClient.updateJobPriority === 'function'
        ) {
          this.decodeClient.updateJobPriority(
            record.tileKey,
            record.priorityScore,
            isPendingDestination && isVisible
          );
        }
      }

      if (!isInKeep) {
        // Cancel any queued, fetching, retrieved_queued, decoding, or uncommitted tile outside keepSet
        if (
          record.state === 'queued' ||
          record.state === 'fetching' ||
          record.state === 'retrieved_queued' ||
          record.state === 'decoding' ||
          record.state === 'ready_to_commit'
        ) {
          // Work Package C: If a worker decode is already running on a worker thread and memory permits,
          // allow it to finish into cached_inactive instead of wasting worker CPU and network bytes.
          if (
            record.state === 'decoding' &&
            this.hierarchy !== null &&
            this.streamingFrameBudget.retainRunningWorkerJobOnDemotion &&
            !this.speculativeBackpressureActive &&
            this.hierarchicalBudget.maxInactiveCachedTiles > 0 &&
            this.hierarchicalBudget.inactiveCacheBudgetBytes > 0
          ) {
            // Keep running; decode completion handler will see !record.isInKeepSet and retain or cache.
          } else {
            const tCancel0 = prof ? performance.now() : 0;
            this.cancelInFlightTile(record);
            if (prof) {
              cancelInFlightMs += performance.now() - tCancel0;
              tilesCancelledCount += 1;
            }
            anyEvictedOrCancelled = true;
          }
        } else if (record.state === 'loaded') {
          const tEvict0 = prof ? performance.now() : 0;
          if (
            this.hierarchy &&
            record.reconstructed &&
            this.hierarchicalBudget.maxInactiveCachedTiles > 0 &&
            this.hierarchicalBudget.inactiveCacheBudgetBytes > 0
          ) {
            this.gpuPreparer.markTilePreparedByMainRender(
              record.tileKey,
              record.reconstructed
            );
            this.detachTileFromCompositeScene(record);
            record.state = 'cached_inactive';
            record.lastUsedAtMs = now;
          } else {
            this.evictLoadedTile(record);
            tilesEvictedCount += 1;
          }
          if (prof) {
            evictDisposeMs += performance.now() - tEvict0;
          }
          anyEvictedOrCancelled = true;
        } else if (record.state === 'prepared_inactive') {
          this.gpuPreparer.cancelTile(record.tileKey, record.reconstructed, false);
          if (
            record.reconstructed &&
            this.hierarchicalBudget.maxInactiveCachedTiles > 0 &&
            this.hierarchicalBudget.inactiveCacheBudgetBytes > 0
          ) {
            record.state = 'cached_inactive';
            record.lastUsedAtMs = now;
          } else {
            this.discardedPreparedTilesTotal += 1;
            this.disposeReconstructedTile(record, false);
            tilesEvictedCount += 1;
          }
          anyEvictedOrCancelled = true;
        }
      } else if (!isInFetch && record.state === 'queued') {
        // Tile drifted from fetchSet into hysteresis keep-only band before fetch even started
        const tCancel0 = prof ? performance.now() : 0;
        this.cancelInFlightTile(record);
        if (prof) {
          cancelInFlightMs += performance.now() - tCancel0;
          tilesCancelledCount += 1;
        }
        anyEvictedOrCancelled = true;
      }

      if (isInFetch) {
        if (record.state === 'cached_inactive' && record.reconstructed) {
          this.cacheHitsTotal += 1;
          record.lastUsedAtMs = now;
          record.pipeline.reusedFromCache = true;
          if (isPendingDestination || isPredictivePrewarm) {
            // Keep detached until atomic frame-boundary activation!
            record.state = 'prepared_inactive';
            if (
              !this.isIncrementalGpuPrepActive() ||
              this.gpuPreparer.isTilePrepared(record.reconstructed)
            ) {
              record.pipeline.readyAtMs = now;
            }
            if (isPendingDestination && this.streamingFrameBudget.reuseDestinationPreparation) {
              this.destinationPrepReusedTotal += 1;
            }
            if (isPendingDestination && record.pipeline.preparedByPrewarm) {
              this.prewarmReusedOnTransitionTotal += 1;
            }
          } else {
            record.reconstructed.scene.updateCameraZoom?.(this.currentCameraZoom);
            record.reconstructed.applyFoliageRuntimeState(this.foliageRuntimeState);
            record.state = 'loaded';
            this.attachTileToCompositeScene(record);
            anyAttachedFromCache = true;
          }
          if (prof) {
            prof.recordEvent({
              eventType: 'cache_hit',
              tileKey: record.tileKey,
              tileSizeMeters: record.resolutionMeters,
              lod: record.manifest.lod,
              queueDepths: this.getQueueDepthSnapshot(),
              detail: {
                reason: isPendingDestination
                  ? 'pending_destination_cache_hit'
                  : isPredictivePrewarm
                    ? 'prewarm_cache_hit'
                    : 'active_reentry_cache_hit',
              },
            });
          }
        } else if (
          isPendingDestination &&
          record.state === 'prepared_inactive' &&
          record.reconstructed &&
          this.streamingFrameBudget.reuseDestinationPreparation
        ) {
          // Reuse already-reconstructed (and possibly already GPU-prepared / prewarmed) destination work
          record.lastUsedAtMs = now;
          if (isVisible) {
            this.destinationPrepReusedTotal += 1;
            if (record.pipeline.preparedByPrewarm) {
              this.prewarmReusedOnTransitionTotal += 1;
            }
          }
          if (
            record.pipeline.readyAtMs === null &&
            (!this.isIncrementalGpuPrepActive() ||
              this.gpuPreparer.isTilePrepared(record.reconstructed))
          ) {
            record.pipeline.readyAtMs = now;
          }
        } else if (record.state === 'unloaded' || record.state === 'error') {
          if (
            isPendingDestination &&
            this.transitionState === 'deferred_budget'
          ) {
            // Do not re-queue pending tiles while deferred due to budget limits.
          } else if (
            (isPendingDestination && !isVisible && this.speculativeBackpressureActive) ||
            (isPredictivePrewarm && this.speculativeBackpressureActive)
          ) {
            // Suppress speculative pending preload / prewarm when budget reserve is tight.
          } else {
            record.state = 'queued';
            record.lastError = null;
            record.pipeline = createEmptyTilePipelineTimings();
            record.pipeline.queuedAtMs = now;
            if (
              isPendingDestination &&
              isVisible &&
              this.transitionStartedAtMs !== null &&
              now > this.transitionStartedAtMs + 1
            ) {
              record.pipeline.enteredDuringActiveTransitionAtMs = now;
              this.currentTransitionNewlyRequiredTilesCount += 1;
            }
          }
        } else if (
          record.state === 'fetching' ||
          record.state === 'retrieved_queued' ||
          record.state === 'decoding' ||
          record.state === 'ready_to_commit'
        ) {
          this.duplicateRequestsSkippedTotal += 1;
        }
      }
    }

    return {
      anyEvictedOrCancelled,
      anyAttachedFromCache,
      cancelInFlightMs,
      evictDisposeMs,
      tilesEvictedCount,
      tilesCancelledCount,
    };
  }

  /**
   * Re-evaluates visible, preload (`fetchSet`), and retention (`keepSet`) tiles
   * for the given ground-plane viewport bounds, cancels obsolete in-flight fetches,
   * evicts distant loaded tiles, and schedules high-priority tile loads.
   */
  updateViewport(viewport: TileViewportGroundBounds): void {
    if (this.isDisposed || !this.metadata) return;
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    const tTotal0 = prof ? performance.now() : 0;
    const now = this.nowFn();

    this.currentViewport = viewport;
    if (viewport.viewportWidthPx !== undefined) {
      this.currentViewportWidthPx = viewport.viewportWidthPx;
    }
    if (viewport.viewportHeightPx !== undefined) {
      this.currentViewportHeightPx = viewport.viewportHeightPx;
    }
    this.needsViewportRefresh = false;
    this.viewportSelectionPasses++;

    if (
      this.hierarchy &&
      viewport.cameraZoom !== undefined &&
      Number.isFinite(viewport.cameraZoom) &&
      viewport.cameraZoom > 0 &&
      viewport.cameraZoom !== this.currentCameraZoom
    ) {
      this.applyCameraZoomWithoutResolutionEval(viewport.cameraZoom);
    }

    if (this.hierarchy) {
      if (this.transitionState === 'deferred_budget') {
        const sig = this.getViewportSignature(viewport);
        if (
          sig !== this.lastDeferredViewportSignature ||
          this.hierarchicalBudget.totalMemoryBudgetBytes !==
            this.lastDeferredBudgetBytes
        ) {
          this.transitionState = 'preparing';
          this.budgetDeferralReason = null;
        }
      }
      this.evaluateDesiredResolutionInternal();
    }

    const tScan0 = prof ? performance.now() : 0;
    if (this.previousFocus) {
      const dx = viewport.focusX - this.previousFocus.x;
      const dz = viewport.focusZ - this.previousFocus.z;
      const dtSec =
        this.lastFocusSampleAtMs !== null
          ? Math.max(0.004, (now - this.lastFocusSampleAtMs) / 1000)
          : 0.016;
      const instVx = dx / dtSec;
      const instVz = dz / dtSec;
      this.panVelocityXPerSec = this.panVelocityXPerSec * 0.6 + instVx * 0.4;
      this.panVelocityZPerSec = this.panVelocityZPerSec * 0.6 + instVz * 0.4;
      const len = Math.hypot(dx, dz);
      if (len > 1.0) {
        const scale = Math.min(len, this.metadata.tileSizeMeters * 0.5) / len;
        this.panLeadVector = { x: dx * scale, z: dz * scale };
      } else {
        this.panLeadVector = { x: 0, z: 0 };
      }
    }
    this.previousFocus = { x: viewport.focusX, z: viewport.focusZ };
    this.lastFocusSampleAtMs = now;

    const leadFocusX = viewport.focusX + this.panLeadVector.x;
    const leadFocusZ = viewport.focusZ + this.panLeadVector.z;

    let anyEvictedOrCancelled = false;
    let anyAttachedFromCache = false;
    let cancelInFlightMs = 0;
    let evictDisposeMs = 0;
    let tilesEvictedCount = 0;
    let tilesCancelledCount = 0;

    const activeLevel = this.getActiveLevelState();
    if (activeLevel) {
      const activeRes = this.evaluateLevelForViewport(
        activeLevel,
        viewport,
        false,
        leadFocusX,
        leadFocusZ,
        prof
      );
      anyEvictedOrCancelled =
        anyEvictedOrCancelled || activeRes.anyEvictedOrCancelled;
      anyAttachedFromCache =
        anyAttachedFromCache || activeRes.anyAttachedFromCache;
      cancelInFlightMs += activeRes.cancelInFlightMs;
      evictDisposeMs += activeRes.evictDisposeMs;
      tilesEvictedCount += activeRes.tilesEvictedCount;
      tilesCancelledCount += activeRes.tilesCancelledCount;
    }

    if (this.hierarchy) {
      const pendingLevel = this.getPendingLevelState();
      if (pendingLevel && this.transitionState !== 'deferred_budget') {
        const pendingRes = this.evaluateLevelForViewport(
          pendingLevel,
          viewport,
          true,
          leadFocusX,
          leadFocusZ,
          prof,
          false
        );
        anyEvictedOrCancelled =
          anyEvictedOrCancelled || pendingRes.anyEvictedOrCancelled;
        cancelInFlightMs += pendingRes.cancelInFlightMs;
        evictDisposeMs += pendingRes.evictDisposeMs;
        tilesEvictedCount += pendingRes.tilesEvictedCount;
        tilesCancelledCount += pendingRes.tilesCancelledCount;
      }

      const prewarmLevel = this.getPrewarmLevelState();
      if (prewarmLevel) {
        const prewarmRes = this.evaluateLevelForViewport(
          prewarmLevel,
          viewport,
          false,
          leadFocusX,
          leadFocusZ,
          prof,
          true
        );
        anyEvictedOrCancelled =
          anyEvictedOrCancelled || prewarmRes.anyEvictedOrCancelled;
        cancelInFlightMs += prewarmRes.cancelInFlightMs;
        evictDisposeMs += prewarmRes.evictDisposeMs;
        tilesEvictedCount += prewarmRes.tilesEvictedCount;
        tilesCancelledCount += prewarmRes.tilesCancelledCount;
      }

      // Ensure idle non-active, non-pending, non-prewarm levels have no stale in-flight work.
      for (const [resMeters, level] of this.levelsByResolution.entries()) {
        if (
          resMeters === this.activeResolutionMeters ||
          resMeters === this.pendingResolutionMeters ||
          resMeters === this.prewarmTargetResolutionMeters
        ) {
          continue;
        }
        for (const record of level.tilesByKey.values()) {
          if (
            record.state === 'queued' ||
            record.state === 'fetching' ||
            record.state === 'retrieved_queued' ||
            record.state === 'decoding' ||
            record.state === 'ready_to_commit'
          ) {
            this.cancelInFlightTile(record);
            anyEvictedOrCancelled = true;
          } else if (record.state === 'prepared_inactive') {
            if (
              record.pipeline.preparedByPrewarm &&
              !this.streamingFrameBudget.retainPrewarmAcrossReversals
            ) {
              const fp = record.decodedFootprint;
              this.wastedPrewarmBytes += fp ? fp.cpuGeometryBytes + fp.bvhBytes : 0;
              this.discardedPreparedTilesTotal += 1;
              this.disposeReconstructedTile(record, false);
            } else {
              record.state = 'cached_inactive';
              record.lastUsedAtMs = this.nowFn();
            }
          }
          record.isVisibleInViewport = false;
          record.isInFetchSet = false;
          record.isInKeepSet = false;
        }
      }

      this.enforceResourceBudgets();

      if (
        pendingLevel &&
        this.pendingResolutionMeters !== null &&
        this.transitionState !== 'deferred_budget'
      ) {
        const readiness = this.checkDestinationReadiness(pendingLevel);
        this.transitionState = readiness.allReady
          ? 'ready_to_activate'
          : 'preparing';
      }
    }

    const rawScanAndActionMs = prof ? performance.now() - tScan0 : 0;
    const tileScanMs = prof
      ? Math.max(0, rawScanAndActionMs - cancelInFlightMs - evictDisposeMs)
      : 0;

    const tPump0 = prof ? performance.now() : 0;
    this.pumpFetchQueue();
    const pumpFetchQueueMs = prof ? performance.now() - tPump0 : 0;

    this.updatePeakTileCounters();
    let evictRebuildStatsMs = 0;
    let evictEmitDiagnosticsMs = 0;
    if (anyEvictedOrCancelled || anyAttachedFromCache) {
      const tStats0 = prof ? performance.now() : 0;
      this.rebuildCompositeStats();
      if (prof) evictRebuildStatsMs = performance.now() - tStats0;

      const tDiag0 = prof ? performance.now() : 0;
      this.emitDiagnostics();
      if (prof) evictEmitDiagnosticsMs = performance.now() - tDiag0;
    }
    this.checkIdleWaiters();

    if (prof) {
      prof.recordViewportUpdate({
        totalMs: performance.now() - tTotal0,
        tileScanMs,
        cancelInFlightMs,
        evictDisposeMs,
        evictRebuildStatsMs,
        evictEmitDiagnosticsMs,
        pumpFetchQueueMs,
        tilesEvictedCount,
        tilesCancelledCount,
      });
    }
  }

  private isIncrementalGpuPrepActive(): boolean {
    return (
      this.streamingFrameBudget.incrementalGpuPrepEnabled &&
      this.gpuPreparer.hasAdapter &&
      !this.gpuPreparer.isContextLost
    );
  }

  private checkDestinationReadiness(pendingLevel: ResolutionLevelState): {
    requiredCount: number;
    readyCount: number;
    gpuPreparedCount: number;
    allReady: boolean;
  } {
    const requireGpuPrep = this.isIncrementalGpuPrepActive();
    let requiredCount = 0;
    let readyCount = 0;
    let gpuPreparedCount = 0;
    for (const record of pendingLevel.tilesByKey.values()) {
      if (!record.isVisibleInViewport) continue;
      requiredCount += 1;
      // Only fully reconstructed tiles (`prepared_inactive`, `cached_inactive`, `loaded` with reconstructed scene)
      // or explicitly empty manifest tiles satisfy CPU destination readiness.
      if (record.manifest.isEmpty) {
        readyCount += 1;
        gpuPreparedCount += 1;
        continue;
      }
      const isCpuReady =
        (record.state === 'prepared_inactive' ||
          record.state === 'cached_inactive' ||
          record.state === 'loaded') &&
        record.reconstructed !== null;
      if (!isCpuReady) continue;

      const isGpuReady =
        !requireGpuPrep || this.gpuPreparer.isTilePrepared(record.reconstructed!);
      if (isGpuReady) {
        gpuPreparedCount += 1;
        readyCount += 1;
      }
    }
    return {
      requiredCount,
      readyCount,
      gpuPreparedCount,
      allReady: readyCount === requiredCount,
    };
  }

  private activatePendingResolutionAtomic(): {
    swapMs: number;
    boundaryOverlayRebuildMs: number;
  } {
    if (
      !this.hierarchy ||
      this.activeResolutionMeters === null ||
      this.pendingResolutionMeters === null
    ) {
      return { swapMs: 0, boundaryOverlayRebuildMs: 0 };
    }
    const oldRes = this.activeResolutionMeters;
    const newRes = this.pendingResolutionMeters;
    const oldLevel = this.levelsByResolution.get(oldRes);
    const newLevel = this.levelsByResolution.get(newRes);
    if (!oldLevel || !newLevel) {
      return { swapMs: 0, boundaryOverlayRebuildMs: 0 };
    }

    const tAct0 = this.nowFn();
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;

    // 1. Detach every tile of the outgoing active resolution (zero simultaneous overlap!)
    for (const record of oldLevel.tilesByKey.values()) {
      if (
        record.state === 'queued' ||
        record.state === 'fetching' ||
        record.state === 'retrieved_queued' ||
        record.state === 'decoding' ||
        record.state === 'ready_to_commit'
      ) {
        this.cancelInFlightTile(record);
      } else if (record.state === 'loaded') {
        if (record.reconstructed) {
          this.gpuPreparer.markTilePreparedByMainRender(
            record.tileKey,
            record.reconstructed
          );
        }
        this.detachTileFromCompositeScene(record);
        if (
          record.reconstructed &&
          this.hierarchicalBudget.maxInactiveCachedTiles > 0 &&
          this.hierarchicalBudget.inactiveCacheBudgetBytes > 0
        ) {
          record.state = 'cached_inactive';
          record.lastUsedAtMs = tAct0;
        } else {
          this.disposeReconstructedTile(record, false);
        }
      }
      record.isVisibleInViewport = false;
      record.isInFetchSet = false;
      record.isInKeepSet = false;
    }

    // 2. Attach all prepared/cached tiles of the incoming destination resolution in keepSet
    for (const record of newLevel.tilesByKey.values()) {
      if (
        (record.state === 'prepared_inactive' ||
          record.state === 'cached_inactive') &&
        record.reconstructed !== null
      ) {
        if (record.isInKeepSet) {
          if (record.pipeline.preparedByPrewarm) {
            this.prewarmedTilesActivatedTotal += 1;
          }
          record.reconstructed.scene.updateCameraZoom?.(this.currentCameraZoom);
          record.reconstructed.applyFoliageRuntimeState(this.foliageRuntimeState);
          record.state = 'loaded';
          record.lastUsedAtMs = tAct0;
          this.attachTileToCompositeScene(record);
          if (prof) {
            const fp = record.decodedFootprint;
            const rawBytes = fp ? fp.cpuGeometryBytes + fp.bvhBytes : null;
            const attachNowMs = this.nowFn();
            prof.recordEvent({
              eventType: 'attach',
              tileKey: record.tileKey,
              tileSizeMeters: record.resolutionMeters,
              lod: record.manifest.lod,
              timestampMs: attachNowMs,
              payloadCompressedBytes: record.lastCompressedBytes ?? null,
              payloadRawBytes: rawBytes,
              queueDepths: this.getQueueDepthSnapshot(),
              detail: {
                reason: 'atomic_resolution_activation',
                meshCount: fp?.meshCount,
                triangleCount: fp?.triangleCount,
              },
            });
            prof.markTilePendingFirstRender({
              tileKey: record.tileKey,
              tileSizeMeters: record.resolutionMeters,
              lod: record.manifest.lod,
              triangles: record.reconstructed.scene.stats.totalTriangles,
              meshes: fp?.meshCount ?? 0,
              compressedBytes: record.lastCompressedBytes ?? null,
              rawBytes,
              attachTimestampMs: attachNowMs,
            });
          }
        } else {
          record.state = 'cached_inactive';
          record.lastUsedAtMs = tAct0;
        }
      }
    }

    // 3. Commit new active resolution state, metadata, and tile boundary overlay
    const elapsedTotalMs =
      this.transitionStartedAtMs !== null
        ? Math.max(0, this.nowFn() - this.transitionStartedAtMs)
        : 0;
    const completedGen = this.transitionGeneration;
    this.activeResolutionMeters = newRes;
    this.pendingResolutionMeters = null;
    this.pendingDebounceTargetResolution = null;
    this.pendingDebounceStartedAtMs = null;
    this.transitionState = 'idle';
    this.transitionStartedAtMs = null;
    this.budgetDeferralReason = null;
    this.lastDeferredViewportSignature = null;
    this.lastDeferredBudgetBytes = null;
    this.metadata = newLevel.metadata;

    let boundaryOverlayRebuildMs = 0;
    if (
      this.streamingFrameBudget.deferHiddenBoundaryOverlayRebuild &&
      !this.boundaryOverlayVisible
    ) {
      this.boundaryOverlayDirty = true;
    } else {
      boundaryOverlayRebuildMs = this.rebuildBoundaryOverlayFromManifest(
        newLevel.metadata,
        newLevel.tilesByKey
      );
    }
    this.lastActivationBoundaryOverlayRebuildMs = boundaryOverlayRebuildMs;

    if (this.currentWireframe) {
      this.materialRegistry.setWireframe(true);
    }
    this.rebuildCompositeStats();

    // 4. Enforce LRU cache and total memory budgets after swap
    this.enforceResourceBudgets();

    const swapMs = Math.max(0, this.nowFn() - tAct0);
    const finishedAtMs = this.nowFn();
    this.recordTransitionCriticalPath({
      outcome: 'completed',
      fromResolutionMeters: oldRes,
      toResolutionMeters: newRes,
      pendingLevel: newLevel,
      finishedAtMs,
      activationSwapMs: swapMs,
      cancelOrDeferReason: null,
      overrideGeneration: completedGen,
      overrideStartedAtMs:
        this.transitionStartedAtMs ?? Math.max(0, finishedAtMs - elapsedTotalMs),
    });

    this.transitionsCompletedTotal += 1;
    this.lastTransitionTotalMs = elapsedTotalMs;
    this.lastActivationSwapMs = swapMs;
    this.maxActivationSwapMs = Math.max(this.maxActivationSwapMs, swapMs);
    pushBoundedSample(this.activationSwapMsRing, swapMs);
    pushBoundedSample(this.transitionDurationMsRing, elapsedTotalMs);
    this.currentTransitionDebounceWaitMs = 0;
    this.currentTransitionCancellations = 0;
    this.currentTransitionNewlyRequiredTilesCount = 0;

    if (prof) {
      prof.recordEvent({
        eventType: 'resolution_transition_activate',
        tileKey: `transition:${oldRes}->${newRes}`,
        tileSizeMeters: newRes,
        lod: 0,
        durationMs: swapMs,
        queueDepths: this.getQueueDepthSnapshot(),
        detail: {
          fromResolutionMeters: oldRes,
          toResolutionMeters: newRes,
          transitionGeneration: completedGen,
          activationDurationMs: Number(swapMs.toFixed(3)),
          reason: `totalTransitionMs=${elapsedTotalMs.toFixed(2)}`,
        },
      });
    }

    this.updatePeakTileCounters();
    this.emitDiagnostics();
    return { swapMs, boundaryOverlayRebuildMs };
  }

  private commitSingleReadyTile(
    record: ManagedTileRecord,
    prof: StreamingProfiler | null,
    accum: {
      committed: number;
      committedActive: number;
      totalReconMs: number;
      totalInstancedBvhMs: number;
      totalInstancedBvhAdoptMs: number;
      totalWorkerBvhAdopted: number;
      totalSyncBvhFallback: number;
      totalStaticBvhMs: number;
      totalAttachMs: number;
    }
  ): boolean {
    if (record.state !== 'ready_to_commit' || !record.decodedPayload || !record.isInKeepSet) {
      return false;
    }
    const isPendingRecord =
      this.hierarchy !== null &&
      record.resolutionMeters === this.pendingResolutionMeters &&
      record.resolutionMeters !== this.activeResolutionMeters;
    const isPrewarmRecord =
      this.hierarchy !== null &&
      this.pendingResolutionMeters === null &&
      record.resolutionMeters === this.prewarmTargetResolutionMeters &&
      record.resolutionMeters !== this.activeResolutionMeters;
    if (
      this.hierarchy &&
      !isPendingRecord &&
      !isPrewarmRecord &&
      record.resolutionMeters !== this.activeResolutionMeters
    ) {
      record.decodedPayload = null;
      record.decodedFootprint = null;
      record.state = 'unloaded';
      return false;
    }
    if (isPendingRecord && this.transitionState === 'deferred_budget') {
      return false;
    }

    const footprintSnapshot = record.decodedFootprint;
    const compressedBytes = record.lastCompressedBytes ?? null;
    const rawBytes = footprintSnapshot
      ? footprintSnapshot.cpuGeometryBytes + footprintSnapshot.bvhBytes
      : null;
    const tileSizeMeters = record.resolutionMeters;

    if (prof) {
      prof.recordEvent({
        eventType: 'reconstruct_start',
        tileKey: record.tileKey,
        tileSizeMeters,
        lod: record.manifest.lod,
        payloadCompressedBytes: compressedBytes,
        payloadRawBytes: rawBytes,
        queueDepths: this.getQueueDepthSnapshot(),
      });
    }

    const t0 = this.nowFn();
    record.pipeline.reconstructStartAtMs = t0;
    if (record.pipeline.decodeCompleteAtMs !== null) {
      record.pipeline.mainThreadReconstructWaitMs = Math.max(
        0,
        t0 - record.pipeline.decodeCompleteAtMs
      );
      this.totalReconstructQueueWaitMs += record.pipeline.mainThreadReconstructWaitMs;
    }
    const reconstructed = reconstructTileSceneFromDecoded(
      record.decodedPayload,
      {
        materialRegistry: this.materialRegistry,
        placementMode: 'study-world-mesh-offset',
        initialCameraZoom: this.currentCameraZoom,
        foliagePrototypeRegistry: this.foliagePrototypeRegistry,
        foliageRuntimeState: this.foliageRuntimeState,
        collectStageTimings: Boolean(prof),
        optimizeMainThreadPrep: this.tilePrepOptions.optimizeMainThreadPrep,
      }
    );
    const tReconEnd = this.nowFn();
    const reconstructMs = Math.max(0, tReconEnd - t0);
    record.pipeline.reconstructCompleteAtMs = tReconEnd;
    record.pipeline.reconstructMs = reconstructMs;

    this.totalReconstructMs += reconstructMs;
    this.reconstructSamples += 1;
    pushBoundedSample(this.reconstructMsRing, reconstructMs);

    this.workerBvhAdoptedTotal += reconstructed.stageTimings.workerBvhAdoptedCount;
    this.syncBvhFallbackTotal += reconstructed.stageTimings.syncBvhFallbackCount;

    record.reconstructed = reconstructed;
    record.decodedPayload = null;
    record.lastUsedAtMs = tReconEnd;
    this.completedLoadsTotal += 1;

    if (prof) {
      accum.totalReconMs += reconstructMs;
      accum.totalInstancedBvhMs += reconstructed.stageTimings.instancedBvhBuildMs;
      accum.totalInstancedBvhAdoptMs += reconstructed.stageTimings.instancedBvhAdoptMs;
      accum.totalWorkerBvhAdopted += reconstructed.stageTimings.workerBvhAdoptedCount;
      accum.totalSyncBvhFallback += reconstructed.stageTimings.syncBvhFallbackCount;
      accum.totalStaticBvhMs += reconstructed.stageTimings.staticBvhDeserializeMs;
      prof.recordEvent({
        eventType: 'reconstruct_complete',
        tileKey: record.tileKey,
        tileSizeMeters,
        lod: record.manifest.lod,
        payloadCompressedBytes: compressedBytes,
        payloadRawBytes:
          rawBytes !== null
            ? rawBytes + reconstructed.instancedPickingStats.totalIndexMemoryBytes
            : null,
        durationMs: reconstructMs,
        queueDepths: this.getQueueDepthSnapshot(),
        detail: {
          instancedBvhBuildMs: reconstructed.stageTimings.instancedBvhBuildMs,
          instancedBvhAdoptMs: reconstructed.stageTimings.instancedBvhAdoptMs,
          workerBvhAdoptedCount: reconstructed.stageTimings.workerBvhAdoptedCount,
          syncBvhFallbackCount: reconstructed.stageTimings.syncBvhFallbackCount,
          staticBvhDeserializeMs: reconstructed.stageTimings.staticBvhDeserializeMs,
          instancedBatchCount: reconstructed.instancedPickingStats.indexedBatchCount,
          indexedInstances: reconstructed.instancedPickingStats.totalIndexedInstances,
          meshCount: footprintSnapshot?.meshCount,
          triangleCount: footprintSnapshot?.triangleCount,
        },
      });
    }

    if (isPendingRecord || isPrewarmRecord) {
      // Reconstructed off-scene; do NOT attach until atomic activation!
      record.state = 'prepared_inactive';
      if (isPrewarmRecord) {
        record.pipeline.preparedByPrewarm = true;
        this.prewarmTilesPreparedTotal += 1;
      }
      if (!this.isIncrementalGpuPrepActive() || record.manifest.isEmpty) {
        record.pipeline.readyAtMs = tReconEnd;
        this.updateHistoricalPrepLatency(record, tReconEnd);
      }
      accum.committed += 1;
      this.enforceResourceBudgets();
    } else {
      record.state = 'loaded';
      record.pipeline.readyAtMs = tReconEnd;
      this.updateHistoricalPrepLatency(record, tReconEnd);
      const tAttach0 = prof ? this.nowFn() : 0;
      this.attachTileToCompositeScene(record);
      const attachMs = prof ? Math.max(0, this.nowFn() - tAttach0) : 0;
      if (prof) {
        accum.totalAttachMs += attachMs;
        const attachNowMs = this.nowFn();
        prof.recordEvent({
          eventType: 'attach',
          tileKey: record.tileKey,
          tileSizeMeters,
          lod: record.manifest.lod,
          timestampMs: attachNowMs,
          payloadCompressedBytes: compressedBytes,
          payloadRawBytes: rawBytes,
          durationMs: attachMs,
          queueDepths: this.getQueueDepthSnapshot(),
          detail: {
            meshCount: footprintSnapshot?.meshCount,
            triangleCount: footprintSnapshot?.triangleCount,
          },
        });
        prof.markTilePendingFirstRender({
          tileKey: record.tileKey,
          tileSizeMeters,
          lod: record.manifest.lod,
          triangles: reconstructed.scene.stats.totalTriangles,
          meshes: footprintSnapshot?.meshCount ?? 0,
          compressedBytes,
          rawBytes,
          attachTimestampMs: attachNowMs,
        });
      }
      accum.committed += 1;
      accum.committedActive += 1;
    }
    return true;
  }

  private updateHistoricalPrepLatency(record: ManagedTileRecord, readyAtMs: number): void {
    const startMs = record.pipeline.fetchStartAtMs ?? record.pipeline.queuedAtMs;
    if (startMs === null) return;
    const totalLatencyMs = Math.max(20, readyAtMs - startMs);
    const res = record.resolutionMeters;
    const prev = this.historicalPrepLatencyByResMs[res] ?? totalLatencyMs;
    this.historicalPrepLatencyByResMs[res] = Number(
      (prev * 0.7 + totalLatencyMs * 0.3).toFixed(2)
    );
  }

  private collectPendingGpuPrepRecords(pendingLevel: ResolutionLevelState): ManagedTileRecord[] {
    const list: ManagedTileRecord[] = [];
    for (const record of pendingLevel.tilesByKey.values()) {
      if (
        (record.state === 'prepared_inactive' || record.state === 'cached_inactive') &&
        record.isInKeepSet &&
        record.reconstructed !== null &&
        !record.manifest.isEmpty &&
        !this.gpuPreparer.isTilePrepared(record.reconstructed)
      ) {
        list.push(record);
      }
    }
    list.sort((a, b) => a.priorityScore - b.priorityScore);
    return list;
  }

  private runDeferredDisposalSlice(
    maxTiles: number,
    maxTimeMs: number,
    accelerated: boolean,
    prof: StreamingProfiler | null
  ): { disposedTiles: number; durationMs: number } {
    if (this.deferredDisposalQueue.size === 0) {
      return { disposedTiles: 0, durationMs: 0 };
    }
    const step = this.deferredDisposalQueue.drainSlice({
      maxTiles,
      maxTimeMs,
      accelerated,
    });
    if (prof && step.disposedEntries.length > 0) {
      const depths = this.getQueueDepthSnapshot();
      for (const entry of step.disposedEntries) {
        prof.recordEvent({
          eventType: 'deferred_dispose_complete',
          tileKey: entry.tileKey,
          tileSizeMeters: entry.resolutionMeters,
          lod: entry.lod,
          payloadRawBytes: entry.measuredBytes,
          durationMs: entry.durationMs,
          queueDepths: depths,
          detail: {
            deferredDisposePendingTiles: this.deferredDisposalQueue.size,
            deferredDisposePendingBytes: this.deferredDisposalQueue.totalPendingBytes,
          },
        });
      }
    }
    return {
      disposedTiles: step.disposedTiles,
      durationMs: step.durationMs,
    };
  }

  /**
   * Commits decoded tiles (`ready_to_commit`), prepares destination GPU buffers
   * incrementally, drains deferred disposals, and executes atomic frame-boundary
   * resolution activation within the configured per-frame streaming budget.
   */
  tick(maxCommits = this.maxCommitsPerFrame): number {
    if (this.isDisposed) return 0;
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    const tTick0 = this.nowFn();
    const isUnboundedFlush = maxCommits === Number.MAX_SAFE_INTEGER;

    // Advance transition debounce timer even if viewport bounds did not change this frame
    if (
      this.hierarchy &&
      this.manifestStatus === 'loaded' &&
      this.pendingDebounceTargetResolution !== null
    ) {
      const promoted = this.evaluateDesiredResolutionInternal();
      if (promoted && this.currentViewport) {
        this.updateViewport(this.currentViewport);
      }
    }

    this.pumpFetchQueue();

    const tReady0 = prof ? this.nowFn() : 0;
    const activeReadyRecords: ManagedTileRecord[] = [];
    const pendingReadyRecords: ManagedTileRecord[] = [];
    const prewarmReadyRecords: ManagedTileRecord[] = [];

    const activeLevel = this.getActiveLevelState();
    if (activeLevel) {
      for (const record of activeLevel.tilesByKey.values()) {
        if (record.state === 'ready_to_commit' && record.isInKeepSet) {
          activeReadyRecords.push(record);
        }
      }
    }
    const pendingLevel =
      this.hierarchy && this.transitionState !== 'deferred_budget'
        ? this.getPendingLevelState()
        : null;
    if (pendingLevel) {
      for (const record of pendingLevel.tilesByKey.values()) {
        if (record.state === 'ready_to_commit' && record.isInKeepSet) {
          pendingReadyRecords.push(record);
        }
      }
    }
    const prewarmLevel =
      this.hierarchy &&
      this.pendingResolutionMeters === null &&
      this.streamingFrameBudget.predictivePrewarmEnabled
        ? this.getPrewarmLevelState()
        : null;
    if (prewarmLevel) {
      for (const record of prewarmLevel.tilesByKey.values()) {
        if (record.state === 'ready_to_commit' && record.isInKeepSet) {
          prewarmReadyRecords.push(record);
        }
      }
    }

    activeReadyRecords.sort((a, b) => a.priorityScore - b.priorityScore);
    pendingReadyRecords.sort((a, b) => a.priorityScore - b.priorityScore);
    prewarmReadyRecords.sort((a, b) => a.priorityScore - b.priorityScore);
    const readyScanAndSortMs = prof ? Math.max(0, this.nowFn() - tReady0) : 0;

    const accum = {
      committed: 0,
      committedActive: 0,
      totalReconMs: 0,
      totalInstancedBvhMs: 0,
      totalInstancedBvhAdoptMs: 0,
      totalWorkerBvhAdopted: 0,
      totalSyncBvhFallback: 0,
      totalStaticBvhMs: 0,
      totalAttachMs: 0,
    };

    let gpuUploadSubmitMs = 0;
    let gpuUploadedBytes = 0;
    let gpuUploadedMeshCount = 0;
    let resolutionActivationMs = 0;
    let boundaryOverlayRebuildMs = 0;
    let deferredDisposeMs = 0;
    let deferredDisposedTilesCount = 0;
    let schedulerBudgetMs = 0;
    let schedulerUsedMs = 0;
    let schedulerOverrunMs = 0;
    let indivisibleOverrunCount = 0;

    const tBatch0 = this.nowFn();
    const cfg = this.streamingFrameBudget;
    const gpuPrepActive = this.isIncrementalGpuPrepActive();
    const coverageGap = this.hasActiveVisibleCoverageGap();

    if (isUnboundedFlush) {
      // Unbounded flush path used by waitForIdle()
      const allReady = [
        ...activeReadyRecords,
        ...pendingReadyRecords,
        ...prewarmReadyRecords,
      ].sort((a, b) => a.priorityScore - b.priorityScore);
      for (const rec of allReady) {
        this.commitSingleReadyTile(rec, prof, accum);
      }

      if (gpuPrepActive && pendingLevel && this.pendingResolutionMeters !== null) {
        const toUpload = this.collectPendingGpuPrepRecords(pendingLevel);
        for (const rec of toUpload) {
          if (!rec.reconstructed) continue;
          const tSliceStart = this.nowFn();
          const step = this.gpuPreparer.prepareTileSlice(
            rec.tileKey,
            rec.reconstructed,
            {
              maxUnits: Number.MAX_SAFE_INTEGER,
              maxBytes: Number.MAX_SAFE_INTEGER,
              maxTimeMs: Number.POSITIVE_INFINITY,
            }
          );
          this.recordGpuPrepStepOnTile(rec, step, tSliceStart);
          gpuUploadSubmitMs += step.uploadSubmitMs;
          gpuUploadedBytes += step.uploadedEstimatedBytes;
          gpuUploadedMeshCount += step.uploadedUnits;
        }
      }

      if (gpuPrepActive && prewarmLevel && this.prewarmTargetResolutionMeters !== null) {
        const toUpload = this.collectPendingGpuPrepRecords(prewarmLevel);
        for (const rec of toUpload) {
          if (!rec.reconstructed) continue;
          const tSliceStart = this.nowFn();
          const step = this.gpuPreparer.prepareTileSlice(
            rec.tileKey,
            rec.reconstructed,
            {
              maxUnits: Number.MAX_SAFE_INTEGER,
              maxBytes: Number.MAX_SAFE_INTEGER,
              maxTimeMs: Number.POSITIVE_INFINITY,
            }
          );
          this.recordGpuPrepStepOnTile(rec, step, tSliceStart);
          gpuUploadSubmitMs += step.uploadSubmitMs;
          gpuUploadedBytes += step.uploadedEstimatedBytes;
          gpuUploadedMeshCount += step.uploadedUnits;
        }
      }

      if (
        this.hierarchy &&
        this.pendingResolutionMeters !== null &&
        this.transitionState !== 'deferred_budget'
      ) {
        const curPending = this.getPendingLevelState();
        if (curPending) {
          const readiness = this.checkDestinationReadiness(curPending);
          if (readiness.allReady) {
            const act = this.activatePendingResolutionAtomic();
            resolutionActivationMs += act.swapMs;
            boundaryOverlayRebuildMs += act.boundaryOverlayRebuildMs;
          }
        }
      }

      if (this.deferredDisposalQueue.size > 0) {
        const step = this.runDeferredDisposalSlice(
          Number.MAX_SAFE_INTEGER,
          Number.POSITIVE_INFINITY,
          true,
          prof
        );
        deferredDisposeMs += step.durationMs;
        deferredDisposedTilesCount += step.disposedTiles;
      }
    } else if (cfg.sharedSchedulerEnabled) {
      // TKT-041-F1 Shared Time-Aware Streaming Workload Scheduler
      const units: ScheduledWorkUnit[] = [];
      let committedThisTick = 0;
      let gpuUnitsLeft = cfg.maxGpuUploadUnitsPerFrame;
      let gpuBytesLeft = cfg.maxGpuUploadBytesPerFrame;
      let gpuAnyUploadedThisFrame = false;

      // 1 & 7: Active level ready_to_commit tiles
      for (const rec of activeReadyRecords) {
        if (
          !rec.isVisibleInViewport &&
          cfg.suppressSpeculativeDuringActiveCoverageGap &&
          coverageGap
        ) {
          continue;
        }
        units.push({
          id: `commit_active:${rec.tileKey}`,
          priority: rec.isVisibleInViewport
            ? 'missing_active_visible'
            : 'active_preload',
          tieBreaker: rec.priorityScore,
          isObsolete: () =>
            rec.state !== 'ready_to_commit' ||
            !rec.isInKeepSet ||
            rec.resolutionMeters !== this.activeResolutionMeters ||
            committedThisTick >= maxCommits,
          execute: () => {
            if (committedThisTick >= maxCommits) return false;
            const did = this.commitSingleReadyTile(rec, prof, accum);
            if (did) committedThisTick += 1;
            return did;
          },
        });
      }

      // 2: Urgent memory-pressure disposal
      const urgentDisposal =
        cfg.deferredDisposalEnabled &&
        this.deferredDisposalQueue.size > 0 &&
        this.deferredDisposalQueue.totalPendingBytes > cfg.maxPendingDisposalBytes;
      if (urgentDisposal) {
        units.push({
          id: 'dispose_urgent',
          priority: 'urgent_memory_disposal',
          tieBreaker: 0,
          isObsolete: () => this.deferredDisposalQueue.size === 0,
          execute: (remMs) => {
            const step = this.runDeferredDisposalSlice(
              Math.max(2, cfg.maxDeferredDisposeTilesPerFrame * 2),
              Math.max(0.5, remMs),
              true,
              prof
            );
            deferredDisposeMs += step.durationMs;
            deferredDisposedTilesCount += step.disposedTiles;
            return step.disposedTiles > 0;
          },
        });
      }

      // 3 & 8: Pending destination ready_to_commit tiles
      if (pendingLevel && this.pendingResolutionMeters !== null) {
        for (const rec of pendingReadyRecords) {
          if (
            !rec.isVisibleInViewport &&
            cfg.suppressSpeculativeDuringActiveCoverageGap &&
            coverageGap
          ) {
            continue;
          }
          units.push({
            id: `commit_pending:${rec.tileKey}`,
            priority: rec.isVisibleInViewport
              ? 'pending_destination_visible'
              : 'speculative_destination',
            tieBreaker: rec.priorityScore,
            isObsolete: () =>
              rec.state !== 'ready_to_commit' ||
              !rec.isInKeepSet ||
              rec.resolutionMeters !== this.pendingResolutionMeters ||
              this.transitionState === 'deferred_budget' ||
              committedThisTick >= maxCommits,
            execute: () => {
              if (committedThisTick >= maxCommits) return false;
              const did = this.commitSingleReadyTile(rec, prof, accum);
              if (did) committedThisTick += 1;
              return did;
            },
          });
        }

        // 4: Incremental offscreen GPU upload slices for prepared destination tiles
        if (gpuPrepActive) {
          const toUpload = this.collectPendingGpuPrepRecords(pendingLevel);
          for (const rec of toUpload) {
            units.push({
              id: `gpu_prep:${rec.tileKey}`,
              priority: rec.isVisibleInViewport
                ? 'gpu_prep_destination'
                : 'speculative_destination',
              tieBreaker: rec.priorityScore,
              isObsolete: () =>
                !rec.reconstructed ||
                !rec.isInKeepSet ||
                rec.resolutionMeters !== this.pendingResolutionMeters ||
                this.transitionState === 'deferred_budget' ||
                this.gpuPreparer.isTilePrepared(rec.reconstructed) ||
                (gpuAnyUploadedThisFrame && (gpuUnitsLeft <= 0 || gpuBytesLeft <= 0)),
              execute: (remMs) => {
                if (!rec.reconstructed) return false;
                const tSliceStart = this.nowFn();
                const step = this.gpuPreparer.prepareTileSlice(
                  rec.tileKey,
                  rec.reconstructed,
                  {
                    maxUnits: Math.max(1, gpuUnitsLeft),
                    maxBytes: Math.max(1, gpuBytesLeft),
                    maxTimeMs: Math.max(0.25, remMs),
                  }
                );
                this.recordGpuPrepStepOnTile(rec, step, tSliceStart);
                if (step.uploadedUnits > 0) {
                  gpuAnyUploadedThisFrame = true;
                  gpuUnitsLeft = Math.max(0, gpuUnitsLeft - step.uploadedUnits);
                  gpuBytesLeft = Math.max(
                    0,
                    gpuBytesLeft - step.uploadedEstimatedBytes
                  );
                  gpuUploadSubmitMs += step.uploadSubmitMs;
                  gpuUploadedBytes += step.uploadedEstimatedBytes;
                  gpuUploadedMeshCount += step.uploadedUnits;
                  if (prof) {
                    prof.recordEvent({
                      eventType: 'gpu_upload_batch',
                      tileKey: rec.tileKey,
                      tileSizeMeters: rec.resolutionMeters,
                      lod: rec.manifest.lod,
                      durationMs: step.uploadSubmitMs,
                      queueDepths: this.getQueueDepthSnapshot(),
                      detail: {
                        gpuUploadedUnits: step.uploadedUnits,
                        gpuUploadedBytes: step.uploadedEstimatedBytes,
                        reason: step.tileCompleted
                          ? 'tile_gpu_prep_complete'
                          : 'tile_gpu_prep_slice',
                      },
                    });
                  }
                  return true;
                }
                return false;
              },
            });
          }
        }

        // 5: Atomic resolution activation (if destination readiness reaches 100%)
        units.push({
          id: `activate:${this.pendingResolutionMeters}`,
          priority: 'resolution_activation',
          tieBreaker: 0,
          isObsolete: () => {
            if (
              this.pendingResolutionMeters === null ||
              this.transitionState === 'deferred_budget'
            ) {
              return true;
            }
            const curPending = this.getPendingLevelState();
            if (!curPending) return true;
            return !this.checkDestinationReadiness(curPending).allReady;
          },
          execute: () => {
            const act = this.activatePendingResolutionAtomic();
            resolutionActivationMs += act.swapMs;
            boundaryOverlayRebuildMs += act.boundaryOverlayRebuildMs;
            return act.swapMs > 0 || resolutionActivationMs >= 0;
          },
        });
      }

      // 6: Normal deferred resource disposal slice
      if (cfg.deferredDisposalEnabled && this.deferredDisposalQueue.size > 0 && !urgentDisposal) {
        units.push({
          id: 'dispose_deferred',
          priority: 'deferred_disposal',
          tieBreaker: 0,
          isObsolete: () => this.deferredDisposalQueue.size === 0,
          execute: (remMs) => {
            const step = this.runDeferredDisposalSlice(
              cfg.maxDeferredDisposeTilesPerFrame,
              Math.max(0.25, remMs),
              false,
              prof
            );
            deferredDisposeMs += step.durationMs;
            deferredDisposedTilesCount += step.disposedTiles;
            return step.disposedTiles > 0;
          },
        });
      }

      // 8b: Opportunistic predictive pre-warm commits & GPU uploads (strictly lowest priority,
      // only when idle with no active coverage gap and healthy memory headroom)
      if (prewarmLevel && !coverageGap && !this.speculativeBackpressureActive) {
        for (const rec of prewarmReadyRecords) {
          units.push({
            id: `commit_prewarm:${rec.tileKey}`,
            priority: 'speculative_destination',
            tieBreaker: rec.priorityScore,
            isObsolete: () =>
              rec.state !== 'ready_to_commit' ||
              !rec.isInKeepSet ||
              this.pendingResolutionMeters !== null ||
              rec.resolutionMeters !== this.prewarmTargetResolutionMeters ||
              this.speculativeBackpressureActive ||
              committedThisTick >= maxCommits,
            execute: () => {
              if (committedThisTick >= maxCommits) return false;
              const did = this.commitSingleReadyTile(rec, prof, accum);
              if (did) committedThisTick += 1;
              return did;
            },
          });
        }
        if (gpuPrepActive) {
          const prewarmGpu = this.collectPendingGpuPrepRecords(prewarmLevel);
          for (const rec of prewarmGpu) {
            units.push({
              id: `gpu_prep_prewarm:${rec.tileKey}`,
              priority: 'speculative_destination',
              tieBreaker: rec.priorityScore + 100_000,
              isObsolete: () =>
                !rec.reconstructed ||
                !rec.isInKeepSet ||
                this.pendingResolutionMeters !== null ||
                rec.resolutionMeters !== this.prewarmTargetResolutionMeters ||
                this.gpuPreparer.isTilePrepared(rec.reconstructed) ||
                (gpuAnyUploadedThisFrame && (gpuUnitsLeft <= 0 || gpuBytesLeft <= 0)),
              execute: (remMs) => {
                if (!rec.reconstructed) return false;
                const tSliceStart = this.nowFn();
                const step = this.gpuPreparer.prepareTileSlice(
                  rec.tileKey,
                  rec.reconstructed,
                  {
                    maxUnits: Math.max(1, gpuUnitsLeft),
                    maxBytes: Math.max(1, gpuBytesLeft),
                    maxTimeMs: Math.max(0.25, remMs),
                  }
                );
                this.recordGpuPrepStepOnTile(rec, step, tSliceStart);
                if (step.uploadedUnits > 0) {
                  gpuAnyUploadedThisFrame = true;
                  gpuUnitsLeft = Math.max(0, gpuUnitsLeft - step.uploadedUnits);
                  gpuBytesLeft = Math.max(0, gpuBytesLeft - step.uploadedEstimatedBytes);
                  gpuUploadSubmitMs += step.uploadSubmitMs;
                  gpuUploadedBytes += step.uploadedEstimatedBytes;
                  gpuUploadedMeshCount += step.uploadedUnits;
                  return true;
                }
                return false;
              },
            });
          }
        }
      }

      const scheduleSummary = this.workloadScheduler.runFrame(
        units,
        cfg.frameStreamingBudgetMs,
        {
          alreadyUsedMs: readyScanAndSortMs,
          allowStarvationEscape: true,
        }
      );
      schedulerBudgetMs = scheduleSummary.budgetMs;
      schedulerUsedMs = scheduleSummary.usedMs;
      schedulerOverrunMs = scheduleSummary.overrunMs;
      indivisibleOverrunCount = scheduleSummary.indivisibleOverrunCount;

      // Update transitionState if pending level is still preparing
      if (
        this.hierarchy &&
        this.pendingResolutionMeters !== null &&
        this.transitionState !== 'deferred_budget'
      ) {
        const curPending = this.getPendingLevelState();
        if (curPending) {
          const readiness = this.checkDestinationReadiness(curPending);
          this.transitionState = readiness.allReady
            ? 'ready_to_activate'
            : 'preparing';
        }
      }
    } else {
      // Separable non-scheduler path (for tkt041_baseline, incremental_gpu_only,
      // deferred_disposal_only, debounce_reuse_only A/B evaluations)
      const allReady = [...activeReadyRecords, ...pendingReadyRecords].sort(
        (a, b) => a.priorityScore - b.priorityScore
      );
      const limit = Math.min(maxCommits, allReady.length);
      const maxCommitBudgetMs = this.hierarchy
        ? this.hierarchicalBudget.maxCommitBudgetMsPerFrame
        : Number.POSITIVE_INFINITY;

      for (let i = 0; i < limit; i++) {
        if (i > 0 && this.nowFn() - tBatch0 >= maxCommitBudgetMs) {
          break;
        }
        this.commitSingleReadyTile(allReady[i], prof, accum);
      }

      if (
        gpuPrepActive &&
        pendingLevel &&
        this.pendingResolutionMeters !== null &&
        this.transitionState !== 'deferred_budget'
      ) {
        const toUpload = this.collectPendingGpuPrepRecords(pendingLevel);
        let unitsLeft = cfg.maxGpuUploadUnitsPerFrame;
        let bytesLeft = cfg.maxGpuUploadBytesPerFrame;
        const tGpu0 = this.nowFn();
        for (const rec of toUpload) {
          if (!rec.reconstructed) continue;
          if (
            gpuUploadedMeshCount > 0 &&
            (unitsLeft <= 0 ||
              bytesLeft <= 0 ||
              this.nowFn() - tGpu0 >= cfg.frameStreamingBudgetMs)
          ) {
            break;
          }
          const tSliceStart = this.nowFn();
          const step = this.gpuPreparer.prepareTileSlice(
            rec.tileKey,
            rec.reconstructed,
            {
              maxUnits: Math.max(1, unitsLeft),
              maxBytes: Math.max(1, bytesLeft),
              maxTimeMs: cfg.frameStreamingBudgetMs,
            }
          );
          this.recordGpuPrepStepOnTile(rec, step, tSliceStart);
          if (step.uploadedUnits > 0) {
            unitsLeft = Math.max(0, unitsLeft - step.uploadedUnits);
            bytesLeft = Math.max(0, bytesLeft - step.uploadedEstimatedBytes);
            gpuUploadSubmitMs += step.uploadSubmitMs;
            gpuUploadedBytes += step.uploadedEstimatedBytes;
            gpuUploadedMeshCount += step.uploadedUnits;
            if (prof) {
              prof.recordEvent({
                eventType: 'gpu_upload_batch',
                tileKey: rec.tileKey,
                tileSizeMeters: rec.resolutionMeters,
                lod: rec.manifest.lod,
                durationMs: step.uploadSubmitMs,
                queueDepths: this.getQueueDepthSnapshot(),
                detail: {
                  gpuUploadedUnits: step.uploadedUnits,
                  gpuUploadedBytes: step.uploadedEstimatedBytes,
                  reason: step.tileCompleted
                    ? 'tile_gpu_prep_complete'
                    : 'tile_gpu_prep_slice',
                },
              });
            }
          }
        }
      }

      if (
        this.hierarchy &&
        this.pendingResolutionMeters !== null &&
        this.transitionState !== 'deferred_budget'
      ) {
        const curPending = this.getPendingLevelState();
        if (curPending) {
          const readiness = this.checkDestinationReadiness(curPending);
          if (readiness.allReady) {
            const act = this.activatePendingResolutionAtomic();
            resolutionActivationMs += act.swapMs;
            boundaryOverlayRebuildMs += act.boundaryOverlayRebuildMs;
          } else {
            this.transitionState = 'preparing';
          }
        }
      }

      if (cfg.deferredDisposalEnabled && this.deferredDisposalQueue.size > 0) {
        const accelerated =
          this.deferredDisposalQueue.totalPendingBytes > cfg.maxPendingDisposalBytes;
        const step = this.runDeferredDisposalSlice(
          accelerated
            ? Math.max(2, cfg.maxDeferredDisposeTilesPerFrame * 2)
            : cfg.maxDeferredDisposeTilesPerFrame,
          cfg.frameStreamingBudgetMs,
          accelerated,
          prof
        );
        deferredDisposeMs += step.durationMs;
        deferredDisposedTilesCount += step.disposedTiles;
      }
    }

    let commitRebuildStatsMs = 0;
    let commitEmitDiagnosticsMs = 0;
    if (accum.committed > 0) {
      const batchCommitMs = Math.max(0, this.nowFn() - tBatch0);
      this.lastCommitMs = batchCommitMs;
      this.maxCommitMs = Math.max(this.maxCommitMs, batchCommitMs);
      pushBoundedSample(this.commitMsRing, batchCommitMs);

      if (accum.committedActive > 0) {
        if (this.currentWireframe) {
          this.materialRegistry.setWireframe(true);
        }
        const tStats0 = prof ? this.nowFn() : 0;
        this.rebuildCompositeStats();
        if (prof) commitRebuildStatsMs = Math.max(0, this.nowFn() - tStats0);
      }

      if (this.hierarchy) {
        this.enforceResourceBudgets();
      }

      const tDiag0 = prof ? this.nowFn() : 0;
      this.emitDiagnostics();
      if (prof) commitEmitDiagnosticsMs = Math.max(0, this.nowFn() - tDiag0);
    }

    // Re-pump fetch queue in case draining `ready_to_commit` relieved worker backpressure
    this.pumpFetchQueue();
    this.checkIdleWaiters();
    if (prof) {
      prof.recordStreamTick({
        totalMs: Math.max(0, this.nowFn() - tTick0),
        readyScanAndSortMs,
        reconstructMs: accum.totalReconMs,
        instancedBvhBuildMs: accum.totalInstancedBvhMs,
        instancedBvhAdoptMs: accum.totalInstancedBvhAdoptMs,
        workerBvhAdoptedCount: accum.totalWorkerBvhAdopted,
        syncBvhFallbackCount: accum.totalSyncBvhFallback,
        staticBvhDeserializeMs: accum.totalStaticBvhMs,
        sceneAttachMs: accum.totalAttachMs,
        commitRebuildStatsMs,
        commitEmitDiagnosticsMs,
        tilesCommittedCount: accum.committed,
        gpuUploadSubmitMs,
        gpuUploadedBytes,
        gpuUploadedMeshCount,
        resolutionActivationMs,
        boundaryOverlayRebuildMs,
        deferredDisposeMs,
        deferredDisposedTilesCount,
        schedulerBudgetMs,
        schedulerUsedMs,
        schedulerOverrunMs,
        indivisibleOverrunCount,
        hasValidViewportCoverage: !this.hasActiveVisibleCoverageGap(),
      });
    }
    return accum.committed;
  }

  /**
   * Waits until all tiles in the current `fetchSet` (and any non-deferred pending
   * hierarchical resolution transition or debounce) have finished fetching, decoding,
   * GPU-preparing, committing, and draining deferred disposals.
   */
  async waitForIdle(): Promise<void> {
    while (!this.isDisposed) {
      this.tick(Number.MAX_SAFE_INTEGER);
      if (this.isCurrentlyIdle()) {
        return;
      }
      if (!this.hasPendingAsyncWork()) {
        if (this.pendingDebounceTargetResolution !== null) {
          const elapsed =
            this.pendingDebounceStartedAtMs !== null
              ? Math.max(0, this.nowFn() - this.pendingDebounceStartedAtMs)
              : 0;
          const remaining = Math.max(
            5,
            this.streamingFrameBudget.transitionDebounceMs - elapsed + 2
          );
          await new Promise<void>((resolve) => setTimeout(resolve, remaining));
        }
        continue;
      }
      await new Promise<void>((resolve) => {
        this.idleWaiters.push(resolve);
      });
    }
  }

  updateTheme(newTheme: MapStyleTheme): void {
    if (this.isDisposed) return;
    this.currentTheme = newTheme;
    this.materialRegistry.applyTheme(newTheme);
    this.boundaryOverlayResult.group.traverse((child) => {
      if (child.name === 'M1a_InternalTileSeams' && (child as THREE.LineSegments).material) {
        const mat = (child as THREE.LineSegments).material as THREE.LineBasicMaterial;
        mat.color.set(newTheme.id === 'daylight' ? '#0284c7' : '#22d3ee');
      }
    });
  }

  private applyCameraZoomWithoutResolutionEval(zoom: number): boolean {
    if (this.experimentSkipUnchangedZoom && zoom === this.currentCameraZoom) {
      this.zoomPropagationSkips++;
      return false;
    }
    const now = this.nowFn();
    const nextScale = computeEffectiveOrthographicScale(
      zoom,
      this.currentViewportWidthPx,
      this.hierarchicalPolicy
    ).effectiveScalePxPerMeter;
    if (
      this.lastScalePxPerMeterSample !== null &&
      this.lastZoomSampleAtMs !== null
    ) {
      const dtSec = Math.max(0.004, (now - this.lastZoomSampleAtMs) / 1000);
      const instVel = (nextScale - this.lastScalePxPerMeterSample) / dtSec;
      this.scaleVelocityPerSec = this.scaleVelocityPerSec * 0.6 + instVel * 0.4;
    }
    this.lastScalePxPerMeterSample = nextScale;
    this.lastZoomSampleAtMs = now;

    if (
      this.previousCameraZoomForTrend !== null &&
      Number.isFinite(zoom) &&
      Math.abs(zoom - this.previousCameraZoomForTrend) > 1e-4
    ) {
      this.zoomTrend =
        zoom < this.previousCameraZoomForTrend ? 'zooming_out' : 'zooming_in';
    }
    this.previousCameraZoomForTrend = zoom;
    this.currentCameraZoom = zoom;
    this.materialRegistry.setCameraZoom(zoom);

    const prevFoliage = this.foliageRuntimeState;
    const nextFoliage = resolveFoliageRuntimeState(
      zoom,
      prevFoliage,
      this.foliageConfig
    );
    const foliageBehaviorChanged =
      nextFoliage.activeLod !== prevFoliage.activeLod ||
      nextFoliage.trunksVisible !== prevFoliage.trunksVisible ||
      nextFoliage.frustumCullingEnabled !== prevFoliage.frustumCullingEnabled ||
      nextFoliage.optimizationEnabled !== prevFoliage.optimizationEnabled;
    this.foliageRuntimeState = nextFoliage;

    for (const record of this.tilesByKey.values()) {
      if (record.state === 'loaded' && record.reconstructed) {
        record.reconstructed.scene.updateCameraZoom?.(zoom);
        if (foliageBehaviorChanged) {
          record.reconstructed.applyFoliageRuntimeState(nextFoliage);
        }
      }
    }
    return true;
  }

  updateCameraZoom(zoom: number): void {
    if (this.isDisposed) return;
    const changed = this.applyCameraZoomWithoutResolutionEval(zoom);
    if (changed && this.hierarchy && this.manifestStatus === 'loaded') {
      const prevPending = this.pendingResolutionMeters;
      this.evaluateDesiredResolutionInternal();
      if (prevPending !== this.pendingResolutionMeters && this.currentViewport) {
        this.updateViewport({
          ...this.currentViewport,
          cameraZoom: zoom,
        });
      }
    }
  }

  setWireframe(enabled: boolean): void {
    if (this.isDisposed) return;
    this.currentWireframe = enabled;
    this.materialRegistry.setWireframe(enabled);
  }

  getTileState(tileKey: string): TileStreamLifecycleState {
    const direct = this.tilesByKey.get(tileKey);
    if (direct) return direct.state;
    if (this.hierarchy && this.activeResolutionMeters !== null) {
      const activeLevel = this.levelsByResolution.get(this.activeResolutionMeters);
      if (activeLevel) {
        for (const rec of activeLevel.tilesByKey.values()) {
          if (formatTileId(rec.manifest.tx, rec.manifest.ty) === tileKey) {
            return rec.state;
          }
        }
      }
    }
    return 'unloaded';
  }

  private computeRecordFootprintBreakdown(record: ManagedTileRecord): {
    cpuGeometryBytes: number;
    staticBvhBytes: number;
    instancedIndexBytes: number;
    queuedDecodedBytes: number;
    estimatedWorkerBytes: number;
    estimatedGpuBytes: number;
    totalMeasuredBytes: number;
  } {
    const fp = record.decodedFootprint;
    if (record.state === 'fetching') {
      return {
        cpuGeometryBytes: 0,
        staticBvhBytes: 0,
        instancedIndexBytes: 0,
        queuedDecodedBytes: 0,
        estimatedWorkerBytes: record.reservedHttpBytes,
        estimatedGpuBytes: 0,
        totalMeasuredBytes: 0,
      };
    }

    if (record.state === 'retrieved_queued') {
      // Binary payload currently held in retrievedBuffer awaiting worker transfer.
      // Single-owner accounting: counted as measured queued bytes until transferred to worker!
      const bufBytes = record.retrievedBuffer?.byteLength ?? 0;
      return {
        cpuGeometryBytes: 0,
        staticBvhBytes: 0,
        instancedIndexBytes: 0,
        queuedDecodedBytes: bufBytes,
        estimatedWorkerBytes: 0,
        estimatedGpuBytes: 0,
        totalMeasuredBytes: bufBytes,
      };
    }

    if (record.state === 'decoding') {
      // ArrayBuffer has been transferred to worker (retrievedBuffer is null -> zero double-counting).
      const comp = record.lastCompressedBytes ?? 0;
      const estimatedWorkerBytes =
        record.reservedWorkerBytes > 0
          ? record.reservedWorkerBytes
          : comp > 0
            ? comp * 4
            : 0;
      return {
        cpuGeometryBytes: 0,
        staticBvhBytes: 0,
        instancedIndexBytes: 0,
        queuedDecodedBytes: 0,
        estimatedWorkerBytes,
        estimatedGpuBytes: 0,
        totalMeasuredBytes: 0,
      };
    }

    if (record.state === 'ready_to_commit') {
      const cpuGeometryBytes = fp?.cpuGeometryBytes ?? 0;
      const preparedInstanced = fp?.preparedInstancedBvhBytes ?? 0;
      const staticBvhBytes = Math.max(0, (fp?.bvhBytes ?? 0) - preparedInstanced);
      const queuedDecodedBytes = cpuGeometryBytes + staticBvhBytes + preparedInstanced;
      return {
        cpuGeometryBytes: 0,
        staticBvhBytes: 0,
        instancedIndexBytes: 0,
        queuedDecodedBytes,
        estimatedWorkerBytes: 0,
        estimatedGpuBytes: 0,
        totalMeasuredBytes: queuedDecodedBytes,
      };
    }

    if (
      (record.state === 'loaded' ||
        record.state === 'prepared_inactive' ||
        record.state === 'cached_inactive') &&
      record.reconstructed !== null
    ) {
      const cpuGeometryBytes = fp?.cpuGeometryBytes ?? 0;
      const preparedInstanced = fp?.preparedInstancedBvhBytes ?? 0;
      const staticBvhBytes = Math.max(0, (fp?.bvhBytes ?? 0) - preparedInstanced);
      const instancedIndexBytes =
        record.reconstructed.instancedPickingStats.totalIndexMemoryBytes;
      // Explicitly estimated GPU vertex/index/instance buffer bytes (WebGL does not expose driver VRAM).
      const estimatedGpuBytes = cpuGeometryBytes;
      const totalMeasuredBytes =
        cpuGeometryBytes + staticBvhBytes + instancedIndexBytes;
      return {
        cpuGeometryBytes,
        staticBvhBytes,
        instancedIndexBytes,
        queuedDecodedBytes: 0,
        estimatedWorkerBytes: 0,
        estimatedGpuBytes,
        totalMeasuredBytes,
      };
    }

    return {
      cpuGeometryBytes: 0,
      staticBvhBytes: 0,
      instancedIndexBytes: 0,
      queuedDecodedBytes: 0,
      estimatedWorkerBytes: 0,
      estimatedGpuBytes: 0,
      totalMeasuredBytes: 0,
    };
  }

  private recordGpuPrepStepOnTile(
    record: ManagedTileRecord,
    step: {
      uploadedUnits: number;
      uploadedEstimatedBytes: number;
      uploadSubmitMs: number;
      tileCompleted: boolean;
      reusedAlreadyPrepared: boolean;
    },
    sliceStartMs: number
  ): void {
    const p = record.pipeline;
    if (p.gpuPrepFirstSliceAtMs === null) {
      p.gpuPrepFirstSliceAtMs = sliceStartMs;
    }
    p.gpuPrepSubmitMs += step.uploadSubmitMs;
    if (step.uploadedUnits > 0) {
      p.gpuPrepSliceCount += 1;
    }
    if (step.tileCompleted) {
      const doneMs = this.nowFn();
      p.gpuPrepCompleteAtMs = doneMs;
      const startRef = p.reconstructCompleteAtMs ?? p.gpuPrepFirstSliceAtMs ?? doneMs;
      const totalGpuSpan = Math.max(0, doneMs - startRef);
      p.gpuPrepWaitMs = Math.max(0, totalGpuSpan - p.gpuPrepSubmitMs);
      p.readyAtMs = doneMs;
      this.totalGpuPrepQueueWaitMs += p.gpuPrepWaitMs;
      this.totalGpuPrepSubmitMs += p.gpuPrepSubmitMs;
      this.gpuPrepCompletedTileSamples += 1;
      this.updateHistoricalPrepLatency(record, doneMs);
    }
  }

  private computeCurrentTransitionBlockerSnapshot(
    resources: HierarchicalResourceAccountingSnapshot
  ): TransitionBlockerSnapshot {
    const now = this.nowFn();
    let activeVisibleInFlightCount = 0;
    let activePreloadInFlightCount = 0;
    let pendingDestinationVisibleInFlightCount = 0;
    let pendingDestinationSpeculativeInFlightCount = 0;
    let pendingDecodedBytes = 0;
    let retrievedQueueCount = 0;

    for (const record of this.tilesByKey.values()) {
      if (record.state === 'retrieved_queued') {
        retrievedQueueCount += 1;
      }
      const inFlight =
        record.state === 'queued' ||
        record.state === 'fetching' ||
        record.state === 'retrieved_queued' ||
        record.state === 'decoding' ||
        record.state === 'ready_to_commit';
      if (record.state === 'ready_to_commit' && record.decodedFootprint) {
        pendingDecodedBytes +=
          record.decodedFootprint.cpuGeometryBytes + record.decodedFootprint.bvhBytes;
      }
      if (!inFlight) continue;
      if (record.resolutionMeters === this.activeResolutionMeters) {
        if (record.isVisibleInViewport) activeVisibleInFlightCount += 1;
        else activePreloadInFlightCount += 1;
      } else if (record.resolutionMeters === this.pendingResolutionMeters) {
        if (record.isVisibleInViewport) pendingDestinationVisibleInFlightCount += 1;
        else pendingDestinationSpeculativeInFlightCount += 1;
      }
    }

    const memoryHeadroomBytes = Math.max(
      0,
      this.hierarchicalBudget.totalMemoryBudgetBytes - resources.totalMeasuredBytes
    );
    const maxFetches = this.getEffectiveMaxConcurrentHttpRetrievals();
    const contention = {
      activeVisibleInFlightCount,
      activePreloadInFlightCount,
      pendingDestinationVisibleInFlightCount,
      pendingDestinationSpeculativeInFlightCount,
      fetchSlotsUsed: this.activeFetchCount,
      fetchSlotsMax: maxFetches,
      retrievedQueueCount,
      retrievedQueueBytes: this.retrievedPayloadQueueBytes,
      workerPendingDecodes: this.decodeClient.getPendingDecodeCount(),
      workerPoolSize: this.decodeClient.getActiveWorkerCount(),
      workerBackpressureActive: this.workerBackpressureActive,
      speculativeBackpressureActive: this.speculativeBackpressureActive,
      memoryHeadroomBytes,
      pendingDecodedBytes,
      pendingDecodedCapBytes: this.streamingFrameBudget.independentPipelineStagesEnabled
        ? this.streamingFrameBudget.maxPreparedPayloadQueueBytes
        : this.hierarchicalBudget.maxPendingDecodedBytes,
      cancellationsDuringTransition: this.currentTransitionCancellations,
    };

    if (
      this.pendingResolutionMeters === null &&
      this.pendingDebounceTargetResolution !== null
    ) {
      const elapsedMs =
        this.pendingDebounceStartedAtMs !== null
          ? Math.max(0, now - this.pendingDebounceStartedAtMs)
          : 0;
      return {
        active: true,
        blockerCategory: 'debounce_waiting',
        blockerReason: `Debouncing transition ${this.activeResolutionMeters ?? '?'}m -> ${this.pendingDebounceTargetResolution}m (${elapsedMs.toFixed(0)}/${this.streamingFrameBudget.transitionDebounceMs} ms)`,
        fromResolutionMeters: this.activeResolutionMeters,
        toResolutionMeters: this.pendingDebounceTargetResolution,
        transitionGeneration: this.transitionGeneration,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        requiredVisibleCount: 0,
        readyCount: 0,
        destinationCoverageReadinessRatio: 0,
        newlyRequiredDestinationTilesCount: 0,
        queuedCount: 0,
        fetchingCount: 0,
        retrievedQueuedCount: 0,
        decodingCount: 0,
        reconstructWaitingCount: 0,
        gpuPrepWaitingCount: 0,
        failedCount: 0,
        slowestOutstandingTile: null,
        oldestOutstandingTile: null,
        contention,
      };
    }

    if (this.pendingResolutionMeters === null) {
      return {
        active: false,
        blockerCategory: 'none',
        blockerReason: 'No transition in progress.',
        fromResolutionMeters: this.activeResolutionMeters,
        toResolutionMeters: null,
        transitionGeneration: this.transitionGeneration,
        elapsedMs: 0,
        requiredVisibleCount: 0,
        readyCount: 0,
        destinationCoverageReadinessRatio: 1,
        newlyRequiredDestinationTilesCount: 0,
        queuedCount: 0,
        fetchingCount: 0,
        retrievedQueuedCount: 0,
        decodingCount: 0,
        reconstructWaitingCount: 0,
        gpuPrepWaitingCount: 0,
        failedCount: 0,
        slowestOutstandingTile: null,
        oldestOutstandingTile: null,
        contention,
      };
    }

    const elapsedMs =
      this.transitionStartedAtMs !== null
        ? Math.max(0, now - this.transitionStartedAtMs)
        : 0;

    if (this.transitionState === 'deferred_budget') {
      return {
        active: true,
        blockerCategory: 'budget_deferred',
        blockerReason:
          this.budgetDeferralReason ?? 'Transition deferred due to memory budget.',
        fromResolutionMeters: this.activeResolutionMeters,
        toResolutionMeters: this.pendingResolutionMeters,
        transitionGeneration: this.transitionGeneration,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        requiredVisibleCount: 0,
        readyCount: 0,
        destinationCoverageReadinessRatio: 0,
        newlyRequiredDestinationTilesCount: this.currentTransitionNewlyRequiredTilesCount,
        queuedCount: 0,
        fetchingCount: 0,
        retrievedQueuedCount: 0,
        decodingCount: 0,
        reconstructWaitingCount: 0,
        gpuPrepWaitingCount: 0,
        failedCount: 0,
        slowestOutstandingTile: null,
        oldestOutstandingTile: null,
        contention,
      };
    }

    const pendingLevel = this.getPendingLevelState();
    const requireGpuPrep = this.isIncrementalGpuPrepActive();
    let requiredVisibleCount = 0;
    let readyCount = 0;
    let queuedCount = 0;
    let fetchingCount = 0;
    let retrievedQueuedCount = 0;
    let decodingCount = 0;
    let reconstructWaitingCount = 0;
    let gpuPrepWaitingCount = 0;
    let failedCount = 0;
    let slowestTile: TransitionOutstandingTileSnapshot | null = null;
    let oldestTile: TransitionOutstandingTileSnapshot | null = null;

    if (pendingLevel) {
      for (const record of pendingLevel.tilesByKey.values()) {
        if (!record.isVisibleInViewport) continue;
        requiredVisibleCount += 1;
        if (record.manifest.isEmpty) {
          readyCount += 1;
          continue;
        }
        const isCpuReady =
          (record.state === 'prepared_inactive' ||
            record.state === 'cached_inactive' ||
            record.state === 'loaded') &&
          record.reconstructed !== null;
        const isGpuReady =
          isCpuReady &&
          (!requireGpuPrep || this.gpuPreparer.isTilePrepared(record.reconstructed!));
        if (isGpuReady) {
          readyCount += 1;
          continue;
        }

        let currentStage: TransitionOutstandingTileSnapshot['currentStage'] = 'unloaded';
        let stageStartMs = this.transitionStartedAtMs ?? now;
        let gpuPrepRemainingUnits = 0;
        const p = record.pipeline;
        if (record.state === 'queued') {
          queuedCount += 1;
          currentStage = 'queued';
          stageStartMs = p.queuedAtMs ?? stageStartMs;
        } else if (record.state === 'fetching') {
          fetchingCount += 1;
          currentStage = 'fetching';
          stageStartMs = p.fetchStartAtMs ?? stageStartMs;
        } else if (record.state === 'retrieved_queued') {
          retrievedQueuedCount += 1;
          currentStage = 'retrieved_queued';
          stageStartMs = p.retrievedQueuedAtMs ?? p.fetchCompleteAtMs ?? stageStartMs;
        } else if (record.state === 'decoding') {
          decodingCount += 1;
          currentStage = 'worker_queue_or_decoding';
          stageStartMs = p.decodeStartAtMs ?? stageStartMs;
        } else if (record.state === 'ready_to_commit') {
          reconstructWaitingCount += 1;
          currentStage = 'reconstruct_waiting';
          stageStartMs = p.decodeCompleteAtMs ?? stageStartMs;
        } else if (isCpuReady && !isGpuReady) {
          gpuPrepWaitingCount += 1;
          currentStage = 'gpu_prep_waiting';
          stageStartMs = p.reconstructCompleteAtMs ?? stageStartMs;
          gpuPrepRemainingUnits = this.gpuPreparer.getRemainingUnits(record.reconstructed!);
        } else if (record.state === 'error') {
          failedCount += 1;
          currentStage = 'error';
        }

        const stageElapsedMs = Math.max(0, now - stageStartMs);
        const tileAgeSinceQueueMs =
          p.queuedAtMs !== null ? Math.max(0, now - p.queuedAtMs) : elapsedMs;
        const liveFetchQueueWaitMs =
          record.state === 'queued' && p.queuedAtMs !== null
            ? Math.max(0, now - p.queuedAtMs)
            : p.fetchQueueWaitMs;
        const livePayloadRetrievalMs =
          record.state === 'fetching' && p.fetchStartAtMs !== null
            ? Math.max(0, now - p.fetchStartAtMs)
            : p.payloadRetrievalMs;
        const liveRetrievedQueueWaitMs =
          record.state === 'retrieved_queued' && p.retrievedQueuedAtMs !== null
            ? Math.max(0, now - p.retrievedQueuedAtMs)
            : p.retrievedQueueWaitMs;
        const liveReconstructWaitMs =
          record.state === 'ready_to_commit' && p.decodeCompleteAtMs !== null
            ? Math.max(0, now - p.decodeCompleteAtMs)
            : p.mainThreadReconstructWaitMs;
        const liveGpuPrepWaitMs =
          isCpuReady && !isGpuReady && p.reconstructCompleteAtMs !== null
            ? Math.max(0, now - p.reconstructCompleteAtMs - p.gpuPrepSubmitMs)
            : p.gpuPrepWaitMs;
        const rawBytes = record.decodedFootprint
          ? record.decodedFootprint.cpuGeometryBytes + record.decodedFootprint.bvhBytes
          : null;

        const candidate: TransitionOutstandingTileSnapshot = {
          tileKey: record.tileKey,
          resolutionMeters: record.resolutionMeters,
          state: record.state,
          currentStage,
          ageSinceTransitionStartMs: Number(tileAgeSinceQueueMs.toFixed(2)),
          currentStageElapsedMs: Number(stageElapsedMs.toFixed(2)),
          fetchQueueWaitMs: Number(liveFetchQueueWaitMs.toFixed(2)),
          payloadRetrievalMs: Number(livePayloadRetrievalMs.toFixed(2)),
          retrievedQueueWaitMs: Number(liveRetrievedQueueWaitMs.toFixed(2)),
          workerQueueWaitMs: Number(
            (p.workerClientQueueWaitMs + p.workerThreadQueueWaitMs).toFixed(2)
          ),
          workerDecodeAndBvhMs: Number(
            (
              p.workerInflateAndDecodeMs +
              p.workerBvhBuildMs +
              p.workerPayloadPrepMs
            ).toFixed(2)
          ),
          mainThreadReconstructWaitMs: Number(liveReconstructWaitMs.toFixed(2)),
          reconstructMs: Number(p.reconstructMs.toFixed(2)),
          gpuPrepWaitMs: Number(liveGpuPrepWaitMs.toFixed(2)),
          gpuPrepSubmitMs: Number(p.gpuPrepSubmitMs.toFixed(2)),
          gpuPrepRemainingUnits,
          payloadCompressedBytes: record.lastCompressedBytes ?? null,
          payloadRawBytes: rawBytes,
          lastError: record.lastError,
        };

        if (
          slowestTile === null ||
          candidate.currentStageElapsedMs > slowestTile.currentStageElapsedMs
        ) {
          slowestTile = candidate;
        }
        if (
          oldestTile === null ||
          candidate.ageSinceTransitionStartMs > oldestTile.ageSinceTransitionStartMs
        ) {
          oldestTile = candidate;
        }
      }
    }

    let blockerCategory: TransitionBlockerCategory = 'none';
    let blockerReason = 'Ready for atomic frame-boundary activation.';
    if (failedCount > 0) {
      blockerCategory = 'error_or_missing';
      blockerReason = `${failedCount} required ${this.pendingResolutionMeters}m tile(s) failed to load.`;
    } else if (this.workerBackpressureActive && (queuedCount > 0 || retrievedQueuedCount > 0)) {
      blockerCategory = 'memory_backpressure';
      blockerReason = `Backpressure active (${(pendingDecodedBytes / (1024 * 1024)).toFixed(1)} MiB prepared awaiting reconstruction) blocking ${queuedCount + retrievedQueuedCount} tile(s).`;
    } else if (
      this.hasActiveVisibleCoverageGap() &&
      (queuedCount > 0 || reconstructWaitingCount > 0 || gpuPrepWaitingCount > 0)
    ) {
      blockerCategory = 'active_coverage_gap';
      blockerReason = `Active ${this.activeResolutionMeters}m visible coverage gap taking priority over ${requiredVisibleCount - readyCount} pending destination tile(s).`;
    } else if (slowestTile) {
      switch (slowestTile.currentStage) {
        case 'queued':
          blockerCategory = 'fetch_queue_contention';
          blockerReason = `${queuedCount} destination tile(s) queued waiting for fetch slots (${this.activeFetchCount}/${maxFetches} used, ${activePreloadInFlightCount} active-preload in flight).`;
          break;
        case 'fetching':
          blockerCategory = 'network_fetching';
          blockerReason = `Fetching ${fetchingCount} destination tile(s); slowest ${slowestTile.tileKey} (${slowestTile.payloadRetrievalMs.toFixed(0)} ms).`;
          break;
        case 'retrieved_queued':
          blockerCategory = 'retrieved_queue_waiting';
          blockerReason = `${retrievedQueuedCount} retrieved destination payload(s) queued awaiting worker slot; slowest ${slowestTile.tileKey} (${(slowestTile.retrievedQueueWaitMs ?? 0).toFixed(0)} ms).`;
          break;
        case 'worker_queue_or_decoding':
          blockerCategory =
            this.decodeClient.getPendingDecodeCount() >
            Math.max(1, this.decodeClient.getActiveWorkerCount())
              ? 'worker_queue_waiting'
              : 'worker_decoding';
          blockerReason = `Decoding ${decodingCount} destination tile(s) (${this.decodeClient.getPendingDecodeCount()} worker jobs across ${this.decodeClient.getActiveWorkerCount()} workers); slowest ${slowestTile.tileKey} (${slowestTile.currentStageElapsedMs.toFixed(0)} ms).`;
          break;
        case 'reconstruct_waiting':
          blockerCategory = 'main_thread_reconstruct_waiting';
          blockerReason = `${reconstructWaitingCount} decoded destination tile(s) awaiting frame-budgeted reconstruction; slowest ${slowestTile.tileKey} (${slowestTile.mainThreadReconstructWaitMs.toFixed(0)} ms).`;
          break;
        case 'gpu_prep_waiting':
          blockerCategory = 'gpu_prep_waiting';
          blockerReason = `${gpuPrepWaitingCount} destination tile(s) awaiting incremental GPU upload; slowest ${slowestTile.tileKey} (${slowestTile.gpuPrepRemainingUnits} units left, ${slowestTile.gpuPrepWaitMs.toFixed(0)} ms wait).`;
          break;
        default:
          blockerCategory = 'error_or_missing';
          blockerReason = `Waiting for ${requiredVisibleCount - readyCount}/${requiredVisibleCount} required ${this.pendingResolutionMeters}m tile(s).`;
          break;
      }
    }

    const readinessRatio =
      requiredVisibleCount > 0
        ? Number((readyCount / requiredVisibleCount).toFixed(4))
        : 1;

    return {
      active: true,
      blockerCategory,
      blockerReason,
      fromResolutionMeters: this.activeResolutionMeters,
      toResolutionMeters: this.pendingResolutionMeters,
      transitionGeneration: this.transitionGeneration,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      requiredVisibleCount,
      readyCount,
      destinationCoverageReadinessRatio: readinessRatio,
      newlyRequiredDestinationTilesCount: this.currentTransitionNewlyRequiredTilesCount,
      queuedCount,
      fetchingCount,
      retrievedQueuedCount,
      decodingCount,
      reconstructWaitingCount,
      gpuPrepWaitingCount,
      failedCount,
      slowestOutstandingTile: slowestTile,
      oldestOutstandingTile: oldestTile,
      contention,
    };
  }

  private recordTransitionCriticalPath(params: {
    outcome: 'completed' | 'cancelled' | 'deferred_budget';
    fromResolutionMeters: number;
    toResolutionMeters: number;
    pendingLevel: ResolutionLevelState | null;
    finishedAtMs: number;
    activationSwapMs: number;
    cancelOrDeferReason: string | null;
    overrideGeneration?: number;
    overrideStartedAtMs?: number;
  }): void {
    const startedAtMs =
      params.overrideStartedAtMs ?? this.transitionStartedAtMs ?? params.finishedAtMs;
    const totalDurationMs = Math.max(0, params.finishedAtMs - startedAtMs);

    let requiredTileCount = 0;
    let reusedFromCacheCount = 0;
    let reusedFromPrewarmCount = 0;
    let earliestReadyAtMs = Number.POSITIVE_INFINITY;
    let latestReadyAtMs = 0;
    let criticalRecord: ManagedTileRecord | null = null;
    let criticalScore = -1;

    if (params.pendingLevel) {
      for (const rec of params.pendingLevel.tilesByKey.values()) {
        if (!rec.isVisibleInViewport) continue;
        requiredTileCount += 1;
        if (rec.pipeline.reusedFromCache) reusedFromCacheCount += 1;
        if (rec.pipeline.preparedByPrewarm) reusedFromPrewarmCount += 1;
        if (rec.pipeline.readyAtMs !== null) {
          earliestReadyAtMs = Math.min(earliestReadyAtMs, rec.pipeline.readyAtMs);
          latestReadyAtMs = Math.max(latestReadyAtMs, rec.pipeline.readyAtMs);
        }
        const tileEndMs = rec.pipeline.readyAtMs ?? params.finishedAtMs;
        const tilePipeSum =
          rec.pipeline.fetchQueueWaitMs +
          rec.pipeline.payloadRetrievalMs +
          rec.pipeline.retrievedQueueWaitMs +
          rec.pipeline.workerClientQueueWaitMs +
          rec.pipeline.workerThreadQueueWaitMs +
          rec.pipeline.workerInflateAndDecodeMs +
          rec.pipeline.workerBvhBuildMs +
          rec.pipeline.workerPayloadPrepMs +
          rec.pipeline.mainThreadReconstructWaitMs +
          rec.pipeline.reconstructMs +
          rec.pipeline.gpuPrepWaitMs +
          rec.pipeline.gpuPrepSubmitMs;
        const score =
          params.outcome === 'completed'
            ? tileEndMs - startedAtMs + tilePipeSum * 0.001
            : tilePipeSum + (rec.pipeline.readyAtMs === null ? 10_000 : 0);
        if (score > criticalScore) {
          criticalScore = score;
          criticalRecord = rec;
        }
      }
    }

    const cp = criticalRecord?.pipeline ?? createEmptyTilePipelineTimings();
    const workerQueueWaitMs = cp.workerClientQueueWaitMs + cp.workerThreadQueueWaitMs;
    const workerDecodeAndBvhMs =
      cp.workerInflateAndDecodeMs + cp.workerBvhBuildMs + cp.workerPayloadPrepMs;
    const gpuPrepTotalMs = cp.gpuPrepWaitMs + cp.gpuPrepSubmitMs;
    const remainingCoverageWaitMs =
      Number.isFinite(earliestReadyAtMs) && latestReadyAtMs >= earliestReadyAtMs
        ? Math.max(0, latestReadyAtMs - earliestReadyAtMs)
        : 0;
    const tailTileEnteredLateMs =
      cp.queuedAtMs !== null && cp.queuedAtMs > startedAtMs
        ? Math.max(0, cp.queuedAtMs - startedAtMs)
        : 0;

    let dominantBlockerCategory: TransitionBlockerCategory = 'none';
    if (params.outcome === 'deferred_budget') {
      dominantBlockerCategory = 'budget_deferred';
    } else {
      const stagePairs: Array<[TransitionBlockerCategory, number]> = [
        ['fetch_queue_contention', cp.fetchQueueWaitMs],
        ['network_fetching', cp.payloadRetrievalMs],
        ['retrieved_queue_waiting', cp.retrievedQueueWaitMs],
        ['worker_queue_waiting', workerQueueWaitMs],
        ['worker_decoding', workerDecodeAndBvhMs],
        ['main_thread_reconstruct_waiting', cp.mainThreadReconstructWaitMs + cp.reconstructMs],
        ['gpu_prep_waiting', gpuPrepTotalMs],
      ];
      let maxVal = 0;
      for (const [cat, val] of stagePairs) {
        if (val > maxVal) {
          maxVal = val;
          dominantBlockerCategory = cat;
        }
      }
    }

    const desiredToActivationMs =
      this.currentTransitionDebounceWaitMs + totalDurationMs;

    const record: TransitionCriticalPathRecord = {
      transitionGeneration: params.overrideGeneration ?? this.transitionGeneration,
      outcome: params.outcome,
      fromResolutionMeters: params.fromResolutionMeters,
      toResolutionMeters: params.toResolutionMeters,
      startedAtMs: Number(startedAtMs.toFixed(2)),
      finishedAtMs: Number(params.finishedAtMs.toFixed(2)),
      totalDurationMs: Number(totalDurationMs.toFixed(3)),
      debounceWaitMs: Number(this.currentTransitionDebounceWaitMs.toFixed(3)),
      desiredToActivationMs: Number(desiredToActivationMs.toFixed(3)),
      prewarmLeadTimeMs: Number(this.lastPreparationLeadTimeMs.toFixed(3)),
      activationSwapMs: Number(params.activationSwapMs.toFixed(3)),
      requiredTileCount,
      reusedFromCacheCount,
      reusedFromPrewarmCount,
      newlyRequiredTilesDuringTransitionCount:
        this.currentTransitionNewlyRequiredTilesCount,
      cancellationsDuringTransition: this.currentTransitionCancellations,
      dominantBlockerCategory,
      criticalPathTileKey: criticalRecord?.tileKey ?? null,
      stagesMs: {
        fetchQueueWaitMs: Number(cp.fetchQueueWaitMs.toFixed(3)),
        payloadRetrievalMs: Number(cp.payloadRetrievalMs.toFixed(3)),
        retrievedQueueWaitMs: Number(cp.retrievedQueueWaitMs.toFixed(3)),
        workerQueueWaitMs: Number(workerQueueWaitMs.toFixed(3)),
        workerInflateMs: Number(cp.workerInflateMs.toFixed(3)),
        workerDecodeOnlyMs: Number(cp.workerDecodeOnlyMs.toFixed(3)),
        workerInflateAndDecodeMs: Number(cp.workerInflateAndDecodeMs.toFixed(3)),
        workerBvhBuildMs: Number(cp.workerBvhBuildMs.toFixed(3)),
        workerDecodeAndBvhMs: Number(workerDecodeAndBvhMs.toFixed(3)),
        mainThreadReconstructWaitMs: Number(cp.mainThreadReconstructWaitMs.toFixed(3)),
        reconstructMs: Number(cp.reconstructMs.toFixed(3)),
        gpuPrepWaitMs: Number(cp.gpuPrepWaitMs.toFixed(3)),
        gpuPrepSubmitMs: Number(cp.gpuPrepSubmitMs.toFixed(3)),
        gpuPrepTotalMs: Number(gpuPrepTotalMs.toFixed(3)),
        remainingCoverageWaitMs: Number(remainingCoverageWaitMs.toFixed(3)),
        tailTileEnteredLateMs: Number(tailTileEnteredLateMs.toFixed(3)),
        activationSwapMs: Number(params.activationSwapMs.toFixed(3)),
      },
      cancelOrDeferReason: params.cancelOrDeferReason,
    };

    this.recentTransitions.push(record);
    if (this.recentTransitions.length > 64) {
      this.recentTransitions.shift();
    }
    if (params.outcome === 'completed') {
      this.lastCompletedTransition = record;
    }
  }

  private computeHierarchicalResourceAccounting(): HierarchicalResourceAccountingSnapshot {
    const byResolution: ResolutionResourceAccounting[] = [];
    let activeGeometryBytes = 0;
    let pendingDestinationGeometryBytes = 0;
    let estimatedWorkerPrepBufferBytes = 0;
    let queuedDecodedPayloadBytes = 0;
    let instancedSpatialIndexBytes = 0;
    let staticBvhBytes = 0;
    let retainedInactiveTilesBytes = 0;
    let totalMeasuredBytes = 0;
    let totalEstimatedGpuBytes = 0;

    const disposalAccounting = this.deferredDisposalQueue.getAccountingSnapshot();
    const sortedResolutions = [...this.levelsByResolution.keys()].sort(
      (a, b) => a - b
    );
    for (const resMeters of sortedResolutions) {
      const level = this.levelsByResolution.get(resMeters)!;
      const acc = createEmptyResolutionAccounting(resMeters);
      for (const record of level.tilesByKey.values()) {
        if (record.state === 'loaded') acc.attachedActiveTiles += 1;
        else if (record.state === 'prepared_inactive') acc.preparedPendingTiles += 1;
        else if (record.state === 'cached_inactive') acc.cachedInactiveTiles += 1;
        else if (record.state === 'queued') acc.queuedTiles += 1;
        else if (record.state === 'fetching') acc.fetchingTiles += 1;
        else if (
          record.state === 'retrieved_queued' ||
          record.state === 'decoding'
        ) {
          acc.decodingTiles += 1;
        } else if (record.state === 'ready_to_commit') {
          acc.readyToCommitTiles += 1;
        }

        const b = this.computeRecordFootprintBreakdown(record);
        acc.measuredCpuGeometryBytes += b.cpuGeometryBytes;
        acc.measuredStaticBvhBytes += b.staticBvhBytes;
        acc.measuredInstancedIndexBytes += b.instancedIndexBytes;
        acc.measuredQueuedDecodedBytes += b.queuedDecodedBytes;
        acc.estimatedWorkerBufferBytes += b.estimatedWorkerBytes;
        acc.estimatedGpuBytes += b.estimatedGpuBytes;

        if (record.state === 'cached_inactive') {
          acc.measuredRetainedInactiveBytes += b.totalMeasuredBytes;
          retainedInactiveTilesBytes += b.totalMeasuredBytes;
        } else if (record.state === 'loaded') {
          activeGeometryBytes += b.cpuGeometryBytes;
        } else if (
          record.state === 'prepared_inactive' ||
          (record.state === 'ready_to_commit' &&
            record.resolutionMeters === this.pendingResolutionMeters)
        ) {
          pendingDestinationGeometryBytes +=
            b.cpuGeometryBytes + b.queuedDecodedBytes;
        }

        estimatedWorkerPrepBufferBytes += b.estimatedWorkerBytes;
        queuedDecodedPayloadBytes += b.queuedDecodedBytes;
        instancedSpatialIndexBytes += b.instancedIndexBytes;
        staticBvhBytes += b.staticBvhBytes;
        totalMeasuredBytes += b.totalMeasuredBytes;
        totalEstimatedGpuBytes += b.estimatedGpuBytes;
      }

      const resPending = disposalAccounting.byResolution[resMeters];
      if (resPending) {
        acc.pendingDisposalTiles = resPending.tiles;
        acc.measuredPendingDisposalBytes = resPending.bytes;
      }
      byResolution.push(acc);
    }

    totalMeasuredBytes += disposalAccounting.pendingBytes;
    totalEstimatedGpuBytes += disposalAccounting.pendingEstimatedGpuBytes;

    return {
      budget: { ...this.hierarchicalBudget },
      activeGeometryBytes,
      pendingDestinationGeometryBytes,
      estimatedWorkerPrepBufferBytes,
      queuedDecodedPayloadBytes,
      instancedSpatialIndexBytes,
      staticBvhBytes,
      retainedInactiveTilesBytes,
      pendingDisposalTiles: disposalAccounting.pendingTiles,
      pendingDisposalBytes: disposalAccounting.pendingBytes,
      totalMeasuredBytes,
      totalEstimatedGpuBytes,
      speculativeBackpressureActive: this.speculativeBackpressureActive,
      workerBackpressureActive: this.workerBackpressureActive,
      byResolution,
    };
  }

  private disposeReconstructedTile(
    record: ManagedTileRecord,
    isCacheEviction: boolean,
    forceImmediate = false
  ): void {
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    const t0 = prof ? this.nowFn() : 0;
    const fp = record.decodedFootprint;
    const breakdown = this.computeRecordFootprintBreakdown(record);
    if (record.state === 'loaded') {
      this.detachTileFromCompositeScene(record);
    }
    this.releaseRecordStageReservations(record);
    const reconstructed = record.reconstructed;
    record.reconstructed = null;
    record.decodedPayload = null;
    record.decodedFootprint = null;
    record.state = 'unloaded';
    this.evictedTilesTotal += 1;
    if (isCacheEviction) {
      this.cacheEvictionsTotal += 1;
    }

    if (reconstructed) {
      this.gpuPreparer.cancelTile(record.tileKey, reconstructed, true);
      if (this.streamingFrameBudget.deferredDisposalEnabled && !forceImmediate) {
        this.deferredDisposalQueue.enqueue({
          tileKey: record.tileKey,
          resolutionMeters: record.resolutionMeters,
          lod: record.manifest.lod,
          reconstructed,
          measuredBytes: breakdown.totalMeasuredBytes,
          estimatedGpuBytes: breakdown.estimatedGpuBytes,
          isCacheEviction,
        });
        if (prof) {
          prof.recordEvent({
            eventType: 'deferred_dispose_enqueue',
            tileKey: record.tileKey,
            tileSizeMeters: record.resolutionMeters,
            lod: record.manifest.lod,
            payloadCompressedBytes: record.lastCompressedBytes ?? null,
            payloadRawBytes: breakdown.totalMeasuredBytes,
            durationMs: Math.max(0, this.nowFn() - t0),
            queueDepths: this.getQueueDepthSnapshot(),
            detail: {
              deferredDisposePendingTiles: this.deferredDisposalQueue.size,
              deferredDisposePendingBytes: this.deferredDisposalQueue.totalPendingBytes,
            },
          });
        }
        return;
      }
      reconstructed.dispose();
    }

    if (prof) {
      prof.recordEvent({
        eventType: isCacheEviction ? 'cache_evict' : 'evict',
        tileKey: record.tileKey,
        tileSizeMeters: record.resolutionMeters,
        lod: record.manifest.lod,
        payloadCompressedBytes: record.lastCompressedBytes ?? null,
        payloadRawBytes: fp ? fp.cpuGeometryBytes + fp.bvhBytes : null,
        durationMs: Math.max(0, this.nowFn() - t0),
        queueDepths: this.getQueueDepthSnapshot(),
      });
    }
  }

  private enforceResourceBudgets(): void {
    if (!this.hierarchy) return;
    const budget = this.hierarchicalBudget;

    // 1. Enforce inactive cache tile count & byte limits via LRU order
    const cachedRecords: Array<{ record: ManagedTileRecord; bytes: number }> = [];
    let cachedBytesTotal = 0;
    for (const record of this.tilesByKey.values()) {
      if (record.state === 'cached_inactive') {
        const bytes = this.computeRecordFootprintBreakdown(record).totalMeasuredBytes;
        cachedRecords.push({ record, bytes });
        cachedBytesTotal += bytes;
      }
    }
    cachedRecords.sort((a, b) => a.record.lastUsedAtMs - b.record.lastUsedAtMs);

    while (
      cachedRecords.length > 0 &&
      (cachedRecords.length > budget.maxInactiveCachedTiles ||
        cachedBytesTotal > budget.inactiveCacheBudgetBytes)
    ) {
      const oldest = cachedRecords.shift()!;
      this.disposeReconstructedTile(oldest.record, true);
      cachedBytesTotal = Math.max(0, cachedBytesTotal - oldest.bytes);
    }

    // 2. Enforce total measured memory budget across all resolutions (including pending disposals!)
    let totalMeasured = this.computeTotalMeasuredMemoryBytes();

    // 2-pre: If pending deferred disposals exceed cap or push total over budget, accelerate draining FIRST
    if (
      this.deferredDisposalQueue.size > 0 &&
      (totalMeasured > budget.totalMemoryBudgetBytes ||
        this.deferredDisposalQueue.totalPendingBytes >
          this.streamingFrameBudget.maxPendingDisposalBytes)
    ) {
      const excessOverBudget = Math.max(
        0,
        totalMeasured - budget.totalMemoryBudgetBytes
      );
      const targetPendingBytes = Math.min(
        this.streamingFrameBudget.maxPendingDisposalBytes,
        Math.max(0, this.deferredDisposalQueue.totalPendingBytes - excessOverBudget)
      );
      const drained = this.deferredDisposalQueue.drainToTargetBytes(targetPendingBytes);
      totalMeasured = Math.max(0, totalMeasured - drained.disposedBytes);
    }

    // 2-prewarm: Cancel/dispose opportunistic predictive prewarm tiles before touching cached or active tiles
    if (totalMeasured > budget.totalMemoryBudgetBytes && this.prewarmTargetResolutionMeters !== null) {
      const prewarmLevel = this.getPrewarmLevelState();
      if (prewarmLevel) {
        for (const record of prewarmLevel.tilesByKey.values()) {
          if (totalMeasured <= budget.totalMemoryBudgetBytes) break;
          if (
            record.state === 'queued' ||
            record.state === 'fetching' ||
            record.state === 'retrieved_queued' ||
            record.state === 'decoding' ||
            record.state === 'ready_to_commit'
          ) {
            const bytes = this.computeRecordFootprintBreakdown(record).totalMeasuredBytes;
            this.cancelInFlightTile(record);
            totalMeasured = Math.max(0, totalMeasured - bytes);
          } else if (record.state === 'prepared_inactive') {
            const bytes = this.computeRecordFootprintBreakdown(record).totalMeasuredBytes;
            this.disposeReconstructedTile(record, false, true);
            totalMeasured = Math.max(0, totalMeasured - bytes);
          }
        }
      }
      this.prewarmTargetResolutionMeters = null;
    }

    if (totalMeasured > budget.totalMemoryBudgetBytes) {
      // 2a. Evict remaining LRU cached_inactive tiles first (forceImmediate under active pressure so bytes reclaim now)
      while (
        totalMeasured > budget.totalMemoryBudgetBytes &&
        cachedRecords.length > 0
      ) {
        const oldest = cachedRecords.shift()!;
        this.disposeReconstructedTile(oldest.record, true, true);
        totalMeasured = Math.max(0, totalMeasured - oldest.bytes);
      }
    }

    if (totalMeasured > budget.totalMemoryBudgetBytes) {
      // 2b. Evict non-visible speculative pending tiles (farthest first)
      const pendingLevel = this.getPendingLevelState();
      if (pendingLevel) {
        const nonVisPending: Array<{ record: ManagedTileRecord; bytes: number }> = [];
        for (const record of pendingLevel.tilesByKey.values()) {
          if (
            !record.isVisibleInViewport &&
            (record.state === 'prepared_inactive' ||
              record.state === 'ready_to_commit')
          ) {
            const bytes =
              this.computeRecordFootprintBreakdown(record).totalMeasuredBytes;
            nonVisPending.push({ record, bytes });
          }
        }
        nonVisPending.sort((a, b) => b.record.priorityScore - a.record.priorityScore);
        for (const item of nonVisPending) {
          if (totalMeasured <= budget.totalMemoryBudgetBytes) break;
          if (item.record.state === 'ready_to_commit') {
            this.cancelInFlightTile(item.record);
          } else {
            this.disposeReconstructedTile(item.record, false, true);
          }
          totalMeasured = Math.max(0, totalMeasured - item.bytes);
        }
      }
    }

    if (totalMeasured > budget.totalMemoryBudgetBytes) {
      // 2c. Evict non-visible active preload tiles (NEVER evict active visible tiles!)
      const activeLevel = this.getActiveLevelState();
      if (activeLevel) {
        const nonVisActive: Array<{ record: ManagedTileRecord; bytes: number }> = [];
        for (const record of activeLevel.tilesByKey.values()) {
          if (
            !record.isVisibleInViewport &&
            (record.state === 'loaded' || record.state === 'ready_to_commit')
          ) {
            const bytes =
              this.computeRecordFootprintBreakdown(record).totalMeasuredBytes;
            nonVisActive.push({ record, bytes });
          }
        }
        nonVisActive.sort((a, b) => b.record.priorityScore - a.record.priorityScore);
        let evictedAnyActive = false;
        for (const item of nonVisActive) {
          if (totalMeasured <= budget.totalMemoryBudgetBytes) break;
          if (item.record.state === 'ready_to_commit') {
            this.cancelInFlightTile(item.record);
          } else {
            this.evictLoadedTile(item.record, true);
            evictedAnyActive = true;
          }
          totalMeasured = Math.max(0, totalMeasured - item.bytes);
        }
        if (evictedAnyActive) {
          this.rebuildCompositeStats();
        }
      }
    }

    // 2d. Impossible budget guard: if STILL over budget while a transition is in progress
    // (active visible + pending required destination alone exceed budget), defer cleanly
    // without evicting active visible coverage!
    if (
      totalMeasured > budget.totalMemoryBudgetBytes &&
      this.pendingResolutionMeters !== null &&
      this.transitionState !== 'deferred_budget'
    ) {
      if (this.deferredDisposalQueue.size > 0) {
        const drained = this.deferredDisposalQueue.flushAll();
        totalMeasured = Math.max(0, totalMeasured - drained.disposedBytes);
      }
      if (totalMeasured > budget.totalMemoryBudgetBytes) {
        const measuredMb = (totalMeasured / (1024 * 1024)).toFixed(2);
        const budgetMb = (budget.totalMemoryBudgetBytes / (1024 * 1024)).toFixed(2);
        this.deferPendingTransitionForBudget(
          `Transition to ${this.pendingResolutionMeters} m deferred: active visible + replacement coverage (${measuredMb} MiB) exceeds total memory budget (${budgetMb} MiB).`
        );
        totalMeasured = this.computeTotalMeasuredMemoryBytes();
      }
    }

    // 3. Update speculative backpressure flag based on transition reserve
    const reserveCutoffBytes =
      budget.totalMemoryBudgetBytes * (1 - budget.transitionReserveRatio);
    this.speculativeBackpressureActive = totalMeasured >= reserveCutoffBytes;
  }

  private computeThroughputPipelineSnapshot(): StreamingThroughputPipelineSnapshot {
    let fetchQueuedCount = 0;
    let httpRetrievingCount = 0;
    let retrievedQueuedCount = 0;
    let workerDecodingCount = 0;
    let preparedQueuedCount = 0;
    let preparedPayloadQueueBytes = 0;
    let reconstructedAwaitingGpuBytes = 0;

    for (const record of this.tilesByKey.values()) {
      if (record.state === 'queued') fetchQueuedCount += 1;
      else if (record.state === 'fetching') httpRetrievingCount += 1;
      else if (record.state === 'retrieved_queued') retrievedQueuedCount += 1;
      else if (record.state === 'decoding') workerDecodingCount += 1;
      else if (record.state === 'ready_to_commit') {
        preparedQueuedCount += 1;
        if (record.decodedFootprint) {
          preparedPayloadQueueBytes +=
            record.decodedFootprint.cpuGeometryBytes +
            record.decodedFootprint.bvhBytes;
        }
      } else if (
        record.state === 'prepared_inactive' &&
        record.reconstructed &&
        !this.gpuPreparer.isTilePrepared(record.reconstructed)
      ) {
        const fp = record.decodedFootprint;
        if (fp) {
          reconstructedAwaitingGpuBytes += fp.cpuGeometryBytes;
        }
      }
    }

    const workerUtil = this.decodeClient.getWorkerUtilizationSnapshot();
    const httpMibPerSec =
      this.totalHttpRetrievalDurationMs > 0
        ? (this.totalNetworkTransferBytes / (1024 * 1024)) /
          (this.totalHttpRetrievalDurationMs / 1000)
        : 0;
    const decodeRawMibPerSec =
      this.totalWorkerActiveDurationMs > 0
        ? (this.totalRawPayloadBytesDecoded / (1024 * 1024)) /
          (this.totalWorkerActiveDurationMs / 1000)
        : 0;
    const tilesDecodedPerSec =
      this.totalWorkerActiveDurationMs > 0
        ? this.totalTilesDecoded / (this.totalWorkerActiveDurationMs / 1000)
        : 0;

    return {
      independentPipelineStagesEnabled:
        this.streamingFrameBudget.independentPipelineStagesEnabled,
      useCompressedHttpTransfer:
        this.streamingFrameBudget.useCompressedHttpTransfer,
      maxConcurrentHttpRetrievals: this.getEffectiveMaxConcurrentHttpRetrievals(),
      workerConcurrency: workerUtil.maxConcurrentWorkers,
      reservedDestinationFetchSlots:
        this.streamingFrameBudget.reservedDestinationFetchSlots,
      reservedDestinationWorkerSlots:
        this.streamingFrameBudget.reservedDestinationWorkerSlots,
      fetchQueuedCount,
      httpRetrievingCount,
      retrievedQueuedCount,
      workerDecodingCount,
      preparedQueuedCount,
      inFlightHttpReservationBytes: this.inFlightHttpReservationBytes,
      retrievedPayloadQueueBytes: this.retrievedPayloadQueueBytes,
      inFlightWorkerPreparationBytes: this.inFlightWorkerPreparationBytes,
      preparedPayloadQueueBytes,
      reconstructedAwaitingGpuBytes,
      busyWorkerCount: workerUtil.busyWorkerCount,
      idleWorkerCount: workerUtil.idleWorkerCount,
      activeDestinationFetchCount: this.activeDestinationFetchCount,
      activeDestinationWorkerCount: workerUtil.activeDestinationWorkerCount,
      totalNetworkTransferBytes: this.totalNetworkTransferBytes,
      totalRawPayloadBytesDecoded: this.totalRawPayloadBytesDecoded,
      sustainedHttpTransferMibPerSec: Number(httpMibPerSec.toFixed(3)),
      sustainedDecodeRawMibPerSec: Number(decodeRawMibPerSec.toFixed(3)),
      sustainedTilesDecodedPerSec: Number(tilesDecodedPerSec.toFixed(3)),
      avgRetrievedQueueWaitMs:
        this.decodeSamples > 0
          ? Number((this.totalRetrievedQueueWaitMs / this.decodeSamples).toFixed(3))
          : 0,
      avgServerSqliteLookupMs:
        this.serverHeaderSamples > 0
          ? Number(
              (this.totalServerSqliteLookupMs / this.serverHeaderSamples).toFixed(3)
            )
          : 0,
      avgServerInflateMs:
        this.serverHeaderSamples > 0
          ? Number(
              (this.totalServerInflateMs / this.serverHeaderSamples).toFixed(3)
            )
          : 0,
      avgServerTotalMs:
        this.serverHeaderSamples > 0
          ? Number(
              (this.totalServerTotalMs / this.serverHeaderSamples).toFixed(3)
            )
          : 0,
      dynamicReprioritizationsTotal: this.dynamicReprioritizationsTotal,
      tailTileBoostsAppliedTotal: this.tailTileBoostsAppliedTotal,
      ageEscalationsAppliedTotal: this.ageEscalationsAppliedTotal,
      oversizedPayloadAdmissionsTotal: this.oversizedPayloadAdmissionsTotal,
      runningWorkerJobsRetainedAfterDemotionTotal:
        this.runningWorkerJobsRetainedAfterDemotionTotal,
      discardedPreparedTilesTotal: this.discardedPreparedTilesTotal,
      wastedNetworkBytes: this.wastedNetworkBytes,
      wastedWorkerTimeMs: Number(
        (this.wastedWorkerTimeMs + workerUtil.wastedWorkerTimeMs).toFixed(3)
      ),
      wastedPrewarmBytes: this.wastedPrewarmBytes,
      prewarmedTilesActivatedTotal: this.prewarmedTilesActivatedTotal,
      lastPreparationLeadTimeMs: Number(this.lastPreparationLeadTimeMs.toFixed(2)),
      historicalPrepLatencyByResMs: { ...this.historicalPrepLatencyByResMs },
    };
  }

  getDiagnostics(): TileStreamDiagnosticsSnapshot {
    let visibleTiles = 0;
    let fetchTargetTiles = 0;
    let keepTargetTiles = 0;
    let loadedTiles = 0;
    let emptyLoadedTiles = 0;
    let queuedTiles = 0;
    let fetchingTiles = 0;
    let retrievedQueuedTiles = 0;
    let decodingTiles = 0;
    let readyToCommitTiles = 0;
    let failedTiles = 0;

    let loadedMeshCount = 0;
    let visibleMeshCount = 0;
    let loadedTriangles = 0;
    let loadedVertices = 0;
    let loadedDrawCallsEstimate = 0;
    let activeTileGeometries = 0;
    let activeTileBvhs = 0;
    let tileCpuGeometryBytes = 0;
    let tileBvhBytes = 0;
    let tileInstancedIndexBytes = 0;
    let tileInstancedIndexCount = 0;
    let tileInstancedIndexInstances = 0;
    let tileInstancedIndexBuildMsTotal = 0;
    let pendingReadyTileBytes = 0;

    const loadedTileKeys: string[] = [];
    const visibleTileKeys: string[] = [];
    const loadingTileKeys: string[] = [];

    const activeLevel = this.getActiveLevelState();
    const activeRecords = activeLevel ? activeLevel.tilesByKey : this.tilesByKey;

    for (const [key, record] of activeRecords.entries()) {
      if (record.isVisibleInViewport) {
        visibleTiles += 1;
        visibleTileKeys.push(key);
      }
      if (record.isInFetchSet) fetchTargetTiles += 1;
      if (record.isInKeepSet) keepTargetTiles += 1;

      if (record.state === 'loaded') {
        loadedTiles += 1;
        loadedTileKeys.push(key);
        if (record.manifest.isEmpty) {
          emptyLoadedTiles += 1;
        }
        const fp = record.decodedFootprint;
        if (fp) {
          loadedMeshCount += fp.meshCount;
          if (record.isVisibleInViewport) {
            visibleMeshCount += fp.meshCount;
          }
          loadedTriangles += fp.triangleCount;
          loadedVertices += fp.vertexCount;
          activeTileBvhs += fp.bvhCount;
          tileCpuGeometryBytes += fp.cpuGeometryBytes;
          tileBvhBytes += fp.bvhBytes;
        }
        if (record.reconstructed) {
          loadedDrawCallsEstimate +=
            record.reconstructed.scene.stats.totalDrawCalls;
          activeTileGeometries +=
            record.reconstructed.scene.resources.ownedGeometriesCount;
          const pStats = record.reconstructed.instancedPickingStats;
          if (pStats) {
            tileInstancedIndexBytes += pStats.totalIndexMemoryBytes;
            tileInstancedIndexCount += pStats.indexedBatchCount;
            tileInstancedIndexInstances += pStats.totalIndexedInstances;
            tileInstancedIndexBuildMsTotal += pStats.totalBuildTimeMs;
          }
        }
      }
    }

    // In-flight queues span active + pending levels
    let pendingQueued = 0;
    let pendingFetching = 0;
    let pendingRetrievedQueued = 0;
    let pendingDecoding = 0;
    let pendingReadyToCommit = 0;
    let pendingPreparedTiles = 0;

    for (const [key, record] of this.tilesByKey.entries()) {
      const isPendingRes =
        this.hierarchy !== null &&
        record.resolutionMeters === this.pendingResolutionMeters;
      if (record.state === 'queued') {
        queuedTiles += 1;
        loadingTileKeys.push(key);
        if (isPendingRes) pendingQueued += 1;
      } else if (record.state === 'fetching') {
        fetchingTiles += 1;
        loadingTileKeys.push(key);
        if (isPendingRes) pendingFetching += 1;
      } else if (record.state === 'retrieved_queued') {
        retrievedQueuedTiles += 1;
        loadingTileKeys.push(key);
        if (isPendingRes) pendingRetrievedQueued += 1;
      } else if (record.state === 'decoding') {
        decodingTiles += 1;
        loadingTileKeys.push(key);
        if (isPendingRes) pendingDecoding += 1;
      } else if (record.state === 'ready_to_commit') {
        readyToCommitTiles += 1;
        loadingTileKeys.push(key);
        if (isPendingRes) pendingReadyToCommit += 1;
        if (record.decodedFootprint) {
          pendingReadyTileBytes +=
            record.decodedFootprint.cpuGeometryBytes +
            record.decodedFootprint.bvhBytes;
        }
      } else if (record.state === 'prepared_inactive' && isPendingRes) {
        pendingPreparedTiles += 1;
      } else if (record.state === 'error') {
        failedTiles += 1;
        if (!this.lastTileError && record.lastError) {
          this.lastTileError = `${key}: ${record.lastError}`;
        }
      }
    }

    const loadingTiles =
      queuedTiles +
      fetchingTiles +
      retrievedQueuedTiles +
      decodingTiles +
      readyToCommitTiles;
    this.peakLoadedTiles = Math.max(this.peakLoadedTiles, loadedTiles);
    this.peakLoadingTiles = Math.max(this.peakLoadingTiles, loadingTiles);

    const isLoaded = this.manifestStatus === 'loaded' && this.metadata !== null;
    const loadedPackPath = isLoaded ? this.manifestPackPath : null;

    const frameBudgetDiag: StreamingFrameBudgetDiagnosticsSnapshot = {
      config: { ...this.streamingFrameBudget },
      variant: identifyStreamingF1Variant(this.streamingFrameBudget),
      scheduler: this.workloadScheduler.getStats(),
      gpuPreparer: this.gpuPreparer.getStats(),
      deferredDisposal: this.deferredDisposalQueue.getAccountingSnapshot(),
      pendingDebounceTargetResolution: this.pendingDebounceTargetResolution,
      pendingDebounceElapsedMs:
        this.pendingDebounceStartedAtMs !== null
          ? Number(Math.max(0, this.nowFn() - this.pendingDebounceStartedAtMs).toFixed(2))
          : 0,
      transitionsDebouncedAvoided: this.transitionsDebouncedAvoidedTotal,
      destinationPrepReused: this.destinationPrepReusedTotal,
      hasValidViewportCoverage: !this.hasActiveVisibleCoverageGap(),
      boundaryOverlayDirty: this.boundaryOverlayDirty,
      boundaryOverlayRebuildMsTotal: Number(this.boundaryOverlayRebuildMsTotal.toFixed(3)),
    };

    const throughputPipeline = this.computeThroughputPipelineSnapshot();

    let hierarchicalDiag: HierarchicalStreamingDiagnosticsSnapshot | null = null;
    if (this.hierarchy && isLoaded && this.activeResolutionMeters !== null) {
      const pendingLevel = this.getPendingLevelState();
      const readiness = pendingLevel
        ? this.checkDestinationReadiness(pendingLevel)
        : { requiredCount: 0, readyCount: 0, gpuPreparedCount: 0, allReady: true };
      const margins = resolvePhysicalMarginsForResolution(
        this.activeResolutionMeters,
        this.hierarchicalPolicy
      );
      const resources = this.computeHierarchicalResourceAccounting();
      const transitionElapsedMs =
        this.transitionStartedAtMs !== null
          ? Math.max(0, this.nowFn() - this.transitionStartedAtMs)
          : 0;
      const currentTransitionBlocker =
        this.computeCurrentTransitionBlockerSnapshot(resources);
      const destinationCoverageReadinessRatio =
        readiness.requiredCount > 0
          ? Number(
              (
                (this.isIncrementalGpuPrepActive()
                  ? readiness.gpuPreparedCount
                  : readiness.readyCount) / readiness.requiredCount
              ).toFixed(3)
            )
          : 1;

      hierarchicalDiag = {
        enabled: true,
        hierarchyName: this.hierarchy.hierarchyName,
        availableResolutionsMeters: [...this.hierarchy.resolutionsMeters],
        resolutionMode: this.hierarchicalPolicy.mode,
        desiredResolutionMeters:
          this.desiredResolutionMeters ?? this.activeResolutionMeters,
        activeResolutionMeters: this.activeResolutionMeters,
        pendingResolutionMeters: this.pendingResolutionMeters,
        prewarmTargetResolutionMeters: this.prewarmTargetResolutionMeters,
        transitionState: this.transitionState,
        transitionGeneration: this.transitionGeneration,
        transitionElapsedMs: Number(transitionElapsedMs.toFixed(2)),
        budgetDeferralReason: this.budgetDeferralReason,
        requiredDestinationTiles: readiness.requiredCount,
        readyDestinationTiles: readiness.readyCount,
        gpuPreparedDestinationTiles: readiness.gpuPreparedCount,
        destinationCoverageReadinessRatio,
        activeVisibleTiles: visibleTiles,
        activeLoadedTiles: loadedTiles,
        pendingPreparedTiles,
        rawCameraZoom: this.currentCameraZoom,
        effectiveScalePxPerMeter:
          this.lastScaleEval?.effectiveScalePxPerMeter ?? this.currentCameraZoom,
        viewportScaleFactor: this.lastScaleEval?.viewportScaleFactor ?? 1.0,
        viewportWidthPx: this.currentViewportWidthPx,
        viewportHeightPx: this.currentViewportHeightPx,
        selectionReason: this.lastScaleEval?.reason ?? 'initial_nominal_scale',
        policy: this.getHierarchicalPolicyConfig(),
        preloadMarginMeters: margins.preloadMarginMeters,
        retainMarginMeters: margins.retainMarginMeters,
        resources,
        pendingQueues: {
          queued: pendingQueued,
          fetching: pendingFetching,
          retrievedQueued: pendingRetrievedQueued,
          decoding: pendingDecoding,
          readyToCommit: pendingReadyToCommit,
        },
        counters: {
          transitionsStarted: this.transitionsStartedTotal,
          transitionsCompleted: this.transitionsCompletedTotal,
          transitionsCancelled: this.transitionsCancelledTotal,
          transitionsDeferredBudget: this.transitionsDeferredBudgetTotal,
          transitionsDebouncedAvoided: this.transitionsDebouncedAvoidedTotal,
          destinationPrepReused: this.destinationPrepReusedTotal,
          prewarmTilesPrepared: this.prewarmTilesPreparedTotal,
          prewarmReusedOnTransition: this.prewarmReusedOnTransitionTotal,
          cacheHits: this.cacheHitsTotal,
          cacheEvictions: this.cacheEvictionsTotal,
        },
        timings: {
          lastTransitionTotalMs: Number(this.lastTransitionTotalMs.toFixed(3)),
          lastActivationSwapMs: Number(this.lastActivationSwapMs.toFixed(3)),
          maxActivationSwapMs: Number(this.maxActivationSwapMs.toFixed(3)),
          activationSwapMsStats: summarizeTimingSamples(this.activationSwapMsRing),
          transitionDurationMsStats: summarizeTimingSamples(
            this.transitionDurationMsRing
          ),
        },
        currentTransitionBlocker,
        lastCompletedTransition: this.lastCompletedTransition
          ? {
              ...this.lastCompletedTransition,
              stagesMs: { ...this.lastCompletedTransition.stagesMs },
            }
          : null,
        recentTransitions: this.recentTransitions.map((t) => ({
          ...t,
          stagesMs: { ...t.stagesMs },
        })),
        frameBudget: frameBudgetDiag,
        throughputPipeline,
      };
    }

    return {
      manifestStatus: this.manifestStatus,
      manifestError: this.manifestError,
      activeMosaicName: this.hierarchy
        ? this.hierarchy.hierarchyName
        : deriveActiveMosaicNameFromPackPath(loadedPackPath),
      packPath: loadedPackPath,
      apiBaseUrl: this.apiBaseUrl,
      snapshotId: isLoaded ? this.metadata!.snapshotId : 'uninitialized',
      bakeSchemaVersion: isLoaded ? this.metadata!.bakeSchemaVersion : 'uninitialized',
      tileSizeMeters: isLoaded ? this.metadata!.tileSizeMeters : 512,
      preloadMarginTiles: this.preloadMarginTiles,
      retainMarginTiles: this.retainMarginTiles,
      totalGridCols: isLoaded ? this.metadata!.gridCols : 8,
      totalGridRows: isLoaded ? this.metadata!.gridRows : 8,
      totalGridTiles: activeRecords.size,
      visibleTiles,
      fetchTargetTiles,
      keepTargetTiles,
      loadedTiles,
      peakLoadedTiles: this.peakLoadedTiles,
      emptyLoadedTiles,
      loadingTiles,
      peakLoadingTiles: this.peakLoadingTiles,
      queuedTiles,
      fetchingTiles,
      retrievedQueuedTiles,
      decodingTiles,
      readyToCommitTiles,
      failedTiles,
      lastTileError: this.lastTileError,
      evictedTilesTotal: this.evictedTilesTotal,
      cancelledRequestsTotal: this.cancelledRequestsTotal,
      duplicateRequestsSkippedTotal: this.duplicateRequestsSkippedTotal,
      completedLoadsTotal: this.completedLoadsTotal,
      loadedMeshCount,
      visibleMeshCount,
      loadedTriangles,
      loadedVertices,
      loadedDrawCallsEstimate,
      activeTileGeometries,
      activeTileBvhs,
      sharedMaterialCount: this.materialRegistry.materialCount,
      tileCpuGeometryBytes,
      tileBvhBytes,
      compositeSceneRevision: this.compositeSceneRevision,
      lastManifestLoadMs: this.lastManifestLoadMs,
      avgFetchMs:
        this.fetchSamples > 0 ? this.totalFetchMs / this.fetchSamples : 0,
      avgDecodeMs:
        this.decodeSamples > 0 ? this.totalDecodeMs / this.decodeSamples : 0,
      avgReconstructMs:
        this.reconstructSamples > 0
          ? this.totalReconstructMs / this.reconstructSamples
          : 0,
      lastCommitMs: this.lastCommitMs,
      maxCommitMs: this.maxCommitMs,
      fetchMsStats: summarizeTimingSamples(this.fetchMsRing),
      decodeMsStats: summarizeTimingSamples(this.decodeMsRing),
      reconstructMsStats: summarizeTimingSamples(this.reconstructMsRing),
      commitMsStats: summarizeTimingSamples(this.commitMsRing),
      viewportBounds: this.currentViewport,
      loadedTileKeys,
      visibleTileKeys,
      loadingTileKeys,
      viewportSelectionPasses: this.viewportSelectionPasses,
      viewportSelectionSkips: this.viewportSelectionSkips,
      zoomPropagationSkips: this.zoomPropagationSkips,
      activeFoliageLod: this.foliageRuntimeState.activeLod,
      foliageTrunksVisible: this.foliageRuntimeState.trunksVisible,
      foliageFrustumCullingEnabled: this.foliageRuntimeState.frustumCullingEnabled,
      sharedFoliagePrototypeCount: this.foliagePrototypeRegistry.disposed
        ? 0
        : this.foliagePrototypeRegistry.geometryCount,
      tileInstancedIndexBytes,
      tileInstancedIndexCount,
      tileInstancedIndexInstances,
      tileInstancedIndexBuildMsTotal: Number(tileInstancedIndexBuildMsTotal.toFixed(3)),
      tilePreparationVariant: identifyTilePreparationVariant(this.tilePrepOptions),
      workerBvhAdoptedTotal: this.workerBvhAdoptedTotal,
      syncBvhFallbackTotal: this.syncBvhFallbackTotal,
      pendingReadyTileBytes,
      frameBudget: frameBudgetDiag,
      throughputPipeline,
      hierarchical: hierarchicalDiag,
    };
  }

  /**
   * Resets cumulative scenario counters and latency sample rings without altering loaded tiles.
   */
  resetPerformanceCounters(): void {
    let loadedNow = 0;
    let loadingNow = 0;
    for (const record of this.tilesByKey.values()) {
      if (record.state === 'loaded') loadedNow += 1;
      else if (
        record.state === 'queued' ||
        record.state === 'fetching' ||
        record.state === 'retrieved_queued' ||
        record.state === 'decoding' ||
        record.state === 'ready_to_commit'
      ) {
        loadingNow += 1;
      }
    }
    this.evictedTilesTotal = 0;
    this.cancelledRequestsTotal = 0;
    this.duplicateRequestsSkippedTotal = 0;
    this.completedLoadsTotal = 0;
    this.workerBvhAdoptedTotal = 0;
    this.syncBvhFallbackTotal = 0;
    this.viewportSelectionPasses = 0;
    this.viewportSelectionSkips = 0;
    this.zoomPropagationSkips = 0;
    this.peakLoadedTiles = loadedNow;
    this.peakLoadingTiles = loadingNow;
    this.totalFetchMs = 0;
    this.fetchSamples = 0;
    this.totalDecodeMs = 0;
    this.decodeSamples = 0;
    this.totalReconstructMs = 0;
    this.reconstructSamples = 0;
    this.lastCommitMs = 0;
    this.maxCommitMs = 0;
    this.fetchMsRing.length = 0;
    this.decodeMsRing.length = 0;
    this.reconstructMsRing.length = 0;
    this.commitMsRing.length = 0;
    this.transitionsStartedTotal = 0;
    this.transitionsCompletedTotal = 0;
    this.transitionsCancelledTotal = 0;
    this.transitionsDeferredBudgetTotal = 0;
    this.cacheHitsTotal = 0;
    this.cacheEvictionsTotal = 0;
    this.lastTransitionTotalMs = 0;
    this.lastActivationSwapMs = 0;
    this.maxActivationSwapMs = 0;
    this.activationSwapMsRing.length = 0;
    this.transitionDurationMsRing.length = 0;
    this.transitionsDebouncedAvoidedTotal = 0;
    this.destinationPrepReusedTotal = 0;
    this.prewarmTilesPreparedTotal = 0;
    this.prewarmReusedOnTransitionTotal = 0;
    this.boundaryOverlayRebuildMsTotal = 0;
    this.recentTransitions.length = 0;
    this.lastCompletedTransition = null;
    this.totalNetworkTransferBytes = 0;
    this.totalRawPayloadBytesDecoded = 0;
    this.totalHttpRetrievalDurationMs = 0;
    this.totalWorkerActiveDurationMs = 0;
    this.totalTilesDecoded = 0;
    this.totalRetrievedQueueWaitMs = 0;
    this.totalServerSqliteLookupMs = 0;
    this.totalServerInflateMs = 0;
    this.totalServerTotalMs = 0;
    this.serverHeaderSamples = 0;
    this.dynamicReprioritizationsTotal = 0;
    this.tailTileBoostsAppliedTotal = 0;
    this.ageEscalationsAppliedTotal = 0;
    this.oversizedPayloadAdmissionsTotal = 0;
    this.runningWorkerJobsRetainedAfterDemotionTotal = 0;
    this.discardedPreparedTilesTotal = 0;
    this.wastedNetworkBytes = 0;
    this.wastedWorkerTimeMs = 0;
    this.wastedPrewarmBytes = 0;
    this.prewarmedTilesActivatedTotal = 0;
    this.lastPreparationLeadTimeMs = 0;
    this.lastTileError = null;
    this.workloadScheduler.resetStats();
    this.gpuPreparer.resetStats();
    this.deferredDisposalQueue.resetStats();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    this.deferredDisposalQueue.flushAll();
    this.gpuPreparer.dispose();

    for (const record of this.tilesByKey.values()) {
      record.requestGeneration = this.requestGenerationCounter++;
      if (record.abortController) {
        record.abortController.abort();
        record.abortController = null;
      }
      this.releaseRecordStageReservations(record);
      if (record.reconstructed) {
        this.detachTileFromCompositeScene(record);
        record.reconstructed.dispose();
        record.reconstructed = null;
      }
      record.decodedPayload = null;
      record.decodedFootprint = null;
      record.state = 'unloaded';
    }

    this.inFlightHttpReservationBytes = 0;
    this.retrievedPayloadQueueBytes = 0;
    this.inFlightWorkerPreparationBytes = 0;
    this.activeFetchCount = 0;
    this.activeDestinationFetchCount = 0;
    this.activeDecodeCount = 0;
    this.tilesByKey.clear();
    this.levelsByResolution.clear();
    this.hierarchy = null;
    this.activeResolutionMeters = null;
    this.desiredResolutionMeters = null;
    this.pendingResolutionMeters = null;
    this.prewarmTargetResolutionMeters = null;
    this.pendingDebounceTargetResolution = null;
    this.pendingDebounceStartedAtMs = null;
    this.transitionState = 'idle';
    this.metadata = null;
    this.manifestPackPath = null;
    this.manifestStatus = 'idle';
    this.manifestError = null;

    this.compositeScene.buildingsGroup.clear();
    this.compositeScene.roadsGroup.clear();
    this.compositeScene.railwaysGroup.clear();
    this.compositeScene.waterGroup.clear();
    this.compositeScene.parksGroup.clear();
    this.compositeScene.landuseGroup.clear();
    this.compositeScene.barriersGroup.clear();
    this.compositeScene.foliageGroup.clear();
    this.compositeScene.interactiveMeshes.buildings = [];

    this.boundaryOverlayResult.dispose();
    this.regionalResources.dispose();
    if (this.ownsDecodeClient) {
      this.decodeClient.dispose();
    }
    if (this.ownsMaterialRegistry) {
      this.materialRegistry.dispose();
    }
    if (this.ownsFoliagePrototypeRegistry) {
      this.foliagePrototypeRegistry.dispose();
    }
    this.checkIdleWaiters();
  }

  private estimateHttpTransferBytes(record: ManagedTileRecord): number {
    if (this.streamingFrameBudget.useCompressedHttpTransfer) {
      return record.manifest.compressedBytes > 0
        ? record.manifest.compressedBytes
        : 4 * 1024 * 1024;
    }
    if (record.manifest.rawBytes > 0) {
      return record.manifest.rawBytes;
    }
    if (record.manifest.compressedBytes > 0) {
      return record.manifest.compressedBytes * 3;
    }
    return 16 * 1024 * 1024;
  }

  private estimateWorkerPreparationBytes(
    record: ManagedTileRecord,
    actualRetrievedBytes: number
  ): number {
    if (record.manifest.rawBytes > 0) {
      return record.manifest.rawBytes;
    }
    if (this.streamingFrameBudget.useCompressedHttpTransfer) {
      return actualRetrievedBytes * 3;
    }
    return actualRetrievedBytes;
  }

  private pumpFetchQueue(): void {
    if (this.isDisposed) return;
    if (this.streamingFrameBudget.independentPipelineStagesEnabled) {
      this.pumpIndependentPipelineStages();
      return;
    }

    // Legacy coupled F1 pipeline (when independentPipelineStagesEnabled is false)
    if (this.hierarchy) {
      let queuedDecodedBytes = 0;
      const nonVisibleReadyPreloads: ManagedTileRecord[] = [];
      let hasQueuedVisibleCritical = false;

      for (const record of this.tilesByKey.values()) {
        if (record.state === 'ready_to_commit' && record.decodedFootprint) {
          queuedDecodedBytes +=
            record.decodedFootprint.cpuGeometryBytes +
            record.decodedFootprint.bvhBytes;
          if (!record.isVisibleInViewport) {
            nonVisibleReadyPreloads.push(record);
          }
        } else if (
          record.state === 'queued' &&
          record.isInFetchSet &&
          record.isVisibleInViewport &&
          (record.resolutionMeters === this.activeResolutionMeters ||
            (record.resolutionMeters === this.pendingResolutionMeters &&
              this.transitionState !== 'deferred_budget'))
        ) {
          hasQueuedVisibleCritical = true;
        }
      }

      if (
        this.streamingFrameBudget.prioritizeDestinationOverActivePreload &&
        hasQueuedVisibleCritical &&
        queuedDecodedBytes >= this.hierarchicalBudget.maxPendingDecodedBytes &&
        nonVisibleReadyPreloads.length > 0
      ) {
        nonVisibleReadyPreloads.sort((a, b) => b.priorityScore - a.priorityScore);
        for (const preloadRec of nonVisibleReadyPreloads) {
          if (queuedDecodedBytes < this.hierarchicalBudget.maxPendingDecodedBytes) {
            break;
          }
          const fp = preloadRec.decodedFootprint;
          const bytes = fp ? fp.cpuGeometryBytes + fp.bvhBytes : 0;
          this.cancelInFlightTile(preloadRec);
          queuedDecodedBytes = Math.max(0, queuedDecodedBytes - bytes);
        }
      }

      this.workerBackpressureActive =
        queuedDecodedBytes >= this.hierarchicalBudget.maxPendingDecodedBytes;
      if (this.workerBackpressureActive) {
        return;
      }
    } else {
      this.workerBackpressureActive = false;
    }

    const availableSlots = this.maxConcurrentFetches - this.activeFetchCount;
    if (availableSlots <= 0) return;

    const coverageGap =
      this.streamingFrameBudget.suppressSpeculativeDuringActiveCoverageGap &&
      this.hasActiveVisibleCoverageGap();
    const pendingTransitionNeedsVisible =
      this.hierarchy !== null &&
      this.pendingResolutionMeters !== null &&
      this.transitionState !== 'deferred_budget' &&
      this.streamingFrameBudget.prioritizeDestinationOverActivePreload &&
      (() => {
        const pendingLevel = this.getPendingLevelState();
        return pendingLevel ? !this.checkDestinationReadiness(pendingLevel).allReady : false;
      })();

    const queued: ManagedTileRecord[] = [];
    for (const record of this.tilesByKey.values()) {
      if (record.state !== 'queued' || !record.isInFetchSet) continue;
      if (this.hierarchy) {
        const isActiveRes = record.resolutionMeters === this.activeResolutionMeters;
        const isPendingRes =
          record.resolutionMeters === this.pendingResolutionMeters &&
          this.transitionState !== 'deferred_budget';
        const isPrewarmRes =
          this.pendingResolutionMeters === null &&
          record.resolutionMeters === this.prewarmTargetResolutionMeters &&
          this.streamingFrameBudget.predictivePrewarmEnabled;
        if (!isActiveRes && !isPendingRes && !isPrewarmRes) continue;
        if (
          (!record.isVisibleInViewport || isPrewarmRes) &&
          (this.speculativeBackpressureActive || coverageGap)
        ) {
          continue;
        }
        if (pendingTransitionNeedsVisible && !record.isVisibleInViewport) {
          continue;
        }
      } else if (coverageGap && !record.isVisibleInViewport) {
        continue;
      }
      queued.push(record);
    }
    if (queued.length === 0) return;

    queued.sort((a, b) => a.priorityScore - b.priorityScore);
    const toLaunch = Math.min(availableSlots, queued.length);

    for (let i = 0; i < toLaunch; i++) {
      this.startTileFetchAndDecode(queued[i]);
    }
  }

  /**
   * TKT-041-F2 Work Package B & C:
   * Independently advances Stage 3 -> 4 (retrieved payload queue -> worker preparation)
   * and Stage 1 -> 2 (fetch queue -> HTTP retrieval) with byte-based backpressure,
   * reserved destination capacity, and oversized-payload forward progress.
   */
  private pumpIndependentPipelineStages(): void {
    if (this.isDisposed) return;
    this.pumpWorkerPreparationQueue();
    this.pumpHttpFetchQueue();
  }

  private pumpWorkerPreparationQueue(): void {
    if (this.isDisposed) return;

    // Measure Stage 5 (ready_to_commit) prepared payload queue bytes and Stage 6 reconstructed awaiting GPU bytes
    let preparedPayloadQueueBytes = 0;
    let reconstructedAwaitingGpuBytes = 0;
    const nonVisibleReadyPreloads: ManagedTileRecord[] = [];
    const retrievedCandidates: ManagedTileRecord[] = [];
    let hasRetrievedVisibleCritical = false;
    let hasRetrievedVisibleDestination = false;

    for (const record of this.tilesByKey.values()) {
      if (record.state === 'ready_to_commit' && record.decodedFootprint) {
        preparedPayloadQueueBytes +=
          record.decodedFootprint.cpuGeometryBytes +
          record.decodedFootprint.bvhBytes;
        if (!record.isVisibleInViewport) {
          nonVisibleReadyPreloads.push(record);
        }
      } else if (
        record.state === 'prepared_inactive' &&
        record.reconstructed &&
        !this.gpuPreparer.isTilePrepared(record.reconstructed)
      ) {
        const fp = record.decodedFootprint;
        if (fp) {
          reconstructedAwaitingGpuBytes += fp.cpuGeometryBytes;
        }
      } else if (
        record.state === 'retrieved_queued' &&
        record.retrievedBuffer !== null
      ) {
        if (!record.isInKeepSet) {
          this.wastedNetworkBytes += record.retrievedBuffer.byteLength;
          this.cancelInFlightTile(record);
          continue;
        }
        retrievedCandidates.push(record);
        const isPendingDest =
          this.hierarchy !== null &&
          record.resolutionMeters === this.pendingResolutionMeters &&
          this.transitionState !== 'deferred_budget' &&
          record.isVisibleInViewport;
        if (isPendingDest) {
          hasRetrievedVisibleDestination = true;
          hasRetrievedVisibleCritical = true;
        } else if (
          record.isVisibleInViewport &&
          (!this.hierarchy ||
            record.resolutionMeters === this.activeResolutionMeters)
        ) {
          hasRetrievedVisibleCritical = true;
        }
      }
    }

    const maxPreparedCap = Math.min(
      this.streamingFrameBudget.maxPreparedPayloadQueueBytes,
      this.hierarchy
        ? this.hierarchicalBudget.maxPendingDecodedBytes
        : this.streamingFrameBudget.maxPreparedPayloadQueueBytes
    );

    // Evict non-visible speculative ready_to_commit tiles if critical visible tiles are waiting in retrieved_queued
    if (
      this.streamingFrameBudget.prioritizeDestinationOverActivePreload &&
      hasRetrievedVisibleCritical &&
      preparedPayloadQueueBytes >= maxPreparedCap &&
      nonVisibleReadyPreloads.length > 0
    ) {
      nonVisibleReadyPreloads.sort((a, b) => b.priorityScore - a.priorityScore);
      for (const preloadRec of nonVisibleReadyPreloads) {
        if (preparedPayloadQueueBytes < maxPreparedCap) break;
        const fp = preloadRec.decodedFootprint;
        const bytes = fp ? fp.cpuGeometryBytes + fp.bvhBytes : 0;
        this.cancelInFlightTile(preloadRec);
        preparedPayloadQueueBytes = Math.max(0, preparedPayloadQueueBytes - bytes);
      }
    }

    const preparedQueueFull =
      preparedPayloadQueueBytes >= maxPreparedCap ||
      (this.hierarchy !== null &&
        reconstructedAwaitingGpuBytes >=
          this.streamingFrameBudget.maxReconstructedAwaitingGpuBytes);

    // Oversized-payload rule for Stage 4 -> 5: allow at least 1 worker decode when Stage 4 and Stage 5 are drained
    const stage4And5Drained =
      this.activeDecodeCount === 0 && preparedPayloadQueueBytes === 0;
    this.workerBackpressureActive = preparedQueueFull && !stage4And5Drained;
    if (this.workerBackpressureActive || retrievedCandidates.length === 0) {
      return;
    }

    retrievedCandidates.sort((a, b) => a.priorityScore - b.priorityScore);

    const maxWorkerConcurrency = Math.max(
      1,
      this.streamingFrameBudget.workerConcurrency
    );
    const maxWorkerPrepBytes =
      this.streamingFrameBudget.maxWorkerPreparationBytes;
    const reservedDestWorkerSlots =
      this.hierarchy !== null && hasRetrievedVisibleDestination
        ? Math.min(
            maxWorkerConcurrency - 1,
            Math.max(0, this.streamingFrameBudget.reservedDestinationWorkerSlots)
          )
        : 0;

    while (retrievedCandidates.length > 0) {
      const workerUtil = this.decodeClient.getWorkerUtilizationSnapshot();
      const totalWorkerInFlightAndQueued =
        workerUtil.busyWorkerCount + workerUtil.queuedDecodeCount;
      // Keep worker queue bounded to at most 2x workerConcurrency so dynamic reprioritization stays responsive
      if (totalWorkerInFlightAndQueued >= maxWorkerConcurrency * 2) {
        break;
      }

      // Pick next candidate respecting reserved destination worker capacity
      const nonDestLimit = Math.max(
        1,
        maxWorkerConcurrency * 2 - reservedDestWorkerSlots
      );
      const nonDestInFlightAndQueued =
        totalWorkerInFlightAndQueued -
        (workerUtil.activeDestinationWorkerCount +
          workerUtil.queuedDestinationDecodeCount);

      let chosenIdx = -1;
      for (let i = 0; i < retrievedCandidates.length; i++) {
        const cand = retrievedCandidates[i];
        const isDestVisible =
          this.hierarchy !== null &&
          cand.resolutionMeters === this.pendingResolutionMeters &&
          this.transitionState !== 'deferred_budget' &&
          cand.isVisibleInViewport;
        if (
          !isDestVisible &&
          reservedDestWorkerSlots > 0 &&
          nonDestInFlightAndQueued >= nonDestLimit
        ) {
          continue;
        }
        chosenIdx = i;
        break;
      }
      if (chosenIdx < 0) {
        chosenIdx = 0;
      }

      const nextRecord = retrievedCandidates[chosenIdx];
      const buffer = nextRecord.retrievedBuffer;
      if (!buffer) {
        retrievedCandidates.splice(chosenIdx, 1);
        continue;
      }

      const estWorkerBytes = this.estimateWorkerPreparationBytes(
        nextRecord,
        buffer.byteLength
      );
      const wouldExceedWorkerPrepCap =
        this.inFlightWorkerPreparationBytes + estWorkerBytes > maxWorkerPrepBytes;
      if (wouldExceedWorkerPrepCap) {
        // Section 5.2 Oversized-payload rule: allow at least 1 oversized payload when worker stage is completely empty
        if (
          this.inFlightWorkerPreparationBytes === 0 &&
          this.activeDecodeCount === 0
        ) {
          this.oversizedPayloadAdmissionsTotal += 1;
        } else {
          break;
        }
      }

      retrievedCandidates.splice(chosenIdx, 1);
      // Single-owner handoff from Stage 3 (retrieved_queued) to Stage 4 (decoding):
      // subtract retrievedBuffer bytes before adding reservedWorkerBytes so buffers are never double-counted.
      this.retrievedPayloadQueueBytes = Math.max(
        0,
        this.retrievedPayloadQueueBytes - buffer.byteLength
      );
      nextRecord.retrievedBuffer = null;
      nextRecord.reservedWorkerBytes = estWorkerBytes;
      this.inFlightWorkerPreparationBytes += estWorkerBytes;

      this.startWorkerDecodeForRetrievedTile(nextRecord, buffer);
    }
  }

  private pumpHttpFetchQueue(): void {
    if (this.isDisposed) return;

    const maxConcurrentHttp = this.getEffectiveMaxConcurrentHttpRetrievals();
    const availableHttpSlots = maxConcurrentHttp - this.activeFetchCount;
    if (availableHttpSlots <= 0) return;

    // Backpressure check on Stage 3 (retrieved_queued) and Stage 2 (in-flight HTTP reservation)
    const maxRetrievedQueueBytes =
      this.streamingFrameBudget.maxRetrievedPayloadQueueBytes;
    const maxHttpResBytes =
      this.streamingFrameBudget.maxInFlightHttpReservationBytes;

    if (
      this.workerBackpressureActive &&
      this.retrievedPayloadQueueBytes >= maxRetrievedQueueBytes
    ) {
      return;
    }

    const coverageGap =
      this.streamingFrameBudget.suppressSpeculativeDuringActiveCoverageGap &&
      this.hasActiveVisibleCoverageGap();
    const pendingTransitionNeedsVisible =
      this.hierarchy !== null &&
      this.pendingResolutionMeters !== null &&
      this.transitionState !== 'deferred_budget' &&
      this.streamingFrameBudget.prioritizeDestinationOverActivePreload &&
      (() => {
        const pendingLevel = this.getPendingLevelState();
        return pendingLevel
          ? !this.checkDestinationReadiness(pendingLevel).allReady
          : false;
      })();

    const queued: ManagedTileRecord[] = [];
    let hasQueuedVisibleDestination = false;

    for (const record of this.tilesByKey.values()) {
      if (record.state !== 'queued' || !record.isInFetchSet) continue;
      if (this.hierarchy) {
        const isActiveRes = record.resolutionMeters === this.activeResolutionMeters;
        const isPendingRes =
          record.resolutionMeters === this.pendingResolutionMeters &&
          this.transitionState !== 'deferred_budget';
        const isPrewarmRes =
          this.pendingResolutionMeters === null &&
          record.resolutionMeters === this.prewarmTargetResolutionMeters &&
          this.streamingFrameBudget.predictivePrewarmEnabled;
        if (!isActiveRes && !isPendingRes && !isPrewarmRes) continue;
        if (
          (!record.isVisibleInViewport || isPrewarmRes) &&
          (this.speculativeBackpressureActive || coverageGap)
        ) {
          continue;
        }
        if (pendingTransitionNeedsVisible && !record.isVisibleInViewport) {
          continue;
        }
        if (isPendingRes && record.isVisibleInViewport) {
          hasQueuedVisibleDestination = true;
        }
      } else if (coverageGap && !record.isVisibleInViewport) {
        continue;
      }
      queued.push(record);
    }

    if (queued.length === 0) return;
    queued.sort((a, b) => a.priorityScore - b.priorityScore);

    const reservedDestSlots =
      this.hierarchy !== null && hasQueuedVisibleDestination
        ? Math.min(
            maxConcurrentHttp - 1,
            Math.max(0, this.streamingFrameBudget.reservedDestinationFetchSlots)
          )
        : 0;
    const maxNonDestActiveHttp = Math.max(
      1,
      maxConcurrentHttp - reservedDestSlots
    );

    while (queued.length > 0 && this.activeFetchCount < maxConcurrentHttp) {
      const nonDestActiveHttp = Math.max(
        0,
        this.activeFetchCount - this.activeDestinationFetchCount
      );

      let chosenIdx = -1;
      for (let i = 0; i < queued.length; i++) {
        const cand = queued[i];
        const isDestVisible =
          this.hierarchy !== null &&
          cand.resolutionMeters === this.pendingResolutionMeters &&
          this.transitionState !== 'deferred_budget' &&
          cand.isVisibleInViewport;
        if (
          !isDestVisible &&
          reservedDestSlots > 0 &&
          nonDestActiveHttp >= maxNonDestActiveHttp
        ) {
          continue;
        }
        chosenIdx = i;
        break;
      }
      if (chosenIdx < 0) {
        break;
      }

      const nextRecord = queued[chosenIdx];
      const estHttpBytes = this.estimateHttpTransferBytes(nextRecord);
      const projectedRetrievedAndInFlight =
        this.inFlightHttpReservationBytes +
        this.retrievedPayloadQueueBytes +
        estHttpBytes;

      const exceedsHttpCap =
        this.inFlightHttpReservationBytes + estHttpBytes > maxHttpResBytes;
      const exceedsRetrievedQueueCap =
        projectedRetrievedAndInFlight > maxRetrievedQueueBytes;

      if (exceedsHttpCap || exceedsRetrievedQueueCap) {
        // Section 5.2 Oversized-payload rule: allow at least 1 oversized HTTP retrieval when Stage 2 & Stage 3 are empty
        if (
          this.activeFetchCount === 0 &&
          this.inFlightHttpReservationBytes === 0 &&
          this.retrievedPayloadQueueBytes === 0
        ) {
          this.oversizedPayloadAdmissionsTotal += 1;
        } else {
          break;
        }
      }

      queued.splice(chosenIdx, 1);
      this.startHttpRetrievalOnly(nextRecord, estHttpBytes);
    }
  }

  private startHttpRetrievalOnly(
    record: ManagedTileRecord,
    estimatedHttpBytes: number
  ): void {
    const abortController = new AbortController();
    const generation = this.requestGenerationCounter++;
    record.abortController = abortController;
    record.requestGeneration = generation;
    record.state = 'fetching';
    record.reservedHttpBytes = estimatedHttpBytes;
    this.inFlightHttpReservationBytes += estimatedHttpBytes;
    this.activeFetchCount += 1;

    const isDestinationFetch =
      this.hierarchy !== null &&
      record.resolutionMeters === this.pendingResolutionMeters &&
      record.isVisibleInViewport;
    if (isDestinationFetch) {
      this.activeDestinationFetchCount += 1;
    }

    const { lod, tx, ty } = record.manifest;
    const tileKey = record.tileKey;
    const tileSizeMeters = record.resolutionMeters;
    const baseUrl = this.hierarchy
      ? `${this.apiBaseUrl}/r/${tileSizeMeters}/${lod}/${tx}/${ty}`
      : `${this.apiBaseUrl}/${lod}/${tx}/${ty}`;
    const url = this.streamingFrameBudget.useCompressedHttpTransfer
      ? `${baseUrl}?compressed=1`
      : baseUrl;

    const fetchStart = this.nowFn();
    record.pipeline.fetchStartAtMs = fetchStart;
    if (record.pipeline.queuedAtMs !== null) {
      record.pipeline.fetchQueueWaitMs = Math.max(
        0,
        fetchStart - record.pipeline.queuedAtMs
      );
    }
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    if (prof) {
      prof.recordEvent({
        eventType: 'fetch_start',
        tileKey,
        tileSizeMeters,
        lod,
        timestampMs: fetchStart,
        queueDepths: this.getQueueDepthSnapshot(),
      });
    }

    let slotReleased = false;
    const releaseHttpSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      this.activeFetchCount = Math.max(0, this.activeFetchCount - 1);
      if (isDestinationFetch) {
        this.activeDestinationFetchCount = Math.max(
          0,
          this.activeDestinationFetchCount - 1
        );
      }
      if (record.reservedHttpBytes > 0) {
        this.inFlightHttpReservationBytes = Math.max(
          0,
          this.inFlightHttpReservationBytes - record.reservedHttpBytes
        );
        record.reservedHttpBytes = 0;
      }
    };

    (async () => {
      try {
        const response = await this.fetchFn(url, {
          signal: abortController.signal,
        });
        if (
          abortController.signal.aborted ||
          record.requestGeneration !== generation
        ) {
          return;
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} fetching tile ${tileKey}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        // Release HTTP slot & reservation IMMEDIATELY when payload arrives!
        releaseHttpSlot();

        if (
          this.isDisposed ||
          abortController.signal.aborted ||
          record.requestGeneration !== generation
        ) {
          this.wastedNetworkBytes += arrayBuffer.byteLength;
          return;
        }

        const headers = response.headers;
        if (headers && typeof headers.get === 'function') {
          const sqliteStr = headers.get('X-Tile-Server-Sqlite-Ms');
          const inflateStr = headers.get('X-Tile-Server-Inflate-Ms');
          const totalStr = headers.get('X-Tile-Server-Total-Ms');
          if (sqliteStr !== null || totalStr !== null) {
            const sqliteMs = Number(sqliteStr ?? 0);
            const inflateMs = Number(inflateStr ?? 0);
            const totalMs = Number(totalStr ?? 0);
            record.pipeline.serverSqliteLookupMs = sqliteMs;
            record.pipeline.serverInflateMs = inflateMs;
            record.pipeline.serverTotalMs = totalMs;
            this.totalServerSqliteLookupMs += sqliteMs;
            this.totalServerInflateMs += inflateMs;
            this.totalServerTotalMs += totalMs;
            this.serverHeaderSamples += 1;
          }
        }

        const payloadBytes = arrayBuffer.byteLength;
        record.lastCompressedBytes = payloadBytes;
        const fetchEnd = this.nowFn();
        const fetchMs = Math.max(0, fetchEnd - fetchStart);
        record.pipeline.fetchCompleteAtMs = fetchEnd;
        record.pipeline.payloadRetrievalMs = fetchMs;
        record.pipeline.retrievedQueuedAtMs = fetchEnd;
        this.totalFetchMs += fetchMs;
        this.fetchSamples += 1;
        this.totalNetworkTransferBytes += payloadBytes;
        this.totalHttpRetrievalDurationMs += fetchMs;
        pushBoundedSample(this.fetchMsRing, fetchMs);

        // Transition to Stage 3: Retrieved-payload queue
        record.retrievedBuffer = arrayBuffer;
        record.state = 'retrieved_queued';
        this.retrievedPayloadQueueBytes += payloadBytes;
        this.updatePeakTileCounters();

        const profAtFetchDone =
          this.profiler && this.profiler.enabled ? this.profiler : null;
        if (profAtFetchDone) {
          profAtFetchDone.recordEvent({
            eventType: 'fetch_complete',
            tileKey,
            tileSizeMeters,
            lod,
            timestampMs: fetchEnd,
            payloadCompressedBytes: payloadBytes,
            durationMs: fetchMs,
            queueDepths: this.getQueueDepthSnapshot(),
          });
        }
      } catch (err) {
        releaseHttpSlot();
        if (
          abortController.signal.aborted ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          return;
        }
        if (record.requestGeneration === generation) {
          const msg = err instanceof Error ? err.message : String(err);
          record.state = 'error';
          record.lastError = msg;
          record.abortController = null;
          this.lastTileError = `${tileKey}: ${msg}`;
          this.needsViewportRefresh = true;

          const profAtErr =
            this.profiler && this.profiler.enabled ? this.profiler : null;
          if (profAtErr) {
            profAtErr.recordEvent({
              eventType: 'error',
              tileKey,
              tileSizeMeters,
              lod,
              queueDepths: this.getQueueDepthSnapshot(),
              detail: { reason: msg },
            });
          }
          this.emitDiagnostics();
        }
      } finally {
        releaseHttpSlot();
        if (!this.isDisposed) {
          this.pumpIndependentPipelineStages();
          this.checkIdleWaiters();
        }
      }
    })();
  }

  private startWorkerDecodeForRetrievedTile(
    record: ManagedTileRecord,
    arrayBuffer: ArrayBuffer
  ): void {
    const abortController = record.abortController ?? new AbortController();
    record.abortController = abortController;
    const generation = record.requestGeneration;
    const { lod, tx, ty } = record.manifest;
    const tileKey = record.tileKey;
    const tileSizeMeters = record.resolutionMeters;
    const compressedPayloadBytes =
      record.lastCompressedBytes ?? arrayBuffer.byteLength;
    const decodeStart = this.nowFn();

    record.state = 'decoding';
    record.pipeline.decodeStartAtMs = decodeStart;
    if (record.pipeline.retrievedQueuedAtMs !== null) {
      record.pipeline.retrievedQueueWaitMs = Math.max(
        0,
        decodeStart - record.pipeline.retrievedQueuedAtMs
      );
      this.totalRetrievedQueueWaitMs += record.pipeline.retrievedQueueWaitMs;
    }
    this.activeDecodeCount += 1;
    this.updatePeakTileCounters();

    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    if (prof) {
      prof.recordEvent({
        eventType: 'decode_start',
        tileKey,
        tileSizeMeters,
        lod,
        timestampMs: decodeStart,
        payloadCompressedBytes: compressedPayloadBytes,
        queueDepths: this.getQueueDepthSnapshot(),
      });
    }

    const isPendingDestination =
      this.hierarchy !== null &&
      record.resolutionMeters === this.pendingResolutionMeters &&
      this.transitionState !== 'deferred_budget' &&
      record.isVisibleInViewport;

    const decodePriority = this.streamingFrameBudget
      .prioritizeDestinationOverActivePreload
      ? record.priorityScore
      : 0;

    (async () => {
      try {
        const decodeResult = await this.decodeClient.decodeTile(
          arrayBuffer,
          tileKey,
          abortController.signal,
          decodePriority,
          {
            isDestination: isPendingDestination,
            retainIfRunningOnAbort:
              this.streamingFrameBudget.retainRunningWorkerJobOnDemotion &&
              !this.speculativeBackpressureActive,
            estimatedBytes: record.reservedWorkerBytes,
          }
        );

        const tCont0 = this.nowFn();
        if (this.isDisposed) return;

        // Release worker reservation before transitioning to Stage 5 (ready_to_commit) or inactive cache
        if (record.reservedWorkerBytes > 0) {
          this.inFlightWorkerPreparationBytes = Math.max(
            0,
            this.inFlightWorkerPreparationBytes - record.reservedWorkerBytes
          );
          record.reservedWorkerBytes = 0;
        }

        const stillValidLevel =
          !this.hierarchy ||
          record.resolutionMeters === this.activeResolutionMeters ||
          (record.resolutionMeters === this.pendingResolutionMeters &&
            this.transitionState !== 'deferred_budget') ||
          (this.pendingResolutionMeters === null &&
            record.resolutionMeters === this.prewarmTargetResolutionMeters &&
            this.streamingFrameBudget.predictivePrewarmEnabled);

        const wasDemotedOrAborted =
          decodeResult.completedAfterAbort === true ||
          abortController.signal.aborted ||
          record.requestGeneration !== generation ||
          !record.isInKeepSet ||
          !stillValidLevel;

        if (wasDemotedOrAborted) {
          // Section 6.3: If a running worker job completed after demotion and we have memory headroom,
          // retain the reconstructed tile in cached_inactive instead of throwing away completed worker work.
          if (
            this.hierarchy &&
            this.streamingFrameBudget.retainRunningWorkerJobOnDemotion &&
            !this.speculativeBackpressureActive &&
            record.state === 'unloaded' &&
            this.hierarchicalBudget.maxInactiveCachedTiles > 0 &&
            this.hierarchicalBudget.inactiveCacheBudgetBytes > 0 &&
            decodeResult.decoded.lod === lod &&
            decodeResult.decoded.tx === tx &&
            decodeResult.decoded.ty === ty &&
            decodeResult.decoded.tileSizeMeters === record.resolutionMeters
          ) {
            const positionedPayload: AnyDecodedTilePayload = {
              ...decodeResult.decoded,
              tileCenterX: record.manifest.tileCenterX,
              tileCenterZ: record.manifest.tileCenterZ,
            };
            const fp = computeDecodedTileMemoryFootprint(positionedPayload);
            const estBytes = fp.cpuGeometryBytes + fp.bvhBytes;
            if (
              this.computeTotalMeasuredMemoryBytes() + estBytes <=
              this.hierarchicalBudget.totalMemoryBudgetBytes
            ) {
              const reconstructed = reconstructTileSceneFromDecoded(
                positionedPayload,
                {
                  materialRegistry: this.materialRegistry,
                  foliagePrototypeRegistry: this.foliagePrototypeRegistry,
                  foliageRuntimeState: this.foliageRuntimeState,
                  optimizeMainThreadPrep:
                    this.tilePrepOptions.optimizeMainThreadPrep,
                }
              );
              record.reconstructed = reconstructed;
              record.decodedFootprint = fp;
              record.decodedPayload = null;
              record.state = 'cached_inactive';
              record.lastUsedAtMs = tCont0;
              this.runningWorkerJobsRetainedAfterDemotionTotal += 1;
              this.enforceResourceBudgets();
              return;
            }
          }
          this.wastedWorkerTimeMs += decodeResult.decodeDurationMs;
          this.wastedNetworkBytes += compressedPayloadBytes;
          return;
        }

        this.totalDecodeMs += decodeResult.decodeDurationMs;
        this.decodeSamples += 1;
        this.totalWorkerActiveDurationMs += decodeResult.decodeDurationMs;
        this.totalTilesDecoded += 1;
        pushBoundedSample(this.decodeMsRing, decodeResult.decodeDurationMs);

        record.pipeline.decodeCompleteAtMs = tCont0;
        record.pipeline.workerClientQueueWaitMs =
          decodeResult.clientQueueWaitMs ?? 0;
        if (decodeResult.workerTimings) {
          record.pipeline.workerThreadQueueWaitMs =
            decodeResult.workerTimings.workerQueueWaitMs;
          record.pipeline.workerInflateMs =
            decodeResult.workerTimings.workerInflateMs;
          record.pipeline.workerDecodeOnlyMs =
            decodeResult.workerTimings.workerDecodeOnlyMs;
          record.pipeline.workerInflateAndDecodeMs =
            decodeResult.workerTimings.workerInflateAndDecodeMs;
          record.pipeline.workerBvhBuildMs =
            decodeResult.workerTimings.workerBvhBuildMs;
          record.pipeline.workerPayloadPrepMs =
            decodeResult.workerTimings.workerPayloadPrepMs;
          record.pipeline.workerDeliveryLatencyMs =
            decodeResult.workerTimings.messageDeliveryLatencyMs;
        }

        if (
          decodeResult.decoded.lod !== lod ||
          decodeResult.decoded.tx !== tx ||
          decodeResult.decoded.ty !== ty ||
          decodeResult.decoded.tileSizeMeters !== record.resolutionMeters
        ) {
          throw new Error(`Decoded tile identity/size mismatch: ${tileKey}`);
        }
        const positionedPayload: AnyDecodedTilePayload = {
          ...decodeResult.decoded,
          tileCenterX: record.manifest.tileCenterX,
          tileCenterZ: record.manifest.tileCenterZ,
        };
        record.decodedPayload = positionedPayload;
        record.decodedFootprint = computeDecodedTileMemoryFootprint(
          positionedPayload
        );
        this.totalRawPayloadBytesDecoded +=
          record.decodedFootprint.cpuGeometryBytes +
          record.decodedFootprint.bvhBytes;
        record.abortController = null;
        record.state = 'ready_to_commit';
        this.updatePeakTileCounters();

        const contDurationMs = Math.max(0, this.nowFn() - tCont0);
        if (decodeResult.workerTimings) {
          decodeResult.workerTimings.mainPromiseContinuationMs = Number(
            contDurationMs.toFixed(3)
          );
        }

        const profAtDecodeDone =
          this.profiler && this.profiler.enabled ? this.profiler : null;
        if (profAtDecodeDone) {
          profAtDecodeDone.recordWorkerContinuation(contDurationMs);
          const readyNowMs = this.nowFn();
          const fp = record.decodedFootprint;
          const rawBytes = fp.cpuGeometryBytes + fp.bvhBytes;
          const depths = this.getQueueDepthSnapshot();
          const wt = decodeResult.workerTimings;
          profAtDecodeDone.recordEvent({
            eventType: 'decode_complete',
            tileKey,
            tileSizeMeters,
            lod,
            timestampMs: readyNowMs,
            payloadCompressedBytes: compressedPayloadBytes,
            payloadRawBytes: rawBytes,
            durationMs: decodeResult.decodeDurationMs,
            queueDepths: depths,
            detail: {
              meshCount: fp.meshCount,
              triangleCount: fp.triangleCount,
              usedWebWorker: decodeResult.usedWebWorker,
              usedCompactTransport: wt?.usedCompactTransport,
              workerInflateMs: wt?.workerInflateMs,
              workerDecodeOnlyMs: wt?.workerDecodeOnlyMs,
              workerBvhBuildMs: wt?.workerBvhBuildMs,
              messageDeliveryLatencyMs: wt?.messageDeliveryLatencyMs,
              mainOnMessageHandlerMs: wt?.mainOnMessageHandlerMs,
              mainPromiseContinuationMs: Number(contDurationMs.toFixed(3)),
              transferableBufferCount: wt?.transferableBufferCount,
              transferableBytes: wt?.transferableBytes,
            },
          });
          profAtDecodeDone.recordEvent({
            eventType: 'ready_to_commit',
            tileKey,
            tileSizeMeters,
            lod,
            timestampMs: readyNowMs,
            payloadCompressedBytes: compressedPayloadBytes,
            payloadRawBytes: rawBytes,
            queueDepths: depths,
          });
        }

        // Wake any waitForIdle() caller so it can commit ready_to_commit tiles and relieve backpressure
        this.wakeIdleWaiters();
      } catch (err) {
        if (record.reservedWorkerBytes > 0) {
          this.inFlightWorkerPreparationBytes = Math.max(
            0,
            this.inFlightWorkerPreparationBytes - record.reservedWorkerBytes
          );
          record.reservedWorkerBytes = 0;
        }
        if (
          abortController.signal.aborted ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          return;
        }
        if (record.requestGeneration === generation) {
          const msg = err instanceof Error ? err.message : String(err);
          record.state = 'error';
          record.lastError = msg;
          record.abortController = null;
          this.lastTileError = `${tileKey}: ${msg}`;
          this.needsViewportRefresh = true;

          const profAtErr =
            this.profiler && this.profiler.enabled ? this.profiler : null;
          if (profAtErr) {
            profAtErr.recordEvent({
              eventType: 'error',
              tileKey,
              tileSizeMeters,
              lod,
              queueDepths: this.getQueueDepthSnapshot(),
              detail: { reason: msg },
            });
          }
          this.emitDiagnostics();
        }
      } finally {
        this.activeDecodeCount = Math.max(0, this.activeDecodeCount - 1);
        if (record.reservedWorkerBytes > 0) {
          this.inFlightWorkerPreparationBytes = Math.max(
            0,
            this.inFlightWorkerPreparationBytes - record.reservedWorkerBytes
          );
          record.reservedWorkerBytes = 0;
        }
        if (!this.isDisposed) {
          this.pumpIndependentPipelineStages();
          this.checkIdleWaiters();
        }
      }
    })();
  }

  private startTileFetchAndDecode(record: ManagedTileRecord): void {
    const abortController = new AbortController();
    const generation = this.requestGenerationCounter++;
    record.abortController = abortController;
    record.requestGeneration = generation;
    record.state = 'fetching';
    this.activeFetchCount += 1;

    const { lod, tx, ty } = record.manifest;
    const tileKey = record.tileKey;
    const tileSizeMeters = record.resolutionMeters;
    const url = this.hierarchy
      ? `${this.apiBaseUrl}/r/${tileSizeMeters}/${lod}/${tx}/${ty}`
      : `${this.apiBaseUrl}/${lod}/${tx}/${ty}`;
    const fetchStart = this.nowFn();
    record.pipeline.fetchStartAtMs = fetchStart;
    if (record.pipeline.queuedAtMs !== null) {
      record.pipeline.fetchQueueWaitMs = Math.max(
        0,
        fetchStart - record.pipeline.queuedAtMs
      );
    }
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;

    if (prof) {
      prof.recordEvent({
        eventType: 'fetch_start',
        tileKey,
        tileSizeMeters,
        lod,
        timestampMs: fetchStart,
        queueDepths: this.getQueueDepthSnapshot(),
      });
    }

    (async () => {
      try {
        const response = await this.fetchFn(url, {
          signal: abortController.signal,
        });
        if (abortController.signal.aborted || record.requestGeneration !== generation) {
          return;
        }
        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status} fetching tile ${tileKey}`
          );
        }
        const arrayBuffer = await response.arrayBuffer();
        if (abortController.signal.aborted || record.requestGeneration !== generation) {
          return;
        }
        // Capture compressed byteLength BEFORE decodeTile transfers the ArrayBuffer to a Worker
        const compressedPayloadBytes = arrayBuffer.byteLength;
        record.lastCompressedBytes = compressedPayloadBytes;
        const fetchEnd = this.nowFn();
        const fetchMs = Math.max(0, fetchEnd - fetchStart);
        record.pipeline.fetchCompleteAtMs = fetchEnd;
        record.pipeline.payloadRetrievalMs = fetchMs;
        record.pipeline.decodeStartAtMs = fetchEnd;
        this.totalFetchMs += fetchMs;
        this.fetchSamples += 1;
        this.totalNetworkTransferBytes += compressedPayloadBytes;
        this.totalHttpRetrievalDurationMs += fetchMs;
        pushBoundedSample(this.fetchMsRing, fetchMs);

        record.state = 'decoding';
        this.updatePeakTileCounters();

        const profAtFetchDone =
          this.profiler && this.profiler.enabled ? this.profiler : null;
        if (profAtFetchDone) {
          const depths = this.getQueueDepthSnapshot();
          profAtFetchDone.recordEvent({
            eventType: 'fetch_complete',
            tileKey,
            tileSizeMeters,
            lod,
            timestampMs: fetchEnd,
            payloadCompressedBytes: compressedPayloadBytes,
            durationMs: fetchMs,
            queueDepths: depths,
          });
          profAtFetchDone.recordEvent({
            eventType: 'decode_start',
            tileKey,
            tileSizeMeters,
            lod,
            timestampMs: fetchEnd,
            payloadCompressedBytes: compressedPayloadBytes,
            queueDepths: depths,
          });
        }

        const decodePriority = this.streamingFrameBudget
          .prioritizeDestinationOverActivePreload
          ? record.priorityScore
          : 0;
        const decodeResult = await this.decodeClient.decodeTile(
          arrayBuffer,
          tileKey,
          abortController.signal,
          decodePriority
        );
        const tCont0 = this.nowFn();
        const stillValidLevel =
          !this.hierarchy ||
          record.resolutionMeters === this.activeResolutionMeters ||
          (record.resolutionMeters === this.pendingResolutionMeters &&
            this.transitionState !== 'deferred_budget') ||
          (this.pendingResolutionMeters === null &&
            record.resolutionMeters === this.prewarmTargetResolutionMeters &&
            this.streamingFrameBudget.predictivePrewarmEnabled);
        if (
          this.isDisposed ||
          abortController.signal.aborted ||
          record.requestGeneration !== generation ||
          !record.isInKeepSet ||
          !stillValidLevel
        ) {
          return;
        }

        this.totalDecodeMs += decodeResult.decodeDurationMs;
        this.decodeSamples += 1;
        this.totalWorkerActiveDurationMs += decodeResult.decodeDurationMs;
        this.totalTilesDecoded += 1;
        pushBoundedSample(this.decodeMsRing, decodeResult.decodeDurationMs);

        record.pipeline.decodeCompleteAtMs = tCont0;
        record.pipeline.workerClientQueueWaitMs =
          decodeResult.clientQueueWaitMs ?? 0;
        if (decodeResult.workerTimings) {
          record.pipeline.workerThreadQueueWaitMs =
            decodeResult.workerTimings.workerQueueWaitMs;
          record.pipeline.workerInflateMs =
            decodeResult.workerTimings.workerInflateMs;
          record.pipeline.workerDecodeOnlyMs =
            decodeResult.workerTimings.workerDecodeOnlyMs;
          record.pipeline.workerInflateAndDecodeMs =
            decodeResult.workerTimings.workerInflateAndDecodeMs;
          record.pipeline.workerBvhBuildMs =
            decodeResult.workerTimings.workerBvhBuildMs;
          record.pipeline.workerPayloadPrepMs =
            decodeResult.workerTimings.workerPayloadPrepMs;
          record.pipeline.workerDeliveryLatencyMs =
            decodeResult.workerTimings.messageDeliveryLatencyMs;
        }

        if (
          decodeResult.decoded.lod !== lod ||
          decodeResult.decoded.tx !== tx ||
          decodeResult.decoded.ty !== ty ||
          decodeResult.decoded.tileSizeMeters !== record.resolutionMeters
        ) {
          throw new Error(`Decoded tile identity/size mismatch: ${tileKey}`);
        }
        const positionedPayload: AnyDecodedTilePayload = {
          ...decodeResult.decoded,
          tileCenterX: record.manifest.tileCenterX,
          tileCenterZ: record.manifest.tileCenterZ,
        };
        record.decodedPayload = positionedPayload;
        record.decodedFootprint = computeDecodedTileMemoryFootprint(
          positionedPayload
        );
        this.totalRawPayloadBytesDecoded +=
          record.decodedFootprint.cpuGeometryBytes +
          record.decodedFootprint.bvhBytes;
        record.abortController = null;
        record.state = 'ready_to_commit';
        this.updatePeakTileCounters();

        const contDurationMs = Math.max(0, this.nowFn() - tCont0);
        if (decodeResult.workerTimings) {
          decodeResult.workerTimings.mainPromiseContinuationMs = Number(
            contDurationMs.toFixed(3)
          );
        }

        const profAtDecodeDone =
          this.profiler && this.profiler.enabled ? this.profiler : null;
        if (profAtDecodeDone) {
          profAtDecodeDone.recordWorkerContinuation(contDurationMs);
          const readyNowMs = this.nowFn();
          const fp = record.decodedFootprint;
          const rawBytes = fp.cpuGeometryBytes + fp.bvhBytes;
          const depths = this.getQueueDepthSnapshot();
          const wt = decodeResult.workerTimings;
          profAtDecodeDone.recordEvent({
            eventType: 'decode_complete',
            tileKey,
            tileSizeMeters,
            lod,
            timestampMs: readyNowMs,
            payloadCompressedBytes: compressedPayloadBytes,
            payloadRawBytes: rawBytes,
            durationMs: decodeResult.decodeDurationMs,
            queueDepths: depths,
            detail: {
              meshCount: fp.meshCount,
              triangleCount: fp.triangleCount,
              usedWebWorker: decodeResult.usedWebWorker,
              usedCompactTransport: wt?.usedCompactTransport,
              workerInflateMs: wt?.workerInflateMs,
              workerDecodeOnlyMs: wt?.workerDecodeOnlyMs,
              workerBvhBuildMs: wt?.workerBvhBuildMs,
              messageDeliveryLatencyMs: wt?.messageDeliveryLatencyMs,
              mainOnMessageHandlerMs: wt?.mainOnMessageHandlerMs,
              mainPromiseContinuationMs: Number(contDurationMs.toFixed(3)),
              transferableBufferCount: wt?.transferableBufferCount,
              transferableBytes: wt?.transferableBytes,
            },
          });
          profAtDecodeDone.recordEvent({
            eventType: 'ready_to_commit',
            tileKey,
            tileSizeMeters,
            lod,
            timestampMs: readyNowMs,
            payloadCompressedBytes: compressedPayloadBytes,
            payloadRawBytes: rawBytes,
            queueDepths: depths,
          });
        }
        this.wakeIdleWaiters();
      } catch (err) {
        if (
          abortController.signal.aborted ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          return;
        }
        if (record.requestGeneration === generation) {
          const msg = err instanceof Error ? err.message : String(err);
          record.state = 'error';
          record.lastError = msg;
          record.abortController = null;
          this.lastTileError = `${tileKey}: ${msg}`;
          this.needsViewportRefresh = true;

          const profAtErr =
            this.profiler && this.profiler.enabled ? this.profiler : null;
          if (profAtErr) {
            profAtErr.recordEvent({
              eventType: 'error',
              tileKey,
              tileSizeMeters,
              lod,
              queueDepths: this.getQueueDepthSnapshot(),
              detail: { reason: msg },
            });
          }
          this.emitDiagnostics();
        }
      } finally {
        this.activeFetchCount = Math.max(0, this.activeFetchCount - 1);
        if (!this.isDisposed) {
          this.pumpFetchQueue();
          this.checkIdleWaiters();
        }
      }
    })();
  }

  private cancelInFlightTile(record: ManagedTileRecord): void {
    const prevState = record.state;
    const isPrewarmTile =
      this.hierarchy !== null &&
      this.prewarmTargetResolutionMeters !== null &&
      record.resolutionMeters === this.prewarmTargetResolutionMeters;
    if (prevState === 'retrieved_queued' && record.retrievedBuffer) {
      this.wastedNetworkBytes += record.retrievedBuffer.byteLength;
      if (isPrewarmTile) {
        this.wastedPrewarmBytes += record.retrievedBuffer.byteLength;
      }
    } else if (prevState === 'ready_to_commit' && record.decodedFootprint) {
      const bytes =
        record.decodedFootprint.cpuGeometryBytes +
        record.decodedFootprint.bvhBytes;
      this.discardedPreparedTilesTotal += 1;
      if (isPrewarmTile) {
        this.wastedPrewarmBytes += bytes;
      }
    }
    this.releaseRecordStageReservations(record);
    record.requestGeneration = this.requestGenerationCounter++;
    if (record.abortController) {
      record.abortController.abort();
      record.abortController = null;
    }
    record.decodedPayload = null;
    record.decodedFootprint = null;
    record.state = 'unloaded';
    this.cancelledRequestsTotal += 1;
    if (
      this.pendingResolutionMeters !== null &&
      record.resolutionMeters === this.pendingResolutionMeters
    ) {
      this.currentTransitionCancellations += 1;
    }
    if (this.profiler && this.profiler.enabled) {
      this.profiler.recordEvent({
        eventType: 'cancel',
        tileKey: record.tileKey,
        tileSizeMeters: record.resolutionMeters,
        lod: record.manifest.lod,
        payloadCompressedBytes: record.lastCompressedBytes ?? null,
        queueDepths: this.getQueueDepthSnapshot(),
        detail: { reason: `cancelled_from_${prevState}` },
      });
    }
  }

  private evictLoadedTile(
    record: ManagedTileRecord,
    forceImmediate = false
  ): void {
    if (!record.reconstructed) {
      this.releaseRecordStageReservations(record);
      record.state = 'unloaded';
      return;
    }
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    const t0 = prof ? this.nowFn() : 0;
    const fp = record.decodedFootprint;
    const compressedBytes = record.lastCompressedBytes ?? null;
    const breakdown = this.computeRecordFootprintBreakdown(record);

    this.detachTileFromCompositeScene(record);
    this.releaseRecordStageReservations(record);
    const reconstructed = record.reconstructed;
    record.reconstructed = null;
    record.decodedPayload = null;
    record.decodedFootprint = null;
    record.state = 'unloaded';
    this.evictedTilesTotal += 1;

    this.gpuPreparer.cancelTile(record.tileKey, reconstructed, true);
    if (this.streamingFrameBudget.deferredDisposalEnabled && !forceImmediate) {
      this.deferredDisposalQueue.enqueue({
        tileKey: record.tileKey,
        resolutionMeters: record.resolutionMeters,
        lod: record.manifest.lod,
        reconstructed,
        measuredBytes: breakdown.totalMeasuredBytes,
        estimatedGpuBytes: breakdown.estimatedGpuBytes,
        isCacheEviction: false,
      });
      if (prof) {
        const durMs = Math.max(0, this.nowFn() - t0);
        const qDepths = this.getQueueDepthSnapshot();
        prof.recordEvent({
          eventType: 'evict',
          tileKey: record.tileKey,
          tileSizeMeters: record.resolutionMeters,
          lod: record.manifest.lod,
          payloadCompressedBytes: compressedBytes,
          payloadRawBytes: fp ? fp.cpuGeometryBytes + fp.bvhBytes : null,
          durationMs: durMs,
          queueDepths: qDepths,
          detail: fp
            ? {
                meshCount: fp.meshCount,
                triangleCount: fp.triangleCount,
              }
            : undefined,
        });
        prof.recordEvent({
          eventType: 'deferred_dispose_enqueue',
          tileKey: record.tileKey,
          tileSizeMeters: record.resolutionMeters,
          lod: record.manifest.lod,
          payloadCompressedBytes: compressedBytes,
          payloadRawBytes: breakdown.totalMeasuredBytes,
          durationMs: durMs,
          queueDepths: qDepths,
          detail: {
            deferredDisposePendingTiles: this.deferredDisposalQueue.size,
            deferredDisposePendingBytes: this.deferredDisposalQueue.totalPendingBytes,
          },
        });
      }
      return;
    }

    reconstructed.dispose();

    if (prof) {
      prof.recordEvent({
        eventType: 'evict',
        tileKey: record.tileKey,
        tileSizeMeters: record.resolutionMeters,
        lod: record.manifest.lod,
        payloadCompressedBytes: compressedBytes,
        payloadRawBytes: fp ? fp.cpuGeometryBytes + fp.bvhBytes : null,
        durationMs: Math.max(0, this.nowFn() - t0),
        queueDepths: this.getQueueDepthSnapshot(),
        detail: fp
          ? {
              meshCount: fp.meshCount,
              triangleCount: fp.triangleCount,
            }
          : undefined,
      });
    }
  }

  private attachTileToCompositeScene(record: ManagedTileRecord): void {
    const reconstructed = record.reconstructed;
    if (!reconstructed) return;
    const tileScene = reconstructed.scene;
    const tileKey = record.tileKey;

    const layerPairs: ReadonlyArray<[THREE.Group, THREE.Group, Exclude<TileLayerKind, 'ground'>]> = [
      [this.compositeScene.buildingsGroup, tileScene.buildingsGroup, 'buildings'],
      [this.compositeScene.roadsGroup, tileScene.roadsGroup, 'roads'],
      [this.compositeScene.railwaysGroup, tileScene.railwaysGroup, 'railways'],
      [this.compositeScene.waterGroup, tileScene.waterGroup, 'water'],
      [this.compositeScene.parksGroup, tileScene.parksGroup, 'parks'],
      [this.compositeScene.landuseGroup, tileScene.landuseGroup, 'landuse'],
      [this.compositeScene.barriersGroup, tileScene.barriersGroup, 'barriers'],
      [this.compositeScene.foliageGroup, tileScene.foliageGroup, 'foliage'],
    ];

    for (const [parentGroup, childGroup, layerKind] of layerPairs) {
      if (childGroup.children.length > 0) {
        childGroup.name = `${layerKind}_${tileKey}`;
        childGroup.userData.tileKey = tileKey;
        childGroup.userData.resolutionMeters = record.resolutionMeters;
        parentGroup.add(childGroup);
        childGroup.updateMatrixWorld(true);
      }
    }
  }

  private detachTileFromCompositeScene(record: ManagedTileRecord): void {
    const reconstructed = record.reconstructed;
    if (!reconstructed) return;
    const tileScene = reconstructed.scene;

    this.compositeScene.buildingsGroup.remove(tileScene.buildingsGroup);
    this.compositeScene.roadsGroup.remove(tileScene.roadsGroup);
    this.compositeScene.railwaysGroup.remove(tileScene.railwaysGroup);
    this.compositeScene.waterGroup.remove(tileScene.waterGroup);
    this.compositeScene.parksGroup.remove(tileScene.parksGroup);
    this.compositeScene.landuseGroup.remove(tileScene.landuseGroup);
    this.compositeScene.barriersGroup.remove(tileScene.barriersGroup);
    this.compositeScene.foliageGroup.remove(tileScene.foliageGroup);
  }

  private rebuildCompositeStats(): void {
    let totalVertices = 0;
    let totalTriangles = 0;
    let totalDrawCalls = 0;
    let renderedFeaturesCount = 0;
    let forestTreesCount = 0;
    let totalSleeper3DBoxCount = 0;
    const interactiveBuildings: THREE.Mesh[] = [];

    const activeLevel = this.getActiveLevelState();
    const recordSource = activeLevel ? activeLevel.tilesByKey : this.tilesByKey;
    for (const record of recordSource.values()) {
      if (record.state !== 'loaded' || !record.reconstructed) continue;
      const s = record.reconstructed.scene;
      totalVertices += s.stats.totalVertices;
      totalTriangles += s.stats.totalTriangles;
      totalDrawCalls += s.stats.totalDrawCalls;
      renderedFeaturesCount += s.stats.renderedFeaturesCount;
      forestTreesCount += s.stats.forestTreesCount;
      const rwStats = s.railwaysGroup.userData?.railwayStats as
        | { sleeper3DBoxCount?: number }
        | undefined;
      totalSleeper3DBoxCount += rwStats?.sleeper3DBoxCount ?? 0;
      interactiveBuildings.push(...s.interactiveMeshes.buildings);
    }

    this.compositeSceneRevision += 1;
    this.compositeScene.stats.totalVertices = totalVertices;
    this.compositeScene.stats.totalTriangles = totalTriangles;
    this.compositeScene.stats.totalDrawCalls = totalDrawCalls;
    this.compositeScene.stats.renderedFeaturesCount = renderedFeaturesCount;
    this.compositeScene.stats.forestTreesCount = forestTreesCount;
    this.compositeScene.interactiveMeshes.buildings = interactiveBuildings;
    this.compositeScene.railwaysGroup.userData.railwayStats = {
      sleeper3DBoxCount: totalSleeper3DBoxCount,
      railwayRenderSource: 'graph_extrusion',
    };
    this.compositeScene.railwaysGroup.userData.compositeRevision =
      this.compositeSceneRevision;
    this.groundMesh.userData.__compositeRevision = this.compositeSceneRevision;
    if (this.activeResolutionMeters !== null) {
      this.groundMesh.userData.__activeResolutionMeters =
        this.activeResolutionMeters;
    }

    // TKT-040 Work Package D: attachTileToCompositeScene already calls
    // childGroup.updateMatrixWorld(true) on newly attached tiles, so avoid
    // re-traversing every already-loaded tile in all 8 composite layer groups.
    if (!this.tilePrepOptions.optimizeMainThreadPrep) {
      for (const layerKind of STREAMED_LAYER_KINDS) {
        const grp = this.compositeScene[`${layerKind}Group` as const];
        grp.updateMatrixWorld(true);
      }
    }
  }

  private updatePeakTileCounters(): void {
    let loadedNow = 0;
    let loadingNow = 0;
    for (const record of this.tilesByKey.values()) {
      if (record.state === 'loaded') loadedNow += 1;
      else if (
        record.state === 'queued' ||
        record.state === 'fetching' ||
        record.state === 'retrieved_queued' ||
        record.state === 'decoding' ||
        record.state === 'ready_to_commit'
      ) {
        loadingNow += 1;
      }
    }
    if (loadedNow > this.peakLoadedTiles) this.peakLoadedTiles = loadedNow;
    if (loadingNow > this.peakLoadingTiles) this.peakLoadingTiles = loadingNow;
  }

  private hasPendingAsyncWork(): boolean {
    if (this.activeFetchCount > 0 || this.activeDecodeCount > 0) return true;
    const coverageGap =
      this.streamingFrameBudget.suppressSpeculativeDuringActiveCoverageGap &&
      this.hasActiveVisibleCoverageGap();
    const pendingTransitionNeedsVisible =
      this.hierarchy !== null &&
      this.pendingResolutionMeters !== null &&
      this.transitionState !== 'deferred_budget' &&
      this.streamingFrameBudget.prioritizeDestinationOverActivePreload &&
      (() => {
        const pendingLevel = this.getPendingLevelState();
        return pendingLevel ? !this.checkDestinationReadiness(pendingLevel).allReady : false;
      })();

    for (const record of this.tilesByKey.values()) {
      if (
        record.state === 'fetching' ||
        record.state === 'decoding'
      ) {
        return true;
      }
      if (record.state === 'retrieved_queued' && record.isInKeepSet) {
        if (!this.workerBackpressureActive) {
          return true;
        }
      }
      if (record.state === 'queued' && record.isInFetchSet) {
        if (this.workerBackpressureActive) {
          continue;
        }
        if (this.hierarchy) {
          const isActiveRes =
            record.resolutionMeters === this.activeResolutionMeters;
          const isPendingRes =
            record.resolutionMeters === this.pendingResolutionMeters &&
            this.transitionState !== 'deferred_budget';
          const isPrewarmRes =
            this.pendingResolutionMeters === null &&
            record.resolutionMeters === this.prewarmTargetResolutionMeters &&
            this.streamingFrameBudget.predictivePrewarmEnabled;
          if (!isActiveRes && !isPendingRes && !isPrewarmRes) continue;
          if (
            (!record.isVisibleInViewport || isPrewarmRes) &&
            (this.speculativeBackpressureActive || coverageGap)
          ) {
            continue;
          }
          if (pendingTransitionNeedsVisible && !record.isVisibleInViewport) {
            continue;
          }
        } else if (coverageGap && !record.isVisibleInViewport) {
          continue;
        }
        return true;
      }
    }
    return false;
  }

  private isCurrentlyIdle(): boolean {
    if (this.hasPendingAsyncWork()) return false;
    if (this.pendingDebounceTargetResolution !== null) return false;
    if (this.deferredDisposalQueue.size > 0) return false;
    for (const record of this.tilesByKey.values()) {
      if (record.state === 'ready_to_commit' && record.isInKeepSet) {
        if (
          this.hierarchy &&
          record.resolutionMeters === this.pendingResolutionMeters &&
          this.transitionState === 'deferred_budget'
        ) {
          continue;
        }
        return false;
      }
    }
    if (
      this.hierarchy &&
      this.pendingResolutionMeters !== null &&
      this.transitionState !== 'deferred_budget'
    ) {
      if (this.transitionState === 'ready_to_activate') {
        return false;
      }
      if (this.isIncrementalGpuPrepActive()) {
        const pendingLevel = this.getPendingLevelState();
        if (
          pendingLevel &&
          this.collectPendingGpuPrepRecords(pendingLevel).some(
            (r) => r.isVisibleInViewport
          )
        ) {
          return false;
        }
      }
    }
    return true;
  }

  private wakeIdleWaiters(): void {
    if (this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const resolve of waiters) {
      resolve();
    }
  }

  private checkIdleWaiters(): void {
    if (this.idleWaiters.length === 0) return;
    if (
      this.isDisposed ||
      (!this.streamingFrameBudget.independentPipelineStagesEnabled &&
        this.activeFetchCount === 0) ||
      !this.hasPendingAsyncWork()
    ) {
      this.wakeIdleWaiters();
    }
  }

  private emitDiagnostics(): void {
    if (this.onDiagnosticsChange) {
      this.onDiagnosticsChange(this.getDiagnostics());
    }
  }
}
