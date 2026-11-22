import * as THREE from 'three';
import polygonClipping from 'polygon-clipping';
import {
  bufferSurfaceFirstRoadCenterline,
  resolveInternalProvenanceBoundaryCaps,
  type SurfaceFirstBufferInstrumentation,
} from './SurfaceFirstRoadFootprints';
import {
  InspectableFeatureInfo,
  ProcessedMapData,
  RoadClass,
} from '../../../types/MapFeature';
import {
  ELEVATION_POLICY,
  getRoadElevation,
  isNonVehicularRoadClass,
} from '../../ElevationPolicy';
import { computePolylineLength } from '../../BridgeAndTunnelBuilder';
import {
  MultiPolygonCoords,
  filterDegenerateBooleanArtifacts,
} from '../../PlanarLayerValidator';
import { SceneResourceManager } from '../../SceneResourceManager';
import { resolveSurfaceVisibility } from '../../SurfaceVisibilityPolicy';
import {
  buildRoadRibbonOutlineRing,
  cleanPolylineForClipping,
  createShapesFromMultiPolygon,
  FaceFeatureRange,
  hasRingSelfIntersection,
  sanitizeOsmTags,
} from '../../GeometryBuilder';
import {
  clipBufferGeometryToBoxXZ,
  type ClipBox2D,
} from '../../tiling/MeshBoxClipper';
import {
  compareStringsCodeUnit,
  EdgeSegmentProvenance,
} from '../topology/InfrastructureGraph';
import {
  InfrastructureRenderDescriptorBundle,
  RoadEdgeRenderDescriptor,
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
  'Tunnel_Underground_Roads',
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
export interface RoadGeometryTraceEvent {
  sourceFeatureId: string;
  edgeId: string;
  subId: string;
  stage:
    | 'filtered-visibility' | 'invalid-edge' | 'invalid-subsegment'
    | 'stroke-empty' | 'fully-subtracted' | 'bbox-outside'
    | 'empty-shapes' | 'invalid-triangles' | 'clip-empty' | 'clip-invalid'
    | 'fault-injected-rejection' | 'emitted' | 'exception';
  /** First unexpected triangle on a validation failure, if one exists. */
  invalidTriangle?: {
    faceIndex: number;
    reason: 'nonfinite' | 'non-upward' | 'no-valid-faces';
    areaSquareMeters?: number;
    normalY?: number;
    vertices?: [number, number, number][];
  };
  triangleCount?: number;
  polygonCount?: number;
  blockerCount?: number;
  message?: string;
}

export interface RoadGeometryTraceTarget {
  sourceId: string;
  events: RoadGeometryTraceEvent[];
}

function findFirstInvalidRoadTriangle(
  geo: THREE.BufferGeometry
): RoadGeometryTraceEvent['invalidTriangle'] {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return { faceIndex: -1, reason: 'no-valid-faces' };
  const idx = geo.getIndex();
  const n = Math.floor((idx?.count ?? pos.count) / 3);
  let valid = 0;
  for (let i = 0; i < n; i++) {
    const ids = [0, 1, 2].map(j => idx ? idx.getX(i * 3 + j) : i * 3 + j);
    const verts = ids.map(j => [pos.getX(j), pos.getY(j), pos.getZ(j)] as [number, number, number]);
    if (verts.some(v => v.some(x => !Number.isFinite(x)))) {
      return { faceIndex: i, reason: 'nonfinite', vertices: verts };
    }
    const [a,b,c] = verts;
    const ab = [b[0]-a[0],b[1]-a[1],b[2]-a[2]];
    const ac = [c[0]-a[0],c[1]-a[1],c[2]-a[2]];
    const crossY = ab[2]*ac[0]-ab[0]*ac[2];
    const crossX = ab[1]*ac[2]-ab[2]*ac[1];
    const crossZ = ab[0]*ac[1]-ab[1]*ac[0];
    const doubleArea = Math.hypot(crossX,crossY,crossZ);
    const area = doubleArea * 0.5;
    if (area <= MIN_NONDEGENERATE_TRIANGLE_AREA_M2) continue;
    const normalY = crossY / doubleArea;
    if (normalY <= 0.99) {
      return { faceIndex: i, reason: 'non-upward', areaSquareMeters: area,
        normalY, vertices: verts };
    }
    valid++;
  }
  return valid === 0 ? { faceIndex: -1, reason: 'no-valid-faces' } : undefined;
}

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
  /** Optional tile XZ bounds; when provided, clips emitted road/step meshes to exact tile boundaries after priority subtraction. */
  tileClipBounds?: ClipBox2D;
  /**
   * Test-only fault injection: simulate a late triangulation rejection for a
   * specific source ID. Never used by the app or the offline tile baker.
   * Lets regression tests prove a non-emitted road cannot occlude later roads.
   */
  testOnlyRejectAfterTriangulation?: (sourceFeatureId: string) => boolean;
  /** Optional, read-only, source-filtered trace of actual road generation decisions. */
  roadGeometryTrace?: RoadGeometryTraceTarget;
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

interface EdgeTrimState {
  start?: [number, number];
  end?: [number, number];
}

interface ResolvedEdgeSubSegment {
  subId: string;
  edge: RoadEdgeRenderDescriptor;
  seg: EdgeSegmentProvenance;
  points: [number, number][];
  width: number;
  roadElevation: number;
  isPath: boolean;
  sourceFeatureId: string;
  sourceFeatureIds: string[];
  osmTags: Record<string, string | number | boolean>;
}

interface PlacedRoadFootprint {
  orderIdx: number;
  id: string;
  isPath: boolean;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  poly: MultiPolygonCoords;
}

const ROAD_SPATIAL_GRID_CELL_SIZE = 32;
const ROAD_SPATIAL_CELL_OFFSET = 32768;
const ROAD_SPATIAL_CELL_STRIDE = 65536;
const ROAD_SPATIAL_MAX_CELLS_PER_ITEM = 4096;

class RoadFootprintSpatialGrid {
  private readonly cellSize = ROAD_SPATIAL_GRID_CELL_SIZE;
  private readonly cells = new Map<number, number[]>();
  private readonly oversized: number[] = [];
  private seenStamp = new Int32Array(1024);
  private currentStamp = 1;

  private ensureStampCapacity(id: number): void {
    if (id < this.seenStamp.length) return;
    let nextCap = this.seenStamp.length * 2;
    while (nextCap <= id) nextCap *= 2;
    const next = new Int32Array(nextCap);
    next.set(this.seenStamp);
    this.seenStamp = next;
  }

  insert(orderIdx: number, minX: number, maxX: number, minZ: number, maxZ: number): void {
    this.ensureStampCapacity(orderIdx);
    const minCx = Math.floor(minX / this.cellSize);
    const maxCx = Math.floor(maxX / this.cellSize);
    const minCz = Math.floor(minZ / this.cellSize);
    const maxCz = Math.floor(maxZ / this.cellSize);
    if (
      !Number.isFinite(minCx) ||
      !Number.isFinite(maxCx) ||
      !Number.isFinite(minCz) ||
      !Number.isFinite(maxCz) ||
      minCx < -ROAD_SPATIAL_CELL_OFFSET ||
      maxCx >= ROAD_SPATIAL_CELL_OFFSET ||
      minCz < -ROAD_SPATIAL_CELL_OFFSET ||
      maxCz >= ROAD_SPATIAL_CELL_OFFSET ||
      (maxCx - minCx + 1) * (maxCz - minCz + 1) > ROAD_SPATIAL_MAX_CELLS_PER_ITEM
    ) {
      this.oversized.push(orderIdx);
      return;
    }
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const key =
          (cx + ROAD_SPATIAL_CELL_OFFSET) * ROAD_SPATIAL_CELL_STRIDE +
          (cz + ROAD_SPATIAL_CELL_OFFSET);
        let bucket = this.cells.get(key);
        if (!bucket) {
          bucket = [];
          this.cells.set(key, bucket);
        }
        bucket.push(orderIdx);
      }
    }
  }

  query(minX: number, maxX: number, minZ: number, maxZ: number, out: number[]): void {
    out.length = 0;
    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(minZ) ||
      !Number.isFinite(maxZ)
    ) {
      return;
    }
    this.currentStamp++;
    if (this.currentStamp >= 0x7fffffff) {
      this.seenStamp.fill(0);
      this.currentStamp = 1;
    }
    const stamp = this.currentStamp;

    for (let k = 0; k < this.oversized.length; k++) {
      const id = this.oversized[k];
      if (this.seenStamp[id] !== stamp) {
        this.seenStamp[id] = stamp;
        out.push(id);
      }
    }

    const minCx = Math.floor(minX / this.cellSize);
    const maxCx = Math.floor(maxX / this.cellSize);
    const minCz = Math.floor(minZ / this.cellSize);
    const maxCz = Math.floor(maxZ / this.cellSize);

    if (
      minCx < -ROAD_SPATIAL_CELL_OFFSET ||
      maxCx >= ROAD_SPATIAL_CELL_OFFSET ||
      minCz < -ROAD_SPATIAL_CELL_OFFSET ||
      maxCz >= ROAD_SPATIAL_CELL_OFFSET ||
      (maxCx - minCx + 1) * (maxCz - minCz + 1) > ROAD_SPATIAL_MAX_CELLS_PER_ITEM
    ) {
      this.cells.forEach((bucket) => {
        for (let k = 0; k < bucket.length; k++) {
          const id = bucket[k];
          if (this.seenStamp[id] !== stamp) {
            this.seenStamp[id] = stamp;
            out.push(id);
          }
        }
      });
    } else {
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          const key =
            (cx + ROAD_SPATIAL_CELL_OFFSET) * ROAD_SPATIAL_CELL_STRIDE +
            (cz + ROAD_SPATIAL_CELL_OFFSET);
          const bucket = this.cells.get(key);
          if (!bucket) continue;
          for (let k = 0; k < bucket.length; k++) {
            const id = bucket[k];
            if (this.seenStamp[id] !== stamp) {
              this.seenStamp[id] = stamp;
              out.push(id);
            }
          }
        }
      }
    }

    if (out.length > 1) {
      out.sort((a, b) => a - b);
    }
  }
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
 * Distinguish a genuinely reversed triangle from a near-collinear
 * triangulation sliver whose winding is below Float32 position resolution.
 *
 * Three.js ShapeGeometry stores vertices in Float32. At, for example,
 * local Z=-387m the coordinate spacing is about 0.0000305m; a sliver thinner
 * than that can change its signed area solely through rounding. Removing it
 * is safer than rejecting the entire otherwise valid road ribbon.
 *
 * This is deliberately a precision-relative criterion rather than a blanket
 * area threshold: a large, visibly inverted face still fails validation.
 */
function hasUnresolvableFloat32Winding(
  vertices: readonly (readonly [number, number])[],
  areaSquareMeters: number
): boolean {
  let largestEdge = 0;
  let maxAbsoluteCoordinate = 0;
  for (let i = 0; i < 3; i++) {
    const [x, z] = vertices[i];
    const [nx, nz] = vertices[(i + 1) % 3];
    largestEdge = Math.max(largestEdge, Math.hypot(nx - x, nz - z));
    maxAbsoluteCoordinate = Math.max(maxAbsoluteCoordinate, Math.abs(x), Math.abs(z));
  }
  if (largestEdge <= 0) return true;

  // The spacing between neighboring normal Float32 values at this coordinate
  // magnitude; subnormal values are already handled by the 1e-6m² area floor.
  const float32Ulp = 2 ** (Math.floor(Math.log2(
    Math.max(maxAbsoluteCoordinate, 2 ** -126)
  )) - 23);
  const altitude = (2 * areaSquareMeters) / largestEdge;
  return altitude <= 2 * float32Ulp;
}

/**
 * Validates and cleans a horizontal road/path/step/junction `BufferGeometry` in place:
 * - Rejects all visibly inverted triangles (`geomNormal.y <= 0.99`) rather than reversing indices.
 *   Tiny near-collinear triangles with altitude below Float32 coordinate spacing are
 *   pruned instead, because their winding cannot be represented reliably.
 * - Filters out zero-area collinear sliver triangles (`area <= 1e-6 m²`) emitted by earcut or pinched quads.
 * - Ensures stored vertex normals on all active vertices are `[0, 1, 0]`.
 *
 * Returns `true` if at least one valid upward-facing triangle remains and
 * no resolvably inverted triangles exist; otherwise returns `false`.
 */
export function validateAndPruneHorizontalGeometry(geo: THREE.BufferGeometry): boolean {
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
      // The polygon tessellator may produce micrometre-scale slivers whose
      // Float32 vertex rounding reverses their apparent winding. Drop only
      // those unresolvable faces; keep rejecting genuine inversions.
      if (hasUnresolvableFloat32Winding(
        [[x0, z0], [x1, z1], [x2, z2]], area
      )) {
        continue;
      }
      return false;
    }

    validIndices.push(i0, i1, i2);
  }

  if (validIndices.length < 3) {
    return false;
  }

  geo.setIndex(validIndices);
  geo.clearGroups();

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
 * Sanitizes a sub-segment centerline polyline while preserving interior curve vertices.
 */
function sanitizeSubSegmentPolyline(rawPoints: [number, number][]): [number, number][] {
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
  return pts;
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
    tileClipBounds,
  } = options;
  void options.surfaceFirst;

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

  const trace = options.roadGeometryTrace;
  const recordTrace = (
    edge: RoadEdgeRenderDescriptor,
    subId: string,
    stage: RoadGeometryTraceEvent['stage'],
    details: Pick<RoadGeometryTraceEvent, 'invalidTriangle' | 'triangleCount' | 'polygonCount' | 'blockerCount' | 'message'> = {}
  ): void => {
    if (!trace || !edge.sourceFeatureIds.includes(trace.sourceId)) return;
    trace.events.push({
      sourceFeatureId: trace.sourceId,
      edgeId: edge.id, subId, stage, ...details,
    });
  };

  const isEligibleSurfaceEdge = (edge: RoadEdgeRenderDescriptor): boolean =>
    edge.isAtGradeBuildable && resolveSurfaceVisibility({
      osmTags: edge.primaryOsmTags,
      placementClassification: edge.placementClassification,
      layer: edge.layer,
      isBridge: edge.isBridge,
      isTunnel: edge.isTunnel,
    }) === 'surface';

  // 1. Filter at-grade buildable road edges and initialize endpoint trim states
  const buildableEdges: RoadEdgeRenderDescriptor[] = [];
  const trimmedEndpoints = new Map<string, EdgeTrimState>();
  const gradeTransitionsById = new Map(
    descriptors.gradeTransitions.map((gt) => [gt.id, gt])
  );

  for (const edge of descriptors.roadEdges) {
    if (!isEligibleSurfaceEdge(edge)) {
      recordTrace(edge, edge.id, 'filtered-visibility', {
        message: 'isAtGradeBuildable=' + edge.isAtGradeBuildable,
      });
      continue;
    }
    stats.atGradeRoadEdgeCount++;

    if (!edge.points || edge.points.length < 2) {
      stats.rejectedOrDegenerateCount++;
      recordTrace(edge, edge.id, 'invalid-edge', { message: 'less than two points' });
      continue;
    }
    const len = computePolylineLength(edge.points as [number, number][]);
    if (!Number.isFinite(len) || len < 0.05) {
      stats.rejectedOrDegenerateCount++;
      recordTrace(edge, edge.id, 'invalid-edge', { message: 'length=' + len });
      continue;
    }

    buildableEdges.push(edge);
    for (const pt of edge.points) {
      atGradeRoadEndpoints.push([pt[0], pt[1]]);
    }

    const startNode = descriptors.roadNodesById.get(edge.fromNodeId);
    const endNode = descriptors.roadNodesById.get(edge.toNodeId);

    const startGt = edge.startGradeTransitionId
      ? gradeTransitionsById.get(edge.startGradeTransitionId)
      : startNode && startNode.gradeTransitionIds.length === 1
        ? gradeTransitionsById.get(startNode.gradeTransitionIds[0])
        : undefined;
    const endGt = edge.endGradeTransitionId
      ? gradeTransitionsById.get(edge.endGradeTransitionId)
      : endNode && endNode.gradeTransitionIds.length === 1
        ? gradeTransitionsById.get(endNode.gradeTransitionIds[0])
        : undefined;

    trimmedEndpoints.set(edge.id, {
      start: startGt ? [startGt.position[0], startGt.position[1]] : undefined,
      end: endGt ? [endGt.position[0], endGt.position[1]] : undefined,
    });
  }

  for (const node of descriptors.roadNodes) {
    if (node.isCrossTierOnlyInteraction) {
      stats.crossTierOnlyNodeCount++;
    }
  }

  // 2. Resolve per-segment provenance sub-polylines for all buildable edges
  // so multi-source simplified edges carry accurate per-segment InspectableFeatureInfo.
  const resolvedSubSegmentsByEdgeId = new Map<string, ResolvedEdgeSubSegment[]>();

  for (const edge of buildableEdges) {
    const tInfo = trimmedEndpoints.get(edge.id)!;
    const width = edge.width * roadWidthMultiplier;
    const totalLen = computePolylineLength(edge.points as [number, number][]);
    const sStart = 0;
    const sEnd = Math.max(totalLen, 0.05);

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
      const subPts = extractPolylineSpan(edge.points, spanStart, spanEnd);
      if (j === 0 && tInfo.start && subPts.length >= 2) {
        subPts[0] = [tInfo.start[0], tInfo.start[1]];
      }
      if (j === m - 1 && tInfo.end && subPts.length >= 2) {
        subPts[subPts.length - 1] = [tInfo.end[0], tInfo.end[1]];
      }
      subPolylines.push(subPts);
    }

    const subSegments: ResolvedEdgeSubSegment[] = [];
    for (let j = 0; j < m; j++) {
      const { seg } = activeSpans[j];
      const subId = m === 1 ? edge.id : `${edge.id}#seg${j}`;
      const sids = [seg.sourceFeatureId, ...seg.deduplicatedFeatureIds];
      const uniqueSids = [...new Set(sids)];
      const sanitizedPts = sanitizeSubSegmentPolyline(subPolylines[j]);

      subSegments.push({
        subId,
        edge,
        seg,
        points: sanitizedPts,
        width,
        roadElevation,
        isPath,
        sourceFeatureId: seg.sourceFeatureId,
        sourceFeatureIds: uniqueSids,
        osmTags: sanitizeOsmTags(seg.osmTags),
      });
    }

    resolvedSubSegmentsByEdgeId.set(edge.id, subSegments);
  }

  // 4. Track 2D polygon footprints of placed junctions and road ribbons for Boolean clipping
  const placedRoadFootprints: PlacedRoadFootprint[] = [];
  const roadFootprintGrid = new RoadFootprintSpatialGrid();
  const gridQueryCandidates: number[] = [];

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
      const orderIdx = placedRoadFootprints.length;
      placedRoadFootprints.push({ orderIdx, id, isPath, minX, maxX, minZ, maxZ, poly });
      roadFootprintGrid.insert(orderIdx, minX, maxX, minZ, maxZ);
    }
  };

  // 4. Build E2+ surface-first road footprints (vehicular edges first by class priority, then path-tier edges)
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
    const subSegments = resolvedSubSegmentsByEdgeId.get(edge.id);
    if (!subSegments || subSegments.length === 0) continue;

    const startNode = descriptors.roadNodesById.get(edge.fromNodeId);
    const endNode = descriptors.roadNodesById.get(edge.toNodeId);
    const hasGradeStart = Boolean(
      edge.startGradeTransitionId ||
        startNode?.gradeTransitionIds.length ||
        startNode?.incidentEdgeIds.some(
          (id) => !descriptors.roadEdgesById.get(id) || !isEligibleSurfaceEdge(descriptors.roadEdgesById.get(id)!)
        )
    );
    const hasGradeEnd = Boolean(
      edge.endGradeTransitionId ||
        endNode?.gradeTransitionIds.length ||
        endNode?.incidentEdgeIds.some(
          (id) => !descriptors.roadEdgesById.get(id) || !isEligibleSurfaceEdge(descriptors.roadEdgesById.get(id)!)
        )
    );
    const surfaceFirstSubCaps = subSegments.map((_, idx) => ({
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

    for (let subIdx = 0; subIdx < subSegments.length; subIdx++) {
      const sub = subSegments[subIdx];
      try {
        const pts = sub.points;
        if (pts.length < 2) {
          stats.rejectedOrDegenerateCount++;
          recordTrace(edge, sub.subId, 'invalid-subsegment');
          continue;
        }
        const { width, roadElevation, isPath, sourceFeatureIds: sids } = sub;

        stats.processedProvenanceSegmentCount++;

        const { capStart, capEnd } = surfaceFirstSubCaps[subIdx];

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
            recordTrace(edge, sub.subId, 'stroke-empty');
            continue;
          }
        }

        const tClipStart = performance.now();
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let pi = 0; pi < stroke.length; pi++) {
          const polygon = stroke[pi];
          for (let ri = 0; ri < polygon.length; ri++) {
            const ring = polygon[ri];
            for (let vi = 0; vi < ring.length; vi++) {
              const pt = ring[vi];
              if (pt[0] < minX) minX = pt[0];
              if (pt[0] > maxX) maxX = pt[0];
              if (pt[1] < minZ) minZ = pt[1];
              if (pt[1] > maxZ) maxZ = pt[1];
            }
          }
        }
        roadFootprintGrid.query(minX, maxX, minZ, maxZ, gridQueryCandidates);
        stats.candidateBlockerCheckCount += gridQueryCandidates.length;
        const blockers: PlacedRoadFootprint[] = [];
        for (let ci = 0; ci < gridQueryCandidates.length; ci++) {
          const fp = placedRoadFootprints[gridQueryCandidates[ci]];
          if (
            (isPath || !fp.isPath) &&
            fp.maxX > minX &&
            fp.minX < maxX &&
            fp.maxZ > minZ &&
            fp.minZ < maxZ
          ) {
            blockers.push(fp);
          }
        }
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
            recordTrace(edge, sub.subId, 'fully-subtracted', { blockerCount: blockers.length });
            fullySubtractedRoadIds.add(sub.subId);
            fullySubtractedRoadIds.add(edge.id);
            for (const sid of sids) {
              fullySubtractedRoadIds.add(sid);
              e2PlusOccludedSourceCandidates.add(sid);
            }
            continue;
          }
          // Ownership must not be committed before a renderable mesh exists.
          // An otherwise valid polygon may fail shape conversion, triangulation,
          // winding validation or tile clipping, leaving a phantom blocker.

          if (
            tileClipBounds &&
            (maxX < tileClipBounds.minX ||
              minX > tileClipBounds.maxX ||
              maxZ < tileClipBounds.minZ ||
              minZ > tileClipBounds.maxZ)
          ) {
            recordTrace(edge, sub.subId, 'bbox-outside');
            continue;
          }

          const tTriStart = performance.now();
          let geo: THREE.BufferGeometry | null = null;
          let failedEmptyShapes = false;
          let failedInvalidTriangles = false;

          const shapes = createShapesFromMultiPolygon(visible);
          if (shapes.length === 0) {
            failedEmptyShapes = true;
          } else {
            const unclippedGeo = new THREE.ShapeGeometry(shapes);
            unclippedGeo.rotateX(-Math.PI / 2);
            unclippedGeo.translate(0, roadElevation, 0);
            if (unclippedGeo.hasAttribute('uv')) unclippedGeo.deleteAttribute('uv');
            if (!validateAndPruneHorizontalGeometry(unclippedGeo)) {
              // Collect a bounded failure witness before the geometry is disposed.
              recordTrace(edge, sub.subId, 'invalid-triangles', {
                invalidTriangle: findFirstInvalidRoadTriangle(unclippedGeo),
                triangleCount: Math.floor((unclippedGeo.getIndex()?.count ??
                  unclippedGeo.getAttribute('position').count) / 3),
                polygonCount: visible.length, blockerCount: blockers.length,
              });
              unclippedGeo.dispose();
              failedInvalidTriangles = true;
            } else if (!tileClipBounds) {
              geo = unclippedGeo;
            } else {
              const clippedGeo = clipBufferGeometryToBoxXZ(unclippedGeo, tileClipBounds);
              unclippedGeo.dispose();
              if (!clippedGeo) {
                // Road bbox overlapped tileClipBounds without intersecting polygon area; valid skip
                timing.triangulationAndValidationTimeMs += performance.now() - tTriStart;
                recordTrace(edge, sub.subId, 'clip-empty');
                continue;
              }
              if (validateAndPruneHorizontalGeometry(clippedGeo)) {
                geo = clippedGeo;
              } else {
                recordTrace(edge, sub.subId, 'clip-invalid', {
                  invalidTriangle: findFirstInvalidRoadTriangle(clippedGeo),
                });
                clippedGeo.dispose();
                // Micro-sliver clipped away at tile border; valid skip
                timing.triangulationAndValidationTimeMs += performance.now() - tTriStart;
                continue;
              }
            }
          }

          if (!geo) {
            timing.triangulationAndValidationTimeMs += performance.now() - tTriStart;
            if (failedEmptyShapes) {
              recordTrace(edge, sub.subId, 'empty-shapes', {
                polygonCount: visible.length, blockerCount: blockers.length,
              });
              stats.emptyShapeCount++;
              stats.rejectedOrDegenerateCount++;
              recordGraphRoadDiagnostic(diagnostics, 'e2plus_empty_shapes', sub.subId);
            } else if (failedInvalidTriangles) {
              stats.invalidTriangleGeometryCount++;
              stats.rejectedOrDegenerateCount++;
              recordGraphRoadDiagnostic(diagnostics, 'e2plus_invalid_triangles', sub.subId);
            }
            continue;
          }

          if (options.testOnlyRejectAfterTriangulation?.(sub.sourceFeatureId)) {
            // Deterministic test for the same late-failure lifecycle as a
            // validator rejection; production callers never supply this hook.
            geo.dispose();
            recordTrace(edge, sub.subId, 'fault-injected-rejection');
            stats.invalidTriangleGeometryCount++;
            stats.rejectedOrDegenerateCount++;
            recordGraphRoadDiagnostic(diagnostics, 'e2plus_invalid_triangles', sub.subId);
            continue;
          }

          timing.triangulationAndValidationTimeMs += performance.now() - tTriStart;
          resourceManager.registerGeometry(geo);
          stats.outputPolygonCount += visible.length;
          for (const poly of visible) {
            if (poly.length > 1) {
              stats.outputHoleRingCount += poly.length - 1;
            }
          }
          const idxAttr = geo.getIndex();
          const posAttr = geo.getAttribute('position');
          stats.outputTriangleCount += idxAttr
            ? Math.floor(idxAttr.count / 3)
            : posAttr
              ? Math.floor(posAttr.count / 3)
              : 0;
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
          // Only surfaces backed by actual rendered triangles may take
          // ownership and subtract lower-priority road geometry.
          registerRoadFootprint(sub.subId, isPath, visible);
          recordTrace(edge, sub.subId, 'emitted', {
            polygonCount: visible.length, blockerCount: blockers.length,
            triangleCount: Math.floor((geo.getIndex()?.count ??
              geo.getAttribute('position').count) / 3),
          });
          stats.renderedRoadRibbonCount++;
          for (const sid of sids) renderedSourceIds.add(sid);
          if (edge.roadClass === 'steps') {
            const rawTreadGeo = generateGraphStepTreads(
              pts, width, roadElevation + ELEVATION_POLICY.STEP_TREAD_OFFSET
            );
            if (rawTreadGeo) {
              const treadGeo = tileClipBounds
                ? (() => {
                    const clipped = clipBufferGeometryToBoxXZ(rawTreadGeo, tileClipBounds);
                    rawTreadGeo.dispose();
                    return clipped;
                  })()
                : rawTreadGeo;
              if (treadGeo) {
                if (validateAndPruneHorizontalGeometry(treadGeo)) {
                  resourceManager.registerGeometry(treadGeo);
                  roadsByClass.get(edge.roadClass)!.push({ geom: treadGeo, info: roadInfo });
                } else {
                  treadGeo.dispose();
                }
              }
            }
          }
        } catch (err) {
          recordTrace(edge, sub.subId, 'exception', {
            message: err instanceof Error ? err.message : String(err),
            blockerCount: blockers.length,
          });
          timing.ownershipClippingTimeMs += performance.now() - tClipStart;
          stats.surfaceClipFailureCount++;
          stats.rejectedOrDegenerateCount++;
          recordGraphRoadDiagnostic(diagnostics, 'e2plus_surface_clip_failed', sub.subId);
        }
      } catch (err) {
        recordTrace(edge, sub.subId, 'exception', {
          message: err instanceof Error ? err.message : String(err),
        });
        console.warn(`Skipping invalid graph at-grade road segment ${sub.subId}`, err);
        stats.rejectedOrDegenerateCount++;
      }
    }
  }

  // Finalize aggregate primitive, polygon, triangle, and timing counters
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

  timing.totalRoadGenerationTimeMs = performance.now() - tTotalStart;

  if (diagnostics) {
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
