import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_THEMES } from '../styles/mapThemes';
import { GeometryBuilder, resolveInspectedFeature } from './GeometryBuilder';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { createAlignedStudyGrid } from './tiling/TileGrid';
import {
  buildSingleSceneReference,
  ingestCanonicalStudyGeoJson,
} from './tiling/TiledStudyPipeline';
import {
  decodeTileBinary,
  encodeBuiltTileToBinary,
} from './tiling/TileBinaryCodec';
import {
  OSMTILE1_FORMAT_VERSION,
  OSMTILE1_MAGIC,
  TilePackCorruptError,
} from './tiling/TilePackContract';
import { ThemeMaterialRegistry } from './tiling/ThemeMaterialRegistry';
import { reconstructTileSceneFromDecoded } from './tiling/TileSceneReconstructor';

function buildFixtureGeoJson(grid: ReturnType<typeof createAlignedStudyGrid>) {
  const toLonLat = (x: number, z: number): [number, number] => grid.projection.toGeo(x, z);
  const ringToLonLat = (pts: Array<[number, number]>) => [pts.map(([x, z]) => toLonLat(x, z))];
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'way/lu-res-1',
        properties: { id: 'way/lu-res-1', landuse: 'residential', name: 'Tile Test Zone' },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [-120, -120],
            [120, -120],
            [120, 120],
            [-120, 120],
            [-120, -120],
          ]),
        },
      },
      {
        type: 'Feature',
        id: 'way/forest-1',
        properties: { id: 'way/forest-1', landuse: 'forest', leaf_type: 'mixed' },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [60, -80],
            [160, -80],
            [160, 40],
            [60, 40],
            [60, -80],
          ]),
        },
      },
      {
        type: 'Feature',
        id: 'way/bldg-church',
        properties: {
          id: 'way/bldg-church',
          building: 'church',
          name: 'Sint-Lambertus',
          'building:levels': '4',
          height: '18',
        },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [-90, -90],
            [-60, -90],
            [-60, -60],
            [-90, -60],
            [-90, -90],
          ]),
        },
      },
      {
        type: 'Feature',
        id: 'way/bldg-house',
        properties: {
          id: 'way/bldg-house',
          building: 'residential',
          name: 'House A',
          height: '8',
        },
        geometry: {
          type: 'Polygon',
          coordinates: ringToLonLat([
            [70, 70],
            [90, 70],
            [90, 90],
            [70, 90],
            [70, 70],
          ]),
        },
      },
      {
        type: 'Feature',
        id: 'way/road-1',
        properties: { id: 'way/road-1', highway: 'primary', name: 'Main Ave', lanes: '2' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-200, 0), toLonLat(200, 0)],
        },
      },
      {
        type: 'Feature',
        id: 'way/rail-1',
        properties: { id: 'way/rail-1', railway: 'rail', electrified: 'contact_line' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-200, -150), toLonLat(200, -150)],
        },
      },
      {
        type: 'Feature',
        id: 'way/rail-turnout',
        properties: { id: 'way/rail-turnout', railway: 'rail', service: 'siding' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-40, -150), toLonLat(0, -153), toLonLat(120, -162)],
        },
      },
      {
        type: 'Feature',
        id: 'way/road-tunnel',
        properties: { id: 'way/road-tunnel', highway: 'tertiary', tunnel: 'yes', layer: '-1' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-80, 120), toLonLat(80, 120)],
        },
      },
    ],
  };
}

test('OSMTILE1 codec preserves attributes, BVH (indexed & non-indexed), instances, tags, and local centering', () => {
  const grid = createAlignedStudyGrid({
    name: 'm1b-unit-2x2',
    centerLonLat: [6.7935, 52.2625],
    cols: 2,
    rows: 2,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const geojson = buildFixtureGeoJson(grid);
  const ingested = ingestCanonicalStudyGeoJson(geojson, grid);
  const tile = grid.tiles[0]; // NW tile centered at (-256, -256)

  const ref = buildSingleSceneReference(ingested, MAP_THEMES.tactical);
  try {
    // Build just one tile directly for codec testing
    const provider = new LocalGeoJsonProvider();
    void provider;
    const rawTileBuilder = new GeometryBuilder({
      initialCameraZoom: 1.0,
      infrastructureRenderOptions: ingested.infrastructureRenderOptions,
      infrastructureRenderPreview: ingested.descriptors
        ? {
            options: ingested.infrastructureRenderOptions,
            graph: ingested.previewMeta.graph,
            descriptors: ingested.descriptors,
            validation: ingested.previewMeta.validation,
            timing: ingested.previewMeta.timing,
          }
        : null,
      tileClipBounds: tile.localBounds,
      maxSceneTrees: 5000,
      precomputedGlobalPlans: ingested.precomputedGlobalPlans,
    });
    const origTileScene = rawTileBuilder.buildScene(ingested.data, MAP_THEMES.tactical);

    try {
      const encoded = encodeBuiltTileToBinary({
        tile,
        scene: origTileScene,
        lod: 0,
        includeBvh: true,
      });

      assert.equal(new TextDecoder().decode(encoded.subarray(0, 8)), OSMTILE1_MAGIC);
      const decoded = decodeTileBinary(encoded, tile.id);
      assert.equal(decoded.formatVersion, OSMTILE1_FORMAT_VERSION);
      assert.equal(decoded.tx, tile.tx);
      assert.equal(decoded.ty, tile.ty);
      assert.equal(decoded.tileCenterX, (tile.localBounds.minX + tile.localBounds.maxX) * 0.5);
      assert.equal(decoded.tileCenterZ, (tile.localBounds.minZ + tile.localBounds.maxZ) * 0.5);

      // Verify vertices are tile-local around [-256..256]
      const roadMeshRec = decoded.meshes.find((m) => m.name.startsWith('Roads_'));
      assert.ok(roadMeshRec, 'Expected Roads_* mesh record');
      for (let i = 0; i < roadMeshRec.positions.length; i += 3) {
        const lx = roadMeshRec.positions[i];
        const lz = roadMeshRec.positions[i + 2];
        assert.ok(Math.abs(lx) <= 270, `Tile-local X ${lx} should be centered near [-256,256]`);
        assert.ok(Math.abs(lz) <= 270, `Tile-local Z ${lz} should be centered near [-256,256]`);
      }

      // Verify railway shader attributes uv & aSwitchAttr survived round-trip
      const sleeperUvRec = decoded.meshes.find((m) => m.name.startsWith('Railway_Sleepers') && !m.name.includes('_3D'));
      assert.ok(sleeperUvRec, 'Expected procedural sleeper UV mesh');
      assert.ok(sleeperUvRec.uvs && sleeperUvRec.uvs.length > 0, 'Expected uv attribute');
      assert.ok(
        sleeperUvRec.switchAttrs && sleeperUvRec.switchAttrs.length > 0,
        'Expected aSwitchAttr attribute'
      );

      // Verify 3D sleeper InstancedMesh boxes + infos survived
      const sleeperInstRec = decoded.instancedBatches.find((b) =>
        b.name.startsWith('Railway_Sleepers_3D')
      );
      assert.ok(sleeperInstRec, 'Expected instanced 3D sleeper batch');
      assert.ok(sleeperInstRec.sleeperBoxes && sleeperInstRec.sleeperBoxes.length === sleeperInstRec.instanceCount);

      // Verify single-building & multi-material building groups preserved
      const churchMeshRec = decoded.meshes.find((m) => m.name === 'Buildings_arch_religious');
      assert.ok(churchMeshRec, 'Expected church building mesh');
      assert.ok(churchMeshRec.groups.length === 2, 'Expected roof + wall material groups');
      assert.ok(churchMeshRec.singleFeatureIdx >= 0, 'Expected singleFeatureIdx on single-building bucket');
      const churchInfo = decoded.featureInfos[churchMeshRec.singleFeatureIdx];
      assert.equal(churchInfo.name, 'Sint-Lambertus');
      assert.equal(churchInfo.osmTags.building, 'church');

      // Reconstruct scene in tile-local mode and verify BVH raycast + inspection parity
      const registry = new ThemeMaterialRegistry(MAP_THEMES.tactical, 1.0);
      const recon = reconstructTileSceneFromDecoded(decoded, {
        materialRegistry: registry,
        placementMode: 'study-world-mesh-offset',
        initialCameraZoom: 1.0,
      });

      const churchObj = recon.scene.buildingsGroup.getObjectByName('Buildings_arch_religious') as THREE.Mesh;
      assert.ok(churchObj, 'Reconstructed church mesh missing');
      assert.ok((churchObj.geometry as unknown as { boundsTree?: unknown }).boundsTree, 'BVH missing on reconstructed church');

      const raycaster = new THREE.Raycaster();
      raycaster.set(new THREE.Vector3(-75, 200, -75), new THREE.Vector3(0, -1, 0));
      const hits = raycaster.intersectObject(churchObj, false);
      assert.ok(hits.length > 0, 'Expected BVH raycast hit on reconstructed church');
      const inspected = resolveInspectedFeature(hits[0]);
      assert.ok(inspected, 'Expected resolveInspectedFeature result');
      assert.equal(inspected.sourceFeatureId, 'way/bldg-church');
      assert.equal(inspected.name, 'Sint-Lambertus');

      // Verify non-indexed clipped planar mesh also deserialized MeshBVH cleanly and raycasts
      const luObj = recon.scene.landuseGroup.getObjectByName('Landuse_residential') as THREE.Mesh;
      assert.ok(luObj, 'Reconstructed landuse mesh missing');
      assert.equal(luObj.geometry.getIndex(), null, 'Clipped planar geometry should be non-indexed');
      assert.ok((luObj.geometry as unknown as { boundsTree?: unknown }).boundsTree, 'BVH missing on non-indexed mesh');
      raycaster.set(new THREE.Vector3(-50, 200, -50), new THREE.Vector3(0, -1, 0));
      const luHits = raycaster.intersectObject(luObj, false);
      assert.ok(luHits.length > 0, 'Expected BVH raycast hit on non-indexed landuse mesh');
      assert.equal(resolveInspectedFeature(luHits[0])?.sourceFeatureId, 'way/lu-res-1');

      // Verify hidden underground tunnel preserved hidden flag
      const ugRoadObj = recon.scene.roadsGroup.getObjectByName('Tunnel_Underground_Roads') as THREE.Mesh;
      if (ugRoadObj) {
        assert.equal(ugRoadObj.visible, false);
        assert.equal(ugRoadObj.userData.isHiddenUnderground, true);
      }

      recon.dispose();
      registry.dispose();
    } finally {
      origTileScene.dispose();
    }
  } finally {
    ref.dispose();
  }
});

test('OSMTILE1 decoder rejects truncated payloads, bad magic, and CRC32 corruption', () => {
  const grid = createAlignedStudyGrid({
    name: 'corrupt-check',
    centerLonLat: [6.7935, 52.2625],
    cols: 1,
    rows: 1,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const ingested = ingestCanonicalStudyGeoJson(buildFixtureGeoJson(grid), grid);
  const ref = buildSingleSceneReference(ingested, MAP_THEMES.tactical);
  try {
    const raw = encodeBuiltTileToBinary({
      tile: grid.tiles[0],
      scene: ref.scene,
      lod: 0,
      includeBvh: true,
    });

    assert.throws(
      () => decodeTileBinary(raw.subarray(0, 40), 'short'),
      (err: unknown) => err instanceof TilePackCorruptError && err.reason === 'truncated_header'
    );

    const badMagic = raw.slice();
    badMagic[0] = 0x58; // 'X'
    assert.throws(
      () => decodeTileBinary(badMagic, 'bad-magic'),
      (err: unknown) => err instanceof TilePackCorruptError && err.reason === 'invalid_magic'
    );

    const badCrc = raw.slice();
    badCrc[badCrc.length - 5] ^= 0xff;
    assert.throws(
      () => decodeTileBinary(badCrc, 'bad-crc'),
      (err: unknown) => err instanceof TilePackCorruptError && err.reason === 'crc32_mismatch'
    );

    const truncated = raw.subarray(0, raw.length - 12);
    assert.throws(
      () => decodeTileBinary(truncated, 'trunc'),
      (err: unknown) => err instanceof TilePackCorruptError && err.reason === 'length_mismatch'
    );
  } finally {
    ref.dispose();
  }
});

test('ThemeMaterialRegistry shares materials across tiles, swaps 4 themes, updates zoom, and isolates disposal', () => {
  const grid = createAlignedStudyGrid({
    name: 'registry-test',
    centerLonLat: [6.7935, 52.2625],
    cols: 2,
    rows: 1,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const ingested = ingestCanonicalStudyGeoJson(buildFixtureGeoJson(grid), grid);
  const registry = new ThemeMaterialRegistry(MAP_THEMES.tactical, 1.0);

  const builtTiles: Array<ReturnType<typeof reconstructTileSceneFromDecoded>> = [];
  for (const tile of grid.tiles) {
    const b = new GeometryBuilder({
      initialCameraZoom: 1.0,
      infrastructureRenderOptions: ingested.infrastructureRenderOptions,
      infrastructureRenderPreview: ingested.descriptors
        ? {
            options: ingested.infrastructureRenderOptions,
            graph: ingested.previewMeta.graph,
            descriptors: ingested.descriptors,
            validation: ingested.previewMeta.validation,
            timing: ingested.previewMeta.timing,
          }
        : null,
      tileClipBounds: tile.localBounds,
      precomputedGlobalPlans: ingested.precomputedGlobalPlans,
    });
    const scene = b.buildScene(ingested.data, MAP_THEMES.tactical);
    const bytes = encodeBuiltTileToBinary({ tile, scene, lod: 0, includeBvh: true });
    scene.dispose();
    const decoded = decodeTileBinary(bytes, tile.id);
    builtTiles.push(
      reconstructTileSceneFromDecoded(decoded, {
        materialRegistry: registry,
        placementMode: 'tile-local',
        initialCameraZoom: 1.0,
      })
    );
  }

  // Verify material instance sharing across Tile 0 and Tile 1
  const road0 = builtTiles[0].scene.roadsGroup.getObjectByName('Roads_primary') as THREE.Mesh;
  const road1 = builtTiles[1].scene.roadsGroup.getObjectByName('Roads_primary') as THREE.Mesh;
  assert.ok(road0 && road1);
  assert.equal(road0.material, road1.material, 'Both tiles must share the same Material instance');

  // Verify 4-theme swap parity in place
  for (const themeId of ['daylight', 'dusk', 'blueprint', 'tactical'] as const) {
    const t = MAP_THEMES[themeId];
    registry.applyTheme(t);
    const mat = road0.material as THREE.MeshStandardMaterial;
    assert.equal(
      mat.color.getHexString(),
      new THREE.Color(t.roadColors.primary).getHexString(),
      `Mismatch for theme ${themeId}`
    );
    const sleeperMat = registry.getMaterial('railway:sleepers_uv');
    assert.equal(
      sleeperMat.userData.railwayUniforms.uBallastColor.value.getHexString(),
      new THREE.Color(t.railwayColors.ballast).getHexString()
    );
  }

  // Verify zoom threshold (> 4.5 px/m) toggles 3D sleepers/rails vs procedural UV ribbons
  builtTiles[0].scene.updateCameraZoom?.(1.0);
  const sleepersUv = builtTiles[0].scene.railwaysGroup.getObjectByName('Railway_Sleepers');
  const sleepers3D = builtTiles[0].scene.railwaysGroup.getObjectByName('Railway_Sleepers_3D');
  assert.ok(sleepersUv && sleepers3D);
  assert.equal(sleepersUv.visible, true);
  assert.equal(sleepers3D.visible, false);

  builtTiles[0].scene.updateCameraZoom?.(6.0);
  assert.equal(sleepersUv.visible, false);
  assert.equal(sleepers3D.visible, true);
  assert.equal(registry.cameraZoom, 6.0);

  // Dispose Tile 0 and verify Tile 1 and shared materials remain completely intact
  builtTiles[0].dispose();
  assert.equal(registry.disposed, false);
  registry.applyTheme(MAP_THEMES.blueprint);
  assert.equal(
    (road1.material as THREE.MeshStandardMaterial).color.getHexString(),
    new THREE.Color(MAP_THEMES.blueprint.roadColors.primary).getHexString()
  );

  builtTiles[1].dispose();
  registry.dispose();
  assert.equal(registry.disposed, true);
});

test('Browser-safe M1b modules execute with globalThis.process undefined', () => {
  const grid = createAlignedStudyGrid({
    name: 'browser-safe-test',
    centerLonLat: [6.7935, 52.2625],
    cols: 1,
    rows: 1,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const ingested = ingestCanonicalStudyGeoJson(buildFixtureGeoJson(grid), grid);
  const ref = buildSingleSceneReference(ingested, MAP_THEMES.tactical);
  const raw = encodeBuiltTileToBinary({ tile: grid.tiles[0], scene: ref.scene, lod: 0 });
  ref.dispose();

  const origProcess = globalThis.process;
  try {
    Object.defineProperty(globalThis, 'process', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const registry = new ThemeMaterialRegistry(MAP_THEMES.tactical, 1.0);
    const decoded = decodeTileBinary(raw, 'browser-check');
    const recon = reconstructTileSceneFromDecoded(decoded, {
      materialRegistry: registry,
      placementMode: 'tile-local',
    });
    registry.applyTheme(MAP_THEMES.daylight);
    recon.scene.updateCameraZoom?.(5.5);
    assert.ok(recon.scene.buildingsGroup.children.length > 0);
    recon.dispose();
    registry.dispose();
  } finally {
    Object.defineProperty(globalThis, 'process', {
      value: origProcess,
      configurable: true,
      writable: true,
    });
  }
});
