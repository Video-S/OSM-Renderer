import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import {
  GeometryBuilder,
  mergeBuildingItemsByMaterial,
  resolveInspectedFeature,
} from './GeometryBuilder';
import { SceneResourceManager } from './SceneResourceManager';
import { MAP_THEMES } from '../styles/mapThemes';
import type { InspectableFeatureInfo } from '../types/MapFeature';
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

function makeTestInfo(id: string, name: string): InspectableFeatureInfo {
  return {
    id,
    sourceFeatureId: id,
    name,
    category: 'Building',
    cartoLabel: 'Building',
    primaryTag: 'building=yes',
    subtype: 'yes',
    type: 'yes',
    height: 10,
    heightFormatted: '10.0m',
    levels: 3,
    osmTags: { building: 'yes', name },
  };
}

function collectQuantizedTrianglesByMaterial(
  geom: THREE.BufferGeometry
): Map<number, string[]> {
  const nonIdx = geom.index ? geom.toNonIndexed() : geom;
  const pos = nonIdx.attributes.position;
  const norm = nonIdx.attributes.normal;
  const result = new Map<number, string[]>();
  const groups =
    nonIdx.groups && nonIdx.groups.length > 0
      ? nonIdx.groups
      : [{ start: 0, count: pos.count, materialIndex: 0 }];

  const fmt = (n: number) => (Math.abs(n) < 1e-6 ? '0.0000' : n.toFixed(4));

  for (const grp of groups) {
    const matIdx = grp.materialIndex ?? 0;
    const end = Math.min(pos.count, grp.start + grp.count);
    let list = result.get(matIdx);
    if (!list) {
      list = [];
      result.set(matIdx, list);
    }
    for (let v = grp.start; v + 2 < end; v += 3) {
      const verts: string[] = [];
      for (let k = 0; k < 3; k++) {
        const idx = v + k;
        const p = `${fmt(pos.getX(idx))},${fmt(pos.getY(idx))},${fmt(pos.getZ(idx))}`;
        const n = norm
          ? `${fmt(norm.getX(idx))},${fmt(norm.getY(idx))},${fmt(norm.getZ(idx))}`
          : '0,0,0';
        verts.push(`${p}|${n}`);
      }
      verts.sort();
      list.push(verts.join(';'));
    }
  }

  for (const list of result.values()) {
    list.sort();
  }
  if (nonIdx !== geom) nonIdx.dispose();
  return result;
}

function buildMultiBucketFixtureGeoJson() {
  const originLon = 6.7935;
  const originLat = 52.2625;
  return {
    type: 'FeatureCollection' as const,
    name: 'TKT-023 Building Batching Fixture',
    features: [
      // Default bucket: 3 ordinary buildings (including one with an interior courtyard hole)
      {
        type: 'Feature',
        id: 'way/1001',
        properties: {
          '@id': 'way/1001',
          name: 'House Alpha',
          building: 'residential',
          height: '9.6',
          'addr:housenumber': '10',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [rectLonLatRing(-40, -20, 8, 6, originLon, originLat)],
        },
      },
      {
        type: 'Feature',
        id: 'way/1002',
        properties: {
          '@id': 'way/1002',
          name: 'Courtyard Block Beta',
          building: 'apartments',
          'building:levels': '4',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            rectLonLatRing(10, -20, 14, 14, originLon, originLat),
            rectLonLatRing(10, -20, 5, 5, originLon, originLat).reverse(),
          ],
        },
      },
      {
        type: 'Feature',
        id: 'way/1003',
        properties: {
          '@id': 'way/1003',
          name: 'Canopy Gamma',
          building: 'roof',
          height: '6.0',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [rectLonLatRing(-40, 25, 12, 5, originLon, originLat)],
        },
      },
      // Archetype buckets: industrial (2), commercial (2)
      {
        type: 'Feature',
        id: 'way/2001',
        properties: {
          '@id': 'way/2001',
          name: 'Factory Hall 1',
          building: 'industrial',
          height: '11',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [rectLonLatRing(45, 25, 12, 9, originLon, originLat)],
        },
      },
      {
        type: 'Feature',
        id: 'way/2002',
        properties: {
          '@id': 'way/2002',
          name: 'Warehouse 2',
          building: 'warehouse',
          height: '14',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [rectLonLatRing(75, 25, 10, 8, originLon, originLat)],
        },
      },
      {
        type: 'Feature',
        id: 'way/2003',
        properties: {
          '@id': 'way/2003',
          name: 'Shop Plaza',
          building: 'commercial',
          height: '8',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [rectLonLatRing(45, -20, 9, 7, originLon, originLat)],
        },
      },
      {
        type: 'Feature',
        id: 'way/2004',
        properties: {
          '@id': 'way/2004',
          name: 'Corner Retail',
          building: 'retail',
          height: '7',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [rectLonLatRing(72, -20, 7, 6, originLon, originLat)],
        },
      },
      // Single-building Landmark bucket (`building=yes` + `amenity` without archetype color override)
      {
        type: 'Feature',
        id: 'way/3001',
        properties: {
          '@id': 'way/3001',
          name: 'Landmark Pavilion',
          building: 'yes',
          amenity: 'landmark',
          height: '18',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [rectLonLatRing(10, 30, 11, 8, originLon, originLat)],
        },
      },
      // Non-building context features (must remain unaffected)
      {
        type: 'Feature',
        id: 'way/4001',
        properties: { '@id': 'way/4001', highway: 'residential', name: 'Stationweg' },
        geometry: {
          type: 'LineString',
          coordinates: [
            unprojectToGeo(-80, 0, originLon, originLat),
            unprojectToGeo(90, 0, originLon, originLat),
          ],
        },
      },
      {
        type: 'Feature',
        id: 'way/4002',
        properties: { '@id': 'way/4002', leisure: 'park', name: 'Green Square' },
        geometry: {
          type: 'Polygon',
          coordinates: [rectLonLatRing(-75, -50, 12, 10, originLon, originLat)],
        },
      },
    ],
  };
}

test('mergeBuildingItemsByMaterial consolidates groups to <=1 per materialIndex with exact triangle & normal parity', () => {
  const rm = new SceneResourceManager();
  const s1 = new THREE.Shape();
  s1.moveTo(0, 0);
  s1.lineTo(10, 0);
  s1.lineTo(10, 8);
  s1.lineTo(0, 8);
  s1.closePath();

  const s2 = new THREE.Shape();
  s2.moveTo(20, 0);
  s2.lineTo(32, 0);
  s2.lineTo(32, 10);
  s2.lineTo(20, 10);
  s2.closePath();

  const g1 = rm.registerGeometry(
    new THREE.ExtrudeGeometry(s1, { depth: 9, bevelEnabled: true, bevelSegments: 1, bevelSize: 0.1, bevelThickness: 0.1 })
  );
  g1.rotateX(-Math.PI / 2);

  const g2 = rm.registerGeometry(
    new THREE.ExtrudeGeometry(s2, { depth: 12, bevelEnabled: true, bevelSegments: 1, bevelSize: 0.1, bevelThickness: 0.1 })
  );
  g2.rotateX(-Math.PI / 2);

  // Also include an indexed geometry with no groups (defaults to materialIndex 0)
  const g3 = rm.registerGeometry(new THREE.SphereGeometry(2, 8, 6));
  g3.translate(-15, 2.5, 0);

  const expectedByMat = new Map<number, string[]>();
  for (const src of [g1, g2, g3]) {
    const partMap = collectQuantizedTrianglesByMaterial(src);
    for (const [m, tris] of partMap.entries()) {
      const acc = expectedByMat.get(m) || [];
      acc.push(...tris);
      expectedByMat.set(m, acc);
    }
  }
  for (const list of expectedByMat.values()) list.sort();

  const info1 = makeTestInfo('b1', 'Alpha');
  const info2 = makeTestInfo('b2', 'Beta');
  const info3 = makeTestInfo('b3', 'GammaBox');

  const { merged, faceRanges } = mergeBuildingItemsByMaterial(
    [
      { geom: g1, info: info1 },
      { geom: g2, info: info2 },
      { geom: g3, info: info3 },
    ],
    rm
  );

  assert.ok(merged, 'Merged building geometry must be non-null');
  rm.registerGeometry(merged);

  // Strictly 2 consolidated groups: materialIndex 0 and materialIndex 1
  assert.equal(merged.groups.length, 2);
  assert.deepEqual(
    merged.groups.map((g) => g.materialIndex),
    [0, 1]
  );
  assert.equal(merged.groups[0].start, 0);
  assert.equal(merged.groups[0].start + merged.groups[0].count, merged.groups[1].start);
  assert.equal(
    merged.groups[1].start + merged.groups[1].count,
    merged.attributes.position.count
  );

  // Exact triangle + normal parity per materialIndex
  const actualByMat = collectQuantizedTrianglesByMaterial(merged);
  assert.deepEqual(actualByMat.get(0), expectedByMat.get(0));
  assert.deepEqual(actualByMat.get(1), expectedByMat.get(1));

  // Face ranges cover every triangle without gaps and map every sampled triangle in both roof and wall groups
  const totalTris = merged.attributes.position.count / 3;
  let cursor = 0;
  const seenIdsByMat = new Map<number, Set<string>>();
  for (const r of faceRanges) {
    assert.equal(r.startFace, cursor);
    assert.ok(r.endFace > r.startFace);
    cursor = r.endFace;
  }
  assert.equal(cursor, totalTris);

  const mockMesh = { userData: { faceRanges } };
  for (const grp of merged.groups) {
    const matIdx = grp.materialIndex ?? 0;
    const startFace = grp.start / 3;
    const endFace = (grp.start + grp.count) / 3;
    const seen = new Set<string>();
    for (let f = startFace; f < endFace; f++) {
      const resolved = resolveInspectedFeature({ object: mockMesh, faceIndex: f });
      assert.ok(resolved, `Face ${f} in material group ${matIdx} must resolve`);
      seen.add(resolved.id);
    }
    seenIdsByMat.set(matIdx, seen);
  }
  assert.deepEqual(Array.from(seenIdsByMat.get(0)!).sort(), ['b1', 'b2', 'b3']);
  assert.deepEqual(Array.from(seenIdsByMat.get(1)!).sort(), ['b1', 'b2']);

  // Only the single merged geometry remains owned prior to final dispose; intermediates freed
  assert.equal(rm.ownedGeometriesCount, 1);
  rm.dispose();
  assert.equal(rm.ownedGeometriesCount, 0);
});

test('mergeBuildingItemsByMaterial handles empty inputs cleanly', () => {
  const { merged, faceRanges } = mergeBuildingItemsByMaterial([]);
  assert.equal(merged, null);
  assert.deepEqual(faceRanges, []);
});

test('GeometryBuilder consolidates building bucket material groups while preserving all roofs, walls, pillars, shadows, inspection, themes, and disposal', () => {
  for (const bevelEnabled of [true, false]) {
    const provider = new LocalGeoJsonProvider();
    const parsed = provider.parseGeoJson(
      buildMultiBucketFixtureGeoJson(),
      'TKT-023 Fixture',
      [6.7935, 52.2625],
      500
    );

    const builder = new GeometryBuilder({ bevelEnabled });
    const scene = builder.buildScene(parsed, MAP_THEMES.tactical);

    const bucketMeshes = scene.buildingsGroup.children as THREE.Mesh[];
    assert.equal(
      bucketMeshes.length,
      4,
      `Expected 4 buckets (default, arch_industrial, arch_commercial, landmark) with bevelEnabled=${bevelEnabled}`
    );

    const expectedFeatureIdsByBucket: Record<string, string[]> = {
      Buildings_default: ['way/1001', 'way/1002'],
      Buildings_arch_industrial: ['way/1003', 'way/2001', 'way/2002'],
      Buildings_arch_commercial: ['way/2003', 'way/2004'],
      Buildings_landmark: ['way/3001'],
    };

    for (const mesh of bucketMeshes) {
      assert.ok(mesh.castShadow, `${mesh.name} must castShadow`);
      assert.ok(mesh.receiveShadow, `${mesh.name} must receiveShadow`);
      assert.ok(Array.isArray(mesh.material), `${mesh.name} must preserve [roofMat, wallMat] material array`);

      const geom = mesh.geometry;
      const groups = geom.groups;
      assert.ok(
        groups.length >= 1 && groups.length <= 2,
        `${mesh.name} must have at most 2 consolidated material groups, got ${groups.length}`
      );
      assert.deepEqual(
        groups.map((g) => g.materialIndex),
        groups.length === 2 ? [0, 1] : [0]
      );

      // Verify contiguous group coverage across entire BufferGeometry
      let expectedStart = 0;
      for (const g of groups) {
        assert.equal(g.start, expectedStart);
        assert.equal(g.count % 3, 0);
        assert.ok(g.count > 0);
        expectedStart += g.count;
      }
      assert.equal(expectedStart, geom.attributes.position.count);

      // Verify faceRanges cover all triangles monotonically & resolve both roof & wall faces per building
      const ranges = mesh.userData.faceRanges as Array<{
        startFace: number;
        endFace: number;
        info: InspectableFeatureInfo;
      }>;
      assert.ok(Array.isArray(ranges) && ranges.length > 0);
      let faceCursor = 0;
      for (const r of ranges) {
        assert.equal(r.startFace, faceCursor);
        assert.ok(r.endFace > r.startFace);
        faceCursor = r.endFace;
      }
      assert.equal(faceCursor, geom.attributes.position.count / 3);

      // Every building in the bucket must be inspectable in BOTH material group 0 (roof) and material group 1 (walls/pillars)
      for (const g of groups) {
        const gStartFace = g.start / 3;
        const gEndFace = (g.start + g.count) / 3;
        const resolvedInGroup = new Set<string>();
        for (let f = gStartFace; f < gEndFace; f++) {
          const hit = resolveInspectedFeature({ object: mesh, faceIndex: f });
          assert.ok(hit && hit.category === 'Building', `Face ${f} on ${mesh.name} must resolve to Building`);
          resolvedInGroup.add(hit.sourceFeatureId || hit.id);
        }
        assert.deepEqual(
          Array.from(resolvedInGroup).sort(),
          [...expectedFeatureIdsByBucket[mesh.name]].sort(),
          `Material group ${g.materialIndex} on ${mesh.name} must resolve every building in bucket`
        );
      }
    }

    // Verify open-air canopy + ground-level pillars preserved on Buildings_arch_industrial (`way/1003`)
    const defaultMesh = bucketMeshes.find((m) => m.name === 'Buildings_default')!;
    const industrialMesh = bucketMeshes.find((m) => m.name === 'Buildings_arch_industrial')!;
    const indPos = industrialMesh.geometry.attributes.position;
    let canopyMinY = Infinity;
    let canopyMaxY = -Infinity;
    for (let f = 0; f < indPos.count / 3; f++) {
      const hit = resolveInspectedFeature({ object: industrialMesh, faceIndex: f });
      if (hit?.sourceFeatureId === 'way/1003') {
        for (let k = 0; k < 3; k++) {
          const y = indPos.getY(f * 3 + k);
          if (y < canopyMinY) canopyMinY = y;
          if (y > canopyMaxY) canopyMaxY = y;
        }
      }
    }
    assert.ok(canopyMinY <= 0.05, `Open-air roof pillars must reach ground (minY=${canopyMinY})`);
    assert.ok(canopyMaxY >= 5.5, `Open-air roof canopy must reach full height (maxY=${canopyMaxY})`);

    // Single-building bucket also preserves direct userData.id fallback
    const landmarkMesh = bucketMeshes.find((m) => m.name === 'Buildings_landmark')!;
    assert.equal(landmarkMesh.userData.sourceFeatureId, 'way/3001');

    // Theme update mutates building materials in place without altering geometry vertex/group counts
    const prevGroups = bucketMeshes.map((m) => m.geometry.groups.length);
    scene.updateTheme(MAP_THEMES.daylight);
    assert.deepEqual(
      bucketMeshes.map((m) => m.geometry.groups.length),
      prevGroups
    );
    const defaultMats = defaultMesh.material as THREE.MeshStandardMaterial[];
    assert.equal(
      defaultMats[0].color.getHexString(),
      new THREE.Color(MAP_THEMES.daylight.buildingRoofColor).getHexString()
    );
    assert.equal(
      defaultMats[1].color.getHexString(),
      new THREE.Color(MAP_THEMES.daylight.buildingWallColor).getHexString()
    );

    // Non-building layers still exist cleanly
    assert.ok(scene.roadsGroup.children.length > 0, 'Non-building roads must still be built');
    assert.ok(scene.parksGroup.children.length > 0, 'Non-building parks must still be built');

    // Deterministic rebuild parity
    const parsed2 = provider.parseGeoJson(
      buildMultiBucketFixtureGeoJson(),
      'TKT-023 Fixture',
      [6.7935, 52.2625],
      500
    );
    const scene2 = new GeometryBuilder({ bevelEnabled }).buildScene(parsed2, MAP_THEMES.tactical);
    assert.equal(scene2.stats.totalVertices, scene.stats.totalVertices);
    assert.equal(scene2.stats.totalTriangles, scene.stats.totalTriangles);
    assert.equal(scene2.stats.totalDrawCalls, scene.stats.totalDrawCalls);

    // Clean, idempotent disposal with zero leaks
    scene.dispose();
    scene.dispose();
    scene2.dispose();
    assert.equal(scene.resources.ownedGeometriesCount, 0);
    assert.equal(scene.resources.ownedMaterialsCount, 0);
    assert.equal(scene2.resources.ownedGeometriesCount, 0);
    assert.equal(scene2.resources.ownedMaterialsCount, 0);
  }
});
