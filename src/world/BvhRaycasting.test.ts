import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { GeometryBuilder, resolveInspectedFeature } from './GeometryBuilder';
import { SceneResourceManager } from './SceneResourceManager';
import { MAP_THEMES } from '../styles/mapThemes';
import { unprojectToGeo } from './WorldCoordinates';

function rectLonLatRing(
  cxMeters: number,
  czMeters: number,
  halfW: number,
  halfD: number,
  originLon: number = 6.7935,
  originLat: number = 52.2625
): [number, number][] {
  const corners: [number, number][] = [
    [cxMeters - halfW, czMeters - halfD],
    [cxMeters + halfW, czMeters - halfD],
    [cxMeters + halfW, czMeters + halfD],
    [cxMeters - halfW, czMeters + halfD],
    [cxMeters - halfW, czMeters - halfD],
  ];
  return corners.map(([x, z]) => {
    const [lon, lat] = unprojectToGeo(x, z, originLon, originLat);
    return [Number(lon.toFixed(7)), Number(lat.toFixed(7))];
  });
}

function buildMixedLayerFixtureGeoJson() {
  const originLon = 6.7935;
  const originLat = 52.2625;
  const pt = (x: number, z: number): [number, number] => {
    const [lon, lat] = unprojectToGeo(x, z, originLon, originLat);
    return [Number(lon.toFixed(7)), Number(lat.toFixed(7))];
  };

  return {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        id: 'way/1001',
        properties: { '@id': 'way/1001', building: 'house', name: 'House A', 'building:levels': '2' },
        geometry: { type: 'Polygon' as const, coordinates: [rectLonLatRing(-30, -20, 6, 5)] },
      },
      {
        type: 'Feature' as const,
        id: 'way/1002',
        properties: { '@id': 'way/1002', building: 'apartments', name: 'Tower B', height: '18' },
        geometry: { type: 'Polygon' as const, coordinates: [rectLonLatRing(-10, -20, 7, 6)] },
      },
      {
        type: 'Feature' as const,
        id: 'way/1003',
        properties: { '@id': 'way/1003', building: 'roof', name: 'Station Canopy', height: '6' },
        geometry: { type: 'Polygon' as const, coordinates: [rectLonLatRing(15, -20, 6, 5)] },
      },
      {
        type: 'Feature' as const,
        id: 'way/2001',
        properties: { '@id': 'way/2001', highway: 'residential', name: 'Main Street' },
        geometry: { type: 'LineString' as const, coordinates: [pt(-50, 0), pt(0, 0), pt(50, 0)] },
      },
      {
        type: 'Feature' as const,
        id: 'way/2002',
        properties: { '@id': 'way/2002', highway: 'service', name: 'Side Alley' },
        geometry: { type: 'LineString' as const, coordinates: [pt(0, -40), pt(0, 0), pt(0, 40)] },
      },
      {
        type: 'Feature' as const,
        id: 'way/3001',
        properties: { '@id': 'way/3001', railway: 'rail', name: 'Mainline Track' },
        geometry: { type: 'LineString' as const, coordinates: [pt(-50, 25), pt(50, 25)] },
      },
      {
        type: 'Feature' as const,
        id: 'way/4001',
        properties: { '@id': 'way/4001', leisure: 'park', name: 'Central Green' },
        geometry: { type: 'Polygon' as const, coordinates: [rectLonLatRing(30, 20, 12, 10)] },
      },
      {
        type: 'Feature' as const,
        id: 'way/5001',
        properties: { '@id': 'way/5001', landuse: 'residential', name: 'Residential Zone' },
        geometry: { type: 'Polygon' as const, coordinates: [rectLonLatRing(-20, -20, 35, 20)] },
      },
      {
        type: 'Feature' as const,
        id: 'way/6001',
        properties: { '@id': 'way/6001', natural: 'water', name: 'Mirror Pond' },
        geometry: { type: 'Polygon' as const, coordinates: [rectLonLatRing(-35, 20, 10, 8)] },
      },
      {
        type: 'Feature' as const,
        id: 'way/7001',
        properties: { '@id': 'way/7001', barrier: 'wall', name: 'Perimeter Wall' },
        geometry: { type: 'LineString' as const, coordinates: [pt(-45, -35), pt(45, -35)] },
      },
      {
        type: 'Feature' as const,
        id: 'node/8001',
        properties: { '@id': 'node/8001', natural: 'tree', name: 'Lone Oak' },
        geometry: { type: 'Point' as const, coordinates: pt(12, 12) },
      },
    ],
  };
}

test('TKT-024: SceneResourceManager constructs indirect MeshBVH once without mutating geometry and disposes cleanly', () => {
  const rm = new SceneResourceManager();

  // 1. Non-indexed multi-material geometry (e.g. merged building bucket)
  const nonIndexedGeo = rm.registerGeometry(new THREE.BufferGeometry());
  const posArr = new Float32Array([
    // tri 0 (group 0: roof)
    0, 10, 0,  5, 10, 0,  0, 10, 5,
    // tri 1 (group 0: roof)
    20, 10, 0, 25, 10, 0, 20, 10, 5,
    // tri 2 (group 1: wall)
    0, 0, 0,   5, 0, 0,   0, 10, 0,
    // tri 3 (group 1: wall)
    20, 0, 0,  25, 0, 0,  20, 10, 0,
  ]);
  nonIndexedGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  nonIndexedGeo.addGroup(0, 6, 0);
  nonIndexedGeo.addGroup(6, 6, 1);

  const multiMats = [
    rm.registerMaterial(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })),
    rm.registerMaterial(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })),
  ];
  const multiMesh = new THREE.Mesh(nonIndexedGeo, multiMats);
  rm.enableMeshBvh(multiMesh);

  assert.equal(nonIndexedGeo.index, null, 'Non-indexed geometry must remain non-indexed');
  assert.equal(nonIndexedGeo.groups.length, 2, 'Material groups must remain intact');
  assert.ok((nonIndexedGeo as any).boundsTree instanceof MeshBVH, 'boundsTree must be a MeshBVH');
  assert.equal((nonIndexedGeo as any).boundsTree.indirect, true, 'MeshBVH must use indirect mode');
  assert.equal(multiMesh.raycast, acceleratedRaycast, 'Mesh must use acceleratedRaycast');

  const firstBvhRef = (nonIndexedGeo as any).boundsTree;
  rm.enableMeshBvh(multiMesh);
  assert.equal(
    (nonIndexedGeo as any).boundsTree,
    firstBvhRef,
    'enableMeshBvh must be idempotent and not rebuild an existing boundsTree'
  );

  // 2. Indexed single-material geometry with sparse groups (like merged roads + ShapeGeometry caps)
  const indexedGeo = rm.registerGeometry(new THREE.BufferGeometry());
  const roadPos = new Float32Array([
    // tri 0 at x=0 (covered by group)
    0, 0.1, 0,   2, 0.1, 0,   0, 0.1, 2,
    // tri 1 at x=50 (NOT covered by sparse group!)
    50, 0.1, 0,  52, 0.1, 0,  50, 0.1, 2,
  ]);
  const origIndices = new Uint16Array([3, 4, 5, 0, 1, 2]);
  indexedGeo.setAttribute('position', new THREE.BufferAttribute(roadPos, 3));
  indexedGeo.setIndex(new THREE.BufferAttribute(origIndices.slice(), 1));
  // Sparse group only covering first 3 indices
  indexedGeo.addGroup(0, 3, 0);

  const singleMat = rm.registerMaterial(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const roadMesh = new THREE.Mesh(indexedGeo, singleMat);
  roadMesh.updateMatrixWorld(true);
  rm.enableMeshBvh(roadMesh);

  assert.deepEqual(
    Array.from(indexedGeo.index!.array),
    Array.from(origIndices),
    'Indexed geometry index buffer must not be reordered or mutated'
  );
  assert.deepEqual(
    indexedGeo.groups,
    [{ start: 0, count: 3, materialIndex: 0 }],
    'Single-material geometry.groups must be restored unchanged after BVH construction'
  );

  // Raycast against BOTH triangles on the sparse-group single-material mesh:
  // faceIndex 0 is at x=50 (indices 3,4,5), faceIndex 1 is at x=0 (indices 0,1,2)
  const ray0 = new THREE.Raycaster(new THREE.Vector3(50.5, 5, 0.5), new THREE.Vector3(0, -1, 0));
  const hit0 = ray0.intersectObject(roadMesh, false);
  assert.equal(hit0.length, 1);
  assert.equal(hit0[0].faceIndex, 0, 'BVH must hit faceIndex 0 at x=50');

  const ray1 = new THREE.Raycaster(new THREE.Vector3(0.5, 5, 0.5), new THREE.Vector3(0, -1, 0));
  const hit1 = ray1.intersectObject(roadMesh, false);
  assert.equal(hit1.length, 1);
  assert.equal(hit1[0].faceIndex, 1, 'BVH must hit faceIndex 1 at x=0 even outside sparse group');

  // Verify BVH memory accounting and clean disposal
  const bvhStatsBefore = rm.getBvhMemoryStats();
  assert.equal(bvhStatsBefore.bvhCount, 2);
  assert.ok(bvhStatsBefore.rootBytes > 0);
  assert.ok(bvhStatsBefore.indirectBufferBytes > 0);
  assert.equal(bvhStatsBefore.totalBytes, bvhStatsBefore.rootBytes + bvhStatsBefore.indirectBufferBytes);

  rm.dispose();
  assert.equal((nonIndexedGeo as any).boundsTree, undefined, 'boundsTree must be cleared on dispose');
  assert.equal((indexedGeo as any).boundsTree, undefined, 'boundsTree must be cleared on dispose');
  const bvhStatsAfter = rm.getBvhMemoryStats();
  assert.equal(bvhStatsAfter.bvhCount, 0);
  assert.equal(bvhStatsAfter.totalBytes, 0);
});

test('TKT-024: Full-scene BVH raycasting matches standard Three.js raycasting 100% across all layers', () => {
  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(
    buildMixedLayerFixtureGeoJson(),
    'TKT-024 Mixed Layer Fixture',
    [6.7935, 52.2625],
    200
  );
  const scene = new GeometryBuilder({
    bevelEnabled: true,
    infrastructureRenderOptions: { roads: 'graph-surface', railways: 'graph-R+' },
  }).buildScene(parsed, MAP_THEMES.tactical);

  const root = new THREE.Group();
  root.add(
    scene.groundMesh,
    scene.landuseGroup,
    scene.parksGroup,
    scene.waterGroup,
    scene.roadsGroup,
    scene.railwaysGroup,
    scene.buildingsGroup,
    scene.foliageGroup,
    scene.barriersGroup
  );
  root.updateMatrixWorld(true);

  // Verify every non-instanced mesh in the scene has BVH attached at build time
  const meshesWithBvh: Array<{ mesh: THREE.Mesh; bvh: MeshBVH }> = [];
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh && !(obj instanceof THREE.InstancedMesh)) {
      const geo = obj.geometry as THREE.BufferGeometry;
      if (geo.attributes?.position?.count >= 3) {
        const bvh = (geo as any).boundsTree as MeshBVH | undefined;
        assert.ok(bvh instanceof MeshBVH, `Mesh "${obj.name}" must have a precomputed MeshBVH`);
        assert.equal(bvh.indirect, true, `Mesh "${obj.name}" BVH must be indirect`);
        assert.equal(obj.raycast, acceleratedRaycast, `Mesh "${obj.name}" must use acceleratedRaycast`);
        meshesWithBvh.push({ mesh: obj, bvh });
      }
    }
  });
  assert.ok(meshesWithBvh.length >= 8, 'Scene must have BVHs across all active mesh layers');

  const camera = new THREE.OrthographicCamera(-60, 60, 60, -60, 0.1, 2000);
  camera.position.set(80, 120, 80);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const raycaster = new THREE.Raycaster();
  (raycaster as any).firstHitOnly = true;

  const hitCategories = new Set<string>();
  const hitFeatureIds = new Set<string>();

  for (let gx = -0.9; gx <= 0.901; gx += 0.12) {
    for (let gy = -0.9; gy <= 0.901; gy += 0.12) {
      raycaster.setFromCamera(new THREE.Vector2(gx, gy), camera);

      // 1. BVH-accelerated raycast
      const bvhHits = raycaster.intersectObjects(root.children, true);
      const bvhFirst = bvhHits[0];
      const bvhInfo = bvhFirst ? resolveInspectedFeature(bvhFirst) : null;

      // 2. Temporarily switch all meshes to standard Three.js Mesh.prototype.raycast and compare
      for (const { mesh } of meshesWithBvh) {
        mesh.raycast = THREE.Mesh.prototype.raycast;
      }
      const stdHits = raycaster.intersectObjects(root.children, true);
      for (const { mesh } of meshesWithBvh) {
        mesh.raycast = acceleratedRaycast;
      }
      const stdFirst = stdHits[0];
      const stdInfo = stdFirst ? resolveInspectedFeature(stdFirst) : null;

      assert.equal(bvhFirst?.object?.name ?? null, stdFirst?.object?.name ?? null);
      assert.equal(bvhFirst?.faceIndex ?? null, stdFirst?.faceIndex ?? null);
      assert.equal(bvhFirst?.instanceId ?? null, stdFirst?.instanceId ?? null);
      assert.equal(bvhInfo?.id ?? null, stdInfo?.id ?? null);
      assert.equal(bvhInfo?.sourceFeatureId ?? null, stdInfo?.sourceFeatureId ?? null);
      assert.equal(bvhInfo?.category ?? null, stdInfo?.category ?? null);
      if (bvhFirst && stdFirst) {
        assert.ok(Math.abs(bvhFirst.distance - stdFirst.distance) < 1e-5);
      }

      if (bvhInfo) {
        hitCategories.add(bvhInfo.category);
        hitFeatureIds.add(bvhInfo.sourceFeatureId || bvhInfo.id);
      }
    }
  }

  // Also cast targeted vertical rays directly onto each feature's world coordinates
  // (including building roofs, canopy, roads, railway, park, landuse, water, barrier, and instanced tree)
  const targetedCoords: Array<[number, number]> = [
    [-29.7, -19.8], // way/1001 building
    [-9.7, -19.8],  // way/1002 building
    [15.3, -19.8],  // way/1003 open-air roof canopy
    [-25.3, 0.2],   // way/2001 road
    [0.3, 0.2],     // road junction
    [0.3, 25.1],    // way/3001 railway
    [30.4, 20.2],   // way/4001 park
    [-25.3, -5.2],  // way/5001 landuse
    [-34.6, 20.2],  // way/6001 water
    [0.3, -35.0],   // way/7001 barrier wall
    [12.0, 12.0],   // node/8001 instanced tree
  ];
  for (const [tx, tz] of targetedCoords) {
    raycaster.set(new THREE.Vector3(tx, 100, tz), new THREE.Vector3(0, -1, 0));

    const bvhHits = raycaster.intersectObjects(root.children, true);
    let bvhInfo = null;
    for (const h of bvhHits) {
      const c = resolveInspectedFeature(h);
      if (c) {
        bvhInfo = c;
        break;
      }
    }

    for (const { mesh } of meshesWithBvh) {
      mesh.raycast = THREE.Mesh.prototype.raycast;
    }
    const stdHits = raycaster.intersectObjects(root.children, true);
    for (const { mesh } of meshesWithBvh) {
      mesh.raycast = acceleratedRaycast;
    }
    let stdInfo = null;
    for (const h of stdHits) {
      const c = resolveInspectedFeature(h);
      if (c) {
        stdInfo = c;
        break;
      }
    }

    assert.equal(bvhHits[0]?.object?.name ?? null, stdHits[0]?.object?.name ?? null);
    assert.equal(bvhHits[0]?.faceIndex ?? null, stdHits[0]?.faceIndex ?? null);
    assert.equal(bvhHits[0]?.instanceId ?? null, stdHits[0]?.instanceId ?? null);
    assert.equal(bvhInfo?.id ?? null, stdInfo?.id ?? null);
    assert.equal(bvhInfo?.sourceFeatureId ?? null, stdInfo?.sourceFeatureId ?? null);
    if (bvhInfo) {
      hitCategories.add(bvhInfo.category);
      hitFeatureIds.add(bvhInfo.sourceFeatureId || bvhInfo.id);
    }
  }

  // Confirm BVH references were not rebuilt during raycasting
  for (const { mesh, bvh } of meshesWithBvh) {
    assert.equal((mesh.geometry as any).boundsTree, bvh);
  }

  assert.ok(hitFeatureIds.has('way/1001'), 'Must hit and resolve Building way/1001');
  assert.ok(hitFeatureIds.has('way/1002'), 'Must hit and resolve Building way/1002');
  assert.ok(hitFeatureIds.has('way/1003'), 'Must hit and resolve Canopy Building way/1003');
  assert.ok(hitFeatureIds.has('way/2001'), 'Must hit and resolve Road way/2001');
  assert.ok(hitFeatureIds.has('way/3001'), 'Must hit and resolve Railway way/3001');
  assert.ok(hitFeatureIds.has('way/4001'), 'Must hit and resolve Park way/4001');
  assert.ok(hitFeatureIds.has('way/5001'), 'Must hit and resolve Landuse way/5001');
  assert.ok(hitFeatureIds.has('way/6001'), 'Must hit and resolve Water way/6001');
  assert.ok(hitFeatureIds.has('way/7001'), 'Must hit and resolve Barrier way/7001');
  assert.ok(hitFeatureIds.has('node/8001'), 'Must hit and resolve Instanced Tree node/8001');

  const bvhMem = scene.resources.getBvhMemoryStats();
  assert.equal(bvhMem.bvhCount, meshesWithBvh.length);
  assert.ok(bvhMem.totalBytes > 0);

  scene.dispose();
  assert.equal(scene.resources.getBvhMemoryStats().bvhCount, 0);
  assert.equal(scene.resources.getBvhMemoryStats().totalBytes, 0);
  for (const { mesh } of meshesWithBvh) {
    assert.equal((mesh.geometry as any).boundsTree, undefined);
  }
});

test('TKT-024: Hengelo S1 real OSM dataset BVH raycast parity and sub-millisecond performance', () => {
  const datasetPath = 'benchmarks/datasets/hengelo-scaling/hengelo-s1-250m.geojson.gz';
  if (!fs.existsSync(datasetPath)) return;

  const raw = zlib.gunzipSync(fs.readFileSync(datasetPath)).toString('utf-8');
  const fc = JSON.parse(raw);
  const parsed = new LocalGeoJsonProvider().parseGeoJson(fc, 'Hengelo S1', [6.7935, 52.2625], 250);
  const scene = new GeometryBuilder({
    bevelEnabled: true,
    infrastructureRenderOptions: { roads: 'graph-surface', railways: 'graph-R+' },
  }).buildScene(parsed, MAP_THEMES.tactical);

  const root = new THREE.Group();
  root.add(
    scene.groundMesh,
    scene.landuseGroup,
    scene.parksGroup,
    scene.waterGroup,
    scene.roadsGroup,
    scene.railwaysGroup,
    scene.buildingsGroup,
    scene.foliageGroup,
    scene.barriersGroup
  );
  root.updateMatrixWorld(true);

  const camera = new THREE.OrthographicCamera(-120, 120, 120, -120, 0.1, 2000);
  camera.position.set(100, 180, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const meshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh && !(obj instanceof THREE.InstancedMesh)) {
      meshes.push(obj);
    }
  });

  const raycaster = new THREE.Raycaster();
  (raycaster as any).firstHitOnly = true;

  for (let gx = -0.8; gx <= 0.801; gx += 0.4) {
    for (let gy = -0.8; gy <= 0.801; gy += 0.4) {
      raycaster.setFromCamera(new THREE.Vector2(gx, gy), camera);

      const bvhHits = raycaster.intersectObjects(root.children, true);
      const bvhInfo = bvhHits[0] ? resolveInspectedFeature(bvhHits[0]) : null;

      for (const m of meshes) m.raycast = THREE.Mesh.prototype.raycast;
      const stdHits = raycaster.intersectObjects(root.children, true);
      for (const m of meshes) m.raycast = acceleratedRaycast;
      const stdInfo = stdHits[0] ? resolveInspectedFeature(stdHits[0]) : null;

      assert.equal(bvhInfo?.id ?? null, stdInfo?.id ?? null);
      assert.equal(bvhInfo?.sourceFeatureId ?? null, stdInfo?.sourceFeatureId ?? null);
      assert.equal(bvhHits[0]?.faceIndex ?? null, stdHits[0]?.faceIndex ?? null);
    }
  }

  scene.dispose();
  assert.equal(scene.resources.getBvhMemoryStats().totalBytes, 0);
});
