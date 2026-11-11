import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import {
  MapStyleTheme,
  ProcessedMapData,
  RailwayFeature,
  RoadFeature,
} from '../types/MapFeature';
import { MAP_THEMES } from '../styles/mapThemes';
import {
  ELEVATION_POLICY,
  getRailwayElevations,
  getRoadElevation,
} from './ElevationPolicy';
import {
  auditGraphRoadMeshIntegrity,
  GeometryBuilder,
  prepareInfrastructureRenderPreview,
} from './GeometryBuilder';
import { buildRailwayInfrastructure } from './infrastructure/railways/RailwayGeometryBuilder';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { validateRoadNetworkGeometry } from './ZFightingValidator';
import { GradeTransitionRenderDiagnostics } from './BridgeAndTunnelBuilder';

function createEmptyMapData(): ProcessedMapData {
  const provider = new LocalGeoJsonProvider();
  const base = provider.parseGeoJson({
    type: 'FeatureCollection',
    name: 'SyntheticGradeTransitionTest',
    features: [],
  } as unknown as Parameters<LocalGeoJsonProvider['parseGeoJson']>[0]);
  base.bounds = {
    minX: -200,
    maxX: 200,
    minZ: -200,
    maxZ: 200,
    widthMeters: 400,
    depthMeters: 400,
  };
  delete base.topologySource;
  return base;
}

function makeRoad(
  id: string,
  points: [number, number][],
  nodeIds: string[],
  overrides?: Partial<RoadFeature>
): RoadFeature {
  const isBridge = overrides?.isBridge ?? false;
  const isTunnel = overrides?.isTunnel ?? false;
  const layer = overrides?.layer ?? (isBridge ? 1 : isTunnel ? -1 : 0);
  const roadClass = overrides?.roadClass ?? 'tertiary';
  return {
    id,
    sourceFeatureId: id,
    sourceFeatureIds: [id],
    type: 'road',
    name: overrides?.name ?? id,
    points: points.map((p) => [p[0], p[1]] as [number, number]),
    nodeIds: [...nodeIds],
    roadClass,
    width: overrides?.width ?? 8,
    isBridge,
    isTunnel,
    layer,
    cartoLabel: overrides?.name ?? id,
    primaryTag: `highway=${roadClass}`,
    osmTags: {
      highway: roadClass,
      ...(isBridge ? { bridge: 'yes', layer: String(layer) } : {}),
      ...(isTunnel ? { tunnel: 'yes', layer: String(layer) } : {}),
      ...(overrides?.osmTags || {}),
    },
    ...overrides,
  };
}

function makeRailway(
  id: string,
  points: [number, number][],
  nodeIds: string[],
  overrides?: Partial<RailwayFeature> & { service?: string; usage?: string }
): RailwayFeature {
  const isBridge = overrides?.isBridge ?? false;
  const isTunnel = overrides?.isTunnel ?? false;
  const layer = overrides?.layer ?? (isBridge ? 1 : isTunnel ? -1 : 0);
  const railwayType = overrides?.railwayType ?? 'rail';
  const { service, usage, ...restOverrides } = overrides ?? {};
  return {
    id,
    sourceFeatureId: id,
    sourceFeatureIds: [id],
    type: 'railway',
    name: restOverrides?.name ?? id,
    points: points.map((p) => [p[0], p[1]] as [number, number]),
    nodeIds: [...nodeIds],
    railwayType,
    width: restOverrides?.width ?? 4.0,
    isBridge,
    isTunnel,
    layer,
    gauge: 1435,
    electrified: true,
    cartoLabel: restOverrides?.name ?? id,
    primaryTag: `railway=${railwayType}`,
    osmTags: {
      railway: railwayType,
      ...(isBridge ? { bridge: 'yes', layer: String(layer) } : {}),
      ...(isTunnel ? { tunnel: 'yes', layer: String(layer) } : {}),
      ...(service ? { service } : {}),
      ...(usage ? { usage } : {}),
      ...(restOverrides?.osmTags || {}),
    },
    ...restOverrides,
  };
}

/**
 * Extracts all world-space vertices `[x, y, z]` belonging to a given `sourceFeatureId`
 * from a mesh or group of meshes using `userData.faceRanges`.
 */
function extractFeatureVerticesFromGroup(
  group: THREE.Group,
  meshNameFilter: (name: string) => boolean,
  sourceFeatureId: string
): Array<[number, number, number]> {
  const vertices: Array<[number, number, number]> = [];
  group.updateMatrixWorld(true);
  const v = new THREE.Vector3();

  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (!meshNameFilter(obj.name)) return;
    const geom = obj.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const index = geom.getIndex();
    const ranges = obj.userData?.faceRanges as
      | Array<{ startFace: number; endFace: number; info: { id: string; sourceFeatureId: string; sourceFeatureIds?: string[] } }>
      | undefined;

    if (!ranges || ranges.length === 0) return;

    const visitedVertIndices = new Set<number>();
    for (const r of ranges) {
      const matches =
        r.info.id === sourceFeatureId ||
        r.info.sourceFeatureId === sourceFeatureId ||
        Boolean(r.info.sourceFeatureIds?.includes(sourceFeatureId));
      if (!matches) continue;

      for (let f = r.startFace; f < r.endFace; f++) {
        const i0 = index ? index.getX(f * 3) : f * 3;
        const i1 = index ? index.getX(f * 3 + 1) : f * 3 + 1;
        const i2 = index ? index.getX(f * 3 + 2) : f * 3 + 2;
        for (const idx of [i0, i1, i2]) {
          if (visitedVertIndices.has(idx)) continue;
          visitedVertIndices.add(idx);
          v.fromBufferAttribute(pos, idx).applyMatrix4(obj.matrixWorld);
          vertices.push([v.x, v.y, v.z]);
        }
      }
    }
  });

  return vertices;
}

/**
 * Finds the minimum and maximum Y values of vertices for `sourceFeatureId` within `radius` (meters)
 * of a 2D target point `[px, pz]`.
 */
function sampleElevationNearPoint(
  vertices: ReadonlyArray<readonly [number, number, number]>,
  pt: readonly [number, number],
  radius: number = 0.6
): { count: number; minY: number; maxY: number; minPlanarDist: number } {
  let minY = Infinity;
  let maxY = -Infinity;
  let minPlanarDist = Infinity;
  let count = 0;

  for (const [x, y, z] of vertices) {
    const d = Math.hypot(x - pt[0], z - pt[1]);
    if (d < minPlanarDist) minPlanarDist = d;
    if (d <= radius) {
      count++;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { count, minY, maxY, minPlanarDist };
}

/**
 * Counts vertical abutment headwall triangles (triangles in `Bridge_Substructure` or
 * `Railway_Bridge_Substructure` whose vertices lie at a given `[px, pz]` portal within `radius`
 * and span down to `groundY = 0` while having a horizontal normal along the track tangent).
 */
function countVerticalAbutmentHeadwallTrianglesNearPoint(
  group: THREE.Group,
  substructureMeshPrefix: string,
  pt: readonly [number, number],
  radius: number = 3.0
): number {
  let headwallTris = 0;
  group.updateMatrixWorld(true);
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const normal = new THREE.Vector3();

  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (!obj.name.startsWith(substructureMeshPrefix)) return;
    const geom = obj.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const index = geom.getIndex();
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);

    for (let f = 0; f < triCount; f++) {
      const i0 = index ? index.getX(f * 3) : f * 3;
      const i1 = index ? index.getX(f * 3 + 1) : f * 3 + 1;
      const i2 = index ? index.getX(f * 3 + 2) : f * 3 + 2;
      v0.fromBufferAttribute(pos, i0).applyMatrix4(obj.matrixWorld);
      v1.fromBufferAttribute(pos, i1).applyMatrix4(obj.matrixWorld);
      v2.fromBufferAttribute(pos, i2).applyMatrix4(obj.matrixWorld);

      const cx = (v0.x + v1.x + v2.x) / 3;
      const cz = (v0.z + v1.z + v2.z) / 3;
      if (Math.hypot(cx - pt[0], cz - pt[1]) > radius) continue;

      const minY = Math.min(v0.y, v1.y, v2.y);
      const maxY = Math.max(v0.y, v1.y, v2.y);
      e1.subVectors(v1, v0);
      e2.subVectors(v2, v0);
      normal.crossVectors(e1, e2).normalize();

      // A vertical headwall spans from ground (minY <= 0.05) to elevated deck (maxY >= 1.0)
      // with a near-horizontal normal (|normal.y| < 0.25)
      if (minY <= 0.05 && maxY >= 1.0 && Math.abs(normal.y) < 0.25) {
        headwallTris++;
      }
    }
  });

  return headwallTris;
}

describe('Milestone 2.3 Stage E4-A: Graph-Driven Bridge & Tunnel Transitions (TKT-013)', () => {
  const defaultTheme: MapStyleTheme = MAP_THEMES.tactical;

  it('1. Simple road bridge approach (confirmed_transition): connects at-grade roads to bridge ramp with < 0.01 m portal continuity and suppresses caps in E2 and E2+', () => {
    const data = createEmptyMapData();
    data.roads = [
      makeRoad('way/road-west', [[-60, 0], [-25, 0]], ['n1', 'n2'], { roadClass: 'tertiary', width: 8 }),
      makeRoad('way/road-bridge', [[-25, 0], [25, 0]], ['n2', 'n3'], {
        roadClass: 'tertiary',
        width: 8,
        isBridge: true,
        layer: 1,
      }),
      makeRoad('way/road-east', [[25, 0], [60, 0]], ['n3', 'n4'], { roadClass: 'tertiary', width: 8 }),
    ];

    for (const roadMode of ['graph', 'graph-surface'] as const) {
      const builder = new GeometryBuilder({
        infrastructureRenderOptions: {
          roads: roadMode,
          railways: 'legacy',
        },
      });
      const scene = builder.buildScene(data, defaultTheme);

      const diag = scene.roadsGroup.userData.gradeTransitionDiagnostics as GradeTransitionRenderDiagnostics;
      assert.ok(diag, `Expected gradeTransitionDiagnostics on roadsGroup in ${roadMode} mode`);
      assert.equal(diag.mode, 'graph');
      assert.equal(diag.confirmedTransitionsConsumed, 2);
      assert.equal(diag.legacyFallbacksCount, 0);

      const westVerts = extractFeatureVerticesFromGroup(
        scene.roadsGroup,
        (n) => n === 'Roads_tertiary',
        'way/road-west'
      );
      const bridgeVerts = extractFeatureVerticesFromGroup(
        scene.roadsGroup,
        (n) => n === 'Roads_tertiary',
        'way/road-bridge'
      );
      const eastVerts = extractFeatureVerticesFromGroup(
        scene.roadsGroup,
        (n) => n === 'Roads_tertiary',
        'way/road-east'
      );

      assert.ok(westVerts.length >= 4 && bridgeVerts.length >= 8 && eastVerts.length >= 4);

      // Check west portal [-25, 0] continuity
      const westAtPortal = sampleElevationNearPoint(westVerts, [-25, 0], 4.5);
      const bridgeAtWestPortal = sampleElevationNearPoint(bridgeVerts, [-25, 0], 4.2);
      assert.ok(
        Math.abs(westAtPortal.minY - ELEVATION_POLICY.ROAD_SURFACE) < 0.005,
        `At-grade west road at portal must be at ROAD_SURFACE (0.050m), got ${westAtPortal.minY}`
      );
      assert.ok(
        Math.abs(bridgeAtWestPortal.minY - ELEVATION_POLICY.ROAD_SURFACE) < 0.01,
        `Bridge start at west portal must meet ROAD_SURFACE (0.050m) within 0.01m, got ${bridgeAtWestPortal.minY}`
      );

      // Check east portal [25, 0] continuity
      const eastAtPortal = sampleElevationNearPoint(eastVerts, [25, 0], 4.5);
      const bridgeAtEastPortal = sampleElevationNearPoint(bridgeVerts, [25, 0], 4.2);
      assert.ok(
        Math.abs(bridgeAtEastPortal.minY - eastAtPortal.minY) < 0.01,
        `Bridge end at east portal must meet east road within 0.01m`
      );

      // Check mid-span peak elevation
      const maxBridgeY = Math.max(...bridgeVerts.map((v) => v[1]));
      const expectedDeckY = getRoadElevation('tertiary', 1, true, false, 'way/road-bridge');
      assert.ok(
        Math.abs(maxBridgeY - expectedDeckY) < 0.01,
        `Bridge mid-span must reach full deck elevation ${expectedDeckY}m, got ${maxBridgeY}m`
      );

      // Verify cap suppression at portals: west road max X must not protrude past x = -25.0 + 0.01
      const maxWestX = Math.max(...westVerts.map((v) => v[0]));
      const minEastX = Math.min(...eastVerts.map((v) => v[0]));
      assert.ok(
        Math.abs(maxWestX - -25) < 0.01,
        `At-grade west road must terminate flat at portal x=-25 without round cap protrusion (maxWestX=${maxWestX})`
      );
      assert.ok(
        Math.abs(minEastX - 25) < 0.01,
        `At-grade east road must terminate flat at portal x=25 without round cap protrusion (minEastX=${minEastX})`
      );

      // Verify integrity and 0 overlaps
      const integrity = auditGraphRoadMeshIntegrity(scene.roadsGroup);
      assert.equal(integrity.negativelyWoundCount, 0);
      const val = validateRoadNetworkGeometry(scene);
      assert.equal(val.isValid, true);

      scene.dispose();
    }
  });

  it('2. Simple railway bridge approach (confirmed_transition) & Scenario 10 (R+ ballast compatibility): connects ballast, sleepers, and rails smoothly across portals', () => {
    const data = createEmptyMapData();
    data.railways = [
      makeRailway('way/rail-west', [[-70, 0], [-30, 0]], ['rn1', 'rn2']),
      makeRailway('way/rail-bridge', [[-30, 0], [30, 0]], ['rn2', 'rn3'], {
        isBridge: true,
        layer: 1,
      }),
      makeRailway('way/rail-east', [[30, 0], [70, 0]], ['rn3', 'rn4']),
    ];

    for (const railMode of ['graph', 'graph-switches', 'graph-R+'] as const) {
      const res = buildRailwayInfrastructure(data, defaultTheme, 6.0, {
        renderSource: railMode,
        spatialChunkSizeMeters: 0,
      });

      const diag = res.stats.gradeTransitionDiagnostics;
      assert.ok(diag, `Expected gradeTransitionDiagnostics in ${railMode}`);
      assert.equal(diag.mode, 'graph');
      assert.equal(diag.confirmedTransitionsConsumed, 2);
      assert.equal(diag.legacyFallbacksCount, 0);

      // Check ballast vertices on bridge and at-grade approaches
      const bridgeBallastVerts = extractFeatureVerticesFromGroup(
        res.railwaysGroup,
        (n) => n.startsWith('Railway_Ballast'),
        'way/rail-bridge'
      );
      assert.ok(bridgeBallastVerts.length >= 8, 'Expected bridge ballast vertices');

      const westPortalSample = sampleElevationNearPoint(bridgeBallastVerts, [-30, 0], 2.5);
      const eastPortalSample = sampleElevationNearPoint(bridgeBallastVerts, [30, 0], 2.5);
      const maxBridgeBallastY = Math.max(...bridgeBallastVerts.map((v) => v[1]));

      assert.ok(
        Math.abs(westPortalSample.minY - ELEVATION_POLICY.RAILWAY_BALLAST) < 0.01,
        `Bridge ballast at west portal must start at RAILWAY_BALLAST (0.060m), got ${westPortalSample.minY}`
      );
      assert.ok(
        Math.abs(eastPortalSample.minY - ELEVATION_POLICY.RAILWAY_BALLAST) < 0.01,
        `Bridge ballast at east portal must end at RAILWAY_BALLAST (0.060m), got ${eastPortalSample.minY}`
      );
      const expectedBridgeBallastY = getRailwayElevations(1, true, false).ballast;
      assert.ok(
        Math.abs(maxBridgeBallastY - expectedBridgeBallastY) < 0.01,
        `Bridge ballast mid-span must reach ${expectedBridgeBallastY}m, got ${maxBridgeBallastY}`
      );

      // Check 3D rails continuity at portals
      const bridgeRailVerts = extractFeatureVerticesFromGroup(
        res.railwaysGroup,
        (n) => n.startsWith('Railway_Rails_3D'),
        'way/rail-bridge'
      );
      const westRailSample = sampleElevationNearPoint(bridgeRailVerts, [-30, 0], 1.5);
      assert.ok(
        Math.abs(westRailSample.minY - ELEVATION_POLICY.RAILWAY_RAILS) < 0.015,
        `Bridge 3D rail base at west portal must meet at-grade rail elevation, got ${westRailSample.minY}`
      );

      // In graph-R+ mode, verify at-grade ballast suppresses round cap at the portal x=-30 and x=30
      if (railMode === 'graph-R+') {
        const westBallastVerts = extractFeatureVerticesFromGroup(
          res.railwaysGroup,
          (n) => n.startsWith('Railway_Ballast'),
          'way/rail-west'
        );
        const maxWestBallastX = Math.max(...westBallastVerts.map((v) => v[0]));
        assert.ok(
          Math.abs(maxWestBallastX - -30) < 0.02,
          `R+ at-grade ballast must not protrude past portal x=-30 with a round cap (got maxX=${maxWestBallastX})`
        );
      }

      res.dispose();
    }
  });

  it('3. Multi-segment bridge continuation (confirmed_elevated_continuation): maintains elevated profile across short portal edges and multi-segment spans without internal abutment cliffs', () => {
    const data = createEmptyMapData();
    // Includes a 2.5m short portal bridge segment ('way/rail-bridge-short-portal')
    // followed by a 25m main bridge segment ('way/rail-bridge-main') and a layer=2 high span ('way/rail-bridge-layer2'),
    // plus an elevated station embankment ('way/rail-station-embankment', layer=1, isBridge=false).
    // In legacy mode, the 2.5m segment (< 5.0m) triggered 'abutment_headwall' (0m ramp) and a 2.8m cliff!
    data.railways = [
      makeRailway('way/rail-approach-w', [[-60, 0], [-30, 0]], ['n1', 'n2']),
      makeRailway('way/rail-bridge-short-portal', [[-30, 0], [-27.5, 0]], ['n2', 'n3'], {
        isBridge: true,
        layer: 1,
        railwayType: 'rail',
      }),
      makeRailway('way/rail-bridge-main', [[-27.5, 0], [0, 0]], ['n3', 'n4'], {
        isBridge: true,
        layer: 1,
        railwayType: 'light_rail', // distinct railwayType prevents edge simplification from merging n3
      }),
      makeRailway('way/rail-station-embankment', [[0, 0], [20, 0]], ['n4', 'n5'], {
        isBridge: false,
        layer: 1,
        railwayType: 'rail',
      }),
      makeRailway('way/rail-bridge-east', [[20, 0], [45, 0]], ['n5', 'n6'], {
        isBridge: true,
        layer: 1,
        railwayType: 'rail',
      }),
      makeRailway('way/rail-approach-e', [[45, 0], [80, 0]], ['n6', 'n7']),
    ];

    const res = buildRailwayInfrastructure(data, defaultTheme, 6.0, {
      renderSource: 'graph-switches',
      spatialChunkSizeMeters: 0,
    });

    const diag = res.stats.gradeTransitionDiagnostics!;
    assert.equal(diag.confirmedTransitionsConsumed, 2);
    assert.ok(diag.confirmedElevatedContinuations >= 3);

    const shortPortalVerts = extractFeatureVerticesFromGroup(
      res.railwaysGroup,
      (n) => n.startsWith('Railway_Ballast'),
      'way/rail-bridge-short-portal'
    );
    const mainBridgeVerts = extractFeatureVerticesFromGroup(
      res.railwaysGroup,
      (n) => n.startsWith('Railway_Ballast'),
      'way/rail-bridge-main'
    );

    // At x = -30 (confirmed transition portal), short portal edge starts at at-grade ballast (0.060m)
    const atWestPortal = sampleElevationNearPoint(shortPortalVerts, [-30, 0], 2.0);
    assert.ok(
      Math.abs(atWestPortal.minY - ELEVATION_POLICY.RAILWAY_BALLAST) < 0.01,
      `Short 2.5m portal edge must start at ground elevation 0.060m instead of a 2.8m cliff, got ${atWestPortal.minY}`
    );

    // At x = -27.5 (internal continuation joint n3 between short portal edge and main bridge),
    // both edges must meet at the exact same intermediate ramp elevation!
    const shortAtJoint = sampleElevationNearPoint(shortPortalVerts, [-27.5, 0], 2.0);
    const mainAtJoint = sampleElevationNearPoint(mainBridgeVerts, [-27.5, 0], 2.0);
    assert.ok(
      Math.abs(shortAtJoint.maxY - mainAtJoint.minY) < 0.01,
      `Short portal edge (${shortAtJoint.maxY}) and main bridge (${mainAtJoint.minY}) must meet continuously at x=-27.5`
    );
    assert.ok(
      shortAtJoint.maxY > ELEVATION_POLICY.RAILWAY_BALLAST + 0.1 &&
        shortAtJoint.maxY < getRailwayElevations(1, true, false).ballast - 0.1,
      `Joint at x=-27.5m (2.5m along 12m ramp) must be at intermediate ramp height, got ${shortAtJoint.maxY}`
    );

    // Verify 0 vertical abutment headwalls at internal bridge-to-bridge joint [-27.5, 0] and [0, 0]
    const internalHeadwalls = countVerticalAbutmentHeadwallTrianglesNearPoint(
      res.railwaysGroup,
      'Railway_Bridge_Substructure',
      [-27.5, 0],
      1.5
    );
    assert.equal(
      internalHeadwalls,
      0,
      'Internal bridge-to-bridge continuation at [-27.5, 0] must not emit a vertical abutment headwall to ground'
    );

    res.dispose();
  });

  it('4. Parallel tracks across a railway bridge: transitions each parallel track independently without cross-track interference', () => {
    const data = createEmptyMapData();
    // Two parallel tracks separated by 2.2m (within 3.5m ballast width, and within 0.8m if converging)
    data.railways = [
      makeRailway('way/trackA-west', [[-60, -1.1], [-25, -1.1]], ['a1', 'a2']),
      makeRailway('way/trackA-bridge', [[-25, -1.1], [25, -1.1]], ['a2', 'a3'], {
        isBridge: true,
        layer: 1,
      }),
      makeRailway('way/trackA-east', [[25, -1.1], [60, -1.1]], ['a3', 'a4']),

      makeRailway('way/trackB-west', [[-60, 1.1], [-25, 1.1]], ['b1', 'b2']),
      makeRailway('way/trackB-bridge', [[-25, 1.1], [25, 1.1]], ['b2', 'b3'], {
        isBridge: true,
        layer: 1,
      }),
      makeRailway('way/trackB-east', [[25, 1.1], [60, 1.1]], ['b3', 'b4']),
    ];

    const res = buildRailwayInfrastructure(data, defaultTheme, 6.0, {
      renderSource: 'graph-R+',
      spatialChunkSizeMeters: 0,
    });

    assert.equal(res.stats.gradeTransitionDiagnostics?.confirmedTransitionsConsumed, 4);

    for (const [bridgeId, z] of [
      ['way/trackA-bridge', -1.1],
      ['way/trackB-bridge', 1.1],
    ] as const) {
      const verts = extractFeatureVerticesFromGroup(
        res.railwaysGroup,
        (n) => n.startsWith('Railway_Ballast'),
        bridgeId
      );
      const startSample = sampleElevationNearPoint(verts, [-25, z], 2.5);
      const midSample = sampleElevationNearPoint(verts, [0, z], 3.5);
      const endSample = sampleElevationNearPoint(verts, [25, z], 2.5);

      assert.ok(Math.abs(startSample.minY - ELEVATION_POLICY.RAILWAY_BALLAST) < 0.01);
      assert.ok(Math.abs(endSample.minY - ELEVATION_POLICY.RAILWAY_BALLAST) < 0.01);
      assert.ok(Math.abs(midSample.maxY - getRailwayElevations(1, true, false).ballast) < 0.01);
    }

    res.dispose();
  });

  it('5. Switch / turnout near and at a bridge portal (Defect Classes 1 & 2): eliminates sibling-track proximity cliffs and aligns 3D switch elevations', () => {
    const data = createEmptyMapData();
    // Case A: Turnout at [-30, 0] right at the bridge portal!
    // At-grade trunk 'way/trunk-ag' ([-70, 0] -> [-30, 0]) splits at node 'sw_portal' into:
    //   1) Straight bridge mainline 'way/bridge-main' ([-30, 0] -> [30, 0], isBridge=true, layer=1)
    //   2) Diverging bridge branch 'way/bridge-div' ([-30, 0] -> [0, 3.0] -> [30, 4.0], isBridge=true, layer=1, service=siding)
    // At [-30, 0], 'way/bridge-main' and 'way/bridge-div' share node 'sw_portal' (distance = 0.0m <= 0.8m!).
    // In legacy mode, connectsStartBridge was TRUE for both bridge branches because they were 0.0m apart,
    // which overrode connectsStartAtGrade and created a 2.80m vertical cliff on BOTH bridge tracks!
    data.railways = [
      makeRailway('way/trunk-ag', [[-70, 0], [-30, 0]], ['n_w', 'sw_portal']),
      makeRailway('way/bridge-main', [[-30, 0], [30, 0]], ['sw_portal', 'n_e_main'], {
        isBridge: true,
        layer: 1,
      }),
      makeRailway(
        'way/bridge-div',
        [
          [-30, 0],
          [0, 2.5],
          [30, 4.0],
        ],
        ['sw_portal', 'n_mid_div', 'n_e_div'],
        {
          isBridge: true,
          layer: 1,
          service: 'siding',
        }
      ),
      makeRailway('way/east-main-ag', [[30, 0], [70, 0]], ['n_e_main', 'n_far_main']),
      makeRailway('way/east-div-ag', [[30, 4.0], [70, 4.0]], ['n_e_div', 'n_far_div'], {
        service: 'siding',
      }),
    ];

    const res = buildRailwayInfrastructure(data, defaultTheme, 6.0, {
      renderSource: 'graph-switches',
      spatialChunkSizeMeters: 0,
    });

    const mainVerts = extractFeatureVerticesFromGroup(
      res.railwaysGroup,
      (n) => n.startsWith('Railway_Ballast'),
      'way/bridge-main'
    );
    const divVerts = extractFeatureVerticesFromGroup(
      res.railwaysGroup,
      (n) => n.startsWith('Railway_Ballast'),
      'way/bridge-div'
    );

    const mainAtPortal = sampleElevationNearPoint(mainVerts, [-30, 0], 2.2);
    const divAtPortal = sampleElevationNearPoint(divVerts, [-30, 0], 2.2);

    // Neither branch may have a 2.8m cliff at [-30, 0]; both must start at ground ballast elevation (0.060m)!
    assert.ok(
      Math.abs(mainAtPortal.minY - ELEVATION_POLICY.RAILWAY_BALLAST) < 0.01,
      `Main bridge branch at turnout portal [-30, 0] must ramp from 0.060m (no 2.8m cliff), got ${mainAtPortal.minY}`
    );
    assert.ok(
      Math.abs(divAtPortal.minY - ELEVATION_POLICY.RAILWAY_BALLAST) < 0.01,
      `Diverging bridge branch at turnout portal [-30, 0] must ramp from 0.060m (no 2.8m cliff), got ${divAtPortal.minY}`
    );

    res.dispose();
  });

  it('6. Nearby unconnected infrastructure (< 0.8m, Defect Class 7): never fabricates bridge ramps to nearby unconnected roads or tracks', () => {
    const data = createEmptyMapData();
    // Standalone road bridge at [-25, 0] -> [25, 0] (nodes 'b1', 'b2')
    // Unconnected at-grade cul-de-sac ends at [-25, -0.45] (0.45m away, node 'cul_end' !== 'b1')
    data.roads = [
      makeRoad('way/standalone-bridge', [[-25, 0], [25, 0]], ['b1', 'b2'], {
        roadClass: 'secondary',
        width: 8,
        isBridge: true,
        layer: 1,
      }),
      makeRoad('way/nearby-culdesac', [[-25, -30], [-25, -0.45]], ['cul_start', 'cul_end'], {
        roadClass: 'service',
        width: 5,
      }),
    ];
    // Same for railway: standalone bridge at [-25, 20] -> [25, 20], unconnected siding ends at [-25.35, 20] (0.35m away)
    data.railways = [
      makeRailway('way/standalone-rail-bridge', [[-25, 20], [25, 20]], ['rb1', 'rb2'], {
        isBridge: true,
        layer: 1,
      }),
      makeRailway('way/nearby-unconnected-siding', [[-60, 20], [-25.35, 20]], ['rs1', 'rs2']),
    ];

    const builder = new GeometryBuilder({
      infrastructureRenderOptions: {
        roads: 'graph-surface',
        railways: 'graph-switches',
      },
    });
    const scene = builder.buildScene(data, defaultTheme);

    const roadDiag = scene.roadsGroup.userData.gradeTransitionDiagnostics as GradeTransitionRenderDiagnostics;
    assert.equal(roadDiag.confirmedTransitionsConsumed, 0);
    // Start endpoint (-25, 0) is within 0.45m of the unconnected cul-de-sac with conflicting node ID ('unresolved_connection'),
    // while end endpoint (25, 0) has no nearby road ('intentionally_standalone').
    assert.equal(roadDiag.unresolvedTransitionsCount, 1);
    assert.equal(roadDiag.intentionallyStandaloneEndpointsCount, 1);

    const bridgeRoadVerts = extractFeatureVerticesFromGroup(
      scene.roadsGroup,
      (n) => n === 'Roads_secondary',
      'way/standalone-bridge'
    );
    const bridgeStartSample = sampleElevationNearPoint(bridgeRoadVerts, [-25, 0], 4.5);
    const expectedRoadBridgeY = getRoadElevation('secondary', 1, true, false, 'way/standalone-bridge');
    assert.ok(
      Math.abs(bridgeStartSample.minY - expectedRoadBridgeY) < 0.01,
      `Standalone road bridge must stay at elevated deck height ${expectedRoadBridgeY}m at [-25, 0] instead of ramping down to nearby unconnected cul-de-sac, got ${bridgeStartSample.minY}`
    );

    const railDiag = scene.railwaysGroup.userData.gradeTransitionDiagnostics as GradeTransitionRenderDiagnostics;
    assert.equal(railDiag.confirmedTransitionsConsumed, 0);

    const bridgeRailVerts = extractFeatureVerticesFromGroup(
      scene.railwaysGroup,
      (n) => n.startsWith('Railway_Ballast'),
      'way/standalone-rail-bridge'
    );
    const railBridgeStartSample = sampleElevationNearPoint(bridgeRailVerts, [-25, 20], 2.5);
    const expectedRailBridgeY = getRailwayElevations(1, true, false).ballast;
    assert.ok(
      Math.abs(railBridgeStartSample.minY - expectedRailBridgeY) < 0.01,
      `Standalone railway bridge must stay at elevated deck height ${expectedRailBridgeY}m at [-25, 20] instead of ramping to nearby unconnected siding, got ${railBridgeStartSample.minY}`
    );

    scene.dispose();
  });

  it('7. Boundary-clipped bridge endpoint (boundary_clipped_continuation, Defect Class 4): stays elevated at clip boundary and suppresses synthetic ramp and headwall', () => {
    const data = createEmptyMapData();
    // Bridge connects to at-grade road at west portal [-20, 0] ('n_portal'),
    // and is clipped at the eastern map boundary [40, 0] (empty nodeId '' indicating boundary clip)
    data.roads = [
      makeRoad('way/ag-west', [[-60, 0], [-20, 0]], ['n_w', 'n_portal'], { roadClass: 'primary', width: 9 }),
      makeRoad('way/clipped-bridge', [[-20, 0], [40, 0]], ['n_portal', ''], {
        roadClass: 'primary',
        width: 9,
        isBridge: true,
        layer: 1,
      }),
    ];
    data.railways = [
      makeRailway('way/rail-ag-west', [[-60, 20], [-20, 20]], ['rn_w', 'rn_portal']),
      makeRailway('way/rail-clipped-bridge', [[-20, 20], [40, 20]], ['rn_portal', ''], {
        isBridge: true,
        layer: 1,
      }),
    ];
    data.topologySource = {
      roadParts: [
        {
          id: 'way/ag-west-0',
          sourceFeatureId: 'way/ag-west',
          hasExplicitSourceId: true,
          partIndex: 0,
          roadClass: 'primary',
          points: [[-60, 0], [-20, 0]],
          rawOsmNodeIds: ['n_w', 'n_portal'],
          width: 9,
          layer: 0,
          isBridge: false,
          isTunnel: false,
          isCulvert: false,
          clippedAtStart: false,
          clippedAtEnd: false,
          osmTags: { highway: 'primary' },
        },
        {
          id: 'way/clipped-bridge-0',
          sourceFeatureId: 'way/clipped-bridge',
          hasExplicitSourceId: true,
          partIndex: 0,
          roadClass: 'primary',
          points: [[-20, 0], [40, 0]],
          rawOsmNodeIds: ['n_portal', undefined],
          width: 9,
          layer: 1,
          isBridge: true,
          isTunnel: false,
          isCulvert: false,
          clippedAtStart: false,
          clippedAtEnd: true,
          osmTags: { highway: 'primary', bridge: 'yes', layer: '1' },
        },
      ],
      railwayParts: [
        {
          id: 'way/rail-ag-west-0',
          sourceFeatureId: 'way/rail-ag-west',
          hasExplicitSourceId: true,
          partIndex: 0,
          railwayType: 'rail',
          points: [[-60, 20], [-20, 20]],
          rawOsmNodeIds: ['rn_w', 'rn_portal'],
          width: 4.0,
          layer: 0,
          isBridge: false,
          isTunnel: false,
          clippedAtStart: false,
          clippedAtEnd: false,
          isSecondaryBranch: false,
          osmTags: { railway: 'rail' },
        },
        {
          id: 'way/rail-clipped-bridge-0',
          sourceFeatureId: 'way/rail-clipped-bridge',
          hasExplicitSourceId: true,
          partIndex: 0,
          railwayType: 'rail',
          points: [[-20, 20], [40, 20]],
          rawOsmNodeIds: ['rn_portal', undefined],
          width: 4.0,
          layer: 1,
          isBridge: true,
          isTunnel: false,
          clippedAtStart: false,
          clippedAtEnd: true,
          isSecondaryBranch: false,
          osmTags: { railway: 'rail', bridge: 'yes', layer: '1' },
        },
      ],
      infrastructurePoints: [],
    };

    const builder = new GeometryBuilder({
      infrastructureRenderOptions: {
        roads: 'graph-surface',
        railways: 'graph-switches',
      },
    });
    const scene = builder.buildScene(data, defaultTheme);

    const roadDiag = scene.roadsGroup.userData.gradeTransitionDiagnostics as GradeTransitionRenderDiagnostics;
    assert.equal(roadDiag.confirmedTransitionsConsumed, 1);
    assert.equal(roadDiag.boundaryClippedEndpointsCount, 1);

    const roadBridgeVerts = extractFeatureVerticesFromGroup(
      scene.roadsGroup,
      (n) => n === 'Roads_primary',
      'way/clipped-bridge'
    );
    const westRoadSample = sampleElevationNearPoint(roadBridgeVerts, [-20, 0], 5.0);
    const eastClippedRoadSample = sampleElevationNearPoint(roadBridgeVerts, [40, 0], 5.0);
    const expectedRoadDeckY = getRoadElevation('primary', 1, true, false, 'way/clipped-bridge');

    assert.ok(
      Math.abs(westRoadSample.minY - ELEVATION_POLICY.ROAD_SURFACE) < 0.01,
      'Confirmed west portal must ramp to ground'
    );
    assert.ok(
      Math.abs(eastClippedRoadSample.minY - expectedRoadDeckY) < 0.01,
      `Boundary-clipped east bridge end must remain at full elevated deck height ${expectedRoadDeckY}m, got ${eastClippedRoadSample.minY}`
    );

    // Ensure no synthetic 14m extension was appended past x = 40
    const maxRoadBridgeX = Math.max(...roadBridgeVerts.map((v) => v[0]));
    assert.ok(
      Math.abs(maxRoadBridgeX - 40) < 0.05,
      `Boundary-clipped bridge must not append synthetic approach extension past clip boundary x=40 (got ${maxRoadBridgeX})`
    );

    // Ensure no vertical abutment headwall was emitted at the clip boundary [40, 0]
    const clipBoundaryHeadwalls = countVerticalAbutmentHeadwallTrianglesNearPoint(
      scene.roadsGroup,
      'Bridge_Substructure',
      [40, 0],
      2.0
    );
    assert.equal(clipBoundaryHeadwalls, 0, 'Boundary-clipped bridge end must not emit vertical abutment headwall');

    scene.dispose();
  });

  it('8. Unresolved grade transition (unresolved_connection, Defect Class 5): handles ambiguous multi-way portal candidates conservatively without inventing ramps', () => {
    const data = createEmptyMapData();
    // Road bridge ends at node 'ambig_node' [0, 0] where TWO symmetric at-grade roads meet at equal angles,
    // making the grade transition at 'ambig_node' unresolved (ambiguous_multiple_candidates).
    data.roads = [
      makeRoad('way/bridge-ambig', [[-40, 0], [0, 0]], ['n_start', 'ambig_node'], {
        roadClass: 'secondary',
        width: 8,
        isBridge: true,
        layer: 1,
      }),
      makeRoad('way/ag-branch-1', [[0, 0], [30, 10]], ['ambig_node', 'n_b1'], {
        roadClass: 'secondary',
        width: 8,
      }),
      makeRoad('way/ag-branch-2', [[0, 0], [30, -10]], ['ambig_node', 'n_b2'], {
        roadClass: 'secondary',
        width: 8,
      }),
    ];

    const builder = new GeometryBuilder({
      infrastructureRenderOptions: {
        roads: 'graph-surface',
        railways: 'legacy',
      },
    });
    const scene = builder.buildScene(data, defaultTheme);

    const roadDiag = scene.roadsGroup.userData.gradeTransitionDiagnostics as GradeTransitionRenderDiagnostics;
    assert.equal(roadDiag.confirmedTransitionsConsumed, 0);
    assert.ok(roadDiag.unresolvedTransitionsCount >= 1, 'Expected unresolvedTransitionsCount >= 1');

    const bridgeVerts = extractFeatureVerticesFromGroup(
      scene.roadsGroup,
      (n) => n === 'Roads_secondary',
      'way/bridge-ambig'
    );
    const endSample = sampleElevationNearPoint(bridgeVerts, [0, 0], 4.5);
    const expectedDeckY = getRoadElevation('secondary', 1, true, false, 'way/bridge-ambig');
    assert.ok(
      Math.abs(endSample.minY - expectedDeckY) < 0.01,
      `Unresolved bridge endpoint must remain conservatively at deck elevation ${expectedDeckY}m without inventing a ramp`
    );

    scene.dispose();
  });

  it('9. Simple and multi-segment tunnel portals & Defect Class 6 portal coordinate snapping: emits portals only at true entrances and snaps sub-tolerance coordinate drift', () => {
    const data = createEmptyMapData();
    // Two contiguous railway tunnel segments ('way/tun-1' and 'way/tun-2') between two at-grade approaches.
    // 'way/rail-west-ag' has a 0.03m coordinate drift at its shared portal node 'tp_west' ([-30.03, 0] vs [-30, 0]).
    data.railways = [
      makeRailway('way/rail-west-ag', [[-70, 0], [-30.03, 0]], ['rw1', 'tp_west']),
      makeRailway('way/tun-1', [[-30, 0], [0, 0]], ['tp_west', 'tp_mid'], {
        isTunnel: true,
        layer: -1,
        railwayType: 'rail',
      }),
      makeRailway('way/tun-2', [[0, 0], [30, 0]], ['tp_mid', 'tp_east'], {
        isTunnel: true,
        layer: -1,
        railwayType: 'rail',
        service: 'siding', // keeps tp_mid unmerged as an internal tunnel-to-tunnel continuation node while remaining compatible with rail-east-ag
      }),
      makeRailway('way/rail-east-ag', [[30, 0], [70, 0]], ['tp_east', 're1']),
    ];

    const res = buildRailwayInfrastructure(data, defaultTheme, 6.0, {
      renderSource: 'graph-switches',
      spatialChunkSizeMeters: 0,
      showUndergroundTunnelTraces: true,
    });

    const diag = res.stats.gradeTransitionDiagnostics!;
    assert.equal(diag.confirmedTransitionsConsumed, 2);
    assert.equal(diag.confirmedElevatedContinuations, 2);
    assert.ok(
      diag.correctedPortalDiscontinuitiesCount >= 1,
      `Expected correctedPortalDiscontinuitiesCount >= 1 for the 0.06m drift at tp_west, got ${diag.correctedPortalDiscontinuitiesCount}`
    );

    // Check that tunnel portal structures exist at [-30, 0] and [30, 0],
    // but NOT at the internal underground continuation [0, 0]!
    const portalVerts1 = extractFeatureVerticesFromGroup(
      res.railwaysGroup,
      (n) => n.startsWith('Railway_Tunnel_Portals'),
      'way/tun-1'
    );
    const portalVerts2 = extractFeatureVerticesFromGroup(
      res.railwaysGroup,
      (n) => n.startsWith('Railway_Tunnel_Portals'),
      'way/tun-2'
    );

    const westPortalArch = sampleElevationNearPoint(portalVerts1, [-30, 0], 4.0);
    const midInternalArch1 = sampleElevationNearPoint(portalVerts1, [0, 0], 4.0);
    const midInternalArch2 = sampleElevationNearPoint(portalVerts2, [0, 0], 4.0);
    const eastPortalArch = sampleElevationNearPoint(portalVerts2, [30, 0], 4.0);

    assert.ok(westPortalArch.count > 0, 'Expected tunnel portal arch at west entrance [-30, 0]');
    assert.ok(eastPortalArch.count > 0, 'Expected tunnel portal arch at east entrance [30, 0]');
    assert.equal(midInternalArch1.count, 0, 'Must NOT emit surface tunnel portal arch at internal underground joint [0, 0]');
    assert.equal(midInternalArch2.count, 0, 'Must NOT emit surface tunnel portal arch at internal underground joint [0, 0]');

    // Both underground tunnel segments must emit underground dashed trace geometry
    const traceVerts1 = extractFeatureVerticesFromGroup(
      res.railwaysGroup,
      (n) => n.startsWith('Railway_Tunnel_Traces'),
      'way/tun-1'
    );
    const traceVerts2 = extractFeatureVerticesFromGroup(
      res.railwaysGroup,
      (n) => n.startsWith('Railway_Tunnel_Traces'),
      'way/tun-2'
    );
    assert.ok(traceVerts1.length > 0 && traceVerts2.length > 0, 'Both tunnel segments must emit underground trace');

    res.dispose();
  });

  it('11 & 12. Determinism under feature permutation, 4-theme updates, LOD zoom switching, and zero-leak resource disposal', () => {
    const makeFixtures = (reverseOrder: boolean) => {
      const data = createEmptyMapData();
      const roads = [
        makeRoad('way/r-west', [[-60, 0], [-25, 0]], ['rn1', 'rn2']),
        makeRoad('way/r-bridge', [[-25, 0], [25, 0]], ['rn2', 'rn3'], { isBridge: true, layer: 1 }),
        makeRoad('way/r-east', [[25, 0], [60, 0]], ['rn3', 'rn4']),
        makeRoad('way/r-tun-w', [[-60, 25], [-20, 25]], ['tn1', 'tn2']),
        makeRoad('way/r-tunnel', [[-20, 25], [20, 25]], ['tn2', 'tn3'], { isTunnel: true, layer: -1 }),
        makeRoad('way/r-tun-e', [[20, 25], [60, 25]], ['tn3', 'tn4']),
      ];
      const railways = [
        makeRailway('way/rl-west', [[-70, -25], [-25, -25]], ['rln1', 'rln2']),
        makeRailway('way/rl-bridge', [[-25, -25], [25, -25]], ['rln2', 'rln3'], { isBridge: true, layer: 1 }),
        makeRailway('way/rl-east', [[25, -25], [70, -25]], ['rln3', 'rln4']),
      ];
      data.roads = reverseOrder ? [...roads].reverse() : roads;
      data.railways = reverseOrder ? [...railways].reverse() : railways;
      return data;
    };

    const builder = new GeometryBuilder({
      infrastructureRenderOptions: {
        roads: 'graph-surface',
        railways: 'graph-R+',
      },
    });
    const sceneA = builder.buildScene(makeFixtures(false), defaultTheme);
    const sceneB = builder.buildScene(makeFixtures(true), defaultTheme);

    assert.equal(sceneA.stats.totalVertices, sceneB.stats.totalVertices);
    assert.equal(sceneA.stats.totalTriangles, sceneB.stats.totalTriangles);
    assert.deepEqual(
      { ...sceneA.roadsGroup.userData.gradeTransitionDiagnostics, bridgeAndTunnelBuildTimeMs: 0 },
      { ...sceneB.roadsGroup.userData.gradeTransitionDiagnostics, bridgeAndTunnelBuildTimeMs: 0 }
    );
    assert.deepEqual(
      { ...sceneA.railwaysGroup.userData.gradeTransitionDiagnostics, bridgeAndTunnelBuildTimeMs: 0 },
      { ...sceneB.railwaysGroup.userData.gradeTransitionDiagnostics, bridgeAndTunnelBuildTimeMs: 0 }
    );

    // Exercise all 4 map themes and LOD zoom switching
    for (const theme of Object.values(MAP_THEMES)) {
      sceneA.updateTheme(theme);
    }
    sceneA.updateCameraZoom(1.5);
    sceneA.updateCameraZoom(7.5);
    sceneA.updateCameraZoom(2.0);

    assert.ok(sceneA.resources.ownedGeometriesCount > 0);
    sceneA.dispose();
    sceneB.dispose();
    assert.equal(sceneA.resources.ownedGeometriesCount, 0, 'Expected 0 leaked geometries after dispose()');
    assert.equal(sceneA.resources.ownedMaterialsCount, 0, 'Expected 0 leaked materials after dispose()');
  });

  it('13. Real-world benchmark fixtures (Station Hengelo & Amsterdam Centraal): resolves real railway bridge transitions without cliffs and preserves legacy defaults', () => {
    // 1. Default mode remains legacy
    const previewDefault = prepareInfrastructureRenderPreview(createEmptyMapData());
    assert.equal(previewDefault.options.roads, 'legacy');
    assert.equal(previewDefault.options.railways, 'legacy');

    // 2. Load Station Hengelo & Amsterdam Centraal benchmark fixtures
    const extractPath = path.resolve(process.cwd(), 'src/world/prototype/realOsmRailwayExtracts.json');
    const rawExtract = JSON.parse(fs.readFileSync(extractPath, 'utf8'));
    const provider = new LocalGeoJsonProvider();

    for (const key of ['hengelo', 'amsterdamCentraal'] as const) {
      const rawRegion = rawExtract.regions[key];
      const parsed = provider.parseGeoJson({
        type: 'FeatureCollection',
        name: key === 'hengelo' ? 'Station Hengelo' : 'Amsterdam Centraal',
        features: rawRegion.features || rawRegion,
      } as any);
      const resLegacy = buildRailwayInfrastructure(parsed, defaultTheme, 4.5, {
        renderSource: 'legacy',
      });
      const resGraph = buildRailwayInfrastructure(parsed, defaultTheme, 4.5, {
        renderSource: 'graph-switches',
      });
      const resRPlus = buildRailwayInfrastructure(parsed, defaultTheme, 4.5, {
        renderSource: 'graph-R+',
      });

      assert.equal(resLegacy.stats.gradeTransitionDiagnostics?.mode, 'legacy');
      assert.equal(resGraph.stats.gradeTransitionDiagnostics?.mode, 'graph');
      assert.equal(resRPlus.stats.gradeTransitionDiagnostics?.mode, 'graph');

      if (key === 'amsterdamCentraal') {
        assert.ok(
          (resGraph.stats.gradeTransitionDiagnostics?.confirmedTransitionsConsumed ?? 0) >= 50,
          `Expected Amsterdam Centraal to consume >= 50 confirmed grade transitions, got ${resGraph.stats.gradeTransitionDiagnostics?.confirmedTransitionsConsumed}`
        );
        assert.ok(
          (resGraph.stats.gradeTransitionDiagnostics?.confirmedElevatedContinuations ?? 0) >= 250,
          `Expected Amsterdam Centraal to resolve >= 250 confirmed elevated continuations, got ${resGraph.stats.gradeTransitionDiagnostics?.confirmedElevatedContinuations}`
        );

        // Verify the previously reported short portal edges (e.g. way/1009641791 2.41m and way/547532273 3.32m)
        // now start at at-grade ballast elevation (0.060m) at their confirmed transition portal instead of a 2.86m cliff!
        for (const edgeId of ['railway_edge:way/1009641791-0:seg_0', 'railway_edge:way/547532273-0:seg_0']) {
          const verts = extractFeatureVerticesFromGroup(
            resGraph.railwaysGroup,
            (n) => n.startsWith('Railway_Ballast'),
            edgeId
          );
          if (verts.length > 0) {
            const minY = Math.min(...verts.map((v) => v[1]));
            assert.ok(
              Math.abs(minY - ELEVATION_POLICY.RAILWAY_BALLAST) < 0.02,
              `Short Amsterdam Centraal portal edge ${edgeId} must start at ground ballast elevation (0.060m) instead of a 2.86m cliff, got minY=${minY}`
            );
          }
        }
      }

      resLegacy.dispose();
      resGraph.dispose();
      resRPlus.dispose();
    }
  });
});
