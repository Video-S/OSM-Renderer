import React, { useEffect, useRef, useState } from 'react';
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
  selectedFeature?: InspectableFeatureInfo | null;
  selectedBoxMeters?: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  isSpatialSelectActive?: boolean;
  onSpatialBoxChange?: (box: { minX: number; maxX: number; minZ: number; maxZ: number } | null) => void;
  showGraphOverlay?: boolean;
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
  selectedFeature,
  selectedBoxMeters,
  isSpatialSelectActive = false,
  onSpatialBoxChange,
  showGraphOverlay = false,
}) => {
  const { gl, events, camera } = useThree();
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
  }, [gl, camera, isSpatialSelectActive, onSpatialBoxChange]);

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
    // Suppress mesh click-selection while in spatial area selection mode
    if (isSpatialSelectActive) return;
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

      {/* 3D Visual Selection Highlight Overlay */}
      {selectedFeature && (
        <group name="DevTools_SelectionHighlight">
          {/* Highlight bounding ring / footprint indicator */}
          <mesh position={[0, (selectedFeature.elevation ?? 0.05) + 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[1.5, 2.2, 32]} />
            <meshBasicMaterial color="#06b6d4" side={THREE.DoubleSide} transparent opacity={0.85} depthTest={false} />
          </mesh>
        </group>
      )}

      {/* Spatial Area Selection Box Overlay */}
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
                <mesh rotation={[-Math.PI / 2, 0, 0]}>
                  <planeGeometry args={[w, d]} />
                  <meshBasicMaterial
                    color={liveDragBox ? '#f59e0b' : '#06b6d4'}
                    transparent
                    opacity={liveDragBox ? 0.35 : 0.22}
                    depthWrite={false}
                    side={THREE.DoubleSide}
                  />
                </mesh>
                <lineSegments rotation={[-Math.PI / 2, 0, 0]}>
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

      {/* Topology Graph Nodes Visual Overlay */}
      {showGraphOverlay && builtGeometry.infrastructureRenderPreview?.descriptors?.roadNodes && (
        <group name="DevTools_GraphNodesOverlay">
          {builtGeometry.infrastructureRenderPreview.descriptors.roadNodes.map((n) => (
            <mesh key={n.id} position={[n.position[0], 0.09, n.position[1]]}>
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
    </group>
  );
};

