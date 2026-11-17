import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { MAP_THEMES } from '../src/styles/mapThemes';
import { ProcessedMapData } from '../src/types/MapFeature';
import {
  BuiltSceneGeometry,
  FaceFeatureRange,
  GeometryBuilder,
  prepareInfrastructureRenderPreview,
  requiresInfrastructureGraphPreview,
} from '../src/world/GeometryBuilder';
import {
  RailwayBuildProfile,
  RailwayPrototypeStats,
} from '../src/world/infrastructure/railways/RailwayGeometryBuilder';
import {
  auditGraphRoadMeshIntegrity,
  GraphRoadGenerationTiming,
  GraphRoadRenderStats,
} from '../src/world/infrastructure/roads/GraphRoadGeometryBuilder';
import { validateSurfaceFirstRoadGeometry } from '../src/world/infrastructure/roads/SurfaceFirstRoadValidator';
import { buildInfrastructureGraph } from '../src/world/infrastructure/topology/InfrastructureGraph';
import {
  adaptInfrastructureGraphToRenderDescriptors,
  InfrastructureRenderPreviewResult,
  validateInfrastructureRenderDescriptors,
} from '../src/world/infrastructure/rendering/InfrastructureRenderAdapter';
import {
  PlanarValidationReport,
} from '../src/world/PlanarLayerValidator';
import { validateRoadNetworkGeometry } from '../src/world/ZFightingValidator';
import { resolveRendererConfigs } from './scenarios';
import {
  DEFAULT_HENGELO_SCALING_MANIFEST_PATH,
  loadHengeloScalingDatasets,
} from './scalingDatasets';
import { computeSampleStatistics } from './stats';
import type {
  BenchmarkErrorRecord,
  CpuStageTimingBreakdown,
  ScalingCompletenessAndCorrectnessMetrics,
  ScalingMemoryMetrics,
  ScalingOperationCounts,
  ScalingWorkloadResult,
  UnsupportedMetricNotice,
} from './types';

export interface ScalingIterationPartialPayload {
  completedMeasuredIterations: number;
  timingsMs: CpuStageTimingBreakdown;
  memory: ScalingMemoryMetrics;
  sceneGeometry: ScalingWorkloadResult['sceneGeometry'];
  operations: ScalingOperationCounts | null;
  unsupportedMetrics: UnsupportedMetricNotice[];
}

function tryTriggerGc(): boolean {
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

function sendHeartbeat(stage: string, startMs: number, peakRssBytes: { value: number }): void {
  const mem = process.memoryUsage();
  if (mem.rss > peakRssBytes.value) {
    peakRssBytes.value = mem.rss;
  }
  if (typeof process.send === 'function') {
    try {
      process.send({
        type: 'heartbeat',
        stage,
        rssMB: toMB(mem.rss),
        heapUsedMB: toMB(mem.heapUsed),
        elapsedMs: Number((performance.now() - startMs).toFixed(1)),
      });
    } catch {
      // Ignore broken IPC pipe if parent already aborted
    }
  }
}

interface ProvenanceAndVertexAudit {
  unattributedMeshFacesCount: number;
  unattributedInstancedItemsCount: number;
  invalidNanOrNonFiniteVertexCount: number;
}

function auditSceneProvenanceAndVertices(scene: BuiltSceneGeometry): ProvenanceAndVertexAudit {
  let unattributedMeshFacesCount = 0;
  let unattributedInstancedItemsCount = 0;
  let invalidNanOrNonFiniteVertexCount = 0;

  const groups: THREE.Object3D[] = [
    scene.buildingsGroup,
    scene.roadsGroup,
    scene.railwaysGroup,
    scene.waterGroup,
    scene.parksGroup,
    scene.landuseGroup,
    scene.barriersGroup,
    scene.foliageGroup,
  ];

  // Structural/underground/support meshes whose parent or name may not carry individual feature provenance
  const OPTIONAL_UNATTRIBUTED_NAMES = new Set([
    'GroundPlane',
    'Tunnel_Entrances',
    'Tunnel_Underground_Trace',
    'Railway_Tunnel_Traces',
  ]);

  for (const group of groups) {
    group.traverse((obj) => {
      if ((obj as THREE.InstancedMesh).isInstancedMesh) {
        const inst = obj as THREE.InstancedMesh;
        const posAttr = inst.geometry?.getAttribute('position');
        if (posAttr) {
          for (let i = 0; i < posAttr.count; i++) {
            if (
              !Number.isFinite(posAttr.getX(i)) ||
              !Number.isFinite(posAttr.getY(i)) ||
              !Number.isFinite(posAttr.getZ(i))
            ) {
              invalidNanOrNonFiniteVertexCount++;
            }
          }
        }
        const infos = inst.userData?.instanceInfos as Array<{ sourceFeatureId?: string; id?: string }> | undefined;
        if (!Array.isArray(infos)) {
          unattributedInstancedItemsCount += inst.count;
        } else {
          for (let k = 0; k < inst.count; k++) {
            const info = infos[k];
            if (!info || (!info.sourceFeatureId && !info.id)) {
              unattributedInstancedItemsCount++;
            }
          }
        }
        return;
      }

      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const geom = mesh.geometry;
        if (!geom) return;
        const posAttr = geom.getAttribute('position');
        if (!posAttr) return;

        for (let i = 0; i < posAttr.count; i++) {
          if (
            !Number.isFinite(posAttr.getX(i)) ||
            !Number.isFinite(posAttr.getY(i)) ||
            !Number.isFinite(posAttr.getZ(i))
          ) {
            invalidNanOrNonFiniteVertexCount++;
          }
        }

        const idxAttr = geom.getIndex();
        const triCount = idxAttr
          ? Math.floor(idxAttr.count / 3)
          : Math.floor(posAttr.count / 3);
        if (triCount <= 0 || OPTIONAL_UNATTRIBUTED_NAMES.has(mesh.name)) {
          return;
        }

        const ranges = mesh.userData?.faceRanges as FaceFeatureRange[] | undefined;
        if (Array.isArray(ranges) && ranges.length > 0) {
          let coveredFaces = 0;
          for (const r of ranges) {
            if (r.info && (r.info.sourceFeatureId || r.info.id)) {
              coveredFaces += Math.max(0, Math.min(triCount, r.endFace) - Math.max(0, r.startFace));
            }
          }
          if (coveredFaces < triCount) {
            unattributedMeshFacesCount += triCount - coveredFaces;
          }
        } else if (!mesh.userData?.sourceFeatureId && !mesh.userData?.id) {
          unattributedMeshFacesCount += triCount;
        }
      }
    });
  }

  return {
    unattributedMeshFacesCount,
    unattributedInstancedItemsCount,
    invalidNanOrNonFiniteVertexCount,
  };
}

export interface ScalingWorkerCliArgs {
  manifestPath: string;
  levelOrId: string;
  configId: string;
  warmupIterations: number;
  measuredIterations: number;
  validatorMaxEdges: number;
}

export function parseScalingWorkerArgs(argv: readonly string[]): ScalingWorkerCliArgs {
  let manifestPath = DEFAULT_HENGELO_SCALING_MANIFEST_PATH;
  let levelOrId = '';
  let configId = '';
  let warmupIterations = 1;
  let measuredIterations = 3;
  let validatorMaxEdges = 250;

  for (const arg of argv) {
    if (arg.startsWith('--manifest=')) manifestPath = arg.slice('--manifest='.length).trim();
    else if (arg.startsWith('--dataset=')) levelOrId = arg.slice('--dataset='.length).trim();
    else if (arg.startsWith('--config=')) configId = arg.slice('--config='.length).trim();
    else if (arg.startsWith('--warmup=')) warmupIterations = Number.parseInt(arg.slice('--warmup='.length), 10);
    else if (arg.startsWith('--iterations=')) measuredIterations = Number.parseInt(arg.slice('--iterations='.length), 10);
    else if (arg.startsWith('--validator-max-edges=')) {
      validatorMaxEdges = Number.parseInt(arg.slice('--validator-max-edges='.length), 10);
    }
  }

  if (!levelOrId || !configId) {
    throw new Error('scalingWorker requires --dataset=<levelOrId> and --config=<configId>.');
  }

  return {
    manifestPath,
    levelOrId,
    configId,
    warmupIterations: Number.isFinite(warmupIterations) ? Math.max(0, warmupIterations) : 1,
    measuredIterations: Number.isFinite(measuredIterations) ? Math.max(1, measuredIterations) : 3,
    validatorMaxEdges: Number.isFinite(validatorMaxEdges) ? Math.max(0, validatorMaxEdges) : 250,
  };
}

export function executeScalingWorkerTask(args: ScalingWorkerCliArgs): ScalingWorkloadResult {
  const startMs = performance.now();
  const peakRssBytes = { value: process.memoryUsage().rss };
  const workerInitialRssBytes = peakRssBytes.value;

  const { datasets } = loadHengeloScalingDatasets({
    manifestPath: args.manifestPath,
    levelsOrIds: [args.levelOrId],
    verifyHashes: true,
  });
  const dataset = datasets[0];
  const [rendererConfig] = resolveRendererConfigs([args.configId]);
  const theme = MAP_THEMES[rendererConfig.themeId] || MAP_THEMES.tactical;
  const renderOptions = rendererConfig.infrastructureRenderOptions;

  const isGraphPreviewActive = requiresInfrastructureGraphPreview(renderOptions);
  const isGraphRoadActive = true;
  const isSurfaceFirstRoadActive = true;

  const unsupportedMetrics: UnsupportedMetricNotice[] = [];
  const errors: BenchmarkErrorRecord[] = [];
  const workloadKey = `${dataset.descriptor.id}::${rendererConfig.id}`;

  const updatePeakRss = () => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes.value) peakRssBytes.value = rss;
    return rss;
  };

  sendHeartbeat('warmup_start', startMs, peakRssBytes);

  let warmedUpOwnedGeos = 0;
  let warmedUpOwnedMats = 0;

  for (let w = 0; w < args.warmupIterations; w++) {
    const warmParsed = dataset.parseInput();
    const warmPreview = isGraphPreviewActive
      ? prepareInfrastructureRenderPreview(warmParsed, renderOptions)
      : null;
    const warmBuilder = new GeometryBuilder({
      buildingHeightMultiplier: rendererConfig.buildingHeightMultiplier,
      roadWidthMultiplier: rendererConfig.roadWidthMultiplier,
      bevelEnabled: rendererConfig.bevelEnabled,
      initialCameraZoom: 8.0,
      infrastructureRenderOptions: renderOptions,
      infrastructureRenderPreview: warmPreview,
    });
    const warmScene = warmBuilder.buildScene(warmParsed, theme);
    updatePeakRss();
    warmScene.dispose();
    warmedUpOwnedGeos = warmScene.resources.ownedGeometriesCount;
    warmedUpOwnedMats = warmScene.resources.ownedMaterialsCount;
    sendHeartbeat(`warmup_${w + 1}`, startMs, peakRssBytes);
  }

  const gcInvokedBeforeRun = tryTriggerGc();
  const memBefore = process.memoryUsage();
  let peakHeapUsedBytes = memBefore.heapUsed;
  updatePeakRss();

  const parseSamples: number[] = [];
  const graphSamples: number[] = [];
  const adapterSamples: number[] = [];
  const planarSamples: number[] = [];
  const roadTotalSamples: number[] = [];
  const roadPrimitiveSamples: number[] = [];
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
  let capturedSceneGeometry: ScalingWorkloadResult['sceneGeometry'] = null;
  let capturedOperations: ScalingOperationCounts | null = null;
  let capturedCompleteness: ScalingCompletenessAndCorrectnessMetrics | null = null;
  let lastOwnedGeosAfterDispose = 0;
  let lastOwnedMatsAfterDispose = 0;
  let completedMeasuredIterations = 0;

  const buildTimingsBreakdown = (): CpuStageTimingBreakdown => ({
    geojsonParseAndClassifyMs: computeSampleStatistics(parseSamples),
    infrastructureGraphBuildMs:
      graphSamples.length > 0 ? computeSampleStatistics(graphSamples) : null,
    graphToRendererAdapterMs:
      adapterSamples.length > 0 ? computeSampleStatistics(adapterSamples) : null,
    planarSurfaceResolutionMs:
      planarSamples.length > 0 ? computeSampleStatistics(planarSamples) : null,
    roadGeometryGenerationMs:
      roadTotalSamples.length > 0 ? computeSampleStatistics(roadTotalSamples) : null,
    roadSubStagesMs:
      isSurfaceFirstRoadActive && roadTotalSamples.length > 0
        ? {
            primitiveConstructionMs: computeSampleStatistics(roadPrimitiveSamples),
            footprintConstructionMs: computeSampleStatistics(roadFootprintSamples),
            polygonUnionMs: computeSampleStatistics(roadUnionSamples),
            ownershipClippingMs: computeSampleStatistics(roadClipSamples),
            triangulationAndValidationMs: computeSampleStatistics(roadTriSamples),
          }
        : null,
    railwayGeometryGenerationMs:
      railGenSamples.length > 0 ? computeSampleStatistics(railGenSamples) : null,
    fullSceneGeometryGenerationMs: computeSampleStatistics(fullSceneSamples),
    sceneResourceDisposalMs: computeSampleStatistics(disposeSamples),
  });

  const buildMemoryMetrics = (memAfterSnapshot: NodeJS.MemoryUsage): ScalingMemoryMetrics => {
    const netLeakedGeometries = lastOwnedGeosAfterDispose - warmedUpOwnedGeos;
    const netLeakedMaterials = lastOwnedMatsAfterDispose - warmedUpOwnedMats;
    const disposalVerified =
      lastOwnedGeosAfterDispose === 0 &&
      lastOwnedMatsAfterDispose === 0 &&
      netLeakedGeometries === 0 &&
      netLeakedMaterials === 0;
    return {
      cpuBufferMemory: capturedCpuBufferMemory,
      workerV8Heap: {
        gcInvokedBeforeRun,
        heapUsedBeforeMB: toMB(memBefore.heapUsed),
        heapUsedPeakMB: toMB(peakHeapUsedBytes),
        heapUsedAfterDisposeMB: toMB(memAfterSnapshot.heapUsed),
        heapDeltaAfterDisposeMB: toMB(memAfterSnapshot.heapUsed - memBefore.heapUsed),
        externalMB: toMB(memAfterSnapshot.external),
        arrayBuffersMB: toMB(memAfterSnapshot.arrayBuffers),
      },
      processRssMB: {
        workerInitialMB: toMB(workerInitialRssBytes),
        workerPeakObservedMB: toMB(peakRssBytes.value),
        workerAfterDisposeMB: toMB(memAfterSnapshot.rss),
        parentPolledPeakMB: null,
      },
      lifecycleAudit: {
        warmupIterations: args.warmupIterations,
        measuredIterations: completedMeasuredIterations,
        ownedGeometriesAfterDispose: lastOwnedGeosAfterDispose,
        ownedMaterialsAfterDispose: lastOwnedMatsAfterDispose,
        netLeakedGeometries,
        netLeakedMaterials,
        disposalVerified,
      },
    };
  };

  const capturedWarnings = new Set<string>();
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...warnArgs: unknown[]) => {
    if (capturedWarnings.size < 50) {
      capturedWarnings.add(`WARN: ${warnArgs.map(String).join(' ').slice(0, 300)}`);
    }
  };
  console.error = (...errArgs: unknown[]) => {
    if (capturedWarnings.size < 50) {
      capturedWarnings.add(`ERROR: ${errArgs.map(String).join(' ').slice(0, 300)}`);
    }
  };

  try {
    for (let i = 0; i < args.measuredIterations; i++) {
      tryTriggerGc();
      const isFinalAuditIteration = i === args.measuredIterations - 1;
      sendHeartbeat(`iter_${i + 1}_parse`, startMs, peakRssBytes);

      // 1. Parse & Classify
      const tParse0 = performance.now();
      const parsedData: ProcessedMapData = dataset.parseInput();
      parseSamples.push(performance.now() - tParse0);
      updatePeakRss();

      // 2. Infrastructure Graph + Adapter (when enabled by config; passed into buildScene to avoid double execution)
      let previewForScene: InfrastructureRenderPreviewResult | null = null;
      if (isGraphPreviewActive && parsedData.topologySource) {
        sendHeartbeat(`iter_${i + 1}_graph_adapter`, startMs, peakRssBytes);
        previewForScene = prepareInfrastructureRenderPreview(parsedData, renderOptions);
        graphSamples.push(previewForScene.timing.graphBuildTimeMs);
        adapterSamples.push(
          previewForScene.timing.adapterBuildTimeMs + previewForScene.timing.validationTimeMs
        );
        updatePeakRss();
      }

      // 3. Full Scene Generation (single pass — planar & railway timings measured inline inside buildScene)
      sendHeartbeat(`iter_${i + 1}_scene_build`, startMs, peakRssBytes);
      const builder = new GeometryBuilder({
        buildingHeightMultiplier: rendererConfig.buildingHeightMultiplier,
        roadWidthMultiplier: rendererConfig.roadWidthMultiplier,
        bevelEnabled: rendererConfig.bevelEnabled,
        initialCameraZoom: 8.0,
        infrastructureRenderOptions: renderOptions,
        infrastructureRenderPreview: previewForScene,
      });
      const tScene0 = performance.now();
      const builtScene = builder.buildScene(parsedData, theme);
      fullSceneSamples.push(performance.now() - tScene0);
      updatePeakRss();

      const memDuring = process.memoryUsage();
      if (memDuring.heapUsed > peakHeapUsedBytes) peakHeapUsedBytes = memDuring.heapUsed;

      const planarMs = builtScene.landuseGroup.userData?.planarResolutionTimingMs;
      if (typeof planarMs === 'number' && Number.isFinite(planarMs)) {
        planarSamples.push(planarMs);
      }
      const railMs = builtScene.railwaysGroup.userData?.railwayGenerationTimingMs;
      if (typeof railMs === 'number' && Number.isFinite(railMs)) {
        railGenSamples.push(railMs);
      }

      const rTiming = builtScene.roadsGroup.userData?.graphRoadTiming as
        | GraphRoadGenerationTiming
        | undefined;
      if (rTiming) {
        roadTotalSamples.push(rTiming.totalRoadGenerationTimeMs);
        roadPrimitiveSamples.push(rTiming.primitiveConstructionTimeMs);
        roadFootprintSamples.push(rTiming.footprintConstructionTimeMs);
        roadUnionSamples.push(rTiming.polygonUnionTimeMs);
        roadClipSamples.push(rTiming.ownershipClippingTimeMs);
        roadTriSamples.push(rTiming.triangulationAndValidationTimeMs);
      }

      if (i === 0 || isFinalAuditIteration) {
        if (isFinalAuditIteration) {
          sendHeartbeat(`iter_${i + 1}_audit`, startMs, peakRssBytes);
        }
        capturedCpuBufferMemory = builtScene.resources.getCpuBufferMemoryStats();

        const computeGroupTris = (g: THREE.Group): { verts: number; tris: number } => {
          let verts = 0;
          let tris = 0;
          g.traverse((obj) => {
            if ((obj as THREE.InstancedMesh).isInstancedMesh) {
              const inst = obj as THREE.InstancedMesh;
              const vc = inst.geometry?.getAttribute('position')?.count || 0;
              const tc = inst.geometry?.getIndex()
                ? inst.geometry.getIndex()!.count / 3
                : vc / 3;
              verts += vc * inst.count;
              tris += tc * inst.count;
            } else if ((obj as THREE.Mesh).isMesh) {
              const m = obj as THREE.Mesh;
              const vc = m.geometry?.getAttribute('position')?.count || 0;
              const tc = m.geometry?.getIndex()
                ? m.geometry.getIndex()!.count / 3
                : vc / 3;
              verts += vc;
              tris += tc;
            }
          });
          return { verts, tris: Math.round(tris) };
        };

        const groupsList = [
          builtScene.buildingsGroup,
          builtScene.roadsGroup,
          builtScene.railwaysGroup,
          builtScene.waterGroup,
          builtScene.parksGroup,
          builtScene.landuseGroup,
          builtScene.barriersGroup,
          builtScene.foliageGroup,
        ];
        let renderedVerticesWithInstances =
          builtScene.groundMesh.geometry.attributes.position?.count || 0;
        let renderedTrianglesWithInstances = Math.round(
          (builtScene.groundMesh.geometry.index?.count || 0) / 3
        );
        for (const grp of groupsList) {
          const gt = computeGroupTris(grp);
          renderedVerticesWithInstances += gt.verts;
          renderedTrianglesWithInstances += gt.tris;
        }

        capturedSceneGeometry = {
          constructedMeshesCount: builtScene.stats.totalDrawCalls,
          totalVertices: builtScene.stats.totalVertices,
          totalTriangles: builtScene.stats.totalTriangles,
          renderedVerticesWithInstances,
          renderedTrianglesWithInstances,
          renderedFeaturesCount: builtScene.stats.renderedFeaturesCount,
          forestTreesCount: builtScene.stats.forestTreesCount ?? 0,
        };

        const planarReport = builtScene.landuseGroup.userData?.planarValidationReport as
          | PlanarValidationReport
          | undefined;
        const graphRoadStats = builtScene.roadsGroup.userData?.graphRoadStats as
          | GraphRoadRenderStats
          | undefined;
        const railStats = builtScene.railwaysGroup.userData?.railwayStats as
          | RailwayPrototypeStats
          | undefined;
        const railProfile = builtScene.railwaysGroup.userData?.railwayProfile as
          | RailwayBuildProfile
          | undefined;

        capturedOperations = {
          planarSurface: {
            totalInputPolygons: planarReport?.totalPolygons ?? 0,
            overlappingPairsChecked: planarReport?.overlappingPairsChecked ?? 0,
            conflictsResolved: planarReport?.conflictsResolved ?? 0,
            deduplicatedCount: planarReport?.deduplicatedCount ?? 0,
            unionedCount: planarReport?.unionedCount ?? 0,
            booleanSubtractionsCount: planarReport?.booleanSubtractionsCount ?? 0,
            maxResidualFillOverlapSqMeters: planarReport?.maxResidualFillOverlapSqMeters ?? 0,
            violationsCount: planarReport?.violations.length ?? 0,
            isValid: planarReport?.isValid ?? true,
          },
          roads: {
            mode: renderOptions.roads,
            atGradeInputCount: graphRoadStats?.atGradeRoadEdgeCount ?? null,
            renderedPrimitivesOrRibbonsCount: graphRoadStats?.renderedRoadRibbonCount ?? null,
            renderedJunctionCount: graphRoadStats?.renderedJunctionCount ?? null,
            candidateBlockerCheckCount: graphRoadStats?.candidateBlockerCheckCount ?? null,
            overlappingBlockerCount: graphRoadStats?.overlappingBlockerCount ?? null,
            polygonUnionOperationCount: graphRoadStats?.polygonUnionOperationCount ?? null,
            polygonIntersectionOperationCount: null,
            polygonDifferenceOperationCount: graphRoadStats?.polygonDifferenceOperationCount ?? null,
            rejectedOrDegenerateCount: graphRoadStats?.rejectedOrDegenerateCount ?? null,
            fullySubtractedCount: graphRoadStats?.fullySubtractedCount ?? null,
            roundedBufferFailureCount: graphRoadStats?.roundedBufferFailureCount ?? null,
            flatRibbonFallbackCount: graphRoadStats?.flatRibbonFallbackCount ?? null,
            surfaceClipFailureCount: graphRoadStats?.surfaceClipFailureCount ?? null,
            emptyShapeCount: graphRoadStats?.emptyShapeCount ?? null,
            invalidTriangleGeometryCount: graphRoadStats?.invalidTriangleGeometryCount ?? null,
            outputPolygonCount: graphRoadStats?.outputPolygonCount ?? null,
            outputHoleRingCount: graphRoadStats?.outputHoleRingCount ?? null,
            outputTriangleCount: graphRoadStats?.outputTriangleCount ?? null,
          },
          railways: {
            renderSource: railStats?.railwayRenderSource ?? renderOptions.railways,
            totalTracksProcessed: railStats?.renderedRailwaysCount ?? null,
            ballastSegmentCount: railStats?.ballastFootprintCount ?? null,
            ballastBooleanUnionCount:
              typeof railStats?.ballastBooleanUnionCount === 'number'
                ? railStats.ballastBooleanUnionCount
                : null,
            sleeperInstancesCount: railStats?.sleeper3DBoxCount ?? null,
            switchCount: railStats?.confirmedSwitchCount ?? null,
            chunkCount: railStats?.spatialChunkCount ?? null,
            overlappingPairsCount: railProfile?.sleeperOverlapStats?.existingCandidatesChecked ?? null,
            clippedSleepersCount: railProfile?.sleeperOverlapStats?.clippedOrShortenedSleepersCount ?? null,
            spatialIndexCellCount: railProfile?.spatialIndexStats?.gridCellsCount ?? null,
            spatialIndexEntries: railProfile?.spatialIndexStats?.registeredSegmentsCount ?? null,
            subStagesMs: railProfile
              ? {
                  ballastMs: railProfile.uvRibbonAndSwitchTimeMs,
                  sleepersMs: railProfile.sleeper3DPlacementTimeMs,
                  railsMs: railProfile.rail3DExtrusionTimeMs,
                  bridgesAndTunnelsMs: railProfile.bridgeAndTunnelTimeMs,
                  spatialChunkingMs: railProfile.geometryMergeAndChunkTimeMs,
                  totalMs: railProfile.totalBuildTimeMs,
                }
              : null,
          },
        };

        if (isFinalAuditIteration) {
          // Completeness & Topology Audit
          const provAudit = auditSceneProvenanceAndVertices(builtScene);
        const meshAudit = auditGraphRoadMeshIntegrity(builtScene.roadsGroup);

        // Topology audit (reuse preview graph if built, otherwise run audit graph on parsedData outside render timing)
        let auditGraph = previewForScene?.graph ?? null;
        let auditValidation = previewForScene?.validation ?? null;
        if (!auditGraph && parsedData.topologySource) {
          auditGraph = buildInfrastructureGraph(parsedData);
          const desc = adaptInfrastructureGraphToRenderDescriptors(auditGraph, {
            roads: 'graph-surface',
            railways: 'graph-R+',
            railwaySwitchPolicy: 'graph',
            railwayBallastStrategy: 'surface-first',
          });
          auditValidation = validateInfrastructureRenderDescriptors(desc);
        }

        const roadEdgeCount =
          auditGraph?.diagnostics.roadEdgeCount ?? parsedData.roads.length;
        const canRunQuadraticValidators = roadEdgeCount <= args.validatorMaxEdges;

        let roadOverlapAndContinuity: ScalingCompletenessAndCorrectnessMetrics['geometryValidation']['roadNetworkOverlapAndContinuity'];
        if (canRunQuadraticValidators) {
          try {
            const roadVal = validateRoadNetworkGeometry(builtScene);
            roadOverlapAndContinuity = {
              status: 'executed',
              overlapConflictCount: roadVal.overlapConflicts.length,
              overlapAreaSqMeters: Number(
                roadVal.overlapConflicts
                  .reduce((sum, c) => sum + c.overlapAreaSqMeters, 0)
                  .toFixed(4)
              ),
              continuityDefectCount: roadVal.continuityDefects.length,
            };
          } catch (err: any) {
            roadOverlapAndContinuity = {
              status: 'failed',
              reason: err?.message || String(err),
              overlapConflictCount: null,
              overlapAreaSqMeters: null,
              continuityDefectCount: null,
            };
          }
        } else {
          roadOverlapAndContinuity = {
            status: 'skipped_due_to_complexity_guard',
            reason: `Skipped O(N^2) validateRoadNetworkGeometry because roadEdgeCount (${roadEdgeCount}) exceeds --validator-max-edges=${args.validatorMaxEdges}.`,
            overlapConflictCount: null,
            overlapAreaSqMeters: null,
            continuityDefectCount: null,
          };
        }

        let surfaceFirstValidation: ScalingCompletenessAndCorrectnessMetrics['geometryValidation']['surfaceFirstValidation'];
        if (renderOptions.roads !== 'graph-surface') {
          surfaceFirstValidation = {
            status: 'not_applicable',
            reason: `Config uses roads="${renderOptions.roads}" (not "graph-surface").`,
            coverageDefectCount: null,
            networkCoverageRatio: null,
            unexplainedMissingAreaM2: null,
            overlapDefectCount: null,
            overlapAreaM2: null,
            inconsistentElevationDefectCount: null,
            tinyDisconnectedFragmentCount: null,
            provenanceDefectCount: null,
            overallValid: null,
          };
        } else if (canRunQuadraticValidators) {
          try {
            const sfReport = validateSurfaceFirstRoadGeometry(builtScene, parsedData, {
              roadWidthMultiplier: rendererConfig.roadWidthMultiplier,
            });
            surfaceFirstValidation = {
              status: 'executed',
              coverageDefectCount: sfReport.coverage.defects.length,
              networkCoverageRatio: Number(sfReport.coverage.networkCoverageRatio.toFixed(4)),
              unexplainedMissingAreaM2: Number(
                sfReport.coverage.unexplainedNetworkMissingAreaM2.toFixed(4)
              ),
              overlapDefectCount: sfReport.overlaps.totalPositiveAreaOverlapCount,
              overlapAreaM2: Number(sfReport.overlaps.totalOverlapAreaM2.toFixed(4)),
              inconsistentElevationDefectCount:
                sfReport.meshIntegrity.inconsistentElevationDefectCount,
              tinyDisconnectedFragmentCount:
                sfReport.meshIntegrity.tinyDisconnectedFragmentCount,
              provenanceDefectCount: sfReport.provenance.defects.length,
              overallValid: sfReport.valid,
            };
          } catch (err: any) {
            surfaceFirstValidation = {
              status: 'failed',
              reason: err?.message || String(err),
              coverageDefectCount: null,
              networkCoverageRatio: null,
              unexplainedMissingAreaM2: null,
              overlapDefectCount: null,
              overlapAreaM2: null,
              inconsistentElevationDefectCount: null,
              tinyDisconnectedFragmentCount: null,
              provenanceDefectCount: null,
              overallValid: null,
            };
          }
        } else {
          surfaceFirstValidation = {
            status: 'skipped_due_to_complexity_guard',
            reason: `Skipped O(N^2) validateSurfaceFirstRoadGeometry because roadEdgeCount (${roadEdgeCount}) exceeds --validator-max-edges=${args.validatorMaxEdges}.`,
            coverageDefectCount: null,
            networkCoverageRatio: null,
            unexplainedMissingAreaM2: null,
            overlapDefectCount: null,
            overlapAreaM2: null,
            inconsistentElevationDefectCount: null,
            tinyDisconnectedFragmentCount: null,
            provenanceDefectCount: null,
            overallValid: null,
          };
        }

        const diag = parsedData.diagnostics;
        const skippedByTag = Object.entries(diag.skippedUnsupported?.byTag ?? {})
          .map(([tag, info]) => ({ tag, count: info.count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 12);

        const rejectedByReason: Record<string, number> = {};
        for (const [reason, info] of Object.entries(diag.rejectedInvalid?.byReason ?? {})) {
          rejectedByReason[reason] = info.count;
        }

        const sourceClassified = diag.sourceFeaturesClassified ?? diag.totalFeaturesParsed ?? 0;
        const sourceRendered = diag.sourceFeaturesRendered ?? builtScene.stats.renderedFeaturesCount;

        capturedCompleteness = {
          rawGeoJsonFeatures: diag.sourceFeaturesReceived ?? dataset.descriptor.geoJsonFeatureCount,
          sourceFeaturesClassified: sourceClassified,
          totalFeaturesParsed: diag.totalFeaturesParsed ?? 0,
          parsedFeaturePartsTotal: diag.parsedFeatureParts?.total ?? 0,
          parsedByCategory: {
            buildings: diag.parsedByCategory?.buildings ?? parsedData.buildings.length,
            roads: diag.parsedByCategory?.roads ?? parsedData.roads.length,
            railways: diag.parsedByCategory?.railways ?? parsedData.railways.length,
            waterBodies: diag.parsedByCategory?.waterBodies ?? parsedData.waterBodies.length,
            linearWaterways:
              diag.parsedByCategory?.linearWaterways ?? parsedData.linearWaterways.length,
            parks: diag.parsedByCategory?.parks ?? parsedData.parks.length,
            landuse: diag.parsedByCategory?.landuse ?? parsedData.landuse.length,
            barriers: diag.parsedByCategory?.barriers ?? parsedData.barriers.length,
            landmarks: diag.parsedByCategory?.landmarks ?? parsedData.landmarks.length,
          },
          exclusionsAndLineage: {
            skippedUnsupportedTotal: diag.skippedUnsupported?.total ?? 0,
            skippedUnsupportedTopTags: skippedByTag,
            clippedByBoundaryCount: diag.featuresClippedByBoundary?.clippedCount ?? 0,
            omittedOutsideBoundaryCount: diag.featuresClippedByBoundary?.omittedOutsideCount ?? 0,
            deduplicatedCount: diag.featureLineage?.deduplicatedCount ?? 0,
            chainedGroupsCount: diag.featureLineage?.chainedGroupsCount ?? 0,
            chainedFeaturesCount: diag.featureLineage?.chainedFeaturesCount ?? 0,
            featuresFullySubtractedCount: diag.featuresFullySubtracted?.count ?? 0,
            clippingFailuresCount: diag.clippingFailures?.count ?? 0,
            conflictingPlacementFallbacksCount: diag.conflictingPlacementFallbacks?.count ?? 0,
            rejectedInvalidTotal: diag.rejectedInvalid?.total ?? 0,
            rejectedInvalidByReason: rejectedByReason,
          },
          renderedCoverage: {
            sourceFeaturesRenderedCount: sourceRendered,
            coverageVsClassifiedRatio:
              sourceClassified > 0
                ? Number((sourceRendered / sourceClassified).toFixed(4))
                : 0,
            builtSceneRenderedFeaturesCount: builtScene.stats.renderedFeaturesCount,
            railwayRendererFallback: diag.railwayRendererFallback ?? null,
            unattributedMeshFacesCount: provAudit.unattributedMeshFacesCount,
            unattributedInstancedItemsCount: provAudit.unattributedInstancedItemsCount,
            invalidNanOrNonFiniteVertexCount: provAudit.invalidNanOrNonFiniteVertexCount,
          },
          topologyAudit: auditGraph
            ? {
                roadNodeCount: auditGraph.diagnostics.roadNodeCount,
                roadEdgeCount: auditGraph.diagnostics.roadEdgeCount,
                railwayNodeCount: auditGraph.diagnostics.railwayNodeCount,
                railwayEdgeCount: auditGraph.diagnostics.railwayEdgeCount,
                railwayConfirmedSwitchCount: auditGraph.diagnostics.railwayConfirmedSwitchCount,
                railwayUnresolvedSwitchCount: auditGraph.diagnostics.railwayUnresolvedSwitchCount,
                railwayFlatCrossingCount: auditGraph.diagnostics.railwayFlatCrossingCount,
                railwayUnresolvedJunctionCount: auditGraph.diagnostics.railwayUnresolvedJunctionCount,
                gradeTransitionCount: auditGraph.diagnostics.gradeTransitionCount,
                unresolvedGradeTransitionCount: auditGraph.diagnostics.unresolvedGradeTransitionCount,
                levelCrossingCount: auditGraph.diagnostics.levelCrossingCount,
                pedestrianRailCrossingCount: auditGraph.diagnostics.pedestrianRailCrossingCount,
                unresolvedCrossingCount: auditGraph.diagnostics.unresolvedCrossingCount,
                gradeSeparatedCrossingCount: auditGraph.diagnostics.gradeSeparatedCrossingCount,
                unresolvedInfrastructurePointsCount:
                  auditGraph.diagnostics.unresolvedInfrastructurePoints?.length ?? 0,
                descriptorValidationPassed: auditValidation?.isValid ?? true,
                descriptorValidationErrorCount: auditValidation?.errors.length ?? 0,
              }
            : null,
          geometryValidation: {
            graphMeshIntegrity: {
              status: 'executed',
              auditedMeshCount: meshAudit.auditedMeshCount,
              auditedTriangleCount: meshAudit.auditedTriangleCount,
              upwardTriangleCount: meshAudit.upwardTriangleCount,
              negativelyWoundCount: meshAudit.negativelyWoundCount,
              storedNormalMismatchCount: meshAudit.storedNormalMismatchCount,
              degenerateTriangleCount: meshAudit.degenerateTriangles.length,
              invalidPositionCount: provAudit.invalidNanOrNonFiniteVertexCount,
            },
            roadNetworkOverlapAndContinuity: roadOverlapAndContinuity,
            surfaceFirstValidation,
          },
          capturedWarnings: Array.from(capturedWarnings),
          };
        }
      }

      // 4. Scene Resource Disposal
      sendHeartbeat(`iter_${i + 1}_dispose`, startMs, peakRssBytes);
      const tDisp0 = performance.now();
      builtScene.dispose();
      disposeSamples.push(performance.now() - tDisp0);
      lastOwnedGeosAfterDispose = builtScene.resources.ownedGeometriesCount;
      lastOwnedMatsAfterDispose = builtScene.resources.ownedMaterialsCount;
      completedMeasuredIterations = i + 1;
      updatePeakRss();

      if (typeof process.send === 'function') {
        try {
          const partialMemSnapshot = process.memoryUsage();
          const partialPayload: ScalingIterationPartialPayload = {
            completedMeasuredIterations,
            timingsMs: buildTimingsBreakdown(),
            memory: buildMemoryMetrics(partialMemSnapshot),
            sceneGeometry: capturedSceneGeometry,
            operations: capturedOperations,
            unsupportedMetrics: [...unsupportedMetrics],
          };
          process.send({
            type: 'iteration_partial',
            partial: partialPayload,
          });
        } catch {
          // Ignore broken IPC pipe if parent already aborted
        }
      }
    }
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }

  tryTriggerGc();
  const memAfter = process.memoryUsage();
  updatePeakRss();

  const finalMemory = buildMemoryMetrics(memAfter);
  if (!finalMemory.lifecycleAudit.disposalVerified) {
    errors.push({
      phase: 'scene_resource_disposal',
      datasetId: dataset.descriptor.id,
      configId: rendererConfig.id,
      message: `SceneResourceManager leak detected: ownedGeos=${lastOwnedGeosAfterDispose}, ownedMats=${lastOwnedMatsAfterDispose}`,
    });
  }

  return {
    workloadKey,
    dataset: dataset.descriptor,
    rendererConfig,
    status: errors.length > 0 ? 'failed_error' : 'completed',
    statusReason:
      errors.length > 0
        ? errors.map((e) => e.message).join('; ')
        : 'Completed within resource and timeout bounds.',
    workerWallClockMs: Number((performance.now() - startMs).toFixed(2)),
    lastHeartbeatStage: 'completed',
    lastHeartbeatElapsedMs: Number((performance.now() - startMs).toFixed(1)),
    warmupIterations: args.warmupIterations,
    measuredIterations: args.measuredIterations,
    completedMeasuredIterations,
    timingsMs: buildTimingsBreakdown(),
    memory: finalMemory,
    sceneGeometry: capturedSceneGeometry,
    operations: capturedOperations,
    completenessAndCorrectness: capturedCompleteness,
    unsupportedMetrics,
    errors,
  };
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  try {
    const cli = parseScalingWorkerArgs(process.argv.slice(2));
    const result = executeScalingWorkerTask(cli);
    if (typeof process.send === 'function') {
      process.send({ type: 'result', result });
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    if (result.status !== 'completed') {
      process.exitCode = 1;
    }
  } catch (err: any) {
    const message = err?.message || String(err);
    if (typeof process.send === 'function') {
      process.send({
        type: 'error',
        error: {
          message,
          stack: err?.stack,
        },
      });
    } else {
      console.error(`scalingWorker failed: ${message}`);
    }
    process.exitCode = 1;
  }
}
