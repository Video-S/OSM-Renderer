import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import polygonClipping from 'polygon-clipping';
import {
  InspectableFeatureInfo,
  ProcessedMapData,
  RawGeoJsonProperties,
  RoadClass,
  RoadPortalConnectionSpec,
} from '../../../types/MapFeature';
import {
  ELEVATION_POLICY,
  getRoadElevation,
  isNonVehicularRoadClass,
} from '../../ElevationPolicy';
import {
  computePolylineLength,
  trimPolylineByArcLength,
} from '../../BridgeAndTunnelBuilder';
import {
  COORDINATE_SNAP_QUANTUM,
  MultiPolygonCoords,
  filterDegenerateBooleanArtifacts,
} from '../../PlanarLayerValidator';
import { SceneResourceManager } from '../../SceneResourceManager';
import {
  buildRoadRibbonOutlineRing,
  buildSafeExteriorSubPolylines,
  cleanPolylineForClipping,
  createShapesFromMultiPolygon,
  generateRoadRibbon,
  generateStepTreads,
  hasRingSelfIntersection,
  sanitizeOsmTags,
  type RoadRibbonOptions,
} from '../../GeometryBuilder';
import {
  compareStringsCodeUnit,
  EdgeSegmentProvenance,
  IncidentHalfEdge,
} from '../topology/InfrastructureGraph';
import {
  InfrastructureRenderDescriptorBundle,
  RoadEdgeRenderDescriptor,
  RoadNodeRenderDescriptor,
} from '../rendering/InfrastructureRenderAdapter';

/**
 * Priority ranking of `RoadClass` values for selecting the dominant road class and surface metadata
 * at multi-way road junctions (`ADR-0002`, `ADR-0009`).
 */
const ROAD_CLASS_PRIORITY: Record<RoadClass, number> = {
  runway: 16,
  taxiway: 15,
  motorway: 14,
  trunk: 13,
  primary: 12,
  secondary: 11,
  tertiary: 10,
  raceway: 9,
  bus_guideway: 9,
  residential: 8,
  living_street: 7,
  unclassified: 6,
  service: 5,
  construction: 5,
  platform: 4,
  pier: 4,
  pedestrian: 4,
  cycleway: 3,
  bridleway: 2,
  track: 2,
  footway: 2,
  steps: 1,
  path: 1,
  bridge: 0,
};

/**
 * Diagnostic and benchmark counters emitted by the Stage E2 graph-driven road geometry builder.
 */
export interface GraphRoadRenderStats {
  /** Total road node descriptors in the input adapter bundle. */
  inputRoadNodeCount: number;
  /** Total road edge descriptors in the input adapter bundle. */
  inputRoadEdgeCount: number;
  /** Number of road edge descriptors eligible for at-grade ribbon construction (`isAtGradeBuildable`). */
  atGradeRoadEdgeCount: number;
  /** Total rendered at-grade road/path ribbon geometry items emitted (including provenance sub-segments). */
  renderedRoadRibbonCount: number;
  /** Total rendered junction polygon geometry items emitted (vehicular + path junctions). */
  renderedJunctionCount: number;
  /** Number of vehicular branching junctions (`requiresVehicularJunctionTrimming === true`) meshed. */
  branchingJunctionCount: number;
  /** Number of degree-2 continuity joins (`requiresVehicularContinuityMiter === true` or path degree-2) resolved. */
  degree2ContinuityJoinCount: number;
  /** Number of pure path-tier branching junctions (`requiresPathJunctionTrimming === true`, `>= 3` arms) meshed. */
  pathJunctionCount: number;
  /** Number of cross-tier-only interaction nodes (`isCrossTierOnlyInteraction === true`) encountered. */
  crossTierOnlyNodeCount: number;
  /** Number of degenerate or micro road edges/sub-segments rejected (`< 2` points or `< 0.05 m` length). */
  rejectedOrDegenerateCount: number;
  /** Number of road/path edges or sub-segments completely removed by 2D Boolean carriageway subtraction. */
  fullySubtractedCount: number;
  /** Number of additional sub-segments produced by splitting simplified edges at provenance boundaries. */
  provenanceSplitSegmentCount: number;
}

/**
 * Input configuration for `buildGraphAtGradeRoadGeometries`.
 */
export interface GraphRoadGeometryBuildOptions {
  /** Immutable graph-backed render descriptor bundle produced by `InfrastructureRenderAdapter`. */
  descriptors: InfrastructureRenderDescriptorBundle;
  /** User/scene multiplier applied to canonical road widths. */
  roadWidthMultiplier: number;
  /** Optional world coordinates `[x, z]` of legacy Stage 6D bridge/tunnel endpoints for cap suppression. */
  gradeTransitionCoords?: ReadonlyArray<readonly [number, number]>;
  /** Scene resource manager for deterministic GPU buffer registration and disposal. */
  resourceManager: SceneResourceManager;
  /** Optional pipeline diagnostics object to record clipping failures or fully subtracted features. */
  diagnostics?: ProcessedMapData['diagnostics'];
}

/**
 * Output of `buildGraphAtGradeRoadGeometries` consumed by `GeometryBuilder.buildScene()` when `roads === 'graph'`.
 */
export interface GraphRoadGeometryBuildResult {
  /** Per-class arrays of registered `BufferGeometry` + `InspectableFeatureInfo` items (ribbons, treads, junctions). */
  roadsByClass: Map<RoadClass, Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }>>;
  /** At-grade road polyline points for Stage 6D bridge ramp connection detection. */
  atGradeRoadEndpoints: [number, number][];
  /** Set of source feature IDs whose geometry was actually emitted. */
  renderedSourceIds: Set<string>;
  /** Set of edge/source feature IDs completely subtracted by 2D Boolean clipping. */
  fullySubtractedRoadIds: Set<string>;
  /** Detailed Stage E2 graph-road rendering statistics. */
  stats: GraphRoadRenderStats;
}

interface PortalSpec {
  left: [number, number];
  right: [number, number];
  center?: [number, number];
}

interface EdgeTrimState {
  start?: [number, number];
  end?: [number, number];
  startPortal?: PortalSpec;
  endPortal?: PortalSpec;
  startTrimDist: number;
  endTrimDist: number;
  hasCapStart: boolean;
  hasCapEnd: boolean;
  exemptFootprintIds: Set<string>;
}

interface GraphBranchSpec {
  edge: RoadEdgeRenderDescriptor;
  endpoint: 'start' | 'end';
  dir: [number, number];
  nodePos: [number, number];
  width: number;
  roadClass: RoadClass;
  segmentLength: number;
}

interface PendingJunctionPolygon {
  nodeId: string;
  junctionFeatureId: string;
  isPathJunction: boolean;
  polygonPoints: [number, number][];
  sortedBranches: GraphBranchSpec[];
  portals: Array<{ left: [number, number]; right: [number, number]; center: [number, number] }>;
  dominantBranch: GraphBranchSpec;
}

interface ResolvedEdgeSubSegment {
  subId: string;
  edge: RoadEdgeRenderDescriptor;
  seg: EdgeSegmentProvenance;
  points: [number, number][];
  width: number;
  roadElevation: number;
  isPath: boolean;
  hasCapStart: boolean;
  hasCapEnd: boolean;
  startPortal?: { left: [number, number]; right: [number, number] };
  endPortal?: { left: [number, number]; right: [number, number] };
  sourceFeatureId: string;
  sourceFeatureIds: string[];
  osmTags: Record<string, string | number | boolean>;
  exemptFootprintIds: Set<string>;
}

interface PlacedRoadFootprint {
  id: string;
  isPath: boolean;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  poly: [number, number][][];
}

function snapCoord(v: number): number {
  return Math.round(v / COORDINATE_SNAP_QUANTUM) * COORDINATE_SNAP_QUANTUM;
}

/**
 * Computes the inward unit tangent `[dx, dz]` pointing away from `endpoint` into the polyline of `edge`.
 */
function computeEdgeInwardTangent(
  edge: RoadEdgeRenderDescriptor,
  endpoint: 'start' | 'end',
  fallbackTangent?: readonly [number, number]
): [number, number] {
  const pts = edge.points;
  if (pts.length >= 2) {
    if (endpoint === 'start') {
      const p0 = pts[0];
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i][0] - p0[0];
        const dz = pts[i][1] - p0[1];
        const len = Math.hypot(dx, dz);
        if (len > 1e-4) {
          return [dx / len, dz / len];
        }
      }
    } else {
      const pn = pts[pts.length - 1];
      for (let i = pts.length - 2; i >= 0; i--) {
        const dx = pts[i][0] - pn[0];
        const dz = pts[i][1] - pn[1];
        const len = Math.hypot(dx, dz);
        if (len > 1e-4) {
          return [dx / len, dz / len];
        }
      }
    }
  }
  if (fallbackTangent) {
    const len = Math.hypot(fallbackTangent[0], fallbackTangent[1]);
    if (len > 1e-6) {
      return [fallbackTangent[0] / len, fallbackTangent[1] / len];
    }
  }
  const raw = endpoint === 'start' ? edge.startInwardTangent : edge.endInwardTangent;
  const len = Math.hypot(raw[0], raw[1]) || 1;
  return [raw[0] / len, raw[1] / len];
}

/**
 * Formats a human-readable cartographic label for a `RoadClass`.
 */
function formatRoadCartoLabel(roadClass: RoadClass): string {
  const formatted = roadClass.replace(/_/g, ' ');
  return `${formatted.charAt(0).toUpperCase()}${formatted.slice(1)} Road`;
}

/**
 * Resolves the constituent `EdgeSegmentProvenance` touching a specific endpoint (`'start'` or `'end'`)
 * of a `RoadEdgeRenderDescriptor`.
 */
function getEndpointProvenanceSegment(
  edge: RoadEdgeRenderDescriptor,
  endpoint: 'start' | 'end'
): EdgeSegmentProvenance | undefined {
  const segs = edge.provenance.segments;
  if (segs.length === 0) return undefined;
  return endpoint === 'start' ? segs[0] : segs[segs.length - 1];
}

/**
 * Applies a degree-2 continuity miter portal between two incident half-edges `b0` and `b1`
 * at `nodeCenter` when their deflection angle and widths permit a direct shared portal join.
 * Returns `true` if a direct shared portal was applied, or `false` if the bend is an extreme
 * hairpin that requires boundary-derived apex trimming.
 */
function applyDegree2SharedContinuityPortal(
  b0: GraphBranchSpec,
  b1: GraphBranchSpec,
  nodeCenter: [number, number],
  trimmedEndpoints: Map<string, EdgeTrimState>
): boolean {
  const dot = b0.dir[0] * b1.dir[0] + b0.dir[1] * b1.dir[1];
  // If interior angle between the two arms is acute (< ~75°, i.e. dot >= 0.25),
  // fall back to boundary-derived 2-branch corner trimming so the acute inner crotch never overlaps.
  if (dot >= 0.25) {
    return false;
  }

  // Forward tangent flowing from b0 into nodeCenter (-b0.dir) and out along b1 (+b1.dir)
  let tx = -b0.dir[0] + b1.dir[0];
  let tz = -b0.dir[1] + b1.dir[1];
  const tLen = Math.hypot(tx, tz);
  if (tLen < 1e-4) {
    return false;
  }
  tx /= tLen;
  tz /= tLen;
  const nx = -tz;
  const nz = tx;

  const cosHalf = Math.sqrt(Math.max(0.1, (1 - dot) * 0.5));
  const miterScale = Math.min(1.30, 1.0 / Math.max(0.72, cosHalf));
  const avgHalfW = (b0.width + b1.width) * 0.25 * miterScale;
  const maxSafeHalfW = Math.min(b0.segmentLength, b1.segmentLength) * 0.85;
  const halfW = Math.min(avgHalfW, Math.max(avgHalfW * 0.5, maxSafeHalfW));

  const sharedLeftOutB1: [number, number] = [
    nodeCenter[0] + nx * halfW,
    nodeCenter[1] + nz * halfW,
  ];
  const sharedRightOutB1: [number, number] = [
    nodeCenter[0] - nx * halfW,
    nodeCenter[1] - nz * halfW,
  ];

  const t0 = trimmedEndpoints.get(b0.edge.id);
  const t1 = trimmedEndpoints.get(b1.edge.id);
  if (!t0 || !t1) return false;

  if (b0.endpoint === 'start') {
    t0.start = [nodeCenter[0], nodeCenter[1]];
    t0.startPortal = {
      left: sharedRightOutB1,
      right: sharedLeftOutB1,
      center: [nodeCenter[0], nodeCenter[1]],
    };
    t0.hasCapStart = false;
  } else {
    t0.end = [nodeCenter[0], nodeCenter[1]];
    t0.endPortal = {
      left: sharedLeftOutB1,
      right: sharedRightOutB1,
      center: [nodeCenter[0], nodeCenter[1]],
    };
    t0.hasCapEnd = false;
  }

  if (b1.endpoint === 'start') {
    t1.start = [nodeCenter[0], nodeCenter[1]];
    t1.startPortal = {
      left: sharedLeftOutB1,
      right: sharedRightOutB1,
      center: [nodeCenter[0], nodeCenter[1]],
    };
    t1.hasCapStart = false;
  } else {
    t1.end = [nodeCenter[0], nodeCenter[1]];
    t1.endPortal = {
      left: sharedRightOutB1,
      right: sharedLeftOutB1,
      center: [nodeCenter[0], nodeCenter[1]],
    };
    t1.hasCapEnd = false;
  }

  t0.exemptFootprintIds.add(b1.edge.id);
  t1.exemptFootprintIds.add(b0.edge.id);
  return true;
}

/**
 * Computes boundary-derived branch portals and a CCW junction polygon ring around `nodeCenter`
 * for a set of `>= 2` incident branches (`ADR-0002`, `ADR-0009`).
 */
function solveBoundaryDerivedJunctionNode(
  nodeId: string,
  nodeCenter: [number, number],
  branches: GraphBranchSpec[],
  isPathJunction: boolean,
  trimmedEndpoints: Map<string, EdgeTrimState>
): PendingJunctionPolygon | null {
  if (branches.length < 2) return null;

  const sortedBranches = [...branches].sort((a, b) => {
    const angleA = Math.atan2(a.dir[1], a.dir[0]);
    const angleB = Math.atan2(b.dir[1], b.dir[0]);
    if (Math.abs(angleA - angleB) > 1e-7) {
      return angleA - angleB;
    }
    const idCmp = compareStringsCodeUnit(a.edge.id, b.edge.id);
    if (idCmp !== 0) return idCmp;
    return compareStringsCodeUnit(a.endpoint, b.endpoint);
  });

  const k = sortedBranches.length;
  const branchNormals: [number, number][] = sortedBranches.map((bBranch) => [
    -bBranch.dir[1],
    bBranch.dir[0],
  ]);
  const maxTrimDists: number[] = sortedBranches.map((bBranch) => {
    const isSelfLoop = bBranch.edge.fromNodeId === bBranch.edge.toNodeId;
    const ratio = isSelfLoop ? 0.35 : 0.45;
    return Math.max(0.15, bBranch.segmentLength * ratio);
  });

  const corners: [number, number][] = [];
  const innerCornerTA: number[] = new Array(k).fill(0);
  const innerCornerTB: number[] = new Array(k).fill(0);
  const isConvexInnerCorner: boolean[] = new Array(k).fill(false);

  for (let i = 0; i < k; i++) {
    const next = (i + 1) % k;
    const bA = sortedBranches[i];
    const bB = sortedBranches[next];
    const nA = branchNormals[i];
    const nB = branchNormals[next];

    const pA: [number, number] = [
      nodeCenter[0] + nA[0] * (bA.width / 2),
      nodeCenter[1] + nA[1] * (bA.width / 2),
    ];
    const dA = bA.dir;

    const pB: [number, number] = [
      nodeCenter[0] - nB[0] * (bB.width / 2),
      nodeCenter[1] - nB[1] * (bB.width / 2),
    ];
    const dB = bB.dir;

    const det = dA[0] * dB[1] - dA[1] * dB[0];
    let cornerX: number;
    let cornerZ: number;

    if (Math.abs(det) > 1e-4) {
      const dx = pB[0] - pA[0];
      const dz = pB[1] - pA[1];
      const tA = (dx * dB[1] - dz * dB[0]) / det;
      const tB = (dx * dA[1] - dz * dA[0]) / det;

      if (det > 0 && tA > 0 && tB > 0) {
        isConvexInnerCorner[i] = true;
        innerCornerTA[i] = tA;
        innerCornerTB[i] = tB;
        const clampedTA = Math.min(tA, maxTrimDists[i]);
        const clampedTB = Math.min(tB, maxTrimDists[next]);
        if (clampedTA === tA && clampedTB === tB) {
          cornerX = pA[0] + tA * dA[0];
          cornerZ = pA[1] + tA * dA[1];
        } else {
          const cAx = pA[0] + clampedTA * dA[0];
          const cAz = pA[1] + clampedTA * dA[1];
          const cBx = pB[0] + clampedTB * dB[0];
          const cBz = pB[1] + clampedTB * dB[1];
          cornerX = (cAx + cBx) * 0.5;
          cornerZ = (cAz + cBz) * 0.5;
        }
      } else {
        cornerX = pA[0] + tA * dA[0];
        cornerZ = pA[1] + tA * dA[1];
        const cDist = Math.hypot(cornerX - nodeCenter[0], cornerZ - nodeCenter[1]);
        const maxOuterDist = 1.35 * Math.max(bA.width, bB.width);
        if (cDist > maxOuterDist && cDist > 1e-4) {
          const scale = maxOuterDist / cDist;
          cornerX = nodeCenter[0] + (cornerX - nodeCenter[0]) * scale;
          cornerZ = nodeCenter[1] + (cornerZ - nodeCenter[1]) * scale;
        }
      }
    } else {
      cornerX = (pA[0] + pB[0]) * 0.5;
      cornerZ = (pA[1] + pB[1]) * 0.5;
    }

    corners.push([cornerX, cornerZ]);
  }

  const portals: Array<{
    left: [number, number];
    right: [number, number];
    center: [number, number];
  }> = [];
  const trimDists: number[] = [];
  const junctionFeatureId = isPathJunction ? `path-junction-${nodeId}` : `junction-${nodeId}`;

  for (let i = 0; i < k; i++) {
    const bBranch = sortedBranches[i];
    const prevCorner = corners[(i - 1 + k) % k];
    const nextCorner = corners[i];
    const n = branchNormals[i];

    const projPrev =
      (prevCorner[0] - nodeCenter[0]) * bBranch.dir[0] +
      (prevCorner[1] - nodeCenter[1]) * bBranch.dir[1];
    const projNext =
      (nextCorner[0] - nodeCenter[0]) * bBranch.dir[0] +
      (nextCorner[1] - nodeCenter[1]) * bBranch.dir[1];

    let trimDist = Math.max(0.1, projPrev, projNext) + 0.02;
    trimDist = Math.min(trimDist, maxTrimDists[i]);
    trimDists.push(trimDist);

    const centerPortal: [number, number] = [
      nodeCenter[0] + bBranch.dir[0] * trimDist,
      nodeCenter[1] + bBranch.dir[1] * trimDist,
    ];
    const leftPortal: [number, number] = [
      centerPortal[0] + n[0] * (bBranch.width / 2),
      centerPortal[1] + n[1] * (bBranch.width / 2),
    ];
    const rightPortal: [number, number] = [
      centerPortal[0] - n[0] * (bBranch.width / 2),
      centerPortal[1] - n[1] * (bBranch.width / 2),
    ];

    portals.push({ left: leftPortal, right: rightPortal, center: centerPortal });
  }

  // Ensure acute/inner convex corners where the inner curb intersection dictates the branch trim
  // (or was clamped at maxTrimDists) share `corners[i]` directly so adjacent portals never cross over
  for (let i = 0; i < k; i++) {
    if (!isConvexInnerCorner[i]) continue;
    const next = (i + 1) % k;
    if (innerCornerTA[i] >= trimDists[i] - 0.05) {
      portals[i].left = [corners[i][0], corners[i][1]];
    }
    if (innerCornerTB[i] >= trimDists[next] - 0.05) {
      portals[next].right = [corners[i][0], corners[i][1]];
    }
  }

  for (let i = 0; i < k; i++) {
    const bBranch = sortedBranches[i];
    const trimDist = trimDists[i];
    const { left: leftPortal, right: rightPortal, center: centerPortal } = portals[i];
    const tRec = trimmedEndpoints.get(bBranch.edge.id);
    if (tRec) {
      if (bBranch.endpoint === 'start') {
        tRec.start = centerPortal;
        tRec.startPortal = { left: leftPortal, right: rightPortal, center: centerPortal };
        tRec.startTrimDist = Math.max(tRec.startTrimDist, trimDist);
        tRec.hasCapStart = false;
      } else {
        tRec.end = centerPortal;
        tRec.endPortal = { left: rightPortal, right: leftPortal, center: centerPortal };
        tRec.endTrimDist = Math.max(tRec.endTrimDist, trimDist);
        tRec.hasCapEnd = false;
      }
      tRec.exemptFootprintIds.add(junctionFeatureId);
    }
  }

  const rawPolygonPoints: [number, number][] = [];
  for (let i = 0; i < k; i++) {
    rawPolygonPoints.push(portals[i].right);
    rawPolygonPoints.push(portals[i].left);
    rawPolygonPoints.push(corners[i]);
  }

  const polygonPoints: [number, number][] = [];
  for (let i = 0; i < rawPolygonPoints.length; i++) {
    const pt = rawPolygonPoints[i];
    const prev =
      polygonPoints.length > 0
        ? polygonPoints[polygonPoints.length - 1]
        : rawPolygonPoints[rawPolygonPoints.length - 1];
    if (Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > 1e-3) {
      polygonPoints.push(pt);
    }
  }

  if (polygonPoints.length < 3) return null;

  let dominantBranch = sortedBranches[0];
  for (let i = 1; i < k; i++) {
    const bBranch = sortedBranches[i];
    if (
      (ROAD_CLASS_PRIORITY[bBranch.roadClass] || 0) >
      (ROAD_CLASS_PRIORITY[dominantBranch.roadClass] || 0)
    ) {
      dominantBranch = bBranch;
    }
  }

  return {
    nodeId,
    junctionFeatureId,
    isPathJunction,
    polygonPoints,
    sortedBranches,
    portals,
    dominantBranch,
  };
}

/**
 * Constructs at-grade road ribbons, degree-2 continuity joins, and boundary-derived junction
 * polygons directly from an `InfrastructureRenderDescriptorBundle` (`M2.3-E2`).
 *
 * Strictly consumes `descriptors.roadNodes` and `descriptors.roadEdges` without calling legacy
 * `splitRoadsAtSharedInteriorNodes` or `TopologicalNodeIndex`.
 */
export function buildGraphAtGradeRoadGeometries(
  options: GraphRoadGeometryBuildOptions
): GraphRoadGeometryBuildResult {
  const {
    descriptors,
    roadWidthMultiplier,
    gradeTransitionCoords = [],
    resourceManager,
    diagnostics,
  } = options;

  const stats: GraphRoadRenderStats = {
    inputRoadNodeCount: descriptors.roadNodes.length,
    inputRoadEdgeCount: descriptors.roadEdges.length,
    atGradeRoadEdgeCount: 0,
    renderedRoadRibbonCount: 0,
    renderedJunctionCount: 0,
    branchingJunctionCount: 0,
    degree2ContinuityJoinCount: 0,
    pathJunctionCount: 0,
    crossTierOnlyNodeCount: 0,
    rejectedOrDegenerateCount: 0,
    fullySubtractedCount: 0,
    provenanceSplitSegmentCount: 0,
  };

  const roadsByClass = new Map<
    RoadClass,
    Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }>
  >();
  const atGradeRoadEndpoints: [number, number][] = [];
  const renderedSourceIds = new Set<string>();
  const fullySubtractedRoadIds = new Set<string>();

  // 1. Collect all confirmed grade transition coordinates (from graph descriptors + Stage 6D)
  const allGradeTransitionCoords: Array<readonly [number, number]> = [...gradeTransitionCoords];
  for (const gt of descriptors.gradeTransitions) {
    if (gt.network === 'road') {
      allGradeTransitionCoords.push(gt.position);
    }
  }

  // 2. Filter at-grade buildable road edges and initialize endpoint trim states
  const buildableEdges: RoadEdgeRenderDescriptor[] = [];
  const trimmedEndpoints = new Map<string, EdgeTrimState>();

  for (const edge of descriptors.roadEdges) {
    if (!edge.isAtGradeBuildable) continue;
    stats.atGradeRoadEdgeCount++;

    if (!edge.points || edge.points.length < 2) {
      stats.rejectedOrDegenerateCount++;
      continue;
    }
    const len = computePolylineLength(edge.points as [number, number][]);
    if (!Number.isFinite(len) || len < 0.05) {
      stats.rejectedOrDegenerateCount++;
      continue;
    }

    buildableEdges.push(edge);
    for (const pt of edge.points) {
      atGradeRoadEndpoints.push([pt[0], pt[1]]);
    }

    const startNode = descriptors.roadNodesById.get(edge.fromNodeId);
    const endNode = descriptors.roadNodesById.get(edge.toNodeId);
    const p0 = edge.points[0];
    const pn = edge.points[edge.points.length - 1];
    const isPath = edge.tier === 'path' || isNonVehicularRoadClass(edge.roadClass);

    const touchesGradeTransitionStart =
      Boolean(edge.startGradeTransitionId) ||
      Boolean(startNode && startNode.gradeTransitionIds.length > 0) ||
      Boolean(
        startNode &&
          startNode.incidentEdgeIds.some((id) => {
            const other = descriptors.roadEdgesById.get(id);
            return Boolean(other && !other.isAtGradeBuildable);
          })
      ) ||
      allGradeTransitionCoords.some((gt) => Math.hypot(gt[0] - p0[0], gt[1] - p0[1]) <= 0.65);

    const touchesGradeTransitionEnd =
      Boolean(edge.endGradeTransitionId) ||
      Boolean(endNode && endNode.gradeTransitionIds.length > 0) ||
      Boolean(
        endNode &&
          endNode.incidentEdgeIds.some((id) => {
            const other = descriptors.roadEdgesById.get(id);
            return Boolean(other && !other.isAtGradeBuildable);
          })
      ) ||
      allGradeTransitionCoords.some((gt) => Math.hypot(gt[0] - pn[0], gt[1] - pn[1]) <= 0.65);

    const isClippedStart = edge.clippedAtStart || Boolean(startNode?.isBoundaryClipped);
    const isClippedEnd = edge.clippedAtEnd || Boolean(endNode?.isBoundaryClipped);

    const sameTierDegreeStart = startNode
      ? isPath
        ? startNode.pathHalfEdgeCount
        : startNode.vehicularHalfEdgeCount
      : 1;
    const sameTierDegreeEnd = endNode
      ? isPath
        ? endNode.pathHalfEdgeCount
        : endNode.vehicularHalfEdgeCount
      : 1;

    const suppressCapStart =
      edge.isClosedLoop ||
      isClippedStart ||
      touchesGradeTransitionStart ||
      sameTierDegreeStart > 1 ||
      (isPath && Boolean(startNode?.isCrossTier));

    const suppressCapEnd =
      edge.isClosedLoop ||
      isClippedEnd ||
      touchesGradeTransitionEnd ||
      sameTierDegreeEnd > 1 ||
      (isPath && Boolean(endNode?.isCrossTier));

    trimmedEndpoints.set(edge.id, {
      startTrimDist: 0,
      endTrimDist: 0,
      hasCapStart: !suppressCapStart,
      hasCapEnd: !suppressCapEnd,
      exemptFootprintIds: new Set<string>(),
    });
  }

  // Helper to build GraphBranchSpec objects from a node's incident half-edges
  const collectBuildableBranches = (
    node: RoadNodeRenderDescriptor,
    halfEdges: readonly IncidentHalfEdge[]
  ): GraphBranchSpec[] => {
    const out: GraphBranchSpec[] = [];
    for (const he of halfEdges) {
      const edge = descriptors.roadEdgesById.get(he.edgeId);
      if (!edge || !edge.isAtGradeBuildable || !trimmedEndpoints.has(edge.id)) continue;
      const totalPolyLen = computePolylineLength(edge.points as [number, number][]);
      if (totalPolyLen < 0.05) continue;
      const dir = computeEdgeInwardTangent(edge, he.endpoint, he.inwardTangent);
      const endpointPt =
        he.endpoint === 'start' ? edge.points[0] : edge.points[edge.points.length - 1];
      const adjacentPt =
        he.endpoint === 'start'
          ? edge.points[1]
          : edge.points[Math.max(0, edge.points.length - 2)];
      const firstSegLen = Math.hypot(
        adjacentPt[0] - endpointPt[0],
        adjacentPt[1] - endpointPt[1]
      );
      out.push({
        edge,
        endpoint: he.endpoint,
        dir,
        nodePos: [node.position[0], node.position[1]],
        width: edge.width * roadWidthMultiplier,
        roadClass: edge.roadClass,
        segmentLength: Math.max(firstSegLen, totalPolyLen),
      });
    }
    return out;
  };

  // 3. Process topological road nodes in canonical order
  const pendingJunctions: PendingJunctionPolygon[] = [];

  for (const node of descriptors.roadNodes) {
    if (node.isCrossTierOnlyInteraction) {
      stats.crossTierOnlyNodeCount++;
    }

    if (node.isBoundaryClipped || node.isBridge || node.isTunnel || node.layer !== 0) {
      continue;
    }

    const nodeCenter: [number, number] = [node.position[0], node.position[1]];

    // A. Vehicular branching junctions (>= 3 vehicular half-edges)
    if (node.requiresVehicularJunctionTrimming) {
      const vehBranches = collectBuildableBranches(node, node.vehicularIncidentHalfEdges);
      if (vehBranches.length >= 3) {
        const solved = solveBoundaryDerivedJunctionNode(
          node.id,
          nodeCenter,
          vehBranches,
          false,
          trimmedEndpoints
        );
        if (solved) {
          pendingJunctions.push(solved);
          stats.branchingJunctionCount++;
        }
      } else if (vehBranches.length === 2) {
        const joined = applyDegree2SharedContinuityPortal(
          vehBranches[0],
          vehBranches[1],
          nodeCenter,
          trimmedEndpoints
        );
        if (joined) {
          stats.degree2ContinuityJoinCount++;
        } else {
          const solved = solveBoundaryDerivedJunctionNode(
            node.id,
            nodeCenter,
            vehBranches,
            false,
            trimmedEndpoints
          );
          if (solved) {
            pendingJunctions.push(solved);
            stats.degree2ContinuityJoinCount++;
          }
        }
      }
    } else if (node.requiresVehicularContinuityMiter) {
      // B. Degree-2 vehicular continuity join (including cross-tier through-roads)
      const vehBranches = collectBuildableBranches(node, node.vehicularIncidentHalfEdges);
      if (vehBranches.length === 2) {
        const joined = applyDegree2SharedContinuityPortal(
          vehBranches[0],
          vehBranches[1],
          nodeCenter,
          trimmedEndpoints
        );
        if (joined) {
          stats.degree2ContinuityJoinCount++;
        } else {
          const solved = solveBoundaryDerivedJunctionNode(
            node.id,
            nodeCenter,
            vehBranches,
            false,
            trimmedEndpoints
          );
          if (solved) {
            pendingJunctions.push(solved);
            stats.degree2ContinuityJoinCount++;
          }
        }
      }
    }

    // C. Pure path-tier junctions & continuity (vehicularHalfEdgeCount === 0 && pathHalfEdgeCount >= 2)
    if (node.requiresPathJunctionTrimming) {
      const pathBranches = collectBuildableBranches(node, node.pathIncidentHalfEdges);
      if (pathBranches.length === 2) {
        const joined = applyDegree2SharedContinuityPortal(
          pathBranches[0],
          pathBranches[1],
          nodeCenter,
          trimmedEndpoints
        );
        if (joined) {
          stats.degree2ContinuityJoinCount++;
        } else {
          const solved = solveBoundaryDerivedJunctionNode(
            node.id,
            nodeCenter,
            pathBranches,
            true,
            trimmedEndpoints
          );
          if (solved) {
            pendingJunctions.push(solved);
            stats.pathJunctionCount++;
          }
        }
      } else if (pathBranches.length >= 3) {
        const solved = solveBoundaryDerivedJunctionNode(
          node.id,
          nodeCenter,
          pathBranches,
          true,
          trimmedEndpoints
        );
        if (solved) {
          pendingJunctions.push(solved);
          stats.pathJunctionCount++;
        }
      }
    }
  }

  // 4. Resolve trimmed polylines and per-segment provenance sub-ribbons for all buildable edges
  // so multi-source simplified edges carry accurate per-segment InspectableFeatureInfo while
  // maintaining continuous shared portals at internal segment boundaries.
  const resolvedSubSegmentsByEdgeId = new Map<string, ResolvedEdgeSubSegment[]>();
  const edgeEndpointTouchingSubSegment = new Map<
    string,
    {
      startSubId: string;
      startSourceId: string;
      endSubId: string;
      endSourceId: string;
    }
  >();

  for (const edge of buildableEdges) {
    const tInfo = trimmedEndpoints.get(edge.id)!;
    const width = edge.width * roadWidthMultiplier;
    const totalLen = computePolylineLength(edge.points as [number, number][]);
    const sStart = Math.min(Math.max(0, tInfo.startTrimDist), totalLen * 0.45);
    const sEnd = Math.max(
      totalLen - Math.min(Math.max(0, tInfo.endTrimDist), totalLen * 0.45),
      sStart + 0.05
    );

    const isPath = edge.tier === 'path' || isNonVehicularRoadClass(edge.roadClass);
    const roadElevation = edge.isCulvert
      ? ELEVATION_POLICY.ROAD_SURFACE
      : getRoadElevation(
          edge.roadClass,
          edge.layer,
          edge.isBridge,
          edge.isTunnel,
          edge.sourceFeatureId || edge.id
        );

    const rawSegments: readonly EdgeSegmentProvenance[] =
      edge.provenance.segments.length > 0
        ? edge.provenance.segments
        : [
            {
              sourceFeatureId: edge.sourceFeatureId,
              partId: `${edge.sourceFeatureId}-0`,
              deduplicatedFeatureIds: edge.deduplicatedFeatureIds,
              startVertexIndex: 0,
              endVertexIndex: edge.points.length - 1,
              sourceStartVertexIndex: 0,
              sourceEndVertexIndex: edge.points.length - 1,
              startArcLength: 0,
              endArcLength: totalLen,
              reversedRelativeToSource: false,
              osmTags: edge.primaryOsmTags,
            },
          ];

    // Filter constituent segments active inside [sStart, sEnd]
    const activeSpans: Array<{
      seg: EdgeSegmentProvenance;
      spanStart: number;
      spanEnd: number;
    }> = [];

    if (rawSegments.length === 1) {
      activeSpans.push({
        seg: rawSegments[0],
        spanStart: sStart,
        spanEnd: sEnd,
      });
    } else {
      for (const seg of rawSegments) {
        const spanStart = Math.max(sStart, seg.startArcLength);
        const spanEnd = Math.min(sEnd, seg.endArcLength);
        if (spanEnd - spanStart >= 0.05) {
          activeSpans.push({ seg, spanStart, spanEnd });
        }
      }
      if (activeSpans.length === 0) {
        activeSpans.push({
          seg: rawSegments[0],
          spanStart: sStart,
          spanEnd: sEnd,
        });
      }
      // Ensure first active span starts at sStart and last active span ends at sEnd
      activeSpans[0].spanStart = sStart;
      activeSpans[activeSpans.length - 1].spanEnd = sEnd;
    }

    const m = activeSpans.length;
    if (m > 1) {
      stats.provenanceSplitSegmentCount += m - 1;
    }

    const subPolylines: [number, number][][] = [];
    for (let j = 0; j < m; j++) {
      const { spanStart, spanEnd } = activeSpans[j];
      const subPts = trimPolylineByArcLength(
        edge.points as [number, number][],
        spanStart,
        totalLen - spanEnd
      );
      if (j === 0 && tInfo.start && subPts.length >= 2) {
        subPts[0] = [tInfo.start[0], tInfo.start[1]];
      }
      if (j === m - 1 && tInfo.end && subPts.length >= 2) {
        subPts[subPts.length - 1] = [tInfo.end[0], tInfo.end[1]];
      }
      subPolylines.push(subPts);
    }

    // Compute shared internal portals between adjacent active provenance segments
    const internalPortals: Array<{ left: [number, number]; right: [number, number] }> = [];
    for (let j = 0; j < m - 1; j++) {
      const ptsA = subPolylines[j];
      const ptsB = subPolylines[j + 1];
      const pJoin = ptsA[ptsA.length - 1];
      ptsB[0] = [pJoin[0], pJoin[1]];

      const pPrev = ptsA[Math.max(0, ptsA.length - 2)];
      const pNext = ptsB[Math.min(ptsB.length - 1, 1)];
      const dxIn = pJoin[0] - pPrev[0];
      const dzIn = pJoin[1] - pPrev[1];
      const lenIn = Math.hypot(dxIn, dzIn) || 1e-6;
      const tInX = dxIn / lenIn;
      const tInZ = dzIn / lenIn;

      const dxOut = pNext[0] - pJoin[0];
      const dzOut = pNext[1] - pJoin[1];
      const lenOut = Math.hypot(dxOut, dzOut) || 1e-6;
      const tOutX = dxOut / lenOut;
      const tOutZ = dzOut / lenOut;

      let tx = tInX + tOutX;
      let tz = tInZ + tOutZ;
      const tLen = Math.hypot(tx, tz) || 1e-6;
      tx /= tLen;
      tz /= tLen;
      const nx = -tz;
      const nz = tx;

      const dot = tInX * tOutX + tInZ * tOutZ;
      const cosHalf = Math.sqrt(Math.max(0.1, (1 + dot) * 0.5));
      const miterScale = Math.min(1.30, 1.0 / Math.max(0.76, cosHalf));
      const halfW = (width / 2) * miterScale;

      internalPortals.push({
        left: [pJoin[0] + nx * halfW, pJoin[1] + nz * halfW],
        right: [pJoin[0] - nx * halfW, pJoin[1] - nz * halfW],
      });
    }

    const subSegments: ResolvedEdgeSubSegment[] = [];
    for (let j = 0; j < m; j++) {
      const { seg } = activeSpans[j];
      const subId = m === 1 ? edge.id : `${edge.id}#seg${j}`;
      const sids = [seg.sourceFeatureId, ...seg.deduplicatedFeatureIds];
      const uniqueSids = [...new Set(sids)];
      const startPortal =
        j === 0
          ? tInfo.startPortal
            ? { left: tInfo.startPortal.left, right: tInfo.startPortal.right }
            : undefined
          : internalPortals[j - 1];
      const endPortal =
        j === m - 1
          ? tInfo.endPortal
            ? { left: tInfo.endPortal.left, right: tInfo.endPortal.right }
            : undefined
          : internalPortals[j];

      const exemptIds = new Set<string>(tInfo.exemptFootprintIds);
      if (j > 0) exemptIds.add(`${edge.id}#seg${j - 1}`);
      if (j < m - 1) exemptIds.add(`${edge.id}#seg${j + 1}`);

      subSegments.push({
        subId,
        edge,
        seg,
        points: subPolylines[j],
        width,
        roadElevation,
        isPath,
        hasCapStart: j === 0 ? tInfo.hasCapStart : false,
        hasCapEnd: j === m - 1 ? tInfo.hasCapEnd : false,
        startPortal,
        endPortal,
        sourceFeatureId: seg.sourceFeatureId,
        sourceFeatureIds: uniqueSids,
        osmTags: sanitizeOsmTags(seg.osmTags),
        exemptFootprintIds: exemptIds,
      });
    }

    resolvedSubSegmentsByEdgeId.set(edge.id, subSegments);
    edgeEndpointTouchingSubSegment.set(edge.id, {
      startSubId: subSegments[0].subId,
      startSourceId: subSegments[0].sourceFeatureId,
      endSubId: subSegments[subSegments.length - 1].subId,
      endSourceId: subSegments[subSegments.length - 1].sourceFeatureId,
    });
  }

  // 5. Track 2D polygon footprints of placed junctions and road ribbons for Boolean clipping
  const placedRoadFootprints: PlacedRoadFootprint[] = [];

  const registerRoadFootprint = (id: string, isPath: boolean, ring: [number, number][]) => {
    if (!ring || ring.length < 3 || hasRingSelfIntersection(ring)) return;
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    const snapped: [number, number][] = [];
    for (const [x, z] of ring) {
      const sx = snapCoord(x);
      const sz = snapCoord(z);
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sz < minZ) minZ = sz;
      if (sz > maxZ) maxZ = sz;
      snapped.push([sx, sz]);
    }
    if (
      snapped.length > 0 &&
      (snapped[0][0] !== snapped[snapped.length - 1][0] ||
        snapped[0][1] !== snapped[snapped.length - 1][1])
    ) {
      snapped.push([snapped[0][0], snapped[0][1]]);
    }
    if (snapped.length >= 4 && !hasRingSelfIntersection(snapped)) {
      placedRoadFootprints.push({
        id,
        isPath,
        minX,
        maxX,
        minZ,
        maxZ,
        poly: [snapped],
      });
    }
  };

  // 6. Triangulate and register junction polygons (vehicular junctions first, then path junctions)
  const junctionGeometriesByClass = new Map<
    RoadClass,
    Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }>
  >();

  for (const junc of pendingJunctions) {
    const {
      junctionFeatureId,
      isPathJunction,
      polygonPoints,
      sortedBranches,
      portals,
      dominantBranch,
    } = junc;
    const dominantClass = dominantBranch.roadClass;
    const domEdge = dominantBranch.edge;
    const domSeg = getEndpointProvenanceSegment(domEdge, dominantBranch.endpoint);
    const domName =
      typeof domSeg?.osmTags?.name === 'string' ? domSeg.osmTags.name : domEdge.name;
    const yElev = getRoadElevation(dominantClass, 0, false, false);

    const junctionSourceIdsSet = new Set<string>();
    const portalConnections: RoadPortalConnectionSpec[] = [];

    for (let bIdx = 0; bIdx < sortedBranches.length; bIdx++) {
      const bBranch = sortedBranches[bIdx];
      const bPortal = portals[bIdx];
      const touching = edgeEndpointTouchingSubSegment.get(bBranch.edge.id);
      const endpointSeg = getEndpointProvenanceSegment(bBranch.edge, bBranch.endpoint);
      const branchSids = endpointSeg
        ? [endpointSeg.sourceFeatureId, ...endpointSeg.deduplicatedFeatureIds]
        : [...bBranch.edge.sourceFeatureIds];
      for (const sid of branchSids) {
        junctionSourceIdsSet.add(sid);
        renderedSourceIds.add(sid);
      }

      const touchingSubId = touching
        ? bBranch.endpoint === 'start'
          ? touching.startSubId
          : touching.endSubId
        : bBranch.edge.id;
      const touchingSourceId = touching
        ? bBranch.endpoint === 'start'
          ? touching.startSourceId
          : touching.endSourceId
        : branchSids[0];

      portalConnections.push({
        roadFeatureId: touchingSubId,
        sourceFeatureId: touchingSourceId,
        endpoint: bBranch.endpoint,
        left: bBranch.endpoint === 'start' ? bPortal.left : bPortal.right,
        right: bBranch.endpoint === 'start' ? bPortal.right : bPortal.left,
      });
    }

    registerRoadFootprint(junctionFeatureId, isPathJunction, polygonPoints);

    const contour = polygonPoints.map(([x, z]) => new THREE.Vector2(x, z));
    if (THREE.ShapeUtils.isClockWise(contour)) {
      contour.reverse();
    }
    const earTriangles = THREE.ShapeUtils.triangulateShape(contour, []);

    const junctionVertices: number[] = [];
    const junctionIndices: number[] = [];
    const junctionNormals: number[] = [];

    for (let pIdx = 0; pIdx < contour.length; pIdx++) {
      junctionVertices.push(contour[pIdx].x, yElev, contour[pIdx].y);
      junctionNormals.push(0, 1, 0);
    }

    for (const [i0, i1, i2] of earTriangles) {
      const ax = contour[i1].x - contour[i0].x;
      const az = contour[i1].y - contour[i0].y;
      const bx = contour[i2].x - contour[i0].x;
      const bz = contour[i2].y - contour[i0].y;
      const crossY = az * bx - ax * bz;
      if (crossY > 1e-7) {
        junctionIndices.push(i0, i1, i2);
      } else if (crossY < -1e-7) {
        junctionIndices.push(i0, i2, i1);
      }
    }

    if (junctionIndices.length > 0) {
      const junctionGeo = resourceManager.registerGeometry(new THREE.BufferGeometry());
      junctionGeo.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(junctionVertices, 3)
      );
      junctionGeo.setAttribute(
        'normal',
        new THREE.Float32BufferAttribute(junctionNormals, 3)
      );
      junctionGeo.setIndex(junctionIndices);

      const cartoLabel = formatRoadCartoLabel(dominantClass);
      if (!junctionGeometriesByClass.has(dominantClass)) {
        junctionGeometriesByClass.set(dominantClass, []);
      }
      junctionGeometriesByClass.get(dominantClass)!.push({
        geom: junctionGeo,
        info: {
          id: junctionFeatureId,
          sourceFeatureId: domSeg?.sourceFeatureId || domEdge.sourceFeatureId || domEdge.id,
          sourceFeatureIds: Array.from(junctionSourceIdsSet),
          portalConnections: isPathJunction ? undefined : portalConnections,
          name: domName ? `${domName} (Junction)` : 'Road Junction',
          category: 'Road & Way',
          cartoLabel,
          primaryTag: `highway=${dominantClass}`,
          subtype: dominantClass,
          width: Number(dominantBranch.width.toFixed(1)),
          elevation: yElev,
          layer: 0,
          isBridge: false,
          isTunnel: false,
          osmTags: sanitizeOsmTags(domSeg?.osmTags ?? domEdge.primaryOsmTags),
        },
      });
      stats.renderedJunctionCount++;
    }
  }

  // 7. Build trimmed road ribbons (vehicular edges first, then path-tier edges so paths clip against carriageways)
  const sortedBuildableEdges = [...buildableEdges].sort((a, b) => {
    const aPath = a.tier === 'path' || isNonVehicularRoadClass(a.roadClass) ? 1 : 0;
    const bPath = b.tier === 'path' || isNonVehicularRoadClass(b.roadClass) ? 1 : 0;
    if (aPath !== bPath) return aPath - bPath;
    return compareStringsCodeUnit(a.id, b.id);
  });

  for (const edge of sortedBuildableEdges) {
    const subSegments = resolvedSubSegmentsByEdgeId.get(edge.id);
    if (!subSegments || subSegments.length === 0) continue;

    for (const sub of subSegments) {
      try {
        let pts = sub.points;
        const { width, roadElevation, isPath, sourceFeatureIds: sids } = sub;
        const portalOpts: Pick<RoadRibbonOptions, 'startPortal' | 'endPortal'> = {
          startPortal: sub.startPortal,
          endPortal: sub.endPortal,
        };

        const isClosedSubLoop =
          pts.length >= 4 &&
          Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <
            0.05;

        const outlinePoly = isClosedSubLoop
          ? null
          : buildRoadRibbonOutlineRing(pts, width, portalOpts);

        let geom: THREE.BufferGeometry | null = null;
        let resolvedClippedPolys: MultiPolygonCoords | null = null;

        // Check whether this road/path sub-segment overlaps any already-placed footprint
        if (placedRoadFootprints.length > 0 && !isClosedSubLoop) {
          let pMinX = Infinity,
            pMaxX = -Infinity,
            pMinZ = Infinity,
            pMaxZ = -Infinity;
          const ptsForBBox = outlinePoly && outlinePoly[0] ? outlinePoly[0] : pts;
          const halfMargin = outlinePoly ? 0 : width * 0.5;
          for (const pt of ptsForBBox) {
            if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
            if (pt[0] - halfMargin < pMinX) pMinX = pt[0] - halfMargin;
            if (pt[0] + halfMargin > pMaxX) pMaxX = pt[0] + halfMargin;
            if (pt[1] - halfMargin < pMinZ) pMinZ = pt[1] - halfMargin;
            if (pt[1] + halfMargin > pMaxZ) pMaxZ = pt[1] + halfMargin;
          }

          const candidateFootprints: PlacedRoadFootprint[] = [];
          for (const fp of placedRoadFootprints) {
            if (!isPath && fp.isPath) continue;
            // For vehicular ribbons, skip footprints that share an exact 1D portal with this sub-segment
            if (!isPath && sub.exemptFootprintIds.has(fp.id)) continue;
            if (isPath && fp.isPath && sub.exemptFootprintIds.has(fp.id)) continue;
            if (
              pMaxX > fp.minX &&
              pMinX < fp.maxX &&
              pMaxZ > fp.minZ &&
              pMinZ < fp.maxZ
            ) {
              candidateFootprints.push(fp);
            }
          }

          if (candidateFootprints.length > 0) {
            const outlineHasSelfIntersection =
              !outlinePoly || !outlinePoly[0] || hasRingSelfIntersection(outlinePoly[0]);

            let requiresClipping = isPath || outlineHasSelfIntersection;
            const overlappingPolys: Array<[number, number][][]> = [];
            const overlappingBoxes: Array<{
              minX: number;
              maxX: number;
              minZ: number;
              maxZ: number;
            }> = [];

            if (!outlineHasSelfIntersection && outlinePoly) {
              for (const fp of candidateFootprints) {
                try {
                  const inter = polygonClipping.intersection(
                    outlinePoly as unknown as polygonClipping.Geom,
                    fp.poly as unknown as polygonClipping.Geom
                  ) as unknown as MultiPolygonCoords;
                  const cleanedInter = filterDegenerateBooleanArtifacts(inter);
                  if (cleanedInter.length > 0) {
                    requiresClipping = true;
                    overlappingPolys.push(fp.poly);
                    overlappingBoxes.push({
                      minX: fp.minX,
                      maxX: fp.maxX,
                      minZ: fp.minZ,
                      maxZ: fp.maxZ,
                    });
                  }
                } catch {
                  requiresClipping = true;
                  overlappingPolys.push(fp.poly);
                  overlappingBoxes.push({
                    minX: fp.minX,
                    maxX: fp.maxX,
                    minZ: fp.minZ,
                    maxZ: fp.maxZ,
                  });
                }
              }
            } else {
              for (const fp of candidateFootprints) {
                overlappingPolys.push(fp.poly);
                overlappingBoxes.push({
                  minX: fp.minX,
                  maxX: fp.maxX,
                  minZ: fp.minZ,
                  maxZ: fp.maxZ,
                });
              }
            }

            if (requiresClipping && overlappingPolys.length > 0) {
              let clippedSuccess = false;
              let diffResult: MultiPolygonCoords = [];

              if (!outlineHasSelfIntersection && outlinePoly) {
                try {
                  const rawDiff = polygonClipping.difference(
                    outlinePoly as unknown as polygonClipping.Geom,
                    ...(overlappingPolys as unknown as polygonClipping.Geom[])
                  ) as unknown as MultiPolygonCoords;
                  diffResult = filterDegenerateBooleanArtifacts(rawDiff);
                  clippedSuccess = true;
                } catch {
                  clippedSuccess = false;
                }
              }

              if (!clippedSuccess) {
                try {
                  const cleanedPts = cleanPolylineForClipping(pts);
                  const cleanedOutline = buildRoadRibbonOutlineRing(cleanedPts, width);
                  if (
                    cleanedOutline &&
                    cleanedOutline[0] &&
                    !hasRingSelfIntersection(cleanedOutline[0])
                  ) {
                    let currentGeom: MultiPolygonCoords = [cleanedOutline];
                    for (const clipPoly of overlappingPolys) {
                      if (currentGeom.length === 0) break;
                      currentGeom = polygonClipping.difference(
                        currentGeom as unknown as polygonClipping.Geom,
                        clipPoly as unknown as polygonClipping.Geom
                      ) as unknown as MultiPolygonCoords;
                    }
                    diffResult = filterDegenerateBooleanArtifacts(currentGeom);
                    clippedSuccess = true;
                  }
                } catch {
                  clippedSuccess = false;
                }
              }

              if (clippedSuccess) {
                resolvedClippedPolys = diffResult;
                const shapes = createShapesFromMultiPolygon(diffResult);
                if (shapes.length > 0) {
                  const shapeGeo = new THREE.ShapeGeometry(shapes);
                  shapeGeo.rotateX(-Math.PI / 2);
                  shapeGeo.translate(0, roadElevation, 0);
                  if (shapeGeo.hasAttribute('uv')) shapeGeo.deleteAttribute('uv');
                  geom = resourceManager.registerGeometry(shapeGeo);
                } else {
                  stats.fullySubtractedCount++;
                  fullySubtractedRoadIds.add(sub.subId);
                  fullySubtractedRoadIds.add(edge.id);
                  for (const sid of sids) fullySubtractedRoadIds.add(sid);
                  if (diagnostics?.featuresFullySubtracted) {
                    diagnostics.featuresFullySubtracted.count++;
                    if (diagnostics.featuresFullySubtracted.sampleIds.length < 10) {
                      diagnostics.featuresFullySubtracted.sampleIds.push(sids[0]);
                    }
                  }
                  continue;
                }
              } else {
                if (diagnostics) {
                  if (!diagnostics.clippingFailures) {
                    diagnostics.clippingFailures = { count: 0, sampleIds: [] };
                  }
                  diagnostics.clippingFailures.count++;
                  if (diagnostics.clippingFailures.sampleIds.length < 10) {
                    diagnostics.clippingFailures.sampleIds.push(sids[0]);
                  }
                  if (!diagnostics.rejectedInvalid.byReason['path_boolean_clipping_failed']) {
                    diagnostics.rejectedInvalid.byReason['path_boolean_clipping_failed'] = {
                      count: 0,
                      sampleIds: [],
                    };
                  }
                  diagnostics.rejectedInvalid.byReason['path_boolean_clipping_failed'].count++;
                  if (
                    diagnostics.rejectedInvalid.byReason['path_boolean_clipping_failed'].sampleIds
                      .length < 10
                  ) {
                    diagnostics.rejectedInvalid.byReason[
                      'path_boolean_clipping_failed'
                    ].sampleIds.push(sids[0]);
                  }
                }

                const exteriorSubPolylines = buildSafeExteriorSubPolylines(
                  pts,
                  width,
                  overlappingBoxes
                );
                const subGeos: THREE.BufferGeometry[] = [];
                for (const subPts of exteriorSubPolylines) {
                  const subOutline = buildRoadRibbonOutlineRing(subPts, width);
                  if (!subOutline || !subOutline[0] || hasRingSelfIntersection(subOutline[0])) {
                    continue;
                  }
                  let overlapsExisting = false;
                  for (const fp of placedRoadFootprints) {
                    if (!isPath && fp.isPath) continue;
                    try {
                      const subInter = polygonClipping.intersection(
                        subOutline as unknown as polygonClipping.Geom,
                        fp.poly as unknown as polygonClipping.Geom
                      ) as unknown as MultiPolygonCoords;
                      if (filterDegenerateBooleanArtifacts(subInter).length > 0) {
                        overlapsExisting = true;
                        break;
                      }
                    } catch {
                      overlapsExisting = true;
                      break;
                    }
                  }
                  if (overlapsExisting) continue;

                  const subRibbon = generateRoadRibbon(subPts, width, roadElevation, {
                    roundCaps: false,
                  });
                  if (subRibbon) {
                    const g = new THREE.BufferGeometry();
                    g.setAttribute('position', new THREE.BufferAttribute(subRibbon.positions, 3));
                    g.setAttribute('normal', new THREE.BufferAttribute(subRibbon.normals, 3));
                    g.setIndex(new THREE.BufferAttribute(subRibbon.indices, 1));
                    subGeos.push(g);
                    registerRoadFootprint(sub.subId, isPath, subOutline[0]);
                  }
                }
                if (subGeos.length > 0) {
                  const mergedSafe = mergeGeometries(subGeos, false);
                  for (const sg of subGeos) sg.dispose();
                  if (mergedSafe) {
                    geom = resourceManager.registerGeometry(mergedSafe);
                  }
                }
                if (!geom) {
                  stats.fullySubtractedCount++;
                  fullySubtractedRoadIds.add(sub.subId);
                  fullySubtractedRoadIds.add(edge.id);
                  for (const sid of sids) fullySubtractedRoadIds.add(sid);
                  continue;
                }
              }
            }
          }
        }

        if (!geom) {
          if (
            !isClosedSubLoop &&
            (!outlinePoly || !outlinePoly[0] || hasRingSelfIntersection(outlinePoly[0]))
          ) {
            const cleanedPts = cleanPolylineForClipping(pts);
            const cleanedOutline = buildRoadRibbonOutlineRing(cleanedPts, width);
            if (
              !cleanedOutline ||
              !cleanedOutline[0] ||
              hasRingSelfIntersection(cleanedOutline[0])
            ) {
              stats.rejectedOrDegenerateCount++;
              if (diagnostics) {
                if (!diagnostics.clippingFailures) {
                  diagnostics.clippingFailures = { count: 0, sampleIds: [] };
                }
                diagnostics.clippingFailures.count++;
                if (diagnostics.clippingFailures.sampleIds.length < 10) {
                  diagnostics.clippingFailures.sampleIds.push(sids[0]);
                }
              }
              continue;
            }
            pts = cleanedPts;
          }

          const ribbon = generateRoadRibbon(pts, width, roadElevation, {
            roundCaps: !isClosedSubLoop,
            hasStartCap: sub.hasCapStart,
            hasEndCap: sub.hasCapEnd,
            startPortal: sub.startPortal,
            endPortal: sub.endPortal,
          });
          if (!ribbon) {
            stats.rejectedOrDegenerateCount++;
            continue;
          }

          geom = resourceManager.registerGeometry(new THREE.BufferGeometry());
          geom.setAttribute('position', new THREE.BufferAttribute(ribbon.positions, 3));
          geom.setAttribute('normal', new THREE.BufferAttribute(ribbon.normals, 3));
          geom.setIndex(new THREE.BufferAttribute(ribbon.indices, 1));
        }

        // Register footprint for downstream clipping
        if (resolvedClippedPolys) {
          for (const polyRings of resolvedClippedPolys) {
            if (polyRings[0]) registerRoadFootprint(sub.subId, isPath, polyRings[0]);
          }
        } else if (isClosedSubLoop) {
          const midIdx = Math.floor(pts.length / 2);
          if (midIdx >= 1 && pts.length - midIdx >= 2) {
            const half1 = buildRoadRibbonOutlineRing(pts.slice(0, midIdx + 1), width, {
              startPortal: sub.startPortal,
            });
            const half2 = buildRoadRibbonOutlineRing(pts.slice(midIdx), width, {
              endPortal: sub.endPortal,
            });
            if (half1 && half1[0]) registerRoadFootprint(`${sub.subId}#h1`, isPath, half1[0]);
            if (half2 && half2[0]) registerRoadFootprint(`${sub.subId}#h2`, isPath, half2[0]);
          }
        } else if (outlinePoly && outlinePoly[0]) {
          registerRoadFootprint(sub.subId, isPath, outlinePoly[0]);
        }

        const segName =
          typeof sub.seg.osmTags?.name === 'string' && sub.seg.osmTags.name.trim().length > 0
            ? sub.seg.osmTags.name.trim()
            : edge.name;
        const cartoLabel = formatRoadCartoLabel(edge.roadClass);

        const roadInfo: InspectableFeatureInfo = {
          id: sub.subId,
          sourceFeatureId: sub.sourceFeatureId,
          sourceFeatureIds: sub.sourceFeatureIds,
          name: segName || cartoLabel || `Road (${edge.roadClass})`,
          category: 'Road & Way',
          cartoLabel,
          primaryTag: `highway=${edge.roadClass}`,
          subtype: edge.roadClass,
          width: Number(width.toFixed(1)),
          elevation: roadElevation,
          layer: edge.layer,
          isBridge: edge.isBridge,
          isTunnel: edge.isTunnel,
          osmTags: sub.osmTags,
        };

        if (!roadsByClass.has(edge.roadClass)) {
          roadsByClass.set(edge.roadClass, []);
        }
        roadsByClass.get(edge.roadClass)!.push({
          geom,
          info: roadInfo,
        });
        stats.renderedRoadRibbonCount++;

        if (edge.roadClass === 'steps') {
          const treadGeo = generateStepTreads(
            pts,
            width,
            roadElevation + ELEVATION_POLICY.STEP_TREAD_OFFSET
          );
          if (treadGeo) {
            resourceManager.registerGeometry(treadGeo);
            roadsByClass.get(edge.roadClass)!.push({ geom: treadGeo, info: roadInfo });
          }
        }

        for (const sid of sids) {
          renderedSourceIds.add(sid);
        }
      } catch (err) {
        console.warn(`Skipping invalid graph at-grade road segment ${sub.subId}`, err);
        stats.rejectedOrDegenerateCount++;
      }
    }
  }

  // 8. Append junction geometries into their corresponding road class buckets
  junctionGeometriesByClass.forEach((items, roadClass) => {
    if (!roadsByClass.has(roadClass)) {
      roadsByClass.set(roadClass, []);
    }
    roadsByClass.get(roadClass)!.push(...items);
  });

  return {
    roadsByClass,
    atGradeRoadEndpoints,
    renderedSourceIds,
    fullySubtractedRoadIds,
    stats,
  };
}
