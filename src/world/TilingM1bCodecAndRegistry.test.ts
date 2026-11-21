import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';
import { MAP_THEMES } from '../styles/mapThemes';
import {
  GeometryBuilder,
  SceneResourceManager,
  resolveInspectedFeature,
  type BuiltSceneGeometry,
} from './GeometryBuilder';
import { auditGraphRoadMeshIntegrity } from './infrastructure/roads/GraphRoadGeometryBuilder';
import { buildUnitSleeperBoxGeometry } from './infrastructure/railways/RailwayGeometryBuilder';
import { DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS } from './infrastructure/rendering/InfrastructureRenderAdapter';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { createAlignedStudyGrid, type TileDescriptor } from './tiling/TileGrid';
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
import {
  collectTileRaySampleTargets,
  verifyStaticMeshBvhSample,
} from '../server/tiles/TilePackVerifier';

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

function createSyntheticBuiltSceneShell(): {
  scene: BuiltSceneGeometry;
  resources: SceneResourceManager;
} {
  const resources = new SceneResourceManager();
  const buildingsGroup = new THREE.Group();
  buildingsGroup.name = 'Buildings';
  const roadsGroup = new THREE.Group();
  roadsGroup.name = 'Roads';
  const railwaysGroup = new THREE.Group();
  railwaysGroup.name = 'Railways';
  const waterGroup = new THREE.Group();
  waterGroup.name = 'Water';
  const parksGroup = new THREE.Group();
  parksGroup.name = 'Parks';
  const landuseGroup = new THREE.Group();
  landuseGroup.name = 'Landuse';
  const barriersGroup = new THREE.Group();
  barriersGroup.name = 'Barriers';
  const foliageGroup = new THREE.Group();
  foliageGroup.name = 'Foliage';
  const groundGeo = resources.registerGeometry(new THREE.PlaneGeometry(512, 512, 1, 1));
  groundGeo.rotateX(-Math.PI / 2);
  const groundMat = resources.registerMaterial(new THREE.MeshStandardMaterial({ color: '#111827' }));
  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.name = 'GroundPlane';

  const scene: BuiltSceneGeometry = {
    buildingsGroup,
    roadsGroup,
    railwaysGroup,
    waterGroup,
    parksGroup,
    landuseGroup,
    barriersGroup,
    foliageGroup,
    groundMesh,
    interactiveMeshes: { buildings: [] },
    stats: {
      totalVertices: 0,
      totalTriangles: 0,
      totalDrawCalls: 0,
      renderedFeaturesCount: 0,
      forestTreesCount: 0,
    },
    resources,
    updateTheme: () => {},
    infrastructureRenderOptions: { ...DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS },
    infrastructureRenderPreview: null,
    dispose: () => resources.dispose(),
  };
  return { scene, resources };
}

function makeFakeTile(tileCenterX: number, tileCenterZ: number): TileDescriptor {
  const half = 256;
  return {
    id: 'tx_test_ty_test',
    tx: 679,
    ty: 11313,
    gridCol: 1,
    gridRow: 4,
    localBounds: {
      minX: tileCenterX - half,
      maxX: tileCenterX + half,
      minZ: tileCenterZ - half,
      maxZ: tileCenterZ + half,
    },
    collarLocalBounds: {
      minX: tileCenterX - half - 64,
      maxX: tileCenterX + half + 64,
      minZ: tileCenterZ - half - 64,
      maxZ: tileCenterZ + half + 64,
    },
    utmBounds: { minEasting: 0, maxEasting: 512, minNorthing: 0, maxNorthing: 512 },
    collarGeoBounds: { minLon: 6.7, maxLon: 6.8, minLat: 52.2, maxLat: 52.3 },
    isEastBoundaryTile: false,
    isSouthBoundaryTile: false,
  };
}

test('TileBinaryCodec prunes Float32-rebase road sliver flips without masking genuine upstream inverted triangles', () => {
  // Exact scenario from tx_679_ty_11313 (tileCenter = [-1280, +256]):
  // Near z = 4 m in study-world coords, Float32 Z ULP is 2^-21; subtracting 256 moves z to -252 where ULP widens to 2^-16.
  const tile = makeFakeTile(-1280, 256);

  // Pick a micro-triangle valid upward in study-world Float32 whose Z snaps downward upon subtracting 256
  const x0 = Math.fround(-1280);
  const x1 = Math.fround(-1280 + 0.8);
  const x2 = Math.fround(-1280 + 0.6);
  // Pre-rebase z values sit near +4m (Float32 ULP = 2^-21); subtracting tileCenterZ=256 shifts to -252m (Float32 ULP = 2^-16).
  // Put z0 and z1 in adjacent Float32 rounding buckets after -256 while placing z2 just below the pre-rebase z0->z1 line
  // so it snaps UP across the edge in post-rebase Float32 and flips ny from +1 to -1.
  const sliverZ0 = Math.fround(4.0 + 1.49 / 65536);
  const sliverZ1 = Math.fround(4.0 + 0.49 / 65536);
  const sliverZ2 = Math.fround(4.0 + 0.55 / 65536);
  const t = (x2 - x0) / (x1 - x0);
  const preLineZ = sliverZ0 + t * (sliverZ1 - sliverZ0);
  const preArea = 0.5 * ((sliverZ1 - sliverZ0) * (x2 - x0) - (x1 - x0) * (sliverZ2 - sliverZ0));
  const qx0 = Math.fround(x0 + 1280);
  const qx1 = Math.fround(x1 + 1280);
  const qx2 = Math.fround(x2 + 1280);
  const qz0 = Math.fround(sliverZ0 - 256);
  const qz1 = Math.fround(sliverZ1 - 256);
  const qz2 = Math.fround(sliverZ2 - 256);
  const postArea = 0.5 * ((qz1 - qz0) * (qx2 - qx0) - (qx1 - qx0) * (qz2 - qz0));
  assert.ok(sliverZ2 < preLineZ && preArea > 1e-6 && postArea < -1e-6, 'Expected deterministic Float32 rebase flip test triangle');

  const roadInfoValid = {
    id: 'road-valid-1',
    sourceFeatureId: 'way/road-valid-1',
    category: 'Road',
    cartoLabel: 'Footway',
    primaryTag: 'highway=footway',
    subtype: 'footway',
    osmTags: { highway: 'footway' },
  };
  const sliverInfo = {
    id: 'road-sliver-1',
    sourceFeatureId: 'way/1444701750',
    category: 'Road',
    cartoLabel: 'Footway',
    primaryTag: 'highway=footway',
    subtype: 'footway',
    osmTags: { highway: 'footway' },
  };

  for (const useIndexed of [false, true]) {
    const { scene, resources } = createSyntheticBuiltSceneShell();
    // Triangle 0 & 1: valid 2x2m CCW upward road quad; Triangle 2: Float32-rebase micro-sliver; Triangle 3: valid 1x1m CCW quad part
    const rawPositions = new Float32Array([
      -1290, 0.05, 10,   -1290, 0.05, 12,   -1288, 0.05, 12,
      -1290, 0.05, 10,   -1288, 0.05, 12,   -1288, 0.05, 10,
      x0,    0.05, sliverZ0, x1, 0.05, sliverZ1, x2, 0.05, sliverZ2,
      -1275, 0.05, 10,   -1275, 0.05, 11,   -1274, 0.05, 11,
    ]);
    const normals = new Float32Array(12 * 3);
    for (let i = 0; i < 12; i++) normals[i * 3 + 1] = 1;

    const geo = resources.registerGeometry(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(rawPositions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    if (useIndexed) {
      geo.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    }
    const mat = resources.registerMaterial(new THREE.MeshStandardMaterial({ color: '#cbd5e1' }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'Roads_footway';
    mesh.userData = {
      faceRanges: [
        { startFace: 0, endFace: 2, info: roadInfoValid },
        { startFace: 2, endFace: 3, info: sliverInfo },
        { startFace: 3, endFace: 4, info: roadInfoValid },
      ],
    };
    scene.roadsGroup.add(mesh);
    scene.stats.totalTriangles = 4;
    scene.stats.totalVertices = 12;
    scene.stats.renderedFeaturesCount = 2;

    // Pre-rebase mesh passes auditGraphRoadMeshIntegrity cleanly!
    scene.roadsGroup.updateMatrixWorld(true);
    const preAudit = auditGraphRoadMeshIntegrity(scene.roadsGroup);
    assert.equal(preAudit.windingDefects.length, 0);
    assert.equal(preAudit.degenerateTriangles.length, 0);

    const bytes = encodeBuiltTileToBinary({ tile, scene, lod: 0, includeBvh: true });
    scene.dispose();

    const decoded = decodeTileBinary(bytes, tile.id);
    assert.equal(decoded.totalTriangles, 3, `Expected sliver pruned (indexed=${useIndexed})`);

    const registry = new ThemeMaterialRegistry(MAP_THEMES.tactical, 1.0);
    const recon = reconstructTileSceneFromDecoded(decoded, {
      materialRegistry: registry,
      placementMode: 'study-world-mesh-offset',
    });

    const postAudit = auditGraphRoadMeshIntegrity(recon.scene.roadsGroup);
    assert.equal(postAudit.windingDefects.length, 0, 'Post-decode must have zero winding defects');
    assert.equal(postAudit.degenerateTriangles.length, 0, 'Post-decode must have zero degenerate triangles');

    // Verify faceRanges remapped accurately for remaining triangle #2 (was face #3)
    const reconMesh = recon.scene.roadsGroup.getObjectByName('Roads_footway') as THREE.Mesh;
    const hitResolved = resolveInspectedFeature({ object: reconMesh, faceIndex: 2 });
    assert.equal(hitResolved?.sourceFeatureId, 'way/road-valid-1');

    recon.dispose();
    registry.dispose();
  }

  // Negative check: a genuine pre-rebase inverted triangle must NOT be suppressed
  {
    const { scene, resources } = createSyntheticBuiltSceneShell();
    const badPositions = new Float32Array([
      -1280, 0.05, 10,
      -1279.9, 0.05, 10,
      -1279.95, 0.05, 10.0005, // CW downward (-Y) already before rebase, area ~ 2.5e-5 > 1e-6
    ]);
    const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
    const geo = resources.registerGeometry(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(badPositions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    const mat = resources.registerMaterial(new THREE.MeshStandardMaterial({ color: '#cbd5e1' }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'Roads_footway';
    mesh.userData = {
      faceRanges: [{ startFace: 0, endFace: 1, info: sliverInfo }],
    };
    scene.roadsGroup.add(mesh);

    const bytes = encodeBuiltTileToBinary({ tile, scene, lod: 0, includeBvh: true });
    scene.dispose();

    const decoded = decodeTileBinary(bytes, tile.id);
    const registry = new ThemeMaterialRegistry(MAP_THEMES.tactical, 1.0);
    const recon = reconstructTileSceneFromDecoded(decoded, {
      materialRegistry: registry,
      placementMode: 'study-world-mesh-offset',
    });

    const postAudit = auditGraphRoadMeshIntegrity(recon.scene.roadsGroup);
    assert.equal(postAudit.negativelyWoundCount, 1, 'Genuine upstream inverted triangle must remain detectable');

    recon.dispose();
    registry.dispose();
  }
});

test('BVH raycast & inspection parity covers vertical facades, occluding overlap, matrixWorld, >65k Uint32 indirect BVH, and instanced sleepers', () => {
  const tile = makeFakeTile(0, 0);
  const { scene, resources } = createSyntheticBuiltSceneShell();

  // 1. Merged Buildings_default with roof + vertical facades, including an occluding building 0.25m in front
  const backBox = new THREE.BoxGeometry(10, 12, 10).toNonIndexed();
  backBox.translate(0, 6, 0); // +Z front wall at z = +5
  const frontOccluder = new THREE.BoxGeometry(10, 12, 0.1).toNonIndexed();
  frontOccluder.translate(0, 6, 5.25); // Thin occluding facade at z = +5.25..+5.3, leaving 0.2m gap in front of z=+5

  const mergedVertCount =
    backBox.attributes.position.count + frontOccluder.attributes.position.count;
  const bPos = new Float32Array(mergedVertCount * 3);
  const bNorm = new Float32Array(mergedVertCount * 3);
  bPos.set(backBox.attributes.position.array as Float32Array, 0);
  bPos.set(
    frontOccluder.attributes.position.array as Float32Array,
    backBox.attributes.position.count * 3
  );
  bNorm.set(backBox.attributes.normal.array as Float32Array, 0);
  bNorm.set(
    frontOccluder.attributes.normal.array as Float32Array,
    backBox.attributes.normal.count * 3
  );
  backBox.dispose();
  frontOccluder.dispose();

  const backTris = 12;
  const frontTris = 12;
  const backInfo = {
    id: 'bldg-back',
    sourceFeatureId: 'way/bldg-back',
    category: 'Building',
    cartoLabel: 'Building',
    primaryTag: 'building=yes',
    subtype: 'yes',
    osmTags: { building: 'yes' },
  };
  const occluderInfo = {
    id: 'bldg-front-occluder',
    sourceFeatureId: 'way/bldg-front-occluder',
    category: 'Building',
    cartoLabel: 'Building',
    primaryTag: 'building=yes',
    subtype: 'yes',
    osmTags: { building: 'yes' },
  };

  const bGeo = resources.registerGeometry(new THREE.BufferGeometry());
  bGeo.setAttribute('position', new THREE.BufferAttribute(bPos, 3));
  bGeo.setAttribute('normal', new THREE.BufferAttribute(bNorm, 3));
  // Multi-material BufferGeometry requires groups covering all vertices for Three.js/BVH raycasting
  bGeo.addGroup(0, backTris * 3, 0);
  bGeo.addGroup(backTris * 3, frontTris * 3, 1);
  const bMat = [
    resources.registerMaterial(new THREE.MeshStandardMaterial({ color: '#475569' })),
    resources.registerMaterial(new THREE.MeshStandardMaterial({ color: '#64748b' })),
  ];
  const bMesh = new THREE.Mesh(bGeo, bMat);
  bMesh.name = 'Buildings_default';
  bMesh.userData = {
    faceRanges: [
      { startFace: 0, endFace: backTris, info: backInfo },
      { startFace: backTris, endFace: backTris + frontTris, info: occluderInfo },
    ],
  };
  scene.buildingsGroup.add(bMesh);

  // 2. Single-feature building (userData.id with no faceRanges) + >65,536 triangles exercising Uint32Array indirectBuffer
  const highTriCount = 65540;
  const hiVertCount = highTriCount * 3;
  const hiPos = new Float32Array(hiVertCount * 3);
  const hiNorm = new Float32Array(hiVertCount * 3);
  const cols = 256;
  for (let f = 0; f < highTriCount; f++) {
    const gx = (f % cols) * 0.25 + 40;
    const gz = Math.floor(f / cols) * 0.25 - 40;
    const base = f * 9;
    hiPos[base + 0] = gx;         hiPos[base + 1] = 10; hiPos[base + 2] = gz;
    hiPos[base + 3] = gx;         hiPos[base + 4] = 10; hiPos[base + 5] = gz + 0.2;
    hiPos[base + 6] = gx + 0.2;   hiPos[base + 7] = 10; hiPos[base + 8] = gz + 0.2;
    for (let v = 0; v < 3; v++) hiNorm[base + v * 3 + 1] = 1;
  }
  const hiGeo = resources.registerGeometry(new THREE.BufferGeometry());
  hiGeo.setAttribute('position', new THREE.BufferAttribute(hiPos, 3));
  hiGeo.setAttribute('normal', new THREE.BufferAttribute(hiNorm, 3));
  hiGeo.addGroup(0, hiVertCount, 0);
  const hiMesh = new THREE.Mesh(hiGeo, bMat);
  hiMesh.name = 'Buildings_arch_religious';
  hiMesh.userData = {
    id: 'bldg-huge-single',
    sourceFeatureId: 'way/bldg-huge-single',
    category: 'Building',
    cartoLabel: 'Church',
    primaryTag: 'building=church',
    subtype: 'church',
    osmTags: { building: 'church' },
  };
  scene.buildingsGroup.add(hiMesh);

  // 3. Instanced sleepers (Railway_Sleepers_3D)
  const unitSleeperGeo = resources.registerGeometry(buildUnitSleeperBoxGeometry());
  const sleeperMat = resources.registerMaterial(new THREE.MeshStandardMaterial({ color: '#78716c' }));
  const sleeperInst = new THREE.InstancedMesh(unitSleeperGeo, sleeperMat, 2);
  sleeperInst.name = 'Railway_Sleepers_3D';
  sleeperInst.visible = false;
  const m0 = new THREE.Matrix4().compose(
    new THREE.Vector3(-40, 0.1, 40),
    new THREE.Quaternion(),
    new THREE.Vector3(2.6, 0.16, 0.26)
  );
  const m1 = new THREE.Matrix4().compose(
    new THREE.Vector3(-40, 0.1, 40.6),
    new THREE.Quaternion(),
    new THREE.Vector3(2.6, 0.16, 0.26)
  );
  sleeperInst.setMatrixAt(0, m0);
  sleeperInst.setMatrixAt(1, m1);
  sleeperInst.instanceMatrix.needsUpdate = true;
  const sleeperInfo0 = {
    id: 'rail-slp-0',
    sourceFeatureId: 'way/rail-slp-0',
    category: 'Railway',
    cartoLabel: 'Railway',
    primaryTag: 'railway=rail',
    subtype: 'rail',
    osmTags: { railway: 'rail' },
  };
  const sleeperInfo1 = {
    id: 'rail-slp-1',
    sourceFeatureId: 'way/rail-slp-1',
    category: 'Railway',
    cartoLabel: 'Railway',
    primaryTag: 'railway=rail',
    subtype: 'rail',
    osmTags: { railway: 'rail' },
  };
  sleeperInst.userData = {
    isInstanced: true,
    isStructural3D: true,
    instanceInfos: [sleeperInfo0, sleeperInfo1],
    instanceBoxes: [
      { cx: -40, cz: 40, yBottom: 0.1, yTop: 0.26, tx: 0, tz: 1, nx: 1, nz: 0, halfLen: 1.3, halfWidthLeft: 0.13, halfWidthRight: 0.13, trackId: 't0' },
      { cx: -40, cz: 40.6, yBottom: 0.1, yTop: 0.26, tx: 0, tz: 1, nx: 1, nz: 0, halfLen: 1.3, halfWidthLeft: 0.13, halfWidthRight: 0.13, trackId: 't0' },
    ],
  };
  scene.railwaysGroup.add(sleeperInst);

  const bytes = encodeBuiltTileToBinary({ tile, scene, lod: 0, includeBvh: true });
  scene.dispose();

  const decoded = decodeTileBinary(bytes, tile.id);
  const hugeMeshRec = decoded.meshes.find((m) => m.name === 'Buildings_arch_religious');
  assert.ok(hugeMeshRec?.bvh?.indirectBuffer instanceof Uint32Array, 'Expected Uint32Array indirectBuffer for >65,536 triangles');

  const registry = new ThemeMaterialRegistry(MAP_THEMES.tactical, 1.0);
  const recon = reconstructTileSceneFromDecoded(decoded, {
    materialRegistry: registry,
    placementMode: 'study-world-mesh-offset',
  });

  // Move parent buildingsGroup to verify matrixWorld transforms are respected
  recon.scene.buildingsGroup.position.set(120, 0, -80);
  recon.scene.buildingsGroup.updateMatrixWorld(true);

  const reconMerged = recon.scene.buildingsGroup.getObjectByName('Buildings_default') as THREE.Mesh;
  assert.ok(reconMerged);
  assert.equal(reconMerged.raycast, acceleratedRaycast);

  // Target the occluded +Z vertical facade on backInfo (face 8 or whichever has normal (0, 0, +1))
  const posAttr = reconMerged.geometry.getAttribute('position') as THREE.BufferAttribute;
  let targetFacadeFace = -1;
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const nVec = new THREE.Vector3();
  for (let f = 0; f < backTris; f++) {
    v0.fromBufferAttribute(posAttr, f * 3).applyMatrix4(reconMerged.matrixWorld);
    v1.fromBufferAttribute(posAttr, f * 3 + 1).applyMatrix4(reconMerged.matrixWorld);
    v2.fromBufferAttribute(posAttr, f * 3 + 2).applyMatrix4(reconMerged.matrixWorld);
    nVec.crossVectors(v1.clone().sub(v0), v2.clone().sub(v0)).normalize();
    if (nVec.z > 0.9) {
      targetFacadeFace = f;
      break;
    }
  }
  assert.ok(targetFacadeFace >= 0, 'Expected +Z vertical wall face on back building');
  const wallCentroid = v0.clone().add(v1).add(v2).multiplyScalar(1 / 3);
  const occludedWallErr = verifyStaticMeshBvhSample({
    sample: {
      kind: 'static',
      category: 'building_facade',
      layer: 'buildings',
      mesh: reconMerged,
      faceIndex: targetFacadeFace,
      centroidWorld: wallCentroid,
      normalWorld: nVec.clone(),
      expectedInfo: backInfo,
    },
    tileId: tile.id,
    expectBvhAttached: true,
  });
  assert.equal(occludedWallErr, null, `Expected occluded vertical facade check to pass, got: ${occludedWallErr}`);

  // Verify >65,536 triangle faceIndex raycast hits tail face cleanly
  const reconHuge = recon.scene.buildingsGroup.getObjectByName('Buildings_arch_religious') as THREE.Mesh;
  const tailFace = 65538;
  const hiPosAttr = reconHuge.geometry.getAttribute('position') as THREE.BufferAttribute;
  v0.fromBufferAttribute(hiPosAttr, tailFace * 3).applyMatrix4(reconHuge.matrixWorld);
  v1.fromBufferAttribute(hiPosAttr, tailFace * 3 + 1).applyMatrix4(reconHuge.matrixWorld);
  v2.fromBufferAttribute(hiPosAttr, tailFace * 3 + 2).applyMatrix4(reconHuge.matrixWorld);
  const tailErr = verifyStaticMeshBvhSample({
    sample: {
      kind: 'static',
      category: 'building_single_feature',
      layer: 'buildings',
      mesh: reconHuge,
      faceIndex: tailFace,
      centroidWorld: v0.clone().add(v1).add(v2).multiplyScalar(1 / 3),
      normalWorld: new THREE.Vector3(0, 1, 0),
      expectedInfo: reconHuge.userData as typeof backInfo,
    },
    tileId: tile.id,
    expectBvhAttached: true,
  });
  assert.equal(tailErr, null, `Expected >65k Uint32 BVH tail face check to pass, got: ${tailErr}`);

  // Verify collectTileRaySampleTargets discovers roof, facade, single-feature, and instanced sleeper samples
  const targets = collectTileRaySampleTargets(recon.scene, 8);
  assert.ok(targets.some((t) => t.category === 'building_roof'));
  assert.ok(targets.some((t) => t.category === 'building_facade'));
  assert.ok(targets.some((t) => t.category === 'building_single_feature'));
  const sleeperTarget = targets.find((t) => t.category === 'sleeper_instanced');
  assert.ok(sleeperTarget && sleeperTarget.kind === 'instanced_sleeper');

  recon.scene.updateCameraZoom?.(6.0);
  sleeperTarget.instancedMesh.updateMatrixWorld(true);
  const sleeperHits = new THREE.Raycaster(sleeperTarget.rayOrigin, sleeperTarget.rayDirection, 0, 10)
    .intersectObject(sleeperTarget.instancedMesh, false);
  assert.ok(sleeperHits.length > 0 && sleeperHits[0].instanceId === sleeperTarget.instanceId);
  assert.equal(resolveInspectedFeature(sleeperHits[0])?.sourceFeatureId, sleeperTarget.expectedInfo?.sourceFeatureId);

  // Sanity check that MeshBVH indirect property is true
  assert.equal(((reconHuge.geometry as unknown as { boundsTree: MeshBVH }).boundsTree).indirect, true);
  assert.equal(typeof acceleratedRaycast, 'function');

  recon.dispose();
  registry.dispose();
});
