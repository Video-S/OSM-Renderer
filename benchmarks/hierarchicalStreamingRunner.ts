/**
 * Reproducible Hierarchical Tile Streaming Benchmark & Validation Runner (TKT-041)
 *
 * Evaluates uniform-viewport zoom-dependent tile resolution switching (1,024 m / 2,048 m /
 * 4,096 m) over a single hierarchical mosaic descriptor (or three compatible mosaic.json
 * indexes) while preserving TKT-040 `combined` preparation as the default optimized path.
 *
 * Usage (Windows PowerShell / Linux / macOS — invoke directly with `npx tsx`):
 *   npx tsx benchmarks/hierarchicalStreamingRunner.ts --descriptor=data/twente-hierarchical.json --foliage=both
 *   npx tsx benchmarks/hierarchicalStreamingRunner.ts --index-1024=... --index-2048=... --index-4096=... --foliage=both
 *   npx tsx benchmarks/hierarchicalStreamingRunner.ts --descriptor=... --allow-software --quick
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
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
import {
  HIERARCHICAL_MOSAIC_SCHEMA_TYPE,
  HIERARCHICAL_MOSAIC_SCHEMA_VERSION,
  type HierarchicalRegionalMosaicDescriptor,
} from '../src/world/tiling/HierarchicalMosaicContract';
import type { HierarchicalResolutionMode } from '../src/world/tiling/HierarchicalResolutionPolicy';
import { REGIONAL_MIN_ZOOM_QUERY_PARAM } from '../src/scene/cameraZoomPolicy';
import {
  computeStreamingFrameDistribution,
  type StreamingFrameDistribution,
} from '../src/world/tiling/StreamingFluidityStats';
import type { StreamingProfilerSnapshot } from '../src/world/tiling/StreamingProfiler';
import type { HierarchicalStreamingDiagnosticsSnapshot } from '../src/world/tiling/TileStreamManager';
import type { RegionalMosaicIndex } from '../src/world/tiling/RegionalMosaicPlan';

export type HierarchicalFoliageFilter = 'both' | 'on' | 'off';

export interface HierarchicalBenchmarkCli {
  descriptorPath: string | null;
  index1024Path: string | null;
  index2048Path: string | null;
  index4096Path: string | null;
  foliage: HierarchicalFoliageFilter;
  themeId: string;
  requireHardware: boolean;
  gpuBackend: ChromiumGpuBackend;
  outputPath: string;
  markdownPath: string;
  quick: boolean;
}

export interface HierarchicalScenarioMetrics {
  foliageEnabled: boolean;
  scenarioId: string;
  description: string;
  durationMs: number;
  frameDistribution: StreamingFrameDistribution;
  transitionsStartedDelta: number;
  transitionsCompletedDelta: number;
  transitionsCancelledDelta: number;
  transitionsDeferredBudgetDelta: number;
  cacheHitsDelta: number;
  cacheEvictionsDelta: number;
  maxActivationSwapMs: number;
  lastActivationSwapMs: number;
  endActiveResolutionMeters: number;
  maxSimultaneousAttachedResolutions: number;
  singleResolutionInvariantPassed: boolean;
  peakMeasuredCpuBytes: number;
  peakEstimatedGpuBytes: number;
  medianDrawCalls: number;
  medianTriangles: number;
  hysteresisZeroTransitionsPassed?: boolean;
}

export interface HierarchicalPickingParityResult {
  foliageEnabled: boolean;
  resolutions: Array<{
    resolutionMeters: number;
    medianPickMs: number;
    p95PickMs: number;
    hitCount: number;
    sampleCount: number;
    hitFeatureIds: Array<string | null>;
  }>;
  comparedPointCount: number;
  parityMatchCount: number;
  parityRatio: number;
}

export interface HierarchicalModeComparisonEntry {
  foliageEnabled: boolean;
  poseLabel: 'Street' | 'Mid' | 'Regional';
  zoom: number;
  mode: HierarchicalResolutionMode;
  activeResolutionMeters: number;
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
  gpuVendor: string;
  gpuRenderer: string;
  isSoftwareRenderer: boolean;
  softwareRendererWarning: string | null;
  scenarios: HierarchicalScenarioMetrics[];
  pickingParity: HierarchicalPickingParityResult[];
  modeComparisons: HierarchicalModeComparisonEntry[];
}

export function parseHierarchicalBenchmarkCli(
  argv: readonly string[] = process.argv.slice(2)
): HierarchicalBenchmarkCli {
  const opts: HierarchicalBenchmarkCli = {
    descriptorPath: null,
    index1024Path: null,
    index2048Path: null,
    index4096Path: null,
    foliage: 'both',
    themeId: 'daylight',
    requireHardware: true,
    gpuBackend: 'auto',
    outputPath: path.resolve('benchmarks/results/tkt041-hierarchical-streaming.json'),
    markdownPath: path.resolve('benchmarks/results/tkt041-hierarchical-streaming.md'),
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
  // Place descriptor in the common ancestor directory so all relative index paths stay inside descriptorRoot
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
    '# TKT-041 Hierarchical Tile Streaming Benchmark Report',
    '',
    `- **Generated:** ${report.generatedAtIso}`,
    `- **Hierarchy:** \`${report.hierarchyName}\` (${report.availableResolutionsMeters.map((r) => `${r} m`).join(' / ')})`,
    `- **Viewport:** ${report.viewport.width} × ${report.viewport.height} @ DPR ${report.viewport.deviceScaleFactor} | **Theme:** \`${report.themeId}\``,
    `- **WebGL Renderer:** \`${report.gpuRenderer}\` (${report.gpuVendor})`,
    `- **Renderer Classification:** ${
      report.isSoftwareRenderer
        ? '**SOFTWARE RASTERIZER (SwiftShader — validates correctness, transition orchestration, picking parity, and memory accounting; frame intervals DO NOT represent RTX hardware GPU performance)**'
        : 'Hardware WebGL2 GPU'
    }`,
    '',
  ];

  if (report.softwareRendererWarning) {
    lines.push(`> **Warning:** ${report.softwareRendererWarning}`, '');
  }

  lines.push(
    '## Transition, Stability, and Memory Scenarios',
    '',
    '| Foliage | Scenario | Frame med / p95 / max (ms) | >6.94ms (144Hz) | Transitions (start/done/cancel/defer) | Cache Hits / Evicts | Max Swap (ms) | Peak Measured CPU/BVH (MiB) | Peak Est. GPU (MiB) | Single-Res Invariant |',
    '|---|---|---:|---:|---|---:|---:|---:|---:|---|'
  );
  for (const s of report.scenarios) {
    const fd = s.frameDistribution;
    const over144Pct =
      fd.thresholdExceedances.find((t) => Math.abs(t.thresholdMs - 6.94) < 0.05)
        ?.pct ?? 0;
    const fLabel = s.foliageEnabled ? 'ON' : 'OFF';
    const inv =
      s.hysteresisZeroTransitionsPassed !== undefined
        ? `${s.singleResolutionInvariantPassed ? 'PASS' : 'FAIL'} (0-osc: ${s.hysteresisZeroTransitionsPassed ? 'PASS' : 'FAIL'})`
        : s.singleResolutionInvariantPassed
          ? 'PASS'
          : 'FAIL';
    lines.push(
      `| ${fLabel} | \`${s.scenarioId}\` | ${fd.median.toFixed(2)} / ${fd.p95.toFixed(2)} / ${fd.max.toFixed(2)} | ${over144Pct.toFixed(1)}% | ${s.transitionsStartedDelta} / ${s.transitionsCompletedDelta} / ${s.transitionsCancelledDelta} / ${s.transitionsDeferredBudgetDelta} | ${s.cacheHitsDelta} / ${s.cacheEvictionsDelta} | ${s.maxActivationSwapMs.toFixed(2)} | ${(s.peakMeasuredCpuBytes / (1024 * 1024)).toFixed(2)} | ${(s.peakEstimatedGpuBytes / (1024 * 1024)).toFixed(2)} | ${inv} |`
    );
  }
  lines.push('');

  if (report.pickingParity.length > 0) {
    lines.push(
      '## Feature Picking Latency & Cross-Resolution Parity',
      '',
      '| Foliage | Resolution | Median Pick (ms) | P95 Pick (ms) | Hits / Samples | Cross-Resolution Parity |',
      '|---|---:|---:|---:|---:|---:|'
    );
    for (const p of report.pickingParity) {
      const fLabel = p.foliageEnabled ? 'ON' : 'OFF';
      for (let i = 0; i < p.resolutions.length; i++) {
        const r = p.resolutions[i];
        const parityCol =
          i === 0
            ? `${p.parityMatchCount}/${p.comparedPointCount} (${(p.parityRatio * 100).toFixed(1)}%)`
            : '—';
        lines.push(
          `| ${fLabel} | ${r.resolutionMeters} m | ${r.medianPickMs.toFixed(3)} | ${r.p95PickMs.toFixed(3)} | ${r.hitCount}/${r.sampleCount} | ${parityCol} |`
        );
      }
    }
    lines.push('');
  }

  if (report.modeComparisons.length > 0) {
    lines.push(
      '## Auto vs. Forced Single-Resolution Mode Comparison',
      '',
      '| Foliage | Pose | Zoom | Mode | Active Res | Frame med / p95 (ms) | Median Draw Calls | Median Triangles | Measured CPU/BVH (MiB) | Est. GPU (MiB) |',
      '|---|---|---:|---|---:|---:|---:|---:|---:|---:|'
    );
    for (const c of report.modeComparisons) {
      const fLabel = c.foliageEnabled ? 'ON' : 'OFF';
      lines.push(
        `| ${fLabel} | ${c.poseLabel} | ${c.zoom.toFixed(2)} | \`${c.mode}\` | ${c.activeResolutionMeters} m | ${c.frameDistribution.median.toFixed(2)} / ${c.frameDistribution.p95.toFixed(2)} | ${c.medianDrawCalls.toFixed(0)} | ${c.medianTriangles.toFixed(0)} | ${c.measuredCpuMiB.toFixed(2)} | ${c.estimatedGpuMiB.toFixed(2)} |`
      );
    }
    lines.push('');
  }

  lines.push(
    '## Notes & Accounting Caveats',
    '',
    '- **Directly measured memory (`Measured CPU/BVH`)** sums JS typed-array vertex/index/instance buffers, serialized mesh BVHs, `InstancedSpatialIndex` buffers, queued payloads, and detached inactive LRU cache tiles.',
    '- **Estimated GPU memory (`Est. GPU`)** is an explicit upper-bound estimate of uploaded WebGL vertex/index/instance buffers; browsers do not expose exact driver VRAM residency.',
    '- **Provisional zoom hysteresis bands** (`1024↔2048`: out `< 0.80` / in `> 1.00`, `2048↔4096`: out `< 0.26` / in `> 0.34`, viewport-width normalized to 1,280 px) remain subject to tuning on the owner’s full Twente dataset.',
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

  const playwright = await import('playwright');
  const server = await startHierarchicalServer(descriptorPath);

  try {
    // Verify manifest first over HTTP
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
        ? `Executed on software WebGL renderer (${gpuInfo.gpuRenderer}). Resolution switching, zero-overlap invariants, hysteresis stability, picking parity, and measured memory accounting are valid, but frame intervals reflect software rasterization rather than hardware GPU performance.`
        : null;

      // Load the hierarchical regional mosaic at canonical center [0, 0, 0]
      await page.evaluate(
        async ({ themeId }) => {
          const h = (window as any).__BENCHMARK_HARNESS__;
          h.setStreamingProfilerEnabled(false);
          await h.unloadDataset?.();
          await h.loadM2aStreaming({
            apiBaseUrl: '/api/tiles-region',
            themeId,
            target: [0, 0, 0],
            zoom: 1.5,
            azimuthDeg: 45,
            regionalMinZoom: 0.15,
            tilePreparationOptions: 'combined',
            waitForIdle: true,
            timeoutMs: 120000,
          });
        },
        { themeId: opts.themeId }
      );

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
      const modeMeasureMs = opts.quick ? 600 : 1400;

      for (const foliageEnabled of foliageConfigs) {
        console.log(
          `[bench:hierarchical] Running scenarios (foliage=${foliageEnabled ? 'ON' : 'OFF'})...`
        );

        await page.evaluate(
          async ({ showFoliage }) => {
            const h = (window as any).__BENCHMARK_HARNESS__;
            h.setShowFoliage(showFoliage);
            h.setHierarchicalConfig({ mode: 'auto' });
            h.setCameraPose([0, 0, 0], 1.6, 45);
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            await h.waitForM2aIdle();
          },
          { showFoliage: foliageEnabled }
        );

        const runTimedScenario = async (params: {
          scenarioId: string;
          description: string;
          waypoints: Array<{ target: [number, number, number]; zoom: number; holdMs: number }>;
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

            const sampleState = () => {
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
              const hd = h.getHierarchicalDiagnostics() as HierarchicalStreamingDiagnosticsSnapshot | null;
              if (hd) {
                if (hd.resources.totalMeasuredBytes > peakMeasuredCpuBytes) {
                  peakMeasuredCpuBytes = hd.resources.totalMeasuredBytes;
                }
                if (
                  hd.resources.totalEstimatedGpuBytes > peakEstimatedGpuBytes
                ) {
                  peakEstimatedGpuBytes = hd.resources.totalEstimatedGpuBytes;
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
            };
          }, params);

          const frames = result.snap.frames;
          const frameDistribution = computeStreamingFrameDistribution(
            frames.map((f) => f.frameIntervalMs)
          );
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

          const entry: HierarchicalScenarioMetrics = {
            foliageEnabled,
            scenarioId: params.scenarioId,
            description: params.description,
            durationMs: Number(result.durationMs.toFixed(2)),
            frameDistribution,
            transitionsStartedDelta: startedDelta,
            transitionsCompletedDelta: completedDelta,
            transitionsCancelledDelta: cancelledDelta,
            transitionsDeferredBudgetDelta: deferredDelta,
            cacheHitsDelta,
            cacheEvictionsDelta,
            maxActivationSwapMs: result.afterDiag.timings.maxActivationSwapMs,
            lastActivationSwapMs: result.afterDiag.timings.lastActivationSwapMs,
            endActiveResolutionMeters: result.afterDiag.activeResolutionMeters,
            maxSimultaneousAttachedResolutions: result.maxSimultaneousAttached,
            singleResolutionInvariantPassed:
              result.maxSimultaneousAttached <= 1,
            peakMeasuredCpuBytes: result.peakMeasuredCpuBytes,
            peakEstimatedGpuBytes: result.peakEstimatedGpuBytes,
            medianDrawCalls: drawCalls.median,
            medianTriangles: triangles.median,
            ...(params.checkZeroTransitions
              ? { hysteresisZeroTransitionsPassed: startedDelta === 0 }
              : {}),
          };
          scenarios.push(entry);
          return entry;
        };

        // Scenario 1: Smooth step-through zoom sweep (1024 -> 2048 -> 4096 -> 2048 -> 1024)
        await runTimedScenario({
          scenarioId: 'zoom_sweep_1024_2048_4096_back',
          description: 'Full 1,024 -> 2,048 -> 4,096 -> 2,048 -> 1,024 zoom sweep',
          waypoints: [
            { target: [0, 0, 0], zoom: 1.6, holdMs: stepMs },
            { target: [0, 0, 0], zoom: 0.55, holdMs: stepMs },
            { target: [0, 0, 0], zoom: 0.18, holdMs: stepMs },
            { target: [0, 0, 0], zoom: 0.55, holdMs: stepMs },
            { target: [0, 0, 0], zoom: 1.6, holdMs: stepMs },
          ],
        });

        // Scenario 2: Direct non-adjacent jump (1024 <-> 4096)
        await runTimedScenario({
          scenarioId: 'direct_jump_1024_4096',
          description: 'Direct jump 1,024 m -> 4,096 m -> 1,024 m without intermediate stop',
          waypoints: [
            { target: [0, 0, 0], zoom: 0.18, holdMs: stepMs },
            { target: [0, 0, 0], zoom: 1.6, holdMs: stepMs },
          ],
        });

        // Scenario 3: Hysteresis deadband oscillation stability (0 transitions expected!)
        await page.evaluate(async () => {
          const h = (window as any).__BENCHMARK_HARNESS__;
          h.setCameraPose([0, 0, 0], 1.2, 45);
          await h.waitForM2aIdle();
        });
        await runTimedScenario({
          scenarioId: 'hysteresis_deadband_stability',
          description: 'Oscillate within 1024<->2048 (0.82-0.98) deadband — expect 0 transitions',
          checkZeroTransitions: true,
          waypoints: [
            { target: [0, 0, 0], zoom: 0.84, holdMs: 220 },
            { target: [0, 0, 0], zoom: 0.96, holdMs: 220 },
            { target: [0, 0, 0], zoom: 0.83, holdMs: 220 },
            { target: [0, 0, 0], zoom: 0.97, holdMs: 220 },
          ],
        });

        // Scenario 4: Pan during transitions + repeated zoom cycles (LRU cache reuse & bounded memory)
        await runTimedScenario({
          scenarioId: 'pan_and_repeated_zoom_cycles',
          description: 'Pan + repeated zoom cycles checking warm LRU cache reuse and bounded memory',
          waypoints: [
            { target: [250, 0, 180], zoom: 0.55, holdMs: stepMs },
            { target: [-250, 0, -180], zoom: 0.18, holdMs: stepMs },
            { target: [0, 0, 0], zoom: 1.6, holdMs: stepMs },
            { target: [180, 0, -120], zoom: 0.55, holdMs: stepMs },
            { target: [0, 0, 0], zoom: 1.6, holdMs: stepMs },
          ],
        });

        // Scenario 5: Feature picking latency & cross-resolution parity
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
          const pickSummary = await page.evaluate(
            async ({ m, points }) => {
              const h = (window as any).__BENCHMARK_HARNESS__;
              h.setHierarchicalConfig({ mode: m });
              h.setCameraPose([0, 0, 0], 1.2, 45);
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
              await h.waitForM2aIdle();
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
              const res = h.measureFeaturePickRaycast(points, {
                mode: 'accelerated',
                scope: 'full_scene',
                warmupPasses: 1,
                passes: 3,
                returnDetails: true,
              });
              return res;
            },
            { m: mode, points: ndcGrid }
          );

          const perRay: Array<{
            featureId?: string | null;
            nearestVisible?: { featureId?: string | null } | null;
          }> = Array.isArray(pickSummary?.perRayResults)
            ? pickSummary.perRayResults
            : [];
          const hitFeatureIds = perRay.slice(0, ndcGrid.length).map((d) => {
            const id = d?.nearestVisible?.featureId ?? d?.featureId ?? null;
            return id ? String(id) : null;
          });
          const hitCount =
            typeof pickSummary?.resolvedFeatureCount === 'number'
              ? pickSummary.resolvedFeatureCount
              : hitFeatureIds.filter(Boolean).length;
          parityByRes.push({
            resolutionMeters: resMeters,
            medianPickMs: Number(pickSummary?.medianMs ?? 0),
            p95PickMs: Number(pickSummary?.p95Ms ?? 0),
            hitCount,
            sampleCount: ndcGrid.length,
            hitFeatureIds,
          });
        }

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
          foliageEnabled,
          resolutions: parityByRes,
          comparedPointCount: baselineIds.length,
          parityMatchCount,
          parityRatio:
            baselineIds.length > 0 ? parityMatchCount / baselineIds.length : 1,
        });

        // Scenario 6: Auto vs. forced single-resolution modes at Street, Mid, Regional
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
                await new Promise<void>((r) => requestAnimationFrame(() => r()));
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

            const frames = cmp.snap.frames;
            const fd = computeStreamingFrameDistribution(
              frames.map((f) => f.frameIntervalMs)
            );
            const dc = computeSampleStatistics(frames.map((f) => f.renderCalls));
            const tri = computeSampleStatistics(
              frames.map((f) => f.renderTriangles)
            );

            modeComparisons.push({
              foliageEnabled,
              poseLabel: pose.poseLabel,
              zoom: pose.zoom,
              mode,
              activeResolutionMeters: cmp.hd.activeResolutionMeters,
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

      const report: HierarchicalStreamingBenchmarkReport = {
        schemaVersion: '1.0.0',
        generatedAtIso: new Date().toISOString(),
        viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        themeId: opts.themeId,
        descriptorPath,
        hierarchyName,
        availableResolutionsMeters,
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
