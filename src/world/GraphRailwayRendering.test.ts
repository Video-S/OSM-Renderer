import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  ProcessedMapData,
  RailwayFeature,
  RawGeoJsonProperties,
} from '../types/MapFeature';
import { MAP_THEMES } from '../styles/mapThemes';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { GeometryBuilder, SceneResourceManager } from './GeometryBuilder';
import {
  buildRailwayInfrastructure,
  BuildRailwayPrototypeOptions,
  RailwayPrototypeResult,
} from './infrastructure/railways/RailwayGeometryBuilder';
import {
  adaptRailwayEdgeDescriptorsToFeatures,
  normalizeInfrastructureRenderOptions,
  parseInfrastructureRenderOptionsFromSearch,
  parseRailwayBallastStrategy,
  parseRailwayInfrastructureRenderSource,
  prepareInfrastructureRenderPreview,
  RailwayEdgeRenderDescriptor,
} from './infrastructure/rendering/InfrastructureRenderAdapter';
import {
  buildAtGradeBallastFootprints,
  groupBallastConnectedComponents,
  buildSurfaceFirstRailwayBallastGeometries,
  computeMultiPolygonArea,
} from './infrastructure/railways/SurfaceFirstRailwayBallast';
import {
  buildRailwayNetwork,
} from './infrastructure/topology/RailwayNetworkBuilder';
import {
  buildInfrastructureGraph,
} from './infrastructure/topology/InfrastructureGraph';
import { createRailwayPrototypeFixtureData } from './prototype/RailwayTestFixtures';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadOfflineRailwayExtract(regionKey: 'hengelo' | 'amsterdamCentraal'): ProcessedMapData {
  const extractPath = path.resolve(__dirname, 'prototype', 'realOsmRailwayExtracts.json');
  assert.ok(fs.existsSync(extractPath), `Extract file must exist at ${extractPath}`);
  const rawExtract = JSON.parse(fs.readFileSync(extractPath, 'utf-8'));
  const rawRegion = rawExtract.regions[regionKey];
  assert.ok(rawRegion, `Region ${regionKey} must exist in extract file`);

  const regionFc: any = {
    type: 'FeatureCollection',
    name: regionKey === 'hengelo' ? 'Station Hengelo' : 'Amsterdam Centraal',
    features: rawRegion.features || rawRegion,
  };

  const provider = new LocalGeoJsonProvider();
  return provider.parseGeoJson(regionFc);
}

function createSyntheticRailwayTrack(
  id: string,
  points: [number, number][],
  overrides: Partial<RailwayFeature> = {}
): RailwayFeature {
  return {
    id,
    sourceFeatureId: overrides.sourceFeatureId || id,
    sourceFeatureIds: overrides.sourceFeatureIds || [overrides.sourceFeatureId || id],
    type: 'railway',
    railwayType: overrides.railwayType || 'rail',
    width: overrides.width || 3.5,
    layer: overrides.layer ?? 0,
    isBridge: overrides.isBridge ?? false,
    isTunnel: overrides.isTunnel ?? false,
    points,
    nodeIds: overrides.nodeIds,
    name: overrides.name,
    cartoLabel: overrides.cartoLabel || 'Railway Track',
    primaryTag: overrides.primaryTag || 'railway=rail',
    osmTags: {
      railway: 'rail',
      ...(overrides.osmTags || {}),
    },
  };
}

function createBaseProcessedMapData(railways: RailwayFeature[]): ProcessedMapData {
  return {
    regionName: 'GraphRailwayRendering Test Region',
    centerLonLat: [6.7935, 52.2625],
    bounds: {
      minX: -500,
      maxX: 500,
      minZ: -500,
      maxZ: 500,
      widthMeters: 1000,
      depthMeters: 1000,
    },
    buildings: [],
    roads: [],
    railways,
    water: [],
    waterBodies: [],
    linearWaterways: [],
    parks: [],
    landuse: [],
    barriers: [],
    landmarks: [],
    stats: {
      totalBuildings: 0,
      totalRoads: 0,
      totalRoadSegments: 0,
      totalRailways: railways.length,
      totalRailwaySegments: railways.length,
      totalWaterPolygons: 0,
      totalLinearWaterways: 0,
      totalParkPolygons: 0,
      totalLandusePolygons: 0,
      totalBarriers: 0,
      totalLandmarks: 0,
      areaKm2: 1.0,
    },
    diagnostics: {
      totalFeaturesReceived: railways.length,
      sourceFeaturesReceived: railways.length,
      sourceFeaturesClassified: railways.length,
      totalFeaturesParsed: railways.length,
      sourceFeaturesRendered: 0,
      totalFeaturesRendered: 0,
      constructedMeshesCount: 0,
      parsedByCategory: {
        buildings: 0,
        roads: 0,
        railways: railways.length,
        waterBodies: 0,
        linearWaterways: 0,
        parks: 0,
        landuse: 0,
      },
      geometryPartsGenerated: {
        total: railways.length,
        byCategory: {
          buildings: 0,
          roads: 0,
          railways: railways.length,
          waterBodies: 0,
          linearWaterways: 0,
          parks: 0,
          landuse: 0,
        },
      },
      skippedUnsupported: { total: 0, byTag: {} },
      rejectedInvalid: { total: 0, byReason: {} },
      byGeometryType: {
        Point: 0,
        MultiPoint: 0,
        LineString: railways.length,
        MultiLineString: 0,
        Polygon: 0,
        MultiPolygon: 0,
        GeometryCollection: 0,
        Unknown: 0,
      },
    },
  };
}

describe('Milestone 2.3 Stage E3-A1: Railway Graph Descriptor Integration', () => {

  // ==========================================================================
  // 1. DESCRIPTOR PARSING & ADAPTER TRANSFORMATION
  // ==========================================================================
  describe('1. Descriptor Parsing & Adapter Transformation', () => {
    it('normalizes topologyRailways options to permanent graph-R+ production contract', () => {
      assert.equal(parseRailwayInfrastructureRenderSource('graph-R+'), 'graph-R+');
      assert.equal(parseRailwayInfrastructureRenderSource('unknown'), 'graph-R+');
      assert.equal(parseRailwayInfrastructureRenderSource(null), 'graph-R+');
      assert.equal(parseRailwayInfrastructureRenderSource(undefined), 'graph-R+');

      const parsedOpts = parseInfrastructureRenderOptionsFromSearch(
        '?topologyRoads=graph-surface&topologyRailways=graph-R+'
      );
      assert.equal(parsedOpts.roads, 'graph-surface');
      assert.equal(parsedOpts.railways, 'graph-R+');

      const normalized = normalizeInfrastructureRenderOptions({
        roads: 'graph-surface',
        railways: 'graph-R+',
      });
      assert.equal(normalized.railways, 'graph-R+');
    });

    it('adaptRailwayEdgeDescriptorsToFeatures transforms descriptors preserving geometry and full provenance', () => {
      const mockEdge: RailwayEdgeRenderDescriptor = {
        id: 'rail_edge:0|0|0:osm_100:osm_200:0',
        fromNodeId: 'rail_node:0|0|0:osm_100',
        toNodeId: 'rail_node:0|0|0:osm_200',
        parallelIndex: 0,
        points: [
          [0, 0],
          [50, 0],
          [100, 0],
        ],
        vertexRawOsmNodeIds: ['100', undefined, '200'],
        lengthMeters: 100,
        railwayType: 'rail',
        width: 3.5,
        gauge: '1435',
        electrified: 'contact_line',
        service: 'siding',
        usage: 'branch',
        name: 'Twente Branch',
        isSecondaryBranch: true,
        layer: 0,
        isBridge: false,
        isTunnel: false,
        isClosedLoop: false,
        clippedAtStart: false,
        clippedAtEnd: false,
        startInwardTangent: [1, 0],
        endInwardTangent: [-1, 0],
        startNodeRoles: ['dead_end'],
        endNodeRoles: ['dead_end'],
        startTurnoutStatus: 'none',
        endTurnoutStatus: 'none',
        hasConfirmedSwitchAtStart: false,
        hasConfirmedSwitchAtEnd: false,
        sourceFeatureId: 'way/1001',
        sourceFeatureIds: ['way/1001', 'way/1002'],
        deduplicatedFeatureIds: ['way/1003'],
        primaryOsmTags: {
          railway: 'rail',
          service: 'siding',
          name: 'Twente Branch',
        },
        provenance: {
          primaryPartId: 'way/1001-0',
          mergedPartIds: ['way/1001-0', 'way/1002-0'],
          sourceFeatureIds: ['way/1001', 'way/1002'],
          segments: [
            {
              partId: 'way/1001-0',
              sourceFeatureId: 'way/1001',
              deduplicatedFeatureIds: [],
              startArcLength: 0,
              endArcLength: 50,
              startVertexIndex: 0,
              endVertexIndex: 1,
              sourceStartVertexIndex: 0,
              sourceEndVertexIndex: 1,
              reversedRelativeToSource: false,
              osmTags: { railway: 'rail', service: 'siding' },
            },
            {
              partId: 'way/1002-0',
              sourceFeatureId: 'way/1002',
              deduplicatedFeatureIds: [],
              startArcLength: 50,
              endArcLength: 100,
              startVertexIndex: 1,
              endVertexIndex: 2,
              sourceStartVertexIndex: 0,
              sourceEndVertexIndex: 1,
              reversedRelativeToSource: false,
              osmTags: { railway: 'rail', service: 'siding' },
            },
          ],
        },
        flatCrossingIds: [],
        gradeTransitionIds: [],
        levelCrossingIds: [],
        gradeSeparatedCrossingIds: [],
      };

      const adapted = adaptRailwayEdgeDescriptorsToFeatures([mockEdge]);
      assert.equal(adapted.length, 1);
      const feat = adapted[0];

      assert.equal(feat.id, mockEdge.id);
      assert.equal(feat.sourceFeatureId, 'way/1001');
      assert.deepEqual(feat.sourceFeatureIds, ['way/1001', 'way/1002']);
      assert.equal(feat.railwayType, 'rail');
      assert.equal(feat.width, 3.5);
      assert.equal(feat.gauge, 1435);
      assert.equal(feat.electrified, true);
      assert.equal(feat.isBridge, false);
      assert.equal(feat.isTunnel, false);
      assert.equal(feat.layer, 0);
      assert.equal(feat.name, 'Twente Branch');
      assert.equal(feat.osmTags?.service, 'siding');
      assert.equal(feat.osmTags?.usage, 'branch');
      assert.deepEqual(feat.points, [
        [0, 0],
        [50, 0],
        [100, 0],
      ]);
      assert.deepEqual(feat.nodeIds, ['100', '', '200']);
    });
  });

  // ==========================================================================
  // 2. OBSERVABLE FALLBACK CONTRACT
  // ==========================================================================
  describe('2. Observable Fallback Contract', () => {
    it('gracefully falls back to raw railway features when graph descriptors are explicitly null and no topologySource exists', () => {
      const tracks = [
        createSyntheticRailwayTrack('way/1', [
          [0, 0],
          [40, 0],
        ]),
      ];
      const data = createBaseProcessedMapData(tracks);

      const result = buildRailwayInfrastructure(data, MAP_THEMES.tactical, 1.0, {
        renderSource: 'graph-R+',
        descriptors: null,
        diagnostics: data.diagnostics,
      });

      assert.ok(result);
      assert.equal(result.stats.railwayRenderSource, 'graph-R+');
      assert.equal(result.stats.graphFallbackOccurred, true);
      assert.equal(result.stats.graphFallbackReason, 'missing_or_empty_descriptors');
      assert.equal(
        data.diagnostics?.railwayRendererFallback,
        'legacy_due_to_missing_descriptors'
      );
      assert.ok(result.stats.renderedRailwaysCount > 0);
      assert.ok(result.renderedSourceIds.has('way/1'));

      result.dispose();
    });

    it('falls back without leaking resources or duplicating meshes', () => {
      const tracks = [
        createSyntheticRailwayTrack('way/1', [
          [0, 0],
          [30, 0],
        ]),
        createSyntheticRailwayTrack('way/2', [
          [30, 0],
          [60, 0],
        ]),
      ];
      const data = createBaseProcessedMapData(tracks);
      const resMgr = new SceneResourceManager();
      const group = new THREE.Group();

      const result = buildRailwayInfrastructure(data, MAP_THEMES.daylight, 1.0, {
        renderSource: 'graph-R+',
        descriptors: null,
        resourceManager: resMgr,
        targetGroup: group,
      });

      assert.equal(result.stats.graphFallbackOccurred, true);
      assert.ok(group.children.length > 0);

      result.dispose();
      assert.equal(group.children.length, 0);
      resMgr.dispose();
    });
  });

  // ==========================================================================
  // 3. SYNTHETIC SWITCHYARD REGRESSION PARITY
  // ==========================================================================
  describe('3. Synthetic Switchyard Regression Parity', () => {
    it('renders 100% of switchyard source ways with 3D sleepers and turnout bearers in Graph R+ Candidate B', () => {
      const switchyardData = createRailwayPrototypeFixtureData();
      assert.ok(switchyardData.railways.length >= 60, 'Switchyard fixture must have >= 60 railway ways');

      const graphResult = buildRailwayInfrastructure(
        switchyardData,
        MAP_THEMES.tactical,
        1.0,
        { renderSource: 'graph-R+' }
      );

      assert.equal(graphResult.stats.railwayRenderSource, 'graph-R+');
      assert.equal(graphResult.stats.graphFallbackOccurred, false);

      assert.equal(
        graphResult.renderedSourceIds.size,
        switchyardData.railways.length,
        'Graph R+ must render 100% of switchyard source ways via provenance'
      );

      assert.ok(graphResult.stats.totalVertices > 0);
      assert.ok(graphResult.stats.drawCalls > 0);
      assert.ok(graphResult.stats.sleeper3DBoxCount > 500);
      assert.ok(graphResult.stats.turnoutBearerCount > 0);

      graphResult.dispose();
    });
  });

  // ==========================================================================
  // 4. STATION HENGELO REAL OSM EXTRACT REGRESSION
  // ==========================================================================
  describe('4. Station Hengelo Real OSM Extract Regression', () => {
    it('renders all 67 source ways with accurate provenance and continuous rails in Graph R+ mode', () => {
      const hengeloData = loadOfflineRailwayExtract('hengelo');
      assert.equal(hengeloData.railways.length, 67, 'Station Hengelo must contain 67 railway features');

      const graphResult = buildRailwayInfrastructure(
        hengeloData,
        MAP_THEMES.tactical,
        1.0,
        { renderSource: 'graph-R+' }
      );

      assert.equal(graphResult.stats.railwayRenderSource, 'graph-R+');
      assert.equal(graphResult.stats.graphFallbackOccurred, false);
      assert.equal(graphResult.renderedSourceIds.size, 67);

      assert.ok(
        graphResult.stats.graphEdgeCount! < graphResult.stats.sourceRailwayCount!,
        `Graph simplification must contract degree-2 chains (edges=${graphResult.stats.graphEdgeCount}, ways=${graphResult.stats.sourceRailwayCount})`
      );
      assert.ok(graphResult.stats.sleeper3DBoxCount > 500);

      graphResult.dispose();
    });
  });

  // ==========================================================================
  // 5. AMSTERDAM CENTRAAL REAL OSM EXTRACT REGRESSION
  // ==========================================================================
  describe('5. Amsterdam Centraal Complex Terminal Throat Extract', () => {
    it('successfully renders complex dense throat with 100% source provenance', () => {
      const amsterdamData = loadOfflineRailwayExtract('amsterdamCentraal');
      assert.equal(
        amsterdamData.railways.length,
        325,
        'Amsterdam Centraal extract must contain 325 railway features'
      );

      const graphResult = buildRailwayInfrastructure(
        amsterdamData,
        MAP_THEMES.daylight,
        1.0,
        { renderSource: 'graph-R+' }
      );

      assert.equal(graphResult.stats.railwayRenderSource, 'graph-R+');
      assert.equal(graphResult.renderedSourceIds.size, 325);
      assert.ok(graphResult.stats.totalTriangles > 5000);
      assert.ok(graphResult.stats.drawCalls > 0);

      graphResult.dispose();
    });
  });

  // ==========================================================================
  // 6. CHAINED SHORT RAILWAY WAYS & REVERSED ORIENTATIONS
  // ==========================================================================
  describe('6. Chained Short Railway Ways & Reversed Orientations', () => {
    it('contracts colinear chained ways into a seamless continuous rail extrusion', () => {
      const track1 = createSyntheticRailwayTrack(
        'way/101',
        [
          [0, 0],
          [20, 0],
        ],
        { nodeIds: ['1', '2'] }
      );
      const track2 = createSyntheticRailwayTrack(
        'way/102',
        [
          [20, 0],
          [40, 0],
        ],
        { nodeIds: ['2', '3'] }
      );
      const track3 = createSyntheticRailwayTrack(
        'way/103',
        [
          [40, 0],
          [60, 0],
        ],
        { nodeIds: ['3', '4'] }
      );

      const data = createBaseProcessedMapData([track1, track2, track3]);

      const graphResult = buildRailwayInfrastructure(
        data,
        MAP_THEMES.tactical,
        1.0,
        { renderSource: 'graph-R+' }
      );

      assert.equal(graphResult.stats.railwayRenderSource, 'graph-R+');
      assert.equal(graphResult.stats.graphEdgeCount, 1, 'All 3 chained ways must contract into 1 simplified edge');

      assert.ok(graphResult.renderedSourceIds.has('way/101'));
      assert.ok(graphResult.renderedSourceIds.has('way/102'));
      assert.ok(graphResult.renderedSourceIds.has('way/103'));

      graphResult.dispose();
    });

    it('handles reversed digitized ways seamlessly without tangent flip artifacts', () => {
      const track1 = createSyntheticRailwayTrack(
        'way/201',
        [
          [0, 0],
          [25, 0],
        ],
        { nodeIds: ['10', '11'] }
      );
      const track2 = createSyntheticRailwayTrack(
        'way/202',
        [
          [50, 0],
          [25, 0],
        ],
        { nodeIds: ['12', '11'] }
      );

      const data = createBaseProcessedMapData([track1, track2]);

      const graphResult = buildRailwayInfrastructure(
        data,
        MAP_THEMES.tactical,
        1.0,
        { renderSource: 'graph-R+' }
      );

      assert.equal(graphResult.stats.railwayRenderSource, 'graph-R+');
      assert.equal(graphResult.stats.graphEdgeCount, 1);
      assert.ok(graphResult.renderedSourceIds.has('way/201'));
      assert.ok(graphResult.renderedSourceIds.has('way/202'));

      graphResult.dispose();
    });
  });

  // ==========================================================================
  // 7. PARALLEL TRACKS, TURNOUTS, AND FLAT CROSSINGS
  // ==========================================================================
  describe('7. Parallel Tracks, Turnouts, and Flat Crossings', () => {
    it('maintains independent ballast footprints on standard parallel tracks (spacing >= 3.8m)', () => {
      const trackA = createSyntheticRailwayTrack('way/p1', [
        [0, 0],
        [60, 0],
      ]);
      const trackB = createSyntheticRailwayTrack('way/p2', [
        [0, 4.0],
        [60, 4.0],
      ]);

      const data = createBaseProcessedMapData([trackA, trackB]);

      const graphResult = buildRailwayInfrastructure(
        data,
        MAP_THEMES.tactical,
        1.0,
        { renderSource: 'graph-R+' }
      );

      assert.equal(graphResult.stats.renderedRailwaysCount, 2);
      assert.equal(graphResult.renderedSourceIds.size, 2);

      graphResult.dispose();
    });

    it('preserves turnout throat proximity detection under Graph R+ mode', () => {
      const mainTrack = createSyntheticRailwayTrack('way/m1', [
        [0, 0],
        [60, 0],
      ], { nodeIds: ['m_0', 'm_sw'], osmTags: { usage: 'main' } });
      const mainCont = createSyntheticRailwayTrack('way/m2', [
        [60, 0],
        [100, 0],
      ], { nodeIds: ['m_sw', 'm_1'], osmTags: { usage: 'main' } });
      const branchTrack = createSyntheticRailwayTrack('way/b1', [
        [60, 0],
        [80, 1.5],
        [100, 5.0],
      ], { nodeIds: ['m_sw', 'b_1'], osmTags: { usage: 'branch' } });

      const data = createBaseProcessedMapData([mainTrack, mainCont, branchTrack]);

      const graphResult = buildRailwayInfrastructure(
        data,
        MAP_THEMES.tactical,
        1.0,
        { renderSource: 'graph-R+' }
      );

      assert.ok(graphResult.stats.turnoutBearerCount > 0);
      graphResult.dispose();
    });
  });

  // ==========================================================================
  // 8. BRIDGES AND TUNNELS IN GRAPH MODE
  // ==========================================================================
  describe('8. Bridges and Tunnels in Graph Mode', () => {
    it('synthesizes bridge 3D profile, piers, and parapets in Graph mode', () => {
      const bridgeTrack = createSyntheticRailwayTrack(
        'way/bridge1',
        [
          [0, 0],
          [60, 0],
        ],
        { isBridge: true, layer: 1 }
      );
      const data = createBaseProcessedMapData([bridgeTrack]);

      const graphResult = buildRailwayInfrastructure(
        data,
        MAP_THEMES.tactical,
        1.0,
        { renderSource: 'graph-R+' }
      );

      assert.equal(graphResult.stats.railwayRenderSource, 'graph-R+');
      assert.ok(graphResult.renderedSourceIds.has('way/bridge1'));
      assert.ok(graphResult.stats.totalTriangles > 0);

      let hasBridgeMesh = false;
      graphResult.railwaysGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          hasBridgeMesh = true;
        }
      });
      assert.ok(hasBridgeMesh, 'Bridge must generate 3D mesh geometry');

      graphResult.dispose();
    });

    it('creates verified tunnel portals and emits underground traces only in diagnostic mode', () => {
      const tunnelTrack = createSyntheticRailwayTrack('way/tunnel1', [[0, 0], [80, 0]], {
        isTunnel: true, layer: -1,
      });
      const surfaceWest = createSyntheticRailwayTrack('way/surface-west', [[-40, 0], [0, 0]]);
      const surfaceEast = createSyntheticRailwayTrack('way/surface-east', [[80, 0], [120, 0]]);
      const data = createBaseProcessedMapData([surfaceWest, tunnelTrack, surfaceEast]);

      const graphResult = buildRailwayInfrastructure(
        data, MAP_THEMES.tactical, 1.0, { renderSource: 'graph-R+' }
      );

      assert.equal(graphResult.stats.railwayRenderSource, 'graph-R+');
      assert.ok(graphResult.renderedSourceIds.has('way/tunnel1'));
      let hasPortal = false;
      let hasTrace = false;
      graphResult.railwaysGroup.traverse((obj) => {
        if (obj.name.startsWith('Railway_Tunnel_Portals')) hasPortal = true;
        if (obj.name.startsWith('Railway_Tunnel_Traces')) hasTrace = true;
      });
      assert.ok(hasPortal, 'A connected surface-to-tunnel transition should create a portal');
      assert.equal(hasTrace, false, 'Normal surface rendering must not allocate diagnostic traces');
      graphResult.dispose();

      const debugResult = buildRailwayInfrastructure(
        data, MAP_THEMES.tactical, 1.0,
        { renderSource: 'graph-R+', showUndergroundTunnelTraces: true }
      );
      let debugHasTrace = false;
      debugResult.railwaysGroup.traverse((obj) => {
        if (obj.name.startsWith('Railway_Tunnel_Traces')) debugHasTrace = true;
      });
      assert.equal(debugHasTrace, true);
      debugResult.dispose();
    });
  });

  // ==========================================================================
  // 9. DETERMINISM, THEME UPDATES & RESOURCE DISPOSAL
  // ==========================================================================
  describe('9. Determinism, Theme Updates & Resource Disposal', () => {
    it('produces deterministic output regardless of feature input order', () => {
      const trackA = createSyntheticRailwayTrack('way/detA', [
        [0, 0],
        [50, 0],
      ]);
      const trackB = createSyntheticRailwayTrack('way/detB', [
        [0, 10],
        [50, 10],
      ]);

      const dataForward = createBaseProcessedMapData([trackA, trackB]);
      const dataReverse = createBaseProcessedMapData([trackB, trackA]);

      const resForward = buildRailwayInfrastructure(
        dataForward,
        MAP_THEMES.tactical,
        1.0,
        { renderSource: 'graph-R+' }
      );
      const resReverse = buildRailwayInfrastructure(
        dataReverse,
        MAP_THEMES.tactical,
        1.0,
        { renderSource: 'graph-R+' }
      );

      assert.equal(resForward.stats.totalVertices, resReverse.stats.totalVertices);
      assert.equal(resForward.stats.totalTriangles, resReverse.stats.totalTriangles);
      assert.equal(resForward.stats.sleeper3DBoxCount, resReverse.stats.sleeper3DBoxCount);

      resForward.dispose();
      resReverse.dispose();
    });

    it('updates visual theme in-place without geometry reallocation', () => {
      const track = createSyntheticRailwayTrack('way/theme1', [
        [0, 0],
        [40, 0],
      ]);
      const data = createBaseProcessedMapData([track]);

      const result = buildRailwayInfrastructure(
        data,
        MAP_THEMES.tactical,
        1.0,
        { renderSource: 'graph-R+' }
      );

      const initialTriangles = result.stats.totalTriangles;
      result.updateTheme(MAP_THEMES.daylight);
      assert.equal(result.stats.totalTriangles, initialTriangles);

      result.updateTheme(MAP_THEMES.blueprint);
      assert.equal(result.stats.totalTriangles, initialTriangles);

      result.dispose();
    });

    it('releases all GPU resources and clears scene hierarchy on dispose', () => {
      const track = createSyntheticRailwayTrack('way/disp1', [
        [0, 0],
        [30, 0],
      ]);
      const data = createBaseProcessedMapData([track]);
      const group = new THREE.Group();

      const result = buildRailwayInfrastructure(
        data,
        MAP_THEMES.tactical,
        1.0,
        { renderSource: 'graph-R+', targetGroup: group }
      );

      assert.ok(group.children.length > 0);
      result.dispose();
      assert.equal(group.children.length, 0);
    });
  });

  // ==========================================================================
  // 10. GEOMETRYBUILDER STAGE 5 INTEGRATION
  // ==========================================================================
  describe('10. GeometryBuilder Stage 5 Full-Scene Integration', () => {
    it('passes infrastructureRenderOptions.railways to Stage 5 with memoized descriptors', () => {
      const track = createSyntheticRailwayTrack('way/sc1', [
        [0, 0],
        [60, 0],
      ]);
      const data = createBaseProcessedMapData([track]);

      const builder = new GeometryBuilder();

      const scene = builder.buildScene(data, MAP_THEMES.tactical);
      assert.ok(scene);
      assert.equal(scene.infrastructureRenderOptions.railways, 'graph-R+');
      assert.ok(scene.infrastructureRenderPreview);

      const railwaysGroup = scene.railwaysGroup;
      assert.ok(railwaysGroup);
      assert.equal(railwaysGroup.userData.railwayRenderSource, 'graph-R+');
      assert.ok(railwaysGroup.userData.railwayStats);

      scene.dispose();
    });
  });

  // ==========================================================================
  // 11. STAGE E3-A2: GRAPH-INFORMED RAILWAY SWITCH RENDERING
  // ==========================================================================
  describe('11. Stage E3-A2: Graph-Informed Railway Switch Rendering', () => {
    it('identifies confirmed turnouts and aligns turnout bearers perpendicular to mainline', () => {
      const trunkWay = createSyntheticRailwayTrack('way/trunk', [
        [0, 0],
        [30, 0],
      ], { nodeIds: ['n_start', 'n_switch'], osmTags: { usage: 'main' }, railwayType: 'rail' });

      const mainBranchWay = createSyntheticRailwayTrack('way/main', [
        [30, 0],
        [70, 0],
      ], { nodeIds: ['n_switch', 'n_main_end'], osmTags: { usage: 'main' }, railwayType: 'rail' });

      const divergingWay = createSyntheticRailwayTrack('way/div', [
        [30, 0],
        [50, 1.2],
        [70, 4.0],
      ], { nodeIds: ['n_switch', 'n_div_end'], osmTags: { usage: 'branch' }, railwayType: 'rail' });

      const data = createBaseProcessedMapData([trunkWay, mainBranchWay, divergingWay]);

      const result = buildRailwayInfrastructure(
        data,
        MAP_THEMES.daylight,
        1.0,
        { renderSource: 'graph-R+', switchPolicy: 'graph' }
      );

      assert.equal(result.stats.railwayRenderSource, 'graph-R+');
      assert.equal(result.stats.railwaySwitchPolicy, 'graph');
      assert.ok((result.stats.confirmedSwitchCount ?? 0) >= 1, 'Must detect at least 1 confirmed switch');
      assert.ok(result.stats.turnoutBearerCount > 0, 'Must produce turnout bearers');

      assert.ok(
        (result.stats.graphTaperedBladeCount ?? 0) >= 1,
        'Must apply targeted switch blade tapering on diverging track'
      );

      result.dispose();
    });

    it('prevents independent parallel tracks (1.60m spacing) from falsely suppressing sleepers or creating turnouts', () => {
      const track1 = createSyntheticRailwayTrack('way/p_close1', [
        [0, 0],
        [80, 0],
      ], { nodeIds: ['n_p1_start', 'n_p1_end'], osmTags: { usage: 'main' }, railwayType: 'rail' });

      const track2 = createSyntheticRailwayTrack('way/p_close2', [
        [0, 1.60],
        [80, 1.60],
      ], { nodeIds: ['n_p2_start', 'n_p2_end'], osmTags: { usage: 'main' }, railwayType: 'rail' });

      const data = createBaseProcessedMapData([track1, track2]);

      const result = buildRailwayInfrastructure(
        data,
        MAP_THEMES.tactical,
        1.0,
        { renderSource: 'graph-R+', switchPolicy: 'graph' }
      );

      assert.equal(result.stats.confirmedSwitchCount ?? 0, 0);
      assert.equal(result.stats.turnoutBearerCount, 0, 'No turnout bearers on independent parallel tracks');
      assert.equal(result.stats.graphTaperedBladeCount ?? 0, 0, 'No tapering on independent parallel tracks');
      assert.ok(result.stats.sleeper3DBoxCount > 200, 'Both tracks must retain independent sleepers');

      result.dispose();
    });

    it('treats flat diamond crossings as non-interconnecting and creates no fictitious turnouts', () => {
      const trackH = createSyntheticRailwayTrack('way/cross_h', [
        [-40, 0],
        [40, 0],
      ], { nodeIds: ['n_h1', 'n_h2'], osmTags: { usage: 'main' }, railwayType: 'rail' });

      const trackD = createSyntheticRailwayTrack('way/cross_d', [
        [-30, -30],
        [30, 30],
      ], { nodeIds: ['n_d1', 'n_d2'], osmTags: { usage: 'main' }, railwayType: 'rail' });

      const data = createBaseProcessedMapData([trackH, trackD]);

      const result = buildRailwayInfrastructure(
        data,
        MAP_THEMES.blueprint,
        1.0,
        { renderSource: 'graph-R+', switchPolicy: 'graph' }
      );

      assert.equal(result.stats.confirmedSwitchCount ?? 0, 0, 'Diamond crossing is not a turnout switch');
      assert.equal(result.stats.turnoutBearerCount, 0, 'Diamond crossing must not generate turnout bearers');
      assert.equal(result.stats.graphTaperedBladeCount ?? 0, 0, 'No rails tapered at flat diamond crossing');

      result.dispose();
    });

    it('tapers only the diverging switch blade facing the stock rail, leaving the mainline rails untapered', () => {
      const trunk = createSyntheticRailwayTrack('way/tp_trunk', [
        [0, 0],
        [20, 0],
      ], { nodeIds: ['nt1', 'nt_sw'], osmTags: { usage: 'main' }, railwayType: 'rail' });

      const main = createSyntheticRailwayTrack('way/tp_main', [
        [20, 0],
        [60, 0],
      ], { nodeIds: ['nt_sw', 'nt2'], osmTags: { usage: 'main' }, railwayType: 'rail' });

      const div = createSyntheticRailwayTrack('way/tp_div', [
        [20, 0],
        [35, 0.8],
        [60, 3.5],
      ], { nodeIds: ['nt_sw', 'nt3'], osmTags: { usage: 'branch' }, railwayType: 'rail' });

      const data = createBaseProcessedMapData([trunk, main, div]);

      const result = buildRailwayInfrastructure(
        data,
        MAP_THEMES.daylight,
        1.0,
        { renderSource: 'graph-R+', switchPolicy: 'graph' }
      );

      assert.equal(result.stats.graphTaperedBladeCount, 1, 'Only the diverging switch blade must taper');

      result.dispose();
    });

    it('safely falls back to geometric calculations without crashing on unresolved switches', () => {
      const t1 = createSyntheticRailwayTrack('way/unres1', [
        [0, 0],
        [30, 0],
      ], { nodeIds: ['nu1', 'nu_common'], osmTags: { usage: 'branch' }, railwayType: 'rail' });

      const t2 = createSyntheticRailwayTrack('way/unres2', [
        [30, 0],
        [60, 10],
      ], { nodeIds: ['nu_common', 'nu2'], osmTags: { usage: 'branch' }, railwayType: 'rail' });

      const t3 = createSyntheticRailwayTrack('way/unres3', [
        [30, 0],
        [60, -10],
      ], { nodeIds: ['nu_common', 'nu3'], osmTags: { usage: 'branch' }, railwayType: 'rail' });

      const data = createBaseProcessedMapData([t1, t2, t3]);

      const result = buildRailwayInfrastructure(
        data,
        MAP_THEMES.tactical,
        1.0,
        { renderSource: 'graph-R+', switchPolicy: 'graph' }
      );

      assert.ok(result.stats.totalTriangles > 0);
      assert.ok(result.stats.sleeper3DBoxCount > 0);

      result.dispose();
    });
  });

  describe('Stage E3-B: Production Surface-First Railway Ballast (R+)', () => {
    it('normalizes render source to graph-R+ and ballast strategy to surface-first', () => {
      assert.equal(parseRailwayInfrastructureRenderSource(null), 'graph-R+');
      assert.equal(parseRailwayInfrastructureRenderSource('graph-r+'), 'graph-R+');
      assert.equal(parseRailwayInfrastructureRenderSource('graph-R+'), 'graph-R+');

      assert.equal(parseRailwayBallastStrategy(null), 'surface-first');
      assert.equal(parseRailwayBallastStrategy('surface-first'), 'surface-first');
      assert.equal(parseRailwayBallastStrategy('r+'), 'surface-first');
      assert.equal(parseRailwayBallastStrategy(null, 'graph-R+'), 'surface-first');

      const options = parseInfrastructureRenderOptionsFromSearch('?topologyRailways=graph-R+');
      assert.equal(options.railways, 'graph-R+');
      assert.equal(options.railwayBallastStrategy, 'surface-first');
      assert.equal(options.railwaySwitchPolicy, 'graph');

      const defaultOptions = normalizeInfrastructureRenderOptions(null);
      assert.equal(defaultOptions.railways, 'graph-R+');
      assert.equal(defaultOptions.railwayBallastStrategy, 'surface-first');
    });

    it('consolidates overlapping at-grade tracks at switches and crossovers into unified components', () => {
      const trunk = createSyntheticRailwayTrack('way/r_trunk', [
        [0, 0],
        [20, 0],
      ], { nodeIds: ['n1', 'n_sw'], osmTags: { usage: 'main' }, railwayType: 'rail' });

      const main = createSyntheticRailwayTrack('way/r_main', [
        [20, 0],
        [60, 0],
      ], { nodeIds: ['n_sw', 'n2'], osmTags: { usage: 'main' }, railwayType: 'rail' });

      const div = createSyntheticRailwayTrack('way/r_div', [
        [20, 0],
        [40, 2],
        [60, 4.5],
      ], { nodeIds: ['n_sw', 'n3'], osmTags: { usage: 'branch' }, railwayType: 'rail' });

      const data = createBaseProcessedMapData([trunk, main, div]);

      const footprints = buildAtGradeBallastFootprints(data.railways);
      assert.equal(footprints.length, 3, 'All 3 tracks are at-grade');

      const components = groupBallastConnectedComponents(footprints);
      assert.equal(components.length, 1, 'All 3 tracks overlap at switch throat and must form 1 component');
      assert.equal(components[0].footprintIds.length, 3);
      assert.equal(components[0].sourceFeatureIds.length, 3);

      const individualArea = footprints.reduce((acc, f) => acc + computeMultiPolygonArea(f.geometry), 0);
      const unifiedArea = computeMultiPolygonArea(components[0].unionGeometry);
      assert.ok(unifiedArea < individualArea, 'Consolidated area must be less than sum due to eliminated overlap');
      assert.ok(individualArea - unifiedArea > 10.0, 'Substantial overlap removed at diverging throat');

      const result = buildRailwayInfrastructure(
        data,
        MAP_THEMES.tactical,
        1.0,
        { renderSource: 'graph-R+', ballastStrategy: 'surface-first' }
      );

      assert.equal(result.stats.railwayBallastStrategy, 'surface-first');
      assert.equal(result.stats.ballastFootprintCount, 3);
      assert.equal(result.stats.ballastComponentCount, 1);
      assert.equal(result.stats.ballastBooleanUnionCount, 1);
      assert.ok((result.stats.ballastTriangles ?? 0) > 0);

      result.dispose();
    });

    it('strictly isolates bridges and tunnels from at-grade ballast consolidation', () => {
      const atGradeTrack = createSyntheticRailwayTrack('way/track_ground', [
        [0, 0],
        [50, 0],
      ], { layer: 0, isBridge: false, isTunnel: false });

      const bridgeTrack = createSyntheticRailwayTrack('way/track_bridge', [
        [0, 1.0],
        [50, 1.0],
      ], { layer: 1, isBridge: true, isTunnel: false });

      const tunnelTrack = createSyntheticRailwayTrack('way/track_tunnel', [
        [0, -1.0],
        [50, -1.0],
      ], { layer: -1, isBridge: false, isTunnel: true });

      const data = createBaseProcessedMapData([atGradeTrack, bridgeTrack, tunnelTrack]);

      const footprints = buildAtGradeBallastFootprints(data.railways);
      assert.equal(footprints.length, 1, 'Only at-grade ground track gets surface-first footprint');
      assert.equal(footprints[0].id, 'way/track_ground');

      const result = buildRailwayInfrastructure(
        data,
        MAP_THEMES.daylight,
        1.0,
        { renderSource: 'graph-R+', ballastStrategy: 'surface-first' }
      );

      assert.equal(result.stats.ballastFootprintCount, 1);
      assert.equal(result.stats.ballastComponentCount, 1);
      assert.equal(result.stats.ballastBooleanUnionCount, 0);

      result.dispose();
    });

    it('reduces ballast triangles on switchyard while preserving 3D sleepers, turnout bearers, and blade tapering', () => {
      const switchyardData = createRailwayPrototypeFixtureData();

      const surfaceFirstResult = buildRailwayInfrastructure(
        switchyardData,
        MAP_THEMES.tactical,
        1.0,
        { renderSource: 'graph-R+', switchPolicy: 'graph', ballastStrategy: 'surface-first' }
      );

      assert.ok(surfaceFirstResult.stats.sleeper3DBoxCount > 500);
      assert.ok(surfaceFirstResult.stats.turnoutBearerCount > 0);
      assert.ok((surfaceFirstResult.stats.confirmedSwitchCount ?? 0) > 0);
      assert.ok((surfaceFirstResult.stats.graphTaperedBladeCount ?? 0) > 0);
      assert.ok(
        (surfaceFirstResult.stats.ballastTriangles ?? 0) < 1154,
        'R+ ballast triangles should be reduced compared to legacy ribbon ballast (1,154 in switchyard)'
      );

      surfaceFirstResult.dispose();
    });

    it('ensures all generated R+ ballast meshes have valid upward normals, non-NaN positions, and valid triangles', () => {
      const switchyardData = createRailwayPrototypeFixtureData();

      const resManager = new SceneResourceManager();
      const getChunkKey = () => 'global';
      const atGradeElev = 0.060;

      const rPlusResult = buildSurfaceFirstRailwayBallastGeometries(
        switchyardData.railways,
        atGradeElev,
        resManager,
        getChunkKey
      );

      assert.ok(rPlusResult.ballastItems.length > 0);
      assert.ok(rPlusResult.stats.ballastTriangles > 0);

      for (const item of rPlusResult.ballastItems) {
        const geo = item.geom;
        const pos = geo.attributes.position;
        const norm = geo.attributes.normal;

        assert.ok(pos && pos.count >= 3);
        assert.ok(norm && norm.count === pos.count);

        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          const y = pos.getY(i);
          const z = pos.getZ(i);

          assert.ok(Number.isFinite(x), 'x must be finite');
          assert.ok(Number.isFinite(y), 'y must be finite');
          assert.ok(Number.isFinite(z), 'z must be finite');
          assert.ok(Math.abs(y - atGradeElev) < 1e-4, 'y must match at-grade ballast elevation');

          const nx = norm.getX(i);
          const ny = norm.getY(i);
          const nz = norm.getZ(i);
          assert.ok(Math.abs(nx) < 1e-4 && Math.abs(ny - 1.0) < 1e-4 && Math.abs(nz) < 1e-4, 'Normal must point up [0,1,0]');
        }

        assert.ok(item.info.sourceFeatureIds.length > 0, 'Every ballast item must have sourceFeatureIds');
      }

      resManager.dispose();
    });

    it('supports theme updates and resource disposal cleanly without memory leaks', () => {
      const switchyardData = createRailwayPrototypeFixtureData();

      const result = buildRailwayInfrastructure(
        switchyardData,
        MAP_THEMES.daylight,
        1.0,
        { renderSource: 'graph-R+', ballastStrategy: 'surface-first' }
      );

      assert.doesNotThrow(() => {
        result.updateTheme(MAP_THEMES.tactical);
      });
      assert.doesNotThrow(() => {
        result.updateTheme(MAP_THEMES.blueprint);
      });
      assert.doesNotThrow(() => {
        result.dispose();
      });
    });

    it('produces deterministic output under feature reordering', () => {
      const t1 = createSyntheticRailwayTrack('way/t1', [[0, 0], [40, 0]], { layer: 0 });
      const t2 = createSyntheticRailwayTrack('way/t2', [[20, 0], [40, 2]], { layer: 0 });
      const t3 = createSyntheticRailwayTrack('way/t3', [[40, 0], [80, 0]], { layer: 0 });

      const dataA = createBaseProcessedMapData([t1, t2, t3]);
      const dataB = createBaseProcessedMapData([t3, t2, t1]);

      const resManagerA = new SceneResourceManager();
      const resManagerB = new SceneResourceManager();

      const resultA = buildSurfaceFirstRailwayBallastGeometries(dataA.railways, 0.060, resManagerA, () => 'global');
      const resultB = buildSurfaceFirstRailwayBallastGeometries(dataB.railways, 0.060, resManagerB, () => 'global');

      assert.equal(resultA.stats.componentCount, resultB.stats.componentCount);
      assert.equal(resultA.stats.booleanUnionCount, resultB.stats.booleanUnionCount);
      assert.equal(resultA.stats.ballastTriangles, resultB.stats.ballastTriangles);

      resManagerA.dispose();
      resManagerB.dispose();
    });
  });
});

