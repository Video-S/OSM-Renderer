import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { MAP_THEMES } from '../styles/mapThemes';
import {
  FaceFeatureRange,
  GeometryBuilder,
  GraphRoadGenerationTiming,
  GraphRoadRenderStats,
  auditGraphRoadMeshIntegrity,
  parseInfrastructureRenderOptionsFromSearch,
  parseRoadInfrastructureRenderSource,
  prepareInfrastructureRenderPreview,
  resolveInspectedFeature,
  validateSurfaceFirstRoadGeometry,
} from './GeometryBuilder';
import {
  bufferSurfaceFirstRoadCenterline,
  SurfaceFirstBufferInstrumentation,
} from './infrastructure/roads/SurfaceFirstRoadFootprints';
import { validateRoadNetworkGeometry } from './ZFightingValidator';
import { ELEVATION_POLICY } from './ElevationPolicy';
import { ProcessedMapData, RoadClass, RoadFeature } from '../types/MapFeature';
import prinsForkRepro from './prototype/PrinsHendrikkadeForkFixture.json';
import veloursSplitRepro from './prototype/VeloursstraatSplitFixture.json';
import parallelwegSplitRepro from './prototype/ParallelwegSplitFixture.json';

const NIEUWSTRAAT_PEDESTRIAN_REPRO = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'way/26735174',
      properties: {
        '@id': 'way/26735174',
        highway: 'pedestrian',
        name: 'Nieuwstraat',
        surface: 'paving_stones',
        _nodeIds: ['1391936373', '1635870960', '275382745'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7932592, 52.2636319],
          [6.7934505, 52.2635675],
          [6.7939619, 52.2633902],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/475447189',
      properties: {
        '@id': 'way/475447189',
        highway: 'pedestrian',
        name: 'Stationsplein',
        surface: 'paving_stones',
        _nodeIds: ['275382745', '4691916888', '1635870939', '4691916890', '4691916891', '5126458735'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7939619, 52.2633902],
          [6.7939441, 52.2633661],
          [6.7939278, 52.2633441],
          [6.7938847, 52.2632888],
          [6.7938605, 52.2632591],
          [6.7937146, 52.2630512],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/527651153',
      properties: {
        '@id': 'way/527651153',
        highway: 'pedestrian',
        lit: 'yes',
        name: 'Nieuwstraat',
        surface: 'paving_stones',
        _nodeIds: ['275382745', '275382625'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7939619, 52.2633902],
          [6.7940798, 52.2633491],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/26735179',
      properties: {
        '@id': 'way/26735179',
        highway: 'cycleway',
        _nodeIds: ['292954791', '5126458735'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7937878, 52.2629393],
          [6.7937146, 52.2630512],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/527651149',
      properties: {
        '@id': 'way/527651149',
        highway: 'cycleway',
        _nodeIds: ['5126458735', '4691916889', '275382625'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7937146, 52.2630512],
          [6.7939543, 52.2632609],
          [6.7940798, 52.2633491],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/527651154',
      properties: {
        '@id': 'way/527651154',
        highway: 'pedestrian',
        _nodeIds: ['275382625', '275382464'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7940798, 52.2633491],
          [6.7944019, 52.2632319],
        ],
      },
    },
  ],
};

const HENGELO_PIZZA_SLICE_CORNERS_REPRO = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'way/352527579',
      properties: {
        '@id': 'way/352527579',
        highway: 'footway',
        footway: 'sidewalk',
        _nodeIds: ['3582509666', '3582509657', '5126458731', '3582509648'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7935568, 52.2630339],
          [6.7935675, 52.2630222],
          [6.7936163, 52.2629699],
          [6.7936226, 52.2629632],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/527651145',
      properties: {
        '@id': 'way/527651145',
        highway: 'footway',
        footway: 'crossing',
        _nodeIds: ['5126458733', '5126458732', '5126458731'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7937005, 52.2629972],
          [6.7936624, 52.2629848],
          [6.7936163, 52.2629699],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/1184231072',
      properties: {
        '@id': 'way/1184231072',
        highway: 'footway',
        _nodeIds: ['5126458731', '10996873170'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7936163, 52.2629699],
          [6.7935304, 52.2629437],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/527651146',
      properties: {
        '@id': 'way/527651146',
        highway: 'cycleway',
        _nodeIds: ['5126458730', '5126458732', '5126458734'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7936818, 52.2629584],
          [6.7936624, 52.2629848],
          [6.7936402, 52.2630148],
        ],
      },
    },
  ],
};

const PRINSES_BEATRIXSTRAAT_ADJACENT_SERVICE_REPRO = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'way/6998290',
      properties: {
        '@id': 'way/6998290',
        highway: 'residential',
        name: 'Prinses Beatrixstraat',
        surface: 'paving_stones',
        _nodeIds: ['5030059202', '48009184', '4688687021', '48011510', '4688687019'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7885872, 52.2638487],
          [6.7887857, 52.2635604],
          [6.7889065, 52.2633862],
          [6.7889378, 52.2633411],
          [6.7892154, 52.2629409],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/6998276',
      properties: {
        '@id': 'way/6998276',
        highway: 'residential',
        name: 'Prinses Beatrixstraat',
        surface: 'paving_stones',
        _nodeIds: ['48011510', '5030059195'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7889378, 52.2633411],
          [6.7891664, 52.2634139],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/475091982',
      properties: {
        '@id': 'way/475091982',
        highway: 'service',
        service: 'parking_aisle',
        surface: 'paving_stones',
        _nodeIds: ['4688687020', '4688687021'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.788685, 52.2633059],
          [6.7889065, 52.2633862],
        ],
      },
    },
  ],
};

interface SyntheticRoadSpec {
  id: string;
  sourceFeatureId?: string;
  roadClass: RoadClass;
  width: number;
  points: [number, number][];
  nodeIds?: string[];
  name?: string;
  layer?: number;
  isBridge?: boolean;
  isTunnel?: boolean;
  oneway?: boolean;
  lanes?: number;
  surface?: string;
  clippedAtStart?: boolean;
  clippedAtEnd?: boolean;
  osmTags?: Record<string, string | number | boolean>;
}

function createSyntheticDataset(
  roads: SyntheticRoadSpec[],
  regionName = 'Synthetic-E2Plus-Fixture'
): ProcessedMapData {
  const roadFeatures: RoadFeature[] = [];
  const roadParts: Array<
    NonNullable<ProcessedMapData['topologySource']>['roadParts'][number]
  > = [];

  for (const r of roads) {
    const sourceFeatureId = r.sourceFeatureId ?? r.id;
    const osmTags: Record<string, string | number | boolean> = {
      highway: r.roadClass,
      ...(r.name ? { name: r.name } : {}),
      ...(r.surface ? { surface: r.surface } : {}),
      ...(r.oneway !== undefined ? { oneway: r.oneway ? 'yes' : 'no' } : {}),
      ...(r.lanes !== undefined ? { lanes: String(r.lanes) } : {}),
      ...(r.osmTags ?? {}),
    };
    roadFeatures.push({
      id: r.id,
      sourceFeatureId,
      type: 'road',
      roadClass: r.roadClass,
      width: r.width,
      points: r.points.map((pt) => [pt[0], pt[1]] as [number, number]),
      nodeIds: r.nodeIds,
      name: r.name,
      layer: r.layer ?? 0,
      isBridge: r.isBridge ?? false,
      isTunnel: r.isTunnel ?? false,
      osmTags,
    });
    roadParts.push({
      id: `${r.id}-0`,
      sourceFeatureId,
      hasExplicitSourceId: true,
      partIndex: 0,
      roadClass: r.roadClass,
      points: r.points.map((pt) => [pt[0], pt[1]] as [number, number]),
      rawOsmNodeIds: r.nodeIds
        ? r.nodeIds.map((nid) => (nid && nid.trim().length > 0 ? nid.trim() : undefined))
        : r.points.map(() => undefined),
      width: r.width,
      layer: r.layer ?? 0,
      isBridge: r.isBridge ?? false,
      isTunnel: r.isTunnel ?? false,
      isCulvert: false,
      name: r.name,
      clippedAtStart: r.clippedAtStart ?? false,
      clippedAtEnd: r.clippedAtEnd ?? false,
      osmTags,
    });
  }

  return {
    buildings: [],
    roads: roadFeatures,
    waterBodies: [],
    water: [],
    linearWaterways: [],
    parks: [],
    railways: [],
    landuse: [],
    barriers: [],
    landmarks: [],
    bounds: {
      minX: -240,
      maxX: 240,
      minZ: -240,
      maxZ: 240,
      widthMeters: 480,
      depthMeters: 480,
    },
    centerLonLat: [6.795, 52.26],
    regionName,
    topologySource: {
      roadParts,
      railwayParts: [],
      infrastructurePoints: [],
    },
    diagnostics: {
      sourceFeaturesReceived: roadFeatures.length,
      sourceFeaturesClassified: roadFeatures.length,
      totalFeaturesParsed: roadFeatures.length,
      sourceFeaturesRendered: 0,
      constructedMeshesCount: 0,
      totalFeaturesReceived: roadFeatures.length,
      totalFeaturesRendered: 0,
      parsedByCategory: {
        buildings: 0,
        roads: roadFeatures.length,
        waterBodies: 0,
        linearWaterways: 0,
        parks: 0,
        railways: 0,
        landuse: 0,
        barriers: 0,
        landmarks: 0,
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
        Point: 0,
        MultiPoint: 0,
        LineString: roadFeatures.length,
        MultiLineString: 0,
        Polygon: 0,
        MultiPolygon: 0,
        GeometryCollection: 0,
        Unknown: 0,
      },
      cartoSubtypesCount: {},
      featuresFullySubtracted: { count: 0, sampleIds: [] },
      clippingFailures: { count: 0, sampleIds: [] },
    },
    stats: {
      totalBuildings: 0,
      totalRoads: roadFeatures.length,
      totalRoadSegments: roadFeatures.length,
      totalRailways: 0,
      totalRailwaySegments: 0,
      totalWaterPolygons: 0,
      totalLinearWaterways: 0,
      totalParkPolygons: 0,
      totalLandusePolygons: 0,
      totalBarriers: 0,
      totalLandmarks: 0,
      areaKm2: 0.23,
    },
  };
}

function buildSurfaceFirstScene(data: ProcessedMapData, roadWidthMultiplier = 1.0) {
  const options = {
    roads: 'graph-surface' as const,
    railways: 'legacy' as const,
  };
  const preview = prepareInfrastructureRenderPreview(data, options);
  const builder = new GeometryBuilder({
    roadWidthMultiplier,
    infrastructureRenderOptions: options,
    infrastructureRenderPreview: preview,
  });
  return builder.buildScene(data, MAP_THEMES.tactical);
}

describe('E2+ Surface-First Road Rendering, Geometry Validation & Performance Instrumentation', () => {
  it('parses graph-surface road mode while keeping legacy default', () => {
    assert.equal(parseRoadInfrastructureRenderSource('graph-surface'), 'graph-surface');
    assert.deepEqual(
      parseInfrastructureRenderOptionsFromSearch('?topologyRoads=graph-surface'),
      { roads: 'graph-surface', railways: 'legacy' }
    );
  });

  it('validates real-world repro fixtures (Nieuwstraat, Hengelo corners, Prins Hendrikkade fork, Veloursstraat split, Parallelweg split, Beatrixstraat service)', () => {
    const provider = new LocalGeoJsonProvider();
    const fixtures = [
      ['Nieuwstraat-Stationsplein', NIEUWSTRAAT_PEDESTRIAN_REPRO],
      ['Hengelo-pizza-slice-corners', HENGELO_PIZZA_SLICE_CORNERS_REPRO],
      ['Prins-Hendrikkade-fork', (prinsForkRepro as any).geoJson ?? prinsForkRepro],
      ['Veloursstraat-split', (veloursSplitRepro as any).geoJson ?? veloursSplitRepro],
      ['Parallelweg-4arm-split', (parallelwegSplitRepro as any).geoJson ?? parallelwegSplitRepro],
      ['Prinses-Beatrixstraat-adjacent-service', PRINSES_BEATRIXSTRAAT_ADJACENT_SERVICE_REPRO],
    ] as const;

    for (const [name, geoJson] of fixtures) {
      const data = provider.parseGeoJson(geoJson, name);
      const scene = buildSurfaceFirstScene(data);

      try {
        const stats: GraphRoadRenderStats = scene.roadsGroup.userData.graphRoadStats;
        const timing: GraphRoadGenerationTiming = scene.roadsGroup.userData.graphRoadTiming;
        assert.ok(stats, `${name}: expected graphRoadStats`);
        assert.ok(timing, `${name}: expected graphRoadTiming`);
        assert.equal(stats.renderedJunctionCount, 0, `${name}: E2+ must not emit junction patches`);
        assert.ok(stats.renderedRoadRibbonCount > 0, `${name}: expected rendered road strokes`);
        assert.ok(stats.outputTriangleCount > 0, `${name}: expected positive outputTriangleCount`);
        assert.ok(
          stats.generatedRectanglePrimitiveCount > 0,
          `${name}: expected positive rectangle primitives`
        );
        assert.ok(
          timing.totalRoadGenerationTimeMs >= 0,
          `${name}: expected non-negative road generation timing`
        );

        const validation = validateSurfaceFirstRoadGeometry(scene, data);
        assert.equal(
          validation.valid,
          true,
          `${name}: expected valid E2+ geometry report, got defects: ${JSON.stringify({
            coverage: validation.coverage.defects,
            overlaps: validation.overlaps.categorizedOverlaps,
            winding: validation.meshIntegrity.auditReport.windingDefects,
            degenerate: validation.meshIntegrity.auditReport.degenerateTriangles,
            artifacts: validation.meshIntegrity.artifacts,
            provenance: validation.provenance.defects,
          })}`
        );
        assert.ok(
          validation.coverage.networkCoverageRatio > 0.96,
          `${name}: expected >96% network coverage ratio, got ${validation.coverage.networkCoverageRatio}`
        );
      } finally {
        scene.dispose();
      }
    }
  });

  it('A1–A5: validates straight/curved roads, 2-/3-/4-way junctions, acute forks, mixed vehicular/path crossings, width transitions, closed loops, boundary clips, and grade transitions', () => {
    const data = createSyntheticDataset([
      // 1. Straight residential road with unclipped dead-end endpoints
      {
        id: 'way/straight-res',
        roadClass: 'residential',
        width: 6.5,
        points: [
          [-160, -120],
          [-100, -120],
        ],
        nodeIds: ['n-s1', 'n-s2'],
        name: 'Rechtestraat',
      },
      // 2. Curved secondary road with interior bends (> 3 deg)
      {
        id: 'way/curved-sec',
        roadClass: 'secondary',
        width: 8.5,
        points: [
          [-160, -80],
          [-135, -75],
          [-115, -62],
          [-95, -40],
        ],
        nodeIds: ['n-c1', 'n-c2', 'n-c3', 'n-c4'],
        name: 'Bochtweg',
      },
      // 3. Degree-2 width transition at shared node n-w2 (primary 10m -> secondary 7m)
      {
        id: 'way/width-trans-a',
        roadClass: 'primary',
        width: 10.0,
        points: [
          [-160, -10],
          [-120, -10],
        ],
        nodeIds: ['n-w1', 'n-w2'],
        name: 'Bredebaan',
      },
      {
        id: 'way/width-trans-b',
        roadClass: 'secondary',
        width: 7.0,
        points: [
          [-120, -10],
          [-80, -10],
        ],
        nodeIds: ['n-w2', 'n-w3'],
        name: 'Smallebaan',
      },
      // 4. 4-way crossroad + mixed vehicular and footway/cycleway intersection at node n-x0 (0, 0)
      {
        id: 'way/cross-primary-w',
        roadClass: 'primary',
        width: 10.0,
        points: [
          [-50, 0],
          [0, 0],
        ],
        nodeIds: ['n-xw', 'n-x0'],
        name: 'Hoofdweg West',
      },
      {
        id: 'way/cross-primary-e',
        roadClass: 'primary',
        width: 10.0,
        points: [
          [0, 0],
          [50, 0],
        ],
        nodeIds: ['n-x0', 'n-xe'],
        name: 'Hoofdweg Oost',
      },
      {
        id: 'way/cross-res-n',
        roadClass: 'residential',
        width: 6.5,
        points: [
          [0, 0],
          [0, 45],
        ],
        nodeIds: ['n-x0', 'n-xn'],
        name: 'Zijstraat Noord',
      },
      {
        id: 'way/cross-res-s',
        roadClass: 'residential',
        width: 6.5,
        points: [
          [0, 0],
          [0, -45],
        ],
        nodeIds: ['n-x0', 'n-xs'],
        name: 'Zijstraat Zuid',
      },
      // Cycleway crossing the primary road at-grade
      {
        id: 'way/cross-cycleway',
        roadClass: 'cycleway',
        width: 2.5,
        points: [
          [-20, -30],
          [-20, 30],
        ],
        nodeIds: ['n-cy1', 'n-cy2'],
        name: 'Fietspad',
      },
      // 5. 3-way T-junction + acute fork at n-xe (50, 0)
      {
        id: 'way/fork-branch-a',
        roadClass: 'tertiary',
        width: 7.0,
        points: [
          [50, 0],
          [95, 12],
        ],
        nodeIds: ['n-xe', 'n-fa'],
        name: 'Vork Noord',
      },
      {
        id: 'way/fork-branch-b',
        roadClass: 'tertiary',
        width: 7.0,
        points: [
          [50, 0],
          [95, -6],
        ],
        nodeIds: ['n-xe', 'n-fb'],
        name: 'Vork Zuid',
      },
      // 6. Closed loop roundabout
      {
        id: 'way/closed-roundabout',
        roadClass: 'tertiary',
        width: 6.0,
        points: [
          [120, 60],
          [135, 60],
          [142, 72],
          [135, 84],
          [120, 84],
          [113, 72],
          [120, 60],
        ],
        nodeIds: ['n-r1', 'n-r2', 'n-r3', 'n-r4', 'n-r5', 'n-r6', 'n-r1'],
        name: 'Rotonde',
      },
      // 7. Dataset boundary clipped road (flat ends, caps suppressed)
      {
        id: 'way/boundary-clipped',
        roadClass: 'secondary',
        width: 8.0,
        points: [
          [-180, 70],
          [-120, 70],
        ],
        nodeIds: ['n-bc1', 'n-bc2'],
        clippedAtStart: true,
        clippedAtEnd: true,
        name: 'Randweg',
      },
      // 8. Grade transition at n-br1 (at-grade road meeting elevated bridge deck) + nearby unconnected dead-end road
      {
        id: 'way/bridge-approach',
        roadClass: 'secondary',
        width: 8.0,
        points: [
          [-60, 80],
          [-20, 80],
        ],
        nodeIds: ['n-br0', 'n-br1'],
        name: 'Brugtoerit',
      },
      {
        id: 'way/bridge-span',
        roadClass: 'secondary',
        width: 8.0,
        layer: 1,
        isBridge: true,
        points: [
          [-20, 80],
          [40, 80],
        ],
        nodeIds: ['n-br1', 'n-br2'],
        name: 'Hoogbrug',
      },
      {
        id: 'way/nearby-unconnected-culdesac',
        roadClass: 'residential',
        width: 6.0,
        points: [
          [-20, 68],
          [-60, 68],
        ],
        nodeIds: ['n-cul1', 'n-cul2'],
        name: 'Parallel Doodlopend',
      },
    ]);

    const scene = buildSurfaceFirstScene(data);
    try {
      const validation = validateSurfaceFirstRoadGeometry(scene, data);
      assert.equal(
        validation.valid,
        true,
        `Expected all synthetic scenarios to pass validation, got defects: ${JSON.stringify({
          coverage: validation.coverage.defects,
          overlaps: validation.overlaps.categorizedOverlaps,
          winding: validation.meshIntegrity.auditReport.windingDefects,
          artifacts: validation.meshIntegrity.artifacts,
          provenance: validation.provenance.defects,
        })}`
      );
      assert.equal(validation.overlaps.totalPositiveAreaOverlapCount, 0);
      assert.equal(validation.meshIntegrity.auditReport.windingDefects.length, 0);
      assert.equal(validation.meshIntegrity.auditReport.degenerateTriangles.length, 0);
      assert.equal(validation.meshIntegrity.inconsistentElevationDefectCount, 0);
      assert.equal(validation.provenance.defects.length, 0);
      assert.ok(
        validation.coverage.legitimatelyPartiallyClippedFeatureIds.length >= 2,
        'Expected lower-priority intersecting roads/cycleways to be recorded as legitimately partially clipped'
      );
    } finally {
      scene.dispose();
    }
  });

  it('A4: preserves sourceFeatureId, sourceFeatureIds, OSM tags, and spatial bounds across provenance splits, deduplicated ways, and fully subtracted paths', () => {
    const data = createSyntheticDataset([
      // 3 compatible residential ways with same street name chained into 1 simplified graph edge along Z=0
      {
        id: 'way/chain-west',
        sourceFeatureId: 'way/chain-west',
        roadClass: 'residential',
        width: 7.0,
        name: 'Ketenspoor',
        osmTags: { section: 'WEST' },
        points: [
          [-90, 0],
          [-30, 0],
        ],
        nodeIds: ['c1', 'c2'],
      },
      // Duplicate of way/chain-west
      {
        id: 'way/chain-west-dup',
        sourceFeatureId: 'way/chain-west-dup',
        roadClass: 'residential',
        width: 7.0,
        name: 'Ketenspoor',
        osmTags: { section: 'WEST' },
        points: [
          [-30, 0],
          [-90, 0],
        ],
        nodeIds: ['c2', 'c1'],
      },
      {
        id: 'way/chain-mid',
        sourceFeatureId: 'way/chain-mid',
        roadClass: 'residential',
        width: 7.0,
        name: 'Ketenspoor',
        osmTags: { section: 'MID' },
        points: [
          [-30, 0],
          [30, 0],
        ],
        nodeIds: ['c2', 'c3'],
      },
      {
        id: 'way/chain-east',
        sourceFeatureId: 'way/chain-east',
        roadClass: 'residential',
        width: 7.0,
        name: 'Ketenspoor',
        osmTags: { section: 'EAST' },
        points: [
          [30, 0],
          [90, 0],
        ],
        nodeIds: ['c3', 'c4'],
      },
      // Short footway completely occluded inside way/chain-mid carriageway
      {
        id: 'way/occluded-footway',
        sourceFeatureId: 'way/occluded-footway',
        roadClass: 'footway',
        width: 1.5,
        name: 'Verborgen Pad',
        points: [
          [-15, 0],
          [15, 0],
        ],
        nodeIds: ['f1', 'f2'],
      },
    ]);

    const scene = buildSurfaceFirstScene(data);
    try {
      const stats: GraphRoadRenderStats = scene.roadsGroup.userData.graphRoadStats;
      assert.equal(stats.provenanceSplitSegmentCount, 2);
      assert.equal(stats.fullySubtractedCount, 1);

      const validation = validateSurfaceFirstRoadGeometry(scene, data);
      assert.equal(validation.valid, true);
      assert.ok(validation.provenance.verifiedSourceFeatureIds.includes('way/chain-west'));
      assert.ok(validation.provenance.verifiedSourceFeatureIds.includes('way/chain-mid'));
      assert.ok(validation.provenance.verifiedSourceFeatureIds.includes('way/chain-east'));
      assert.ok(validation.provenance.verifiedDeduplicatedSurvivorIds.includes('way/chain-west'));
      assert.ok(validation.provenance.verifiedFullySubtractedIds.includes('way/occluded-footway'));
      assert.ok(
        validation.coverage.legitimatelyFullSubtractedFeatureIds.includes('way/occluded-footway')
      );
    } finally {
      scene.dispose();
    }
  });

  it('A1 defect reproduction: detects outer-corner wedge gap when a simplified edge bends at an internal provenance split boundary', () => {
    // Two compatible residential ways with same name and different custom tags meeting at a 60-degree bend at node (0, 0).
    // RoadNetworkBuilder chains them into 1 simplified graph edge with 2 provenance segments (#seg0 and #seg1).
    // In E2+, capEnd on #seg0 is false and capStart on #seg1 is false at internal provenance split boundaries,
    // leaving an unrounded outer-corner wedge gap at (0, 0).
    const data = createSyntheticDataset([
      {
        id: 'way/bent-chain-a',
        sourceFeatureId: 'way/bent-chain-a',
        roadClass: 'residential',
        width: 8.0,
        name: 'Bochtstraat',
        osmTags: { segment: 'A' },
        points: [
          [-40, 0],
          [0, 0],
        ],
        nodeIds: ['b1', 'b2'],
      },
      {
        id: 'way/bent-chain-b',
        sourceFeatureId: 'way/bent-chain-b',
        roadClass: 'residential',
        width: 8.0,
        name: 'Bochtstraat',
        osmTags: { segment: 'B' },
        points: [
          [0, 0],
          [20, 35],
        ],
        nodeIds: ['b2', 'b3'],
      },
    ]);

    const scene = buildSurfaceFirstScene(data);
    try {
      const validation = validateSurfaceFirstRoadGeometry(scene, data);
      const bendGapDefects = validation.coverage.defects.filter(
        (d) => d.kind === 'provenance_split_bend_gap'
      );
      assert.equal(
        bendGapDefects.length,
        1,
        'Expected validator to detect the outer-corner wedge gap at an angled internal provenance split boundary'
      );
      assert.equal(bendGapDefects[0].sourceFeatureId, 'way/bent-chain-a');
    } finally {
      scene.dispose();
    }
  });

  it('negative validation tests: catches synthetic missing coverage, coplanar overlaps, inverted winding, elevation drift, and corrupted provenance', () => {
    const data = createSyntheticDataset([
      {
        id: 'way/neg-primary',
        roadClass: 'primary',
        width: 8.0,
        points: [
          [-30, 0],
          [30, 0],
        ],
        nodeIds: ['np1', 'np2'],
        osmTags: { ref: 'N100' },
      },
      {
        id: 'way/neg-secondary',
        roadClass: 'secondary',
        width: 6.0,
        points: [
          [-30, 25],
          [30, 25],
        ],
        nodeIds: ['ns1', 'ns2'],
      },
    ]);

    // 1. Baseline is clean
    const cleanScene = buildSurfaceFirstScene(data);
    assert.equal(validateSurfaceFirstRoadGeometry(cleanScene, data).valid, true);
    cleanScene.dispose();

    // 2. Corrupt scene by removing Roads_secondary mesh -> triggers omitted_road_feature
    const missingScene = buildSurfaceFirstScene(data);
    const secMesh = missingScene.roadsGroup.children.find((c) => c.name === 'Roads_secondary');
    assert.ok(secMesh);
    missingScene.roadsGroup.remove(secMesh!);
    const missingReport = validateSurfaceFirstRoadGeometry(missingScene, data);
    assert.equal(missingReport.valid, false);
    assert.ok(
      missingReport.coverage.defects.some(
        (d) => d.kind === 'omitted_road_feature' && d.sourceFeatureId === 'way/neg-secondary'
      ),
      'Validator must detect omitted road feature when mesh is missing'
    );
    missingScene.dispose();

    // 3. Inject coplanar overlapping triangle on Roads_secondary at (0, 0) overlapping Roads_primary
    const overlapScene = buildSurfaceFirstScene(data);
    const overlapGeo = new THREE.BufferGeometry();
    const y = ELEVATION_POLICY.ROAD_SURFACE;
    overlapGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-5, y, -2, -5, y, 2, 5, y, 2], 3)
    );
    overlapGeo.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3)
    );
    overlapGeo.setIndex([0, 1, 2]);
    const rogueMesh = new THREE.Mesh(overlapGeo, new THREE.MeshBasicMaterial());
    rogueMesh.name = 'Roads_tertiary';
    rogueMesh.userData = {
      faceRanges: [
        {
          startFace: 0,
          endFace: 1,
          info: {
            id: 'way/neg-secondary',
            sourceFeatureId: 'way/neg-secondary',
            sourceFeatureIds: ['way/neg-secondary'],
            name: 'Rogue',
            category: 'Road & Way',
            cartoLabel: 'Tertiary',
            primaryTag: 'highway=tertiary',
            subtype: 'tertiary',
            width: 6,
            elevation: y,
            layer: 0,
            isBridge: false,
            isTunnel: false,
            osmTags: { highway: 'secondary' },
          },
        },
      ],
    };
    overlapScene.roadsGroup.add(rogueMesh);
    const overlapReport = validateSurfaceFirstRoadGeometry(overlapScene, data);
    assert.equal(overlapReport.valid, false);
    assert.ok(
      overlapReport.overlaps.totalPositiveAreaOverlapCount > 0,
      'Validator must detect injected coplanar positive-area road overlap'
    );
    assert.ok(
      overlapReport.provenance.defects.some((d) => d.kind === 'road_class_mismatch'),
      'Validator must detect subtype/roadClass mismatch on rogue mesh'
    );
    overlapGeo.dispose();
    overlapScene.dispose();

    // 4. Corrupt winding & elevation on Roads_primary
    const corruptMeshScene = buildSurfaceFirstScene(data);
    const primMesh = corruptMeshScene.roadsGroup.children.find(
      (c) => c.name === 'Roads_primary'
    ) as THREE.Mesh;
    assert.ok(primMesh);
    const idxAttr = primMesh.geometry.getIndex()!;
    const i0 = idxAttr.getX(0);
    const i1 = idxAttr.getX(1);
    // Swap i0 and i1 to invert winding of face 0
    idxAttr.setX(0, i1);
    idxAttr.setX(1, i0);
    // Shift vertex 0 elevation by +0.25m
    const posAttr = primMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    posAttr.setY(i0, ELEVATION_POLICY.ROAD_SURFACE + 0.25);
    // Corrupt faceRanges[0].info.osmTags
    (primMesh.userData.faceRanges as FaceFeatureRange[])[0].info.osmTags = { ref: 'CORRUPTED' };

    const corruptReport = validateSurfaceFirstRoadGeometry(corruptMeshScene, data);
    assert.equal(corruptReport.valid, false);
    assert.ok(
      corruptReport.meshIntegrity.auditReport.windingDefects.length > 0,
      'Validator must detect inverted triangle winding'
    );
    assert.ok(
      corruptReport.meshIntegrity.inconsistentElevationDefectCount > 0,
      'Validator must detect inconsistent vertex elevation'
    );
    assert.ok(
      corruptReport.provenance.defects.some((d) => d.kind === 'osm_tag_mismatch'),
      'Validator must detect corrupted OSM tag provenance'
    );
    corruptMeshScene.dispose();
  });

  it('B1–B3: instrumentation is bit-for-bit geometry-invariant, deterministic across permutations, and resets cleanly across builds', () => {
    const pts: [number, number][] = [
      [-40, -10],
      [-10, -10],
      [15, 12],
      [45, 12],
    ];
    const uninstrumentedPoly = bufferSurfaceFirstRoadCenterline(pts, 7.5, {
      capStart: true,
      capEnd: true,
    });
    const inst: SurfaceFirstBufferInstrumentation = {
      rectanglePrimitiveCount: 0,
      bendDiskPrimitiveCount: 0,
      capDiskPrimitiveCount: 0,
      unionOperationCount: 0,
      primitiveConstructionTimeMs: 0,
      polygonUnionTimeMs: 0,
    };
    const instrumentedPoly = bufferSurfaceFirstRoadCenterline(
      pts,
      7.5,
      { capStart: true, capEnd: true },
      inst
    );
    assert.deepEqual(
      instrumentedPoly,
      uninstrumentedPoly,
      'bufferSurfaceFirstRoadCenterline output must be bit-for-bit identical with or without instrumentation'
    );
    assert.equal(inst.rectanglePrimitiveCount, 3);
    assert.equal(inst.bendDiskPrimitiveCount, 2);
    assert.equal(inst.capDiskPrimitiveCount, 2);
    assert.equal(inst.unionOperationCount, 1);

    // Check determinism across reversed input feature ordering and counter reset across consecutive builds
    const provider = new LocalGeoJsonProvider();
    const forwardData = provider.parseGeoJson(
      NIEUWSTRAAT_PEDESTRIAN_REPRO,
      'Nieuwstraat-Forward'
    );
    const reversedGeoJson = {
      ...NIEUWSTRAAT_PEDESTRIAN_REPRO,
      features: [...NIEUWSTRAAT_PEDESTRIAN_REPRO.features].reverse(),
    };
    const reversedData = provider.parseGeoJson(reversedGeoJson, 'Nieuwstraat-Reversed');

    const scene1 = buildSurfaceFirstScene(forwardData);
    const scene2 = buildSurfaceFirstScene(reversedData);

    try {
      const stats1: GraphRoadRenderStats = scene1.roadsGroup.userData.graphRoadStats;
      const stats2: GraphRoadRenderStats = scene2.roadsGroup.userData.graphRoadStats;
      assert.deepEqual(
        stats1,
        stats2,
        'All GraphRoadRenderStats counters must be deterministic and invariant to input feature order'
      );

      const val1 = validateSurfaceFirstRoadGeometry(scene1, forwardData);
      const val2 = validateSurfaceFirstRoadGeometry(scene2, reversedData);
      assert.deepEqual(
        val1,
        val2,
        'SurfaceFirstRoadValidationReport must be deterministic across runs and input permutations'
      );
    } finally {
      scene1.dispose();
      scene2.dispose();
    }
  });
});
