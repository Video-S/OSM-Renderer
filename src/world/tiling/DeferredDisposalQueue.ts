/**
 * Bounded Deferred Resource Disposal Queue (TKT-041-F1)
 *
 * Immediately detached tiles (removed from composite scene & picking roots) are enqueued
 * here so their CPU/GPU `.dispose()` calls can be distributed across subsequent frames
 * inside the shared per-frame streaming budget instead of causing eviction/transition spikes.
 *
 * Safety & ownership invariants:
 *   1. Only fully detached tile scenes whose owning record has already transitioned to
 *      `unloaded` (never `loaded`, `prepared_inactive`, or `cached_inactive`) may be enqueued.
 *   2. Duplicate enqueue of the same `ReconstructedTileSceneResult` instance is prevented.
 *   3. Shared materials (`ThemeMaterialRegistry`) and shared foliage prototypes
 *      (`FoliagePrototypeRegistry`) are NOT owned by `ReconstructedTileSceneResult.dispose()`,
 *      so deferred tile disposal never invalidates shared GPU resources.
 *   4. Pending-disposal memory bytes and tile counts are explicitly tracked and included in
 *      `HierarchicalResourceAccountingSnapshot.totalMeasuredBytes`.
 *   5. Under memory pressure (when total memory or pending-disposal bytes exceed limits),
 *      disposal accelerates automatically to reclaim resources promptly.
 */

import type { ReconstructedTileSceneResult } from './TileSceneReconstructor';

export interface DeferredDisposalEntry {
  tileKey: string;
  resolutionMeters: number;
  lod: number;
  reconstructed: ReconstructedTileSceneResult;
  measuredBytes: number;
  estimatedGpuBytes: number;
  geometryCount: number;
  enqueuedAtMs: number;
  isCacheEviction: boolean;
}

export interface DeferredDisposalStepResult {
  disposedTiles: number;
  disposedBytes: number;
  disposedGeometries: number;
  durationMs: number;
  disposedEntries: Array<{
    tileKey: string;
    resolutionMeters: number;
    lod: number;
    measuredBytes: number;
    isCacheEviction: boolean;
    durationMs: number;
  }>;
}

export interface DeferredDisposalAccountingSnapshot {
  pendingTiles: number;
  pendingBytes: number;
  pendingEstimatedGpuBytes: number;
  pendingGeometries: number;
  peakPendingTiles: number;
  peakPendingBytes: number;
  totalEnqueuedTiles: number;
  totalDisposedTiles: number;
  totalDisposedBytes: number;
  totalDisposeMs: number;
  acceleratedFlushCount: number;
  byResolution: Record<number, { tiles: number; bytes: number; estimatedGpuBytes: number }>;
}

export class DeferredDisposalQueue {
  private readonly queue: DeferredDisposalEntry[] = [];
  private readonly enqueuedSet = new WeakSet<ReconstructedTileSceneResult>();
  private readonly nowFn: () => number;

  private pendingBytes = 0;
  private pendingEstimatedGpuBytes = 0;
  private pendingGeometries = 0;
  private peakPendingTiles = 0;
  private peakPendingBytes = 0;
  private totalEnqueuedTiles = 0;
  private totalDisposedTiles = 0;
  private totalDisposedBytes = 0;
  private totalDisposeMs = 0;
  private acceleratedFlushCount = 0;

  constructor(nowFn: () => number = () => performance.now()) {
    this.nowFn = nowFn;
  }

  get size(): number {
    return this.queue.length;
  }

  get totalPendingBytes(): number {
    return this.pendingBytes;
  }

  get totalPendingEstimatedGpuBytes(): number {
    return this.pendingEstimatedGpuBytes;
  }

  get totalPendingGeometries(): number {
    return this.pendingGeometries;
  }

  /**
   * Checks whether a reconstructed tile scene instance is currently queued for disposal.
   */
  isPending(reconstructed: ReconstructedTileSceneResult): boolean {
    return this.enqueuedSet.has(reconstructed);
  }

  /**
   * Enqueues a detached tile scene for deferred disposal.
   * Caller MUST have already detached `reconstructed.scene` from the composite scene graph
   * and cleared the owning record's reference so no active/cached tile points to it.
   */
  enqueue(entry: Omit<DeferredDisposalEntry, 'enqueuedAtMs' | 'geometryCount'>): boolean {
    if (this.enqueuedSet.has(entry.reconstructed)) {
      return false;
    }
    const geometryCount = entry.reconstructed.scene.resources.ownedGeometriesCount;
    const fullEntry: DeferredDisposalEntry = {
      ...entry,
      geometryCount,
      enqueuedAtMs: this.nowFn(),
    };
    this.queue.push(fullEntry);
    this.enqueuedSet.add(entry.reconstructed);
    this.pendingBytes += entry.measuredBytes;
    this.pendingEstimatedGpuBytes += entry.estimatedGpuBytes;
    this.pendingGeometries += geometryCount;
    this.totalEnqueuedTiles += 1;

    if (this.queue.length > this.peakPendingTiles) {
      this.peakPendingTiles = this.queue.length;
    }
    if (this.pendingBytes > this.peakPendingBytes) {
      this.peakPendingBytes = this.pendingBytes;
    }
    return true;
  }

  /**
   * Disposes up to `maxTiles` queued tiles within `maxTimeMs`.
   * Always disposes at least 1 tile when the queue is non-empty (starvation prevention).
   */
  drainSlice(limits: {
    maxTiles: number;
    maxTimeMs: number;
    accelerated?: boolean;
  }): DeferredDisposalStepResult {
    if (this.queue.length === 0) {
      return {
        disposedTiles: 0,
        disposedBytes: 0,
        disposedGeometries: 0,
        durationMs: 0,
        disposedEntries: [],
      };
    }

    if (limits.accelerated) {
      this.acceleratedFlushCount += 1;
    }

    const maxTiles = Math.max(1, Math.floor(limits.maxTiles));
    const maxTimeMs =
      Number.isFinite(limits.maxTimeMs) && limits.maxTimeMs > 0
        ? limits.maxTimeMs
        : Number.POSITIVE_INFINITY;

    const t0 = this.nowFn();
    let disposedTiles = 0;
    let disposedBytes = 0;
    let disposedGeometries = 0;
    const disposedEntries: DeferredDisposalStepResult['disposedEntries'] = [];

    while (this.queue.length > 0 && disposedTiles < maxTiles) {
      if (disposedTiles > 0 && this.nowFn() - t0 >= maxTimeMs) {
        break;
      }
      const item = this.queue.shift()!;
      const u0 = this.nowFn();
      item.reconstructed.dispose();
      const itemDurationMs = Math.max(0, this.nowFn() - u0);

      this.pendingBytes = Math.max(0, this.pendingBytes - item.measuredBytes);
      this.pendingEstimatedGpuBytes = Math.max(
        0,
        this.pendingEstimatedGpuBytes - item.estimatedGpuBytes
      );
      this.pendingGeometries = Math.max(
        0,
        this.pendingGeometries - item.geometryCount
      );

      disposedTiles += 1;
      disposedBytes += item.measuredBytes;
      disposedGeometries += item.geometryCount;
      this.totalDisposedTiles += 1;
      this.totalDisposedBytes += item.measuredBytes;
      this.totalDisposeMs += itemDurationMs;

      disposedEntries.push({
        tileKey: item.tileKey,
        resolutionMeters: item.resolutionMeters,
        lod: item.lod,
        measuredBytes: item.measuredBytes,
        isCacheEviction: item.isCacheEviction,
        durationMs: Number(itemDurationMs.toFixed(3)),
      });
    }

    const durationMs = Math.max(0, this.nowFn() - t0);
    return {
      disposedTiles,
      disposedBytes,
      disposedGeometries,
      durationMs: Number(durationMs.toFixed(3)),
      disposedEntries,
    };
  }

  /**
   * Immediately disposes enough oldest tiles to bring `pendingBytes <= targetMaxPendingBytes`.
   */
  drainToTargetBytes(targetMaxPendingBytes: number): DeferredDisposalStepResult {
    const cap = Math.max(0, targetMaxPendingBytes);
    if (this.pendingBytes <= cap || this.queue.length === 0) {
      return {
        disposedTiles: 0,
        disposedBytes: 0,
        disposedGeometries: 0,
        durationMs: 0,
        disposedEntries: [],
      };
    }

    this.acceleratedFlushCount += 1;
    const t0 = this.nowFn();
    let disposedTiles = 0;
    let disposedBytes = 0;
    let disposedGeometries = 0;
    const disposedEntries: DeferredDisposalStepResult['disposedEntries'] = [];

    while (this.queue.length > 0 && this.pendingBytes > cap) {
      const item = this.queue.shift()!;
      const u0 = this.nowFn();
      item.reconstructed.dispose();
      const itemDurationMs = Math.max(0, this.nowFn() - u0);

      this.pendingBytes = Math.max(0, this.pendingBytes - item.measuredBytes);
      this.pendingEstimatedGpuBytes = Math.max(
        0,
        this.pendingEstimatedGpuBytes - item.estimatedGpuBytes
      );
      this.pendingGeometries = Math.max(
        0,
        this.pendingGeometries - item.geometryCount
      );

      disposedTiles += 1;
      disposedBytes += item.measuredBytes;
      disposedGeometries += item.geometryCount;
      this.totalDisposedTiles += 1;
      this.totalDisposedBytes += item.measuredBytes;
      this.totalDisposeMs += itemDurationMs;

      disposedEntries.push({
        tileKey: item.tileKey,
        resolutionMeters: item.resolutionMeters,
        lod: item.lod,
        measuredBytes: item.measuredBytes,
        isCacheEviction: item.isCacheEviction,
        durationMs: Number(itemDurationMs.toFixed(3)),
      });
    }

    return {
      disposedTiles,
      disposedBytes,
      disposedGeometries,
      durationMs: Number(Math.max(0, this.nowFn() - t0).toFixed(3)),
      disposedEntries,
    };
  }

  /**
   * Flushes and disposes every pending entry synchronously (used on manager shutdown/dispose).
   */
  flushAll(): DeferredDisposalStepResult {
    return this.drainToTargetBytes(0);
  }

  getAccountingSnapshot(): DeferredDisposalAccountingSnapshot {
    const byResolution: Record<
      number,
      { tiles: number; bytes: number; estimatedGpuBytes: number }
    > = {};
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      const bucket =
        byResolution[item.resolutionMeters] ??
        (byResolution[item.resolutionMeters] = {
          tiles: 0,
          bytes: 0,
          estimatedGpuBytes: 0,
        });
      bucket.tiles += 1;
      bucket.bytes += item.measuredBytes;
      bucket.estimatedGpuBytes += item.estimatedGpuBytes;
    }

    return {
      pendingTiles: this.queue.length,
      pendingBytes: this.pendingBytes,
      pendingEstimatedGpuBytes: this.pendingEstimatedGpuBytes,
      pendingGeometries: this.pendingGeometries,
      peakPendingTiles: this.peakPendingTiles,
      peakPendingBytes: this.peakPendingBytes,
      totalEnqueuedTiles: this.totalEnqueuedTiles,
      totalDisposedTiles: this.totalDisposedTiles,
      totalDisposedBytes: this.totalDisposedBytes,
      totalDisposeMs: Number(this.totalDisposeMs.toFixed(3)),
      acceleratedFlushCount: this.acceleratedFlushCount,
      byResolution,
    };
  }

  resetStats(): void {
    this.peakPendingTiles = this.queue.length;
    this.peakPendingBytes = this.pendingBytes;
    this.totalEnqueuedTiles = 0;
    this.totalDisposedTiles = 0;
    this.totalDisposedBytes = 0;
    this.totalDisposeMs = 0;
    this.acceleratedFlushCount = 0;
  }
}
