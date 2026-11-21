import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeSampleStatistics } from './stats';
import { resolveChromiumLaunchArgs } from './browserRunner';
import { isSoftwareWebGLRenderer } from './environment';
import { verifyRegionalMosaic } from '../scripts/verify-regional-mosaic';
import {
  CANONICAL_HENGELO_SNAPSHOT_ID,
  CANONICAL_HENGELO_SOURCE_SHA256,
} from '../src/world/tiling/TilePackContract';
import type { BenchmarkFrameTelemetry } from '../src/types/BenchmarkTelemetry';
import type { SceneMeshCountsSnapshot } from './tileStreamingRunner';
import type { TileStreamDiagnosticsSnapshot } from '../src/world/tiling/TileStreamManager';

export type RegionalExperiment = 'baseline' | 'viewport' | 'zoom' | 'both';
export interface RegionalFrameCostCli {
  serverUrl: string;
  mosaicIndex: string;
  runs: number;
  warmupFrames: number;
  measuredFrames: number;
  compare: 'none' | 'viewport' | 'zoom' | 'both';
  requireHardware: boolean;
  outputPath: string;
  markdownPath: string;
}

export function parseRegionalFrameCostCli(argv: readonly string[] = process.argv.slice(2)): RegionalFrameCostCli {
  const opts: RegionalFrameCostCli = {
    serverUrl: 'http://localhost:3000',
    mosaicIndex: path.resolve('data/osm/twente-pilot-1024m/mosaic.json'),
    runs: 3,
    warmupFrames: 12,
    measuredFrames: 120,
    compare: 'none',
    requireHardware: true,
    outputPath: path.resolve('benchmarks/results/tkt031-regional-frame-cost.json'),
    markdownPath: path.resolve('benchmarks/results/tkt031-regional-frame-cost.md'),
  };
  for (const arg of argv) {
    if (arg === '--allow-software') {
      opts.requireHardware = false;
      continue;
    }
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq <= 2) throw new Error('Expected --key=value, got ' + arg);
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    if (!value) throw new Error('Empty option ' + key);
    if (key === 'url') {
      const u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('url must use HTTP(S)');
      opts.serverUrl = u.toString().replace(/\/$/, '');
    } else if (key === 'index') opts.mosaicIndex = path.resolve(value);
    else if (key === 'runs' || key === 'warmup-frames' || key === 'measured-frames') {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1 || n > 10000) throw new Error(key + ' must be an integer between 1 and 10000');
      if (key === 'runs') opts.runs = n;
      if (key === 'warmup-frames') opts.warmupFrames = n;
      if (key === 'measured-frames') opts.measuredFrames = n;
    } else if (key === 'compare') {
      if (value !== 'none' && value !== 'viewport' && value !== 'zoom' && value !== 'both') {
        throw new Error('compare must be none, viewport, zoom or both');
      }
      opts.compare = value;
    } else if (key === 'out') opts.outputPath = path.resolve(value);
    else if (key === 'markdown-out') opts.markdownPath = path.resolve(value);
    else throw new Error('Unknown regional performance option --' + key);
  }
  return opts;
}

type PhaseId = 'street' | 'city' | 'region' | 'active_teleport' | 'settled_after_teleport';
interface PhasePayload {
  phase: PhaseId;
  samples: BenchmarkFrameTelemetry[];
  meshCounts: SceneMeshCountsSnapshot | null;
  diagnostics: TileStreamDiagnosticsSnapshot | null;
  camera: unknown;
}
interface PhaseSummary {
  phase: PhaseId;
  frame: ReturnType<typeof computeSampleStatistics>;
  cpuRender: ReturnType<typeof computeSampleStatistics>;
  calls: ReturnType<typeof computeSampleStatistics>;
  triangles: ReturnType<typeof computeSampleStatistics>;
  gpu: { status: string; validSamples: number; statistics: ReturnType<typeof computeSampleStatistics> | null };
  samples: number;
  meshCounts: SceneMeshCountsSnapshot | null;
  diagnostics: TileStreamDiagnosticsSnapshot | null;
  camera: unknown;
}

function summarizePhase(raw: PhasePayload): PhaseSummary {
  const validGpu = raw.samples
    .filter((s) => s.gpuTimerStatus === 'valid' && !s.gpuDisjointOccurred &&
      typeof s.gpuPassTimeMs === 'number' && Number.isFinite(s.gpuPassTimeMs))
    .map((s) => s.gpuPassTimeMs!);
  const statuses = new Set(raw.samples.map((s) => s.gpuTimerStatus));
  const status = validGpu.length ? 'supported' :
    statuses.has('disjoint') ? 'disjoint' :
    statuses.has('unsupported') ? 'unsupported' : 'unavailable';
  return {
    phase: raw.phase,
    frame: computeSampleStatistics(raw.samples.map((s) => s.frameIntervalMs)),
    cpuRender: computeSampleStatistics(raw.samples.map((s) => s.cpuRenderTimeMs)),
    calls: computeSampleStatistics(raw.samples.map((s) => s.renderCalls)),
    triangles: computeSampleStatistics(raw.samples.map((s) => s.renderTriangles)),
    gpu: {
      status,
      validSamples: validGpu.length,
      statistics: validGpu.length ? computeSampleStatistics(validGpu) : null,
    },
    samples: raw.samples.length,
    meshCounts: raw.meshCounts,
    diagnostics: raw.diagnostics,
    camera: raw.camera,
  };
}

interface RegionalRun {
  repetition: number;
  experiment: RegionalExperiment;
  phases: PhaseSummary[];
}
export interface RegionalFrameCostReport {
  ticket: 'TKT-031';
  schemaVersion: 1;
  createdAt: string;
  source: {
    indexPath: string;
    verifiedShards: number;
    verifiedTiles: number;
    nonEmptyTiles: number;
    apiTileCount: number;
    snapshotId: string;
  };
  environment: {
    serverUrl: string;
    browserVersion: string;
    gpuVendor: string;
    gpuRenderer: string;
    softwareRenderer: boolean;
    viewport: string;
    dpr: number;
    theme: string;
    tileSizeMeters: number;
    preloadMeters: number;
    retainMeters: number;
    shadows: 'unchanged';
  };
  protocol: {
    compare: RegionalFrameCostCli['compare'];
    runs: number;
    warmupFrames: number;
    measuredFrames: number;
    backend: string;
    notes: string[];
  };
  runs: RegionalRun[];
}

export function formatRegionalFrameCostMarkdown(report: RegionalFrameCostReport): string {
  const lines = [
    '# TKT-031 — Regional Frame Cost (16 km OSMTILE1)',
    '',
    '- Date: ' + report.createdAt,
    '- Mosaic: ' + report.source.verifiedTiles + ' verified tiles / ' + report.source.verifiedShards + ' shards; ' +
      report.source.nonEmptyTiles + ' non-empty; snapshot ' + report.source.snapshotId,
    '- GPU: ' + report.environment.gpuRenderer +
      (report.environment.softwareRenderer ? ' (SOFTWARE — not a hardware speed result)' : ' (HARDWARE)'),
    '- Viewport: ' + report.environment.viewport + ', DPR ' + report.environment.dpr +
      '; shadows ' + report.environment.shadows,
    '- Streaming margins: preload ' + report.environment.preloadMeters +
      'm / retain ' + report.environment.retainMeters + 'm',
    '- Design: ' + report.protocol.runs + ' repeated runs, ' +
      report.protocol.measuredFrames + ' measured frames per steady phase, compare=' + report.protocol.compare,
    '',
    'The material-group columns below are **estimates from the main-camera frustum**, not observed WebGL calls. ' +
      'Actual WebGL calls include other render passes (notably shadows). GPU timer data is omitted when unsupported.',
    '',
    '| Run | Variant | Phase | Frame median / p95 / p99 (ms) | CPU render median (ms) | WebGL calls median | Main-pass group proxy | GPU timer | Loaded tiles | Viewport scans / skips | Zoom skips |',
    '|---|---|---|---|---:|---:|---:|---|---:|---|---:|',
  ];
  for (const run of report.runs) {
    for (const p of run.phases) {
      lines.push(
        '| ' + run.repetition + ' | ' + run.experiment + ' | ' + p.phase +
        ' | ' + p.frame.median.toFixed(2) + ' / ' + p.frame.p95.toFixed(2) + ' / ' + p.frame.p99.toFixed(2) +
        ' | ' + p.cpuRender.median.toFixed(2) +
        ' | ' + p.calls.median.toFixed(0) +
        ' | ' + (p.meshCounts?.drawWorkEstimate?.total.mainPassSubmissions ?? 'n/a') +
        ' | ' + (p.gpu.statistics ? p.gpu.statistics.median.toFixed(2) + ' ms' : p.gpu.status) +
        ' | ' + (p.diagnostics?.loadedTiles ?? 'n/a') +
        ' | ' + (p.diagnostics ? p.diagnostics.viewportSelectionPasses + ' / ' + p.diagnostics.viewportSelectionSkips : 'n/a') +
        ' | ' + (p.diagnostics?.zoomPropagationSkips ?? 'n/a') + ' |'
      );
    }
  }
  lines.push('', '## Per-layer main-camera render-work proxy', '',
    'These are potential material-group submissions; do not interpret them as exact per-layer GPU draw-call or shadow-pass counts.', '');
  for (const run of report.runs) {
    for (const phase of run.phases) {
      const byLayer = phase.meshCounts?.drawWorkEstimate?.byLayer;
      if (!byLayer) continue;
      lines.push('### Run ' + run.repetition + ' / ' + run.experiment + ' / ' + phase.phase, '',
        '| Layer | Main-pass group proxy | Shadow-casting candidates (main frustum only) | Drawable meshes |',
        '|---|---:|---:|---:|');
      for (const [layer, stats] of Object.entries(byLayer)) {
        lines.push('| ' + layer + ' | ' + stats.mainPassSubmissions + ' | ' +
          stats.mainFrustumShadowCasterSubmissions + ' | ' + stats.drawableMeshes + ' |');
      }
      lines.push('');
    }
  }
  lines.push('## Interpretation limits', '',
    '- The 16 km mosaic is verified for binary/manifest integrity; cross-shard visual fidelity is a separate human acceptance gate.',
    '- Camera poses: street [0,0,0] zoom 6.5, city [0,0,0] zoom 0.65, region [0,0,0] zoom 0.05, ' +
      'teleport [-5500,0,-3500] to [5500,0,3500] at zoom 2.2; azimuth 45°.',
    '- Teleport is a loading-stress scenario, not a smooth continuous-pan measurement.',
    '- VSync/frame caps may mask small FPS improvements. Compare CPU render and actual GL calls alongside frame intervals.',
    '- Frame instrumentation and browser execution may add overhead; verify candidates in normal interactive mode.',
    '- No geometry, tile size, LOD, render settings, shadow policy, or source data were changed by this benchmark.',
    '');
  return lines.join('\n');
}

/**
 * Runs against an explicitly started local dev server and an already-verified
 * regional bake. Never bakes data or substitutes a synthetic region.
 */
export async function runRegionalFrameCostBenchmark(opts: RegionalFrameCostCli): Promise<RegionalFrameCostReport> {
  if (!fs.existsSync(opts.mosaicIndex)) {
    throw new Error('Regional mosaic index is missing: ' + opts.mosaicIndex +
      '. Complete TKT-029 bake and run npm run osm:verify-regional-mosaic first.');
  }
  // This validates every shard's hashes and every tile payload before benchmarking.
  const verified = verifyRegionalMosaic(opts.mosaicIndex);
  if (verified.tiles !== 256 || verified.shards !== 16) {
    throw new Error('TKT-031 expects complete 16-shard / 256-tile pilot mosaic.');
  }
  let manifest: any;
  try {
    const resp = await fetch(opts.serverUrl + '/api/tiles-region/manifest');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    manifest = await resp.json();
  } catch (err) {
    throw new Error('Regional API unavailable at ' + opts.serverUrl +
      '. Start npm run dev in a separate terminal. Cause: ' + String(err));
  }
  if (!manifest?.metadata || !Array.isArray(manifest?.tiles) ||
      manifest.tiles.length !== verified.tiles ||
      manifest.metadata.gridCols !== 16 || manifest.metadata.gridRows !== 16 ||
      manifest.metadata.tileSizeMeters !== 1024 ||
      manifest.metadata.snapshotId !== CANONICAL_HENGELO_SNAPSHOT_ID ||
      manifest.metadata.sourceSha256 !== CANONICAL_HENGELO_SOURCE_SHA256) {
    throw new Error('Regional API manifest does not match the complete validated 16x16 1024m pilot.');
  }
  const playwrightName = 'playwright';
  let playwright: any;
  try {
    playwright = await import(playwrightName);
  } catch {
    throw new Error('Playwright is required for the regional benchmark. ' +
      'Install the project benchmark dependencies and Chromium first.');
  }
  const browser = await playwright.chromium.launch({
    headless: true,
    args: resolveChromiumLaunchArgs(),
  });
  const runs: RegionalRun[] = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.on('pageerror', (err: Error) => console.error('[regional:perf] Browser error:', err.message));
    await page.addInitScript('window.__name = (fn) => fn;');
    await page.goto(opts.serverUrl + '/?benchmark=1&dock=collapsed', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForFunction(
      () => Boolean((window as any).__BENCHMARK_HARNESS__ && document.querySelector('canvas')),
      { timeout: 30000 }
    );

    const gpu = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
      if (!gl) throw new Error('Regional benchmark requires WebGL2');
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        vendor: String(gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
        renderer: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      };
    });
    const software = isSoftwareWebGLRenderer(gpu.renderer);
    if (opts.requireHardware && software) {
      throw new Error('Hardware GPU required, but Chromium selected software renderer: ' + gpu.renderer);
    }

    const experiments: RegionalExperiment[] =
      opts.compare === 'none' ? ['baseline'] : ['baseline', opts.compare];

    for (let repetition = 1; repetition <= opts.runs; repetition++) {
      // Alternate execution order to avoid systematically favoring warm caches.
      const order = repetition % 2 ? experiments : [...experiments].reverse();
      for (const experiment of order) {
        console.log('[regional:perf] Run ' + repetition + '/' + opts.runs + ', ' + experiment);
        await page.evaluate(async (flags: { viewport: boolean; zoom: boolean }) => {
          const h = (window as any).__BENCHMARK_HARNESS__;
          await h.unloadDataset();
          await h.loadM2aStreaming({
            apiBaseUrl: '/api/tiles-region',
            preloadMarginTiles: 0.5,
            retainMarginTiles: 1,
            experimentSkipUnchangedViewport: flags.viewport,
            experimentSkipUnchangedZoom: flags.zoom,
            themeId: 'tactical',
            target: [0, 0, 0],
            zoom: 1.8,
            azimuthDeg: 45,
            waitForIdle: true,
            timeoutMs: 300000,
          });
        }, {
          viewport: experiment === 'viewport' || experiment === 'both',
          zoom: experiment === 'zoom' || experiment === 'both',
        });

        const phases: PhaseSummary[] = [];
        const scenarios: Array<{ phase: PhaseId; zoom: number }> = [
          { phase: 'street', zoom: 6.5 },
          { phase: 'city', zoom: 0.65 },
          { phase: 'region', zoom: 0.05 },
        ];
        for (const scenario of scenarios) {
          const raw: PhasePayload = await page.evaluate(async (args: {
            phase: PhaseId; zoom: number; warmup: number; measured: number;
          }) => {
            const h = (window as any).__BENCHMARK_HARNESS__;
            h.setCameraPose([0, 0, 0], args.zoom, 45);
            await h.waitForM2aIdle();
            h.resetM2aPerfCounters();
            const frames: BenchmarkFrameTelemetry[] = [];
            let onFrame: (() => void) | null = null;
            (window as any).__BENCHMARK_RESET_GPU_TIMERS__?.();
            (window as any).__BENCHMARK_ACTIVE__ = true;
            (window as any).__BENCHMARK_FRAME_COLLECTOR__ = (sample: BenchmarkFrameTelemetry) => {
              frames.push(sample);
              if (onFrame) {
                const r = onFrame;
                onFrame = null;
                r();
              }
            };
            try {
              const total = args.warmup + args.measured;
              for (let i = 0; i < total; i++) {
                (window as any).__BENCHMARK_COLLECTOR_META__ = {
                  phase: i < args.warmup ? 'warmup' : 'measured',
                  frameIndex: i < args.warmup ? i : i - args.warmup,
                  totalMeasuredFrames: args.measured,
                  samplingStride: 4,
                };
                await new Promise<void>((resolve) => { onFrame = resolve; });
              }
            } finally {
              (window as any).__BENCHMARK_FRAME_COLLECTOR__ = null;
              (window as any).__BENCHMARK_COLLECTOR_META__ = undefined;
              (window as any).__BENCHMARK_ACTIVE__ = false;
            }
            return {
              phase: args.phase,
              samples: frames.slice(args.warmup),
              meshCounts: h.getSceneMeshCounts(),
              diagnostics: h.getTileStreamDiagnostics(),
              camera: (window as any).__BENCHMARK_GET_CAMERA_STATE__?.() ?? null,
            };
          }, {
            phase: scenario.phase,
            zoom: scenario.zoom,
            warmup: opts.warmupFrames,
            measured: opts.measuredFrames,
          });
          phases.push(summarizePhase(raw));
          console.log('[regional:perf] ' + scenario.phase + ' frame median ' +
            phases[phases.length - 1].frame.median.toFixed(2) + 'ms');
        }

        const teleport = await page.evaluate(async (args: { measured: number; warmup: number }) => {
          const h = (window as any).__BENCHMARK_HARNESS__;
          h.setCameraPose([-5500, 0, -3500], 2.2, 45);
          await h.waitForM2aIdle();
          h.resetM2aPerfCounters();
          const samples: BenchmarkFrameTelemetry[] = [];
          (window as any).__BENCHMARK_RESET_GPU_TIMERS__?.();
          (window as any).__BENCHMARK_ACTIVE__ = true;
          (window as any).__BENCHMARK_COLLECTOR_META__ = {
            phase: 'measured', frameIndex: 1, totalMeasuredFrames: 1000, samplingStride: 999,
          };
          (window as any).__BENCHMARK_FRAME_COLLECTOR__ = (sample: BenchmarkFrameTelemetry) => {
            if (samples.length < 1500) samples.push(sample);
          };
          try {
            h.setCameraPose([5500, 0, 3500], 2.2, 45);
            // Do not call waitForM2aIdle(): it uses an unlimited commit
            // budget and would distort the active-streaming jank measurement.
            // Let the normal render loop perform its 4-tile/frame commits.
            let idleFrames = 0;
            const startedAt = performance.now();
            for (let frame = 0; frame < 1800; frame++) {
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
              const diag = h.getTileStreamDiagnostics();
              idleFrames = diag?.loadingTiles === 0 ? idleFrames + 1 : 0;
              if (idleFrames >= 3) break;
              if (performance.now() - startedAt > 180000) {
                throw new Error('Timed out waiting for regional teleport streaming');
              }
            }
            if (idleFrames < 3) {
              throw new Error('Regional teleport did not settle within 1800 frames');
            }
          } finally {
            (window as any).__BENCHMARK_FRAME_COLLECTOR__ = null;
            (window as any).__BENCHMARK_COLLECTOR_META__ = undefined;
            (window as any).__BENCHMARK_ACTIVE__ = false;
          }
          const active = {
            phase: 'active_teleport' as PhaseId,
            samples,
            meshCounts: h.getSceneMeshCounts(),
            diagnostics: h.getTileStreamDiagnostics(),
            camera: (window as any).__BENCHMARK_GET_CAMERA_STATE__?.() ?? null,
          };
          const more: BenchmarkFrameTelemetry[] = [];
          let resolveFrame: (() => void) | null = null;
          (window as any).__BENCHMARK_ACTIVE__ = true;
          (window as any).__BENCHMARK_FRAME_COLLECTOR__ = (sample: BenchmarkFrameTelemetry) => {
            more.push(sample);
            if (resolveFrame) { const r = resolveFrame; resolveFrame = null; r(); }
          };
          try {
            for (let i = 0; i < args.warmup + args.measured; i++) {
              (window as any).__BENCHMARK_COLLECTOR_META__ = {
                phase: i < args.warmup ? 'warmup' : 'measured',
                frameIndex: i,
                totalMeasuredFrames: args.measured, samplingStride: 4,
              };
              await new Promise<void>((r) => { resolveFrame = r; });
            }
          } finally {
            (window as any).__BENCHMARK_FRAME_COLLECTOR__ = null;
            (window as any).__BENCHMARK_COLLECTOR_META__ = undefined;
            (window as any).__BENCHMARK_ACTIVE__ = false;
          }
          return {
            active,
            settled: {
              phase: 'settled_after_teleport' as PhaseId,
              samples: more.slice(args.warmup),
              meshCounts: h.getSceneMeshCounts(),
              diagnostics: h.getTileStreamDiagnostics(),
              camera: (window as any).__BENCHMARK_GET_CAMERA_STATE__?.() ?? null,
            },
          };
        }, { measured: opts.measuredFrames, warmup: opts.warmupFrames });
        if (teleport.active.samples.length > 0) phases.push(summarizePhase(teleport.active));
        phases.push(summarizePhase(teleport.settled));
        runs.push({ repetition, experiment, phases });
      }
    }
    const report: RegionalFrameCostReport = {
      ticket: 'TKT-031',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      source: {
        indexPath: opts.mosaicIndex,
        verifiedShards: verified.shards,
        verifiedTiles: verified.tiles,
        nonEmptyTiles: verified.nonEmptyTiles,
        apiTileCount: manifest.tiles.length,
        snapshotId: manifest.metadata.snapshotId,
      },
      environment: {
        serverUrl: opts.serverUrl,
        browserVersion: browser.version(),
        gpuVendor: gpu.vendor,
        gpuRenderer: gpu.renderer,
        softwareRenderer: software,
        viewport: '1440x900',
        dpr: 1,
        theme: 'tactical',
        tileSizeMeters: 1024,
        preloadMeters: 512,
        retainMeters: 1024,
        shadows: 'unchanged',
      },
      protocol: {
        compare: opts.compare,
        runs: opts.runs,
        warmupFrames: opts.warmupFrames,
        measuredFrames: opts.measuredFrames,
        backend: 'Chromium WebGL2',
        notes: [
          'Real canonical TKT-029 mosaic only; no regional data was synthesized or baked.',
          'Main-camera material group attribution is estimated and cannot include exact shadow draw calls.',
          'Foliage culling and railway chunk size were not altered.',
          'Frame intervals may be VSync limited; do not infer GPU throughput from frame intervals alone.',
          'Teleport-stress and settled phases must be interpreted separately.',
        ],
      },
      runs,
    };
    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
    fs.mkdirSync(path.dirname(opts.markdownPath), { recursive: true });
    fs.writeFileSync(opts.outputPath, JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(opts.markdownPath, formatRegionalFrameCostMarkdown(report));
    console.log('[regional:perf] JSON: ' + opts.outputPath);
    console.log('[regional:perf] Markdown: ' + opts.markdownPath);
    await context.close();
    return report;
  } finally {
    await browser.close();
  }
}

const isEntrypoint = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  runRegionalFrameCostBenchmark(parseRegionalFrameCostCli()).catch((err) => {
    console.error('[regional:perf] Failed:', err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
