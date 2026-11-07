import React, { useEffect, useRef, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { MapControls, OrthographicCamera } from '@react-three/drei';
import type { MapControls as MapControlsImpl } from 'three-stdlib';

export interface BoundingBox2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  widthMeters?: number;
  depthMeters?: number;
}

export interface VerticalEnvelope {
  minY: number;
  maxY: number;
}

export interface CameraControllerProps {
  bounds?: BoundingBox2D;
  verticalEnvelope?: VerticalEnvelope;
  resetSignal?: number;
  frameRegionSignal?: number;
  rotateStepSignal?: number; // +/- 1 for 45 deg rotation step
  onResetComplete?: () => void;
  target?: [number, number, number];
  fixedTiltAngle?: number; // radians from vertical Y axis, default ~55 deg
  minZoom?: number;
  maxZoom?: number;
  initialZoom?: number;
  explicitPose?: {
    target: [number, number, number];
    zoom: number;
    azimuthRad?: number;
    signal: number;
  };
  controlsEnabled?: boolean;
}

export const DEFAULT_CAMERA_POS: [number, number, number] = [380, 460, 380];
export const DEFAULT_CAMERA_TARGET: [number, number, number] = [0, 0, 0];
export const DEFAULT_TILT_ANGLE = Math.PI / 3.25; // ~55.4 degrees (classic isometric angle)
export const DEFAULT_AZIMUTH = Math.PI / 4; // 45 degrees
export const DEFAULT_INITIAL_ZOOM = 0.85;

/**
 * Computes projected bounds framing for the orthographic camera.
 * Projects the 4 ground corners of the bounding box into screen coordinates
 * taking into account camera azimuth and polar tilt, applying viewport aspect ratio and padding.
 */
export function computeProjectedBoundsFraming(
  bounds: BoundingBox2D,
  viewportWidth: number,
  viewportHeight: number,
  fixedTiltAngle: number = DEFAULT_TILT_ANGLE,
  azimuthAngle: number = DEFAULT_AZIMUTH,
  paddingFactor: number = 1.25
): { target: [number, number, number]; position: [number, number, number]; zoom: number } {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const target: [number, number, number] = [cx, 0, cz];

  const corners: [number, number][] = [
    [bounds.minX, bounds.minZ],
    [bounds.maxX, bounds.minZ],
    [bounds.maxX, bounds.maxZ],
    [bounds.minX, bounds.maxZ],
  ];

  const cosAz = Math.cos(azimuthAngle);
  const sinAz = Math.sin(azimuthAngle);
  const cosTilt = Math.cos(fixedTiltAngle);

  let minU = Infinity,
    maxU = -Infinity;
  let minV = Infinity,
    maxV = -Infinity;

  for (const [x, z] of corners) {
    const rx = x - cx;
    const rz = z - cz;

    // Projected horizontal screen coordinate (perpendicular to view azimuth)
    const u = rx * cosAz - rz * sinAz;
    // Projected vertical screen coordinate (along view azimuth, foreshortened by tilt)
    const v = (rx * sinAz + rz * cosAz) * cosTilt;

    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  // Use 0.78 octagonal inscribed factor so 45°-rotated square bounding boxes of circular OSM queries
  // frame the actual urban neighborhood tightly rather than empty diagonal corners
  const spanU = Math.max((maxU - minU) * 0.78 * paddingFactor, 20);
  const spanV = Math.max((maxV - minV) * 0.78 * paddingFactor, 20);

  const zoomU = viewportWidth / spanU;
  const zoomV = viewportHeight / spanV;
  const zoom = Math.max(0.15, Math.min(zoomU, zoomV, 8.0));

  const dist = Math.min(Math.max(spanU, spanV) * 1.5, 6000);
  const camX = cx + dist * Math.sin(fixedTiltAngle) * sinAz;
  const camY = dist * Math.cos(fixedTiltAngle);
  const camZ = cz + dist * Math.sin(fixedTiltAngle) * cosAz;

  return {
    target,
    position: [camX, camY, camZ],
    zoom,
  };
}

/**
 * Computes tight scene-derived orthographic clipping planes [near, far] from the actual
 * 3D world-space scene bounding box ([minX..maxX] x [yMin..yMax] x [minZ..maxZ]) and camera pose.
 * Prevents near-plane clipping when panning/zooming close to tall structures while maximizing
 * fixed-point depth-buffer precision.
 */
export function computeSceneFrustumPlanes(
  bounds: BoundingBox2D | undefined,
  cameraPosition: [number, number, number],
  cameraTarget: [number, number, number],
  verticalEnvelope: VerticalEnvelope = { minY: -4.0, maxY: 65.0 }
): { near: number; far: number; depthSpan: number } {
  const bMinX = bounds && Number.isFinite(bounds.minX) ? bounds.minX : -500;
  const bMaxX = bounds && Number.isFinite(bounds.maxX) ? bounds.maxX : 500;
  const bMinZ = bounds && Number.isFinite(bounds.minZ) ? bounds.minZ : -500;
  const bMaxZ = bounds && Number.isFinite(bounds.maxZ) ? bounds.maxZ : 500;

  // Include ground plane expansion (1.5x tile span) so ground edges never clip during pan/rotation
  const halfSpanX = Math.max((bMaxX - bMinX) * 0.75, 400);
  const halfSpanZ = Math.max((bMaxZ - bMinZ) * 0.75, 400);
  const cx = (bMinX + bMaxX) * 0.5;
  const cz = (bMinZ + bMaxZ) * 0.5;

  const minX = cx - halfSpanX;
  const maxX = cx + halfSpanX;
  const minZ = cz - halfSpanZ;
  const maxZ = cz + halfSpanZ;
  const minY = Math.min(-4.0, verticalEnvelope.minY - 2.0);
  const maxY = Math.max(15.0, verticalEnvelope.maxY + 5.0);

  const vx = cameraTarget[0] - cameraPosition[0];
  const vy = cameraTarget[1] - cameraPosition[1];
  const vz = cameraTarget[2] - cameraPosition[2];
  const vLen = Math.hypot(vx, vy, vz) || 1.0;
  const dirX = vx / vLen;
  const dirY = vy / vLen;
  const dirZ = vz / vLen;

  const xs = [minX, maxX];
  const ys = [minY, maxY];
  const zs = [minZ, maxZ];

  let dMin = Infinity;
  let dMax = -Infinity;

  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        const dx = x - cameraPosition[0];
        const dy = y - cameraPosition[1];
        const dz = z - cameraPosition[2];
        const depth = dx * dirX + dy * dirY + dz * dirZ;
        if (depth < dMin) dMin = depth;
        if (depth > dMax) dMax = depth;
      }
    }
  }

  const rawSpan = Math.max(20, dMax - dMin);
  const margin = Math.max(4.0, rawSpan * 0.05);
  const near = Math.max(0.1, Math.min(dMin - margin, Math.max(0.1, dMin * 0.5)));
  const far = Math.max(near + 20, Math.ceil(dMax + margin));

  return {
    near: Number(near.toFixed(2)),
    far: Number(far.toFixed(2)),
    depthSpan: Number((far - near).toFixed(2)),
  };
}

export const CameraController: React.FC<CameraControllerProps> = ({
  bounds,
  verticalEnvelope,
  resetSignal = 0,
  frameRegionSignal = 0,
  rotateStepSignal = 0,
  onResetComplete,
  target = DEFAULT_CAMERA_TARGET,
  fixedTiltAngle = DEFAULT_TILT_ANGLE,
  minZoom = 0.15,
  maxZoom = 16.0,
  initialZoom = DEFAULT_INITIAL_ZOOM,
  explicitPose,
  controlsEnabled = true,
}) => {
  const controlsRef = useRef<MapControlsImpl>(null);
  const { camera, invalidate, gl, size } = useThree();

  const lastResetSignal = useRef(resetSignal);
  const lastFrameRegionSignal = useRef(frameRegionSignal);
  const lastRotateStepSignal = useRef(rotateStepSignal);
  const lastExplicitPoseSignal = useRef(0);
  const lastBoundsKey = useRef<string>('');

  // Animation state for smooth camera transitions
  const isResetting = useRef(false);
  const resetProgress = useRef(0);
  const startPos = useRef(new THREE.Vector3());
  const startTarget = useRef(new THREE.Vector3());
  const startZoom = useRef(initialZoom);

  const destPos = useRef(new THREE.Vector3(...DEFAULT_CAMERA_POS));
  const destTarget = useRef(new THREE.Vector3(...target));
  const destZoom = useRef(initialZoom);

  // Compute framing from region bounds when available
  const boundsFraming = useMemo(() => {
    if (!bounds || !Number.isFinite(bounds.minX) || !Number.isFinite(bounds.maxX)) {
      return null;
    }
    return computeProjectedBoundsFraming(
      bounds,
      size.width || 1200,
      size.height || 800,
      fixedTiltAngle,
      DEFAULT_AZIMUTH,
      1.05
    );
  }, [
    bounds?.minX,
    bounds?.maxX,
    bounds?.minZ,
    bounds?.maxZ,
    size.width,
    size.height,
    fixedTiltAngle,
  ]);

  // Prevent right-click browser context menu
  useEffect(() => {
    const canvas = gl.domElement;
    const preventContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    canvas.addEventListener('contextmenu', preventContextMenu);
    return () => {
      canvas.removeEventListener('contextmenu', preventContextMenu);
    };
  }, [gl]);

  // 1. Initial framing or explicit region change: fit to loaded region bounds
  useEffect(() => {
    if (!bounds || (explicitPose && explicitPose.signal > 0)) return;
    const key = `${bounds.minX.toFixed(1)},${bounds.maxX.toFixed(1)},${bounds.minZ.toFixed(1)},${bounds.maxZ.toFixed(1)}`;
    if (key !== lastBoundsKey.current && boundsFraming && controlsRef.current) {
      const isInitialLoad = lastBoundsKey.current === '';
      lastBoundsKey.current = key;

      isResetting.current = true;
      resetProgress.current = isInitialLoad ? 0.85 : 0;

      startPos.current.copy(camera.position);
      startTarget.current.copy(controlsRef.current.target);
      if ('zoom' in camera) {
        startZoom.current = (camera as THREE.OrthographicCamera).zoom;
      }

      destPos.current.set(...boundsFraming.position);
      destTarget.current.set(...boundsFraming.target);
      destZoom.current = boundsFraming.zoom;

      invalidate();
    }
  }, [boundsFraming, camera, invalidate, bounds]);

  // 1b. Handle viewport resize smoothly without resetting camera pose
  useEffect(() => {
    if ('updateProjectionMatrix' in camera) {
      (camera as THREE.OrthographicCamera).updateProjectionMatrix();
      invalidate();
    }
  }, [size.width, size.height, camera, invalidate]);

  // 2. Handle explicit "Frame Region" signal
  useEffect(() => {
    if (frameRegionSignal > lastFrameRegionSignal.current && controlsRef.current) {
      lastFrameRegionSignal.current = frameRegionSignal;

      const framing =
        boundsFraming || {
          position: DEFAULT_CAMERA_POS,
          target: DEFAULT_CAMERA_TARGET,
          zoom: DEFAULT_INITIAL_ZOOM,
        };

      isResetting.current = true;
      resetProgress.current = 0;

      startPos.current.copy(camera.position);
      startTarget.current.copy(controlsRef.current.target);
      if ('zoom' in camera) {
        startZoom.current = (camera as THREE.OrthographicCamera).zoom;
      }

      destPos.current.set(...framing.position);
      destTarget.current.set(...framing.target);
      destZoom.current = framing.zoom;

      invalidate();
    } else {
      lastFrameRegionSignal.current = frameRegionSignal;
    }
  }, [frameRegionSignal, boundsFraming, camera, invalidate]);

  // 3. Handle standard reset signal
  useEffect(() => {
    if (resetSignal > lastResetSignal.current && controlsRef.current) {
      lastResetSignal.current = resetSignal;
      isResetting.current = true;
      resetProgress.current = 0;

      startPos.current.copy(camera.position);
      startTarget.current.copy(controlsRef.current.target);

      if ('zoom' in camera) {
        startZoom.current = (camera as THREE.OrthographicCamera).zoom;
      }

      const framing = boundsFraming || {
        position: DEFAULT_CAMERA_POS,
        target: DEFAULT_CAMERA_TARGET,
        zoom: initialZoom,
      };

      destPos.current.set(...framing.position);
      destTarget.current.set(...framing.target);
      destZoom.current = framing.zoom;

      invalidate();
    } else {
      lastResetSignal.current = resetSignal;
    }
  }, [resetSignal, boundsFraming, camera, initialZoom, invalidate]);

  // 4. Handle manual 45-degree rotation steps
  useEffect(() => {
    if (rotateStepSignal !== lastRotateStepSignal.current && controlsRef.current) {
      const step = rotateStepSignal > lastRotateStepSignal.current ? 1 : -1;
      lastRotateStepSignal.current = rotateStepSignal;

      const angle = (Math.PI / 4) * step;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      const targetVec = controlsRef.current.target;
      const dx = camera.position.x - targetVec.x;
      const dz = camera.position.z - targetVec.z;

      camera.position.x = targetVec.x + (dx * cos - dz * sin);
      camera.position.z = targetVec.z + (dx * sin + dz * cos);
      camera.lookAt(targetVec);

      controlsRef.current.update();
      invalidate();
    } else {
      lastRotateStepSignal.current = rotateStepSignal;
    }
  }, [rotateStepSignal, camera, invalidate]);

  // 5. Handle explicit camera pose jump (for railway prototype zone & zoom inspection)
  useEffect(() => {
    if (
      explicitPose &&
      explicitPose.signal > lastExplicitPoseSignal.current &&
      controlsRef.current
    ) {
      lastExplicitPoseSignal.current = explicitPose.signal;
      isResetting.current = false;

      const [tx, ty, tz] = explicitPose.target;
      const az = explicitPose.azimuthRad ?? DEFAULT_AZIMUTH;
      const dist = 600;
      const camX = tx + dist * Math.sin(fixedTiltAngle) * Math.sin(az);
      const camY = ty + dist * Math.cos(fixedTiltAngle);
      const camZ = tz + dist * Math.sin(fixedTiltAngle) * Math.cos(az);

      camera.position.set(camX, camY, camZ);
      controlsRef.current.target.set(tx, ty, tz);
      if ('zoom' in camera) {
        const ortho = camera as THREE.OrthographicCamera;
        ortho.zoom = Math.max(minZoom, Math.min(maxZoom, explicitPose.zoom));
        ortho.updateProjectionMatrix();
      }
      camera.lookAt(tx, ty, tz);
      controlsRef.current.update();
      invalidate();
    }
  }, [explicitPose, fixedTiltAngle, minZoom, maxZoom, camera, invalidate]);

  // Frame loop
  useFrame((state, delta) => {
    if (!controlsRef.current) return;
    const activeCamera = state.camera;

    if (isResetting.current) {
      resetProgress.current += delta * 2.8;
      const t = Math.min(1.0, resetProgress.current);
      const ease = t * t * (3 - 2 * t);

      activeCamera.position.lerpVectors(startPos.current, destPos.current, ease);
      controlsRef.current.target.lerpVectors(startTarget.current, destTarget.current, ease);

      if ('zoom' in activeCamera) {
        const ortho = activeCamera as THREE.OrthographicCamera;
        ortho.zoom = THREE.MathUtils.lerp(startZoom.current, destZoom.current, ease);
        ortho.updateProjectionMatrix();
      }

      if (t >= 1.0) {
        isResetting.current = false;
        if (onResetComplete) {
          onResetComplete();
        }
      }
    }

    controlsRef.current.update();

    if (
      'isOrthographicCamera' in activeCamera &&
      (activeCamera as THREE.OrthographicCamera).isOrthographicCamera
    ) {
      const ortho = activeCamera as THREE.OrthographicCamera;
      const t = controlsRef.current.target;
      const { near, far } = computeSceneFrustumPlanes(
        bounds,
        [ortho.position.x, ortho.position.y, ortho.position.z],
        [t.x, t.y, t.z],
        verticalEnvelope
      );
      if (Math.abs(ortho.near - near) > 0.5 || Math.abs(ortho.far - far) > 2.0) {
        ortho.near = near;
        ortho.far = far;
        ortho.updateProjectionMatrix();
      }
    }
  });

  const initialFrustum = useMemo(() => {
    const pos = boundsFraming ? boundsFraming.position : DEFAULT_CAMERA_POS;
    const tgt = boundsFraming ? boundsFraming.target : DEFAULT_CAMERA_TARGET;
    return computeSceneFrustumPlanes(bounds, pos, tgt, verticalEnvelope);
  }, [bounds, boundsFraming, verticalEnvelope]);

  return (
    <>
      <OrthographicCamera
        makeDefault
        position={boundsFraming ? boundsFraming.position : DEFAULT_CAMERA_POS}
        zoom={boundsFraming ? boundsFraming.zoom : initialZoom}
        near={initialFrustum.near}
        far={initialFrustum.far}
      />
      <MapControls
        ref={controlsRef}
        makeDefault
        enabled={controlsEnabled}
        minPolarAngle={fixedTiltAngle}
        maxPolarAngle={fixedTiltAngle}
        minZoom={minZoom}
        maxZoom={maxZoom}
        enableDamping
        dampingFactor={0.12}
        screenSpacePanning={false}
        mouseButtons={{
          LEFT: THREE.MOUSE.PAN,
          MIDDLE: THREE.MOUSE.DOLLY,
          RIGHT: THREE.MOUSE.ROTATE,
        }}
        enableRotate={controlsEnabled}
        enableZoom
        enablePan={controlsEnabled}
      />
    </>
  );
};
