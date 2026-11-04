import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { BuiltSceneGeometry, resolveInspectedFeature } from '../world/GeometryBuilder';
import { InspectableFeatureInfo, MapStyleTheme } from '../types/MapFeature';
import { LiveWebGLTelemetrySnapshot } from '../world/prototype/PerformanceBaselineHarness';

export interface MapSceneProps {
  builtGeometry: BuiltSceneGeometry;
  railwayGroupOverride?: THREE.Group | null;
  onCameraZoomChange?: (zoom: number) => void;
  onTelemetryUpdate?: (snapshot: LiveWebGLTelemetrySnapshot) => void;
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
  onFpsUpdate?: (fps: number) => void;
  onHoverBuilding?: (buildingData: Record<string, unknown> | null) => void;
  onClickBuilding?: (buildingData: Record<string, unknown> | null) => void;
  onHoverFeature?: (
    feature: InspectableFeatureInfo | null,
    clientPos?: { x: number; y: number }
  ) => void;
  onSelectFeature?: (feature: InspectableFeatureInfo | null) => void;
}

function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return Number(sorted[idx].toFixed(2));
}

export const MapScene: React.FC<MapSceneProps> = ({
  builtGeometry,
  railwayGroupOverride = null,
  onCameraZoomChange,
  onTelemetryUpdate,
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
  onFpsUpdate,
  onHoverBuilding,
  onClickBuilding,
  onHoverFeature,
  onSelectFeature,
}) => {
  const { gl, events } = useThree();
  const lastHoverTimeRef = useRef<number>(0);
  const lastHoverRaycastMsRef = useRef<number>(0);
  const frameCountRef = useRef<number>(0);
  const lastFpsTimeRef = useRef<number>(performance.now());
  const lastFrameTimestampRef = useRef<number>(performance.now());
  const frameIntervalsRingRef = useRef<number[]>([]);
  const lastZoomRef = useRef<number>(-1);

  const lastGpuTimeMsRef = useRef<number | null>(null);
  const gpuDisjointRef = useRef<boolean>(false);
  const gpuTimerSupportedRef = useRef<boolean>(false);
  const gpuVendorRef = useRef<string>('Unknown');
  const gpuRendererRef = useRef<string>('Unknown');
  const lastRenderCallsRef = useRef<number>(0);
  const lastRenderTrianglesRef = useRef<number>(0);

  const activeRailwaysGroup = railwayGroupOverride || builtGeometry.railwaysGroup;

  // Suppress R3F CPU raycasting across MapRoot while user is actively dragging to pan/orbit the camera
  useEffect(() => {
    const dom = gl.domElement;
    if (!dom) return;
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
  }, [gl, events]);

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

    gl.render = (scene: THREE.Object3D, camera: THREE.Camera) => {
      if (timerExt && typeof rawGl.createQuery === 'function') {
        const disjoint = Boolean(rawGl.getParameter(timerExt.GPU_DISJOINT_EXT));
        if (disjoint) {
          gpuDisjointRef.current = true;
          while (pendingQueries.length > 0) {
            const q = pendingQueries.shift()!;
            rawGl.deleteQuery(q);
          }
          lastGpuTimeMsRef.current = null;
        } else {
          while (pendingQueries.length > 0) {
            const head = pendingQueries[0];
            const available = rawGl.getQueryParameter(head, rawGl.QUERY_RESULT_AVAILABLE);
            if (!available) break;
            pendingQueries.shift();
            const ns = rawGl.getQueryParameter(head, rawGl.QUERY_RESULT);
            rawGl.deleteQuery(head);
            if (typeof ns === 'number' && ns > 0) {
              lastGpuTimeMsRef.current = Number((ns / 1e6).toFixed(3));
              gpuDisjointRef.current = false;
            }
          }
        }

        if (!queryInFlight && pendingQueries.length < 4) {
          const q = rawGl.createQuery();
          if (q) {
            try {
              rawGl.beginQuery(timerExt.TIME_ELAPSED_EXT, q);
              queryInFlight = true;
              origRender(scene, camera);
              rawGl.endQuery(timerExt.TIME_ELAPSED_EXT);
              queryInFlight = false;
              pendingQueries.push(q);
            } catch {
              queryInFlight = false;
              rawGl.deleteQuery(q);
              origRender(scene, camera);
            }
            lastRenderCallsRef.current = gl.info.render.calls;
            lastRenderTrianglesRef.current = gl.info.render.triangles;
            return;
          }
        }
      }

      origRender(scene, camera);
      lastRenderCallsRef.current = gl.info.render.calls;
      lastRenderTrianglesRef.current = gl.info.render.triangles;
    };

    return () => {
      gl.render = origRender;
      while (pendingQueries.length > 0) {
        const q = pendingQueries.shift()!;
        try {
          rawGl.deleteQuery(q);
        } catch {
          // ignore context loss
        }
      }
    };
  }, [gl]);

  // Measure actual WebGL frame rate, frame interval percentiles, camera zoom, and frustum-culled railway telemetry
  useFrame((state) => {
    const now = performance.now();
    const frameDt = now - lastFrameTimestampRef.current;
    lastFrameTimestampRef.current = now;
    if (frameDt > 0 && frameDt < 5000) {
      const ring = frameIntervalsRingRef.current;
      ring.push(frameDt);
      if (ring.length > 120) {
        ring.shift();
      }
    }

    const cam = state.camera as THREE.OrthographicCamera;
    if (typeof cam.zoom === 'number' && Math.abs(cam.zoom - lastZoomRef.current) > 0.005) {
      lastZoomRef.current = cam.zoom;
      builtGeometry.updateCameraZoom?.(cam.zoom);
      if (onCameraZoomChange) {
        onCameraZoomChange(cam.zoom);
      }
    }

    frameCountRef.current++;
    const delta = now - lastFpsTimeRef.current;
    let currentFps = delta > 0 ? Math.round((frameCountRef.current * 1000) / delta) : 60;
    if (delta >= 400) {
      if (trackFps && onFpsUpdate) {
        onFpsUpdate(currentFps);
      }
      frameCountRef.current = 0;
      lastFpsTimeRef.current = now;
    }

    if (onTelemetryUpdate) {
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

      // Evaluate frustum-visible vs frustum-culled railway meshes
      cam.updateMatrixWorld();
      const projScreenMatrix = new THREE.Matrix4().multiplyMatrices(
        cam.projectionMatrix,
        cam.matrixWorldInverse
      );
      const frustum = new THREE.Frustum().setFromProjectionMatrix(projScreenMatrix);
      let activeRailwayMeshes = 0;
      let culledRailwayMeshes = 0;
      let visibleRailwayTriangles = 0;

      if (showRailways && activeRailwaysGroup) {
        activeRailwaysGroup.traverse((child) => {
          if (!(child as THREE.Mesh).isMesh) return;
          let cur: THREE.Object3D | null = child;
          while (cur) {
            if (!cur.visible) return;
            cur = cur.parent;
          }
          const mesh = child as THREE.Mesh;
          const isInst = (mesh as unknown as THREE.InstancedMesh).isInstancedMesh === true;
          const instMesh = mesh as unknown as THREE.InstancedMesh;
          const instCount = isInst ? Math.max(0, instMesh.count || 0) : 1;
          const geo = mesh.geometry;
          const tris = geo
            ? (geo.index
                ? Math.round(geo.index.count / 3)
                : Math.round((geo.attributes.position?.count || 0) / 3)) * instCount
            : 0;

          let inFrustum = true;
          if (mesh.frustumCulled) {
            if (isInst && instMesh.boundingSphere) {
              inFrustum = frustum.intersectsSphere(instMesh.boundingSphere);
            } else if (geo) {
              if (!geo.boundingSphere) geo.computeBoundingSphere();
              inFrustum = frustum.intersectsObject(mesh);
            }
          }
          if (inFrustum) {
            activeRailwayMeshes++;
            visibleRailwayTriangles += tris;
          } else {
            culledRailwayMeshes++;
          }
        });
      }

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
        renderCalls: lastRenderCallsRef.current || state.gl.info.render.calls,
        renderTriangles: lastRenderTrianglesRef.current || state.gl.info.render.triangles,
        activeRailwayMeshes,
        activeFrustumCulledRailwayMeshes: culledRailwayMeshes,
        activeFrustumVisibleRailwayTriangles: visibleRailwayTriangles,
        hoverRaycastTimeMs: lastHoverRaycastMsRef.current,
        driverGeometries: state.gl.info.memory.geometries,
        driverTextures: state.gl.info.memory.textures,
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
    const buttons = e.buttons ?? e.nativeEvent?.buttons ?? 0;
    if (buttons !== 0) return;
    const now = performance.now();
    if (now - lastHoverTimeRef.current < 16) return;
    lastHoverTimeRef.current = now;

    const t0 = performance.now();
    const info = resolveInspectedFeature(e);
    lastHoverRaycastMsRef.current = Number((performance.now() - t0).toFixed(3));
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
    // Ignore drag-releases when panning/orbiting camera
    if (typeof e.delta === 'number' && e.delta > 6) return;
    e.stopPropagation();
    const info = resolveInspectedFeature(e);
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
          theme.skyColor,
          theme.groundColor,
          theme.lightIntensity * 0.45,
        ]}
      />
      <directionalLight
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
    </group>
  );
};

