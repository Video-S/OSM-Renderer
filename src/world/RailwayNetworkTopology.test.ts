import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import osmtogeojson from 'osmtogeojson';
import { DOMParser } from 'xmldom';
import * as THREE from 'three';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { GeometryBuilder } from './GeometryBuilder';
import { MAP_THEMES } from '../styles/mapThemes';
import {
  buildRailwayNetwork,
  enrichGeoJsonWithOsmXmlNodeIds,
  enrichGeoJsonWithOverpassNodeIds,
  InfrastructurePointMetadata,
  RailwayNetworkBuildResult,
  UnchainedRailwayPart,
} from './infrastructure/topology/InfrastructureGraph';
import realOsmExtracts from './prototype/realOsmRailwayExtracts.json';

function assertSceneGroupBuffersEqual(
  preObj: THREE.Object3D,
  postObj: THREE.Object3D,
  contextPath = 'root'
) {
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

  if (preObj.userData?.faceRanges || postObj.userData?.faceRanges) {
    assert.deepEqual(preObj.userData.faceRanges, postObj.userData.faceRanges);
  }

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

  if ('instanceMatrix' in preObj && 'instanceMatrix' in postObj) {
    const instPre = preObj as THREE.InstancedMesh;
    const instPost = postObj as THREE.InstancedMesh;
    assert.equal(instPre.count, instPost.count);
    assert.deepEqual(
      Array.from(instPre.instanceMatrix.array),
      Array.from(instPost.instanceMatrix.array)
    );
  }

  for (let i = 0; i < preObj.children.length; i++) {
    assertSceneGroupBuffersEqual(
      preObj.children[i],
      postObj.children[i],
      `${contextPath}/${preObj.children[i].name || i}`
    );
  }
}

function makeRailwayPart(
  overrides: Partial<UnchainedRailwayPart> & {
    id: string;
    points: readonly [number, number][];
  }
): UnchainedRailwayPart {
  const sourceFeatureId = overrides.sourceFeatureId ?? overrides.id.replace(/-\d+$/, '');
  const service = overrides.service;
  const usage = overrides.usage;
  const defaultSecondary =
    (service !== undefined &&
      ['siding', 'yard', 'spur', 'crossover'].includes(service.toLowerCase())) ||
    (usage !== undefined &&
      ['branch', 'industrial', 'military', 'test', 'tourism'].includes(usage.toLowerCase()));

  return {
    id: overrides.id,
    sourceFeatureId,
    hasExplicitSourceId: overrides.hasExplicitSourceId ?? !/^feat-\d+$/.test(sourceFeatureId),
    partIndex: overrides.partIndex ?? 0,
    points: overrides.points.map((pt) => [pt[0], pt[1]] as [number, number]),
    rawOsmNodeIds:
      overrides.rawOsmNodeIds ?? overrides.points.map(() => undefined as string | undefined),
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
    service,
    usage,
    isSecondaryBranch: overrides.isSecondaryBranch ?? defaultSecondary,
    osmTags: overrides.osmTags ?? {
      railway: overrides.railwayType ?? 'rail',
      ...(overrides.gauge ? { gauge: overrides.gauge } : { gauge: '1435' }),
      ...(overrides.electrified
        ? { electrified: overrides.electrified }
        : { electrified: 'contact_line' }),
      ...(service ? { service } : {}),
      ...(usage ? { usage } : {}),
      ...(overrides.name ? { name: overrides.name } : {}),
    },
  };
}

function serializeRailwayResult(res: RailwayNetworkBuildResult) {
  return {
    nodes: [...res.railways.nodes.entries()],
    edges: [...res.railways.edges.entries()],
    featureToEdgeIds: [...res.railways.featureToEdgeIds.entries()],
    railwayFlatCrossings: res.railwayFlatCrossings,
    diagnostics: res.diagnostics,
  };
}

function areEdgesConnectedInGraph(
  res: RailwayNetworkBuildResult,
  edgeAId: string,
  edgeBId: string
): boolean {
  const edgeA = res.railways.edges.get(edgeAId);
  const edgeB = res.railways.edges.get(edgeBId);
  if (!edgeA || !edgeB) return false;
  if (edgeAId === edgeBId) return true;

  const visitedNodes = new Set<string>([edgeA.fromNodeId, edgeA.toNodeId]);
  const queue: string[] = [edgeA.fromNodeId, edgeA.toNodeId];

  while (queue.length > 0) {
    const curNodeId = queue.shift()!;
    const node = res.railways.nodes.get(curNodeId);
    if (!node) continue;
    for (const incEdgeId of node.incidentEdgeIds) {
      if (incEdgeId === edgeBId) return true;
      const incEdge = res.railways.edges.get(incEdgeId);
      if (!incEdge) continue;
      for (const nextNodeId of [incEdge.fromNodeId, incEdge.toNodeId]) {
        if (!visitedNodes.has(nextNodeId)) {
          visitedNodes.add(nextNodeId);
          queue.push(nextNodeId);
        }
      }
    }
  }
  return false;
}

describe('M2.3-C Railway Network Graph Topology (ADR-0009)', () => {
  it('T-11(a): confirms a 1-to-2 railway turnout switch with asymmetric deflection and resolves trunk, main, and diverging branches', () => {
    const parts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/10-0',
        sourceFeatureId: 'way/10',
        points: [
          [-100, 0],
          [0, 0],
        ],
        rawOsmNodeIds: ['1001', '1002'],
        usage: 'main',
      }),
      makeRailwayPart({
        id: 'way/11-0',
        sourceFeatureId: 'way/11',
        points: [
          [0, 0],
          [100, 0],
        ],
        rawOsmNodeIds: ['1002', '1003'],
        usage: 'main',
      }),
      makeRailwayPart({
        id: 'way/12-0',
        sourceFeatureId: 'way/12',
        points: [
          [0, 0],
          [100, -18],
        ],
        rawOsmNodeIds: ['1002', '1004'],
        service: 'siding',
        isSecondaryBranch: true,
      }),
    ];

    const points: InfrastructurePointMetadata[] = [
      {
        id: 'node/1002',
        hasExplicitSourceId: true,
        rawOsmNodeId: '1002',
        point: [0, 0],
        kind: 'railway_switch',
        osmTags: { railway: 'switch', 'railway:switch': 'left' },
      },
    ];

    const res = buildRailwayNetwork(parts, points);
    assert.equal(res.diagnostics.railwayNodeCount, 4);
    assert.equal(res.diagnostics.railwayEdgeCount, 3);
    assert.equal(res.diagnostics.railwayConfirmedSwitchCount, 1);
    assert.equal(res.diagnostics.railwayUnresolvedSwitchCount, 0);

    const switchNode = res.railways.nodes.get('rail_node:0|0|0:osm_1002');
    assert.ok(switchNode, 'Expected explicit OSM switch node');
    assert.equal(switchNode.degree, 3);
    assert.equal(switchNode.primaryRole, 'switch');
    assert.deepEqual(switchNode.roles, ['switch']);
    assert.ok(switchNode.turnoutTopology);
    assert.equal(switchNode.turnoutTopology.status, 'confirmed');
    assert.equal(switchNode.turnoutTopology.trunkEdgeId, 'rail_edge:way/10-0:seg_0:p_0');
    assert.equal(switchNode.turnoutTopology.mainBranchEdgeId, 'rail_edge:way/11-0:seg_0:p_0');
    assert.equal(switchNode.turnoutTopology.divergingBranchEdgeId, 'rail_edge:way/12-0:seg_0:p_0');
    assert.equal(switchNode.turnoutTopology.turnoutSide, 'left');
    assert.ok(
      switchNode.turnoutTopology.divergenceAngleRad! > 0.15 &&
        switchNode.turnoutTopology.divergenceAngleRad! < 0.22
    );
  });

  it('T-11(b) & (c): classifies symmetric Y-switches (< 4 deg diff, identical tags) as unresolved_main_vs_diverging unless disambiguated by secondary branch, and malformed throats as unresolved_throat', () => {
    const rad5 = (5 * Math.PI) / 180;
    const symParts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/20-0',
        points: [
          [-100, 0],
          [0, 0],
        ],
        rawOsmNodeIds: ['2001', '2002'],
      }),
      makeRailwayPart({
        id: 'way/21-0',
        points: [
          [0, 0],
          [100 * Math.cos(rad5), -100 * Math.sin(rad5)],
        ],
        rawOsmNodeIds: ['2002', '2003'],
      }),
      makeRailwayPart({
        id: 'way/22-0',
        points: [
          [0, 0],
          [100 * Math.cos(rad5), 100 * Math.sin(rad5)],
        ],
        rawOsmNodeIds: ['2002', '2004'],
      }),
    ];

    const symRes = buildRailwayNetwork(symParts, [
      {
        id: 'node/2002',
        hasExplicitSourceId: true,
        rawOsmNodeId: '2002',
        point: [0, 0],
        kind: 'railway_switch',
        osmTags: { railway: 'switch' },
      },
    ]);

    assert.equal(symRes.diagnostics.railwayConfirmedSwitchCount, 0);
    assert.equal(symRes.diagnostics.railwayUnresolvedSwitchCount, 1);
    const symNode = symRes.railways.nodes.get('rail_node:0|0|0:osm_2002')!;
    assert.equal(symNode.turnoutTopology?.status, 'unresolved_main_vs_diverging');
    assert.equal(symNode.turnoutTopology?.trunkEdgeId, 'rail_edge:way/20-0:seg_0:p_0');
    assert.equal(symNode.turnoutTopology?.mainBranchEdgeId, undefined);
    assert.equal(symNode.turnoutTopology?.divergingBranchEdgeId, undefined);
    assert.ok(symNode.roles.includes('junction'));
    assert.ok(symNode.roles.includes('switch'));

    // Symmetric Y-switch where way/22 is tagged service=siding -> confirmed via secondary-branch disambiguation
    const disambigParts = [
      symParts[0],
      symParts[1],
      makeRailwayPart({
        ...symParts[2],
        service: 'siding',
        isSecondaryBranch: true,
      }),
    ];
    const disambigRes = buildRailwayNetwork(disambigParts);
    assert.equal(disambigRes.diagnostics.railwayConfirmedSwitchCount, 1);
    const disambigNode = disambigRes.railways.nodes.get('rail_node:0|0|0:osm_2002')!;
    assert.equal(disambigNode.turnoutTopology?.status, 'confirmed');
    assert.equal(disambigNode.turnoutTopology?.mainBranchEdgeId, 'rail_edge:way/21-0:seg_0:p_0');
    assert.equal(
      disambigNode.turnoutTopology?.divergingBranchEdgeId,
      'rail_edge:way/22-0:seg_0:p_0'
    );

    // Malformed degree-3 throat where all 3 edges point into the same Eastward hemisphere
    const malformedParts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/30-0',
        points: [
          [0, 0],
          [100, -30],
        ],
        rawOsmNodeIds: ['3001', '3002'],
      }),
      makeRailwayPart({
        id: 'way/31-0',
        points: [
          [0, 0],
          [100, 0],
        ],
        rawOsmNodeIds: ['3001', '3003'],
      }),
      makeRailwayPart({
        id: 'way/32-0',
        points: [
          [0, 0],
          [100, 30],
        ],
        rawOsmNodeIds: ['3001', '3004'],
      }),
    ];
    const malformedRes = buildRailwayNetwork(malformedParts);
    assert.equal(malformedRes.diagnostics.railwayConfirmedSwitchCount, 0);
    assert.equal(malformedRes.diagnostics.railwayUnresolvedSwitchCount, 1);
    const throatNode = malformedRes.railways.nodes.get('rail_node:0|0|0:osm_3001')!;
    assert.equal(throatNode.turnoutTopology?.status, 'unresolved_throat');
    assert.ok(throatNode.roles.includes('junction'));
  });

  it('T-12(a) & (d): resolves a flat diamond crossing on two continuous ways sharing a crossing vertex and enforces strict non-interchange', () => {
    const parts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/100-0',
        sourceFeatureId: 'way/100',
        points: [
          [-80, 0],
          [0, 0],
          [80, 0],
        ],
        rawOsmNodeIds: ['4001', '4002', '4003'],
      }),
      makeRailwayPart({
        id: 'way/101-0',
        sourceFeatureId: 'way/101',
        points: [
          [-40, -70],
          [0, 0],
          [40, 70],
        ],
        rawOsmNodeIds: ['4004', '4002', '4005'],
      }),
    ];

    const crossingPoint: InfrastructurePointMetadata = {
      id: 'node/4002',
      hasExplicitSourceId: true,
      rawOsmNodeId: '4002',
      point: [0, 0],
      kind: 'railway_crossing_flat',
      osmTags: { railway: 'railway_crossing' },
    };

    const res = buildRailwayNetwork(parts, [crossingPoint]);
    assert.equal(res.diagnostics.railwayFlatCrossingCount, 1);
    assert.equal(res.diagnostics.railwayUnresolvedJunctionCount, 0);
    assert.equal(res.diagnostics.railwayEdgeCount, 2);
    assert.equal(res.diagnostics.railwayNodeCount, 4);

    const fc = res.railwayFlatCrossings[0];
    assert.equal(fc.id, 'rail_flat_crossing:1');
    assert.equal(fc.rawOsmNodeId, '4002');
    assert.equal(fc.confidence, 'explicit_railway_crossing_tag');
    assert.equal(fc.trackAEdgeId, 'rail_edge:way/100-0:seg_0:p_0');
    assert.equal(fc.trackBEdgeId, 'rail_edge:way/101-0:seg_0:p_0');
    assert.ok(Math.abs(fc.trackAArcLengthMeters - 80) < 1e-6);
    assert.ok(Math.abs(fc.trackBArcLengthMeters - Math.hypot(40, 70)) < 1e-6);
    assert.ok(fc.crossingAngleRad > 0.9 && fc.crossingAngleRad <= Math.PI / 2 + 1e-6);

    assert.equal(
      areEdgesConnectedInGraph(res, fc.trackAEdgeId, fc.trackBEdgeId),
      false,
      'Flat diamond crossing tracks must not be connected in the railway graph'
    );
  });

  it('T-12(b), (c) & (d): pairs 4 segmented endpoints at a tagged railway=railway_crossing diamond into 2 independent through-tracks, while flagging untagged degree-4 meetings as unresolved', () => {
    const fourSegments: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/201-0',
        sourceFeatureId: 'way/201',
        points: [
          [-60, 0],
          [0, 0],
        ],
        rawOsmNodeIds: ['5001', '5000'],
      }),
      makeRailwayPart({
        id: 'way/202-0',
        sourceFeatureId: 'way/202',
        points: [
          [0, 0],
          [60, 0],
        ],
        rawOsmNodeIds: ['5000', '5002'],
      }),
      makeRailwayPart({
        id: 'way/203-0',
        sourceFeatureId: 'way/203',
        points: [
          [0, -50],
          [0, 0],
        ],
        rawOsmNodeIds: ['5003', '5000'],
      }),
      makeRailwayPart({
        id: 'way/204-0',
        sourceFeatureId: 'way/204',
        points: [
          [0, 0],
          [0, 50],
        ],
        rawOsmNodeIds: ['5000', '5004'],
      }),
    ];

    const taggedRes = buildRailwayNetwork(fourSegments, [
      {
        id: 'node/5000',
        hasExplicitSourceId: true,
        rawOsmNodeId: '5000',
        point: [0, 0],
        kind: 'railway_crossing_flat',
        osmTags: { railway: 'railway_crossing' },
      },
    ]);

    assert.equal(taggedRes.diagnostics.railwayFlatCrossingCount, 1);
    assert.equal(taggedRes.diagnostics.railwayUnresolvedJunctionCount, 0);
    assert.equal(taggedRes.diagnostics.railwayEdgeCount, 2);
    assert.equal(taggedRes.diagnostics.railwayNodeCount, 4);

    const fc = taggedRes.railwayFlatCrossings[0];
    assert.equal(fc.confidence, 'explicit_railway_crossing_tag');
    assert.ok(Math.abs(fc.trackAArcLengthMeters - 60) < 1e-6);
    assert.ok(Math.abs(fc.trackBArcLengthMeters - 50) < 1e-6);
    assert.ok(Math.abs(fc.crossingAngleRad - Math.PI / 2) < 1e-6);

    const trackAEdge = taggedRes.railways.edges.get(fc.trackAEdgeId)!;
    const trackBEdge = taggedRes.railways.edges.get(fc.trackBEdgeId)!;
    assert.deepEqual(trackAEdge.provenance.mergedPartIds, ['way/201-0', 'way/202-0']);
    assert.deepEqual(trackBEdge.provenance.mergedPartIds, ['way/203-0', 'way/204-0']);
    assert.equal(
      areEdgesConnectedInGraph(taggedRes, fc.trackAEdgeId, fc.trackBEdgeId),
      false,
      'Segmented flat diamond crossing through-tracks must not allow turning between Track A and Track B'
    );

    const untaggedRes = buildRailwayNetwork(fourSegments);
    assert.equal(untaggedRes.diagnostics.railwayFlatCrossingCount, 0);
    assert.equal(untaggedRes.diagnostics.railwayUnresolvedJunctionCount, 1);
    assert.equal(untaggedRes.diagnostics.unresolvedCrossings.length, 1);
    assert.equal(
      untaggedRes.diagnostics.unresolvedCrossings[0].reason,
      'missing_railway_crossing_tag_at_degree_4_node'
    );
    const centerNode = untaggedRes.railways.nodes.get('rail_node:0|0|0:osm_5000')!;
    assert.equal(centerNode.degree, 4);
    assert.equal(centerNode.primaryRole, 'junction');
  });

  it('splits a continuous main line at a shared interior OSM node where a branch track attaches', () => {
    const parts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/300-0',
        points: [
          [-100, 0],
          [0, 0],
          [100, 0],
        ],
        rawOsmNodeIds: ['6001', '6002', '6003'],
      }),
      makeRailwayPart({
        id: 'way/301-0',
        points: [
          [0, 0],
          [80, 15],
        ],
        rawOsmNodeIds: ['6002', '6004'],
        service: 'spur',
      }),
    ];

    const res = buildRailwayNetwork(parts);
    assert.equal(res.diagnostics.railwayInteriorSplitCount, 1);
    assert.equal(res.diagnostics.railwayEdgeCount, 3);
    assert.equal(res.diagnostics.railwayConfirmedSwitchCount, 1);

    const switchNode = res.railways.nodes.get('rail_node:0|0|0:osm_6002')!;
    assert.equal(switchNode.degree, 3);
    assert.equal(switchNode.turnoutTopology?.status, 'confirmed');
    assert.equal(switchNode.turnoutTopology?.turnoutSide, 'right');
  });

  it('preserves intermediate curved railway shape vertices and contracts compatible degree-2 chains with reversed provenance', () => {
    const parts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/400-0',
        sourceFeatureId: 'way/400',
        points: [
          [-100, 0],
          [-50, 5],
          [0, 0],
        ],
        rawOsmNodeIds: ['7001', '7010', '7002'],
      }),
      makeRailwayPart({
        id: 'way/401-0',
        sourceFeatureId: 'way/401',
        points: [
          [100, 0],
          [50, -5],
          [0, 0],
        ],
        rawOsmNodeIds: ['7003', '7011', '7002'],
      }),
    ];

    const res = buildRailwayNetwork(parts);
    assert.equal(res.diagnostics.railwaySimplifiedDegree2Count, 1);
    assert.equal(res.diagnostics.railwayEdgeCount, 1);
    assert.equal(res.diagnostics.railwayNodeCount, 2);

    const edge = [...res.railways.edges.values()][0];
    assert.equal(edge.points.length, 5);
    assert.deepEqual(edge.points, [
      [-100, 0],
      [-50, 5],
      [0, 0],
      [50, -5],
      [100, 0],
    ]);
    assert.deepEqual(edge.vertexRawOsmNodeIds, ['7001', '7010', '7002', '7011', '7003']);
    assert.equal(edge.provenance.segments.length, 2);
    assert.equal(edge.provenance.segments[0].partId, 'way/400-0');
    assert.equal(edge.provenance.segments[0].reversedRelativeToSource, false);
    assert.equal(edge.provenance.segments[1].partId, 'way/401-0');
    assert.equal(edge.provenance.segments[1].reversedRelativeToSource, true);
    assert.equal(edge.provenance.segments[1].sourceStartVertexIndex, 2);
    assert.equal(edge.provenance.segments[1].sourceEndVertexIndex, 0);
  });

  it('preserves parallel tracks and passing loops without collapsing and assigns deterministic parallelIndex', () => {
    const parts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/500-0',
        points: [
          [0, 0],
          [50, 0],
          [100, 0],
        ],
        rawOsmNodeIds: ['8001', undefined, '8002'],
        usage: 'main',
      }),
      makeRailwayPart({
        id: 'way/501-0',
        points: [
          [0, 0],
          [20, 4],
          [80, 4],
          [100, 0],
        ],
        rawOsmNodeIds: ['8001', undefined, undefined, '8002'],
        service: 'siding',
      }),
    ];

    const res = buildRailwayNetwork(parts);
    assert.equal(res.diagnostics.railwayEdgeCount, 2);
    assert.equal(res.diagnostics.railwayParallelEdgePairCount, 1);

    const e0 = res.railways.edges.get('rail_edge:way/500-0:seg_0:p_0')!;
    const e1 = res.railways.edges.get('rail_edge:way/501-0:seg_0:p_1')!;
    assert.ok(e0 && e1);
    assert.equal(e0.parallelIndex, 0);
    assert.equal(e1.parallelIndex, 1);
  });

  it('maintains self-loop and P-loop degree and half-edge invariants', () => {
    // P-loop: stem (9001 -> 9002) + closed loop (9002 -> ... -> 9002)
    // Plus an isolated 3-way closed balloon loop (9010 -> 9011 -> 9012 -> 9010)
    const parts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/600-0',
        points: [
          [-50, 0],
          [0, 0],
        ],
        rawOsmNodeIds: ['9001', '9002'],
      }),
      makeRailwayPart({
        id: 'way/601-0',
        points: [
          [0, 0],
          [30, -20],
          [60, 0],
          [30, 20],
          [0, 0],
        ],
        rawOsmNodeIds: ['9002', undefined, undefined, undefined, '9002'],
      }),
      makeRailwayPart({
        id: 'way/602-0',
        points: [
          [200, 0],
          [240, -30],
        ],
        rawOsmNodeIds: ['9010', '9011'],
      }),
      makeRailwayPart({
        id: 'way/603-0',
        points: [
          [240, -30],
          [280, 0],
        ],
        rawOsmNodeIds: ['9011', '9012'],
      }),
      makeRailwayPart({
        id: 'way/604-0',
        points: [
          [280, 0],
          [240, 30],
          [200, 0],
        ],
        rawOsmNodeIds: ['9012', undefined, '9010'],
      }),
    ];

    const res = buildRailwayNetwork(parts);
    assert.equal(res.diagnostics.closedLoopEdgeCount, 2);

    const pLoopJoin = res.railways.nodes.get('rail_node:0|0|0:osm_9002')!;
    assert.equal(pLoopJoin.degree, 3);
    assert.equal(pLoopJoin.incidentHalfEdges.length, 3);
    assert.equal(pLoopJoin.incidentEdgeIds.length, 2);

    const isolatedAnchor = res.railways.nodes.get('rail_node:0|0|0:osm_9010')!;
    assert.ok(isolatedAnchor, 'Expected deterministic osm_9010 anchor on isolated closed loop');
    assert.equal(isolatedAnchor.degree, 2);
    assert.equal(isolatedAnchor.incidentHalfEdges.length, 2);
    assert.equal(isolatedAnchor.incidentEdgeIds.length, 1);
    assert.ok(isolatedAnchor.roles.includes('loop_anchor'));
  });

  it('prevents degree-2 contraction across railwayType, width, gauge, electrified, service, and usage breaks', () => {
    const attributeCases: Array<{
      label: string;
      mod: Partial<UnchainedRailwayPart>;
    }> = [
      { label: 'railwayType', mod: { railwayType: 'tram' } },
      { label: 'width', mod: { width: 3.6 } },
      { label: 'gauge', mod: { gauge: '1000' } },
      { label: 'electrified', mod: { electrified: 'no' } },
      { label: 'service', mod: { service: 'siding', isSecondaryBranch: true } },
      { label: 'usage', mod: { usage: 'branch', isSecondaryBranch: true } },
    ];

    for (const tc of attributeCases) {
      const p1 = makeRailwayPart({
        id: 'way/700-0',
        points: [
          [-50, 0],
          [0, 0],
        ],
        rawOsmNodeIds: ['71', '72'],
        usage: 'main',
      });
      const p2 = makeRailwayPart({
        id: 'way/701-0',
        points: [
          [0, 0],
          [50, 0],
        ],
        rawOsmNodeIds: ['72', '73'],
        usage: 'main',
        ...tc.mod,
      });

      const res = buildRailwayNetwork([p1, p2]);
      assert.equal(
        res.diagnostics.railwaySimplifiedDegree2Count,
        0,
        `Expected attribute break for ${tc.label}`
      );
      assert.equal(res.diagnostics.railwayEdgeCount, 2);
      const breakNode = res.railways.nodes.get('rail_node:0|0|0:osm_72')!;
      assert.ok(
        breakNode.roles.includes('attribute_break'),
        `Expected attribute_break role for ${tc.label}`
      );
    }
  });

  it('isolates bridge railway tracks from at-grade railway tracks without false nodes or flat crossings', () => {
    const parts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/800-0',
        points: [
          [-60, 0],
          [0, 0],
          [60, 0],
        ],
        rawOsmNodeIds: ['81', '82', '83'],
        layer: 0,
        isBridge: false,
      }),
      makeRailwayPart({
        id: 'way/801-0',
        points: [
          [0, -60],
          [0, 0],
          [0, 60],
        ],
        rawOsmNodeIds: ['84', '82', '85'],
        layer: 1,
        isBridge: true,
      }),
    ];

    const res = buildRailwayNetwork(parts);
    assert.equal(res.diagnostics.railwayEdgeCount, 2);
    assert.equal(res.diagnostics.railwayNodeCount, 4);
    assert.equal(res.diagnostics.railwayFlatCrossingCount, 0);
  });

  it('preserves synthetic boundary-clipped railway endpoints and never merges them into junctions', () => {
    const parts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/900-0',
        points: [
          [-380, 10],
          [0, 10],
        ],
        rawOsmNodeIds: [undefined, '902'],
        clippedAtStart: true,
      }),
      makeRailwayPart({
        id: 'way/901-0',
        points: [
          [-380, 10.05],
          [0, 20],
        ],
        rawOsmNodeIds: [undefined, '903'],
        clippedAtStart: true,
      }),
    ];

    const res = buildRailwayNetwork(parts);
    assert.equal(res.diagnostics.boundaryClippedNodeCount, 2);
    assert.equal(res.diagnostics.railwayNodeCount, 4);
    for (const node of res.railways.nodes.values()) {
      if (node.isBoundaryClipped) {
        assert.equal(node.nodeIdOrigin, 'boundary_clip');
        assert.equal(node.primaryRole, 'boundary_clip');
        assert.equal(node.degree, 1);
      }
    }
  });

  it('preserves explicit OSM node IDs across LineString, MultiLineString, Overpass JSON, and OSM XML inputs', () => {
    const provider = new LocalGeoJsonProvider();

    const overpassPayload = {
      version: 0.6,
      elements: [
        { type: 'node', id: 9101, lat: 52.378, lon: 4.9 },
        { type: 'node', id: 9102, lat: 52.378, lon: 4.901, tags: { railway: 'switch', 'railway:switch': 'left' } },
        { type: 'node', id: 9103, lat: 52.378, lon: 4.902 },
        { type: 'node', id: 9104, lat: 52.3782, lon: 4.902 },
        {
          type: 'way',
          id: 1002,
          nodes: [9102, 9104],
          tags: { railway: 'rail', service: 'siding' },
        },
      ],
    };

    const baseGeoJson: any = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'way/1001',
          properties: {
            '@id': 'way/1001',
            railway: 'rail',
            gauge: '1435',
            electrified: 'contact_line',
            _nodeIdsByPart: [
              ['9101', '9102'],
              ['9102', '9103'],
            ],
          },
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [4.9, 52.378],
                [4.901, 52.378],
              ],
              [
                [4.901, 52.378],
                [4.902, 52.378],
              ],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'way/1002',
          properties: {
            '@id': 'way/1002',
            railway: 'rail',
            service: 'siding',
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.901, 52.378],
              [4.902, 52.3782],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'node/9102',
          properties: {
            '@id': 'node/9102',
            railway: 'switch',
            'railway:switch': 'left',
          },
          geometry: {
            type: 'Point',
            coordinates: [4.901, 52.378],
          },
        },
      ],
    };

    enrichGeoJsonWithOverpassNodeIds(baseGeoJson, overpassPayload);

    const parsedOverpass = provider.parseGeoJson(baseGeoJson);
    assert.equal(parsedOverpass.topologySource?.railwayParts.length, 3);
    assert.deepEqual(parsedOverpass.topologySource?.railwayParts[2].rawOsmNodeIds, ['9102', '9104']);
    assert.equal(parsedOverpass.topologySource?.infrastructurePoints.length, 1);
    assert.equal(parsedOverpass.topologySource?.infrastructurePoints[0].kind, 'railway_switch');
    assert.equal(parsedOverpass.topologySource?.infrastructurePoints[0].rawOsmNodeId, '9102');

    const overpassNet = buildRailwayNetwork(parsedOverpass);
    assert.equal(overpassNet.diagnostics.railwayConfirmedSwitchCount, 1);
    const swNode = overpassNet.railways.nodes.get('rail_node:0|0|0:osm_9102')!;
    assert.ok(swNode);
    assert.equal(swNode.turnoutTopology?.status, 'confirmed');
    assert.equal(swNode.turnoutTopology?.turnoutSide, 'left');

    // 2. OSM 0.6 XML enrichment
    const osmXmlString = `<?xml version="1.0" encoding="UTF-8"?>
      <osm version="0.6">
        <node id="8801" lat="52.3780" lon="4.9000"/>
        <node id="8802" lat="52.3780" lon="4.9010"/>
        <way id="2001">
          <nd ref="8801"/>
          <nd ref="8802"/>
          <tag k="railway" v="rail"/>
        </way>
      </osm>`;
    const xmlDoc = new DOMParser().parseFromString(osmXmlString, 'text/xml');
    const xmlGeoJson = osmtogeojson(xmlDoc);
    enrichGeoJsonWithOsmXmlNodeIds(xmlGeoJson, xmlDoc);
    const parsedXml = provider.parseGeoJson(xmlGeoJson);
    assert.deepEqual(parsedXml.topologySource?.railwayParts[0].rawOsmNodeIds, ['8801', '8802']);
  });

  it('deduplicates exact 1mm + identical-metadata railway duplicates while preserving identical geometries with differing railway metadata', () => {
    const basePart = makeRailwayPart({
      id: 'way/1100-0',
      sourceFeatureId: 'way/1100',
      points: [
        [0, 0],
        [100, 0],
      ],
      rawOsmNodeIds: ['11', '12'],
      gauge: '1435',
    });
    const exactReversedDuplicate = makeRailwayPart({
      id: 'way/1101-0',
      sourceFeatureId: 'way/1101',
      points: [
        [100, 0],
        [0, 0],
      ],
      rawOsmNodeIds: ['12', '11'],
      gauge: '1435',
    });
    const dualGaugeOverlay = makeRailwayPart({
      id: 'way/1102-0',
      sourceFeatureId: 'way/1102',
      points: [
        [0, 0],
        [100, 0],
      ],
      rawOsmNodeIds: ['11', '12'],
      gauge: '1000',
    });

    const res = buildRailwayNetwork([basePart, exactReversedDuplicate, dualGaugeOverlay]);
    assert.equal(res.diagnostics.exactDeduplicatedCount, 1);
    assert.equal(res.diagnostics.railwayEdgeCount, 2);
    assert.equal(res.diagnostics.railwayParallelEdgePairCount, 1);
  });

  it('guarantees feature-order determinism and strict input immutability', () => {
    const parts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/1200-0',
        points: [
          [-100, 0],
          [0, 0],
        ],
        rawOsmNodeIds: ['1201', '1202'],
      }),
      makeRailwayPart({
        id: 'way/1201-0',
        points: [
          [0, 0],
          [100, 0],
        ],
        rawOsmNodeIds: ['1202', '1203'],
      }),
      makeRailwayPart({
        id: 'way/1202-0',
        points: [
          [0, 0],
          [100, -15],
        ],
        rawOsmNodeIds: ['1202', '1204'],
        service: 'siding',
      }),
      makeRailwayPart({
        id: 'way/1203-0',
        points: [
          [50, -50],
          [50, 0],
          [50, 50],
        ],
        rawOsmNodeIds: ['1205', '1206', '1207'],
      }),
      makeRailwayPart({
        id: 'way/1204-0',
        points: [
          [10, 0],
          [50, 0],
          [90, 0],
        ],
        rawOsmNodeIds: ['1208', '1206', '1209'],
      }),
    ];

    const points: InfrastructurePointMetadata[] = [
      {
        id: 'node/1202',
        hasExplicitSourceId: true,
        rawOsmNodeId: '1202',
        point: [0, 0],
        kind: 'railway_switch',
        osmTags: { railway: 'switch' },
      },
      {
        id: 'node/1206',
        hasExplicitSourceId: true,
        rawOsmNodeId: '1206',
        point: [50, 0],
        kind: 'railway_crossing_flat',
        osmTags: { railway: 'railway_crossing' },
      },
    ];

    const snapshotBefore = JSON.stringify({ parts, points });
    const resForward = buildRailwayNetwork(parts, points);
    const resReversed = buildRailwayNetwork([...parts].reverse(), [...points].reverse());
    const snapshotAfter = JSON.stringify({ parts, points });

    assert.equal(snapshotAfter, snapshotBefore, 'Caller inputs must not be mutated');
    assert.deepEqual(serializeRailwayResult(resReversed), serializeRailwayResult(resForward));
  });

  it('preserves mapData.railways and rendered 3D railway geometry byte-for-byte before and after Stage C topology enrichment', () => {
    const provider = new LocalGeoJsonProvider();
    const rawGeoJson: any = {
      type: 'FeatureCollection',
      name: 'Station Hengelo',
      features: JSON.parse(JSON.stringify(realOsmExtracts.regions.hengelo.features)),
    };
    const enrichedGeoJson: any = {
      type: 'FeatureCollection',
      name: 'Station Hengelo',
      features: JSON.parse(JSON.stringify(realOsmExtracts.regions.hengelo.features)),
    };

    let nodeCounter = 500000;
    for (const feat of enrichedGeoJson.features) {
      if (feat.geometry?.type === 'LineString' && Array.isArray(feat.geometry.coordinates)) {
        feat.properties = {
          ...(feat.properties || {}),
          _nodeIds: feat.geometry.coordinates.map(() => String(++nodeCounter)),
        };
      }
    }

    const mapDataPre = provider.parseGeoJson(rawGeoJson);
    const mapDataPost = provider.parseGeoJson(enrichedGeoJson);

    // 1. Renderer-facing mapData.railways and diagnostics must be 100% identical
    assert.deepEqual(mapDataPost.railways, mapDataPre.railways);
    assert.deepEqual(mapDataPost.diagnostics, mapDataPre.diagnostics);

    // 2. topologySource.railwayParts and infrastructurePoints must share zero mutable references with mapData.railways
    assert.ok(mapDataPost.topologySource!.railwayParts.length > 0);
    assert.ok(mapDataPost.topologySource!.infrastructurePoints.length > 0);
    assert.notEqual(
      mapDataPost.topologySource!.railwayParts[0].points,
      mapDataPost.railways[0].points
    );
    assert.notEqual(
      mapDataPost.topologySource!.railwayParts[0].osmTags,
      mapDataPost.railways[0].osmTags
    );

    // 3. Build 3D scenes and verify identical railway meshes and buffer geometry attributes
    const scenePre = new GeometryBuilder().buildScene(mapDataPre, MAP_THEMES.tactical);
    const scenePost = new GeometryBuilder().buildScene(mapDataPost, MAP_THEMES.tactical);

    assertSceneGroupBuffersEqual(
      scenePre.railwaysGroup,
      scenePost.railwaysGroup,
      'HengeloRailwaysGroup'
    );

    scenePre.dispose();
    scenePost.dispose();
  });

  it('validates real OSM railway extracts (Hengelo & Amsterdam Centraal) and reports parser vs. railway-graph build performance', () => {
    const provider = new LocalGeoJsonProvider();

    const hengeloFc: any = {
      type: 'FeatureCollection',
      name: 'Station Hengelo',
      features: realOsmExtracts.regions.hengelo.features,
    };
    const amsterdamFc: any = {
      type: 'FeatureCollection',
      name: 'Amsterdam Centraal',
      features: realOsmExtracts.regions.amsterdamCentraal.features,
    };

    const t0HengeloParse = performance.now();
    const hengeloData = provider.parseGeoJson(hengeloFc);
    const hengeloParseMs = performance.now() - t0HengeloParse;

    const t0HengeloGraph = performance.now();
    const hengeloGraph = buildRailwayNetwork(hengeloData);
    const hengeloGraphMs = performance.now() - t0HengeloGraph;

    const t0AmsterdamParse = performance.now();
    const amsterdamData = provider.parseGeoJson(amsterdamFc);
    const amsterdamParseMs = performance.now() - t0AmsterdamParse;

    const t0AmsterdamGraph = performance.now();
    const amsterdamGraph = buildRailwayNetwork(amsterdamData);
    const amsterdamGraphMs = performance.now() - t0AmsterdamGraph;

    // Verify Hengelo real extract metrics: 67 clipped railway parts, 30 switch points + 3 flat crossing points (+ 1 level_crossing in Stage D)
    assert.equal(hengeloData.topologySource?.railwayParts.length, 67);
    assert.equal(hengeloData.topologySource?.railwayParts.length, hengeloData.railways.length);
    assert.equal(
      hengeloData.topologySource?.infrastructurePoints.filter(
        (pt) => pt.kind === 'railway_switch' || pt.kind === 'railway_crossing_flat'
      ).length,
      33
    );
    assert.equal(hengeloData.topologySource?.infrastructurePoints.length, 34);
    assert.ok(hengeloGraph.diagnostics.railwayConfirmedSwitchCount >= 20);
    assert.equal(hengeloGraph.diagnostics.railwayFlatCrossingCount, 3);

    // Verify Amsterdam Centraal real extract metrics: 325 clipped in-bounds railway parts, 104 switch points + 15 flat crossing points (+ 2 railway=crossing + 19 highway=crossing in Stage D)
    // (13 single-scope diamond crossings resolved; node/5017068574 spans a bridge/at-grade scope boundary and node/5319252866 has only 1 surviving track)
    assert.equal(amsterdamData.topologySource?.railwayParts.length, 325);
    assert.equal(amsterdamData.topologySource?.railwayParts.length, amsterdamData.railways.length);
    assert.equal(
      amsterdamData.topologySource?.infrastructurePoints.filter(
        (pt) => pt.kind === 'railway_switch' || pt.kind === 'railway_crossing_flat'
      ).length,
      119
    );
    assert.equal(amsterdamData.topologySource?.infrastructurePoints.length, 140);
    assert.ok(amsterdamGraph.diagnostics.railwayConfirmedSwitchCount >= 75);
    assert.equal(amsterdamGraph.diagnostics.railwayFlatCrossingCount, 13);

    // Verify that Amsterdam Centraal's shallow 9.00-deg crossover diamond (node/5319252871) and wide diamond (node/3175850142) are resolved and decoupled
    const acShallowCrossing = amsterdamGraph.railwayFlatCrossings.find(
      (fc) => fc.rawOsmNodeId === '5319252871'
    );
    const acWideCrossing = amsterdamGraph.railwayFlatCrossings.find(
      (fc) => fc.rawOsmNodeId === '3175850142'
    );
    assert.ok(
      acShallowCrossing && acWideCrossing,
      'Expected Amsterdam Centraal diamond crossings node/5319252871 and node/3175850142 to be resolved'
    );

    // Synthetic 65-way railway yard benchmark (16 parallel main/yard tracks + 48 ladder turnouts + 1 crossing track)
    const syntheticFeatures: any[] = [];
    for (let t = 0; t < 16; t++) {
      const latOffset = t * 0.00004;
      syntheticFeatures.push({
        type: 'Feature',
        id: `way/syn_main_${t}`,
        properties: {
          id: `way/syn_main_${t}`,
          railway: 'rail',
          ...(t >= 4 ? { service: 'yard' } : {}),
          _nodeIds: [`syn_n_${t}_0`, `syn_n_${t}_1`, `syn_n_${t}_2`, `syn_n_${t}_3`],
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.896, 52.378 + latOffset],
            [4.899, 52.378 + latOffset],
            [4.901, 52.378 + latOffset],
            [4.904, 52.378 + latOffset],
          ],
        },
      });
      if (t < 15) {
        syntheticFeatures.push(
          {
            type: 'Feature',
            id: `way/syn_turnout_left_${t}`,
            properties: {
              id: `way/syn_turnout_left_${t}`,
              railway: 'rail',
              service: 'spur',
              _nodeIds: [`syn_n_${t}_1`, `syn_n_${t + 1}_L`],
            },
            geometry: {
              type: 'LineString',
              coordinates: [
                [4.899, 52.378 + t * 0.00004],
                [4.8996, 52.378 + (t + 1) * 0.00004],
              ],
            },
          },
          {
            type: 'Feature',
            id: `way/syn_turnout_right_${t}`,
            properties: {
              id: `way/syn_turnout_right_${t}`,
              railway: 'rail',
              service: 'spur',
              _nodeIds: [`syn_n_${t}_2`, `syn_n_${t + 1}_R`],
            },
            geometry: {
              type: 'LineString',
              coordinates: [
                [4.901, 52.378 + t * 0.00004],
                [4.9016, 52.378 + (t + 1) * 0.00004],
              ],
            },
          }
        );
      }
    }
    syntheticFeatures.push({
      type: 'Feature',
      id: 'way/syn_diag_65',
      properties: {
        id: 'way/syn_diag_65',
        railway: 'rail',
        service: 'crossover',
        _nodeIds: ['syn_n_0_1', 'syn_n_1_2'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [4.899, 52.378],
          [4.901, 52.378 + 0.00004],
        ],
      },
    });
    const syntheticFc: any = {
      type: 'FeatureCollection',
      name: 'Synthetic 65-Way Switchyard',
      features: syntheticFeatures,
    };
    const t0SynParse = performance.now();
    const synData = provider.parseGeoJson(syntheticFc);
    const synParseMs = performance.now() - t0SynParse;
    const t0SynGraph = performance.now();
    const synGraph = buildRailwayNetwork(synData);
    const synGraphMs = performance.now() - t0SynGraph;

    assert.ok(synGraphMs < 100, `Synthetic yard graph build too slow: ${synGraphMs.toFixed(2)}ms`);
    assert.ok(hengeloGraphMs < 200, `Hengelo graph build too slow: ${hengeloGraphMs.toFixed(2)}ms`);
    assert.ok(
      amsterdamGraphMs < 500,
      `Amsterdam Centraal graph build too slow: ${amsterdamGraphMs.toFixed(2)}ms`
    );

    console.log(
      `[M2.3-C Benchmark] Synthetic Yard: parse=${synParseMs.toFixed(2)}ms, railGraph=${synGraphMs.toFixed(2)}ms ` +
        `(parts=${synGraph.diagnostics.inputPartCount}, nodes=${synGraph.diagnostics.railwayNodeCount}, ` +
        `edges=${synGraph.diagnostics.railwayEdgeCount}, switches=${synGraph.diagnostics.railwayConfirmedSwitchCount} confirmed)`
    );
    console.log(
      `[M2.3-C Benchmark] Hengelo: parse=${hengeloParseMs.toFixed(2)}ms, railGraph=${hengeloGraphMs.toFixed(2)}ms ` +
        `(parts=${hengeloGraph.diagnostics.inputPartCount}, nodes=${hengeloGraph.diagnostics.railwayNodeCount}, ` +
        `edges=${hengeloGraph.diagnostics.railwayEdgeCount}, switches=${hengeloGraph.diagnostics.railwayConfirmedSwitchCount} confirmed / ` +
        `${hengeloGraph.diagnostics.railwayUnresolvedSwitchCount} unresolved, flatCrossings=${hengeloGraph.diagnostics.railwayFlatCrossingCount})`
    );
    console.log(
      `[M2.3-C Benchmark] Amsterdam Centraal: parse=${amsterdamParseMs.toFixed(2)}ms, railGraph=${amsterdamGraphMs.toFixed(2)}ms ` +
        `(parts=${amsterdamGraph.diagnostics.inputPartCount}, nodes=${amsterdamGraph.diagnostics.railwayNodeCount}, ` +
        `edges=${amsterdamGraph.diagnostics.railwayEdgeCount}, switches=${amsterdamGraph.diagnostics.railwayConfirmedSwitchCount} confirmed / ` +
        `${amsterdamGraph.diagnostics.railwayUnresolvedSwitchCount} unresolved, flatCrossings=${amsterdamGraph.diagnostics.railwayFlatCrossingCount})`
    );
  });

  it('completes unresolved 4-arm railway crossing diagnostics across 2-interior, 1-interior+2-endpoint, and 4-endpoint arrangements (tagged and untagged)', () => {
    // 1. Case A (2 interior occurrences) — untagged coordinate-fallback interior meeting
    const caseACoordFallbackParts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/ca_fb_1-0',
        sourceFeatureId: 'way/ca_fb_1',
        points: [
          [-60, 0],
          [0, 0],
          [60, 0],
        ],
        rawOsmNodeIds: [undefined, undefined, undefined],
      }),
      makeRailwayPart({
        id: 'way/ca_fb_2-0',
        sourceFeatureId: 'way/ca_fb_2',
        points: [
          [0, -60],
          [0, 0],
          [0, 60],
        ],
        rawOsmNodeIds: [undefined, undefined, undefined],
      }),
    ];
    const resCaseAFb = buildRailwayNetwork(caseACoordFallbackParts);
    assert.equal(resCaseAFb.diagnostics.railwayFlatCrossingCount, 0);
    assert.equal(resCaseAFb.diagnostics.railwayConfirmedSwitchCount, 0);
    assert.equal(resCaseAFb.diagnostics.railwayUnresolvedSwitchCount, 0);
    assert.equal(resCaseAFb.diagnostics.railwayUnresolvedJunctionCount, 1);
    assert.equal(resCaseAFb.diagnostics.unresolvedCrossings.length, 1);
    assert.equal(
      resCaseAFb.diagnostics.unresolvedCrossings[0].reason,
      'coincident_vertex_without_osm_id'
    );
    const fbCenterNode = [...resCaseAFb.railways.nodes.values()].find((n) => n.degree === 4)!;
    assert.ok(fbCenterNode);
    assert.equal(fbCenterNode.primaryRole, 'junction');
    assert.deepEqual(fbCenterNode.roles, ['junction']);
    assert.equal(fbCenterNode.turnoutTopology, undefined);

    // 2. Case A (2 interior occurrences) — tagged railway=railway_crossing where one way bends 90 deg at the node (ambiguous track pairing)
    const caseATaggedKinkParts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/ca_kink_1-0',
        sourceFeatureId: 'way/ca_kink_1',
        points: [
          [-60, 0],
          [0, 0],
          [60, 0],
        ],
        rawOsmNodeIds: ['6101', '6100', '6102'],
      }),
      makeRailwayPart({
        id: 'way/ca_kink_2-0',
        sourceFeatureId: 'way/ca_kink_2',
        points: [
          [0, -60],
          [0, 0],
          [40, -50],
        ],
        rawOsmNodeIds: ['6103', '6100', '6104'],
      }),
    ];
    const resCaseATaggedKink = buildRailwayNetwork(caseATaggedKinkParts, [
      {
        id: 'node/6100',
        hasExplicitSourceId: true,
        rawOsmNodeId: '6100',
        point: [0, 0],
        kind: 'railway_crossing_flat',
        osmTags: { railway: 'railway_crossing' },
      },
    ]);
    assert.equal(resCaseATaggedKink.diagnostics.railwayFlatCrossingCount, 0);
    assert.equal(resCaseATaggedKink.diagnostics.railwayConfirmedSwitchCount, 0);
    assert.equal(resCaseATaggedKink.diagnostics.railwayUnresolvedJunctionCount, 1);
    assert.equal(resCaseATaggedKink.diagnostics.unresolvedCrossings.length, 1);
    assert.equal(
      resCaseATaggedKink.diagnostics.unresolvedCrossings[0].reason,
      'ambiguous_railway_crossing_track_pairing'
    );
    const kinkNode = resCaseATaggedKink.railways.nodes.get('rail_node:0|0|0:osm_6100')!;
    assert.ok(kinkNode);
    assert.equal(kinkNode.degree, 4);
    assert.equal(kinkNode.primaryRole, 'junction');
    assert.deepEqual(kinkNode.roles, ['junction']);
    assert.equal(kinkNode.turnoutTopology, undefined);

    // 3. Case B (1 interior-through-way + 2 terminating way endpoints) — confirmed when tagged & collinear, unresolved when untagged or non-collinear
    const caseBCollinearParts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/cb_thru-0',
        sourceFeatureId: 'way/cb_thru',
        points: [
          [-60, 0],
          [0, 0],
          [60, 0],
        ],
        rawOsmNodeIds: ['6201', '6200', '6202'],
      }),
      makeRailwayPart({
        id: 'way/cb_end1-0',
        sourceFeatureId: 'way/cb_end1',
        points: [
          [0, -50],
          [0, 0],
        ],
        rawOsmNodeIds: ['6203', '6200'],
      }),
      makeRailwayPart({
        id: 'way/cb_end2-0',
        sourceFeatureId: 'way/cb_end2',
        points: [
          [0, 0],
          [0, 50],
        ],
        rawOsmNodeIds: ['6200', '6204'],
      }),
    ];

    // 3a. Case B untagged -> unresolved with missing_railway_crossing_tag_at_degree_4_node
    const resCaseBUntagged = buildRailwayNetwork(caseBCollinearParts);
    assert.equal(resCaseBUntagged.diagnostics.railwayFlatCrossingCount, 0);
    assert.equal(resCaseBUntagged.diagnostics.railwayConfirmedSwitchCount, 0);
    assert.equal(resCaseBUntagged.diagnostics.railwayUnresolvedJunctionCount, 1);
    assert.equal(resCaseBUntagged.diagnostics.unresolvedCrossings.length, 1);
    assert.equal(
      resCaseBUntagged.diagnostics.unresolvedCrossings[0].reason,
      'missing_railway_crossing_tag_at_degree_4_node'
    );
    const cbUntaggedNode = resCaseBUntagged.railways.nodes.get('rail_node:0|0|0:osm_6200')!;
    assert.equal(cbUntaggedNode.degree, 4);
    assert.equal(cbUntaggedNode.primaryRole, 'junction');
    assert.deepEqual(cbUntaggedNode.roles, ['junction']);

    // 3b. Case B tagged & collinear -> confirmed flat diamond crossing with non-interconnecting tracks
    const resCaseBConfirmed = buildRailwayNetwork(caseBCollinearParts, [
      {
        id: 'node/6200',
        hasExplicitSourceId: true,
        rawOsmNodeId: '6200',
        point: [0, 0],
        kind: 'railway_crossing_flat',
        osmTags: { railway: 'railway_crossing' },
      },
    ]);
    assert.equal(resCaseBConfirmed.diagnostics.railwayFlatCrossingCount, 1);
    assert.equal(resCaseBConfirmed.diagnostics.railwayUnresolvedJunctionCount, 0);
    assert.equal(resCaseBConfirmed.diagnostics.unresolvedCrossings.length, 0);
    const cbFc = resCaseBConfirmed.railwayFlatCrossings[0];
    assert.equal(
      areEdgesConnectedInGraph(resCaseBConfirmed, cbFc.trackAEdgeId, cbFc.trackBEdgeId),
      false
    );

    // 3c. Case B tagged, but terminating endpoints are non-collinear (ambiguous_railway_crossing_track_pairing)
    const caseBNonCollinearParts: UnchainedRailwayPart[] = [
      caseBCollinearParts[0],
      caseBCollinearParts[1],
      makeRailwayPart({
        id: 'way/cb_end2_bent-0',
        sourceFeatureId: 'way/cb_end2_bent',
        points: [
          [0, 0],
          [40, 30],
        ],
        rawOsmNodeIds: ['6200', '6204'],
      }),
    ];
    const resCaseBAmbiguous = buildRailwayNetwork(caseBNonCollinearParts, [
      {
        id: 'node/6200',
        hasExplicitSourceId: true,
        rawOsmNodeId: '6200',
        point: [0, 0],
        kind: 'railway_crossing_flat',
        osmTags: { railway: 'railway_crossing' },
      },
    ]);
    assert.equal(resCaseBAmbiguous.diagnostics.railwayFlatCrossingCount, 0);
    assert.equal(resCaseBAmbiguous.diagnostics.railwayConfirmedSwitchCount, 0);
    assert.equal(resCaseBAmbiguous.diagnostics.railwayUnresolvedJunctionCount, 1);
    assert.equal(resCaseBAmbiguous.diagnostics.unresolvedCrossings.length, 1);
    assert.equal(
      resCaseBAmbiguous.diagnostics.unresolvedCrossings[0].reason,
      'ambiguous_railway_crossing_track_pairing'
    );
    const cbAmbigNode = resCaseBAmbiguous.railways.nodes.get('rail_node:0|0|0:osm_6200')!;
    assert.equal(cbAmbigNode.degree, 4);
    assert.equal(cbAmbigNode.primaryRole, 'junction');
    assert.deepEqual(cbAmbigNode.roles, ['junction']);

    // 4. Case C (4 terminating way endpoints) — tagged railway=railway_crossing with ambiguous track pairing
    // 4a. Zero valid collinear partitions (4-arm fan)
    const caseCFanParts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/cc_fan_1-0',
        points: [
          [-60, 0],
          [0, 0],
        ],
        rawOsmNodeIds: ['6301', '6300'],
      }),
      makeRailwayPart({
        id: 'way/cc_fan_2-0',
        points: [
          [0, 0],
          [60, -40],
        ],
        rawOsmNodeIds: ['6300', '6302'],
      }),
      makeRailwayPart({
        id: 'way/cc_fan_3-0',
        points: [
          [0, 0],
          [60, 0],
        ],
        rawOsmNodeIds: ['6300', '6303'],
      }),
      makeRailwayPart({
        id: 'way/cc_fan_4-0',
        points: [
          [0, 0],
          [60, 40],
        ],
        rawOsmNodeIds: ['6300', '6304'],
      }),
    ];
    const resCaseCFan = buildRailwayNetwork(caseCFanParts, [
      {
        id: 'node/6300',
        hasExplicitSourceId: true,
        rawOsmNodeId: '6300',
        point: [0, 0],
        kind: 'railway_crossing_flat',
        osmTags: { railway: 'railway_crossing' },
      },
    ]);
    assert.equal(resCaseCFan.diagnostics.railwayFlatCrossingCount, 0);
    assert.equal(resCaseCFan.diagnostics.railwayConfirmedSwitchCount, 0);
    assert.equal(resCaseCFan.diagnostics.railwayUnresolvedJunctionCount, 1);
    assert.equal(resCaseCFan.diagnostics.unresolvedCrossings.length, 1);
    assert.equal(
      resCaseCFan.diagnostics.unresolvedCrossings[0].reason,
      'ambiguous_railway_crossing_track_pairing'
    );
    const ccFanNode = resCaseCFan.railways.nodes.get('rail_node:0|0|0:osm_6300')!;
    assert.equal(ccFanNode.degree, 4);
    assert.equal(ccFanNode.primaryRole, 'junction');
    assert.deepEqual(ccFanNode.roles, ['junction']);

    // 4b. Multiple competing collinear partitions (4 endpoints in a narrow 6-deg bundle: 0, 6, 180, 186 deg)
    const rad6 = (6 * Math.PI) / 180;
    const caseCBundleParts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/cc_bun_1-0',
        points: [
          [-60, 0],
          [0, 0],
        ],
        rawOsmNodeIds: ['6401', '6400'],
      }),
      makeRailwayPart({
        id: 'way/cc_bun_2-0',
        points: [
          [-60 * Math.cos(rad6), -60 * Math.sin(rad6)],
          [0, 0],
        ],
        rawOsmNodeIds: ['6402', '6400'],
      }),
      makeRailwayPart({
        id: 'way/cc_bun_3-0',
        points: [
          [0, 0],
          [60, 0],
        ],
        rawOsmNodeIds: ['6400', '6403'],
      }),
      makeRailwayPart({
        id: 'way/cc_bun_4-0',
        points: [
          [0, 0],
          [60 * Math.cos(rad6), 60 * Math.sin(rad6)],
        ],
        rawOsmNodeIds: ['6400', '6404'],
      }),
    ];
    const resCaseCBundle = buildRailwayNetwork(caseCBundleParts, [
      {
        id: 'node/6400',
        hasExplicitSourceId: true,
        rawOsmNodeId: '6400',
        point: [0, 0],
        kind: 'railway_crossing_flat',
        osmTags: { railway: 'railway_crossing' },
      },
    ]);
    assert.equal(resCaseCBundle.diagnostics.railwayFlatCrossingCount, 0);
    assert.equal(resCaseCBundle.diagnostics.railwayUnresolvedJunctionCount, 1);
    assert.equal(resCaseCBundle.diagnostics.unresolvedCrossings.length, 1);
    assert.equal(
      resCaseCBundle.diagnostics.unresolvedCrossings[0].reason,
      'ambiguous_railway_crossing_track_pairing'
    );
  });

  it('enforces conservative railway=switch and railway=railway_crossing point matching (unique fallback, multiple nearby nodes, conflicting explicit IDs, and vertical-scope isolation)', () => {
    const baseTurnoutParts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/pm_1-0',
        points: [
          [-80, 0],
          [0, 0],
        ],
        rawOsmNodeIds: [undefined, undefined],
      }),
      makeRailwayPart({
        id: 'way/pm_2-0',
        points: [
          [0, 0],
          [80, 0],
        ],
        rawOsmNodeIds: [undefined, undefined],
      }),
      makeRailwayPart({
        id: 'way/pm_3-0',
        points: [
          [0, 0],
          [80, 15],
        ],
        rawOsmNodeIds: [undefined, undefined],
      }),
    ];

    // 1. Unique valid coordinate fallback within 0.15 m
    const uniqueFallbackRes = buildRailwayNetwork(baseTurnoutParts, [
      {
        id: 'pt_switch_fallback',
        hasExplicitSourceId: false,
        rawOsmNodeId: undefined,
        point: [0.06, -0.05], // ~0.078 m <= 0.15 m
        kind: 'railway_switch',
        osmTags: { railway: 'switch', ref: 'SW-42' },
      },
    ]);
    assert.equal(uniqueFallbackRes.diagnostics.unresolvedInfrastructurePoints.length, 0);
    assert.equal(uniqueFallbackRes.diagnostics.railwayConfirmedSwitchCount, 1);
    const matchedSwitchNode = [...uniqueFallbackRes.railways.nodes.values()].find(
      (n) => n.degree === 3
    )!;
    assert.deepEqual(matchedSwitchNode.pointOsmTags, { railway: 'switch', ref: 'SW-42' });

    // 2. Two equally plausible nearby railway nodes within 0.15 m -> neither matched (even if one is slightly closer)
    const twoNearbyTurnoutsParts: UnchainedRailwayPart[] = [
      // Turnout A at (-0.06, 0)
      makeRailwayPart({
        id: 'way/tA_1-0',
        points: [
          [-80, 0],
          [-0.06, 0],
        ],
        rawOsmNodeIds: ['7101', '7100'],
      }),
      makeRailwayPart({
        id: 'way/tA_2-0',
        points: [
          [-0.06, 0],
          [80, 0],
        ],
        rawOsmNodeIds: ['7100', '7102'],
      }),
      makeRailwayPart({
        id: 'way/tA_3-0',
        points: [
          [-0.06, 0],
          [80, 15],
        ],
        rawOsmNodeIds: ['7100', '7103'],
      }),
      // Turnout B at (+0.08, 0)
      makeRailwayPart({
        id: 'way/tB_1-0',
        points: [
          [-80, 5],
          [0.08, 0],
        ],
        rawOsmNodeIds: ['7201', '7200'],
      }),
      makeRailwayPart({
        id: 'way/tB_2-0',
        points: [
          [0.08, 0],
          [80, 5],
        ],
        rawOsmNodeIds: ['7200', '7202'],
      }),
      makeRailwayPart({
        id: 'way/tB_3-0',
        points: [
          [0.08, 0],
          [80, 20],
        ],
        rawOsmNodeIds: ['7200', '7203'],
      }),
    ];
    const twoNearbyRes = buildRailwayNetwork(twoNearbyTurnoutsParts, [
      {
        id: 'pt_ambiguous_switch',
        hasExplicitSourceId: false,
        rawOsmNodeId: undefined,
        point: [0, 0], // 0.06 m from 7100 and 0.08 m from 7200 (both <= 0.15 m)
        kind: 'railway_switch',
        osmTags: { railway: 'switch', ref: 'AMBIG' },
      },
    ]);
    assert.equal(twoNearbyRes.diagnostics.unresolvedInfrastructurePoints.length, 1);
    assert.equal(
      twoNearbyRes.diagnostics.unresolvedInfrastructurePoints[0].reason,
      'ambiguous_multiple_candidate_nodes'
    );
    assert.deepEqual(twoNearbyRes.diagnostics.unresolvedInfrastructurePoints[0].candidateNodeIds, [
      'rail_node:0|0|0:osm_7100',
      'rail_node:0|0|0:osm_7200',
    ]);
    assert.equal(
      twoNearbyRes.railways.nodes.get('rail_node:0|0|0:osm_7100')!.pointOsmTags,
      undefined
    );
    assert.equal(
      twoNearbyRes.railways.nodes.get('rail_node:0|0|0:osm_7200')!.pointOsmTags,
      undefined
    );

    // 3. Conflicting explicit OSM node IDs -> never matched by proximity
    const explicitTurnoutParts: UnchainedRailwayPart[] = [
      makeRailwayPart({
        id: 'way/exp_1-0',
        points: [
          [-80, 0],
          [0, 0],
        ],
        rawOsmNodeIds: ['8101', '8100'],
      }),
      makeRailwayPart({
        id: 'way/exp_2-0',
        points: [
          [0, 0],
          [80, 0],
        ],
        rawOsmNodeIds: ['8100', '8102'],
      }),
      makeRailwayPart({
        id: 'way/exp_3-0',
        points: [
          [0, 0],
          [80, 15],
        ],
        rawOsmNodeIds: ['8100', '8103'],
      }),
    ];
    const conflictIdRes = buildRailwayNetwork(explicitTurnoutParts, [
      {
        id: 'node/9999',
        hasExplicitSourceId: true,
        rawOsmNodeId: '9999', // conflicts with node 8100 at [0, 0]
        point: [0, 0],
        kind: 'railway_switch',
        osmTags: { railway: 'switch', ref: 'CONFLICT' },
      },
    ]);
    assert.equal(conflictIdRes.diagnostics.unresolvedInfrastructurePoints.length, 1);
    assert.equal(
      conflictIdRes.diagnostics.unresolvedInfrastructurePoints[0].reason,
      'conflicting_explicit_osm_node_id'
    );
    assert.equal(
      conflictIdRes.railways.nodes.get('rail_node:0|0|0:osm_8100')!.pointOsmTags,
      undefined
    );

    // 4. Nearby railway tracks on different vertical scopes (at-grade vs bridge vs tunnel)
    const multiScopeParts: UnchainedRailwayPart[] = [
      ...baseTurnoutParts, // at-grade (layer=0, isBridge=false) with turnout at [0, 0]
      makeRailwayPart({
        id: 'way/bridge_overpass-0',
        points: [
          [0, -60],
          [0, 0],
          [0, 60],
        ],
        rawOsmNodeIds: [undefined, undefined, undefined],
        layer: 1,
        isBridge: true,
      }),
    ];

    // 4a. Untagged point at [0, 0] where both at-grade turnout and bridge track pass within 0.15 m -> rejected
    const untaggedCrossScopeRes = buildRailwayNetwork(multiScopeParts, [
      {
        id: 'pt_untagged_multiscope',
        hasExplicitSourceId: false,
        rawOsmNodeId: undefined,
        point: [0, 0],
        kind: 'railway_switch',
        osmTags: { railway: 'switch', ref: 'UNSCOPED' },
      },
    ]);
    assert.equal(untaggedCrossScopeRes.diagnostics.unresolvedInfrastructurePoints.length, 1);
    assert.equal(
      untaggedCrossScopeRes.diagnostics.unresolvedInfrastructurePoints[0].reason,
      'vertical_scope_mismatch'
    );

    // 4b. Point explicitly tagged bridge=yes, layer=1 on at-grade-only turnout -> rejected
    const wrongExplicitScopeRes = buildRailwayNetwork(baseTurnoutParts, [
      {
        id: 'pt_bridge_only_tag',
        hasExplicitSourceId: false,
        rawOsmNodeId: undefined,
        point: [0, 0],
        kind: 'railway_switch',
        osmTags: { railway: 'switch', bridge: 'yes', layer: '1' },
      },
    ]);
    assert.equal(wrongExplicitScopeRes.diagnostics.unresolvedInfrastructurePoints.length, 1);
    assert.equal(
      wrongExplicitScopeRes.diagnostics.unresolvedInfrastructurePoints[0].reason,
      'vertical_scope_mismatch'
    );

    // 4c. Point explicitly tagged layer=0, bridge=no at [0, 0] in multiScopeParts -> matches ONLY the at-grade turnout node
    const scopedToAtGradeRes = buildRailwayNetwork(multiScopeParts, [
      {
        id: 'pt_scoped_at_grade',
        hasExplicitSourceId: false,
        rawOsmNodeId: undefined,
        point: [0, 0],
        kind: 'railway_switch',
        osmTags: { railway: 'switch', layer: '0', bridge: 'no', ref: 'AG-ONLY' },
      },
    ]);
    assert.equal(scopedToAtGradeRes.diagnostics.unresolvedInfrastructurePoints.length, 0);
    const agTurnoutNode = [...scopedToAtGradeRes.railways.nodes.values()].find(
      (n) => !n.isBridge && n.degree === 3
    )!;
    assert.equal(agTurnoutNode.pointOsmTags?.ref, 'AG-ONLY');
    for (const n of scopedToAtGradeRes.railways.nodes.values()) {
      if (n.isBridge) {
        assert.equal(n.pointOsmTags, undefined);
      }
    }
  });
});


