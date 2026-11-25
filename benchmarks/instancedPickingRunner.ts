/**
 * Reproducible Spatially Accelerated Instanced Feature Picking Benchmark Runner (TKT-038)
 *
 * Compares unaccelerated (vanilla Three.js linear `InstancedMesh.raycast`) vs. spatially
 * accelerated (`InstancedSpatialIndex` BVH) feature picking across 1,024 m, 2,048 m, and
 * 4,096 m regional mosaics under identical UTM targets, camera poses (zoom 6.5 / 1.2 / 0.65 / 0.15),
 * viewport dimensions, NDC ray grids, and foliage configurations (enabled vs. disabled).
 *
 * Measures:
 * - Overall, hit-only, and miss-only median / p95 / max raycast durations (full scene & foliage-only)
 * - Exact per-ray visible-hit parity (hit/miss, distance, instanceId, featureId) + invisible-batch phantom-hit suppression count
 * - Instanced broad-phase / narrow-phase diagnostics (candidates, exact tests, total queried instances, BVH nodes)
 * - Resident spatial index build time, memory footprint, and tile reconstruction latency
 * - Rendering regression guard (GL draw calls, submitted triangles, CPU render ms)
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
import type { InstancedPickingAggregateStats } from '../src/world/InstancedSpatialIndex';

export interface PickingBenchmarkPoseSpec {
  id: string;
  label: string;
  zoom: number;
  azimuthDeg: number;
}

export const DEFAULT_PICKING_BENCHMARK_POSES: readonly PickingBenchmarkPoseSpec[] = [
  { id: 'street', label: 'Close street (zoom 6.5)', zoom: 6.5, azimuthDeg: 45 },
  { id: 'default', label: 'Default startup (zoom 1.2)', zoom: 1.2, azimuthDeg: 45 },
  { id: 'city', label: 'City zoom-out (zoom 0.65)', zoom: 0.65, azimuthDeg: 45 },
  { id: 'regional_min', label: 'Regional minZoom (zoom 0.15)', zoom: 0.15, azimuthDeg: 45 },
];

export type PickingFoliageModeId = 'foliage_enabled_tkt036' | 'foliage_disabled';
export type PickingScopeId = 'full_scene' | 'foliage_only';

export interface PickingMosaicInput {
  label: string;
  tileSizeMeters: number;
  indexPath: string;
  apiBaseUrl: string;
}

export interface InstancedPickingCli {
  mosaics: PickingMosaicInput[];
  warmupPasses: number;
  passes: number;
  gridSize: number;
  frameWarmup: number;
  frameSamples: number;
  targetEasting: number | null;
  targetNorthing: number | null;
  themeId: string;
  requireHardware: boolean;
  outputPath: string;
  markdownPath: string;
}

export function parseInstancedPickingCli(
  argv: readonly string[] = process.argv.slice(2)
): InstancedPickingCli {
  let index1024: string | null = null;
  let index2048: string | null = null;
  let index4096: string | null = null;

  const opts: InstancedPickingCli = {
    mosaics: [],
    warmupPasses: 1,
    passes: 3,
    gridSize: 7,
    frameWarmup: 6,
    frameSamples: 20,
    targetEasting: null,
    targetNorthing: null,
    themeId: 'daylight',
    requireHardware: true,
    outputPath: path.resolve('benchmarks/results/tkt038-instanced-picking.json'),
    markdownPath: path.resolve('benchmarks/results/tkt038-instanced-picking.md'),
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
    else if (key === 'warmup-passes') opts.warmupPasses = Math.max(0, Math.floor(Number(val)));
    else if (key === 'passes') opts.passes = Math.max(1, Math.floor(Number(val)));
    else if (key === 'grid-size') opts.gridSize = Math.max(3, Math.floor(Number(val)));
    else if (key === 'frame-warmup') opts.frameWarmup = Math.max(1, Math.floor(Number(val)));
    else if (key === 'frame-samples') opts.frameSamples = Math.max(5, Math.floor(Number(val)));
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
      apiBaseUrl: '/api/tiles-pick-1024',
    });
  }
  if (index2048) {
    opts.mosaics.push({
      label: '2048m',
      tileSizeMeters: 2048,
      indexPath: index2048,
      apiBaseUrl: '/api/tiles-pick-2048',
    });
  }
  if (index4096) {
    opts.mosaics.push({
      label: '4096m',
      tileSizeMeters: 4096,
      indexPath: index4096,
      apiBaseUrl: '/api/tiles-pick-4096',
    });
  }

  if (opts.mosaics.length === 0) {
    throw new Error(
      'Provide at least one mosaic index via --index-1024=<path> --index-2048=<path> --index-4096=<path>'
    );
  }
  return opts;
}

export interface PerRayPickRecord {
  ndc: [number, number];
  hit: boolean;
  distance: number | null;
  instanceId: number | null;
  featureId: string | null;
  sourceFeatureId: string | null;
  objectName: string | null;
  objectVisible: boolean;
  isInstancedHit: boolean;
  nearestVisible: {
    distance: number;
    instanceId: number | null;
    featureId: string | null;
    sourceFeatureId: string | null;
    objectName: string | null;
    isInstancedHit: boolean;
  } | null;
}

export interface PickMeasurementPayload {
  mode: 'accelerated' | 'unaccelerated';
  scope: PickingScopeId;
  sampleCount: number;
  passes: number;
  totalQueries: number;
  hitCount: number;
  resolvedFeatureCount: number;
  medianMs: number;
  p95Ms: number;
  meanMs: number;
  maxMs: number;
  hitMedianMs: number;
  missMedianMs: number;
  sampleFeatureIds: string[];
  instancedDiagnostics: {
    avgBatchesVisited: number;
    avgBatchesSkippedInvisible: number;
    avgBatchesRejectedBroadPhase: number;
    avgBatchesTested: number;
    avgTotalInstancesInQueriedBatches: number;
    avgBvhNodesVisited: number;
    avgCandidateInstances: number;
    avgExactInstanceTests: number;
    avgInstancedDurationMs: number;
  };
  indexStats: InstancedPickingAggregateStats;
  perRayResults?: PerRayPickRecord[];
}

export interface ParityVerificationSummary {
  totalRays: number;
  visibleMatchedRays: number;
  visibleMismatchCount: number;
  invisiblePhantomHitsSuppressed: number;
  equalDistanceTieCount: number;
  maxDistanceDeltaMeters: number;
  sampleMismatches: Array<{
    rayIndex: number;
    ndc: [number, number];
    reason: string;
    unaccelerated: PerRayPickRecord['nearestVisible'];
    accelerated: PerRayPickRecord['nearestVisible'];
  }>;
}

export interface PickingScopeComparison {
  scope: PickingScopeId;
  unaccelerated: Omit<PickMeasurementPayload, 'perRayResults'>;
  accelerated: Omit<PickMeasurementPayload, 'perRayResults'>;
  speedupFactor: number;
  medianReductionPct: number;
  p95ReductionPct: number;
  candidateReductionPct: number;
  exactTestReductionPct: number;
  parity: ParityVerificationSummary;
}

export interface InstancedPickingPoseResult {
  mosaicLabel: string;
  tileSizeMeters: number;
  foliageMode: PickingFoliageModeId;
  poseId: string;
  poseLabel: string;
  zoom: number;
  loadedTiles: number;
  visibleTiles: number;
  renderRegression: {
    renderCallsMedian: number;
    renderTrianglesMedian: number;
    cpuRenderMsMedian: number;
    frameMsMedian: number;
    driverGeometries: number;
  };
  tileIndexOverhead: {
    avgReconstructMs: number;
    indexedBatchCount: number;
    totalIndexedInstances: number;
    totalIndexNodes: number;
    totalIndexMemoryBytes: number;
    totalIndexMemoryMB: number;
    totalBuildTimeMs: number;
    streamIndexedBytes: number;
    streamIndexBuildMsTotal: number;
  };
  fullScene: PickingScopeComparison;
  foliageOnly: PickingScopeComparison | null;
}

export interface PickingMosaicSummary {
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
}

export interface InstancedPickingBenchmarkReport {
  generatedAtIso: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  themeId: string;
  targetUtm: { easting: number; northing: number };
  gpuVendor: string;
  gpuRenderer: string;
  isSoftwareRenderer: boolean;
  softwareRendererWarning: string | null;
  gridSize: number;
  raysPerPass: number;
  warmupPasses: number;
  measuredPasses: number;
  mosaics: PickingMosaicSummary[];
  results: InstancedPickingPoseResult[];
  overallParity: {
    totalComparisons: number;
    totalRaysVerified: number;
    totalVisibleMismatches: number;
    totalInvisiblePhantomHitsSuppressed: number;
  };
}

export function buildPickingNdcGrid(gridSize: number): Array<[number, number]> {
  const n = Math.max(3, Math.floor(gridSize));
  const points: Array<[number, number]> = [];
  const span = 1.5; // [-0.75, +0.75]
  for (let row = 0; row < n; row++) {
    const ny = -0.75 + (span * row) / (n - 1);
    for (let col = 0; col < n; col++) {
      const nx = -0.75 + (span * col) / (n - 1);
      points.push([Number(nx.toFixed(4)), Number(ny.toFixed(4))]);
    }
  }
  return points;
}

export function comparePickingParity(
  unaccelRays: readonly PerRayPickRecord[],
  accelRays: readonly PerRayPickRecord[],
  distanceToleranceMeters: number = 1e-4
): ParityVerificationSummary {
  const totalRays = Math.min(unaccelRays.length, accelRays.length);
  let visibleMatchedRays = 0;
  let visibleMismatchCount = 0;
  let invisiblePhantomHitsSuppressed = 0;
  let equalDistanceTieCount = 0;
  let maxDistanceDeltaMeters = 0;
  const sampleMismatches: ParityVerificationSummary['sampleMismatches'] = [];

  for (let i = 0; i < totalRays; i++) {
    const u = unaccelRays[i];
    const a = accelRays[i];

    // Vanilla Three.js InstancedMesh.raycast does not check hierarchy visibility, so when
    // trunks or 3D sleepers are hidden it can report phantom hits on invisible batches.
    if (u.hit && !u.objectVisible) {
      invisiblePhantomHitsSuppressed++;
    }

    const uv = u.nearestVisible;
    const av = a.nearestVisible;

    if (!uv && !av) {
      visibleMatchedRays++;
      continue;
    }

    if (!uv || !av) {
      visibleMismatchCount++;
      if (sampleMismatches.length < 10) {
        sampleMismatches.push({
          rayIndex: i,
          ndc: u.ndc,
          reason: uv ? 'accelerated_missed_visible_hit' : 'accelerated_hit_where_unaccelerated_missed',
          unaccelerated: uv,
          accelerated: av,
        });
      }
      continue;
    }

    const distDelta = Math.abs(uv.distance - av.distance);
    if (distDelta > maxDistanceDeltaMeters) {
      maxDistanceDeltaMeters = Number(distDelta.toFixed(6));
    }

    if (distDelta > distanceToleranceMeters) {
      visibleMismatchCount++;
      if (sampleMismatches.length < 10) {
        sampleMismatches.push({
          rayIndex: i,
          ndc: u.ndc,
          reason: `distance_mismatch_${distDelta.toFixed(6)}m`,
          unaccelerated: uv,
          accelerated: av,
        });
      }
      continue;
    }

    const sameFeature =
      uv.instanceId === av.instanceId &&
      uv.featureId === av.featureId &&
      uv.objectName === av.objectName;

    if (sameFeature) {
      visibleMatchedRays++;
    } else if (distDelta <= 1e-4) {
      // Exact equal-distance tie between two overlapping surfaces at the same hit point
      equalDistanceTieCount++;
      visibleMatchedRays++;
    } else {
      visibleMismatchCount++;
      if (sampleMismatches.length < 10) {
        sampleMismatches.push({
          rayIndex: i,
          ndc: u.ndc,
          reason: 'feature_or_instance_mismatch',
          unaccelerated: uv,
          accelerated: av,
        });
      }
    }
  }

  return {
    totalRays,
    visibleMatchedRays,
    visibleMismatchCount,
    invisiblePhantomHitsSuppressed,
    equalDistanceTieCount,
    maxDistanceDeltaMeters,
    sampleMismatches,
  };
}

function summarizeComparison(
  scope: PickingScopeId,
  unaccel: PickMeasurementPayload,
  accel: PickMeasurementPayload
): PickingScopeComparison {
  const parity = comparePickingParity(
    unaccel.perRayResults ?? [],
    accel.perRayResults ?? []
  );

  const uMed = unaccel.medianMs;
  const aMed = accel.medianMs;
  const speedupFactor =
    aMed > 0
      ? Number((uMed / aMed).toFixed(2))
      : uMed > 0
        ? Number((uMed / Math.max(accel.meanMs, 0.05)).toFixed(2))
        : 1;
  const medianReductionPct =
    uMed > 0
      ? Number((((uMed - Math.min(uMed, aMed > 0 ? aMed : accel.meanMs)) / uMed) * 100).toFixed(1))
      : 0;
  const p95ReductionPct =
    unaccel.p95Ms > 0
      ? Number((((unaccel.p95Ms - accel.p95Ms) / unaccel.p95Ms) * 100).toFixed(1))
      : 0;

  const uInst = unaccel.instancedDiagnostics.avgTotalInstancesInQueriedBatches;
  const aCand = accel.instancedDiagnostics.avgCandidateInstances;
  const aExact = accel.instancedDiagnostics.avgExactInstanceTests;
  const candidateReductionPct =
    uInst > 0 ? Number((((uInst - aCand) / uInst) * 100).toFixed(2)) : 0;
  const exactTestReductionPct =
    uInst > 0 ? Number((((uInst - aExact) / uInst) * 100).toFixed(2)) : 0;

  const { perRayResults: _uDrop, ...unaccelClean } = unaccel;
  const { perRayResults: _aDrop, ...accelClean } = accel;
  void _uDrop;
  void _aDrop;

  return {
    scope,
    unaccelerated: unaccelClean,
    accelerated: accelClean,
    speedupFactor,
    medianReductionPct,
    p95ReductionPct,
    candidateReductionPct,
    exactTestReductionPct,
    parity,
  };
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

async function startMultiMosaicPickingServer(
  mosaics: readonly PickingMosaicInput[]
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

export function formatInstancedPickingMarkdown(
  report: InstancedPickingBenchmarkReport
): string {
  const lines: string[] = [
    '# TKT-038 Spatially Accelerated Instanced Feature Picking Benchmark Report',
    '',
    `- **Generated:** ${report.generatedAtIso}`,
    `- **Viewport:** ${report.viewport.width} × ${report.viewport.height} @ DPR ${report.viewport.deviceScaleFactor} | **Theme:** \`${report.themeId}\``,
    `- **Shared Geographic UTM Target:** E ${report.targetUtm.easting.toFixed(1)} m, N ${report.targetUtm.northing.toFixed(1)} m`,
    `- **WebGL Renderer:** \`${report.gpuRenderer}\` (${report.gpuVendor})`,
    `- **Renderer Classification:** ${
      report.isSoftwareRenderer
        ? '**SOFTWARE RENDERER (SwiftShader — CPU picking & parity are deterministic, but frame/GPU timings are NOT representative of discrete hardware)**'
        : 'Hardware WebGL2 GPU'
    }`,
    `- **Picking Grid:** ${report.gridSize} × ${report.gridSize} (${report.raysPerPass} NDC rays/pass) × ${report.warmupPasses} warmup + ${report.measuredPasses} measured pass(es)`,
    `- **Overall Parity Verification:** ${report.overallParity.totalRaysVerified} rays across ${report.overallParity.totalComparisons} scope comparisons — **${report.overallParity.totalVisibleMismatches} visible mismatches**, ${report.overallParity.totalInvisiblePhantomHitsSuppressed} hidden-batch phantom hits suppressed`,
    '',
  ];

  if (report.softwareRendererWarning) {
    lines.push(`> **Warning:** ${report.softwareRendererWarning}`, '');
  }

  const foliageModes: PickingFoliageModeId[] = ['foliage_enabled_tkt036', 'foliage_disabled'];
  for (const fMode of foliageModes) {
    lines.push(
      `## Full-Scene Feature Picking — ${fMode === 'foliage_enabled_tkt036' ? 'Foliage Enabled (TKT-036)' : 'Foliage Disabled'}`,
      '',
      '| Pose | Tile Size | Loaded / Vis Tiles | Unaccel med / p95 / max (ms) | Accel med / p95 / max (ms) | Speedup | Hit / Miss med Accel (ms) | Avg Queried → Exact Tests | Parity (Vis Mismatch) |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|'
    );

    for (const pose of DEFAULT_PICKING_BENCHMARK_POSES) {
      const rows = report.results.filter(
        (r) => r.foliageMode === fMode && r.poseId === pose.id
      );
      for (const r of rows) {
        const fsComp = r.fullScene;
        const u = fsComp.unaccelerated;
        const a = fsComp.accelerated;
        lines.push(
          `| ${pose.id} (${pose.zoom}) | ${r.tileSizeMeters} m | ${r.loadedTiles} / ${r.visibleTiles} | ${u.medianMs.toFixed(3)} / ${u.p95Ms.toFixed(3)} / ${u.maxMs.toFixed(3)} | ${a.medianMs.toFixed(3)} / ${a.p95Ms.toFixed(3)} / ${a.maxMs.toFixed(3)} | ${fsComp.speedupFactor.toFixed(2)}× (-${fsComp.medianReductionPct.toFixed(1)}%) | ${a.hitMedianMs.toFixed(3)} / ${a.missMedianMs.toFixed(3)} | ${Math.round(u.instancedDiagnostics.avgTotalInstancesInQueriedBatches).toLocaleString()} → ${a.instancedDiagnostics.avgExactInstanceTests.toFixed(1)} | ${fsComp.parity.visibleMismatchCount}/${fsComp.parity.totalRays} |`
        );
      }
    }
    lines.push('');
  }

  const foliageOnlyRows = report.results.filter(
    (r) => r.foliageMode === 'foliage_enabled_tkt036' && r.foliageOnly !== null
  );
  if (foliageOnlyRows.length > 0) {
    lines.push(
      '## Isolated Foliage Picking (`foliage_only` Scope)',
      '',
      '| Pose | Tile Size | Unaccel med / p95 (ms) | Accel med / p95 (ms) | Speedup | Avg BVH Nodes | Avg Candidates | Avg Exact Tests | Parity (Vis Mismatch) |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|'
    );
    for (const r of foliageOnlyRows) {
      const fo = r.foliageOnly!;
      const u = fo.unaccelerated;
      const a = fo.accelerated;
      lines.push(
        `| ${r.poseId} (${r.zoom}) | ${r.tileSizeMeters} m | ${u.medianMs.toFixed(3)} / ${u.p95Ms.toFixed(3)} | ${a.medianMs.toFixed(3)} / ${a.p95Ms.toFixed(3)} | ${fo.speedupFactor.toFixed(2)}× (-${fo.medianReductionPct.toFixed(1)}%) | ${a.instancedDiagnostics.avgBvhNodesVisited.toFixed(1)} | ${a.instancedDiagnostics.avgCandidateInstances.toFixed(1)} | ${a.instancedDiagnostics.avgExactInstanceTests.toFixed(1)} | ${fo.parity.visibleMismatchCount}/${fo.parity.totalRays} |`
      );
    }
    lines.push('');
  }

  lines.push(
    '## Spatial Index Footprint & Rendering Regression Guard (Foliage Enabled)',
    '',
    '| Pose | Tile Size | Indexed Batches | Indexed Instances | Index Nodes | Index Memory | Index Build Total | Avg Tile Recon | GL Calls (med) | GL Tris (med) | CPU Render (med) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
  );
  for (const r of report.results.filter((x) => x.foliageMode === 'foliage_enabled_tkt036')) {
    const idx = r.tileIndexOverhead;
    const reg = r.renderRegression;
    lines.push(
      `| ${r.poseId} (${r.zoom}) | ${r.tileSizeMeters} m | ${idx.indexedBatchCount} | ${idx.totalIndexedInstances.toLocaleString()} | ${idx.totalIndexNodes.toLocaleString()} | ${idx.totalIndexMemoryMB.toFixed(2)} MB | ${idx.totalBuildTimeMs.toFixed(2)} ms | ${idx.avgReconstructMs.toFixed(2)} ms | ${reg.renderCallsMedian.toFixed(0)} | ${Math.round(reg.renderTrianglesMedian).toLocaleString()} | ${reg.cpuRenderMsMedian.toFixed(2)} ms |`
    );
  }
  lines.push('');

  return lines.join('\n');
}

export async function runInstancedPickingBenchmark(
  opts: InstancedPickingCli
): Promise<InstancedPickingBenchmarkReport> {
  let playwright: any;
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error('Playwright is required to run benchmarks/instancedPickingRunner.ts');
  }

  const server = await startMultiMosaicPickingServer(opts.mosaics);

  try {
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

    const mosaicSummaries: PickingMosaicSummary[] = opts.mosaics.map((m) => {
      const man = manifests.get(m.label);
      const meta = man.metadata;
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
              typeof (window as any).__BENCHMARK_MEASURE_FEATURE_PICK__ === 'function' &&
              document.querySelector('canvas')
          ),
        { timeout: 60000 }
      );

      const gpuInfo = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
        if (!gl) {
          throw new Error('Instanced picking benchmark requires an active WebGL2 canvas');
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
        isSoftwareWebGLRenderer(gpuInfo.gpuRenderer) || gpuInfo.gpuRenderer === 'Unknown';
      if (isSoftware && opts.requireHardware) {
        throw new Error(
          `Detected software/unverified WebGL renderer "${gpuInfo.gpuRenderer}". Re-run on hardware GPU or pass --allow-software for deterministic picking/parity verification.`
        );
      }

      const softwareWarning = isSoftware
        ? `Executed on software WebGL renderer (${gpuInfo.gpuRenderer}). CPU picking speedup, candidate/test counts, index overhead, and parity checks are deterministic; WebGL frame/GPU timings are NOT representative of discrete hardware.`
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
              (window as any).__BENCHMARK_FRAME_COLLECTOR__ = (t: BenchmarkFrameTelemetry) => {
                seen++;
                if (seen > warmup) out.push(t);
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

      const ndcGrid = buildPickingNdcGrid(opts.gridSize);
      const results: InstancedPickingPoseResult[] = [];
      const foliageModes: PickingFoliageModeId[] = [
        'foliage_enabled_tkt036',
        'foliage_disabled',
      ];

      for (const summary of mosaicSummaries) {
        const mosaicInput = opts.mosaics.find((m) => m.label === summary.label)!;
        const targetPose: [number, number, number] = [
          summary.targetLocalX,
          0,
          summary.targetLocalZ,
        ];
        console.log(
          `[bench:instanced-picking] Loading ${summary.label} (${summary.tileSizeMeters} m, ${summary.gridCols}×${summary.gridRows})...`
        );

        await page.evaluate(
          async ({ apiBaseUrl, themeId, target }) => {
            const harness = (window as any).__BENCHMARK_HARNESS__;
            await harness.unloadDataset?.();
            await harness.loadM2aStreaming({
              apiBaseUrl,
              preloadMarginTiles: 0.5,
              retainMarginTiles: 1,
              themeId,
              target,
              zoom: 1.2,
              azimuthDeg: 45,
              regionalMinZoom: 0.15,
              waitForIdle: true,
              timeoutMs: 120000,
            });
          },
          { apiBaseUrl: mosaicInput.apiBaseUrl, themeId: opts.themeId, target: targetPose }
        );

        for (const fMode of foliageModes) {
          const foliageVisible = fMode === 'foliage_enabled_tkt036';
          await page.evaluate(
            async ({ visible }) => {
              const harness = (window as any).__BENCHMARK_HARNESS__;
              harness.setShowFoliage(visible);
              if (visible) {
                harness.setFoliageOptimizationConfig({
                  enabled: true,
                  lodMode: 'auto',
                  trunkSuppressionEnabled: true,
                  frustumCullingEnabled: true,
                });
              }
              harness.setInstancedPickingMode('accelerated');
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
            },
            { visible: foliageVisible }
          );

          for (const pose of DEFAULT_PICKING_BENCHMARK_POSES) {
            await page.evaluate(
              async ({ target, zoom, azimuthDeg }) => {
                const harness = (window as any).__BENCHMARK_HARNESS__;
                harness.setCameraPose(target, zoom, azimuthDeg);
                await new Promise<void>((r) => requestAnimationFrame(() => r()));
                await harness.waitForM2aIdle();
                await new Promise<void>((r) => requestAnimationFrame(() => r()));
              },
              {
                target: targetPose,
                zoom: pose.zoom,
                azimuthDeg: pose.azimuthDeg,
              }
            );

            // Capture rendering regression guard metrics + resident index telemetry
            const frames = await sampleFrames(opts.frameWarmup, opts.frameSamples);
            const streamDiag: TileStreamDiagnosticsSnapshot | null = await page.evaluate(
              () => (window as any).__BENCHMARK_HARNESS__?.getTileStreamDiagnostics?.() ?? null
            );

            const runPickMeasure = async (
              mode: 'accelerated' | 'unaccelerated',
              scope: PickingScopeId
            ): Promise<PickMeasurementPayload> => {
              return page.evaluate(
                ({ points, m, s, warmupPasses, passes }) =>
                  (window as any).__BENCHMARK_MEASURE_FEATURE_PICK__(points, {
                    mode: m,
                    scope: s,
                    warmupPasses,
                    passes,
                    returnDetails: true,
                  }),
                {
                  points: ndcGrid,
                  m: mode,
                  s: scope,
                  warmupPasses: opts.warmupPasses,
                  passes: opts.passes,
                }
              );
            };

            const fullUnaccel = await runPickMeasure('unaccelerated', 'full_scene');
            const fullAccel = await runPickMeasure('accelerated', 'full_scene');
            const fullSceneComparison = summarizeComparison('full_scene', fullUnaccel, fullAccel);

            let foliageOnlyComparison: PickingScopeComparison | null = null;
            if (foliageVisible) {
              const foUnaccel = await runPickMeasure('unaccelerated', 'foliage_only');
              const foAccel = await runPickMeasure('accelerated', 'foliage_only');
              foliageOnlyComparison = summarizeComparison('foliage_only', foUnaccel, foAccel);
            }

            const renderCallsStats = computeSampleStatistics(frames.map((f) => f.renderCalls));
            const renderTrisStats = computeSampleStatistics(frames.map((f) => f.renderTriangles));
            const cpuRenderStats = computeSampleStatistics(frames.map((f) => f.cpuRenderTimeMs));
            const frameStats = computeSampleStatistics(frames.map((f) => f.frameIntervalMs));
            const idxStats = fullAccel.indexStats;

            results.push({
              mosaicLabel: summary.label,
              tileSizeMeters: summary.tileSizeMeters,
              foliageMode: fMode,
              poseId: pose.id,
              poseLabel: pose.label,
              zoom: pose.zoom,
              loadedTiles: streamDiag?.loadedTiles ?? 0,
              visibleTiles: streamDiag?.visibleTiles ?? 0,
              renderRegression: {
                renderCallsMedian: renderCallsStats.median,
                renderTrianglesMedian: renderTrisStats.median,
                cpuRenderMsMedian: cpuRenderStats.median,
                frameMsMedian: frameStats.median,
                driverGeometries: frames[frames.length - 1]?.driverGeometries ?? 0,
              },
              tileIndexOverhead: {
                avgReconstructMs: streamDiag?.avgReconstructMs ?? 0,
                indexedBatchCount: idxStats.indexedBatchCount,
                totalIndexedInstances: idxStats.totalIndexedInstances,
                totalIndexNodes: idxStats.totalIndexNodes,
                totalIndexMemoryBytes: idxStats.totalIndexMemoryBytes,
                totalIndexMemoryMB: Number(
                  (idxStats.totalIndexMemoryBytes / (1024 * 1024)).toFixed(3)
                ),
                totalBuildTimeMs: idxStats.totalBuildTimeMs,
                streamIndexedBytes: streamDiag?.tileInstancedIndexBytes ?? 0,
                streamIndexBuildMsTotal: streamDiag?.tileInstancedIndexBuildMsTotal ?? 0,
              },
              fullScene: fullSceneComparison,
              foliageOnly: foliageOnlyComparison,
            });

            console.log(
              `  [${summary.label} | ${fMode} | ${pose.id}] full: ${fullUnaccel.medianMs.toFixed(2)}ms -> ${fullAccel.medianMs.toFixed(2)}ms (${fullSceneComparison.speedupFactor.toFixed(1)}x, visMismatch=${fullSceneComparison.parity.visibleMismatchCount})` +
                (foliageOnlyComparison
                  ? ` | foliage: ${foliageOnlyComparison.unaccelerated.medianMs.toFixed(2)}ms -> ${foliageOnlyComparison.accelerated.medianMs.toFixed(2)}ms (${foliageOnlyComparison.speedupFactor.toFixed(1)}x)`
                  : '')
            );
          }
        }
      }

      let totalComparisons = 0;
      let totalRaysVerified = 0;
      let totalVisibleMismatches = 0;
      let totalInvisiblePhantomHitsSuppressed = 0;
      for (const r of results) {
        totalComparisons++;
        totalRaysVerified += r.fullScene.parity.totalRays;
        totalVisibleMismatches += r.fullScene.parity.visibleMismatchCount;
        totalInvisiblePhantomHitsSuppressed += r.fullScene.parity.invisiblePhantomHitsSuppressed;
        if (r.foliageOnly) {
          totalComparisons++;
          totalRaysVerified += r.foliageOnly.parity.totalRays;
          totalVisibleMismatches += r.foliageOnly.parity.visibleMismatchCount;
          totalInvisiblePhantomHitsSuppressed +=
            r.foliageOnly.parity.invisiblePhantomHitsSuppressed;
        }
      }

      const report: InstancedPickingBenchmarkReport = {
        generatedAtIso: new Date().toISOString(),
        viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
        themeId: opts.themeId,
        targetUtm: { easting: targetEasting, northing: targetNorthing },
        gpuVendor: gpuInfo.gpuVendor,
        gpuRenderer: gpuInfo.gpuRenderer,
        isSoftwareRenderer: isSoftware,
        softwareRendererWarning: softwareWarning,
        gridSize: opts.gridSize,
        raysPerPass: ndcGrid.length,
        warmupPasses: opts.warmupPasses,
        measuredPasses: opts.passes,
        mosaics: mosaicSummaries,
        results,
        overallParity: {
          totalComparisons,
          totalRaysVerified,
          totalVisibleMismatches,
          totalInvisiblePhantomHitsSuppressed,
        },
      };

      fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
      fs.writeFileSync(opts.outputPath, JSON.stringify(report, null, 2), 'utf8');
      fs.mkdirSync(path.dirname(opts.markdownPath), { recursive: true });
      fs.writeFileSync(opts.markdownPath, formatInstancedPickingMarkdown(report), 'utf8');

      console.log(`[bench:instanced-picking] Wrote JSON: ${opts.outputPath}`);
      console.log(`[bench:instanced-picking] Wrote Markdown: ${opts.markdownPath}`);
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
  const cli = parseInstancedPickingCli(process.argv.slice(2));
  runInstancedPickingBenchmark(cli).catch((err) => {
    console.error('[bench:instanced-picking] FAILED:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
