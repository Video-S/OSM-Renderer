import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { Info, MousePointerClick, PanelLeft, X } from 'lucide-react';
import { LocalGeoJsonProvider } from '../world/LocalGeoJsonProvider';
import { OsmApiProvider } from '../world/OsmApiProvider';
import {
  GeometryBuilder,
  BuiltSceneGeometry,
  DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS,
  normalizeInfrastructureRenderOptions,
  parseInfrastructureRenderOptionsFromSearch,
  prepareInfrastructureRenderPreview,
  requiresInfrastructureGraphPreview,
  type InfrastructureRenderOptions,
} from '../world/GeometryBuilder';
import {
  DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG,
  normalizeFoliageOptimizationConfig,
  parseFoliageOptimizationConfigFromSearch,
  type FoliageOptimizationConfig,
} from '../world/FoliageLodSystem';
import {
  ProcessedMapData,
  MapStyleTheme,
  InspectableFeatureInfo,
} from '../types/MapFeature';
import { MAP_THEMES } from '../styles/mapThemes';
import { MapScene } from '../scene/MapScene';
import { Fallback2DMap } from '../scene/Fallback2DMap';
import { CameraController } from '../scene/CameraController';
import { DeveloperReproductionPackage } from '../world/dev/ReproductionReport';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { detectWebGLSupport } from '../utils/webglCheck';
import {
  createRailwayPrototypeFixtureData,
  RAILWAY_PROTOTYPE_ZONE_PRESETS,
  RailwayPrototypeZoneId,
} from '../world/prototype/RailwayTestFixtures';
import prinsHendrikkadeForkFixture from '../world/prototype/PrinsHendrikkadeForkFixture.json';
import {
  computeGroupGeometryStats,
  LiveWebGLTelemetrySnapshot,
} from '../world/prototype/PerformanceBaselineHarness';
import {
  type BenchmarkHarnessSnapshot,
  type ExpectedSceneReadinessSpec,
  type SceneRevisionConfigMeta,
  validateSceneReadinessSnapshot,
} from '../types/BenchmarkTelemetry';
import {
  type MapLoadDiagnosticsRecord,
  type MapLoadSourceType,
  MapLoadTimelineTracker,
} from '../world/dev/MapLoadDiagnostics';
import {
  createAlignedStudyGrid,
  createHengeloStudyGrid,
} from '../world/tiling/TileGrid';
import {
  buildSingleSceneReference,
  buildTiledStudyScenes,
  ingestCanonicalStudyGeoJson,
  type IngestedStudyRegion,
} from '../world/tiling/TiledStudyPipeline';
import {
  assembleTiledStudyCompositeScene,
  createM1aTileBoundaryOverlay,
  type M1aTileBoundaryOverlayResult,
  type M1aVisualComparisonMode,
} from '../world/tiling/M1aVisualHarness';
import {
  TileStreamManager,
  INACTIVE_MOSAIC_IDENTITY,
  createLoadingMosaicIdentity,
  createErrorMosaicIdentity,
  createMosaicIdentityFromDiagnostics,
  type ActiveMosaicIdentity,
  type TileManifestCoverageSummary,
  type TileStreamDiagnosticsSnapshot,
} from '../world/tiling/TileStreamManager';
import {
  REGIONAL_MIN_ZOOM_TILE_THRESHOLD,
  clampCameraZoom,
  parseRegionalMinZoomFromSearch,
  resolveCameraZoomPolicy,
} from '../scene/cameraZoomPolicy';
import { utm32NToGeo } from '../world/tiling/RegionalProjection';
import { NavigationSidebar } from '../components/workspace/NavigationSidebar';
import { ContextSidebar } from '../components/workspace/ContextSidebar';
import { CameraToolbar } from '../components/workspace/CameraToolbar';
import { SearchPanel } from '../components/workspace/panels/SearchPanel';
import { LayersPanel } from '../components/workspace/panels/LayersPanel';
import { AppearancePanel } from '../components/workspace/panels/AppearancePanel';
import { InspectorPanel } from '../components/workspace/panels/InspectorPanel';
import { PerformancePanel } from '../components/workspace/panels/PerformancePanel';
import { DiagnosticsPanel } from '../components/workspace/panels/DiagnosticsPanel';
import { WorldPanel } from '../components/workspace/panels/WorldPanel';
import {
  INITIAL_REPRO_FORM_STATE,
  INITIAL_SEARCH_SESSION_STATE,
  loadWorkspacePreferences,
  mapLegacyTabToPanelId,
  saveWorkspacePreferences,
  togglePanelSelection,
  type NavSidebarMode,
  type ReproFormSessionState,
  type SearchPanelSessionState,
  type WorkspacePanelId,
  type WorkspacePreferences,
} from '../components/workspace/workspaceTypes';

const CAMERA_TARGET: [number, number, number] = [0, 0, 0];

const DEFAULT_REGIONAL_MOSAIC_OPTIONS = {
  apiBaseUrl: '/api/tiles-region',
  preloadMarginTiles: 0.5,
  retainMarginTiles: 1,
} as const;

export default function App() {
  const urlSearchParams = useMemo(
    () =>
      typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search)
        : new URLSearchParams(),
    []
  );

  const isBenchmarkMode = useMemo(() => {
    const fixtureParam = urlSearchParams.get('fixture');
    const benchParam = urlSearchParams.get('benchmark');
    return benchParam === '1' || benchParam === 'true' || fixtureParam === 'benchmark';
  }, [urlSearchParams]);

  const initialWorkspaceState = useMemo<WorkspacePreferences>(() => {
    const stored = loadWorkspacePreferences();
    if (isBenchmarkMode) {
      return {
        navMode: 'hidden',
        activePanel: null,
        hideCameraToolbar: true,
      };
    }

    let navMode = stored.navMode;
    let activePanel = stored.activePanel;
    const hideCameraToolbar = stored.hideCameraToolbar;

    if (urlSearchParams.get('dock') === 'collapsed') {
      navMode = 'hidden';
      activePanel = null;
    }

    const tabParam = urlSearchParams.get('tab');
    if (
      tabParam === 'layers' ||
      tabParam === 'inspector' ||
      tabParam === 'style' ||
      tabParam === 'stats' ||
      tabParam === 'info'
    ) {
      activePanel = mapLegacyTabToPanelId(tabParam);
    } else if (
      urlSearchParams.get('devtools') === 'true' ||
      urlSearchParams.get('devtools') === '1'
    ) {
      activePanel = 'diagnostics';
    }

    return { navMode, activePanel, hideCameraToolbar };
  }, [isBenchmarkMode, urlSearchParams]);

  const [navMode, setNavMode] = useState<NavSidebarMode>(initialWorkspaceState.navMode);
  const [activePanel, setActivePanel] = useState<WorkspacePanelId | null>(
    initialWorkspaceState.activePanel
  );
  const [hideCameraToolbar, setHideCameraToolbar] = useState<boolean>(
    initialWorkspaceState.hideCameraToolbar
  );

  const persistWorkspacePrefs = (next: WorkspacePreferences) => {
    saveWorkspacePreferences(next);
  };

  const handleSelectPanel = (panelId: WorkspacePanelId | null) => {
    const nextPanel =
      panelId === null ? null : togglePanelSelection(activePanel, panelId);
    setActivePanel(nextPanel);
    persistWorkspacePrefs({
      navMode,
      activePanel: nextPanel,
      hideCameraToolbar,
    });
  };

  const handleChangeNavMode = (nextMode: NavSidebarMode) => {
    setNavMode(nextMode);
    persistWorkspacePrefs({
      navMode: nextMode,
      activePanel,
      hideCameraToolbar,
    });
  };

  const handleToggleCameraToolbar = () => {
    const nextHide = !hideCameraToolbar;
    setHideCameraToolbar(nextHide);
    persistWorkspacePrefs({
      navMode,
      activePanel,
      hideCameraToolbar: nextHide,
    });
  };

  const handleEnterImmersiveMode = () => {
    setNavMode('hidden');
    setActivePanel(null);
    setHideCameraToolbar(true);
    persistWorkspacePrefs({
      navMode: 'hidden',
      activePanel: null,
      hideCameraToolbar: true,
    });
  };

  const handleRestoreWorkspaceUi = () => {
    setNavMode('expanded');
    setHideCameraToolbar(false);
    persistWorkspacePrefs({
      navMode: 'expanded',
      activePanel,
      hideCameraToolbar: false,
    });
  };

  // Lifted panel session state so inputs/results survive switching or closing panels
  const [searchSession, setSearchSession] = useState<SearchPanelSessionState>(
    INITIAL_SEARCH_SESSION_STATE
  );
  const [reproForm, setReproForm] = useState<ReproFormSessionState>(
    INITIAL_REPRO_FORM_STATE
  );

  // Map data state
  const [mapData, setMapData] = useState<ProcessedMapData | null>(null);
  const [activeLocationId, setActiveLocationId] = useState<string>('hengelo_m2a_tiles');
  const [loading, setLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState(
    'Initializing baked regional mosaic (/api/tiles-region/manifest)...'
  );
  const [error, setError] = useState<string | null>(null);
  const [currentRawGeoJson, setCurrentRawGeoJson] = useState<any>(null);

  // Styling & configuration
  const [selectedThemeId, setSelectedThemeId] = useState<string>('tactical');
  const [heightMultiplier, setHeightMultiplier] = useState<number>(1.0);
  const [roadWidthMultiplier, setRoadWidthMultiplier] = useState<number>(1.0);
  const [bevelEnabled, setBevelEnabled] = useState<boolean>(true);
  const [wireframe, setWireframe] = useState<boolean>(false);

  const [activePrototypeZone, setActivePrototypeZone] =
    useState<RailwayPrototypeZoneId>('overview');
  const currentCameraZoomRef = useRef<number>(1.2);
  const [cameraOrientation, setCameraOrientation] = useState<{
    zoom: number;
    azimuthDeg: number;
  }>({ zoom: 1.2, azimuthDeg: 45 });
  const latestTelemetryRef = useRef<LiveWebGLTelemetrySnapshot | null>(null);

  // Permanent production infrastructure configuration (E2+ surface-first roads + E3-B R+ railways)
  const [infrastructureRenderOptions, setInfrastructureRenderOptions] =
    useState<InfrastructureRenderOptions>(() =>
      typeof window !== 'undefined'
        ? parseInfrastructureRenderOptionsFromSearch(window.location.search)
        : { ...DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS }
    );

  // TKT-036: Runtime foliage LOD, trunk suppression, and conservative frustum culling config
  const [foliageConfig, setFoliageConfig] = useState<FoliageOptimizationConfig>(() =>
    typeof window !== 'undefined'
      ? parseFoliageOptimizationConfigFromSearch(window.location.search)
      : { ...DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG }
  );
  const foliageConfigRef = useRef<FoliageOptimizationConfig>(foliageConfig);
  foliageConfigRef.current = foliageConfig;

  // TKT-017: Deterministic scene revision tracking & live refs for race-free benchmark snapshots
  const transitionRevisionRef = useRef<number>(0);
  const pendingTransitionMetaRef = useRef<Omit<
    SceneRevisionConfigMeta,
    'webglFramesRendered'
  > | null>(null);
  const latestRenderedMetaRef = useRef<SceneRevisionConfigMeta | null>(null);
  const imperativePoseSetterRef = useRef<
    ((target: [number, number, number], zoom: number, azimuthDeg?: number) => void) | null
  >(null);
  const readinessWaitersRef = useRef<
    Array<{
      targetRevision: number;
      expected: ExpectedSceneReadinessSpec;
      resolve: () => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>
  >([]);
  const activeLocationIdRef = useRef<string>(activeLocationId);
  const mapDataRef = useRef<ProcessedMapData | null>(mapData);
  const infrastructureRenderOptionsRef = useRef<InfrastructureRenderOptions>(
    infrastructureRenderOptions
  );
  const selectedThemeIdRef = useRef<string>(selectedThemeId);
  const activePrototypeZoneRef = useRef<RailwayPrototypeZoneId>(activePrototypeZone);
  const infrastructureRenderPreviewRef = useRef<any>(null);

  activeLocationIdRef.current = activeLocationId;
  mapDataRef.current = mapData;
  infrastructureRenderOptionsRef.current = infrastructureRenderOptions;
  selectedThemeIdRef.current = selectedThemeId;
  activePrototypeZoneRef.current = activePrototypeZone;

  // Layer visibility toggles
  const [showBuildings, setShowBuildings] = useState<boolean>(true);
  const [showRoads, setShowRoads] = useState<boolean>(true);
  const [showRailways, setShowRailways] = useState<boolean>(true);
  const [showWater, setShowWater] = useState<boolean>(true);
  const [showParks, setShowParks] = useState<boolean>(true);
  const [showLanduse, setShowLanduse] = useState<boolean>(true);
  const [showBarriers, setShowBarriers] = useState<boolean>(true);
  const [showFoliage, setShowFoliage] = useState<boolean>(true);

  // Camera & Navigation Signals
  const [resetCount, setResetCount] = useState<number>(0);
  const [frameRegionCount, setFrameRegionCount] = useState<number>(0);
  const [rotateStepCount, setRotateStepCount] = useState<number>(0);
  const [zoomStepCount, setZoomStepCount] = useState<number>(0);
  const [explicitPose, setExplicitPose] = useState<{
    target: [number, number, number];
    zoom: number;
    azimuthRad?: number;
    signal: number;
    animate?: boolean;
  }>({
    target: [0, 0, 0],
    zoom: 1.2,
    signal: 0,
  });

  // Universal OSM Feature Hover Tooltip & Click Inspector
  const [hoveredFeature, setHoveredFeature] = useState<InspectableFeatureInfo | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [selectedFeature, setSelectedFeature] = useState<InspectableFeatureInfo | null>(null);
  const [selectedFeatures, setSelectedFeatures] = useState<InspectableFeatureInfo[]>([]);
  const [focusedFeatureId, setFocusedFeatureId] = useState<string | null>(null);

  // Spatial selection & overlay state
  const [showGraphOverlay, setShowGraphOverlay] = useState<boolean>(false);
  const [isSpatialSelectActive, setIsSpatialSelectActive] = useState<boolean>(false);
  const [selectedBoxMeters, setSelectedBoxMeters] = useState<{
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  } | null>(null);

  // Performance stats & M2.1 telemetry
  const [fps, setFps] = useState<number>(60);
  const [cpuBuildTimeMs, setCpuBuildTimeMs] = useState<number>(0);
  const latestCpuBuildTimeMsRef = useRef<number>(0);
  const latestPreviewTimeMsRef = useRef<number>(0);
  const [liveTelemetry, setLiveTelemetry] = useState<LiveWebGLTelemetrySnapshot | null>(null);
  const lastUiTelemetryTimeRef = useRef<number>(0);
  const [webglSupported, setWebglSupported] = useState<boolean>(
    () => detectWebGLSupport().supported
  );

  // Internal provider instances (for test/benchmark fixtures & repro import only)
  const osmApiProvider = useMemo(() => new OsmApiProvider(), []);
  const localProvider = useMemo(() => new LocalGeoJsonProvider(), []);

  // TKT-021: End-to-end map loading diagnostics
  const mapLoadTrackerRef = useRef<MapLoadTimelineTracker>(new MapLoadTimelineTracker(10));
  const mapDataRequestIdRef = useRef<WeakMap<ProcessedMapData, number>>(new WeakMap());
  const initialMountLoadStartedRef = useRef<boolean>(false);
  const [lastMapLoadDiagnostics, setLastMapLoadDiagnostics] =
    useState<MapLoadDiagnosticsRecord | null>(null);

  const commitMapDataForRequest = (requestId: number, data: ProcessedMapData) => {
    mapDataRequestIdRef.current.set(data, requestId);
    mapLoadTrackerRef.current.markMapDataCommitted(requestId, {
      buildings: data.stats?.totalBuildings ?? data.buildings?.length ?? 0,
      roads: data.stats?.totalRoads ?? data.roads?.length ?? 0,
      railways: data.stats?.totalRailways ?? data.railways?.length ?? 0,
      totalFeaturesParsed: data.diagnostics?.totalFeaturesParsed ?? 0,
    });
    if (
      activeLocationIdRef.current !== 'hengelo_m1a' &&
      activeLocationIdRef.current !== 'hengelo_m1a_tiled' &&
      activeLocationIdRef.current !== 'hengelo_m1a_reference'
    ) {
      isM1aHarnessActiveRef.current = false;
      setIsM1aHarnessActive(false);
      disposeM1aHarnessScenes();
    }
    if (activeLocationIdRef.current !== 'hengelo_m2a_tiles') {
      clearM2aStreamingOnDatasetSwitch();
    }
    setMapData(data);
  };

  // Built scene geometry reference for cleanup and in-place material updates
  const [builtGeometry, setBuiltGeometry] = useState<BuiltSceneGeometry | null>(null);
  const activeSceneRef = useRef<BuiltSceneGeometry | null>(null);

  // TKT-028 M1a Developer-Only Visual Acceptance Harness State
  const [isM1aHarnessActive, setIsM1aHarnessActive] = useState<boolean>(false);
  const [m1aViewMode, setM1aViewMode] = useState<M1aVisualComparisonMode>('tiled');
  const [showM1aTileBoundaries, setShowM1aTileBoundaries] = useState<boolean>(true);
  const [m1aHarnessMetrics, setM1aHarnessMetrics] = useState<{
    tileCount: number;
    gridCols: number;
    gridRows: number;
    tileSizeMeters: number;
    internalSeamCount: number;
    featureCount: number;
    tiledBuildTimeMs: number;
    referenceBuildTimeMs: number;
    tiledTriangles: number;
    referenceTriangles: number;
    tiledDrawCalls: number;
    referenceDrawCalls: number;
  } | null>(null);
  const m1aIngestedRef = useRef<IngestedStudyRegion | null>(null);
  const m1aTiledSceneRef = useRef<BuiltSceneGeometry | null>(null);
  const m1aReferenceSceneRef = useRef<BuiltSceneGeometry | null>(null);
  const m1aBoundaryOverlayRef = useRef<M1aTileBoundaryOverlayResult | null>(null);

  // TKT-028 M2-A Runtime Baked Tile Streaming State
  const [isM2aStreamingActive, setIsM2aStreamingActive] = useState<boolean>(false);
  const [showM2aTileBoundaries, setShowM2aTileBoundaries] = useState<boolean>(false);
  const [m2aStreamDiagnostics, setM2aStreamDiagnostics] =
    useState<TileStreamDiagnosticsSnapshot | null>(null);
  const [manifestCoverage, setManifestCoverage] =
    useState<TileManifestCoverageSummary | null>(null);
  const [activeMosaicIdentity, setActiveMosaicIdentity] = useState<ActiveMosaicIdentity>(
    INACTIVE_MOSAIC_IDENTITY
  );
  const activeMosaicIdentityRef = useRef<ActiveMosaicIdentity>(INACTIVE_MOSAIC_IDENTITY);
  activeMosaicIdentityRef.current = activeMosaicIdentity;

  const urlRegionalMinZoomOverride = useMemo(
    () =>
      typeof window !== 'undefined'
        ? parseRegionalMinZoomFromSearch(window.location.search)
        : null,
    []
  );
  const [programmaticRegionalMinZoom, setProgrammaticRegionalMinZoom] = useState<number | null>(
    null
  );

  const isRegionalZoomContext =
    (isM2aStreamingActive &&
      (activeMosaicIdentity.isRegionalStreaming ||
        (m2aStreamDiagnostics?.totalGridTiles ?? 0) > REGIONAL_MIN_ZOOM_TILE_THRESHOLD)) ||
    (activeMosaicIdentity.status !== 'inactive' && activeMosaicIdentity.isRegionalStreaming);

  const cameraZoomPolicy = useMemo(
    () =>
      resolveCameraZoomPolicy({
        isRegionalStreaming: isRegionalZoomContext,
        urlOverride: urlRegionalMinZoomOverride,
        programmaticOverride: programmaticRegionalMinZoom,
      }),
    [isRegionalZoomContext, urlRegionalMinZoomOverride, programmaticRegionalMinZoom]
  );
  const cameraZoomPolicyRef = useRef(cameraZoomPolicy);
  cameraZoomPolicyRef.current = cameraZoomPolicy;

  const tileStreamManagerRef = useRef<TileStreamManager | null>(null);
  const lastM2aDiagUiTimeRef = useRef<number>(0);
  const m2aLoadTokenRef = useRef<number>(0);
  const isM1aHarnessActiveRef = useRef<boolean>(false);
  const isM2aStreamingActiveRef = useRef<boolean>(false);

  const disposeM1aHarnessScenes = () => {
    if (m1aTiledSceneRef.current) {
      if (activeSceneRef.current === m1aTiledSceneRef.current) {
        activeSceneRef.current = null;
      }
      m1aTiledSceneRef.current.dispose();
      m1aTiledSceneRef.current = null;
    }
    if (m1aReferenceSceneRef.current) {
      if (activeSceneRef.current === m1aReferenceSceneRef.current) {
        activeSceneRef.current = null;
      }
      m1aReferenceSceneRef.current.dispose();
      m1aReferenceSceneRef.current = null;
    }
    if (m1aBoundaryOverlayRef.current) {
      m1aBoundaryOverlayRef.current.dispose();
      m1aBoundaryOverlayRef.current = null;
    }
    m1aIngestedRef.current = null;
    setM1aHarnessMetrics(null);
  };

  const disposeM2aStreamManager = (resetIdentity: boolean = true) => {
    if (tileStreamManagerRef.current) {
      if (activeSceneRef.current === tileStreamManagerRef.current.scene) {
        activeSceneRef.current = null;
      }
      tileStreamManagerRef.current.dispose();
      tileStreamManagerRef.current = null;
    }
    setM2aStreamDiagnostics(null);
    setManifestCoverage(null);
    if (resetIdentity) {
      setActiveMosaicIdentity(INACTIVE_MOSAIC_IDENTITY);
      setProgrammaticRegionalMinZoom(null);
    }
  };

  const clearM2aStreamingOnDatasetSwitch = () => {
    m2aLoadTokenRef.current += 1;
    isM2aStreamingActiveRef.current = false;
    setIsM2aStreamingActive(false);
    disposeM2aStreamManager(true);
  };

  const switchM1aVisualMode = (nextMode: M1aVisualComparisonMode): number | null => {
    setM1aViewMode(nextMode);
    const targetScene =
      nextMode === 'tiled' ? m1aTiledSceneRef.current : m1aReferenceSceneRef.current;
    if (!targetScene) return null;

    const activeTheme = MAP_THEMES[selectedThemeIdRef.current] || MAP_THEMES.tactical;
    targetScene.updateTheme(activeTheme);
    targetScene.updateCameraZoom?.(currentCameraZoomRef.current);

    const revision = ++transitionRevisionRef.current;
    const datasetId = nextMode === 'tiled' ? 'hengelo_m1a_tiled' : 'hengelo_m1a_reference';
    activeLocationIdRef.current = datasetId;
    setActiveLocationId(datasetId);
    const sceneMeta: SceneRevisionConfigMeta = {
      revision,
      datasetId,
      roadsMode: infrastructureRenderOptionsRef.current.roads,
      railwaysMode: infrastructureRenderOptionsRef.current.railways,
      railwayPrototypeMode: 'production',
      themeId: selectedThemeIdRef.current,
      hasFeatures: true,
      webglFramesRendered: 0,
    };
    targetScene.groundMesh.userData.__sceneMeta = sceneMeta;
    activeSceneRef.current = targetScene;
    setBuiltGeometry(targetScene);
    return revision;
  };

  const loadHengeloM1aVisualHarness = async (
    initialMode: M1aVisualComparisonMode = 'tiled',
    overrideZoom?: number,
    overrideAzimuthDeg?: number,
    isInitialStartupLoad: boolean = false,
    extraOptions?: {
      osmDataUrl?: string;
      gridCols?: number;
      gridRows?: number;
      tileSizeMeters?: number;
      centerLonLat?: [number, number];
      themeId?: string;
      target?: [number, number, number];
    }
  ) => {
    const requestedTileSizeMeters = extraOptions?.tileSizeMeters ?? 512;
    const grid =
      typeof extraOptions?.gridCols === 'number' || typeof extraOptions?.gridRows === 'number'
        ? createAlignedStudyGrid({
            name: 'study-m1a-custom',
            centerLonLat: extraOptions?.centerLonLat ?? [6.7935, 52.2625],
            cols: extraOptions?.gridCols ?? 8,
            rows: extraOptions?.gridRows ?? 8,
            tileSizeMeters: requestedTileSizeMeters,
            collarMeters: 64,
          })
        : createHengeloStudyGrid(requestedTileSizeMeters, 64);

    const requestId = mapLoadTrackerRef.current.startLoad({
      locationId: 'hengelo_m1a',
      locationName: `Hengelo M1a Regional Tiling Study (${grid.cols}×${grid.rows} · ${grid.tiles.length} Tiles · ${grid.tileSizeMeters} m)`,
      radiusMeters: 2048,
      sourceType: 'fixture',
      isInitialStartupLoad,
      rendererConfig: {
        roadsMode: infrastructureRenderOptionsRef.current.roads,
        railwaysMode: infrastructureRenderOptionsRef.current.railways,
        railwayPrototypeMode: 'production',
        themeId: extraOptions?.themeId ?? selectedThemeIdRef.current,
      },
    });

    setLoading(true);
    setError(null);
    setHoveredFeature(null);
    setSelectedFeature(null);
    activeLocationIdRef.current = 'hengelo_m1a';
    setActiveLocationId('hengelo_m1a');
    clearM2aStreamingOnDatasetSwitch();
    setStatusMessage(
      'Fetching canonical Hengelo M1a 4×4 km study GeoJSON from local Overijssel SQLite store...'
    );

    try {
      if (extraOptions?.themeId && MAP_THEMES[extraOptions.themeId]) {
        selectedThemeIdRef.current = extraOptions.themeId;
        setSelectedThemeId(extraOptions.themeId);
      }

      const tFetch0 = performance.now();
      const res = await fetch(extraOptions?.osmDataUrl ?? '/api/osm-data?preset=hengelo-m1a');
      if (!res.ok) {
        let errText = `HTTP ${res.status}`;
        try {
          const errJson = await res.json();
          if (errJson?.error) errText = errJson.error;
        } catch {
          // ignore
        }
        throw new Error(errText);
      }
      const rawGeoJson = await res.json();
      const fetchElapsedMs = performance.now() - tFetch0;

      setStatusMessage(
        `Synthesizing canonical M1a single-scene reference & ${grid.tiles.length}-tile (${grid.cols}×${grid.rows} · ${grid.tileSizeMeters} m) geometry...`
      );
      await new Promise<void>((r) => setTimeout(r, 25));

      disposeM1aHarnessScenes();
      if (activeSceneRef.current) {
        activeSceneRef.current.dispose();
        activeSceneRef.current = null;
      }

      const tIngest0 = performance.now();
      const ingested = ingestCanonicalStudyGeoJson(rawGeoJson, grid);
      const ingestElapsedMs = performance.now() - tIngest0;

      mapLoadTrackerRef.current.recordLocalTransferAndParse(requestId, {
        responseTransferMs: fetchElapsedMs,
        geoJsonProcessingMs: ingestElapsedMs,
        featureCount: Array.isArray(rawGeoJson?.features) ? rawGeoJson.features.length : null,
      });

      const activeTheme =
        MAP_THEMES[extraOptions?.themeId ?? selectedThemeIdRef.current] || MAP_THEMES.tactical;

      const tRef0 = performance.now();
      const referenceBuild = buildSingleSceneReference(ingested, activeTheme, {
        initialCameraZoom: overrideZoom ?? currentCameraZoomRef.current,
      });
      const referenceScene = referenceBuild.scene;
      const referenceBuildTimeMs = Number((performance.now() - tRef0).toFixed(1));

      const tTiled0 = performance.now();
      const tiledBuild = buildTiledStudyScenes(ingested, activeTheme, {
        initialCameraZoom: overrideZoom ?? currentCameraZoomRef.current,
      });
      const compositeTiledScene = assembleTiledStudyCompositeScene(
        tiledBuild,
        ingested,
        activeTheme
      );
      const tiledBuildTimeMs = Number((performance.now() - tTiled0).toFixed(1));

      const boundaryOverlay = createM1aTileBoundaryOverlay(grid);

      m1aIngestedRef.current = ingested;
      m1aReferenceSceneRef.current = referenceScene;
      m1aTiledSceneRef.current = compositeTiledScene;
      m1aBoundaryOverlayRef.current = boundaryOverlay;

      const metricsPayload = {
        tileCount: tiledBuild.tiles.length,
        gridCols: grid.cols,
        gridRows: grid.rows,
        tileSizeMeters: grid.tileSizeMeters,
        internalSeamCount: boundaryOverlay.internalSeamCount,
        featureCount: Array.isArray(rawGeoJson?.features) ? rawGeoJson.features.length : 0,
        tiledBuildTimeMs,
        referenceBuildTimeMs,
        tiledTriangles: compositeTiledScene.stats.totalTriangles,
        referenceTriangles: referenceScene.stats.totalTriangles,
        tiledDrawCalls: compositeTiledScene.stats.totalDrawCalls,
        referenceDrawCalls: referenceScene.stats.totalDrawCalls,
      };
      setM1aHarnessMetrics(metricsPayload);

      isM1aHarnessActiveRef.current = true;
      setIsM1aHarnessActive(true);
      setM1aViewMode(initialMode);
      setCurrentRawGeoJson(rawGeoJson);

      const targetScene =
        initialMode === 'tiled' ? compositeTiledScene : referenceScene;
      const revision = ++transitionRevisionRef.current;
      const initialDatasetId =
        initialMode === 'tiled' ? 'hengelo_m1a_tiled' : 'hengelo_m1a_reference';
      activeLocationIdRef.current = initialDatasetId;
      setActiveLocationId(initialDatasetId);
      const sceneMeta: SceneRevisionConfigMeta = {
        revision,
        datasetId: initialDatasetId,
        roadsMode: infrastructureRenderOptionsRef.current.roads,
        railwaysMode: infrastructureRenderOptionsRef.current.railways,
        railwayPrototypeMode: 'production',
        themeId: activeTheme.id,
        hasFeatures: true,
        webglFramesRendered: 0,
      };
      targetScene.groundMesh.userData.__sceneMeta = sceneMeta;
      targetScene.updateCameraZoom?.(overrideZoom ?? 0.22);

      const totalBuildMs = Number((referenceBuildTimeMs + tiledBuildTimeMs).toFixed(2));
      latestCpuBuildTimeMsRef.current = totalBuildMs;
      setCpuBuildTimeMs(totalBuildMs);

      commitMapDataForRequest(requestId, ingested.data);
      mapLoadTrackerRef.current.recordSceneGeometryBuild(requestId, {
        effectStartedAtMs: tRef0,
        buildDurationMs: totalBuildMs,
        sceneRevision: revision,
        stageTimingsMs: referenceScene.stageTimingsMs ?? null,
        rendererConfig: {
          roadsMode: infrastructureRenderOptionsRef.current.roads,
          railwaysMode: infrastructureRenderOptionsRef.current.railways,
          railwayPrototypeMode: 'production',
          themeId: activeTheme.id,
        },
        triangles: targetScene.stats.totalTriangles,
        drawCalls: targetScene.stats.totalDrawCalls,
      });

      activeSceneRef.current = targetScene;
      setBuiltGeometry(targetScene);
      setLoading(false);
      mapLoadTrackerRef.current.markLoadingIndicatorHidden(requestId);

      setExplicitPose((prev) => ({
        target: extraOptions?.target ?? [0, 0, 0],
        zoom: overrideZoom ?? 0.22,
        azimuthRad: ((overrideAzimuthDeg ?? 45) * Math.PI) / 180,
        signal: prev.signal + 1,
      }));

      return {
        ...metricsPayload,
        totalBuildMs,
        ingestElapsedMs: Number(ingestElapsedMs.toFixed(2)),
        fetchElapsedMs: Number(fetchElapsedMs.toFixed(2)),
        sceneRevision: revision,
        datasetId: initialDatasetId,
        themeId: activeTheme.id,
      };
    } catch (err: any) {
      console.error('Failed to load M1a Hengelo Visual Acceptance Harness:', err);
      setError(`M1a Visual Harness Error: ${err?.message || String(err)}`);
      setLoading(false);
      mapLoadTrackerRef.current.markLoadingIndicatorHidden(requestId);
      const failed = mapLoadTrackerRef.current.markLoadFailed(
        requestId,
        err?.message || 'Failed to load M1a Hengelo Visual Acceptance Harness'
      );
      if (failed) setLastMapLoadDiagnostics(failed);
      throw err;
    }
  };

  const loadHengeloM2aTileStreaming = async (
    overrideZoom?: number,
    overrideAzimuthDeg?: number,
    isInitialStartupLoad: boolean = false,
    extraOptions?: {
      apiBaseUrl?: string;
      preloadMarginTiles?: number;
      retainMarginTiles?: number;
      maxConcurrentFetches?: number;
      maxCommitsPerFrame?: number;
      experimentSkipUnchangedViewport?: boolean;
      experimentSkipUnchangedZoom?: boolean;
      themeId?: string;
      target?: [number, number, number];
      regionalMinZoom?: number;
    }
  ) => {
    const loadToken = ++m2aLoadTokenRef.current;
    const targetThemeId =
      extraOptions?.themeId && MAP_THEMES[extraOptions.themeId]
        ? extraOptions.themeId
        : selectedThemeIdRef.current;

    const targetApiBaseUrl = extraOptions?.apiBaseUrl ?? '/api/tiles';
    const isExperimental1024 = targetApiBaseUrl.includes('1024m');
    const isRegionalPilot = targetApiBaseUrl.includes('tiles-region');
    const requestId = mapLoadTrackerRef.current.startLoad({
      locationId: 'hengelo_m2a_tiles',
      locationName: isRegionalPilot
        ? 'Twente Regional Mosaic (Bounded Shard Streaming · OSMTILE1)'
        : isExperimental1024
          ? 'Hengelo M2-A Baked Tile Streaming (4×4 · 1,024 m Experiment · OSMTILE1)'
          : 'Hengelo M2-A Baked Tile Streaming (8×8 · 512 m · OSMTILE1)',
      radiusMeters: 2048,
      sourceType: 'fixture',
      isInitialStartupLoad,
      rendererConfig: {
        roadsMode: infrastructureRenderOptionsRef.current.roads,
        railwaysMode: infrastructureRenderOptionsRef.current.railways,
        railwayPrototypeMode: 'production',
        themeId: targetThemeId,
      },
    });

    setLoading(true);
    setError(null);
    setHoveredFeature(null);
    setSelectedFeature(null);
    activeLocationIdRef.current = 'hengelo_m2a_tiles';
    setActiveLocationId('hengelo_m2a_tiles');
    isM1aHarnessActiveRef.current = false;
    setIsM1aHarnessActive(false);
    disposeM1aHarnessScenes();
    // Immediately clear any previously loaded mosaic identity & manager before fetching
    isM2aStreamingActiveRef.current = false;
    setIsM2aStreamingActive(false);
    disposeM2aStreamManager(false);
    setProgrammaticRegionalMinZoom(
      typeof extraOptions?.regionalMinZoom === 'number' ? extraOptions.regionalMinZoom : null
    );
    setActiveMosaicIdentity(createLoadingMosaicIdentity(isRegionalPilot));
    if (activeSceneRef.current) {
      activeSceneRef.current.dispose();
      activeSceneRef.current = null;
    }

    setStatusMessage(
      `Initializing tile stream from baked mosaic (${targetApiBaseUrl}/manifest)...`
    );

    try {
      if (extraOptions?.themeId && MAP_THEMES[extraOptions.themeId]) {
        selectedThemeIdRef.current = extraOptions.themeId;
        setSelectedThemeId(extraOptions.themeId);
      }

      const initialZoomRequested = overrideZoom ?? 1.2;
      const provisionalZoomPolicy = resolveCameraZoomPolicy({
        isRegionalStreaming: isRegionalPilot,
        urlOverride: urlRegionalMinZoomOverride,
        programmaticOverride:
          typeof extraOptions?.regionalMinZoom === 'number'
            ? extraOptions.regionalMinZoom
            : null,
      });
      const provisionalZoom = clampCameraZoom(
        initialZoomRequested,
        provisionalZoomPolicy.minZoom,
        provisionalZoomPolicy.maxZoom
      );
      const initialTarget: [number, number, number] = extraOptions?.target ?? [0, 0, 0];
      const activeTheme = MAP_THEMES[targetThemeId] || MAP_THEMES.tactical;

      const manager = new TileStreamManager({
        apiBaseUrl: extraOptions?.apiBaseUrl,
        preloadMarginTiles: extraOptions?.preloadMarginTiles,
        retainMarginTiles: extraOptions?.retainMarginTiles,
        maxConcurrentFetches: extraOptions?.maxConcurrentFetches,
        maxCommitsPerFrame: extraOptions?.maxCommitsPerFrame,
        experimentSkipUnchangedViewport: extraOptions?.experimentSkipUnchangedViewport,
        experimentSkipUnchangedZoom: extraOptions?.experimentSkipUnchangedZoom,
        initialTheme: activeTheme,
        initialCameraZoom: provisionalZoom,
        foliageOptimizationConfig: foliageConfigRef.current,
        onDiagnosticsChange: (diag) => {
          if (typeof window !== 'undefined' && (window as any).__BENCHMARK_ACTIVE__ === true) {
            return;
          }
          const now = performance.now();
          if (diag.loadingTiles === 0 || now - lastM2aDiagUiTimeRef.current >= 80) {
            lastM2aDiagUiTimeRef.current = now;
            setM2aStreamDiagnostics(diag);
          }
        },
      });
      manager.setWireframe(wireframe);
      tileStreamManagerRef.current = manager;

      const tInit0 = performance.now();
      const packMeta = await manager.initialize();
      const initElapsedMs = performance.now() - tInit0;

      if (loadToken !== m2aLoadTokenRef.current) {
        manager.dispose();
        return {
          initElapsedMs: Number(initElapsedMs.toFixed(2)),
          packMetadata: packMeta,
          sceneRevision: transitionRevisionRef.current,
        };
      }

      const loadedDiagnostics = manager.getDiagnostics();
      const coverageSummary = manager.getManifestCoverageSummary();
      const resolvedIsRegional =
        isRegionalPilot || loadedDiagnostics.totalGridTiles > REGIONAL_MIN_ZOOM_TILE_THRESHOLD;
      const resolvedZoomPolicy = resolveCameraZoomPolicy({
        isRegionalStreaming: resolvedIsRegional,
        urlOverride: urlRegionalMinZoomOverride,
        programmaticOverride:
          typeof extraOptions?.regionalMinZoom === 'number'
            ? extraOptions.regionalMinZoom
            : null,
      });
      const initialZoom = clampCameraZoom(
        initialZoomRequested,
        resolvedZoomPolicy.minZoom,
        resolvedZoomPolicy.maxZoom
      );
      manager.updateCameraZoom(initialZoom);

      // Seed initial viewport around target before first WebGL frame
      const halfSpan = Math.max(256, 700 / Math.max(initialZoom, resolvedZoomPolicy.minZoom));
      manager.updateViewport({
        minX: initialTarget[0] - halfSpan,
        maxX: initialTarget[0] + halfSpan,
        minZ: initialTarget[2] - halfSpan,
        maxZ: initialTarget[2] + halfSpan,
        focusX: initialTarget[0],
        focusZ: initialTarget[2],
        cameraZoom: initialZoom,
      });

      const totalPackTiles = packMeta.gridCols * packMeta.gridRows;
      const halfWidthM = (packMeta.gridCols * packMeta.tileSizeMeters) / 2;
      const halfDepthM = (packMeta.gridRows * packMeta.tileSizeMeters) / 2;
      const centerLonLat: [number, number] =
        Number.isFinite(packMeta.studyOriginEasting) &&
        Number.isFinite(packMeta.studyOriginNorthing)
          ? utm32NToGeo(packMeta.studyOriginEasting, packMeta.studyOriginNorthing)
          : [6.7935, 52.2625];

      const activeRegionalLabel = isRegionalPilot
        ? loadedDiagnostics.activeMosaicName || 'Twente Regional Mosaic'
        : 'Hengelo';
      const emptyEnvelopeData = localProvider.parseGeoJson(
        { type: 'FeatureCollection', features: [] },
        `${activeRegionalLabel} (${packMeta.snapshotId} · ${packMeta.gridCols}×${packMeta.gridRows} / ${totalPackTiles} Tiles)`,
        centerLonLat,
        Math.max(halfWidthM, halfDepthM)
      );
      emptyEnvelopeData.bounds = {
        minX: -halfWidthM,
        maxX: halfWidthM,
        minZ: -halfDepthM,
        maxZ: halfDepthM,
        widthMeters: halfWidthM * 2,
        depthMeters: halfDepthM * 2,
      };

      mapLoadTrackerRef.current.recordLocalTransferAndParse(requestId, {
        responseTransferMs: initElapsedMs,
        geoJsonProcessingMs: 0,
        featureCount: null,
      });

      const targetScene = manager.scene;
      const revision = ++transitionRevisionRef.current;
      const sceneMeta: SceneRevisionConfigMeta = {
        revision,
        datasetId: 'hengelo_m2a_tiles',
        roadsMode: infrastructureRenderOptionsRef.current.roads,
        railwaysMode: infrastructureRenderOptionsRef.current.railways,
        railwayPrototypeMode: 'production',
        themeId: targetThemeId,
        hasFeatures: true,
        webglFramesRendered: 0,
      };
      targetScene.groundMesh.userData.__sceneMeta = sceneMeta;

      const initMsRounded = Number(initElapsedMs.toFixed(2));
      latestCpuBuildTimeMsRef.current = initMsRounded;
      setCpuBuildTimeMs(initMsRounded);

      isM2aStreamingActiveRef.current = true;
      setIsM2aStreamingActive(true);
      setManifestCoverage(coverageSummary);
      setActiveMosaicIdentity(
        createMosaicIdentityFromDiagnostics(loadedDiagnostics, resolvedIsRegional)
      );
      setCurrentRawGeoJson(null);
      commitMapDataForRequest(requestId, emptyEnvelopeData);
      mapLoadTrackerRef.current.recordSceneGeometryBuild(requestId, {
        effectStartedAtMs: tInit0,
        buildDurationMs: initMsRounded,
        sceneRevision: revision,
        stageTimingsMs: null,
        rendererConfig: {
          roadsMode: infrastructureRenderOptionsRef.current.roads,
          railwaysMode: infrastructureRenderOptionsRef.current.railways,
          railwayPrototypeMode: 'production',
          themeId: targetThemeId,
        },
        triangles: targetScene.stats.totalTriangles,
        drawCalls: targetScene.stats.totalDrawCalls,
      });

      activeSceneRef.current = targetScene;
      setBuiltGeometry(targetScene);
      setM2aStreamDiagnostics(manager.getDiagnostics());
      setLoading(false);
      mapLoadTrackerRef.current.markLoadingIndicatorHidden(requestId);

      setExplicitPose((prev) => ({
        target: initialTarget,
        zoom: initialZoom,
        azimuthRad: ((overrideAzimuthDeg ?? 45) * Math.PI) / 180,
        signal: prev.signal + 1,
      }));

      return {
        initElapsedMs: initMsRounded,
        packMetadata: packMeta,
        sceneRevision: revision,
      };
    } catch (err: any) {
      console.error('Failed to initialize M2-A Runtime Tile Streaming:', err);
      if (loadToken !== m2aLoadTokenRef.current) {
        throw err;
      }
      disposeM2aStreamManager(false);
      isM2aStreamingActiveRef.current = false;
      setIsM2aStreamingActive(false);
      setProgrammaticRegionalMinZoom(null);
      setActiveMosaicIdentity(
        createErrorMosaicIdentity(
          isRegionalPilot,
          err?.message || 'Failed to initialize baked regional tile streaming'
        )
      );
      setError(`Regional Mosaic Unavailable: ${err?.message || String(err)}`);
      setLoading(false);
      mapLoadTrackerRef.current.markLoadingIndicatorHidden(requestId);
      const failed = mapLoadTrackerRef.current.markLoadFailed(
        requestId,
        err?.message || 'Failed to initialize baked regional tile streaming'
      );
      if (failed) setLastMapLoadDiagnostics(failed);
      throw err;
    }
  };

  const loadSwitchyardFixture = (
    targetZone: RailwayPrototypeZoneId = 'overview',
    overrideZoom?: number,
    overrideAzimuthDeg?: number,
    isInitialStartupLoad: boolean = false
  ) => {
    const requestId = mapLoadTrackerRef.current.startLoad({
      locationId: 'm21_switchyard',
      locationName: 'M2.1 Railway Switchyard Benchmark',
      radiusMeters: null,
      sourceType: 'fixture',
      isInitialStartupLoad,
      rendererConfig: {
        roadsMode: infrastructureRenderOptionsRef.current.roads,
        railwaysMode: infrastructureRenderOptionsRef.current.railways,
        railwayPrototypeMode: 'production',
        themeId: selectedThemeIdRef.current,
      },
    });
    setLoading(true);
    setError(null);
    setHoveredFeature(null);
    setSelectedFeature(null);
    clearM2aStreamingOnDatasetSwitch();
    setActiveLocationId('m21_switchyard');
    const tFixture0 = performance.now();
    const fixtureData = createRailwayPrototypeFixtureData();
    const tFixture1 = performance.now();
    mapLoadTrackerRef.current.recordLocalTransferAndParse(requestId, {
      geoJsonProcessingMs: tFixture1 - tFixture0,
    });
    setCurrentRawGeoJson(null);
    commitMapDataForRequest(requestId, fixtureData);
    setLoading(false);
    mapLoadTrackerRef.current.markLoadingIndicatorHidden(requestId);

    const preset =
      RAILWAY_PROTOTYPE_ZONE_PRESETS[targetZone] || RAILWAY_PROTOTYPE_ZONE_PRESETS.overview;
    setActivePrototypeZone(preset.id);
    setExplicitPose((prev) => ({
      target: preset.target,
      zoom: overrideZoom ?? preset.defaultZoom,
      azimuthRad:
        typeof overrideAzimuthDeg === 'number'
          ? (overrideAzimuthDeg * Math.PI) / 180
          : Math.PI / 4,
      signal: prev.signal + 1,
    }));
  };

  const loadPrinsHendrikkadeForkFixture = (
    overrideZoom?: number,
    overrideAzimuthDeg?: number,
    isInitialStartupLoad: boolean = false
  ) => {
    const requestId = mapLoadTrackerRef.current.startLoad({
      locationId: 'm23_prins_fork',
      locationName: 'M2.3-E2 Junction Lab · Prins Hendrikkade South',
      radiusMeters: 60,
      sourceType: 'fixture',
      isInitialStartupLoad,
      rendererConfig: {
        roadsMode: infrastructureRenderOptionsRef.current.roads,
        railwaysMode: infrastructureRenderOptionsRef.current.railways,
        railwayPrototypeMode: 'production',
        themeId: selectedThemeIdRef.current,
      },
    });
    setLoading(true);
    setError(null);
    setHoveredFeature(null);
    setSelectedFeature(null);
    clearM2aStreamingOnDatasetSwitch();
    setActiveLocationId('m23_prins_fork');
    try {
      const tParse0 = performance.now();
      const data = localProvider.parseGeoJson(
        prinsHendrikkadeForkFixture,
        'M2.3-E2 Junction Lab · Prins Hendrikkade South',
        [4.8979247, 52.3773823],
        60
      );
      const tParse1 = performance.now();
      mapLoadTrackerRef.current.recordLocalTransferAndParse(requestId, {
        geoJsonProcessingMs: tParse1 - tParse0,
        geoJsonSubTimingsMs: localProvider.getLastParseSubTimings(),
        featureCount: Array.isArray((prinsHendrikkadeForkFixture as any)?.features)
          ? (prinsHendrikkadeForkFixture as any).features.length
          : null,
      });
      setCurrentRawGeoJson(prinsHendrikkadeForkFixture);
      commitMapDataForRequest(requestId, data);
      setStatusMessage('Loaded southern Prins Hendrikkade acute cycleway fork');
      setExplicitPose((prev) => ({
        target: [0, 0, 0],
        zoom: overrideZoom ?? 8.0,
        azimuthRad: ((overrideAzimuthDeg ?? 45) * Math.PI) / 180,
        signal: prev.signal + 1,
      }));
    } catch (err: any) {
      console.error('Failed to load Prins Hendrikkade junction fixture:', err);
      setError(err.message);
      const failed = mapLoadTrackerRef.current.markLoadFailed(
        requestId,
        err?.message || 'Failed to load fixture'
      );
      if (failed) setLastMapLoadDiagnostics(failed);
    } finally {
      setLoading(false);
      mapLoadTrackerRef.current.markLoadingIndicatorHidden(requestId);
    }
  };

  const loadLiveHengeloPreset = async (
    target: [number, number, number] = [0, 0, 0],
    zoom: number = 1.0,
    azimuthDeg: number = 45,
    isInitialStartupLoad: boolean = false
  ) => {
    setActiveLocationId('hengelo');
    await fetchLiveOsmLocation(
      {
        name: 'Station Hengelo (Overijssel)',
        lat: 52.2625,
        lon: 6.7935,
        radius: 400,
      },
      {
        locationId: 'hengelo',
        sourceType: 'preset_live_osm',
        isInitialStartupLoad,
      }
    );
    setExplicitPose((prev) => ({
      target,
      zoom,
      azimuthRad: (azimuthDeg * Math.PI) / 180,
      signal: prev.signal + 1,
    }));
  };

  const loadLiveAmsterdamPreset = async (
    target: [number, number, number] = [0, 0, 0],
    zoom: number = 1.0,
    azimuthDeg: number = 45,
    isInitialStartupLoad: boolean = false
  ) => {
    setActiveLocationId('amsterdam');
    await fetchLiveOsmLocation(
      {
        name: 'Amsterdam Centraal (Railways & Canals)',
        lat: 52.3791,
        lon: 4.9003,
        radius: 420,
      },
      {
        locationId: 'amsterdam',
        sourceType: 'preset_live_osm',
        isInitialStartupLoad,
      }
    );
    setExplicitPose((prev) => ({
      target,
      zoom,
      azimuthRad: (azimuthDeg * Math.PI) / 180,
      signal: prev.signal + 1,
    }));
  };

  const handleImportReproductionPackage = (pkg: DeveloperReproductionPackage) => {
    const reproId = `repro_${Date.now()}`;
    const targetRenderOpts = pkg.configuration?.infrastructureRenderOptions
      ? normalizeInfrastructureRenderOptions(pkg.configuration.infrastructureRenderOptions)
      : infrastructureRenderOptionsRef.current;
    const targetThemeId =
      pkg.configuration?.themeId && MAP_THEMES[pkg.configuration.themeId]
        ? pkg.configuration.themeId
        : selectedThemeIdRef.current;

    const requestId = mapLoadTrackerRef.current.startLoad({
      locationId: reproId,
      locationName: pkg.report?.title || 'Imported Reproduction Scenario',
      radiusMeters: null,
      sourceType: 'repro_import',
      rendererConfig: {
        roadsMode: targetRenderOpts.roads,
        railwaysMode: targetRenderOpts.railways,
        railwayPrototypeMode: 'production',
        themeId: targetThemeId,
      },
    });
    setLoading(true);
    setError(null);
    setHoveredFeature(null);
    setSelectedFeature(null);
    clearM2aStreamingOnDatasetSwitch();
    setActiveLocationId(reproId);

    try {
      const defaultCenter: [number, number] = [4.897, 52.377];
      const tParse0 = performance.now();
      const parsedData = localProvider.parseGeoJson(
        pkg.geoJson,
        pkg.report?.title || 'Imported Reproduction Scenario',
        defaultCenter
      );
      const tParse1 = performance.now();
      mapLoadTrackerRef.current.recordLocalTransferAndParse(requestId, {
        geoJsonProcessingMs: tParse1 - tParse0,
        geoJsonSubTimingsMs: localProvider.getLastParseSubTimings(),
        featureCount: Array.isArray(pkg.geoJson?.features) ? pkg.geoJson.features.length : null,
      });

      setCurrentRawGeoJson(pkg.geoJson);
      commitMapDataForRequest(requestId, parsedData);

      if (pkg.configuration?.infrastructureRenderOptions) {
        setInfrastructureRenderOptions(
          normalizeInfrastructureRenderOptions(pkg.configuration.infrastructureRenderOptions)
        );
      }
      if (pkg.configuration?.themeId && MAP_THEMES[pkg.configuration.themeId]) {
        setSelectedThemeId(pkg.configuration.themeId);
      }
      if (typeof pkg.configuration?.roadWidthMultiplier === 'number') {
        setRoadWidthMultiplier(pkg.configuration.roadWidthMultiplier);
      }
      if (typeof pkg.configuration?.wireframe === 'boolean') {
        setWireframe(pkg.configuration.wireframe);
      }

      if (pkg.camera) {
        setExplicitPose((prev) => ({
          target: pkg.camera.target || [0, 0, 0],
          zoom: pkg.camera.zoom || 1.0,
          azimuthRad:
            typeof pkg.camera.azimuthDeg === 'number'
              ? (pkg.camera.azimuthDeg * Math.PI) / 180
              : undefined,
          signal: prev.signal + 1,
        }));
      }

      if (pkg.selectedArea?.spatialBoxMeters) {
        setSelectedBoxMeters(pkg.selectedArea.spatialBoxMeters);
      } else if ((pkg as any).selectedBoxMeters) {
        setSelectedBoxMeters((pkg as any).selectedBoxMeters);
      } else {
        setSelectedBoxMeters(null);
      }

      if (Array.isArray(pkg.selectedObjects) && pkg.selectedObjects.length > 0) {
        const restored: InspectableFeatureInfo[] = pkg.selectedObjects.map((obj) => ({
          id: obj.id,
          sourceFeatureId: obj.osmId || obj.id,
          sourceFeatureIds: [obj.osmId || obj.id],
          category: obj.category || 'Road & Way',
          cartoLabel: obj.cartoLabel || obj.category || 'Feature',
          primaryTag: obj.primaryTag || '',
          subtype: obj.subtype || '',
          width: obj.inferredWidth,
          elevation: obj.elevation,
          layer: obj.layer,
          isBridge: obj.isBridge,
          isTunnel: obj.isTunnel,
          osmTags: obj.osmTags || {},
        }));
        setSelectedFeatures(restored);
        const focusId = pkg.focusedFeatureId || restored[0].id;
        setFocusedFeatureId(focusId);
        const focusFeat = restored.find((f) => f.id === focusId) || restored[0];
        setSelectedFeature(focusFeat);
      } else if (pkg.inspection) {
        const insp = pkg.inspection;
        const single: InspectableFeatureInfo = {
          id: insp.selectedFeatureId,
          sourceFeatureId: insp.sourceFeatureIds?.[0] || insp.selectedFeatureId,
          sourceFeatureIds: insp.sourceFeatureIds,
          category: insp.category,
          cartoLabel: insp.cartoLabel,
          primaryTag: insp.primaryTag,
          subtype: insp.subtype,
          width: insp.inferredWidth,
          elevation: insp.elevation,
          layer: insp.layer,
          isBridge: insp.isBridge,
          isTunnel: insp.isTunnel,
          osmTags: insp.osmTags,
          portalConnections: insp.graphConnectivity?.portalConnections,
        };
        setSelectedFeatures([single]);
        setFocusedFeatureId(single.id);
        setSelectedFeature(single);
      } else {
        setSelectedFeatures([]);
        setFocusedFeatureId(null);
        setSelectedFeature(null);
      }

      setActivePanel('diagnostics');
      setStatusMessage(`Loaded reproduction: ${pkg.report?.title || 'Imported Scenario'}`);
    } catch (err: any) {
      console.error('Failed to import reproduction package:', err);
      setError(`Failed to import reproduction package: ${err.message}`);
      const failed = mapLoadTrackerRef.current.markLoadFailed(
        requestId,
        err?.message || 'Failed to import reproduction package'
      );
      if (failed) setLastMapLoadDiagnostics(failed);
    } finally {
      setLoading(false);
      mapLoadTrackerRef.current.markLoadingIndicatorHidden(requestId);
    }
  };

  const resolvePrototypeZonePreset = (zoneId: string) => {
    const aliasMap: Record<string, RailwayPrototypeZoneId> = {
      short: 'straight_curved',
      turnout: 'single_turnout',
      scissors: 'scissors_crossover',
      throat: 'station_throat',
    };
    const canonical = (aliasMap[zoneId] || zoneId) as RailwayPrototypeZoneId;
    return RAILWAY_PROTOTYPE_ZONE_PRESETS[canonical] || RAILWAY_PROTOTYPE_ZONE_PRESETS.overview;
  };

  const jumpToPrototypeZone = (
    zoneId: RailwayPrototypeZoneId,
    overrideZoom?: number,
    overrideAzimuthDeg?: number
  ) => {
    const preset = resolvePrototypeZonePreset(zoneId);
    setActivePrototypeZone(preset.id);
    setExplicitPose((prev) => ({
      target: preset.target,
      zoom: overrideZoom ?? preset.defaultZoom,
      azimuthRad:
        typeof overrideAzimuthDeg === 'number'
          ? (overrideAzimuthDeg * Math.PI) / 180
          : undefined,
      signal: prev.signal + 1,
    }));
  };

  const fetchLiveOsmLocation = async (
    loc: { name: string; lat: number; lon: number; radius: number },
    options?: {
      locationId?: string;
      sourceType?: MapLoadSourceType;
      isInitialStartupLoad?: boolean;
    }
  ) => {
    const requestId = mapLoadTrackerRef.current.startLoad({
      locationId: options?.locationId ?? activeLocationIdRef.current,
      locationName: loc.name,
      radiusMeters: loc.radius,
      sourceType: options?.sourceType ?? 'live_osm',
      isInitialStartupLoad: options?.isInitialStartupLoad,
      rendererConfig: {
        roadsMode: infrastructureRenderOptionsRef.current.roads,
        railwaysMode: infrastructureRenderOptionsRef.current.railways,
        railwayPrototypeMode: 'production',
        themeId: selectedThemeIdRef.current,
      },
    });
    setLoading(true);
    setError(null);
    setHoveredFeature(null);
    setSelectedFeature(null);
    clearM2aStreamingOnDatasetSwitch();
    setStatusMessage(`Retrieving OpenStreetMap fixture data for ${loc.name}...`);
    try {
      const parsedData = await osmApiProvider.loadRegion({
        centerLat: loc.lat,
        centerLon: loc.lon,
        radiusMeters: loc.radius,
        locationName: loc.name,
      });

      const providerMetrics = osmApiProvider.getLastLoadMetrics();
      if (providerMetrics) {
        mapLoadTrackerRef.current.recordOsmProviderMetrics(requestId, providerMetrics);
      }

      if (!mapLoadTrackerRef.current.isRequestCurrent(requestId)) {
        return;
      }

      setCurrentRawGeoJson(osmApiProvider.getLastRawGeoJson());
      commitMapDataForRequest(requestId, parsedData);
      setLoading(false);
      mapLoadTrackerRef.current.markLoadingIndicatorHidden(requestId);
      setResetCount((c) => c + 1);
    } catch (err: any) {
      console.error('Failed to load OSM region:', err);
      if (!mapLoadTrackerRef.current.isRequestCurrent(requestId)) {
        return;
      }
      setError(err.message);
      setLoading(false);
      mapLoadTrackerRef.current.markLoadingIndicatorHidden(requestId);
      const failed = mapLoadTrackerRef.current.markLoadFailed(
        requestId,
        err?.message || 'Failed to load OSM region'
      );
      if (failed) setLastMapLoadDiagnostics(failed);
    }
  };

  // Initial startup: boot directly into configured regional mosaic (/api/tiles-region) unless URL harness flags override
  useEffect(() => {
    if (initialMountLoadStartedRef.current) return;
    initialMountLoadStartedRef.current = true;

    const params = urlSearchParams;
    const initialRenderOpts = parseInfrastructureRenderOptionsFromSearch(
      window.location.search
    );
    infrastructureRenderOptionsRef.current = initialRenderOpts;
    setInfrastructureRenderOptions(initialRenderOpts);

    const themeParam = params.get('theme');
    if (themeParam && MAP_THEMES[themeParam]) {
      selectedThemeIdRef.current = themeParam;
      setSelectedThemeId(themeParam);
    }

    const fixtureParam = params.get('fixture');
    const zoneParam = (params.get('zone') as RailwayPrototypeZoneId) || 'overview';
    const rawZoomParam = params.get('zoom');
    const parsedZoomParam =
      rawZoomParam !== null && rawZoomParam.trim() !== '' ? Number(rawZoomParam.trim()) : NaN;
    const zoomParam =
      Number.isFinite(parsedZoomParam) && parsedZoomParam > 0 ? parsedZoomParam : undefined;
    const rawAzParam = params.get('azimuth');
    const parsedAzParam =
      rawAzParam !== null && rawAzParam.trim() !== '' ? Number(rawAzParam.trim()) : NaN;
    const azParam = Number.isFinite(parsedAzParam) ? parsedAzParam : undefined;

    const regionParam = params.get('region');
    const isRegionalPilotUrl =
      regionParam === 'twente-pilot' ||
      regionParam === 'twente-full' ||
      regionParam === 'twente';
    const isM2aStreamingParam =
      params.get('m2a') === '1' ||
      params.get('m2a') === 'true' ||
      params.get('m2') === '1' ||
      params.get('m2') === 'true' ||
      params.get('streaming') === '1' ||
      params.get('tiles') === '1' ||
      fixtureParam === 'hengelo-tiles' ||
      fixtureParam === 'm2a' ||
      isRegionalPilotUrl;
    const isM1aHarnessParam =
      params.get('m1a') === '1' ||
      params.get('m1a') === 'true' ||
      fixtureParam === 'hengelo-m1a' ||
      fixtureParam === 'm1a';
    const m1aModeParam =
      params.get('m1aMode') === 'reference' ? 'reference' : 'tiled';
    const tileSizeParamRaw = params.get('tileSize') ?? params.get('tileSizeMeters');
    const parsedTileSizeParam = tileSizeParamRaw
      ? Number.parseInt(tileSizeParamRaw, 10)
      : undefined;
    const is1024ExperimentUrl =
      parsedTileSizeParam === 1024 || params.get('pack') === '1024m';
    const matchedMarginsParam = params.get('matchPhysicalMargins');
    const matchPhysicalMargins =
      matchedMarginsParam === '1' || matchedMarginsParam === 'true';
    const experimentSkipUnchangedViewport = params.get('perfViewportGate') === '1';
    const experimentSkipUnchangedZoom = params.get('perfZoomGate') === '1';
    const visualStreamingOptions = {
      experimentSkipUnchangedViewport,
      experimentSkipUnchangedZoom,
      ...(isRegionalPilotUrl
        ? { apiBaseUrl: '/api/tiles-region' }
        : is1024ExperimentUrl
          ? { apiBaseUrl: '/api/tiles-1024m' }
          : {}),
      ...(isRegionalPilotUrl || matchPhysicalMargins
        ? {
            preloadMarginTiles: isRegionalPilotUrl || is1024ExperimentUrl ? 0.5 : 1,
            retainMarginTiles: isRegionalPilotUrl || is1024ExperimentUrl ? 1 : 2,
          }
        : {}),
    };

    if (isBenchmarkMode) {
      setActiveLocationId('benchmark_idle');
      const emptyData = localProvider.parseGeoJson(
        { type: 'FeatureCollection', features: [] },
        'Benchmark Idle State',
        [4.9003, 52.3791],
        100
      );
      setCurrentRawGeoJson(null);
      setMapData(emptyData);
      setLoading(false);
    } else if (isM2aStreamingParam) {
      void loadHengeloM2aTileStreaming(
        zoomParam,
        azParam,
        true,
        isRegionalPilotUrl ||
          is1024ExperimentUrl ||
          matchPhysicalMargins ||
          experimentSkipUnchangedViewport ||
          experimentSkipUnchangedZoom
          ? visualStreamingOptions
          : undefined
      );
    } else if (isM1aHarnessParam) {
      void loadHengeloM1aVisualHarness(
        m1aModeParam,
        zoomParam,
        azParam,
        true,
        is1024ExperimentUrl ? { tileSizeMeters: 1024 } : undefined
      );
    } else if (fixtureParam === 'switchyard') {
      loadSwitchyardFixture(zoneParam, zoomParam, azParam, true);
    } else if (fixtureParam === 'prins-fork') {
      loadPrinsHendrikkadeForkFixture(zoomParam, azParam, true);
    } else if (fixtureParam === 'amsterdam') {
      void loadLiveAmsterdamPreset([0, 0, 0], zoomParam ?? 1.0, azParam ?? 45, true);
    } else if (fixtureParam === 'hengelo') {
      void loadLiveHengeloPreset([0, 0, 0], zoomParam ?? 1.0, azParam ?? 45, true);
    } else {
      void loadHengeloM2aTileStreaming(
        zoomParam ?? 1.2,
        azParam ?? 45,
        true,
        {
          ...DEFAULT_REGIONAL_MOSAIC_OPTIONS,
        }
      );
    }
  }, []);

  const currentTheme: MapStyleTheme = useMemo(() => {
    return MAP_THEMES[selectedThemeId] || MAP_THEMES.tactical;
  }, [selectedThemeId]);

  const infrastructureRenderPreview = useMemo(() => {
    if (isM1aHarnessActive && m1aIngestedRef.current) {
      const ing = m1aIngestedRef.current;
      const preview =
        ing.descriptors && ing.previewMeta
          ? {
              options: ing.infrastructureRenderOptions,
              graph: ing.previewMeta.graph,
              descriptors: ing.descriptors,
              validation: ing.previewMeta.validation,
              timing: ing.previewMeta.timing,
            }
          : null;
      latestPreviewTimeMsRef.current = preview?.timing.totalPreviewTimeMs ?? 0;
      infrastructureRenderPreviewRef.current = preview;
      return preview;
    }

    const requestId = mapData ? mapDataRequestIdRef.current.get(mapData) : undefined;
    const trackPrep =
      requestId !== undefined && !mapLoadTrackerRef.current.hasFinalizedPresentation(requestId);

    if (!mapData || !requiresInfrastructureGraphPreview(infrastructureRenderOptions)) {
      latestPreviewTimeMsRef.current = 0;
      infrastructureRenderPreviewRef.current = null;
      if (trackPrep && requestId !== undefined) {
        mapLoadTrackerRef.current.recordInfrastructurePrep(requestId, performance.now(), 0);
      }
      return null;
    }
    const tPrep0 = performance.now();
    const preview = prepareInfrastructureRenderPreview(mapData, infrastructureRenderOptions);
    const prepDurationMs = performance.now() - tPrep0;
    latestPreviewTimeMsRef.current = preview?.timing.totalPreviewTimeMs ?? 0;
    infrastructureRenderPreviewRef.current = preview;
    if (trackPrep && requestId !== undefined) {
      mapLoadTrackerRef.current.recordInfrastructurePrep(requestId, tPrep0, prepDurationMs);
    }
    return preview;
  }, [mapData, isM1aHarnessActive, infrastructureRenderOptions.roads, infrastructureRenderOptions.railways]);

  useEffect(() => {
    if (
      !mapData ||
      isM1aHarnessActive ||
      isM2aStreamingActive ||
      isM1aHarnessActiveRef.current ||
      isM2aStreamingActiveRef.current
    ) {
      return;
    }

    const tEffectStart = performance.now();
    const requestId = mapDataRequestIdRef.current.get(mapData);

    if (
      typeof window !== 'undefined' &&
      typeof (window as any).__BENCHMARK_RESET_GPU_TIMERS__ === 'function'
    ) {
      (window as any).__BENCHMARK_RESET_GPU_TIMERS__();
    }

    if (activeSceneRef.current) {
      activeSceneRef.current.dispose();
      activeSceneRef.current = null;
    }

    const builder = new GeometryBuilder({
      buildingHeightMultiplier: heightMultiplier,
      roadWidthMultiplier: roadWidthMultiplier,
      bevelEnabled: bevelEnabled,
      initialCameraZoom: currentCameraZoomRef.current,
      infrastructureRenderOptions,
      infrastructureRenderPreview,
    });

    const t0 = performance.now();
    const scene = builder.buildScene(mapData, currentTheme);
    const rawBuildElapsedMs = performance.now() - t0;
    const buildElapsedMs = Number(rawBuildElapsedMs.toFixed(2));
    latestCpuBuildTimeMsRef.current = buildElapsedMs;

    const hasFeatures =
      (mapData.buildings?.length || 0) +
        (mapData.roads?.length || 0) +
        (mapData.railways?.length || 0) +
        (mapData.waterBodies?.length || 0) +
        (mapData.linearWaterways?.length || 0) +
        (mapData.parks?.length || 0) +
        (mapData.landuse?.length || 0) +
        (mapData.barriers?.length || 0) +
        (mapData.landmarks?.length || 0) >
      0;

    const pending = pendingTransitionMetaRef.current;
    const matchesPending =
      pending !== null &&
      pending.datasetId === activeLocationIdRef.current &&
      pending.roadsMode === infrastructureRenderOptions.roads &&
      pending.railwaysMode === infrastructureRenderOptions.railways &&
      pending.themeId === selectedThemeIdRef.current;

    const revision = matchesPending ? pending!.revision : ++transitionRevisionRef.current;
    if (matchesPending) {
      pendingTransitionMetaRef.current = null;
    }

    const sceneMeta: SceneRevisionConfigMeta = {
      revision,
      datasetId: activeLocationIdRef.current,
      roadsMode: infrastructureRenderOptions.roads,
      railwaysMode: infrastructureRenderOptions.railways,
      railwayPrototypeMode: 'production',
      themeId: selectedThemeIdRef.current,
      hasFeatures,
      webglFramesRendered: 0,
    };
    scene.groundMesh.userData.__sceneMeta = sceneMeta;

    if (requestId !== undefined && !mapLoadTrackerRef.current.hasFinalizedPresentation(requestId)) {
      mapLoadTrackerRef.current.recordSceneGeometryBuild(requestId, {
        effectStartedAtMs: tEffectStart,
        buildDurationMs: rawBuildElapsedMs,
        sceneRevision: revision,
        stageTimingsMs: scene.stageTimingsMs ?? null,
        rendererConfig: {
          roadsMode: infrastructureRenderOptions.roads,
          railwaysMode: infrastructureRenderOptions.railways,
          railwayPrototypeMode: 'production',
          themeId: selectedThemeIdRef.current,
        },
        triangles: scene.stats.totalTriangles,
        drawCalls: scene.stats.totalDrawCalls,
      });
    }

    setCpuBuildTimeMs(buildElapsedMs);
    activeSceneRef.current = scene;
    setBuiltGeometry(scene);
  }, [
    mapData,
    heightMultiplier,
    roadWidthMultiplier,
    bevelEnabled,
    infrastructureRenderOptions,
    infrastructureRenderPreview,
  ]);

  useEffect(() => {
    if (isM1aHarnessActive) {
      m1aTiledSceneRef.current?.updateTheme(currentTheme);
      m1aReferenceSceneRef.current?.updateTheme(currentTheme);
      return;
    }
    if (isM2aStreamingActive) {
      tileStreamManagerRef.current?.updateTheme(currentTheme);
      return;
    }
    if (activeSceneRef.current) {
      activeSceneRef.current.updateTheme(currentTheme);
    }
  }, [currentTheme, isM1aHarnessActive, isM2aStreamingActive]);

  useEffect(() => {
    if (isM2aStreamingActive) {
      tileStreamManagerRef.current?.setWireframe(wireframe);
    }
  }, [wireframe, isM2aStreamingActive]);

  useEffect(() => {
    return () => {
      disposeM1aHarnessScenes();
      disposeM2aStreamManager();
      if (activeSceneRef.current) {
        activeSceneRef.current.dispose();
        activeSceneRef.current = null;
      }
    };
  }, []);

  const buildLiveHarnessSnapshot = (): BenchmarkHarnessSnapshot & Record<string, any> => {
    const liveScene = activeSceneRef.current;
    const liveRenderOpts = infrastructureRenderOptionsRef.current;
    const livePreview = infrastructureRenderPreviewRef.current;
    const liveMap = mapDataRef.current;
    const sceneMeta =
      (liveScene?.groundMesh?.userData?.__sceneMeta as SceneRevisionConfigMeta | undefined) || null;
    const renderedMeta = latestRenderedMetaRef.current;

    const railStats = liveScene ? computeGroupGeometryStats(liveScene.railwaysGroup) : null;
    const rawCpuMem = liveScene?.resources.getCpuBufferMemoryStats() || null;
    const rawBvhMem = liveScene?.resources?.getBvhMemoryStats?.() ?? null;
    const tileStreamDiag = tileStreamManagerRef.current?.getDiagnostics() ?? null;
    const cpuMem =
      isM2aStreamingActiveRef.current && tileStreamDiag
        ? {
            geometryCount:
              (rawCpuMem?.geometryCount ?? 0) + tileStreamDiag.loadedTiles,
            attributeBytes:
              (rawCpuMem?.attributeBytes ?? 0) + tileStreamDiag.tileCpuGeometryBytes,
            indexBytes: rawCpuMem?.indexBytes ?? 0,
            totalBytes:
              (rawCpuMem?.totalBytes ?? 0) + tileStreamDiag.tileCpuGeometryBytes,
            totalMB: Number(
              (
                ((rawCpuMem?.totalBytes ?? 0) +
                  tileStreamDiag.tileCpuGeometryBytes) /
                (1024 * 1024)
              ).toFixed(3)
            ),
          }
        : rawCpuMem;
    const bvhMem =
      isM2aStreamingActiveRef.current && tileStreamDiag
        ? {
            bvhCount:
              (rawBvhMem?.bvhCount ?? 0) + tileStreamDiag.loadedTiles,
            rootBytes:
              (rawBvhMem?.rootBytes ?? 0) + tileStreamDiag.tileBvhBytes,
            indirectBufferBytes: rawBvhMem?.indirectBufferBytes ?? 0,
            totalBytes:
              (rawBvhMem?.totalBytes ?? 0) + tileStreamDiag.tileBvhBytes,
            totalMB: Number(
              (
                ((rawBvhMem?.totalBytes ?? 0) + tileStreamDiag.tileBvhBytes) /
                (1024 * 1024)
              ).toFixed(3)
            ),
          }
        : rawBvhMem;
    const totalCpuBufferMB = Number(((cpuMem?.totalBytes ?? 0) / (1024 * 1024)).toFixed(3));
    const totalSceneVertices = liveScene?.stats.totalVertices ?? 0;
    const totalSceneTriangles = liveScene?.stats.totalTriangles ?? 0;
    const totalSceneMeshes = liveScene?.stats.totalDrawCalls ?? 0;

    const webglFramesRenderedForRevision =
      sceneMeta && renderedMeta && renderedMeta.revision === sceneMeta.revision
        ? renderedMeta.webglFramesRendered
        : (sceneMeta?.webglFramesRendered ?? 0);
    const isSceneReady = Boolean(
      liveScene &&
        sceneMeta &&
        webglFramesRenderedForRevision >= 1
    );

    return {
      locationId: sceneMeta?.datasetId ?? activeLocationIdRef.current,
      regionName: liveMap?.regionName,
      prototypeMode: 'production',
      infrastructureRenderOptions: sceneMeta
        ? {
            ...liveRenderOpts,
            roads: sceneMeta.roadsMode,
            railways: sceneMeta.railwaysMode,
          }
        : liveRenderOpts,
      infrastructurePreviewStats: livePreview
        ? {
            graphBuildTimeMs: livePreview.timing.graphBuildTimeMs,
            adapterBuildTimeMs: livePreview.timing.adapterBuildTimeMs,
            validationTimeMs: livePreview.timing.validationTimeMs,
            totalPreviewTimeMs: livePreview.timing.totalPreviewTimeMs,
            isValid: livePreview.validation?.isValid ?? false,
            roadEdgeCount: livePreview.validation?.roadEdgeCount ?? 0,
            roadNodeCount: livePreview.validation?.roadNodeCount ?? 0,
            railwayEdgeCount: livePreview.validation?.railwayEdgeCount ?? 0,
            railwayNodeCount: livePreview.validation?.railwayNodeCount ?? 0,
          }
        : null,
      prototypeOptions: {
        useSpatialGridIndex: true,
        adaptiveBridgeSampling: true,
        multiIntervalClip: true,
        sleeper3DMode: 'instanced',
        spatialChunkSizeMeters: 128,
      },
      activeZone: activePrototypeZoneRef.current,
      themeId: sceneMeta?.themeId ?? selectedThemeIdRef.current,
      sceneRevision: sceneMeta?.revision ?? null,
      webglFramesRenderedForRevision,
      isSceneReady,
      cpuBuildTimeMs: latestCpuBuildTimeMsRef.current,
      prototypeBuildTimeMs: null,
      prototypeBuildProfile: liveScene?.railwaysGroup?.userData?.railwayProfile ?? null,
      constructedMeshesCount: totalSceneMeshes,
      sceneVertices: totalSceneVertices,
      sceneTriangles: totalSceneTriangles,
      cpuBufferMB: totalCpuBufferMB,
      cpuBufferMemoryStats: cpuMem,
      bvhMemoryStats: bvhMem,
      sceneStageTimingsMs: liveScene?.stageTimingsMs ?? null,
      legacyRoadStats: null,
      planarValidationReport: liveScene?.landuseGroup?.userData?.planarValidationReport ?? null,
      jsHeapMemory:
        typeof performance !== 'undefined' && (performance as any).memory
          ? {
              usedJSHeapSize: (performance as any).memory.usedJSHeapSize,
              totalJSHeapSize: (performance as any).memory.totalJSHeapSize,
              jsHeapSizeLimit: (performance as any).memory.jsHeapSizeLimit,
            }
          : null,
      railwayGroupStats: railStats,
      graphRoadStats: liveScene?.roadsGroup?.userData?.graphRoadStats ?? null,
      graphRoadTiming: liveScene?.roadsGroup?.userData?.graphRoadTiming ?? null,
      tileStreamingStats: tileStreamDiag,
      sceneMeshCounts:
        typeof window !== 'undefined' &&
        typeof (window as any).__BENCHMARK_GET_SCENE_MESH_COUNTS__ === 'function'
          ? (window as any).__BENCHMARK_GET_SCENE_MESH_COUNTS__()
          : null,
      liveWebGL: latestTelemetryRef.current,
    };
  };

  const handleSceneRevisionRendered = (meta: SceneRevisionConfigMeta) => {
    latestRenderedMetaRef.current = meta;
    if (meta.webglFramesRendered === 1) {
      const completedRecord = mapLoadTrackerRef.current.markScenePresented(meta.revision);
      if (completedRecord) {
        setLastMapLoadDiagnostics(completedRecord);
      }
    }
    if (readinessWaitersRef.current.length === 0) return;

    const remaining: typeof readinessWaitersRef.current = [];
    for (const waiter of readinessWaitersRef.current) {
      if (waiter.targetRevision !== meta.revision) {
        remaining.push(waiter);
        continue;
      }
      const snap = buildLiveHarnessSnapshot();
      const check = validateSceneReadinessSnapshot(snap, waiter.expected);
      if (check.ready) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    readinessWaitersRef.current = remaining;
  };

  const waitForSceneReady = (
    targetRevision: number,
    expected: ExpectedSceneReadinessSpec,
    timeoutMs: number = 30000
  ): Promise<void> => {
    const existingSnap = buildLiveHarnessSnapshot();
    const immediateCheck = validateSceneReadinessSnapshot(existingSnap, expected);
    if (immediateCheck.ready) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        readinessWaitersRef.current = readinessWaitersRef.current.filter(
          (w) => w.targetRevision !== targetRevision
        );
        const finalSnap = buildLiveHarnessSnapshot();
        const finalCheck = validateSceneReadinessSnapshot(finalSnap, expected);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for scene readiness (revision=${targetRevision}): ${finalCheck.reason || 'unknown readiness failure'}`
          )
        );
      }, timeoutMs);

      readinessWaitersRef.current.push({
        targetRevision,
        expected,
        resolve,
        reject,
        timer,
      });
    });
  };

  // Expose deterministic M2.1 Prototype Lab & Benchmark Harness API on window
  useEffect(() => {
    (window as any).__M21_LAB__ = {
      setMode: () => {},
      setInfrastructureRenderOptions: (opts: Partial<InfrastructureRenderOptions>) =>
        setInfrastructureRenderOptions((prev) => {
          const next = normalizeInfrastructureRenderOptions({ ...prev, ...opts });
          infrastructureRenderOptionsRef.current = next;
          return next;
        }),
      getInfrastructureRenderOptions: () => infrastructureRenderOptionsRef.current,
      getInfrastructureRenderPreview: () => infrastructureRenderPreviewRef.current,
      setPrototypeOptions: () => {},
      getPrototypeOptions: () => ({
        useSpatialGridIndex: true,
        adaptiveBridgeSampling: true,
        multiIntervalClip: true,
        sleeper3DMode: 'instanced' as const,
        spatialChunkSizeMeters: 128,
      }),
      setTheme: (themeId: string) => {
        selectedThemeIdRef.current = themeId;
        setSelectedThemeId(themeId);
      },
      setDockCollapsed: (collapsed: boolean) => {
        setNavMode(collapsed ? 'hidden' : 'expanded');
        if (collapsed) setActivePanel(null);
      },
      setActiveTab: (tab: 'layers' | 'inspector' | 'style' | 'stats' | 'info') =>
        setActivePanel(mapLegacyTabToPanelId(tab)),
      loadSwitchyard: (
        zone: RailwayPrototypeZoneId = 'overview',
        zoom?: number,
        azimuthDeg?: number
      ) => loadSwitchyardFixture(zone, zoom, azimuthDeg),
      loadHengelo: (
        target: [number, number, number] = [0, 0, 0],
        zoom: number = 1.0,
        azimuthDeg: number = 45
      ) => loadLiveHengeloPreset(target, zoom, azimuthDeg),
      loadAmsterdam: (
        target: [number, number, number] = [0, 0, 0],
        zoom: number = 1.0,
        azimuthDeg: number = 45
      ) => loadLiveAmsterdamPreset(target, zoom, azimuthDeg),
      loadOsmLocation: async (params: {
        name: string;
        lat: number;
        lon: number;
        radius: number;
        locationId?: string;
      }) => {
        const locId = params.locationId ?? `live_${params.radius}m`;
        activeLocationIdRef.current = locId;
        setActiveLocationId(locId);
        await fetchLiveOsmLocation(
          {
            name: params.name,
            lat: params.lat,
            lon: params.lon,
            radius: params.radius,
          },
          {
            locationId: locId,
            sourceType: 'live_osm',
          }
        );
      },
      setCameraPose: (
        target: [number, number, number],
        zoom: number,
        azimuthDeg?: number
      ) => {
        if (imperativePoseSetterRef.current) {
          imperativePoseSetterRef.current(target, zoom, azimuthDeg);
          return;
        }
        setExplicitPose((prev) => ({
          target,
          zoom,
          azimuthRad:
            typeof azimuthDeg === 'number' ? (azimuthDeg * Math.PI) / 180 : prev.azimuthRad,
          signal: prev.signal + 1,
        }));
      },
      jumpToZone: (
        zone: RailwayPrototypeZoneId,
        zoom?: number,
        azimuthDeg?: number
      ) => jumpToPrototypeZone(zone, zoom, azimuthDeg),
      getSnapshot: () => buildLiveHarnessSnapshot(),
      getMapLoadDiagnostics: () => ({
        latest: mapLoadTrackerRef.current.getLatestRecord(),
        inProgress: mapLoadTrackerRef.current.getInProgressSnapshot(),
        history: mapLoadTrackerRef.current.getHistory(),
      }),
      runCameraScenario: async (
        scenarioId:
          | 'overview'
          | 'throat_close'
          | 'pan_sweep'
          | 'rotate_sweep'
          | 'combined_sweep',
        steps: number = 12,
        stepDelayMs: number = 16
      ) => {
        const samples: number[] = [];
        const hoverRaycastSamples: number[] = [];
        const renderCallSamples: number[] = [];
        const frustumTriSamples: number[] = [];
        const canvas = document.querySelector('canvas');

        await new Promise<void>((r) => requestAnimationFrame(() => r()));

        for (let i = 0; i < steps; i++) {
          const u = steps <= 1 ? 0 : i / (steps - 1);
          if (scenarioId === 'overview') {
            setExplicitPose((prev) => ({
              target: [0, 0, 0],
              zoom: 1.0,
              azimuthRad: Math.PI / 4,
              signal: prev.signal + 1,
            }));
          } else if (scenarioId === 'throat_close') {
            setExplicitPose((prev) => ({
              target: [-290, 0, -145],
              zoom: 8.0,
              azimuthRad: Math.PI / 4,
              signal: prev.signal + 1,
            }));
          } else if (scenarioId === 'pan_sweep') {
            const x = -320 + 640 * u;
            const z = -160 + 320 * u;
            setExplicitPose((prev) => ({
              target: [x, 0, z],
              zoom: 6.5,
              azimuthRad: Math.PI / 4,
              signal: prev.signal + 1,
            }));
          } else if (scenarioId === 'rotate_sweep') {
            const az = Math.PI / 4 + u * Math.PI * 2;
            setExplicitPose((prev) => ({
              target: [-210, 0, -95],
              zoom: 6.5,
              azimuthRad: az,
              signal: prev.signal + 1,
            }));
          } else if (scenarioId === 'combined_sweep') {
            const x = -310 + 550 * u;
            const z = -150 + 300 * u;
            const az = Math.PI / 4 + u * Math.PI * 1.5;
            const zm = 5.0 + 3.5 * Math.sin(u * Math.PI);
            setExplicitPose((prev) => ({
              target: [x, 0, z],
              zoom: zm,
              azimuthRad: az,
              signal: prev.signal + 1,
            }));
            if (canvas) {
              const rect = canvas.getBoundingClientRect();
              canvas.dispatchEvent(
                new PointerEvent('pointermove', {
                  clientX: rect.left + rect.width * (0.25 + 0.5 * u),
                  clientY: rect.top + rect.height * (0.3 + 0.4 * u),
                  buttons: 1,
                  bubbles: true,
                })
              );
            }
          }

          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          const tStart = performance.now();
          await new Promise<void>((r) =>
            requestAnimationFrame(() => {
              if (stepDelayMs > 0) setTimeout(r, stepDelayMs);
              else r();
            })
          );
          const stepFrameMs = Number((performance.now() - tStart).toFixed(2));
          samples.push(stepFrameMs);
          const tel = latestTelemetryRef.current;
          if (tel) {
            hoverRaycastSamples.push(tel.hoverRaycastTimeMs ?? 0);
            renderCallSamples.push(tel.renderCalls);
            frustumTriSamples.push(tel.activeFrustumVisibleRailwayTriangles ?? 0);
          }
        }

        const sorted = [...samples].sort((a, b) => a - b);
        const pct = (p: number) =>
          sorted.length === 0
            ? 0
            : sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
        const medianMs = Number(pct(0.5).toFixed(2));
        const p95Ms = Number(pct(0.95).toFixed(2));
        const p99Ms = Number(pct(0.99).toFixed(2));
        const minMs = sorted.length > 0 ? sorted[0] : 0;
        const maxMs = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
        return {
          scenarioId,
          sampleCount: samples.length,
          medianFrameIntervalMs: medianMs,
          p95FrameIntervalMs: p95Ms,
          p99FrameIntervalMs: p99Ms,
          minFps: maxMs > 0 ? Math.round(1000 / maxMs) : 0,
          maxFps: minMs > 0 ? Math.min(240, Math.round(1000 / minMs)) : 0,
          spikesOver33msCount: samples.filter((s) => s > 33.3).length,
          spikesOver50msCount: samples.filter((s) => s > 50.0).length,
          maxSpikeDurationMs: Number(maxMs.toFixed(2)),
          avgRenderCalls:
            renderCallSamples.length > 0
              ? Math.round(
                  renderCallSamples.reduce((a, b) => a + b, 0) / renderCallSamples.length
                )
              : 0,
          avgFrustumVisibleRailwayTriangles:
            frustumTriSamples.length > 0
              ? Math.round(
                  frustumTriSamples.reduce((a, b) => a + b, 0) / frustumTriSamples.length
                )
              : 0,
          maxHoverRaycastMs:
            hoverRaycastSamples.length > 0
              ? Number(Math.max(...hoverRaycastSamples).toFixed(2))
              : 0,
          latestWebGL: latestTelemetryRef.current,
        };
      },
      exportBenchmarkJson: () => {
        const snap = (window as any).__M21_LAB__?.getSnapshot();
        const payload = {
          benchmarkVersion: 'M2.1-runtime-performance-investigation',
          exportTimestamp: new Date().toISOString(),
          platform: {
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown',
            devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
            hardwareConcurrency:
              typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null,
            gpuVendor: snap?.liveWebGL?.gpuVendor ?? 'Unknown',
            gpuRenderer:
              snap?.liveWebGL?.gpuRenderer ?? 'Software GL / WebGL2 (SwiftShader)',
            canvasWidth: snap?.liveWebGL?.canvasWidth ?? window.innerWidth,
            canvasHeight: snap?.liveWebGL?.canvasHeight ?? window.innerHeight,
          },
          ...snap,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
          type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `m2-1-baseline-${payload.locationId || 'data'}-${payload.prototypeMode}.json`;
        a.click();
        URL.revokeObjectURL(url);
        return payload;
      },
      captureCanvasDataUrl: () => {
        const canvas = document.querySelector('canvas');
        return canvas ? canvas.toDataURL('image/png') : null;
      },
      capturePose: (
        _mode: string,
        themeId: string,
        zone: RailwayPrototypeZoneId,
        zoom: number,
        dockCollapsed: boolean = true
      ) =>
        new Promise<string | null>((resolve) => {
          setSelectedThemeId(themeId);
          setNavMode(dockCollapsed ? 'hidden' : 'expanded');
          setActivePanel(dockCollapsed ? null : 'performance');
          jumpToPrototypeZone(zone, zoom);
          setTimeout(() => {
            const canvas = document.querySelector('canvas');
            resolve(canvas ? canvas.toDataURL('image/png') : null);
          }, 450);
        }),
      loadOfflineDataset: async (params: {
        datasetId: string;
        regionName: string;
        rawGeoJson?: any;
        isSwitchyardFixture?: boolean;
        centerLonLat: [number, number];
        clipRadiusMeters?: number;
        infrastructureRenderOptions?: Partial<InfrastructureRenderOptions>;
        roadsMode?: InfrastructureRenderOptions['roads'];
        railwaysMode?: InfrastructureRenderOptions['railways'];
        railwayPrototypeMode?: 'production' | 'candidateB';
        themeId?: string;
        target?: [number, number, number];
        zoom?: number;
        azimuthDeg?: number;
        timeoutMs?: number;
      }) => {
        const tTotalStart = performance.now();
        const targetRevision = ++transitionRevisionRef.current;

        const targetRenderOpts = normalizeInfrastructureRenderOptions({
          ...infrastructureRenderOptionsRef.current,
          ...params.infrastructureRenderOptions,
          ...(params.roadsMode ? { roads: params.roadsMode } : {}),
          ...(params.railwaysMode ? { railways: params.railwaysMode } : {}),
        });
        const targetThemeId =
          params.themeId && MAP_THEMES[params.themeId]
            ? params.themeId
            : selectedThemeIdRef.current;

        const requestId = mapLoadTrackerRef.current.startLoad({
          locationId: params.datasetId,
          locationName: params.regionName,
          radiusMeters: params.clipRadiusMeters ?? null,
          sourceType: 'offline_benchmark',
          rendererConfig: {
            roadsMode: targetRenderOpts.roads,
            railwaysMode: targetRenderOpts.railways,
            railwayPrototypeMode: 'production',
            themeId: targetThemeId,
          },
        });

        setLoading(true);
        setError(null);
        setHoveredFeature(null);
        setSelectedFeature(null);
        clearM2aStreamingOnDatasetSwitch();
        activeLocationIdRef.current = params.datasetId;
        setActiveLocationId(params.datasetId);

        const tParseStart = performance.now();
        const parsedData = params.isSwitchyardFixture
          ? createRailwayPrototypeFixtureData()
          : localProvider.parseGeoJson(
              params.rawGeoJson,
              params.regionName,
              params.centerLonLat,
              params.clipRadiusMeters
            );
        const rawParseMs = performance.now() - tParseStart;
        const datasetParseMs = Number(rawParseMs.toFixed(3));
        mapLoadTrackerRef.current.recordLocalTransferAndParse(requestId, {
          geoJsonProcessingMs: rawParseMs,
          geoJsonSubTimingsMs: params.isSwitchyardFixture
            ? null
            : localProvider.getLastParseSubTimings(),
          featureCount: Array.isArray(params.rawGeoJson?.features)
            ? params.rawGeoJson.features.length
            : null,
        });

        const hasFeatures =
          (parsedData.buildings?.length || 0) +
            (parsedData.roads?.length || 0) +
            (parsedData.railways?.length || 0) +
            (parsedData.waterBodies?.length || 0) +
            (parsedData.linearWaterways?.length || 0) +
            (parsedData.parks?.length || 0) +
            (parsedData.landuse?.length || 0) +
            (parsedData.barriers?.length || 0) +
            (parsedData.landmarks?.length || 0) >
          0;

        pendingTransitionMetaRef.current = {
          revision: targetRevision,
          datasetId: params.datasetId,
          roadsMode: targetRenderOpts.roads,
          railwaysMode: targetRenderOpts.railways,
          railwayPrototypeMode: 'production',
          themeId: targetThemeId,
          hasFeatures,
        };

        infrastructureRenderOptionsRef.current = targetRenderOpts;
        setInfrastructureRenderOptions(targetRenderOpts);
        selectedThemeIdRef.current = targetThemeId;
        setSelectedThemeId(targetThemeId);

        setCurrentRawGeoJson(params.rawGeoJson ?? null);
        mapDataRef.current = parsedData;
        commitMapDataForRequest(requestId, parsedData);
        setLoading(false);
        mapLoadTrackerRef.current.markLoadingIndicatorHidden(requestId);

        const target: [number, number, number] = params.target ?? [0, 0, 0];
        const zoom = params.zoom ?? 1.0;
        const azimuthDeg = params.azimuthDeg ?? 45;
        const azimuthRad = (azimuthDeg * Math.PI) / 180;
        setExplicitPose((prev) => ({
          target,
          zoom,
          azimuthRad,
          signal: prev.signal + 1,
        }));

        const tReadyWaitStart = performance.now();
        await waitForSceneReady(
          targetRevision,
          {
            expectedRevision: targetRevision,
            datasetId: params.datasetId,
            roadsMode: targetRenderOpts.roads,
            railwaysMode: targetRenderOpts.railways,
            railwayPrototypeMode: 'production',
            themeId: targetThemeId,
            expectNonEmptyScene: hasFeatures,
            minWebglFramesRendered: 1,
          },
          params.timeoutMs ?? 30000
        );

        if (imperativePoseSetterRef.current) {
          imperativePoseSetterRef.current(target, zoom, azimuthDeg);
        }

        const totalSceneInitToFirstFrameMs = Number(
          (performance.now() - tTotalStart).toFixed(3)
        );
        const cpuSceneBuildMs = Number(
          (latestCpuBuildTimeMsRef.current + latestPreviewTimeMsRef.current).toFixed(3)
        );
        const firstWebGLRenderMs = Number(
          Math.max(
            0,
            performance.now() - tReadyWaitStart - cpuSceneBuildMs
          ).toFixed(3)
        );

        return {
          datasetParseMs,
          cpuSceneBuildMs,
          firstWebGLRenderMs,
          totalSceneInitToFirstFrameMs,
          sceneRevision: targetRevision,
        };
      },
      unloadDataset: async () => {
        const targetRevision = ++transitionRevisionRef.current;
        const curOpts = infrastructureRenderOptionsRef.current;
        const curTheme = selectedThemeIdRef.current;

        setHoveredFeature(null);
        setSelectedFeature(null);
        isM1aHarnessActiveRef.current = false;
        setIsM1aHarnessActive(false);
        disposeM1aHarnessScenes();
        clearM2aStreamingOnDatasetSwitch();
        activeLocationIdRef.current = 'benchmark_unloaded';
        setActiveLocationId('benchmark_unloaded');

        const emptyData = localProvider.parseGeoJson(
          { type: 'FeatureCollection', features: [] },
          'Benchmark Unloaded State',
          [4.9003, 52.3791],
          100
        );

        pendingTransitionMetaRef.current = {
          revision: targetRevision,
          datasetId: 'benchmark_unloaded',
          roadsMode: curOpts.roads,
          railwaysMode: curOpts.railways,
          railwayPrototypeMode: 'production',
          themeId: curTheme,
          hasFeatures: false,
        };

        setCurrentRawGeoJson(null);
        mapDataRef.current = emptyData;
        setMapData(emptyData);

        await waitForSceneReady(targetRevision, {
          expectedRevision: targetRevision,
          datasetId: 'benchmark_unloaded',
          roadsMode: curOpts.roads,
          railwaysMode: curOpts.railways,
          railwayPrototypeMode: 'production',
          themeId: curTheme,
          expectNonEmptyScene: false,
          minWebglFramesRendered: 1,
        });
      },
      loadM1aModes: async (params: {
        osmDataUrl?: string;
        initialMode?: M1aVisualComparisonMode;
        gridCols?: number;
        gridRows?: number;
        tileSizeMeters?: number;
        centerLonLat?: [number, number];
        themeId?: string;
        target?: [number, number, number];
        zoom?: number;
        azimuthDeg?: number;
        timeoutMs?: number;
      } = {}) => {
        const initialMode = params.initialMode ?? 'tiled';
        const res = await loadHengeloM1aVisualHarness(
          initialMode,
          params.zoom ?? 1.8,
          params.azimuthDeg ?? 45,
          false,
          {
            osmDataUrl: params.osmDataUrl,
            gridCols: params.gridCols,
            gridRows: params.gridRows,
            tileSizeMeters: params.tileSizeMeters,
            centerLonLat: params.centerLonLat,
            themeId: params.themeId,
            target: params.target,
          }
        );
        const datasetId =
          initialMode === 'tiled' ? 'hengelo_m1a_tiled' : 'hengelo_m1a_reference';
        await waitForSceneReady(
          res.sceneRevision,
          {
            expectedRevision: res.sceneRevision,
            datasetId,
            roadsMode: infrastructureRenderOptionsRef.current.roads,
            railwaysMode: infrastructureRenderOptionsRef.current.railways,
            railwayPrototypeMode: 'production',
            themeId: res.themeId,
            expectNonEmptyScene: true,
            minWebglFramesRendered: 1,
          },
          params.timeoutMs ?? 120000
        );
        if (imperativePoseSetterRef.current) {
          imperativePoseSetterRef.current(
            params.target ?? [0, 0, 0],
            params.zoom ?? 1.8,
            params.azimuthDeg ?? 45
          );
        }
        return res;
      },
      switchM1aMode: async (
        mode: M1aVisualComparisonMode,
        timeoutMs: number = 30000
      ) => {
        const rev = switchM1aVisualMode(mode);
        if (rev === null) {
          throw new Error(
            `M1a mode "${mode}" is not built. Call loadM1aModes() first.`
          );
        }
        const datasetId =
          mode === 'tiled' ? 'hengelo_m1a_tiled' : 'hengelo_m1a_reference';
        await waitForSceneReady(
          rev,
          {
            expectedRevision: rev,
            datasetId,
            roadsMode: infrastructureRenderOptionsRef.current.roads,
            railwaysMode: infrastructureRenderOptionsRef.current.railways,
            railwayPrototypeMode: 'production',
            themeId: selectedThemeIdRef.current,
            expectNonEmptyScene: true,
            minWebglFramesRendered: 1,
          },
          timeoutMs
        );
        return { mode, sceneRevision: rev };
      },
      loadM2aStreaming: async (params: {
        apiBaseUrl?: string;
        preloadMarginTiles?: number;
        retainMarginTiles?: number;
        maxConcurrentFetches?: number;
        maxCommitsPerFrame?: number;
        experimentSkipUnchangedViewport?: boolean;
        experimentSkipUnchangedZoom?: boolean;
        themeId?: string;
        target?: [number, number, number];
        zoom?: number;
        azimuthDeg?: number;
        regionalMinZoom?: number;
        waitForIdle?: boolean;
        timeoutMs?: number;
      } = {}) => {
        const res = await loadHengeloM2aTileStreaming(
          params.zoom ?? 1.8,
          params.azimuthDeg ?? 45,
          false,
          {
            apiBaseUrl: params.apiBaseUrl,
            preloadMarginTiles: params.preloadMarginTiles,
            retainMarginTiles: params.retainMarginTiles,
            maxConcurrentFetches: params.maxConcurrentFetches,
            maxCommitsPerFrame: params.maxCommitsPerFrame,
            experimentSkipUnchangedViewport: params.experimentSkipUnchangedViewport,
            experimentSkipUnchangedZoom: params.experimentSkipUnchangedZoom,
            themeId: params.themeId,
            target: params.target,
            regionalMinZoom: params.regionalMinZoom,
          }
        );
        await waitForSceneReady(
          res.sceneRevision,
          {
            expectedRevision: res.sceneRevision,
            datasetId: 'hengelo_m2a_tiles',
            roadsMode: infrastructureRenderOptionsRef.current.roads,
            railwaysMode: infrastructureRenderOptionsRef.current.railways,
            railwayPrototypeMode: 'production',
            themeId: params.themeId ?? selectedThemeIdRef.current,
            expectNonEmptyScene: true,
            minWebglFramesRendered: 1,
          },
          params.timeoutMs ?? 60000
        );
        if (imperativePoseSetterRef.current) {
          imperativePoseSetterRef.current(
            params.target ?? [0, 0, 0],
            params.zoom ?? 1.8,
            params.azimuthDeg ?? 45
          );
        }
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (params.waitForIdle !== false && tileStreamManagerRef.current) {
          await tileStreamManagerRef.current.waitForIdle();
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
        }
        return {
          ...res,
          diagnostics: tileStreamManagerRef.current?.getDiagnostics() ?? null,
        };
      },
      waitForM2aIdle: async () => {
        if (!tileStreamManagerRef.current) return null;
        await tileStreamManagerRef.current.waitForIdle();
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        return tileStreamManagerRef.current.getDiagnostics();
      },
      resetM2aPerfCounters: () => {
        tileStreamManagerRef.current?.resetPerformanceCounters();
      },
      getTileStreamDiagnostics: () =>
        tileStreamManagerRef.current?.getDiagnostics() ?? null,
      getActiveMosaicIdentity: () => activeMosaicIdentityRef.current,
      getCameraZoomPolicy: () => cameraZoomPolicyRef.current,
      getSceneMeshCounts: () =>
        typeof (window as any).__BENCHMARK_GET_SCENE_MESH_COUNTS__ === 'function'
          ? (window as any).__BENCHMARK_GET_SCENE_MESH_COUNTS__()
          : null,
      getCameraState: () =>
        typeof (window as any).__BENCHMARK_GET_CAMERA_STATE__ === 'function'
          ? (window as any).__BENCHMARK_GET_CAMERA_STATE__()
          : null,
      getFoliageOptimizationConfig: () => ({ ...foliageConfigRef.current }),
      setFoliageOptimizationConfig: (
        partial: Partial<FoliageOptimizationConfig>
      ) => {
        const next = normalizeFoliageOptimizationConfig({
          ...foliageConfigRef.current,
          ...partial,
        });
        foliageConfigRef.current = next;
        setFoliageConfig(next);
        if (tileStreamManagerRef.current) {
          return tileStreamManagerRef.current.setFoliageOptimizationConfig(next);
        }
        const setSceneFoliage = activeSceneRef.current?.foliageGroup?.userData
          ?.setFoliageOptimizationConfig as
          | ((cfg: Partial<FoliageOptimizationConfig>) => unknown)
          | undefined;
        if (typeof setSceneFoliage === 'function') {
          return setSceneFoliage(next);
        }
        return null;
      },
      getFoliageTelemetry: () =>
        typeof (window as any).__BENCHMARK_GET_FOLIAGE_TELEMETRY__ === 'function'
          ? (window as any).__BENCHMARK_GET_FOLIAGE_TELEMETRY__()
          : null,
    };
    (window as any).__BENCHMARK_HARNESS__ = (window as any).__M21_LAB__;
  }, [
    activeLocationId,
    mapData,
    infrastructureRenderOptions,
    infrastructureRenderPreview,
    activePrototypeZone,
    selectedThemeId,
    cpuBuildTimeMs,
    builtGeometry,
    liveTelemetry,
  ]);

  // Synchronize runtime foliage optimization settings whenever a new scene mounts
  useEffect(() => {
    const setSceneFoliage = builtGeometry?.foliageGroup?.userData
      ?.setFoliageOptimizationConfig as
      | ((cfg: Partial<FoliageOptimizationConfig>) => void)
      | undefined;
    if (typeof setSceneFoliage === 'function') {
      setSceneFoliage(foliageConfigRef.current);
    }
  }, [builtGeometry]);

  const handleChangeFoliageConfig = (
    partial: Partial<FoliageOptimizationConfig>
  ) => {
    const next = normalizeFoliageOptimizationConfig({
      ...foliageConfigRef.current,
      ...partial,
    });
    foliageConfigRef.current = next;
    setFoliageConfig(next);
    if (tileStreamManagerRef.current) {
      tileStreamManagerRef.current.setFoliageOptimizationConfig(next);
    }
    const setSceneFoliage = activeSceneRef.current?.foliageGroup?.userData
      ?.setFoliageOptimizationConfig as
      | ((cfg: Partial<FoliageOptimizationConfig>) => void)
      | undefined;
    if (typeof setSceneFoliage === 'function') {
      setSceneFoliage(next);
    }
  };

  const handleResetCamera = () => {
    setResetCount((c) => c + 1);
  };

  const handleHoverFeature = (
    info: InspectableFeatureInfo | null,
    pos?: { x: number; y: number }
  ) => {
    setHoveredFeature(info);
    if (pos && (pos.x !== 0 || pos.y !== 0)) {
      setHoverPos(pos);
    }
  };

  // Selecting a feature in the 3D viewport updates selection state WITHOUT altering open sidebars
  const handleSelectFeature = (info: InspectableFeatureInfo | null) => {
    if (!info) {
      setSelectedFeature(null);
      return;
    }
    setSelectedFeature(info);
    setFocusedFeatureId(info.id);
    setSelectedFeatures((prev) => {
      const existing = prev.find(
        (f) => f.id === info.id || (f.sourceFeatureId && f.sourceFeatureId === info.sourceFeatureId)
      );
      if (existing) {
        return prev;
      }
      return [...prev, info];
    });
  };

  const handleRemoveSelectedFeature = (id: string) => {
    setSelectedFeatures((prev) => {
      const next = prev.filter((f) => f.id !== id && f.sourceFeatureId !== id);
      if (focusedFeatureId === id) {
        const remaining = next[next.length - 1] || null;
        setFocusedFeatureId(remaining ? remaining.id : null);
        setSelectedFeature(remaining);
      }
      return next;
    });
  };

  const handleClearAllSelectedFeatures = () => {
    setSelectedFeatures([]);
    setFocusedFeatureId(null);
    setSelectedFeature(null);
  };

  const handleFocusFeature = (id: string) => {
    setFocusedFeatureId(id);
    const found = selectedFeatures.find((f) => f.id === id);
    if (found) {
      setSelectedFeature(found);
    }
  };

  const handleShowAllLayers = () => {
    setShowBuildings(true);
    setShowRoads(true);
    setShowRailways(true);
    setShowWater(true);
    setShowParks(true);
    setShowLanduse(true);
    setShowBarriers(true);
    setShowFoliage(true);
  };

  const tooltipStyle = useMemo(() => {
    const maxW = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const maxH = typeof window !== 'undefined' ? window.innerHeight : 800;
    const left = Math.min(Math.max(16, hoverPos.x + 16), maxW - 310);
    const top = Math.min(Math.max(16, hoverPos.y + 16), maxH - 130);
    return {
      transform: `translate3d(${left}px, ${top}px, 0)`,
    };
  }, [hoverPos]);

  const showRestoreWorkspaceControl =
    navMode === 'hidden' && !activePanel && !isBenchmarkMode;

  return (
    <div
      data-testid="workspace-root"
      className="flex w-screen h-screen overflow-hidden bg-slate-950 font-sans text-slate-100 select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 1. LEFT NAVIGATION SIDEBAR */}
      <NavigationSidebar
        mode={navMode}
        activePanel={activePanel}
        selectedFeatureCount={selectedFeatures.length}
        hideCameraToolbar={hideCameraToolbar}
        onSelectPanel={handleSelectPanel}
        onChangeMode={handleChangeNavMode}
        onToggleImmersiveMode={handleEnterImmersiveMode}
        onToggleCameraToolbar={handleToggleCameraToolbar}
      />

      {/* 2. CENTRAL 3D MAP VIEWPORT */}
      <main
        className="relative flex-1 min-w-0 h-full overflow-hidden"
        data-testid="webgl-viewport"
        onContextMenu={(e) => e.preventDefault()}
      >
        {loading && (
          <div className="absolute inset-0 z-10 pointer-events-none flex flex-col items-center justify-center bg-slate-950/80 backdrop-blur-sm">
            <div className="w-10 h-10 border-4 border-cyan-500/20 border-t-cyan-400 rounded-full animate-spin mb-3" />
            <h2 className="text-base font-semibold tracking-wide text-slate-100">
              Loading Regional World...
            </h2>
            <p className="text-xs text-slate-400 mt-1 font-mono max-w-md text-center px-4">
              {statusMessage}
            </p>
          </div>
        )}

        {error && (
          <div
            data-testid="viewport-error-overlay"
            className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-slate-950/95 p-6 text-center"
          >
            <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-400 mb-3">
              <Info className="w-7 h-7" />
            </div>
            <h2 className="text-base font-semibold text-rose-300">
              Regional Mosaic Unavailable
            </h2>
            <p className="text-xs text-slate-300 max-w-md mt-1.5 break-words">
              {error}
            </p>
            <p className="text-[11px] font-mono text-slate-400 max-w-md mt-2">
              Verify <code className="text-slate-200">OVERIJSSEL_REGIONAL_MOSAIC_PATH</code> or bake the regional pilot with{' '}
              <code className="text-slate-200">npm run osm:bake-regional-pilot</code>.
            </p>
            <button
              type="button"
              data-testid="btn-retry-regional-mosaic"
              onClick={() =>
                void loadHengeloM2aTileStreaming(1.2, 45, false, {
                  ...DEFAULT_REGIONAL_MOSAIC_OPTIONS,
                })
              }
              className="mt-4 px-4 py-2 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-200 text-xs font-semibold rounded-md border border-cyan-500/40 cursor-pointer"
            >
              Retry Regional Mosaic
            </button>
          </div>
        )}

        {mapData && builtGeometry && (
          !webglSupported ? (
            <Fallback2DMap
              mapData={mapData}
              theme={currentTheme}
              showBuildings={showBuildings}
              showRoads={showRoads}
              showWater={showWater}
              showParks={showParks}
              heightMultiplier={heightMultiplier}
              roadWidthMultiplier={roadWidthMultiplier}
              resetSignal={resetCount}
              onRetryWebGL={() => setWebglSupported(detectWebGLSupport().supported)}
            />
          ) : (
            <ErrorBoundary
              fallback={(_err, reset) => (
                <Fallback2DMap
                  mapData={mapData}
                  theme={currentTheme}
                  showBuildings={showBuildings}
                  showRoads={showRoads}
                  showWater={showWater}
                  showParks={showParks}
                  heightMultiplier={heightMultiplier}
                  roadWidthMultiplier={roadWidthMultiplier}
                  resetSignal={resetCount}
                  onRetryWebGL={() => {
                    setWebglSupported(detectWebGLSupport().supported);
                    reset();
                  }}
                />
              )}
            >
              <Canvas
                shadows={false}
                gl={{
                  antialias: true,
                  stencil: true,
                  preserveDrawingBuffer: true,
                  powerPreference: 'high-performance',
                  outputColorSpace: THREE.SRGBColorSpace,
                  toneMapping: THREE.ACESFilmicToneMapping,
                  toneMappingExposure: 1.15,
                }}
                dpr={Math.min(window.devicePixelRatio, 2)}
              >
                <color attach="background" args={[currentTheme.groundColor]} />

                <CameraController
                  bounds={mapData.bounds}
                  resetSignal={resetCount}
                  frameRegionSignal={frameRegionCount}
                  rotateStepSignal={rotateStepCount}
                  zoomStepSignal={zoomStepCount}
                  onCameraOrientationChange={setCameraOrientation}
                  target={CAMERA_TARGET}
                  minZoom={cameraZoomPolicy.minZoom}
                  maxZoom={cameraZoomPolicy.maxZoom}
                  explicitPose={explicitPose}
                  onRegisterImperativePoseSetter={(setter) => {
                    imperativePoseSetterRef.current = setter;
                  }}
                  controlsEnabled={!isSpatialSelectActive}
                />

                <MapScene
                  builtGeometry={builtGeometry}
                  onCameraZoomChange={(z) => {
                    currentCameraZoomRef.current = z;
                    activeSceneRef.current?.updateCameraZoom?.(z);
                  }}
                  onSceneRevisionRendered={handleSceneRevisionRendered}
                  onTelemetryUpdate={(snap) => {
                    latestTelemetryRef.current = snap;
                    if ((window as any).__BENCHMARK_ACTIVE__) return;
                    const now = performance.now();
                    if (now - lastUiTelemetryTimeRef.current >= 400) {
                      lastUiTelemetryTimeRef.current = now;
                      setLiveTelemetry(snap);
                    }
                  }}
                  theme={currentTheme}
                  showBuildings={showBuildings}
                  showRoads={showRoads}
                  showRailways={showRailways}
                  showWater={showWater}
                  showParks={showParks}
                  showLanduse={showLanduse}
                  showBarriers={showBarriers}
                  showFoliage={showFoliage}
                  wireframe={wireframe}
                  trackFps={activePanel === 'performance'}
                  trackTelemetry={
                    activePanel === 'performance' ||
                    activePanel === 'diagnostics' ||
                    isBenchmarkMode
                  }
                  onFpsUpdate={setFps}
                  onHoverFeature={handleHoverFeature}
                  onSelectFeature={handleSelectFeature}
                  selectedFeature={selectedFeature}
                  selectedFeatures={selectedFeatures}
                  focusedFeatureId={focusedFeatureId}
                  selectedBoxMeters={selectedBoxMeters}
                  isSpatialSelectActive={isSpatialSelectActive}
                  onSpatialBoxChange={setSelectedBoxMeters}
                  onDeactivateSpatialSelect={() => setIsSpatialSelectActive(false)}
                  showGraphOverlay={showGraphOverlay}
                  tileBoundaryOverlayGroup={
                    isM2aStreamingActive
                      ? tileStreamManagerRef.current?.tileBoundaryOverlay ?? null
                      : m1aBoundaryOverlayRef.current?.group ?? null
                  }
                  showTileBoundaryOverlay={
                    (isM1aHarnessActive && showM1aTileBoundaries) ||
                    (isM2aStreamingActive && showM2aTileBoundaries)
                  }
                  onViewportFrameUpdate={
                    isM2aStreamingActive
                      ? (cam) => tileStreamManagerRef.current?.updateFromCamera(cam)
                      : undefined
                  }
                />
              </Canvas>
            </ErrorBoundary>
          )
        )}

        {/* Restore Workspace UI Button when Sidebar is Hidden / Immersive Mode Active */}
        {showRestoreWorkspaceControl && (
          <button
            type="button"
            data-testid="btn-restore-workspace-ui"
            onClick={handleRestoreWorkspaceUi}
            onPointerDown={(e) => e.stopPropagation()}
            title={
              hideCameraToolbar
                ? 'Restore workspace navigation and camera toolbar'
                : 'Restore workspace navigation sidebar'
            }
            className="absolute top-3 left-3 z-20 pointer-events-auto flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-slate-950/90 hover:bg-slate-900 border border-slate-800 text-xs font-medium text-slate-200 shadow-xl backdrop-blur-md transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer"
          >
            <PanelLeft className="w-3.5 h-3.5 text-cyan-400" />
            <span>{hideCameraToolbar ? 'Show UI' : 'Show Sidebar'}</span>
          </button>
        )}

        {/* Non-Intrusive Selected Feature Floating Bar (when Inspector panel is not active) */}
        {selectedFeature && activePanel !== 'inspector' && !isBenchmarkMode && (
          <div
            data-testid="viewport-selection-chip"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-16 left-3 z-20 pointer-events-auto flex items-center gap-2 bg-slate-950/92 border border-slate-800 rounded-md px-2.5 py-1.5 shadow-xl backdrop-blur-md text-xs max-w-[320px]"
          >
            <MousePointerClick className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span className="truncate text-slate-200">
              {selectedFeature.name || selectedFeature.cartoLabel || selectedFeature.id}
            </span>
            <button
              type="button"
              data-testid="btn-open-selection-inspector"
              onClick={() => handleSelectPanel('inspector')}
              className="px-2 py-0.5 rounded bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-200 text-[11px] font-medium shrink-0 cursor-pointer"
            >
              Inspect
            </button>
            <button
              type="button"
              aria-label="Clear selected feature"
              onClick={handleClearAllSelectedFeatures}
              className="p-0.5 text-slate-400 hover:text-slate-100 cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Developer-Only M1a A/B Study Harness Floating Bar (?m1a=1) */}
        {isM1aHarnessActive && m1aHarnessMetrics && (
          <div
            data-testid="m1a-visual-harness-bar"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="absolute top-3 left-1/2 -translate-x-1/2 z-20 pointer-events-auto w-[calc(100%-2rem)] max-w-[960px] bg-slate-950/95 border border-cyan-500/40 rounded-lg shadow-2xl px-3.5 py-2 backdrop-blur-md flex flex-wrap items-center justify-between gap-2 text-xs"
          >
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="px-2 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 font-mono text-[10px] font-bold uppercase">
                M1a Harness
              </span>
              <span className="text-slate-300 font-medium">
                {m1aHarnessMetrics.gridCols}×{m1aHarnessMetrics.gridRows} ({m1aHarnessMetrics.tileCount} Tiles · {m1aHarnessMetrics.tileSizeMeters}m)
              </span>
              <div className="flex items-center bg-slate-900 border border-slate-800 p-0.5 rounded-md">
                <button
                  type="button"
                  data-testid="btn-m1a-mode-tiled"
                  onClick={() => switchM1aVisualMode('tiled')}
                  className={`px-2 py-0.5 rounded text-[11px] font-semibold cursor-pointer ${
                    m1aViewMode === 'tiled'
                      ? 'bg-cyan-500 text-slate-950'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Tiled
                </button>
                <button
                  type="button"
                  data-testid="btn-m1a-mode-reference"
                  onClick={() => switchM1aVisualMode('reference')}
                  className={`px-2 py-0.5 rounded text-[11px] font-semibold cursor-pointer ${
                    m1aViewMode === 'reference'
                      ? 'bg-amber-400 text-slate-950'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Reference
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2 font-mono tabular-nums text-[11px] text-slate-400">
              <button
                type="button"
                data-testid="btn-m1a-toggle-boundaries"
                onClick={() => setShowM1aTileBoundaries((v) => !v)}
                className="px-2 py-0.5 rounded border border-slate-700 text-slate-200 hover:bg-slate-800 cursor-pointer"
              >
                Grid: {showM1aTileBoundaries ? 'ON' : 'OFF'}
              </button>
              <span>
                Tris:{' '}
                <strong className="text-slate-200">
                  {(m1aViewMode === 'tiled'
                    ? m1aHarnessMetrics.tiledTriangles
                    : m1aHarnessMetrics.referenceTriangles
                  ).toLocaleString()}
                </strong>
              </span>
            </div>
          </div>
        )}

        {/* Floating Viewport Camera Toolbar */}
        <CameraToolbar
          visible={!hideCameraToolbar && !isBenchmarkMode}
          currentZoom={cameraOrientation.zoom}
          minZoom={cameraZoomPolicy.minZoom}
          maxZoom={cameraZoomPolicy.maxZoom}
          azimuthDeg={cameraOrientation.azimuthDeg}
          onRotateLeft={() => setRotateStepCount((c) => c - 1)}
          onRotateRight={() => setRotateStepCount((c) => c + 1)}
          onZoomIn={() => setZoomStepCount((c) => c + 1)}
          onZoomOut={() => setZoomStepCount((c) => c - 1)}
          onResetCamera={handleResetCamera}
          onFrameWorld={() => setFrameRegionCount((c) => c + 1)}
          onHideToolbar={handleToggleCameraToolbar}
        />

        {/* Floating Cursor Hover Tooltip */}
        {hoveredFeature && (
          <div
            data-testid="osm-hover-tooltip"
            style={tooltipStyle}
            className="fixed top-0 left-0 z-30 pointer-events-none bg-slate-950/92 border border-slate-700/80 px-3 py-2 rounded-md shadow-2xl backdrop-blur-md max-w-[290px]"
          >
            <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-400 truncate">
              {hoveredFeature.cartoLabel} · {hoveredFeature.primaryTag}
            </div>
            <div className="text-xs font-semibold text-slate-100 truncate mt-0.5">
              {hoveredFeature.name}
            </div>
            <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-0.5 flex flex-wrap items-center gap-x-1.5">
              <span>{hoveredFeature.category}</span>
              <span>·</span>
              <span>{hoveredFeature.subtype}</span>
              {typeof hoveredFeature.height === 'number' && (
                <>
                  <span>·</span>
                  <span>{hoveredFeature.height.toFixed(1)}m H</span>
                </>
              )}
              {typeof hoveredFeature.width === 'number' && (
                <>
                  <span>·</span>
                  <span>{hoveredFeature.width.toFixed(1)}m W</span>
                </>
              )}
              {hoveredFeature.isBridge && (
                <>
                  <span>·</span>
                  <span className="text-amber-300">Bridge</span>
                </>
              )}
              {hoveredFeature.isTunnel && (
                <>
                  <span>·</span>
                  <span className="text-indigo-300">Tunnel</span>
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {/* 3. RIGHT CONTEXTUAL TOOL SIDEBAR */}
      <ContextSidebar
        activePanel={activePanel}
        onClose={() => handleSelectPanel(null)}
      >
        {activePanel === 'search' && (
          <SearchPanel
            session={searchSession}
            onUpdateSession={setSearchSession}
            activeMosaicName={activeMosaicIdentity.mosaicName}
            manifestCoverage={manifestCoverage}
            currentZoom={cameraOrientation.zoom}
            onNavigateToResult={({ worldX, worldZ, targetZoom }) => {
              const clampedZoom = clampCameraZoom(
                targetZoom,
                cameraZoomPolicy.minZoom,
                cameraZoomPolicy.maxZoom
              );
              setExplicitPose((prev) => ({
                target: [worldX, 0, worldZ],
                zoom: clampedZoom,
                signal: prev.signal + 1,
                animate: true,
              }));
            }}
          />
        )}

        {activePanel === 'layers' && (
          <LayersPanel
            isBakedTileMode={isM2aStreamingActive}
            mapData={mapData}
            builtGeometry={builtGeometry}
            showBuildings={showBuildings}
            showRoads={showRoads}
            showRailways={showRailways}
            showWater={showWater}
            showParks={showParks}
            showLanduse={showLanduse}
            showFoliage={showFoliage}
            showBarriers={showBarriers}
            onToggleBuildings={() => setShowBuildings((v) => !v)}
            onToggleRoads={() => setShowRoads((v) => !v)}
            onToggleRailways={() => setShowRailways((v) => !v)}
            onToggleWater={() => setShowWater((v) => !v)}
            onToggleParks={() => setShowParks((v) => !v)}
            onToggleLanduse={() => setShowLanduse((v) => !v)}
            onToggleFoliage={() => setShowFoliage((v) => !v)}
            onToggleBarriers={() => setShowBarriers((v) => !v)}
            onShowAllLayers={handleShowAllLayers}
          />
        )}

        {activePanel === 'appearance' && (
          <AppearancePanel
            selectedThemeId={selectedThemeId}
            onSelectTheme={setSelectedThemeId}
            isBakedTileMode={isM2aStreamingActive}
            heightMultiplier={heightMultiplier}
            roadWidthMultiplier={roadWidthMultiplier}
            bevelEnabled={bevelEnabled}
            onChangeHeightMultiplier={setHeightMultiplier}
            onChangeRoadWidthMultiplier={setRoadWidthMultiplier}
            onChangeBevelEnabled={setBevelEnabled}
          />
        )}

        {activePanel === 'inspector' && (
          <InspectorPanel
            selectedFeature={selectedFeature}
            selectedFeatures={selectedFeatures}
            focusedFeatureId={focusedFeatureId}
            isSpatialSelectActive={isSpatialSelectActive}
            selectedBoxMeters={selectedBoxMeters}
            onToggleSpatialSelect={() => setIsSpatialSelectActive((v) => !v)}
            onClearSpatialBox={() => setSelectedBoxMeters(null)}
            onSelectFeature={handleSelectFeature}
            onFocusFeature={handleFocusFeature}
            onRemoveSelectedFeature={handleRemoveSelectedFeature}
            onClearAllSelectedFeatures={handleClearAllSelectedFeatures}
          />
        )}

        {activePanel === 'performance' && (
          <PerformancePanel
            fps={fps}
            cpuBuildTimeMs={cpuBuildTimeMs}
            liveTelemetry={liveTelemetry}
            builtGeometry={builtGeometry}
            isM2aStreamingActive={isM2aStreamingActive}
            m2aStreamDiagnostics={m2aStreamDiagnostics}
            onExportBenchmarkJson={() =>
              (window as any).__M21_LAB__?.exportBenchmarkJson?.()
            }
          />
        )}

        {activePanel === 'diagnostics' && (
          <DiagnosticsPanel
            wireframe={wireframe}
            onToggleWireframe={() => setWireframe((v) => !v)}
            isBakedTileMode={isM2aStreamingActive}
            isM1aHarnessActive={isM1aHarnessActive}
            showM1aTileBoundaries={showM1aTileBoundaries}
            onToggleM1aTileBoundaries={() => setShowM1aTileBoundaries((v) => !v)}
            isM2aStreamingActive={isM2aStreamingActive}
            showM2aTileBoundaries={showM2aTileBoundaries}
            onToggleM2aTileBoundaries={() => setShowM2aTileBoundaries((v) => !v)}
            tileSizeMeters={
              m2aStreamDiagnostics?.tileSizeMeters ??
              m1aHarnessMetrics?.tileSizeMeters ??
              null
            }
            showGraphOverlay={showGraphOverlay}
            onToggleGraphOverlay={() => setShowGraphOverlay((v) => !v)}
            infrastructureRenderOptions={infrastructureRenderOptions}
            roadRenderStats={
              builtGeometry?.roadsGroup?.userData?.graphRoadStats ?? null
            }
            roadRenderTiming={
              builtGeometry?.roadsGroup?.userData?.graphRoadTiming ?? null
            }
            infrastructurePreviewTiming={infrastructureRenderPreview?.timing ?? null}
            cpuBuildTimeMs={cpuBuildTimeMs}
            lastLoadDiagnostics={
              lastMapLoadDiagnostics ??
              mapLoadTrackerRef.current.getInProgressSnapshot()
            }
            loadDiagnosticsHistory={mapLoadTrackerRef.current.getHistory()}
            liveWebGLSnapshot={liveTelemetry ?? latestTelemetryRef.current}
            activeMosaicIdentity={activeMosaicIdentity}
            cameraZoomPolicy={cameraZoomPolicy}
            mapData={mapData}
            currentRawGeoJson={currentRawGeoJson}
            currentCameraPose={{
              target: explicitPose.target,
              zoom: currentCameraZoomRef.current || explicitPose.zoom,
              azimuthDeg: cameraOrientation.azimuthDeg,
            }}
            selectedFeature={selectedFeature}
            selectedFeatures={selectedFeatures}
            focusedFeatureId={focusedFeatureId}
            selectedBoxMeters={selectedBoxMeters}
            roadWidthMultiplier={roadWidthMultiplier}
            heightMultiplier={heightMultiplier}
            themeId={selectedThemeId}
            reproForm={reproForm}
            onChangeReproForm={setReproForm}
            onImportReproductionPackage={handleImportReproductionPackage}
            foliageConfig={foliageConfig}
            onChangeFoliageConfig={handleChangeFoliageConfig}
          />
        )}

        {activePanel === 'world' && (
          <WorldPanel
            activeMosaicIdentity={activeMosaicIdentity}
            manifestCoverage={manifestCoverage}
            m2aStreamDiagnostics={m2aStreamDiagnostics}
            cameraZoomPolicy={cameraZoomPolicy}
            mapData={mapData}
            activeLocationId={activeLocationId}
            isM2aStreamingActive={isM2aStreamingActive}
            onReloadRegionalMosaic={() =>
              void loadHengeloM2aTileStreaming(1.2, 45, false, {
                ...DEFAULT_REGIONAL_MOSAIC_OPTIONS,
              })
            }
          />
        )}
      </ContextSidebar>
    </div>
  );
}
