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
    signal?: AbortSignal
  ): Promise<TileDecodeResult>;
  getPreparationOptions(): TilePreparationOptions;
  setPreparationOptions(
    options: TilePreparationVariantId | Partial<TilePreparationOptions>
  ): TilePreparationOptions;
  getActiveWorkerCount(): number;
  getPendingDecodeCount(): number;
  dispose(): void;
}

export interface TileDecodeClientOptions {
  /** Number of Web Workers in the decode pool (default: 2 in browser). */
  workerCount?: number;
  /** Force inline async decode (useful for deterministic unit tests). */
  forceInlineDecode?: boolean;
  /** Initial TKT-040 tile preparation variant or explicit options (default: 'combined'). */
  preparationOptions?: TilePreparationVariantId | Partial<TilePreparationOptions>;
  /** Optional hook fired synchronously at the end of `worker.onmessage` for frame attribution. */
  onWorkerMessageDelivered?: (info: WorkerMessageDeliveredInfo) => void;
}

interface PendingJob {
  requestId: number;
  tileKey: string;
  buffer: ArrayBuffer;
  signal?: AbortSignal;
  abortHandler?: () => void;
  resolve: (result: TileDecodeResult) => void;
  reject: (err: Error) => void;
}

function createAbortError(tileKey: string): Error {
  const err = new Error(`Tile decode aborted for ${tileKey}`);
  err.name = 'AbortError';
  return err;
}

/**
 * Manages a pool of browser Web Workers that decode `OSMTILE1` binary tile payloads
 * off the main thread, with `AbortSignal` cancellation for queued jobs, TKT-040
 * cross-thread timing instrumentation, and automatic fallback when running in Node.js
 * test environments without browser `Worker`.
 */
export function createTileDecodeClient(
  options: TileDecodeClientOptions = {}
): TileDecodeClient {
  const desiredWorkers = Math.max(1, options.workerCount ?? 2);
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

  const canUseBrowserWorker =
    !options.forceInlineDecode &&
    typeof Worker !== 'undefined' &&
    typeof window !== 'undefined';

  const pumpQueue = (): void => {
    if (disposed || workers.length === 0) return;

    while (queuedJobs.length > 0) {
      const idleWorker = workers.find((w) => !busyWorkers.has(w));
      if (!idleWorker) break;

      const job = queuedJobs.shift()!;
      if (job.signal?.aborted) {
        if (job.abortHandler && job.signal) {
          job.signal.removeEventListener('abort', job.abortHandler);
        }
        job.reject(createAbortError(job.tileKey));
        continue;
      }

      busyWorkers.add(idleWorker);
      activeJobsByRequestId.set(job.requestId, { job, worker: idleWorker });

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
        busyWorkers.delete(idleWorker);
        activeJobsByRequestId.delete(job.requestId);
        if (job.abortHandler && job.signal) {
          job.signal.removeEventListener('abort', job.abortHandler);
        }
        job.reject(
          err instanceof Error ? err : new Error(String(err))
        );
      }
    }
  };

  if (canUseBrowserWorker) {
    try {
      for (let i = 0; i < desiredWorkers; i++) {
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
          if (job.abortHandler && job.signal) {
            job.signal.removeEventListener('abort', job.abortHandler);
          }

          let deliveredTimings: WorkerDecodeStageTimings | null = null;
          if (job.signal?.aborted) {
            job.reject(createAbortError(job.tileKey));
          } else if (response.ok) {
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
            });
          } else {
            const errResp = response as TileDecodeWorkerErrorResponse;
            job.reject(new Error(errResp.error));
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

        worker.onerror = (event: ErrorEvent) => {
          // Reject any job currently running on this worker
          for (const [reqId, active] of activeJobsByRequestId.entries()) {
            if (active.worker === worker) {
              activeJobsByRequestId.delete(reqId);
              busyWorkers.delete(worker);
              if (active.job.abortHandler && active.job.signal) {
                active.job.signal.removeEventListener(
                  'abort',
                  active.job.abortHandler
                );
              }
              active.job.reject(
                new Error(
                  event.message ||
                    `TileDecodeWorker error for ${active.job.tileKey}`
                )
              );
            }
          }
          pumpQueue();
        };

        workers.push(worker);
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
    signal?: AbortSignal
  ): Promise<TileDecodeResult> => {
    if (signal?.aborted) {
      throw createAbortError(tileKey);
    }
    await Promise.resolve();
    if (signal?.aborted) {
      throw createAbortError(tileKey);
    }
    const t0 = performance.now();
    const tInflate0 = performance.now();
    const rawBytes = await ensureRawOmsTileBytes(buffer);
    const inflateMs = performance.now() - tInflate0;
    const prep = prepareTileInWorker(rawBytes, tileKey, currentPrepOptions, false);
    const endMs = performance.now();
    const decodeDurationMs = endMs - t0;
    const timings: WorkerDecodeStageTimings = {
      usedWebWorker: false,
      usedCompactTransport: prep.options.compactMetadataTransport,
      transferAllTypedArrays: prep.options.transferAllTypedArrays,
      workerInstanceBvhEnabled: prep.options.workerInstanceBvh,
      workerQueueWaitMs: 0,
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
    };
  };

  const decodeTile = (
    buffer: ArrayBuffer,
    tileKey: string,
    signal?: AbortSignal
  ): Promise<TileDecodeResult> => {
    if (disposed) {
      return Promise.reject(new Error('TileDecodeClient has been disposed.'));
    }
    if (signal?.aborted) {
      return Promise.reject(createAbortError(tileKey));
    }
    if (workers.length === 0) {
      return decodeInline(buffer, tileKey, signal);
    }

    return new Promise<TileDecodeResult>((resolve, reject) => {
      const requestId = nextRequestId++;
      const job: PendingJob = {
        requestId,
        tileKey,
        buffer,
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

  return {
    decodeTile,
    getPreparationOptions: () => ({ ...currentPrepOptions }),
    setPreparationOptions: (
      next: TilePreparationVariantId | Partial<TilePreparationOptions>
    ) => {
      currentPrepOptions = resolveTilePreparationOptions(next);
      return { ...currentPrepOptions };
    },
    getActiveWorkerCount: () => workers.length,
    getPendingDecodeCount: () =>
      queuedJobs.length + activeJobsByRequestId.size,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      while (queuedJobs.length > 0) {
        const job = queuedJobs.shift()!;
        if (job.abortHandler && job.signal) {
          job.signal.removeEventListener('abort', job.abortHandler);
        }
        job.reject(new Error('TileDecodeClient disposed'));
      }
      for (const [, active] of activeJobsByRequestId.entries()) {
        if (active.job.abortHandler && active.job.signal) {
          active.job.signal.removeEventListener(
            'abort',
            active.job.abortHandler
          );
        }
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
