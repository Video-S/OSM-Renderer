import * as THREE from 'three';
import type { MapStyleTheme } from '../../types/MapFeature';
import { MAP_THEMES } from '../../styles/mapThemes';
import {
  SceneResourceManager,
  type BuiltSceneGeometry,
} from '../GeometryBuilder';
import {
  equalFoliageOptimizationConfig,
  FoliagePrototypeRegistry,
  normalizeFoliageOptimizationConfig,
  resolveFoliageRuntimeState,
  type FoliageLodLevel,
  type FoliageOptimizationConfig,
  type FoliageRuntimeState,
} from '../FoliageLodSystem';
import { DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS } from '../infrastructure/rendering/InfrastructureRenderAdapter';
import {
  createM1aTileBoundaryOverlay,
  type M1aTileBoundaryOverlayResult,
} from './M1aVisualHarness';
import { ThemeMaterialRegistry } from './ThemeMaterialRegistry';
import {
  createTileDecodeClient,
  type TileDecodeClient,
} from './TileDecodeClient';
import {
  reconstructTileSceneFromDecoded,
  type ReconstructedTileSceneResult,
} from './TileSceneReconstructor';
import {
  type DecodedTilePayload,
  type TileLayerKind,
  type TileManifestEntry,
  type TilePackMetadata,
} from './TilePackContract';
import {
  createHengeloStudyGrid,
  formatTileId,
  type StudyGridSpec,
} from './TileGrid';
import {
  deriveActiveMosaicNameFromPackPath,
  type TileManifestLoadStatus,
} from './ActiveMosaicIdentity';
import { utm32NToGeo } from './RegionalProjection';
import {
  getGlobalStreamingProfiler,
  type StreamingProfiler,
  type StreamingQueueDepths,
} from './StreamingProfiler';

export {
  deriveActiveMosaicNameFromPackPath,
  createLoadingMosaicIdentity,
  createErrorMosaicIdentity,
  createMosaicIdentityFromDiagnostics,
  INACTIVE_MOSAIC_IDENTITY,
  type ActiveMosaicIdentity,
  type ActiveMosaicStatus,
  type TileManifestLoadStatus,
} from './ActiveMosaicIdentity';

export type TileStreamLifecycleState =
  | 'unloaded'
  | 'queued'
  | 'fetching'
  | 'decoding'
  | 'ready_to_commit'
  | 'loaded'
  | 'error';

export interface TileViewportGroundBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  focusX: number;
  focusZ: number;
  cameraZoom?: number;
}

export interface TileMemoryFootprint {
  cpuGeometryBytes: number;
  bvhBytes: number;
  meshCount: number;
  instancedBatchCount: number;
  bvhCount: number;
  triangleCount: number;
  vertexCount: number;
}

export interface TileTimingSummaryStats {
  count: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
}

export interface TileStreamDiagnosticsSnapshot {
  manifestStatus: TileManifestLoadStatus;
  manifestError: string | null;
  activeMosaicName: string | null;
  packPath: string | null;
  apiBaseUrl: string;
  snapshotId: string;
  bakeSchemaVersion: string;
  tileSizeMeters: number;
  preloadMarginTiles: number;
  retainMarginTiles: number;
  totalGridCols: number;
  totalGridRows: number;
  totalGridTiles: number;
  visibleTiles: number;
  fetchTargetTiles: number;
  keepTargetTiles: number;
  loadedTiles: number;
  peakLoadedTiles: number;
  emptyLoadedTiles: number;
  loadingTiles: number;
  peakLoadingTiles: number;
  queuedTiles: number;
  fetchingTiles: number;
  decodingTiles: number;
  readyToCommitTiles: number;
  failedTiles: number;
  evictedTilesTotal: number;
  cancelledRequestsTotal: number;
  duplicateRequestsSkippedTotal: number;
  completedLoadsTotal: number;
  loadedMeshCount: number;
  visibleMeshCount: number;
  loadedTriangles: number;
  loadedVertices: number;
  loadedDrawCallsEstimate: number;
  activeTileGeometries: number;
  activeTileBvhs: number;
  sharedMaterialCount: number;
  tileCpuGeometryBytes: number;
  tileBvhBytes: number;
  compositeSceneRevision: number;
  lastManifestLoadMs: number;
  avgFetchMs: number;
  avgDecodeMs: number;
  avgReconstructMs: number;
  lastCommitMs: number;
  maxCommitMs: number;
  fetchMsStats: TileTimingSummaryStats | null;
  decodeMsStats: TileTimingSummaryStats | null;
  reconstructMsStats: TileTimingSummaryStats | null;
  commitMsStats: TileTimingSummaryStats | null;
  viewportBounds: TileViewportGroundBounds | null;
  loadedTileKeys: string[];
  visibleTileKeys: string[];
  loadingTileKeys: string[];
  /** TKT-031 opt-in experiment: viewport selection work since last counter reset. */
  viewportSelectionPasses: number;
  viewportSelectionSkips: number;
  /** TKT-031 opt-in experiment: unchanged zoom propagation skips. */
  zoomPropagationSkips: number;
  /** TKT-036 runtime foliage LOD & culling diagnostics. */
  activeFoliageLod: FoliageLodLevel;
  foliageTrunksVisible: boolean;
  foliageFrustumCullingEnabled: boolean;
  sharedFoliagePrototypeCount: number;
  /** TKT-038 instanced spatial picking index diagnostics across resident loaded tiles. */
  tileInstancedIndexBytes: number;
  tileInstancedIndexCount: number;
  tileInstancedIndexInstances: number;
  tileInstancedIndexBuildMsTotal: number;
}

export interface TilePackManifestPayload {
  available?: boolean;
  packPath?: string;
  dbSizeBytes?: number;
  metadata: TilePackMetadata;
  tiles: TileManifestEntry[];
}

export interface TileManifestCoverageSummary {
  totalTiles: number;
  nonEmptyTiles: number;
  emptyTiles: number;
  gridCols: number;
  gridRows: number;
  tileSizeMeters: number;
  studyOriginEasting: number;
  studyOriginNorthing: number;
  boundsUtm: {
    minEasting: number;
    maxEasting: number;
    minNorthing: number;
    maxNorthing: number;
  } | null;
  boundsGeo: {
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
  } | null;
  minTx: number | null;
  maxTx: number | null;
  minTy: number | null;
  maxTy: number | null;
  shardCountEstimate: number | null;
  compression: string;
  projection: string;
  createdAt: string;
}

export interface TileStreamManagerOptions {
  /** Base URL for tile API (default: `/api/tiles`). */
  apiBaseUrl?: string;
  /** Surrounding margin in tiles to preload around the visible viewport (default: 1 = 512 m). */
  preloadMarginTiles?: number;
  /** Surrounding margin in tiles to retain before unloading (default: 2 = 1,024 m). */
  retainMarginTiles?: number;
  /** Maximum concurrent tile HTTP requests + worker decodes (default: 6). */
  maxConcurrentFetches?: number;
  /** Maximum decoded tiles reconstructed and mounted per tick (default: 4). */
  maxCommitsPerFrame?: number;
  /** Initial map theme (default: `MAP_THEMES.tactical`). */
  initialTheme?: MapStyleTheme;
  /** Initial camera zoom in CSS px/m (default: 1.0). */
  initialCameraZoom?: number;
  /** Optional pre-configured shared `ThemeMaterialRegistry`. */
  materialRegistry?: ThemeMaterialRegistry;
  /** Optional pre-configured shared `FoliagePrototypeRegistry`. */
  foliagePrototypeRegistry?: FoliagePrototypeRegistry;
  /** Optional initial runtime foliage LOD & culling configuration. */
  foliageOptimizationConfig?: Partial<FoliageOptimizationConfig>;
  /** Optional pre-configured `TileDecodeClient`. */
  decodeClient?: TileDecodeClient;
  /** Optional custom `fetch` implementation for tests. */
  fetchFn?: typeof fetch;
  /** TKT-031: A/B only. Avoid identical viewport-selection work; never skip tick(). */
  experimentSkipUnchangedViewport?: boolean;
  /** TKT-031: A/B only. Avoid propagating identical zoom values to loaded tiles. */
  experimentSkipUnchangedZoom?: boolean;
  /** Optional callback fired whenever diagnostics or loaded tiles change. */
  onDiagnosticsChange?: (diagnostics: TileStreamDiagnosticsSnapshot) => void;
  /** Optional opt-in frame/streaming profiler (defaults to global singleton; zero overhead when disabled). */
  profiler?: StreamingProfiler | null;
}

interface ManagedTileRecord {
  tileKey: string;
  manifest: TileManifestEntry;
  /** Ownership study-world AABB [minX, maxX, minZ, maxZ] */
  worldBounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    centerX: number;
    centerZ: number;
  };
  /** Overhang study-world AABB [minX, maxX, minZ, maxZ] */
  overhangWorldBounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
  state: TileStreamLifecycleState;
  isVisibleInViewport: boolean;
  isInFetchSet: boolean;
  isInKeepSet: boolean;
  priorityScore: number;
  abortController: AbortController | null;
  requestGeneration: number;
  decodedPayload: DecodedTilePayload | null;
  decodedFootprint: TileMemoryFootprint | null;
  reconstructed: ReconstructedTileSceneResult | null;
  lastError: string | null;
  lastCompressedBytes?: number | null;
}

const STREAMED_LAYER_KINDS: ReadonlyArray<Exclude<TileLayerKind, 'ground'>> = [
  'buildings',
  'roads',
  'railways',
  'water',
  'parks',
  'landuse',
  'barriers',
  'foliage',
];

const MAX_TIMING_SAMPLES = 256;

function pushBoundedSample(samples: number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  samples.push(value);
  if (samples.length > MAX_TIMING_SAMPLES) {
    samples.shift();
  }
}

function summarizeTimingSamples(
  samples: readonly number[]
): TileTimingSummaryStats | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < sorted.length; i++) {
    sum += sorted[i];
  }
  const p95Idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(0.95 * (sorted.length - 1)))
  );
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) * 0.5;
  return {
    count: sorted.length,
    minMs: Number(sorted[0].toFixed(3)),
    medianMs: Number(median.toFixed(3)),
    p95Ms: Number(sorted[p95Idx].toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
    avgMs: Number((sum / sorted.length).toFixed(3)),
  };
}

export function computeDecodedTileMemoryFootprint(
  decoded: DecodedTilePayload
): TileMemoryFootprint {
  let cpuGeometryBytes = 0;
  let bvhBytes = 0;
  let meshCount = 0;
  let bvhCount = 0;

  for (const m of decoded.meshes) {
    if (m.layer !== 'ground') {
      meshCount += 1;
    }
    cpuGeometryBytes += m.positions.byteLength;
    cpuGeometryBytes += m.normals?.byteLength ?? 0;
    cpuGeometryBytes += m.uvs?.byteLength ?? 0;
    cpuGeometryBytes += m.switchAttrs?.byteLength ?? 0;
    cpuGeometryBytes += m.colors?.byteLength ?? 0;
    cpuGeometryBytes += m.indices?.byteLength ?? 0;

    if (m.bvh) {
      bvhCount += 1;
      for (const root of m.bvh.roots) {
        bvhBytes += root.byteLength;
      }
      bvhBytes += m.bvh.indirectBuffer?.byteLength ?? 0;
    }
  }

  for (const b of decoded.instancedBatches) {
    meshCount += 1;
    cpuGeometryBytes += b.matrices.byteLength;
    cpuGeometryBytes += b.instanceColors?.byteLength ?? 0;
  }

  return {
    cpuGeometryBytes,
    bvhBytes,
    meshCount,
    instancedBatchCount: decoded.instancedBatches.length,
    bvhCount,
    triangleCount: decoded.totalTriangles,
    vertexCount: decoded.totalVertices,
  };
}

/**
 * Projects the current OrthographicCamera frustum onto the horizontal study-world ground
 * envelope (`y ∈ [-4, 65]`) so tile selection accounts for both ground surfaces and tall
 * elevated structures near screen edges.
 */
export function computeViewportGroundBoundsForCamera(
  camera: THREE.OrthographicCamera,
  target?: { x: number; y?: number; z: number }
): TileViewportGroundBounds {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const focusX = target?.x ?? camera.position.x;
  const focusZ = target?.z ?? camera.position.z;
  const zoom = Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;

  const ndcCorners: ReadonlyArray<[number, number]> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const sampleHeights = [-4, 0, 65];

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let validIntersections = 0;

  const pNear = new THREE.Vector3();
  const pFar = new THREE.Vector3();
  const dir = new THREE.Vector3();

  for (const [ndcX, ndcY] of ndcCorners) {
    pNear.set(ndcX, ndcY, -1).unproject(camera);
    pFar.set(ndcX, ndcY, 1).unproject(camera);
    dir.subVectors(pFar, pNear);

    if (Math.abs(dir.y) > 1e-5) {
      for (const h of sampleHeights) {
        const t = (h - pNear.y) / dir.y;
        const ix = pNear.x + t * dir.x;
        const iz = pNear.z + t * dir.z;
        if (Number.isFinite(ix) && Number.isFinite(iz)) {
          minX = Math.min(minX, ix);
          maxX = Math.max(maxX, ix);
          minZ = Math.min(minZ, iz);
          maxZ = Math.max(maxZ, iz);
          validIntersections++;
        }
      }
    }
  }

  if (validIntersections === 0 || !Number.isFinite(minX)) {
    const halfWidth = Math.abs(camera.right - camera.left) / (2 * zoom);
    const halfHeight = Math.abs(camera.top - camera.bottom) / (2 * zoom);
    const radius = Math.max(halfWidth, halfHeight, 256);
    minX = focusX - radius;
    maxX = focusX + radius;
    minZ = focusZ - radius;
    maxZ = focusZ + radius;
  }

  return {
    minX,
    maxX,
    minZ,
    maxZ,
    focusX,
    focusZ,
    cameraZoom: zoom,
  };
}

/**
 * Strict equality avoids accepting stale tile membership near a cell boundary.
 * We compare the derived ground-plane footprint, not just camera position/zoom:
 * rotating, resizing or changing target alters one or more of these values.
 */
export function equalTileViewportBounds(
  a: TileViewportGroundBounds | null,
  b: TileViewportGroundBounds
): boolean {
  return a !== null &&
    a.minX === b.minX && a.maxX === b.maxX &&
    a.minZ === b.minZ && a.maxZ === b.maxZ &&
    a.focusX === b.focusX && a.focusZ === b.focusZ &&
    a.cameraZoom === b.cameraZoom;
}

function aabbIntersects2D(
  aMinX: number,
  aMaxX: number,
  aMinZ: number,
  aMaxZ: number,
  bMinX: number,
  bMaxX: number,
  bMinZ: number,
  bMaxZ: number
): boolean {
  return aMinX <= bMaxX && aMaxX >= bMinX && aMinZ <= bMaxZ && aMaxZ >= bMinZ;
}

/**
 * Runtime tile streaming controller for M2-A.
 *
 * Determines required 512 m tiles from the camera viewport, preloads a surrounding
 * margin, decodes `OSMTILE1` binary payloads via `TileDecodeClient` (Web Worker),
 * reconstructs tile scenes on a bounded per-frame budget using `TileSceneReconstructor`
 * and a single shared `ThemeMaterialRegistry`, and strictly disposes tile-owned
 * CPU/GPU geometries and BVHs when distant tiles are unloaded.
 */
export class TileStreamManager {
  private readonly apiBaseUrl: string;
  private readonly preloadMarginTiles: number;
  private readonly retainMarginTiles: number;
  private readonly maxConcurrentFetches: number;
  private readonly maxCommitsPerFrame: number;
  private readonly experimentSkipUnchangedViewport: boolean;
  private readonly experimentSkipUnchangedZoom: boolean;
  private readonly materialRegistry: ThemeMaterialRegistry;
  private readonly ownsMaterialRegistry: boolean;
  private readonly foliagePrototypeRegistry: FoliagePrototypeRegistry;
  private readonly ownsFoliagePrototypeRegistry: boolean;
  private readonly decodeClient: TileDecodeClient;
  private readonly ownsDecodeClient: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly onDiagnosticsChange?: (
    diagnostics: TileStreamDiagnosticsSnapshot
  ) => void;
  private profiler: StreamingProfiler | null;

  private readonly regionalResources = new SceneResourceManager();
  private readonly compositeScene: BuiltSceneGeometry;
  // Rebuilt after loading a pack manifest while retaining the mounted THREE.Group identity.
  private boundaryOverlayResult: M1aTileBoundaryOverlayResult;
  private readonly groundMesh: THREE.Mesh;
  private readonly tilesByKey = new Map<string, ManagedTileRecord>();

  private metadata: TilePackMetadata | null = null;
  private manifestStatus: TileManifestLoadStatus = 'idle';
  private manifestPackPath: string | null = null;
  private manifestError: string | null = null;
  private currentTheme: MapStyleTheme;
  private currentCameraZoom: number;
  private foliageConfig: FoliageOptimizationConfig;
  private foliageRuntimeState: FoliageRuntimeState;
  private currentWireframe = false;
  private currentViewport: TileViewportGroundBounds | null = null;
  private previousFocus: { x: number; z: number } | null = null;
  private panLeadVector: { x: number; z: number } = { x: 0, z: 0 };

  private activeFetchCount = 0;
  private requestGenerationCounter = 1;
  private isDisposed = false;

  // Cumulative telemetry counters
  private evictedTilesTotal = 0;
  private cancelledRequestsTotal = 0;
  private duplicateRequestsSkippedTotal = 0;
  private completedLoadsTotal = 0;
  private peakLoadedTiles = 0;
  private peakLoadingTiles = 0;
  private compositeSceneRevision = 0;
  /** Failed fetches may require viewport re-evaluation even if the camera remains still. */
  private needsViewportRefresh = false;
  private viewportSelectionPasses = 0;
  private viewportSelectionSkips = 0;
  private zoomPropagationSkips = 0;
  private lastManifestLoadMs = 0;
  private totalFetchMs = 0;
  private fetchSamples = 0;
  private totalDecodeMs = 0;
  private decodeSamples = 0;
  private totalReconstructMs = 0;
  private reconstructSamples = 0;
  private lastCommitMs = 0;
  private maxCommitMs = 0;
  private readonly fetchMsRing: number[] = [];
  private readonly decodeMsRing: number[] = [];
  private readonly reconstructMsRing: number[] = [];
  private readonly commitMsRing: number[] = [];

  // Idle synchronization waiters
  private idleWaiters: Array<() => void> = [];

  constructor(options: TileStreamManagerOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? '/api/tiles').replace(/\/+$/, '');
    this.preloadMarginTiles = Math.max(0, options.preloadMarginTiles ?? 1);
    this.retainMarginTiles = Math.max(
      this.preloadMarginTiles,
      options.retainMarginTiles ?? this.preloadMarginTiles + 1
    );
    this.maxConcurrentFetches = Math.max(1, options.maxConcurrentFetches ?? 6);
    this.maxCommitsPerFrame = Math.max(1, options.maxCommitsPerFrame ?? 4);
    this.experimentSkipUnchangedViewport = options.experimentSkipUnchangedViewport === true;
    this.experimentSkipUnchangedZoom = options.experimentSkipUnchangedZoom === true;
    this.currentTheme = options.initialTheme ?? MAP_THEMES.tactical;
    this.currentCameraZoom = options.initialCameraZoom ?? 1.0;
    this.foliageConfig = normalizeFoliageOptimizationConfig(
      options.foliageOptimizationConfig
    );
    this.foliageRuntimeState = resolveFoliageRuntimeState(
      this.currentCameraZoom,
      null,
      this.foliageConfig
    );

    if (options.materialRegistry) {
      this.materialRegistry = options.materialRegistry;
      this.ownsMaterialRegistry = false;
    } else {
      this.materialRegistry = new ThemeMaterialRegistry(
        this.currentTheme,
        this.currentCameraZoom
      );
      this.ownsMaterialRegistry = true;
    }

    if (options.foliagePrototypeRegistry) {
      this.foliagePrototypeRegistry = options.foliagePrototypeRegistry;
      this.ownsFoliagePrototypeRegistry = false;
    } else {
      this.foliagePrototypeRegistry = new FoliagePrototypeRegistry();
      this.ownsFoliagePrototypeRegistry = true;
    }

    if (options.decodeClient) {
      this.decodeClient = options.decodeClient;
      this.ownsDecodeClient = false;
    } else {
      this.decodeClient = createTileDecodeClient();
      this.ownsDecodeClient = true;
    }

    this.fetchFn =
      options.fetchFn ??
      ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.onDiagnosticsChange = options.onDiagnosticsChange;
    this.profiler =
      options.profiler === undefined
        ? getGlobalStreamingProfiler()
        : options.profiler;

    // Top-level composite layer groups mounted by MapScene.tsx
    const buildingsGroup = new THREE.Group();
    buildingsGroup.name = 'Buildings';
    const roadsGroup = new THREE.Group();
    roadsGroup.name = 'Roads';
    const railwaysGroup = new THREE.Group();
    railwaysGroup.name = 'Railways';
    const waterGroup = new THREE.Group();
    waterGroup.name = 'Water';
    waterGroup.renderOrder = 2;
    const parksGroup = new THREE.Group();
    parksGroup.name = 'Parks';
    parksGroup.renderOrder = 3;
    const landuseGroup = new THREE.Group();
    landuseGroup.name = 'Landuse';
    landuseGroup.renderOrder = 1;
    const barriersGroup = new THREE.Group();
    barriersGroup.name = 'Barriers';
    const foliageGroup = new THREE.Group();
    foliageGroup.name = 'Foliage';

    const grid = createHengeloStudyGrid();
    const spanX = grid.cols * grid.tileSizeMeters;
    const spanZ = grid.rows * grid.tileSizeMeters;
    const groundGeo = this.regionalResources.registerGeometry(
      new THREE.PlaneGeometry(spanX + 1024, spanZ + 1024, 1, 1)
    );
    groundGeo.rotateX(-Math.PI / 2);
    this.groundMesh = new THREE.Mesh(
      groundGeo,
      this.materialRegistry.getMaterial('ground')
    );
    this.groundMesh.name = 'GroundPlane_M2A_Regional';
    this.groundMesh.position.set(0, -0.015, 0);
    this.groundMesh.receiveShadow = true;

    this.boundaryOverlayResult = createM1aTileBoundaryOverlay(grid);
    this.boundaryOverlayResult.group.visible = true;

    railwaysGroup.userData.railwayStats = {
      sleeper3DBoxCount: 0,
      railwayRenderSource: 'graph_extrusion',
    };
    railwaysGroup.userData.updateCameraZoom = (zoom: number) =>
      this.updateCameraZoom(zoom);
    foliageGroup.userData.getFoliageRuntimeState = () =>
      this.foliageRuntimeState;
    foliageGroup.userData.getFoliageOptimizationConfig = () =>
      this.foliageConfig;
    foliageGroup.userData.getFoliagePrototypeRegistry = () =>
      this.foliagePrototypeRegistry;
    foliageGroup.userData.setFoliageOptimizationConfig = (
      partial: Partial<FoliageOptimizationConfig>
    ) => this.setFoliageOptimizationConfig(partial);

    this.compositeScene = {
      buildingsGroup,
      roadsGroup,
      railwaysGroup,
      waterGroup,
      parksGroup,
      landuseGroup,
      barriersGroup,
      foliageGroup,
      groundMesh: this.groundMesh,
      interactiveMeshes: {
        buildings: [],
      },
      stats: {
        totalVertices: 0,
        totalTriangles: 0,
        totalDrawCalls: 0,
        renderedFeaturesCount: 0,
        forestTreesCount: 0,
      },
      resources: this.regionalResources,
      infrastructureRenderOptions: { ...DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS },
      infrastructureRenderPreview: null,
      dispose: () => this.dispose(),
      updateTheme: (newTheme: MapStyleTheme) => this.updateTheme(newTheme),
      updateCameraZoom: (zoom: number) => this.updateCameraZoom(zoom),
    };
  }

  get scene(): BuiltSceneGeometry {
    return this.compositeScene;
  }

  get tileBoundaryOverlay(): THREE.Group {
    return this.boundaryOverlayResult.group;
  }

  get sharedMaterialRegistry(): ThemeMaterialRegistry {
    return this.materialRegistry;
  }

  get sharedFoliagePrototypeRegistry(): FoliagePrototypeRegistry {
    return this.foliagePrototypeRegistry;
  }

  setProfiler(profiler: StreamingProfiler | null): void {
    this.profiler = profiler;
  }

  private getQueueDepthSnapshot(): StreamingQueueDepths {
    let queued = 0;
    let fetching = 0;
    let decoding = 0;
    let readyToCommit = 0;
    let loaded = 0;
    let visible = 0;
    for (const r of this.tilesByKey.values()) {
      if (r.isVisibleInViewport) visible += 1;
      if (r.state === 'queued') queued += 1;
      else if (r.state === 'fetching') fetching += 1;
      else if (r.state === 'decoding') decoding += 1;
      else if (r.state === 'ready_to_commit') readyToCommit += 1;
      else if (r.state === 'loaded') loaded += 1;
    }
    return { queued, fetching, decoding, readyToCommit, loaded, visible };
  }

  getFoliageOptimizationConfig(): FoliageOptimizationConfig {
    return { ...this.foliageConfig };
  }

  getFoliageRuntimeState(): FoliageRuntimeState {
    return { ...this.foliageRuntimeState };
  }

  setFoliageOptimizationConfig(
    partial: Partial<FoliageOptimizationConfig>
  ): FoliageRuntimeState {
    if (this.isDisposed) {
      return { ...this.foliageRuntimeState };
    }
    const nextConfig = normalizeFoliageOptimizationConfig({
      ...this.foliageConfig,
      ...partial,
    });
    if (equalFoliageOptimizationConfig(this.foliageConfig, nextConfig)) {
      return { ...this.foliageRuntimeState };
    }
    this.foliageConfig = nextConfig;
    const nextState = resolveFoliageRuntimeState(
      this.currentCameraZoom,
      null,
      this.foliageConfig
    );
    this.foliageRuntimeState = nextState;
    for (const record of this.tilesByKey.values()) {
      if (record.state === 'loaded' && record.reconstructed) {
        record.reconstructed.applyFoliageRuntimeState(nextState);
      }
    }
    this.emitDiagnostics();
    return { ...nextState };
  }

  get packMetadata(): TilePackMetadata | null {
    return this.metadata;
  }

  get packPath(): string | null {
    return this.manifestPackPath;
  }

  get activeMosaicName(): string | null {
    return deriveActiveMosaicNameFromPackPath(this.manifestPackPath);
  }

  get currentManifestStatus(): TileManifestLoadStatus {
    return this.manifestStatus;
  }

  getManifestCoverageSummary(): TileManifestCoverageSummary | null {
    if (this.manifestStatus !== 'loaded' || !this.metadata) {
      return null;
    }
    let nonEmptyTiles = 0;
    let emptyTiles = 0;
    let minE = Number.POSITIVE_INFINITY;
    let maxE = Number.NEGATIVE_INFINITY;
    let minN = Number.POSITIVE_INFINITY;
    let maxN = Number.NEGATIVE_INFINITY;
    let minTx = Number.POSITIVE_INFINITY;
    let maxTx = Number.NEGATIVE_INFINITY;
    let minTy = Number.POSITIVE_INFINITY;
    let maxTy = Number.NEGATIVE_INFINITY;

    for (const record of this.tilesByKey.values()) {
      const m = record.manifest;
      if (m.isEmpty) {
        emptyTiles += 1;
      } else {
        nonEmptyTiles += 1;
      }
      if (m.minEasting < minE) minE = m.minEasting;
      if (m.maxEasting > maxE) maxE = m.maxEasting;
      if (m.minNorthing < minN) minN = m.minNorthing;
      if (m.maxNorthing > maxN) maxN = m.maxNorthing;
      if (m.tx < minTx) minTx = m.tx;
      if (m.ty < minTy) minTy = m.ty;
      if (m.tx > maxTx) maxTx = m.tx;
      if (m.ty > maxTy) maxTy = m.ty;
    }

    const hasBounds = Number.isFinite(minE) && Number.isFinite(maxE) && Number.isFinite(minN) && Number.isFinite(maxN);
    let boundsGeo: TileManifestCoverageSummary['boundsGeo'] = null;
    if (hasBounds) {
      const sw = utm32NToGeo(minE, minN);
      const nw = utm32NToGeo(minE, maxN);
      const se = utm32NToGeo(maxE, minN);
      const ne = utm32NToGeo(maxE, maxN);
      boundsGeo = {
        minLon: Math.min(sw[0], nw[0], se[0], ne[0]),
        maxLon: Math.max(sw[0], nw[0], se[0], ne[0]),
        minLat: Math.min(sw[1], nw[1], se[1], ne[1]),
        maxLat: Math.max(sw[1], nw[1], se[1], ne[1]),
      };
    }

    const cols = this.metadata.gridCols;
    const rows = this.metadata.gridRows;
    const shardCountEstimate =
      cols >= 4 && rows >= 4 && cols % 4 === 0 && rows % 4 === 0
        ? (cols / 4) * (rows / 4)
        : null;

    return {
      totalTiles: this.tilesByKey.size,
      nonEmptyTiles,
      emptyTiles,
      gridCols: cols,
      gridRows: rows,
      tileSizeMeters: this.metadata.tileSizeMeters,
      studyOriginEasting: this.metadata.studyOriginEasting,
      studyOriginNorthing: this.metadata.studyOriginNorthing,
      boundsUtm: hasBounds
        ? { minEasting: minE, maxEasting: maxE, minNorthing: minN, maxNorthing: maxN }
        : null,
      boundsGeo,
      minTx: Number.isFinite(minTx) ? minTx : this.metadata.minTx ?? null,
      maxTx: Number.isFinite(maxTx) ? maxTx : this.metadata.maxTx ?? null,
      minTy: Number.isFinite(minTy) ? minTy : this.metadata.minTy ?? null,
      maxTy: Number.isFinite(maxTy) ? maxTy : this.metadata.maxTy ?? null,
      shardCountEstimate,
      compression: this.metadata.compression ?? 'deflate',
      projection: this.metadata.projectionId,
      createdAt: this.metadata.createdAtIso,
    };
  }

  setBoundaryOverlayVisible(visible: boolean): void {
    this.boundaryOverlayResult.group.visible = visible;
  }

  /**
   * Clears any currently loaded tiles and manifest metadata so a reload or
   * failed manifest fetch can never report a previous dataset as active.
   */
  private resetLoadedManifestState(): void {
    let detachedAny = false;
    for (const record of this.tilesByKey.values()) {
      if (record.abortController) {
        record.abortController.abort();
        record.abortController = null;
      }
      if (record.reconstructed) {
        this.detachTileFromCompositeScene(record);
        record.reconstructed.dispose();
        record.reconstructed = null;
        detachedAny = true;
      }
      record.decodedPayload = null;
      record.decodedFootprint = null;
      record.state = 'unloaded';
    }
    this.tilesByKey.clear();
    this.metadata = null;
    this.manifestPackPath = null;
    this.currentViewport = null;
    this.needsViewportRefresh = false;
    this.previousFocus = null;
    this.panLeadVector = { x: 0, z: 0 };
    if (detachedAny) {
      this.rebuildCompositeStats();
    }
  }

  /**
   * Initializes the stream manager from `/api/tiles/manifest` or a pre-loaded manifest payload.
   */
  async initialize(
    manifestOverride?: TilePackManifestPayload
  ): Promise<TilePackMetadata> {
    if (this.isDisposed) {
      throw new Error('TileStreamManager has been disposed.');
    }
    const t0 = performance.now();
    this.resetLoadedManifestState();
    this.manifestStatus = 'loading';
    this.manifestError = null;
    this.emitDiagnostics();

    let payload: TilePackManifestPayload;
    try {
      if (manifestOverride) {
        payload = manifestOverride;
      } else {
        const response = await this.fetchFn(`${this.apiBaseUrl}/manifest`);
        if (!response.ok) {
          let errorMessage = `Failed to load tile manifest (HTTP ${response.status})`;
          try {
            const errJson = (await response.json()) as { error?: string };
            if (errJson?.error) {
              errorMessage = errJson.error;
            }
          } catch {
            // ignore
          }
          throw new Error(errorMessage);
        }
        payload = (await response.json()) as TilePackManifestPayload;
      }

      if (
        !payload ||
        payload.available === false ||
        !payload.metadata ||
        !Array.isArray(payload.tiles)
      ) {
        throw new Error('Tile manifest response is unavailable or malformed.');
      }
    } catch (err) {
      this.resetLoadedManifestState();
      this.manifestStatus = 'error';
      this.manifestError = err instanceof Error ? err.message : String(err);
      this.emitDiagnostics();
      throw err;
    }

    if (this.isDisposed) {
      throw new Error('TileStreamManager has been disposed.');
    }

    // A valid HTTP manifest is not enough: tile and overlay setup can still fail.
    // Keep diagnostics in the loading state until the complete setup succeeds.
    try {
      this.lastManifestLoadMs = performance.now() - t0;
      this.metadata = payload.metadata;
      this.manifestPackPath =
        typeof payload.packPath === 'string' && payload.packPath.trim().length > 0
          ? payload.packPath.trim()
          : null;
      this.tilesByKey.clear();
      this.currentViewport = null;
      this.needsViewportRefresh = false;
      this.previousFocus = null;
      this.panLeadVector = { x: 0, z: 0 };

      // The original 4km study ground plane is insufficient for larger baked regions.
      // Keep the same scene/mesh identity while resizing only its geometry.
      const regionWidth = payload.metadata.gridCols * payload.metadata.tileSizeMeters;
      const regionDepth = payload.metadata.gridRows * payload.metadata.tileSizeMeters;
      this.groundMesh.userData.__regionalStreamingWidthMeters = regionWidth;
      if (regionWidth > 0 && regionDepth > 0) {
        const oldGeometry = this.groundMesh.geometry;
        const groundGeometry = this.regionalResources.registerGeometry(
          new THREE.PlaneGeometry(regionWidth + 1024, regionDepth + 1024, 1, 1)
        );
        groundGeometry.rotateX(-Math.PI / 2);
        this.groundMesh.geometry = groundGeometry;
        oldGeometry.dispose();
      }

      const originEasting = payload.metadata.studyOriginEasting;
      const originNorthing = payload.metadata.studyOriginNorthing;

      for (const entry of payload.tiles) {
        const minX = entry.minEasting - originEasting;
        const maxX = entry.maxEasting - originEasting;
        const minZ = originNorthing - entry.maxNorthing;
        const maxZ = originNorthing - entry.minNorthing;

        const ovMinX = entry.tileCenterX + entry.overhangMinX;
        const ovMaxX = entry.tileCenterX + entry.overhangMaxX;
        const ovMinZ = entry.tileCenterZ + entry.overhangMinZ;
        const ovMaxZ = entry.tileCenterZ + entry.overhangMaxZ;

        const tileKey = formatTileId(entry.tx, entry.ty);
        this.tilesByKey.set(tileKey, {
          tileKey,
          manifest: entry,
          worldBounds: {
            minX,
            maxX,
            minZ,
            maxZ,
            centerX: (minX + maxX) * 0.5,
            centerZ: (minZ + maxZ) * 0.5,
          },
          overhangWorldBounds: {
            minX: Math.min(minX, ovMinX),
            maxX: Math.max(maxX, ovMaxX),
            minZ: Math.min(minZ, ovMinZ),
            maxZ: Math.max(maxZ, ovMaxZ),
          },
          state: 'unloaded',
          isVisibleInViewport: false,
          isInFetchSet: false,
          isInKeepSet: false,
          priorityScore: Number.POSITIVE_INFINITY,
          abortController: null,
          requestGeneration: 0,
          decodedPayload: null,
          decodedFootprint: null,
          reconstructed: null,
          lastError: null,
          lastCompressedBytes: null,
        });
      }

      this.rebuildBoundaryOverlayFromManifest(payload.metadata);
      // Only advertise an active mosaic once all tile records and overlays exist.
      this.manifestStatus = 'loaded';
      this.manifestError = null;
      this.emitDiagnostics();
      return payload.metadata;
    } catch (err) {
      this.resetLoadedManifestState();
      this.manifestStatus = 'error';
      this.manifestError = err instanceof Error ? err.message : String(err);
      this.emitDiagnostics();
      throw err;
    }
  }

  private rebuildBoundaryOverlayFromManifest(metadata: TilePackMetadata): void {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const record of this.tilesByKey.values()) {
      if (record.worldBounds.minX < minX) minX = record.worldBounds.minX;
      if (record.worldBounds.maxX > maxX) maxX = record.worldBounds.maxX;
      if (record.worldBounds.minZ < minZ) minZ = record.worldBounds.minZ;
      if (record.worldBounds.maxZ > maxZ) maxZ = record.worldBounds.maxZ;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
      const halfSpanX = (metadata.gridCols * metadata.tileSizeMeters) / 2;
      const halfSpanZ = (metadata.gridRows * metadata.tileSizeMeters) / 2;
      minX = -halfSpanX;
      maxX = halfSpanX;
      minZ = -halfSpanZ;
      maxZ = halfSpanZ;
    }

    const prevGroup = this.boundaryOverlayResult.group;
    const wasVisible = prevGroup.visible;
    this.boundaryOverlayResult.dispose();
    prevGroup.clear();

    const syntheticGridSpec = {
      cols: metadata.gridCols,
      rows: metadata.gridRows,
      tileSizeMeters: metadata.tileSizeMeters,
      studyLocalBounds: {
        minX,
        maxX,
        minZ,
        maxZ,
        includeMaxEdgeX: true,
        includeMaxEdgeZ: true,
      },
      tiles: new Array(this.tilesByKey.size),
    } as unknown as StudyGridSpec;

    const nextOverlay = createM1aTileBoundaryOverlay(syntheticGridSpec);
    while (nextOverlay.group.children.length > 0) {
      const child = nextOverlay.group.children[0];
      nextOverlay.group.remove(child);
      prevGroup.add(child);
    }
    prevGroup.visible = wasVisible;

    this.boundaryOverlayResult = {
      group: prevGroup,
      tileCount: nextOverlay.tileCount,
      internalSeamCount: nextOverlay.internalSeamCount,
      dispose: nextOverlay.dispose,
    };
  }

  /**
   * Updates the active viewport from an OrthographicCamera and pumps fetch/commit queues.
   */
  updateFromCamera(
    camera: THREE.OrthographicCamera,
    target?: { x: number; y?: number; z: number }
  ): void {
    if (this.isDisposed || !this.metadata) return;
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;

    const tBounds0 = prof ? performance.now() : 0;
    const bounds = computeViewportGroundBoundsForCamera(camera, target);
    const boundsMs = prof ? performance.now() - tBounds0 : 0;

    let zoomSyncMs = 0;
    if (bounds.cameraZoom !== undefined) {
      const tZoom0 = prof ? performance.now() : 0;
      this.updateCameraZoom(bounds.cameraZoom);
      if (prof) zoomSyncMs = performance.now() - tZoom0;
    }
    if (prof) {
      prof.recordViewportBoundsDuration(boundsMs, zoomSyncMs);
    }

    if (this.experimentSkipUnchangedViewport &&
        !this.needsViewportRefresh &&
        equalTileViewportBounds(this.currentViewport, bounds)) {
      this.viewportSelectionSkips++;
    } else {
      this.updateViewport(bounds);
    }
    // Keep draining completed worker decodes even when the camera is stationary.
    this.tick();
    if (prof) {
      prof.recordQueueDepths(this.getQueueDepthSnapshot());
    }
  }

  /**
   * Re-evaluates visible, preload (`fetchSet`), and retention (`keepSet`) tiles
   * for the given ground-plane viewport bounds, cancels obsolete in-flight fetches,
   * evicts distant loaded tiles, and schedules high-priority tile loads.
   */
  updateViewport(viewport: TileViewportGroundBounds): void {
    if (this.isDisposed || !this.metadata) return;
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    const tTotal0 = prof ? performance.now() : 0;

    this.currentViewport = viewport;
    this.needsViewportRefresh = false;
    this.viewportSelectionPasses++;

    const tScan0 = prof ? performance.now() : 0;
    if (this.previousFocus) {
      const dx = viewport.focusX - this.previousFocus.x;
      const dz = viewport.focusZ - this.previousFocus.z;
      const len = Math.hypot(dx, dz);
      if (len > 1.0) {
        const scale = Math.min(len, this.metadata.tileSizeMeters * 0.5) / len;
        this.panLeadVector = { x: dx * scale, z: dz * scale };
      } else {
        this.panLeadVector = { x: 0, z: 0 };
      }
    }
    this.previousFocus = { x: viewport.focusX, z: viewport.focusZ };

    const tileSize = this.metadata.tileSizeMeters;
    const fetchMarginMeters = this.preloadMarginTiles * tileSize;
    const keepMarginMeters = this.retainMarginTiles * tileSize;

    const fetchMinX = viewport.minX - fetchMarginMeters;
    const fetchMaxX = viewport.maxX + fetchMarginMeters;
    const fetchMinZ = viewport.minZ - fetchMarginMeters;
    const fetchMaxZ = viewport.maxZ + fetchMarginMeters;

    const keepMinX = viewport.minX - keepMarginMeters;
    const keepMaxX = viewport.maxX + keepMarginMeters;
    const keepMinZ = viewport.minZ - keepMarginMeters;
    const keepMaxZ = viewport.maxZ + keepMarginMeters;

    const leadFocusX = viewport.focusX + this.panLeadVector.x;
    const leadFocusZ = viewport.focusZ + this.panLeadVector.z;

    let anyEvictedOrCancelled = false;
    let cancelInFlightMs = 0;
    let evictDisposeMs = 0;
    let tilesEvictedCount = 0;
    let tilesCancelledCount = 0;

    for (const record of this.tilesByKey.values()) {
      const wb = record.worldBounds;
      const ob = record.overhangWorldBounds;

      const isVisible = aabbIntersects2D(
        ob.minX,
        ob.maxX,
        ob.minZ,
        ob.maxZ,
        viewport.minX,
        viewport.maxX,
        viewport.minZ,
        viewport.maxZ
      );
      const isInFetch =
        isVisible ||
        aabbIntersects2D(
          wb.minX,
          wb.maxX,
          wb.minZ,
          wb.maxZ,
          fetchMinX,
          fetchMaxX,
          fetchMinZ,
          fetchMaxZ
        );
      const isInKeep =
        isInFetch ||
        aabbIntersects2D(
          wb.minX,
          wb.maxX,
          wb.minZ,
          wb.maxZ,
          keepMinX,
          keepMaxX,
          keepMinZ,
          keepMaxZ
        );

      record.isVisibleInViewport = isVisible;
      record.isInFetchSet = isInFetch;
      record.isInKeepSet = isInKeep;

      const distToFocus = Math.hypot(
        wb.centerX - leadFocusX,
        wb.centerZ - leadFocusZ
      );
      // Visible tiles get a -1,000,000 priority boost so they always load before preload margin tiles
      record.priorityScore = (isVisible ? -1_000_000 : 0) + distToFocus;

      if (!isInKeep) {
        // Cancel any queued, fetching, decoding, or uncommitted tile outside keepSet
        if (
          record.state === 'queued' ||
          record.state === 'fetching' ||
          record.state === 'decoding' ||
          record.state === 'ready_to_commit'
        ) {
          const tCancel0 = prof ? performance.now() : 0;
          this.cancelInFlightTile(record);
          if (prof) {
            cancelInFlightMs += performance.now() - tCancel0;
            tilesCancelledCount += 1;
          }
          anyEvictedOrCancelled = true;
        } else if (record.state === 'loaded') {
          const tEvict0 = prof ? performance.now() : 0;
          this.evictLoadedTile(record);
          if (prof) {
            evictDisposeMs += performance.now() - tEvict0;
            tilesEvictedCount += 1;
          }
          anyEvictedOrCancelled = true;
        }
      } else if (!isInFetch && record.state === 'queued') {
        // Tile drifted from fetchSet into hysteresis keep-only band before fetch even started
        const tCancel0 = prof ? performance.now() : 0;
        this.cancelInFlightTile(record);
        if (prof) {
          cancelInFlightMs += performance.now() - tCancel0;
          tilesCancelledCount += 1;
        }
        anyEvictedOrCancelled = true;
      }

      if (isInFetch) {
        if (record.state === 'unloaded' || record.state === 'error') {
          record.state = 'queued';
          record.lastError = null;
        } else if (
          record.state === 'fetching' ||
          record.state === 'decoding' ||
          record.state === 'ready_to_commit'
        ) {
          this.duplicateRequestsSkippedTotal += 1;
        }
      }
    }

    const rawScanAndActionMs = prof ? performance.now() - tScan0 : 0;
    const tileScanMs = prof
      ? Math.max(0, rawScanAndActionMs - cancelInFlightMs - evictDisposeMs)
      : 0;

    const tPump0 = prof ? performance.now() : 0;
    this.pumpFetchQueue();
    const pumpFetchQueueMs = prof ? performance.now() - tPump0 : 0;

    this.updatePeakTileCounters();
    let evictRebuildStatsMs = 0;
    let evictEmitDiagnosticsMs = 0;
    if (anyEvictedOrCancelled) {
      const tStats0 = prof ? performance.now() : 0;
      this.rebuildCompositeStats();
      if (prof) evictRebuildStatsMs = performance.now() - tStats0;

      const tDiag0 = prof ? performance.now() : 0;
      this.emitDiagnostics();
      if (prof) evictEmitDiagnosticsMs = performance.now() - tDiag0;
    }
    this.checkIdleWaiters();

    if (prof) {
      prof.recordViewportUpdate({
        totalMs: performance.now() - tTotal0,
        tileScanMs,
        cancelInFlightMs,
        evictDisposeMs,
        evictRebuildStatsMs,
        evictEmitDiagnosticsMs,
        pumpFetchQueueMs,
        tilesEvictedCount,
        tilesCancelledCount,
      });
    }
  }

  /**
   * Commits up to `maxCommits` decoded tiles (`ready_to_commit`) into the Three.js
   * composite scene graph on the main thread.
   */
  tick(maxCommits = this.maxCommitsPerFrame): number {
    if (this.isDisposed) return 0;
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    const tTick0 = prof ? performance.now() : 0;

    this.pumpFetchQueue();

    const tReady0 = prof ? performance.now() : 0;
    const readyRecords: ManagedTileRecord[] = [];
    for (const record of this.tilesByKey.values()) {
      if (record.state === 'ready_to_commit' && record.isInKeepSet) {
        readyRecords.push(record);
      }
    }

    if (readyRecords.length === 0) {
      this.checkIdleWaiters();
      if (prof) {
        const tickTotal = performance.now() - tTick0;
        prof.recordStreamTick({
          totalMs: tickTotal,
          readyScanAndSortMs: performance.now() - tReady0,
          reconstructMs: 0,
          instancedBvhBuildMs: 0,
          staticBvhDeserializeMs: 0,
          sceneAttachMs: 0,
          commitRebuildStatsMs: 0,
          commitEmitDiagnosticsMs: 0,
          tilesCommittedCount: 0,
        });
      }
      return 0;
    }

    readyRecords.sort((a, b) => a.priorityScore - b.priorityScore);
    const readyScanAndSortMs = prof ? performance.now() - tReady0 : 0;

    const limit = Math.min(maxCommits, readyRecords.length);
    let committed = 0;
    let totalReconMs = 0;
    let totalInstancedBvhMs = 0;
    let totalStaticBvhMs = 0;
    let totalAttachMs = 0;
    const tileSizeMeters = this.metadata?.tileSizeMeters ?? 1024;
    const tBatch0 = performance.now();

    for (let i = 0; i < limit; i++) {
      const record = readyRecords[i];
      if (!record.decodedPayload) continue;

      const footprintSnapshot = record.decodedFootprint;
      const compressedBytes = record.lastCompressedBytes ?? null;
      const rawBytes = footprintSnapshot
        ? footprintSnapshot.cpuGeometryBytes + footprintSnapshot.bvhBytes
        : null;

      if (prof) {
        prof.recordEvent({
          eventType: 'reconstruct_start',
          tileKey: record.tileKey,
          tileSizeMeters,
          lod: record.manifest.lod,
          payloadCompressedBytes: compressedBytes,
          payloadRawBytes: rawBytes,
          queueDepths: this.getQueueDepthSnapshot(),
        });
      }

      const t0 = performance.now();
      const reconstructed = reconstructTileSceneFromDecoded(
        record.decodedPayload,
        {
          materialRegistry: this.materialRegistry,
          placementMode: 'study-world-mesh-offset',
          initialCameraZoom: this.currentCameraZoom,
          foliagePrototypeRegistry: this.foliagePrototypeRegistry,
          foliageRuntimeState: this.foliageRuntimeState,
          collectStageTimings: Boolean(prof),
        }
      );
      const reconstructMs = performance.now() - t0;

      this.totalReconstructMs += reconstructMs;
      this.reconstructSamples += 1;
      pushBoundedSample(this.reconstructMsRing, reconstructMs);

      record.reconstructed = reconstructed;
      record.decodedPayload = null;
      record.state = 'loaded';
      this.completedLoadsTotal += 1;

      if (prof) {
        totalReconMs += reconstructMs;
        totalInstancedBvhMs += reconstructed.stageTimings.instancedBvhBuildMs;
        totalStaticBvhMs += reconstructed.stageTimings.staticBvhDeserializeMs;
        prof.recordEvent({
          eventType: 'reconstruct_complete',
          tileKey: record.tileKey,
          tileSizeMeters,
          lod: record.manifest.lod,
          payloadCompressedBytes: compressedBytes,
          payloadRawBytes:
            rawBytes !== null
              ? rawBytes + reconstructed.instancedPickingStats.totalIndexMemoryBytes
              : null,
          durationMs: reconstructMs,
          queueDepths: this.getQueueDepthSnapshot(),
          detail: {
            instancedBvhBuildMs: reconstructed.stageTimings.instancedBvhBuildMs,
            staticBvhDeserializeMs: reconstructed.stageTimings.staticBvhDeserializeMs,
            instancedBatchCount: reconstructed.instancedPickingStats.indexedBatchCount,
            indexedInstances: reconstructed.instancedPickingStats.totalIndexedInstances,
            meshCount: footprintSnapshot?.meshCount,
            triangleCount: footprintSnapshot?.triangleCount,
          },
        });
      }

      const tAttach0 = prof ? performance.now() : 0;
      this.attachTileToCompositeScene(record);
      const attachMs = prof ? performance.now() - tAttach0 : 0;
      if (prof) {
        totalAttachMs += attachMs;
        const attachNowMs = performance.now();
        prof.recordEvent({
          eventType: 'attach',
          tileKey: record.tileKey,
          tileSizeMeters,
          lod: record.manifest.lod,
          timestampMs: attachNowMs,
          payloadCompressedBytes: compressedBytes,
          payloadRawBytes: rawBytes,
          durationMs: attachMs,
          queueDepths: this.getQueueDepthSnapshot(),
          detail: {
            meshCount: footprintSnapshot?.meshCount,
            triangleCount: footprintSnapshot?.triangleCount,
          },
        });
        prof.markTilePendingFirstRender({
          tileKey: record.tileKey,
          tileSizeMeters,
          lod: record.manifest.lod,
          triangles: reconstructed.scene.stats.totalTriangles,
          meshes: footprintSnapshot?.meshCount ?? 0,
          compressedBytes,
          rawBytes,
          attachTimestampMs: attachNowMs,
        });
      }

      committed += 1;
    }

    let commitRebuildStatsMs = 0;
    let commitEmitDiagnosticsMs = 0;
    if (committed > 0) {
      const batchCommitMs = performance.now() - tBatch0;
      this.lastCommitMs = batchCommitMs;
      this.maxCommitMs = Math.max(this.maxCommitMs, batchCommitMs);
      pushBoundedSample(this.commitMsRing, batchCommitMs);

      if (this.currentWireframe) {
        this.materialRegistry.setWireframe(true);
      }
      const tStats0 = prof ? performance.now() : 0;
      this.rebuildCompositeStats();
      if (prof) commitRebuildStatsMs = performance.now() - tStats0;

      const tDiag0 = prof ? performance.now() : 0;
      this.emitDiagnostics();
      if (prof) commitEmitDiagnosticsMs = performance.now() - tDiag0;
    }

    this.checkIdleWaiters();
    if (prof) {
      prof.recordStreamTick({
        totalMs: performance.now() - tTick0,
        readyScanAndSortMs,
        reconstructMs: totalReconMs,
        instancedBvhBuildMs: totalInstancedBvhMs,
        staticBvhDeserializeMs: totalStaticBvhMs,
        sceneAttachMs: totalAttachMs,
        commitRebuildStatsMs,
        commitEmitDiagnosticsMs,
        tilesCommittedCount: committed,
      });
    }
    return committed;
  }

  /**
   * Waits until all tiles in the current `fetchSet` have finished fetching,
   * decoding, and committing to the scene graph.
   */
  async waitForIdle(): Promise<void> {
    while (!this.isDisposed) {
      this.tick(Number.MAX_SAFE_INTEGER);
      if (this.isCurrentlyIdle()) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.idleWaiters.push(resolve);
      });
    }
  }

  updateTheme(newTheme: MapStyleTheme): void {
    if (this.isDisposed) return;
    this.currentTheme = newTheme;
    this.materialRegistry.applyTheme(newTheme);
    this.boundaryOverlayResult.group.traverse((child) => {
      if (child.name === 'M1a_InternalTileSeams' && (child as THREE.LineSegments).material) {
        const mat = (child as THREE.LineSegments).material as THREE.LineBasicMaterial;
        mat.color.set(newTheme.id === 'daylight' ? '#0284c7' : '#22d3ee');
      }
    });
  }

  updateCameraZoom(zoom: number): void {
    if (this.isDisposed) return;
    if (this.experimentSkipUnchangedZoom && zoom === this.currentCameraZoom) {
      this.zoomPropagationSkips++;
      return;
    }
    this.currentCameraZoom = zoom;
    this.materialRegistry.setCameraZoom(zoom);

    const prevFoliage = this.foliageRuntimeState;
    const nextFoliage = resolveFoliageRuntimeState(
      zoom,
      prevFoliage,
      this.foliageConfig
    );
    const foliageBehaviorChanged =
      nextFoliage.activeLod !== prevFoliage.activeLod ||
      nextFoliage.trunksVisible !== prevFoliage.trunksVisible ||
      nextFoliage.frustumCullingEnabled !== prevFoliage.frustumCullingEnabled ||
      nextFoliage.optimizationEnabled !== prevFoliage.optimizationEnabled;
    this.foliageRuntimeState = nextFoliage;

    for (const record of this.tilesByKey.values()) {
      if (record.state === 'loaded' && record.reconstructed) {
        record.reconstructed.scene.updateCameraZoom?.(zoom);
        if (foliageBehaviorChanged) {
          record.reconstructed.applyFoliageRuntimeState(nextFoliage);
        }
      }
    }
  }

  setWireframe(enabled: boolean): void {
    if (this.isDisposed) return;
    this.currentWireframe = enabled;
    this.materialRegistry.setWireframe(enabled);
  }

  getTileState(tileKey: string): TileStreamLifecycleState {
    return this.tilesByKey.get(tileKey)?.state ?? 'unloaded';
  }

  getDiagnostics(): TileStreamDiagnosticsSnapshot {
    let visibleTiles = 0;
    let fetchTargetTiles = 0;
    let keepTargetTiles = 0;
    let loadedTiles = 0;
    let emptyLoadedTiles = 0;
    let queuedTiles = 0;
    let fetchingTiles = 0;
    let decodingTiles = 0;
    let readyToCommitTiles = 0;
    let failedTiles = 0;

    let loadedMeshCount = 0;
    let visibleMeshCount = 0;
    let loadedTriangles = 0;
    let loadedVertices = 0;
    let loadedDrawCallsEstimate = 0;
    let activeTileGeometries = 0;
    let activeTileBvhs = 0;
    let tileCpuGeometryBytes = 0;
    let tileBvhBytes = 0;
    let tileInstancedIndexBytes = 0;
    let tileInstancedIndexCount = 0;
    let tileInstancedIndexInstances = 0;
    let tileInstancedIndexBuildMsTotal = 0;

    const loadedTileKeys: string[] = [];
    const visibleTileKeys: string[] = [];
    const loadingTileKeys: string[] = [];

    for (const [key, record] of this.tilesByKey.entries()) {
      if (record.isVisibleInViewport) {
        visibleTiles += 1;
        visibleTileKeys.push(key);
      }
      if (record.isInFetchSet) fetchTargetTiles += 1;
      if (record.isInKeepSet) keepTargetTiles += 1;

      if (record.state === 'loaded') {
        loadedTiles += 1;
        loadedTileKeys.push(key);
        if (record.manifest.isEmpty) {
          emptyLoadedTiles += 1;
        }
        const fp = record.decodedFootprint;
        if (fp) {
          loadedMeshCount += fp.meshCount;
          if (record.isVisibleInViewport) {
            visibleMeshCount += fp.meshCount;
          }
          loadedTriangles += fp.triangleCount;
          loadedVertices += fp.vertexCount;
          activeTileBvhs += fp.bvhCount;
          tileCpuGeometryBytes += fp.cpuGeometryBytes;
          tileBvhBytes += fp.bvhBytes;
        }
        if (record.reconstructed) {
          loadedDrawCallsEstimate +=
            record.reconstructed.scene.stats.totalDrawCalls;
          activeTileGeometries +=
            record.reconstructed.scene.resources.ownedGeometriesCount;
          const pStats = record.reconstructed.instancedPickingStats;
          if (pStats) {
            tileInstancedIndexBytes += pStats.totalIndexMemoryBytes;
            tileInstancedIndexCount += pStats.indexedBatchCount;
            tileInstancedIndexInstances += pStats.totalIndexedInstances;
            tileInstancedIndexBuildMsTotal += pStats.totalBuildTimeMs;
          }
        }
      } else if (record.state === 'queued') {
        queuedTiles += 1;
        loadingTileKeys.push(key);
      } else if (record.state === 'fetching') {
        fetchingTiles += 1;
        loadingTileKeys.push(key);
      } else if (record.state === 'decoding') {
        decodingTiles += 1;
        loadingTileKeys.push(key);
      } else if (record.state === 'ready_to_commit') {
        readyToCommitTiles += 1;
        loadingTileKeys.push(key);
      } else if (record.state === 'error') {
        failedTiles += 1;
      }
    }

    const loadingTiles =
      queuedTiles + fetchingTiles + decodingTiles + readyToCommitTiles;
    this.peakLoadedTiles = Math.max(this.peakLoadedTiles, loadedTiles);
    this.peakLoadingTiles = Math.max(this.peakLoadingTiles, loadingTiles);

    const isLoaded = this.manifestStatus === 'loaded' && this.metadata !== null;
    const loadedPackPath = isLoaded ? this.manifestPackPath : null;

    return {
      manifestStatus: this.manifestStatus,
      manifestError: this.manifestError,
      activeMosaicName: deriveActiveMosaicNameFromPackPath(loadedPackPath),
      packPath: loadedPackPath,
      apiBaseUrl: this.apiBaseUrl,
      snapshotId: isLoaded ? this.metadata!.snapshotId : 'uninitialized',
      bakeSchemaVersion: isLoaded ? this.metadata!.bakeSchemaVersion : 'uninitialized',
      tileSizeMeters: isLoaded ? this.metadata!.tileSizeMeters : 512,
      preloadMarginTiles: this.preloadMarginTiles,
      retainMarginTiles: this.retainMarginTiles,
      totalGridCols: isLoaded ? this.metadata!.gridCols : 8,
      totalGridRows: isLoaded ? this.metadata!.gridRows : 8,
      totalGridTiles: this.tilesByKey.size,
      visibleTiles,
      fetchTargetTiles,
      keepTargetTiles,
      loadedTiles,
      peakLoadedTiles: this.peakLoadedTiles,
      emptyLoadedTiles,
      loadingTiles,
      peakLoadingTiles: this.peakLoadingTiles,
      queuedTiles,
      fetchingTiles,
      decodingTiles,
      readyToCommitTiles,
      failedTiles,
      evictedTilesTotal: this.evictedTilesTotal,
      cancelledRequestsTotal: this.cancelledRequestsTotal,
      duplicateRequestsSkippedTotal: this.duplicateRequestsSkippedTotal,
      completedLoadsTotal: this.completedLoadsTotal,
      loadedMeshCount,
      visibleMeshCount,
      loadedTriangles,
      loadedVertices,
      loadedDrawCallsEstimate,
      activeTileGeometries,
      activeTileBvhs,
      sharedMaterialCount: this.materialRegistry.materialCount,
      tileCpuGeometryBytes,
      tileBvhBytes,
      compositeSceneRevision: this.compositeSceneRevision,
      lastManifestLoadMs: this.lastManifestLoadMs,
      avgFetchMs:
        this.fetchSamples > 0 ? this.totalFetchMs / this.fetchSamples : 0,
      avgDecodeMs:
        this.decodeSamples > 0 ? this.totalDecodeMs / this.decodeSamples : 0,
      avgReconstructMs:
        this.reconstructSamples > 0
          ? this.totalReconstructMs / this.reconstructSamples
          : 0,
      lastCommitMs: this.lastCommitMs,
      maxCommitMs: this.maxCommitMs,
      fetchMsStats: summarizeTimingSamples(this.fetchMsRing),
      decodeMsStats: summarizeTimingSamples(this.decodeMsRing),
      reconstructMsStats: summarizeTimingSamples(this.reconstructMsRing),
      commitMsStats: summarizeTimingSamples(this.commitMsRing),
      viewportBounds: this.currentViewport,
      loadedTileKeys,
      visibleTileKeys,
      loadingTileKeys,
      viewportSelectionPasses: this.viewportSelectionPasses,
      viewportSelectionSkips: this.viewportSelectionSkips,
      zoomPropagationSkips: this.zoomPropagationSkips,
      activeFoliageLod: this.foliageRuntimeState.activeLod,
      foliageTrunksVisible: this.foliageRuntimeState.trunksVisible,
      foliageFrustumCullingEnabled: this.foliageRuntimeState.frustumCullingEnabled,
      sharedFoliagePrototypeCount: this.foliagePrototypeRegistry.disposed
        ? 0
        : this.foliagePrototypeRegistry.geometryCount,
      tileInstancedIndexBytes,
      tileInstancedIndexCount,
      tileInstancedIndexInstances,
      tileInstancedIndexBuildMsTotal: Number(tileInstancedIndexBuildMsTotal.toFixed(3)),
    };
  }

  /**
   * Resets cumulative scenario counters and latency sample rings without altering loaded tiles.
   */
  resetPerformanceCounters(): void {
    let loadedNow = 0;
    let loadingNow = 0;
    for (const record of this.tilesByKey.values()) {
      if (record.state === 'loaded') loadedNow += 1;
      else if (
        record.state === 'queued' ||
        record.state === 'fetching' ||
        record.state === 'decoding' ||
        record.state === 'ready_to_commit'
      ) {
        loadingNow += 1;
      }
    }
    this.evictedTilesTotal = 0;
    this.cancelledRequestsTotal = 0;
    this.duplicateRequestsSkippedTotal = 0;
    this.completedLoadsTotal = 0;
    this.viewportSelectionPasses = 0;
    this.viewportSelectionSkips = 0;
    this.zoomPropagationSkips = 0;
    this.peakLoadedTiles = loadedNow;
    this.peakLoadingTiles = loadingNow;
    this.totalFetchMs = 0;
    this.fetchSamples = 0;
    this.totalDecodeMs = 0;
    this.decodeSamples = 0;
    this.totalReconstructMs = 0;
    this.reconstructSamples = 0;
    this.lastCommitMs = 0;
    this.maxCommitMs = 0;
    this.fetchMsRing.length = 0;
    this.decodeMsRing.length = 0;
    this.reconstructMsRing.length = 0;
    this.commitMsRing.length = 0;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    for (const record of this.tilesByKey.values()) {
      if (record.abortController) {
        record.abortController.abort();
        record.abortController = null;
      }
      if (record.reconstructed) {
        this.detachTileFromCompositeScene(record);
        record.reconstructed.dispose();
        record.reconstructed = null;
      }
      record.decodedPayload = null;
      record.decodedFootprint = null;
      record.state = 'unloaded';
    }

    this.tilesByKey.clear();
    this.metadata = null;
    this.manifestPackPath = null;
    this.manifestStatus = 'idle';
    this.manifestError = null;

    this.compositeScene.buildingsGroup.clear();
    this.compositeScene.roadsGroup.clear();
    this.compositeScene.railwaysGroup.clear();
    this.compositeScene.waterGroup.clear();
    this.compositeScene.parksGroup.clear();
    this.compositeScene.landuseGroup.clear();
    this.compositeScene.barriersGroup.clear();
    this.compositeScene.foliageGroup.clear();
    this.compositeScene.interactiveMeshes.buildings = [];

    this.boundaryOverlayResult.dispose();
    this.regionalResources.dispose();
    if (this.ownsDecodeClient) {
      this.decodeClient.dispose();
    }
    if (this.ownsMaterialRegistry) {
      this.materialRegistry.dispose();
    }
    if (this.ownsFoliagePrototypeRegistry) {
      this.foliagePrototypeRegistry.dispose();
    }
    this.checkIdleWaiters();
  }

  private pumpFetchQueue(): void {
    if (this.isDisposed) return;

    const availableSlots = this.maxConcurrentFetches - this.activeFetchCount;
    if (availableSlots <= 0) return;

    const queued: ManagedTileRecord[] = [];
    for (const record of this.tilesByKey.values()) {
      if (record.state === 'queued' && record.isInFetchSet) {
        queued.push(record);
      }
    }
    if (queued.length === 0) return;

    queued.sort((a, b) => a.priorityScore - b.priorityScore);
    const toLaunch = Math.min(availableSlots, queued.length);

    for (let i = 0; i < toLaunch; i++) {
      this.startTileFetchAndDecode(queued[i]);
    }
  }

  private startTileFetchAndDecode(record: ManagedTileRecord): void {
    const abortController = new AbortController();
    const generation = this.requestGenerationCounter++;
    record.abortController = abortController;
    record.requestGeneration = generation;
    record.state = 'fetching';
    this.activeFetchCount += 1;

    const { lod, tx, ty } = record.manifest;
    const tileKey = record.tileKey;
    const tileSizeMeters = this.metadata?.tileSizeMeters ?? 1024;
    const url = `${this.apiBaseUrl}/${lod}/${tx}/${ty}`;
    const fetchStart = performance.now();
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;

    if (prof) {
      prof.recordEvent({
        eventType: 'fetch_start',
        tileKey,
        tileSizeMeters,
        lod,
        timestampMs: fetchStart,
        queueDepths: this.getQueueDepthSnapshot(),
      });
    }

    (async () => {
      try {
        const response = await this.fetchFn(url, {
          signal: abortController.signal,
        });
        if (abortController.signal.aborted || record.requestGeneration !== generation) {
          return;
        }
        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status} fetching tile ${tileKey}`
          );
        }
        const arrayBuffer = await response.arrayBuffer();
        if (abortController.signal.aborted || record.requestGeneration !== generation) {
          return;
        }
        // Capture compressed byteLength BEFORE decodeTile transfers the ArrayBuffer to a Worker
        const compressedPayloadBytes = arrayBuffer.byteLength;
        record.lastCompressedBytes = compressedPayloadBytes;
        const fetchEnd = performance.now();
        const fetchMs = fetchEnd - fetchStart;
        this.totalFetchMs += fetchMs;
        this.fetchSamples += 1;
        pushBoundedSample(this.fetchMsRing, fetchMs);

        record.state = 'decoding';
        this.updatePeakTileCounters();

        const profAtFetchDone =
          this.profiler && this.profiler.enabled ? this.profiler : null;
        if (profAtFetchDone) {
          const depths = this.getQueueDepthSnapshot();
          profAtFetchDone.recordEvent({
            eventType: 'fetch_complete',
            tileKey,
            tileSizeMeters,
            lod,
            timestampMs: fetchEnd,
            payloadCompressedBytes: compressedPayloadBytes,
            durationMs: fetchMs,
            queueDepths: depths,
          });
          profAtFetchDone.recordEvent({
            eventType: 'decode_start',
            tileKey,
            tileSizeMeters,
            lod,
            timestampMs: fetchEnd,
            payloadCompressedBytes: compressedPayloadBytes,
            queueDepths: depths,
          });
        }

        const decodeResult = await this.decodeClient.decodeTile(
          arrayBuffer,
          tileKey,
          abortController.signal
        );
        if (
          abortController.signal.aborted ||
          record.requestGeneration !== generation ||
          !record.isInKeepSet
        ) {
          return;
        }

        this.totalDecodeMs += decodeResult.decodeDurationMs;
        this.decodeSamples += 1;
        pushBoundedSample(this.decodeMsRing, decodeResult.decodeDurationMs);

        // A regional mosaic reuses immutable shard-local OSMTILE1 payloads.
        // Geometry inside each payload is tile-local; only the decoded center must
        // be relocated to the regional origin supplied by the composed manifest.
        // Identical for legacy packs, where these centers already agree.
        if (
          decodeResult.decoded.lod !== lod ||
          decodeResult.decoded.tx !== tx ||
          decodeResult.decoded.ty !== ty ||
          decodeResult.decoded.tileSizeMeters !== this.metadata?.tileSizeMeters
        ) {
          throw new Error(`Decoded tile identity/size mismatch: ${tileKey}`);
        }
        const positionedPayload = {
          ...decodeResult.decoded,
          tileCenterX: record.manifest.tileCenterX,
          tileCenterZ: record.manifest.tileCenterZ,
        };
        record.decodedPayload = positionedPayload;
        record.decodedFootprint = computeDecodedTileMemoryFootprint(
          positionedPayload
        );
        record.abortController = null;
        record.state = 'ready_to_commit';
        this.updatePeakTileCounters();

        const profAtDecodeDone =
          this.profiler && this.profiler.enabled ? this.profiler : null;
        if (profAtDecodeDone) {
          const readyNowMs = performance.now();
          const fp = record.decodedFootprint;
          const rawBytes = fp.cpuGeometryBytes + fp.bvhBytes;
          const depths = this.getQueueDepthSnapshot();
          profAtDecodeDone.recordEvent({
            eventType: 'decode_complete',
            tileKey,
            tileSizeMeters,
            lod,
            timestampMs: readyNowMs,
            payloadCompressedBytes: compressedPayloadBytes,
            payloadRawBytes: rawBytes,
            durationMs: decodeResult.decodeDurationMs,
            queueDepths: depths,
            detail: {
              meshCount: fp.meshCount,
              triangleCount: fp.triangleCount,
              usedWebWorker: decodeResult.usedWebWorker,
            },
          });
          profAtDecodeDone.recordEvent({
            eventType: 'ready_to_commit',
            tileKey,
            tileSizeMeters,
            lod,
            timestampMs: readyNowMs,
            payloadCompressedBytes: compressedPayloadBytes,
            payloadRawBytes: rawBytes,
            queueDepths: depths,
          });
        }
      } catch (err) {
        if (
          abortController.signal.aborted ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          return;
        }
        if (record.requestGeneration === generation) {
          const msg = err instanceof Error ? err.message : String(err);
          record.state = 'error';
          record.lastError = msg;
          record.abortController = null;
          // updateViewport normally retries fetch errors on the next frame.
          // Invalidate the opt-in identical-camera gate to preserve that behavior.
          this.needsViewportRefresh = true;

          const profAtErr =
            this.profiler && this.profiler.enabled ? this.profiler : null;
          if (profAtErr) {
            profAtErr.recordEvent({
              eventType: 'error',
              tileKey,
              tileSizeMeters,
              lod,
              queueDepths: this.getQueueDepthSnapshot(),
              detail: { reason: msg },
            });
          }
        }
      } finally {
        this.activeFetchCount = Math.max(0, this.activeFetchCount - 1);
        if (!this.isDisposed) {
          this.pumpFetchQueue();
          this.checkIdleWaiters();
        }
      }
    })();
  }

  private cancelInFlightTile(record: ManagedTileRecord): void {
    const prevState = record.state;
    record.requestGeneration = this.requestGenerationCounter++;
    if (record.abortController) {
      record.abortController.abort();
      record.abortController = null;
    }
    record.decodedPayload = null;
    record.decodedFootprint = null;
    record.state = 'unloaded';
    this.cancelledRequestsTotal += 1;
    if (this.profiler && this.profiler.enabled) {
      this.profiler.recordEvent({
        eventType: 'cancel',
        tileKey: record.tileKey,
        tileSizeMeters: this.metadata?.tileSizeMeters ?? 1024,
        lod: record.manifest.lod,
        payloadCompressedBytes: record.lastCompressedBytes ?? null,
        queueDepths: this.getQueueDepthSnapshot(),
        detail: { reason: `cancelled_from_${prevState}` },
      });
    }
  }

  private evictLoadedTile(record: ManagedTileRecord): void {
    if (!record.reconstructed) {
      record.state = 'unloaded';
      return;
    }
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    const t0 = prof ? performance.now() : 0;
    const fp = record.decodedFootprint;
    const compressedBytes = record.lastCompressedBytes ?? null;

    this.detachTileFromCompositeScene(record);
    record.reconstructed.dispose();
    record.reconstructed = null;
    record.decodedPayload = null;
    record.decodedFootprint = null;
    record.state = 'unloaded';
    this.evictedTilesTotal += 1;

    if (prof) {
      prof.recordEvent({
        eventType: 'evict',
        tileKey: record.tileKey,
        tileSizeMeters: this.metadata?.tileSizeMeters ?? 1024,
        lod: record.manifest.lod,
        payloadCompressedBytes: compressedBytes,
        payloadRawBytes: fp ? fp.cpuGeometryBytes + fp.bvhBytes : null,
        durationMs: performance.now() - t0,
        queueDepths: this.getQueueDepthSnapshot(),
        detail: fp
          ? {
              meshCount: fp.meshCount,
              triangleCount: fp.triangleCount,
            }
          : undefined,
      });
    }
  }

  private attachTileToCompositeScene(record: ManagedTileRecord): void {
    const reconstructed = record.reconstructed;
    if (!reconstructed) return;
    const tileScene = reconstructed.scene;
    const tileKey = record.tileKey;

    const layerPairs: ReadonlyArray<[THREE.Group, THREE.Group, Exclude<TileLayerKind, 'ground'>]> = [
      [this.compositeScene.buildingsGroup, tileScene.buildingsGroup, 'buildings'],
      [this.compositeScene.roadsGroup, tileScene.roadsGroup, 'roads'],
      [this.compositeScene.railwaysGroup, tileScene.railwaysGroup, 'railways'],
      [this.compositeScene.waterGroup, tileScene.waterGroup, 'water'],
      [this.compositeScene.parksGroup, tileScene.parksGroup, 'parks'],
      [this.compositeScene.landuseGroup, tileScene.landuseGroup, 'landuse'],
      [this.compositeScene.barriersGroup, tileScene.barriersGroup, 'barriers'],
      [this.compositeScene.foliageGroup, tileScene.foliageGroup, 'foliage'],
    ];

    for (const [parentGroup, childGroup, layerKind] of layerPairs) {
      if (childGroup.children.length > 0) {
        childGroup.name = `${layerKind}_${tileKey}`;
        childGroup.userData.tileKey = tileKey;
        parentGroup.add(childGroup);
        childGroup.updateMatrixWorld(true);
      }
    }
  }

  private detachTileFromCompositeScene(record: ManagedTileRecord): void {
    const reconstructed = record.reconstructed;
    if (!reconstructed) return;
    const tileScene = reconstructed.scene;

    this.compositeScene.buildingsGroup.remove(tileScene.buildingsGroup);
    this.compositeScene.roadsGroup.remove(tileScene.roadsGroup);
    this.compositeScene.railwaysGroup.remove(tileScene.railwaysGroup);
    this.compositeScene.waterGroup.remove(tileScene.waterGroup);
    this.compositeScene.parksGroup.remove(tileScene.parksGroup);
    this.compositeScene.landuseGroup.remove(tileScene.landuseGroup);
    this.compositeScene.barriersGroup.remove(tileScene.barriersGroup);
    this.compositeScene.foliageGroup.remove(tileScene.foliageGroup);
  }

  private rebuildCompositeStats(): void {
    let totalVertices = 0;
    let totalTriangles = 0;
    let totalDrawCalls = 0;
    let renderedFeaturesCount = 0;
    let forestTreesCount = 0;
    let totalSleeper3DBoxCount = 0;
    const interactiveBuildings: THREE.Mesh[] = [];

    for (const record of this.tilesByKey.values()) {
      if (record.state !== 'loaded' || !record.reconstructed) continue;
      const s = record.reconstructed.scene;
      totalVertices += s.stats.totalVertices;
      totalTriangles += s.stats.totalTriangles;
      totalDrawCalls += s.stats.totalDrawCalls;
      renderedFeaturesCount += s.stats.renderedFeaturesCount;
      forestTreesCount += s.stats.forestTreesCount;
      const rwStats = s.railwaysGroup.userData?.railwayStats as
        | { sleeper3DBoxCount?: number }
        | undefined;
      totalSleeper3DBoxCount += rwStats?.sleeper3DBoxCount ?? 0;
      interactiveBuildings.push(...s.interactiveMeshes.buildings);
    }

    this.compositeSceneRevision += 1;
    this.compositeScene.stats.totalVertices = totalVertices;
    this.compositeScene.stats.totalTriangles = totalTriangles;
    this.compositeScene.stats.totalDrawCalls = totalDrawCalls;
    this.compositeScene.stats.renderedFeaturesCount = renderedFeaturesCount;
    this.compositeScene.stats.forestTreesCount = forestTreesCount;
    this.compositeScene.interactiveMeshes.buildings = interactiveBuildings;
    this.compositeScene.railwaysGroup.userData.railwayStats = {
      sleeper3DBoxCount: totalSleeper3DBoxCount,
      railwayRenderSource: 'graph_extrusion',
    };
    this.compositeScene.railwaysGroup.userData.compositeRevision =
      this.compositeSceneRevision;
    this.groundMesh.userData.__compositeRevision = this.compositeSceneRevision;

    for (const layerKind of STREAMED_LAYER_KINDS) {
      const grp = this.compositeScene[`${layerKind}Group` as const];
      grp.updateMatrixWorld(true);
    }
  }

  private updatePeakTileCounters(): void {
    let loadedNow = 0;
    let loadingNow = 0;
    for (const record of this.tilesByKey.values()) {
      if (record.state === 'loaded') loadedNow += 1;
      else if (
        record.state === 'queued' ||
        record.state === 'fetching' ||
        record.state === 'decoding' ||
        record.state === 'ready_to_commit'
      ) {
        loadingNow += 1;
      }
    }
    if (loadedNow > this.peakLoadedTiles) this.peakLoadedTiles = loadedNow;
    if (loadingNow > this.peakLoadingTiles) this.peakLoadingTiles = loadingNow;
  }

  private hasPendingAsyncWork(): boolean {
    if (this.activeFetchCount > 0) return true;
    for (const record of this.tilesByKey.values()) {
      if (
        (record.state === 'queued' && record.isInFetchSet) ||
        record.state === 'fetching' ||
        record.state === 'decoding'
      ) {
        return true;
      }
    }
    return false;
  }

  private isCurrentlyIdle(): boolean {
    if (this.hasPendingAsyncWork()) return false;
    for (const record of this.tilesByKey.values()) {
      if (record.state === 'ready_to_commit' && record.isInKeepSet) {
        return false;
      }
    }
    return true;
  }

  private checkIdleWaiters(): void {
    if (this.idleWaiters.length === 0) return;
    if (this.isDisposed || !this.hasPendingAsyncWork()) {
      const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  private emitDiagnostics(): void {
    if (this.onDiagnosticsChange) {
      this.onDiagnosticsChange(this.getDiagnostics());
    }
  }
}
