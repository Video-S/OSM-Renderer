import { RailwayFeature } from '../../../types/MapFeature';
import { ELEVATION_POLICY } from '../../ElevationPolicy';

/**
 * Canonical physical and visual railway dimensions validated in Milestone 2.1 (`TKT-002`).
 */
export const RAILWAY_DIMENSION_SPEC = {
  innerGaugeMeters: 1.435,
  physicalRailHeadWidthMeters: 0.072,
  physicalCenterToCenterGaugeMeters: 1.435 + 0.072,
  visualRailWidthMeters: 0.2,
  visualTramRailWidthMeters: 0.16,
  visualCenterToCenterGaugeMeters: 1.635,
  visualTramCenterToCenterGaugeMeters: 1.595,
  ballastWidthMeters: 3.5,
  tramBallastWidthMeters: 2.5,
  sleeperWidthMeters: 2.5,
  tramSleeperWidthMeters: 2.0,
  hostSleeperClearanceHalfWidthMeters: 1.21,
  physicalSleeperLengthMeters: 0.26,
  visualSleeperLengthMeters: 0.36,
  candidateB3DSleeperLengthMeters: 0.28,
  physicalSleeperPeriodMeters: 0.6,
  candidateBCloseSleeperPeriodMeters: 0.725,
  candidateBCloseTramSleeperPeriodMeters: 0.825,
  visualSleeperPeriodMeters: 1.45,
  visualTramSleeperPeriodMeters: 1.65,
  sleeperStepHeightMeters: ELEVATION_POLICY.RAILWAY_SLEEPERS - ELEVATION_POLICY.RAILWAY_BALLAST,
  railStepHeightMeters: ELEVATION_POLICY.RAILWAY_RAILS - ELEVATION_POLICY.RAILWAY_SLEEPERS,
  candidateB3DSleeperHeightMeters: 0.024,
  candidateB3DRailHeightMeters: 0.026,
  hybridCloseZoomThresholdPxPerMeter: 4.5,
  switchBladeTaperLengthMeters: 3.2,
} as const;

export interface SleeperBearerBox3D {
  cx: number;
  cz: number;
  yBottom: number;
  yTop: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  halfLen: number;
  halfWidthLeft: number;
  halfWidthRight: number;
  trackId: string;
  supportedTrackIds?: string[];
  isTurnoutBearer?: boolean;
  isSplitSegment?: boolean;
}

export interface HostTrackSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  len: number;
  gaugeCenterOffset: number;
  trackId: string;
  lastQueryTag: number;
}

export interface TransverseTrackMatch {
  trackId: string;
  signedV: number;
  absDist: number;
  cosAngle: number;
  gaugeCenterOffset: number;
}

const SPATIAL_GRID_CELL_SIZE_METERS = 8;

/**
 * Spatial index of railway track segments supporting 8m × 8m uniform spatial hash grid
 * acceleration for switch-zone clearance queries, switch-blade taper checks, and
 * transverse multi-track turnout/parallel sleeper queries.
 */
export class HostTrackSpatialIndex {
  private segments: HostTrackSegment[] = [];
  private grid = new Map<string, HostTrackSegment[]>();
  private queryTagCounter = 0;

  public totalQueries = 0;
  public totalSegmentsExamined = 0;
  public maxSegmentsInSingleQuery = 0;
  public totalDistanceCalculations = 0;
  public queryTimeMs = 0;
  public readonly useSpatialGrid: boolean;

  constructor(useSpatialGrid: boolean = true) {
    this.useSpatialGrid = useSpatialGrid;
  }

  get registeredSegmentsCount(): number {
    return this.segments.length;
  }

  get gridCellsCount(): number {
    return this.grid.size;
  }

  registerTrack(pts: [number, number][], gaugeCenterOffset: number, trackId: string): void {
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0];
      const az = pts[i][1];
      const bx = pts[i + 1][0];
      const bz = pts[i + 1][1];
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;
      const tx = dx / len;
      const tz = dz / len;
      const seg: HostTrackSegment = {
        ax,
        az,
        bx,
        bz,
        tx,
        tz,
        nx: -tz,
        nz: tx,
        len,
        gaugeCenterOffset,
        trackId,
        lastQueryTag: 0,
      };
      this.segments.push(seg);

      if (this.useSpatialGrid) {
        const pad = 0.5;
        const gx0 = Math.floor((Math.min(ax, bx) - pad) / SPATIAL_GRID_CELL_SIZE_METERS);
        const gx1 = Math.floor((Math.max(ax, bx) + pad) / SPATIAL_GRID_CELL_SIZE_METERS);
        const gz0 = Math.floor((Math.min(az, bz) - pad) / SPATIAL_GRID_CELL_SIZE_METERS);
        const gz1 = Math.floor((Math.max(az, bz) + pad) / SPATIAL_GRID_CELL_SIZE_METERS);
        for (let gx = gx0; gx <= gx1; gx++) {
          for (let gz = gz0; gz <= gz1; gz++) {
            const key = `${gx},${gz}`;
            let bucket = this.grid.get(key);
            if (!bucket) {
              bucket = [];
              this.grid.set(key, bucket);
            }
            bucket.push(seg);
          }
        }
      }
    }
  }

  forEachCandidateSegment(
    px: number,
    pz: number,
    excludeTrackId: string,
    visitor: (seg: HostTrackSegment) => boolean | void
  ): void {
    const t0 = performance.now();
    this.totalQueries++;
    let examined = 0;

    if (this.useSpatialGrid) {
      const tag = ++this.queryTagCounter;
      const cx = Math.floor(px / SPATIAL_GRID_CELL_SIZE_METERS);
      const cz = Math.floor(pz / SPATIAL_GRID_CELL_SIZE_METERS);
      outer: for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.grid.get(`${cx + dx},${cz + dz}`);
          if (bucket) {
            for (let i = 0; i < bucket.length; i++) {
              const seg = bucket[i];
              if (seg.lastQueryTag !== tag) {
                seg.lastQueryTag = tag;
                if (seg.trackId !== excludeTrackId) {
                  examined++;
                  if (visitor(seg) === true) break outer;
                }
              }
            }
          }
        }
      }
    } else {
      for (let i = 0; i < this.segments.length; i++) {
        const seg = this.segments[i];
        if (seg.trackId !== excludeTrackId) {
          examined++;
          if (visitor(seg) === true) break;
        }
      }
    }

    this.totalSegmentsExamined += examined;
    if (examined > this.maxSegmentsInSingleQuery) {
      this.maxSegmentsInSingleQuery = examined;
    }
    this.queryTimeMs += performance.now() - t0;
  }

  queryMinDistanceToHostCenterline(
    px: number,
    pz: number,
    excludeTrackId: string
  ): { minDist: number; hostSegment: HostTrackSegment | null } {
    let minDist = 999;
    let hostSegment: HostTrackSegment | null = null;
    this.forEachCandidateSegment(px, pz, excludeTrackId, (seg) => {
      const dx = px - seg.ax;
      const dz = pz - seg.az;
      const u = dx * seg.tx + dz * seg.tz;
      if (u < -0.05 || u > seg.len + 0.05) return;
      this.totalDistanceCalculations++;
      const clampedU = Math.max(0, Math.min(seg.len, u));
      const qx = seg.ax + seg.tx * clampedU;
      const qz = seg.az + seg.tz * clampedU;
      const d = Math.hypot(px - qx, pz - qz);
      if (d < minDist) {
        minDist = d;
        hostSegment = seg;
      }
    });
    return { minDist, hostSegment };
  }

  hasHostTrackStrictlyAlongside(
    px: number,
    pz: number,
    excludeTrackId: string,
    maxDist: number = 1.8
  ): boolean {
    let found = false;
    this.forEachCandidateSegment(px, pz, excludeTrackId, (seg) => {
      const dx = px - seg.ax;
      const dz = pz - seg.az;
      const u = dx * seg.tx + dz * seg.tz;
      if (u < 0.02 || u > seg.len - 0.02) return;
      this.totalDistanceCalculations++;
      const qx = seg.ax + seg.tx * u;
      const qz = seg.az + seg.tz * u;
      if (Math.hypot(px - qx, pz - qz) <= maxDist) {
        found = true;
        return true;
      }
    });
    return found;
  }

  queryMinDistanceToHostRail(px: number, pz: number, excludeTrackId: string): number {
    let minDist = 999;
    this.forEachCandidateSegment(px, pz, excludeTrackId, (seg) => {
      const dx = px - seg.ax;
      const dz = pz - seg.az;
      const u = dx * seg.tx + dz * seg.tz;
      if (u < -0.15 || u > seg.len + 0.15) return;
      const clampedU = Math.max(0, Math.min(seg.len, u));
      const qx = seg.ax + seg.tx * clampedU;
      const qz = seg.az + seg.tz * clampedU;
      for (const side of [-1, 1]) {
        this.totalDistanceCalculations++;
        const rx = qx + seg.nx * seg.gaugeCenterOffset * side;
        const rz = qz + seg.nz * seg.gaugeCenterOffset * side;
        const d = Math.hypot(px - rx, pz - rz);
        if (d < minDist) minDist = d;
      }
    });
    return minDist;
  }

  queryTransverseTracks(
    px: number,
    pz: number,
    tx: number,
    tz: number,
    nx: number,
    nz: number,
    excludeTrackId: string,
    maxSearchDist: number = 3.2
  ): TransverseTrackMatch[] {
    const byTrack = new Map<string, TransverseTrackMatch>();
    this.forEachCandidateSegment(px, pz, excludeTrackId, (seg) => {
      const dx = px - seg.ax;
      const dz = pz - seg.az;
      const u = dx * seg.tx + dz * seg.tz;
      if (u < -0.25 || u > seg.len + 0.25) return;
      this.totalDistanceCalculations++;
      const clampedU = Math.max(0, Math.min(seg.len, u));
      const qx = seg.ax + seg.tx * clampedU;
      const qz = seg.az + seg.tz * clampedU;
      const vx = qx - px;
      const vz = qz - pz;
      const absDist = Math.hypot(vx, vz);
      if (absDist > maxSearchDist) return;
      const signedV = vx * nx + vz * nz;
      const cosAngle = Math.abs(tx * seg.tx + tz * seg.tz);
      const existing = byTrack.get(seg.trackId);
      if (!existing || absDist < existing.absDist) {
        byTrack.set(seg.trackId, {
          trackId: seg.trackId,
          signedV,
          absDist,
          cosAngle,
          gaugeCenterOffset: seg.gaugeCenterOffset,
        });
      }
    });
    return Array.from(byTrack.values());
  }
}

/**
 * Single-interval lateral subtraction `[a0, a1] \ [b0, b1]`.
 */
export function subtractLateralInterval(
  a0: number,
  a1: number,
  b0: number,
  b1: number
): [number, number] | null {
  if (b1 <= a0 || b0 >= a1) return [a0, a1];
  if (b0 <= a0 + 0.04 && b1 >= a1 - 0.04) return null;
  if (b0 <= a0 + 0.04) return [Math.max(a0, b1), a1];
  if (b1 >= a1 - 0.04) return [a0, Math.min(a1, b0)];
  const rightRem = a1 - b1;
  const leftRem = b0 - a0;
  return b0 >= 0
    ? leftRem >= rightRem
      ? [a0, b0]
      : [b1, a1]
    : rightRem >= leftRem
      ? [b1, a1]
      : [a0, b0];
}

/**
 * Multi-interval lateral subtraction: subtracts `[b0, b1]` from a list of intervals,
 * keeping all remaining sub-segments with width `>= minValidWidth` (default `0.38 m`).
 */
export function subtractIntervalFromList(
  intervals: Array<[number, number]>,
  b0: number,
  b1: number,
  minValidWidth: number = 0.38
): Array<[number, number]> {
  if (b1 <= b0) return intervals;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < intervals.length; i++) {
    const [a0, a1] = intervals[i];
    if (b1 <= a0 || b0 >= a1) {
      out.push([a0, a1]);
    } else {
      if (b0 - a0 >= minValidWidth) out.push([a0, b0]);
      if (a1 - b1 >= minValidWidth) out.push([b1, a1]);
    }
  }
  return out;
}

/**
 * Evaluates the strictly interior perpendicular distance from `(px, pz)` to `poly`.
 */
export function queryInteriorPerpDistanceToPolyline(
  px: number,
  pz: number,
  poly: [number, number][]
): number | null {
  let minDist = Infinity;
  let found = false;
  const numSegs = poly.length - 1;
  for (let i = 0; i < numSegs; i++) {
    const ax = poly[i][0];
    const az = poly[i][1];
    const dx = poly[i + 1][0] - ax;
    const dz = poly[i + 1][1] - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const proj = ((px - ax) * dx + (pz - az) * dz) / len;
    if ((i === 0 && proj < -0.05) || (i === numSegs - 1 && proj > len + 0.05)) continue;
    const clamped = Math.max(0, Math.min(len, proj));
    const qx = ax + (dx / len) * clamped;
    const qz = az + (dz / len) * clamped;
    const d = Math.hypot(px - qx, pz - qz);
    if (d < minDist) {
      minDist = d;
      found = true;
    }
  }
  return found ? minDist : null;
}

/**
 * Classifies whether two railway tracks are in a genuine converging/diverging turnout throat
 * (`true`) versus running as independent closely spaced parallel tracks (`false`).
 */
export function isTurnoutThroatPair(
  selfPts: [number, number][],
  otherPts: [number, number][] | undefined,
  sampleX: number,
  sampleZ: number,
  currentDist: number
): boolean {
  if (currentDist <= 1.68) return true;
  if (!otherPts || otherPts.length < 2 || selfPts.length < 2) return false;

  let bestDistSq = Infinity;
  let bestSegIdx = 0;
  let bestSegOffset = 0;
  for (let i = 0; i < otherPts.length - 1; i++) {
    const ax = otherPts[i][0];
    const az = otherPts[i][1];
    const dx = otherPts[i + 1][0] - ax;
    const dz = otherPts[i + 1][1] - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const proj = Math.max(0, Math.min(len, ((sampleX - ax) * dx + (sampleZ - az) * dz) / len));
    const qx = ax + (dx / len) * proj;
    const qz = az + (dz / len) * proj;
    const dSq = (sampleX - qx) * (sampleX - qx) + (sampleZ - qz) * (sampleZ - qz);
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestSegIdx = i;
      bestSegOffset = proj;
    }
  }

  const sampleAlongOther = (deltaS: number): [number, number] | null => {
    let segIdx = bestSegIdx;
    let rem = bestSegOffset + deltaS;
    while (rem < 0 && segIdx > 0) {
      segIdx--;
      const segLen = Math.hypot(
        otherPts[segIdx + 1][0] - otherPts[segIdx][0],
        otherPts[segIdx + 1][1] - otherPts[segIdx][1]
      );
      rem += segLen;
    }
    if (rem < -0.05) return null;
    while (segIdx < otherPts.length - 2) {
      const segLen = Math.hypot(
        otherPts[segIdx + 1][0] - otherPts[segIdx][0],
        otherPts[segIdx + 1][1] - otherPts[segIdx][1]
      );
      if (rem <= segLen) break;
      rem -= segLen;
      segIdx++;
    }
    const ax = otherPts[segIdx][0];
    const az = otherPts[segIdx][1];
    const dx = otherPts[segIdx + 1][0] - ax;
    const dz = otherPts[segIdx + 1][1] - az;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 1e-6 || rem > segLen + 0.05) return null;
    const clamped = Math.max(0, Math.min(segLen, rem));
    return [ax + (dx / segLen) * clamped, az + (dz / segLen) * clamped];
  };

  let minD = currentDist;
  let maxD = currentDist;
  let minOffset = 0;
  let maxOffset = 0;
  for (const offset of [-8, -6, -4, -2, -1, 1, 2, 4, 6, 8]) {
    const pt = sampleAlongOther(offset);
    if (!pt) continue;
    const d = queryInteriorPerpDistanceToPolyline(pt[0], pt[1], selfPts);
    if (d !== null) {
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
      if (offset < minOffset) minOffset = offset;
      if (offset > maxOffset) maxOffset = offset;
    }
  }

  if (minD <= 1.68) return true;
  const span = maxOffset - minOffset;
  return span >= 0.4 && maxD - minD >= 0.04 && (maxD - minD) / span >= 0.022;
}

/**
 * Sorts railway features deterministically so primary mainlines are processed before
 * sidings, yards, spurs, and crossovers.
 */
export function sortRailwaysMainlineFirst(
  railways: RailwayFeature[],
  divergingEdgeIds?: ReadonlySet<string>
): RailwayFeature[] {
  const ranked = railways.map((feature) => {
    const svc = String(feature.osmTags?.service || '').toLowerCase();
    const serviceRank =
      svc === 'crossover' ? 2 : svc === 'siding' || svc === 'spur' || svc === 'yard' ? 1 : 0;
    const usage = String(feature.osmTags?.usage || '').toLowerCase();
    const usageRank = usage === 'main' ? 0 : usage === 'branch' ? 2 : 1;
    const divergingRank = divergingEdgeIds?.has(feature.id) ? 1 : 0;
    let len = 0;
    if (feature.points) {
      for (let i = 0; i < feature.points.length - 1; i++) {
        len += Math.hypot(
          feature.points[i + 1][0] - feature.points[i][0],
          feature.points[i + 1][1] - feature.points[i][1]
        );
      }
    }
    return { feature, serviceRank, usageRank, divergingRank, len };
  });

  ranked.sort((a, b) => {
    if (a.divergingRank !== b.divergingRank) {
      return a.divergingRank - b.divergingRank; // Mainline (0) before diverging branch (1)
    }
    return a.serviceRank === b.serviceRank
      ? a.usageRank === b.usageRank
        ? b.len - a.len
        : a.usageRank - b.usageRank
      : a.serviceRank - b.serviceRank;
  });
  return ranked.map((r) => r.feature);
}

/**
 * Computes continuous longitudinal arc-length phase offsets (`uPhase`) across connected
 * railway endpoints so chained ways maintain unbroken sleeper cadence.
 */
export function computeContinuousTrackPhases(railways: RailwayFeature[]): Map<string, number> {
  const phaseById = new Map<string, number>();
  const endpoints: Array<{
    x: number;
    z: number;
    tx: number;
    tz: number;
    uPhase: number;
  }> = [];

  for (const r of railways) {
    if (!r.points || r.points.length < 2) continue;
    const pts = r.points;
    const n = pts.length;
    let totalLen = 0;
    for (let i = 0; i < n - 1; i++) {
      totalLen += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    }
    if (totalLen < 0.001) continue;

    const dx0 = pts[1][0] - pts[0][0];
    const dz0 = pts[1][1] - pts[0][1];
    const l0 = Math.hypot(dx0, dz0) || 1;
    const tx0 = dx0 / l0;
    const tz0 = dz0 / l0;

    const dx1 = pts[n - 1][0] - pts[n - 2][0];
    const dz1 = pts[n - 1][1] - pts[n - 2][1];
    const l1 = Math.hypot(dx1, dz1) || 1;
    const tx1 = dx1 / l1;
    const tz1 = dz1 / l1;

    const period =
      r.railwayType === 'tram'
        ? RAILWAY_DIMENSION_SPEC.visualTramSleeperPeriodMeters
        : RAILWAY_DIMENSION_SPEC.visualSleeperPeriodMeters;

    let rawPhase: number | null = null;
    for (const ep of endpoints) {
      if (Math.hypot(pts[0][0] - ep.x, pts[0][1] - ep.z) <= 0.65 && tx0 * ep.tx + tz0 * ep.tz > 0.7) {
        rawPhase = ep.uPhase;
        break;
      }
      if (
        Math.hypot(pts[n - 1][0] - ep.x, pts[n - 1][1] - ep.z) <= 0.65 &&
        tx1 * ep.tx + tz1 * ep.tz > 0.7
      ) {
        rawPhase = ep.uPhase - totalLen;
        break;
      }
    }

    if (rawPhase === null) {
      const sign = tx0 > 1e-4 || (Math.abs(tx0) <= 1e-4 && tz0 >= 0) ? 1 : -1;
      const cx = tx0 * sign;
      const cz = tz0 * sign;
      rawPhase = (((pts[0][0] * cx + pts[0][1] * cz) % period) + period) % period;
    }

    const uPhase = ((rawPhase % period) + period) % period;
    phaseById.set(r.id, uPhase);
    endpoints.push(
      { x: pts[0][0], z: pts[0][1], tx: tx0, tz: tz0, uPhase },
      { x: pts[n - 1][0], z: pts[n - 1][1], tx: tx1, tz: tz1, uPhase: uPhase + totalLen }
    );
  }

  return phaseById;
}
