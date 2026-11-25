/**
 * Reproducible Spatial Batching Benchmark Runner (TKT-037)
 *
 * Compares 1,024 m (baseline), 2,048 m (2×2 consolidated), and 4,096 m (4×4 consolidated)
 * regional mosaics under identical geographic UTM targets, camera poses, viewport dimensions,
 * theme, and foliage configurations (TKT-036 enabled vs. foliage disabled), plus a continuous
 * pan streaming scenario and BVH feature-picking raycast timing.
 *
 * Mounts all provided mosaics on a single ephemeral Express + Vite server so the owner can
 * run the entire comparison in one command without restarting servers or changing env vars.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { computeSampleStatistics } from './stats';
import { resolveChromiumLaunchArgs } from './browserRunner';
import { isSoftwareWebGLRenderer } from './environment';
import { createRegionalMosaicHttpHandler } from '../src/server/tiles/RegionalMosaicHttpHandler';
import { REGIONAL_MIN_ZOOM_QUERY_PARAM } from '../src/scene/cameraZoomPolicy';
import type { BenchmarkFrameTelemetry } from '../src/types/BenchmarkTelemetry';
import type { TileStreamDiagnosticsSnapshot } from '../src/world/tiling/TileStreamManager';
import type { ConsolidationMosaicReport } from '../src/server/tiles/OfflineTileConsolidator';

export interface SpatialBatchingPoseSpec {
  id: string;
  label: string;
  zoom: number;
  azimuthDeg: number;
}

export const DEFAULT_SPATIAL_BATCHING_POSES: readonly SpatialBatchingPoseSpec[] = [
  { id: 'street', label: 'Close street (zoom 6.5)', zoom: 6.5, azimuthDeg: 45 },
  { id: 'default', label: 'Default startup (zoom 1.2)', zoom: 1.2, azimuthDeg: 45 },
  { id: 'city', label: 'City zoom-out (zoom 0.65)', zoom: 0.65, azimuthDeg: 45 },
  { id: 'regional_min', label: 'Regional minZoom (zoom 0.15)', zoom: 0.15, azimuthDeg: 45 },
];

export type FoliageModeId = 'foliage_enabled_tkt036' | 'foliage_disabled';

export interface SpatialBatchingMosaicInput {
  label: string;
  tileSizeMeters: number;
  indexPath: string;
  apiBaseUrl: string;
}

export interface SpatialBatchingCli {
  mosaics: SpatialBatchingMosaicInput[];
  runs: number;
  warmupFrames: number;
  measuredFrames: number;
  panSteps: number;
  panZoom: number;
  panDistanceMeters: number;
  targetEasting: number | null;
  targetNorthing: number | null;
  themeId: string;
  requireHardware: boolean;
  outputPath: string;
  markdownPath: string;
}

export function parseSpatialBatchingCli(
  argv: readonly string[] = process.argv.slice(2)
): SpatialBatchingCli {
  let index1024: string | null = null;
  let index2048: string | null = null;
  let index4096: string | null = null;
  const opts: SpatialBatchingCli = {
    mosaics: [],
    runs: 2,
    warmupFrames: 12,
    measuredFrames: 45,
    panSteps: 40,
    panZoom: 0.55,
    panDistanceMeters: 3200,
    targetEasting: null,
    targetNorthing: null,
    themeId: 'daylight',
    requireHardware: true,
    outputPath: path.resolve('benchmarks/results/tkt037-spatial-batching.json'),
    markdownPath: path.resolve('benchmarks/results/tkt037-spatial-batching.md'),
  };

  for (const arg of argv) {
    if (arg === '--allow-software') {
      opts.requireHardware = false;
      continue;
    }
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq <= 2) {
      throw new Error(`Expected --key=value, got "${arg}"`);
    }
    const key = arg.slice(2, eq);
    const val = arg.slice(eq + 1);
    if (!val) throw new Error(`Empty value for --${key}`);

    if (key === 'index-1024') index1024 = path.resolve(val);
    else if (key === 'index-2048') index2048 = path.resolve(val);
    else if (key === 'index-4096') index4096 = path.resolve(val);
    else if (key === 'runs') opts.runs = Math.max(1, Number(val));
    else if (key === 'warmup-frames') opts.warmupFrames = Math.max(1, Number(val));
    else if (key === 'measured-frames') opts.measuredFrames = Math.max(5, Number(val));
    else if (key === 'pan-steps') opts.panSteps = Math.max(5, Number(val));
    else if (key === 'pan-zoom') opts.panZoom = Number(val);
    else if (key === 'pan-distance-m') opts.panDistanceMeters = Number(val);
    else if (key === 'target-easting') opts.targetEasting = Number(val);
    else if (key === 'target-northing') opts.targetNorthing = Number(val);
    else if (key === 'theme') opts.themeId = val;
    else if (key === 'out') opts.outputPath = path.resolve(val);
    else if (key === 'markdown-out') opts.markdownPath = path.resolve(val);
    else throw new Error(`Unknown option --${key}`);
  }

  if (index1024) {
    opts.mosaics.push({
      label: '1024m',
      tileSizeMeters: 1024,
      indexPath: index1024,
      apiBaseUrl: '/api/tiles-batch-1024',
    });
  }
  if (index2048) {
    opts.mosaics.push({
      label: '2048m',
      tileSizeMeters: 2048,
      indexPath: index2048,
      apiBaseUrl: '/api/tiles-batch-2048',
    });
  }
  if (index4096) {
    opts.mosaics.push({
      label: '4096m',
      tileSizeMeters: 4096,
      indexPath: index4096,
      apiBaseUrl: '/api/tiles-batch-4096',
    });
  }

  if (opts.mosaics.length === 0) {
    throw new Error(
      'Provide at least one mosaic index via --index-1024=<path> --index-2048=<path> --index-4096=<path>'
    );
  }
  return opts;
}

export interface FeaturePickTimingSummary {
  sampleCount: number;
  hitCount: number;
  resolvedFeatureCount: number;
  medianMs: number;
  p95Ms: number;
  meanMs: number;
  maxMs: number;
}

export interface SpatialBatchingPoseResult {
  mosaicLabel: string;
  tileSizeMeters: number;
  foliageMode: FoliageModeId;
  poseId: string;
  poseLabel: string;
  zoom: number;
  runsMeasured: number;
  frameMs: ReturnType<typeof computeSampleStatistics>;
  cpuRenderMs: ReturnType<typeof computeSampleStatistics>;
  renderCalls: ReturnType<typeof computeSampleStatistics>;
  renderTriangles: ReturnType<typeof computeSampleStatistics>;
  gpuPassMs: ReturnType<typeof computeSampleStatistics> | null;
  gpuTimerStatus: string;
  loadedTiles: number;
  visibleTiles: number;
  residentSceneObjects: number;
  residentMeshes: number;
  frustumVisibleMeshes: number;
  residentBufferTriangles: number;
  visibleBufferTriangles: number;
  driverGeometries: number;
  driverTextures: number;
  estimatedGeometryMemoryMB: number;
  jsHeapMB: number | null;
  drawWorkByLayer: Record<
    string,
    {
      mainPassSubmissions: number;
      mainFrustumShadowCasterSubmissions: number;
      instancedMeshes: number;
      drawableMeshes: number;
    }
  >;
  tileStreamCosts: {
    fetchesCompleted: number;
    avgFetchMs: number;
    avgDecodeMs: number;
    avgReconstructMs: number;
    maxCommitMs: number;
  };
  featurePickRaycast: FeaturePickTimingSummary | null;
}

export interface SpatialBatchingPanResult {
  mosaicLabel: string;
  tileSizeMeters: number;
  foliageMode: FoliageModeId;
  zoom: number;
  panDistanceMeters: number;
  panSteps: number;
  frameMs: ReturnType<typeof computeSampleStatistics>;
  cpuRenderMs: ReturnType<typeof computeSampleStatistics>;
  renderCalls: ReturnType<typeof computeSampleStatistics>;
  renderTriangles: ReturnType<typeof computeSampleStatistics>;
  streamDuringPan: {
    fetchesCompleted: number;
    avgFetchMs: number;
    avgDecodeMs: number;
    avgReconstructMs: number;
    maxCommitMs: number;
    tilesLoadedEnd: number;
    tilesVisibleEnd: number;
    tilesEvicted: number;
  };
}

export interface SpatialBatchingMosaicSummary {
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
  targetLocalX: number;
  targetLocalZ: number;
  consolidationReport: ConsolidationMosaicReport | null;
}

export interface SpatialBatchingBenchmarkReport {
  generatedAtIso: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  themeId: string;
  targetUtm: { easting: number; northing: number };
  gpuVendor: string;
  gpuRenderer: string;
  isSoftwareRenderer: boolean;
  softwareRendererWarning: string | null;
  runsPerCase: number;
  warmupFrames: number;
  measuredFrames: number;
  mosaics: SpatialBatchingMosaicSummary[];
  stationaryResults: SpatialBatchingPoseResult[];
  panResults: SpatialBatchingPanResult[];
}

function resolveChromiumExecutablePath(): string | undefined {
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
}

async function startMultiMosaicBenchmarkServer(
  mosaics: readonly SpatialBatchingMosaicInput[]
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
    app.get(`${m.apiBaseUrl}/:snapshotId/:schemaVersion/:lod/:tx/:ty`, (req, res) => {
      void handler.tilePayloadHandler(req, res);
    });
  }

  // Mount default /api/tiles-region to the first mosaic so initial page boot stays quiet
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
  app.get('/api/tiles-region/:snapshotId/:schemaVersion/:lod/:tx/:ty', (req, res) => {
    void defaultHandler.tilePayloadHandler(req, res);
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
    throw new Error('Failed to bind ephemeral benchmark server port');
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
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

export function formatSpatialBatchingMarkdown(
  report: SpatialBatchingBenchmarkReport
): string {
  const lines: string[] = [
    '# TKT-037 Spatial Batching Benchmark Report',
    '',
    `- **Generated:** ${report.generatedAtIso}`,
    `- **Viewport:** ${report.viewport.width} × ${report.viewport.height} @ DPR ${report.viewport.deviceScaleFactor} | **Theme:** \`${report.themeId}\``,
    `- **Shared Geographic UTM Target:** E ${report.targetUtm.easting.toFixed(1)} m, N ${report.targetUtm.northing.toFixed(1)} m`,
    `- **WebGL Renderer:** \`${report.gpuRenderer}\` (${report.gpuVendor})`,
    `- **Renderer Classification:** ${
      report.isSoftwareRenderer
        ? '**SOFTWARE RENDERER (SwiftShader — deterministic geometry/draw-call/culling verification ONLY; NOT representative of hardware GPU frame timings)**'
        : 'Hardware WebGL2 GPU'
    }`,
    `- **Sampling:** ${report.runsPerCase} repeated pass(es) × (${report.warmupFrames} warmup + ${report.measuredFrames} measured frames)`,
    '',
  ];

  if (report.softwareRendererWarning) {
    lines.push(`> **Warning:** ${report.softwareRendererWarning}`, '');
  }

  lines.push(
    '## Mosaics Compared',
    '',
    '| Mosaic | Tile Size | Grid | Total Tiles | Consolidation Time | Peak RSS | Compressed Size | Resident Draw Calls (Audit) |',
    '|---|---:|---|---:|---:|---:|---:|---:|'
  );
  for (const m of report.mosaics) {
    const cr = m.consolidationReport;
    const cTime = cr ? `${(cr.performance.elapsedMs / 1000).toFixed(2)} s` : 'baseline';
    const cRss = cr ? `${cr.performance.peakRssMiB.toFixed(1)} MiB` : 'baseline';
    const cSize = cr
      ? `${(cr.storage.parentCompressedBytes / (1024 * 1024)).toFixed(2)} MiB (${cr.storage.compressedSizeDeltaPct >= 0 ? '+' : ''}${cr.storage.compressedSizeDeltaPct}%)`
      : 'baseline';
    const cDc = cr
      ? `${cr.geometryAudit.parentTotalDrawCalls.toLocaleString()} (-${cr.geometryAudit.totalDrawCallReductionPct}%)`
      : 'baseline';
    lines.push(
      `| ${m.label} | ${m.tileSizeMeters} m | ${m.gridCols} × ${m.gridRows} | ${m.totalTiles} | ${cTime} | ${cRss} | ${cSize} | ${cDc} |`
    );
  }
  lines.push('');

  const foliageModes: FoliageModeId[] = ['foliage_enabled_tkt036', 'foliage_disabled'];
  for (const fMode of foliageModes) {
    lines.push(
      `## Stationary Poses — ${fMode === 'foliage_enabled_tkt036' ? 'Foliage Enabled (TKT-036 Optimized)' : 'Foliage Disabled'}`,
      ''
    );
    for (const pose of DEFAULT_SPATIAL_BATCHING_POSES) {
      const rows = report.stationaryResults.filter(
        (r) => r.foliageMode === fMode && r.poseId === pose.id
      );
      if (rows.length === 0) continue;
      const base = rows.find((r) => r.tileSizeMeters === 1024) ?? rows[0];

      lines.push(
        `### ${pose.label}`,
        '',
        '| Tile Size | Loaded / Vis Tiles | Scene Objs | Vis / Res Meshes | Driver Geos | GL Calls (med) | GL Tris (med) | Resident Buf Tris | CPU Render (med / p95 ms) | GPU Pass (med) | Frame (med / p95 ms) | Raycast Pick (med ms) |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
      );

      for (const r of rows) {
        const callDelta =
          base && base.renderCalls.median > 0 && r !== base
            ? ` (${(((r.renderCalls.median - base.renderCalls.median) / base.renderCalls.median) * 100).toFixed(1)}%)`
            : '';
        const gpuStr = r.gpuPassMs ? `${r.gpuPassMs.median.toFixed(2)} ms` : r.gpuTimerStatus;
        const pickStr = r.featurePickRaycast
          ? `${r.featurePickRaycast.medianMs.toFixed(2)} ms (${r.featurePickRaycast.resolvedFeatureCount}/${r.featurePickRaycast.sampleCount})`
          : 'n/a';
        lines.push(
          `| ${r.tileSizeMeters} m | ${r.loadedTiles} / ${r.visibleTiles} | ${r.residentSceneObjects} | ${r.frustumVisibleMeshes} / ${r.residentMeshes} | ${r.driverGeometries} | ${r.renderCalls.median.toFixed(0)}${callDelta} | ${Math.round(r.renderTriangles.median).toLocaleString()} | ${r.residentBufferTriangles.toLocaleString()} | ${r.cpuRenderMs.median.toFixed(2)} / ${r.cpuRenderMs.p95.toFixed(2)} | ${gpuStr} | ${r.frameMs.median.toFixed(2)} / ${r.frameMs.p95.toFixed(2)} | ${pickStr} |`
        );
      }
      lines.push('');
    }
  }

  if (report.panResults.length > 0) {
    lines.push(
      '## Continuous Pan Streaming Scenario',
      '',
      '| Tile Size | Foliage | Zoom | Pan Distance | Frame med / p95 / max (ms) | CPU Render med / p95 (ms) | GL Calls (med) | Fetches | Avg Fetch / Decode / Recon (ms) | Max Stream Update (ms) |',
      '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|'
    );
    for (const p of report.panResults) {
      const s = p.streamDuringPan;
      lines.push(
        `| ${p.tileSizeMeters} m | ${p.foliageMode === 'foliage_enabled_tkt036' ? 'Enabled' : 'Disabled'} | ${p.zoom} | ${p.panDistanceMeters} m | ${p.frameMs.median.toFixed(2)} / ${p.frameMs.p95.toFixed(2)} / ${p.frameMs.max.toFixed(2)} | ${p.cpuRenderMs.median.toFixed(2)} / ${p.cpuRenderMs.p95.toFixed(2)} | ${p.renderCalls.median.toFixed(0)} | ${s.fetchesCompleted} | ${s.avgFetchMs.toFixed(2)} / ${s.avgDecodeMs.toFixed(2)} / ${s.avgReconstructMs.toFixed(2)} | ${s.maxCommitMs.toFixed(2)} |`
      );
    }
    lines.push('');
  }

  lines.push(
    '## Methodology & Interpretation Limits',
    '',
    '- Every tile size frames the exact same absolute UTM ground coordinate by converting `(targetEasting, targetNorthing)` against each mosaic manifest\'s `studyOriginEasting/Northing`.',
    '- WebGL draw calls (`GL Calls`), submitted triangles (`GL Tris`), resident buffer triangles, scene object counts, and frustum culling counts are deterministic across hardware and software renderers.',
    '- Frame interval, CPU render time, and GPU pass timings are only representative of interactive performance on a hardware GPU (never extrapolate SwiftShader software timings to RTX/discrete hardware).',
    ''
  );

  return lines.join('\n');
}

export async function runSpatialBatchingBenchmark(
  opts: SpatialBatchingCli
): Promise<SpatialBatchingBenchmarkReport> {
  let playwright: any;
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error('Playwright is required to run benchmarks/spatialBatchingRunner.ts');
  }

  const server = await startMultiMosaicBenchmarkServer(opts.mosaics);

  try {
    // Query all manifests to lock a single shared absolute UTM target across all tile sizes
    const manifests = new Map<string, any>();
    for (const m of opts.mosaics) {
      const resp = await fetch(`${server.baseUrl}${m.apiBaseUrl}/manifest`);
      if (!resp.ok) {
        throw new Error(`Failed to fetch manifest for ${m.label}: HTTP ${resp.status}`);
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

    const mosaicSummaries: SpatialBatchingMosaicSummary[] = opts.mosaics.map((m) => {
      const man = manifests.get(m.label);
      const meta = man.metadata;
      const reportFile = path.join(path.dirname(m.indexPath), 'consolidation-report.json');
      let consolidationReport: ConsolidationMosaicReport | null = null;
      if (fs.existsSync(reportFile)) {
        try {
          consolidationReport = JSON.parse(
            fs.readFileSync(reportFile, 'utf8')
          ) as ConsolidationMosaicReport;
        } catch {
          consolidationReport = null;
        }
      }
      return {
        label: m.label,
        tileSizeMeters: meta.tileSizeMeters,
        indexPath: m.indexPath,
        mosaicName: man.activeMosaicName ?? path.basename(path.dirname(m.indexPath)),
        snapshotId: meta.snapshotId,
        gridCols: meta.gridCols,
        gridRows: meta.gridRows,
        totalTiles: man.tiles.length,
        studyOriginEasting: meta.studyOriginEasting,
        studyOriginNorthing: meta.studyOriginNorthing,
        targetLocalX: Number((targetEasting - meta.studyOriginEasting).toFixed(4)),
        targetLocalZ: Number((meta.studyOriginNorthing - targetNorthing).toFixed(4)),
        consolidationReport,
      };
    });

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
      await page.addInitScript('window.__name = (fn) => fn;');

      const pageUrl = `${server.baseUrl}/?benchmark=1&dock=collapsed&${REGIONAL_MIN_ZOOM_QUERY_PARAM}=0.15`;
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(
        () =>
          Boolean(
            (window as any).__BENCHMARK_HARNESS__?.loadM2aStreaming &&
              document.querySelector('canvas')
          ),
        { timeout: 60000 }
      );

      // Probe real WebGL2 GPU vendor/renderer directly from the active canvas context
      const gpuInfo = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
        if (!gl) {
          throw new Error('Spatial batching benchmark requires an active WebGL2 canvas');
        }
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        const vendor = String(
          gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR) ?? 'Unknown'
        );
        const renderer = String(
          gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? 'Unknown'
        );
        return { gpuVendor: vendor, gpuRenderer: renderer };
      });

      const isSoftware =
        isSoftwareWebGLRenderer(gpuInfo.gpuRenderer) ||
        gpuInfo.gpuRenderer === 'Unknown';
      if (isSoftware && opts.requireHardware) {
        throw new Error(
          `Detected software/unverified WebGL renderer "${gpuInfo.gpuRenderer}". Re-run on hardware GPU or pass --allow-software for deterministic geometry/draw-call verification only.`
        );
      }

      const softwareWarning = isSoftware
        ? `Executed on software WebGL renderer (${gpuInfo.gpuRenderer}). Geometry, draw-call, and culling counts are deterministic; CPU/GPU/frame timings are NOT representative of hardware GPU performance.`
        : null;

      const sampleFrames = async (
        warmupFrames: number,
        measuredFrames: number
      ): Promise<BenchmarkFrameTelemetry[]> => {
        return page.evaluate(
          ({ warmup, measured }) =>
            new Promise<BenchmarkFrameTelemetry[]>((resolve) => {
              const out: BenchmarkFrameTelemetry[] = [];
              let seen = 0;
              (window as any).__BENCHMARK_ACTIVE__ = true;
              if (typeof (window as any).__BENCHMARK_RESET_GPU_TIMERS__ === 'function') {
                (window as any).__BENCHMARK_RESET_GPU_TIMERS__();
              }
              (window as any).__BENCHMARK_FRAME_COLLECTOR__ = (
                t: BenchmarkFrameTelemetry
              ) => {
                seen++;
                if (seen > warmup) {
                  out.push(t);
                }
                if (out.length >= measured) {
                  delete (window as any).__BENCHMARK_FRAME_COLLECTOR__;
                  (window as any).__BENCHMARK_ACTIVE__ = false;
                  resolve(out);
                }
              };
            }),
          { warmup: warmupFrames, measured: measuredFrames }
        );
      };

      const stationaryResults: SpatialBatchingPoseResult[] = [];
      const panResults: SpatialBatchingPanResult[] = [];
      const foliageModes: FoliageModeId[] = ['foliage_enabled_tkt036', 'foliage_disabled'];

      for (const summary of mosaicSummaries) {
        const mosaicInput = opts.mosaics.find((m) => m.label === summary.label)!;
        const target: [number, number, number] = [
          summary.targetLocalX,
          0,
          summary.targetLocalZ,
        ];

        // Unload any prior mosaic and load this mosaic fresh into TileStreamManager
        await page.evaluate(
          async ({ apiBaseUrl, themeId, targetPose }) => {
            const h = (window as any).__BENCHMARK_HARNESS__;
            await h.unloadDataset?.();
            await h.loadM2aStreaming({
              apiBaseUrl,
              preloadMarginTiles: 0.5,
              retainMarginTiles: 1,
              themeId,
              target: targetPose,
              zoom: 1.2,
              azimuthDeg: 45,
              regionalMinZoom: 0.15,
              waitForIdle: true,
              timeoutMs: 120000,
            });
          },
          {
            apiBaseUrl: mosaicInput.apiBaseUrl,
            themeId: opts.themeId,
            targetPose: target,
          }
        );

        for (const foliageMode of foliageModes) {
          await page.evaluate(
            async ({ enabled }) => {
              const h = (window as any).__BENCHMARK_HARNESS__;
              h.setShowFoliage(enabled);
              if (enabled) {
                h.setFoliageOptimizationConfig({
                  enabled: true,
                  lodMode: 'auto',
                  trunkSuppressionEnabled: true,
                  frustumCullingEnabled: true,
                });
              }
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
            },
            { enabled: foliageMode === 'foliage_enabled_tkt036' }
          );

          for (const pose of DEFAULT_SPATIAL_BATCHING_POSES) {
            const allFrameIntervals: number[] = [];
            const allCpuRenderMs: number[] = [];
            const allRenderCalls: number[] = [];
            const allRenderTriangles: number[] = [];
            const allGpuPassMs: number[] = [];
            let gpuTimerStatus = 'unavailable';

            let lastSceneCounts: any = null;
            let lastDiag: TileStreamDiagnosticsSnapshot | null = null;
            let lastJsHeapMB: number | null = null;
            let lastPick: FeaturePickTimingSummary | null = null;

            for (let runIdx = 0; runIdx < opts.runs; runIdx++) {
              await page.evaluate(
                async ({ poseTarget, zoom, azimuthDeg }) => {
                  const h = (window as any).__BENCHMARK_HARNESS__;
                  h.resetM2aPerfCounters?.();
                  h.setCameraPose(poseTarget, zoom, azimuthDeg);
                  await new Promise<void>((r) => requestAnimationFrame(() => r()));
                  await h.waitForM2aIdle();
                  await new Promise<void>((r) => requestAnimationFrame(() => r()));
                },
                { poseTarget: target, zoom: pose.zoom, azimuthDeg: pose.azimuthDeg }
              );

              const frames = await sampleFrames(opts.warmupFrames, opts.measuredFrames);
              for (const f of frames) {
                if (typeof f.frameIntervalMs === 'number' && Number.isFinite(f.frameIntervalMs)) {
                  allFrameIntervals.push(f.frameIntervalMs);
                }
                if (typeof f.cpuRenderTimeMs === 'number' && Number.isFinite(f.cpuRenderTimeMs)) {
                  allCpuRenderMs.push(f.cpuRenderTimeMs);
                }
                if (typeof f.renderCalls === 'number' && Number.isFinite(f.renderCalls)) {
                  allRenderCalls.push(f.renderCalls);
                }
                if (typeof f.renderTriangles === 'number' && Number.isFinite(f.renderTriangles)) {
                  allRenderTriangles.push(f.renderTriangles);
                }
                if (
                  f.gpuTimerStatus === 'valid' &&
                  typeof f.gpuPassTimeMs === 'number' &&
                  Number.isFinite(f.gpuPassTimeMs)
                ) {
                  allGpuPassMs.push(f.gpuPassTimeMs);
                }
                if (f.gpuTimerStatus) {
                  gpuTimerStatus = f.gpuTimerStatus;
                }
              }

              const snap = await page.evaluate(() => {
                const h = (window as any).__BENCHMARK_HARNESS__;
                const perfMem = (performance as unknown as { memory?: { usedJSHeapSize?: number } })
                  .memory;
                return {
                  sceneCounts: h.getSceneMeshCounts?.() ?? null,
                  diag: h.getTileStreamDiagnostics?.() ?? null,
                  jsHeapMB:
                    perfMem && typeof perfMem.usedJSHeapSize === 'number'
                      ? Number((perfMem.usedJSHeapSize / (1024 * 1024)).toFixed(2))
                      : null,
                  pick: h.measureFeaturePickRaycast?.() ?? null,
                };
              });

              lastSceneCounts = snap.sceneCounts;
              lastDiag = snap.diag;
              lastJsHeapMB = snap.jsHeapMB;
              lastPick = snap.pick;
            }

            const totals = lastSceneCounts?.total ?? {};
            stationaryResults.push({
              mosaicLabel: summary.label,
              tileSizeMeters: summary.tileSizeMeters,
              foliageMode,
              poseId: pose.id,
              poseLabel: pose.label,
              zoom: pose.zoom,
              runsMeasured: opts.runs,
              frameMs: computeSampleStatistics(allFrameIntervals),
              cpuRenderMs: computeSampleStatistics(allCpuRenderMs),
              renderCalls: computeSampleStatistics(allRenderCalls),
              renderTriangles: computeSampleStatistics(allRenderTriangles),
              gpuPassMs:
                allGpuPassMs.length > 0 ? computeSampleStatistics(allGpuPassMs) : null,
              gpuTimerStatus,
              loadedTiles: lastDiag?.loadedTiles ?? 0,
              visibleTiles: lastDiag?.visibleTiles ?? 0,
              residentSceneObjects: totals.totalSceneObjects ?? 0,
              residentMeshes: totals.totalMeshes ?? 0,
              frustumVisibleMeshes: totals.frustumVisibleMeshes ?? 0,
              residentBufferTriangles: totals.residentBufferTriangles ?? 0,
              visibleBufferTriangles: totals.visibleBufferTriangles ?? 0,
              driverGeometries: totals.residentGeometries ?? 0,
              driverTextures: totals.residentTextures ?? 0,
              estimatedGeometryMemoryMB: lastDiag
                ? Number(
                    (
                      ((lastDiag.tileCpuGeometryBytes ?? 0) + (lastDiag.tileBvhBytes ?? 0)) /
                      (1024 * 1024)
                    ).toFixed(2)
                  )
                : 0,
              jsHeapMB: lastJsHeapMB,
              drawWorkByLayer: lastSceneCounts?.drawWorkEstimate?.byLayer ?? {},
              tileStreamCosts: {
                fetchesCompleted: lastDiag?.completedLoadsTotal ?? 0,
                avgFetchMs: lastDiag?.avgFetchMs ?? 0,
                avgDecodeMs: lastDiag?.avgDecodeMs ?? 0,
                avgReconstructMs: lastDiag?.avgReconstructMs ?? 0,
                maxCommitMs: lastDiag?.maxCommitMs ?? 0,
              },
              featurePickRaycast: lastPick,
            });
          }

          // Continuous pan scenario across tile boundaries
          const panStartX = target[0] - opts.panDistanceMeters * 0.5;
          const panEndX = target[0] + opts.panDistanceMeters * 0.5;
          await page.evaluate(
            async ({ startPose, zoom }) => {
              const h = (window as any).__BENCHMARK_HARNESS__;
              h.setCameraPose(startPose, zoom, 45);
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
              await h.waitForM2aIdle();
              h.resetM2aPerfCounters?.();
            },
            { startPose: [panStartX, 0, target[2]] as [number, number, number], zoom: opts.panZoom }
          );

          const panTelemetry = await page.evaluate(
            ({ startX, endX, z, zoom, steps }) =>
              new Promise<{
                frames: BenchmarkFrameTelemetry[];
                diag: TileStreamDiagnosticsSnapshot | null;
              }>((resolve) => {
                const h = (window as any).__BENCHMARK_HARNESS__;
                const frames: BenchmarkFrameTelemetry[] = [];
                let step = 0;
                (window as any).__BENCHMARK_ACTIVE__ = true;
                (window as any).__BENCHMARK_FRAME_COLLECTOR__ = (
                  t: BenchmarkFrameTelemetry
                ) => {
                  frames.push(t);
                  step++;
                  if (step >= steps) {
                    delete (window as any).__BENCHMARK_FRAME_COLLECTOR__;
                    (window as any).__BENCHMARK_ACTIVE__ = false;
                    resolve({
                      frames,
                      diag: h.getTileStreamDiagnostics?.() ?? null,
                    });
                    return;
                  }
                  const frac = step / Math.max(1, steps - 1);
                  h.setCameraPose([startX + (endX - startX) * frac, 0, z], zoom, 45);
                };
                h.setCameraPose([startX, 0, z], zoom, 45);
              }),
            {
              startX: panStartX,
              endX: panEndX,
              z: target[2],
              zoom: opts.panZoom,
              steps: opts.panSteps,
            }
          );

          const panFrames = panTelemetry.frames;
          const panDiag = panTelemetry.diag;
          panResults.push({
            mosaicLabel: summary.label,
            tileSizeMeters: summary.tileSizeMeters,
            foliageMode,
            zoom: opts.panZoom,
            panDistanceMeters: opts.panDistanceMeters,
            panSteps: opts.panSteps,
            frameMs: computeSampleStatistics(
              panFrames
                .map((f) => f.frameIntervalMs)
                .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
            ),
            cpuRenderMs: computeSampleStatistics(
              panFrames
                .map((f) => f.cpuRenderTimeMs)
                .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
            ),
            renderCalls: computeSampleStatistics(
              panFrames
                .map((f) => f.renderCalls)
                .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
            ),
            renderTriangles: computeSampleStatistics(
              panFrames
                .map((f) => f.renderTriangles)
                .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
            ),
            streamDuringPan: {
              fetchesCompleted: panDiag?.completedLoadsTotal ?? 0,
              avgFetchMs: panDiag?.avgFetchMs ?? 0,
              avgDecodeMs: panDiag?.avgDecodeMs ?? 0,
              avgReconstructMs: panDiag?.avgReconstructMs ?? 0,
              maxCommitMs: panDiag?.maxCommitMs ?? 0,
              tilesLoadedEnd: panDiag?.loadedTiles ?? 0,
              tilesVisibleEnd: panDiag?.visibleTiles ?? 0,
              tilesEvicted: panDiag?.evictedTilesTotal ?? 0,
            },
          });
        }
      }

      const report: SpatialBatchingBenchmarkReport = {
        generatedAtIso: new Date().toISOString(),
        viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
        themeId: opts.themeId,
        targetUtm: { easting: targetEasting, northing: targetNorthing },
        gpuVendor: gpuInfo.gpuVendor,
        gpuRenderer: gpuInfo.gpuRenderer,
        isSoftwareRenderer: isSoftware,
        softwareRendererWarning: softwareWarning,
        runsPerCase: opts.runs,
        warmupFrames: opts.warmupFrames,
        measuredFrames: opts.measuredFrames,
        mosaics: mosaicSummaries,
        stationaryResults,
        panResults,
      };

      fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
      fs.writeFileSync(opts.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      fs.mkdirSync(path.dirname(opts.markdownPath), { recursive: true });
      fs.writeFileSync(opts.markdownPath, formatSpatialBatchingMarkdown(report), 'utf8');

      return report;
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  const opts = parseSpatialBatchingCli(process.argv.slice(2));
  runSpatialBatchingBenchmark(opts)
    .then((report) => {
      console.log(
        `[bench:spatial-batching] Complete (${report.mosaics.map((m) => m.label).join(' vs ')}) on "${report.gpuRenderer}"`
      );
      console.log(`  JSON:     ${opts.outputPath}`);
      console.log(`  Markdown: ${opts.markdownPath}`);
    })
    .catch((err) => {
      console.error('[bench:spatial-batching] Failed:', err);
      process.exitCode = 1;
    });
}
