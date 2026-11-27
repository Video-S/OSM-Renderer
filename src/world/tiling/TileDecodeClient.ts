import type { AnyDecodedTilePayload } from './CompactTileTransport';
import {
  ensureRawOmsTileBytes,
  prepareTileInWorker,
  type TileDecodeWorkerErrorResponse,
  type TileDecodeWorkerRequest,
  type TileDecodeWorkerResponse,
} from './TileDecodeWorker';
import {
  nowEpochMs,
  resolveTilePreparationOptions,
  type TilePreparationOptions,
  type TilePreparationVariantId,
  type WorkerDecodeStageTimings,
} from './TilePreparationConfig';

export interface TileDecodeResult {
  decoded: AnyDecodedTilePayload;
  decodeDurationMs: number;
  usedWebWorker: boolean;
  workerTimings: WorkerDecodeStageTimings;
  /** Time spent queued in TileDecodeClient waiting for an idle Web Worker (ms). */
  clientQueueWaitMs?: number;
  /** True if the request signal was aborted while already running on a worker, but retained by policy. */
  completedAfterAbort?: boolean;
}

export interface TileDecodeJobOptions {
  /** Whether this job prepares a required pending destination resolution tile. */
  isDestination?: boolean;
  /**
   * When true, if the job's AbortSignal fires AFTER the job has already been dispatched
   * to a Web Worker (or inline execution has started), allow it to resolve with
   * `completedAfterAbort: true` so the caller can decide whether to retain it in inactive cache.
   * Queued (not-yet-running) jobs are still immediately removed and rejected with AbortError.
   */
  retainIfRunningOnAbort?: boolean;
  /** Estimated payload byte size for worker memory accounting. */
  estimatedBytes?: number;
}

export interface TileDecodeWorkerUtilizationSnapshot {
  configuredWorkerPoolSize: number;
  maxConcurrentWorkers: number;
  busyWorkerCount: number;
  idleWorkerCount: number;
  queuedDecodeCount: number;
  queuedDestinationDecodeCount: number;
  activeDestinationWorkerCount: number;
  totalJobsCompleted: number;
  totalJobsAbortedInQueue: number;
  totalJobsAbortedWhileRunning: number;
  totalJobsRetainedAfterAbort: number;
  totalWorkerActiveTimeMs: number;
  totalClientQueueWaitMs: number;
  wastedWorkerTimeMs: number;
}

export interface WorkerMessageDeliveredInfo {
  tileKey: string;
  onMessageStartMs: number;
  onMessageEndMs: number;
  handlerDurationMs: number;
  timings: WorkerDecodeStageTimings;
}

export interface TileDecodeClient {
  decodeTile(
    buffer: ArrayBuffer,
    tileKey: string,
    signal?: AbortSignal,
    priority?: number,
    jobOptions?: TileDecodeJobOptions
  ): Promise<TileDecodeResult>;
  /**
   * Dynamically updates the priority (and optional destination flag) of a queued
   * decode job without restarting it or losing its enqueue timestamp.
   * Returns true if a queued job was found and updated.
   */
  updateJobPriority(
    tileKey: string,
    newPriority: number,
    isDestination?: boolean
  ): boolean;
  getPreparationOptions(): TilePreparationOptions;
  setPreparationOptions(
    options: TilePreparationVariantId | Partial<TilePreparationOptions>
  ): TilePreparationOptions;
  getActiveWorkerCount(): number;
  getBusyWorkerCount(): number;
  getQueuedDecodeCount(): number;
  getPendingDecodeCount(): number;
  setMaxWorkerConcurrency(
    maxWorkers: number,
    reservedDestinationSlots?: number
  ): void;
  getWorkerUtilizationSnapshot(): TileDecodeWorkerUtilizationSnapshot;
  dispose(): void;
}

export interface TileDecodeClientOptions {
  /** Number of Web Workers in the decode pool (default: 4 in browser for TKT-041-F2). */
  workerCount?: number;
  /** Maximum concurrently active workers (default: workerCount). */
  maxConcurrentWorkers?: number;
  /** Reserved worker slots for pending destination coverage when destination jobs are queued. */
  reservedDestinationWorkerSlots?: number;
  /** Force inline async decode (useful for deterministic unit tests). */
  forceInlineDecode?: boolean;
  /** Maximum duration (ms) a dispatched Web Worker decode job may run before timing out (default: 30000). */
  workerJobTimeoutMs?: number;
  /** Initial TKT-040 tile preparation variant or explicit options (default: 'combined'). */
  preparationOptions?: TilePreparationVariantId | Partial<TilePreparationOptions>;
  /** Optional hook fired synchronously at the end of `worker.onmessage` for frame attribution. */
  onWorkerMessageDelivered?: (info: WorkerMessageDeliveredInfo) => void;
}

interface PendingJob {
  requestId: number;
  tileKey: string;
  buffer: ArrayBuffer;
  priority: number;
  isDestination: boolean;
  retainIfRunningOnAbort: boolean;
  enqueuedAtMs: number;
  dispatchedAtMs: number;
  clientQueueWaitMs: number;
  signal?: AbortSignal;
  abortHandler?: () => void;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  resolve: (result: TileDecodeResult) => void;
  reject: (err: Error) => void;
}

function createAbortError(tileKey: string): Error {
  const err = new Error(`Tile decode aborted for ${tileKey}`);
  err.name = 'AbortError';
  return err;
}

function resolveDefaultWorkerPoolSize(explicitCount?: number): number {
  if (typeof explicitCount === 'number' && Number.isFinite(explicitCount)) {
    return Math.max(1, Math.floor(explicitCount));
  }
  const hc =
    typeof navigator !== 'undefined' &&
    typeof navigator.hardwareConcurrency === 'number' &&
    Number.isFinite(navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : 8;
  return Math.min(4, Math.max(2, Math.floor(hc / 2)));
}

/**
 * Manages a pool of browser Web Workers that decode `OSMTILE1` binary tile payloads
 * off the main thread, with priority-ordered dispatch, dynamic queue reprioritization,
 * reserved destination worker slot fairness, `AbortSignal` cancellation for queued jobs,
 * optional retention of already-running worker jobs, TKT-040/TKT-041-F2 cross-thread
 * timing instrumentation, and automatic fallback in Node.js test environments.
 */
export function createTileDecodeClient(
  options: TileDecodeClientOptions = {}
): TileDecodeClient {
  const poolSize = resolveDefaultWorkerPoolSize(options.workerCount);
  let maxConcurrentWorkers = Math.max(
    1,
    Math.min(poolSize, options.maxConcurrentWorkers ?? poolSize)
  );
  let reservedDestinationSlots = Math.max(
    0,
    Math.min(
      maxConcurrentWorkers - 1,
      options.reservedDestinationWorkerSlots ?? 0
    )
  );
  const workerJobTimeoutMs =
    typeof options.workerJobTimeoutMs === 'number' &&
    Number.isFinite(options.workerJobTimeoutMs) &&
    options.workerJobTimeoutMs > 0
      ? Math.max(250, Math.floor(options.workerJobTimeoutMs))
      : 30000;
  let currentPrepOptions: TilePreparationOptions = resolveTilePreparationOptions(
    options.preparationOptions
  );
  const workers: Worker[] = [];
  const busyWorkers = new Set<Worker>();
  const activeJobsByRequestId = new Map<
    number,
    { job: PendingJob; worker: Worker }
  >();
  const queuedJobs: PendingJob[] = [];
  let nextRequestId = 1;
  let disposed = false;

  // Cumulative utilization telemetry (Work Package A / C / D)
  let totalJobsCompleted = 0;
  let totalJobsAbortedInQueue = 0;
  let totalJobsAbortedWhileRunning = 0;
  let totalJobsRetainedAfterAbort = 0;
  let totalWorkerActiveTimeMs = 0;
  let totalClientQueueWaitMs = 0;
  let wastedWorkerTimeMs = 0;

  const canUseBrowserWorker =
    !options.forceInlineDecode &&
    typeof Worker !== 'undefined' &&
    typeof window !== 'undefined';

  const clearJobListeners = (job: PendingJob): void => {
    if (job.timeoutTimer !== undefined) {
      clearTimeout(job.timeoutTimer);
      job.timeoutTimer = undefined;
    }
    if (job.abortHandler && job.signal) {
      job.signal.removeEventListener('abort', job.abortHandler);
    }
  };

  const countActiveDestinationWorkers = (): number => {
    let count = 0;
    for (const [, active] of activeJobsByRequestId.entries()) {
      if (active.job.isDestination) count += 1;
    }
    return count;
  };

  const hasQueuedDestinationJobs = (): boolean => {
    for (let i = 0; i < queuedJobs.length; i++) {
      if (queuedJobs[i].isDestination && !queuedJobs[i].signal?.aborted) {
        return true;
      }
    }
    return false;
  };

  const popNextEligibleJob = (): PendingJob | undefined => {
    if (queuedJobs.length === 0) return undefined;

    // Enforce reserved destination worker slots when destination jobs are waiting
    const activeDest = countActiveDestinationWorkers();
    const freeSlots = Math.max(0, maxConcurrentWorkers - busyWorkers.size);
    const neededDestSlots = Math.max(0, reservedDestinationSlots - activeDest);
    const mustPickDestination =
      neededDestSlots > 0 &&
      freeSlots <= neededDestSlots &&
      hasQueuedDestinationJobs();

    let bestIdx = -1;
    for (let i = 0; i < queuedJobs.length; i++) {
      const candidate = queuedJobs[i];
      if (mustPickDestination && !candidate.isDestination) {
        continue;
      }
      if (bestIdx === -1) {
        bestIdx = i;
        continue;
      }
      const best = queuedJobs[bestIdx];
      if (
        candidate.priority < best.priority ||
        (candidate.priority === best.priority &&
          candidate.requestId < best.requestId)
      ) {
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      bestIdx = 0;
      for (let i = 1; i < queuedJobs.length; i++) {
        const a = queuedJobs[i];
        const b = queuedJobs[bestIdx];
        if (
          a.priority < b.priority ||
          (a.priority === b.priority && a.requestId < b.requestId)
        ) {
          bestIdx = i;
        }
      }
    }
    return queuedJobs.splice(bestIdx, 1)[0];
  };

  const spawnWorkerInstance = (): Worker => {
    const worker = new Worker(
      new URL('./TileDecodeWorker.ts', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = (event: MessageEvent<TileDecodeWorkerResponse>) => {
      const onMessageStartMs = performance.now();
      const onMessageEnterEpochMs = nowEpochMs();
      const response = event.data;
      const active = activeJobsByRequestId.get(response.requestId);
      if (!active) return;

      activeJobsByRequestId.delete(response.requestId);
      busyWorkers.delete(active.worker);

      const { job } = active;
      clearJobListeners(job);

      const workerExecMs = response.ok
        ? response.decodeDurationMs
        : Math.max(0, onMessageStartMs - job.dispatchedAtMs);
      totalWorkerActiveTimeMs += workerExecMs;

      let deliveredTimings: WorkerDecodeStageTimings | null = null;
      const wasAborted = Boolean(job.signal?.aborted);

      if (wasAborted && !job.retainIfRunningOnAbort) {
        totalJobsAbortedWhileRunning += 1;
        wastedWorkerTimeMs += workerExecMs;
        job.reject(createAbortError(job.tileKey));
      } else if (response.ok) {
        if (wasAborted) {
          totalJobsRetainedAfterAbort += 1;
        }
        totalJobsCompleted += 1;
        const wt = response.workerTimings;
        const deliveryLatencyMs = Number(
          Math.max(
            0,
            onMessageEnterEpochMs - wt.workerPostMessageStartEpochMs
          ).toFixed(3)
        );
        deliveredTimings = {
          usedWebWorker: true,
          usedCompactTransport: wt.usedCompactTransport,
          transferAllTypedArrays: wt.transferAllTypedArrays,
          workerInstanceBvhEnabled: wt.workerInstanceBvhEnabled,
          workerQueueWaitMs: wt.workerQueueWaitMs,
          workerInflateMs: wt.workerInflateMs,
          workerDecodeOnlyMs: wt.workerDecodeOnlyMs,
          workerInflateAndDecodeMs: wt.workerInflateAndDecodeMs,
          workerBvhBuildMs: wt.workerBvhBuildMs,
          workerPayloadPrepMs: wt.workerPayloadPrepMs,
          workerPostMessageCallMs: 0,
          workerTotalMs: wt.workerTotalBeforePostMessageMs,
          messageDeliveryLatencyMs: deliveryLatencyMs,
          mainOnMessageHandlerMs: 0,
          mainPromiseContinuationMs: 0,
          mainOnMessageStartMs: onMessageStartMs,
          mainOnMessageEndMs: onMessageStartMs,
          transferableBufferCount: wt.transferableBufferCount,
          transferableBytes: wt.transferableBytes,
          workerBvhBatchCount: wt.workerBvhBatchCount,
          workerBvhInstanceCount: wt.workerBvhInstanceCount,
        };
        job.resolve({
          decoded: response.decoded,
          decodeDurationMs: response.decodeDurationMs,
          usedWebWorker: true,
          workerTimings: deliveredTimings,
          clientQueueWaitMs: Number(job.clientQueueWaitMs.toFixed(3)),
          completedAfterAbort: wasAborted,
        });
      } else {
        const errResp = response as TileDecodeWorkerErrorResponse;
        job.reject(new Error(`TileDecodeWorker failed for ${job.tileKey}: ${errResp.error}`));
      }

      pumpQueue();

      const onMessageEndMs = performance.now();
      const handlerDurationMs = Math.max(0, onMessageEndMs - onMessageStartMs);
      if (deliveredTimings) {
        deliveredTimings.mainOnMessageHandlerMs = Number(
          handlerDurationMs.toFixed(3)
        );
        deliveredTimings.mainOnMessageEndMs = onMessageEndMs;
        options.onWorkerMessageDelivered?.({
          tileKey: job.tileKey,
          onMessageStartMs,
          onMessageEndMs,
          handlerDurationMs,
          timings: deliveredTimings,
        });
      }
    };

    const failActiveJobsOnWorker = (reasonPrefix: string, detail?: string): void => {
      for (const [reqId, active] of activeJobsByRequestId.entries()) {
        if (active.worker === worker) {
          activeJobsByRequestId.delete(reqId);
          busyWorkers.delete(worker);
          clearJobListeners(active.job);
          active.job.reject(
            new Error(
              detail
                ? `${reasonPrefix} for ${active.job.tileKey}: ${detail}`
                : `${reasonPrefix} for ${active.job.tileKey}`
            )
          );
        }
      }
      pumpQueue();
    };

    worker.onerror = (event: ErrorEvent) => {
      failActiveJobsOnWorker('TileDecodeWorker error', event.message);
    };

    worker.onmessageerror = () => {
      failActiveJobsOnWorker('TileDecodeWorker message deserialization error');
    };

    return worker;
  };

  const replaceHungWorker = (stuckWorker: Worker): void => {
    busyWorkers.delete(stuckWorker);
    try {
      stuckWorker.terminate();
    } catch {
      // ignore
    }
    const idx = workers.indexOf(stuckWorker);
    if (disposed) {
      if (idx !== -1) workers.splice(idx, 1);
      return;
    }
    try {
      const replacement = spawnWorkerInstance();
      if (idx !== -1) {
        workers[idx] = replacement;
      } else {
        workers.push(replacement);
      }
    } catch {
      if (idx !== -1) workers.splice(idx, 1);
    }
  };

  const pumpQueue = (): void => {
    if (disposed || workers.length === 0) return;

    while (queuedJobs.length > 0 && busyWorkers.size < maxConcurrentWorkers) {
      const idleWorker = workers.find((w) => !busyWorkers.has(w));
      if (!idleWorker) break;

      const job = popNextEligibleJob();
      if (!job) break;
      if (job.signal?.aborted) {
        clearJobListeners(job);
        totalJobsAbortedInQueue += 1;
        job.reject(createAbortError(job.tileKey));
        continue;
      }

      const nowMs = performance.now();
      job.dispatchedAtMs = nowMs;
      job.clientQueueWaitMs = Math.max(0, nowMs - job.enqueuedAtMs);
      totalClientQueueWaitMs += job.clientQueueWaitMs;
      busyWorkers.add(idleWorker);
      activeJobsByRequestId.set(job.requestId, { job, worker: idleWorker });

      job.timeoutTimer = setTimeout(() => {
        const active = activeJobsByRequestId.get(job.requestId);
        if (!active) return;
        activeJobsByRequestId.delete(job.requestId);
        clearJobListeners(active.job);
        wastedWorkerTimeMs += workerJobTimeoutMs;
        replaceHungWorker(active.worker);
        active.job.reject(
          new Error(
            `TileDecodeWorker timed out after ${workerJobTimeoutMs}ms decoding ${active.job.tileKey}`
          )
        );
        pumpQueue();
      }, workerJobTimeoutMs);

      const message: TileDecodeWorkerRequest = {
        requestId: job.requestId,
        tileKey: job.tileKey,
        buffer: job.buffer,
        options: { ...currentPrepOptions },
        mainPostMessageEpochMs: nowEpochMs(),
      };
      try {
        idleWorker.postMessage(message, [job.buffer]);
      } catch (err) {
        clearJobListeners(job);
        busyWorkers.delete(idleWorker);
        activeJobsByRequestId.delete(job.requestId);
        job.reject(
          err instanceof Error ? err : new Error(String(err))
        );
      }
    }
  };

  if (canUseBrowserWorker) {
    try {
      for (let i = 0; i < poolSize; i++) {
        workers.push(spawnWorkerInstance());
      }
    } catch {
      // Fallback to inline decode if Worker construction fails in test/SSR environment
      for (const w of workers) {
        try {
          w.terminate();
        } catch {
          // ignore
        }
      }
      workers.length = 0;
    }
  }

  const decodeInline = async (
    buffer: ArrayBuffer,
    tileKey: string,
    signal?: AbortSignal,
    jobOptions?: TileDecodeJobOptions
  ): Promise<TileDecodeResult> => {
    if (signal?.aborted) {
      totalJobsAbortedInQueue += 1;
      throw createAbortError(tileKey);
    }
    await Promise.resolve();
    if (signal?.aborted && !jobOptions?.retainIfRunningOnAbort) {
      totalJobsAbortedWhileRunning += 1;
      throw createAbortError(tileKey);
    }
    const t0 = performance.now();
    const tInflate0 = performance.now();
    const rawBytes = await ensureRawOmsTileBytes(buffer);
    const inflateMs = performance.now() - tInflate0;
    const prep = prepareTileInWorker(rawBytes, tileKey, currentPrepOptions, false);
    const endMs = performance.now();
    const decodeDurationMs = endMs - t0;
    totalWorkerActiveTimeMs += decodeDurationMs;

    const wasAborted = Boolean(signal?.aborted);
    if (wasAborted && !jobOptions?.retainIfRunningOnAbort) {
      totalJobsAbortedWhileRunning += 1;
      wastedWorkerTimeMs += decodeDurationMs;
      throw createAbortError(tileKey);
    }
    if (wasAborted) {
      totalJobsRetainedAfterAbort += 1;
    }
    totalJobsCompleted += 1;

    const timings: WorkerDecodeStageTimings = {
      usedWebWorker: false,
      usedCompactTransport: prep.options.compactMetadataTransport,
      transferAllTypedArrays: prep.options.transferAllTypedArrays,
      workerInstanceBvhEnabled: prep.options.workerInstanceBvh,
      workerQueueWaitMs: 0,
      workerInflateMs: Number(inflateMs.toFixed(3)),
      workerDecodeOnlyMs: Number(prep.decodeOnlyMs.toFixed(3)),
      workerInflateAndDecodeMs: Number((inflateMs + prep.decodeOnlyMs).toFixed(3)),
      workerBvhBuildMs: Number(prep.workerBvhBuildMs.toFixed(3)),
      workerPayloadPrepMs: Number(prep.workerPayloadPrepMs.toFixed(3)),
      workerPostMessageCallMs: 0,
      workerTotalMs: Number(decodeDurationMs.toFixed(3)),
      messageDeliveryLatencyMs: 0,
      mainOnMessageHandlerMs: Number(decodeDurationMs.toFixed(3)),
      mainPromiseContinuationMs: 0,
      mainOnMessageStartMs: t0,
      mainOnMessageEndMs: endMs,
      transferableBufferCount: prep.transferables.length,
      transferableBytes: prep.transferableBytes,
      workerBvhBatchCount: prep.workerBvhBatchCount,
      workerBvhInstanceCount: prep.workerBvhInstanceCount,
    };
    options.onWorkerMessageDelivered?.({
      tileKey,
      onMessageStartMs: t0,
      onMessageEndMs: endMs,
      handlerDurationMs: decodeDurationMs,
      timings,
    });
    return {
      decoded: prep.decoded,
      decodeDurationMs,
      usedWebWorker: false,
      workerTimings: timings,
      clientQueueWaitMs: 0,
      completedAfterAbort: wasAborted,
    };
  };

  const decodeTile = (
    buffer: ArrayBuffer,
    tileKey: string,
    signal?: AbortSignal,
    priority = 0,
    jobOptions?: TileDecodeJobOptions
  ): Promise<TileDecodeResult> => {
    if (disposed) {
      return Promise.reject(new Error('TileDecodeClient has been disposed.'));
    }
    if (signal?.aborted) {
      totalJobsAbortedInQueue += 1;
      return Promise.reject(createAbortError(tileKey));
    }
    if (workers.length === 0) {
      return decodeInline(buffer, tileKey, signal, jobOptions);
    }

    return new Promise<TileDecodeResult>((resolve, reject) => {
      const requestId = nextRequestId++;
      const nowMs = performance.now();
      const job: PendingJob = {
        requestId,
        tileKey,
        buffer,
        priority: Number.isFinite(priority) ? priority : 0,
        isDestination: Boolean(jobOptions?.isDestination),
        retainIfRunningOnAbort: Boolean(jobOptions?.retainIfRunningOnAbort),
        enqueuedAtMs: nowMs,
        dispatchedAtMs: nowMs,
        clientQueueWaitMs: 0,
        signal,
        resolve,
        reject,
      };

      if (signal) {
        const onAbort = () => {
          const queueIdx = queuedJobs.indexOf(job);
          if (queueIdx !== -1) {
            queuedJobs.splice(queueIdx, 1);
            signal.removeEventListener('abort', onAbort);
            totalJobsAbortedInQueue += 1;
            reject(createAbortError(tileKey));
          }
        };
        job.abortHandler = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      queuedJobs.push(job);
      pumpQueue();
    });
  };

  const updateJobPriority = (
    tileKey: string,
    newPriority: number,
    isDestination?: boolean
  ): boolean => {
    let updated = false;
    for (let i = 0; i < queuedJobs.length; i++) {
      const job = queuedJobs[i];
      if (job.tileKey === tileKey) {
        if (Number.isFinite(newPriority)) {
          job.priority = newPriority;
        }
        if (typeof isDestination === 'boolean') {
          job.isDestination = isDestination;
        }
        updated = true;
      }
    }
    for (const [, active] of activeJobsByRequestId.entries()) {
      if (active.job.tileKey === tileKey) {
        if (Number.isFinite(newPriority)) {
          active.job.priority = newPriority;
        }
        if (typeof isDestination === 'boolean') {
          active.job.isDestination = isDestination;
        }
      }
    }
    return updated;
  };

  return {
    decodeTile,
    updateJobPriority,
    getPreparationOptions: () => ({ ...currentPrepOptions }),
    setPreparationOptions: (
      next: TilePreparationVariantId | Partial<TilePreparationOptions>
    ) => {
      currentPrepOptions = resolveTilePreparationOptions(next);
      return { ...currentPrepOptions };
    },
    getActiveWorkerCount: () =>
      workers.length > 0 ? maxConcurrentWorkers : 0,
    getBusyWorkerCount: () => busyWorkers.size,
    getQueuedDecodeCount: () => queuedJobs.length,
    getPendingDecodeCount: () =>
      queuedJobs.length + activeJobsByRequestId.size,
    setMaxWorkerConcurrency: (
      maxWorkers: number,
      reservedDestSlots?: number
    ) => {
      if (Number.isFinite(maxWorkers) && maxWorkers >= 1) {
        maxConcurrentWorkers = Math.max(
          1,
          Math.min(
            workers.length > 0 ? workers.length : poolSize,
            Math.floor(maxWorkers)
          )
        );
      }
      if (
        typeof reservedDestSlots === 'number' &&
        Number.isFinite(reservedDestSlots)
      ) {
        reservedDestinationSlots = Math.max(
          0,
          Math.min(maxConcurrentWorkers - 1, Math.floor(reservedDestSlots))
        );
      } else {
        reservedDestinationSlots = Math.min(
          reservedDestinationSlots,
          Math.max(0, maxConcurrentWorkers - 1)
        );
      }
      pumpQueue();
    },
    getWorkerUtilizationSnapshot: (): TileDecodeWorkerUtilizationSnapshot => {
      let queuedDest = 0;
      for (let i = 0; i < queuedJobs.length; i++) {
        if (queuedJobs[i].isDestination) queuedDest += 1;
      }
      const effMax = workers.length > 0 ? maxConcurrentWorkers : 1;
      return {
        configuredWorkerPoolSize: workers.length,
        maxConcurrentWorkers: effMax,
        busyWorkerCount: busyWorkers.size,
        idleWorkerCount: Math.max(0, effMax - busyWorkers.size),
        queuedDecodeCount: queuedJobs.length,
        queuedDestinationDecodeCount: queuedDest,
        activeDestinationWorkerCount: countActiveDestinationWorkers(),
        totalJobsCompleted,
        totalJobsAbortedInQueue,
        totalJobsAbortedWhileRunning,
        totalJobsRetainedAfterAbort,
        totalWorkerActiveTimeMs: Number(totalWorkerActiveTimeMs.toFixed(3)),
        totalClientQueueWaitMs: Number(totalClientQueueWaitMs.toFixed(3)),
        wastedWorkerTimeMs: Number(wastedWorkerTimeMs.toFixed(3)),
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      while (queuedJobs.length > 0) {
        const job = queuedJobs.shift()!;
        clearJobListeners(job);
        job.reject(new Error('TileDecodeClient disposed'));
      }
      for (const [, active] of activeJobsByRequestId.entries()) {
        clearJobListeners(active.job);
        active.job.reject(new Error('TileDecodeClient disposed'));
      }
      activeJobsByRequestId.clear();
      busyWorkers.clear();
      for (const worker of workers) {
        try {
          worker.terminate();
        } catch {
          // ignore
        }
      }
      workers.length = 0;
    },
  };
}

