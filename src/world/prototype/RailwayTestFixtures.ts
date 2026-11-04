import {
  BuildingFeature,
  LanduseFeature,
  ParkFeature,
  ProcessedMapData,
  RailwayFeature,
  RoadFeature,
} from '../../types/MapFeature';

export type RailwayPrototypeZoneId =
  | 'overview'
  | 'straight_curved'
  | 'single_turnout'
  | 'scissors_crossover'
  | 'station_throat';

export interface RailwayPrototypeZoneCameraPreset {
  id: RailwayPrototypeZoneId;
  label: string;
  description: string;
  target: [number, number, number];
  defaultZoom: number;
}

export const RAILWAY_PROTOTYPE_ZONE_PRESETS: Record<
  RailwayPrototypeZoneId,
  RailwayPrototypeZoneCameraPreset
> = {
  overview: {
    id: 'overview',
    label: 'All 4 Zones (Overview)',
    description: 'Full switchyard benchmark tile spanning straight/curved, turnouts, scissors crossover, and 6-track station throat.',
    target: [0, 0, -5],
    defaultZoom: 1.0,
  },
  straight_curved: {
    id: 'straight_curved',
    label: 'Zone 1: Straight, Curved & Chained Ways',
    description: 'Parallel straight/curved tracks (R=75m) + 18 chained short (<0.9m) OSM way segments.',
    target: [-145, 0, -85],
    defaultZoom: 8.0,
  },
  single_turnout: {
    id: 'single_turnout',
    label: 'Zone 2: Single Turnouts (1:9 & 1:12)',
    description: 'Right-hand 1:9 (6.3°) and left-hand 1:12 (4.8°) diverging switches into parallel sidings.',
    target: [-5, 0, -85],
    defaultZoom: 8.0,
  },
  scissors_crossover: {
    id: 'scissors_crossover',
    label: 'Zone 3: Scissors Crossover (Diamond)',
    description: 'Two parallel mainlines with intersecting diagonal crossovers forming 4 switches + 1 central frog diamond.',
    target: [135, 0, -85],
    defaultZoom: 8.0,
  },
  station_throat: {
    id: 'station_throat',
    label: 'Zone 4: 6-Track Station Throat',
    description: 'Dense 6-track station throat with double ladder crossovers, converging sidings, and passenger platforms.',
    target: [-10, 0, 70],
    defaultZoom: 3.0,
  },
};

function buildArcPoints(
  startX: number,
  startZ: number,
  radius: number,
  startAngleRad: number,
  endAngleRad: number,
  steps: number
): [number, number][] {
  const cx = startX - Math.sin(startAngleRad) * radius;
  const cz = startZ - Math.cos(startAngleRad) * radius;
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ang = startAngleRad + (endAngleRad - startAngleRad) * t;
    pts.push([
      Number((cx + Math.sin(ang) * radius).toFixed(3)),
      Number((cz + Math.cos(ang) * radius).toFixed(3)),
    ]);
  }
  return pts;
}

/**
 * Generates a realistic S-curve turnout / crossover polyline between `(x0, z0)` and `(x1, z1)`
 * with smooth entry/exit tangents matching a railway switch blade and frog crossing.
 */
function buildTurnoutCurve(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  leadMeters: number,
  steps: number = 14
): [number, number][] {
  const pts: [number, number][] = [];
  const dx = x1 - x0;
  const dz = z1 - z0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + dx * t;
    // Cubic Hermite S-curve for smooth switch divergence and realignment
    let z: number;
    if (t <= 0.45) {
      // Quadratic switch-blade + frog divergence
      const u = t / 0.45;
      z = z0 + dz * 0.45 * (u * u * (1.35 - 0.35 * u));
    } else {
      const s = t;
      const h = s * s * (3 - 2 * s);
      z = z0 + dz * h;
    }
    pts.push([Number(x.toFixed(3)), Number(z.toFixed(3))]);
  }
  // Ensure exact endpoints
  pts[0] = [x0, z0];
  pts[pts.length - 1] = [x1, z1];
  void leadMeters;
  return pts;
}

/**
 * Creates the canonical Milestone 2.1 Railway Switchyard & Station Throat Benchmark Dataset.
 * Covers all 4 required topological scenarios:
 * 1. Straight and curved tracks + chained short (`0.85 m`) OSM segments
 * 2. Single turnouts ($1:9$ and $1:12$)
 * 3. Scissors crossover (2 parallel tracks with intersecting X-crossovers)
 * 4. Dense 6-track station throat with ladder crossovers and platforms
 */
export function createRailwayPrototypeFixtureData(): ProcessedMapData {
  const railways: RailwayFeature[] = [];
  const roads: RoadFeature[] = [];
  const buildings: BuildingFeature[] = [];
  const parks: ParkFeature[] = [];
  const landuse: LanduseFeature[] = [];

  const makeRail = (
    id: string,
    name: string,
    points: [number, number][],
    opts?: {
      service?: string;
      usage?: string;
      nodeIds?: string[];
      railwayType?: RailwayFeature['railwayType'];
    }
  ): RailwayFeature => ({
    id,
    sourceFeatureId: id,
    sourceFeatureIds: [id],
    type: 'railway',
    name,
    points,
    nodeIds: opts?.nodeIds,
    railwayType: opts?.railwayType || 'rail',
    cartoLabel: 'Standard Railway',
    primaryTag: 'railway=rail',
    width: 3.5,
    gauge: 1435,
    layer: 0,
    isBridge: false,
    isTunnel: false,
    osmTags: {
      railway: opts?.railwayType || 'rail',
      gauge: '1435',
      name,
      ...(opts?.service ? { service: opts.service } : {}),
      ...(opts?.usage ? { usage: opts.usage } : { usage: 'main' }),
    },
  });

  // ============================================================================
  // ZONE 1: Straight, Curved (R=75m) & Chained Short (<0.9m) Segments
  // Centered around [-145, -85]
  // ============================================================================
  const z1StraightA: [number, number][] = [
    [-210, -92],
    [-160, -92],
  ];
  const z1CurveA = buildArcPoints(-160, -92, 75, 0, Math.PI / 4, 16);
  railways.push(
    makeRail('z1_main_outer', 'Zone 1 Outer Curved Mainline', [...z1StraightA, ...z1CurveA.slice(1)], {
      usage: 'main',
    })
  );

  const z1StraightB: [number, number][] = [
    [-210, -88],
    [-160, -88],
  ];
  const z1CurveB = buildArcPoints(-160, -88, 71, 0, Math.PI / 4, 16);
  railways.push(
    makeRail('z1_main_inner', 'Zone 1 Inner Curved Mainline', [...z1StraightB, ...z1CurveB.slice(1)], {
      usage: 'main',
    })
  );

  // Chained short ways (18 segments of 0.85m = 15.3m total, each < 1.45m sleeper spacing)
  const shortStart = -185;
  const shortSegLen = 0.85;
  for (let s = 0; s < 18; s++) {
    const x0 = Number((shortStart + s * shortSegLen).toFixed(3));
    const x1 = Number((shortStart + (s + 1) * shortSegLen).toFixed(3));
    railways.push(
      makeRail(
        `z1_chained_short_${s}`,
        `Zone 1 Short Chained Way #${s + 1} (0.85m)`,
        [
          [x0, -82],
          [x1, -82],
        ],
        {
          usage: 'main',
          nodeIds: [`node_z1_short_${s}`, `node_z1_short_${s + 1}`],
        }
      )
    );
  }
  // Continuation before and after the chained short ways
  railways.push(
    makeRail(
      'z1_chained_lead_in',
      'Zone 1 Chained Track Lead-In',
      [
        [-210, -82],
        [shortStart, -82],
      ],
      { usage: 'main', nodeIds: ['node_z1_short_lead', 'node_z1_short_0'] }
    ),
    makeRail(
      'z1_chained_lead_out',
      'Zone 1 Chained Track Lead-Out',
      [
        [Number((shortStart + 18 * shortSegLen).toFixed(3)), -82],
        [-130, -82],
      ],
      { usage: 'main', nodeIds: ['node_z1_short_18', 'node_z1_short_end'] }
    )
  );

  // ============================================================================
  // ZONE 2: Single Turnouts (1:9 Right-Hand & 1:12 Left-Hand)
  // Centered around [-5, -85]
  // ============================================================================
  // Through Mainline split at two switch nodes: (-35, -86) and (-15, -86)
  railways.push(
    makeRail(
      'z2_main_1',
      'Zone 2 Through Mainline West',
      [
        [-65, -86],
        [-35, -86],
      ],
      { usage: 'main', nodeIds: ['node_z2_w', 'node_z2_sw1'] }
    ),
    makeRail(
      'z2_main_2',
      'Zone 2 Through Mainline Center',
      [
        [-35, -86],
        [-10, -86],
      ],
      { usage: 'main', nodeIds: ['node_z2_sw1', 'node_z2_sw2'] }
    ),
    makeRail(
      'z2_main_3',
      'Zone 2 Through Mainline East',
      [
        [-10, -86],
        [55, -86],
      ],
      { usage: 'main', nodeIds: ['node_z2_sw2', 'node_z2_e'] }
    )
  );

  // Right-hand 1:9 Turnout diverging from (-35, -86) to parallel siding at z = -90.2
  const turnout1Pts = buildTurnoutCurve(-35, -86, -5, -90.2, 30, 14);
  railways.push(
    makeRail('z2_turnout_1_9', 'Zone 2 1:9 Turnout Branch', turnout1Pts, {
      service: 'siding',
      usage: 'branch',
      nodeIds: ['node_z2_sw1', 'node_z2_siding1_start'],
    }),
    makeRail(
      'z2_siding_south',
      'Zone 2 South Parallel Siding',
      [
        [-5, -90.2],
        [55, -90.2],
      ],
      {
        service: 'siding',
        usage: 'branch',
        nodeIds: ['node_z2_siding1_start', 'node_z2_siding1_end'],
      }
    )
  );

  // Left-hand 1:12 Turnout diverging from (-10, -86) to north siding at z = -81.8
  const turnout2Pts = buildTurnoutCurve(-10, -86, 26, -81.8, 36, 14);
  railways.push(
    makeRail('z2_turnout_1_12', 'Zone 2 1:12 Turnout Branch', turnout2Pts, {
      service: 'siding',
      usage: 'branch',
      nodeIds: ['node_z2_sw2', 'node_z2_siding2_start'],
    }),
    makeRail(
      'z2_siding_north',
      'Zone 2 North Parallel Siding',
      [
        [26, -81.8],
        [55, -81.8],
      ],
      {
        service: 'siding',
        usage: 'branch',
        nodeIds: ['node_z2_siding2_start', 'node_z2_siding2_end'],
      }
    )
  );

  // ============================================================================
  // ZONE 3: Scissors Crossover (2 Parallel Tracks + Intersecting X-Crossovers)
  // Centered around [135, -85]
  // ============================================================================
  // North Mainline (z = -87) & South Mainline (z = -83), 4.0m center spacing
  railways.push(
    makeRail(
      'z3_north_w',
      'Zone 3 North Mainline West',
      [
        [85, -87],
        [115, -87],
      ],
      { usage: 'main', nodeIds: ['node_z3_nw', 'node_z3_nsw_w'] }
    ),
    makeRail(
      'z3_north_mid',
      'Zone 3 North Mainline Throat',
      [
        [115, -87],
        [155, -87],
      ],
      { usage: 'main', nodeIds: ['node_z3_nsw_w', 'node_z3_nsw_e'] }
    ),
    makeRail(
      'z3_north_e',
      'Zone 3 North Mainline East',
      [
        [155, -87],
        [190, -87],
      ],
      { usage: 'main', nodeIds: ['node_z3_nsw_e', 'node_z3_ne'] }
    ),
    makeRail(
      'z3_south_w',
      'Zone 3 South Mainline West',
      [
        [85, -83],
        [115, -83],
      ],
      { usage: 'main', nodeIds: ['node_z3_sw', 'node_z3_ssw_w'] }
    ),
    makeRail(
      'z3_south_mid',
      'Zone 3 South Mainline Throat',
      [
        [115, -83],
        [155, -83],
      ],
      { usage: 'main', nodeIds: ['node_z3_ssw_w', 'node_z3_ssw_e'] }
    ),
    makeRail(
      'z3_south_e',
      'Zone 3 South Mainline East',
      [
        [155, -83],
        [190, -83],
      ],
      { usage: 'main', nodeIds: ['node_z3_ssw_e', 'node_z3_se'] }
    )
  );

  // Diagonal Crossover 1: (115, -87) -> (155, -83)
  railways.push(
    makeRail(
      'z3_scissors_diag_1',
      'Zone 3 Scissors Crossover NW-to-SE',
      buildTurnoutCurve(115, -87, 155, -83, 40, 16),
      {
        service: 'crossover',
        usage: 'branch',
        nodeIds: ['node_z3_nsw_w', 'node_z3_ssw_e'],
      }
    ),
    // Diagonal Crossover 2: (115, -83) -> (155, -87)
    makeRail(
      'z3_scissors_diag_2',
      'Zone 3 Scissors Crossover SW-to-NE',
      buildTurnoutCurve(115, -83, 155, -87, 40, 16),
      {
        service: 'crossover',
        usage: 'branch',
        nodeIds: ['node_z3_ssw_w', 'node_z3_nsw_e'],
      }
    )
  );

  // ============================================================================
  // ZONE 4: Dense 6-Track Station Throat with Double Ladder Crossovers
  // Centered around [-10, 70]
  // ============================================================================
  const numStationTracks = 6;
  const trackSpacing = 4.0; // 4.0m standard center-to-center yard spacing
  const baseZ = 58.0; // Tracks at Z = 58, 62, 66, 70, 74, 78

  for (let t = 0; t < numStationTracks; t++) {
    const z = baseZ + t * trackSpacing;
    const swLadder1X = -95 + t * 24;
    const swLadder2X = -45 + t * 24;

    railways.push(
      makeRail(
        `z4_track_${t + 1}_west`,
        `Station Track ${t + 1} West Approach`,
        [
          [-160, z],
          [swLadder1X, z],
        ],
        {
          usage: 'main',
          nodeIds: [`node_z4_t${t}_w`, `node_z4_t${t}_sw1`],
        }
      ),
      makeRail(
        `z4_track_${t + 1}_mid`,
        `Station Track ${t + 1} Throat Span`,
        [
          [swLadder1X, z],
          [swLadder2X, z],
        ],
        {
          usage: 'main',
          nodeIds: [`node_z4_t${t}_sw1`, `node_z4_t${t}_sw2`],
        }
      ),
      makeRail(
        `z4_track_${t + 1}_east`,
        `Station Track ${t + 1} Platform Berth`,
        [
          [swLadder2X, z],
          [165, z],
        ],
        {
          usage: 'main',
          nodeIds: [`node_z4_t${t}_sw2`, `node_z4_t${t}_e`],
        }
      )
    );
  }

  // Ladder 1: Ascending crossovers connecting Track t -> Track t+1
  for (let t = 0; t < numStationTracks - 1; t++) {
    const z0 = baseZ + t * trackSpacing;
    const z1 = baseZ + (t + 1) * trackSpacing;
    const x0 = -95 + t * 24;
    const x1 = -95 + (t + 1) * 24;
    railways.push(
      makeRail(
        `z4_ladder1_${t + 1}_to_${t + 2}`,
        `Station Throat West Ladder ${t + 1}->${t + 2}`,
        buildTurnoutCurve(x0, z0, x1, z1, 24, 12),
        {
          service: 'crossover',
          usage: 'branch',
          nodeIds: [`node_z4_t${t}_sw1`, `node_z4_t${t + 1}_sw1`],
        }
      )
    );
  }

  // Ladder 2: Descending crossovers connecting Track t+1 -> Track t
  for (let t = 0; t < numStationTracks - 1; t++) {
    const z0 = baseZ + (t + 1) * trackSpacing;
    const z1 = baseZ + t * trackSpacing;
    const x0 = -45 + t * 24;
    const x1 = -45 + (t + 1) * 24;
    railways.push(
      makeRail(
        `z4_ladder2_${t + 2}_to_${t + 1}`,
        `Station Throat East Ladder ${t + 2}->${t + 1}`,
        buildTurnoutCurve(x0, z0, x1, z1, 24, 12),
        {
          service: 'crossover',
          usage: 'branch',
          nodeIds: [`node_z4_t${t + 1}_sw2`, `node_z4_t${t}_sw2`],
        }
      )
    );
  }

  // Add Island Passenger Platforms in the East Station Berth (X in [75, 160])
  const platformZs = [baseZ - 3.6, baseZ + 6.0, baseZ + 14.0, baseZ + 23.6];
  platformZs.forEach((pz, idx) => {
    roads.push({
      id: `z4_platform_${idx + 1}`,
      sourceFeatureId: `z4_platform_${idx + 1}`,
      sourceFeatureIds: [`z4_platform_${idx + 1}`],
      type: 'road',
      name: `Station Platform ${idx + 1}`,
      points: [
        [75, pz],
        [160, pz],
      ],
      roadClass: 'platform',
      cartoLabel: 'Transit Platform',
      primaryTag: 'railway=platform',
      width: 3.2,
      layer: 0,
      isBridge: false,
      isTunnel: false,
      osmTags: { railway: 'platform', name: `Platform ${idx + 1}` },
    });
  });

  // Add Station Concourse Building adjacent to Zone 4
  buildings.push({
    id: 'z4_station_building',
    sourceFeatureId: 'z4_station_building',
    type: 'building',
    name: 'Hengelo Oost Benchmark Terminal',
    footprint: [
      [
        [80, 34],
        [155, 34],
        [155, 50],
        [80, 50],
        [80, 34],
      ],
    ],
    height: 11.5,
    minHeight: 0,
    levels: 3,
    buildingType: 'train_station',
    cartoLabel: 'Train Station',
    primaryTag: 'building=train_station',
    osmTags: { building: 'train_station', name: 'Hengelo Oost Benchmark Terminal' },
  });

  // Underlying railway yard landuse apron
  landuse.push({
    id: 'yard_landuse_z4',
    sourceFeatureId: 'yard_landuse_z4',
    type: 'landuse',
    name: 'Station Throat Railway Yard',
    polygon: [
      [
        [-225, -110],
        [205, -110],
        [205, 100],
        [-225, 100],
        [-225, -110],
      ],
    ],
    landuseType: 'railway',
    cartoLabel: 'Railway Landuse',
    primaryTag: 'landuse=railway',
    osmTags: { landuse: 'railway' },
  });

  return {
    regionName: 'M2.1 Railway Switchyard & Station Throat Benchmark',
    centerLonLat: [6.7935, 52.2625],
    bounds: {
      minX: -225,
      maxX: 205,
      minZ: -110,
      maxZ: 100,
      widthMeters: 430,
      depthMeters: 210,
    },
    buildings,
    roads,
    railways,
    waterBodies: [],
    water: [],
    linearWaterways: [],
    parks,
    landuse,
    barriers: [],
    landmarks: [],
    stats: {
      totalBuildings: buildings.length,
      totalRoads: roads.length,
      totalRoadSegments: roads.length,
      totalRailways: railways.length,
      totalRailwaySegments: railways.length,
      totalWaterPolygons: 0,
      totalLinearWaterways: 0,
      totalParkPolygons: 0,
      totalLandusePolygons: landuse.length,
      totalBarriers: 0,
      totalLandmarks: 0,
      areaKm2: Number(((430 * 210) / 1_000_000).toFixed(3)),
    },
    diagnostics: {
      sourceFeaturesReceived: railways.length + roads.length + buildings.length + landuse.length,
      sourceFeaturesClassified: railways.length + roads.length + buildings.length + landuse.length,
      sourceFeaturesRendered: railways.length + roads.length + buildings.length + landuse.length,
      constructedMeshesCount: 0,
      totalFeaturesReceived: railways.length + roads.length + buildings.length + landuse.length,
      totalFeaturesParsed: railways.length + roads.length + buildings.length + landuse.length,
      totalFeaturesRendered: railways.length + roads.length + buildings.length + landuse.length,
      byGeometryType: {
        Point: 0,
        MultiPoint: 0,
        LineString: railways.length + roads.length,
        Polygon: buildings.length + landuse.length,
        MultiPolygon: 0,
        MultiLineString: 0,
        GeometryCollection: 0,
        Unknown: 0,
      },
      parsedByCategory: {
        buildings: buildings.length,
        roads: roads.length,
        railways: railways.length,
        waterBodies: 0,
        linearWaterways: 0,
        parks: 0,
        landuse: landuse.length,
        barriers: 0,
        landmarks: 0,
      },
      geometryPartsGenerated: {
        total: railways.length + roads.length + buildings.length + landuse.length,
        byCategory: {
          buildings: buildings.length,
          roads: roads.length,
          railways: railways.length,
          waterBodies: 0,
          linearWaterways: 0,
          parks: 0,
          landuse: landuse.length,
          barriers: 0,
          landmarks: 0,
        },
      },
      cartoSubtypesCount: {
        'Standard Railway': railways.length,
        'Transit Platform': roads.length,
        'Train Station': buildings.length,
      },
      skippedUnsupported: { total: 0, byTag: {} },
      rejectedInvalid: { total: 0, byReason: {} },
      featuresClippedByBoundary: { clippedCount: 0, omittedOutsideCount: 0, sampleIds: [] },
      featuresFullySubtracted: { count: 0, sampleIds: [] },
      clippingFailures: { count: 0, sampleIds: [] },
    },
  };
}
