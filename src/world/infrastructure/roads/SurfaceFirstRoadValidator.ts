import * as THREE from 'three';
import polygonClipping from 'polygon-clipping';
import {
  InspectableFeatureInfo,
  ProcessedMapData,
  RoadClass,
  RoadFeature,
} from '../../../types/MapFeature';
import {
  ELEVATION_POLICY,
  isNonVehicularRoadClass,
} from '../../ElevationPolicy';
import {
  computeMultiPolygonArea,
  filterDegenerateBooleanArtifacts,
  MultiPolygonCoords,
} from '../../PlanarLayerValidator';
import {
  RoadNetworkValidationReport,
  validateRoadNetworkGeometry,
} from '../../ZFightingValidator';

/**
 * Coplanar positive-area overlap tolerance (`m²`) matching `ZFightingValidator`.
 * Shared 1D boundaries and floating-point touches (`<= 1e-3 m²`) are not overlaps.
 */
export const COPLANAR_OVERLAP_AREA_TOLERANCE_M2 = 1e-3;
import {
  FaceFeatureRange,
  resolveInspectedFeature,
   BuiltSceneGeometry,
} from '../../GeometryBuilder';
import {
  auditGraphRoadMeshIntegrity,
  GraphRoadMeshIntegrityReport,
  GraphRoadRenderStats,
  MIN_NONDEGENERATE_TRIANGLE_AREA_M2,
} from './GraphRoadGeometryBuilder';
import { RoadEdgeRenderDescriptor } from '../rendering/InfrastructureRenderAdapter';

/**
 * Maximum acceptable area discrepancy ratio between an independent analytical centerline corridor
 * (with 24-gon round joins/caps) and the emitted 16-gon E2+ mesh union (plus legitimate higher-priority
 * road occlusion). Accounts for 16-gon vs exact circle discretization (`1 - (16/(2*pi))*sin(2*pi/16) ≈ 2.55%`).
 */
export const COVERAGE_DISCRETIZATION_RATIO_TOLERANCE = 0.04;

/**
 * Absolute minimum missing area (`m²`) required before a coverage shortfall on an edge/sub-segment
 * is flagged as an unexpected geometry loss defect.
 */
export const MIN_COVERAGE_DEFECT_AREA_M2 = 0.05;

/**
 * Minimum area (`m²`) below which an isolated disconnected polygon/triangle component is flagged
 * as a tiny disconnected polygon artifact in A3 mesh integrity validation.
 */
export const TINY_DISCONNECTED_ARTIFACT_AREA_M2 = 1e-3;

/**
 * Maximum area (`m²`) of an unlooped interior void inside the union of emitted road surfaces
 * that is classified as an unintended Boolean/triangulation hole rather than a real city block.
 */
export const UNINTENDED_INTERIOR_HOLE_MAX_AREA_M2 = 2.0;

/**
 * Classification of a surface coverage defect detected by `validateSurfaceFirstRoadGeometry` (Task A1).
 */
export type SurfaceCoverageDefectKind =
  | 'omitted_road_feature'
  | 'missing_road_surface_area'
  | 'connected_node_gap'
  | 'provenance_split_bend_gap'
  | 'unintended_interior_hole';

/**
 * Detailed attribution for an A1 surface coverage defect.
 */
export interface SurfaceCoverageDefect {
  kind: SurfaceCoverageDefectKind;
  featureId: string;
  sourceFeatureId?: string;
  roadClass?: RoadClass;
  expectedAreaM2: number;
  ownEmittedAreaM2: number;
  occludedByHigherPriorityAreaM2: number;
  unexplainedMissingAreaM2: number;
  sampleWorldPoint?: [number, number];
  description: string;
}

/**
 * Summary of A1 surface coverage validation.
 */
export interface SurfaceFirstCoverageValidationReport {
  eligibleAtGradeEdgeCount: number;
  evaluatedSubSegmentCount: number;
  independentExpectedUnionAreaM2: number;
  emittedAtGradeUnionAreaM2: number;
  unexplainedNetworkMissingAreaM2: number;
  networkCoverageRatio: number;
  checkedConnectedNodeCount: number;
  checkedProvenanceSplitJoinCount: number;
  legitimatelyFullSubtractedFeatureIds: string[];
  legitimatelyPartiallyClippedFeatureIds: string[];
  defects: SurfaceCoverageDefect[];
}

/**
 * Classification of a coplanar overlap defect (Task A2).
 */
export type SurfaceOverlapCategory =
  | 'cross_class_vehicular'
  | 'same_class_road'
  | 'path_or_cycleway'
  | 'multi_provenance_segment'
  | 'intra_feature_self_overlap';

/**
 * Categorized coplanar overlap defect derived from `validateRoadNetworkGeometry`.
 */
export interface CategorizedRoadOverlapDefect {
  category: SurfaceOverlapCategory;
  meshA: string;
  meshB: string;
  featureIdA: string;
  featureIdB: string;
  elevation: number;
  overlapAreaM2: number;
  centroid: [number, number];
}

/**
 * Summary of A2 overlap validation.
 */
export interface SurfaceFirstOverlapValidationReport {
  baseReport: RoadNetworkValidationReport;
  totalPositiveAreaOverlapCount: number;
  totalOverlapAreaM2: number;
  byCategory: Record<SurfaceOverlapCategory, number>;
  categorizedOverlaps: CategorizedRoadOverlapDefect[];
}

/**
 * Elevation or tiny-fragment defect detected during A3 mesh integrity validation.
 */
export interface SurfaceMeshArtifactDefect {
  kind: 'inconsistent_elevation' | 'tiny_disconnected_fragment';
  meshName: string;
  featureId?: string;
  sourceFeatureId?: string;
  faceIndex?: number;
  measuredValue: number;
  expectedValue: number;
  description: string;
}

/**
 * Summary of A3 mesh integrity validation.
 */
export interface SurfaceFirstMeshIntegrityValidationReport {
  auditReport: GraphRoadMeshIntegrityReport;
  consistentElevationTriangleCount: number;
  inconsistentElevationDefectCount: number;
  tinyDisconnectedFragmentCount: number;
  artifacts: SurfaceMeshArtifactDefect[];
}

/**
 * Provenance attribution defect detected during A4 validation.
 */
export interface SurfaceProvenanceDefect {
  kind:
    | 'unattributed_triangle_face'
    | 'missing_source_feature_id'
    | 'unknown_source_feature_id'
    | 'road_class_mismatch'
    | 'osm_tag_mismatch'
    | 'provenance_span_escape'
    | 'deduplicated_lineage_missing'
    | 'invalid_fully_subtracted_claim'
    | 'diagnostics_fully_subtracted_desync';
  meshName?: string;
  featureId?: string;
  sourceFeatureId?: string;
  description: string;
}

/**
 * Summary of A4 source-feature provenance validation.
 */
export interface SurfaceFirstProvenanceValidationReport {
  totalAuditedFaceRanges: number;
  totalAuditedTriangles: number;
  attributedTriangleCount: number;
  verifiedSourceFeatureIds: string[];
  verifiedProvenanceSplitEdgeIds: string[];
  verifiedDeduplicatedSurvivorIds: string[];
  verifiedFullySubtractedIds: string[];
  diagnosticsFullySubtractedCount: number;
  statsFullySubtractedCount: number;
  defects: SurfaceProvenanceDefect[];
}

/**
 * Complete automated E2+ geometry correctness report combining A1, A2, A3, and A4.
 */
export interface SurfaceFirstRoadValidationReport {
  valid: boolean;
  rendererMode: string;
  coverage: SurfaceFirstCoverageValidationReport;
  overlaps: SurfaceFirstOverlapValidationReport;
  meshIntegrity: SurfaceFirstMeshIntegrityValidationReport;
  provenance: SurfaceFirstProvenanceValidationReport;
}

interface ExtractedAtGradeRoadTriangle {
  meshName: string;
  faceIndex: number;
  featureId: string;
  sourceFeatureId: string;
  sourceFeatureIds: string[];
  roadClass: RoadClass;
  isPath: boolean;
  elevation: number;
  areaM2: number;
  pts2D: [[number, number], [number, number], [number, number]];
  ringPoly: MultiPolygonCoords;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const STRUCTURAL_ROAD_MESH_NAMES = new Set<string>([
  'Bridge_Substructure',
  'Bridge_Piers',
  'Bridge_Parapets',
  'Tunnel_Portals',
  'Tunnel_Entrances',
  'Tunnel_Underground_Trace',
  'Tunnel_Underground_Roads',
]);

/**
 * Independently constructs a 2D analytical corridor MultiPolygon from a polyline and width
 * using 24-sided endpoint/bend disks (distinct from E2+'s 16-sided snapped buffer) for
 * non-circular area and point-coverage verification.
 */
export function buildIndependentAnalyticalRoadCorridor(
  points: ReadonlyArray<readonly [number, number]>,
  width: number,
  options: { capStart: boolean; capEnd: boolean }
): MultiPolygonCoords {
  if (!Number.isFinite(width) || width <= 0 || points.length < 2) return [];
  const clean: [number, number][] = [];
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (
      clean.length === 0 ||
      Math.hypot(p[0] - clean[clean.length - 1][0], p[1] - clean[clean.length - 1][1]) > 0.02
    ) {
      clean.push([p[0], p[1]]);
    }
  }
  if (clean.length < 2) return [];

  const isClosed =
    clean.length >= 4 &&
    Math.hypot(clean[0][0] - clean[clean.length - 1][0], clean[0][1] - clean[clean.length - 1][1]) <
      0.05;
  const r = width * 0.5;
  const pieces: MultiPolygonCoords[] = [];

  const makeCircle24 = (center: [number, number]): MultiPolygonCoords => {
    const ring: [number, number][] = [];
    const steps = 24;
    for (let k = 0; k < steps; k++) {
      const a = (k * 2 * Math.PI) / steps;
      ring.push([center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r]);
    }
    ring.push([ring[0][0], ring[0][1]]);
    return [[ring]];
  };

  for (let i = 1; i < clean.length; i++) {
    const p0 = clean[i - 1];
    const p1 = clean[i];
    const dx = p1[0] - p0[0];
    const dz = p1[1] - p0[1];
    const segLen = Math.hypot(dx, dz);
    if (segLen <= 0.02) continue;
    const nx = (-dz / segLen) * r;
    const nz = (dx / segLen) * r;
    const ring: [number, number][] = [
      [p0[0] + nx, p0[1] + nz],
      [p1[0] + nx, p1[1] + nz],
      [p1[0] - nx, p1[1] - nz],
      [p0[0] - nx, p0[1] - nz],
    ];
    ring.push([ring[0][0], ring[0][1]]);
    pieces.push([[ring]]);
  }

  for (let i = 1; i < clean.length - 1; i++) {
    const p0 = clean[i - 1];
    const p1 = clean[i];
    const p2 = clean[i + 1];
    const ux = p1[0] - p0[0];
    const uz = p1[1] - p0[1];
    const vx = p2[0] - p1[0];
    const vz = p2[1] - p1[1];
    const denom = Math.hypot(ux, uz) * Math.hypot(vx, vz);
    if (denom > 1e-6 && (ux * vx + uz * vz) / denom < 0.9995) {
      pieces.push(makeCircle24(p1));
    }
  }

  if (!isClosed && options.capStart) pieces.push(makeCircle24(clean[0]));
  if (!isClosed && options.capEnd) pieces.push(makeCircle24(clean[clean.length - 1]));
  if (isClosed) pieces.push(makeCircle24(clean[0]));

  if (pieces.length === 0) return [];
  try {
    return filterDegenerateBooleanArtifacts(
      polygonClipping.union(
        pieces[0] as unknown as polygonClipping.Geom,
        ...(pieces.slice(1) as unknown as polygonClipping.Geom[])
      ) as unknown as MultiPolygonCoords
    );
  } catch {
    return pieces[0];
  }
}

/**
 * Exact 2D point-in-triangle test (inclusive of small boundary epsilon `1e-4 m`).
 */
function isPointInTriangle2D(
  px: number,
  pz: number,
  t: [[number, number], [number, number], [number, number]],
  eps = 1e-4
): boolean {
  const [a, b, c] = t;
  const v0x = c[0] - a[0];
  const v0z = c[1] - a[1];
  const v1x = b[0] - a[0];
  const v1z = b[1] - a[1];
  const v2x = px - a[0];
  const v2z = pz - a[1];

  const dot00 = v0x * v0x + v0z * v0z;
  const dot01 = v0x * v1x + v0z * v1z;
  const dot02 = v0x * v2x + v0z * v2z;
  const dot11 = v1x * v1x + v1z * v1z;
  const dot12 = v1x * v2x + v1z * v2z;

  const denom = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denom) <= 1e-12) return false;
  const invDenom = 1 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
  return u >= -eps && v >= -eps && u + v <= 1 + eps;
}

/**
 * Extracts all horizontal at-grade road surface triangles from `scene.roadsGroup`
 * (excluding elevated bridges, underground tunnels, 3D substructures, and raised step treads).
 */
function extractAtGradeRoadSurfaceTriangles(
  roadsGroup: THREE.Group
): ExtractedAtGradeRoadTriangle[] {
  const triangles: ExtractedAtGradeRoadTriangle[] = [];
  roadsGroup.updateMatrixWorld(true);
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();

  roadsGroup.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (STRUCTURAL_ROAD_MESH_NAMES.has(obj.name)) return;
    if (obj.name === 'Roads_bridge') return;

    const geom = obj.geometry as THREE.BufferGeometry | undefined;
    if (!geom) return;
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr || posAttr.count < 3) return;
    const idxAttr = geom.getIndex();
    const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);
    const ranges = (obj.userData?.faceRanges as FaceFeatureRange[] | undefined) ?? [];

    for (let f = 0; f < triCount; f++) {
      let info: InspectableFeatureInfo | undefined;
      for (const r of ranges) {
        if (f >= r.startFace && f < r.endFace) {
          info = r.info;
          break;
        }
      }
      if (info?.isBridge || info?.isTunnel) {
        // Note: culverts are at-grade (`elevation === ROAD_SURFACE`), whereas true underground tunnels are < -0.1m
        if (info.isBridge) continue;
      }

      const i0 = idxAttr ? idxAttr.getX(f * 3) : f * 3;
      const i1 = idxAttr ? idxAttr.getX(f * 3 + 1) : f * 3 + 1;
      const i2 = idxAttr ? idxAttr.getX(f * 3 + 2) : f * 3 + 2;

      v0.fromBufferAttribute(posAttr, i0).applyMatrix4(obj.matrixWorld);
      v1.fromBufferAttribute(posAttr, i1).applyMatrix4(obj.matrixWorld);
      v2.fromBufferAttribute(posAttr, i2).applyMatrix4(obj.matrixWorld);

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
        continue;
      }

      const avgY = (v0.y + v1.y + v2.y) / 3;
      // Only include primary at-grade road plane (exclude raised step treads at +0.056m and bridges/tunnels)
      if (Math.abs(avgY - ELEVATION_POLICY.ROAD_SURFACE) > 0.003) {
        continue;
      }

      const signedArea2D =
        0.5 * ((v1.x - v0.x) * (v2.z - v0.z) - (v2.x - v0.x) * (v1.z - v0.z));
      const areaM2 = Math.abs(signedArea2D);
      if (areaM2 <= MIN_NONDEGENERATE_TRIANGLE_AREA_M2) continue;

      const pts2D: [[number, number], [number, number], [number, number]] =
        signedArea2D >= 0
          ? [
              [v0.x, v0.z],
              [v1.x, v1.z],
              [v2.x, v2.z],
            ]
          : [
              [v0.x, v0.z],
              [v2.x, v2.z],
              [v1.x, v1.z],
            ];

      const ring: [number, number][] = [pts2D[0], pts2D[1], pts2D[2], pts2D[0]];
      const roadClass =
        (info?.subtype as RoadClass | undefined) ??
        (obj.name.startsWith('Roads_') ? (obj.name.slice(6) as RoadClass) : 'residential');
      const isPath = isNonVehicularRoadClass(roadClass);
      const featureId = info?.id ?? `${obj.name}#f${f}`;
      const sourceFeatureId = info?.sourceFeatureId ?? featureId;
      const sourceFeatureIds = info?.sourceFeatureIds ?? [sourceFeatureId];

      triangles.push({
        meshName: obj.name,
        faceIndex: f,
        featureId,
        sourceFeatureId,
        sourceFeatureIds,
        roadClass,
        isPath,
        elevation: avgY,
        areaM2,
        pts2D,
        ringPoly: [[ring]],
        minX: Math.min(pts2D[0][0], pts2D[1][0], pts2D[2][0]),
        maxX: Math.max(pts2D[0][0], pts2D[1][0], pts2D[2][0]),
        minZ: Math.min(pts2D[0][1], pts2D[1][1], pts2D[2][1]),
        maxZ: Math.max(pts2D[0][1], pts2D[1][1], pts2D[2][1]),
      });
    }
  });

  return triangles;
}

/**
 * Computes the signed 2D area of a closed ring `[x, z][]`.
 */
function computeSignedRingArea(ring: ReadonlyArray<readonly [number, number]>): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return 0.5 * sum;
}

/**
 * Performs comprehensive automated geometry correctness validation on a built scene (`Task A`):
 * - `A1`: Surface coverage, continuity, hole detection, and legitimate ownership accounting
 * - `A2`: Coplanar positive-area overlap validation by category
 * - `A3`: Mesh integrity, triangle winding, normal agreement, elevation consistency, and tiny artifact check
 * - `A4`: Source-feature provenance, multi-segment chaining splits, deduplication lineage, and subtraction accounting
 */
export function validateSurfaceFirstRoadGeometry(
  scene: BuiltSceneGeometry,
  data: ProcessedMapData,
  options?: {
    roadWidthMultiplier?: number;
  }
): SurfaceFirstRoadValidationReport {
  const roadWidthMultiplier = options?.roadWidthMultiplier ?? 1.0;
  const rendererMode = String(scene.roadsGroup.userData?.graphRoadMode ?? 'legacy');
  const descriptors = scene.infrastructureRenderPreview?.descriptors;
  const stats = scene.roadsGroup.userData?.graphRoadStats as GraphRoadRenderStats | undefined;

  // ============================================================================
  // A3. Mesh Integrity Validation
  // ============================================================================
  const auditReport = auditGraphRoadMeshIntegrity(scene.roadsGroup);
  const meshArtifacts: SurfaceMeshArtifactDefect[] = [];
  let consistentElevationTriangleCount = 0;
  let inconsistentElevationDefectCount = 0;
  let tinyDisconnectedFragmentCount = 0;

  scene.roadsGroup.updateMatrixWorld(true);
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();

  scene.roadsGroup.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (STRUCTURAL_ROAD_MESH_NAMES.has(obj.name) || obj.name === 'Roads_bridge') return;
    const geom = obj.geometry as THREE.BufferGeometry | undefined;
    if (!geom) return;
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr || posAttr.count < 3) return;
    const idxAttr = geom.getIndex();
    const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);
    const ranges = (obj.userData?.faceRanges as FaceFeatureRange[] | undefined) ?? [];

    // Check per-triangle physical elevation consistency
    for (let f = 0; f < triCount; f++) {
      let info: InspectableFeatureInfo | undefined;
      for (const r of ranges) {
        if (f >= r.startFace && f < r.endFace) {
          info = r.info;
          break;
        }
      }
      if (info?.isBridge) continue;

      const i0 = idxAttr ? idxAttr.getX(f * 3) : f * 3;
      const i1 = idxAttr ? idxAttr.getX(f * 3 + 1) : f * 3 + 1;
      const i2 = idxAttr ? idxAttr.getX(f * 3 + 2) : f * 3 + 2;
      v0.fromBufferAttribute(posAttr, i0).applyMatrix4(obj.matrixWorld);
      v1.fromBufferAttribute(posAttr, i1).applyMatrix4(obj.matrixWorld);
      v2.fromBufferAttribute(posAttr, i2).applyMatrix4(obj.matrixWorld);
      if (!Number.isFinite(v0.y) || !Number.isFinite(v1.y) || !Number.isFinite(v2.y)) continue;

      const expectedY = ELEVATION_POLICY.ROAD_SURFACE;
      const treadY = ELEVATION_POLICY.ROAD_SURFACE + ELEVATION_POLICY.STEP_TREAD_OFFSET;
      const matchesRoadPlane =
        Math.abs(v0.y - expectedY) <= 1e-4 &&
        Math.abs(v1.y - expectedY) <= 1e-4 &&
        Math.abs(v2.y - expectedY) <= 1e-4;
      const matchesStepTreadPlane =
        obj.name === 'Roads_steps' &&
        Math.abs(v0.y - treadY) <= 1e-4 &&
        Math.abs(v1.y - treadY) <= 1e-4 &&
        Math.abs(v2.y - treadY) <= 1e-4;

      if (matchesRoadPlane || matchesStepTreadPlane) {
        consistentElevationTriangleCount++;
      } else {
        inconsistentElevationDefectCount++;
        meshArtifacts.push({
          kind: 'inconsistent_elevation',
          meshName: obj.name,
          featureId: info?.id,
          sourceFeatureId: info?.sourceFeatureId,
          faceIndex: f,
          measuredValue: (v0.y + v1.y + v2.y) / 3,
          expectedValue: expectedY,
          description: `Triangle ${f} on ${obj.name} has vertex Y=[${v0.y.toFixed(4)}, ${v1.y.toFixed(4)}, ${v2.y.toFixed(4)}] instead of ${expectedY.toFixed(4)}m`,
        });
      }
    }

    // Check per-feature total triangle area for tiny disconnected polygon artifacts
    for (const r of ranges) {
      let rangeArea = 0;
      for (let f = r.startFace; f < r.endFace && f < triCount; f++) {
        const i0 = idxAttr ? idxAttr.getX(f * 3) : f * 3;
        const i1 = idxAttr ? idxAttr.getX(f * 3 + 1) : f * 3 + 1;
        const i2 = idxAttr ? idxAttr.getX(f * 3 + 2) : f * 3 + 2;
        v0.fromBufferAttribute(posAttr, i0).applyMatrix4(obj.matrixWorld);
        v1.fromBufferAttribute(posAttr, i1).applyMatrix4(obj.matrixWorld);
        v2.fromBufferAttribute(posAttr, i2).applyMatrix4(obj.matrixWorld);
        const a =
          0.5 *
          Math.abs((v1.x - v0.x) * (v2.z - v0.z) - (v2.x - v0.x) * (v1.z - v0.z));
        if (Number.isFinite(a)) rangeArea += a;
      }
      if (rangeArea > 0 && rangeArea < TINY_DISCONNECTED_ARTIFACT_AREA_M2) {
        tinyDisconnectedFragmentCount++;
        meshArtifacts.push({
          kind: 'tiny_disconnected_fragment',
          meshName: obj.name,
          featureId: r.info.id,
          sourceFeatureId: r.info.sourceFeatureId,
          measuredValue: rangeArea,
          expectedValue: TINY_DISCONNECTED_ARTIFACT_AREA_M2,
          description: `Feature range ${r.info.id} on ${obj.name} has tiny total area ${rangeArea.toExponential(3)} m² (< ${TINY_DISCONNECTED_ARTIFACT_AREA_M2} m²)`,
        });
      }
    }
  });

  const meshIntegrityReport: SurfaceFirstMeshIntegrityValidationReport = {
    auditReport,
    consistentElevationTriangleCount,
    inconsistentElevationDefectCount,
    tinyDisconnectedFragmentCount,
    artifacts: meshArtifacts,
  };

  // ============================================================================
  // A2. Coplanar Overlap Validation
  // ============================================================================
  const baseOverlapReport = validateRoadNetworkGeometry(scene);
  const byCategory: Record<SurfaceOverlapCategory, number> = {
    cross_class_vehicular: 0,
    same_class_road: 0,
    path_or_cycleway: 0,
    multi_provenance_segment: 0,
    intra_feature_self_overlap: 0,
  };
  const categorizedOverlaps: CategorizedRoadOverlapDefect[] = [];
  let totalOverlapAreaM2 = 0;

  for (const ov of baseOverlapReport.overlapConflicts) {
    if (ov.overlapAreaSqMeters <= COPLANAR_OVERLAP_AREA_TOLERANCE_M2) continue;
    totalOverlapAreaM2 += ov.overlapAreaSqMeters;

    const classA = ov.meshA.startsWith('Roads_') ? (ov.meshA.slice(6) as RoadClass) : 'residential';
    const classB = ov.meshB.startsWith('Roads_') ? (ov.meshB.slice(6) as RoadClass) : 'residential';
    const isPathA = isNonVehicularRoadClass(classA);
    const isPathB = isNonVehicularRoadClass(classB);
    const baseEdgeA = ov.featureA.split('#seg')[0];
    const baseEdgeB = ov.featureB.split('#seg')[0];

    let category: SurfaceOverlapCategory;
    if (ov.featureA === ov.featureB) {
      category = 'intra_feature_self_overlap';
    } else if (
      (ov.featureA.includes('#seg') || ov.featureB.includes('#seg')) &&
      baseEdgeA === baseEdgeB
    ) {
      category = 'multi_provenance_segment';
    } else if (isPathA || isPathB) {
      category = 'path_or_cycleway';
    } else if (classA === classB) {
      category = 'same_class_road';
    } else {
      category = 'cross_class_vehicular';
    }

    byCategory[category]++;
    categorizedOverlaps.push({
      category,
      meshA: ov.meshA,
      meshB: ov.meshB,
      featureIdA: ov.featureA,
      featureIdB: ov.featureB,
      elevation: ELEVATION_POLICY.ROAD_SURFACE,
      overlapAreaM2: ov.overlapAreaSqMeters,
      centroid: [0, 0],
    });
  }

  const overlapsReport: SurfaceFirstOverlapValidationReport = {
    baseReport: baseOverlapReport,
    totalPositiveAreaOverlapCount: categorizedOverlaps.length,
    totalOverlapAreaM2,
    byCategory,
    categorizedOverlaps,
  };

  // ============================================================================
  // A1. Surface Coverage Validation
  // ============================================================================
  const emittedTriangles = extractAtGradeRoadSurfaceTriangles(scene.roadsGroup);
  const coverageDefects: SurfaceCoverageDefect[] = [];
  const legitimatelyFullSubtractedFeatureIds = new Set<string>();
  const legitimatelyPartiallyClippedFeatureIds = new Set<string>();

  const isPointCoveredByEmittedTriangle = (
    px: number,
    pz: number,
    predicate?: (tri: ExtractedAtGradeRoadTriangle) => boolean
  ): boolean => {
    for (const tri of emittedTriangles) {
      if (px < tri.minX - 1e-3 || px > tri.maxX + 1e-3 || pz < tri.minZ - 1e-3 || pz > tri.maxZ + 1e-3) {
        continue;
      }
      if (predicate && !predicate(tri)) continue;
      if (isPointInTriangle2D(px, pz, tri.pts2D, 1.5e-3)) {
        return true;
      }
    }
    return false;
  };

  let eligibleAtGradeEdgeCount = 0;
  let evaluatedSubSegmentCount = 0;
  let checkedConnectedNodeCount = 0;
  let checkedProvenanceSplitJoinCount = 0;

  const expectedCorridors: MultiPolygonCoords[] = [];

  if (descriptors) {
    const buildableEdges: RoadEdgeRenderDescriptor[] = [];
    for (const edge of descriptors.roadEdges) {
      if (!edge.isAtGradeBuildable) continue;
      if (!edge.points || edge.points.length < 2) continue;
      let totalLen = 0;
      for (let i = 1; i < edge.points.length; i++) {
        totalLen += Math.hypot(
          edge.points[i][0] - edge.points[i - 1][0],
          edge.points[i][1] - edge.points[i - 1][1]
        );
      }
      if (!Number.isFinite(totalLen) || totalLen < 0.05) continue;
      eligibleAtGradeEdgeCount++;
      buildableEdges.push(edge);
    }

    // Group emitted triangles by sourceFeatureId and featureId for fast lookup
    const trianglesBySourceId = new Map<string, ExtractedAtGradeRoadTriangle[]>();
    const trianglesByFeatureId = new Map<string, ExtractedAtGradeRoadTriangle[]>();
    for (const tri of emittedTriangles) {
      if (!trianglesByFeatureId.has(tri.featureId)) {
        trianglesByFeatureId.set(tri.featureId, []);
      }
      trianglesByFeatureId.get(tri.featureId)!.push(tri);
      for (const sid of tri.sourceFeatureIds) {
        if (!trianglesBySourceId.has(sid)) {
          trianglesBySourceId.set(sid, []);
        }
        trianglesBySourceId.get(sid)!.push(tri);
      }
    }

    for (const edge of buildableEdges) {
      const width = edge.width * roadWidthMultiplier;
      const isPath = edge.tier === 'path' || isNonVehicularRoadClass(edge.roadClass);
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
      const capStart =
        !edge.isClosedLoop &&
        !edge.clippedAtStart &&
        !startNode?.isBoundaryClipped &&
        !hasGradeStart;
      const capEnd =
        !edge.isClosedLoop &&
        !edge.clippedAtEnd &&
        !endNode?.isBoundaryClipped &&
        !hasGradeEnd;

      const edgeCorridor = buildIndependentAnalyticalRoadCorridor(edge.points, width, {
        capStart,
        capEnd,
      });
      if (edgeCorridor.length > 0) {
        expectedCorridors.push(edgeCorridor);
      }
      const expectedAreaM2 = computeMultiPolygonArea(edgeCorridor);
      if (expectedAreaM2 <= 1e-4) continue;

      evaluatedSubSegmentCount += Math.max(1, edge.provenance.segments.length);

      // Find all emitted triangles belonging to this edge (or its provenance segments)
      const ownTriangles: ExtractedAtGradeRoadTriangle[] = [];
      for (const tri of emittedTriangles) {
        if (
          tri.featureId === edge.id ||
          tri.featureId.startsWith(`${edge.id}#seg`) ||
          edge.sourceFeatureIds.includes(tri.sourceFeatureId)
        ) {
          ownTriangles.push(tri);
        }
      }

      // Compute bbox of edgeCorridor to find overlapping higher/other road triangles
      let minX = Infinity,
        maxX = -Infinity,
        minZ = Infinity,
        maxZ = -Infinity;
      for (const poly of edgeCorridor) {
        for (const ring of poly) {
          for (const [x, z] of ring) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minZ = Math.min(minZ, z);
            maxZ = Math.max(maxZ, z);
          }
        }
      }

      const otherBlockingTris = emittedTriangles.filter(
        (tri) =>
          tri.featureId !== edge.id &&
          !tri.featureId.startsWith(`${edge.id}#seg`) &&
          (isPath || !tri.isPath) &&
          tri.maxX > minX &&
          tri.minX < maxX &&
          tri.maxZ > minZ &&
          tri.minZ < maxZ
      );

      let ownEmittedAreaM2 = 0;
      for (const tri of ownTriangles) {
        ownEmittedAreaM2 += tri.areaM2;
      }

      let uncoveredAreaM2 = expectedAreaM2;
      let occludedByHigherPriorityAreaM2 = 0;

      try {
        let unoccludedCorridor: MultiPolygonCoords = edgeCorridor;
        if (otherBlockingTris.length > 0) {
          unoccludedCorridor = filterDegenerateBooleanArtifacts(
            polygonClipping.difference(
              edgeCorridor as unknown as polygonClipping.Geom,
              ...(otherBlockingTris.map((t) => t.ringPoly) as unknown as polygonClipping.Geom[])
            ) as unknown as MultiPolygonCoords
          );
          const unoccludedArea = computeMultiPolygonArea(unoccludedCorridor);
          occludedByHigherPriorityAreaM2 = Math.max(0, expectedAreaM2 - unoccludedArea);
          uncoveredAreaM2 = unoccludedArea;
        }

        if (unoccludedCorridor.length > 0 && ownTriangles.length > 0) {
          const uncoveredPoly = filterDegenerateBooleanArtifacts(
            polygonClipping.difference(
              unoccludedCorridor as unknown as polygonClipping.Geom,
              ...(ownTriangles.map((t) => t.ringPoly) as unknown as polygonClipping.Geom[])
            ) as unknown as MultiPolygonCoords
          );
          uncoveredAreaM2 = computeMultiPolygonArea(uncoveredPoly);
        }
      } catch {
        uncoveredAreaM2 = Math.max(0, expectedAreaM2 - ownEmittedAreaM2);
      }

      if (ownTriangles.length === 0) {
        if (uncoveredAreaM2 <= Math.max(MIN_COVERAGE_DEFECT_AREA_M2, expectedAreaM2 * COVERAGE_DISCRETIZATION_RATIO_TOLERANCE)) {
          legitimatelyFullSubtractedFeatureIds.add(edge.id);
          for (const sid of edge.sourceFeatureIds) {
            legitimatelyFullSubtractedFeatureIds.add(sid);
          }
        } else {
          coverageDefects.push({
            kind: 'omitted_road_feature',
            featureId: edge.id,
            sourceFeatureId: edge.sourceFeatureId,
            roadClass: edge.roadClass,
            expectedAreaM2,
            ownEmittedAreaM2: 0,
            occludedByHigherPriorityAreaM2,
            unexplainedMissingAreaM2: uncoveredAreaM2,
            sampleWorldPoint: [edge.points[0][0], edge.points[0][1]],
            description: `Eligible at-grade road edge ${edge.id} (${edge.sourceFeatureId}) emitted 0 triangles and has ${uncoveredAreaM2.toFixed(2)} m² uncovered by any higher-priority road`,
          });
        }
      } else {
        if (occludedByHigherPriorityAreaM2 > 1e-2) {
          legitimatelyPartiallyClippedFeatureIds.add(edge.id);
        }
        const allowedDiscrepancyM2 = Math.max(
          MIN_COVERAGE_DEFECT_AREA_M2,
          expectedAreaM2 * COVERAGE_DISCRETIZATION_RATIO_TOLERANCE
        );
        if (uncoveredAreaM2 > allowedDiscrepancyM2) {
          coverageDefects.push({
            kind: 'missing_road_surface_area',
            featureId: edge.id,
            sourceFeatureId: edge.sourceFeatureId,
            roadClass: edge.roadClass,
            expectedAreaM2,
            ownEmittedAreaM2,
            occludedByHigherPriorityAreaM2,
            unexplainedMissingAreaM2: uncoveredAreaM2,
            sampleWorldPoint: [edge.points[0][0], edge.points[0][1]],
            description: `At-grade road edge ${edge.id} (${edge.sourceFeatureId}) is missing ${uncoveredAreaM2.toFixed(3)} m² of expected corridor coverage (expected ${expectedAreaM2.toFixed(2)} m²)`,
          });
        }
      }

      // Check internal provenance split boundaries for bend gaps (#seg0 -> #seg1)
      if (edge.provenance.segments.length > 1) {
        const segs = edge.provenance.segments;
        for (let sIdx = 0; sIdx < segs.length - 1; sIdx++) {
          const joinVertexIdx = segs[sIdx].endVertexIndex;
          if (joinVertexIdx > 0 && joinVertexIdx < edge.points.length - 1) {
            checkedProvenanceSplitJoinCount++;
            const pPrev = edge.points[joinVertexIdx - 1];
            const pJoin = edge.points[joinVertexIdx];
            const pNext = edge.points[joinVertexIdx + 1];
            const ux = pJoin[0] - pPrev[0];
            const uz = pJoin[1] - pPrev[1];
            const vx = pNext[0] - pJoin[0];
            const vz = pNext[1] - pJoin[1];
            const lenU = Math.hypot(ux, uz);
            const lenV = Math.hypot(vx, vz);
            if (lenU > 0.05 && lenV > 0.05) {
              const uux = ux / lenU;
              const uuz = uz / lenU;
              const vvx = vx / lenV;
              const vvz = vz / lenV;
              const dot = uux * vvx + uuz * vvz;
              // If the provenance boundary occurs at an interior bend (> ~5 degrees):
              if (dot < 0.996) {
                // Exterior bisector vector pointing toward the outside of the bend:
                const bx = uux - vvx;
                const bz = uuz - vvz;
                const bLen = Math.hypot(bx, bz);
                if (bLen > 1e-5) {
                  const probeDist = Math.min(width * 0.42, (width * 0.5) * 0.85);
                  const probeX = pJoin[0] + (bx / bLen) * probeDist;
                  const probeZ = pJoin[1] + (bz / bLen) * probeDist;
                  if (!isPointCoveredByEmittedTriangle(probeX, probeZ)) {
                    coverageDefects.push({
                      kind: 'provenance_split_bend_gap',
                      featureId: `${edge.id}#seg${sIdx}`,
                      sourceFeatureId: segs[sIdx].sourceFeatureId,
                      roadClass: edge.roadClass,
                      expectedAreaM2,
                      ownEmittedAreaM2,
                      occludedByHigherPriorityAreaM2,
                      unexplainedMissingAreaM2: uncoveredAreaM2,
                      sampleWorldPoint: [probeX, probeZ],
                      description: `Outer-corner wedge gap detected at internal provenance split vertex (${pJoin[0].toFixed(2)}, ${pJoin[1].toFixed(2)}) between ${segs[sIdx].sourceFeatureId} and ${segs[sIdx + 1].sourceFeatureId}`,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    // Check connected topological at-grade road nodes for unexpected junction/join gaps
    for (const node of descriptors.roadNodes) {
      if (node.isBoundaryClipped || node.isBridge || node.isTunnel || node.layer !== 0) continue;
      if (node.gradeTransitionIds.length > 0) continue;
      const connectedBuildable = node.incidentEdgeIds
        .map((id) => descriptors.roadEdgesById.get(id))
        .filter((e): e is RoadEdgeRenderDescriptor =>
          Boolean(e && e.isAtGradeBuildable && e.points.length >= 2)
        );
      if (connectedBuildable.length < 2) continue;

      checkedConnectedNodeCount++;
      const [nx, nz] = node.position;
      if (!isPointCoveredByEmittedTriangle(nx, nz)) {
        coverageDefects.push({
          kind: 'connected_node_gap',
          featureId: node.id,
          roadClass: connectedBuildable[0].roadClass,
          expectedAreaM2: 0,
          ownEmittedAreaM2: 0,
          occludedByHigherPriorityAreaM2: 0,
          unexplainedMissingAreaM2: 0,
          sampleWorldPoint: [nx, nz],
          description: `Connected topological road node ${node.id} at (${nx.toFixed(2)}, ${nz.toFixed(2)}) with ${connectedBuildable.length} incident at-grade edges is not covered by any road surface triangle`,
        });
      }
    }
  }

  // Compute network-level independent expected union vs emitted union and check for unintended holes
  let independentExpectedUnionAreaM2 = 0;
  let emittedAtGradeUnionAreaM2 = 0;
  let unexplainedNetworkMissingAreaM2 = 0;

  if (expectedCorridors.length > 0) {
    try {
      const flatExpected = expectedCorridors.flatMap((mp) => mp);
      const expectedUnion = filterDegenerateBooleanArtifacts(
        polygonClipping.union(
          [flatExpected[0]] as unknown as polygonClipping.Geom,
          ...(flatExpected.slice(1).map((p) => [p]) as unknown as polygonClipping.Geom[])
        ) as unknown as MultiPolygonCoords
      );
      independentExpectedUnionAreaM2 = computeMultiPolygonArea(expectedUnion);

      if (emittedTriangles.length > 0) {
        const emittedPolys = emittedTriangles.map((t) => t.ringPoly);
        const emittedUnion = filterDegenerateBooleanArtifacts(
          polygonClipping.union(
            emittedPolys[0] as unknown as polygonClipping.Geom,
            ...(emittedPolys.slice(1) as unknown as polygonClipping.Geom[])
          ) as unknown as MultiPolygonCoords
        );
        emittedAtGradeUnionAreaM2 = computeMultiPolygonArea(emittedUnion);

        const networkMissingPoly = filterDegenerateBooleanArtifacts(
          polygonClipping.difference(
            expectedUnion as unknown as polygonClipping.Geom,
            emittedUnion as unknown as polygonClipping.Geom
          ) as unknown as MultiPolygonCoords
        );
        unexplainedNetworkMissingAreaM2 = computeMultiPolygonArea(networkMissingPoly);

        // Check for unintended small interior holes in emittedUnion that do not exist in expectedUnion
        const expectedHoleCentroids: Array<{ x: number; z: number; area: number }> = [];
        for (const poly of expectedUnion) {
          for (let rIdx = 1; rIdx < poly.length; rIdx++) {
            const ring = poly[rIdx];
            const area = Math.abs(computeSignedRingArea(ring));
            if (area > 1e-4 && ring.length >= 3) {
              let cx = 0,
                cz = 0;
              const n = ring.length - 1;
              for (let i = 0; i < n; i++) {
                cx += ring[i][0];
                cz += ring[i][1];
              }
              expectedHoleCentroids.push({ x: cx / n, z: cz / n, area });
            }
          }
        }

        for (const poly of emittedUnion) {
          for (let rIdx = 1; rIdx < poly.length; rIdx++) {
            const holeRing = poly[rIdx];
            const holeArea = Math.abs(computeSignedRingArea(holeRing));
            if (holeArea > 1e-4 && holeArea <= UNINTENDED_INTERIOR_HOLE_MAX_AREA_M2) {
              let cx = 0,
                cz = 0;
              const n = Math.max(1, holeRing.length - 1);
              for (let i = 0; i < n; i++) {
                cx += holeRing[i][0];
                cz += holeRing[i][1];
              }
              cx /= n;
              cz /= n;
              const matchesExpectedLoop = expectedHoleCentroids.some(
                (eh) => Math.hypot(eh.x - cx, eh.z - cz) < 2.5
              );
              if (!matchesExpectedLoop) {
                coverageDefects.push({
                  kind: 'unintended_interior_hole',
                  featureId: 'network-union',
                  expectedAreaM2: 0,
                  ownEmittedAreaM2: emittedAtGradeUnionAreaM2,
                  occludedByHigherPriorityAreaM2: 0,
                  unexplainedMissingAreaM2: holeArea,
                  sampleWorldPoint: [cx, cz],
                  description: `Unintended interior hole of area ${holeArea.toFixed(4)} m² detected inside road surface union at (${cx.toFixed(2)}, ${cz.toFixed(2)})`,
                });
              }
            }
          }
        }
      }
    } catch {
      // Fallback if union over very large triangle soup exceeds recursion/precision limits
      for (const c of expectedCorridors) {
        independentExpectedUnionAreaM2 += computeMultiPolygonArea(c);
      }
      for (const t of emittedTriangles) {
        emittedAtGradeUnionAreaM2 += t.areaM2;
      }
    }
  }

  const networkCoverageRatio =
    independentExpectedUnionAreaM2 > 1e-6
      ? Math.min(1, emittedAtGradeUnionAreaM2 / independentExpectedUnionAreaM2)
      : 1;

  const coverageReport: SurfaceFirstCoverageValidationReport = {
    eligibleAtGradeEdgeCount,
    evaluatedSubSegmentCount,
    independentExpectedUnionAreaM2,
    emittedAtGradeUnionAreaM2,
    unexplainedNetworkMissingAreaM2,
    networkCoverageRatio,
    checkedConnectedNodeCount,
    checkedProvenanceSplitJoinCount,
    legitimatelyFullSubtractedFeatureIds: Array.from(legitimatelyFullSubtractedFeatureIds).sort(),
    legitimatelyPartiallyClippedFeatureIds: Array.from(
      legitimatelyPartiallyClippedFeatureIds
    ).sort(),
    defects: coverageDefects,
  };

  // ============================================================================
  // A4. Source-Feature Provenance Validation
  // ============================================================================
  const provenanceDefects: SurfaceProvenanceDefect[] = [];
  const sourceRoadsById = new Map<string, RoadFeature>();
  const sourcePointsById = new Map<string, [number, number][]>();

  const registerSourcePoints = (key: string | undefined, pts: readonly (readonly [number, number])[]) => {
    if (!key || !pts || pts.length === 0) return;
    const mapped = pts.map((p) => [p[0], p[1]] as [number, number]);
    const existing = sourcePointsById.get(key);
    if (existing) {
      existing.push(...mapped);
    } else {
      sourcePointsById.set(key, mapped);
    }
  };

  if (data.topologySource?.roadParts) {
    for (const part of data.topologySource.roadParts) {
      const asRoad: RoadFeature = {
        id: part.id,
        sourceFeatureId: part.sourceFeatureId,
        type: 'road',
        roadClass: part.roadClass,
        width: part.width,
        points: part.points.map((p) => [p[0], p[1]] as [number, number]),
        nodeIds: part.rawOsmNodeIds
          ? part.rawOsmNodeIds.filter((id): id is string => typeof id === 'string')
          : undefined,
        name: part.name,
        layer: part.layer,
        isBridge: part.isBridge,
        isTunnel: part.isTunnel,
        osmTags: part.osmTags,
      };
      if (!sourceRoadsById.has(part.id)) {
        sourceRoadsById.set(part.id, asRoad);
      }
      if (part.sourceFeatureId && !sourceRoadsById.has(part.sourceFeatureId)) {
        sourceRoadsById.set(part.sourceFeatureId, asRoad);
      }
      registerSourcePoints(part.id, part.points);
      registerSourcePoints(part.sourceFeatureId, part.points);
    }
  }

  for (const r of data.roads) {
    sourceRoadsById.set(r.id, r);
    if (r.sourceFeatureId) {
      sourceRoadsById.set(r.sourceFeatureId, r);
    }
    registerSourcePoints(r.id, r.points);
    registerSourcePoints(r.sourceFeatureId, r.points);
  }

  let totalAuditedFaceRanges = 0;
  let totalAuditedTriangles = 0;
  let attributedTriangleCount = 0;
  const verifiedSourceFeatureIds = new Set<string>();
  const verifiedProvenanceSplitEdgeIds = new Set<string>();
  const verifiedDeduplicatedSurvivorIds = new Set<string>();

  scene.roadsGroup.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (STRUCTURAL_ROAD_MESH_NAMES.has(obj.name)) return;
    const geom = obj.geometry as THREE.BufferGeometry | undefined;
    if (!geom) return;
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr || posAttr.count < 3) return;
    const idxAttr = geom.getIndex();
    const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);
    const ranges = (obj.userData?.faceRanges as FaceFeatureRange[] | undefined) ?? [];

    totalAuditedFaceRanges += ranges.length;
    totalAuditedTriangles += triCount;

    // Verify every face index resolves via resolveInspectedFeature
    for (let f = 0; f < triCount; f++) {
      const picked = resolveInspectedFeature({ object: obj, faceIndex: f });
      if (!picked) {
        provenanceDefects.push({
          kind: 'unattributed_triangle_face',
          meshName: obj.name,
          description: `Face ${f} on ${obj.name} failed to resolve via resolveInspectedFeature`,
        });
      } else {
        attributedTriangleCount++;
      }
    }

    const expectedClass = obj.name.startsWith('Roads_')
      ? (obj.name.slice(6) as RoadClass)
      : undefined;

    for (const r of ranges) {
      const info = r.info;
      if (!info.sourceFeatureId) {
        provenanceDefects.push({
          kind: 'missing_source_feature_id',
          meshName: obj.name,
          featureId: info.id,
          description: `FaceFeatureRange [${r.startFace}, ${r.endFace}) on ${obj.name} is missing sourceFeatureId`,
        });
        continue;
      }

      const sourceRoad = sourceRoadsById.get(info.sourceFeatureId);
      if (!sourceRoad) {
        provenanceDefects.push({
          kind: 'unknown_source_feature_id',
          meshName: obj.name,
          featureId: info.id,
          sourceFeatureId: info.sourceFeatureId,
          description: `FaceFeatureRange ${info.id} references unknown sourceFeatureId "${info.sourceFeatureId}"`,
        });
        continue;
      }

      verifiedSourceFeatureIds.add(info.sourceFeatureId);
      if (info.id.includes('#seg')) {
        verifiedProvenanceSplitEdgeIds.add(info.id.split('#seg')[0]);
      }

      // Verify subtype / roadClass matches mesh and source feature (except bridge deck mesh `Roads_bridge` or junction dominant class)
      const isJunctionFeature = info.id.startsWith('junction-') || info.id.startsWith('path-junction-');
      if (expectedClass && expectedClass !== 'bridge' && info.subtype !== expectedClass) {
        provenanceDefects.push({
          kind: 'road_class_mismatch',
          meshName: obj.name,
          featureId: info.id,
          sourceFeatureId: info.sourceFeatureId,
          description: `Feature ${info.id} has subtype="${info.subtype}" inside mesh "${obj.name}"`,
        });
      }
      if (!isJunctionFeature && !info.isBridge && info.subtype !== sourceRoad.roadClass) {
        provenanceDefects.push({
          kind: 'road_class_mismatch',
          meshName: obj.name,
          featureId: info.id,
          sourceFeatureId: info.sourceFeatureId,
          description: `Feature ${info.id} has subtype="${info.subtype}" but source OSM way "${info.sourceFeatureId}" has roadClass="${sourceRoad.roadClass}"`,
        });
      }

      // Verify original OSM primitive tags are preserved on non-junction road ranges
      if (!isJunctionFeature && sourceRoad.osmTags) {
        for (const [k, v] of Object.entries(sourceRoad.osmTags)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            if (info.osmTags?.[k] !== v) {
              provenanceDefects.push({
                kind: 'osm_tag_mismatch',
                meshName: obj.name,
                featureId: info.id,
                sourceFeatureId: info.sourceFeatureId,
                description: `Feature ${info.id} lost or altered OSM tag "${k}": expected "${String(v)}", got "${String(info.osmTags?.[k])}"`,
              });
              break;
            }
          }
        }
      }

      // Verify spatial provenance envelope: vertices of a non-junction road segment must lie within
      // the bounding box of its source OSM way expanded by road width + 1.5m tolerance
      const refPoints = sourcePointsById.get(info.sourceFeatureId) ?? sourceRoad.points;
      if (!isJunctionFeature && !info.isBridge && refPoints.length >= 2) {
        let sMinX = Infinity,
          sMaxX = -Infinity,
          sMinZ = Infinity,
          sMaxZ = -Infinity;
        for (const [px, pz] of refPoints) {
          sMinX = Math.min(sMinX, px);
          sMaxX = Math.max(sMaxX, px);
          sMinZ = Math.min(sMinZ, pz);
          sMaxZ = Math.max(sMaxZ, pz);
        }
        const margin = (info.width ?? sourceRoad.width) * roadWidthMultiplier + 1.5;
        let tMinX = Infinity,
          tMaxX = -Infinity,
          tMinZ = Infinity,
          tMaxZ = -Infinity;
        for (let f = r.startFace; f < r.endFace && f < triCount; f++) {
          for (let k = 0; k < 3; k++) {
            const vIdx = idxAttr ? idxAttr.getX(f * 3 + k) : f * 3 + k;
            v0.fromBufferAttribute(posAttr, vIdx).applyMatrix4(obj.matrixWorld);
            tMinX = Math.min(tMinX, v0.x);
            tMaxX = Math.max(tMaxX, v0.x);
            tMinZ = Math.min(tMinZ, v0.z);
            tMaxZ = Math.max(tMaxZ, v0.z);
          }
        }
        if (
          tMinX < sMinX - margin ||
          tMaxX > sMaxX + margin ||
          tMinZ < sMinZ - margin ||
          tMaxZ > sMaxZ + margin
        ) {
          provenanceDefects.push({
            kind: 'provenance_span_escape',
            meshName: obj.name,
            featureId: info.id,
            sourceFeatureId: info.sourceFeatureId,
            description: `Triangles of ${info.id} (${info.sourceFeatureId}) escaped source way envelope: mesh bbox [${tMinX.toFixed(1)}, ${tMaxX.toFixed(1)}]x[${tMinZ.toFixed(1)}, ${tMaxZ.toFixed(1)}] vs source [${sMinX.toFixed(1)}, ${sMaxX.toFixed(1)}]x[${sMinZ.toFixed(1)}, ${sMaxZ.toFixed(1)}] ± ${margin.toFixed(1)}m`,
          });
        }
      }
    }
  });

  // Verify deduplicated feature lineage propagation
  const lineage = scene.roadsGroup.userData?.graphRoadLineage as
    | {
        renderedSourceIds: string[];
        deduplicatedMap: Record<string, string[]>;
        chainingMap: Record<string, string[]>;
      }
    | undefined;
  if (lineage?.deduplicatedMap) {
    for (const [survivorId, dupIds] of Object.entries(lineage.deduplicatedMap)) {
      if (verifiedSourceFeatureIds.has(survivorId)) {
        verifiedDeduplicatedSurvivorIds.add(survivorId);
        // Check that at least one FaceFeatureRange for survivorId includes every dupId in sourceFeatureIds
        let allIncluded = true;
        scene.roadsGroup.traverse((obj) => {
          if (!(obj instanceof THREE.Mesh)) return;
          const ranges = (obj.userData?.faceRanges as FaceFeatureRange[] | undefined) ?? [];
          for (const r of ranges) {
            if (r.info.sourceFeatureId === survivorId) {
              for (const dupId of dupIds) {
                if (!r.info.sourceFeatureIds?.includes(dupId)) {
                  allIncluded = false;
                }
              }
            }
          }
        });
        if (!allIncluded) {
          provenanceDefects.push({
            kind: 'deduplicated_lineage_missing',
            sourceFeatureId: survivorId,
            description: `Survivor feature ${survivorId} did not include all deduplicated IDs [${dupIds.join(', ')}] in its FaceFeatureRange.sourceFeatureIds`,
          });
        }
      }
    }
  }

  // Verify fullySubtractedRoadIds
  const fullySubtractedIds =
    (scene.roadsGroup.userData?.fullySubtractedRoadIds as string[] | undefined) ?? [];
  const verifiedFullySubtractedIds: string[] = [];
  for (const subId of fullySubtractedIds) {
    if (subId.startsWith('way/')) {
      verifiedFullySubtractedIds.push(subId);
      if (!legitimatelyFullSubtractedFeatureIds.has(subId) && descriptors) {
        const matchingEdges = descriptors.roadEdges.filter((e) =>
          e.sourceFeatureIds.includes(subId)
        );
        const hasLegitimateSubtractedPart = matchingEdges.some(
          (e) =>
            legitimatelyFullSubtractedFeatureIds.has(e.id) ||
            (e.provenance.segments.length > 1 &&
              legitimatelyPartiallyClippedFeatureIds.has(e.id))
        );
        if (matchingEdges.length > 0 && !hasLegitimateSubtractedPart) {
          provenanceDefects.push({
            kind: 'invalid_fully_subtracted_claim',
            sourceFeatureId: subId,
            description: `Feature ${subId} is marked in fullySubtractedRoadIds, but its expected corridor was not fully covered by higher-priority road surfaces`,
          });
        }
      }
    }
  }

  const diagnosticsFullySubtractedCount =
    data.diagnostics?.featuresFullySubtracted?.count ?? 0;
  const statsFullySubtractedCount = stats?.fullySubtractedCount ?? 0;

  const provenanceReport: SurfaceFirstProvenanceValidationReport = {
    totalAuditedFaceRanges,
    totalAuditedTriangles,
    attributedTriangleCount,
    verifiedSourceFeatureIds: Array.from(verifiedSourceFeatureIds).sort(),
    verifiedProvenanceSplitEdgeIds: Array.from(verifiedProvenanceSplitEdgeIds).sort(),
    verifiedDeduplicatedSurvivorIds: Array.from(verifiedDeduplicatedSurvivorIds).sort(),
    verifiedFullySubtractedIds: verifiedFullySubtractedIds.sort(),
    diagnosticsFullySubtractedCount,
    statsFullySubtractedCount,
    defects: provenanceDefects,
  };

  const valid =
    coverageReport.defects.length === 0 &&
    overlapsReport.totalPositiveAreaOverlapCount === 0 &&
    meshIntegrityReport.auditReport.windingDefects.length === 0 &&
    meshIntegrityReport.auditReport.degenerateTriangles.length === 0 &&
    meshIntegrityReport.inconsistentElevationDefectCount === 0 &&
    meshIntegrityReport.tinyDisconnectedFragmentCount === 0 &&
    provenanceReport.defects.length === 0;

  return {
    valid,
    rendererMode,
    coverage: coverageReport,
    overlaps: overlapsReport,
    meshIntegrity: meshIntegrityReport,
    provenance: provenanceReport,
  };
}
