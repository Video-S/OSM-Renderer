import type {
  InfrastructureRenderOptions,
  RailwayInfrastructureRenderSource,
  RoadInfrastructureRenderSource,
} from '../src/world/GeometryBuilder';
import type { GroupGeometryStats } from '../src/world/prototype/PerformanceBaselineHarness';
import type { RailwayPrototypeMode } from '../src/world/prototype/RailwayPrototypeBuilder';

import type {
  GpuScenarioStatus,
  RailwayScenarioVisibilityStatus,
} from '../src/types/BenchmarkTelemetry';

export const BENCHMARK_SCHEMA_VERSION = '1.1.0' as const;
export const SUPPORTED_BENCHMARK_SCHEMA_VERSIONS = ['1.0.0', '1.1.0'] as const;

export type BenchmarkSuiteKind = 'cpu' | 'browser';

export type ChromiumGpuBackend =
  | 'auto'
  | 'd3d11'
  | 'vulkan'
  | 'opengl'
  | 'metal'
  | 'swiftshader'
  | 'default';

export type GitMetadataStatus =
  | 'available'
  | 'ci_env_only'
  | 'unborn_head'
  | 'not_a_git_repository'
  | 'git_unavailable'
  | 'dubious_ownership'
  | 'error';

export type BenchmarkDatasetScale =
  | 'small-real-world'
  | 'medium-real-world'
  | 'complex-real-world'
  | 'synthetic-stress';

export interface SampleStatistics {
  sampleCount: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  p99: number;
  stdDev: number;
  iqr: number;
  coefficientOfVariation: number;
  samples: number[];
}

export interface UnsupportedMetricNotice {
  metricId: string;
  reason: 'unsupported_by_runtime' | 'unsupported_by_gpu_driver' | 'disjoint_gpu_timer' | 'disabled_by_config';
  explanation: string;
}

export interface BenchmarkErrorRecord {
  phase: string;
  datasetId?: string;
  configId?: string;
  scenarioId?: string;
  message: string;
  stack?: string;
}

export interface BenchmarkEnvironmentMetadata {
  gitCommitSha: string;
  gitDirty: boolean;
  gitBranch?: string | null;
  gitMetadataStatus?: GitMetadataStatus;
  gitMetadataReason?: string;
  timestampIso: string;
  nodeVersion: string;
  v8Version: string;
  platform: string;
  osRelease: string;
  arch: string;
  cpuModel: string;
  cpuLogicalCores: number;
  totalSystemMemoryMB: number;
  gcExposed: boolean;
  browser?: {
    browserName: string;
    browserVersion: string;
    userAgent: string;
    viewportWidth: number;
    viewportHeight: number;
    devicePixelRatio: number;
    webglVersion: string;
    gpuVendor: string;
    gpuRenderer: string;
    isSoftwareRenderer: boolean;
    useSwiftShader?: boolean;
    gpuBackendRequested?: ChromiumGpuBackend;
    hardwareAccelerationRequested: boolean;
    launchFlags: string[];
  };
}

export interface BenchmarkDatasetMetadata {
  id: string;
  name: string;
  scale: BenchmarkDatasetScale;
  description: string;
  sourceFiles: string[];
  contentHashSha256: string;
  originLonLat: [number, number];
  clipRadiusMeters?: number;
  rawFeatureCount: number;
  parsedFeatureCounts: {
    total: number;
    buildings: number;
    roads: number;
    railways: number;
    waterBodies: number;
    linearWaterways: number;
    parks: number;
    landuse: number;
    barriers: number;
    landmarks: number;
  };
  topologySourceCounts: {
    roadParts: number;
    railwayParts: number;
    infrastructurePoints: number;
  };
}

export interface BenchmarkRendererConfig {
  id: string;
  label: string;
  themeId: string;
  railwayPrototypeMode: RailwayPrototypeMode;
  infrastructureRenderOptions: InfrastructureRenderOptions;
  buildingHeightMultiplier: number;
  roadWidthMultiplier: number;
  bevelEnabled: boolean;
}

export interface CpuStageTimingBreakdown {
  /** Direct measurement of LocalGeoJsonProvider.parseGeoJson (or dataset clone + feature classification) */
  geojsonParseAndClassifyMs: SampleStatistics | null;
  /** Direct measurement of buildInfrastructureGraph (RoadNetworkBuilder + RailwayNetworkBuilder + CrossModalAnalyzer) */
  infrastructureGraphBuildMs: SampleStatistics | null;
  /** Direct measurement of adaptInfrastructureGraphToRenderDescriptors + validateInfrastructureRenderDescriptors */
  graphToRendererAdapterMs: SampleStatistics | null;
  /** Direct measurement of resolveAndValidatePlanarPolygons (landuse, parks, water bodies, waterways) */
  planarSurfaceResolutionMs: SampleStatistics | null;
  /** Direct measurement of road geometry generation (GraphRoadGeometryBuilder / SurfaceFirstRoadFootprints when active) */
  roadGeometryGenerationMs: SampleStatistics | null;
  /** Optional sub-stage breakdown for graph / surface-first road geometry generation */
  roadSubStagesMs?: {
    footprintConstructionMs: SampleStatistics;
    polygonUnionMs: SampleStatistics;
    ownershipClippingMs: SampleStatistics;
    triangulationAndValidationMs: SampleStatistics;
  } | null;
  /** Direct measurement of buildRailwayInfrastructure */
  railwayGeometryGenerationMs: SampleStatistics | null;
  /** Direct measurement of complete GeometryBuilder.buildScene execution */
  fullSceneGeometryGenerationMs: SampleStatistics;
  /** Direct measurement of BuiltSceneGeometry.dispose() resource release */
  sceneResourceDisposalMs: SampleStatistics;
}

export interface CpuMemoryAndGeometryMetrics {
  /** Deterministic Three.js BufferGeometry TypedArray memory (vertex attributes + indices) */
  cpuBufferMemory: {
    geometryCount: number;
    attributeBytes: number;
    indexBytes: number;
    totalBytes: number;
    totalMB: number;
  };
  /** Node.js V8 heap & RSS snapshots (subject to V8 GC non-determinism; documented in report) */
  v8HeapMemory: {
    gcInvokedBetweenRuns: boolean;
    heapUsedBeforeMB: number;
    heapUsedPeakMB: number;
    heapUsedAfterDisposeMB: number;
    heapDeltaAfterDisposeMB: number;
    rssMB: number;
    externalMB: number;
    arrayBuffersMB: number;
  };
  /** Scene-wide static geometry totals */
  sceneGeometry: {
    constructedMeshesCount: number;
    totalVertices: number;
    totalTriangles: number;
    renderedVerticesWithInstances: number;
    renderedTrianglesWithInstances: number;
    renderedFeaturesCount: number;
    forestTreesCount: number;
  };
  /** Per-group geometry breakdown */
  groupStats: {
    buildings: GroupGeometryStats;
    roads: GroupGeometryStats;
    railways: GroupGeometryStats;
    water: GroupGeometryStats;
    parks: GroupGeometryStats;
    landuse: GroupGeometryStats;
    barriers: GroupGeometryStats;
    foliage: GroupGeometryStats;
  };
  /** Resource lifecycle & disposal verification */
  lifecycleAudit: {
    warmupIterations: number;
    measuredIterations: number;
    ownedGeometriesAfterDispose: number;
    ownedMaterialsAfterDispose: number;
    netLeakedGeometries: number;
    netLeakedMaterials: number;
    disposalVerified: boolean;
  };
}

export interface CpuWorkloadBenchmarkResult {
  dataset: BenchmarkDatasetMetadata;
  rendererConfig: BenchmarkRendererConfig;
  warmupIterations: number;
  measuredIterations: number;
  timingsMs: CpuStageTimingBreakdown;
  memoryAndGeometry: CpuMemoryAndGeometryMetrics;
  unsupportedMetrics: UnsupportedMetricNotice[];
  errors: BenchmarkErrorRecord[];
}

export type BrowserScenarioKind =
  | 'static_overview'
  | 'static_close_junction'
  | 'automated_pan_sweep'
  | 'zoom_and_orbit_sweep'
  | 'repeated_scene_reload';

export interface BrowserScenarioSpec {
  id: BrowserScenarioKind;
  name: string;
  description: string;
  warmupFrames: number;
  measuredFrames: number;
  reloadCycles?: number;
}

export interface BrowserScenarioResult {
  scenarioId: BrowserScenarioKind;
  scenarioName: string;
  warmupFrames: number;
  measuredFrames: number;
  /** RAF-to-RAF frame interval in milliseconds (distinct from CPU render duration and GPU pass time) */
  frameIntervalMs: SampleStatistics;
  /** Derived steady-state frame rate from median frame interval (1000 / medianFrameIntervalMs) */
  effectiveMedianFps: number;
  /** CPU-side synchronous WebGLRenderer.render() execution time per frame in milliseconds */
  cpuFrameRenderTimeMs: SampleStatistics;
  /** GPU hardware timer query (EXT_disjoint_timer_query_webgl2) duration in milliseconds, or null when unsupported/disjoint */
  gpuFrameRenderTimeMs: {
    status: GpuScenarioStatus;
    statistics: SampleStatistics | null;
    sampleCounts?: {
      totalFrames: number;
      valid: number;
      pending: number;
      disjoint: number;
      unsupported: number;
    };
  };
  /** Actual WebGL draw calls per frame recorded from gl.info.render.calls after gl.render() */
  webglDrawCallsPerFrame: SampleStatistics;
  /** Actual rendered triangles per frame recorded from gl.info.render.triangles after gl.render() */
  renderedTrianglesPerFrame: SampleStatistics;
  /** WebGL driver resource counts and static/sampled railway visibility metrics */
  webglResources: {
    driverGeometries: number;
    driverTextures: number;
    shaderPrograms: number;
    staticRailwayMeshes?: number;
    staticRailwayTriangles?: number;
    railwayVisibilityStatus?: RailwayScenarioVisibilityStatus;
    railwayVisibilitySamplingStride?: number;
    railwayVisibilitySampledFrames?: number;
    activeRailwayMeshes: number | null;
    frustumCulledRailwayMeshes: number | null;
    frustumVisibleRailwayTriangles: number | null;
  };
  /** Overhead of per-frame benchmark telemetry collection in milliseconds */
  instrumentationOverheadMs?: SampleStatistics;
  /** Browser JS heap memory from performance.memory when available in Chromium */
  browserMemoryMB: {
    supported: boolean;
    usedJSHeapSizeMB: number | null;
    totalJSHeapSizeMB: number | null;
    jsHeapSizeLimitMB: number | null;
  };
  /** Populated for repeated_scene_reload scenario */
  reloadLifecycleAudit?: {
    cyclesExecuted: number;
    reloadAndFirstRenderMs: SampleStatistics;
    initialDriverGeometries: number;
    finalDriverGeometries: number;
    netDriverGeometryDelta: number;
    initialDriverTextures: number;
    finalDriverTextures: number;
    netDriverTextureDelta: number;
    cleanDisposalVerified: boolean;
  };
}

export interface BrowserWorkloadBenchmarkResult {
  dataset: BenchmarkDatasetMetadata;
  rendererConfig: BenchmarkRendererConfig;
  initializationTimingMs: {
    datasetParseMs: number;
    cpuSceneBuildMs: number;
    firstWebGLRenderMs: number;
    totalSceneInitToFirstFrameMs: number;
  };
  staticSceneGeometry: {
    constructedMeshesCount: number;
    sceneVertices: number;
    sceneTriangles: number;
    cpuBufferMB: number;
  };
  scenarios: BrowserScenarioResult[];
  unsupportedMetrics: UnsupportedMetricNotice[];
  errors: BenchmarkErrorRecord[];
}

export interface BenchmarkReport {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  suite: BenchmarkSuiteKind;
  benchmarkName: string;
  environment: BenchmarkEnvironmentMetadata;
  methodology: {
    warmupIterations: number;
    measuredIterations: number;
    metricDefinitions: Record<string, string>;
    memoryMeasurementNotes: string[];
  };
  cpuResults?: CpuWorkloadBenchmarkResult[];
  browserResults?: BrowserWorkloadBenchmarkResult[];
  unsupportedMetrics: UnsupportedMetricNotice[];
  errors: BenchmarkErrorRecord[];
}

export interface RegressionThresholdConfig {
  /** Max allowed percentage increase in CPU stage median time before flagging a regression (default: 20%) */
  maxCpuTimeRegressionPct: number;
  /** Max allowed percentage increase in browser frame interval / CPU render time (default: 20%) */
  maxFrameTimeRegressionPct: number;
  /** Max allowed percentage increase in WebGL draw calls per frame (default: 5%) */
  maxDrawCallsRegressionPct: number;
  /** Max allowed percentage increase in CPU geometry buffer memory bytes (default: 5%) */
  maxCpuBufferMemoryRegressionPct: number;
  /** Minimum absolute time difference (ms) required before a percentage increase is flagged as a timing regression (default: 1.0 ms) */
  minTimingRegressionAbsoluteDeltaMs: number;
}

export interface MetricComparisonDelta {
  metricPath: string;
  label: string;
  unit: 'ms' | 'bytes' | 'MB' | 'count' | 'calls' | 'triangles';
  baselineValue: number | null;
  candidateValue: number | null;
  absoluteDelta: number | null;
  percentChange: number | null;
  status:
    | 'improved'
    | 'unchanged'
    | 'regressed'
    | 'changed_neutral'
    | 'missing_in_baseline'
    | 'missing_in_candidate'
    | 'unsupported';
  thresholdPct?: number;
}

export interface WorkloadComparisonResult {
  workloadKey: string;
  datasetId: string;
  datasetName: string;
  rendererConfigId: string;
  compatible: boolean;
  incompatibilityReasons: string[];
  metrics: MetricComparisonDelta[];
  regressionsFlagged: MetricComparisonDelta[];
}

export interface BenchmarkComparisonReport {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  comparedAtIso: string;
  suite: BenchmarkSuiteKind | 'incompatible';
  compatible: boolean;
  incompatibilityErrors: string[];
  environmentWarnings: string[];
  baselineCommitSha: string;
  candidateCommitSha: string;
  thresholds: RegressionThresholdConfig;
  workloadComparisons: WorkloadComparisonResult[];
  unmatchedBaselineWorkloads: string[];
  unmatchedCandidateWorkloads: string[];
  totalRegressionsFlagged: number;
}

export type RoadRenderModeOption = RoadInfrastructureRenderSource;
export type RailwayRenderModeOption = RailwayInfrastructureRenderSource;
