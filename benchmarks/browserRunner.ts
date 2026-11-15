import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BENCHMARK_SCHEMA_VERSION,
  type BenchmarkErrorRecord,
  type BenchmarkReport,
  type BrowserScenarioKind,
  type BrowserScenarioResult,
  type BrowserScenarioSpec,
  type BrowserWorkloadBenchmarkResult,
  type ChromiumGpuBackend,
  type UnsupportedMetricNotice,
} from './types';
import { computeSampleStatistics } from './stats';
import {
  collectHostEnvironmentMetadata,
  isSoftwareWebGLRenderer,
  MEMORY_MEASUREMENT_NOTES,
  STANDARD_METRIC_DEFINITIONS,
} from './environment';
import { loadBenchmarkDatasets } from './datasets';
import {
  resolveBrowserScenarios,
  resolveRendererConfigs,
} from './scenarios';
import {
  formatBenchmarkReportSummary,
  saveBenchmarkReport,
  validateBenchmarkReport,
} from './serializer';
import {
  buildLocalServerSpawnSpec,
  parseBrowserRunnerCliArgs,
  parseChromiumGpuBackend,
  terminateChildProcessTree,
} from './cliAndServer';
import {
  type BenchmarkFrameTelemetry,
  type BenchmarkHarnessSnapshot,
  computeConsecutiveFrameIntervalsMs,
  RAILWAY_VISIBILITY_SAMPLING_STRIDE,
  type RailwayScenarioVisibilityStatus,
  validateSceneReadinessSnapshot,
} from '../src/types/BenchmarkTelemetry';

export interface BrowserBenchmarkRunnerOptions {
  datasetIds?: string[];
  configIds?: string[];
  scenarioIds?: BrowserScenarioKind[];
  warmupFramesOverride?: number;
  measuredFramesOverride?: number;
  reloadCyclesOverride?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  devicePixelRatio?: number;
  serverUrl?: string;
  headless?: boolean;
  useSwiftShader?: boolean;
  gpuBackend?: ChromiumGpuBackend;
  requireHardwareGpu?: boolean;
  outputPath?: string;
  quiet?: boolean;
}

export interface RawScenarioBrowserPayload {
  scenarioId: BrowserScenarioKind;
  warmupFrames: number;
  measuredFrames: number;
  anchorTimestampMs: number | null;
  samples: BenchmarkFrameTelemetry[];
  browserMemoryMB: {
    supported: boolean;
    usedJSHeapSizeMB: number | null;
    totalJSHeapSizeMB: number | null;
    jsHeapSizeLimitMB: number | null;
  };
  reloadLifecycleAudit?: {
    cyclesExecuted: number;
    reloadAndFirstRenderSamplesMs: number[];
    initialDriverGeometries: number;
    finalDriverGeometries: number;
    netDriverGeometryDelta: number;
    initialDriverTextures: number;
    finalDriverTextures: number;
    netDriverTextureDelta: number;
    cleanDisposalVerified: boolean;
  };
}

export function resolveChromiumLaunchArgs(
  options: {
    useSwiftShader?: boolean;
    gpuBackend?: ChromiumGpuBackend;
    platform?: NodeJS.Platform;
  } = {}
): string[] {
  const platform = options.platform ?? process.platform;
  const requestedBackend = options.gpuBackend ?? 'auto';
  if (
    options.useSwiftShader &&
    requestedBackend !== 'auto' &&
    requestedBackend !== 'swiftshader'
  ) {
    throw new Error(
      `Cannot combine useSwiftShader=true with hardware GPU backend "${requestedBackend}".`
    );
  }

  const effectiveBackend: ChromiumGpuBackend = options.useSwiftShader
    ? 'swiftshader'
    : requestedBackend;

  const args = [
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--enable-precise-memory-info',
  ];

  const resolvedAngleBackend: Exclude<ChromiumGpuBackend, 'auto'> =
    effectiveBackend === 'auto'
      ? platform === 'win32'
        ? 'd3d11'
        : 'default'
      : effectiveBackend;

  switch (resolvedAngleBackend) {
    case 'swiftshader':
      args.unshift('--use-gl=angle', '--use-angle=swiftshader');
      break;
    case 'd3d11':
      args.unshift('--use-gl=angle', '--use-angle=d3d11');
      break;
    case 'vulkan':
      args.unshift('--use-gl=angle', '--use-angle=vulkan');
      break;
    case 'opengl':
      args.unshift('--use-gl=angle', '--use-angle=gl');
      break;
    case 'metal':
      args.unshift('--use-gl=angle', '--use-angle=metal');
      break;
    case 'default':
      break;
  }

  return args;
}

function findPreinstalledContainerChromiumExecutable(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  const envExec = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (envExec && fs.existsSync(envExec)) return envExec;

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright';
  if (!fs.existsSync(root)) return undefined;

  const direct = path.join(root, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
  if (fs.existsSync(direct)) return direct;

  try {
    const dirs = fs.readdirSync(root);
    for (const d of dirs) {
      if (d.startsWith('chromium_headless_shell-')) {
        const candidate = path.join(root, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
        if (fs.existsSync(candidate)) return candidate;
      }
      if (d.startsWith('chromium-')) {
        const candidate = path.join(root, d, 'chrome-linux', 'chrome');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function loadPlaywrightModule(): Promise<any> {
  try {
    const modName = 'playwright';
    return await import(modName);
  } catch {
    const globalPath = '/usr/local/share/bun-global/node_modules/playwright/index.mjs';
    if (fs.existsSync(globalPath)) {
      return await import(pathToFileURL(globalPath).href);
    }
    throw new Error(
      'Playwright is not installed. Run "npm install" and "npx playwright install chromium".'
    );
  }
}

async function findAvailablePort(preferredPort: number = 3145): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => {
      const fallback = net.createServer();
      fallback.unref();
      fallback.on('error', reject);
      fallback.listen(0, '127.0.0.1', () => {
        const addr = fallback.address();
        const port = typeof addr === 'object' && addr ? addr.port : preferredPort;
        fallback.close(() => resolve(port));
      });
    });
    srv.listen(preferredPort, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : preferredPort;
      srv.close(() => resolve(port));
    });
  });
}

function checkUrlReady(url: string, timeoutMs: number = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureLocalBenchmarkServer(explicitUrl?: string): Promise<{
  baseUrl: string;
  stopServer: () => Promise<void>;
}> {
  if (explicitUrl) {
    const ready = await checkUrlReady(explicitUrl, 3000);
    if (!ready) {
      throw new Error(`Explicit benchmark server URL is not reachable: ${explicitUrl}`);
    }
    return { baseUrl: explicitUrl.replace(/\/$/, ''), stopServer: async () => {} };
  }

  const port = await findAvailablePort(3145);
  const baseUrl = `http://127.0.0.1:${port}`;
  const spawnSpec = buildLocalServerSpawnSpec(port);

  const stderrChunks: string[] = [];
  const child: ChildProcess = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: spawnSpec.cwd,
    env: spawnSpec.env,
    shell: spawnSpec.shell,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (chunk) => {
    if (stderrChunks.length < 20) stderrChunks.push(String(chunk));
  });

  const startupDeadline = Date.now() + 25000;
  let ready = false;
  while (Date.now() < startupDeadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Local benchmark server exited prematurely with code ${child.exitCode}: ${stderrChunks.join('')}`
      );
    }
    if (await checkUrlReady(baseUrl, 1000)) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  if (!ready) {
    await terminateChildProcessTree(child);
    throw new Error(`Timed out waiting for local benchmark server on ${baseUrl}`);
  }

  const stopServer = async () => {
    await terminateChildProcessTree(child);
  };

  return { baseUrl, stopServer };
}

/**
 * Pure aggregation helper mapping raw post-gl.render() BenchmarkFrameTelemetry samples
 * into a validated BrowserScenarioResult. Exported for deterministic unit testing.
 */
export function buildScenarioResult(
  scenarioSpec: BrowserScenarioSpec,
  raw: RawScenarioBrowserPayload
): {
  result: BrowserScenarioResult;
  gpuUnsupportedNotice: UnsupportedMetricNotice | null;
  railwayUnavailableNotice: UnsupportedMetricNotice | null;
} {
  // Compute consecutive completed-frame intervals from post-gl.render() timestamps when anchor exists
  let frameIntervals: number[];
  if (raw.anchorTimestampMs !== null && raw.samples.length > 0) {
    frameIntervals = computeConsecutiveFrameIntervalsMs([
      raw.anchorTimestampMs,
      ...raw.samples.map((s) => s.frameTimestampMs),
    ]);
  } else if (raw.samples.length >= 2) {
    // Reload scenario or unanchored fallback: fall back to consecutive pairs or recorded rAF intervals
    frameIntervals = raw.samples.map((s) => s.frameIntervalMs);
  } else {
    frameIntervals = raw.samples.map((s) => s.frameIntervalMs);
  }

  const cpuRenderTimes = raw.samples.map((s) => s.cpuRenderTimeMs);
  const drawCalls = raw.samples.map((s) => s.renderCalls);
  const triangles = raw.samples.map((s) => s.renderTriangles);
  const collectorOverhead = raw.samples.map((s) => s.instrumentationOverheadMs ?? 0);

  const frameIntervalStats = computeSampleStatistics(frameIntervals);
  const cpuRenderStats = computeSampleStatistics(cpuRenderTimes);
  const drawCallStats = computeSampleStatistics(drawCalls);
  const triangleStats = computeSampleStatistics(triangles);
  const overheadStats = computeSampleStatistics(collectorOverhead);

  // Aggregate GPU timer query status & valid samples
  let validCount = 0;
  let pendingCount = 0;
  let disjointCount = 0;
  let unsupportedCount = 0;
  const validGpuSamples: number[] = [];

  for (const s of raw.samples) {
    if (!s.gpuTimerQuerySupported || s.gpuTimerStatus === 'unsupported') {
      unsupportedCount++;
    } else if (s.gpuDisjointOccurred || s.gpuTimerStatus === 'disjoint') {
      disjointCount++;
    } else if (
      s.gpuTimerStatus === 'valid' &&
      typeof s.gpuPassTimeMs === 'number' &&
      Number.isFinite(s.gpuPassTimeMs) &&
      s.gpuPassTimeMs >= 0
    ) {
      validCount++;
      validGpuSamples.push(s.gpuPassTimeMs);
    } else {
      pendingCount++;
    }
  }

  let gpuStatus: BrowserScenarioResult['gpuFrameRenderTimeMs']['status'];
  let gpuStatistics: BrowserScenarioResult['gpuFrameRenderTimeMs']['statistics'] = null;
  let gpuUnsupportedNotice: UnsupportedMetricNotice | null = null;

  if (raw.samples.length === 0 || unsupportedCount === raw.samples.length) {
    gpuStatus = 'unsupported';
    gpuUnsupportedNotice = {
      metricId: `${scenarioSpec.id}::gpuFrameRenderTimeMs`,
      reason: 'unsupported_by_gpu_driver',
      explanation:
        'EXT_disjoint_timer_query_webgl2 is not exposed by the active WebGL2 driver (common on SwiftShader or restricted GPU contexts). No fabricated GPU times were substituted.',
    };
  } else if (validGpuSamples.length > 0) {
    gpuStatus = 'supported';
    gpuStatistics = computeSampleStatistics(validGpuSamples);
  } else if (disjointCount > 0) {
    gpuStatus = 'disjoint';
    gpuUnsupportedNotice = {
      metricId: `${scenarioSpec.id}::gpuFrameRenderTimeMs`,
      reason: 'disjoint_gpu_timer',
      explanation:
        'GPU timer queries reported GPU_DISJOINT_EXT during the scenario; measurements were invalidated.',
    };
  } else {
    gpuStatus = 'unavailable';
    gpuUnsupportedNotice = {
      metricId: `${scenarioSpec.id}::gpuFrameRenderTimeMs`,
      reason: 'unsupported_by_gpu_driver',
      explanation:
        'EXT_disjoint_timer_query_webgl2 was present, but no completed non-disjoint query results resolved during the measurement window.',
    };
  }

  // Aggregate railway static counts & sampled frustum visibility (null if genuinely unavailable; 0 only if disabled/empty)
  const measuredRailSamples = raw.samples.filter(
    (s) =>
      s.railwayVisibilityStatus === 'measured' &&
      typeof s.activeRailwayMeshes === 'number' &&
      typeof s.frustumCulledRailwayMeshes === 'number' &&
      typeof s.frustumVisibleRailwayTriangles === 'number'
  );
  const disabledRailSamples = raw.samples.filter(
    (s) => s.railwayVisibilityStatus === 'disabled_by_config'
  );

  const lastSample = raw.samples[raw.samples.length - 1];
  const staticRailwayMeshes =
    raw.samples.find((s) => typeof s.staticRailwayMeshes === 'number')?.staticRailwayMeshes ??
    0;
  const staticRailwayTriangles =
    raw.samples.find((s) => typeof s.staticRailwayTriangles === 'number')
      ?.staticRailwayTriangles ?? 0;

  let railwayVisibilityStatus: RailwayScenarioVisibilityStatus;
  let activeRailwayMeshes: number | null;
  let frustumCulledRailwayMeshes: number | null;
  let frustumVisibleRailwayTriangles: number | null;
  let railwayUnavailableNotice: UnsupportedMetricNotice | null = null;

  if (disabledRailSamples.length === raw.samples.length && raw.samples.length > 0) {
    railwayVisibilityStatus = 'disabled_by_config';
    activeRailwayMeshes = 0;
    frustumCulledRailwayMeshes = 0;
    frustumVisibleRailwayTriangles = 0;
  } else if (measuredRailSamples.length > 0) {
    railwayVisibilityStatus = 'measured';
    activeRailwayMeshes = Math.round(
      computeSampleStatistics(measuredRailSamples.map((s) => s.activeRailwayMeshes as number))
        .median
    );
    frustumCulledRailwayMeshes = Math.round(
      computeSampleStatistics(
        measuredRailSamples.map((s) => s.frustumCulledRailwayMeshes as number)
      ).median
    );
    frustumVisibleRailwayTriangles = Math.round(
      computeSampleStatistics(
        measuredRailSamples.map((s) => s.frustumVisibleRailwayTriangles as number)
      ).median
    );
  } else {
    railwayVisibilityStatus = 'unavailable';
    activeRailwayMeshes = null;
    frustumCulledRailwayMeshes = null;
    frustumVisibleRailwayTriangles = null;
    railwayUnavailableNotice = {
      metricId: `${scenarioSpec.id}::railwayVisibility`,
      reason: 'unsupported_by_runtime',
      explanation:
        'Per-frame railway frustum visibility metrics could not be collected during this scenario; values are explicitly recorded as null rather than zero.',
    };
  }

  const effectiveMedianFps =
    frameIntervalStats.median > 0
      ? Number((1000 / frameIntervalStats.median).toFixed(2))
      : 0;

  const result: BrowserScenarioResult = {
    scenarioId: scenarioSpec.id,
    scenarioName: scenarioSpec.name,
    warmupFrames: raw.warmupFrames,
    measuredFrames: raw.samples.length,
    frameIntervalMs: frameIntervalStats,
    effectiveMedianFps,
    cpuFrameRenderTimeMs: cpuRenderStats,
    gpuFrameRenderTimeMs: {
      status: gpuStatus,
      statistics: gpuStatistics,
      sampleCounts: {
        totalFrames: raw.samples.length,
        valid: validCount,
        pending: pendingCount,
        disjoint: disjointCount,
        unsupported: unsupportedCount,
      },
    },
    webglDrawCallsPerFrame: drawCallStats,
    renderedTrianglesPerFrame: triangleStats,
    webglResources: {
      driverGeometries: lastSample?.driverGeometries ?? 0,
      driverTextures: lastSample?.driverTextures ?? 0,
      shaderPrograms: lastSample?.driverPrograms ?? 0,
      staticRailwayMeshes,
      staticRailwayTriangles,
      railwayVisibilityStatus,
      railwayVisibilitySamplingStride:
        lastSample?.railwayVisibilitySamplingStride ?? RAILWAY_VISIBILITY_SAMPLING_STRIDE,
      railwayVisibilitySampledFrames: measuredRailSamples.length,
      activeRailwayMeshes,
      frustumCulledRailwayMeshes,
      frustumVisibleRailwayTriangles,
    },
    instrumentationOverheadMs: overheadStats,
    browserMemoryMB: raw.browserMemoryMB,
    reloadLifecycleAudit: raw.reloadLifecycleAudit
      ? {
          cyclesExecuted: raw.reloadLifecycleAudit.cyclesExecuted,
          reloadAndFirstRenderMs: computeSampleStatistics(
            raw.reloadLifecycleAudit.reloadAndFirstRenderSamplesMs
          ),
          initialDriverGeometries: raw.reloadLifecycleAudit.initialDriverGeometries,
          finalDriverGeometries: raw.reloadLifecycleAudit.finalDriverGeometries,
          netDriverGeometryDelta: raw.reloadLifecycleAudit.netDriverGeometryDelta,
          initialDriverTextures: raw.reloadLifecycleAudit.initialDriverTextures,
          finalDriverTextures: raw.reloadLifecycleAudit.finalDriverTextures,
          netDriverTextureDelta: raw.reloadLifecycleAudit.netDriverTextureDelta,
          cleanDisposalVerified: raw.reloadLifecycleAudit.cleanDisposalVerified,
        }
      : undefined,
  };

  return { result, gpuUnsupportedNotice, railwayUnavailableNotice };
}

export async function runBrowserBenchmarks(
  options: BrowserBenchmarkRunnerOptions = {}
): Promise<BenchmarkReport> {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/ms-playwright')) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright';
  }

  const datasets = loadBenchmarkDatasets(options.datasetIds);
  const configs = resolveRendererConfigs(options.configIds);
  const scenarios = resolveBrowserScenarios(options.scenarioIds);

  const viewportWidth = options.viewportWidth ?? 1440;
  const viewportHeight = options.viewportHeight ?? 900;
  const devicePixelRatio = options.devicePixelRatio ?? 1;
  const headless = options.headless ?? true;
  const useSwiftShader = options.useSwiftShader ?? false;
  const envBackend = process.env.BENCH_GPU_BACKEND
    ? parseChromiumGpuBackend(process.env.BENCH_GPU_BACKEND)
    : undefined;
  const gpuBackend: ChromiumGpuBackend = options.gpuBackend ?? envBackend ?? 'auto';
  const requireHardwareGpu = options.requireHardwareGpu ?? false;

  if (useSwiftShader && requireHardwareGpu) {
    throw new Error('Cannot combine useSwiftShader=true with requireHardwareGpu=true.');
  }
  if (gpuBackend === 'swiftshader' && requireHardwareGpu) {
    throw new Error('Cannot combine gpuBackend="swiftshader" with requireHardwareGpu=true.');
  }

  const launchFlags = resolveChromiumLaunchArgs({ useSwiftShader, gpuBackend });

  const { baseUrl, stopServer } = await ensureLocalBenchmarkServer(options.serverUrl);
  const playwright = await loadPlaywrightModule();

  let browser: any = null;
  try {
    const defaultExecutablePath =
      typeof playwright.chromium.executablePath === 'function'
        ? playwright.chromium.executablePath()
        : undefined;
    const launchOptions: Record<string, any> = {
      headless,
      args: launchFlags,
    };

    if (!defaultExecutablePath || !fs.existsSync(defaultExecutablePath)) {
      const containerFallback = headless
        ? findPreinstalledContainerChromiumExecutable()
        : undefined;
      if (containerFallback) {
        launchOptions.executablePath = containerFallback;
      } else {
        throw new Error(
          `Playwright Chromium executable not found at "${defaultExecutablePath || 'unknown'}". Run "npx playwright install chromium" to install it.`
        );
      }
    }

    browser = await playwright.chromium.launch(launchOptions);

    const context = await browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      deviceScaleFactor: devicePixelRatio,
    });

    const page = await context.newPage();
    await page.addInitScript('window.__name = (fn) => fn;');

    // Strictly block any live external OSM / Overpass / Nominatim network calls for offline determinism
    await page.route('**/*', (route: any) => {
      const reqUrl: string = route.request().url();
      if (
        reqUrl.startsWith(baseUrl) ||
        reqUrl.startsWith('http://127.0.0.1') ||
        reqUrl.startsWith('http://localhost') ||
        reqUrl.startsWith('data:') ||
        reqUrl.startsWith('blob:')
      ) {
        route.continue();
      } else {
        route.abort();
      }
    });

    const benchmarkUrl = `${baseUrl}/?benchmark=1&dock=collapsed`;
    await page.goto(benchmarkUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(
      () => Boolean((window as any).__BENCHMARK_HARNESS__ && document.querySelector('canvas')),
      { timeout: 25000 }
    );

    page.on('crash', () => {
      console.error('[bench:browser] Chromium page crashed unexpectedly.');
    });
    page.on('pageerror', (err: Error) => {
      console.error(`[bench:browser] Uncaught page error: ${err?.message || String(err)}`);
    });
    page.on('framenavigated', (frame: any) => {
      if (frame === page.mainFrame()) {
        console.error(`[bench:browser] Unexpected main-frame navigation to: ${frame.url()}`);
      }
    });

    const browserEnvInfo = await page.evaluate(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const harness = (window as any).__BENCHMARK_HARNESS__;
      const snap = harness?.getSnapshot?.();
      const live = snap?.liveWebGL;
      const canvas = document.querySelector('canvas');
      const gl2 = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
      const gl1 = !gl2 ? (canvas?.getContext('webgl') as WebGLRenderingContext | null) : null;
      const gl = gl2 || gl1;
      const dbg = gl ? gl.getExtension('WEBGL_debug_renderer_info') : null;
      const directVendor = gl
        ? String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR))
        : null;
      const directRenderer = gl
        ? String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
        : null;
      const webglVersion: string = gl2 ? 'WebGL2' : gl1 ? 'WebGL1' : 'unavailable';
      return {
        userAgent: navigator.userAgent,
        gpuVendor: directVendor || live?.gpuVendor || 'Unknown',
        gpuRenderer: directRenderer || live?.gpuRenderer || 'Unknown',
        webglVersion,
      };
    });

    if (browserEnvInfo.webglVersion === 'unavailable') {
      throw new Error(
        'Browser benchmark failed: WebGL context is unavailable in Chromium.'
      );
    }

    const isSoftware = isSoftwareWebGLRenderer(browserEnvInfo.gpuRenderer);
    if (requireHardwareGpu && isSoftware) {
      throw new Error(
        `--require-hardware was specified, but Chromium initialized a software WebGL renderer: "${browserEnvInfo.gpuRenderer}". Ensure a hardware GPU driver is available and do not pass --swiftshader.`
      );
    }

    const effectiveSwiftShader = useSwiftShader || gpuBackend === 'swiftshader';
    const environment = collectHostEnvironmentMetadata({
      browserName: 'Chromium',
      browserVersion: browser.version(),
      userAgent: browserEnvInfo.userAgent,
      viewportWidth,
      viewportHeight,
      devicePixelRatio,
      webglVersion: browserEnvInfo.webglVersion,
      gpuVendor: browserEnvInfo.gpuVendor,
      gpuRenderer: browserEnvInfo.gpuRenderer,
      isSoftwareRenderer: isSoftware,
      useSwiftShader: effectiveSwiftShader,
      gpuBackendRequested: effectiveSwiftShader ? 'swiftshader' : gpuBackend,
      hardwareAccelerationRequested: !effectiveSwiftShader,
      launchFlags,
    });

    const browserResults: BrowserWorkloadBenchmarkResult[] = [];
    const globalUnsupported: UnsupportedMetricNotice[] = [];
    const allErrors: BenchmarkErrorRecord[] = [];
    const seenUnsupportedIds = new Set<string>();

    for (const dataset of datasets) {
      const expectNonEmptyScene = dataset.metadata.parsedFeatureCounts.total > 0;

      for (const config of configs) {
        if (!options.quiet) {
          console.log(
            `[bench:browser] Measuring dataset="${dataset.metadata.id}" config="${config.id}" (${scenarios.length} scenarios)...`
          );
        }

        const loadParams = {
          datasetId: dataset.metadata.id,
          regionName: dataset.metadata.name,
          rawGeoJson: dataset.rawGeoJson,
          isSwitchyardFixture: false,
          centerLonLat: dataset.metadata.originLonLat,
          clipRadiusMeters: dataset.metadata.clipRadiusMeters,
          infrastructureRenderOptions: config.infrastructureRenderOptions,
          railwayPrototypeMode: config.railwayPrototypeMode,
          themeId: config.themeId,
          target: [0, 0, 0] as [number, number, number],
          zoom: 1.0,
          azimuthDeg: 45,
        };

        const initializationTimingMs = await page.evaluate(
          async (params: typeof loadParams) => {
            return await (window as any).__BENCHMARK_HARNESS__.loadOfflineDataset(params);
          },
          loadParams
        );

        const loadedSnapshot: BenchmarkHarnessSnapshot = await page.evaluate(() => {
          return (window as any).__BENCHMARK_HARNESS__.getSnapshot();
        });

        const readiness = validateSceneReadinessSnapshot(loadedSnapshot, {
          expectedRevision: initializationTimingMs.sceneRevision,
          datasetId: dataset.metadata.id,
          roadsMode: config.infrastructureRenderOptions.roads,
          railwaysMode: config.infrastructureRenderOptions.railways,
          railwayPrototypeMode: config.railwayPrototypeMode,
          themeId: config.themeId,
          expectNonEmptyScene,
          minWebglFramesRendered: 1,
        });

        if (!readiness.ready) {
          throw new Error(
            `Scene failed post-load readiness validation for dataset="${dataset.metadata.id}" config="${config.id}": ${readiness.reason}`
          );
        }

        const staticSceneGeometry = {
          constructedMeshesCount: loadedSnapshot.constructedMeshesCount,
          sceneVertices: loadedSnapshot.sceneVertices,
          sceneTriangles: loadedSnapshot.sceneTriangles,
          cpuBufferMB: loadedSnapshot.cpuBufferMB,
        };

        const scenarioResults: BrowserScenarioResult[] = [];
        const workloadUnsupported: UnsupportedMetricNotice[] = [];
        const workloadErrors: BenchmarkErrorRecord[] = [];

        for (const scenarioSpec of scenarios) {
          const warmupFrames = options.warmupFramesOverride ?? scenarioSpec.warmupFrames;
          const measuredFrames = options.measuredFramesOverride ?? scenarioSpec.measuredFrames;
          const reloadCycles =
            options.reloadCyclesOverride ?? scenarioSpec.reloadCycles ?? 3;

          const rawPayload: RawScenarioBrowserPayload = await page.evaluate(
            async (args: {
              scenarioId: BrowserScenarioKind;
              warmupFrames: number;
              measuredFrames: number;
              reloadCycles: number;
              loadParams: typeof loadParams;
              samplingStride: number;
              expectNonEmptyScene: boolean;
            }) => {
              const harness = (window as any).__BENCHMARK_HARNESS__;
              const samples: BenchmarkFrameTelemetry[] = [];
              let anchorTimestampMs: number | null = null;

              const applyStepPose = (stepIndex: number, totalSteps: number) => {
                const u = totalSteps <= 1 ? 0 : stepIndex / (totalSteps - 1);
                if (args.scenarioId === 'static_overview') {
                  harness.setCameraPose([0, 0, 0], 1.0, 45);
                } else if (args.scenarioId === 'static_close_junction') {
                  harness.setCameraPose([0, 0, 0], 8.0, 45);
                } else if (args.scenarioId === 'automated_pan_sweep') {
                  const x = -220 + 440 * u;
                  const z = -140 + 280 * u;
                  harness.setCameraPose([x, 0, z], 5.5, 45);
                } else if (args.scenarioId === 'zoom_and_orbit_sweep') {
                  const x = -80 * Math.cos(u * Math.PI * 2);
                  const z = -80 * Math.sin(u * Math.PI * 2);
                  const zoom = 1.2 + 7.3 * Math.sin(u * Math.PI);
                  const azimuthDeg = 45 + u * 270;
                  harness.setCameraPose([x, 0, z], zoom, azimuthDeg);
                }
              };

              let pendingFrameResolve: ((tel: BenchmarkFrameTelemetry) => void) | null = null;
              const waitNextRenderedFrame = (): Promise<BenchmarkFrameTelemetry> =>
                new Promise((resolve) => {
                  pendingFrameResolve = resolve;
                });

              (window as any).__BENCHMARK_RESET_GPU_TIMERS__?.();
              (window as any).__BENCHMARK_ACTIVE__ = true;
              (window as any).__BENCHMARK_COLLECTOR_META__ = {
                phase: 'warmup',
                frameIndex: 0,
                totalMeasuredFrames: args.measuredFrames,
                samplingStride: args.samplingStride,
              };
              (window as any).__BENCHMARK_FRAME_COLLECTOR__ = (
                tel: BenchmarkFrameTelemetry
              ) => {
                if (pendingFrameResolve) {
                  const r = pendingFrameResolve;
                  pendingFrameResolve = null;
                  r(tel);
                }
              };

              let reloadLifecycleAudit: RawScenarioBrowserPayload['reloadLifecycleAudit'] =
                undefined;

              try {
                if (args.scenarioId === 'repeated_scene_reload') {
                  const snap0 = harness.getSnapshot();
                  const initialDriverGeometries = snap0?.liveWebGL?.driverGeometries ?? 0;
                  const initialDriverTextures = snap0?.liveWebGL?.driverTextures ?? 0;
                  const reloadAndFirstRenderSamplesMs: number[] = [];

                  const framesPerCycle = Math.max(
                    2,
                    Math.ceil(args.measuredFrames / Math.max(1, args.reloadCycles))
                  );

                  for (let cycle = 0; cycle < args.reloadCycles; cycle++) {
                    await harness.unloadDataset();
                    const unloadedSnap = harness.getSnapshot();
                    if (unloadedSnap?.locationId !== 'benchmark_unloaded') {
                      throw new Error(
                        `unloadDataset did not commit benchmark_unloaded state (got "${unloadedSnap?.locationId}").`
                      );
                    }

                    const reloadTiming = await harness.loadOfflineDataset(args.loadParams);
                    const reloadedSnap = harness.getSnapshot();
                    if (
                      reloadedSnap?.locationId !== args.loadParams.datasetId ||
                      (args.expectNonEmptyScene && reloadedSnap?.constructedMeshesCount <= 1)
                    ) {
                      throw new Error(
                        `Reloaded scene snapshot invalid after cycle ${cycle}: locationId=${reloadedSnap?.locationId}, meshes=${reloadedSnap?.constructedMeshesCount}`
                      );
                    }
                    reloadAndFirstRenderSamplesMs.push(
                      reloadTiming.totalSceneInitToFirstFrameMs
                    );

                    // Anchor frame for consecutive post-render intervals inside this reload cycle
                    const anchorTel = await waitNextRenderedFrame();
                    let prevTs = anchorTel.frameTimestampMs;

                    for (
                      let f = 0;
                      f < framesPerCycle && samples.length < args.measuredFrames;
                      f++
                    ) {
                      (window as any).__BENCHMARK_COLLECTOR_META__ = {
                        phase: 'measured',
                        frameIndex: samples.length,
                        totalMeasuredFrames: args.measuredFrames,
                        samplingStride: args.samplingStride,
                      };
                      const tel = await waitNextRenderedFrame();
                      const consecutiveInterval = Number(
                        Math.max(0, tel.frameTimestampMs - prevTs).toFixed(3)
                      );
                      prevTs = tel.frameTimestampMs;
                      samples.push({
                        ...tel,
                        frameIntervalMs: consecutiveInterval,
                      });
                    }
                  }

                  const snapFinal = harness.getSnapshot();
                  const finalDriverGeometries = snapFinal?.liveWebGL?.driverGeometries ?? 0;
                  const finalDriverTextures = snapFinal?.liveWebGL?.driverTextures ?? 0;
                  const netDriverGeometryDelta =
                    finalDriverGeometries - initialDriverGeometries;
                  const netDriverTextureDelta =
                    finalDriverTextures - initialDriverTextures;

                  reloadLifecycleAudit = {
                    cyclesExecuted: args.reloadCycles,
                    reloadAndFirstRenderSamplesMs,
                    initialDriverGeometries,
                    finalDriverGeometries,
                    netDriverGeometryDelta,
                    initialDriverTextures,
                    finalDriverTextures,
                    netDriverTextureDelta,
                    cleanDisposalVerified:
                      netDriverGeometryDelta <= 0 && netDriverTextureDelta <= 0,
                  };
                } else {
                  const totalSteps = args.warmupFrames + args.measuredFrames;
                  // Ensure at least 1 anchor frame completes before measured frame 0
                  const effectiveWarmup = Math.max(1, args.warmupFrames);

                  for (let w = 0; w < effectiveWarmup; w++) {
                    (window as any).__BENCHMARK_COLLECTOR_META__ = {
                      phase: 'warmup',
                      frameIndex: w,
                      totalMeasuredFrames: args.measuredFrames,
                      samplingStride: args.samplingStride,
                    };
                    applyStepPose(Math.min(w, Math.max(0, totalSteps - 1)), totalSteps);
                    const warmTel = await waitNextRenderedFrame();
                    anchorTimestampMs = warmTel.frameTimestampMs;
                  }

                  for (let m = 0; m < args.measuredFrames; m++) {
                    (window as any).__BENCHMARK_COLLECTOR_META__ = {
                      phase: 'measured',
                      frameIndex: m,
                      totalMeasuredFrames: args.measuredFrames,
                      samplingStride: args.samplingStride,
                    };
                    applyStepPose(args.warmupFrames + m, totalSteps);
                    const tel = await waitNextRenderedFrame();
                    samples.push(tel);
                  }
                }
              } finally {
                pendingFrameResolve = null;
                (window as any).__BENCHMARK_FRAME_COLLECTOR__ = null;
                (window as any).__BENCHMARK_COLLECTOR_META__ = undefined;
                (window as any).__BENCHMARK_ACTIVE__ = false;
              }

              const perfMem = (performance as any).memory;
              const browserMemoryMB = perfMem
                ? {
                    supported: true,
                    usedJSHeapSizeMB: Number(
                      (perfMem.usedJSHeapSize / (1024 * 1024)).toFixed(3)
                    ),
                    totalJSHeapSizeMB: Number(
                      (perfMem.totalJSHeapSize / (1024 * 1024)).toFixed(3)
                    ),
                    jsHeapSizeLimitMB: Number(
                      (perfMem.jsHeapSizeLimit / (1024 * 1024)).toFixed(3)
                    ),
                  }
                : {
                    supported: false,
                    usedJSHeapSizeMB: null,
                    totalJSHeapSizeMB: null,
                    jsHeapSizeLimitMB: null,
                  };

              return {
                scenarioId: args.scenarioId,
                warmupFrames: args.warmupFrames,
                measuredFrames: samples.length,
                anchorTimestampMs:
                  args.scenarioId === 'repeated_scene_reload' ? null : anchorTimestampMs,
                samples,
                browserMemoryMB,
                reloadLifecycleAudit,
              };
            },
            {
              scenarioId: scenarioSpec.id,
              warmupFrames,
              measuredFrames,
              reloadCycles,
              loadParams,
              samplingStride: RAILWAY_VISIBILITY_SAMPLING_STRIDE,
              expectNonEmptyScene,
            }
          );

          const { result, gpuUnsupportedNotice, railwayUnavailableNotice } =
            buildScenarioResult(scenarioSpec, rawPayload);
          scenarioResults.push(result);

          for (const notice of [gpuUnsupportedNotice, railwayUnavailableNotice]) {
            if (notice) {
              workloadUnsupported.push(notice);
              if (!seenUnsupportedIds.has(notice.metricId)) {
                seenUnsupportedIds.add(notice.metricId);
                globalUnsupported.push(notice);
              }
            }
          }
        }

        browserResults.push({
          dataset: dataset.metadata,
          rendererConfig: config,
          initializationTimingMs: {
            datasetParseMs: initializationTimingMs.datasetParseMs,
            cpuSceneBuildMs: initializationTimingMs.cpuSceneBuildMs,
            firstWebGLRenderMs: initializationTimingMs.firstWebGLRenderMs,
            totalSceneInitToFirstFrameMs:
              initializationTimingMs.totalSceneInitToFirstFrameMs,
          },
          staticSceneGeometry,
          scenarios: scenarioResults,
          unsupportedMetrics: workloadUnsupported,
          errors: workloadErrors,
        });
      }
    }

    const report: BenchmarkReport = {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      suite: 'browser',
      benchmarkName:
        'OSM 3D Renderer — Browser & WebGL Rendering Benchmark Suite (Playwright Chromium)',
      environment,
      methodology: {
        warmupIterations: options.warmupFramesOverride ?? 8,
        measuredIterations: options.measuredFramesOverride ?? 36,
        metricDefinitions: { ...STANDARD_METRIC_DEFINITIONS },
        memoryMeasurementNotes: [...MEMORY_MEASUREMENT_NOTES],
      },
      browserResults,
      unsupportedMetrics: globalUnsupported,
      errors: allErrors,
    };

    const validation = validateBenchmarkReport(report);
    if (!validation.valid) {
      throw new Error(
        `Generated browser benchmark report failed validation: ${validation.errors.join('; ')}`
      );
    }

    if (options.outputPath) {
      saveBenchmarkReport(report, options.outputPath);
    }

    if (!options.quiet) {
      console.log(formatBenchmarkReportSummary(report));
      if (options.outputPath) {
        console.log(`\nSaved Browser benchmark report to: ${path.resolve(options.outputPath)}`);
      }
    }

    return report;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    await stopServer();
  }
}

const isMainModule =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  try {
    const cliOptions = parseBrowserRunnerCliArgs(process.argv.slice(2));
    runBrowserBenchmarks(cliOptions).catch((err: any) => {
      console.error(`Browser benchmark runner failed: ${err?.message || String(err)}`);
      process.exit(1);
    });
  } catch (err: any) {
    console.error(`Browser benchmark runner failed: ${err?.message || String(err)}`);
    process.exit(1);
  }
}
