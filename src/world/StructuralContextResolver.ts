import * as THREE from 'three';
import type { BarrierFeature, RailwayFeature, RoadFeature } from '../types/MapFeature';
import {
  ELEVATION_POLICY,
  getRailwayElevations,
  getRoadElevation,
  resolveTunnelClearanceAndDepth,
} from './ElevationPolicy';
import { classifyInfrastructurePlacement } from './InfrastructurePlacementClassifier';

export type BarrierStructuralPlacementKind =
  | 'surface_standard'
  | 'subterranean_enclosed'
  | 'cutting_or_portal_approach'
  | 'unassociated_negative_layer';

export type BarrierStructuralKind = BarrierStructuralPlacementKind;

export interface BarrierProfileVertex3D {
  x: number;
  z: number;
  arcLength: number;
  baseY: number;
  topY: number;
}

export interface BarrierStructuralContext {
  barrierId: string;
  sourceFeatureId: string;
  kind: BarrierStructuralPlacementKind;
  layer: number;
  /** Minimum base Y across all vertices of this barrier (m). */
  minBaseY: number;
  /** Maximum top Y across all vertices of this barrier (m). */
  maxTopY: number;
  /** Representative elevation reported in InspectableFeatureInfo (m). */
  representativeElevationY: number;
  /** True when the barrier is completely enclosed underground and should be placed in the subterranean structural layer. */
  rendersInSubterraneanLayer: boolean;
  /** True when `layer < 0` was present without any verified subterranean or cutting corridor association. */
  isUncertainNegativeLayer: boolean;
  /** Associated subterranean or cutting corridor source feature IDs (sorted). */
  associatedCorridorFeatureIds: readonly string[];
  /** Associated approach/neighboring barrier source feature IDs sharing explicit OSM nodes (sorted). */
  sharedNodeBarrierFeatureIds: readonly string[];
  /** Per-vertex variable `[baseY, topY]` 3D profile along the barrier polyline. */
  profile: readonly BarrierProfileVertex3D[];
}

export interface StructuralContextDiagnostics {
  totalBarriersEvaluated: number;
  surfaceStandardBarrierCount: number;
  subterraneanEnclosedBarrierCount: number;
  cuttingOrPortalApproachBarrierCount: number;
  unassociatedNegativeLayerBarrierCount: number;
  subterraneanEnclosedBarrierIds: string[];
  cuttingOrPortalApproachBarrierIds: string[];
  unassociatedNegativeLayerBarrierIds: string[];
}

interface CorridorSegmentEntry {
  featureId: string;
  sourceFeatureId: string;
  corridorKind: 'underground_tunnel' | 'open_cutting';
  domain: 'road' | 'railway';
  layer: number;
  width: number;
  floorY: number;
  roofSoffitY: number;
  surfaceY: number;
  p0: [number, number];
  p1: [number, number];
  tx: number;
  tz: number;
  segLen: number;
  s0: number;
  s1: number;
  totalLen: number;
  rampStartLen: number;
  rampEndLen: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const GRID_CELL_SIZE = 16.0;
const MAX_CORRIDOR_ASSOCIATION_DIST_METERS = 18.0;
const MIN_DIRECTIONAL_ALIGNMENT_DOT = 0.62;

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pointToSegmentProjection(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number
): { dist: number; t: number; projX: number; projZ: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-8) {
    return { dist: Math.hypot(px - ax, pz - az), t: 0, projX: ax, projZ: az };
  }
  const rawT = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  const t = Math.max(0, Math.min(1, rawT));
  const projX = ax + dx * t;
  const projZ = az + dz * t;
  return {
    dist: Math.hypot(px - projX, pz - projZ),
    t,
    projX,
    projZ,
  };
}

function evaluateCorridorFloorAtArcLength(
  seg: CorridorSegmentEntry,
  s: number
): { floorY: number; isInsidePortalRamp: boolean } {
  if (seg.corridorKind === 'open_cutting') {
    return { floorY: seg.floorY, isInsidePortalRamp: true };
  }
  const smoothstep = (u: number): number => {
    const c = Math.max(0, Math.min(1, u));
    return c * c * (3 - 2 * c);
  };
  if (seg.rampStartLen > 1e-3 && s < seg.rampStartLen) {
    const t = smoothstep(s / seg.rampStartLen);
    return {
      floorY: seg.surfaceY + (seg.floorY - seg.surfaceY) * t,
      isInsidePortalRamp: true,
    };
  }
  if (seg.rampEndLen > 1e-3 && s > seg.totalLen - seg.rampEndLen) {
    const rem = Math.max(0, seg.totalLen - s);
    const t = smoothstep(rem / seg.rampEndLen);
    return {
      floorY: seg.surfaceY + (seg.floorY - seg.surfaceY) * t,
      isInsidePortalRamp: true,
    };
  }
  return { floorY: seg.floorY, isInsidePortalRamp: false };
}

/**
 * Evaluates all linear barriers (`barrier=retaining_wall`, `wall`, `fence`, `embankment`, etc.)
 * in relation to surrounding subterranean tunnels, underpasses, open cuttings, and connected
 * retaining wall chains (M2.3-E4-T2).
 *
 * Uses a bounded 2D spatial grid (`16 m` cells) and explicit OSM node / topological node sharing
 * rather than global $O(N^2)$ proximity searches or blind negative-layer sinking.
 */
export function resolveBarrierStructuralContexts(
  barriers: readonly BarrierFeature[],
  roads: readonly RoadFeature[],
  railways: readonly RailwayFeature[]
): {
  contextsById: ReadonlyMap<string, BarrierStructuralContext>;
  diagnostics: StructuralContextDiagnostics;
} {
  const diagnostics: StructuralContextDiagnostics = {
    totalBarriersEvaluated: 0,
    surfaceStandardBarrierCount: 0,
    subterraneanEnclosedBarrierCount: 0,
    cuttingOrPortalApproachBarrierCount: 0,
    unassociatedNegativeLayerBarrierCount: 0,
    subterraneanEnclosedBarrierIds: [],
    cuttingOrPortalApproachBarrierIds: [],
    unassociatedNegativeLayerBarrierIds: [],
  };

  const contextsById = new Map<string, BarrierStructuralContext>();
  if (!barriers || barriers.length === 0) {
    return { contextsById, diagnostics };
  }

  // 1. Index subterranean tunnel and open-cutting road & railway segments into a 2D spatial grid
  const corridorSegments: CorridorSegmentEntry[] = [];
  const spatialGrid = new Map<string, CorridorSegmentEntry[]>();
  const corridorOsmNodeToFeatureIds = new Map<string, Set<string>>();

  const registerSegmentInGrid = (entry: CorridorSegmentEntry) => {
    corridorSegments.push(entry);
    const gx0 = Math.floor((entry.minX - MAX_CORRIDOR_ASSOCIATION_DIST_METERS) / GRID_CELL_SIZE);
    const gx1 = Math.floor((entry.maxX + MAX_CORRIDOR_ASSOCIATION_DIST_METERS) / GRID_CELL_SIZE);
    const gz0 = Math.floor((entry.minZ - MAX_CORRIDOR_ASSOCIATION_DIST_METERS) / GRID_CELL_SIZE);
    const gz1 = Math.floor((entry.maxZ + MAX_CORRIDOR_ASSOCIATION_DIST_METERS) / GRID_CELL_SIZE);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const key = `${gx},${gz}`;
        let cell = spatialGrid.get(key);
        if (!cell) {
          cell = [];
          spatialGrid.set(key, cell);
        }
        cell.push(entry);
      }
    }
  };

  const addPolylineToCorridorIndex = (
    featureId: string,
    sourceFeatureId: string,
    corridorKind: 'underground_tunnel' | 'open_cutting',
    domain: 'road' | 'railway',
    layer: number,
    width: number,
    floorY: number,
    roofSoffitY: number,
    surfaceY: number,
    pts: readonly [number, number][],
    nodeIds?: readonly (string | number | undefined)[]
  ) => {
    if (!pts || pts.length < 2) return;
    if (nodeIds) {
      for (const nid of nodeIds) {
        if (nid === undefined || nid === null || String(nid).trim() === '') continue;
        const key = String(nid).trim();
        let set = corridorOsmNodeToFeatureIds.get(key);
        if (!set) {
          set = new Set();
          corridorOsmNodeToFeatureIds.set(key, set);
        }
        set.add(sourceFeatureId);
      }
    }

    let totalLen = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      totalLen += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    }
    if (totalLen < 0.2) return;

    const nominalRamp =
      corridorKind === 'underground_tunnel' ? Math.min(10.0, totalLen * 0.35) : 0;

    let accumS = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0: [number, number] = [pts[i][0], pts[i][1]];
      const p1: [number, number] = [pts[i + 1][0], pts[i + 1][1]];
      const segLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (segLen < 1e-4) continue;
      const tx = (p1[0] - p0[0]) / segLen;
      const tz = (p1[1] - p0[1]) / segLen;
      registerSegmentInGrid({
        featureId,
        sourceFeatureId,
        corridorKind,
        domain,
        layer,
        width,
        floorY,
        roofSoffitY,
        surfaceY,
        p0,
        p1,
        tx,
        tz,
        segLen,
        s0: accumS,
        s1: accumS + segLen,
        totalLen,
        rampStartLen: nominalRamp,
        rampEndLen: nominalRamp,
        minX: Math.min(p0[0], p1[0]),
        maxX: Math.max(p0[0], p1[0]),
        minZ: Math.min(p0[1], p1[1]),
        maxZ: Math.max(p0[1], p1[1]),
      });
      accumS += segLen;
    }
  };

  for (const r of roads || []) {
    if (!r.points || r.points.length < 2) continue;
    const placement =
      r.placementClassification ??
      classifyInfrastructurePlacement(r.osmTags, {
        isBridge: r.isBridge,
        isTunnel: r.isTunnel,
        layer: r.layer,
        featureDomain: 'road',
      });
    if (placement.hasConflict) continue;

    if (placement.isSubterraneanTunnel) {
      const maxH = placement.supportingEvidence.maxheightMeters;
      const clearance = resolveTunnelClearanceAndDepth({
        domain: 'road',
        layer: r.layer,
        roadClass: r.roadClass,
        maxheightMeters: maxH,
      });
      const floorY = getRoadElevation(r.roadClass, r.layer, false, true, r.sourceFeatureId || r.id, maxH);
      addPolylineToCorridorIndex(
        r.id,
        r.sourceFeatureId || r.id,
        'underground_tunnel',
        'road',
        r.layer < 0 ? r.layer : -1,
        r.width,
        floorY,
        clearance.targetRoofSoffitElevation,
        ELEVATION_POLICY.ROAD_SURFACE,
        r.points,
        r.nodeIds
      );
    } else if (placement.isOpenCutting) {
      addPolylineToCorridorIndex(
        r.id,
        r.sourceFeatureId || r.id,
        'open_cutting',
        'road',
        r.layer,
        r.width,
        ELEVATION_POLICY.OPEN_CUTTING_DEPTH,
        ELEVATION_POLICY.GROUND_COVER_SURFACE,
        ELEVATION_POLICY.ROAD_SURFACE,
        r.points,
        r.nodeIds
      );
    }
  }

  for (const rw of railways || []) {
    if (!rw.points || rw.points.length < 2) continue;
    const placement =
      rw.placementClassification ??
      classifyInfrastructurePlacement(rw.osmTags, {
        isBridge: rw.isBridge,
        isTunnel: rw.isTunnel,
        layer: rw.layer,
        featureDomain: 'railway',
      });
    if (placement.hasConflict) continue;

    if (placement.isSubterraneanTunnel) {
      const maxH = placement.supportingEvidence.maxheightMeters;
      const clearance = resolveTunnelClearanceAndDepth({
        domain: 'railway',
        layer: rw.layer,
        railwayType: rw.railwayType,
        electrified: rw.electrified ?? (rw.osmTags?.electrified as string | boolean | undefined),
        maxheightMeters: maxH,
      });
      const elevs = getRailwayElevations(rw.layer, false, true, {
        railwayType: rw.railwayType,
        electrified: rw.electrified ?? (rw.osmTags?.electrified as string | boolean | undefined),
        maxheightMeters: maxH,
      });
      addPolylineToCorridorIndex(
        rw.id,
        rw.sourceFeatureId || rw.id,
        'underground_tunnel',
        'railway',
        rw.layer < 0 ? rw.layer : -1,
        rw.width,
        elevs.ballast,
        clearance.targetRoofSoffitElevation,
        ELEVATION_POLICY.RAILWAY_BALLAST,
        rw.points,
        rw.nodeIds
      );
    } else if (placement.isOpenCutting) {
      addPolylineToCorridorIndex(
        rw.id,
        rw.sourceFeatureId || rw.id,
        'open_cutting',
        'railway',
        rw.layer,
        rw.width,
        ELEVATION_POLICY.OPEN_CUTTING_DEPTH,
        ELEVATION_POLICY.GROUND_COVER_SURFACE,
        ELEVATION_POLICY.RAILWAY_BALLAST,
        rw.points,
        rw.nodeIds
      );
    }
  }

  // 2. Build barrier-to-barrier node sharing index (both raw OSM node IDs and snapped endpoints <= 0.15 m)
  const nodeToBarrierIds = new Map<string, Set<string>>();
  const registerBarrierNodeKey = (key: string, barrierSourceId: string) => {
    let s = nodeToBarrierIds.get(key);
    if (!s) {
      s = new Set();
      nodeToBarrierIds.set(key, s);
    }
    s.add(barrierSourceId);
  };

  for (const bar of barriers) {
    if (!bar.points || bar.points.length < 2) continue;
    const bSid = bar.sourceFeatureId || bar.id;
    if (bar.rawOsmNodeIds) {
      for (const rn of bar.rawOsmNodeIds) {
        if (rn) registerBarrierNodeKey(`osm:${rn}`, bSid);
      }
    }
    if (bar.nodeIds) {
      for (const cn of bar.nodeIds) {
        if (cn !== undefined && cn !== null && String(cn) !== '') {
          registerBarrierNodeKey(`topo:${cn}`, bSid);
        }
      }
    }
    for (const pt of bar.points) {
      const qx = Math.round(pt[0] / 0.15);
      const qz = Math.round(pt[1] / 0.15);
      registerBarrierNodeKey(`coord:${qx},${qz}`, bSid);
    }
  }

  const getSharedNodeBarrierIds = (bar: BarrierFeature): string[] => {
    const bSid = bar.sourceFeatureId || bar.id;
    const related = new Set<string>();
    const checkKey = (key: string) => {
      const matches = nodeToBarrierIds.get(key);
      if (!matches) return;
      for (const m of matches) {
        if (m !== bSid) related.add(m);
      }
    };
    if (bar.rawOsmNodeIds) {
      for (const rn of bar.rawOsmNodeIds) {
        if (rn) checkKey(`osm:${rn}`);
      }
    }
    if (bar.nodeIds) {
      for (const cn of bar.nodeIds) {
        if (cn !== undefined && cn !== null && String(cn) !== '') checkKey(`topo:${cn}`);
      }
    }
    for (const pt of bar.points) {
      const qx = Math.round(pt[0] / 0.15);
      const qz = Math.round(pt[1] / 0.15);
      checkKey(`coord:${qx},${qz}`);
    }
    return [...related].sort(compareCodeUnits);
  };

  const queryNearbyCorridorSegments = (x: number, z: number): CorridorSegmentEntry[] => {
    const gx = Math.floor(x / GRID_CELL_SIZE);
    const gz = Math.floor(z / GRID_CELL_SIZE);
    return spatialGrid.get(`${gx},${gz}`) ?? [];
  };

  // 3. First pass: identify barriers that are explicitly subterranean or negative-layer with verified corridor association
  const subterraneanBarrierSourceIds = new Set<string>();
  const subterraneanFloorByBarrierSourceId = new Map<string, number>();

  interface PreclassifiedBarrier {
    bar: BarrierFeature;
    layer: number;
    explicitTunnelOrUnderground: boolean;
    explicitCutting: boolean;
    sharedNodeBarrierIds: string[];
    matchedTunnelCorridorIds: string[];
    matchedCuttingCorridorIds: string[];
    deepestMatchedTunnelFloorY: number;
    shallowestMatchedRoofSoffitY: number;
  }

  const preclassified: PreclassifiedBarrier[] = [];

  for (const bar of barriers) {
    if (!bar.points || bar.points.length < 2 || bar.barrierType === 'tree_row') continue;
    const rawTags = bar.osmTags || {};
    const rawLayer =
      bar.layer !== undefined
        ? bar.layer
        : rawTags.layer !== undefined
          ? parseInt(String(rawTags.layer), 10) || 0
          : 0;
    const tunnelVal = String(rawTags.tunnel ?? '').trim().toLowerCase();
    const locationVal = String(rawTags.location ?? '').trim().toLowerCase();
    const cuttingVal = String(rawTags.cutting ?? '').trim().toLowerCase();
    const explicitTunnelOrUnderground =
      Boolean(bar.isTunnel) ||
      tunnelVal === 'yes' ||
      tunnelVal === 'underpass' ||
      tunnelVal === 'railway' ||
      tunnelVal === 'subway' ||
      locationVal === 'underground';
    const explicitCutting =
      cuttingVal === 'yes' || cuttingVal === 'left' || cuttingVal === 'right' || cuttingVal === 'both';

    const sharedNodeBarrierIds = getSharedNodeBarrierIds(bar);
    const matchedTunnelIds = new Set<string>();
    const matchedCuttingIds = new Set<string>();
    let deepestTunnelFloorY = ELEVATION_POLICY.TUNNEL_DEPTH;
    let shallowestRoofSoffitY = -ELEVATION_POLICY.TUNNEL_ROOF_COVER_THICKNESS;

    // Check explicit OSM node sharing with corridor ways
    if (bar.rawOsmNodeIds) {
      for (const rn of bar.rawOsmNodeIds) {
        if (!rn) continue;
        const cSet = corridorOsmNodeToFeatureIds.get(rn);
        if (cSet) {
          for (const cid of cSet) matchedTunnelIds.add(cid);
        }
      }
    }

    // Sample barrier segments against the spatial corridor grid
    let totalBarrierLen = 0;
    let alignedTunnelWeight = 0;
    let alignedCuttingWeight = 0;

    for (let i = 0; i < bar.points.length - 1; i++) {
      const p0 = bar.points[i];
      const p1 = bar.points[i + 1];
      const segLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (segLen < 1e-4) continue;
      totalBarrierLen += segLen;
      const btx = (p1[0] - p0[0]) / segLen;
      const btz = (p1[1] - p0[1]) / segLen;
      const midX = (p0[0] + p1[0]) * 0.5;
      const midZ = (p0[1] + p1[1]) * 0.5;

      const candidates = queryNearbyCorridorSegments(midX, midZ);
      let segMatchedTunnel = false;
      let segMatchedCutting = false;

      for (const cand of candidates) {
        const maxLateral = Math.max(cand.width * 0.5 + 14.0, MAX_CORRIDOR_ASSOCIATION_DIST_METERS);
        const projMid = pointToSegmentProjection(
          midX,
          midZ,
          cand.p0[0],
          cand.p0[1],
          cand.p1[0],
          cand.p1[1]
        );
        if (projMid.dist > maxLateral) continue;

        const absDot = Math.abs(btx * cand.tx + btz * cand.tz);
        if (absDot < MIN_DIRECTIONAL_ALIGNMENT_DOT) continue;

        if (cand.corridorKind === 'underground_tunnel') {
          const layerCompatible =
            rawLayer < 0 || explicitTunnelOrUnderground || projMid.dist <= cand.width * 0.5 + 8.5;
          if (!layerCompatible) continue;
          matchedTunnelIds.add(cand.sourceFeatureId);
          segMatchedTunnel = true;
          if (cand.floorY < deepestTunnelFloorY) deepestTunnelFloorY = cand.floorY;
          if (cand.roofSoffitY < shallowestRoofSoffitY) {
            shallowestRoofSoffitY = cand.roofSoffitY;
          }
        } else if (cand.corridorKind === 'open_cutting') {
          if (projMid.dist <= cand.width * 0.5 + 12.0) {
            matchedCuttingIds.add(cand.sourceFeatureId);
            segMatchedCutting = true;
          }
        }
      }

      if (segMatchedTunnel) alignedTunnelWeight += segLen;
      if (segMatchedCutting) alignedCuttingWeight += segLen;
    }

    const tunnelCoverageRatio =
      totalBarrierLen > 1e-4 ? alignedTunnelWeight / totalBarrierLen : 0;
    const isSubterraneanEnclosed =
      explicitTunnelOrUnderground ||
      (rawLayer < 0 && matchedTunnelIds.size > 0 && tunnelCoverageRatio >= 0.35);

    if (isSubterraneanEnclosed) {
      const bSid = bar.sourceFeatureId || bar.id;
      subterraneanBarrierSourceIds.add(bSid);
      subterraneanFloorByBarrierSourceId.set(bSid, deepestTunnelFloorY);
    }

    preclassified.push({
      bar,
      layer: rawLayer,
      explicitTunnelOrUnderground,
      explicitCutting,
      sharedNodeBarrierIds,
      matchedTunnelCorridorIds: [...matchedTunnelIds].sort(compareCodeUnits),
      matchedCuttingCorridorIds: [...matchedCuttingIds].sort(compareCodeUnits),
      deepestMatchedTunnelFloorY: deepestTunnelFloorY,
      shallowestMatchedRoofSoffitY: shallowestRoofSoffitY,
    });
  }

  // 4. Second pass: construct per-vertex [baseY, topY] profiles for each barrier
  for (const item of preclassified) {
    const {
      bar,
      layer,
      explicitTunnelOrUnderground,
      explicitCutting,
      sharedNodeBarrierIds,
      matchedTunnelCorridorIds,
      matchedCuttingCorridorIds,
      deepestMatchedTunnelFloorY,
      shallowestMatchedRoofSoffitY,
    } = item;

    diagnostics.totalBarriersEvaluated++;
    const bSid = bar.sourceFeatureId || bar.id;
    const touchesSubterraneanBarrier = sharedNodeBarrierIds.some((id) =>
      subterraneanBarrierSourceIds.has(id)
    );

    const cumArc: number[] = [0];
    for (let i = 0; i < bar.points.length - 1; i++) {
      const d = Math.hypot(
        bar.points[i + 1][0] - bar.points[i][0],
        bar.points[i + 1][1] - bar.points[i][1]
      );
      cumArc.push(cumArc[i] + d);
    }

    // Case A: Subterranean enclosed barrier (e.g., Europatunnel way/375064982 & way/375064983)
    if (subterraneanBarrierSourceIds.has(bSid)) {
      const baseFloorY =
        matchedTunnelCorridorIds.length > 0
          ? deepestMatchedTunnelFloorY
          : getRoadElevation('secondary', layer < 0 ? layer : -1, false, true);
      const maxAllowedTopY = Math.min(
        ELEVATION_POLICY.GROUND - 0.05,
        shallowestMatchedRoofSoffitY
      );
      const wallTopY = Math.min(maxAllowedTopY, baseFloorY + Math.max(bar.height, 3.2));

      const profile: BarrierProfileVertex3D[] = bar.points.map((pt, idx) => ({
        x: pt[0],
        z: pt[1],
        arcLength: cumArc[idx],
        baseY: Number(baseFloorY.toFixed(4)),
        topY: Number(Math.max(baseFloorY + 0.5, wallTopY).toFixed(4)),
      }));

      const ctx: BarrierStructuralContext = {
        barrierId: bar.id,
        sourceFeatureId: bSid,
        kind: 'subterranean_enclosed',
        layer: layer < 0 ? layer : -1,
        minBaseY: profile[0].baseY,
        maxTopY: profile[0].topY,
        representativeElevationY: profile[0].baseY,
        rendersInSubterraneanLayer: true,
        isUncertainNegativeLayer: false,
        associatedCorridorFeatureIds: matchedTunnelCorridorIds,
        sharedNodeBarrierFeatureIds: sharedNodeBarrierIds,
        profile,
      };
      contextsById.set(bar.id, ctx);
      diagnostics.subterraneanEnclosedBarrierCount++;
      diagnostics.subterraneanEnclosedBarrierIds.push(bSid);
      continue;
    }

    // Case B: Negative-layer barrier that touches a subterranean enclosed barrier at a shared node
    if (layer < 0 && touchesSubterraneanBarrier) {
      let neighborFloorY = ELEVATION_POLICY.TUNNEL_DEPTH;
      for (const nid of sharedNodeBarrierIds) {
        const nf = subterraneanFloorByBarrierSourceId.get(nid);
        if (nf !== undefined && nf < neighborFloorY) neighborFloorY = nf;
      }
      const wallTopY = Math.min(
        ELEVATION_POLICY.GROUND - 0.05,
        neighborFloorY + Math.max(bar.height, 3.2)
      );
      const profile: BarrierProfileVertex3D[] = bar.points.map((pt, idx) => ({
        x: pt[0],
        z: pt[1],
        arcLength: cumArc[idx],
        baseY: Number(neighborFloorY.toFixed(4)),
        topY: Number(Math.max(neighborFloorY + 0.5, wallTopY).toFixed(4)),
      }));

      const ctx: BarrierStructuralContext = {
        barrierId: bar.id,
        sourceFeatureId: bSid,
        kind: 'subterranean_enclosed',
        layer,
        minBaseY: profile[0].baseY,
        maxTopY: profile[0].topY,
        representativeElevationY: profile[0].baseY,
        rendersInSubterraneanLayer: true,
        isUncertainNegativeLayer: false,
        associatedCorridorFeatureIds: matchedTunnelCorridorIds,
        sharedNodeBarrierFeatureIds: sharedNodeBarrierIds,
        profile,
      };
      contextsById.set(bar.id, ctx);
      diagnostics.subterraneanEnclosedBarrierCount++;
      diagnostics.subterraneanEnclosedBarrierIds.push(bSid);
      continue;
    }

    // Case C: Open cutting or portal approach retaining wall (variable baseY along depressed corridor/approach)
    const isRetainingOrWall =
      bar.barrierType === 'retaining_wall' ||
      bar.barrierType === 'wall' ||
      bar.barrierType === 'embankment' ||
      bar.barrierType === 'cliff';
    const hasCuttingOrApproachAssociation =
      explicitCutting ||
      matchedCuttingCorridorIds.length > 0 ||
      (isRetainingOrWall && (touchesSubterraneanBarrier || matchedTunnelCorridorIds.length > 0));

    if (hasCuttingOrApproachAssociation) {
      const surfaceBaseY = ELEVATION_POLICY.PARKS;
      const standardTopY =
        matchedCuttingCorridorIds.length > 0 || explicitCutting
          ? surfaceBaseY + 0.05
          : surfaceBaseY + bar.height;
      let minBaseY = surfaceBaseY;
      let maxTopY = standardTopY;

      const profile: BarrierProfileVertex3D[] = bar.points.map((pt, idx) => {
        const candidates = queryNearbyCorridorSegments(pt[0], pt[1]);
        let bestLocalFloorY = surfaceBaseY;

        if (explicitCutting && matchedCuttingCorridorIds.length === 0) {
          bestLocalFloorY = ELEVATION_POLICY.OPEN_CUTTING_DEPTH;
        }

        for (const cand of candidates) {
          const maxDist = cand.width * 0.5 + 12.0;
          const proj = pointToSegmentProjection(
            pt[0],
            pt[1],
            cand.p0[0],
            cand.p0[1],
            cand.p1[0],
            cand.p1[1]
          );
          if (proj.dist > maxDist) continue;
          const s = cand.s0 + proj.t * cand.segLen;
          const evalRes = evaluateCorridorFloorAtArcLength(cand, s);
          if (cand.corridorKind === 'open_cutting') {
            bestLocalFloorY = Math.min(bestLocalFloorY, evalRes.floorY);
          } else if (evalRes.isInsidePortalRamp) {
            bestLocalFloorY = Math.min(bestLocalFloorY, evalRes.floorY);
          } else if (touchesSubterraneanBarrier && proj.dist <= cand.width * 0.5 + 8.5) {
            // Smooth transition near portal entrance where approach wall meets subterranean wall
            const distToPortal = Math.min(s, Math.max(0, cand.totalLen - s));
            if (distToPortal <= 14.0) {
              const blend = Math.max(0, 1 - distToPortal / 14.0);
              const targetY = surfaceBaseY + (cand.floorY * 0.45 - surfaceBaseY) * blend;
              bestLocalFloorY = Math.min(bestLocalFloorY, targetY);
            }
          }
        }

        const vBaseY = Number(bestLocalFloorY.toFixed(4));
        const vTopY = Number(standardTopY.toFixed(4));
        if (vBaseY < minBaseY) minBaseY = vBaseY;
        if (vTopY > maxTopY) maxTopY = vTopY;

        return {
          x: pt[0],
          z: pt[1],
          arcLength: cumArc[idx],
          baseY: vBaseY,
          topY: vTopY,
        };
      });

      const allAssociatedIds = Array.from(
        new Set([...matchedCuttingCorridorIds, ...matchedTunnelCorridorIds])
      ).sort(compareCodeUnits);

      const ctx: BarrierStructuralContext = {
        barrierId: bar.id,
        sourceFeatureId: bSid,
        kind: 'cutting_or_portal_approach',
        layer,
        minBaseY,
        maxTopY,
        representativeElevationY: minBaseY,
        rendersInSubterraneanLayer: false,
        isUncertainNegativeLayer: false,
        associatedCorridorFeatureIds: allAssociatedIds,
        sharedNodeBarrierFeatureIds: sharedNodeBarrierIds,
        profile,
      };
      contextsById.set(bar.id, ctx);
      diagnostics.cuttingOrPortalApproachBarrierCount++;
      diagnostics.cuttingOrPortalApproachBarrierIds.push(bSid);
      continue;
    }

    // Case D: Unassociated negative-layer barrier (conservative surface fallback + explicit diagnostic record)
    if (layer < 0 && !explicitTunnelOrUnderground) {
      const baseY = ELEVATION_POLICY.PARKS;
      const topY = Number((baseY + bar.height).toFixed(4));
      const profile: BarrierProfileVertex3D[] = bar.points.map((pt, idx) => ({
        x: pt[0],
        z: pt[1],
        arcLength: cumArc[idx],
        baseY,
        topY,
      }));

      const ctx: BarrierStructuralContext = {
        barrierId: bar.id,
        sourceFeatureId: bSid,
        kind: 'unassociated_negative_layer',
        layer,
        minBaseY: baseY,
        maxTopY: topY,
        representativeElevationY: baseY,
        rendersInSubterraneanLayer: false,
        isUncertainNegativeLayer: true,
        associatedCorridorFeatureIds: [],
        sharedNodeBarrierFeatureIds: sharedNodeBarrierIds,
        profile,
      };
      contextsById.set(bar.id, ctx);
      diagnostics.unassociatedNegativeLayerBarrierCount++;
      diagnostics.unassociatedNegativeLayerBarrierIds.push(bSid);
      continue;
    }

    // Case E: Standard above-ground barrier
    const baseY = ELEVATION_POLICY.PARKS;
    const topY = Number((baseY + bar.height).toFixed(4));
    const profile: BarrierProfileVertex3D[] = bar.points.map((pt, idx) => ({
      x: pt[0],
      z: pt[1],
      arcLength: cumArc[idx],
      baseY,
      topY,
    }));

    const ctx: BarrierStructuralContext = {
      barrierId: bar.id,
      sourceFeatureId: bSid,
      kind: 'surface_standard',
      layer,
      minBaseY: baseY,
      maxTopY: topY,
      representativeElevationY: baseY,
      rendersInSubterraneanLayer: false,
      isUncertainNegativeLayer: false,
      associatedCorridorFeatureIds: [],
      sharedNodeBarrierFeatureIds: sharedNodeBarrierIds,
      profile,
    };
    contextsById.set(bar.id, ctx);
    diagnostics.surfaceStandardBarrierCount++;
  }

  return { contextsById, diagnostics };
}

/**
 * Extrudes a 3D wall/barrier ribbon with per-vertex variable `[baseY, topY]` elevations (M2.3-E4-T2).
 * Supports both constant-elevation surface barriers and sloped/depressed cutting or subterranean retaining walls.
 */
export function generateProfiledBarrierRibbon3D(
  profile: readonly BarrierProfileVertex3D[],
  width: number
): THREE.BufferGeometry | null {
  if (!profile || profile.length < 2) return null;

  const clean: BarrierProfileVertex3D[] = [profile[0]];
  for (let i = 1; i < profile.length; i++) {
    const prev = clean[clean.length - 1];
    const curr = profile[i];
    if (Math.hypot(curr.x - prev.x, curr.z - prev.z) > 0.05) {
      clean.push(curr);
    }
  }
  if (clean.length < 2) return null;

  const n = clean.length;
  const halfW = width * 0.5;
  const normals2D: [number, number][] = [];

  for (let i = 0; i < n; i++) {
    let tx = 0;
    let tz = 0;
    if (i < n - 1) {
      const dx = clean[i + 1].x - clean[i].x;
      const dz = clean[i + 1].z - clean[i].z;
      const l = Math.hypot(dx, dz) || 1;
      tx += dx / l;
      tz += dz / l;
    }
    if (i > 0) {
      const dx = clean[i].x - clean[i - 1].x;
      const dz = clean[i].z - clean[i - 1].z;
      const l = Math.hypot(dx, dz) || 1;
      tx += dx / l;
      tz += dz / l;
    }
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    normals2D.push([-tz, tx]);
  }

  const positions: number[] = [];
  const normArr: number[] = [];
  const indices: number[] = [];
  let vOffset = 0;

  const addQuad = (
    p0: [number, number, number],
    p1: [number, number, number],
    p2: [number, number, number],
    p3: [number, number, number],
    nx: number,
    ny: number,
    nz: number
  ) => {
    positions.push(...p0, ...p1, ...p2, ...p3);
    for (let k = 0; k < 4; k++) normArr.push(nx, ny, nz);
    indices.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
    vOffset += 4;
  };

  for (let i = 0; i < n - 1; i++) {
    const c0 = clean[i];
    const c1 = clean[i + 1];
    const n0 = normals2D[i];
    const n1 = normals2D[i + 1];

    const l0x = c0.x + n0[0] * halfW;
    const l0z = c0.z + n0[1] * halfW;
    const r0x = c0.x - n0[0] * halfW;
    const r0z = c0.z - n0[1] * halfW;

    const l1x = c1.x + n1[0] * halfW;
    const l1z = c1.z + n1[1] * halfW;
    const r1x = c1.x - n1[0] * halfW;
    const r1z = c1.z - n1[1] * halfW;

    // Top face
    addQuad(
      [l0x, c0.topY, l0z],
      [r0x, c0.topY, r0z],
      [r1x, c1.topY, r1z],
      [l1x, c1.topY, l1z],
      0,
      1,
      0
    );
    // Left face
    addQuad(
      [l0x, c0.baseY, l0z],
      [l0x, c0.topY, l0z],
      [l1x, c1.topY, l1z],
      [l1x, c1.baseY, l1z],
      n0[0],
      0,
      n0[1]
    );
    // Right face
    addQuad(
      [r1x, c1.baseY, r1z],
      [r1x, c1.topY, r1z],
      [r0x, c0.topY, r0z],
      [r0x, c0.baseY, r0z],
      -n0[0],
      0,
      -n0[1]
    );

    if (i === 0) {
      addQuad(
        [r0x, c0.baseY, r0z],
        [r0x, c0.topY, r0z],
        [l0x, c0.topY, l0z],
        [l0x, c0.baseY, l0z],
        -n0[1],
        0,
        n0[0]
      );
    }
    if (i === n - 2) {
      addQuad(
        [l1x, c1.baseY, l1z],
        [l1x, c1.topY, l1z],
        [r1x, c1.topY, r1z],
        [r1x, c1.baseY, r1z],
        n1[1],
        0,
        -n1[0]
      );
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normArr, 3));
  geo.setIndex(indices);
  return geo;
}
