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
  type AnyDecodedTilePayload,
} from './CompactTileTransport';
import {
  type TileLayerKind,
  type TileManifestEntry,
  type TilePackMetadata,
} from './TilePackContract';
import {
  identifyTilePreparationVariant,
  resolveTilePreparationOptions,
  type TilePreparationOptions,
  type TilePreparationVariantId,
} from './TilePreparationConfig';
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
import {
  formatHierarchicalTileKey,
  type HierarchicalMosaicLevelManifest,
  type HierarchicalMosaicManifestExtension,
} from './HierarchicalMosaicContract';
import {
  DEFAULT_HIERARCHICAL_RESOLUTION_POLICY,
  normalizeHierarchicalResolutionPolicy,
  resolveDesiredHierarchicalResolution,
  resolvePhysicalMarginsForResolution,
  type HierarchicalResolutionMode,
  type HierarchicalResolutionPolicyConfig,
  type HierarchicalScaleEvaluation,
} from './HierarchicalResolutionPolicy';
import {
  createEmptyResolutionAccounting,
  normalizeHierarchicalResourceBudget,
  type HierarchicalResourceAccountingSnapshot,
  type HierarchicalResourceBudgetConfig,
  type ResolutionResourceAccounting,
} from './HierarchicalResourceBudget';

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
  | 'prepared_inactive'
  | 'loaded'
  | 'cached_inactive'
  | 'error';

export type HierarchicalTransitionState =
  | 'idle'
  | 'preparing'
  | 'ready_to_activate'
  | 'deferred_budget';

export interface TileViewportGroundBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  focusX: number;
  focusZ: number;
  cameraZoom?: number;
  /** Optional orthographic CSS viewport width in pixels for scale compensation. */
  viewportWidthPx?: number;
  /** Optional orthographic CSS viewport height in pixels. */
  viewportHeightPx?: number;
}

export interface TileMemoryFootprint {
  cpuGeometryBytes: number;
  bvhBytes: number;
  /** Portion of `bvhBytes` originating from worker-prepared instanced spatial indices (avoids double-counting). */
  preparedInstancedBvhBytes?: number;
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
  /** TKT-040 non-blocking tile preparation & worker transfer diagnostics. */
  tilePreparationVariant: TilePreparationVariantId | 'custom';
  workerBvhAdoptedTotal: number;
  syncBvhFallbackTotal: number;
  pendingReadyTileBytes: number;
  /** TKT-041 hierarchical multi-resolution streaming diagnostics (null for single-resolution packs). */
  hierarchical: HierarchicalStreamingDiagnosticsSnapshot | null;
}

export interface HierarchicalStreamingDiagnosticsSnapshot {
  enabled: boolean;
  hierarchyName: string;
  availableResolutionsMeters: number[];
  resolutionMode: HierarchicalResolutionMode;
  desiredResolutionMeters: number;
  activeResolutionMeters: number;
  pendingResolutionMeters: number | null;
  transitionState: HierarchicalTransitionState;
  transitionGeneration: number;
  transitionElapsedMs: number;
  budgetDeferralReason: string | null;
  requiredDestinationTiles: number;
  readyDestinationTiles: number;
  activeVisibleTiles: number;
  activeLoadedTiles: number;
  pendingPreparedTiles: number;
  rawCameraZoom: number;
  effectiveScalePxPerMeter: number;
  viewportScaleFactor: number;
  viewportWidthPx: number | null;
  viewportHeightPx: number | null;
  selectionReason: string;
  policy: HierarchicalResolutionPolicyConfig;
  preloadMarginMeters: number;
  retainMarginMeters: number;
  resources: HierarchicalResourceAccountingSnapshot;
  pendingQueues: {
    queued: number;
    fetching: number;
    decoding: number;
    readyToCommit: number;
  };
  counters: {
    transitionsStarted: number;
    transitionsCompleted: number;
    transitionsCancelled: number;
    transitionsDeferredBudget: number;
    cacheHits: number;
    cacheEvictions: number;
  };
  timings: {
    lastTransitionTotalMs: number;
    lastActivationSwapMs: number;
    maxActivationSwapMs: number;
    activationSwapMsStats: TileTimingSummaryStats | null;
    transitionDurationMsStats: TileTimingSummaryStats | null;
  };
}

export interface TilePackManifestPayload {
  available?: boolean;
  packPath?: string;
  dbSizeBytes?: number;
  metadata: TilePackMetadata;
  tiles: TileManifestEntry[];
  /** Optional TKT-041 multi-resolution hierarchy descriptor and canonically rebased levels. */
  hierarchy?: HierarchicalMosaicManifestExtension;
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
  /** TKT-040: Tile preparation variant or explicit optimization flags (default: 'combined'). */
  tilePreparationOptions?: TilePreparationVariantId | Partial<TilePreparationOptions>;
  /** TKT-041: Hierarchical resolution selection, hysteresis, and physical margin policy. */
  hierarchicalPolicy?: Partial<HierarchicalResolutionPolicyConfig>;
  /** TKT-041: Hierarchical memory budget, inactive LRU cache, and time-aware commit limits. */
  hierarchicalBudget?: Partial<HierarchicalResourceBudgetConfig>;
}

interface ManagedTileRecord {
  tileKey: string;
  /** Resolution level in meters (`tileSizeMeters`) that owns this record. */
  resolutionMeters: number;
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
  decodedPayload: AnyDecodedTilePayload | null;
  decodedFootprint: TileMemoryFootprint | null;
  reconstructed: ReconstructedTileSceneResult | null;
  lastError: string | null;
  lastCompressedBytes?: number | null;
  /** Monotonic timestamp for LRU eviction in `cached_inactive`. */
  lastUsedAtMs: number;
}

interface ResolutionLevelState {
  tileSizeMeters: number;
  metadata: TilePackMetadata;
  levelManifest: HierarchicalMosaicLevelManifest | null;
  tilesByKey: Map<string, ManagedTileRecord>;
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
  decoded: AnyDecodedTilePayload
): TileMemoryFootprint {
  if (decoded.precomputedFootprint) {
    let preparedInstancedBvhBytes = 0;
    for (const b of decoded.instancedBatches) {
      if (b.preparedSpatialIndex) {
        preparedInstancedBvhBytes += b.preparedSpatialIndex.estimatedMemoryBytes;
      }
    }
    return {
      ...decoded.precomputedFootprint,
      preparedInstancedBvhBytes,
    };
  }
  let cpuGeometryBytes = 0;
  let bvhBytes = 0;
  let preparedInstancedBvhBytes = 0;
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
    if (b.preparedSpatialIndex) {
      bvhBytes += b.preparedSpatialIndex.estimatedMemoryBytes;
      preparedInstancedBvhBytes += b.preparedSpatialIndex.estimatedMemoryBytes;
    }
  }

  return {
    cpuGeometryBytes,
    bvhBytes,
    preparedInstancedBvhBytes,
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

  const viewportWidthPx = Math.abs(camera.right - camera.left);
  const viewportHeightPx = Math.abs(camera.top - camera.bottom);

  return {
    minX,
    maxX,
    minZ,
    maxZ,
    focusX,
    focusZ,
    cameraZoom: zoom,
    viewportWidthPx:
      Number.isFinite(viewportWidthPx) && viewportWidthPx > 0
        ? viewportWidthPx
        : undefined,
    viewportHeightPx:
      Number.isFinite(viewportHeightPx) && viewportHeightPx > 0
        ? viewportHeightPx
        : undefined,
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
    a.cameraZoom === b.cameraZoom &&
    a.viewportWidthPx === b.viewportWidthPx &&
    a.viewportHeightPx === b.viewportHeightPx;
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
  /**
   * Global tile map.
   * - Single-resolution packs: keyed by legacy `formatTileId(tx, ty)` (`tx_..._ty_...`).
   * - Hierarchical packs: contains all records across every resolution keyed by
   *   collision-free `formatHierarchicalTileKey(tileSizeMeters, tx, ty, lod)`.
   */
  private readonly tilesByKey = new Map<string, ManagedTileRecord>();
  /** Per-resolution tile maps keyed by `tileSizeMeters` (size 1 for single-resolution packs). */
  private readonly levelsByResolution = new Map<number, ResolutionLevelState>();
  private hierarchy: HierarchicalMosaicManifestExtension | null = null;
  private hierarchicalPolicy: HierarchicalResolutionPolicyConfig;
  private hierarchicalBudget: HierarchicalResourceBudgetConfig;
  private activeResolutionMeters: number | null = null;
  private desiredResolutionMeters: number | null = null;
  private pendingResolutionMeters: number | null = null;
  private transitionState: HierarchicalTransitionState = 'idle';
  private transitionGeneration = 0;
  private transitionStartedAtMs: number | null = null;
  private budgetDeferralReason: string | null = null;
  private lastDeferredViewportSignature: string | null = null;
  private lastDeferredBudgetBytes: number | null = null;
  private currentViewportWidthPx: number | null = null;
  private currentViewportHeightPx: number | null = null;
  private lastScaleEval: HierarchicalScaleEvaluation | null = null;
  private speculativeBackpressureActive = false;
  private workerBackpressureActive = false;

  // Hierarchical telemetry counters & timings
  private transitionsStartedTotal = 0;
  private transitionsCompletedTotal = 0;
  private transitionsCancelledTotal = 0;
  private transitionsDeferredBudgetTotal = 0;
  private cacheHitsTotal = 0;
  private cacheEvictionsTotal = 0;
  private lastTransitionTotalMs = 0;
  private lastActivationSwapMs = 0;
  private maxActivationSwapMs = 0;
  private readonly activationSwapMsRing: number[] = [];
  private readonly transitionDurationMsRing: number[] = [];

  private metadata: TilePackMetadata | null = null;
  private manifestStatus: TileManifestLoadStatus = 'idle';
  private manifestPackPath: string | null = null;
  private manifestError: string | null = null;
  private currentTheme: MapStyleTheme;
  private currentCameraZoom: number;
  private foliageConfig: FoliageOptimizationConfig;
  private foliageRuntimeState: FoliageRuntimeState;
  private tilePrepOptions: TilePreparationOptions;
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
  private workerBvhAdoptedTotal = 0;
  private syncBvhFallbackTotal = 0;
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
    this.tilePrepOptions = resolveTilePreparationOptions(
      options.tilePreparationOptions
    );
    this.hierarchicalPolicy = normalizeHierarchicalResolutionPolicy(
      options.hierarchicalPolicy
    );
    this.hierarchicalBudget = normalizeHierarchicalResourceBudget(
      options.hierarchicalBudget
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

    this.profiler =
      options.profiler === undefined
        ? getGlobalStreamingProfiler()
        : options.profiler;

    if (options.decodeClient) {
      this.decodeClient = options.decodeClient;
      this.ownsDecodeClient = false;
      if (typeof this.decodeClient.getPreparationOptions === 'function') {
        this.tilePrepOptions = this.decodeClient.getPreparationOptions();
      }
    } else {
      this.decodeClient = createTileDecodeClient({
        preparationOptions: this.tilePrepOptions,
        onWorkerMessageDelivered: (info) => {
          const prof =
            this.profiler && this.profiler.enabled ? this.profiler : null;
          if (!prof) return;
          prof.recordWorkerOnMessage({
            durationMs: info.handlerDurationMs,
            deliveryLatencyMs: info.timings.messageDeliveryLatencyMs,
            workerBvhBuildMs: info.timings.workerBvhBuildMs,
            transferableBytes: info.timings.transferableBytes,
            usedCompactTransport: info.timings.usedCompactTransport,
          });
          const rec = this.tilesByKey.get(info.tileKey);
          prof.recordEvent({
            eventType: 'worker_message_received',
            tileKey: info.tileKey,
            tileSizeMeters:
              rec?.resolutionMeters ?? this.metadata?.tileSizeMeters ?? 1024,
            lod: rec?.manifest.lod ?? 0,
            timestampMs: info.onMessageEndMs,
            payloadCompressedBytes: rec?.lastCompressedBytes ?? null,
            durationMs: info.handlerDurationMs,
            queueDepths: this.getQueueDepthSnapshot(),
            detail: {
              usedWebWorker: info.timings.usedWebWorker,
              usedCompactTransport: info.timings.usedCompactTransport,
              transferAllTypedArrays: info.timings.transferAllTypedArrays,
              workerInstanceBvhEnabled: info.timings.workerInstanceBvhEnabled,
              workerQueueWaitMs: info.timings.workerQueueWaitMs,
              workerInflateAndDecodeMs: info.timings.workerInflateAndDecodeMs,
              workerBvhBuildMs: info.timings.workerBvhBuildMs,
              workerPayloadPrepMs: info.timings.workerPayloadPrepMs,
              messageDeliveryLatencyMs: info.timings.messageDeliveryLatencyMs,
              mainOnMessageHandlerMs: info.timings.mainOnMessageHandlerMs,
              transferableBufferCount: info.timings.transferableBufferCount,
              transferableBytes: info.timings.transferableBytes,
              workerBvhBatchCount: info.timings.workerBvhBatchCount,
              workerBvhInstanceCount: info.timings.workerBvhInstanceCount,
            },
          });
        },
      });
      this.ownsDecodeClient = true;
    }

    this.fetchFn =
      options.fetchFn ??
      ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.onDiagnosticsChange = options.onDiagnosticsChange;

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

  get isHierarchical(): boolean {
    return this.hierarchy !== null;
  }

  getTilePreparationOptions(): TilePreparationOptions {
    return { ...this.tilePrepOptions };
  }

  setTilePreparationOptions(
    next: TilePreparationVariantId | Partial<TilePreparationOptions>
  ): TilePreparationOptions {
    this.tilePrepOptions = resolveTilePreparationOptions(next);
    this.decodeClient.setPreparationOptions(this.tilePrepOptions);
    this.emitDiagnostics();
    return { ...this.tilePrepOptions };
  }

  getHierarchicalPolicyConfig(): HierarchicalResolutionPolicyConfig {
    return {
      ...this.hierarchicalPolicy,
      bands: this.hierarchicalPolicy.bands.map((b) => ({ ...b })),
    };
  }

  setHierarchicalPolicyConfig(
    partial: Partial<HierarchicalResolutionPolicyConfig>
  ): HierarchicalResolutionPolicyConfig {
    if (this.isDisposed) {
      return this.getHierarchicalPolicyConfig();
    }
    this.hierarchicalPolicy = normalizeHierarchicalResolutionPolicy({
      ...this.hierarchicalPolicy,
      ...partial,
      bands: partial.bands ?? this.hierarchicalPolicy.bands,
    });
    if (this.hierarchy && this.manifestStatus === 'loaded') {
      if (this.transitionState === 'deferred_budget') {
        this.transitionState = 'preparing';
        this.budgetDeferralReason = null;
        this.lastDeferredViewportSignature = null;
      }
      this.evaluateDesiredResolutionInternal();
      this.needsViewportRefresh = true;
      if (this.currentViewport) {
        this.updateViewport(this.currentViewport);
      } else {
        this.emitDiagnostics();
      }
    } else {
      this.emitDiagnostics();
    }
    return this.getHierarchicalPolicyConfig();
  }

  getHierarchicalBudgetConfig(): HierarchicalResourceBudgetConfig {
    return { ...this.hierarchicalBudget };
  }

  setHierarchicalBudgetConfig(
    partial: Partial<HierarchicalResourceBudgetConfig>
  ): HierarchicalResourceBudgetConfig {
    if (this.isDisposed) {
      return this.getHierarchicalBudgetConfig();
    }
    const mergedBudget: Partial<HierarchicalResourceBudgetConfig> = {
      ...this.hierarchicalBudget,
      ...partial,
    };
    // When totalMemoryBudgetBytes changes without explicit dependent overrides,
    // recompute derived defaults so a prior tight budget clamp does not stick.
    if (partial.totalMemoryBudgetBytes !== undefined) {
      if (partial.inactiveCacheBudgetBytes === undefined) {
        delete mergedBudget.inactiveCacheBudgetBytes;
      }
      if (partial.maxPendingDecodedBytes === undefined) {
        delete mergedBudget.maxPendingDecodedBytes;
      }
    }
    this.hierarchicalBudget = normalizeHierarchicalResourceBudget(mergedBudget);
    if (this.hierarchy && this.manifestStatus === 'loaded') {
      if (this.transitionState === 'deferred_budget') {
        this.transitionState = 'preparing';
        this.budgetDeferralReason = null;
        this.lastDeferredViewportSignature = null;
        this.lastDeferredBudgetBytes = null;
      }
      this.enforceResourceBudgets();
      this.needsViewportRefresh = true;
      if (this.currentViewport) {
        this.updateViewport(this.currentViewport);
      } else {
        this.emitDiagnostics();
      }
    } else {
      this.emitDiagnostics();
    }
    return this.getHierarchicalBudgetConfig();
  }

  getHierarchicalDiagnostics(): HierarchicalStreamingDiagnosticsSnapshot | null {
    return this.getDiagnostics().hierarchical;
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

  private getActiveLevelState(): ResolutionLevelState | null {
    if (this.activeResolutionMeters === null) return null;
    return this.levelsByResolution.get(this.activeResolutionMeters) ?? null;
  }

  private getPendingLevelState(): ResolutionLevelState | null {
    if (this.pendingResolutionMeters === null) return null;
    return this.levelsByResolution.get(this.pendingResolutionMeters) ?? null;
  }

  private getQueueDepthSnapshot(): StreamingQueueDepths {
    let queued = 0;
    let fetching = 0;
    let decoding = 0;
    let readyToCommit = 0;
    let loaded = 0;
    let visible = 0;
    for (const r of this.tilesByKey.values()) {
      if (r.resolutionMeters === this.activeResolutionMeters && r.isVisibleInViewport) {
        visible += 1;
      }
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
    if (this.hierarchy) {
      return this.hierarchy.hierarchyName;
    }
    return deriveActiveMosaicNameFromPackPath(this.manifestPackPath);
  }

  get currentManifestStatus(): TileManifestLoadStatus {
    return this.manifestStatus;
  }

  getManifestCoverageSummary(): TileManifestCoverageSummary | null {
    if (this.manifestStatus !== 'loaded' || !this.metadata) {
      return null;
    }
    const activeLevel = this.getActiveLevelState();
    const recordSource = activeLevel ? activeLevel.tilesByKey : this.tilesByKey;
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

    for (const record of recordSource.values()) {
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
      totalTiles: recordSource.size,
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
      record.requestGeneration = this.requestGenerationCounter++;
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
    this.levelsByResolution.clear();
    this.hierarchy = null;
    this.activeResolutionMeters = null;
    this.desiredResolutionMeters = null;
    this.pendingResolutionMeters = null;
    this.transitionState = 'idle';
    this.transitionGeneration += 1;
    this.transitionStartedAtMs = null;
    this.budgetDeferralReason = null;
    this.lastDeferredViewportSignature = null;
    this.lastDeferredBudgetBytes = null;
    this.lastScaleEval = null;
    this.speculativeBackpressureActive = false;
    this.workerBackpressureActive = false;
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

  private buildTileRecord(
    entry: TileManifestEntry,
    tileKey: string,
    resolutionMeters: number,
    originEasting: number,
    originNorthing: number
  ): ManagedTileRecord {
    const minX = entry.minEasting - originEasting;
    const maxX = entry.maxEasting - originEasting;
    const minZ = originNorthing - entry.maxNorthing;
    const maxZ = originNorthing - entry.minNorthing;

    const ovMinX = entry.tileCenterX + entry.overhangMinX;
    const ovMaxX = entry.tileCenterX + entry.overhangMaxX;
    const ovMinZ = entry.tileCenterZ + entry.overhangMinZ;
    const ovMaxZ = entry.tileCenterZ + entry.overhangMaxZ;

    return {
      tileKey,
      resolutionMeters,
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
      lastUsedAtMs: 0,
    };
  }

  /**
   * Initializes the stream manager from `/api/tiles/manifest` or a pre-loaded manifest payload.
   * Supports both single-resolution mosaics and multi-resolution hierarchical manifests.
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
      this.manifestPackPath =
        typeof payload.packPath === 'string' && payload.packPath.trim().length > 0
          ? payload.packPath.trim()
          : null;
      this.tilesByKey.clear();
      this.levelsByResolution.clear();
      this.currentViewport = null;
      this.needsViewportRefresh = false;
      this.previousFocus = null;
      this.panLeadVector = { x: 0, z: 0 };

      const hasHierarchy =
        Boolean(payload.hierarchy) &&
        Array.isArray(payload.hierarchy?.levels) &&
        payload.hierarchy!.levels.length >= 2;

      if (hasHierarchy && payload.hierarchy) {
        const h = payload.hierarchy;
        this.hierarchy = h;

        const originEasting = h.canonicalOriginEasting;
        const originNorthing = h.canonicalOriginNorthing;

        for (const levelManifest of h.levels) {
          const levelTiles = new Map<string, ManagedTileRecord>();
          for (const entry of levelManifest.tiles) {
            const tileKey = formatHierarchicalTileKey(
              levelManifest.tileSizeMeters,
              entry.tx,
              entry.ty,
              entry.lod
            );
            const record = this.buildTileRecord(
              entry,
              tileKey,
              levelManifest.tileSizeMeters,
              originEasting,
              originNorthing
            );
            levelTiles.set(tileKey, record);
            this.tilesByKey.set(tileKey, record);
          }
          this.levelsByResolution.set(levelManifest.tileSizeMeters, {
            tileSizeMeters: levelManifest.tileSizeMeters,
            metadata: levelManifest.metadata,
            levelManifest,
            tilesByKey: levelTiles,
          });
        }

        const initialEval = resolveDesiredHierarchicalResolution({
          availableResolutionsMeters: h.resolutionsMeters,
          currentResolutionMeters: null,
          cameraZoom: this.currentCameraZoom,
          viewportWidthPx: this.currentViewportWidthPx,
          viewportHeightPx: this.currentViewportHeightPx,
          policy: this.hierarchicalPolicy,
        });
        this.lastScaleEval = initialEval;
        this.activeResolutionMeters = initialEval.desiredResolutionMeters;
        this.desiredResolutionMeters = initialEval.desiredResolutionMeters;
        this.pendingResolutionMeters = null;
        this.transitionState = 'idle';
        this.budgetDeferralReason = null;

        const activeLevel = this.levelsByResolution.get(this.activeResolutionMeters)!;
        this.metadata = activeLevel.metadata;

        // Size ground plane from the union UTM coverage across all resolutions.
        const unionSpanX = h.unionBoundsUtm.maxEasting - h.unionBoundsUtm.minEasting;
        const unionSpanZ = h.unionBoundsUtm.maxNorthing - h.unionBoundsUtm.minNorthing;
        const maxTileSize = h.resolutionsMeters[h.resolutionsMeters.length - 1] ?? 4096;
        this.groundMesh.userData.__regionalStreamingWidthMeters = unionSpanX;
        if (unionSpanX > 0 && unionSpanZ > 0) {
          const oldGeometry = this.groundMesh.geometry;
          const groundGeometry = this.regionalResources.registerGeometry(
            new THREE.PlaneGeometry(
              unionSpanX + maxTileSize * 2,
              unionSpanZ + maxTileSize * 2,
              1,
              1
            )
          );
          groundGeometry.rotateX(-Math.PI / 2);
          this.groundMesh.geometry = groundGeometry;
          oldGeometry.dispose();
        }

        this.rebuildBoundaryOverlayFromManifest(
          activeLevel.metadata,
          activeLevel.tilesByKey
        );
      } else {
        this.hierarchy = null;
        this.metadata = payload.metadata;
        this.activeResolutionMeters = payload.metadata.tileSizeMeters;
        this.desiredResolutionMeters = payload.metadata.tileSizeMeters;
        this.pendingResolutionMeters = null;
        this.transitionState = 'idle';
        this.budgetDeferralReason = null;

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
          const tileKey = formatTileId(entry.tx, entry.ty);
          const record = this.buildTileRecord(
            entry,
            tileKey,
            payload.metadata.tileSizeMeters,
            originEasting,
            originNorthing
          );
          this.tilesByKey.set(tileKey, record);
        }

        this.levelsByResolution.set(payload.metadata.tileSizeMeters, {
          tileSizeMeters: payload.metadata.tileSizeMeters,
          metadata: payload.metadata,
          levelManifest: null,
          tilesByKey: this.tilesByKey,
        });

        this.rebuildBoundaryOverlayFromManifest(payload.metadata, this.tilesByKey);
      }

      // Only advertise an active mosaic once all tile records and overlays exist.
      this.manifestStatus = 'loaded';
      this.manifestError = null;
      this.emitDiagnostics();
      return this.metadata!;
    } catch (err) {
      this.resetLoadedManifestState();
      this.manifestStatus = 'error';
      this.manifestError = err instanceof Error ? err.message : String(err);
      this.emitDiagnostics();
      throw err;
    }
  }

  private rebuildBoundaryOverlayFromManifest(
    metadata: TilePackMetadata,
    levelTiles: Map<string, ManagedTileRecord> = this.tilesByKey
  ): void {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const record of levelTiles.values()) {
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
      tiles: new Array(levelTiles.size),
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

    if (bounds.viewportWidthPx !== undefined) {
      this.currentViewportWidthPx = bounds.viewportWidthPx;
    }
    if (bounds.viewportHeightPx !== undefined) {
      this.currentViewportHeightPx = bounds.viewportHeightPx;
    }

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

  private getViewportSignature(viewport: TileViewportGroundBounds): string {
    return `${viewport.minX.toFixed(1)},${viewport.maxX.toFixed(1)},${viewport.minZ.toFixed(1)},${viewport.maxZ.toFixed(1)},${(viewport.cameraZoom ?? this.currentCameraZoom).toFixed(4)},${viewport.viewportWidthPx ?? 0}`;
  }

  private cancelPendingTransition(reason: string): void {
    if (this.pendingResolutionMeters === null) return;
    const prevPendingRes = this.pendingResolutionMeters;
    const pendingLevel = this.levelsByResolution.get(prevPendingRes);
    const now = performance.now();
    if (pendingLevel) {
      for (const record of pendingLevel.tilesByKey.values()) {
        if (
          record.state === 'queued' ||
          record.state === 'fetching' ||
          record.state === 'decoding' ||
          record.state === 'ready_to_commit'
        ) {
          this.cancelInFlightTile(record);
        } else if (record.state === 'prepared_inactive') {
          if (
            record.reconstructed &&
            this.hierarchicalBudget.maxInactiveCachedTiles > 0 &&
            this.hierarchicalBudget.inactiveCacheBudgetBytes > 0
          ) {
            record.state = 'cached_inactive';
            record.lastUsedAtMs = now;
          } else {
            this.disposeReconstructedTile(record, false);
          }
        }
        record.isVisibleInViewport = false;
        record.isInFetchSet = false;
        record.isInKeepSet = false;
      }
    }

    const elapsedMs =
      this.transitionStartedAtMs !== null
        ? Math.max(0, now - this.transitionStartedAtMs)
        : 0;
    const prevGen = this.transitionGeneration;
    this.pendingResolutionMeters = null;
    this.transitionState = 'idle';
    this.transitionStartedAtMs = null;
    this.budgetDeferralReason = null;
    this.transitionGeneration += 1;
    this.transitionsCancelledTotal += 1;
    this.needsViewportRefresh = true;

    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    if (prof) {
      prof.recordEvent({
        eventType: 'resolution_transition_cancel',
        tileKey: `transition:${this.activeResolutionMeters ?? 0}->${prevPendingRes}`,
        tileSizeMeters: prevPendingRes,
        lod: 0,
        durationMs: elapsedMs,
        queueDepths: this.getQueueDepthSnapshot(),
        detail: {
          reason,
          fromResolutionMeters: this.activeResolutionMeters ?? undefined,
          toResolutionMeters: prevPendingRes,
          transitionGeneration: prevGen,
        },
      });
    }
  }

  private deferPendingTransitionForBudget(reason: string): void {
    if (this.pendingResolutionMeters === null) return;
    const pendingRes = this.pendingResolutionMeters;
    const pendingLevel = this.levelsByResolution.get(pendingRes);
    if (pendingLevel) {
      for (const record of pendingLevel.tilesByKey.values()) {
        if (
          record.state === 'queued' ||
          record.state === 'fetching' ||
          record.state === 'decoding' ||
          record.state === 'ready_to_commit'
        ) {
          this.cancelInFlightTile(record);
        } else if (record.state === 'prepared_inactive') {
          this.disposeReconstructedTile(record, false);
        }
      }
    }
    this.transitionState = 'deferred_budget';
    this.budgetDeferralReason = reason;
    this.lastDeferredViewportSignature = this.currentViewport
      ? this.getViewportSignature(this.currentViewport)
      : null;
    this.lastDeferredBudgetBytes = this.hierarchicalBudget.totalMemoryBudgetBytes;
    this.transitionsDeferredBudgetTotal += 1;

    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    if (prof) {
      prof.recordEvent({
        eventType: 'resolution_transition_defer_budget',
        tileKey: `transition:${this.activeResolutionMeters ?? 0}->${pendingRes}`,
        tileSizeMeters: pendingRes,
        lod: 0,
        queueDepths: this.getQueueDepthSnapshot(),
        detail: {
          reason,
          fromResolutionMeters: this.activeResolutionMeters ?? undefined,
          toResolutionMeters: pendingRes,
          transitionGeneration: this.transitionGeneration,
        },
      });
    }
    this.emitDiagnostics();
    this.checkIdleWaiters();
  }

  private evaluateDesiredResolutionInternal(): void {
    if (!this.hierarchy || this.activeResolutionMeters === null) return;

    const evalBasisRes =
      this.pendingResolutionMeters ?? this.activeResolutionMeters;
    const evalResult = resolveDesiredHierarchicalResolution({
      availableResolutionsMeters: this.hierarchy.resolutionsMeters,
      currentResolutionMeters: evalBasisRes,
      cameraZoom: this.currentCameraZoom,
      viewportWidthPx: this.currentViewportWidthPx,
      viewportHeightPx: this.currentViewportHeightPx,
      policy: this.hierarchicalPolicy,
    });
    this.lastScaleEval = evalResult;
    const nextDesired = evalResult.desiredResolutionMeters;
    this.desiredResolutionMeters = nextDesired;

    if (nextDesired === this.activeResolutionMeters) {
      if (this.pendingResolutionMeters !== null) {
        this.cancelPendingTransition('zoom_reversed_to_active');
      }
      return;
    }

    if (this.pendingResolutionMeters !== nextDesired) {
      if (this.pendingResolutionMeters !== null) {
        this.cancelPendingTransition('retargeted_to_new_resolution');
      }
      this.pendingResolutionMeters = nextDesired;
      this.transitionGeneration += 1;
      this.transitionStartedAtMs = performance.now();
      this.transitionState = 'preparing';
      this.budgetDeferralReason = null;
      this.lastDeferredViewportSignature = null;
      this.lastDeferredBudgetBytes = null;
      this.transitionsStartedTotal += 1;
      this.needsViewportRefresh = true;

      const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
      if (prof) {
        prof.recordEvent({
          eventType: 'resolution_transition_start',
          tileKey: `transition:${this.activeResolutionMeters}->${nextDesired}`,
          tileSizeMeters: nextDesired,
          lod: 0,
          queueDepths: this.getQueueDepthSnapshot(),
          detail: {
            reason: evalResult.reason,
            fromResolutionMeters: this.activeResolutionMeters,
            toResolutionMeters: nextDesired,
            transitionGeneration: this.transitionGeneration,
          },
        });
      }
    }
  }

  private evaluateLevelForViewport(
    level: ResolutionLevelState,
    viewport: TileViewportGroundBounds,
    isPendingDestination: boolean,
    leadFocusX: number,
    leadFocusZ: number,
    prof: StreamingProfiler | null
  ): {
    anyEvictedOrCancelled: boolean;
    anyAttachedFromCache: boolean;
    cancelInFlightMs: number;
    evictDisposeMs: number;
    tilesEvictedCount: number;
    tilesCancelledCount: number;
  } {
    const tileSize = level.tileSizeMeters;
    let fetchMarginMeters: number;
    let keepMarginMeters: number;
    if (this.hierarchy) {
      const margins = resolvePhysicalMarginsForResolution(
        tileSize,
        this.hierarchicalPolicy
      );
      fetchMarginMeters = margins.preloadMarginMeters;
      keepMarginMeters = margins.retainMarginMeters;
    } else {
      fetchMarginMeters = this.preloadMarginTiles * tileSize;
      keepMarginMeters = this.retainMarginTiles * tileSize;
    }

    const fetchMinX = viewport.minX - fetchMarginMeters;
    const fetchMaxX = viewport.maxX + fetchMarginMeters;
    const fetchMinZ = viewport.minZ - fetchMarginMeters;
    const fetchMaxZ = viewport.maxZ + fetchMarginMeters;

    const keepMinX = viewport.minX - keepMarginMeters;
    const keepMaxX = viewport.maxX + keepMarginMeters;
    const keepMinZ = viewport.minZ - keepMarginMeters;
    const keepMaxZ = viewport.maxZ + keepMarginMeters;

    let anyEvictedOrCancelled = false;
    let anyAttachedFromCache = false;
    let cancelInFlightMs = 0;
    let evictDisposeMs = 0;
    let tilesEvictedCount = 0;
    let tilesCancelledCount = 0;
    const now = performance.now();

    for (const record of level.tilesByKey.values()) {
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

      if (this.hierarchy) {
        // 4-tier priority queue:
        // 1. Active visible (-4M)
        // 2. Pending required destination (-3M)
        // 3. Active preload (-2M)
        // 4. Pending speculative preload (-1M)
        const tierOffset = isPendingDestination
          ? isVisible
            ? -3_000_000
            : -1_000_000
          : isVisible
            ? -4_000_000
            : -2_000_000;
        record.priorityScore = tierOffset + distToFocus;
      } else {
        // Visible tiles get a -1,000,000 priority boost so they always load before preload margin tiles
        record.priorityScore = (isVisible ? -1_000_000 : 0) + distToFocus;
      }

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
          if (
            this.hierarchy &&
            record.reconstructed &&
            this.hierarchicalBudget.maxInactiveCachedTiles > 0 &&
            this.hierarchicalBudget.inactiveCacheBudgetBytes > 0
          ) {
            this.detachTileFromCompositeScene(record);
            record.state = 'cached_inactive';
            record.lastUsedAtMs = now;
          } else {
            this.evictLoadedTile(record);
            tilesEvictedCount += 1;
          }
          if (prof) {
            evictDisposeMs += performance.now() - tEvict0;
          }
          anyEvictedOrCancelled = true;
        } else if (record.state === 'prepared_inactive') {
          if (
            record.reconstructed &&
            this.hierarchicalBudget.maxInactiveCachedTiles > 0 &&
            this.hierarchicalBudget.inactiveCacheBudgetBytes > 0
          ) {
            record.state = 'cached_inactive';
            record.lastUsedAtMs = now;
          } else {
            this.disposeReconstructedTile(record, false);
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
        if (record.state === 'cached_inactive' && record.reconstructed) {
          this.cacheHitsTotal += 1;
          record.lastUsedAtMs = now;
          if (isPendingDestination) {
            // Keep detached until atomic frame-boundary activation!
            record.state = 'prepared_inactive';
          } else {
            record.reconstructed.scene.updateCameraZoom?.(this.currentCameraZoom);
            record.reconstructed.applyFoliageRuntimeState(this.foliageRuntimeState);
            record.state = 'loaded';
            this.attachTileToCompositeScene(record);
            anyAttachedFromCache = true;
          }
          if (prof) {
            prof.recordEvent({
              eventType: 'cache_hit',
              tileKey: record.tileKey,
              tileSizeMeters: record.resolutionMeters,
              lod: record.manifest.lod,
              queueDepths: this.getQueueDepthSnapshot(),
              detail: {
                reason: isPendingDestination
                  ? 'pending_destination_cache_hit'
                  : 'active_reentry_cache_hit',
              },
            });
          }
        } else if (record.state === 'unloaded' || record.state === 'error') {
          if (
            isPendingDestination &&
            this.transitionState === 'deferred_budget'
          ) {
            // Do not re-queue pending tiles while deferred due to budget limits.
          } else if (
            isPendingDestination &&
            !isVisible &&
            this.speculativeBackpressureActive
          ) {
            // Suppress speculative pending preload when budget reserve is tight.
          } else {
            record.state = 'queued';
            record.lastError = null;
          }
        } else if (
          record.state === 'fetching' ||
          record.state === 'decoding' ||
          record.state === 'ready_to_commit'
        ) {
          this.duplicateRequestsSkippedTotal += 1;
        }
      }
    }

    return {
      anyEvictedOrCancelled,
      anyAttachedFromCache,
      cancelInFlightMs,
      evictDisposeMs,
      tilesEvictedCount,
      tilesCancelledCount,
    };
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
    if (viewport.viewportWidthPx !== undefined) {
      this.currentViewportWidthPx = viewport.viewportWidthPx;
    }
    if (viewport.viewportHeightPx !== undefined) {
      this.currentViewportHeightPx = viewport.viewportHeightPx;
    }
    this.needsViewportRefresh = false;
    this.viewportSelectionPasses++;

    if (
      this.hierarchy &&
      viewport.cameraZoom !== undefined &&
      Number.isFinite(viewport.cameraZoom) &&
      viewport.cameraZoom > 0 &&
      viewport.cameraZoom !== this.currentCameraZoom
    ) {
      this.applyCameraZoomWithoutResolutionEval(viewport.cameraZoom);
    }

    if (this.hierarchy) {
      if (this.transitionState === 'deferred_budget') {
        const sig = this.getViewportSignature(viewport);
        if (
          sig !== this.lastDeferredViewportSignature ||
          this.hierarchicalBudget.totalMemoryBudgetBytes !==
            this.lastDeferredBudgetBytes
        ) {
          this.transitionState = 'preparing';
          this.budgetDeferralReason = null;
        }
      }
      this.evaluateDesiredResolutionInternal();
    }

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

    const leadFocusX = viewport.focusX + this.panLeadVector.x;
    const leadFocusZ = viewport.focusZ + this.panLeadVector.z;

    let anyEvictedOrCancelled = false;
    let anyAttachedFromCache = false;
    let cancelInFlightMs = 0;
    let evictDisposeMs = 0;
    let tilesEvictedCount = 0;
    let tilesCancelledCount = 0;

    const activeLevel = this.getActiveLevelState();
    if (activeLevel) {
      const activeRes = this.evaluateLevelForViewport(
        activeLevel,
        viewport,
        false,
        leadFocusX,
        leadFocusZ,
        prof
      );
      anyEvictedOrCancelled =
        anyEvictedOrCancelled || activeRes.anyEvictedOrCancelled;
      anyAttachedFromCache =
        anyAttachedFromCache || activeRes.anyAttachedFromCache;
      cancelInFlightMs += activeRes.cancelInFlightMs;
      evictDisposeMs += activeRes.evictDisposeMs;
      tilesEvictedCount += activeRes.tilesEvictedCount;
      tilesCancelledCount += activeRes.tilesCancelledCount;
    }

    if (this.hierarchy) {
      const pendingLevel = this.getPendingLevelState();
      if (pendingLevel && this.transitionState !== 'deferred_budget') {
        const pendingRes = this.evaluateLevelForViewport(
          pendingLevel,
          viewport,
          true,
          leadFocusX,
          leadFocusZ,
          prof
        );
        anyEvictedOrCancelled =
          anyEvictedOrCancelled || pendingRes.anyEvictedOrCancelled;
        cancelInFlightMs += pendingRes.cancelInFlightMs;
        evictDisposeMs += pendingRes.evictDisposeMs;
        tilesEvictedCount += pendingRes.tilesEvictedCount;
        tilesCancelledCount += pendingRes.tilesCancelledCount;
      }

      // Ensure idle non-active, non-pending levels have no stale in-flight work.
      for (const [resMeters, level] of this.levelsByResolution.entries()) {
        if (
          resMeters === this.activeResolutionMeters ||
          resMeters === this.pendingResolutionMeters
        ) {
          continue;
        }
        for (const record of level.tilesByKey.values()) {
          if (
            record.state === 'queued' ||
            record.state === 'fetching' ||
            record.state === 'decoding' ||
            record.state === 'ready_to_commit'
          ) {
            this.cancelInFlightTile(record);
            anyEvictedOrCancelled = true;
          } else if (record.state === 'prepared_inactive') {
            record.state = 'cached_inactive';
            record.lastUsedAtMs = performance.now();
          }
          record.isVisibleInViewport = false;
          record.isInFetchSet = false;
          record.isInKeepSet = false;
        }
      }

      this.enforceResourceBudgets();

      if (
        pendingLevel &&
        this.pendingResolutionMeters !== null &&
        this.transitionState !== 'deferred_budget'
      ) {
        const readiness = this.checkDestinationReadiness(pendingLevel);
        this.transitionState = readiness.allReady
          ? 'ready_to_activate'
          : 'preparing';
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
    if (anyEvictedOrCancelled || anyAttachedFromCache) {
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

  private checkDestinationReadiness(pendingLevel: ResolutionLevelState): {
    requiredCount: number;
    readyCount: number;
    allReady: boolean;
  } {
    let requiredCount = 0;
    let readyCount = 0;
    for (const record of pendingLevel.tilesByKey.values()) {
      if (!record.isVisibleInViewport) continue;
      requiredCount += 1;
      // Only fully reconstructed tiles (`prepared_inactive`, `cached_inactive`, `loaded` with reconstructed scene)
      // or explicitly empty manifest tiles satisfy destination readiness.
      // Never treat `fetching`, `decoding`, `ready_to_commit`, or `error` as ready!
      const isTileReady =
        record.manifest.isEmpty ||
        ((record.state === 'prepared_inactive' ||
          record.state === 'cached_inactive' ||
          record.state === 'loaded') &&
          record.reconstructed !== null);
      if (isTileReady) {
        readyCount += 1;
      }
    }
    return {
      requiredCount,
      readyCount,
      allReady: readyCount === requiredCount,
    };
  }

  private activatePendingResolutionAtomic(): void {
    if (
      !this.hierarchy ||
      this.activeResolutionMeters === null ||
      this.pendingResolutionMeters === null
    ) {
      return;
    }
    const oldRes = this.activeResolutionMeters;
    const newRes = this.pendingResolutionMeters;
    const oldLevel = this.levelsByResolution.get(oldRes);
    const newLevel = this.levelsByResolution.get(newRes);
    if (!oldLevel || !newLevel) return;

    const tAct0 = performance.now();
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;

    // 1. Detach every tile of the outgoing active resolution (zero simultaneous overlap!)
    for (const record of oldLevel.tilesByKey.values()) {
      if (
        record.state === 'queued' ||
        record.state === 'fetching' ||
        record.state === 'decoding' ||
        record.state === 'ready_to_commit'
      ) {
        this.cancelInFlightTile(record);
      } else if (record.state === 'loaded') {
        this.detachTileFromCompositeScene(record);
        if (
          record.reconstructed &&
          this.hierarchicalBudget.maxInactiveCachedTiles > 0 &&
          this.hierarchicalBudget.inactiveCacheBudgetBytes > 0
        ) {
          record.state = 'cached_inactive';
          record.lastUsedAtMs = tAct0;
        } else {
          this.disposeReconstructedTile(record, false);
        }
      }
      record.isVisibleInViewport = false;
      record.isInFetchSet = false;
      record.isInKeepSet = false;
    }

    // 2. Attach all prepared/cached tiles of the incoming destination resolution in keepSet
    for (const record of newLevel.tilesByKey.values()) {
      if (
        (record.state === 'prepared_inactive' ||
          record.state === 'cached_inactive') &&
        record.reconstructed !== null
      ) {
        if (record.isInKeepSet) {
          record.reconstructed.scene.updateCameraZoom?.(this.currentCameraZoom);
          record.reconstructed.applyFoliageRuntimeState(this.foliageRuntimeState);
          record.state = 'loaded';
          record.lastUsedAtMs = tAct0;
          this.attachTileToCompositeScene(record);
          if (prof) {
            const fp = record.decodedFootprint;
            const rawBytes = fp ? fp.cpuGeometryBytes + fp.bvhBytes : null;
            const attachNowMs = performance.now();
            prof.recordEvent({
              eventType: 'attach',
              tileKey: record.tileKey,
              tileSizeMeters: record.resolutionMeters,
              lod: record.manifest.lod,
              timestampMs: attachNowMs,
              payloadCompressedBytes: record.lastCompressedBytes ?? null,
              payloadRawBytes: rawBytes,
              queueDepths: this.getQueueDepthSnapshot(),
              detail: {
                reason: 'atomic_resolution_activation',
                meshCount: fp?.meshCount,
                triangleCount: fp?.triangleCount,
              },
            });
            prof.markTilePendingFirstRender({
              tileKey: record.tileKey,
              tileSizeMeters: record.resolutionMeters,
              lod: record.manifest.lod,
              triangles: record.reconstructed.scene.stats.totalTriangles,
              meshes: fp?.meshCount ?? 0,
              compressedBytes: record.lastCompressedBytes ?? null,
              rawBytes,
              attachTimestampMs: attachNowMs,
            });
          }
        } else {
          record.state = 'cached_inactive';
          record.lastUsedAtMs = tAct0;
        }
      }
    }

    // 3. Commit new active resolution state, metadata, and tile boundary overlay
    const elapsedTotalMs =
      this.transitionStartedAtMs !== null
        ? Math.max(0, performance.now() - this.transitionStartedAtMs)
        : 0;
    const completedGen = this.transitionGeneration;
    this.activeResolutionMeters = newRes;
    this.pendingResolutionMeters = null;
    this.transitionState = 'idle';
    this.transitionStartedAtMs = null;
    this.budgetDeferralReason = null;
    this.lastDeferredViewportSignature = null;
    this.lastDeferredBudgetBytes = null;
    this.metadata = newLevel.metadata;

    this.rebuildBoundaryOverlayFromManifest(
      newLevel.metadata,
      newLevel.tilesByKey
    );
    if (this.currentWireframe) {
      this.materialRegistry.setWireframe(true);
    }
    this.rebuildCompositeStats();

    // 4. Enforce LRU cache and total memory budgets after swap
    this.enforceResourceBudgets();

    const swapMs = performance.now() - tAct0;
    this.transitionsCompletedTotal += 1;
    this.lastTransitionTotalMs = elapsedTotalMs;
    this.lastActivationSwapMs = swapMs;
    this.maxActivationSwapMs = Math.max(this.maxActivationSwapMs, swapMs);
    pushBoundedSample(this.activationSwapMsRing, swapMs);
    pushBoundedSample(this.transitionDurationMsRing, elapsedTotalMs);

    if (prof) {
      prof.recordEvent({
        eventType: 'resolution_transition_activate',
        tileKey: `transition:${oldRes}->${newRes}`,
        tileSizeMeters: newRes,
        lod: 0,
        durationMs: swapMs,
        queueDepths: this.getQueueDepthSnapshot(),
        detail: {
          fromResolutionMeters: oldRes,
          toResolutionMeters: newRes,
          transitionGeneration: completedGen,
          reason: `totalTransitionMs=${elapsedTotalMs.toFixed(2)}`,
        },
      });
    }

    this.updatePeakTileCounters();
    this.emitDiagnostics();
  }

  /**
   * Commits up to `maxCommits` decoded tiles (`ready_to_commit`) into the Three.js
   * composite scene graph on the main thread (time-aware in hierarchical mode),
   * and executes atomic frame-boundary resolution activation when all required
   * destination tiles are prepared.
   */
  tick(maxCommits = this.maxCommitsPerFrame): number {
    if (this.isDisposed) return 0;
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    const tTick0 = prof ? performance.now() : 0;

    this.pumpFetchQueue();

    const tReady0 = prof ? performance.now() : 0;
    const readyRecords: ManagedTileRecord[] = [];
    const activeLevel = this.getActiveLevelState();
    if (activeLevel) {
      for (const record of activeLevel.tilesByKey.values()) {
        if (record.state === 'ready_to_commit' && record.isInKeepSet) {
          readyRecords.push(record);
        }
      }
    }
    const pendingLevel =
      this.hierarchy && this.transitionState !== 'deferred_budget'
        ? this.getPendingLevelState()
        : null;
    if (pendingLevel) {
      for (const record of pendingLevel.tilesByKey.values()) {
        if (record.state === 'ready_to_commit' && record.isInKeepSet) {
          readyRecords.push(record);
        }
      }
    }

    if (readyRecords.length === 0) {
      // Even with zero new commits, check if a pending transition is already ready (e.g. 100% cache hit!)
      if (
        this.hierarchy &&
        pendingLevel &&
        this.pendingResolutionMeters !== null &&
        this.transitionState !== 'deferred_budget'
      ) {
        const readiness = this.checkDestinationReadiness(pendingLevel);
        if (readiness.allReady) {
          this.activatePendingResolutionAtomic();
        }
      }
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
    const maxCommitBudgetMs =
      this.hierarchy && maxCommits !== Number.MAX_SAFE_INTEGER
        ? this.hierarchicalBudget.maxCommitBudgetMsPerFrame
        : Number.POSITIVE_INFINITY;

    let committed = 0;
    let committedActive = 0;
    let totalReconMs = 0;
    let totalInstancedBvhMs = 0;
    let totalInstancedBvhAdoptMs = 0;
    let totalWorkerBvhAdopted = 0;
    let totalSyncBvhFallback = 0;
    let totalStaticBvhMs = 0;
    let totalAttachMs = 0;
    const tBatch0 = performance.now();

    for (let i = 0; i < limit; i++) {
      // Time-aware budget: always commit at least 1 tile so large tiles never starve.
      if (i > 0 && performance.now() - tBatch0 >= maxCommitBudgetMs) {
        break;
      }

      const record = readyRecords[i];
      if (!record.decodedPayload) continue;
      const isPendingRecord =
        this.hierarchy !== null &&
        record.resolutionMeters === this.pendingResolutionMeters &&
        record.resolutionMeters !== this.activeResolutionMeters;
      if (
        this.hierarchy &&
        !isPendingRecord &&
        record.resolutionMeters !== this.activeResolutionMeters
      ) {
        // Stale record from an inactive level; discard cleanly
        record.decodedPayload = null;
        record.decodedFootprint = null;
        record.state = 'unloaded';
        continue;
      }
      if (isPendingRecord && this.transitionState === 'deferred_budget') {
        continue;
      }

      const footprintSnapshot = record.decodedFootprint;
      const compressedBytes = record.lastCompressedBytes ?? null;
      const rawBytes = footprintSnapshot
        ? footprintSnapshot.cpuGeometryBytes + footprintSnapshot.bvhBytes
        : null;
      const tileSizeMeters = record.resolutionMeters;

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
          optimizeMainThreadPrep: this.tilePrepOptions.optimizeMainThreadPrep,
        }
      );
      const reconstructMs = performance.now() - t0;

      this.totalReconstructMs += reconstructMs;
      this.reconstructSamples += 1;
      pushBoundedSample(this.reconstructMsRing, reconstructMs);

      this.workerBvhAdoptedTotal += reconstructed.stageTimings.workerBvhAdoptedCount;
      this.syncBvhFallbackTotal += reconstructed.stageTimings.syncBvhFallbackCount;

      record.reconstructed = reconstructed;
      record.decodedPayload = null;
      record.lastUsedAtMs = performance.now();
      this.completedLoadsTotal += 1;

      if (prof) {
        totalReconMs += reconstructMs;
        totalInstancedBvhMs += reconstructed.stageTimings.instancedBvhBuildMs;
        totalInstancedBvhAdoptMs += reconstructed.stageTimings.instancedBvhAdoptMs;
        totalWorkerBvhAdopted += reconstructed.stageTimings.workerBvhAdoptedCount;
        totalSyncBvhFallback += reconstructed.stageTimings.syncBvhFallbackCount;
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
            instancedBvhAdoptMs: reconstructed.stageTimings.instancedBvhAdoptMs,
            workerBvhAdoptedCount: reconstructed.stageTimings.workerBvhAdoptedCount,
            syncBvhFallbackCount: reconstructed.stageTimings.syncBvhFallbackCount,
            staticBvhDeserializeMs: reconstructed.stageTimings.staticBvhDeserializeMs,
            instancedBatchCount: reconstructed.instancedPickingStats.indexedBatchCount,
            indexedInstances: reconstructed.instancedPickingStats.totalIndexedInstances,
            meshCount: footprintSnapshot?.meshCount,
            triangleCount: footprintSnapshot?.triangleCount,
          },
        });
      }

      if (isPendingRecord) {
        // Reconstructed off-scene; do NOT attach until atomic activation!
        record.state = 'prepared_inactive';
        committed += 1;
        this.enforceResourceBudgets();
      } else {
        record.state = 'loaded';
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
        committedActive += 1;
      }
    }

    let commitRebuildStatsMs = 0;
    let commitEmitDiagnosticsMs = 0;
    if (committed > 0) {
      const batchCommitMs = performance.now() - tBatch0;
      this.lastCommitMs = batchCommitMs;
      this.maxCommitMs = Math.max(this.maxCommitMs, batchCommitMs);
      pushBoundedSample(this.commitMsRing, batchCommitMs);

      if (committedActive > 0) {
        if (this.currentWireframe) {
          this.materialRegistry.setWireframe(true);
        }
        const tStats0 = prof ? performance.now() : 0;
        this.rebuildCompositeStats();
        if (prof) commitRebuildStatsMs = performance.now() - tStats0;
      }

      if (this.hierarchy) {
        this.enforceResourceBudgets();
      }

      const tDiag0 = prof ? performance.now() : 0;
      this.emitDiagnostics();
      if (prof) commitEmitDiagnosticsMs = performance.now() - tDiag0;
    }

    // Atomic frame-boundary resolution activation check
    if (
      this.hierarchy &&
      this.pendingResolutionMeters !== null &&
      this.transitionState !== 'deferred_budget'
    ) {
      const currentPendingLevel = this.getPendingLevelState();
      if (currentPendingLevel) {
        const readiness = this.checkDestinationReadiness(currentPendingLevel);
        if (readiness.allReady) {
          this.activatePendingResolutionAtomic();
        } else {
          this.transitionState = 'preparing';
        }
      }
    }

    // Re-pump fetch queue in case draining `ready_to_commit` relieved worker backpressure
    this.pumpFetchQueue();
    this.checkIdleWaiters();
    if (prof) {
      prof.recordStreamTick({
        totalMs: performance.now() - tTick0,
        readyScanAndSortMs,
        reconstructMs: totalReconMs,
        instancedBvhBuildMs: totalInstancedBvhMs,
        instancedBvhAdoptMs: totalInstancedBvhAdoptMs,
        workerBvhAdoptedCount: totalWorkerBvhAdopted,
        syncBvhFallbackCount: totalSyncBvhFallback,
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
   * Waits until all tiles in the current `fetchSet` (and any non-deferred pending
   * hierarchical resolution transition) have finished fetching, decoding, and committing.
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

  private applyCameraZoomWithoutResolutionEval(zoom: number): boolean {
    if (this.experimentSkipUnchangedZoom && zoom === this.currentCameraZoom) {
      this.zoomPropagationSkips++;
      return false;
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
    return true;
  }

  updateCameraZoom(zoom: number): void {
    if (this.isDisposed) return;
    const changed = this.applyCameraZoomWithoutResolutionEval(zoom);
    if (changed && this.hierarchy && this.manifestStatus === 'loaded') {
      const prevPending = this.pendingResolutionMeters;
      this.evaluateDesiredResolutionInternal();
      if (prevPending !== this.pendingResolutionMeters && this.currentViewport) {
        this.updateViewport({
          ...this.currentViewport,
          cameraZoom: zoom,
        });
      }
    }
  }

  setWireframe(enabled: boolean): void {
    if (this.isDisposed) return;
    this.currentWireframe = enabled;
    this.materialRegistry.setWireframe(enabled);
  }

  getTileState(tileKey: string): TileStreamLifecycleState {
    const direct = this.tilesByKey.get(tileKey);
    if (direct) return direct.state;
    if (this.hierarchy && this.activeResolutionMeters !== null) {
      const activeLevel = this.levelsByResolution.get(this.activeResolutionMeters);
      if (activeLevel) {
        for (const rec of activeLevel.tilesByKey.values()) {
          if (formatTileId(rec.manifest.tx, rec.manifest.ty) === tileKey) {
            return rec.state;
          }
        }
      }
    }
    return 'unloaded';
  }

  private computeRecordFootprintBreakdown(record: ManagedTileRecord): {
    cpuGeometryBytes: number;
    staticBvhBytes: number;
    instancedIndexBytes: number;
    queuedDecodedBytes: number;
    estimatedWorkerBytes: number;
    estimatedGpuBytes: number;
    totalMeasuredBytes: number;
  } {
    const fp = record.decodedFootprint;
    if (record.state === 'fetching' || record.state === 'decoding') {
      // Conservative estimate of in-flight worker preparation buffers based on compressed payload size (or 0 before response).
      const comp = record.lastCompressedBytes ?? 0;
      const estimatedWorkerBytes = comp > 0 ? comp * 4 : 0;
      return {
        cpuGeometryBytes: 0,
        staticBvhBytes: 0,
        instancedIndexBytes: 0,
        queuedDecodedBytes: 0,
        estimatedWorkerBytes,
        estimatedGpuBytes: 0,
        totalMeasuredBytes: 0,
      };
    }

    if (record.state === 'ready_to_commit') {
      const cpuGeometryBytes = fp?.cpuGeometryBytes ?? 0;
      const preparedInstanced = fp?.preparedInstancedBvhBytes ?? 0;
      const staticBvhBytes = Math.max(0, (fp?.bvhBytes ?? 0) - preparedInstanced);
      const queuedDecodedBytes = cpuGeometryBytes + staticBvhBytes + preparedInstanced;
      return {
        cpuGeometryBytes: 0,
        staticBvhBytes: 0,
        instancedIndexBytes: 0,
        queuedDecodedBytes,
        estimatedWorkerBytes: 0,
        estimatedGpuBytes: 0,
        totalMeasuredBytes: queuedDecodedBytes,
      };
    }

    if (
      (record.state === 'loaded' ||
        record.state === 'prepared_inactive' ||
        record.state === 'cached_inactive') &&
      record.reconstructed !== null
    ) {
      const cpuGeometryBytes = fp?.cpuGeometryBytes ?? 0;
      const preparedInstanced = fp?.preparedInstancedBvhBytes ?? 0;
      const staticBvhBytes = Math.max(0, (fp?.bvhBytes ?? 0) - preparedInstanced);
      const instancedIndexBytes =
        record.reconstructed.instancedPickingStats.totalIndexMemoryBytes;
      // Explicitly estimated GPU vertex/index/instance buffer bytes (WebGL does not expose driver VRAM).
      const estimatedGpuBytes = cpuGeometryBytes;
      const totalMeasuredBytes =
        cpuGeometryBytes + staticBvhBytes + instancedIndexBytes;
      return {
        cpuGeometryBytes,
        staticBvhBytes,
        instancedIndexBytes,
        queuedDecodedBytes: 0,
        estimatedWorkerBytes: 0,
        estimatedGpuBytes,
        totalMeasuredBytes,
      };
    }

    return {
      cpuGeometryBytes: 0,
      staticBvhBytes: 0,
      instancedIndexBytes: 0,
      queuedDecodedBytes: 0,
      estimatedWorkerBytes: 0,
      estimatedGpuBytes: 0,
      totalMeasuredBytes: 0,
    };
  }

  private computeHierarchicalResourceAccounting(): HierarchicalResourceAccountingSnapshot {
    const byResolution: ResolutionResourceAccounting[] = [];
    let activeGeometryBytes = 0;
    let pendingDestinationGeometryBytes = 0;
    let estimatedWorkerPrepBufferBytes = 0;
    let queuedDecodedPayloadBytes = 0;
    let instancedSpatialIndexBytes = 0;
    let staticBvhBytes = 0;
    let retainedInactiveTilesBytes = 0;
    let totalMeasuredBytes = 0;
    let totalEstimatedGpuBytes = 0;

    const sortedResolutions = [...this.levelsByResolution.keys()].sort(
      (a, b) => a - b
    );
    for (const resMeters of sortedResolutions) {
      const level = this.levelsByResolution.get(resMeters)!;
      const acc = createEmptyResolutionAccounting(resMeters);
      for (const record of level.tilesByKey.values()) {
        if (record.state === 'loaded') acc.attachedActiveTiles += 1;
        else if (record.state === 'prepared_inactive') acc.preparedPendingTiles += 1;
        else if (record.state === 'cached_inactive') acc.cachedInactiveTiles += 1;
        else if (record.state === 'queued') acc.queuedTiles += 1;
        else if (record.state === 'fetching') acc.fetchingTiles += 1;
        else if (record.state === 'decoding') acc.decodingTiles += 1;
        else if (record.state === 'ready_to_commit') acc.readyToCommitTiles += 1;

        const b = this.computeRecordFootprintBreakdown(record);
        acc.measuredCpuGeometryBytes += b.cpuGeometryBytes;
        acc.measuredStaticBvhBytes += b.staticBvhBytes;
        acc.measuredInstancedIndexBytes += b.instancedIndexBytes;
        acc.measuredQueuedDecodedBytes += b.queuedDecodedBytes;
        acc.estimatedWorkerBufferBytes += b.estimatedWorkerBytes;
        acc.estimatedGpuBytes += b.estimatedGpuBytes;

        if (record.state === 'cached_inactive') {
          acc.measuredRetainedInactiveBytes += b.totalMeasuredBytes;
          retainedInactiveTilesBytes += b.totalMeasuredBytes;
        } else if (record.state === 'loaded') {
          activeGeometryBytes += b.cpuGeometryBytes;
        } else if (
          record.state === 'prepared_inactive' ||
          (record.state === 'ready_to_commit' &&
            record.resolutionMeters === this.pendingResolutionMeters)
        ) {
          pendingDestinationGeometryBytes +=
            b.cpuGeometryBytes + b.queuedDecodedBytes;
        }

        estimatedWorkerPrepBufferBytes += b.estimatedWorkerBytes;
        queuedDecodedPayloadBytes += b.queuedDecodedBytes;
        instancedSpatialIndexBytes += b.instancedIndexBytes;
        staticBvhBytes += b.staticBvhBytes;
        totalMeasuredBytes += b.totalMeasuredBytes;
        totalEstimatedGpuBytes += b.estimatedGpuBytes;
      }
      byResolution.push(acc);
    }

    return {
      budget: { ...this.hierarchicalBudget },
      activeGeometryBytes,
      pendingDestinationGeometryBytes,
      estimatedWorkerPrepBufferBytes,
      queuedDecodedPayloadBytes,
      instancedSpatialIndexBytes,
      staticBvhBytes,
      retainedInactiveTilesBytes,
      totalMeasuredBytes,
      totalEstimatedGpuBytes,
      speculativeBackpressureActive: this.speculativeBackpressureActive,
      workerBackpressureActive: this.workerBackpressureActive,
      byResolution,
    };
  }

  private disposeReconstructedTile(
    record: ManagedTileRecord,
    isCacheEviction: boolean
  ): void {
    const prof = this.profiler && this.profiler.enabled ? this.profiler : null;
    const t0 = prof ? performance.now() : 0;
    const fp = record.decodedFootprint;
    if (record.state === 'loaded') {
      this.detachTileFromCompositeScene(record);
    }
    if (record.reconstructed) {
      record.reconstructed.dispose();
      record.reconstructed = null;
    }
    record.decodedPayload = null;
    record.decodedFootprint = null;
    record.state = 'unloaded';
    this.evictedTilesTotal += 1;
    if (isCacheEviction) {
      this.cacheEvictionsTotal += 1;
    }
    if (prof) {
      prof.recordEvent({
        eventType: isCacheEviction ? 'cache_evict' : 'evict',
        tileKey: record.tileKey,
        tileSizeMeters: record.resolutionMeters,
        lod: record.manifest.lod,
        payloadCompressedBytes: record.lastCompressedBytes ?? null,
        payloadRawBytes: fp ? fp.cpuGeometryBytes + fp.bvhBytes : null,
        durationMs: performance.now() - t0,
        queueDepths: this.getQueueDepthSnapshot(),
      });
    }
  }

  private enforceResourceBudgets(): void {
    if (!this.hierarchy) return;
    const budget = this.hierarchicalBudget;

    // 1. Enforce inactive cache tile count & byte limits via LRU order
    const cachedRecords: Array<{ record: ManagedTileRecord; bytes: number }> = [];
    let cachedBytesTotal = 0;
    for (const record of this.tilesByKey.values()) {
      if (record.state === 'cached_inactive') {
        const bytes = this.computeRecordFootprintBreakdown(record).totalMeasuredBytes;
        cachedRecords.push({ record, bytes });
        cachedBytesTotal += bytes;
      }
    }
    cachedRecords.sort((a, b) => a.record.lastUsedAtMs - b.record.lastUsedAtMs);

    while (
      cachedRecords.length > 0 &&
      (cachedRecords.length > budget.maxInactiveCachedTiles ||
        cachedBytesTotal > budget.inactiveCacheBudgetBytes)
    ) {
      const oldest = cachedRecords.shift()!;
      this.disposeReconstructedTile(oldest.record, true);
      cachedBytesTotal = Math.max(0, cachedBytesTotal - oldest.bytes);
    }

    // 2. Enforce total measured memory budget across all resolutions
    let totalMeasured = 0;
    for (const record of this.tilesByKey.values()) {
      totalMeasured += this.computeRecordFootprintBreakdown(record).totalMeasuredBytes;
    }

    if (totalMeasured > budget.totalMemoryBudgetBytes) {
      // 2a. Evict remaining LRU cached_inactive tiles first
      while (
        totalMeasured > budget.totalMemoryBudgetBytes &&
        cachedRecords.length > 0
      ) {
        const oldest = cachedRecords.shift()!;
        this.disposeReconstructedTile(oldest.record, true);
        totalMeasured = Math.max(0, totalMeasured - oldest.bytes);
      }
    }

    if (totalMeasured > budget.totalMemoryBudgetBytes) {
      // 2b. Evict non-visible speculative pending tiles (farthest first)
      const pendingLevel = this.getPendingLevelState();
      if (pendingLevel) {
        const nonVisPending: Array<{ record: ManagedTileRecord; bytes: number }> = [];
        for (const record of pendingLevel.tilesByKey.values()) {
          if (
            !record.isVisibleInViewport &&
            (record.state === 'prepared_inactive' ||
              record.state === 'ready_to_commit')
          ) {
            const bytes =
              this.computeRecordFootprintBreakdown(record).totalMeasuredBytes;
            nonVisPending.push({ record, bytes });
          }
        }
        nonVisPending.sort((a, b) => b.record.priorityScore - a.record.priorityScore);
        for (const item of nonVisPending) {
          if (totalMeasured <= budget.totalMemoryBudgetBytes) break;
          if (item.record.state === 'ready_to_commit') {
            this.cancelInFlightTile(item.record);
          } else {
            this.disposeReconstructedTile(item.record, false);
          }
          totalMeasured = Math.max(0, totalMeasured - item.bytes);
        }
      }
    }

    if (totalMeasured > budget.totalMemoryBudgetBytes) {
      // 2c. Evict non-visible active preload tiles (NEVER evict active visible tiles!)
      const activeLevel = this.getActiveLevelState();
      if (activeLevel) {
        const nonVisActive: Array<{ record: ManagedTileRecord; bytes: number }> = [];
        for (const record of activeLevel.tilesByKey.values()) {
          if (
            !record.isVisibleInViewport &&
            (record.state === 'loaded' || record.state === 'ready_to_commit')
          ) {
            const bytes =
              this.computeRecordFootprintBreakdown(record).totalMeasuredBytes;
            nonVisActive.push({ record, bytes });
          }
        }
        nonVisActive.sort((a, b) => b.record.priorityScore - a.record.priorityScore);
        let evictedAnyActive = false;
        for (const item of nonVisActive) {
          if (totalMeasured <= budget.totalMemoryBudgetBytes) break;
          if (item.record.state === 'ready_to_commit') {
            this.cancelInFlightTile(item.record);
          } else {
            this.evictLoadedTile(item.record);
            evictedAnyActive = true;
          }
          totalMeasured = Math.max(0, totalMeasured - item.bytes);
        }
        if (evictedAnyActive) {
          this.rebuildCompositeStats();
        }
      }
    }

    // 2d. Impossible budget guard: if STILL over budget while a transition is in progress
    // (active visible + pending required destination alone exceed budget), defer cleanly
    // without evicting active visible coverage!
    if (
      totalMeasured > budget.totalMemoryBudgetBytes &&
      this.pendingResolutionMeters !== null &&
      this.transitionState !== 'deferred_budget'
    ) {
      const measuredMb = (totalMeasured / (1024 * 1024)).toFixed(2);
      const budgetMb = (budget.totalMemoryBudgetBytes / (1024 * 1024)).toFixed(2);
      this.deferPendingTransitionForBudget(
        `Transition to ${this.pendingResolutionMeters} m deferred: active visible + replacement coverage (${measuredMb} MiB) exceeds total memory budget (${budgetMb} MiB).`
      );
      totalMeasured = 0;
      for (const record of this.tilesByKey.values()) {
        totalMeasured +=
          this.computeRecordFootprintBreakdown(record).totalMeasuredBytes;
      }
    }

    // 3. Update speculative backpressure flag based on transition reserve
    const reserveCutoffBytes =
      budget.totalMemoryBudgetBytes * (1 - budget.transitionReserveRatio);
    this.speculativeBackpressureActive = totalMeasured >= reserveCutoffBytes;
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
    let pendingReadyTileBytes = 0;

    const loadedTileKeys: string[] = [];
    const visibleTileKeys: string[] = [];
    const loadingTileKeys: string[] = [];

    const activeLevel = this.getActiveLevelState();
    const activeRecords = activeLevel ? activeLevel.tilesByKey : this.tilesByKey;

    for (const [key, record] of activeRecords.entries()) {
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
      }
    }

    // In-flight queues span active + pending levels
    let pendingQueued = 0;
    let pendingFetching = 0;
    let pendingDecoding = 0;
    let pendingReadyToCommit = 0;
    let pendingPreparedTiles = 0;

    for (const [key, record] of this.tilesByKey.entries()) {
      const isPendingRes =
        this.hierarchy !== null &&
        record.resolutionMeters === this.pendingResolutionMeters;
      if (record.state === 'queued') {
        queuedTiles += 1;
        loadingTileKeys.push(key);
        if (isPendingRes) pendingQueued += 1;
      } else if (record.state === 'fetching') {
        fetchingTiles += 1;
        loadingTileKeys.push(key);
        if (isPendingRes) pendingFetching += 1;
      } else if (record.state === 'decoding') {
        decodingTiles += 1;
        loadingTileKeys.push(key);
        if (isPendingRes) pendingDecoding += 1;
      } else if (record.state === 'ready_to_commit') {
        readyToCommitTiles += 1;
        loadingTileKeys.push(key);
        if (isPendingRes) pendingReadyToCommit += 1;
        if (record.decodedFootprint) {
          pendingReadyTileBytes +=
            record.decodedFootprint.cpuGeometryBytes +
            record.decodedFootprint.bvhBytes;
        }
      } else if (record.state === 'prepared_inactive' && isPendingRes) {
        pendingPreparedTiles += 1;
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

    let hierarchicalDiag: HierarchicalStreamingDiagnosticsSnapshot | null = null;
    if (this.hierarchy && isLoaded && this.activeResolutionMeters !== null) {
      const pendingLevel = this.getPendingLevelState();
      const readiness = pendingLevel
        ? this.checkDestinationReadiness(pendingLevel)
        : { requiredCount: 0, readyCount: 0, allReady: true };
      const margins = resolvePhysicalMarginsForResolution(
        this.activeResolutionMeters,
        this.hierarchicalPolicy
      );
      const resources = this.computeHierarchicalResourceAccounting();
      const transitionElapsedMs =
        this.transitionStartedAtMs !== null
          ? Math.max(0, performance.now() - this.transitionStartedAtMs)
          : 0;

      hierarchicalDiag = {
        enabled: true,
        hierarchyName: this.hierarchy.hierarchyName,
        availableResolutionsMeters: [...this.hierarchy.resolutionsMeters],
        resolutionMode: this.hierarchicalPolicy.mode,
        desiredResolutionMeters:
          this.desiredResolutionMeters ?? this.activeResolutionMeters,
        activeResolutionMeters: this.activeResolutionMeters,
        pendingResolutionMeters: this.pendingResolutionMeters,
        transitionState: this.transitionState,
        transitionGeneration: this.transitionGeneration,
        transitionElapsedMs: Number(transitionElapsedMs.toFixed(2)),
        budgetDeferralReason: this.budgetDeferralReason,
        requiredDestinationTiles: readiness.requiredCount,
        readyDestinationTiles: readiness.readyCount,
        activeVisibleTiles: visibleTiles,
        activeLoadedTiles: loadedTiles,
        pendingPreparedTiles,
        rawCameraZoom: this.currentCameraZoom,
        effectiveScalePxPerMeter:
          this.lastScaleEval?.effectiveScalePxPerMeter ?? this.currentCameraZoom,
        viewportScaleFactor: this.lastScaleEval?.viewportScaleFactor ?? 1.0,
        viewportWidthPx: this.currentViewportWidthPx,
        viewportHeightPx: this.currentViewportHeightPx,
        selectionReason: this.lastScaleEval?.reason ?? 'initial_nominal_scale',
        policy: this.getHierarchicalPolicyConfig(),
        preloadMarginMeters: margins.preloadMarginMeters,
        retainMarginMeters: margins.retainMarginMeters,
        resources,
        pendingQueues: {
          queued: pendingQueued,
          fetching: pendingFetching,
          decoding: pendingDecoding,
          readyToCommit: pendingReadyToCommit,
        },
        counters: {
          transitionsStarted: this.transitionsStartedTotal,
          transitionsCompleted: this.transitionsCompletedTotal,
          transitionsCancelled: this.transitionsCancelledTotal,
          transitionsDeferredBudget: this.transitionsDeferredBudgetTotal,
          cacheHits: this.cacheHitsTotal,
          cacheEvictions: this.cacheEvictionsTotal,
        },
        timings: {
          lastTransitionTotalMs: Number(this.lastTransitionTotalMs.toFixed(3)),
          lastActivationSwapMs: Number(this.lastActivationSwapMs.toFixed(3)),
          maxActivationSwapMs: Number(this.maxActivationSwapMs.toFixed(3)),
          activationSwapMsStats: summarizeTimingSamples(this.activationSwapMsRing),
          transitionDurationMsStats: summarizeTimingSamples(
            this.transitionDurationMsRing
          ),
        },
      };
    }

    return {
      manifestStatus: this.manifestStatus,
      manifestError: this.manifestError,
      activeMosaicName: this.hierarchy
        ? this.hierarchy.hierarchyName
        : deriveActiveMosaicNameFromPackPath(loadedPackPath),
      packPath: loadedPackPath,
      apiBaseUrl: this.apiBaseUrl,
      snapshotId: isLoaded ? this.metadata!.snapshotId : 'uninitialized',
      bakeSchemaVersion: isLoaded ? this.metadata!.bakeSchemaVersion : 'uninitialized',
      tileSizeMeters: isLoaded ? this.metadata!.tileSizeMeters : 512,
      preloadMarginTiles: this.preloadMarginTiles,
      retainMarginTiles: this.retainMarginTiles,
      totalGridCols: isLoaded ? this.metadata!.gridCols : 8,
      totalGridRows: isLoaded ? this.metadata!.gridRows : 8,
      totalGridTiles: activeRecords.size,
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
      tilePreparationVariant: identifyTilePreparationVariant(this.tilePrepOptions),
      workerBvhAdoptedTotal: this.workerBvhAdoptedTotal,
      syncBvhFallbackTotal: this.syncBvhFallbackTotal,
      pendingReadyTileBytes,
      hierarchical: hierarchicalDiag,
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
    this.workerBvhAdoptedTotal = 0;
    this.syncBvhFallbackTotal = 0;
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
    this.transitionsStartedTotal = 0;
    this.transitionsCompletedTotal = 0;
    this.transitionsCancelledTotal = 0;
    this.transitionsDeferredBudgetTotal = 0;
    this.cacheHitsTotal = 0;
    this.cacheEvictionsTotal = 0;
    this.lastTransitionTotalMs = 0;
    this.lastActivationSwapMs = 0;
    this.maxActivationSwapMs = 0;
    this.activationSwapMsRing.length = 0;
    this.transitionDurationMsRing.length = 0;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    for (const record of this.tilesByKey.values()) {
      record.requestGeneration = this.requestGenerationCounter++;
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
    this.levelsByResolution.clear();
    this.hierarchy = null;
    this.activeResolutionMeters = null;
    this.desiredResolutionMeters = null;
    this.pendingResolutionMeters = null;
    this.transitionState = 'idle';
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

    // Worker backpressure check in hierarchical mode
    if (this.hierarchy) {
      let queuedDecodedBytes = 0;
      for (const record of this.tilesByKey.values()) {
        if (record.state === 'ready_to_commit' && record.decodedFootprint) {
          queuedDecodedBytes +=
            record.decodedFootprint.cpuGeometryBytes +
            record.decodedFootprint.bvhBytes;
        }
      }
      this.workerBackpressureActive =
        queuedDecodedBytes >= this.hierarchicalBudget.maxPendingDecodedBytes;
      if (this.workerBackpressureActive) {
        return;
      }
    } else {
      this.workerBackpressureActive = false;
    }

    const availableSlots = this.maxConcurrentFetches - this.activeFetchCount;
    if (availableSlots <= 0) return;

    const queued: ManagedTileRecord[] = [];
    for (const record of this.tilesByKey.values()) {
      if (record.state !== 'queued' || !record.isInFetchSet) continue;
      if (this.hierarchy) {
        const isActiveRes = record.resolutionMeters === this.activeResolutionMeters;
        const isPendingRes =
          record.resolutionMeters === this.pendingResolutionMeters &&
          this.transitionState !== 'deferred_budget';
        if (!isActiveRes && !isPendingRes) continue;
        // Suppress non-visible speculative preload when budget reserve is tight
        if (!record.isVisibleInViewport && this.speculativeBackpressureActive) {
          continue;
        }
      }
      queued.push(record);
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
    const tileSizeMeters = record.resolutionMeters;
    const url = this.hierarchy
      ? `${this.apiBaseUrl}/r/${tileSizeMeters}/${lod}/${tx}/${ty}`
      : `${this.apiBaseUrl}/${lod}/${tx}/${ty}`;
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
        const tCont0 = performance.now();
        const stillValidLevel =
          !this.hierarchy ||
          record.resolutionMeters === this.activeResolutionMeters ||
          (record.resolutionMeters === this.pendingResolutionMeters &&
            this.transitionState !== 'deferred_budget');
        if (
          this.isDisposed ||
          abortController.signal.aborted ||
          record.requestGeneration !== generation ||
          !record.isInKeepSet ||
          !stillValidLevel
        ) {
          return;
        }

        this.totalDecodeMs += decodeResult.decodeDurationMs;
        this.decodeSamples += 1;
        pushBoundedSample(this.decodeMsRing, decodeResult.decodeDurationMs);

        // A regional mosaic reuses immutable shard-local OSMTILE1 payloads.
        // Geometry inside each payload is tile-local; only the decoded center must
        // be relocated to the canonical regional origin supplied by the composed manifest.
        // Identical for legacy packs, where these centers already agree.
        if (
          decodeResult.decoded.lod !== lod ||
          decodeResult.decoded.tx !== tx ||
          decodeResult.decoded.ty !== ty ||
          decodeResult.decoded.tileSizeMeters !== record.resolutionMeters
        ) {
          throw new Error(`Decoded tile identity/size mismatch: ${tileKey}`);
        }
        const positionedPayload: AnyDecodedTilePayload = {
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

        const contDurationMs = Math.max(0, performance.now() - tCont0);
        if (decodeResult.workerTimings) {
          decodeResult.workerTimings.mainPromiseContinuationMs = Number(
            contDurationMs.toFixed(3)
          );
        }

        const profAtDecodeDone =
          this.profiler && this.profiler.enabled ? this.profiler : null;
        if (profAtDecodeDone) {
          profAtDecodeDone.recordWorkerContinuation(contDurationMs);
          const readyNowMs = performance.now();
          const fp = record.decodedFootprint;
          const rawBytes = fp.cpuGeometryBytes + fp.bvhBytes;
          const depths = this.getQueueDepthSnapshot();
          const wt = decodeResult.workerTimings;
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
              usedCompactTransport: wt?.usedCompactTransport,
              workerBvhBuildMs: wt?.workerBvhBuildMs,
              messageDeliveryLatencyMs: wt?.messageDeliveryLatencyMs,
              mainOnMessageHandlerMs: wt?.mainOnMessageHandlerMs,
              mainPromiseContinuationMs: Number(contDurationMs.toFixed(3)),
              transferableBufferCount: wt?.transferableBufferCount,
              transferableBytes: wt?.transferableBytes,
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
        tileSizeMeters: record.resolutionMeters,
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
        tileSizeMeters: record.resolutionMeters,
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
        childGroup.userData.resolutionMeters = record.resolutionMeters;
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

    const activeLevel = this.getActiveLevelState();
    const recordSource = activeLevel ? activeLevel.tilesByKey : this.tilesByKey;
    for (const record of recordSource.values()) {
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
    if (this.activeResolutionMeters !== null) {
      this.groundMesh.userData.__activeResolutionMeters =
        this.activeResolutionMeters;
    }

    // TKT-040 Work Package D: attachTileToCompositeScene already calls
    // childGroup.updateMatrixWorld(true) on newly attached tiles, so avoid
    // re-traversing every already-loaded tile in all 8 composite layer groups.
    if (!this.tilePrepOptions.optimizeMainThreadPrep) {
      for (const layerKind of STREAMED_LAYER_KINDS) {
        const grp = this.compositeScene[`${layerKind}Group` as const];
        grp.updateMatrixWorld(true);
      }
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
      if (record.state === 'fetching' || record.state === 'decoding') {
        return true;
      }
      if (record.state === 'queued' && record.isInFetchSet) {
        if (this.hierarchy) {
          const isActiveRes =
            record.resolutionMeters === this.activeResolutionMeters;
          const isPendingRes =
            record.resolutionMeters === this.pendingResolutionMeters &&
            this.transitionState !== 'deferred_budget';
          if (!isActiveRes && !isPendingRes) continue;
          if (!record.isVisibleInViewport && this.speculativeBackpressureActive) {
            continue;
          }
        }
        return true;
      }
    }
    return false;
  }

  private isCurrentlyIdle(): boolean {
    if (this.hasPendingAsyncWork()) return false;
    for (const record of this.tilesByKey.values()) {
      if (record.state === 'ready_to_commit' && record.isInKeepSet) {
        if (
          this.hierarchy &&
          record.resolutionMeters === this.pendingResolutionMeters &&
          this.transitionState === 'deferred_budget'
        ) {
          continue;
        }
        return false;
      }
    }
    if (
      this.hierarchy &&
      this.pendingResolutionMeters !== null &&
      this.transitionState === 'ready_to_activate'
    ) {
      return false;
    }
    return true;
  }

  private checkIdleWaiters(): void {
    if (this.idleWaiters.length === 0) return;
    const needsTickToDrainBackpressure =
      this.activeFetchCount === 0 && this.workerBackpressureActive;
    if (
      this.isDisposed ||
      !this.hasPendingAsyncWork() ||
      needsTickToDrainBackpressure
    ) {
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
