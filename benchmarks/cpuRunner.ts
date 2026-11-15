import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP_THEMES } from '../src/styles/mapThemes';
import { ProcessedMapData } from '../src/types/MapFeature';
import {
  adaptInfrastructureGraphToRenderDescriptors,
  GeometryBuilder,
  GraphRoadGenerationTiming,
  prepareInfrastructureRenderPreview,
  requiresInfrastructureGraphPreview,
  validateInfrastructureRenderDescriptors,
} from '../src/world/GeometryBuilder';
import { buildRailwayInfrastructure } from '../src/world/infrastructure/railways/RailwayGeometryBuilder';
import { buildInfrastructureGraph } from '../src/world/infrastructure/topology/InfrastructureGraph';
import { resolveAndValidatePlanarPolygons } from '../src/world/PlanarLayerValidator';
import { computeGroupGeometryStats } from '../src/world/prototype/PerformanceBaselineHarness';
import { loadBenchmarkDatasets, LoadedBenchmarkDataset } from './datasets';
import {
  collectHostEnvironmentMetadata,
  MEMORY_MEASUREMENT_NOTES,
  STANDARD_METRIC_DEFINITIONS,
} from './environment';
import { resolveRendererConfigs } from './scenarios';
import {
  formatBenchmarkReportSummary,
  saveBenchmarkReport,
} from './serializer';
import { computeSampleStatistics } from './stats';
import {
  BENCHMARK_SCHEMA_VERSION,
  BenchmarkErrorRecord,
  BenchmarkRendererConfig,
  BenchmarkReport,
  CpuWorkloadBenchmarkResult,
  UnsupportedMetricNotice,
} from './types';

export interface CpuBenchmarkRunOptions {
  datasetIds?: readonly string[];
  configIds?: readonly string[];
  warmupIterations?: number;
  measuredIterations?: number;
  benchmarkName?: string;
}

function tryTriggerGarbageCollection(): boolean {
  const gcFn = (globalThis as any).gc;
  if (typeof gcFn === 'function') {
    gcFn();
    return true;
  }
  return false;
}

function toMB(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(3));
}

function executeSingleCpuWorkload(
  dataset: LoadedBenchmarkDataset,
  rendererConfig: BenchmarkRendererConfig,
  warmupIterations: number,
  measuredIterations: number
): CpuWorkloadBenchmarkResult {
  const theme = MAP_THEMES[rendererConfig.themeId] || MAP_THEMES.tactical;
  const renderOptions = rendererConfig.infrastructureRenderOptions;
  const unsupportedMetrics: UnsupportedMetricNotice[] = [];
  const errors: BenchmarkErrorRecord[] = [];

  const isGraphRoadActive =
    renderOptions.roads === 'graph' || renderOptions.roads === 'graph-surface';

  if (!isGraphRoadActive) {
    unsupportedMetrics.push({
      metricId: `${dataset.metadata.id}::${rendererConfig.id}::roadGeometryGenerationMs`,
      reason: 'disabled_by_config',
      explanation:
        'Direct stage-isolated road geometry timing (GraphRoadGenerationTiming) is only emitted when infrastructureRenderOptions.roads is "graph" or "graph-surface"; in "legacy" mode road meshing executes inline inside GeometryBuilder.buildScene.',
    });
  }

  // 1. Warm-up executions (prevents JIT cold-start contamination and establishes warmed-up resource baseline)
  let warmedUpOwnedGeosAfterDispose = 0;
  let warmedUpOwnedMatsAfterDispose = 0;

  for (let w = 0; w < warmupIterations; w++) {
    const parsedWarm = dataset.parseInput();
    if (parsedWarm.topologySource) {
      const g = buildInfrastructureGraph(parsedWarm);
      const d = adaptInfrastructureGraphToRenderDescriptors(g, renderOptions);
      validateInfrastructureRenderDescriptors(d);
    }
    resolveAndValidatePlanarPolygons(
      parsedWarm.landuse || [],
      parsedWarm.parks || [],
      parsedWarm.waterBodies || [],
      parsedWarm.linearWaterways || []
    );
    const previewWarm = requiresInfrastructureGraphPreview(renderOptions)
      ? prepareInfrastructureRenderPreview(parsedWarm, renderOptions)
      : null;
    const builderWarm = new GeometryBuilder({
      buildingHeightMultiplier: rendererConfig.buildingHeightMultiplier,
      roadWidthMultiplier: rendererConfig.roadWidthMultiplier,
      bevelEnabled: rendererConfig.bevelEnabled,
      initialCameraZoom: 8.0,
      infrastructureRenderOptions: renderOptions,
      infrastructureRenderPreview: previewWarm,
    });
    const warmScene = builderWarm.buildScene(parsedWarm, theme);
    warmScene.dispose();
    warmedUpOwnedGeosAfterDispose = warmScene.resources.ownedGeometriesCount;
    warmedUpOwnedMatsAfterDispose = warmScene.resources.ownedMaterialsCount;
  }

  const gcInvokedBetweenRuns = tryTriggerGarbageCollection();
  const memBefore = process.memoryUsage();
  let peakHeapUsedBytes = memBefore.heapUsed;

  const parseSamples: number[] = [];
  const graphSamples: number[] = [];
  const adapterSamples: number[] = [];
  const planarSamples: number[] = [];
  const roadTotalSamples: number[] = [];
  const roadFootprintSamples: number[] = [];
  const roadUnionSamples: number[] = [];
  const roadClipSamples: number[] = [];
  const roadTriSamples: number[] = [];
  const railGenSamples: number[] = [];
  const fullSceneSamples: number[] = [];
  const disposeSamples: number[] = [];

  let capturedCpuBufferMemory = {
    geometryCount: 0,
    attributeBytes: 0,
    indexBytes: 0,
    totalBytes: 0,
    totalMB: 0,
  };
  let capturedSceneGeometry = {
    constructedMeshesCount: 0,
    totalVertices: 0,
    totalTriangles: 0,
    renderedVerticesWithInstances: 0,
    renderedTrianglesWithInstances: 0,
    renderedFeaturesCount: 0,
    forestTreesCount: 0,
  };
  let capturedGroupStats: CpuWorkloadBenchmarkResult['memoryAndGeometry']['groupStats'] | null =
    null;
  let lastOwnedGeosAfterDispose = 0;
  let lastOwnedMatsAfterDispose = 0;

  for (let i = 0; i < measuredIterations; i++) {
    tryTriggerGarbageCollection();

    // Stage 1: Direct GeoJSON Parse & Classification
    const tParse0 = performance.now();
    const parsedData: ProcessedMapData = dataset.parseInput();
    parseSamples.push(performance.now() - tParse0);

    // Stage 2 & 3: Direct Infrastructure Graph Construction & Graph-to-Renderer Adapter
    let descriptorsForRail: any = undefined;
    if (parsedData.topologySource) {
      const tGraph0 = performance.now();
      const graph = buildInfrastructureGraph(parsedData);
      graphSamples.push(performance.now() - tGraph0);

      const tAdapt0 = performance.now();
      const descriptors = adaptInfrastructureGraphToRenderDescriptors(graph, renderOptions);
      validateInfrastructureRenderDescriptors(descriptors);
      adapterSamples.push(performance.now() - tAdapt0);
      descriptorsForRail = descriptors;
    }

    // Stage 4: Direct Planar Surface & Polygon Boolean Resolution
    const tPlanar0 = performance.now();
    resolveAndValidatePlanarPolygons(
      parsedData.landuse || [],
      parsedData.parks || [],
      parsedData.waterBodies || [],
      parsedData.linearWaterways || []
    );
    planarSamples.push(performance.now() - tPlanar0);

    // Stage 5: Direct Railway Geometry Generation (isolated direct measurement + immediate disposal)
    const railClone: ProcessedMapData = JSON.parse(JSON.stringify(parsedData));
    const tRail0 = performance.now();
    const railIsolated = buildRailwayInfrastructure(railClone, theme, 8.0, {
      renderSource: renderOptions.railways,
      descriptors: descriptorsForRail,
      switchPolicy: renderOptions.railwaySwitchPolicy,
      ballastStrategy: renderOptions.railwayBallastStrategy,
    });
    railGenSamples.push(performance.now() - tRail0);
    railIsolated.dispose();

    // Stage 6: Complete Scene Geometry Generation
    const sceneInputClone: ProcessedMapData = JSON.parse(JSON.stringify(parsedData));
    const preview = requiresInfrastructureGraphPreview(renderOptions)
      ? prepareInfrastructureRenderPreview(sceneInputClone, renderOptions)
      : null;
    const builder = new GeometryBuilder({
      buildingHeightMultiplier: rendererConfig.buildingHeightMultiplier,
      roadWidthMultiplier: rendererConfig.roadWidthMultiplier,
      bevelEnabled: rendererConfig.bevelEnabled,
      initialCameraZoom: 8.0,
      infrastructureRenderOptions: renderOptions,
      infrastructureRenderPreview: preview,
    });

    const tScene0 = performance.now();
    const builtScene = builder.buildScene(sceneInputClone, theme);
    fullSceneSamples.push(performance.now() - tScene0);

    const rTiming = builtScene.roadsGroup.userData?.graphRoadTiming as
      | GraphRoadGenerationTiming
      | undefined;
    if (rTiming && isGraphRoadActive) {
      roadTotalSamples.push(rTiming.totalRoadGenerationTimeMs);
      roadFootprintSamples.push(rTiming.footprintConstructionTimeMs);
      roadUnionSamples.push(rTiming.polygonUnionTimeMs);
      roadClipSamples.push(rTiming.ownershipClippingTimeMs);
      roadTriSamples.push(rTiming.triangulationAndValidationTimeMs);
    }

    const memDuringScene = process.memoryUsage();
    if (memDuringScene.heapUsed > peakHeapUsedBytes) {
      peakHeapUsedBytes = memDuringScene.heapUsed;
    }

    // Capture deterministic geometry & buffer stats on final iteration before disposal
    if (i === measuredIterations - 1) {
      capturedCpuBufferMemory = builtScene.resources.getCpuBufferMemoryStats();
      const buildings = computeGroupGeometryStats(builtScene.buildingsGroup);
      const roads = computeGroupGeometryStats(builtScene.roadsGroup);
      const railways = computeGroupGeometryStats(builtScene.railwaysGroup);
      const water = computeGroupGeometryStats(builtScene.waterGroup);
      const parks = computeGroupGeometryStats(builtScene.parksGroup);
      const landuse = computeGroupGeometryStats(builtScene.landuseGroup);
      const barriers = computeGroupGeometryStats(builtScene.barriersGroup);
      const foliage = computeGroupGeometryStats(builtScene.foliageGroup);

      capturedGroupStats = {
        buildings,
        roads,
        railways,
        water,
        parks,
        landuse,
        barriers,
        foliage,
      };

      const allGroups = [buildings, roads, railways, water, parks, landuse, barriers, foliage];
      const renderedVerticesWithInstances =
        allGroups.reduce((s, g) => s + g.renderedVerticesWithInstances, 0) +
        (builtScene.groundMesh.geometry.attributes.position?.count || 0);
      const renderedTrianglesWithInstances =
        allGroups.reduce((s, g) => s + g.renderedTrianglesWithInstances, 0) +
        Math.round((builtScene.groundMesh.geometry.index?.count || 0) / 3);

      capturedSceneGeometry = {
        constructedMeshesCount: builtScene.stats.totalDrawCalls,
        totalVertices: builtScene.stats.totalVertices,
        totalTriangles: builtScene.stats.totalTriangles,
        renderedVerticesWithInstances,
        renderedTrianglesWithInstances,
        renderedFeaturesCount: builtScene.stats.renderedFeaturesCount,
        forestTreesCount: builtScene.stats.forestTreesCount ?? 0,
      };
    }

    // Stage 7: Direct Scene Resource Disposal
    const tDispose0 = performance.now();
    builtScene.dispose();
    disposeSamples.push(performance.now() - tDispose0);

    lastOwnedGeosAfterDispose = builtScene.resources.ownedGeometriesCount;
    lastOwnedMatsAfterDispose = builtScene.resources.ownedMaterialsCount;
  }

  tryTriggerGarbageCollection();
  const memAfter = process.memoryUsage();

  const netLeakedGeometries = lastOwnedGeosAfterDispose - warmedUpOwnedGeosAfterDispose;
  const netLeakedMaterials = lastOwnedMatsAfterDispose - warmedUpOwnedMatsAfterDispose;
  const disposalVerified =
    lastOwnedGeosAfterDispose === 0 &&
    lastOwnedMatsAfterDispose === 0 &&
    netLeakedGeometries === 0 &&
    netLeakedMaterials === 0;

  if (!disposalVerified) {
    errors.push({
      phase: 'scene_resource_disposal',
      datasetId: dataset.metadata.id,
      configId: rendererConfig.id,
      message: `SceneResourceManager leak detected: ownedGeos=${lastOwnedGeosAfterDispose}, ownedMats=${lastOwnedMatsAfterDispose}, netLeakedGeos=${netLeakedGeometries}, netLeakedMats=${netLeakedMaterials}`,
    });
  }

  return {
    dataset: dataset.metadata,
    rendererConfig,
    warmupIterations,
    measuredIterations,
    timingsMs: {
      geojsonParseAndClassifyMs: computeSampleStatistics(parseSamples),
      infrastructureGraphBuildMs:
        graphSamples.length > 0 ? computeSampleStatistics(graphSamples) : null,
      graphToRendererAdapterMs:
        adapterSamples.length > 0 ? computeSampleStatistics(adapterSamples) : null,
      planarSurfaceResolutionMs: computeSampleStatistics(planarSamples),
      roadGeometryGenerationMs:
        roadTotalSamples.length > 0 ? computeSampleStatistics(roadTotalSamples) : null,
      roadSubStagesMs:
        roadTotalSamples.length > 0
          ? {
              footprintConstructionMs: computeSampleStatistics(roadFootprintSamples),
              polygonUnionMs: computeSampleStatistics(roadUnionSamples),
              ownershipClippingMs: computeSampleStatistics(roadClipSamples),
              triangulationAndValidationMs: computeSampleStatistics(roadTriSamples),
            }
          : null,
      railwayGeometryGenerationMs: computeSampleStatistics(railGenSamples),
      fullSceneGeometryGenerationMs: computeSampleStatistics(fullSceneSamples),
      sceneResourceDisposalMs: computeSampleStatistics(disposeSamples),
    },
    memoryAndGeometry: {
      cpuBufferMemory: capturedCpuBufferMemory,
      v8HeapMemory: {
        gcInvokedBetweenRuns,
        heapUsedBeforeMB: toMB(memBefore.heapUsed),
        heapUsedPeakMB: toMB(peakHeapUsedBytes),
        heapUsedAfterDisposeMB: toMB(memAfter.heapUsed),
        heapDeltaAfterDisposeMB: toMB(memAfter.heapUsed - memBefore.heapUsed),
        rssMB: toMB(memAfter.rss),
        externalMB: toMB(memAfter.external),
        arrayBuffersMB: toMB(memAfter.arrayBuffers),
      },
      sceneGeometry: capturedSceneGeometry,
      groupStats: capturedGroupStats!,
      lifecycleAudit: {
        warmupIterations,
        measuredIterations,
        ownedGeometriesAfterDispose: lastOwnedGeosAfterDispose,
        ownedMaterialsAfterDispose: lastOwnedMatsAfterDispose,
        netLeakedGeometries,
        netLeakedMaterials,
        disposalVerified,
      },
    },
    unsupportedMetrics,
    errors,
  };
}

/**
 * Runs the Node.js CPU & memory benchmark suite across selected datasets and renderer configurations.
 */
export function runCpuBenchmarks(options: CpuBenchmarkRunOptions = {}): BenchmarkReport {
  const warmupIterations = options.warmupIterations ?? 2;
  const measuredIterations = options.measuredIterations ?? 5;
  const datasets = loadBenchmarkDatasets(options.datasetIds);
  const configs = resolveRendererConfigs(options.configIds);

  const env = collectHostEnvironmentMetadata();
  const globalUnsupported: UnsupportedMetricNotice[] = [];
  if (!env.gcExposed) {
    globalUnsupported.push({
      metricId: 'v8HeapMemory.deterministicGcBeforeSample',
      reason: 'unsupported_by_runtime',
      explanation:
        'Node.js was launched without --expose-gc; V8 heap snapshots reflect natural GC cadence. Use cpuBufferMemory for deterministic byte-exact geometry memory.',
    });
  }

  const cpuResults: CpuWorkloadBenchmarkResult[] = [];
  const allErrors: BenchmarkErrorRecord[] = [];

  for (const ds of datasets) {
    for (const cfg of configs) {
      try {
        const res = executeSingleCpuWorkload(ds, cfg, warmupIterations, measuredIterations);
        cpuResults.push(res);
        globalUnsupported.push(...res.unsupportedMetrics);
        allErrors.push(...res.errors);
      } catch (err: any) {
        allErrors.push({
          phase: 'cpu_workload_execution',
          datasetId: ds.metadata.id,
          configId: cfg.id,
          message: err?.message || String(err),
          stack: err?.stack,
        });
      }
    }
  }

  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    suite: 'cpu',
    benchmarkName:
      options.benchmarkName || 'OSM 3D Renderer — Node.js CPU & Memory Benchmark Suite',
    environment: env,
    methodology: {
      warmupIterations,
      measuredIterations,
      metricDefinitions: { ...STANDARD_METRIC_DEFINITIONS },
      memoryMeasurementNotes: [...MEMORY_MEASUREMENT_NOTES],
    },
    cpuResults,
    unsupportedMetrics: globalUnsupported,
    errors: allErrors,
  };
}

function parseCpuCliArgs(argv: string[]) {
  let datasetIds: string[] | undefined;
  let configIds: string[] | undefined;
  let warmupIterations = 2;
  let measuredIterations = 5;
  let outPath = 'benchmarks/baselines/cpu-baseline.json';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--datasets' && argv[i + 1]) {
      datasetIds = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--configs' && argv[i + 1]) {
      configIds = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--warmup' && argv[i + 1]) {
      warmupIterations = Math.max(0, parseInt(argv[++i], 10));
    } else if (arg === '--samples' && argv[i + 1]) {
      measuredIterations = Math.max(1, parseInt(argv[++i], 10));
    } else if (arg === '--out' && argv[i + 1]) {
      outPath = argv[++i];
    }
  }

  return {
    datasetIds,
    configIds,
    warmupIterations,
    measuredIterations,
    outPath,
  };
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const cli = parseCpuCliArgs(process.argv.slice(2));
  console.log(
    `Running CPU benchmarks (warmup=${cli.warmupIterations}, samples=${cli.measuredIterations})...`
  );
  const report = runCpuBenchmarks({
    datasetIds: cli.datasetIds,
    configIds: cli.configIds,
    warmupIterations: cli.warmupIterations,
    measuredIterations: cli.measuredIterations,
  });

  console.log('\n' + formatBenchmarkReportSummary(report));
  const savedPath = saveBenchmarkReport(report, cli.outPath);
  console.log(`\nSaved validated CPU benchmark JSON report to: ${savedPath}`);

  if (report.errors.length > 0) {
    process.exit(1);
  }
}
