import type {
  InfrastructureRenderOptions,
  RailwayInfrastructureRenderSource,
  RoadInfrastructureRenderSource,
} from '../world/GeometryBuilder';

export const RAILWAY_VISIBILITY_SAMPLING_STRIDE = 4;

/**
 * Per-frame status of the WebGL2 EXT_disjoint_timer_query_webgl2 measurement.
 */
export type GpuTimerQueryStatus = 'valid' | 'pending' | 'disjoint' | 'unsupported';

/**
 * Aggregated scenario-level status of GPU hardware timing.
 */
export type GpuScenarioStatus = 'supported' | 'unsupported' | 'disjoint' | 'unavailable';

/**
 * Per-frame status of railway frustum-visibility telemetry.
 */
export type RailwayVisibilityStatus =
  | 'measured'
  | 'unsampled'
  | 'unavailable'
  | 'disabled_by_config';

/**
 * Scenario-level status of railway visibility collection.
 */
export type RailwayScenarioVisibilityStatus =
  | 'measured'
  | 'unavailable'
  | 'disabled_by_config';

export interface SceneRevisionConfigMeta {
  revision: number;
  datasetId: string;
  roadsMode: RoadInfrastructureRenderSource;
  railwaysMode: RailwayInfrastructureRenderSource;
  railwayPrototypeMode: string;
  themeId: string;
  hasFeatures: boolean;
  webglFramesRendered: number;
}

/**
 * Shared typed per-frame telemetry contract emitted post-gl.render() by MapScene.tsx
 * and consumed by benchmarks/browserRunner.ts.
 */
export interface BenchmarkFrameTelemetry {
  /** Monotonic high-resolution timestamp immediately after gl.render(scene, camera) finishes. */
  frameTimestampMs: number;
  /** Interval between consecutive requestAnimationFrame / useFrame ticks (for live HUD reference). */
  frameIntervalMs: number;
  /** Synchronous CPU wall-clock duration of gl.render(scene, camera) for this exact frame. */
  cpuRenderTimeMs: number;
  /** WebGL draw calls issued during this exact frame's gl.render(). */
  renderCalls: number;
  /** Rendered triangles submitted during this exact frame's gl.render(). */
  renderTriangles: number;
  /** Active WebGL driver geometry buffer count (gl.info.memory.geometries). */
  driverGeometries: number;
  /** Active WebGL driver texture count (gl.info.memory.textures). */
  driverTextures: number;
  /** Compiled WebGL shader program count (gl.info.programs.length). */
  driverPrograms: number;
  /** Active camera zoom at the time this frame rendered. */
  cameraZoom: number;
  /** Unmasked/masked WebGL GPU vendor string. */
  gpuVendor: string;
  /** Unmasked/masked WebGL GPU renderer string. */
  gpuRenderer: string;

  /** Whether EXT_disjoint_timer_query_webgl2 is supported on the active WebGL2 context. */
  gpuTimerQuerySupported: boolean;
  /** State of GPU timer query resolution for this frame. */
  gpuTimerStatus: GpuTimerQueryStatus;
  /** True if GPU_DISJOINT_EXT invalidated pending timer queries on this frame. */
  gpuDisjointOccurred: boolean;
  /** Resolved GPU duration in ms ONLY when gpuTimerStatus === 'valid'; null otherwise. */
  gpuPassTimeMs: number | null;

  /** Status of railway visibility sampling on this frame. */
  railwayVisibilityStatus: RailwayVisibilityStatus;
  /** Static count of railway meshes present in the committed scene (irrespective of frustum). */
  staticRailwayMeshes: number | null;
  /** Static rendered triangle count (including InstancedMesh counts) of committed railway meshes. */
  staticRailwayTriangles: number | null;
  /** LOD-active and frustum-visible railway meshes on sampled frames; null if unsampled/unavailable. */
  activeRailwayMeshes: number | null;
  /** LOD-active but frustum-culled railway meshes on sampled frames; null if unsampled/unavailable. */
  frustumCulledRailwayMeshes: number | null;
  /** Frustum-visible railway triangles (including InstancedMesh counts) on sampled frames; null if unsampled/unavailable. */
  frustumVisibleRailwayTriangles: number | null;
  /** Configured frame stride used for frustum visibility sampling. */
  railwayVisibilitySamplingStride: number;

  /** Scene revision stamped on the rendered BuiltSceneGeometry. */
  sceneRevision: number | null;
  /** Measured collector bookkeeping overhead for this frame in ms. */
  instrumentationOverheadMs: number;
}

export interface BenchmarkHarnessSnapshot {
  locationId: string;
  regionName?: string;
  prototypeMode: string;
  infrastructureRenderOptions: InfrastructureRenderOptions;
  themeId: string;
  sceneRevision: number | null;
  webglFramesRenderedForRevision: number;
  isSceneReady: boolean;
  constructedMeshesCount: number;
  sceneVertices: number;
  sceneTriangles: number;
  cpuBufferMB: number;
  liveWebGL: {
    gpuTimerQuerySupported?: boolean;
    gpuDisjointOccurred?: boolean;
    gpuPassTimeMs?: number | null;
    cpuRenderTimeMs?: number;
    renderCalls?: number;
    renderTriangles?: number;
    driverGeometries?: number;
    driverTextures?: number;
    driverPrograms?: number;
    gpuVendor?: string;
    gpuRenderer?: string;
  } | null;
}

export interface ExpectedSceneReadinessSpec {
  expectedRevision?: number;
  datasetId: string;
  roadsMode: RoadInfrastructureRenderSource;
  railwaysMode: RailwayInfrastructureRenderSource;
  railwayPrototypeMode: string;
  themeId?: string;
  expectNonEmptyScene: boolean;
  minWebglFramesRendered?: number;
}

/**
 * Pure GPU timer state transition resolver used by both WebGL producer and unit tests.
 * Never returns stale cached times when pending, disjoint, or unsupported.
 */
export function resolveGpuFrameTelemetryState(params: {
  supported: boolean;
  disjoint: boolean;
  resolvedNs: number | null;
}): {
  gpuTimerQuerySupported: boolean;
  gpuTimerStatus: GpuTimerQueryStatus;
  gpuPassTimeMs: number | null;
  gpuDisjointOccurred: boolean;
} {
  if (!params.supported) {
    return {
      gpuTimerQuerySupported: false,
      gpuTimerStatus: 'unsupported',
      gpuPassTimeMs: null,
      gpuDisjointOccurred: false,
    };
  }
  if (params.disjoint) {
    return {
      gpuTimerQuerySupported: true,
      gpuTimerStatus: 'disjoint',
      gpuPassTimeMs: null,
      gpuDisjointOccurred: true,
    };
  }
  if (
    typeof params.resolvedNs === 'number' &&
    Number.isFinite(params.resolvedNs) &&
    params.resolvedNs >= 0
  ) {
    return {
      gpuTimerQuerySupported: true,
      gpuTimerStatus: 'valid',
      gpuPassTimeMs: Number((params.resolvedNs / 1e6).toFixed(3)),
      gpuDisjointOccurred: false,
    };
  }
  return {
    gpuTimerQuerySupported: true,
    gpuTimerStatus: 'pending',
    gpuPassTimeMs: null,
    gpuDisjointOccurred: false,
  };
}

/**
 * Determines whether railway frustum-visibility evaluation should run on a given measured frame.
 * Always samples frame 0 and the final measured frame, plus every `stride`-th frame in between.
 */
export function shouldSampleRailwayVisibilityForFrame(
  frameIndex: number,
  totalMeasuredFrames: number,
  stride: number = RAILWAY_VISIBILITY_SAMPLING_STRIDE
): boolean {
  const normalizedStride = Math.max(1, Math.floor(stride));
  if (frameIndex <= 0) return true;
  if (totalMeasuredFrames > 0 && frameIndex >= totalMeasuredFrames - 1) return true;
  return frameIndex % normalizedStride === 0;
}

/**
 * Computes consecutive completed WebGL frame intervals (ms) from post-gl.render() timestamps.
 * Expects `timestampsMs` to include an anchor timestamp (e.g., last warmup frame) followed by
 * M measured frame completion timestamps, returning M intervals.
 */
export function computeConsecutiveFrameIntervalsMs(
  timestampsMs: readonly number[]
): number[] {
  if (timestampsMs.length < 2) return [];
  const intervals: number[] = [];
  for (let i = 1; i < timestampsMs.length; i++) {
    const dt = timestampsMs[i] - timestampsMs[i - 1];
    intervals.push(Number(Math.max(0, dt).toFixed(3)));
  }
  return intervals;
}

/**
 * Validates that a harness snapshot genuinely reflects the requested dataset, renderer config,
 * committed WebGL frame, and non-idle scene geometry before scenario measurement starts.
 */
export function validateSceneReadinessSnapshot(
  snapshot: BenchmarkHarnessSnapshot | null | undefined,
  expected: ExpectedSceneReadinessSpec
): { ready: boolean; reason?: string } {
  if (!snapshot) {
    return { ready: false, reason: 'Snapshot is null or undefined.' };
  }
  if (snapshot.locationId !== expected.datasetId) {
    return {
      ready: false,
      reason: `Dataset mismatch: expected "${expected.datasetId}", got "${snapshot.locationId}".`,
    };
  }
  if (snapshot.infrastructureRenderOptions?.roads !== expected.roadsMode) {
    return {
      ready: false,
      reason: `Roads render mode mismatch: expected "${expected.roadsMode}", got "${snapshot.infrastructureRenderOptions?.roads}".`,
    };
  }
  if (snapshot.infrastructureRenderOptions?.railways !== expected.railwaysMode) {
    return {
      ready: false,
      reason: `Railways render mode mismatch: expected "${expected.railwaysMode}", got "${snapshot.infrastructureRenderOptions?.railways}".`,
    };
  }
  if (snapshot.prototypeMode !== expected.railwayPrototypeMode) {
    return {
      ready: false,
      reason: `Prototype mode mismatch: expected "${expected.railwayPrototypeMode}", got "${snapshot.prototypeMode}".`,
    };
  }
  if (expected.themeId && snapshot.themeId !== expected.themeId) {
    return {
      ready: false,
      reason: `Theme mismatch: expected "${expected.themeId}", got "${snapshot.themeId}".`,
    };
  }
  if (
    typeof expected.expectedRevision === 'number' &&
    snapshot.sceneRevision !== expected.expectedRevision
  ) {
    return {
      ready: false,
      reason: `Scene revision mismatch: expected ${expected.expectedRevision}, got ${String(snapshot.sceneRevision)}.`,
    };
  }
  const minFrames = expected.minWebglFramesRendered ?? 1;
  if ((snapshot.webglFramesRenderedForRevision ?? 0) < minFrames) {
    return {
      ready: false,
      reason: `Expected >= ${minFrames} committed WebGL render frame(s) for revision ${String(snapshot.sceneRevision)}, got ${snapshot.webglFramesRenderedForRevision ?? 0}.`,
    };
  }
  if (!snapshot.isSceneReady) {
    return { ready: false, reason: 'Harness reports isSceneReady === false.' };
  }
  if (expected.expectNonEmptyScene) {
    if (
      snapshot.constructedMeshesCount <= 1 ||
      snapshot.sceneVertices <= 4 ||
      snapshot.sceneTriangles <= 2
    ) {
      return {
        ready: false,
        reason: `Scene appears to reflect idle ground-only geometry (meshes=${snapshot.constructedMeshesCount}, verts=${snapshot.sceneVertices}, tris=${snapshot.sceneTriangles}) for non-empty dataset "${expected.datasetId}".`,
      };
    }
  }
  return { ready: true };
}
