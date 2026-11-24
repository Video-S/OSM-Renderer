import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { BuiltSceneGeometry, resolveInspectedFeature } from '../world/GeometryBuilder';
import {
  addLayerDrawWork,
  emptyLayerDrawWork,
  type SceneLayerDrawWorkEstimate,
} from '../world/tiling/RenderWorkAttribution';
import { InspectableFeatureInfo, MapStyleTheme } from '../types/MapFeature';
import { getThemeExposure, isNaturalTheme } from '../styles/mapThemes';
import { LiveWebGLTelemetrySnapshot } from '../world/prototype/PerformanceBaselineHarness';
import {
  type BenchmarkFrameTelemetry,
  type GpuTimerQueryStatus,
  RAILWAY_VISIBILITY_SAMPLING_STRIDE,
  resolveGpuFrameTelemetryState,
  type SceneRevisionConfigMeta,
  shouldSampleRailwayVisibilityForFrame,
} from '../types/BenchmarkTelemetry';
import {
  buildCachedRailwayIndex,
  type CachedRailwayIndex,
  evaluateCachedRailwayVisibility,
} from '../world/prototype/BenchmarkRailwayTelemetry';

export interface MapSceneProps {
  builtGeometry: BuiltSceneGeometry;
  onCameraZoomChange?: (zoom: number) => void;
  onTelemetryUpdate?: (snapshot: LiveWebGLTelemetrySnapshot) => void;
  onSceneRevisionRendered?: (meta: SceneRevisionConfigMeta) => void;
  theme: MapStyleTheme;
  showBuildings?: boolean;
  showRoads?: boolean;
  showRailways?: boolean;
  showWater?: boolean;
  showParks?: boolean;
  showLanduse?: boolean;
  showBarriers?: boolean;
  showFoliage?: boolean;
  wireframe?: boolean;
  trackFps?: boolean;
  trackTelemetry?: boolean;
  onFpsUpdate?: (fps: number) => void;
  onHoverBuilding?: (buildingData: Record<string, unknown> | null) => void;
  onClickBuilding?: (buildingData: Record<string, unknown> | null) => void;
  onHoverFeature?: (
    feature: InspectableFeatureInfo | null,
    clientPos?: { x: number; y: number }
  ) => void;
  onSelectFeature?: (feature: InspectableFeatureInfo | null) => void;
  selectedFeature?: InspectableFeatureInfo | null;
  selectedFeatures?: InspectableFeatureInfo[];
  focusedFeatureId?: string | null;
  selectedBoxMeters?: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  isSpatialSelectActive?: boolean;
  onSpatialBoxChange?: (box: { minX: number; maxX: number; minZ: number; maxZ: number } | null) => void;
  onDeactivateSpatialSelect?: () => void;
  showGraphOverlay?: boolean;
  tileBoundaryOverlayGroup?: THREE.Group | null;
  showTileBoundaryOverlay?: boolean;
  onViewportFrameUpdate?: (camera: THREE.OrthographicCamera) => void;
}

function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return Number(sorted[idx].toFixed(2));
}

const PolylineHighlight: React.FC<{
  points: readonly [number, number][];
  elev: number;
  color: string;
  isFocused: boolean;
}> = ({ points, elev, color, isFocused }) => {
  const line = React.useMemo(() => {
    const pts = points.map((p) => new THREE.Vector3(p[0], elev, p[1]));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color,
      linewidth: isFocused ? 4 : 2,
      depthTest: false,
    });
    const l = new THREE.Line(geo, mat);
    l.raycast = () => {};
    return l;
  }, [points, elev, color, isFocused]);

  React.useEffect(() => {
    return () => {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    };
  }, [line]);

  return <primitive object={line} raycast={() => null} />;
};

export const MapScene: React.FC<MapSceneProps> = ({
  builtGeometry,
  onCameraZoomChange,
  onTelemetryUpdate,
  onSceneRevisionRendered,
  theme,
  showBuildings = true,
  showRoads = true,
  showRailways = true,
  showWater = true,
  showParks = true,
  showLanduse = true,
  showBarriers = true,
  showFoliage = true,
  wireframe = false,
  trackFps = false,
  trackTelemetry = false,
  onFpsUpdate,
  onHoverBuilding,
  onClickBuilding,
  onHoverFeature,
  onSelectFeature,
  selectedFeature,
  selectedFeatures,
  focusedFeatureId,
  selectedBoxMeters,
  isSpatialSelectActive = false,
  onSpatialBoxChange,
  onDeactivateSpatialSelect,
  showGraphOverlay = false,
  tileBoundaryOverlayGroup = null,
  showTileBoundaryOverlay = false,
  onViewportFrameUpdate,
}) => {
  const { gl, events, camera, raycaster } = useThree();
  const naturalLighting = isNaturalTheme(theme);

  useEffect(() => {
    // Apply exposure in place when switching themes; legacy theme exposure is unchanged.
    gl.toneMappingExposure = getThemeExposure(theme);
  }, [gl, theme.id]);
  const sunLightRef = useRef<THREE.DirectionalLight>(null);
  const sunDirectionRef = useRef(new THREE.Vector3());
  const lastHoverTimeRef = useRef<number>(0);
  const lastHoverRaycastMsRef = useRef<number>(0);
  const lastRaycastIntersectMsRef = useRef<number>(0);
  const frameCountRef = useRef<number>(0);
  const lastFpsTimeRef = useRef<number>(performance.now());
  const lastFrameTimestampRef = useRef<number>(performance.now());
  const lastRafIntervalMsRef = useRef<number>(16.667);
  const frameIntervalsRingRef = useRef<number[]>([]);
  const lastZoomRef = useRef<number>(-1);

  const lastGpuTimeMsRef = useRef<number | null>(null);
  const lastGpuTimerStatusRef = useRef<GpuTimerQueryStatus>('unsupported');
  const lastCpuRenderTimeMsRef = useRef<number>(0);
  const gpuDisjointRef = useRef<boolean>(false);
  const gpuTimerSupportedRef = useRef<boolean>(false);
  const gpuVendorRef = useRef<string>('Unknown');
  const gpuRendererRef = useRef<string>('Unknown');
  const lastRenderCallsRef = useRef<number>(0);
  const lastRenderTrianglesRef = useRef<number>(0);
  const lastDriverProgramsRef = useRef<number>(0);

  const activeRailwaysGroup = builtGeometry.railwaysGroup;
  const cachedRailwayIndexRef = useRef<CachedRailwayIndex | null>(null);
  const lastRailwayCompositeRevRef = useRef<number>(-1);
  const committedBuiltGeometryRef = useRef<BuiltSceneGeometry | null>(null);
  const showRailwaysRef = useRef<boolean>(showRailways);
  const cameraRef = useRef<THREE.Camera>(camera);
  const onSceneRevisionRenderedRef = useRef(onSceneRevisionRendered);

  showRailwaysRef.current = showRailways;
  cameraRef.current = camera;
  onSceneRevisionRenderedRef.current = onSceneRevisionRendered;

  useLayoutEffect(() => {
    committedBuiltGeometryRef.current = builtGeometry;
  }, [builtGeometry]);

  useLayoutEffect(() => {
    lastRailwayCompositeRevRef.current =
      typeof activeRailwaysGroup.userData?.compositeRevision === 'number'
        ? activeRailwaysGroup.userData.compositeRevision
        : -1;
    cachedRailwayIndexRef.current = buildCachedRailwayIndex(activeRailwaysGroup);
  }, [activeRailwaysGroup, builtGeometry]);

  // Enable three-mesh-bvh firstHitOnly optimization and measure actual R3F
  // raycaster.intersectObject(MapRoot, true) execution time so hoverRaycastTimeMs
  // reflects the true Three.js/BVH raycast duration plus feature metadata lookup.
  useEffect(() => {
    if (!raycaster) return;
    const prevFirstHitOnly = (raycaster as any).firstHitOnly;
    (raycaster as any).firstHitOnly = true;
    const origIntersectObject = raycaster.intersectObject.bind(raycaster);
    const origIntersectObjects = raycaster.intersectObjects.bind(raycaster);
    let depth = 0;

    raycaster.intersectObject = (
      object: THREE.Object3D,
      recursive?: boolean,
      optionalTarget?: THREE.Intersection[]
    ) => {
      if (depth > 0) {
        return origIntersectObject(object, recursive, optionalTarget);
      }
      depth++;
      const t0 = performance.now();
      try {
        return origIntersectObject(object, recursive, optionalTarget);
      } finally {
        const elapsed = performance.now() - t0;
        if (object.name === 'MapRoot' || elapsed >= lastRaycastIntersectMsRef.current) {
          lastRaycastIntersectMsRef.current = elapsed;
          lastHoverRaycastMsRef.current = Number(elapsed.toFixed(3));
        }
        depth--;
      }
    };

    raycaster.intersectObjects = (
      objects: THREE.Object3D[],
      recursive?: boolean,
      optionalTarget?: THREE.Intersection[]
    ) => {
      if (depth > 0) {
        return origIntersectObjects(objects, recursive, optionalTarget);
      }
      depth++;
      const t0 = performance.now();
      try {
        return origIntersectObjects(objects, recursive, optionalTarget);
      } finally {
        const elapsed = performance.now() - t0;
        lastRaycastIntersectMsRef.current = elapsed;
        lastHoverRaycastMsRef.current = Number(elapsed.toFixed(3));
        depth--;
      }
    };

    return () => {
      (raycaster as any).firstHitOnly = prevFirstHitOnly;
      raycaster.intersectObject = origIntersectObject;
      raycaster.intersectObjects = origIntersectObjects;
    };
  }, [raycaster]);

  // Spatial area drag state
  const isDraggingBoxRef = useRef(false);
  const dragStartPointRef = useRef<[number, number] | null>(null);
  const [liveDragBox, setLiveDragBox] = useState<{ minX: number; maxX: number; minZ: number; maxZ: number } | null>(null);

  // Ground plane unprojection helper for area selection
  const getGroundCoords = (clientX: number, clientY: number): [number, number] | null => {
    const dom = gl.domElement;
    if (!dom) return null;
    const rect = dom.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);

    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(groundPlane, hit)) {
      return [hit.x, hit.z];
    }
    return null;
  };

  // Handle spatial area drag selection on canvas when isSpatialSelectActive is true
  useEffect(() => {
    const dom = gl.domElement;
    if (!dom) return;

    if (!isSpatialSelectActive) {
      dom.style.cursor = 'default';
      setLiveDragBox(null);
      isDraggingBoxRef.current = false;
      dragStartPointRef.current = null;
      return;
    }

    // Set crosshair cursor to clearly indicate area selection mode
    dom.style.cursor = 'crosshair';

    const onPointerDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      const pt = getGroundCoords(ev.clientX, ev.clientY);
      if (!pt) return;

      isDraggingBoxRef.current = true;
      dragStartPointRef.current = pt;
      setLiveDragBox({ minX: pt[0], maxX: pt[0], minZ: pt[1], maxZ: pt[1] });
      ev.preventDefault();
      ev.stopPropagation();
    };

    const onPointerMove = (ev: PointerEvent) => {
      if (!isDraggingBoxRef.current || !dragStartPointRef.current) return;
      const pt = getGroundCoords(ev.clientX, ev.clientY);
      if (!pt) return;

      const start = dragStartPointRef.current;
      const minX = Math.min(start[0], pt[0]);
      const maxX = Math.max(start[0], pt[0]);
      const minZ = Math.min(start[1], pt[1]);
      const maxZ = Math.max(start[1], pt[1]);
      setLiveDragBox({ minX, maxX, minZ, maxZ });
      ev.preventDefault();
      ev.stopPropagation();
    };

    const onPointerUp = (ev: PointerEvent) => {
      if (!isDraggingBoxRef.current || !dragStartPointRef.current) return;
      const pt = getGroundCoords(ev.clientX, ev.clientY) || dragStartPointRef.current;
      const start = dragStartPointRef.current;
      const minX = Math.min(start[0], pt[0]);
      const maxX = Math.max(start[0], pt[0]);
      const minZ = Math.min(start[1], pt[1]);
      const maxZ = Math.max(start[1], pt[1]);

      isDraggingBoxRef.current = false;
      dragStartPointRef.current = null;
      setLiveDragBox(null);

      // Only commit if the box has a discernible dimension (> 0.5m)
      if (maxX - minX >= 0.5 || maxZ - minZ >= 0.5) {
        onSpatialBoxChange?.({ minX, maxX, minZ, maxZ });
        onDeactivateSpatialSelect?.();
      }
      ev.preventDefault();
      ev.stopPropagation();
    };

    dom.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    return () => {
      dom.style.cursor = 'default';
      dom.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [gl, camera, isSpatialSelectActive, onSpatialBoxChange, onDeactivateSpatialSelect]);

  // Suppress R3F CPU raycasting across MapRoot while user is actively dragging to pan/orbit the camera
  useEffect(() => {
    const dom = gl.domElement;
    if (!dom || isSpatialSelectActive) return;
    let isPointerDown = false;
    let downX = 0;
    let downY = 0;
    let eventsSuppressedForDrag = false;

    const onPointerDown = (ev: PointerEvent) => {
      isPointerDown = true;
      downX = ev.clientX;
      downY = ev.clientY;
    };

    const onPointerMoveDom = (ev: PointerEvent) => {
      if (!isPointerDown || eventsSuppressedForDrag) return;
      const dist = Math.hypot(ev.clientX - downX, ev.clientY - downY);
      if (dist > 5) {
        eventsSuppressedForDrag = true;
        events.enabled = false;
      }
    };

    const restoreEvents = () => {
      isPointerDown = false;
      if (eventsSuppressedForDrag) {
        eventsSuppressedForDrag = false;
        events.enabled = true;
      }
    };

    dom.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointermove', onPointerMoveDom, { passive: true });
    window.addEventListener('pointerup', restoreEvents, { passive: true });
    window.addEventListener('pointercancel', restoreEvents, { passive: true });

    return () => {
      events.enabled = true;
      dom.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMoveDom);
      window.removeEventListener('pointerup', restoreEvents);
      window.removeEventListener('pointercancel', restoreEvents);
    };
  }, [gl, events, isSpatialSelectActive]);

  // Bracket WebGLRenderer.render with EXT_disjoint_timer_query_webgl2 and capture exact post-render gl.info
  useEffect(() => {
    const rawGl = gl.getContext() as WebGL2RenderingContext;
    if (!rawGl) return;

    const dbgExt = rawGl.getExtension ? rawGl.getExtension('WEBGL_debug_renderer_info') : null;
    if (dbgExt) {
      gpuVendorRef.current = String(rawGl.getParameter(dbgExt.UNMASKED_VENDOR_WEBGL) || 'Unknown');
      gpuRendererRef.current = String(
        rawGl.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) || 'Unknown'
      );
    } else {
      gpuVendorRef.current = String(rawGl.getParameter(rawGl.VENDOR) || 'Unknown');
      gpuRendererRef.current = String(rawGl.getParameter(rawGl.RENDERER) || 'Unknown');
    }

    const timerExt = rawGl.getExtension
      ? rawGl.getExtension('EXT_disjoint_timer_query_webgl2')
      : null;
    gpuTimerSupportedRef.current = Boolean(timerExt && typeof rawGl.createQuery === 'function');

    const pendingQueries: WebGLQuery[] = [];
    let queryInFlight = false;
    const origRender = gl.render.bind(gl);

    const drainPendingQueries = (deleteAll: boolean) => {
      while (pendingQueries.length > 0) {
        const q = pendingQueries.shift()!;
        try {
          rawGl.deleteQuery(q);
        } catch {
          // ignore context loss
        }
      }
      if (deleteAll) {
        lastGpuTimeMsRef.current = null;
        gpuDisjointRef.current = false;
        lastGpuTimerStatusRef.current = gpuTimerSupportedRef.current
          ? 'pending'
          : 'unsupported';
      }
    };

    if (typeof window !== 'undefined') {
      (window as any).__BENCHMARK_RESET_GPU_TIMERS__ = () => {
        if (timerExt) {
          try {
            rawGl.getParameter(timerExt.GPU_DISJOINT_EXT);
          } catch {
            // ignore
          }
        }
        drainPendingQueries(true);
      };

      (window as any).__BENCHMARK_GET_CAMERA_STATE__ = () => {
        const cam = cameraRef.current as THREE.OrthographicCamera;
        if (!cam) return null;
        return {
          isOrthographicCamera: Boolean((cam as any).isOrthographicCamera),
          position: [
            Number(cam.position.x.toFixed(3)),
            Number(cam.position.y.toFixed(3)),
            Number(cam.position.z.toFixed(3)),
          ],
          zoom: Number((cam.zoom ?? 1).toFixed(4)),
          left: cam.left,
          right: cam.right,
          top: cam.top,
          bottom: cam.bottom,
          near: cam.near,
          far: cam.far,
        };
      };

      (window as any).__BENCHMARK_GET_SCENE_MESH_COUNTS__ = () => {
        const geo = committedBuiltGeometryRef.current;
        const cam = cameraRef.current as THREE.OrthographicCamera;
        if (!geo) return null;
        const frustum = new THREE.Frustum();
        const projScreen = new THREE.Matrix4();
        let hasValidFrustum = false;
        if (cam) {
          cam.updateMatrixWorld(true);
          cam.updateProjectionMatrix();
          projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
          frustum.setFromProjectionMatrix(projScreen);
          hasValidFrustum = true;
        }

        const layerEntries: Array<[string, THREE.Object3D]> = [
          ['ground', geo.groundMesh],
          ['landuse', geo.landuseGroup],
          ['water', geo.waterGroup],
          ['parks', geo.parksGroup],
          ['railways', geo.railwaysGroup],
          ['roads', geo.roadsGroup],
          ['barriers', geo.barriersGroup],
          ['foliage', geo.foliageGroup],
          ['buildings', geo.buildingsGroup],
        ];

        const byLayer: Record<
          string,
          { totalMeshes: number; frustumVisibleMeshes: number; visibleFlagMeshes: number }
        > = {};
        let totalMeshes = 0;
        let frustumVisibleMeshes = 0;
        let visibleFlagMeshes = 0;
        // Run only on a benchmark harness snapshot, never in the frame loop.
        const drawWorkByLayer: Record<string, SceneLayerDrawWorkEstimate> = {};
        const drawWorkTotal = emptyLayerDrawWork();

        for (const [layerName, rootObj] of layerEntries) {
          let layerTotal = 0;
          let layerFrustumVis = 0;
          let layerVisFlag = 0;
          const drawWork = emptyLayerDrawWork();
          rootObj.traverse((obj) => {
            if (!(obj as THREE.Mesh).isMesh) return;
            const mesh = obj as THREE.Mesh;
            layerTotal += 1;
            let ancestorVisible = mesh.visible;
            let p = mesh.parent;
            while (ancestorVisible && p) {
              ancestorVisible = p.visible;
              p = p.parent;
            }
            if (ancestorVisible) {
              layerVisFlag += 1;
              if (!hasValidFrustum || !mesh.frustumCulled || frustum.intersectsObject(mesh)) {
                layerFrustumVis += 1;
                addLayerDrawWork(drawWork, mesh);
              }
            }
          });
          drawWorkByLayer[layerName] = drawWork;
          drawWorkTotal.mainPassSubmissions += drawWork.mainPassSubmissions;
          drawWorkTotal.mainFrustumShadowCasterSubmissions +=
            drawWork.mainFrustumShadowCasterSubmissions;
          drawWorkTotal.instancedMeshes += drawWork.instancedMeshes;
          drawWorkTotal.drawableMeshes += drawWork.drawableMeshes;
          byLayer[layerName] = {
            totalMeshes: layerTotal,
            frustumVisibleMeshes: layerFrustumVis,
            visibleFlagMeshes: layerVisFlag,
          };
          totalMeshes += layerTotal;
          frustumVisibleMeshes += layerFrustumVis;
          visibleFlagMeshes += layerVisFlag;
        }

        return {
          total: {
            totalMeshes,
            visibleFlagMeshes,
            frustumVisibleMeshes,
          },
          byLayer,
          // Estimate of eligible material groups only, NOT measured GL draws.
          // Shadow passes have independent frusta and cannot be inferred here.
          drawWorkEstimate: {
            total: drawWorkTotal,
            byLayer: drawWorkByLayer,
            caveat: 'Main-camera material-group candidate estimate; excludes shadow passes, renderer filtering and overlays.',
          },
        };
      };
    }

    const emitPostRenderTelemetry = (
      scene: THREE.Object3D,
      cpuElapsedMs: number,
      gpuResolvedNsThisFrame: number | null,
      disjointOccurredThisFrame: boolean
    ) => {
      const postRenderTimestampMs = performance.now();
      lastCpuRenderTimeMsRef.current = Number(cpuElapsedMs.toFixed(3));
      lastRenderCallsRef.current = gl.info.render.calls;
      lastRenderTrianglesRef.current = gl.info.render.triangles;
      lastDriverProgramsRef.current = Array.isArray((gl.info as any).programs)
        ? (gl.info as any).programs.length
        : 0;

      const gpuState = resolveGpuFrameTelemetryState({
        supported: gpuTimerSupportedRef.current,
        disjoint: disjointOccurredThisFrame,
        resolvedNs: gpuResolvedNsThisFrame,
      });
      lastGpuTimerStatusRef.current = gpuState.gpuTimerStatus;
      gpuDisjointRef.current = gpuState.gpuDisjointOccurred;
      lastGpuTimeMsRef.current = gpuState.gpuPassTimeMs;

      const committedGeo = committedBuiltGeometryRef.current;
      let renderedRevision: number | null = null;
      if (committedGeo && committedGeo.groundMesh?.parent) {
        const meta = committedGeo.groundMesh.userData
          ?.__sceneMeta as SceneRevisionConfigMeta | undefined;
        if (meta) {
          meta.webglFramesRendered = (meta.webglFramesRendered || 0) + 1;
          renderedRevision = meta.revision;
          onSceneRevisionRenderedRef.current?.(meta);
        }
      }

      const benchmarkCollector =
        typeof window !== 'undefined' ? (window as any).__BENCHMARK_FRAME_COLLECTOR__ : null;
      if (typeof benchmarkCollector === 'function') {
        const tCollect0 = performance.now();
        const collectorMeta = (window as any).__BENCHMARK_COLLECTOR_META__ as
          | {
              phase?: 'warmup' | 'measured';
              frameIndex?: number;
              totalMeasuredFrames?: number;
              samplingStride?: number;
            }
          | undefined;
        const stride = collectorMeta?.samplingStride ?? RAILWAY_VISIBILITY_SAMPLING_STRIDE;
        const shouldSampleRailways =
          collectorMeta && typeof collectorMeta.frameIndex === 'number'
            ? shouldSampleRailwayVisibilityForFrame(
                collectorMeta.frameIndex,
                collectorMeta.totalMeasuredFrames ?? 0,
                stride
              )
            : true;

        const railSample = evaluateCachedRailwayVisibility({
          index: cachedRailwayIndexRef.current,
          camera: cameraRef.current,
          showRailways: showRailwaysRef.current,
          shouldSample: shouldSampleRailways,
        });

        const orthoCam = cameraRef.current as THREE.OrthographicCamera;
        const payload: BenchmarkFrameTelemetry = {
          frameTimestampMs: postRenderTimestampMs,
          frameIntervalMs: Number(lastRafIntervalMsRef.current.toFixed(3)),
          cpuRenderTimeMs: lastCpuRenderTimeMsRef.current,
          renderCalls: lastRenderCallsRef.current,
          renderTriangles: lastRenderTrianglesRef.current,
          driverGeometries: gl.info.memory.geometries,
          driverTextures: gl.info.memory.textures,
          driverPrograms: lastDriverProgramsRef.current,
          cameraZoom: Number((orthoCam?.zoom || 1).toFixed(3)),
          gpuVendor: gpuVendorRef.current,
          gpuRenderer: gpuRendererRef.current,
          gpuTimerQuerySupported: gpuState.gpuTimerQuerySupported,
          gpuTimerStatus: gpuState.gpuTimerStatus,
          gpuDisjointOccurred: gpuState.gpuDisjointOccurred,
          gpuPassTimeMs: gpuState.gpuPassTimeMs,
          railwayVisibilityStatus: railSample.status,
          staticRailwayMeshes: railSample.staticRailwayMeshes,
          staticRailwayTriangles: railSample.staticRailwayTriangles,
          activeRailwayMeshes: railSample.activeRailwayMeshes,
          frustumCulledRailwayMeshes: railSample.frustumCulledRailwayMeshes,
          frustumVisibleRailwayTriangles: railSample.frustumVisibleRailwayTriangles,
          railwayVisibilitySamplingStride: stride,
          sceneRevision: renderedRevision,
          instrumentationOverheadMs: Number((performance.now() - tCollect0).toFixed(3)),
        };
        benchmarkCollector(payload);
      }
      void scene;
    };

    gl.render = (scene: THREE.Object3D, renderCamera: THREE.Camera) => {
      let resolvedNsThisFrame: number | null = null;
      let disjointThisFrame = false;

      if (timerExt && typeof rawGl.createQuery === 'function') {
        const disjoint = Boolean(rawGl.getParameter(timerExt.GPU_DISJOINT_EXT));
        if (disjoint) {
          disjointThisFrame = true;
          drainPendingQueries(false);
        } else {
          while (pendingQueries.length > 0) {
            const head = pendingQueries[0];
            const available = rawGl.getQueryParameter(head, rawGl.QUERY_RESULT_AVAILABLE);
            if (!available) break;
            pendingQueries.shift();
            const ns = rawGl.getQueryParameter(head, rawGl.QUERY_RESULT);
            rawGl.deleteQuery(head);
            if (typeof ns === 'number' && Number.isFinite(ns) && ns >= 0) {
              resolvedNsThisFrame = ns;
            }
          }
        }

        if (!queryInFlight && pendingQueries.length < 8) {
          const q = rawGl.createQuery();
          if (q) {
            let tCpu0 = performance.now();
            try {
              rawGl.beginQuery(timerExt.TIME_ELAPSED_EXT, q);
              queryInFlight = true;
              tCpu0 = performance.now();
              origRender(scene, renderCamera);
              const cpuElapsed = performance.now() - tCpu0;
              rawGl.endQuery(timerExt.TIME_ELAPSED_EXT);
              queryInFlight = false;
              pendingQueries.push(q);
              emitPostRenderTelemetry(
                scene,
                cpuElapsed,
                resolvedNsThisFrame,
                disjointThisFrame
              );
              return;
            } catch {
              queryInFlight = false;
              try {
                rawGl.deleteQuery(q);
              } catch {
                // ignore
              }
              tCpu0 = performance.now();
              origRender(scene, renderCamera);
              emitPostRenderTelemetry(
                scene,
                performance.now() - tCpu0,
                resolvedNsThisFrame,
                disjointThisFrame
              );
              return;
            }
          }
        }
      }

      const tCpu0 = performance.now();
      origRender(scene, renderCamera);
      emitPostRenderTelemetry(
        scene,
        performance.now() - tCpu0,
        resolvedNsThisFrame,
        disjointThisFrame
      );
    };

    return () => {
      gl.render = origRender;
      if (typeof window !== 'undefined') {
        delete (window as any).__BENCHMARK_RESET_GPU_TIMERS__;
        delete (window as any).__BENCHMARK_GET_CAMERA_STATE__;
        delete (window as any).__BENCHMARK_GET_SCENE_MESH_COUNTS__;
      }
      drainPendingQueries(false);
    };
  }, [gl]);

  // Measure actual WebGL frame rate, camera zoom LOD updates, and live HUD telemetry
  useFrame((state) => {
    // The 3km shadow frustum must follow the camera over regional maps.
    // Moving the light, not enlarging the frustum, preserves shadow precision.
    if (
      (builtGeometry.groundMesh.userData.__regionalStreamingWidthMeters as number | undefined) &&
      (builtGeometry.groundMesh.userData.__regionalStreamingWidthMeters as number) > 4096 &&
      sunLightRef.current
    ) {
      const dir = sunDirectionRef.current;
      state.camera.getWorldDirection(dir);
      if (Math.abs(dir.y) > 1e-5) {
        const t = -state.camera.position.y / dir.y;
        const x = state.camera.position.x + dir.x * t;
        const z = state.camera.position.z + dir.z * t;
        const light = sunLightRef.current;
        light.position.set(x + 300, 500, z + 200);
        light.target.position.set(x, 0, z);
        light.target.updateMatrixWorld();
      }
    }
    const now = performance.now();
    const frameDt = now - lastFrameTimestampRef.current;
    lastFrameTimestampRef.current = now;
    lastRafIntervalMsRef.current = frameDt;

    const isBenchmarkActive =
      typeof window !== 'undefined' && (window as any).__BENCHMARK_ACTIVE__ === true;

    const cam = state.camera as THREE.OrthographicCamera;
    if (typeof cam.zoom === 'number' && Math.abs(cam.zoom - lastZoomRef.current) > 0.005) {
      lastZoomRef.current = cam.zoom;
      builtGeometry.updateCameraZoom?.(cam.zoom);
      if (onCameraZoomChange) {
        onCameraZoomChange(cam.zoom);
      }
    }

    if (onViewportFrameUpdate && (cam as THREE.OrthographicCamera).isOrthographicCamera) {
      onViewportFrameUpdate(cam);
    }

    const compositeRev = activeRailwaysGroup.userData?.compositeRevision;
    if (typeof compositeRev === 'number' && compositeRev !== lastRailwayCompositeRevRef.current) {
      lastRailwayCompositeRevRef.current = compositeRev;
      cachedRailwayIndexRef.current = buildCachedRailwayIndex(activeRailwaysGroup);
    }

    // During active automated frame benchmarking, skip ring sorting, HUD stats, and React updates;
    // benchmark frame telemetry is emitted synchronously post-origRender inside gl.render().
    if (isBenchmarkActive) {
      return;
    }

    // Skip per-frame telemetry sorting and railway sampling when the Performance panel is closed.
    if (!trackTelemetry && !trackFps) {
      return;
    }

    if (frameDt > 0 && frameDt < 5000) {
      const ring = frameIntervalsRingRef.current;
      ring.push(frameDt);
      if (ring.length > 120) {
        ring.shift();
      }
    }

    frameCountRef.current++;
    const delta = now - lastFpsTimeRef.current;
    const currentFps = delta > 0 ? Math.round((frameCountRef.current * 1000) / delta) : 60;
    if (delta >= 400) {
      if (trackFps && onFpsUpdate) {
        onFpsUpdate(currentFps);
      }
      frameCountRef.current = 0;
      lastFpsTimeRef.current = now;
    }

    if (trackTelemetry && onTelemetryUpdate) {
      const frameIntervalMs = Number(frameDt.toFixed(2));
      const ring = frameIntervalsRingRef.current;
      const sorted = [...ring].sort((a, b) => a - b);
      const medianMs = computePercentile(sorted, 50);
      const p95Ms = computePercentile(sorted, 95);
      const p99Ms = computePercentile(sorted, 99);
      const maxDt = sorted.length > 0 ? sorted[sorted.length - 1] : frameIntervalMs;
      const minDt = sorted.length > 0 ? sorted[0] : frameIntervalMs;
      const spikesOver33 = ring.filter((d) => d > 33.33).length;
      const spikesOver50 = ring.filter((d) => d > 50.0).length;

      const railSample = evaluateCachedRailwayVisibility({
        index: cachedRailwayIndexRef.current,
        camera: cam,
        showRailways,
        shouldSample: true,
      });

      onTelemetryUpdate({
        fps: currentFps,
        frameIntervalMs,
        medianFrameIntervalMs: medianMs,
        p95FrameIntervalMs: p95Ms,
        p99FrameIntervalMs: p99Ms,
        minFps: maxDt > 0 ? Number((1000 / maxDt).toFixed(1)) : currentFps,
        maxFps: minDt > 0 ? Number(Math.min(240, 1000 / minDt).toFixed(1)) : currentFps,
        spikesOver33msCount: spikesOver33,
        spikesOver50msCount: spikesOver50,
        maxSpikeDurationMs: Number(maxDt.toFixed(2)),
        gpuTimerQuerySupported: gpuTimerSupportedRef.current,
        gpuDisjointOccurred: gpuDisjointRef.current,
        gpuPassTimeMs: lastGpuTimeMsRef.current,
        cpuRenderTimeMs: lastCpuRenderTimeMsRef.current,
        renderCalls: lastRenderCallsRef.current || state.gl.info.render.calls,
        renderTriangles: lastRenderTrianglesRef.current || state.gl.info.render.triangles,
        activeRailwayMeshes: railSample.activeRailwayMeshes ?? undefined,
        activeFrustumCulledRailwayMeshes: railSample.frustumCulledRailwayMeshes ?? undefined,
        activeFrustumVisibleRailwayTriangles:
          railSample.frustumVisibleRailwayTriangles ?? undefined,
        hoverRaycastTimeMs: lastHoverRaycastMsRef.current,
        driverGeometries: state.gl.info.memory.geometries,
        driverTextures: state.gl.info.memory.textures,
        driverPrograms: lastDriverProgramsRef.current,
        cameraZoom: Number((cam.zoom || 1).toFixed(2)),
        gpuVendor: gpuVendorRef.current,
        gpuRenderer: gpuRendererRef.current,
        cameraFrustum: {
          left: cam.left,
          right: cam.right,
          top: cam.top,
          bottom: cam.bottom,
          width: state.size.width,
          height: state.size.height,
        },
      });
    }
  });

  // Apply wireframe to scene materials inside useEffect (not during render)
  useEffect(() => {
    const groups = [
      builtGeometry.buildingsGroup,
      builtGeometry.roadsGroup,
      activeRailwaysGroup,
      builtGeometry.waterGroup,
      builtGeometry.parksGroup,
      builtGeometry.landuseGroup,
      builtGeometry.barriersGroup,
      builtGeometry.foliageGroup,
    ];
    for (const grp of groups) {
      grp.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => {
              (m as THREE.MeshStandardMaterial).wireframe = wireframe;
            });
          } else if (mesh.material) {
            (mesh.material as THREE.MeshStandardMaterial).wireframe = wireframe;
          }
        }
      });
    }
  }, [builtGeometry, activeRailwaysGroup, wireframe]);

  const handlePointerMove = (e: any) => {
    e.stopPropagation();
    if (isSpatialSelectActive) {
      if (onHoverFeature) onHoverFeature(null, { x: 0, y: 0 });
      return;
    }
    const buttons = e.buttons ?? e.nativeEvent?.buttons ?? 0;
    if (buttons !== 0) return;
    const now = performance.now();
    if (now - lastHoverTimeRef.current < 16) return;
    lastHoverTimeRef.current = now;

    const t0 = performance.now();
    let info = resolveInspectedFeature(e);
    if (!info && Array.isArray(e.intersections)) {
      for (const hit of e.intersections) {
        const candidate = resolveInspectedFeature(hit);
        if (candidate) {
          info = candidate;
          break;
        }
      }
    }
    lastHoverRaycastMsRef.current = Number(
      (lastRaycastIntersectMsRef.current + (performance.now() - t0)).toFixed(3)
    );
    if (onHoverFeature) {
      const clientX = e.nativeEvent?.clientX ?? e.clientX ?? 0;
      const clientY = e.nativeEvent?.clientY ?? e.clientY ?? 0;
      onHoverFeature(info, { x: clientX, y: clientY });
    }
    if (onHoverBuilding) {
      if (info && info.category === 'Building') {
        onHoverBuilding(info as unknown as Record<string, unknown>);
      } else {
        onHoverBuilding(null);
      }
    }
  };

  const handlePointerOut = (e: any) => {
    e.stopPropagation();
    if (onHoverFeature) {
      onHoverFeature(null);
    }
    if (onHoverBuilding) {
      onHoverBuilding(null);
    }
  };

  const handleClick = (e: any) => {
    // Suppress mesh click-selection while actively dragging an area box
    if (isSpatialSelectActive) return;
    // Ignore drag-releases when panning/orbiting camera
    if (typeof e.delta === 'number' && e.delta > 6) return;
    e.stopPropagation();
    let info = resolveInspectedFeature(e);
    if (!info && Array.isArray(e.intersections)) {
      for (const hit of e.intersections) {
        const candidate = resolveInspectedFeature(hit);
        if (candidate) {
          info = candidate;
          break;
        }
      }
    }
    if (onSelectFeature) {
      onSelectFeature(info);
    }
    if (onClickBuilding && info && info.category === 'Building') {
      onClickBuilding(info as unknown as Record<string, unknown>);
    }
  };

  return (
    <group
      name="MapRoot"
      onPointerMove={handlePointerMove}
      onPointerOut={handlePointerOut}
      onClick={handleClick}
    >
      {/* Studio Lighting Rig */}
      <ambientLight intensity={theme.lightIntensity * 0.35} />
      <hemisphereLight
        args={[
          naturalLighting ? '#e8ebe7' : theme.skyColor,
          naturalLighting ? '#adb0a7' : theme.groundColor,
          theme.lightIntensity * 0.45,
        ]}
      />
      <directionalLight
        ref={sunLightRef}
        position={[300, 500, 200]}
        intensity={theme.lightIntensity * 1.1}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-1500}
        shadow-camera-right={1500}
        shadow-camera-top={1500}
        shadow-camera-bottom={-1500}
        shadow-camera-near={10}
        shadow-camera-far={3000}
        shadow-bias={-0.0002}
        shadow-normalBias={0.02}
      />
      {/* Soft rim light from opposite side */}
      <directionalLight
        position={[-300, 200, -200]}
        intensity={theme.lightIntensity * 0.25}
      />

      {/* Ground plane */}
      <primitive
        object={builtGeometry.groundMesh}
        onPointerMove={(e: any) => {
          e.stopPropagation();
          if (onHoverFeature) onHoverFeature(null);
          if (onHoverBuilding) onHoverBuilding(null);
        }}
      />

      {/* Landuse zoning layer */}
      {showLanduse && <primitive object={builtGeometry.landuseGroup} />}

      {/* Water layer (polygonal water & linear waterways) */}
      {showWater && <primitive object={builtGeometry.waterGroup} />}

      {/* Parks & green spaces layer */}
      {showParks && <primitive object={builtGeometry.parksGroup} />}

      {/* Railways layer (Production Baseline or Isolated M2.1 Prototype Override) */}
      {showRailways && <primitive object={activeRailwaysGroup} />}

      {/* Roads layer */}
      {showRoads && <primitive object={builtGeometry.roadsGroup} />}

      {/* Linear barriers (walls, hedges, fences, cliffs, tree rows) */}
      {showBarriers && <primitive object={builtGeometry.barriersGroup} />}

      {/* Procedural 3D Forests, Trees & Point Landmarks */}
      {showFoliage && <primitive object={builtGeometry.foliageGroup} />}

      {/* Buildings layer */}
      {showBuildings && <primitive object={builtGeometry.buildingsGroup} />}

      {/* 3D Visual Selection Highlight Overlay for Multi-Selection */}
      {(() => {
        const activeList =
          Array.isArray(selectedFeatures) && selectedFeatures.length > 0
            ? selectedFeatures
            : selectedFeature
            ? [selectedFeature]
            : [];
        if (activeList.length === 0) return null;

        const roadEdges = builtGeometry.infrastructureRenderPreview?.descriptors?.roadEdges || [];
        const roadNodes = builtGeometry.infrastructureRenderPreview?.descriptors?.roadNodes || [];

        return (
          <group name="DevTools_SelectionHighlight">
            {activeList.map((feat) => {
              const isFocused =
                feat.id === focusedFeatureId || (!focusedFeatureId && feat === activeList[0]);
              const color = isFocused ? '#f59e0b' : '#06b6d4';
              const elev = (feat.elevation ?? 0.05) + (isFocused ? 0.09 : 0.06);

              // 1. Matched junction node
              const matchedNode = roadNodes.find(
                (n) =>
                  n.id === feat.id ||
                  n.rawOsmNodeId === feat.id ||
                  `node/${n.rawOsmNodeId}` === feat.sourceFeatureId
              );
              if (matchedNode || feat.category === 'Junction') {
                const pos = matchedNode ? matchedNode.position : (feat as any).position || [0, 0];
                return (
                  <group key={`hl_${feat.id}`} position={[pos[0], 0.12, pos[1]]} raycast={() => null}>
                    <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
                      <ringGeometry args={[0.9, 1.5, 32]} />
                      <meshBasicMaterial
                        color={color}
                        side={THREE.DoubleSide}
                        transparent
                        opacity={0.9}
                        depthTest={false}
                      />
                    </mesh>
                    <mesh position={[0, 0.15, 0]} raycast={() => null}>
                      <sphereGeometry args={[isFocused ? 0.7 : 0.45, 16, 16]} />
                      <meshBasicMaterial color={color} depthTest={false} />
                    </mesh>
                  </group>
                );
              }

              // 2. Matched road edge: polyline highlight along centerline
              const matchedEdge = roadEdges.find(
                (e) =>
                  e.sourceFeatureId === feat.sourceFeatureId ||
                  e.sourceFeatureId === feat.id ||
                  e.id === feat.id
              );
              if (matchedEdge && matchedEdge.points.length >= 2) {
                return (
                  <PolylineHighlight
                    key={`hl_${feat.id}`}
                    points={matchedEdge.points}
                    elev={elev}
                    color={color}
                    isFocused={isFocused}
                  />
                );
              }

              // 3. Fallback position ring
              return (
                <mesh
                  key={`hl_${feat.id}`}
                  position={[0, elev, 0]}
                  rotation={[-Math.PI / 2, 0, 0]}
                  raycast={() => null}
                >
                  <ringGeometry args={[1.5, 2.2, 32]} />
                  <meshBasicMaterial
                    color={color}
                    side={THREE.DoubleSide}
                    transparent
                    opacity={0.85}
                    depthTest={false}
                  />
                </mesh>
              );
            })}
          </group>
        );
      })()}

      {/* Spatial Area Selection Box Overlay - raycast disabled so underlying objects can be selected */}
      {(liveDragBox || selectedBoxMeters) && (
        <group name="DevTools_SpatialSelectionBox">
          {(() => {
            const b = liveDragBox || selectedBoxMeters!;
            const w = Math.max(b.maxX - b.minX, 0.5);
            const d = Math.max(b.maxZ - b.minZ, 0.5);
            const cx = (b.minX + b.maxX) / 2;
            const cz = (b.minZ + b.maxZ) / 2;
            return (
              <group position={[cx, 0.08, cz]}>
                <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
                  <planeGeometry args={[w, d]} />
                  <meshBasicMaterial
                    color={liveDragBox ? '#f59e0b' : '#06b6d4'}
                    transparent
                    opacity={liveDragBox ? 0.35 : 0.22}
                    depthWrite={false}
                    side={THREE.DoubleSide}
                  />
                </mesh>
                <lineSegments rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
                  <edgesGeometry args={[new THREE.PlaneGeometry(w, d)]} />
                  <lineBasicMaterial
                    color={liveDragBox ? '#fbbf24' : '#22d3ee'}
                    linewidth={2}
                  />
                </lineSegments>
              </group>
            );
          })()}
        </group>
      )}

      {/* Topology Graph Nodes Visual Overlay with interactive userData */}
      {showGraphOverlay && builtGeometry.infrastructureRenderPreview?.descriptors?.roadNodes && (
        <group name="DevTools_GraphNodesOverlay">
          {builtGeometry.infrastructureRenderPreview.descriptors.roadNodes.map((n) => (
            <mesh
              key={n.id}
              position={[n.position[0], 0.09, n.position[1]]}
              userData={{
                id: n.id,
                sourceFeatureId: n.rawOsmNodeId ? `node/${n.rawOsmNodeId}` : n.id,
                category: 'Junction',
                cartoLabel: `Junction (${n.primaryRole})`,
                primaryTag: 'highway=junction',
                subtype: n.primaryRole,
                elevation: 0.09,
                layer: n.layer,
                degree: n.degree,
                role: n.primaryRole,
                position: n.position,
                osmTags: n.rawOsmNodeId
                  ? { 'osm:id': n.rawOsmNodeId, role: n.primaryRole, degree: n.degree }
                  : { role: n.primaryRole, degree: n.degree },
                incidentEdgeIds: n.incidentEdgeIds,
              }}
            >
              <sphereGeometry args={[n.degree >= 3 ? 0.9 : 0.5, 12, 12]} />
              <meshBasicMaterial
                color={
                  n.primaryRole === 'junction'
                    ? '#f59e0b'
                    : n.primaryRole === 'cross_tier'
                    ? '#a855f7'
                    : n.primaryRole === 'dead_end'
                    ? '#ef4444'
                    : '#06b6d4'
                }
              />
            </mesh>
          ))}
        </group>
      )}

      {/* M1a Developer Visual Acceptance Harness: 512 m Tile Grid Boundary Overlay (8×8 / 112 internal seams) */}
      {showTileBoundaryOverlay && tileBoundaryOverlayGroup && (
        <primitive object={tileBoundaryOverlayGroup} raycast={() => null} />
      )}
    </group>
  );
};

