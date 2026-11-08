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
      // Source-width through-road and branch are continuous here. An
      // artificial local junction patch produced the wedge visible in the
      // owner's repro even though the raw three-ribbon union has no gap.
      const patch = ranges.find((r) =>
        r.info.id === 'path-junction-road_node:0|0|0:osm_2487253245'
      );
      assert.equal(patch, undefined,
        'Equal-width pedestrian T junction should use continuous ribbons');
      for (const id of ['way/241043218', 'way/6670784']) {
        assert.ok(ranges.some((r) => r.info.sourceFeatureIds.includes(id)),
          'Source way must remain separately inspectable: ' + id);
      }
      const pos = mesh.geometry.getAttribute('position');
      const idx = mesh.geometry.getIndex();
      const covers = (x: number, z: number): boolean => {
        const faceCount = idx ? idx.count / 3 : pos.count / 3;
        for (let face = 0; face < faceCount; face++) {
          const [a, b, c] = [0, 1, 2].map((j) =>
            idx ? idx.getX(face * 3 + j) : face * 3 + j
          );
          const ax = pos.getX(a), az = pos.getZ(a);
          const bx = pos.getX(b), bz = pos.getZ(b);
          const cx = pos.getX(c), cz = pos.getZ(c);
          const denom = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
          if (Math.abs(denom) < 1e-8) continue;
          const u = ((bx - x) * (cz - z) - (bz - z) * (cx - x)) / denom;
          const v = ((cx - x) * (az - z) - (cz - z) * (ax - x)) / denom;
          if (u >= -1e-5 && v >= -1e-5 && u + v <= 1.00001) return true;
        }
        return false;
      };
      assert.ok(covers(actualNode.x, actualNode.z),
        'Original full-width pedestrian ribbons must cover the junction center');
      const audit = auditGraphRoadMeshIntegrity(scene.roadsGroup);
      assert.ok(audit.auditedTriangleCount > 0);
      assert.equal(audit.negativelyWoundCount, 0);
      assert.equal(audit.storedNormalMismatchCount, 0);
    } finally {
      scene.dispose();
    }
  });
});
