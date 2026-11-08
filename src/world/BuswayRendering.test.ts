import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { classifyGeoJsonFeature, ROAD_CLASS_WIDTHS } from './FeatureCatalogue';
import { ELEVATION_POLICY, isNonVehicularRoadClass } from './ElevationPolicy';
import { getRoadTier } from './infrastructure/topology/RoadNetworkBuilder';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import {
  auditGraphRoadMeshIntegrity,
  GeometryBuilder,
  prepareInfrastructureRenderPreview,
} from './GeometryBuilder';
import { MAP_THEMES } from '../styles/mapThemes';

function makeBuswayDataset() {
  const specs = [
    { id: 'way/busway-explicit', tags: { highway: 'busway', width: '4.8', oneway: 'yes' } },
    { id: 'way/busway-two-way', tags: { highway: 'busway', oneway: 'no' } },
    { id: 'way/busway-one-way', tags: { highway: 'busway', oneway: 'yes' } },
    { id: 'way/guided', tags: { highway: 'bus_guideway' } },
    {
      id: 'way/bus-lane',
      tags: {
        highway: 'secondary',
        lanes: '2',
        'bus:lanes': 'yes|designated',
        'psv:lanes': 'yes|designated',
        'lanes:bus': '1',
        busway: 'lane',
      },
    },
    {
      id: 'way/bus-only-service',
      tags: { highway: 'service', access: 'no', bus: 'designated' },
    },
  ];
  const collection = {
    type: 'FeatureCollection',
    features: specs.map((spec, idx) => {
      const lat = 52.26 + idx * 0.0007;
      return {
        type: 'Feature',
        id: spec.id,
        properties: { id: spec.id, ...spec.tags, _nodeIds: [String(10000 + idx * 2), String(10001 + idx * 2)] },
        geometry: {
          type: 'LineString',
          coordinates: [[6.79, lat], [6.7905, lat]],
        },
      };
    }),
  };
  return new LocalGeoJsonProvider().parseGeoJson(
    collection,
    'Dedicated busway and in-road bus lane classification regression',
    [6.79, 52.262],
    650
  );
}

describe('Dedicated busway rendering (E2 isolated extension)', () => {
  it('recognizes independently mapped busways but not in-road lane tags as new road classes', () => {
    const busway = classifyGeoJsonFeature({ highway: 'busway' }, 'LineString');
    assert.equal(busway.category, 'road');
    assert.equal(busway.subtype, 'busway');
    assert.equal(busway.primaryTag, 'highway=busway');
    assert.equal(busway.cartoLabel, 'Dedicated Busway');
    assert.equal(classifyGeoJsonFeature({ highway: 'busway' }, 'Point').category, 'unsupported');
    assert.equal(classifyGeoJsonFeature({ highway: 'bus_guideway' }, 'LineString').subtype, 'bus_guideway');
    assert.equal(
      classifyGeoJsonFeature({ highway: 'secondary', 'bus:lanes': 'yes|designated' }, 'LineString').subtype,
      'secondary'
    );
    assert.equal(
      classifyGeoJsonFeature({ highway: 'service', access: 'no', bus: 'designated' }, 'LineString').subtype,
      'service'
    );
    assert.equal(getRoadTier('busway'), 'vehicular');
    assert.equal(isNonVehicularRoadClass('busway'), false);
    assert.equal(ELEVATION_POLICY.ROAD_BASE_TIERS.busway, ELEVATION_POLICY.ROAD_SURFACE);
    for (const theme of Object.values(MAP_THEMES)) {
      assert.ok(theme.roadColors.busway, 'Each theme must style busways as ordinary road geometry');
    }
  });

  it('preserves ordinary widths and metadata without lane-based widening or inferred bus-lane surfaces', () => {
    const data = makeBuswayDataset();
    const parts = new Map((data.topologySource?.roadParts ?? []).map((p) => [p.sourceFeatureId, p]));
    assert.equal(parts.size, 6);
    assert.equal(parts.get('way/busway-explicit')?.roadClass, 'busway');
    assert.equal(parts.get('way/busway-explicit')?.width, 4.8);
    assert.equal(parts.get('way/busway-two-way')?.width, ROAD_CLASS_WIDTHS.busway);
    assert.ok(Math.abs((parts.get('way/busway-one-way')?.width ?? 0) - 3.72) < 1e-6);
    assert.equal(parts.get('way/guided')?.roadClass, 'bus_guideway');
    assert.equal(parts.get('way/guided')?.width, ROAD_CLASS_WIDTHS.bus_guideway);
    assert.equal(parts.get('way/bus-lane')?.roadClass, 'secondary');
    assert.equal(parts.get('way/bus-lane')?.width, ROAD_CLASS_WIDTHS.secondary);
    assert.equal(parts.get('way/bus-lane')?.osmTags['bus:lanes'], 'yes|designated');
    assert.equal(parts.get('way/bus-lane')?.osmTags['lanes:bus'], '1');
    assert.equal(parts.get('way/bus-only-service')?.roadClass, 'service');
    assert.equal(parts.get('way/bus-only-service')?.width, ROAD_CLASS_WIDTHS.service);

    const buswayLegacy = data.roads.filter((r) => r.roadClass === 'busway');
    assert.equal(buswayLegacy.length, 3);
    assert.ok(buswayLegacy.some((r) => r.primaryTag === 'highway=busway'));
  });

  it('emits inspectable busway surface meshes in legacy, graph-preview, and graph modes', () => {
    const data = makeBuswayDataset();
    const legacyScene = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'legacy', railways: 'legacy' },
    }).buildScene(data, MAP_THEMES.tactical);
    const preview = prepareInfrastructureRenderPreview(data, {
      roads: 'graph-preview', railways: 'legacy',
    });
    const previewScene = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'graph-preview', railways: 'legacy' },
      infrastructureRenderPreview: preview,
    }).buildScene(data, MAP_THEMES.tactical);
    const graphPreview = prepareInfrastructureRenderPreview(data, {
      roads: 'graph', railways: 'legacy',
    });
    assert.ok(graphPreview.graph);
    assert.ok(graphPreview.descriptors);
    assert.equal(graphPreview.validation?.isValid, true);
    const graphScene = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
      infrastructureRenderPreview: graphPreview,
    }).buildScene(data, MAP_THEMES.tactical);
    try {
      for (const scene of [legacyScene, previewScene, graphScene]) {
        const buswayMesh = scene.roadsGroup.children.find((o) => o.name === 'Roads_busway') as THREE.Mesh | undefined;
        assert.ok(buswayMesh, 'Dedicated busway must be a rendered road mesh');
        assert.ok(buswayMesh.geometry.getAttribute('position').count > 0);
        const ranges = buswayMesh.userData.faceRanges;
        assert.ok(Array.isArray(ranges));
        for (const id of ['way/busway-explicit', 'way/busway-two-way', 'way/busway-one-way']) {
          assert.ok(
            ranges.some((r: { info: { sourceFeatureId: string } }) => r.info.sourceFeatureId === id),
            'Busway mesh must preserve source provenance for ' + id
          );
        }
        assert.ok(scene.roadsGroup.children.some((o) => o.name === 'Roads_bus_guideway'));
        assert.ok(scene.roadsGroup.children.some((o) => o.name === 'Roads_secondary'));
        assert.ok(!scene.roadsGroup.children.some((o) => o.name === 'Roads_bus_lane'));
      }
      const report = auditGraphRoadMeshIntegrity(graphScene.roadsGroup);
      assert.ok(report.auditedTriangleCount > 0);
      assert.equal(report.negativelyWoundCount, 0);
      assert.equal(report.storedNormalMismatchCount, 0);
    } finally {
      legacyScene.dispose();
      previewScene.dispose();
      graphScene.dispose();
    }
  });
});
