import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  InspectableFeatureInfo,
  MapFeatureDiagnostics,
  MapStyleTheme,
  ProcessedMapData,
  RailwayFeature,
} from '../../../types/MapFeature';
import {
  DEPTH_OFFSET_CONFIG,
  ELEVATION_POLICY,
  getRailwayElevations,
} from '../../ElevationPolicy';
import {
  buildBridgeProfile3D,
  generateBridgeStructureGeometries,
  generateTunnelPortalAndTraceGeometries,
  ProfiledPoint3D,
} from '../../BridgeAndTunnelBuilder';
import { SceneResourceManager } from '../../SceneResourceManager';
import {
  buildUvRibbonGeometry3D,
  subdivideSharpPolylineCorners2D,
} from '../rendering/UvRibbonBuilder';
import {
  configureProceduralRailMaterial,
  configureProceduralSleeperMaterial,
  ProceduralRailwayMaterialControl,
} from '../rendering/InfrastructureShaderChunks';
import {
  adaptRailwayEdgeDescriptorsToFeatures,
  InfrastructureRenderDescriptorBundle,
  prepareInfrastructureRenderPreview,
  RailwayInfrastructureRenderSource,
} from '../rendering/InfrastructureRenderAdapter';
import {
  computeContinuousTrackPhases,
  HostTrackSpatialIndex,
  isTurnoutThroatPair,
  RAILWAY_DIMENSION_SPEC,
  SleeperBearerBox3D,
  sortRailwaysMainlineFirst,
  subtractIntervalFromList,
  subtractLateralInterval,
} from './RailwayTopology';

export type RailwayPrototypeMode = 'disabled' | 'production' | 'candidateA' | 'candidateB';

export interface BuildRailwayPrototypeOptions {
  /** Enable 8m × 8m uniform spatial grid index for host track queries (default true) */
  useSpatialGridIndex?: boolean;
  /** Use adaptive bridge deck sampling instead of uniform dense sampling (default true) */
  adaptiveBridgeSampling?: boolean;
  /** Preserve both remaining outer segments when an interior cut splits a sleeper (default true) */
  multiIntervalClip?: boolean;
  /** Represent close-zoom 3D sleepers via InstancedMesh or merged BufferGeometry */
  sleeper3DMode?: 'merged' | 'instanced';
  /** Static spatial chunk size in meters for frustum culling and raycast culling (0 disables chunking) */
  spatialChunkSizeMeters?: number;
  /** Close-zoom 3D sleeper period in meters (default 0.725m half-harmonic) */
  closeZoomSleeperPeriodMeters?: number;
  /** Optional shared SceneResourceManager (used when integrated into GeometryBuilder) */
  resourceManager?: SceneResourceManager;
  /** Optional existing THREE.Group to populate directly (used when integrated into GeometryBuilder) */
  targetGroup?: THREE.Group;
  /** Railway render source mode ('legacy' | 'graph-preview' | 'graph'). Defaults to 'legacy'. */
  renderSource?: RailwayInfrastructureRenderSource;
  /** Optional pre-built descriptor bundle when available from infrastructureRenderPreview */
  descriptors?: InfrastructureRenderDescriptorBundle | null;
  /** Optional diagnostics container to record fallback events */
  diagnostics?: MapFeatureDiagnostics;
}

export interface RailwayBuildProfile {
  totalBuildTimeMs: number;
  phaseAndSortTimeMs: number;
  bridgeAndTunnelTimeMs: number;
  uvRibbonAndSwitchTimeMs: number;
  sleeper3DPlacementTimeMs: number;
  rail3DExtrusionTimeMs: number;
  geometryMergeAndChunkTimeMs: number;
  spatialIndexStats: {
    useSpatialGrid: boolean;
    registeredSegmentsCount: number;
    gridCellsCount: number;
    totalQueries: number;
    totalSegmentsExamined: number;
    avgSegmentsPerQuery: number;
    maxSegmentsInSingleQuery: number;
    totalDistanceCalculations: number;
    queryTimeMs: number;
  };
  sleeperOverlapStats: {
    multiIntervalClipEnabled: boolean;
    proposedSleeperStations: number;
    existingCandidatesChecked: number;
    minkowskiOverlapCalculations: number;
    sharedTurnoutBearersCount: number;
    clippedOrShortenedSleepersCount: number;
    splitIntoTwoSegmentsStationsCount: number;
    discardedSleepersCount: number;
    emittedSleeperBoxesCount: number;
    overlapResolutionTimeMs: number;
  };
  bakedAssetStats: {
    sleeper3DMode: 'merged' | 'instanced';
    spatialChunkSizeMeters: number;
    spatialChunkCount: number;
    estimatedBakedBinaryBytes: number;
    estimatedBakedBinaryMB: number;
  };
}

export interface RailwayPrototypeStats {
  mode: 'candidateA' | 'candidateB';
  buildTimeMs: number;
  totalVertices: number;
  totalTriangles: number;
  renderedVerticesWithInstances: number;
  renderedTrianglesWithInstances: number;
  drawCalls: number;
  cpuBufferBytes: number;
  cpuBufferMB: number;
  renderedRailwaysCount: number;
  closeZoomSleeperPeriodMeters: number;
  sleeper3DBoxCount: number;
  turnoutBearerCount: number;
  splitMultiSegmentStationsCount: number;
  sleeper3DMode: 'merged' | 'instanced';
  spatialChunkSizeMeters: number;
  spatialChunkCount: number;
  /** Active railway infrastructure render source mode (Stage E3-A1) */
  railwayRenderSource?: RailwayInfrastructureRenderSource;
  /** True if graph mode fell back to legacy */
  graphFallbackOccurred?: boolean;
  /** Explanation for fallback event */
  graphFallbackReason?: string;
  /** Number of simplified railway edges in graph mode */
  graphEdgeCount?: number;
  /** Total raw source railway feature count in mapData.railways */
  sourceRailwayCount?: number;
}

export interface RailwayPrototypeResult {
  railwaysGroup: THREE.Group;
  resources: SceneResourceManager;
  sleeperBoxes3D: SleeperBearerBox3D[];
  renderedSourceIds: Set<string>;
  profile: RailwayBuildProfile;
  stats: RailwayPrototypeStats;
  updateTheme: (newTheme: MapStyleTheme) => void;
  updateCameraZoom: (zoom: number) => void;
  dispose: () => void;
}

interface ChunkedGeoItem {
  geom: THREE.BufferGeometry;
  info: InspectableFeatureInfo;
  chunkKey: string;
}

interface FaceRangeEntry {
  startFace: number;
  endFace: number;
  info: InspectableFeatureInfo;
}

function getTriangleCount(geo: THREE.BufferGeometry): number {
  return geo.index ? geo.index.count / 3 : (geo.attributes.position?.count || 0) / 3;
}

function mergeItemsWithFaceRanges(
  items: Array<{ geom: THREE.BufferGeometry; info: InspectableFeatureInfo }>,
  resourceManager: SceneResourceManager
): { merged: THREE.BufferGeometry | null; faceRanges: FaceRangeEntry[] } {
  if (items.length === 0) return { merged: null, faceRanges: [] };
  const geos: THREE.BufferGeometry[] = [];
  const faceRanges: FaceRangeEntry[] = [];
  let currentFace = 0;

  for (const item of items) {
    const triCount = Math.round(getTriangleCount(item.geom));
    if (triCount <= 0) continue;
    geos.push(item.geom);
    faceRanges.push({
      startFace: currentFace,
      endFace: currentFace + triCount,
      info: item.info,
    });
    currentFace += triCount;
  }

  if (geos.length === 0) return { merged: null, faceRanges: [] };
  const merged = mergeGeometries(geos, false);
  for (const g of geos) {
    resourceManager.releaseIntermediateGeometry(g);
  }
  if (merged) {
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
  }
  return { merged, faceRanges };
}

/**
 * Builds a merged 5-face (top + 4 sides, no bottom) 3D BufferGeometry for a list of sleeper/bearer boxes.
 */
export function buildMergedSleeperBoxes3DGeometry(
  boxes: SleeperBearerBox3D[]
): THREE.BufferGeometry | null {
  if (boxes.length === 0) return null;
  const positions = new Float32Array(boxes.length * 20 * 3);
  const normals = new Float32Array(boxes.length * 20 * 3);
  const indices = new Uint32Array(boxes.length * 30);

  let vOffset = 0;
  let iOffset = 0;

  const pushQuad = (
    p0: [number, number, number],
    p1: [number, number, number],
    p2: [number, number, number],
    p3: [number, number, number],
    norm: [number, number, number]
  ) => {
    const base = vOffset;
    const pts = [p0, p1, p2, p3];
    for (let k = 0; k < 4; k++) {
      positions[(base + k) * 3] = pts[k][0];
      positions[(base + k) * 3 + 1] = pts[k][1];
      positions[(base + k) * 3 + 2] = pts[k][2];
      normals[(base + k) * 3] = norm[0];
      normals[(base + k) * 3 + 1] = norm[1];
      normals[(base + k) * 3 + 2] = norm[2];
    }
    indices[iOffset++] = base;
    indices[iOffset++] = base + 1;
    indices[iOffset++] = base + 2;
    indices[iOffset++] = base;
    indices[iOffset++] = base + 2;
    indices[iOffset++] = base + 3;
    vOffset += 4;
  };

  for (const b of boxes) {
    const fx = b.tx * b.halfLen;
    const fz = b.tz * b.halfLen;
    const lx = b.nx * b.halfWidthLeft;
    const lz = b.nz * b.halfWidthLeft;
    const rx = -b.nx * b.halfWidthRight;
    const rz = -b.nz * b.halfWidthRight;

    const t0: [number, number, number] = [b.cx - fx + lx, b.yTop, b.cz - fz + lz];
    const t1: [number, number, number] = [b.cx + fx + lx, b.yTop, b.cz + fz + lz];
    const t2: [number, number, number] = [b.cx + fx + rx, b.yTop, b.cz + fz + rz];
    const t3: [number, number, number] = [b.cx - fx + rx, b.yTop, b.cz - fz + rz];

    const b0: [number, number, number] = [t0[0], b.yBottom, t0[2]];
    const b1: [number, number, number] = [t1[0], b.yBottom, t1[2]];
    const b2: [number, number, number] = [t2[0], b.yBottom, t2[2]];
    const b3: [number, number, number] = [t3[0], b.yBottom, t3[2]];

    pushQuad(t0, t1, t2, t3, [0, 1, 0]);
    pushQuad(b1, b2, t2, t1, [b.tx, 0, b.tz]);
    pushQuad(b3, b0, t0, t3, [-b.tx, 0, -b.tz]);
    pushQuad(b0, b1, t1, t0, [b.nx, 0, b.nz]);
    pushQuad(b2, b3, t3, t2, [-b.nx, 0, -b.nz]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

/**
 * Builds the canonical unit 5-face sleeper box (`20` vertices, `10` triangles) used by `THREE.InstancedMesh`.
 */
export function buildUnitSleeperBoxGeometry(): THREE.BufferGeometry {
  return buildMergedSleeperBoxes3DGeometry([
    {
      cx: 0,
      cz: 0,
      yBottom: 0,
      yTop: 1,
      tx: 0,
      tz: -1,
      nx: 1,
      nz: 0,
      halfLen: 0.5,
      halfWidthLeft: 0.5,
      halfWidthRight: 0.5,
      trackId: 'unit',
    },
  ])!;
}

function buildInstancedSleepersMesh(
  items: Array<{ box: SleeperBearerBox3D; info: InspectableFeatureInfo }>,
  unitGeo: THREE.BufferGeometry,
  material: THREE.Material,
  meshName: string
): { instancedMesh: THREE.InstancedMesh; matrixBytes: number } {
  const count = items.length;
  const instancedMesh = new THREE.InstancedMesh(unitGeo, material, count);
  instancedMesh.name = meshName;
  instancedMesh.castShadow = false;
  instancedMesh.receiveShadow = true;
  instancedMesh.renderOrder = 15;
  instancedMesh.frustumCulled = true;

  const instanceInfos: InspectableFeatureInfo[] = new Array(count);
  const mat4 = new THREE.Matrix4();
  const te = mat4.elements;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < count; i++) {
    const { box, info } = items[i];
    instanceInfos[i] = info;

    const totalWidth = box.halfWidthLeft + box.halfWidthRight;
    const midOffset = (box.halfWidthLeft - box.halfWidthRight) * 0.5;
    const height = box.yTop - box.yBottom;
    const length = box.halfLen * 2;
    const cx = box.cx + box.nx * midOffset;
    const cy = box.yBottom;
    const cz = box.cz + box.nz * midOffset;

    te[0] = box.nx * totalWidth;
    te[1] = 0;
    te[2] = box.nz * totalWidth;
    te[3] = 0;
    te[4] = 0;
    te[5] = height;
    te[6] = 0;
    te[7] = 0;
    te[8] = -box.tx * length;
    te[9] = 0;
    te[10] = -box.tz * length;
    te[11] = 0;
    te[12] = cx;
    te[13] = cy;
    te[14] = cz;
    te[15] = 1;

    instancedMesh.setMatrixAt(i, mat4);

    const r = Math.hypot(totalWidth * 0.5, box.halfLen);
    if (cx - r < minX) minX = cx - r;
    if (cx + r > maxX) maxX = cx + r;
    if (box.yBottom < minY) minY = box.yBottom;
    if (box.yTop > maxY) maxY = box.yTop;
    if (cz - r < minZ) minZ = cz - r;
    if (cz + r > maxZ) maxZ = cz + r;
  }

  instancedMesh.instanceMatrix.needsUpdate = true;
  const bbox = new THREE.Box3(
    new THREE.Vector3(minX, minY, minZ),
    new THREE.Vector3(maxX, maxY, maxZ)
  );
  instancedMesh.boundingBox = bbox;
  instancedMesh.boundingSphere = bbox.getBoundingSphere(new THREE.Sphere());
  instancedMesh.userData = {
    isInstanced: true,
    isStructural3D: true,
    instanceInfos,
  };

  return {
    instancedMesh,
    matrixBytes: instancedMesh.instanceMatrix.array.byteLength,
  };
}

/**
 * Builds a 3-face (top + left + right) extruded 3D rail geometry with optional switch-blade taper.
 */
export function buildExtrudedRail3DGeometry(
  profile: ProfiledPoint3D[],
  lateralCenterOffset: number,
  railWidth: number,
  railHeight: number,
  evaluateBladeTaper?: (x: number, z: number, arcS: number, totalLength: number) => number
): THREE.BufferGeometry | null {
  if (!profile || profile.length < 2) return null;
  const n = profile.length;
  const totalLength = profile[n - 1].arcLength - profile[0].arcLength;
  if (totalLength < 0.001) return null;

  const segTangents: [number, number][] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = profile[i + 1].x - profile[i].x;
    const dz = profile[i + 1].z - profile[i].z;
    const len = Math.hypot(dx, dz) || 1e-6;
    segTangents.push([dx / len, dz / len]);
  }

  const positions = new Float32Array(n * 6 * 3);
  const normals = new Float32Array(n * 6 * 3);
  const indices = new Uint32Array((n - 1) * 18);

  for (let i = 0; i < n; i++) {
    let tx = 0;
    let tz = 0;
    if (i === 0) {
      [tx, tz] = segTangents[0];
    } else if (i === n - 1) {
      [tx, tz] = segTangents[n - 2];
    } else {
      tx = segTangents[i - 1][0] + segTangents[i][0];
      tz = segTangents[i - 1][1] + segTangents[i][1];
      const len = Math.hypot(tx, tz) || 1e-6;
      tx /= len;
      tz /= len;
    }

    const nx = -tz;
    const nz = tx;
    const pt = profile[i];
    const arcS = pt.arcLength - profile[0].arcLength;
    const taper = evaluateBladeTaper ? evaluateBladeTaper(pt.x, pt.z, arcS, totalLength) : 1;
    const halfW = railWidth * 0.5 * taper;

    const cx = pt.x + nx * lateralCenterOffset;
    const cz = pt.z + nz * lateralCenterOffset;
    const lx = cx + nx * halfW;
    const lz = cz + nz * halfW;
    const rx = cx - nx * halfW;
    const rz = cz - nz * halfW;
    const yTop = pt.y + railHeight * 0.5;
    const yBot = pt.y - railHeight * 0.5;

    const base = i * 6;
    positions[(base + 0) * 3] = lx;
    positions[(base + 0) * 3 + 1] = yTop;
    positions[(base + 0) * 3 + 2] = lz;
    normals[(base + 0) * 3] = 0;
    normals[(base + 0) * 3 + 1] = 1;
    normals[(base + 0) * 3 + 2] = 0;

    positions[(base + 1) * 3] = rx;
    positions[(base + 1) * 3 + 1] = yTop;
    positions[(base + 1) * 3 + 2] = rz;
    normals[(base + 1) * 3] = 0;
    normals[(base + 1) * 3 + 1] = 1;
    normals[(base + 1) * 3 + 2] = 0;

    positions[(base + 2) * 3] = lx;
    positions[(base + 2) * 3 + 1] = yTop;
    positions[(base + 2) * 3 + 2] = lz;
    normals[(base + 2) * 3] = nx;
    normals[(base + 2) * 3 + 1] = 0.25;
    normals[(base + 2) * 3 + 2] = nz;

    positions[(base + 3) * 3] = lx;
    positions[(base + 3) * 3 + 1] = yBot;
    positions[(base + 3) * 3 + 2] = lz;
    normals[(base + 3) * 3] = nx;
    normals[(base + 3) * 3 + 1] = 0.25;
    normals[(base + 3) * 3 + 2] = nz;

    positions[(base + 4) * 3] = rx;
    positions[(base + 4) * 3 + 1] = yTop;
    positions[(base + 4) * 3 + 2] = rz;
    normals[(base + 4) * 3] = -nx;
    normals[(base + 4) * 3 + 1] = 0.25;
    normals[(base + 4) * 3 + 2] = -nz;

    positions[(base + 5) * 3] = rx;
    positions[(base + 5) * 3 + 1] = yBot;
    positions[(base + 5) * 3 + 2] = rz;
    normals[(base + 5) * 3] = -nx;
    normals[(base + 5) * 3 + 1] = 0.25;
    normals[(base + 5) * 3 + 2] = -nz;
  }

  for (let i = 0; i < n - 1; i++) {
    const b0 = i * 6;
    const b1 = (i + 1) * 6;
    const idx = i * 18;
    indices[idx + 0] = b0 + 0;
    indices[idx + 1] = b1 + 0;
    indices[idx + 2] = b0 + 1;
    indices[idx + 3] = b0 + 1;
    indices[idx + 4] = b1 + 0;
    indices[idx + 5] = b1 + 1;

    indices[idx + 6] = b0 + 3;
    indices[idx + 7] = b1 + 3;
    indices[idx + 8] = b1 + 2;
    indices[idx + 9] = b0 + 3;
    indices[idx + 10] = b1 + 2;
    indices[idx + 11] = b0 + 2;

    indices[idx + 12] = b0 + 4;
    indices[idx + 13] = b1 + 4;
    indices[idx + 14] = b1 + 5;
    indices[idx + 15] = b0 + 4;
    indices[idx + 16] = b1 + 5;
    indices[idx + 17] = b0 + 5;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

/**
 * Core railway geometry synthesis engine supporting both the M2.1 prototype modes (`candidateA`, `candidateB`)
 * and the M2.2 production scene pipeline (`buildRailwayInfrastructure`).
 */
export function buildRailwayGroupInternal(
  data: ProcessedMapData,
  theme: MapStyleTheme,
  mode: 'candidateA' | 'candidateB',
  initialZoom: number = 1.0,
  options?: BuildRailwayPrototypeOptions
): RailwayPrototypeResult {
  const tStart = performance.now();
  const resourceManager = options?.resourceManager ?? new SceneResourceManager();
  const railwaysGroup = options?.targetGroup ?? new THREE.Group();
  if (!options?.targetGroup) {
    railwaysGroup.name = `Railways_Prototype_${mode}`;
  }

  const useSpatialGridIndex = options?.useSpatialGridIndex ?? true;
  const adaptiveBridgeSampling = options?.adaptiveBridgeSampling ?? true;
  const multiIntervalClip = options?.multiIntervalClip ?? true;
  const sleeper3DMode = options?.sleeper3DMode ?? 'merged';
  const spatialChunkSizeMeters = Math.max(0, options?.spatialChunkSizeMeters ?? 0);

  const getChunkKey = (x: number, z: number): string =>
    spatialChunkSizeMeters <= 0
      ? 'global'
      : `${Math.floor(x / spatialChunkSizeMeters)}_${Math.floor(z / spatialChunkSizeMeters)}`;

  const ballastItems: ChunkedGeoItem[] = [];
  const sleeperRibbonItems: ChunkedGeoItem[] = [];
  const railRibbonItems: ChunkedGeoItem[] = [];
  const sleeper3DMergedItems: ChunkedGeoItem[] = [];
  const sleeper3DInstancedItems: Array<{
    box: SleeperBearerBox3D;
    info: InspectableFeatureInfo;
    chunkKey: string;
  }> = [];
  const rail3DItems: ChunkedGeoItem[] = [];
  const sleeperBoxes3D: SleeperBearerBox3D[] = [];
  const renderedSourceIds = new Set<string>();

  let sharedTurnoutBearersCount = 0;
  let proposedSleeperStations = 0;
  let existingCandidatesChecked = 0;
  let minkowskiOverlapCalculations = 0;
  let clippedOrShortenedSleepersCount = 0;
  let splitIntoTwoSegmentsStationsCount = 0;
  let discardedSleepersCount = 0;
  let overlapResolutionTimeMs = 0;
  let bridgeAndTunnelTimeMs = 0;
  let uvRibbonAndSwitchTimeMs = 0;
  let sleeper3DPlacementTimeMs = 0;
  let rail3DExtrusionTimeMs = 0;

  const bridgeSubstructureItems: ChunkedGeoItem[] = [];
  const bridgeParapetItems: ChunkedGeoItem[] = [];
  const bridgePierItems: ChunkedGeoItem[] = [];
  const tunnelPortalItems: ChunkedGeoItem[] = [];
  const tunnelMouthItems: ChunkedGeoItem[] = [];
  const tunnelTraceItems: ChunkedGeoItem[] = [];

  const requestedSource: RailwayInfrastructureRenderSource =
    options?.renderSource ?? 'legacy';
  let effectiveSource: RailwayInfrastructureRenderSource = requestedSource;
  let graphFallbackOccurred = false;
  let graphFallbackReason: string | undefined;
  let activeDescriptors: InfrastructureRenderDescriptorBundle | null = options?.descriptors ?? null;
  let graphEdgeCount: number | undefined;

  let sourceFeatures: RailwayFeature[];

  if (requestedSource === 'graph') {
    if (!activeDescriptors && options?.descriptors === undefined) {
      const preview = prepareInfrastructureRenderPreview(data, { railways: 'graph' });
      activeDescriptors = preview.descriptors;
    }

    if (activeDescriptors?.railwayEdges && activeDescriptors.railwayEdges.length > 0) {
      graphEdgeCount = activeDescriptors.railwayEdges.length;
      sourceFeatures = adaptRailwayEdgeDescriptorsToFeatures(activeDescriptors.railwayEdges);
    } else {
      // Graceful fallback to legacy
      effectiveSource = 'legacy';
      graphFallbackOccurred = true;
      graphFallbackReason = 'missing_or_empty_descriptors';
      sourceFeatures = data.railways || [];
      if (options?.diagnostics) {
        options.diagnostics.railwayRendererFallback = 'legacy_due_to_missing_descriptors';
      }
    }
  } else {
    sourceFeatures = data.railways || [];
  }

  const tPhase0 = performance.now();
  const activeRailways = sortRailwaysMainlineFirst(sourceFeatures);
  const trackPhaseMap = computeContinuousTrackPhases(activeRailways);

  const hostIndexByScope = new Map<string, HostTrackSpatialIndex>();
  const allTracksIndexByScope = new Map<string, HostTrackSpatialIndex>();
  const subdividedPtsByScope = new Map<string, Map<string, [number, number][]>>();
  const sleeperGridByScope = new Map<string, Map<string, SleeperBearerBox3D[]>>();

  const atGradeRailEndpoints: [number, number][] = [];
  const bridgeRailEndpoints: Array<{ id: string; pt: [number, number] }> = [];

  for (const r of activeRailways) {
    if (!r.points || r.points.length < 2) continue;
    if (!r.isTunnel && r.layer === 0 && !r.isBridge) {
      atGradeRailEndpoints.push(r.points[0], r.points[r.points.length - 1]);
    } else if (!r.isTunnel && (r.isBridge || r.layer > 0)) {
      bridgeRailEndpoints.push(
        { id: r.id, pt: r.points[0] },
        { id: r.id, pt: r.points[r.points.length - 1] }
      );
    }
  }

  for (const r of activeRailways) {
    if (!r.points || r.points.length < 2 || r.isTunnel || r.layer < 0) continue;
    const isTram = r.railwayType === 'tram';
    const gaugeOffsetHalf =
      (isTram
        ? RAILWAY_DIMENSION_SPEC.visualTramCenterToCenterGaugeMeters
        : RAILWAY_DIMENSION_SPEC.visualCenterToCenterGaugeMeters) * 0.5;
    const isBridge = Boolean(r.isBridge || r.layer > 0);
    const scope = `${r.layer}|${isBridge}|${isTram ? 'tram' : 'rail'}`;

    let allIdx = allTracksIndexByScope.get(scope);
    if (!allIdx) {
      allIdx = new HostTrackSpatialIndex(useSpatialGridIndex);
      allTracksIndexByScope.set(scope, allIdx);
    }
    let ptsMap = subdividedPtsByScope.get(scope);
    if (!ptsMap) {
      ptsMap = new Map<string, [number, number][]>();
      subdividedPtsByScope.set(scope, ptsMap);
    }

    const cleanPts: [number, number][] = [];
    for (const pt of r.points) {
      if (
        cleanPts.length === 0 ||
        Math.hypot(pt[0] - cleanPts[cleanPts.length - 1][0], pt[1] - cleanPts[cleanPts.length - 1][1]) >
          0.02
      ) {
        cleanPts.push(pt);
      }
    }
    if (cleanPts.length >= 2) {
      const subdiv = subdivideSharpPolylineCorners2D(cleanPts);
      if (subdiv.length >= 2) {
        allIdx.registerTrack(subdiv, gaugeOffsetHalf, r.id);
        ptsMap.set(r.id, subdiv);
      }
    }
  }

  const phaseAndSortTimeMs = performance.now() - tPhase0;
  let renderedRailwaysCount = 0;
  const closeZoomSleeperPeriodMeters =
    options?.closeZoomSleeperPeriodMeters ?? RAILWAY_DIMENSION_SPEC.candidateBCloseSleeperPeriodMeters;

  for (const r of activeRailways) {
    if (!r.points || r.points.length < 2) continue;

    const sids =
      r.sourceFeatureIds && r.sourceFeatureIds.length > 0
        ? r.sourceFeatureIds
        : r.sourceFeatureId
          ? [r.sourceFeatureId]
          : [r.id];
    const midPt = r.points[Math.floor(r.points.length / 2)];
    const chunkKey = getChunkKey(midPt[0], midPt[1]);
    const elevs = getRailwayElevations(r.layer, r.isBridge, r.isTunnel);

    const railInfo: InspectableFeatureInfo = {
      id: r.id,
      sourceFeatureId: sids[0],
      sourceFeatureIds: sids,
      name: r.name || r.cartoLabel || `Railway (${r.railwayType})`,
      category: 'Railway & Aerial',
      cartoLabel: r.cartoLabel || `Railway (${r.railwayType})`,
      primaryTag: r.primaryTag || `railway=${r.railwayType}`,
      subtype: r.railwayType,
      width: r.width,
      elevation: elevs.ballast,
      layer: r.layer,
      isBridge: r.isBridge,
      isTunnel: r.isTunnel,
      osmTags: (r.osmTags || {}) as Record<string, string | number | boolean>,
    };

    if (r.isTunnel || r.layer < 0) {
      const tTun0 = performance.now();
      const { portalStructureGeo, portalMouthGeo, undergroundTraceGeo } =
        generateTunnelPortalAndTraceGeometries(r.points, r.width || 4.8, false);
      if (portalStructureGeo) {
        resourceManager.registerGeometry(portalStructureGeo);
        tunnelPortalItems.push({ geom: portalStructureGeo, info: railInfo, chunkKey });
      }
      if (portalMouthGeo) {
        resourceManager.registerGeometry(portalMouthGeo);
        tunnelMouthItems.push({ geom: portalMouthGeo, info: railInfo, chunkKey });
      }
      if (undergroundTraceGeo) {
        resourceManager.registerGeometry(undergroundTraceGeo);
        tunnelTraceItems.push({ geom: undergroundTraceGeo, info: railInfo, chunkKey });
      }
      bridgeAndTunnelTimeMs += performance.now() - tTun0;
      renderedRailwaysCount++;
      for (const sid of sids) renderedSourceIds.add(sid);
      continue;
    }

    const cleanPts: [number, number][] = [];
    for (const pt of r.points) {
      if (
        cleanPts.length === 0 ||
        Math.hypot(pt[0] - cleanPts[cleanPts.length - 1][0], pt[1] - cleanPts[cleanPts.length - 1][1]) >
          0.02
      ) {
        cleanPts.push(pt);
      }
    }
    if (cleanPts.length < 2) continue;

    const isTram = r.railwayType === 'tram';
    const ballastWidth = isTram
      ? RAILWAY_DIMENSION_SPEC.tramBallastWidthMeters
      : RAILWAY_DIMENSION_SPEC.ballastWidthMeters;
    const sleeperWidth = isTram
      ? RAILWAY_DIMENSION_SPEC.tramSleeperWidthMeters
      : RAILWAY_DIMENSION_SPEC.sleeperWidthMeters;
    const railWidth = isTram
      ? RAILWAY_DIMENSION_SPEC.visualTramRailWidthMeters
      : RAILWAY_DIMENSION_SPEC.visualRailWidthMeters;
    const gaugeOffsetHalf =
      (isTram
        ? RAILWAY_DIMENSION_SPEC.visualTramCenterToCenterGaugeMeters
        : RAILWAY_DIMENSION_SPEC.visualCenterToCenterGaugeMeters) * 0.5;
    const isBridge = Boolean(r.isBridge || r.layer > 0);
    const scope = `${r.layer}|${isBridge}|${isTram ? 'tram' : 'rail'}`;

    let hostIndex = hostIndexByScope.get(scope);
    if (!hostIndex) {
      hostIndex = new HostTrackSpatialIndex(useSpatialGridIndex);
      hostIndexByScope.set(scope, hostIndex);
    }
    let scopeSleeperGrid = sleeperGridByScope.get(scope);
    if (!scopeSleeperGrid) {
      scopeSleeperGrid = new Map<string, SleeperBearerBox3D[]>();
      sleeperGridByScope.set(scope, scopeSleeperGrid);
    }
    const allTracksIndex = allTracksIndexByScope.get(scope) || hostIndex;
    const scopePtsMap = subdividedPtsByScope.get(scope);

    const subdivPts = subdivideSharpPolylineCorners2D(cleanPts);
    if (subdivPts.length < 2) continue;

    const tUv0 = performance.now();
    const densifiedPts: [number, number][] = [subdivPts[0]];
    for (let i = 0; i < subdivPts.length - 1; i++) {
      const p0 = subdivPts[i];
      const p1 = subdivPts[i + 1];
      const segLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (segLen > 2.2) {
        const d0 = hostIndex.queryMinDistanceToHostCenterline(p0[0], p0[1], r.id).minDist;
        const d1 = hostIndex.queryMinDistanceToHostCenterline(p1[0], p1[1], r.id).minDist;
        const mx = (p0[0] + p1[0]) * 0.5;
        const mz = (p0[1] + p1[1]) * 0.5;
        const dm = hostIndex.queryMinDistanceToHostCenterline(mx, mz, r.id).minDist;
        if (d0 < 3.6 || d1 < 3.6 || dm < 3.6) {
          const steps = Math.min(32, Math.ceil(segLen / 1.8));
          for (let s = 1; s < steps; s++) {
            const frac = s / steps;
            densifiedPts.push([
              p0[0] + (p1[0] - p0[0]) * frac,
              p0[1] + (p1[1] - p0[1]) * frac,
            ]);
          }
        }
      }
      densifiedPts.push(p1);
    }
    uvRibbonAndSwitchTimeMs += performance.now() - tUv0;

    let profile3D: ProfiledPoint3D[] = [];
    if (isBridge) {
      const tBr0 = performance.now();
      const pStart = densifiedPts[0];
      const pEnd = densifiedPts[densifiedPts.length - 1];
      const connectsStartAtGrade = atGradeRailEndpoints.some(
        (pt) => Math.hypot(pt[0] - pStart[0], pt[1] - pStart[1]) <= 0.8
      );
      const connectsEndAtGrade = atGradeRailEndpoints.some(
        (pt) => Math.hypot(pt[0] - pEnd[0], pt[1] - pEnd[1]) <= 0.8
      );
      const connectsStartBridge = bridgeRailEndpoints.some(
        (b) => b.id !== r.id && Math.hypot(b.pt[0] - pStart[0], b.pt[1] - pStart[1]) <= 0.8
      );
      const connectsEndBridge = bridgeRailEndpoints.some(
        (b) => b.id !== r.id && Math.hypot(b.pt[0] - pEnd[0], b.pt[1] - pEnd[1]) <= 0.8
      );

      const bridgeProf = buildBridgeProfile3D({
        points: densifiedPts,
        baseElevation: ELEVATION_POLICY.RAILWAY_BALLAST,
        targetBridgeElevation: elevs.ballast,
        connectsStartAtGrade,
        connectsEndAtGrade,
        connectsStartBridge,
        connectsEndBridge,
        maxSampleStep: 2.2,
      });

      if (bridgeProf.profile.length >= 2) {
        let prof = bridgeProf.profile;
        if (adaptiveBridgeSampling && prof.length > 2) {
          const totalArc = prof[prof.length - 1].arcLength;
          const rampStartLimit = bridgeProf.rampStartLength + 0.45;
          const rampEndLimit = totalArc - bridgeProf.rampEndLength - 0.45;
          const filtered: ProfiledPoint3D[] = [prof[0]];
          for (let i = 1; i < prof.length - 1; i++) {
            const prev = filtered[filtered.length - 1];
            const curr = prof[i];
            const next = prof[i + 1];
            if (
              (bridgeProf.rampStartLength > 0.001 && curr.arcLength <= rampStartLimit) ||
              (bridgeProf.rampEndLength > 0.001 && curr.arcLength >= rampEndLimit) ||
              Math.abs(curr.y - prev.y) > 1e-4 ||
              Math.abs(next.y - curr.y) > 1e-4
            ) {
              filtered.push(curr);
              continue;
            }
            const dx1 = curr.x - prev.x;
            const dz1 = curr.z - prev.z;
            const l1 = Math.hypot(dx1, dz1) || 1e-6;
            const dx2 = next.x - curr.x;
            const dz2 = next.z - curr.z;
            const l2 = Math.hypot(dx2, dz2) || 1e-6;
            if ((dx1 * dx2 + dz1 * dz2) / (l1 * l2) < 0.99985) {
              filtered.push(curr);
              continue;
            }
            const span = curr.arcLength - prev.arcLength;
            if (
              span >= 1.75 &&
              (hostIndex.queryMinDistanceToHostCenterline(curr.x, curr.z, r.id).minDist < 3.6 ||
                span >= 14)
            ) {
              filtered.push(curr);
            }
          }
          filtered.push(prof[prof.length - 1]);
          prof = filtered;
        }
        profile3D = prof;
        const { substructureGeo, parapetGeo, piersGeo } = generateBridgeStructureGeometries(
          prof,
          ballastWidth + 0.6,
          bridgeProf.peakElevation,
          0.38
        );
        if (substructureGeo) {
          resourceManager.registerGeometry(substructureGeo);
          bridgeSubstructureItems.push({ geom: substructureGeo, info: railInfo, chunkKey });
        }
        if (parapetGeo) {
          resourceManager.registerGeometry(parapetGeo);
          bridgeParapetItems.push({ geom: parapetGeo, info: railInfo, chunkKey });
        }
        if (piersGeo) {
          resourceManager.registerGeometry(piersGeo);
          bridgePierItems.push({ geom: piersGeo, info: railInfo, chunkKey });
        }
      }
      bridgeAndTunnelTimeMs += performance.now() - tBr0;
    }

    if (profile3D.length < 2) {
      let accumArc = 0;
      for (let i = 0; i < densifiedPts.length; i++) {
        if (i > 0) {
          accumArc += Math.hypot(
            densifiedPts[i][0] - densifiedPts[i - 1][0],
            densifiedPts[i][1] - densifiedPts[i - 1][1]
          );
        }
        profile3D.push({
          x: densifiedPts[i][0],
          y: elevs.ballast,
          z: densifiedPts[i][1],
          arcLength: accumArc,
        });
      }
    }

    const startPhaseU = trackPhaseMap.get(r.id) || 0;
    const tRib0 = performance.now();

    const ballastGeo = buildUvRibbonGeometry3D(profile3D, {
      width: ballastWidth,
      startPhaseU,
    });
    if (ballastGeo) {
      resourceManager.registerGeometry(ballastGeo);
      ballastItems.push({ geom: ballastGeo, info: railInfo, chunkKey });
    }

    const sleeperProfile3D = profile3D.map((p) => ({
      x: p.x,
      y: p.y + RAILWAY_DIMENSION_SPEC.sleeperStepHeightMeters,
      z: p.z,
      arcLength: p.arcLength,
    }));
    const currentHostIdx = hostIndex;
    const sleeperRibbonGeo = buildUvRibbonGeometry3D(sleeperProfile3D, {
      width: sleeperWidth,
      startPhaseU,
      evaluateSwitchAttributes: (vx, vz) => {
        const { minDist } = currentHostIdx.queryMinDistanceToHostCenterline(vx, vz, r.id);
        return [minDist, 1];
      },
    });
    if (sleeperRibbonGeo) {
      resourceManager.registerGeometry(sleeperRibbonGeo);
      sleeperRibbonItems.push({ geom: sleeperRibbonGeo, info: railInfo, chunkKey });
    }

    const railProfile3D = profile3D.map((p) => ({
      x: p.x,
      y:
        p.y +
        RAILWAY_DIMENSION_SPEC.sleeperStepHeightMeters +
        RAILWAY_DIMENSION_SPEC.railStepHeightMeters,
      z: p.z,
      arcLength: p.arcLength,
    }));
    const totalTrackLen =
      railProfile3D[railProfile3D.length - 1].arcLength - railProfile3D[0].arcLength;

    const sampleRailProfileAt = (sTarget: number): [number, number] => {
      for (let i = 0; i < railProfile3D.length - 1; i++) {
        const p0 = railProfile3D[i];
        const p1 = railProfile3D[i + 1];
        if (p1.arcLength >= sTarget || i === railProfile3D.length - 2) {
          const segLen = Math.max(1e-5, p1.arcLength - p0.arcLength);
          const frac = Math.max(0, Math.min(1, (sTarget - p0.arcLength) / segLen));
          return [p0.x + (p1.x - p0.x) * frac, p0.z + (p1.z - p0.z) * frac];
        }
      }
      return [railProfile3D[0].x, railProfile3D[0].z];
    };

    const [startProbeX, startProbeZ] = sampleRailProfileAt(Math.min(0.45, totalTrackLen * 0.4));
    const [endProbeX, endProbeZ] = sampleRailProfileAt(
      Math.max(totalTrackLen - 0.45, totalTrackLen * 0.6)
    );
    const taperStart =
      totalTrackLen >= 1.5 &&
      currentHostIdx.hasHostTrackStrictlyAlongside(startProbeX, startProbeZ, r.id, 1.8);
    const taperEnd =
      totalTrackLen >= 1.5 &&
      currentHostIdx.hasHostTrackStrictlyAlongside(endProbeX, endProbeZ, r.id, 1.8);
    const taperLen = Math.min(
      RAILWAY_DIMENSION_SPEC.switchBladeTaperLengthMeters,
      Math.max(0.5, totalTrackLen * 0.45)
    );

    for (const sideSign of [1, -1] as const) {
      const railRibbonGeo = buildUvRibbonGeometry3D(railProfile3D, {
        width: railWidth,
        startPhaseU,
        lateralCenterOffset: sideSign * gaugeOffsetHalf,
        evaluateSwitchAttributes: (vx, vz, arcS, totalLen, cx, cz) => {
          const rx = cx ?? vx;
          const rz = cz ?? vz;
          let distFromToe = 999;
          if (taperStart && arcS < taperLen) distFromToe = Math.min(distFromToe, arcS);
          if (taperEnd && totalLen - arcS < taperLen) {
            distFromToe = Math.min(distFromToe, totalLen - arcS);
          }
          let taperFactor = 1;
          if (
            distFromToe < taperLen &&
            currentHostIdx.queryMinDistanceToHostRail(rx, rz, r.id) < 0.32
          ) {
            taperFactor = 0.32 + 0.68 * Math.min(1, distFromToe / taperLen);
          }
          return [999, taperFactor];
        },
      });
      if (railRibbonGeo) {
        resourceManager.registerGeometry(railRibbonGeo);
        railRibbonItems.push({ geom: railRibbonGeo, info: railInfo, chunkKey });
      }
    }

    uvRibbonAndSwitchTimeMs += performance.now() - tRib0;

    if (mode === 'candidateB') {
      const tSlp0 = performance.now();
      const sleeperPeriod = isTram
        ? options?.closeZoomSleeperPeriodMeters
          ? options.closeZoomSleeperPeriodMeters * 1.14
          : RAILWAY_DIMENSION_SPEC.candidateBCloseTramSleeperPeriodMeters
        : closeZoomSleeperPeriodMeters;
      const sleeperHalfLen =
        sleeperPeriod <= 0.85
          ? RAILWAY_DIMENSION_SPEC.candidateB3DSleeperLengthMeters * 0.5
          : RAILWAY_DIMENSION_SPEC.visualSleeperLengthMeters * 0.5;
      const sleeperHalfW = sleeperWidth * 0.5;
      const trackArcLen =
        sleeperProfile3D[sleeperProfile3D.length - 1].arcLength - sleeperProfile3D[0].arcLength;
      const trackSleeperBoxes: SleeperBearerBox3D[] = [];

      const rawFirstS = (sleeperPeriod - (startPhaseU % sleeperPeriod)) % sleeperPeriod;
      const firstS = rawFirstS < 0.03 ? sleeperPeriod * 0.5 : rawFirstS;

      const queryNearbyPlacedBoxes = (qx: number, qz: number): SleeperBearerBox3D[] => {
        const gx = Math.floor(qx / 6);
        const gz = Math.floor(qz / 6);
        const out: SleeperBearerBox3D[] = [];
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = scopeSleeperGrid.get(`${gx + dx},${gz + dz}`);
            if (bucket) {
              for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
            }
          }
        }
        return out;
      };

      const evaluateCandidateStation = (
        cx: number,
        cz: number,
        yBot: number,
        tx: number,
        tz: number,
        nx: number,
        nz: number
      ) => {
        const hostMatches = currentHostIdx.queryTransverseTracks(
          cx,
          cz,
          tx,
          tz,
          nx,
          nz,
          r.id,
          sleeperHalfW + 3.2
        );
        const hostTrackSet = new Set(hostMatches.map((m) => m.trackId));
        const nearbyBoxes = queryNearbyPlacedBoxes(cx, cz);
        existingCandidatesChecked += nearbyBoxes.length;

        let minV = -sleeperHalfW;
        let maxV = sleeperHalfW;
        let isTurnoutBearer = false;
        let elongatedLeft = false;
        let elongatedRight = false;

        const allNeighbors = allTracksIndex.queryTransverseTracks(
          cx,
          cz,
          tx,
          tz,
          nx,
          nz,
          r.id,
          sleeperHalfW + 2.85
        );
        const turnoutPairFlags = new Map<string, boolean>();
        for (const nb of allNeighbors) {
          if (nb.cosAngle > 0.86 && nb.absDist <= 2.28) {
            const isPair = isTurnoutThroatPair(
              subdivPts,
              scopePtsMap?.get(nb.trackId),
              cx,
              cz,
              nb.absDist
            );
            turnoutPairFlags.set(nb.trackId, isPair);
          } else {
            turnoutPairFlags.set(nb.trackId, false);
          }
        }

        const sharedPartnerTargets: Array<{
          trackId: string;
          signedV: number;
          gaugeCenterOffset: number;
        }> = [];

        for (const nb of allNeighbors) {
          const isTurnout = turnoutPairFlags.get(nb.trackId) ?? false;
          if (nb.absDist <= 1.68 && nb.cosAngle > 0.78) {
            sharedPartnerTargets.push({
              trackId: nb.trackId,
              signedV: nb.signedV,
              gaugeCenterOffset: nb.gaugeCenterOffset,
            });
          }
          if (!hostTrackSet.has(nb.trackId) && isTurnout) {
            let reach = Math.min(sleeperHalfW + 2.35, nb.absDist + nb.gaugeCenterOffset + 0.38);
            for (const nbOuter of allNeighbors) {
              if (
                nbOuter.trackId !== nb.trackId &&
                nbOuter.signedV * nb.signedV > 0 &&
                nbOuter.absDist > nb.absDist + 0.4 &&
                nbOuter.cosAngle > 0.72 &&
                !(!hostTrackSet.has(nbOuter.trackId) && (turnoutPairFlags.get(nbOuter.trackId) ?? false))
              ) {
                const cap = 0.5 * (nb.absDist + nbOuter.absDist) - 0.024;
                if (cap >= nb.absDist + nb.gaugeCenterOffset + 0.12) {
                  reach = Math.min(reach, cap);
                }
              }
            }
            if (nb.signedV >= 0) {
              if (reach > maxV) {
                maxV = reach;
                isTurnoutBearer = true;
                elongatedLeft = true;
              }
              if (maxV >= nb.absDist + nb.gaugeCenterOffset + 0.08) {
                sharedPartnerTargets.push({
                  trackId: nb.trackId,
                  signedV: nb.signedV,
                  gaugeCenterOffset: nb.gaugeCenterOffset,
                });
              }
            } else {
              if (-reach < minV) {
                minV = -reach;
                isTurnoutBearer = true;
                elongatedRight = true;
              }
              if (minV <= -(nb.absDist + nb.gaugeCenterOffset + 0.08)) {
                sharedPartnerTargets.push({
                  trackId: nb.trackId,
                  signedV: nb.signedV,
                  gaugeCenterOffset: nb.gaugeCenterOffset,
                });
              }
            }
          }
        }

        const sharedPartnerSet = new Set(sharedPartnerTargets.map((p) => p.trackId));
        for (const nb of allNeighbors) {
          if (
            !sharedPartnerSet.has(nb.trackId) &&
            nb.cosAngle > 0.75 &&
            nb.absDist > 1.68 &&
            nb.absDist < 2 * sleeperHalfW + 0.06
          ) {
            const gap = nb.absDist < 1.9 ? 0.016 : 0.024;
            const bound = Math.max(gaugeOffsetHalf + 0.04, nb.absDist * 0.5 - gap);
            if (nb.signedV >= 0 && !elongatedLeft) {
              maxV = Math.min(maxV, bound);
            } else if (nb.signedV < 0 && !elongatedRight) {
              minV = Math.max(minV, -bound);
            }
          }
        }

        const initialSpanWidth = maxV - minV;
        let intervals: Array<[number, number]> = [[minV, maxV]];
        let leftSupportedByHost = false;
        let rightSupportedByHost = false;

        for (const hm of hostMatches) {
          if (hm.cosAngle <= 0.72) continue;
          let minDAlong = Infinity;
          for (const box of nearbyBoxes) {
            if (box.trackId !== hm.trackId || Math.hypot(cx - box.cx, cz - box.cz) >= 4.5) {
              continue;
            }
            const dAlong = Math.abs((cx - box.cx) * box.tx + (cz - box.cz) * box.tz);
            if (dAlong < minDAlong) minDAlong = dAlong;
          }

          if (minDAlong <= sleeperPeriod * 0.62) {
            let hostMinV = Infinity;
            let hostMaxV = -Infinity;
            let isSharedHost = hm.absDist <= 1.68;

            for (const box of nearbyBoxes) {
              if (
                box.trackId === hm.trackId &&
                Math.hypot(cx - box.cx, cz - box.cz) < 4.5 &&
                Math.abs((cx - box.cx) * box.tx + (cz - box.cz) * box.tz) <= minDAlong + 0.12
              ) {
                const lx = box.cx + box.nx * box.halfWidthLeft;
                const lz = box.cz + box.nz * box.halfWidthLeft;
                const rx = box.cx - box.nx * box.halfWidthRight;
                const rz = box.cz - box.nz * box.halfWidthRight;
                const vL = (lx - cx) * nx + (lz - cz) * nz;
                const vR = (rx - cx) * nx + (rz - cz) * nz;
                hostMinV = Math.min(hostMinV, vL, vR);
                hostMaxV = Math.max(hostMaxV, vL, vR);
                if (box.supportedTrackIds?.includes(r.id)) {
                  isSharedHost = true;
                }
              }
            }

            if (isSharedHost) {
              if (hostMinV <= -gaugeOffsetHalf - 0.06 && hostMaxV >= -gaugeOffsetHalf + 0.06) {
                leftSupportedByHost = true;
              }
              if (hostMinV <= gaugeOffsetHalf - 0.06 && hostMaxV >= gaugeOffsetHalf + 0.06) {
                rightSupportedByHost = true;
              }
              if (leftSupportedByHost && rightSupportedByHost) {
                return {
                  status: 'supported_by_host_bearer' as const,
                  cx,
                  cz,
                  yBot,
                  tx,
                  tz,
                  nx,
                  nz,
                  initialSpanWidth,
                  isTurnoutBearer,
                  validIntervals: [] as Array<[number, number]>,
                  sharedPartnerTargets,
                  supportedRailsCount: 2,
                  totalValidWidth: 0,
                };
              }
            }

            let cutMin = hostMinV - 0.022;
            let cutMax = hostMaxV + 0.022;
            if (!isSharedHost && hm.absDist > 1.68) {
              const gap = hm.absDist < 1.9 ? 0.016 : 0.024;
              const bound = Math.max(gaugeOffsetHalf + 0.04, hm.absDist * 0.5 - gap);
              if (hm.signedV < 0) {
                cutMax = Math.min(cutMax, -bound);
              } else {
                cutMin = Math.max(cutMin, bound);
              }
            }

            if (cutMin < cutMax) {
              if (multiIntervalClip) {
                intervals = subtractIntervalFromList(intervals, cutMin, cutMax, 0.26);
              } else {
                const single = subtractLateralInterval(
                  intervals[0][0],
                  intervals[0][1],
                  cutMin,
                  cutMax
                );
                intervals = single ? [single] : [];
              }
              if (intervals.length === 0) break;
            }
          } else if (hm.absDist > 1.68 && hm.absDist < 2 * sleeperHalfW + 0.06) {
            const gap = hm.absDist < 1.9 ? 0.016 : 0.024;
            const bound = Math.max(gaugeOffsetHalf + 0.04, hm.absDist * 0.5 - gap);
            const cutMin = hm.signedV < 0 ? -99 : bound;
            const cutMax = hm.signedV < 0 ? -bound : 99;
            if (multiIntervalClip) {
              intervals = subtractIntervalFromList(intervals, cutMin, cutMax, 0.26);
            } else {
              const single = subtractLateralInterval(
                intervals[0][0],
                intervals[0][1],
                cutMin,
                cutMax
              );
              intervals = single ? [single] : [];
            }
            if (intervals.length === 0) break;
          }
        }

        if (intervals.length > 0) {
          const railRx = cx - nx * gaugeOffsetHalf;
          const railRz = cz - nz * gaugeOffsetHalf;
          const railLx = cx + nx * gaugeOffsetHalf;
          const railLz = cz + nz * gaugeOffsetHalf;

          for (const box of nearbyBoxes) {
            if (box.trackId === r.id) continue;
            const dx = cx - box.cx;
            const dz = cz - box.cz;
            const distSq = dx * dx + dz * dz;
            if (distSq > 36) continue;

            minkowskiOverlapCalculations++;
            if (box.supportedTrackIds?.includes(r.id) || distSq <= 1.68 * 1.68) {
              const drx = railRx - box.cx;
              const drz = railRz - box.cz;
              const uR = Math.abs(drx * box.tx + drz * box.tz);
              const vR = drx * box.nx + drz * box.nz;
              if (
                uR <= box.halfLen + 0.06 &&
                vR >= -box.halfWidthRight - 0.04 &&
                vR <= box.halfWidthLeft + 0.04
              ) {
                leftSupportedByHost = true;
              }

              const dlx = railLx - box.cx;
              const dlz = railLz - box.cz;
              const uL = Math.abs(dlx * box.tx + dlz * box.tz);
              const vL = dlx * box.nx + dlz * box.nz;
              if (
                uL <= box.halfLen + 0.06 &&
                vL >= -box.halfWidthRight - 0.04 &&
                vL <= box.halfWidthLeft + 0.04
              ) {
                rightSupportedByHost = true;
              }
            }

            const u0 = dx * box.tx + dz * box.tz;
            const du = nx * box.tx + nz * box.tz;
            const padU = sleeperHalfLen * Math.abs(tx * box.tx + tz * box.tz) + 0.015;
            const boundU = box.halfLen + padU;
            let tMinU = -Infinity;
            let tMaxU = Infinity;
            if (Math.abs(du) < 1e-6) {
              if (u0 < -boundU || u0 > boundU) continue;
            } else {
              const t1 = (-boundU - u0) / du;
              const t2 = (boundU - u0) / du;
              tMinU = Math.min(t1, t2);
              tMaxU = Math.max(t1, t2);
            }

            const v0 = dx * box.nx + dz * box.nz;
            const dv = nx * box.nx + nz * box.nz;
            const padV = sleeperHalfLen * Math.abs(tx * box.nx + tz * box.nz) + 0.022;
            const minBoxV = -box.halfWidthRight - padV;
            const maxBoxV = box.halfWidthLeft + padV;
            let tMinV = -Infinity;
            let tMaxV = Infinity;
            if (Math.abs(dv) < 1e-6) {
              if (v0 < minBoxV || v0 > maxBoxV) continue;
            } else {
              const t1 = (minBoxV - v0) / dv;
              const t2 = (maxBoxV - v0) / dv;
              tMinV = Math.min(t1, t2);
              tMaxV = Math.max(t1, t2);
            }

            const cutStart = Math.max(tMinU, tMinV);
            const cutEnd = Math.min(tMaxU, tMaxV);
            if (cutStart < cutEnd) {
              if (multiIntervalClip) {
                intervals = subtractIntervalFromList(intervals, cutStart, cutEnd, 0.26);
              } else {
                const single = subtractLateralInterval(
                  intervals[0][0],
                  intervals[0][1],
                  cutStart,
                  cutEnd
                );
                intervals = single ? [single] : [];
              }
              if (intervals.length === 0) break;
            }
          }
        }

        const validIntervals = intervals.filter(([a, b]) => {
          const w = b - a;
          const coversR = a <= -gaugeOffsetHalf - 0.02 && b >= -gaugeOffsetHalf + 0.02;
          const coversL = a <= gaugeOffsetHalf - 0.02 && b >= gaugeOffsetHalf + 0.02;
          return coversR || coversL ? w >= 0.26 : w >= 0.38;
        });

        const coversRight =
          leftSupportedByHost ||
          validIntervals.some(([a, b]) => a <= -gaugeOffsetHalf - 0.02 && b >= -gaugeOffsetHalf + 0.02);
        const coversLeft =
          rightSupportedByHost ||
          validIntervals.some(([a, b]) => a <= gaugeOffsetHalf - 0.02 && b >= gaugeOffsetHalf + 0.02);
        const supportedRailsCount = (coversRight ? 1 : 0) + (coversLeft ? 1 : 0);
        let totalValidWidth = 0;
        for (const [a, b] of validIntervals) totalValidWidth += b - a;

        return {
          status: validIntervals.length > 0 ? ('placed' as const) : ('discarded' as const),
          cx,
          cz,
          yBot,
          tx,
          tz,
          nx,
          nz,
          initialSpanWidth,
          isTurnoutBearer,
          validIntervals,
          sharedPartnerTargets,
          supportedRailsCount,
          totalValidWidth,
        };
      };

      const commitPlacedStation = (
        evalRes: ReturnType<typeof evaluateCandidateStation>
      ) => {
        if (evalRes.status !== 'placed' || evalRes.validIntervals.length === 0) {
          discardedSleepersCount++;
          return;
        }
        const {
          cx,
          cz,
          yBot,
          tx,
          tz,
          nx,
          nz,
          initialSpanWidth,
          isTurnoutBearer,
          validIntervals,
          sharedPartnerTargets,
        } = evalRes;

        if (validIntervals.length > 1) splitIntoTwoSegmentsStationsCount++;
        const cellKey = `${Math.floor(cx / 6)},${Math.floor(cz / 6)}`;
        let cellBucket = scopeSleeperGrid.get(cellKey);
        if (!cellBucket) {
          cellBucket = [];
          scopeSleeperGrid.set(cellKey, cellBucket);
        }

        for (const [v0, v1] of validIntervals) {
          const w = v1 - v0;
          if (w < initialSpanWidth - 0.02) clippedOrShortenedSleepersCount++;
          const isElongatedBearer = isTurnoutBearer && w > sleeperWidth + 0.08;
          if (isElongatedBearer) sharedTurnoutBearersCount++;

          const supportedTrackIds: string[] = [r.id];
          for (const partner of sharedPartnerTargets) {
            if (
              v0 <= partner.signedV + partner.gaugeCenterOffset &&
              v1 >= partner.signedV - partner.gaugeCenterOffset
            ) {
              if (!supportedTrackIds.includes(partner.trackId)) {
                supportedTrackIds.push(partner.trackId);
              }
            }
          }

          const box: SleeperBearerBox3D = {
            cx,
            cz,
            yBottom: yBot,
            yTop: yBot + RAILWAY_DIMENSION_SPEC.candidateB3DSleeperHeightMeters,
            tx,
            tz,
            nx,
            nz,
            halfLen: sleeperHalfLen,
            halfWidthLeft: v1,
            halfWidthRight: -v0,
            trackId: r.id,
            supportedTrackIds,
            isTurnoutBearer: isElongatedBearer,
            isSplitSegment: validIntervals.length > 1,
          };
          trackSleeperBoxes.push(box);
          cellBucket.push(box);
          sleeperBoxes3D.push(box);
          if (sleeper3DMode === 'instanced') {
            sleeper3DInstancedItems.push({
              box,
              info: railInfo,
              chunkKey: getChunkKey(cx, cz),
            });
          }
        }
      };

      const sampleSleeperProfileAt = (sTarget: number) => {
        let idx = 0;
        while (
          idx < sleeperProfile3D.length - 2 &&
          sleeperProfile3D[idx + 1].arcLength < sTarget
        ) {
          idx++;
        }
        const p0 = sleeperProfile3D[idx];
        const p1 = sleeperProfile3D[idx + 1];
        const segLen = Math.max(1e-5, p1.arcLength - p0.arcLength);
        const frac = Math.max(0, Math.min(1, (sTarget - p0.arcLength) / segLen));
        const cx = p0.x + (p1.x - p0.x) * frac;
        const cz = p0.z + (p1.z - p0.z) * frac;
        const yBot = p0.y + (p1.y - p0.y) * frac - 0.004;
        const dx = p1.x - p0.x;
        const dz = p1.z - p0.z;
        const len = Math.hypot(dx, dz) || 1;
        const tx = dx / len;
        const tz = dz / len;
        return { cx, cz, yBot, tx, tz, nx: -tz, nz: tx };
      };

      let lastPlacedS = -999;
      for (let s = firstS; s <= trackArcLen - 0.02; s += sleeperPeriod) {
        const tOvl0 = performance.now();
        proposedSleeperStations++;
        const st = sampleSleeperProfileAt(s);
        let bestEval = evaluateCandidateStation(
          st.cx,
          st.cz,
          st.yBot,
          st.tx,
          st.tz,
          st.nx,
          st.nz
        );
        let chosenS = s;

        if (bestEval.supportedRailsCount < 2 && trackArcLen >= 0.45) {
          for (const ds of [0.18, -0.18, 0.32, -0.32]) {
            const altS = s + ds;
            if (
              altS < 0.03 ||
              altS > trackArcLen - 0.03 ||
              altS < lastPlacedS + sleeperHalfLen * 2 + 0.05
            ) {
              continue;
            }
            const altSt = sampleSleeperProfileAt(altS);
            const altEval = evaluateCandidateStation(
              altSt.cx,
              altSt.cz,
              altSt.yBot,
              altSt.tx,
              altSt.tz,
              altSt.nx,
              altSt.nz
            );
            if (
              altEval.supportedRailsCount > bestEval.supportedRailsCount ||
              (altEval.supportedRailsCount === bestEval.supportedRailsCount &&
                altEval.totalValidWidth > bestEval.totalValidWidth + 0.05)
            ) {
              bestEval = altEval;
              chosenS = altS;
              if (bestEval.supportedRailsCount === 2) break;
            }
          }
        }

        commitPlacedStation(bestEval);
        if (bestEval.status === 'placed') lastPlacedS = chosenS;
        overlapResolutionTimeMs += performance.now() - tOvl0;
      }

      if (trackSleeperBoxes.length === 0 && trackArcLen >= 0.35) {
        const tOvl0 = performance.now();
        proposedSleeperStations++;
        const midSt = sampleSleeperProfileAt(trackArcLen * 0.5);
        commitPlacedStation(
          evaluateCandidateStation(
            midSt.cx,
            midSt.cz,
            midSt.yBot,
            midSt.tx,
            midSt.tz,
            midSt.nx,
            midSt.nz
          )
        );
        overlapResolutionTimeMs += performance.now() - tOvl0;
      }

      if (sleeper3DMode === 'merged') {
        const mergedSleeperGeo = buildMergedSleeperBoxes3DGeometry(trackSleeperBoxes);
        if (mergedSleeperGeo) {
          resourceManager.registerGeometry(mergedSleeperGeo);
          sleeper3DMergedItems.push({ geom: mergedSleeperGeo, info: railInfo, chunkKey });
        }
      }
      sleeper3DPlacementTimeMs += performance.now() - tSlp0;

      const tRail3D0 = performance.now();
      for (const sideSign of [1, -1] as const) {
        const rail3DGeo = buildExtrudedRail3DGeometry(
          railProfile3D,
          sideSign * gaugeOffsetHalf,
          railWidth,
          RAILWAY_DIMENSION_SPEC.candidateB3DRailHeightMeters,
          (px, pz, arcS, totalLen) => {
            let distFromToe = 999;
            if (taperStart && arcS < taperLen) distFromToe = Math.min(distFromToe, arcS);
            if (taperEnd && totalLen - arcS < taperLen) {
              distFromToe = Math.min(distFromToe, totalLen - arcS);
            }
            return distFromToe < taperLen &&
              currentHostIdx.queryMinDistanceToHostRail(px, pz, r.id) < gaugeOffsetHalf + 0.25
              ? 0.28 + 0.72 * Math.min(1, distFromToe / taperLen)
              : 1;
          }
        );
        if (rail3DGeo) {
          resourceManager.registerGeometry(rail3DGeo);
          rail3DItems.push({ geom: rail3DGeo, info: railInfo, chunkKey });
        }
      }
      rail3DExtrusionTimeMs += performance.now() - tRail3D0;
    }

    hostIndex.registerTrack(
      useSpatialGridIndex ? subdivPts : profile3D.map((p) => [p.x, p.z]),
      gaugeOffsetHalf,
      r.id
    );
    renderedRailwaysCount++;
    for (const sid of sids) renderedSourceIds.add(sid);
  }

  const tMerge0 = performance.now();
  let totalVertices = 0;
  let totalTriangles = 0;
  let instancedExtraVertices = 0;
  let instancedExtraTriangles = 0;
  let instancedMatrixBytes = 0;
  let drawCalls = 0;
  const activeChunkKeys = new Set<string>();

  const buildLayerTarget = (
    layerName: string,
    items: ChunkedGeoItem[],
    material: THREE.Material,
    configureMesh: (mesh: THREE.Mesh) => void
  ): THREE.Object3D | null => {
    if (items.length === 0) return null;
    if (spatialChunkSizeMeters <= 0) {
      const { merged, faceRanges } = mergeItemsWithFaceRanges(items, resourceManager);
      if (!merged) return null;
      resourceManager.registerGeometry(merged);
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = layerName;
      mesh.frustumCulled = true;
      configureMesh(mesh);
      mesh.userData = { ...mesh.userData, faceRanges };
      railwaysGroup.add(mesh);
      drawCalls++;
      totalVertices += merged.attributes.position.count;
      totalTriangles += Math.round(getTriangleCount(merged));
      activeChunkKeys.add('global');
      return mesh;
    }

    const byChunk = new Map<string, ChunkedGeoItem[]>();
    for (const item of items) {
      activeChunkKeys.add(item.chunkKey);
      let bucket = byChunk.get(item.chunkKey);
      if (!bucket) {
        bucket = [];
        byChunk.set(item.chunkKey, bucket);
      }
      bucket.push(item);
    }

    const layerGroup = new THREE.Group();
    layerGroup.name = layerName;
    const aggregatedFaceRanges: FaceRangeEntry[] = [];
    let runningFace = 0;

    for (const [cKey, chunkItems] of byChunk.entries()) {
      const { merged, faceRanges } = mergeItemsWithFaceRanges(chunkItems, resourceManager);
      if (!merged) continue;
      resourceManager.registerGeometry(merged);
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `${layerName}_chunk_${cKey}`;
      mesh.frustumCulled = true;
      configureMesh(mesh);
      mesh.userData = { ...mesh.userData, faceRanges, chunkKey: cKey };
      for (const fr of faceRanges) {
        aggregatedFaceRanges.push({
          startFace: runningFace + fr.startFace,
          endFace: runningFace + fr.endFace,
          info: fr.info,
        });
      }
      runningFace += Math.round(getTriangleCount(merged));
      layerGroup.add(mesh);
      drawCalls++;
      totalVertices += merged.attributes.position.count;
      totalTriangles += Math.round(getTriangleCount(merged));
    }
    layerGroup.userData = { faceRanges: aggregatedFaceRanges };
    railwaysGroup.add(layerGroup);
    return layerGroup;
  };

  let ballastMat: THREE.MeshStandardMaterial | null = null;
  if (ballastItems.length > 0) {
    ballastMat = resourceManager.registerMaterial(
      new THREE.MeshStandardMaterial({
        color: theme.railwayColors.ballast,
        roughness: 0.92,
        metalness: 0.08,
        side: THREE.FrontSide,
        depthFunc: THREE.LessEqualDepth,
        stencilWrite: true,
        stencilRef: 14,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilZPass: THREE.ReplaceStencilOp,
        ...DEPTH_OFFSET_CONFIG.railways,
      })
    );
    buildLayerTarget('Railway_Ballast', ballastItems, ballastMat, (m) => {
      m.receiveShadow = true;
      m.renderOrder = 14;
    });
  }

  let sleepersRibbonTarget: THREE.Object3D | null = null;
  let sleepersShaderCtrl: ProceduralRailwayMaterialControl | null = null;
  if (sleeperRibbonItems.length > 0) {
    const mat = resourceManager.registerMaterial(
      new THREE.MeshStandardMaterial({
        color: '#ffffff',
        roughness: 0.88,
        metalness: 0.06,
        side: THREE.FrontSide,
        depthFunc: THREE.LessEqualDepth,
        stencilWrite: true,
        stencilRef: 15,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilZPass: THREE.ReplaceStencilOp,
        ...DEPTH_OFFSET_CONFIG.railwaySleepers,
      })
    );
    sleepersShaderCtrl = configureProceduralSleeperMaterial(mat, theme, initialZoom);
    sleepersRibbonTarget = buildLayerTarget('Railway_Sleepers', sleeperRibbonItems, mat, (m) => {
      m.receiveShadow = true;
      m.renderOrder = 15;
    });
  }

  let railsRibbonTarget: THREE.Object3D | null = null;
  let railsShaderCtrl: ProceduralRailwayMaterialControl | null = null;
  if (railRibbonItems.length > 0) {
    const mat = resourceManager.registerMaterial(
      new THREE.MeshStandardMaterial({
        color: '#ffffff',
        roughness: 0.72,
        metalness: 0.22,
        side: THREE.FrontSide,
        depthFunc: THREE.LessEqualDepth,
        stencilWrite: true,
        stencilRef: 16,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilZPass: THREE.ReplaceStencilOp,
        ...DEPTH_OFFSET_CONFIG.railwayRails,
      })
    );
    railsShaderCtrl = configureProceduralRailMaterial(mat, theme, initialZoom);
    railsRibbonTarget = buildLayerTarget('Railway_Rails', railRibbonItems, mat, (m) => {
      m.receiveShadow = true;
      m.renderOrder = 16;
    });
  }

  let sleepers3DTarget: THREE.Object3D | null = null;
  let sleepers3DMat: THREE.MeshStandardMaterial | null = null;
  let rails3DTarget: THREE.Object3D | null = null;
  let rails3DMat: THREE.MeshStandardMaterial | null = null;

  if (mode === 'candidateB') {
    sleepers3DMat = resourceManager.registerMaterial(
      new THREE.MeshStandardMaterial({
        color: theme.railwayColors.sleeper || '#64748b',
        roughness: 0.86,
        metalness: 0.08,
        side: THREE.FrontSide,
        ...DEPTH_OFFSET_CONFIG.railwaySleepers,
      })
    );

    if (sleeper3DMode === 'instanced' && sleeper3DInstancedItems.length > 0) {
      const unitGeo = resourceManager.registerGeometry(buildUnitSleeperBoxGeometry());
      totalVertices += 20;
      totalTriangles += 10;
      instancedExtraVertices += sleeper3DInstancedItems.length * 20 - 20;
      instancedExtraTriangles += sleeper3DInstancedItems.length * 10 - 10;

      if (spatialChunkSizeMeters <= 0) {
        const { instancedMesh, matrixBytes } = buildInstancedSleepersMesh(
          sleeper3DInstancedItems,
          unitGeo,
          sleepers3DMat,
          'Railway_Sleepers_3D'
        );
        railwaysGroup.add(instancedMesh);
        sleepers3DTarget = instancedMesh;
        instancedMatrixBytes += matrixBytes;
        drawCalls++;
        activeChunkKeys.add('global');
      } else {
        const byChunk = new Map<
          string,
          Array<{ box: SleeperBearerBox3D; info: InspectableFeatureInfo; chunkKey: string }>
        >();
        for (const item of sleeper3DInstancedItems) {
          activeChunkKeys.add(item.chunkKey);
          let list = byChunk.get(item.chunkKey);
          if (!list) {
            list = [];
            byChunk.set(item.chunkKey, list);
          }
          list.push(item);
        }
        const instGroup = new THREE.Group();
        instGroup.name = 'Railway_Sleepers_3D';
        const aggregatedInstanceInfos: InspectableFeatureInfo[] = [];
        for (const [cKey, chunkItems] of byChunk.entries()) {
          const { instancedMesh, matrixBytes } = buildInstancedSleepersMesh(
            chunkItems,
            unitGeo,
            sleepers3DMat,
            `Railway_Sleepers_3D_chunk_${cKey}`
          );
          aggregatedInstanceInfos.push(
            ...(instancedMesh.userData.instanceInfos as InspectableFeatureInfo[])
          );
          instGroup.add(instancedMesh);
          instancedMatrixBytes += matrixBytes;
          drawCalls++;
        }
        instGroup.userData = {
          isInstanced: true,
          isStructural3D: true,
          instanceInfos: aggregatedInstanceInfos,
        };
        railwaysGroup.add(instGroup);
        sleepers3DTarget = instGroup;
      }
    } else if (sleeper3DMergedItems.length > 0) {
      sleepers3DTarget = buildLayerTarget(
        'Railway_Sleepers_3D',
        sleeper3DMergedItems,
        sleepers3DMat,
        (m) => {
          m.castShadow = false;
          m.receiveShadow = true;
          m.renderOrder = 15;
          m.userData.isStructural3D = true;
        }
      );
    }

    if (rail3DItems.length > 0) {
      rails3DMat = resourceManager.registerMaterial(
        new THREE.MeshStandardMaterial({
          color: theme.railwayColors.rail,
          roughness: 0.65,
          metalness: 0.28,
          side: THREE.FrontSide,
          stencilWrite: true,
          stencilRef: 16,
          stencilFunc: THREE.NotEqualStencilFunc,
          stencilZPass: THREE.ReplaceStencilOp,
          ...DEPTH_OFFSET_CONFIG.railwayRails,
        })
      );
      rails3DTarget = buildLayerTarget('Railway_Rails_3D', rail3DItems, rails3DMat, (m) => {
        m.castShadow = false;
        m.receiveShadow = true;
        m.renderOrder = 16;
        m.userData.isStructural3D = true;
      });
    }
  }

  let bridgeSubMat: THREE.MeshStandardMaterial | null = null;
  let bridgeParapetMat: THREE.MeshStandardMaterial | null = null;
  let tunnelPortalMat: THREE.MeshStandardMaterial | null = null;
  let tunnelTraceMat: THREE.MeshStandardMaterial | null = null;

  if (bridgeSubstructureItems.length > 0 || bridgePierItems.length > 0) {
    bridgeSubMat = resourceManager.registerMaterial(
      new THREE.MeshStandardMaterial({
        color:
          theme.id === 'daylight'
            ? '#64748b'
            : theme.id === 'blueprint'
              ? '#0077b6'
              : '#334155',
        roughness: 0.85,
        metalness: 0.15,
      })
    );
    buildLayerTarget(
      'Railway_Bridge_Substructure',
      [...bridgeSubstructureItems, ...bridgePierItems],
      bridgeSubMat,
      (m) => {
        m.receiveShadow = true;
        m.renderOrder = 12;
        m.userData.isStructural3D = true;
      }
    );
  }

  if (bridgeParapetItems.length > 0) {
    bridgeParapetMat = resourceManager.registerMaterial(
      new THREE.MeshStandardMaterial({
        color:
          theme.id === 'daylight'
            ? '#94a3b8'
            : theme.id === 'blueprint'
              ? '#48cae4'
              : '#64748b',
        roughness: 0.75,
        metalness: 0.2,
      })
    );
    buildLayerTarget('Railway_Bridge_Parapets', bridgeParapetItems, bridgeParapetMat, (m) => {
      m.receiveShadow = true;
      m.renderOrder = 13;
      m.userData.isStructural3D = true;
    });
  }

  if (tunnelPortalItems.length > 0 || tunnelMouthItems.length > 0) {
    tunnelPortalMat = resourceManager.registerMaterial(
      new THREE.MeshStandardMaterial({
        color:
          theme.id === 'daylight'
            ? '#94a3b8'
            : theme.id === 'blueprint'
              ? '#0096c7'
              : '#475569',
        roughness: 0.85,
      })
    );
    buildLayerTarget(
      'Railway_Tunnel_Portals',
      [...tunnelPortalItems, ...tunnelMouthItems],
      tunnelPortalMat,
      (m) => {
        m.receiveShadow = true;
        m.renderOrder = 17;
        m.userData.isStructural3D = true;
      }
    );
  }

  if (tunnelTraceItems.length > 0) {
    tunnelTraceMat = resourceManager.registerMaterial(
      new THREE.MeshStandardMaterial({
        color:
          theme.id === 'daylight'
            ? '#475569'
            : theme.id === 'blueprint'
              ? '#00b4d8'
              : '#38bdf8',
        roughness: 0.9,
      })
    );
    buildLayerTarget('Railway_Tunnel_Traces', tunnelTraceItems, tunnelTraceMat, (m) => {
      m.receiveShadow = false;
      m.renderOrder = 15;
    });
  }

  const geometryMergeAndChunkTimeMs = performance.now() - tMerge0;

  let currentCameraZoom = -1;
  const updateCameraZoom = (zoom: number) => {
    if (Math.abs(zoom - currentCameraZoom) < 0.002) return;
    currentCameraZoom = zoom;
    sleepersShaderCtrl?.updateZoom(zoom);
    railsShaderCtrl?.updateZoom(zoom);
    if (mode === 'candidateB') {
      const show3D = zoom > RAILWAY_DIMENSION_SPEC.hybridCloseZoomThresholdPxPerMeter;
      if (sleepers3DTarget) sleepers3DTarget.visible = show3D;
      if (rails3DTarget) rails3DTarget.visible = show3D;
      if (sleepersRibbonTarget) sleepersRibbonTarget.visible = !show3D;
      if (railsRibbonTarget) railsRibbonTarget.visible = !show3D;
    }
  };
  updateCameraZoom(initialZoom);

  let registeredSegmentsCount = 0;
  let gridCellsCount = 0;
  let totalQueries = 0;
  let totalSegmentsExamined = 0;
  let maxSegmentsInSingleQuery = 0;
  let totalDistanceCalculations = 0;
  let queryTimeMs = 0;
  const visitedIdx = new Set<HostTrackSpatialIndex>();

  for (const idx of [...hostIndexByScope.values(), ...allTracksIndexByScope.values()]) {
    if (visitedIdx.has(idx)) continue;
    visitedIdx.add(idx);
    registeredSegmentsCount += idx.registeredSegmentsCount;
    gridCellsCount += idx.gridCellsCount;
    totalQueries += idx.totalQueries;
    totalSegmentsExamined += idx.totalSegmentsExamined;
    if (idx.maxSegmentsInSingleQuery > maxSegmentsInSingleQuery) {
      maxSegmentsInSingleQuery = idx.maxSegmentsInSingleQuery;
    }
    totalDistanceCalculations += idx.totalDistanceCalculations;
    queryTimeMs += idx.queryTimeMs;
  }

  const cpuBufferBytes =
    resourceManager.getCpuBufferMemoryStats().totalBytes + instancedMatrixBytes;
  const cpuBufferMB = Number((cpuBufferBytes / 1048576).toFixed(3));
  const totalBuildTimeMs = Number((performance.now() - tStart).toFixed(2));
  const spatialChunkCount = Math.max(1, activeChunkKeys.size);

  return {
    railwaysGroup,
    resources: resourceManager,
    sleeperBoxes3D,
    renderedSourceIds,
    profile: {
      totalBuildTimeMs,
      phaseAndSortTimeMs: Number(phaseAndSortTimeMs.toFixed(2)),
      bridgeAndTunnelTimeMs: Number(bridgeAndTunnelTimeMs.toFixed(2)),
      uvRibbonAndSwitchTimeMs: Number(uvRibbonAndSwitchTimeMs.toFixed(2)),
      sleeper3DPlacementTimeMs: Number(sleeper3DPlacementTimeMs.toFixed(2)),
      rail3DExtrusionTimeMs: Number(rail3DExtrusionTimeMs.toFixed(2)),
      geometryMergeAndChunkTimeMs: Number(geometryMergeAndChunkTimeMs.toFixed(2)),
      spatialIndexStats: {
        useSpatialGrid: useSpatialGridIndex,
        registeredSegmentsCount,
        gridCellsCount,
        totalQueries,
        totalSegmentsExamined,
        avgSegmentsPerQuery:
          totalQueries > 0 ? Number((totalSegmentsExamined / totalQueries).toFixed(2)) : 0,
        maxSegmentsInSingleQuery,
        totalDistanceCalculations,
        queryTimeMs: Number(queryTimeMs.toFixed(2)),
      },
      sleeperOverlapStats: {
        multiIntervalClipEnabled: multiIntervalClip,
        proposedSleeperStations,
        existingCandidatesChecked,
        minkowskiOverlapCalculations,
        sharedTurnoutBearersCount,
        clippedOrShortenedSleepersCount,
        splitIntoTwoSegmentsStationsCount,
        discardedSleepersCount,
        emittedSleeperBoxesCount: sleeperBoxes3D.length,
        overlapResolutionTimeMs: Number(overlapResolutionTimeMs.toFixed(2)),
      },
      bakedAssetStats: {
        sleeper3DMode,
        spatialChunkSizeMeters,
        spatialChunkCount,
        estimatedBakedBinaryBytes: cpuBufferBytes,
        estimatedBakedBinaryMB: cpuBufferMB,
      },
    },
    stats: {
      mode,
      buildTimeMs: totalBuildTimeMs,
      totalVertices,
      totalTriangles,
      renderedVerticesWithInstances: totalVertices + instancedExtraVertices,
      renderedTrianglesWithInstances: totalTriangles + instancedExtraTriangles,
      drawCalls,
      cpuBufferBytes,
      cpuBufferMB,
      renderedRailwaysCount,
      closeZoomSleeperPeriodMeters,
      sleeper3DBoxCount: sleeperBoxes3D.length,
      turnoutBearerCount: sharedTurnoutBearersCount,
      splitMultiSegmentStationsCount: splitIntoTwoSegmentsStationsCount,
      sleeper3DMode,
      spatialChunkSizeMeters,
      spatialChunkCount,
      railwayRenderSource: effectiveSource,
      graphFallbackOccurred,
      graphFallbackReason,
      graphEdgeCount,
      sourceRailwayCount: (data.railways || []).length,
    },
    updateTheme: (newTheme: MapStyleTheme) => {
      if (ballastMat) ballastMat.color.set(newTheme.railwayColors.ballast);
      sleepersShaderCtrl?.updateThemeColors(newTheme);
      railsShaderCtrl?.updateThemeColors(newTheme);
      if (sleepers3DMat) sleepers3DMat.color.set(newTheme.railwayColors.sleeper || '#64748b');
      if (rails3DMat) rails3DMat.color.set(newTheme.railwayColors.rail);
      if (bridgeSubMat) {
        bridgeSubMat.color.set(
          newTheme.id === 'daylight'
            ? '#64748b'
            : newTheme.id === 'blueprint'
              ? '#0077b6'
              : '#334155'
        );
      }
      if (bridgeParapetMat) {
        bridgeParapetMat.color.set(
          newTheme.id === 'daylight'
            ? '#94a3b8'
            : newTheme.id === 'blueprint'
              ? '#48cae4'
              : '#64748b'
        );
      }
      if (tunnelPortalMat) {
        tunnelPortalMat.color.set(
          newTheme.id === 'daylight'
            ? '#94a3b8'
            : newTheme.id === 'blueprint'
              ? '#0096c7'
              : '#475569'
        );
      }
      if (tunnelTraceMat) {
        tunnelTraceMat.color.set(
          newTheme.id === 'daylight'
            ? '#475569'
            : newTheme.id === 'blueprint'
              ? '#00b4d8'
              : '#38bdf8'
        );
      }
    },
    updateCameraZoom,
    dispose: () => {
      railwaysGroup.clear();
      if (!options?.resourceManager) {
        resourceManager.dispose();
      }
    },
  };
}

/**
 * Production entry point for Milestone 2.2 (`TKT-001`): builds the validated Candidate B
 * hybrid railway infrastructure with the optimized production configuration:
 * - `useSpatialGridIndex: true`
 * - `adaptiveBridgeSampling: true`
 * - `multiIntervalClip: true`
 * - `sleeper3DMode: 'instanced'`
 * - `spatialChunkSizeMeters: 128`
 * - Zoom threshold `4.5 CSS px/m` (`hybridCloseZoomThresholdPxPerMeter = 4.5`)
 */
export function buildRailwayInfrastructure(
  data: ProcessedMapData,
  theme: MapStyleTheme,
  initialZoom: number = 1.0,
  options?: BuildRailwayPrototypeOptions
): RailwayPrototypeResult {
  return buildRailwayGroupInternal(data, theme, 'candidateB', initialZoom, {
    useSpatialGridIndex: options?.useSpatialGridIndex ?? true,
    adaptiveBridgeSampling: options?.adaptiveBridgeSampling ?? true,
    multiIntervalClip: options?.multiIntervalClip ?? true,
    sleeper3DMode: options?.sleeper3DMode ?? 'instanced',
    spatialChunkSizeMeters: options?.spatialChunkSizeMeters ?? 128,
    closeZoomSleeperPeriodMeters: options?.closeZoomSleeperPeriodMeters,
    resourceManager: options?.resourceManager,
    targetGroup: options?.targetGroup,
    renderSource: options?.renderSource,
    descriptors: options?.descriptors,
    diagnostics: options?.diagnostics,
  });
}
