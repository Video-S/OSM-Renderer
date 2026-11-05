import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_THEMES } from '../styles/mapThemes';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { GeometryBuilder } from './GeometryBuilder';
import realOsmExtracts from './prototype/realOsmRailwayExtracts.json';
import {
  analyzeCrossModal,
  buildInfrastructureGraph,
  buildRailwayNetwork,
  buildRoadNetwork,
  InfrastructureGraph,
  TopologySourceData,
  UnchainedRailwayPart,
  UnchainedRoadPart,
} from './infrastructure/topology/InfrastructureGraph';

function makeRoadPart(
  overrides: Partial<UnchainedRoadPart> & {
    id: string;
    points: readonly [number, number][];
  }
): UnchainedRoadPart {
  const n = overrides.points.length;
  const sourceFeatureId = overrides.sourceFeatureId ?? overrides.id.replace(/-\d+$/, '');
  return {
    id: overrides.id,
    sourceFeatureId,
    hasExplicitSourceId: overrides.hasExplicitSourceId ?? !/^feat-\d+$/.test(sourceFeatureId),
    partIndex: overrides.partIndex ?? 0,
    points: overrides.points,
    rawOsmNodeIds: overrides.rawOsmNodeIds ?? new Array(n).fill(undefined),
    clippedAtStart: overrides.clippedAtStart ?? false,
    clippedAtEnd: overrides.clippedAtEnd ?? false,
    roadClass: overrides.roadClass ?? 'secondary',
    width: overrides.width ?? 7.0,
    layer: overrides.layer ?? 0,
    isBridge: overrides.isBridge ?? false,
    isTunnel: overrides.isTunnel ?? false,
    isCulvert: overrides.isCulvert ?? false,
    name: overrides.name,
    osmTags: overrides.osmTags ?? { highway: overrides.roadClass ?? 'secondary' },
  };
}

function makeRailwayPart(
  overrides: Partial<UnchainedRailwayPart> & {
    id: string;
    points: readonly [number, number][];
  }
): UnchainedRailwayPart {
  const n = overrides.points.length;
  const sourceFeatureId = overrides.sourceFeatureId ?? overrides.id.replace(/-\d+$/, '');
  return {
    id: overrides.id,
    sourceFeatureId,
    hasExplicitSourceId: overrides.hasExplicitSourceId ?? !/^feat-\d+$/.test(sourceFeatureId),
    partIndex: overrides.partIndex ?? 0,
    points: overrides.points,
    rawOsmNodeIds: overrides.rawOsmNodeIds ?? new Array(n).fill(undefined),
    clippedAtStart: overrides.clippedAtStart ?? false,
    clippedAtEnd: overrides.clippedAtEnd ?? false,
    railwayType: overrides.railwayType ?? 'rail',
    width: overrides.width ?? 4.8,
    layer: overrides.layer ?? 0,
    isBridge: overrides.isBridge ?? false,
    isTunnel: overrides.isTunnel ?? false,
    name: overrides.name,
    gauge: overrides.gauge ?? '1435',
    electrified: overrides.electrified ?? 'contact_line',
    service: overrides.service,
    usage: overrides.usage ?? 'main',
    isSecondaryBranch: overrides.isSecondaryBranch ?? false,
    osmTags: overrides.osmTags ?? { railway: overrides.railwayType ?? 'rail' },
  };
}

function serializeInfrastructureGraph(graph: InfrastructureGraph): string {
  return JSON.stringify({
    roadNodes: [...graph.roads.nodes.entries()],
    roadEdges: [...graph.roads.edges.entries()],
    roadFeatureToEdgeIds: [...graph.roads.featureToEdgeIds.entries()],
    railwayNodes: [...graph.railways.nodes.entries()],
    railwayEdges: [...graph.railways.edges.entries()],
    railwayFeatureToEdgeIds: [...graph.railways.featureToEdgeIds.entries()],
    gradeTransitions: graph.gradeTransitions,
    railwayFlatCrossings: graph.railwayFlatCrossings,
    levelCrossings: graph.levelCrossings,
    gradeSeparatedCrossings: graph.gradeSeparatedCrossings,
    diagnostics: graph.diagnostics,
  });
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithSeed<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  const rand = mulberry32(seed);
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

describe('M2.3-D Cross-Modal Connectivity, Level Crossings & Grade Transitions (ADR-0009)', () => {
  it('1. Point-Level Infrastructure Ingestion: captures all 5 InfrastructurePointKind categories with verified rawOsmNodeId, tags, and bbox filtering', () => {
    const provider = new LocalGeoJsonProvider();
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'way/100',
          properties: { highway: 'secondary', _nodeIds: ['10', '20', '30'] },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.899, 52.378],
              [4.900, 52.378],
              [4.901, 52.378],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'node/501',
          properties: { railway: 'switch', 'railway:switch': 'left' },
          geometry: { type: 'Point', coordinates: [4.900, 52.378] },
        },
        {
          type: 'Feature',
          id: 'node/502',
          properties: { railway: 'railway_crossing' },
          geometry: { type: 'Point', coordinates: [4.9001, 52.378] },
        },
        {
          type: 'Feature',
          id: 'node/503',
          properties: { railway: 'level_crossing', crossing: 'barrier', 'crossing:barrier': 'full' },
          geometry: { type: 'Point', coordinates: [4.9002, 52.378] },
        },
        {
          type: 'Feature',
          id: 'node/504',
          properties: { railway: 'crossing', crossing: 'uncontrolled' },
          geometry: { type: 'Point', coordinates: [4.9003, 52.378] },
        },
        {
          type: 'Feature',
          id: 'node/505',
          properties: {
            highway: 'crossing',
            crossing: 'marked',
            'crossing:markings': 'zebra',
          },
          geometry: { type: 'Point', coordinates: [4.900, 52.378] },
        },
        // Synthetic fallback ID feature without explicit OSM ID must not fabricate rawOsmNodeId
        {
          type: 'Feature',
          properties: { highway: 'crossing', crossing: 'unmarked' },
          geometry: { type: 'Point', coordinates: [4.9004, 52.378] },
        },
        // Out-of-bounds point outside clip radius
        {
          type: 'Feature',
          id: 'node/999',
          properties: { railway: 'level_crossing' },
          geometry: { type: 'Point', coordinates: [4.950, 52.420] },
        },
      ],
    };

    const mapData = provider.parseGeoJson(fc, 'Test Point Ingestion', [4.900, 52.378], 250);
    const pts = mapData.topologySource?.infrastructurePoints ?? [];
    assert.equal(pts.length, 6, 'Out-of-bounds point node/999 must be filtered by clip radius');

    const byId = new Map(pts.map((p) => [p.id, p]));
    assert.equal(byId.get('node/501')?.kind, 'railway_switch');
    assert.equal(byId.get('node/501')?.rawOsmNodeId, '501');
    assert.equal(byId.get('node/501')?.hasExplicitSourceId, true);

    assert.equal(byId.get('node/502')?.kind, 'railway_crossing_flat');
    assert.equal(byId.get('node/502')?.rawOsmNodeId, '502');

    assert.equal(byId.get('node/503')?.kind, 'railway_level_crossing');
    assert.equal(byId.get('node/503')?.rawOsmNodeId, '503');
    assert.equal(byId.get('node/503')?.osmTags.crossing, 'barrier');

    assert.equal(byId.get('node/504')?.kind, 'railway_ped_crossing');
    assert.equal(byId.get('node/504')?.rawOsmNodeId, '504');

    assert.equal(byId.get('node/505')?.kind, 'highway_crossing');
    assert.equal(byId.get('node/505')?.rawOsmNodeId, '505');
    assert.equal(byId.get('node/505')?.osmTags['crossing:markings'], 'zebra');

    const fallbackPt = pts.find((p) => !p.hasExplicitSourceId);
    assert.ok(fallbackPt);
    assert.equal(fallbackPt.rawOsmNodeId, undefined, 'Synthetic feat-* ID must never masquerade as rawOsmNodeId');
  });

  it('2. T-13 Level Crossing Detection & Rejection: covers (a) shared explicit OSM node, (b) point-tagged within 0.15 m, (c) coincident untagged vertex rejected, (d) geometric crossing rejected, and (e) pedestrian railway=crossing', () => {
    // (a) Road way and railway way sharing explicit node '5001' tagged railway=level_crossing
    const sourceA: TopologySourceData = {
      roadParts: [
        makeRoadPart({
          id: 'way/100-0',
          points: [
            [-30, 0],
            [0, 0],
            [30, 0],
          ],
          rawOsmNodeIds: ['1001', '5001', '1002'],
          roadClass: 'secondary',
        }),
      ],
      railwayParts: [
        makeRailwayPart({
          id: 'way/200-0',
          points: [
            [0, -40],
            [0, 0],
            [0, 40],
          ],
          rawOsmNodeIds: ['2001', '5001', '2002'],
          railwayType: 'rail',
        }),
      ],
      infrastructurePoints: [
        {
          id: 'node/5001',
          hasExplicitSourceId: true,
          rawOsmNodeId: '5001',
          point: [0, 0],
          kind: 'railway_level_crossing',
          osmTags: { railway: 'level_crossing', crossing: 'barrier' },
        },
      ],
    };

    const graphA = buildInfrastructureGraph(sourceA);
    assert.equal(graphA.levelCrossings.length, 1);
    assert.equal(graphA.diagnostics.levelCrossingCount, 1);
    assert.equal(graphA.diagnostics.pedestrianRailCrossingCount, 0);
    assert.equal(graphA.diagnostics.unresolvedCrossingCount, 0);

    const lcA = graphA.levelCrossings[0];
    assert.equal(lcA.crossingKind, 'road_rail_level_crossing');
    assert.equal(lcA.confidence, 'explicit_osm_crossing_tag');
    assert.equal(lcA.rawOsmNodeId, '5001');
    assert.ok(lcA.roadNodeId, 'Expected retained roadNodeId at crossing');
    assert.ok(lcA.railwayNodeId, 'Expected retained railwayNodeId at crossing');
    assert.ok(Math.abs(lcA.roadArcLengthMeters - 30) < 1e-6);
    assert.ok(Math.abs(lcA.railwayArcLengthMeters - 40) < 1e-6);
    assert.ok(Math.abs(lcA.crossingAngleRad - Math.PI / 2) < 1e-6);
    assert.equal(lcA.pointOsmTags?.crossing, 'barrier');

    const roadCrossNode = graphA.roads.nodes.get(lcA.roadNodeId!);
    const railCrossNode = graphA.railways.nodes.get(lcA.railwayNodeId!);
    assert.ok(roadCrossNode?.roles.includes('level_crossing'));
    assert.ok(!roadCrossNode?.roles.includes('attribute_break'), 'Protected crossing node on uniform road must not get false attribute_break role');
    assert.ok(railCrossNode?.roles.includes('level_crossing'));
    assert.ok(!railCrossNode?.roles.includes('attribute_break'), 'Protected crossing node on uniform track must not get false attribute_break role');

    // (a2) Shared explicit OSM node without separate Point feature -> confidence: 'shared_explicit_osm_node'
    const graphA2 = buildInfrastructureGraph({
      roadParts: sourceA.roadParts,
      railwayParts: sourceA.railwayParts,
      infrastructurePoints: [],
    });
    assert.equal(graphA2.levelCrossings.length, 1);
    assert.equal(graphA2.levelCrossings[0].confidence, 'shared_explicit_osm_node');
    assert.equal(graphA2.levelCrossings[0].crossingKind, 'road_rail_level_crossing');

    // (b) Road way and railway way lacking explicit node IDs, with a Point feature railway=level_crossing within 0.15 m of their interior intersection
    const sourceB: TopologySourceData = {
      roadParts: [
        makeRoadPart({
          id: 'way/101-0',
          points: [
            [-25, 0],
            [25, 0],
          ],
          roadClass: 'residential',
        }),
      ],
      railwayParts: [
        makeRailwayPart({
          id: 'way/201-0',
          points: [
            [0, -35],
            [0, 35],
          ],
          railwayType: 'rail',
        }),
      ],
      infrastructurePoints: [
        {
          id: 'node/6001',
          hasExplicitSourceId: true,
          rawOsmNodeId: '6001',
          point: [0.04, -0.03],
          kind: 'railway_level_crossing',
          osmTags: { railway: 'level_crossing' },
        },
      ],
    };

    const graphB = buildInfrastructureGraph(sourceB);
    assert.equal(graphB.levelCrossings.length, 1);
    assert.equal(graphB.levelCrossings[0].confidence, 'explicit_osm_crossing_tag');
    assert.equal(graphB.levelCrossings[0].crossingKind, 'road_rail_level_crossing');
    assert.equal(
      graphB.levelCrossings[0].roadNodeId,
      undefined,
      'Must not invent a roadNodeId when crossing occurs inside an unsplit edge'
    );
    assert.equal(
      graphB.levelCrossings[0].railwayNodeId,
      undefined,
      'Must not invent a railwayNodeId when crossing occurs inside an unsplit edge'
    );
    assert.ok(Math.abs(graphB.levelCrossings[0].roadArcLengthMeters - 25.04) < 1e-4);
    assert.ok(Math.abs(graphB.levelCrossings[0].railwayArcLengthMeters - 34.97) < 1e-4);

    // (c) Road way and railway way sharing a coincident coordinate-only vertex (<= 0.15 m) with NO explicit OSM node ID and NO railway=level_crossing tag
    const sourceC: TopologySourceData = {
      roadParts: [
        makeRoadPart({
          id: 'way/102-0',
          points: [
            [-20, 0],
            [0, 0],
            [20, 0],
          ],
          roadClass: 'secondary',
        }),
      ],
      railwayParts: [
        makeRailwayPart({
          id: 'way/202-0',
          points: [
            [0, -20],
            [0.05, 0],
            [0, 20],
          ],
          railwayType: 'rail',
        }),
      ],
      infrastructurePoints: [],
    };

    const graphC = buildInfrastructureGraph(sourceC);
    assert.equal(graphC.levelCrossings.length, 0);
    assert.equal(graphC.diagnostics.unresolvedCrossings.length, 1);
    assert.equal(
      graphC.diagnostics.unresolvedCrossings[0].reason,
      'coincident_vertex_without_osm_id'
    );

    // (d) Road way and railway way crossing geometrically in 2D without a shared node or crossing tag
    const sourceD: TopologySourceData = {
      roadParts: [
        makeRoadPart({
          id: 'way/103-0',
          points: [
            [-20, 0],
            [20, 0],
          ],
          roadClass: 'secondary',
        }),
      ],
      railwayParts: [
        makeRailwayPart({
          id: 'way/203-0',
          points: [
            [0, -20],
            [0, 20],
          ],
          railwayType: 'rail',
        }),
      ],
      infrastructurePoints: [],
    };

    const graphD = buildInfrastructureGraph(sourceD);
    assert.equal(graphD.levelCrossings.length, 0);
    assert.equal(graphD.diagnostics.unresolvedCrossings.length, 1);
    assert.equal(
      graphD.diagnostics.unresolvedCrossings[0].reason,
      'geometric_intersection_without_shared_node'
    );

    // (e) Footway way and railway way sharing a node tagged railway=crossing
    const sourceE: TopologySourceData = {
      roadParts: [
        makeRoadPart({
          id: 'way/104-0',
          points: [
            [-15, 0],
            [0, 0],
            [15, 0],
          ],
          rawOsmNodeIds: ['7001', '7002', '7003'],
          roadClass: 'footway',
          width: 2.0,
        }),
      ],
      railwayParts: [
        makeRailwayPart({
          id: 'way/204-0',
          points: [
            [0, -25],
            [0, 0],
            [0, 25],
          ],
          rawOsmNodeIds: ['8001', '7002', '8003'],
          railwayType: 'rail',
        }),
      ],
      infrastructurePoints: [
        {
          id: 'node/7002',
          hasExplicitSourceId: true,
          rawOsmNodeId: '7002',
          point: [0, 0],
          kind: 'railway_ped_crossing',
          osmTags: { railway: 'crossing', crossing: 'chicane' },
        },
      ],
    };

    const graphE = buildInfrastructureGraph(sourceE);
    assert.equal(graphE.levelCrossings.length, 1);
    assert.equal(graphE.levelCrossings[0].crossingKind, 'pedestrian_rail_crossing');
    assert.equal(graphE.levelCrossings[0].confidence, 'explicit_osm_crossing_tag');
    assert.equal(graphE.diagnostics.levelCrossingCount, 1);
    assert.equal(graphE.diagnostics.pedestrianRailCrossingCount, 1);
  });

  it('3. Crossing Tag vs Road Tier Conflict & highway=crossing Isolation: rejects conflicting crossing tags and keeps highway=crossing as road crosswalk metadata', () => {
    // Conflict 1: railway=level_crossing on a path-tier footway must NOT confirm a LevelCrossingRelation
    const conflictSource: TopologySourceData = {
      roadParts: [
        makeRoadPart({
          id: 'way/301-0',
          points: [
            [-15, 0],
            [0, 0],
            [15, 0],
          ],
          rawOsmNodeIds: ['11', '12', '13'],
          roadClass: 'footway',
        }),
      ],
      railwayParts: [
        makeRailwayPart({
          id: 'way/302-0',
          points: [
            [0, -15],
            [0, 0],
            [0, 15],
          ],
          rawOsmNodeIds: ['21', '12', '23'],
          railwayType: 'rail',
        }),
      ],
      infrastructurePoints: [
        {
          id: 'node/12',
          hasExplicitSourceId: true,
          rawOsmNodeId: '12',
          point: [0, 0],
          kind: 'railway_level_crossing',
          osmTags: { railway: 'level_crossing' },
        },
      ],
    };

    const conflictGraph = buildInfrastructureGraph(conflictSource);
    assert.equal(conflictGraph.levelCrossings.length, 0);
    assert.equal(conflictGraph.diagnostics.unresolvedCrossings.length, 1);
    assert.equal(
      conflictGraph.diagnostics.unresolvedCrossings[0].reason,
      'conflicting_crossing_tag_and_road_tier'
    );
    assert.equal(
      conflictGraph.diagnostics.unresolvedInfrastructurePoints?.[0]?.reason,
      'conflicting_crossing_tag_and_road_tier'
    );

    // highway=crossing on a road way must preserve RoadNodeRole 'highway_crossing' and never emit a rail LevelCrossingRelation
    const crosswalkSource: TopologySourceData = {
      roadParts: [
        makeRoadPart({
          id: 'way/310-0',
          points: [
            [-25, 0],
            [0, 0],
            [25, 0],
          ],
          rawOsmNodeIds: ['901', '902', '903'],
          roadClass: 'primary',
        }),
      ],
      railwayParts: [],
      infrastructurePoints: [
        {
          id: 'node/902',
          hasExplicitSourceId: true,
          rawOsmNodeId: '902',
          point: [0, 0],
          kind: 'highway_crossing',
          osmTags: {
            highway: 'crossing',
            crossing: 'traffic_signals',
            'crossing:markings': 'zebra',
          },
        },
      ],
    };

    const crosswalkGraph = buildInfrastructureGraph(crosswalkSource);
    assert.equal(crosswalkGraph.levelCrossings.length, 0);
    const crosswalkNode = [...crosswalkGraph.roads.nodes.values()].find(
      (n) => n.rawOsmNodeId === '902'
    );
    assert.ok(crosswalkNode, 'Expected highway=crossing node to be preserved against degree-2 contraction');
    assert.ok(crosswalkNode.roles.includes('highway_crossing'));
    assert.equal(crosswalkNode.primaryRole, 'highway_crossing');
    assert.equal(crosswalkNode.pointOsmTags?.['crossing:markings'], 'zebra');
  });

  it('4. T-03, T-04 & T-15 Grade Transitions & Same-Grade Separation: covers Tier 1 explicit portal, Tier 2 coordinate fallback, Y-junction disambiguation, perpendicular cross-street rejection, and T-04 unshared 2D road crossing', () => {
    // T-03: Road way A (layer=0, isBridge=false) and Road way B (layer=1, isBridge=true) sharing OSM node '7001' at [10, 0]
    const t03Source: TopologySourceData = {
      roadParts: [
        makeRoadPart({
          id: 'way/400-0',
          points: [
            [-20, 0],
            [10, 0],
          ],
          rawOsmNodeIds: ['7000', '7001'],
          roadClass: 'primary',
          layer: 0,
          isBridge: false,
        }),
        makeRoadPart({
          id: 'way/401-0',
          points: [
            [10, 0],
            [50, 0],
          ],
          rawOsmNodeIds: ['7001', '7002'],
          roadClass: 'primary',
          layer: 1,
          isBridge: true,
        }),
      ],
      railwayParts: [],
      infrastructurePoints: [],
    };

    const t03Graph = buildInfrastructureGraph(t03Source);
    assert.equal(t03Graph.gradeTransitions.length, 1);
    const gt = t03Graph.gradeTransitions[0];
    assert.equal(gt.network, 'road');
    assert.equal(gt.transitionType, 'bridge_approach');
    assert.equal(gt.confidence, 'explicit_osm_node');
    assert.equal(gt.rawOsmNodeId, '7001');
    assert.notEqual(
      gt.atGradeNodeId,
      gt.gradeSeparatedNodeId,
      'At-grade node and bridge node must remain distinct RoadNode records'
    );
    assert.ok(Math.abs(gt.continuousTraversalDot - 1.0) < 1e-6);

    const atGradePortalNode = t03Graph.roads.nodes.get(gt.atGradeNodeId);
    const bridgePortalNode = t03Graph.roads.nodes.get(gt.gradeSeparatedNodeId);
    assert.ok(atGradePortalNode?.roles.includes('grade_transition'));
    assert.ok(bridgePortalNode?.roles.includes('grade_transition'));

    // Tier 2 coordinate fallback: terminal unclipped endpoints within 0.15 m, collinear within 15 deg (dot >= cos(30 deg))
    const tier2Source: TopologySourceData = {
      roadParts: [],
      railwayParts: [
        makeRailwayPart({
          id: 'way/410-0',
          points: [
            [-30, 0],
            [0, 0],
          ],
          railwayType: 'rail',
          layer: 0,
          isTunnel: false,
        }),
        makeRailwayPart({
          id: 'way/411-0',
          points: [
            [0.08, 0.02],
            [30, 2],
          ],
          railwayType: 'rail',
          layer: -1,
          isTunnel: true,
        }),
      ],
      infrastructurePoints: [],
    };

    const tier2Graph = buildInfrastructureGraph(tier2Source);
    assert.equal(tier2Graph.gradeTransitions.length, 1);
    assert.equal(tier2Graph.gradeTransitions[0].network, 'railway');
    assert.equal(tier2Graph.gradeTransitions[0].transitionType, 'tunnel_portal');
    assert.equal(tier2Graph.gradeTransitions[0].confidence, 'coordinate_fallback_confirmed');
    assert.ok(tier2Graph.gradeTransitions[0].continuousTraversalDot >= Math.cos((30 * Math.PI) / 180));

    // Tier 1 Y-junction disambiguation: bridge landing at an explicit OSM node shared by a straight continuation (0 deg, dot=1.0) and a side branch (45 deg, dot=0.707) -> lead 0.293 >= 0.10 -> confirms straight continuation
    const yJunctionSource: TopologySourceData = {
      roadParts: [
        makeRoadPart({
          id: 'way/420-0',
          points: [
            [-20, 0],
            [0, 0],
          ],
          rawOsmNodeIds: ['8000', '8001'],
          roadClass: 'secondary',
          layer: 1,
          isBridge: true,
        }),
        makeRoadPart({
          id: 'way/421-0',
          points: [
            [0, 0],
            [25, 0],
          ],
          rawOsmNodeIds: ['8001', '8002'],
          roadClass: 'secondary',
          layer: 0,
        }),
        makeRoadPart({
          id: 'way/422-0',
          points: [
            [0, 0],
            [20, 20],
          ],
          rawOsmNodeIds: ['8001', '8003'],
          roadClass: 'secondary',
          layer: 0,
        }),
      ],
      railwayParts: [],
      infrastructurePoints: [],
    };

    const yJunctionGraph = buildInfrastructureGraph(yJunctionSource);
    assert.equal(yJunctionGraph.gradeTransitions.length, 1);
    assert.ok(yJunctionGraph.gradeTransitions[0].atGradeEdgeId.includes('way/421-0'));

    // Perpendicular cross-street passing 0.50 m from a bridge portal -> 0 GradeTransitionRelation, 1 UnresolvedGradeTransitionCandidate
    const perpPortalSource: TopologySourceData = {
      roadParts: [
        makeRoadPart({
          id: 'way/430-0',
          points: [
            [-30, 0],
            [0, 0],
          ],
          roadClass: 'secondary',
          layer: 1,
          isBridge: true,
        }),
        makeRoadPart({
          id: 'way/431-0',
          points: [
            [0.5, -20],
            [0.5, 20],
          ],
          roadClass: 'secondary',
          layer: 0,
          isBridge: false,
        }),
      ],
      railwayParts: [],
      infrastructurePoints: [],
    };

    const perpPortalGraph = buildInfrastructureGraph(perpPortalSource);
    assert.equal(perpPortalGraph.gradeTransitions.length, 0);
    assert.equal(perpPortalGraph.diagnostics.unresolvedGradeTransitions.length, 1);
    assert.equal(
      perpPortalGraph.diagnostics.unresolvedGradeTransitions[0].reason,
      'misaligned_tangent'
    );
    assert.ok(
      Math.abs(perpPortalGraph.diagnostics.unresolvedGradeTransitions[0].distanceMeters - 0.5) <
        1e-6
    );

    // Diagnostic reasons: distinct_explicit_osm_nodes, incompatible_class_or_tier, non_terminal_endpoint, exceeds_snap_tolerance, ambiguous_multiple_candidates
    const diagPortalSource: TopologySourceData = {
      roadParts: [
        // 1. Distinct explicit OSM node IDs within 0.15 m
        makeRoadPart({
          id: 'way/440-0',
          points: [
            [-20, 100],
            [0, 100],
          ],
          rawOsmNodeIds: ['9000', '9001'],
          roadClass: 'secondary',
          layer: 1,
          isBridge: true,
        }),
        makeRoadPart({
          id: 'way/441-0',
          points: [
            [0.05, 100],
            [20, 100],
          ],
          rawOsmNodeIds: ['9002', '9003'],
          roadClass: 'secondary',
          layer: 0,
        }),
        // 2. Incompatible tier (vehicular bridge vs footway path)
        makeRoadPart({
          id: 'way/442-0',
          points: [
            [-20, 200],
            [0, 200],
          ],
          roadClass: 'secondary',
          layer: 1,
          isBridge: true,
        }),
        makeRoadPart({
          id: 'way/443-0',
          points: [
            [0.05, 200],
            [20, 200],
          ],
          roadClass: 'footway',
          layer: 0,
        }),
        // 3. Exceeds snap tolerance (0.40 m gap <= 0.80 m)
        makeRoadPart({
          id: 'way/444-0',
          points: [
            [-20, 300],
            [0, 300],
          ],
          roadClass: 'secondary',
          layer: 1,
          isBridge: true,
        }),
        makeRoadPart({
          id: 'way/445-0',
          points: [
            [0.4, 300],
            [20, 300],
          ],
          roadClass: 'secondary',
          layer: 0,
        }),
        // 4. Non-terminal endpoint (coordinate fallback at degree-2 junction)
        makeRoadPart({
          id: 'way/446-0',
          points: [
            [-20, 400],
            [0, 400],
          ],
          roadClass: 'secondary',
          layer: 1,
          isBridge: true,
        }),
        makeRoadPart({
          id: 'way/447-0',
          points: [
            [0.05, 400],
            [20, 400],
          ],
          rawOsmNodeIds: ['9100', '9101'],
          roadClass: 'secondary',
          layer: 0,
        }),
        makeRoadPart({
          id: 'way/448-0',
          points: [
            [0.05, 400],
            [0.05, 420],
          ],
          rawOsmNodeIds: ['9100', '9102'],
          roadClass: 'residential',
          layer: 0,
        }),
        // 5. Ambiguous symmetric Y-fork at shared explicit OSM node (both branches at +20 deg and -20 deg -> lead = 0 < 0.10)
        makeRoadPart({
          id: 'way/449-0',
          points: [
            [-20, 500],
            [0, 500],
          ],
          rawOsmNodeIds: ['9200', '9201'],
          roadClass: 'secondary',
          layer: 1,
          isBridge: true,
        }),
        makeRoadPart({
          id: 'way/450-0',
          points: [
            [0, 500],
            [20, 505],
          ],
          rawOsmNodeIds: ['9201', '9202'],
          roadClass: 'secondary',
          layer: 0,
        }),
        makeRoadPart({
          id: 'way/451-0',
          points: [
            [0, 500],
            [20, 495],
          ],
          rawOsmNodeIds: ['9201', '9203'],
          roadClass: 'secondary',
          layer: 0,
        }),
      ],
      railwayParts: [],
      infrastructurePoints: [],
    };

    const diagPortalGraph = buildInfrastructureGraph(diagPortalSource);
    assert.equal(diagPortalGraph.gradeTransitions.length, 0);
    const reasons = new Set(
      diagPortalGraph.diagnostics.unresolvedGradeTransitions.map((u) => u.reason)
    );
    assert.ok(reasons.has('distinct_explicit_osm_nodes'));
    assert.ok(reasons.has('incompatible_class_or_tier'));
    assert.ok(reasons.has('exceeds_snap_tolerance'));
    assert.ok(reasons.has('non_terminal_endpoint'));
    assert.ok(reasons.has('ambiguous_multiple_candidates'));

    // T-04: Two road ways crossing in 2D on the same layer without a shared vertex or explicit OSM node
    const t04Source: TopologySourceData = {
      roadParts: [
        makeRoadPart({
          id: 'way/460-0',
          points: [
            [-25, 0],
            [25, 0],
          ],
          roadClass: 'secondary',
          layer: 0,
        }),
        makeRoadPart({
          id: 'way/461-0',
          points: [
            [0, -25],
            [0, 25],
          ],
          roadClass: 'secondary',
          layer: 0,
        }),
      ],
      railwayParts: [],
      infrastructurePoints: [],
    };

    const t04Graph = buildInfrastructureGraph(t04Source);
    const junctionNodes = [...t04Graph.roads.nodes.values()].filter((n) => n.degree >= 3);
    assert.equal(junctionNodes.length, 0, 'T-04: Must not fabricate a junction node at an unshared 2D road crossing');
    assert.equal(t04Graph.diagnostics.unresolvedCrossings.length, 1);
    assert.equal(t04Graph.diagnostics.unresolvedCrossings[0].kind, 'road_road');
    assert.equal(
      t04Graph.diagnostics.unresolvedCrossings[0].reason,
      'geometric_intersection_without_shared_node'
    );
  });

  it('5. T-14 Grade-Separated Crossings & Contradictory Vertical Tag Rejection: detects road-over-rail, rail-over-road, tunnels, and same-domain overpasses while rejecting contradictory tags', () => {
    const source: TopologySourceData = {
      roadParts: [
        // Road bridge (layer=1) crossing over at-grade railway (layer=0) at [0, 0]
        makeRoadPart({
          id: 'way/500-0',
          points: [
            [-20, 0],
            [20, 0],
          ],
          roadClass: 'primary',
          layer: 1,
          isBridge: true,
        }),
        // At-grade road (layer=0) crossed by railway bridge (layer=1) at [50, 0]
        makeRoadPart({
          id: 'way/501-0',
          points: [
            [50, -20],
            [50, 20],
          ],
          roadClass: 'secondary',
          layer: 0,
          isBridge: false,
        }),
        // Road tunnel (layer=-1) passing under at-grade road (layer=0) at [50, 0]
        makeRoadPart({
          id: 'way/502-0',
          points: [
            [30, 10],
            [70, 10],
          ],
          roadClass: 'secondary',
          layer: -1,
          isTunnel: true,
        }),
        // Contradictory road: layer=1 with isTunnel=true crossing at-grade railway at [100, 0]
        makeRoadPart({
          id: 'way/503-0',
          points: [
            [80, 0],
            [120, 0],
          ],
          roadClass: 'secondary',
          layer: 1,
          isTunnel: true,
        }),
      ],
      railwayParts: [
        // At-grade railway at [0, 0]
        makeRailwayPart({
          id: 'way/600-0',
          points: [
            [0, -20],
            [0, 20],
          ],
          railwayType: 'rail',
          layer: 0,
        }),
        // Railway bridge (layer=1) crossing over at-grade road at [50, 0]
        makeRailwayPart({
          id: 'way/601-0',
          points: [
            [30, 0],
            [70, 0],
          ],
          railwayType: 'rail',
          layer: 1,
          isBridge: true,
        }),
        // At-grade railway at [100, 0] crossed by contradictory road (layer=1, isTunnel=true)
        makeRailwayPart({
          id: 'way/602-0',
          points: [
            [100, -20],
            [100, 20],
          ],
          railwayType: 'rail',
          layer: 0,
        }),
      ],
      infrastructurePoints: [],
    };

    const graph = buildInfrastructureGraph(source);
    assert.equal(graph.levelCrossings.length, 0, 'Must never fabricate a level crossing for grade-separated or contradictory crossings');
    assert.equal(graph.gradeSeparatedCrossings.length, 3);
    assert.equal(graph.diagnostics.gradeSeparatedCrossingCount, 3);

    // 1. Road bridge over railway at [0, 0]
    const roadOverRail = graph.gradeSeparatedCrossings.find(
      (g) => g.upperNetwork === 'road' && g.lowerNetwork === 'railway'
    );
    assert.ok(roadOverRail);
    assert.equal(roadOverRail.upperLayer, 1);
    assert.equal(roadOverRail.upperIsBridge, true);
    assert.equal(roadOverRail.lowerLayer, 0);
    assert.equal(roadOverRail.lowerIsTunnel, false);

    // 2. Railway bridge over road at [50, 0]
    const railOverRoad = graph.gradeSeparatedCrossings.find(
      (g) => g.upperNetwork === 'railway' && g.lowerNetwork === 'road'
    );
    assert.ok(railOverRoad);
    assert.equal(railOverRoad.upperLayer, 1);
    assert.equal(railOverRoad.upperIsBridge, true);
    assert.equal(railOverRoad.lowerLayer, 0);

    // 3. At-grade road over road tunnel at [50, 10]
    const roadOverRoadTunnel = graph.gradeSeparatedCrossings.find(
      (g) => g.upperNetwork === 'road' && g.lowerNetwork === 'road'
    );
    assert.ok(roadOverRoadTunnel);
    assert.equal(roadOverRoadTunnel.upperLayer, 0);
    assert.equal(roadOverRoadTunnel.lowerLayer, -1);
    assert.equal(roadOverRoadTunnel.lowerIsTunnel, true);

    // 4. Contradictory crossing at [100, 0] was rejected from gradeSeparatedCrossings and recorded as unresolved
    assert.equal(graph.diagnostics.unresolvedCrossings.length, 1);
    assert.ok(graph.diagnostics.unresolvedCrossings[0].edgeAId.includes('way/503-0'));
  });

  it('6. MultiLineString & Boundary Clipping Provenance + Stage C Flat Diamond Non-Interchange Regression', () => {
    const provider = new LocalGeoJsonProvider();
    const rawFc = {
      type: 'FeatureCollection',
      features: [
        // MultiLineString road crossing boundary and sharing a level_crossing node on part 0
        {
          type: 'Feature',
          id: 'way/700',
          properties: {
            highway: 'secondary',
            _nodeIdsByPart: [
              ['701', '702', '703'],
              ['704', '705'],
            ],
          },
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [4.899, 52.378],
                [4.900, 52.378],
                [4.901, 52.378],
              ],
              [
                [4.901, 52.378],
                [4.910, 52.378], // extends outside 150 m clip box
              ],
            ],
          },
        },
        // Railway track crossing road at node/702 and also forming a flat diamond crossing with way/711 at node/706
        {
          type: 'Feature',
          id: 'way/710',
          properties: {
            railway: 'rail',
            _nodeIds: ['7101', '702', '706', '7102'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.900, 52.3775],
              [4.900, 52.378],
              [4.900, 52.3785],
              [4.900, 52.379],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'way/711',
          properties: {
            railway: 'rail',
            _nodeIds: ['7111', '706', '7112'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.8995, 52.3785],
              [4.900, 52.3785],
              [4.9005, 52.3785],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'node/702',
          properties: { railway: 'level_crossing' },
          geometry: { type: 'Point', coordinates: [4.900, 52.378] },
        },
        {
          type: 'Feature',
          id: 'node/706',
          properties: { railway: 'railway_crossing' },
          geometry: { type: 'Point', coordinates: [4.900, 52.3785] },
        },
      ],
    };

    const mapData = provider.parseGeoJson(rawFc, 'MultiLine Clipping & Flat Crossing', [4.900, 52.378], 150);
    const graph = buildInfrastructureGraph(mapData);

    // 1. Confirmed level crossing at node/702
    assert.equal(graph.levelCrossings.length, 1);
    assert.equal(graph.levelCrossings[0].rawOsmNodeId, '702');

    // 2. Confirmed Stage C flat diamond crossing at node/706 remains non-interchanging (two decoupled tracks, no switch)
    assert.equal(graph.railwayFlatCrossings.length, 1);
    assert.equal(graph.railwayFlatCrossings[0].rawOsmNodeId, '706');
    assert.notEqual(
      graph.railwayFlatCrossings[0].trackAEdgeId,
      graph.railwayFlatCrossings[0].trackBEdgeId
    );
    const trackA = graph.railways.edges.get(graph.railwayFlatCrossings[0].trackAEdgeId)!;
    const trackB = graph.railways.edges.get(graph.railwayFlatCrossings[0].trackBEdgeId)!;
    const trackANodes = new Set([trackA.fromNodeId, trackA.toNodeId]);
    assert.ok(
      !trackANodes.has(trackB.fromNodeId) && !trackANodes.has(trackB.toNodeId),
      'Flat diamond crossing tracks must remain topologically decoupled in Stage D'
    );

    // 3. Boundary-clipped endpoint from MultiLineString part 1 has role 'boundary_clip' and is never matched as a grade transition or crossing
    assert.ok(graph.diagnostics.boundaryClippedNodeCount >= 1);
    const clippedRoadNodes = [...graph.roads.nodes.values()].filter((n) => n.isBoundaryClipped);
    assert.ok(clippedRoadNodes.length >= 1);
    for (const cn of clippedRoadNodes) {
      assert.ok(cn.roles.includes('boundary_clip'));
      assert.ok(!cn.roles.includes('grade_transition'));
      assert.ok(!cn.roles.includes('level_crossing'));
    }
  });

  it('7. T-17 Determinism & Input Immutability: 10 seeded permutations produce identical InfrastructureGraph and zero input mutation', () => {
    const baseSource: TopologySourceData = {
      roadParts: [
        makeRoadPart({
          id: 'way/800-0',
          points: [
            [-40, 0],
            [0, 0],
          ],
          rawOsmNodeIds: ['801', '802'],
          roadClass: 'primary',
          layer: 0,
        }),
        makeRoadPart({
          id: 'way/801-0',
          points: [
            [0, 0],
            [40, 0],
          ],
          rawOsmNodeIds: ['802', '803'],
          roadClass: 'primary',
          layer: 1,
          isBridge: true,
        }),
        makeRoadPart({
          id: 'way/802-0',
          points: [
            [-40, 30],
            [0, 30],
            [40, 30],
          ],
          rawOsmNodeIds: ['804', '805', '806'],
          roadClass: 'secondary',
          layer: 0,
        }),
      ],
      railwayParts: [
        makeRailwayPart({
          id: 'way/810-0',
          points: [
            [20, -40],
            [20, 0],
            [20, 30],
            [20, 60],
          ],
          rawOsmNodeIds: ['811', '812', '813', '814'],
          railwayType: 'rail',
          layer: 0,
        }),
        makeRailwayPart({
          id: 'way/811-0',
          points: [
            [0, -40],
            [0, 30],
            [0, 60],
          ],
          rawOsmNodeIds: ['821', '805', '822'],
          railwayType: 'rail',
          layer: 0,
        }),
      ],
      infrastructurePoints: [
        {
          id: 'node/805',
          hasExplicitSourceId: true,
          rawOsmNodeId: '805',
          point: [0, 30],
          kind: 'railway_level_crossing',
          osmTags: { railway: 'level_crossing', crossing: 'barrier' },
        },
        {
          id: 'node/804',
          hasExplicitSourceId: true,
          rawOsmNodeId: '804',
          point: [-40, 30],
          kind: 'highway_crossing',
          osmTags: { highway: 'crossing', crossing: 'marked' },
        },
      ],
    };

    const snapshotBefore = JSON.stringify(baseSource);
    const baselineGraph = buildInfrastructureGraph(baseSource);
    const snapshotAfter = JSON.stringify(baseSource);
    assert.equal(snapshotAfter, snapshotBefore, 'buildInfrastructureGraph must never mutate caller inputs');

    const baselineSerialized = serializeInfrastructureGraph(baselineGraph);

    for (let seed = 1; seed <= 10; seed++) {
      const permuted: TopologySourceData = {
        roadParts: shuffleWithSeed(baseSource.roadParts, seed * 13),
        railwayParts: shuffleWithSeed(baseSource.railwayParts, seed * 29),
        infrastructurePoints: shuffleWithSeed(baseSource.infrastructurePoints, seed * 47),
      };
      const permutedGraph = buildInfrastructureGraph(permuted);
      assert.equal(
        serializeInfrastructureGraph(permutedGraph),
        baselineSerialized,
        `Seeded permutation ${seed} must produce identical InfrastructureGraph`
      );
    }
  });

  it('8. GeometryBuilder Renderer Isolation & Real Dataset Verification + Performance Benchmarks (Synthetic, Station Hengelo, Amsterdam Centraal)', () => {
    const hengeloRawFc: any = {
      type: 'FeatureCollection',
      name: 'Station Hengelo',
      features: JSON.parse(JSON.stringify(realOsmExtracts.regions.hengelo.features)),
    };
    const hengeloFc: any = {
      type: 'FeatureCollection',
      name: 'Station Hengelo',
      features: JSON.parse(JSON.stringify(realOsmExtracts.regions.hengelo.features)),
    };
    let nodeCounter = 700000;
    for (const feat of hengeloFc.features) {
      if (feat.geometry?.type === 'LineString' && Array.isArray(feat.geometry.coordinates)) {
        feat.properties = {
          ...(feat.properties || {}),
          _nodeIds: feat.geometry.coordinates.map(() => String(++nodeCounter)),
        };
      }
    }

    const amsterdamFc: any = {
      type: 'FeatureCollection',
      name: 'Amsterdam Centraal',
      features: JSON.parse(JSON.stringify(realOsmExtracts.regions.amsterdamCentraal.features)),
    };

    const provider = new LocalGeoJsonProvider();

    // 1. Verify renderer mesh-buffer invariance on Hengelo before vs after buildInfrastructureGraph
    const hengeloPre = provider.parseGeoJson(hengeloRawFc);
    const hengeloPost = provider.parseGeoJson(hengeloFc);
    const hengeloFullGraph = buildInfrastructureGraph(hengeloPost);

    assert.deepEqual(
      hengeloPost.roads,
      hengeloPre.roads,
      'Legacy mapData.roads must remain 100% identical after Stage D ingestion & graph build'
    );
    assert.deepEqual(
      hengeloPost.railways,
      hengeloPre.railways,
      'Legacy mapData.railways must remain 100% identical after Stage D ingestion & graph build'
    );

    const scenePre = new GeometryBuilder().buildScene(hengeloPre, MAP_THEMES.tactical);
    const scenePost = new GeometryBuilder().buildScene(hengeloPost, MAP_THEMES.tactical);

    const assertSceneGroupBuffersEqual = (
      preObj: THREE.Object3D,
      postObj: THREE.Object3D,
      contextPath = 'root'
    ) => {
      assert.equal(preObj.name, postObj.name, `Object name mismatch at ${contextPath}`);
      assert.equal(preObj.type, postObj.type, `Object type mismatch at ${contextPath}`);
      assert.equal(
        preObj.children.length,
        postObj.children.length,
        `Child count mismatch at ${contextPath}`
      );
      assert.deepEqual(preObj.position.toArray(), postObj.position.toArray());
      assert.deepEqual(preObj.rotation.toArray(), postObj.rotation.toArray());
      assert.deepEqual(preObj.scale.toArray(), postObj.scale.toArray());
      assert.equal(preObj.renderOrder, postObj.renderOrder);

      if ('geometry' in preObj && 'geometry' in postObj) {
        const geoPre = (preObj as THREE.Mesh).geometry;
        const geoPost = (postObj as THREE.Mesh).geometry;
        if (geoPre && geoPost) {
          if (geoPre.index || geoPost.index) {
            assert.ok(geoPre.index && geoPost.index);
            assert.equal(geoPre.index.count, geoPost.index.count);
            assert.deepEqual(Array.from(geoPre.index.array), Array.from(geoPost.index.array));
          }
          const attrKeysPre = Object.keys(geoPre.attributes).sort();
          const attrKeysPost = Object.keys(geoPost.attributes).sort();
          assert.deepEqual(attrKeysPre, attrKeysPost);
          for (const attrName of attrKeysPre) {
            const attrPre = geoPre.attributes[attrName];
            const attrPost = geoPost.attributes[attrName];
            assert.equal(attrPre.count, attrPost.count);
            assert.equal(attrPre.itemSize, attrPost.itemSize);
            assert.deepEqual(Array.from(attrPre.array), Array.from(attrPost.array));
          }
        }
      }
      for (let i = 0; i < preObj.children.length; i++) {
        assertSceneGroupBuffersEqual(
          preObj.children[i],
          postObj.children[i],
          `${contextPath}/${preObj.children[i].name || i}`
        );
      }
    };

    assertSceneGroupBuffersEqual(scenePre.roadsGroup, scenePost.roadsGroup, 'HengeloRoadsGroup');
    assertSceneGroupBuffersEqual(
      scenePre.railwaysGroup,
      scenePost.railwaysGroup,
      'HengeloRailwaysGroup'
    );

    scenePre.dispose();
    scenePost.dispose();

    // 2. Benchmark Station Hengelo
    const tHengeloParse0 = performance.now();
    const hengeloData = provider.parseGeoJson(hengeloRawFc);
    const hengeloParseMs = performance.now() - tHengeloParse0;

    const tHengeloRoad0 = performance.now();
    const hengeloRoads = buildRoadNetwork(hengeloData);
    const hengeloRoadMs = performance.now() - tHengeloRoad0;

    const tHengeloRail0 = performance.now();
    const hengeloRails = buildRailwayNetwork(hengeloData);
    const hengeloRailMs = performance.now() - tHengeloRail0;

    const tHengeloCross0 = performance.now();
    analyzeCrossModal({
      roads: hengeloRoads.roads,
      railways: hengeloRails.railways,
      infrastructurePoints: hengeloData.topologySource?.infrastructurePoints,
      railwayFlatCrossings: hengeloRails.railwayFlatCrossings,
      railwayUnresolvedCrossings: hengeloRails.diagnostics.unresolvedCrossings,
    });
    const hengeloCrossMs = performance.now() - tHengeloCross0;

    const tHengeloTotal0 = performance.now();
    const hengeloGraph = buildInfrastructureGraph(hengeloData);
    const hengeloTotalMs = performance.now() - tHengeloTotal0;

    // 3. Benchmark Amsterdam Centraal
    const tAmsterdamParse0 = performance.now();
    const amsterdamData = provider.parseGeoJson(amsterdamFc);
    const amsterdamParseMs = performance.now() - tAmsterdamParse0;

    const tAmsterdamRoad0 = performance.now();
    const amsterdamRoads = buildRoadNetwork(amsterdamData);
    const amsterdamRoadMs = performance.now() - tAmsterdamRoad0;

    const tAmsterdamRail0 = performance.now();
    const amsterdamRails = buildRailwayNetwork(amsterdamData);
    const amsterdamRailMs = performance.now() - tAmsterdamRail0;

    const tAmsterdamCross0 = performance.now();
    analyzeCrossModal({
      roads: amsterdamRoads.roads,
      railways: amsterdamRails.railways,
      infrastructurePoints: amsterdamData.topologySource?.infrastructurePoints,
      railwayFlatCrossings: amsterdamRails.railwayFlatCrossings,
      railwayUnresolvedCrossings: amsterdamRails.diagnostics.unresolvedCrossings,
    });
    const amsterdamCrossMs = performance.now() - tAmsterdamCross0;

    const tAmsterdamTotal0 = performance.now();
    const amsterdamGraph = buildInfrastructureGraph(amsterdamData);
    const amsterdamTotalMs = performance.now() - tAmsterdamTotal0;

    // 4. Benchmark Synthetic Cross-Modal Dataset (120 roads + 40 railways + 20 crossings + 20 bridges)
    const synthRoadParts: UnchainedRoadPart[] = [];
    const synthRailParts: UnchainedRailwayPart[] = [];
    for (let i = 0; i < 60; i++) {
      const z = -300 + i * 10;
      const isBridge = i % 3 === 0;
      synthRoadParts.push(
        makeRoadPart({
          id: `way/synth_r_${i}-0`,
          points: [
            [-300, z],
            [0, z],
            [300, z],
          ],
          rawOsmNodeIds: [`sr_${i}_0`, `cross_${i}`, `sr_${i}_2`],
          roadClass: i === 31 || i % 5 === 0 ? 'footway' : 'secondary',
          layer: isBridge ? 1 : 0,
          isBridge,
        })
      );
    }
    for (let j = 0; j < 20; j++) {
      const x = -200 + j * 20;
      synthRailParts.push(
        makeRailwayPart({
          id: `way/synth_rl_${j}-0`,
          points: [
            [x, -350],
            [x, 10],
            [x, 350],
          ],
          rawOsmNodeIds: [
            `srl_${j}_0`,
            j === 10 ? 'cross_31' : `srl_${j}_1`,
            `srl_${j}_2`,
          ],
          railwayType: 'rail',
          layer: 0,
        })
      );
    }

    const synthSource: TopologySourceData = {
      roadParts: synthRoadParts,
      railwayParts: synthRailParts,
      infrastructurePoints: [
        {
          id: 'node/cross_31',
          hasExplicitSourceId: true,
          rawOsmNodeId: 'cross_31',
          point: [0, 10],
          kind: 'railway_ped_crossing',
          osmTags: { railway: 'crossing' },
        },
      ],
    };

    const tSynthRoad0 = performance.now();
    const synthRoads = buildRoadNetwork(synthSource);
    const synthRoadMs = performance.now() - tSynthRoad0;

    const tSynthRail0 = performance.now();
    const synthRails = buildRailwayNetwork(synthSource);
    const synthRailMs = performance.now() - tSynthRail0;

    const tSynthCross0 = performance.now();
    analyzeCrossModal({
      roads: synthRoads.roads,
      railways: synthRails.railways,
      infrastructurePoints: synthSource.infrastructurePoints,
      railwayFlatCrossings: synthRails.railwayFlatCrossings,
      railwayUnresolvedCrossings: synthRails.diagnostics.unresolvedCrossings,
    });
    const synthCrossMs = performance.now() - tSynthCross0;

    const tSynthTotal0 = performance.now();
    const synthGraph = buildInfrastructureGraph(synthSource);
    const synthTotalMs = performance.now() - tSynthTotal0;

    assert.ok(synthGraph.gradeSeparatedCrossings.length >= 200);
    assert.equal(synthGraph.levelCrossings.length, 1);
    assert.equal(
      hengeloFullGraph.diagnostics.railwayFlatCrossingCount,
      hengeloFullGraph.railwayFlatCrossings.length
    );
    assert.equal(
      amsterdamGraph.diagnostics.railwayFlatCrossingCount,
      amsterdamGraph.railwayFlatCrossings.length
    );

    // Verify diagnostic invariants: every <collection>Count matches its top-level collection length
    for (const g of [hengeloGraph, amsterdamGraph, synthGraph]) {
      assert.equal(g.diagnostics.roadNodeCount, g.roads.nodes.size);
      assert.equal(g.diagnostics.roadEdgeCount, g.roads.edges.size);
      assert.equal(g.diagnostics.railwayNodeCount, g.railways.nodes.size);
      assert.equal(g.diagnostics.railwayEdgeCount, g.railways.edges.size);
      assert.equal(g.diagnostics.railwayFlatCrossingCount, g.railwayFlatCrossings.length);
      assert.equal(g.diagnostics.gradeTransitionCount, g.gradeTransitions.length);
      assert.equal(
        g.diagnostics.unresolvedGradeTransitionCount,
        g.diagnostics.unresolvedGradeTransitions.length
      );
      assert.equal(g.diagnostics.levelCrossingCount, g.levelCrossings.length);
      assert.equal(
        g.diagnostics.pedestrianRailCrossingCount,
        g.levelCrossings.filter((lc) => lc.crossingKind === 'pedestrian_rail_crossing').length
      );
      assert.equal(
        g.diagnostics.unresolvedCrossingCount,
        g.diagnostics.unresolvedCrossings.length
      );
      assert.equal(
        g.diagnostics.gradeSeparatedCrossingCount,
        g.gradeSeparatedCrossings.length
      );
    }

    assert.ok(hengeloTotalMs < 150, `Expected Hengelo buildInfrastructureGraph < 150 ms (got ${hengeloTotalMs.toFixed(2)} ms)`);
    assert.ok(amsterdamTotalMs < 250, `Expected Amsterdam buildInfrastructureGraph < 250 ms (got ${amsterdamTotalMs.toFixed(2)} ms)`);
    assert.ok(synthTotalMs < 150, `Expected Synthetic buildInfrastructureGraph < 150 ms (got ${synthTotalMs.toFixed(2)} ms)`);

    // Log timings and diagnostics for verification reporting
    console.log(
      `[Stage D Benchmarks] Hengelo: parse=${hengeloParseMs.toFixed(2)}ms, road=${hengeloRoadMs.toFixed(2)}ms, rail=${hengeloRailMs.toFixed(2)}ms, crossModal=${hengeloCrossMs.toFixed(2)}ms, total=${hengeloTotalMs.toFixed(2)}ms | diag=${JSON.stringify({
        roadNodes: hengeloGraph.diagnostics.roadNodeCount,
        roadEdges: hengeloGraph.diagnostics.roadEdgeCount,
        railNodes: hengeloGraph.diagnostics.railwayNodeCount,
        railEdges: hengeloGraph.diagnostics.railwayEdgeCount,
        gradeTransitions: hengeloGraph.diagnostics.gradeTransitionCount,
        unresolvedGradeTransitions: hengeloGraph.diagnostics.unresolvedGradeTransitionCount,
        levelCrossings: hengeloGraph.diagnostics.levelCrossingCount,
        pedRailCrossings: hengeloGraph.diagnostics.pedestrianRailCrossingCount,
        gradeSeparatedCrossings: hengeloGraph.diagnostics.gradeSeparatedCrossingCount,
        unresolvedCrossings: hengeloGraph.diagnostics.unresolvedCrossingCount,
        unresolvedPoints: hengeloGraph.diagnostics.unresolvedInfrastructurePoints?.length ?? 0,
      })}`
    );
    console.log(
      `[Stage D Benchmarks] Amsterdam: parse=${amsterdamParseMs.toFixed(2)}ms, road=${amsterdamRoadMs.toFixed(2)}ms, rail=${amsterdamRailMs.toFixed(2)}ms, crossModal=${amsterdamCrossMs.toFixed(2)}ms, total=${amsterdamTotalMs.toFixed(2)}ms | diag=${JSON.stringify({
        roadNodes: amsterdamGraph.diagnostics.roadNodeCount,
        roadEdges: amsterdamGraph.diagnostics.roadEdgeCount,
        railNodes: amsterdamGraph.diagnostics.railwayNodeCount,
        railEdges: amsterdamGraph.diagnostics.railwayEdgeCount,
        gradeTransitions: amsterdamGraph.diagnostics.gradeTransitionCount,
        unresolvedGradeTransitions: amsterdamGraph.diagnostics.unresolvedGradeTransitionCount,
        levelCrossings: amsterdamGraph.diagnostics.levelCrossingCount,
        pedRailCrossings: amsterdamGraph.diagnostics.pedestrianRailCrossingCount,
        gradeSeparatedCrossings: amsterdamGraph.diagnostics.gradeSeparatedCrossingCount,
        unresolvedCrossings: amsterdamGraph.diagnostics.unresolvedCrossingCount,
        unresolvedPoints: amsterdamGraph.diagnostics.unresolvedInfrastructurePoints?.length ?? 0,
      })}`
    );
    console.log(
      `[Stage D Benchmarks] Synthetic (60 roads x 20 rails): road=${synthRoadMs.toFixed(2)}ms, rail=${synthRailMs.toFixed(2)}ms, crossModal=${synthCrossMs.toFixed(2)}ms, total=${synthTotalMs.toFixed(2)}ms, gradeSeparated=${synthGraph.gradeSeparatedCrossings.length}`
    );
  });
});
