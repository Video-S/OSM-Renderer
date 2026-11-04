import * as THREE from 'three';
import { ELEVATION_POLICY } from './ElevationPolicy';

export interface ProfiledPoint3D {
  x: number;
  y: number;
  z: number;
  arcLength: number;
}

/**
 * Canonical bridge approach ramp transition constants:
 * - Standard/adapted approach ramp length: `min(12.0 m, 30% of mapped bridge length)`.
 * - At least `40%` (`MIN_CENTRAL_DECK_FRACTION = 0.40`) of a ramped bridge span remains flat at full
 *   `targetBridgeElevation` (`ROAD_SURFACE + BRIDGE_BASE_CLEARANCE = 2.850 m` for layer 1) so vertical
 *   clearance over crossed roads/waterways/railways is never reduced.
 * - Documented Fallback for Ultra-Short Bridges (`mappedBridgeLength < MIN_RAMPED_BRIDGE_SPAN_METERS = 5.0 m`):
 *   When a bridge span is shorter than `5.0 m`, interior approach ramps cannot fit without collapsing
 *   the central clearance zone or producing an excessive ramp gradient. The builder preserves 100% of
 *   `targetBridgeElevation` across the deck (`rampMode = 'abutment_headwall'`, `rampStartLength = 0`,
 *   `rampEndLength = 0`) and closes the bridge ends with vertical abutment headwalls down to ground level.
 */
export const DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS = 12.0;
export const DEFAULT_BRIDGE_RAMP_MAX_FRACTION = 0.30;
export const MIN_RAMPED_BRIDGE_SPAN_METERS = 5.0;
export const MIN_CENTRAL_DECK_FRACTION = 0.40;

export type BridgeRampMode =
  | 'standard_ramp'
  | 'adapted_ramp'
  | 'abutment_headwall'
  | 'elevated_continuation';

export interface BridgeProfileOptions {
  points: [number, number][];
  baseElevation: number;
  targetBridgeElevation: number;
  connectsStartAtGrade: boolean;
  connectsEndAtGrade: boolean;
  connectsStartBridge: boolean;
  connectsEndBridge: boolean;
  maxSampleStep?: number;
}

/**
 * Computes the total 2D arc length of a polyline.
 */
export function computePolylineLength(points: [number, number][]): number {
  if (!points || points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
  }
  return total;
}

/**
 * Trims a 2D polyline by `startTrim` meters from the start and `endTrim` meters from the end
 * along its true arc length, removing any short intermediate segments inside the trim zone
 * so short-segmented OSM approaches at junctions never protrude into the intersection.
 */
export function trimPolylineByArcLength(
  points: [number, number][],
  startTrim: number,
  endTrim: number
): [number, number][] {
  if (!points || points.length < 2) return points;
  const totalLen = computePolylineLength(points);
  if (totalLen < 1e-3) return points;

  const sStart = Math.min(Math.max(0, startTrim), totalLen * 0.45);
  const sEnd = Math.max(totalLen - Math.min(Math.max(0, endTrim), totalLen * 0.45), sStart + 0.05);

  if (sStart <= 1e-4 && sEnd >= totalLen - 1e-4) {
    return [...points];
  }

  const cumDist: number[] = [0];
  for (let i = 0; i < points.length - 1; i++) {
    const d = Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    cumDist.push(cumDist[i] + d);
  }

  const sampleAt = (s: number): [number, number] => {
    if (s <= 0) return [points[0][0], points[0][1]];
    if (s >= totalLen) return [points[points.length - 1][0], points[points.length - 1][1]];
    for (let i = 0; i < points.length - 1; i++) {
      const d0 = cumDist[i];
      const d1 = cumDist[i + 1];
      if (s >= d0 && s <= d1) {
        const segLen = d1 - d0;
        if (segLen < 1e-6) return [points[i][0], points[i][1]];
        const t = (s - d0) / segLen;
        return [
          points[i][0] + (points[i + 1][0] - points[i][0]) * t,
          points[i][1] + (points[i + 1][1] - points[i][1]) * t,
        ];
      }
    }
    return [points[points.length - 1][0], points[points.length - 1][1]];
  };

  const out: [number, number][] = [sampleAt(sStart)];
  for (let i = 1; i < points.length - 1; i++) {
    const d = cumDist[i];
    if (d > sStart + 0.02 && d < sEnd - 0.02) {
      out.push([points[i][0], points[i][1]]);
    }
  }
  out.push(sampleAt(sEnd));
  return out;
}

/**
 * Densifies a 2D polyline and computes a smooth 3D vertical elevation profile `y(s)` for a bridge.
 * - Preserves full grade separation (`peakElevation = targetBridgeElevation`) regardless of bridge length.
 * - Computes ramp lengths from `mappedBridgeLength` (`min(12.0 m, 30% of mapped bridge length)`),
 *   before any synthetic external approach segments are appended for standalone bridges.
 * - Adapts ramp lengths and longitudinal sampling density on short bridges (`5.0 m <= L < 40.0 m`)
 *   so at least `40%` of the bridge span remains flat at full `targetBridgeElevation`.
 * - Uses the documented `'abutment_headwall'` fallback when `mappedBridgeLength < 5.0 m`.
 */
export function buildBridgeProfile3D(options: BridgeProfileOptions): {
  profile: ProfiledPoint3D[];
  peakElevation: number;
  mappedBridgeLength: number;
  rampStartLength: number;
  rampEndLength: number;
  rampMode: BridgeRampMode;
} {
  const {
    points,
    baseElevation,
    targetBridgeElevation,
    connectsStartAtGrade,
    connectsEndAtGrade,
    connectsStartBridge,
    connectsEndBridge,
    maxSampleStep = 2.0,
  } = options;

  const cleanPts: [number, number][] = [];
  for (const pt of points) {
    if (
      cleanPts.length === 0 ||
      Math.hypot(pt[0] - cleanPts[cleanPts.length - 1][0], pt[1] - cleanPts[cleanPts.length - 1][1]) > 0.02
    ) {
      cleanPts.push(pt);
    }
  }

  if (cleanPts.length < 2) {
    return {
      profile: [],
      peakElevation: targetBridgeElevation,
      mappedBridgeLength: 0,
      rampStartLength: 0,
      rampEndLength: 0,
      rampMode: 'elevated_continuation',
    };
  }

  // Always preserve full grade separation as required by the elevation policy
  const peakElevation = targetBridgeElevation;
  const mappedBridgeLength = computePolylineLength(cleanPts);

  let workingPts = [...cleanPts];
  const isStandaloneStart = !connectsStartAtGrade && !connectsStartBridge;
  const isStandaloneEnd = !connectsEndAtGrade && !connectsEndBridge;
  const wantsInSpanStartRamp = connectsStartAtGrade && !connectsStartBridge;
  const wantsInSpanEndRamp = connectsEndAtGrade && !connectsEndBridge;

  // Determine ramp lengths from mappedBridgeLength BEFORE adding any synthetic standalone extensions
  const nominalRampLen = Math.min(
    DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS,
    mappedBridgeLength * DEFAULT_BRIDGE_RAMP_MAX_FRACTION
  );

  let rampStartLength = 0;
  let rampEndLength = 0;
  let rampMode: BridgeRampMode = 'elevated_continuation';

  if (mappedBridgeLength < MIN_RAMPED_BRIDGE_SPAN_METERS) {
    // Documented Fallback: span is too short (< 5.0m) to fit approach ramps without losing clearance.
    // Keep entire deck at full targetBridgeElevation and rely on vertical abutment headwalls.
    rampStartLength = 0;
    rampEndLength = 0;
    rampMode =
      connectsStartBridge && connectsEndBridge ? 'elevated_continuation' : 'abutment_headwall';
  } else {
    if (isStandaloneStart) {
      const dx = workingPts[0][0] - workingPts[1][0];
      const dz = workingPts[0][1] - workingPts[1][1];
      const l = Math.hypot(dx, dz) || 1;
      const ext = nominalRampLen;
      workingPts = [
        [workingPts[0][0] + (dx / l) * ext, workingPts[0][1] + (dz / l) * ext],
        ...workingPts,
      ];
      rampStartLength = ext;
    } else if (wantsInSpanStartRamp) {
      rampStartLength = nominalRampLen;
    }

    if (isStandaloneEnd) {
      const n = workingPts.length;
      const dx = workingPts[n - 1][0] - workingPts[n - 2][0];
      const dz = workingPts[n - 1][1] - workingPts[n - 2][1];
      const l = Math.hypot(dx, dz) || 1;
      const ext = nominalRampLen;
      workingPts = [
        ...workingPts,
        [workingPts[n - 1][0] + (dx / l) * ext, workingPts[n - 1][1] + (dz / l) * ext],
      ];
      rampEndLength = ext;
    } else if (wantsInSpanEndRamp) {
      rampEndLength = nominalRampLen;
    }

    // Guarantee that in-span ramps never consume more than (1 - MIN_CENTRAL_DECK_FRACTION) of mappedBridgeLength
    const inSpanRampBudget = mappedBridgeLength * (1.0 - MIN_CENTRAL_DECK_FRACTION);
    const activeInSpanRamps =
      (wantsInSpanStartRamp ? rampStartLength : 0) + (wantsInSpanEndRamp ? rampEndLength : 0);
    if (activeInSpanRamps > inSpanRampBudget && activeInSpanRamps > 1e-6) {
      const scale = inSpanRampBudget / activeInSpanRamps;
      if (wantsInSpanStartRamp) rampStartLength *= scale;
      if (wantsInSpanEndRamp) rampEndLength *= scale;
    }

    const hasAnyRamp = rampStartLength > 0 || rampEndLength > 0;
    if (!hasAnyRamp) {
      rampMode = 'elevated_continuation';
    } else if (
      (rampStartLength > 0 && rampStartLength < DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS - 1e-3) ||
      (rampEndLength > 0 && rampEndLength < DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS - 1e-3)
    ) {
      rampMode = 'adapted_ramp';
    } else {
      rampMode = 'standard_ramp';
    }
  }

  const totalLen = computePolylineLength(workingPts);
  const activeRampLengths = [rampStartLength, rampEndLength].filter((r) => r > 1e-3);
  const minActiveRamp =
    activeRampLengths.length > 0 ? Math.min(...activeRampLengths) : maxSampleStep;
  const effectiveSampleStep = Math.min(maxSampleStep, Math.max(0.35, minActiveRamp / 6));

  const evalElevationAt = (s: number): number => {
    if (rampStartLength > 1e-3 && s < rampStartLength) {
      const t = Math.min(Math.max(s / rampStartLength, 0), 1);
      const ease = 0.5 - 0.5 * Math.cos(Math.PI * t);
      return baseElevation + (peakElevation - baseElevation) * ease;
    }
    if (rampEndLength > 1e-3 && s > totalLen - rampEndLength) {
      const rem = totalLen - s;
      const t = Math.min(Math.max(rem / rampEndLength, 0), 1);
      const ease = 0.5 - 0.5 * Math.cos(Math.PI * t);
      return baseElevation + (peakElevation - baseElevation) * ease;
    }
    return peakElevation;
  };

  const profile: ProfiledPoint3D[] = [];
  let accum = 0;

  for (let i = 0; i < workingPts.length - 1; i++) {
    const p0 = workingPts[i];
    const p1 = workingPts[i + 1];
    const segLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (segLen < 1e-4) continue;

    // Ensure exact transition points (rampStartLength and totalLen - rampEndLength) are sampled
    const steps = Math.max(1, Math.ceil(segLen / effectiveSampleStep));
    const sampleFracs = new Set<number>();
    const startStep = i === 0 ? 0 : 1;
    for (let sIdx = startStep; sIdx <= steps; sIdx++) {
      sampleFracs.add(Number((sIdx / steps).toFixed(6)));
    }
    if (rampStartLength > accum + 1e-4 && rampStartLength < accum + segLen - 1e-4) {
      sampleFracs.add(Number(((rampStartLength - accum) / segLen).toFixed(6)));
    }
    const endRampStartS = totalLen - rampEndLength;
    if (
      rampEndLength > 1e-3 &&
      endRampStartS > accum + 1e-4 &&
      endRampStartS < accum + segLen - 1e-4
    ) {
      sampleFracs.add(Number(((endRampStartS - accum) / segLen).toFixed(6)));
    }

    const sortedFracs = Array.from(sampleFracs).sort((a, b) => a - b);
    for (const frac of sortedFracs) {
      const x = p0[0] + (p1[0] - p0[0]) * frac;
      const z = p0[1] + (p1[1] - p0[1]) * frac;
      const s = accum + segLen * frac;
      profile.push({
        x,
        y: evalElevationAt(s),
        z,
        arcLength: s,
      });
    }
    accum += segLen;
  }

  return {
    profile,
    peakElevation,
    mappedBridgeLength,
    rampStartLength,
    rampEndLength,
    rampMode,
  };
}

/**
 * Generates a 3D surface ribbon along a 3D profiled centerline `profile`.
 */
export function generateProfiledRibbon3D(
  profile: ProfiledPoint3D[],
  width: number
): THREE.BufferGeometry | null {
  if (!profile || profile.length < 2) return null;
  const n = profile.length;
  const halfW = width * 0.5;

  const tangents: [number, number][] = [];
  const slopesY: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = profile[i + 1].x - profile[i].x;
    const dz = profile[i + 1].z - profile[i].z;
    const dy = profile[i + 1].y - profile[i].y;
    const lenXZ = Math.hypot(dx, dz) || 1e-6;
    tangents.push([dx / lenXZ, dz / lenXZ]);
    slopesY.push(dy / lenXZ);
  }

  const positions = new Float32Array(n * 2 * 3);
  const normals = new Float32Array(n * 2 * 3);
  const indices = new Uint32Array((n - 1) * 6);

  for (let i = 0; i < n; i++) {
    let tx = 0;
    let tz = 0;
    let slope = 0;
    let miterScale = 1.0;

    if (i === 0) {
      [tx, tz] = tangents[0];
      slope = slopesY[0];
    } else if (i === n - 1) {
      [tx, tz] = tangents[n - 2];
      slope = slopesY[n - 2];
    } else {
      tx = tangents[i - 1][0] + tangents[i][0];
      tz = tangents[i - 1][1] + tangents[i][1];
      const l = Math.hypot(tx, tz) || 1e-6;
      tx /= l;
      tz /= l;
      slope = (slopesY[i - 1] + slopesY[i]) * 0.5;
      const dot = tangents[i - 1][0] * tangents[i][0] + tangents[i - 1][1] * tangents[i][1];
      const cosHalf = Math.sqrt(Math.max(0.1, (1 + dot) * 0.5));
      miterScale = Math.min(1.28, 1.0 / Math.max(0.76, cosHalf));
    }

    const nx = -tz;
    const nz = tx;
    const ox = nx * halfW * miterScale;
    const oz = nz * halfW * miterScale;

    // Surface normal tilted slightly along longitudinal slope
    const normX = -tx * slope;
    const normY = 1.0;
    const normZ = -tz * slope;
    const normLen = Math.hypot(normX, normY, normZ) || 1.0;

    const lIdx = i * 2;
    const rIdx = i * 2 + 1;

    positions[lIdx * 3] = profile[i].x + ox;
    positions[lIdx * 3 + 1] = profile[i].y;
    positions[lIdx * 3 + 2] = profile[i].z + oz;
    normals[lIdx * 3] = normX / normLen;
    normals[lIdx * 3 + 1] = normY / normLen;
    normals[lIdx * 3 + 2] = normZ / normLen;

    positions[rIdx * 3] = profile[i].x - ox;
    positions[rIdx * 3 + 1] = profile[i].y;
    positions[rIdx * 3 + 2] = profile[i].z - oz;
    normals[rIdx * 3] = normX / normLen;
    normals[rIdx * 3 + 1] = normY / normLen;
    normals[rIdx * 3 + 2] = normZ / normLen;
  }

  let ptr = 0;
  for (let i = 0; i < n - 1; i++) {
    const l0 = i * 2;
    const r0 = i * 2 + 1;
    const l1 = (i + 1) * 2;
    const r1 = (i + 1) * 2 + 1;
    indices[ptr++] = l0;
    indices[ptr++] = l1;
    indices[ptr++] = r0;
    indices[ptr++] = r0;
    indices[ptr++] = l1;
    indices[ptr++] = r1;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

/**
 * Generates 3D bridge deck substructure (side fascia walls, soffit underside, and solid ramp abutment walls
 * reaching down to ground level under the sloped approach ramps), plus side safety parapets and support piers.
 */
export function generateBridgeStructureGeometries(
  profile: ProfiledPoint3D[],
  width: number,
  peakElevation: number,
  deckThickness: number = 0.36
): {
  substructureGeo: THREE.BufferGeometry | null;
  parapetGeo: THREE.BufferGeometry | null;
  piersGeo: THREE.BufferGeometry | null;
} {
  if (!profile || profile.length < 2) {
    return { substructureGeo: null, parapetGeo: null, piersGeo: null };
  }

  const subPos: number[] = [];
  const subNorm: number[] = [];
  const subIdx: number[] = [];
  let subV = 0;

  const parPos: number[] = [];
  const parNorm: number[] = [];
  const parIdx: number[] = [];
  let parV = 0;

  const pierPos: number[] = [];
  const pierNorm: number[] = [];
  const pierIdx: number[] = [];
  let pierV = 0;

  const halfW = width * 0.5;
  const parapetW = 0.22;
  const parapetH = 0.36;
  const groundY = ELEVATION_POLICY.GROUND_COVER_SURFACE;

  const appendQuad = (
    posArr: number[],
    normArr: number[],
    idxArr: number[],
    vCount: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number
  ): number => {
    posArr.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let k = 0; k < 4; k++) normArr.push(nx, ny, nz);
    idxArr.push(vCount, vCount + 1, vCount + 2, vCount, vCount + 2, vCount + 3);
    return vCount + 4;
  };

  for (let i = 0; i < profile.length - 1; i++) {
    const p0 = profile[i];
    const p1 = profile[i + 1];
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;

    const tx = dx / len;
    const tz = dz / len;
    const nx = -tz;
    const nz = tx;

    // On ramp sections (where deck is transitioning below peakElevation), extend side abutment walls down to groundY
    // so the bridge approach forms a solid connected embankment; on main span, use deckThickness fascia.
    const isRampSeg = p0.y < peakElevation - 0.08 || p1.y < peakElevation - 0.08;
    const botY0 = isRampSeg ? groundY : Math.max(groundY, p0.y - deckThickness);
    const botY1 = isRampSeg ? groundY : Math.max(groundY, p1.y - deckThickness);

    const l0x = p0.x + nx * halfW;
    const l0z = p0.z + nz * halfW;
    const l1x = p1.x + nx * halfW;
    const l1z = p1.z + nz * halfW;

    const r0x = p0.x - nx * halfW;
    const r0z = p0.z - nz * halfW;
    const r1x = p1.x - nx * halfW;
    const r1z = p1.z - nz * halfW;

    // Left fascia / abutment wall
    subV = appendQuad(
      subPos, subNorm, subIdx, subV,
      l0x, botY0, l0z,
      l1x, botY1, l1z,
      l1x, p1.y, l1z,
      l0x, p0.y, l0z,
      nx, 0, nz
    );

    // Right fascia / abutment wall
    subV = appendQuad(
      subPos, subNorm, subIdx, subV,
      r1x, botY1, r1z,
      r0x, botY0, r0z,
      r0x, p0.y, r0z,
      r1x, p1.y, r1z,
      -nx, 0, -nz
    );

    // Underside soffit quad
    subV = appendQuad(
      subPos, subNorm, subIdx, subV,
      l0x, botY0, l0z,
      r0x, botY0, r0z,
      r1x, botY1, r1z,
      l1x, botY1, l1z,
      0, -1, 0
    );

    // Start vertical abutment headwall down to groundY when start of bridge is elevated
    if (i === 0 && p0.y > groundY + 0.08) {
      subV = appendQuad(
        subPos, subNorm, subIdx, subV,
        r0x, groundY, r0z,
        l0x, groundY, l0z,
        l0x, p0.y, l0z,
        r0x, p0.y, r0z,
        -tx, 0, -tz
      );
    }

    // End vertical abutment headwall down to groundY when end of bridge is elevated
    if (i === profile.length - 2 && p1.y > groundY + 0.08) {
      subV = appendQuad(
        subPos, subNorm, subIdx, subV,
        l1x, groundY, l1z,
        r1x, groundY, r1z,
        r1x, p1.y, r1z,
        l1x, p1.y, l1z,
        tx, 0, tz
      );
    }

    // Side safety parapets / curbs along both left and right edges (only where elevated >= 0.25m above ground)
    if (p0.y > groundY + 0.15 || p1.y > groundY + 0.15) {
      for (const sideSign of [1, -1]) {
        const outerOff = sideSign * halfW;
        const innerOff = sideSign * Math.max(0, halfW - parapetW);
        const minOff = Math.min(outerOff, innerOff);
        const maxOff = Math.max(outerOff, innerOff);

        const a0x = p0.x + nx * maxOff;
        const a0z = p0.z + nz * maxOff;
        const a1x = p1.x + nx * maxOff;
        const a1z = p1.z + nz * maxOff;

        const b0x = p0.x + nx * minOff;
        const b0z = p0.z + nz * minOff;
        const b1x = p1.x + nx * minOff;
        const b1z = p1.z + nz * minOff;

        const top0 = p0.y + parapetH;
        const top1 = p1.y + parapetH;

        // Top face of parapet (CCW from above)
        parV = appendQuad(
          parPos, parNorm, parIdx, parV,
          a0x, top0, a0z,
          a1x, top1, a1z,
          b1x, top1, b1z,
          b0x, top0, b0z,
          0, 1, 0
        );

        // Outer wall of parapet
        parV = appendQuad(
          parPos, parNorm, parIdx, parV,
          a0x, p0.y, a0z,
          a1x, p1.y, a1z,
          a1x, top1, a1z,
          a0x, top0, a0z,
          nx, 0, nz
        );

        // Inner wall of parapet
        parV = appendQuad(
          parPos, parNorm, parIdx, parV,
          b1x, p1.y, b1z,
          b0x, p0.y, b0z,
          b0x, top0, b0z,
          b1x, top1, b1z,
          -nx, 0, -nz
        );
      }
    }
  }

  // Generate support piers along the elevated span for bridges with span >= 18m
  const totalLen = profile[profile.length - 1].arcLength;
  if (totalLen >= 18.0) {
    const pierSpacing = 20.0;
    const startS = Math.max(9.0, totalLen * 0.25);
    const endS = Math.min(totalLen - 9.0, totalLen * 0.75);

    const sampleDates: number[] = [];
    if (endS >= startS) {
      for (let d = startS; d <= endS + 0.1; d += pierSpacing) {
        sampleDates.push(d);
      }
    }
    if (sampleDates.length === 0) {
      sampleDates.push(totalLen * 0.5);
    }

    const pierHalfThick = 0.42;
    const pierHalfWidth = Math.max(0.55, width * 0.34);

    for (const targetS of sampleDates) {
      // Find segment containing targetS
      let segIdx = 0;
      for (let i = 0; i < profile.length - 1; i++) {
        if (profile[i + 1].arcLength >= targetS) {
          segIdx = i;
          break;
        }
      }
      const p0 = profile[segIdx];
      const p1 = profile[Math.min(segIdx + 1, profile.length - 1)];
      if (p0.y < groundY + 1.0) continue;

      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const len = Math.hypot(dx, dz) || 1;
      const tx = dx / len;
      const tz = dz / len;
      const nx = -tz;
      const nz = tx;

      const cx = (p0.x + p1.x) * 0.5;
      const cz = (p0.z + p1.z) * 0.5;
      const topY = Math.min(p0.y, p1.y) - deckThickness * 0.9;
      const baseY = ELEVATION_POLICY.GROUND;
      if (topY <= baseY + 0.3) continue;

      const fx = tx * pierHalfThick;
      const fz = tz * pierHalfThick;
      const sx = nx * pierHalfWidth;
      const sz = nz * pierHalfWidth;

      const cFL: [number, number] = [cx + fx + sx, cz + fz + sz];
      const cFR: [number, number] = [cx + fx - sx, cz + fz - sz];
      const cBR: [number, number] = [cx - fx - sx, cz - fz - sz];
      const cBL: [number, number] = [cx - fx + sx, cz - fz + sz];

      // 4 vertical walls of the support pier
      pierV = appendQuad(
        pierPos, pierNorm, pierIdx, pierV,
        cBL[0], baseY, cBL[1],
        cFL[0], baseY, cFL[1],
        cFL[0], topY, cFL[1],
        cBL[0], topY, cBL[1],
        nx, 0, nz
      );
      pierV = appendQuad(
        pierPos, pierNorm, pierIdx, pierV,
        cFR[0], baseY, cFR[1],
        cBR[0], baseY, cBR[1],
        cBR[0], topY, cBR[1],
        cFR[0], topY, cFR[1],
        -nx, 0, -nz
      );
      pierV = appendQuad(
        pierPos, pierNorm, pierIdx, pierV,
        cFL[0], baseY, cFL[1],
        cFR[0], baseY, cFR[1],
        cFR[0], topY, cFR[1],
        cFL[0], topY, cFL[1],
        tx, 0, tz
      );
      pierV = appendQuad(
        pierPos, pierNorm, pierIdx, pierV,
        cBR[0], baseY, cBR[1],
        cBL[0], baseY, cBL[1],
        cBL[0], topY, cBL[1],
        cBR[0], topY, cBL[1],
        -tx, 0, -tz
      );
    }
  }

  const makeGeo = (pos: number[], norm: number[], idx: number[]): THREE.BufferGeometry | null => {
    if (pos.length === 0 || idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
    g.setIndex(idx);
    return g;
  };

  return {
    substructureGeo: makeGeo(subPos, subNorm, subIdx),
    parapetGeo: makeGeo(parPos, parNorm, parIdx),
    piersGeo: makeGeo(pierPos, pierNorm, pierIdx),
  };
}

/**
 * Generates 3D tunnel portal headwall arches, dark recessed portal entrance mouths,
 * and a dashed underground corridor trace for a subterranean road, path, or railway tunnel.
 * All vertices are kept at Y >= ELEVATION_POLICY.GROUND_COVER_SURFACE (>= 0.025m)
 * so surface mesh invariants (y >= 0) and depth-buffer tests are strictly satisfied.
 */
export function generateTunnelPortalAndTraceGeometries(
  points: [number, number][],
  width: number,
  isPedestrianOrCycle: boolean = false
): {
  portalStructureGeo: THREE.BufferGeometry | null;
  portalMouthGeo: THREE.BufferGeometry | null;
  undergroundTraceGeo: THREE.BufferGeometry | null;
} {
  const cleanPts: [number, number][] = [];
  for (const pt of points) {
    if (
      cleanPts.length === 0 ||
      Math.hypot(pt[0] - cleanPts[cleanPts.length - 1][0], pt[1] - cleanPts[cleanPts.length - 1][1]) > 0.02
    ) {
      cleanPts.push(pt);
    }
  }

  if (cleanPts.length < 2) {
    return { portalStructureGeo: null, portalMouthGeo: null, undergroundTraceGeo: null };
  }

  const portalPos: number[] = [];
  const portalNorm: number[] = [];
  const portalIdx: number[] = [];
  let portalV = 0;

  const mouthPos: number[] = [];
  const mouthNorm: number[] = [];
  const mouthIdx: number[] = [];
  let mouthV = 0;

  const tracePos: number[] = [];
  const traceNorm: number[] = [];
  const traceIdx: number[] = [];
  let traceV = 0;

  const appendBox = (
    posArr: number[],
    normArr: number[],
    idxArr: number[],
    vBase: number,
    cx: number,
    cz: number,
    tx: number,
    tz: number,
    lenAlongT: number,
    widthAlongN: number,
    yBottom: number,
    yTop: number
  ): number => {
    const nx = -tz;
    const nz = tx;
    const hl = lenAlongT * 0.5;
    const hw = widthAlongN * 0.5;

    const fx = tx * hl;
    const fz = tz * hl;
    const sx = nx * hw;
    const sz = nz * hw;

    // 4 corners in XZ: FL (+f +s), FR (+f -s), BR (-f -s), BL (-f +s)
    const flX = cx + fx + sx, flZ = cz + fz + sz;
    const frX = cx + fx - sx, frZ = cz + fz - sz;
    const brX = cx - fx - sx, brZ = cz - fz - sz;
    const blX = cx - fx + sx, blZ = cz - fz + sz;

    const pushFace = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      dx: number, dy: number, dz: number,
      ex: number, ey: number, ez: number,
      fnx: number, fny: number, fnz: number
    ) => {
      posArr.push(ax, ay, az, bx, by, bz, dx, dy, dz, ex, ey, ez);
      for (let k = 0; k < 4; k++) normArr.push(fnx, fny, fnz);
      idxArr.push(vBase, vBase + 1, vBase + 2, vBase, vBase + 2, vBase + 3);
      vBase += 4;
    };

    // Top face (CCW from above: BL -> FL -> FR -> BR)
    pushFace(blX, yTop, blZ, flX, yTop, flZ, frX, yTop, frZ, brX, yTop, brZ, 0, 1, 0);
    // Left wall (+nx, +nz)
    pushFace(blX, yBottom, blZ, flX, yBottom, flZ, flX, yTop, flZ, blX, yTop, blZ, nx, 0, nz);
    // Right wall (-nx, -nz)
    pushFace(frX, yBottom, frZ, brX, yBottom, brZ, brX, yTop, brZ, frX, yTop, frZ, -nx, 0, -nz);
    // Front wall (+tx, +tz)
    pushFace(flX, yBottom, flZ, frX, yBottom, frZ, frX, yTop, frZ, flX, yTop, flZ, tx, 0, tz);
    // Back wall (-tx, -tz)
    pushFace(brX, yBottom, brZ, blX, yBottom, blZ, blX, yTop, blZ, brX, yTop, brZ, -tx, 0, -tz);

    return vBase;
  };

  const emitPortalAt = (px: number, pz: number, inTx: number, inTz: number) => {
    const nx = -inTz;
    const nz = inTx;

    const baseY = ELEVATION_POLICY.ROAD_SURFACE;
    const portalHeight = isPedestrianOrCycle ? 2.15 : 3.1;
    const lintelHeight = isPedestrianOrCycle ? 0.52 : 0.72;
    const pillarWidth = isPedestrianOrCycle ? 0.42 : 0.58;
    const hoodDepth = isPedestrianOrCycle ? 1.8 : 2.5;
    const wingLen = isPedestrianOrCycle ? 1.6 : 2.2;
    const openW = Math.max(width + 0.25, isPedestrianOrCycle ? 2.2 : 3.8);
    const halfOpen = openW * 0.5;

    // 1. Left & Right Portal Retaining Pillars (hooded entrance frame)
    const hoodCenterX = px + inTx * (hoodDepth * 0.5);
    const hoodCenterZ = pz + inTz * (hoodDepth * 0.5);
    const pillarOffset = halfOpen + pillarWidth * 0.5;

    portalV = appendBox(
      portalPos, portalNorm, portalIdx, portalV,
      hoodCenterX + nx * pillarOffset,
      hoodCenterZ + nz * pillarOffset,
      inTx, inTz,
      hoodDepth,
      pillarWidth,
      baseY,
      baseY + portalHeight
    );

    portalV = appendBox(
      portalPos, portalNorm, portalIdx, portalV,
      hoodCenterX - nx * pillarOffset,
      hoodCenterZ - nz * pillarOffset,
      inTx, inTz,
      hoodDepth,
      pillarWidth,
      baseY,
      baseY + portalHeight
    );

    // 2. Overhead Portal Arch / Headwall Lintel Beam
    portalV = appendBox(
      portalPos, portalNorm, portalIdx, portalV,
      hoodCenterX,
      hoodCenterZ,
      inTx, inTz,
      hoodDepth,
      openW + pillarWidth * 2,
      baseY + portalHeight - lintelHeight,
      baseY + portalHeight
    );

    // 3. Approach Retaining Wing Walls flanking the entrance ramp
    const wingCenterX = px - inTx * (wingLen * 0.5);
    const wingCenterZ = pz - inTz * (wingLen * 0.5);
    const wingWallH = portalHeight * 0.48;

    portalV = appendBox(
      portalPos, portalNorm, portalIdx, portalV,
      wingCenterX + nx * pillarOffset,
      wingCenterZ + nz * pillarOffset,
      inTx, inTz,
      wingLen,
      pillarWidth * 0.85,
      baseY,
      baseY + wingWallH
    );

    portalV = appendBox(
      portalPos, portalNorm, portalIdx, portalV,
      wingCenterX - nx * pillarOffset,
      wingCenterZ - nz * pillarOffset,
      inTx, inTz,
      wingLen,
      pillarWidth * 0.85,
      baseY,
      baseY + wingWallH
    );

    // 4. Dark Recessed Tunnel Mouth Mat & Shadow Backwall inside the portal arch
    const mouthY = ELEVATION_POLICY.ROAD_SURFACE + 0.002;
    const mStartX = px - inTx * 0.25;
    const mStartZ = pz - inTz * 0.25;
    const mEndX = px + inTx * (hoodDepth * 0.92);
    const mEndZ = pz + inTz * (hoodDepth * 0.92);
    const mHalfW = halfOpen * 0.96;

    // Horizontal dark ramp threshold mat (CCW from above)
    mouthPos.push(
      mStartX + nx * mHalfW, mouthY, mStartZ + nz * mHalfW,
      mEndX + nx * mHalfW, mouthY, mEndZ + nz * mHalfW,
      mEndX - nx * mHalfW, mouthY, mEndZ - nz * mHalfW,
      mStartX - nx * mHalfW, mouthY, mStartZ - nz * mHalfW
    );
    for (let k = 0; k < 4; k++) mouthNorm.push(0, 1, 0);
    mouthIdx.push(mouthV, mouthV + 1, mouthV + 2, mouthV, mouthV + 2, mouthV + 3);
    mouthV += 4;

    // Dark vertical shadow curtain inside the portal opening
    const curtainX = px + inTx * (hoodDepth * 0.72);
    const curtainZ = pz + inTz * (hoodDepth * 0.72);
    const curtainTop = baseY + portalHeight - lintelHeight;
    mouthPos.push(
      curtainX - nx * mHalfW, mouthY, curtainZ - nz * mHalfW,
      curtainX + nx * mHalfW, mouthY, curtainZ + nz * mHalfW,
      curtainX + nx * mHalfW, curtainTop, curtainZ + nz * mHalfW,
      curtainX - nx * mHalfW, curtainTop, curtainZ - nz * mHalfW
    );
    for (let k = 0; k < 4; k++) mouthNorm.push(-inTx, 0, -inTz);
    mouthIdx.push(mouthV, mouthV + 1, mouthV + 2, mouthV, mouthV + 2, mouthV + 3);
    mouthV += 4;
  };

  // Start portal
  const dx0 = cleanPts[1][0] - cleanPts[0][0];
  const dz0 = cleanPts[1][1] - cleanPts[0][1];
  const len0 = Math.hypot(dx0, dz0) || 1;
  emitPortalAt(cleanPts[0][0], cleanPts[0][1], dx0 / len0, dz0 / len0);

  // End portal
  const n = cleanPts.length;
  const dxn = cleanPts[n - 2][0] - cleanPts[n - 1][0];
  const dzn = cleanPts[n - 2][1] - cleanPts[n - 1][1];
  const lenn = Math.hypot(dxn, dzn) || 1;
  emitPortalAt(cleanPts[n - 1][0], cleanPts[n - 1][1], dxn / lenn, dzn / lenn);

  // 5. Dashed Underground Alignment Trace between the two portals
  const totalLen = computePolylineLength(cleanPts);
  if (totalLen >= 8.0) {
    const dashLen = 1.5;
    const dashSpacing = 5.2;
    const traceHalfW = Math.min(Math.max(width * 0.22, 0.35), 0.75);
    const traceY = ELEVATION_POLICY.ROAD_SURFACE + 0.003;

    let accum = 0;
    for (let i = 0; i < cleanPts.length - 1; i++) {
      const p0 = cleanPts[i];
      const p1 = cleanPts[i + 1];
      const segLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (segLen < 1e-3) continue;
      const tx = (p1[0] - p0[0]) / segLen;
      const tz = (p1[1] - p0[1]) / segLen;
      const nx = -tz;
      const nz = tx;

      for (let d = 0.8; d + dashLen <= segLen - 0.4; d += dashSpacing) {
        const globalS = accum + d;
        if (globalS < 3.2 || globalS + dashLen > totalLen - 3.2) continue;

        const c0x = p0[0] + tx * d;
        const c0z = p0[1] + tz * d;
        const c1x = p0[0] + tx * (d + dashLen);
        const c1z = p0[1] + tz * (d + dashLen);

        tracePos.push(
          c0x + nx * traceHalfW, traceY, c0z + nz * traceHalfW,
          c1x + nx * traceHalfW, traceY, c1z + nz * traceHalfW,
          c1x - nx * traceHalfW, traceY, c1z - nz * traceHalfW,
          c0x - nx * traceHalfW, traceY, c0z - nz * traceHalfW
        );
        for (let k = 0; k < 4; k++) traceNorm.push(0, 1, 0);
        traceIdx.push(traceV, traceV + 1, traceV + 2, traceV, traceV + 2, traceV + 3);
        traceV += 4;
      }
      accum += segLen;
    }
  }

  const makeGeo = (pos: number[], norm: number[], idx: number[]): THREE.BufferGeometry | null => {
    if (pos.length === 0 || idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
    g.setIndex(idx);
    return g;
  };

  return {
    portalStructureGeo: makeGeo(portalPos, portalNorm, portalIdx),
    portalMouthGeo: makeGeo(mouthPos, mouthNorm, mouthIdx),
    undergroundTraceGeo: makeGeo(tracePos, traceNorm, traceIdx),
  };
}
