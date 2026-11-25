import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { MAP_THEMES } from '../styles/mapThemes';
import { GeometryBuilder, resolveInspectedFeature } from './GeometryBuilder';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import {
  FoliagePrototypeRegistry,
  type FoliageLodLevel,
  type FoliageRuntimeState,
} from './FoliageLodSystem';
import {
  InstancedSpatialIndex,
  attachInstancedSpatialIndex,
  collectInstancedSpatialIndexStats,
  disposeInstancedSpatialIndex,
  getInstancedPickingMode,
  getInstancedSpatialIndex,
  getLastInstancedRaycastDiagnostics,
  parseInstancedPickingModeFromSearch,
  resetInstancedRaycastDiagnostics,
  setInstancedPickingMode,
  setRaycasterInstancedPickingMode,
  withInstancedPickingMode,
} from './InstancedSpatialIndex';
import {
  OSMTILE1_FORMAT_VERSION,
  TILE_MESH_FLAG_HAS_BVH,
  TILE_MESH_FLAG_RECEIVE_SHADOW,
  TILE_MESH_FLAG_VISIBLE,
  TILE_PAYLOAD_FLAG_HAS_BVH,
  type DecodedTilePayload,
  type TileInstancedBatchRecord,
  type TileMeshRecord,
} from './tiling/TilePackContract';
import { buildTileLocalBvh } from './tiling/TileBinaryCodec';
import { consolidateChildTilePayloads } from './tiling/TileConsolidator';
import { reconstructTileSceneFromDecoded } from './tiling/TileSceneReconstructor';
import { ThemeMaterialRegistry } from './tiling/ThemeMaterialRegistry';
import type { InspectableFeatureInfo, ProcessedMapData } from '../types/MapFeature';

/** Deterministic PRNG (Mulberry32) so all randomized differential tests are 100% reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function summarizeDurations(samples: number[]): {
  medianMs: number;
  p95Ms: number;
  meanMs: number;
  maxMs: number;
} {
  const s = [...samples].sort((a, b) => a - b);
  const pct = (p: number) =>
    s.length > 0 ? s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] : 0;
  const mean = s.length > 0 ? s.reduce((acc, v) => acc + v, 0) / s.length : 0;
  return {
    medianMs: Number(pct(0.5).toFixed(4)),
    p95Ms: Number(pct(0.95).toFixed(4)),
    meanMs: Number(mean.toFixed(4)),
    maxMs: s.length > 0 ? Number(s[s.length - 1].toFixed(4)) : 0,
  };
}

function composeMatrixArray(
  transforms: Array<{
    x: number;
    y: number;
    z: number;
    rotY?: number;
    rotX?: number;
    sx?: number;
    sy?: number;
    sz?: number;
  }>
): Float32Array {
  const out = new Float32Array(transforms.length * 16);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();

  for (let i = 0; i < transforms.length; i++) {
    const t = transforms[i];
    p.set(t.x, t.y, t.z);
    e.set(t.rotX ?? 0, t.rotY ?? 0, 0);
    q.setFromEuler(e);
    s.set(t.sx ?? 1, t.sy ?? 1, t.sz ?? 1);
    m.compose(p, q, s);
    out.set(m.elements, i * 16);
  }
  return out;
}

function makeStaticBuildingRecord(
  cx: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  featureIdx: number
): TileMeshRecord {
  const box = new THREE.BoxGeometry(sx, sy, sz);
  box.translate(cx, sy * 0.5, cz);
  const positions = new Float32Array(box.attributes.position.array as Float32Array);
  const normals = new Float32Array(box.attributes.normal.array as Float32Array);
  const uvs = new Float32Array(box.attributes.uv.array as Float32Array);
  const indices = new Uint16Array(box.index!.array as Uint16Array);
  const triCount = indices.length / 3;
  box.computeBoundingBox();
  const bb = box.boundingBox!;
  const bvh = buildTileLocalBvh(positions, indices);
  box.dispose();

  return {
    layer: 'buildings',
    name: `Buildings_default_${featureIdx}`,
    materialSlotKeys: ['building:wall:default'],
    renderOrder: 0,
    flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_RECEIVE_SHADOW | TILE_MESH_FLAG_HAS_BVH,
    localPositionOffset: [0, 0, 0],
    bboxMin: [bb.min.x, bb.min.y, bb.min.z],
    bboxMax: [bb.max.x, bb.max.y, bb.max.z],
    positions,
    normals,
    uvs,
    switchAttrs: null,
    colors: null,
    indices,
    groups: [{ start: 0, count: indices.length, materialIndex: 0 }],
    faceRanges: [{ startFace: 0, endFace: triCount - 1, infoIdx: featureIdx }],
    singleFeatureIdx: featureIdx,
    bvh,
  };
}

function createSyntheticTilePayload(
  tx: number,
  ty: number,
  tileSizeMeters: number,
  seed: number,
  broadleafCount: number,
  coniferCount: number,
  buildingCount: number
): DecodedTilePayload {
  const rand = mulberry32(seed);
  const half = tileSizeMeters * 0.5;
  const featureInfos: InspectableFeatureInfo[] = [
    {
      id: `forest-broad-${tx}-${ty}`,
      sourceFeatureId: `way/broad_${tx}_${ty}`,
      category: 'Terrain & Nature',
      cartoLabel: 'Broadleaf Forest',
      primaryTag: 'natural=wood',
      subtype: 'wood',
      name: `Broadleaf Stand (${tx},${ty})`,
      osmTags: { natural: 'wood', leaf_type: 'broadleaved' },
    },
    {
      id: `forest-conifer-${tx}-${ty}`,
      sourceFeatureId: `way/conifer_${tx}_${ty}`,
      category: 'Terrain & Nature',
      cartoLabel: 'Conifer Forest',
      primaryTag: 'natural=wood',
      subtype: 'wood',
      name: `Conifer Stand (${tx},${ty})`,
      osmTags: { natural: 'wood', leaf_type: 'needleleaved' },
    },
  ];

  // 3 dense forest pockets + scattered sparse trees + tile-overhanging trees
  const clusters: Array<{ cx: number; cz: number; radius: number }> = [
    { cx: -half * 0.45, cz: -half * 0.35, radius: tileSizeMeters * 0.14 },
    { cx: half * 0.38, cz: -half * 0.2, radius: tileSizeMeters * 0.12 },
    { cx: 0, cz: half * 0.42, radius: tileSizeMeters * 0.16 },
  ];

  const trunkTransforms: Array<{
    x: number;
    y: number;
    z: number;
    rotY: number;
    sx: number;
    sy: number;
    sz: number;
  }> = [];
  const broadTransforms: typeof trunkTransforms = [];
  const coniferTransforms: typeof trunkTransforms = [];

  const sampleTreePos = (index: number, total: number) => {
    if (index < 6) {
      const side = index % 4;
      const offset = (rand() - 0.5) * tileSizeMeters * 0.8;
      if (side === 0) return { x: -half + 0.5, z: offset };
      if (side === 1) return { x: half - 0.5, z: offset };
      if (side === 2) return { x: offset, z: -half + 0.5 };
      return { x: offset, z: half - 0.5 };
    }
    if (index < total * 0.78) {
      const c = clusters[index % clusters.length];
      const angle = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * c.radius;
      return { x: c.cx + Math.cos(angle) * r, z: c.cz + Math.sin(angle) * r };
    }
    return {
      x: (rand() - 0.5) * tileSizeMeters * 0.92,
      z: (rand() - 0.5) * tileSizeMeters * 0.92,
    };
  };

  const trunkFeatureIds: number[] = [];
  const broadFeatureIds: number[] = [];
  const coniferFeatureIds: number[] = [];

  for (let i = 0; i < broadleafCount; i++) {
    const pos = sampleTreePos(i, broadleafCount);
    const trunkH = 2.5 + rand() * 3.0;
    const crownS = 2.2 + rand() * 3.5;
    const rotY = rand() * Math.PI * 2;
    trunkTransforms.push({
      x: pos.x,
      y: trunkH * 0.5,
      z: pos.z,
      rotY,
      sx: 0.25 + rand() * 0.2,
      sy: trunkH,
      sz: 0.25 + rand() * 0.2,
    });
    trunkFeatureIds.push(0);

    broadTransforms.push({
      x: pos.x,
      y: trunkH + crownS * 0.55,
      z: pos.z,
      rotY,
      sx: crownS * (0.85 + rand() * 0.3),
      sy: crownS * (0.8 + rand() * 0.4),
      sz: crownS * (0.85 + rand() * 0.3),
    });
    broadFeatureIds.push(0);
  }

  for (let i = 0; i < coniferCount; i++) {
    const pos = sampleTreePos(i, coniferCount);
    const trunkH = 2.0 + rand() * 2.5;
    const crownS = 1.8 + rand() * 2.8;
    const rotY = rand() * Math.PI * 2;
    trunkTransforms.push({
      x: pos.x,
      y: trunkH * 0.5,
      z: pos.z,
      rotY,
      sx: 0.22 + rand() * 0.15,
      sy: trunkH,
      sz: 0.22 + rand() * 0.15,
    });
    trunkFeatureIds.push(1);

    coniferTransforms.push({
      x: pos.x,
      y: trunkH + crownS * 0.4,
      z: pos.z,
      rotY,
      sx: crownS * 0.8,
      sy: crownS * 1.4,
      sz: crownS * 0.8,
    });
    coniferFeatureIds.push(1);
  }

  const meshes: TileMeshRecord[] = [];
  for (let b = 0; b < buildingCount; b++) {
    const featureIdx = featureInfos.length;
    featureInfos.push({
      id: `bldg-${tx}-${ty}-${b}`,
      sourceFeatureId: `way/bldg_${tx}_${ty}_${b}`,
      category: 'Building',
      cartoLabel: 'Residential Building',
      primaryTag: 'building=yes',
      subtype: 'residential',
      name: `Building ${b}`,
      osmTags: { building: 'yes' },
    });
    const bx = (rand() - 0.5) * tileSizeMeters * 0.7;
    const bz = (rand() - 0.5) * tileSizeMeters * 0.7;
    meshes.push(
      makeStaticBuildingRecord(
        bx,
        bz,
        14 + rand() * 18,
        8 + rand() * 16,
        12 + rand() * 16,
        featureIdx
      )
    );
  }

  const instancedBatches: TileInstancedBatchRecord[] = [];
  if (trunkTransforms.length > 0) {
    instancedBatches.push({
      layer: 'foliage',
      name: 'ProceduralForest_Trunks',
      materialSlotKey: 'foliage:trunk',
      prototypeKind: 'tree_trunk',
      renderOrder: 0,
      flags: TILE_MESH_FLAG_VISIBLE,
      bboxMin: [-half - 10, 0, -half - 10],
      bboxMax: [half + 10, 10, half + 10],
      instanceCount: trunkTransforms.length,
      matrices: composeMatrixArray(trunkTransforms),
      instanceColors: null,
      instanceFeatureIdxs: new Int32Array(trunkFeatureIds),
      sleeperBoxes: null,
    });
  }
  if (broadTransforms.length > 0) {
    const colors = new Float32Array(broadTransforms.length * 3);
    for (let i = 0; i < broadTransforms.length; i++) {
      colors[i * 3] = 0.25;
      colors[i * 3 + 1] = 0.55;
      colors[i * 3 + 2] = 0.22;
    }
    instancedBatches.push({
      layer: 'foliage',
      name: 'ProceduralForest_BroadleavedCanopy',
      materialSlotKey: 'foliage:broadleaved',
      prototypeKind: 'tree_broadleaved',
      renderOrder: 0,
      flags: TILE_MESH_FLAG_VISIBLE,
      bboxMin: [-half - 10, 0, -half - 10],
      bboxMax: [half + 10, 20, half + 10],
      instanceCount: broadTransforms.length,
      matrices: composeMatrixArray(broadTransforms),
      instanceColors: colors,
      instanceFeatureIdxs: new Int32Array(broadFeatureIds),
      sleeperBoxes: null,
    });
  }
  if (coniferTransforms.length > 0) {
    const colors = new Float32Array(coniferTransforms.length * 3);
    for (let i = 0; i < coniferTransforms.length; i++) {
      colors[i * 3] = 0.16;
      colors[i * 3 + 1] = 0.38;
      colors[i * 3 + 2] = 0.2;
    }
    instancedBatches.push({
      layer: 'foliage',
      name: 'ProceduralForest_NeedleleavedCanopy',
      materialSlotKey: 'foliage:needleleaved',
      prototypeKind: 'tree_needleleaved',
      renderOrder: 0,
      flags: TILE_MESH_FLAG_VISIBLE,
      bboxMin: [-half - 10, 0, -half - 10],
      bboxMax: [half + 10, 20, half + 10],
      instanceCount: coniferTransforms.length,
      matrices: composeMatrixArray(coniferTransforms),
      instanceColors: colors,
      instanceFeatureIdxs: new Int32Array(coniferFeatureIds),
      sleeperBoxes: null,
    });
  }

  return {
    formatVersion: OSMTILE1_FORMAT_VERSION,
    lod: 0,
    tx,
    ty,
    tileCenterX: (tx + 0.5) * tileSizeMeters,
    tileCenterZ: (ty + 0.5) * tileSizeMeters,
    tileSizeMeters,
    overhangBoundsMin: [-half - 10, 0, -half - 10],
    overhangBoundsMax: [half + 10, 25, half + 10],
    flags: TILE_PAYLOAD_FLAG_HAS_BVH,
    renderedFeaturesCount: featureInfos.length,
    forestTreesCount: broadleafCount + coniferCount,
    sleeper3DBoxCount: 0,
    totalVertices: meshes.reduce((acc, m) => acc + m.positions.length / 3, 0),
    totalTriangles: meshes.reduce((acc, m) => acc + (m.indices ? m.indices.length / 3 : 0), 0),
    totalDrawCalls: meshes.length + instancedBatches.length,
    railwayRenderSource: 'r-plus',
    featureInfos,
    meshes,
    instancedBatches,
    byteLength: 0,
  };
}

test('TKT-038 (1/4): Edge cases — empty, single, coincident centroids, rotated/non-uniform scale, occlusion, visibility, near/far, and tie-breaking', () => {
  // 1a. URL param & mode switch API
  assert.equal(parseInstancedPickingModeFromSearch(''), 'accelerated');
  assert.equal(parseInstancedPickingModeFromSearch('?instancedPicking=accelerated'), 'accelerated');
  assert.equal(parseInstancedPickingModeFromSearch('?instancedPicking=unaccelerated'), 'unaccelerated');
  assert.equal(parseInstancedPickingModeFromSearch('?instancedPicking=linear'), 'unaccelerated');
  assert.equal(getInstancedPickingMode(), 'accelerated');
  const inside = withInstancedPickingMode('unaccelerated', () => getInstancedPickingMode());
  assert.equal(inside, 'unaccelerated');
  assert.equal(getInstancedPickingMode(), 'accelerated');

  const protoGeo = new THREE.BoxGeometry(2, 2, 2);
  protoGeo.computeBoundingBox();
  const mat = new THREE.MeshBasicMaterial();

  // 1b. Empty batch (count = 0)
  const emptyMesh = new THREE.InstancedMesh(protoGeo, mat, 0);
  const emptyIndex = attachInstancedSpatialIndex(emptyMesh, protoGeo.boundingBox!);
  assert.equal(emptyIndex.getStats().instanceCount, 0);
  assert.equal(emptyIndex.getStats().nodeCount, 0);
  const rcEmpty = new THREE.Raycaster(new THREE.Vector3(0, 20, 0), new THREE.Vector3(0, -1, 0));
  assert.equal(rcEmpty.intersectObject(emptyMesh, false).length, 0);
  disposeInstancedSpatialIndex(emptyMesh);

  // 1c. Single instance + rotated/non-uniform scale + vertical/horizontal/oblique/near-far rays
  const singleMesh = new THREE.InstancedMesh(protoGeo, mat, 1);
  const mSingle = new THREE.Matrix4().compose(
    new THREE.Vector3(10, 5, -8),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.7, -0.2)),
    new THREE.Vector3(3.0, 0.75, 1.8)
  );
  singleMesh.setMatrixAt(0, mSingle);
  singleMesh.instanceMatrix.needsUpdate = true;
  singleMesh.updateMatrixWorld(true);
  attachInstancedSpatialIndex(singleMesh, protoGeo.boundingBox!);

  const singleRays = [
    // Exact vertical ray (tests dx=0, dz=0 slab handling)
    { origin: new THREE.Vector3(10, 30, -8), dir: new THREE.Vector3(0, -1, 0), near: 0, far: Infinity },
    // Horizontal axis-aligned ray
    { origin: new THREE.Vector3(-20, 5, -8), dir: new THREE.Vector3(1, 0, 0), near: 0, far: Infinity },
    // Oblique ray
    { origin: new THREE.Vector3(25, 20, 10), dir: new THREE.Vector3(-15, -15, -18).normalize(), near: 0, far: Infinity },
    // Near-clipped miss
    { origin: new THREE.Vector3(10, 30, -8), dir: new THREE.Vector3(0, -1, 0), near: 28, far: Infinity },
    // Far-clipped miss
    { origin: new THREE.Vector3(10, 30, -8), dir: new THREE.Vector3(0, -1, 0), near: 0, far: 18 },
  ];

  for (const spec of singleRays) {
    const rcRef = new THREE.Raycaster(spec.origin, spec.dir, spec.near, spec.far);
    setRaycasterInstancedPickingMode(rcRef, 'unaccelerated');
    const refHits = rcRef.intersectObject(singleMesh, false);

    const rcAcc = new THREE.Raycaster(spec.origin, spec.dir, spec.near, spec.far);
    (rcAcc as unknown as { firstHitOnly?: boolean }).firstHitOnly = true;
    setRaycasterInstancedPickingMode(rcAcc, 'accelerated');
    const accHits = rcAcc.intersectObject(singleMesh, false);

    assert.equal(accHits.length > 0, refHits.length > 0);
    if (refHits.length > 0) {
      assert.ok(Math.abs(accHits[0].distance - refHits[0].distance) < 1e-5);
      assert.equal(accHits[0].instanceId, refHits[0].instanceId);
    }
  }
  disposeInstancedSpatialIndex(singleMesh);

  // 1d. Adversarial coincident-centroid stacked instances (64 identical centroids) + deterministic tie-breaking
  const stackCount = 64;
  const stackMesh = new THREE.InstancedMesh(protoGeo, mat, stackCount);
  const stackIdent = new THREE.Matrix4().makeTranslation(0, 2, 0);
  for (let i = 0; i < stackCount; i++) {
    stackMesh.setMatrixAt(i, stackIdent);
  }
  stackMesh.instanceMatrix.needsUpdate = true;
  stackMesh.updateMatrixWorld(true);
  const stackIdx = attachInstancedSpatialIndex(stackMesh, protoGeo.boundingBox!);
  assert.ok(
    stackIdx.getStats().maxDepth <= 48,
    `Expected bounded depth <= 48, got ${stackIdx.getStats().maxDepth}`
  );

  // Offset slightly from top-face diagonal (0.25, 15, 0.1) so each box hits 1 triangle cleanly
  const rcTie = new THREE.Raycaster(new THREE.Vector3(0.25, 15, 0.1), new THREE.Vector3(0, -1, 0));
  (rcTie as unknown as { firstHitOnly?: boolean }).firstHitOnly = true;
  const tieHits = rcTie.intersectObject(stackMesh, false);
  assert.equal(tieHits.length, 1);
  // Deterministic tie-breaking by lowest instanceId (0)
  assert.equal(tieHits[0].instanceId, 0);

  // All-hits mode (firstHitOnly = false) matches reference hit count and contains every stacked instanceId
  const rcAllAcc = new THREE.Raycaster(new THREE.Vector3(0.25, 15, 0.1), new THREE.Vector3(0, -1, 0));
  setRaycasterInstancedPickingMode(rcAllAcc, 'accelerated');
  const allAccHits = rcAllAcc.intersectObject(stackMesh, false);
  const rcAllRef = new THREE.Raycaster(new THREE.Vector3(0.25, 15, 0.1), new THREE.Vector3(0, -1, 0));
  setRaycasterInstancedPickingMode(rcAllRef, 'unaccelerated');
  const allRefHits = rcAllRef.intersectObject(stackMesh, false);
  assert.equal(allAccHits.length, allRefHits.length);
  assert.equal(new Set(allAccHits.map((h) => h.instanceId)).size, stackCount);
  disposeInstancedSpatialIndex(stackMesh);

  // 1e. Occlusion & hierarchy visibility semantics (static building vs foliage, hidden parent group)
  const sceneRoot = new THREE.Group();
  const staticBuilding = new THREE.Mesh(new THREE.BoxGeometry(6, 10, 6), mat);
  staticBuilding.name = 'StaticOccludingBuilding';
  staticBuilding.position.set(0, 5, 0);

  const foliageLayer = new THREE.Group();
  const treeBatch = new THREE.InstancedMesh(protoGeo, mat, 2);
  treeBatch.name = 'CanopyBatch';
  // Tree 0 is BEHIND/INSIDE static building (below roof y=10) at y=3
  treeBatch.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 3, 0));
  // Tree 1 is ABOVE static building at y=14 (occludes building from above!)
  treeBatch.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 14, 0));
  treeBatch.instanceMatrix.needsUpdate = true;
  attachInstancedSpatialIndex(treeBatch, protoGeo.boundingBox!);
  foliageLayer.add(treeBatch);
  sceneRoot.add(staticBuilding, foliageLayer);
  sceneRoot.updateMatrixWorld(true);

  const rcTop = new THREE.Raycaster(new THREE.Vector3(0.2, 30, 0.1), new THREE.Vector3(0, -1, 0));
  (rcTop as unknown as { firstHitOnly?: boolean }).firstHitOnly = true;
  const topHits = rcTop.intersectObjects([staticBuilding, foliageLayer], true);
  assert.equal(topHits[0].object, treeBatch);
  assert.equal(topHits[0].instanceId, 1);

  const rcSide = new THREE.Raycaster(new THREE.Vector3(20, 3, 0.1), new THREE.Vector3(-1, 0, 0));
  (rcSide as unknown as { firstHitOnly?: boolean }).firstHitOnly = true;
  const sideHits = rcSide.intersectObjects([staticBuilding, foliageLayer], true);
  assert.equal(sideHits[0].object, staticBuilding);

  // Hide foliage parent layer: accelerated index must skip batch with 0 candidates/tests and hit building
  foliageLayer.visible = false;
  resetInstancedRaycastDiagnostics('accelerated');
  const hiddenHits = rcTop.intersectObjects([staticBuilding, foliageLayer], true);
  const hiddenDiag = getLastInstancedRaycastDiagnostics();
  assert.equal(hiddenHits[0].object, staticBuilding);
  assert.equal(hiddenDiag.batchesSkippedInvisible, 1);
  assert.equal(hiddenDiag.candidateInstances, 0);
  assert.equal(hiddenDiag.exactInstanceTests, 0);

  disposeInstancedSpatialIndex(treeBatch);
  staticBuilding.geometry.dispose();
  protoGeo.dispose();
  mat.dispose();
});

test('TKT-038 (2/4): Randomized differential verification across 500 rays, all 3 foliage LODs, firstHitOnly=true/false, and rebased parent transform', () => {
  const matReg = new ThemeMaterialRegistry(MAP_THEMES.daylight);
  const foliageReg = new FoliagePrototypeRegistry();

  const tile = createSyntheticTilePayload(0, 0, 1024, 38001, 450, 250, 10);
  const reconstructed = reconstructTileSceneFromDecoded(tile, {
    materialRegistry: matReg,
    foliagePrototypeRegistry: foliageReg,
    initialCameraZoom: 6.5,
  });

  // Apply non-trivial parent rebasing + rotation to prove mesh-local BVH needs zero refit
  const rebasedParent = new THREE.Group();
  rebasedParent.position.set(1425.5, -12.25, -830.75);
  rebasedParent.rotation.set(0, 0.27, 0);
  rebasedParent.add(reconstructed.scene.foliageGroup, reconstructed.scene.buildingsGroup);
  rebasedParent.updateMatrixWorld(true);

  const pickTargets = [reconstructed.scene.foliageGroup, reconstructed.scene.buildingsGroup];
  const rand = mulberry32(99038);

  const rays: Array<{ origin: THREE.Vector3; dir: THREE.Vector3 }> = [];
  for (let i = 0; i < 500; i++) {
    const localX = (rand() - 0.5) * 1120;
    const localZ = (rand() - 0.5) * 1120;
    const targetWorld = new THREE.Vector3(localX, 0, localZ).applyMatrix4(
      rebasedParent.matrixWorld
    );
    const isVertical = i % 5 === 0;
    const offset = isVertical
      ? new THREE.Vector3(0, 220, 0)
      : new THREE.Vector3((rand() - 0.5) * 260, 140 + rand() * 120, (rand() - 0.5) * 260);
    const origin = targetWorld.clone().add(offset);
    const dir = targetWorld.clone().sub(origin).normalize();
    rays.push({ origin, dir });
  }

  const lodTiers: FoliageLodLevel[] = ['lod0', 'lod1', 'lod2'];
  let totalHitsChecked = 0;

  for (const tier of lodTiers) {
    const runtimeState: FoliageRuntimeState = {
      activeLod: tier,
      lodMode: 'auto',
      trunksVisible: true, // Keep trunks visible during 1:1 parity against vanilla linear raycast
      frustumCullingEnabled: true,
      effectiveZoom: tier === 'lod0' ? 6.5 : tier === 'lod1' ? 1.2 : 0.15,
      canopyScreenDiameterPx: tier === 'lod0' ? 26 : tier === 'lod1' ? 4.8 : 0.6,
      trunkScreenDiameterPx: tier === 'lod0' ? 4.16 : tier === 'lod1' ? 0.77 : 0.1,
      optimizationEnabled: true,
    };
    reconstructed.applyFoliageRuntimeState(runtimeState);

    for (const firstHitOnly of [true, false]) {
      const rcRef = new THREE.Raycaster();
      const rcAcc = new THREE.Raycaster();
      (rcRef as unknown as { firstHitOnly?: boolean }).firstHitOnly = firstHitOnly;
      (rcAcc as unknown as { firstHitOnly?: boolean }).firstHitOnly = firstHitOnly;
      setRaycasterInstancedPickingMode(rcRef, 'unaccelerated');
      setRaycasterInstancedPickingMode(rcAcc, 'accelerated');

      for (let i = 0; i < rays.length; i++) {
        const { origin, dir } = rays[i];
        rcRef.set(origin, dir);
        rcAcc.set(origin, dir);

        const refHits = rcRef.intersectObjects(pickTargets, true);
        const accHits = rcAcc.intersectObjects(pickTargets, true);

        assert.equal(
          accHits.length > 0,
          refHits.length > 0,
          `Hit/miss mismatch on tier=${tier} firstHitOnly=${firstHitOnly} ray=${i}`
        );

        if (refHits.length > 0) {
          totalHitsChecked++;
          const r0 = refHits[0];
          const a0 = accHits[0];
          assert.ok(
            Math.abs(a0.distance - r0.distance) < 1e-4,
            `Distance mismatch on tier=${tier} ray=${i}: ref=${r0.distance} acc=${a0.distance}`
          );

          const refInfo = resolveInspectedFeature(r0);
          const accInfo = resolveInspectedFeature(a0);
          if (r0.object === a0.object && r0.instanceId === a0.instanceId) {
            assert.equal(accInfo?.id, refInfo?.id);
            assert.equal(accInfo?.sourceFeatureId, refInfo?.sourceFeatureId);
            assert.equal(accInfo?.category, refInfo?.category);
          }

          if (!firstHitOnly) {
            const accInstKeys = new Set(
              accHits
                .filter((h) => (h.object as THREE.InstancedMesh).isInstancedMesh)
                .map((h) => `${h.object.uuid}:${h.instanceId}`)
            );
            for (const rh of refHits) {
              if ((rh.object as THREE.InstancedMesh).isInstancedMesh) {
                assert.ok(
                  accInstKeys.has(`${rh.object.uuid}:${rh.instanceId}`),
                  `Missing all-hits instanced intersection ${rh.object.name}#${rh.instanceId} on tier=${tier} ray=${i}`
                );
              }
            }
          }
        }
      }
    }
  }

  assert.ok(totalHitsChecked > 100, `Expected substantial hit coverage, got ${totalHitsChecked}`);

  reconstructed.dispose();
  foliageReg.dispose();
  matReg.dispose();
});

test('TKT-038 (3/4): Zoom LOD transitions require zero index rebuilds, trunk suppression skips hidden batch, and dispose frees all spatial indices', () => {
  const matReg = new ThemeMaterialRegistry(MAP_THEMES.daylight);
  const foliageReg = new FoliagePrototypeRegistry();
  const tile = createSyntheticTilePayload(1, -1, 1024, 38002, 300, 150, 2);

  const reconstructed = reconstructTileSceneFromDecoded(tile, {
    materialRegistry: matReg,
    foliagePrototypeRegistry: foliageReg,
    initialCameraZoom: 6.5,
  });

  const batches: THREE.InstancedMesh[] = [];
  const originalIndices = new Map<THREE.InstancedMesh, InstancedSpatialIndex>();
  reconstructed.scene.foliageGroup.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh) {
      batches.push(im);
      const idx = getInstancedSpatialIndex(im);
      assert.ok(idx, `Expected InstancedSpatialIndex attached to ${im.name}`);
      originalIndices.set(im, idx!);
    }
  });
  assert.equal(batches.length, 3);
  assert.equal(reconstructed.instancedPickingStats.indexedBatchCount, 3);
  assert.equal(reconstructed.instancedPickingStats.totalIndexedInstances, 900);
  assert.ok(reconstructed.instancedPickingStats.totalIndexMemoryBytes > 0);

  // Transition through LOD1 and LOD2 (suppressing trunks at LOD2)
  for (const tier of ['lod1', 'lod2', 'lod0'] as FoliageLodLevel[]) {
    reconstructed.applyFoliageRuntimeState({
      activeLod: tier,
      lodMode: 'auto',
      trunksVisible: tier !== 'lod2',
      frustumCullingEnabled: true,
      effectiveZoom: tier === 'lod0' ? 6.5 : tier === 'lod1' ? 1.2 : 0.15,
      canopyScreenDiameterPx: tier === 'lod0' ? 26 : tier === 'lod1' ? 4.8 : 0.6,
      trunkScreenDiameterPx: tier === 'lod0' ? 4.16 : tier === 'lod1' ? 0.77 : 0.1,
      optimizationEnabled: true,
    });
    for (const im of batches) {
      // Same index instance — ZERO rebuild on zoom/LOD transitions
      assert.strictEqual(getInstancedSpatialIndex(im), originalIndices.get(im));
    }
    if (tier === 'lod2') {
      resetInstancedRaycastDiagnostics('accelerated');
      const rc = new THREE.Raycaster(new THREE.Vector3(0, 200, 0), new THREE.Vector3(0, -1, 0));
      (rc as unknown as { firstHitOnly?: boolean }).firstHitOnly = true;
      rc.intersectObject(reconstructed.scene.foliageGroup, true);
      const diag = getLastInstancedRaycastDiagnostics();
      assert.equal(diag.batchesSkippedInvisible, 1, 'Hidden trunk batch must be skipped at LOD2');
    }
  }

  // Also test GeometryBuilder non-tiled path attaches & disposes spatial indices cleanly
  const gb = new GeometryBuilder();
  const sampleData: ProcessedMapData = new LocalGeoJsonProvider().parseGeoJson(
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'way/999',
          properties: { natural: 'wood', name: 'Test Wood' },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [6.8, 52.2],
                [6.803, 52.2],
                [6.803, 52.202],
                [6.8, 52.202],
                [6.8, 52.2],
              ],
            ],
          },
        },
      ],
    },
    'UnitTestForest',
    [6.8015, 52.201],
    300
  );
  const built = gb.buildScene(sampleData, MAP_THEMES.daylight);
  const builtStats = collectInstancedSpatialIndexStats([built.foliageGroup]);
  assert.ok(builtStats.indexedBatchCount > 0, 'GeometryBuilder must attach spatial indices to foliage');
  assert.ok(builtStats.totalIndexedInstances > 0);
  const builtIndices: InstancedSpatialIndex[] = [];
  built.foliageGroup.traverse((o) => {
    const idx = getInstancedSpatialIndex(o as THREE.InstancedMesh);
    if (idx) builtIndices.push(idx);
  });
  built.dispose();
  for (const idx of builtIndices) {
    assert.equal(idx.disposed, true, 'GeometryBuilder.dispose must dispose instanced spatial indices');
  }

  // Dispose tile scene and confirm every spatial index is cleanly released and raycast restored
  reconstructed.dispose();
  for (const im of batches) {
    const idx = originalIndices.get(im)!;
    assert.equal(idx.disposed, true);
    assert.equal(getInstancedSpatialIndex(im), null);
    assert.strictEqual(im.raycast, THREE.InstancedMesh.prototype.raycast);
  }

  foliageReg.dispose();
  matReg.dispose();
});

test('TKT-038 (4/4): Synthetic scaling benchmark across 1,024 m, 2,048 m, and 4,096 m consolidated tiled scenes', () => {
  const matReg = new ThemeMaterialRegistry(MAP_THEMES.daylight);
  const foliageReg = new FoliagePrototypeRegistry();

  // 4×4 grid of 1,024 m tiles = 4,096 m × 4,096 m footprint
  // 1,000 trees/tile (650 broadleaf + 350 conifer + 1,000 trunks = 2,000 instances/tile)
  // Total = 16,000 trees = 32,000 foliage instances in a single 4,096 m consolidated tile
  const baseEasting = 350000;
  const baseNorthing = 5790000;

  const child1024: DecodedTilePayload[] = [];
  for (let ty = -2; ty < 2; ty++) {
    for (let tx = -2; tx < 2; tx++) {
      const seed = 41000 + (ty + 2) * 10 + (tx + 2);
      child1024.push(createSyntheticTilePayload(tx, ty, 1024, seed, 650, 350, 6));
    }
  }

  const childCenterUtm = (tx: number, ty: number) => ({
    easting: baseEasting + (tx + 0.5) * 1024,
    northing: baseNorthing - (ty + 0.5) * 1024,
  });

  // Consolidate into 2×2 tiles of 2,048 m
  const tiles2048: DecodedTilePayload[] = [];
  for (let py = -1; py < 1; py++) {
    for (let px = -1; px < 1; px++) {
      const group = child1024.filter(
        (c) => Math.floor(c.tx / 2) === px && Math.floor(c.ty / 2) === py
      );
      const parentCenterEasting = baseEasting + (px + 0.5) * 2048;
      const parentCenterNorthing = baseNorthing - (py + 0.5) * 2048;
      const { payload } = consolidateChildTilePayloads(
        group.map((c) => {
          const utm = childCenterUtm(c.tx, c.ty);
          return {
            payload: c,
            childCenterEasting: utm.easting,
            childCenterNorthing: utm.northing,
            tx: c.tx,
            ty: c.ty,
          };
        }),
        {
          lod: 0,
          tx: px,
          ty: py,
          tileSizeMeters: 2048,
          parentCenterEasting,
          parentCenterNorthing,
          tileCenterX: (px + 0.5) * 2048,
          tileCenterZ: (py + 0.5) * 2048,
        }
      );
      tiles2048.push(payload);
    }
  }

  // Consolidate into 1×1 tile of 4,096 m
  const { payload: tile4096 } = consolidateChildTilePayloads(
    child1024.map((c) => {
      const utm = childCenterUtm(c.tx, c.ty);
      return {
        payload: c,
        childCenterEasting: utm.easting,
        childCenterNorthing: utm.northing,
        tx: c.tx,
        ty: c.ty,
      };
    }),
    {
      lod: 0,
      tx: 0,
      ty: 0,
      tileSizeMeters: 4096,
      parentCenterEasting: baseEasting,
      parentCenterNorthing: baseNorthing,
      tileCenterX: 0,
      tileCenterZ: 0,
    }
  );

  // 120 identical world rays spanning the 4 km × 4 km area (dense forest hits, sparse areas, misses)
  const rand = mulberry32(384096);
  const rays: Array<{ origin: THREE.Vector3; dir: THREE.Vector3 }> = [];
  for (let i = 0; i < 120; i++) {
    const x = (rand() - 0.5) * 3900;
    const z = (rand() - 0.5) * 3900;
    const origin = new THREE.Vector3(x + 180, 260, z + 180);
    const target = new THREE.Vector3(x, 0, z);
    rays.push({ origin, dir: target.sub(origin).normalize() });
  }

  const configs: Array<{
    label: string;
    tileSizeMeters: number;
    tiles: Array<{ payload: DecodedTilePayload; posX: number; posZ: number }>;
  }> = [
    {
      label: '1024m (16 tiles)',
      tileSizeMeters: 1024,
      tiles: child1024.map((p) => ({
        payload: p,
        posX: p.tileCenterX,
        posZ: p.tileCenterZ,
      })),
    },
    {
      label: '2048m (4 tiles)',
      tileSizeMeters: 2048,
      tiles: tiles2048.map((p) => ({
        payload: p,
        posX: p.tileCenterX,
        posZ: p.tileCenterZ,
      })),
    },
    {
      label: '4096m (1 tile)',
      tileSizeMeters: 4096,
      tiles: [{ payload: tile4096, posX: 0, posZ: 0 }],
    },
  ];

  setInstancedPickingMode('accelerated');

  for (const cfg of configs) {
    const foliageRoot = new THREE.Group();
    const buildingsRoot = new THREE.Group();
    const disposers: Array<() => void> = [];
    let drawCallCount = 0;

    for (const entry of cfg.tiles) {
      const rec = reconstructTileSceneFromDecoded(entry.payload, {
        materialRegistry: matReg,
        foliagePrototypeRegistry: foliageReg,
        initialCameraZoom: 6.5,
      });
      rec.scene.foliageGroup.position.set(entry.posX, 0, entry.posZ);
      rec.scene.buildingsGroup.position.set(entry.posX, 0, entry.posZ);
      foliageRoot.add(rec.scene.foliageGroup);
      buildingsRoot.add(rec.scene.buildingsGroup);
      rec.scene.foliageGroup.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) drawCallCount++;
      });
      disposers.push(() => rec.dispose());
    }
    foliageRoot.updateMatrixWorld(true);
    buildingsRoot.updateMatrixWorld(true);

    const idxStats = collectInstancedSpatialIndexStats([foliageRoot]);
    assert.equal(idxStats.totalIndexedInstances, 32000);
    // Draw call count must match expected 3 foliage batches per tile (zero extra objects!)
    assert.equal(drawCallCount, cfg.tiles.length * 3);

    const rcUnaccel = new THREE.Raycaster();
    const rcAccel = new THREE.Raycaster();
    (rcUnaccel as unknown as { firstHitOnly?: boolean }).firstHitOnly = true;
    (rcAccel as unknown as { firstHitOnly?: boolean }).firstHitOnly = true;
    setRaycasterInstancedPickingMode(rcUnaccel, 'unaccelerated');
    setRaycasterInstancedPickingMode(rcAccel, 'accelerated');

    // Warmup 10 rays
    for (let i = 0; i < 10; i++) {
      rcUnaccel.set(rays[i].origin, rays[i].dir);
      rcUnaccel.intersectObjects([foliageRoot, buildingsRoot], true);
      rcAccel.set(rays[i].origin, rays[i].dir);
      rcAccel.intersectObjects([foliageRoot, buildingsRoot], true);
    }

    const unaccelDurations: number[] = [];
    const accelDurations: number[] = [];
    let sumUnaccelQueried = 0;
    let sumAccelCandidates = 0;
    let sumAccelExact = 0;
    let parityMismatches = 0;
    let hitsFound = 0;

    for (const r of rays) {
      rcUnaccel.set(r.origin, r.dir);
      resetInstancedRaycastDiagnostics('unaccelerated');
      const tU0 = performance.now();
      const uHits = rcUnaccel.intersectObjects([foliageRoot, buildingsRoot], true);
      unaccelDurations.push(performance.now() - tU0);
      sumUnaccelQueried += getLastInstancedRaycastDiagnostics().totalInstancesInQueriedBatches;

      rcAccel.set(r.origin, r.dir);
      resetInstancedRaycastDiagnostics('accelerated');
      const tA0 = performance.now();
      const aHits = rcAccel.intersectObjects([foliageRoot, buildingsRoot], true);
      accelDurations.push(performance.now() - tA0);
      const aDiag = getLastInstancedRaycastDiagnostics();
      sumAccelCandidates += aDiag.candidateInstances;
      sumAccelExact += aDiag.exactInstanceTests;

      if (uHits.length > 0) hitsFound++;
      if ((uHits.length > 0) !== (aHits.length > 0)) {
        parityMismatches++;
      } else if (uHits.length > 0 && Math.abs(uHits[0].distance - aHits[0].distance) > 1e-4) {
        parityMismatches++;
      }
    }

    const uSummary = summarizeDurations(unaccelDurations);
    const aSummary = summarizeDurations(accelDurations);
    const speedup = aSummary.medianMs > 0 ? uSummary.medianMs / aSummary.medianMs : 999;
    const avgQueried = sumUnaccelQueried / rays.length;
    const avgCand = sumAccelCandidates / rays.length;
    const avgExact = sumAccelExact / rays.length;

    console.log(
      `[TKT-038 synthetic ${cfg.label}] instances=${idxStats.totalIndexedInstances} ` +
        `indexMem=${(idxStats.totalIndexMemoryBytes / (1024 * 1024)).toFixed(2)}MB ` +
        `buildMs=${idxStats.totalBuildTimeMs.toFixed(2)}ms ` +
        `unaccel(med/p95/max)=${uSummary.medianMs}/${uSummary.p95Ms}/${uSummary.maxMs}ms ` +
        `accel(med/p95/max)=${aSummary.medianMs}/${aSummary.p95Ms}/${aSummary.maxMs}ms ` +
        `speedup=${speedup.toFixed(1)}x queried=${avgQueried.toFixed(0)}->exact=${avgExact.toFixed(1)} ` +
        `candidates=${avgCand.toFixed(1)} hits=${hitsFound}/${rays.length} mismatches=${parityMismatches}`
    );

    assert.equal(parityMismatches, 0, `Expected zero parity mismatches on ${cfg.label}`);
    assert.ok(
      avgExact < avgQueried * 0.05,
      `Expected >95% reduction in exact narrow-phase instance tests on ${cfg.label}, got ${avgExact} vs ${avgQueried}`
    );
    if (cfg.tileSizeMeters >= 2048) {
      assert.ok(
        aSummary.medianMs < uSummary.medianMs * 0.2,
        `Expected >80% reduction in median picking duration on ${cfg.label}, got ${aSummary.medianMs}ms vs ${uSummary.medianMs}ms`
      );
    }

    for (const d of disposers) d();
  }

  foliageReg.dispose();
  matReg.dispose();
});
