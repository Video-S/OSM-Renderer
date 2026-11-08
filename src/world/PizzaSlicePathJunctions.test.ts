import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import polygonClipping from 'polygon-clipping';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import {
  auditGraphRoadMeshIntegrity,
  FaceFeatureRange,
  GeometryBuilder,
  prepareInfrastructureRenderPreview,
} from './GeometryBuilder';
import { ELEVATION_POLICY } from './ElevationPolicy';
import { MAP_THEMES } from '../styles/mapThemes';
import { MultiPolygonCoords, computeMultiPolygonArea } from './PlanarLayerValidator';

/**
 * Source-grounded subset of repro-pizza-slice-corners-2026-11-08.json.
 * The two 4-arm path nodes are 4.1 m apart and their full-width patches
 * overlap. Coordinates, way IDs, and all shared node IDs are original OSM.
 * Only far-away interior vertices are omitted.
 */
function pizzaSliceFixture(reverse = false) {
  const roads = [
    {
      id: 'way/108044813', highway: 'cycleway',
      nodeIds: ['1240356584', '2487253134', '13382746338', '1240356673'],
      coordinates: [
        [6.7986395, 52.2622981], [6.7983217, 52.2620227],
        [6.7980771, 52.2619476], [6.7980301, 52.2619387],
      ],
    },
    {
      id: 'way/108044818', highway: 'cycleway',
      nodeIds: ['1240356673', '1240356680', '13273618255', '1860778918', '1860778914'],
      coordinates: [
        [6.7980301, 52.2619387], [6.7979865, 52.2619306],
        [6.7979586, 52.2619253], [6.7977435, 52.2618847],
        [6.7976921, 52.2618795],
      ],
    },
    {
      id: 'way/1446673721', highway: 'footway',
      nodeIds: ['13273618254', '13273618255', '13273618256', '13273618257'],
      coordinates: [
        [6.7979283, 52.2617994], [6.7979586, 52.2619253],
        [6.7979512, 52.2619439], [6.7979963, 52.2619539],
      ],
    },
    {
      id: 'way/241043233', highway: 'footway',
      nodeIds: ['1240356673', '13273618257', '2487253072', '5213510971'],
      coordinates: [
        [6.7980301, 52.2619387], [6.7979963, 52.2619539],
        [6.7979529, 52.2619734], [6.7979074, 52.2619916],
      ],
    },
    {
      id: 'way/1459207201', highway: 'footway',
      nodeIds: [
        '13382746335', '13382746336', '13382746337',
        '13382746338', '13382746339', '13273618257',
      ],
      coordinates: [
        [6.7984028, 52.2618082], [6.7983789, 52.2618171],
        [6.7982773, 52.2618580], [6.7980771, 52.2619476],
        [6.7980421, 52.2619626], [6.7979963, 52.2619539],
      ],
    },
    {
      id: 'way/108044814', highway: 'cycleway',
      nodeIds: ['1240356673', '4465243104', '5480661116'],
      coordinates: [
        [6.7980301, 52.2619387], [6.7981347, 52.2618931],
        [6.7982500, 52.2618375],
      ],
    },
  ];
  const features = roads.map(({ id, highway, nodeIds, coordinates }) => ({
    type: 'Feature',
    id,
    properties: {
      id, highway, _nodeIds: nodeIds,
      surface: highway === 'cycleway' ? 'asphalt' : 'paving_stones',
    },
    geometry: { type: 'LineString', coordinates },
  }));
  return {
    type: 'FeatureCollection',
    features: reverse ? features.reverse() : features,
  };
}

/** Reconstruct actual emitted junction footprints from provenance-attributed triangles. */
function pathJunctionSurfacePolygons(roadsGroup: THREE.Group): Map<string, MultiPolygonCoords> {
  const paths = new Map<string, MultiPolygonCoords>();
  roadsGroup.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    if (!mesh.name.startsWith('Roads_')) return;
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const faceRanges = mesh.userData.faceRanges as FaceFeatureRange[] | undefined;
    if (!pos || !faceRanges) return;

    for (const range of faceRanges) {
      if (!range.info.id.startsWith('path-junction-')) continue;
      const triangles: MultiPolygonCoords = [];
      for (let face = range.startFace; face < range.endFace; face++) {
        const ids = [0, 1, 2].map((k) => index ? index.getX(face * 3 + k) : face * 3 + k);
        if (ids.some((id) => Math.abs(pos.getY(id) - ELEVATION_POLICY.ROAD_SURFACE) > 0.001)) {
          continue;
        }
        const tri = ids.map((id) =>
          [pos.getX(id), pos.getZ(id)] as [number, number]
        );
        const twiceArea = Math.abs(
          (tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1]) -
          (tri[1][1] - tri[0][1]) * (tri[2][0] - tri[0][0])
        );
        if (twiceArea > 2e-6) {
          triangles.push([[tri[0], tri[1], tri[2], tri[0]]]);
        }
      }
      assert.ok(triangles.length > 0, 'Path-junction patch has no valid triangles: ' + range.info.id);
      const surface = polygonClipping.union(
        triangles[0] as unknown as polygonClipping.Geom,
        ...(triangles.slice(1) as unknown as polygonClipping.Geom[])
      ) as unknown as MultiPolygonCoords;
      assert.ok(computeMultiPolygonArea(surface) > 0.05, 'Missing patch surface: ' + range.info.id);
      paths.set(range.info.id, surface);
    }
  });
  return paths;
}

describe('E2 adjacent path-junction pizza-slice overlap regression', () => {
  it('keeps adjacent cycleway and footway patches mutually exclusive in emitted geometry', () => {
    for (const reverse of [false, true]) {
      const data = new LocalGeoJsonProvider().parseGeoJson(
        pizzaSliceFixture(reverse),
        'Hengelo close-set footway/cycleway junctions',
        [6.7980, 52.26194],
        160
      );
      const preview = prepareInfrastructureRenderPreview(data, {
        roads: 'graph', railways: 'legacy',
      });
      assert.ok(preview.graph);
      assert.equal(preview.validation?.isValid, true);
      for (const osmNodeId of ['13273618255', '13273618257']) {
        const node = [...preview.graph!.roads.nodes.values()]
          .find((n) => n.rawOsmNodeId === osmNodeId);
        assert.ok(node, 'OSM node must survive graph topology: ' + osmNodeId);
        assert.equal(node.degree, 4);
      }

      const scene = new GeometryBuilder({
        infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
        infrastructureRenderPreview: preview,
      }).buildScene(data, MAP_THEMES.tactical);
      try {
        const patches = pathJunctionSurfacePolygons(scene.roadsGroup);
        const id55 = 'path-junction-road_node:0|0|0:osm_13273618255';
        const id57 = 'path-junction-road_node:0|0|0:osm_13273618257';
        // A cut/patch pair is exactly what caused these closely spaced
        // connected ribbons to split into sharp triangular surfaces.
        // The entire source-width ribbons must now form their union directly.
        assert.equal(patches.has(id55), false,
          'Mixed cycleway/footway node must not create artificial cut portals');
        assert.equal(patches.has(id57), false,
          'Adjacent footway-only node must not create artificial cut portals');
        // The underlying OSM paths must remain both inspectable and rendered.
        const sourceIds = new Set<string>();
        for (const obj of scene.roadsGroup.children) {
          if (!obj.name.startsWith('Roads_')) continue;
          const ranges = obj.userData.faceRanges as FaceFeatureRange[] | undefined;
          for (const range of ranges ?? []) {
            for (const sourceId of range.info.sourceFeatureIds ?? []) {
              sourceIds.add(sourceId);
            }
          }
        }
        for (const id of [
          'way/108044818', 'way/1446673721',
          'way/241043233', 'way/1459207201',
        ]) {
          assert.ok(sourceIds.has(id), 'Untrimmed source path must be inspectable: ' + id);
        }
        const allPathMeshes = scene.roadsGroup.children.filter((obj) =>
          obj.name === 'Roads_cycleway' || obj.name === 'Roads_footway'
        ) as THREE.Mesh[];
        const covers = (x: number, z: number): boolean => allPathMeshes.some((mesh) => {
          const pos = mesh.geometry.getAttribute('position');
          const index = mesh.geometry.getIndex();
          const faceCount = index ? index.count / 3 : pos.count / 3;
          for (let face = 0; face < faceCount; face++) {
            const [a, b, c] = [0, 1, 2].map((j) =>
              index ? index.getX(face * 3 + j) : face * 3 + j
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
        });
        for (const osmNodeId of ['13273618255', '13273618257']) {
          const node = [...preview.graph!.roads.nodes.values()].find((n) =>
            n.rawOsmNodeId === osmNodeId
          );
          assert.ok(node);
          assert.ok(covers(node.x, node.z),
            'Source ribbon union must cover the full connected path at ' + osmNodeId);
        }
        const all = [...patches.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        for (let i = 0; i < all.length; i++) {
          for (let j = i + 1; j < all.length; j++) {
            const overlap = polygonClipping.intersection(
              all[i][1] as unknown as polygonClipping.Geom,
              all[j][1] as unknown as polygonClipping.Geom
            ) as unknown as MultiPolygonCoords;
            const area = computeMultiPolygonArea(overlap);
            assert.ok(area < 0.003,
              'Two path junction meshes must never compete for the same plane: ' +
              all[i][0] + ' / ' + all[j][0] + ' = ' + area.toFixed(5) + 'm²');
          }
        }
        const audit = auditGraphRoadMeshIntegrity(scene.roadsGroup);
        assert.ok(audit.auditedTriangleCount > 0);
        assert.equal(audit.negativelyWoundCount, 0);
        assert.equal(audit.storedNormalMismatchCount, 0);
      } finally {
        scene.dispose();
      }
    }
  });
});
