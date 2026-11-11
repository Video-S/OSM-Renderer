import type {
  InfrastructurePointKind,
  InfrastructurePointMetadata,
  TopologySourceData,
  UnchainedRailwayPart,
  UnchainedRoadPart,
} from '../world/infrastructure/topology/types';
import type {
  ExplicitPlacementHints,
  InfrastructureEnclosureKind,
  InfrastructurePlacementClassification,
  InfrastructurePlacementConfidence,
  InfrastructurePlacementDiagnostics,
  InfrastructurePlacementKind,
  InfrastructureSupportingVerticalEvidence,
  InfrastructureVerticalRelation,
  TunnelConstructionSubtype,
} from '../world/InfrastructurePlacementClassifier';

export type {
  ExplicitPlacementHints,
  InfrastructureEnclosureKind,
  InfrastructurePlacementClassification,
  InfrastructurePlacementConfidence,
  InfrastructurePlacementDiagnostics,
  InfrastructurePlacementKind,
  InfrastructurePointKind,
  InfrastructurePointMetadata,
  InfrastructureSupportingVerticalEvidence,
  InfrastructureVerticalRelation,
  TopologySourceData,
  TunnelConstructionSubtype,
  UnchainedRailwayPart,
  UnchainedRoadPart,
};

export type FeatureType =
  | 'building'
  | 'road'
  | 'railway'
  | 'water'
  | 'waterway'
  | 'park'
  | 'landuse'
  | 'barrier'
  | 'landmark'
  | 'ground'
  | 'unknown';

export type RoadClass =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'residential'
  | 'living_street'
  | 'service'
  | 'pedestrian'
  | 'footway'
  | 'cycleway'
  | 'bridleway'
  | 'steps'
  | 'path'
  | 'track'
  | 'runway'
  | 'taxiway'
  | 'platform'
  | 'pier'
  | 'raceway'
  | 'busway'
  | 'bus_guideway'
  | 'construction'
  | 'bridge'
  | 'unclassified';

export type RailwayType =
  | 'rail'
  | 'light_rail'
  | 'subway'
  | 'tram'
  | 'narrow_gauge'
  | 'monorail'
  | 'funicular'
  | 'miniature'
  | 'construction'
  | 'disused'
  | 'turntable'
  | 'roller_coaster'
  | 'aerialway'
  | 'unclassified';

export type WaterwayType =
  | 'river'
  | 'stream'
  | 'canal'
  | 'drain'
  | 'ditch'
  | 'dock'
  | 'weir'
  | 'dam'
  | 'water_slide'
  | 'waterway';

export type WaterBodyType =
  | 'riverbank'
  | 'lake'
  | 'pond'
  | 'reservoir'
  | 'basin'
  | 'dock'
  | 'canal'
  | 'ocean'
  | 'swimming_pool'
  | 'salt_pond'
  | 'reef'
  | 'wetland'
  | 'water';

export type LanduseType =
  | 'residential'
  | 'commercial'
  | 'industrial'
  | 'retail'
  | 'construction'
  | 'brownfield'
  | 'landfill'
  | 'cemetery'
  | 'allotments'
  | 'institutional'
  | 'education'
  | 'healthcare'
  | 'civic'
  | 'religious'
  | 'military'
  | 'farmland'
  | 'farmyard'
  | 'orchard'
  | 'vineyard'
  | 'plant_nursery'
  | 'quarry'
  | 'railway'
  | 'garages'
  | 'parking'
  | 'parking_space'
  | 'apron'
  | 'aerodrome'
  | 'platform_area'
  | 'pedestrian_area'
  | 'power'
  | 'water_works'
  | 'leisure_Select'
  | 'tourism_area'
  | 'landuse';

export type BarrierType =
  | 'hedge'
  | 'wall'
  | 'fence'
  | 'city_wall'
  | 'retaining_wall'
  | 'guard_rail'
  | 'breakwater'
  | 'groyne'
  | 'embankment'
  | 'cliff'
  | 'tree_row'
  | 'weir'
  | 'dam';

export type LandmarkType =
  | 'tree'
  | 'tower'
  | 'communication_tower'
  | 'observation_tower'
  | 'water_tower'
  | 'bell_tower'
  | 'cooling_tower'
  | 'lighthouse'
  | 'windmill'
  | 'wind_turbine'
  | 'mast'
  | 'chimney'
  | 'crane'
  | 'storage_tank'
  | 'obelisk'
  | 'power_tower'
  | 'power_pole'
  | 'monument'
  | 'memorial'
  | 'peak'
  | 'volcano'
  | 'bench'
  | 'waste_basket'
  | 'street_lamp'
  | 'bicycle_parking'
  | 'fountain'
  | 'shelter'
  | 'post_box'
  | 'transit_stop'
  | 'poi';

export interface RawGeoJsonProperties {
  id?: string | number;
  name?: string;
  building?: string | boolean;
  'building:levels'?: string | number;
  height?: string | number;
  min_height?: string | number;
  highway?: string;
  railway?: string;
  waterway?: string;
  natural?: string;
  water?: string;
  leisure?: string;
  landuse?: string;
  bridge?: string | boolean;
  tunnel?: string | boolean;
  amenity?: string;
  layer?: string | number;
  width?: string | number;
  gauge?: string | number;
  electrified?: string | boolean;
  surface?: string;
  nodes?: Array<string | number>;
  nodeIds?: Array<string | number>;
  _nodeIds?: Array<string | number>;
  _nodeIdsByPart?: Array<Array<string | number>>;
  [key: string]: unknown;
}

export interface RoadPortalConnectionSpec {
  roadFeatureId: string;
  sourceFeatureId: string;
  endpoint: 'start' | 'end';
  left: [number, number];
  right: [number, number];
}

/**
 * Rich metadata attached to every 3D geometry range / mesh / instance for universal hover & click inspection.
 */
export interface InspectableFeatureInfo {
  id: string;
  sourceFeatureId: string;
  sourceFeatureIds?: string[];
  portalConnections?: RoadPortalConnectionSpec[];
  name?: string;
  category: string; // e.g., 'Building', 'Road & Way', 'Terrain & Nature', 'Landuse & Zoning', 'Railway & Transit', 'Water', 'Barrier & Wall', '3D Tree & Landmark'
  cartoLabel: string; // Human-readable OSM Carto description
  primaryTag: string; // e.g., 'highway=track + tracktype=grade2'
  subtype: string;
  height?: number;
  heightFormatted?: string;
  levels?: number;
  width?: number;
  elevation?: number;
  layer?: number;
  isBridge?: boolean;
  isTunnel?: boolean;
  placementClassification?: InfrastructurePlacementClassification;
  type?: string; // Backward compatibility for buildingType
  amenity?: string;
  osmTags: Record<string, string | number | boolean>;
}

export interface BuildingFeature {
  id: string;
  sourceFeatureId?: string;
  type: 'building';
  name?: string;
  footprint: [number, number][][]; // outer ring + optional hole rings in local meters [x, z]
  height: number; // meters
  minHeight: number; // meters from ground
  levels?: number;
  buildingType: string;
  buildingArchetype?: 'religious' | 'transit' | 'civic' | 'commercial' | 'industrial' | 'historic' | 'residential';
  isRoofOnly?: boolean;
  amenity?: string;
  cartoLabel?: string;
  primaryTag?: string;
  osmTags?: RawGeoJsonProperties;
}

export interface RoadFeature {
  id: string;
  sourceFeatureId?: string;
  sourceFeatureIds?: string[]; // All original source IDs contributing to this road (e.g. after chaining)
  type: 'road';
  name?: string;
  points: [number, number][]; // polyline points in local meters [x, z]
  nodeIds?: (string | number)[]; // OSM or topological node IDs for each point
  roadClass: RoadClass;
  subtype?: string;
  width: number; // meters
  isBridge: boolean;
  isTunnel: boolean;
  layer: number;
  placementClassification?: InfrastructurePlacementClassification;
  cartoLabel?: string;
  primaryTag?: string;
  osmTags?: RawGeoJsonProperties;
}

export interface RailwayFeature {
  id: string;
  sourceFeatureId?: string;
  sourceFeatureIds?: string[]; // All original source IDs contributing to this railway
  type: 'railway';
  name?: string;
  points: [number, number][]; // polyline points in local meters [x, z]
  nodeIds?: (string | number)[]; // OSM or topological node IDs for each point
  railwayType: RailwayType;
  width: number; // track bed width in meters
  isBridge: boolean;
  isTunnel: boolean;
  layer: number;
  placementClassification?: InfrastructurePlacementClassification;
  gauge?: number;
  electrified?: boolean;
  cartoLabel?: string;
  primaryTag?: string;
  osmTags?: RawGeoJsonProperties;
}

export interface WaterBodyFeature {
  id: string;
  sourceFeatureId?: string;
  type: 'water';
  name?: string;
  polygon: [number, number][][]; // outer ring + optional hole rings in local meters [x, z]
  waterType: WaterBodyType;
  isBridge?: boolean;
  isTunnel?: boolean;
  layer?: number;
  intermittent?: boolean;
  cartoLabel?: string;
  primaryTag?: string;
  osmTags?: RawGeoJsonProperties;
}

export interface LinearWaterwayFeature {
  id: string;
  sourceFeatureId?: string;
  type: 'waterway';
  name?: string;
  points: [number, number][]; // polyline points in local meters [x, z]
  waterwayType: WaterwayType;
  width: number; // meters
  isBridge: boolean;
  isTunnel: boolean;
  layer: number;
  placementClassification?: InfrastructurePlacementClassification;
  intermittent?: boolean;
  cartoLabel?: string;
  primaryTag?: string;
  osmTags?: RawGeoJsonProperties;
}

export interface ParkFeature {
  id: string;
  sourceFeatureId?: string;
  type: 'park';
  name?: string;
  polygon: [number, number][][]; // outer ring + optional hole rings in local meters [x, z]
  subtype: string;
  has3DFoliage?: boolean;
  leafType?: 'broadleaved' | 'needleleaved' | 'mixed' | 'leafless';
  cartoLabel?: string;
  primaryTag?: string;
  osmTags?: RawGeoJsonProperties;
}

export interface LanduseFeature {
  id: string;
  sourceFeatureId?: string;
  type: 'landuse';
  name?: string;
  polygon: [number, number][][];
  landuseType: LanduseType;
  subtype?: string;
  cartoLabel?: string;
  primaryTag?: string;
  osmTags?: RawGeoJsonProperties;
}

export interface BarrierFeature {
  id: string;
  sourceFeatureId?: string;
  type: 'barrier';
  name?: string;
  points: [number, number][];
  barrierType: BarrierType;
  width: number;
  height: number;
  cartoLabel?: string;
  primaryTag?: string;
  osmTags?: RawGeoJsonProperties;
}

export interface PointLandmarkFeature {
  id: string;
  sourceFeatureId?: string;
  type: 'landmark';
  name?: string;
  position: [number, number]; // [x, z] in local meters
  landmarkType: LandmarkType;
  height: number;
  leafType?: 'broadleaved' | 'needleleaved' | 'mixed' | 'leafless';
  cartoLabel?: string;
  primaryTag?: string;
  osmTags?: RawGeoJsonProperties;
}

// Retain SurfaceAreaFeature for backward compatibility if needed
export type SurfaceAreaFeature = WaterBodyFeature | ParkFeature;

export type MapFeature =
  | BuildingFeature
  | RoadFeature
  | RailwayFeature
  | WaterBodyFeature
  | LinearWaterwayFeature
  | ParkFeature
  | LanduseFeature
  | BarrierFeature
  | PointLandmarkFeature;

export interface FeatureDiagnosticBreakdown {
  count: number;
  sampleIds: string[];
}

export interface MapFeatureDiagnostics {
  /** 1. Total raw GeoJSON Feature objects received from source data */
  sourceFeaturesReceived: number;
  /** 2. Total source GeoJSON features successfully classified into a supported category */
  sourceFeaturesClassified: number;
  /** 3. Total source features whose geometry was valid and yielded parsed features */
  totalFeaturesParsed: number;
  /** 4. Total source features represented in the final 3D scene */
  sourceFeaturesRendered: number;
  /** 5. Total discrete Three.js meshes constructed in the scene graph */
  constructedMeshesCount: number;

  /** Counts of source features classified by category */
  parsedByCategory: {
    buildings: number;
    roads: number;
    railways: number;
    waterBodies: number;
    linearWaterways: number;
    parks: number;
    landuse: number;
    barriers?: number;
    landmarks?: number;
  };

  /** Parsed feature parts extracted during GeoJSON parsing (before 3D mesh generation) */
  parsedFeatureParts?: {
    total: number;
    byCategory: {
      buildings: number;
      roads: number;
      railways: number;
      waterBodies: number;
      linearWaterways: number;
      parks: number;
      landuse: number;
      barriers?: number;
      landmarks?: number;
    };
  };

  /** 3D geometry parts actually constructed in GeometryBuilder.buildScene() */
  geometryPartsGenerated: {
    total: number;
    byCategory: {
      buildings: number;
      roads: number;
      railways: number;
      waterBodies: number;
      linearWaterways: number;
      parks: number;
      landuse: number;
      barriers?: number;
      landmarks?: number;
    };
  };

  /** Features clipped or omitted at the loaded region boundary */
  featuresClippedByBoundary?: {
    clippedCount: number;
    omittedOutsideCount: number;
    sampleIds: string[];
  };

  /** Features completely removed by Boolean surface/carriageway subtraction */
  featuresFullySubtracted?: {
    count: number;
    sampleIds: string[];
  };

  /** Boolean clipping failures recorded during surface or road/path resolution */
  clippingFailures?: {
    count: number;
    sampleIds: string[];
  };

  /** Observable railway renderer fallback reason when graph mode falls back to legacy (Stage E3-A1) */
  railwayRendererFallback?: string;

  /** Count of classified features by human-readable OSM Carto subtype */
  cartoSubtypesCount?: Record<string, number>;

  /** Features skipped due to unsupported tags or non-linear infrastructure */
  skippedUnsupported: {
    total: number;
    byTag: Record<string, FeatureDiagnosticBreakdown>;
  };

  /** Features rejected due to malformed or degenerate coordinates */
  rejectedInvalid: {
    total: number;
    byReason: Record<string, FeatureDiagnosticBreakdown>;
  };

  /** Feature processing outcomes and lineage tracking */
  featureLineage?: {
    retainedCount: number;
    chainedGroupsCount: number;
    chainedFeaturesCount: number;
    deduplicatedCount: number;
    chainingMap: Record<string, string[]>; // compositeId -> constituent sourceFeatureIds
    deduplicatedMap: Record<string, string[]>; // canonicalId -> deduplicated duplicate sourceFeatureIds
  };

  /** Source features breakdown by GeoJSON geometry type */
  byGeometryType: {
    Point: number;
    MultiPoint: number;
    LineString: number;
    MultiLineString: number;
    Polygon: number;
    MultiPolygon: number;
    GeometryCollection: number;
    Unknown: number;
  };

  // Backward compatibility alias:
  totalFeaturesReceived: number;
  totalFeaturesRendered: number;

  /** Post-build planar polygon layering & Z-fighting validation report */
  planarValidation?: {
    isValid: boolean;
    totalPolygons: number;
    overlappingPairsChecked: number;
    conflictsResolved: number;
    minObservedSeparationMeters: number;
    maxStackDepth: number;
  };

  /** Semantic placement classification breakdown (Stage E4-T) */
  placementDiagnostics?: InfrastructurePlacementDiagnostics;
}

export interface ProcessedMapData {
  regionName: string;
  centerLonLat: [number, number];
  bounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    widthMeters: number;
    depthMeters: number;
  };
  buildings: BuildingFeature[];
  roads: RoadFeature[];
  railways: RailwayFeature[];
  waterBodies: WaterBodyFeature[];
  linearWaterways: LinearWaterwayFeature[];
  // For backward compatibility:
  water: WaterBodyFeature[];
  parks: ParkFeature[];
  landuse: LanduseFeature[];
  barriers: BarrierFeature[];
  landmarks: PointLandmarkFeature[];
  /** Non-destructive pre-deduplication and pre-chaining topology inputs (ADR-0009). */
  topologySource?: TopologySourceData;
  diagnostics: MapFeatureDiagnostics;
  stats: {
    totalBuildings: number;
    totalRoads: number;
    totalRoadSegments: number;
    totalRailways: number;
    totalRailwaySegments: number;
    totalWaterPolygons: number;
    totalLinearWaterways: number;
    totalParkPolygons: number;
    totalLandusePolygons: number;
    totalBarriers?: number;
    totalLandmarks?: number;
    areaKm2: number;
  };
}

export interface MapStyleTheme {
  id: 'tactical' | 'daylight' | 'dusk' | 'blueprint';
  name: string;
  groundColor: string;
  gridColor: string;
  buildingWallColor: string;
  buildingRoofColor: string;
  buildingArchetypeColors?: {
    religious: { wall: string; roof: string };
    transit: { wall: string; roof: string };
    civic: { wall: string; roof: string };
    commercial: { wall: string; roof: string };
    industrial: { wall: string; roof: string };
    historic: { wall: string; roof: string };
  };
  waterColor: string;
  parkColor: string;
  terrainColors?: Record<string, string>;
  foliageColors?: {
    trunk: string;
    broadleaved: string;
    needleleaved: string;
    leafless: string;
  };
  barrierColors?: {
    hedge: string;
    wall: string;
    city_wall: string;
    fence: string;
    cliff: string;
  };
  roadColors: Record<RoadClass, string>;
  railwayColors: {
    ballast: string;
    sleeper?: string;
    rail: string;
  };
  landuseColors: Record<string, string>;
  skyColor: string;
  fogColor: string;
  lightIntensity: number;
}
