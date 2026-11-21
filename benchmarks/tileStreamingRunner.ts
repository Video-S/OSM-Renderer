import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BenchmarkEnvironmentMetadata, ChromiumGpuBackend, SampleStatistics } from './types';
import { computeSampleStatistics } from './stats';
import { collectHostEnvironmentMetadata, isSoftwareWebGLRenderer } from './environment';
import {
  buildLocalServerSpawnSpec,
  parseChromiumGpuBackend,
  terminateChildProcessTree,
} from './cliAndServer';
import { resolveChromiumLaunchArgs } from './browserRunner';
import {
  type BenchmarkFrameTelemetry,
  computeConsecutiveFrameIntervalsMs,
} from '../src/types/BenchmarkTelemetry';
import { MAP_THEMES } from '../src/styles/mapThemes';
import { createAlignedStudyGrid } from '../src/world/tiling/TileGrid';
import { ingestCanonicalStudyGeoJson } from '../src/world/tiling/TiledStudyPipeline';
import {
  bakeStudyRegionTilesToSqlite,
  disposeIngestedStudyRegionPlans,
} from '../src/server/tiles/OfflineHengeloTileBaker';
import { TilePackSqliteStore } from '../src/server/tiles/TilePackSqliteStore';
import { inflateTilePayload } from '../src/server/tiles/TileCompression';
import { formatTileId } from '../src/world/tiling/TileGrid';
import type { TileStreamDiagnosticsSnapshot, TileTimingSummaryStats } from '../src/world/tiling/TileStreamManager';

export const M2B_BENCHMARK_SCHEMA_VERSION = '1.0.0' as const;

export type TileBenchmarkDatasetKind = 'canonical-hengelo' | 'synthetic-smoke-4x4';

export type TileBenchmarkModeId =
  | 'm1a_single_scene'
  | 'm1a_tiled_64'
  | 'm2a_streaming';

export type TileBenchmarkScenarioId =
  | 'closeup_station'
  | 'medium_navigation'
  | 'far_overview'
  | 'continuous_pan'
  | 'repeated_pan_eviction';

export const ALL_TILE_BENCHMARK_MODES: readonly TileBenchmarkModeId[] = Object.freeze([
  'm1a_single_scene',
  'm1a_tiled_64',
  'm2a_streaming',
]);

export const ALL_TILE_BENCHMARK_SCENARIOS: readonly TileBenchmarkScenarioId[] = Object.freeze([
  'closeup_station',
  'medium_navigation',
  'far_overview',
  'continuous_pan',
  'repeated_pan_eviction',
]);

export interface TileStreamingCliOptions {
  dataset: TileBenchmarkDatasetKind;
  modes: TileBenchmarkModeId[];
  scenarios: TileBenchmarkScenarioId[];
  warmupFrames: number;
  measuredFrames: number;
  evictionHops: number;
  quick: boolean;
  useSwiftShader: boolean;
  gpuBackend: ChromiumGpuBackend;
  requireHardwareGpu: boolean;
  headless: boolean;
  serverUrl?: string;
  outputPath?: string;
  markdownOutputPath?: string;
  quiet: boolean;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  themeId: string;
}

export interface SceneMeshCountsSnapshot {
  total: {
    totalMeshes: number;
    visibleFlagMeshes: number;
    frustumVisibleMeshes: number;
  };
  byLayer: Record<
    string,
    {
      totalMeshes: number;
      visibleFlagMeshes: number;
      frustumVisibleMeshes: number;
    }
  >;
}

export interface TileStreamingPhaseMetrics {
  phaseId: string;
  warmupFrames: number;
  measuredFrames: number;
  frameIntervalMs: SampleStatistics;
  effectiveMedianFps: number;
  spikesOver33msCount: number;
  spikesOver50msCount: number;
  cpuRenderTimeMs: SampleStatistics;
  gpuFrameRenderTimeMs: {
    status: 'supported' | 'unsupported' | 'disjoint' | 'unavailable';
    statistics: SampleStatistics | null;
    sampleCounts: {
      totalFrames: number;
      valid: number;
      pending: number;
      disjoint: number;
      unsupported: number;
    };
  };
  webglDrawCallsPerFrame: SampleStatistics;
  renderedTrianglesPerFrame: SampleStatistics;
  meshCounts: SceneMeshCountsSnapshot | null;
  driverResourcesEnd: {
    driverGeometries: number;
    driverTextures: number;
    driverPrograms: number;
  };
  browserMemoryMB: {
    supported: boolean;
    usedJSHeapSizeMB: number | null;
    totalJSHeapSizeMB: number | null;
    jsHeapSizeLimitMB: number | null;
  };
  cpuBufferMB: number | null;
  bvhMemoryMB: number | null;
  streamingDiagnostics?: TileStreamDiagnosticsSnapshot | null;
  extraPanSettleMs?: number | null;
}

export interface RepeatedEvictionHopRecord {
  hopIndex: number;
  quadrant: 'NW' | 'SE';
  target: [number, number, number];
  zoom: number;
  settleDurationMs: number;
  framesMeasured: number;
  maxFrameIntervalMs: number;
  spikesOver33msCount: number;
  spikesOver50msCount: number;
  loadedTiles: number | null;
  visibleTiles: number | null;
  evictedTilesTotal: number | null;
  completedLoadsTotal: number | null;
  tileCpuGeometryBytes: number | null;
  tileBvhBytes: number | null;
  driverGeometries: number;
  driverTextures: number;
  usedJSHeapSizeMB: number | null;
}

export interface TileBenchmarkScenarioResult {
  scenarioId: TileBenchmarkScenarioId;
  cameraPoseSummary: string;
  primaryMetrics: TileStreamingPhaseMetrics;
  /** Populated for `continuous_pan` (`Phase B: settledPostPanSteadyState` after active streaming completes) */
  settledSteadyStateMetrics?: TileStreamingPhaseMetrics;
  /** Populated for `repeated_pan_eviction` */
  evictionLifecycle?: {
    hopsExecuted: number;
    cyclesExecuted: number;
    hops: RepeatedEvictionHopRecord[];
    nwCycle0VsFinalDelta: {
      loadedTilesDelta: number | null;
      tileCpuGeometryBytesDelta: number | null;
      tileBvhBytesDelta: number | null;
      driverGeometriesDelta: number;
      driverTexturesDelta: number;
      usedJSHeapDeltaMB: number | null;
    } | null;
    seCycle0VsFinalDelta: {
      loadedTilesDelta: number | null;
      tileCpuGeometryBytesDelta: number | null;
      tileBvhBytesDelta: number | null;
      driverGeometriesDelta: number;
      driverTexturesDelta: number;
      usedJSHeapDeltaMB: number | null;
    } | null;
    postUnloadDriverGeometries: number | null;
    postUnloadDriverTextures: number | null;
    postUnloadUsedJSHeapMB: number | null;
    cleanResourceStabilizationVerified: boolean;
  };
}

export interface TileBenchmarkModeResult {
  modeId: TileBenchmarkModeId;
  modeLabel: string;
  tileCountInGrid: number;
  initialization: {
    fetchOrManifestMs: number;
    ingestMs: number | null;
    referenceBuildMs: number | null;
    tiledBuildMs: number | null;
    totalInitToFirstFrameMs: number;
    sharedMaterialCount: number | null;
  };
  scenarios: TileBenchmarkScenarioResult[];
}

export interface CrossModeScenarioComparison {
  scenarioId: TileBenchmarkScenarioId;
  m1aSingleMeshes: number | null;
  m1aTiledMeshes: number | null;
  m2aStreamingMeshesTotal: number | null;
  m2aStreamingMeshesFrustum: number | null;
  meshReductionStreamingVsAllTilesPct: number | null;
  meshRatioStreamingVsSingleScene: number | null;
  m1aSingleDrawCalls: number | null;
  m1aTiledDrawCalls: number | null;
  m2aStreamingDrawCalls: number | null;
  drawCallReductionStreamingVsAllTilesPct: number | null;
  drawCallRatioStreamingVsSingleScene: number | null;
  m1aSingleTriangles: number | null;
  m1aTiledTriangles: number | null;
  m2aStreamingTriangles: number | null;
  m1aSingleFrameMedianMs: number | null;
  m1aTiledFrameMedianMs: number | null;
  m2aStreamingFrameMedianMs: number | null;
  m1aSingleCpuRenderMs: number | null;
  m1aTiledCpuRenderMs: number | null;
  m2aStreamingCpuRenderMs: number | null;
}

export interface TileStreamingBenchmarkReport {
  schemaVersion: typeof M2B_BENCHMARK_SCHEMA_VERSION;
  benchmarkName: string;
  ticket: 'TKT-028';
  milestone: 'M2-B';
  dataset: {
    id: TileBenchmarkDatasetKind;
    description: string;
    gridCols: number;
    gridRows: number;
    totalGridTiles: number;
    tileSizeMeters: number;
    isCanonicalHengelo: boolean;
  };
  renderSettings: {
    viewportWidth: number;
    viewportHeight: number;
    devicePixelRatio: number;
    themeId: string;
    roadsMode: 'graph-surface';
    railwaysMode: 'graph-R+';
    preloadMarginTiles: number;
    retainMarginTiles: number;
    maxConcurrentFetches: number;
    maxCommitsPerFrame: number;
  };
  environment: BenchmarkEnvironmentMetadata;
  modes: TileBenchmarkModeResult[];
  comparisons: CrossModeScenarioComparison[];
  notes: string[];
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

function parseIntFlag(raw: string, flagName: string, min: number): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Invalid integer for ${flagName}: "${raw}".`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`Flag ${flagName} must be >= ${min}, received "${raw}".`);
  }
  return parsed;
}

/**
 * Parses CLI flags for `benchmarks/tileStreamingRunner.ts` with PowerShell comma-split compatibility.
 */
export function parseTileStreamingCliArgs(
  argv: readonly string[]
): TileStreamingCliOptions {
  let dataset: TileBenchmarkDatasetKind = 'canonical-hengelo';
  let modes: TileBenchmarkModeId[] = [...ALL_TILE_BENCHMARK_MODES];
  let scenarios: TileBenchmarkScenarioId[] = [...ALL_TILE_BENCHMARK_SCENARIOS];
  let warmupFrames = 6;
  let measuredFrames = 24;
  let evictionHops = 12;
  let quick = false;
  let useSwiftShader = false;
  let gpuBackend: ChromiumGpuBackend = 'auto';
  let requireHardwareGpu = false;
  let headless = true;
  let serverUrl: string | undefined;
  let outputPath: string | undefined;
  let noSave = false;
  let markdownOutputPath: string | undefined;
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dataset' || arg.startsWith('--dataset=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--dataset');
      if (value !== 'canonical-hengelo' && value !== 'synthetic-smoke-4x4') {
        throw new Error(
          `Unsupported --dataset "${value}". Expected "canonical-hengelo" or "synthetic-smoke-4x4".`
        );
      }
      dataset = value;
      i = nextIndex;
    } else if (
      arg === '--modes' ||
      arg === '--mode' ||
      arg.startsWith('--modes=') ||
      arg.startsWith('--mode=')
    ) {
      const eqIdx = arg.indexOf('=');
      const { values, nextIndex } =
        eqIdx !== -1
          ? consumeListTokens(argv, i + 1, arg.slice(eqIdx + 1))
          : consumeListTokens(argv, i + 1);
      if (values.length === 0) {
        throw new Error('Flag --modes requires at least one mode ID.');
      }
      for (const v of values) {
        if (!(ALL_TILE_BENCHMARK_MODES as readonly string[]).includes(v)) {
          throw new Error(
            `Unknown mode "${v}". Expected one of: ${ALL_TILE_BENCHMARK_MODES.join(', ')}.`
          );
        }
      }
      modes = Array.from(new Set(values)) as TileBenchmarkModeId[];
      i = nextIndex;
    } else if (
      arg === '--scenarios' ||
      arg === '--scenario' ||
      arg.startsWith('--scenarios=') ||
      arg.startsWith('--scenario=')
    ) {
      const eqIdx = arg.indexOf('=');
      const { values, nextIndex } =
        eqIdx !== -1
          ? consumeListTokens(argv, i + 1, arg.slice(eqIdx + 1))
          : consumeListTokens(argv, i + 1);
      if (values.length === 0) {
        throw new Error('Flag --scenarios requires at least one scenario ID.');
      }
      for (const v of values) {
        if (!(ALL_TILE_BENCHMARK_SCENARIOS as readonly string[]).includes(v)) {
          throw new Error(
            `Unknown scenario "${v}". Expected one of: ${ALL_TILE_BENCHMARK_SCENARIOS.join(', ')}.`
          );
        }
      }
      scenarios = Array.from(new Set(values)) as TileBenchmarkScenarioId[];
      i = nextIndex;
    } else if (arg === '--warmup-frames' || arg.startsWith('--warmup-frames=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--warmup-frames');
      warmupFrames = parseIntFlag(value, '--warmup-frames', 1);
      i = nextIndex;
    } else if (arg === '--measured-frames' || arg.startsWith('--measured-frames=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--measured-frames');
      measuredFrames = parseIntFlag(value, '--measured-frames', 4);
      i = nextIndex;
    } else if (arg === '--eviction-hops' || arg.startsWith('--eviction-hops=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--eviction-hops');
      evictionHops = parseIntFlag(value, '--eviction-hops', 2);
      i = nextIndex;
    } else if (arg === '--quick') {
      quick = true;
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
    } else if (arg === '--url' || arg.startsWith('--url=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--url');
      serverUrl = value;
      i = nextIndex;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--out');
      outputPath = value;
      i = nextIndex;
    } else if (arg === '--markdown-out' || arg.startsWith('--markdown-out=')) {
      const { value, nextIndex } = readSingleValueFlag(argv, i, '--markdown-out');
      markdownOutputPath = value;
      i = nextIndex;
    } else if (arg === '--no-save') {
      noSave = true;
    } else if (arg === '--quiet') {
      quiet = true;
    } else {
      throw new Error(`Unknown CLI argument for bench:tiles: "${arg}".`);
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

  if (quick) {
    warmupFrames = Math.min(warmupFrames, 3);
    measuredFrames = Math.min(measuredFrames, 12);
    evictionHops = Math.max(10, Math.min(evictionHops, 10));
  }

  const defaultOut =
    dataset === 'canonical-hengelo'
      ? 'benchmarks/results/tkt028-m2b-hengelo-streaming.json'
      : 'benchmarks/results/tkt028-m2b-synthetic-smoke.json';

  return {
    dataset,
    modes,
    scenarios,
    warmupFrames,
    measuredFrames,
    evictionHops,
    quick,
    useSwiftShader,
    gpuBackend,
    requireHardwareGpu,
    headless,
    serverUrl,
    outputPath: noSave ? undefined : outputPath ?? defaultOut,
    markdownOutputPath,
    quiet,
    viewportWidth: 1440,
    viewportHeight: 900,
    devicePixelRatio: 1,
    themeId: 'tactical',
  };
}

/**
 * Generates a realistic multi-category synthetic 4x4 (2,048 m x 2,048 m) OSM GeoJSON fixture
 * aligned to the EPSG:25832 Hengelo study center so synthetic WebGL E2E runs exercise roads,
 * buildings, railway sleepers/switches, water, park, landuse, and trees across all 16 tiles.
 */
export function buildSynthetic4x4GeoJson() {
  const grid = createAlignedStudyGrid({
    name: 'study-m1a-custom',
    centerLonLat: [6.7935, 52.2625],
    cols: 4,
    rows: 4,
    tileSizeMeters: 512,
    collarMeters: 64,
  });

  const toLonLat = (x: number, z: number): [number, number] =>
    grid.projection.toGeo(x, z);
  const ringToLonLat = (pts: Array<[number, number]>) => [
    pts.map(([x, z]) => toLonLat(x, z)),
  ];

  const features: any[] = [];
  let featureSeq = 1;

  // Regional residential & forest landuse quadrants across all 4x4 tiles [-1024..1024]
  features.push({
    type: 'Feature',
    id: 'way/syn-res-west',
    properties: { id: 'way/syn-res-west', landuse: 'residential', name: 'Synthetic West' },
    geometry: {
      type: 'Polygon',
      coordinates: ringToLonLat([
        [-980, -980],
        [-30, -980],
        [-30, 980],
        [-980, 980],
        [-980, -980],
      ]),
    },
  });

  features.push({
    type: 'Feature',
    id: 'way/syn-park-east',
    properties: { id: 'way/syn-park-east', leisure: 'park', name: 'Synthetic Park' },
    geometry: {
      type: 'Polygon',
      coordinates: ringToLonLat([
        [80, -960],
        [960, -960],
        [960, -80],
        [80, -80],
        [80, -960],
      ]),
    },
  });

  features.push({
    type: 'Feature',
    id: 'way/syn-water-se',
    properties: { id: 'way/syn-water-se', natural: 'water', water: 'pond', name: 'SE Pond' },
    geometry: {
      type: 'Polygon',
      coordinates: ringToLonLat([
        [320, 320],
        [680, 320],
        [680, 680],
        [320, 680],
        [320, 320],
      ]),
    },
  });

  // Cross-tile arterial road grid spanning the entire 2,048 m x 2,048 m extent
  for (const offset of [-768, -256, 256, 768]) {
    const idEW = `way/syn-road-ew-${featureSeq++}`;
    features.push({
      type: 'Feature',
      id: idEW,
      properties: {
        id: idEW,
        highway: offset === -256 ? 'primary' : 'residential',
        name: `Avenue ${offset}`,
      },
      geometry: {
        type: 'LineString',
        coordinates: [toLonLat(-990, offset), toLonLat(0, offset), toLonLat(990, offset)],
      },
    });
    const idNS = `way/syn-road-ns-${featureSeq++}`;
    features.push({
      type: 'Feature',
      id: idNS,
      properties: {
        id: idNS,
        highway: offset === 256 ? 'secondary' : 'residential',
        name: `Street ${offset}`,
      },
      geometry: {
        type: 'LineString',
        coordinates: [toLonLat(offset, -990), toLonLat(offset, 0), toLonLat(offset, 990)],
      },
    });
  }

  // Cross-tile dual-track railway corridor + siding turnout spanning central station & corners
  features.push({
    type: 'Feature',
    id: 'way/syn-rail-main-1',
    properties: {
      id: 'way/syn-rail-main-1',
      railway: 'rail',
      electrified: 'contact_line',
      name: 'Main Line N',
    },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-990, -10), toLonLat(0, -10), toLonLat(990, -10)],
    },
  });
  features.push({
    type: 'Feature',
    id: 'way/syn-rail-main-2',
    properties: {
      id: 'way/syn-rail-main-2',
      railway: 'rail',
      electrified: 'contact_line',
      name: 'Main Line S',
    },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-990, 10), toLonLat(0, 10), toLonLat(990, 10)],
    },
  });
  features.push({
    type: 'Feature',
    id: 'way/syn-rail-siding',
    properties: {
      id: 'way/syn-rail-siding',
      railway: 'rail',
      service: 'siding',
    },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(0, 10), toLonLat(90, 26), toLonLat(650, 26)],
    },
  });

  // Populate deterministic buildings in all 16 tiles (512 m tiles centered at -768,-256,256,768)
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const tileCx = -768 + col * 512;
      const tileCz = -768 + row * 512;
      const offsets: Array<[number, number, number, number, string]> = [
        [-140, -140, 32, 24, 'residential'],
        [120, -135, 38, 26, 'commercial'],
        [-130, 125, 28, 30, 'apartments'],
        [135, 130, 34, 22, 'industrial'],
      ];
      for (const [dx, dz, w, d, bType] of offsets) {
        const bx = tileCx + dx;
        const bz = tileCz + dz;
        const bid = `way/syn-bldg-${row}-${col}-${featureSeq++}`;
        features.push({
          type: 'Feature',
          id: bid,
          properties: {
            id: bid,
            building: bType,
            name: `Block ${row}-${col}-${featureSeq}`,
            height: String(10 + ((row + col) % 4) * 5),
          },
          geometry: {
            type: 'Polygon',
            coordinates: ringToLonLat([
              [bx - w / 2, bz - d / 2],
              [bx + w / 2, bz - d / 2],
              [bx + w / 2, bz + d / 2],
              [bx - w / 2, bz + d / 2],
              [bx - w / 2, bz - d / 2],
            ]),
          },
        });
      }
      // Corner trees for instanced foliage testing
      const treeId = `node/syn-tree-${row}-${col}-${featureSeq++}`;
      features.push({
        type: 'Feature',
        id: treeId,
        properties: { id: treeId, natural: 'tree', leaf_type: 'broadleaved' },
        geometry: {
          type: 'Point',
          coordinates: toLonLat(tileCx - 45, tileCz + 60),
        },
      });
    }
  }

  return {
    grid,
    geoJson: {
      type: 'FeatureCollection',
      features,
    },
  };
}

/**
 * Computes pure cross-mode comparison ratios & reductions from completed mode results.
 */
export function computeCrossModeComparisonSummary(
  modes: readonly TileBenchmarkModeResult[],
  scenarios: readonly TileBenchmarkScenarioId[]
): CrossModeScenarioComparison[] {
  const byMode = new Map<TileBenchmarkModeId, TileBenchmarkModeResult>();
  for (const m of modes) byMode.set(m.modeId, m);

  const m1Single = byMode.get('m1a_single_scene');
  const m1Tiled = byMode.get('m1a_tiled_64');
  const m2Stream = byMode.get('m2a_streaming');

  const getScenarioMetrics = (
    modeRes: TileBenchmarkModeResult | undefined,
    scenarioId: TileBenchmarkScenarioId
  ): TileStreamingPhaseMetrics | null => {
    const sc = modeRes?.scenarios.find((s) => s.scenarioId === scenarioId);
    return sc?.primaryMetrics ?? null;
  };

  return scenarios.map((scenarioId) => {
    const p1 = getScenarioMetrics(m1Single, scenarioId);
    const p2 = getScenarioMetrics(m1Tiled, scenarioId);
    const p3 = getScenarioMetrics(m2Stream, scenarioId);

    const m1aSingleMeshes = p1?.meshCounts?.total.totalMeshes ?? null;
    const m1aTiledMeshes = p2?.meshCounts?.total.totalMeshes ?? null;
    const m2aStreamingMeshesTotal = p3?.meshCounts?.total.totalMeshes ?? null;
    const m2aStreamingMeshesFrustum =
      p3?.meshCounts?.total.frustumVisibleMeshes ?? null;

    const meshReductionStreamingVsAllTilesPct =
      m1aTiledMeshes !== null &&
      m1aTiledMeshes > 0 &&
      m2aStreamingMeshesTotal !== null
        ? Number(
            (((m1aTiledMeshes - m2aStreamingMeshesTotal) / m1aTiledMeshes) * 100).toFixed(2)
          )
        : null;

    const meshRatioStreamingVsSingleScene =
      m1aSingleMeshes !== null &&
      m1aSingleMeshes > 0 &&
      m2aStreamingMeshesTotal !== null
        ? Number((m2aStreamingMeshesTotal / m1aSingleMeshes).toFixed(2))
        : null;

    const m1aSingleDrawCalls = p1 ? Number(p1.webglDrawCallsPerFrame.median.toFixed(1)) : null;
    const m1aTiledDrawCalls = p2 ? Number(p2.webglDrawCallsPerFrame.median.toFixed(1)) : null;
    const m2aStreamingDrawCalls = p3
      ? Number(p3.webglDrawCallsPerFrame.median.toFixed(1))
      : null;

    const drawCallReductionStreamingVsAllTilesPct =
      m1aTiledDrawCalls !== null &&
      m1aTiledDrawCalls > 0 &&
      m2aStreamingDrawCalls !== null
        ? Number(
            (((m1aTiledDrawCalls - m2aStreamingDrawCalls) / m1aTiledDrawCalls) * 100).toFixed(2)
          )
        : null;

    const drawCallRatioStreamingVsSingleScene =
      m1aSingleDrawCalls !== null &&
      m1aSingleDrawCalls > 0 &&
      m2aStreamingDrawCalls !== null
        ? Number((m2aStreamingDrawCalls / m1aSingleDrawCalls).toFixed(2))
        : null;

    return {
      scenarioId,
      m1aSingleMeshes,
      m1aTiledMeshes,
      m2aStreamingMeshesTotal,
      m2aStreamingMeshesFrustum,
      meshReductionStreamingVsAllTilesPct,
      meshRatioStreamingVsSingleScene,
      m1aSingleDrawCalls,
      m1aTiledDrawCalls,
      m2aStreamingDrawCalls,
      drawCallReductionStreamingVsAllTilesPct,
      drawCallRatioStreamingVsSingleScene,
      m1aSingleTriangles: p1 ? Math.round(p1.renderedTrianglesPerFrame.median) : null,
      m1aTiledTriangles: p2 ? Math.round(p2.renderedTrianglesPerFrame.median) : null,
      m2aStreamingTriangles: p3 ? Math.round(p3.renderedTrianglesPerFrame.median) : null,
      m1aSingleFrameMedianMs: p1 ? Number(p1.frameIntervalMs.median.toFixed(2)) : null,
      m1aTiledFrameMedianMs: p2 ? Number(p2.frameIntervalMs.median.toFixed(2)) : null,
      m2aStreamingFrameMedianMs: p3 ? Number(p3.frameIntervalMs.median.toFixed(2)) : null,
      m1aSingleCpuRenderMs: p1 ? Number(p1.cpuRenderTimeMs.median.toFixed(2)) : null,
      m1aTiledCpuRenderMs: p2 ? Number(p2.cpuRenderTimeMs.median.toFixed(2)) : null,
      m2aStreamingCpuRenderMs: p3 ? Number(p3.cpuRenderTimeMs.median.toFixed(2)) : null,
    };
  });
}

function fmtNum(v: number | null | undefined, digits = 1): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'n/a';
  return digits === 0 ? Math.round(v).toLocaleString('en-US') : v.toFixed(digits);
}

function fmtTimingStats(s: TileTimingSummaryStats | null | undefined): string {
  if (!s || s.count === 0) return 'n/a';
  return `med ${s.medianMs.toFixed(2)} ms / p95 ${s.p95Ms.toFixed(2)} ms / max ${s.maxMs.toFixed(2)} ms (n=${s.count})`;
}

/**
 * Formats a concise human-readable terminal & Markdown summary of an M2-B 3-mode comparison report.
 */
export function formatM2bMarkdownReport(report: TileStreamingBenchmarkReport): string {
  const lines: string[] = [];
  const env = report.environment;
  const b = env.browser;
  const provenanceBanner = report.dataset.isCanonicalHengelo
    ? b?.isSoftwareRenderer
      ? 'Canonical 8×8 Hengelo dataset rendered on **software WebGL (SwiftShader)** — geometry/draw-call/mesh/resource counts are exact, while frame/GPU timings reflect CPU rasterization.'
      : 'Canonical 8×8 Hengelo dataset rendered on **hardware GPU WebGL2**.'
    : `**Synthetic 4×4 smoke dataset (${report.dataset.totalGridTiles} tiles)** rendered on **${b?.isSoftwareRenderer ? 'software WebGL (SwiftShader)' : 'hardware GPU'}** — validates streaming pipeline end-to-end; canonical 8×8 Hengelo (64 tiles) metrics require running on a machine with \`data/osm/overijssel-tiles-261114-8ae28196.sqlite\`.`;

  lines.push(`# M2-B Streaming Performance & Memory Comparison Summary`);
  lines.push('');
  lines.push(`> **Provenance**: ${provenanceBanner}`);
  lines.push(`- **Timestamp**: \`${env.timestampIso}\` | **Git**: \`${env.gitCommitSha}\` (${env.gitMetadataStatus ?? 'unknown'})`);
  lines.push(`- **Host**: ${env.platform} (${env.arch}), ${env.cpuModel} (${env.cpuLogicalCores} logical cores), Node ${env.nodeVersion}`);
  if (b) {
    lines.push(
      `- **Browser & WebGL**: ${b.browserName} ${b.browserVersion}, \`${b.viewportWidth}×${b.viewportHeight}\` @ \`${b.devicePixelRatio}x\`, \`${b.webglVersion}\`, Renderer: \`${b.gpuRenderer}\` (${b.isSoftwareRenderer ? 'SOFTWARE' : 'HARDWARE'})`
    );
  }
  lines.push(
    `- **Dataset & Settings**: \`${report.dataset.id}\` (${report.dataset.gridCols}×${report.dataset.gridRows} = ${report.dataset.totalGridTiles} × ${report.dataset.tileSizeMeters} m tiles), theme \`${report.renderSettings.themeId}\`, \`E2+/R+\`, \`preload=${report.renderSettings.preloadMarginTiles}\`, \`retain=${report.renderSettings.retainMarginTiles}\`, \`maxFetches=${report.renderSettings.maxConcurrentFetches}\`, \`maxCommits=${report.renderSettings.maxCommitsPerFrame}\``
  );
  lines.push('');

  lines.push('## 1. Initialization & Static Scene Comparison');
  lines.push('');
  lines.push('| Mode | Grid Tiles | Fetch/Manifest (ms) | Ingest (ms) | Build/Init (ms) | Shared Materials |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const m of report.modes) {
    const buildOrTiled =
      m.modeId === 'm1a_single_scene'
        ? m.initialization.referenceBuildMs
        : m.modeId === 'm1a_tiled_64'
        ? m.initialization.tiledBuildMs
        : m.initialization.totalInitToFirstFrameMs;
    lines.push(
      `| \`${m.modeId}\` | ${m.tileCountInGrid} | ${fmtNum(m.initialization.fetchOrManifestMs, 2)} | ${fmtNum(m.initialization.ingestMs, 2)} | ${fmtNum(buildOrTiled, 2)} | ${m.initialization.sharedMaterialCount ?? 'n/a'} |`
    );
  }
  lines.push('');

  lines.push('## 2. Cross-Mode Mesh, Draw Call, Triangle & Frame Time Comparison');
  lines.push('');
  lines.push(
    '| Scenario | Single Meshes | All-Tiles Meshes | Stream Meshes (Total / Frustum) | Mesh vs All-Tiles | Single Calls | All-Tiles Calls | Stream Calls | Calls vs All-Tiles | Stream Tris Med | Frame Med (1 / All / Stream ms) | CPU Render Med (1 / All / Stream ms) |'
  );
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|');
  for (const c of report.comparisons) {
    lines.push(
      `| \`${c.scenarioId}\` | ${fmtNum(c.m1aSingleMeshes, 0)} | ${fmtNum(c.m1aTiledMeshes, 0)} | ${fmtNum(c.m2aStreamingMeshesTotal, 0)} / ${fmtNum(c.m2aStreamingMeshesFrustum, 0)} | ${c.meshReductionStreamingVsAllTilesPct !== null ? `${c.meshReductionStreamingVsAllTilesPct >= 0 ? '-' : '+'}${Math.abs(c.meshReductionStreamingVsAllTilesPct).toFixed(1)}%` : 'n/a'} | ${fmtNum(c.m1aSingleDrawCalls, 0)} | ${fmtNum(c.m1aTiledDrawCalls, 0)} | ${fmtNum(c.m2aStreamingDrawCalls, 0)} | ${c.drawCallReductionStreamingVsAllTilesPct !== null ? `${c.drawCallReductionStreamingVsAllTilesPct >= 0 ? '-' : '+'}${Math.abs(c.drawCallReductionStreamingVsAllTilesPct).toFixed(1)}%` : 'n/a'} | ${fmtNum(c.m2aStreamingTriangles, 0)} | ${fmtNum(c.m1aSingleFrameMedianMs, 2)} / ${fmtNum(c.m1aTiledFrameMedianMs, 2)} / ${fmtNum(c.m2aStreamingFrameMedianMs, 2)} | ${fmtNum(c.m1aSingleCpuRenderMs, 2)} / ${fmtNum(c.m1aTiledCpuRenderMs, 2)} / ${fmtNum(c.m2aStreamingCpuRenderMs, 2)} |`
    );
  }
  lines.push('');

  const m2 = report.modes.find((m) => m.modeId === 'm2a_streaming');
  if (m2) {
    lines.push('## 3. M2-A Runtime Streaming Details (Active Pan, Steady State & Eviction Hops)');
    lines.push('');
    for (const sc of m2.scenarios) {
      const p = sc.primaryMetrics;
      const d = p.streamingDiagnostics;
      lines.push(`### Scenario \`${sc.scenarioId}\` (${sc.cameraPoseSummary})`);
      lines.push(
        `- **Frame interval**: med \`${p.frameIntervalMs.median.toFixed(2)} ms\`, p95 \`${p.frameIntervalMs.p95.toFixed(2)} ms\`, p99 \`${p.frameIntervalMs.p99.toFixed(2)} ms\` (spikes >33.3ms: \`${p.spikesOver33msCount}\`, >50ms: \`${p.spikesOver50msCount}\`)`
      );
      lines.push(
        `- **CPU \`gl.render()\`**: med \`${p.cpuRenderTimeMs.median.toFixed(2)} ms\`, p95 \`${p.cpuRenderTimeMs.p95.toFixed(2)} ms\` | **GPU Timer**: \`${p.gpuFrameRenderTimeMs.status}\`${p.gpuFrameRenderTimeMs.statistics ? ` (med \`${p.gpuFrameRenderTimeMs.statistics.median.toFixed(2)} ms\`)` : ''}`
      );
      lines.push(
        `- **WebGL Driver & Buffers**: geometries \`${p.driverResourcesEnd.driverGeometries}\`, textures \`${p.driverResourcesEnd.driverTextures}\`, CPU buffers \`${fmtNum(p.cpuBufferMB, 3)} MB\`, BVHs \`${fmtNum(p.bvhMemoryMB, 3)} MB\`, JS Heap \`${p.browserMemoryMB.supported ? `${fmtNum(p.browserMemoryMB.usedJSHeapSizeMB, 1)} MB` : 'unsupported'}\``
      );
      if (d) {
        lines.push(
          `- **Streaming State**: visible \`${d.visibleTiles}\`, loaded \`${d.loadedTiles}\` (peak \`${d.peakLoadedTiles}\`), loading \`${d.loadingTiles}\` (peak \`${d.peakLoadingTiles}\`), evicted \`${d.evictedTilesTotal}\`, cancelled \`${d.cancelledRequestsTotal}\`, deduplicated \`${d.duplicateRequestsSkippedTotal}\``
        );
        lines.push(
          `- **Streaming Stage Timings**: fetch=${fmtTimingStats(d.fetchMsStats)} | decode=${fmtTimingStats(d.decodeMsStats)} | reconstruct=${fmtTimingStats(d.reconstructMsStats)} | commit=${fmtTimingStats(d.commitMsStats)}`
        );
      }
      if (sc.settledSteadyStateMetrics) {
        const st = sc.settledSteadyStateMetrics;
        lines.push(
          `- **Phase B (Settled Post-Pan Steady State)**: frame med \`${st.frameIntervalMs.median.toFixed(2)} ms\` / p95 \`${st.frameIntervalMs.p95.toFixed(2)} ms\`, CPU render med \`${st.cpuRenderTimeMs.median.toFixed(2)} ms\`, draw calls med \`${st.webglDrawCallsPerFrame.median.toFixed(0)}\`, tris med \`${Math.round(st.renderedTrianglesPerFrame.median).toLocaleString('en-US')}\`, loaded tiles \`${st.streamingDiagnostics?.loadedTiles ?? 'n/a'}\``
        );
      }
      if (sc.evictionLifecycle) {
        const ev = sc.evictionLifecycle;
        lines.push(
          `- **Repeated Eviction Lifecycle (${ev.hopsExecuted} hops / ${ev.cyclesExecuted} cycles)**: clean stabilization verified = \`${ev.cleanResourceStabilizationVerified}\`, post-unload WebGL geometries = \`${ev.postUnloadDriverGeometries ?? 'n/a'}\`, textures = \`${ev.postUnloadDriverTextures ?? 'n/a'}\``
        );
        if (ev.nwCycle0VsFinalDelta) {
          lines.push(
            `  - NW cycle 0 -> final delta: tiles=${ev.nwCycle0VsFinalDelta.loadedTilesDelta}, cpuBytes=${ev.nwCycle0VsFinalDelta.tileCpuGeometryBytesDelta}, bvhBytes=${ev.nwCycle0VsFinalDelta.tileBvhBytesDelta}, driverGeos=${ev.nwCycle0VsFinalDelta.driverGeometriesDelta}`
          );
        }
        if (ev.seCycle0VsFinalDelta) {
          lines.push(
            `  - SE cycle 0 -> final delta: tiles=${ev.seCycle0VsFinalDelta.loadedTilesDelta}, cpuBytes=${ev.seCycle0VsFinalDelta.tileCpuGeometryBytesDelta}, bvhBytes=${ev.seCycle0VsFinalDelta.tileBvhBytesDelta}, driverGeos=${ev.seCycle0VsFinalDelta.driverGeometriesDelta}`
          );
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
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
    for (const d of fs.readdirSync(root)) {
      if (d.startsWith('chromium_headless_shell-')) {
        const c = path.join(root, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
        if (fs.existsSync(c)) return c;
      }
      if (d.startsWith('chromium-')) {
        const c = path.join(root, d, 'chrome-linux', 'chrome');
        if (fs.existsSync(c)) return c;
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

async function findAvailablePort(preferredPort: number = 3147): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => {
      const fb = net.createServer();
      fb.unref();
      fb.on('error', reject);
      fb.listen(0, '0.0.0.0', () => {
        const addr = fb.address();
        const port = typeof addr === 'object' && addr ? addr.port : preferredPort;
        fb.close(() => resolve(port));
      });
    });
    srv.listen(preferredPort, '0.0.0.0', () => {
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

async function ensureLocalServer(explicitUrl?: string): Promise<{
  baseUrl: string;
  stopServer: () => Promise<void>;
}> {
  if (explicitUrl) {
    const ready = await checkUrlReady(explicitUrl, 3000);
    if (!ready) {
      throw new Error(`Explicit server URL is not reachable: ${explicitUrl}`);
    }
    return { baseUrl: explicitUrl.replace(/\/$/, ''), stopServer: async () => {} };
  }

  const port = await findAvailablePort(3147);
  const baseUrl = `http://127.0.0.1:${port}`;
  const spawnSpec = buildLocalServerSpawnSpec(port);
  spawnSpec.env.DISABLE_OVERIJSSEL_BOOTSTRAP =
    process.env.DISABLE_OVERIJSSEL_BOOTSTRAP ?? '1';

  const stderrChunks: string[] = [];
  const child: ChildProcess = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: spawnSpec.cwd,
    env: spawnSpec.env,
    shell: spawnSpec.shell,
    detached: process.platform !== 'win32',
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
        `Local server exited prematurely with code ${child.exitCode}: ${stderrChunks.join('')}`
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
    throw new Error(`Timed out waiting for local server on ${baseUrl}`);
  }

  return {
    baseUrl,
    stopServer: () => terminateChildProcessTree(child),
  };
}

interface RawBrowserPhasePayload {
  phaseId: string;
  warmupFrames: number;
  measuredFrames: number;
  anchorTimestampMs: number | null;
  samples: BenchmarkFrameTelemetry[];
  meshCounts: SceneMeshCountsSnapshot | null;
  cpuBufferMB: number | null;
  bvhMemoryMB: number | null;
  streamingDiagnostics: TileStreamDiagnosticsSnapshot | null;
  browserMemoryMB: {
    supported: boolean;
    usedJSHeapSizeMB: number | null;
    totalJSHeapSizeMB: number | null;
    jsHeapSizeLimitMB: number | null;
  };
  extraPanSettleMs?: number | null;
}

function summarizePhasePayload(raw: RawBrowserPhasePayload): TileStreamingPhaseMetrics {
  const frameIntervals =
    raw.anchorTimestampMs !== null && raw.samples.length > 0
      ? computeConsecutiveFrameIntervalsMs([
          raw.anchorTimestampMs,
          ...raw.samples.map((s) => s.frameTimestampMs),
        ])
      : raw.samples.map((s) => s.frameIntervalMs);

  const frameIntervalStats = computeSampleStatistics(frameIntervals);
  const cpuRenderStats = computeSampleStatistics(raw.samples.map((s) => s.cpuRenderTimeMs));
  const drawCallStats = computeSampleStatistics(raw.samples.map((s) => s.renderCalls));
  const triangleStats = computeSampleStatistics(raw.samples.map((s) => s.renderTriangles));

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

  let gpuStatus: TileStreamingPhaseMetrics['gpuFrameRenderTimeMs']['status'];
  let gpuStatistics: SampleStatistics | null = null;
  if (raw.samples.length === 0 || unsupportedCount === raw.samples.length) {
    gpuStatus = 'unsupported';
  } else if (validGpuSamples.length > 0) {
    gpuStatus = 'supported';
    gpuStatistics = computeSampleStatistics(validGpuSamples);
  } else if (disjointCount > 0) {
    gpuStatus = 'disjoint';
  } else {
    gpuStatus = 'unavailable';
  }

  const lastSample = raw.samples[raw.samples.length - 1];

  return {
    phaseId: raw.phaseId,
    warmupFrames: raw.warmupFrames,
    measuredFrames: raw.samples.length,
    frameIntervalMs: frameIntervalStats,
    effectiveMedianFps:
      frameIntervalStats.median > 0
        ? Number((1000 / frameIntervalStats.median).toFixed(2))
        : 0,
    spikesOver33msCount: frameIntervals.filter((ms) => ms > 33.33).length,
    spikesOver50msCount: frameIntervals.filter((ms) => ms > 50.0).length,
    cpuRenderTimeMs: cpuRenderStats,
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
    meshCounts: raw.meshCounts,
    driverResourcesEnd: {
      driverGeometries: lastSample?.driverGeometries ?? 0,
      driverTextures: lastSample?.driverTextures ?? 0,
      driverPrograms: lastSample?.driverPrograms ?? 0,
    },
    browserMemoryMB: raw.browserMemoryMB,
    cpuBufferMB: raw.cpuBufferMB,
    bvhMemoryMB: raw.bvhMemoryMB,
    streamingDiagnostics: raw.streamingDiagnostics,
    extraPanSettleMs: raw.extraPanSettleMs ?? null,
  };
}

/**
 * Runs the 3-mode Playwright WebGL streaming comparison (`m1a_single_scene`,
 * `m1a_tiled_64`, `m2a_streaming`) across closeup, medium navigation, far overview,
 * continuous pan (active streaming vs settled steady state), and >=10 distant pan/eviction hops.
 */
export async function runTileStreamingBenchmark(
  options: Partial<TileStreamingCliOptions> = {}
): Promise<TileStreamingBenchmarkReport> {
  const opts: TileStreamingCliOptions = {
    dataset: options.dataset ?? 'canonical-hengelo',
    modes: options.modes ?? [...ALL_TILE_BENCHMARK_MODES],
    scenarios: options.scenarios ?? [...ALL_TILE_BENCHMARK_SCENARIOS],
    warmupFrames: options.warmupFrames ?? 6,
    measuredFrames: options.measuredFrames ?? 24,
    evictionHops: options.evictionHops ?? 12,
    quick: options.quick ?? false,
    useSwiftShader: options.useSwiftShader ?? false,
    gpuBackend: options.gpuBackend ?? 'auto',
    requireHardwareGpu: options.requireHardwareGpu ?? false,
    headless: options.headless ?? true,
    serverUrl: options.serverUrl,
    outputPath: options.outputPath,
    markdownOutputPath: options.markdownOutputPath,
    quiet: options.quiet ?? false,
    viewportWidth: options.viewportWidth ?? 1440,
    viewportHeight: options.viewportHeight ?? 900,
    devicePixelRatio: options.devicePixelRatio ?? 1,
    themeId: options.themeId ?? 'tactical',
  };

  if (opts.useSwiftShader && opts.requireHardwareGpu) {
    throw new Error('Cannot combine useSwiftShader=true with requireHardwareGpu=true.');
  }

  // Fail fast with actionable PowerShell guidance when canonical Hengelo SQLite inputs are missing
  if (opts.dataset === 'canonical-hengelo' && !opts.serverUrl) {
    const osmIndexPath = path.resolve('data/osm/overijssel-261114-8ae28196.sqlite');
    const tilePackPath = path.resolve('data/osm/overijssel-tiles-261114-8ae28196.sqlite');
    const missing: string[] = [];
    if (!fs.existsSync(osmIndexPath)) missing.push(osmIndexPath);
    if (!fs.existsSync(tilePackPath)) missing.push(tilePackPath);
    if (missing.length > 0) {
      throw new Error(
        `Canonical Hengelo dataset requires local Overijssel SQLite + baked tile pack:\n` +
          missing.map((p) => `  - Missing: ${p}`).join('\n') +
          `\nRun on Windows:\n` +
          `  npm run osm:setup-overijssel\n` +
          `  npm run osm:bake-hengelo-tiles\n` +
          `Or run "--dataset=synthetic-smoke-4x4" to execute the synthetic 4x4 WebGL smoke suite.`
      );
    }
  }

  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/ms-playwright')) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright';
  }

  const isCanonical = opts.dataset === 'canonical-hengelo';
  const gridCols = isCanonical ? 8 : 4;
  const gridRows = isCanonical ? 8 : 4;

  // Prepare temporary synthetic 4x4 GeoJSON + SQLite tile pack when requested
  let syntheticTmpDir: string | null = null;
  let syntheticStore: TilePackSqliteStore | null = null;
  let syntheticGeoJsonString: string | null = null;

  if (!isCanonical) {
    syntheticTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-m2b-bench-4x4-'));
    const packPath = path.join(syntheticTmpDir, 'synthetic-4x4-tiles.sqlite');
    const { grid, geoJson } = buildSynthetic4x4GeoJson();
    syntheticGeoJsonString = JSON.stringify(geoJson);
    const ingested = ingestCanonicalStudyGeoJson(geoJson, grid);
    try {
      bakeStudyRegionTilesToSqlite({
        ingested,
        outPath: packPath,
        snapshotId: 'synthetic-m2b-4x4',
        sourceSha256: 'c'.repeat(64),
        batchDimension: 2,
        includeBvh: true,
        theme: MAP_THEMES[opts.themeId] ?? MAP_THEMES.tactical,
      });
    } finally {
      disposeIngestedStudyRegionPlans(ingested);
    }
    syntheticStore = new TilePackSqliteStore(packPath, {
      expectedSnapshotId: 'synthetic-m2b-4x4',
      expectedSourceSha256: 'c'.repeat(64),
      allowCustomSnapshot: true,
    });
  }

  const launchFlags = resolveChromiumLaunchArgs({
    useSwiftShader: opts.useSwiftShader,
    gpuBackend: opts.gpuBackend,
  });

  const { baseUrl, stopServer } = await ensureLocalServer(opts.serverUrl);
  const playwright = await loadPlaywrightModule();
  let browser: any = null;

  try {
    const defaultExecutablePath =
      typeof playwright.chromium.executablePath === 'function'
        ? playwright.chromium.executablePath()
        : undefined;
    const launchOptions: Record<string, any> = {
      headless: opts.headless,
      args: launchFlags,
    };
    if (!defaultExecutablePath || !fs.existsSync(defaultExecutablePath)) {
      const containerFallback = opts.headless
        ? findPreinstalledContainerChromiumExecutable()
        : undefined;
      if (containerFallback) {
        launchOptions.executablePath = containerFallback;
      } else {
        throw new Error(
          `Playwright Chromium executable not found at "${defaultExecutablePath || 'unknown'}". Run "npx playwright install chromium" first.`
        );
      }
    }

    browser = await playwright.chromium.launch(launchOptions);
    const context = await browser.newContext({
      viewport: { width: opts.viewportWidth, height: opts.viewportHeight },
      deviceScaleFactor: opts.devicePixelRatio,
    });

    // Block external OSM/Overpass requests; serve synthetic 4x4 routes when active
    await context.route('**/*', async (route: any) => {
      const reqUrl: string = route.request().url();
      if (!isCanonical && syntheticStore && syntheticGeoJsonString) {
        if (reqUrl.includes('/__m2b_synthetic__/osm-data')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: syntheticGeoJsonString,
          });
          return;
        }
        if (reqUrl.includes('/__m2b_synthetic__/tiles/manifest')) {
          const metadata = syntheticStore.getMetadata();
          const tiles = syntheticStore.listManifestEntries(0);
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              available: true,
              packPath: 'synthetic-4x4',
              dbSizeBytes: syntheticStore.getFileSizeBytes(),
              metadata,
              tiles,
            }),
          });
          return;
        }
        const tileMatch = reqUrl.match(/\/__m2b_synthetic__\/tiles\/(\d+)\/(-?\d+)\/(-?\d+)$/);
        if (tileMatch) {
          const lod = Number.parseInt(tileMatch[1], 10);
          const tx = Number.parseInt(tileMatch[2], 10);
          const ty = Number.parseInt(tileMatch[3], 10);
          const rec = syntheticStore.getTileCompressed(lod, tx, ty);
          if (!rec) {
            await route.fulfill({ status: 404, body: 'Tile not found' });
            return;
          }
          const rawPayload = inflateTilePayload(
            rec.compressedPayload,
            formatTileId(rec.manifest.tx, rec.manifest.ty)
          );
          await route.fulfill({
            status: 200,
            contentType: 'application/octet-stream',
            body: Buffer.from(
              rawPayload.buffer,
              rawPayload.byteOffset,
              rawPayload.byteLength
            ),
          });
          return;
        }
      }

      if (
        reqUrl.startsWith(baseUrl) ||
        reqUrl.startsWith('http://127.0.0.1') ||
        reqUrl.startsWith('http://localhost') ||
        reqUrl.startsWith('data:') ||
        reqUrl.startsWith('blob:')
      ) {
        await route.continue();
      } else {
        await route.abort();
      }
    });

    const page = await context.newPage();
    await page.addInitScript('window.__name = (fn) => fn;');
    page.on('pageerror', (err: Error) => {
      console.error(`[bench:tiles] Page error: ${err?.message || String(err)}`);
    });

    const benchmarkUrl = `${baseUrl}/?benchmark=1&dock=collapsed`;
    await page.goto(benchmarkUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(
      () => Boolean((window as any).__BENCHMARK_HARNESS__ && document.querySelector('canvas')),
      { timeout: 25000 }
    );

    const browserEnvInfo = await page.evaluate(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const canvas = document.querySelector('canvas');
      const gl2 = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
      const gl1 = !gl2 ? (canvas?.getContext('webgl') as WebGLRenderingContext | null) : null;
      const gl = gl2 || gl1;
      const dbg = gl ? gl.getExtension('WEBGL_debug_renderer_info') : null;
      return {
        userAgent: navigator.userAgent,
        gpuVendor: gl ? String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR)) : 'Unknown',
        gpuRenderer: gl ? String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : 'Unknown',
        webglVersion: gl2 ? 'WebGL2' : gl1 ? 'WebGL1' : 'unavailable',
      };
    });

    if (browserEnvInfo.webglVersion === 'unavailable') {
      throw new Error('Tile streaming benchmark failed: WebGL context unavailable in Chromium.');
    }
    const isSoftware = isSoftwareWebGLRenderer(browserEnvInfo.gpuRenderer);
    if (opts.requireHardwareGpu && isSoftware) {
      throw new Error(
        `--require-hardware was specified, but Chromium initialized a software renderer: "${browserEnvInfo.gpuRenderer}".`
      );
    }

    const effectiveSwiftShader = opts.useSwiftShader || opts.gpuBackend === 'swiftshader';
    const environment = collectHostEnvironmentMetadata({
      browserName: 'Chromium',
      browserVersion: browser.version(),
      userAgent: browserEnvInfo.userAgent,
      viewportWidth: opts.viewportWidth,
      viewportHeight: opts.viewportHeight,
      devicePixelRatio: opts.devicePixelRatio,
      webglVersion: browserEnvInfo.webglVersion,
      gpuVendor: browserEnvInfo.gpuVendor,
      gpuRenderer: browserEnvInfo.gpuRenderer,
      isSoftwareRenderer: isSoftware,
      useSwiftShader: effectiveSwiftShader,
      gpuBackendRequested: effectiveSwiftShader ? 'swiftshader' : opts.gpuBackend,
      hardwareAccelerationRequested: !effectiveSwiftShader,
      launchFlags,
    });

    const osmDataUrl = isCanonical
      ? '/api/osm-data?preset=hengelo-m1a'
      : '/__m2b_synthetic__/osm-data';
    const tilesApiBaseUrl = isCanonical
      ? '/api/tiles'
      : '/__m2b_synthetic__/tiles';

    // Shared trajectory parameters scaled strictly only in pan/hop extents when running 4x4 smoke
    const panHalfExtentX = isCanonical ? 1200 : 650;
    const panHalfExtentZ = isCanonical ? 900 : 500;
    const panZoom = isCanonical ? 2.2 : 2.5;
    const hopOffset = isCanonical ? 1300 : 760;
    const hopZoom = isCanonical ? 2.8 : 3.2;

    const modeResults: TileBenchmarkModeResult[] = [];
    let m1aLoaded = false;

    const runModeScenarioSet = async (
      modeId: TileBenchmarkModeId,
      modeLabel: string,
      initialization: TileBenchmarkModeResult['initialization']
    ): Promise<TileBenchmarkModeResult> => {
      if (!opts.quiet) {
        console.log(`[bench:tiles] Running mode="${modeId}" (${opts.scenarios.length} scenarios)...`);
      }

      const scenarioResults: TileBenchmarkScenarioResult[] = [];

      for (const scenarioId of opts.scenarios) {
        const isStreaming = modeId === 'm2a_streaming';
        const poseSummary =
          scenarioId === 'closeup_station'
            ? 'target=[0,0,0], zoom=6.5 (>4.5 px/m 3D sleepers), az=45deg'
            : scenarioId === 'medium_navigation'
            ? 'target=[0,0,0], zoom=1.8, az=45deg'
            : scenarioId === 'far_overview'
            ? 'target=[0,0,0], zoom=0.22 (minZoom=0.15 preserved), az=45deg'
            : scenarioId === 'continuous_pan'
            ? `pan (-${panHalfExtentX},-${panHalfExtentZ}) -> (+${panHalfExtentX},+${panHalfExtentZ}), zoom=${panZoom}, az=45deg`
            : `${opts.evictionHops} hops NW[-${hopOffset},-${hopOffset}] <-> SE[+${hopOffset},+${hopOffset}], zoom=${hopZoom}, az=45deg`;

        const evalRes = await page.evaluate(
          async (args: {
            modeId: TileBenchmarkModeId;
            isStreaming: boolean;
            scenarioId: TileBenchmarkScenarioId;
            warmupFrames: number;
            measuredFrames: number;
            evictionHops: number;
            panHalfExtentX: number;
            panHalfExtentZ: number;
            panZoom: number;
            hopOffset: number;
            hopZoom: number;
          }) => {
            const harness = (window as any).__BENCHMARK_HARNESS__;
            let pendingResolve: ((tel: BenchmarkFrameTelemetry) => void) | null = null;
            const waitNextFrame = (): Promise<BenchmarkFrameTelemetry> =>
              new Promise((resolve) => {
                pendingResolve = resolve;
              });

            const readPerfMemory = () => {
              const pm = (performance as any).memory;
              return pm
                ? {
                    supported: true,
                    usedJSHeapSizeMB: Number((pm.usedJSHeapSize / (1024 * 1024)).toFixed(3)),
                    totalJSHeapSizeMB: Number((pm.totalJSHeapSize / (1024 * 1024)).toFixed(3)),
                    jsHeapSizeLimitMB: Number((pm.jsHeapSizeLimit / (1024 * 1024)).toFixed(3)),
                  }
                : {
                    supported: false,
                    usedJSHeapSizeMB: null,
                    totalJSHeapSizeMB: null,
                    jsHeapSizeLimitMB: null,
                  };
            };

            const attachCollectors = () => {
              (window as any).__BENCHMARK_RESET_GPU_TIMERS__?.();
              (window as any).__BENCHMARK_ACTIVE__ = true;
              (window as any).__BENCHMARK_COLLECTOR_META__ = {
                phase: 'warmup',
                frameIndex: 0,
                totalMeasuredFrames: args.measuredFrames,
                samplingStride: 4,
              };
              (window as any).__BENCHMARK_FRAME_COLLECTOR__ = (tel: BenchmarkFrameTelemetry) => {
                if (pendingResolve) {
                  const r = pendingResolve;
                  pendingResolve = null;
                  r(tel);
                }
              };
            };

            const detachCollectors = () => {
              pendingResolve = null;
              (window as any).__BENCHMARK_FRAME_COLLECTOR__ = null;
              (window as any).__BENCHMARK_COLLECTOR_META__ = undefined;
              (window as any).__BENCHMARK_ACTIVE__ = false;
            };

            const captureStaticPhase = async (
              phaseId: string,
              poseTarget: [number, number, number],
              poseZoom: number
            ) => {
              harness.setCameraPose(poseTarget, poseZoom, 45);
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
              if (args.isStreaming) {
                await harness.waitForM2aIdle();
                harness.resetM2aPerfCounters();
              }

              attachCollectors();
              const samples: BenchmarkFrameTelemetry[] = [];
              let anchorTimestampMs: number | null = null;
              try {
                for (let w = 0; w < args.warmupFrames; w++) {
                  (window as any).__BENCHMARK_COLLECTOR_META__ = {
                    phase: 'warmup',
                    frameIndex: w,
                    totalMeasuredFrames: args.measuredFrames,
                    samplingStride: 4,
                  };
                  const wt = await waitNextFrame();
                  anchorTimestampMs = wt.frameTimestampMs;
                }
                for (let m = 0; m < args.measuredFrames; m++) {
                  (window as any).__BENCHMARK_COLLECTOR_META__ = {
                    phase: 'measured',
                    frameIndex: m,
                    totalMeasuredFrames: args.measuredFrames,
                    samplingStride: 4,
                  };
                  samples.push(await waitNextFrame());
                }
              } finally {
                detachCollectors();
              }

              const snap = harness.getSnapshot();
              const meshCounts = harness.getSceneMeshCounts();
              return {
                phaseId,
                warmupFrames: args.warmupFrames,
                measuredFrames: samples.length,
                anchorTimestampMs,
                samples,
                meshCounts,
                cpuBufferMB:
                  typeof snap?.cpuBufferMB === 'number' ? snap.cpuBufferMB : null,
                bvhMemoryMB:
                  typeof snap?.bvhMemoryStats?.totalMB === 'number'
                    ? snap.bvhMemoryStats.totalMB
                    : null,
                streamingDiagnostics: args.isStreaming
                  ? harness.getTileStreamDiagnostics()
                  : null,
                browserMemoryMB: readPerfMemory(),
              };
            };

            if (args.scenarioId === 'closeup_station') {
              return {
                primary: await captureStaticPhase('steady_state', [0, 0, 0], 6.5),
                settled: null,
                eviction: null,
              };
            }
            if (args.scenarioId === 'medium_navigation') {
              return {
                primary: await captureStaticPhase('steady_state', [0, 0, 0], 1.8),
                settled: null,
                eviction: null,
              };
            }
            if (args.scenarioId === 'far_overview') {
              return {
                primary: await captureStaticPhase('steady_state', [0, 0, 0], 0.22),
                settled: null,
                eviction: null,
              };
            }

            if (args.scenarioId === 'continuous_pan') {
              // Anchor at start of sweep & settle so active pan starts from realistic loaded state
              harness.setCameraPose(
                [-args.panHalfExtentX, 0, -args.panHalfExtentZ],
                args.panZoom,
                45
              );
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
              if (args.isStreaming) {
                await harness.waitForM2aIdle();
                harness.resetM2aPerfCounters();
              }

              // Phase A: Active pan sweep across the tile grid
              attachCollectors();
              const panSamples: BenchmarkFrameTelemetry[] = [];
              let panAnchorTs: number | null = null;
              let extraPanSettleMs: number | null = null;
              try {
                // Anchor frame before starting sweep
                const anchorTel = await waitNextFrame();
                panAnchorTs = anchorTel.frameTimestampMs;

                const steps = args.measuredFrames;
                for (let m = 0; m < steps; m++) {
                  const u = steps <= 1 ? 1 : m / (steps - 1);
                  const tx = -args.panHalfExtentX + 2 * args.panHalfExtentX * u;
                  const tz = -args.panHalfExtentZ + 2 * args.panHalfExtentZ * u;
                  harness.setCameraPose([tx, 0, tz], args.panZoom, 45);
                  (window as any).__BENCHMARK_COLLECTOR_META__ = {
                    phase: 'measured',
                    frameIndex: m,
                    totalMeasuredFrames: steps,
                    samplingStride: 4,
                  };
                  panSamples.push(await waitNextFrame());
                }

                if (args.isStreaming) {
                  const tExtra0 = performance.now();
                  // Pump frames until TileStreamManager drains remaining commits/fetches
                  while ((harness.getTileStreamDiagnostics()?.loadingTiles ?? 0) > 0) {
                    (window as any).__BENCHMARK_COLLECTOR_META__ = {
                      phase: 'measured',
                      frameIndex: panSamples.length,
                      totalMeasuredFrames: args.measuredFrames + 60,
                      samplingStride: 4,
                    };
                    panSamples.push(await waitNextFrame());
                    if (performance.now() - tExtra0 > 20000) break;
                  }
                  extraPanSettleMs = Number((performance.now() - tExtra0).toFixed(2));
                }
              } finally {
                detachCollectors();
              }

              const activeSnap = harness.getSnapshot();
              const activePhase = {
                phaseId: 'active_pan_streaming',
                warmupFrames: 1,
                measuredFrames: panSamples.length,
                anchorTimestampMs: panAnchorTs,
                samples: panSamples,
                meshCounts: harness.getSceneMeshCounts(),
                cpuBufferMB:
                  typeof activeSnap?.cpuBufferMB === 'number' ? activeSnap.cpuBufferMB : null,
                bvhMemoryMB:
                  typeof activeSnap?.bvhMemoryStats?.totalMB === 'number'
                    ? activeSnap.bvhMemoryStats.totalMB
                    : null,
                streamingDiagnostics: args.isStreaming
                  ? harness.getTileStreamDiagnostics()
                  : null,
                browserMemoryMB: readPerfMemory(),
                extraPanSettleMs,
              };

              // Phase B: Settled post-pan steady state at end-of-pan pose
              const settledPhase = await captureStaticPhase(
                'settled_post_pan_steady_state',
                [args.panHalfExtentX, 0, args.panHalfExtentZ],
                args.panZoom
              );

              return {
                primary: activePhase,
                settled: settledPhase,
                eviction: null,
              };
            }

            // repeated_pan_eviction: >= 10 alternating opposing-quadrant distant hops
            const hops: any[] = [];
            const allHopSamples: BenchmarkFrameTelemetry[] = [];
            let firstAnchorTs: number | null = null;
            if (args.isStreaming) {
              harness.resetM2aPerfCounters();
            }

            for (let h = 0; h < args.evictionHops; h++) {
              const isNw = h % 2 === 0;
              const target: [number, number, number] = isNw
                ? [-args.hopOffset, 0, -args.hopOffset]
                : [args.hopOffset, 0, args.hopOffset];

              const tHop0 = performance.now();
              harness.setCameraPose(target, args.hopZoom, 45);
              attachCollectors();
              const hopSamples: BenchmarkFrameTelemetry[] = [];
              let hopAnchor: number | null = null;
              try {
                const aTel = await waitNextFrame();
                hopAnchor = aTel.frameTimestampMs;
                if (firstAnchorTs === null) firstAnchorTs = aTel.frameTimestampMs;

                const minHopFrames = Math.max(4, Math.min(8, args.measuredFrames));
                let frameIdx = 0;
                while (
                  frameIdx < minHopFrames ||
                  (args.isStreaming &&
                    (harness.getTileStreamDiagnostics()?.loadingTiles ?? 0) > 0 &&
                    frameIdx < 120)
                ) {
                  (window as any).__BENCHMARK_COLLECTOR_META__ = {
                    phase: 'measured',
                    frameIndex: frameIdx,
                    totalMeasuredFrames: minHopFrames,
                    samplingStride: 4,
                  };
                  const tel = await waitNextFrame();
                  hopSamples.push(tel);
                  allHopSamples.push(tel);
                  frameIdx++;
                }
              } finally {
                detachCollectors();
              }
              const settleDurationMs = Number((performance.now() - tHop0).toFixed(2));
              const hopTimestamps = [
                hopAnchor!,
                ...hopSamples.map((s) => s.frameTimestampMs),
              ];
              const hopIntervals: number[] = [];
              for (let ti = 1; ti < hopTimestamps.length; ti++) {
                hopIntervals.push(Number(Math.max(0, hopTimestamps[ti] - hopTimestamps[ti - 1]).toFixed(3)));
              }
              const diag = args.isStreaming ? harness.getTileStreamDiagnostics() : null;
              const snap = harness.getSnapshot();
              const mem = readPerfMemory();

              hops.push({
                hopIndex: h,
                quadrant: isNw ? 'NW' : 'SE',
                target,
                zoom: args.hopZoom,
                settleDurationMs,
                framesMeasured: hopSamples.length,
                maxFrameIntervalMs:
                  hopIntervals.length > 0 ? Number(Math.max(...hopIntervals).toFixed(2)) : 0,
                spikesOver33msCount: hopIntervals.filter((ms) => ms > 33.33).length,
                spikesOver50msCount: hopIntervals.filter((ms) => ms > 50.0).length,
                loadedTiles: diag?.loadedTiles ?? null,
                visibleTiles: diag?.visibleTiles ?? null,
                evictedTilesTotal: diag?.evictedTilesTotal ?? null,
                completedLoadsTotal: diag?.completedLoadsTotal ?? null,
                tileCpuGeometryBytes: diag?.tileCpuGeometryBytes ?? null,
                tileBvhBytes: diag?.tileBvhBytes ?? null,
                driverGeometries: snap?.liveWebGL?.driverGeometries ?? 0,
                driverTextures: snap?.liveWebGL?.driverTextures ?? 0,
                usedJSHeapSizeMB: mem.usedJSHeapSizeMB,
              });
            }

            const endSnap = harness.getSnapshot();
            const endPhase = {
              phaseId: 'repeated_eviction_aggregate',
              warmupFrames: 0,
              measuredFrames: allHopSamples.length,
              anchorTimestampMs: null as number | null,
              samples: allHopSamples,
              meshCounts: harness.getSceneMeshCounts(),
              cpuBufferMB:
                typeof endSnap?.cpuBufferMB === 'number' ? endSnap.cpuBufferMB : null,
              bvhMemoryMB:
                typeof endSnap?.bvhMemoryStats?.totalMB === 'number'
                  ? endSnap.bvhMemoryStats.totalMB
                  : null,
              streamingDiagnostics: args.isStreaming
                ? harness.getTileStreamDiagnostics()
                : null,
              browserMemoryMB: readPerfMemory(),
            };

            const nwHops = hops.filter((r) => r.quadrant === 'NW');
            const seHops = hops.filter((r) => r.quadrant === 'SE');
            const diffPair = (a: any, b: any) =>
              a && b
                ? {
                    loadedTilesDelta:
                      a.loadedTiles !== null && b.loadedTiles !== null
                        ? b.loadedTiles - a.loadedTiles
                        : null,
                    tileCpuGeometryBytesDelta:
                      a.tileCpuGeometryBytes !== null && b.tileCpuGeometryBytes !== null
                        ? b.tileCpuGeometryBytes - a.tileCpuGeometryBytes
                        : null,
                    tileBvhBytesDelta:
                      a.tileBvhBytes !== null && b.tileBvhBytes !== null
                        ? b.tileBvhBytes - a.tileBvhBytes
                        : null,
                    driverGeometriesDelta: b.driverGeometries - a.driverGeometries,
                    driverTexturesDelta: b.driverTextures - a.driverTextures,
                    usedJSHeapDeltaMB:
                      a.usedJSHeapSizeMB !== null && b.usedJSHeapSizeMB !== null
                        ? Number((b.usedJSHeapSizeMB - a.usedJSHeapSizeMB).toFixed(3))
                        : null,
                  }
                : null;

            const nwDelta = nwHops.length >= 2 ? diffPair(nwHops[0], nwHops[nwHops.length - 1]) : null;
            const seDelta = seHops.length >= 2 ? diffPair(seHops[0], seHops[seHops.length - 1]) : null;

            // Unload dataset at end of eviction scenario to audit full GPU cleanup
            await harness.unloadDataset();
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            const postUnloadSnap = harness.getSnapshot();
            const postUnloadMem = readPerfMemory();

            const cleanResourceStabilizationVerified =
              (!nwDelta ||
                ((nwDelta.tileCpuGeometryBytesDelta ?? 0) === 0 &&
                  (nwDelta.tileBvhBytesDelta ?? 0) === 0 &&
                  nwDelta.driverGeometriesDelta <= 0)) &&
              (!seDelta ||
                ((seDelta.tileCpuGeometryBytesDelta ?? 0) === 0 &&
                  (seDelta.tileBvhBytesDelta ?? 0) === 0 &&
                  seDelta.driverGeometriesDelta <= 0));

            return {
              primary: endPhase,
              settled: null,
              eviction: {
                hopsExecuted: hops.length,
                cyclesExecuted: Math.floor(hops.length / 2),
                hops,
                nwCycle0VsFinalDelta: nwDelta,
                seCycle0VsFinalDelta: seDelta,
                postUnloadDriverGeometries: postUnloadSnap?.liveWebGL?.driverGeometries ?? null,
                postUnloadDriverTextures: postUnloadSnap?.liveWebGL?.driverTextures ?? null,
                postUnloadUsedJSHeapMB: postUnloadMem.usedJSHeapSizeMB,
                cleanResourceStabilizationVerified,
              },
            };
          },
          {
            modeId,
            isStreaming,
            scenarioId,
            warmupFrames: opts.warmupFrames,
            measuredFrames: opts.measuredFrames,
            evictionHops: opts.evictionHops,
            panHalfExtentX,
            panHalfExtentZ,
            panZoom,
            hopOffset,
            hopZoom,
          }
        );

        scenarioResults.push({
          scenarioId,
          cameraPoseSummary: poseSummary,
          primaryMetrics: summarizePhasePayload(evalRes.primary),
          ...(evalRes.settled
            ? { settledSteadyStateMetrics: summarizePhasePayload(evalRes.settled) }
            : {}),
          ...(evalRes.eviction ? { evictionLifecycle: evalRes.eviction } : {}),
        });
      }

      return {
        modeId,
        modeLabel,
        tileCountInGrid: gridCols * gridRows,
        initialization,
        scenarios: scenarioResults,
      };
    };

    // Execute requested modes in deterministic order
    for (const modeId of opts.modes) {
      if (modeId === 'm1a_single_scene' || modeId === 'm1a_tiled_64') {
        const targetM1aView = modeId === 'm1a_single_scene' ? 'reference' : 'tiled';
        let initInfo: any;
        if (!m1aLoaded) {
          initInfo = await page.evaluate(
            async (p: {
              osmDataUrl: string;
              initialMode: 'reference' | 'tiled';
              gridCols: number;
              gridRows: number;
              themeId: string;
            }) => {
              const t0 = performance.now();
              const res = await (window as any).__BENCHMARK_HARNESS__.loadM1aModes({
                osmDataUrl: p.osmDataUrl,
                initialMode: p.initialMode,
                gridCols: p.gridCols,
                gridRows: p.gridRows,
                themeId: p.themeId,
                target: [0, 0, 0],
                zoom: 1.8,
                azimuthDeg: 45,
              });
              return {
                ...res,
                wallTotalMs: Number((performance.now() - t0).toFixed(2)),
              };
            },
            {
              osmDataUrl,
              initialMode: targetM1aView,
              gridCols,
              gridRows,
              themeId: opts.themeId,
            }
          );
          m1aLoaded = true;
        } else {
          const switchStart = await page.evaluate(async (m: 'reference' | 'tiled') => {
            const t0 = performance.now();
            await (window as any).__BENCHMARK_HARNESS__.switchM1aMode(m);
            return Number((performance.now() - t0).toFixed(2));
          }, targetM1aView);
          initInfo = {
            fetchElapsedMs: 0,
            ingestElapsedMs: 0,
            referenceBuildTimeMs: null,
            tiledBuildTimeMs: null,
            wallTotalMs: switchStart,
          };
        }

        const res = await runModeScenarioSet(
          modeId,
          modeId === 'm1a_single_scene'
            ? 'M1a Single-Scene Reference (A)'
            : `M1a All ${gridCols * gridRows} Tiles Mounted Together (C)`,
          {
            fetchOrManifestMs: initInfo.fetchElapsedMs ?? 0,
            ingestMs: initInfo.ingestElapsedMs ?? null,
            referenceBuildMs: initInfo.referenceBuildTimeMs ?? null,
            tiledBuildMs: initInfo.tiledBuildTimeMs ?? null,
            totalInitToFirstFrameMs: initInfo.wallTotalMs ?? initInfo.totalBuildMs ?? 0,
            sharedMaterialCount: null,
          }
        );
        modeResults.push(res);

        // If `repeated_pan_eviction` just unloaded the scene, mark m1aLoaded = false
        if (opts.scenarios.includes('repeated_pan_eviction')) {
          m1aLoaded = false;
        }
      } else if (modeId === 'm2a_streaming') {
        m1aLoaded = false;
        const m2Init = await page.evaluate(
          async (p: { apiBaseUrl: string; themeId: string }) => {
            await (window as any).__BENCHMARK_HARNESS__.unloadDataset();
            const t0 = performance.now();
            const res = await (window as any).__BENCHMARK_HARNESS__.loadM2aStreaming({
              apiBaseUrl: p.apiBaseUrl,
              preloadMarginTiles: 1,
              retainMarginTiles: 2,
              maxConcurrentFetches: 6,
              maxCommitsPerFrame: 4,
              themeId: p.themeId,
              target: [0, 0, 0],
              zoom: 1.8,
              azimuthDeg: 45,
              waitForIdle: true,
            });
            return {
              initElapsedMs: res.initElapsedMs,
              wallTotalMs: Number((performance.now() - t0).toFixed(2)),
              sharedMaterialCount: res.diagnostics?.sharedMaterialCount ?? null,
            };
          },
          { apiBaseUrl: tilesApiBaseUrl, themeId: opts.themeId }
        );

        const res = await runModeScenarioSet(
          'm2a_streaming',
          'M2-A Runtime Tile Streaming (OSMTILE1 + Worker + TileStreamManager)',
          {
            fetchOrManifestMs: m2Init.initElapsedMs,
            ingestMs: 0,
            referenceBuildMs: null,
            tiledBuildMs: null,
            totalInitToFirstFrameMs: m2Init.wallTotalMs,
            sharedMaterialCount: m2Init.sharedMaterialCount,
          }
        );
        modeResults.push(res);
      }
    }

    const comparisons = computeCrossModeComparisonSummary(modeResults, opts.scenarios);

    const report: TileStreamingBenchmarkReport = {
      schemaVersion: M2B_BENCHMARK_SCHEMA_VERSION,
      benchmarkName:
        'TKT-028 M2-B — Three-Mode Tile Streaming Performance & Memory Comparison',
      ticket: 'TKT-028',
      milestone: 'M2-B',
      dataset: {
        id: opts.dataset,
        description: isCanonical
          ? 'Canonical Hengelo 8x8 (4,096 x 4,096 m, 512 m LOD0 tiles) from overijssel-261114-8ae28196 & overijssel-tiles-261114-8ae28196.sqlite'
          : 'Synthetic 4x4 (2,048 x 2,048 m, 512 m LOD0 tiles) multi-category OSM smoke fixture',
        gridCols,
        gridRows,
        totalGridTiles: gridCols * gridRows,
        tileSizeMeters: 512,
        isCanonicalHengelo: isCanonical,
      },
      renderSettings: {
        viewportWidth: opts.viewportWidth,
        viewportHeight: opts.viewportHeight,
        devicePixelRatio: opts.devicePixelRatio,
        themeId: opts.themeId,
        roadsMode: 'graph-surface',
        railwaysMode: 'graph-R+',
        preloadMarginTiles: 1,
        retainMarginTiles: 2,
        maxConcurrentFetches: 6,
        maxCommitsPerFrame: 4,
      },
      environment,
      modes: modeResults,
      comparisons,
      notes: [
        'All three modes execute at identical 1440x900 @ 1x DPR viewport, tactical theme, and E2+/R+ production render settings.',
        'totalMeshes reports every THREE.Mesh inside the active composite scene groups; frustumVisibleMeshes counts THREE.Mesh leaves intersecting the OrthographicCamera frustum.',
        'EXT_disjoint_timer_query_webgl2 GPU pass timing is explicitly marked "unsupported", "unavailable", or "disjoint" whenever hardware timer queries cannot resolve.',
        'Browser performance.memory JS heap numbers are advisory only and recorded as supported=false / null when unavailable.',
      ],
    };

    const markdown = formatM2bMarkdownReport(report);

    if (opts.outputPath) {
      const resolvedJson = path.resolve(opts.outputPath);
      fs.mkdirSync(path.dirname(resolvedJson), { recursive: true });
      fs.writeFileSync(resolvedJson, JSON.stringify(report, null, 2) + '\n', 'utf8');
    }

    if (opts.markdownOutputPath) {
      const resolvedMd = path.resolve(opts.markdownOutputPath);
      fs.mkdirSync(path.dirname(resolvedMd), { recursive: true });
      fs.writeFileSync(resolvedMd, markdown + '\n', 'utf8');
    }

    if (!opts.quiet) {
      console.log(markdown);
      if (opts.outputPath) {
        console.log(`\nSaved M2-B JSON report to: ${path.resolve(opts.outputPath)}`);
      }
      if (opts.markdownOutputPath) {
        console.log(`Saved M2-B Markdown summary to: ${path.resolve(opts.markdownOutputPath)}`);
      }
    }

    return report;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    await stopServer();
    syntheticStore?.close();
    if (syntheticTmpDir) {
      fs.rmSync(syntheticTmpDir, { recursive: true, force: true });
    }
  }
}

const isMainModule =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  try {
    const cliOptions = parseTileStreamingCliArgs(process.argv.slice(2));
    runTileStreamingBenchmark(cliOptions).catch((err: any) => {
      console.error(`Tile streaming benchmark runner failed: ${err?.message || String(err)}`);
      process.exit(1);
    });
  } catch (err: any) {
    console.error(`Tile streaming benchmark runner failed: ${err?.message || String(err)}`);
    process.exit(1);
  }
}
