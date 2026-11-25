import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeSampleStatistics } from './stats';
import { resolveChromiumLaunchArgs } from './browserRunner';
import { isSoftwareWebGLRenderer } from './environment';
import {
  BENCHMARK_REGIONAL_OVERVIEW_MIN_ZOOM,
  REGIONAL_MIN_ZOOM_QUERY_PARAM,
} from '../src/scene/cameraZoomPolicy';
import type { BenchmarkFrameTelemetry } from '../src/types/BenchmarkTelemetry';
import type { FoliageOptimizationConfig, FoliageTelemetrySnapshot } from '../src/world/FoliageLodSystem';
import type { TileStreamDiagnosticsSnapshot } from '../src/world/tiling/TileStreamManager';

export type FoliageBenchmarkVariantId =
  | 'baseline'
  | 'canopy_lod_only'
  | 'trunk_suppression_only'
  | 'frustum_culling_only'
  | 'combined';

export interface FoliageBenchmarkVariantSpec {
  id: FoliageBenchmarkVariantId;
  label: string;
  config: FoliageOptimizationConfig;
}

export const FOLIAGE_BENCHMARK_VARIANTS: readonly FoliageBenchmarkVariantSpec[] = [
  {
    id: 'baseline',
    label: 'Baseline (LOD0 + trunks + no culling)',
    config: {
      enabled: false,
      lodMode: 'lod0',
      trunkSuppressionEnabled: false,
      frustumCullingEnabled: false,
    },
  },
  {
    id: 'canopy_lod_only',
    label: 'Canopy LOD only (auto LOD, trunks on, culling off)',
    config: {
      enabled: true,
      lodMode: 'auto',
      trunkSuppressionEnabled: false,
      frustumCullingEnabled: false,
    },
  },
  {
    id: 'trunk_suppression_only',
    label: 'Trunk suppression only (LOD0 canopies, trunks auto-hidden, culling off)',
    config: {
      enabled: true,
      lodMode: 'lod0',
      trunkSuppressionEnabled: true,
      frustumCullingEnabled: false,
    },
  },
  {
    id: 'frustum_culling_only',
    label: 'Frustum culling only (LOD0 + trunks on, conservative culling on)',
    config: {
      enabled: true,
      lodMode: 'lod0',
      trunkSuppressionEnabled: false,
      frustumCullingEnabled: true,
    },
  },
  {
    id: 'combined',
    label: 'Combined (Canopy LOD + trunk suppression + frustum culling)',
    config: {
      enabled: true,
      lodMode: 'auto',
      trunkSuppressionEnabled: true,
      frustumCullingEnabled: true,
    },
  },
];

export interface FoliageBenchmarkPose {
  id: string;
  label: string;
  target: [number, number, number];
  zoom: number;
  azimuthDeg: number;
}

export const DEFAULT_FOLIAGE_BENCHMARK_POSES: readonly FoliageBenchmarkPose[] = [
  { id: 'street', label: 'Close street (zoom 6.5)', target: [0, 0, 0], zoom: 6.5, azimuthDeg: 45 },
  { id: 'default', label: 'Default startup (zoom 1.2)', target: [0, 0, 0], zoom: 1.2, azimuthDeg: 45 },
  { id: 'city', label: 'City zoom-out (zoom 0.65)', target: [0, 0, 0], zoom: 0.65, azimuthDeg: 45 },
  { id: 'regional_min', label: 'Regional minZoom (zoom 0.15)', target: [0, 0, 0], zoom: 0.15, azimuthDeg: 45 },
];

export interface FoliageBenchmarkCli {
  serverUrl: string;
  apiBaseUrl: string;
  warmupFrames: number;
  measuredFrames: number;
  targetX: number;
  targetZ: number;
  includeOverview005: boolean;
  requireHardware: boolean;
  outputPath: string;
  markdownPath: string;
}

export function parseFoliageBenchmarkCli(
  argv: readonly string[] = process.argv.slice(2)
): FoliageBenchmarkCli {
  const opts: FoliageBenchmarkCli = {
    serverUrl: 'http://localhost:3000',
    apiBaseUrl: '/api/tiles-region',
    warmupFrames: 10,
    measuredFrames: 60,
    targetX: 0,
    targetZ: 0,
    includeOverview005: false,
    requireHardware: true,
    outputPath: path.resolve('benchmarks/results/tkt036-foliage-optimization.json'),
    markdownPath: path.resolve('benchmarks/results/tkt036-foliage-optimization.md'),
  };
  for (const arg of argv) {
    if (arg === '--allow-software') {
      opts.requireHardware = false;
      continue;
    }
    if (arg === '--include-overview') {
      opts.includeOverview005 = true;
      continue;
    }
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq <= 2) {
      throw new Error(`Expected --key=value, got ${arg}`);
    }
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    if (!value) throw new Error(`Empty option --${key}`);
    if (key === 'url') {
      const u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('url must use http:// or https://');
      }
      opts.serverUrl = u.toString().replace(/\/$/, '');
    } else if (key === 'api-base') {
      opts.apiBaseUrl = value;
    } else if (key === 'warmup-frames' || key === 'measured-frames') {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1 || n > 5000) {
        throw new Error(`--${key} must be an integer between 1 and 5000`);
      }
      if (key === 'warmup-frames') opts.warmupFrames = n;
      if (key === 'measured-frames') opts.measuredFrames = n;
    } else if (key === 'target-x' || key === 'target-z') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`--${key} must be a finite number`);
      if (key === 'target-x') opts.targetX = n;
      if (key === 'target-z') opts.targetZ = n;
    } else if (key === 'out') {
      opts.outputPath = path.resolve(value);
    } else if (key === 'markdown-out') {
      opts.markdownPath = path.resolve(value);
    } else {
      throw new Error(`Unknown option --${key}`);
    }
  }
  return opts;
}

export interface FoliagePoseVariantResult {
  poseId: string;
  poseLabel: string;
  zoom: number;
  variantId: FoliageBenchmarkVariantId;
  variantLabel: string;
  frameMs: ReturnType<typeof computeSampleStatistics>;
  cpuRenderMs: ReturnType<typeof computeSampleStatistics>;
  renderCalls: ReturnType<typeof computeSampleStatistics>;
  renderTriangles: ReturnType<typeof computeSampleStatistics>;
  driverGeometries: number;
  gpuTimerStatus: string;
  gpuPassMs: ReturnType<typeof computeSampleStatistics> | null;
  foliage: FoliageTelemetrySnapshot | null;
  loadedTiles: number;
  visibleTiles: number;
}

export interface FoliageBenchmarkReport {
  schema: 'tkt036-foliage-optimization-v1';
  generatedAtIso: string;
  serverUrl: string;
  apiBaseUrl: string;
  activeMosaicName: string | null;
  packPath: string | null;
  snapshotId: string;
  gridCols: number;
  gridRows: number;
  tileSizeMeters: number;
  totalTiles: number;
  gpuVendor: string;
  gpuRenderer: string;
  isSoftwareRenderer: boolean;
  softwareRendererWarning: string | null;
  warmupFrames: number;
  measuredFrames: number;
  results: FoliagePoseVariantResult[];
}

export function formatFoliageBenchmarkMarkdown(report: FoliageBenchmarkReport): string {
  const lines: string[] = [
    '# TKT-036 Foliage LOD & Culling Evaluation Report',
    '',
    `- **Generated:** ${report.generatedAtIso}`,
    `- **Active Mosaic:** \`${report.activeMosaicName ?? 'unknown'}\` (${report.gridCols} × ${report.gridRows} tiles @ ${report.tileSizeMeters} m, ${report.totalTiles} tiles)`,
    `- **Snapshot ID:** \`${report.snapshotId}\``,
    `- **WebGL Renderer:** \`${report.gpuRenderer}\` (${report.gpuVendor})`,
    `- **Renderer Classification:** ${
      report.isSoftwareRenderer
        ? '**SOFTWARE RENDERER (NOT representative of hardware GPU frame time — use for deterministic geometry, draw-call, and culling verification only)**'
        : 'Hardware WebGL2 GPU'
    }`,
    `- **Frames per variant/pose:** ${report.warmupFrames} warmup + ${report.measuredFrames} measured`,
    '',
  ];

  if (report.softwareRendererWarning) {
    lines.push(`> **Warning:** ${report.softwareRendererWarning}`, '');
  }

  const poseIds = Array.from(new Set(report.results.map((r) => r.poseId)));
  for (const poseId of poseIds) {
    const poseResults = report.results.filter((r) => r.poseId === poseId);
    const first = poseResults[0];
    if (!first) continue;
    const baseline = poseResults.find((r) => r.variantId === 'baseline');

    lines.push(
      `## Pose: ${first.poseLabel} (${first.loadedTiles} loaded / ${first.visibleTiles} visible tiles)`,
      '',
      '| Variant | Active LOD | Trunks | Foliage Batches (Sub/Res, Culled) | Foliage Tris (Sub / Res) | vs LOD0 | Total GL Tris (med) | GL Calls (med) | Driver Geos | CPU Render (med ms) | Frame (med ms) | GPU Pass |',
      '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
    );

    for (const r of poseResults) {
      const f = r.foliage;
      const batchesStr = f
        ? `${f.submittedBatches}/${f.residentBatches} (${f.frustumCulledBatches})`
        : 'n/a';
      const folTrisStr = f
        ? `${f.submittedTriangles.toLocaleString()} / ${f.residentTriangles.toLocaleString()}`
        : 'n/a';
      const redStr = f ? `-${f.triangleReductionVsLod0Pct.toFixed(1)}%` : 'n/a';
      const glTriDelta =
        baseline && baseline.renderTriangles.median > 0 && r.variantId !== 'baseline'
          ? ` (${(((r.renderTriangles.median - baseline.renderTriangles.median) / baseline.renderTriangles.median) * 100).toFixed(1)}%)`
          : '';
      const gpuStr = r.gpuPassMs ? `${r.gpuPassMs.median.toFixed(2)} ms` : r.gpuTimerStatus;

      lines.push(
        `| ${r.variantId} | ${f?.activeLod ?? 'n/a'} | ${f ? (f.trunksVisible ? 'Visible' : 'Hidden') : 'n/a'} | ${batchesStr} | ${folTrisStr} | ${redStr} | ${Math.round(r.renderTriangles.median).toLocaleString()}${glTriDelta} | ${r.renderCalls.median.toFixed(0)} | ${r.driverGeometries} | ${r.cpuRenderMs.median.toFixed(2)} | ${r.frameMs.median.toFixed(2)} | ${gpuStr} |`
      );
    }
    lines.push('');
  }

  lines.push(
    '## Methodology & Interpretation Limits',
    '',
    '- Every pose loads the exact same streamed tile set once and switches foliage optimization modes in-place (`baseline`, `canopy_lod_only`, `trunk_suppression_only`, `frustum_culling_only`, `combined`) without moving the camera or changing tree placement.',
    '- Resident vs. submitted foliage triangles and draw-call counts are exact deterministic metrics regardless of GPU backend.',
    '- Frame interval and GPU pass timings are only representative of interactive performance on a hardware GPU (not SwiftShader software rendering).',
    '- Visual acceptance of LOD0/LOD1/LOD2 transitions and trunk suppression belongs to the project owner.',
    ''
  );

  return lines.join('\n');
}

export async function runFoliageOptimizationBenchmark(
  opts: FoliageBenchmarkCli
): Promise<FoliageBenchmarkReport> {
  let manifest: any;
  try {
    const resp = await fetch(`${opts.serverUrl}${opts.apiBaseUrl}/manifest`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    manifest = await resp.json();
  } catch (err) {
    throw new Error(
      `Regional tile API unavailable at ${opts.serverUrl}${opts.apiBaseUrl}/manifest. Start 'npm run dev' first. Cause: ${String(err)}`
    );
  }

  if (!manifest?.metadata || !Array.isArray(manifest?.tiles)) {
    throw new Error('Malformed tile manifest response.');
  }

  let playwright: any;
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error('Playwright is required to run benchmarks/foliageOptimizationRunner.ts');
  }

  const poses: FoliageBenchmarkPose[] = DEFAULT_FOLIAGE_BENCHMARK_POSES.map((p) => ({
    ...p,
    target: [opts.targetX, 0, opts.targetZ],
  }));
  if (opts.includeOverview005) {
    poses.push({
      id: 'region_overview',
      label: 'Regional overview (zoom 0.05)',
      target: [opts.targetX, 0, opts.targetZ],
      zoom: 0.05,
      azimuthDeg: 45,
    });
  }

  const minZoomOverride = opts.includeOverview005
    ? BENCHMARK_REGIONAL_OVERVIEW_MIN_ZOOM
    : 0.15;

  const resolveChromiumExecutablePath = (): string | undefined => {
    const envExec = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    if (envExec && fs.existsSync(envExec)) return envExec;
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright';
    if (!fs.existsSync(root)) return undefined;
    const direct = path.join(root, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
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
  };

  const executablePath = resolveChromiumExecutablePath();
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: resolveChromiumLaunchArgs(),
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.on('pageerror', (err: Error) =>
      console.error('[foliage:bench] Browser error:', err.message)
    );
    await page.addInitScript('window.__name = (fn) => fn;');
    await page.goto(
      `${opts.serverUrl}/?benchmark=1&dock=collapsed&${REGIONAL_MIN_ZOOM_QUERY_PARAM}=${minZoomOverride}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await page.waitForFunction(
      () => Boolean((window as any).__BENCHMARK_HARNESS__ && document.querySelector('canvas')),
      { timeout: 30000 }
    );

    const gpu = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
      if (!gl) throw new Error('Benchmark requires WebGL2');
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        vendor: String(gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
        renderer: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      };
    });

    const isSoftware = isSoftwareWebGLRenderer(gpu.renderer);
    if (opts.requireHardware && isSoftware) {
      throw new Error(
        `Hardware GPU required, but Chromium selected software renderer: ${gpu.renderer}. Pass --allow-software for deterministic geometry/culling verification only.`
      );
    }

    await page.evaluate(
      async (args: {
        apiBaseUrl: string;
        target: [number, number, number];
        minZoom: number;
      }) => {
        const h = (window as any).__BENCHMARK_HARNESS__;
        await h.unloadDataset();
        await h.loadM2aStreaming({
          apiBaseUrl: args.apiBaseUrl,
          preloadMarginTiles: 0.5,
          retainMarginTiles: 1,
          regionalMinZoom: args.minZoom,
          themeId: 'tactical',
          target: args.target,
          zoom: 1.2,
          azimuthDeg: 45,
          waitForIdle: true,
          timeoutMs: 300000,
        });
      },
      {
        apiBaseUrl: opts.apiBaseUrl,
        target: [opts.targetX, 0, opts.targetZ] as [number, number, number],
        minZoom: minZoomOverride,
      }
    );

    const results: FoliagePoseVariantResult[] = [];

    for (const pose of poses) {
      console.log(`[foliage:bench] Settling pose ${pose.id} (zoom ${pose.zoom})...`);
      const settledDiag: TileStreamDiagnosticsSnapshot | null = await page.evaluate(
        async (p: FoliageBenchmarkPose) => {
          const h = (window as any).__BENCHMARK_HARNESS__;
          h.setCameraPose(p.target, p.zoom, p.azimuthDeg);
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          await h.waitForM2aIdle();
          return h.getTileStreamDiagnostics();
        },
        pose
      );

      for (const variant of FOLIAGE_BENCHMARK_VARIANTS) {
        const raw = await page.evaluate(
          async (args: {
            config: FoliageOptimizationConfig;
            warmup: number;
            measured: number;
          }) => {
            const h = (window as any).__BENCHMARK_HARNESS__;
            h.setFoliageOptimizationConfig(args.config);
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            await new Promise<void>((r) => requestAnimationFrame(() => r()));

            const samples: BenchmarkFrameTelemetry[] = [];
            (window as any).__BENCHMARK_ACTIVE__ = true;
            if (typeof (window as any).__BENCHMARK_RESET_GPU_TIMERS__ === 'function') {
              (window as any).__BENCHMARK_RESET_GPU_TIMERS__();
            }

            await new Promise<void>((resolve) => {
              let seen = 0;
              (window as any).__BENCHMARK_FRAME_COLLECTOR__ = (
                sample: BenchmarkFrameTelemetry
              ) => {
                seen += 1;
                if (seen > args.warmup) {
                  samples.push(sample);
                }
                if (seen >= args.warmup + args.measured) {
                  delete (window as any).__BENCHMARK_FRAME_COLLECTOR__;
                  (window as any).__BENCHMARK_ACTIVE__ = false;
                  resolve();
                }
              };
            });

            const foliage = h.getFoliageTelemetry() as FoliageTelemetrySnapshot | null;
            return { samples, foliage };
          },
          {
            config: variant.config,
            warmup: opts.warmupFrames,
            measured: opts.measuredFrames,
          }
        );

        const validGpu = raw.samples
          .filter(
            (s) =>
              s.gpuTimerStatus === 'valid' &&
              !s.gpuDisjointOccurred &&
              typeof s.gpuPassTimeMs === 'number' &&
              Number.isFinite(s.gpuPassTimeMs)
          )
          .map((s) => s.gpuPassTimeMs!);
        const statuses = new Set(raw.samples.map((s) => s.gpuTimerStatus));
        const gpuTimerStatus = validGpu.length
          ? 'supported'
          : statuses.has('disjoint')
            ? 'disjoint'
            : statuses.has('unsupported')
              ? 'unsupported'
              : 'unavailable';

        results.push({
          poseId: pose.id,
          poseLabel: pose.label,
          zoom: pose.zoom,
          variantId: variant.id,
          variantLabel: variant.label,
          frameMs: computeSampleStatistics(raw.samples.map((s) => s.frameIntervalMs)),
          cpuRenderMs: computeSampleStatistics(raw.samples.map((s) => s.cpuRenderTimeMs)),
          renderCalls: computeSampleStatistics(raw.samples.map((s) => s.renderCalls)),
          renderTriangles: computeSampleStatistics(raw.samples.map((s) => s.renderTriangles)),
          driverGeometries: raw.samples.length
            ? raw.samples[raw.samples.length - 1].driverGeometries
            : 0,
          gpuTimerStatus,
          gpuPassMs: validGpu.length ? computeSampleStatistics(validGpu) : null,
          foliage: raw.foliage,
          loadedTiles: settledDiag?.loadedTiles ?? 0,
          visibleTiles: settledDiag?.visibleTiles ?? 0,
        });
      }
    }

    const identity = await page.evaluate(() => {
      const h = (window as any).__BENCHMARK_HARNESS__;
      return h.getActiveMosaicIdentity?.() ?? null;
    });

    const report: FoliageBenchmarkReport = {
      schema: 'tkt036-foliage-optimization-v1',
      generatedAtIso: new Date().toISOString(),
      serverUrl: opts.serverUrl,
      apiBaseUrl: opts.apiBaseUrl,
      activeMosaicName: identity?.mosaicName ?? null,
      packPath: manifest.packPath ?? null,
      snapshotId: manifest.metadata.snapshotId,
      gridCols: manifest.metadata.gridCols,
      gridRows: manifest.metadata.gridRows,
      tileSizeMeters: manifest.metadata.tileSizeMeters,
      totalTiles: manifest.tiles.length,
      gpuVendor: gpu.vendor,
      gpuRenderer: gpu.renderer,
      isSoftwareRenderer: isSoftware,
      softwareRendererWarning: isSoftware
        ? 'Measured under software WebGL (SwiftShader). Frame/CPU timings do NOT reflect hardware GPU performance; only geometry counts, draw calls, driver geometries, and culling counts are authoritative.'
        : null,
      warmupFrames: opts.warmupFrames,
      measuredFrames: opts.measuredFrames,
      results,
    };

    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
    fs.writeFileSync(opts.outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    fs.mkdirSync(path.dirname(opts.markdownPath), { recursive: true });
    fs.writeFileSync(opts.markdownPath, formatFoliageBenchmarkMarkdown(report), 'utf8');

    console.log(`[foliage:bench] Wrote JSON: ${opts.outputPath}`);
    console.log(`[foliage:bench] Wrote Markdown: ${opts.markdownPath}`);
    return report;
  } finally {
    await browser.close();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const cli = parseFoliageBenchmarkCli(process.argv.slice(2));
  runFoliageOptimizationBenchmark(cli).catch((err) => {
    console.error('[foliage:bench] Failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
