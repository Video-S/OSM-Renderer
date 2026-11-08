import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_THEMES } from '../styles/mapThemes';
import {
  PointLandmarkFeature,
  ProcessedMapData,
  RailwayFeature,
  RawGeoJsonProperties,
  RoadFeature,
} from '../types/MapFeature';
import {
  adaptInfrastructureGraphToRenderDescriptors,
  buildInfrastructureRenderDescriptors,
  DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS,
  GeometryBuilder,
  normalizeInfrastructureRenderOptions,
  parseInfrastructureRenderOptionsFromSearch,
  parseInfrastructureRenderSource,
  prepareInfrastructureRenderPreview,
  requiresInfrastructureGraphPreview,
  resolveInspectedFeature,
  validateInfrastructureRenderDescriptors,
  type BuiltSceneGeometry,
  type InfrastructureRenderDescriptorBundle,
} from './GeometryBuilder';
import { buildInfrastructureGraph } from './infrastructure/topology/InfrastructureGraph';
import {
  InfrastructurePointMetadata,
  TopologySourceData,
  UnchainedRailwayPart,
  UnchainedRoadPart,
} from './infrastructure/topology/types';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { buildRailwayPrototypeGroup } from './prototype/RailwayPrototypeBuilder';
import { createRailwayPrototypeFixtureData } from './prototype/RailwayTestFixtures';
import realOsmExtracts from './prototype/realOsmRailwayExtracts.json';

type TestRoadFeature = RoadFeature & {
  lanes?: number;
  oneway?: boolean;
  surface?: string;
};

type TestRailwayFeature = RailwayFeature & {
  gaugeMeters?: number;
  isMainline?: boolean;
  isSecondaryTrack?: boolean;
};

function makeRoad(
  id: string,
  points: [number, number][],
  overrides: Partial<TestRoadFeature> = {}
): TestRoadFeature {
  return {
    id,
    type: 'road',
    sourceFeatureId: overrides.sourceFeatureId ?? id,
    points: points.map((p) => [p[0], p[1]] as [number, number]),
    roadClass: overrides.roadClass ?? 'secondary',
    width: overrides.width ?? 7,
    lanes: overrides.lanes ?? 2,
    oneway: overrides.oneway ?? false,
    isBridge: overrides.isBridge ?? false,
    isTunnel: overrides.isTunnel ?? false,
    layer: overrides.layer ?? 0,
    ...overrides,
  };
}

function makeRailway(
  id: string,
  points: [number, number][],
  overrides: Partial<TestRailwayFeature> = {}
): TestRailwayFeature {
  return {
    id,
    type: 'railway',
    sourceFeatureId: overrides.sourceFeatureId ?? id,
    points: points.map((p) => [p[0], p[1]] as [number, number]),
    railwayType: overrides.railwayType ?? 'rail',
    width: overrides.width ?? 4,
    gaugeMeters: overrides.gaugeMeters ?? 1.435,
    isMainline: overrides.isMainline ?? true,
    isSecondaryTrack: overrides.isSecondaryTrack ?? false,
    isBridge: overrides.isBridge ?? false,
    isTunnel: overrides.isTunnel ?? false,
    layer: overrides.layer ?? 0,
    ...overrides,
  };
}

function makePointFeature(
  id: string,
  point: [number, number],
  osmTags: RawGeoJsonProperties,
  overrides: Partial<PointLandmarkFeature> = {}
): PointLandmarkFeature {
  return {
    id,
    type: 'landmark',
    sourceFeatureId: overrides.sourceFeatureId ?? id,
    position: [point[0], point[1]],
    landmarkType: overrides.landmarkType ?? 'tower',
    height: overrides.height ?? 1,
    osmTags,
    ...overrides,
  };
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const arr = [...items];
  let s = seed >>> 0;
  const nextRand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(nextRand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function createRichSyntheticDataset(): ProcessedMapData & TopologySourceData {
  const roads: TestRoadFeature[] = [
    // 4-way vehicular intersection at [0, 0] (explicit node 1001) + boundary-clipped West arm at [-500, 0]
    makeRoad(
      'way/road-west-east',
      [
        [-500, 0],
        [0, 0],
        [60, 0],
      ],
      {
        sourceFeatureId: 'way/road-west-east',
        nodeIds: ['1000', '1001', '1002'],
        roadClass: 'primary',
        width: 9,
        lanes: 2,
        oneway: false,
        surface: 'asphalt',
        osmTags: {
          highway: 'primary',
          surface: 'asphalt',
          _nodeIdsByPart: [['1000', '1001'], ['1001', '1002']],
          nestedMeta: {
            flags: [1, 2, 3],
            classification: { code: 'primary_trunk' },
          },
        },
      }
    ),
    makeRoad(
      'way/road-south-north',
      [
        [0, -40],
        [0, -20],
        [0, 0],
        [0, 40],
      ],
      {
        sourceFeatureId: 'way/road-south-north',
        nodeIds: ['1003', '5002', '1001', '1004'],
        roadClass: 'secondary',
        width: 7,
        lanes: 2,
        oneway: true,
        osmTags: { highway: 'secondary', oneway: 'yes' },
      }
    ),
    // Reverse oneway road & conditional oneway road
    makeRoad(
      'way/road-reverse-oneway',
      [
        [60, 0],
        [60, 35],
      ],
      {
        sourceFeatureId: 'way/road-reverse-oneway',
        nodeIds: ['1002', '1005'],
        roadClass: 'tertiary',
        width: 6,
        lanes: 1,
        oneway: true,
        osmTags: { highway: 'tertiary', oneway: '-1' },
      }
    ),
    makeRoad(
      'way/road-unknown-oneway',
      [
        [60, 35],
        [95, 35],
      ],
      {
        sourceFeatureId: 'way/road-unknown-oneway',
        nodeIds: ['1005', '1006'],
        roadClass: 'residential',
        width: 5.5,
        lanes: 1,
        oneway: false,
        osmTags: { highway: 'residential', oneway: 'reversible', tunnel: 'culvert' },
      }
    ),
    // Footway meeting vehicular road at [0, 40] (single vehicular way + path = cross-tier only interaction)
    makeRoad(
      'way/footway-cross-tier',
      [
        [-25, 40],
        [0, 40],
        [25, 40],
      ],
      {
        sourceFeatureId: 'way/footway-cross-tier',
        nodeIds: ['2001', '1004', '2002'],
        roadClass: 'footway',
        width: 2.0,
        lanes: 1,
        osmTags: { highway: 'footway', surface: 'paving_stones' },
      }
    ),
    // Parallel multi-edge between [60, 0] and [100, 0]
    makeRoad(
      'way/road-parallel-north',
      [
        [60, 0],
        [80, 12],
        [100, 0],
      ],
      {
        sourceFeatureId: 'way/road-parallel-north',
        nodeIds: ['1002', '1010', '1011'],
        roadClass: 'service',
        width: 4,
      }
    ),
    makeRoad(
      'way/road-parallel-south',
      [
        [60, 0],
        [80, -12],
        [100, 0],
      ],
      {
        sourceFeatureId: 'way/road-parallel-south',
        nodeIds: ['1002', '1012', '1011'],
        roadClass: 'service',
        width: 4,
      }
    ),
    // Isolated closed roundabout loop
    makeRoad(
      'way/road-closed-loop',
      [
        [140, 0],
        [150, 10],
        [160, 0],
        [150, -10],
        [140, 0],
      ],
      {
        sourceFeatureId: 'way/road-closed-loop',
        nodeIds: ['3001', '3002', '3003', '3004', '3001'],
        roadClass: 'tertiary',
        width: 6,
      }
    ),
    // P-loop stem + loop returning to intermediate node 3101
    makeRoad(
      'way/road-p-loop',
      [
        [100, 0],
        [120, 0],
        [130, 12],
        [120, 24],
        [120, 0],
      ],
      {
        sourceFeatureId: 'way/road-p-loop',
        nodeIds: ['1011', '3101', '3102', '3103', '3101'],
        roadClass: 'residential',
        width: 5,
      }
    ),
    // Exact duplicate road to verify deduplicatedFeatureIds & deduplicatedMap
    makeRoad(
      'way/road-z-duplicate-rev',
      [
        [60, 35],
        [95, 35],
      ],
      {
        sourceFeatureId: 'way/road-z-duplicate-rev',
        nodeIds: ['1005', '1006'],
        roadClass: 'residential',
        width: 5.5,
        lanes: 1,
        oneway: false,
        osmTags: { highway: 'residential', oneway: 'reversible', tunnel: 'culvert' },
      }
    ),
    // Road bridge transition + overpass over railway at [30, -20]
    makeRoad(
      'way/road-approach-south',
      [
        [30, -60],
        [30, -35],
      ],
      {
        sourceFeatureId: 'way/road-approach-south',
        nodeIds: ['4001', '4002'],
        roadClass: 'secondary',
        width: 7,
        isBridge: false,
        layer: 0,
      }
    ),
    makeRoad(
      'way/road-bridge-span',
      [
        [30, -35],
        [30, -5],
      ],
      {
        sourceFeatureId: 'way/road-bridge-span',
        nodeIds: ['4002', '4003'],
        roadClass: 'secondary',
        width: 7,
        isBridge: true,
        layer: 1,
        osmTags: { highway: 'secondary', bridge: 'yes', layer: '1' },
      }
    ),
    makeRoad(
      'way/road-approach-north',
      [
        [30, -5],
        [30, 25],
      ],
      {
        sourceFeatureId: 'way/road-approach-north',
        nodeIds: ['4003', '4004'],
        roadClass: 'secondary',
        width: 7,
        isBridge: false,
        layer: 0,
      }
    ),
  ];

  const railways: TestRailwayFeature[] = [
    // Mainline track passing through level crossing at [0, -20] (node 5002) and under road bridge at [30, -20],
    // then reaching confirmed turnout at [50, -20] (node 5003)
    makeRailway(
      'way/rail-main-trunk',
      [
        [-60, -20],
        [0, -20],
        [50, -20],
      ],
      {
        sourceFeatureId: 'way/rail-main-trunk',
        nodeIds: ['5001', '5002', '5003'],
        railwayType: 'rail',
        gaugeMeters: 1.435,
        isMainline: true,
        isSecondaryTrack: false,
        osmTags: {
          railway: 'rail',
          gauge: '1435',
          electrified: 'contact_line',
          usage: 'main',
          _nodeIdsByPart: [['5001', '5002'], ['5002', '5003']],
          nestedSubsystem: {
            signaling: 'ETCS_Level_2',
            powerSpecs: { voltageKv: 25, freqHz: 50 },
          },
        },
      }
    ),
    // Confirmed switch continuation straight East from [50, -20] to [110, -20] (through flat diamond crossing at [80, -20])
    makeRailway(
      'way/rail-main-through',
      [
        [50, -20],
        [80, -20],
        [110, -20],
      ],
      {
        sourceFeatureId: 'way/rail-main-through',
        nodeIds: ['5003', '5004', '5005'],
        railwayType: 'rail',
        gaugeMeters: 1.435,
        isMainline: true,
        isSecondaryTrack: false,
        osmTags: {
          railway: 'rail',
          gauge: '1435',
          electrified: 'contact_line',
          usage: 'main',
        },
      }
    ),
    // Confirmed switch diverging siding branch from [50, -20]
    makeRailway(
      'way/rail-siding-diverging',
      [
        [50, -20],
        [85, -12],
      ],
      {
        sourceFeatureId: 'way/rail-siding-diverging',
        nodeIds: ['5003', '5006'],
        railwayType: 'rail',
        gaugeMeters: 1.435,
        isMainline: false,
        isSecondaryTrack: true,
        osmTags: {
          railway: 'rail',
          gauge: '1435',
          electrified: 'no',
          service: 'siding',
        },
      }
    ),
    // Second railway crossing flat diamond at [80, -20] (node 5004)
    makeRailway(
      'way/rail-diamond-cross',
      [
        [65, -35],
        [80, -20],
        [95, -5],
      ],
      {
        sourceFeatureId: 'way/rail-diamond-cross',
        nodeIds: ['5007', '5004', '5008'],
        railwayType: 'rail',
        gaugeMeters: 1.435,
        isMainline: false,
        isSecondaryTrack: true,
        osmTags: {
          railway: 'rail',
          service: 'spur',
        },
      }
    ),
    // Unresolved symmetric Y-junction at [-90, -20] (three opposing 120 deg branches)
    makeRailway(
      'way/rail-y-1',
      [
        [-120, -20],
        [-90, -20],
      ],
      {
        sourceFeatureId: 'way/rail-y-1',
        nodeIds: ['6001', '6000'],
      }
    ),
    makeRailway(
      'way/rail-y-2',
      [
        [-90, -20],
        [-75, -3],
      ],
      {
        sourceFeatureId: 'way/rail-y-2',
        nodeIds: ['6000', '6002'],
      }
    ),
    makeRailway(
      'way/rail-y-3',
      [
        [-90, -20],
        [-75, -37],
      ],
      {
        sourceFeatureId: 'way/rail-y-3',
        nodeIds: ['6000', '6003'],
      }
    ),
    // Unresolved geometric road-rail crossing (no shared node or level_crossing tag) at [0, -30]
    makeRailway(
      'way/rail-untagged-cross',
      [
        [-25, -30],
        [20, -30],
      ],
      {
        sourceFeatureId: 'way/rail-untagged-cross',
        nodeIds: ['7001', '7002'],
      }
    ),
  ];

  const pointFeatures: PointLandmarkFeature[] = [
    makePointFeature('node/5002', [0, -20], { railway: 'level_crossing' }),
    makePointFeature('node/5003', [50, -20], {
      railway: 'switch',
      ref: 'W12',
      nestedDetails: {
        specs: ['standard', 'heavy_rail'],
        actuator: { type: 'electric' },
      },
    }),
    makePointFeature('node/5004', [80, -20], { railway: 'railway_crossing' }),
  ];

  const roadParts: UnchainedRoadPart[] = roads.map((r) => ({
    id: `${r.id}-0`,
    sourceFeatureId: r.sourceFeatureId || r.id,
    hasExplicitSourceId: true,
    partIndex: 0,
    points: r.points.map((pt) => [pt[0], pt[1]] as [number, number]),
    rawOsmNodeIds: r.nodeIds
      ? r.nodeIds.map((nid, idx) =>
          r.id === 'way/road-west-east' && idx === 0 ? undefined : nid
        )
      : r.points.map(() => undefined),
    clippedAtStart: r.id === 'way/road-west-east',
    clippedAtEnd: false,
    roadClass: r.roadClass,
    width: r.width,
    lanes: r.lanes,
    oneway: r.oneway,
    surface: r.surface,
    name: r.name,
    layer: r.layer ?? 0,
    isBridge: r.isBridge ?? false,
    isTunnel: r.isTunnel ?? false,
    isCulvert: r.osmTags?.tunnel === 'culvert',
    osmTags: r.osmTags ? { ...r.osmTags } : undefined,
  }));

  const railwayParts: UnchainedRailwayPart[] = railways.map((rw) => ({
    id: `${rw.id}-0`,
    sourceFeatureId: rw.sourceFeatureId || rw.id,
    hasExplicitSourceId: true,
    partIndex: 0,
    points: rw.points.map((pt) => [pt[0], pt[1]] as [number, number]),
    rawOsmNodeIds: rw.nodeIds ? [...rw.nodeIds] : rw.points.map(() => undefined),
    clippedAtStart: false,
    clippedAtEnd: false,
    railwayType: rw.railwayType,
    width: rw.width,
    gauge: rw.osmTags?.gauge !== undefined ? String(rw.osmTags.gauge) : undefined,
    electrified:
      rw.osmTags?.electrified !== undefined ? String(rw.osmTags.electrified) : undefined,
    service: rw.osmTags?.service !== undefined ? String(rw.osmTags.service) : undefined,
    usage: rw.osmTags?.usage !== undefined ? String(rw.osmTags.usage) : undefined,
    name: rw.name,
    isSecondaryBranch: rw.isSecondaryTrack ?? false,
    layer: rw.layer ?? 0,
    isBridge: rw.isBridge ?? false,
    isTunnel: rw.isTunnel ?? false,
    osmTags: rw.osmTags ? { ...rw.osmTags } : undefined,
  }));

  const infrastructurePoints: InfrastructurePointMetadata[] = [
    {
      id: 'node/5002',
      hasExplicitSourceId: true,
      rawOsmNodeId: '5002',
      point: [0, -20],
      kind: 'railway_level_crossing',
      osmTags: { railway: 'level_crossing' },
    },
    {
      id: 'node/5003',
      hasExplicitSourceId: true,
      rawOsmNodeId: '5003',
      point: [50, -20],
      kind: 'railway_switch',
      osmTags: {
        railway: 'switch',
        ref: 'W12',
        nestedDetails: {
          specs: ['standard', 'heavy_rail'],
          actuator: { type: 'electric' },
        },
      },
    },
    {
      id: 'node/5004',
      hasExplicitSourceId: true,
      rawOsmNodeId: '5004',
      point: [80, -20],
      kind: 'railway_crossing_flat',
      osmTags: { railway: 'railway_crossing' },
    },
  ];

  return {
    regionName: 'Synthetic M2.3-E1 Adapter Fixture',
    centerLonLat: [6.7935, 52.2625],
    bounds: {
      minX: -500,
      maxX: 500,
      minZ: -500,
      maxZ: 500,
      widthMeters: 1000,
      depthMeters: 1000,
    },
    buildings: [
      {
        id: 'way/building-1',
        sourceFeatureId: 'way/building-1',
        type: 'building',
        footprint: [
          [
            [-35, 10],
            [-15, 10],
            [-15, 25],
            [-35, 25],
            [-35, 10],
          ],
        ],
        height: 14,
        minHeight: 0,
        levels: 4,
        buildingType: 'commercial',
        buildingArchetype: 'commercial',
      },
    ],
    roads,
    railways,
    waterBodies: [],
    linearWaterways: [],
    water: [],
    parks: [],
    landuse: [],
    barriers: [],
    landmarks: pointFeatures,
    roadParts,
    railwayParts,
    infrastructurePoints,
    topologySource: {
      roadParts,
      railwayParts,
      infrastructurePoints,
    },
    diagnostics: {
      sourceFeaturesReceived: 1 + roads.length + railways.length + pointFeatures.length,
      sourceFeaturesClassified: 1 + roads.length + railways.length + pointFeatures.length,
      totalFeaturesParsed: 1 + roads.length + railways.length + pointFeatures.length,
      sourceFeaturesRendered: 0,
      constructedMeshesCount: 0,
      parsedByCategory: {
        buildings: 1,
        roads: roads.length,
        railways: railways.length,
        waterBodies: 0,
        linearWaterways: 0,
        parks: 0,
        landuse: 0,
        barriers: 0,
        landmarks: pointFeatures.length,
      },
      geometryPartsGenerated: {
        total: 0,
        byCategory: {
          buildings: 0,
          roads: 0,
          railways: 0,
          waterBodies: 0,
          linearWaterways: 0,
          parks: 0,
          landuse: 0,
          barriers: 0,
          landmarks: 0,
        },
      },
      skippedUnsupported: { total: 0, byTag: {} },
      rejectedInvalid: { total: 0, byReason: {} },
      byGeometryType: {
        Point: pointFeatures.length,
        MultiPoint: 0,
        LineString: roads.length + railways.length,
        MultiLineString: 0,
        Polygon: 1,
        MultiPolygon: 0,
        GeometryCollection: 0,
        Unknown: 0,
      },
      totalFeaturesReceived: 1 + roads.length + railways.length + pointFeatures.length,
      totalFeaturesRendered: 0,
    },
    stats: {
      totalBuildings: 1,
      totalRoads: roads.length,
      totalRoadSegments: roads.reduce((acc, r) => acc + Math.max(0, r.points.length - 1), 0),
      totalRailways: railways.length,
      totalRailwaySegments: railways.reduce(
        (acc, rw) => acc + Math.max(0, rw.points.length - 1),
        0
      ),
      totalWaterPolygons: 0,
      totalLinearWaterways: 0,
      totalParkPolygons: 0,
      totalLandusePolygons: 0,
      totalBarriers: 0,
      totalLandmarks: pointFeatures.length,
      areaKm2: 1.0,
    },
  };
}

function snapshotSceneNode(obj: THREE.Object3D): any {
  const ud = obj.userData || {};
  const isInst = obj instanceof THREE.InstancedMesh;
  const instCount = isInst ? (obj as THREE.InstancedMesh).count : 0;
  const instMatArr =
    isInst && (obj as THREE.InstancedMesh).instanceMatrix
      ? Array.from((obj as THREE.InstancedMesh).instanceMatrix.array.slice(0, instCount * 16))
      : [];

  let geometrySnapshot: {
    attributes: Record<
      string,
      {
        itemSize: number;
        count: number;
        normalized: boolean;
        values: number[];
      }
    >;
    index: number[] | null;
    groups: Array<{ start: number; count: number; materialIndex?: number }>;
  } | null = null;

  if (obj instanceof THREE.Mesh && obj.geometry instanceof THREE.BufferGeometry) {
    const geom = obj.geometry;
    const attributes: Record<
      string,
      {
        itemSize: number;
        count: number;
        normalized: boolean;
        values: number[];
      }
    > = {};

    const attrNames = Object.keys(geom.attributes).sort();
    for (const name of attrNames) {
      const attr = geom.attributes[name];
      if (attr && attr.array) {
        attributes[name] = {
          itemSize: attr.itemSize,
          count: attr.count,
          normalized: Boolean(attr.normalized),
          values: Array.from(attr.array as ArrayLike<number>),
        };
      }
    }

    const index = geom.index ? Array.from(geom.index.array as ArrayLike<number>) : null;
    const groups = (geom.groups || []).map((g) => ({
      start: g.start,
      count: g.count,
      materialIndex: g.materialIndex,
    }));

    geometrySnapshot = {
      attributes,
      index,
      groups,
    };
  }

  // Complete faceRanges collection (cloned cleanly for deterministic value comparison)
  const faceRanges = Array.isArray(ud.faceRanges)
    ? ud.faceRanges.map((fr: any) => ({
        startFace: fr.startFace,
        endFace: fr.endFace,
        info: fr.info ? JSON.parse(JSON.stringify(fr.info)) : null,
      }))
    : undefined;

  // Complete instanceInfos collection (cloned cleanly for deterministic value comparison)
  const instanceInfos = Array.isArray(ud.instanceInfos)
    ? ud.instanceInfos.map((info: any) => (info ? JSON.parse(JSON.stringify(info)) : null))
    : undefined;

  // Full nested scene object hierarchy and transforms
  const children = (obj.children || []).map(snapshotSceneNode);

  return {
    name: obj.name,
    type: obj.type,
    visible: obj.visible,
    renderOrder: obj.renderOrder,
    position: [obj.position.x, obj.position.y, obj.position.z],
    rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
    scale: [obj.scale.x, obj.scale.y, obj.scale.z],
    matrix: Array.from(obj.matrix.elements),
    matrixWorld: Array.from(obj.matrixWorld.elements),
    userDataKeys: Object.keys(ud).sort(),
    directId: typeof ud.id === 'string' ? ud.id : undefined,
    faceRanges,
    instanceInfos,
    isInstanced: isInst,
    instanceCount: instCount,
    instanceMatrices: instMatArr,
    geometry: geometrySnapshot,
    children,
  };
}

function collectSceneSnapshot(scene: BuiltSceneGeometry) {
  const groups = [
    scene.buildingsGroup,
    scene.roadsGroup,
    scene.railwaysGroup,
    scene.waterGroup,
    scene.parksGroup,
    scene.landuseGroup,
    scene.barriersGroup,
    scene.foliageGroup,
  ];

  const groupSnapshots = groups.map(snapshotSceneNode);

  const provenanceSamples: Array<{
    meshName: string;
    target: string;
    resolved: any;
  }> = [];

  for (const group of groups) {
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const ud = obj.userData || {};
        if (Array.isArray(ud.faceRanges) && ud.faceRanges.length > 0) {
          for (let rIdx = 0; rIdx < ud.faceRanges.length; rIdx++) {
            const fr = ud.faceRanges[rIdx];
            provenanceSamples.push({
              meshName: obj.name,
              target: `range-${rIdx}:start:${fr.startFace}`,
              resolved: resolveInspectedFeature({
                object: obj,
                faceIndex: fr.startFace,
              }),
            });
            if (fr.endFace > fr.startFace + 1) {
              const midFace = Math.floor((fr.startFace + fr.endFace - 1) / 2);
              provenanceSamples.push({
                meshName: obj.name,
                target: `range-${rIdx}:mid:${midFace}`,
                resolved: resolveInspectedFeature({
                  object: obj,
                  faceIndex: midFace,
                }),
              });
            }
          }
        } else if (ud.isInstanced && Array.isArray(ud.instanceInfos) && ud.instanceInfos.length > 0) {
          for (let iIdx = 0; iIdx < ud.instanceInfos.length; iIdx++) {
            provenanceSamples.push({
              meshName: obj.name,
              target: `inst-${iIdx}`,
              resolved: resolveInspectedFeature({
                object: obj,
                instanceId: iIdx,
              }),
            });
          }
        } else if (ud.id) {
          provenanceSamples.push({
            meshName: obj.name,
            target: 'direct',
            resolved: resolveInspectedFeature({ object: obj }),
          });
        }
      }
    });
  }

  return {
    stats: { ...scene.stats },
    resourceStats: {
      ownedGeometriesCount: scene.resources.ownedGeometriesCount,
      ownedMaterialsCount: scene.resources.ownedMaterialsCount,
      disposed: scene.resources.disposed,
    },
    cpuMemStats: scene.resources.getCpuBufferMemoryStats(),
    groupSnapshots,
    provenanceSamples,
  };
}

function serializeDescriptorBundle(bundle: InfrastructureRenderDescriptorBundle) {
  return {
    roadNodes: bundle.roadNodes,
    roadEdges: bundle.roadEdges,
    railwayNodes: bundle.railwayNodes,
    railwayEdges: bundle.railwayEdges,
    railwayFlatCrossings: bundle.railwayFlatCrossings,
    levelCrossings: bundle.levelCrossings,
    gradeTransitions: bundle.gradeTransitions,
    gradeSeparatedCrossings: bundle.gradeSeparatedCrossings,
    unresolvedDiagnostics: bundle.unresolvedDiagnostics,
    sourceFeatureToRoadEdgeIds: Array.from(bundle.sourceFeatureToRoadEdgeIds.entries()),
    sourceFeatureToRailwayEdgeIds: Array.from(bundle.sourceFeatureToRailwayEdgeIds.entries()),
    roadFeatureLineage: bundle.roadFeatureLineage,
    railwayFeatureLineage: bundle.railwayFeatureLineage,
  };
}

describe('Milestone 2.3 Stage E1 — Graph-to-Renderer Adapter & Safe Integration (TKT-007)', () => {
  it('1. defaults both road and railway render sources to legacy and parses URL query switches independently', () => {
    assert.deepEqual(DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS, {
      roads: 'legacy',
      railways: 'legacy',
    });
    assert.deepEqual(normalizeInfrastructureRenderOptions(), {
      roads: 'legacy',
      railways: 'legacy',
    });
    assert.equal(parseInfrastructureRenderSource(undefined), 'legacy');
    assert.equal(parseInfrastructureRenderSource(null), 'legacy');
    assert.equal(parseInfrastructureRenderSource(''), 'legacy');
    assert.equal(parseInfrastructureRenderSource('invalid-mode'), 'legacy');
    assert.equal(parseInfrastructureRenderSource('legacy'), 'legacy');
    assert.equal(parseInfrastructureRenderSource('graph-preview'), 'graph-preview');
    assert.equal(parseInfrastructureRenderSource('graph-surface'), 'graph-surface');
    assert.deepEqual(parseInfrastructureRenderOptionsFromSearch('?topologyRoads=graph-surface&topologyRailways=legacy'), { roads: 'graph-surface', railways: 'legacy' });
    assert.equal(requiresInfrastructureGraphPreview({ roads: 'graph-surface', railways: 'legacy' }), true);

    assert.deepEqual(parseInfrastructureRenderOptionsFromSearch(''), {
      roads: 'legacy',
      railways: 'legacy',
    });
    assert.deepEqual(
      parseInfrastructureRenderOptionsFromSearch(
        '?topologyRoads=graph-preview&topologyRailways=legacy'
      ),
      {
        roads: 'graph-preview',
        railways: 'legacy',
      }
    );
    assert.deepEqual(
      parseInfrastructureRenderOptionsFromSearch(
        '?topologyRoads=legacy&topologyRailways=graph-preview'
      ),
      {
        roads: 'legacy',
        railways: 'graph-preview',
      }
    );
    assert.deepEqual(
      parseInfrastructureRenderOptionsFromSearch(
        '?topologyRoads=graph-preview&topologyRailways=graph-preview'
      ),
      {
        roads: 'graph-preview',
        railways: 'graph-preview',
      }
    );
    assert.deepEqual(
      parseInfrastructureRenderOptionsFromSearch('?topologyRoads=bogus&topologyRailways=123'),
      {
        roads: 'legacy',
        railways: 'legacy',
      }
    );

    assert.equal(
      requiresInfrastructureGraphPreview({ roads: 'legacy', railways: 'legacy' }),
      false
    );
    assert.equal(
      requiresInfrastructureGraphPreview({ roads: 'graph-preview', railways: 'legacy' }),
      true
    );
    assert.equal(
      requiresInfrastructureGraphPreview({ roads: 'legacy', railways: 'graph-preview' }),
      true
    );
  });

  it('2. produces bit-for-bit identical descriptor bundles across 10 seeded permutations of input feature order', () => {
    const baseData = createRichSyntheticDataset();
    const baselineGraph = buildInfrastructureGraph(baseData);
    const baselineBundle = buildInfrastructureRenderDescriptors(baselineGraph);
    const baselineValidation = validateInfrastructureRenderDescriptors(
      baselineBundle,
      baselineGraph
    );
    assert.equal(baselineValidation.isValid, true);
    assert.deepEqual(baselineValidation.errors, []);

    const baselineSerialized = serializeDescriptorBundle(baselineBundle);

    for (let seed = 1; seed <= 10; seed++) {
      const permutedData: TopologySourceData = {
        roadParts: seededShuffle(baseData.roadParts, seed * 101).map((r) => ({
          ...r,
          points: r.points.map((pt) => [pt[0], pt[1]] as [number, number]),
          rawOsmNodeIds: [...r.rawOsmNodeIds],
        })),
        railwayParts: seededShuffle(baseData.railwayParts, seed * 307).map((rw) => ({
          ...rw,
          points: rw.points.map((pt) => [pt[0], pt[1]] as [number, number]),
          rawOsmNodeIds: [...rw.rawOsmNodeIds],
        })),
        infrastructurePoints: seededShuffle(baseData.infrastructurePoints || [], seed * 709).map(
          (pt) => ({
            ...pt,
            point: [pt.point[0], pt.point[1]] as [number, number],
            osmTags: pt.osmTags ? { ...pt.osmTags } : undefined,
          })
        ),
      };

      const permutedGraph = buildInfrastructureGraph(permutedData);
      const permutedBundle = adaptInfrastructureGraphToRenderDescriptors(permutedGraph);
      const permutedValidation = validateInfrastructureRenderDescriptors(
        permutedBundle,
        permutedGraph
      );

      assert.equal(permutedValidation.isValid, true);
      assert.deepEqual(serializeDescriptorBundle(permutedBundle), baselineSerialized);
    }
  });

  it('3. maps road node and edge descriptors accurately (cross-tier contacts, parallel edges, loops, oneway, boundary clips)', () => {
    const data = createRichSyntheticDataset();
    const graph = buildInfrastructureGraph(data);
    const bundle = buildInfrastructureRenderDescriptors(graph);

    // Boundary clip at [-500, 0]
    const westBoundaryNode = bundle.roadNodes.find(
      (n) => Math.abs(n.position[0] - -500) < 1e-3 && Math.abs(n.position[1] - 0) < 1e-3
    );
    assert.ok(westBoundaryNode, 'Expected west boundary node at [-500, 0]');
    assert.equal(westBoundaryNode.isBoundaryClipped, true);
    assert.ok(westBoundaryNode.roles.includes('boundary_clip'));

    const westBorderEdge = bundle.roadEdges.find(
      (e) => e.fromNodeId === westBoundaryNode.id || e.toNodeId === westBoundaryNode.id
    );
    assert.ok(westBorderEdge, 'Expected west border edge');
    assert.equal(westBorderEdge.clippedAtStart || westBorderEdge.clippedAtEnd, true);

    // 4-way vehicular junction at [0, 0] (explicit node 1001)
    const centerJunction = bundle.roadNodes.find((n) => n.rawOsmNodeId === '1001');
    assert.ok(centerJunction, 'Expected center junction node 1001');
    assert.ok(centerJunction.degree >= 4);
    assert.ok(centerJunction.roles.includes('junction'));
    assert.equal(centerJunction.requiresVehicularJunctionTrimming, true);
    assert.equal(centerJunction.requiresVehicularContinuityMiter, false);
    assert.equal(centerJunction.isCrossTierOnlyInteraction, false);

    // Cross-tier footway/road contact at [0, 40] (node 1004): 1 vehicular termination + 2 footway arms
    const crossTierNode = bundle.roadNodes.find((n) => n.rawOsmNodeId === '1004');
    assert.ok(crossTierNode, 'Expected cross-tier contact node 1004');
    assert.equal(crossTierNode.isCrossTier, true);
    assert.ok(crossTierNode.roles.includes('cross_tier'));
    assert.equal(crossTierNode.vehicularHalfEdgeCount, 1);
    assert.equal(crossTierNode.pathHalfEdgeCount, 2);
    assert.equal(crossTierNode.isCrossTierOnlyInteraction, true);
    // Crucial E2 invariant: a single vehicular arm touching a path does NOT trigger full-width vehicular intersection trimming
    assert.equal(crossTierNode.requiresVehicularJunctionTrimming, false);
    assert.equal(crossTierNode.requiresVehicularContinuityMiter, false);
    assert.equal(crossTierNode.requiresPathJunctionTrimming, false);

    // Parallel multi-edges between nodes 1002 and 1011
    const parallelEdges = bundle.roadEdges.filter(
      (e) =>
        e.sourceFeatureId === 'way/road-parallel-north' ||
        e.sourceFeatureId === 'way/road-parallel-south'
    );
    assert.equal(parallelEdges.length, 2);
    assert.deepEqual(
      parallelEdges.map((e) => e.parallelIndex).sort((a, b) => a - b),
      [0, 1]
    );

    // Closed loop and P-loop sub-edge detection
    const closedLoopEdges = bundle.roadEdges.filter(
      (e) => e.sourceFeatureId === 'way/road-closed-loop'
    );
    assert.equal(closedLoopEdges.length, 1);
    assert.equal(closedLoopEdges[0].isClosedLoop, true);
    assert.equal(closedLoopEdges[0].fromNodeId, closedLoopEdges[0].toNodeId);

    const pLoopEdges = bundle.roadEdges.filter((e) => e.sourceFeatureId === 'way/road-p-loop');
    assert.equal(pLoopEdges.length, 2);
    assert.equal(
      pLoopEdges.some((e) => e.isClosedLoop),
      true
    );
    assert.equal(
      pLoopEdges.some((e) => !e.isClosedLoop),
      true
    );

    // Oneway semantics: bidirectional, forward, reverse, unknown + rawOnewayTag + culvert
    const primaryEdge = bundle.roadEdges.find(
      (e) => e.sourceFeatureId === 'way/road-west-east'
    );
    assert.equal(primaryEdge?.normalizedOneway, 'bidirectional');
    assert.equal(primaryEdge?.surface, 'asphalt');

    const forwardEdge = bundle.roadEdges.find(
      (e) => e.sourceFeatureId === 'way/road-south-north'
    );
    assert.equal(forwardEdge?.normalizedOneway, 'forward');
    assert.equal(forwardEdge?.rawOnewayTag, 'yes');

    const reverseEdge = bundle.roadEdges.find(
      (e) => e.sourceFeatureId === 'way/road-reverse-oneway'
    );
    assert.equal(reverseEdge?.normalizedOneway, 'reverse');
    assert.equal(reverseEdge?.rawOnewayTag, '-1');

    const unknownOnewayEdge = bundle.roadEdges.find(
      (e) =>
        e.sourceFeatureIds.includes('way/road-unknown-oneway') &&
        e.deduplicatedFeatureIds.includes('way/road-z-duplicate-rev')
    );
    assert.ok(unknownOnewayEdge, 'Expected deduplicated unknown-oneway edge');
    assert.equal(unknownOnewayEdge.normalizedOneway, 'unknown');
    assert.equal(unknownOnewayEdge.rawOnewayTag, 'reversible');
    assert.equal(unknownOnewayEdge.isCulvert, true);
    assert.ok(unknownOnewayEdge.deduplicatedFeatureIds.includes('way/road-z-duplicate-rev'));
  });

  it('4. maps railway node, edge, turnout switch, and flat diamond crossing descriptors accurately', () => {
    const data = createRichSyntheticDataset();
    const graph = buildInfrastructureGraph(data);
    const bundle = buildInfrastructureRenderDescriptors(graph);

    // Confirmed turnout switch at node 5003 ([50, -20])
    const confirmedSwitchNode = bundle.railwayNodes.find((n) => n.rawOsmNodeId === '5003');
    assert.ok(confirmedSwitchNode, 'Expected confirmed switch node 5003');
    assert.equal(confirmedSwitchNode.isConfirmedSwitch, true);
    assert.equal(confirmedSwitchNode.isUnresolvedSwitch, false);
    assert.equal(confirmedSwitchNode.turnoutStatus, 'confirmed');
    assert.ok(confirmedSwitchNode.turnoutTopology, 'Expected turnoutTopology on confirmed switch');
    assert.equal(confirmedSwitchNode.pointOsmTags?.ref, 'W12');
    assert.ok(confirmedSwitchNode.turnoutTopology.trunkEdgeId);
    assert.ok(confirmedSwitchNode.turnoutTopology.mainBranchEdgeId);
    assert.ok(confirmedSwitchNode.turnoutTopology.divergingBranchEdgeId);
    assert.ok(['left', 'right'].includes(confirmedSwitchNode.turnoutTopology.turnoutSide));
    assert.ok(confirmedSwitchNode.turnoutTopology.divergenceAngleRad > 0);

    // Unresolved symmetric Y-junction at node 6000 ([-90, -20])
    const unresolvedSwitchNode = bundle.railwayNodes.find((n) => n.rawOsmNodeId === '6000');
    assert.ok(unresolvedSwitchNode, 'Expected unresolved switch node 6000');
    assert.equal(unresolvedSwitchNode.isConfirmedSwitch, false);
    assert.equal(unresolvedSwitchNode.isUnresolvedSwitch, true);
    assert.ok(
      unresolvedSwitchNode.turnoutStatus === 'unresolved_main_vs_diverging' ||
        unresolvedSwitchNode.turnoutStatus === 'unresolved_throat'
    );
    assert.equal(
      bundle.unresolvedDiagnostics.unresolvedRailwaySwitchNodeIds.includes(
        unresolvedSwitchNode.id
      ),
      true
    );

    // Flat diamond crossing at node 5004 ([80, -20])
    assert.equal(bundle.railwayFlatCrossings.length, 1);
    const diamond = bundle.railwayFlatCrossings[0];
    assert.equal(diamond.allowsBranchInterchange, false);
    assert.ok(diamond.trackAEdgeId);
    assert.ok(diamond.trackBEdgeId);
    assert.notEqual(diamond.trackAEdgeId, diamond.trackBEdgeId);
    assert.ok(diamond.crossingAngleRad > 0);
    // Ensure diamond node is NOT promoted to a confirmed switch
    const diamondNode = bundle.railwayNodes.find((n) => n.rawOsmNodeId === '5004');
    if (diamondNode) {
      assert.equal(diamondNode.isConfirmedSwitch, false);
    }

    // Verify railway edge metadata preservation (gauge, electrified, service, usage, secondary branch)
    const mainEdge = bundle.railwayEdges.find(
      (e) => e.sourceFeatureId === 'way/rail-main-trunk'
    );
    assert.ok(mainEdge);
    assert.equal(mainEdge.gauge, '1435');
    assert.equal(mainEdge.electrified, 'contact_line');
    assert.equal(mainEdge.usage, 'main');
    assert.equal(mainEdge.isSecondaryBranch, false);

    const sidingEdge = bundle.railwayEdges.find(
      (e) => e.sourceFeatureId === 'way/rail-siding-diverging'
    );
    assert.ok(sidingEdge);
    assert.equal(sidingEdge.service, 'siding');
    assert.equal(sidingEdge.isSecondaryBranch, true);
  });

  it('5. maps cross-domain descriptors (level crossings, grade transitions, grade-separated crossings) and keeps unresolved diagnostics separate', () => {
    const data = createRichSyntheticDataset();
    const graph = buildInfrastructureGraph(data);
    const bundle = buildInfrastructureRenderDescriptors(graph);

    // Confirmed level crossing at [0, -20] (node 5002)
    assert.equal(bundle.levelCrossings.length, 1);
    const lc = bundle.levelCrossings[0];
    assert.ok(Math.abs(lc.position[0] - 0) < 1e-3);
    assert.ok(Math.abs(lc.position[1] - -20) < 1e-3);
    assert.equal(lc.crossingKind, 'road_rail_level_crossing');
    assert.equal(lc.confidence, 'explicit_osm_crossing_tag');
    assert.ok(lc.roadNodeId);
    assert.ok(lc.railwayNodeId);
    assert.ok(lc.roadArcLengthMeters >= 0);
    assert.ok(lc.railwayArcLengthMeters >= 0);

    // Unresolved untagged road-rail crossing at [0, -30] stays in unresolvedDiagnostics, never in confirmed levelCrossings
    assert.ok(bundle.unresolvedDiagnostics.unresolvedCrossings.length >= 1);
    const unresolvedLc = bundle.unresolvedDiagnostics.unresolvedCrossings.find(
      (u) => Math.abs(u.position[0] - 0) < 0.2 && Math.abs(u.position[1] - -30) < 0.2
    );
    assert.ok(unresolvedLc, 'Expected unresolved crossing at [0, -30]');
    assert.equal(
      bundle.levelCrossings.some(
        (c) => Math.abs(c.position[0] - 0) < 0.2 && Math.abs(c.position[1] - -30) < 0.2
      ),
      false
    );

    // Grade transitions at [30, -35] (node 4002) and [30, -5] (node 4003)
    assert.equal(bundle.gradeTransitions.length, 2);
    for (const gt of bundle.gradeTransitions) {
      assert.equal(gt.network, 'road');
      assert.equal(gt.transitionType, 'bridge_approach');
      assert.notEqual(gt.atGradeNodeId, gt.gradeSeparatedNodeId);
      assert.ok(gt.continuousTraversalDot > 0.99);
      const dirLen = Math.hypot(
        gt.atGradeToStructureDirection[0],
        gt.atGradeToStructureDirection[1]
      );
      assert.ok(Math.abs(dirLen - 1) < 1e-5);
    }

    // Grade-separated crossing between road bridge (layer 1) and railway (layer 0) at [30, -20]
    assert.ok(bundle.gradeSeparatedCrossings.length >= 1);
    const gsc = bundle.gradeSeparatedCrossings.find(
      (c) => Math.abs(c.position[0] - 30) < 0.2 && Math.abs(c.position[1] - -20) < 0.2
    );
    assert.ok(gsc, 'Expected grade-separated crossing at [30, -20]');
    assert.equal(gsc.upperNetwork, 'road');
    assert.equal(gsc.lowerNetwork, 'railway');
    assert.equal(gsc.upperLayer, 1);
    assert.equal(gsc.lowerLayer, 0);
    // Ensure no level crossing was fabricated at [30, -20]
    assert.equal(
      bundle.levelCrossings.some(
        (c) => Math.abs(c.position[0] - 30) < 0.2 && Math.abs(c.position[1] - -20) < 0.2
      ),
      false
    );
  });

  it('6. preserves complete source-feature lineage and leaves input data and InfrastructureGraph strictly immutable', () => {
    const data = createRichSyntheticDataset();
    const dataSnapshotBefore = JSON.stringify(data);
    const graph = buildInfrastructureGraph(data);
    const graphSnapshotBefore = JSON.stringify({
      roadNodes: Array.from(graph.roads.nodes.entries()),
      roadEdges: Array.from(graph.roads.edges.entries()),
      railwayNodes: Array.from(graph.railways.nodes.entries()),
      railwayEdges: Array.from(graph.railways.edges.entries()),
      diagnostics: graph.diagnostics,
    });

    const bundle = buildInfrastructureRenderDescriptors(graph);
    const validation = validateInfrastructureRenderDescriptors(bundle, graph);
    assert.equal(validation.isValid, true);

    // Every input road and railway feature ID is traceable in sourceFeatureToRoadEdgeIds / sourceFeatureToRailwayEdgeIds
    for (const road of data.roads) {
      const fid = road.sourceFeatureId || road.id;
      const mappedEdges = bundle.sourceFeatureToRoadEdgeIds.get(fid);
      assert.ok(mappedEdges, `Expected mapped road edges for ${fid}`);
      assert.ok(mappedEdges.length >= 1);
    }

    for (const rail of data.railways) {
      const fid = rail.sourceFeatureId || rail.id;
      const mappedEdges = bundle.sourceFeatureToRailwayEdgeIds.get(fid);
      assert.ok(mappedEdges, `Expected mapped railway edges for ${fid}`);
      assert.ok(mappedEdges.length >= 1);
    }

    // Exact duplicate road way/road-z-duplicate-rev is recorded in deduplicatedMap
    assert.deepEqual(bundle.roadFeatureLineage.deduplicatedMap['way/road-unknown-oneway'], [
      'way/road-z-duplicate-rev',
    ]);

    // Mutating returned descriptor arrays/points must not mutate the underlying InfrastructureGraph
    (bundle.roadEdges[0].points[0] as unknown as number[])[0] = 999999;
    (bundle.roadNodes[0].position as unknown as number[])[0] = -999999;

    // Focused regression: mutating top-level and nested descriptor OSM property objects and arrays
    // must not mutate the underlying InfrastructureGraph, its edge provenance tags, or source ProcessedMapData
    const primaryEdgeDesc = bundle.roadEdges.find(
      (e) => e.sourceFeatureId === 'way/road-west-east'
    );
    assert.ok(primaryEdgeDesc);
    (primaryEdgeDesc.primaryOsmTags as any).highway = 'MUTATED_HIGHWAY';
    (primaryEdgeDesc.primaryOsmTags as any)._nodeIdsByPart[0].push('MUTATED_NODE_999');
    (primaryEdgeDesc.primaryOsmTags as any).nestedMeta.classification.code = 'MUTATED_CLASSIFICATION';
    (primaryEdgeDesc.primaryOsmTags as any).nestedMeta.flags.push(9999);
    (primaryEdgeDesc.provenance.segments[0].osmTags as any)._nodeIdsByPart[0].push('MUTATED_PROV_NODE');
    (primaryEdgeDesc.provenance.segments[0].osmTags as any).nestedMeta.classification.code = 'MUTATED_PROV_CODE';

    const switchNodeDesc = bundle.railwayNodes.find((n) => n.rawOsmNodeId === '5003');
    assert.ok(switchNodeDesc?.pointOsmTags);
    (switchNodeDesc.pointOsmTags as any).ref = 'MUTATED_REF_W99';
    (switchNodeDesc.pointOsmTags as any).nestedDetails.specs.push('MUTATED_SPEC_MAGLEV');
    (switchNodeDesc.pointOsmTags as any).nestedDetails.actuator.type = 'MUTATED_HYDRAULIC';

    const graphSnapshotAfter = JSON.stringify({
      roadNodes: Array.from(graph.roads.nodes.entries()),
      roadEdges: Array.from(graph.roads.edges.entries()),
      railwayNodes: Array.from(graph.railways.nodes.entries()),
      railwayEdges: Array.from(graph.railways.edges.entries()),
      diagnostics: graph.diagnostics,
    });
    assert.equal(JSON.stringify(data), dataSnapshotBefore);
    assert.equal(graphSnapshotAfter, graphSnapshotBefore);

    // Verify source and graph remain completely free of any mutated values
    const sourceRoad = data.roads.find((r) => r.id === 'way/road-west-east');
    assert.deepEqual((sourceRoad?.osmTags as any)._nodeIdsByPart, [
      ['1000', '1001'],
      ['1001', '1002'],
    ]);
    assert.equal(
      (sourceRoad?.osmTags as any).nestedMeta.classification.code,
      'primary_trunk'
    );
    assert.deepEqual((sourceRoad?.osmTags as any).nestedMeta.flags, [1, 2, 3]);

    const graphRoadEdge = graph.roads.edges.get(primaryEdgeDesc.id);
    assert.ok(graphRoadEdge);
    assert.deepEqual(
      (graphRoadEdge.provenance.segments[0].osmTags as any)._nodeIdsByPart,
      [
        ['1000', '1001'],
        ['1001', '1002'],
      ]
    );
    assert.equal(
      (graphRoadEdge.provenance.segments[0].osmTags as any).nestedMeta.classification.code,
      'primary_trunk'
    );
    assert.deepEqual(
      (graphRoadEdge.provenance.segments[0].osmTags as any).nestedMeta.flags,
      [1, 2, 3]
    );

    const graphRailNode = graph.railways.nodes.get(switchNodeDesc.id);
    assert.ok(graphRailNode);
    assert.equal((graphRailNode.pointOsmTags as any).ref, 'W12');
    assert.deepEqual((graphRailNode.pointOsmTags as any).nestedDetails.specs, [
      'standard',
      'heavy_rail',
    ]);
    assert.equal(
      (graphRailNode.pointOsmTags as any).nestedDetails.actuator.type,
      'electric'
    );
  });

  it('7. Primary E1 Acceptance: Legacy Renderer Invariance across Synthetic, Switchyard, Station Hengelo, and Amsterdam Centraal datasets', () => {
    const provider = new LocalGeoJsonProvider();
    const hengeloRawFc: any = {
      type: 'FeatureCollection',
      name: 'Station Hengelo',
      features: JSON.parse(JSON.stringify(realOsmExtracts.regions.hengelo.features)),
    };
    const amsterdamRawFc: any = {
      type: 'FeatureCollection',
      name: 'Amsterdam Centraal',
      features: JSON.parse(JSON.stringify(realOsmExtracts.regions.amsterdamCentraal.features)),
    };

    const makeDatasets = (): Array<{ name: string; data: ProcessedMapData }> => [
      { name: 'Synthetic M2.3-E1', data: createRichSyntheticDataset() },
      { name: 'M2.1 Switchyard Fixture', data: createRailwayPrototypeFixtureData() },
      {
        name: 'Station Hengelo (Overijssel)',
        data: provider.parseGeoJson(
          JSON.parse(JSON.stringify(hengeloRawFc)),
          'Station Hengelo'
        ),
      },
      {
        name: 'Amsterdam Centraal',
        data: provider.parseGeoJson(
          JSON.parse(JSON.stringify(amsterdamRawFc)),
          'Amsterdam Centraal'
        ),
      },
    ];

    const legacyDatasets = makeDatasets();
    const previewDatasets = makeDatasets();

    for (let i = 0; i < legacyDatasets.length; i++) {
      const dsLegacy = legacyDatasets[i];
      const dsPreview = previewDatasets[i];

      const roadSnapshotBeforePreview = JSON.stringify(dsPreview.data.roads);
      const railSnapshotBeforePreview = JSON.stringify(dsPreview.data.railways);

      // 1. Default legacy scene
      const legacyBuilder = new GeometryBuilder({
        initialCameraZoom: 1.0,
        infrastructureRenderOptions: { roads: 'legacy', railways: 'legacy' },
      });
      const legacyScene = legacyBuilder.buildScene(dsLegacy.data, MAP_THEMES.tactical);
      assert.deepEqual(legacyScene.infrastructureRenderOptions, {
        roads: 'legacy',
        railways: 'legacy',
      });
      // In legacy mode, no preview graph/descriptor bundle is allocated
      assert.equal(legacyScene.infrastructureRenderPreview, null);

      // 2. Both road & railway graph-preview enabled (sharing 1 InfrastructureGraph)
      const sharedPreview = prepareInfrastructureRenderPreview(dsPreview.data, {
        roads: 'graph-preview',
        railways: 'graph-preview',
      });
      assert.ok(sharedPreview.graph, `Expected sharedPreview.graph for ${dsPreview.name}`);
      assert.ok(sharedPreview.descriptors, `Expected sharedPreview.descriptors for ${dsPreview.name}`);
      assert.equal(sharedPreview.validation?.isValid, true);

      // Verify prepareInfrastructureRenderPreview did NOT mutate ProcessedMapData.roads or .railways
      assert.equal(JSON.stringify(dsPreview.data.roads), roadSnapshotBeforePreview);
      assert.equal(JSON.stringify(dsPreview.data.railways), railSnapshotBeforePreview);

      const previewBuilder = new GeometryBuilder({
        initialCameraZoom: 1.0,
        infrastructureRenderOptions: {
          roads: 'graph-preview',
          railways: 'graph-preview',
        },
        infrastructureRenderPreview: sharedPreview,
      });
      const previewScene = previewBuilder.buildScene(dsPreview.data, MAP_THEMES.tactical);
      assert.equal(previewScene.infrastructureRenderPreview, sharedPreview);

      // Verify after scene build that dsLegacy.data and dsPreview.data have identical roads and railways
      assert.deepEqual(dsPreview.data.roads, dsLegacy.data.roads);
      assert.deepEqual(dsPreview.data.railways, dsLegacy.data.railways);

      // Compare complete scene snapshots (groups, meshes, buffer attributes, instanced matrices, faceRanges, provenance, stats)
      const snapLegacy = collectSceneSnapshot(legacyScene);
      const snapPreview = collectSceneSnapshot(previewScene);
      assert.deepEqual(snapPreview, snapLegacy);

      // Verify zoom/LOD transitions produce identical visibility in both scenes
      legacyScene.updateCameraZoom?.(8.0);
      previewScene.updateCameraZoom?.(8.0);
      assert.deepEqual(
        collectSceneSnapshot(previewScene).groupSnapshots,
        collectSceneSnapshot(legacyScene).groupSnapshots
      );

      legacyScene.updateCameraZoom?.(1.0);
      previewScene.updateCameraZoom?.(1.0);
      assert.deepEqual(
        collectSceneSnapshot(previewScene).groupSnapshots,
        collectSceneSnapshot(legacyScene).groupSnapshots
      );

      // Verify in-place theme update works identically without regenerating geometry or preview descriptors
      legacyScene.updateTheme(MAP_THEMES.daylight);
      previewScene.updateTheme(MAP_THEMES.daylight);
      assert.equal(previewScene.infrastructureRenderPreview, sharedPreview);

      // Verify disposal releases GPU resources and clears preview reference
      legacyScene.dispose();
      previewScene.dispose();
      assert.equal(legacyScene.resources.ownedGeometriesCount, 0);
      assert.equal(legacyScene.resources.ownedMaterialsCount, 0);
      assert.equal(legacyScene.resources.disposed, true);
      assert.equal(previewScene.resources.ownedGeometriesCount, 0);
      assert.equal(previewScene.resources.ownedMaterialsCount, 0);
      assert.equal(previewScene.resources.disposed, true);
      assert.equal(previewScene.infrastructureRenderPreview, null);
    }
  });

  it('8. preserves full railwayPrototypeMode compatibility (production, candidateA, candidateB, disabled) alongside preview switches', () => {
    const fixtureLegacy = createRailwayPrototypeFixtureData();
    const fixturePreview = createRailwayPrototypeFixtureData();
    const sharedPreview = prepareInfrastructureRenderPreview(fixturePreview, {
      roads: 'graph-preview',
      railways: 'graph-preview',
    });
    assert.ok(sharedPreview.descriptors);
    assert.equal(sharedPreview.validation?.isValid, true);

    // When railwayPrototypeMode is candidateB, App.tsx passes railways: [] to GeometryBuilder and mounts buildRailwayPrototypeGroup
    const nonRailLegacyData: ProcessedMapData = {
      ...fixtureLegacy,
      railways: [],
    };
    const nonRailPreviewData: ProcessedMapData = {
      ...fixturePreview,
      railways: [],
    };

    const legacyNonRail = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'legacy', railways: 'legacy' },
    }).buildScene(nonRailLegacyData, MAP_THEMES.tactical);

    const previewNonRail = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'graph-preview', railways: 'graph-preview' },
      infrastructureRenderPreview: sharedPreview,
    }).buildScene(nonRailPreviewData, MAP_THEMES.tactical);

    assert.deepEqual(collectSceneSnapshot(previewNonRail), collectSceneSnapshot(legacyNonRail));

    const protoA = buildRailwayPrototypeGroup(
      fixturePreview,
      MAP_THEMES.tactical,
      'candidateA',
      1.0
    );
    const protoB = buildRailwayPrototypeGroup(
      fixturePreview,
      MAP_THEMES.tactical,
      'candidateB',
      1.0
    );
    assert.ok(protoA.railwaysGroup.children.length > 0);
    assert.ok(protoB.railwaysGroup.children.length > 0);

    protoA.dispose();
    protoB.dispose();
    legacyNonRail.dispose();
    previewNonRail.dispose();
  });

  it('9. measures and validates independent graph build, adapter build, and scene build performance across all benchmark datasets', () => {
    const provider = new LocalGeoJsonProvider();
    const hengeloRawFc: any = {
      type: 'FeatureCollection',
      name: 'Station Hengelo',
      features: JSON.parse(JSON.stringify(realOsmExtracts.regions.hengelo.features)),
    };
    const amsterdamRawFc: any = {
      type: 'FeatureCollection',
      name: 'Amsterdam Centraal',
      features: JSON.parse(JSON.stringify(realOsmExtracts.regions.amsterdamCentraal.features)),
    };

    const datasets: Array<{ name: string; data: ProcessedMapData }> = [
      { name: 'Synthetic M2.3-E1', data: createRichSyntheticDataset() },
      {
        name: 'Station Hengelo',
        data: provider.parseGeoJson(hengeloRawFc, 'Station Hengelo'),
      },
      {
        name: 'Amsterdam Centraal',
        data: provider.parseGeoJson(amsterdamRawFc, 'Amsterdam Centraal'),
      },
    ];

    const benchmarkReport: Array<{
      dataset: string;
      roadsIn: number;
      railwaysIn: number;
      graphBuildMs: number;
      adapterBuildMs: number;
      legacySceneBuildMs: number;
      previewTotalOverheadMs: number;
      roadNodes: number;
      roadEdges: number;
      railwayNodes: number;
      railwayEdges: number;
      levelCrossings: number;
      gradeTransitions: number;
      gradeSeparatedCrossings: number;
    }> = [];

    for (const ds of datasets) {
      const tGraph0 = performance.now();
      const graph = buildInfrastructureGraph(ds.data);
      const graphBuildMs = Number((performance.now() - tGraph0).toFixed(2));

      const tAdapt0 = performance.now();
      const bundle: InfrastructureRenderDescriptorBundle =
        buildInfrastructureRenderDescriptors(graph);
      const adapterBuildMs = Number((performance.now() - tAdapt0).toFixed(2));

      const validation = validateInfrastructureRenderDescriptors(bundle, graph);
      assert.equal(validation.isValid, true);

      const tScene0 = performance.now();
      const scene = new GeometryBuilder().buildScene(ds.data, MAP_THEMES.tactical);
      const legacySceneBuildMs = Number((performance.now() - tScene0).toFixed(2));
      scene.dispose();

      benchmarkReport.push({
        dataset: ds.name,
        roadsIn: ds.data.roads.length,
        railwaysIn: ds.data.railways.length,
        graphBuildMs,
        adapterBuildMs,
        legacySceneBuildMs,
        previewTotalOverheadMs: Number((graphBuildMs + adapterBuildMs).toFixed(2)),
        roadNodes: bundle.roadNodes.length,
        roadEdges: bundle.roadEdges.length,
        railwayNodes: bundle.railwayNodes.length,
        railwayEdges: bundle.railwayEdges.length,
        levelCrossings: bundle.levelCrossings.length,
        gradeTransitions: bundle.gradeTransitions.length,
        gradeSeparatedCrossings: bundle.gradeSeparatedCrossings.length,
      });
    }

    console.log('[M2.3-E1 Benchmarks]', JSON.stringify(benchmarkReport));
  });

  it('10. classifies cross-tier junction trimming vs degree-2 continuity miter across through-roads and branching intersections', () => {
    // Exercises all 5 required cross-tier and vehicular intersection scenarios:
    // 1) 2 vehicular arms + 1 footpath (continuous through-road with joining side footpath)
    // 2) 2 vehicular arms + 2 footpaths (continuous through-road crossed by footpath)
    // 3) 3 vehicular arms + 1 footpath (vehicular T-junction with connecting footpath)
    // 4) 1 vehicular arm + 2 footpaths (terminating vehicular road with path arms)
    // 5) Pure vehicular junction (3 vehicular arms, 0 footpaths)
    // 6) Pure vehicular degree-2 road continuity (2 vehicular arms, 0 footpaths)
    const roads: TestRoadFeature[] = [
      // Case 1: Node 9011 at [0, 0] -> 2 vehicular half-edges + 1 footpath
      makeRoad('way/c1-v1', [[-20, 0], [0, 0]], {
        roadClass: 'secondary',
        nodeIds: ['9010', '9011'],
        osmTags: { highway: 'secondary' },
      }),
      makeRoad('way/c1-v2', [[0, 0], [20, 0]], {
        roadClass: 'secondary',
        nodeIds: ['9011', '9012'],
        osmTags: { highway: 'secondary' },
      }),
      makeRoad('way/c1-p1', [[0, 0], [0, 20]], {
        roadClass: 'footway',
        nodeIds: ['9011', '9013'],
        osmTags: { highway: 'footway' },
      }),

      // Case 2: Node 9021 at [0, 50] -> 2 vehicular half-edges + 2 footpaths
      makeRoad('way/c2-v1', [[-20, 50], [0, 50]], {
        roadClass: 'secondary',
        nodeIds: ['9020', '9021'],
        osmTags: { highway: 'secondary' },
      }),
      makeRoad('way/c2-v2', [[0, 50], [20, 50]], {
        roadClass: 'secondary',
        nodeIds: ['9021', '9022'],
        osmTags: { highway: 'secondary' },
      }),
      makeRoad('way/c2-p1', [[0, 50], [0, 70]], {
        roadClass: 'footway',
        nodeIds: ['9021', '9023'],
        osmTags: { highway: 'footway' },
      }),
      makeRoad('way/c2-p2', [[0, 50], [0, 30]], {
        roadClass: 'footway',
        nodeIds: ['9021', '9024'],
        osmTags: { highway: 'footway' },
      }),

      // Case 3: Node 9031 at [0, 100] -> 3 vehicular half-edges + 1 footpath
      makeRoad('way/c3-v1', [[-20, 100], [0, 100]], {
        roadClass: 'secondary',
        nodeIds: ['9030', '9031'],
        osmTags: { highway: 'secondary' },
      }),
      makeRoad('way/c3-v2', [[0, 100], [20, 100]], {
        roadClass: 'secondary',
        nodeIds: ['9031', '9032'],
        osmTags: { highway: 'secondary' },
      }),
      makeRoad('way/c3-v3', [[0, 100], [0, 80]], {
        roadClass: 'secondary',
        nodeIds: ['9031', '9033'],
        osmTags: { highway: 'secondary' },
      }),
      makeRoad('way/c3-p1', [[0, 100], [0, 120]], {
        roadClass: 'footway',
        nodeIds: ['9031', '9034'],
        osmTags: { highway: 'footway' },
      }),

      // Case 4: Node 9041 at [0, 150] -> 1 vehicular half-edge + 2 footpaths
      makeRoad('way/c4-v1', [[-20, 150], [0, 150]], {
        roadClass: 'secondary',
        nodeIds: ['9040', '9041'],
        osmTags: { highway: 'secondary' },
      }),
      makeRoad('way/c4-p1', [[0, 150], [0, 170]], {
        roadClass: 'footway',
        nodeIds: ['9041', '9042'],
        osmTags: { highway: 'footway' },
      }),
      makeRoad('way/c4-p2', [[0, 150], [0, 130]], {
        roadClass: 'footway',
        nodeIds: ['9041', '9043'],
        osmTags: { highway: 'footway' },
      }),

      // Case 5: Node 9051 at [0, 200] -> Pure vehicular junction (3 vehicular arms, 0 footpaths)
      makeRoad('way/c5-v1', [[-20, 200], [0, 200]], {
        roadClass: 'secondary',
        nodeIds: ['9050', '9051'],
        osmTags: { highway: 'secondary' },
      }),
      makeRoad('way/c5-v2', [[0, 200], [20, 200]], {
        roadClass: 'secondary',
        nodeIds: ['9051', '9052'],
        osmTags: { highway: 'secondary' },
      }),
      makeRoad('way/c5-v3', [[0, 200], [0, 220]], {
        roadClass: 'secondary',
        nodeIds: ['9051', '9053'],
        osmTags: { highway: 'secondary' },
      }),

      // Case 6: Node 9061 at [0, 250] -> Pure vehicular degree-2 continuity (2 vehicular arms, 0 footpaths, attribute break)
      makeRoad('way/c6-v1', [[-20, 250], [0, 250]], {
        roadClass: 'secondary',
        nodeIds: ['9060', '9061'],
        surface: 'asphalt',
        osmTags: { highway: 'secondary', surface: 'asphalt' },
      }),
      makeRoad('way/c6-v2', [[0, 250], [20, 250]], {
        roadClass: 'secondary',
        nodeIds: ['9061', '9062'],
        surface: 'paving_stones',
        osmTags: { highway: 'secondary', surface: 'paving_stones' },
      }),
    ];

    const roadParts: UnchainedRoadPart[] = roads.map((r) => ({
      id: `${r.id}-0`,
      sourceFeatureId: r.sourceFeatureId || r.id,
      hasExplicitSourceId: true,
      partIndex: 0,
      points: r.points.map((pt) => [pt[0], pt[1]] as [number, number]),
      rawOsmNodeIds: r.nodeIds ? [...r.nodeIds] : r.points.map(() => undefined),
      clippedAtStart: false,
      clippedAtEnd: false,
      roadClass: r.roadClass,
      width: r.width,
      lanes: r.lanes,
      oneway: r.oneway,
      surface: r.surface,
      layer: r.layer ?? 0,
      isBridge: r.isBridge ?? false,
      isTunnel: r.isTunnel ?? false,
      isCulvert: false,
      osmTags: r.osmTags ? { ...r.osmTags } : undefined,
    }));

    const graph = buildInfrastructureGraph({
      roadParts,
      railwayParts: [],
      infrastructurePoints: [],
    });
    const bundle = buildInfrastructureRenderDescriptors(graph);

    // Validate the bundle conforms to all invariant checks
    const validation = validateInfrastructureRenderDescriptors(bundle, graph);
    assert.equal(validation.isValid, true);
    assert.deepEqual(validation.errors, []);

    // 1) 2 vehicular + 1 footpath
    const node9011 = bundle.roadNodes.find((n) => n.rawOsmNodeId === '9011');
    assert.ok(node9011, 'Expected node 9011');
    assert.equal(node9011.vehicularHalfEdgeCount, 2);
    assert.equal(node9011.pathHalfEdgeCount, 1);
    assert.equal(node9011.isCrossTier, true);
    assert.equal(node9011.isCrossTierOnlyInteraction, true);
    assert.equal(node9011.requiresVehicularJunctionTrimming, false);
    assert.equal(node9011.requiresVehicularContinuityMiter, true);
    assert.equal(node9011.requiresPathJunctionTrimming, false);

    // 2) 2 vehicular + 2 footpaths
    const node9021 = bundle.roadNodes.find((n) => n.rawOsmNodeId === '9021');
    assert.ok(node9021, 'Expected node 9021');
    assert.equal(node9021.vehicularHalfEdgeCount, 2);
    assert.equal(node9021.pathHalfEdgeCount, 2);
    assert.equal(node9021.isCrossTier, true);
    assert.equal(node9021.isCrossTierOnlyInteraction, true);
    assert.equal(node9021.requiresVehicularJunctionTrimming, false);
    assert.equal(node9021.requiresVehicularContinuityMiter, true);
    assert.equal(node9021.requiresPathJunctionTrimming, false);

    // 3) 3 vehicular + 1 footpath
    const node9031 = bundle.roadNodes.find((n) => n.rawOsmNodeId === '9031');
    assert.ok(node9031, 'Expected node 9031');
    assert.equal(node9031.vehicularHalfEdgeCount, 3);
    assert.equal(node9031.pathHalfEdgeCount, 1);
    assert.equal(node9031.isCrossTier, true);
    assert.equal(node9031.isCrossTierOnlyInteraction, false);
    assert.equal(node9031.requiresVehicularJunctionTrimming, true);
    assert.equal(node9031.requiresVehicularContinuityMiter, false);
    assert.equal(node9031.requiresPathJunctionTrimming, false);

    // 4) 1 vehicular + 2 footpaths
    const node9041 = bundle.roadNodes.find((n) => n.rawOsmNodeId === '9041');
    assert.ok(node9041, 'Expected node 9041');
    assert.equal(node9041.vehicularHalfEdgeCount, 1);
    assert.equal(node9041.pathHalfEdgeCount, 2);
    assert.equal(node9041.isCrossTier, true);
    assert.equal(node9041.isCrossTierOnlyInteraction, true);
    assert.equal(node9041.requiresVehicularJunctionTrimming, false);
    assert.equal(node9041.requiresVehicularContinuityMiter, false);
    assert.equal(node9041.requiresPathJunctionTrimming, false);

    // 5) Pure vehicular junction (3 vehicular arms)
    const node9051 = bundle.roadNodes.find((n) => n.rawOsmNodeId === '9051');
    assert.ok(node9051, 'Expected node 9051');
    assert.equal(node9051.vehicularHalfEdgeCount, 3);
    assert.equal(node9051.pathHalfEdgeCount, 0);
    assert.equal(node9051.isCrossTier, false);
    assert.equal(node9051.isCrossTierOnlyInteraction, false);
    assert.equal(node9051.requiresVehicularJunctionTrimming, true);
    assert.equal(node9051.requiresVehicularContinuityMiter, false);
    assert.equal(node9051.requiresPathJunctionTrimming, false);

    // 6) Pure vehicular degree-2 road continuity
    const node9061 = bundle.roadNodes.find((n) => n.rawOsmNodeId === '9061');
    assert.ok(node9061, 'Expected node 9061');
    assert.equal(node9061.vehicularHalfEdgeCount, 2);
    assert.equal(node9061.pathHalfEdgeCount, 0);
    assert.equal(node9061.isCrossTier, false);
    assert.equal(node9061.isCrossTierOnlyInteraction, false);
    assert.equal(node9061.requiresVehicularJunctionTrimming, false);
    assert.equal(node9061.requiresVehicularContinuityMiter, true);
    assert.equal(node9061.requiresPathJunctionTrimming, false);
  });
});
