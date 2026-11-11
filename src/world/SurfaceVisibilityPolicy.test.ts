import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RoadFeature, RailwayFeature, RawGeoJsonProperties } from '../types/MapFeature';
import { classifyInfrastructurePlacement } from './InfrastructurePlacementClassifier';
import { resolveSurfaceVisibility, VerifiedTunnelEntrances } from './SurfaceVisibilityPolicy';
import { calculateTunnelPortalGroundCutouts, generateTunnelPortalAndTraceGeometries } from './BridgeAndTunnelBuilder';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { GeometryBuilder } from './GeometryBuilder';
import { MAP_THEMES } from '../styles/mapThemes';

function road(
  id: string,
  from: [number, number],
  to: [number, number],
  tags: RawGeoJsonProperties,
  nodeIds?: [number, number]
): RoadFeature {
  const osmTags = { highway: 'secondary', ...tags, ...(nodeIds ? { nodes: nodeIds } : {}) };
  const cls = classifyInfrastructurePlacement(osmTags, { featureDomain: 'road' });
  return {
    id,
    type: 'road',
    roadClass: 'secondary',
    width: 6,
    points: [from, to],
    layer: cls.layer,
    isBridge: cls.isElevatedBridge,
    isTunnel: cls.isSubterraneanTunnel,
    placementClassification: cls,
    osmTags,
  };
}

function rail(
  id: string,
  from: [number, number],
  to: [number, number],
  tags: RawGeoJsonProperties
): RailwayFeature {
  const osmTags = { railway: 'rail', ...tags };
  const cls = classifyInfrastructurePlacement(osmTags, { featureDomain: 'railway' });
  return {
    id,
    type: 'railway',
    railwayType: 'rail',
    width: 4.8,
    points: [from, to],
    layer: cls.layer,
    isBridge: cls.isElevatedBridge,
    isTunnel: cls.isSubterraneanTunnel,
    placementClassification: cls,
    osmTags,
  };
}

describe('Unified surface visibility policy', () => {
  it('distinguishes layer, level and elevation; uses indoor context for below-ground floors', () => {
    assert.equal(resolveSurfaceVisibility(road('a', [0, 0], [1, 0], { layer: -3 })), 'surface');
    assert.equal(resolveSurfaceVisibility(road('b', [0, 0], [1, 0], { level: -3 })), 'surface');
    assert.equal(resolveSurfaceVisibility(road('c', [0, 0], [1, 0], { level: -3, indoor: 'yes' })), 'concealed_indoor');
    assert.equal(resolveSurfaceVisibility(road('d', [0, 0], [1, 0], { level: 0, indoor: 'yes' })), 'surface');
    assert.equal(resolveSurfaceVisibility(road('e', [0, 0], [1, 0], { level: -1, location: 'indoor' })), 'concealed_indoor');
    assert.equal(resolveSurfaceVisibility(road('f', [0, 0], [1, 0], { layer: -3, tunnel: 'yes' })), 'underground');
    assert.equal(resolveSurfaceVisibility(road('g', [0, 0], [1, 0], { layer: -1, cutting: 'yes' })), 'surface');
    assert.equal(resolveSurfaceVisibility(rail('h', [0, 0], [1, 0], { level: -1, location: 'underground' })), 'underground');
  });

  it('suppresses isolated, internal, and unverified deep tunnel endpoints', () => {
    const tunnelA = road('tA', [0, 0], [20, 0], { tunnel: 'yes', layer: -3 }, [1, 2]);
    const tunnelB = road('tB', [20, 0], [40, 0], { tunnel: 'yes', layer: -3 }, [2, 3]);
    const decisions = new VerifiedTunnelEntrances([tunnelA, tunnelB], []);
    assert.deepEqual(decisions.forFeature(tunnelA), { start: false, end: false });
    assert.deepEqual(decisions.forFeature(tunnelB), { start: false, end: false });
    // A non-terminal graph segment must not acquire a source way's portal.
    assert.equal(decisions.forEndpoint(['tA'], [10, 0], 'start'), false);
  });

  it('only opens transitions to genuinely adjacent exposed ways', () => {
    const tunnel = road('tun', [0, 0], [20, 0], { tunnel: 'yes', layer: -3 }, [2, 3]);
    const incoming = road('in', [-20, 0], [0, 0], {}, [1, 2]);
    const unrelatedCrossing = road('cross', [10, -10], [10, 10], {}, [5, 6]);
    const exitIndoor = road('indoor', [20, 0], [40, 0], { indoor: 'yes', level: -1 }, [3, 4]);
    const decisions = new VerifiedTunnelEntrances([incoming, tunnel, unrelatedCrossing, exitIndoor], []);
    assert.deepEqual(decisions.forFeature(tunnel), { start: true, end: false });
  });

  it('keeps endpoint decisions stable when a graph renderer snaps or reverses working points', () => {
    const tunnel = road('snap-tun', [0, 0], [20, 0], { tunnel: 'yes' }, [2, 3]);
    const west = road('snap-west', [-20, 0], [0, 0], {}, [1, 2]);
    const decisions = new VerifiedTunnelEntrances([west, tunnel], []);
    tunnel.points = [[25, 0], [5, 0]];
    assert.equal(decisions.forEndpoint(['snap-tun'], [0, 0], 'start'), true);
    assert.equal(decisions.forEndpoint(['snap-tun'], [20, 0], 'end'), false);
    assert.equal(decisions.forEndpoint(['snap-tun'], [10, 0], 'start'), false);
  });

  it('does not join coincident endpoints with contradictory explicit OSM node IDs', () => {
    const tunnel = road('tun', [0, 0], [20, 0], { tunnel: 'yes' }, [2, 3]);
    const unrelated = road('other', [-20, 0], [0, 0], {}, [10, 11]);
    assert.deepEqual(new VerifiedTunnelEntrances([tunnel, unrelated], []).forFeature(tunnel), { start: false, end: false });
  });

  it('preserves verified entrances on reverse-digitized ways without creating internal portals', () => {
    const tunnel = road('tun', [20, 0], [0, 0], { tunnel: 'yes', layer: -3 }, [3, 2]);
    const west = road('west', [-20, 0], [0, 0], {}, [1, 2]);
    const east = road('east', [20, 0], [40, 0], {}, [3, 4]);
    const decisions = new VerifiedTunnelEntrances([west, tunnel, east], []);
    assert.deepEqual(decisions.forFeature(tunnel), { start: true, end: true });
    assert.equal(decisions.forEndpoint(['tun'], [10, 0], 'end'), false);
    // A graph edge reversed relative to the source should still see the true mouth.
    assert.equal(decisions.forEndpoint(['tun'], [0, 0], 'start'), true);
  });

  it('never authorizes a railway portal from a road connection', () => {
    const railTunnel = rail('tun', [0, 0], [20, 0], { tunnel: 'yes' });
    const roadApproach = road('road', [-20, 0], [0, 0], {});
    assert.deepEqual(new VerifiedTunnelEntrances([roadApproach], [railTunnel]).forFeature(railTunnel), {
      start: false, end: false,
    });
  });

  it('uses identical no-portal decisions for both ground openings and actual scene geometry', () => {
    const geojson = {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          id: 'way/orphan-deep',
          properties: { highway: 'secondary', tunnel: 'yes', layer: '-3' },
          geometry: {
            type: 'LineString' as const,
            coordinates: [[6.793, 52.265], [6.7935, 52.265]],
          },
        },
        {
          type: 'Feature' as const,
          id: 'way/park',
          properties: { leisure: 'park' },
          geometry: {
            type: 'Polygon' as const,
            coordinates: [[[6.792, 52.264], [6.794, 52.264], [6.794, 52.266], [6.792, 52.266], [6.792, 52.264]]],
          },
        },
      ],
    };
    const processed = new LocalGeoJsonProvider().parseGeoJson(geojson as any);
    const builder = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'legacy', railways: 'legacy' },
    });
    const scene = builder.buildScene(processed, MAP_THEMES.tactical);
    assert.equal(scene.roadsGroup.userData.gradeTransitionDiagnostics?.tunnelPortalsEmittedCount, 0);
    assert.deepEqual(scene.roadsGroup.userData.portalGroundCutoutPolygons, []);
    let hasUndergroundMesh = false;
    scene.roadsGroup.traverse((obj) => {
      if (obj.name === 'Tunnel_Underground_Roads') hasUndergroundMesh = true;
    });
    assert.equal(hasUndergroundMesh, false);
    scene.dispose();
  });
  it('uses identical cutout geometry in terrain prepass and portal builders, including railway widths', () => {
    const pts: [number, number][] = [[0, 0], [10, 0], [20, 0]];
    for (const options of [
      { isPath: false, width: 8, railwayType: undefined, start: true, end: false },
      { isPath: true, width: 2.2, railwayType: undefined, start: true, end: true },
      { isPath: false, width: 4.8, railwayType: 'rail', start: false, end: true },
    ]) {
      const props = {
        emitStartPortal: options.start,
        emitEndPortal: options.end,
        railwayType: options.railwayType,
      };
      const pure = calculateTunnelPortalGroundCutouts(pts, options.width, options.isPath, props);
      const rendered = generateTunnelPortalAndTraceGeometries(pts, options.width, options.isPath, props);
      assert.deepEqual(pure, rendered.portalGroundCutoutPolygons);
      rendered.portalStructureGeo?.dispose();
      rendered.portalMouthGeo?.dispose();
      rendered.undergroundTraceGeo?.dispose();
    }
  });

});
