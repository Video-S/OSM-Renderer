import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import type { BrowserScenarioKind, ChromiumGpuBackend } from './types';

export const SUPPORTED_CHROMIUM_GPU_BACKENDS: readonly ChromiumGpuBackend[] = Object.freeze([
  'auto',
  'd3d11',
  'vulkan',
  'opengl',
  'metal',
  'swiftshader',
  'default',
]);

export function parseChromiumGpuBackend(raw: string): ChromiumGpuBackend {
  const normalized = raw.trim().toLowerCase();
  if ((SUPPORTED_CHROMIUM_GPU_BACKENDS as readonly string[]).includes(normalized)) {
    return normalized as ChromiumGpuBackend;
  }
  throw new Error(
    `Unsupported --gpu-backend value "${raw}". Expected one of: ${SUPPORTED_CHROMIUM_GPU_BACKENDS.join(', ')}.`
  );
}

export interface ParsedBrowserCliOptions {
  datasetIds?: string[];
  configIds?: string[];
  scenarioIds?: BrowserScenarioKind[];
  warmupFramesOverride?: number;
  measuredFramesOverride?: number;
  reloadCyclesOverride?: number;
  useSwiftShader: boolean;
  gpuBackend: ChromiumGpuBackend;
  requireHardwareGpu: boolean;
  headless: boolean;
  serverUrl?: string;
  outputPath?: string;
  quiet: boolean;
}

export interface ParsedCpuCliOptions {
  datasetIds?: string[];
  configIds?: string[];
  warmupIterations: number;
  measuredIterations: number;
  outputPath?: string;
}

/**
 * Consumes comma-separated and PowerShell-split list tokens following a list flag
 * (e.g. `['--scenarios', 'static_overview', 'automated_pan_sweep']` or
 * `['--scenarios', 'static_overview,', 'automated_pan_sweep']`) until the next `--flag`.
 */
function consumeListTokens(
  argv: readonly string[],
  startIndex: number,
  initialToken?: string
): { values: string[]; nextIndex: number } {
  const rawTokens: string[] = [];
  if (typeof initialToken === 'string') {
    rawTokens.push(initialToken);
  }
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
    if (!val) {
      throw new Error(`Flag ${flagName} requires a non-empty value.`);
    }
    return { value: val, nextIndex: index };
  }
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`Flag ${flagName} requires a value.`);
  }
  return { value: next.trim(), nextIndex: index + 1 };
}

function parsePositiveOrZeroInt(raw: string, flagName: string, min: number): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Invalid integer for ${flagName}: "${raw}".`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`Value for ${flagName} must be an integer >= ${min}, received ${raw}.`);
  }
  return parsed;
}

/**
 * Parses CLI flags for `benchmarks/browserRunner.ts` with support for repeated flags,
 * `--flag=value`, and Windows PowerShell unquoted comma-split tokens.
 */
export function parseBrowserRunnerCliArgs(argv: readonly string[]): ParsedBrowserCliOptions {
  const datasetAcc: string[] = [];
  const configAcc: string[] = [];
  const scenarioAcc: string[] = [];
  let hasDatasetFlag = false;
  let hasConfigFlag = false;
  let hasScenarioFlag = false;

  let warmupFramesOverride: number | undefined;
  let measuredFramesOverride: number | undefined;
  let reloadCyclesOverride: number | undefined;
  let useSwiftShader = false;
  let gpuBackend: ChromiumGpuBackend = 'auto';
  let requireHardwareGpu = false;
  let headless = true;
  let serverUrl: string | undefined;
  let outputPath: string | undefined = 'benchmarks/baselines/browser-baseline.json';
  let explicitOutProvided = false;
  let quiet = false;
  let quickMode = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--datasets' || arg === '--dataset' || arg.startsWith('--datasets=') || arg.startsWith('--dataset=')) {
      hasDatasetFlag = true;
      const eqIdx = arg.indexOf('=');
      const { values, nextIndex } =
        eqIdx !== -1
          ? consumeListTokens(argv, i + 1, arg.slice(eqIdx + 1))
          : consumeListTokens(argv, i + 1);
      if (values.length === 0) {
        throw new Error(`Flag ${arg.split('=')[0]} requires at least one dataset ID.`);
      }
      datasetAcc.push(...values);
      i = nextIndex;
    } else if (arg === '--configs' || arg === '--config' || arg.startsWith('--configs=') || arg.startsWith('--config=')) {
      hasConfigFlag = true;
      const eqIdx = arg.indexOf('=');
      const { values, nextIndex } =
        eqIdx !== -1
          ? consumeListTokens(argv, i + 1, arg.slice(eqIdx + 1))
          : consumeListTokens(argv, i + 1);
      if (values.length === 0) {
        throw new Error(`Flag ${arg.split('=')[0]} requires at least one config ID.`);
      }
      configAcc.push(...values);
      i = nextIndex;
    } else if (arg === '--scenarios' || arg === '--scenario' || arg.startsWith('--scenarios=') || arg.startsWith('--scenario=')) {
      hasScenarioFlag = true;
      const eqIdx = arg.indexOf('=');
      const { values, nextIndex } =
        eqIdx !== -1
          ? consumeListTokens(argv, i + 1, arg.slice(eqIdx + 1))
          : consumeListTokens(argv, i + 1);
      if (values.length === 0) {
        throw new Error(`Flag ${arg.split('=')[0]} requires at least one scenario ID.`);
      }
      scenarioAcc.push(...values);
      i = nextIndex;
    } else if (arg === '--warmup-frames' || arg.startsWith('--warmup-frames=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--warmup-frames');
      warmupFramesOverride = parsePositiveOrZeroInt(value, '--warmup-frames', 0);
      i = nextIndex;
    } else if (arg === '--measured-frames' || arg.startsWith('--measured-frames=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--measured-frames');
      measuredFramesOverride = parsePositiveOrZeroInt(value, '--measured-frames', 1);
      i = nextIndex;
    } else if (arg === '--reload-iterations' || arg.startsWith('--reload-iterations=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--reload-iterations');
      reloadCyclesOverride = parsePositiveOrZeroInt(value, '--reload-iterations', 1);
      i = nextIndex;
    } else if (arg === '--url' || arg.startsWith('--url=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--url');
      serverUrl = value;
      i = nextIndex;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--out');
      outputPath = value;
      explicitOutProvided = true;
      i = nextIndex;
    } else if (arg === '--no-save') {
      outputPath = undefined;
      explicitOutProvided = true;
    } else if (arg === '--quiet') {
      quiet = true;
    } else if (arg === '--swiftshader') {
      useSwiftShader = true;
    } else if (arg === '--gpu-backend' || arg.startsWith('--gpu-backend=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--gpu-backend');
      gpuBackend = parseChromiumGpuBackend(value);
      i = nextIndex;
    } else if (arg === '--require-hardware') {
      requireHardwareGpu = true;
    } else if (arg === '--headed') {
      headless = false;
    } else if (arg === '--headless') {
      headless = true;
    } else if (arg === '--quick') {
      quickMode = true;
    } else {
      throw new Error(`Unknown CLI argument for bench:browser: "${arg}".`);
    }
  }

  if (useSwiftShader && requireHardwareGpu) {
    throw new Error('Cannot combine --swiftshader and --require-hardware flags.');
  }
  if (gpuBackend === 'swiftshader' && requireHardwareGpu) {
    throw new Error('Cannot combine --gpu-backend=swiftshader and --require-hardware flags.');
  }
  if (useSwiftShader && gpuBackend !== 'auto' && gpuBackend !== 'swiftshader') {
    throw new Error(
      `Cannot combine --swiftshader with hardware GPU backend "--gpu-backend=${gpuBackend}".`
    );
  }

  if (quickMode) {
    if (warmupFramesOverride === undefined) warmupFramesOverride = 4;
    if (measuredFramesOverride === undefined) measuredFramesOverride = 12;
    if (reloadCyclesOverride === undefined) reloadCyclesOverride = 2;
    if (!hasConfigFlag) {
      configAcc.push('surface-first-e2plus-rplus');
      hasConfigFlag = true;
    }
    if (!hasDatasetFlag) {
      datasetAcc.push('small-real-europatunnel', 'synthetic-stress-urban-switchyard');
      hasDatasetFlag = true;
    }
  }

  return {
    datasetIds: hasDatasetFlag ? Array.from(new Set(datasetAcc)) : undefined,
    configIds: hasConfigFlag ? Array.from(new Set(configAcc)) : undefined,
    scenarioIds: hasScenarioFlag
      ? (Array.from(new Set(scenarioAcc)) as BrowserScenarioKind[])
      : undefined,
    warmupFramesOverride,
    measuredFramesOverride,
    reloadCyclesOverride,
    useSwiftShader,
    gpuBackend,
    requireHardwareGpu,
    headless,
    serverUrl,
    outputPath: explicitOutProvided ? outputPath : outputPath,
    quiet,
  };
}

/**
 * Parses CLI flags for `benchmarks/cpuRunner.ts` with support for `--flag=value`,
 * `--iterations` alias, repeated flags, and PowerShell-split comma lists.
 */
export function parseCpuRunnerCliArgs(argv: readonly string[]): ParsedCpuCliOptions {
  const datasetAcc: string[] = [];
  const configAcc: string[] = [];
  let hasDatasetFlag = false;
  let hasConfigFlag = false;

  let warmupIterations = 2;
  let measuredIterations = 5;
  let outputPath: string | undefined = 'benchmarks/baselines/cpu-baseline.json';
  let quickMode = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--datasets' || arg === '--dataset' || arg.startsWith('--datasets=') || arg.startsWith('--dataset=')) {
      hasDatasetFlag = true;
      const eqIdx = arg.indexOf('=');
      const { values, nextIndex } =
        eqIdx !== -1
          ? consumeListTokens(argv, i + 1, arg.slice(eqIdx + 1))
          : consumeListTokens(argv, i + 1);
      if (values.length === 0) {
        throw new Error(`Flag ${arg.split('=')[0]} requires at least one dataset ID.`);
      }
      datasetAcc.push(...values);
      i = nextIndex;
    } else if (arg === '--configs' || arg === '--config' || arg.startsWith('--configs=') || arg.startsWith('--config=')) {
      hasConfigFlag = true;
      const eqIdx = arg.indexOf('=');
      const { values, nextIndex } =
        eqIdx !== -1
          ? consumeListTokens(argv, i + 1, arg.slice(eqIdx + 1))
          : consumeListTokens(argv, i + 1);
      if (values.length === 0) {
        throw new Error(`Flag ${arg.split('=')[0]} requires at least one config ID.`);
      }
      configAcc.push(...values);
      i = nextIndex;
    } else if (arg === '--warmup' || arg.startsWith('--warmup=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--warmup');
      warmupIterations = parsePositiveOrZeroInt(value, '--warmup', 0);
      i = nextIndex;
    } else if (
      arg === '--samples' ||
      arg.startsWith('--samples=') ||
      arg === '--iterations' ||
      arg.startsWith('--iterations=')
    ) {
      const flagName = arg.includes('--iterations') ? '--iterations' : '--samples';
      const { value, nextIndex } = readSingleValueFlag(argv, i, flagName);
      measuredIterations = parsePositiveOrZeroInt(value, flagName, 1);
      i = nextIndex;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--out');
      outputPath = value;
      i = nextIndex;
    } else if (arg === '--no-save') {
      outputPath = undefined;
    } else if (arg === '--quick') {
      quickMode = true;
    } else {
      throw new Error(`Unknown CLI argument for bench:cpu: "${arg}".`);
    }
  }

  if (quickMode) {
    warmupIterations = Math.min(warmupIterations, 1);
    measuredIterations = Math.min(measuredIterations, 3);
    if (!hasConfigFlag) {
      configAcc.push('surface-first-e2plus-rplus');
      hasConfigFlag = true;
    }
    if (!hasDatasetFlag) {
      datasetAcc.push('small-real-europatunnel', 'synthetic-stress-urban-switchyard');
      hasDatasetFlag = true;
    }
  }

  return {
    datasetIds: hasDatasetFlag ? Array.from(new Set(datasetAcc)) : undefined,
    configIds: hasConfigFlag ? Array.from(new Set(configAcc)) : undefined,
    warmupIterations,
    measuredIterations,
    outputPath,
  };
}

/**
 * Resolves the local `tsx` CLI JavaScript entrypoint from `node_modules` without relying on
 * `npx` or `.cmd` shims on Windows.
 */
export function resolveTsxCliPath(cwd: string = process.cwd()): string {
  const candidates = [
    path.join(cwd, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(cwd, 'node_modules', 'tsx', 'dist', 'cli.cjs'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const req = createRequire(path.join(cwd, 'package.json'));
    const pkgPath = req.resolve('tsx/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsx;
    if (binRel) {
      const resolvedBin = path.resolve(path.dirname(pkgPath), binRel);
      if (fs.existsSync(resolvedBin)) {
        return resolvedBin;
      }
    }
  } catch {
    // fall through to explicit error
  }

  throw new Error(
    `Unable to locate local tsx CLI entrypoint under ${path.join(cwd, 'node_modules', 'tsx')}. Run "npm install" first.`
  );
}

export interface ServerSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  shell: false;
  env: NodeJS.ProcessEnv;
}

/**
 * Constructs a cross-platform `spawn(process.execPath, [tsxCli, serverTs])` specification
 * avoiding `npx` / `.cmd` shell wrappers that fail with ENOENT on Windows.
 */
export function buildLocalServerSpawnSpec(
  port: number,
  cwd: string = process.cwd(),
  baseEnv: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath
): ServerSpawnSpec {
  const tsxCli = resolveTsxCliPath(cwd);
  const serverEntry = path.join(cwd, 'server.ts');
  return {
    command: execPath,
    args: [tsxCli, serverEntry],
    cwd,
    shell: false,
    env: {
      ...baseEnv,
      NODE_ENV: 'development',
      DISABLE_HMR: 'true',
      PORT: String(port),
    },
  };
}

/**
 * Terminates a child server process cleanly across Windows and POSIX platforms.
 */
export async function terminateChildProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (platform === 'win32' && typeof child.pid === 'number') {
    await new Promise<void>((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        resolve();
      };

      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
      });
      killer.on('error', () => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        done();
      });
      killer.on('exit', () => done());
      child.once('exit', () => done());
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        done();
      }, 2500);
    });
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
