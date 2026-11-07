import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import {
  Compass,
  RotateCcw,
  RotateCw,
  Layers,
  ChevronDown,
  ChevronUp,
  Info,
  Building2,
  Navigation,
  Waves,
  Trees,
  Cpu,
  Palette,
  Search,
  Download,
  Upload,
  Train,
  LandPlot,
  Maximize2,
  Fence,
  TreePine,
  MousePointerClick,
  X,
  Wrench,
} from 'lucide-react';
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
  ProcessedMapData,
  MapStyleTheme,
  InspectableFeatureInfo,
} from '../types/MapFeature';
import { MAP_THEMES } from '../styles/mapThemes';
import { MapScene } from '../scene/MapScene';
import { Fallback2DMap } from '../scene/Fallback2DMap';
import { CameraController } from '../scene/CameraController';
import { AddressSearchModal, GeocodeResult } from '../components/AddressSearchModal';
import { DevToolsPanel } from '../components/DevToolsPanel';
import { DeveloperReproductionPackage } from '../world/dev/ReproductionReport';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { detectWebGLSupport } from '../utils/webglCheck';
import {
  buildRailwayPrototypeGroup,
  BuildRailwayPrototypeOptions,
  BuiltRailwayPrototypeResult,
  RailwayPrototypeMode,
} from '../world/prototype/RailwayPrototypeBuilder';
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

const CAMERA_TARGET: [number, number, number] = [0, 0, 0];

export interface LivePresetLocation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radius: number;
}

export const LIVE_PRESET_LOCATIONS: LivePresetLocation[] = [
  { id: 'hengelo', name: 'Station Hengelo (Overijssel)', lat: 52.2625, lon: 6.7935, radius: 400 },
  { id: 'amsterdam', name: 'Amsterdam Centraal (Railways & Canals)', lat: 52.3791, lon: 4.9003, radius: 420 },
  { id: 'eiffel', name: 'Eiffel Tower & Seine (Paris)', lat: 48.8584, lon: 2.2945, radius: 400 },
  { id: 'colosseum', name: 'Colosseum (Rome)', lat: 41.8902, lon: 12.4922, radius: 360 },
  { id: 'towerbridge', name: 'Tower Bridge & Thames (London)', lat: 51.5055, lon: -0.0754, radius: 380 },
  { id: 'brandenburg', name: 'Brandenburg Gate (Berlin)', lat: 52.5163, lon: 13.3777, radius: 380 },
  { id: 'sydney', name: 'Sydney Opera House (Sydney)', lat: -33.8568, lon: 151.2153, radius: 380 },
];

export default function App() {
  // Map data state
  const [mapData, setMapData] = useState<ProcessedMapData | null>(null);
  const [activeLocationId, setActiveLocationId] = useState<string>('hengelo');
  const [loading, setLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState('Fetching live OpenStreetMap data...');
  const [error, setError] = useState<string | null>(null);

  // Address search & GeoJSON export
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [currentRawGeoJson, setCurrentRawGeoJson] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  //Styling & configuration
  const [selectedThemeId, setSelectedThemeId] = useState<string>('tactical');
  const [heightMultiplier, setHeightMultiplier] = useState<number>(1.0);
  const [roadWidthMultiplier, setRoadWidthMultiplier] = useState<number>(1.0);
  const [bevelEnabled, setBevelEnabled] = useState<boolean>(true);
  const [wireframe, setWireframe] = useState<boolean>(false);

  // Milestone 2.2 Production Railway state ('production' | 'candidateA' | 'candidateB' | 'disabled')
  const [railwayPrototypeMode, setRailwayPrototypeMode] =
    useState<RailwayPrototypeMode>('production');
  const [prototypeOptions, setPrototypeOptions] = useState<BuildRailwayPrototypeOptions>({
    useSpatialGridIndex: true,
    adaptiveBridgeSampling: true,
    multiIntervalClip: true,
    sleeper3DMode: 'instanced',
    spatialChunkSizeMeters: 128,
  });
  const [activePrototypeZone, setActivePrototypeZone] =
    useState<RailwayPrototypeZoneId>('overview');
  const [builtPrototypeRailways, setBuiltPrototypeRailways] =
    useState<BuiltRailwayPrototypeResult | null>(null);
  const activePrototypeRef = useRef<BuiltRailwayPrototypeResult | null>(null);
  const currentCameraZoomRef = useRef<number>(1.0);
  const latestTelemetryRef = useRef<LiveWebGLTelemetrySnapshot | null>(null);

  // Milestone 2.3 Stage E1 independent graph-to-renderer preview switches (default 'legacy')
  const [infrastructureRenderOptions, setInfrastructureRenderOptions] =
    useState<InfrastructureRenderOptions>(() =>
      typeof window !== 'undefined'
        ? parseInfrastructureRenderOptionsFromSearch(window.location.search)
        : { ...DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS }
    );

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
  const [explicitPose, setExplicitPose] = useState<{
    target: [number, number, number];
    zoom: number;
    azimuthRad?: number;
    signal: number;
  }>({
    target: [0, 0, 0],
    zoom: 1.0,
    signal: 0,
  });

  // Universal OSM Feature Hover Tooltip & Click Inspector
  const [hoveredFeature, setHoveredFeature] = useState<InspectableFeatureInfo | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [selectedFeature, setSelectedFeature] = useState<InspectableFeatureInfo | null>(null);
  const [selectedFeatures, setSelectedFeatures] = useState<InspectableFeatureInfo[]>([]);
  const [focusedFeatureId, setFocusedFeatureId] = useState<string | null>(null);

  // Developer Tools Interface State
  const [isDevToolsOpen, setIsDevToolsOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const p = new URLSearchParams(window.location.search);
    return p.get('devtools') === 'true' || p.get('devtools') === '1';
  });
  const [showGraphOverlay, setShowGraphOverlay] = useState<boolean>(false);
  const [isSpatialSelectActive, setIsSpatialSelectActive] = useState<boolean>(false);
  const [selectedBoxMeters, setSelectedBoxMeters] = useState<{
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  } | null>(null);

  const [isDockCollapsed, setIsDockCollapsed] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'layers' | 'inspector' | 'style' | 'stats' | 'info'>('layers');

  // Performance stats & M2.1 telemetry
  const [fps, setFps] = useState<number>(60);
  const [cpuBuildTimeMs, setCpuBuildTimeMs] = useState<number>(0);
  const [liveTelemetry, setLiveTelemetry] = useState<LiveWebGLTelemetrySnapshot | null>(null);
  const lastUiTelemetryTimeRef = useRef<number>(0);
  const [webglSupported, setWebglSupported] = useState<boolean>(() => detectWebGLSupport().supported);

  // Provider instances for data loading abstraction
  const osmApiProvider = useMemo(() => new OsmApiProvider(), []);
  const localProvider = useMemo(() => new LocalGeoJsonProvider(), []);

  // Built scene geometry reference for cleanup and in-place material updates
  const [builtGeometry, setBuiltGeometry] = useState<BuiltSceneGeometry | null>(null);
  const activeSceneRef = useRef<BuiltSceneGeometry | null>(null);

  const loadSwitchyardFixture = (
    targetZone: RailwayPrototypeZoneId = 'overview',
    overrideZoom?: number,
    overrideAzimuthDeg?: number
  ) => {
    setLoading(true);
    setError(null);
    setHoveredFeature(null);
    setSelectedFeature(null);
    setActiveLocationId('m21_switchyard');
    const fixtureData = createRailwayPrototypeFixtureData();
    setCurrentRawGeoJson(null);
    setMapData(fixtureData);
    setLoading(false);

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

  // Tiny source-grounded E2 repro: three cycleways at southern node/6387677253.
  // No background network call, railway prototype scene, or separate renderer.
  const loadPrinsHendrikkadeForkFixture = (
    overrideZoom?: number,
    overrideAzimuthDeg?: number
  ) => {
    setLoading(true);
    setError(null);
    setHoveredFeature(null);
    setSelectedFeature(null);
    setActiveLocationId('m23_prins_fork');
    try {
      const data = localProvider.parseGeoJson(
        prinsHendrikkadeForkFixture,
        'M2.3-E2 Junction Lab · Prins Hendrikkade South',
        [4.8979247, 52.3773823],
        60
      );
      setCurrentRawGeoJson(prinsHendrikkadeForkFixture);
      setMapData(data);
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
    } finally {
      setLoading(false);
    }
  };

  const loadLiveHengeloPreset = async (
    target: [number, number, number] = [0, 0, 0],
    zoom: number = 1.0,
    azimuthDeg: number = 45
  ) => {
    setActiveLocationId('hengelo');
    await fetchLiveOsmLocation(LIVE_PRESET_LOCATIONS[0]);
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
    azimuthDeg: number = 45
  ) => {
    setActiveLocationId('amsterdam');
    await fetchLiveOsmLocation(LIVE_PRESET_LOCATIONS[1]);
    setExplicitPose((prev) => ({
      target,
      zoom,
      azimuthRad: (azimuthDeg * Math.PI) / 180,
      signal: prev.signal + 1,
    }));
  };

  const handleImportReproductionPackage = (pkg: DeveloperReproductionPackage) => {
    setLoading(true);
    setError(null);
    setHoveredFeature(null);
    setSelectedFeature(null);
    setActiveLocationId(`repro_${Date.now()}`);

    try {
      const defaultCenter: [number, number] = [4.897, 52.377];
      const parsedData = localProvider.parseGeoJson(
        pkg.geoJson,
        pkg.report?.title || 'Imported Reproduction Scenario',
        defaultCenter
      );

      setCurrentRawGeoJson(pkg.geoJson);
      setMapData(parsedData);

      if (pkg.configuration?.infrastructureRenderOptions) {
        setInfrastructureRenderOptions(
          normalizeInfrastructureRenderOptions(pkg.configuration.infrastructureRenderOptions)
        );
      }
      if (pkg.configuration?.railwayPrototypeMode) {
        setRailwayPrototypeMode(pkg.configuration.railwayPrototypeMode);
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

      // Restore spatial area bounding box
      if (pkg.selectedArea?.spatialBoxMeters) {
        setSelectedBoxMeters(pkg.selectedArea.spatialBoxMeters);
      } else if ((pkg as any).selectedBoxMeters) {
        setSelectedBoxMeters((pkg as any).selectedBoxMeters);
      } else {
        setSelectedBoxMeters(null);
      }

      // Restore selected objects
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
          portalConnections: obj.incidentOsmIds?.map((osmId) => ({
            roadFeatureId: osmId,
            sourceFeatureId: osmId,
            endpoint: 'start' as const,
            left: [0, 0] as [number, number],
            right: [0, 0] as [number, number],
          })),
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

      setIsDevToolsOpen(true);
      setStatusMessage(`Loaded reproduction: ${pkg.report?.title || 'Imported Scenario'}`);
    } catch (err: any) {
      console.error('Failed to import reproduction package:', err);
      setError(`Failed to import reproduction package: ${err.message}`);
    } finally {
      setLoading(false);
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

  // Function to load any real-world coordinates through MapDataProvider abstraction
  const fetchLiveOsmLocation = async (loc: { name: string; lat: number; lon: number; radius: number }) => {
    setLoading(true);
    setError(null);
    setHoveredFeature(null);
    setSelectedFeature(null);
    setStatusMessage(`Retrieving real OpenStreetMap data for ${loc.name}...`);
    try {
      const parsedData = await osmApiProvider.loadRegion({
        centerLat: loc.lat,
        centerLon: loc.lon,
        radiusMeters: loc.radius,
        locationName: loc.name,
      });

      setCurrentRawGeoJson(osmApiProvider.getLastRawGeoJson());
      setMapData(parsedData);
      setLoading(false);
      setResetCount((c) => c + 1);

      // Log development-only diagnostics to console
      if (parsedData.diagnostics) {
        console.group(`🗺️ OpenStreetMap Diagnostics [${loc.name}]`);
        console.table({
          'Source Features Received': parsedData.diagnostics.sourceFeaturesReceived,
          'Features Classified': parsedData.diagnostics.sourceFeaturesClassified,
          'Valid Features Parsed': parsedData.diagnostics.totalFeaturesParsed,
          'Geometry Parts Generated': parsedData.diagnostics.geometryPartsGenerated.total,
          'Features Rendered': parsedData.diagnostics.sourceFeaturesRendered,
          'Scene Meshes Built': parsedData.diagnostics.constructedMeshesCount,
          'Buildings': parsedData.diagnostics.parsedByCategory.buildings,
          'Roads': parsedData.diagnostics.parsedByCategory.roads,
          'Railways': parsedData.diagnostics.parsedByCategory.railways,
          'Water Bodies': parsedData.diagnostics.parsedByCategory.waterBodies,
          'Linear Waterways': parsedData.diagnostics.parsedByCategory.linearWaterways,
          'Parks & Nature': parsedData.diagnostics.parsedByCategory.parks,
          'Landuse & Civic': parsedData.diagnostics.parsedByCategory.landuse,
          'Barriers & Walls': parsedData.diagnostics.parsedByCategory.barriers || 0,
          '3D Landmarks & Trees': parsedData.diagnostics.parsedByCategory.landmarks || 0,
          'Skipped (Unsupported)': parsedData.diagnostics.skippedUnsupported.total,
          'Rejected (Invalid)': parsedData.diagnostics.rejectedInvalid.total,
        });
        console.groupEnd();
      }
    } catch (err: any) {
      console.error('Failed to load real OSM region:', err);
      setError(err.message);
      setLoading(false);
    }
  };

  // Initial load: Check URL query parameters for M2.1 Prototype Lab or fetch Station Hengelo
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const protoParam = params.get('prototype') as RailwayPrototypeMode | null;
    if (
      protoParam === 'disabled' ||
      protoParam === 'production' ||
      protoParam === 'candidateA' ||
      protoParam === 'candidateB'
    ) {
      setRailwayPrototypeMode(protoParam);
    } else if ((protoParam as string) === 'baseline') {
      setRailwayPrototypeMode('production');
    }
    // The isolated junction lab is specifically for E2 graph-road visuals.
    // Keep an explicit topologyRoads query value authoritative for A/B comparison.
    const isForkFixture = params.get('fixture') === 'prins-fork';
    setInfrastructureRenderOptions(
      isForkFixture && !params.has('topologyRoads')
        ? { roads: 'graph', railways: 'legacy' }
        : parseInfrastructureRenderOptionsFromSearch(window.location.search)
    );
    const themeParam = params.get('theme');
    if (themeParam && MAP_THEMES[themeParam]) {
      setSelectedThemeId(themeParam);
    }
    const tabParam = params.get('tab');
    if (
      tabParam === 'layers' ||
      tabParam === 'inspector' ||
      tabParam === 'style' ||
      tabParam === 'stats' ||
      tabParam === 'info'
    ) {
      setActiveTab(tabParam);
    }
    const dockParam = params.get('dock');
    if (dockParam === 'collapsed') {
      setIsDockCollapsed(true);
    }

    const fixtureParam = params.get('fixture');
    const zoneParam = (params.get('zone') as RailwayPrototypeZoneId) || 'overview';
    const zoomParam = params.get('zoom') ? parseFloat(params.get('zoom')!) : undefined;
    const azParam = params.get('azimuth') ? parseFloat(params.get('azimuth')!) : undefined;

    if (fixtureParam === 'switchyard') {
      loadSwitchyardFixture(zoneParam, zoomParam, azParam);
    } else if (fixtureParam === 'prins-fork') {
      loadPrinsHendrikkadeForkFixture(zoomParam, azParam);
    } else if (fixtureParam === 'amsterdam') {
      loadLiveAmsterdamPreset([0, 0, 0], zoomParam ?? 1.0, azParam ?? 45);
    } else if (fixtureParam === 'hengelo') {
      loadLiveHengeloPreset([0, 0, 0], zoomParam ?? 1.0, azParam ?? 45);
    } else {
      fetchLiveOsmLocation(LIVE_PRESET_LOCATIONS[0]);
    }
  }, []);

  const currentTheme: MapStyleTheme = useMemo(() => {
    return MAP_THEMES[selectedThemeId] || MAP_THEMES.tactical;
  }, [selectedThemeId]);

  const useProductionSceneRailways =
    railwayPrototypeMode === 'production' || (railwayPrototypeMode as string) === 'baseline';

  // Milestone 2.3-E1: Build one shared InfrastructureGraph + render descriptor bundle per dataset
  // when either road or railway preview mode is active; completely skipped in default 'legacy' mode.
  const infrastructureRenderPreview = useMemo(() => {
    if (!mapData || !requiresInfrastructureGraphPreview(infrastructureRenderOptions)) {
      return null;
    }
    return prepareInfrastructureRenderPreview(mapData, infrastructureRenderOptions);
  }, [mapData, infrastructureRenderOptions.roads, infrastructureRenderOptions.railways]);

  // Generate 3D Scene Geometries when geometric parameters or railway mode change.
  // When railwayPrototypeMode is 'candidateA', 'candidateB', or 'disabled', pass railways: []
  // to GeometryBuilder so the non-railway map is 100% identical and railway bridges are never duplicated.
  useEffect(() => {
    if (!mapData) return;

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

    const sceneData: ProcessedMapData = useProductionSceneRailways
      ? mapData
      : {
          ...mapData,
          railways: [],
          diagnostics: mapData.diagnostics
            ? {
                ...mapData.diagnostics,
                geometryPartsGenerated: { ...mapData.diagnostics.geometryPartsGenerated },
                skippedUnsupported: {
                  ...mapData.diagnostics.skippedUnsupported,
                  byTag: { ...mapData.diagnostics.skippedUnsupported.byTag },
                },
                rejectedInvalid: {
                  ...mapData.diagnostics.rejectedInvalid,
                  byReason: { ...mapData.diagnostics.rejectedInvalid.byReason },
                },
              }
            : undefined!,
        };

    const t0 = performance.now();
    const scene = builder.buildScene(sceneData, currentTheme);
    setCpuBuildTimeMs(Number((performance.now() - t0).toFixed(2)));
    activeSceneRef.current = scene;
    setBuiltGeometry(scene);
  }, [
    mapData,
    heightMultiplier,
    roadWidthMultiplier,
    bevelEnabled,
    useProductionSceneRailways,
    infrastructureRenderOptions,
    infrastructureRenderPreview,
  ]);

  // Build or dispose the isolated M2.1 Railway Prototype group when mode, options, or mapData changes
  useEffect(() => {
    if (activePrototypeRef.current) {
      activePrototypeRef.current.dispose();
      activePrototypeRef.current = null;
    }
    if (
      !mapData ||
      railwayPrototypeMode === 'production' ||
      (railwayPrototypeMode as string) === 'baseline' ||
      railwayPrototypeMode === 'disabled'
    ) {
      setBuiltPrototypeRailways(null);
      return;
    }
    const proto = buildRailwayPrototypeGroup(
      mapData,
      currentTheme,
      railwayPrototypeMode,
      currentCameraZoomRef.current,
      prototypeOptions
    );
    activePrototypeRef.current = proto;
    setBuiltPrototypeRailways(proto);
  }, [mapData, railwayPrototypeMode, prototypeOptions]);


  // Separate material theme updates from geometry regeneration (zero GPU re-allocations)
  useEffect(() => {
    if (activeSceneRef.current) {
      activeSceneRef.current.updateTheme(currentTheme);
    }
    if (activePrototypeRef.current) {
      activePrototypeRef.current.updateTheme(currentTheme);
    }
  }, [currentTheme]);

  // Clean unmount disposal
  useEffect(() => {
    return () => {
      if (activePrototypeRef.current) {
        activePrototypeRef.current.dispose();
        activePrototypeRef.current = null;
      }
      if (activeSceneRef.current) {
        activeSceneRef.current.dispose();
        activeSceneRef.current = null;
      }
    };
  }, []);

  // Expose deterministic M2.1 Prototype Lab API on window for automated Playwright inspection
  useEffect(() => {
    const railStats =
      railwayPrototypeMode === 'disabled'
        ? {
            meshCount: 0,
            visibleMeshCount: 0,
            vertexCount: 0,
            triangleCount: 0,
            renderedVerticesWithInstances: 0,
            renderedTrianglesWithInstances: 0,
            visibleRenderedTriangles: 0,
            cpuBufferBytes: 0,
            cpuBufferMB: 0,
          }
        : builtPrototypeRailways
          ? computeGroupGeometryStats(builtPrototypeRailways.railwaysGroup)
          : builtGeometry
            ? computeGroupGeometryStats(builtGeometry.railwaysGroup)
            : null;
    const cpuMem = builtGeometry?.resources.getCpuBufferMemoryStats() || null;
    const protoCpuBytes = builtPrototypeRailways?.stats.cpuBufferBytes ?? 0;
    const totalCpuBufferMB = Number(
      (((cpuMem?.totalBytes ?? 0) + protoCpuBytes) / (1024 * 1024)).toFixed(3)
    );
    const totalSceneVertices =
      (builtGeometry?.stats.totalVertices ?? 0) +
      (builtPrototypeRailways?.stats.renderedVerticesWithInstances ?? 0);
    const totalSceneTriangles =
      (builtGeometry?.stats.totalTriangles ?? 0) +
      (builtPrototypeRailways?.stats.renderedTrianglesWithInstances ?? 0);
    const totalSceneMeshes =
      (builtGeometry?.stats.totalDrawCalls ?? 0) +
      (builtPrototypeRailways?.stats.drawCalls ?? 0);

    (window as any).__M21_LAB__ = {
      setMode: (mode: RailwayPrototypeMode) => setRailwayPrototypeMode(mode),
      setInfrastructureRenderOptions: (opts: Partial<InfrastructureRenderOptions>) =>
        setInfrastructureRenderOptions((prev) =>
          normalizeInfrastructureRenderOptions({ ...prev, ...opts })
        ),
      getInfrastructureRenderOptions: () => infrastructureRenderOptions,
      getInfrastructureRenderPreview: () => infrastructureRenderPreview,
      setPrototypeOptions: (opts: Partial<BuildRailwayPrototypeOptions>) =>
        setPrototypeOptions((prev) => ({ ...prev, ...opts })),
      getPrototypeOptions: () => prototypeOptions,
      setTheme: (themeId: string) => setSelectedThemeId(themeId),
      setDockCollapsed: (collapsed: boolean) => setIsDockCollapsed(collapsed),
      setActiveTab: (tab: 'layers' | 'inspector' | 'style' | 'stats' | 'info') =>
        setActiveTab(tab),
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
      setCameraPose: (
        target: [number, number, number],
        zoom: number,
        azimuthDeg?: number
      ) => {
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
      getSnapshot: () => ({
        locationId: activeLocationId,
        regionName: mapData?.regionName,
        prototypeMode: railwayPrototypeMode,
        infrastructureRenderOptions,
        infrastructurePreviewStats: infrastructureRenderPreview
          ? {
              graphBuildTimeMs: infrastructureRenderPreview.timing.graphBuildTimeMs,
              adapterBuildTimeMs: infrastructureRenderPreview.timing.adapterBuildTimeMs,
              validationTimeMs: infrastructureRenderPreview.timing.validationTimeMs,
              totalPreviewTimeMs: infrastructureRenderPreview.timing.totalPreviewTimeMs,
              isValid: infrastructureRenderPreview.validation?.isValid ?? false,
              roadEdgeCount: infrastructureRenderPreview.validation?.roadEdgeCount ?? 0,
              roadNodeCount: infrastructureRenderPreview.validation?.roadNodeCount ?? 0,
              railwayEdgeCount: infrastructureRenderPreview.validation?.railwayEdgeCount ?? 0,
              railwayNodeCount: infrastructureRenderPreview.validation?.railwayNodeCount ?? 0,
            }
          : null,
        prototypeOptions,
        activeZone: activePrototypeZone,
        themeId: selectedThemeId,
        cpuBuildTimeMs,
        prototypeBuildTimeMs: builtPrototypeRailways?.stats.buildTimeMs ?? null,
        prototypeBuildProfile: builtPrototypeRailways?.profile ?? null,
        constructedMeshesCount: totalSceneMeshes,
        sceneVertices: totalSceneVertices,
        sceneTriangles: totalSceneTriangles,
        cpuBufferMB: totalCpuBufferMB,
        railwayGroupStats: railStats,
        liveWebGL: latestTelemetryRef.current || liveTelemetry,
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

        // Warm up 1 frame after pose/mode change
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

          // Tick 1: allow React to commit explicitPose and CameraController useEffect to update ortho.zoom & position
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          // Tick 2: measure actual rendered frame interval for the updated camera pose
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
            hardwareConcurrency: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null,
            gpuVendor: snap?.liveWebGL?.gpuVendor ?? 'Unknown',
            gpuRenderer: snap?.liveWebGL?.gpuRenderer ?? 'Software GL / WebGL2 (SwiftShader)',
            canvasWidth: snap?.liveWebGL?.canvasWidth ?? window.innerWidth,
            canvasHeight: snap?.liveWebGL?.canvasHeight ?? window.innerHeight,
          },
          ...snap,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
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
        mode: RailwayPrototypeMode,
        themeId: string,
        zone: RailwayPrototypeZoneId,
        zoom: number,
        dockCollapsed: boolean = true
      ) =>
        new Promise<string | null>((resolve) => {
          setRailwayPrototypeMode(mode);
          setSelectedThemeId(themeId);
          setIsDockCollapsed(dockCollapsed);
          if (!dockCollapsed) {
            setActiveTab('stats');
          }
          jumpToPrototypeZone(zone, zoom);
          setTimeout(() => {
            const canvas = document.querySelector('canvas');
            resolve(canvas ? canvas.toDataURL('image/png') : null);
          }, 450);
        }),
    };
  }, [
    activeLocationId,
    mapData,
    railwayPrototypeMode,
    infrastructureRenderOptions,
    infrastructureRenderPreview,
    prototypeOptions,
    activePrototypeZone,
    selectedThemeId,
    cpuBuildTimeMs,
    builtGeometry,
    builtPrototypeRailways,
    liveTelemetry,
  ]);

  const handleResetCamera = () => {
    setResetCount((c) => c + 1);
  };

  const handlePresetSelect = (preset: LivePresetLocation) => {
    setActiveLocationId(preset.id);
    fetchLiveOsmLocation(preset);
  };

  const handleSelectAddress = async (location: GeocodeResult, radiusMeters: number) => {
    setActiveLocationId('custom');
    await fetchLiveOsmLocation({
      name: location.name,
      lat: location.lat,
      lon: location.lon,
      radius: radiusMeters,
    });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);
    setStatusMessage(`Parsing uploaded GeoJSON file ${file.name}...`);
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const json = JSON.parse(text);
        setCurrentRawGeoJson(json);
        const data = localProvider.parseGeoJson(json, file.name);
        setMapData(data);
        setActiveLocationId('custom');
        setLoading(false);
        setResetCount((c) => c + 1);
      } catch (err: any) {
        console.error('Failed to parse uploaded GeoJSON:', err);
        setError(`Failed to parse uploaded GeoJSON: ${err.message}`);
        setLoading(false);
      }
    };
    reader.onerror = () => {
      setError('Failed to read selected file');
      setLoading(false);
    };
    reader.readAsText(file);
  };

  const handleDownloadCurrentGeoJson = () => {
    if (!currentRawGeoJson) return;
    const blob = new Blob([JSON.stringify(currentRawGeoJson, null, 2)], {
      type: 'application/geo+json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(currentRawGeoJson.name || mapData?.regionName || 'osm-map-region').toLowerCase().replace(/[^a-z0-9]/g, '-')}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
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
    setActiveTab('inspector');
    setIsDockCollapsed(false);
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

  // Clamp floating cursor tooltip inside viewport bounds
  const tooltipStyle = useMemo(() => {
    const maxW = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const maxH = typeof window !== 'undefined' ? window.innerHeight : 800;
    const left = Math.min(Math.max(16, hoverPos.x + 16), maxW - 310);
    const top = Math.min(Math.max(16, hoverPos.y + 16), maxH - 130);
    return {
      transform: `translate3d(${left}px, ${top}px, 0)`,
    };
  }, [hoverPos]);

  return (
    <div
      className="relative w-screen h-screen overflow-hidden bg-slate-950 font-sans text-slate-100 select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 3D WebGL Viewport */}
      <div
        className="absolute inset-0"
        data-testid="webgl-viewport"
        onContextMenu={(e) => e.preventDefault()}
      >
        {loading && (
          <div className="absolute inset-0 z-10 pointer-events-none flex flex-col items-center justify-center bg-slate-950/80 backdrop-blur-sm">
            <div className="w-12 h-12 border-4 border-cyan-500/20 border-t-cyan-400 rounded-full animate-spin mb-4" />
            <h2 className="text-xl font-semibold tracking-wide text-slate-100">
              Generating 3D City Geometry...
            </h2>
            <p className="text-sm text-slate-400 mt-1 font-mono">
              {statusMessage}
            </p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-slate-950/95 p-6 text-center">
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 mb-3">
              <Info className="w-8 h-8" />
            </div>
            <h2 className="text-lg font-semibold text-red-300">Map Ingestion Error</h2>
            <p className="text-sm text-slate-400 max-w-md mt-1">{error}</p>
            <button
              type="button"
              onClick={() => fetchLiveOsmLocation(LIVE_PRESET_LOCATIONS[0])}
              className="mt-4 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 cursor-pointer"
            >
              Retry Default Location
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
                shadows
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
                  target={CAMERA_TARGET}
                  minZoom={0.15}
                  maxZoom={16.0}
                  explicitPose={explicitPose}
                  controlsEnabled={!isSpatialSelectActive}
                />

                <MapScene
                  builtGeometry={builtGeometry}
                  railwayGroupOverride={
                    railwayPrototypeMode === 'disabled'
                      ? null
                      : builtPrototypeRailways?.railwaysGroup || null
                  }
                  onCameraZoomChange={(z) => {
                    currentCameraZoomRef.current = z;
                    activeSceneRef.current?.updateCameraZoom?.(z);
                    activePrototypeRef.current?.updateCameraZoom(z);
                  }}
                  onTelemetryUpdate={(snap) => {
                    latestTelemetryRef.current = snap;
                    const now = performance.now();
                    if (now - lastUiTelemetryTimeRef.current >= 400) {
                      lastUiTelemetryTimeRef.current = now;
                      setLiveTelemetry(snap);
                    }
                  }}
                  theme={currentTheme}
                  showBuildings={showBuildings}
                  showRoads={showRoads}
                  showRailways={showRailways && railwayPrototypeMode !== 'disabled'}
                  showWater={showWater}
                  showParks={showParks}
                  showLanduse={showLanduse}
                  showBarriers={showBarriers}
                  showFoliage={showFoliage}
                  wireframe={wireframe}
                  trackFps={activeTab === 'stats'}
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
                />
              </Canvas>
            </ErrorBoundary>
          )
        )}
      </div>

      {/* Hidden file input for custom GeoJSON */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileUpload}
        accept=".geojson,.json"
        className="hidden"
        aria-label="Upload custom GeoJSON file"
      />

      {/* TOP HEADER: Dynamic Live Location Title, Search, and Controls */}
      <header className="absolute top-4 left-4 right-4 z-20 flex flex-wrap items-center justify-between gap-3 pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-3 bg-slate-900/90 border border-slate-800/80 px-4 py-2.5 rounded-xl shadow-2xl backdrop-blur-md">
          <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 font-bold shrink-0">
            <Compass className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold tracking-tight text-slate-100">
                Real-World 3D Map Viewer
              </h1>
              <span className="text-[10px] font-mono text-emerald-400">
                · Live OSM Carto
              </span>
            </div>
            <p className="text-xs text-slate-400 font-medium">
              {mapData?.regionName || 'Loading location...'}
              {mapData && (
                <span className="font-mono tabular-nums text-[10px] text-slate-500 ml-1.5">
                  ({mapData.centerLonLat[1].toFixed(4)}°, {mapData.centerLonLat[0].toFixed(4)}°)
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Global Search, Preset Switcher & Navigation Actions */}
        <div className="pointer-events-auto flex items-center gap-2">
          {/* Search by Address Modal Trigger */}
          <button
            type="button"
            onClick={() => setIsSearchOpen(true)}
            title="Search any real-world address or landmark worldwide"
            className="flex items-center gap-1.5 px-3 py-2 bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold rounded-xl shadow-lg shadow-cyan-950/40 transition active:scale-95 cursor-pointer"
          >
            <Search className="w-3.5 h-3.5" />
            <span>Search Address</span>
          </button>

          {/* Quick Real OSM Destinations + M2.1 Switchyard Lab */}
          <div className="hidden lg:flex items-center bg-slate-900/90 border border-slate-800/80 p-1 rounded-xl shadow-xl backdrop-blur-md gap-1">
            {LIVE_PRESET_LOCATIONS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => handlePresetSelect(preset)}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg transition cursor-pointer ${
                  activeLocationId === preset.id
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                {preset.name.split('(')[0].trim()}
              </button>
            ))}
            <button
              type="button"
              data-testid="btn-m21-switchyard"
              onClick={() => loadSwitchyardFixture('overview')}
              className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg transition cursor-pointer ${
                activeLocationId === 'm21_switchyard'
                  ? 'bg-purple-500/25 text-purple-200 border border-purple-400/50'
                  : 'text-purple-300 hover:text-purple-100 hover:bg-purple-950/50'
              }`}
              title="Load M2.1 Railway Switchyard & Station Throat Prototype Benchmark"
            >
              M2.1 Switchyard Lab
            </button>
          </div>

          {/* Upload GeoJSON file */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Upload any OpenStreetMap GeoJSON file from your computer"
            className="flex items-center gap-1.5 px-2.5 py-2 bg-slate-900/90 hover:bg-slate-800 border border-slate-700/70 text-slate-300 text-xs font-medium rounded-xl shadow-lg transition active:scale-95 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden sm:inline">Upload GeoJSON</span>
          </button>

          {/* Export Current GeoJSON */}
          {currentRawGeoJson && (
            <button
              type="button"
              onClick={handleDownloadCurrentGeoJson}
              title="Export and download current region as GeoJSON"
              className="flex items-center gap-1.5 px-2.5 py-2 bg-slate-900/90 hover:bg-slate-800 border border-slate-700/70 text-slate-200 text-xs font-medium rounded-xl shadow-lg transition active:scale-95 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-cyan-400" />
              <span className="hidden sm:inline">Export GeoJSON</span>
            </button>
          )}

          {/* Camera Rotation & Reset Controls */}
          <div className="flex items-center bg-slate-900/90 border border-slate-800/80 p-1 rounded-xl shadow-xl backdrop-blur-md gap-1">
            <button
              type="button"
              onClick={() => setRotateStepCount((c) => c - 1)}
              aria-label="Rotate view counter-clockwise 45 degrees"
              title="Rotate Left 45°"
              className="p-1.5 text-slate-300 hover:text-cyan-400 hover:bg-slate-800/80 rounded-lg transition active:scale-95 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => setRotateStepCount((c) => c + 1)}
              aria-label="Rotate view clockwise 45 degrees"
              title="Rotate Right 45°"
              className="p-1.5 text-slate-300 hover:text-cyan-400 hover:bg-slate-800/80 rounded-lg transition active:scale-95 cursor-pointer"
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>

            <div className="w-px h-4 bg-slate-800 mx-0.5" />

            <button
              type="button"
              onClick={() => setFrameRegionCount((c) => c + 1)}
              aria-label="Frame the entire loaded region in view"
              title="Fit View to Region Bounds"
              className="flex items-center gap-1 px-2 py-1 text-slate-200 hover:text-cyan-300 hover:bg-slate-800/80 text-xs font-medium rounded-lg transition active:scale-95 cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5 text-cyan-400" />
              <span>Frame Region</span>
            </button>

            <button
              type="button"
              onClick={handleResetCamera}
              aria-label="Reset camera view to initial position"
              title="Reset View to Center"
              className="flex items-center gap-1 px-2 py-1 text-slate-200 hover:text-cyan-300 hover:bg-slate-800/80 text-xs font-medium rounded-lg transition active:scale-95 cursor-pointer"
            >
              <Compass className="w-3.5 h-3.5 text-cyan-400" />
              <span>Reset</span>
            </button>
          </div>

          {/* Dev Tools Toggle Button */}
          <button
            type="button"
            data-testid="btn-toggle-devtools"
            onClick={() => setIsDevToolsOpen((v) => !v)}
            title="Open Developer Tools (Rendering controls, geometry inspection, issue reporting & fixtures)"
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl shadow-lg transition active:scale-95 cursor-pointer ${
              isDevToolsOpen
                ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold border border-amber-300'
                : 'bg-slate-900/90 hover:bg-slate-800 border border-slate-700/80 text-amber-300'
            }`}
          >
            <Wrench className="w-3.5 h-3.5" />
            <span>Dev Tools</span>
            {showGraphOverlay && (
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse ml-0.5" />
            )}
          </button>
        </div>
      </header>

      {/* FLOATING CURSOR TOOLTIP FOR ANY HOVERED OSM FEATURE */}
      {hoveredFeature && (
        <div
          data-testid="osm-hover-tooltip"
          style={tooltipStyle}
          className="fixed top-0 left-0 z-30 pointer-events-none bg-slate-950/92 border border-slate-700/80 px-3.5 py-2.5 rounded-lg shadow-2xl backdrop-blur-md max-w-[290px]"
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
            {hoveredFeature.levels && (
              <>
                <span>·</span>
                <span>{hoveredFeature.levels} fl</span>
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
          <div className="text-[10px] text-slate-500 mt-1">
            Click to inspect all {Object.keys(hoveredFeature.osmTags || {}).length} OSM tags
          </div>
        </div>
      )}

      {/* BOTTOM CONTROL DOCK */}
      <footer className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20 w-[95vw] max-w-[960px] pointer-events-none">
        <div className="flex flex-col items-center">
          {/* Collapse / Expand Toggle Button */}
          <button
            type="button"
            onClick={() => setIsDockCollapsed((c) => !c)}
            aria-label={isDockCollapsed ? 'Expand control dock' : 'Collapse control dock'}
            className="pointer-events-auto mb-1.5 px-3 py-1 bg-slate-900/90 hover:bg-slate-800 border border-slate-800 rounded-full text-slate-300 text-xs font-medium flex items-center gap-1.5 shadow-xl transition cursor-pointer"
          >
            {isDockCollapsed ? (
              <>
                <ChevronUp className="w-3.5 h-3.5 text-cyan-400" />
                <span>Show Controls</span>
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5 text-cyan-400" />
                <span>Hide Controls</span>
              </>
            )}
          </button>

          {/* Main Control Surface */}
          {!isDockCollapsed && (
            <div className="pointer-events-auto w-full bg-slate-900/95 border border-slate-800 rounded-2xl shadow-2xl p-4 backdrop-blur-md">
              {/* Tabs Navigation */}
              <div className="flex flex-wrap items-center justify-between border-b border-slate-800/80 pb-3 mb-3 gap-2">
                <nav className="flex flex-wrap items-center gap-1" aria-label="Control dock tabs">
                  <button
                    type="button"
                    onClick={() => setActiveTab('layers')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition cursor-pointer ${
                      activeTab === 'layers'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                    }`}
                  >
                    <Layers className="w-3.5 h-3.5" />
                    <span>Map Layers</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('inspector')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition cursor-pointer ${
                      activeTab === 'inspector'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                    }`}
                  >
                    <MousePointerClick className="w-3.5 h-3.5" />
                    <span>
                      Feature Inspector
                      {selectedFeature ? ` · ${selectedFeature.cartoLabel}` : ''}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('style')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition cursor-pointer ${
                      activeTab === 'style'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                    }`}
                  >
                    <Palette className="w-3.5 h-3.5" />
                    <span>Styling & Scale</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('stats')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition cursor-pointer ${
                      activeTab === 'stats'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                    }`}
                  >
                    <Cpu className="w-3.5 h-3.5" />
                    <span>Performance ({fps} FPS)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('info')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition cursor-pointer ${
                      activeTab === 'info'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                    }`}
                  >
                    <Info className="w-3.5 h-3.5" />
                    <span>OSM Diagnostics</span>
                  </button>
                </nav>

                {/* Navigation Hints */}
                <div className="hidden md:flex items-center gap-2 text-[11px] text-slate-400 font-mono">
                  <span>Hover: Tooltip</span>
                  <span>·</span>
                  <span>Click: Inspect</span>
                  <span>·</span>
                  <span>Pan: Left-Drag</span>
                  <span>·</span>
                  <span>Orbit: Right-Drag</span>
                </div>
              </div>

              {/* Tab 1: Map Layers */}
              {activeTab === 'layers' && (
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
                  <button
                    type="button"
                    onClick={() => setShowBuildings((v) => !v)}
                    aria-pressed={showBuildings}
                    className={`flex items-center justify-between p-2 rounded-xl border text-xs font-medium transition cursor-pointer ${
                      showBuildings
                        ? 'bg-slate-800/90 border-cyan-500/40 text-slate-100'
                        : 'bg-slate-900/50 border-slate-800 text-slate-500'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <Building2 className={`w-3.5 h-3.5 shrink-0 ${showBuildings ? 'text-amber-400' : 'text-slate-600'}`} />
                      <span className="truncate">Buildings</span>
                    </div>
                    <span className="text-[10px] font-mono tabular-nums opacity-70 ml-1">
                      {mapData?.stats.totalBuildings || 0}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowRoads((v) => !v)}
                    aria-pressed={showRoads}
                    className={`flex items-center justify-between p-2 rounded-xl border text-xs font-medium transition cursor-pointer ${
                      showRoads
                        ? 'bg-slate-800/90 border-cyan-500/40 text-slate-100'
                        : 'bg-slate-900/50 border-slate-800 text-slate-500'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <Navigation className={`w-3.5 h-3.5 shrink-0 ${showRoads ? 'text-sky-400' : 'text-slate-600'}`} />
                      <span className="truncate">Roads</span>
                    </div>
                    <span className="text-[10px] font-mono tabular-nums opacity-70 ml-1">
                      {mapData?.stats.totalRoads || 0}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowRailways((v) => !v)}
                    aria-pressed={showRailways}
                    className={`flex items-center justify-between p-2 rounded-xl border text-xs font-medium transition cursor-pointer ${
                      showRailways
                        ? 'bg-slate-800/90 border-cyan-500/40 text-slate-100'
                        : 'bg-slate-900/50 border-slate-800 text-slate-500'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <Train className={`w-3.5 h-3.5 shrink-0 ${showRailways ? 'text-purple-400' : 'text-slate-600'}`} />
                      <span className="truncate">Railways</span>
                    </div>
                    <span className="text-[10px] font-mono tabular-nums opacity-70 ml-1">
                      {mapData?.stats.totalRailways || 0}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowWater((v) => !v)}
                    aria-pressed={showWater}
                    className={`flex items-center justify-between p-2 rounded-xl border text-xs font-medium transition cursor-pointer ${
                      showWater
                        ? 'bg-slate-800/90 border-cyan-500/40 text-slate-100'
                        : 'bg-slate-900/50 border-slate-800 text-slate-500'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <Waves className={`w-3.5 h-3.5 shrink-0 ${showWater ? 'text-cyan-400' : 'text-slate-600'}`} />
                      <span className="truncate">Water</span>
                    </div>
                    <span className="text-[10px] font-mono tabular-nums opacity-70 ml-1">
                      {(mapData?.stats.totalWaterPolygons || 0) + (mapData?.stats.totalLinearWaterways || 0)}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowParks((v) => !v)}
                    aria-pressed={showParks}
                    className={`flex items-center justify-between p-2 rounded-xl border text-xs font-medium transition cursor-pointer ${
                      showParks
                        ? 'bg-slate-800/90 border-cyan-500/40 text-slate-100'
                        : 'bg-slate-900/50 border-slate-800 text-slate-500'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <Trees className={`w-3.5 h-3.5 shrink-0 ${showParks ? 'text-emerald-400' : 'text-slate-600'}`} />
                      <span className="truncate">Parks</span>
                    </div>
                    <span className="text-[10px] font-mono tabular-nums opacity-70 ml-1">
                      {mapData?.stats.totalParkPolygons || 0}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowLanduse((v) => !v)}
                    aria-pressed={showLanduse}
                    className={`flex items-center justify-between p-2 rounded-xl border text-xs font-medium transition cursor-pointer ${
                      showLanduse
                        ? 'bg-slate-800/90 border-cyan-500/40 text-slate-100'
                        : 'bg-slate-900/50 border-slate-800 text-slate-500'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <LandPlot className={`w-3.5 h-3.5 shrink-0 ${showLanduse ? 'text-indigo-400' : 'text-slate-600'}`} />
                      <span className="truncate">Landuse</span>
                    </div>
                    <span className="text-[10px] font-mono tabular-nums opacity-70 ml-1">
                      {mapData?.stats.totalLandusePolygons || 0}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowFoliage((v) => !v)}
                    aria-pressed={showFoliage}
                    className={`flex items-center justify-between p-2 rounded-xl border text-xs font-medium transition cursor-pointer ${
                      showFoliage
                        ? 'bg-slate-800/90 border-cyan-500/40 text-slate-100'
                        : 'bg-slate-900/50 border-slate-800 text-slate-500'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <TreePine className={`w-3.5 h-3.5 shrink-0 ${showFoliage ? 'text-lime-400' : 'text-slate-600'}`} />
                      <span className="truncate">3D Forests</span>
                    </div>
                    <span className="text-[10px] font-mono tabular-nums opacity-70 ml-1">
                      {(builtGeometry?.stats.forestTreesCount || 0) + (mapData?.stats.totalLandmarks || 0)}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowBarriers((v) => !v)}
                    aria-pressed={showBarriers}
                    className={`flex items-center justify-between p-2 rounded-xl border text-xs font-medium transition cursor-pointer ${
                      showBarriers
                        ? 'bg-slate-800/90 border-cyan-500/40 text-slate-100'
                        : 'bg-slate-900/50 border-slate-800 text-slate-500'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <Fence className={`w-3.5 h-3.5 shrink-0 ${showBarriers ? 'text-amber-300' : 'text-slate-600'}`} />
                      <span className="truncate">Barriers</span>
                    </div>
                    <span className="text-[10px] font-mono tabular-nums opacity-70 ml-1">
                      {mapData?.stats.totalBarriers || 0}
                    </span>
                  </button>
                </div>
              )}

              {/* Tab 2: Universal OSM Feature Inspector */}
              {activeTab === 'inspector' && (
                <div className="text-xs">
                  {!selectedFeature ? (
                    <div className="py-6 text-center text-slate-400">
                      <p className="font-medium text-slate-300">
                        No map feature selected
                      </p>
                      <p className="text-[11px] text-slate-500 mt-1">
                        Hover over any building, road, railway, waterway, forest, park, landuse polygon, barrier, or 3D tree in the scene to see its live Carto tooltip, or click to inspect all raw OpenStreetMap tags.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3 max-h-52 overflow-y-auto pr-1">
                      <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-2.5">
                        <div>
                          <div className="text-[11px] font-mono uppercase tracking-wider text-cyan-400">
                            {selectedFeature.cartoLabel} · {selectedFeature.primaryTag} · ID: {selectedFeature.id}
                          </div>
                          <h3 className="text-sm font-bold text-slate-100 mt-0.5">
                            {selectedFeature.name}
                          </h3>
                          <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-1 flex flex-wrap items-center gap-x-2">
                            <span>Category: <strong className="text-slate-200">{selectedFeature.category}</strong></span>
                            <span>·</span>
                            <span>Subtype: <strong className="text-slate-200">{selectedFeature.subtype}</strong></span>
                            {typeof selectedFeature.height === 'number' && (
                              <>
                                <span>·</span>
                                <span>Height: <strong className="text-slate-200">{selectedFeature.height.toFixed(1)}m</strong></span>
                              </>
                            )}
                            {typeof selectedFeature.width === 'number' && (
                              <>
                                <span>·</span>
                                <span>Width: <strong className="text-slate-200">{selectedFeature.width.toFixed(1)}m</strong></span>
                              </>
                            )}
                            {selectedFeature.levels && (
                              <>
                                <span>·</span>
                                <span>Levels: <strong className="text-slate-200">{selectedFeature.levels}</strong></span>
                              </>
                            )}
                            {typeof selectedFeature.layer === 'number' && (
                              <>
                                <span>·</span>
                                <span>Layer: <strong className="text-slate-200">{selectedFeature.layer}</strong></span>
                              </>
                            )}
                            {selectedFeature.isBridge && (
                              <>
                                <span>·</span>
                                <span className="text-amber-300 font-semibold">Bridge</span>
                              </>
                            )}
                            {selectedFeature.isTunnel && (
                              <>
                                <span>·</span>
                                <span className="text-indigo-300 font-semibold">Tunnel / Underground</span>
                              </>
                            )}
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => setSelectedFeature(null)}
                          className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition cursor-pointer"
                          title="Clear selection"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>

                      {/* Raw OSM Tags Table */}
                      <div>
                        <div className="text-[11px] font-semibold text-slate-300 mb-1.5">
                          OpenStreetMap Tags ({Object.keys(selectedFeature.osmTags || {}).length}):
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 bg-slate-950/60 border border-slate-800/90 rounded-lg p-2.5 font-mono tabular-nums text-[11px]">
                          {Object.entries(selectedFeature.osmTags || {}).map(([k, v]) => (
                            <div key={k} className="flex items-baseline justify-between gap-2 border-b border-slate-800/50 py-0.5 truncate">
                              <span className="text-slate-400 shrink-0">{k}</span>
                              <span className="text-cyan-300 truncate" title={String(v)}>
                                {String(v)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 3: Style & Scale + M2.1 Railway Prototype Comparison */}
              {activeTab === 'style' && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-slate-400 font-medium">Visual Theme:</span>
                      <div className="flex items-center gap-1">
                        {Object.values(MAP_THEMES).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => setSelectedThemeId(t.id)}
                            className={`px-2.5 py-1 text-xs font-medium rounded-lg border transition cursor-pointer ${
                              selectedThemeId === t.id
                                ? 'bg-cyan-950 border-cyan-500 text-cyan-300 font-semibold'
                                : 'bg-slate-800 border-slate-700/60 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {t.name}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={wireframe}
                          onChange={(e) => setWireframe(e.target.checked)}
                          className="rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0"
                        />
                        <span>Wireframe Mode</span>
                      </label>

                      <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={bevelEnabled}
                          onChange={(e) => setBevelEnabled(e.target.checked)}
                          className="rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0"
                        />
                        <span>Beveled Edges</span>
                      </label>
                    </div>
                  </div>

                  {/* M2.1 Isolated Railway Renderer Comparison Controls */}
                  <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-2.5 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <Train className="w-3.5 h-3.5 text-purple-400" />
                        <span className="text-xs font-semibold text-slate-200">
                          M2.1 Railway Renderer Configuration:
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        {(
                          [
                            { id: 'disabled', label: 'A. Railways Disabled' },
                            { id: 'production', label: 'B. Production (Candidate B)' },
                            { id: 'candidateA', label: 'C. Candidate A (Procedural)' },
                            { id: 'candidateB', label: 'D. Candidate B Prototype' },
                          ] as const
                        ).map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            data-testid={`proto-mode-${m.id}`}
                            onClick={() => setRailwayPrototypeMode(m.id)}
                            className={`px-2.5 py-1 text-[11px] font-medium rounded-lg border transition cursor-pointer ${
                              railwayPrototypeMode === m.id
                                ? 'bg-purple-950/80 border-purple-400 text-purple-200 font-semibold'
                                : 'bg-slate-800/80 border-slate-700/60 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Candidate B Controlled Optimization Toggles */}
                    {railwayPrototypeMode === 'candidateB' && (
                      <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-slate-800/70 text-[11px]">
                        <span className="text-slate-400 font-semibold">Candidate B Opts:</span>
                        <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={prototypeOptions.useSpatialGridIndex ?? true}
                            onChange={(e) =>
                              setPrototypeOptions((prev) => ({
                                ...prev,
                                useSpatialGridIndex: e.target.checked,
                              }))
                            }
                            className="rounded border-slate-700 bg-slate-800 text-purple-500"
                          />
                          <span>Spatial Grid Index</span>
                        </label>
                        <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={prototypeOptions.adaptiveBridgeSampling ?? true}
                            onChange={(e) =>
                              setPrototypeOptions((prev) => ({
                                ...prev,
                                adaptiveBridgeSampling: e.target.checked,
                              }))
                            }
                            className="rounded border-slate-700 bg-slate-800 text-purple-500"
                          />
                          <span>Adaptive Bridge Sampling</span>
                        </label>
                        <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={prototypeOptions.multiIntervalClip ?? true}
                            onChange={(e) =>
                              setPrototypeOptions((prev) => ({
                                ...prev,
                                multiIntervalClip: e.target.checked,
                              }))
                            }
                            className="rounded border-slate-700 bg-slate-800 text-purple-500"
                          />
                          <span>Multi-Interval Clip</span>
                        </label>
                        <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={prototypeOptions.sleeper3DMode === 'instanced'}
                            onChange={(e) =>
                              setPrototypeOptions((prev) => ({
                                ...prev,
                                sleeper3DMode: e.target.checked ? 'instanced' : 'merged',
                              }))
                            }
                            className="rounded border-slate-700 bg-slate-800 text-purple-500"
                          />
                          <span>Instanced 3D Sleepers</span>
                        </label>
                        <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={(prototypeOptions.spatialChunkSizeMeters ?? 0) > 0}
                            onChange={(e) =>
                              setPrototypeOptions((prev) => ({
                                ...prev,
                                spatialChunkSizeMeters: e.target.checked ? 128 : 0,
                              }))
                            }
                            className="rounded border-slate-700 bg-slate-800 text-purple-500"
                          />
                          <span>128m Spatial Chunks</span>
                        </label>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800/70">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-[11px] text-slate-400 mr-1">Switchyard Zones:</span>
                        {Object.values(RAILWAY_PROTOTYPE_ZONE_PRESETS).map((zp) => (
                          <button
                            key={zp.id}
                            type="button"
                            onClick={() => {
                              if (activeLocationId !== 'm21_switchyard') {
                                loadSwitchyardFixture(zp.id);
                              } else {
                                jumpToPrototypeZone(zp.id);
                              }
                            }}
                            className={`px-2 py-0.5 text-[10px] font-mono rounded border transition cursor-pointer ${
                              activeLocationId === 'm21_switchyard' && activePrototypeZone === zp.id
                                ? 'bg-cyan-950 border-cyan-500/70 text-cyan-300'
                                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {zp.label.split(':')[0]}
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-[11px] text-slate-400 mr-1">Zoom Presets:</span>
                        {[
                          { label: 'Extreme (16.0x)', zoom: 16.0 },
                          { label: 'Close (8.0x)', zoom: 8.0 },
                          { label: 'Med (3.0x)', zoom: 3.0 },
                          { label: 'Far (1.0x)', zoom: 1.0 },
                        ].map((zp) => (
                          <button
                            key={zp.label}
                            type="button"
                            onClick={() => jumpToPrototypeZone(activePrototypeZone, zp.zoom)}
                            className="px-2 py-0.5 text-[10px] font-mono rounded bg-slate-900 border border-slate-800 text-slate-300 hover:border-cyan-500/50 cursor-pointer"
                          >
                            {zp.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Sliders */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-slate-400 w-28 shrink-0">
                        Building Height ({heightMultiplier.toFixed(1)}x):
                      </span>
                      <input
                        type="range"
                        min="0.5"
                        max="2.5"
                        step="0.1"
                        value={heightMultiplier}
                        onChange={(e) => setHeightMultiplier(parseFloat(e.target.value))}
                        className="w-full accent-cyan-400 cursor-pointer"
                        aria-label="Building height multiplier"
                      />
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="text-xs text-slate-400 w-28 shrink-0">
                        Road Width ({roadWidthMultiplier.toFixed(1)}x):
                      </span>
                      <input
                        type="range"
                        min="0.6"
                        max="2.0"
                        step="0.1"
                        value={roadWidthMultiplier}
                        onChange={(e) => setRoadWidthMultiplier(parseFloat(e.target.value))}
                        className="w-full accent-cyan-400 cursor-pointer"
                        aria-label="Road width multiplier"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 4: Performance & Geometry Stats (M2.1 7-Metric Telemetry) */}
              {activeTab === 'stats' && (
                <div className="space-y-2.5 text-xs">
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                    {/* Metric 1: Frame Cadence */}
                    <div className="bg-slate-800/60 p-2 rounded-xl border border-slate-800">
                      <span className="text-slate-400 block text-[10px]">1. Frame Interval</span>
                      <span className="text-xs font-bold font-mono tabular-nums text-emerald-400">
                        {liveTelemetry?.fps ?? fps} FPS ({liveTelemetry?.frameIntervalMs ?? 16.7} ms)
                      </span>
                      <span className="text-[9px] text-slate-500 block font-mono truncate">
                        p50:{liveTelemetry?.medianFrameIntervalMs ?? 16.7} · p95:{liveTelemetry?.p95FrameIntervalMs ?? 16.7}ms
                      </span>
                    </div>

                    {/* Metric 2: Offline Scene + Rail Build */}
                    <div className="bg-slate-800/60 p-2 rounded-xl border border-slate-800">
                      <span className="text-slate-400 block text-[10px]">2. Offline Build</span>
                      <span className="text-xs font-bold font-mono tabular-nums text-cyan-300">
                        {cpuBuildTimeMs} ms
                        {builtPrototypeRailways ? ` (+${builtPrototypeRailways.stats.buildTimeMs}ms)` : ''}
                      </span>
                      <span className="text-[9px] text-slate-500 block">
                        Raycast: {liveTelemetry?.hoverRaycastTimeMs ?? 0}ms
                      </span>
                    </div>

                    {/* Metric 3: GPU Timer Query */}
                    <div className="bg-slate-800/60 p-2 rounded-xl border border-slate-800">
                      <span className="text-slate-400 block text-[10px]">3. GPU Timer Query</span>
                      <span className="text-xs font-bold font-mono tabular-nums text-slate-300">
                        {liveTelemetry?.gpuPassTimeMs != null
                          ? `${liveTelemetry.gpuPassTimeMs} ms`
                          : 'Not measured'}
                      </span>
                      <span
                        className="text-[9px] text-slate-500 block truncate"
                        title="EXT_disjoint_timer_query_webgl2"
                      >
                        {liveTelemetry?.gpuTimerQuerySupported
                          ? 'Bracketed EXT timer'
                          : 'Unmeasured (SwiftShader)'}
                      </span>
                    </div>

                    {/* Metric 4: WebGL Draw Calls / Meshes */}
                    <div className="bg-slate-800/60 p-2 rounded-xl border border-slate-800">
                      <span className="text-slate-400 block text-[10px]">4. WebGL Calls / Meshes</span>
                      <span className="text-xs font-bold font-mono tabular-nums text-amber-300">
                        {liveTelemetry?.renderCalls ?? builtGeometry?.stats.totalDrawCalls ?? 0} calls
                      </span>
                      <span className="text-[9px] text-slate-500 block">
                        {liveTelemetry?.activeFrustumCulledRailwayMeshes ?? 0}/{liveTelemetry?.activeRailwayMeshes ?? 0} rail meshes vis
                      </span>
                    </div>

                    {/* Metric 5: Scene Triangles & Vertices */}
                    <div className="bg-slate-800/60 p-2 rounded-xl border border-slate-800">
                      <span className="text-slate-400 block text-[10px]">5. Triangles & Vertices</span>
                      <span className="text-xs font-bold font-mono tabular-nums text-cyan-300">
                        {(
                          (builtGeometry?.stats.totalTriangles ?? 0) +
                          (builtPrototypeRailways?.stats.renderedTrianglesWithInstances ?? 0)
                        ).toLocaleString()}{' '}
                        tris
                      </span>
                      <span className="text-[9px] text-slate-500 block">
                        {(liveTelemetry?.activeFrustumVisibleRailwayTriangles ?? 0).toLocaleString()} vis rail tris
                      </span>
                    </div>

                    {/* Metric 6: CPU TypedArray Memory */}
                    <div className="bg-slate-800/60 p-2 rounded-xl border border-slate-800">
                      <span className="text-slate-400 block text-[10px]">6. CPU Buffer Memory</span>
                      <span className="text-xs font-bold font-mono tabular-nums text-purple-300">
                        {(
                          ((builtGeometry?.resources.getCpuBufferMemoryStats().totalBytes ?? 0) +
                            (builtPrototypeRailways?.stats.cpuBufferBytes ?? 0)) /
                          (1024 * 1024)
                        ).toFixed(2)}{' '}
                        MB
                      </span>
                      <span className="text-[9px] text-slate-500 block">TypedArray + Instances</span>
                    </div>

                    {/* Metric 7: Estimated GPU Driver Memory / Geoms */}
                    <div className="bg-slate-800/60 p-2 rounded-xl border border-slate-800">
                      <span className="text-slate-400 block text-[10px]">7. Driver Geoms / Zoom</span>
                      <span className="text-xs font-bold font-mono tabular-nums text-lime-300">
                        {liveTelemetry?.driverGeometries ?? 0} geos · {liveTelemetry?.cameraZoom ?? 1.0}x
                      </span>
                      <span className="text-[9px] text-slate-500 block truncate" title={liveTelemetry?.gpuRenderer}>
                        {liveTelemetry?.gpuRenderer?.includes('SwiftShader')
                          ? 'SwiftShader Software GL'
                          : liveTelemetry?.gpuRenderer || 'WebGL2'}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800/70">
                    <div className="text-[11px] text-slate-400">
                      M2.1 Runtime Performance Lab · Spikes &gt;33ms: {liveTelemetry?.spikesOver33msCount ?? 0} · &gt;50ms: {liveTelemetry?.spikesOver50msCount ?? 0} · Max: {liveTelemetry?.maxSpikeDurationMs ?? 0}ms
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => loadLiveAmsterdamPreset([0, 0, 0], 1.0, 45)}
                        className="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-purple-950/80 hover:bg-purple-900 border border-purple-500/50 text-purple-200 transition cursor-pointer"
                      >
                        Load Amsterdam Preset (420m)
                      </button>
                      <button
                        type="button"
                        onClick={() => (window as any).__M21_LAB__?.exportBenchmarkJson?.()}
                        className="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-cyan-950/80 hover:bg-cyan-900 border border-cyan-500/50 text-cyan-200 transition cursor-pointer"
                      >
                        Export Benchmark JSON
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 5: OpenStreetMap Feature Diagnostics */}
              {activeTab === 'info' && (
                <div className="space-y-2.5 text-xs text-slate-400 max-h-48 overflow-y-auto pr-1">
                  {/* Pipeline Summary Counters */}
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
                    <div className="bg-slate-800/80 p-2 rounded-lg border border-slate-700/60">
                      <span className="text-[10px] text-slate-400 block uppercase tracking-wider">Received</span>
                      <span className="text-sm font-bold font-mono tabular-nums text-slate-100">
                        {mapData?.diagnostics.sourceFeaturesReceived || mapData?.diagnostics.totalFeaturesReceived || 0}
                      </span>
                    </div>
                    <div className="bg-slate-800/80 p-2 rounded-lg border border-indigo-900/60">
                      <span className="text-[10px] text-indigo-400 block uppercase tracking-wider">Classified</span>
                      <span className="text-sm font-bold font-mono tabular-nums text-indigo-300">
                        {mapData?.diagnostics.sourceFeaturesClassified || 0}
                      </span>
                    </div>
                    <div className="bg-slate-800/80 p-2 rounded-lg border border-emerald-900/60">
                      <span className="text-[10px] text-emerald-400 block uppercase tracking-wider">Valid Parsed</span>
                      <span className="text-sm font-bold font-mono tabular-nums text-emerald-300">
                        {mapData?.diagnostics.totalFeaturesParsed || 0}
                      </span>
                    </div>
                    <div className="bg-slate-800/80 p-2 rounded-lg border border-cyan-900/60">
                      <span className="text-[10px] text-cyan-400 block uppercase tracking-wider">3D Rendered</span>
                      <span className="text-sm font-bold font-mono tabular-nums text-cyan-300">
                        {mapData?.diagnostics.sourceFeaturesRendered || mapData?.diagnostics.totalFeaturesRendered || 0}
                      </span>
                    </div>
                    <div className="bg-slate-800/80 p-2 rounded-lg border border-amber-900/60">
                      <span className="text-[10px] text-amber-400 block uppercase tracking-wider">Skipped / Inv</span>
                      <span className="text-sm font-bold font-mono tabular-nums text-amber-300">
                        {(mapData?.diagnostics.skippedUnsupported.total || 0) + (mapData?.diagnostics.rejectedInvalid.total || 0)}
                      </span>
                    </div>
                  </div>

                  {/* Category Breakdown */}
                  <div className="bg-slate-800/40 p-2.5 rounded-lg border border-slate-800">
                    <div className="text-[11px] font-semibold text-slate-300 mb-1">Parsed OSM Carto Categories:</div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono tabular-nums">
                      <span>Buildings: <strong className="text-slate-100">{mapData?.diagnostics.parsedByCategory.buildings}</strong></span>
                      <span>Roads & Ways: <strong className="text-slate-100">{mapData?.diagnostics.parsedByCategory.roads}</strong></span>
                      <span>Railways: <strong className="text-purple-300">{mapData?.diagnostics.parsedByCategory.railways}</strong></span>
                      <span>Waterways: <strong className="text-cyan-300">{mapData?.diagnostics.parsedByCategory.linearWaterways}</strong></span>
                      <span>Water Bodies: <strong className="text-cyan-300">{mapData?.diagnostics.parsedByCategory.waterBodies}</strong></span>
                      <span>Nature & Parks: <strong className="text-emerald-300">{mapData?.diagnostics.parsedByCategory.parks}</strong></span>
                      <span>Landuse & Civic: <strong className="text-indigo-300">{mapData?.diagnostics.parsedByCategory.landuse}</strong></span>
                      <span>Barriers & Walls: <strong className="text-amber-300">{mapData?.diagnostics.parsedByCategory.barriers || 0}</strong></span>
                      <span>3D Landmarks/Trees: <strong className="text-lime-300">{mapData?.diagnostics.parsedByCategory.landmarks || 0}</strong></span>
                    </div>
                  </div>

                  {/* OSM Carto Subtype Distribution */}
                  {mapData?.diagnostics.cartoSubtypesCount &&
                    Object.keys(mapData.diagnostics.cartoSubtypesCount).length > 0 && (
                      <div className="bg-slate-800/40 p-2.5 rounded-lg border border-slate-800">
                        <div className="text-[11px] font-semibold text-cyan-300 mb-1">
                          Active OSM Carto Subtypes ({Object.keys(mapData.diagnostics.cartoSubtypesCount).length} distinct types):
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-mono tabular-nums text-slate-300">
                          {Object.entries(mapData.diagnostics.cartoSubtypesCount)
                            .sort((a, b) => b[1] - a[1])
                            .map(([label, count]) => (
                              <span key={label}>
                                {label}: <strong className="text-cyan-400">{count}</strong>
                              </span>
                            ))}
                        </div>
                      </div>
                    )}

                  {/* Skipped Unsupported Tags */}
                  {mapData?.diagnostics.skippedUnsupported.total! > 0 && (
                    <div className="bg-slate-800/40 p-2.5 rounded-lg border border-slate-800">
                      <div className="text-[11px] font-semibold text-amber-400 mb-1">
                        Skipped Unsupported Tags ({mapData?.diagnostics.skippedUnsupported.total} features):
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-mono tabular-nums text-slate-300">
                        {Object.entries(mapData?.diagnostics.skippedUnsupported.byTag || {}).map(([tag, b]) => (
                          <span key={tag}>
                            {tag} <strong className="text-amber-400">({b.count})</strong>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Geometry Breakdown */}
                  <div className="flex items-center justify-between text-[11px] pt-1 text-slate-500 font-mono tabular-nums">
                    <span>
                      Geometry: LineString ({mapData?.diagnostics.byGeometryType.LineString}), Polygon ({mapData?.diagnostics.byGeometryType.Polygon}), MultiPolygon ({mapData?.diagnostics.byGeometryType.MultiPolygon}), Point ({mapData?.diagnostics.byGeometryType.Point})
                    </span>
                    <span>
                      Data: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="text-cyan-400 underline">OpenStreetMap</a>
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </footer>

      {/* Address Search Modal */}
      <AddressSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onSelectLocation={handleSelectAddress}
        currentGeoJson={currentRawGeoJson}
      />

      {/* Unified Developer Tools Panel */}
      <DevToolsPanel
        isOpen={isDevToolsOpen}
        onClose={() => setIsDevToolsOpen(false)}
        infrastructureRenderOptions={infrastructureRenderOptions}
        onChangeInfrastructureRenderOptions={(opts) =>
          setInfrastructureRenderOptions((prev) =>
            normalizeInfrastructureRenderOptions({ ...prev, ...opts })
          )
        }
        railwayPrototypeMode={railwayPrototypeMode}
        onChangeRailwayPrototypeMode={(mode) => setRailwayPrototypeMode(mode)}
        wireframe={wireframe}
        onToggleWireframe={() => setWireframe((v) => !v)}
        showGraphOverlay={showGraphOverlay}
        onToggleGraphOverlay={() => setShowGraphOverlay((v) => !v)}
        selectedFeature={selectedFeature}
        selectedFeatures={selectedFeatures}
        focusedFeatureId={focusedFeatureId}
        onSelectFeature={handleSelectFeature}
        onFocusFeature={handleFocusFeature}
        onRemoveSelectedFeature={handleRemoveSelectedFeature}
        onClearAllSelectedFeatures={handleClearAllSelectedFeatures}
        isSpatialSelectActive={isSpatialSelectActive}
        onToggleSpatialSelect={() => setIsSpatialSelectActive((v) => !v)}
        selectedBoxMeters={selectedBoxMeters}
        onClearSpatialBox={() => setSelectedBoxMeters(null)}
        mapData={mapData}
        currentRawGeoJson={currentRawGeoJson}
        themeId={selectedThemeId}
        roadWidthMultiplier={roadWidthMultiplier}
        heightMultiplier={heightMultiplier}
        currentCameraPose={{
          target: explicitPose.target,
          zoom: currentCameraZoomRef.current || explicitPose.zoom,
          azimuthDeg: explicitPose.azimuthRad
            ? Math.round((explicitPose.azimuthRad * 180) / Math.PI)
            : 45,
        }}
        onApplyCameraPose={(pose) => {
          setExplicitPose((prev) => ({
            target: pose.target,
            zoom: pose.zoom,
            azimuthRad:
              typeof pose.azimuthDeg === 'number'
                ? (pose.azimuthDeg * Math.PI) / 180
                : prev.azimuthRad,
            signal: prev.signal + 1,
          }));
        }}
        onLoadSwitchyard={(zone) => loadSwitchyardFixture(zone)}
        onLoadPrinsFork={() => loadPrinsHendrikkadeForkFixture()}
        onLoadHengelo={() => loadLiveHengeloPreset()}
        onLoadAmsterdam={() => loadLiveAmsterdamPreset()}
        onImportReproductionPackage={handleImportReproductionPackage}
      />
    </div>
  );
}
