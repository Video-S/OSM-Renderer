import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { pathToFileURL } from 'url';
import {
  BENCHMARK_SCHEMA_VERSION,
  type BenchmarkErrorRecord,
  type BenchmarkReport,
  type BrowserScenarioKind,
  type BrowserScenarioResult,
  type BrowserScenarioSpec,
  type BrowserWorkloadBenchmarkResult,
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
  outputPath?: string;
  quiet?: boolean;
}

interface RawBrowserFrameSample {
  frameIntervalMs: number;
  cpuRenderTimeMs: number;
  renderCalls: number;
  renderTriangles: number;
  driverGeometries: number;
  driverTextures: number;
  driverPrograms: number;
  activeRailwayMeshes: number;
  frustumCulledRailwayMeshes: number;
  frustumVisibleRailwayTriangles: number;
  gpuFrameTimeMs: number | null;
  gpuTimerSupported: boolean;
  gpuTimerDisjoint: boolean;
}

interface RawScenarioBrowserPayload {
  scenarioId: BrowserScenarioKind;
  warmupFrames: number;
  measuredFrames: number;
  samples: RawBrowserFrameSample[];
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
      'Playwright is not installed locally or in /usr/local/share/bun-global/node_modules/playwright.'
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

  if (await checkUrlReady('http://127.0.0.1:3000', 1000)) {
    return { baseUrl: 'http://127.0.0.1:3000', stopServer: async () => {} };
  }

  const port = await findAvailablePort(3145);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn('npx', ['tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const startupDeadline = Date.now() + 25000;
  let ready = false;
  while (Date.now() < startupDeadline) {
    if (await checkUrlReady(baseUrl, 1000)) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  if (!ready) {
    child.kill('SIGTERM');
    throw new Error(`Timed out waiting for local benchmark server on ${baseUrl}`);
  }

  const stopServer = async () => {
    if (child.killed) return;
    child.kill('SIGTERM');
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
  };

  return { baseUrl, stopServer };
}

function buildScenarioResult(
  scenarioSpec: BrowserScenarioSpec,
  raw: RawScenarioBrowserPayload
): {
  result: BrowserScenarioResult;
  gpuUnsupportedNotice: UnsupportedMetricNotice | null;
} {
  const frameIntervals = raw.samples.map((s) => s.frameIntervalMs);
  const cpuRenderTimes = raw.samples.map((s) => s.cpuRenderTimeMs);
  const drawCalls = raw.samples.map((s) => s.renderCalls);
  const triangles = raw.samples.map((s) => s.renderTriangles);

  const frameIntervalStats = computeSampleStatistics(frameIntervals);
  const cpuRenderStats = computeSampleStatistics(cpuRenderTimes);
  const drawCallStats = computeSampleStatistics(drawCalls);
  const triangleStats = computeSampleStatistics(triangles);

  const validGpuSamples = raw.samples
    .filter(
      (s) =>
        s.gpuTimerSupported &&
        !s.gpuTimerDisjoint &&
        typeof s.gpuFrameTimeMs === 'number' &&
        s.gpuFrameTimeMs >= 0
    )
    .map((s) => s.gpuFrameTimeMs as number);

  const anyGpuSupported = raw.samples.some((s) => s.gpuTimerSupported);
  const anyGpuDisjoint = raw.samples.some((s) => s.gpuTimerDisjoint);

  let gpuStatus: BrowserScenarioResult['gpuFrameRenderTimeMs']['status'];
  let gpuStatistics: BrowserScenarioResult['gpuFrameRenderTimeMs']['statistics'] = null;
  let gpuUnsupportedNotice: UnsupportedMetricNotice | null = null;

  if (!anyGpuSupported) {
    gpuStatus = 'unsupported';
    gpuUnsupportedNotice = {
      metricId: `${scenarioSpec.id}::gpuFrameRenderTimeMs`,
      reason: 'unsupported_by_gpu_driver',
      explanation:
        'EXT_disjoint_timer_query_webgl2 is not exposed by the active WebGL2 driver (common on SwiftShader or security-restricted GPU contexts). No fabricated GPU times were substituted.',
    };
  } else if (anyGpuDisjoint && validGpuSamples.length === 0) {
    gpuStatus = 'disjoint';
    gpuUnsupportedNotice = {
      metricId: `${scenarioSpec.id}::gpuFrameRenderTimeMs`,
      reason: 'disjoint_gpu_timer',
      explanation:
        'GPU timer queries reported GPU_DISJOINT_EXT during the scenario; measurements were invalidated.',
    };
  } else if (validGpuSamples.length === 0) {
    gpuStatus = 'unavailable';
    gpuUnsupportedNotice = {
      metricId: `${scenarioSpec.id}::gpuFrameRenderTimeMs`,
      reason: 'unsupported_by_gpu_driver',
      explanation:
        'EXT_disjoint_timer_query_webgl2 was present, but no completed non-disjoint query results resolved during the measurement window.',
    };
  } else {
    gpuStatus = 'supported';
    gpuStatistics = computeSampleStatistics(validGpuSamples);
  }

  const lastSample = raw.samples[raw.samples.length - 1];
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
    },
    webglDrawCallsPerFrame: drawCallStats,
    renderedTrianglesPerFrame: triangleStats,
    webglResources: {
      driverGeometries: lastSample?.driverGeometries ?? 0,
      driverTextures: lastSample?.driverTextures ?? 0,
      shaderPrograms: lastSample?.driverPrograms ?? 0,
      activeRailwayMeshes: lastSample?.activeRailwayMeshes ?? 0,
      frustumCulledRailwayMeshes: lastSample?.frustumCulledRailwayMeshes ?? 0,
      frustumVisibleRailwayTriangles: lastSample?.frustumVisibleRailwayTriangles ?? 0,
    },
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

  return { result, gpuUnsupportedNotice };
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

  const launchFlags = [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--enable-precise-memory-info',
  ];

  const { baseUrl, stopServer } = await ensureLocalBenchmarkServer(options.serverUrl);
  const playwright = await loadPlaywrightModule();

  let browser: any = null;
  try {
    browser = await playwright.chromium.launch({
      headless: options.headless ?? true,
      args: launchFlags,
    });

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

    await page.evaluate(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    });

    const browserEnvInfo = await page.evaluate(() => {
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
      hardwareAccelerationRequested: true,
      launchFlags,
    });

    const browserResults: BrowserWorkloadBenchmarkResult[] = [];
    const globalUnsupported: UnsupportedMetricNotice[] = [];
    const allErrors: BenchmarkErrorRecord[] = [];
    const seenUnsupportedIds = new Set<string>();

    for (const dataset of datasets) {
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

        const staticSceneGeometry = await page.evaluate(() => {
          const snap = (window as any).__BENCHMARK_HARNESS__.getSnapshot();
          return {
            constructedMeshesCount: snap?.constructedMeshesCount ?? 0,
            sceneVertices: snap?.sceneVertices ?? 0,
            sceneTriangles: snap?.sceneTriangles ?? 0,
            cpuBufferMB: snap?.cpuBufferMB ?? 0,
          };
        });

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
            }) => {
              const harness = (window as any).__BENCHMARK_HARNESS__;
              const samples: RawBrowserFrameSample[] = [];

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

              const collectSingleFrame = (): Promise<RawBrowserFrameSample> => {
                return new Promise((resolve) => {
                  const tFrameStart = performance.now();
                  (window as any).__BENCHMARK_FRAME_COLLECTOR__ = (tel: any) => {
                    (window as any).__BENCHMARK_FRAME_COLLECTOR__ = null;
                    const frameIntervalMs = Number((performance.now() - tFrameStart).toFixed(3));
                    resolve({
                      frameIntervalMs,
                      cpuRenderTimeMs: Number((tel.cpuRenderTimeMs ?? 0).toFixed(3)),
                      renderCalls: tel.renderCalls ?? 0,
                      renderTriangles: tel.renderTriangles ?? 0,
                      driverGeometries: tel.driverGeometries ?? 0,
                      driverTextures: tel.driverTextures ?? 0,
                      driverPrograms: tel.driverPrograms ?? 0,
                      activeRailwayMeshes: tel.activeRailwayMeshes ?? 0,
                      frustumCulledRailwayMeshes: tel.frustumCulledRailwayMeshes ?? 0,
                      frustumVisibleRailwayTriangles: tel.activeFrustumVisibleRailwayTriangles ?? 0,
                      gpuFrameTimeMs: tel.gpuFrameTimeMs ?? null,
                      gpuTimerSupported: Boolean(tel.gpuTimerSupported),
                      gpuTimerDisjoint: Boolean(tel.gpuTimerDisjoint),
                    });
                  };
                });
              };

              let reloadLifecycleAudit: RawScenarioBrowserPayload['reloadLifecycleAudit'] =
                undefined;

              (window as any).__BENCHMARK_ACTIVE__ = true;
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
                    const reloadTiming = await harness.loadOfflineDataset(args.loadParams);
                    reloadAndFirstRenderSamplesMs.push(
                      reloadTiming.totalSceneInitToFirstFrameMs
                    );
                    for (
                      let f = 0;
                      f < framesPerCycle && samples.length < args.measuredFrames;
                      f++
                    ) {
                      samples.push(await collectSingleFrame());
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
                  for (let w = 0; w < args.warmupFrames; w++) {
                    applyStepPose(w, totalSteps);
                    await collectSingleFrame();
                  }
                  for (let m = 0; m < args.measuredFrames; m++) {
                    applyStepPose(args.warmupFrames + m, totalSteps);
                    samples.push(await collectSingleFrame());
                  }
                }
              } finally {
                (window as any).__BENCHMARK_FRAME_COLLECTOR__ = null;
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
            }
          );

          const { result, gpuUnsupportedNotice } = buildScenarioResult(
            scenarioSpec,
            rawPayload
          );
          scenarioResults.push(result);

          if (gpuUnsupportedNotice) {
            workloadUnsupported.push(gpuUnsupportedNotice);
            if (!seenUnsupportedIds.has(gpuUnsupportedNotice.metricId)) {
              seenUnsupportedIds.add(gpuUnsupportedNotice.metricId);
              globalUnsupported.push(gpuUnsupportedNotice);
            }
          }
        }

        browserResults.push({
          dataset: dataset.metadata,
          rendererConfig: config,
          initializationTimingMs,
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

function parseBrowserRunnerCliArgs(argv: string[]): BrowserBenchmarkRunnerOptions {
  let datasetIds: string[] | undefined;
  let configIds: string[] | undefined;
  let scenarioIds: BrowserScenarioKind[] | undefined;
  let warmupFramesOverride: number | undefined;
  let measuredFramesOverride: number | undefined;
  let reloadCyclesOverride: number | undefined;
  let serverUrl: string | undefined;
  let outputPath = 'benchmarks/baselines/browser-baseline.json';
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--datasets' && argv[i + 1]) {
      datasetIds = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--datasets=')) {
      datasetIds = arg.slice('--datasets='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--configs' && argv[i + 1]) {
      configIds = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--configs=')) {
      configIds = arg.slice('--configs='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--scenarios' && argv[i + 1]) {
      scenarioIds = argv[++i].split(',').map((s) => s.trim()) as BrowserScenarioKind[];
    } else if (arg.startsWith('--scenarios=')) {
      scenarioIds = arg.slice('--scenarios='.length).split(',').map((s) => s.trim()) as BrowserScenarioKind[];
    } else if (arg === '--warmup-frames' && argv[i + 1]) {
      warmupFramesOverride = Math.max(0, parseInt(argv[++i], 10));
    } else if (arg === '--measured-frames' && argv[i + 1]) {
      measuredFramesOverride = Math.max(1, parseInt(argv[++i], 10));
    } else if (arg === '--reload-iterations' && argv[i + 1]) {
      reloadCyclesOverride = Math.max(1, parseInt(argv[++i], 10));
    } else if (arg === '--url' && argv[i + 1]) {
      serverUrl = argv[++i];
    } else if (arg.startsWith('--url=')) {
      serverUrl = arg.slice('--url='.length);
    } else if (arg === '--out' && argv[i + 1]) {
      outputPath = argv[++i];
    } else if (arg.startsWith('--out=')) {
      outputPath = arg.slice('--out='.length);
    } else if (arg === '--no-save') {
      outputPath = '';
    } else if (arg === '--quiet') {
      quiet = true;
    } else if (arg === '--quick') {
      warmupFramesOverride = 4;
      measuredFramesOverride = 12;
      reloadCyclesOverride = 2;
      configIds = configIds ?? ['production-legacy', 'surface-first-e2plus-rplus'];
      datasetIds = datasetIds ?? ['small-real-europatunnel', 'synthetic-stress-urban-switchyard'];
    }
  }

  return {
    datasetIds,
    configIds,
    scenarioIds,
    warmupFramesOverride,
    measuredFramesOverride,
    reloadCyclesOverride,
    serverUrl,
    outputPath: outputPath || undefined,
    quiet,
  };
}

const isMainModule =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  (process.argv[1].endsWith('benchmarks/browserRunner.ts') ||
    process.argv[1].endsWith('benchmarks\\browserRunner.ts'));

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
