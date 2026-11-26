/**
 * Reproducible Hierarchical Tile Streaming & Frame-Budgeted Benchmark Runner
 * (TKT-041 & TKT-041-F1, including Section 12 Transition Latency Investigation)
 *
 * Evaluates uniform-viewport zoom-dependent tile resolution switching (1,024 m / 2,048 m /
 * 4,096 m) across separable TKT-041-F1 variants, continuous simultaneous panning + zooming
 * (elapsed-time movement without waiting for streaming to settle between camera updates),
 * frame-stage attribution, and independent transition-latency / critical-path instrumentation.
 *
 * Usage (Windows PowerShell / Linux / macOS — invoke directly with `npx tsx`):
 *   npx tsx benchmarks/hierarchicalStreamingRunner.ts --descriptor=data/osm/twente-full-hierarchical.json --variants=all --foliage=both
 *   npx tsx benchmarks/hierarchicalStreamingRunner.ts --descriptor=data/osm/twente-full-hierarchical.json --variants=scheduler_only,combined --budgets=1,2,4 --foliage=on
 *   npx tsx benchmarks/hierarchicalStreamingRunner.ts --descriptor=data/osm/twente-full-hierarchical.json --variants=debounce_reuse_only,combined --debounce-ms=100,150,250 --foliage=on
 *   npx tsx benchmarks/hierarchicalStreamingRunner.ts --descriptor=... --allow-software --quick
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { computeQuantileFromSorted, computeSampleStatistics } from './stats';
import { resolveChromiumLaunchArgs } from './browserRunner';
import { parseChromiumGpuBackend } from './cliAndServer';
import { isSoftwareWebGLRenderer } from './environment';
import type { ChromiumGpuBackend } from './types';
import { createRegionalMosaicHttpHandler } from '../src/server/tiles/RegionalMosaicHttpHandler';
import {
  HIERARCHICAL_MOSAIC_SCHEMA_TYPE,
  HIERARCHICAL_MOSAIC_SCHEMA_VERSION,
  type HierarchicalRegionalMosaicDescriptor,
} from '../src/world/tiling/HierarchicalMosaicContract';
import type { HierarchicalResolutionMode } from '../src/world/tiling/HierarchicalResolutionPolicy';
import { REGIONAL_MIN_ZOOM_QUERY_PARAM } from '../src/scene/cameraZoomPolicy';
import {
  assessObservedRefreshCadence,
  attributeWorstFrames,
  computeStreamingFrameDistribution,
  summarizeEventConditionedFrames,
  summarizeStageTimings,
  verifyFrameStageNesting,
  type EventConditionedFrameSummary,
  type FrameSpikeAttributionRecord,
  type ObservedCadenceAssessment,
  type StageTimingSummaryEntry,
  type StreamingFrameDistribution,
} from '../src/world/tiling/StreamingFluidityStats';
import type { StreamingProfilerSnapshot } from '../src/world/tiling/StreamingProfiler';
import type {
  HierarchicalStreamingDiagnosticsSnapshot,
  HierarchicalTransitionState,
  TransitionBlockerSnapshot,
  TransitionCriticalPathRecord,
} from '../src/world/tiling/TileStreamManager';
import type { RegionalMosaicIndex } from '../src/world/tiling/RegionalMosaicPlan';
import {
  normalizeStreamingFrameBudgetConfig,
  STREAMING_F1_VARIANTS,
  type StreamingF1VariantId,
  type StreamingFrameBudgetConfig,
} from '../src/world/tiling/StreamingSchedulerConfig';
import { DEFAULT_HIERARCHICAL_RESOURCE_BUDGET } from '../src/world/tiling/HierarchicalResourceBudget';

export type HierarchicalFoliageFilter = 'both' | 'on' | 'off';

export const ALL_F1_BENCHMARK_VARIANTS: readonly StreamingF1VariantId[] = [
  'tkt041_baseline',
  'scheduler_only',
  'incremental_gpu_only',
  'deferred_disposal_only',
  'debounce_reuse_only',
  'combined',
  'combined_prewarm',
] as const;

export interface HierarchicalBenchmarkCli {
  descriptorPath: string | null;
  index1024Path: string | null;
  index2048Path: string | null;
  index4096Path: string | null;
  foliage: HierarchicalFoliageFilter;
  variants: StreamingF1VariantId[];
  frameBudgetsMs: number[] | null;
  debounceValuesMs: number[] | null;
  cpuMemoryBudgetMiB: number;
  themeId: string;
  requireHardware: boolean;
  gpuBackend: ChromiumGpuBackend;
  outputPath: string;
  markdownPath: string;
  quick: boolean;
}

export interface VariantRunSpec {
  runId: string;
  variantId: StreamingF1VariantId;
  frameBudgetConfig: StreamingFrameBudgetConfig;
  cpuMemoryBudgetMiB: number;
}

export interface LatencyDistributionSummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface TransitionStageAggregate {
  fetchQueueWaitMs: number;
  payloadRetrievalMs: number;
  workerQueueWaitMs: number;
  workerDecodeAndBvhMs: number;
  mainThreadReconstructWaitMs: number;
  reconstructMs: number;
  gpuPrepWaitMs: number;
  gpuPrepSubmitMs: number;
  gpuPrepTotalMs: number;
  remainingCoverageWaitMs: number;
  tailTileEnteredLateMs: number;
  activationSwapMs: number;
}

export interface TransitionLatencySummary {
  transitionsAttempted: number;
  transitionsCompleted: number;
  transitionsCancelled: number;
  transitionsDeferredBudget: number;
  transitionsUnfinishedAtEnd: number;
  maxPendingDurationMs: number;
  completedLatencyMs: LatencyDistributionSummary;
  completedLatencyByTarget: {
    to1024: LatencyDistributionSummary;
    to2048: LatencyDistributionSummary;
    to4096: LatencyDistributionSummary;
  };
  criticalPathStagesMedianMs: TransitionStageAggregate;
  criticalPathStagesMaxMs: TransitionStageAggregate;
  dominantBlockerCounts: Record<string, number>;
  slowestTransition: TransitionCriticalPathRecord | null;
  liveBlockerAtEnd: TransitionBlockerSnapshot | null;
  recordedTransitions: TransitionCriticalPathRecord[];
}

export interface HierarchicalScenarioF1Counters {
  transitionsDebouncedAvoidedDelta: number;
  destinationPrepReusedDelta: number;
  prewarmTilesPreparedDelta: number;
  prewarmReusedOnTransitionDelta: number;
  gpuUploadedUnitsDelta: number;
  gpuUploadedBytesDelta: number;
  deferredDisposedTilesDelta: number;
  peakPendingDisposalBytes: number;
  schedulerOverrunCountDelta: number;
  boundaryOverlayRebuildMsDelta: number;
  timeWithoutValidCoverageMs: number;
}

export interface HierarchicalScenarioMetrics {
  variantRunId: string;
  variantId: StreamingF1VariantId;
  frameBudgetConfig: StreamingFrameBudgetConfig;
  cpuMemoryBudgetMiB: number;
  foliageEnabled: boolean;
  scenarioId: string;
  description: string;
  continuousMotion: boolean;
  durationMs: number;
  frameDistribution: StreamingFrameDistribution;
  observedCadence: ObservedCadenceAssessment;
  eventConditioned: EventConditionedFrameSummary;
  stageSummaries: StageTimingSummaryEntry[];
  topSpikes: FrameSpikeAttributionRecord[];
  nestingValidation: {
    checkedFrames: number;
    violationCount: number;
  };
  transitionsStartedDelta: number;
  transitionsCompletedDelta: number;
  transitionsCancelledDelta: number;
  transitionsDeferredBudgetDelta: number;
  cacheHitsDelta: number;
  cacheEvictionsDelta: number;
  maxActivationSwapMs: number;
  lastActivationSwapMs: number;
  endActiveResolutionMeters: number;
  endTransitionState: HierarchicalTransitionState;
  maxSimultaneousAttachedResolutions: number;
  singleResolutionInvariantPassed: boolean;
  peakMeasuredCpuBytes: number;
  peakEstimatedGpuBytes: number;
  medianDrawCalls: number;
  medianTriangles: number;
  hysteresisZeroTransitionsPassed?: boolean;
  f1Counters: HierarchicalScenarioF1Counters;
  transitionLatency: TransitionLatencySummary;
}

export interface HierarchicalPickingParityResult {
  variantRunId: string;
  foliageEnabled: boolean;
  resolutions: Array<{
    resolutionMeters: number;
    requestedResolutionMeters: number;
    actualActiveResolutionMeters: number;
    transitionCompleted: boolean;
    budgetDeferralReason: string | null;
    medianPickMs: number;
    p95PickMs: number;
    hitCount: number;
    sampleCount: number;
    hitFeatureIds: Array<string | null>;
  }>;
  comparedPointCount: number;
  parityMatchCount: number;
  parityRatio: number;
  allResolutionsValid: boolean;
}

export interface HierarchicalModeComparisonEntry {
  variantRunId: string;
  foliageEnabled: boolean;
  poseLabel: 'Street' | 'Mid' | 'Regional';
  zoom: number;
  mode: HierarchicalResolutionMode;
  requestedResolutionMeters: number;
  actualActiveResolutionMeters: number;
  /** @deprecated Alias kept for backward compatibility; equals actualActiveResolutionMeters. */
  activeResolutionMeters: number;
  transitionState: HierarchicalTransitionState;
  transitionCompleted: boolean;
  budgetDeferralReason: string | null;
  comparisonValid: boolean;
  invalidReason: string | null;
  frameDistribution: StreamingFrameDistribution;
  medianDrawCalls: number;
  medianTriangles: number;
  measuredCpuMiB: number;
  estimatedGpuMiB: number;
}

export interface HierarchicalStreamingBenchmarkReport {
  schemaVersion: string;
  generatedAtIso: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  themeId: string;
  descriptorPath: string;
  hierarchyName: string;
  availableResolutionsMeters: number[];
  cpuMemoryBudgetMiB: number;
  variantMatrix: VariantRunSpec[];
  gpuVendor: string;
  gpuRenderer: string;
  isSoftwareRenderer: boolean;
  softwareRendererWarning: string | null;
  scenarios: HierarchicalScenarioMetrics[];
  pickingParity: HierarchicalPickingParityResult[];
  modeComparisons: HierarchicalModeComparisonEntry[];
}

function roundNum(value: number, digits = 3): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function computeLatencyDistribution(values: readonly number[]): LatencyDistributionSummary {
  if (values.length === 0) {
    return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: roundNum(computeQuantileFromSorted(sorted, 0.5), 2),
    p95Ms: roundNum(computeQuantileFromSorted(sorted, 0.95), 2),
    maxMs: roundNum(sorted[sorted.length - 1], 2),
  };
}

function emptyStageAggregate(): TransitionStageAggregate {
  return {
    fetchQueueWaitMs: 0,
    payloadRetrievalMs: 0,
    workerQueueWaitMs: 0,
    workerDecodeAndBvhMs: 0,
    mainThreadReconstructWaitMs: 0,
    reconstructMs: 0,
    gpuPrepWaitMs: 0,
    gpuPrepSubmitMs: 0,
    gpuPrepTotalMs: 0,
    remainingCoverageWaitMs: 0,
    tailTileEnteredLateMs: 0,
    activationSwapMs: 0,
  };
}

function aggregateTransitionStages(
  records: readonly TransitionCriticalPathRecord[],
  mode: 'median' | 'max'
): TransitionStageAggregate {
  if (records.length === 0) return emptyStageAggregate();
  const keys = Object.keys(emptyStageAggregate()) as Array<keyof TransitionStageAggregate>;
  const out = emptyStageAggregate();
  for (const key of keys) {
    const vals = records
      .map((r) => r.stagesMs[key])
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    if (vals.length === 0) {
      out[key] = 0;
    } else if (mode === 'median') {
      out[key] = roundNum(computeQuantileFromSorted(vals, 0.5), 2);
    } else {
      out[key] = roundNum(vals[vals.length - 1], 2);
    }
  }
  return out;
}

export function summarizeTransitionLatency(params: {
  transitions: readonly TransitionCriticalPathRecord[];
  maxObservedPendingMs: number;
  afterDiag: HierarchicalStreamingDiagnosticsSnapshot;
  startedDelta: number;
  completedDelta: number;
  cancelledDelta: number;
  deferredDelta: number;
}): TransitionLatencySummary {
  const {
    transitions,
    maxObservedPendingMs,
    afterDiag,
    startedDelta,
    completedDelta,
    cancelledDelta,
    deferredDelta,
  } = params;

  const completed = transitions.filter((t) => t.outcome === 'completed');
  const unfinishedAtEnd = afterDiag.transitionState !== 'idle' ? 1 : 0;

  let maxPending = maxObservedPendingMs;
  for (const t of transitions) {
    if (t.totalDurationMs > maxPending) {
      maxPending = t.totalDurationMs;
    }
  }
  if (unfinishedAtEnd > 0 && afterDiag.transitionElapsedMs > maxPending) {
    maxPending = afterDiag.transitionElapsedMs;
  }

  const dominantBlockerCounts: Record<string, number> = {};
  for (const t of transitions) {
    dominantBlockerCounts[t.dominantBlockerCategory] =
      (dominantBlockerCounts[t.dominantBlockerCategory] ?? 0) + 1;
  }
  if (
    unfinishedAtEnd > 0 &&
    afterDiag.currentTransitionBlocker.active &&
    afterDiag.currentTransitionBlocker.blockerCategory !== 'none'
  ) {
    const k = `${afterDiag.currentTransitionBlocker.blockerCategory} (unfinished)`;
    dominantBlockerCounts[k] = (dominantBlockerCounts[k] ?? 0) + 1;
  }

  let slowestTransition: TransitionCriticalPathRecord | null = null;
  for (const t of transitions) {
    if (!slowestTransition || t.totalDurationMs > slowestTransition.totalDurationMs) {
      slowestTransition = t;
    }
  }

  return {
    transitionsAttempted: startedDelta,
    transitionsCompleted: completedDelta,
    transitionsCancelled: cancelledDelta,
    transitionsDeferredBudget: deferredDelta,
    transitionsUnfinishedAtEnd: unfinishedAtEnd,
    maxPendingDurationMs: roundNum(maxPending, 2),
    completedLatencyMs: computeLatencyDistribution(
      completed.map((t) => t.totalDurationMs)
    ),
    completedLatencyByTarget: {
      to1024: computeLatencyDistribution(
        completed
          .filter((t) => t.toResolutionMeters === 1024)
          .map((t) => t.totalDurationMs)
      ),
      to2048: computeLatencyDistribution(
        completed
          .filter((t) => t.toResolutionMeters === 2048)
          .map((t) => t.totalDurationMs)
      ),
      to4096: computeLatencyDistribution(
        completed
          .filter((t) => t.toResolutionMeters === 4096)
          .map((t) => t.totalDurationMs)
      ),
    },
    criticalPathStagesMedianMs: aggregateTransitionStages(
      completed.length > 0 ? completed : transitions,
      'median'
    ),
    criticalPathStagesMaxMs: aggregateTransitionStages(
      completed.length > 0 ? completed : transitions,
      'max'
    ),
    dominantBlockerCounts,
    slowestTransition,
    liveBlockerAtEnd:
      unfinishedAtEnd > 0 ? afterDiag.currentTransitionBlocker : null,
    recordedTransitions: [...transitions],
  };
}

function parseVariantList(raw: string): StreamingF1VariantId[] {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'all') {
    return [...ALL_F1_BENCHMARK_VARIANTS];
  }
  const tokens = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error('Empty --variants list');
  }
  const out: StreamingF1VariantId[] = [];
  for (const token of tokens) {
    if (!(token in STREAMING_F1_VARIANTS)) {
      throw new Error(
        `Unknown variant "${token}". Valid values: all, ${ALL_F1_BENCHMARK_VARIANTS.join(', ')}`
      );
    }
    const id = token as StreamingF1VariantId;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function parseNumberCsv(raw: string, flagName: string, minVal: number): number[] {
  const values = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= minVal);
  if (values.length === 0) {
    throw new Error(`Invalid numeric list for --${flagName}: "${raw}"`);
  }
  return values;
}

export function buildVariantRunMatrix(opts: HierarchicalBenchmarkCli): VariantRunSpec[] {
  const runs: VariantRunSpec[] = [];
  const budgets = opts.frameBudgetsMs;
  const debounces = opts.debounceValuesMs;

  for (const variantId of opts.variants) {
    const base = STREAMING_F1_VARIANTS[variantId];
    const sweepBudgets =
      budgets && base.sharedSchedulerEnabled ? budgets : [base.frameStreamingBudgetMs];
    const sweepDebounces =
      debounces && base.transitionDebounceMs > 0
        ? debounces
        : [base.transitionDebounceMs];

    for (const budgetMs of sweepBudgets) {
      for (const debounceMs of sweepDebounces) {
        const cfg = normalizeStreamingFrameBudgetConfig(
          {
            frameStreamingBudgetMs: budgetMs,
            transitionDebounceMs: debounceMs,
          },
          base
        );
        const suffixParts: string[] = [];
        if (budgets && base.sharedSchedulerEnabled) {
          suffixParts.push(`b${budgetMs}ms`);
        }
        if (debounces && base.transitionDebounceMs > 0) {
          suffixParts.push(`d${debounceMs}ms`);
        }
        const runId =
          suffixParts.length > 0
            ? `${variantId}@${suffixParts.join('_')}`
            : variantId;
        runs.push({
          runId,
          variantId,
          frameBudgetConfig: cfg,
          cpuMemoryBudgetMiB: opts.cpuMemoryBudgetMiB,
        });
      }
    }
  }
  return runs;
}

export function parseHierarchicalBenchmarkCli(
  argv: readonly string[] = process.argv.slice(2)
): HierarchicalBenchmarkCli {
  const defaultBudgetMiB = Math.round(
    DEFAULT_HIERARCHICAL_RESOURCE_BUDGET.totalMemoryBudgetBytes / (1024 * 1024)
  );
  const opts: HierarchicalBenchmarkCli = {
    descriptorPath: null,
    index1024Path: null,
    index2048Path: null,
    index4096Path: null,
    foliage: 'both',
    variants: ['combined'],
    frameBudgetsMs: null,
    debounceValuesMs: null,
    cpuMemoryBudgetMiB: defaultBudgetMiB,
    themeId: 'daylight',
    requireHardware: true,
    gpuBackend: 'auto',
    outputPath: path.resolve('benchmarks/results/tkt041-f1-hierarchical-streaming.json'),
    markdownPath: path.resolve('benchmarks/results/tkt041-f1-hierarchical-streaming.md'),
    quick: false,
  };

  for (const arg of argv) {
    if (arg === '--allow-software') {
      opts.requireHardware = false;
      continue;
    }
    if (arg === '--quick') {
      opts.quick = true;
      continue;
    }
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq <= 2) {
      throw new Error(`Expected --key=value or --flag, got "${arg}"`);
    }
    const key = arg.slice(2, eq);
    const val = arg.slice(eq + 1);
    if (!val) throw new Error(`Empty value for --${key}`);

    if (key === 'descriptor') opts.descriptorPath = path.resolve(val);
    else if (key === 'index-1024') opts.index1024Path = path.resolve(val);
    else if (key === 'index-2048') opts.index2048Path = path.resolve(val);
    else if (key === 'index-4096') opts.index4096Path = path.resolve(val);
    else if (key === 'foliage') {
      if (val !== 'both' && val !== 'on' && val !== 'off') {
        throw new Error(`Invalid --foliage "${val}" (expected both|on|off)`);
      }
      opts.foliage = val;
    } else if (key === 'variants') {
      opts.variants = parseVariantList(val);
    } else if (key === 'budgets') {
      opts.frameBudgetsMs = parseNumberCsv(val, 'budgets', 0.25);
    } else if (key === 'debounce-ms') {
      opts.debounceValuesMs = parseNumberCsv(val, 'debounce-ms', 0);
    } else if (key === 'budget-mb') {
      const n = Number(val);
      if (!Number.isFinite(n) || n < 32) {
        throw new Error(`Invalid --budget-mb "${val}" (must be >= 32)`);
      }
      opts.cpuMemoryBudgetMiB = Math.round(n);
    } else if (key === 'theme') opts.themeId = val;
    else if (key === 'gpu-backend') opts.gpuBackend = parseChromiumGpuBackend(val);
    else if (key === 'out') opts.outputPath = path.resolve(val);
    else if (key === 'markdown-out') opts.markdownPath = path.resolve(val);
    else throw new Error(`Unknown CLI argument "--${key}"`);
  }

  if (!opts.descriptorPath) {
    const provided = [opts.index1024Path, opts.index2048Path, opts.index4096Path].filter(
      Boolean
    );
    if (provided.length < 2) {
      throw new Error(
        'Provide either --descriptor=<hierarchical-mosaic.json> or at least two of --index-1024 / --index-2048 / --index-4096.'
      );
    }
  }

  return opts;
}

function resolveChromiumExecutablePath(): string | undefined {
  const envExec = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (envExec && fs.existsSync(envExec)) return envExec;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright';
  if (!fs.existsSync(root)) return undefined;
  const direct = path.join(
    root,
    'chrome-headless-shell-linux64',
    'chrome-headless-shell'
  );
  if (fs.existsSync(direct)) return direct;
  for (const entry of fs.readdirSync(root)) {
    if (entry.startsWith('chromium_headless_shell-')) {
      const candidate = path.join(
        root,
        entry,
        'chrome-headless-shell-linux64',
        'chrome-headless-shell'
      );
      if (fs.existsSync(candidate)) return candidate;
    }
    if (entry.startsWith('chromium-')) {
      const candidate = path.join(root, entry, 'chrome-linux', 'chrome');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function buildTempDescriptorFromIndexes(opts: HierarchicalBenchmarkCli): {
  descriptorPath: string;
  cleanup: () => void;
} {
  const entries: Array<{ tileSizeMeters: number; absPath: string }> = [];
  if (opts.index1024Path) {
    entries.push({ tileSizeMeters: 1024, absPath: opts.index1024Path });
  }
  if (opts.index2048Path) {
    entries.push({ tileSizeMeters: 2048, absPath: opts.index2048Path });
  }
  if (opts.index4096Path) {
    entries.push({ tileSizeMeters: 4096, absPath: opts.index4096Path });
  }
  let commonDir = path.dirname(entries[0].absPath);
  for (let i = 1; i < entries.length; i++) {
    const dir = path.dirname(entries[i].absPath);
    while (!dir.startsWith(commonDir) && commonDir !== path.dirname(commonDir)) {
      commonDir = path.dirname(commonDir);
    }
  }
  const firstIdx = JSON.parse(
    fs.readFileSync(entries[0].absPath, 'utf8')
  ) as RegionalMosaicIndex;
  const tempFile = path.join(
    commonDir,
    `.tmp-tkt041-hierarchical-${process.pid}-${Date.now()}.json`
  );
  const descriptor: HierarchicalRegionalMosaicDescriptor = {
    schemaType: HIERARCHICAL_MOSAIC_SCHEMA_TYPE,
    schemaVersion: HIERARCHICAL_MOSAIC_SCHEMA_VERSION,
    name: `${firstIdx.config.name}-hierarchical`,
    snapshotId: firstIdx.snapshotId,
    sourceSha256: firstIdx.sourceSha256,
    projectionId: 'EPSG:25832',
    levels: entries.map((e) => ({
      tileSizeMeters: e.tileSizeMeters,
      indexPath: path.relative(commonDir, e.absPath).replace(/\\/g, '/'),
    })),
  };
  fs.writeFileSync(tempFile, JSON.stringify(descriptor, null, 2), 'utf8');
  return {
    descriptorPath: tempFile,
    cleanup: () => {
      try {
        fs.rmSync(tempFile, { force: true });
      } catch {
        // ignore cleanup error
      }
    },
  };
}

async function startHierarchicalServer(descriptorPath: string): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = express();
  const handler = createRegionalMosaicHttpHandler({ indexPath: descriptorPath });

  app.get('/api/tiles-region/manifest', (req, res) => {
    void handler.manifestHandler(req, res);
  });
  app.get(
    '/api/tiles-region/r/:tileSizeMeters/:snapshotId/:schemaVersion/:lod/:tx/:ty',
    (req, res) => {
      void handler.tilePayloadHandler(req, res);
    }
  );
  app.get('/api/tiles-region/r/:tileSizeMeters/:lod/:tx/:ty', (req, res) => {
    void handler.tilePayloadHandler(req, res);
  });
  app.get(
    '/api/tiles-region/:snapshotId/:schemaVersion/:lod/:tx/:ty',
    (req, res) => {
      void handler.tilePayloadHandler(req, res);
    }
  );
  app.get('/api/tiles-region/:lod/:tx/:ty', (req, res) => {
    void handler.tilePayloadHandler(req, res);
  });

  const vite: ViteDevServer = await createViteServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'spa',
    logLevel: 'error',
  });
  app.use(vite.middlewares);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind ephemeral port for hierarchical benchmark');
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      try {
        handler.close();
      } catch {
        // ignore
      }
      await vite.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function formatHierarchicalStreamingMarkdown(
  report: HierarchicalStreamingBenchmarkReport
): string {
  const lines: string[] = [
    '# TKT-041-F1 Frame-Budgeted Hierarchical Tile Streaming Benchmark Report',
    '',
    `- **Generated:** ${report.generatedAtIso}`,
    `- **Hierarchy:** \`${report.hierarchyName}\` (${report.availableResolutionsMeters.map((r) => `${r} m`).join(' / ')})`,
    `- **CPU Memory Budget:** ${report.cpuMemoryBudgetMiB} MiB (provisional desktop default: 1,536 MiB)`,
    `- **Variants Evaluated:** ${report.variantMatrix.map((v) => `\`${v.runId}\``).join(', ')}`,
    `- **Viewport:** ${report.viewport.width} × ${report.viewport.height} @ DPR ${report.viewport.deviceScaleFactor} | **Theme:** \`${report.themeId}\``,
    `- **WebGL Renderer:** \`${report.gpuRenderer}\` (${report.gpuVendor})`,
    `- **Renderer Classification:** ${
      report.isSoftwareRenderer
        ? '**SOFTWARE RASTERIZER (SwiftShader — validates correctness, scheduler/GPU-prep/deferred-disposal orchestration, transition critical-path attribution, picking parity, and memory accounting; frame intervals DO NOT represent RTX hardware GPU performance)**'
        : 'Hardware WebGL2 GPU'
    }`,
    '',
  ];

  if (report.softwareRendererWarning) {
    lines.push(`> **Warning:** ${report.softwareRendererWarning}`, '');
  }

  lines.push(
    '## 1. Frame-Time Consistency Across Variants & Scenarios',
    '',
    '| Variant | Foliage | Scenario | Motion | Frame med / p95 / p99 / max (ms) | >6.94ms (144Hz) | Active-Work p95 (ms) | GPU Upload (u / MiB) | Def Disp (tiles / peak MiB) | Sched Overruns | Peak CPU/BVH (MiB) | Single-Res |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|'
  );
  for (const s of report.scenarios) {
    const fd = s.frameDistribution;
    const over144Pct =
      fd.thresholdExceedances.find((t) => Math.abs(t.thresholdMs - 6.94) < 0.05)
        ?.pct ?? 0;
    const fLabel = s.foliageEnabled ? 'ON' : 'OFF';
    const inv =
      s.hysteresisZeroTransitionsPassed !== undefined
        ? `${s.singleResolutionInvariantPassed ? 'PASS' : 'FAIL'} (0-osc:${s.hysteresisZeroTransitionsPassed ? 'PASS' : 'FAIL'})`
        : s.singleResolutionInvariantPassed
          ? 'PASS'
          : 'FAIL';
    lines.push(
      `| \`${s.variantRunId}\` | ${fLabel} | \`${s.scenarioId}\` | ${s.continuousMotion ? 'continuous' : 'stepped'} | ${fd.median.toFixed(2)} / ${fd.p95.toFixed(2)} / ${fd.p99.toFixed(2)} / ${fd.max.toFixed(2)} | ${over144Pct.toFixed(1)}% | ${s.eventConditioned.activeStreamingWorkFrames.p95.toFixed(2)} | ${s.f1Counters.gpuUploadedUnitsDelta} / ${(s.f1Counters.gpuUploadedBytesDelta / (1024 * 1024)).toFixed(2)} | ${s.f1Counters.deferredDisposedTilesDelta} / ${(s.f1Counters.peakPendingDisposalBytes / (1024 * 1024)).toFixed(2)} | ${s.f1Counters.schedulerOverrunCountDelta} | ${(s.peakMeasuredCpuBytes / (1024 * 1024)).toFixed(2)} | ${inv} |`
    );
  }
  lines.push('');

  lines.push(
    '## 2. Independent Transition Latency & Critical-Path Attribution (Section 12)',
    '',
    '> Transition latency is tracked separately from frame-time consistency so smoother frames are never achieved by leaving resolution transitions pending indefinitely.',
    '',
    '| Variant | Foliage | Scenario | Trans (start/done/cancel/defer/unfinished) | Max Pending (ms) | Overall p50 / p95 / max (ms) | →4096m p50 / max (ms) | Med Critical Stages: fq / net / wq / dec / rw / gpu / tail (ms) | Top Dominant Blocker |',
    '|---|---|---|---|---:|---:|---:|---|---|'
  );
  for (const s of report.scenarios) {
    const tl = s.transitionLatency;
    const st = tl.criticalPathStagesMedianMs;
    const topBlockerEntry = Object.entries(tl.dominantBlockerCounts).sort(
      (a, b) => b[1] - a[1]
    )[0];
    const topBlocker = topBlockerEntry
      ? `${topBlockerEntry[0]} (${topBlockerEntry[1]})`
      : '—';
    const to4096Str =
      tl.completedLatencyByTarget.to4096.count > 0
        ? `${tl.completedLatencyByTarget.to4096.p50Ms.toFixed(1)} / ${tl.completedLatencyByTarget.to4096.maxMs.toFixed(1)}`
        : '—';
    const overallStr =
      tl.completedLatencyMs.count > 0
        ? `${tl.completedLatencyMs.p50Ms.toFixed(1)} / ${tl.completedLatencyMs.p95Ms.toFixed(1)} / ${tl.completedLatencyMs.maxMs.toFixed(1)}`
        : '—';
    lines.push(
      `| \`${s.variantRunId}\` | ${s.foliageEnabled ? 'ON' : 'OFF'} | \`${s.scenarioId}\` | ${tl.transitionsAttempted}/${tl.transitionsCompleted}/${tl.transitionsCancelled}/${tl.transitionsDeferredBudget}/${tl.transitionsUnfinishedAtEnd} | ${tl.maxPendingDurationMs.toFixed(1)} | ${overallStr} | ${to4096Str} | ${st.fetchQueueWaitMs.toFixed(1)} / ${st.payloadRetrievalMs.toFixed(1)} / ${st.workerQueueWaitMs.toFixed(1)} / ${st.workerDecodeAndBvhMs.toFixed(1)} / ${st.mainThreadReconstructWaitMs.toFixed(1)} / ${st.gpuPrepTotalMs.toFixed(1)} / ${st.remainingCoverageWaitMs.toFixed(1)} | ${topBlocker} |`
    );
  }
  lines.push('');

  if (report.pickingParity.length > 0) {
    lines.push(
      '## 3. Feature Picking Latency & Cross-Resolution Parity',
      '',
      '| Variant | Foliage | Resolution | Status | Median Pick (ms) | P95 Pick (ms) | Hits / Samples | Cross-Resolution Parity |',
      '|---|---|---:|---|---:|---:|---:|---:|'
    );
    for (const p of report.pickingParity) {
      const fLabel = p.foliageEnabled ? 'ON' : 'OFF';
      for (let i = 0; i < p.resolutions.length; i++) {
        const r = p.resolutions[i];
        const status = r.transitionCompleted
          ? 'VALID'
          : `INVALID (${r.budgetDeferralReason ? 'DEFERRED' : `actual ${r.actualActiveResolutionMeters}m`})`;
        const parityCol =
          i === 0
            ? p.allResolutionsValid
              ? `${p.parityMatchCount}/${p.comparedPointCount} (${(p.parityRatio * 100).toFixed(1)}%)`
              : 'INVALID (resolution mismatch/deferral)'
            : '—';
        lines.push(
          `| \`${p.variantRunId}\` | ${fLabel} | ${r.resolutionMeters} m | ${status} | ${r.medianPickMs.toFixed(3)} | ${r.p95PickMs.toFixed(3)} | ${r.hitCount}/${r.sampleCount} | ${parityCol} |`
        );
      }
    }
    lines.push('');
  }

  if (report.modeComparisons.length > 0) {
    lines.push(
      '## 4. Auto vs. Forced Single-Resolution Mode Comparison',
      '',
      '| Variant | Foliage | Pose | Zoom | Mode | Req / Active Res | Status | Frame med / p95 (ms) | Median Draw Calls | Median Triangles | Measured CPU/BVH (MiB) | Est. GPU (MiB) |',
      '|---|---|---|---:|---|---|---|---:|---:|---:|---:|---:|'
    );
    for (const c of report.modeComparisons) {
      const fLabel = c.foliageEnabled ? 'ON' : 'OFF';
      const status = c.comparisonValid
        ? 'VALID'
        : `INVALID (${c.invalidReason ?? 'mismatch'})`;
      lines.push(
        `| \`${c.variantRunId}\` | ${fLabel} | ${c.poseLabel} | ${c.zoom.toFixed(2)} | \`${c.mode}\` | ${c.requestedResolutionMeters}m / ${c.actualActiveResolutionMeters}m | ${status} | ${c.frameDistribution.median.toFixed(2)} / ${c.frameDistribution.p95.toFixed(2)} | ${c.medianDrawCalls.toFixed(0)} | ${c.medianTriangles.toFixed(0)} | ${c.measuredCpuMiB.toFixed(2)} | ${c.estimatedGpuMiB.toFixed(2)} |`
      );
    }
    lines.push('');
  }

  lines.push(
    '## Notes & Accounting Caveats',
    '',
    '- **Directly measured memory (`Measured CPU/BVH`)** sums JS typed-array vertex/index/instance buffers, serialized mesh BVHs, `InstancedSpatialIndex` buffers, queued decoded payloads, retained inactive LRU cache tiles, and queued pending-disposal tiles until physically disposed.',
    '- **Estimated GPU memory (`Est. GPU`)** is an explicit upper-bound estimate of uploaded WebGL vertex/index/instance buffers; browsers do not expose exact driver VRAM residency.',
    '- **GPU upload timing (`gpuUploadSubmitMs`)** measures main-thread CPU submission time of the public-API 1×1 `WebGLRenderTarget` offscreen staging render; asynchronous GPU driver completion is not measured by this timer.',
    '- **Comparison validity guard (TKT-041-F1 Section 8):** Forced or automatic mode comparisons whose requested resolution was deferred by memory budget or did not reach atomic activation are explicitly marked `INVALID` and never reported as valid resolution comparisons.',
    ''
  );

  return lines.join('\n');
}

export async function runHierarchicalStreamingBenchmark(
  opts: HierarchicalBenchmarkCli
): Promise<HierarchicalStreamingBenchmarkReport> {
  let descriptorPath = opts.descriptorPath;
  let cleanupTempDescriptor: (() => void) | null = null;
  if (!descriptorPath) {
    const built = buildTempDescriptorFromIndexes(opts);
    descriptorPath = built.descriptorPath;
    cleanupTempDescriptor = built.cleanup;
  }

  const variantMatrix = buildVariantRunMatrix(opts);
  const playwright = await import('playwright');
  const server = await startHierarchicalServer(descriptorPath);

  try {
    const manifestResp = await fetch(`${server.baseUrl}/api/tiles-region/manifest`);
    if (!manifestResp.ok) {
      throw new Error(
        `Hierarchical manifest endpoint failed with HTTP ${manifestResp.status}`
      );
    }
    const manifestJson = (await manifestResp.json()) as any;
    if (!manifestJson.available || !manifestJson.hierarchy) {
      throw new Error(
        `Loaded mosaic at ${descriptorPath} is not a valid multi-resolution hierarchical descriptor`
      );
    }

    const hierarchyName: string = manifestJson.hierarchy.hierarchyName;
    const availableResolutionsMeters: number[] =
      manifestJson.hierarchy.resolutionsMeters;

    const executablePath = resolveChromiumExecutablePath();
    const browser = await playwright.chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: resolveChromiumLaunchArgs({
        useSwiftShader:
          !opts.requireHardware && opts.gpuBackend === 'auto' ? false : undefined,
        gpuBackend: opts.gpuBackend,
      }),
    });

    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      await page.addInitScript('window.__name = (fn) => fn;');

      const pageUrl = `${server.baseUrl}/?benchmark=1&dock=collapsed&${REGIONAL_MIN_ZOOM_QUERY_PARAM}=0.15`;
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(
        () =>
          Boolean(
            (window as any).__BENCHMARK_HARNESS__?.loadM2aStreaming &&
              (window as any).__BENCHMARK_HARNESS__?.getHierarchicalDiagnostics &&
              (window as any).__BENCHMARK_HARNESS__?.setStreamingFrameBudgetConfig &&
              document.querySelector('canvas')
          ),
        { timeout: 60000 }
      );

      const gpuInfo = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
        if (!gl) {
          throw new Error('Hierarchical benchmark requires an active WebGL2 canvas');
        }
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        const vendor = String(
          gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR) ??
            'Unknown'
        );
        const renderer = String(
          gl.getParameter(
            debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER
          ) ?? 'Unknown'
        );
        return { gpuVendor: vendor, gpuRenderer: renderer };
      });

      const isSoftware =
        isSoftwareWebGLRenderer(gpuInfo.gpuRenderer) ||
        gpuInfo.gpuRenderer === 'Unknown';
      if (isSoftware && opts.requireHardware) {
        throw new Error(
          `Detected software/unverified WebGL renderer "${gpuInfo.gpuRenderer}". Re-run on hardware GPU or pass --allow-software for deterministic synthetic validation.`
        );
      }

      const softwareWarning = isSoftware
        ? `Executed on software WebGL renderer (${gpuInfo.gpuRenderer}). Resolution switching, frame-budget scheduler, incremental GPU upload slicing, deferred disposal, zero-overlap invariants, Section 12 transition critical-path attribution, picking parity, and measured memory accounting are valid, but frame intervals reflect software rasterization rather than hardware GPU performance.`
        : null;

      const foliageConfigs: boolean[] =
        opts.foliage === 'both'
          ? [true, false]
          : opts.foliage === 'on'
            ? [true]
            : [false];

      const scenarios: HierarchicalScenarioMetrics[] = [];
      const pickingParity: HierarchicalPickingParityResult[] = [];
      const modeComparisons: HierarchicalModeComparisonEntry[] = [];

      const stepMs = opts.quick ? 550 : 1200;
      const continuousTotalMs = opts.quick ? 2400 : 5400;
      const reversalTotalMs = opts.quick ? 2200 : 4800;
      const repeatedTotalMs = opts.quick ? 2800 : 6200;
      const modeMeasureMs = opts.quick ? 600 : 1400;
      const cpuBudgetBytes = opts.cpuMemoryBudgetMiB * 1024 * 1024;

      // Determine which variant runs the shared TKT-041 correctness/parity/mode-comparison checks
      const primaryVariantForExtras =
        variantMatrix.find((v) => v.variantId === 'combined')?.runId ??
        variantMatrix[variantMatrix.length - 1].runId;

      const reloadFreshMosaic = async (
        variantSpec: VariantRunSpec,
        foliageEnabled: boolean,
        initialZoom = 1.6
      ) => {
        await page.evaluate(
          async ({ themeId, showFoliage, f1Config, budgetBytes, zoom }) => {
            const h = (window as any).__BENCHMARK_HARNESS__;
            h.setStreamingProfilerEnabled(false);
            h.setShowFoliage(showFoliage);
            await h.unloadDataset?.();
            await h.loadM2aStreaming({
              apiBaseUrl: '/api/tiles-region',
              themeId,
              target: [0, 0, 0],
              zoom,
              azimuthDeg: 45,
              regionalMinZoom: 0.15,
              tilePreparationOptions: 'combined',
              hierarchicalPolicy: { mode: 'auto' },
              hierarchicalBudget: { totalMemoryBudgetBytes: budgetBytes },
              streamingFrameBudget: f1Config,
              waitForIdle: true,
              timeoutMs: 120000,
            });
          },
          {
            themeId: opts.themeId,
            showFoliage: foliageEnabled,
            f1Config: variantSpec.frameBudgetConfig,
            budgetBytes: cpuBudgetBytes,
            zoom: initialZoom,
          }
        );
      };

      const buildScenarioMetricsFromBrowser = (
        variantSpec: VariantRunSpec,
        foliageEnabled: boolean,
        scenarioId: string,
        description: string,
        continuousMotion: boolean,
        checkZeroTransitions: boolean | undefined,
        result: {
          durationMs: number;
          beforeDiag: HierarchicalStreamingDiagnosticsSnapshot;
          afterDiag: HierarchicalStreamingDiagnosticsSnapshot;
          snap: StreamingProfilerSnapshot;
          maxSimultaneousAttached: number;
          peakMeasuredCpuBytes: number;
          peakEstimatedGpuBytes: number;
          peakPendingDisposalBytes: number;
          maxObservedPendingMs: number;
          timeWithoutValidCoverageMs: number;
        }
      ): HierarchicalScenarioMetrics => {
        const frames = result.snap.frames;
        const frameIntervalsMs = frames.map((f) => f.frameIntervalMs);
        const frameDistribution = computeStreamingFrameDistribution(
          frameIntervalsMs
        );
        const observedCadence = assessObservedRefreshCadence({
          frameIntervalsMs,
          cpuRenderMs: frames.map((f) => f.glRenderCpuMs),
          syncMainThreadMs: frames.map((f) => f.attributedSyncMainThreadMs),
          isSoftwareRenderer: isSoftware,
        });
        const eventConditioned = summarizeEventConditionedFrames(frames);
        const stageSummaries = summarizeStageTimings(frames);
        const topSpikes = attributeWorstFrames({
          frames,
          events: result.snap.events ?? [],
          longTasks: result.snap.longTasks ?? [],
          loafs: result.snap.loafs ?? [],
          topN: 8,
        });

        let nestingViolations = 0;
        for (const f of frames) {
          if (!verifyFrameStageNesting(f).valid) {
            nestingViolations += 1;
          }
        }

        const drawCalls = computeSampleStatistics(
          frames.map((f) => f.renderCalls)
        );
        const triangles = computeSampleStatistics(
          frames.map((f) => f.renderTriangles)
        );

        const startedDelta =
          result.afterDiag.counters.transitionsStarted -
          result.beforeDiag.counters.transitionsStarted;
        const completedDelta =
          result.afterDiag.counters.transitionsCompleted -
          result.beforeDiag.counters.transitionsCompleted;
        const cancelledDelta =
          result.afterDiag.counters.transitionsCancelled -
          result.beforeDiag.counters.transitionsCancelled;
        const deferredDelta =
          result.afterDiag.counters.transitionsDeferredBudget -
          result.beforeDiag.counters.transitionsDeferredBudget;
        const cacheHitsDelta =
          result.afterDiag.counters.cacheHits -
          result.beforeDiag.counters.cacheHits;
        const cacheEvictionsDelta =
          result.afterDiag.counters.cacheEvictions -
          result.beforeDiag.counters.cacheEvictions;

        const beforeMaxGen = result.beforeDiag.recentTransitions.reduce(
          (m, t) => Math.max(m, t.transitionGeneration),
          0
        );
        const newTransitions = result.afterDiag.recentTransitions.filter(
          (t) => t.transitionGeneration > beforeMaxGen
        );

        const transitionLatency = summarizeTransitionLatency({
          transitions: newTransitions,
          maxObservedPendingMs: result.maxObservedPendingMs,
          afterDiag: result.afterDiag,
          startedDelta,
          completedDelta,
          cancelledDelta,
          deferredDelta,
        });

        const beforeFb = result.beforeDiag.frameBudget;
        const afterFb = result.afterDiag.frameBudget;
        const f1Counters: HierarchicalScenarioF1Counters = {
          transitionsDebouncedAvoidedDelta:
            afterFb.transitionsDebouncedAvoided -
            beforeFb.transitionsDebouncedAvoided,
          destinationPrepReusedDelta:
            afterFb.destinationPrepReused - beforeFb.destinationPrepReused,
          prewarmTilesPreparedDelta:
            result.afterDiag.counters.prewarmTilesPrepared -
            result.beforeDiag.counters.prewarmTilesPrepared,
          prewarmReusedOnTransitionDelta:
            result.afterDiag.counters.prewarmReusedOnTransition -
            result.beforeDiag.counters.prewarmReusedOnTransition,
          gpuUploadedUnitsDelta:
            afterFb.gpuPreparer.totalUnitsUploaded -
            beforeFb.gpuPreparer.totalUnitsUploaded,
          gpuUploadedBytesDelta:
            afterFb.gpuPreparer.totalEstimatedBytesUploaded -
            beforeFb.gpuPreparer.totalEstimatedBytesUploaded,
          deferredDisposedTilesDelta:
            afterFb.deferredDisposal.totalDisposedTiles -
            beforeFb.deferredDisposal.totalDisposedTiles,
          peakPendingDisposalBytes: result.peakPendingDisposalBytes,
          schedulerOverrunCountDelta:
            afterFb.scheduler.totalIndivisibleOverruns -
            beforeFb.scheduler.totalIndivisibleOverruns,
          boundaryOverlayRebuildMsDelta: roundNum(
            afterFb.boundaryOverlayRebuildMsTotal -
              beforeFb.boundaryOverlayRebuildMsTotal,
            3
          ),
          timeWithoutValidCoverageMs: roundNum(
            result.timeWithoutValidCoverageMs,
            2
          ),
        };

        return {
          variantRunId: variantSpec.runId,
          variantId: variantSpec.variantId,
          frameBudgetConfig: { ...variantSpec.frameBudgetConfig },
          cpuMemoryBudgetMiB: variantSpec.cpuMemoryBudgetMiB,
          foliageEnabled,
          scenarioId,
          description,
          continuousMotion,
          durationMs: roundNum(result.durationMs, 2),
          frameDistribution,
          observedCadence,
          eventConditioned,
          stageSummaries,
          topSpikes,
          nestingValidation: {
            checkedFrames: frames.length,
            violationCount: nestingViolations,
          },
          transitionsStartedDelta: startedDelta,
          transitionsCompletedDelta: completedDelta,
          transitionsCancelledDelta: cancelledDelta,
          transitionsDeferredBudgetDelta: deferredDelta,
          cacheHitsDelta,
          cacheEvictionsDelta,
          maxActivationSwapMs: result.afterDiag.timings.maxActivationSwapMs,
          lastActivationSwapMs: result.afterDiag.timings.lastActivationSwapMs,
          endActiveResolutionMeters: result.afterDiag.activeResolutionMeters,
          endTransitionState: result.afterDiag.transitionState,
          maxSimultaneousAttachedResolutions: result.maxSimultaneousAttached,
          singleResolutionInvariantPassed:
            result.maxSimultaneousAttached <= 1,
          peakMeasuredCpuBytes: result.peakMeasuredCpuBytes,
          peakEstimatedGpuBytes: result.peakEstimatedGpuBytes,
          medianDrawCalls: drawCalls.median,
          medianTriangles: triangles.median,
          ...(checkZeroTransitions
            ? { hysteresisZeroTransitionsPassed: startedDelta === 0 }
            : {}),
          f1Counters,
          transitionLatency,
        };
      };

      const runContinuousMotionScenario = async (params: {
        variantSpec: VariantRunSpec;
        foliageEnabled: boolean;
        scenarioId: string;
        description: string;
        durationMs: number;
        trajectoryKind:
          | 'pan_zoom_sweep'
          | 'rapid_zoom_reversal_pan'
          | 'repeated_transitions_pan';
      }): Promise<HierarchicalScenarioMetrics> => {
        const result = await page.evaluate(
          async ({ scenarioId, durationMs, trajectoryKind }) => {
            const h = (window as any).__BENCHMARK_HARNESS__;
            const beforeDiag: HierarchicalStreamingDiagnosticsSnapshot =
              h.getHierarchicalDiagnostics();
            h.resetStreamingProfiler(scenarioId);
            h.setStreamingProfilerEnabled(true, scenarioId);

            let maxSimultaneousAttached = 0;
            let peakMeasuredCpuBytes =
              beforeDiag?.resources.totalMeasuredBytes ?? 0;
            let peakEstimatedGpuBytes =
              beforeDiag?.resources.totalEstimatedGpuBytes ?? 0;
            let peakPendingDisposalBytes =
              beforeDiag?.frameBudget?.deferredDisposal.pendingBytes ?? 0;
            let maxObservedPendingMs = beforeDiag?.transitionElapsedMs ?? 0;
            let timeWithoutValidCoverageMs = 0;

            let lastSampleNow = performance.now();
            const sampleState = (now: number) => {
              const dt = Math.max(0, now - lastSampleNow);
              lastSampleNow = now;
              const breakdown = h.getAttachedResolutionBreakdown() as Record<
                string,
                number
              > | null;
              if (breakdown) {
                const count = Object.keys(breakdown).length;
                if (count > maxSimultaneousAttached) {
                  maxSimultaneousAttached = count;
                }
              }
              const hd =
                h.getHierarchicalDiagnostics() as HierarchicalStreamingDiagnosticsSnapshot | null;
              if (hd) {
                if (hd.resources.totalMeasuredBytes > peakMeasuredCpuBytes) {
                  peakMeasuredCpuBytes = hd.resources.totalMeasuredBytes;
                }
                if (
                  hd.resources.totalEstimatedGpuBytes > peakEstimatedGpuBytes
                ) {
                  peakEstimatedGpuBytes = hd.resources.totalEstimatedGpuBytes;
                }
                const dispBytes =
                  hd.frameBudget?.deferredDisposal.pendingBytes ?? 0;
                if (dispBytes > peakPendingDisposalBytes) {
                  peakPendingDisposalBytes = dispBytes;
                }
                if (
                  hd.transitionState !== 'idle' &&
                  hd.transitionElapsedMs > maxObservedPendingMs
                ) {
                  maxObservedPendingMs = hd.transitionElapsedMs;
                }
                if (hd.frameBudget && !hd.frameBudget.hasValidViewportCoverage) {
                  timeWithoutValidCoverageMs += dt;
                }
              }
            };

            const computePose = (
              u: number
            ): { target: [number, number, number]; zoom: number } => {
              const clampedU = Math.min(1, Math.max(0, u));
              if (trajectoryKind === 'pan_zoom_sweep') {
                // Continuous diagonal pan + smooth log-space zoom sweep 1.6 -> 0.18 -> 1.6
                const x = Math.sin(clampedU * Math.PI * 2) * 900;
                const z = (clampedU - 0.5) * 1400;
                const logMin = Math.log(0.18);
                const logMax = Math.log(1.6);
                const phase =
                  clampedU <= 0.5 ? clampedU * 2 : (1 - clampedU) * 2;
                const zoom = Math.exp(logMax + (logMin - logMax) * phase);
                return { target: [x, 0, z], zoom };
              }
              if (trajectoryKind === 'rapid_zoom_reversal_pan') {
                // Continuous pan while rapidly oscillating across 1024<->2048 and 2048<->4096
                const x = (clampedU - 0.5) * 1200;
                const z = Math.cos(clampedU * Math.PI * 3) * 500;
                // First half: fast boundary reversals around 0.72..1.08; second half: sustained zoom out to 0.18 then back to 1.4
                let zoom: number;
                if (clampedU < 0.45) {
                  zoom = 0.9 + Math.sin(clampedU * Math.PI * 14) * 0.22;
                } else if (clampedU < 0.78) {
                  zoom = 0.2;
                } else {
                  zoom = 1.4;
                }
                return { target: [x, 0, z], zoom };
              }
              // repeated_transitions_pan: continuous pan while visiting 1024 -> 2048 -> 4096 -> 2048 -> 1024 -> 4096 -> 1024
              const x = Math.cos(clampedU * Math.PI * 2) * 850;
              const z = Math.sin(clampedU * Math.PI * 2) * 850;
              const zoomStops = [1.5, 0.52, 0.18, 0.52, 1.5, 0.18, 1.5];
              const segPos = clampedU * (zoomStops.length - 1);
              const idx = Math.min(zoomStops.length - 2, Math.floor(segPos));
              const frac = segPos - idx;
              const z0 = zoomStops[idx];
              const z1 = zoomStops[idx + 1];
              const zoom = Math.exp(
                Math.log(z0) + (Math.log(z1) - Math.log(z0)) * frac
              );
              return { target: [x, 0, z], zoom };
            };

            // Elapsed-time driven loop: NEVER calls waitForM2aIdle() between camera updates!
            const tStart = performance.now();
            lastSampleNow = tStart;
            await new Promise<void>((resolve) => {
              const step = () => {
                const now = performance.now();
                const elapsed = now - tStart;
                const u = Math.min(1, elapsed / durationMs);
                const pose = computePose(u);
                h.setCameraPose(pose.target, pose.zoom, 45);
                sampleState(now);
                if (elapsed >= durationMs) {
                  resolve();
                  return;
                }
                requestAnimationFrame(step);
              };
              requestAnimationFrame(step);
            });
            const actualDurationMs = performance.now() - tStart;

            const afterDiag: HierarchicalStreamingDiagnosticsSnapshot =
              h.getHierarchicalDiagnostics();
            const snap: StreamingProfilerSnapshot =
              h.getStreamingProfilerSnapshot();
            h.setStreamingProfilerEnabled(false);

            return {
              durationMs: actualDurationMs,
              beforeDiag,
              afterDiag,
              snap,
              maxSimultaneousAttached,
              peakMeasuredCpuBytes,
              peakEstimatedGpuBytes,
              peakPendingDisposalBytes,
              maxObservedPendingMs,
              timeWithoutValidCoverageMs,
            };
          },
          {
            scenarioId: params.scenarioId,
            durationMs: params.durationMs,
            trajectoryKind: params.trajectoryKind,
          }
        );

        const entry = buildScenarioMetricsFromBrowser(
          params.variantSpec,
          params.foliageEnabled,
          params.scenarioId,
          params.description,
          true,
          undefined,
          result
        );
        scenarios.push(entry);
        return entry;
      };

      const runSteppedScenario = async (params: {
        variantSpec: VariantRunSpec;
        foliageEnabled: boolean;
        scenarioId: string;
        description: string;
        waypoints: Array<{
          target: [number, number, number];
          zoom: number;
          holdMs: number;
        }>;
        checkZeroTransitions?: boolean;
      }): Promise<HierarchicalScenarioMetrics> => {
        const result = await page.evaluate(async (p) => {
          const h = (window as any).__BENCHMARK_HARNESS__;
          const beforeDiag: HierarchicalStreamingDiagnosticsSnapshot =
            h.getHierarchicalDiagnostics();
          h.resetStreamingProfiler(p.scenarioId);
          h.setStreamingProfilerEnabled(true, p.scenarioId);

          let maxSimultaneousAttached = 0;
          let peakMeasuredCpuBytes =
            beforeDiag?.resources.totalMeasuredBytes ?? 0;
          let peakEstimatedGpuBytes =
            beforeDiag?.resources.totalEstimatedGpuBytes ?? 0;
          let peakPendingDisposalBytes =
            beforeDiag?.frameBudget?.deferredDisposal.pendingBytes ?? 0;
          let maxObservedPendingMs = beforeDiag?.transitionElapsedMs ?? 0;
          let timeWithoutValidCoverageMs = 0;
          let lastSampleNow = performance.now();

          const sampleState = () => {
            const now = performance.now();
            const dt = Math.max(0, now - lastSampleNow);
            lastSampleNow = now;
            const breakdown = h.getAttachedResolutionBreakdown() as Record<
              string,
              number
            > | null;
            if (breakdown) {
              const count = Object.keys(breakdown).length;
              if (count > maxSimultaneousAttached) {
                maxSimultaneousAttached = count;
              }
            }
            const hd =
              h.getHierarchicalDiagnostics() as HierarchicalStreamingDiagnosticsSnapshot | null;
            if (hd) {
              if (hd.resources.totalMeasuredBytes > peakMeasuredCpuBytes) {
                peakMeasuredCpuBytes = hd.resources.totalMeasuredBytes;
              }
              if (
                hd.resources.totalEstimatedGpuBytes > peakEstimatedGpuBytes
              ) {
                peakEstimatedGpuBytes = hd.resources.totalEstimatedGpuBytes;
              }
              const dispBytes =
                hd.frameBudget?.deferredDisposal.pendingBytes ?? 0;
              if (dispBytes > peakPendingDisposalBytes) {
                peakPendingDisposalBytes = dispBytes;
              }
              if (
                hd.transitionState !== 'idle' &&
                hd.transitionElapsedMs > maxObservedPendingMs
              ) {
                maxObservedPendingMs = hd.transitionElapsedMs;
              }
              if (hd.frameBudget && !hd.frameBudget.hasValidViewportCoverage) {
                timeWithoutValidCoverageMs += dt;
              }
            }
          };

          const tStart = performance.now();
          for (const wp of p.waypoints) {
            h.setCameraPose(wp.target, wp.zoom, 45);
            const wpStart = performance.now();
            await new Promise<void>((resolve) => {
              const rafLoop = () => {
                sampleState();
                if (performance.now() - wpStart >= wp.holdMs) {
                  resolve();
                  return;
                }
                requestAnimationFrame(rafLoop);
              };
              requestAnimationFrame(rafLoop);
            });
            await h.waitForM2aIdle();
            sampleState();
          }
          const durationMs = performance.now() - tStart;

          const afterDiag: HierarchicalStreamingDiagnosticsSnapshot =
            h.getHierarchicalDiagnostics();
          const snap: StreamingProfilerSnapshot =
            h.getStreamingProfilerSnapshot();
          h.setStreamingProfilerEnabled(false);

          return {
            durationMs,
            beforeDiag,
            afterDiag,
            snap,
            maxSimultaneousAttached,
            peakMeasuredCpuBytes,
            peakEstimatedGpuBytes,
            peakPendingDisposalBytes,
            maxObservedPendingMs,
            timeWithoutValidCoverageMs,
          };
        }, {
          scenarioId: params.scenarioId,
          waypoints: params.waypoints,
        });

        const entry = buildScenarioMetricsFromBrowser(
          params.variantSpec,
          params.foliageEnabled,
          params.scenarioId,
          params.description,
          false,
          params.checkZeroTransitions,
          result
        );
        scenarios.push(entry);
        return entry;
      };

      for (const foliageEnabled of foliageConfigs) {
        for (const variantSpec of variantMatrix) {
          console.log(
            `[bench:hierarchical] Variant=${variantSpec.runId} (foliage=${foliageEnabled ? 'ON' : 'OFF'}, budget=${variantSpec.cpuMemoryBudgetMiB} MiB)...`
          );

          // 1. Cold-cache continuous simultaneous pan + zoom (fresh mosaic reload)
          await reloadFreshMosaic(variantSpec, foliageEnabled, 1.6);
          await runContinuousMotionScenario({
            variantSpec,
            foliageEnabled,
            scenarioId: 'simultaneous_pan_zoom_cold',
            description:
              'Cold-cache continuous elapsed-time simultaneous pan + zoom (1.6 -> 0.18 -> 1.6) without waiting for streaming to settle',
            durationMs: continuousTotalMs,
            trajectoryKind: 'pan_zoom_sweep',
          });

          // Let pending transitions finish briefly between cold and warm scenarios
          await page.evaluate(async () => {
            const h = (window as any).__BENCHMARK_HARNESS__;
            h.setCameraPose([0, 0, 0], 1.6, 45);
            await h.waitForM2aIdle();
          });

          // 2. Warm-cache continuous simultaneous pan + zoom
          await runContinuousMotionScenario({
            variantSpec,
            foliageEnabled,
            scenarioId: 'simultaneous_pan_zoom_warm',
            description:
              'Warm-cache continuous elapsed-time simultaneous pan + zoom (1.6 -> 0.18 -> 1.6) checking cache/GPU prep reuse',
            durationMs: continuousTotalMs,
            trajectoryKind: 'pan_zoom_sweep',
          });

          // 3. Rapid zoom reversal while continuously panning
          await page.evaluate(async () => {
            const h = (window as any).__BENCHMARK_HARNESS__;
            h.setCameraPose([0, 0, 0], 1.15, 45);
            await h.waitForM2aIdle();
          });
          await runContinuousMotionScenario({
            variantSpec,
            foliageEnabled,
            scenarioId: 'rapid_zoom_reversal_pan',
            description:
              'Continuous pan with rapid zoom reversals across threshold then sustained zoom-out & zoom-in',
            durationMs: reversalTotalMs,
            trajectoryKind: 'rapid_zoom_reversal_pan',
          });

          // 4. Repeated resolution transitions during continuous pan
          await page.evaluate(async () => {
            const h = (window as any).__BENCHMARK_HARNESS__;
            h.setCameraPose([0, 0, 0], 1.5, 45);
            await h.waitForM2aIdle();
          });
          await runContinuousMotionScenario({
            variantSpec,
            foliageEnabled,
            scenarioId: 'repeated_resolution_transitions_pan',
            description:
              'Continuous circular pan with repeated 1024 -> 2048 -> 4096 -> 2048 -> 1024 -> 4096 -> 1024 transitions',
            durationMs: repeatedTotalMs,
            trajectoryKind: 'repeated_transitions_pan',
          });

          // 5. Stepped full zoom sweep (1024 -> 2048 -> 4096 -> 2048 -> 1024) for deterministic transition-latency verification
          await page.evaluate(async () => {
            const h = (window as any).__BENCHMARK_HARNESS__;
            h.setCameraPose([0, 0, 0], 1.6, 45);
            await h.waitForM2aIdle();
          });
          await runSteppedScenario({
            variantSpec,
            foliageEnabled,
            scenarioId: 'zoom_sweep_1024_2048_4096_back',
            description:
              'Stepped 1,024 -> 2,048 -> 4,096 -> 2,048 -> 1,024 zoom sweep settling at each stop',
            waypoints: [
              { target: [0, 0, 0], zoom: 1.6, holdMs: stepMs },
              { target: [0, 0, 0], zoom: 0.55, holdMs: stepMs },
              { target: [0, 0, 0], zoom: 0.18, holdMs: stepMs },
              { target: [0, 0, 0], zoom: 0.55, holdMs: stepMs },
              { target: [0, 0, 0], zoom: 1.6, holdMs: stepMs },
            ],
          });

          if (variantSpec.runId === primaryVariantForExtras) {
            // 6. Direct non-adjacent jump (1024 <-> 4096)
            await runSteppedScenario({
              variantSpec,
              foliageEnabled,
              scenarioId: 'direct_jump_1024_4096',
              description:
                'Direct jump 1,024 m -> 4,096 m -> 1,024 m without intermediate stop',
              waypoints: [
                { target: [0, 0, 0], zoom: 0.18, holdMs: stepMs },
                { target: [0, 0, 0], zoom: 1.6, holdMs: stepMs },
              ],
            });

            // 7. Hysteresis deadband oscillation stability (0 transitions expected)
            await page.evaluate(async () => {
              const h = (window as any).__BENCHMARK_HARNESS__;
              h.setCameraPose([0, 0, 0], 1.2, 45);
              await h.waitForM2aIdle();
            });
            await runSteppedScenario({
              variantSpec,
              foliageEnabled,
              scenarioId: 'hysteresis_deadband_stability',
              description:
                'Oscillate within 1024<->2048 (0.82-0.98) deadband — expect 0 transitions',
              checkZeroTransitions: true,
              waypoints: [
                { target: [0, 0, 0], zoom: 0.84, holdMs: 220 },
                { target: [0, 0, 0], zoom: 0.96, holdMs: 220 },
                { target: [0, 0, 0], zoom: 0.83, holdMs: 220 },
                { target: [0, 0, 0], zoom: 0.97, holdMs: 220 },
              ],
            });

            // 8. Feature picking latency & cross-resolution parity (with Section 8 validity check)
            const ndcGrid: Array<[number, number]> = [
              [0, 0],
              [-0.25, -0.25],
              [0.25, -0.25],
              [-0.25, 0.25],
              [0.25, 0.25],
              [0, 0.3],
              [0, -0.3],
              [0.3, 0],
              [-0.3, 0],
            ];
            const parityByRes: HierarchicalPickingParityResult['resolutions'] = [];
            for (const resMeters of availableResolutionsMeters) {
              const mode: HierarchicalResolutionMode =
                resMeters === 1024
                  ? 'force_1024'
                  : resMeters === 2048
                    ? 'force_2048'
                    : 'force_4096';
              const pickRes = await page.evaluate(
                async ({ m, points }) => {
                  const h = (window as any).__BENCHMARK_HARNESS__;
                  h.setHierarchicalConfig({ mode: m });
                  h.setCameraPose([0, 0, 0], 1.2, 45);
                  await new Promise<void>((r) => requestAnimationFrame(() => r()));
                  await h.waitForM2aIdle();
                  await new Promise<void>((r) => requestAnimationFrame(() => r()));
                  const hd: HierarchicalStreamingDiagnosticsSnapshot =
                    h.getHierarchicalDiagnostics();
                  const res = h.measureFeaturePickRaycast(points, {
                    mode: 'accelerated',
                    scope: 'full_scene',
                    warmupPasses: 1,
                    passes: 3,
                    returnDetails: true,
                  });
                  return { res, hd };
                },
                { m: mode, points: ndcGrid }
              );

              const perRay: Array<{
                featureId?: string | null;
                nearestVisible?: { featureId?: string | null } | null;
              }> = Array.isArray(pickRes.res?.perRayResults)
                ? pickRes.res.perRayResults
                : [];
              const hitFeatureIds = perRay.slice(0, ndcGrid.length).map((d) => {
                const id = d?.nearestVisible?.featureId ?? d?.featureId ?? null;
                return id ? String(id) : null;
              });
              const hitCount =
                typeof pickRes.res?.resolvedFeatureCount === 'number'
                  ? pickRes.res.resolvedFeatureCount
                  : hitFeatureIds.filter(Boolean).length;
              const transitionCompleted =
                pickRes.hd.transitionState === 'idle' &&
                pickRes.hd.activeResolutionMeters === resMeters &&
                pickRes.hd.budgetDeferralReason === null;
              parityByRes.push({
                resolutionMeters: resMeters,
                requestedResolutionMeters: resMeters,
                actualActiveResolutionMeters: pickRes.hd.activeResolutionMeters,
                transitionCompleted,
                budgetDeferralReason: pickRes.hd.budgetDeferralReason,
                medianPickMs: Number(pickRes.res?.medianMs ?? 0),
                p95PickMs: Number(pickRes.res?.p95Ms ?? 0),
                hitCount,
                sampleCount: ndcGrid.length,
                hitFeatureIds,
              });
            }

            const allResolutionsValid = parityByRes.every(
              (r) => r.transitionCompleted
            );
            const baselineIds = parityByRes[0]?.hitFeatureIds ?? [];
            let parityMatchCount = 0;
            for (let i = 0; i < baselineIds.length; i++) {
              const baseId = baselineIds[i];
              const allMatch = parityByRes.every(
                (r) => (r.hitFeatureIds[i] ?? null) === baseId
              );
              if (allMatch) parityMatchCount++;
            }
            pickingParity.push({
              variantRunId: variantSpec.runId,
              foliageEnabled,
              resolutions: parityByRes,
              comparedPointCount: baselineIds.length,
              parityMatchCount,
              parityRatio:
                baselineIds.length > 0
                  ? parityMatchCount / baselineIds.length
                  : 1,
              allResolutionsValid,
            });

            // 9. Auto vs. forced single-resolution modes (Section 8 strict comparison validity guard)
            const comparisonPoses: Array<{
              poseLabel: 'Street' | 'Mid' | 'Regional';
              zoom: number;
            }> = [
              { poseLabel: 'Street', zoom: 1.6 },
              { poseLabel: 'Mid', zoom: 0.55 },
              { poseLabel: 'Regional', zoom: 0.18 },
            ];
            const modesToCompare: HierarchicalResolutionMode[] = [
              'auto',
              ...availableResolutionsMeters.map((r): HierarchicalResolutionMode =>
                r === 1024 ? 'force_1024' : r === 2048 ? 'force_2048' : 'force_4096'
              ),
            ];

            for (const pose of comparisonPoses) {
              for (const mode of modesToCompare) {
                const cmp = await page.evaluate(
                  async ({ m, z, dur }) => {
                    const h = (window as any).__BENCHMARK_HARNESS__;
                    h.setHierarchicalConfig({ mode: m });
                    h.setCameraPose([0, 0, 0], z, 45);
                    await new Promise<void>((r) =>
                      requestAnimationFrame(() => r())
                    );
                    await h.waitForM2aIdle();
                    h.resetStreamingProfiler(`cmp_${m}_${z}`);
                    h.setStreamingProfilerEnabled(true, `cmp_${m}_${z}`);
                    const start = performance.now();
                    await new Promise<void>((resolve) => {
                      const loop = () => {
                        if (performance.now() - start >= dur) {
                          resolve();
                          return;
                        }
                        requestAnimationFrame(loop);
                      };
                      requestAnimationFrame(loop);
                    });
                    const snap: StreamingProfilerSnapshot =
                      h.getStreamingProfilerSnapshot();
                    const hd: HierarchicalStreamingDiagnosticsSnapshot =
                      h.getHierarchicalDiagnostics();
                    h.setStreamingProfilerEnabled(false);
                    return { snap, hd };
                  },
                  { m: mode, z: pose.zoom, dur: modeMeasureMs }
                );

                const requestedResolutionMeters =
                  mode === 'force_1024'
                    ? 1024
                    : mode === 'force_2048'
                      ? 2048
                      : mode === 'force_4096'
                        ? 4096
                        : cmp.hd.desiredResolutionMeters;
                const actualActiveResolutionMeters =
                  cmp.hd.activeResolutionMeters;
                const transitionCompleted =
                  cmp.hd.transitionState === 'idle' &&
                  actualActiveResolutionMeters === requestedResolutionMeters &&
                  cmp.hd.frameBudget.hasValidViewportCoverage;
                const comparisonValid =
                  transitionCompleted && cmp.hd.budgetDeferralReason === null;
                let invalidReason: string | null = null;
                if (!comparisonValid) {
                  if (cmp.hd.budgetDeferralReason) {
                    invalidReason = `budget_deferred: ${cmp.hd.budgetDeferralReason}`;
                  } else if (
                    actualActiveResolutionMeters !== requestedResolutionMeters
                  ) {
                    invalidReason = `resolution_mismatch: requested ${requestedResolutionMeters}m, active ${actualActiveResolutionMeters}m`;
                  } else if (cmp.hd.transitionState !== 'idle') {
                    invalidReason = `transition_incomplete: state=${cmp.hd.transitionState}`;
                  } else {
                    invalidReason = 'invalid_viewport_coverage';
                  }
                }

                const frames = cmp.snap.frames;
                const fd = computeStreamingFrameDistribution(
                  frames.map((f) => f.frameIntervalMs)
                );
                const dc = computeSampleStatistics(
                  frames.map((f) => f.renderCalls)
                );
                const tri = computeSampleStatistics(
                  frames.map((f) => f.renderTriangles)
                );

                modeComparisons.push({
                  variantRunId: variantSpec.runId,
                  foliageEnabled,
                  poseLabel: pose.poseLabel,
                  zoom: pose.zoom,
                  mode,
                  requestedResolutionMeters,
                  actualActiveResolutionMeters,
                  activeResolutionMeters: actualActiveResolutionMeters,
                  transitionState: cmp.hd.transitionState,
                  transitionCompleted,
                  budgetDeferralReason: cmp.hd.budgetDeferralReason,
                  comparisonValid,
                  invalidReason,
                  frameDistribution: fd,
                  medianDrawCalls: dc.median,
                  medianTriangles: tri.median,
                  measuredCpuMiB:
                    cmp.hd.resources.totalMeasuredBytes / (1024 * 1024),
                  estimatedGpuMiB:
                    cmp.hd.resources.totalEstimatedGpuBytes / (1024 * 1024),
                });
              }
            }
          }
        }
      }

      const report: HierarchicalStreamingBenchmarkReport = {
        schemaVersion: '2.0.0-tkt041-f1',
        generatedAtIso: new Date().toISOString(),
        viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        themeId: opts.themeId,
        descriptorPath,
        hierarchyName,
        availableResolutionsMeters,
        cpuMemoryBudgetMiB: opts.cpuMemoryBudgetMiB,
        variantMatrix,
        gpuVendor: gpuInfo.gpuVendor,
        gpuRenderer: gpuInfo.gpuRenderer,
        isSoftwareRenderer: isSoftware,
        softwareRendererWarning: softwareWarning,
        scenarios,
        pickingParity,
        modeComparisons,
      };

      fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
      fs.writeFileSync(
        opts.outputPath,
        JSON.stringify(report, null, 2),
        'utf8'
      );
      fs.mkdirSync(path.dirname(opts.markdownPath), { recursive: true });
      fs.writeFileSync(
        opts.markdownPath,
        formatHierarchicalStreamingMarkdown(report),
        'utf8'
      );

      console.log(
        `[bench:hierarchical] Wrote JSON report -> ${opts.outputPath}`
      );
      console.log(
        `[bench:hierarchical] Wrote Markdown report -> ${opts.markdownPath}`
      );

      return report;
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
    cleanupTempDescriptor?.();
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  const cli = parseHierarchicalBenchmarkCli(process.argv.slice(2));
  runHierarchicalStreamingBenchmark(cli).catch((err) => {
    console.error('[bench:hierarchical] Failed:', err);
    process.exit(1);
  });
}
