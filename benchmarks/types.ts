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

// ============================================================================
// TKT-019: Regional Rendering Scalability Assessment Types
// ============================================================================

export const BENCHMARK_SCALING_SCHEMA_VERSION = '1.0.0' as const;

export type HengeloScalingLevel = 'S1' | 'S2' | 'S3' | 'S4' | 'S5';

export type ScalingWorkloadStatus =
  | 'completed'
  | 'failed_timeout'
  | 'failed_memory_limit'
  | 'failed_oom_or_crash'
  | 'failed_error'
  | 'skipped_due_to_threshold';

export type ScalingValidatorStatus =
  | 'executed'
  | 'skipped_due_to_complexity_guard'
  | 'not_applicable'
  | 'failed';

export interface ScalingResourceLimits {
  /** Max process RSS allowed before parent terminates worker (MB) */
  maxRssMB: number;
  /** Node V8 --max-old-space-size passed to child worker (MB) */
  maxOldSpaceSizeMB: number;
  /** Wall-clock timeout per isolated (dataset, config) child process (ms) */
  timeoutMs: number;
  /** Maximum at-grade road edges before quadratic O(N^2) geometry validators are guarded */
  validatorMaxEdges: number;
  /** Parent RSS poll interval (ms) */
  rssPollIntervalMs: number;
}

export interface ScalingDatasetDescriptor {
  level: HengeloScalingLevel;
  id: string;
  name: string;
  areaKm2: number;
  widthMeters: number;
  depthMeters: number;
  halfExtentMeters: number;
  centerLonLat: [number, number];
  bbox: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
  osmElementCounts: {
    nodes: number;
    ways: number;
    relations: number;
    total: number;
  };
  geoJsonFeatureCount: number;
  geoJsonSha256: string;
  gzipFileSha256: string;
  gzipBytes: number;
  uncompressedBytes: number;
  osmTimestampIso: string;
  attribution: string;
}

export interface ScalingOperationCounts {
  planarSurface: {
    totalInputPolygons: number;
    overlappingPairsChecked: number;
    conflictsResolved: number;
    deduplicatedCount: number;
    unionedCount: number;
    booleanSubtractionsCount: number;
    maxResidualFillOverlapSqMeters: number;
    violationsCount: number;
    isValid: boolean;
  };
  roads: {
    mode: RoadRenderModeOption;
    atGradeInputCount: number | null;
    renderedPrimitivesOrRibbonsCount: number | null;
    renderedJunctionCount: number | null;
    candidateBlockerCheckCount: number | null;
    overlappingBlockerCount: number | null;
    polygonUnionOperationCount: number | null;
    polygonIntersectionOperationCount: number | null;
    polygonDifferenceOperationCount: number | null;
    rejectedOrDegenerateCount: number | null;
    fullySubtractedCount: number | null;
    roundedBufferFailureCount: number | null;
    flatRibbonFallbackCount: number | null;
    surfaceClipFailureCount: number | null;
    emptyShapeCount: number | null;
    invalidTriangleGeometryCount: number | null;
    outputPolygonCount: number | null;
    outputHoleRingCount: number | null;
    outputTriangleCount: number | null;
  };
  railways: {
    renderSource: RailwayRenderModeOption | string;
    totalTracksProcessed: number | null;
    ballastSegmentCount: number | null;
    ballastBooleanUnionCount: number | null;
    sleeperInstancesCount: number | null;
    switchCount: number | null;
    chunkCount: number | null;
    overlappingPairsCount: number | null;
    clippedSleepersCount: number | null;
    spatialIndexCellCount: number | null;
    spatialIndexEntries: number | null;
    subStagesMs: {
      ballastMs: number | null;
      sleepersMs: number | null;
      railsMs: number | null;
      bridgesAndTunnelsMs: number | null;
      spatialChunkingMs: number | null;
      totalMs: number | null;
    } | null;
  };
}

export interface ScalingCompletenessAndCorrectnessMetrics {
  rawGeoJsonFeatures: number;
  sourceFeaturesClassified: number;
  totalFeaturesParsed: number;
  parsedFeaturePartsTotal: number;
  parsedByCategory: {
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
  exclusionsAndLineage: {
    skippedUnsupportedTotal: number;
    skippedUnsupportedTopTags: Array<{ tag: string; count: number }>;
    clippedByBoundaryCount: number;
    omittedOutsideBoundaryCount: number;
    deduplicatedCount: number;
    chainedGroupsCount: number;
    chainedFeaturesCount: number;
    featuresFullySubtractedCount: number;
    clippingFailuresCount: number;
    conflictingPlacementFallbacksCount: number;
    rejectedInvalidTotal: number;
    rejectedInvalidByReason: Record<string, number>;
  };
  renderedCoverage: {
    sourceFeaturesRenderedCount: number;
    coverageVsClassifiedRatio: number;
    builtSceneRenderedFeaturesCount: number;
    railwayRendererFallback: string | null;
    unattributedMeshFacesCount: number;
    unattributedInstancedItemsCount: number;
    invalidNanOrNonFiniteVertexCount: number;
  };
  topologyAudit: {
    roadNodeCount: number;
    roadEdgeCount: number;
    railwayNodeCount: number;
    railwayEdgeCount: number;
    railwayConfirmedSwitchCount: number;
    railwayUnresolvedSwitchCount: number;
    railwayFlatCrossingCount: number;
    railwayUnresolvedJunctionCount: number;
    gradeTransitionCount: number;
    unresolvedGradeTransitionCount: number;
    levelCrossingCount: number;
    pedestrianRailCrossingCount: number;
    unresolvedCrossingCount: number;
    gradeSeparatedCrossingCount: number;
    unresolvedInfrastructurePointsCount: number;
    descriptorValidationPassed: boolean;
    descriptorValidationErrorCount: number;
  } | null;
  geometryValidation: {
    graphMeshIntegrity: {
      status: ScalingValidatorStatus;
      auditedMeshCount: number | null;
      auditedTriangleCount: number | null;
      upwardTriangleCount: number | null;
      negativelyWoundCount: number | null;
      storedNormalMismatchCount: number | null;
      degenerateTriangleCount: number | null;
      invalidPositionCount: number | null;
    };
    roadNetworkOverlapAndContinuity: {
      status: ScalingValidatorStatus;
      reason?: string;
      overlapConflictCount: number | null;
      overlapAreaSqMeters: number | null;
      continuityDefectCount: number | null;
    };
    surfaceFirstValidation: {
      status: ScalingValidatorStatus;
      reason?: string;
      coverageDefectCount: number | null;
      networkCoverageRatio: number | null;
      unexplainedMissingAreaM2: number | null;
      overlapDefectCount: number | null;
      overlapAreaM2: number | null;
      inconsistentElevationDefectCount: number | null;
      tinyDisconnectedFragmentCount: number | null;
      provenanceDefectCount: number | null;
      overallValid: boolean | null;
    };
  };
  capturedWarnings: string[];
}

export interface ScalingMemoryMetrics {
  cpuBufferMemory: {
    geometryCount: number;
    attributeBytes: number;
    indexBytes: number;
    totalBytes: number;
    totalMB: number;
  };
  workerV8Heap: {
    gcInvokedBeforeRun: boolean;
    heapUsedBeforeMB: number;
    heapUsedPeakMB: number;
    heapUsedAfterDisposeMB: number;
    heapDeltaAfterDisposeMB: number;
    externalMB: number;
    arrayBuffersMB: number;
  };
  processRssMB: {
    workerInitialMB: number;
    workerPeakObservedMB: number;
    workerAfterDisposeMB: number;
    parentPolledPeakMB: number | null;
  };
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

export interface ScalingWorkloadResult {
  workloadKey: string;
  dataset: ScalingDatasetDescriptor;
  rendererConfig: BenchmarkRendererConfig;
  status: ScalingWorkloadStatus;
  statusReason: string;
  workerWallClockMs: number;
  lastHeartbeatStage: string | null;
  lastHeartbeatElapsedMs: number | null;
  warmupIterations: number;
  measuredIterations: number;
  timingsMs: CpuStageTimingBreakdown | null;
  memory: ScalingMemoryMetrics | null;
  sceneGeometry: {
    constructedMeshesCount: number;
    totalVertices: number;
    totalTriangles: number;
    renderedVerticesWithInstances: number;
    renderedTrianglesWithInstances: number;
    renderedFeaturesCount: number;
    forestTreesCount: number;
  } | null;
  operations: ScalingOperationCounts | null;
  completenessAndCorrectness: ScalingCompletenessAndCorrectnessMetrics | null;
  unsupportedMetrics: UnsupportedMetricNotice[];
  errors: BenchmarkErrorRecord[];
}

export interface ScalingConfigProgressionSummary {
  configId: string;
  configLabel: string;
  highestCompletedLevel: HengeloScalingLevel | null;
  stoppedAtLevel: HengeloScalingLevel | null;
  stopReason: string | null;
  completedLevelsCount: number;
  skippedLevelsCount: number;
  failedLevelsCount: number;
}

export interface RegionalScalingReport {
  schemaVersion: typeof BENCHMARK_SCALING_SCHEMA_VERSION;
  suite: 'regional-scaling';
  benchmarkName: string;
  generatedAtIso: string;
  environment: BenchmarkEnvironmentMetadata;
  datasetSeries: {
    studyArea: string;
    sourceFileName: string;
    sourceSha256: string;
    osmTimestampIso: string;
    attribution: string;
    datasets: ScalingDatasetDescriptor[];
  };
  resourceLimits: ScalingResourceLimits;
  methodology: {
    warmupIterations: number;
    measuredIterations: number;
    executionModel: string;
    metricDefinitions: Record<string, string>;
    memoryMeasurementNotes: string[];
  };
  configSummaries: ScalingConfigProgressionSummary[];
  results: ScalingWorkloadResult[];
  errors: BenchmarkErrorRecord[];
}

