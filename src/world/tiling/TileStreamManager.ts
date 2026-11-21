import * as THREE from 'three';
import type { MapStyleTheme } from '../../types/MapFeature';
import { MAP_THEMES } from '../../styles/mapThemes';
import {
  SceneResourceManager,
  type BuiltSceneGeometry,
} from '../GeometryBuilder';
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
import { createHengeloStudyGrid, formatTileId } from './TileGrid';

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

export interface TileStreamDiagnosticsSnapshot {
  snapshotId: string;
  bakeSchemaVersion: string;
  tileSizeMeters: number;
  preloadMarginTiles: number;
  retainMarginTiles: number;
  totalGridTiles: number;
  visibleTiles: number;
  fetchTargetTiles: number;
  keepTargetTiles: number;
  loadedTiles: number;
  emptyLoadedTiles: number;
  loadingTiles: number;
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
  lastManifestLoadMs: number;
  avgFetchMs: number;
  avgDecodeMs: number;
  avgReconstructMs: number;
  lastCommitMs: number;
  maxCommitMs: number;
  viewportBounds: TileViewportGroundBounds | null;
  loadedTileKeys: string[];
  visibleTileKeys: string[];
  loadingTileKeys: string[];
}

export interface TilePackManifestPayload {
  metadata: TilePackMetadata;
  tiles: TileManifestEntry[];
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
  /** Optional pre-configured `TileDecodeClient`. */
  decodeClient?: TileDecodeClient;
  /** Optional custom `fetch` implementation for tests. */
  fetchFn?: typeof fetch;
  /** Optional callback fired whenever diagnostics or loaded tiles change. */
  onDiagnosticsChange?: (diagnostics: TileStreamDiagnosticsSnapshot) => void;
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
  private readonly materialRegistry: ThemeMaterialRegistry;
  private readonly ownsMaterialRegistry: boolean;
  private readonly decodeClient: TileDecodeClient;
  private readonly ownsDecodeClient: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly onDiagnosticsChange?: (
    diagnostics: TileStreamDiagnosticsSnapshot
  ) => void;

  private readonly regionalResources = new SceneResourceManager();
  private readonly compositeScene: BuiltSceneGeometry;
  private readonly boundaryOverlayResult: M1aTileBoundaryOverlayResult;
  private readonly groundMesh: THREE.Mesh;
  private readonly tilesByKey = new Map<string, ManagedTileRecord>();

  private metadata: TilePackMetadata | null = null;
  private currentTheme: MapStyleTheme;
  private currentCameraZoom: number;
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
  private lastManifestLoadMs = 0;
  private totalFetchMs = 0;
  private fetchSamples = 0;
  private totalDecodeMs = 0;
  private decodeSamples = 0;
  private totalReconstructMs = 0;
  private reconstructSamples = 0;
  private lastCommitMs = 0;
  private maxCommitMs = 0;

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
    this.currentTheme = options.initialTheme ?? MAP_THEMES.tactical;
    this.currentCameraZoom = options.initialCameraZoom ?? 1.0;

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

  get packMetadata(): TilePackMetadata | null {
    return this.metadata;
  }

  setBoundaryOverlayVisible(visible: boolean): void {
    this.boundaryOverlayResult.group.visible = visible;
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
    let payload: TilePackManifestPayload;

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

    this.lastManifestLoadMs = performance.now() - t0;
    this.metadata = payload.metadata;
    this.tilesByKey.clear();

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
      });
    }

    this.emitDiagnostics();
    return payload.metadata;
  }

  /**
   * Updates the active viewport from an OrthographicCamera and pumps fetch/commit queues.
   */
  updateFromCamera(
    camera: THREE.OrthographicCamera,
    target?: { x: number; y?: number; z: number }
  ): void {
    if (this.isDisposed || !this.metadata) return;
    const bounds = computeViewportGroundBoundsForCamera(camera, target);
    if (bounds.cameraZoom !== undefined) {
      this.updateCameraZoom(bounds.cameraZoom);
    }
    this.updateViewport(bounds);
    this.tick();
  }

  /**
   * Re-evaluates visible, preload (`fetchSet`), and retention (`keepSet`) tiles
   * for the given ground-plane viewport bounds, cancels obsolete in-flight fetches,
   * evicts distant loaded tiles, and schedules high-priority tile loads.
   */
  updateViewport(viewport: TileViewportGroundBounds): void {
    if (this.isDisposed || !this.metadata) return;
    this.currentViewport = viewport;

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
          this.cancelInFlightTile(record);
          anyEvictedOrCancelled = true;
        } else if (record.state === 'loaded') {
          this.evictLoadedTile(record);
          anyEvictedOrCancelled = true;
        }
      } else if (!isInFetch && record.state === 'queued') {
        // Tile drifted from fetchSet into hysteresis keep-only band before fetch even started
        this.cancelInFlightTile(record);
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

    this.pumpFetchQueue();
    if (anyEvictedOrCancelled) {
      this.rebuildCompositeStats();
      this.emitDiagnostics();
    }
    this.checkIdleWaiters();
  }

  /**
   * Commits up to `maxCommits` decoded tiles (`ready_to_commit`) into the Three.js
   * composite scene graph on the main thread.
   */
  tick(maxCommits = this.maxCommitsPerFrame): number {
    if (this.isDisposed) return 0;
    this.pumpFetchQueue();

    const readyRecords: ManagedTileRecord[] = [];
    for (const record of this.tilesByKey.values()) {
      if (record.state === 'ready_to_commit' && record.isInKeepSet) {
        readyRecords.push(record);
      }
    }

    if (readyRecords.length === 0) {
      this.checkIdleWaiters();
      return 0;
    }

    readyRecords.sort((a, b) => a.priorityScore - b.priorityScore);
    const limit = Math.min(maxCommits, readyRecords.length);
    let committed = 0;

    for (let i = 0; i < limit; i++) {
      const record = readyRecords[i];
      if (!record.decodedPayload) continue;

      const t0 = performance.now();
      const reconstructed = reconstructTileSceneFromDecoded(
        record.decodedPayload,
        {
          materialRegistry: this.materialRegistry,
          placementMode: 'study-world-mesh-offset',
          initialCameraZoom: this.currentCameraZoom,
        }
      );
      const reconstructMs = performance.now() - t0;

      this.totalReconstructMs += reconstructMs;
      this.reconstructSamples += 1;
      this.lastCommitMs = reconstructMs;
      this.maxCommitMs = Math.max(this.maxCommitMs, reconstructMs);

      record.reconstructed = reconstructed;
      record.decodedPayload = null;
      record.state = 'loaded';
      this.completedLoadsTotal += 1;
      this.attachTileToCompositeScene(record);
      committed += 1;
    }

    if (committed > 0) {
      if (this.currentWireframe) {
        this.materialRegistry.setWireframe(true);
      }
      this.rebuildCompositeStats();
      this.emitDiagnostics();
    }

    this.checkIdleWaiters();
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
    this.currentCameraZoom = zoom;
    this.materialRegistry.setCameraZoom(zoom);
    for (const record of this.tilesByKey.values()) {
      if (record.state === 'loaded' && record.reconstructed) {
        record.reconstructed.scene.updateCameraZoom?.(zoom);
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
            record.reconstructed.scene.resources.getStats().geometries;
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

    return {
      snapshotId: this.metadata?.snapshotId ?? 'uninitialized',
      bakeSchemaVersion: this.metadata?.bakeSchemaVersion ?? 'uninitialized',
      tileSizeMeters: this.metadata?.tileSizeMeters ?? 512,
      preloadMarginTiles: this.preloadMarginTiles,
      retainMarginTiles: this.retainMarginTiles,
      totalGridTiles: this.tilesByKey.size,
      visibleTiles,
      fetchTargetTiles,
      keepTargetTiles,
      loadedTiles,
      emptyLoadedTiles,
      loadingTiles,
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
      viewportBounds: this.currentViewport,
      loadedTileKeys,
      visibleTileKeys,
      loadingTileKeys,
    };
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
    const url = `${this.apiBaseUrl}/${lod}/${tx}/${ty}`;
    const fetchStart = performance.now();

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
        const fetchMs = performance.now() - fetchStart;
        this.totalFetchMs += fetchMs;
        this.fetchSamples += 1;

        record.state = 'decoding';
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

        record.decodedPayload = decodeResult.decoded;
        record.decodedFootprint = computeDecodedTileMemoryFootprint(
          decodeResult.decoded
        );
        record.abortController = null;
        record.state = 'ready_to_commit';
      } catch (err) {
        if (
          abortController.signal.aborted ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          return;
        }
        if (record.requestGeneration === generation) {
          record.state = 'error';
          record.lastError =
            err instanceof Error ? err.message : String(err);
          record.abortController = null;
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
    record.requestGeneration = this.requestGenerationCounter++;
    if (record.abortController) {
      record.abortController.abort();
      record.abortController = null;
    }
    record.decodedPayload = null;
    record.decodedFootprint = null;
    record.state = 'unloaded';
    this.cancelledRequestsTotal += 1;
  }

  private evictLoadedTile(record: ManagedTileRecord): void {
    if (!record.reconstructed) {
      record.state = 'unloaded';
      return;
    }
    this.detachTileFromCompositeScene(record);
    record.reconstructed.dispose();
    record.reconstructed = null;
    record.decodedPayload = null;
    record.decodedFootprint = null;
    record.state = 'unloaded';
    this.evictedTilesTotal += 1;
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

    for (const layerKind of STREAMED_LAYER_KINDS) {
      const grp = this.compositeScene[`${layerKind}Group` as const];
      grp.updateMatrixWorld(true);
    }
  }

  private isCurrentlyIdle(): boolean {
    if (this.activeFetchCount > 0) return false;
    for (const record of this.tilesByKey.values()) {
      if (
        record.state === 'queued' ||
        record.state === 'fetching' ||
        record.state === 'decoding' ||
        (record.state === 'ready_to_commit' && record.isInKeepSet)
      ) {
        return false;
      }
    }
    return true;
  }

  private checkIdleWaiters(): void {
    if (this.idleWaiters.length === 0) return;
    if (this.isDisposed || this.isCurrentlyIdle()) {
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
