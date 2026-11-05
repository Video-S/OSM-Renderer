import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import osmtogeojson from 'osmtogeojson';
import { DOMParser } from 'xmldom';
import * as THREE from 'three';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { GeometryBuilder } from './GeometryBuilder';
import { MAP_THEMES } from '../styles/mapThemes';
import {
  buildRoadNetwork,
  enrichGeoJsonWithOverpassNodeIds,
  enrichGeoJsonWithOsmXmlNodeIds,
  COORD_ALIGNMENT_TOLERANCE_DEG,
  UnchainedRoadPart,
} from './infrastructure/topology/InfrastructureGraph';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Recursively verifies that two Three.js scene hierarchies have identical object structure,
 * transforms, render orders, inspectable feature provenance faceRanges, and byte-for-byte identical
 * buffer geometry attributes (positions, normals, UVs, indices) and instance matrices.
 */
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
    `Child count mismatch at ${contextPath} (pre=[${preObj.children.map((c) => c.name)}], post=[${postObj.children.map((c) => c.name)}])`
  );

  assert.deepEqual(preObj.position.toArray(), postObj.position.toArray(), `Position mismatch at ${contextPath}`);
  assert.deepEqual(preObj.rotation.toArray(), postObj.rotation.toArray(), `Rotation mismatch at ${contextPath}`);
  assert.deepEqual(preObj.scale.toArray(), postObj.scale.toArray(), `Scale mismatch at ${contextPath}`);
  assert.equal(preObj.renderOrder, postObj.renderOrder, `RenderOrder mismatch at ${contextPath}`);

  if (preObj.userData?.faceRanges || postObj.userData?.faceRanges) {
    assert.deepEqual(
      preObj.userData.faceRanges,
      postObj.userData.faceRanges,
      `userData.faceRanges provenance mismatch at ${contextPath}`
    );
  }

  if ('geometry' in preObj && 'geometry' in postObj) {
    const geoPre = (preObj as THREE.Mesh).geometry;
    const geoPost = (postObj as THREE.Mesh).geometry;
    if (geoPre && geoPost) {
      if (geoPre.index || geoPost.index) {
        assert.ok(geoPre.index && geoPost.index, `Index buffer presence mismatch at ${contextPath}`);
        assert.equal(geoPre.index.count, geoPost.index.count, `Index count mismatch at ${contextPath}`);
        assert.deepEqual(
          Array.from(geoPre.index.array),
          Array.from(geoPost.index.array),
          `Index buffer values mismatch at ${contextPath}`
        );
      }

      const attrKeysPre = Object.keys(geoPre.attributes).sort();
      const attrKeysPost = Object.keys(geoPost.attributes).sort();
      assert.deepEqual(attrKeysPre, attrKeysPost, `Attribute keys mismatch at ${contextPath}`);

      for (const attrName of attrKeysPre) {
        const attrPre = geoPre.attributes[attrName];
        const attrPost = geoPost.attributes[attrName];
        assert.equal(attrPre.count, attrPost.count, `Attribute ${attrName} count mismatch at ${contextPath}`);
        assert.equal(attrPre.itemSize, attrPost.itemSize, `Attribute ${attrName} itemSize mismatch at ${contextPath}`);
        assert.deepEqual(
          Array.from(attrPre.array),
          Array.from(attrPost.array),
          `Attribute ${attrName} buffer values mismatch at ${contextPath}`
        );
      }
    }
  }

  if ('instanceMatrix' in preObj && 'instanceMatrix' in postObj) {
    const instPre = preObj as THREE.InstancedMesh;
    const instPost = postObj as THREE.InstancedMesh;
    assert.equal(instPre.count, instPost.count, `Instance count mismatch at ${contextPath}`);
    assert.deepEqual(
      Array.from(instPre.instanceMatrix.array),
      Array.from(instPost.instanceMatrix.array),
      `Instance matrix buffer values mismatch at ${contextPath}`
    );
  }

  for (let i = 0; i < preObj.children.length; i++) {
    const childPre = preObj.children[i];
    const childPost = postObj.children[i];
    assertSceneGroupBuffersEqual(childPre, childPost, `${contextPath}/${childPre.name || i}`);
  }
}

function makeRoadPart(
  overrides: Partial<UnchainedRoadPart> & {
    id: string;
    sourceFeatureId: string;
    points: [number, number][];
    rawOsmNodeIds?: Array<string | number | undefined>;
    oneway?: string;
    lanes?: number;
    surface?: string;
  }
): UnchainedRoadPart {
  const baseTags: Record<string, any> = {
    id: overrides.sourceFeatureId,
    highway: overrides.roadClass ?? 'residential',
    ...(overrides.name ? { name: overrides.name } : {}),
    ...(overrides.oneway !== undefined ? { oneway: overrides.oneway } : {}),
    ...(overrides.lanes !== undefined ? { lanes: String(overrides.lanes) } : {}),
    ...(overrides.surface !== undefined ? { surface: overrides.surface } : {}),
    ...(overrides.osmTags ?? {}),
  };

  return {
    id: overrides.id,
    sourceFeatureId: overrides.sourceFeatureId,
    hasExplicitSourceId: overrides.hasExplicitSourceId ?? true,
    partIndex: overrides.partIndex ?? 0,
    name: overrides.name,
    points: overrides.points,
    rawOsmNodeIds: overrides.points.map((_, idx) =>
      overrides.rawOsmNodeIds && overrides.rawOsmNodeIds[idx] !== undefined
        ? String(overrides.rawOsmNodeIds[idx])
        : undefined
    ),
    clippedAtStart: overrides.clippedAtStart ?? false,
    clippedAtEnd: overrides.clippedAtEnd ?? false,
    roadClass: overrides.roadClass ?? 'residential',
    width: overrides.width ?? 6.0,
    isBridge: overrides.isBridge ?? false,
    isTunnel: overrides.isTunnel ?? false,
    isCulvert: overrides.isCulvert ?? false,
    layer: overrides.layer ?? 0,
    osmTags: baseTags,
  };
}

test('M2.3-B T-01: simplifies curved degree-2 chains while preserving interior vertices and reversed middle segment provenance', () => {
    // 3 contiguous residential parts (A -> B, C -> B reversed middle segment, C -> D) with curved interior vertices
    const part1 = makeRoadPart({
      id: 'way/101-0',
      sourceFeatureId: 'way/101',
      name: 'Curve Street',
      points: [
        [0, 0],
        [5, 2],
        [10, 0],
      ],
      rawOsmNodeIds: ['1', '2', '3'],
      osmTags: { id: 'way/101', highway: 'residential', name: 'Curve Street', surface: 'asphalt', maxspeed: '30' },
    });
    // Reversed middle segment: digitized from node 5 (20, 0) back to node 3 (10, 0) via interior curve point (15, -3)
    const part2Reversed = makeRoadPart({
      id: 'way/102-0',
      sourceFeatureId: 'way/102',
      name: 'Curve Street',
      points: [
        [20, 0],
        [15, -3],
        [10, 0],
      ],
      rawOsmNodeIds: ['5', '4', '3'],
      osmTags: { id: 'way/102', highway: 'residential', name: 'Curve Street', surface: 'asphalt', maxspeed: '50' },
    });
    const part3 = makeRoadPart({
      id: 'way/103-0',
      sourceFeatureId: 'way/103',
      name: 'Curve Street',
      points: [
        [20, 0],
        [25, 4],
        [30, 0],
      ],
      rawOsmNodeIds: ['5', '6', '7'],
      osmTags: { id: 'way/103', highway: 'residential', name: 'Curve Street', surface: 'asphalt' },
    });

    const { roads: network, diagnostics } = buildRoadNetwork([part1, part2Reversed, part3]);

    assert.equal(network.nodes.size, 2, 'Curved degree-2 chain must simplify to 2 terminal nodes');
    assert.equal(network.edges.size, 1, 'Curved degree-2 chain must simplify to 1 RoadEdge');
    assert.equal(diagnostics.roadSimplifiedDegree2Count, 2);

    const [edge] = [...network.edges.values()];
    assert.deepEqual(
      edge.points,
      [
        [0, 0],
        [5, 2],
        [10, 0],
        [15, -3],
        [20, 0],
        [25, 4],
        [30, 0],
      ],
      'Simplified edge must preserve all 7 ordered curve vertices without losing interior curvature'
    );
    assert.deepEqual(edge.vertexRawOsmNodeIds, ['1', '2', '3', '4', '5', '6', '7']);
    assert.deepEqual(edge.provenance.mergedPartIds, ['way/101-0', 'way/102-0', 'way/103-0']);
    assert.deepEqual(edge.provenance.sourceFeatureIds, ['way/101', 'way/102', 'way/103']);
    assert.equal(edge.provenance.segments.length, 3);

    const [seg0, seg1, seg2] = edge.provenance.segments;
    assert.equal(seg0.sourceFeatureId, 'way/101');
    assert.equal(seg0.reversedRelativeToSource, false);
    assert.equal(seg0.osmTags.maxspeed, '30');

    assert.equal(seg1.sourceFeatureId, 'way/102');
    assert.equal(
      seg1.reversedRelativeToSource,
      true,
      'Middle segment traversed opposite its original digitization must record reversedRelativeToSource: true'
    );
    assert.equal(seg1.osmTags.maxspeed, '50');
    assert.ok(seg1.startArcLength > seg0.startArcLength);
    assert.ok(Math.abs(seg1.startArcLength - seg0.endArcLength) < 1e-6);

    assert.equal(seg2.sourceFeatureId, 'way/103');
    assert.equal(seg2.reversedRelativeToSource, false);
    assert.ok(Math.abs(seg2.endArcLength - edge.lengthMeters) < 1e-6);
  });

test('M2.3-B T-02: distinguishes true T-junction nodes (degree 3) from ordinary interior curve vertices', () => {
    const mainWest = makeRoadPart({
      id: 'way/201-0',
      sourceFeatureId: 'way/201',
      name: 'Main Road',
      points: [
        [-20, 0],
        [-10, 3],
        [0, 0],
      ],
      rawOsmNodeIds: ['10', '11', '12'],
    });
    const mainEast = makeRoadPart({
      id: 'way/202-0',
      sourceFeatureId: 'way/202',
      name: 'Main Road',
      points: [
        [0, 0],
        [10, 3],
        [20, 0],
      ],
      rawOsmNodeIds: ['12', '13', '14'],
    });
    const stemSouth = makeRoadPart({
      id: 'way/203-0',
      sourceFeatureId: 'way/203',
      name: 'Side Street',
      points: [
        [0, 0],
        [0, -15],
      ],
      rawOsmNodeIds: ['12', '15'],
    });

    const { roads: network } = buildRoadNetwork([mainWest, mainEast, stemSouth]);

    assert.equal(network.edges.size, 3, 'T-junction must not simplify across the degree-3 node');
    assert.equal(
      network.nodes.size,
      4,
      'Only 3 dead-ends and 1 T-junction node should exist in RoadNetwork.nodes'
    );
    assert.equal(
      network.nodes.has('road_node:0|0|0:osm_11'),
      false,
      'Interior curve vertex 11 must not be a graph node'
    );
    assert.equal(
      network.nodes.has('road_node:0|0|0:osm_13'),
      false,
      'Interior curve vertex 13 must not be a graph node'
    );

    const junctionNode = network.nodes.get('road_node:0|0|0:osm_12');
    assert.ok(junctionNode, 'Shared T-junction node must exist');
    assert.equal(junctionNode.degree, 3);
    assert.deepEqual(junctionNode.roles, ['junction']);
    assert.equal(junctionNode.incidentEdgeIds.length, 3);
    assert.equal(junctionNode.incidentHalfEdges.length, 3);
  });

test('M2.3-B T-03: models a 4-way shared-node road intersection with degree 4 and 4 incident half-edges', () => {
    const north = makeRoadPart({
      id: 'way/301-0',
      sourceFeatureId: 'way/301',
      points: [
        [0, 20],
        [0, 0],
      ],
      rawOsmNodeIds: ['31', '30'],
    });
    const south = makeRoadPart({
      id: 'way/302-0',
      sourceFeatureId: 'way/302',
      points: [
        [0, 0],
        [0, -20],
      ],
      rawOsmNodeIds: ['30', '32'],
    });
    const west = makeRoadPart({
      id: 'way/303-0',
      sourceFeatureId: 'way/303',
      points: [
        [-20, 0],
        [0, 0],
      ],
      rawOsmNodeIds: ['33', '30'],
    });
    const east = makeRoadPart({
      id: 'way/304-0',
      sourceFeatureId: 'way/304',
      points: [
        [0, 0],
        [20, 0],
      ],
      rawOsmNodeIds: ['30', '34'],
    });

    const { roads: network } = buildRoadNetwork([north, south, west, east]);
    assert.equal(network.edges.size, 4);
    assert.equal(network.nodes.size, 5);

    const centerNode = network.nodes.get('road_node:0|0|0:osm_30');
    assert.ok(centerNode);
    assert.equal(centerNode.degree, 4);
    assert.deepEqual(centerNode.roles, ['junction']);
    assert.equal(centerNode.incidentEdgeIds.length, 4);
    assert.equal(centerNode.incidentHalfEdges.length, 4);
  });

test('M2.3-B T-04: does not create a junction node for unconnected 2D geometric crossings (same-grade unshared or bridge overpass)', () => {
    // Case A: Bridge overpass (layer=1, isBridge=true) crossing over ground road (layer=0)
    const groundRoad = makeRoadPart({
      id: 'way/401-0',
      sourceFeatureId: 'way/401',
      points: [
        [-25, 0],
        [25, 0],
      ],
      rawOsmNodeIds: ['41', '42'],
      layer: 0,
      isBridge: false,
    });
    const overpassRoad = makeRoadPart({
      id: 'way/402-0',
      sourceFeatureId: 'way/402',
      points: [
        [0, -25],
        [0, 25],
      ],
      rawOsmNodeIds: ['43', '44'],
      layer: 1,
      isBridge: true,
    });

    const resOverpass = buildRoadNetwork([groundRoad, overpassRoad]);
    assert.equal(resOverpass.roads.edges.size, 2);
    assert.equal(resOverpass.roads.nodes.size, 4);
    for (const node of resOverpass.roads.nodes.values()) {
      assert.equal(node.degree, 1, 'Overpass crossing must not create any shared junction node');
    }

    // Case B: Two same-grade ways whose segments geometrically cross at (0, 0) without a shared vertex
    const ewUnshared = makeRoadPart({
      id: 'way/403-0',
      sourceFeatureId: 'way/403',
      points: [
        [-25, 0],
        [25, 0],
      ],
      rawOsmNodeIds: ['45', '46'],
    });
    const nsUnshared = makeRoadPart({
      id: 'way/404-0',
      sourceFeatureId: 'way/404',
      points: [
        [0, -25],
        [0, 25],
      ],
      rawOsmNodeIds: ['47', '48'],
    });

    const resSameGrade = buildRoadNetwork([ewUnshared, nsUnshared]);
    assert.equal(resSameGrade.roads.edges.size, 2);
    assert.equal(resSameGrade.roads.nodes.size, 4);
    for (const node of resSameGrade.roads.nodes.values()) {
      assert.equal(
        node.degree,
        1,
        'Pure 2D segment intersection without shared OSM node or vertex must not synthesize a road junction'
      );
    }
  });

test('M2.3-B T-05: splits through-ways at interior OSM junctions (explicit node ID and 0.15m coordinate fallback) and marks cross-tier junctions', () => {
    // Through vehicular road with interior vertex at (0, 0)
    const throughRoad = makeRoadPart({
      id: 'way/501-0',
      sourceFeatureId: 'way/501',
      roadClass: 'primary',
      width: 9.0,
      points: [
        [-30, 0],
        [0, 0],
        [30, 0],
      ],
      rawOsmNodeIds: ['501', '502', '503'],
    });
    // Footway terminating at the interior node 502 of throughRoad
    const sideFootway = makeRoadPart({
      id: 'way/502-0',
      sourceFeatureId: 'way/502',
      roadClass: 'footway',
      width: 2.0,
      points: [
        [0, 0],
        [0, 20],
      ],
      rawOsmNodeIds: ['502', '504'],
    });

    const { roads: network, diagnostics } = buildRoadNetwork([throughRoad, sideFootway]);
    assert.equal(
      network.edges.size,
      3,
      'Through-road must split at interior vertex 502 into 2 primary edges + 1 footway edge'
    );
    assert.equal(diagnostics.roadInteriorSplitCount, 1);

    const sharedNode = network.nodes.get('road_node:0|0|0:osm_502');
    assert.ok(sharedNode);
    assert.equal(sharedNode.degree, 3);
    assert.equal(
      sharedNode.isCrossTier,
      true,
      'Primary (vehicular) + footway (path) must set isCrossTier: true'
    );
    assert.ok(sharedNode.roles.includes('junction'));
    assert.ok(sharedNode.roles.includes('cross_tier'));

    // Also verify 0.15m coordinate fallback when rawOsmNodeIds are absent
    const throughCoordOnly = makeRoadPart({
      id: 'way/511-0',
      sourceFeatureId: 'way/511',
      roadClass: 'residential',
      points: [
        [-20, 0],
        [0, 0],
        [20, 0],
      ],
    });
    const branchCoordOnly = makeRoadPart({
      id: 'way/512-0',
      sourceFeatureId: 'way/512',
      roadClass: 'service',
      points: [
        [0.08, -0.05], // within 0.15m of interior vertex [0, 0]
        [0, -15],
      ],
    });

    const coordSplitRes = buildRoadNetwork([throughCoordOnly, branchCoordOnly]);
    assert.equal(
      coordSplitRes.roads.edges.size,
      3,
      'Coordinate-only interior vertex within 0.15m of another way endpoint must split the through-way'
    );
    assert.equal(coordSplitRes.diagnostics.roadInteriorSplitCount, 1);
  });

test('M2.3-B T-06: preserves parallel multi-edges with deterministic parallelIndex across reversed input orders and qualifies anonymous feature determinism', () => {
    const northArc = makeRoadPart({
      id: 'way/601-0',
      sourceFeatureId: 'way/601',
      hasExplicitSourceId: true,
      points: [
        [0, 0],
        [10, 6],
        [20, 0],
      ],
      rawOsmNodeIds: ['61', '62', '63'],
    });
    const southArc = makeRoadPart({
      id: 'way/602-0',
      sourceFeatureId: 'way/602',
      hasExplicitSourceId: true,
      points: [
        [0, 0],
        [10, -6],
        [20, 0],
      ],
      rawOsmNodeIds: ['61', '64', '63'],
    });

    const forwardBuild = buildRoadNetwork([northArc, southArc]);
    const reverseBuild = buildRoadNetwork([southArc, northArc]);

    assert.equal(forwardBuild.roads.edges.size, 2);
    assert.equal(forwardBuild.diagnostics.roadParallelEdgePairCount, 1);
    assert.deepEqual(
      [...forwardBuild.roads.edges.keys()],
      [...reverseBuild.roads.edges.keys()],
      'Edge IDs and parallelIndex must be 100% identical regardless of input order when explicit IDs are present'
    );

    const edges = [...forwardBuild.roads.edges.values()];
    assert.equal(edges[0].parallelIndex, 0);
    assert.equal(edges[1].parallelIndex, 1);
    assert.equal(edges[0].provenance.primaryPartId, 'way/601-0');
    assert.equal(edges[1].provenance.primaryPartId, 'way/602-0');

    // Qualified determinism when source features lack explicit IDs (`hasExplicitSourceId: false`)
    const anonPartA = makeRoadPart({
      id: 'feat-1-0',
      sourceFeatureId: 'feat-1',
      hasExplicitSourceId: false,
      points: [
        [0, 0],
        [10, 0],
      ],
    });
    const anonRun1 = buildRoadNetwork([anonPartA]);
    const anonRun2 = buildRoadNetwork([anonPartA]);
    assert.deepEqual(
      [...anonRun1.roads.edges.keys()],
      [...anonRun2.roads.edges.keys()],
      'Fixed-order anonymous inputs must still produce deterministic IDs across repeated runs'
    );
  });

test('M2.3-B T-07: preserves P-loops (stem + self-loop) and isolated closed loops (loop_anchor) without dropping loop geometry', () => {
    // Case A: P-loop (stem way 701 from node 70 -> 71, plus closed loop way 702 from 71 -> 72 -> 73 -> 74 -> 71)
    const stem = makeRoadPart({
      id: 'way/701-0',
      sourceFeatureId: 'way/701',
      points: [
        [0, 0],
        [10, 0],
      ],
      rawOsmNodeIds: ['70', '71'],
    });
    const loop = makeRoadPart({
      id: 'way/702-0',
      sourceFeatureId: 'way/702',
      points: [
        [10, 0],
        [20, 8],
        [28, 0],
        [20, -8],
        [10, 0],
      ],
      rawOsmNodeIds: ['71', '72', '73', '74', '71'],
    });

    const pLoopRes = buildRoadNetwork([stem, loop]);
    assert.equal(
      pLoopRes.roads.edges.size,
      2,
      'P-loop must retain 1 stem edge and 1 closed-loop edge'
    );
    const apexNode = pLoopRes.roads.nodes.get('road_node:0|0|0:osm_71');
    assert.ok(apexNode);
    assert.equal(
      apexNode.degree,
      3,
      'P-loop apex node must have topological degree 3 (1 stem half-edge + 2 loop half-edges)'
    );
    assert.equal(apexNode.incidentHalfEdges.length, 3);
    assert.equal(
      apexNode.incidentEdgeIds.length,
      2,
      'incidentEdgeIds must be deduplicated to the 2 distinct RoadEdge IDs'
    );

    const loopEdge = [...pLoopRes.roads.edges.values()].find((e) => e.isClosedLoop);
    assert.ok(loopEdge, 'Closed loop edge must have isClosedLoop: true');
    assert.equal(loopEdge.fromNodeId, loopEdge.toNodeId);
    assert.equal(loopEdge.points.length, 5);

    // Case B: Isolated closed roundabout ring composed of 3 ways with no connecting stem
    const isolatedRingA = makeRoadPart({
      id: 'way/703-0',
      sourceFeatureId: 'way/703',
      points: [
        [50, 0],
        [60, 10],
      ],
      rawOsmNodeIds: ['83', '81'],
    });
    const isolatedRingB = makeRoadPart({
      id: 'way/704-0',
      sourceFeatureId: 'way/704',
      points: [
        [60, 10],
        [70, 0],
      ],
      rawOsmNodeIds: ['81', '82'],
    });
    const isolatedRingC = makeRoadPart({
      id: 'way/705-0',
      sourceFeatureId: 'way/705',
      points: [
        [70, 0],
        [60, -10],
        [50, 0],
      ],
      rawOsmNodeIds: ['82', '84', '83'],
    });

    const isolatedRes = buildRoadNetwork([isolatedRingA, isolatedRingB, isolatedRingC]);
    assert.equal(
      isolatedRes.roads.edges.size,
      1,
      'Isolated closed loop must contract to 1 closed loop edge without disappearing'
    );
    assert.equal(
      isolatedRes.roads.nodes.size,
      1,
      'Isolated closed loop must select 1 deterministic loop_anchor node'
    );

    const [anchorNode] = [...isolatedRes.roads.nodes.values()];
    assert.equal(
      anchorNode.id,
      'road_node:0|0|0:osm_81',
      'Smallest canonical degree-2 node ID (osm_81) must be chosen as loop_anchor'
    );
    assert.ok(anchorNode.roles.includes('loop_anchor'));
    assert.equal(anchorNode.degree, 2);
    assert.equal(anchorNode.incidentHalfEdges.length, 2);
    assert.equal(anchorNode.incidentEdgeIds.length, 1);
  });

test('M2.3-B T-08: blocks degree-2 simplification across road attribute breaks and one-way direction/mode discontinuities', () => {
    // 1. Width / roadClass / culvert / name break
    const segA = makeRoadPart({
      id: 'way/801-0',
      sourceFeatureId: 'way/801',
      name: 'Alpha Ave',
      roadClass: 'residential',
      width: 6.0,
      points: [
        [0, 0],
        [10, 0],
      ],
      rawOsmNodeIds: ['801', '802'],
    });
    const segBCulvert = makeRoadPart({
      id: 'way/802-0',
      sourceFeatureId: 'way/802',
      name: 'Alpha Ave',
      roadClass: 'residential',
      width: 6.0,
      isCulvert: true,
      points: [
        [10, 0],
        [20, 0],
      ],
      rawOsmNodeIds: ['802', '803'],
    });

    const culvertBreakRes = buildRoadNetwork([segA, segBCulvert]);
    assert.equal(culvertBreakRes.roads.edges.size, 2, 'isCulvert transition must block simplification');
    const breakNode = culvertBreakRes.roads.nodes.get('road_node:0|0|0:osm_802');
    assert.ok(breakNode);
    assert.deepEqual(breakNode.roles, ['attribute_break']);

    // Surface break: asphalt meeting paving_stones must block degree-2 simplification
    const segSurfaceAsphalt = makeRoadPart({
      id: 'way/805-0',
      sourceFeatureId: 'way/805',
      name: 'Pave Road',
      roadClass: 'tertiary',
      width: 6.0,
      surface: 'asphalt',
      points: [
        [0, 0],
        [10, 0],
      ],
      rawOsmNodeIds: ['805', '806'],
    });
    const segSurfacePaving = makeRoadPart({
      id: 'way/806-0',
      sourceFeatureId: 'way/806',
      name: 'Pave Road',
      roadClass: 'tertiary',
      width: 6.0,
      surface: 'paving_stones',
      points: [
        [10, 0],
        [20, 0],
      ],
      rawOsmNodeIds: ['806', '807'],
    });
    const surfaceBreakRes = buildRoadNetwork([segSurfaceAsphalt, segSurfacePaving]);
    assert.equal(surfaceBreakRes.roads.edges.size, 2, 'Surface transition must block simplification');
    const surfaceBreakNode = surfaceBreakRes.roads.nodes.get('road_node:0|0|0:osm_806');
    assert.ok(surfaceBreakNode);
    assert.deepEqual(surfaceBreakNode.roles, ['attribute_break']);
    assert.equal(surfaceBreakNode.primaryRole, 'attribute_break');

    // Case 1: Two compatible oneway=yes segments with continuous traffic flow (A -> B, B -> C)
    const onewayA = makeRoadPart({
      id: 'way/810-0',
      sourceFeatureId: 'way/810',
      oneway: 'yes',
      points: [
        [0, 0],
        [10, 0],
      ],
      rawOsmNodeIds: ['810', '811'],
    });
    const onewayB = makeRoadPart({
      id: 'way/811-0',
      sourceFeatureId: 'way/811',
      oneway: 'yes',
      points: [
        [10, 0],
        [20, 0],
      ],
      rawOsmNodeIds: ['811', '812'],
    });
    const forwardMergeRes = buildRoadNetwork([onewayA, onewayB]);
    assert.equal(
      forwardMergeRes.roads.edges.size,
      1,
      'Two compatible oneway=yes segments with continuous flow must simplify into 1 edge'
    );
    const [mergedForward] = [...forwardMergeRes.roads.edges.values()];
    assert.equal(mergedForward.normalizedOneway, 'forward');
    assert.equal(mergedForward.rawOnewayTag, 'yes');
    assert.equal(mergedForward.points.length, 3);
    assert.equal(mergedForward.provenance.segments.length, 2);
    assert.equal(mergedForward.provenance.segments[0].reversedRelativeToSource, false);
    assert.equal(mergedForward.provenance.segments[1].reversedRelativeToSource, false);

    // Case 2: Two compatible oneway=-1 segments with continuous traffic flow
    // Way 1 digitized A -> B (traffic B -> A); Way 2 digitized B -> C (traffic C -> B).
    // Continuous traffic flow is C -> B -> A.
    const onewayRevA = makeRoadPart({
      id: 'way/820-0',
      sourceFeatureId: 'way/820',
      oneway: '-1',
      points: [
        [0, 0],
        [10, 0],
      ],
      rawOsmNodeIds: ['820', '821'],
    });
    const onewayRevB = makeRoadPart({
      id: 'way/821-0',
      sourceFeatureId: 'way/821',
      oneway: '-1',
      points: [
        [10, 0],
        [20, 0],
      ],
      rawOsmNodeIds: ['821', '822'],
    });
    const reverseMergeRes = buildRoadNetwork([onewayRevA, onewayRevB]);
    assert.equal(
      reverseMergeRes.roads.edges.size,
      1,
      'Two compatible oneway=-1 segments with continuous flow must simplify into 1 edge'
    );
    const [mergedReverse] = [...reverseMergeRes.roads.edges.values()];
    assert.equal(mergedReverse.normalizedOneway, 'reverse');
    assert.equal(mergedReverse.rawOnewayTag, '-1');
    assert.equal(mergedReverse.points.length, 3);
    assert.equal(mergedReverse.provenance.segments.length, 2);
    assert.equal(mergedReverse.provenance.segments[0].reversedRelativeToSource, false);
    assert.equal(mergedReverse.provenance.segments[1].reversedRelativeToSource, false);

    // Case 3: oneway=yes meeting oneway=-1: must NOT simplify (differs in rawOnewayTag per ADR-0009 Sec 4.3)
    const onewayYesMeetingRev = makeRoadPart({
      id: 'way/830-0',
      sourceFeatureId: 'way/830',
      oneway: 'yes',
      points: [
        [0, 0],
        [10, 0],
      ],
      rawOsmNodeIds: ['830', '831'],
    });
    const onewayRevMeetingYes = makeRoadPart({
      id: 'way/831-0',
      sourceFeatureId: 'way/831',
      oneway: '-1',
      points: [
        [20, 0],
        [10, 0],
      ],
      rawOsmNodeIds: ['832', '831'],
    });
    const yesMeetingRevRes = buildRoadNetwork([onewayYesMeetingRev, onewayRevMeetingYes]);
    assert.equal(
      yesMeetingRevRes.roads.edges.size,
      2,
      'oneway=yes meeting oneway=-1 must NOT simplify (differs in rawOnewayTag)'
    );
    const node831 = yesMeetingRevRes.roads.nodes.get('road_node:0|0|0:osm_831');
    assert.ok(node831?.roles.includes('attribute_break'));

    // Case 4: Omitted oneway meeting explicit oneway=no: must NOT simplify
    const omittedOneway = makeRoadPart({
      id: 'way/840-0',
      sourceFeatureId: 'way/840',
      points: [
        [0, 0],
        [10, 0],
      ],
      rawOsmNodeIds: ['840', '841'],
    });
    const explicitOnewayNo = makeRoadPart({
      id: 'way/841-0',
      sourceFeatureId: 'way/841',
      oneway: 'no',
      points: [
        [10, 0],
        [20, 0],
      ],
      rawOsmNodeIds: ['841', '842'],
    });
    const omittedVsNoRes = buildRoadNetwork([omittedOneway, explicitOnewayNo]);
    assert.equal(
      omittedVsNoRes.roads.edges.size,
      2,
      'Omitted oneway meeting explicit oneway=no must NOT simplify (differs in rawOnewayTag)'
    );
    const node841 = omittedVsNoRes.roads.nodes.get('road_node:0|0|0:osm_841');
    assert.ok(node841?.roles.includes('attribute_break'));

    // Case 5: Opposing one-way traffic: must NOT simplify (head-to-head collision at node 851)
    const opposingEast = makeRoadPart({
      id: 'way/850-0',
      sourceFeatureId: 'way/850',
      oneway: 'yes',
      points: [
        [0, 0],
        [10, 0],
      ],
      rawOsmNodeIds: ['850', '851'],
    });
    const opposingWest = makeRoadPart({
      id: 'way/851-0',
      sourceFeatureId: 'way/851',
      oneway: 'yes',
      points: [
        [20, 0],
        [10, 0],
      ],
      rawOsmNodeIds: ['852', '851'],
    });
    const opposingRes = buildRoadNetwork([opposingEast, opposingWest]);
    assert.equal(
      opposingRes.roads.edges.size,
      2,
      'Opposing one-way traffic (both entering node 851) must NOT simplify'
    );
    const node851 = opposingRes.roads.nodes.get('road_node:0|0|0:osm_851');
    assert.ok(node851?.roles.includes('attribute_break'));

    // Case 6: Unknown/conditional one-way tags: retain original data and do NOT simplify
    const reversibleWay = makeRoadPart({
      id: 'way/860-0',
      sourceFeatureId: 'way/860',
      oneway: 'reversible',
      points: [
        [10, 0],
        [20, 0],
      ],
      rawOsmNodeIds: ['861', '862'],
    });
    const reversibleRes = buildRoadNetwork([onewayA, reversibleWay]);
    assert.equal(
      reversibleRes.roads.edges.size,
      2,
      'oneway=reversible must not merge with oneway=yes'
    );
    const revEdge = [...reversibleRes.roads.edges.values()].find(
      (e) => e.provenance.primaryPartId === 'way/860-0'
    );
    assert.equal(revEdge?.normalizedOneway, 'unknown');
    assert.equal(revEdge?.rawOnewayTag, 'reversible');
  });

test('M2.3-B preserves edge-level surface semantics: blocks degree-2 simplification for asphalt meeting paving stones and assigns attribute_break role', () => {
  // Two contiguous tertiary road segments meeting at shared degree-2 node 902
  const asphaltPart = makeRoadPart({
    id: 'way/901-0',
    sourceFeatureId: 'way/901',
    name: 'Kerkstraat',
    roadClass: 'tertiary',
    width: 6.0,
    surface: 'asphalt',
    points: [
      [0, 0],
      [10, 0],
    ],
    rawOsmNodeIds: ['901', '902'],
    osmTags: { id: 'way/901', highway: 'tertiary', name: 'Kerkstraat', surface: 'asphalt', maxspeed: '50' },
  });

  const pavingStonesPart = makeRoadPart({
    id: 'way/902-0',
    sourceFeatureId: 'way/902',
    name: 'Kerkstraat',
    roadClass: 'tertiary',
    width: 6.0,
    surface: 'paving_stones',
    points: [
      [10, 0],
      [20, 0],
    ],
    rawOsmNodeIds: ['902', '903'],
    osmTags: { id: 'way/902', highway: 'tertiary', name: 'Kerkstraat', surface: 'paving_stones', maxspeed: '30' },
  });

  const graph = buildRoadNetwork([asphaltPart, pavingStonesPart]);

  // Simplification must be blocked: 2 edges retained, 3 nodes retained
  assert.equal(
    graph.roads.edges.size,
    2,
    'Surface transition (asphalt -> paving_stones) must block degree-2 simplification'
  );
  assert.equal(
    graph.roads.nodes.size,
    3,
    'All 3 nodes (including degree-2 attribute break node) must be retained'
  );

  const breakNode = graph.roads.nodes.get('road_node:0|0|0:osm_902');
  assert.ok(breakNode, 'Shared degree-2 node 902 must be retained');
  assert.equal(breakNode.degree, 2);
  assert.equal(breakNode.primaryRole, 'attribute_break');
  assert.ok(breakNode.roles.includes('attribute_break'));

  // Verify edge-level surface semantics
  const edges = [...graph.roads.edges.values()];
  const edgeAsphalt = edges.find(
    (e) => e.fromNodeId === 'road_node:0|0|0:osm_901' && e.toNodeId === 'road_node:0|0|0:osm_902'
  );
  const edgePaving = edges.find(
    (e) => e.fromNodeId === 'road_node:0|0|0:osm_902' && e.toNodeId === 'road_node:0|0|0:osm_903'
  );
  assert.ok(edgeAsphalt);
  assert.ok(edgePaving);
  assert.equal(edgeAsphalt.surface, 'asphalt');
  assert.equal(edgePaving.surface, 'paving_stones');

  // Verify per-segment provenance retains original tags without loss
  assert.equal(edgeAsphalt.provenance.segments[0].osmTags.surface, 'asphalt');
  assert.equal(edgeAsphalt.provenance.segments[0].osmTags.maxspeed, '50');
  assert.equal(edgePaving.provenance.segments[0].osmTags.surface, 'paving_stones');
  assert.equal(edgePaving.provenance.segments[0].osmTags.maxspeed, '30');

  // In contrast: Two segments with identical surface ('asphalt') but differing unrelated tags (e.g. lit=yes vs lit=no, maxspeed=50 vs maxspeed=30)
  // must simplify into 1 edge, preserving per-segment provenance without triggering an automatic split
  const asphaltSegA = makeRoadPart({
    id: 'way/910-0',
    sourceFeatureId: 'way/910',
    name: 'Dorpsstraat',
    roadClass: 'residential',
    surface: 'asphalt',
    points: [
      [0, 0],
      [10, 0],
    ],
    rawOsmNodeIds: ['910', '911'],
    osmTags: { id: 'way/910', highway: 'residential', name: 'Dorpsstraat', surface: 'asphalt', lit: 'yes', maxspeed: '50' },
  });
  const asphaltSegB = makeRoadPart({
    id: 'way/911-0',
    sourceFeatureId: 'way/911',
    name: 'Dorpsstraat',
    roadClass: 'residential',
    surface: 'asphalt',
    points: [
      [10, 0],
      [20, 0],
    ],
    rawOsmNodeIds: ['911', '912'],
    osmTags: { id: 'way/911', highway: 'residential', name: 'Dorpsstraat', surface: 'asphalt', lit: 'no', maxspeed: '30' },
  });

  const mergedGraph = buildRoadNetwork([asphaltSegA, asphaltSegB]);
  assert.equal(mergedGraph.roads.edges.size, 1, 'Same surface with differing unrelated tags must simplify into 1 edge');
  const [mergedEdge] = [...mergedGraph.roads.edges.values()];
  assert.equal(mergedEdge.surface, 'asphalt');
  assert.equal(mergedEdge.provenance.segments.length, 2);
  assert.equal(mergedEdge.provenance.segments[0].osmTags.lit, 'yes');
  assert.equal(mergedEdge.provenance.segments[0].osmTags.maxspeed, '50');
  assert.equal(mergedEdge.provenance.segments[1].osmTags.lit, 'no');
  assert.equal(mergedEdge.provenance.segments[1].osmTags.maxspeed, '30');
});

test('M2.3-B T-09: enforces explicit OSM node ID precedence over 0.15m coordinate proximity and order-independent coordinate snapping', () => {
    // Two distinct explicit OSM nodes (901 and 902) at the exact same [0, 0] coordinate must NOT merge
    const wayA = makeRoadPart({
      id: 'way/901-0',
      sourceFeatureId: 'way/901',
      points: [
        [-10, 0],
        [0, 0],
      ],
      rawOsmNodeIds: ['900', '901'],
    });
    const wayB = makeRoadPart({
      id: 'way/902-0',
      sourceFeatureId: 'way/902',
      points: [
        [0, 0],
        [10, 0],
      ],
      rawOsmNodeIds: ['902', '903'],
    });

    const distinctExplicitRes = buildRoadNetwork([wayA, wayB]);
    assert.equal(
      distinctExplicitRes.roads.nodes.has('road_node:0|0|0:osm_901'),
      true,
      'Explicit node osm_901 must exist'
    );
    assert.equal(
      distinctExplicitRes.roads.nodes.has('road_node:0|0|0:osm_902'),
      true,
      'Explicit node osm_902 must remain separate from osm_901 despite identical [0,0] coordinates'
    );
    assert.equal(distinctExplicitRes.roads.nodes.get('road_node:0|0|0:osm_901')?.degree, 1);
    assert.equal(distinctExplicitRes.roads.nodes.get('road_node:0|0|0:osm_902')?.degree, 1);

    // Coordinate-only way endpoint within 0.15m of explicit node 901 must snap to osm_901 regardless of input order
    const coordWayNear901 = makeRoadPart({
      id: 'way/903-0',
      sourceFeatureId: 'way/903',
      name: 'Cross Alley',
      points: [
        [0.05, -0.05],
        [0, -15],
      ],
      rawOsmNodeIds: undefined,
    });

    const explicitFirst = buildRoadNetwork([wayA, coordWayNear901]);
    const coordFirst = buildRoadNetwork([coordWayNear901, wayA]);

    assert.equal(explicitFirst.roads.nodes.get('road_node:0|0|0:osm_901')?.degree, 2);
    assert.equal(
      coordFirst.roads.nodes.get('road_node:0|0|0:osm_901')?.degree,
      2,
      'Coordinate-only endpoint registered before explicit OSM node must canonicalize to osm_901'
    );
  });

test('M2.3-B T-10: isolates boundary-clipped endpoints from snapping while preserving explicit OSM node IDs on unclipped interior vertices', () => {
    const provider = new LocalGeoJsonProvider();
    // Two parallel ways spaced 0.08m apart (within 0.15m snap tolerance) that both exit the eastern clip boundary (+50m)
    const geojson = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'way/1001',
          properties: {
            id: 'way/1001',
            highway: 'residential',
            nodes: ['10010', '10011', '10012'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.9, 52.378],
              [4.9003, 52.378],
              [4.902, 52.378], // outside 50m clip box
            ],
          },
        },
        {
          type: 'Feature',
          id: 'way/1002',
          properties: {
            id: 'way/1002',
            highway: 'residential',
            nodes: ['10020', '10021', '10022'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.9, 52.3780007], // ~0.08m north
              [4.9003, 52.3780007],
              [4.902, 52.3780007], // outside 50m clip box
            ],
          },
        },
      ],
    };

    const mapData = provider.parseGeoJson(geojson, 'Boundary Clip Test', [4.9, 52.378], 50);
    assert.ok(mapData.topologySource);
    assert.equal(mapData.topologySource.roadParts.length, 2);

    const [p1] = mapData.topologySource.roadParts;
    assert.equal(p1.clippedAtStart, false);
    assert.equal(p1.clippedAtEnd, true);
    assert.equal(
      p1.rawOsmNodeIds[0],
      '10010',
      'Unclipped start vertex must keep explicit OSM node ID'
    );
    assert.equal(
      p1.rawOsmNodeIds[1],
      '10011',
      'Unclipped interior vertex must keep explicit OSM node ID'
    );
    assert.equal(
      p1.rawOsmNodeIds[2],
      undefined,
      'Synthetic boundary cut point must have undefined OSM node ID'
    );

    const { roads: network } = buildRoadNetwork(mapData.topologySource.roadParts);
    assert.equal(network.edges.size, 2);

    const clipNodes = [...network.nodes.values()].filter(
      (n) => n.nodeIdOrigin === 'boundary_clip'
    );
    assert.equal(
      clipNodes.length,
      2,
      'Two nearby boundary-clipped endpoints (~0.08m apart) must remain 2 distinct boundary_clip nodes and never snap together'
    );
    for (const cn of clipNodes) {
      assert.equal(cn.degree, 1);
      assert.ok(cn.roles.includes('boundary_clip'));
      assert.equal(cn.isBoundaryClipped, true);
    }
  });

test('M2.3-B T-16: retains distinct parallel geometries colliding under legacy heuristic hash while deduplicating <= 1mm exact duplicates', () => {
    const provider = new LocalGeoJsonProvider();
    // Construct two mirror S-curve roads between [0, 0] and [20, 0] with identical endpoints,
    // identical average midpoint [10, 0], and identical length, which collide under LocalGeoJsonProvider's seenRoadSegments!
    const geojson = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'way/1601',
          properties: { id: 'way/1601', highway: 'residential', nodes: ['1', '2', '3', '4'] },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.9, 52.378],
              [4.9001, 52.37803],
              [4.9003, 52.37797],
              [4.9004, 52.378],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'way/1602',
          properties: { id: 'way/1602', highway: 'residential', nodes: ['1', '5', '6', '4'] },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.9, 52.378],
              [4.9001, 52.37797],
              [4.9003, 52.37803],
              [4.9004, 52.378],
            ],
          },
        },
      ],
    };

    const mapData = provider.parseGeoJson(geojson, 'Heuristic Collision Test', [4.9002, 52.378]);
    assert.equal(
      mapData.roads.length,
      1,
      'Legacy renderer-facing mapData.roads collapses the mirror S-curves under seenRoadSegments'
    );
    assert.equal(
      mapData.topologySource?.roadParts.length,
      2,
      'topologySource.roadParts must capture both parts before seenRoadSegments'
    );

    const sCurveGraph = buildRoadNetwork(mapData.topologySource!.roadParts);
    assert.equal(
      sCurveGraph.roads.edges.size,
      2,
      'RoadNetworkBuilder must retain both distinct mirror S-curve geometries as parallel edges (parallelIndex 0 and 1)'
    );
    assert.equal(sCurveGraph.diagnostics.exactDeduplicatedCount, 0);

    // Now verify exact <= 1mm forward and reverse duplicate collapse
    const basePart = makeRoadPart({
      id: 'way/1610-0',
      sourceFeatureId: 'way/1610',
      points: [
        [0, 0],
        [10, 2],
        [20, 0],
      ],
      rawOsmNodeIds: ['10', '11', '12'],
    });
    const forwardSubMmDup = makeRoadPart({
      id: 'way/1611-0',
      sourceFeatureId: 'way/1611',
      points: [
        [0, 0],
        [10.0004, 2.0004], // within 1mm
        [20, 0],
      ],
      rawOsmNodeIds: ['10', '11', '12'],
    });
    const reverseBidirectionalDup = makeRoadPart({
      id: 'way/1612-0',
      sourceFeatureId: 'way/1612',
      points: [
        [20, 0],
        [9.9995, 1.9995], // within 1mm in reverse
        [0, 0],
      ],
      rawOsmNodeIds: ['12', '11', '10'],
    });
    const offset2CmNonDup = makeRoadPart({
      id: 'way/1613-0',
      sourceFeatureId: 'way/1613',
      points: [
        [0, 0],
        [10, 2.02], // 2cm > 1mm tolerance -> must NOT be deduplicated
        [20, 0],
      ],
      rawOsmNodeIds: ['10', '13', '12'],
    });

    const dupGraph = buildRoadNetwork([
      basePart,
      forwardSubMmDup,
      reverseBidirectionalDup,
      offset2CmNonDup,
    ]);
    assert.equal(dupGraph.roads.edges.size, 2, '1 canonical edge + 1 offset (2cm) parallel edge');
    assert.equal(dupGraph.diagnostics.exactDeduplicatedCount, 2);

    const canonicalEdge = [...dupGraph.roads.edges.values()].find(
      (e) => e.provenance.primaryPartId === 'way/1610-0'
    );
    assert.ok(canonicalEdge);
    assert.deepEqual(canonicalEdge.provenance.segments[0].deduplicatedFeatureIds, [
      'way/1611',
      'way/1612',
    ]);
    assert.deepEqual(canonicalEdge.provenance.sourceFeatureIds, [
      'way/1610',
      'way/1611',
      'way/1612',
    ]);

    // Semantic attribute preservation during duplicate detection:
    // Geometrically identical ways with differing surface, lane markings, or directional attributes must NOT collapse!
    const asphaltRoad = makeRoadPart({
      id: 'way/1620-0',
      sourceFeatureId: 'way/1620',
      points: [
        [30, 0],
        [40, 0],
      ],
      rawOsmNodeIds: ['20', '21'],
      surface: 'asphalt',
    });
    const pavingStonesRoad = makeRoadPart({
      id: 'way/1621-0',
      sourceFeatureId: 'way/1621',
      points: [
        [30, 0],
        [40, 0],
      ],
      rawOsmNodeIds: ['20', '21'],
      surface: 'paving_stones',
    });
    const surfaceDiffGraph = buildRoadNetwork([asphaltRoad, pavingStonesRoad]);
    assert.equal(
      surfaceDiffGraph.roads.edges.size,
      2,
      'Geometrically identical ways with differing surface must remain distinct edges'
    );
    assert.equal(surfaceDiffGraph.diagnostics.exactDeduplicatedCount, 0);

    const laneMarkedRoadA = makeRoadPart({
      id: 'way/1622-0',
      sourceFeatureId: 'way/1622',
      points: [
        [50, 0],
        [60, 0],
      ],
      rawOsmNodeIds: ['30', '31'],
      osmTags: { 'turn:lanes': 'left|through' },
    });
    const laneMarkedRoadB = makeRoadPart({
      id: 'way/1623-0',
      sourceFeatureId: 'way/1623',
      points: [
        [50, 0],
        [60, 0],
      ],
      rawOsmNodeIds: ['30', '31'],
      osmTags: { 'turn:lanes': 'through|right' },
    });
    const laneDiffGraph = buildRoadNetwork([laneMarkedRoadA, laneMarkedRoadB]);
    assert.equal(
      laneDiffGraph.roads.edges.size,
      2,
      'Geometrically identical ways with differing turn:lanes markings must remain distinct edges'
    );
    assert.equal(laneDiffGraph.diagnostics.exactDeduplicatedCount, 0);

    const directionalRoadA = makeRoadPart({
      id: 'way/1624-0',
      sourceFeatureId: 'way/1624',
      points: [
        [70, 0],
        [80, 0],
      ],
      rawOsmNodeIds: ['40', '41'],
      oneway: 'yes',
    });
    const directionalRoadB = makeRoadPart({
      id: 'way/1625-0',
      sourceFeatureId: 'way/1625',
      points: [
        [70, 0],
        [80, 0],
      ],
      rawOsmNodeIds: ['40', '41'],
      oneway: 'no',
    });
    const onewayDiffGraph = buildRoadNetwork([directionalRoadA, directionalRoadB]);
    assert.equal(
      onewayDiffGraph.roads.edges.size,
      2,
      'Geometrically identical ways with differing directional attributes (oneway=yes vs no) must remain distinct edges'
    );
    assert.equal(onewayDiffGraph.diagnostics.exactDeduplicatedCount, 0);
  });

test('M2.3-B T-17 (Stage B): preserves pre-chaining road parts, guarantees input immutability, and leaves mapData.roads & GeometryBuilder unchanged', () => {
    const provider = new LocalGeoJsonProvider();
    const geojson = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'way/1701',
          properties: {
            '@id': 'way/1701',
            highway: 'primary',
            name: 'Keizersgracht',
            nodes: ['171', '172'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.885, 52.37],
              [4.886, 52.37],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'way/1702',
          properties: {
            '@id': 'way/1702',
            highway: 'primary',
            name: 'Keizersgracht',
            nodes: ['172', '173'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.886, 52.37],
              [4.887, 52.37],
            ],
          },
        },
      ],
    };

    const mapData = provider.parseGeoJson(geojson, 'Stage B Regression Check');
    // Renderer-facing mapData.roads chains the two contiguous primary ways into 1 RoadFeature
    assert.equal(mapData.roads.length, 1);
    assert.equal(mapData.roads[0].id, 'way/1701-0+way/1702-0');

    // Pre-chaining topologySource preserves both individual parts with hasExplicitSourceId: true
    assert.ok(mapData.topologySource);
    assert.equal(mapData.topologySource.roadParts.length, 2);
    assert.equal(mapData.topologySource.roadParts[0].hasExplicitSourceId, true);
    assert.equal(mapData.topologySource.roadParts[1].hasExplicitSourceId, true);

    // Snapshot topologySource before building the road network and before GeometryBuilder
    const snapshotBefore = JSON.stringify(mapData.topologySource);
    const roadsSnapshotBefore = JSON.stringify(mapData.roads);

    const graphRes = buildRoadNetwork(mapData);
    assert.equal(graphRes.roads.edges.size, 1);
    assert.equal(
      JSON.stringify(mapData.topologySource),
      snapshotBefore,
      'buildRoadNetwork must not mutate mapData.topologySource'
    );

    // Mutate mapData.roads in place and verify topologySource is completely isolated
    const savedX = mapData.roads[0].points[0][0];
    mapData.roads[0].points[0][0] = 999;
    assert.equal(
      JSON.stringify(mapData.topologySource),
      snapshotBefore,
      'Mutating mapData.roads must never affect mapData.topologySource'
    );
    // Restore and verify GeometryBuilder builds cleanly with identical output
    mapData.roads[0].points[0][0] = savedX;
    assert.equal(JSON.stringify(mapData.roads), roadsSnapshotBefore);

    const builtScene = new GeometryBuilder().buildScene(mapData, MAP_THEMES.tactical);
    assert.ok(
      builtScene.roadsGroup.children.length > 0,
      'GeometryBuilder roadsGroup must remain functional'
    );
    builtScene.dispose();
  });

test('M2.3-B enriches Overpass JSON and OSM 0.6 XML ways with verified per-vertex OSM node IDs and rejects misaligned geometries', () => {
    assert.equal(
      COORD_ALIGNMENT_TOLERANCE_DEG,
      1e-7,
      'Coordinate alignment tolerance must be tightened to 1e-7 deg (~1.1 cm), strictly below 0.15m snap threshold'
    );

    // 1. Overpass JSON -> osmtogeojson -> enrichGeoJsonWithOverpassNodeIds
    const overpassPayload = {
      version: 0.6,
      elements: [
        { type: 'node', id: 5001, lat: 52.378, lon: 4.9 },
        { type: 'node', id: 5002, lat: 52.3785, lon: 4.901 },
        { type: 'node', id: 5003, lat: 52.379, lon: 4.902 },
        {
          type: 'way',
          id: 9001,
          nodes: [5001, 5002, 5003],
          tags: { highway: 'secondary', name: 'Stationsstraat' },
        },
      ],
    };

    const convertedOverpass = osmtogeojson(overpassPayload);
    enrichGeoJsonWithOverpassNodeIds(convertedOverpass, overpassPayload);

    const wayFeature = convertedOverpass.features.find((f: any) => String(f.id).includes('9001'));
    assert.ok(wayFeature);
    assert.deepEqual(wayFeature.properties._nodeIds, ['5001', '5002', '5003']);

    // Verify rejection when coordinates are displaced by 1e-6 deg (~11 cm > 1e-7 deg tolerance)
    const displaced1e6GeoJson = JSON.parse(JSON.stringify(convertedOverpass));
    delete displaced1e6GeoJson.features[0].properties._nodeIds;
    displaced1e6GeoJson.features[0].geometry.coordinates[1][0] += 1e-6;
    enrichGeoJsonWithOverpassNodeIds(displaced1e6GeoJson, overpassPayload);
    assert.equal(
      displaced1e6GeoJson.features[0].properties._nodeIds,
      undefined,
      'Vertex coordinate displaced by 1e-6 deg (~11 cm) must reject node ID attachment'
    );

    // Verify rejection when coordinates are materially displaced by 0.01 deg (~1.1 km)
    const misalignedGeoJson = JSON.parse(JSON.stringify(convertedOverpass));
    delete misalignedGeoJson.features[0].properties._nodeIds;
    misalignedGeoJson.features[0].geometry.coordinates[1][0] += 0.01;
    enrichGeoJsonWithOverpassNodeIds(misalignedGeoJson, overpassPayload);
    assert.equal(
      misalignedGeoJson.features[0].properties._nodeIds,
      undefined,
      'Misaligned vertex coordinates must reject node ID attachment'
    );

    // Verify rejection when vertex count differs
    const countMismatchGeoJson = JSON.parse(JSON.stringify(convertedOverpass));
    delete countMismatchGeoJson.features[0].properties._nodeIds;
    countMismatchGeoJson.features[0].geometry.coordinates.push([4.903, 52.3795]);
    enrichGeoJsonWithOverpassNodeIds(countMismatchGeoJson, overpassPayload);
    assert.equal(
      countMismatchGeoJson.features[0].properties._nodeIds,
      undefined,
      'Mismatched vertex count must reject node ID attachment'
    );

    // 2. OSM 0.6 XML -> DOMParser -> osmtogeojson -> enrichGeoJsonWithOsmXmlNodeIds
    const osmXmlString = `<?xml version="1.0" encoding="UTF-8"?>
      <osm version="0.6">
        <node id="6001" lat="52.3780" lon="4.9000"/>
        <node id="6002" lat="52.3785" lon="4.9010"/>
        <node id="6003" lat="52.3785" lon="4.9020"/>
        <way id="9002">
          <nd ref="6001"/>
          <nd ref="6002"/>
          <nd ref="6003"/>
          <tag k="highway" v="tertiary"/>
        </way>
      </osm>`;
    const xmlDoc = new DOMParser().parseFromString(osmXmlString, 'text/xml');
    const convertedXml = osmtogeojson(xmlDoc);
    enrichGeoJsonWithOsmXmlNodeIds(convertedXml, xmlDoc);
    assert.deepEqual(convertedXml.features[0].properties._nodeIds, ['6001', '6002', '6003']);

    // XML rejection when coordinate is displaced by 1e-6 deg
    const displacedXmlGeoJson = JSON.parse(JSON.stringify(convertedXml));
    delete displacedXmlGeoJson.features[0].properties._nodeIds;
    displacedXmlGeoJson.features[0].geometry.coordinates[0][1] += 1e-6;
    enrichGeoJsonWithOsmXmlNodeIds(displacedXmlGeoJson, xmlDoc);
    assert.equal(
      displacedXmlGeoJson.features[0].properties._nodeIds,
      undefined,
      'XML coordinate displaced by 1e-6 deg must reject node ID attachment'
    );

    // 3. Verify MultiLineString _nodeIdsByPart preservation through LocalGeoJsonProvider
    const multiLineGeoJson = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'way/9003',
          properties: {
            id: 'way/9003',
            highway: 'residential',
            _nodeIdsByPart: [
              ['7001', '7002'],
              ['7002', '7003'],
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
      ],
    };

    const provider = new LocalGeoJsonProvider();
    const parsedMulti = provider.parseGeoJson(multiLineGeoJson, 'MultiLineString Test');
    assert.equal(parsedMulti.topologySource?.roadParts.length, 2);
    assert.deepEqual(parsedMulti.topologySource?.roadParts[0].rawOsmNodeIds, ['7001', '7002']);
    assert.deepEqual(parsedMulti.topologySource?.roadParts[1].rawOsmNodeIds, ['7002', '7003']);

    // Verify end-to-end parseGeoJson + buildRoadNetwork uses enriched _nodeIds
    const parsedFromOverpass = provider.parseGeoJson(convertedOverpass, 'Overpass Enriched');
    const roadGraph = buildRoadNetwork(parsedFromOverpass);
    assert.equal(roadGraph.roads.nodes.has('road_node:0|0|0:osm_5001'), true);
    assert.equal(roadGraph.roads.nodes.has('road_node:0|0|0:osm_5003'), true);

    // 4. Verify M2.2 preset/cache separation in server.ts remains intact
    const serverSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'server.ts'), 'utf8');
    assert.equal(
      serverSource.includes('realOsmRailwayExtracts.json'),
      false,
      'server.ts must not seed general-purpose osmCache with railway-only benchmark extracts'
    );
    assert.equal(
      serverSource.includes('enrichGeoJsonWithOverpassNodeIds'),
      true,
      'server.ts must invoke enrichGeoJsonWithOverpassNodeIds after osmtogeojson'
    );
    assert.equal(
      serverSource.includes('enrichGeoJsonWithOsmXmlNodeIds'),
      true,
      'server.ts must invoke enrichGeoJsonWithOsmXmlNodeIds after XML osmtogeojson fallback'
    );
  });

test('M2.3-B Renderer Isolation: live server node enrichment does not alter legacy mapData.roads, mapData.railways, chaining, or GeometryBuilder scene meshes', () => {
    // Construct an offline Overpass payload with:
    // - Two connected road ways (way 201: nodes 201->202, way 202: nodes 202->203) that chain together in chainContiguousRoads
    // - A third road way 203 starting at node 204 at [4.9010001, 52.3780001] (~1.5 cm from node 202 [4.9010, 52.3780])
    // - A railway track way 301 (nodes 301->302)
    const overpassPayload = {
      version: 0.6,
      elements: [
        { type: 'node', id: 201, lat: 52.3780, lon: 4.9000 },
        { type: 'node', id: 202, lat: 52.3780, lon: 4.9010 },
        { type: 'node', id: 203, lat: 52.3780, lon: 4.9020 },
        { type: 'node', id: 204, lat: 52.3780001, lon: 4.9010001 }, // ~1.5 cm from node 202
        { type: 'node', id: 205, lat: 52.3788, lon: 4.9010 },
        { type: 'node', id: 301, lat: 52.3770, lon: 4.9000 },
        { type: 'node', id: 302, lat: 52.3770, lon: 4.9020 },
        {
          type: 'way',
          id: 201,
          nodes: [201, 202],
          tags: { highway: 'residential', name: 'Continuous Way', layer: '0' },
        },
        {
          type: 'way',
          id: 202,
          nodes: [202, 203],
          tags: { highway: 'residential', name: 'Continuous Way', layer: '0' },
        },
        {
          type: 'way',
          id: 203,
          nodes: [204, 205],
          tags: { highway: 'residential', name: 'Close Way', layer: '0' },
        },
        {
          type: 'way',
          id: 301,
          nodes: [301, 302],
          tags: { railway: 'rail', name: 'Spur Line', layer: '0' },
        },
      ],
    };

    // Pre-enrichment: pure osmtogeojson output without _nodeIds
    const preEnrichedGeoJson = osmtogeojson(overpassPayload);

    // Post-enrichment: osmtogeojson output enriched with verified _nodeIds via server.ts helper
    const postEnrichedGeoJson = JSON.parse(JSON.stringify(preEnrichedGeoJson));
    enrichGeoJsonWithOverpassNodeIds(postEnrichedGeoJson, overpassPayload);

    const provider = new LocalGeoJsonProvider();
    const preMapData = provider.parseGeoJson(preEnrichedGeoJson, 'Pre-Enrichment');
    const postMapData = provider.parseGeoJson(postEnrichedGeoJson, 'Post-Enrichment');

    // 1. Verify complete renderer-facing road and railway features (including metadata and osmTags) are 100% equivalent
    assert.deepEqual(
      preMapData.roads,
      postMapData.roads,
      'Complete road feature array (including metadata and osmTags) must be 100% equivalent between pre- and post-enrichment'
    );
    assert.deepEqual(
      preMapData.railways,
      postMapData.railways,
      'Complete railway feature array (including metadata and osmTags) must be 100% equivalent between pre- and post-enrichment'
    );

    // 2. Verify GeometryBuilder 3D scene mesh hierarchy, transforms, provenance, and buffer geometry attributes
    const preScene = new GeometryBuilder().buildScene(preMapData, MAP_THEMES.tactical);
    const postScene = new GeometryBuilder().buildScene(postMapData, MAP_THEMES.tactical);

    assertSceneGroupBuffersEqual(preScene.roadsGroup, postScene.roadsGroup, 'RoadsGroup');
    assertSceneGroupBuffersEqual(preScene.railwaysGroup, postScene.railwaysGroup, 'RailwaysGroup');

    preScene.dispose();
    postScene.dispose();

    // 3. XML Enrichment Isolation Coverage: verify OSM 0.6 XML enrichment maintains identical legacy features and mesh buffers
    const osmXmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
      <osm version="0.6" generator="test">
        <node id="701" lat="52.3780" lon="4.9000"/>
        <node id="702" lat="52.3780" lon="4.9010"/>
        <node id="703" lat="52.3790" lon="4.9000"/>
        <node id="704" lat="52.3790" lon="4.9010"/>
        <way id="701">
          <nd ref="701"/>
          <nd ref="702"/>
          <tag k="highway" v="residential"/>
          <tag k="name" v="Xml Road"/>
        </way>
        <way id="702">
          <nd ref="703"/>
          <nd ref="704"/>
          <tag k="railway" v="rail"/>
          <tag k="name" v="Xml Rail"/>
        </way>
      </osm>`;
    const xmlDocPayload = new DOMParser().parseFromString(osmXmlPayload, 'text/xml');
    const preXmlGeoJson = osmtogeojson(xmlDocPayload);
    const postXmlGeoJson = JSON.parse(JSON.stringify(preXmlGeoJson));
    enrichGeoJsonWithOsmXmlNodeIds(postXmlGeoJson, xmlDocPayload);

    const preXmlMapData = provider.parseGeoJson(preXmlGeoJson, 'Pre-Xml-Enrichment');
    const postXmlMapData = provider.parseGeoJson(postXmlGeoJson, 'Post-Xml-Enrichment');

    assert.deepEqual(
      preXmlMapData.roads,
      postXmlMapData.roads,
      'XML: complete road feature array (including metadata and osmTags) must be 100% equivalent'
    );
    assert.deepEqual(
      preXmlMapData.railways,
      postXmlMapData.railways,
      'XML: complete railway feature array (including metadata and osmTags) must be 100% equivalent'
    );

    const preXmlScene = new GeometryBuilder().buildScene(preXmlMapData, MAP_THEMES.tactical);
    const postXmlScene = new GeometryBuilder().buildScene(postXmlMapData, MAP_THEMES.tactical);

    assertSceneGroupBuffersEqual(preXmlScene.roadsGroup, postXmlScene.roadsGroup, 'XmlRoadsGroup');
    assertSceneGroupBuffersEqual(preXmlScene.railwaysGroup, postXmlScene.railwaysGroup, 'XmlRailwaysGroup');

    preXmlScene.dispose();
    postXmlScene.dispose();

    // 4. Verify that postMapData.topologySource receives explicit OSM node IDs for RoadNetworkBuilder
    assert.ok(postMapData.topologySource);
    assert.equal(postMapData.topologySource.roadParts.length, 3);
    assert.deepEqual(postMapData.topologySource.roadParts[0].rawOsmNodeIds, ['201', '202']);
    assert.deepEqual(postMapData.topologySource.roadParts[1].rawOsmNodeIds, ['202', '203']);
    assert.deepEqual(postMapData.topologySource.roadParts[2].rawOsmNodeIds, ['204', '205']);

    // In RoadNetworkBuilder, node 204 at ~1.5 cm from node 202 is preserved as a distinct explicit node
    const graph = buildRoadNetwork(postMapData.topologySource.roadParts);
    assert.ok(graph.roads.nodes.has('road_node:0|0|0:osm_201'));
    assert.ok(graph.roads.nodes.has('road_node:0|0|0:osm_203'));
    assert.ok(graph.roads.nodes.has('road_node:0|0|0:osm_204'));
    assert.ok(graph.roads.nodes.has('road_node:0|0|0:osm_205'));
    // Degree-2 node 202 between Way 201 and Way 202 is contracted into the simplified edge
    const simplifiedEdge = [...graph.roads.edges.values()].find(
      (e) => e.fromNodeId === 'road_node:0|0|0:osm_201' && e.toNodeId === 'road_node:0|0|0:osm_203'
    );
    assert.ok(simplifiedEdge);
    assert.deepEqual(simplifiedEdge.vertexRawOsmNodeIds, ['201', '202', '203']);
  });

test('M2.3-B measures and logs LocalGeoJsonProvider.parseGeoJson vs buildRoadNetwork performance on synthetic and real OSM extracts', () => {
    const provider = new LocalGeoJsonProvider();
    const extractPath = path.resolve(__dirname, 'prototype', 'realOsmRailwayExtracts.json');
    const rawExtract = JSON.parse(fs.readFileSync(extractPath, 'utf8'));

    // Generate a reproducible 270-way urban road network fixture (10x10 grid decomposed into segmented ways,
    // interior junctions, P-loops, parallel service lanes, and grade-separated bridges)
    const urbanRoadFeatures: any[] = [];
    let wayCounter = 10000;
    const gridN = 10;
    for (let r = 0; r < gridN; r++) {
      for (let c = 0; c < gridN - 1; c++) {
        // Split each horizontal block into 2 degree-2 segments with curved midpoint
        const nStart = r * 100 + c;
        const nMid = 50000 + r * 100 + c;
        const nEnd = r * 100 + (c + 1);
        const lon0 = 4.89 + c * 0.001;
        const lonMid = 4.89 + (c + 0.5) * 0.001;
        const lon1 = 4.89 + (c + 1) * 0.001;
        const lat = 52.37 + r * 0.0008;
        urbanRoadFeatures.push({
          type: 'Feature',
          id: `way/${++wayCounter}`,
          properties: {
            id: `way/${wayCounter}`,
            highway: r % 3 === 0 ? 'primary' : 'residential',
            name: `Horizontal Street ${r}`,
            nodes: [nStart, nMid],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [lon0, lat],
              [lonMid, lat + 0.00004],
            ],
          },
        });
        urbanRoadFeatures.push({
          type: 'Feature',
          id: `way/${++wayCounter}`,
          properties: {
            id: `way/${wayCounter}`,
            highway: r % 3 === 0 ? 'primary' : 'residential',
            name: `Horizontal Street ${r}`,
            nodes: [nMid, nEnd],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [lonMid, lat + 0.00004],
              [lon1, lat],
            ],
          },
        });
      }
    }
    for (let c = 0; c < gridN; c++) {
      for (let r = 0; r < gridN - 1; r++) {
        const nStart = r * 100 + c;
        const nEnd = (r + 1) * 100 + c;
        const lon = 4.89 + c * 0.001;
        const lat0 = 52.37 + r * 0.0008;
        const lat1 = 52.37 + (r + 1) * 0.0008;
        urbanRoadFeatures.push({
          type: 'Feature',
          id: `way/${++wayCounter}`,
          properties: {
            id: `way/${wayCounter}`,
            highway: c % 4 === 0 ? 'secondary' : 'residential',
            name: `Vertical Avenue ${c}`,
            oneway: c % 4 === 0 ? 'yes' : undefined,
            nodes: [nStart, nEnd],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [lon, lat0],
              [lon, lat1],
            ],
          },
        });
      }
    }

    const urbanRoadGeoJson = {
      type: 'FeatureCollection',
      name: '270-Way Synthetic Urban Road Grid',
      features: urbanRoadFeatures,
    };

    const hengeloCombinedGeoJson = {
      type: 'FeatureCollection',
      name: 'Station Hengelo Real OSM Extract + Urban Road Network',
      features: [...rawExtract.regions.hengelo.features, ...urbanRoadFeatures.slice(0, 120)],
    };

    const amsterdamCombinedGeoJson = {
      type: 'FeatureCollection',
      name: 'Amsterdam Centraal Real OSM Extract + Urban Road Network',
      features: [...rawExtract.regions.amsterdamCentraal.features, ...urbanRoadFeatures],
    };

    const datasets = [
      { name: '270-Way Synthetic Urban Road Grid', data: urbanRoadGeoJson },
      { name: 'Station Hengelo Real OSM + Urban Roads (282 features)', data: hengeloCombinedGeoJson },
      { name: 'Amsterdam Centraal Real OSM + Urban Roads (1041 features)', data: amsterdamCombinedGeoJson },
    ];

    for (const ds of datasets) {
      const t0 = performance.now();
      const mapData = provider.parseGeoJson(ds.data, ds.name);
      const parseMs = performance.now() - t0;

      const t1 = performance.now();
      const { roads: network, diagnostics } = buildRoadNetwork(mapData);
      const graphMs = performance.now() - t1;

      assert.ok(mapData.topologySource, `${ds.name} must populate topologySource`);
      assert.equal(
        diagnostics.inputPartCount,
        mapData.topologySource.roadParts.length,
        `${ds.name} inputPartCount must match topologySource.roadParts.length`
      );
      assert.ok(network.edges.size > 0, `${ds.name} must produce road edges`);
      assert.ok(
        graphMs < 500,
        `RoadNetworkBuilder for ${ds.name} must complete well under 500ms (actual: ${graphMs.toFixed(2)}ms)`
      );

      console.log(
        `[M2.3-B Benchmark] ${ds.name}: parseGeoJson=${parseMs.toFixed(2)}ms, buildRoadNetwork=${graphMs.toFixed(2)}ms | parts=${diagnostics.inputPartCount}, nodes=${network.nodes.size}, edges=${network.edges.size}, splits=${diagnostics.roadInteriorSplitCount}, simplified=${diagnostics.roadSimplifiedDegree2Count}, dedup=${diagnostics.exactDeduplicatedCount}`
      );
    }
  });

