import * as THREE from 'three';
import { ELEVATION_POLICY } from './ElevationPolicy';
import { resolveSurfaceVisibility } from './SurfaceVisibilityPolicy';
import type {
  GradeTransitionRenderDescriptor,
  InfrastructureRenderDescriptorBundle,
  RailwayEdgeRenderDescriptor,
  RoadEdgeRenderDescriptor,
} from './infrastructure/rendering/InfrastructureRenderAdapter';

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
 *   When a standalone bridge span is shorter than `5.0 m`, interior approach ramps cannot fit without collapsing
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

/**
 * Explicit Stage E4-A classification for each endpoint of a grade-separated (bridge or tunnel) edge.
 */
export type GradeSeparatedEndpointClassification =
  | 'confirmed_transition'
  | 'confirmed_elevated_continuation'
  | 'boundary_clipped_continuation'
  | 'unresolved_connection'
  | 'intentionally_standalone';

export interface ResolvedGradeSeparatedEdgePlan {
  edgeId: string;
  network: 'road' | 'railway';
  isBridge: boolean;
  isTunnel: boolean;
  points: [number, number][];
  startClassification: GradeSeparatedEndpointClassification;
  endClassification: GradeSeparatedEndpointClassification;
  startTransition?: GradeTransitionRenderDescriptor;
  endTransition?: GradeTransitionRenderDescriptor;
  /** Shortest path distance (meters) along connected bridge component from start node to nearest confirmed transition portal (`Infinity` if none). */
  startPortalDistanceMeters: number;
  /** Shortest path distance (meters) along connected bridge component from end node to nearest confirmed transition portal (`Infinity` if none). */
  endPortalDistanceMeters: number;
  /** Effective ramp length (meters) for the connected bridge component containing this edge. */
  componentRampLengthMeters: number;
  /** Effective total span (meters) of the connected bridge component containing this edge. */
  componentSpanMeters: number;
  /** Authoritative target deck elevation at start node (supports smooth cross-layer bridge continuations). */
  startTargetDeckElevation: number;
  /** Authoritative target deck elevation at end node (supports smooth cross-layer bridge continuations). */
  endTargetDeckElevation: number;
  /** Number of portal horizontal discontinuities (> 0.0001 m) snapped to authoritative transition node on this edge. */
  correctedPortalDiscontinuities: number;
}

export interface GradeTransitionRenderDiagnostics {
  mode: 'legacy' | 'graph';
  confirmedTransitionsConsumed: number;
  confirmedElevatedContinuations: number;
  unresolvedTransitionsCount: number;
  boundaryClippedEndpointsCount: number;
  intentionallyStandaloneEndpointsCount: number;
  legacyFallbacksCount: number;
  correctedPortalDiscontinuitiesCount: number;
  bridgeAndTunnelBuildTimeMs: number;
  /** Number of individual tunnel portal structures emitted at confirmed/standalone entrances (M2.3-E4-T). */
  tunnelPortalsEmittedCount?: number;
  /** Number of subterranean tunnel road features rendered with continuous 3D underground road geometry (M2.3-E4-T). */
  undergroundRoadGeometryCount?: number;
  /** Number of subterranean tunnel railway features rendered with continuous 3D underground track geometry (M2.3-E4-T). */
  undergroundRailwayGeometryCount?: number;
  /** Number of features skipped from grade-separated/surface rendering due to contradictory vertical/enclosure tags (M2.3-E4-T). */
  conflictingPlacementSkippedCount?: number;
  /** Number of features with conflicting vertical tags routed to a conservative surface fallback (M2.3-E4-T2). */
  conflictingPlacementFallbackCount?: number;
  /** Number of localized portal ground-cover cutouts applied at confirmed tunnel entrances (M2.3-E4-T2). */
  portalGroundCutoutsCount?: number;
  /** Number of subterranean meshes hidden from normal surface draw calls (M2.3-E4-T2). */
  hiddenUndergroundMeshCount?: number;
  /** True when diagnostic dashed underground traces are enabled in visible presentation (M2.3-E4-T2). */
  undergroundTracesVisible?: boolean;
}

export interface GraphGradeSeparatedResolutionResult {
  plansByEdgeId: ReadonlyMap<string, ResolvedGradeSeparatedEdgePlan>;
  /** Map from at-grade edge ID to authoritative portal endpoint coordinates (`start` and/or `end`) snapped to confirmed GradeTransition positions. */
  atGradePortalSnapsByEdgeId: ReadonlyMap<
    string,
    { start?: readonly [number, number]; end?: readonly [number, number] }
  >;
  diagnostics: GradeTransitionRenderDiagnostics;
}

export interface BridgeProfileOptions {
  points: [number, number][];
  baseElevation: number;
  targetBridgeElevation: number;
  connectsStartAtGrade: boolean;
  connectsEndAtGrade: boolean;
  connectsStartBridge: boolean;
  connectsEndBridge: boolean;
  maxSampleStep?: number;
  /** Optional Stage E4-A graph-driven endpoint classifications and component ramp parameters. */
  startClassification?: GradeSeparatedEndpointClassification;
  endClassification?: GradeSeparatedEndpointClassification;
  startPortalDistanceMeters?: number;
  endPortalDistanceMeters?: number;
  componentRampLengthMeters?: number;
  startTargetDeckElevation?: number;
  endTargetDeckElevation?: number;
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

export interface BridgeStructureGenerationOptions {
  suppressStartAbutmentHeadwall?: boolean;
  suppressEndAbutmentHeadwall?: boolean;
  minElevatedDeckY?: number;
}

export interface TunnelPortalGenerationOptions {
  emitStartPortal?: boolean;
  emitEndPortal?: boolean;
  /** Optional explicit maxheight in meters (`maxheight=*`) to scale portal vertical clearance (M2.3-E4-T). */
  maxheightMeters?: number;
  /** Optional railway type (`'rail'`, `'subway'`, `'light_rail'`, `'tram'`) for railway portal scaling (M2.3-E4-T). */
  railwayType?: string;
  /** Surface base elevation at portal entrance (defaults to `ELEVATION_POLICY.ROAD_SURFACE = 0.050`). */
  surfaceElevation?: number;
}

export const DEFAULT_TUNNEL_PORTAL_RAMP_MAX_LENGTH_METERS = 10.0;
export const DEFAULT_TUNNEL_PORTAL_RAMP_MAX_FRACTION = 0.35;

export interface TunnelUndergroundProfileOptions {
  points: [number, number][];
  surfaceElevation: number;
  targetTunnelElevation: number;
  emitStartPortal: boolean;
  emitEndPortal: boolean;
  maxSampleStep?: number;
  startTargetTunnelElevation?: number;
  endTargetTunnelElevation?: number;
}

/**
 * Constructs a continuous 3D vertical profile `ProfiledPoint3D[]` along a subterranean tunnel alignment (M2.3-E4-T / E4-T2).
 * - At justified external portal entrances (`emitStartPortal` / `emitEndPortal`), starts at `surfaceElevation`
 *   and drops below `ELEVATION_POLICY.GROUND` (`-0.08 m`) within the portal hood (`<= 2.2 m`) before sloping
 *   smoothly down through a local entrance ramp (`min(10.0 m, 35% of span)`) to `targetTunnelElevation`
 *   (`ELEVATION_POLICY.TUNNEL_DEPTH = -4.2 m` for layer -1), staying strictly inside the mapped tunnel span.
 * - At internal multi-segment tunnel joints (`confirmed_elevated_continuation`), boundary-clipped ends
 *   (`boundary_clipped_continuation`), or unresolved ends (`unresolved_connection`), stays continuously at
 *   `startTargetTunnelElevation` / `endTargetTunnelElevation` with zero vertical step.
 */
export function buildTunnelUndergroundProfile3D(
  options: TunnelUndergroundProfileOptions
): {
  profile: ProfiledPoint3D[];
  minElevation: number;
  maxElevation: number;
  rampStartLength: number;
  rampEndLength: number;
} {
  const {
    points,
    surfaceElevation,
    targetTunnelElevation,
    emitStartPortal,
    emitEndPortal,
    maxSampleStep = 2.0,
    startTargetTunnelElevation,
    endTargetTunnelElevation,
  } = options;

  const cleanPts: [number, number][] = [];
  for (const pt of points) {
    if (
      cleanPts.length === 0 ||
      Math.hypot(
        pt[0] - cleanPts[cleanPts.length - 1][0],
        pt[1] - cleanPts[cleanPts.length - 1][1]
      ) > 0.02
    ) {
      cleanPts.push([pt[0], pt[1]]);
    }
  }

  const startFloorY = startTargetTunnelElevation ?? targetTunnelElevation;
  const endFloorY = endTargetTunnelElevation ?? targetTunnelElevation;
  const deepestFloorY = Math.min(targetTunnelElevation, startFloorY, endFloorY);

  if (cleanPts.length < 2) {
    return {
      profile: [],
      minElevation: deepestFloorY,
      maxElevation: deepestFloorY,
      rampStartLength: 0,
      rampEndLength: 0,
    };
  }

  const totalLength = computePolylineLength(cleanPts);
  const nominalRamp = Math.min(
    DEFAULT_TUNNEL_PORTAL_RAMP_MAX_LENGTH_METERS,
    totalLength * DEFAULT_TUNNEL_PORTAL_RAMP_MAX_FRACTION
  );

  let rampStartLength = emitStartPortal ? nominalRamp : 0;
  let rampEndLength = emitEndPortal ? nominalRamp : 0;
  const maxCombinedRamp = totalLength * 0.7;
  if (rampStartLength + rampEndLength > maxCombinedRamp && rampStartLength + rampEndLength > 1e-6) {
    const scale = maxCombinedRamp / (rampStartLength + rampEndLength);
    rampStartLength *= scale;
    rampEndLength *= scale;
  }

  const smoothstep = (u: number): number => {
    const c = Math.max(0, Math.min(1, u));
    return c * c * (3 - 2 * c);
  };

  // Within the portal hood (<= 1.8m), drop swiftly below ELEVATION_POLICY.GROUND (-0.015m)
  // so no subterranean ribbon ever pokes above surface ground cover behind the portal curtain.
  const evaluatePortalRampY = (distFromPortal: number, rampLen: number, targetFloorY: number): number => {
    const hoodDropLen = Math.min(1.8, rampLen * 0.35);
    const subGroundThresholdY = Math.min(ELEVATION_POLICY.GROUND - 0.12, targetFloorY * 0.15);
    if (hoodDropLen > 1e-3 && distFromPortal <= hoodDropLen) {
      const u = distFromPortal / hoodDropLen;
      return surfaceElevation + (subGroundThresholdY - surfaceElevation) * u;
    }
    const remLen = Math.max(1e-4, rampLen - hoodDropLen);
    const u = Math.max(0, Math.min(1, (distFromPortal - hoodDropLen) / remLen));
    const t = smoothstep(u);
    return subGroundThresholdY + (targetFloorY - subGroundThresholdY) * t;
  };

  const evaluateY = (s: number): number => {
    const fracEdge = totalLength > 1e-6 ? Math.max(0, Math.min(1, s / totalLength)) : 0;
    const localFloorY =
      startFloorY + (endFloorY - startFloorY) * smoothstep(fracEdge);

    if (rampStartLength > 1e-3 && s < rampStartLength) {
      return evaluatePortalRampY(s, rampStartLength, localFloorY);
    }
    if (rampEndLength > 1e-3 && s > totalLength - rampEndLength) {
      const rem = Math.max(0, totalLength - s);
      return evaluatePortalRampY(rem, rampEndLength, localFloorY);
    }
    return localFloorY;
  };

  const profile: ProfiledPoint3D[] = [];
  let accumS = 0;
  let minElevation = Infinity;
  let maxElevation = -Infinity;

  const pushSample = (x: number, z: number, s: number) => {
    const y = evaluateY(s);
    if (y < minElevation) minElevation = y;
    if (y > maxElevation) maxElevation = y;
    profile.push({ x, y, z, arcLength: s });
  };

  pushSample(cleanPts[0][0], cleanPts[0][1], 0);

  for (let i = 0; i < cleanPts.length - 1; i++) {
    const p0 = cleanPts[i];
    const p1 = cleanPts[i + 1];
    const segLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (segLen < 1e-5) continue;

    const effectiveStep = Math.min(maxSampleStep, 1.5);
    const steps = Math.max(1, Math.ceil(segLen / effectiveStep));
    const sampleFracs = new Set<number>();
    for (let k = 1; k <= steps; k++) {
      sampleFracs.add(Number((k / steps).toFixed(6)));
    }
    const criticalArcs = [
      Math.min(1.8, rampStartLength * 0.35),
      rampStartLength,
      totalLength - rampEndLength,
      totalLength - Math.min(1.8, rampEndLength * 0.35),
    ];
    for (const ca of criticalArcs) {
      if (ca > accumS + 1e-4 && ca < accumS + segLen - 1e-4) {
        sampleFracs.add(Number(((ca - accumS) / segLen).toFixed(6)));
      }
    }

    const sortedFracs = [...sampleFracs].sort((a, b) => a - b);
    for (const frac of sortedFracs) {
      const sx = p0[0] + (p1[0] - p0[0]) * frac;
      const sz = p0[1] + (p1[1] - p0[1]) * frac;
      const s = accumS + segLen * frac;
      pushSample(sx, sz, s);
    }
    accumS += segLen;
  }

  return {
    profile,
    minElevation: Number.isFinite(minElevation) ? minElevation : deepestFloorY,
    maxElevation: Number.isFinite(maxElevation) ? maxElevation : deepestFloorY,
    rampStartLength,
    rampEndLength,
  };
}

/**
 * Densifies a 2D polyline and computes a smooth 3D vertical elevation profile `y(s)` for a bridge.
 * - Preserves full grade separation (`peakElevation = targetBridgeElevation`) regardless of bridge length.
 * - Computes ramp lengths from `mappedBridgeLength` (`min(12.0 m, 30% of mapped bridge length)`),
 *   before any synthetic external approach segments are appended for standalone bridges in legacy mode.
 * - When Stage E4-A graph classifications (`startClassification` / `endClassification`) are provided:
 *   - Never invents synthetic external approach extensions for standalone, unresolved, or boundary-clipped ends.
 *   - Ramps to `baseElevation` strictly at `'confirmed_transition'` portals (and along multi-edge connected bridge
 *     components via `startPortalDistanceMeters`, `endPortalDistanceMeters`, and `componentRampLengthMeters`).
 *   - Preserves elevated deck height conservatively at `'boundary_clipped_continuation'`, `'unresolved_connection'`,
 *     and `'intentionally_standalone'` endpoints.
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
    startClassification,
    endClassification,
    startPortalDistanceMeters,
    endPortalDistanceMeters,
    componentRampLengthMeters,
    startTargetDeckElevation,
    endTargetDeckElevation,
  } = options;

  const cleanPts: [number, number][] = [];
  for (const pt of points) {
    if (
      cleanPts.length === 0 ||
      Math.hypot(pt[0] - cleanPts[cleanPts.length - 1][0], pt[1] - cleanPts[cleanPts.length - 1][1]) > 0.02
    ) {
      cleanPts.push([pt[0], pt[1]]);
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

  const startTargetY = startTargetDeckElevation ?? targetBridgeElevation;
  const endTargetY = endTargetDeckElevation ?? targetBridgeElevation;
  const peakElevation = Math.max(targetBridgeElevation, startTargetY, endTargetY);
  const mappedBridgeLength = computePolylineLength(cleanPts);

  const isGraphDriven = startClassification !== undefined || endClassification !== undefined;
  const hasComponentRampModel =
    isGraphDriven &&
    componentRampLengthMeters !== undefined &&
    startPortalDistanceMeters !== undefined &&
    endPortalDistanceMeters !== undefined;

  let workingPts = [...cleanPts];
  let rampStartLength = 0;
  let rampEndLength = 0;
  let rampMode: BridgeRampMode = 'elevated_continuation';

  if (hasComponentRampModel) {
    const R = componentRampLengthMeters!;
    const d0 = startPortalDistanceMeters!;
    const d1 = endPortalDistanceMeters!;

    if (R > 1e-3 && d0 < R) {
      rampStartLength = Math.min(mappedBridgeLength, Math.max(0, R - d0));
    }
    if (R > 1e-3 && d1 < R) {
      rampEndLength = Math.min(mappedBridgeLength, Math.max(0, R - d1));
    }

    if (R <= 1e-3) {
      rampMode =
        startClassification === 'confirmed_elevated_continuation' &&
        endClassification === 'confirmed_elevated_continuation'
          ? 'elevated_continuation'
          : 'abutment_headwall';
    } else if (rampStartLength <= 1e-3 && rampEndLength <= 1e-3) {
      rampMode = 'elevated_continuation';
    } else if (R < DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS - 1e-3) {
      rampMode = 'adapted_ramp';
    } else {
      rampMode = 'standard_ramp';
    }
  } else if (isGraphDriven) {
    // Graph-driven fallback without component distance overrides:
    // Only confirmed_transition endpoints ramp to ground; never synthesize external extensions.
    const wantsInSpanStartRamp = startClassification === 'confirmed_transition';
    const wantsInSpanEndRamp = endClassification === 'confirmed_transition';
    const nominalRampLen = Math.min(
      DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS,
      mappedBridgeLength * DEFAULT_BRIDGE_RAMP_MAX_FRACTION
    );

    if (mappedBridgeLength < MIN_RAMPED_BRIDGE_SPAN_METERS && wantsInSpanStartRamp && wantsInSpanEndRamp) {
      rampStartLength = 0;
      rampEndLength = 0;
      rampMode = 'abutment_headwall';
    } else if (mappedBridgeLength < MIN_RAMPED_BRIDGE_SPAN_METERS && (wantsInSpanStartRamp || wantsInSpanEndRamp)) {
      const otherIsContOrClip =
        (wantsInSpanStartRamp &&
          (endClassification === 'confirmed_elevated_continuation' ||
            endClassification === 'boundary_clipped_continuation')) ||
        (wantsInSpanEndRamp &&
          (startClassification === 'confirmed_elevated_continuation' ||
            startClassification === 'boundary_clipped_continuation'));
      if (otherIsContOrClip) {
        if (wantsInSpanStartRamp) rampStartLength = mappedBridgeLength;
        if (wantsInSpanEndRamp) rampEndLength = mappedBridgeLength;
        rampMode = 'adapted_ramp';
      } else {
        rampStartLength = 0;
        rampEndLength = 0;
        rampMode = 'abutment_headwall';
      }
    } else {
      if (wantsInSpanStartRamp) rampStartLength = nominalRampLen;
      if (wantsInSpanEndRamp) rampEndLength = nominalRampLen;
      const inSpanRampBudget = mappedBridgeLength * (1.0 - MIN_CENTRAL_DECK_FRACTION);
      const activeInSpanRamps = rampStartLength + rampEndLength;
      if (activeInSpanRamps > inSpanRampBudget && activeInSpanRamps > 1e-6) {
        const scale = inSpanRampBudget / activeInSpanRamps;
        rampStartLength *= scale;
        rampEndLength *= scale;
      }
      const hasAnyRamp = rampStartLength > 0 || rampEndLength > 0;
      if (!hasAnyRamp) {
        rampMode =
          startClassification === 'confirmed_elevated_continuation' &&
          endClassification === 'confirmed_elevated_continuation'
            ? 'elevated_continuation'
            : 'abutment_headwall';
      } else if (
        (rampStartLength > 0 && rampStartLength < DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS - 1e-3) ||
        (rampEndLength > 0 && rampEndLength < DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS - 1e-3)
      ) {
        rampMode = 'adapted_ramp';
      } else {
        rampMode = 'standard_ramp';
      }
    }
  } else {
    // Legacy mode: preserve exact backward compatibility for legacy callers and unit tests
    const isStandaloneStart = !connectsStartAtGrade && !connectsStartBridge;
    const isStandaloneEnd = !connectsEndAtGrade && !connectsEndBridge;
    const wantsInSpanStartRamp = connectsStartAtGrade;
    const wantsInSpanEndRamp = connectsEndAtGrade;

    const nominalRampLen = Math.min(
      DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS,
      mappedBridgeLength * DEFAULT_BRIDGE_RAMP_MAX_FRACTION
    );

    if (mappedBridgeLength < MIN_RAMPED_BRIDGE_SPAN_METERS) {
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
  }

  const totalLen = computePolylineLength(workingPts);
  const activeRampLengths = [rampStartLength, rampEndLength].filter((r) => r > 1e-3);
  const hasLayerTransition = Math.abs(startTargetY - endTargetY) > 1e-4;
  const minActiveRamp =
    activeRampLengths.length > 0
      ? Math.min(...activeRampLengths)
      : hasLayerTransition
        ? Math.min(maxSampleStep, Math.max(0.5, totalLen / 6))
        : maxSampleStep;
  const effectiveSampleStep = Math.min(maxSampleStep, Math.max(0.35, minActiveRamp / 6));

  const evalElevationAt = (s: number): number => {
    const fracEdge = totalLen > 1e-6 ? Math.min(Math.max(s / totalLen, 0), 1) : 0;
    const easeEdge = 0.5 - 0.5 * Math.cos(Math.PI * fracEdge);
    const localTargetY = startTargetY + (endTargetY - startTargetY) * easeEdge;

    if (hasComponentRampModel) {
      const R = componentRampLengthMeters!;
      const d0 = startPortalDistanceMeters!;
      const d1 = endPortalDistanceMeters!;
      const dPortal = Math.min(d0 + s, d1 + Math.max(0, totalLen - s));
      if (R > 1e-3 && dPortal < R) {
        const t = Math.min(Math.max(dPortal / R, 0), 1);
        const ease = 0.5 - 0.5 * Math.cos(Math.PI * t);
        return baseElevation + (localTargetY - baseElevation) * ease;
      }
      return localTargetY;
    }

    if (rampStartLength > 1e-3 && s < rampStartLength) {
      const t = Math.min(Math.max(s / rampStartLength, 0), 1);
      const ease = 0.5 - 0.5 * Math.cos(Math.PI * t);
      return baseElevation + (localTargetY - baseElevation) * ease;
    }
    if (rampEndLength > 1e-3 && s > totalLen - rampEndLength) {
      const rem = totalLen - s;
      const t = Math.min(Math.max(rem / rampEndLength, 0), 1);
      const ease = 0.5 - 0.5 * Math.cos(Math.PI * t);
      return baseElevation + (localTargetY - baseElevation) * ease;
    }
    return localTargetY;
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
  deckThickness: number = 0.36,
  options?: BridgeStructureGenerationOptions
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
  const minDeckThresholdY = options?.minElevatedDeckY ?? peakElevation;

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

    // On ramp sections (where deck is transitioning below minDeckThresholdY), extend side abutment walls down to groundY
    // so the bridge approach forms a solid connected embankment; on main span, use deckThickness fascia.
    const isRampSeg = p0.y < minDeckThresholdY - 0.08 || p1.y < minDeckThresholdY - 0.08;
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

    // Start vertical abutment headwall down to groundY when start of bridge is elevated and not an elevated/clipped continuation
    if (i === 0 && p0.y > groundY + 0.08 && !options?.suppressStartAbutmentHeadwall) {
      subV = appendQuad(
        subPos, subNorm, subIdx, subV,
        r0x, groundY, r0z,
        l0x, groundY, l0z,
        l0x, p0.y, l0z,
        r0x, p0.y, r0z,
        -tx, 0, -tz
      );
    }

    // End vertical abutment headwall down to groundY when end of bridge is elevated and not an elevated/clipped continuation
    if (
      i === profile.length - 2 &&
      p1.y > groundY + 0.08 &&
      !options?.suppressEndAbutmentHeadwall
    ) {
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
  isPedestrianOrCycle: boolean = false,
  options?: TunnelPortalGenerationOptions
): {
  portalStructureGeo: THREE.BufferGeometry | null;
  portalMouthGeo: THREE.BufferGeometry | null;
  undergroundTraceGeo: THREE.BufferGeometry | null;
  /** Tightly bounded 2D polygons `[outerRing]` at each emitted portal mouth for localized ground-cover recession (M2.3-E4-T2). */
  portalGroundCutoutPolygons: [number, number][][][];
} {
  const cleanPts: [number, number][] = [];
  for (const pt of points) {
    if (
      cleanPts.length === 0 ||
      Math.hypot(pt[0] - cleanPts[cleanPts.length - 1][0], pt[1] - cleanPts[cleanPts.length - 1][1]) > 0.02
    ) {
      cleanPts.push([pt[0], pt[1]]);
    }
  }

  if (cleanPts.length < 2) {
    return {
      portalStructureGeo: null,
      portalMouthGeo: null,
      undergroundTraceGeo: null,
      portalGroundCutoutPolygons: [],
    };
  }

  // Fail closed: callers must provide verified transition decisions.
  const emitStartPortal = options?.emitStartPortal === true;
  const emitEndPortal = options?.emitEndPortal === true;

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

  const portalGroundCutoutPolygons: [number, number][][][] = [];

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

    const baseY = options?.surfaceElevation ?? ELEVATION_POLICY.ROAD_SURFACE;
    const isRailwayPortal = Boolean(options?.railwayType);
    const customMaxH =
      typeof options?.maxheightMeters === 'number' &&
      Number.isFinite(options.maxheightMeters) &&
      options.maxheightMeters > 1.5
        ? Math.min(Math.max(options.maxheightMeters, 2.0), 6.5)
        : undefined;

    const clearanceHeight =
      customMaxH ??
      (isRailwayPortal
        ? options?.railwayType === 'subway'
          ? 3.2
          : options?.railwayType === 'tram' || options?.railwayType === 'light_rail'
            ? 3.05
            : 3.55
        : isPedestrianOrCycle
          ? 1.95
          : width >= 9.0
            ? 3.1
            : 2.55);

    const lintelHeight = isPedestrianOrCycle ? 0.52 : isRailwayPortal ? 0.78 : 0.72;
    const portalHeight = clearanceHeight + lintelHeight;
    const pillarWidth = isPedestrianOrCycle ? 0.42 : isRailwayPortal ? 0.64 : 0.58;
    const hoodDepth = isPedestrianOrCycle ? 1.8 : isRailwayPortal ? 2.8 : 2.5;
    const wingLen = isPedestrianOrCycle ? 1.6 : isRailwayPortal ? 2.4 : 2.2;
    const openW = Math.max(
      width + 0.25,
      isPedestrianOrCycle ? 2.2 : isRailwayPortal ? 3.6 : 3.8
    );
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

    // 2. Overhead Portal Arch / Headwall Lintel Beam + Coping Collar
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

    const copingDepth = Math.min(0.45, hoodDepth * 0.25);
    const copingCenterX = px + inTx * (copingDepth * 0.5);
    const copingCenterZ = pz + inTz * (copingDepth * 0.5);
    portalV = appendBox(
      portalPos, portalNorm, portalIdx, portalV,
      copingCenterX,
      copingCenterZ,
      inTx, inTz,
      copingDepth,
      openW + pillarWidth * 2.25,
      baseY + portalHeight,
      baseY + portalHeight + (isPedestrianOrCycle ? 0.14 : 0.22)
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

    // 4. Localized Recessed Tunnel Mouth Trough, Sloped Entrance Ramp & Shadow Backwall inside the portal arch
    const mouthStartY = baseY;
    const mouthEndY = ELEVATION_POLICY.GROUND - 0.14;
    const mStartX = px - inTx * 0.08;
    const mStartZ = pz - inTz * 0.08;
    const mEndX = px + inTx * (hoodDepth * 0.86);
    const mEndZ = pz + inTz * (hoodDepth * 0.86);
    const mHalfW = halfOpen * 0.96;

    // Sloped dark entrance ramp threshold mat descending below ground inside the portal opening (CCW from above)
    mouthPos.push(
      mStartX + nx * mHalfW, mouthStartY, mStartZ + nz * mHalfW,
      mEndX + nx * mHalfW, mouthEndY, mEndZ + nz * mHalfW,
      mEndX - nx * mHalfW, mouthEndY, mEndZ - nz * mHalfW,
      mStartX - nx * mHalfW, mouthStartY, mStartZ - nz * mHalfW
    );
    for (let k = 0; k < 4; k++) mouthNorm.push(0, 1, 0);
    mouthIdx.push(mouthV, mouthV + 1, mouthV + 2, mouthV, mouthV + 2, mouthV + 3);
    mouthV += 4;

    // Recessed left & right interior cheek walls closing the wedge between surface baseY and the descending ramp
    mouthPos.push(
      mStartX + nx * mHalfW, mouthStartY, mStartZ + nz * mHalfW,
      mEndX + nx * mHalfW, baseY, mEndZ + nz * mHalfW,
      mEndX + nx * mHalfW, mouthEndY, mEndZ + nz * mHalfW,
      mStartX + nx * mHalfW, mouthStartY, mStartZ + nz * mHalfW
    );
    for (let k = 0; k < 4; k++) mouthNorm.push(-nx, 0, -nz);
    mouthIdx.push(mouthV, mouthV + 1, mouthV + 2);
    mouthV += 4;

    mouthPos.push(
      mStartX - nx * mHalfW, mouthStartY, mStartZ - nz * mHalfW,
      mEndX - nx * mHalfW, mouthEndY, mEndZ - nz * mHalfW,
      mEndX - nx * mHalfW, baseY, mEndZ - nz * mHalfW,
      mStartX - nx * mHalfW, mouthStartY, mStartZ - nz * mHalfW
    );
    for (let k = 0; k < 4; k++) mouthNorm.push(nx, 0, nz);
    mouthIdx.push(mouthV, mouthV + 1, mouthV + 2);
    mouthV += 4;

    // Dark vertical shadow curtain inside the portal opening
    const curtainX = px + inTx * (hoodDepth * 0.72);
    const curtainZ = pz + inTz * (hoodDepth * 0.72);
    const curtainTop = baseY + portalHeight - lintelHeight;
    mouthPos.push(
      curtainX - nx * mHalfW, mouthEndY, curtainZ - nz * mHalfW,
      curtainX + nx * mHalfW, mouthEndY, curtainZ + nz * mHalfW,
      curtainX + nx * mHalfW, curtainTop, curtainZ + nz * mHalfW,
      curtainX - nx * mHalfW, curtainTop, curtainZ - nz * mHalfW
    );
    for (let k = 0; k < 4; k++) mouthNorm.push(-inTx, 0, -inTz);
    mouthIdx.push(mouthV, mouthV + 1, mouthV + 2, mouthV, mouthV + 2, mouthV + 3);
    mouthV += 4;

    // 5. Tightly bounded 2D cutout rectangle for localized ground-cover recession at the portal mouth
    const cutStartX = px;
    const cutStartZ = pz;
    const cutEndX = px + inTx * (hoodDepth * 0.76);
    const cutEndZ = pz + inTz * (hoodDepth * 0.76);
    const cutHalfW = halfOpen * 0.94;
    const cutoutRing: [number, number][] = [
      [Number((cutStartX + nx * cutHalfW).toFixed(4)), Number((cutStartZ + nz * cutHalfW).toFixed(4))],
      [Number((cutEndX + nx * cutHalfW).toFixed(4)), Number((cutEndZ + nz * cutHalfW).toFixed(4))],
      [Number((cutEndX - nx * cutHalfW).toFixed(4)), Number((cutEndZ - nz * cutHalfW).toFixed(4))],
      [Number((cutStartX - nx * cutHalfW).toFixed(4)), Number((cutStartZ - nz * cutHalfW).toFixed(4))],
      [Number((cutStartX + nx * cutHalfW).toFixed(4)), Number((cutStartZ + nz * cutHalfW).toFixed(4))],
    ];
    portalGroundCutoutPolygons.push([cutoutRing]);
  };

  // Start portal
  if (emitStartPortal) {
    const dx0 = cleanPts[1][0] - cleanPts[0][0];
    const dz0 = cleanPts[1][1] - cleanPts[0][1];
    const len0 = Math.hypot(dx0, dz0) || 1;
    emitPortalAt(cleanPts[0][0], cleanPts[0][1], dx0 / len0, dz0 / len0);
  }

  // End portal
  if (emitEndPortal) {
    const n = cleanPts.length;
    const dxn = cleanPts[n - 2][0] - cleanPts[n - 1][0];
    const dzn = cleanPts[n - 2][1] - cleanPts[n - 1][1];
    const lenn = Math.hypot(dxn, dzn) || 1;
    emitPortalAt(cleanPts[n - 1][0], cleanPts[n - 1][1], dxn / lenn, dzn / lenn);
  }

  // 6. Optional Diagnostic Dashed Underground Alignment Trace between the two portals
  const totalLen = computePolylineLength(cleanPts);
  if (totalLen >= 8.0) {
    const dashLen = 1.5;
    const dashSpacing = 5.2;
    const traceHalfW = Math.min(Math.max(width * 0.22, 0.35), 0.75);
    const traceY = ELEVATION_POLICY.ROAD_SURFACE + 0.003;
    const minTraceS = emitStartPortal ? 3.2 : 0.2;
    const maxTraceS = emitEndPortal ? totalLen - 3.2 : totalLen - 0.2;

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
        if (globalS < minTraceS || globalS + dashLen > maxTraceS) continue;

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
    portalGroundCutoutPolygons,
  };
}

function compareStringsCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Authoritative Stage E4-A graph-driven grade-transition and continuation resolver for road and railway
 * bridges and tunnels.
 *
 * Classifies every grade-separated endpoint into one of:
 * 1. `'confirmed_transition'`
 * 2. `'confirmed_elevated_continuation'`
 * 3. `'boundary_clipped_continuation'`
 * 4. `'unresolved_connection'`
 * 5. `'intentionally_standalone'`
 *
 * Also computes connected bridge component path spans and shortest portal distances so multi-segment bridges,
 * bridges with switches/turnouts near portals, and cross-layer bridge continuations share exact 3D elevations
 * at every interior node and every confirmed ground portal without vertical cliffs.
 */
export function resolveGraphGradeSeparatedPlans(
  descriptors: InfrastructureRenderDescriptorBundle,
  network: 'road' | 'railway',
  getTargetDeckElevation: (
    edge: RoadEdgeRenderDescriptor | RailwayEdgeRenderDescriptor
  ) => number
): GraphGradeSeparatedResolutionResult {
  const COS_60_DEG = 0.5;
  const COS_30_DEG = Math.cos((30 * Math.PI) / 180);
  const SNAP_TOLERANCE_METERS = 0.15;

  type AnyEdge = RoadEdgeRenderDescriptor | RailwayEdgeRenderDescriptor;
  const allEdges: readonly AnyEdge[] =
    network === 'road' ? descriptors.roadEdges : descriptors.railwayEdges;

  const isGroundEdge = (e: AnyEdge): boolean => {
    if (e.placementClassification?.hasConflict) return false;
    if (e.placementClassification) {
      return resolveSurfaceVisibility({
        osmTags: e.primaryOsmTags,
        placementClassification: e.placementClassification,
        isBridge: e.isBridge,
        isTunnel: e.isTunnel,
        layer: e.layer,
      }) === 'surface';
    }
    if (network === 'road') {
      return (e as RoadEdgeRenderDescriptor).isAtGradeBuildable;
    }
    return e.layer === 0 && !e.isBridge && !e.isTunnel;
  };

  const isTunnelEdge = (e: AnyEdge): boolean => {
    if (e.placementClassification?.hasConflict) return false;
    if (isGroundEdge(e)) return false;
    if (e.placementClassification) {
      return e.placementClassification.isSubterraneanTunnel;
    }
    return Boolean(e.isTunnel);
  };

  const isBridgeEdge = (e: AnyEdge): boolean => {
    if (e.placementClassification?.hasConflict) return false;
    if (isGroundEdge(e) || isTunnelEdge(e)) return false;
    if (e.placementClassification) {
      return resolveSurfaceVisibility({
        osmTags: e.primaryOsmTags,
        placementClassification: e.placementClassification,
        layer: e.layer,
      }) === 'elevated';
    }
    return Boolean(e.isBridge || e.layer > 0);
  };

  const getNode = (nodeId: string) =>
    network === 'road'
      ? descriptors.roadNodesById.get(nodeId)
      : descriptors.railwayNodesById.get(nodeId);

  const groundEdges: AnyEdge[] = [];
  const bridgeEdges: AnyEdge[] = [];
  const tunnelEdges: AnyEdge[] = [];
  const groundEdgeById = new Map<string, AnyEdge>();
  const bridgeEdgeById = new Map<string, AnyEdge>();
  const tunnelEdgeById = new Map<string, AnyEdge>();

  for (const e of allEdges) {
    if (isGroundEdge(e)) {
      groundEdges.push(e);
      groundEdgeById.set(e.id, e);
    } else if (isTunnelEdge(e)) {
      tunnelEdges.push(e);
      tunnelEdgeById.set(e.id, e);
    } else if (isBridgeEdge(e)) {
      bridgeEdges.push(e);
      bridgeEdgeById.set(e.id, e);
    }
  }

  let correctedPortalDiscontinuitiesCount = 0;
  const atGradePortalSnaps = new Map<
    string,
    { start?: readonly [number, number]; end?: readonly [number, number] }
  >();
  const recordAtGradeSnap = (
    edgeId: string,
    endpoint: 'start' | 'end',
    pos: readonly [number, number]
  ) => {
    const cur = atGradePortalSnaps.get(edgeId) ?? {};
    const gEdge = groundEdgeById.get(edgeId);
    if (gEdge && gEdge.points.length >= 2) {
      const pt =
        endpoint === 'start'
          ? gEdge.points[0]
          : gEdge.points[gEdge.points.length - 1];
      if (Math.hypot(pt[0] - pos[0], pt[1] - pos[1]) > 1e-4) {
        correctedPortalDiscontinuitiesCount++;
      }
    }
    if (endpoint === 'start') cur.start = [pos[0], pos[1]];
    else cur.end = [pos[0], pos[1]];
    atGradePortalSnaps.set(edgeId, cur);
    if (gEdge?.sourceFeatureId && gEdge.sourceFeatureId !== edgeId) {
      atGradePortalSnaps.set(gEdge.sourceFeatureId, cur);
    }
  };

  // Map from `${edgeId}|${'start'|'end'}` to confirmed ground-to-structure GradeTransitionRenderDescriptor
  const confirmedTransitionByEndpoint = new Map<string, GradeTransitionRenderDescriptor>();
  const confirmedTransitionByNodeId = new Map<string, GradeTransitionRenderDescriptor>();

  // Cross-scope continuation links between nodes in the same structure stratum (bridge<->bridge or tunnel<->tunnel)
  const crossScopeNodeLinks = new Map<string, Set<string>>();
  const crossScopeSnapPositionByNode = new Map<string, [number, number]>();
  const linkStructureNodes = (
    nodeAId: string,
    nodeBId: string,
    snapPos?: readonly [number, number]
  ) => {
    if (nodeAId === nodeBId) return;
    if (!crossScopeNodeLinks.has(nodeAId)) crossScopeNodeLinks.set(nodeAId, new Set());
    if (!crossScopeNodeLinks.has(nodeBId)) crossScopeNodeLinks.set(nodeBId, new Set());
    crossScopeNodeLinks.get(nodeAId)!.add(nodeBId);
    crossScopeNodeLinks.get(nodeBId)!.add(nodeAId);
    if (snapPos) {
      crossScopeSnapPositionByNode.set(nodeAId, [snapPos[0], snapPos[1]]);
      crossScopeSnapPositionByNode.set(nodeBId, [snapPos[0], snapPos[1]]);
    }
  };

  // 1. Process confirmed GradeTransitionRenderDescriptors from the adapter
  const domainTransitions = descriptors.gradeTransitions.filter((gt) => gt.network === network);
  for (const gt of domainTransitions) {
    const agIsGround = groundEdgeById.has(gt.atGradeEdgeId);
    const gsIsGround = groundEdgeById.has(gt.gradeSeparatedEdgeId);
    const agIsBridge = bridgeEdgeById.has(gt.atGradeEdgeId);
    const gsIsBridge = bridgeEdgeById.has(gt.gradeSeparatedEdgeId);
    const agIsTunnel = tunnelEdgeById.has(gt.atGradeEdgeId);
    const gsIsTunnel = tunnelEdgeById.has(gt.gradeSeparatedEdgeId);

    if (agIsGround && (gsIsBridge || gsIsTunnel)) {
      confirmedTransitionByEndpoint.set(
        `${gt.gradeSeparatedEdgeId}|${gt.gradeSeparatedEndpoint}`,
        gt
      );
      if (!confirmedTransitionByNodeId.has(gt.gradeSeparatedNodeId)) {
        confirmedTransitionByNodeId.set(gt.gradeSeparatedNodeId, gt);
      }
      recordAtGradeSnap(gt.atGradeEdgeId, gt.atGradeEndpoint, gt.position);
    } else if (gsIsGround && (agIsBridge || agIsTunnel)) {
      confirmedTransitionByEndpoint.set(`${gt.atGradeEdgeId}|${gt.atGradeEndpoint}`, gt);
      if (!confirmedTransitionByNodeId.has(gt.atGradeNodeId)) {
        confirmedTransitionByNodeId.set(gt.atGradeNodeId, gt);
      }
      recordAtGradeSnap(gt.gradeSeparatedEdgeId, gt.gradeSeparatedEndpoint, gt.position);
    } else if ((agIsBridge && gsIsBridge) || (agIsTunnel && gsIsTunnel)) {
      // Both edges belong to the same elevated or subterranean stratum (e.g. layer=1|isBridge=true meeting layer=1|isBridge=false)
      linkStructureNodes(gt.gradeSeparatedNodeId, gt.atGradeNodeId, gt.position);
    }
  }

  // Helper to check compatibility of two edges in the same domain
  const areEdgesCompatible = (a: AnyEdge, b: AnyEdge): boolean => {
    if (network === 'road') {
      return (a as RoadEdgeRenderDescriptor).tier === (b as RoadEdgeRenderDescriptor).tier;
    }
    return (
      (a as RailwayEdgeRenderDescriptor).railwayType ===
      (b as RailwayEdgeRenderDescriptor).railwayType
    );
  };

  // 2. Check for Elevated (layer > 0, isBridge=false) <-> Ground (layer === 0, isBridge=false) transitions
  //    that were both treated as non-bridge in CrossModalAnalyzer
  type EndpointRec = {
    edge: AnyEdge;
    endpoint: 'start' | 'end';
    nodeId: string;
    position: readonly [number, number];
    inwardTangent: readonly [number, number];
    rawOsmNodeId?: string;
    isClipped: boolean;
  };

  const collectEndpoints = (edges: readonly AnyEdge[]): EndpointRec[] => {
    const out: EndpointRec[] = [];
    for (const e of edges) {
      const startN = getNode(e.fromNodeId);
      const endN = getNode(e.toNodeId);
      if (startN) {
        out.push({
          edge: e,
          endpoint: 'start',
          nodeId: e.fromNodeId,
          position: startN.position,
          inwardTangent: e.startInwardTangent,
          rawOsmNodeId: startN.rawOsmNodeId,
          isClipped: Boolean(e.clippedAtStart || startN.isBoundaryClipped),
        });
      }
      if (endN) {
        out.push({
          edge: e,
          endpoint: 'end',
          nodeId: e.toNodeId,
          position: endN.position,
          inwardTangent: e.endInwardTangent,
          rawOsmNodeId: endN.rawOsmNodeId,
          isClipped: Boolean(e.clippedAtEnd || endN.isBoundaryClipped),
        });
      }
    }
    return out;
  };

  const groundEndpoints = collectEndpoints(groundEdges);
  const bridgeEndpoints = collectEndpoints(bridgeEdges);
  const tunnelEndpoints = collectEndpoints(tunnelEdges);

  for (const bEp of bridgeEndpoints) {
    if (bEp.isClipped) continue;
    const epKey = `${bEp.edge.id}|${bEp.endpoint}`;
    if (
      confirmedTransitionByEndpoint.has(epKey) ||
      confirmedTransitionByNodeId.has(bEp.nodeId)
    ) {
      continue;
    }
    // Only needed when bEp.edge had !isBridge (e.g. layer > 0 embankment), or when a shared explicit node connects to ground
    if (bEp.edge.isBridge) continue;

    let bestGround: { gEp: EndpointRec; dot: number; dist: number; isExplicit: boolean } | null =
      null;
    for (const gEp of groundEndpoints) {
      if (gEp.isClipped || !areEdgesCompatible(bEp.edge, gEp.edge)) continue;
      const dot = -(
        bEp.inwardTangent[0] * gEp.inwardTangent[0] +
        bEp.inwardTangent[1] * gEp.inwardTangent[1]
      );
      if (bEp.rawOsmNodeId && gEp.rawOsmNodeId) {
        if (bEp.rawOsmNodeId !== gEp.rawOsmNodeId) continue;
        if (dot < COS_60_DEG) continue;
        const dist = Math.hypot(
          bEp.position[0] - gEp.position[0],
          bEp.position[1] - gEp.position[1]
        );
        if (!bestGround || !bestGround.isExplicit || dot > bestGround.dot) {
          bestGround = { gEp, dot, dist, isExplicit: true };
        }
      } else {
        const dist = Math.hypot(
          bEp.position[0] - gEp.position[0],
          bEp.position[1] - gEp.position[1]
        );
        if (dist > SNAP_TOLERANCE_METERS || dot < COS_30_DEG) continue;
        if (!bestGround || (!bestGround.isExplicit && dot > bestGround.dot)) {
          bestGround = { gEp, dot, dist, isExplicit: false };
        }
      }
    }

    if (bestGround) {
      const midPos: [number, number] = [
        (bEp.position[0] + bestGround.gEp.position[0]) * 0.5,
        (bEp.position[1] + bestGround.gEp.position[1]) * 0.5,
      ];
      const synthGt: GradeTransitionRenderDescriptor = {
        id: `grade_transition:${network}:${bEp.edge.id}:${bEp.endpoint}->${bestGround.gEp.edge.id}:${bestGround.gEp.endpoint}`,
        network,
        transitionType: 'bridge_approach',
        position: midPos,
        rawOsmNodeId: bEp.rawOsmNodeId ?? bestGround.gEp.rawOsmNodeId,
        atGradeNodeId: bestGround.gEp.nodeId,
        atGradeEdgeId: bestGround.gEp.edge.id,
        atGradeEndpoint: bestGround.gEp.endpoint,
        atGradeSourceFeatureIds: bestGround.gEp.edge.sourceFeatureIds,
        gradeSeparatedNodeId: bEp.nodeId,
        gradeSeparatedEdgeId: bEp.edge.id,
        gradeSeparatedEndpoint: bEp.endpoint,
        gradeSeparatedSourceFeatureIds: bEp.edge.sourceFeatureIds,
        atGradeOutwardTangent: [
          -bestGround.gEp.inwardTangent[0],
          -bestGround.gEp.inwardTangent[1],
        ],
        gradeSeparatedInwardTangent: bEp.inwardTangent,
        atGradeToStructureDirection: bEp.inwardTangent,
        continuousTraversalDot: bestGround.dot,
        confidence: bestGround.isExplicit
          ? 'explicit_osm_node'
          : 'coordinate_fallback_confirmed',
      };
      confirmedTransitionByEndpoint.set(epKey, synthGt);
      if (!confirmedTransitionByNodeId.has(bEp.nodeId)) {
        confirmedTransitionByNodeId.set(bEp.nodeId, synthGt);
      }
      recordAtGradeSnap(bestGround.gEp.edge.id, bestGround.gEp.endpoint, midPos);
    }
  }

  // 3. Detect cross-layer same-structure continuations (e.g. bridge layer=1 <-> bridge layer=2, or tunnel layer=-1 <-> tunnel layer=-2)
  const linkCrossLayerContinuations = (eps: readonly EndpointRec[]) => {
    for (let i = 0; i < eps.length; i++) {
      const a = eps[i];
      if (a.isClipped) continue;
      for (let j = i + 1; j < eps.length; j++) {
        const b = eps[j];
        if (b.isClipped || a.edge.id === b.edge.id || a.nodeId === b.nodeId) continue;
        if (a.edge.layer === b.edge.layer && a.edge.isBridge === b.edge.isBridge) continue;
        if (!areEdgesCompatible(a.edge, b.edge)) continue;

        const dot = -(
          a.inwardTangent[0] * b.inwardTangent[0] +
          a.inwardTangent[1] * b.inwardTangent[1]
        );
        if (a.rawOsmNodeId && b.rawOsmNodeId) {
          if (a.rawOsmNodeId !== b.rawOsmNodeId || dot < COS_60_DEG) continue;
          const mid: [number, number] = [
            (a.position[0] + b.position[0]) * 0.5,
            (a.position[1] + b.position[1]) * 0.5,
          ];
          linkStructureNodes(a.nodeId, b.nodeId, mid);
        } else {
          const dist = Math.hypot(
            a.position[0] - b.position[0],
            a.position[1] - b.position[1]
          );
          if (dist <= SNAP_TOLERANCE_METERS && dot >= COS_30_DEG) {
            const mid: [number, number] = [
              (a.position[0] + b.position[0]) * 0.5,
              (a.position[1] + b.position[1]) * 0.5,
            ];
            linkStructureNodes(a.nodeId, b.nodeId, mid);
          }
        }
      }
    }
  };

  linkCrossLayerContinuations(bridgeEndpoints);
  linkCrossLayerContinuations(tunnelEndpoints);

  // 4. Index unresolved grade transitions
  const unresolvedEndpointKeys = new Set<string>();
  const unresolvedNodeIds = new Set<string>();
  for (const u of descriptors.unresolvedDiagnostics.unresolvedGradeTransitions) {
    if (u.network !== network) continue;
    unresolvedEndpointKeys.add(`${u.gradeSeparatedEdgeId}|${u.gradeSeparatedEndpoint}`);
    const e =
      bridgeEdgeById.get(u.gradeSeparatedEdgeId) ?? tunnelEdgeById.get(u.gradeSeparatedEdgeId);
    if (e) {
      unresolvedNodeIds.add(
        u.gradeSeparatedEndpoint === 'start' ? e.fromNodeId : e.toNodeId
      );
    }
  }

  // 5. Count incident structure edges per node (within bridge stratum and within tunnel stratum)
  const bridgeIncidentByNode = new Map<string, AnyEdge[]>();
  for (const e of bridgeEdges) {
    if (!bridgeIncidentByNode.has(e.fromNodeId)) bridgeIncidentByNode.set(e.fromNodeId, []);
    if (!bridgeIncidentByNode.has(e.toNodeId)) bridgeIncidentByNode.set(e.toNodeId, []);
    bridgeIncidentByNode.get(e.fromNodeId)!.push(e);
    bridgeIncidentByNode.get(e.toNodeId)!.push(e);
  }

  const tunnelIncidentByNode = new Map<string, AnyEdge[]>();
  for (const e of tunnelEdges) {
    if (!tunnelIncidentByNode.has(e.fromNodeId)) tunnelIncidentByNode.set(e.fromNodeId, []);
    if (!tunnelIncidentByNode.has(e.toNodeId)) tunnelIncidentByNode.set(e.toNodeId, []);
    tunnelIncidentByNode.get(e.fromNodeId)!.push(e);
    tunnelIncidentByNode.get(e.toNodeId)!.push(e);
  }

  const getEquivalentNodeIds = (nodeId: string): string[] => {
    const visited = new Set<string>([nodeId]);
    const queue = [nodeId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const links = crossScopeNodeLinks.get(cur);
      if (!links) continue;
      for (const nxt of links) {
        if (!visited.has(nxt)) {
          visited.add(nxt);
          queue.push(nxt);
        }
      }
    }
    return [...visited].sort(compareStringsCodeUnit);
  };

  const classifyEndpoint = (
    edge: AnyEdge,
    endpoint: 'start' | 'end',
    isTunnel: boolean
  ): {
    classification: GradeSeparatedEndpointClassification;
    transition?: GradeTransitionRenderDescriptor;
  } => {
    const nodeId = endpoint === 'start' ? edge.fromNodeId : edge.toNodeId;
    const node = getNode(nodeId);
    const equivNodes = getEquivalentNodeIds(nodeId);

    // 1. Confirmed transition to ground
    const directGt = confirmedTransitionByEndpoint.get(`${edge.id}|${endpoint}`);
    if (directGt) {
      return { classification: 'confirmed_transition', transition: directGt };
    }
    for (const eqId of equivNodes) {
      const nodeGt = confirmedTransitionByNodeId.get(eqId);
      if (nodeGt) {
        return { classification: 'confirmed_transition', transition: nodeGt };
      }
    }

    // 2. Confirmed elevated (or tunnel) continuation within structure stratum
    const incidentMap = isTunnel ? tunnelIncidentByNode : bridgeIncidentByNode;
    const incidentEdgeIds = new Set<string>();
    for (const eqId of equivNodes) {
      for (const inc of incidentMap.get(eqId) ?? []) {
        incidentEdgeIds.add(inc.id);
      }
    }
    if (incidentEdgeIds.size >= 2) {
      return { classification: 'confirmed_elevated_continuation' };
    }

    // 3. Boundary-clipped continuation
    const isClipped =
      (endpoint === 'start' ? edge.clippedAtStart : edge.clippedAtEnd) ||
      Boolean(node?.isBoundaryClipped) ||
      Boolean(node && (node.roles as readonly string[]).includes('boundary_clip'));
    if (isClipped) {
      return { classification: 'boundary_clipped_continuation' };
    }

    // 4. Unresolved connection
    if (
      unresolvedEndpointKeys.has(`${edge.id}|${endpoint}`) ||
      equivNodes.some((eqId) => unresolvedNodeIds.has(eqId))
    ) {
      return { classification: 'unresolved_connection' };
    }

    // 5. Intentionally standalone structure
    return { classification: 'intentionally_standalone' };
  };

  // 6. Solve bridge and tunnel super-node target elevations for continuous multi-segment vertical profiles
  const superNodeKeyByNodeId = new Map<string, string>();
  const superNodeTargetY = new Map<string, number>();
  for (const e of bridgeEdges) {
    for (const nid of [e.fromNodeId, e.toNodeId]) {
      if (superNodeKeyByNodeId.has(nid)) continue;
      const equiv = getEquivalentNodeIds(nid);
      const canonicalKey = equiv[0];
      const elevs: number[] = [];
      for (const eqId of equiv) {
        superNodeKeyByNodeId.set(eqId, canonicalKey);
        for (const inc of bridgeIncidentByNode.get(eqId) ?? []) {
          elevs.push(getTargetDeckElevation(inc));
        }
      }
      const avgY =
        elevs.length > 0
          ? elevs.reduce((sum, v) => sum + v, 0) / elevs.length
          : getTargetDeckElevation(e);
      superNodeTargetY.set(canonicalKey, Number(avgY.toFixed(4)));
    }
  }

  for (const e of tunnelEdges) {
    for (const nid of [e.fromNodeId, e.toNodeId]) {
      if (superNodeKeyByNodeId.has(nid)) continue;
      const equiv = getEquivalentNodeIds(nid);
      const canonicalKey = equiv[0];
      const elevs: number[] = [];
      for (const eqId of equiv) {
        superNodeKeyByNodeId.set(eqId, canonicalKey);
        for (const inc of tunnelIncidentByNode.get(eqId) ?? []) {
          elevs.push(getTargetDeckElevation(inc));
        }
      }
      // For connected tunnel segments, harmonize at the deepest required clearance floor at the joint
      const minY =
        elevs.length > 0 ? Math.min(...elevs) : getTargetDeckElevation(e);
      superNodeTargetY.set(canonicalKey, Number(minY.toFixed(4)));
    }
  }

  // Adjacency in bridge super-node graph
  const bridgeAdj = new Map<string, Array<{ toSuperNode: string; edge: AnyEdge }>>();
  for (const e of bridgeEdges) {
    const u = superNodeKeyByNodeId.get(e.fromNodeId)!;
    const v = superNodeKeyByNodeId.get(e.toNodeId)!;
    if (!bridgeAdj.has(u)) bridgeAdj.set(u, []);
    if (!bridgeAdj.has(v)) bridgeAdj.set(v, []);
    bridgeAdj.get(u)!.push({ toSuperNode: v, edge: e });
    bridgeAdj.get(v)!.push({ toSuperNode: u, edge: e });
  }

  const endpointMetaByEdgeId = new Map<
    string,
    {
      start: {
        classification: GradeSeparatedEndpointClassification;
        transition?: GradeTransitionRenderDescriptor;
      };
      end: {
        classification: GradeSeparatedEndpointClassification;
        transition?: GradeTransitionRenderDescriptor;
      };
    }
  >();

  for (const e of [...bridgeEdges, ...tunnelEdges]) {
    const isTun = tunnelEdgeById.has(e.id);
    endpointMetaByEdgeId.set(e.id, {
      start: classifyEndpoint(e, 'start', isTun),
      end: classifyEndpoint(e, 'end', isTun),
    });
  }

  const portalDistBySuperNode = new Map<string, number>();
  const componentSpanByEdgeId = new Map<string, number>();
  const componentRampByEdgeId = new Map<string, number>();

  const visitedSuperNodes = new Set<string>();
  const allSuperNodes = [...bridgeAdj.keys()].sort(compareStringsCodeUnit);

  for (const rootSuperNode of allSuperNodes) {
    if (visitedSuperNodes.has(rootSuperNode)) continue;

    // Collect connected component
    const compSuperNodes: string[] = [];
    const compEdgeMap = new Map<string, AnyEdge>();
    const bfs = [rootSuperNode];
    visitedSuperNodes.add(rootSuperNode);

    while (bfs.length > 0) {
      const cur = bfs.shift()!;
      compSuperNodes.push(cur);
      for (const { toSuperNode, edge } of bridgeAdj.get(cur) ?? []) {
        compEdgeMap.set(edge.id, edge);
        if (!visitedSuperNodes.has(toSuperNode)) {
          visitedSuperNodes.add(toSuperNode);
          bfs.push(toSuperNode);
        }
      }
    }

    const compEdges = [...compEdgeMap.values()].sort((a, b) =>
      compareStringsCodeUnit(a.id, b.id)
    );
    const portalSuperNodes = new Set<string>();
    for (const e of compEdges) {
      const meta = endpointMetaByEdgeId.get(e.id)!;
      if (meta.start.classification === 'confirmed_transition') {
        portalSuperNodes.add(superNodeKeyByNodeId.get(e.fromNodeId)!);
      }
      if (meta.end.classification === 'confirmed_transition') {
        portalSuperNodes.add(superNodeKeyByNodeId.get(e.toNodeId)!);
      }
    }

    // Dijkstra from all portalSuperNodes
    for (const sn of compSuperNodes) {
      portalDistBySuperNode.set(sn, portalSuperNodes.has(sn) ? 0 : Infinity);
    }

    if (portalSuperNodes.size > 0) {
      const unvisited = new Set<string>(compSuperNodes);
      while (unvisited.size > 0) {
        let bestNode: string | null = null;
        let bestDist = Infinity;
        for (const cand of unvisited) {
          const d = portalDistBySuperNode.get(cand) ?? Infinity;
          if (d < bestDist) {
            bestDist = d;
            bestNode = cand;
          }
        }
        if (bestNode === null || !Number.isFinite(bestDist)) break;
        unvisited.delete(bestNode);

        for (const { toSuperNode, edge } of bridgeAdj.get(bestNode) ?? []) {
          const alt = bestDist + edge.lengthMeters;
          if (alt < (portalDistBySuperNode.get(toSuperNode) ?? Infinity)) {
            portalDistBySuperNode.set(toSuperNode, alt);
          }
        }
      }
    }

    // Determine effective span and ramp length for this bridge component
    if (compEdges.length === 1) {
      const onlyEdge = compEdges[0];
      const meta = endpointMetaByEdgeId.get(onlyEdge.id)!;
      const L = onlyEdge.lengthMeters;
      const startIsTrans = meta.start.classification === 'confirmed_transition';
      const endIsTrans = meta.end.classification === 'confirmed_transition';
      const otherIsClipped =
        meta.start.classification === 'boundary_clipped_continuation' ||
        meta.end.classification === 'boundary_clipped_continuation';

      let rampLen = 0;
      if (startIsTrans && endIsTrans) {
        rampLen =
          L < MIN_RAMPED_BRIDGE_SPAN_METERS
            ? 0
            : Math.min(
                DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS,
                L * DEFAULT_BRIDGE_RAMP_MAX_FRACTION
              );
      } else if (startIsTrans || endIsTrans) {
        if (L < MIN_RAMPED_BRIDGE_SPAN_METERS) {
          rampLen = otherIsClipped
            ? DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS
            : Math.min(DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS, L * 0.60);
        } else {
          rampLen = Math.min(
            DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS,
            L * DEFAULT_BRIDGE_RAMP_MAX_FRACTION
          );
        }
      }
      componentSpanByEdgeId.set(onlyEdge.id, L);
      componentRampByEdgeId.set(onlyEdge.id, rampLen);
    } else {
      // Multi-edge bridge component: compute longest shortest-path diameter across component super-nodes
      let maxPathSpan = 0;
      const runSingleSourceShortestPath = (src: string): number => {
        const dist = new Map<string, number>();
        for (const sn of compSuperNodes) dist.set(sn, sn === src ? 0 : Infinity);
        const rem = new Set<string>(compSuperNodes);
        let maxD = 0;
        while (rem.size > 0) {
          let u: string | null = null;
          let best = Infinity;
          for (const c of rem) {
            const d = dist.get(c)!;
            if (d < best) {
              best = d;
              u = c;
            }
          }
          if (u === null || !Number.isFinite(best)) break;
          rem.delete(u);
          if (best > maxD) maxD = best;
          for (const { toSuperNode, edge } of bridgeAdj.get(u) ?? []) {
            const alt = best + edge.lengthMeters;
            if (alt < dist.get(toSuperNode)!) {
              dist.set(toSuperNode, alt);
            }
          }
        }
        return maxD;
      };

      const seedNodes =
        portalSuperNodes.size > 0 ? [...portalSuperNodes] : compSuperNodes.slice(0, 4);
      for (const sNode of seedNodes) {
        maxPathSpan = Math.max(maxPathSpan, runSingleSourceShortestPath(sNode));
      }
      for (const e of compEdges) {
        maxPathSpan = Math.max(maxPathSpan, e.lengthMeters);
      }

      let rampLen = 0;
      if (portalSuperNodes.size >= 2) {
        rampLen =
          maxPathSpan < MIN_RAMPED_BRIDGE_SPAN_METERS
            ? 0
            : Math.min(
                DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS,
                maxPathSpan * DEFAULT_BRIDGE_RAMP_MAX_FRACTION
              );
      } else if (portalSuperNodes.size === 1) {
        rampLen = Math.min(
          DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS,
          maxPathSpan < MIN_RAMPED_BRIDGE_SPAN_METERS
            ? maxPathSpan * 0.60
            : maxPathSpan * DEFAULT_BRIDGE_RAMP_MAX_FRACTION
        );
      }

      for (const e of compEdges) {
        componentSpanByEdgeId.set(e.id, maxPathSpan);
        componentRampByEdgeId.set(e.id, rampLen);
      }
    }
  }

  // 7. Assemble final plans and diagnostics
  const plansByEdgeId = new Map<string, ResolvedGradeSeparatedEdgePlan>();
  let confirmedTransitionsConsumed = 0;
  let confirmedElevatedContinuations = 0;
  let unresolvedTransitionsCount = 0;
  let boundaryClippedEndpointsCount = 0;
  let intentionallyStandaloneEndpointsCount = 0;

  const tallyClassification = (c: GradeSeparatedEndpointClassification) => {
    if (c === 'confirmed_transition') confirmedTransitionsConsumed++;
    else if (c === 'confirmed_elevated_continuation') confirmedElevatedContinuations++;
    else if (c === 'boundary_clipped_continuation') boundaryClippedEndpointsCount++;
    else if (c === 'unresolved_connection') unresolvedTransitionsCount++;
    else intentionallyStandaloneEndpointsCount++;
  };

  for (const e of [...bridgeEdges, ...tunnelEdges].sort((a, b) =>
    compareStringsCodeUnit(a.id, b.id)
  )) {
    const isTun = tunnelEdgeById.has(e.id);
    const meta = endpointMetaByEdgeId.get(e.id)!;
    tallyClassification(meta.start.classification);
    tallyClassification(meta.end.classification);

    const pts: [number, number][] = e.points.map((p) => [p[0], p[1]]);
    let edgeCorrectedCount = 0;

    // Snap start endpoint if confirmed transition or cross-scope continuation
    const startSnapPos =
      meta.start.transition?.position ?? crossScopeSnapPositionByNode.get(e.fromNodeId);
    if (startSnapPos && pts.length >= 2) {
      const dist = Math.hypot(pts[0][0] - startSnapPos[0], pts[0][1] - startSnapPos[1]);
      if (dist > 1e-4) {
        edgeCorrectedCount++;
        correctedPortalDiscontinuitiesCount++;
      }
      pts[0] = [startSnapPos[0], startSnapPos[1]];
    }

    // Snap end endpoint if confirmed transition or cross-scope continuation
    const endSnapPos =
      meta.end.transition?.position ?? crossScopeSnapPositionByNode.get(e.toNodeId);
    if (endSnapPos && pts.length >= 2) {
      const lastIdx = pts.length - 1;
      const dist = Math.hypot(
        pts[lastIdx][0] - endSnapPos[0],
        pts[lastIdx][1] - endSnapPos[1]
      );
      if (dist > 1e-4) {
        edgeCorrectedCount++;
        correctedPortalDiscontinuitiesCount++;
      }
      pts[lastIdx] = [endSnapPos[0], endSnapPos[1]];
    }

    const defaultTargetY = getTargetDeckElevation(e);
    const uSuper = superNodeKeyByNodeId.get(e.fromNodeId);
    const vSuper = superNodeKeyByNodeId.get(e.toNodeId);

    const startPortalDistanceMeters = isTun
      ? Infinity
      : uSuper
        ? (portalDistBySuperNode.get(uSuper) ?? Infinity)
        : Infinity;
    const endPortalDistanceMeters = isTun
      ? Infinity
      : vSuper
        ? (portalDistBySuperNode.get(vSuper) ?? Infinity)
        : Infinity;

    const plan = {
      edgeId: e.id,
      network,
      isBridge: !isTun,
      isTunnel: isTun,
      points: pts,
      startClassification: meta.start.classification,
      endClassification: meta.end.classification,
      startTransition: meta.start.transition,
      endTransition: meta.end.transition,
      startPortalDistanceMeters,
      endPortalDistanceMeters,
      componentRampLengthMeters: isTun ? 0 : (componentRampByEdgeId.get(e.id) ?? 0),
      componentSpanMeters: isTun
        ? e.lengthMeters
        : (componentSpanByEdgeId.get(e.id) ?? e.lengthMeters),
      startTargetDeckElevation: uSuper
        ? (superNodeTargetY.get(uSuper) ?? defaultTargetY)
        : defaultTargetY,
      endTargetDeckElevation: vSuper
        ? (superNodeTargetY.get(vSuper) ?? defaultTargetY)
        : defaultTargetY,
      correctedPortalDiscontinuities: edgeCorrectedCount,
    };
    plansByEdgeId.set(e.id, plan);
    if (e.sourceFeatureId && e.sourceFeatureId !== e.id) {
      plansByEdgeId.set(e.sourceFeatureId, plan);
    }
  }

  return {
    plansByEdgeId,
    atGradePortalSnapsByEdgeId: atGradePortalSnaps,
    diagnostics: {
      mode: 'graph',
      confirmedTransitionsConsumed,
      confirmedElevatedContinuations,
      unresolvedTransitionsCount,
      boundaryClippedEndpointsCount,
      intentionallyStandaloneEndpointsCount,
      legacyFallbacksCount: 0,
      correctedPortalDiscontinuitiesCount,
      bridgeAndTunnelBuildTimeMs: 0,
    },
  };
}

