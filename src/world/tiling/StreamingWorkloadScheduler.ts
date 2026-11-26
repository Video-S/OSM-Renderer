/**
 * Shared Time-Aware Streaming Workload Scheduler (TKT-041-F1)
 *
 * Coordinates deferrable main-thread streaming work within a configurable per-frame
 * time budget so tile reconstruction, offscreen GPU upload preparation, resolution
 * activation, and deferred resource disposal do not accumulate into single-frame spikes.
 *
 * Priority hierarchy (lower rank = higher priority):
 *   1. `missing_active_visible`      — Active viewport tiles with missing visible coverage
 *   2. `urgent_memory_disposal`      — Reclaiming memory when over budget / pending disposal cap
 *   3. `pending_destination_visible` — Reconstructing visible destination tiles for a transition
 *   4. `gpu_prep_destination`        — Incremental GPU upload of prepared destination tiles
 *   5. `resolution_activation`       — Atomic resolution swap once all destination tiles are ready
 *   6. `deferred_disposal`           — Normal-pressure background disposal of detached tiles
 *   7. `active_preload`              — Non-visible preload tiles for active resolution
 *   8. `speculative_destination`     — Non-visible preload tiles for pending destination resolution
 *
 * Starvation prevention:
 *   Always permits at least one highest-priority work unit per frame even when that
 *   single indivisible unit exceeds the configured frame budget, while explicitly
 *   recording the overrun in scheduler diagnostics.
 */

export type StreamingWorkPriority =
  | 'missing_active_visible'
  | 'urgent_memory_disposal'
  | 'pending_destination_visible'
  | 'gpu_prep_destination'
  | 'resolution_activation'
  | 'deferred_disposal'
  | 'active_preload'
  | 'speculative_destination';

export const STREAMING_WORK_PRIORITY_RANK: Readonly<
  Record<StreamingWorkPriority, number>
> = {
  missing_active_visible: 0,
  urgent_memory_disposal: 1,
  pending_destination_visible: 2,
  gpu_prep_destination: 3,
  resolution_activation: 4,
  deferred_disposal: 5,
  active_preload: 6,
  speculative_destination: 7,
};

export interface ScheduledWorkUnit {
  id: string;
  priority: StreamingWorkPriority;
  /** Secondary tie-breaker within the same priority tier (smaller executes first). */
  tieBreaker: number;
  /** Optional cancellation check evaluated right before execution. */
  isObsolete?: () => boolean;
  /** Execute one bounded unit of work; returns true if meaningful work was executed. */
  execute: (remainingBudgetMs: number) => boolean;
}

export interface FrameScheduleRunSummary {
  budgetMs: number;
  usedMs: number;
  overrunMs: number;
  unitsExecuted: number;
  unitsCancelled: number;
  unitsDeferred: number;
  indivisibleOverrunCount: number;
  maxIndivisibleUnitMs: number;
  executedByPriority: Partial<Record<StreamingWorkPriority, number>>;
}

export interface StreamingSchedulerCumulativeStats {
  framesScheduled: number;
  totalUnitsExecuted: number;
  totalUnitsCancelled: number;
  totalUnitsDeferred: number;
  totalIndivisibleOverruns: number;
  maxIndivisibleUnitMs: number;
  totalBudgetOverrunMs: number;
  lastFrameSummary: FrameScheduleRunSummary | null;
}

export class StreamingWorkloadScheduler {
  private readonly nowFn: () => number;
  private framesScheduled = 0;
  private totalUnitsExecuted = 0;
  private totalUnitsCancelled = 0;
  private totalUnitsDeferred = 0;
  private totalIndivisibleOverruns = 0;
  private maxIndivisibleUnitMs = 0;
  private totalBudgetOverrunMs = 0;
  private lastFrameSummary: FrameScheduleRunSummary | null = null;

  constructor(nowFn: () => number = () => performance.now()) {
    this.nowFn = nowFn;
  }

  /**
   * Executes prioritized work units for a single frame within `budgetMs`.
   *
   * - Filters out obsolete units immediately (counting them as cancelled).
   * - Sorts strictly by `STREAMING_WORK_PRIORITY_RANK`, then `tieBreaker`.
   * - Starvation prevention: when `budgetMs` is finite and `allowStarvationEscape`
   *   is true (default), at least one non-obsolete unit is always executed even if
   *   its indivisible runtime exceeds `budgetMs`.
   * - Explicitly accounts for indivisible overruns without hiding them.
   */
  runFrame(
    units: ScheduledWorkUnit[],
    budgetMs: number,
    options?: {
      /** Starting elapsed time already consumed in this frame's streaming slice. */
      alreadyUsedMs?: number;
      /** Ensure at least 1 unit executes per frame to prevent starvation (default: true). */
      allowStarvationEscape?: boolean;
      /** Optional hard cap on total units executed this frame. */
      maxUnits?: number;
    }
  ): FrameScheduleRunSummary {
    const tStart = this.nowFn();
    const effectiveBudgetMs =
      Number.isFinite(budgetMs) && budgetMs > 0
        ? budgetMs
        : Number.POSITIVE_INFINITY;
    const baseUsedMs = Math.max(0, options?.alreadyUsedMs ?? 0);
    const allowStarvationEscape = options?.allowStarvationEscape !== false;
    const maxUnits =
      typeof options?.maxUnits === 'number' && options.maxUnits > 0
        ? Math.floor(options.maxUnits)
        : Number.MAX_SAFE_INTEGER;

    // Sort deterministically by priority tier then tie-breaker
    const ordered = [...units].sort((a, b) => {
      const rankDiff =
        STREAMING_WORK_PRIORITY_RANK[a.priority] -
        STREAMING_WORK_PRIORITY_RANK[b.priority];
      if (rankDiff !== 0) return rankDiff;
      return a.tieBreaker - b.tieBreaker;
    });

    let unitsExecuted = 0;
    let unitsCancelled = 0;
    let unitsDeferred = 0;
    let indivisibleOverrunCount = 0;
    let maxIndivisibleUnitMs = 0;
    const executedByPriority: Partial<Record<StreamingWorkPriority, number>> = {};

    for (let i = 0; i < ordered.length; i++) {
      const unit = ordered[i];
      if (unit.isObsolete && unit.isObsolete()) {
        unitsCancelled += 1;
        continue;
      }

      if (unitsExecuted >= maxUnits) {
        unitsDeferred += 1;
        continue;
      }

      const elapsedSoFar = baseUsedMs + (this.nowFn() - tStart);
      const remainingMs = effectiveBudgetMs - elapsedSoFar;

      if (remainingMs <= 0) {
        if (unitsExecuted > 0 || !allowStarvationEscape) {
          unitsDeferred += 1;
          continue;
        }
      }

      const u0 = this.nowFn();
      const didWork = unit.execute(Math.max(0, remainingMs));
      const unitDurationMs = Math.max(0, this.nowFn() - u0);

      if (didWork) {
        unitsExecuted += 1;
        executedByPriority[unit.priority] =
          (executedByPriority[unit.priority] ?? 0) + 1;

        if (
          Number.isFinite(effectiveBudgetMs) &&
          unitDurationMs > effectiveBudgetMs
        ) {
          indivisibleOverrunCount += 1;
          if (unitDurationMs > maxIndivisibleUnitMs) {
            maxIndivisibleUnitMs = unitDurationMs;
          }
        }
      }
    }

    const usedMs = Math.max(0, baseUsedMs + (this.nowFn() - tStart));
    const overrunMs = Number.isFinite(effectiveBudgetMs)
      ? Math.max(0, usedMs - effectiveBudgetMs)
      : 0;

    const summary: FrameScheduleRunSummary = {
      budgetMs: Number.isFinite(effectiveBudgetMs)
        ? Number(effectiveBudgetMs.toFixed(3))
        : 0,
      usedMs: Number(usedMs.toFixed(3)),
      overrunMs: Number(overrunMs.toFixed(3)),
      unitsExecuted,
      unitsCancelled,
      unitsDeferred,
      indivisibleOverrunCount,
      maxIndivisibleUnitMs: Number(maxIndivisibleUnitMs.toFixed(3)),
      executedByPriority,
    };

    this.framesScheduled += 1;
    this.totalUnitsExecuted += unitsExecuted;
    this.totalUnitsCancelled += unitsCancelled;
    this.totalUnitsDeferred += unitsDeferred;
    this.totalIndivisibleOverruns += indivisibleOverrunCount;
    if (maxIndivisibleUnitMs > this.maxIndivisibleUnitMs) {
      this.maxIndivisibleUnitMs = maxIndivisibleUnitMs;
    }
    this.totalBudgetOverrunMs += overrunMs;
    this.lastFrameSummary = summary;

    return summary;
  }

  getStats(): StreamingSchedulerCumulativeStats {
    return {
      framesScheduled: this.framesScheduled,
      totalUnitsExecuted: this.totalUnitsExecuted,
      totalUnitsCancelled: this.totalUnitsCancelled,
      totalUnitsDeferred: this.totalUnitsDeferred,
      totalIndivisibleOverruns: this.totalIndivisibleOverruns,
      maxIndivisibleUnitMs: Number(this.maxIndivisibleUnitMs.toFixed(3)),
      totalBudgetOverrunMs: Number(this.totalBudgetOverrunMs.toFixed(3)),
      lastFrameSummary: this.lastFrameSummary,
    };
  }

  resetStats(): void {
    this.framesScheduled = 0;
    this.totalUnitsExecuted = 0;
    this.totalUnitsCancelled = 0;
    this.totalUnitsDeferred = 0;
    this.totalIndivisibleOverruns = 0;
    this.maxIndivisibleUnitMs = 0;
    this.totalBudgetOverrunMs = 0;
    this.lastFrameSummary = null;
  }
}
