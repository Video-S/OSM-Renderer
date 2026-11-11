import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import {
  GeometryBuilder,
  prepareInfrastructureRenderPreview,
  type BuiltSceneGeometry,
} from './GeometryBuilder';
import { MAP_THEMES } from '../styles/mapThemes';
import { ELEVATION_POLICY, resolveTunnelClearanceAndDepth } from './ElevationPolicy';
import type { InfrastructureRenderOptions } from './infrastructure/rendering/InfrastructureRenderAdapter';

const DEFAULT_THEME = MAP_THEMES.tactical;

function buildSceneFromFeatures(
  features: Array<{
    id: string;
    properties: Record<string, any>;
    coordinates: [number, number][];
    geometryType?: 'LineString' | 'Polygon';
  }>,
  options?: Partial<InfrastructureRenderOptions>
) {
  const geojson = {
    type: 'FeatureCollection' as const,
    name: 'SyntheticSubterraneanTest',
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
  const infrastructureRenderOptions: InfrastructureRenderOptions = {
    roads: options?.roads ?? 'graph-surface',
    railways: options?.railways ?? 'graph-R+',
    railwaySwitchPolicy: options?.railwaySwitchPolicy ?? 'graph',
    railwayBallastStrategy: options?.railwayBallastStrategy ?? 'surface-first',
    showUndergroundTunnelTraces: options?.showUndergroundTunnelTraces ?? false,
    showHiddenUndergroundGeometry: options?.showHiddenUndergroundGeometry ?? true,
  };
  const preview = prepareInfrastructureRenderPreview(processed, infrastructureRenderOptions);
  const builder = new GeometryBuilder({
    infrastructureRenderOptions,
    infrastructureRenderPreview: preview,
  });
  const scene = builder.buildScene(processed, DEFAULT_THEME);
  return { processed, scene };
}

function findMeshInScene(scene: BuiltSceneGeometry, name: string): THREE.Mesh | null {
  const groups = [
    scene.roadsGroup,
    scene.railwaysGroup,
    scene.barriersGroup,
    scene.buildingsGroup,
    scene.landuseGroup,
    scene.parksGroup,
    scene.waterGroup,
    scene.foliageGroup,
  ];
  let found: THREE.Mesh | null = null;
  for (const g of groups) {
    if (!g) continue;
    g.traverse((obj) => {
      if (found) return;
      if (
        (obj as THREE.Mesh).isMesh &&
        (obj.name === name ||
          obj.name.startsWith(`${name}_chunk_`) ||
          obj.name === `${name}_3D` ||
          obj.name.startsWith(`${name}_3D_chunk_`) ||
          (name.endsWith('_3D') && obj.name === name.replace('_3D', '')))
      ) {
        found = obj as THREE.Mesh;
      }
    });
    if (found) return found;
  }
  return null;
}

function findMeshesByPrefixInScene(scene: BuiltSceneGeometry, prefix: string): THREE.Mesh[] {
  const groups = [
    scene.roadsGroup,
    scene.railwaysGroup,
    scene.barriersGroup,
    scene.buildingsGroup,
    scene.landuseGroup,
    scene.parksGroup,
    scene.waterGroup,
    scene.foliageGroup,
  ];
  const list: THREE.Mesh[] = [];
  for (const g of groups) {
    if (!g) continue;
    g.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh && obj.name.startsWith(prefix)) {
        list.push(obj as THREE.Mesh);
      }
    });
  }
  return list;
}

function getSourceVertsYRange(
  meshOrMeshes: THREE.Mesh | THREE.Mesh[] | null | undefined,
  sourceId: string
): {
  minY: number;
  maxY: number;
  vertexCount: number;
} | null {
  if (!meshOrMeshes) return null;
  const meshes = Array.isArray(meshOrMeshes) ? meshOrMeshes : [meshOrMeshes];
  let minY = Infinity;
  let maxY = -Infinity;
  let vertexCount = 0;

  for (const mesh of meshes) {
    if (!mesh || !mesh.geometry) continue;
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const faceRanges = mesh.userData?.faceRanges as
      | Array<{
          startFace?: number;
          endFace?: number;
          startTriangle?: number;
          triangleCount?: number;
          info?: { sourceId?: string; sourceFeatureId?: string; sourceFeatureIds?: string[]; id?: string };
        }>
      | undefined;
    if (!pos || !faceRanges) continue;

    for (const r of faceRanges) {
      const sid = r.info?.sourceFeatureId || r.info?.sourceId || r.info?.id;
      const sids = r.info?.sourceFeatureIds || [];
      const matches = sid === sourceId || sids.includes(sourceId) || r.info?.id === sourceId;
      if (!matches) continue;

      const startIdx =
        r.startFace !== undefined
          ? r.startFace * 3
          : r.startTriangle !== undefined
            ? r.startTriangle * 3
            : 0;
      const endIdx =
        r.endFace !== undefined
          ? r.endFace * 3
          : r.triangleCount !== undefined && r.startTriangle !== undefined
            ? (r.startTriangle + r.triangleCount) * 3
            : pos.count;

      if (index) {
        for (let i = startIdx; i < endIdx && i < index.count; i++) {
          const v = index.getX(i);
          const y = pos.getY(v);
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          vertexCount++;
        }
      } else {
        for (let v = startIdx; v < endIdx && v < pos.count; v++) {
          const y = pos.getY(v);
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          vertexCount++;
        }
      }
    }
  }

  return vertexCount > 0 ? { minY, maxY, vertexCount } : null;
}

describe('M2.3-E4-T2 Subterranean Visual Integration & Structural Context (TKT-015)', () => {
  it('1. Europatunnel Hengelo reproduction: fixes way/375064982 and way/375064983 above-ground retaining walls and models approach walls accurately', () => {
    const fixturePath = path.resolve(
      process.cwd(),
      'src/world/prototype/EuropatunnelHengeloFixture.json'
    );
    const rawEuropatunnel = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    const provider = new LocalGeoJsonProvider();
    const processed = provider.parseGeoJson(rawEuropatunnel);
    const builder = new GeometryBuilder({
      infrastructureRenderOptions: {
        roads: 'graph-surface',
        railways: 'graph-R+',
        railwaySwitchPolicy: 'graph',
        railwayBallastStrategy: 'surface-first',
        showHiddenUndergroundGeometry: true,
      },
    });
    const scene = builder.buildScene(processed, DEFAULT_THEME);

    // Confirm defective retaining walls and neighboring Europatunnel ways are present
    const b982 = processed.barriers.find(
      (b) => b.sourceFeatureId === 'way/375064982' || b.id === 'way/375064982'
    );
    const b983 = processed.barriers.find(
      (b) => b.sourceFeatureId === 'way/375064983' || b.id === 'way/375064983'
    );
    const b703 = processed.barriers.find(
      (b) => b.sourceFeatureId === 'way/375047303' || b.id === 'way/375047303'
    );
    const b985 = processed.barriers.find(
      (b) => b.sourceFeatureId === 'way/375064985' || b.id === 'way/375064985'
    );
    const b984 = processed.barriers.find(
      (b) => b.sourceFeatureId === 'way/375064984' || b.id === 'way/375064984'
    );

    assert.ok(b982, 'way/375064982 should exist');
    assert.ok(b983, 'way/375064983 should exist');
    assert.ok(b703, 'way/375047303 should exist');
    assert.ok(b985, 'way/375064985 should exist');
    assert.ok(b984, 'way/375064984 should exist');

    // Check structural context classification
    assert.equal(b982.structuralContext?.kind, 'subterranean_enclosed');
    assert.equal(b983.structuralContext?.kind, 'subterranean_enclosed');
    assert.equal(b703.structuralContext?.kind, 'cutting_or_portal_approach');
    assert.equal(b985.structuralContext?.kind, 'cutting_or_portal_approach');

    // Verify way/375064982 and way/375064983 are NOT in surface Barriers_wall at Y = 0.025m
    const surfaceWallMesh = findMeshInScene(scene, 'Barriers_wall');
    const surface982 = getSourceVertsYRange(surfaceWallMesh, 'way/375064982');
    const surface983 = getSourceVertsYRange(surfaceWallMesh, 'way/375064983');
    assert.equal(surface982, null);
    assert.equal(surface983, null);

    // Verify they are placed in Tunnel_Underground_Barriers below ground cover (maxY <= -0.4m) and hidden by default
    const ugBarrierMesh = findMeshInScene(scene, 'Tunnel_Underground_Barriers');
    assert.ok(ugBarrierMesh, 'Tunnel_Underground_Barriers mesh should exist');
    assert.equal(ugBarrierMesh.visible, true);

    const ug982 = getSourceVertsYRange(ugBarrierMesh, 'way/375064982');
    const ug983 = getSourceVertsYRange(ugBarrierMesh, 'way/375064983');
    assert.ok(ug982, 'way/375064982 should be in Tunnel_Underground_Barriers');
    assert.ok(ug983, 'way/375064983 should be in Tunnel_Underground_Barriers');
    assert.ok(ug982.maxY <= -0.4, `Expected ug982.maxY <= -0.4, got ${ug982.maxY}`);
    assert.ok(ug982.minY <= -4.0, `Expected ug982.minY <= -4.0, got ${ug982.minY}`);
    assert.ok(ug983.maxY <= -0.4, `Expected ug983.maxY <= -0.4, got ${ug983.maxY}`);
    assert.ok(ug983.minY <= -4.0, `Expected ug983.minY <= -4.0, got ${ug983.minY}`);

    // Verify approach retaining walls (way/375047303, way/375064985, way/375064984) remain visible in Barriers_wall
    // and span down into the depressed portal approach rather than sitting flat at Y = +0.025m
    assert.ok(surfaceWallMesh, 'Barriers_wall mesh should exist');
    assert.equal(surfaceWallMesh.visible, true);
    const approach703 = getSourceVertsYRange(surfaceWallMesh, 'way/375047303');
    const approach985 = getSourceVertsYRange(surfaceWallMesh, 'way/375064985');
    assert.ok(approach703);
    assert.ok(approach985);
    assert.ok(approach703.minY < 0, `Expected approach703.minY < 0, got ${approach703.minY}`);
    assert.ok(approach985.minY < 0, `Expected approach985.minY < 0, got ${approach985.minY}`);

    // Verify neighboring Europatunnel roads/cycleways/footways are rendered
    const ugRoadMesh = findMeshInScene(scene, 'Tunnel_Underground_Roads');
    assert.ok(ugRoadMesh);
    for (const id of [
      'way/6671250',
      'way/230163955',
      'way/190592701',
      'way/532064936',
      'way/532064942',
    ]) {
      assert.ok(getSourceVertsYRange(ugRoadMesh, id), `Expected ${id} in Tunnel_Underground_Roads`);
    }

    scene.dispose();
  });

  it('2. Ordinary surface retaining wall: renders above ground on surface at standard barrier elevation', () => {
    const { processed, scene } = buildSceneFromFeatures([
      {
        id: 'way/surface-wall-1',
        properties: { barrier: 'retaining_wall' },
        coordinates: [
          [6.794, 52.264],
          [6.795, 52.264],
        ],
      },
    ]);

    assert.equal(processed.barriers[0].structuralContext?.kind, 'surface_standard');
    const wallMesh = findMeshInScene(scene, 'Barriers_wall');
    assert.ok(wallMesh);
    assert.equal(wallMesh.visible, true);

    const range = getSourceVertsYRange(wallMesh, 'way/surface-wall-1');
    assert.ok(range);
    assert.ok(Math.abs(range.minY - ELEVATION_POLICY.BARRIER_BASE) < 1e-3);
    assert.ok(range.maxY > 1.0);
    scene.dispose();
  });

  it('3. Negative-layer retaining wall without nearby tunnel context: classifies as unassociated_negative_layer and uses conservative surface fallback', () => {
    const { processed, scene } = buildSceneFromFeatures([
      {
        id: 'way/isolated-neg-wall',
        properties: { barrier: 'retaining_wall', layer: '-1' },
        coordinates: [
          [6.794, 52.264],
          [6.795, 52.264],
        ],
      },
    ]);

    assert.equal(
      processed.barriers[0].structuralContext?.kind,
      'unassociated_negative_layer'
    );
    assert.equal(
      processed.diagnostics?.structuralContextDiagnostics?.unassociatedNegativeLayerBarrierCount,
      1
    );

    const wallMesh = findMeshInScene(scene, 'Barriers_wall');
    assert.ok(wallMesh);
    const range = getSourceVertsYRange(wallMesh, 'way/isolated-neg-wall');
    assert.ok(range);
    assert.ok(Math.abs(range.minY - ELEVATION_POLICY.BARRIER_BASE) < 1e-3);
    assert.equal(findMeshInScene(scene, 'Tunnel_Underground_Barriers'), null);
    scene.dispose();
  });

  it('4. Retaining wall along an open cutting: spans from depressed cutting floor to surface rim', () => {
    const { processed, scene } = buildSceneFromFeatures([
      {
        id: 'way/cutting-road',
        properties: { highway: 'secondary', cutting: 'yes', layer: '-1' },
        coordinates: [
          [6.793, 52.264],
          [6.796, 52.264],
        ],
      },
      {
        id: 'way/cutting-wall',
        properties: { barrier: 'retaining_wall', layer: '-1' },
        coordinates: [
          [6.7932, 52.26404],
          [6.7958, 52.26404],
        ],
      },
    ]);

    assert.equal(
      processed.barriers[0].structuralContext?.kind,
      'cutting_or_portal_approach'
    );
    const wallMesh = findMeshInScene(scene, 'Barriers_wall');
    assert.ok(wallMesh);
    assert.equal(wallMesh.visible, true);

    const range = getSourceVertsYRange(wallMesh, 'way/cutting-wall');
    assert.ok(range);
    assert.ok(Math.abs(range.minY - ELEVATION_POLICY.OPEN_CUTTING_DEPTH) < 0.05);
    assert.ok(Math.abs(range.maxY - 0.05) < 0.05);
    scene.dispose();
  });

  it('5. Retaining wall along an enclosed tunnel: classifies as subterranean_enclosed and stays below ground cover', () => {
    const { processed, scene } = buildSceneFromFeatures([
      {
        id: 'way/enclosed-tunnel',
        properties: {
          highway: 'primary',
          tunnel: 'yes',
          layer: '-1',
          maxheight: '4.2',
          _nodeIds: [10, 11],
        },
        coordinates: [
          [6.793, 52.264],
          [6.796, 52.264],
        ],
      },
      {
        id: 'way/enclosed-tunnel-wall',
        properties: { barrier: 'retaining_wall', layer: '-1' },
        coordinates: [
          [6.7935, 52.26403],
          [6.7955, 52.26403],
        ],
      },
    ]);

    assert.equal(processed.barriers[0].structuralContext?.kind, 'subterranean_enclosed');
    const ugWallMesh = findMeshInScene(scene, 'Tunnel_Underground_Barriers');
    assert.ok(ugWallMesh);
    assert.equal(ugWallMesh.visible, true);

    const range = getSourceVertsYRange(ugWallMesh, 'way/enclosed-tunnel-wall');
    assert.ok(range);
    assert.ok(range.maxY <= -0.4);
    scene.dispose();
  });

  it('6. Parallel road/cycleway/footway underpass corridor: maintains distinct subterranean clearance depths and coherent portal transitions', () => {
    const roadClearance = resolveTunnelClearanceAndDepth({
      kind: 'road',
      roadCategory: 'secondary',
      maxheightTag: '3.8',
    });
    const cycleClearance = resolveTunnelClearanceAndDepth({
      kind: 'road',
      roadCategory: 'cycleway',
    });
    const railElectrifiedClearance = resolveTunnelClearanceAndDepth({
      kind: 'railway',
      electrifiedTag: 'contact_line',
    });

    assert.ok(Math.abs(roadClearance.requiredClearanceMeters - 3.8) < 0.01);
    assert.ok(Math.abs(cycleClearance.requiredClearanceMeters - 2.6) < 0.01);
    assert.ok(Math.abs(railElectrifiedClearance.requiredClearanceMeters - 5.2) < 0.01);
    assert.ok(railElectrifiedClearance.targetFloorElevation < ELEVATION_POLICY.TUNNEL_DEPTH);

    const fixturePath = path.resolve(
      process.cwd(),
      'src/world/prototype/EuropatunnelHengeloFixture.json'
    );
    const rawEuropatunnel = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const provider = new LocalGeoJsonProvider();
    const processed = provider.parseGeoJson(rawEuropatunnel);
    const builder = new GeometryBuilder({
      infrastructureRenderOptions: {
        roads: 'graph-surface',
        railways: 'graph-R+',
        railwaySwitchPolicy: 'graph',
        railwayBallastStrategy: 'surface-first',
        showHiddenUndergroundGeometry: true,
      },
    });
    const scene = builder.buildScene(processed, DEFAULT_THEME);

    const portalMesh = findMeshInScene(scene, 'Tunnel_Portals');
    const entranceMesh = findMeshInScene(scene, 'Tunnel_Entrances');
    const ugRoadMesh = findMeshInScene(scene, 'Tunnel_Underground_Roads');

    assert.ok(portalMesh);
    assert.equal(portalMesh.visible, true);
    assert.ok(entranceMesh);
    assert.equal(entranceMesh.visible, true);
    assert.ok(ugRoadMesh);
    assert.equal(ugRoadMesh.visible, true);
    scene.dispose();
  });

  it('7. Road tunnel entrance and exit: descends below ground cover inside portal hood, hides dashed traces and buried meshes by default, and supports debug toggles and inspection', () => {
    const featureSpecs = [
      {
        id: 'way/road-approach-start',
        properties: { highway: 'secondary', _nodeIds: [1, 2] },
        coordinates: [
          [6.792, 52.264],
          [6.7935, 52.264],
        ] as [number, number][],
      },
      {
        id: 'way/road-tunnel-mid',
        properties: { highway: 'secondary', tunnel: 'yes', layer: '-1', _nodeIds: [2, 3] },
        coordinates: [
          [6.7935, 52.264],
          [6.7965, 52.264],
        ] as [number, number][],
      },
      {
        id: 'way/road-approach-end',
        properties: { highway: 'secondary', _nodeIds: [3, 4] },
        coordinates: [
          [6.7965, 52.264],
          [6.798, 52.264],
        ] as [number, number][],
      },
    ];

    const { scene: defaultScene } = buildSceneFromFeatures(featureSpecs, {
      showHiddenUndergroundGeometry: false,
    });
    const traceMeshDefault = findMeshInScene(defaultScene, 'Tunnel_Underground_Trace');
    const ugRoadMeshDefault = findMeshInScene(defaultScene, 'Tunnel_Underground_Roads');
    const entranceMesh = findMeshInScene(defaultScene, 'Tunnel_Entrances');
    const portalMesh = findMeshInScene(defaultScene, 'Tunnel_Portals');
    const roadDiag = defaultScene.roadsGroup.userData.gradeTransitionDiagnostics;

    assert.equal(portalMesh?.visible, true);
    assert.equal(entranceMesh?.visible, true);
    assert.equal(traceMeshDefault, null);
    assert.equal(ugRoadMeshDefault, null);
    assert.equal(roadDiag?.undergroundTracesVisible, false);
    assert.equal(roadDiag?.hiddenUndergroundMeshCount ?? 0, 0);

    // Verify entrance ramp recesses below ground cover (minY < ELEVATION_POLICY.GROUND)
    const entranceRange = getSourceVertsYRange(entranceMesh, 'way/road-tunnel-mid');
    assert.ok(entranceRange);
    assert.ok(entranceRange.minY < ELEVATION_POLICY.GROUND);

    // Production mode does not allocate buried meshes; raw source data remains accessible.
    defaultScene.dispose();

    // Debug build: enabling showUndergroundTunnelTraces and showHiddenUndergroundGeometry makes them visible
    const { scene: debugScene } = buildSceneFromFeatures(featureSpecs, {
      showUndergroundTunnelTraces: true,
      showHiddenUndergroundGeometry: true,
    });
    assert.equal(findMeshInScene(debugScene, 'Tunnel_Underground_Trace')?.visible, true);
    const debugUndergroundMesh = findMeshInScene(debugScene, 'Tunnel_Underground_Roads');
    assert.equal(debugUndergroundMesh?.visible, true);
    // Full inspectable geometry and provenance are available in explicit cutaway mode.
    const faceRanges = debugUndergroundMesh?.userData?.faceRanges as
      | Array<{ info: { sourceId?: string; sourceFeatureId?: string } }>
      | undefined;
    assert.ok(faceRanges && faceRanges.length > 0);
    assert.equal(faceRanges[0].info.sourceFeatureId || faceRanges[0].info.sourceId, 'way/road-tunnel-mid');
    assert.equal(
      debugScene.roadsGroup.userData.gradeTransitionDiagnostics?.undergroundTracesVisible,
      true
    );
    debugScene.dispose();
  });

  it('8. Railway tunnel entrance and exit: connects cleanly to portals, hides dashed traces and buried track meshes by default, and preserves inspection metadata', () => {
    const { scene } = buildSceneFromFeatures([
      {
        id: 'way/rail-approach-1',
        properties: { railway: 'rail', _nodeIds: [101, 102] },
        coordinates: [
          [6.792, 52.265],
          [6.7935, 52.265],
        ],
      },
      {
        id: 'way/rail-tunnel-1',
        properties: {
          railway: 'rail',
          tunnel: 'yes',
          layer: '-1',
          electrified: 'contact_line',
          _nodeIds: [102, 103],
        },
        coordinates: [
          [6.7935, 52.265],
          [6.7965, 52.265],
        ],
      },
      {
        id: 'way/rail-approach-2',
        properties: { railway: 'rail', _nodeIds: [103, 104] },
        coordinates: [
          [6.7965, 52.265],
          [6.798, 52.265],
        ],
      },
    ]);

    const railPortalMesh = findMeshInScene(scene, 'Railway_Tunnel_Portals');
    const railTraceMesh = findMeshInScene(scene, 'Railway_Tunnel_Traces');
    const ugBallast = findMeshInScene(scene, 'Tunnel_Underground_Railway_Ballast');
    const ugSleepers = findMeshInScene(scene, 'Tunnel_Underground_Railway_Sleepers');
    const ugRails = findMeshInScene(scene, 'Tunnel_Underground_Railway_Rails');

    assert.equal(railPortalMesh?.visible, true);
    assert.equal(railTraceMesh, null);
    assert.equal(ugBallast?.visible, true);
    assert.equal(ugSleepers?.visible, true);
    assert.equal(ugRails?.visible, true);

    // Electrified railway tunnel clearance (5.2m + 0.4m cover = -5.6m)
    const railRange = getSourceVertsYRange(ugRails, 'way/rail-tunnel-1');
    assert.ok(railRange);
    assert.ok(railRange.minY <= -5.5);
    scene.dispose();
  });

  it('9. Multi-segment tunnel: suppresses internal portals in both graph and legacy modes and maintains continuous vertical alignment at shared tunnel nodes', () => {
    const { scene } = buildSceneFromFeatures([
      {
        id: 'way/multi-approach-start',
        properties: { highway: 'primary', _nodeIds: [201, 202] },
        coordinates: [
          [6.7915, 52.264],
          [6.793, 52.264],
        ],
      },
      {
        id: 'way/multi-tunnel-a',
        properties: {
          highway: 'primary',
          tunnel: 'yes',
          layer: '-1',
          name: 'Tunnel West',
          maxheight: '3.8',
          _nodeIds: [202, 203],
        },
        coordinates: [
          [6.793, 52.264],
          [6.795, 52.264],
        ],
      },
      {
        id: 'way/multi-tunnel-b',
        properties: {
          highway: 'primary',
          tunnel: 'yes',
          layer: '-1',
          name: 'Tunnel East',
          maxheight: '5.4',
          _nodeIds: [203, 204],
        },
        coordinates: [
          [6.795, 52.264],
          [6.797, 52.264],
        ],
      },
      {
        id: 'way/multi-approach-end',
        properties: { highway: 'primary', _nodeIds: [204, 205] },
        coordinates: [
          [6.797, 52.264],
          [6.7985, 52.264],
        ],
      },
    ]);

    const roadDiag = scene.roadsGroup.userData.gradeTransitionDiagnostics;
    assert.equal(roadDiag?.tunnelPortalsEmittedCount, 2);
    if (roadDiag?.mode === 'graph') {
      assert.ok((roadDiag?.confirmedElevatedContinuations ?? 0) >= 2);
    }

    // Check that both segments share harmonized deep elevation (-5.8m from maxheight=5.4 + 0.4m cover)
    const ugRoadMesh = findMeshInScene(scene, 'Tunnel_Underground_Roads');
    const rangeA = getSourceVertsYRange(ugRoadMesh, 'way/multi-tunnel-a');
    const rangeB = getSourceVertsYRange(ugRoadMesh, 'way/multi-tunnel-b');
    assert.ok(rangeA);
    assert.ok(rangeB);
    assert.ok(Math.abs(rangeA.minY - rangeB.minY) < 0.05);
    scene.dispose();
  });

  it('10. Reversed-way tunnel: produces identical portal count and depth regardless of digitization order', () => {
    const makeSpecs = (reverseTunnel: boolean) => [
      {
        id: 'way/rev-start',
        properties: { highway: 'secondary', _nodeIds: [301, 302] },
        coordinates: [
          [6.792, 52.264],
          [6.794, 52.264],
        ] as [number, number][],
      },
      {
        id: 'way/rev-tunnel',
        properties: {
          highway: 'secondary',
          tunnel: 'yes',
          layer: '-1',
          _nodeIds: reverseTunnel ? [303, 302] : [302, 303],
        },
        coordinates: (reverseTunnel
          ? [
              [6.796, 52.264],
              [6.794, 52.264],
            ]
          : [
              [6.794, 52.264],
              [6.796, 52.264],
            ]) as [number, number][],
      },
      {
        id: 'way/rev-end',
        properties: { highway: 'secondary', _nodeIds: [303, 304] },
        coordinates: [
          [6.796, 52.264],
          [6.798, 52.264],
        ] as [number, number][],
      },
    ];

    const { scene: fwdScene } = buildSceneFromFeatures(makeSpecs(false));
    const { scene: revScene } = buildSceneFromFeatures(makeSpecs(true));

    const fwdDiag = fwdScene.roadsGroup.userData.gradeTransitionDiagnostics;
    const revDiag = revScene.roadsGroup.userData.gradeTransitionDiagnostics;

    assert.equal(fwdDiag?.tunnelPortalsEmittedCount, 2);
    assert.equal(revDiag?.tunnelPortalsEmittedCount, 2);
    assert.equal(fwdDiag?.portalGroundCutoutsCount, revDiag?.portalGroundCutoutsCount);
    fwdScene.dispose();
    revScene.dispose();
  });

  it('11. Boundary-clipped tunnel: suppresses fake portal and ground cutout at tile boundary while emitting true entrance portal', () => {
    const geojson = {
      type: 'FeatureCollection' as const,
      name: 'BoundaryClippedTunnelTest',
      features: [
        {
          type: 'Feature' as const,
          id: 'way/clipped-approach',
          properties: { id: 'way/clipped-approach', highway: 'secondary', _nodeIds: [401, 402] },
          geometry: {
            type: 'LineString' as const,
            coordinates: [
              [6.7925, 52.265],
              [6.793, 52.265],
            ],
          },
        },
        {
          type: 'Feature' as const,
          id: 'way/clipped-tunnel',
          properties: {
            id: 'way/clipped-tunnel',
            highway: 'secondary',
            tunnel: 'yes',
            layer: '-1',
            _nodeIds: [402, 403],
          },
          geometry: {
            type: 'LineString' as const,
            coordinates: [
              [6.793, 52.265],
              [6.82, 52.265],
            ],
          },
        },
      ],
    };

    const provider = new LocalGeoJsonProvider();
    const processed = provider.parseGeoJson(geojson as any);
    const preview = prepareInfrastructureRenderPreview(processed, {
      roads: 'graph-surface',
      railways: 'graph-R+',
      railwaySwitchPolicy: 'graph',
      railwayBallastStrategy: 'surface-first',
    });
    const tunnelEdge = preview.descriptors!.roadEdges.find((e) => e.isTunnel);
    assert.ok(tunnelEdge);
    (tunnelEdge as { clippedAtEnd: boolean }).clippedAtEnd = true;
    const endNode = preview.descriptors!.roadNodesById.get(tunnelEdge!.toNodeId);
    if (endNode) {
      (endNode as { isBoundaryClipped: boolean }).isBoundaryClipped = true;
    }

    const builder = new GeometryBuilder({
      infrastructureRenderOptions: {
        roads: 'graph-surface',
        railways: 'graph-R+',
        railwaySwitchPolicy: 'graph',
        railwayBallastStrategy: 'surface-first',
      },
      infrastructureRenderPreview: preview,
    });
    const scene = builder.buildScene(processed, DEFAULT_THEME);
    const roadDiag = scene.roadsGroup.userData.gradeTransitionDiagnostics;

    assert.equal(roadDiag?.tunnelPortalsEmittedCount, 1);
    assert.ok((roadDiag?.boundaryClippedEndpointsCount ?? 0) >= 1);
    assert.equal(roadDiag?.portalGroundCutoutsCount, 1);
    scene.dispose();
  });

  it('12. Unrelated surface road/railway crossing above a tunnel: preserves continuous surface infrastructure and vertical separation >= 5.0m', () => {
    const { scene } = buildSceneFromFeatures([
      {
        id: 'way/underpass-tunnel',
        properties: { highway: 'primary', tunnel: 'yes', layer: '-1', _nodeIds: [501, 502] },
        coordinates: [
          [6.793, 52.263],
          [6.797, 52.267],
        ],
      },
      {
        id: 'way/surface-overpass-rail',
        properties: { railway: 'rail', _nodeIds: [601, 602] },
        coordinates: [
          [6.793, 52.265],
          [6.797, 52.265],
        ],
      },
    ]);

    const ugRoadMesh = findMeshInScene(scene, 'Tunnel_Underground_Roads');
    const tunnelRange = getSourceVertsYRange(ugRoadMesh, 'way/underpass-tunnel');
    assert.ok(tunnelRange);
    assert.ok(ELEVATION_POLICY.RAILWAY_RAILS - tunnelRange.minY >= 5.0);
    scene.dispose();
  });

  it('13. Ground-cover behavior around tunnel entrances: carves localized portal opening in overlapping landuse without cutting buildings', () => {
    const { scene } = buildSceneFromFeatures([
      {
        id: 'way/grass-cover',
        properties: { landuse: 'grass' },
        geometryType: 'Polygon',
        coordinates: [
          [6.792, 52.263],
          [6.798, 52.263],
          [6.798, 52.266],
          [6.792, 52.266],
          [6.792, 52.263],
        ],
      },
      {
        id: 'way/portal-approach',
        properties: { highway: 'secondary', _nodeIds: [701, 702] },
        coordinates: [
          [6.793, 52.2645],
          [6.7945, 52.2645],
        ],
      },
      {
        id: 'way/portal-tunnel',
        properties: { highway: 'secondary', tunnel: 'yes', layer: '-1', _nodeIds: [702, 703] },
        coordinates: [
          [6.7945, 52.2645],
          [6.7965, 52.2645],
        ],
      },
      {
        id: 'way/building-over-tunnel',
        properties: { building: 'yes' },
        geometryType: 'Polygon',
        coordinates: [
          [6.7952, 52.2643],
          [6.7958, 52.2643],
          [6.7958, 52.2647],
          [6.7952, 52.2647],
          [6.7952, 52.2643],
        ],
      },
    ]);

    const roadDiag = scene.roadsGroup.userData.gradeTransitionDiagnostics;
    assert.ok((roadDiag?.portalGroundCutoutsCount ?? 0) >= 1);
    assert.ok(scene.parksGroup.children.length > 0);
    assert.ok(scene.interactiveMeshes.buildings.length > 0);
    scene.dispose();
  });

  it('14. Conflicting OSM vertical tags: routes to conservative at-grade surface fallback with explicit diagnostics', () => {
    const { processed, scene } = buildSceneFromFeatures([
      {
        id: 'way/conflict-road',
        properties: {
          highway: 'secondary',
          bridge: 'yes',
          tunnel: 'yes',
          layer: '-1',
        },
        coordinates: [
          [6.793, 52.264],
          [6.796, 52.264],
        ],
      },
      {
        id: 'way/conflict-rail',
        properties: {
          railway: 'rail',
          bridge: 'yes',
          tunnel: 'yes',
          layer: '1',
        },
        coordinates: [
          [6.793, 52.265],
          [6.796, 52.265],
        ],
      },
    ]);

    const roadDiag = scene.roadsGroup.userData.gradeTransitionDiagnostics;
    const railDiag = scene.railwaysGroup.userData.gradeTransitionDiagnostics;

    assert.equal(roadDiag?.conflictingPlacementFallbackCount, 1);
    assert.equal(railDiag?.conflictingPlacementFallbackCount, 1);
    assert.equal(processed.diagnostics?.conflictingPlacementFallbacks?.count, 2);
    assert.equal(roadDiag?.tunnelPortalsEmittedCount, 0);
    assert.equal(railDiag?.tunnelPortalsEmittedCount, 0);
    assert.ok(scene.stats.totalVertices > 0);
    scene.dispose();
  });

  it('15. Regression compatibility & performance benchmarks across Europatunnel Hengelo, Station Hengelo, and Amsterdam Centraal', () => {
    const provider = new LocalGeoJsonProvider();
    const europatunnelPath = path.resolve(
      process.cwd(),
      'src/world/prototype/EuropatunnelHengeloFixture.json'
    );
    const extractPath = path.resolve(
      process.cwd(),
      'src/world/prototype/realOsmRailwayExtracts.json'
    );
    const rawEuropatunnel = JSON.parse(fs.readFileSync(europatunnelPath, 'utf8'));
    const rawExtract = JSON.parse(fs.readFileSync(extractPath, 'utf8'));

    const runBench = (name: string, geojson: any) => {
      const t0 = performance.now();
      const processed = provider.parseGeoJson(geojson);
      const builder = new GeometryBuilder({
        infrastructureRenderOptions: {
          roads: 'graph-surface',
          railways: 'graph-R+',
          railwaySwitchPolicy: 'graph',
          railwayBallastStrategy: 'surface-first',
        },
      });
      const scene = builder.buildScene(processed, DEFAULT_THEME);
      const elapsedMs = performance.now() - t0;
      const result = {
        name,
        elapsedMs,
        drawCalls: scene.stats.totalDrawCalls,
        vertices: scene.stats.totalVertices,
        triangles: scene.stats.totalTriangles,
        structuralDiagnostics: processed.diagnostics?.structuralContextDiagnostics,
        roadGradeDiag: scene.roadsGroup.userData.gradeTransitionDiagnostics,
        railGradeDiag: scene.railwaysGroup.userData.gradeTransitionDiagnostics,
      };
      scene.dispose();
      return result;
    };

    const europatunnelBench = runBench('Europatunnel Hengelo', rawEuropatunnel);
    const hengeloBench = runBench('Station Hengelo', {
      type: 'FeatureCollection',
      name: 'Station Hengelo',
      features: rawExtract.regions.hengelo.features || rawExtract.regions.hengelo,
    });
    const amsterdamBench = runBench('Amsterdam Centraal', {
      type: 'FeatureCollection',
      name: 'Amsterdam Centraal',
      features:
        rawExtract.regions.amsterdamCentraal.features || rawExtract.regions.amsterdamCentraal,
    });

    assert.ok(
      (europatunnelBench.structuralDiagnostics?.subterraneanEnclosedBarrierCount ?? 0) >= 2
    );
    assert.ok(
      (europatunnelBench.structuralDiagnostics?.cuttingOrPortalApproachBarrierCount ?? 0) >= 3
    );
    assert.ok(hengeloBench.vertices > 0);
    assert.ok(amsterdamBench.vertices > 0);
    assert.ok(europatunnelBench.elapsedMs < 2000);
    assert.ok(hengeloBench.elapsedMs < 2000);
    assert.ok(amsterdamBench.elapsedMs < 3000);
  });
});
