import { RoadClass } from '../types/MapFeature';

/**
 * ============================================================================
 * CENTRAL MAP SURFACE ELEVATION & GRADE-SEPARATION POLICY
 * ============================================================================
 *
 * Architectural Principles:
 * 1. Separation of 2D Semantic Ownership and 3D Physical Elevation:
 *    - Mutually exclusive at-grade ground-cover fills (landuse, subzoning, parks,
 *      forests, grass islands, paved parking lots, sports pitches) are resolved in 2D
 *      via batch MultiPolygon Boolean subtraction so their footprints never overlap.
 *    - Because their 2D footprints are mutually exclusive, all resolved ground-cover fills
 *      share a SINGLE flush ground-cover plane (`GROUND_COVER_SURFACE = +0.025m`),
 *      producing a 0.0mm flush seam at every shared boundary.
 * 2. Water Bodies & Waterways:
 *    - Surface water carves its footprint out of overlapping ground-cover polygons
 *      and sits at `WATER_SURFACE = +0.015m` (a 10mm depressed shoreline inside its cutout).
 * 3. Intentional Surface Decals (`Parking_Markings`, `Pitch_Markings`, `parking_space`):
 *    - Placed relative to their host surface (`+0.028m` / `+0.029m`) with non-overlapping
 *      unioned 2D stroke geometry and selective `polygonOffset`.
 * 4. Uniform At-Grade Road Baseline (`ROAD_SURFACE = +0.050m`):
 *    - All ordinary at-grade roads, streets, and pedestrian/cycle paths share the agreed
 *      uniform physical elevation baseline of `+0.050m` (`ROAD_SURFACE = 0.050`).
 *    - Ordinary roads of different classes (`primary`, `residential`, `footway`, `cycleway`)
 *      do NOT receive arbitrary physical elevation tiers or feature-ID micro-offsets.
 *    - Coplanar overlaps at intersections and cross-class crossings are eliminated in 2D
 *      via topological junction trimming and Boolean polygon clipping, supplemented by
 *      deterministic `renderOrder` and `polygonOffset`.
 * 5. At-Grade Railway System (`+0.060m` to `+0.085m`):
 *    - Crushed stone ballast sits at `+0.060m` (10mm proud of `ROAD_SURFACE`),
 *      perpendicular cross-tie sleepers at `+0.072m`, and twin steel rails at `+0.085m`.
 * 6. Real Grade Separation (Bridges & Tunnels):
 *    - Bridges rise to `ROAD_SURFACE + BRIDGE_BASE_CLEARANCE` (`+2.850m` for layer 1)
 *      via continuous sloped approach ramps and abutments.
 *    - Tunnels descend below grade (`TUNNEL_DEPTH = -2.0m`) through 3D tunnel portals.
 */

export const ELEVATION_POLICY = {
  // 1. Base Canvas & Reference Planes (meters)
  GROUND: -0.015,               // Base fallback canvas plane (40mm below mapped ground cover)
  LANDUSE: -0.005,              // Policy substrate reference plane (GROUND < LANDUSE < WATER_SURFACE < PARKS < ROAD_SURFACE)
  WATER_BOTTOM: -0.040,         // Water body bed depression
  WATER_SURFACE: 0.015,         // Surface water level inside carved basin cutout

  // 2. Uniform Flush Ground-Cover Plane (meters)
  // All mutually exclusive ground-cover fills share this single flush plane (+0.025m).
  GROUND_COVER_SURFACE: 0.025,
  PARKS: 0.025,
  BARRIER_BASE: 0.025,
  LANDUSE_SUBZONING: 0.025,
  PAVED_LOT_SURFACE: 0.025,
  PITCH_SURFACE: 0.025,

  // 3. Intentional Surface Decals & Markings (meters)
  PARKING_SPACE_SURFACE: 0.028, // Individual mapped parking stall decal (+3mm above host lot)
  PARKING_MARKINGS: 0.029,      // Unioned painted parking stall lines (+4mm above host lot)
  PITCH_MARKINGS: 0.029,        // Unioned white sports pitch lines (+4mm above host pitch)

  // 4. Uniform At-Grade Road & Path Surface Baseline (meters)
  ROAD_SURFACE: 0.050,

  ROAD_BASE_TIERS: {
    path: 0.050,
    footway: 0.050,
    steps: 0.050,
    bridleway: 0.050,
    track: 0.050,
    cycleway: 0.050,
    pedestrian: 0.050,
    platform: 0.050,
    pier: 0.050,
    service: 0.050,
    living_street: 0.050,
    residential: 0.050,
    unclassified: 0.050,
    tertiary: 0.050,
    secondary: 0.050,
    primary: 0.050,
    trunk: 0.050,
    motorway: 0.050,
    runway: 0.050,
    taxiway: 0.050,
    raceway: 0.050,
    busway: 0.050,
    bus_guideway: 0.050,
    construction: 0.050,
    bridge: 0.050,
  } as Record<RoadClass, number>,

  // 5. At-Grade Railway System (meters)
  RAILWAY_BALLAST: 0.060,
  RAILWAY_SLEEPERS: 0.072,
  RAILWAY_RAILS: 0.085,

  // 6. Decal & Step Offsets (meters)
  MARKING_OFFSET: 0.004,
  STEP_TREAD_OFFSET: 0.006,

  // 7. Relational Grade Separation (Bridges & Flyovers)
  BRIDGE_BASE_CLEARANCE: 2.8,   // 2.8 meters base clearance above road grade
  BRIDGE_LAYER_STEP: 1.4,       // 1.4 meters per positive OSM layer

  // 8. Subterranean Grade Separation (Tunnels, Underpasses & Cuttings)
  TUNNEL_DEPTH: -5.0,                       // -5.0m baseline subterranean floor depth (4.6m standard clearance + 0.4m roof slab cover below Y=0m)
  TUNNEL_LAYER_STEP: 5.0,                   // 5.0m vertical separation per deeper negative OSM layer
  TUNNEL_ROOF_COVER_THICKNESS: 0.4,         // Minimum structural roof slab + soil cover allowance below Y=0.0m
  TUNNEL_CLEARANCE_FOOT_CYCLE: 2.6,         // Minimum clearance for pedestrian/cycleway underpasses (m)
  TUNNEL_CLEARANCE_VEHICULAR: 3.8,          // Standard vehicular tunnel clearance (m, matches Europatunnel maxheight=3.8)
  TUNNEL_CLEARANCE_RAILWAY: 4.6,            // Non-electrified / urban transit railway tunnel clearance (m)
  TUNNEL_CLEARANCE_RAILWAY_ELECTRIFIED: 5.2,// Mainline electrified railway tunnel clearance (m)
  OPEN_CUTTING_DEPTH: -1.8,                 // Default open cutting floor depression alongside cutting retaining walls (m)

  // 9. Micro-tiering step is zero: no artificial height staggering
  MICRO_TIER_STEP: 0.0,
  MAX_MICRO_TIERS: 1,
};

export interface TunnelClearanceOptions {
  domain?: 'road' | 'railway';
  kind?: 'road' | 'railway';
  layer?: number;
  roadClass?: RoadClass;
  roadCategory?: string;
  railwayType?: string;
  electrified?: boolean | string;
  electrifiedTag?: boolean | string;
  maxheightMeters?: number;
  maxheightTag?: string | number;
}

export interface ResolvedTunnelClearance {
  requiredClearanceMeters: number;
  roofCoverThicknessMeters: number;
  targetFloorElevation: number;
  targetRoofSoffitElevation: number;
}

/**
 * Centralizes subterranean tunnel clearance and floor depth calculations (M2.3-E4-T2).
 *
 * - Ensures every subterranean tunnel leaves sufficient vertical clearance plus structural roof cover
 *   beneath `Y = 0.0 m` (`targetFloorElevation + requiredClearanceMeters <= -roofCoverThicknessMeters`).
 * - Respects explicit OSM `maxheight=*` tags when present.
 * - Distinguishes pedestrian/cycleway underpasses, vehicular roads, urban transit / non-electrified rail,
 *   and electrified mainline rail.
 */
export function resolveTunnelClearanceAndDepth(
  options: TunnelClearanceOptions
): ResolvedTunnelClearance {
  const domain = options.domain ?? options.kind ?? 'road';
  const tunnelLayer = options.layer !== undefined && options.layer < 0 ? Math.abs(options.layer) : 1;
  const roofCoverThicknessMeters = ELEVATION_POLICY.TUNNEL_ROOF_COVER_THICKNESS;

  const rawParsedMaxH =
    options.maxheightMeters !== undefined
      ? options.maxheightMeters
      : options.maxheightTag !== undefined
        ? parseFloat(String(options.maxheightTag))
        : undefined;

  const explicitMaxH =
    typeof rawParsedMaxH === 'number' &&
    Number.isFinite(rawParsedMaxH) &&
    rawParsedMaxH > 1.5
      ? Math.min(Math.max(rawParsedMaxH, 2.0), 8.0)
      : undefined;

  let requiredClearanceMeters: number;
  if (domain === 'railway') {
    const rawElectrified = options.electrified ?? options.electrifiedTag;
    const isElectrified =
      rawElectrified === true ||
      (typeof rawElectrified === 'string' &&
        rawElectrified.trim() !== '' &&
        rawElectrified.trim().toLowerCase() !== 'no' &&
        rawElectrified.trim().toLowerCase() !== 'false');
    const rType = (options.railwayType || 'rail').toLowerCase();
    const isUrbanOrLight =
      rType === 'subway' ||
      rType === 'tram' ||
      rType === 'light_rail' ||
      rType === 'miniature' ||
      rType === 'narrow_gauge';
    const baseRailClearance =
      isElectrified && !isUrbanOrLight
        ? ELEVATION_POLICY.TUNNEL_CLEARANCE_RAILWAY_ELECTRIFIED
        : ELEVATION_POLICY.TUNNEL_CLEARANCE_RAILWAY;
    requiredClearanceMeters = explicitMaxH ? Math.max(explicitMaxH, 3.0) : baseRailClearance;
  } else {
    const rClass = (options.roadClass ?? options.roadCategory ?? 'residential') as RoadClass;
    const isFootOrCycle = isNonVehicularRoadClass(rClass);
    const baseRoadClearance = isFootOrCycle
      ? ELEVATION_POLICY.TUNNEL_CLEARANCE_FOOT_CYCLE
      : ELEVATION_POLICY.TUNNEL_CLEARANCE_VEHICULAR;
    requiredClearanceMeters = explicitMaxH ?? baseRoadClearance;
  }

  const minDepthForClearance = -(requiredClearanceMeters + roofCoverThicknessMeters);
  const layer1BaseDepth = Math.min(ELEVATION_POLICY.TUNNEL_DEPTH, minDepthForClearance);

  const targetFloorElevation = Number(
    (layer1BaseDepth - (tunnelLayer - 1) * ELEVATION_POLICY.TUNNEL_LAYER_STEP).toFixed(4)
  );
  const targetRoofSoffitElevation = Number(
    Math.min(-roofCoverThicknessMeters, targetFloorElevation + requiredClearanceMeters).toFixed(4)
  );

  return {
    requiredClearanceMeters: Number(requiredClearanceMeters.toFixed(3)),
    roofCoverThicknessMeters,
    targetFloorElevation,
    targetRoofSoffitElevation,
  };
}

/**
 * Helper to determine if a RoadClass belongs to the non-vehicular path/pedestrian category.
 * Used for semantic categorization, width rules, and 2D carriageway clipping priority
 * (NOT for assigning a different physical elevation).
 */
export function isNonVehicularRoadClass(roadClass: RoadClass): boolean {
  return (
    roadClass === 'path' ||
    roadClass === 'footway' ||
    roadClass === 'steps' ||
    roadClass === 'bridleway' ||
    roadClass === 'track' ||
    roadClass === 'cycleway' ||
    roadClass === 'pedestrian' ||
    roadClass === 'platform' ||
    roadClass === 'pier'
  );
}

/**
 * Computes a deterministic integer hash from a string ID (e.g. OSM feature ID).
 * Used only for deterministic procedural details (such as foliage variation), never for Y-elevation offsets.
 */
export function hashFeatureId(id: string | number): number {
  const str = String(id);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * Determines the physical Y-elevation for a road feature.
 * - All ordinary at-grade roads and paths share the uniform physical baseline ELEVATION_POLICY.ROAD_SURFACE (0.050m).
 * - Bridges: relational grade-separation clearance (>= 2.8m above grade).
 * - Tunnels: subterranean depth (<= ELEVATION_POLICY.TUNNEL_DEPTH = -4.2m, deepened further when explicit maxheight requires it).
 */
export function getRoadElevation(
  roadClass: RoadClass,
  layer: number = 0,
  isBridge: boolean = false,
  isTunnel: boolean = false,
  _featureId?: string,
  maxheightMeters?: number
): number {
  if (isTunnel) {
    return resolveTunnelClearanceAndDepth({
      domain: 'road',
      layer,
      roadClass,
      maxheightMeters,
    }).targetFloorElevation;
  }

  if (isBridge || layer > 0) {
    const bridgeLayer = layer > 0 ? layer : 1;
    return (
      ELEVATION_POLICY.ROAD_SURFACE +
      ELEVATION_POLICY.BRIDGE_BASE_CLEARANCE +
      (bridgeLayer - 1) * ELEVATION_POLICY.BRIDGE_LAYER_STEP
    );
  }

  return ELEVATION_POLICY.ROAD_BASE_TIERS[roadClass] ?? ELEVATION_POLICY.ROAD_SURFACE;
}

/**
 * Determines the physical Y-elevation for a railway feature (ballast bed, cross-tie sleepers, and steel rails).
 */
export function getRailwayElevations(
  layer: number = 0,
  isBridge: boolean = false,
  isTunnel: boolean = false,
  clearanceOptions?: {
    railwayType?: string;
    electrified?: boolean | string;
    maxheightMeters?: number;
  }
): { ballast: number; sleepers: number; rails: number } {
  if (isTunnel) {
    const depth = resolveTunnelClearanceAndDepth({
      domain: 'railway',
      layer,
      railwayType: clearanceOptions?.railwayType,
      electrified: clearanceOptions?.electrified,
      maxheightMeters: clearanceOptions?.maxheightMeters,
    }).targetFloorElevation;
    return {
      ballast: depth,
      sleepers: Number((depth + 0.1).toFixed(4)),
      rails: Number((depth + 0.25).toFixed(4)),
    };
  }

  if (isBridge || layer > 0) {
    const bridgeLayer = layer > 0 ? layer : 1;
    const bridgeElevation =
      ELEVATION_POLICY.RAILWAY_BALLAST +
      ELEVATION_POLICY.BRIDGE_BASE_CLEARANCE +
      (bridgeLayer - 1) * ELEVATION_POLICY.BRIDGE_LAYER_STEP;
    return {
      ballast: bridgeElevation,
      sleepers: bridgeElevation + 0.012,
      rails: bridgeElevation + 0.025,
    };
  }

  return {
    ballast: ELEVATION_POLICY.RAILWAY_BALLAST,
    sleepers: ELEVATION_POLICY.RAILWAY_SLEEPERS,
    rails: ELEVATION_POLICY.RAILWAY_RAILS,
  };
}

/**
 * Three.js material polygonOffset configurations.
 * Mutually exclusive ground-cover fills do not rely on polygonOffset against each other
 * because their 2D footprints are disjoint after Boolean subtraction.
 * Intentional decals and raised transportation overlays use selective negative depth bias
 * to guarantee multi-step separation even on 16-bit depth buffers at steep oblique tilts (72°).
 */
export const DEPTH_OFFSET_CONFIG = {
  subzoning: {
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
  water: {
    polygonOffset: true,
    polygonOffsetFactor: -0.5,
    polygonOffsetUnits: -0.5,
  },
  parks: {
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
  pavedLots: {
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
  parkingSpaces: {
    polygonOffset: true,
    polygonOffsetFactor: -0.6,
    polygonOffsetUnits: -0.6,
  },
  pitchMarkings: {
    polygonOffset: true,
    polygonOffsetFactor: -1.0,
    polygonOffsetUnits: -1.0,
  },
  parkingMarkings: {
    polygonOffset: true,
    polygonOffsetFactor: -1.0,
    polygonOffsetUnits: -1.0,
  },
  paths: {
    polygonOffset: true,
    polygonOffsetFactor: -2.0,
    polygonOffsetUnits: -2.0,
  },
  roads: {
    polygonOffset: true,
    polygonOffsetFactor: -2.5,
    polygonOffsetUnits: -2.5,
  },
  railways: {
    polygonOffset: true,
    polygonOffsetFactor: -3.0,
    polygonOffsetUnits: -3.0,
  },
  railwaySleepers: {
    polygonOffset: true,
    polygonOffsetFactor: -3.5,
    polygonOffsetUnits: -3.5,
  },
  railwayRails: {
    polygonOffset: true,
    polygonOffsetFactor: -4.0,
    polygonOffsetUnits: -4.0,
  },
  markings: {
    polygonOffset: true,
    polygonOffsetFactor: -3.2,
    polygonOffsetUnits: -3.2,
  },
};

/**
 * Returns the physical Y-elevation, renderOrder, and depth bias config for a landuse subtype.
 * All ordinary ground-cover fills share the uniform flush GROUND_COVER_SURFACE (+0.025m),
 * while `parking_space` decals sit at +0.028m.
 */
export function getLanduseElevationAndOffset(subtype: string): {
  elevation: number;
  renderOrder: number;
  depthOffset: {
    polygonOffset?: boolean;
    polygonOffsetFactor?: number;
    polygonOffsetUnits?: number;
  };
} {
  if (subtype === 'parking_space') {
    return {
      elevation: ELEVATION_POLICY.PARKING_SPACE_SURFACE,
      renderOrder: 4,
      depthOffset: DEPTH_OFFSET_CONFIG.parkingSpaces,
    };
  }

  return {
    elevation: ELEVATION_POLICY.GROUND_COVER_SURFACE,
    renderOrder: 1,
    depthOffset: {},
  };
}
