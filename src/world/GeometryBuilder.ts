import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  BarrierFeature,
  BuildingFeature,
  InspectableFeatureInfo,
  LanduseFeature,
  LinearWaterwayFeature,
  MapStyleTheme,
  ParkFeature,
  PointLandmarkFeature,
  ProcessedMapData,
  RailwayFeature,
  RawGeoJsonProperties,
  RoadClass,
  RoadFeature,
  RoadPortalConnectionSpec,
  WaterBodyFeature,
} from '../types/MapFeature';
import {
  ELEVATION_POLICY,
  DEPTH_OFFSET_CONFIG,
  getRoadElevation,
  getRailwayElevations,
  getLanduseElevationAndOffset,
  hashFeatureId,
  isNonVehicularRoadClass,
} from './ElevationPolicy';
import polygonClipping from 'polygon-clipping';
import { TopologicalNodeIndex } from './TopologicalNodeIndex';
import { SceneResourceManager } from './SceneResourceManager';
import {
  buildBridgeProfile3D,
  computePolylineLength,
  generateBridgeStructureGeometries,
  generateProfiledRibbon3D,
  generateTunnelPortalAndTraceGeometries,
  trimPolylineByArcLength,
} from './BridgeAndTunnelBuilder';
import {
  COORDINATE_SNAP_QUANTUM,
  MultiPolygonCoords,
  filterDegenerateBooleanArtifacts,
  resolveAndValidatePlanarPolygons,
} from './PlanarLayerValidator';
import {
  buildRailwayInfrastructure,
  type RailwayPrototypeResult,
} from './infrastructure/railways/RailwayGeometryBuilder';
import {
  adaptInfrastructureGraphToRenderDescriptors,
  buildInfrastructureRenderDescriptors,
  cloneDescriptorOsmTags,
  DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS,
  normalizeInfrastructureRenderOptions,
  parseInfrastructureRenderOptionsFromSearch,
  parseInfrastructureRenderSource,
  prepareInfrastructureRenderPreview,
  requiresInfrastructureGraphPreview,
  validateInfrastructureRenderDescriptors,
  type InfrastructureRenderDescriptorBundle,
  type InfrastructureRenderOptions,
  type InfrastructureRenderPreviewResult,
  type InfrastructureRenderSource,
  type InfrastructureRenderValidationReport,
} from './infrastructure/rendering/InfrastructureRenderAdapter';

export {
  SceneResourceManager,
  adaptInfrastructureGraphToRenderDescriptors,
  buildInfrastructureRenderDescriptors,
  cloneDescriptorOsmTags,
  DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS,
  normalizeInfrastructureRenderOptions,
  parseInfrastructureRenderOptionsFromSearch,
  parseInfrastructureRenderSource,
  prepareInfrastructureRenderPreview,
  requiresInfrastructureGraphPreview,
  validateInfrastructureRenderDescriptors,
  type InfrastructureRenderDescriptorBundle,
  type InfrastructureRenderOptions,
  type InfrastructureRenderPreviewResult,
  type InfrastructureRenderSource,
  type InfrastructureRenderValidationReport,
};


export interface GeometryBuilderOptions {
  buildingHeightMultiplier?: number;
  roadWidthMultiplier?: number;
  bevelEnabled?: boolean;
  initialCameraZoom?: number;
  infrastructureRenderOptions?: Partial<InfrastructureRenderOptions>;
  infrastructureRenderPreview?: InfrastructureRenderPreviewResult | null;
}

export interface FaceFeatureRange {
  startFace: number;
  endFace: number;
  info: InspectableFeatureInfo;
}

export interface BuiltSceneGeometry {
  buildingsGroup: THREE.Group;
  roadsGroup: THREE.Group;
  railwaysGroup: THREE.Group;
  waterGroup: THREE.Group;
  parksGroup: THREE.Group;
  landuseGroup: THREE.Group;
  barriersGroup: THREE.Group;
  foliageGroup: THREE.Group;
  groundMesh: THREE.Mesh;
  interactiveMeshes: {
    buildings: THREE.Mesh[];
  };
  stats: {
    totalVertices: number;
    totalTriangles: number;
    totalDrawCalls: number;
    renderedFeaturesCount: number;
    forestTreesCount?: number;
  };
  resources: SceneResourceManager;
  infrastructureRenderOptions: InfrastructureRenderOptions;
  infrastructureRenderPreview: InfrastructureRenderPreviewResult | null;
  dispose: () => void;
  updateTheme: (theme: MapStyleTheme) => void;
  updateCameraZoom?: (zoom: number) => void;
}

export interface RoadRibbonOptions {
  roundCaps?: boolean;
  hasStartCap?: boolean;
  hasEndCap?: boolean;
  capSegments?: number;
  startPortal?: { left: [number, number]; right: [number, number] };
  endPortal?: { left: [number, number]; right: [number, number] };
}

/**
 * Resolves any Three.js / React Three Fiber raycast intersection to its exact OpenStreetMap feature metadata.
 * Supports:
 * 1. InstancedMesh hits via `instanceId` (3D forest trees, towers, point landmarks)
 * 2. Merged BufferGeometry hits via `faceIndex` binary search (`faceRanges` on roads, railways, parks, landuse, water, barriers)
 * 3. Individual mesh `userData` hits (buildings & custom structures)
 */
export function resolveInspectedFeature(hit: {
  object?: any;
  faceIndex?: number | null;
  instanceId?: number | null;
}): InspectableFeatureInfo | null {
  if (!hit || !hit.object) return null;
  const obj = hit.object;
  const ud = obj.userData;
  if (!ud) return null;

  // 1. InstancedMesh lookup
  if (ud.isInstanced && Array.isArray(ud.instanceInfos) && typeof hit.instanceId === 'number') {
    return ud.instanceInfos[hit.instanceId] || null;
  }

  // 2. Merged geometry faceIndex binary search lookup
  if (Array.isArray(ud.faceRanges) && typeof hit.faceIndex === 'number') {
    const ranges: FaceFeatureRange[] = ud.faceRanges;
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const r = ranges[mid];
      if (hit.faceIndex < r.startFace) {
        hi = mid - 1;
      } else if (hit.faceIndex >= r.endFace) {
        lo = mid + 1;
      } else {
        return r.info;
      }
    }
  }

  // 3. Direct mesh userData lookup (e.g. Buildings)
  if (ud.id) {
    return ud as InspectableFeatureInfo;
  }

  return null;
}

function sanitizeOsmTags(raw?: RawGeoJsonProperties): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null && typeof v !== 'object') {
      out[k] = v as string | number | boolean;
    }
  }
  return out;
}


/**
 * Pure math helper to compute 2D ribbon strip vertices from a centerline polyline.
 * Exported for unit testing and reusable for roads, railways, and linear waterways.
 * Supports independent start and end caps for clean junction trimming and cul-de-sacs.
 */
export function generateRoadRibbon(
  points: [number, number][],
  width: number,
  yElevation: number = 0.050,
  options?: RoadRibbonOptions
): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } | null {
  if (!points || points.length < 2) return null;

  // Filter out duplicate consecutive points to prevent degenerate zero-length vectors,
  // while always preserving both the exact start and exact end points.
  const cleanPoints: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    if (cleanPoints.length === 0) {
      cleanPoints.push(pt);
    } else {
      const prev = cleanPoints[cleanPoints.length - 1];
      if (Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > 0.01) {
        cleanPoints.push(pt);
      } else if (i === points.length - 1 && cleanPoints.length >= 2) {
        cleanPoints[cleanPoints.length - 1] = pt;
      }
    }
  }

  if (cleanPoints.length < 2) return null;

  const n = cleanPoints.length;
  const stripVertexCount = n * 2;
  const quadCount = n - 1;
  const stripTriangleCount = quadCount * 2;

  const halfW = width / 2;

  // Tangents along segments
  const tangents: [number, number][] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = cleanPoints[i + 1][0] - cleanPoints[i][0];
    const dz = cleanPoints[i + 1][1] - cleanPoints[i][1];
    const len = Math.hypot(dx, dz) || 1e-6;
    tangents.push([dx / len, dz / len]);
  }

  // Calculate whether start and end meet (closed loop, e.g. roundabout)
  const isClosed =
    Math.hypot(
      cleanPoints[0][0] - cleanPoints[n - 1][0],
      cleanPoints[0][1] - cleanPoints[n - 1][1]
    ) < 0.05;

  const allowCaps = Boolean(options?.roundCaps && !isClosed);
  const addStartCap = allowCaps && !options?.startPortal && (options?.hasStartCap ?? true);
  const addEndCap = allowCaps && !options?.endPortal && (options?.hasEndCap ?? true);
  const capSegments = Math.max(3, options?.capSegments ?? 6);

  const numCaps = (addStartCap ? 1 : 0) + (addEndCap ? 1 : 0);
  const extraVertices = numCaps * capSegments;
  const extraTriangles = numCaps * capSegments;

  const totalVertices = stripVertexCount + extraVertices;
  const totalTriangles = stripTriangleCount + extraTriangles;

  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const indices = new Uint32Array(totalTriangles * 3);

  // Calculate vertex normals and offsets for each point
  for (let i = 0; i < n; i++) {
    let tx = 0;
    let tz = 0;

    if (i === 0) {
      [tx, tz] = tangents[0];
    } else if (i === n - 1) {
      [tx, tz] = tangents[n - 2];
    } else {
      tx = tangents[i - 1][0] + tangents[i][0];
      tz = tangents[i - 1][1] + tangents[i][1];
      const len = Math.hypot(tx, tz) || 1e-6;
      tx /= len;
      tz /= len;
    }

    // Perpendicular vector in XZ plane: (-tz, tx)
    const nx = -tz;
    const nz = tx;

    // Miter calculation to maintain uniform road width around turns without flared corner spikes
    let miterScale = 1.0;
    if (i > 0 && i < n - 1) {
      const dot = tangents[i - 1][0] * tangents[i][0] + tangents[i - 1][1] * tangents[i][1];
      const cosHalf = Math.sqrt(Math.max(0.1, (1 + dot) / 2));
      miterScale = Math.min(1.30, 1.0 / Math.max(0.76, cosHalf));
    }

    const offsetX = nx * halfW * miterScale;
    const offsetZ = nz * halfW * miterScale;

    const px = cleanPoints[i][0];
    const pz = cleanPoints[i][1];

    // Left vertex
    const leftIdx = i * 2;
    if (i === 0 && options?.startPortal) {
      positions[leftIdx * 3] = options.startPortal.left[0];
      positions[leftIdx * 3 + 1] = yElevation;
      positions[leftIdx * 3 + 2] = options.startPortal.left[1];
    } else if (i === n - 1 && options?.endPortal) {
      positions[leftIdx * 3] = options.endPortal.left[0];
      positions[leftIdx * 3 + 1] = yElevation;
      positions[leftIdx * 3 + 2] = options.endPortal.left[1];
    } else {
      positions[leftIdx * 3] = px + offsetX;
      positions[leftIdx * 3 + 1] = yElevation;
      positions[leftIdx * 3 + 2] = pz + offsetZ;
    }

    normals[leftIdx * 3] = 0;
    normals[leftIdx * 3 + 1] = 1;
    normals[leftIdx * 3 + 2] = 0;

    // Right vertex
    const rightIdx = i * 2 + 1;
    if (i === 0 && options?.startPortal) {
      positions[rightIdx * 3] = options.startPortal.right[0];
      positions[rightIdx * 3 + 1] = yElevation;
      positions[rightIdx * 3 + 2] = options.startPortal.right[1];
    } else if (i === n - 1 && options?.endPortal) {
      positions[rightIdx * 3] = options.endPortal.right[0];
      positions[rightIdx * 3 + 1] = yElevation;
      positions[rightIdx * 3 + 2] = options.endPortal.right[1];
    } else {
      positions[rightIdx * 3] = px - offsetX;
      positions[rightIdx * 3 + 1] = yElevation;
      positions[rightIdx * 3 + 2] = pz - offsetZ;
    }

    normals[rightIdx * 3] = 0;
    normals[rightIdx * 3 + 1] = 1;
    normals[rightIdx * 3 + 2] = 0;
  }

  // Generate triangle indices (CCW when viewed from above)
  let idxOffset = 0;
  for (let i = 0; i < quadCount; i++) {
    const l0 = i * 2;
    const r0 = i * 2 + 1;
    const l1 = (i + 1) * 2;
    const r1 = (i + 1) * 2 + 1;

    // Triangle 1: l0, l1, r0
    indices[idxOffset++] = l0;
    indices[idxOffset++] = l1;
    indices[idxOffset++] = r0;

    // Triangle 2: r0, l1, r1
    indices[idxOffset++] = r0;
    indices[idxOffset++] = l1;
    indices[idxOffset++] = r1;
  }

  let nextVertex = stripVertexCount;

  // 1. Start Cap (at cleanPoints[0], opposite tangent[0])
  if (addStartCap) {
    const p0x = cleanPoints[0][0];
    const p0z = cleanPoints[0][1];
    const t0x = tangents[0][0];
    const t0z = tangents[0][1];
    const n0x = -t0z;
    const n0z = t0x;

    const centerStartIdx = nextVertex++;
    positions[centerStartIdx * 3] = p0x;
    positions[centerStartIdx * 3 + 1] = yElevation;
    positions[centerStartIdx * 3 + 2] = p0z;
    normals[centerStartIdx * 3] = 0;
    normals[centerStartIdx * 3 + 1] = 1;
    normals[centerStartIdx * 3 + 2] = 0;

    const startArcIndices: number[] = [0];
    for (let k = 1; k < capSegments; k++) {
      const angle = Math.PI / 2 + (k / capSegments) * Math.PI;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const vx = cosA * t0x + sinA * n0x;
      const vz = cosA * t0z + sinA * n0z;

      const vIdx = nextVertex++;
      positions[vIdx * 3] = p0x + vx * halfW;
      positions[vIdx * 3 + 1] = yElevation;
      positions[vIdx * 3 + 2] = p0z + vz * halfW;
      normals[vIdx * 3] = 0;
      normals[vIdx * 3 + 1] = 1;
      normals[vIdx * 3 + 2] = 0;
      startArcIndices.push(vIdx);
    }
    startArcIndices.push(1); // Right vertex (1)

    for (let k = 0; k < capSegments; k++) {
      indices[idxOffset++] = centerStartIdx;
      indices[idxOffset++] = startArcIndices[k + 1];
      indices[idxOffset++] = startArcIndices[k];
    }
  }

  // 2. End Cap (at cleanPoints[n-1], along tangent[n-2])
  if (addEndCap) {
    const pnx = cleanPoints[n - 1][0];
    const pnz = cleanPoints[n - 1][1];
    const tnx = tangents[n - 2][0];
    const tnz = tangents[n - 2][1];
    const nnx = -tnz;
    const nnz = tnx;

    const centerEndIdx = nextVertex++;
    positions[centerEndIdx * 3] = pnx;
    positions[centerEndIdx * 3 + 1] = yElevation;
    positions[centerEndIdx * 3 + 2] = pnz;
    normals[centerEndIdx * 3] = 0;
    normals[centerEndIdx * 3 + 1] = 1;
    normals[centerEndIdx * 3 + 2] = 0;

    const rightEndIdx = 2 * n - 1;
    const leftEndIdx = 2 * n - 2;

    const endArcIndices: number[] = [rightEndIdx];
    for (let k = 1; k < capSegments; k++) {
      const angle = -Math.PI / 2 + (k / capSegments) * Math.PI;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const vx = cosA * tnx + sinA * nnx;
      const vz = cosA * tnz + sinA * nnz;

      const vIdx = nextVertex++;
      positions[vIdx * 3] = pnx + vx * halfW;
      positions[vIdx * 3 + 1] = yElevation;
      positions[vIdx * 3 + 2] = pnz + vz * halfW;
      normals[vIdx * 3] = 0;
      normals[vIdx * 3 + 1] = 1;
      normals[vIdx * 3 + 2] = 0;
      endArcIndices.push(vIdx);
    }
    endArcIndices.push(leftEndIdx);

    for (let k = 0; k < capSegments; k++) {
      indices[idxOffset++] = centerEndIdx;
      indices[idxOffset++] = endArcIndices[k + 1];
      indices[idxOffset++] = endArcIndices[k];
    }
  }

  return { positions, normals, indices };
}

/**
 * Generates a 3D volumetric wall/hedge extrusion along a polyline (top surface + side walls).
 */
export function generateExtrudedBarrierRibbon(
  points: [number, number][],
  width: number,
  height: number,
  baseY: number = 0.0
): THREE.BufferGeometry | null {
  if (!points || points.length < 2) return null;

  const cleanPoints: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (cleanPoints.length === 0) {
      cleanPoints.push(pt);
    } else {
      const prev = cleanPoints[cleanPoints.length - 1];
      if (Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > 0.02) {
        cleanPoints.push(pt);
      }
    }
  }
  if (cleanPoints.length < 2) return null;

  const topY = baseY + height;
  const topRibbon = generateRoadRibbon(cleanPoints, width, topY, { roundCaps: false });
  if (!topRibbon) return null;

  const positions: number[] = Array.from(topRibbon.positions);
  const normals: number[] = Array.from(topRibbon.normals);
  const indices: number[] = Array.from(topRibbon.indices);

  let vOffset = topRibbon.positions.length / 3;
  const halfW = width / 2;

  for (let i = 0; i < cleanPoints.length - 1; i++) {
    const p0 = cleanPoints[i];
    const p1 = cleanPoints[i + 1];
    const dx = p1[0] - p0[0];
    const dz = p1[1] - p0[1];
    const len = Math.hypot(dx, dz) || 1e-6;
    const nx = -dz / len;
    const nz = dx / len;

    // Left wall (facing +nx, +nz)
    const l0x = p0[0] + nx * halfW;
    const l0z = p0[1] + nz * halfW;
    const l1x = p1[0] + nx * halfW;
    const l1z = p1[1] + nz * halfW;

    positions.push(
      l0x, baseY, l0z,
      l1x, baseY, l1z,
      l1x, topY, l1z,
      l0x, topY, l0z
    );
    for (let k = 0; k < 4; k++) normals.push(nx, 0, nz);
    indices.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
    vOffset += 4;

    // Right wall (facing -nx, -nz)
    const r0x = p0[0] - nx * halfW;
    const r0z = p0[1] - nz * halfW;
    const r1x = p1[0] - nx * halfW;
    const r1z = p1[1] - nz * halfW;

    positions.push(
      r1x, baseY, r1z,
      r0x, baseY, r0z,
      r0x, topY, r0z,
      r1x, topY, r1z
    );
    for (let k = 0; k < 4; k++) normals.push(-nx, 0, -nz);
    indices.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
    vOffset += 4;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

/**
 * Ray-casting 2D point-in-polygon check (outer ring in, hole rings out) for procedural 3D forest tree sampling.
 */
function isPointInPolygonRings(x: number, z: number, rings: [number, number][][]): boolean {
  if (!rings || rings.length === 0) return false;

  const inRing = (ring: [number, number][]): boolean => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], zi = ring[i][1];
      const xj = ring[j][0], zj = ring[j][1];
      const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  };

  if (!inRing(rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    if (inRing(rings[h])) return false;
  }
  return true;
}

/**
 * Creates a THREE.Shape from polygon rings (outer ring + holes) in the XZ plane.
 * Normalizes outer ring to counter-clockwise (CCW) and hole rings to clockwise (CW)
 * in Three.js 2D Shape space (x, -z) so earcut triangulation never inverts or drops holes.
 */
export function createShapeFromRings(rings: [number, number][][]): THREE.Shape | null {
  if (!rings || rings.length === 0) return null;
  const rawOuter = rings[0];
  if (!rawOuter || rawOuter.length < 3) return null;

  const toVec2Ring = (ring: [number, number][], wantClockwise: boolean): THREE.Vector2[] => {
    const pts: THREE.Vector2[] = [];
    for (const [x, z] of ring) {
      const vx = x;
      const vy = -z;
      if (pts.length === 0 || Math.hypot(vx - pts[pts.length - 1].x, vy - pts[pts.length - 1].y) > 1e-4) {
        pts.push(new THREE.Vector2(vx, vy));
      }
    }
    if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= 1e-4) {
      pts.pop();
    }
    if (pts.length < 3) return [];
    const isCW = THREE.ShapeUtils.isClockWise(pts);
    if (isCW !== wantClockwise) {
      pts.reverse();
    }
    return pts;
  };

  const outerPts = toVec2Ring(rawOuter, false); // CCW outer ring
  if (outerPts.length < 3) return null;

  const shape = new THREE.Shape(outerPts);
  shape.closePath();

  for (let h = 1; h < rings.length; h++) {
    const holePts = toVec2Ring(rings[h], true); // CW hole ring
    if (holePts.length >= 3) {
      const holePath = new THREE.Path(holePts);
      holePath.closePath();
      shape.holes.push(holePath);
    }
  }

  return shape;
}

/**
 * Converts a resolved MultiPolygon (which may contain disconnected outer polygons and interior holes)
 * into an array of winding-normalized THREE.Shape instances.
 */
export function createShapesFromMultiPolygon(mp: MultiPolygonCoords): THREE.Shape[] {
  const shapes: THREE.Shape[] = [];
  if (!mp || mp.length === 0) return shapes;
  for (const polyRings of mp) {
    const s = createShapeFromRings(polyRings);
    if (s) shapes.push(s);
  }
  return shapes;
}

interface RoadBranch {
  road: RoadFeature;
  endpoint: 'start' | 'end';
  dir: [number, number];
  nodePos: [number, number];
  width: number;
  roadClass: RoadClass;
  segmentLength: number;
}

function getTriangleCount(geom: THREE.BufferGeometry): number {
  if (geom.index) {
    return geom.index.count / 3;
  }
  return (geom.attributes.position?.count || 0) / 3;
}

function mergeWithFaceRanges(
  items: Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }>,
  resourceManager?: SceneResourceManager
): { merged: THREE.BufferGeometry | null; faceRanges: FaceFeatureRange[] } {
  if (items.length === 0) return { merged: null, faceRanges: [] };
  const geos: THREE.BufferGeometry[] = [];
  const faceRanges: FaceFeatureRange[] = [];
  const combinedGroups: Array<{ start: number; count: number; materialIndex: number }> = [];
  let hasGroups = false;
  let cursor = 0;

  for (const item of items) {
    const triCount = getTriangleCount(item.geom);
    if (triCount <= 0) {
      if (resourceManager) resourceManager.releaseIntermediateGeometry(item.geom);
      else item.geom.dispose();
      continue;
    }
    if (item.geom.groups && item.geom.groups.length > 0) {
      hasGroups = true;
      const offset = cursor * 3;
      for (const g of item.geom.groups) {
        combinedGroups.push({
          start: offset + g.start,
          count: g.count,
          materialIndex: g.materialIndex ?? 0,
        });
      }
    }
    geos.push(item.geom);
    faceRanges.push({
      startFace: cursor,
      endFace: cursor + triCount,
      info: item.info,
    });
    cursor += triCount;
  }

  if (geos.length === 0) return { merged: null, faceRanges: [] };
  const merged = mergeGeometries(geos, false);
  for (const g of geos) {
    if (resourceManager) {
      resourceManager.releaseIntermediateGeometry(g);
    } else {
      g.dispose();
    }
  }
  if (merged && hasGroups) {
    merged.clearGroups();
    for (const g of combinedGroups) {
      merged.addGroup(g.start, g.count, g.materialIndex);
    }
  }
  return { merged, faceRanges };
}

/**
 * Extracts a closed 2D outer polygon ring `[x, z][]` around a centerline polyline of width `width`
 * so at-grade road ribbons and footpaths can participate in exact 2D Boolean clipping.
 */
function buildRoadRibbonOutlineRing(
  points: [number, number][],
  width: number,
  options?: Pick<RoadRibbonOptions, 'startPortal' | 'endPortal'>
): [number, number][][] | null {
  const ribbon = generateRoadRibbon(points, width, 0, {
    roundCaps: false,
    startPortal: options?.startPortal,
    endPortal: options?.endPortal,
  });
  if (!ribbon) return null;
  const pos = ribbon.positions;
  const n = pos.length / 6; // n points => 2*n vertices
  if (n < 2) return null;

  const ring: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const lIdx = i * 2;
    const x = pos[lIdx * 3];
    const z = pos[lIdx * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    ring.push([snapCoord(x), snapCoord(z)]);
  }
  for (let i = n - 1; i >= 0; i--) {
    const rIdx = i * 2 + 1;
    const x = pos[rIdx * 3];
    const z = pos[rIdx * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    ring.push([snapCoord(x), snapCoord(z)]);
  }
  if (ring.length < 3) return null;
  ring.push([ring[0][0], ring[0][1]]);
  return [ring];
}

/**
 * Checks whether a closed 2D polygon ring `[x, z][]` contains any proper non-adjacent edge self-intersections
 * or zero-width fold-back reversals that would corrupt sweep-line Boolean clipping or create overlapping triangles.
 */
export function hasRingSelfIntersection(ring: [number, number][]): boolean {
  if (!ring || ring.length < 4) return true;
  const n =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.length - 1
      : ring.length;
  if (n < 3) return true;

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(ring[i][0]) || !Number.isFinite(ring[i][1])) return true;
    const prev = ring[(i - 1 + n) % n];
    const curr = ring[i];
    const next = ring[(i + 1) % n];
    const v1x = curr[0] - prev[0];
    const v1z = curr[1] - prev[1];
    const v2x = next[0] - curr[0];
    const v2z = next[1] - curr[1];
    const l1 = Math.hypot(v1x, v1z);
    const l2 = Math.hypot(v2x, v2z);
    if (l1 > 1e-4 && l2 > 1e-4) {
      const cosAngle = (v1x * v2x + v1z * v2z) / (l1 * l2);
      if (cosAngle < -0.992) return true;
    }
  }

  const ccw = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) =>
    (cz - az) * (bx - ax) - (bz - az) * (cx - ax);

  for (let i = 0; i < n; i++) {
    const a1 = ring[i];
    const a2 = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent at closure
      const b1 = ring[j];
      const b2 = ring[(j + 1) % n];

      const d1 = ccw(a1[0], a1[1], a2[0], a2[1], b1[0], b1[1]);
      const d2 = ccw(a1[0], a1[1], a2[0], a2[1], b2[0], b2[1]);
      const d3 = ccw(b1[0], b1[1], b2[0], b2[1], a1[0], a1[1]);
      const d4 = ccw(b1[0], b1[1], b2[0], b2[1], a2[0], a2[1]);

      if (((d1 > 1e-7 && d2 < -1e-7) || (d1 < -1e-7 && d2 > 1e-7)) &&
          ((d3 > 1e-7 && d4 < -1e-7) || (d3 < -1e-7 && d4 > 1e-7))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Cleans a 2D polyline before retrying Boolean clipping by filtering non-finite points,
 * deduplicating near-coincident consecutive vertices, and removing near-180-degree fold-back spikes.
 */
export function cleanPolylineForClipping(points: [number, number][]): [number, number][] {
  if (!points || points.length < 2) return [];
  const valid = points.filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
  if (valid.length < 2) return [];

  const deduped: [number, number][] = [valid[0]];
  for (let i = 1; i < valid.length; i++) {
    const pt = valid[i];
    const prev = deduped[deduped.length - 1];
    if (Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) >= 0.05) {
      deduped.push(pt);
    } else if (i === valid.length - 1 && deduped.length >= 2) {
      deduped[deduped.length - 1] = pt;
    }
  }
  if (deduped.length <= 2) return deduped;

  let current = deduped;
  for (let pass = 0; pass < 2; pass++) {
    if (current.length <= 2) break;
    const nextPass: [number, number][] = [current[0]];
    for (let i = 1; i < current.length - 1; i++) {
      const pPrev = nextPass[nextPass.length - 1];
      const pCurr = current[i];
      const pNext = current[i + 1];
      const v1x = pCurr[0] - pPrev[0];
      const v1z = pCurr[1] - pPrev[1];
      const v2x = pNext[0] - pCurr[0];
      const v2z = pNext[1] - pCurr[1];
      const l1 = Math.hypot(v1x, v1z);
      const l2 = Math.hypot(v2x, v2z);
      if (l1 > 1e-4 && l2 > 1e-4) {
        const cosAngle = (v1x * v2x + v1z * v2z) / (l1 * l2);
        if (cosAngle < -0.985) {
          continue; // Drop fold-back spike vertex
        }
      }
      nextPass.push(pCurr);
    }
    const lastPt = current[current.length - 1];
    if (
      nextPass.length === 1 ||
      Math.hypot(
        lastPt[0] - nextPass[nextPass.length - 1][0],
        lastPt[1] - nextPass[nextPass.length - 1][1]
      ) >= 0.05
    ) {
      nextPass.push(lastPt);
    }
    current = nextPass;
  }
  return current;
}

/**
 * Documented safe fallback when sweep-line Boolean clipping fails on a degenerate/self-intersecting path:
 * Clips each individual segment of the path to the exterior of the expanded bounding boxes of all
 * overlapping road footprints, returning only clean, non-self-intersecting exterior sub-polylines
 * that never overlap the conflicting road surface.
 */
function buildSafeExteriorSubPolylines(
  points: [number, number][],
  width: number,
  overlappingBoxes: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>
): [number, number][][] {
  const cleaned = cleanPolylineForClipping(points);
  if (cleaned.length < 2) return [];
  const margin = width * 0.5 + 0.15;
  const safeSegments: [number, number][][] = [];

  for (let i = 0; i < cleaned.length - 1; i++) {
    const p0 = cleaned[i];
    const p1 = cleaned[i + 1];
    const dx = p1[0] - p0[0];
    const dz = p1[1] - p0[1];
    const segLen = Math.hypot(dx, dz);
    if (segLen < 0.25) continue;

    // Subtract parameter intervals [t0, t1] where the segment intersects each expanded box
    let intervals: Array<[number, number]> = [[0, 1]];
    for (const box of overlappingBoxes) {
      const bMinX = box.minX - margin;
      const bMaxX = box.maxX + margin;
      const bMinZ = box.minZ - margin;
      const bMaxZ = box.maxZ + margin;

      let tEnter = 0;
      let tExit = 1;
      const p = [-dx, dx, -dz, dz];
      const q = [p0[0] - bMinX, bMaxX - p0[0], p0[1] - bMinZ, bMaxZ - p0[1]];
      let hitsBox = true;
      for (let k = 0; k < 4; k++) {
        if (Math.abs(p[k]) < 1e-12) {
          if (q[k] < 0) {
            hitsBox = false;
            break;
          }
        } else {
          const t = q[k] / p[k];
          if (p[k] < 0) {
            if (t > tEnter) tEnter = t;
          } else {
            if (t < tExit) tExit = t;
          }
          if (tEnter > tExit) {
            hitsBox = false;
            break;
          }
        }
      }

      if (hitsBox && tExit > tEnter) {
        const nextIntervals: Array<[number, number]> = [];
        for (const [a, b] of intervals) {
          if (tExit <= a || tEnter >= b) {
            nextIntervals.push([a, b]);
          } else {
            if (tEnter > a + 1e-3) nextIntervals.push([a, tEnter]);
            if (tExit < b - 1e-3) nextIntervals.push([tExit, b]);
          }
        }
        intervals = nextIntervals;
        if (intervals.length === 0) break;
      }
    }

    for (const [ta, tb] of intervals) {
      if ((tb - ta) * segLen >= 0.4) {
        safeSegments.push([
          [p0[0] + dx * ta, p0[1] + dz * ta],
          [p0[0] + dx * tb, p0[1] + dz * tb],
        ]);
      }
    }
  }

  return safeSegments;
}

/**
 * Splits road polylines wherever an interior vertex is shared with another road in the same tier
 * so that all T-junctions and mid-polyline cross-streets are exposed as true endpoints for junction meshing.
 */
export function splitRoadsAtSharedInteriorNodes(
  roads: RoadFeature[],
  topoIndex: TopologicalNodeIndex
): RoadFeature[] {
  const nodeUsageCount = new Map<string, number>();

  // Pass 1: Register all vertices in topoIndex so explicit OSM node IDs and coordinate-only vertices
  // unify symmetrically regardless of feature order, while distinct explicit OSM node IDs stay separate.
  const rawRoadNodeIds = new Map<string, string[]>();
  for (const r of roads) {
    if (!r.points || r.points.length < 2) continue;
    const isPath = isNonVehicularRoadClass(r.roadClass);
    const tierScope = isPath ? 'path' : 'veh';
    const rawIds = r.points.map((pt, idx) => {
      const existingId =
        r.nodeIds && r.nodeIds[idx] !== undefined ? String(r.nodeIds[idx]).trim() : '';
      const isExplicit = existingId.length > 0 && !existingId.startsWith('tn_');
      return topoIndex.getOrCreateNode(
        pt[0],
        pt[1],
        tierScope,
        isExplicit ? existingId : undefined
      );
    });
    rawRoadNodeIds.set(r.id, rawIds);
  }

  // Pass 2: Resolve canonical node keys after any fallback-to-explicit promotions
  const roadVertexKeys = new Map<string, string[]>();
  for (const r of roads) {
    if (!r.points || r.points.length < 2) continue;
    const isPath = isNonVehicularRoadClass(r.roadClass);
    const tierPrefix = isPath ? 'path_' : 'veh_';
    const rawIds = rawRoadNodeIds.get(r.id)!;
    const canonicalNodeIds = rawIds.map((id) => topoIndex.resolveCanonicalNodeId(id));
    r.nodeIds = canonicalNodeIds;
    const keys = canonicalNodeIds.map((cid) => `${tierPrefix}${cid}`);
    roadVertexKeys.set(r.id, keys);
    // Count distinct road visits per node
    const uniqueInRoad = new Set(keys);
    for (const k of uniqueInRoad) {
      nodeUsageCount.set(k, (nodeUsageCount.get(k) || 0) + 1);
    }
  }

  const result: RoadFeature[] = [];
  for (const r of roads) {
    if (!r.points || r.points.length <= 2) {
      result.push(r);
      continue;
    }
    const keys = roadVertexKeys.get(r.id)!;
    let startIdx = 0;
    let subPart = 0;

    for (let i = 1; i < r.points.length - 1; i++) {
      if ((nodeUsageCount.get(keys[i]) || 0) > 1) {
        result.push({
          ...r,
          id: `${r.id}_seg${subPart++}`,
          points: r.points.slice(startIdx, i + 1),
          nodeIds: r.nodeIds ? r.nodeIds.slice(startIdx, i + 1) : undefined,
        });
        startIdx = i;
      }
    }

    if (startIdx === 0) {
      result.push(r);
    } else {
      result.push({
        ...r,
        id: `${r.id}_seg${subPart}`,
        points: r.points.slice(startIdx),
        nodeIds: r.nodeIds ? r.nodeIds.slice(startIdx) : undefined,
      });
    }
  }

  return result;
}

/**
 * Generates a 3D bridge deck substructure with outward-facing side fascia walls and a downward-facing underside.
 */
function generateBridgeDeckSubstructure(
  points: [number, number][],
  width: number,
  topY: number,
  deckThickness: number
): THREE.BufferGeometry | null {
  const bottomY = topY - deckThickness;
  const topRibbon = generateRoadRibbon(points, width, bottomY, { roundCaps: false });
  if (!topRibbon) return null;

  // Flip underside ribbon normals to [0, -1, 0] and reverse triangle winding
  const positions: number[] = Array.from(topRibbon.positions);
  const normals: number[] = [];
  for (let i = 0; i < topRibbon.normals.length; i += 3) {
    normals.push(0, -1, 0);
  }
  const indices: number[] = [];
  for (let i = 0; i < topRibbon.indices.length; i += 3) {
    indices.push(topRibbon.indices[i], topRibbon.indices[i + 2], topRibbon.indices[i + 1]);
  }

  let vOffset = positions.length / 3;
  const halfW = width / 2;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const dx = p1[0] - p0[0];
    const dz = p1[1] - p0[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;
    const nx = -dz / len;
    const nz = dx / len;

    // Left fascia wall (facing +nx, +nz)
    const l0x = p0[0] + nx * halfW;
    const l0z = p0[1] + nz * halfW;
    const l1x = p1[0] + nx * halfW;
    const l1z = p1[1] + nz * halfW;

    positions.push(
      l0x, bottomY, l0z,
      l1x, bottomY, l1z,
      l1x, topY, l1z,
      l0x, topY, l0z
    );
    for (let k = 0; k < 4; k++) normals.push(nx, 0, nz);
    indices.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
    vOffset += 4;

    // Right fascia wall (facing -nx, -nz)
    const r0x = p0[0] - nx * halfW;
    const r0z = p0[1] - nz * halfW;
    const r1x = p1[0] - nx * halfW;
    const r1z = p1[1] - nz * halfW;

    positions.push(
      r1x, bottomY, r1z,
      r0x, bottomY, r0z,
      r0x, topY, r0z,
      r1x, topY, r1z
    );
    for (let k = 0; k < 4; k++) normals.push(-nx, 0, -nz);
    indices.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
    vOffset += 4;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

/**
 * Computes polygon area (m²), centroid [cx, cz], and principal orientation unit vector [ux, uz]
 * aligned with the longest edge of the outer ring.
 */
function computePolygonAreaAndPrincipalAxis(ring: [number, number][]): {
  area: number;
  centroid: [number, number];
  ux: number;
  uz: number;
} {
  if (!ring || ring.length < 3) {
    return { area: 0, centroid: [0, 0], ux: 1, uz: 0 };
  }
  let signedArea2 = 0;
  let cx = 0;
  let cz = 0;
  let bestEdgeLenSq = -1;
  let ux = 1;
  let uz = 0;

  for (let i = 0; i < ring.length; i++) {
    const p0 = ring[i];
    const p1 = ring[(i + 1) % ring.length];
    const cross = p0[0] * p1[1] - p1[0] * p0[1];
    signedArea2 += cross;
    cx += p0[0];
    cz += p0[1];

    const dx = p1[0] - p0[0];
    const dz = p1[1] - p0[1];
    const lenSq = dx * dx + dz * dz;
    if (lenSq > bestEdgeLenSq && lenSq > 1e-4) {
      bestEdgeLenSq = lenSq;
      const len = Math.sqrt(lenSq);
      ux = dx / len;
      uz = dz / len;
    }
  }

  return {
    area: Math.abs(signedArea2) * 0.5,
    centroid: [cx / ring.length, cz / ring.length],
    ux,
    uz,
  };
}

/**
 * Appends a flat horizontal quad segment from (x0, z0) to (x1, z1) of width `lineWidth` at elevation `yElev`.
 */
function appendFlatLineQuad(
  positions: number[],
  normals: number[],
  indices: number[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  lineWidth: number,
  yElev: number
): void {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 1e-3) return;
  const nx = (-dz / len) * (lineWidth * 0.5);
  const nz = (dx / len) * (lineWidth * 0.5);

  const vBase = positions.length / 3;
  positions.push(
    x0 + nx, yElev, z0 + nz,
    x0 - nx, yElev, z0 - nz,
    x1 - nx, yElev, z1 - nz,
    x1 + nx, yElev, z1 + nz
  );
  for (let k = 0; k < 4; k++) normals.push(0, 1, 0);
  indices.push(vBase, vBase + 1, vBase + 2, vBase, vBase + 2, vBase + 3);
}

/**
 * Builds a closed 2D quad polygon ring for a stroke segment from (x0, z0) to (x1, z1) of width `lineWidth`.
 */
function snapCoord(v: number): number {
  return Math.round(v / COORDINATE_SNAP_QUANTUM) * COORDINATE_SNAP_QUANTUM;
}

/**
 * Builds a closed 2D quad polygon ring for a stroke segment from (x0, z0) to (x1, z1) of width `lineWidth`.
 * Coordinates are snapped to the 0.1mm planar quantum to prevent sweep-line roundoff failures.
 */
function buildLineStrokeRing(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  lineWidth: number
): [number, number][][] | null {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 1e-3) return null;
  const nx = (-dz / len) * (lineWidth * 0.5);
  const nz = (dx / len) * (lineWidth * 0.5);

  const p0: [number, number] = [snapCoord(x0 + nx), snapCoord(z0 + nz)];
  const p1: [number, number] = [snapCoord(x0 - nx), snapCoord(z0 - nz)];
  const p2: [number, number] = [snapCoord(x1 - nx), snapCoord(z1 - nz)];
  const p3: [number, number] = [snapCoord(x1 + nx), snapCoord(z1 + nz)];

  return [[p0, p1, p2, p3, [p0[0], p0[1]]]];
}

/**
 * Unions an array of 2D stroke polygons, optionally subtracts higher-priority cutout MultiPolygons,
 * and triangulates the resulting non-overlapping 2D MultiPolygon at `yElev`.
 * Includes per-component fallback if batch sweep-line union encounters a degenerate collinear edge.
 */
function triangulateUnionedStrokePolygons(
  strokePolygons: Array<[number, number][][]>,
  yElev: number,
  clipOutMultiPolygon?: MultiPolygonCoords
): THREE.BufferGeometry | null {
  if (strokePolygons.length === 0) return null;

  let unioned: MultiPolygonCoords;
  try {
    unioned = polygonClipping.union(
      strokePolygons[0] as unknown as polygonClipping.Geom,
      ...(strokePolygons.slice(1) as unknown as polygonClipping.Geom[])
    ) as unknown as MultiPolygonCoords;
  } catch {
    // Fallback: union incrementally and keep any disjoint stroke that triggers a sweep-line edge case
    let acc: MultiPolygonCoords = [strokePolygons[0]];
    const fallbackDisjoint: MultiPolygonCoords = [];
    for (let i = 1; i < strokePolygons.length; i++) {
      try {
        acc = polygonClipping.union(
          acc as unknown as polygonClipping.Geom,
          strokePolygons[i] as unknown as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords;
      } catch {
        fallbackDisjoint.push(strokePolygons[i]);
      }
    }
    unioned = [...acc, ...fallbackDisjoint];
  }

  if (clipOutMultiPolygon && clipOutMultiPolygon.length > 0) {
    try {
      unioned = polygonClipping.difference(
        unioned as unknown as polygonClipping.Geom,
        clipOutMultiPolygon as unknown as polygonClipping.Geom
      ) as unknown as MultiPolygonCoords;
    } catch {
      const clippedParts: MultiPolygonCoords = [];
      for (const comp of unioned) {
        try {
          const diff = polygonClipping.difference(
            [comp] as unknown as polygonClipping.Geom,
            clipOutMultiPolygon as unknown as polygonClipping.Geom
          ) as unknown as MultiPolygonCoords;
          clippedParts.push(...diff);
        } catch {
          clippedParts.push(comp);
        }
      }
      unioned = clippedParts;
    }
  }

  const cleaned = filterDegenerateBooleanArtifacts(unioned);
  const shapes = createShapesFromMultiPolygon(cleaned);
  if (shapes.length === 0) return null;

  const geom = new THREE.ShapeGeometry(shapes);
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, yElev, 0);
  if (geom.hasAttribute('uv')) {
    geom.deleteAttribute('uv');
  }
  return geom;
}

/**
 * Generates crisp painted parking stall lines for either an individual `amenity=parking_space` polygon
 * or a surface `amenity=parking` lot polygon (including resolved MultiPolygons with interior holes).
 * Eliminates T-junction collinear sweep-line failures by separating perpendicular stall dividers
 * from the spine edge by 2mm and merging contiguous spine runs into single stroke quads.
 */
export function generateParkingStallMarkings(
  polygon: [number, number][][],
  isIndividualSpace: boolean,
  yElev: number,
  existingSpaceBoxes: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>,
  higherOverlappingMultiPolygon?: MultiPolygonCoords,
  resolvedMultiPolygon?: MultiPolygonCoords
): THREE.BufferGeometry | null {
  const targetPolygons: MultiPolygonCoords =
    resolvedMultiPolygon && resolvedMultiPolygon.length > 0
      ? resolvedMultiPolygon
      : polygon && polygon.length > 0
        ? [polygon]
        : [];

  if (targetPolygons.length === 0) return null;

  const strokePolygons: Array<[number, number][][]> = [];

  for (const polyRings of targetPolygons) {
    const outer = polyRings[0];
    if (!outer || outer.length < 3) continue;

    if (isIndividualSpace) {
      // Trace the perimeter of the individual parking space stall with a crisp 0.11m painted line
      for (let i = 0; i < outer.length; i++) {
        const p0 = outer[i];
        const p1 = outer[(i + 1) % outer.length];
        if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 0.2) continue;
        const stroke = buildLineStrokeRing(p0[0], p0[1], p1[0], p1[1], 0.11);
        if (stroke) strokePolygons.push(stroke);
      }
      continue;
    }

    const { area, centroid, ux, uz } = computePolygonAreaAndPrincipalAxis(outer);
    if (area < 10 || area > 85000) continue;

    const vx = -uz;
    const vz = ux;
    const [cx, cz] = centroid;

    let minU = Infinity,
      maxU = -Infinity;
    let minV = Infinity,
      maxV = -Infinity;
    for (const pt of outer) {
      const du = (pt[0] - cx) * ux + (pt[1] - cz) * uz;
      const dv = (pt[0] - cx) * vx + (pt[1] - cz) * vz;
      if (du < minU) minU = du;
      if (du > maxU) maxU = du;
      if (dv < minV) minV = dv;
      if (dv > maxV) maxV = dv;
    }

    const spanU = maxU - minU;
    const spanV = maxV - minV;
    if (spanU < 4.2 || spanV < 1.8) continue;

    const stallWidth = 2.6;
    const stallDepth = 4.6;
    const aisleWidth = 6.0;
    const lineWidth = 0.13;
    const halfLine = lineWidth * 0.5;
    // 2mm clearance between perpendicular stall dividers and central spine edge
    // prevents collinear T-junction sweep-line singularities in polygon-clipping
    const spineClearance = halfLine + 0.002;

    const isInsideMappedSpace = (wx: number, wz: number): boolean => {
      for (const box of existingSpaceBoxes) {
        if (
          wx >= box.minX - 0.5 &&
          wx <= box.maxX + 0.5 &&
          wz >= box.minZ - 0.5 &&
          wz <= box.maxZ + 0.5
        ) {
          return true;
        }
      }
      return false;
    };

    const marginU = Math.min(1.4, Math.max(0.4, (spanU - stallWidth) * 0.15));

    const emitStallRow = (vSpine: number, vEnd: number, drawSpine: boolean) => {
      const dirSign = vEnd >= vSpine ? 1 : -1;
      const vDividerStart = vSpine + dirSign * spineClearance;
      if (Math.abs(vEnd - vDividerStart) < 1.1) return;
      const vMid = (vDividerStart + vEnd) * 0.5;
      let runStartSpinePt: [number, number] | null = null;
      let runLastSpinePt: [number, number] | null = null;

      const flushSpineRun = () => {
        if (drawSpine && runStartSpinePt && runLastSpinePt) {
          const spineStroke = buildLineStrokeRing(
            runStartSpinePt[0],
            runStartSpinePt[1],
            runLastSpinePt[0],
            runLastSpinePt[1],
            lineWidth
          );
          if (spineStroke) strokePolygons.push(spineStroke);
        }
        runStartSpinePt = null;
        runLastSpinePt = null;
      };

      for (let u = minU + marginU; u <= maxU - marginU + 1e-4; u += stallWidth) {
        const wxSpine = cx + u * ux + vSpine * vx;
        const wzSpine = cz + u * uz + vSpine * vz;
        const wx0 = cx + u * ux + vDividerStart * vx;
        const wz0 = cz + u * uz + vDividerStart * vz;
        const wxMid = cx + u * ux + vMid * vx;
        const wzMid = cz + u * uz + vMid * vz;
        const wx1 = cx + u * ux + vEnd * vx;
        const wz1 = cz + u * uz + vEnd * vz;

        if (
          !isInsideMappedSpace(wxMid, wzMid) &&
          isPointInPolygonRings(wxSpine, wzSpine, polyRings) &&
          isPointInPolygonRings(wxMid, wzMid, polyRings) &&
          isPointInPolygonRings(wx1, wz1, polyRings)
        ) {
          const divStroke = buildLineStrokeRing(wx0, wz0, wx1, wz1, lineWidth);
          if (divStroke) strokePolygons.push(divStroke);

          if (drawSpine) {
            if (!runStartSpinePt) {
              runStartSpinePt = [wxSpine, wzSpine];
            }
            runLastSpinePt = [wxSpine, wzSpine];
          }
        } else {
          flushSpineRun();
        }
      }
      flushSpineRun();
    };

    if (spanV < 12.0) {
      // Narrow or street-side lot: single row of stalls fitted to available depth
      const marginV = Math.min(0.45, spanV * 0.12);
      const availV = spanV - 2 * marginV;
      const effDepth = Math.min(stallDepth, availV);
      if (effDepth >= 1.3) {
        const vCenter = (minV + maxV) * 0.5;
        const v0 = vCenter - effDepth * 0.5;
        const v1 = vCenter + effDepth * 0.5;
        emitStallRow(v0, v1, spanV >= 3.6);
      }
    } else {
      // Standard or multi-aisle lot: double-loaded bays separated by driving aisles
      const rowStep = stallDepth * 2 + aisleWidth;
      let lastCoveredV = minV;
      for (
        let vCenter = minV + stallDepth + 1.0;
        vCenter <= maxV - stallDepth - 1.0;
        vCenter += rowStep
      ) {
        emitStallRow(vCenter, vCenter - stallDepth, true);
        emitStallRow(vCenter, vCenter + stallDepth, false);
        lastCoveredV = vCenter + stallDepth;
      }
      // If a trailing swath (>= 1 stall depth + aisle margin) remains near maxV, emit a perimeter single row
      if (maxV - lastCoveredV >= stallDepth + 2.0) {
        const vPerimeterSpine = maxV - 0.8;
        emitStallRow(vPerimeterSpine, vPerimeterSpine - stallDepth, true);
      }
    }
  }

  return triangulateUnionedStrokePolygons(strokePolygons, yElev, higherOverlappingMultiPolygon);
}

/**
 * Generates crisp white court/field boundary lines, halfway line, center circle, or baseball diamond
 * on sports pitches (`leisure=pitch`) by constructing the 2D Boolean union of all stroke footprints,
 * subtracting any higher-priority overlapping feature footprints, and triangulating as a single non-overlapping mesh.
 */
function generatePitchMarkings(
  polygon: [number, number][][],
  yElev: number,
  sport: string = '',
  higherOverlappingPolygons: [number, number][][][] = [],
  higherOverlappingMultiPolygon?: MultiPolygonCoords
): THREE.BufferGeometry | null {
  const outer = polygon[0];
  if (!outer || outer.length < 4) return null;

  const { area, centroid, ux, uz } = computePolygonAreaAndPrincipalAxis(outer);
  if (area < 65 || area > 28000) return null;

  const vx = -uz;
  const vz = ux;
  const [cx, cz] = centroid;

  let minU = Infinity, maxU = -Infinity;
  let minV = Infinity, maxV = -Infinity;
  for (const pt of outer) {
    const du = (pt[0] - cx) * ux + (pt[1] - cz) * uz;
    const dv = (pt[0] - cx) * vx + (pt[1] - cz) * vz;
    if (du < minU) minU = du;
    if (du > maxU) maxU = du;
    if (dv < minV) minV = dv;
    if (dv > maxV) maxV = dv;
  }

  const toWorld = (u: number, v: number): [number, number] => [
    cx + u * ux + v * vx,
    cz + u * uz + v * vz,
  ];

  const isMasked = (wx: number, wz: number): boolean => {
    for (const hPoly of higherOverlappingPolygons) {
      if (isPointInPolygonRings(wx, wz, hPoly)) return true;
    }
    return false;
  };

  const strokePolygons: Array<[number, number][][]> = [];
  const lw = 0.16;

  const emitClippedLine = (p0: [number, number], p1: [number, number], width: number = lw) => {
    const midX = (p0[0] + p1[0]) * 0.5;
    const midZ = (p0[1] + p1[1]) * 0.5;
    if (isMasked(midX, midZ)) return;
    if (
      !isPointInPolygonRings(p0[0], p0[1], polygon) ||
      !isPointInPolygonRings(midX, midZ, polygon) ||
      !isPointInPolygonRings(p1[0], p1[1], polygon)
    ) {
      return;
    }
    const stroke = buildLineStrokeRing(p0[0], p0[1], p1[0], p1[1], width);
    if (stroke) strokePolygons.push(stroke);
  };

  const isBaseball = sport.includes('baseball') || sport.includes('softball');
  if (isBaseball) {
    const span = Math.min(maxU - minU, maxV - minV);
    if (span < 10) return null;
    const baseDist = Math.min(Math.max(span * 0.28, 7.5), 24.0);
    const halfDiag = baseDist * Math.SQRT1_2;
    const home = toWorld(0, -halfDiag);
    const first = toWorld(halfDiag, 0);
    const second = toWorld(0, halfDiag);
    const third = toWorld(-halfDiag, 0);

    emitClippedLine(home, first);
    emitClippedLine(first, second);
    emitClippedLine(second, third);
    emitClippedLine(third, home);

    const foulExt = Math.min(span * 0.44, 42.0);
    if (foulExt > baseDist * 1.15) {
      const foulRight = toWorld(foulExt * Math.SQRT1_2, -halfDiag + foulExt * Math.SQRT1_2);
      const foulLeft = toWorld(-foulExt * Math.SQRT1_2, -halfDiag + foulExt * Math.SQRT1_2);
      emitClippedLine(first, foulRight);
      emitClippedLine(third, foulLeft);
    }

    const moundR = Math.min(baseDist * 0.14, 2.7);
    const segs = 12;
    for (let s = 0; s < segs; s++) {
      const a0 = (s / segs) * Math.PI * 2;
      const a1 = ((s + 1) / segs) * Math.PI * 2;
      emitClippedLine(
        toWorld(Math.cos(a0) * moundR, Math.sin(a0) * moundR),
        toWorld(Math.cos(a1) * moundR, Math.sin(a1) * moundR),
        0.13
      );
    }

    return triangulateUnionedStrokePolygons(strokePolygons, yElev, higherOverlappingMultiPolygon);
  }

  const inset = 1.4;
  const u0 = minU + inset;
  const u1 = maxU - inset;
  const v0 = minV + inset;
  const v1 = maxV - inset;
  if (u1 - u0 < 8 || v1 - v0 < 5) return null;

  const c00 = toWorld(u0, v0);
  const c10 = toWorld(u1, v0);
  const c11 = toWorld(u1, v1);
  const c01 = toWorld(u0, v1);

  if (
    !isPointInPolygonRings(c00[0], c00[1], polygon) ||
    !isPointInPolygonRings(c10[0], c10[1], polygon) ||
    !isPointInPolygonRings(c11[0], c11[1], polygon) ||
    !isPointInPolygonRings(c01[0], c01[1], polygon)
  ) {
    return null;
  }

  // Outer pitch boundary rectangle
  emitClippedLine(c00, c10);
  emitClippedLine(c10, c11);
  emitClippedLine(c11, c01);
  emitClippedLine(c01, c00);

  // Halfway line across U=0 (trimmed inside outer touchlines by lw*0.5)
  const m0 = toWorld((u0 + u1) * 0.5, v0 + lw * 0.5);
  const m1 = toWorld((u0 + u1) * 0.5, v1 - lw * 0.5);
  emitClippedLine(m0, m1);

  // Center circle
  const circleRadius = Math.min((u1 - u0) * 0.12, (v1 - v0) * 0.22, 6.5);
  if (circleRadius >= 1.5) {
    const segs = 16;
    const uMid = (u0 + u1) * 0.5;
    const vMid = (v0 + v1) * 0.5;
    for (let s = 0; s < segs; s++) {
      const a0 = (s / segs) * Math.PI * 2;
      const a1 = ((s + 1) / segs) * Math.PI * 2;
      const p0 = toWorld(uMid + Math.cos(a0) * circleRadius, vMid + Math.sin(a0) * circleRadius);
      const p1 = toWorld(uMid + Math.cos(a1) * circleRadius, vMid + Math.sin(a1) * circleRadius);
      emitClippedLine(p0, p1);
    }
  }

  return triangulateUnionedStrokePolygons(strokePolygons, yElev, higherOverlappingMultiPolygon);
}

/**
 * Generates transverse raised 3D step treads along a `highway=steps` stairway polyline.
 */
function generateStepTreads(
  points: [number, number][],
  width: number,
  yElev: number
): THREE.BufferGeometry | null {
  if (!points || points.length < 2) return null;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const halfW = width * 0.44;
  const treadDepth = 0.22;
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
      const lx = cx + nx * halfW;
      const lz = cz + nz * halfW;
      const rx = cx - nx * halfW;
      const rz = cz - nz * halfW;
      appendFlatLineQuad(positions, normals, indices, lx, lz, rx, rz, treadDepth, yElev);
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
 * Generates an open-air elevated roof slab (`building=roof`, `carport`, `canopy`, `shelter`)
 * together with 3D structural support pillars extending from ground level (Y = 0) up to the roof underside.
 * Preserves Three.js material groups: group 0 = roof top/bottom, group 1 = fascia & support columns.
 */
function generateOpenAirRoofWithPillars(
  shape: THREE.Shape,
  outerRing: [number, number][],
  effectiveHeight: number,
  explicitMinHeight: number,
  bevelEnabled: boolean
): THREE.BufferGeometry {
  const slabThickness = Math.min(Math.max(effectiveHeight * 0.15, 0.45), 0.85);
  const clearanceY =
    explicitMinHeight > 0
      ? explicitMinHeight
      : Math.max(2.8, effectiveHeight - slabThickness);

  const roofSlab = new THREE.ExtrudeGeometry(shape, {
    depth: slabThickness,
    bevelEnabled,
    bevelSegments: 1,
    steps: 1,
    bevelSize: 0.08,
    bevelThickness: 0.08,
  });
  roofSlab.rotateX(-Math.PI / 2);
  roofSlab.translate(0, clearanceY, 0);

  // Deduplicate outer ring vertices and compute centroid for slight inward column inset
  const cleanPts: [number, number][] = [];
  for (const pt of outerRing) {
    if (
      cleanPts.length === 0 ||
      Math.hypot(pt[0] - cleanPts[cleanPts.length - 1][0], pt[1] - cleanPts[cleanPts.length - 1][1]) > 0.6
    ) {
      cleanPts.push(pt);
    }
  }
  if (
    cleanPts.length > 1 &&
    Math.hypot(
      cleanPts[0][0] - cleanPts[cleanPts.length - 1][0],
      cleanPts[0][1] - cleanPts[cleanPts.length - 1][1]
    ) < 0.6
  ) {
    cleanPts.pop();
  }

  if (cleanPts.length < 3 || clearanceY < 1.2) {
    return roofSlab;
  }

  let cx = 0;
  let cz = 0;
  for (const pt of cleanPts) {
    cx += pt[0];
    cz += pt[1];
  }
  cx /= cleanPts.length;
  cz /= cleanPts.length;

  const pillarPositions: [number, number][] = [];
  const maxPillars = 24;

  for (let i = 0; i < cleanPts.length; i++) {
    if (pillarPositions.length >= maxPillars) break;
    const p0 = cleanPts[i];
    const p1 = cleanPts[(i + 1) % cleanPts.length];

    // Place corner column slightly inset toward centroid
    const dxC = cx - p0[0];
    const dzC = cz - p0[1];
    const distC = Math.hypot(dxC, dzC) || 1;
    const inset = Math.min(0.32, distC * 0.2);
    const px = p0[0] + (dxC / distC) * inset;
    const pz = p0[1] + (dzC / distC) * inset;

    const tooClose = pillarPositions.some((existing) => Math.hypot(existing[0] - px, existing[1] - pz) < 1.8);
    if (!tooClose) {
      pillarPositions.push([px, pz]);
    }

    // Add intermediate support columns along long spans (> 10m)
    const spanLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (spanLen > 10.5 && pillarPositions.length < maxPillars) {
      const numIntermediate = Math.min(3, Math.floor(spanLen / 9.5));
      for (let k = 1; k <= numIntermediate; k++) {
        if (pillarPositions.length >= maxPillars) break;
        const t = k / (numIntermediate + 1);
        const mx = p0[0] + (p1[0] - p0[0]) * t;
        const mz = p0[1] + (p1[1] - p0[1]) * t;
        const mdx = cx - mx;
        const mdz = cz - mz;
        const mDist = Math.hypot(mdx, mdz) || 1;
        const mInset = Math.min(0.32, mDist * 0.2);
        pillarPositions.push([mx + (mdx / mDist) * mInset, mz + (mdz / mDist) * mInset]);
      }
    }
  }

  if (pillarPositions.length === 0) {
    return roofSlab;
  }

  const pillarRadius = Math.min(Math.max(clearanceY * 0.045, 0.15), 0.26);
  const pillarGeos: THREE.BufferGeometry[] = [];
  for (const [px, pz] of pillarPositions) {
    const cyl = new THREE.CylinderGeometry(pillarRadius, pillarRadius * 1.1, clearanceY, 8);
    cyl.translate(px, clearanceY * 0.5, pz);
    const nonIdxCyl = cyl.toNonIndexed();
    cyl.dispose();
    pillarGeos.push(nonIdxCyl);
  }

  const mergedPillars = mergeGeometries(pillarGeos, false);
  for (const g of pillarGeos) g.dispose();
  if (!mergedPillars) return roofSlab;

  const nonIdxSlab = roofSlab.index ? roofSlab.toNonIndexed() : roofSlab;
  const slabVertCount = nonIdxSlab.attributes.position.count;
  const pillarVertCount = mergedPillars.attributes.position.count;

  const combined = mergeGeometries([nonIdxSlab, mergedPillars], false);
  mergedPillars.dispose();
  if (!combined) return roofSlab;

  // Preserve roofSlab material groups (0 = roof cap, 1 = wall/fascia) and assign pillars to group 1 (wall/column material)
  combined.clearGroups();
  if (nonIdxSlab.groups && nonIdxSlab.groups.length > 0) {
    for (const grp of nonIdxSlab.groups) {
      combined.addGroup(grp.start, grp.count, grp.materialIndex ?? 0);
    }
  } else {
    combined.addGroup(0, slabVertCount, 0);
  }
  combined.addGroup(slabVertCount, pillarVertCount, 1);

  if (nonIdxSlab !== roofSlab) nonIdxSlab.dispose();
  roofSlab.dispose();
  return combined;
}

/**
 * Builds an authentic multi-part 3D geometry for street furniture and micro-amenities
 * (`bench`, `waste_basket`, `street_lamp`, `bicycle_parking`, `fountain`, `shelter`, `post_box`).
 */
function buildStreetFurnitureGeometry(
  lm: PointLandmarkFeature
): { geom: THREE.BufferGeometry; styleGroup: 'wood' | 'metal' | 'lamp' | 'stone' } {
  const [x, z] = lm.position;
  const yBase = ELEVATION_POLICY.PARKS;
  const rotY = ((hashFeatureId(lm.id) % 360) * Math.PI) / 180;

  const transformPart = (g: THREE.BufferGeometry, lx: number, ly: number, lz: number): THREE.BufferGeometry => {
    g.translate(lx, ly, lz);
    g.rotateY(rotY);
    g.translate(x, yBase, z);
    const nonIdx = g.index ? g.toNonIndexed() : g.clone();
    g.dispose();
    if (nonIdx.hasAttribute('uv')) nonIdx.deleteAttribute('uv');
    return nonIdx;
  };

  if (lm.landmarkType === 'bench') {
    // Multi-part 3D bench: slatted seat plank + backrest + two side leg frames
    const seat = transformPart(new THREE.BoxGeometry(1.9, 0.12, 0.62), 0, 0.48, 0);
    const back = transformPart(new THREE.BoxGeometry(1.9, 0.44, 0.10), 0, 0.76, -0.26);
    const legL = transformPart(new THREE.BoxGeometry(0.14, 0.48, 0.60), -0.78, 0.24, 0);
    const legR = transformPart(new THREE.BoxGeometry(0.14, 0.48, 0.60), 0.78, 0.24, 0);
    const merged = mergeGeometries([seat, back, legL, legR], false)!;
    seat.dispose();
    back.dispose();
    legL.dispose();
    legR.dispose();
    return { geom: merged, styleGroup: 'wood' };
  }

  if (lm.landmarkType === 'waste_basket') {
    // Multi-part 3D cylindrical waste bin: plinth base + body + domed hood
    const base = transformPart(new THREE.CylinderGeometry(0.28, 0.32, 0.20, 8), 0, 0.10, 0);
    const body = transformPart(new THREE.CylinderGeometry(0.36, 0.30, 0.75, 10), 0, 0.575, 0);
    const dome = transformPart(new THREE.CylinderGeometry(0.20, 0.38, 0.25, 10), 0, 1.075, 0);
    const merged = mergeGeometries([base, body, dome], false)!;
    base.dispose();
    body.dispose();
    dome.dispose();
    return { geom: merged, styleGroup: 'metal' };
  }

  if (lm.landmarkType === 'street_lamp') {
    // Multi-part 3D street lamp post: base plinth + slender tapered pole + luminaire arm + lamp head
    const h = Math.max(lm.height, 4.8);
    const plinth = transformPart(new THREE.CylinderGeometry(0.15, 0.22, 0.9, 8), 0, 0.45, 0);
    const pole = transformPart(new THREE.CylinderGeometry(0.08, 0.14, h - 0.9, 8), 0, 0.9 + (h - 0.9) * 0.5, 0);
    const arm = transformPart(new THREE.BoxGeometry(1.15, 0.10, 0.12), 0.52, h - 0.12, 0);
    const head = transformPart(new THREE.BoxGeometry(0.52, 0.16, 0.30), 0.98, h - 0.18, 0);
    const merged = mergeGeometries([plinth, pole, arm, head], false)!;
    plinth.dispose();
    pole.dispose();
    arm.dispose();
    head.dispose();
    return { geom: merged, styleGroup: 'lamp' };
  }

  if (lm.landmarkType === 'bicycle_parking') {
    // Multi-part 3D Sheffield bicycle rack: base rails + 3 parallel U-stands
    const rail = transformPart(new THREE.BoxGeometry(2.3, 0.08, 1.3), 0, 0.04, 0);
    const hoop1 = transformPart(new THREE.BoxGeometry(0.10, 0.88, 1.15), -0.8, 0.48, 0);
    const hoop2 = transformPart(new THREE.BoxGeometry(0.10, 0.88, 1.15), 0, 0.48, 0);
    const hoop3 = transformPart(new THREE.BoxGeometry(0.10, 0.88, 1.15), 0.8, 0.48, 0);
    const merged = mergeGeometries([rail, hoop1, hoop2, hoop3], false)!;
    rail.dispose();
    hoop1.dispose();
    hoop2.dispose();
    hoop3.dispose();
    return { geom: merged, styleGroup: 'metal' };
  }

  if (lm.landmarkType === 'fountain') {
    // Multi-part 3D tiered fountain: outer stone basin + upper bowl + central water column
    const basin = transformPart(new THREE.CylinderGeometry(1.45, 1.35, 0.48, 12), 0, 0.24, 0);
    const bowl = transformPart(new THREE.CylinderGeometry(0.80, 0.60, 0.36, 10), 0, 0.90, 0);
    const spout = transformPart(new THREE.CylinderGeometry(0.20, 0.32, 1.65, 8), 0, 0.95, 0);
    const merged = mergeGeometries([basin, bowl, spout], false)!;
    basin.dispose();
    bowl.dispose();
    spout.dispose();
    return { geom: merged, styleGroup: 'stone' };
  }

  if (lm.landmarkType === 'shelter') {
    // Multi-part 3D transit/weather shelter: rear panel + two pillars + cantilevered roof canopy + bench
    const postL = transformPart(new THREE.BoxGeometry(0.15, 2.35, 0.15), -1.3, 1.175, -0.55);
    const postR = transformPart(new THREE.BoxGeometry(0.15, 2.35, 0.15), 1.3, 1.175, -0.55);
    const backWall = transformPart(new THREE.BoxGeometry(2.5, 1.85, 0.08), 0, 1.15, -0.55);
    const roof = transformPart(new THREE.BoxGeometry(3.0, 0.18, 1.6), 0, 2.40, 0);
    const bench = transformPart(new THREE.BoxGeometry(1.9, 0.12, 0.45), 0, 0.48, -0.28);
    const merged = mergeGeometries([postL, postR, backWall, roof, bench], false)!;
    postL.dispose();
    postR.dispose();
    backWall.dispose();
    roof.dispose();
    bench.dispose();
    return { geom: merged, styleGroup: 'metal' };
  }

  // Default: post_box / vending_machine / parcel_locker / telephone kiosk
  const body = transformPart(new THREE.BoxGeometry(0.76, 1.35, 0.66), 0, 0.675, 0);
  const cap = transformPart(new THREE.CylinderGeometry(0.42, 0.46, 0.20, 8), 0, 1.45, 0);
  const merged = mergeGeometries([body, cap], false)!;
  body.dispose();
  cap.dispose();
  return { geom: merged, styleGroup: 'lamp' };
}

export class GeometryBuilder {
  private options: {
    buildingHeightMultiplier: number;
    roadWidthMultiplier: number;
    bevelEnabled: boolean;
    initialCameraZoom: number;
    infrastructureRenderOptions: InfrastructureRenderOptions;
    infrastructureRenderPreview: InfrastructureRenderPreviewResult | null | undefined;
  };

  constructor(options: GeometryBuilderOptions = {}) {
    this.options = {
      buildingHeightMultiplier: options.buildingHeightMultiplier ?? 1.0,
      roadWidthMultiplier: options.roadWidthMultiplier ?? 1.0,
      bevelEnabled: options.bevelEnabled ?? false,
      initialCameraZoom: options.initialCameraZoom ?? 1.0,
      infrastructureRenderOptions: normalizeInfrastructureRenderOptions(
        options.infrastructureRenderOptions
      ),
      infrastructureRenderPreview: options.infrastructureRenderPreview,
    };
  }

  buildScene(data: ProcessedMapData, theme: MapStyleTheme): BuiltSceneGeometry {
    const resourceManager = new SceneResourceManager();
    const infrastructureRenderOptions = this.options.infrastructureRenderOptions;
    let infrastructureRenderPreview: InfrastructureRenderPreviewResult | null =
      this.options.infrastructureRenderPreview !== undefined
        ? this.options.infrastructureRenderPreview
        : requiresInfrastructureGraphPreview(infrastructureRenderOptions)
          ? prepareInfrastructureRenderPreview(data, infrastructureRenderOptions)
          : null;

    const buildingsGroup = new THREE.Group();
    buildingsGroup.name = 'BuildingsGroup';

    const roadsGroup = new THREE.Group();
    roadsGroup.name = 'RoadsGroup';

    const railwaysGroup = new THREE.Group();
    railwaysGroup.name = 'RailwaysGroup';

    const waterGroup = new THREE.Group();
    waterGroup.name = 'WaterGroup';

    const parksGroup = new THREE.Group();
    parksGroup.name = 'ParksGroup';

    const landuseGroup = new THREE.Group();
    landuseGroup.name = 'LanduseGroup';

    const barriersGroup = new THREE.Group();
    barriersGroup.name = 'BarriersGroup';

    const foliageGroup = new THREE.Group();
    foliageGroup.name = 'FoliageAndLandmarksGroup';

    let totalVertices = 0;
    let totalTriangles = 0;
    let drawCalls = 0;
    const renderedSourceIds = new Set<string>();

    const roadMaterialsByClass = new Map<RoadClass, THREE.MeshStandardMaterial>();
    const landuseMaterialsBySubtype = new Map<string, THREE.MeshStandardMaterial>();
    const parkMaterialsBySubtype = new Map<string, THREE.MeshStandardMaterial>();
    const barrierMaterialsByType = new Map<string, THREE.MeshStandardMaterial>();

    // ==========================================================================
    // 1. GROUND PLANE
    // ==========================================================================
    const b = data.bounds;
    const groundWidth = Math.max(b.widthMeters * 1.5, 800);
    const groundDepth = Math.max(b.depthMeters * 1.5, 800);
    const groundGeo = resourceManager.registerGeometry(
      new THREE.PlaneGeometry(groundWidth, groundDepth, 1, 1)
    );
    groundGeo.rotateX(-Math.PI / 2);

    const groundMat = resourceManager.registerMaterial(
      new THREE.MeshStandardMaterial({
        color: theme.groundColor,
        roughness: 0.95,
        metalness: 0.05,
      })
    );
    const groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.name = 'GroundPlane';
    groundMesh.position.set((b.minX + b.maxX) / 2, ELEVATION_POLICY.GROUND, (b.minZ + b.maxZ) / 2);
    groundMesh.receiveShadow = true;
    drawCalls++;

    totalVertices += groundGeo.attributes.position.count;
    totalTriangles += (groundGeo.index?.count || 0) / 3;

    // ==========================================================================
    // 2. SEMANTIC SURFACE RESOLUTION & LANDUSE / PARKING AREAS
    // ==========================================================================
    const { resolvedById: resolvedPlanarById, report: planarValidationReport } =
      resolveAndValidatePlanarPolygons(
        data.landuse || [],
        data.parks || [],
        data.waterBodies || [],
        data.linearWaterways || []
      );

    if (data.diagnostics) {
      data.diagnostics.planarValidation = {
        isValid: planarValidationReport.isValid,
        totalPolygons: planarValidationReport.totalPolygons,
        overlappingPairsChecked: planarValidationReport.overlappingPairsChecked,
        conflictsResolved: planarValidationReport.conflictsResolved,
        minObservedSeparationMeters: planarValidationReport.minObservedSeparationMeters,
        maxStackDepth: planarValidationReport.maxStackDepth,
      };
    }

    const planarPolygonRingsById = new Map<string, [number, number][][]>();
    for (const lu of data.landuse) {
      if (lu.polygon) planarPolygonRingsById.set(lu.id, lu.polygon);
    }
    for (const pk of data.parks) {
      if (pk.polygon) planarPolygonRingsById.set(pk.id, pk.polygon);
    }

    const landuseBySubtype = new Map<
      string,
      Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo; sortY: number }>
    >();
    const parkingMarkingItems: Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }> = [];

    // Pre-collect bounding boxes of explicitly mapped individual parking spaces (`amenity=parking_space`)
    // so procedural lot stall lines do not double-draw over mapped individual spaces.
    const existingParkingSpaceBoxes: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> = [];
    for (const item of data.landuse) {
      if (item.landuseType === 'parking_space' && item.polygon && item.polygon[0]?.length >= 3) {
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const pt of item.polygon[0]) {
          if (pt[0] < minX) minX = pt[0];
          if (pt[0] > maxX) maxX = pt[0];
          if (pt[1] < minZ) minZ = pt[1];
          if (pt[1] > maxZ) maxZ = pt[1];
        }
        existingParkingSpaceBoxes.push({ minX, maxX, minZ, maxZ });
      }
    }

    for (const item of data.landuse) {
      try {
        const resolved = resolvedPlanarById.get(item.id);
        if (resolved?.isDeduplicatedInto) {
          if (item.sourceFeatureId) renderedSourceIds.add(item.sourceFeatureId);
          continue;
        }

        const shapes =
          resolved && resolved.resolvedMultiPolygon.length > 0
            ? createShapesFromMultiPolygon(resolved.resolvedMultiPolygon)
            : resolved && resolved.resolvedMultiPolygon.length === 0
              ? []
              : (() => {
                  const s = createShapeFromRings(item.polygon);
                  return s ? [s] : [];
                })();
        if (shapes.length === 0) {
          if (data.diagnostics?.featuresFullySubtracted) {
            data.diagnostics.featuresFullySubtracted.count++;
            if (data.diagnostics.featuresFullySubtracted.sampleIds.length < 10) {
              data.diagnostics.featuresFullySubtracted.sampleIds.push(
                item.sourceFeatureId || item.id
              );
            }
          }
          continue;
        }

        const subtype = item.landuseType || 'landuse';
        const tierInfo = getLanduseElevationAndOffset(subtype);
        const exactElevation = resolved ? resolved.elevationY : tierInfo.elevation;

        const geom = resourceManager.registerGeometry(new THREE.ShapeGeometry(shapes));
        geom.rotateX(-Math.PI / 2);
        geom.translate(0, exactElevation, 0);
        if (geom.hasAttribute('uv')) {
          geom.deleteAttribute('uv');
        }

        const mergedSourceIds =
          resolved && resolved.sourceFeatureIds.length > 0
            ? resolved.sourceFeatureIds
            : [item.sourceFeatureId || item.id];

        const featureInfo: InspectableFeatureInfo = {
          id: item.id,
          sourceFeatureId: mergedSourceIds[0],
          name: item.name || item.cartoLabel || `Landuse (${subtype})`,
          category: 'Landuse & Zoning',
          cartoLabel: item.cartoLabel || `${subtype} Area`,
          primaryTag: item.primaryTag || `landuse=${subtype}`,
          subtype,
          elevation: Number(exactElevation.toFixed(4)),
          osmTags: sanitizeOsmTags(item.osmTags),
        };

        if (!landuseBySubtype.has(subtype)) {
          landuseBySubtype.set(subtype, []);
        }
        landuseBySubtype.get(subtype)!.push({
          geom,
          info: featureInfo,
          sortY: exactElevation,
        });

        // Generate procedural painted stall lines for surface parking lots and individual parking spaces
        const isUndergroundParking =
          item.osmTags?.parking === 'underground' ||
          item.osmTags?.location === 'underground' ||
          item.osmTags?.parking === 'multi-storey';

        const isBicycleParking = item.osmTags?.amenity === 'bicycle_parking';

        if (
          (subtype === 'parking' || subtype === 'parking_space') &&
          !isUndergroundParking &&
          !isBicycleParking
        ) {
          // Only exclude explicitly mapped individual `amenity=parking_space` decals via bounding boxes;
          // higher-priority overlapping surface polygons are already carved out of `resolved.resolvedMultiPolygon`
          // as exact interior holes and subtracted via `resolved.higherOverlappingMultiPolygon`.
          const exclusionBoxes = subtype === 'parking' ? existingParkingSpaceBoxes : [];

          const parkingMarkY = resolved
            ? resolved.markingElevationY
            : ELEVATION_POLICY.PARKING_MARKINGS;

          const markingGeo = generateParkingStallMarkings(
            item.polygon,
            subtype === 'parking_space',
            parkingMarkY,
            exclusionBoxes,
            resolved?.higherOverlappingMultiPolygon,
            resolved?.resolvedMultiPolygon
          );
          if (markingGeo) {
            resourceManager.registerGeometry(markingGeo);
            parkingMarkingItems.push({ geom: markingGeo, info: featureInfo });
          }
        }

        for (const sid of mergedSourceIds) {
          if (sid) renderedSourceIds.add(sid);
        }
      } catch (err) {
        console.warn(`Skipping invalid landuse feature ${item.id}`, err);
      }
    }

    landuseBySubtype.forEach((items, subtype) => {
      items.sort((a, b) => a.sortY - b.sortY);
      const { merged: mergedLanduseGeo, faceRanges } = mergeWithFaceRanges(items, resourceManager);
      if (mergedLanduseGeo) {
        resourceManager.registerGeometry(mergedLanduseGeo);
        const tierInfo = getLanduseElevationAndOffset(subtype);
        const color = theme.landuseColors[subtype] || theme.landuseColors.landuse || '#0f172a';
        const landuseMat = resourceManager.registerMaterial(
          new THREE.MeshStandardMaterial({
            color,
            roughness: subtype === 'parking' || subtype === 'parking_space' ? 0.82 : 0.9,
            metalness: 0.05,
            side: THREE.DoubleSide,
            ...tierInfo.depthOffset,
          })
        );
        landuseMaterialsBySubtype.set(subtype, landuseMat);

        const landuseMesh = new THREE.Mesh(mergedLanduseGeo, landuseMat);
        landuseMesh.name = `Landuse_${subtype}`;
        landuseMesh.position.y = 0;
        landuseMesh.receiveShadow = true;
        landuseMesh.renderOrder = tierInfo.renderOrder;
        landuseMesh.userData = { faceRanges };
        landuseGroup.renderOrder = 1;
        landuseGroup.add(landuseMesh);
        drawCalls++;

        totalVertices += mergedLanduseGeo.attributes.position.count;
        totalTriangles += (mergedLanduseGeo.index?.count || 0) / 3;
      }
    });

    let parkingMarkingMat: THREE.MeshStandardMaterial | undefined;
    if (parkingMarkingItems.length > 0) {
      const { merged: mergedParkingMarks, faceRanges } = mergeWithFaceRanges(
        parkingMarkingItems,
        resourceManager
      );
      if (mergedParkingMarks) {
        resourceManager.registerGeometry(mergedParkingMarks);
        const markColor =
          theme.id === 'daylight'
            ? '#f8fafc'
            : theme.id === 'blueprint'
              ? '#48cae4'
              : '#94a3b8';
        parkingMarkingMat = resourceManager.registerMaterial(
          new THREE.MeshStandardMaterial({
            color: markColor,
            roughness: 0.5,
            metalness: 0.1,
            side: THREE.DoubleSide,
            ...DEPTH_OFFSET_CONFIG.parkingMarkings,
          })
        );
        const markMesh = new THREE.Mesh(mergedParkingMarks, parkingMarkingMat);
        markMesh.name = 'Parking_Markings';
        markMesh.position.y = 0;
        markMesh.receiveShadow = true;
        markMesh.renderOrder = 5;
        markMesh.userData = { faceRanges };
        landuseGroup.add(markMesh);
        drawCalls++;

        totalVertices += mergedParkingMarks.attributes.position.count;
        totalTriangles += (mergedParkingMarks.index?.count || 0) / 3;
      }
    }

    // ==========================================================================
    // 3. WATER BODIES & LINEAR WATERWAYS
    // ==========================================================================
    const waterItems: Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }> = [];
    const placedWaterMultiPolygons: MultiPolygonCoords = [];

    for (const item of data.waterBodies) {
      if (item.isTunnel || (item.layer !== undefined && item.layer < 0)) continue;
      try {
        const resolved = resolvedPlanarById.get(item.id);
        if (resolved?.isDeduplicatedInto) {
          if (item.sourceFeatureId) renderedSourceIds.add(item.sourceFeatureId);
          continue;
        }

        const shapes =
          resolved && resolved.resolvedMultiPolygon.length > 0
            ? createShapesFromMultiPolygon(resolved.resolvedMultiPolygon)
            : resolved && resolved.resolvedMultiPolygon.length === 0
              ? []
              : (() => {
                  const s = createShapeFromRings(item.polygon);
                  return s ? [s] : [];
                })();
        if (shapes.length === 0) {
          if (data.diagnostics?.featuresFullySubtracted) {
            data.diagnostics.featuresFullySubtracted.count++;
            if (data.diagnostics.featuresFullySubtracted.sampleIds.length < 10) {
              data.diagnostics.featuresFullySubtracted.sampleIds.push(
                item.sourceFeatureId || item.id
              );
            }
          }
          continue;
        }

        if (resolved && resolved.resolvedMultiPolygon.length > 0) {
          placedWaterMultiPolygons.push(...resolved.resolvedMultiPolygon);
        }

        const geom = resourceManager.registerGeometry(new THREE.ShapeGeometry(shapes));
        geom.rotateX(-Math.PI / 2);
        geom.translate(0, ELEVATION_POLICY.WATER_SURFACE, 0);
        if (geom.hasAttribute('uv')) {
          geom.deleteAttribute('uv');
        }
        waterItems.push({
          geom,
          info: {
            id: item.id,
            sourceFeatureId: item.sourceFeatureId || item.id,
            name: item.name || item.cartoLabel || 'Water Body',
            category: 'Water & Waterway',
            cartoLabel: item.cartoLabel || 'Body of Water',
            primaryTag: item.primaryTag || `natural=water (${item.waterType})`,
            subtype: item.waterType,
            elevation: ELEVATION_POLICY.WATER_SURFACE,
            layer: item.layer || 0,
            osmTags: sanitizeOsmTags(item.osmTags),
          },
        });
        if (item.sourceFeatureId) renderedSourceIds.add(item.sourceFeatureId);
      } catch (err) {
        console.warn(`Skipping invalid water body ${item.id}`, err);
      }
    }

    for (const item of data.linearWaterways) {
      if (item.isTunnel || (item.layer !== undefined && item.layer < 0)) continue;
      try {
        const width = item.width || 10.0;
        const ribbon = generateRoadRibbon(item.points, width, ELEVATION_POLICY.WATER_SURFACE, {
          roundCaps: true,
        });
        if (!ribbon) continue;
        const geom = resourceManager.registerGeometry(new THREE.BufferGeometry());
        geom.setAttribute('position', new THREE.BufferAttribute(ribbon.positions, 3));
        geom.setAttribute('normal', new THREE.BufferAttribute(ribbon.normals, 3));
        geom.setIndex(new THREE.BufferAttribute(ribbon.indices, 1));
        waterItems.push({
          geom,
          info: {
            id: item.id,
            sourceFeatureId: item.sourceFeatureId || item.id,
            name: item.name || item.cartoLabel || 'Waterway',
            category: 'Water & Waterway',
            cartoLabel: item.cartoLabel || `Linear Waterway (${item.waterwayType})`,
            primaryTag: item.primaryTag || `waterway=${item.waterwayType}`,
            subtype: item.waterwayType,
            width,
            elevation: ELEVATION_POLICY.WATER_SURFACE,
            layer: item.layer,
            isBridge: item.isBridge,
            isTunnel: item.isTunnel,
            osmTags: sanitizeOsmTags(item.osmTags),
          },
        });
        if (item.sourceFeatureId) renderedSourceIds.add(item.sourceFeatureId);
      } catch (err) {
        console.warn(`Skipping invalid waterway ${item.id}`, err);
      }
    }

    let waterMat: THREE.MeshStandardMaterial | undefined;
    if (waterItems.length > 0) {
      const { merged: mergedWaterGeo, faceRanges } = mergeWithFaceRanges(waterItems, resourceManager);
      if (mergedWaterGeo) {
        resourceManager.registerGeometry(mergedWaterGeo);
        mergedWaterGeo.computeBoundingBox();
        mergedWaterGeo.computeBoundingSphere();
        waterMat = resourceManager.registerMaterial(
          new THREE.MeshStandardMaterial({
            color: theme.waterColor,
            roughness: 0.15,
            metalness: 0.45,
            side: THREE.DoubleSide,
            ...DEPTH_OFFSET_CONFIG.water,
          })
        );
        const waterMesh = new THREE.Mesh(mergedWaterGeo, waterMat);
        waterMesh.name = 'WaterSurfaces';
        waterMesh.position.y = 0;
        waterMesh.receiveShadow = true;
        waterMesh.renderOrder = 2;
        waterMesh.frustumCulled = false;
        waterMesh.userData = { faceRanges };
        waterGroup.renderOrder = 2;
        waterGroup.add(waterMesh);
        drawCalls++;

        totalVertices += mergedWaterGeo.attributes.position.count;
        totalTriangles += (mergedWaterGeo.index?.count || 0) / 3;
      }
    }

    // ==========================================================================
    // 4. PARKS, FORESTS, WETLANDS, NATURE & SPORTS AREAS (By Semantic Subtype)
    // ==========================================================================
    const parksBySubtype = new Map<
      string,
      Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo; sortY: number }>
    >();
    const pitchMarkingItems: Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }> = [];

    // Collect procedural 3D tree placements from forests/woods, tree rows, and individual tree nodes
    interface TreePlacement {
      x: number;
      z: number;
      scale: number;
      rotationY: number;
      leafType: 'broadleaved' | 'needleleaved' | 'mixed' | 'leafless';
      info: InspectableFeatureInfo;
    }
    const treePlacements: TreePlacement[] = [];
    const MAX_SCENE_TREES = 2200;

    for (const item of data.parks) {
      try {
        const resolved = resolvedPlanarById.get(item.id);
        if (resolved?.isDeduplicatedInto) {
          if (item.sourceFeatureId) renderedSourceIds.add(item.sourceFeatureId);
          continue;
        }

        const shapes =
          resolved && resolved.resolvedMultiPolygon.length > 0
            ? createShapesFromMultiPolygon(resolved.resolvedMultiPolygon)
            : resolved && resolved.resolvedMultiPolygon.length === 0
              ? []
              : (() => {
                  const s = createShapeFromRings(item.polygon);
                  return s ? [s] : [];
                })();
        if (shapes.length === 0) {
          if (data.diagnostics?.featuresFullySubtracted) {
            data.diagnostics.featuresFullySubtracted.count++;
            if (data.diagnostics.featuresFullySubtracted.sampleIds.length < 10) {
              data.diagnostics.featuresFullySubtracted.sampleIds.push(
                item.sourceFeatureId || item.id
              );
            }
          }
          continue;
        }

        const subtype = item.subtype || 'park';
        const exactParkY = resolved ? resolved.elevationY : ELEVATION_POLICY.PARKS;

        const geom = resourceManager.registerGeometry(new THREE.ShapeGeometry(shapes));
        geom.rotateX(-Math.PI / 2);
        geom.translate(0, exactParkY, 0);
        if (geom.hasAttribute('uv')) {
          geom.deleteAttribute('uv');
        }

        if (!parksBySubtype.has(subtype)) {
          parksBySubtype.set(subtype, []);
        }

        const mergedSourceIds =
          resolved && resolved.sourceFeatureIds.length > 0
            ? resolved.sourceFeatureIds
            : [item.sourceFeatureId || item.id];

        const featureInfo: InspectableFeatureInfo = {
          id: item.id,
          sourceFeatureId: mergedSourceIds[0],
          name: item.name || item.cartoLabel || 'Park / Natural Area',
          category: item.has3DFoliage ? 'Forest & Woodland' : 'Terrain & Nature',
          cartoLabel: item.cartoLabel || `${subtype} Area`,
          primaryTag: item.primaryTag || `leisure=${subtype}`,
          subtype,
          elevation: Number(exactParkY.toFixed(4)),
          osmTags: sanitizeOsmTags(item.osmTags),
        };

        parksBySubtype.get(subtype)!.push({ geom, info: featureInfo, sortY: exactParkY });
        for (const sid of mergedSourceIds) {
          if (sid) renderedSourceIds.add(sid);
        }

        // Generate crisp white court/field markings on sports pitches (`leisure=pitch`)
        if (subtype === 'pitch') {
          const pitchMarkY = resolved ? resolved.markingElevationY : exactParkY + 0.004;
          const higherPolys: [number, number][][][] = [];
          if (resolved && resolved.higherOverlappingIds.length > 0) {
            for (const hid of resolved.higherOverlappingIds) {
              const hp = planarPolygonRingsById.get(hid);
              if (hp) higherPolys.push(hp);
            }
          }
          const sportTag = String(item.osmTags?.sport || '').toLowerCase();
          const pitchMarkGeo = generatePitchMarkings(
            item.polygon,
            pitchMarkY,
            sportTag,
            higherPolys,
            resolved?.higherOverlappingMultiPolygon
          );
          if (pitchMarkGeo) {
            resourceManager.registerGeometry(pitchMarkGeo);
            pitchMarkingItems.push({ geom: pitchMarkGeo, info: featureInfo });
          }
        }

        // Populate procedural 3D trees inside forest/woodland polygons
        if (item.has3DFoliage && treePlacements.length < MAX_SCENE_TREES) {
          const outer = item.polygon[0];
          let pMinX = Infinity, pMaxX = -Infinity, pMinZ = Infinity, pMaxZ = -Infinity;
          for (const pt of outer) {
            if (pt[0] < pMinX) pMinX = pt[0];
            if (pt[0] > pMaxX) pMaxX = pt[0];
            if (pt[1] < pMinZ) pMinZ = pt[1];
            if (pt[1] > pMaxZ) pMaxZ = pt[1];
          }

          const areaApprox = (pMaxX - pMinX) * (pMaxZ - pMinZ);
          const spacing = areaApprox > 60000 ? 15.0 : 11.5;

          for (let gx = pMinX + spacing * 0.5; gx < pMaxX - spacing * 0.3; gx += spacing) {
            for (let gz = pMinZ + spacing * 0.5; gz < pMaxZ - spacing * 0.3; gz += spacing) {
              if (treePlacements.length >= MAX_SCENE_TREES) break;
              const h1 = Math.sin(gx * 12.9898 + gz * 78.233) * 43758.5453;
              const h2 = Math.cos(gx * 39.346 + gz * 11.135) * 23421.631;
              const jx = (h1 - Math.floor(h1) - 0.5) * spacing * 0.65;
              const jz = (h2 - Math.floor(h2) - 0.5) * spacing * 0.65;
              const tx = gx + jx;
              const tz = gz + jz;

              if (isPointInPolygonRings(tx, tz, item.polygon)) {
                const frac = h1 - Math.floor(h1);
                const rawLt = item.leafType || 'broadleaved';
                const resolvedLt =
                  rawLt === 'mixed'
                    ? frac > 0.45
                      ? 'broadleaved'
                      : 'needleleaved'
                    : rawLt;

                treePlacements.push({
                  x: tx,
                  z: tz,
                  scale: 0.78 + frac * 0.44,
                  rotationY: frac * Math.PI * 2,
                  leafType: resolvedLt,
                  info: featureInfo,
                });
              }
            }
          }
        }
      } catch (err) {
        console.warn(`Skipping invalid park feature ${item.id}`, err);
      }
    }

    parksBySubtype.forEach((items, subtype) => {
      items.sort((a, b) => a.sortY - b.sortY);
      const { merged: mergedParkGeo, faceRanges } = mergeWithFaceRanges(items, resourceManager);
      if (mergedParkGeo) {
        resourceManager.registerGeometry(mergedParkGeo);
        const color = theme.terrainColors?.[subtype] || theme.parkColor;
        const parkMat = resourceManager.registerMaterial(
          new THREE.MeshStandardMaterial({
            color,
            roughness: 0.78,
            metalness: 0.05,
            side: THREE.DoubleSide,
            ...DEPTH_OFFSET_CONFIG.parks,
          })
        );
        parkMaterialsBySubtype.set(subtype, parkMat);

        const parkMesh = new THREE.Mesh(mergedParkGeo, parkMat);
        parkMesh.name = `ParkSurfaces_${subtype}`;
        parkMesh.position.y = 0;
        parkMesh.receiveShadow = true;
        parkMesh.renderOrder = 3;
        parkMesh.userData = { faceRanges };
        parksGroup.renderOrder = 3;
        parksGroup.add(parkMesh);
        drawCalls++;

        totalVertices += mergedParkGeo.attributes.position.count;
        totalTriangles += (mergedParkGeo.index?.count || 0) / 3;
      }
    });

    let pitchMarkingMat: THREE.MeshStandardMaterial | undefined;
    if (pitchMarkingItems.length > 0) {
      const { merged: mergedPitchMarks, faceRanges } = mergeWithFaceRanges(
        pitchMarkingItems,
        resourceManager
      );
      if (mergedPitchMarks) {
        resourceManager.registerGeometry(mergedPitchMarks);
        pitchMarkingMat = resourceManager.registerMaterial(
          new THREE.MeshStandardMaterial({
            color: theme.id === 'blueprint' ? '#90e0ef' : '#e2e8f0',
            roughness: 0.55,
            metalness: 0.05,
            side: THREE.DoubleSide,
            ...DEPTH_OFFSET_CONFIG.pitchMarkings,
          })
        );
        const pitchMarkMesh = new THREE.Mesh(mergedPitchMarks, pitchMarkingMat);
        pitchMarkMesh.name = 'Pitch_Markings';
        pitchMarkMesh.position.y = 0;
        pitchMarkMesh.receiveShadow = true;
        pitchMarkMesh.renderOrder = 5;
        pitchMarkMesh.userData = { faceRanges };
        parksGroup.add(pitchMarkMesh);
        drawCalls++;

        totalVertices += mergedPitchMarks.attributes.position.count;
        totalTriangles += (mergedPitchMarks.index?.count || 0) / 3;
      }
    }

    // ==========================================================================
    // 5. RAILWAYS & AERIALWAYS (Delegated to Hybrid Candidate B RailwayGeometryBuilder)
    // ==========================================================================
    let railwayInfrastructureResult: RailwayPrototypeResult | null = null;
    if (data.railways && data.railways.length > 0) {
      railwayInfrastructureResult = buildRailwayInfrastructure(
        data,
        theme,
        this.options.initialCameraZoom ?? 1.0,
        {
          resourceManager,
          targetGroup: railwaysGroup,
        }
      );
      for (const sid of railwayInfrastructureResult.renderedSourceIds) {
        renderedSourceIds.add(sid);
      }
      drawCalls += railwayInfrastructureResult.stats.drawCalls;
      totalVertices += railwayInfrastructureResult.stats.totalVertices;
      totalTriangles += railwayInfrastructureResult.stats.totalTriangles;
    }

    const bridgeSubstructureItems: Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }> = [];
    const bridgeParapetItems: Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }> = [];
    const bridgePierItems: Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }> = [];
    const tunnelPortalItems: Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }> = [];
    const tunnelMouthItems: Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }> = [];
    const tunnelTraceItems: Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }> = [];

    // ==========================================================================
    // 6. ROADS, JUNCTION-NODE MESHING, 3D BRIDGE RAMPS & 3D TUNNEL PORTALS
    // ==========================================================================
    const topoIndex = new TopologicalNodeIndex(0.15);

    const rawAtGradeRoads: RoadFeature[] = [];
    const gradeSeparatedRoads: RoadFeature[] = [];
    const atGradeRoadEndpoints: [number, number][] = [];
    const bridgeRoadEndpoints: Array<{ id: string; pt: [number, number] }> = [];
    const gradeTransitionCoords: [number, number][] = [];

    for (const r of data.roads) {
      if (!r.points || r.points.length < 2) continue;
      const isExplicitCulvert = Boolean(
        r.osmTags?.culvert === 'yes' ||
          r.osmTags?.tunnel === 'culvert' ||
          r.osmTags?.bridge === 'culvert' ||
          r.osmTags?.man_made === 'culvert' ||
          r.osmTags?.bridge === 'low_water_crossing'
      );
      if ((r.layer === 0 && !r.isBridge && !r.isTunnel) || isExplicitCulvert) {
        rawAtGradeRoads.push(r);
        for (const pt of r.points) {
          atGradeRoadEndpoints.push(pt);
        }
      } else {
        gradeSeparatedRoads.push(r);
        const p0 = r.points[0];
        const pn = r.points[r.points.length - 1];
        gradeTransitionCoords.push(p0, pn);
        if (!r.isTunnel && (r.isBridge || r.layer > 0)) {
          bridgeRoadEndpoints.push({ id: r.id, pt: p0 }, { id: r.id, pt: pn });
        }
      }
    }

    // Split at-grade roads at any shared interior nodes so mid-polyline intersections are meshed
    const atGradeRoads = splitRoadsAtSharedInteriorNodes(rawAtGradeRoads, topoIndex);
    const nodeBranches = new Map<string, RoadBranch[]>();

    // A. Gather road branches at at-grade junction nodes
    for (const road of atGradeRoads) {
      if (!road.points || road.points.length < 2) continue;
      const isPath = isNonVehicularRoadClass(road.roadClass);
      const tierPrefix = isPath ? 'path_' : 'veh_';
      const w = road.width * this.options.roadWidthMultiplier;
      const totalPolyLen = computePolylineLength(road.points);
      const p0 = road.points[0];
      const p1 = road.points[1];
      const pn = road.points[road.points.length - 1];
      const pn_1 = road.points[road.points.length - 2];

      const rawStartId =
        road.nodeIds && road.nodeIds.length > 0
          ? topoIndex.resolveCanonicalNodeId(String(road.nodeIds[0]))
          : topoIndex.getOrCreateNode(p0[0], p0[1], isPath ? 'path' : 'veh');
      const startNodeId = `${tierPrefix}${rawStartId}`;
      const dx0 = p1[0] - p0[0];
      const dz0 = p1[1] - p0[1];
      const len0 = Math.hypot(dx0, dz0) || 1e-6;
      const branchStart: RoadBranch = {
        road,
        endpoint: 'start',
        dir: [dx0 / len0, dz0 / len0],
        nodePos: p0,
        width: w,
        roadClass: road.roadClass,
        segmentLength: Math.max(len0, totalPolyLen),
      };
      if (!nodeBranches.has(startNodeId)) nodeBranches.set(startNodeId, []);
      nodeBranches.get(startNodeId)!.push(branchStart);

      const rawEndId =
        road.nodeIds && road.nodeIds.length > 0
          ? topoIndex.resolveCanonicalNodeId(String(road.nodeIds[road.nodeIds.length - 1]))
          : topoIndex.getOrCreateNode(pn[0], pn[1], isPath ? 'path' : 'veh');
      const endNodeId = `${tierPrefix}${rawEndId}`;
      const dxn = pn_1[0] - pn[0];
      const dzn = pn_1[1] - pn[1];
      const lenn = Math.hypot(dxn, dzn) || 1e-6;
      const branchEnd: RoadBranch = {
        road,
        endpoint: 'end',
        dir: [dxn / lenn, dzn / lenn],
        nodePos: pn,
        width: w,
        roadClass: road.roadClass,
        segmentLength: Math.max(lenn, totalPolyLen),
      };
      if (!nodeBranches.has(endNodeId)) nodeBranches.set(endNodeId, []);
      nodeBranches.get(endNodeId)!.push(branchEnd);
    }

    const trimmedEndpoints = new Map<
      string,
      {
        start?: [number, number];
        end?: [number, number];
        startPortal?: { left: [number, number]; right: [number, number] };
        endPortal?: { left: [number, number]; right: [number, number] };
        startTrimDist: number;
        endTrimDist: number;
        hasCapStart: boolean;
        hasCapEnd: boolean;
      }
    >();
    for (const road of atGradeRoads) {
      const p0 = road.points[0];
      const pn = road.points[road.points.length - 1];
      const touchesBridgeOrTunnelStart = gradeTransitionCoords.some(
        (gt) => Math.hypot(gt[0] - p0[0], gt[1] - p0[1]) <= 0.65
      );
      const touchesBridgeOrTunnelEnd = gradeTransitionCoords.some(
        (gt) => Math.hypot(gt[0] - pn[0], gt[1] - pn[1]) <= 0.65
      );
      const touchesOtherAtGradeStart = atGradeRoads.some(
        (other) =>
          other.id !== road.id &&
          other.points.length >= 2 &&
          (Math.hypot(other.points[0][0] - p0[0], other.points[0][1] - p0[1]) <= 0.25 ||
            Math.hypot(
              other.points[other.points.length - 1][0] - p0[0],
              other.points[other.points.length - 1][1] - p0[1]
            ) <= 0.25)
      );
      const touchesOtherAtGradeEnd = atGradeRoads.some(
        (other) =>
          other.id !== road.id &&
          other.points.length >= 2 &&
          (Math.hypot(other.points[0][0] - pn[0], other.points[0][1] - pn[1]) <= 0.25 ||
            Math.hypot(
              other.points[other.points.length - 1][0] - pn[0],
              other.points[other.points.length - 1][1] - pn[1]
            ) <= 0.25)
      );
      trimmedEndpoints.set(road.id, {
        startTrimDist: 0,
        endTrimDist: 0,
        hasCapStart: !touchesBridgeOrTunnelStart && !touchesOtherAtGradeStart,
        hasCapEnd: !touchesBridgeOrTunnelEnd && !touchesOtherAtGradeEnd,
      });
    }

    const junctionGeometriesByClass = new Map<
      RoadClass,
      Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }>
    >();

    // Track 2D polygon footprints of placed at-grade junctions and roads at Y = 0.050m
    // so crossing paths and unsplit/acute overlapping roads can be Boolean-clipped
    // for zero coplanar triangle overlap at the uniform 0.050m baseline.
    interface PlacedRoadFootprint {
      id: string;
      isPath: boolean;
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
      poly: [number, number][][];
    }
    const placedRoadFootprints: PlacedRoadFootprint[] = [];

    const registerRoadFootprint = (id: string, isPath: boolean, ring: [number, number][]) => {
      if (!ring || ring.length < 3 || hasRingSelfIntersection(ring)) return;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
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

    // B. Solve each junction node: trim incoming ribbons & synthesize non-overlapping junction polygons
    for (const [nodeId, branches] of nodeBranches) {
      if (branches.length < 2) continue;

      let cx = 0;
      let cz = 0;
      for (const bBranch of branches) {
        cx += bBranch.nodePos[0];
        cz += bBranch.nodePos[1];
      }
      cx /= branches.length;
      cz /= branches.length;
      const nodeCenter: [number, number] = [cx, cz];

      // Degree 2 collinear / gentle bend connection: share exact mitered portal vertices at nodeCenter
      if (branches.length === 2) {
        const b0 = branches[0];
        const b1 = branches[1];
        const dot = b0.dir[0] * b1.dir[0] + b0.dir[1] * b1.dir[1];
        if (dot < -0.92 && Math.abs(b0.width - b1.width) < 0.1) {
          // Tangent flowing from b0 into nodeCenter and out along b1
          let tx = -b0.dir[0] + b1.dir[0];
          let tz = -b0.dir[1] + b1.dir[1];
          const tLen = Math.hypot(tx, tz) || 1e-6;
          tx /= tLen;
          tz /= tLen;
          const nx = -tz;
          const nz = tx;
          const cosHalf = Math.sqrt(Math.max(0.1, (1 - dot) * 0.5));
          const miterScale = Math.min(1.25, 1.0 / Math.max(0.76, cosHalf));
          const halfW = (b0.width + b1.width) * 0.25 * miterScale;

          const sharedLeftOutB1: [number, number] = [
            nodeCenter[0] + nx * halfW,
            nodeCenter[1] + nz * halfW,
          ];
          const sharedRightOutB1: [number, number] = [
            nodeCenter[0] - nx * halfW,
            nodeCenter[1] - nz * halfW,
          ];

          const t0 = trimmedEndpoints.get(b0.road.id)!;
          const t1 = trimmedEndpoints.get(b1.road.id)!;
          // Looking outward along b0.dir (opposite t), left is sharedRightOutB1 and right is sharedLeftOutB1
          if (b0.endpoint === 'start') {
            t0.start = nodeCenter;
            t0.startPortal = { left: sharedRightOutB1, right: sharedLeftOutB1 };
            t0.hasCapStart = false;
          } else {
            t0.end = nodeCenter;
            t0.endPortal = { left: sharedLeftOutB1, right: sharedRightOutB1 };
            t0.hasCapEnd = false;
          }
          // Looking outward along b1.dir (along t), left is sharedLeftOutB1 and right is sharedRightOutB1
          if (b1.endpoint === 'start') {
            t1.start = nodeCenter;
            t1.startPortal = { left: sharedLeftOutB1, right: sharedRightOutB1 };
            t1.hasCapStart = false;
          } else {
            t1.end = nodeCenter;
            t1.endPortal = { left: sharedRightOutB1, right: sharedLeftOutB1 };
            t1.hasCapEnd = false;
          }
          continue;
        }
      }

      // Sort branches CCW around junction node
      const sortedBranches = [...branches].sort((a, bBranch) => {
        const angleA = Math.atan2(a.dir[1], a.dir[0]);
        const angleB = Math.atan2(bBranch.dir[1], bBranch.dir[0]);
        return angleA - angleB;
      });

      const k = sortedBranches.length;
      const branchNormals: [number, number][] = sortedBranches.map((bBranch) => [
        -bBranch.dir[1],
        bBranch.dir[0],
      ]);
      const maxTrimDists: number[] = sortedBranches.map((bBranch) =>
        Math.max(0.15, bBranch.segmentLength * 0.45)
      );

      // Compute corner intersections between adjacent branches
      const corners: [number, number][] = [];
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
            // Convex / acute inner crotch between branch A and branch B:
            // Preserve the exact curb intersection up to each branch's maxTrimDist so the two
            // outgoing ribbons are completely separated outside the junction polygon.
            const clampedTA = Math.min(tA, maxTrimDists[i] * 0.94);
            const clampedTB = Math.min(tB, maxTrimDists[next] * 0.94);
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
            // Reflex outer corner (angle >= 180°): bevel outer miter so sharp turns never spike outward
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
          cornerX = (pA[0] + pB[0]) / 2;
          cornerZ = (pA[1] + pB[1]) / 2;
        }

        corners.push([cornerX, cornerZ]);
      }

      // Compute trim portals for each branch
      const portals: Array<{
        left: [number, number];
        right: [number, number];
        center: [number, number];
      }> = [];

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

        const tRec = trimmedEndpoints.get(bBranch.road.id)!;
        if (bBranch.endpoint === 'start') {
          tRec.start = centerPortal;
          tRec.startPortal = { left: leftPortal, right: rightPortal };
          tRec.startTrimDist = Math.max(tRec.startTrimDist, trimDist);
          tRec.hasCapStart = false;
        } else {
          tRec.end = centerPortal;
          // Looking inward toward nodeCenter (the end of the road), left is rightPortal and right is leftPortal
          tRec.endPortal = { left: rightPortal, right: leftPortal };
          tRec.endTrimDist = Math.max(tRec.endTrimDist, trimDist);
          tRec.hasCapEnd = false;
        }
      }

      // Construct closed boundary polygon in CCW order and deduplicate near-coincident vertices
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

      const numPts = polygonPoints.length;
      if (numPts < 3) continue;

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
      let dominantBranch = sortedBranches[0];
      const junctionSourceIdsSet = new Set<string>();
      const portalConnections: RoadPortalConnectionSpec[] = [];
      for (let bIdx = 0; bIdx < k; bIdx++) {
        const bBranch = sortedBranches[bIdx];
        const bPortal = portals[bIdx];
        if (
          (ROAD_CLASS_PRIORITY[bBranch.roadClass] || 0) >
          (ROAD_CLASS_PRIORITY[dominantBranch.roadClass] || 0)
        ) {
          dominantBranch = bBranch;
        }
        const bSids =
          bBranch.road.sourceFeatureIds && bBranch.road.sourceFeatureIds.length > 0
            ? bBranch.road.sourceFeatureIds
            : bBranch.road.sourceFeatureId
              ? [bBranch.road.sourceFeatureId]
              : [bBranch.road.id];
        for (const sid of bSids) {
          junctionSourceIdsSet.add(sid);
          renderedSourceIds.add(sid);
        }
        portalConnections.push({
          roadFeatureId: bBranch.road.id,
          sourceFeatureId: bSids[0],
          endpoint: bBranch.endpoint,
          left: bBranch.endpoint === 'start' ? bPortal.left : bPortal.right,
          right: bBranch.endpoint === 'start' ? bPortal.right : bPortal.left,
        });
      }
      const dominantClass = dominantBranch.roadClass;
      const junctionSourceIds = Array.from(junctionSourceIdsSet);
      const domRoad = dominantBranch.road;
      const junctionFeatureId = `junction-${nodeId}`;

      registerRoadFootprint(
        junctionFeatureId,
        isNonVehicularRoadClass(dominantClass),
        polygonPoints
      );

      const yElev = getRoadElevation(dominantClass, 0, false, false);

      // Ear-clipping triangulation via THREE.ShapeUtils.triangulateShape to prevent fan fold-overs
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

        if (!junctionGeometriesByClass.has(dominantClass)) {
          junctionGeometriesByClass.set(dominantClass, []);
        }
        junctionGeometriesByClass.get(dominantClass)!.push({
          geom: junctionGeo,
          info: {
            id: junctionFeatureId,
            sourceFeatureId: domRoad.sourceFeatureId || domRoad.id,
            sourceFeatureIds: junctionSourceIds,
            portalConnections,
            name: domRoad.name ? `${domRoad.name} (Junction)` : domRoad.cartoLabel || 'Road Junction',
            category: 'Road & Way',
            cartoLabel: domRoad.cartoLabel || `${dominantClass} Road`,
            primaryTag: domRoad.primaryTag || `highway=${dominantClass}`,
            subtype: dominantClass,
            width: dominantBranch.width,
            elevation: yElev,
            layer: 0,
            isBridge: false,
            isTunnel: false,
            osmTags: sanitizeOsmTags(domRoad.osmTags),
          },
        });
      }
    }

    // C. Build trimmed road ribbons for at-grade roads (Vehicular by priority first, then non-vehicular paths)
    const roadsByClass = new Map<
      RoadClass,
      Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }>
    >();

    const fullySubtractedRoadIds = new Set<string>();

    const sortedAtGradeRoads = [...atGradeRoads].sort((a, bRoad) => {
      const aPath = isNonVehicularRoadClass(a.roadClass) ? 1 : 0;
      const bPath = isNonVehicularRoadClass(bRoad.roadClass) ? 1 : 0;
      return aPath - bPath;
    });

    for (const road of sortedAtGradeRoads) {
      try {
        const width = road.width * this.options.roadWidthMultiplier;
        const tInfo = trimmedEndpoints.get(road.id);

        let pts =
          tInfo && (tInfo.startTrimDist > 0 || tInfo.endTrimDist > 0)
            ? trimPolylineByArcLength(road.points, tInfo.startTrimDist, tInfo.endTrimDist)
            : [...road.points];
        if (tInfo?.start && pts.length >= 2) pts[0] = tInfo.start;
        if (tInfo?.end && pts.length >= 2) pts[pts.length - 1] = tInfo.end;

        const isExplicitCulvert =
          !road.isTunnel &&
          Boolean(
            road.osmTags?.culvert === 'yes' ||
              road.osmTags?.tunnel === 'culvert' ||
              road.osmTags?.bridge === 'culvert' ||
              road.osmTags?.man_made === 'culvert' ||
              road.osmTags?.bridge === 'low_water_crossing'
          );
        const roadElevation = isExplicitCulvert
          ? ELEVATION_POLICY.ROAD_SURFACE
          : getRoadElevation(
              road.roadClass,
              road.layer,
              road.isBridge,
              road.isTunnel,
              road.sourceFeatureId || road.id
            );

        const isPath = isNonVehicularRoadClass(road.roadClass);
        const portalOpts = {
          startPortal: tInfo?.startPortal,
          endPortal: tInfo?.endPortal,
        };
        const outlinePoly = buildRoadRibbonOutlineRing(pts, width, portalOpts);

        const sids =
          road.sourceFeatureIds && road.sourceFeatureIds.length > 0
            ? road.sourceFeatureIds
            : road.sourceFeatureId
              ? [road.sourceFeatureId]
              : [road.id];

        let geom: THREE.BufferGeometry | null = null;
        let resolvedClippedPolys: MultiPolygonCoords | null = null;

        // Check whether this road/path overlaps any already-placed junction or road footprint at Y = 0.050m
        if (placedRoadFootprints.length > 0) {
          let pMinX = Infinity, pMaxX = -Infinity, pMinZ = Infinity, pMaxZ = -Infinity;
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
            // Non-vehicular paths clip against vehicular roads/junctions and other paths;
            // vehicular roads clip against any overlapping vehicular junctions or roads
            if (!isPath && fp.isPath) continue;
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

            // For clean vehicular ribbons that meet their junction along a 1D portal edge,
            // verify whether there is any actual positive-area 2D overlap (> 1e-3 m²) before clipping.
            let requiresClipping = isPath || outlineHasSelfIntersection;
            const overlappingPolys: Array<[number, number][][]> = [];
            const overlappingBoxes: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> = [];

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

              // Stage 1: Primary Boolean difference (only if outline ring is manifold and self-intersection-free)
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

              // Stage 2: Retry after polyline cleanup (spike/duplicate removal) and sequential difference
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
                  // Completely subtracted by overlapping road/junction: record diagnostic and do NOT mark as rendered
                  fullySubtractedRoadIds.add(road.id);
                  for (const sid of sids) fullySubtractedRoadIds.add(sid);
                  if (data.diagnostics?.featuresFullySubtracted) {
                    data.diagnostics.featuresFullySubtracted.count++;
                    if (data.diagnostics.featuresFullySubtracted.sampleIds.length < 10) {
                      data.diagnostics.featuresFullySubtracted.sampleIds.push(sids[0]);
                    }
                  }
                  continue;
                }
              } else {
                // Stage 3: Explicit clipping failure diagnostic + safe non-overlapping exterior sub-segment fallback
                if (data.diagnostics) {
                  if (!data.diagnostics.clippingFailures) {
                    data.diagnostics.clippingFailures = { count: 0, sampleIds: [] };
                  }
                  data.diagnostics.clippingFailures.count++;
                  if (data.diagnostics.clippingFailures.sampleIds.length < 10) {
                    data.diagnostics.clippingFailures.sampleIds.push(sids[0]);
                  }
                  if (!data.diagnostics.rejectedInvalid.byReason['path_boolean_clipping_failed']) {
                    data.diagnostics.rejectedInvalid.byReason['path_boolean_clipping_failed'] = {
                      count: 0,
                      sampleIds: [],
                    };
                  }
                  data.diagnostics.rejectedInvalid.byReason['path_boolean_clipping_failed'].count++;
                  if (
                    data.diagnostics.rejectedInvalid.byReason['path_boolean_clipping_failed']
                      .sampleIds.length < 10
                  ) {
                    data.diagnostics.rejectedInvalid.byReason[
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
                  // Verify this exterior sub-segment does not overlap any already-placed road/path footprint
                  // (including earlier sub-segments of this same self-crossing path)
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
                    registerRoadFootprint(road.id, isPath, subOutline[0]);
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
                  // Do NOT fall back to an overlapping path ribbon and do NOT claim feature was rendered
                  fullySubtractedRoadIds.add(road.id);
                  for (const sid of sids) fullySubtractedRoadIds.add(sid);
                  continue;
                }
              }
            }
          }
        }

        if (!geom) {
          if (!outlinePoly || !outlinePoly[0] || hasRingSelfIntersection(outlinePoly[0])) {
            const cleanedPts = cleanPolylineForClipping(pts);
            const cleanedOutline = buildRoadRibbonOutlineRing(cleanedPts, width);
            if (!cleanedOutline || !cleanedOutline[0] || hasRingSelfIntersection(cleanedOutline[0])) {
              if (data.diagnostics) {
                if (!data.diagnostics.clippingFailures) {
                  data.diagnostics.clippingFailures = { count: 0, sampleIds: [] };
                }
                data.diagnostics.clippingFailures.count++;
                if (data.diagnostics.clippingFailures.sampleIds.length < 10) {
                  data.diagnostics.clippingFailures.sampleIds.push(sids[0]);
                }
              }
              continue;
            }
            pts = cleanedPts;
          }

          const ribbon = generateRoadRibbon(pts, width, roadElevation, {
            roundCaps: true,
            hasStartCap: tInfo?.hasCapStart ?? true,
            hasEndCap: tInfo?.hasCapEnd ?? true,
            startPortal: tInfo?.startPortal,
            endPortal: tInfo?.endPortal,
          });
          if (!ribbon) continue;

          geom = resourceManager.registerGeometry(new THREE.BufferGeometry());
          geom.setAttribute('position', new THREE.BufferAttribute(ribbon.positions, 3));
          geom.setAttribute('normal', new THREE.BufferAttribute(ribbon.normals, 3));
          geom.setIndex(new THREE.BufferAttribute(ribbon.indices, 1));
        }

        if (resolvedClippedPolys) {
          for (const polyRings of resolvedClippedPolys) {
            if (polyRings[0]) registerRoadFootprint(road.id, isPath, polyRings[0]);
          }
        } else if (outlinePoly && outlinePoly[0]) {
          registerRoadFootprint(road.id, isPath, outlinePoly[0]);
        }

        const roadInfo: InspectableFeatureInfo = {
          id: road.id,
          sourceFeatureId: sids[0],
          sourceFeatureIds: sids,
          name: road.name || road.cartoLabel || `Road (${road.roadClass})`,
          category: 'Road & Way',
          cartoLabel: road.cartoLabel || `${road.roadClass} Road`,
          primaryTag: road.primaryTag || `highway=${road.roadClass}`,
          subtype: road.roadClass,
          width: Number(width.toFixed(1)),
          elevation: roadElevation,
          layer: road.layer,
          isBridge: road.isBridge,
          isTunnel: road.isTunnel,
          osmTags: sanitizeOsmTags(road.osmTags),
        };

        if (!roadsByClass.has(road.roadClass)) {
          roadsByClass.set(road.roadClass, []);
        }
        roadsByClass.get(road.roadClass)!.push({
          geom,
          info: roadInfo,
        });

        // For stairways (`highway=steps`), generate raised transverse step treads
        if (road.roadClass === 'steps') {
          const treadGeo = generateStepTreads(
            pts,
            width,
            roadElevation + ELEVATION_POLICY.STEP_TREAD_OFFSET
          );
          if (treadGeo) {
            resourceManager.registerGeometry(treadGeo);
            roadsByClass.get(road.roadClass)!.push({ geom: treadGeo, info: roadInfo });
          }
        }

        for (const sid of sids) renderedSourceIds.add(sid);
      } catch (err) {
        console.warn(`Skipping invalid at-grade road ${road.id}`, err);
      }
    }

    roadsGroup.userData.fullySubtractedRoadIds = Array.from(fullySubtractedRoadIds);

    // Add junction geometries into matching class buffers
    junctionGeometriesByClass.forEach((items, roadClass) => {
      if (!roadsByClass.has(roadClass)) {
        roadsByClass.set(roadClass, []);
      }
      roadsByClass.get(roadClass)!.push(...items);
    });

    // D. Build grade-separated roads:
    // - Bridges: 3D sloped approach ramps connecting at-grade roads to elevated bridge decks + substructure + parapets + piers
    // - Tunnels: 3D concrete tunnel portal arches + dark recessed entrance mouths + dashed underground traces
    for (const road of gradeSeparatedRoads) {
      try {
        const width = road.width * this.options.roadWidthMultiplier;
        const sids =
          road.sourceFeatureIds && road.sourceFeatureIds.length > 0
            ? road.sourceFeatureIds
            : road.sourceFeatureId
              ? [road.sourceFeatureId]
              : [road.id];

        if (road.isTunnel || road.layer < 0) {
          const tunnelInfo: InspectableFeatureInfo = {
            id: road.id,
            sourceFeatureId: sids[0],
            sourceFeatureIds: sids,
            name: road.name || road.cartoLabel || `Tunnel (${road.roadClass})`,
            category: 'Road & Way',
            cartoLabel: road.cartoLabel ? `${road.cartoLabel} (Tunnel)` : `${road.roadClass} Tunnel`,
            primaryTag: road.primaryTag || `highway=${road.roadClass} + tunnel=yes`,
            subtype: road.roadClass,
            width: Number(width.toFixed(1)),
            elevation: getRoadElevation(road.roadClass, road.layer, false, true),
            layer: road.layer,
            isBridge: false,
            isTunnel: true,
            osmTags: sanitizeOsmTags(road.osmTags),
          };

          const { portalStructureGeo, portalMouthGeo, undergroundTraceGeo } =
            generateTunnelPortalAndTraceGeometries(
              road.points,
              width,
              isNonVehicularRoadClass(road.roadClass)
            );
          if (portalStructureGeo) {
            resourceManager.registerGeometry(portalStructureGeo);
            tunnelPortalItems.push({ geom: portalStructureGeo, info: tunnelInfo });
          }
          if (portalMouthGeo) {
            resourceManager.registerGeometry(portalMouthGeo);
            tunnelMouthItems.push({ geom: portalMouthGeo, info: tunnelInfo });
          }
          if (undergroundTraceGeo) {
            resourceManager.registerGeometry(undergroundTraceGeo);
            tunnelTraceItems.push({ geom: undergroundTraceGeo, info: tunnelInfo });
          }

          for (const sid of sids) renderedSourceIds.add(sid);
          continue;
        }

        const targetElevation = getRoadElevation(
          road.roadClass,
          road.layer,
          road.isBridge,
          road.isTunnel,
          road.sourceFeatureId || road.id
        );

        const pStart = road.points[0];
        const pEnd = road.points[road.points.length - 1];
        const connectsStartAtGrade = atGradeRoadEndpoints.some(
          (pt) => Math.hypot(pt[0] - pStart[0], pt[1] - pStart[1]) <= 0.8
        );
        const connectsEndAtGrade = atGradeRoadEndpoints.some(
          (pt) => Math.hypot(pt[0] - pEnd[0], pt[1] - pEnd[1]) <= 0.8
        );
        const connectsStartBridge = bridgeRoadEndpoints.some(
          (b) => b.id !== road.id && Math.hypot(b.pt[0] - pStart[0], b.pt[1] - pStart[1]) <= 0.8
        );
        const connectsEndBridge = bridgeRoadEndpoints.some(
          (b) => b.id !== road.id && Math.hypot(b.pt[0] - pEnd[0], b.pt[1] - pEnd[1]) <= 0.8
        );

        const { profile, peakElevation } = buildBridgeProfile3D({
          points: road.points,
          baseElevation: ELEVATION_POLICY.ROAD_SURFACE,
          targetBridgeElevation: targetElevation,
          connectsStartAtGrade,
          connectsEndAtGrade,
          connectsStartBridge,
          connectsEndBridge,
          maxSampleStep: 2.0,
        });

        const geom =
          profile.length >= 2
            ? generateProfiledRibbon3D(profile, width)
            : (() => {
                const ribbon = generateRoadRibbon(road.points, width, targetElevation, {
                  roundCaps: true,
                });
                if (!ribbon) return null;
                const g = new THREE.BufferGeometry();
                g.setAttribute('position', new THREE.BufferAttribute(ribbon.positions, 3));
                g.setAttribute('normal', new THREE.BufferAttribute(ribbon.normals, 3));
                g.setIndex(new THREE.BufferAttribute(ribbon.indices, 1));
                return g;
              })();

        if (!geom) continue;
        resourceManager.registerGeometry(geom);

        const bridgeInfo: InspectableFeatureInfo = {
          id: road.id,
          sourceFeatureId: sids[0],
          sourceFeatureIds: sids,
          name: road.name || road.cartoLabel || `Bridge (${road.roadClass})`,
          category: 'Road & Way',
          cartoLabel: road.cartoLabel ? `${road.cartoLabel} (Bridge)` : `${road.roadClass} Bridge`,
          primaryTag: road.primaryTag || `highway=${road.roadClass} + bridge=yes`,
          subtype: road.roadClass,
          width: Number(width.toFixed(1)),
          elevation: peakElevation,
          layer: road.layer,
          isBridge: road.isBridge,
          isTunnel: road.isTunnel,
          osmTags: sanitizeOsmTags(road.osmTags),
        };

        if (!roadsByClass.has(road.roadClass)) {
          roadsByClass.set(road.roadClass, []);
        }
        roadsByClass.get(road.roadClass)!.push({ geom, info: bridgeInfo });

        // Generate 3D bridge deck substructure (fascia + soffit + ramp embankments), side parapets, and support piers
        if (profile.length >= 2) {
          const { substructureGeo, parapetGeo, piersGeo } = generateBridgeStructureGeometries(
            profile,
            width,
            peakElevation,
            0.36
          );
          if (substructureGeo) {
            resourceManager.registerGeometry(substructureGeo);
            bridgeSubstructureItems.push({ geom: substructureGeo, info: bridgeInfo });
          }
          if (parapetGeo) {
            resourceManager.registerGeometry(parapetGeo);
            bridgeParapetItems.push({ geom: parapetGeo, info: bridgeInfo });
          }
          if (piersGeo) {
            resourceManager.registerGeometry(piersGeo);
            bridgePierItems.push({ geom: piersGeo, info: bridgeInfo });
          }
        }

        for (const sid of sids) renderedSourceIds.add(sid);
      } catch (err) {
        console.warn(`Skipping invalid grade-separated road ${road.id}`, err);
      }
    }

    // Render order must strictly exceed water (2) and parks (3) for all paths and roads
    const ROAD_CLASS_RENDER_ORDER: Record<RoadClass, number> = {
      path: 4,
      footway: 4,
      steps: 4,
      bridleway: 4,
      track: 4,
      cycleway: 5,
      pedestrian: 5,
      platform: 5,
      pier: 5,
      service: 6,
      construction: 6,
      living_street: 7,
      residential: 7,
      unclassified: 7,
      tertiary: 8,
      bus_guideway: 8,
      raceway: 9,
      secondary: 9,
      primary: 10,
      taxiway: 10,
      runway: 11,
      trunk: 11,
      motorway: 11,
      bridge: 12,
    };

    // Merge and instantiate road meshes by class
    roadsByClass.forEach((items, roadClass) => {
      const { merged: mergedRoadGeo, faceRanges } = mergeWithFaceRanges(items, resourceManager);
      if (mergedRoadGeo) {
        resourceManager.registerGeometry(mergedRoadGeo);
        const color = theme.roadColors[roadClass] || '#64748b';
        const isPath = isNonVehicularRoadClass(roadClass);
        const depthConfig = isPath ? DEPTH_OFFSET_CONFIG.paths : DEPTH_OFFSET_CONFIG.roads;
        const roadMat = resourceManager.registerMaterial(
          new THREE.MeshStandardMaterial({
            color,
            roughness: 0.8,
            metalness: 0.1,
            side: THREE.DoubleSide,
            ...depthConfig,
          })
        );
        roadMaterialsByClass.set(roadClass, roadMat);

        const roadMesh = new THREE.Mesh(mergedRoadGeo, roadMat);
        roadMesh.name = `Roads_${roadClass}`;
        roadMesh.receiveShadow = true;
        roadMesh.renderOrder = ROAD_CLASS_RENDER_ORDER[roadClass] ?? 6;
        roadMesh.userData = { faceRanges };
        roadsGroup.add(roadMesh);
        drawCalls++;

        totalVertices += mergedRoadGeo.attributes.position.count;
        totalTriangles += (mergedRoadGeo.index?.count || 0) / 3;
      }
    });

    // Instantiate 3D Bridge Substructure, Side Parapets, Support Piers, and 3D Tunnel Portals / Traces
    let bridgeStructureMat: THREE.MeshStandardMaterial | undefined;
    let bridgeParapetMat: THREE.MeshStandardMaterial | undefined;
    let tunnelPortalMat: THREE.MeshStandardMaterial | undefined;
    let tunnelMouthMat: THREE.MeshStandardMaterial | undefined;
    let tunnelTraceMat: THREE.MeshStandardMaterial | undefined;

    if (bridgeSubstructureItems.length > 0 || bridgePierItems.length > 0) {
      bridgeStructureMat = resourceManager.registerMaterial(
        new THREE.MeshStandardMaterial({
          color: theme.id === 'daylight' ? '#64748b' : theme.id === 'blueprint' ? '#0077b6' : '#334155',
          roughness: 0.78,
          metalness: 0.18,
          side: THREE.DoubleSide,
        })
      );

      if (bridgeSubstructureItems.length > 0) {
        const { merged, faceRanges } = mergeWithFaceRanges(bridgeSubstructureItems, resourceManager);
        if (merged) {
          resourceManager.registerGeometry(merged);
          const mesh = new THREE.Mesh(merged, bridgeStructureMat);
          mesh.name = 'Bridge_Substructure';
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.renderOrder = 12;
          mesh.userData = { faceRanges };
          roadsGroup.add(mesh);
          drawCalls++;
          totalVertices += merged.attributes.position.count;
          totalTriangles += getTriangleCount(merged);
        }
      }

      if (bridgePierItems.length > 0) {
        const { merged, faceRanges } = mergeWithFaceRanges(bridgePierItems, resourceManager);
        if (merged) {
          resourceManager.registerGeometry(merged);
          const mesh = new THREE.Mesh(merged, bridgeStructureMat);
          mesh.name = 'Bridge_Piers';
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.renderOrder = 12;
          mesh.userData = { faceRanges };
          roadsGroup.add(mesh);
          drawCalls++;
          totalVertices += merged.attributes.position.count;
          totalTriangles += getTriangleCount(merged);
        }
      }
    }

    if (bridgeParapetItems.length > 0) {
      const { merged, faceRanges } = mergeWithFaceRanges(bridgeParapetItems, resourceManager);
      if (merged) {
        resourceManager.registerGeometry(merged);
        bridgeParapetMat = resourceManager.registerMaterial(
          new THREE.MeshStandardMaterial({
            color: theme.id === 'daylight' ? '#94a3b8' : theme.id === 'blueprint' ? '#48cae4' : '#64748b',
            roughness: 0.55,
            metalness: 0.3,
            side: THREE.DoubleSide,
            ...DEPTH_OFFSET_CONFIG.roads,
          })
        );
        const mesh = new THREE.Mesh(merged, bridgeParapetMat);
        mesh.name = 'Bridge_Parapets';
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.renderOrder = 13;
        mesh.userData = { faceRanges };
        roadsGroup.add(mesh);
        drawCalls++;
        totalVertices += merged.attributes.position.count;
        totalTriangles += getTriangleCount(merged);
      }
    }

    if (tunnelPortalItems.length > 0) {
      const { merged, faceRanges } = mergeWithFaceRanges(tunnelPortalItems, resourceManager);
      if (merged) {
        resourceManager.registerGeometry(merged);
        tunnelPortalMat = resourceManager.registerMaterial(
          new THREE.MeshStandardMaterial({
            color: theme.id === 'daylight' ? '#94a3b8' : theme.id === 'blueprint' ? '#0096c7' : '#475569',
            roughness: 0.65,
            metalness: 0.25,
            side: THREE.DoubleSide,
            ...DEPTH_OFFSET_CONFIG.roads,
          })
        );
        const mesh = new THREE.Mesh(merged, tunnelPortalMat);
        mesh.name = 'Tunnel_Portals';
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.renderOrder = 18;
        mesh.userData = { faceRanges };
        roadsGroup.add(mesh);
        drawCalls++;
        totalVertices += merged.attributes.position.count;
        totalTriangles += getTriangleCount(merged);
      }
    }

    if (tunnelMouthItems.length > 0) {
      const { merged, faceRanges } = mergeWithFaceRanges(tunnelMouthItems, resourceManager);
      if (merged) {
        resourceManager.registerGeometry(merged);
        tunnelMouthMat = resourceManager.registerMaterial(
          new THREE.MeshStandardMaterial({
            color: '#070a12',
            roughness: 0.95,
            metalness: 0.05,
            side: THREE.DoubleSide,
            ...DEPTH_OFFSET_CONFIG.railways,
          })
        );
        const mesh = new THREE.Mesh(merged, tunnelMouthMat);
        mesh.name = 'Tunnel_Entrances';
        mesh.receiveShadow = true;
        mesh.renderOrder = 17;
        mesh.userData = { faceRanges };
        roadsGroup.add(mesh);
        drawCalls++;
        totalVertices += merged.attributes.position.count;
        totalTriangles += getTriangleCount(merged);
      }
    }

    if (tunnelTraceItems.length > 0) {
      const { merged, faceRanges } = mergeWithFaceRanges(tunnelTraceItems, resourceManager);
      if (merged) {
        resourceManager.registerGeometry(merged);
        tunnelTraceMat = resourceManager.registerMaterial(
          new THREE.MeshStandardMaterial({
            color: theme.id === 'daylight' ? '#475569' : theme.id === 'blueprint' ? '#00b4d8' : '#38bdf8',
            roughness: 0.6,
            metalness: 0.2,
            transparent: true,
            opacity: 0.55,
            side: THREE.DoubleSide,
            ...DEPTH_OFFSET_CONFIG.railways,
          })
        );
        const mesh = new THREE.Mesh(merged, tunnelTraceMat);
        mesh.name = 'Tunnel_Underground_Trace';
        mesh.receiveShadow = false;
        mesh.renderOrder = 15;
        mesh.userData = { faceRanges };
        roadsGroup.add(mesh);
        drawCalls++;
        totalVertices += merged.attributes.position.count;
        totalTriangles += getTriangleCount(merged);
      }
    }

    // ==========================================================================
    // 7. LINEAR BARRIERS (Walls, Hedges, Fences, City Walls, Cliffs, Tree Rows)
    // ==========================================================================
    const barriersByType = new Map<
      string,
      Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }>
    >();

    for (const bar of data.barriers || []) {
      try {
        const info: InspectableFeatureInfo = {
          id: bar.id,
          sourceFeatureId: bar.sourceFeatureId || bar.id,
          name: bar.name || bar.cartoLabel || 'Barrier',
          category: 'Barrier & Wall',
          cartoLabel: bar.cartoLabel || `Barrier (${bar.barrierType})`,
          primaryTag: bar.primaryTag || `barrier=${bar.barrierType}`,
          subtype: bar.barrierType,
          width: bar.width,
          height: bar.height,
          elevation: ELEVATION_POLICY.PARKS,
          osmTags: sanitizeOsmTags(bar.osmTags),
        };

        // If natural=tree_row, place procedural 3D trees along the polyline
        if (bar.barrierType === 'tree_row') {
          const stepMeters = 9.5;
          for (let i = 0; i < bar.points.length - 1; i++) {
            const p0 = bar.points[i];
            const p1 = bar.points[i + 1];
            const segLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
            const steps = Math.max(1, Math.floor(segLen / stepMeters));
            for (let s = 0; s <= steps; s++) {
              if (treePlacements.length >= MAX_SCENE_TREES) break;
              const t = steps === 0 ? 0 : s / steps;
              const tx = p0[0] + (p1[0] - p0[0]) * t;
              const tz = p0[1] + (p1[1] - p0[1]) * t;
              const h = Math.abs(Math.sin(tx * 17.3 + tz * 31.7));
              treePlacements.push({
                x: tx,
                z: tz,
                scale: 0.85 + (h % 0.35),
                rotationY: (h * 6.28) % 6.28,
                leafType: 'broadleaved',
                info,
              });
            }
          }
          if (bar.sourceFeatureId) renderedSourceIds.add(bar.sourceFeatureId);
          continue;
        }

        const barGeo = generateExtrudedBarrierRibbon(
          bar.points,
          bar.width,
          bar.height,
          ELEVATION_POLICY.PARKS
        );
        if (!barGeo) continue;
        resourceManager.registerGeometry(barGeo);

        const bKey =
          bar.barrierType === 'hedge'
            ? 'hedge'
            : bar.barrierType === 'city_wall'
              ? 'city_wall'
              : bar.barrierType === 'fence' || bar.barrierType === 'guard_rail'
                ? 'fence'
                : bar.barrierType === 'cliff' || bar.barrierType === 'embankment'
                  ? 'cliff'
                  : 'wall';

        if (!barriersByType.has(bKey)) barriersByType.set(bKey, []);
        barriersByType.get(bKey)!.push({ geom: barGeo, info });
        if (bar.sourceFeatureId) renderedSourceIds.add(bar.sourceFeatureId);
      } catch (err) {
        console.warn(`Skipping invalid barrier ${bar.id}`, err);
      }
    }

    barriersByType.forEach((items, bKey) => {
      const { merged, faceRanges } = mergeWithFaceRanges(items, resourceManager);
      if (merged) {
        resourceManager.registerGeometry(merged);
        const color =
          (theme.barrierColors as any)?.[bKey] ||
          (bKey === 'hedge' ? '#15803d' : '#64748b');
        const mat = resourceManager.registerMaterial(
          new THREE.MeshStandardMaterial({
            color,
            roughness: bKey === 'hedge' ? 0.85 : 0.7,
            metalness: 0.1,
            side: THREE.DoubleSide,
          })
        );
        barrierMaterialsByType.set(bKey, mat);

        const mesh = new THREE.Mesh(merged, mat);
        mesh.name = `Barriers_${bKey}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = { faceRanges };
        barriersGroup.add(mesh);
        drawCalls++;

        totalVertices += merged.attributes.position.count;
        totalTriangles += (merged.index?.count || 0) / 3;
      }
    });

    // ==========================================================================
    // 8. PROCEDURAL 3D FORESTS, INDIVIDUAL TREES, STREET FURNITURE & 3D LANDMARKS
    // ==========================================================================
    const structuralLandmarks: PointLandmarkFeature[] = [];
    const streetFurnitureLandmarks: PointLandmarkFeature[] = [];
    const STREET_FURNITURE_TYPES = new Set([
      'bench',
      'waste_basket',
      'street_lamp',
      'bicycle_parking',
      'fountain',
      'shelter',
      'post_box',
    ]);

    for (const lm of data.landmarks || []) {
      const isStreetFurniture = STREET_FURNITURE_TYPES.has(lm.landmarkType);
      const info: InspectableFeatureInfo = {
        id: lm.id,
        sourceFeatureId: lm.sourceFeatureId || lm.id,
        name: lm.name || lm.cartoLabel || 'Landmark',
        category:
          lm.landmarkType === 'tree'
            ? 'Forest & Woodland'
            : isStreetFurniture
              ? 'Street Furniture & Amenity'
              : '3D Tree & Landmark',
        cartoLabel: lm.cartoLabel || `Landmark (${lm.landmarkType})`,
        primaryTag: lm.primaryTag || `man_made=${lm.landmarkType}`,
        subtype: lm.landmarkType,
        height: lm.height,
        heightFormatted: `${lm.height.toFixed(1)}m`,
        elevation: ELEVATION_POLICY.PARKS,
        osmTags: sanitizeOsmTags(lm.osmTags),
      };

      if (lm.landmarkType === 'tree') {
        if (treePlacements.length < MAX_SCENE_TREES) {
          const h = Math.abs(Math.sin(lm.position[0] * 19.1 + lm.position[1] * 47.3));
          treePlacements.push({
            x: lm.position[0],
            z: lm.position[1],
            scale: 0.9 + (h % 0.35),
            rotationY: (h * 6.28) % 6.28,
            leafType: lm.leafType || 'broadleaved',
            info,
          });
        }
        if (lm.sourceFeatureId) renderedSourceIds.add(lm.sourceFeatureId);
      } else if (isStreetFurniture) {
        streetFurnitureLandmarks.push(lm);
        if (lm.sourceFeatureId) renderedSourceIds.add(lm.sourceFeatureId);
      } else if (lm.landmarkType !== 'poi' && lm.landmarkType !== 'transit_stop') {
        // Render 3D physical towers, masts, wind turbines, windmills, chimneys, cranes, monuments
        structuralLandmarks.push(lm);
        if (lm.sourceFeatureId) renderedSourceIds.add(lm.sourceFeatureId);
      }
    }

    // Build hardware-instanced procedural 3D trees (Trunks + Broadleaved 3-Lobe Crowns + Conifer 3-Tier Crowns)
    let trunkMat: THREE.MeshStandardMaterial | undefined;
    let broadleafMat: THREE.MeshStandardMaterial | undefined;
    let needleleafMat: THREE.MeshStandardMaterial | undefined;

    if (treePlacements.length > 0) {
      // 1. Shared Trunk Geometry (tapered cylinder grounded at y=0)
      const trunkGeo = resourceManager.registerGeometry(
        new THREE.CylinderGeometry(0.18, 0.32, 2.5, 6)
      );
      trunkGeo.translate(0, 1.25, 0);

      trunkMat = resourceManager.registerMaterial(
        new THREE.MeshStandardMaterial({
          color: theme.foliageColors?.trunk || '#451a03',
          roughness: 0.9,
          metalness: 0.05,
        })
      );

      const trunkInstanced = new THREE.InstancedMesh(
        trunkGeo,
        trunkMat,
        treePlacements.length
      );
      trunkInstanced.name = 'ProceduralForest_Trunks';
      trunkInstanced.castShadow = true;
      trunkInstanced.receiveShadow = true;
      trunkInstanced.frustumCulled = false;

      const dummy = new THREE.Object3D();
      const trunkInfos: InspectableFeatureInfo[] = [];

      const broadPlacements: TreePlacement[] = [];
      const needlePlacements: TreePlacement[] = [];

      for (let i = 0; i < treePlacements.length; i++) {
        const tp = treePlacements[i];
        dummy.position.set(tp.x, ELEVATION_POLICY.PARKS, tp.z);
        dummy.rotation.set(0, tp.rotationY, 0);
        dummy.scale.setScalar(tp.scale);
        dummy.updateMatrix();
        trunkInstanced.setMatrixAt(i, dummy.matrix);
        trunkInfos.push(tp.info);

        if (tp.leafType === 'needleleaved') {
          needlePlacements.push(tp);
        } else {
          broadPlacements.push(tp);
        }
      }
      trunkInstanced.instanceMatrix.needsUpdate = true;
      trunkInstanced.userData = { isInstanced: true, instanceInfos: trunkInfos };
      foliageGroup.add(trunkInstanced);
      drawCalls++;

      totalVertices += trunkGeo.attributes.position.count * treePlacements.length;
      totalTriangles += ((trunkGeo.index?.count || 0) / 3) * treePlacements.length;

      // 2. Broadleaved Composite 3-Lobe Canopy Geometry
      if (broadPlacements.length > 0) {
        const lobeMain = new THREE.IcosahedronGeometry(1.75, 1);
        lobeMain.translate(0, 3.8, 0);
        const lobeLeft = new THREE.IcosahedronGeometry(1.3, 1);
        lobeLeft.translate(-0.85, 3.25, 0.5);
        const lobeRight = new THREE.IcosahedronGeometry(1.35, 1);
        lobeRight.translate(0.8, 3.35, -0.45);

        const mergedBroadCanopy = resourceManager.registerGeometry(
          mergeGeometries([lobeMain, lobeLeft, lobeRight], false)!
        );
        lobeMain.dispose();
        lobeLeft.dispose();
        lobeRight.dispose();

        broadleafMat = resourceManager.registerMaterial(
          new THREE.MeshStandardMaterial({
            color: theme.foliageColors?.broadleaved || '#16a34a',
            roughness: 0.78,
            metalness: 0.05,
          })
        );

        const broadInstanced = new THREE.InstancedMesh(
          mergedBroadCanopy,
          broadleafMat,
          broadPlacements.length
        );
        broadInstanced.name = 'ProceduralForest_BroadleavedCanopy';
        broadInstanced.castShadow = true;
        broadInstanced.receiveShadow = true;
        broadInstanced.frustumCulled = false;

        const broadInfos: InspectableFeatureInfo[] = [];
        for (let i = 0; i < broadPlacements.length; i++) {
          const tp = broadPlacements[i];
          dummy.position.set(tp.x, ELEVATION_POLICY.PARKS, tp.z);
          dummy.rotation.set(0, tp.rotationY, 0);
          dummy.scale.setScalar(tp.scale);
          dummy.updateMatrix();
          broadInstanced.setMatrixAt(i, dummy.matrix);
          broadInfos.push(tp.info);
        }
        broadInstanced.instanceMatrix.needsUpdate = true;
        broadInstanced.userData = { isInstanced: true, instanceInfos: broadInfos };
        foliageGroup.add(broadInstanced);
        drawCalls++;

        totalVertices += mergedBroadCanopy.attributes.position.count * broadPlacements.length;
        totalTriangles += ((mergedBroadCanopy.index?.count || 0) / 3) * broadPlacements.length;
      }

      // 3. Needleleaved (Coniferous) Composite 3-Tier Pine Geometry
      if (needlePlacements.length > 0) {
        const tierBottom = new THREE.ConeGeometry(1.85, 2.5, 7);
        tierBottom.translate(0, 3.0, 0);
        const tierMid = new THREE.ConeGeometry(1.4, 2.2, 7);
        tierMid.translate(0, 4.3, 0);
        const tierTop = new THREE.ConeGeometry(0.95, 1.8, 7);
        tierTop.translate(0, 5.4, 0);

        const mergedNeedleCanopy = resourceManager.registerGeometry(
          mergeGeometries([tierBottom, tierMid, tierTop], false)!
        );
        tierBottom.dispose();
        tierMid.dispose();
        tierTop.dispose();

        needleleafMat = resourceManager.registerMaterial(
          new THREE.MeshStandardMaterial({
            color: theme.foliageColors?.needleleaved || '#15803d',
            roughness: 0.75,
            metalness: 0.05,
          })
        );

        const needleInstanced = new THREE.InstancedMesh(
          mergedNeedleCanopy,
          needleleafMat,
          needlePlacements.length
        );
        needleInstanced.name = 'ProceduralForest_NeedleleavedCanopy';
        needleInstanced.castShadow = true;
        needleInstanced.receiveShadow = true;
        needleInstanced.frustumCulled = false;

        const needleInfos: InspectableFeatureInfo[] = [];
        for (let i = 0; i < needlePlacements.length; i++) {
          const tp = needlePlacements[i];
          dummy.position.set(tp.x, ELEVATION_POLICY.PARKS, tp.z);
          dummy.rotation.set(0, tp.rotationY, 0);
          dummy.scale.setScalar(tp.scale);
          dummy.updateMatrix();
          needleInstanced.setMatrixAt(i, dummy.matrix);
          needleInfos.push(tp.info);
        }
        needleInstanced.instanceMatrix.needsUpdate = true;
        needleInstanced.userData = { isInstanced: true, instanceInfos: needleInfos };
        foliageGroup.add(needleInstanced);
        drawCalls++;

        totalVertices += mergedNeedleCanopy.attributes.position.count * needlePlacements.length;
        totalTriangles += ((mergedNeedleCanopy.index?.count || 0) / 3) * needlePlacements.length;
      }
    }

    // 4. Composite 3D Point Landmarks (Towers, Wind Turbines, Windmills, Masts, Monuments)
    let landmarkPointMat: THREE.MeshStandardMaterial | undefined;
    if (structuralLandmarks.length > 0) {
      landmarkPointMat = resourceManager.registerMaterial(
        new THREE.MeshStandardMaterial({
          color: theme.id === 'tactical' ? '#38bdf8' : '#f59e0b',
          roughness: 0.35,
          metalness: 0.65,
        })
      );

      const lmItems: Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }> = [];

      for (const lm of structuralLandmarks) {
        const h = Math.max(lm.height * this.options.buildingHeightMultiplier, 3.0);
        const rBase = lm.landmarkType === 'storage_tank' ? 3.2 : lm.landmarkType === 'cooling_tower' ? 4.5 : 1.1;
        const rTop = lm.landmarkType === 'storage_tank' ? 3.2 : lm.landmarkType === 'cooling_tower' ? 3.2 : 0.45;

        const shaft = new THREE.CylinderGeometry(rTop, rBase, h * 0.85, 8);
        shaft.translate(lm.position[0], (h * 0.85) / 2, lm.position[1]);

        const cap = new THREE.ConeGeometry(rTop * 1.45, h * 0.2, 8);
        cap.translate(lm.position[0], h * 0.85 + (h * 0.2) / 2, lm.position[1]);

        const composite = resourceManager.registerGeometry(
          mergeGeometries([shaft, cap], false)!
        );
        shaft.dispose();
        cap.dispose();

        lmItems.push({
          geom: composite,
          info: {
            id: lm.id,
            sourceFeatureId: lm.sourceFeatureId || lm.id,
            name: lm.name || lm.cartoLabel || '3D Landmark',
            category: '3D Tree & Landmark',
            cartoLabel: lm.cartoLabel || `Landmark (${lm.landmarkType})`,
            primaryTag: lm.primaryTag || `man_made=${lm.landmarkType}`,
            subtype: lm.landmarkType,
            height: Number(h.toFixed(1)),
            heightFormatted: `${h.toFixed(1)}m`,
            osmTags: sanitizeOsmTags(lm.osmTags),
          },
        });
      }

      const { merged: mergedLmGeo, faceRanges } = mergeWithFaceRanges(lmItems, resourceManager);
      if (mergedLmGeo) {
        resourceManager.registerGeometry(mergedLmGeo);
        const lmMesh = new THREE.Mesh(mergedLmGeo, landmarkPointMat);
        lmMesh.name = 'PointLandmarks_3D';
        lmMesh.castShadow = true;
        lmMesh.receiveShadow = true;
        lmMesh.userData = { faceRanges };
        foliageGroup.add(lmMesh);
        drawCalls++;

        totalVertices += mergedLmGeo.attributes.position.count;
        totalTriangles += (mergedLmGeo.index?.count || 0) / 3;
      }
    }

    // 5. Composite 3D Street Furniture & Micro-Amenities (Benches, Waste Bins, Street Lamps, Bike Racks, Fountains, Shelters)
    const furnitureByStyle = new Map<
      'wood' | 'metal' | 'lamp' | 'stone',
      Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }>
    >();
    const furnitureMaterials = new Map<'wood' | 'metal' | 'lamp' | 'stone', THREE.MeshStandardMaterial>();

    if (streetFurnitureLandmarks.length > 0) {
      for (const lm of streetFurnitureLandmarks) {
        try {
          const { geom, styleGroup } = buildStreetFurnitureGeometry(lm);
          resourceManager.registerGeometry(geom);
          if (!furnitureByStyle.has(styleGroup)) {
            furnitureByStyle.set(styleGroup, []);
          }
          furnitureByStyle.get(styleGroup)!.push({
            geom,
            info: {
              id: lm.id,
              sourceFeatureId: lm.sourceFeatureId || lm.id,
              name: lm.name || lm.cartoLabel || 'Street Furniture',
              category: 'Street Furniture & Amenity',
              cartoLabel: lm.cartoLabel || `Amenity (${lm.landmarkType})`,
              primaryTag: lm.primaryTag || `amenity=${lm.landmarkType}`,
              subtype: lm.landmarkType,
              height: Number(lm.height.toFixed(2)),
              heightFormatted: `${lm.height.toFixed(1)}m`,
              elevation: ELEVATION_POLICY.PARKS,
              osmTags: sanitizeOsmTags(lm.osmTags),
            },
          });
        } catch (err) {
          console.warn(`Skipping invalid street furniture ${lm.id}`, err);
        }
      }

      const stylePalette: Record<'wood' | 'metal' | 'lamp' | 'stone', { color: string; roughness: number; metalness: number }> = {
        wood: {
          color: theme.id === 'blueprint' ? '#48cae4' : '#b45309',
          roughness: 0.75,
          metalness: 0.15,
        },
        metal: {
          color: theme.id === 'daylight' ? '#475569' : '#94a3b8',
          roughness: 0.4,
          metalness: 0.7,
        },
        lamp: {
          color: theme.id === 'daylight' ? '#334155' : '#fde047',
          roughness: 0.3,
          metalness: 0.6,
        },
        stone: {
          color: theme.id === 'daylight' ? '#94a3b8' : '#38bdf8',
          roughness: 0.5,
          metalness: 0.25,
        },
      };

      furnitureByStyle.forEach((items, styleGroup) => {
        const { merged: mergedFurnGeo, faceRanges } = mergeWithFaceRanges(items, resourceManager);
        if (mergedFurnGeo) {
          resourceManager.registerGeometry(mergedFurnGeo);
          const p = stylePalette[styleGroup];
          const mat = resourceManager.registerMaterial(
            new THREE.MeshStandardMaterial({
              color: p.color,
              roughness: p.roughness,
              metalness: p.metalness,
            })
          );
          furnitureMaterials.set(styleGroup, mat);

          const furnMesh = new THREE.Mesh(mergedFurnGeo, mat);
          furnMesh.name = `StreetFurniture_${styleGroup}`;
          furnMesh.castShadow = true;
          furnMesh.receiveShadow = true;
          furnMesh.userData = { faceRanges };
          foliageGroup.add(furnMesh);
          drawCalls++;

          totalVertices += mergedFurnGeo.attributes.position.count;
          totalTriangles += getTriangleCount(mergedFurnGeo);
        }
      });
    }

    // ==========================================================================
    // 9. BUILDINGS (3D Extrusions with Archetype Sub-Palettes & Full OSM Tags)
    // ==========================================================================
    const interactiveBuildings: THREE.Mesh[] = [];

    const wallMat = resourceManager.registerMaterial(
      new THREE.MeshStandardMaterial({
        color: theme.buildingWallColor,
        roughness: 0.65,
        metalness: 0.15,
      })
    );

    const roofMat = resourceManager.registerMaterial(
      new THREE.MeshStandardMaterial({
        color: theme.buildingRoofColor,
        roughness: 0.4,
        metalness: 0.25,
      })
    );

    const landmarkWallMat = resourceManager.registerMaterial(
      new THREE.MeshStandardMaterial({
        color: theme.id === 'tactical' ? '#f59e0b' : '#fef08a',
        roughness: 0.5,
        metalness: 0.3,
      })
    );

    const archetypeMaterials = new Map<
      string,
      { wall: THREE.MeshStandardMaterial; roof: THREE.MeshStandardMaterial }
    >();
    if (theme.buildingArchetypeColors) {
      for (const [archKey, colors] of Object.entries(theme.buildingArchetypeColors)) {
        archetypeMaterials.set(archKey, {
          wall: resourceManager.registerMaterial(
            new THREE.MeshStandardMaterial({
              color: colors.wall,
              roughness: 0.58,
              metalness: 0.2,
            })
          ),
          roof: resourceManager.registerMaterial(
            new THREE.MeshStandardMaterial({
              color: colors.roof,
              roughness: 0.38,
              metalness: 0.28,
            })
          ),
        });
      }
    }

    const buildingsByBucket = new Map<
      string,
      {
        materials: THREE.MeshStandardMaterial[];
        items: Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }>;
      }
    >();

    for (const bldg of data.buildings) {
      try {
        const shape = createShapeFromRings(bldg.footprint);
        if (!shape) continue;

        const effectiveHeight =
          Math.max(bldg.height, 2.5) * this.options.buildingHeightMultiplier;
        const explicitMinH = (bldg.minHeight || 0) * this.options.buildingHeightMultiplier;

        const isRoofStructure = Boolean(
          bldg.isRoofOnly ||
            bldg.buildingType === 'roof' ||
            bldg.buildingType === 'carport' ||
            bldg.buildingType === 'canopy' ||
            bldg.buildingType === 'grandstand' ||
            bldg.buildingType === 'shelter'
        );

        let geom: THREE.BufferGeometry;
        if (isRoofStructure) {
          geom = resourceManager.registerGeometry(
            generateOpenAirRoofWithPillars(
              shape,
              bldg.footprint[0],
              effectiveHeight,
              explicitMinH,
              this.options.bevelEnabled
            )
          );
        } else {
          const extrudeSettings: THREE.ExtrudeGeometryOptions = {
            depth: Math.max(effectiveHeight - explicitMinH, 1.5),
            bevelEnabled: this.options.bevelEnabled,
            bevelSegments: 1,
            steps: 1,
            bevelSize: 0.1,
            bevelThickness: 0.1,
          };

          geom = resourceManager.registerGeometry(
            new THREE.ExtrudeGeometry(shape, extrudeSettings)
          );
          geom.rotateX(-Math.PI / 2);
          if (explicitMinH > 0) {
            geom.translate(0, explicitMinH, 0);
          }
        }

        const arch = bldg.buildingArchetype;
        const archMat = arch ? archetypeMaterials.get(arch) : undefined;

        const isLandmark = Boolean(
          bldg.amenity ||
            bldg.buildingType === 'cathedral' ||
            bldg.buildingType === 'hospital' ||
            bldg.buildingType === 'train_station'
        );

        const bucketKey = archMat
          ? `arch_${arch}`
          : isLandmark
            ? 'landmark'
            : 'default';

        const materials = archMat
          ? [archMat.roof, archMat.wall]
          : [roofMat, isLandmark ? landmarkWallMat : wallMat];

        const buildingInfo: InspectableFeatureInfo = {
          id: bldg.id,
          sourceFeatureId: bldg.sourceFeatureId || bldg.id,
          name: bldg.name || bldg.cartoLabel || 'Building',
          category: 'Building',
          cartoLabel: bldg.cartoLabel || `Building (${bldg.buildingType})`,
          primaryTag: bldg.primaryTag || `building=${bldg.buildingType}`,
          subtype: bldg.buildingType,
          type: bldg.buildingType,
          amenity: bldg.amenity,
          height: Number(effectiveHeight.toFixed(1)),
          heightFormatted: `${effectiveHeight.toFixed(1)}m`,
          levels: bldg.levels || Math.round(effectiveHeight / 3.2),
          osmTags: sanitizeOsmTags(bldg.osmTags),
        };

        if (!buildingsByBucket.has(bucketKey)) {
          buildingsByBucket.set(bucketKey, { materials, items: [] });
        }
        buildingsByBucket.get(bucketKey)!.items.push({ geom, info: buildingInfo });

        if (bldg.sourceFeatureId) renderedSourceIds.add(bldg.sourceFeatureId);
      } catch (err) {
        console.warn(`Skipping invalid building feature ${bldg.id}`, err);
      }
    }

    buildingsByBucket.forEach(({ materials, items }, bucketKey) => {
      const { merged: mergedBldgGeo, faceRanges } = mergeWithFaceRanges(items, resourceManager);
      if (mergedBldgGeo) {
        resourceManager.registerGeometry(mergedBldgGeo);
        const mesh = new THREE.Mesh(mergedBldgGeo, materials);
        mesh.name = `Buildings_${bucketKey}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData =
          items.length === 1
            ? { ...items[0].info, faceRanges }
            : { faceRanges };

        buildingsGroup.add(mesh);
        interactiveBuildings.push(mesh);
        drawCalls++;

        totalVertices += mergedBldgGeo.attributes.position.count;
        totalTriangles += getTriangleCount(mergedBldgGeo);
      }
    });

    if (data.diagnostics) {
      data.diagnostics.sourceFeaturesRendered = renderedSourceIds.size;
      data.diagnostics.totalFeaturesRendered = renderedSourceIds.size;
      data.diagnostics.constructedMeshesCount = drawCalls;

      let bldgParts = 0;
      buildingsByBucket.forEach(({ items }) => {
        bldgParts += items.length;
      });
      let roadParts =
        bridgeSubstructureItems.length +
        bridgeParapetItems.length +
        bridgePierItems.length +
        tunnelPortalItems.length +
        tunnelMouthItems.length +
        tunnelTraceItems.length;
      roadsByClass.forEach((items) => {
        roadParts += items.length;
      });
      let railParts = 0;
      railwaysGroup.children.forEach((child) => {
        const ranges = (child as THREE.Mesh).userData?.faceRanges;
        railParts += Array.isArray(ranges) ? ranges.length : 1;
      });
      let parkParts = pitchMarkingItems.length;
      parksBySubtype.forEach((items) => {
        parkParts += items.length;
      });
      let landuseParts = parkingMarkingItems.length;
      landuseBySubtype.forEach((items) => {
        landuseParts += items.length;
      });
      let barrierParts = 0;
      barriersByType.forEach((items) => {
        barrierParts += items.length;
      });
      let waterBodyParts = 0;
      let linearWaterwayParts = 0;
      for (const wItem of waterItems) {
        if (wItem.info.primaryTag?.startsWith('waterway=')) {
          linearWaterwayParts++;
        } else {
          waterBodyParts++;
        }
      }
      const waterParts = waterItems.length;
      const landmarkParts =
        treePlacements.length + structuralLandmarks.length + streetFurnitureLandmarks.length;

      data.diagnostics.geometryPartsGenerated = {
        total:
          bldgParts +
          roadParts +
          railParts +
          waterParts +
          parkParts +
          landuseParts +
          barrierParts +
          landmarkParts,
        byCategory: {
          buildings: bldgParts,
          roads: roadParts,
          railways: railParts,
          waterBodies: waterBodyParts,
          linearWaterways: linearWaterwayParts,
          parks: parkParts,
          landuse: landuseParts,
          barriers: barrierParts,
          landmarks: landmarkParts,
        },
      };
    }

    // Safe, idempotent single-pass resource disposal
    const dispose = () => {
      const allGroups = [
        buildingsGroup,
        roadsGroup,
        railwaysGroup,
        waterGroup,
        parksGroup,
        landuseGroup,
        barriersGroup,
        foliageGroup,
      ];
      for (const group of allGroups) {
        group.clear();
      }
      infrastructureRenderPreview = null;
      builtScene.infrastructureRenderPreview = null;
      resourceManager.dispose();
    };

    // Fast in-place theme update (no vertex buffer regeneration)
    const updateTheme = (newTheme: MapStyleTheme) => {
      groundMat.color.set(newTheme.groundColor);
      if (waterMat) waterMat.color.set(newTheme.waterColor);
      railwayInfrastructureResult?.updateTheme(newTheme);

      parkMaterialsBySubtype.forEach((mat, subtype) => {
        mat.color.set(newTheme.terrainColors?.[subtype] || newTheme.parkColor);
      });

      roadMaterialsByClass.forEach((mat, cls) => {
        mat.color.set(newTheme.roadColors[cls] || '#64748b');
      });

      if (bridgeStructureMat) {
        bridgeStructureMat.color.set(
          newTheme.id === 'daylight' ? '#64748b' : newTheme.id === 'blueprint' ? '#0077b6' : '#334155'
        );
      }
      if (bridgeParapetMat) {
        bridgeParapetMat.color.set(
          newTheme.id === 'daylight' ? '#94a3b8' : newTheme.id === 'blueprint' ? '#48cae4' : '#64748b'
        );
      }
      if (tunnelPortalMat) {
        tunnelPortalMat.color.set(
          newTheme.id === 'daylight' ? '#94a3b8' : newTheme.id === 'blueprint' ? '#0096c7' : '#475569'
        );
      }
      if (tunnelTraceMat) {
        tunnelTraceMat.color.set(
          newTheme.id === 'daylight' ? '#475569' : newTheme.id === 'blueprint' ? '#00b4d8' : '#38bdf8'
        );
      }

      landuseMaterialsBySubtype.forEach((mat, subtype) => {
        mat.color.set(
          newTheme.landuseColors[subtype] || newTheme.landuseColors.landuse || '#0f172a'
        );
      });

      barrierMaterialsByType.forEach((mat, bKey) => {
        const col =
          (newTheme.barrierColors as any)?.[bKey] ||
          (bKey === 'hedge' ? '#15803d' : '#64748b');
        mat.color.set(col);
      });

      if (trunkMat) trunkMat.color.set(newTheme.foliageColors?.trunk || '#451a03');
      if (broadleafMat) broadleafMat.color.set(newTheme.foliageColors?.broadleaved || '#16a34a');
      if (needleleafMat) needleleafMat.color.set(newTheme.foliageColors?.needleleaved || '#15803d');
      if (landmarkPointMat) {
        landmarkPointMat.color.set(newTheme.id === 'tactical' ? '#38bdf8' : '#f59e0b');
      }
      if (parkingMarkingMat) {
        parkingMarkingMat.color.set(
          newTheme.id === 'daylight'
            ? '#f8fafc'
            : newTheme.id === 'blueprint'
              ? '#48cae4'
              : '#94a3b8'
        );
      }
      if (pitchMarkingMat) {
        pitchMarkingMat.color.set(newTheme.id === 'blueprint' ? '#90e0ef' : '#e2e8f0');
      }
      furnitureMaterials.forEach((mat, styleGroup) => {
        if (styleGroup === 'wood') {
          mat.color.set(newTheme.id === 'blueprint' ? '#48cae4' : '#b45309');
        } else if (styleGroup === 'metal') {
          mat.color.set(newTheme.id === 'daylight' ? '#475569' : '#94a3b8');
        } else if (styleGroup === 'lamp') {
          mat.color.set(newTheme.id === 'daylight' ? '#334155' : '#fde047');
        } else if (styleGroup === 'stone') {
          mat.color.set(newTheme.id === 'daylight' ? '#94a3b8' : '#38bdf8');
        }
      });

      wallMat.color.set(newTheme.buildingWallColor);
      roofMat.color.set(newTheme.buildingRoofColor);
      landmarkWallMat.color.set(newTheme.id === 'tactical' ? '#f59e0b' : '#fef08a');

      if (newTheme.buildingArchetypeColors) {
        archetypeMaterials.forEach((mats, archKey) => {
          const c = (newTheme.buildingArchetypeColors as any)[archKey];
          if (c) {
            mats.wall.color.set(c.wall);
            mats.roof.color.set(c.roof);
          }
        });
      }
    };

    const updateCameraZoom = (zoom: number) => {
      railwayInfrastructureResult?.updateCameraZoom(zoom);
    };

    const builtScene: BuiltSceneGeometry = {
      buildingsGroup,
      roadsGroup,
      railwaysGroup,
      waterGroup,
      parksGroup,
      landuseGroup,
      barriersGroup,
      foliageGroup,
      groundMesh,
      interactiveMeshes: {
        buildings: interactiveBuildings,
      },
      stats: {
        totalVertices,
        totalTriangles: Math.round(totalTriangles),
        totalDrawCalls: drawCalls,
        renderedFeaturesCount: renderedSourceIds.size,
        forestTreesCount: treePlacements.length,
      },
      resources: resourceManager,
      infrastructureRenderOptions,
      infrastructureRenderPreview,
      dispose,
      updateTheme,
      updateCameraZoom,
    };

    return builtScene;
  }
}
