import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  resolveTsxCliPath,
  terminateChildProcessTree,
} from './cliAndServer';
import {
  collectHostEnvironmentMetadata,
  MEMORY_MEASUREMENT_NOTES,
  STANDARD_METRIC_DEFINITIONS,
} from './environment';
import {
  DEFAULT_HENGELO_SCALING_MANIFEST_PATH,
  loadHengeloScalingDatasets,
  LoadedScalingDataset,
} from './scalingDatasets';
import {
  formatScalingMarkdownReport,
  saveScalingJsonReport,
} from './scalingReport';
import { resolveRendererConfigs } from './scenarios';
import {
  BENCHMARK_SCALING_SCHEMA_VERSION,
  BenchmarkErrorRecord,
  BenchmarkRendererConfig,
  HengeloScalingLevel,
  RegionalScalingReport,
  ScalingConfigProgressionSummary,
  ScalingResourceLimits,
  ScalingWorkloadResult,
} from './types';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_WORKER_PATH = path.join(__dirname, 'scalingWorker.ts');

export interface ParsedScalingCliOptions {
  manifestPath: string;
  datasetIds?: string[];
  configIds?: string[];
  maxScale: HengeloScalingLevel;
  warmupIterations: number;
  measuredIterations: number;
  resourceLimits: ScalingResourceLimits;
  outputPath?: string;
  markdownOutputPath?: string;
  quiet: boolean;
}

function consumeListTokens(
  argv: readonly string[],
  startIndex: number,
  initialToken?: string
): { values: string[]; nextIndex: number } {
  const rawTokens: string[] = [];
  if (typeof initialToken === 'string') rawTokens.push(initialToken);
  let idx = startIndex;
  while (idx < argv.length && !argv[idx].startsWith('--')) {
    rawTokens.push(argv[idx]);
    idx++;
  }
  const values = rawTokens
    .flatMap((t) => t.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { values, nextIndex: idx - 1 };
}

function readSingleValueFlag(
  argv: readonly string[],
  index: number,
  flagName: string
): { value: string; nextIndex: number } {
  const arg = argv[index];
  const eqIdx = arg.indexOf('=');
  if (eqIdx !== -1) {
    const val = arg.slice(eqIdx + 1).trim();
    if (!val) throw new Error(`Flag ${flagName} requires a non-empty value.`);
    return { value: val, nextIndex: index };
  }
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`Flag ${flagName} requires a value.`);
  }
  return { value: next.trim(), nextIndex: index + 1 };
}

function parseIntFlag(raw: string, flagName: string, min: number): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Invalid integer for ${flagName}: "${raw}".`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`Value for ${flagName} must be >= ${min}, received ${raw}.`);
  }
  return parsed;
}

function parseMaxScale(raw: string): HengeloScalingLevel {
  const upper = raw.trim().toUpperCase();
  if (upper === 'S1' || upper === 'S2' || upper === 'S3' || upper === 'S4' || upper === 'S5') {
    return upper;
  }
  throw new Error(`Unsupported --max-scale "${raw}". Expected S1, S2, S3, S4, or S5.`);
}

/**
 * Parses CLI flags for `benchmarks/scalingRunner.ts`, compatible with Bash and Windows PowerShell.
 */
export function parseScalingRunnerCliArgs(argv: readonly string[]): ParsedScalingCliOptions {
  const datasetAcc: string[] = [];
  const configAcc: string[] = [];
  let hasDatasetFlag = false;
  let hasConfigFlag = false;

  let manifestPath = DEFAULT_HENGELO_SCALING_MANIFEST_PATH;
  let maxScale: HengeloScalingLevel = 'S5';
  let warmupIterations = 1;
  let measuredIterations = 3;
  let maxRssMB = 3072;
  let maxOldSpaceSizeMB = 3072;
  let timeoutMs = 120_000;
  let rssPollIntervalMs = 250;
  let validatorMaxEdges = 250;
  let outputPath: string | undefined = path.join(
    'benchmarks',
    'results',
    'tkt019-hengelo-scaling.json'
  );
  let markdownOutputPath: string | undefined = path.join(
    'docs',
    'tkt019-hengelo-scaling-report.md'
  );
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--datasets' || arg === '--dataset' || arg.startsWith('--datasets=') || arg.startsWith('--dataset=')) {
      hasDatasetFlag = true;
      const eqIdx = arg.indexOf('=');
      const { values, nextIndex } =
        eqIdx !== -1
          ? consumeListTokens(argv, i + 1, arg.slice(eqIdx + 1))
          : consumeListTokens(argv, i + 1);
      if (values.length === 0) throw new Error(`Flag ${arg.split('=')[0]} requires a value.`);
      datasetAcc.push(...values);
      i = nextIndex;
    } else if (arg === '--configs' || arg === '--config' || arg.startsWith('--configs=') || arg.startsWith('--config=')) {
      hasConfigFlag = true;
      const eqIdx = arg.indexOf('=');
      const { values, nextIndex } =
        eqIdx !== -1
          ? consumeListTokens(argv, i + 1, arg.slice(eqIdx + 1))
          : consumeListTokens(argv, i + 1);
      if (values.length === 0) throw new Error(`Flag ${arg.split('=')[0]} requires a value.`);
      configAcc.push(...values);
      i = nextIndex;
    } else if (arg === '--manifest' || arg.startsWith('--manifest=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--manifest');
      manifestPath = value;
      i = nextIndex;
    } else if (arg === '--max-scale' || arg.startsWith('--max-scale=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--max-scale');
      maxScale = parseMaxScale(value);
      i = nextIndex;
    } else if (arg === '--warmup' || arg.startsWith('--warmup=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--warmup');
      warmupIterations = parseIntFlag(value, '--warmup', 0);
      i = nextIndex;
    } else if (
      arg === '--iterations' ||
      arg.startsWith('--iterations=') ||
      arg === '--samples' ||
      arg.startsWith('--samples=')
    ) {
      const name = arg.includes('--samples') ? '--samples' : '--iterations';
      const { value, nextIndex } = readSingleValueFlag(argv, i, name);
      measuredIterations = parseIntFlag(value, name, 1);
      i = nextIndex;
    } else if (arg === '--max-rss-mb' || arg.startsWith('--max-rss-mb=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--max-rss-mb');
      maxRssMB = parseIntFlag(value, '--max-rss-mb', 64);
      i = nextIndex;
    } else if (arg === '--max-old-space-size-mb' || arg.startsWith('--max-old-space-size-mb=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--max-old-space-size-mb');
      maxOldSpaceSizeMB = parseIntFlag(value, '--max-old-space-size-mb', 64);
      i = nextIndex;
    } else if (arg === '--timeout-ms' || arg.startsWith('--timeout-ms=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--timeout-ms');
      timeoutMs = parseIntFlag(value, '--timeout-ms', 100);
      i = nextIndex;
    } else if (arg === '--rss-poll-ms' || arg.startsWith('--rss-poll-ms=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--rss-poll-ms');
      rssPollIntervalMs = parseIntFlag(value, '--rss-poll-ms', 25);
      i = nextIndex;
    } else if (arg === '--validator-max-edges' || arg.startsWith('--validator-max-edges=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--validator-max-edges');
      validatorMaxEdges = parseIntFlag(value, '--validator-max-edges', 0);
      i = nextIndex;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--out');
      outputPath = value;
      i = nextIndex;
    } else if (arg === '--md-out' || arg.startsWith('--md-out=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--md-out');
      markdownOutputPath = value;
      i = nextIndex;
    } else if (arg === '--no-save') {
      outputPath = undefined;
      markdownOutputPath = undefined;
    } else if (arg === '--quiet') {
      quiet = true;
    } else {
      throw new Error(`Unknown CLI argument for bench:scaling: "${arg}".`);
    }
  }

  return {
    manifestPath,
    datasetIds: hasDatasetFlag ? Array.from(new Set(datasetAcc)) : undefined,
    configIds: hasConfigFlag ? Array.from(new Set(configAcc)) : undefined,
    maxScale,
    warmupIterations,
    measuredIterations,
    resourceLimits: {
      maxRssMB,
      maxOldSpaceSizeMB,
      timeoutMs,
      validatorMaxEdges,
      rssPollIntervalMs,
    },
    outputPath,
    markdownOutputPath,
    quiet,
  };
}

/**
 * Reads live resident set size (RSS) in MiB for an active child PID on Linux, Windows, or macOS.
 * Returns `null` if the process already exited or OS inspection is unavailable.
 */
export async function readProcessRssMB(
  pid: number,
  platform: NodeJS.Platform = process.platform
): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (platform === 'linux') {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (match) {
        return Number((Number.parseInt(match[1], 10) / 1024).toFixed(3));
      }
    } catch {
      return null;
    }
  }

  if (platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { timeout: 1500, windowsHide: true }
      );
      // Format: "node.exe","12345","Console","1","412,340 K"
      const match = stdout.match(/"([\d,.\s]+)\s*K"\s*$/im);
      if (match) {
        const kb = Number.parseInt(match[1].replace(/[^\d]/g, ''), 10);
        if (Number.isFinite(kb)) return Number((kb / 1024).toFixed(3));
      }
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], {
      timeout: 1500,
    });
    const kb = Number.parseInt(stdout.trim(), 10);
    if (Number.isFinite(kb)) return Number((kb / 1024).toFixed(3));
  } catch {
    return null;
  }

  return null;
}

export interface RunIsolatedWorkloadOptions {
  dataset: LoadedScalingDataset;
  rendererConfig: BenchmarkRendererConfig;
  manifestPath: string;
  warmupIterations: number;
  measuredIterations: number;
  resourceLimits: ScalingResourceLimits;
  workerScriptPath?: string;
  extraWorkerArgs?: readonly string[];
  cwd?: string;
}

/**
 * Executes a single `(dataset, config)` workload inside an isolated, memory- and time-bounded
 * child Node process with live RSS polling and cross-platform process tree teardown.
 */
export async function runIsolatedScalingWorkload(
  options: RunIsolatedWorkloadOptions
): Promise<ScalingWorkloadResult> {
  const cwd = options.cwd ?? REPO_ROOT;
  const workerScriptPath = options.workerScriptPath ?? DEFAULT_WORKER_PATH;
  const tsxCli = resolveTsxCliPath(cwd);
  const limits = options.resourceLimits;
  const workloadKey = `${options.dataset.descriptor.id}::${options.rendererConfig.id}`;

  const childArgs = [
    '--expose-gc',
    `--max-old-space-size=${limits.maxOldSpaceSizeMB}`,
    tsxCli,
    workerScriptPath,
    `--manifest=${path.resolve(options.manifestPath)}`,
    `--dataset=${options.dataset.descriptor.id}`,
    `--config=${options.rendererConfig.id}`,
    `--warmup=${options.warmupIterations}`,
    `--iterations=${options.measuredIterations}`,
    `--validator-max-edges=${limits.validatorMaxEdges}`,
    ...(options.extraWorkerArgs ?? []),
  ];

  const startTime = performance.now();
  const child = spawn(process.execPath, childArgs, {
    cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
    },
  });

  let stderrTail = '';
  let stdoutTail = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrTail = (stderrTail + String(chunk)).slice(-2000);
  });
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdoutTail = (stdoutTail + String(chunk)).slice(-1000);
  });

  let peakPolledRssMB: number | null = null;
  let lastHeartbeatStage: string | null = null;
  let lastHeartbeatElapsedMs: number | null = null;
  let workerResult: ScalingWorkloadResult | null = null;
  let workerErrorMsg: string | null = null;
  let abortStatus: 'failed_timeout' | 'failed_memory_limit' | null = null;
  let abortReason = '';
  let pollingInFlight = false;
  let settled = false;

  const updatePeakRss = (mb: number | null) => {
    if (mb !== null && Number.isFinite(mb)) {
      if (peakPolledRssMB === null || mb > peakPolledRssMB) {
        peakPolledRssMB = mb;
      }
      if (!abortStatus && mb > limits.maxRssMB) {
        abortStatus = 'failed_memory_limit';
        abortReason = `Worker RSS (${mb.toFixed(1)} MB) exceeded configured maxRssMB=${limits.maxRssMB} MB at stage "${lastHeartbeatStage ?? 'startup'}".`;
        void terminateChildProcessTree(child);
      }
    }
  };

  child.on('message', (msg: any) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'heartbeat') {
      if (typeof msg.stage === 'string') lastHeartbeatStage = msg.stage;
      if (typeof msg.elapsedMs === 'number') lastHeartbeatElapsedMs = msg.elapsedMs;
      if (typeof msg.rssMB === 'number') updatePeakRss(msg.rssMB);
    } else if (msg.type === 'result' && msg.result) {
      workerResult = msg.result as ScalingWorkloadResult;
    } else if (msg.type === 'error' && msg.error) {
      workerErrorMsg = String(msg.error.message || 'Worker reported an execution error.');
    }
  });

  return await new Promise<ScalingWorkloadResult>((resolve) => {
    const cleanupTimers = () => {
      clearInterval(rssTimer);
      clearTimeout(timeoutTimer);
    };

    const rssTimer = setInterval(() => {
      if (settled || pollingInFlight || !child.pid || child.exitCode !== null) return;
      pollingInFlight = true;
      void readProcessRssMB(child.pid)
        .then((mb) => {
          updatePeakRss(mb);
        })
        .finally(() => {
          pollingInFlight = false;
        });
    }, limits.rssPollIntervalMs);

    const timeoutTimer = setTimeout(() => {
      if (!abortStatus && !settled) {
        abortStatus = 'failed_timeout';
        abortReason = `Worker exceeded wall-clock timeoutMs=${limits.timeoutMs} ms (last stage: "${lastHeartbeatStage ?? 'startup'}").`;
        void terminateChildProcessTree(child);
      }
    }, limits.timeoutMs);

    const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      const wallClockMs = Number((performance.now() - startTime).toFixed(2));

      if (abortStatus) {
        resolve({
          workloadKey,
          dataset: options.dataset.descriptor,
          rendererConfig: options.rendererConfig,
          status: abortStatus,
          statusReason: abortReason,
          workerWallClockMs: wallClockMs,
          lastHeartbeatStage,
          lastHeartbeatElapsedMs,
          warmupIterations: options.warmupIterations,
          measuredIterations: options.measuredIterations,
          timingsMs: null,
          memory: null,
          sceneGeometry: null,
          operations: null,
          completenessAndCorrectness: null,
          unsupportedMetrics: [],
          errors: [
            {
              phase: abortStatus,
              datasetId: options.dataset.descriptor.id,
              configId: options.rendererConfig.id,
              message: abortReason,
            },
          ],
        });
        return;
      }

      if (workerResult) {
        if (workerResult.memory) {
          workerResult.memory.processRssMB.parentPolledPeakMB = peakPolledRssMB;
          if (
            peakPolledRssMB !== null &&
            peakPolledRssMB > workerResult.memory.processRssMB.workerPeakObservedMB
          ) {
            workerResult.memory.processRssMB.workerPeakObservedMB = peakPolledRssMB;
          }
        }
        workerResult.workerWallClockMs = wallClockMs;
        resolve(workerResult);
        return;
      }

      const diagTail = (stderrTail || stdoutTail).trim();
      const msg =
        workerErrorMsg ??
        `Worker exited abnormally without result (code=${code}, signal=${signal}, peakPolledRssMB=${peakPolledRssMB ?? 'unknown'})${diagTail ? `: ${diagTail.slice(-400)}` : ''}`;

      resolve({
        workloadKey,
        dataset: options.dataset.descriptor,
        rendererConfig: options.rendererConfig,
        status: 'failed_oom_or_crash',
        statusReason: msg,
        workerWallClockMs: wallClockMs,
        lastHeartbeatStage,
        lastHeartbeatElapsedMs,
        warmupIterations: options.warmupIterations,
        measuredIterations: options.measuredIterations,
        timingsMs: null,
        memory: null,
        sceneGeometry: null,
        operations: null,
        completenessAndCorrectness: null,
        unsupportedMetrics: [],
        errors: [
          {
            phase: 'worker_crash_or_oom',
            datasetId: options.dataset.descriptor.id,
            configId: options.rendererConfig.id,
            message: msg,
          },
        ],
      });
    };

    child.once('error', (err) => {
      workerErrorMsg = err.message;
      finalize(child.exitCode, null);
    });
    child.once('exit', (code, signal) => {
      finalize(code, signal);
    });
  });
}

function makeSkippedResult(
  dataset: LoadedScalingDataset,
  rendererConfig: BenchmarkRendererConfig,
  warmupIterations: number,
  measuredIterations: number,
  reason: string
): ScalingWorkloadResult {
  return {
    workloadKey: `${dataset.descriptor.id}::${rendererConfig.id}`,
    dataset: dataset.descriptor,
    rendererConfig,
    status: 'skipped_due_to_threshold',
    statusReason: reason,
    workerWallClockMs: 0,
    lastHeartbeatStage: null,
    lastHeartbeatElapsedMs: null,
    warmupIterations,
    measuredIterations,
    timingsMs: null,
    memory: null,
    sceneGeometry: null,
    operations: null,
    completenessAndCorrectness: null,
    unsupportedMetrics: [],
    errors: [],
  };
}

export interface RegionalScalingRunOptions {
  manifestPath?: string;
  datasetIds?: readonly string[];
  configIds?: readonly string[];
  maxScale?: HengeloScalingLevel;
  warmupIterations?: number;
  measuredIterations?: number;
  resourceLimits?: Partial<ScalingResourceLimits>;
  workerScriptPath?: string;
  quiet?: boolean;
}

/**
 * Executes the resource-bounded Hengelo S1–S5 regional scalability benchmark suite
 * sequentially across isolated child worker processes, halting larger-scale progression
 * per configuration whenever resource, crash, or timeout limits are reached.
 */
export async function runRegionalScalingBenchmarks(
  options: RegionalScalingRunOptions = {}
): Promise<RegionalScalingReport> {
  const manifestPath = path.resolve(
    options.manifestPath ?? DEFAULT_HENGELO_SCALING_MANIFEST_PATH
  );
  const { manifest, datasets } = loadHengeloScalingDatasets({
    manifestPath,
    levelsOrIds: options.datasetIds,
    maxScale: options.maxScale ?? 'S5',
    verifyHashes: true,
  });
  const configs = resolveRendererConfigs(options.configIds);

  const warmupIterations = options.warmupIterations ?? 1;
  const measuredIterations = options.measuredIterations ?? 3;
  const resourceLimits: ScalingResourceLimits = {
    maxRssMB: options.resourceLimits?.maxRssMB ?? 3072,
    maxOldSpaceSizeMB: options.resourceLimits?.maxOldSpaceSizeMB ?? 3072,
    timeoutMs: options.resourceLimits?.timeoutMs ?? 120_000,
    validatorMaxEdges: options.resourceLimits?.validatorMaxEdges ?? 250,
    rssPollIntervalMs: options.resourceLimits?.rssPollIntervalMs ?? 250,
  };

  const results: ScalingWorkloadResult[] = [];
  const configSummaries: ScalingConfigProgressionSummary[] = [];
  const allErrors: BenchmarkErrorRecord[] = [];

  for (const config of configs) {
    let stoppedReason: string | null = null;
    let stoppedAtLevel: HengeloScalingLevel | null = null;
    let highestCompletedLevel: HengeloScalingLevel | null = null;
    let completedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const ds of datasets) {
      if (stoppedReason !== null) {
        const skipReason = `Skipped ${ds.descriptor.level} for config "${config.id}" because progression halted at ${stoppedAtLevel}: ${stoppedReason}`;
        if (!options.quiet) {
          console.log(`[SKIP] ${ds.descriptor.level} / ${config.id}: ${skipReason}`);
        }
        results.push(
          makeSkippedResult(ds, config, warmupIterations, measuredIterations, skipReason)
        );
        skippedCount++;
        continue;
      }

      if (!options.quiet) {
        console.log(
          `[RUN] ${ds.descriptor.level} (${ds.descriptor.id}) × ${config.id} [maxRss=${resourceLimits.maxRssMB}MB, timeout=${(resourceLimits.timeoutMs / 1000).toFixed(0)}s]...`
        );
      }

      const res = await runIsolatedScalingWorkload({
        dataset: ds,
        rendererConfig: config,
        manifestPath,
        warmupIterations,
        measuredIterations,
        resourceLimits,
        workerScriptPath: options.workerScriptPath,
      });
      results.push(res);

      if (res.status === 'completed') {
        highestCompletedLevel = ds.descriptor.level;
        completedCount++;
        if (!options.quiet && res.timingsMs && res.memory) {
          console.log(
            `  [OK] ${ds.descriptor.level} / ${config.id}: scene=${res.timingsMs.fullSceneGeometryGenerationMs.median.toFixed(1)}ms, rssPeak=${res.memory.processRssMB.workerPeakObservedMB.toFixed(1)}MB, cpuBuf=${res.memory.cpuBufferMemory.totalMB.toFixed(2)}MB, tris=${res.sceneGeometry?.renderedTrianglesWithInstances.toLocaleString()}`
          );
        }
      } else {
        failedCount++;
        stoppedAtLevel = ds.descriptor.level;
        stoppedReason = `${res.status}: ${res.statusReason}`;
        allErrors.push(...res.errors);
        if (!options.quiet) {
          console.warn(`  [STOP] ${ds.descriptor.level} / ${config.id}: ${stoppedReason}`);
        }
      }
    }

    configSummaries.push({
      configId: config.id,
      configLabel: config.label,
      highestCompletedLevel,
      stoppedAtLevel,
      stopReason: stoppedReason,
      completedLevelsCount: completedCount,
      skippedLevelsCount: skippedCount,
      failedLevelsCount: failedCount,
    });
  }

  return {
    schemaVersion: BENCHMARK_SCALING_SCHEMA_VERSION,
    suite: 'regional-scaling',
    benchmarkName: 'OSM 3D Renderer — TKT-019 Hengelo S1–S5 Regional Scalability Assessment',
    generatedAtIso: new Date().toISOString(),
    environment: collectHostEnvironmentMetadata(),
    datasetSeries: {
      studyArea: manifest.studyArea,
      sourceFileName: manifest.sourceFileName,
      sourceSha256: manifest.sourceSha256,
      osmTimestampIso: manifest.osmTimestampIso,
      attribution: manifest.attribution,
      datasets: datasets.map((d) => d.descriptor),
    },
    resourceLimits,
    methodology: {
      warmupIterations,
      measuredIterations,
      executionModel:
        'Sequential isolated child Node.js processes (--expose-gc, --max-old-space-size, active RSS polling, wall-clock timeout, cross-platform tree kill, automatic progression halt on threshold breach).',
      metricDefinitions: {
        ...STANDARD_METRIC_DEFINITIONS,
        workerPeakObservedMB:
          'Peak process resident set size (RSS) observed by parent OS polling (/proc on Linux, tasklist on Windows) or child IPC heartbeat.',
      },
      memoryMeasurementNotes: [
        ...MEMORY_MEASUREMENT_NOTES,
        'Each (dataset, config) pair executes in a fresh OS process to eliminate cross-workload V8 heap contamination and protect 16 GB developer machines.',
      ],
    },
    configSummaries,
    results,
    errors: allErrors,
  };
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runRegionalScalingBenchmarksFromCli().catch((err: any) => {
    console.error(`Scaling benchmark runner failed: ${err?.message || String(err)}`);
    process.exit(1);
  });
}

async function runRegionalScalingBenchmarksFromCli(): Promise<void> {
  const cli = parseScalingRunnerCliArgs(process.argv.slice(2));
  const report = await runRegionalScalingBenchmarks({
    manifestPath: cli.manifestPath,
    datasetIds: cli.datasetIds,
    configIds: cli.configIds,
    maxScale: cli.maxScale,
    warmupIterations: cli.warmupIterations,
    measuredIterations: cli.measuredIterations,
    resourceLimits: cli.resourceLimits,
    quiet: cli.quiet,
  });

  const md = formatScalingMarkdownReport(report);
  if (!cli.quiet) {
    console.log('\n' + md);
  }

  if (cli.outputPath) {
    const savedJson = saveScalingJsonReport(report, cli.outputPath);
    console.log(`\nSaved TKT-019 scaling JSON report to: ${savedJson}`);
  }
  if (cli.markdownOutputPath) {
    const resolvedMd = path.resolve(cli.markdownOutputPath);
    fs.mkdirSync(path.dirname(resolvedMd), { recursive: true });
    fs.writeFileSync(resolvedMd, md + '\n', 'utf8');
    console.log(`Saved TKT-019 scaling Markdown report to: ${resolvedMd}`);
  }
}
