import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { proposeRoundedPathJunctionOutline } from './infrastructure/roads/PathJunctionCornerSmoothing';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { auditGraphRoadMeshIntegrity, GeometryBuilder, prepareInfrastructureRenderPreview } from './GeometryBuilder';
import { MAP_THEMES } from '../styles/mapThemes';

describe('E2 bounded path junction outline fillets', () => {
  it('smooths only local polygon corners, leaving full-width branch cut portals unchanged', () => {
    // An L-shaped junction outline with two interior corners.
    const polygon: [number, number][][][] = [[[
      [-8, -2], [-2, -2], [-2, -5], [2, -5], [2, -2],
      [8, -2], [8, 2], [2, 2], [2, 8], [-2, 8],
      [-2, 2], [-8, 2], [-8, -2],
    ]]];
    const portals: [number, number][] = [
      [-8, -2], [-8, 2], [8, -2], [8, 2], [-2, 8], [2, 8],
    ];
    const proposal = proposeRoundedPathJunctionOutline(
      polygon, [0, 0], portals, 4.2
    );
    assert.ok(proposal, 'Expected a bounded curvature proposal');
    assert.ok(proposal[0][0].length > polygon[0][0].length + 5);
    for (const portal of portals) {
      assert.ok(proposal[0][0].some((p) => p[0] === portal[0] && p[1] === portal[1]),
        'Original full-width portal anchor must remain exact: ' + portal.join(','));
    }
    assert.equal(proposeRoundedPathJunctionOutline(polygon, [100, 100], portals, 4.2), null,
      'No global path smoothing away from the junction center');
  });

  it('retains the original Nieuwstraat–Stationsplein three-arm pedestrian graph junction', () => {
    // Source geometry and true OSM vertex identifiers from
    // repro-same-issue-2026-11-08.json.
    const data = new LocalGeoJsonProvider().parseGeoJson({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'way/6670784',
          properties: {
            id: 'way/6670784', highway: 'pedestrian', surface: 'paving_stones',
            name: 'Nieuwstraat',
            _nodeIds: [
              '6609184964', '12395644665', '1860778963', '2487253245',
              '5067153036', '5028745228', '2487253274',
            ],
          },
          geometry: { type: 'LineString', coordinates: [
            [6.7931389, 52.2624774], [6.7931468, 52.2625093],
            [6.7931611, 52.2625563], [6.7932068, 52.262735],
            [6.7932603, 52.2627752], [6.7932608, 52.262777],
            [6.7933026, 52.2628458],
          ] },
        },
        {
          type: 'Feature',
          id: 'way/241043218',
          properties: {
            id: 'way/241043218', highway: 'pedestrian',
            surface: 'paving_stones', name: 'Stationsplein',
            _nodeIds: ['2487253245', '2487253211'],
          },
          geometry: { type: 'LineString', coordinates: [
            [6.7932068, 52.262735], [6.7945717, 52.2625672],
          ] },
        },
      ],
    }, 'Nieuwstraat three-way path corner repro', [6.7932068, 52.262735], 130);

    const preview = prepareInfrastructureRenderPreview(data, {
      roads: 'graph', railways: 'legacy',
    });
    assert.ok(preview.graph);
    assert.equal(preview.validation?.isValid, true);
    const actualNode = [...preview.graph.roads.nodes.values()].find((n) =>
      n.rawOsmNodeId === '2487253245'
    );
    assert.ok(actualNode);
    assert.equal(actualNode.degree, 3);

    const scene = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
      infrastructureRenderPreview: preview,
    }).buildScene(data, MAP_THEMES.dusk);
    try {
      const mesh = scene.roadsGroup.children.find((obj) =>
        obj.name === 'Roads_pedestrian'
      ) as THREE.Mesh | undefined;
      assert.ok(mesh);
      const ranges = mesh.userData.faceRanges as Array<{
        startFace: number; endFace: number;
        info: { id: string; sourceFeatureIds: string[]; width: number };
      }>;
      const patch = ranges.find((r) =>
        r.info.id === 'path-junction-road_node:0|0|0:osm_2487253245'
      );
      assert.ok(patch, 'Path junction must remain a separate inspectable surface');
      assert.ok(patch.endFace > patch.startFace);
      assert.equal(patch.info.width, 4.2);
      assert.deepEqual([...patch.info.sourceFeatureIds].sort(),
        ['way/241043218', 'way/6670784']);
      const audit = auditGraphRoadMeshIntegrity(scene.roadsGroup);
      assert.ok(audit.auditedTriangleCount > 0);
      assert.equal(audit.negativelyWoundCount, 0);
      assert.equal(audit.storedNormalMismatchCount, 0);
    } finally {
      scene.dispose();
    }
  });
});
