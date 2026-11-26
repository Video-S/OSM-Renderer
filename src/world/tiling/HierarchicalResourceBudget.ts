export interface HierarchicalResourceBudgetConfig {
  /**
   * Total measured CPU + BVH + instanced-index + queued-payload + pending-disposal
   * memory budget across all resolutions (provisional desktop default: 1,536 MiB,
   * configurable via URL/UI/API).
   */
  totalMemoryBudgetBytes: number;
  /**
   * Maximum measured bytes retained in the bounded inactive-resolution tile cache
   * (default: 25% of totalMemoryBudgetBytes, capped at 384 MiB).
   */
  inactiveCacheBudgetBytes: number;
  /** Maximum number of detached inactive tiles retained in LRU cache (default: 48). */
  maxInactiveCachedTiles: number;
  /**
   * Backpressure threshold for uncommitted `ready_to_commit` decoded payloads
   * (default: 25% of totalMemoryBudgetBytes, capped at 256 MiB).
   */
  maxPendingDecodedBytes: number;
  /**
   * Fraction of `totalMemoryBudgetBytes` reserved for replacement coverage during transitions
   * (default: 0.35). Non-visible speculative preload is suppressed once resident memory
   * encroaches on this reserve.
   */
  transitionReserveRatio: number;
  /**
   * Time-aware per-frame commit budget in milliseconds (TKT-041 baseline fallback when
   * the TKT-041-F1 shared workload scheduler is disabled).
   */
  maxCommitBudgetMsPerFrame: number;
}

export const DEFAULT_TOTAL_MEMORY_BUDGET_BYTES = 1536 * 1024 * 1024; // 1,536 MiB provisional desktop budget
export const DEFAULT_INACTIVE_CACHE_BUDGET_BYTES = 384 * 1024 * 1024; // 384 MiB
export const DEFAULT_MAX_INACTIVE_CACHED_TILES = 48;
export const DEFAULT_MAX_PENDING_DECODED_BYTES = 256 * 1024 * 1024; // 256 MiB
export const DEFAULT_TRANSITION_RESERVE_RATIO = 0.35;
export const DEFAULT_MAX_COMMIT_BUDGET_MS_PER_FRAME = 4.5;

export const DEFAULT_HIERARCHICAL_RESOURCE_BUDGET: Readonly<HierarchicalResourceBudgetConfig> =
  Object.freeze({
    totalMemoryBudgetBytes: DEFAULT_TOTAL_MEMORY_BUDGET_BYTES,
    inactiveCacheBudgetBytes: DEFAULT_INACTIVE_CACHE_BUDGET_BYTES,
    maxInactiveCachedTiles: DEFAULT_MAX_INACTIVE_CACHED_TILES,
    maxPendingDecodedBytes: DEFAULT_MAX_PENDING_DECODED_BYTES,
    transitionReserveRatio: DEFAULT_TRANSITION_RESERVE_RATIO,
    maxCommitBudgetMsPerFrame: DEFAULT_MAX_COMMIT_BUDGET_MS_PER_FRAME,
  });

export function normalizeHierarchicalResourceBudget(
  partial?: Partial<HierarchicalResourceBudgetConfig> | null
): HierarchicalResourceBudgetConfig {
  const base = DEFAULT_HIERARCHICAL_RESOURCE_BUDGET;
  const totalMemoryBudgetBytes =
    typeof partial?.totalMemoryBudgetBytes === 'number' &&
    Number.isFinite(partial.totalMemoryBudgetBytes) &&
    partial.totalMemoryBudgetBytes > 0
      ? Math.round(partial.totalMemoryBudgetBytes)
      : base.totalMemoryBudgetBytes;

  const defaultInactive = Math.min(
    DEFAULT_INACTIVE_CACHE_BUDGET_BYTES,
    Math.round(totalMemoryBudgetBytes * 0.25)
  );
  const inactiveCacheBudgetBytes =
    typeof partial?.inactiveCacheBudgetBytes === 'number' &&
    Number.isFinite(partial.inactiveCacheBudgetBytes) &&
    partial.inactiveCacheBudgetBytes >= 0
      ? Math.min(totalMemoryBudgetBytes, Math.round(partial.inactiveCacheBudgetBytes))
      : defaultInactive;

  const maxInactiveCachedTiles =
    typeof partial?.maxInactiveCachedTiles === 'number' &&
    Number.isFinite(partial.maxInactiveCachedTiles) &&
    partial.maxInactiveCachedTiles >= 0
      ? Math.floor(partial.maxInactiveCachedTiles)
      : base.maxInactiveCachedTiles;

  const defaultPendingDecoded = Math.min(
    DEFAULT_MAX_PENDING_DECODED_BYTES,
    Math.round(totalMemoryBudgetBytes * 0.25)
  );
  const maxPendingDecodedBytes =
    typeof partial?.maxPendingDecodedBytes === 'number' &&
    Number.isFinite(partial.maxPendingDecodedBytes) &&
    partial.maxPendingDecodedBytes > 0
      ? Math.min(totalMemoryBudgetBytes, Math.round(partial.maxPendingDecodedBytes))
      : defaultPendingDecoded;

  const transitionReserveRatio =
    typeof partial?.transitionReserveRatio === 'number' &&
    Number.isFinite(partial.transitionReserveRatio) &&
    partial.transitionReserveRatio >= 0 &&
    partial.transitionReserveRatio <= 0.8
      ? partial.transitionReserveRatio
      : base.transitionReserveRatio;

  const maxCommitBudgetMsPerFrame =
    typeof partial?.maxCommitBudgetMsPerFrame === 'number' &&
    Number.isFinite(partial.maxCommitBudgetMsPerFrame) &&
    partial.maxCommitBudgetMsPerFrame > 0
      ? partial.maxCommitBudgetMsPerFrame
      : base.maxCommitBudgetMsPerFrame;

  return {
    totalMemoryBudgetBytes,
    inactiveCacheBudgetBytes,
    maxInactiveCachedTiles,
    maxPendingDecodedBytes,
    transitionReserveRatio,
    maxCommitBudgetMsPerFrame,
  };
}

/**
 * Per-resolution resource accounting separating directly measured CPU/typed-array
 * bytes from estimated GPU VRAM allocations (WebGL does not expose exact driver VRAM).
 */
export interface ResolutionResourceAccounting {
  tileSizeMeters: number;
  attachedActiveTiles: number;
  preparedPendingTiles: number;
  cachedInactiveTiles: number;
  queuedTiles: number;
  fetchingTiles: number;
  decodingTiles: number;
  readyToCommitTiles: number;
  /** Detached tiles currently awaiting paced disposal in DeferredDisposalQueue. */
  pendingDisposalTiles: number;
  /** Directly measured typed-array geometry bytes (positions/normals/uvs/indices/matrices). */
  measuredCpuGeometryBytes: number;
  /** Directly measured static MeshBVH serialized/buffer bytes. */
  measuredStaticBvhBytes: number;
  /** Directly measured InstancedSpatialIndex flat typed-array BVH bytes. */
  measuredInstancedIndexBytes: number;
  /** Directly measured uncommitted decoded payloads queued in `ready_to_commit`. */
  measuredQueuedDecodedBytes: number;
  /** Estimated in-flight worker preparation buffers for tiles in `fetching`/`decoding`. */
  estimatedWorkerBufferBytes: number;
  /** Directly measured bytes of detached reconstructed tiles retained in the inactive cache. */
  measuredRetainedInactiveBytes: number;
  /** Directly measured bytes of detached tiles awaiting disposal in DeferredDisposalQueue. */
  measuredPendingDisposalBytes: number;
  /** Estimated GPU buffer bytes (vertex/index/instance buffers on reconstructed + pending-disposal meshes; NOT driver-queried). */
  estimatedGpuBytes: number;
}

export interface HierarchicalResourceAccountingSnapshot {
  /** Configured budget limits. */
  budget: HierarchicalResourceBudgetConfig;
  /** Directly measured CPU geometry bytes on active attached tiles. */
  activeGeometryBytes: number;
  /** Directly measured bytes on prepared + queued pending-destination tiles. */
  pendingDestinationGeometryBytes: number;
  /** Estimated bytes currently in flight across HTTP/worker preparation. */
  estimatedWorkerPrepBufferBytes: number;
  /** Directly measured uncommitted decoded payloads in `ready_to_commit`. */
  queuedDecodedPayloadBytes: number;
  /** Directly measured InstancedSpatialIndex BVH bytes across all resident tiles. */
  instancedSpatialIndexBytes: number;
  /** Directly measured static MeshBVH bytes across all resident tiles. */
  staticBvhBytes: number;
  /** Directly measured bytes of detached tiles retained in the inactive cache. */
  retainedInactiveTilesBytes: number;
  /** Count of detached tiles currently awaiting paced disposal. */
  pendingDisposalTiles: number;
  /** Directly measured bytes of detached tiles currently awaiting paced disposal. */
  pendingDisposalBytes: number;
  /** Total directly measured CPU + BVH + instanced-index + queued + pending-disposal bytes across all resolutions. */
  totalMeasuredBytes: number;
  /** Total estimated GPU buffer bytes across all reconstructed + pending-disposal tiles (explicitly estimated). */
  totalEstimatedGpuBytes: number;
  /** True when speculative preload / background caching is suppressed due to budget pressure. */
  speculativeBackpressureActive: boolean;
  /** True when worker dispatch is throttled because queued decoded bytes hit limit. */
  workerBackpressureActive: boolean;
  /** Per-resolution resource breakdown sorted ascending by tileSizeMeters. */
  byResolution: ResolutionResourceAccounting[];
}

export function createEmptyResolutionAccounting(
  tileSizeMeters: number
): ResolutionResourceAccounting {
  return {
    tileSizeMeters,
    attachedActiveTiles: 0,
    preparedPendingTiles: 0,
    cachedInactiveTiles: 0,
    queuedTiles: 0,
    fetchingTiles: 0,
    decodingTiles: 0,
    readyToCommitTiles: 0,
    pendingDisposalTiles: 0,
    measuredCpuGeometryBytes: 0,
    measuredStaticBvhBytes: 0,
    measuredInstancedIndexBytes: 0,
    measuredQueuedDecodedBytes: 0,
    estimatedWorkerBufferBytes: 0,
    measuredRetainedInactiveBytes: 0,
    measuredPendingDisposalBytes: 0,
    estimatedGpuBytes: 0,
  };
}

/**
 * Parses optional budget URL overrides:
 * - `?hierarchicalBudgetMb=1536`
 * - `?hierarchicalCacheMb=384`
 * - `?hierarchicalCommitBudgetMs=4.5`
 */
export function parseHierarchicalBudgetFromSearch(
  search: string
): Partial<HierarchicalResourceBudgetConfig> | null {
  if (!search) return null;
  const params = new URLSearchParams(search);
  const partial: Partial<HierarchicalResourceBudgetConfig> = {};
  let hasAny = false;

  const budgetMbRaw = params.get('hierarchicalBudgetMb')?.trim();
  if (budgetMbRaw) {
    const mb = Number(budgetMbRaw);
    if (Number.isFinite(mb) && mb >= 1 && mb <= 8192) {
      partial.totalMemoryBudgetBytes = Math.round(mb * 1024 * 1024);
      hasAny = true;
    }
  }

  const cacheMbRaw = params.get('hierarchicalCacheMb')?.trim();
  if (cacheMbRaw) {
    const mb = Number(cacheMbRaw);
    if (Number.isFinite(mb) && mb >= 0 && mb <= 4096) {
      partial.inactiveCacheBudgetBytes = Math.round(mb * 1024 * 1024);
      hasAny = true;
    }
  }

  const commitMsRaw = params.get('hierarchicalCommitBudgetMs')?.trim();
  if (commitMsRaw) {
    const ms = Number(commitMsRaw);
    if (Number.isFinite(ms) && ms > 0.25 && ms <= 100) {
      partial.maxCommitBudgetMsPerFrame = ms;
      hasAny = true;
    }
  }

  return hasAny ? partial : null;
}
