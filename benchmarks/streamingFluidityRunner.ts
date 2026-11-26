/**
 * Reproducible Camera Movement & Streaming Frame-Time Profiling Runner (TKT-039)
 *
 * Profiles frame-time distributions (p50/p95/p99/p99.9/max, 144Hz/60Hz/30Hz misses,
 * slow-frame streaks), observed display cadence vs. workload stalls, nested main-thread
 * synchronous stages, bounded tile-streaming lifecycle events, first-render upload
 * proxies, browser LongTasks/LoAFs, real Playwright pointer-drag interaction, and
 * profiler-enabled vs. profiler-disabled overhead across 1,024 m, 2,048 m, and 4,096 m
 * regional mosaics at identical physical EPSG:25832 UTM coordinates.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { computeSampleStatistics } from './stats';
import { resolveChromiumLaunchArgs } from './browserRunner';
import { parseChromiumGpuBackend } from './cliAndServer';
import { isSoftwareWebGLRenderer } from './environment';
import type { ChromiumGpuBackend } from './types';
import { createRegionalMosaicHttpHandler } from '../src/server/tiles/RegionalMosaicHttpHandler';
import { REGIONAL_MIN_ZOOM_QUERY_PARAM } from '../src/scene/cameraZoomPolicy';
import type { BenchmarkFrameTelemetry } from '../src/types/BenchmarkTelemetry';
import type {
  FrameStageProfileSample,
  StreamingLifecycleEvent,
  StreamingProfilerSnapshot,
} from '../src/world/tiling/StreamingProfiler';
import {
  assessObservedRefreshCadence,
  attributeWorstFrames,
  computeStreamingFrameDistribution,
  classifyScenarioCacheBehavior,
  summarizeEventConditionedFrames,
  summarizeStageTimings,
  summarizeWorkerDeliveryMetrics,
  utmToLocalTarget,
  type EventConditionedFrameSummary,
  type FrameSpikeAttributionRecord,
  type ObservedCadenceAssessment,
  type ScenarioCacheClassificationResult,
  type StageTimingSummaryEntry,
  type StreamingFluidityScenarioId,
  type StreamingFrameDistribution,
  type WorkerDeliverySummary,
} from '../src/world/tiling/StreamingFluidityStats';
import {
  TILE_PREPARATION_VARIANT_PRESETS,
  type TilePreparationVariantId,
} from '../src/world/tiling/TilePreparationConfig';

export type StreamingFoliageFilter = 'both' | 'on' | 'off';
export type StreamingPickingFilter = 'accelerated' | 'unaccelerated' | 'both';
export type StreamingScenarioSelector =
  | StreamingFluidityScenarioId
  | 'overhead';

export interface StreamingMosaicInput {
  label: string;
  tileSizeMeters: number;
  indexPath: string;
  apiBaseUrl: string;
}

export interface StreamingFluidityCli {
  mosaics: StreamingMosaicInput[];
  variants: TilePreparationVariantId[];
  foliage: StreamingFoliageFilter;
  picking: StreamingPickingFilter;
  scenarios: StreamingScenarioSelector[];
  targetEasting: number | null;
  targetNorthing: number | null;
  panSpeedMps: number;
  warmPanDistanceMeters: number;
  streamPanDistanceMeters: number | null;
  warmupMs: number;
  measureMs: number;
  runs: number;
  preloadMarginTiles: number;
  retainMarginTiles: number;
  themeId: string;
  requireHardware: boolean;
  gpuBackend: ChromiumGpuBackend;
  traceOutPath: string | null;
  outputPath: string;
  markdownPath: string;
  quick: boolean;
}

const ALL_VARIANTS: readonly TilePreparationVariantId[] = [
  'baseline',
  'transfer_only',
  'compact_transport',
  'worker_bvh',
  'combined',
];

const ALL_SCENARIOS: readonly StreamingScenarioSelector[] = [
  'A_stationary_baseline',
  'B_warm_cache_pan',
  'C_streaming_pan',
  'D_reverse_traversal',
  'E_continuous_zoom',
  'F_teleportation',
  'G_pointer_drag_pan',
  'overhead',
];

function mapScenarioToken(token: string): StreamingScenarioSelector {
  const norm = token.trim().toLowerCase();
  if (norm === 'a' || norm === 'a_stationary_baseline' || norm === 'stationary') {
    return 'A_stationary_baseline';
  }
  if (norm === 'b' || norm === 'b_warm_cache_pan' || norm === 'warm_pan') {
    return 'B_warm_cache_pan';
  }
  if (norm === 'c' || norm === 'c_streaming_pan' || norm === 'streaming_pan') {
    return 'C_streaming_pan';
  }
  if (norm === 'd' || norm === 'd_reverse_traversal' || norm === 'reverse') {
    return 'D_reverse_traversal';
  }
  if (norm === 'e' || norm === 'e_continuous_zoom' || norm === 'zoom') {
    return 'E_continuous_zoom';
  }
  if (norm === 'f' || norm === 'f_teleportation' || norm === 'teleport') {
    return 'F_teleportation';
  }
  if (
    norm === 'g' ||
    norm === 'g_pointer_drag_pan' ||
    norm === 'drag' ||
    norm === 'pointer_drag'
  ) {
    return 'G_pointer_drag_pan';
  }
  if (norm === 'overhead') {
    return 'overhead';
  }
  throw new Error(`Unknown scenario selector "${token}"`);
}

export function parseStreamingFluidityCli(
  argv: readonly string[] = process.argv.slice(2)
): StreamingFluidityCli {
  let index1024: string | null = null;
  let index2048: string | null = null;
  let index4096: string | null = null;

  const opts: StreamingFluidityCli = {
    mosaics: [],
    variants: ['combined'],
    foliage: 'both',
    picking: 'accelerated',
    scenarios: [...ALL_SCENARIOS],
    targetEasting: null,
    targetNorthing: null,
    panSpeedMps: 350,
    warmPanDistanceMeters: 120,
    streamPanDistanceMeters: null,
    warmupMs: 800,
    measureMs: 4000,
    runs: 1,
    preloadMarginTiles: 1,
    retainMarginTiles: 2,
    themeId: 'daylight',
    requireHardware: true,
    gpuBackend: 'auto',
    traceOutPath: null,
    outputPath: path.resolve('benchmarks/results/tkt040-streaming-fluidity.json'),
    markdownPath: path.resolve('benchmarks/results/tkt040-streaming-fluidity.md'),
    quick: false,
  };

  let explicitWarmup = false;
  let explicitMeasure = false;

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

    if (key === 'index-1024') index1024 = path.resolve(val);
    else if (key === 'index-2048') index2048 = path.resolve(val);
    else if (key === 'index-4096') index4096 = path.resolve(val);
    else if (key === 'variant') {
      const norm = val.trim().toLowerCase();
      if (norm === 'all') {
        opts.variants = [...ALL_VARIANTS];
      } else {
        const parsed = norm
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const list: TilePreparationVariantId[] = [];
        for (const token of parsed) {
          if (
            token in TILE_PREPARATION_VARIANT_PRESETS
          ) {
            list.push(token as TilePreparationVariantId);
          } else {
            throw new Error(
              `Invalid --variant token "${token}" (expected baseline|transfer_only|compact_transport|worker_bvh|combined|all)`
            );
          }
        }
        if (list.length === 0) {
          throw new Error('Empty --variant list');
        }
        opts.variants = Array.from(new Set(list));
      }
    } else if (key === 'foliage') {
      if (val !== 'both' && val !== 'on' && val !== 'off') {
        throw new Error(`Invalid --foliage value "${val}" (expected both|on|off)`);
      }
      opts.foliage = val;
    } else if (key === 'picking') {
      if (
        val !== 'accelerated' &&
        val !== 'unaccelerated' &&
        val !== 'both'
      ) {
        throw new Error(
          `Invalid --picking value "${val}" (expected accelerated|unaccelerated|both)`
        );
      }
      opts.picking = val;
    } else if (key === 'scenarios') {
      if (val.trim().toLowerCase() === 'all') {
        opts.scenarios = [...ALL_SCENARIOS];
      } else {
        const list = val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map(mapScenarioToken);
        if (list.length === 0) {
          throw new Error('Empty --scenarios list');
        }
        opts.scenarios = Array.from(new Set(list));
      }
    } else if (key === 'target-easting') opts.targetEasting = Number(val);
    else if (key === 'target-northing') opts.targetNorthing = Number(val);
    else if (key === 'pan-speed-mps') {
      opts.panSpeedMps = Math.max(10, Number(val));
    } else if (key === 'warm-pan-distance-m') {
      opts.warmPanDistanceMeters = Math.max(10, Number(val));
    } else if (key === 'stream-pan-distance-m') {
      opts.streamPanDistanceMeters = Math.max(200, Number(val));
    } else if (key === 'warmup-ms') {
      opts.warmupMs = Math.max(0, Math.floor(Number(val)));
      explicitWarmup = true;
    } else if (key === 'measure-ms') {
      opts.measureMs = Math.max(250, Math.floor(Number(val)));
      explicitMeasure = true;
    } else if (key === 'runs') {
      opts.runs = Math.max(1, Math.floor(Number(val)));
    } else if (key === 'preload-margin-tiles') {
      opts.preloadMarginTiles = Math.max(0, Number(val));
    } else if (key === 'retain-margin-tiles') {
      opts.retainMarginTiles = Math.max(0.5, Number(val));
    } else if (key === 'theme') opts.themeId = val;
    else if (key === 'gpu-backend') {
      opts.gpuBackend = parseChromiumGpuBackend(val);
    } else if (key === 'trace-out') opts.traceOutPath = path.resolve(val);
    else if (key === 'out') opts.outputPath = path.resolve(val);
    else if (key === 'markdown-out') opts.markdownPath = path.resolve(val);
    else throw new Error(`Unknown option --${key}`);
  }

  if (opts.quick) {
    if (!explicitWarmup) opts.warmupMs = 300;
    if (!explicitMeasure) opts.measureMs = 1500;
  }

  if (index1024) {
    opts.mosaics.push({
      label: '1024m',
      tileSizeMeters: 1024,
      indexPath: index1024,
      apiBaseUrl: '/api/tiles-fluid-1024',
    });
  }
  if (index2048) {
    opts.mosaics.push({
      label: '2048m',
      tileSizeMeters: 2048,
      indexPath: index2048,
      apiBaseUrl: '/api/tiles-fluid-2048',
    });
  }
  if (index4096) {
    opts.mosaics.push({
      label: '4096m',
      tileSizeMeters: 4096,
      indexPath: index4096,
      apiBaseUrl: '/api/tiles-fluid-4096',
    });
  }

  if (opts.mosaics.length === 0) {
    throw new Error(
      'Provide at least one mosaic index via --index-1024=<path>, --index-2048=<path>, or --index-4096=<path>'
    );
  }

  return opts;
}

export interface TrajectoryPoseSample {
  target: [number, number, number];
  zoom: number;
  azimuthDeg: number;
}

/**
 * Computes deterministic elapsed-time-based camera poses for Scenarios A-E so
 * trajectories remain consistent across refresh rates (60 Hz / 144 Hz / SwiftShader).
 */
export function buildTrajectoryPoseAtElapsedMs(params: {
  scenarioId: Exclude<
    StreamingFluidityScenarioId,
    'F_teleportation' | 'G_pointer_drag_pan'
  >;
  elapsedMs: number;
  durationMs: number;
  baseTarget: [number, number, number];
  baseZoom: number;
  azimuthDeg: number;
  warmPanDistanceMeters: number;
  streamPanDistanceMeters: number;
  reverseDirection?: 'forward' | 'return';
}): TrajectoryPoseSample {
  const duration = Math.max(1, params.durationMs);
  const t = Math.min(1, Math.max(0, params.elapsedMs / duration));
  const [bx, by, bz] = params.baseTarget;

  if (params.scenarioId === 'A_stationary_baseline') {
    return {
      target: [bx, by, bz],
      zoom: params.baseZoom,
      azimuthDeg: params.azimuthDeg,
    };
  }

  if (params.scenarioId === 'B_warm_cache_pan') {
    // Smooth bidirectional triangle wave strictly inside preloaded margin radius
    const phase = t < 0.5 ? t * 2 : (1 - t) * 2;
    const offset = (phase - 0.5) * 2 * params.warmPanDistanceMeters;
    return {
      target: [bx + offset, by, bz + offset * 0.35],
      zoom: params.baseZoom,
      azimuthDeg: params.azimuthDeg,
    };
  }

  if (params.scenarioId === 'C_streaming_pan') {
    const offset = t * params.streamPanDistanceMeters;
    return {
      target: [bx + offset, by, bz],
      zoom: params.baseZoom,
      azimuthDeg: params.azimuthDeg,
    };
  }

  if (params.scenarioId === 'D_reverse_traversal') {
    const dir = params.reverseDirection ?? 'forward';
    const progress = dir === 'forward' ? t : 1 - t;
    const offset = progress * params.streamPanDistanceMeters;
    return {
      target: [bx + offset, by, bz],
      zoom: params.baseZoom,
      azimuthDeg: params.azimuthDeg,
    };
  }

  // E_continuous_zoom: smooth exponential zoom sweep street <-> regional <-> default
  const minZoom = 0.2;
  const maxZoom = 6.5;
  const wave = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
  const logMin = Math.log(minZoom);
  const logMax = Math.log(maxZoom);
  const zoom = Number(Math.exp(logMin + wave * (logMax - logMin)).toFixed(4));
  return {
    target: [bx, by, bz],
    zoom,
    azimuthDeg: params.azimuthDeg,
  };
}

export interface StreamingMosaicSummary {
  label: string;
  tileSizeMeters: number;
  indexPath: string;
  mosaicName: string;
  snapshotId: string;
  gridCols: number;
  gridRows: number;
  totalTiles: number;
  studyOriginEasting: number;
  studyOriginNorthing: number;
  boundsUtm: {
    minEasting: number;
    maxEasting: number;
    minNorthing: number;
    maxNorthing: number;
  };
  startLocalTarget: [number, number, number];
  streamPanDistanceMeters: number;
  teleportLocalTarget: [number, number, number];
}

export interface StreamingScenarioResult {
  mosaicLabel: string;
  tileSizeMeters: number;
  variant: TilePreparationVariantId;
  foliageEnabled: boolean;
  pickingMode: 'accelerated' | 'unaccelerated';
  scenarioId: StreamingFluidityScenarioId;
  inputPath: 'harness_camera_pose' | 'real_pointer_drag';
  runCount: number;
  durationMs: number;
  panDistanceMeters: number | null;
  droppedFramesCount: number;
  droppedEventsCount: number;
  frameDistribution: StreamingFrameDistribution;
  eventConditionedFrames: EventConditionedFrameSummary;
  workerDeliverySummary: WorkerDeliverySummary;
  cadenceAssessment: ObservedCadenceAssessment;
  cacheClassification: ScenarioCacheClassificationResult;
  stageSummary: StageTimingSummaryEntry[];
  worstFrames: FrameSpikeAttributionRecord[];
  browserObservers: StreamingProfilerSnapshot['browserObservers'];
  gpuStatsSummary: {
    medianDrawCalls: number;
    maxDrawCalls: number;
    medianTriangles: number;
    maxTriangles: number;
    gpuTimerSupported: boolean;
    medianGpuPassMs: number | null;
  };
}

export interface TeleportationScenarioResult {
  mosaicLabel: string;
  tileSizeMeters: number;
  variant: TilePreparationVariantId;
  foliageEnabled: boolean;
  pickingMode: 'accelerated' | 'unaccelerated';
  fromTarget: [number, number, number];
  toTarget: [number, number, number];
  jumpDistanceMeters: number;
  timeToFirstVisibleAttachMs: number | null;
  timeToAllVisibleAttachedMs: number | null;
  timeToIdleMs: number;
  frameDistribution: StreamingFrameDistribution;
  eventConditionedFrames: EventConditionedFrameSummary;
  workerDeliverySummary: WorkerDeliverySummary;
  cacheClassification: ScenarioCacheClassificationResult;
  stageSummary: StageTimingSummaryEntry[];
  worstFrames: FrameSpikeAttributionRecord[];
}

export interface ProfilingOverheadCheckResult {
  mosaicLabel: string;
  tileSizeMeters: number;
  variant: TilePreparationVariantId;
  foliageEnabled: boolean;
  pickingMode: 'accelerated' | 'unaccelerated';
  disabledSampleCount: number;
  enabledSampleCount: number;
  disabledIntervalMedianMs: number;
  enabledIntervalMedianMs: number;
  intervalMedianDeltaMs: number;
  disabledIntervalP95Ms: number;
  enabledIntervalP95Ms: number;
  disabledCpuRenderMedianMs: number;
  enabledCpuRenderMedianMs: number;
  cpuRenderDeltaMs: number;
}

export interface StreamingFluidityBenchmarkReport {
  schemaVersion: string;
  generatedAtIso: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  themeId: string;
  variants: TilePreparationVariantId[];
  targetUtm: { easting: number; northing: number };
  preloadMarginTiles: number;
  retainMarginTiles: number;
  panSpeedMps: number;
  warmPanDistanceMeters: number;
  warmupMs: number;
  measureMs: number;
  runsPerScenario: number;
  gpuVendor: string;
  gpuRenderer: string;
  isSoftwareRenderer: boolean;
  softwareRendererWarning: string | null;
  traceOutPath: string | null;
  mosaics: StreamingMosaicSummary[];
  interactiveResults: StreamingScenarioResult[];
  teleportationResults: TeleportationScenarioResult[];
  overheadChecks: ProfilingOverheadCheckResult[];
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

async function startMultiMosaicServer(
  mosaics: readonly StreamingMosaicInput[]
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = express();
  const handlers: Array<{ close: () => void }> = [];

  for (const m of mosaics) {
    const handler = createRegionalMosaicHttpHandler({ indexPath: m.indexPath });
    handlers.push(handler);
    app.get(`${m.apiBaseUrl}/manifest`, (req, res) => {
      void handler.manifestHandler(req, res);
    });
    app.get(`${m.apiBaseUrl}/:lod/:tx/:ty`, (req, res) => {
      void handler.tilePayloadHandler(req, res);
    });
    app.get(
      `${m.apiBaseUrl}/:snapshotId/:schemaVersion/:lod/:tx/:ty`,
      (req, res) => {
        void handler.tilePayloadHandler(req, res);
      }
    );
  }

  const defaultHandler = createRegionalMosaicHttpHandler({
    indexPath: mosaics[0].indexPath,
  });
  handlers.push(defaultHandler);
  app.get('/api/tiles-region/manifest', (req, res) => {
    void defaultHandler.manifestHandler(req, res);
  });
  app.get('/api/tiles-region/:lod/:tx/:ty', (req, res) => {
    void defaultHandler.tilePayloadHandler(req, res);
  });
  app.get(
    '/api/tiles-region/:snapshotId/:schemaVersion/:lod/:tx/:ty',
    (req, res) => {
      void defaultHandler.tilePayloadHandler(req, res);
    }
  );

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
    throw new Error('Failed to bind ephemeral streaming benchmark port');
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      for (const h of handlers) {
        try {
          h.close();
        } catch {
          // ignore
        }
      }
      await vite.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function summarizeScenarioSnapshot(params: {
  mosaicLabel: string;
  tileSizeMeters: number;
  variant: TilePreparationVariantId;
  foliageEnabled: boolean;
  pickingMode: 'accelerated' | 'unaccelerated';
  scenarioId: StreamingFluidityScenarioId;
  inputPath: 'harness_camera_pose' | 'real_pointer_drag';
  runCount: number;
  durationMs: number;
  panDistanceMeters: number | null;
  snapshot: StreamingProfilerSnapshot;
  isSoftwareRenderer: boolean;
  stationaryReferenceMedianMs?: number;
  forwardEvents?: StreamingLifecycleEvent[];
  reverseEvents?: StreamingLifecycleEvent[];
  initiallyResidentTileKeys?: string[];
}): StreamingScenarioResult {
  const frames = params.snapshot.frames;
  const intervals = frames.map((f) => f.frameIntervalMs);
  const frameDistribution = computeStreamingFrameDistribution(intervals);
  const eventConditionedFrames = summarizeEventConditionedFrames(frames);
  const workerDeliverySummary = summarizeWorkerDeliveryMetrics(
    params.snapshot.events,
    frames
  );
  const cadenceAssessment = assessObservedRefreshCadence({
    frameIntervalsMs: intervals,
    cpuRenderMs: frames.map((f) => f.glRenderCpuMs),
    syncMainThreadMs: frames.map((f) => f.attributedSyncMainThreadMs),
    isSoftwareRenderer: params.isSoftwareRenderer,
    stationaryReferenceMedianMs: params.stationaryReferenceMedianMs,
  });

  const cacheClassification = classifyScenarioCacheBehavior({
    scenarioId: params.scenarioId,
    events: params.snapshot.events,
    forwardEvents: params.forwardEvents,
    reverseEvents: params.reverseEvents,
    initiallyResidentTileKeys: params.initiallyResidentTileKeys,
  });

  const stageSummary = summarizeStageTimings(frames);
  const worstFrames = attributeWorstFrames({
    frames,
    events: params.snapshot.events,
    longTasks: params.snapshot.longTasks,
    loafs: params.snapshot.loafs,
    topN: 12,
  });

  const drawCallStats = computeSampleStatistics(frames.map((f) => f.renderCalls));
  const triStats = computeSampleStatistics(frames.map((f) => f.renderTriangles));
  const gpuSamples = frames
    .map((f) => f.gpuPassTimeMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const gpuSupported = frames.some((f) => f.gpuTimerQuerySupported);

  return {
    mosaicLabel: params.mosaicLabel,
    tileSizeMeters: params.tileSizeMeters,
    variant: params.variant,
    foliageEnabled: params.foliageEnabled,
    pickingMode: params.pickingMode,
    scenarioId: params.scenarioId,
    inputPath: params.inputPath,
    runCount: params.runCount,
    durationMs: params.durationMs,
    panDistanceMeters: params.panDistanceMeters,
    droppedFramesCount: params.snapshot.droppedFramesCount,
    droppedEventsCount: params.snapshot.droppedEventsCount,
    frameDistribution,
    eventConditionedFrames,
    workerDeliverySummary,
    cadenceAssessment,
    cacheClassification,
    stageSummary,
    worstFrames,
    browserObservers: params.snapshot.browserObservers,
    gpuStatsSummary: {
      medianDrawCalls: drawCallStats.median,
      maxDrawCalls: drawCallStats.max,
      medianTriangles: triStats.median,
      maxTriangles: triStats.max,
      gpuTimerSupported: gpuSupported,
      medianGpuPassMs:
        gpuSamples.length > 0
          ? computeSampleStatistics(gpuSamples).median
          : null,
    },
  };
}

export function formatStreamingFluidityMarkdown(
  report: StreamingFluidityBenchmarkReport
): string {
  const lines: string[] = [
    '# TKT-040 Non-blocking Tile Preparation & Streaming Frame-Time Report',
    '',
    `- **Generated:** ${report.generatedAtIso}`,
    `- **Viewport:** ${report.viewport.width} × ${report.viewport.height} @ DPR ${report.viewport.deviceScaleFactor} | **Theme:** \`${report.themeId}\``,
    `- **Tile Preparation Variants:** ${report.variants.map((v) => `\`${v}\``).join(', ')}`,
    `- **Shared Physical UTM Reference:** E ${report.targetUtm.easting.toFixed(1)} m, N ${report.targetUtm.northing.toFixed(1)} m`,
    `- **Streaming Policy:** \`preloadMarginTiles=${report.preloadMarginTiles}\`, \`retainMarginTiles=${report.retainMarginTiles}\`, \`panSpeed=${report.panSpeedMps} m/s\`, \`warmPan=${report.warmPanDistanceMeters} m\``,
    `- **WebGL Renderer:** \`${report.gpuRenderer}\` (${report.gpuVendor})`,
    `- **Renderer Classification:** ${
      report.isSoftwareRenderer
        ? '**SOFTWARE RASTERIZER (SwiftShader — frame intervals & gl.render CPU times reflect software rasterization, NOT RTX hardware GPU performance)**'
        : 'Hardware WebGL2 GPU'
    }`,
    '',
  ];

  if (report.softwareRendererWarning) {
    lines.push(`> **Warning:** ${report.softwareRendererWarning}`, '');
  }

  lines.push(
    '## Mosaic Configurations',
    '',
    '| Label | Tile Size | Grid | Tiles | Study Origin (E, N) | Start Local Target (x, z) | Streaming Pan Distance |',
    '|---|---:|---|---:|---|---|---:|'
  );
  for (const m of report.mosaics) {
    lines.push(
      `| ${m.label} | ${m.tileSizeMeters} m | ${m.gridCols}×${m.gridRows} | ${m.totalTiles} | (${m.studyOriginEasting.toFixed(1)}, ${m.studyOriginNorthing.toFixed(1)}) | (${m.startLocalTarget[0].toFixed(1)}, ${m.startLocalTarget[2].toFixed(1)}) | ${m.streamPanDistanceMeters.toFixed(0)} m |`
    );
  }
  lines.push('');

  if (report.variants.length > 1 && report.interactiveResults.length > 0) {
    lines.push(
      '## Variant Comparison Summary (TKT-040 A/B Evaluation)',
      '',
      '| Mosaic | Foliage | Scenario | Variant | med / p95 / p99 / p99.9 / max (ms) | >6.94ms (144Hz) | >16.67ms | OnMsg Max (ms) | Recon Max (ms) | InstBVH Build / Adopt Max (ms) | Worker BVH Adopt / Fallback | Delivery-Frame p95 / max (ms) | Recon-Frame p95 / max (ms) | Throughput (tiles/s) |',
      '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
    );
    for (const r of report.interactiveResults) {
      const d = r.frameDistribution;
      const ex6 = d.thresholdExceedances[0];
      const ex16 = d.thresholdExceedances[2];
      const byId = new Map(r.stageSummary.map((s) => [s.stageKey, s]));
      const onMsgMax = byId.get('workerOnMessageMs')?.stats.max ?? 0;
      const reconMax = byId.get('reconstructMs')?.stats.max ?? 0;
      const bvhBuildMax = byId.get('instancedBvhBuildMs')?.stats.max ?? 0;
      const bvhAdoptMax = byId.get('instancedBvhAdoptMs')?.stats.max ?? 0;
      const wd = r.workerDeliverySummary;
      const ec = r.eventConditionedFrames;
      lines.push(
        `| ${r.mosaicLabel} | ${r.foliageEnabled ? 'ON' : 'OFF'} | \`${r.scenarioId}\` | \`${r.variant}\` | ${d.median.toFixed(2)} / ${d.p95.toFixed(2)} / ${d.p99.toFixed(2)} / ${d.p999.toFixed(2)} / ${d.max.toFixed(2)} | ${ex6?.count ?? 0} (${(ex6?.pct ?? 0).toFixed(1)}%) | ${ex16?.count ?? 0} | ${onMsgMax.toFixed(2)} | ${reconMax.toFixed(2)} | ${bvhBuildMax.toFixed(2)} / ${bvhAdoptMax.toFixed(2)} | ${wd.workerBvhAdoptedTotal} / ${wd.syncBvhFallbackTotal} | ${ec.workerDeliveryFrames.p95.toFixed(2)} / ${ec.workerDeliveryFrames.max.toFixed(2)} | ${ec.tileCommitFrames.p95.toFixed(2)} / ${ec.tileCommitFrames.max.toFixed(2)} | ${wd.tilesPerSecond.toFixed(2)} |`
      );
    }
    lines.push('');
  }

  if (report.overheadChecks.length > 0) {
    lines.push(
      '## Profiling Overhead Check (`profiler=false` vs. `profiler=true`)',
      '',
      '| Mosaic | Variant | Foliage | Picking | Disabled Samples | Enabled Samples | Disabled med / p95 (ms) | Enabled med / p95 (ms) | Interval Median Δ | CPU Render med (Off → On) |',
      '|---|---|---|---|---:|---:|---:|---:|---:|---:|'
    );
    for (const ov of report.overheadChecks) {
      lines.push(
        `| ${ov.mosaicLabel} | \`${ov.variant}\` | ${ov.foliageEnabled ? 'ON' : 'OFF'} | ${ov.pickingMode} | ${ov.disabledSampleCount} | ${ov.enabledSampleCount} | ${ov.disabledIntervalMedianMs.toFixed(2)} / ${ov.disabledIntervalP95Ms.toFixed(2)} | ${ov.enabledIntervalMedianMs.toFixed(2)} / ${ov.enabledIntervalP95Ms.toFixed(2)} | ${ov.intervalMedianDeltaMs >= 0 ? '+' : ''}${ov.intervalMedianDeltaMs.toFixed(2)} ms | ${ov.disabledCpuRenderMedianMs.toFixed(2)} → ${ov.enabledCpuRenderMedianMs.toFixed(2)} ms (${ov.cpuRenderDeltaMs >= 0 ? '+' : ''}${ov.cpuRenderDeltaMs.toFixed(2)} ms) |`
      );
    }
    lines.push('');
  }

  if (report.interactiveResults.length > 0) {
    lines.push(
      '## Interactive Camera & Streaming Scenarios (Scenarios A–E & G; Teleportation Isolated Below)',
      '',
      '| Mosaic | Variant | Foliage | Picking | Scenario | Input Path | N | med / p95 / p99 / p99.9 / max (ms) | >6.94ms (144Hz) | >16.67ms (60Hz) | >33.33ms / >50ms | Max Streak (>16.67ms) | Cadence Class | Cache Verification (Fetch/Recon/Attach/Evict) |',
      '|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|'
    );
    for (const r of report.interactiveResults) {
      const d = r.frameDistribution;
      const ex6 = d.thresholdExceedances[0];
      const ex16 = d.thresholdExceedances[2];
      const ex33 = d.thresholdExceedances[3];
      const ex50 = d.thresholdExceedances[4];
      const ev = r.cacheClassification.eventCounts;
      lines.push(
        `| ${r.mosaicLabel} | \`${r.variant}\` | ${r.foliageEnabled ? 'ON' : 'OFF'} | ${r.pickingMode} | \`${r.scenarioId}\` | \`${r.inputPath}\` | ${d.sampleCount} | ${d.median.toFixed(2)} / ${d.p95.toFixed(2)} / ${d.p99.toFixed(2)} / ${d.p999.toFixed(2)} / ${d.max.toFixed(2)} | ${ex6?.count ?? 0} (${(ex6?.pct ?? 0).toFixed(1)}%) | ${ex16?.count ?? 0} (${(ex16?.pct ?? 0).toFixed(1)}%) | ${ex33?.count ?? 0} / ${ex50?.count ?? 0} | ${ex16?.maxConsecutiveFrames ?? 0} | \`${r.cadenceAssessment.classification}\` | \`${r.cacheClassification.classification}\` (${ev.fetchStart}/${ev.reconstructComplete}/${ev.attach}/${ev.evict}) |`
      );
    }
    lines.push('');
  }

  // Detail top stage breakdown & top spike attributions for streaming / reverse / drag scenarios
  const focusScenarios = report.interactiveResults.filter(
    (r) =>
      r.scenarioId === 'C_streaming_pan' ||
      r.scenarioId === 'D_reverse_traversal' ||
      r.scenarioId === 'G_pointer_drag_pan' ||
      r.scenarioId === 'B_warm_cache_pan'
  );
  if (focusScenarios.length > 0) {
    lines.push('## Stage Breakdown, Worker Delivery & Worst-Frame Attribution (Focus Scenarios)', '');
    for (const r of focusScenarios) {
      const wd = r.workerDeliverySummary;
      const ec = r.eventConditionedFrames;
      lines.push(
        `### ${r.mosaicLabel} | \`${r.variant}\` | Foliage ${r.foliageEnabled ? 'ON' : 'OFF'} | ${r.pickingMode} | \`${r.scenarioId}\``,
        '',
        `- **Cadence Note:** ${r.cadenceAssessment.explanation}`,
        `- **Cache / Streaming Verification:** ${r.cacheClassification.reason}`,
        `- **Worker Delivery & Prep:** deliveries=${wd.deliveryCount}, compact=${wd.usedCompactTransportCount}, transferred=${(wd.transferableBytesTotal / (1024 * 1024)).toFixed(2)} MB (mean ${wd.transferableBufferCountMean} buffers/tile), workerDecode med/max=${wd.workerInflateAndDecodeMs.median.toFixed(2)}/${wd.workerInflateAndDecodeMs.max.toFixed(2)} ms, workerBVH med/max=${wd.workerBvhBuildMs.median.toFixed(2)}/${wd.workerBvhBuildMs.max.toFixed(2)} ms, deliveryLatency med/max=${wd.messageDeliveryLatencyMs.median.toFixed(2)}/${wd.messageDeliveryLatencyMs.max.toFixed(2)} ms, mainOnMsg med/max=${wd.mainOnMessageHandlerMs.median.toFixed(2)}/${wd.mainOnMessageHandlerMs.max.toFixed(2)} ms, workerBVH adopted=${wd.workerBvhAdoptedTotal}, syncFallback=${wd.syncBvhFallbackTotal}, readiness med=${wd.tileReadinessLatencyMs.median.toFixed(1)} ms, throughput=${wd.tilesPerSecond.toFixed(2)} tiles/s`,
        `- **Event-Conditioned Frames (med / p95 / max ms):** quiet(n=${ec.quietFrames.sampleCount})=${ec.quietFrames.median.toFixed(2)}/${ec.quietFrames.p95.toFixed(2)}/${ec.quietFrames.max.toFixed(2)}, delivery(n=${ec.workerDeliveryFrames.sampleCount})=${ec.workerDeliveryFrames.median.toFixed(2)}/${ec.workerDeliveryFrames.p95.toFixed(2)}/${ec.workerDeliveryFrames.max.toFixed(2)}, commit(n=${ec.tileCommitFrames.sampleCount})=${ec.tileCommitFrames.median.toFixed(2)}/${ec.tileCommitFrames.p95.toFixed(2)}/${ec.tileCommitFrames.max.toFixed(2)}, activeStreaming(n=${ec.activeStreamingWorkFrames.sampleCount})=${ec.activeStreamingWorkFrames.median.toFixed(2)}/${ec.activeStreamingWorkFrames.p95.toFixed(2)}/${ec.activeStreamingWorkFrames.max.toFixed(2)}`
      );
      if (r.cacheClassification.reverseReuseSummary) {
        const rev = r.cacheClassification.reverseReuseSummary;
        lines.push(
          `- **Reverse Traversal Reuse:** forward attached=${rev.forwardAttachedTiles}, evicted=${rev.forwardEvictedTiles}, resident at turnaround=${rev.reverseReusedLoadedTiles}, return refetched=${rev.reverseRefetchedTiles}, estimated reuse hit rate=${rev.reverseReuseHitRatePct !== null ? `${rev.reverseReuseHitRatePct}%` : 'n/a'}`
        );
      }
      lines.push(
        `- **Browser Observers:** LongTasks=${r.browserObservers.longTaskCount} (supported=${r.browserObservers.longTaskSupported}), LoAFs=${r.browserObservers.loafCount} (supported=${r.browserObservers.loafSupported}), droppedFrames=${r.droppedFramesCount}, droppedEvents=${r.droppedEventsCount}`,
        '',
        '| Synchronous Stage | Median (ms) | p95 (ms) | p99 (ms) | Max (ms) | Cumulative (ms) |',
        '|---|---:|---:|---:|---:|---:|'
      );
      for (const s of r.stageSummary) {
        if (s.totalMs <= 0 && s.nestingLevel !== 'top_level') continue;
        lines.push(
          `| ${s.label} | ${s.stats.median.toFixed(3)} | ${s.stats.p95.toFixed(3)} | ${s.stats.p99.toFixed(3)} | ${s.stats.max.toFixed(3)} | ${s.totalMs.toFixed(2)} |`
        );
      }
      if (r.worstFrames.length > 0) {
        lines.push(
          '',
          '| Rank | Frame | Interval (ms) | Sync Sum (ms) | Unattributed (ms) | Primary Suspect | Key Stage Drivers & Proxy Details |',
          '|---:|---:|---:|---:|---:|---|---|'
        );
        for (const w of r.worstFrames.slice(0, 6)) {
          lines.push(
            `| #${w.rank} | ${w.frameIndex} | ${w.frameIntervalMs.toFixed(2)} | ${w.attributedSyncMainThreadMs.toFixed(2)} | ${w.unattributedMs.toFixed(2)} | \`${w.primarySuspect}\` | ${w.suspectRationale} |`
          );
        }
      }
      lines.push('');
    }
  }

  if (report.teleportationResults.length > 0) {
    lines.push(
      '## Scenario F — Teleportation (Isolated Cold Jump Latency)',
      '',
      '| Mosaic | Variant | Foliage | Picking | Jump (m) | First Visible Attach (ms) | All Visible Attached (ms) | Time To Idle (ms) | Worst Frame (ms) | Fetches / Recon / Attach / Evict |',
      '|---|---|---|---|---:|---:|---:|---:|---:|---:|'
    );
    for (const tp of report.teleportationResults) {
      const ev = tp.cacheClassification.eventCounts;
      lines.push(
        `| ${tp.mosaicLabel} | \`${tp.variant}\` | ${tp.foliageEnabled ? 'ON' : 'OFF'} | ${tp.pickingMode} | ${tp.jumpDistanceMeters.toFixed(0)} | ${tp.timeToFirstVisibleAttachMs !== null ? tp.timeToFirstVisibleAttachMs.toFixed(1) : 'n/a'} | ${tp.timeToAllVisibleAttachedMs !== null ? tp.timeToAllVisibleAttachedMs.toFixed(1) : 'n/a'} | ${tp.timeToIdleMs.toFixed(1)} | ${tp.frameDistribution.max.toFixed(2)} | ${ev.fetchStart} / ${ev.reconstructComplete} / ${ev.attach} / ${ev.evict} |`
      );
    }
    lines.push('');
  }

  lines.push(
    '## Methodological Caveats & Chrome DevTools Trace Capture',
    '',
    '1. **Frame-Interval Alignment (TKT-040 Fix):** Frame intervals are measured post-render to post-render (`[intervalStartMs, intervalEndMs]`), ensuring inter-frame callbacks (`Worker.onmessage`, promise continuations, React commits), `useFrame` work, and `gl.render()` land on the exact affected frame `N` rather than shifting to `N+1`.',
    '2. **`gl.render()` Driver Sync Caveat:** `glRenderCpuMs` measures synchronous CPU wall-clock around `WebGLRenderer.render()`, which can include ANGLE/driver command-buffer flushing or first-use GPU buffer/shader uploads rather than pure GPU execution time.',
    '3. **First-Render Upload Proxy:** `first_rendered_use` and `driverGeometriesDelta` record which newly attached tiles entered their first `gl.render()` pass and how many WebGL buffer objects changed. They are **correlative proxies**, not direct GPU upload timers.',
    '4. **VSync Cadence vs. 144 Hz Target:** Desktop browsers typically pace `requestAnimationFrame` at monitor refresh (e.g., 60 Hz ≈ 16.67 ms or 144 Hz ≈ 6.94 ms); stationary intervals matching monitor cadence reflect display sync, while `>6.94 ms` tracking evaluates against the 144 Hz target independently.',
    '5. **Chrome DevTools Performance Trace:** Pass `--trace-out=benchmarks/results/tkt040-trace.json` to capture a full Chrome DevTools Performance trace via CDP (`Tracing.start`/`Tracing.end`) during `C_streaming_pan`.',
    ''
  );

  return lines.join('\n');
}

export async function runStreamingFluidityBenchmark(
  opts: StreamingFluidityCli
): Promise<StreamingFluidityBenchmarkReport> {
  let playwright: any;
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error(
      'Playwright is required to run benchmarks/streamingFluidityRunner.ts'
    );
  }

  const server = await startMultiMosaicServer(opts.mosaics);

  try {
    const manifests = new Map<string, any>();
    for (const m of opts.mosaics) {
      const resp = await fetch(`${server.baseUrl}${m.apiBaseUrl}/manifest`);
      if (!resp.ok) {
        throw new Error(
          `Failed to fetch manifest for ${m.label}: HTTP ${resp.status}`
        );
      }
      manifests.set(m.label, await resp.json());
    }

    const baseMosaic =
      opts.mosaics.find((m) => m.tileSizeMeters === 1024) ?? opts.mosaics[0];
    const baseManifest = manifests.get(baseMosaic.label);
    const targetEasting =
      opts.targetEasting ?? Number(baseManifest.metadata.studyOriginEasting);
    const targetNorthing =
      opts.targetNorthing ?? Number(baseManifest.metadata.studyOriginNorthing);

    const mosaicSummaries: StreamingMosaicSummary[] = opts.mosaics.map((m) => {
      const man = manifests.get(m.label);
      const meta = man.metadata;
      const tiles: Array<{
        minEasting: number;
        maxEasting: number;
        minNorthing: number;
        maxNorthing: number;
      }> = man.tiles;
      let minE = Number.POSITIVE_INFINITY;
      let maxE = Number.NEGATIVE_INFINITY;
      let minN = Number.POSITIVE_INFINITY;
      let maxN = Number.NEGATIVE_INFINITY;
      for (const t of tiles) {
        if (t.minEasting < minE) minE = t.minEasting;
        if (t.maxEasting > maxE) maxE = t.maxEasting;
        if (t.minNorthing < minN) minN = t.minNorthing;
        if (t.maxNorthing > maxN) maxN = t.maxNorthing;
      }

      const startLocalTarget = utmToLocalTarget(
        targetEasting,
        targetNorthing,
        meta.studyOriginEasting,
        meta.studyOriginNorthing
      );

      // Derive safe streaming pan distance along +X that stays within mosaic bounds while
      // forcing multiple tile boundary crossings & evictions where grid extent allows.
      const eastRemaining = Math.max(0, maxE - targetEasting);
      const westRemaining = Math.max(0, targetEasting - minE);
      const usableEast = Math.max(eastRemaining, westRemaining) - m.tileSizeMeters * 0.25;
      const desiredStreamPan =
        opts.streamPanDistanceMeters ??
        Math.max(m.tileSizeMeters * (opts.preloadMarginTiles + 2.25), 3500);
      const streamPanDistanceMeters = Math.max(
        m.tileSizeMeters * 1.25,
        Math.min(desiredStreamPan, Math.max(m.tileSizeMeters * 1.25, usableEast))
      );

      // Start near western edge when mosaic doesn't extend far enough east of center
      let panStartLocalX = startLocalTarget[0];
      if (eastRemaining < streamPanDistanceMeters + m.tileSizeMeters * 0.25) {
        const minLocalX = minE - meta.studyOriginEasting + m.tileSizeMeters * 0.4;
        const maxLocalX = maxE - meta.studyOriginEasting - m.tileSizeMeters * 0.4;
        if (maxLocalX - minLocalX > m.tileSizeMeters * 1.5) {
          panStartLocalX = minLocalX;
        }
      }

      const teleportUtmE =
        targetEasting <= (minE + maxE) * 0.5
          ? maxE - m.tileSizeMeters * 0.5
          : minE + m.tileSizeMeters * 0.5;
      const teleportUtmN =
        targetNorthing <= (minN + maxN) * 0.5
          ? maxN - m.tileSizeMeters * 0.5
          : minN + m.tileSizeMeters * 0.5;
      const teleportLocalTarget = utmToLocalTarget(
        teleportUtmE,
        teleportUtmN,
        meta.studyOriginEasting,
        meta.studyOriginNorthing
      );

      return {
        label: m.label,
        tileSizeMeters: meta.tileSizeMeters,
        indexPath: m.indexPath,
        mosaicName:
          man.activeMosaicName ?? path.basename(path.dirname(m.indexPath)),
        snapshotId: meta.snapshotId,
        gridCols: meta.gridCols,
        gridRows: meta.gridRows,
        totalTiles: tiles.length,
        studyOriginEasting: meta.studyOriginEasting,
        studyOriginNorthing: meta.studyOriginNorthing,
        boundsUtm: {
          minEasting: minE,
          maxEasting: maxE,
          minNorthing: minN,
          maxNorthing: maxN,
        },
        startLocalTarget: [panStartLocalX, 0, startLocalTarget[2]],
        streamPanDistanceMeters,
        teleportLocalTarget,
      };
    });

    const executablePath = resolveChromiumExecutablePath();
    const browser = await playwright.chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: resolveChromiumLaunchArgs({
        useSwiftShader: !opts.requireHardware && opts.gpuBackend === 'auto' ? false : undefined,
        gpuBackend: opts.gpuBackend,
      }),
    });

    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
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
              (window as any).__BENCHMARK_HARNESS__?.setStreamingProfilerEnabled &&
              document.querySelector('canvas')
          ),
        { timeout: 60000 }
      );

      const gpuInfo = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
        if (!gl) {
          throw new Error(
            'Streaming fluidity benchmark requires an active WebGL2 canvas'
          );
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
          `Detected software/unverified WebGL renderer "${gpuInfo.gpuRenderer}". Re-run on hardware GPU or pass --allow-software for deterministic synthetic pipeline verification.`
        );
      }

      const softwareWarning = isSoftware
        ? `Executed on software WebGL renderer (${gpuInfo.gpuRenderer}). Event sequences, stage attribution pipeline, and cache checks are valid, but frame intervals and CPU render timings reflect software rasterization rather than hardware GPU.`
        : null;

      const foliageConfigs: boolean[] =
        opts.foliage === 'both'
          ? [true, false]
          : opts.foliage === 'on'
            ? [true]
            : [false];
      const pickingModes: Array<'accelerated' | 'unaccelerated'> =
        opts.picking === 'both'
          ? ['accelerated', 'unaccelerated']
          : [opts.picking];

      const interactiveResults: StreamingScenarioResult[] = [];
      const teleportationResults: TeleportationScenarioResult[] = [];
      const overheadChecks: ProfilingOverheadCheckResult[] = [];
      let traceCaptured = false;

      const runTrajectoryInPage = async (params: {
        scenarioId: Exclude<
          StreamingFluidityScenarioId,
          'F_teleportation' | 'G_pointer_drag_pan'
        >;
        durationMs: number;
        baseTarget: [number, number, number];
        baseZoom: number;
        azimuthDeg: number;
        warmPanDistanceMeters: number;
        streamPanDistanceMeters: number;
        reverseDirection?: 'forward' | 'return';
      }) => {
        await page.evaluate(async (p) => {
          const h = (window as any).__BENCHMARK_HARNESS__;
          const start = performance.now();
          await new Promise<void>((resolve) => {
            const step = () => {
              const elapsed = performance.now() - start;
              const t = Math.min(1, Math.max(0, elapsed / Math.max(1, p.durationMs)));
              const [bx, by, bz] = p.baseTarget;
              let tx = bx;
              let tz = bz;
              let zoom = p.baseZoom;

              if (p.scenarioId === 'B_warm_cache_pan') {
                const phase = t < 0.5 ? t * 2 : (1 - t) * 2;
                const offset = (phase - 0.5) * 2 * p.warmPanDistanceMeters;
                tx = bx + offset;
                tz = bz + offset * 0.35;
              } else if (p.scenarioId === 'C_streaming_pan') {
                tx = bx + t * p.streamPanDistanceMeters;
              } else if (p.scenarioId === 'D_reverse_traversal') {
                const prog = p.reverseDirection === 'return' ? 1 - t : t;
                tx = bx + prog * p.streamPanDistanceMeters;
              } else if (p.scenarioId === 'E_continuous_zoom') {
                const wave = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
                const logMin = Math.log(0.2);
                const logMax = Math.log(6.5);
                zoom = Number(
                  Math.exp(logMin + wave * (logMax - logMin)).toFixed(4)
                );
              }

              h.setCameraPose([tx, by, tz], zoom, p.azimuthDeg);
              if (elapsed >= p.durationMs) {
                resolve();
                return;
              }
              requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          });
        }, params);
      };

      const resetPoseAndSettle = async (
        target: [number, number, number],
        zoom = 1.2,
        azimuthDeg = 45
      ) => {
        await page.evaluate(
          async ({ t, z, az }) => {
            const h = (window as any).__BENCHMARK_HARNESS__;
            h.setStreamingProfilerEnabled(false);
            h.setCameraPose(t, z, az);
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            await h.waitForM2aIdle();
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
          },
          { t: target, z: zoom, az: azimuthDeg }
        );
      };

      for (const summary of mosaicSummaries) {
        const mosaicInput = opts.mosaics.find((m) => m.label === summary.label)!;
        const centerTarget = utmToLocalTarget(
          targetEasting,
          targetNorthing,
          summary.studyOriginEasting,
          summary.studyOriginNorthing
        );

        for (const variant of opts.variants) {
          console.log(
            `[bench:streaming-fluidity] Loading ${summary.label} (${summary.tileSizeMeters} m, ${summary.gridCols}×${summary.gridRows}) [variant=${variant}]...`
          );

          await page.evaluate(
            async ({
              apiBaseUrl,
              themeId,
              target,
              preloadMarginTiles,
              retainMarginTiles,
              tilePreparationOptions,
            }) => {
              const h = (window as any).__BENCHMARK_HARNESS__;
              h.setStreamingProfilerEnabled(false);
              await h.unloadDataset?.();
              await h.loadM2aStreaming({
                apiBaseUrl,
                preloadMarginTiles,
                retainMarginTiles,
                themeId,
                target,
                zoom: 1.2,
                azimuthDeg: 45,
                regionalMinZoom: 0.15,
                tilePreparationOptions,
                waitForIdle: true,
                timeoutMs: 120000,
              });
            },
            {
              apiBaseUrl: mosaicInput.apiBaseUrl,
              themeId: opts.themeId,
              target: centerTarget,
              preloadMarginTiles: opts.preloadMarginTiles,
              retainMarginTiles: opts.retainMarginTiles,
              tilePreparationOptions: variant,
            }
          );

        for (const foliageEnabled of foliageConfigs) {
          for (const pickingMode of pickingModes) {
            await page.evaluate(
              async ({ visible, mode }) => {
                const h = (window as any).__BENCHMARK_HARNESS__;
                h.setShowFoliage(visible);
                if (visible) {
                  h.setFoliageOptimizationConfig({
                    enabled: true,
                    lodMode: 'auto',
                    trunkSuppressionEnabled: true,
                    frustumCullingEnabled: true,
                  });
                }
                h.setInstancedPickingMode(mode);
                await new Promise<void>((r) => requestAnimationFrame(() => r()));
                await new Promise<void>((r) => requestAnimationFrame(() => r()));
              },
              { visible: foliageEnabled, mode: pickingMode }
            );

            let stationaryMedianRef: number | undefined;

            // 1. Profiling Overhead Check
            if (opts.scenarios.includes('overhead')) {
              await resetPoseAndSettle(centerTarget, 1.2, 45);
              const overheadDurationMs = Math.min(2000, opts.measureMs);

              const disabledSamples = await page.evaluate(
                async ({ durationMs, baseTarget, warmPanDistanceMeters }) => {
                  const h = (window as any).__BENCHMARK_HARNESS__;
                  h.setStreamingProfilerEnabled(false);
                  const collected: BenchmarkFrameTelemetry[] = [];
                  (window as any).__BENCHMARK_ACTIVE__ = true;
                  (window as any).__BENCHMARK_FRAME_COLLECTOR__ = (
                    t: BenchmarkFrameTelemetry
                  ) => {
                    collected.push(t);
                  };
                  const start = performance.now();
                  await new Promise<void>((resolve) => {
                    const step = () => {
                      const elapsed = performance.now() - start;
                      const prog = Math.min(1, elapsed / Math.max(1, durationMs));
                      const phase = prog < 0.5 ? prog * 2 : (1 - prog) * 2;
                      const off = (phase - 0.5) * 2 * warmPanDistanceMeters;
                      h.setCameraPose(
                        [baseTarget[0] + off, 0, baseTarget[2]],
                        1.2,
                        45
                      );
                      if (elapsed >= durationMs) {
                        resolve();
                        return;
                      }
                      requestAnimationFrame(step);
                    };
                    requestAnimationFrame(step);
                  });
                  delete (window as any).__BENCHMARK_FRAME_COLLECTOR__;
                  (window as any).__BENCHMARK_ACTIVE__ = false;
                  return collected;
                },
                {
                  durationMs: overheadDurationMs,
                  baseTarget: centerTarget,
                  warmPanDistanceMeters: opts.warmPanDistanceMeters,
                }
              );

              await resetPoseAndSettle(centerTarget, 1.2, 45);
              await page.evaluate(() => {
                const h = (window as any).__BENCHMARK_HARNESS__;
                h.resetStreamingProfiler('overhead_enabled');
                h.setStreamingProfilerEnabled(true, 'overhead_enabled');
              });
              await runTrajectoryInPage({
                scenarioId: 'B_warm_cache_pan',
                durationMs: overheadDurationMs,
                baseTarget: centerTarget,
                baseZoom: 1.2,
                azimuthDeg: 45,
                warmPanDistanceMeters: opts.warmPanDistanceMeters,
                streamPanDistanceMeters: summary.streamPanDistanceMeters,
              });
              const enabledSnap: StreamingProfilerSnapshot = await page.evaluate(
                () => {
                  const h = (window as any).__BENCHMARK_HARNESS__;
                  h.setStreamingProfilerEnabled(false);
                  return h.getStreamingProfilerSnapshot();
                }
              );

              const disInterval = computeSampleStatistics(
                disabledSamples.map((s) => s.frameIntervalMs)
              );
              const enInterval = computeSampleStatistics(
                enabledSnap.frames.map((f) => f.frameIntervalMs)
              );
              const disCpu = computeSampleStatistics(
                disabledSamples.map((s) => s.cpuRenderTimeMs)
              );
              const enCpu = computeSampleStatistics(
                enabledSnap.frames.map((f) => f.glRenderCpuMs)
              );

              overheadChecks.push({
                mosaicLabel: summary.label,
                tileSizeMeters: summary.tileSizeMeters,
                variant,
                foliageEnabled,
                pickingMode,
                disabledSampleCount: disabledSamples.length,
                enabledSampleCount: enabledSnap.frames.length,
                disabledIntervalMedianMs: disInterval.median,
                enabledIntervalMedianMs: enInterval.median,
                intervalMedianDeltaMs: Number(
                  (enInterval.median - disInterval.median).toFixed(3)
                ),
                disabledIntervalP95Ms: disInterval.p95,
                enabledIntervalP95Ms: enInterval.p95,
                disabledCpuRenderMedianMs: disCpu.median,
                enabledCpuRenderMedianMs: enCpu.median,
                cpuRenderDeltaMs: Number((enCpu.median - disCpu.median).toFixed(3)),
              });
            }

            // 2. Scenario A: Stationary Baseline
            if (opts.scenarios.includes('A_stationary_baseline')) {
              await resetPoseAndSettle(centerTarget, 1.2, 45);
              const mergedFrames: FrameStageProfileSample[] = [];
              const mergedEvents: StreamingLifecycleEvent[] = [];
              let lastSnap!: StreamingProfilerSnapshot;
              for (let r = 0; r < opts.runs; r++) {
                await page.evaluate(() => {
                  const h = (window as any).__BENCHMARK_HARNESS__;
                  h.resetStreamingProfiler('A_stationary_baseline');
                  h.setStreamingProfilerEnabled(true, 'A_stationary_baseline');
                });
                await runTrajectoryInPage({
                  scenarioId: 'A_stationary_baseline',
                  durationMs: opts.measureMs,
                  baseTarget: centerTarget,
                  baseZoom: 1.2,
                  azimuthDeg: 45,
                  warmPanDistanceMeters: opts.warmPanDistanceMeters,
                  streamPanDistanceMeters: summary.streamPanDistanceMeters,
                });
                lastSnap = await page.evaluate(() => {
                  const h = (window as any).__BENCHMARK_HARNESS__;
                  h.setStreamingProfilerEnabled(false);
                  return h.getStreamingProfilerSnapshot();
                });
                mergedFrames.push(...lastSnap.frames);
                mergedEvents.push(...lastSnap.events);
              }
              const res = summarizeScenarioSnapshot({
                mosaicLabel: summary.label,
                tileSizeMeters: summary.tileSizeMeters,
                variant,
                foliageEnabled,
                pickingMode,
                scenarioId: 'A_stationary_baseline',
                inputPath: 'harness_camera_pose',
                runCount: opts.runs,
                durationMs: opts.measureMs * opts.runs,
                panDistanceMeters: 0,
                snapshot: {
                  ...lastSnap,
                  frames: mergedFrames,
                  events: mergedEvents,
                },
                isSoftwareRenderer: isSoftware,
              });
              stationaryMedianRef = res.frameDistribution.median;
              interactiveResults.push(res);
            }

            // 3. Scenario B: Warm-Cache Pan
            if (opts.scenarios.includes('B_warm_cache_pan')) {
              await resetPoseAndSettle(centerTarget, 1.2, 45);
              await page.evaluate(() => {
                const h = (window as any).__BENCHMARK_HARNESS__;
                h.resetStreamingProfiler('B_warm_cache_pan');
                h.setStreamingProfilerEnabled(true, 'B_warm_cache_pan');
              });
              await runTrajectoryInPage({
                scenarioId: 'B_warm_cache_pan',
                durationMs: opts.measureMs,
                baseTarget: centerTarget,
                baseZoom: 1.2,
                azimuthDeg: 45,
                warmPanDistanceMeters: opts.warmPanDistanceMeters,
                streamPanDistanceMeters: summary.streamPanDistanceMeters,
              });
              const snap: StreamingProfilerSnapshot = await page.evaluate(() => {
                const h = (window as any).__BENCHMARK_HARNESS__;
                h.setStreamingProfilerEnabled(false);
                return h.getStreamingProfilerSnapshot();
              });
              interactiveResults.push(
                summarizeScenarioSnapshot({
                  mosaicLabel: summary.label,
                  tileSizeMeters: summary.tileSizeMeters,
                  variant,
                  foliageEnabled,
                  pickingMode,
                  scenarioId: 'B_warm_cache_pan',
                  inputPath: 'harness_camera_pose',
                  runCount: 1,
                  durationMs: opts.measureMs,
                  panDistanceMeters: opts.warmPanDistanceMeters,
                  snapshot: snap,
                  isSoftwareRenderer: isSoftware,
                  stationaryReferenceMedianMs: stationaryMedianRef,
                })
              );
            }

            // 4. Scenario C: Streaming Pan Across Tile Boundaries
            if (opts.scenarios.includes('C_streaming_pan')) {
              await resetPoseAndSettle(summary.startLocalTarget, 1.2, 45);
              const streamDurationMs = Math.max(
                opts.measureMs,
                Math.round(
                  (summary.streamPanDistanceMeters / opts.panSpeedMps) * 1000
                )
              );

              let cdp: any = null;
              const traceChunks: any[] = [];
              const shouldTrace =
                Boolean(opts.traceOutPath) &&
                !traceCaptured &&
                foliageEnabled === foliageConfigs[0];
              if (shouldTrace) {
                cdp = await context.newCDPSession(page);
                cdp.on('Tracing.dataCollected', (evt: any) => {
                  if (Array.isArray(evt?.value)) {
                    traceChunks.push(...evt.value);
                  }
                });
                await cdp.send('Tracing.start', {
                  categories:
                    'devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame',
                });
              }

              await page.evaluate(() => {
                const h = (window as any).__BENCHMARK_HARNESS__;
                h.resetStreamingProfiler('C_streaming_pan');
                h.setStreamingProfilerEnabled(true, 'C_streaming_pan');
              });
              await runTrajectoryInPage({
                scenarioId: 'C_streaming_pan',
                durationMs: streamDurationMs,
                baseTarget: summary.startLocalTarget,
                baseZoom: 1.2,
                azimuthDeg: 45,
                warmPanDistanceMeters: opts.warmPanDistanceMeters,
                streamPanDistanceMeters: summary.streamPanDistanceMeters,
              });
              // Settle remaining async decodes/commits briefly inside capture window
              await page.evaluate(async () => {
                const h = (window as any).__BENCHMARK_HARNESS__;
                await h.waitForM2aIdle();
              });
              const snap: StreamingProfilerSnapshot = await page.evaluate(() => {
                const h = (window as any).__BENCHMARK_HARNESS__;
                h.setStreamingProfilerEnabled(false);
                return h.getStreamingProfilerSnapshot();
              });

              if (cdp && opts.traceOutPath) {
                const traceComplete = new Promise<void>((resolve) => {
                  cdp.once('Tracing.tracingComplete', () => resolve());
                });
                await cdp.send('Tracing.end');
                await traceComplete;
                fs.mkdirSync(path.dirname(opts.traceOutPath), {
                  recursive: true,
                });
                fs.writeFileSync(
                  opts.traceOutPath,
                  JSON.stringify({ traceEvents: traceChunks }),
                  'utf8'
                );
                await cdp.detach();
                traceCaptured = true;
                console.log(
                  `[bench:streaming-fluidity] Saved CDP trace: ${opts.traceOutPath} (${traceChunks.length} events)`
                );
              }

              interactiveResults.push(
                summarizeScenarioSnapshot({
                  mosaicLabel: summary.label,
                  tileSizeMeters: summary.tileSizeMeters,
                  variant,
                  foliageEnabled,
                  pickingMode,
                  scenarioId: 'C_streaming_pan',
                  inputPath: 'harness_camera_pose',
                  runCount: 1,
                  durationMs: streamDurationMs,
                  panDistanceMeters: summary.streamPanDistanceMeters,
                  snapshot: snap,
                  isSoftwareRenderer: isSoftware,
                  stationaryReferenceMedianMs: stationaryMedianRef,
                })
              );
            }

            // 5. Scenario D: Reverse Traversal (Reuse vs Refetch / Eviction)
            if (opts.scenarios.includes('D_reverse_traversal')) {
              await resetPoseAndSettle(summary.startLocalTarget, 1.2, 45);
              const legDurationMs = Math.max(
                opts.measureMs,
                Math.round(
                  (summary.streamPanDistanceMeters / opts.panSpeedMps) * 1000
                )
              );

              await page.evaluate(() => {
                const h = (window as any).__BENCHMARK_HARNESS__;
                h.resetStreamingProfiler('D_reverse_forward');
                h.setStreamingProfilerEnabled(true, 'D_reverse_forward');
              });
              await runTrajectoryInPage({
                scenarioId: 'D_reverse_traversal',
                durationMs: legDurationMs,
                baseTarget: summary.startLocalTarget,
                baseZoom: 1.2,
                azimuthDeg: 45,
                warmPanDistanceMeters: opts.warmPanDistanceMeters,
                streamPanDistanceMeters: summary.streamPanDistanceMeters,
                reverseDirection: 'forward',
              });
              await page.evaluate(async () => {
                await (window as any).__BENCHMARK_HARNESS__.waitForM2aIdle();
              });
              const fwdSnap: StreamingProfilerSnapshot = await page.evaluate(
                () => (window as any).__BENCHMARK_HARNESS__.getStreamingProfilerSnapshot()
              );

              await page.evaluate(() => {
                const h = (window as any).__BENCHMARK_HARNESS__;
                h.resetStreamingProfiler('D_reverse_return');
              });
              await runTrajectoryInPage({
                scenarioId: 'D_reverse_traversal',
                durationMs: legDurationMs,
                baseTarget: summary.startLocalTarget,
                baseZoom: 1.2,
                azimuthDeg: 45,
                warmPanDistanceMeters: opts.warmPanDistanceMeters,
                streamPanDistanceMeters: summary.streamPanDistanceMeters,
                reverseDirection: 'return',
              });
              await page.evaluate(async () => {
                await (window as any).__BENCHMARK_HARNESS__.waitForM2aIdle();
              });
              const revSnap: StreamingProfilerSnapshot = await page.evaluate(
                () => {
                  const h = (window as any).__BENCHMARK_HARNESS__;
                  h.setStreamingProfilerEnabled(false);
                  return h.getStreamingProfilerSnapshot();
                }
              );

              interactiveResults.push(
                summarizeScenarioSnapshot({
                  mosaicLabel: summary.label,
                  tileSizeMeters: summary.tileSizeMeters,
                  variant,
                  foliageEnabled,
                  pickingMode,
                  scenarioId: 'D_reverse_traversal',
                  inputPath: 'harness_camera_pose',
                  runCount: 1,
                  durationMs: legDurationMs * 2,
                  panDistanceMeters: summary.streamPanDistanceMeters * 2,
                  snapshot: {
                    ...revSnap,
                    frames: [...fwdSnap.frames, ...revSnap.frames],
                    events: [...fwdSnap.events, ...revSnap.events],
                    longTasks: [...fwdSnap.longTasks, ...revSnap.longTasks],
                    loafs: [...fwdSnap.loafs, ...revSnap.loafs],
                  },
                  isSoftwareRenderer: isSoftware,
                  stationaryReferenceMedianMs: stationaryMedianRef,
                  forwardEvents: fwdSnap.events,
                  reverseEvents: revSnap.events,
                })
              );
            }

            // 6. Scenario E: Continuous Zoom Sweep
            if (opts.scenarios.includes('E_continuous_zoom')) {
              await resetPoseAndSettle(centerTarget, 1.2, 45);
              await page.evaluate(() => {
                const h = (window as any).__BENCHMARK_HARNESS__;
                h.resetStreamingProfiler('E_continuous_zoom');
                h.setStreamingProfilerEnabled(true, 'E_continuous_zoom');
              });
              await runTrajectoryInPage({
                scenarioId: 'E_continuous_zoom',
                durationMs: opts.measureMs,
                baseTarget: centerTarget,
                baseZoom: 1.2,
                azimuthDeg: 45,
                warmPanDistanceMeters: opts.warmPanDistanceMeters,
                streamPanDistanceMeters: summary.streamPanDistanceMeters,
              });
              const snap: StreamingProfilerSnapshot = await page.evaluate(() => {
                const h = (window as any).__BENCHMARK_HARNESS__;
                h.setStreamingProfilerEnabled(false);
                return h.getStreamingProfilerSnapshot();
              });
              interactiveResults.push(
                summarizeScenarioSnapshot({
                  mosaicLabel: summary.label,
                  tileSizeMeters: summary.tileSizeMeters,
                  variant,
                  foliageEnabled,
                  pickingMode,
                  scenarioId: 'E_continuous_zoom',
                  inputPath: 'harness_camera_pose',
                  runCount: 1,
                  durationMs: opts.measureMs,
                  panDistanceMeters: null,
                  snapshot: snap,
                  isSoftwareRenderer: isSoftware,
                  stationaryReferenceMedianMs: stationaryMedianRef,
                })
              );
            }

            // 7. Scenario G: Real Playwright Pointer Drag Interaction
            if (opts.scenarios.includes('G_pointer_drag_pan')) {
              await resetPoseAndSettle(centerTarget, 1.2, 45);
              const canvasBox = await page
                .locator('[data-testid="webgl-viewport"] canvas')
                .boundingBox();
              if (canvasBox && canvasBox.width > 100 && canvasBox.height > 100) {
                const cx = canvasBox.x + canvasBox.width * 0.5;
                const cy = canvasBox.y + canvasBox.height * 0.5;
                await page.evaluate(() => {
                  const h = (window as any).__BENCHMARK_HARNESS__;
                  h.resetStreamingProfiler('G_pointer_drag_pan');
                  h.setStreamingProfilerEnabled(true, 'G_pointer_drag_pan');
                });
                const dragSpanPx = Math.min(320, canvasBox.width * 0.25);
                await page.mouse.move(cx, cy);
                await page.mouse.down();
                await page.mouse.move(cx - dragSpanPx, cy - 40, { steps: 36 });
                await page.mouse.move(cx + dragSpanPx, cy + 40, { steps: 48 });
                await page.mouse.up();
                await page.evaluate(async () => {
                  await (window as any).__BENCHMARK_HARNESS__.waitForM2aIdle();
                });
                const snap: StreamingProfilerSnapshot = await page.evaluate(
                  () => {
                    const h = (window as any).__BENCHMARK_HARNESS__;
                    h.setStreamingProfilerEnabled(false);
                    return h.getStreamingProfilerSnapshot();
                  }
                );
                interactiveResults.push(
                  summarizeScenarioSnapshot({
                    mosaicLabel: summary.label,
                    tileSizeMeters: summary.tileSizeMeters,
                    variant,
                    foliageEnabled,
                    pickingMode,
                    scenarioId: 'G_pointer_drag_pan',
                    inputPath: 'real_pointer_drag',
                    runCount: 1,
                    durationMs: opts.measureMs,
                    panDistanceMeters: null,
                    snapshot: snap,
                    isSoftwareRenderer: isSoftware,
                    stationaryReferenceMedianMs: stationaryMedianRef,
                  })
                );
              }
            }

            // 8. Scenario F: Teleportation (Isolated)
            if (opts.scenarios.includes('F_teleportation')) {
              await resetPoseAndSettle(summary.startLocalTarget, 1.2, 45);
              const jumpDist = Math.hypot(
                summary.teleportLocalTarget[0] - summary.startLocalTarget[0],
                summary.teleportLocalTarget[2] - summary.startLocalTarget[2]
              );
              const tpData = await page.evaluate(async ({ target }) => {
                const h = (window as any).__BENCHMARK_HARNESS__;
                h.resetStreamingProfiler('F_teleportation');
                h.setStreamingProfilerEnabled(true, 'F_teleportation');
                const t0 = performance.now();
                h.setCameraPose(target, 1.2, 45);
                await h.waitForM2aIdle();
                const timeToIdleMs = performance.now() - t0;
                h.setStreamingProfilerEnabled(false);
                const snap = h.getStreamingProfilerSnapshot() as StreamingProfilerSnapshot;
                return { t0, timeToIdleMs, snap };
              }, { target: summary.teleportLocalTarget });

              const attaches = tpData.snap.events.filter(
                (e) => e.eventType === 'attach'
              );
              const timeToFirstVisibleAttachMs =
                attaches.length > 0
                  ? Math.max(0, attaches[0].timestampMs - tpData.t0)
                  : null;
              const timeToAllVisibleAttachedMs =
                attaches.length > 0
                  ? Math.max(
                      0,
                      attaches[attaches.length - 1].timestampMs - tpData.t0
                    )
                  : null;

              const tpRes = summarizeScenarioSnapshot({
                mosaicLabel: summary.label,
                tileSizeMeters: summary.tileSizeMeters,
                variant,
                foliageEnabled,
                pickingMode,
                scenarioId: 'F_teleportation',
                inputPath: 'harness_camera_pose',
                runCount: 1,
                durationMs: Number(tpData.timeToIdleMs.toFixed(1)),
                panDistanceMeters: jumpDist,
                snapshot: tpData.snap,
                isSoftwareRenderer: isSoftware,
                stationaryReferenceMedianMs: stationaryMedianRef,
              });

              teleportationResults.push({
                mosaicLabel: summary.label,
                tileSizeMeters: summary.tileSizeMeters,
                variant,
                foliageEnabled,
                pickingMode,
                fromTarget: summary.startLocalTarget,
                toTarget: summary.teleportLocalTarget,
                jumpDistanceMeters: Number(jumpDist.toFixed(1)),
                timeToFirstVisibleAttachMs:
                  timeToFirstVisibleAttachMs !== null
                    ? Number(timeToFirstVisibleAttachMs.toFixed(1))
                    : null,
                timeToAllVisibleAttachedMs:
                  timeToAllVisibleAttachedMs !== null
                    ? Number(timeToAllVisibleAttachedMs.toFixed(1))
                    : null,
                timeToIdleMs: Number(tpData.timeToIdleMs.toFixed(1)),
                frameDistribution: tpRes.frameDistribution,
                eventConditionedFrames: tpRes.eventConditionedFrames,
                workerDeliverySummary: tpRes.workerDeliverySummary,
                cacheClassification: tpRes.cacheClassification,
                stageSummary: tpRes.stageSummary,
                worstFrames: tpRes.worstFrames,
              });
            }
          }
        }
        }
      }

      const report: StreamingFluidityBenchmarkReport = {
        schemaVersion: '2.0.0',
        generatedAtIso: new Date().toISOString(),
        viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
        themeId: opts.themeId,
        variants: [...opts.variants],
        targetUtm: { easting: targetEasting, northing: targetNorthing },
        preloadMarginTiles: opts.preloadMarginTiles,
        retainMarginTiles: opts.retainMarginTiles,
        panSpeedMps: opts.panSpeedMps,
        warmPanDistanceMeters: opts.warmPanDistanceMeters,
        warmupMs: opts.warmupMs,
        measureMs: opts.measureMs,
        runsPerScenario: opts.runs,
        gpuVendor: gpuInfo.gpuVendor,
        gpuRenderer: gpuInfo.gpuRenderer,
        isSoftwareRenderer: isSoftware,
        softwareRendererWarning: softwareWarning,
        traceOutPath: traceCaptured ? opts.traceOutPath : null,
        mosaics: mosaicSummaries,
        interactiveResults,
        teleportationResults,
        overheadChecks,
      };

      fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
      fs.writeFileSync(opts.outputPath, JSON.stringify(report, null, 2), 'utf8');
      fs.mkdirSync(path.dirname(opts.markdownPath), { recursive: true });
      fs.writeFileSync(
        opts.markdownPath,
        formatStreamingFluidityMarkdown(report),
        'utf8'
      );

      console.log(`[bench:streaming-fluidity] Wrote JSON: ${opts.outputPath}`);
      console.log(
        `[bench:streaming-fluidity] Wrote Markdown: ${opts.markdownPath}`
      );
      return report;
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  const cli = parseStreamingFluidityCli(process.argv.slice(2));
  runStreamingFluidityBenchmark(cli).catch((err) => {
    console.error(
      '[bench:streaming-fluidity] FAILED:',
      err instanceof Error ? err.message : err
    );
    process.exitCode = 1;
  });
}
