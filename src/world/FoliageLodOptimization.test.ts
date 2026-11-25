import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAP_THEMES } from '../styles/mapThemes';
import type { ProcessedMapData } from '../types/MapFeature';
import { GeometryBuilder, resolveInspectedFeature } from './GeometryBuilder';
import {
  buildFoliagePrototypeGeometry,
  computeConservativeInstancedBounds,
  computeFoliageTelemetrySnapshot,
  DEFAULT_FOLIAGE_LOD_THRESHOLDS,
  DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG,
  FOLIAGE_LOD_LEVELS,
  FOLIAGE_PROTOTYPE_TRIANGLE_COUNTS,
  FoliagePrototypeRegistry,
  getGeometryTriangleCount,
  parseFoliageOptimizationConfigFromSearch,
  resolveFoliageRuntimeState,
  type FoliageOptimizationConfig,
} from './FoliageLodSystem';
import { createAlignedStudyGrid } from './tiling/TileGrid';
import { decodeTileBinary, encodeBuiltTileToBinary } from './tiling/TileBinaryCodec';
import { reconstructTileSceneFromDecoded } from './tiling/TileSceneReconstructor';
import { ThemeMaterialRegistry } from './tiling/ThemeMaterialRegistry';
import {
  TileStreamManager,
  type TilePackManifestPayload,
} from './tiling/TileStreamManager';
import {
  BAKE_SCHEMA_VERSION,
  CANONICAL_HENGELO_SNAPSHOT_ID,
  CANONICAL_HENGELO_SOURCE_SHA256,
  type TileManifestEntry,
} from './tiling/TilePackContract';
import { createTileDecodeClient } from './tiling/TileDecodeClient';

function createSyntheticForestMapData(
  trees: Array<{
    id: string;
    x: number;
    z: number;
    leafType: 'broadleaved' | 'needleleaved';
    name?: string;
  }>
): ProcessedMapData {
  return {
    regionName: 'Synthetic Forest Test',
    centerLonLat: [6.7935, 52.2625],
    bounds: {
      minX: -1024,
      maxX: 1024,
      minZ: -1024,
      maxZ: 1024,
      widthMeters: 2048,
      depthMeters: 2048,
    },
    buildings: [],
    roads: [],
    railways: [],
    waterBodies: [],
    linearWaterways: [],
    water: [],
    parks: [],
    landuse: [],
    barriers: [],
    landmarks: trees.map((t) => ({
      id: t.id,
      type: 'landmark' as const,
      sourceFeatureId: `node/${t.id}`,
      name: t.name ?? `Tree ${t.id}`,
      landmarkType: 'tree' as const,
      leafType: t.leafType,
      position: [t.x, t.z] as [number, number],
      height: 7.5,
      cartoLabel: 'Tree',
      primaryTag: `natural=tree (${t.leafType})`,
      osmTags: { natural: 'tree', leaf_type: t.leafType },
    })),
    diagnostics: {
      rawInputFeatures: trees.length,
      parsedByCategory: {
        buildings: 0,
        roads: 0,
        railways: 0,
        waterBodies: 0,
        linearWaterways: 0,
        parks: 0,
        landuse: 0,
        barriers: 0,
        landmarks: trees.length,
      },
      discardedTotal: 0,
      discardedByReason: {},
    } as unknown as ProcessedMapData['diagnostics'],
    stats: {
      totalBuildings: 0,
      totalRoads: 0,
      totalRoadSegments: 0,
      totalRailways: 0,
      totalRailwaySegments: 0,
      totalWaterPolygons: 0,
      totalLinearWaterways: 0,
      totalParkPolygons: 0,
      totalLandusePolygons: 0,
      totalBarriers: 0,
      totalLandmarks: trees.length,
      areaKm2: 4.19,
    },
  };
}

function createOrthoCameraLookingAt(
  targetX: number,
  targetZ: number,
  zoom: number,
  widthPx = 1280,
  heightPx = 720
): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(
    -widthPx / 2,
    widthPx / 2,
    heightPx / 2,
    -heightPx / 2,
    0.1,
    10000
  );
  cam.zoom = zoom;
  // Isometric 45° azimuth, ~55.4° pitch matching MapScene/CameraController
  cam.position.set(targetX + 350, 500, targetZ + 350);
  cam.lookAt(targetX, 0, targetZ);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

test('foliage prototype geometries match exact verified LOD0/LOD1/LOD2 triangle budgets and shared registry ownership', () => {
  const registry = new FoliagePrototypeRegistry();
  try {
    assert.equal(registry.geometryCount, 7, 'Expected 1 trunk + 3 broadleaf + 3 conifer shared geometries');
    assert.ok(registry.cpuBufferBytes > 0);

    for (const kind of ['tree_trunk', 'tree_broadleaved', 'tree_needleleaved'] as const) {
      for (const lod of FOLIAGE_LOD_LEVELS) {
        const geo = registry.getGeometry(kind, lod);
        const tris = getGeometryTriangleCount(geo);
        assert.equal(
          tris,
          FOLIAGE_PROTOTYPE_TRIANGLE_COUNTS[kind][lod],
          `Triangle mismatch for ${kind}:${lod}`
        );
        // Same reference returned on repeated lookup (zero per-call allocation)
        assert.equal(registry.getGeometry(kind, lod), geo);
      }

      // Union bounds must enclose every LOD variant's geometry bounds
      const unionBox = registry.getUnionLocalBounds(kind);
      for (const lod of FOLIAGE_LOD_LEVELS) {
        const geo = registry.getGeometry(kind, lod);
        assert.ok(geo.boundingBox);
        assert.ok(
          unionBox.containsBox(geo.boundingBox),
          `Union bounds must enclose ${kind}:${lod}`
        );
      }
    }

    // Verify LOD0 matches standalone builder bit-for-bit in vertex/triangle counts
    const standaloneBroad0 = buildFoliagePrototypeGeometry('tree_broadleaved', 'lod0');
    assert.equal(getGeometryTriangleCount(standaloneBroad0), 240);
    standaloneBroad0.dispose();

    const standaloneNeedle0 = buildFoliagePrototypeGeometry('tree_needleleaved', 'lod0');
    assert.equal(getGeometryTriangleCount(standaloneNeedle0), 42);
    standaloneNeedle0.dispose();

    const standaloneTrunk = buildFoliagePrototypeGeometry('tree_trunk', 'lod0');
    assert.equal(getGeometryTriangleCount(standaloneTrunk), 24);
    standaloneTrunk.dispose();

    // Verify simplified broadleaf LOD1 (60 tris) and LOD2 (20 tris) stay within LOD0 silhouette envelope (+0.05m tol)
    const broadLod0Box = registry.getGeometry('tree_broadleaved', 'lod0').boundingBox!;
    const expandedBroad0 = broadLod0Box.clone().expandByScalar(0.05);
    assert.ok(expandedBroad0.containsBox(registry.getGeometry('tree_broadleaved', 'lod1').boundingBox!));
    assert.ok(expandedBroad0.containsBox(registry.getGeometry('tree_broadleaved', 'lod2').boundingBox!));

    const needleLod0Box = registry.getGeometry('tree_needleleaved', 'lod0').boundingBox!;
    const expandedNeedle0 = needleLod0Box.clone().expandByScalar(0.05);
    assert.ok(expandedNeedle0.containsBox(registry.getGeometry('tree_needleleaved', 'lod1').boundingBox!));
    assert.ok(expandedNeedle0.containsBox(registry.getGeometry('tree_needleleaved', 'lod2').boundingBox!));
  } finally {
    registry.dispose();
    registry.dispose(); // idempotent
    assert.equal(registry.disposed, true);
    assert.equal(registry.geometryCount, 0);
  }
});

test('screen-space foliage LOD & trunk suppression enforce hysteresis and developer overrides', () => {
  const cfg = DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG;
  const th = DEFAULT_FOLIAGE_LOD_THRESHOLDS;

  // Street close-up (zoom 6.5 -> canopy 26px, trunk 4.16px)
  const street = resolveFoliageRuntimeState(6.5, null, cfg, th);
  assert.equal(street.activeLod, 'lod0');
  assert.equal(street.trunksVisible, true);
  assert.equal(street.frustumCullingEnabled, true);

  // Hysteresis LOD0 -> LOD1 deadband: [7.2px, 8.4px] => zoom [1.80, 2.10]
  const stayLod0 = resolveFoliageRuntimeState(1.90, street, cfg, th); // 7.6px
  assert.equal(stayLod0.activeLod, 'lod0', 'Must remain LOD0 inside LOD0->LOD1 deadband');

  const dropToLod1 = resolveFoliageRuntimeState(1.75, stayLod0, cfg, th); // 7.0px < 7.2px
  assert.equal(dropToLod1.activeLod, 'lod1');
  assert.equal(dropToLod1.trunksVisible, true);

  const stayLod1Up = resolveFoliageRuntimeState(2.00, dropToLod1, cfg, th); // 8.0px < 8.4px
  assert.equal(stayLod1Up.activeLod, 'lod1', 'Must remain LOD1 inside LOD1->LOD0 deadband');

  const upgradeToLod0 = resolveFoliageRuntimeState(2.12, stayLod1Up, cfg, th); // 8.48px >= 8.4px
  assert.equal(upgradeToLod0.activeLod, 'lod0');

  // Default startup zoom (1.2 -> canopy 4.8px, trunk 0.768px)
  const startup = resolveFoliageRuntimeState(1.2, null, cfg, th);
  assert.equal(startup.activeLod, 'lod1');
  assert.equal(startup.trunksVisible, true);

  // Hysteresis LOD1 -> LOD2 deadband: [3.0px, 3.6px] => zoom [0.75, 0.90]
  const stayLod1Down = resolveFoliageRuntimeState(0.80, startup, cfg, th); // 3.2px, trunk 0.512px
  assert.equal(stayLod1Down.activeLod, 'lod1');
  assert.equal(stayLod1Down.trunksVisible, true);

  const dropToLod2 = resolveFoliageRuntimeState(0.65, stayLod1Down, cfg, th); // 2.6px, trunk 0.416px
  assert.equal(dropToLod2.activeLod, 'lod2');
  assert.equal(dropToLod2.trunksVisible, false);

  const stayLod2AndHidden = resolveFoliageRuntimeState(0.85, dropToLod2, cfg, th); // 3.4px, trunk 0.544px
  assert.equal(stayLod2AndHidden.activeLod, 'lod2', 'Must stay LOD2 inside LOD2->LOD1 deadband');
  assert.equal(stayLod2AndHidden.trunksVisible, false, 'Trunks must stay hidden inside trunk deadband');

  const recoverLod1AndTrunks = resolveFoliageRuntimeState(0.96, stayLod2AndHidden, cfg, th); // 3.84px, trunk 0.614px
  assert.equal(recoverLod1AndTrunks.activeLod, 'lod1');
  assert.equal(recoverLod1AndTrunks.trunksVisible, true);

  // Master disable overrides everything back to baseline LOD0 + trunks visible + culling off
  const disabled = resolveFoliageRuntimeState(0.15, dropToLod2, {
    ...cfg,
    enabled: false,
  });
  assert.equal(disabled.activeLod, 'lod0');
  assert.equal(disabled.trunksVisible, true);
  assert.equal(disabled.frustumCullingEnabled, false);

  // Independent toggles: forced LOD2 with trunk suppression OFF and frustum culling OFF
  const canopyOnly = resolveFoliageRuntimeState(6.5, null, {
    enabled: true,
    lodMode: 'lod2',
    trunkSuppressionEnabled: false,
    frustumCullingEnabled: false,
  });
  assert.equal(canopyOnly.activeLod, 'lod2');
  assert.equal(canopyOnly.trunksVisible, true);
  assert.equal(canopyOnly.frustumCullingEnabled, false);

  // URL parser
  const parsed = parseFoliageOptimizationConfigFromSearch(
    '?foliageOpt=1&foliageLod=lod1&foliageTrunks=0&foliageCull=0'
  );
  assert.deepEqual(parsed, {
    enabled: true,
    lodMode: 'lod1',
    trunkSuppressionEnabled: false,
    frustumCullingEnabled: false,
  });
});

test('conservative instanced bounds enclose every transformed vertex across scales, rotations, LODs, and tile offsets without premature frustum culling', () => {
  const registry = new FoliagePrototypeRegistry();
  try {
    const count = 24;
    const matrices = new Float32Array(count * 16);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const x = ((i % 6) - 2.5) * 35;
      const z = (Math.floor(i / 6) - 1.5) * 40;
      const scale = 0.8 + (i % 5) * 0.14; // up to 1.36
      const rotY = (i * 1.17) % (Math.PI * 2);
      dummy.position.set(x, 0.08, z);
      dummy.rotation.set(0, rotY, 0);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      matrices.set(dummy.matrix.elements, i * 16);
    }

    const unionBox = registry.getUnionLocalBounds('tree_broadleaved');
    const { boundingBox, boundingSphere } = computeConservativeInstancedBounds(
      matrices,
      count,
      unionBox
    );

    const inst = new THREE.InstancedMesh(
      registry.getGeometry('tree_broadleaved', 'lod0'),
      new THREE.MeshBasicMaterial(),
      count
    );
    (inst.instanceMatrix.array as Float32Array).set(matrices);
    inst.instanceMatrix.needsUpdate = true;
    inst.boundingBox = boundingBox;
    inst.boundingSphere = boundingSphere;

    // Apply regional coordinate offset (study-world-mesh-offset)
    const offsetX = 12288;
    const offsetZ = -8192;
    inst.position.set(offsetX, 0, offsetZ);
    inst.updateMatrixWorld(true);

    // Every single transformed vertex of every instance across all 3 LODs must be strictly inside boundingBox & boundingSphere
    const instMat = new THREE.Matrix4();
    const v = new THREE.Vector3();
    for (const lod of FOLIAGE_LOD_LEVELS) {
      const geo = registry.getGeometry('tree_broadleaved', lod);
      const pos = geo.attributes.position;
      for (let i = 0; i < count; i++) {
        instMat.fromArray(matrices, i * 16);
        for (let k = 0; k < pos.count; k++) {
          v.fromBufferAttribute(pos, k).applyMatrix4(instMat);
          assert.ok(
            boundingBox.containsPoint(v),
            `Vertex (${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}) escaped conservative AABB at ${lod}`
          );
          assert.ok(
            boundingSphere.containsPoint(v),
            `Vertex escaped conservative boundingSphere at ${lod}`
          );
        }
      }
    }

    // Camera grazing the outer canopy edge of an extreme tree (tree ground point itself outside view!)
    // Extreme +X tree is at x = 2.5 * 35 = 87.5 (world 12288 + 87.5 = 12375.5), canopy overhangs by ~2.5m to ~12378
    const frustum = new THREE.Frustum();
    const projScreen = new THREE.Matrix4();

    // Place a top-down ortho camera centered so its left edge is at world X = 12377.0 (tree origin 12375.5 is outside, canopy overhangs inside!)
    const edgeCam = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 2000);
    edgeCam.zoom = 1.0;
    edgeCam.position.set(12377 + 50, 400, offsetZ + 60);
    edgeCam.lookAt(12377 + 50, 0, offsetZ + 60);
    edgeCam.updateMatrixWorld(true);
    edgeCam.updateProjectionMatrix();
    projScreen.multiplyMatrices(edgeCam.projectionMatrix, edgeCam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    assert.equal(
      frustum.intersectsObject(inst),
      true,
      'Must NOT prematurely frustum-cull batch when an overhanging canopy enters frustum edge'
    );

    // Move camera far away -> batch must be cleanly frustum culled
    const farCam = createOrthoCameraLookingAt(offsetX + 5000, offsetZ + 5000, 1.0);
    projScreen.multiplyMatrices(farCam.projectionMatrix, farCam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    assert.equal(
      frustum.intersectsObject(inst),
      false,
      'Off-screen foliage batch must be frustum culled'
    );

    (inst.material as THREE.Material).dispose();
    inst.dispose();
  } finally {
    registry.dispose();
  }
});

test('OSMTILE1 v1 backward compatibility: LOD switching & trunk suppression preserve matrices, metadata, raycast inspection, and layer visibility', () => {
  const trees = [
    { id: 't-broad-1', x: -20, z: -20, leafType: 'broadleaved' as const, name: 'Oak Alpha' },
    { id: 't-broad-2', x: 35, z: 10, leafType: 'broadleaved' as const, name: 'Oak Beta' },
    { id: 't-pine-1', x: 0, z: 45, leafType: 'needleleaved' as const, name: 'Pine Gamma' },
  ];
  const mapData = createSyntheticForestMapData(trees);
  const grid = createAlignedStudyGrid({
    name: 'foliage-compat-test',
    centerLonLat: [6.7935, 52.2625],
    cols: 1,
    rows: 1,
    tileSizeMeters: 512,
  });

  // Build clipped tile scene as the offline baker does -> verify bake flags remain LOD0 + visible
  const builder = new GeometryBuilder({
    initialCameraZoom: 0.25, // low zoom during bake must NOT bake suppressed trunks
    tileClipBounds: grid.tiles[0].localBounds,
  });
  const bakedScene = builder.buildScene(mapData, MAP_THEMES.tactical);
  try {
    const bakedTrunk = bakedScene.foliageGroup.getObjectByName(
      'ProceduralForest_Trunks'
    ) as THREE.InstancedMesh;
    const bakedBroad = bakedScene.foliageGroup.getObjectByName(
      'ProceduralForest_BroadleavedCanopy'
    ) as THREE.InstancedMesh;
    assert.ok(bakedTrunk && bakedBroad);
    assert.equal(bakedTrunk.visible, true, 'Baker path must keep trunks visible in baked payload');
    assert.equal(getGeometryTriangleCount(bakedBroad.geometry), 240, 'Baker path must keep LOD0');

    const binary = encodeBuiltTileToBinary({
      tile: grid.tiles[0],
      scene: bakedScene,
      lod: 0,
    });
    const decoded = decodeTileBinary(binary, 'foliage-compat-tile');

    const materialRegistry = new ThemeMaterialRegistry(MAP_THEMES.tactical, 6.5);
    const foliageRegistry = new FoliagePrototypeRegistry();
    const initialState = resolveFoliageRuntimeState(6.5, null, DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG);
    const recon = reconstructTileSceneFromDecoded(decoded, {
      materialRegistry,
      placementMode: 'study-world-mesh-offset',
      initialCameraZoom: 6.5,
      foliagePrototypeRegistry: foliageRegistry,
      foliageRuntimeState: initialState,
    });

    try {
      const trunkMesh = recon.scene.foliageGroup.getObjectByName(
        'ProceduralForest_Trunks'
      ) as THREE.InstancedMesh;
      const broadMesh = recon.scene.foliageGroup.getObjectByName(
        'ProceduralForest_BroadleavedCanopy'
      ) as THREE.InstancedMesh;
      const needleMesh = recon.scene.foliageGroup.getObjectByName(
        'ProceduralForest_NeedleleavedCanopy'
      ) as THREE.InstancedMesh;
      assert.ok(trunkMesh && broadMesh && needleMesh);

      const snapshotMatrices = new Float32Array(broadMesh.instanceMatrix.array as Float32Array);
      const snapshotInfos = [...(broadMesh.userData.instanceInfos as unknown[])];

      assert.equal(getGeometryTriangleCount(broadMesh.geometry), 240);
      assert.equal(getGeometryTriangleCount(needleMesh.geometry), 42);
      assert.equal(trunkMesh.visible, true);
      assert.equal(broadMesh.frustumCulled, true);

      // Transition to LOD2 + suppressed trunks
      const lod2State = resolveFoliageRuntimeState(0.5, initialState, DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG);
      recon.applyFoliageRuntimeState(lod2State);

      assert.equal(getGeometryTriangleCount(broadMesh.geometry), 20);
      assert.equal(getGeometryTriangleCount(needleMesh.geometry), 5);
      assert.equal(trunkMesh.visible, false, 'Trunks suppressed at zoom 0.5');
      assert.equal(broadMesh.visible, true, 'Broadleaf canopy must remain visible');
      assert.equal(needleMesh.visible, true, 'Conifer canopy must remain visible');

      // Instance matrices & inspectable feature metadata remain identical
      assert.deepEqual(
        Array.from(broadMesh.instanceMatrix.array as Float32Array),
        Array.from(snapshotMatrices)
      );
      assert.deepEqual(broadMesh.userData.instanceInfos, snapshotInfos);

      // Raycast inspection still resolves Oak Alpha at LOD2!
      const raycaster = new THREE.Raycaster();
      raycaster.set(new THREE.Vector3(-20, 50, -20), new THREE.Vector3(0, -1, 0));
      const hits = raycaster.intersectObject(broadMesh, false);
      assert.ok(hits.length > 0, 'Expected raycast hit on LOD2 broadleaf canopy');
      const inspected = resolveInspectedFeature(hits[0]);
      assert.equal(inspected?.sourceFeatureId, 'node/t-broad-1');
      assert.equal(inspected?.name, 'Oak Alpha');

      // Layer visibility group toggle (showFoliage = false) hides everything cleanly
      recon.scene.foliageGroup.visible = false;
      const cam = createOrthoCameraLookingAt(0, 0, 0.5);
      const hiddenSnap = computeFoliageTelemetrySnapshot(
        recon.scene.foliageGroup,
        cam,
        lod2State,
        DEFAULT_FOLIAGE_OPTIMIZATION_CONFIG,
        foliageRegistry
      );
      assert.equal(hiddenSnap.foliageLayerVisible, false);
      assert.equal(hiddenSnap.submittedBatches, 0);
      assert.equal(hiddenSnap.submittedTriangles, 0);

      // Re-enabling foliage layer preserves suppressed trunks & LOD2 state
      recon.scene.foliageGroup.visible = true;
      assert.equal(trunkMesh.visible, false);
      assert.equal(broadMesh.visible, true);
      assert.equal(getGeometryTriangleCount(broadMesh.geometry), 20);
    } finally {
      recon.dispose();
      foliageRegistry.dispose();
      materialRegistry.dispose();
    }
  } finally {
    bakedScene.dispose();
  }
});

test('TileStreamManager shares 7 foliage prototypes, initializes newly streamed tiles with active LOD, culls off-screen tiles, and disposes without leaks', async () => {
  // Build a 3x1 grid of 512m tiles with dense trees in each tile
  const grid = createAlignedStudyGrid({
    name: 'foliage-stream-test',
    centerLonLat: [6.7935, 52.2625],
    cols: 3,
    rows: 1,
    tileSizeMeters: 512,
  });

  const tilesMap = new Map<string, Uint8Array>();
  const manifestEntries: TileManifestEntry[] = [];

  for (const tile of grid.tiles) {
    const cx = (tile.localBounds.minX + tile.localBounds.maxX) * 0.5;
    const cz = (tile.localBounds.minZ + tile.localBounds.maxZ) * 0.5;
    const tileTrees = [];
    for (let i = 0; i < 12; i++) {
      const ox = ((i % 4) - 1.5) * 60;
      const oz = (Math.floor(i / 4) - 1) * 60;
      tileTrees.push({
        id: `${tile.id}-t${i}`,
        x: cx + ox,
        z: cz + oz,
        leafType: i % 3 === 0 ? ('needleleaved' as const) : ('broadleaved' as const),
      });
    }
    const mapData = createSyntheticForestMapData(tileTrees);
    const builder = new GeometryBuilder({
      initialCameraZoom: 1.0,
      tileClipBounds: tile.localBounds,
    });
    const built = builder.buildScene(mapData, MAP_THEMES.tactical);
    const raw = encodeBuiltTileToBinary({ tile, scene: built, lod: 0 });
    built.dispose();

    const url = `/api/tiles-test/0/${tile.tx}/${tile.ty}`;
    tilesMap.set(url, raw);
    manifestEntries.push({
      lod: 0,
      tx: tile.tx,
      ty: tile.ty,
      minEasting: tile.utmBounds.minEasting,
      maxEasting: tile.utmBounds.maxEasting,
      minNorthing: tile.utmBounds.minNorthing,
      maxNorthing: tile.utmBounds.maxNorthing,
      tileCenterX: cx,
      tileCenterZ: cz,
      overhangMinX: -256,
      overhangMaxX: 256,
      overhangMinY: -2,
      overhangMaxY: 12,
      overhangMinZ: -256,
      overhangMaxZ: 256,
      triCount: 1000,
      vertexCount: 1000,
      featureCount: tileTrees.length,
      isEmpty: false,
      hasBvh: false,
      rawBytes: raw.byteLength,
      compressedBytes: raw.byteLength,
      contentHash: 'test',
    });
  }

  const manifest: TilePackManifestPayload = {
    available: true,
    packPath: '/tmp/foliage-stream-test/mosaic.json',
    metadata: {
      snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
      sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
      projectionId: 'EPSG:25832',
      bakeSchemaVersion: BAKE_SCHEMA_VERSION,
      lodPolicyHash: 'test-lod-policy',
      compression: 'deflate',
      tileSizeMeters: 512,
      collarMeters: 256,
      studyOriginEasting: grid.projection.originEasting,
      studyOriginNorthing: grid.projection.originNorthing,
      gridCols: 3,
      gridRows: 1,
      minTx: Math.min(...grid.tiles.map((t) => t.tx)),
      maxTx: Math.max(...grid.tiles.map((t) => t.tx)),
      minTy: Math.min(...grid.tiles.map((t) => t.ty)),
      maxTy: Math.max(...grid.tiles.map((t) => t.ty)),
      bakeStatus: 'complete',
      createdAtIso: '2026-11-25T00:00:00.000Z',
      completedAtIso: '2026-11-25T00:00:01.000Z',
    },
    tiles: manifestEntries,
  };

  const mockFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const bytes = tilesMap.get(url);
    if (!bytes) {
      return new Response('Not Found', { status: 404 });
    }
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
      status: 200,
    });
  }) as typeof fetch;

  const manager = new TileStreamManager({
    apiBaseUrl: '/api/tiles-test',
    preloadMarginTiles: 1,
    retainMarginTiles: 2,
    initialCameraZoom: 0.5, // starts at LOD2 + trunks suppressed
    decodeClient: createTileDecodeClient(),
    fetchFn: mockFetch,
  });

  try {
    await manager.initialize(manifest);

    // Tight camera focused ONLY on the left tile (-512, 0) at zoom 4.0 -> center tile (0,0) is preloaded off-screen!
    const leftTile = grid.tiles[0];
    const leftCx = (leftTile.localBounds.minX + leftTile.localBounds.maxX) * 0.5;
    const leftCz = (leftTile.localBounds.minZ + leftTile.localBounds.maxZ) * 0.5;
    const camLeft = createOrthoCameraLookingAt(leftCx, leftCz, 4.0, 400, 400);
    // First set zoom low (0.5) before loading so newly streamed tiles initialize in LOD2
    manager.updateCameraZoom(0.5);
    manager.updateViewport({
      minX: leftTile.localBounds.minX + 50,
      maxX: leftTile.localBounds.maxX - 50,
      minZ: leftTile.localBounds.minZ + 50,
      maxZ: leftTile.localBounds.maxZ - 50,
      focusX: leftCx,
      focusZ: leftCz,
      cameraZoom: 0.5,
    });
    await manager.waitForIdle();

    const diag = manager.getDiagnostics();
    assert.ok(diag.loadedTiles >= 2, `Expected visible + preloaded tiles, got ${diag.loadedTiles}`);
    assert.equal(diag.activeFoliageLod, 'lod2');
    assert.equal(diag.foliageTrunksVisible, false);
    assert.equal(diag.sharedFoliagePrototypeCount, 7);

    // Every newly loaded tile must already have LOD2 canopies and hidden trunks
    manager.scene.foliageGroup.traverse((obj) => {
      if (obj instanceof THREE.InstancedMesh) {
        const kind = obj.userData.foliagePrototypeKind;
        if (kind === 'tree_trunk') {
          assert.equal(obj.visible, false);
        } else if (kind === 'tree_broadleaved') {
          assert.equal(getGeometryTriangleCount(obj.geometry), 20);
        } else if (kind === 'tree_needleleaved') {
          assert.equal(getGeometryTriangleCount(obj.geometry), 5);
        }
        assert.equal(obj.frustumCulled, true);
      }
    });

    // Under tight camera over leftTile, the preloaded adjacent tile must be frustum culled!
    const snapLod2Culled = computeFoliageTelemetrySnapshot(
      manager.scene.foliageGroup,
      camLeft,
      manager.getFoliageRuntimeState(),
      manager.getFoliageOptimizationConfig(),
      manager.sharedFoliagePrototypeRegistry
    );
    assert.ok(
      snapLod2Culled.frustumCulledBatches > 0,
      `Expected off-screen preloaded foliage batches to be frustum culled, got ${snapLod2Culled.frustumCulledBatches}`
    );
    assert.ok(
      snapLod2Culled.submittedTriangles < snapLod2Culled.baselineLod0ResidentTriangles * 0.1,
      `Expected >90% foliage triangle reduction at LOD2 + culling, got ${snapLod2Culled.triangleReductionVsLod0Pct}%`
    );

    // Toggle optimization OFF -> all batches revert to LOD0, trunks visible, frustum culling OFF
    manager.setFoliageOptimizationConfig({ enabled: false });
    const snapBaseline = computeFoliageTelemetrySnapshot(
      manager.scene.foliageGroup,
      camLeft,
      manager.getFoliageRuntimeState(),
      manager.getFoliageOptimizationConfig(),
      manager.sharedFoliagePrototypeRegistry
    );
    assert.equal(snapBaseline.activeLod, 'lod0');
    assert.equal(snapBaseline.trunksVisible, true);
    assert.equal(snapBaseline.frustumCulledBatches, 0);
    assert.equal(snapBaseline.submittedTriangles, snapBaseline.baselineLod0ResidentTriangles);
    assert.equal(snapBaseline.triangleReductionVsLod0Pct, 0);

    // Rapid repeated LOD transitions allocate zero extra prototype geometries
    const configs: Partial<FoliageOptimizationConfig>[] = [
      { enabled: true, lodMode: 'lod0' },
      { enabled: true, lodMode: 'lod1' },
      { enabled: true, lodMode: 'lod2' },
      { enabled: true, lodMode: 'auto' },
    ];
    for (let cycle = 0; cycle < 10; cycle++) {
      for (const c of configs) {
        manager.setFoliageOptimizationConfig(c);
      }
    }
    assert.equal(manager.sharedFoliagePrototypeRegistry.geometryCount, 7);

    // Evict all tiles by moving viewport far away -> zero leaked geometries
    manager.updateViewport({
      minX: 50000,
      maxX: 50500,
      minZ: 50000,
      maxZ: 50500,
      focusX: 50250,
      focusZ: 50250,
      cameraZoom: 1.0,
    });
    const afterEvict = manager.getDiagnostics();
    assert.equal(afterEvict.loadedTiles, 0);
    assert.equal(afterEvict.activeTileGeometries, 0);
    assert.equal(afterEvict.sharedFoliagePrototypeCount, 7, 'Shared prototypes remain alive until manager.dispose()');
  } finally {
    manager.dispose();
    assert.equal(manager.sharedFoliagePrototypeRegistry.disposed, true);
    assert.equal(manager.sharedFoliagePrototypeRegistry.geometryCount, 0);
  }
});

test('GeometryBuilder live single-scene path responds to updateCameraZoom and setFoliageOptimizationConfig', () => {
  const mapData = createSyntheticForestMapData([
    { id: 's1', x: 0, z: 0, leafType: 'broadleaved' },
    { id: 's2', x: 12, z: -8, leafType: 'needleleaved' },
  ]);
  const builder = new GeometryBuilder({ initialCameraZoom: 6.5 });
  const scene = builder.buildScene(mapData, MAP_THEMES.tactical);
  try {
    const trunk = scene.foliageGroup.getObjectByName('ProceduralForest_Trunks') as THREE.InstancedMesh;
    const broad = scene.foliageGroup.getObjectByName('ProceduralForest_BroadleavedCanopy') as THREE.InstancedMesh;
    const needle = scene.foliageGroup.getObjectByName('ProceduralForest_NeedleleavedCanopy') as THREE.InstancedMesh;

    assert.equal(getGeometryTriangleCount(broad.geometry), 240);
    assert.equal(getGeometryTriangleCount(needle.geometry), 42);
    assert.equal(trunk.visible, true);
    assert.equal(broad.frustumCulled, true);

    scene.updateCameraZoom?.(0.5);
    assert.equal(getGeometryTriangleCount(broad.geometry), 20);
    assert.equal(getGeometryTriangleCount(needle.geometry), 5);
    assert.equal(trunk.visible, false);

    const setCfg = scene.foliageGroup.userData.setFoliageOptimizationConfig as (
      partial: Partial<FoliageOptimizationConfig>
    ) => void;
    setCfg({ enabled: false });
    assert.equal(getGeometryTriangleCount(broad.geometry), 240);
    assert.equal(trunk.visible, true);
    assert.equal(broad.frustumCulled, false);
  } finally {
    scene.dispose();
  }
});

test('foliageOptimizationRunner parses CLI options and formats honest software-renderer warnings', async () => {
  const {
    parseFoliageBenchmarkCli,
    formatFoliageBenchmarkMarkdown,
    FOLIAGE_BENCHMARK_VARIANTS,
  } = await import('../../benchmarks/foliageOptimizationRunner');

  assert.equal(FOLIAGE_BENCHMARK_VARIANTS.length, 5);
  const cli = parseFoliageBenchmarkCli([
    '--url=http://127.0.0.1:3000',
    '--warmup-frames=4',
    '--measured-frames=16',
    '--target-x=500',
    '--target-z=-250',
    '--include-overview',
    '--allow-software',
  ]);
  assert.equal(cli.serverUrl, 'http://127.0.0.1:3000');
  assert.equal(cli.warmupFrames, 4);
  assert.equal(cli.measuredFrames, 16);
  assert.equal(cli.targetX, 500);
  assert.equal(cli.targetZ, -250);
  assert.equal(cli.includeOverview005, true);
  assert.equal(cli.requireHardware, false);

  const md = formatFoliageBenchmarkMarkdown({
    schema: 'tkt036-foliage-optimization-v1',
    generatedAtIso: '2026-11-25T12:00:00.000Z',
    serverUrl: 'http://127.0.0.1:3000',
    apiBaseUrl: '/api/tiles-region',
    activeMosaicName: 'twente-full-1024m',
    packPath: 'data/osm/twente-full-1024m/mosaic.json',
    snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
    gridCols: 48,
    gridRows: 40,
    tileSizeMeters: 1024,
    totalTiles: 1920,
    gpuVendor: 'Google Inc.',
    gpuRenderer: 'Google SwiftShader',
    isSoftwareRenderer: true,
    softwareRendererWarning: 'Software renderer warning text',
    warmupFrames: 4,
    measuredFrames: 16,
    results: [],
  });
  assert.ok(md.includes('SOFTWARE RENDERER'));
  assert.ok(md.includes('Software renderer warning text'));
  assert.ok(md.includes('twente-full-1024m'));
});

