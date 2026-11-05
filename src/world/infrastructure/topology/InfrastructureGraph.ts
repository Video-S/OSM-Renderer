import { ProcessedMapData, RawGeoJsonProperties } from '../../../types/MapFeature';
import { DEFAULT_NODE_SNAP_TOLERANCE_METERS } from '../../TopologicalNodeIndex';
import { analyzeCrossModal } from './CrossModalAnalyzer';
import { buildRailwayNetwork } from './RailwayNetworkBuilder';
import {
  buildRoadNetwork,
  cloneOsmTags,
  compareStringsCodeUnit,
  getRoadTier,
} from './RoadNetworkBuilder';
import {
  InfrastructureGraph,
  InfrastructurePointMetadata,
  RailwayNode,
  RailwayNodeRole,
  RoadNode,
  RoadNodeRole,
  RoadTier,
  TopologyDiagnostics,
  TopologySourceData,
  UnchainedRailwayPart,
  UnchainedRoadPart,
} from './types';

export * from './types';
export * from './OsmNodeIdEnricher';
export * from './RoadNetworkBuilder';
export * from './RailwayNetworkBuilder';
export * from './CrossModalAnalyzer';

const ROAD_ROLE_PRIORITY: readonly RoadNodeRole[] = [
  'junction',
  'grade_transition',
  'level_crossing',
  'highway_crossing',
  'attribute_break',
  'loop_anchor',
  'boundary_clip',
  'dead_end',
  'cross_tier',
];

const RAILWAY_ROLE_PRIORITY: readonly RailwayNodeRole[] = [
  'switch',
  'railway_crossing',
  'junction',
  'grade_transition',
  'level_crossing',
  'attribute_break',
  'loop_anchor',
  'boundary_clip',
  'dead_end',
];

function selectPrimaryRoadRole(roles: readonly RoadNodeRole[]): RoadNodeRole {
  for (const r of ROAD_ROLE_PRIORITY) {
    if (roles.includes(r)) return r;
  }
  return roles[0] ?? 'junction';
}

function selectPrimaryRailwayRole(roles: readonly RailwayNodeRole[]): RailwayNodeRole {
  for (const r of RAILWAY_ROLE_PRIORITY) {
    if (roles.includes(r)) return r;
  }
  return roles[0] ?? 'junction';
}

function stripNodePrefix(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^feat-\d+(?:-\d+)?$/i.test(trimmed)) return undefined;
  if (trimmed.startsWith('node/')) {
    const rest = trimmed.slice(5).trim();
    if (!rest || /^feat-\d+(?:-\d+)?$/i.test(rest)) return undefined;
    return rest;
  }
  if (trimmed.startsWith('osm_')) {
    const rest = trimmed.slice(4).trim();
    if (!rest || /^feat-\d+(?:-\d+)?$/i.test(rest)) return undefined;
    return rest;
  }
  return trimmed;
}

function distancePointToPolyline2D(
  pt: readonly [number, number],
  polyline: readonly [number, number][]
): number {
  if (polyline.length === 0) return Infinity;
  if (polyline.length === 1) {
    return Math.hypot(pt[0] - polyline[0][0], pt[1] - polyline[0][1]);
  }
  let minDist = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const ax = polyline[i][0];
    const az = polyline[i][1];
    const bx = polyline[i + 1][0];
    const bz = polyline[i + 1][1];
    const vx = bx - ax;
    const vz = bz - az;
    const lenSq = vx * vx + vz * vz;
    let t = 0;
    if (lenSq > 1e-12) {
      t = Math.max(0, Math.min(1, ((pt[0] - ax) * vx + (pt[1] - az) * vz) / lenSq));
    }
    const projX = ax + t * vx;
    const projZ = az + t * vz;
    const d = Math.hypot(pt[0] - projX, pt[1] - projZ);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

function extractTopologySourceFromInput(
  input: ProcessedMapData | TopologySourceData
): TopologySourceData {
  if ('roadParts' in input && 'railwayParts' in input) {
    return {
      roadParts: input.roadParts,
      railwayParts: input.railwayParts,
      infrastructurePoints: input.infrastructurePoints ?? [],
    };
  }

  const mapData = input as ProcessedMapData;
  if (mapData.topologySource) {
    return {
      roadParts: mapData.topologySource.roadParts ?? [],
      railwayParts: mapData.topologySource.railwayParts ?? [],
      infrastructurePoints: mapData.topologySource.infrastructurePoints ?? [],
    };
  }

  // Fallback adapter for synthetic ProcessedMapData literals constructed directly in tests
  const roadParts: UnchainedRoadPart[] = (mapData.roads || []).map((r, idx) => {
    const sourceId = r.sourceFeatureId || r.id || `feat-${idx + 1}`;
    const hasExplicit = !/^feat-\d+$/.test(sourceId);
    const rawNodeIds: (string | undefined)[] = r.points.map((_, pIdx) => {
      const nid = r.nodeIds && pIdx < r.nodeIds.length ? r.nodeIds[pIdx] : undefined;
      if (nid === undefined || nid === null) return undefined;
      const s = String(nid).trim();
      if (!s || s.startsWith('tn_')) return undefined;
      if (s.includes('|osm_')) return s.split('|osm_').pop();
      if (s.startsWith('osm_')) return s.slice(4);
      return s;
    });
    return {
      id: r.id || `${sourceId}-0`,
      sourceFeatureId: sourceId,
      hasExplicitSourceId: hasExplicit,
      partIndex: 0,
      points: r.points.map((pt) => [pt[0], pt[1]] as [number, number]),
      rawOsmNodeIds: rawNodeIds,
      clippedAtStart: false,
      clippedAtEnd: false,
      roadClass: r.roadClass,
      width: r.width,
      layer: r.layer ?? 0,
      isBridge: Boolean(r.isBridge),
      isTunnel: Boolean(r.isTunnel),
      isCulvert: false,
      name: r.name,
      osmTags: cloneOsmTags(r.osmTags),
    };
  });

  const railwayParts: UnchainedRailwayPart[] = (mapData.railways || []).map((rw, idx) => {
    const sourceId = rw.sourceFeatureId || rw.id || `feat-${idx + 1}`;
    const hasExplicit = !/^feat-\d+$/.test(sourceId);
    const rawNodeIds: (string | undefined)[] = rw.points.map((_, pIdx) => {
      const nid = rw.nodeIds && pIdx < rw.nodeIds.length ? rw.nodeIds[pIdx] : undefined;
      if (nid === undefined || nid === null) return undefined;
      const s = String(nid).trim();
      if (!s || s.startsWith('tn_')) return undefined;
      if (s.includes('|osm_')) return s.split('|osm_').pop();
      if (s.startsWith('osm_')) return s.slice(4);
      return s;
    });
    const tags = cloneOsmTags(rw.osmTags);
    return {
      id: rw.id || `${sourceId}-0`,
      sourceFeatureId: sourceId,
      hasExplicitSourceId: hasExplicit,
      partIndex: 0,
      points: rw.points.map((pt) => [pt[0], pt[1]] as [number, number]),
      rawOsmNodeIds: rawNodeIds,
      clippedAtStart: false,
      clippedAtEnd: false,
      railwayType: rw.railwayType,
      width: rw.width,
      layer: rw.layer ?? 0,
      isBridge: Boolean(rw.isBridge),
      isTunnel: Boolean(rw.isTunnel),
      name: rw.name,
      gauge: tags.gauge !== undefined ? String(tags.gauge) : undefined,
      electrified: tags.electrified !== undefined ? String(tags.electrified) : undefined,
      service: tags.service !== undefined ? String(tags.service) : undefined,
      usage: tags.usage !== undefined ? String(tags.usage) : undefined,
      isSecondaryBranch: false,
      osmTags: tags,
    };
  });

  return {
    roadParts,
    railwayParts,
    infrastructurePoints: [],
  };
}

const MIN_LEVEL_CROSSING_ANGLE_RAD = (10 * Math.PI) / 180;
const COS_60_DEG = 0.5;

function intersectPolylinesNearPoint2D(
  polyA: readonly [number, number][],
  polyB: readonly [number, number][],
  refPoint: readonly [number, number],
  maxDistanceMeters: number
): boolean {
  for (let i = 0; i < polyA.length - 1; i++) {
    const ax0 = polyA[i][0];
    const az0 = polyA[i][1];
    const ax1 = polyA[i + 1][0];
    const az1 = polyA[i + 1][1];
    const dax = ax1 - ax0;
    const daz = az1 - az0;
    const lenA = Math.hypot(dax, daz);
    if (lenA <= 1e-9) continue;

    for (let j = 0; j < polyB.length - 1; j++) {
      const bx0 = polyB[j][0];
      const bz0 = polyB[j][1];
      const bx1 = polyB[j + 1][0];
      const bz1 = polyB[j + 1][1];
      const dbx = bx1 - bx0;
      const dbz = bz1 - bz0;
      const lenB = Math.hypot(dbx, dbz);
      if (lenB <= 1e-9) continue;

      const denom = dax * dbz - daz * dbx;
      if (Math.abs(denom) < 1e-10) continue;

      const s = ((bx0 - ax0) * dbz - (bz0 - az0) * dbx) / denom;
      const t = ((bx0 - ax0) * daz - (bz0 - az0) * dax) / denom;
      const eps = 1e-5;
      if (s < -eps || s > 1 + eps || t < -eps || t > 1 + eps) continue;

      const cs = Math.max(0, Math.min(1, s));
      const ix = ax0 + cs * dax;
      const iz = az0 + cs * daz;
      if (Math.hypot(ix - refPoint[0], iz - refPoint[1]) > maxDistanceMeters) {
        continue;
      }

      const absDot = Math.min(
        1,
        Math.max(0, Math.abs((dax / lenA) * (dbx / lenB) + (daz / lenA) * (dbz / lenB)))
      );
      const angle = Math.acos(absDot);
      if (angle >= MIN_LEVEL_CROSSING_ANGLE_RAD) {
        return true;
      }
    }
  }
  return false;
}

function computePartInwardTangentAtVertex(
  pts: readonly [number, number][],
  vertexIndex: number,
  which: 'start' | 'end'
): [number, number] | undefined {
  if (which === 'start') {
    for (let i = vertexIndex + 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[vertexIndex][0];
      const dz = pts[i][1] - pts[vertexIndex][1];
      const len = Math.hypot(dx, dz);
      if (len > 1e-9) return [dx / len, dz / len];
    }
    return undefined;
  } else {
    for (let i = vertexIndex - 1; i >= 0; i--) {
      const dx = pts[i][0] - pts[vertexIndex][0];
      const dz = pts[i][1] - pts[vertexIndex][1];
      const len = Math.hypot(dx, dz);
      if (len > 1e-9) return [dx / len, dz / len];
    }
    return undefined;
  }
}

function isUnambiguousSinglePartContinuation<
  TPart extends { id: string; points: readonly [number, number][]; rawOsmNodeIds: readonly (string | undefined)[] },
>(parts: readonly TPart[], osmId?: string): boolean {
  if (parts.length === 0) return false;
  if (parts.length === 1) {
    if (!osmId) return true;
    const p = parts[0];
    let matchCount = 0;
    for (let i = 0; i < p.points.length; i++) {
      if (stripNodePrefix(p.rawOsmNodeIds[i]) === osmId) matchCount++;
    }
    return matchCount <= 1;
  }
  if (parts.length === 2 && osmId !== undefined) {
    const [pA, pB] = parts;
    if (pA.id === pB.id) return false;
    const idxA = pA.rawOsmNodeIds.findIndex((id) => stripNodePrefix(id) === osmId);
    const idxB = pB.rawOsmNodeIds.findIndex((id) => stripNodePrefix(id) === osmId);
    const aIsTerminal = idxA === 0 || idxA === pA.points.length - 1;
    const bIsTerminal = idxB === 0 || idxB === pB.points.length - 1;
    if (!aIsTerminal || !bIsTerminal) return false;
    const tA = computePartInwardTangentAtVertex(
      pA.points,
      idxA,
      idxA === 0 ? 'start' : 'end'
    );
    const tB = computePartInwardTangentAtVertex(
      pB.points,
      idxB,
      idxB === 0 ? 'start' : 'end'
    );
    if (!tA || !tB) return false;
    const dot = tA[0] * tB[0] + tA[1] * tB[1];
    return dot <= -COS_60_DEG;
  }
  return false;
}

/**
 * Pre-scans `TopologySourceData` to identify vertices on road and railway parts that
 * participate in confirmed level crossings (`railway=level_crossing`, `railway=crossing`,
 * or shared explicit `rawOsmNodeId` between at-grade road and rail) or confirmed portals
 * so that degree-2 path simplification preserves only genuinely confirmed crossing/portal nodes.
 */
function computeProtectedCrossingVertices(source: TopologySourceData): {
  protectedRoadOsmIds: Set<string>;
  protectedRailOsmIds: Set<string>;
  protectedRoadPartVertices: Map<string, Set<number>>;
  protectedRailPartVertices: Map<string, Set<number>>;
} {
  const protectedRoadOsmIds = new Set<string>();
  const protectedRailOsmIds = new Set<string>();
  const protectedRoadPartVertices = new Map<string, Set<number>>();
  const protectedRailPartVertices = new Map<string, Set<number>>();

  const addProtectedPartVertex = (
    map: Map<string, Set<number>>,
    partId: string,
    vertexIndex: number
  ) => {
    let set = map.get(partId);
    if (!set) {
      set = new Set<number>();
      map.set(partId, set);
    }
    set.add(vertexIndex);
  };

  const railCrossingPts = (source.infrastructurePoints ?? []).filter(
    (pt) => pt.kind === 'railway_level_crossing' || pt.kind === 'railway_ped_crossing'
  );
  const crossingPtByOsmId = new Map<string, InfrastructurePointMetadata>();
  for (const pt of railCrossingPts) {
    const osmId =
      stripNodePrefix(pt.rawOsmNodeId) ??
      (pt.hasExplicitSourceId ? stripNodePrefix(pt.id) : undefined);
    if (osmId && !crossingPtByOsmId.has(osmId)) {
      crossingPtByOsmId.set(osmId, pt);
    }
  }

  // 1. Shared explicit OSM node IDs between at-grade road parts and at-grade railway parts
  const atGradeRoadByOsmId = new Map<
    string,
    Array<{ part: UnchainedRoadPart; vertexIndex: number; point: [number, number]; tier: RoadTier }>
  >();

  for (const rp of source.roadParts) {
    if (rp.isBridge || rp.isTunnel) continue;
    const tier = getRoadTier(rp.roadClass);
    for (let i = 0; i < rp.points.length; i++) {
      const osmId = stripNodePrefix(rp.rawOsmNodeIds[i]);
      if (!osmId) continue;
      let list = atGradeRoadByOsmId.get(osmId);
      if (!list) {
        list = [];
        atGradeRoadByOsmId.set(osmId, list);
      }
      list.push({ part: rp, vertexIndex: i, point: rp.points[i], tier });
    }
  }

  const atGradeRailByOsmId = new Map<
    string,
    Array<{ part: UnchainedRailwayPart; vertexIndex: number; point: [number, number] }>
  >();

  for (const rlp of source.railwayParts) {
    if (rlp.isBridge || rlp.isTunnel) continue;
    for (let i = 0; i < rlp.points.length; i++) {
      const osmId = stripNodePrefix(rlp.rawOsmNodeIds[i]);
      if (!osmId) continue;
      let list = atGradeRailByOsmId.get(osmId);
      if (!list) {
        list = [];
        atGradeRailByOsmId.set(osmId, list);
      }
      list.push({ part: rlp, vertexIndex: i, point: rlp.points[i] });
    }
  }

  for (const [osmId, roadRefs] of atGradeRoadByOsmId.entries()) {
    const railRefs = atGradeRailByOsmId.get(osmId);
    if (!railRefs || railRefs.length === 0) continue;

    // Require compatible layer and proximity <= 0.15 m
    const compatibleRoadRefs = roadRefs.filter((r) =>
      railRefs.some(
        (rl) =>
          rl.part.layer === r.part.layer &&
          Math.hypot(rl.point[0] - r.point[0], rl.point[1] - r.point[1]) <=
            DEFAULT_NODE_SNAP_TOLERANCE_METERS
      )
    );
    if (compatibleRoadRefs.length === 0) continue;

    const targetLayer = compatibleRoadRefs[0].part.layer;
    const layerRoadParts = [...new Map(compatibleRoadRefs.map((r) => [r.part.id, r.part])).values()];
    const layerRailParts = [
      ...new Map(
        railRefs.filter((rl) => rl.part.layer === targetLayer).map((rl) => [rl.part.id, rl.part])
      ).values(),
    ];

    if (
      !isUnambiguousSinglePartContinuation(layerRoadParts, osmId) ||
      !isUnambiguousSinglePartContinuation(layerRailParts, osmId)
    ) {
      continue;
    }

    const pos = compatibleRoadRefs[0].point;
    const hasValidCrossingGeometry = layerRoadParts.some((rp) =>
      layerRailParts.some((rlp) =>
        intersectPolylinesNearPoint2D(
          rp.points,
          rlp.points,
          pos,
          DEFAULT_NODE_SNAP_TOLERANCE_METERS
        )
      )
    );
    if (!hasValidCrossingGeometry) continue;

    // Check if an explicit crossing point conflicts with the road tier
    let matchedPt = crossingPtByOsmId.get(osmId);
    if (!matchedPt) {
      const nearby = railCrossingPts.filter((pt) => {
        const ptOsm =
          stripNodePrefix(pt.rawOsmNodeId) ??
          (pt.hasExplicitSourceId ? stripNodePrefix(pt.id) : undefined);
        return (
          ptOsm === osmId &&
          Math.hypot(pt.point[0] - pos[0], pt.point[1] - pos[1]) <=
            DEFAULT_NODE_SNAP_TOLERANCE_METERS
        );
      });
      if (nearby.length === 1) {
        matchedPt = nearby[0];
      }
    }

    if (matchedPt) {
      const primaryTier = compatibleRoadRefs[0].tier;
      const conflict =
        (matchedPt.kind === 'railway_level_crossing' && primaryTier !== 'vehicular') ||
        (matchedPt.kind === 'railway_ped_crossing' && primaryTier !== 'path');
      if (conflict) {
        continue;
      }
    }

    protectedRoadOsmIds.add(osmId);
    protectedRailOsmIds.add(osmId);
  }

  // 2. Point-tagged `railway_level_crossing` and `railway_ped_crossing` matching at least one way's verified `rawOsmNodeId`
  for (const pt of railCrossingPts) {
    const ptOsmId =
      stripNodePrefix(pt.rawOsmNodeId) ??
      (pt.hasExplicitSourceId ? stripNodePrefix(pt.id) : undefined);
    // ADR-0009 Section 6.2: Point-based confirmation requires a verified OSM node ID on the point
    if (ptOsmId === undefined) continue;

    const nearbyRoadParts = source.roadParts.filter(
      (rp) =>
        !rp.isBridge &&
        !rp.isTunnel &&
        distancePointToPolyline2D(pt.point, rp.points) <= DEFAULT_NODE_SNAP_TOLERANCE_METERS
    );
    const nearbyRailParts = source.railwayParts.filter(
      (rlp) =>
        !rlp.isBridge &&
        !rlp.isTunnel &&
        distancePointToPolyline2D(pt.point, rlp.points) <= DEFAULT_NODE_SNAP_TOLERANCE_METERS
    );

    if (nearbyRoadParts.length === 0 || nearbyRailParts.length === 0) continue;

    const sameLayerRoads = nearbyRoadParts.filter((rp) =>
      nearbyRailParts.some((rlp) => rlp.layer === rp.layer)
    );
    if (sameLayerRoads.length === 0) continue;

    const distinctLayers = new Set(sameLayerRoads.map((rp) => rp.layer));
    if (distinctLayers.size !== 1) continue;

    const targetLayer = sameLayerRoads[0].layer;
    const layerRails = nearbyRailParts.filter((rlp) => rlp.layer === targetLayer);

    // Check for conflicting explicit OSM node IDs on nearby vertices and verify at least one way matches ptOsmId
    let hasIdConflict = false;
    const matchedRoadVertices: Array<{ partId: string; vertexIndex: number }> = [];
    const matchedRailVertices: Array<{ partId: string; vertexIndex: number }> = [];

    for (const rp of sameLayerRoads) {
      for (let i = 0; i < rp.points.length; i++) {
        if (
          Math.hypot(rp.points[i][0] - pt.point[0], rp.points[i][1] - pt.point[1]) <=
          DEFAULT_NODE_SNAP_TOLERANCE_METERS
        ) {
          const vOsm = stripNodePrefix(rp.rawOsmNodeIds[i]);
          if (vOsm !== undefined && vOsm !== ptOsmId) {
            hasIdConflict = true;
          } else if (vOsm === ptOsmId) {
            matchedRoadVertices.push({ partId: rp.id, vertexIndex: i });
          }
        }
      }
    }

    for (const rlp of layerRails) {
      for (let i = 0; i < rlp.points.length; i++) {
        if (
          Math.hypot(rlp.points[i][0] - pt.point[0], rlp.points[i][1] - pt.point[1]) <=
          DEFAULT_NODE_SNAP_TOLERANCE_METERS
        ) {
          const vOsm = stripNodePrefix(rlp.rawOsmNodeIds[i]);
          if (vOsm !== undefined && vOsm !== ptOsmId) {
            hasIdConflict = true;
          } else if (vOsm === ptOsmId) {
            matchedRailVertices.push({ partId: rlp.id, vertexIndex: i });
          }
        }
      }
    }

    if (hasIdConflict) continue;
    if (matchedRoadVertices.length === 0 && matchedRailVertices.length === 0) {
      // Point OSM node ID matches neither way's verified nodes -> do not protect
      continue;
    }

    // Check non-ambiguity in both domains
    if (
      !isUnambiguousSinglePartContinuation(
        sameLayerRoads,
        matchedRoadVertices.length > 0 ? ptOsmId : undefined
      ) ||
      !isUnambiguousSinglePartContinuation(
        layerRails,
        matchedRailVertices.length > 0 ? ptOsmId : undefined
      )
    ) {
      continue;
    }

    // Check tier compatibility
    const tier = getRoadTier(sameLayerRoads[0].roadClass);
    const tierConflict =
      (pt.kind === 'railway_level_crossing' && tier !== 'vehicular') ||
      (pt.kind === 'railway_ped_crossing' && tier !== 'path');
    if (tierConflict) continue;

    // Check genuine non-parallel 2D crossing geometry within 0.15 m of pt.point
    const hasValidCrossingGeometry = sameLayerRoads.some((rp) =>
      layerRails.some((rlp) =>
        intersectPolylinesNearPoint2D(
          rp.points,
          rlp.points,
          pt.point,
          DEFAULT_NODE_SNAP_TOLERANCE_METERS
        )
      )
    );
    if (!hasValidCrossingGeometry) continue;

    if (matchedRoadVertices.length > 0) {
      protectedRoadOsmIds.add(ptOsmId);
      for (const rv of matchedRoadVertices) {
        addProtectedPartVertex(protectedRoadPartVertices, rv.partId, rv.vertexIndex);
      }
    }
    if (matchedRailVertices.length > 0) {
      protectedRailOsmIds.add(ptOsmId);
      for (const rlv of matchedRailVertices) {
        addProtectedPartVertex(protectedRailPartVertices, rlv.partId, rlv.vertexIndex);
      }
    }
  }

  // 3. Protect explicit OSM node IDs shared between at-grade parts and grade-separated (bridge/tunnel) parts
  // in the same domain so degree-2 at-grade portal junctions are never contracted across a portal node.
  const gradeSeparatedRoadOsmIds = new Set<string>();
  for (const rp of source.roadParts) {
    if (!rp.isBridge && !rp.isTunnel) continue;
    for (let i = 0; i < rp.points.length; i++) {
      const osmId = stripNodePrefix(rp.rawOsmNodeIds[i]);
      if (osmId) gradeSeparatedRoadOsmIds.add(osmId);
    }
  }
  for (const osmId of gradeSeparatedRoadOsmIds) {
    if (atGradeRoadByOsmId.has(osmId)) {
      protectedRoadOsmIds.add(osmId);
    }
  }

  const gradeSeparatedRailOsmIds = new Set<string>();
  for (const rlp of source.railwayParts) {
    if (!rlp.isBridge && !rlp.isTunnel) continue;
    for (let i = 0; i < rlp.points.length; i++) {
      const osmId = stripNodePrefix(rlp.rawOsmNodeIds[i]);
      if (osmId) gradeSeparatedRailOsmIds.add(osmId);
    }
  }
  for (const osmId of gradeSeparatedRailOsmIds) {
    if (atGradeRailByOsmId.has(osmId)) {
      protectedRailOsmIds.add(osmId);
    }
  }

  return {
    protectedRoadOsmIds,
    protectedRailOsmIds,
    protectedRoadPartVertices,
    protectedRailPartVertices,
  };
}

/**
 * Pure, deterministic top-level Infrastructure Graph builder (`ADR-0009` Stages B–D).
 * Constructs `RoadNetwork`, `RailwayNetwork`, `GradeTransitionRelation[]`,
 * `RailwayFlatCrossingRelation[]`, `LevelCrossingRelation[]`,
 * `GradeSeparatedCrossingRelation[]`, and `TopologyDiagnostics` with zero renderer
 * or Three.js dependencies and without mutating caller inputs.
 */
export function buildInfrastructureGraph(
  input: ProcessedMapData | TopologySourceData
): InfrastructureGraph {
  const topologySource = extractTopologySourceFromInput(input);
  const {
    protectedRoadOsmIds,
    protectedRailOsmIds,
    protectedRoadPartVertices,
    protectedRailPartVertices,
  } = computeProtectedCrossingVertices(topologySource);

  const roadBuildResult = buildRoadNetwork(topologySource, {
    infrastructurePoints: topologySource.infrastructurePoints,
    protectedRawOsmNodeIds: protectedRoadOsmIds,
    protectedPartVertices: protectedRoadPartVertices,
  });

  const railwayBuildResult = buildRailwayNetwork(topologySource, {
    infrastructurePoints: topologySource.infrastructurePoints,
    protectedRawOsmNodeIds: protectedRailOsmIds,
    protectedPartVertices: protectedRailPartVertices,
  });

  const crossModal = analyzeCrossModal({
    roads: roadBuildResult.roads,
    railways: railwayBuildResult.railways,
    infrastructurePoints: topologySource.infrastructurePoints,
    railwayFlatCrossings: railwayBuildResult.railwayFlatCrossings,
    railwayUnresolvedCrossings: railwayBuildResult.diagnostics.unresolvedCrossings,
    roadUnresolvedInfrastructurePoints:
      roadBuildResult.diagnostics.unresolvedInfrastructurePoints,
    railwayUnresolvedInfrastructurePoints:
      railwayBuildResult.diagnostics.unresolvedInfrastructurePoints,
  });

  // Update retained RoadNode and RailwayNode roles (`level_crossing`, `grade_transition`) and `pointOsmTags`
  const updatedRoadNodes = new Map<string, RoadNode>(roadBuildResult.roads.nodes);
  const updatedRailwayNodes = new Map<string, RailwayNode>(railwayBuildResult.railways.nodes);

  const addRoadNodeRole = (
    nodeId: string | undefined,
    role: RoadNodeRole,
    pointTags?: RawGeoJsonProperties
  ) => {
    if (!nodeId) return;
    const existing = updatedRoadNodes.get(nodeId);
    if (!existing) return;
    const roleSet = new Set<RoadNodeRole>(existing.roles);
    roleSet.add(role);
    const roles = [...roleSet].sort(compareStringsCodeUnit);
    const primaryRole = selectPrimaryRoadRole(roles);
    updatedRoadNodes.set(nodeId, {
      ...existing,
      roles,
      primaryRole,
      pointOsmTags:
        existing.pointOsmTags ?? (pointTags ? cloneOsmTags(pointTags) : undefined),
    });
  };

  const addRailwayNodeRole = (
    nodeId: string | undefined,
    role: RailwayNodeRole,
    pointTags?: RawGeoJsonProperties
  ) => {
    if (!nodeId) return;
    const existing = updatedRailwayNodes.get(nodeId);
    if (!existing) return;
    const roleSet = new Set<RailwayNodeRole>(existing.roles);
    roleSet.add(role);
    const roles = [...roleSet].sort(compareStringsCodeUnit);
    const primaryRole = selectPrimaryRailwayRole(roles);
    updatedRailwayNodes.set(nodeId, {
      ...existing,
      roles,
      primaryRole,
      pointOsmTags:
        existing.pointOsmTags ?? (pointTags ? cloneOsmTags(pointTags) : undefined),
    });
  };

  for (const lc of crossModal.levelCrossings) {
    addRoadNodeRole(lc.roadNodeId, 'level_crossing', lc.pointOsmTags);
    addRailwayNodeRole(lc.railwayNodeId, 'level_crossing', lc.pointOsmTags);
  }

  for (const gt of crossModal.gradeTransitions) {
    if (gt.network === 'road') {
      addRoadNodeRole(gt.atGradeNodeId, 'grade_transition');
      addRoadNodeRole(gt.gradeSeparatedNodeId, 'grade_transition');
    } else if (gt.network === 'railway') {
      addRailwayNodeRole(gt.atGradeNodeId, 'grade_transition');
      addRailwayNodeRole(gt.gradeSeparatedNodeId, 'grade_transition');
    }
  }

  const pedestrianRailCrossingCount = crossModal.levelCrossings.filter(
    (lc) => lc.crossingKind === 'pedestrian_rail_crossing'
  ).length;

  const diagnostics: TopologyDiagnostics = {
    roadNodeCount: updatedRoadNodes.size,
    roadEdgeCount: roadBuildResult.roads.edges.size,
    roadSimplifiedDegree2Count: roadBuildResult.diagnostics.roadSimplifiedDegree2Count,
    roadInteriorSplitCount: roadBuildResult.diagnostics.roadInteriorSplitCount,
    roadParallelEdgePairCount: roadBuildResult.diagnostics.roadParallelEdgePairCount,
    railwayNodeCount: updatedRailwayNodes.size,
    railwayEdgeCount: railwayBuildResult.railways.edges.size,
    railwayConfirmedSwitchCount: railwayBuildResult.diagnostics.railwayConfirmedSwitchCount,
    railwayUnresolvedSwitchCount: railwayBuildResult.diagnostics.railwayUnresolvedSwitchCount,
    railwayFlatCrossingCount: railwayBuildResult.railwayFlatCrossings.length,
    railwayUnresolvedJunctionCount:
      railwayBuildResult.diagnostics.railwayUnresolvedJunctionCount,
    railwaySimplifiedDegree2Count:
      railwayBuildResult.diagnostics.railwaySimplifiedDegree2Count,
    gradeTransitionCount: crossModal.gradeTransitions.length,
    unresolvedGradeTransitionCount: crossModal.unresolvedGradeTransitions.length,
    levelCrossingCount: crossModal.levelCrossings.length,
    pedestrianRailCrossingCount,
    unresolvedCrossingCount: crossModal.unresolvedCrossings.length,
    gradeSeparatedCrossingCount: crossModal.gradeSeparatedCrossings.length,
    boundaryClippedNodeCount:
      roadBuildResult.diagnostics.boundaryClippedNodeCount +
      railwayBuildResult.diagnostics.boundaryClippedNodeCount,
    unresolvedGradeTransitions: crossModal.unresolvedGradeTransitions,
    unresolvedCrossings: crossModal.unresolvedCrossings,
    unresolvedInfrastructurePoints: crossModal.unresolvedInfrastructurePoints,
  };

  return {
    roads: {
      nodes: updatedRoadNodes,
      edges: roadBuildResult.roads.edges,
      featureToEdgeIds: roadBuildResult.roads.featureToEdgeIds,
    },
    railways: {
      nodes: updatedRailwayNodes,
      edges: railwayBuildResult.railways.edges,
      featureToEdgeIds: railwayBuildResult.railways.featureToEdgeIds,
    },
    gradeTransitions: crossModal.gradeTransitions,
    railwayFlatCrossings: railwayBuildResult.railwayFlatCrossings,
    levelCrossings: crossModal.levelCrossings,
    gradeSeparatedCrossings: crossModal.gradeSeparatedCrossings,
    diagnostics,
  };
}
