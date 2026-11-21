import {
  decodeTileBinary,
  type DecodedTilePayload,
} from './TileBinaryCodec';
import type {
  TileDecodeWorkerRequest,
  TileDecodeWorkerResponse,
} from './TileDecodeWorker';

export interface TileDecodeResult {
  decoded: DecodedTilePayload;
  decodeDurationMs: number;
  usedWebWorker: boolean;
}

export interface TileDecodeClient {
  decodeTile(
    buffer: ArrayBuffer,
    tileKey: string,
    signal?: AbortSignal
  ): Promise<TileDecodeResult>;
  getActiveWorkerCount(): number;
  getPendingDecodeCount(): number;
  dispose(): void;
}

export interface TileDecodeClientOptions {
  /** Number of Web Workers in the decode pool (default: 2 in browser). */
  workerCount?: number;
  /** Force inline async decode (useful for deterministic unit tests). */
  forceInlineDecode?: boolean;
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
 * off the main thread, with `AbortSignal` cancellation for queued jobs and automatic
 * fallback when running in Node.js test environments without browser `Worker`.
 */
export function createTileDecodeClient(
  options: TileDecodeClientOptions = {}
): TileDecodeClient {
  const desiredWorkers = Math.max(1, options.workerCount ?? 2);
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
          const response = event.data;
          const active = activeJobsByRequestId.get(response.requestId);
          if (!active) return;

          activeJobsByRequestId.delete(response.requestId);
          busyWorkers.delete(active.worker);

          const { job } = active;
          if (job.abortHandler && job.signal) {
            job.signal.removeEventListener('abort', job.abortHandler);
          }

          if (job.signal?.aborted) {
            job.reject(createAbortError(job.tileKey));
          } else if (response.ok) {
            job.resolve({
              decoded: response.decoded,
              decodeDurationMs: response.decodeDurationMs,
              usedWebWorker: true,
            });
          } else {
            job.reject(new Error(response.error));
          }

          pumpQueue();
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
                  event.message || `TileDecodeWorker error for ${active.job.tileKey}`
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
    const decoded = decodeTileBinary(new Uint8Array(buffer), tileKey);
    const decodeDurationMs = performance.now() - t0;
    return {
      decoded,
      decodeDurationMs,
      usedWebWorker: false,
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
