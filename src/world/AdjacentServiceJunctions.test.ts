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
import { ELEVATION_POLICY } from './ElevationPolicy';

/** True when a class-mesh has a positive-area horizontal triangle containing (x,z). */
function meshCoversPointXZ(mesh: THREE.Mesh | undefined, x: number, z: number): boolean {
  if (!mesh) return false;
  const pos = mesh.geometry.getAttribute('position');
  const index = mesh.geometry.getIndex();
  if (!pos) return false;
  const triCount = index ? index.count / 3 : pos.count / 3;
  for (let face = 0; face < triCount; face++) {
    const a = index ? index.getX(face * 3) : face * 3;
    const b = index ? index.getX(face * 3 + 1) : face * 3 + 1;
    const c = index ? index.getX(face * 3 + 2) : face * 3 + 2;
    if ([a, b, c].some((i) => Math.abs(pos.getY(i) - ELEVATION_POLICY.ROAD_SURFACE) > 0.001)) {
      continue;
    }
    const ax = pos.getX(a), az = pos.getZ(a);
    const bx = pos.getX(b), bz = pos.getZ(b);
    const cx = pos.getX(c), cz = pos.getZ(c);
    const orient = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(orient) < 1e-8) continue;
    const u = ((bx - x) * (cz - z) - (bz - z) * (cx - x)) / orient;
    const v = ((cx - x) * (az - z) - (cz - z) * (ax - x)) / orient;
    const w = 1 - u - v;
    if (Math.min(u, v, w) >= 1e-5) return true;
  }
  return false;
}

function roadMesh(scene: { roadsGroup: THREE.Group }, roadClass: string): THREE.Mesh | undefined {
  return scene.roadsGroup.children.find((child) => child.name === 'Roads_' + roadClass) as
    | THREE.Mesh
    | undefined;
}

describe('E2 deterministic road-surface ownership and adjacent T-junction regression', () => {
  it('prioritizes the main carriageway over parking aisles irrespective of OSM feature ID', () => {
    // These two separately identified ways overlap physically at grade. The
    // parking-aisle ID sorts BEFORE the main road's ID; it must not win the
    // first-emitted-footprint clipping competition merely for that reason.
    const data = new LocalGeoJsonProvider().parseGeoJson({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature', id: 'way/100', properties: {
            id: 'way/100', highway: 'service', service: 'parking_aisle',
            _nodeIds: ['100001', '100002'],
          },
          geometry: { type: 'LineString', coordinates: [
            [6.7895, 52.2630], [6.7895, 52.2634],
          ] },
        },
        {
          type: 'Feature', id: 'way/900', properties: {
            id: 'way/900', highway: 'unclassified',
            _nodeIds: ['900001', '900002'],
          },
          geometry: { type: 'LineString', coordinates: [
            [6.7890, 52.2632], [6.7900, 52.2632],
          ] },
        },
      ],
    }, 'Road-Class Ownership Regression', [6.7895, 52.2632], 120);

    const preview = prepareInfrastructureRenderPreview(data, {
      roads: 'graph', railways: 'legacy',
    });
    assert.ok(preview.graph);
    assert.equal(preview.validation?.isValid, true);
    const scene = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
      infrastructureRenderPreview: preview,
    }).buildScene(data, MAP_THEMES.tactical);
    try {
      const main = roadMesh(scene, 'unclassified');
      const aisle = roadMesh(scene, 'service');
      assert.ok(main && aisle);
      // The source geometries overlap in a 3m x 4.8m area. Main-road
      // triangles must own its center; the lower-class service ribbon is
      // Boolean-clipped instead of relying on renderOrder / z-index.
      assert.ok(meshCoversPointXZ(main, 0, 0), 'Main road must own shared pavement');
      assert.equal(meshCoversPointXZ(aisle, 0, 0), false,
        'Parking aisle must not render overlapping coplanar triangles on main road');
      const report = auditGraphRoadMeshIntegrity(scene.roadsGroup);
      assert.equal(report.negativelyWoundCount, 0);
      assert.equal(report.storedNormalMismatchCount, 0);
    } finally {
      scene.dispose();
    }
  });

  it('keeps both real Prinses Beatrixstraat parking-aisle junctions with valid geometry', () => {
    // Exact mapped OSM node IDs/centerlines from
    // repro-inconsistent-rendering-on-side-paths-2026-11-08.json.
    // The two junctions are ~4.5m apart; side aisles are 3m,
    // mainline highway=unclassified is 4.8m. Both are degree-three.
    const data = new LocalGeoJsonProvider().parseGeoJson({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature', id: 'way/1507428766', properties: {
            id: 'way/1507428766', highway: 'unclassified',
            name: 'Prinses Beatrixstraat',
            _nodeIds: [
              '5665806836', '8739333487', '8739333480',
              '7157133638', '13251335305', '45936221',
            ],
          },
          geometry: { type: 'LineString', coordinates: [
            [6.7907201, 52.2627573],
            [6.7903422, 52.2628521],
            [6.7897535, 52.2630062],
            [6.7891902, 52.2631415],
            [6.7891291, 52.2631568],
            [6.7888915, 52.2632140],
          ] },
        },
        {
          type: 'Feature', id: 'way/1444115768', properties: {
            id: 'way/1444115768', highway: 'service',
            service: 'parking_aisle', oneway: 'yes', access: 'customers',
            _nodeIds: [
              '7157133640', '7157133639', '13251335293', '7157133638',
            ],
          },
          geometry: { type: 'LineString', coordinates: [
            [6.7891056, 52.2628545],
            [6.7891651, 52.2630505],
            [6.7891773, 52.2630949],
            [6.7891902, 52.2631415],
          ] },
        },
        {
          type: 'Feature', id: 'way/1444115769', properties: {
            id: 'way/1444115769', highway: 'service',
            service: 'parking_aisle', oneway: 'yes', access: 'customers',
            _nodeIds: [
              '13251335305', '13251335307', '13251335308',
              '13251335306', '7157133640',
            ],
          },
          geometry: { type: 'LineString', coordinates: [
            [6.7891291, 52.2631568],
            [6.7891147, 52.2631079],
            [6.7890642, 52.2629369],
            [6.7890419, 52.2628609],
            [6.7891056, 52.2628545],
          ] },
        },
      ],
    }, 'Prinses Beatrixstraat / Parking Aisles', [6.7893, 52.26305], 160);

    const parts = data.topologySource?.roadParts ?? [];
    assert.equal(parts.length, 3);
    assert.equal(parts.find((p) => p.sourceFeatureId === 'way/1507428766')?.width, 4.8);
    for (const id of ['way/1444115768', 'way/1444115769']) {
      assert.equal(parts.find((p) => p.sourceFeatureId === id)?.width, 3.0);
    }

    const preview = prepareInfrastructureRenderPreview(data, {
      roads: 'graph', railways: 'legacy',
    });
    assert.ok(preview.graph);
    assert.equal(preview.validation?.isValid, true);
    const junctionNodes = ['7157133638', '13251335305'].map((osmNodeId) => {
      const node = [...preview.graph!.roads.nodes.values()].find((n) => n.rawOsmNodeId === osmNodeId);
      assert.ok(node, 'Expected source OSM node ' + osmNodeId);
      assert.equal(node.degree, 3, 'Main road / parking aisle connection must be a real T-junction');
      return node;
    });
    const scene = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
      infrastructureRenderPreview: preview,
    }).buildScene(data, MAP_THEMES.tactical);
    try {
      const main = roadMesh(scene, 'unclassified');
      const aisle = roadMesh(scene, 'service');
      assert.ok(main && aisle);
      const mainRanges = main.userData.faceRanges as Array<{
        info: { id: string; sourceFeatureIds: string[]; subtype: string };
      }>;
      for (const node of junctionNodes) {
        const patch = mainRanges.find((r) => r.info.id === 'junction-' + node.id);
        assert.ok(patch, 'Both real T-junctions must be resolved as main-road patches');
        assert.ok(patch.info.sourceFeatureIds.includes('way/1507428766'));
        assert.ok(patch.info.sourceFeatureIds.some((id) =>
          id === 'way/1444115768' || id === 'way/1444115769'));
      }
      const report = auditGraphRoadMeshIntegrity(scene.roadsGroup);
      assert.ok(report.auditedTriangleCount > 0);
      assert.equal(report.negativelyWoundCount, 0);
      assert.equal(report.storedNormalMismatchCount, 0);
    } finally {
      scene.dispose();
    }
  });
});
