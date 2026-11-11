import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  buildUvRibbonGeometry2D,
  buildUvRibbonGeometry3D,
  subdivideSharpPolylineCorners2D,
} from './infrastructure/rendering/UvRibbonBuilder';
import {
  configureProceduralRailMaterial,
  configureProceduralSleeperMaterial,
} from './infrastructure/rendering/InfrastructureShaderChunks';
import {
  computeContinuousTrackPhases,
  HostTrackSpatialIndex,
  isTurnoutThroatPair,
  RAILWAY_DIMENSION_SPEC,
  sortRailwaysMainlineFirst,
  subtractIntervalFromList,
  subtractLateralInterval,
} from './infrastructure/railways/RailwayTopology';
import { buildRailwayInfrastructure } from './infrastructure/railways/RailwayGeometryBuilder';
import { GeometryBuilder, resolveInspectedFeature, SceneResourceManager } from './GeometryBuilder';
import { ELEVATION_POLICY, getRailwayElevations } from './ElevationPolicy';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { MAP_THEMES } from '../styles/mapThemes';
import { ProcessedMapData, RailwayFeature } from '../types/MapFeature';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createBaseMapData(railways: RailwayFeature[]): ProcessedMapData {
  return {
    regionName: 'RailwayRendering Unit Test Fixture',
    centerLonLat: [6.7935, 52.2625],
    bounds: {
      minX: -200,
      maxX: 200,
      minZ: -100,
      maxZ: 100,
      widthMeters: 400,
      depthMeters: 200,
    },
    buildings: [],
    roads: [],
    railways,
    water: [],
    waterBodies: [],
    linearWaterways: [],
    parks: [],
    landuse: [],
    barriers: [],
    landmarks: [],
    stats: {
      totalBuildings: 0,
      totalRoads: 0,
      totalRoadSegments: 0,
      totalRailways: railways.length,
      totalRailwaySegments: railways.length,
      totalWaterPolygons: 0,
      totalLinearWaterways: 0,
      totalParkPolygons: 0,
      totalLandusePolygons: 0,
      totalBarriers: 0,
      totalLandmarks: 0,
      areaKm2: 0.08,
    },
    diagnostics: {
      totalFeaturesReceived: railways.length,
      sourceFeaturesReceived: railways.length,
      sourceFeaturesClassified: railways.length,
      totalFeaturesParsed: railways.length,
      sourceFeaturesRendered: 0,
      totalFeaturesRendered: 0,
      constructedMeshesCount: 0,
      parsedByCategory: {
        buildings: 0,
        roads: 0,
        railways: railways.length,
        waterBodies: 0,
        linearWaterways: 0,
        parks: 0,
        landuse: 0,
        barriers: 0,
        landmarks: 0,
      },
      cartoSubtypesCount: {},
      byGeometryType: {
        Point: 0,
        MultiPoint: 0,
        LineString: railways.length,
        MultiLineString: 0,
        Polygon: 0,
        MultiPolygon: 0,
        GeometryCollection: 0,
        Unknown: 0,
      },
      geometryPartsGenerated: {
        total: 0,
        byCategory: {
          buildings: 0,
          roads: 0,
          railways: 0,
          waterBodies: 0,
          linearWaterways: 0,
          parks: 0,
          landuse: 0,
          barriers: 0,
          landmarks: 0,
        },
      },
      skippedUnsupported: { total: 0, byTag: {} },
      rejectedInvalid: { total: 0, byReason: {} },
    },
  };
}

test('UvRibbonBuilder: generates continuous arc-length U, signed lateral V, upward normals, and sharp-corner bevels', () => {
  const rawPts: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10], // 90-degree sharp corner -> 3-point chamfer subdivision
  ];

  const subdivided = subdivideSharpPolylineCorners2D(rawPts);
  assert.equal(
    subdivided.length,
    5,
    '90-degree corner must be subdivided into a 3-point chamfered transition (start + 3 chamfer pts + end)'
  );

  const ribbon2D = buildUvRibbonGeometry2D(rawPts, 0.085, {
    width: 2.5,
    startPhaseU: 1.25,
  });
  assert.ok(ribbon2D, 'buildUvRibbonGeometry2D must return a valid BufferGeometry');

  const pos = ribbon2D.attributes.position;
  const norm = ribbon2D.attributes.normal;
  const uv = ribbon2D.attributes.uv;
  assert.equal(pos.count, subdivided.length * 2, '2 vertices per station');

  let prevU = -Infinity;
  for (let i = 0; i < subdivided.length; i++) {
    const vLeft = i * 2;
    const vRight = i * 2 + 1;

    // Upward normal [0, 1, 0]
    assert.equal(norm.getX(vLeft), 0);
    assert.equal(norm.getY(vLeft), 1);
    assert.equal(norm.getZ(vLeft), 0);

    // Elevation Y = 0.085
    assert.ok(Math.abs(pos.getY(vLeft) - 0.085) < 1e-6);
    assert.ok(Math.abs(pos.getY(vRight) - 0.085) < 1e-6);

    // Continuous non-decreasing arc-length U starting at startPhaseU = 1.25
    const uLeft = uv.getX(vLeft);
    const uRight = uv.getX(vRight);
    assert.ok(Math.abs(uLeft - uRight) < 1e-6, 'Left and right vertices share identical station U');
    assert.ok(uLeft >= prevU, `Arc-length U must be monotonically non-decreasing (${uLeft} >= ${prevU})`);
    prevU = uLeft;

    // Signed lateral V = ±halfWidth (±1.25m)
    assert.ok(Math.abs(uv.getY(vLeft) - 1.25) < 1e-5, 'Left vertex V must equal +halfWidth');
    assert.ok(Math.abs(uv.getY(vRight) + 1.25) < 1e-5, 'Right vertex V must equal -halfWidth');
  }
  assert.ok(Math.abs(uv.getX(0) - 1.25) < 1e-5, 'Initial station U must equal startPhaseU');

  // 3D ramp ribbon test
  const pts3D = [
    { x: 0, y: 0.055, z: 0, arcLength: 0 },
    { x: 20, y: 3.055, z: 0, arcLength: 20 },
    { x: 40, y: 6.055, z: 0, arcLength: 40 },
  ];
  const ribbon3D = buildUvRibbonGeometry3D(pts3D, { width: 3.6, startPhaseU: 0.5 });
  assert.ok(ribbon3D, 'buildUvRibbonGeometry3D must return a valid 3D BufferGeometry');
  assert.ok(
    Math.abs(ribbon3D.attributes.uv.getX(4) - 40.5) < 1e-4,
    'Final 3D ribbon station U must equal startPhaseU + arcLength'
  );
});

test('RailwayTopology: chains mainline tracks first and propagates continuous arc-length phases across split ways', () => {
  const tracks: RailwayFeature[] = [
    {
      id: 'crossover-branch',
      type: 'railway',
      sourceFeatureId: 'way/100',
      name: 'Crossover',
      railwayType: 'rail',
      width: 3.8,
      layer: 0,
      isBridge: false,
      isTunnel: false,
      osmTags: { railway: 'rail', service: 'crossover' },
      points: [
        [10, 0],
        [40, 4.0],
      ],
    },
    {
      id: 'main-seg-1',
      type: 'railway',
      sourceFeatureId: 'way/101',
      name: 'Mainline West',
      railwayType: 'rail',
      width: 3.8,
      layer: 0,
      isBridge: false,
      isTunnel: false,
      osmTags: { railway: 'rail', usage: 'main' },
      points: [
        [0, 0],
        [10, 0],
      ],
    },
    {
      id: 'main-seg-2',
      type: 'railway',
      sourceFeatureId: 'way/102',
      name: 'Mainline Mid (short 0.8m split)',
      railwayType: 'rail',
      width: 3.8,
      layer: 0,
      isBridge: false,
      isTunnel: false,
      osmTags: { railway: 'rail', usage: 'main' },
      points: [
        [10, 0],
        [10.8, 0],
      ],
    },
    {
      id: 'main-seg-3',
      type: 'railway',
      sourceFeatureId: 'way/103',
      name: 'Mainline East',
      railwayType: 'rail',
      width: 3.8,
      layer: 0,
      isBridge: false,
      isTunnel: false,
      osmTags: { railway: 'rail', usage: 'main' },
      points: [
        [10.8, 0],
        [60, 0],
      ],
    },
  ];

  const sorted = sortRailwaysMainlineFirst(tracks);
  assert.equal(
    sorted[sorted.length - 1].id,
    'crossover-branch',
    'Service crossover must sort after chained mainline through-corridor segments'
  );

  const phases = computeContinuousTrackPhases(sorted);
  const p1 = phases.get('main-seg-1');
  const p2 = phases.get('main-seg-2');
  const p3 = phases.get('main-seg-3');
  assert.ok(
    p1 !== undefined && p2 !== undefined && p3 !== undefined,
    'All chained mainline segments must receive phase offsets'
  );

  const S = RAILWAY_DIMENSION_SPEC.visualSleeperPeriodMeters;
  const expectedP2 = (p1 + 10.0) % S;
  const expectedP3 = (p2 + 0.8) % S;
  assert.ok(
    Math.abs(p2 - expectedP2) < 1e-4,
    `Segment 2 phase (${p2}) must continue Segment 1 phase (${expectedP2})`
  );
  assert.ok(
    Math.abs(p3 - expectedP3) < 1e-4,
    `Segment 3 phase (${p3}) must continue Segment 2 phase (${expectedP3})`
  );
});

test('RailwayTopology: multi-interval clipping and turnout-throat pair classification', () => {
  // Single interval subtraction vs multi-interval subtraction
  const single = subtractLateralInterval(-1.25, 1.25, -0.3, 0.3);
  assert.ok(single, 'subtractLateralInterval returns the longer surviving side');

  const multi = subtractIntervalFromList([[-1.25, 1.25]], -0.25, 0.25, 0.4);
  assert.equal(
    multi.length,
    2,
    'subtractIntervalFromList must preserve both left [-1.25, -0.25] and right [0.25, 1.25] segments when an interior interval is removed'
  );
  assert.deepEqual(multi[0], [-1.25, -0.25]);
  assert.deepEqual(multi[1], [0.25, 1.25]);

  // Turnout throat pair vs independent parallel tracks
  const hostIndex = new HostTrackSpatialIndex(true);
  const mainPts: [number, number][] = [
    [0, 0],
    [100, 0],
  ];
  const branchPts: [number, number][] = [
    [20, 0], // shares interior switch node at (20, 0) on mainPts
    [80, 4.0],
  ];
  const parallelPts: [number, number][] = [
    [0, 2.25], // closely spaced parallel track with no shared switch node
    [100, 2.25],
  ];

  hostIndex.registerTrack(mainPts, 0.7175, 'main');
  hostIndex.registerTrack(branchPts, 0.7175, 'branch');
  hostIndex.registerTrack(parallelPts, 0.7175, 'parallel');
  assert.equal(hostIndex.registeredSegmentsCount, 3);

  // Sample in turnout throat at x=30 (branch z = (10/60)*4.0 = 0.667m, or x=45 where z = (25/60)*4.0 = 1.667m, or x=50 where z = 2.0m)
  assert.equal(
    isTurnoutThroatPair(branchPts, mainPts, 50, 2.0, 2.0),
    true,
    'Tracks converging toward a shared switch vertex within 26m must be classified as a turnout-throat pair'
  );
  assert.equal(
    isTurnoutThroatPair(parallelPts, mainPts, 50, 2.25, 2.25),
    false,
    'Closely spaced parallel tracks with constant 2.25m separation must NOT be classified as a turnout-throat pair'
  );
});

test('InfrastructureShaderChunks: configures sleeper and rail materials and updates uniforms in place', () => {
  const sleeperMat = new THREE.MeshStandardMaterial({ color: '#475569' });
  const sleeperCtrl = configureProceduralSleeperMaterial(
    sleeperMat,
    MAP_THEMES.tactical,
    1.0
  );

  const mockSleeperShader = {
    uniforms: {} as Record<string, { value: any }>,
    vertexShader: '#include <common>\n#include <begin_vertex>',
    fragmentShader: '#include <common>\n#include <color_fragment>',
  };
  sleeperMat.onBeforeCompile(mockSleeperShader as any, {} as any);
  assert.ok(mockSleeperShader.uniforms.uSleeperColor, 'Sleeper shader must inject uSleeperColor uniform');
  assert.ok(
    mockSleeperShader.fragmentShader.includes('fwidth(uCoord)'),
    'Sleeper shader must use derivative-based fwidth filtering'
  );

  sleeperCtrl.updateThemeColors(MAP_THEMES.daylight);
  sleeperCtrl.updateZoom(3.5);
  assert.equal(
    '#' + mockSleeperShader.uniforms.uSleeperColor.value.getHexString(),
    (MAP_THEMES.daylight.railwayColors.sleeper || '#64748b').toLowerCase(),
    'Sleeper uniform color must update in place without rebuilding material'
  );
  assert.equal(
    mockSleeperShader.uniforms.uCameraZoom.value,
    3.5,
    'Sleeper zoom uniform must update in place'
  );

  const railMat = new THREE.MeshStandardMaterial({ color: '#cbd5e1' });
  const railCtrl = configureProceduralRailMaterial(railMat, MAP_THEMES.tactical, 1.0);
  const mockRailShader = {
    uniforms: {} as Record<string, { value: any }>,
    vertexShader: '#include <common>\n#include <begin_vertex>',
    fragmentShader: '#include <common>\n#include <color_fragment>',
  };
  railMat.onBeforeCompile(mockRailShader as any, {} as any);
  assert.ok(mockRailShader.uniforms.uRailColor, 'Rail shader must inject uRailColor uniform');
  assert.ok(
    mockRailShader.fragmentShader.includes('energyFactor'),
    'Rail shader must implement analytical energy-conserving sub-pixel coverage'
  );

  railCtrl.updateThemeColors(MAP_THEMES.blueprint);
  railCtrl.updateZoom(4.0);
  assert.equal(
    '#' + mockRailShader.uniforms.uRailColor.value.getHexString(),
    MAP_THEMES.blueprint.railwayColors.rail.toLowerCase(),
    'Rail uniform color must update in place'
  );
  assert.equal(
    mockRailShader.uniforms.uCameraZoom.value,
    4.0,
    'Rail zoom uniform must update in place'
  );
});

test('RailwayGeometryBuilder & GeometryBuilder: hybrid zoom switching, close parallel sleeper support, feature inspection, 4-theme updates, and resource disposal', () => {
  // Two closely spaced parallel tracks (2.25m center-to-center) + diverging turnout branch
  const railways: RailwayFeature[] = [
    {
      id: 'track-main-1',
      type: 'railway',
      sourceFeatureId: 'way/2001',
      name: 'Track 1',
      railwayType: 'rail',
      width: 3.8,
      layer: 0,
      isBridge: false,
      isTunnel: false,
      osmTags: { railway: 'rail', usage: 'main' },
      points: [
        [-40, 0],
        [0, 0],
        [40, 0],
      ],
    },
    {
      id: 'track-main-2-close',
      type: 'railway',
      sourceFeatureId: 'way/2002',
      name: 'Track 2 (2.25m parallel)',
      railwayType: 'rail',
      width: 3.8,
      layer: 0,
      isBridge: false,
      isTunnel: false,
      osmTags: { railway: 'rail', usage: 'main' },
      points: [
        [-40, 2.25],
        [40, 2.25],
      ],
    },
    {
      id: 'track-turnout-branch',
      type: 'railway',
      sourceFeatureId: 'way/2003',
      name: 'Turnout Branch',
      railwayType: 'rail',
      width: 3.8,
      layer: 0,
      isBridge: false,
      isTunnel: false,
      osmTags: { railway: 'rail', service: 'spur' },
      points: [
        [0, 0],
        [40, -3.2],
      ],
    },
  ];

  const mapData = createBaseMapData(railways);
  const builder = new GeometryBuilder({ initialCameraZoom: 1.0 });
  const scene = builder.buildScene(mapData, MAP_THEMES.tactical);

  const railChildren = scene.railwaysGroup.children;
  const ballastTarget = railChildren.find((m) => m.name === 'Railway_Ballast')!;
  const sleepersRibbon = railChildren.find((m) => m.name === 'Railway_Sleepers')!;
  const railsRibbon = railChildren.find((m) => m.name === 'Railway_Rails')!;
  const sleepers3DTarget = railChildren.find((m) => m.name.startsWith('Railway_Sleepers_3D'))!;
  const rails3DTarget = railChildren.find((m) => m.name.startsWith('Railway_Rails_3D'))!;

  assert.ok(ballastTarget && sleepersRibbon && railsRibbon, 'Overview ribbon targets must exist');
  assert.ok(sleepers3DTarget, 'Instanced 3D sleeper target must exist');
  assert.ok(rails3DTarget, '3D extruded rail target must exist');

  const firstMesh = (obj: THREE.Object3D): THREE.Mesh =>
    (obj as THREE.Mesh).isMesh ? (obj as THREE.Mesh) : (obj.children[0] as THREE.Mesh);

  const ballastMesh = firstMesh(ballastTarget);
  const sleepers3DMesh = firstMesh(sleepers3DTarget);
  const rails3DMesh = firstMesh(rails3DTarget);

  // 1. Zoom-level hybrid switching (<= 4.5 overview vs > 4.5 close-zoom 3D)
  assert.equal(sleepersRibbon.visible, true, 'Procedural sleeper ribbon visible at zoom 1.0');
  assert.equal(railsRibbon.visible, true, 'Procedural rail ribbon visible at zoom 1.0');
  assert.equal(sleepers3DTarget.visible, false, '3D sleeper target hidden at zoom 1.0');
  assert.equal(rails3DTarget.visible, false, '3D rail target hidden at zoom 1.0');

  scene.updateCameraZoom?.(4.5);
  assert.equal(sleepersRibbon.visible, true, 'Procedural sleeper ribbon still visible at threshold zoom 4.5');
  assert.equal(sleepers3DTarget.visible, false, '3D sleeper target still hidden at threshold zoom 4.5');

  scene.updateCameraZoom?.(8.0);
  assert.equal(sleepersRibbon.visible, false, 'Procedural sleeper ribbon hidden at close zoom 8.0');
  assert.equal(railsRibbon.visible, false, 'Procedural rail ribbon hidden at close zoom 8.0');
  assert.equal(sleepers3DTarget.visible, true, '3D sleeper target visible at close zoom 8.0');
  assert.equal(rails3DTarget.visible, true, '3D rail target visible at close zoom 8.0');

  // 2. Verify both closely spaced parallel tracks and the turnout branch receive 3D sleepers
  const sleeperCountByTrack = new Map<string, number>();
  const infos = (sleepers3DTarget.userData as any).instanceInfos as Array<{ id: string }>;
  for (const inf of infos) {
    sleeperCountByTrack.set(inf.id, (sleeperCountByTrack.get(inf.id) || 0) + 1);
  }
  assert.ok(
    (sleeperCountByTrack.get('track-main-1') || 0) >= 100,
    `Main track 1 must have continuous 3D sleepers (got ${sleeperCountByTrack.get('track-main-1')})`
  );
  assert.ok(
    (sleeperCountByTrack.get('track-main-2-close') || 0) >= 100,
    `Closely spaced 2.25m parallel track 2 must retain its own sleepers without omission (got ${sleeperCountByTrack.get('track-main-2-close')})`
  );
  assert.ok(
    (sleeperCountByTrack.get('track-turnout-branch') || 0) >= 12,
    `Diverging turnout branch must receive independent sleepers beyond shared throat bearers (got ${sleeperCountByTrack.get('track-turnout-branch')})`
  );

  // 3. Feature inspection metadata via resolveInspectedFeature()
  const hitBallast = resolveInspectedFeature({ object: ballastMesh, faceIndex: 0 });
  assert.ok(hitBallast && hitBallast.category === 'Railway & Aerial', 'Ballast faceRanges must resolve railway feature');

  const hit3DRail = resolveInspectedFeature({ object: rails3DMesh, faceIndex: 0 });
  assert.ok(hit3DRail && hit3DRail.category === 'Railway & Aerial', '3D Rail faceRanges must resolve railway feature');

  const hit3DSleeper = resolveInspectedFeature({ object: sleepers3DMesh, instanceId: 0 });
  assert.ok(
    hit3DSleeper && hit3DSleeper.category === 'Railway & Aerial',
    'Instanced 3D Sleeper instanceInfos must resolve railway feature via instanceId'
  );

  // 4. Theme updates across all 4 themes without geometry reconstruction
  const initialBallastGeomUuid = ballastMesh.geometry.uuid;
  const initialRails3DGeomUuid = rails3DMesh.geometry.uuid;
  for (const themeKey of ['tactical', 'daylight', 'dusk', 'blueprint'] as const) {
    const targetTheme = MAP_THEMES[themeKey];
    scene.updateTheme(targetTheme);
    assert.equal(
      '#' + (ballastMesh.material as THREE.MeshStandardMaterial).color.getHexString(),
      targetTheme.railwayColors.ballast.toLowerCase(),
      `Ballast color must match ${themeKey} theme`
    );
    assert.equal(
      '#' + (rails3DMesh.material as THREE.MeshStandardMaterial).color.getHexString(),
      targetTheme.railwayColors.rail.toLowerCase(),
      `3D Rail color must match ${themeKey} theme`
    );
    assert.equal(
      ballastMesh.geometry.uuid,
      initialBallastGeomUuid,
      'Theme update must not reconstruct railway geometry buffers'
    );
    assert.equal(
      rails3DMesh.geometry.uuid,
      initialRails3DGeomUuid,
      'Theme update must not reconstruct 3D rail geometry buffers'
    );
  }

  // 5. Resource disposal via SceneResourceManager
  assert.ok(scene.resources.ownedGeometriesCount > 0, 'Active geometries must be tracked before disposal');
  assert.ok(scene.resources.ownedMaterialsCount > 0, 'Active materials must be tracked before disposal');

  scene.dispose();
  assert.equal(scene.resources.ownedGeometriesCount, 0, 'All railway geometries must be disposed');
  assert.equal(scene.resources.ownedMaterialsCount, 0, 'All railway materials must be disposed');
  assert.equal(scene.railwaysGroup.children.length, 0, 'railwaysGroup must be cleared on dispose');

  // Direct standalone buildRailwayInfrastructure call with its own internal SceneResourceManager
  const ownedRes = buildRailwayInfrastructure(mapData, MAP_THEMES.tactical, 1.0);
  assert.ok(ownedRes.resources.ownedGeometriesCount > 0);
  ownedRes.dispose();
  assert.equal(ownedRes.resources.ownedGeometriesCount, 0);

  // Direct standalone buildRailwayInfrastructure call with an externally supplied SceneResourceManager
  const standaloneRm = new SceneResourceManager();
  const standaloneRes = buildRailwayInfrastructure(mapData, MAP_THEMES.tactical, 1.0, {
    resourceManager: standaloneRm,
  });
  assert.ok(standaloneRm.ownedGeometriesCount > 0);
  standaloneRes.dispose();
  standaloneRm.dispose();
  assert.equal(standaloneRm.ownedGeometriesCount, 0);
});

test('M2.2 Railway bridge: track elevation, 3D bridge profile, substructure, parapet, and pier scene layer generation', () => {
  const bridgeRailway: RailwayFeature = {
    id: 'rail-bridge-test-1',
    type: 'railway',
    sourceFeatureId: 'way/9001',
    railwayType: 'rail',
    name: 'Mainline Viaduct Test',
    points: [
      [-60, 0],
      [-20, 0],
      [20, 0],
      [60, 0],
    ],
    isBridge: true,
    isTunnel: false,
    layer: 1,
    width: 3.2,
    osmTags: { railway: 'rail', bridge: 'yes', layer: '1', name: 'Mainline Viaduct Test' },
  };

  const mapData = createBaseMapData([bridgeRailway]);
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(mapData, MAP_THEMES.tactical);

  const firstMesh = (obj: THREE.Object3D): THREE.Mesh =>
    (obj as THREE.Mesh).isMesh ? (obj as THREE.Mesh) : (obj.children[0] as THREE.Mesh);

  const getYBounds = (geo: THREE.BufferGeometry): { minY: number; maxY: number } => {
    const pos = geo.attributes.position;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minY, maxY };
  };

  // 1. Verify bridge substructure and support piers in railwaysGroup
  const bridgeSubTarget = scene.railwaysGroup.children.find(
    (c) => c.name === 'Railway_Bridge_Substructure'
  );
  assert.ok(bridgeSubTarget, 'railwaysGroup must contain Railway_Bridge_Substructure');
  const bridgeSubMesh = firstMesh(bridgeSubTarget);
  assert.ok(
    bridgeSubMesh.geometry.attributes.position.count > 0,
    'Bridge substructure must have vertex geometry'
  );

  // Verify pier geometry exists: Railway_Bridge_Substructure merges [substructureGeo, piersGeo],
  // producing 2 distinct faceRanges for this single bridge feature (range 0 = deck/abutments, range 1 = support piers).
  const subFaceRanges = bridgeSubMesh.userData.faceRanges as Array<{
    startFace: number;
    endFace: number;
    info: any;
  }>;
  assert.ok(
    Array.isArray(subFaceRanges) && subFaceRanges.length === 2,
    `Expected 2 faceRanges (substructure + support piers) in Railway_Bridge_Substructure for a 120m span bridge, got ${subFaceRanges?.length}`
  );
  const pierRange = subFaceRanges[1];
  assert.ok(
    pierRange.endFace > pierRange.startFace,
    `Pier face range must contain generated pier triangles (${pierRange.startFace}..${pierRange.endFace})`
  );

  // Inspect actual pier vertices from pierRange (faces startFace..endFace):
  // Support piers are placed in the central elevated span (|x| < 45m) and extend from ELEVATION_POLICY.GROUND (-0.015m) up to the deck soffit (~2.52m).
  const subIdxAttr = bridgeSubMesh.geometry.index!;
  const subPosAttr = bridgeSubMesh.geometry.attributes.position;
  let pierMinY = Infinity;
  let pierMaxY = -Infinity;
  let pierMinAbsX = Infinity;
  for (let f = pierRange.startFace; f < pierRange.endFace; f++) {
    for (let k = 0; k < 3; k++) {
      const vIdx = subIdxAttr.getX(f * 3 + k);
      const vx = subPosAttr.getX(vIdx);
      const vy = subPosAttr.getY(vIdx);
      pierMinY = Math.min(pierMinY, vy);
      pierMaxY = Math.max(pierMaxY, vy);
      pierMinAbsX = Math.min(pierMinAbsX, Math.abs(vx));
    }
  }
  assert.ok(
    Math.abs(pierMinY - ELEVATION_POLICY.GROUND) < 1e-4,
    `Bridge pier bases must meet ELEVATION_POLICY.GROUND (${ELEVATION_POLICY.GROUND}m), got pierMinY=${pierMinY}`
  );
  assert.ok(
    pierMaxY > 2.4,
    `Bridge pier tops must reach the elevated deck soffit (> 2.4m), got pierMaxY=${pierMaxY}`
  );
  assert.ok(
    pierMinAbsX < 35,
    `Bridge piers must be generated along the central elevated span (|x| < 35m), got pierMinAbsX=${pierMinAbsX}`
  );

  const bridgeParapetTarget = scene.railwaysGroup.children.find(
    (c) => c.name === 'Railway_Bridge_Parapets'
  );
  assert.ok(bridgeParapetTarget, 'railwaysGroup must contain Railway_Bridge_Parapets');
  const bridgeParapetMesh = firstMesh(bridgeParapetTarget);
  const parapetBounds = getYBounds(bridgeParapetMesh.geometry);
  assert.ok(
    parapetBounds.maxY > 3.1,
    `Bridge parapets must rise above the elevated bridge deck (> 3.1m), got maxY=${parapetBounds.maxY}`
  );

  // 2. Elevated track geometry across ALL track components (ballast, UV sleeper/rail ribbons, 3D instanced sleepers, and 3D extruded rails)
  const expectedElevs = getRailwayElevations(1, true, false);
  const ballastTarget = scene.railwaysGroup.children.find((c) => c.name === 'Railway_Ballast');
  const sleepersRibbonTarget = scene.railwaysGroup.children.find((c) => c.name === 'Railway_Sleepers');
  const railsRibbonTarget = scene.railwaysGroup.children.find((c) => c.name === 'Railway_Rails');
  const sleepers3DTarget = scene.railwaysGroup.children.find((c) => c.name.startsWith('Railway_Sleepers_3D'));
  const rails3DTarget = scene.railwaysGroup.children.find((c) => c.name.startsWith('Railway_Rails_3D'));

  assert.ok(ballastTarget && sleepersRibbonTarget && railsRibbonTarget, 'Bridge UV-ribbon track layers must exist');
  assert.ok(sleepers3DTarget && rails3DTarget, 'Bridge 3D close-zoom sleeper and rail layers must exist');

  const ballastMesh = firstMesh(ballastTarget);
  const sleepersRibbonMesh = firstMesh(sleepersRibbonTarget);
  const railsRibbonMesh = firstMesh(railsRibbonTarget);
  const sleepers3DMesh = firstMesh(sleepers3DTarget) as THREE.InstancedMesh;
  const rails3DMesh = firstMesh(rails3DTarget);

  const ballastY = getYBounds(ballastMesh.geometry);
  const sleepersRibbonY = getYBounds(sleepersRibbonMesh.geometry);
  const railsRibbonY = getYBounds(railsRibbonMesh.geometry);
  const rails3DY = getYBounds(rails3DMesh.geometry);

  // Verify sloped approach ramps transition from at-grade base up to full layer-1 bridge elevation
  assert.ok(
    Math.abs(ballastY.minY - ELEVATION_POLICY.RAILWAY_BALLAST) < 0.05 &&
      Math.abs(ballastY.maxY - expectedElevs.ballast) < 0.02,
    `Bridge ballast must ramp from ~${ELEVATION_POLICY.RAILWAY_BALLAST}m to ~${expectedElevs.ballast}m (got ${ballastY.minY.toFixed(3)}..${ballastY.maxY.toFixed(3)})`
  );
  assert.ok(
    Math.abs(sleepersRibbonY.maxY - expectedElevs.sleepers) < 0.02 &&
      sleepersRibbonY.maxY > ballastY.maxY,
    `Bridge sleeper UV-ribbon must reach elevated sleeper height ~${expectedElevs.sleepers}m above ballast (got ${sleepersRibbonY.maxY.toFixed(3)})`
  );
  assert.ok(
    Math.abs(railsRibbonY.maxY - expectedElevs.rails) < 0.02 &&
      railsRibbonY.maxY > sleepersRibbonY.maxY,
    `Bridge rail UV-ribbon must reach elevated rail height ~${expectedElevs.rails}m above sleepers (got ${railsRibbonY.maxY.toFixed(3)})`
  );
  assert.ok(
    rails3DY.minY < 0.3 && rails3DY.maxY > expectedElevs.rails,
    `3D extruded bridge rails must follow the ramped bridge profile from <0.3m up to >${expectedElevs.rails}m (got ${rails3DY.minY.toFixed(3)}..${rails3DY.maxY.toFixed(3)})`
  );

  // Verify 3D instanced sleepers follow the elevated 3D bridge profile via instance matrices
  assert.ok(sleepers3DMesh.isInstancedMesh && sleepers3DMesh.count > 50, 'Bridge must have instanced 3D sleepers');
  const mat4 = new THREE.Matrix4();
  const posVec = new THREE.Vector3();
  let minSleeperInstY = Infinity;
  let maxSleeperInstY = -Infinity;
  for (let i = 0; i < sleepers3DMesh.count; i++) {
    sleepers3DMesh.getMatrixAt(i, mat4);
    posVec.setFromMatrixPosition(mat4);
    minSleeperInstY = Math.min(minSleeperInstY, posVec.y);
    maxSleeperInstY = Math.max(maxSleeperInstY, posVec.y);
  }
  assert.ok(
    minSleeperInstY < 0.3 && maxSleeperInstY > expectedElevs.ballast,
    `Instanced 3D bridge sleepers must follow the elevated bridge profile from approach ramps (<0.3m) to central deck (>${expectedElevs.ballast}m), got ${minSleeperInstY.toFixed(3)}..${maxSleeperInstY.toFixed(3)}`
  );

  // 3. No duplicate bridge geometry in roadsGroup
  const roadBridgeSub = scene.roadsGroup.children.find(
    (c) => c.name === 'BridgeSubstructure' || c.name === 'BridgeParapets'
  );
  assert.equal(
    roadBridgeSub,
    undefined,
    'Roads group must not contain bridge geometry for railway-only features'
  );

  // 4. Inspection provenance across bridge substructure, piers, parapets, ballast, 3D rails, and 3D sleepers
  for (const [label, hit] of [
    ['Bridge Substructure', resolveInspectedFeature({ object: bridgeSubMesh, faceIndex: subFaceRanges[0].startFace })],
    ['Bridge Piers', resolveInspectedFeature({ object: bridgeSubMesh, faceIndex: pierRange.startFace })],
    ['Bridge Parapets', resolveInspectedFeature({ object: bridgeParapetMesh, faceIndex: 0 })],
    ['Bridge Ballast', resolveInspectedFeature({ object: ballastMesh, faceIndex: 0 })],
    ['Bridge 3D Rails', resolveInspectedFeature({ object: rails3DMesh, faceIndex: 0 })],
    ['Bridge 3D Sleepers', resolveInspectedFeature({ object: sleepers3DMesh, instanceId: 0 })],
  ] as const) {
    assert.ok(hit, `${label} must resolve feature inspection info`);
    assert.equal(hit.sourceFeatureId, 'way/9001', `${label} must preserve sourceFeatureId 'way/9001'`);
    assert.equal(hit.isBridge, true, `${label} must preserve isBridge=true`);
    assert.equal(hit.layer, 1, `${label} must preserve layer=1`);
  }

  // 5. Deterministic disposal
  assert.ok(scene.resources.ownedGeometriesCount > 0);
  assert.ok(scene.resources.ownedMaterialsCount > 0);
  scene.dispose();
  assert.equal(scene.resources.ownedGeometriesCount, 0, 'All bridge geometries must be disposed');
  assert.equal(scene.resources.ownedMaterialsCount, 0, 'All bridge materials must be disposed');
  assert.equal(scene.railwaysGroup.children.length, 0, 'railwaysGroup must be empty after dispose');
});

test('M2.2 Railway tunnel: underground track elevation profile, portals, mouths, and underground traces', () => {
  const tunnelRailway: RailwayFeature = {
    id: 'rail-tunnel-test-1',
    type: 'railway',
    sourceFeatureId: 'way/9002',
    railwayType: 'rail',
    name: 'Underground Corridor Test',
    points: [
      [-80, 20],
      [-40, 20],
      [0, 20],
      [40, 20],
      [80, 20],
    ],
    isBridge: false,
    isTunnel: true,
    layer: -1,
    width: 3.2,
    osmTags: { railway: 'rail', tunnel: 'yes', layer: '-1', name: 'Underground Corridor Test' },
  };

  // 1. Verify underground track elevation profile independently of surface portal and trace geometry
  const tunnelElevsLayer1 = getRailwayElevations(
    tunnelRailway.layer,
    tunnelRailway.isBridge,
    tunnelRailway.isTunnel
  );
  assert.equal(
    tunnelElevsLayer1.ballast,
    ELEVATION_POLICY.TUNNEL_DEPTH,
    `Layer -1 tunnel ballast must sit at subterranean depth ELEVATION_POLICY.TUNNEL_DEPTH (${ELEVATION_POLICY.TUNNEL_DEPTH}m)`
  );
  assert.ok(
    tunnelElevsLayer1.ballast < tunnelElevsLayer1.sleepers &&
      tunnelElevsLayer1.sleepers < tunnelElevsLayer1.rails &&
      tunnelElevsLayer1.rails < 0,
    `Tunnel track components must maintain strict subterranean vertical hierarchy < 0m (got ballast=${tunnelElevsLayer1.ballast}, sleepers=${tunnelElevsLayer1.sleepers}, rails=${tunnelElevsLayer1.rails})`
  );

  const tunnelElevsLayer2 = getRailwayElevations(-2, false, true);
  assert.equal(
    tunnelElevsLayer2.ballast,
    ELEVATION_POLICY.TUNNEL_DEPTH - ELEVATION_POLICY.TUNNEL_LAYER_STEP,
    'Layer -2 railway tunnel must descend by an additional TUNNEL_LAYER_STEP (-3.0m)'
  );

  // Explicit surface approaches establish actual physical tunnel entrances.
  const westSurface: RailwayFeature = {
    ...tunnelRailway,
    id: 'rail-west-surface',
    sourceFeatureId: 'way/west-surface',
    points: [[-120, 20], [-80, 20]],
    isTunnel: false,
    layer: 0,
    osmTags: { railway: 'rail' },
  };
  const eastSurface: RailwayFeature = {
    ...westSurface,
    id: 'rail-east-surface',
    sourceFeatureId: 'way/east-surface',
    points: [[80, 20], [120, 20]],
  };
  const mapData = createBaseMapData([westSurface, tunnelRailway, eastSurface]);
  const builder = new GeometryBuilder({
    infrastructureRenderOptions: { roads: 'legacy', railways: 'legacy', showUndergroundTunnelTraces: true },
  });
  const scene = builder.buildScene(mapData, MAP_THEMES.tactical);

  const firstMesh = (obj: THREE.Object3D): THREE.Mesh =>
    (obj as THREE.Mesh).isMesh ? (obj as THREE.Mesh) : (obj.children[0] as THREE.Mesh);

  // 2. Verify tunnel portal (arch structure + recessed mouth) and trace meshes in railwaysGroup,
  //    and confirm above-ground ballast/sleeper/rail meshes are not emitted for a subterranean tunnel span
  const portalTarget = scene.railwaysGroup.children.find(
    (c) => c.name === 'Railway_Tunnel_Portals'
  );
  assert.ok(portalTarget, 'railwaysGroup must contain Railway_Tunnel_Portals');
  const portalMesh = firstMesh(portalTarget);
  assert.ok(
    portalMesh.geometry.attributes.position.count > 0,
    'Tunnel portal geometry must contain vertices'
  );

  // Railway_Tunnel_Portals merges [portalStructureGeo, portalMouthGeo] -> 2 faceRanges for 1 tunnel feature
  const portalRanges = portalMesh.userData.faceRanges as Array<{
    startFace: number;
    endFace: number;
    info: any;
  }>;
  assert.ok(
    Array.isArray(portalRanges) && portalRanges.length === 2,
    `Expected 2 faceRanges (portal structure + recessed mouth) in Railway_Tunnel_Portals, got ${portalRanges?.length}`
  );

  const traceTarget = scene.railwaysGroup.children.find(
    (c) => c.name === 'Railway_Tunnel_Traces'
  );
  assert.ok(traceTarget, 'railwaysGroup must contain Railway_Tunnel_Traces');
  const traceMesh = firstMesh(traceTarget);
  assert.ok(
    traceMesh.geometry.attributes.position.count > 0,
    'Tunnel trace geometry must contain vertices'
  );

  // Surface tracks remain present on both sides; the buried tunnel contributes
  // only portal structures, never to the ordinary surface track materials.
  assert.ok(scene.railwaysGroup.children.find((c) => c.name === 'Railway_Ballast'));
  assert.ok(scene.railwaysGroup.children.find((c) => c.name.startsWith('Railway_Rails')));

  // 3. Inspection provenance & subterranean elevation recorded on tunnel feature info
  for (const [label, hit] of [
    ['Tunnel Portal Structure', resolveInspectedFeature({ object: portalMesh, faceIndex: portalRanges[0].startFace })],
    ['Tunnel Portal Mouth', resolveInspectedFeature({ object: portalMesh, faceIndex: portalRanges[1].startFace })],
    ['Tunnel Surface Trace', resolveInspectedFeature({ object: traceMesh, faceIndex: 0 })],
  ] as const) {
    assert.ok(hit, `${label} must resolve feature info`);
    assert.equal(hit.sourceFeatureId, 'way/9002', `${label} must trace back to 'way/9002'`);
    assert.equal(hit.isTunnel, true, `${label} must record isTunnel=true`);
    assert.equal(hit.layer, -1, `${label} must record layer=-1`);
    assert.equal(
      hit.elevation,
      ELEVATION_POLICY.TUNNEL_DEPTH,
      `${label} feature metadata must record subterranean track elevation (${ELEVATION_POLICY.TUNNEL_DEPTH}m)`
    );
  }

  // 4. Deterministic disposal
  assert.ok(scene.resources.ownedGeometriesCount > 0);
  assert.ok(scene.resources.ownedMaterialsCount > 0);
  scene.dispose();
  assert.equal(scene.resources.ownedGeometriesCount, 0, 'All tunnel geometries must be disposed');
  assert.equal(scene.resources.ownedMaterialsCount, 0, 'All tunnel materials must be disposed');
  assert.equal(scene.railwaysGroup.children.length, 0, 'railwaysGroup must be empty after dispose');
});

test('M2.2 Railway bridge and tunnel: 4-theme in-place material updates and deterministic resource disposal', () => {
  const bridgeRailway: RailwayFeature = {
    id: 'rail-bridge-test-theme',
    type: 'railway',
    sourceFeatureId: 'way/9003',
    railwayType: 'rail',
    points: [
      [-50, 0],
      [0, 0],
      [50, 0],
    ],
    isBridge: true,
    isTunnel: false,
    layer: 1,
    width: 3.2,
    osmTags: { railway: 'rail', bridge: 'yes', layer: '1' },
  };

  const tunnelRailway: RailwayFeature = {
    id: 'rail-tunnel-test-theme',
    type: 'railway',
    sourceFeatureId: 'way/9004',
    railwayType: 'rail',
    points: [
      [-50, 30],
      [0, 30],
      [50, 30],
    ],
    isBridge: false,
    isTunnel: true,
    layer: -1,
    width: 3.2,
    osmTags: { railway: 'rail', tunnel: 'yes', layer: '-1' },
  };

  const tunnelWestSurface: RailwayFeature = {
    ...tunnelRailway,
    id: 'rail-tunnel-west-surface',
    sourceFeatureId: 'way/tunnel-west-surface',
    points: [[-80, 30], [-50, 30]],
    isTunnel: false,
    layer: 0,
    osmTags: { railway: 'rail' },
  };
  const tunnelEastSurface: RailwayFeature = {
    ...tunnelWestSurface,
    id: 'rail-tunnel-east-surface',
    sourceFeatureId: 'way/tunnel-east-surface',
    points: [[50, 30], [80, 30]],
  };
  const mapData = createBaseMapData([bridgeRailway, tunnelWestSurface, tunnelRailway, tunnelEastSurface]);
  const builder = new GeometryBuilder({
    infrastructureRenderOptions: { roads: 'legacy', railways: 'legacy', showUndergroundTunnelTraces: true },
  });
  const scene = builder.buildScene(mapData, MAP_THEMES.tactical);

  const firstMesh = (obj: THREE.Object3D): THREE.Mesh =>
    (obj as THREE.Mesh).isMesh ? (obj as THREE.Mesh) : (obj.children[0] as THREE.Mesh);

  const bridgeSubTarget = scene.railwaysGroup.children.find(
    (c) => c.name === 'Railway_Bridge_Substructure'
  );
  const bridgeParapetTarget = scene.railwaysGroup.children.find(
    (c) => c.name === 'Railway_Bridge_Parapets'
  );
  const tunnelPortalTarget = scene.railwaysGroup.children.find(
    (c) => c.name === 'Railway_Tunnel_Portals'
  );
  const tunnelTraceTarget = scene.railwaysGroup.children.find(
    (c) => c.name === 'Railway_Tunnel_Traces'
  );
  const ballastTarget = scene.railwaysGroup.children.find(
    (c) => c.name === 'Railway_Ballast'
  );
  const sleepers3DTarget = scene.railwaysGroup.children.find(
    (c) => c.name.startsWith('Railway_Sleepers_3D')
  );
  const rails3DTarget = scene.railwaysGroup.children.find(
    (c) => c.name.startsWith('Railway_Rails_3D')
  );

  assert.ok(bridgeSubTarget && bridgeParapetTarget, 'Bridge structure targets must exist');
  assert.ok(tunnelPortalTarget && tunnelTraceTarget, 'Tunnel targets must exist');
  assert.ok(ballastTarget && sleepers3DTarget && rails3DTarget, 'Bridge track targets must exist');

  const bridgeSubMesh = firstMesh(bridgeSubTarget);
  const bridgeParapetMesh = firstMesh(bridgeParapetTarget);
  const tunnelPortalMesh = firstMesh(tunnelPortalTarget);
  const tunnelTraceMesh = firstMesh(tunnelTraceTarget);
  const ballastMesh = firstMesh(ballastTarget);
  const sleepers3DMesh = firstMesh(sleepers3DTarget);
  const rails3DMesh = firstMesh(rails3DTarget);

  const initialSubUuid = bridgeSubMesh.geometry.uuid;
  const initialParapetUuid = bridgeParapetMesh.geometry.uuid;
  const initialPortalUuid = tunnelPortalMesh.geometry.uuid;
  const initialTraceUuid = tunnelTraceMesh.geometry.uuid;
  const initialBallastUuid = ballastMesh.geometry.uuid;
  const initialRails3DUuid = rails3DMesh.geometry.uuid;

  const expectedStructureColors: Record<
    'tactical' | 'daylight' | 'dusk' | 'blueprint',
    { sub: string; parapet: string; portal: string; trace: string }
  > = {
    tactical: { sub: '#334155', parapet: '#64748b', portal: '#475569', trace: '#38bdf8' },
    daylight: { sub: '#64748b', parapet: '#94a3b8', portal: '#94a3b8', trace: '#475569' },
    dusk: { sub: '#334155', parapet: '#64748b', portal: '#475569', trace: '#38bdf8' },
    blueprint: { sub: '#0077b6', parapet: '#48cae4', portal: '#0096c7', trace: '#00b4d8' },
  };

  for (const themeKey of ['tactical', 'daylight', 'dusk', 'blueprint'] as const) {
    const theme = MAP_THEMES[themeKey];
    const expected = expectedStructureColors[themeKey];
    scene.updateTheme(theme);

    // 1. Verify bridge and tunnel structural materials actually update their colors in place
    assert.equal(
      '#' + (bridgeSubMesh.material as THREE.MeshStandardMaterial).color.getHexString(),
      expected.sub,
      `Bridge substructure material color must update for ${themeKey} theme`
    );
    assert.equal(
      '#' + (bridgeParapetMesh.material as THREE.MeshStandardMaterial).color.getHexString(),
      expected.parapet,
      `Bridge parapet material color must update for ${themeKey} theme`
    );
    assert.equal(
      '#' + (tunnelPortalMesh.material as THREE.MeshStandardMaterial).color.getHexString(),
      expected.portal,
      `Tunnel portal material color must update for ${themeKey} theme`
    );
    assert.equal(
      '#' + (tunnelTraceMesh.material as THREE.MeshStandardMaterial).color.getHexString(),
      expected.trace,
      `Tunnel trace material color must update for ${themeKey} theme`
    );

    // 2. Verify elevated bridge track materials (ballast, 3D sleepers, 3D rails) also update in place
    assert.equal(
      '#' + (ballastMesh.material as THREE.MeshStandardMaterial).color.getHexString(),
      theme.railwayColors.ballast.toLowerCase(),
      `Bridge ballast material color must update for ${themeKey} theme`
    );
    assert.equal(
      '#' + (sleepers3DMesh.material as THREE.MeshStandardMaterial).color.getHexString(),
      (theme.railwayColors.sleeper || '#64748b').toLowerCase(),
      `Bridge 3D sleeper material color must update for ${themeKey} theme`
    );
    assert.equal(
      '#' + (rails3DMesh.material as THREE.MeshStandardMaterial).color.getHexString(),
      theme.railwayColors.rail.toLowerCase(),
      `Bridge 3D rail material color must update for ${themeKey} theme`
    );

    // 3. Buffers must not be re-allocated
    assert.equal(bridgeSubMesh.geometry.uuid, initialSubUuid, `Bridge substructure geometry buffer must remain stable across ${themeKey}`);
    assert.equal(bridgeParapetMesh.geometry.uuid, initialParapetUuid, `Bridge parapet geometry buffer must remain stable across ${themeKey}`);
    assert.equal(tunnelPortalMesh.geometry.uuid, initialPortalUuid, `Tunnel portal geometry buffer must remain stable across ${themeKey}`);
    assert.equal(tunnelTraceMesh.geometry.uuid, initialTraceUuid, `Tunnel trace geometry buffer must remain stable across ${themeKey}`);
    assert.equal(ballastMesh.geometry.uuid, initialBallastUuid, `Bridge ballast geometry buffer must remain stable across ${themeKey}`);
    assert.equal(rails3DMesh.geometry.uuid, initialRails3DUuid, `Bridge 3D rail geometry buffer must remain stable across ${themeKey}`);
  }

  // Verify resource disposal
  assert.ok(scene.resources.ownedGeometriesCount > 0);
  assert.ok(scene.resources.ownedMaterialsCount > 0);

  scene.dispose();

  assert.equal(scene.resources.ownedGeometriesCount, 0, 'All geometries must be freed upon dispose');
  assert.equal(scene.resources.ownedMaterialsCount, 0, 'All materials must be freed upon dispose');
  assert.equal(scene.railwaysGroup.children.length, 0, 'railwaysGroup must be empty after dispose');
});

test('M2.2 OSM Preset Regression: server.ts never seeds osmCache with railway-only benchmark extracts', () => {
  const serverPath = path.resolve(__dirname, '..', '..', 'server.ts');
  const serverSource = fs.readFileSync(serverPath, 'utf-8');

  assert.equal(
    serverSource.includes('realOsmRailwayExtracts.json'),
    false,
    'server.ts must not load or seed general-purpose osmCache with realOsmRailwayExtracts.json'
  );

  // Confirm that realOsmRailwayExtracts.json remains intact for offline railway benchmarks,
  // and verify why it must never masquerade as a full regional OSM preset dataset:
  const extractPath = path.resolve(__dirname, 'prototype', 'realOsmRailwayExtracts.json');
  assert.ok(fs.existsSync(extractPath), 'realOsmRailwayExtracts.json must remain available for railway benchmarks');
  const rawExtract = JSON.parse(fs.readFileSync(extractPath, 'utf-8'));

  const hengeloFeatures = rawExtract.regions.hengelo.features as Array<{ properties?: Record<string, any> }>;
  const amsterdamFeatures = rawExtract.regions.amsterdamCentraal.features as Array<{ properties?: Record<string, any> }>;
  assert.equal(hengeloFeatures.length, 162, 'Hengelo railway extract contains 162 railway-scoped features');
  assert.equal(amsterdamFeatures.length, 771, 'Amsterdam railway extract contains 771 railway-scoped features');
  assert.ok(
    hengeloFeatures.every((f) => Boolean(f.properties?.railway)),
    'Every feature in Hengelo railway benchmark extract carries a railway tag'
  );
  assert.ok(
    amsterdamFeatures.every((f) => Boolean(f.properties?.railway)),
    'Every feature in Amsterdam railway benchmark extract carries a railway tag'
  );

  const provider = new LocalGeoJsonProvider();
  const hengeloExtractParsed = provider.parseGeoJson(
    {
      type: 'FeatureCollection',
      name: rawExtract.regions.hengelo.name,
      features: hengeloFeatures,
    },
    rawExtract.regions.hengelo.name,
    rawExtract.regions.hengelo.center,
    rawExtract.regions.hengelo.radiusMeters
  );
  assert.ok(hengeloExtractParsed.railways.length > 50, 'Hengelo railway benchmark extract contains railway ways');
  assert.equal(
    hengeloExtractParsed.roads.length +
      hengeloExtractParsed.waterBodies.length +
      hengeloExtractParsed.linearWaterways.length +
      hengeloExtractParsed.parks.length,
    0,
    'Hengelo railway benchmark extract contains 0 roads, waterBodies, linearWaterways, or parks'
  );
});


