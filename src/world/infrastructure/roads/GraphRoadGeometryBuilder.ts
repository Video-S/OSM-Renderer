import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import polygonClipping from 'polygon-clipping';
import { proposeRoundedPathJunctionOutline } from './PathJunctionCornerSmoothing';
import {
  bufferSurfaceFirstRoadCenterline,
  resolveInternalProvenanceBoundaryCaps,
  type SurfaceFirstBufferInstrumentation,
} from './SurfaceFirstRoadFootprints';
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
import { computePolylineLength } from '../../BridgeAndTunnelBuilder';
import {
  COORDINATE_SNAP_QUANTUM,
  MultiPolygonCoords,
  computeMultiPolygonArea,
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
  busway: 9,
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
 * High-resolution wall-clock timing breakdown (`ms`) for at-grade road geometry generation.
 * Stored separately from `GraphRoadRenderStats` so deterministic counter snapshots remain
 * bit-for-bit identical across runs.
 */
export interface GraphRoadGenerationTiming {
  /** Total wall-clock time (`ms`) spent inside `buildGraphAtGradeRoadGeometries`. */
  totalRoadGenerationTimeMs: number;
  /** Wall-clock time (`ms`) spent constructing rounded stroke footprints (primitive setup + union). */
  footprintConstructionTimeMs: number;
  /** Wall-clock time (`ms`) spent constructing segment rectangle and disk primitives prior to union. */
  primitiveConstructionTimeMs: number;
  /** Wall-clock time (`ms`) spent inside `polygonClipping.union` during footprint buffering. */
  polygonUnionTimeMs: number;
  /** Wall-clock time (`ms`) spent in bbox blocker checks and `polygonClipping.difference` ownership clipping. */
  ownershipClippingTimeMs: number;
  /** Wall-clock time (`ms`) spent in `createShapesFromMultiPolygon`, `ShapeGeometry`, and `validateAndPruneHorizontalGeometry`. */
  triangulationAndValidationTimeMs: number;
}

/**
 * Diagnostic and benchmark counters emitted by the Stage E2 / E2+ graph-driven road geometry builder.
 */
export interface GraphRoadRenderStats {
  /** Total road node descriptors in the input adapter bundle. */
  inputRoadNodeCount: number;
  /** Total road edge descriptors in the input adapter bundle. */
  inputRoadEdgeCount: number;
  /** Number of road edge descriptors eligible for at-grade ribbon construction (`isAtGradeBuildable`). */
  atGradeRoadEdgeCount: number;
  /** Total provenance sub-segments processed in the road surface emission pass. */
  processedProvenanceSegmentCount: number;
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
  /** Number of segment rectangle primitives generated during E2+ rounded footprint buffering. */
  generatedRectanglePrimitiveCount: number;
  /** Number of interior bend disk primitives generated during E2+ rounded footprint buffering. */
  generatedBendDiskPrimitiveCount: number;
  /** Number of endpoint or closed-loop cap disk primitives generated during E2+ rounded footprint buffering. */
  generatedCapDiskPrimitiveCount: number;
  /** Total disk primitives (`generatedBendDiskPrimitiveCount + generatedCapDiskPrimitiveCount`) generated in E2+. */
  generatedDiskPrimitiveCount: number;
  /** Total rectangle and disk primitives generated during E2+ rounded footprint buffering. */
  generatedTotalPrimitiveCount: number;
  /** Number of `polygonClipping.union` operations invoked during road geometry generation. */
  polygonUnionOperationCount: number;
  /** Number of `polygonClipping.difference` operations invoked during ownership clipping. */
  polygonDifferenceOperationCount: number;
  /** Total placed-footprint bounding-box candidate checks evaluated during ownership clipping. */
  candidateBlockerCheckCount: number;
  /** Number of candidate footprints whose bounding box overlapped and were passed to Boolean clipping. */
  overlappingBlockerCount: number;
  /** Total outer polygon components across all emitted at-grade road/junction surfaces. */
  outputPolygonCount: number;
  /** Total interior hole rings across all emitted at-grade road/junction surfaces. */
  outputHoleRingCount: number;
  /** Total indexed triangles emitted across all at-grade road, step-tread, and junction geometries. */
  outputTriangleCount: number;
  /** Number of E2+ rounded buffer construction failures (`e2plus_rounded_buffer_failed`). */
  roundedBufferFailureCount: number;
  /** Number of E2+ flat ribbon fallbacks (`e2plus_flat_ribbon_fallback`). */
  flatRibbonFallbackCount: number;
  /** Number of E2+ surface ownership clipping failures (`e2plus_surface_clip_failed`). */
  surfaceClipFailureCount: number;
  /** Number of E2+ empty `THREE.Shape` conversions (`e2plus_empty_shapes`). */
  emptyShapeCount: number;
  /** Number of E2+ triangulated geometries rejected by `validateAndPruneHorizontalGeometry` (`e2plus_invalid_triangles`). */
  invalidTriangleGeometryCount: number;
}

/**
 * Input configuration for `buildGraphAtGradeRoadGeometries`.
 */
export interface GraphRoadGeometryBuildOptions {
  /** Immutable graph-backed render descriptor bundle produced by `InfrastructureRenderAdapter`. */
  descriptors: InfrastructureRenderDescriptorBundle;
  /** User/scene multiplier applied to canonical road widths. */
  roadWidthMultiplier: number;
  /** E2+ independent rounded-stroke footprint construction; false preserves E2 exactly. */
  surfaceFirst?: boolean;
  /** Optional world coordinates `[x, z]` of legacy Stage 6D bridge/tunnel endpoints (retained for interface compatibility). */
  gradeTransitionCoords?: ReadonlyArray<readonly [number, number]>;
  /** Scene resource manager for deterministic GPU buffer registration and disposal. */
  resourceManager: SceneResourceManager;
  /** Optional pipeline diagnostics object to record clipping failures or rejected geometry fallbacks. */
  diagnostics?: ProcessedMapData['diagnostics'];
}

/**
 * Output of `buildGraphAtGradeRoadGeometries` consumed by `GeometryBuilder.buildScene()` when `roads === 'graph' | 'graph-surface'`.
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
  /** Deterministic Stage E2 / E2+ graph-road rendering statistics and operation counters. */
  stats: GraphRoadRenderStats;
  /** High-resolution wall-clock timing breakdown (`ms`) for this road generation pass. */
  timing: GraphRoadGenerationTiming;
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
  junctionMultiPoly: MultiPolygonCoords;
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
  poly: MultiPolygonCoords;
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

  // A single shared miter portal cannot preserve two different approach widths.
  // Let the existing local full-width footprint union form the two-arm transition
  // instead of averaging widths and pinching/widening the source ribbons.
  if (Math.abs(b0.width - b1.width) > 1e-3) {
    return false;
  }

  const dot = b0.dir[0] * b1.dir[0] + b0.dir[1] * b1.dir[1];
  // If interior angle between the two arms is acute (< ~95°, i.e. dot >= 0.08),
  // fall back to boundary-derived 2-branch corner trimming so the inner crotch never overlaps.
  if (dot >= 0.08) {
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
  const miterScale = Math.min(1.35, 1.0 / Math.max(0.75, cosHalf));
  // Both widths are equal here, so the shared portal preserves their original
  // cross-sections instead of inventing a third, averaged road width.
  const halfW = b0.width * 0.5 * miterScale;

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
 * Computes the Euclidean distance from 2D point `pt` to segment `a -> b`.
 */
function distPointToSeg2D(
  pt: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number]
): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lenSq = dx * dx + dz * dz;
  if (lenSq <= 1e-12) {
    return Math.hypot(pt[0] - a[0], pt[1] - a[1]);
  }
  const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dz) / lenSq));
  return Math.hypot(pt[0] - (a[0] + t * dx), pt[1] - (a[1] + t * dz));
}

/**
 * Computes minimum distance from `pt` to any boundary segment of `multiPoly`.
 */
function distPointToMultiPolygonBoundary(
  pt: readonly [number, number],
  multiPoly: MultiPolygonCoords
): number {
  let minDist = Infinity;
  for (const poly of multiPoly) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const d = distPointToSeg2D(pt, ring[i], ring[i + 1]);
        if (d < minDist) minDist = d;
      }
    }
  }
  return minDist;
}

/**
 * Resolves the effective exposed portal endpoints along the segment `rightPt -> leftPt`
 * on the boundary of `junctionMultiPoly` (and optionally `clippedRoadMultiPoly` when the road
 * ribbon was clipped against the junction patch).
 */
function resolveEffectivePortalOnJunctionBoundary(
  leftPt: [number, number],
  rightPt: [number, number],
  junctionMultiPoly: MultiPolygonCoords,
  clippedRoadMultiPoly?: MultiPolygonCoords | null
): { left: [number, number]; right: [number, number] } | null {
  const dLeftJunc = distPointToMultiPolygonBoundary(leftPt, junctionMultiPoly);
  const dRightJunc = distPointToMultiPolygonBoundary(rightPt, junctionMultiPoly);
  const dLeftRoad = clippedRoadMultiPoly
    ? distPointToMultiPolygonBoundary(leftPt, clippedRoadMultiPoly)
    : 0;
  const dRightRoad = clippedRoadMultiPoly
    ? distPointToMultiPolygonBoundary(rightPt, clippedRoadMultiPoly)
    : 0;

  if (dLeftJunc <= 0.015 && dRightJunc <= 0.015 && dLeftRoad <= 0.015 && dRightRoad <= 0.015) {
    return { left: leftPt, right: rightPt };
  }

  // If the road was clipped against the junction, find shared boundary vertices where
  // clippedRoadMultiPoly and junctionMultiPoly meet (distance <= 0.012 m to both boundaries).
  if (clippedRoadMultiPoly) {
    const sharedPts: [number, number][] = [];
    for (const poly of clippedRoadMultiPoly) {
      for (const ring of poly) {
        for (const pt of ring) {
          if (distPointToMultiPolygonBoundary(pt, junctionMultiPoly) <= 0.012) {
            sharedPts.push([pt[0], pt[1]]);
          }
        }
      }
    }
    for (const poly of junctionMultiPoly) {
      for (const ring of poly) {
        for (const pt of ring) {
          if (distPointToMultiPolygonBoundary(pt, clippedRoadMultiPoly) <= 0.012) {
            sharedPts.push([pt[0], pt[1]]);
          }
        }
      }
    }
    if (sharedPts.length >= 2) {
      const pdx = leftPt[0] - rightPt[0];
      const pdz = leftPt[1] - rightPt[1];
      let minProj = Infinity;
      let maxProj = -Infinity;
      let bestRight = sharedPts[0];
      let bestLeft = sharedPts[0];
      for (const pt of sharedPts) {
        const proj = (pt[0] - rightPt[0]) * pdx + (pt[1] - rightPt[1]) * pdz;
        if (proj < minProj) {
          minProj = proj;
          bestRight = pt;
        }
        if (proj > maxProj) {
          maxProj = proj;
          bestLeft = pt;
        }
      }
      if (Math.hypot(bestLeft[0] - bestRight[0], bestLeft[1] - bestRight[1]) >= 0.05) {
        return { left: bestLeft, right: bestRight };
      }
    }
  }

  // Intersect portal segment P(t) = rightPt + t * (leftPt - rightPt) with junctionMultiPoly boundary segments
  const pdx = leftPt[0] - rightPt[0];
  const pdz = leftPt[1] - rightPt[1];
  const pLenSq = pdx * pdx + pdz * pdz;
  if (pLenSq <= 1e-8) return null;

  const crossings: number[] = [];
  for (const poly of junctionMultiPoly) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const q0 = ring[i];
        const q1 = ring[i + 1];
        const qdx = q1[0] - q0[0];
        const qdz = q1[1] - q0[1];
        const det = pdx * qdz - pdz * qdx;
        if (Math.abs(det) > 1e-7) {
          const rx = q0[0] - rightPt[0];
          const rz = q0[1] - rightPt[1];
          const t = (rx * qdz - rz * qdx) / det;
          const u = (rx * pdz - rz * pdx) / det;
          if (t >= -0.02 && t <= 1.02 && u >= -0.02 && u <= 1.02) {
            crossings.push(Math.max(0, Math.min(1, t)));
          }
        }
        if (distPointToSeg2D(q0, rightPt, leftPt) <= 0.012) {
          const t = ((q0[0] - rightPt[0]) * pdx + (q0[1] - rightPt[1]) * pdz) / pLenSq;
          if (t >= -0.02 && t <= 1.02) {
            crossings.push(Math.max(0, Math.min(1, t)));
          }
        }
      }
    }
  }

  const tStart =
    dRightJunc <= 0.015 ? 0 : crossings.length > 0 ? Math.min(...crossings) : 0;
  const tEnd =
    dLeftJunc <= 0.015 ? 1 : crossings.length > 0 ? Math.max(...crossings) : 1;

  if (tEnd - tStart < 0.02) {
    return { left: leftPt, right: rightPt };
  }

  return {
    right: [rightPt[0] + tStart * pdx, rightPt[1] + tStart * pdz],
    left: [rightPt[0] + tEnd * pdx, rightPt[1] + tEnd * pdz],
  };
}

/**
 * Extracts the exact sub-polyline along `points` between arc-length offsets `sStart` and `sEnd`
 * (`0 <= sStart <= sEnd <= totalLength`) without the 45% endpoint clamp of `trimPolylineByArcLength`.
 * Preserves all intermediate polyline vertices strictly inside `(sStart, sEnd)`.
 */
function extractPolylineSpan(
  points: readonly (readonly [number, number])[],
  sStart: number,
  sEnd: number
): [number, number][] {
  if (!points || points.length < 2) {
    return points ? points.map((pt) => [pt[0], pt[1]]) : [];
  }
  const cumDist: number[] = [0];
  for (let i = 0; i < points.length - 1; i++) {
    const d = Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    cumDist.push(cumDist[i] + d);
  }
  const totalLen = cumDist[cumDist.length - 1];
  if (totalLen <= 1e-6) {
    return [
      [points[0][0], points[0][1]],
      [points[points.length - 1][0], points[points.length - 1][1]],
    ];
  }

  const a = Math.max(0, Math.min(totalLen, sStart));
  const b = Math.max(a, Math.min(totalLen, sEnd));

  const sampleAt = (s: number): [number, number] => {
    if (s <= 0) return [points[0][0], points[0][1]];
    if (s >= totalLen) return [points[points.length - 1][0], points[points.length - 1][1]];
    for (let i = 0; i < points.length - 1; i++) {
      const d0 = cumDist[i];
      const d1 = cumDist[i + 1];
      if (s <= d1 || i === points.length - 2) {
        const segLen = d1 - d0;
        if (segLen <= 1e-9) return [points[i][0], points[i][1]];
        const t = Math.max(0, Math.min(1, (s - d0) / segLen));
        return [
          points[i][0] + t * (points[i + 1][0] - points[i][0]),
          points[i][1] + t * (points[i + 1][1] - points[i][1]),
        ];
      }
    }
    return [points[points.length - 1][0], points[points.length - 1][1]];
  };

  const out: [number, number][] = [sampleAt(a)];
  for (let i = 1; i < points.length - 1; i++) {
    const d = cumDist[i];
    if (d > a + 1e-4 && d < b - 1e-4) {
      out.push([points[i][0], points[i][1]]);
    }
  }
  out.push(sampleAt(b));
  return out;
}

/**
 * Repairs only a numerically thin near-reversal hairpin introduced by unioning
 * nearly collinear, full-width road stubs. A short junction approach can be
 * narrower in *length* than its carriageway width: two consecutive stubs then
 * overlap around the center and polygon-clipping may retain a thin (~centimetre)
 * backtracking spur. hasRingSelfIntersection correctly rejects that ring.
 *
 * Delete such an apex only when its neighboring vertices almost coincide,
 * both arms are shorter than the road width, and the total affected footprint
 * area is under 0.15 m². Never use this for broad concavities, actual islands,
 * holes, or meaningful curb transitions.
 */
function repairNearReversalJunctionPolygon(
  polygon: [number, number][][],
  maxBranchWidth: number
): [number, number][][] | null {
  if (polygon.length !== 1 || polygon[0].length < 5) return null;
  const ring = polygon[0];
  const closed =
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const points = (closed ? ring.slice(0, -1) : ring).map(
    ([x, z]) => [x, z] as [number, number]
  );
  if (points.length < 4) return null;

  const originalArea = computeMultiPolygonArea([polygon]);
  let removals = 0;
  for (; removals < 3; removals++) {
    const candidateRing: [number, number][] = [...points, points[0]];
    if (!hasRingSelfIntersection(candidateRing)) {
      if (removals === 0) return null;
      const repaired: [number, number][][] = [candidateRing];
      const areaChange = Math.abs(computeMultiPolygonArea([repaired]) - originalArea);
      return areaChange <= Math.min(0.15, maxBranchWidth * 0.04)
        ? repaired : null;
    }

    let removeIndex = -1;
    for (let i = 0; i < points.length; i++) {
      const prev = points[(i - 1 + points.length) % points.length];
      const curr = points[i];
      const next = points[(i + 1) % points.length];
      const ux = curr[0] - prev[0], uz = curr[1] - prev[1];
      const vx = next[0] - curr[0], vz = next[1] - curr[1];
      const lenU = Math.hypot(ux, uz), lenV = Math.hypot(vx, vz);
      if (lenU < 1e-3 || lenV < 1e-3 ||
          Math.max(lenU, lenV) > maxBranchWidth * 0.65) continue;

      const cosine = (ux * vx + uz * vz) / (lenU * lenV);
      const neighborDistance = Math.hypot(next[0] - prev[0], next[1] - prev[1]);
      const affectedArea = Math.abs(
        ux * (next[1] - prev[1]) - uz * (next[0] - prev[0])
      ) * 0.5;
      if (cosine < -0.992 && neighborDistance <= 0.08 && affectedArea <= 0.12) {
        removeIndex = i;
        break;
      }
    }
    if (removeIndex < 0 || points.length <= 3) return null;
    points.splice(removeIndex, 1);
  }

  const finalRing: [number, number][] = [...points, points[0]];
  if (hasRingSelfIntersection(finalRing)) return null;
  const repaired: [number, number][][] = [finalRing];
  return Math.abs(computeMultiPolygonArea([repaired]) - originalArea) <=
      Math.min(0.15, maxBranchWidth * 0.04)
    ? repaired : null;
}

/**
 * Constructs a localized road-footprint union junction patch and full-width orthogonal branch
 * portals around `nodeCenter` for a set of `>= 2` incident branches (`ADR-0002`, `ADR-0009`).
 *
 * Preserves each incident road's full intended width (`bBranch.width`) and curved centerline
 * geometry right up to the local junction cut line `s = trimDist`, and takes the 2D Boolean union
 * of the overlapping local road footprints so road boundaries never pinch or stretch into wedges.
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
  const maxBranchWidth = Math.max(...sortedBranches.map((b) => b.width));

  // Nearly parallel branches that diverge from the same OSM node can have
  // overlapping full-width footprints well beyond the usual width-based trim.
  // For example, two 2.4m cycleways at 17 degrees still overlap at ~8m.
  // Keep their shared overlap in ONE local junction patch instead of ending
  // that patch early and leaving square-ended ribbon clipping artifacts.
  const acuteOverlapClearance = sortedBranches.map((branch, i) => {
    let clearance = 0;
    for (let j = 0; j < sortedBranches.length; j++) {
      if (i === j) continue;
      const other = sortedBranches[j];
      if (branch.edge.id === other.edge.id) continue;
      // The longer clearance is needed only for similarly sized, same-class
      // branches that genuinely travel alongside each other. Applying it to a
      // narrow residential slip road joining a wide trunk road extends the
      // whole trunk junction far beyond its established local trim budget.
      if (branch.roadClass !== other.roadClass ||
          Math.abs(branch.width - other.width) > 1e-3) continue;
      const dot = branch.dir[0] * other.dir[0] + branch.dir[1] * other.dir[1];
      if (dot <= 0) continue; // opposite through-arms do not overlap downstream
      const sine = Math.abs(branch.dir[0] * other.dir[1] -
                            branch.dir[1] * other.dir[0]);
      if (sine < 0.08) continue; // near-coincident rays are handled as ambiguous
      const clearAt = (branch.width + other.width) * 0.5 / sine + 0.15;
      clearance = Math.max(clearance, Math.min(clearAt, maxBranchWidth * 6));
    }
    return clearance;
  });

  // Local trim budget per branch: bounded by a tight local radius multiple of road width and
  // total edge length budget (never clamped by firstSegmentLength so curved roads with dense vertices
  // retain their full curvature through the junction).
  const maxTrimDists: number[] = sortedBranches.map((bBranch, i) => {
    const tRec = trimmedEndpoints.get(bBranch.edge.id);
    const existingOtherTrim = tRec
      ? bBranch.endpoint === 'start'
        ? tRec.endTrimDist
        : tRec.startTrimDist
      : 0;
    const isSelfLoop = bBranch.edge.fromNodeId === bBranch.edge.toNodeId;
    const localRadiusCap = Math.max(
      Math.max(bBranch.width, maxBranchWidth) * 1.65,
      acuteOverlapClearance[i]
    );
    const maxByTotalRatio = Math.max(
      0.12,
      bBranch.totalEdgeLength * (isSelfLoop ? 0.32 : 0.42)
    );
    const remainingBudget = Math.max(
      0.12,
      (bBranch.totalEdgeLength -
        existingOtherTrim -
        Math.min(0.20, bBranch.totalEdgeLength * 0.10)) *
        (isSelfLoop ? 0.45 : 0.82)
    );
    return Math.min(localRadiusCap, maxByTotalRatio, remainingBudget);
  });

  const sectorDet: number[] = new Array(k).fill(0);
  const sectorTA: number[] = new Array(k).fill(0);
  const sectorTB: number[] = new Array(k).fill(0);

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
    sectorDet[i] = det;

    if (Math.abs(det) > 0.06) {
      const dx = pB[0] - pA[0];
      const dz = pB[1] - pA[1];
      const tA = (dx * dB[1] - dz * dB[0]) / det;
      const tB = (dx * dA[1] - dz * dA[0]) / det;
      sectorTA[i] = tA;
      sectorTB[i] = tB;
    }
  }

  const trimDists: number[] = [];
  // Two connected through-arms with different widths need a local taper,
  // otherwise the full-width footprint union leaves square shoulders at the node.
  // A gentle centerline bend is still continuity: 35° for two arms, 23° for
  // three-arm forks. Do not invent a mainline at ambiguous branching nodes.
  let widthTransitionPair: [number, number] | null = null;
  const maxThroughArmDot = k === 2 ? -0.82 : -0.92;
  const taperCandidates: Array<{ pair: [number, number]; dot: number }> = [];
  if (k === 2 || k === 3) {
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const a = sortedBranches[i];
        const b = sortedBranches[j];
        // Different vehicular classes may have deliberately distinct carriageways.
        // For a three-arm road fork, blend only a geometrically continuous
        // same-class pair. Cycleways use the same path-tier rule.
        if (k === 3 && !isPathJunction && a.roadClass !== b.roadClass) continue;
        const dot = a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1];
        const delta = Math.abs(a.width - b.width);
        if (a.edge.id === b.edge.id || dot > maxThroughArmDot || delta <= 1e-3) continue;
        const minTaperLength = delta * 0.65;
        if (maxTrimDists[i] < minTaperLength || maxTrimDists[j] < minTaperLength) continue;
        taperCandidates.push({ pair: [i, j], dot });
      }
    }
  }
  taperCandidates.sort((a, b) => a.dot - b.dot);
  // If two through-pairs are almost equally aligned, preserve the ordinary
  // footprint union instead of guessing which branch should be continuous.
  if (taperCandidates.length > 0 &&
      (k === 2 || taperCandidates.length === 1 ||
       taperCandidates[1].dot - taperCandidates[0].dot >= 0.10)) {
    widthTransitionPair = taperCandidates[0].pair;
  }
  // A two-way road can split into TWO narrower, same-class branches on
  // opposite sides of its continuation. No single through-arm can represent
  // that width transition: choosing one creates a shoulder on the other side.
  // Allow one additional DIFFERENT-class arm (e.g. the service road at
  // Industriestraat node/45929045), but never guess across 5+ arm junctions.
  let splitMergeTransition: {
    trunkIndex: number;
    outerBranches: Array<{ index: number; side: -1 | 1 }>;
  } | null = null;
  if (!isPathJunction && (k === 3 || k === 4)) {
    const trunkIndex = sortedBranches.findIndex((candidate) =>
      sortedBranches.every((other) =>
        other === candidate || candidate.width > other.width + 0.50
      )
    );
    if (trunkIndex >= 0) {
      const trunk = sortedBranches[trunkIndex];
      const narrowIndices = sortedBranches
        .map((branch, index) => ({ branch, index }))
        .filter(({ branch }) =>
          branch.roadClass === trunk.roadClass &&
          branch.edge.id !== trunk.edge.id
        );
      const extraArms = sortedBranches.filter((branch) =>
        branch.roadClass !== trunk.roadClass
      );
      if (narrowIndices.length === 2 &&
          extraArms.length === k - 3 &&
          Math.abs(narrowIndices[0].branch.width - narrowIndices[1].branch.width) < 0.05 &&
          narrowIndices.every(({ branch }) =>
            trunk.width - branch.width >= 0.50 &&
            branch.totalEdgeLength >= 4 &&
            -trunk.dir[0] * branch.dir[0] - trunk.dir[1] * branch.dir[1] > 0.72
          )) {
        const forward: [number, number] = [-trunk.dir[0], -trunk.dir[1]];
        const cross = narrowIndices.map(({ branch }) =>
          forward[0] * branch.dir[1] - forward[1] * branch.dir[0]
        );
        // A valid split straddles the trunk direction. Requiring an
        // arbitrary product below -0.01 rejected asymmetric, real OSM
        // splits (Parallelweg LS node/45922214: +0.132 / -0.071).
        // Test each side explicitly, with a modest angular spread so nearly
        // coincident or noisy rays cannot trigger an invented split.
        if (cross[0] * cross[1] < 0 &&
            Math.min(Math.abs(cross[0]), Math.abs(cross[1])) >= 0.035 &&
            Math.abs(cross[0] - cross[1]) >= 0.15) {
          splitMergeTransition = {
            trunkIndex,
            outerBranches: narrowIndices.map(({ index }, i) => ({
              index,
              side: (cross[i] > 0 ? 1 : -1) as -1 | 1,
            })),
          };
          // An ordinary pair taper would arbitrarily favor one of the arms.
          widthTransitionPair = null;
        }
      }
    }
  }

  const junctionFeatureId = isPathJunction ? `path-junction-${nodeId}` : `junction-${nodeId}`;

  for (let i = 0; i < k; i++) {
    const prev = (i - 1 + k) % k;
    const next = (i + 1) % k;
    const bBranch = sortedBranches[i];

    const reqLeft =
      sectorDet[i] > 0.06 && sectorTA[i] > 0
        ? sectorTA[i] + 0.12
        : Math.abs(bBranch.width - sortedBranches[next].width) * 0.35 + 0.25;
    const reqRight =
      sectorDet[prev] > 0.06 && sectorTB[prev] > 0
        ? sectorTB[prev] + 0.12
        : Math.abs(bBranch.width - sortedBranches[prev].width) * 0.35 + 0.25;

    let maxPairReq = 0;
    if (k >= 4) {
      for (let j = 0; j < k; j++) {
        if (j === i || j === prev || j === next) continue;
        const other = sortedBranches[j];
        const cosTheta =
          bBranch.dir[0] * other.dir[0] + bBranch.dir[1] * other.dir[1];
        if (cosTheta > -0.15) {
          const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
          const pairDist =
            (other.width * 0.5 + bBranch.width * 0.5 * Math.max(0, cosTheta)) /
              Math.max(0.30, sinTheta) +
            0.10;
          if (pairDist > maxPairReq) maxPairReq = pairDist;
        }
      }
    }

    const minStub = Math.min(bBranch.width * 0.30, 1.2);
    const rawTrimDist = Math.max(0.15, minStub, reqLeft, reqRight, maxPairReq);
    const isTransitionArm = widthTransitionPair?.includes(i) ?? false;
    const transitionDelta = widthTransitionPair
      ? Math.abs(sortedBranches[widthTransitionPair[0]].width -
          sortedBranches[widthTransitionPair[1]].width)
      : 0;
    const taperTrimDist = isTransitionArm
      ? Math.max(rawTrimDist, maxBranchWidth * 0.5, transitionDelta * 0.65)
      : rawTrimDist;
    const requestedTrimDist = Math.max(taperTrimDist, acuteOverlapClearance[i]);
    const trimDist = Math.min(requestedTrimDist, maxTrimDists[i]);
    trimDists.push(trimDist);
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

  const portals: Array<{
    left: [number, number];
    right: [number, number];
    center: [number, number];
  }> = [];
  const unionInputs: MultiPolygonCoords = [];
  const splitMergeFins: MultiPolygonCoords = [];

  for (let i = 0; i < k; i++) {
    const bBranch = sortedBranches[i];
    const trimDist = trimDists[i];

    // Extract the branch's local curved centerline on [0, trimDist] oriented outward from nodeCenter
    const rawLocalPts =
      bBranch.endpoint === 'start'
        ? extractPolylineSpan(bBranch.edge.points, 0, trimDist)
        : extractPolylineSpan(
            bBranch.edge.points,
            Math.max(0, bBranch.totalEdgeLength - trimDist),
            bBranch.totalEdgeLength
          )
            .slice()
            .reverse();

    const localPts: [number, number][] = [[nodeCenter[0], nodeCenter[1]]];
    for (let pIdx = 1; pIdx < rawLocalPts.length; pIdx++) {
      const pt = rawLocalPts[pIdx];
      const prevPt = localPts[localPts.length - 1];
      if (Math.hypot(pt[0] - prevPt[0], pt[1] - prevPt[1]) > 0.01) {
        localPts.push([pt[0], pt[1]]);
      } else if (pIdx === rawLocalPts.length - 1 && localPts.length >= 2) {
        localPts[localPts.length - 1] = [pt[0], pt[1]];
      }
    }
    if (localPts.length < 2) {
      localPts.push([
        nodeCenter[0] + bBranch.dir[0] * trimDist,
        nodeCenter[1] + bBranch.dir[1] * trimDist,
      ]);
    }

    const pPrev = localPts[localPts.length - 2];
    const pCut = localPts[localPts.length - 1];
    const segDx = pCut[0] - pPrev[0];
    const segDz = pCut[1] - pPrev[1];
    const segLen = Math.hypot(segDx, segDz) || 1e-6;
    const tCutX = segDx / segLen;
    const tCutZ = segDz / segLen;
    const nCutX = -tCutZ;
    const nCutZ = tCutX;
    const halfW = bBranch.width * 0.5;

    // Strictly orthogonal, 100% full-width portal at pCut
    const centerPortal: [number, number] = [snapCoord(pCut[0]), snapCoord(pCut[1])];
    const leftPortal: [number, number] = [
      snapCoord(pCut[0] + nCutX * halfW),
      snapCoord(pCut[1] + nCutZ * halfW),
    ];
    const rightPortal: [number, number] = [
      snapCoord(pCut[0] - nCutX * halfW),
      snapCoord(pCut[1] - nCutZ * halfW),
    ];
    portals.push({ left: leftPortal, right: rightPortal, center: centerPortal });

    // Generate full-width local ribbon along localPts to capture any curve inside [0, trimDist]
    const stubRibbon = generateRoadRibbon(localPts, bBranch.width, 0, {
      roundCaps: false,
      endPortal: { left: leftPortal, right: rightPortal },
    });

    const leftChain: [number, number][] = [];
    const rightChain: [number, number][] = [];
    if (stubRibbon && stubRibbon.positions.length >= localPts.length * 6) {
      const pos = stubRibbon.positions;
      for (let v = 0; v < localPts.length; v++) {
        const lIdx = v * 2;
        const rIdx = v * 2 + 1;
        leftChain.push([snapCoord(pos[lIdx * 3]), snapCoord(pos[lIdx * 3 + 2])]);
        rightChain.push([snapCoord(pos[rIdx * 3]), snapCoord(pos[rIdx * 3 + 2])]);
      }
      leftChain[leftChain.length - 1] = leftPortal;
      rightChain[rightChain.length - 1] = rightPortal;
    } else {
      const n0 = branchNormals[i];
      leftChain.push(
        [
          snapCoord(nodeCenter[0] + n0[0] * halfW),
          snapCoord(nodeCenter[1] + n0[1] * halfW),
        ],
        leftPortal
      );
      rightChain.push(
        [
          snapCoord(nodeCenter[0] - n0[0] * halfW),
          snapCoord(nodeCenter[1] - n0[1] * halfW),
        ],
        rightPortal
      );
    }

    // Split/merge outer-curb transition. Add a smooth one-sided width taper
    // along each narrower branch's existing outside curb, leaving its inside
    // curb and the real gap between the diverging branches unchanged. Use the
    // SAME mitered offset vectors as the source ribbon at every vertex, then
    // interpolate between vertices so even short multi-bend arms stay valid.
    // Smoothstep gives zero change in width derivative at both ends.
    const splitOuter = splitMergeTransition?.outerBranches.find((b) => b.index === i);
    if (splitOuter && trimDist >= 2.0) {
      const trunk = sortedBranches[splitMergeTransition!.trunkIndex];
      const deltaHalfWidth = (trunk.width - bBranch.width) * 0.5;
      const baseHalfWidth = bBranch.width * 0.5;
      const branchOuter = splitOuter.side === 1 ? leftChain : rightChain;
      const localLength = computePolylineLength(localPts);
      if (deltaHalfWidth >= 0.25 && baseHalfWidth > 0.1 &&
          localLength > 1.9 && localPts.length === branchOuter.length) {
        const outerChain: [number, number][] = [];
        const originalChain: [number, number][] = [];
        let walked = 0;
        for (let seg = 0; seg < localPts.length - 1; seg++) {
          const p0 = localPts[seg], p1 = localPts[seg + 1];
          const c0 = branchOuter[seg], c1 = branchOuter[seg + 1];
          const segLength = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
          for (let step = 0; step < 4; step++) {
            const t = step / 4;
            const cx = p0[0] + (p1[0] - p0[0]) * t;
            const cz = p0[1] + (p1[1] - p0[1]) * t;
            const bx = c0[0] + (c1[0] - c0[0]) * t;
            const bz = c0[1] + (c1[1] - c0[1]) * t;
            const u = Math.min(1, (walked + segLength * t) / localLength);
            const ease = (1 - u) * (1 - u) * (1 + 2 * u);
            // A mathematically zero-width taper tip makes its two contour
            // edges fold back 180 degrees, which the strict polygon validator
            // correctly rejects. End with a sub-visual 1.4cm cross-section so
            // the polygon is nondegenerate at the orthogonal cut portal.
            const endFringe = Math.min(0.014, deltaHalfWidth * 0.1);
            const grow = (endFringe + (deltaHalfWidth - endFringe) * ease) /
              baseHalfWidth;
            originalChain.push([snapCoord(bx), snapCoord(bz)]);
            outerChain.push([
              snapCoord(bx + (bx - cx) * grow),
              snapCoord(bz + (bz - cz) * grow),
            ]);
          }
          walked += segLength;
        }
        // Cap the one-sided fin with the SAME nonzero fringe used by the
        // smoothstep profile. Previously both chains ended at endOuter, making
        // a zero-width cusp: hasRingSelfIntersection correctly rejected the
        // near-180-degree fold-back and silently selected the plain union.
        // A 1.4cm transverse cap remains within portal boundary tolerance.
        const endOuter = branchOuter[branchOuter.length - 1];
        const endCenter = localPts[localPts.length - 1];
        const endFringe = Math.min(0.014, deltaHalfWidth * 0.1);
        outerChain.push([
          snapCoord(endOuter[0] + (endOuter[0] - endCenter[0]) *
            (endFringe / baseHalfWidth)),
          snapCoord(endOuter[1] + (endOuter[1] - endCenter[1]) *
            (endFringe / baseHalfWidth)),
        ]);
        originalChain.push(endOuter);
        const finRing: [number, number][] = [
          ...outerChain, ...originalChain.slice().reverse(), outerChain[0],
        ];
        if (!hasRingSelfIntersection(finRing) &&
            computeMultiPolygonArea([[finRing]]) >= 0.05) {
          splitMergeFins.push([finRing]);
        }
      }
    }

    // The complete curb chains, not shortened or pinched corner chains, define this local road footprint.
    // Authoritative full-width road footprint stub from nodeCenter to the cut portal
    const fullStripRing: [number, number][] = [
      ...rightChain,
      ...leftChain.slice().reverse(),
      rightChain[0],
    ];
    const dedupedStrip: [number, number][] = [];
    for (const pt of fullStripRing) {
      const snappedPt: [number, number] = [snapCoord(pt[0]), snapCoord(pt[1])];
      if (
        dedupedStrip.length === 0 ||
        Math.hypot(
          snappedPt[0] - dedupedStrip[dedupedStrip.length - 1][0],
          snappedPt[1] - dedupedStrip[dedupedStrip.length - 1][1]
        ) > 1e-4
      ) {
        dedupedStrip.push(snappedPt);
      }
    }
    if (
      dedupedStrip.length >= 2 &&
      (dedupedStrip[0][0] !== dedupedStrip[dedupedStrip.length - 1][0] ||
        dedupedStrip[0][1] !== dedupedStrip[dedupedStrip.length - 1][1])
    ) {
      dedupedStrip.push([dedupedStrip[0][0], dedupedStrip[0][1]]);
    }
    if (dedupedStrip.length >= 4 && !hasRingSelfIntersection(dedupedStrip)) {
      unionInputs.push([dedupedStrip]);
    }
  }

  // Every incident full-width stub must participate. A union of only some branches
  // may be valid geometry but would leave uncovered roads after endpoint trimming.
  if (unionInputs.length !== k) {
    recordGraphRoadDiagnostic(diagnostics, 'junction_invalid_full_width_stub', nodeId);
    return null;
  }

  // Additive split/merge fins change the FINAL outline while retaining
  // every original full-width stub. Require BOTH outside curbs, a measurable
  // addition, and a strict area budget. Otherwise use the existing solver.
  let splitMergePoly: MultiPolygonCoords | null = null;
  if (splitMergeTransition && splitMergeFins.length === 2) {
    try {
      const base = filterDegenerateBooleanArtifacts(
        polygonClipping.union(
          unionInputs[0] as unknown as polygonClipping.Geom,
          ...(unionInputs.slice(1) as unknown as polygonClipping.Geom[])
        ) as unknown as MultiPolygonCoords
      );
      const candidate = filterDegenerateBooleanArtifacts(
        polygonClipping.union(
          base as unknown as polygonClipping.Geom,
          ...(splitMergeFins as unknown as polygonClipping.Geom[])
        ) as unknown as MultiPolygonCoords
      );
      const addedArea = computeMultiPolygonArea(candidate) -
        computeMultiPolygonArea(base);
      if (addedArea >= 0.20 &&
          addedArea < maxBranchWidth * maxBranchWidth &&
          candidate.length > 0 &&
          candidate.every((poly) => poly[0] && !hasRingSelfIntersection(poly[0]))) {
        splitMergePoly = candidate;
      }
    } catch {
      // Use the original local footprint union if a fin cannot be unioned.
    }
  }

  // Bridge the independent full-width portals of a continuous unequal-width
  // pair with a bounded taper instead of the wide arm's square shoulder.
  // A third diverging arm joins the taper through the same local footprint union.
  // On tight bends, short edges, or invalid contours, keep the ordinary union.
  let solidMultiPoly: MultiPolygonCoords = splitMergePoly ?? [];
  if (widthTransitionPair && solidMultiPoly.length === 0) {
    const [a, b] = widthTransitionPair;
    const transitionRing: [number, number][] = [
      portals[a].left, portals[a].right,
      portals[b].left, portals[b].right,
      portals[a].left,
    ];
    if (!hasRingSelfIntersection(transitionRing) &&
        computeMultiPolygonArea([[transitionRing]]) >= 0.05) {
      const remainingArms = unionInputs.filter((_, i) => i !== a && i !== b);
      if (remainingArms.length === 0) {
        solidMultiPoly = [[transitionRing]];
      } else {
        try {
          solidMultiPoly = filterDegenerateBooleanArtifacts(
            polygonClipping.union(
              [[transitionRing]] as unknown as polygonClipping.Geom,
              ...(remainingArms as unknown as polygonClipping.Geom[])
            ) as unknown as MultiPolygonCoords
          ).filter((poly) => poly[0] && !hasRingSelfIntersection(poly[0]));
        } catch {
          // Keep the reliable complete footprint union below.
        }
      }
    }
  }
  if (solidMultiPoly.length === 0) {
    try {
      const rawUnion = polygonClipping.union(
        unionInputs[0] as unknown as polygonClipping.Geom,
        ...(unionInputs.slice(1) as unknown as polygonClipping.Geom[])
      ) as unknown as MultiPolygonCoords;
      solidMultiPoly = filterDegenerateBooleanArtifacts(rawUnion)
        .map((poly) => {
          if (!poly[0] || !hasRingSelfIntersection(poly[0])) return poly;
          // Keep the strict validator; repair only a tiny folded-back spur
          // caused by near-collinear road stubs at a short adjacent junction.
          const repaired = repairNearReversalJunctionPolygon(poly, maxBranchWidth);
          if (repaired) {
            recordGraphRoadDiagnostic(
              diagnostics, 'junction_near_reversal_spur_repaired', nodeId
            );
            return repaired;
          }
          return poly;
        })
        .filter((poly) =>
          poly[0] && poly[0].length >= 4 && !hasRingSelfIntersection(poly[0])
        );
    } catch {
      recordGraphRoadDiagnostic(diagnostics, 'junction_footprint_union_failed', nodeId);
      return null;
    }
  }

  if (solidMultiPoly.length === 0 || computeMultiPolygonArea(solidMultiPoly) < 0.05) {
    recordGraphRoadDiagnostic(diagnostics, 'junction_polygon_validation_failed', nodeId);
    return null;
  }

  // Only path-tier junctions with at least three arms need this subtle rounding.
  // Fillet the *post-union* outer outline rather than individual input strips:
  // the earlier additive-fillets attempt was absorbed by their Boolean union.
  // Portals remain exact, all existing geometric validation remains mandatory.
  if (isPathJunction && k >= 3) {
    const portalAnchors = portals.flatMap((portal) => [portal.left, portal.right]);
    const proposed = proposeRoundedPathJunctionOutline(
      solidMultiPoly, nodeCenter, portalAnchors, maxBranchWidth
    );
    if (proposed && proposed.every((poly) =>
      poly[0] && poly[0].length >= 4 && !hasRingSelfIntersection(poly[0])
    )) {
      try {
        const difference = polygonClipping.xor(
          solidMultiPoly as unknown as polygonClipping.Geom,
          proposed as unknown as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords;
        const changedArea = computeMultiPolygonArea(
          filterDegenerateBooleanArtifacts(difference)
        );
        const changeBudget = Math.min(
          maxBranchWidth * maxBranchWidth * 0.20,
          computeMultiPolygonArea(solidMultiPoly) * 0.12
        );
        if (changedArea > 0.001 && changedArea <= changeBudget) {
          const proposedShapes = createShapesFromMultiPolygon(proposed);
          if (proposedShapes.length > 0) {
            const proposedGeo = new THREE.ShapeGeometry(proposedShapes);
            proposedGeo.rotateX(-Math.PI / 2);
            const valid = validateAndPruneHorizontalGeometry(proposedGeo);
            proposedGeo.dispose();
            if (valid) solidMultiPoly = proposed;
          }
        }
      } catch {
        // Never compromise connectivity because a rounding proposal failed.
        // Existing exact-width polygon remains the authoritative fallback.
      }
    }
  }

  // Validate 3D triangulation and upward face normals before committing trimmedEndpoints
  const testShapes = createShapesFromMultiPolygon(solidMultiPoly);
  if (testShapes.length === 0) {
    recordGraphRoadDiagnostic(diagnostics, 'junction_polygon_validation_failed', nodeId);
    return null;
  }
  const testGeo = new THREE.ShapeGeometry(testShapes);
  testGeo.rotateX(-Math.PI / 2);
  const isValidGeo = validateAndPruneHorizontalGeometry(testGeo);
  testGeo.dispose();

  if (!isValidGeo) {
    recordGraphRoadDiagnostic(diagnostics, 'junction_polygon_validation_failed', nodeId);
    return null;
  }

  // Transactionally commit endpoint trim state ONLY after polygon & portal validation succeeded!
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
      // Do not exempt incident ribbons from this patch: local overlap is removed
      // by the same Boolean difference used for all other road footprints.
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
    junctionMultiPoly: solidMultiPoly,
    sortedBranches,
    portals,
    dominantBranch,
  };
}

/**
 * Sanitizes a sub-segment centerline polyline and its optional `startPortal` / `endPortal`
 * while preserving interior curve vertices and confining any degree-2 width step to a local
 * transition zone near the node.
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

  // Merge sub-meter stub vertices right next to startPortal only when startPortal overhang +
  // the interior bend overhang at pts[1] would physically invert the first quad.
  if (pts.length > 2) {
    while (pts.length > 2) {
      const p0 = pts[0];
      const p1 = pts[1];
      const p2 = pts[2];
      const dx0 = p1[0] - p0[0];
      const dz0 = p1[1] - p0[1];
      const segLen0 = Math.hypot(dx0, dz0);
      if (segLen0 < 1e-4) {
        pts.splice(1, 1);
        continue;
      }
      const tx0 = dx0 / segLen0;
      const tz0 = dz0 / segLen0;
      let portalOverhang = 0;
      if (startPortal) {
        const projL = (startPortal.left[0] - p0[0]) * tx0 + (startPortal.left[1] - p0[1]) * tz0;
        const projR = (startPortal.right[0] - p0[0]) * tx0 + (startPortal.right[1] - p0[1]) * tz0;
        portalOverhang = Math.max(0, projL, projR);
      }
      const dx1 = p2[0] - p1[0];
      const dz1 = p2[1] - p1[1];
      const segLen1 = Math.hypot(dx1, dz1) || 1e-6;
      const dot = (tx0 * dx1 + tz0 * dz1) / segLen1;
      const sinHalf = Math.sqrt(Math.max(0, (1 - dot) * 0.5));
      const cosHalf = Math.sqrt(Math.max(0.1, (1 + dot) * 0.5));
      const bendOverhang = (width * 0.5 * sinHalf) / Math.max(0.75, cosHalf);

      if (segLen0 <= portalOverhang + bendOverhang + 0.05) {
        pts.splice(1, 1);
      } else {
        break;
      }
    }
  }

  // Merge sub-meter stub vertices right next to endPortal only when endPortal overhang +
  // the interior bend overhang at pts[last - 1] would physically invert the last quad.
  if (pts.length > 2) {
    while (pts.length > 2) {
      const last = pts.length - 1;
      const pn = pts[last];
      const pPrev = pts[last - 1];
      const pPrev2 = pts[last - 2];
      const dx0 = pn[0] - pPrev[0];
      const dz0 = pn[1] - pPrev[1];
      const segLen0 = Math.hypot(dx0, dz0);
      if (segLen0 < 1e-4) {
        pts.splice(last - 1, 1);
        continue;
      }
      const tx0 = dx0 / segLen0;
      const tz0 = dz0 / segLen0;
      let portalOverhang = 0;
      if (endPortal) {
        const projL = (pn[0] - endPortal.left[0]) * tx0 + (pn[1] - endPortal.left[1]) * tz0;
        const projR = (pn[0] - endPortal.right[0]) * tx0 + (pn[1] - endPortal.right[1]) * tz0;
        portalOverhang = Math.max(0, projL, projR);
      }
      const dx1 = pPrev[0] - pPrev2[0];
      const dz1 = pPrev[1] - pPrev2[1];
      const segLen1 = Math.hypot(dx1, dz1) || 1e-6;
      const dot = (tx0 * dx1 + tz0 * dz1) / segLen1;
      const sinHalf = Math.sqrt(Math.max(0, (1 - dot) * 0.5));
      const cosHalf = Math.sqrt(Math.max(0.1, (1 + dot) * 0.5));
      const bendOverhang = (width * 0.5 * sinHalf) / Math.max(0.75, cosHalf);

      if (segLen0 <= portalOverhang + bendOverhang + 0.05) {
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
  const surfaceFirst = options.surfaceFirst === true;

  const tTotalStart = performance.now();
  const timing: GraphRoadGenerationTiming = {
    totalRoadGenerationTimeMs: 0,
    footprintConstructionTimeMs: 0,
    primitiveConstructionTimeMs: 0,
    polygonUnionTimeMs: 0,
    ownershipClippingTimeMs: 0,
    triangulationAndValidationTimeMs: 0,
  };
  const bufferInstrumentation: SurfaceFirstBufferInstrumentation = {
    rectanglePrimitiveCount: 0,
    bendDiskPrimitiveCount: 0,
    capDiskPrimitiveCount: 0,
    unionOperationCount: 0,
    primitiveConstructionTimeMs: 0,
    polygonUnionTimeMs: 0,
  };

  const stats: GraphRoadRenderStats = {
    inputRoadNodeCount: descriptors.roadNodes.length,
    inputRoadEdgeCount: descriptors.roadEdges.length,
    atGradeRoadEdgeCount: 0,
    processedProvenanceSegmentCount: 0,
    renderedRoadRibbonCount: 0,
    renderedJunctionCount: 0,
    branchingJunctionCount: 0,
    degree2ContinuityJoinCount: 0,
    pathJunctionCount: 0,
    crossTierOnlyNodeCount: 0,
    rejectedOrDegenerateCount: 0,
    fullySubtractedCount: 0,
    provenanceSplitSegmentCount: 0,
    generatedRectanglePrimitiveCount: 0,
    generatedBendDiskPrimitiveCount: 0,
    generatedCapDiskPrimitiveCount: 0,
    generatedDiskPrimitiveCount: 0,
    generatedTotalPrimitiveCount: 0,
    polygonUnionOperationCount: 0,
    polygonDifferenceOperationCount: 0,
    candidateBlockerCheckCount: 0,
    overlappingBlockerCount: 0,
    outputPolygonCount: 0,
    outputHoleRingCount: 0,
    outputTriangleCount: 0,
    roundedBufferFailureCount: 0,
    flatRibbonFallbackCount: 0,
    surfaceClipFailureCount: 0,
    emptyShapeCount: 0,
    invalidTriangleGeometryCount: 0,
  };

  const roadsByClass = new Map<
    RoadClass,
    Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }>
  >();
  const atGradeRoadEndpoints: [number, number][] = [];
  const renderedSourceIds = new Set<string>();
  const fullySubtractedRoadIds = new Set<string>();
  // Unlike fullySubtractedRoadIds (which also records edge and subsegment IDs),
  // this tracks only original OSM source IDs that had an entirely occluded E2+ subsegment.
  // A source can still have visible geometry elsewhere, so finalize after all edges.
  const e2PlusOccludedSourceCandidates = new Set<string>();

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
    // E2+ deliberately skips junction cuts, patch creation, and continuity miters.
    if (surfaceFirst) continue;
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
    // A path can branch at a cross-tier node as well. Its path-only junction patch
    // must not create a vehicular asphalt junction, and will be clipped under
    // already-rendered vehicular surfaces during the separate path pass.
    if (node.requiresPathJunctionTrimming || (node.isCrossTier && node.pathHalfEdgeCount >= 2)) {
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
        // In an equal-width acute cycleway fork, the complete original-width
        // ribbons already form the correct surface. Cutting them back to make
        // a separate junction patch introduces an artificial square shoulder
        // at the patch/ribbon handoff. Keep the original centerlines untrimmed
        // and let the existing deterministic path-on-path Boolean clipping
        // form their union, preserving individual source provenance.
        const directRibbonFork = pathBranches.length === 3 &&
          node.vehicularHalfEdgeCount === 0 &&
          pathBranches.every((b) => b.roadClass === 'cycleway' &&
            Math.abs(b.width - pathBranches[0].width) < 1e-3) &&
          pathBranches.some((a, i) => pathBranches.some((b, j) =>
            j > i && a.edge.id !== b.edge.id &&
            a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] > 0.90 &&
            a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] < 0.9998
          ));
        // The original source-width ribbons already form a continuous,
        // connected path surface at these small homogeneous junctions. A
        // localized cut/patch creates artificial portal boundaries and
        // separate material-owned wedges ("pizza slices") that aren't in OSM.
        //
        // Extend the existing directRibbonFork strategy conservatively:
        //  - all-path, grade-0 nodes; no steps / motor-carriageway interaction
        //  - 3-arm pedestrian-only T junctions of equal width (Nieuwstraat)
        //  - 4-arm footway/cycleway/pedestrian nodes with almost equal widths
        //    (Hengelo's closely spaced path crossings, 2.2m vs 2.4m).
        //
        // Each whole ribbon still undergoes the normal deterministic 2D
        // clipping against existing higher-priority surfaces. The graph node
        // and every original OSM source ID remain available for inspection.
        const continuousPathClasses = pathBranches.every((b) =>
          b.roadClass === 'footway' ||
          b.roadClass === 'cycleway' ||
          b.roadClass === 'pedestrian'
        );
        const widthRange = Math.max(...pathBranches.map((b) => b.width)) -
          Math.min(...pathBranches.map((b) => b.width));
        const useContinuousRibbons = node.vehicularHalfEdgeCount === 0 &&
          continuousPathClasses &&
          widthRange <= 0.250001 &&
          (pathBranches.length === 4 ||
            (pathBranches.length === 3 &&
              pathBranches.every((b) => b.roadClass === 'pedestrian')));
        if (directRibbonFork || useContinuousRibbons) continue;
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
      // Source-provenance spans may occupy only the first or last few metres of
      // a much longer simplified edge. trimPolylineByArcLength caps each trim
      // at 45% of the entire edge and therefore expands those spans, creating
      // overlapping ribbons, accidental clipping, and misplaced face ranges.
      const subPts = extractPolylineSpan(edge.points, spanStart, spanEnd);
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

  // Track exactly the final polygonal surface, including disconnected components and holes.
  // Registering only the outer ring (or skipping a component) makes subsequent Boolean
  // clipping disagree with the triangles that were actually rendered.
  const registerRoadFootprint = (id: string, isPath: boolean, poly: MultiPolygonCoords) => {
    if (!poly || poly.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const rings of poly) {
      if (!rings[0] || rings[0].length < 4) return;
      for (const ring of rings) {
        for (const [x, z] of ring) {
          if (!Number.isFinite(x) || !Number.isFinite(z)) return;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minZ = Math.min(minZ, z);
          maxZ = Math.max(maxZ, z);
        }
      }
    }
    if (minX < maxX && minZ < maxZ) {
      placedRoadFootprints.push({ id, isPath, minX, maxX, minZ, maxZ, poly });
    }
  };

  // 5. Emit pre-validated, upward-wound junction polygon geometries from localized footprint unions
  const junctionGeometriesByClass = new Map<
    RoadClass,
    Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }>
  >();
  const junctionMultiPolyByFeatureId = new Map<string, MultiPolygonCoords>();

  const emitJunctions = (junctions: PendingJunctionPolygon[], clipPathAgainstVehicular: boolean) => {
  for (const junc of junctions) {
    const {
      junctionFeatureId,
      isPathJunction,
      junctionMultiPoly,
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

    // Path patches must not z-fight with at-grade vehicular ribbons/junctions OR
    // neighboring path-junction patches. Closely-spaced multi-arm path junctions
    // can overlap, even when every incident graph edge is topologically sound.
    // Path patches are emitted highest-class-first, then by canonical node ID;
    // each later patch subtracts previously emitted same-plane ownership.
    // This keeps one surface owner without changing the original road widths.
    let visibleJunctionPoly = junctionMultiPoly;
    if (isPathJunction && clipPathAgainstVehicular) {
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const polygon of junctionMultiPoly) {
        for (const ring of polygon) {
          for (const [x, z] of ring) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minZ = Math.min(minZ, z);
            maxZ = Math.max(maxZ, z);
          }
        }
      }
      const blockers = placedRoadFootprints.filter((fp) =>
        // Other path ribbons have not been emitted yet. Only pre-existing
        // path *junction* patches should block neighboring path patches.
        (!fp.isPath || fp.id.startsWith('path-junction-')) &&
        fp.maxX > minX && fp.minX < maxX &&
        fp.maxZ > minZ && fp.minZ < maxZ
      );
      if (blockers.length > 0) {
        try {
          visibleJunctionPoly = filterDegenerateBooleanArtifacts(
            polygonClipping.difference(
              junctionMultiPoly as unknown as polygonClipping.Geom,
              ...(blockers.map((fp) => fp.poly) as unknown as polygonClipping.Geom[])
            ) as unknown as MultiPolygonCoords
          );
        } catch {
          recordGraphRoadDiagnostic(diagnostics, 'path_junction_surface_clipping_failed', junctionFeatureId);
          stats.rejectedOrDegenerateCount++;
          continue;
        }
      }
    }
    if (visibleJunctionPoly.length === 0) continue;

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

      const effectivePortal =
        resolveEffectivePortalOnJunctionBoundary(
          bPortal.left,
          bPortal.right,
          junctionMultiPoly
        ) ?? bPortal;

      portalConnections.push({
        roadFeatureId: touchingSubId,
        sourceFeatureId: touchingSourceId,
        endpoint: bBranch.endpoint,
        left: bBranch.endpoint === 'start' ? effectivePortal.left : effectivePortal.right,
        right: bBranch.endpoint === 'start' ? effectivePortal.right : effectivePortal.left,
      });
    }

    const shapes = createShapesFromMultiPolygon(visibleJunctionPoly);
    if (shapes.length > 0) {
      const junctionGeo = new THREE.ShapeGeometry(shapes);
      junctionGeo.rotateX(-Math.PI / 2);
      junctionGeo.translate(0, yElev, 0);
      if (junctionGeo.hasAttribute('uv')) junctionGeo.deleteAttribute('uv');

      if (validateAndPruneHorizontalGeometry(junctionGeo)) {
        // Only let subsequent ribbons clip against a junction that was emitted.
        registerRoadFootprint(junctionFeatureId, isPathJunction, visibleJunctionPoly);
        junctionMultiPolyByFeatureId.set(junctionFeatureId, visibleJunctionPoly);
        for (const sid of junctionSourceIdsSet) renderedSourceIds.add(sid);
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

  };

  // Vehicle ribbons are emitted before path patches; this allows path patches to
  // subtract only actually rendered, same-plane vehicular surfaces.
  emitJunctions(pendingJunctions.filter((j) => !j.isPathJunction), false);
  const pathJunctions = pendingJunctions
    .filter((j) => j.isPathJunction)
    .sort((a, b) => {
      const priorityDiff =
        (ROAD_CLASS_PRIORITY[b.dominantBranch.roadClass] ?? 0) -
        (ROAD_CLASS_PRIORITY[a.dominantBranch.roadClass] ?? 0);
      return priorityDiff !== 0
        ? priorityDiff
        : compareStringsCodeUnit(a.nodeId, b.nodeId);
    });
  let pathJunctionsEmitted = false;

  // 6. Build trimmed road ribbons (vehicular edges first, then path-tier edges so paths clip against carriageways)
  const clippedPolysBySubId = new Map<string, MultiPolygonCoords>();
  // Earlier emitted ribbons claim 2D surface footprints and later ribbons are
  // Boolean-clipped against them. Sorting only by OSM edge ID unintentionally gives
  // lower-priority service/parking aisles ownership over the main carriageway when
  // their IDs happen to sort first. Use the SAME road-class priority as the
  // junction's dominant-surface selection, then IDs for deterministic ties.
  const sortedBuildableEdges = [...buildableEdges].sort((a, b) => {
    const aPath = a.tier === 'path' || isNonVehicularRoadClass(a.roadClass) ? 1 : 0;
    const bPath = b.tier === 'path' || isNonVehicularRoadClass(b.roadClass) ? 1 : 0;
    if (aPath !== bPath) return aPath - bPath;
    const classPriorityDiff =
      (ROAD_CLASS_PRIORITY[b.roadClass] ?? 0) -
      (ROAD_CLASS_PRIORITY[a.roadClass] ?? 0);
    if (classPriorityDiff !== 0) return classPriorityDiff;
    return compareStringsCodeUnit(a.id, b.id);
  });

  for (const edge of sortedBuildableEdges) {
    const isPathEdge = edge.tier === 'path' || isNonVehicularRoadClass(edge.roadClass);
    if (isPathEdge && !pathJunctionsEmitted) {
      emitJunctions(pathJunctions, true);
      pathJunctionsEmitted = true;
    }
    const subSegments = resolvedSubSegmentsByEdgeId.get(edge.id);
    if (!subSegments || subSegments.length === 0) continue;

    let surfaceFirstSubCaps: Array<{ capStart: boolean; capEnd: boolean }> | undefined;
    if (surfaceFirst) {
      const startNode = descriptors.roadNodesById.get(edge.fromNodeId);
      const endNode = descriptors.roadNodesById.get(edge.toNodeId);
      const hasGradeStart = Boolean(
        edge.startGradeTransitionId ||
          startNode?.gradeTransitionIds.length ||
          startNode?.incidentEdgeIds.some(
            (id) => !descriptors.roadEdgesById.get(id)?.isAtGradeBuildable
          )
      );
      const hasGradeEnd = Boolean(
        edge.endGradeTransitionId ||
          endNode?.gradeTransitionIds.length ||
          endNode?.incidentEdgeIds.some(
            (id) => !descriptors.roadEdgesById.get(id)?.isAtGradeBuildable
          )
      );
      surfaceFirstSubCaps = subSegments.map((_, idx) => ({
        capStart:
          idx === 0 &&
          !edge.isClosedLoop &&
          !edge.clippedAtStart &&
          !startNode?.isBoundaryClipped &&
          !hasGradeStart,
        capEnd:
          idx === subSegments.length - 1 &&
          !edge.isClosedLoop &&
          !edge.clippedAtEnd &&
          !endNode?.isBoundaryClipped &&
          !hasGradeEnd,
      }));
      if (subSegments.length > 1) {
        for (let idx = 0; idx < subSegments.length - 1; idx++) {
          const subA = subSegments[idx];
          const subB = subSegments[idx + 1];
          const { capEndOnA, capStartOnB } = resolveInternalProvenanceBoundaryCaps(
            {
              id: subA.subId,
              sourceKey: subA.seg.partId || subA.sourceFeatureId,
              points: subA.points,
              width: subA.width,
            },
            {
              id: subB.subId,
              sourceKey: subB.seg.partId || subB.sourceFeatureId,
              points: subB.points,
              width: subB.width,
            }
          );
          if (capEndOnA) surfaceFirstSubCaps[idx].capEnd = true;
          if (capStartOnB) surfaceFirstSubCaps[idx + 1].capStart = true;
        }
        if (edge.isClosedLoop) {
          const lastIdx = subSegments.length - 1;
          const subA = subSegments[lastIdx];
          const subB = subSegments[0];
          const { capEndOnA, capStartOnB } = resolveInternalProvenanceBoundaryCaps(
            {
              id: subA.subId,
              sourceKey: subA.seg.partId || subA.sourceFeatureId,
              points: subA.points,
              width: subA.width,
            },
            {
              id: subB.subId,
              sourceKey: subB.seg.partId || subB.sourceFeatureId,
              points: subB.points,
              width: subB.width,
            }
          );
          if (capEndOnA) surfaceFirstSubCaps[lastIdx].capEnd = true;
          if (capStartOnB) surfaceFirstSubCaps[0].capStart = true;
        }
      }
    }

    for (let subIdx = 0; subIdx < subSegments.length; subIdx++) {
      const sub = subSegments[subIdx];
      try {
        let pts = sub.points;
        if (pts.length < 2) {
          stats.rejectedOrDegenerateCount++;
          continue;
        }
        const { width, roadElevation, isPath, sourceFeatureIds: sids } = sub;
        let activeStartPortal = sub.startPortal;
        let activeEndPortal = sub.endPortal;

        stats.processedProvenanceSegmentCount++;

        const isClosedSubLoop =
          pts.length >= 4 &&
          Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <
            0.05;

        if (surfaceFirst) {
          // Experimental continuous-stroke path: no trimmed junction portals.
          // The same graph, widths, provenance and surface-ownership priorities
          // as E2 are retained; only the footprint generator changes.
          const { capStart, capEnd } = surfaceFirstSubCaps![subIdx];

          let stroke: MultiPolygonCoords = [];
          try {
            stroke = bufferSurfaceFirstRoadCenterline(
              pts,
              width,
              { capStart, capEnd },
              bufferInstrumentation
            );
          } catch {
            stats.roundedBufferFailureCount++;
            recordGraphRoadDiagnostic(diagnostics, 'e2plus_rounded_buffer_failed', sub.subId);
          }
          if (stroke.length === 0) {
            const fallback = buildRoadRibbonOutlineRing(cleanPolylineForClipping(pts), width);
            if (fallback && fallback[0] && !hasRingSelfIntersection(fallback[0])) {
              stroke = [fallback];
              stats.flatRibbonFallbackCount++;
              recordGraphRoadDiagnostic(diagnostics, 'e2plus_flat_ribbon_fallback', sub.subId);
            } else {
              stats.rejectedOrDegenerateCount++;
              continue;
            }
          }

          const tClipStart = performance.now();
          const ptsOnSurface = stroke.flatMap((polygon) => polygon.flat());
          const minX = Math.min(...ptsOnSurface.map((p) => p[0]));
          const maxX = Math.max(...ptsOnSurface.map((p) => p[0]));
          const minZ = Math.min(...ptsOnSurface.map((p) => p[1]));
          const maxZ = Math.max(...ptsOnSurface.map((p) => p[1]));
          stats.candidateBlockerCheckCount += placedRoadFootprints.length;
          const blockers = placedRoadFootprints.filter((fp) =>
            (isPath || !fp.isPath) && fp.maxX > minX && fp.minX < maxX &&
            fp.maxZ > minZ && fp.minZ < maxZ
          );
          stats.overlappingBlockerCount += blockers.length;
          try {
            if (blockers.length > 0) {
              stats.polygonDifferenceOperationCount++;
            }
            const visible = blockers.length > 0
              ? filterDegenerateBooleanArtifacts(polygonClipping.difference(
                  stroke as unknown as polygonClipping.Geom,
                  ...(blockers.map((fp) => fp.poly) as unknown as polygonClipping.Geom[])
                ) as unknown as MultiPolygonCoords)
              : stroke;
            timing.ownershipClippingTimeMs += performance.now() - tClipStart;
            if (visible.length === 0) {
              stats.fullySubtractedCount++;
              fullySubtractedRoadIds.add(sub.subId);
              fullySubtractedRoadIds.add(edge.id);
              for (const sid of sids) {
                fullySubtractedRoadIds.add(sid);
                e2PlusOccludedSourceCandidates.add(sid);
              }
              continue;
            }
            const tTriStart = performance.now();
            const shapes = createShapesFromMultiPolygon(visible);
            if (shapes.length === 0) {
              timing.triangulationAndValidationTimeMs += performance.now() - tTriStart;
              stats.emptyShapeCount++;
              stats.rejectedOrDegenerateCount++;
              recordGraphRoadDiagnostic(diagnostics, 'e2plus_empty_shapes', sub.subId);
              continue;
            }
            const geo = new THREE.ShapeGeometry(shapes);
            geo.rotateX(-Math.PI / 2);
            geo.translate(0, roadElevation, 0);
            if (geo.hasAttribute('uv')) geo.deleteAttribute('uv');
            if (!validateAndPruneHorizontalGeometry(geo)) {
              timing.triangulationAndValidationTimeMs += performance.now() - tTriStart;
              geo.dispose();
              stats.invalidTriangleGeometryCount++;
              stats.rejectedOrDegenerateCount++;
              recordGraphRoadDiagnostic(diagnostics, 'e2plus_invalid_triangles', sub.subId);
              continue;
            }
            timing.triangulationAndValidationTimeMs += performance.now() - tTriStart;
            resourceManager.registerGeometry(geo);
            registerRoadFootprint(sub.subId, isPath, visible);
            stats.outputPolygonCount += visible.length;
            for (const poly of visible) {
              if (poly.length > 1) {
                stats.outputHoleRingCount += poly.length - 1;
              }
            }
            const name = typeof sub.seg.osmTags?.name === 'string'
              ? sub.seg.osmTags.name.trim() : edge.name;
            const cartoLabel = formatRoadCartoLabel(edge.roadClass);
            const roadInfo: InspectableFeatureInfo = {
              id: sub.subId,
              sourceFeatureId: sub.sourceFeatureId,
              sourceFeatureIds: sub.sourceFeatureIds,
              name: name || cartoLabel,
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
            if (!roadsByClass.has(edge.roadClass)) roadsByClass.set(edge.roadClass, []);
            roadsByClass.get(edge.roadClass)!.push({ geom: geo, info: roadInfo });
            stats.renderedRoadRibbonCount++;
            for (const sid of sids) renderedSourceIds.add(sid);
            if (edge.roadClass === 'steps') {
              const treadGeo = generateGraphStepTreads(
                pts, width, roadElevation + ELEVATION_POLICY.STEP_TREAD_OFFSET
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
          } catch {
            timing.ownershipClippingTimeMs += performance.now() - tClipStart;
            stats.surfaceClipFailureCount++;
            stats.rejectedOrDegenerateCount++;
            recordGraphRoadDiagnostic(diagnostics, 'e2plus_surface_clip_failed', sub.subId);
          }
          continue;
        }

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
            // Skip footprints that share an exact 1D unclamped portal with this sub-segment
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

            let requiresClipping = outlineHasSelfIntersection;
            const overlappingPolys: MultiPolygonCoords[] = [];
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
                  const interArea = computeMultiPolygonArea(cleanedInter);
                  const minTriggerArea = sub.exemptFootprintIds.has(fp.id) ? 5e-4 : 0;
                  if (cleanedInter.length > 0 && interArea > minTriggerArea) {
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
                  if (!sub.exemptFootprintIds.has(fp.id)) {
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
              }
            } else {
              for (const fp of candidateFootprints) {
                if (sub.exemptFootprintIds.has(fp.id)) continue;
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
                // Grid snapping in the remainder filter can introduce folded boundaries.
                // Resolve them before triangulation, then use this same surface for
                // clipping footprints and junction portal reconciliation.
                if (diffResult.length > 0) {
                  diffResult = polygonClipping.union(diffResult) as MultiPolygonCoords;
                }
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
                      if (subOutline) registerRoadFootprint(sub.subId, isPath, [subOutline]);
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
            if (candidateGeo) {
              outlinePoly = buildGraphRibbonPolygonRing(pts, width, {
                hasStartCap: sub.hasCapStart,
                hasEndCap: sub.hasCapEnd,
              });
            }
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
                activeStartPortal = undefined;
                activeEndPortal = undefined;
                outlinePoly = buildGraphRibbonPolygonRing(pts, width, {
                  hasStartCap: sub.hasCapStart,
                  hasEndCap: sub.hasCapEnd,
                });
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
          clippedPolysBySubId.set(sub.subId, resolvedClippedPolys);
          registerRoadFootprint(sub.subId, isPath, resolvedClippedPolys);
        } else if (isClosedSubLoop) {
          const midIdx = Math.floor(pts.length / 2);
          if (midIdx >= 1 && pts.length - midIdx >= 2) {
            const half1 = buildRoadRibbonOutlineRing(pts.slice(0, midIdx + 1), width, {
              startPortal: activeStartPortal,
            });
            const half2 = buildRoadRibbonOutlineRing(pts.slice(midIdx), width, {
              endPortal: activeEndPortal,
            });
            if (half1) registerRoadFootprint(`${sub.subId}#h1`, isPath, [half1]);
            if (half2) registerRoadFootprint(`${sub.subId}#h2`, isPath, [half2]);
          }
        } else if (outlinePoly) {
          registerRoadFootprint(sub.subId, isPath, [outlinePoly]);
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



  if (!pathJunctionsEmitted) emitJunctions(pathJunctions, true);

  // 7. Synchronize junction portalConnections against any clipped or fully-subtracted road ribbons
  // and append junction geometries into their corresponding road class buckets.
  junctionGeometriesByClass.forEach((items, roadClass) => {
    for (const item of items) {
      const conns = item.info.portalConnections;
      const juncPoly = junctionMultiPolyByFeatureId.get(item.info.id);
      if (Array.isArray(conns) && juncPoly) {
        const refinedConns: RoadPortalConnectionSpec[] = [];
        for (const c of conns) {
          if (fullySubtractedRoadIds.has(c.roadFeatureId)) {
            continue;
          }
          const clippedRoadPoly = clippedPolysBySubId.get(c.roadFeatureId);
          if (clippedRoadPoly) {
            const rawLeft = c.endpoint === 'start' ? c.left : c.right;
            const rawRight = c.endpoint === 'start' ? c.right : c.left;
            const resolved = resolveEffectivePortalOnJunctionBoundary(
              rawLeft,
              rawRight,
              juncPoly,
              clippedRoadPoly
            );
            if (resolved) {
              refinedConns.push({
                ...c,
                left: c.endpoint === 'start' ? resolved.left : resolved.right,
                right: c.endpoint === 'start' ? resolved.right : resolved.left,
              });
            } else {
              refinedConns.push(c);
            }
          } else {
            refinedConns.push(c);
          }
        }
        item.info.portalConnections = refinedConns;
      }
    }
    if (!roadsByClass.has(roadClass)) {
      roadsByClass.set(roadClass, []);
    }
    roadsByClass.get(roadClass)!.push(...items);
  });

  // Finalize aggregate primitive, polygon, triangle, and timing counters
  if (surfaceFirst) {
    stats.generatedRectanglePrimitiveCount = bufferInstrumentation.rectanglePrimitiveCount;
    stats.generatedBendDiskPrimitiveCount = bufferInstrumentation.bendDiskPrimitiveCount;
    stats.generatedCapDiskPrimitiveCount = bufferInstrumentation.capDiskPrimitiveCount;
    stats.generatedDiskPrimitiveCount =
      bufferInstrumentation.bendDiskPrimitiveCount + bufferInstrumentation.capDiskPrimitiveCount;
    stats.generatedTotalPrimitiveCount =
      stats.generatedRectanglePrimitiveCount + stats.generatedDiskPrimitiveCount;
    stats.polygonUnionOperationCount = bufferInstrumentation.unionOperationCount;
    timing.primitiveConstructionTimeMs = bufferInstrumentation.primitiveConstructionTimeMs;
    timing.polygonUnionTimeMs = bufferInstrumentation.polygonUnionTimeMs;
    timing.footprintConstructionTimeMs =
      bufferInstrumentation.primitiveConstructionTimeMs + bufferInstrumentation.polygonUnionTimeMs;
  } else {
    for (const fp of placedRoadFootprints) {
      stats.outputPolygonCount += fp.poly.length;
      for (const poly of fp.poly) {
        if (poly.length > 1) {
          stats.outputHoleRingCount += poly.length - 1;
        }
      }
    }
  }

  let totalEmittedTriangles = 0;
  roadsByClass.forEach((items) => {
    for (const item of items) {
      const idx = item.geom.getIndex();
      const pos = item.geom.getAttribute('position');
      const triCount = idx
        ? Math.floor(idx.count / 3)
        : pos
          ? Math.floor(pos.count / 3)
          : 0;
      totalEmittedTriangles += triCount;
    }
  });
  stats.outputTriangleCount = totalEmittedTriangles;
  timing.totalRoadGenerationTimeMs = performance.now() - tTotalStart;

  if (surfaceFirst && diagnostics) {
    // Report fully removed *source features*, not provenance subsegments.
    // One source can be split across multiple edges and may remain visible
    // even if some of its subsegments were completely subtracted.
    const fullyOccludedSourceIds = [...e2PlusOccludedSourceCandidates]
      .filter((sourceId) => !renderedSourceIds.has(sourceId))
      .sort(compareStringsCodeUnit);
    if (fullyOccludedSourceIds.length > 0) {
      const summary = diagnostics.featuresFullySubtracted ??
        (diagnostics.featuresFullySubtracted = { count: 0, sampleIds: [] });
      summary.count += fullyOccludedSourceIds.length;
      for (const sourceId of fullyOccludedSourceIds) {
        if (summary.sampleIds.length >= 10) break;
        if (!summary.sampleIds.includes(sourceId)) {
          summary.sampleIds.push(sourceId);
        }
      }
    }
  }

  return {
    roadsByClass,
    atGradeRoadEndpoints,
    renderedSourceIds,
    fullySubtractedRoadIds,
    stats,
    timing,
  };
}
