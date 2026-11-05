import * as THREE from 'three';
import { MapStyleTheme, ProcessedMapData } from '../../types/MapFeature';
import { BuiltSceneGeometry, GeometryBuilder } from '../GeometryBuilder';
import {
  buildRailwayPrototypeGroup,
  BuildRailwayPrototypeOptions,
  RailwayBuildProfile,
  RailwayPrototypeMode,
} from './RailwayPrototypeBuilder';

export interface GroupGeometryStats {
  meshCount: number;
  visibleMeshCount: number;
  vertices: number;
  triangles: number;
  renderedVerticesWithInstances: number;
  renderedTrianglesWithInstances: number;
  visibleRenderedTriangles: number;
  cpuBufferBytes: number;
}

export interface CpuBenchmarkReport {
  datasetName: string;
  mode: RailwayPrototypeMode;
  buildTimeMs: number;
  nonRailwayBuildTimeMs: number;
  railwayBuildTimeMs: number;
  constructedMeshesCount: number;
  totalVertices: number;
  totalTriangles: number;
  renderedVerticesWithInstances: number;
  renderedTrianglesWithInstances: number;
  cpuBufferBytes: number;
  cpuBufferMB: number;
  railwayGroupStats: GroupGeometryStats;
  roadsGroupStats: GroupGeometryStats;
  buildingsGroupStats: GroupGeometryStats;
  railwayProfile?: RailwayBuildProfile;
  lifecycleAudit: {
    warmedUpOwnedGeometriesAfterDispose: number;
    warmedUpOwnedMaterialsAfterDispose: number;
    cyclesTested: number;
    netLeakedGeometriesAfterCycles: number;
    netLeakedMaterialsAfterCycles: number;
  };
}

export interface LiveWebGLTelemetrySnapshot {
  fps: number;
  frameIntervalMs: number;
  medianFrameIntervalMs?: number;
  p95FrameIntervalMs?: number;
  p99FrameIntervalMs?: number;
  minFps?: number;
  maxFps?: number;
  spikesOver33msCount?: number;
  spikesOver50msCount?: number;
  maxSpikeDurationMs?: number;
  gpuTimerQuerySupported: boolean;
  gpuDisjointOccurred?: boolean;
  gpuPassTimeMs: number | null;
  renderCalls: number;
  renderTriangles: number;
  activeRailwayMeshes?: number;
  activeFrustumCulledRailwayMeshes?: number;
  activeFrustumVisibleRailwayTriangles?: number;
  hoverRaycastTimeMs?: number;
  driverGeometries: number;
  driverTextures: number;
  cameraZoom: number;
  gpuVendor?: string;
  gpuRenderer?: string;
  cameraFrustum?: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
  };
}

function isObjectAndAncestorsVisible(obj: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

/**
 * Computes static geometry statistics (mesh count, vertex count, triangle count, instanced triangle count,
 * and CPU TypedArray bytes) for any Three.js Group.
 */
export function computeGroupGeometryStats(group: THREE.Group): GroupGeometryStats {
  let meshCount = 0;
  let visibleMeshCount = 0;
  let vertices = 0;
  let triangles = 0;
  let renderedVerticesWithInstances = 0;
  let renderedTrianglesWithInstances = 0;
  let visibleRenderedTriangles = 0;
  let cpuBufferBytes = 0;
  const visitedGeos = new Set<THREE.BufferGeometry>();

  group.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      meshCount++;
      const isVis = isObjectAndAncestorsVisible(child);
      if (isVis) visibleMeshCount++;

      const mesh = child as THREE.Mesh;
      const isInst = (mesh as unknown as THREE.InstancedMesh).isInstancedMesh === true;
      const instMesh = mesh as unknown as THREE.InstancedMesh;
      const instCount = isInst ? Math.max(0, instMesh.count || 0) : 1;

      if (isInst && instMesh.instanceMatrix?.array) {
        cpuBufferBytes += instMesh.instanceMatrix.array.byteLength;
      }

      const geo = mesh.geometry;
      if (geo) {
        const pos = geo.attributes.position;
        const geoVerts = pos ? pos.count : 0;
        const geoTris = geo.index
          ? Math.round(geo.index.count / 3)
          : pos
            ? Math.round(pos.count / 3)
            : 0;

        renderedVerticesWithInstances += geoVerts * instCount;
        renderedTrianglesWithInstances += geoTris * instCount;
        if (isVis) {
          visibleRenderedTriangles += geoTris * instCount;
        }

        if (!visitedGeos.has(geo)) {
          visitedGeos.add(geo);
          vertices += geoVerts;
          triangles += geoTris;
          for (const attrKey of Object.keys(geo.attributes)) {
            const attr = geo.attributes[attrKey];
            if (attr?.array && typeof attr.array.byteLength === 'number') {
              cpuBufferBytes += attr.array.byteLength;
            }
          }
          if (geo.index?.array && typeof geo.index.array.byteLength === 'number') {
            cpuBufferBytes += geo.index.array.byteLength;
          }
        }
      }
    }
  });

  return {
    meshCount,
    visibleMeshCount,
    vertices,
    triangles,
    renderedVerticesWithInstances,
    renderedTrianglesWithInstances,
    visibleRenderedTriangles,
    cpuBufferBytes,
  };
}

/**
 * Runs a reproducible CPU & memory benchmark + warmed-up resource lifecycle audit for a dataset and mode.
 * Supports the 4 active benchmark configurations:
 * - `'disabled'`: Non-railway map only (`railways: []`), isolating the baseline cost of the rest of the map.
 * - `'production'`: Current production scene pipeline with the integrated Candidate B hybrid railway renderer.
 * - `'candidateA'`: Non-railway map + Candidate A pure procedural UV railway ribbons.
 * - `'candidateB'`: Non-railway map + Candidate B hybrid 3D close-zoom + procedural railway renderer.
 *
 * Note: Historical Goalpost 1 `'baseline'` measurements cannot be dynamically regenerated because the
 * available project source and git history do not contain the superseded Goalpost 1 railway implementation.
 * Historical Goalpost 1 baseline measurements are preserved as frozen evidence in `docs/m2-1-baseline-data.json`.
 */
export function runCpuAndLifecycleBenchmark(
  data: ProcessedMapData,
  theme: MapStyleTheme,
  mode: RailwayPrototypeMode = 'production',
  reloadCycles: number = 5,
  prototypeOptions?: BuildRailwayPrototypeOptions
): CpuBenchmarkReport {
  if ((mode as string) === 'baseline') {
    throw new Error(
      "The 'baseline' benchmark mode represents the historical Goalpost 1 renderer. " +
      "The available project source and git history do not contain the superseded Goalpost 1 railway implementation, " +
      "so historical Goalpost 1 baseline measurements cannot be dynamically regenerated. " +
      "Frozen historical baseline data is preserved in 'docs/m2-1-baseline-data.json'. " +
      "Use mode: 'production' to benchmark the current Candidate B production renderer."
    );
  }

  const builder = new GeometryBuilder();
  const nonRailData: ProcessedMapData = {
    ...data,
    railways: [],
    diagnostics: data.diagnostics ? { ...data.diagnostics } : undefined,
  };

  // 1. Warmup cycle (establishes warmed-up baseline and verifies clean disposal)
  const warmupScene = builder.buildScene(mode === 'production' ? data : nonRailData, theme);
  warmupScene.dispose();
  const warmedUpOwnedGeometriesAfterDispose = warmupScene.resources.ownedGeometriesCount;
  const warmedUpOwnedMaterialsAfterDispose = warmupScene.resources.ownedMaterialsCount;

  // 2. N reload cycles to verify zero cumulative resource leaks relative to warmed-up baseline
  let lastDisposedScene: BuiltSceneGeometry | null = null;
  for (let c = 0; c < reloadCycles; c++) {
    const cycleScene = builder.buildScene(mode === 'production' ? data : nonRailData, theme);
    if (mode === 'candidateA' || mode === 'candidateB') {
      const proto = buildRailwayPrototypeGroup(data, theme, mode, 8.0, prototypeOptions);
      proto.dispose();
    }
    cycleScene.dispose();
    lastDisposedScene = cycleScene;
  }

  const netLeakedGeometriesAfterCycles =
    (lastDisposedScene?.resources.ownedGeometriesCount ?? 0) -
    warmedUpOwnedGeometriesAfterDispose;
  const netLeakedMaterialsAfterCycles =
    (lastDisposedScene?.resources.ownedMaterialsCount ?? 0) -
    warmedUpOwnedMaterialsAfterDispose;

  // 3. Timed measurement run
  if (mode === 'disabled') {
    const t0 = performance.now();
    const scene = builder.buildScene(nonRailData, theme);
    const nonRailwayBuildTimeMs = Number((performance.now() - t0).toFixed(2));
    const railStats = computeGroupGeometryStats(scene.railwaysGroup);
    const roadsGroupStats = computeGroupGeometryStats(scene.roadsGroup);
    const buildingsGroupStats = computeGroupGeometryStats(scene.buildingsGroup);
    const baseMem = scene.resources.getCpuBufferMemoryStats();

    const report: CpuBenchmarkReport = {
      datasetName: data.regionName,
      mode: 'disabled',
      buildTimeMs: nonRailwayBuildTimeMs,
      nonRailwayBuildTimeMs,
      railwayBuildTimeMs: 0,
      constructedMeshesCount: scene.stats.totalDrawCalls,
      totalVertices: scene.stats.totalVertices,
      totalTriangles: scene.stats.totalTriangles,
      renderedVerticesWithInstances: scene.stats.totalVertices,
      renderedTrianglesWithInstances: scene.stats.totalTriangles,
      cpuBufferBytes: baseMem.totalBytes,
      cpuBufferMB: baseMem.totalMB,
      railwayGroupStats: railStats,
      roadsGroupStats,
      buildingsGroupStats,
      lifecycleAudit: {
        warmedUpOwnedGeometriesAfterDispose,
        warmedUpOwnedMaterialsAfterDispose,
        cyclesTested: reloadCycles,
        netLeakedGeometriesAfterCycles,
        netLeakedMaterialsAfterCycles,
      },
    };
    scene.dispose();
    return report;
  }

  if (mode === 'production') {
    const tStart = performance.now();
    const scene = builder.buildScene(data, theme);
    const buildTimeMs = Number((performance.now() - tStart).toFixed(2));

    const railOnlyData: ProcessedMapData = {
      ...data,
      buildings: [],
      roads: [],
      waterBodies: [],
      water: [],
      linearWaterways: [],
      parks: [],
      landuse: [],
      barriers: [],
      landmarks: [],
      diagnostics: data.diagnostics ? { ...data.diagnostics } : undefined,
    };
    const tRail0 = performance.now();
    const railOnlyScene = builder.buildScene(railOnlyData, theme);
    const railwayBuildTimeMs = Number((performance.now() - tRail0).toFixed(2));
    railOnlyScene.dispose();

    const railwayGroupStats = computeGroupGeometryStats(scene.railwaysGroup);
    const roadsGroupStats = computeGroupGeometryStats(scene.roadsGroup);
    const buildingsGroupStats = computeGroupGeometryStats(scene.buildingsGroup);
    const baseMem = scene.resources.getCpuBufferMemoryStats();

    const report: CpuBenchmarkReport = {
      datasetName: data.regionName,
      mode: 'production',
      buildTimeMs,
      nonRailwayBuildTimeMs: Number(Math.max(0, buildTimeMs - railwayBuildTimeMs).toFixed(2)),
      railwayBuildTimeMs,
      constructedMeshesCount: scene.stats.totalDrawCalls,
      totalVertices: scene.stats.totalVertices,
      totalTriangles: scene.stats.totalTriangles,
      renderedVerticesWithInstances: scene.stats.totalVertices,
      renderedTrianglesWithInstances: scene.stats.totalTriangles,
      cpuBufferBytes: baseMem.totalBytes,
      cpuBufferMB: baseMem.totalMB,
      railwayGroupStats,
      roadsGroupStats,
      buildingsGroupStats,
      lifecycleAudit: {
        warmedUpOwnedGeometriesAfterDispose,
        warmedUpOwnedMaterialsAfterDispose,
        cyclesTested: reloadCycles,
        netLeakedGeometriesAfterCycles,
        netLeakedMaterialsAfterCycles,
      },
    };
    scene.dispose();
    return report;
  }

  // Prototype mode (Candidate A or Candidate B): build non-railway base scene + isolated prototype railway group
  const tNonRail0 = performance.now();
  const nonRailScene = builder.buildScene(nonRailData, theme);
  const nonRailwayBuildTimeMs = Number((performance.now() - tNonRail0).toFixed(2));

  const proto = buildRailwayPrototypeGroup(data, theme, mode, 8.0, prototypeOptions);
  const protoRailStats = computeGroupGeometryStats(proto.railwaysGroup);
  const roadsGroupStats = computeGroupGeometryStats(nonRailScene.roadsGroup);
  const buildingsGroupStats = computeGroupGeometryStats(nonRailScene.buildingsGroup);
  const nonRailMem = nonRailScene.resources.getCpuBufferMemoryStats();

  const totalBytes = nonRailMem.totalBytes + proto.stats.cpuBufferBytes;

  const report: CpuBenchmarkReport = {
    datasetName: data.regionName,
    mode,
    buildTimeMs: Number((nonRailwayBuildTimeMs + proto.stats.buildTimeMs).toFixed(2)),
    nonRailwayBuildTimeMs,
    railwayBuildTimeMs: proto.stats.buildTimeMs,
    constructedMeshesCount: nonRailScene.stats.totalDrawCalls + proto.stats.drawCalls,
    totalVertices: nonRailScene.stats.totalVertices + proto.stats.totalVertices,
    totalTriangles: nonRailScene.stats.totalTriangles + proto.stats.totalTriangles,
    renderedVerticesWithInstances:
      nonRailScene.stats.totalVertices + proto.stats.renderedVerticesWithInstances,
    renderedTrianglesWithInstances:
      nonRailScene.stats.totalTriangles + proto.stats.renderedTrianglesWithInstances,
    cpuBufferBytes: totalBytes,
    cpuBufferMB: Number((totalBytes / (1024 * 1024)).toFixed(3)),
    railwayGroupStats: protoRailStats,
    roadsGroupStats,
    buildingsGroupStats,
    railwayProfile: proto.profile,
    lifecycleAudit: {
      warmedUpOwnedGeometriesAfterDispose,
      warmedUpOwnedMaterialsAfterDispose,
      cyclesTested: reloadCycles,
      netLeakedGeometriesAfterCycles,
      netLeakedMaterialsAfterCycles,
    },
  };

  proto.dispose();
  nonRailScene.dispose();
  return report;
}

