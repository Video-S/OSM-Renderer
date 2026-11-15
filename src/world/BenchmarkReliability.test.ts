import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as THREE from 'three';
import {
  BROWSER_BENCHMARK_SCENARIOS,
  buildLocalServerSpawnSpec,
  buildScenarioResult,
  parseBrowserRunnerCliArgs,
  parseCpuRunnerCliArgs,
  resolveChromiumLaunchArgs,
  resolveGitState,
  resolveTsxCliPath,
  type RawScenarioBrowserPayload,
} from '../../benchmarks/index';
import {
  computeConsecutiveFrameIntervalsMs,
  RAILWAY_VISIBILITY_SAMPLING_STRIDE,
  resolveGpuFrameTelemetryState,
  shouldSampleRailwayVisibilityForFrame,
  validateSceneReadinessSnapshot,
  type BenchmarkFrameTelemetry,
  type BenchmarkHarnessSnapshot,
} from '../types/BenchmarkTelemetry';
import {
  buildCachedRailwayIndex,
  evaluateCachedRailwayVisibility,
} from './prototype/BenchmarkRailwayTelemetry';

function makeFrameTelemetry(
  overrides: Partial<BenchmarkFrameTelemetry> = {}
): BenchmarkFrameTelemetry {
  return {
    frameTimestampMs: 1000,
    frameIntervalMs: 16.667,
    cpuRenderTimeMs: 1.25,
    renderCalls: 42,
    renderTriangles: 12000,
    driverGeometries: 18,
    driverTextures: 4,
    driverPrograms: 5,
    cameraZoom: 1.0,
    gpuVendor: 'NVIDIA Corporation',
    gpuRenderer: 'NVIDIA GeForce RTX 4060 Ti',
    gpuTimerQuerySupported: true,
    gpuTimerStatus: 'valid',
    gpuDisjointOccurred: false,
    gpuPassTimeMs: 0.85,
    railwayVisibilityStatus: 'measured',
    staticRailwayMeshes: 12,
    staticRailwayTriangles: 4800,
    activeRailwayMeshes: 8,
    frustumCulledRailwayMeshes: 4,
    frustumVisibleRailwayTriangles: 3200,
    railwayVisibilitySamplingStride: RAILWAY_VISIBILITY_SAMPLING_STRIDE,
    sceneRevision: 3,
    instrumentationOverheadMs: 0.04,
    ...overrides,
  };
}

function makeReadySnapshot(
  overrides: Partial<BenchmarkHarnessSnapshot> = {}
): BenchmarkHarnessSnapshot {
  return {
    locationId: 'synthetic-stress-urban-switchyard',
    regionName: 'Synthetic Stress Urban Switchyard',
    prototypeMode: 'production',
    infrastructureRenderOptions: {
      roads: 'legacy',
      railways: 'legacy',
    },
    themeId: 'tactical',
    sceneRevision: 3,
    webglFramesRenderedForRevision: 2,
    isSceneReady: true,
    constructedMeshesCount: 15,
    sceneVertices: 24500,
    sceneTriangles: 18901,
    cpuBufferMB: 2.35,
    liveWebGL: {
      gpuTimerQuerySupported: true,
      gpuDisjointOccurred: false,
      gpuPassTimeMs: 0.72,
      cpuRenderTimeMs: 1.15,
      renderCalls: 193,
      renderTriangles: 18901,
      driverGeometries: 25,
      driverTextures: 4,
      driverPrograms: 6,
      gpuVendor: 'NVIDIA Corporation',
      gpuRenderer: 'NVIDIA GeForce RTX 4060 Ti',
    },
    ...overrides,
  };
}

describe('TKT-017: Benchmark Infrastructure Reliability & Windows Compatibility', () => {
  describe('1. Telemetry Producer / Consumer Field Compatibility', () => {
    it('consumes canonical gpuPassTimeMs, gpuTimerQuerySupported, gpuDisjointOccurred and railway fields from MapScene contract', () => {
      const staticOverview = BROWSER_BENCHMARK_SCENARIOS.find(
        (s) => s.id === 'static_overview'
      )!;

      const raw: RawScenarioBrowserPayload = {
        scenarioId: 'static_overview',
        warmupFrames: 2,
        measuredFrames: 4,
        anchorTimestampMs: 1000,
        samples: [
          makeFrameTelemetry({
            frameTimestampMs: 1016,
            gpuTimerQuerySupported: true,
            gpuTimerStatus: 'valid',
            gpuDisjointOccurred: false,
            gpuPassTimeMs: 1.4,
            railwayVisibilityStatus: 'measured',
            staticRailwayMeshes: 10,
            staticRailwayTriangles: 4200,
            activeRailwayMeshes: 6,
            frustumCulledRailwayMeshes: 4,
            frustumVisibleRailwayTriangles: 2600,
          }),
          makeFrameTelemetry({
            frameTimestampMs: 1032,
            gpuTimerQuerySupported: true,
            gpuTimerStatus: 'pending',
            gpuDisjointOccurred: false,
            gpuPassTimeMs: null,
            railwayVisibilityStatus: 'unsampled',
            staticRailwayMeshes: 10,
            staticRailwayTriangles: 4200,
            activeRailwayMeshes: null,
            frustumCulledRailwayMeshes: null,
            frustumVisibleRailwayTriangles: null,
          }),
          makeFrameTelemetry({
            frameTimestampMs: 1048,
            gpuTimerQuerySupported: true,
            gpuTimerStatus: 'valid',
            gpuDisjointOccurred: false,
            gpuPassTimeMs: 1.8,
            railwayVisibilityStatus: 'unsampled',
            staticRailwayMeshes: 10,
            staticRailwayTriangles: 4200,
            activeRailwayMeshes: null,
            frustumCulledRailwayMeshes: null,
            frustumVisibleRailwayTriangles: null,
          }),
          makeFrameTelemetry({
            frameTimestampMs: 1064,
            gpuTimerQuerySupported: true,
            gpuTimerStatus: 'valid',
            gpuDisjointOccurred: false,
            gpuPassTimeMs: 2.0,
            railwayVisibilityStatus: 'measured',
            staticRailwayMeshes: 10,
            staticRailwayTriangles: 4200,
            activeRailwayMeshes: 8,
            frustumCulledRailwayMeshes: 2,
            frustumVisibleRailwayTriangles: 3400,
          }),
        ],
        browserMemoryMB: {
          supported: true,
          usedJSHeapSizeMB: 48.5,
          totalJSHeapSizeMB: 64.0,
          jsHeapSizeLimitMB: 2048.0,
        },
      };

      const { result, gpuUnsupportedNotice, railwayUnavailableNotice } = buildScenarioResult(
        staticOverview,
        raw
      );

      assert.equal(gpuUnsupportedNotice, null);
      assert.equal(railwayUnavailableNotice, null);
      assert.equal(result.gpuFrameRenderTimeMs.status, 'supported');
      assert.equal(result.gpuFrameRenderTimeMs.statistics?.sampleCount, 3);
      assert.equal(result.gpuFrameRenderTimeMs.statistics?.median, 1.8);
      assert.deepEqual(result.gpuFrameRenderTimeMs.sampleCounts, {
        totalFrames: 4,
        valid: 3,
        pending: 1,
        disjoint: 0,
        unsupported: 0,
      });

      assert.equal(result.webglResources.staticRailwayMeshes, 10);
      assert.equal(result.webglResources.staticRailwayTriangles, 4200);
      assert.equal(result.webglResources.railwayVisibilityStatus, 'measured');
      assert.equal(result.webglResources.railwayVisibilitySampledFrames, 2);
      assert.equal(result.webglResources.activeRailwayMeshes, 7);
      assert.equal(result.webglResources.frustumCulledRailwayMeshes, 3);
      assert.equal(result.webglResources.frustumVisibleRailwayTriangles, 3000);
    });
  });

  describe('2. GPU Timer Query State Machine & Aggregation', () => {
    it('distinguishes unsupported, pending, disjoint, and valid (including 0 ms) without caching stale times or substituting CPU time', () => {
      const unsupported = resolveGpuFrameTelemetryState({
        supported: false,
        disjoint: false,
        resolvedNs: 1_500_000,
      });
      assert.deepEqual(unsupported, {
        gpuTimerQuerySupported: false,
        gpuTimerStatus: 'unsupported',
        gpuPassTimeMs: null,
        gpuDisjointOccurred: false,
      });

      const disjoint = resolveGpuFrameTelemetryState({
        supported: true,
        disjoint: true,
        resolvedNs: 2_500_000,
      });
      assert.deepEqual(disjoint, {
        gpuTimerQuerySupported: true,
        gpuTimerStatus: 'disjoint',
        gpuPassTimeMs: null,
        gpuDisjointOccurred: true,
      });

      const pending = resolveGpuFrameTelemetryState({
        supported: true,
        disjoint: false,
        resolvedNs: null,
      });
      assert.deepEqual(pending, {
        gpuTimerQuerySupported: true,
        gpuTimerStatus: 'pending',
        gpuPassTimeMs: null,
        gpuDisjointOccurred: false,
      });

      // Zero nanoseconds on trivial frame must remain valid 0 ms, not treated as missing
      const validZero = resolveGpuFrameTelemetryState({
        supported: true,
        disjoint: false,
        resolvedNs: 0,
      });
      assert.deepEqual(validZero, {
        gpuTimerQuerySupported: true,
        gpuTimerStatus: 'valid',
        gpuPassTimeMs: 0,
        gpuDisjointOccurred: false,
      });

      const validNonZero = resolveGpuFrameTelemetryState({
        supported: true,
        disjoint: false,
        resolvedNs: 1_234_567,
      });
      assert.deepEqual(validNonZero, {
        gpuTimerQuerySupported: true,
        gpuTimerStatus: 'valid',
        gpuPassTimeMs: 1.235,
        gpuDisjointOccurred: false,
      });
    });

    it('reports disjoint, unavailable, and unsupported GPU scenario statuses honestly with null statistics', () => {
      const spec = BROWSER_BENCHMARK_SCENARIOS[0];
      const mem = {
        supported: false,
        usedJSHeapSizeMB: null,
        totalJSHeapSizeMB: null,
        jsHeapSizeLimitMB: null,
      };

      // All unsupported -> status 'unsupported', statistics null
      const unsupRes = buildScenarioResult(spec, {
        scenarioId: 'static_overview',
        warmupFrames: 1,
        measuredFrames: 2,
        anchorTimestampMs: 100,
        samples: [
          makeFrameTelemetry({
            cpuRenderTimeMs: 44.4,
            gpuTimerQuerySupported: false,
            gpuTimerStatus: 'unsupported',
            gpuPassTimeMs: null,
          }),
          makeFrameTelemetry({
            cpuRenderTimeMs: 55.5,
            gpuTimerQuerySupported: false,
            gpuTimerStatus: 'unsupported',
            gpuPassTimeMs: null,
          }),
        ],
        browserMemoryMB: mem,
      });
      assert.equal(unsupRes.result.gpuFrameRenderTimeMs.status, 'unsupported');
      assert.equal(unsupRes.result.gpuFrameRenderTimeMs.statistics, null);
      assert.ok(unsupRes.gpuUnsupportedNotice);

      // Extension supported, all frames still pending -> status 'unavailable', statistics null
      const pendingRes = buildScenarioResult(spec, {
        scenarioId: 'static_overview',
        warmupFrames: 1,
        measuredFrames: 2,
        anchorTimestampMs: 100,
        samples: [
          makeFrameTelemetry({
            cpuRenderTimeMs: 12.3,
            gpuTimerQuerySupported: true,
            gpuTimerStatus: 'pending',
            gpuPassTimeMs: null,
          }),
        ],
        browserMemoryMB: mem,
      });
      assert.equal(pendingRes.result.gpuFrameRenderTimeMs.status, 'unavailable');
      assert.equal(pendingRes.result.gpuFrameRenderTimeMs.statistics, null);

      // Disjoint with zero valid samples -> status 'disjoint', statistics null
      const disjointRes = buildScenarioResult(spec, {
        scenarioId: 'static_overview',
        warmupFrames: 1,
        measuredFrames: 1,
        anchorTimestampMs: 100,
        samples: [
          makeFrameTelemetry({
            cpuRenderTimeMs: 9.9,
            gpuTimerQuerySupported: true,
            gpuTimerStatus: 'disjoint',
            gpuDisjointOccurred: true,
            gpuPassTimeMs: null,
          }),
        ],
        browserMemoryMB: mem,
      });
      assert.equal(disjointRes.result.gpuFrameRenderTimeMs.status, 'disjoint');
      assert.equal(disjointRes.result.gpuFrameRenderTimeMs.statistics, null);
    });
  });

  describe('3. Scene Initialization & Snapshot Readiness Validation', () => {
    it('accepts a ready non-empty committed WebGL scene and rejects unrendered or idle ground-only geometry', () => {
      const valid = validateSceneReadinessSnapshot(makeReadySnapshot(), {
        expectedRevision: 3,
        datasetId: 'synthetic-stress-urban-switchyard',
        roadsMode: 'legacy',
        railwaysMode: 'legacy',
        railwayPrototypeMode: 'production',
        themeId: 'tactical',
        expectNonEmptyScene: true,
        minWebglFramesRendered: 1,
      });
      assert.equal(valid.ready, true);

      // Exact TKT-017 regression: stale {1, 4, 2} idle ground-only snapshot for a non-empty dataset
      const idleGroundOnly = validateSceneReadinessSnapshot(
        makeReadySnapshot({
          constructedMeshesCount: 1,
          sceneVertices: 4,
          sceneTriangles: 2,
          cpuBufferMB: 0,
        }),
        {
          expectedRevision: 3,
          datasetId: 'synthetic-stress-urban-switchyard',
          roadsMode: 'legacy',
          railwaysMode: 'legacy',
          railwayPrototypeMode: 'production',
          expectNonEmptyScene: true,
        }
      );
      assert.equal(idleGroundOnly.ready, false);
      assert.match(idleGroundOnly.reason || '', /idle ground-only geometry/i);

      // Unrendered revision (0 WebGL frames committed) must fail readiness
      const unrendered = validateSceneReadinessSnapshot(
        makeReadySnapshot({ webglFramesRenderedForRevision: 0 }),
        {
          expectedRevision: 3,
          datasetId: 'synthetic-stress-urban-switchyard',
          roadsMode: 'legacy',
          railwaysMode: 'legacy',
          railwayPrototypeMode: 'production',
          expectNonEmptyScene: true,
          minWebglFramesRendered: 1,
        }
      );
      assert.equal(unrendered.ready, false);
      assert.match(unrendered.reason || '', /committed WebGL render frame/i);

      // Explicitly empty dataset allows ground-only mesh when committed and ready
      const validEmpty = validateSceneReadinessSnapshot(
        makeReadySnapshot({
          constructedMeshesCount: 1,
          sceneVertices: 4,
          sceneTriangles: 2,
        }),
        {
          expectedRevision: 3,
          datasetId: 'synthetic-stress-urban-switchyard',
          roadsMode: 'legacy',
          railwaysMode: 'legacy',
          railwayPrototypeMode: 'production',
          expectNonEmptyScene: false,
        }
      );
      assert.equal(validEmpty.ready, true);
    });
  });

  describe('4. Stale Snapshot Rejection Across Dataset & Config Transitions', () => {
    it('rejects snapshots from previous datasets, renderer configs, themes, or scene revisions', () => {
      const legacySmallSnap = makeReadySnapshot({
        locationId: 'small-real-europatunnel',
        sceneRevision: 2,
        infrastructureRenderOptions: { roads: 'legacy', railways: 'legacy' },
        themeId: 'tactical',
      });

      const datasetMismatch = validateSceneReadinessSnapshot(legacySmallSnap, {
        expectedRevision: 3,
        datasetId: 'synthetic-stress-urban-switchyard',
        roadsMode: 'legacy',
        railwaysMode: 'legacy',
        railwayPrototypeMode: 'production',
        expectNonEmptyScene: true,
      });
      assert.equal(datasetMismatch.ready, false);
      assert.match(datasetMismatch.reason || '', /Dataset mismatch/);

      const configTransitionMismatch = validateSceneReadinessSnapshot(legacySmallSnap, {
        expectedRevision: 2,
        datasetId: 'small-real-europatunnel',
        roadsMode: 'graph-surface',
        railwaysMode: 'graph-R+',
        railwayPrototypeMode: 'production',
        expectNonEmptyScene: true,
      });
      assert.equal(configTransitionMismatch.ready, false);
      assert.match(configTransitionMismatch.reason || '', /Roads render mode mismatch/);

      const railwaysTransitionMismatch = validateSceneReadinessSnapshot(
        makeReadySnapshot({
          locationId: 'small-real-europatunnel',
          sceneRevision: 2,
          infrastructureRenderOptions: { roads: 'graph-surface', railways: 'legacy' },
        }),
        {
          expectedRevision: 2,
          datasetId: 'small-real-europatunnel',
          roadsMode: 'graph-surface',
          railwaysMode: 'graph-R+',
          railwayPrototypeMode: 'production',
          expectNonEmptyScene: true,
        }
      );
      assert.equal(railwaysTransitionMismatch.ready, false);
      assert.match(railwaysTransitionMismatch.reason || '', /Railways render mode mismatch/);

      const staleRevision = validateSceneReadinessSnapshot(legacySmallSnap, {
        expectedRevision: 5,
        datasetId: 'small-real-europatunnel',
        roadsMode: 'legacy',
        railwaysMode: 'legacy',
        railwayPrototypeMode: 'production',
        expectNonEmptyScene: true,
      });
      assert.equal(staleRevision.ready, false);
      assert.match(staleRevision.reason || '', /Scene revision mismatch/);
    });
  });

  describe('5. Frame Cadence Calculation Accuracy', () => {
    it('computes consecutive post-gl.render() frame intervals and exact effectiveMedianFps', () => {
      const timestamps = [1000.0, 1016.25, 1032.75, 1049.0, 1065.25];
      const intervals = computeConsecutiveFrameIntervalsMs(timestamps);
      assert.deepEqual(intervals, [16.25, 16.5, 16.25, 16.25]);

      const spec = BROWSER_BENCHMARK_SCENARIOS[0];
      const { result } = buildScenarioResult(spec, {
        scenarioId: 'static_overview',
        warmupFrames: 1,
        measuredFrames: 4,
        anchorTimestampMs: 1000.0,
        samples: [
          makeFrameTelemetry({ frameTimestampMs: 1016.25, instrumentationOverheadMs: 0.05 }),
          makeFrameTelemetry({ frameTimestampMs: 1032.75, instrumentationOverheadMs: 0.06 }),
          makeFrameTelemetry({ frameTimestampMs: 1049.0, instrumentationOverheadMs: 0.04 }),
          makeFrameTelemetry({ frameTimestampMs: 1065.25, instrumentationOverheadMs: 0.05 }),
        ],
        browserMemoryMB: {
          supported: false,
          usedJSHeapSizeMB: null,
          totalJSHeapSizeMB: null,
          jsHeapSizeLimitMB: null,
        },
      });

      assert.equal(result.frameIntervalMs.sampleCount, 4);
      assert.equal(result.frameIntervalMs.median, 16.25);
      assert.equal(result.effectiveMedianFps, Number((1000 / 16.25).toFixed(2)));
      assert.equal(result.instrumentationOverheadMs.median, 0.05);
    });
  });

  describe('6. Missing vs Genuine Zero Railway Metrics & Cached Frustum Evaluation', () => {
    it('evaluates cached railway visibility without traversal and separates sampled/unsampled/unavailable/disabled', () => {
      const group = new THREE.Group();
      const nearBox = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshBasicMaterial()
      );
      nearBox.position.set(0, 0, 0);
      nearBox.updateMatrixWorld(true);

      const farBox = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshBasicMaterial()
      );
      farBox.position.set(5000, 0, 5000);
      farBox.updateMatrixWorld(true);

      const hiddenSubgroup = new THREE.Group();
      hiddenSubgroup.visible = false;
      const hiddenMesh = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshBasicMaterial()
      );
      hiddenSubgroup.add(hiddenMesh);

      group.add(nearBox, farBox, hiddenSubgroup);
      group.updateMatrixWorld(true);

      const index = buildCachedRailwayIndex(group);
      assert.equal(index.staticMeshCount, 3);
      assert.equal(index.staticTriangleCount, 36); // 3 boxes * 12 triangles

      const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
      camera.position.set(0, 100, 0);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);

      // Sampled frame: nearBox active (12 tris), farBox frustum-culled, hiddenMesh ignored by LOD visibility
      const sampled = evaluateCachedRailwayVisibility({
        index,
        camera,
        showRailways: true,
        shouldSample: true,
      });
      assert.equal(sampled.status, 'measured');
      assert.equal(sampled.staticRailwayMeshes, 3);
      assert.equal(sampled.staticRailwayTriangles, 36);
      assert.equal(sampled.activeRailwayMeshes, 1);
      assert.equal(sampled.frustumCulledRailwayMeshes, 1);
      assert.equal(sampled.frustumVisibleRailwayTriangles, 12);

      // Unsampled frame: static counts retained, frustum visibility explicitly null (never 0)
      const unsampled = evaluateCachedRailwayVisibility({
        index,
        camera,
        showRailways: true,
        shouldSample: false,
      });
      assert.equal(unsampled.status, 'unsampled');
      assert.equal(unsampled.staticRailwayMeshes, 3);
      assert.equal(unsampled.activeRailwayMeshes, null);
      assert.equal(unsampled.frustumCulledRailwayMeshes, null);
      assert.equal(unsampled.frustumVisibleRailwayTriangles, null);

      // Disabled by config: genuine 0
      const disabled = evaluateCachedRailwayVisibility({
        index,
        camera,
        showRailways: false,
        shouldSample: true,
      });
      assert.equal(disabled.status, 'disabled_by_config');
      assert.equal(disabled.activeRailwayMeshes, 0);

      // Unavailable index: null + unavailable
      const unavailable = evaluateCachedRailwayVisibility({
        index: null,
        camera,
        showRailways: true,
        shouldSample: true,
      });
      assert.equal(unavailable.status, 'unavailable');
      assert.equal(unavailable.activeRailwayMeshes, null);

      // Verify deterministic stride sampling policy (frame 0, stride multiples, and final frame)
      assert.equal(shouldSampleRailwayVisibilityForFrame(0, 12, 4), true);
      assert.equal(shouldSampleRailwayVisibilityForFrame(1, 12, 4), false);
      assert.equal(shouldSampleRailwayVisibilityForFrame(4, 12, 4), true);
      assert.equal(shouldSampleRailwayVisibilityForFrame(11, 12, 4), true);

      // Verify scenario aggregation preserves null when all samples are unavailable/unsampled
      const unavailableScenario = buildScenarioResult(BROWSER_BENCHMARK_SCENARIOS[0], {
        scenarioId: 'static_overview',
        warmupFrames: 1,
        measuredFrames: 2,
        anchorTimestampMs: 100,
        samples: [
          makeFrameTelemetry({
            railwayVisibilityStatus: 'unavailable',
            staticRailwayMeshes: 0,
            staticRailwayTriangles: 0,
            activeRailwayMeshes: null,
            frustumCulledRailwayMeshes: null,
            frustumVisibleRailwayTriangles: null,
          }),
        ],
        browserMemoryMB: {
          supported: false,
          usedJSHeapSizeMB: null,
          totalJSHeapSizeMB: null,
          jsHeapSizeLimitMB: null,
        },
      });
      assert.equal(
        unavailableScenario.result.webglResources.railwayVisibilityStatus,
        'unavailable'
      );
      assert.equal(unavailableScenario.result.webglResources.activeRailwayMeshes, null);
      assert.equal(unavailableScenario.result.webglResources.frustumCulledRailwayMeshes, null);
      assert.equal(
        unavailableScenario.result.webglResources.frustumVisibleRailwayTriangles,
        null
      );
      assert.ok(unavailableScenario.railwayUnavailableNotice);

      // Clean up Three.js test geometries/materials
      nearBox.geometry.dispose();
      (nearBox.material as THREE.Material).dispose();
      farBox.geometry.dispose();
      (farBox.material as THREE.Material).dispose();
      hiddenMesh.geometry.dispose();
      (hiddenMesh.material as THREE.Material).dispose();
    });
  });

  describe('7. Cross-Platform CLI Argument Parsing', () => {
    it('supports comma lists, Windows PowerShell space/comma-split tokens, repeated flags, --iterations, and strict errors', () => {
      // Standard bash/POSIX comma-separated
      const posix = parseBrowserRunnerCliArgs([
        '--datasets=small-real-europatunnel,synthetic-stress-urban-switchyard',
        '--scenarios',
        'static_overview,automated_pan_sweep',
        '--require-hardware',
        '--headed',
      ]);
      assert.deepEqual(posix.datasetIds, [
        'small-real-europatunnel',
        'synthetic-stress-urban-switchyard',
      ]);
      assert.deepEqual(posix.scenarioIds, ['static_overview', 'automated_pan_sweep']);
      assert.equal(posix.requireHardwareGpu, true);
      assert.equal(posix.useSwiftShader, false);
      assert.equal(posix.headless, false);

      // PowerShell splits unquoted `a,b` into separate tokens (`['a,', 'b']` or `['a', 'b']`)
      const powershellSplit = parseBrowserRunnerCliArgs([
        '--scenarios',
        'static_overview',
        'automated_pan_sweep',
        '--configs',
        'production-legacy,',
        'graph-e2-e3',
        '--scenario',
        'static_close_junction',
        '--swiftshader',
        '--no-save',
      ]);
      assert.deepEqual(powershellSplit.scenarioIds, [
        'static_overview',
        'automated_pan_sweep',
        'static_close_junction',
      ]);
      assert.deepEqual(powershellSplit.configIds, ['production-legacy', 'graph-e2-e3']);
      assert.equal(powershellSplit.useSwiftShader, true);
      assert.equal(powershellSplit.outputPath, undefined);

      // Mutual exclusion of --swiftshader and --require-hardware
      assert.throws(
        () => parseBrowserRunnerCliArgs(['--swiftshader', '--require-hardware']),
        /Cannot combine --swiftshader and --require-hardware/
      );

      // Unknown flags fail clearly
      assert.throws(
        () => parseBrowserRunnerCliArgs(['--unknown-flag']),
        /Unknown CLI argument/
      );

      // CPU runner --iterations alias and PowerShell tokens
      const cpuOpts = parseCpuRunnerCliArgs([
        '--datasets',
        'small-real-europatunnel',
        'synthetic-stress-urban-switchyard',
        '--iterations=4',
        '--warmup',
        '1',
        '--no-save',
      ]);
      assert.deepEqual(cpuOpts.datasetIds, [
        'small-real-europatunnel',
        'synthetic-stress-urban-switchyard',
      ]);
      assert.equal(cpuOpts.measuredIterations, 4);
      assert.equal(cpuOpts.warmupIterations, 1);
      assert.equal(cpuOpts.outputPath, undefined);
    });
  });

  describe('8. Cross-Platform Server Resolution & Chromium GPU Flags', () => {
    it('resolves local tsx entrypoint directly via process.execPath without npx or shell=true, and defaults Chromium to hardware GPU', () => {
      const tsxPath = resolveTsxCliPath(process.cwd());
      assert.ok(tsxPath.endsWith(path.join('tsx', 'dist', 'cli.mjs')) || tsxPath.endsWith('.cjs'));

      const spawnSpec = buildLocalServerSpawnSpec(3199, process.cwd(), {}, '/custom/node.exe');
      assert.equal(spawnSpec.command, '/custom/node.exe');
      assert.equal(spawnSpec.shell, false);
      assert.equal(spawnSpec.args[0], tsxPath);
      assert.equal(spawnSpec.args[1], path.join(process.cwd(), 'server.ts'));
      assert.equal(spawnSpec.env.PORT, '3199');
      assert.equal(
        spawnSpec.command.toLowerCase().includes('npx'),
        false,
        'Server spawn must never rely on npx.cmd'
      );

      const winDefaultFlags = resolveChromiumLaunchArgs({
        useSwiftShader: false,
        platform: 'win32',
      });
      assert.equal(winDefaultFlags.includes('--use-gl=angle'), true);
      assert.equal(winDefaultFlags.includes('--use-angle=d3d11'), true);
      assert.equal(winDefaultFlags.includes('--use-angle=swiftshader'), false);
      assert.equal(winDefaultFlags.includes('--enable-webgl'), true);

      const linuxDefaultFlags = resolveChromiumLaunchArgs({
        useSwiftShader: false,
        platform: 'linux',
      });
      assert.equal(linuxDefaultFlags.includes('--use-angle=d3d11'), false);
      assert.equal(linuxDefaultFlags.includes('--use-angle=swiftshader'), false);
      assert.equal(linuxDefaultFlags.includes('--use-gl=angle'), false);
      assert.equal(linuxDefaultFlags.includes('--enable-webgl'), true);

      const macDefaultFlags = resolveChromiumLaunchArgs({
        useSwiftShader: false,
        platform: 'darwin',
      });
      assert.equal(macDefaultFlags.includes('--use-angle=d3d11'), false);
      assert.equal(macDefaultFlags.includes('--use-gl=angle'), false);

      const winSwiftFlags = resolveChromiumLaunchArgs({
        useSwiftShader: true,
        platform: 'win32',
      });
      assert.equal(winSwiftFlags.includes('--use-angle=swiftshader'), true);
      assert.equal(winSwiftFlags.includes('--use-angle=d3d11'), false);
      assert.equal(winSwiftFlags.includes('--use-gl=angle'), true);

      const linuxSwiftFlags = resolveChromiumLaunchArgs({
        useSwiftShader: true,
        platform: 'linux',
      });
      assert.equal(linuxSwiftFlags.includes('--use-angle=swiftshader'), true);
      assert.equal(linuxSwiftFlags.includes('--use-gl=angle'), true);

      // Configurable backends override platform defaults cleanly
      assert.equal(
        resolveChromiumLaunchArgs({ gpuBackend: 'vulkan', platform: 'linux' }).includes(
          '--use-angle=vulkan'
        ),
        true
      );
      assert.equal(
        resolveChromiumLaunchArgs({ gpuBackend: 'opengl', platform: 'win32' }).includes(
          '--use-angle=gl'
        ),
        true
      );
      assert.equal(
        resolveChromiumLaunchArgs({ gpuBackend: 'default', platform: 'win32' }).includes(
          '--use-gl=angle'
        ),
        false
      );

      // CLI parsing for --gpu-backend and mutual exclusion with --require-hardware / --swiftshader
      const parsedBackend = parseBrowserRunnerCliArgs([
        '--gpu-backend=d3d11',
        '--require-hardware',
      ]);
      assert.equal(parsedBackend.gpuBackend, 'd3d11');
      assert.equal(parsedBackend.requireHardwareGpu, true);

      assert.throws(
        () => parseBrowserRunnerCliArgs(['--gpu-backend=swiftshader', '--require-hardware']),
        /Cannot combine --gpu-backend=swiftshader and --require-hardware/
      );
      assert.throws(
        () => parseBrowserRunnerCliArgs(['--swiftshader', '--gpu-backend=d3d11']),
        /Cannot combine --swiftshader with hardware GPU backend/
      );
      assert.throws(
        () => parseBrowserRunnerCliArgs(['--gpu-backend=invalid-backend']),
        /Unsupported --gpu-backend/
      );
    });
  });

  describe('9. Git Reproducibility Metadata Resolution', () => {
    it('reports available commits, unborn HEAD, CI env SHAs, and non-git directories honestly without fabricating metadata', () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-git-meta-test-'));
      try {
        // 1. Non-git workspace without CI env -> explicit not_a_git_repository status
        const nonGitDir = path.join(tmpRoot, 'non-git');
        fs.mkdirSync(nonGitDir, { recursive: true });
        const nonGitState = resolveGitState(nonGitDir, {
          env: {},
          disableRepoRootFallback: true,
        });
        assert.equal(nonGitState.gitCommitSha, 'unknown');
        assert.equal(nonGitState.gitDirty, false);
        assert.equal(nonGitState.gitMetadataStatus, 'not_a_git_repository');
        assert.match(nonGitState.gitMetadataReason || '', /No \.git repository metadata/i);

        // 2. Non-git workspace with CI commit SHA -> ci_env_only without inventing dirty flag
        const ciState = resolveGitState(nonGitDir, {
          env: { GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567', GITHUB_REF_NAME: 'main' },
          disableRepoRootFallback: true,
        });
        assert.equal(ciState.gitCommitSha, '0123456789ab');
        assert.equal(ciState.gitBranch, 'main');
        assert.equal(ciState.gitDirty, false);
        assert.equal(ciState.gitMetadataStatus, 'ci_env_only');

        // 3. Initialized git repository with unborn HEAD and untracked file
        const repoDir = path.join(tmpRoot, 'git-repo');
        fs.mkdirSync(repoDir, { recursive: true });
        execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
        fs.writeFileSync(path.join(repoDir, 'sample.txt'), 'initial\n', 'utf8');

        const unbornState = resolveGitState(repoDir, {
          env: {},
          disableRepoRootFallback: true,
        });
        assert.equal(unbornState.gitCommitSha, 'unborn-head');
        assert.equal(unbornState.gitDirty, true);
        assert.equal(unbornState.gitMetadataStatus, 'unborn_head');

        // 4. Committed repository (clean -> available, then modified -> dirty)
        execFileSync('git', ['add', 'sample.txt'], { cwd: repoDir, stdio: 'ignore' });
        execFileSync(
          'git',
          ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'],
          { cwd: repoDir, stdio: 'ignore' }
        );

        const cleanState = resolveGitState(repoDir, {
          env: {},
          disableRepoRootFallback: true,
        });
        assert.match(cleanState.gitCommitSha, /^[a-f0-9]{12}$/);
        assert.equal(cleanState.gitDirty, false);
        assert.equal(cleanState.gitMetadataStatus, 'available');

        fs.writeFileSync(path.join(repoDir, 'sample.txt'), 'modified\n', 'utf8');
        const dirtyState = resolveGitState(repoDir, {
          env: {},
          disableRepoRootFallback: true,
        });
        assert.equal(dirtyState.gitCommitSha, cleanState.gitCommitSha);
        assert.equal(dirtyState.gitDirty, true);
        assert.equal(dirtyState.gitMetadataStatus, 'available');
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });
});
