/**
 * TKT-040: Configuration and cross-thread instrumentation types for non-blocking
 * tile preparation, worker payload transfer, compact metadata transport, and
 * worker-side instanced spatial index (BVH) construction.
 */

export type TilePreparationVariantId =
  | 'baseline'
  | 'transfer_only'
  | 'compact_transport'
  | 'worker_bvh'
  | 'combined';

export const ALL_TILE_PREPARATION_VARIANTS: readonly TilePreparationVariantId[] = [
  'baseline',
  'transfer_only',
  'compact_transport',
  'worker_bvh',
  'combined',
];

export interface TilePreparationOptions {
  /**
   * Include all eligible typed-array backing buffers (including `instanceFeatureIdxs`,
   * compact metadata buffers, and worker-prepared BVH buffers) in `postMessage` transfer list.
   * When `false`, reproduces the pre-TKT-040 baseline where `instanceFeatureIdxs` was omitted.
   */
  transferAllTypedArrays: boolean;
  /**
   * Transport high-cardinality metadata (`featureInfos`, `faceRanges`, `groups`,
   * `sleeperBoxes`, precomputed footprint) via compact transferable typed arrays
   * with lazy on-demand feature materialization instead of large structured-cloned JS graphs.
   */
  compactMetadataTransport: boolean;
  /**
   * Build `InstancedSpatialIndex` BVH structures inside the Web Worker and transfer
   * compact flat typed arrays for O(1) main-thread adoption.
   */
  workerInstanceBvh: boolean;
  /**
   * Eliminate avoidable main-thread preparation work during tile reconstruction
   * (adopt `matrices` buffer directly on `InstancedMesh`, derive conservative bounds
   * from worker BVH root bounds, use lazy metadata lookup without eager object arrays).
   */
  optimizeMainThreadPrep: boolean;
}

export const DEFAULT_TILE_PREPARATION_VARIANT: TilePreparationVariantId = 'combined';

export const TILE_PREPARATION_VARIANT_PRESETS: Readonly<
  Record<TilePreparationVariantId, Readonly<TilePreparationOptions>>
> = {
  baseline: {
    transferAllTypedArrays: false,
    compactMetadataTransport: false,
    workerInstanceBvh: false,
    optimizeMainThreadPrep: false,
  },
  transfer_only: {
    transferAllTypedArrays: true,
    compactMetadataTransport: false,
    workerInstanceBvh: false,
    optimizeMainThreadPrep: false,
  },
  compact_transport: {
    transferAllTypedArrays: true,
    compactMetadataTransport: true,
    workerInstanceBvh: false,
    optimizeMainThreadPrep: false,
  },
  worker_bvh: {
    transferAllTypedArrays: true,
    compactMetadataTransport: false,
    workerInstanceBvh: true,
    optimizeMainThreadPrep: false,
  },
  combined: {
    transferAllTypedArrays: true,
    compactMetadataTransport: true,
    workerInstanceBvh: true,
    optimizeMainThreadPrep: true,
  },
};

export function isTilePreparationVariantId(
  value: unknown
): value is TilePreparationVariantId {
  return (
    value === 'baseline' ||
    value === 'transfer_only' ||
    value === 'compact_transport' ||
    value === 'worker_bvh' ||
    value === 'combined'
  );
}

export function resolveTilePreparationOptions(
  input?: TilePreparationVariantId | Partial<TilePreparationOptions> | null
): TilePreparationOptions {
  if (!input) {
    return { ...TILE_PREPARATION_VARIANT_PRESETS[DEFAULT_TILE_PREPARATION_VARIANT] };
  }
  if (typeof input === 'string') {
    const preset = isTilePreparationVariantId(input)
      ? TILE_PREPARATION_VARIANT_PRESETS[input]
      : TILE_PREPARATION_VARIANT_PRESETS[DEFAULT_TILE_PREPARATION_VARIANT];
    return { ...preset };
  }
  const base = TILE_PREPARATION_VARIANT_PRESETS[DEFAULT_TILE_PREPARATION_VARIANT];
  return {
    transferAllTypedArrays:
      typeof input.transferAllTypedArrays === 'boolean'
        ? input.transferAllTypedArrays
        : base.transferAllTypedArrays,
    compactMetadataTransport:
      typeof input.compactMetadataTransport === 'boolean'
        ? input.compactMetadataTransport
        : base.compactMetadataTransport,
    workerInstanceBvh:
      typeof input.workerInstanceBvh === 'boolean'
        ? input.workerInstanceBvh
        : base.workerInstanceBvh,
    optimizeMainThreadPrep:
      typeof input.optimizeMainThreadPrep === 'boolean'
        ? input.optimizeMainThreadPrep
        : base.optimizeMainThreadPrep,
  };
}

export function identifyTilePreparationVariant(
  opts: TilePreparationOptions
): TilePreparationVariantId | 'custom' {
  for (const id of ALL_TILE_PREPARATION_VARIANTS) {
    const p = TILE_PREPARATION_VARIANT_PRESETS[id];
    if (
      p.transferAllTypedArrays === opts.transferAllTypedArrays &&
      p.compactMetadataTransport === opts.compactMetadataTransport &&
      p.workerInstanceBvh === opts.workerInstanceBvh &&
      p.optimizeMainThreadPrep === opts.optimizeMainThreadPrep
    ) {
      return id;
    }
  }
  return 'custom';
}

export function parseTilePreparationOptionsFromSearch(
  search: string
): TilePreparationOptions {
  const params = new URLSearchParams(search);
  const rawVariant = params.get('tilePrepVariant')?.trim().toLowerCase();
  const base = isTilePreparationVariantId(rawVariant)
    ? resolveTilePreparationOptions(rawVariant)
    : resolveTilePreparationOptions(DEFAULT_TILE_PREPARATION_VARIANT);

  const parseBool = (key: string, fallback: boolean): boolean => {
    const raw = params.get(key)?.trim().toLowerCase();
    if (raw === '0' || raw === 'false' || raw === 'off') return false;
    if (raw === '1' || raw === 'true' || raw === 'on') return true;
    return fallback;
  };

  return {
    transferAllTypedArrays: parseBool('tilePrepTransferAll', base.transferAllTypedArrays),
    compactMetadataTransport: parseBool('tilePrepCompact', base.compactMetadataTransport),
    workerInstanceBvh: parseBool('tilePrepWorkerBvh', base.workerInstanceBvh),
    optimizeMainThreadPrep: parseBool('tilePrepOptMain', base.optimizeMainThreadPrep),
  };
}

/**
 * Epoch-aligned monotonic timestamp (`performance.timeOrigin + performance.now()`),
 * allowing meaningful cross-thread deltas between the main thread and Web Workers.
 */
export function nowEpochMs(): number {
  if (typeof performance !== 'undefined') {
    if (typeof performance.timeOrigin === 'number' && Number.isFinite(performance.timeOrigin)) {
      return performance.timeOrigin + performance.now();
    }
    return performance.now();
  }
  return Date.now();
}

/**
 * Detailed stage timings for a single tile decode and worker-to-main-thread delivery.
 *
 * Methodological note: `messageDeliveryLatencyMs` spans from right before worker
 * `postMessage(...)` to JS entry into main-thread `worker.onmessage`. In browsers,
 * internal structured-clone deserialization of non-transferred JS object graphs may
 * run on the main thread BEFORE JS enters `onmessage`, so `mainOnMessageHandlerMs`
 * measures only synchronous JS execution inside the handler and NOT browser-internal
 * deserialization time occurring prior to handler invocation.
 */
export interface WorkerDecodeStageTimings {
  usedWebWorker: boolean;
  usedCompactTransport: boolean;
  transferAllTypedArrays: boolean;
  workerInstanceBvhEnabled: boolean;
  /** Queue + IPC wait from main-thread postMessage to worker onmessage entry. */
  workerQueueWaitMs: number;
  /** Worker decompression (inflate) + binary decode time. */
  workerInflateAndDecodeMs: number;
  /** Worker InstancedSpatialIndex BVH construction time (0 when disabled). */
  workerBvhBuildMs: number;
  /** Worker payload preparation (compact packing, footprint, transferable collection). */
  workerPayloadPrepMs: number;
  /** Synchronous duration of worker-side postMessage() call. */
  workerPostMessageCallMs: number;
  /** Total time spent inside worker onmessage handler. */
  workerTotalMs: number;
  /**
   * Cross-thread delivery latency from worker postMessage submission to main-thread
   * onmessage entry (includes IPC transit, event-loop queueing, and browser-internal
   * structured-clone deserialization before JS enters onmessage).
   */
  messageDeliveryLatencyMs: number;
  /** Synchronous JS duration inside main-thread worker.onmessage handler. */
  mainOnMessageHandlerMs: number;
  /** Synchronous JS duration inside TileStreamManager post-await continuation. */
  mainPromiseContinuationMs: number;
  /** Main-thread `performance.now()` timestamp at onmessage entry (for frame alignment). */
  mainOnMessageStartMs: number;
  /** Main-thread `performance.now()` timestamp at onmessage exit. */
  mainOnMessageEndMs: number;
  /** Number of unique ArrayBuffers passed in transferList. */
  transferableBufferCount: number;
  /** Total byte length of unique ArrayBuffers passed in transferList. */
  transferableBytes: number;
  /** Number of instanced batches whose BVH was constructed inside the worker. */
  workerBvhBatchCount: number;
  /** Total instances indexed inside the worker across those batches. */
  workerBvhInstanceCount: number;
}
