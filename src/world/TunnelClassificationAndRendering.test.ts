import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import {
  classifyInfrastructurePlacement,
  createEmptyPlacementDiagnostics,
  recordPlacementInDiagnostics,
} from './InfrastructurePlacementClassifier';
import { classifyGeoJsonFeature } from './FeatureCatalogue';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { GeometryBuilder, prepareInfrastructureRenderPreview } from './GeometryBuilder';
import { MAP_THEMES } from '../styles/mapThemes';
import { ELEVATION_POLICY } from './ElevationPolicy';
import { buildInfrastructureGraph } from './infrastructure/topology/InfrastructureGraph';

const DEFAULT_THEME = MAP_THEMES.tactical;

function buildSceneFromFeatures(
  features: Array<{
    id: string;
    properties: Record<string, any>;
    coordinates: [number, number][];
    geometryType?: 'LineString' | 'Polygon';
  }>,
  options?: {
    roads?: 'legacy' | 'graph' | 'graph-surface';
    railways?: 'legacy' | 'graph' | 'graph-switches' | 'graph-R+';
  }
) {
  const geojson = {
    type: 'FeatureCollection' as const,
    name: 'SyntheticTunnelTest',
    features: features.map((f) => ({
      type: 'Feature' as const,
      id: f.id,
      properties: { id: f.id, ...f.properties },
      geometry:
        f.geometryType === 'Polygon'
          ? {
              type: 'Polygon' as const,
              coordinates: [f.coordinates],
            }
          : {
              type: 'LineString' as const,
              coordinates: f.coordinates,
            },
    })),
  };

  const provider = new LocalGeoJsonProvider();
  const processed = provider.parseGeoJson(
    geojson as unknown as Parameters<LocalGeoJsonProvider['parseGeoJson']>[0]
  );
  const builder = new GeometryBuilder({
    infrastructureRenderOptions: {
      roads: options?.roads ?? 'graph-surface',
      railways: options?.railways ?? 'graph-R+',
      railwaySwitchPolicy: 'graph',
      railwayBallastStrategy: 'surface-first',
      // These geometry tests explicitly inspect buried meshes in cutaway mode.
      showHiddenUndergroundGeometry: true,
    },
  });
  const scene = builder.buildScene(processed, DEFAULT_THEME);
  return { processed, scene };
}

function findMeshByName(root: THREE.Object3D, name: string): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh && obj.name === name) {
      found = obj as THREE.Mesh;
    }
  });
  return found;
}

function findMeshesByPrefix(root: THREE.Object3D, prefix: string): THREE.Mesh[] {
  const list: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh && obj.name.startsWith(prefix)) {
      list.push(obj as THREE.Mesh);
    }
  });
  return list;
}

function getGeometryYBounds(mesh: THREE.Mesh): { minY: number; maxY: number } {
  const pos = mesh.geometry.attributes.position;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minY, maxY };
}

// Convert local meters offset (dx, dz) around (52.265, 6.793) to [lon, lat]
function metersToLonLat(dxEast: number, dzSouth: number): [number, number] {
  const baseLat = 52.265;
  const baseLon = 6.793;
  const metersPerDegLat = 111132.954;
  const metersPerDegLon = 111132.954 * Math.cos((baseLat * Math.PI) / 180);
  return [baseLon + dxEast / metersPerDegLon, baseLat - dzSouth / metersPerDegLat];
}

function assertCloseTo(actual: number, expected: number, tolerance = 1e-2, msg?: string) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    msg ?? `Expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

describe('Milestone 2.3 Stage E4-T — Tunnel Classification & Rendering (TKT-014)', () => {
  it('Scenario 1: Explicit tunnel=yes road classifies as underground_tunnel and generates scaled portals + 3D underground road geometry', () => {
    const placement = classifyInfrastructurePlacement({
      highway: 'primary',
      tunnel: 'yes',
      layer: '-1',
      maxheight: '4.6 m',
    });
    assert.equal(placement.placement, 'underground_tunnel');
    assert.equal(placement.verticalRelation, 'below_grade_enclosed');
    assert.equal(placement.enclosure, 'subterranean_tunnel');
    assert.equal(placement.isSubterraneanTunnel, true);
    assert.equal(placement.rendersOnSurface, false);
    assert.equal(placement.canGenerateUndergroundGeometry, true);
    assertCloseTo(placement.supportingEvidence.maxheightMeters!, 4.6, 1e-2);

    const { processed, scene } = buildSceneFromFeatures([
      {
        id: 'way/road-approach-start',
        properties: { highway: 'primary' },
        coordinates: [metersToLonLat(-80, 0), metersToLonLat(-30, 0)],
      },
      {
        id: 'way/road-tunnel-1',
        properties: { highway: 'primary', tunnel: 'yes', layer: '-1', maxheight: '4.6' },
        coordinates: [metersToLonLat(-30, 0), metersToLonLat(30, 0)],
      },
      {
        id: 'way/road-approach-end',
        properties: { highway: 'primary' },
        coordinates: [metersToLonLat(30, 0), metersToLonLat(80, 0)],
      },
    ]);

    assert.equal(
      processed.diagnostics?.placementDiagnostics?.undergroundTunnelCount,
      1
    );
    assert.equal(processed.diagnostics?.placementDiagnostics?.surfaceOpenCount, 2);

    const portalsMesh = findMeshByName(scene.roadsGroup, 'Tunnel_Portals');
    const entrancesMesh = findMeshByName(scene.roadsGroup, 'Tunnel_Entrances');
    const undergroundRoadMesh = findMeshByName(scene.roadsGroup, 'Tunnel_Underground_Roads');
    assert.ok(portalsMesh, 'Expected Tunnel_Portals mesh');
    assert.ok(entrancesMesh, 'Expected Tunnel_Entrances mesh');
    assert.ok(undergroundRoadMesh, 'Expected Tunnel_Underground_Roads mesh');

    const ugBounds = getGeometryYBounds(undergroundRoadMesh!);
    assertCloseTo(ugBounds.minY, ELEVATION_POLICY.TUNNEL_DEPTH, 1e-2);
    assertCloseTo(ugBounds.maxY, ELEVATION_POLICY.ROAD_SURFACE, 1e-2);

    const roadDiag = scene.roadsGroup.userData.gradeTransitionDiagnostics;
    assert.equal(roadDiag.tunnelPortalsEmittedCount, 2);
    assert.equal(roadDiag.undergroundRoadGeometryCount, 1);
    scene.dispose();
  });

  it('Scenario 2: Explicit railway tunnel classifies as underground_tunnel and generates railway portals + 3D underground ballast, sleepers, and rails', () => {
    const placement = classifyInfrastructurePlacement({
      railway: 'rail',
      tunnel: 'yes',
      layer: '-1',
    });
    assert.equal(placement.placement, 'underground_tunnel');
    assert.equal(placement.isSubterraneanTunnel, true);
    assert.equal(placement.canGenerateUndergroundGeometry, true);

    const { scene } = buildSceneFromFeatures([
      {
        id: 'way/rail-surface-start',
        properties: { railway: 'rail' },
        coordinates: [metersToLonLat(-90, 0), metersToLonLat(-35, 0)],
      },
      {
        id: 'way/rail-tunnel-main',
        properties: { railway: 'rail', tunnel: 'yes', layer: '-1' },
        coordinates: [metersToLonLat(-35, 0), metersToLonLat(35, 0)],
      },
      {
        id: 'way/rail-surface-end',
        properties: { railway: 'rail' },
        coordinates: [metersToLonLat(35, 0), metersToLonLat(90, 0)],
      },
    ]);

    const portalTarget = findMeshesByPrefix(scene.railwaysGroup, 'Railway_Tunnel_Portals');
    const ugBallastMeshes = findMeshesByPrefix(
      scene.railwaysGroup,
      'Tunnel_Underground_Railway_Ballast'
    );
    const ugSleeperMeshes = findMeshesByPrefix(
      scene.railwaysGroup,
      'Tunnel_Underground_Railway_Sleepers'
    );
    const ugRailMeshes = findMeshesByPrefix(
      scene.railwaysGroup,
      'Tunnel_Underground_Railway_Rails'
    );

    assert.ok(portalTarget.length > 0, 'Expected Railway_Tunnel_Portals');
    assert.ok(ugBallastMeshes.length > 0, 'Expected Tunnel_Underground_Railway_Ballast');
    assert.ok(ugSleeperMeshes.length > 0, 'Expected Tunnel_Underground_Railway_Sleepers');
    assert.ok(ugRailMeshes.length > 0, 'Expected Tunnel_Underground_Railway_Rails');

    const ugBallastBounds = getGeometryYBounds(ugBallastMeshes[0]);
    assertCloseTo(ugBallastBounds.minY, ELEVATION_POLICY.TUNNEL_DEPTH, 1e-2);
    assertCloseTo(ugBallastBounds.maxY, ELEVATION_POLICY.RAILWAY_BALLAST, 1e-2);

    const railDiag = scene.railwaysGroup.userData.gradeTransitionDiagnostics;
    assert.equal(railDiag.tunnelPortalsEmittedCount, 2);
    assert.equal(railDiag.undergroundRailwayGeometryCount, 1);
    scene.dispose();
  });

  it('Scenario 3: Metro line (railway=subway) above ground renders on surface or bridge without automatic underground inference', () => {
    const surfaceSubway = classifyInfrastructurePlacement({
      railway: 'subway',
    });
    assert.equal(surfaceSubway.placement, 'surface_open');
    assert.equal(surfaceSubway.isSubterraneanTunnel, false);
    assert.equal(surfaceSubway.rendersOnSurface, true);

    const elevatedSubway = classifyInfrastructurePlacement({
      railway: 'subway',
      bridge: 'viaduct',
      layer: '1',
    });
    assert.equal(elevatedSubway.placement, 'elevated');
    assert.equal(elevatedSubway.isSubterraneanTunnel, false);
    assert.equal(elevatedSubway.isElevatedBridge, true);

    const { scene } = buildSceneFromFeatures([
      {
        id: 'way/metro-surface',
        properties: { railway: 'subway' },
        coordinates: [metersToLonLat(-50, 0), metersToLonLat(50, 0)],
      },
    ]);

    assert.equal(findMeshesByPrefix(scene.railwaysGroup, 'Railway_Tunnel_Portals').length, 0);
    assert.equal(
      findMeshesByPrefix(scene.railwaysGroup, 'Tunnel_Underground_Railway_Ballast').length,
      0
    );
    assert.ok(findMeshesByPrefix(scene.railwaysGroup, 'Railway_Ballast').length > 0);
    assert.ok(findMeshesByPrefix(scene.railwaysGroup, 'Railway_Rails').length > 0);
    scene.dispose();
  });

  it('Scenario 4: Metro line (railway=subway + tunnel=yes or location=underground) classifies and renders as underground_tunnel', () => {
    const tunnelSubway = classifyInfrastructurePlacement({
      railway: 'subway',
      tunnel: 'yes',
      layer: '-2',
    });
    assert.equal(tunnelSubway.placement, 'underground_tunnel');
    assert.equal(tunnelSubway.isSubterraneanTunnel, true);

    const locationSubway = classifyInfrastructurePlacement({
      railway: 'subway',
      location: 'underground',
      level: '-1',
    });
    assert.equal(locationSubway.placement, 'underground_tunnel');
    assert.equal(locationSubway.isSubterraneanTunnel, true);
    assert.equal(locationSubway.supportingEvidence.level, -1);

    const { scene } = buildSceneFromFeatures([
      {
        id: 'way/metro-underground',
        properties: { railway: 'subway', location: 'underground', layer: '-1' },
        coordinates: [metersToLonLat(-40, 0), metersToLonLat(40, 0)],
      },
    ]);

    assert.ok(findMeshesByPrefix(scene.railwaysGroup, 'Railway_Tunnel_Portals').length > 0);
    assert.ok(
      findMeshesByPrefix(scene.railwaysGroup, 'Tunnel_Underground_Railway_Rails').length > 0
    );
    assert.equal(findMeshesByPrefix(scene.railwaysGroup, 'Railway_Ballast').length, 0);
    scene.dispose();
  });

  it('Scenario 5: layer=-1 without a tunnel tag classifies as surface_open (relative_layer_only) and renders on surface, NOT as a tunnel', () => {
    const roadLayerNeg = classifyInfrastructurePlacement({
      highway: 'secondary',
      layer: '-1',
    });
    assert.equal(roadLayerNeg.placement, 'surface_open');
    assert.equal(roadLayerNeg.verticalRelation, 'relative_layer_only');
    assert.equal(roadLayerNeg.enclosure, 'open_air');
    assert.equal(roadLayerNeg.isSubterraneanTunnel, false);
    assert.equal(roadLayerNeg.rendersOnSurface, true);

    const catMatch = classifyGeoJsonFeature({ highway: 'secondary', layer: '-1' }, 'LineString');
    assert.equal(catMatch?.isTunnel, false);
    assert.equal(catMatch?.layer, -1);

    const { scene } = buildSceneFromFeatures([
      {
        id: 'way/road-neg-layer-no-tunnel',
        properties: { highway: 'secondary', layer: '-1' },
        coordinates: [metersToLonLat(-40, 0), metersToLonLat(40, 0)],
      },
      {
        id: 'way/rail-neg-layer-no-tunnel',
        properties: { railway: 'rail', layer: '-1' },
        coordinates: [metersToLonLat(-40, 20), metersToLonLat(40, 20)],
      },
    ]);

    // Must render as surface road and surface railway, NOT as tunnel portals or underground meshes
    assert.ok(findMeshByName(scene.roadsGroup, 'Roads_secondary'));
    assert.equal(findMeshByName(scene.roadsGroup, 'Tunnel_Portals'), null);
    assert.equal(findMeshByName(scene.roadsGroup, 'Tunnel_Underground_Roads'), null);
    assert.ok(findMeshesByPrefix(scene.railwaysGroup, 'Railway_Ballast').length > 0);
    assert.equal(findMeshesByPrefix(scene.railwaysGroup, 'Railway_Tunnel_Portals').length, 0);
    scene.dispose();
  });

  it('Scenario 6: covered=yes footpath classifies as covered_passage and renders at-grade on surface without tunnel portals', () => {
    const placement = classifyInfrastructurePlacement({
      highway: 'footway',
      covered: 'yes',
    });
    assert.equal(placement.placement, 'covered_passage');
    assert.equal(placement.verticalRelation, 'at_grade');
    assert.equal(placement.enclosure, 'covered_surface');
    assert.equal(placement.isSubterraneanTunnel, false);
    assert.equal(placement.rendersOnSurface, true);

    const { scene } = buildSceneFromFeatures([
      {
        id: 'way/covered-footpath',
        properties: { highway: 'footway', covered: 'yes' },
        coordinates: [metersToLonLat(-25, 0), metersToLonLat(25, 0)],
      },
    ]);

    const footwayMesh = findMeshByName(scene.roadsGroup, 'Roads_footway');
    assert.ok(footwayMesh);
    assert.equal(findMeshByName(scene.roadsGroup, 'Tunnel_Portals'), null);
    assert.equal(findMeshByName(scene.roadsGroup, 'Tunnel_Underground_Roads'), null);
    scene.dispose();
  });

  it('Scenario 7: tunnel=building_passage classifies as covered_passage (building_passage enclosure) and renders on surface', () => {
    const placement = classifyInfrastructurePlacement({
      highway: 'service',
      tunnel: 'building_passage',
    });
    assert.equal(placement.placement, 'covered_passage');
    assert.equal(placement.enclosure, 'building_passage');
    assert.equal(placement.isSubterraneanTunnel, false);
    assert.equal(placement.rendersOnSurface, true);

    const { scene } = buildSceneFromFeatures([
      {
        id: 'way/building-passage-service',
        properties: { highway: 'service', tunnel: 'building_passage' },
        coordinates: [metersToLonLat(-20, 0), metersToLonLat(20, 0)],
      },
    ]);

    assert.ok(findMeshByName(scene.roadsGroup, 'Roads_service'));
    assert.equal(findMeshByName(scene.roadsGroup, 'Tunnel_Portals'), null);
    assert.equal(findMeshByName(scene.roadsGroup, 'Tunnel_Underground_Roads'), null);
    scene.dispose();
  });

  it('Scenario 8: cutting=yes railway classifies as open_cutting (below_grade_open) and renders as open surface railway without tunnel portals', () => {
    const placement = classifyInfrastructurePlacement({
      railway: 'rail',
      cutting: 'yes',
      layer: '-1',
    });
    assert.equal(placement.placement, 'open_cutting');
    assert.equal(placement.verticalRelation, 'below_grade_open');
    assert.equal(placement.enclosure, 'open_air');
    assert.equal(placement.isSubterraneanTunnel, false);
    assert.equal(placement.rendersOnSurface, true);

    const { scene } = buildSceneFromFeatures([
      {
        id: 'way/cutting-railway',
        properties: { railway: 'rail', cutting: 'yes', layer: '-1' },
        coordinates: [metersToLonLat(-50, 0), metersToLonLat(50, 0)],
      },
    ]);

    assert.ok(findMeshesByPrefix(scene.railwaysGroup, 'Railway_Ballast').length > 0);
    assert.equal(findMeshesByPrefix(scene.railwaysGroup, 'Railway_Tunnel_Portals').length, 0);
    assert.equal(
      findMeshesByPrefix(scene.railwaysGroup, 'Tunnel_Underground_Railway_Ballast').length,
      0
    );
    scene.dispose();
  });

  it('Scenario 9: Explicit tunnel=no overrides negative layer and renders as surface_open', () => {
    const placement = classifyInfrastructurePlacement({
      highway: 'tertiary',
      tunnel: 'no',
      layer: '-1',
    });
    assert.equal(placement.placement, 'surface_open');
    assert.equal(placement.isSubterraneanTunnel, false);
    assert.equal(placement.rendersOnSurface, true);

    const { scene } = buildSceneFromFeatures([
      {
        id: 'way/explicit-tunnel-no',
        properties: { highway: 'tertiary', tunnel: 'no', layer: '-1' },
        coordinates: [metersToLonLat(-30, 0), metersToLonLat(30, 0)],
      },
    ]);

    assert.ok(findMeshByName(scene.roadsGroup, 'Roads_tertiary'));
    assert.equal(findMeshByName(scene.roadsGroup, 'Tunnel_Portals'), null);
    scene.dispose();
  });

  it('Scenario 10: Multi-segment tunnel suppresses internal portals at intermediate tunnel-to-tunnel joints and maintains continuous underground 3D geometry', () => {
    const { scene } = buildSceneFromFeatures([
      {
        id: 'way/road-surface-west',
        properties: { highway: 'primary' },
        coordinates: [metersToLonLat(-100, 0), metersToLonLat(-50, 0)],
      },
      {
        id: 'way/road-tunnel-seg1',
        properties: { highway: 'primary', tunnel: 'yes', layer: '-1', name: 'West Segment' },
        coordinates: [metersToLonLat(-50, 0), metersToLonLat(0, 0)],
      },
      {
        id: 'way/road-tunnel-seg2',
        properties: {
          highway: 'primary',
          tunnel: 'yes',
          layer: '-1',
          name: 'East Segment',
          maxspeed: '50',
        },
        coordinates: [metersToLonLat(0, 0), metersToLonLat(50, 0)],
      },
      {
        id: 'way/road-surface-east',
        properties: { highway: 'primary' },
        coordinates: [metersToLonLat(50, 0), metersToLonLat(100, 0)],
      },
    ]);

    const roadDiag = scene.roadsGroup.userData.gradeTransitionDiagnostics;
    // Exactly 2 outer portals (west entrance at -50 and east exit at +50), 0 internal portals at x=0
    assert.ok(roadDiag.confirmedElevatedContinuations >= 2);
    assert.equal(roadDiag.tunnelPortalsEmittedCount, 2);
    assert.equal(roadDiag.undergroundRoadGeometryCount, 2);
    scene.dispose();
  });

  it('Scenario 11: Reversed-way entrance/exit resolves confirmed transitions and portals identically regardless of way digitization direction', () => {
    const { scene } = buildSceneFromFeatures([
      {
        id: 'way/rail-west-atgrade',
        properties: { railway: 'rail' },
        coordinates: [metersToLonLat(-90, 0), metersToLonLat(-40, 0)],
      },
      {
        // Digitized in reverse (east to west)
        id: 'way/rail-tunnel-reversed',
        properties: { railway: 'rail', tunnel: 'yes', layer: '-1' },
        coordinates: [metersToLonLat(40, 0), metersToLonLat(-40, 0)],
      },
      {
        id: 'way/rail-east-atgrade',
        properties: { railway: 'rail' },
        coordinates: [metersToLonLat(40, 0), metersToLonLat(90, 0)],
      },
    ]);

    const railDiag = scene.railwaysGroup.userData.gradeTransitionDiagnostics;
    assert.equal(railDiag.confirmedTransitionsConsumed, 2);
    assert.equal(railDiag.tunnelPortalsEmittedCount, 2);
    assert.equal(railDiag.undergroundRailwayGeometryCount, 1);
    scene.dispose();
  });

  it('Scenario 12: Tunnel beneath an unrelated surface road maintains vertical separation and preserves surface road + ground continuity', () => {
    const { processed, scene } = buildSceneFromFeatures([
      {
        // East-west underground road tunnel
        id: 'way/ew-tunnel',
        properties: { highway: 'primary', tunnel: 'yes', layer: '-1' },
        coordinates: [metersToLonLat(-60, 0), metersToLonLat(60, 0)],
      },
      {
        // North-south surface road crossing directly above at (0, 0) without shared node
        id: 'way/ns-surface',
        properties: { highway: 'secondary' },
        coordinates: [metersToLonLat(0, -60), metersToLonLat(0, 60)],
      },
    ]);

    const graph = buildInfrastructureGraph(processed);
    assert.equal(graph.gradeTransitions.length, 0);

    const surfaceMesh = findMeshByName(scene.roadsGroup, 'Roads_secondary');
    const ugMesh = findMeshByName(scene.roadsGroup, 'Tunnel_Underground_Roads');
    assert.ok(surfaceMesh);
    assert.ok(ugMesh);

    const surfaceBounds = getGeometryYBounds(surfaceMesh!);
    const ugBounds = getGeometryYBounds(ugMesh!);
    assertCloseTo(surfaceBounds.minY, ELEVATION_POLICY.ROAD_SURFACE, 1e-2);
    assertCloseTo(ugBounds.minY, ELEVATION_POLICY.TUNNEL_DEPTH, 1e-2);
    assert.ok(surfaceBounds.minY - ugBounds.minY > 2.0);
    scene.dispose();
  });

  it('Scenario 13: Boundary-clipped tunnel suppresses portal at clipped tile boundary while emitting portal at valid entrance', () => {
    const geojson = {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          id: 'way/rail-approach',
          properties: { id: 'way/rail-approach', railway: 'rail' },
          geometry: {
            type: 'LineString' as const,
            coordinates: [metersToLonLat(-60, 0), metersToLonLat(-10, 0)],
          },
        },
        {
          type: 'Feature' as const,
          id: 'way/rail-clipped-tunnel',
          properties: {
            id: 'way/rail-clipped-tunnel',
            railway: 'rail',
            tunnel: 'yes',
            layer: '-1',
          },
          geometry: {
            type: 'LineString' as const,
            coordinates: [metersToLonLat(-10, 0), metersToLonLat(50, 0)],
          },
        },
      ],
    };

    const provider = new LocalGeoJsonProvider();
    const processed = provider.parseGeoJson(
      geojson as unknown as Parameters<LocalGeoJsonProvider['parseGeoJson']>[0]
    );
    const preview = prepareInfrastructureRenderPreview(processed, {
      railways: 'graph-R+',
      railwaySwitchPolicy: 'graph',
      railwayBallastStrategy: 'surface-first',
    });
    assert.ok(preview.descriptors);
    const tunnelEdge = preview.descriptors!.railwayEdges.find((e) => e.isTunnel);
    assert.ok(tunnelEdge);
    (tunnelEdge as { clippedAtEnd: boolean }).clippedAtEnd = true;
    const endNode = preview.descriptors!.railwayNodesById.get(tunnelEdge!.toNodeId);
    if (endNode) {
      (endNode as { isBoundaryClipped: boolean }).isBoundaryClipped = true;
    }

    const builder = new GeometryBuilder({
      infrastructureRenderOptions: {
        railways: 'graph-R+',
        railwaySwitchPolicy: 'graph',
        railwayBallastStrategy: 'surface-first',
      },
    });
    const scene = builder.buildScene(processed, DEFAULT_THEME);
    assert.ok(scene);
    scene.dispose();
  });

  it('Scenario 14: Missing or contradictory vertical tags classify as unknown_or_conflicting and never generate speculative tunnel portals or underground geometry', () => {
    const bridgeAndTunnel = classifyInfrastructurePlacement({
      highway: 'primary',
      bridge: 'yes',
      tunnel: 'yes',
    });
    assert.equal(bridgeAndTunnel.placement, 'unknown_or_conflicting');
    assert.equal(bridgeAndTunnel.hasConflict, true);
    assert.equal(bridgeAndTunnel.canGenerateUndergroundGeometry, false);

    const tunnelPositiveLayer = classifyInfrastructurePlacement({
      railway: 'rail',
      tunnel: 'yes',
      layer: '1',
    });
    assert.equal(tunnelPositiveLayer.placement, 'unknown_or_conflicting');
    assert.equal(tunnelPositiveLayer.hasConflict, true);

    const unknownTunnelTag = classifyInfrastructurePlacement({
      highway: 'service',
      tunnel: 'mystery_unknown_value',
    });
    assert.equal(unknownTunnelTag.placement, 'unknown_or_conflicting');
    assert.equal(unknownTunnelTag.hasConflict, true);

    const { processed, scene } = buildSceneFromFeatures([
      {
        id: 'way/conflicting-road',
        properties: { highway: 'primary', bridge: 'yes', tunnel: 'yes' },
        coordinates: [metersToLonLat(-30, 0), metersToLonLat(30, 0)],
      },
      {
        id: 'way/conflicting-rail',
        properties: { railway: 'rail', tunnel: 'yes', layer: '2' },
        coordinates: [metersToLonLat(-30, 20), metersToLonLat(30, 20)],
      },
    ]);

    assert.equal(
      processed.diagnostics?.placementDiagnostics?.unknownOrConflictingCount,
      2
    );
    assert.equal(findMeshByName(scene.roadsGroup, 'Tunnel_Portals'), null);
    assert.equal(findMeshByName(scene.roadsGroup, 'Tunnel_Underground_Roads'), null);
    assert.equal(findMeshesByPrefix(scene.railwaysGroup, 'Railway_Tunnel_Portals').length, 0);
    assert.equal(
      findMeshesByPrefix(scene.railwaysGroup, 'Tunnel_Underground_Railway_Ballast').length,
      0
    );
    scene.dispose();
  });

  it('Scenario 15: Culvert and short underpass handling distinguishes drainage culverts from walkable/drivable underpasses', () => {
    const roadCulvert = classifyInfrastructurePlacement(
      { highway: 'residential', tunnel: 'culvert', layer: '-1' },
      { featureDomain: 'road' }
    );
    assert.equal(roadCulvert.placement, 'surface_open');
    assert.equal(roadCulvert.enclosure, 'culvert_conduit');
    assert.equal(roadCulvert.isCulvert, true);
    assert.equal(roadCulvert.isSubterraneanTunnel, false);
    assert.equal(roadCulvert.rendersOnSurface, true);

    const waterCulvert = classifyInfrastructurePlacement(
      { waterway: 'stream', tunnel: 'culvert', layer: '-1' },
      { featureDomain: 'waterway' }
    );
    assert.equal(waterCulvert.placement, 'underground_tunnel');
    assert.equal(waterCulvert.enclosure, 'culvert_conduit');
    assert.equal(waterCulvert.isCulvert, true);
    assert.equal(waterCulvert.isSubterraneanTunnel, true);

    const shortUnderpass = classifyInfrastructurePlacement(
      { highway: 'cycleway', tunnel: 'underpass', layer: '-1', maxheight: '2.5' },
      { featureDomain: 'road' }
    );
    assert.equal(shortUnderpass.placement, 'underground_tunnel');
    assert.equal(shortUnderpass.isSubterraneanTunnel, true);
    assertCloseTo(shortUnderpass.supportingEvidence.maxheightMeters!, 2.5, 1e-2);

    const { scene } = buildSceneFromFeatures([
      {
        id: 'way/culvert-road',
        properties: { highway: 'residential', tunnel: 'culvert', layer: '-1' },
        coordinates: [metersToLonLat(-25, -15), metersToLonLat(25, -15)],
      },
      {
        id: 'way/cycle-underpass',
        properties: { highway: 'cycleway', tunnel: 'underpass', layer: '-1' },
        coordinates: [metersToLonLat(-20, 15), metersToLonLat(20, 15)],
      },
    ]);

    assert.ok(findMeshByName(scene.roadsGroup, 'Roads_residential'));
    // A standalone underpass has no verified surface transition: no fabricated portals.
    assert.equal(findMeshByName(scene.roadsGroup, 'Tunnel_Portals'), null);
    assert.ok(findMeshByName(scene.roadsGroup, 'Tunnel_Underground_Roads'));
    scene.dispose();
  });

  it('Scenario 16: Regression compatibility with E2+ surface-first roads, E3-B R+ railway ballast, and E4-A bridge transitions', () => {
    const { processed, scene } = buildSceneFromFeatures([
      {
        id: 'way/e2-road-ew',
        properties: { highway: 'residential' },
        coordinates: [metersToLonLat(-60, -40), metersToLonLat(0, -40), metersToLonLat(60, -40)],
      },
      {
        id: 'way/e2-road-ns',
        properties: { highway: 'residential' },
        coordinates: [metersToLonLat(0, -80), metersToLonLat(0, -40), metersToLonLat(0, 0)],
      },
      {
        id: 'way/rail-atgrade-west',
        properties: { railway: 'rail' },
        coordinates: [metersToLonLat(-120, 40), metersToLonLat(-60, 40)],
      },
      {
        id: 'way/rail-bridge-mid',
        properties: { railway: 'rail', bridge: 'yes', layer: '1' },
        coordinates: [metersToLonLat(-60, 40), metersToLonLat(0, 40)],
      },
      {
        id: 'way/rail-atgrade-center',
        properties: { railway: 'rail' },
        coordinates: [metersToLonLat(0, 40), metersToLonLat(60, 40)],
      },
      {
        id: 'way/rail-tunnel-east',
        properties: { railway: 'rail', tunnel: 'yes', layer: '-1' },
        coordinates: [metersToLonLat(60, 40), metersToLonLat(120, 40)],
      },
    ]);

    const pd = processed.diagnostics?.placementDiagnostics;
    assert.ok(pd);
    assert.equal(pd!.surfaceOpenCount, 4);
    assert.equal(pd!.elevatedCount, 1);
    assert.equal(pd!.undergroundTunnelCount, 1);
    assert.ok(findMeshByName(scene.roadsGroup, 'Roads_residential'));
    assert.ok(findMeshesByPrefix(scene.railwaysGroup, 'Railway_Ballast').length > 0);
    assert.ok(
      findMeshesByPrefix(scene.railwaysGroup, 'Railway_Bridge_Substructure').length > 0
    );
    assert.ok(findMeshesByPrefix(scene.railwaysGroup, 'Railway_Tunnel_Portals').length > 0);
    assert.ok(
      findMeshesByPrefix(scene.railwaysGroup, 'Tunnel_Underground_Railway_Ballast').length > 0
    );

    const railDiag = scene.railwaysGroup.userData.gradeTransitionDiagnostics;
    assert.ok(railDiag.confirmedTransitionsConsumed >= 3);
    assert.equal(railDiag.undergroundRailwayGeometryCount, 1);
    scene.dispose();
  });

  it('Records placement diagnostics accurately via createEmptyPlacementDiagnostics and recordPlacementInDiagnostics', () => {
    const diag = createEmptyPlacementDiagnostics();
    recordPlacementInDiagnostics(
      diag,
      classifyInfrastructurePlacement({ highway: 'primary', tunnel: 'yes', layer: '-1' })
    );
    recordPlacementInDiagnostics(
      diag,
      classifyInfrastructurePlacement({ highway: 'footway', covered: 'yes' })
    );
    recordPlacementInDiagnostics(
      diag,
      classifyInfrastructurePlacement({ railway: 'rail', cutting: 'yes' })
    );
    recordPlacementInDiagnostics(
      diag,
      classifyInfrastructurePlacement({ highway: 'secondary', layer: '-1' })
    );
    recordPlacementInDiagnostics(
      diag,
      classifyInfrastructurePlacement({ highway: 'primary', bridge: 'yes', tunnel: 'yes' })
    );

    assert.equal(diag.undergroundTunnelCount, 1);
    assert.equal(diag.coveredPassageCount, 1);
    assert.equal(diag.openCuttingCount, 1);
    assert.equal(diag.surfaceOpenCount, 1);
    assert.equal(diag.unknownOrConflictingCount, 1);
    assert.equal(diag.relativeNegativeLayerNonTunnelCount, 1);
  });

  it('Evaluates real-world benchmark fixtures (Station Hengelo & Amsterdam Centraal) and records E4-T placement and tunnel rendering diagnostics', () => {
    const provider = new LocalGeoJsonProvider();
    const extractPath = path.resolve(
      process.cwd(),
      'src/world/prototype/realOsmRailwayExtracts.json'
    );
    const rawExtract = JSON.parse(fs.readFileSync(extractPath, 'utf8'));

    // 1. Station Hengelo real-world extract
    const hengeloData = provider.parseGeoJson({
      type: 'FeatureCollection',
      name: 'Station Hengelo',
      features: rawExtract.regions.hengelo.features || rawExtract.regions.hengelo,
    } as any);
    const hengeloPlacementDiag = hengeloData.diagnostics?.placementDiagnostics;
    assert.ok(hengeloPlacementDiag, 'Expected placementDiagnostics on Hengelo dataset');
    assert.ok(hengeloPlacementDiag!.surfaceOpenCount > 0);

    const builder = new GeometryBuilder({
      infrastructureRenderOptions: {
        roads: 'graph-surface',
        railways: 'graph-R+',
        railwaySwitchPolicy: 'graph',
        railwayBallastStrategy: 'surface-first',
        // Benchmark underground geometry generation explicitly, not normal production.
        showHiddenUndergroundGeometry: true,
      },
    });
    const t0 = performance.now();
    const hengeloScene = builder.buildScene(hengeloData, DEFAULT_THEME);
    const hengeloBuildMs = Number((performance.now() - t0).toFixed(2));
    const hengeloRoadDiag = hengeloScene.roadsGroup.userData.gradeTransitionDiagnostics;
    const hengeloRailDiag = hengeloScene.railwaysGroup.userData.gradeTransitionDiagnostics;
    assert.ok(hengeloRoadDiag);
    assert.ok(hengeloRailDiag);
    assert.ok(hengeloBuildMs > 0);
    hengeloScene.dispose();

    // 2. Amsterdam Centraal real-world extract
    const amsParsed = provider.parseGeoJson({
      type: 'FeatureCollection',
      name: 'Amsterdam Centraal',
      features:
        rawExtract.regions.amsterdamCentraal.features || rawExtract.regions.amsterdamCentraal,
    } as any);
    const amsPlacementDiag = amsParsed.diagnostics?.placementDiagnostics;
    assert.ok(amsPlacementDiag);
    assert.ok(amsPlacementDiag!.undergroundTunnelCount >= 1);

    const amsScene = builder.buildScene(amsParsed, DEFAULT_THEME);
    const amsRailDiag = amsScene.railwaysGroup.userData.gradeTransitionDiagnostics;
    assert.ok(amsRailDiag);
    assert.ok((amsRailDiag.undergroundRailwayGeometryCount ?? 0) >= 1);
    assert.ok((amsRailDiag.confirmedTransitionsConsumed ?? 0) >= 50);
    amsScene.dispose();
  });
});
