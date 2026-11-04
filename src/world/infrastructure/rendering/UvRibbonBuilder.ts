import * as THREE from 'three';
import { ProfiledPoint3D } from '../../BridgeAndTunnelBuilder';

export interface UvRibbonOptions {
  /** Ribbon width in world meters */
  width: number;
  /** Signed lateral offset from track centerline in meters (+left, -right) */
  lateralCenterOffset?: number;
  /** Starting cumulative longitudinal arc-length phase in meters */
  startPhaseU?: number;
  /**
   * Optional per-vertex callback returning `[hostClearanceDist, switchBladeTaperFactor]`
   * stored in `aSwitchAttr` (`vec2`).
   */
  evaluateSwitchAttributes?: (
    vx: number,
    vz: number,
    arcS: number,
    totalLength: number,
    cx?: number,
    cz?: number
  ) => [number, number];
}

/**
 * Automatically subdivides sharp corners (`> maxAngleRad`, default 6 degrees) along a 2D polyline
 * into a smooth 3-point chamfered arc so UV ribbons and extruded rails never pinch or self-intersect.
 */
export function subdivideSharpPolylineCorners2D(
  points: [number, number][],
  maxAngleRad: number = (6 * Math.PI) / 180,
  chamferMeters: number = 0.65
): [number, number][] {
  if (!points || points.length < 3) return points ? [...points] : [];
  const cosThreshold = Math.cos(maxAngleRad);
  const out: [number, number][] = [points[0]];

  for (let i = 1; i < points.length - 1; i++) {
    const pPrev = points[i - 1];
    const pCurr = points[i];
    const pNext = points[i + 1];

    const dx1 = pCurr[0] - pPrev[0];
    const dz1 = pCurr[1] - pPrev[1];
    const len1 = Math.hypot(dx1, dz1);

    const dx2 = pNext[0] - pCurr[0];
    const dz2 = pNext[1] - pCurr[1];
    const len2 = Math.hypot(dx2, dz2);

    if (len1 < 0.25 || len2 < 0.25) {
      out.push(pCurr);
      continue;
    }

    const ux1 = dx1 / len1;
    const uz1 = dz1 / len1;
    const ux2 = dx2 / len2;
    const uz2 = dz2 / len2;

    if (ux1 * ux2 + uz1 * uz2 < cosThreshold) {
      const offset = Math.min(chamferMeters, len1 * 0.35, len2 * 0.35);
      const ptBefore: [number, number] = [pCurr[0] - ux1 * offset, pCurr[1] - uz1 * offset];
      const ptMid: [number, number] = [
        pCurr[0] + (ux2 - ux1) * (offset * 0.25),
        pCurr[1] + (uz2 - uz1) * (offset * 0.25),
      ];
      const ptAfter: [number, number] = [pCurr[0] + ux2 * offset, pCurr[1] + uz2 * offset];
      out.push(ptBefore, ptMid, ptAfter);
    } else {
      out.push(pCurr);
    }
  }

  out.push(points[points.length - 1]);
  return out;
}

/**
 * Builds a continuous UV-parameterized 3D ribbon geometry along a 3D vertical profile.
 * - `uv.x` (`u`): Continuous longitudinal arc-length coordinate in world meters (`startPhaseU + arcS`).
 * - `uv.y` (`v`): Signed lateral distance from ribbon centerline in world meters (`+width/2` left, `-width/2` right).
 * - `aSwitchAttr`: `vec2(hostClearanceDist, switchBladeTaperFactor)` for switch-zone shader filtering.
 */
export function buildUvRibbonGeometry3D(
  profile: ProfiledPoint3D[],
  options: UvRibbonOptions
): THREE.BufferGeometry | null {
  if (!profile || profile.length < 2) return null;
  const n = profile.length;
  const totalLength = profile[n - 1].arcLength - profile[0].arcLength;
  if (totalLength < 0.001) return null;

  const halfW = options.width * 0.5;
  const lateralOffset = options.lateralCenterOffset || 0;
  const startPhaseU = options.startPhaseU || 0;

  const segTangents: [number, number][] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = profile[i + 1].x - profile[i].x;
    const dz = profile[i + 1].z - profile[i].z;
    const len = Math.hypot(dx, dz) || 1e-6;
    segTangents.push([dx / len, dz / len]);
  }

  const positions = new Float32Array(n * 2 * 3);
  const normals = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);
  const switchAttrs = new Float32Array(n * 2 * 2);
  const indices = new Uint32Array((n - 1) * 6);

  for (let i = 0; i < n; i++) {
    let tx = 0;
    let tz = 0;
    let miterScale = 1;

    if (i === 0) {
      [tx, tz] = segTangents[0];
    } else if (i === n - 1) {
      [tx, tz] = segTangents[n - 2];
    } else {
      tx = segTangents[i - 1][0] + segTangents[i][0];
      tz = segTangents[i - 1][1] + segTangents[i][1];
      const len = Math.hypot(tx, tz) || 1e-6;
      tx /= len;
      tz /= len;
      const dot =
        segTangents[i - 1][0] * segTangents[i][0] + segTangents[i - 1][1] * segTangents[i][1];
      const cosHalf = Math.sqrt(Math.max(0.15, (1 + dot) * 0.5));
      miterScale = Math.min(1.3, 1 / Math.max(0.76, cosHalf));
    }

    const nx = -tz * miterScale;
    const nz = tx * miterScale;
    const pt = profile[i];
    const arcS = pt.arcLength - profile[0].arcLength;
    const uCoord = startPhaseU + arcS;

    const cx = pt.x + nx * lateralOffset;
    const cz = pt.z + nz * lateralOffset;
    const lx = cx + nx * halfW;
    const lz = cz + nz * halfW;
    const rx = cx - nx * halfW;
    const rz = cz - nz * halfW;

    const [swL0, swL1] = options.evaluateSwitchAttributes
      ? options.evaluateSwitchAttributes(lx, lz, arcS, totalLength, cx, cz)
      : [999, 1];
    const [swR0, swR1] = options.evaluateSwitchAttributes
      ? options.evaluateSwitchAttributes(rx, rz, arcS, totalLength, cx, cz)
      : [999, 1];

    const vL = i * 2;
    const vR = i * 2 + 1;

    positions[vL * 3] = lx;
    positions[vL * 3 + 1] = pt.y;
    positions[vL * 3 + 2] = lz;
    normals[vL * 3] = 0;
    normals[vL * 3 + 1] = 1;
    normals[vL * 3 + 2] = 0;
    uvs[vL * 2] = uCoord;
    uvs[vL * 2 + 1] = halfW;
    switchAttrs[vL * 2] = swL0;
    switchAttrs[vL * 2 + 1] = swL1;

    positions[vR * 3] = rx;
    positions[vR * 3 + 1] = pt.y;
    positions[vR * 3 + 2] = rz;
    normals[vR * 3] = 0;
    normals[vR * 3 + 1] = 1;
    normals[vR * 3 + 2] = 0;
    uvs[vR * 2] = uCoord;
    uvs[vR * 2 + 1] = -halfW;
    switchAttrs[vR * 2] = swR0;
    switchAttrs[vR * 2 + 1] = swR1;
  }

  for (let i = 0; i < n - 1; i++) {
    const l0 = i * 2;
    const r0 = i * 2 + 1;
    const l1 = (i + 1) * 2;
    const r1 = (i + 1) * 2 + 1;
    const base = i * 6;
    indices[base] = l0;
    indices[base + 1] = l1;
    indices[base + 2] = r0;
    indices[base + 3] = r0;
    indices[base + 4] = l1;
    indices[base + 5] = r1;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('aSwitchAttr', new THREE.BufferAttribute(switchAttrs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

/**
 * Builds a continuous UV-parameterized 2D ribbon geometry at constant elevation `yElevation`,
 * automatically subdividing sharp corners (`> 6 deg`) beforehand.
 */
export function buildUvRibbonGeometry2D(
  rawPoints: [number, number][],
  yElevation: number,
  options: UvRibbonOptions
): THREE.BufferGeometry | null {
  const subdivided = subdivideSharpPolylineCorners2D(rawPoints);
  if (subdivided.length < 2) return null;

  let arcLength = 0;
  const profile: ProfiledPoint3D[] = [];
  for (let i = 0; i < subdivided.length; i++) {
    if (i > 0) {
      arcLength += Math.hypot(
        subdivided[i][0] - subdivided[i - 1][0],
        subdivided[i][1] - subdivided[i - 1][1]
      );
    }
    profile.push({
      x: subdivided[i][0],
      y: yElevation,
      z: subdivided[i][1],
      arcLength,
    });
  }

  return buildUvRibbonGeometry3D(profile, options);
}
