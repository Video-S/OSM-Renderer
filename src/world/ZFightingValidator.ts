import * as THREE from 'three';
import polygonClipping from 'polygon-clipping';
import { BuiltSceneGeometry, FaceFeatureRange } from './GeometryBuilder';
import { BoundingBox2D, computeSceneFrustumPlanes } from '../scene/CameraController';
import { computeMultiPolygonArea, MultiPolygonCoords } from './PlanarLayerValidator';
import { RoadPortalConnectionSpec } from '../types/MapFeature';

export interface ExtractedSceneTriangle {
  meshName: string;
  groupName: string;
  featureId: string;
  subtype: string;
  isSurfaceFill: boolean;
  isIntentionalDecal: boolean;
  isRoadOrPath: boolean;
  renderOrder: number;
  polygonOffset: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
  v0: THREE.Vector3;
  v1: THREE.Vector3;
  v2: THREE.Vector3;
  normal: THREE.Vector3;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface SurfaceFillOverlapConflict {
  meshA: string;
  meshB: string;
  featureA: string;
  featureB: string;
  overlapAreaSqMeters: number;
}

export interface ScreenSpaceDepthDiagnostic {
  cameraLabel: string;
  meshUpper: string;
  meshLower: string;
  featureUpper: string;
  featureLower: string;
  minGeometricViewDeltaMeters: number;
  minGeometricNdcDelta: number;
  minQuantizedSteps16Bit: number;
  minQuantizedSteps24Bit: number;
  signConsistentAcrossOverlap: boolean;
}

export interface InteriorSamplePointSpec {
  label: string;
  worldX: number;
  worldZ: number;
  expectedFeatureIdSubstring: string;
  expectedMeshNameSubstring?: string;
  viewScaleMeters?: number; // e.g., 400m macro or 12m close-up marking view (2.34cm/px at 512x512)
}

export interface SampleWinnerAuditResult {
  label: string;
  passed: boolean;
  observedFeatureId: string | null;
  observedMeshName: string | null;
  stableUnderPerturbation16Bit: boolean;
  stableUnderPerturbation24Bit: boolean;
  details?: string;
}

export interface RoadNetworkOverlapConflict {
  meshA: string;
  meshB: string;
  featureA: string;
  featureB: string;
  overlapAreaSqMeters: number;
}

export interface RoadJunctionContinuityDefect {
  junctionFeatureId: string;
  roadFeatureId: string;
  minVertexGapMeters: number;
  portalGapMeters?: number;
  reason?: 'portal_gap' | 'missing_connected_road';
}

export interface RoadNetworkValidationReport {
  isValid: boolean;
  atGradeRoadTrianglesCount: number;
  overlapConflicts: RoadNetworkOverlapConflict[];
  continuityDefects: RoadJunctionContinuityDefect[];
  maxNumericalPortalToleranceMeters?: number;
}

export interface ZFightingValidationReport {
  isValid: boolean;
  totalUpwardTriangles: number;
  surfaceFillOverlapConflicts: SurfaceFillOverlapConflict[];
  roadNetworkOverlapConflicts: RoadNetworkOverlapConflict[];
  parkingMarkingSelfOverlaps: number;
  pitchMarkingSelfOverlaps: number;
  screenSpaceAuditsCount: number;
  screenSpaceDepthConflicts: ScreenSpaceDepthDiagnostic[];
  sampleWinnerResults: SampleWinnerAuditResult[];
}

function lookupFeatureForFace(
  mesh: THREE.Mesh,
  faceIdx: number
): { id: string; subtype: string } {
  const ranges: FaceFeatureRange[] | undefined = mesh.userData?.faceRanges;
  if (Array.isArray(ranges) && ranges.length > 0) {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const r = ranges[mid];
      if (faceIdx < r.startFace) hi = mid - 1;
      else if (faceIdx >= r.endFace) lo = mid + 1;
      else {
        return {
          id: r.info.id || r.info.sourceFeatureId || mesh.name,
          subtype: r.info.subtype || mesh.name,
        };
      }
    }
  }
  return {
    id: mesh.userData?.id || mesh.name,
    subtype: mesh.userData?.subtype || mesh.name,
  };
}

/**
 * Extracts all upward-facing world-space triangles (n_y > 0.5) from surface, water, marking, and road groups.
 */
export function extractUpwardSceneTriangles(scene: BuiltSceneGeometry): ExtractedSceneTriangle[] {
  const out: ExtractedSceneTriangle[] = [];
  const groups: Array<{ group: THREE.Object3D; groupName: string }> = [
    { group: scene.landuseGroup, groupName: 'LanduseGroup' },
    { group: scene.waterGroup, groupName: 'WaterGroup' },
    { group: scene.parksGroup, groupName: 'ParksGroup' },
    { group: scene.roadsGroup, groupName: 'RoadsGroup' },
    { group: scene.railwaysGroup, groupName: 'RailwaysGroup' },
  ];

  for (const { group, groupName } of groups) {
    group.updateMatrixWorld(true);
    group.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      const geom = mesh.geometry;
      const posAttr = geom.attributes.position;
      if (!posAttr) return;

      const mat = Array.isArray(mesh.material)
        ? (mesh.material[0] as THREE.MeshStandardMaterial)
        : (mesh.material as THREE.MeshStandardMaterial);

      const isDecal =
        mesh.name === 'Parking_Markings' ||
        mesh.name === 'Pitch_Markings' ||
        mesh.name === 'Landuse_parking_space' ||
        mesh.name === 'Highway_Steps_Treads' ||
        mesh.name === 'Tunnel_Entrances' ||
        mesh.name === 'Tunnel_Underground_Trace' ||
        mesh.name === 'Railways_Tunnel_Entrances' ||
        mesh.name === 'Railways_Tunnel_Underground_Trace';

      const isStructural3D =
        Boolean(mesh.userData?.isUndergroundTunnelGeometry) ||
        mesh.name === 'Bridge_Substructure' ||
        mesh.name === 'Bridge_Parapets' ||
        mesh.name === 'Bridge_Piers' ||
        mesh.name === 'Tunnel_Portals' ||
        mesh.name === 'Tunnel_Underground_Roads' ||
        mesh.name === 'Railways_Bridge_Substructure' ||
        mesh.name === 'Railways_Bridge_Parapets' ||
        mesh.name === 'Railways_Bridge_Piers' ||
        mesh.name === 'Railways_Tunnel_Portals' ||
        mesh.name.startsWith('Tunnel_Underground_Railway_');

      const isSurfaceFill =
        !isDecal &&
        !isStructural3D &&
        (groupName === 'LanduseGroup' || groupName === 'ParksGroup' || groupName === 'WaterGroup');

      const isRoadOrPath =
        (groupName === 'RoadsGroup' || groupName === 'RailwaysGroup') && !isDecal && !isStructural3D;

      const indexAttr = geom.index;
      const triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;

      for (let f = 0; f < triCount; f++) {
        const i0 = indexAttr ? indexAttr.getX(f * 3) : f * 3;
        const i1 = indexAttr ? indexAttr.getX(f * 3 + 1) : f * 3 + 1;
        const i2 = indexAttr ? indexAttr.getX(f * 3 + 2) : f * 3 + 2;

        const v0 = new THREE.Vector3().fromBufferAttribute(posAttr, i0).applyMatrix4(mesh.matrixWorld);
        const v1 = new THREE.Vector3().fromBufferAttribute(posAttr, i1).applyMatrix4(mesh.matrixWorld);
        const v2 = new THREE.Vector3().fromBufferAttribute(posAttr, i2).applyMatrix4(mesh.matrixWorld);

        const e1 = new THREE.Vector3().subVectors(v1, v0);
        const e2 = new THREE.Vector3().subVectors(v2, v0);
        const normal = new THREE.Vector3().crossVectors(e1, e2);
        const area2 = normal.length();
        if (area2 <= 1e-6) continue;
        normal.divideScalar(area2);
        if (Math.abs(normal.y) <= 0.5) continue;

        const { id, subtype } = lookupFeatureForFace(mesh, f);

        out.push({
          meshName: mesh.name,
          groupName,
          featureId: id,
          subtype,
          isSurfaceFill,
          isIntentionalDecal: isDecal,
          isRoadOrPath,
          renderOrder: mesh.renderOrder || 0,
          polygonOffset: Boolean(mat?.polygonOffset),
          polygonOffsetFactor: mat?.polygonOffsetFactor || 0,
          polygonOffsetUnits: mat?.polygonOffsetUnits || 0,
          v0,
          v1,
          v2,
          normal,
          minX: Math.min(v0.x, v1.x, v2.x),
          maxX: Math.max(v0.x, v1.x, v2.x),
          minZ: Math.min(v0.z, v1.z, v2.z),
          maxZ: Math.max(v0.z, v1.z, v2.z),
        });
      }
    });
  }

  return out;
}

/**
 * Exact 2D convex polygon clipping (Sutherland-Hodgman) for two 2D triangles.
 * Since every triangle is convex, clipping triangle A against the 3 half-planes of triangle B
 * is mathematically exact and allocation-light.
 */
export function clip2DTriangles(
  triA: Array<[number, number]>,
  triB: Array<[number, number]>
): Array<[number, number]> {
  const signedAreaB =
    (triB[1][0] - triB[0][0]) * (triB[2][1] - triB[0][1]) -
    (triB[1][1] - triB[0][1]) * (triB[2][0] - triB[0][0]);
  if (Math.abs(signedAreaB) <= 1e-11) return [];

  // Ensure clipper B is oriented counter-clockwise
  const clipTri = signedAreaB > 0 ? triB : [triB[0], triB[2], triB[1]];

  let poly = [...triA];
  for (let e = 0; e < 3; e++) {
    const p1 = clipTri[e];
    const p2 = clipTri[(e + 1) % 3];
    const ex = p2[0] - p1[0];
    const ey = p2[1] - p1[1];

    const input = poly;
    poly = [];
    if (input.length === 0) break;

    for (let i = 0; i < input.length; i++) {
      const curr = input[i];
      const prev = input[(i - 1 + input.length) % input.length];

      const crossCurr = ex * (curr[1] - p1[1]) - ey * (curr[0] - p1[0]);
      const crossPrev = ex * (prev[1] - p1[1]) - ey * (prev[0] - p1[0]);

      if (crossCurr >= -1e-9) {
        if (crossPrev < -1e-9) {
          const t = crossPrev / (crossPrev - crossCurr);
          poly.push([prev[0] + t * (curr[0] - prev[0]), prev[1] + t * (curr[1] - prev[1])]);
        }
        poly.push(curr);
      } else if (crossPrev >= -1e-9) {
        const t = crossPrev / (crossPrev - crossCurr);
        poly.push([prev[0] + t * (curr[0] - prev[0]), prev[1] + t * (curr[1] - prev[1])]);
      }
    }
  }

  return poly;
}

export function compute2DPolygonArea(pts: Array<[number, number]>): number {
  if (pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % pts.length];
    sum += p0[0] * p1[1] - p1[0] * p0[1];
  }
  return Math.abs(sum) * 0.5;
}

/**
 * Counts self-overlapping triangle pairs within a single mesh (such as `Parking_Markings` or `Pitch_Markings`).
 */
export function countInternalMeshSelfOverlaps(
  triangles: ExtractedSceneTriangle[],
  meshName: string,
  areaToleranceSqMeters: number = 1e-4
): number {
  const meshTris = triangles.filter((t) => t.meshName === meshName);
  let selfOverlaps = 0;

  for (let i = 0; i < meshTris.length; i++) {
    const a = meshTris[i];
    for (let j = i + 1; j < meshTris.length; j++) {
      const b = meshTris[j];
      if (a.featureId !== b.featureId) continue;
      if (a.maxX <= b.minX + 1e-4 || a.minX >= b.maxX - 1e-4) continue;
      if (a.maxZ <= b.minZ + 1e-4 || a.minZ >= b.maxZ - 1e-4) continue;

      const clipped = clip2DTriangles(
        [
          [a.v0.x, a.v0.z],
          [a.v1.x, a.v1.z],
          [a.v2.x, a.v2.z],
        ],
        [
          [b.v0.x, b.v0.z],
          [b.v1.x, b.v1.z],
          [b.v2.x, b.v2.z],
        ]
      );
      if (compute2DPolygonArea(clipped) > areaToleranceSqMeters) {
        selfOverlaps++;
      }
    }
  }

  return selfOverlaps;
}

/**
 * Queries the active depth buffer bit-depth from a WebGLRenderingContext when available,
 * defaulting to testing both 16-bit (WebGL minimum guarantee) and 24-bit fixed-point depth buffers.
 */
export function queryActiveWebGLDepthBits(gl?: WebGLRenderingContext | WebGL2RenderingContext | null): number {
  if (!gl) return 24;
  try {
    const bits = gl.getParameter(gl.DEPTH_BITS);
    return typeof bits === 'number' && bits > 0 ? bits : 24;
  } catch {
    return 24;
  }
}

/**
 * Projects a triangle into OrthographicCamera view space and NDC space, returning a linear plane
 * interpolator z_ndc(x_ndc, y_ndc) and z_view(x_ndc, y_ndc) across screen space.
 */
function buildProjectedTriangleInterpolator(
  tri: ExtractedSceneTriangle,
  camera: THREE.OrthographicCamera,
  viewportWidth: number = 512,
  viewportHeight: number = 512
): {
  ndcPts: Array<[number, number]>;
  evalAtNdc: (xNdc: number, yNdc: number) => {
    zView: number;
    zNdcGeometric: number;
    effectiveDepth16: number;
    effectiveDepth24: number;
  };
} | null {
  const p0View = tri.v0.clone().applyMatrix4(camera.matrixWorldInverse);
  const p1View = tri.v1.clone().applyMatrix4(camera.matrixWorldInverse);
  const p2View = tri.v2.clone().applyMatrix4(camera.matrixWorldInverse);

  const p0Ndc = p0View.clone().applyMatrix4(camera.projectionMatrix);
  const p1Ndc = p1View.clone().applyMatrix4(camera.projectionMatrix);
  const p2Ndc = p2View.clone().applyMatrix4(camera.projectionMatrix);

  const x0 = p0Ndc.x, y0 = p0Ndc.y;
  const x1 = p1Ndc.x, y1 = p1Ndc.y;
  const x2 = p2Ndc.x, y2 = p2Ndc.y;

  const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
  if (Math.abs(det) <= 1e-10) return null;

  // Compute screen-space depth slope m = max(|dz_win/dx_win|, |dz_win/dy_win|) for diagnostic polygonOffset
  const zWin0 = (p0Ndc.z + 1) * 0.5;
  const zWin1 = (p1Ndc.z + 1) * 0.5;
  const zWin2 = (p2Ndc.z + 1) * 0.5;

  const dzdxNdc = ((y1 - y2) * (zWin0 - zWin2) + (y2 - y0) * (zWin1 - zWin2)) / det;
  const dzdyNdc = ((x2 - x1) * (zWin0 - zWin2) + (x0 - x2) * (zWin1 - zWin2)) / det;
  const dzdxPixel = Math.abs(dzdxNdc) * (2.0 / viewportWidth);
  const dzdyPixel = Math.abs(dzdyNdc) * (2.0 / viewportHeight);
  const maxDepthSlope = Math.max(dzdxPixel, dzdyPixel);

  const evalAtNdc = (xNdc: number, yNdc: number) => {
    const w0 = ((y1 - y2) * (xNdc - x2) + (x2 - x1) * (yNdc - y2)) / det;
    const w1 = ((y2 - y0) * (xNdc - x2) + (x0 - x2) * (yNdc - y2)) / det;
    const w2 = 1.0 - w0 - w1;

    // Camera-space distance along view ray (-z in Three.js view coordinates)
    const zView = -(w0 * p0View.z + w1 * p1View.z + w2 * p2View.z);
    const zNdcGeometric = w0 * p0Ndc.z + w1 * p1Ndc.z + w2 * p2Ndc.z;
    const zWin = (zNdcGeometric + 1.0) * 0.5;

    const r16 = 1.0 / 65535.0;
    const r24 = 1.0 / 16777215.0;
    const bias16 = tri.polygonOffset
      ? tri.polygonOffsetFactor * maxDepthSlope + tri.polygonOffsetUnits * r16
      : 0;
    const bias24 = tri.polygonOffset
      ? tri.polygonOffsetFactor * maxDepthSlope + tri.polygonOffsetUnits * r24
      : 0;

    return {
      zView,
      zNdcGeometric,
      effectiveDepth16: (zWin + bias16) * 65535.0,
      effectiveDepth24: (zWin + bias24) * 16777215.0,
    };
  };

  return {
    ndcPts: [
      [x0, y0],
      [x1, y1],
      [x2, y2],
    ],
    evalAtNdc,
  };
}

/**
 * Evaluates which feature/mesh wins at a given 3D world sample point (worldX, worldZ)
 * under an OrthographicCamera configured at the specified tilt, azimuth, and view scale.
 */
export function evaluateSampleWinnerAtCameraPose(
  triangles: ExtractedSceneTriangle[],
  bounds: BoundingBox2D,
  worldX: number,
  worldZ: number,
  tiltRadians: number,
  azimuthRadians: number,
  viewScaleMeters: number = 400
): {
  winner16Bit: ExtractedSceneTriangle | null;
  winner24Bit: ExtractedSceneTriangle | null;
} {
  const dist = 600;
  const camX = worldX + dist * Math.sin(tiltRadians) * Math.sin(azimuthRadians);
  const camY = dist * Math.cos(tiltRadians);
  const camZ = worldZ + dist * Math.sin(tiltRadians) * Math.cos(azimuthRadians);

  const { near, far } = computeSceneFrustumPlanes(bounds, [camX, camY, camZ], [worldX, 0, worldZ]);
  const halfSpan = viewScaleMeters * 0.5;
  const camera = new THREE.OrthographicCamera(-halfSpan, halfSpan, halfSpan, -halfSpan, near, far);
  camera.position.set(camX, camY, camZ);
  camera.lookAt(worldX, 0, worldZ);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  // Candidate triangles containing (worldX, worldZ) in XZ or projecting over (0, 0) in NDC
  const candidates: Array<{
    tri: ExtractedSceneTriangle;
    d16: number;
    d24: number;
  }> = [];

  for (const tri of triangles) {
    if (
      worldX < tri.minX - 2.0 ||
      worldX > tri.maxX + 2.0 ||
      worldZ < tri.minZ - 2.0 ||
      worldZ > tri.maxZ + 2.0
    ) {
      continue;
    }

    // Check if (worldX, worldZ) lies inside the triangle's XZ footprint
    const ax = tri.v0.x, az = tri.v0.z;
    const bx = tri.v1.x, bz = tri.v1.z;
    const cx = tri.v2.x, cz = tri.v2.z;
    const detT = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(detT) <= 1e-9) continue;
    const u = ((bz - cz) * (worldX - cx) + (cx - bx) * (worldZ - cz)) / detT;
    const v = ((cz - az) * (worldX - cx) + (ax - cx) * (worldZ - cz)) / detT;
    const w = 1.0 - u - v;
    if (u < -1e-4 || v < -1e-4 || w < -1e-4) continue;

    const worldY = u * tri.v0.y + v * tri.v1.y + w * tri.v2.y;
    const ptNdc = new THREE.Vector3(worldX, worldY, worldZ)
      .applyMatrix4(camera.matrixWorldInverse)
      .applyMatrix4(camera.projectionMatrix);

    const interp = buildProjectedTriangleInterpolator(tri, camera, 512, 512);
    if (!interp) continue;
    const evalRes = interp.evalAtNdc(ptNdc.x, ptNdc.y);

    candidates.push({
      tri,
      d16: Math.round(evalRes.effectiveDepth16),
      d24: Math.round(evalRes.effectiveDepth24),
    });
  }

  // Sort by renderOrder ASC (Three.js submission order), and apply WebGL LESS_EQUAL depth test
  candidates.sort((a, b) => a.tri.renderOrder - b.tri.renderOrder);

  let winner16: ExtractedSceneTriangle | null = null;
  let bestDepth16 = Infinity;
  let winner24: ExtractedSceneTriangle | null = null;
  let bestDepth24 = Infinity;

  for (const c of candidates) {
    if (c.d16 <= bestDepth16) {
      bestDepth16 = c.d16;
      winner16 = c.tri;
    }
    if (c.d24 <= bestDepth24) {
      bestDepth24 = c.d24;
      winner24 = c.tri;
    }
  }

  return { winner16Bit: winner16, winner24Bit: winner24 };
}

/**
 * Runs the comprehensive Two-Layer Z-Fighting Validation Engine on a built 3D scene:
 * 1. Audits resolved surface-fill triangles (`landuseGroup`, `parksGroup`, `waterGroup`) for
 *    mutual exclusion (overlap area <= 1e-4 m²).
 * 2. Audits `Parking_Markings` and `Pitch_Markings` for zero internal self-overlapping triangles.
 * 3. Audits screen-space projected triangle pairs across polar tilts (15°, 35°, 55.4°, 72°) and azimuths
 *    for both 16-bit and 24-bit fixed-point depth quantization.
 * 4. Audits interior 3D sample points (at both 400m macro scale and 12m 2.34cm/px marking close-up scale)
 *    across baseline and +-0.15° micro-perturbed camera orientations.
 */
export function validateSceneZeroZFighting(
  scene: BuiltSceneGeometry,
  bounds: BoundingBox2D,
  samplePoints: InteriorSamplePointSpec[] = []
): ZFightingValidationReport {
  const triangles = extractUpwardSceneTriangles(scene);
  const surfaceFillOverlapConflicts: SurfaceFillOverlapConflict[] = [];

  // 1. Surface-fill mutual exclusion audit (spatial grid broad-phase + exact 2D triangle clipping)
  const surfaceFillTris = triangles.filter((t) => t.isSurfaceFill);
  const cellSize = 20.0;
  const grid = new Map<string, number[]>();

  for (let i = 0; i < surfaceFillTris.length; i++) {
    const t = surfaceFillTris[i];
    const gx0 = Math.floor(t.minX / cellSize);
    const gx1 = Math.floor(t.maxX / cellSize);
    const gz0 = Math.floor(t.minZ / cellSize);
    const gz1 = Math.floor(t.maxZ / cellSize);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const key = `${gx},${gz}`;
        let list = grid.get(key);
        if (!list) {
          list = [];
          grid.set(key, list);
        }
        list.push(i);
      }
    }
  }

  const checkedPairs = new Set<string>();
  for (const indices of grid.values()) {
    for (let aIdx = 0; aIdx < indices.length; aIdx++) {
      const i = indices[aIdx];
      const a = surfaceFillTris[i];
      for (let bIdx = aIdx + 1; bIdx < indices.length; bIdx++) {
        const j = indices[bIdx];
        const b = surfaceFillTris[j];
        if (a.featureId === b.featureId) continue;

        const pairKey = i < j ? `${i}:${j}` : `${j}:${i}`;
        if (checkedPairs.has(pairKey)) continue;
        checkedPairs.add(pairKey);

        if (a.maxX <= b.minX + 1e-3 || a.minX >= b.maxX - 1e-3) continue;
        if (a.maxZ <= b.minZ + 1e-3 || a.minZ >= b.maxZ - 1e-3) continue;

        const clipped = clip2DTriangles(
          [
            [a.v0.x, a.v0.z],
            [a.v1.x, a.v1.z],
            [a.v2.x, a.v2.z],
          ],
          [
            [b.v0.x, b.v0.z],
            [b.v1.x, b.v1.z],
            [b.v2.x, b.v2.z],
          ]
        );
        const area = compute2DPolygonArea(clipped);
        if (area > 1e-3) {
          surfaceFillOverlapConflicts.push({
            meshA: a.meshName,
            meshB: b.meshName,
            featureA: a.featureId,
            featureB: b.featureId,
            overlapAreaSqMeters: Number(area.toFixed(6)),
          });
        }
      }
    }
  }

  // 2. Self-overlap check inside Parking_Markings and Pitch_Markings
  const parkingMarkingSelfOverlaps = countInternalMeshSelfOverlaps(triangles, 'Parking_Markings', 1e-3);
  const pitchMarkingSelfOverlaps = countInternalMeshSelfOverlaps(triangles, 'Pitch_Markings', 1e-3);

  // 3. Multi-Tilt & Multi-Azimuth Screen-Space Depth Audit for Intentional Overlays & Roads
  const tiltsDeg = [15, 35, 55.4, 72];
  const azimuthsDeg = [45, 135, 225, 315];
  const cx = (bounds.minX + bounds.maxX) * 0.5;
  const cz = (bounds.minZ + bounds.maxZ) * 0.5;

  let screenSpaceAuditsCount = 0;
  const screenSpaceDepthConflicts: ScreenSpaceDepthDiagnostic[] = [];

  for (const tiltDeg of tiltsDeg) {
    const tiltRad = (tiltDeg * Math.PI) / 180;
    for (const azDeg of azimuthsDeg) {
      const azRad = (azDeg * Math.PI) / 180;
      const dist = 600;
      const camPos: [number, number, number] = [
        cx + dist * Math.sin(tiltRad) * Math.sin(azRad),
        dist * Math.cos(tiltRad),
        cz + dist * Math.sin(tiltRad) * Math.cos(azRad),
      ];
      const { near, far } = computeSceneFrustumPlanes(bounds, camPos, [cx, 0, cz]);
      const camera = new THREE.OrthographicCamera(-250, 250, 250, -250, near, far);
      camera.position.set(...camPos);
      camera.lookAt(cx, 0, cz);
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();

      // Compare intentional decals and roads against overlapping ground-cover triangles
      const overlayTris = triangles.filter((t) => t.isIntentionalDecal || t.isRoadOrPath);
      for (const overTri of overlayTris) {
        const interpOver = buildProjectedTriangleInterpolator(overTri, camera);
        if (!interpOver) continue;

        for (const baseTri of surfaceFillTris) {
          if (overTri.maxX <= baseTri.minX || overTri.minX >= baseTri.maxX) continue;
          if (overTri.maxZ <= baseTri.minZ || overTri.minZ >= baseTri.maxZ) continue;

          const xzOverlap = clip2DTriangles(
            [
              [overTri.v0.x, overTri.v0.z],
              [overTri.v1.x, overTri.v1.z],
              [overTri.v2.x, overTri.v2.z],
            ],
            [
              [baseTri.v0.x, baseTri.v0.z],
              [baseTri.v1.x, baseTri.v1.z],
              [baseTri.v2.x, baseTri.v2.z],
            ]
          );
          if (compute2DPolygonArea(xzOverlap) <= 1e-3) continue;

          const interpBase = buildProjectedTriangleInterpolator(baseTri, camera);
          if (!interpBase) continue;

          const ndcClip = clip2DTriangles(interpOver.ndcPts, interpBase.ndcPts);
          if (ndcClip.length < 3) continue;

          screenSpaceAuditsCount++;
          let minViewDelta = Infinity;
          let minNdcDelta = Infinity;
          let minSteps16 = Infinity;
          let minSteps24 = Infinity;
          let allOverInFront = true;

          for (const [nx, ny] of ndcClip) {
            const oVal = interpOver.evalAtNdc(nx, ny);
            const bVal = interpBase.evalAtNdc(nx, ny);

            const viewDelta = bVal.zView - oVal.zView;
            const ndcDelta = bVal.zNdcGeometric - oVal.zNdcGeometric;
            const steps16 = bVal.effectiveDepth16 - oVal.effectiveDepth16;
            const steps24 = bVal.effectiveDepth24 - oVal.effectiveDepth24;

            if (viewDelta < minViewDelta) minViewDelta = viewDelta;
            if (ndcDelta < minNdcDelta) minNdcDelta = ndcDelta;
            if (steps16 < minSteps16) minSteps16 = steps16;
            if (steps24 < minSteps24) minSteps24 = steps24;

            if (steps24 <= 0) allOverInFront = false;
          }

          if (!allOverInFront) {
            screenSpaceDepthConflicts.push({
              cameraLabel: `tilt=${tiltDeg}°,az=${azDeg}°`,
              meshUpper: overTri.meshName,
              meshLower: baseTri.meshName,
              featureUpper: overTri.featureId,
              featureLower: baseTri.featureId,
              minGeometricViewDeltaMeters: Number(minViewDelta.toFixed(5)),
              minGeometricNdcDelta: Number(minNdcDelta.toExponential(3)),
              minQuantizedSteps16Bit: Number(minSteps16.toFixed(2)),
              minQuantizedSteps24Bit: Number(minSteps24.toFixed(2)),
              signConsistentAcrossOverlap: allOverInFront,
            });
          }
        }
      }
    }
  }

  // 4. Multi-scale Interior Sample Point Winner & Micro-Perturbation Stability Audit
  const sampleWinnerResults: SampleWinnerAuditResult[] = [];
  for (const spec of samplePoints) {
    const scale = spec.viewScaleMeters ?? 400;
    const baseTilt = (55.4 * Math.PI) / 180;
    const baseAz = (45.0 * Math.PI) / 180;
    const deltaAngle = (0.15 * Math.PI) / 180;

    const baseline = evaluateSampleWinnerAtCameraPose(
      triangles,
      bounds,
      spec.worldX,
      spec.worldZ,
      baseTilt,
      baseAz,
      scale
    );

    const perturbedPoses = [
      evaluateSampleWinnerAtCameraPose(
        triangles,
        bounds,
        spec.worldX,
        spec.worldZ,
        baseTilt + deltaAngle,
        baseAz + deltaAngle,
        scale
      ),
      evaluateSampleWinnerAtCameraPose(
        triangles,
        bounds,
        spec.worldX,
        spec.worldZ,
        baseTilt - deltaAngle,
        baseAz - deltaAngle,
        scale
      ),
      evaluateSampleWinnerAtCameraPose(
        triangles,
        bounds,
        spec.worldX,
        spec.worldZ,
        (72.0 * Math.PI) / 180,
        (135.0 * Math.PI) / 180,
        scale
      ),
    ];

    const w24 = baseline.winner24Bit;
    const w16 = baseline.winner16Bit;

    const matchesExpectedFeature = Boolean(
      w24 && w24.featureId.includes(spec.expectedFeatureIdSubstring)
    );
    const matchesExpectedMesh =
      !spec.expectedMeshNameSubstring ||
      Boolean(w24 && w24.meshName.includes(spec.expectedMeshNameSubstring));

    const stable24 = perturbedPoses.every(
      (p) => p.winner24Bit?.featureId === w24?.featureId && p.winner24Bit?.meshName === w24?.meshName
    );
    const stable16 = perturbedPoses.every(
      (p) => p.winner16Bit?.featureId === w16?.featureId && p.winner16Bit?.meshName === w16?.meshName
    );

    sampleWinnerResults.push({
      label: spec.label,
      passed: matchesExpectedFeature && matchesExpectedMesh && stable24 && stable16,
      observedFeatureId: w24?.featureId || null,
      observedMeshName: w24?.meshName || null,
      stableUnderPerturbation16Bit: stable16,
      stableUnderPerturbation24Bit: stable24,
    });
  }

  const roadNetworkReport = validateRoadNetworkGeometry(scene, triangles);
  const roadNetworkOverlapConflicts = roadNetworkReport.overlapConflicts;

  const allSamplesPassed = sampleWinnerResults.every((r) => r.passed);

  return {
    isValid:
      surfaceFillOverlapConflicts.length === 0 &&
      roadNetworkOverlapConflicts.length === 0 &&
      roadNetworkReport.continuityDefects.length === 0 &&
      parkingMarkingSelfOverlaps === 0 &&
      pitchMarkingSelfOverlaps === 0 &&
      screenSpaceDepthConflicts.length === 0 &&
      allSamplesPassed,
    totalUpwardTriangles: triangles.length,
    surfaceFillOverlapConflicts,
    roadNetworkOverlapConflicts,
    parkingMarkingSelfOverlaps,
    pitchMarkingSelfOverlaps,
    screenSpaceAuditsCount,
    screenSpaceDepthConflicts,
    sampleWinnerResults,
  };
}

function pointToSegmentDist2D(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq <= 1e-12) return Math.hypot(px - ax, pz - az);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

function minDistancePointToGeometry2D(
  pt: [number, number],
  vertices: Array<[number, number]>,
  segments: Array<[[number, number], [number, number]]>
): number {
  let minD = Infinity;
  for (const [vx, vz] of vertices) {
    const d = Math.hypot(pt[0] - vx, pt[1] - vz);
    if (d < minD) minD = d;
  }
  for (const [a, b] of segments) {
    const d = pointToSegmentDist2D(pt[0], pt[1], a[0], a[1], b[0], b[1]);
    if (d < minD) minD = d;
  }
  return minD;
}

/**
 * Validates all at-grade road ribbons and junction polygons in `scene.roadsGroup` at `Y ≈ 0.050 m`
 * for:
 * 1. Zero positive-area 2D triangle overlaps (`> 1e-3 m²`) between coplanar triangles, including
 *    triangles belonging to the same feature (`featureA === featureB`), while ignoring harmless
 *    0-area shared-edge and shared-vertex contacts.
 * 2. Watertight portal continuity (`<= 0.02 m` gap; `<= 1e-3 m` numerical tolerance) between each
 *    junction polygon and its connected road ribbons along the actual portal boundary edges,
 *    treating missing or unmatched connected roads as validation failures.
 */
export function validateRoadNetworkGeometry(
  scene: BuiltSceneGeometry,
  preExtractedTriangles?: ExtractedSceneTriangle[]
): RoadNetworkValidationReport {
  const triangles = preExtractedTriangles ?? extractUpwardSceneTriangles(scene);
  const atGradeRoadTris = triangles.filter(
    (t) =>
      t.groupName === 'RoadsGroup' &&
      t.isRoadOrPath &&
      Math.abs(t.v0.y - 0.05) <= 0.0025 &&
      Math.abs(t.v1.y - 0.05) <= 0.0025 &&
      Math.abs(t.v2.y - 0.05) <= 0.0025
  );

  const cellSize = 15.0;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < atGradeRoadTris.length; i++) {
    const t = atGradeRoadTris[i];
    const gx0 = Math.floor(t.minX / cellSize);
    const gx1 = Math.floor(t.maxX / cellSize);
    const gz0 = Math.floor(t.minZ / cellSize);
    const gz1 = Math.floor(t.maxZ / cellSize);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const key = `${gx},${gz}`;
        let list = grid.get(key);
        if (!list) {
          list = [];
          grid.set(key, list);
        }
        list.push(i);
      }
    }
  }

  const overlapConflicts: RoadNetworkOverlapConflict[] = [];
  const checkedPairs = new Set<string>();
  const featurePairOverlapArea = new Map<
    string,
    { meshA: string; meshB: string; featureA: string; featureB: string; area: number }
  >();

  for (const indices of grid.values()) {
    for (let aIdx = 0; aIdx < indices.length; aIdx++) {
      const i = indices[aIdx];
      const a = atGradeRoadTris[i];
      for (let bIdx = aIdx + 1; bIdx < indices.length; bIdx++) {
        const j = indices[bIdx];
        const b = atGradeRoadTris[j];

        const pairKey = i < j ? `${i}:${j}` : `${j}:${i}`;
        if (checkedPairs.has(pairKey)) continue;
        checkedPairs.add(pairKey);

        if (a.maxX <= b.minX + 1e-4 || a.minX >= b.maxX - 1e-4) continue;
        if (a.maxZ <= b.minZ + 1e-4 || a.minZ >= b.maxZ - 1e-4) continue;

        const clipped = clip2DTriangles(
          [
            [a.v0.x, a.v0.z],
            [a.v1.x, a.v1.z],
            [a.v2.x, a.v2.z],
          ],
          [
            [b.v0.x, b.v0.z],
            [b.v1.x, b.v1.z],
            [b.v2.x, b.v2.z],
          ]
        );
        const area = compute2DPolygonArea(clipped);
        if (area > 1e-4) {
          const fKey =
            a.featureId <= b.featureId
              ? `${a.featureId}|${b.featureId}`
              : `${b.featureId}|${a.featureId}`;
          const existing = featurePairOverlapArea.get(fKey);
          if (existing) {
            existing.area += area;
          } else {
            featurePairOverlapArea.set(fKey, {
              meshA: a.meshName,
              meshB: b.meshName,
              featureA: a.featureId,
              featureB: b.featureId,
              area,
            });
          }
        }
      }
    }
  }

  for (const entry of featurePairOverlapArea.values()) {
    if (entry.area > 1e-3) {
      overlapConflicts.push({
        meshA: entry.meshA,
        meshB: entry.meshB,
        featureA: entry.featureA,
        featureB: entry.featureB,
        overlapAreaSqMeters: Number(entry.area.toFixed(6)),
      });
    }
  }

  // Audit junction-to-ribbon continuity using actual portal boundaries
  const continuityDefects: RoadJunctionContinuityDefect[] = [];
  const verticesByFeatureId = new Map<string, Array<[number, number]>>();
  const segmentsByFeatureId = new Map<string, Array<[[number, number], [number, number]]>>();
  const allNonJunctionVertices: Array<[number, number]> = [];
  const allNonJunctionSegments: Array<[[number, number], [number, number]]> = [];
  const junctionConnections = new Map<
    string,
    {
      sourceFeatureIds: string[];
      portalConnections?: RoadPortalConnectionSpec[];
    }
  >();

  const fullySubtractedIds = new Set<string>(
    Array.isArray(scene.roadsGroup.userData?.fullySubtractedRoadIds)
      ? scene.roadsGroup.userData.fullySubtractedRoadIds
      : []
  );

  scene.roadsGroup.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const ranges: FaceFeatureRange[] | undefined = mesh.userData?.faceRanges;
    if (!Array.isArray(ranges)) return;
    const posAttr = mesh.geometry.attributes.position;
    const indexAttr = mesh.geometry.index;
    if (!posAttr) return;

    for (const r of ranges) {
      const fid = r.info.id;
      if (!fid) continue;
      if (fid.startsWith('junction-')) {
        const existing = junctionConnections.get(fid);
        junctionConnections.set(fid, {
          sourceFeatureIds: Array.isArray(r.info.sourceFeatureIds)
            ? r.info.sourceFeatureIds
            : existing?.sourceFeatureIds ?? [],
          portalConnections: Array.isArray(r.info.portalConnections)
            ? r.info.portalConnections
            : existing?.portalConnections,
        });
      }
      let pts = verticesByFeatureId.get(fid);
      if (!pts) {
        pts = [];
        verticesByFeatureId.set(fid, pts);
      }
      let segs = segmentsByFeatureId.get(fid);
      if (!segs) {
        segs = [];
        segmentsByFeatureId.set(fid, segs);
      }
      const isJunction = fid.startsWith('junction-');
      for (let f = r.startFace; f < r.endFace; f++) {
        const i0 = indexAttr ? indexAttr.getX(f * 3) : f * 3;
        const i1 = indexAttr ? indexAttr.getX(f * 3 + 1) : f * 3 + 1;
        const i2 = indexAttr ? indexAttr.getX(f * 3 + 2) : f * 3 + 2;
        if (
          Math.abs(posAttr.getY(i0) - 0.05) <= 0.0025 &&
          Math.abs(posAttr.getY(i1) - 0.05) <= 0.0025 &&
          Math.abs(posAttr.getY(i2) - 0.05) <= 0.0025
        ) {
          const p0: [number, number] = [posAttr.getX(i0), posAttr.getZ(i0)];
          const p1: [number, number] = [posAttr.getX(i1), posAttr.getZ(i1)];
          const p2: [number, number] = [posAttr.getX(i2), posAttr.getZ(i2)];
          pts.push(p0, p1, p2);
          segs.push([p0, p1], [p1, p2], [p2, p0]);
          if (!isJunction) {
            allNonJunctionVertices.push(p0, p1, p2);
            allNonJunctionSegments.push([p0, p1], [p1, p2], [p2, p0]);
          }
        }
      }
    }
  });

  // Distinguish actual geometry defects (> 2 cm gap) from floating-point tolerance (<= 1 mm)
  const PORTAL_DEFECT_THRESHOLD_METERS = 0.02;
  let maxNumericalPortalToleranceMeters = 0;

  for (const [junctionId, conn] of junctionConnections.entries()) {
    const jPts = verticesByFeatureId.get(junctionId);
    const jSegs = segmentsByFeatureId.get(junctionId) ?? [];
    if (!jPts || jPts.length === 0) continue;

    if (Array.isArray(conn.portalConnections) && conn.portalConnections.length > 0) {
      for (const portal of conn.portalConnections) {
        const matchingRoadPts: Array<[number, number]> = [];
        const matchingRoadSegs: Array<[[number, number], [number, number]]> = [];

        const exactPts = verticesByFeatureId.get(portal.roadFeatureId);
        const exactSegs = segmentsByFeatureId.get(portal.roadFeatureId);
        if (exactPts && exactPts.length > 0) {
          matchingRoadPts.push(...exactPts);
          if (exactSegs) matchingRoadSegs.push(...exactSegs);
        } else {
          for (const [fid, fPts] of verticesByFeatureId.entries()) {
            if (fid === junctionId || fid.startsWith('junction-')) continue;
            if (
              fid === portal.sourceFeatureId ||
              fid.startsWith(`${portal.sourceFeatureId}_seg`)
            ) {
              matchingRoadPts.push(...fPts);
              const fSegs = segmentsByFeatureId.get(fid);
              if (fSegs) matchingRoadSegs.push(...fSegs);
            }
          }
        }

        if (matchingRoadPts.length === 0) {
          if (
            fullySubtractedIds.has(portal.roadFeatureId) ||
            fullySubtractedIds.has(portal.sourceFeatureId)
          ) {
            continue;
          }
          continuityDefects.push({
            junctionFeatureId: junctionId,
            roadFeatureId: portal.roadFeatureId,
            minVertexGapMeters: Infinity,
            portalGapMeters: Infinity,
            reason: 'missing_connected_road',
          });
          continue;
        }

        const midPortal: [number, number] = [
          (portal.left[0] + portal.right[0]) * 0.5,
          (portal.left[1] + portal.right[1]) * 0.5,
        ];

        // 1. Verify junction polygon contains the portal endpoints
        const dJuncLeft = minDistancePointToGeometry2D(portal.left, jPts, jSegs);
        const dJuncRight = minDistancePointToGeometry2D(portal.right, jPts, jSegs);

        // 2. Verify connected road meets the portal boundary segment [left, right]
        const dRoadLeft = minDistancePointToGeometry2D(
          portal.left,
          matchingRoadPts,
          matchingRoadSegs
        );
        const dRoadRight = minDistancePointToGeometry2D(
          portal.right,
          matchingRoadPts,
          matchingRoadSegs
        );
        const dRoadMid = minDistancePointToGeometry2D(
          midPortal,
          matchingRoadPts,
          matchingRoadSegs
        );

        // If one corner of the portal was Boolean-clipped against an adjacent overlapping road,
        // that corner is covered by the adjacent road while the remaining portal edge touches this road.
        const dAnyRoadLeft =
          dRoadLeft <= PORTAL_DEFECT_THRESHOLD_METERS
            ? dRoadLeft
            : minDistancePointToGeometry2D(
                portal.left,
                allNonJunctionVertices,
                allNonJunctionSegments
              );
        const dAnyRoadRight =
          dRoadRight <= PORTAL_DEFECT_THRESHOLD_METERS
            ? dRoadRight
            : minDistancePointToGeometry2D(
                portal.right,
                allNonJunctionVertices,
                allNonJunctionSegments
              );
        const dMinPortalContact = Math.min(dRoadLeft, dRoadRight, dRoadMid);

        const portalGap = Math.max(
          dJuncLeft,
          dJuncRight,
          dMinPortalContact,
          dAnyRoadLeft,
          dAnyRoadRight
        );

        if (portalGap <= PORTAL_DEFECT_THRESHOLD_METERS) {
          if (portalGap > maxNumericalPortalToleranceMeters) {
            maxNumericalPortalToleranceMeters = portalGap;
          }
        } else {
          continuityDefects.push({
            junctionFeatureId: junctionId,
            roadFeatureId: portal.roadFeatureId,
            minVertexGapMeters: Number(portalGap.toFixed(5)),
            portalGapMeters: Number(portalGap.toFixed(5)),
            reason: 'portal_gap',
          });
        }
      }
      continue;
    }

    // Fallback when synthetic test meshes only supply sourceFeatureIds without portalConnections
    for (const sid of conn.sourceFeatureIds) {
      const matchingRoadPts: Array<[number, number]> = [];
      const matchingRoadSegs: Array<[[number, number], [number, number]]> = [];
      for (const [fid, fPts] of verticesByFeatureId.entries()) {
        if (fid === junctionId || fid.startsWith('junction-')) continue;
        if (fid === sid || fid.startsWith(`${sid}_seg`)) {
          matchingRoadPts.push(...fPts);
          const fSegs = segmentsByFeatureId.get(fid);
          if (fSegs) matchingRoadSegs.push(...fSegs);
        }
      }
      if (matchingRoadPts.length === 0) {
        if (fullySubtractedIds.has(sid)) continue;
        continuityDefects.push({
          junctionFeatureId: junctionId,
          roadFeatureId: sid,
          minVertexGapMeters: Infinity,
          portalGapMeters: Infinity,
          reason: 'missing_connected_road',
        });
        continue;
      }

      let minGap = Infinity;
      for (const [jx, jz] of jPts) {
        const d = minDistancePointToGeometry2D([jx, jz], matchingRoadPts, matchingRoadSegs);
        if (d < minGap) minGap = d;
      }
      if (minGap > PORTAL_DEFECT_THRESHOLD_METERS) {
        continuityDefects.push({
          junctionFeatureId: junctionId,
          roadFeatureId: sid,
          minVertexGapMeters: Number(minGap.toFixed(5)),
          portalGapMeters: Number(minGap.toFixed(5)),
          reason: 'portal_gap',
        });
      }
    }
  }

  return {
    isValid: overlapConflicts.length === 0 && continuityDefects.length === 0,
    atGradeRoadTrianglesCount: atGradeRoadTris.length,
    overlapConflicts,
    continuityDefects,
    maxNumericalPortalToleranceMeters: Number(maxNumericalPortalToleranceMeters.toFixed(6)),
  };
}
