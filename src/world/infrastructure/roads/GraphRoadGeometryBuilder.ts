import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import polygonClipping from 'polygon-clipping';
import {
  InspectableFeatureInfo,
  ProcessedMapData,
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
  FaceFeatureRange,
  generateRoadRibbon,
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
 * Structural 3D mesh names inside `roadsGroup` that legitimately contain vertical walls
 * or downward-facing bridge undersides and are excluded from horizontal at-grade road surface checks.
 */
const STRUCTURAL_NON_SURFACE_ROAD_MESH_NAMES = new Set<string>([
  'Bridge_Substructure',
  'Bridge_Piers',
  'Bridge_Parapets',
  'Tunnel_Portals',
  'Tunnel_Entrances',
  'Tunnel_Underground_Trace',
]);

/**
 * Minimum triangle area (`m²`) below which an indexed face is classified as degenerate.
 */
export const MIN_NONDEGENERATE_TRIANGLE_AREA_M2 = 1e-6;

/**
 * Detailed attribution for a winding or normal-orientation defect detected on an at-grade road,
 * path, step-tread, or junction triangle (`M2.3-E2`).
 */
export interface GraphRoadWindingDefect {
  /** Name of the Three.js `Mesh` containing the defective triangle (e.g. `Roads_residential`). */
  meshName: string;
  /** Zero-based triangle face index (`indexOffset / 3`) within the mesh geometry. */
  faceIndex: number;
  /** Graph edge, sub-segment, or junction feature ID resolved from `userData.faceRanges`. */
  featureId?: string;
  /** Upstream source feature ID (`way/...`) resolved from `userData.faceRanges`. */
  sourceFeatureId?: string;
  /** Failure classification. */
  reason:
    | 'inverted_winding'
    | 'non_upward_horizontal_face'
    | 'stored_normal_mismatch'
    | 'non_finite_vertex';
  /** World-space triangle vertex coordinates `[v0, v1, v2]`. */
  vertices: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
  /** Unit geometric face normal computed via `normalize(cross(v1 - v0, v2 - v0))`. */
  geometricNormal: [number, number, number];
  /** Stored vertex normals `[n0, n1, n2]` from the geometry's `normal` buffer attribute. */
  storedNormals: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
  /** Minimum dot product between `geometricNormal` and the 3 stored vertex normals. */
  minStoredNormalDot: number;
  /** Geometric area of the triangle in square meters (`0.5 * |cross(v1 - v0, v2 - v0)|`). */
  area: number;
}

/**
 * Detailed attribution for a zero-area or near-zero-area degenerate triangle detected in a road mesh.
 */
export interface GraphRoadDegenerateTriangleDefect {
  /** Name of the Three.js `Mesh` containing the degenerate triangle. */
  meshName: string;
  /** Zero-based triangle face index (`indexOffset / 3`) within the mesh geometry. */
  faceIndex: number;
  /** Graph edge, sub-segment, or junction feature ID resolved from `userData.faceRanges`. */
  featureId?: string;
  /** Upstream source feature ID (`way/...`) resolved from `userData.faceRanges`. */
  sourceFeatureId?: string;
  /** World-space triangle vertex coordinates `[v0, v1, v2]`. */
  vertices: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
  /** Geometric area of the triangle in square meters (`<= 1e-6 m²`). */
  area: number;
}

/**
 * Summary report produced by `auditGraphRoadMeshIntegrity()`.
 */
export interface GraphRoadMeshIntegrityReport {
  /** Total horizontal at-grade road/path/step/junction meshes inspected. */
  auditedMeshCount: number;
  /** Total indexed triangles inspected across all audited at-grade road/path/junction features. */
  auditedTriangleCount: number;
  /** Number of non-degenerate horizontal triangles with valid upward `+Y` geometric winding (`geomNormal.y > 0.99`). */
  upwardTriangleCount: number;
  /** Number of triangles with inverted/downward geometric winding (`geomNormal.y < 0`). */
  negativelyWoundCount: number;
  /** Number of triangles whose stored vertex normals disagree with the geometric face normal (`dot <= 0.99`). */
  storedNormalMismatchCount: number;
  /** Winding and normal orientation defects with full feature and coordinate attribution. */
  windingDefects: GraphRoadWindingDefect[];
  /** Degenerate triangles (`area <= 1e-6 m²`) reported separately from winding defects. */
  degenerateTriangles: GraphRoadDegenerateTriangleDefect[];
}

/**
 * Resolves the `InspectableFeatureInfo` corresponding to `faceIndex` from a mesh's `userData.faceRanges`.
 */
function resolveFaceFeatureInfo(
  mesh: THREE.Mesh,
  faceIndex: number
): InspectableFeatureInfo | undefined {
  const ranges = mesh.userData?.faceRanges as FaceFeatureRange[] | undefined;
  if (Array.isArray(ranges)) {
    for (const r of ranges) {
      if (faceIndex >= r.startFace && faceIndex < r.endFace) {
        return r.info;
      }
    }
  }
  if (mesh.userData?.id && mesh.userData?.category) {
    return mesh.userData as InspectableFeatureInfo;
  }
  return undefined;
}

/**
 * Audits all horizontal at-grade road, path, step-tread, and junction triangles under `roadsRoot`
 * by computing actual geometric face normals from indexed triangle positions via `cross(v1 - v0, v2 - v0)`.
 *
 * Verifies:
 * 1. Every non-degenerate horizontal at-grade road/path/junction triangle faces upward (`geomNormal.y > 0.99`).
 * 2. Stored vertex normals agree with geometric face orientation (`dot(storedNormal, geomNormal) > 0.99`).
 * 3. Degenerate triangles (`area <= 1e-6 m²`) are reported separately.
 * 4. Valid 3D structural meshes (`Bridge_Substructure`, `Bridge_Piers`, `Bridge_Parapets`, `Tunnel_Portals`)
 *    and sloped elevated bridge ramps are not misclassified as horizontal at-grade road surfaces.
 */
export function auditGraphRoadMeshIntegrity(
  roadsRoot: THREE.Object3D
): GraphRoadMeshIntegrityReport {
  const report: GraphRoadMeshIntegrityReport = {
    auditedMeshCount: 0,
    auditedTriangleCount: 0,
    upwardTriangleCount: 0,
    negativelyWoundCount: 0,
    storedNormalMismatchCount: 0,
    windingDefects: [],
    degenerateTriangles: [],
  };

  roadsRoot.updateMatrixWorld(true);
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const crossVec = new THREE.Vector3();
  const n0 = new THREE.Vector3();
  const n1 = new THREE.Vector3();
  const n2 = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();

  roadsRoot.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (STRUCTURAL_NON_SURFACE_ROAD_MESH_NAMES.has(obj.name)) return;

    const geom = obj.geometry as THREE.BufferGeometry | undefined;
    if (!geom) return;
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr || posAttr.count < 3) return;
    const normAttr = geom.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const indexAttr = geom.getIndex();

    report.auditedMeshCount++;
    normalMatrix.getNormalMatrix(obj.matrixWorld);

    const triCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(posAttr.count / 3);

    for (let f = 0; f < triCount; f++) {
      const i0 = indexAttr ? indexAttr.getX(f * 3) : f * 3;
      const i1 = indexAttr ? indexAttr.getX(f * 3 + 1) : f * 3 + 1;
      const i2 = indexAttr ? indexAttr.getX(f * 3 + 2) : f * 3 + 2;

      const info = resolveFaceFeatureInfo(obj, f);
      // Skip elevated bridge deck ramps (`Roads_bridge` / `info.isBridge`), which have sloped approach spans.
      // At-grade culverts (where `info.isTunnel` may be true on a horizontal road mesh) remain audited.
      if (obj.name === 'Roads_bridge' || info?.isBridge) {
        continue;
      }

      v0.fromBufferAttribute(posAttr, i0).applyMatrix4(obj.matrixWorld);
      v1.fromBufferAttribute(posAttr, i1).applyMatrix4(obj.matrixWorld);
      v2.fromBufferAttribute(posAttr, i2).applyMatrix4(obj.matrixWorld);

      const verts: [
        [number, number, number],
        [number, number, number],
        [number, number, number],
      ] = [
        [v0.x, v0.y, v0.z],
        [v1.x, v1.y, v1.z],
        [v2.x, v2.y, v2.z],
      ];

      if (
        !Number.isFinite(v0.x) ||
        !Number.isFinite(v0.y) ||
        !Number.isFinite(v0.z) ||
        !Number.isFinite(v1.x) ||
        !Number.isFinite(v1.y) ||
        !Number.isFinite(v1.z) ||
        !Number.isFinite(v2.x) ||
        !Number.isFinite(v2.y) ||
        !Number.isFinite(v2.z)
      ) {
        report.auditedTriangleCount++;
        report.windingDefects.push({
          meshName: obj.name || 'UnnamedRoadMesh',
          faceIndex: f,
          featureId: info?.id,
          sourceFeatureId: info?.sourceFeatureId,
          reason: 'non_finite_vertex',
          vertices: verts,
          geometricNormal: [0, 0, 0],
          storedNormals: [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
          ],
          minStoredNormalDot: 0,
          area: 0,
        });
        continue;
      }

      // If no faceRanges metadata was attached, ignore elevated sloped bridge ramp faces (y > 0.12 m)
      const maxY = Math.max(v0.y, v1.y, v2.y);
      const minY = Math.min(v0.y, v1.y, v2.y);
      if (!info && (maxY > 0.12 || minY < -0.05)) {
        continue;
      }

      report.auditedTriangleCount++;

      e1.subVectors(v1, v0);
      e2.subVectors(v2, v0);
      crossVec.crossVectors(e1, e2);
      const doubleArea = crossVec.length();
      const area = doubleArea * 0.5;

      if (!Number.isFinite(area) || area <= MIN_NONDEGENERATE_TRIANGLE_AREA_M2) {
        report.degenerateTriangles.push({
          meshName: obj.name || 'UnnamedRoadMesh',
          faceIndex: f,
          featureId: info?.id,
          sourceFeatureId: info?.sourceFeatureId,
          vertices: verts,
          area: Number.isFinite(area) ? area : 0,
        });
        continue;
      }

      const geomNormal: [number, number, number] = [
        crossVec.x / doubleArea,
        crossVec.y / doubleArea,
        crossVec.z / doubleArea,
      ];

      let storedNormals: [
        [number, number, number],
        [number, number, number],
        [number, number, number],
      ] = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      let minDot = -1;

      if (normAttr && normAttr.count > Math.max(i0, i1, i2)) {
        n0.fromBufferAttribute(normAttr, i0).applyMatrix3(normalMatrix).normalize();
        n1.fromBufferAttribute(normAttr, i1).applyMatrix3(normalMatrix).normalize();
        n2.fromBufferAttribute(normAttr, i2).applyMatrix3(normalMatrix).normalize();
        storedNormals = [
          [n0.x, n0.y, n0.z],
          [n1.x, n1.y, n1.z],
          [n2.x, n2.y, n2.z],
        ];
        const dot0 =
          n0.x * geomNormal[0] + n0.y * geomNormal[1] + n0.z * geomNormal[2];
        const dot1 =
          n1.x * geomNormal[0] + n1.y * geomNormal[1] + n1.z * geomNormal[2];
        const dot2 =
          n2.x * geomNormal[0] + n2.y * geomNormal[1] + n2.z * geomNormal[2];
        minDot = Math.min(dot0, dot1, dot2);
      }

      const isUpward = geomNormal[1] > 0.99;
      const normalsAgree = minDot > 0.99;

      if (geomNormal[1] < 0) {
        report.negativelyWoundCount++;
      }
      if (!normalsAgree) {
        report.storedNormalMismatchCount++;
      }

      if (!isUpward) {
        report.windingDefects.push({
          meshName: obj.name || 'UnnamedRoadMesh',
          faceIndex: f,
          featureId: info?.id,
          sourceFeatureId: info?.sourceFeatureId,
          reason: geomNormal[1] < 0 ? 'inverted_winding' : 'non_upward_horizontal_face',
          vertices: verts,
          geometricNormal: geomNormal,
          storedNormals,
          minStoredNormalDot: minDot,
          area,
        });
      } else if (!normalsAgree) {
        report.windingDefects.push({
          meshName: obj.name || 'UnnamedRoadMesh',
          faceIndex: f,
          featureId: info?.id,
          sourceFeatureId: info?.sourceFeatureId,
          reason: 'stored_normal_mismatch',
          vertices: verts,
          geometricNormal: geomNormal,
          storedNormals,
          minStoredNormalDot: minDot,
          area,
        });
      } else {
        report.upwardTriangleCount++;
      }
    }
  });

  return report;
}

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
  /** Number of degenerate or micro road edges/sub-segments or invalid junction solutions rejected. */
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
  /** Optional world coordinates `[x, z]` of legacy Stage 6D bridge/tunnel endpoints (retained for interface compatibility). */
  gradeTransitionCoords?: ReadonlyArray<readonly [number, number]>;
  /** Scene resource manager for deterministic GPU buffer registration and disposal. */
  resourceManager: SceneResourceManager;
  /** Optional pipeline diagnostics object to record clipping failures or rejected geometry fallbacks. */
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
  firstSegmentLength: number;
  totalEdgeLength: number;
  segmentLength: number;
}

interface PendingJunctionPolygon {
  nodeId: string;
  junctionFeatureId: string;
  isPathJunction: boolean;
  polygonPoints: [number, number][];
  validatedTriangles: Array<[number, number, number]>;
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
 * Records a structured rejection/fallback reason in `ProcessedMapData['diagnostics']` when provided.
 */
function recordGraphRoadDiagnostic(
  diagnostics: ProcessedMapData['diagnostics'] | undefined,
  reason: string,
  sampleId: string
): void {
  if (!diagnostics) return;
  if (!diagnostics.rejectedInvalid.byReason[reason]) {
    diagnostics.rejectedInvalid.byReason[reason] = { count: 0, sampleIds: [] };
  }
  const bucket = diagnostics.rejectedInvalid.byReason[reason];
  bucket.count++;
  if (bucket.sampleIds.length < 10 && !bucket.sampleIds.includes(sampleId)) {
    bucket.sampleIds.push(sampleId);
  }
}

/**
 * Validates and cleans a horizontal road/path/step/junction `BufferGeometry` in place:
 * - Verifies that NO non-degenerate triangle (`area > 1e-6 m²`) has downward/inverted winding (`crossY <= 0`).
 *   Never conceals inverted triangles by flipping normals or reversing indices.
 * - Filters out zero-area collinear sliver triangles (`area <= 1e-6 m²`) emitted by earcut or pinched quads.
 * - Ensures stored vertex normals on all active vertices are `[0, 1, 0]`.
 *
 * Returns `true` if the geometry has `>= 1` valid upward-facing triangles and `0` inverted triangles,
 * or `false` if any non-degenerate triangle is inverted or no valid triangles remain.
 */
function validateAndPruneHorizontalGeometry(geo: THREE.BufferGeometry): boolean {
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!posAttr || posAttr.count < 3) return false;

  const indexAttr = geo.getIndex();
  const triCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(posAttr.count / 3);
  if (triCount === 0) return false;

  const validIndices: number[] = [];

  for (let f = 0; f < triCount; f++) {
    const i0 = indexAttr ? indexAttr.getX(f * 3) : f * 3;
    const i1 = indexAttr ? indexAttr.getX(f * 3 + 1) : f * 3 + 1;
    const i2 = indexAttr ? indexAttr.getX(f * 3 + 2) : f * 3 + 2;

    const x0 = posAttr.getX(i0);
    const y0 = posAttr.getY(i0);
    const z0 = posAttr.getZ(i0);
    const x1 = posAttr.getX(i1);
    const y1 = posAttr.getY(i1);
    const z1 = posAttr.getZ(i1);
    const x2 = posAttr.getX(i2);
    const y2 = posAttr.getY(i2);
    const z2 = posAttr.getZ(i2);

    if (
      !Number.isFinite(x0) ||
      !Number.isFinite(y0) ||
      !Number.isFinite(z0) ||
      !Number.isFinite(x1) ||
      !Number.isFinite(y1) ||
      !Number.isFinite(z1) ||
      !Number.isFinite(x2) ||
      !Number.isFinite(y2) ||
      !Number.isFinite(z2)
    ) {
      return false;
    }

    const ax = x1 - x0;
    const ay = y1 - y0;
    const az = z1 - z0;
    const bx = x2 - x0;
    const by = y2 - y0;
    const bz = z2 - z0;

    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    const doubleArea = Math.hypot(cx, cy, cz);
    const area = doubleArea * 0.5;

    if (!Number.isFinite(area) || area <= MIN_NONDEGENERATE_TRIANGLE_AREA_M2) {
      // Omit zero-area sliver triangle
      continue;
    }

    const ny = cy / doubleArea;
    if (ny <= 0.99) {
      // Never conceal an inverted or non-upward triangle by flipping normals or indices
      return false;
    }

    validIndices.push(i0, i1, i2);
  }

  if (validIndices.length < 3) {
    return false;
  }

  geo.setIndex(validIndices);

  const normAttr = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (!normAttr || normAttr.count !== posAttr.count) {
    const normals = new Float32Array(posAttr.count * 3);
    for (let i = 0; i < posAttr.count; i++) {
      normals[i * 3] = 0;
      normals[i * 3 + 1] = 1;
      normals[i * 3 + 2] = 0;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  } else {
    for (let i = 0; i < normAttr.count; i++) {
      normAttr.setXYZ(i, 0, 1, 0);
    }
  }

  return true;
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
 * at `nodeCenter` when their deflection angle, widths, and segment lengths permit a valid,
 * non-inverting shared portal join.
 *
 * Transactionally validates portal orientation and longitudinal overhang against both incident
 * edges before mutating `trimmedEndpoints`. Returns `false` if the join requires boundary-derived
 * corner trimming or safe fallback.
 */
function applyDegree2SharedContinuityPortal(
  b0: GraphBranchSpec,
  b1: GraphBranchSpec,
  nodeCenter: [number, number],
  trimmedEndpoints: Map<string, EdgeTrimState>
): boolean {
  if (b0.edge.id === b1.edge.id && b0.endpoint === b1.endpoint) {
    return false;
  }

  const dot = b0.dir[0] * b1.dir[0] + b0.dir[1] * b1.dir[1];
  // If interior angle between the two arms is acute (< ~95°, i.e. dot >= 0.08),
  // fall back to boundary-derived 2-branch corner trimming so the inner crotch never overlaps.
  if (dot >= 0.08) {
    return false;
  }

  // If the two arms have drastically different widths at a sharp bend, use boundary-derived beveling
  const widthRatio =
    Math.max(b0.width, b1.width) / Math.max(0.1, Math.min(b0.width, b1.width));
  if (widthRatio > 1.75 && dot > -0.85) {
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
  const miterScale = Math.min(1.25, 1.0 / Math.max(0.75, cosHalf));
  const avgHalfW = (b0.width + b1.width) * 0.25 * miterScale;
  const maxSafeHalfW = Math.min(b0.firstSegmentLength, b1.firstSegmentLength) * 0.75;
  const halfW = Math.min(avgHalfW, Math.max(avgHalfW * 0.5, maxSafeHalfW));

  const t0 = trimmedEndpoints.get(b0.edge.id);
  const t1 = trimmedEndpoints.get(b1.edge.id);
  if (!t0 || !t1) return false;

  // Check longitudinal overhang of the tilted miter portal into b0 and b1
  const overhang0 = Math.abs(nx * b0.dir[0] + nz * b0.dir[1]) * halfW;
  const overhang1 = Math.abs(nx * b1.dir[0] + nz * b1.dir[1]) * halfW;

  const otherTrim0 = b0.endpoint === 'start' ? t0.endTrimDist : t0.startTrimDist;
  const otherTrim1 = b1.endpoint === 'start' ? t1.endTrimDist : t1.startTrimDist;

  if (
    overhang0 > b0.firstSegmentLength * 0.65 ||
    overhang1 > b1.firstSegmentLength * 0.65 ||
    overhang0 + otherTrim0 > b0.totalEdgeLength * 0.75 ||
    overhang1 + otherTrim1 > b1.totalEdgeLength * 0.75
  ) {
    return false;
  }

  const sharedLeftOutB1: [number, number] = [
    nodeCenter[0] + nx * halfW,
    nodeCenter[1] + nz * halfW,
  ];
  const sharedRightOutB1: [number, number] = [
    nodeCenter[0] - nx * halfW,
    nodeCenter[1] - nz * halfW,
  ];

  // Verify positive lateral width along both b0 and b1 inward normals
  const n0x = -b0.dir[1];
  const n0z = b0.dir[0];
  const n1x = -b1.dir[1];
  const n1z = b1.dir[0];
  const latWidth0 =
    (sharedRightOutB1[0] - sharedLeftOutB1[0]) * n0x +
    (sharedRightOutB1[1] - sharedLeftOutB1[1]) * n0z;
  const latWidth1 =
    (sharedLeftOutB1[0] - sharedRightOutB1[0]) * n1x +
    (sharedLeftOutB1[1] - sharedRightOutB1[1]) * n1z;

  if (latWidth0 < b0.width * 0.25 || latWidth1 < b1.width * 0.25) {
    return false;
  }

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
 * Validates and triangulates a candidate junction polygon ring `[x, z][]` around `nodeCenter`.
 *
 * Enforces:
 * - Finite coordinates within `maxAllowedRadius` of `nodeCenter`.
 * - Minimum 3 unique non-collinear vertices (deduplicating consecutive vertices `< 1e-3 m` and
 *   folding spikes).
 * - Positive signed area `>= 0.05 m²` in ascending `atan2(z, x)` winding order around `nodeCenter`
 *   (preventing inside-out polygons).
 * - Zero self-intersections (`!hasRingSelfIntersection`).
 * - Clean earcut triangulation in `(x, -z)` 2D space producing `>= 1` non-degenerate upward-facing
 *   triangles (`crossY > 0`) and `0` inverted triangles.
 */
function validateAndTriangulateJunctionRing(
  rawPoints: [number, number][],
  nodeCenter: [number, number],
  maxAllowedRadius: number
): {
  polygonPoints: [number, number][];
  validatedTriangles: Array<[number, number, number]>;
} | null {
  if (!rawPoints || rawPoints.length < 3) return null;

  // 1. Deduplicate near-coincident consecutive vertices
  const deduped: [number, number][] = [];
  for (let i = 0; i < rawPoints.length; i++) {
    const pt = rawPoints[i];
    if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) return null;
    if (Math.hypot(pt[0] - nodeCenter[0], pt[1] - nodeCenter[1]) > maxAllowedRadius) {
      return null;
    }
    const prev =
      deduped.length > 0 ? deduped[deduped.length - 1] : rawPoints[rawPoints.length - 1];
    if (Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > 1e-3) {
      deduped.push([pt[0], pt[1]]);
    }
  }
  if (deduped.length < 3) return null;

  // 2. Reject any candidate ring containing a near-180-degree fold-back spike
  // rather than deleting portal vertices
  const polygonPoints = deduped;
  const n = polygonPoints.length;
  for (let i = 0; i < n; i++) {
    const prev = polygonPoints[(i - 1 + n) % n];
    const curr = polygonPoints[i];
    const next = polygonPoints[(i + 1) % n];
    const v1x = curr[0] - prev[0];
    const v1z = curr[1] - prev[1];
    const v2x = next[0] - curr[0];
    const v2z = next[1] - curr[1];
    const l1 = Math.hypot(v1x, v1z);
    const l2 = Math.hypot(v2x, v2z);
    if (l1 <= 1e-3 || l2 <= 1e-3) continue;
    const cosA = (v1x * v2x + v1z * v2z) / (l1 * l2);
    if (cosA < -0.992) {
      return null;
    }
  }

  // 3. Check closed ring self-intersection
  const closedRing: [number, number][] = [
    ...polygonPoints,
    [polygonPoints[0][0], polygonPoints[0][1]],
  ];
  if (hasRingSelfIntersection(closedRing)) {
    return null;
  }

  // 4. Verify positive signed area in ascending atan2(z, x) order (not inside-out)
  let signedArea2 = 0;
  for (let i = 0; i < polygonPoints.length; i++) {
    const p0 = polygonPoints[i];
    const p1 = polygonPoints[(i + 1) % polygonPoints.length];
    signedArea2 += p0[0] * p1[1] - p1[0] * p0[1];
  }
  const signedAreaXZ = signedArea2 * 0.5;
  if (!Number.isFinite(signedAreaXZ) || signedAreaXZ < 0.05) {
    return null;
  }

  // 5. Triangulate in 2D (x, z) space. Because signedAreaXZ > 0, contourXZ is 2D CCW
  // (!THREE.ShapeUtils.isClockWise(contourXZ)), and each 2D CCW triangle [i0, i1, i2]
  // maps to 3D +Y upward-facing triangle [i0, i2, i1] in right-handed (X, Y, Z) coordinates.
  const contourXZ = polygonPoints.map(([x, z]) => new THREE.Vector2(x, z));
  if (THREE.ShapeUtils.isClockWise(contourXZ)) {
    return null;
  }

  const earTriangles = THREE.ShapeUtils.triangulateShape(contourXZ, []);
  if (!earTriangles || earTriangles.length === 0) {
    return null;
  }

  const validatedTriangles: Array<[number, number, number]> = [];
  let triAreaSum = 0;

  for (const [e0, e1, e2] of earTriangles) {
    // Map 2D (x, z) CCW [e0, e1, e2] to 3D (X, Y, Z) +Y upward [e0, e2, e1]
    const i0 = e0;
    const i1 = e2;
    const i2 = e1;
    const p0 = polygonPoints[i0];
    const p1 = polygonPoints[i1];
    const p2 = polygonPoints[i2];
    if (!p0 || !p1 || !p2) return null;

    const ax = p1[0] - p0[0];
    const az = p1[1] - p0[1];
    const bx = p2[0] - p0[0];
    const bz = p2[1] - p0[1];
    // 3D cross product Y component: (v1 - v0) x (v2 - v0)
    const crossY = az * bx - ax * bz;
    const area = Math.abs(crossY) * 0.5;

    if (area <= MIN_NONDEGENERATE_TRIANGLE_AREA_M2) {
      // Omit collinear zero-area earcut sliver triangle
      continue;
    }
    if (crossY <= 0) {
      // Reject if any non-degenerate triangle is inverted
      return null;
    }

    validatedTriangles.push([i0, i1, i2]);
    triAreaSum += area;
  }

  if (
    validatedTriangles.length === 0 ||
    Math.abs(triAreaSum - signedAreaXZ) > Math.max(0.05, signedAreaXZ * 0.05)
  ) {
    return null;
  }

  return { polygonPoints, validatedTriangles };
}

/**
 * Computes boundary-derived branch portals and a validated, upward-triangulated junction polygon
 * around `nodeCenter` for a set of `>= 2` incident branches (`ADR-0002`, `ADR-0009`).
 *
 * Transactionally validates all branch portals, trim distances, polygon self-intersections,
 * and triangle orientations BEFORE committing any state to `trimmedEndpoints`.
 */
function solveBoundaryDerivedJunctionNode(
  nodeId: string,
  nodeCenter: [number, number],
  branches: GraphBranchSpec[],
  isPathJunction: boolean,
  trimmedEndpoints: Map<string, EdgeTrimState>,
  diagnostics?: ProcessedMapData['diagnostics']
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

  // Reject if two distinct branches enter along the exact same ray within < 1 degree
  for (let i = 0; i < k; i++) {
    const bA = sortedBranches[i];
    const bB = sortedBranches[(i + 1) % k];
    const dot = bA.dir[0] * bB.dir[0] + bA.dir[1] * bB.dir[1];
    const det = bA.dir[0] * bB.dir[1] - bA.dir[1] * bB.dir[0];
    if (dot > 0.9998 && Math.abs(det) < 0.02) {
      recordGraphRoadDiagnostic(
        diagnostics,
        'junction_degenerate_overlapping_arms',
        nodeId
      );
      return null;
    }
  }

  const branchNormals: [number, number][] = sortedBranches.map((bBranch) => [
    -bBranch.dir[1],
    bBranch.dir[0],
  ]);

  const maxTrimDists: number[] = sortedBranches.map((bBranch) => {
    const tRec = trimmedEndpoints.get(bBranch.edge.id);
    const existingOtherTrim = tRec
      ? bBranch.endpoint === 'start'
        ? tRec.endTrimDist
        : tRec.startTrimDist
      : 0;
    const isSelfLoop = bBranch.edge.fromNodeId === bBranch.edge.toNodeId;
    const maxByFirstSeg = Math.max(0.12, bBranch.firstSegmentLength * 0.80);
    const maxByTotalRatio = Math.max(
      0.12,
      bBranch.totalEdgeLength * (isSelfLoop ? 0.35 : 0.45)
    );
    const remainingBudget = Math.max(
      0.12,
      (bBranch.totalEdgeLength - existingOtherTrim - 0.20) * (isSelfLoop ? 0.45 : 0.80)
    );
    return Math.min(maxByFirstSeg, maxByTotalRatio, remainingBudget);
  });

  const corners: [number, number][] = [];
  const innerCornerTA: number[] = new Array(k).fill(0);
  const innerCornerTB: number[] = new Array(k).fill(0);
  const isConvexInnerCorner: boolean[] = new Array(k).fill(false);
  const wasInnerCornerClamped: boolean[] = new Array(k).fill(false);
  const hasExplicitCornerVertex: boolean[] = new Array(k).fill(false);

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

    if (Math.abs(det) > 0.06) {
      const dx = pB[0] - pA[0];
      const dz = pB[1] - pA[1];
      const tA = (dx * dB[1] - dz * dB[0]) / det;
      const tB = (dx * dA[1] - dz * dA[0]) / det;

      if (det > 0 && tA > 0 && tB > 0) {
        // Case 1: Convex inner crotch between adjacent branches bA and bB
        isConvexInnerCorner[i] = true;
        hasExplicitCornerVertex[i] = true;
        innerCornerTA[i] = tA;
        innerCornerTB[i] = tB;
        const clampedTA = Math.min(tA, maxTrimDists[i]);
        const clampedTB = Math.min(tB, maxTrimDists[next]);
        if (clampedTA === tA && clampedTB === tB) {
          cornerX = pA[0] + tA * dA[0];
          cornerZ = pA[1] + tA * dA[1];
        } else {
          wasInnerCornerClamped[i] = true;
          const cAx = pA[0] + clampedTA * dA[0];
          const cAz = pA[1] + clampedTA * dA[1];
          const cBx = pB[0] + clampedTB * dB[0];
          const cBz = pB[1] + clampedTB * dB[1];
          cornerX = (cAx + cBx) * 0.5;
          cornerZ = (cAz + cBz) * 0.5;
        }
      } else if (det < 0 && tA <= 0 && tB <= 0) {
        // Case 2: True reflex outer corner (angle between bA and bB > 180 degrees)
        hasExplicitCornerVertex[i] = true;
        cornerX = pA[0] + tA * dA[0];
        cornerZ = pA[1] + tA * dA[1];
        const cDist = Math.hypot(cornerX - nodeCenter[0], cornerZ - nodeCenter[1]);
        const maxOuterDist = 1.25 * Math.max(bA.width, bB.width);
        if (cDist > maxOuterDist && cDist > 1e-4) {
          const scale = maxOuterDist / cDist;
          cornerX = nodeCenter[0] + (cornerX - nodeCenter[0]) * scale;
          cornerZ = nodeCenter[1] + (cornerZ - nodeCenter[1]) * scale;
        }
      } else {
        // Case 3: Near-180-degree or obtuse unequal-width transition (tA and tB have opposite signs):
        // Connect portals[i].left directly to portals[next].right without an intermediate spike vertex.
        cornerX = (pA[0] + pB[0]) * 0.5;
        cornerZ = (pA[1] + pB[1]) * 0.5;
      }
    } else {
      // Collinear / antiparallel curb transition
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

  // Save orthogonal un-snapped portals in case we need a clean portal-only fallback
  const orthogonalPortals = portals.map((p) => ({
    left: [p.left[0], p.left[1]] as [number, number],
    right: [p.right[0], p.right[1]] as [number, number],
    center: [p.center[0], p.center[1]] as [number, number],
  }));

  // Snap inner corners where adjacent portals meet or overlap angularly
  for (let i = 0; i < k; i++) {
    const next = (i + 1) % k;
    const bA = sortedBranches[i];
    const bB = sortedBranches[next];
    const nA = branchNormals[i];
    const nB = branchNormals[next];

    const vLeftX = portals[i].left[0] - nodeCenter[0];
    const vLeftZ = portals[i].left[1] - nodeCenter[1];
    const vRightX = portals[next].right[0] - nodeCenter[0];
    const vRightZ = portals[next].right[1] - nodeCenter[1];
    // In ascending atan2(z, x) order, if vLeft x vRight < 0, portals[i].left has crossed past portals[next].right
    const portalsCrossedAngularly = vLeftX * vRightZ - vLeftZ * vRightX < -1e-4;

    if (wasInnerCornerClamped[i] || portalsCrossedAngularly) {
      // Partition the outer span [portals[i].right -> portals[next].left] proportionally to branch widths
      // so both portals remain strictly positive in width and share a non-crossing inner seam vertex.
      const rA = portals[i].right;
      const lB = portals[next].left;
      const alpha = bA.width / Math.max(1e-3, bA.width + bB.width);
      const seamPt: [number, number] = [
        rA[0] + alpha * (lB[0] - rA[0]),
        rA[1] + alpha * (lB[1] - rA[1]),
      ];
      const widthA = (seamPt[0] - rA[0]) * nA[0] + (seamPt[1] - rA[1]) * nA[1];
      const widthB = (lB[0] - seamPt[0]) * nB[0] + (lB[1] - seamPt[1]) * nB[1];
      if (widthA >= bA.width * 0.20 && widthB >= bB.width * 0.20) {
        corners[i] = seamPt;
        portals[i].left = [seamPt[0], seamPt[1]];
        portals[next].right = [seamPt[0], seamPt[1]];
      }
    } else if (isConvexInnerCorner[i]) {
      const cPt = corners[i];
      if (innerCornerTA[i] >= trimDists[i] - 0.05) {
        const widthA =
          (cPt[0] - portals[i].right[0]) * nA[0] +
          (cPt[1] - portals[i].right[1]) * nA[1];
        if (widthA >= bA.width * 0.25) {
          portals[i].left = [cPt[0], cPt[1]];
        }
      }
      if (innerCornerTB[i] >= trimDists[next] - 0.05) {
        const widthB =
          (portals[next].left[0] - cPt[0]) * nB[0] +
          (portals[next].left[1] - cPt[1]) * nB[1];
        if (widthB >= bB.width * 0.25) {
          portals[next].right = [cPt[0], cPt[1]];
        }
      }
    }
  }

  // Validate that no edge's startTrimDist + endTrimDist exceeds available edge length
  const trimSumByEdgeId = new Map<string, number>();
  for (let i = 0; i < k; i++) {
    const bBranch = sortedBranches[i];
    const tRec = trimmedEndpoints.get(bBranch.edge.id);
    if (!tRec) return null;
    const prevSum =
      trimSumByEdgeId.get(bBranch.edge.id) ??
      (bBranch.endpoint === 'start' ? tRec.endTrimDist : tRec.startTrimDist);
    const nextSum = prevSum + trimDists[i];
    if (nextSum > bBranch.totalEdgeLength - 0.08) {
      recordGraphRoadDiagnostic(
        diagnostics,
        'junction_short_edge_portal_crossover',
        nodeId
      );
      return null;
    }
    trimSumByEdgeId.set(bBranch.edge.id, nextSum);
  }

  // Validate portal widths on all branches
  const portalsHaveValidWidths = (
    candidatePortals: Array<{
      left: [number, number];
      right: [number, number];
      center: [number, number];
    }>
  ): boolean => {
    for (let i = 0; i < k; i++) {
      const p = candidatePortals[i];
      const n = branchNormals[i];
      const bBranch = sortedBranches[i];
      const w = (p.left[0] - p.right[0]) * n[0] + (p.left[1] - p.right[1]) * n[1];
      if (!Number.isFinite(w) || w < bBranch.width * 0.20) {
        return false;
      }
    }
    return true;
  };

  const maxBranchWidth = Math.max(...sortedBranches.map((b) => b.width));
  const maxTrim = Math.max(...trimDists);
  const maxAllowedRadius = maxBranchWidth * 2.5 + maxTrim * 1.5 + 1.0;

  // Build candidate 1: boundary-derived ring including explicit inner/reflex corner vertices
  const rawCandidate1: [number, number][] = [];
  for (let i = 0; i < k; i++) {
    rawCandidate1.push(portals[i].right);
    rawCandidate1.push(portals[i].left);
    if (hasExplicitCornerVertex[i]) {
      rawCandidate1.push(corners[i]);
    }
  }

  let activePortals = portals;
  let validated = portalsHaveValidWidths(portals)
    ? validateAndTriangulateJunctionRing(rawCandidate1, nodeCenter, maxAllowedRadius)
    : null;

  // Candidate 2 fallback: direct portal-to-portal boundary with snapped portals (omitting intermediate corners)
  if (!validated && portalsHaveValidWidths(portals)) {
    const rawCandidate2: [number, number][] = [];
    for (let i = 0; i < k; i++) {
      rawCandidate2.push(portals[i].right);
      rawCandidate2.push(portals[i].left);
    }
    validated = validateAndTriangulateJunctionRing(
      rawCandidate2,
      nodeCenter,
      maxAllowedRadius
    );
  }

  // Candidate 3 fallback: orthogonal un-snapped portals
  if (!validated && portalsHaveValidWidths(orthogonalPortals)) {
    const rawCandidate3: [number, number][] = [];
    for (let i = 0; i < k; i++) {
      rawCandidate3.push(orthogonalPortals[i].right);
      rawCandidate3.push(orthogonalPortals[i].left);
    }
    validated = validateAndTriangulateJunctionRing(
      rawCandidate3,
      nodeCenter,
      maxAllowedRadius
    );
    if (validated) {
      activePortals = orthogonalPortals;
    }
  }

  if (!validated) {
    recordGraphRoadDiagnostic(
      diagnostics,
      'junction_polygon_validation_failed',
      nodeId
    );
    return null;
  }

  // Transactionally commit endpoint trim state ONLY after polygon & portal validation succeeded!
  for (let i = 0; i < k; i++) {
    const bBranch = sortedBranches[i];
    const trimDist = trimDists[i];
    const { left: leftPortal, right: rightPortal, center: centerPortal } = activePortals[i];
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
    polygonPoints: validated.polygonPoints,
    validatedTriangles: validated.validatedTriangles,
    sortedBranches,
    portals: activePortals,
    dominantBranch,
  };
}

/**
 * Sanitizes a sub-segment centerline polyline and its optional `startPortal` / `endPortal`
 * so interior polyline vertices never fall behind a skewed portal corner and endpoint portals
 * never invert relative to the first/last segment tangent.
 */
function sanitizeSubSegmentPolylineAndPortals(
  rawPoints: [number, number][],
  width: number,
  rawStartPortal?: { left: [number, number]; right: [number, number] },
  rawEndPortal?: { left: [number, number]; right: [number, number] },
  diagnostics?: ProcessedMapData['diagnostics'],
  subId: string = ''
): {
  points: [number, number][];
  startPortal?: { left: [number, number]; right: [number, number] };
  endPortal?: { left: [number, number]; right: [number, number] };
} {
  const pts: [number, number][] = [];
  for (let i = 0; i < rawPoints.length; i++) {
    const pt = rawPoints[i];
    if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    if (pts.length === 0) {
      pts.push([pt[0], pt[1]]);
    } else {
      const prev = pts[pts.length - 1];
      if (Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > 0.02) {
        pts.push([pt[0], pt[1]]);
      } else if (i === rawPoints.length - 1 && pts.length >= 2) {
        pts[pts.length - 1] = [pt[0], pt[1]];
      }
    }
  }

  if (pts.length < 2) {
    return { points: pts };
  }

  let startPortal = rawStartPortal
    ? {
        left: [rawStartPortal.left[0], rawStartPortal.left[1]] as [number, number],
        right: [rawStartPortal.right[0], rawStartPortal.right[1]] as [number, number],
      }
    : undefined;
  let endPortal = rawEndPortal
    ? {
        left: [rawEndPortal.left[0], rawEndPortal.left[1]] as [number, number],
        right: [rawEndPortal.right[0], rawEndPortal.right[1]] as [number, number],
      }
    : undefined;

  // Prune interior vertices near start that lie inside the longitudinal overhang of startPortal
  if (startPortal && pts.length > 2) {
    while (pts.length > 2) {
      const p0 = pts[0];
      const p1 = pts[1];
      const dx = p1[0] - p0[0];
      const dz = p1[1] - p0[1];
      const segLen = Math.hypot(dx, dz);
      if (segLen < 1e-4) {
        pts.splice(1, 1);
        continue;
      }
      const tx = dx / segLen;
      const tz = dz / segLen;
      const projL = (startPortal.left[0] - p0[0]) * tx + (startPortal.left[1] - p0[1]) * tz;
      const projR = (startPortal.right[0] - p0[0]) * tx + (startPortal.right[1] - p0[1]) * tz;
      const maxOverhang = Math.max(0, projL, projR);
      if (segLen <= maxOverhang + width * 0.25) {
        pts.splice(1, 1);
      } else {
        break;
      }
    }
  }

  // Prune interior vertices near end that lie inside the longitudinal overhang of endPortal
  if (endPortal && pts.length > 2) {
    while (pts.length > 2) {
      const last = pts.length - 1;
      const pn = pts[last];
      const pPrev = pts[last - 1];
      const dx = pn[0] - pPrev[0];
      const dz = pn[1] - pPrev[1];
      const segLen = Math.hypot(dx, dz);
      if (segLen < 1e-4) {
        pts.splice(last - 1, 1);
        continue;
      }
      const tx = dx / segLen;
      const tz = dz / segLen;
      const projL = (pn[0] - endPortal.left[0]) * tx + (pn[1] - endPortal.left[1]) * tz;
      const projR = (pn[0] - endPortal.right[0]) * tx + (pn[1] - endPortal.right[1]) * tz;
      const maxOverhang = Math.max(0, projL, projR);
      if (segLen <= maxOverhang + width * 0.25) {
        pts.splice(last - 1, 1);
      } else {
        break;
      }
    }
  }

  // Validate startPortal orientation against actual first segment tangent
  if (startPortal && pts.length >= 2) {
    const dx = pts[1][0] - pts[0][0];
    const dz = pts[1][1] - pts[0][1];
    const segLen = Math.hypot(dx, dz) || 1e-6;
    const tx = dx / segLen;
    const tz = dz / segLen;
    const nx = -tz;
    const nz = tx;
    const latWidth =
      (startPortal.left[0] - startPortal.right[0]) * nx +
      (startPortal.left[1] - startPortal.right[1]) * nz;
    const projL = (startPortal.left[0] - pts[0][0]) * tx + (startPortal.left[1] - pts[0][1]) * tz;
    const projR =
      (startPortal.right[0] - pts[0][0]) * tx + (startPortal.right[1] - pts[0][1]) * tz;
    if (latWidth < width * 0.15 || Math.max(projL, projR) >= segLen * 0.85) {
      startPortal = undefined;
      recordGraphRoadDiagnostic(
        diagnostics,
        'ribbon_start_portal_fallback_orthogonal',
        subId
      );
    }
  }

  // Validate endPortal orientation against actual last segment tangent
  if (endPortal && pts.length >= 2) {
    const last = pts.length - 1;
    const dx = pts[last][0] - pts[last - 1][0];
    const dz = pts[last][1] - pts[last - 1][1];
    const segLen = Math.hypot(dx, dz) || 1e-6;
    const tx = dx / segLen;
    const tz = dz / segLen;
    const nx = -tz;
    const nz = tx;
    const latWidth =
      (endPortal.left[0] - endPortal.right[0]) * nx +
      (endPortal.left[1] - endPortal.right[1]) * nz;
    const projL =
      (pts[last][0] - endPortal.left[0]) * tx + (pts[last][1] - endPortal.left[1]) * tz;
    const projR =
      (pts[last][0] - endPortal.right[0]) * tx + (pts[last][1] - endPortal.right[1]) * tz;
    if (latWidth < width * 0.15 || Math.max(projL, projR) >= segLen * 0.85) {
      endPortal = undefined;
      recordGraphRoadDiagnostic(
        diagnostics,
        'ribbon_end_portal_fallback_orthogonal',
        subId
      );
    }
  }

  // On a 2-point segment with both startPortal and endPortal, verify the left and right edges advance forward
  if (startPortal && endPortal && pts.length === 2) {
    const dx = pts[1][0] - pts[0][0];
    const dz = pts[1][1] - pts[0][1];
    const segLen = Math.hypot(dx, dz) || 1e-6;
    const tx = dx / segLen;
    const tz = dz / segLen;
    const leftAdvance =
      (endPortal.left[0] - startPortal.left[0]) * tx +
      (endPortal.left[1] - startPortal.left[1]) * tz;
    const rightAdvance =
      (endPortal.right[0] - startPortal.right[0]) * tx +
      (endPortal.right[1] - startPortal.right[1]) * tz;
    if (leftAdvance <= 0.05 || rightAdvance <= 0.05) {
      startPortal = undefined;
      endPortal = undefined;
      recordGraphRoadDiagnostic(
        diagnostics,
        'ribbon_short_segment_portal_crossover_fallback',
        subId
      );
    }
  }

  return { points: pts, startPortal, endPortal };
}

/**
 * Builds a closed 2D polygon ring `[x, z][][]` around a road/path centerline polyline,
 * including semicircular start and end cap arcs when `hasStartCap` or `hasEndCap` is active.
 * Ensures 2D Boolean clipping footprints match the exact 3D rendered ribbon geometry.
 */
function buildGraphRibbonPolygonRing(
  points: [number, number][],
  width: number,
  options?: {
    hasStartCap?: boolean;
    hasEndCap?: boolean;
    startPortal?: { left: [number, number]; right: [number, number] };
    endPortal?: { left: [number, number]; right: [number, number] };
  }
): [number, number][][] | null {
  if (!options?.hasStartCap && !options?.hasEndCap) {
    return buildRoadRibbonOutlineRing(points, width, {
      startPortal: options?.startPortal,
      endPortal: options?.endPortal,
    });
  }

  const ribbon = generateRoadRibbon(points, width, 0, {
    roundCaps: false,
    startPortal: options?.startPortal,
    endPortal: options?.endPortal,
  });
  if (!ribbon) return null;
  const pos = ribbon.positions;
  const n = pos.length / 6;
  if (n < 2) return null;

  const halfW = width * 0.5;
  const capSegments = 6;
  const ring: [number, number][] = [];

  for (let i = 0; i < n; i++) {
    const lIdx = i * 2;
    const x = pos[lIdx * 3];
    const z = pos[lIdx * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    ring.push([snapCoord(x), snapCoord(z)]);
  }

  // Append end semicircle cap from leftEnd to rightEnd when hasEndCap && !endPortal
  if (options?.hasEndCap && !options?.endPortal && points.length >= 2) {
    const pn = points[points.length - 1];
    const pPrev = points[points.length - 2];
    const dx = pn[0] - pPrev[0];
    const dz = pn[1] - pPrev[1];
    const len = Math.hypot(dx, dz) || 1e-6;
    const tnx = dx / len;
    const tnz = dz / len;
    const nnx = -tnz;
    const nnz = tnx;
    for (let k = capSegments - 1; k >= 1; k--) {
      const angle = -Math.PI / 2 + (k / capSegments) * Math.PI;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const vx = cosA * tnx + sinA * nnx;
      const vz = cosA * tnz + sinA * nnz;
      ring.push([snapCoord(pn[0] + vx * halfW), snapCoord(pn[1] + vz * halfW)]);
    }
  }

  for (let i = n - 1; i >= 0; i--) {
    const rIdx = i * 2 + 1;
    const x = pos[rIdx * 3];
    const z = pos[rIdx * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    ring.push([snapCoord(x), snapCoord(z)]);
  }

  // Append start semicircle cap from rightStart to leftStart when hasStartCap && !startPortal
  if (options?.hasStartCap && !options?.startPortal && points.length >= 2) {
    const p0 = points[0];
    const p1 = points[1];
    const dx = p1[0] - p0[0];
    const dz = p1[1] - p0[1];
    const len = Math.hypot(dx, dz) || 1e-6;
    const t0x = dx / len;
    const t0z = dz / len;
    const n0x = -t0z;
    const n0z = t0x;
    for (let k = capSegments - 1; k >= 1; k--) {
      const angle = Math.PI / 2 + (k / capSegments) * Math.PI;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const vx = cosA * t0x + sinA * n0x;
      const vz = cosA * t0z + sinA * n0z;
      ring.push([snapCoord(p0[0] + vx * halfW), snapCoord(p0[1] + vz * halfW)]);
    }
  }

  if (ring.length < 3) return null;
  ring.push([ring[0][0], ring[0][1]]);
  return [ring];
}

/**
 * Generates horizontal raised step-tread quads along a `highway=steps` polyline
 * with strictly upward (+Y) counter-clockwise triangle winding (`cross(v1 - v0, v2 - v0) = +Y`).
 */
function generateGraphStepTreads(
  points: [number, number][],
  width: number,
  yElev: number
): THREE.BufferGeometry | null {
  if (!points || points.length < 2) return null;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const halfW = width * 0.44;
  const halfTread = 0.11;
  const stepSpacing = 0.65;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const dx = p1[0] - p0[0];
    const dz = p1[1] - p0[1];
    const segLen = Math.hypot(dx, dz);
    if (segLen < 0.4) continue;
    const tx = dx / segLen;
    const tz = dz / segLen;
    const nx = -tz;
    const nz = tx;

    for (let d = 0.35; d < segLen - 0.25; d += stepSpacing) {
      const cx = p0[0] + tx * d;
      const cz = p0[1] + tz * d;

      // Quad corners around tread center (cx, cz) in CCW order when viewed from +Y:
      // v0: back-left, v1: front-left, v2: front-right, v3: back-right
      const v0x = cx - tx * halfTread + nx * halfW;
      const v0z = cz - tz * halfTread + nz * halfW;
      const v1x = cx + tx * halfTread + nx * halfW;
      const v1z = cz + tz * halfTread + nz * halfW;
      const v2x = cx + tx * halfTread - nx * halfW;
      const v2z = cz + tz * halfTread - nz * halfW;
      const v3x = cx - tx * halfTread - nx * halfW;
      const v3z = cz - tz * halfTread - nz * halfW;

      const vBase = positions.length / 3;
      positions.push(
        v0x, yElev, v0z,
        v1x, yElev, v1z,
        v2x, yElev, v2z,
        v3x, yElev, v3z
      );
      for (let k = 0; k < 4; k++) normals.push(0, 1, 0);
      // Triangle 1: (v0, v1, v3), Triangle 2: (v3, v1, v2) -> both have +Y normal!
      indices.push(vBase, vBase + 1, vBase + 3, vBase + 3, vBase + 1, vBase + 2);
    }
  }

  if (indices.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
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

  // 1. Filter at-grade buildable road edges and initialize endpoint trim states
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
    const isPath = edge.tier === 'path' || isNonVehicularRoadClass(edge.roadClass);

    // Authoritative graph-backed grade-transition cap suppression:
    // Only suppress an endpoint cap when the edge or its topological node has an explicit
    // grade transition or connects to a non-at-grade (bridge/tunnel) road edge at that node.
    // Nearby but unconnected road endpoints near a bridge or tunnel keep their dead-end caps.
    const touchesGradeTransitionStart =
      Boolean(edge.startGradeTransitionId) ||
      Boolean(startNode && startNode.gradeTransitionIds.length > 0) ||
      Boolean(
        startNode &&
          startNode.incidentEdgeIds.some((id) => {
            const other = descriptors.roadEdgesById.get(id);
            return Boolean(other && !other.isAtGradeBuildable);
          })
      );

    const touchesGradeTransitionEnd =
      Boolean(edge.endGradeTransitionId) ||
      Boolean(endNode && endNode.gradeTransitionIds.length > 0) ||
      Boolean(
        endNode &&
          endNode.incidentEdgeIds.some((id) => {
            const other = descriptors.roadEdgesById.get(id);
            return Boolean(other && !other.isAtGradeBuildable);
          })
      );

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

  // Helper to build deduplicated GraphBranchSpec objects from a node's incident half-edges
  const collectBuildableBranches = (
    node: RoadNodeRenderDescriptor,
    halfEdges: readonly IncidentHalfEdge[]
  ): GraphBranchSpec[] => {
    const out: GraphBranchSpec[] = [];
    const seenHalfEdges = new Set<string>();
    for (const he of halfEdges) {
      const heKey = `${he.edgeId}:${he.endpoint}`;
      if (seenHalfEdges.has(heKey)) continue;
      seenHalfEdges.add(heKey);

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
      const firstSegLen = Math.max(
        0.05,
        Math.hypot(adjacentPt[0] - endpointPt[0], adjacentPt[1] - endpointPt[1])
      );
      out.push({
        edge,
        endpoint: he.endpoint,
        dir,
        nodePos: [node.position[0], node.position[1]],
        width: edge.width * roadWidthMultiplier,
        roadClass: edge.roadClass,
        firstSegmentLength: firstSegLen,
        totalEdgeLength: totalPolyLen,
        segmentLength: Math.min(firstSegLen, totalPolyLen),
      });
    }
    return out;
  };

  // 2. Process topological road nodes in canonical order
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
          trimmedEndpoints,
          diagnostics
        );
        if (solved) {
          pendingJunctions.push(solved);
          stats.branchingJunctionCount++;
        } else {
          stats.rejectedOrDegenerateCount++;
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
            trimmedEndpoints,
            diagnostics
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
            trimmedEndpoints,
            diagnostics
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
            trimmedEndpoints,
            diagnostics
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
          trimmedEndpoints,
          diagnostics
        );
        if (solved) {
          pendingJunctions.push(solved);
          stats.pathJunctionCount++;
        } else {
          stats.rejectedOrDegenerateCount++;
        }
      }
    }
  }

  // 3. Resolve trimmed polylines and per-segment provenance sub-ribbons for all buildable edges
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
      const miterScale = Math.min(1.25, 1.0 / Math.max(0.76, cosHalf));
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
      const rawStartPortal =
        j === 0
          ? tInfo.startPortal
            ? { left: tInfo.startPortal.left, right: tInfo.startPortal.right }
            : undefined
          : internalPortals[j - 1];
      const rawEndPortal =
        j === m - 1
          ? tInfo.endPortal
            ? { left: tInfo.endPortal.left, right: tInfo.endPortal.right }
            : undefined
          : internalPortals[j];

      const sanitized = sanitizeSubSegmentPolylineAndPortals(
        subPolylines[j],
        width,
        rawStartPortal,
        rawEndPortal,
        diagnostics,
        subId
      );

      const exemptIds = new Set<string>(tInfo.exemptFootprintIds);
      if (j > 0) exemptIds.add(`${edge.id}#seg${j - 1}`);
      if (j < m - 1) exemptIds.add(`${edge.id}#seg${j + 1}`);

      subSegments.push({
        subId,
        edge,
        seg,
        points: sanitized.points,
        width,
        roadElevation,
        isPath,
        hasCapStart: j === 0 ? tInfo.hasCapStart : false,
        hasCapEnd: j === m - 1 ? tInfo.hasCapEnd : false,
        startPortal: sanitized.startPortal,
        endPortal: sanitized.endPortal,
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

  // 4. Track 2D polygon footprints of placed junctions and road ribbons for Boolean clipping
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

  // 5. Emit pre-validated, upward-wound junction polygon geometries
  const junctionGeometriesByClass = new Map<
    RoadClass,
    Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }>
  >();

  for (const junc of pendingJunctions) {
    const {
      junctionFeatureId,
      isPathJunction,
      polygonPoints,
      validatedTriangles,
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

    const junctionVertices: number[] = [];
    const junctionIndices: number[] = [];
    const junctionNormals: number[] = [];

    for (let pIdx = 0; pIdx < polygonPoints.length; pIdx++) {
      junctionVertices.push(polygonPoints[pIdx][0], yElev, polygonPoints[pIdx][1]);
      junctionNormals.push(0, 1, 0);
    }

    for (const [i0, i1, i2] of validatedTriangles) {
      junctionIndices.push(i0, i1, i2);
    }

    if (junctionIndices.length > 0) {
      const junctionGeo = new THREE.BufferGeometry();
      junctionGeo.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(junctionVertices, 3)
      );
      junctionGeo.setAttribute(
        'normal',
        new THREE.Float32BufferAttribute(junctionNormals, 3)
      );
      junctionGeo.setIndex(junctionIndices);

      if (validateAndPruneHorizontalGeometry(junctionGeo)) {
        resourceManager.registerGeometry(junctionGeo);
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
      } else {
        junctionGeo.dispose();
        stats.rejectedOrDegenerateCount++;
      }
    }
  }

  // 6. Build trimmed road ribbons (vehicular edges first, then path-tier edges so paths clip against carriageways)
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
        if (pts.length < 2) {
          stats.rejectedOrDegenerateCount++;
          continue;
        }
        const { width, roadElevation, isPath, sourceFeatureIds: sids } = sub;
        let activeStartPortal = sub.startPortal;
        let activeEndPortal = sub.endPortal;

        const isClosedSubLoop =
          pts.length >= 4 &&
          Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <
            0.05;

        let outlinePoly = isClosedSubLoop
          ? null
          : buildGraphRibbonPolygonRing(pts, width, {
              hasStartCap: sub.hasCapStart,
              hasEndCap: sub.hasCapEnd,
              startPortal: activeStartPortal,
              endPortal: activeEndPortal,
            });

        // If skewed portals caused the outline ring to self-intersect, relax back to orthogonal portals
        if (
          !isClosedSubLoop &&
          (activeStartPortal || activeEndPortal) &&
          (!outlinePoly || !outlinePoly[0] || hasRingSelfIntersection(outlinePoly[0]))
        ) {
          const orthoOutline = buildGraphRibbonPolygonRing(pts, width, {
            hasStartCap: sub.hasCapStart,
            hasEndCap: sub.hasCapEnd,
          });
          if (orthoOutline && orthoOutline[0] && !hasRingSelfIntersection(orthoOutline[0])) {
            activeStartPortal = undefined;
            activeEndPortal = undefined;
            outlinePoly = orthoOutline;
            recordGraphRoadDiagnostic(
              diagnostics,
              'ribbon_skewed_portal_self_intersection_fallback',
              sub.subId
            );
          }
        }

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
                  if (validateAndPruneHorizontalGeometry(shapeGeo)) {
                    geom = resourceManager.registerGeometry(shapeGeo);
                  } else {
                    shapeGeo.dispose();
                    stats.rejectedOrDegenerateCount++;
                    continue;
                  }
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
                  recordGraphRoadDiagnostic(
                    diagnostics,
                    'path_boolean_clipping_failed',
                    sids[0]
                  );
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
                    if (validateAndPruneHorizontalGeometry(g)) {
                      subGeos.push(g);
                      registerRoadFootprint(sub.subId, isPath, subOutline[0]);
                    } else {
                      g.dispose();
                    }
                  }
                }
                if (subGeos.length > 0) {
                  const mergedSafe = mergeGeometries(subGeos, false);
                  for (const sg of subGeos) sg.dispose();
                  if (mergedSafe && validateAndPruneHorizontalGeometry(mergedSafe)) {
                    geom = resourceManager.registerGeometry(mergedSafe);
                  } else if (mergedSafe) {
                    mergedSafe.dispose();
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
            activeStartPortal = undefined;
            activeEndPortal = undefined;
            outlinePoly = cleanedOutline;
          }

          const buildValidatedRibbonGeometry = (
            rPts: [number, number][],
            opts: RoadRibbonOptions
          ): THREE.BufferGeometry | null => {
            const ribbon = generateRoadRibbon(rPts, width, roadElevation, opts);
            if (!ribbon) return null;
            const candidateGeo = new THREE.BufferGeometry();
            candidateGeo.setAttribute('position', new THREE.BufferAttribute(ribbon.positions, 3));
            candidateGeo.setAttribute('normal', new THREE.BufferAttribute(ribbon.normals, 3));
            candidateGeo.setIndex(new THREE.BufferAttribute(ribbon.indices, 1));
            if (validateAndPruneHorizontalGeometry(candidateGeo)) {
              return candidateGeo;
            }
            candidateGeo.dispose();
            return null;
          };

          let candidateGeo = buildValidatedRibbonGeometry(pts, {
            roundCaps: !isClosedSubLoop,
            hasStartCap: sub.hasCapStart,
            hasEndCap: sub.hasCapEnd,
            startPortal: activeStartPortal,
            endPortal: activeEndPortal,
          });

          // If skewed portals caused a pinched/inverted quad on a short segment, fall back to orthogonal portals
          if (!candidateGeo && (activeStartPortal || activeEndPortal)) {
            activeStartPortal = undefined;
            activeEndPortal = undefined;
            recordGraphRoadDiagnostic(
              diagnostics,
              'ribbon_inverted_portal_quad_fallback',
              sub.subId
            );
            candidateGeo = buildValidatedRibbonGeometry(pts, {
              roundCaps: !isClosedSubLoop,
              hasStartCap: sub.hasCapStart,
              hasEndCap: sub.hasCapEnd,
            });
          }

          // If tight interior vertices still caused a self-fold, clean the polyline and retry
          if (!candidateGeo) {
            const cleanedPts = cleanPolylineForClipping(pts);
            if (cleanedPts.length >= 2) {
              recordGraphRoadDiagnostic(
                diagnostics,
                'ribbon_tight_bend_cleaned_fallback',
                sub.subId
              );
              candidateGeo = buildValidatedRibbonGeometry(cleanedPts, {
                roundCaps: !isClosedSubLoop,
                hasStartCap: sub.hasCapStart,
                hasEndCap: sub.hasCapEnd,
              });
              if (candidateGeo) {
                pts = cleanedPts;
              }
            }
          }

          if (!candidateGeo) {
            stats.rejectedOrDegenerateCount++;
            recordGraphRoadDiagnostic(
              diagnostics,
              'ribbon_unrecoverable_inversion_rejected',
              sub.subId
            );
            continue;
          }

          geom = resourceManager.registerGeometry(candidateGeo);
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
              startPortal: activeStartPortal,
            });
            const half2 = buildRoadRibbonOutlineRing(pts.slice(midIdx), width, {
              endPortal: activeEndPortal,
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
          const treadGeo = generateGraphStepTreads(
            pts,
            width,
            roadElevation + ELEVATION_POLICY.STEP_TREAD_OFFSET
          );
          if (treadGeo) {
            if (validateAndPruneHorizontalGeometry(treadGeo)) {
              resourceManager.registerGeometry(treadGeo);
              roadsByClass.get(edge.roadClass)!.push({ geom: treadGeo, info: roadInfo });
            } else {
              treadGeo.dispose();
            }
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

  // 7. Append junction geometries into their corresponding road class buckets
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
