import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import {
  auditGraphRoadMeshIntegrity,
  GeometryBuilder,
  prepareInfrastructureRenderPreview,
} from './GeometryBuilder';
import { MAP_THEMES } from '../styles/mapThemes';
import { computeMultiPolygonArea } from './PlanarLayerValidator';
import { bufferSurfaceFirstRoadCenterline } from './infrastructure/roads/SurfaceFirstRoadFootprints';

type Point = [number, number];

function way(
  id: string, cls: string, nodes: string[], points: Point[]
) {
  return {
    type: 'Feature',
    id,
    properties: { id, highway: cls, _nodeIds: nodes, surface: 'paving_stones' },
    geometry: { type: 'LineString', coordinates: points },
  };
}

const scenarios = [
  {
    label: 'Nieuwstraat–Stationsplein',
    center: [6.7932068, 52.262735] as Point,
    targetNodeId: '2487253245',
    requiredSources: ['way/6670784', 'way/241043218'],
    features: [
      way('way/6670784', 'pedestrian',
        ['6609184964', '12395644665', '1860778963', '2487253245',
          '5067153036', '5028745228', '2487253274'],
        [[6.7931389, 52.2624774], [6.7931468, 52.2625093],
          [6.7931611, 52.2625563], [6.7932068, 52.262735],
          [6.7932603, 52.2627752], [6.7932608, 52.262777],
          [6.7933026, 52.2628458]]),
      way('way/241043218', 'pedestrian',
        ['2487253245', '2487253211'],
        [[6.7932068, 52.262735], [6.7945717, 52.2625672]]),
    ],
  },
  {
    label: 'Hengelo pizza-slice corners',
    center: [6.7979963, 52.2619539] as Point,
    targetNodeId: '13273618257',
    requiredSources: [
      'way/108044818', 'way/1446673721',
      'way/241043233', 'way/1459207201',
    ],
    features: [
      way('way/108044813', 'cycleway',
        ['1240356584', '2487253134', '13382746338', '1240356673'],
        [[6.7986395, 52.2622981], [6.7983217, 52.2620227],
          [6.7980771, 52.2619476], [6.7980301, 52.2619387]]),
      way('way/108044818', 'cycleway',
        ['1240356673', '1240356680', '13273618255',
          '1860778918', '1860778914'],
        [[6.7980301, 52.2619387], [6.7979865, 52.2619306],
          [6.7979586, 52.2619253], [6.7977435, 52.2618847],
          [6.7976921, 52.2618795]]),
      way('way/1446673721', 'footway',
        ['13273618254', '13273618255', '13273618256', '13273618257'],
        [[6.7979283, 52.2617994], [6.7979586, 52.2619253],
          [6.7979512, 52.2619439], [6.7979963, 52.2619539]]),
      way('way/241043233', 'footway',
        ['1240356673', '13273618257', '2487253072', '5213510971'],
        [[6.7980301, 52.2619387], [6.7979963, 52.2619539],
          [6.7979529, 52.2619734], [6.7979074, 52.2619916]]),
      way('way/1459207201', 'footway',
        ['13382746335', '13382746336', '13382746337',
          '13382746338', '13382746339', '13273618257'],
        [[6.7984028, 52.2618082], [6.7983789, 52.2618171],
          [6.7982773, 52.261858], [6.7980771, 52.2619476],
          [6.7980421, 52.2619626], [6.7979963, 52.2619539]]),
      way('way/108044814', 'cycleway',
        ['1240356673', '4465243104', '5480661116'],
        [[6.7980301, 52.2619387], [6.7981347, 52.2618931],
          [6.79825, 52.2618375]]),
    ],
  },
];

function meshCovers(mesh: THREE.Mesh, x: number, z: number): boolean {
  const pos = mesh.geometry.getAttribute('position');
  const idx = mesh.geometry.getIndex();
  for (let f = 0; f < (idx ? idx.count / 3 : pos.count / 3); f++) {
    const ids = [0, 1, 2].map((i) => idx ? idx.getX(f * 3 + i) : f * 3 + i);
    const pts = ids.map((i) => [pos.getX(i), pos.getZ(i)] as Point);
    const cross = (a: Point, b: Point) =>
      (a[0] - x) * (b[1] - z) - (a[1] - z) * (b[0] - x);
    const [a, b, c] = pts;
    const ab = cross(a, b), bc = cross(b, c), ca = cross(c, a);
    if ((ab >= -1e-4 && bc >= -1e-4 && ca >= -1e-4) ||
        (ab <= 1e-4 && bc <= 1e-4 && ca <= 1e-4)) return true;
  }
  return false;
}

describe('E2+ surface-first road visual-prototype invariants', () => {
  it('buffers a 10m straight into a 4m-wide round-capped stroke', () => {
    const poly = bufferSurfaceFirstRoadCenterline(
      [[0, 0], [10, 0]], 4, { capStart: true, capEnd: true }
    );
    const area = computeMultiPolygonArea(poly);
    assert.ok(area > 51 && area < 54,
      'Stroke area should be the 40m² rectangle plus two round half-caps');
    const bend = bufferSurfaceFirstRoadCenterline(
      [[0, 0], [10, 0], [10, 10]], 4, { capStart: true, capEnd: true }
    );
    assert.ok(computeMultiPolygonArea(bend) > 70);
  });

  for (const scenario of scenarios) {
    it('preserves topology and source coverage in ' + scenario.label, () => {
      const data = new LocalGeoJsonProvider().parseGeoJson(
        { type: 'FeatureCollection', features: scenario.features },
        scenario.label,
        scenario.center,
        170
      );
      const preview = prepareInfrastructureRenderPreview(data, {
        roads: 'graph-surface', railways: 'legacy',
      });
      assert.ok(preview.descriptors);
      assert.ok(preview.graph);
      assert.equal(preview.validation?.isValid, true);
      const node = [...preview.graph.roads.nodes.values()]
        .find((n) => n.rawOsmNodeId === scenario.targetNodeId);
      assert.ok(node);

      const scene = new GeometryBuilder({
        infrastructureRenderOptions: { roads: 'graph-surface', railways: 'legacy' },
        infrastructureRenderPreview: preview,
      }).buildScene(data, MAP_THEMES.dusk);
      try {
        assert.equal(scene.roadsGroup.userData.graphRoadMode, 'graph-surface');
        const stats = scene.roadsGroup.userData.graphRoadStats;
        assert.equal(stats.renderedJunctionCount, 0);
        assert.equal(stats.pathJunctionCount, 0);
        assert.ok(stats.renderedRoadRibbonCount > 0);
        const sources = new Set<string>();
        const meshes: THREE.Mesh[] = [];
        scene.roadsGroup.traverse((obj) => {
          if (!(obj as THREE.Mesh).isMesh || !obj.name.startsWith('Roads_')) return;
          const mesh = obj as THREE.Mesh;
          meshes.push(mesh);
          const ranges = mesh.userData.faceRanges as Array<{
            info: { id: string; sourceFeatureIds: string[] };
          }> | undefined;
          for (const range of ranges ?? []) {
            assert.ok(!range.info.id.startsWith('path-junction-'));
            assert.ok(!range.info.id.startsWith('junction-'));
            for (const id of range.info.sourceFeatureIds) sources.add(id);
          }
        });
        for (const id of scenario.requiredSources) {
          assert.ok(sources.has(id), 'Missing inspectable source: ' + id);
        }
        assert.ok(meshes.some((mesh) => meshCovers(mesh, node.x, node.z)),
          'The shared OSM node must remain part of a rendered surface');
        const audit = auditGraphRoadMeshIntegrity(scene.roadsGroup);
        assert.ok(audit.auditedTriangleCount > 0);
        assert.equal(audit.negativelyWoundCount, 0);
        assert.equal(audit.storedNormalMismatchCount, 0);
      } finally {
        scene.dispose();
      }
    });
  }
});
