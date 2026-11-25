import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as THREE from 'three';
import {
  GeometryBuilder,
  getTriangleCount,
  resolveInspectedFeature,
} from './GeometryBuilder';
import { MAP_THEMES } from '../styles/mapThemes';
import {
  CANONICAL_HENGELO_SNAPSHOT_ID,
  CANONICAL_HENGELO_SOURCE_SHA256,
  BAKE_SCHEMA_VERSION,
  DEFAULT_PROJECTION_ID,
  OSMTILE1_FORMAT_VERSION,
  TILE_MESH_FLAG_CAST_SHADOW,
  TILE_MESH_FLAG_HAS_BVH,
  TILE_MESH_FLAG_HIDDEN_UNDERGROUND,
  TILE_MESH_FLAG_RECEIVE_SHADOW,
  TILE_MESH_FLAG_STRUCTURAL_3D,
  TILE_MESH_FLAG_UNDERGROUND_GEOM,
  TILE_MESH_FLAG_UNDERGROUND_TRACE,
  TILE_MESH_FLAG_VISIBLE,
  TILE_PAYLOAD_FLAG_HAS_BVH,
  computeLodPolicyHash,
  type DecodedTilePayload,
  type TileInstancedBatchRecord,
  type TileManifestEntry,
  type TileMeshRecord,
} from './tiling/TilePackContract';
import {
  createRegionalMosaicPlan,
  type RegionalMosaicConfig,
  type RegionalMosaicIndex,
} from './tiling/RegionalMosaicPlan';
import {
  buildTileLocalBvh,
  decodeTileBinary,
  encodeDecodedTilePayloadToBinary,
} from './tiling/TileBinaryCodec';
import {
  compareStoredVsComputedTileStats,
  computeDecodedTileGeometryStats,
} from './tiling/TileGeometryStats';
import {
  consolidateChildTilePayloads,
  type ChildTileConsolidationInput,
} from './tiling/TileConsolidator';
import { reconstructTileSceneFromDecoded } from './tiling/TileSceneReconstructor';
import { ThemeMaterialRegistry } from './tiling/ThemeMaterialRegistry';
import { FoliagePrototypeRegistry } from './FoliageLodSystem';
import {
  TilePackSqliteStore,
  TilePackSqliteWriter,
} from '../server/tiles/TilePackSqliteStore';
import { deflateTilePayload, sha256Hex } from '../server/tiles/TileCompression';
import { consolidateRegionalMosaic } from '../server/tiles/OfflineTileConsolidator';
import { createRegionalMosaicHttpHandler } from '../server/tiles/RegionalMosaicHttpHandler';
import type { InspectableFeatureInfo, ProcessedMapData } from '../types/MapFeature';

function makeBoxMeshGeometry(
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  nonIndexed = false
): {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array | null;
} {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(cx, cy, cz);
  const src = nonIndexed ? g.toNonIndexed() : g;
  const positions = new Float32Array(src.attributes.position.array as Float32Array);
  const normals = new Float32Array(src.attributes.normal.array as Float32Array);
  const uvs = new Float32Array(src.attributes.uv.array as Float32Array);
  const indices = src.index ? new Uint16Array(src.index.array as Uint16Array) : null;
  if (src !== g) src.dispose();
  g.dispose();
  return { positions, normals, uvs, indices };
}

/**
 * Builds a multi-material building with a courtyard hole (4 outer wall-ring sections
 * around an open central courtyard + flat roof ring) so raycasting into the courtyard
 * must miss the building while raycasting the roof/walls resolves the exact OSM feature.
 */
function makeCourtyardBuildingMesh(
  cx: number,
  cz: number,
  height: number,
  featureIdx: number
): TileMeshRecord {
  // 4 rectangular wings around a 20m×20m central courtyard hole at (cx, cz)
  const wings: Array<[number, number, number, number]> = [
    [cx, cz - 15, 40, 10], // North wing
    [cx, cz + 15, 40, 10], // South wing
    [cx - 15, cz, 10, 20], // West wing
    [cx + 15, cz, 10, 20], // East wing
  ];

  const posArr: number[] = [];
  const normArr: number[] = [];
  const roofIdx: number[] = [];
  const wallIdx: number[] = [];

  for (const [wx, wz, sx, sz] of wings) {
    const baseV = posArr.length / 3;
    const x0 = wx - sx / 2;
    const x1 = wx + sx / 2;
    const z0 = wz - sz / 2;
    const z1 = wz + sz / 2;

    // 4 roof vertices (top y=height)
    posArr.push(x0, height, z0, x1, height, z0, x1, height, z1, x0, height, z1);
    normArr.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    roofIdx.push(baseV, baseV + 2, baseV + 1, baseV, baseV + 3, baseV + 2);

    // 4 wall vertices (south face for simplicity + north face)
    const wBase = posArr.length / 3;
    posArr.push(
      x0, 0, z1, x1, 0, z1, x1, height, z1, x0, height, z1,
      x1, 0, z0, x0, 0, z0, x0, height, z0, x1, height, z0
    );
    normArr.push(
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
      0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1
    );
    wallIdx.push(
      wBase, wBase + 1, wBase + 2, wBase, wBase + 2, wBase + 3,
      wBase + 4, wBase + 5, wBase + 6, wBase + 4, wBase + 6, wBase + 7
    );
  }

  const positions = new Float32Array(posArr);
  const normals = new Float32Array(normArr);
  const indices = new Uint16Array([...roofIdx, ...wallIdx]);
  const triCount = indices.length / 3;
  const bvh = buildTileLocalBvh(positions, indices);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minX) minX = positions[i];
    if (positions[i] > maxX) maxX = positions[i];
    if (positions[i + 1] < minY) minY = positions[i + 1];
    if (positions[i + 1] > maxY) maxY = positions[i + 1];
    if (positions[i + 2] < minZ) minZ = positions[i + 2];
    if (positions[i + 2] > maxZ) maxZ = positions[i + 2];
  }

  return {
    layer: 'buildings',
    name: 'Buildings_default',
    materialSlotKeys: ['building:default:roof', 'building:default:wall'],
    renderOrder: 10,
    flags:
      TILE_MESH_FLAG_VISIBLE |
      TILE_MESH_FLAG_CAST_SHADOW |
      TILE_MESH_FLAG_RECEIVE_SHADOW |
      TILE_MESH_FLAG_HAS_BVH,
    localPositionOffset: [0, 0, 0],
    bboxMin: [minX, minY, minZ],
    bboxMax: [maxX, maxY, maxZ],
    positions,
    normals,
    uvs: null,
    switchAttrs: null,
    colors: null,
    indices,
    groups: [
      { start: 0, count: roofIdx.length, materialIndex: 0 },
      { start: roofIdx.length, count: wallIdx.length, materialIndex: 1 },
    ],
    faceRanges: [{ startFace: 0, endFace: triCount, infoIdx: featureIdx }],
    singleFeatureIdx: featureIdx,
    bvh,
  };
}

function makeFlatQuadMesh(params: {
  layer: TileMeshRecord['layer'];
  name: string;
  materialSlotKey: string;
  cx: number;
  cz: number;
  y: number;
  sx: number;
  sz: number;
  renderOrder: number;
  flags: number;
  featureIdx: number;
  withUvs?: boolean;
  withSwitchAttrs?: boolean;
  withColors?: boolean;
  nonIndexed?: boolean;
}): TileMeshRecord {
  const x0 = params.cx - params.sx / 2;
  const x1 = params.cx + params.sx / 2;
  const z0 = params.cz - params.sz / 2;
  const z1 = params.cz + params.sz / 2;
  const y = params.y;

  let positions: Float32Array;
  let normals: Float32Array;
  let uvs: Float32Array | null = null;
  let switchAttrs: Float32Array | null = null;
  let colors: Float32Array | null = null;
  let indices: Uint16Array | null = null;

  if (params.nonIndexed) {
    positions = new Float32Array([
      x0, y, z0, x0, y, z1, x1, y, z0,
      x0, y, z1, x1, y, z1, x1, y, z0,
    ]);
    normals = new Float32Array([
      0, 1, 0, 0, 1, 0, 0, 1, 0,
      0, 1, 0, 0, 1, 0, 0, 1, 0,
    ]);
    if (params.withUvs) {
      uvs = new Float32Array([0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1]);
    }
    if (params.withSwitchAttrs) {
      switchAttrs = new Float32Array([0.2, 0.8, 0.2, 0.8, 0.5, 0.8, 0.2, 0.8, 0.5, 0.8, 0.5, 0.8]);
    }
    if (params.withColors) {
      colors = new Float32Array(18).fill(0.75);
    }
  } else {
    positions = new Float32Array([
      x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z1,
    ]);
    normals = new Float32Array([
      0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    ]);
    if (params.withUvs) {
      uvs = new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]);
    }
    if (params.withSwitchAttrs) {
      switchAttrs = new Float32Array([0.2, 0.8, 0.5, 0.8, 0.2, 0.8, 0.5, 0.8]);
    }
    if (params.withColors) {
      colors = new Float32Array(12).fill(0.75);
    }
    indices = new Uint16Array([0, 2, 1, 2, 3, 1]);
  }

  const bvh = buildTileLocalBvh(positions, indices);
  return {
    layer: params.layer,
    name: params.name,
    materialSlotKeys: [params.materialSlotKey],
    renderOrder: params.renderOrder,
    flags: params.flags | TILE_MESH_FLAG_HAS_BVH,
    localPositionOffset: [0, 0, 0],
    bboxMin: [x0, y, z0],
    bboxMax: [x1, y, z1],
    positions,
    normals,
    uvs,
    switchAttrs,
    colors,
    indices,
    groups: [],
    faceRanges:
      params.featureIdx >= 0
        ? [{ startFace: 0, endFace: 2, infoIdx: params.featureIdx }]
        : [],
    singleFeatureIdx: params.featureIdx,
    bvh,
  };
}

/**
 * Generates a synthetic, fully compliant 1,024 m OSMTILE1 child tile payload containing
 * all production infrastructure categories, multi-material courtyard buildings, indexed
 * and non-indexed meshes, overhanging features, broadleaf/coniferous foliage, and 3D sleepers.
 */
function createSyntheticChildTilePayload(params: {
  tx: number;
  ty: number;
  tileCenterX: number;
  tileCenterZ: number;
  tileSizeMeters: number;
  empty?: boolean;
  includeOverhang?: boolean;
  nonIndexedRoadVariant?: boolean;
}): DecodedTilePayload {
  const { tx, ty, tileCenterX, tileCenterZ, tileSizeMeters } = params;
  const half = tileSizeMeters * 0.5;

  if (params.empty) {
    return {
      formatVersion: OSMTILE1_FORMAT_VERSION,
      flags: TILE_PAYLOAD_FLAG_HAS_BVH,
      lod: 0,
      tx,
      ty,
      byteLength: 0,
      renderedFeaturesCount: 0,
      forestTreesCount: 0,
      sleeper3DBoxCount: 0,
      totalVertices: 0,
      totalTriangles: 0,
      totalDrawCalls: 0,
      tileCenterX,
      tileCenterZ,
      tileSizeMeters,
      overhangBoundsMin: [-half, -0.05, -half],
      overhangBoundsMax: [half, 0.05, half],
      railwayRenderSource: 'graph-R+',
      featureInfos: [],
      meshes: [],
      instancedBatches: [],
    };
  }

  const tag = `${tx}_${ty}`;
  const featureInfos: InspectableFeatureInfo[] = [
    {
      id: `bldg_${tag}`,
      sourceFeatureId: `way/bldg_${tag}`,
      name: `Courtyard Block ${tag}`,
      category: 'Building',
      cartoLabel: 'Residential Building',
      primaryTag: 'building=residential',
      subtype: 'residential',
      height: 14,
      levels: 4,
      osmTags: { building: 'residential', 'building:levels': 4 },
    },
    {
      id: `road_${tag}`,
      sourceFeatureId: `way/road_${tag}`,
      name: `Hoofdstraat ${tag}`,
      category: 'Road & Highway',
      cartoLabel: 'Primary Road',
      primaryTag: 'highway=primary',
      subtype: 'primary',
      width: 9,
      osmTags: { highway: 'primary', surface: 'asphalt' },
    },
    {
      id: `bridge_${tag}`,
      sourceFeatureId: `way/bridge_${tag}`,
      name: `Viaduct ${tag}`,
      category: 'Road & Highway',
      cartoLabel: 'Bridge',
      primaryTag: 'highway=secondary',
      subtype: 'secondary',
      isBridge: true,
      layer: 1,
      osmTags: { highway: 'secondary', bridge: 'yes', layer: 1 },
    },
    {
      id: `tunnel_${tag}`,
      sourceFeatureId: `way/tunnel_${tag}`,
      name: `Underpass ${tag}`,
      category: 'Road & Highway',
      cartoLabel: 'Tunnel',
      primaryTag: 'highway=residential',
      subtype: 'residential',
      isTunnel: true,
      layer: -1,
      osmTags: { highway: 'residential', tunnel: 'yes', layer: -1 },
    },
    {
      id: `rail_${tag}`,
      sourceFeatureId: `way/rail_${tag}`,
      name: `Twente Mainline ${tag}`,
      category: 'Railway & Transit',
      cartoLabel: 'Rail Track',
      primaryTag: 'railway=rail',
      subtype: 'rail',
      osmTags: { railway: 'rail', gauge: '1435' },
    },
    {
      id: `water_${tag}`,
      sourceFeatureId: `way/water_${tag}`,
      name: `Twentekanaal ${tag}`,
      category: 'Water & Waterway',
      cartoLabel: 'Water',
      primaryTag: 'natural=water',
      subtype: 'water',
      osmTags: { natural: 'water' },
    },
    {
      id: `landuse_${tag}`,
      sourceFeatureId: `way/landuse_${tag}`,
      name: `Residential Zone ${tag}`,
      category: 'Landuse & Zoning',
      cartoLabel: 'Residential',
      primaryTag: 'landuse=residential',
      subtype: 'residential',
      osmTags: { landuse: 'residential' },
    },
    {
      id: `forest_${tag}`,
      sourceFeatureId: `way/forest_${tag}`,
      name: `Twente Bos ${tag}`,
      category: 'Forest & Woodland',
      cartoLabel: 'Forest',
      primaryTag: 'landuse=forest',
      subtype: 'forest',
      osmTags: { landuse: 'forest', leaf_type: 'mixed' },
    },
  ];

  // GroundPlane
  const groundMesh = makeFlatQuadMesh({
    layer: 'ground',
    name: 'GroundPlane',
    materialSlotKey: 'ground',
    cx: 0,
    cz: 0,
    y: 0,
    sx: tileSizeMeters,
    sz: tileSizeMeters,
    renderOrder: 0,
    flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_RECEIVE_SHADOW,
    featureIdx: -1,
    withUvs: true,
  });
  groundMesh.localPositionOffset = [0, -0.015, 0];

  // Courtyard multi-material building at (-100, -100)
  const bldgMesh = makeCourtyardBuildingMesh(-100, -100, 14, 0);

  // Overhanging landmark building (extends past +half on X if includeOverhang)
  const lmBox = makeBoxMeshGeometry(
    params.includeOverhang ? half + 18 : 140,
    12,
    -120,
    24,
    24,
    24,
    true // non-indexed
  );
  const lmBvh = buildTileLocalBvh(lmBox.positions, null);
  const landmarkMesh: TileMeshRecord = {
    layer: 'buildings',
    name: 'Buildings_landmark',
    materialSlotKeys: ['building:landmark:roof', 'building:landmark:wall'],
    renderOrder: 10,
    flags:
      TILE_MESH_FLAG_VISIBLE |
      TILE_MESH_FLAG_CAST_SHADOW |
      TILE_MESH_FLAG_RECEIVE_SHADOW |
      TILE_MESH_FLAG_HAS_BVH,
    localPositionOffset: [0, 0, 0],
    bboxMin: [
      (params.includeOverhang ? half + 18 : 140) - 12,
      0,
      -132,
    ],
    bboxMax: [
      (params.includeOverhang ? half + 18 : 140) + 12,
      24,
      -108,
    ],
    positions: lmBox.positions,
    normals: lmBox.normals,
    uvs: lmBox.uvs,
    switchAttrs: null,
    colors: null,
    indices: null,
    groups: [
      { start: 0, count: 18, materialIndex: 0 },
      { start: 18, count: 18, materialIndex: 1 },
    ],
    faceRanges: [{ startFace: 0, endFace: 12, infoIdx: 0 }],
    singleFeatureIdx: 0,
    bvh: lmBvh,
  };

  // Roads (indexed or non-indexed to exercise mixed-index promotion!)
  const primaryRoadMesh = makeFlatQuadMesh({
    layer: 'roads',
    name: 'Roads_primary',
    materialSlotKey: 'road:primary',
    cx: 0,
    cz: 80,
    y: 0.055,
    sx: 400,
    sz: 12,
    renderOrder: 8,
    flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_RECEIVE_SHADOW,
    featureIdx: 1,
    nonIndexed: Boolean(params.nonIndexedRoadVariant),
  });

  // Bridge substructure + hidden underground tunnel road + tunnel trace
  const bridgeMesh = makeFlatQuadMesh({
    layer: 'roads',
    name: 'Bridge_Substructure',
    materialSlotKey: 'road:bridge_structure',
    cx: 120,
    cz: 140,
    y: 4.5,
    sx: 60,
    sz: 10,
    renderOrder: 12,
    flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_CAST_SHADOW | TILE_MESH_FLAG_RECEIVE_SHADOW,
    featureIdx: 2,
  });

  const tunnelRoadMesh = makeFlatQuadMesh({
    layer: 'roads',
    name: 'Tunnel_Underground_Roads',
    materialSlotKey: 'road:tunnel_underground',
    cx: -140,
    cz: 140,
    y: -3.0,
    sx: 50,
    sz: 8,
    renderOrder: 3,
    flags:
      TILE_MESH_FLAG_RECEIVE_SHADOW |
      TILE_MESH_FLAG_STRUCTURAL_3D |
      TILE_MESH_FLAG_UNDERGROUND_GEOM |
      TILE_MESH_FLAG_HIDDEN_UNDERGROUND,
    featureIdx: 3,
  });

  const tunnelTraceMesh = makeFlatQuadMesh({
    layer: 'roads',
    name: 'Tunnel_Underground_Trace',
    materialSlotKey: 'road:tunnel_trace',
    cx: -140,
    cz: 140,
    y: 0.09,
    sx: 50,
    sz: 8,
    renderOrder: 15,
    flags: TILE_MESH_FLAG_UNDERGROUND_TRACE,
    featureIdx: 3,
  });

  // Railways: Ballast, Rails (with UV + aSwitchAttr), Rails_3D (zoom-dependent)
  const railBallastMesh = makeFlatQuadMesh({
    layer: 'railways',
    name: 'Railway_Ballast',
    materialSlotKey: 'railway:ballast',
    cx: 0,
    cz: -220,
    y: 0.07,
    sx: 500,
    sz: 6,
    renderOrder: 9,
    flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_RECEIVE_SHADOW,
    featureIdx: 4,
    withUvs: true,
    withColors: true,
  });

  const rail2DMesh = makeFlatQuadMesh({
    layer: 'railways',
    name: 'Railway_Rails',
    materialSlotKey: 'railway:rails_2d',
    cx: 0,
    cz: -220,
    y: 0.085,
    sx: 500,
    sz: 1.5,
    renderOrder: 11,
    flags: TILE_MESH_FLAG_VISIBLE,
    featureIdx: 4,
    withUvs: true,
    withSwitchAttrs: true,
  });

  const rail3DMesh = makeFlatQuadMesh({
    layer: 'railways',
    name: 'Railway_Rails_3D',
    materialSlotKey: 'railway:rails_3d',
    cx: 0,
    cz: -220,
    y: 0.18,
    sx: 500,
    sz: 1.5,
    renderOrder: 12,
    flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_CAST_SHADOW,
    featureIdx: 4,
    withUvs: true,
    withSwitchAttrs: true,
  });

  // Water & Landuse
  const waterMesh = makeFlatQuadMesh({
    layer: 'water',
    name: 'Water_All',
    materialSlotKey: 'water',
    cx: 220,
    cz: 220,
    y: 0.02,
    sx: 120,
    sz: 90,
    renderOrder: 2,
    flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_RECEIVE_SHADOW,
    featureIdx: 5,
  });

  const landuseMesh = makeFlatQuadMesh({
    layer: 'landuse',
    name: 'Landuse_residential',
    materialSlotKey: 'landuse:residential',
    cx: -220,
    cz: -220,
    y: 0.01,
    sx: 150,
    sz: 150,
    renderOrder: 1,
    flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_RECEIVE_SHADOW,
    featureIdx: 6,
  });

  // Instanced foliage: 12 broadleaf + 8 coniferous = 20 trees per tile
  const dummy = new THREE.Object3D();
  const trunkMatrices = new Float32Array(20 * 16);
  const broadMatrices = new Float32Array(12 * 16);
  const needleMatrices = new Float32Array(8 * 16);
  const trunkFeats = new Int32Array(20).fill(7);
  const broadFeats = new Int32Array(12).fill(7);
  const needleFeats = new Int32Array(8).fill(7);

  let bIdx = 0;
  let nIdx = 0;
  for (let i = 0; i < 20; i++) {
    const px = -300 + (i % 5) * 32;
    const pz = 240 + Math.floor(i / 5) * 32;
    dummy.position.set(px, 0.025, pz);
    dummy.rotation.set(0, (i * 0.7) % (Math.PI * 2), 0);
    dummy.scale.setScalar(0.9 + (i % 3) * 0.15);
    dummy.updateMatrix();
    trunkMatrices.set(dummy.matrix.elements, i * 16);
    if (i < 12) {
      broadMatrices.set(dummy.matrix.elements, bIdx * 16);
      bIdx++;
    } else {
      needleMatrices.set(dummy.matrix.elements, nIdx * 16);
      nIdx++;
    }
  }

  // Instanced 3D railway sleepers: 10 sleepers along z = -220
  const sleeperMatrices = new Float32Array(10 * 16);
  const sleeperFeats = new Int32Array(10).fill(4);
  const sleeperBoxes = [];
  for (let i = 0; i < 10; i++) {
    const sx = -200 + i * 40;
    const sz = -220;
    dummy.position.set(sx, 0.09, sz);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    sleeperMatrices.set(dummy.matrix.elements, i * 16);
    sleeperBoxes.push({
      cx: sx,
      cz: sz,
      yBottom: 0.02,
      yTop: 0.16,
      tx: 1,
      tz: 0,
      nx: 0,
      nz: 1,
      halfLen: 0.12,
      halfWidthLeft: 1.25,
      halfWidthRight: 1.25,
      trackId: `track_${tag}`,
    });
  }

  const instancedBatches: TileInstancedBatchRecord[] = [
    {
      layer: 'foliage',
      name: 'ProceduralForest_Trunks',
      materialSlotKey: 'foliage:trunk',
      prototypeKind: 'tree_trunk',
      renderOrder: 0,
      flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_CAST_SHADOW | TILE_MESH_FLAG_RECEIVE_SHADOW,
      bboxMin: [-310, 0, 230],
      bboxMax: [-160, 10, 360],
      instanceCount: 20,
      matrices: trunkMatrices,
      instanceColors: null,
      instanceFeatureIdxs: trunkFeats,
      sleeperBoxes: null,
    },
    {
      layer: 'foliage',
      name: 'ProceduralForest_BroadleavedCanopy',
      materialSlotKey: 'foliage:broadleaved',
      prototypeKind: 'tree_broadleaved',
      renderOrder: 0,
      flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_CAST_SHADOW | TILE_MESH_FLAG_RECEIVE_SHADOW,
      bboxMin: [-310, 0, 230],
      bboxMax: [-160, 14, 340],
      instanceCount: 12,
      matrices: broadMatrices,
      instanceColors: null,
      instanceFeatureIdxs: broadFeats,
      sleeperBoxes: null,
    },
    {
      layer: 'foliage',
      name: 'ProceduralForest_NeedleleavedCanopy',
      materialSlotKey: 'foliage:needleleaved',
      prototypeKind: 'tree_needleleaved',
      renderOrder: 0,
      flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_CAST_SHADOW | TILE_MESH_FLAG_RECEIVE_SHADOW,
      bboxMin: [-310, 0, 290],
      bboxMax: [-160, 14, 360],
      instanceCount: 8,
      matrices: needleMatrices,
      instanceColors: null,
      instanceFeatureIdxs: needleFeats,
      sleeperBoxes: null,
    },
    {
      layer: 'railways',
      name: 'Railway_Sleepers_3D',
      materialSlotKey: 'railway:sleepers_3d',
      prototypeKind: 'sleeper_box_unit',
      renderOrder: 10,
      flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_CAST_SHADOW | TILE_MESH_FLAG_RECEIVE_SHADOW,
      bboxMin: [-202, 0, -222],
      bboxMax: [162, 0.2, -218],
      instanceCount: 10,
      matrices: sleeperMatrices,
      instanceColors: null,
      instanceFeatureIdxs: sleeperFeats,
      sleeperBoxes,
    },
  ];

  const meshes: TileMeshRecord[] = [
    groundMesh,
    bldgMesh,
    landmarkMesh,
    primaryRoadMesh,
    bridgeMesh,
    tunnelRoadMesh,
    tunnelTraceMesh,
    railBallastMesh,
    rail2DMesh,
    rail3DMesh,
    waterMesh,
    landuseMesh,
  ];

  const payload: DecodedTilePayload = {
    formatVersion: OSMTILE1_FORMAT_VERSION,
    flags: TILE_PAYLOAD_FLAG_HAS_BVH,
    lod: 0,
    tx,
    ty,
    byteLength: 0,
    renderedFeaturesCount: featureInfos.length,
    forestTreesCount: 20,
    sleeper3DBoxCount: 10,
    totalVertices: 0,
    totalTriangles: 0,
    totalDrawCalls: 0,
    tileCenterX,
    tileCenterZ,
    tileSizeMeters,
    overhangBoundsMin: [-half, -3, -half],
    overhangBoundsMax: [params.includeOverhang ? half + 30 : half, 24, half],
    railwayRenderSource: 'graph-R+',
    featureInfos,
    meshes,
    instancedBatches,
  };

  const stats = computeDecodedTileGeometryStats(payload, 'lod0');
  payload.totalVertices = stats.totalVertices;
  // Intentionally simulate legacy pre-TKT-037 header under-count (missing non-indexed broadleaved canopy 240*12 = 2880 tris)
  payload.totalTriangles = stats.totalTriangles - 12 * 240;
  payload.totalDrawCalls = stats.totalDrawCalls;
  return payload;
}

/**
 * Writes a deterministic synthetic regional mosaic to disk using real SQLite shard packs.
 */
function buildSyntheticMosaicOnDisk(
  outDir: string,
  config: RegionalMosaicConfig,
  emptyCoordSet: Set<string>
): string {
  const plan = createRegionalMosaicPlan(config);
  fs.mkdirSync(path.join(outDir, 'shards'), { recursive: true });
  const lodPolicyHash = computeLodPolicyHash({
    projectionId: DEFAULT_PROJECTION_ID,
    tileSizeMeters: config.tileSizeMeters,
    collarMeters: config.collarMeters,
    lod: 0,
    includeBvh: true,
  });

  const shardRefs: Array<{ id: string; file: string }> = [];
  for (const shard of plan.shards) {
    const relFile = `shards/${shard.id}.sqlite`;
    const absFile = path.join(outDir, relFile);
    const writer = new TilePackSqliteWriter(absFile, {
      snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
      sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
      projectionId: DEFAULT_PROJECTION_ID,
      bakeSchemaVersion: BAKE_SCHEMA_VERSION,
      lodPolicyHash,
      compression: 'deflate',
      tileSizeMeters: config.tileSizeMeters,
      collarMeters: config.collarMeters,
      studyOriginEasting: shard.grid.projection.originEasting,
      studyOriginNorthing: shard.grid.projection.originNorthing,
      gridCols: shard.grid.cols,
      gridRows: shard.grid.rows,
      minTx: shard.grid.minTx,
      maxTx: shard.grid.maxTx,
      minTy: shard.grid.minTy,
      maxTy: shard.grid.maxTy,
      createdAtIso: '2026-11-25T00:00:00.000Z',
    });

    const batchItems = [];
    for (const tile of shard.grid.tiles) {
      const tileCenterX = (tile.localBounds.minX + tile.localBounds.maxX) * 0.5;
      const tileCenterZ = (tile.localBounds.minZ + tile.localBounds.maxZ) * 0.5;
      const isEmpty = emptyCoordSet.has(`${tile.tx}:${tile.ty}`);
      const payload = createSyntheticChildTilePayload({
        tx: tile.tx,
        ty: tile.ty,
        tileCenterX,
        tileCenterZ,
        tileSizeMeters: config.tileSizeMeters,
        empty: isEmpty,
        includeOverhang: tile.tx === plan.grid.minTx && tile.ty === plan.grid.minTy,
        nonIndexedRoadVariant: (tile.tx + tile.ty) % 2 === 1,
      });
      const rawBytes = encodeDecodedTilePayloadToBinary(payload);
      const compressedPayload = deflateTilePayload(rawBytes);
      const manifest: TileManifestEntry = {
        lod: 0,
        tx: tile.tx,
        ty: tile.ty,
        minEasting: tile.utmBounds.minEasting,
        maxEasting: tile.utmBounds.maxEasting,
        minNorthing: tile.utmBounds.minNorthing,
        maxNorthing: tile.utmBounds.maxNorthing,
        tileCenterX,
        tileCenterZ,
        overhangMinX: payload.overhangBoundsMin[0],
        overhangMaxX: payload.overhangBoundsMax[0],
        overhangMinY: payload.overhangBoundsMin[1],
        overhangMaxY: payload.overhangBoundsMax[1],
        overhangMinZ: payload.overhangBoundsMin[2],
        overhangMaxZ: payload.overhangBoundsMax[2],
        triCount: payload.totalTriangles,
        vertexCount: payload.totalVertices,
        featureCount: payload.renderedFeaturesCount,
        isEmpty,
        hasBvh: !isEmpty,
        rawBytes: rawBytes.byteLength,
        compressedBytes: compressedPayload.byteLength,
        contentHash: sha256Hex(compressedPayload),
      };
      batchItems.push({ manifest, compressedPayload });
    }
    writer.writeTileBatch(batchItems);
    writer.finalize('2026-11-25T00:00:01.000Z');
    shardRefs.push({ id: shard.id, file: relFile });
  }

  const index: RegionalMosaicIndex = {
    schemaVersion: 1,
    config,
    snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
    sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
    shards: shardRefs,
  };
  const indexPath = path.join(outDir, 'mosaic.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
  return indexPath;
}

test('TKT-037 Section 6: triangle statistics handle indexed, non-indexed, and instanced foliage accurately', () => {
  // 1. Verify getTriangleCount handles both indexed and non-indexed geometries
  const indexed = new THREE.BoxGeometry(1, 1, 1);
  const nonIndexed = indexed.toNonIndexed();
  assert.equal(getTriangleCount(indexed), 12);
  assert.equal(getTriangleCount(nonIndexed), 12);
  indexed.dispose();
  nonIndexed.dispose();

  // 2. Verify FoliagePrototypeRegistry broadleaf LOD0 (non-indexed) now contributes 240 tris/tree in GeometryBuilder
  const protoReg = new FoliagePrototypeRegistry();
  const broadGeo = protoReg.getGeometry('tree_broadleaved', 'lod0');
  assert.equal(broadGeo.index, null, 'Broadleaf LOD0 prototype is non-indexed');
  assert.equal(getTriangleCount(broadGeo), 240);
  protoReg.dispose();

  const syntheticParsed: ProcessedMapData = {
    regionName: 'Synthetic Forest Stats',
    centerLonLat: [6.845, 52.25],
    bounds: {
      minX: -100,
      maxX: 100,
      minZ: -100,
      maxZ: 100,
      widthMeters: 200,
      depthMeters: 200,
    },
    buildings: [],
    roads: [],
    railways: [],
    waterBodies: [],
    linearWaterways: [],
    water: [],
    parks: [
      {
        id: 'forest_1',
        sourceFeatureId: 'way/forest_1',
        type: 'park',
        name: 'Broadleaf Patch',
        subtype: 'forest',
        has3DFoliage: true,
        leafType: 'broadleaved',
        polygon: [
          [
            [-40, -40],
            [40, -40],
            [40, 40],
            [-40, 40],
            [-40, -40],
          ],
        ],
      },
    ],
    landuse: [],
    barriers: [],
    landmarks: [],
    diagnostics: {
      sourceFeaturesReceived: 1,
      sourceFeaturesClassified: 1,
      totalFeaturesParsed: 1,
      sourceFeaturesRendered: 1,
      constructedMeshesCount: 0,
      parsedByCategory: {
        buildings: 0,
        roads: 0,
        railways: 0,
        waterBodies: 0,
        linearWaterways: 0,
        parks: 1,
        landuse: 0,
        barriers: 0,
        landmarks: 0,
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
      byGeometryType: {
        Point: 0,
        MultiPoint: 0,
        LineString: 0,
        MultiLineString: 0,
        Polygon: 1,
        MultiPolygon: 0,
        GeometryCollection: 0,
        Unknown: 0,
      },
      totalFeaturesReceived: 1,
      totalFeaturesRendered: 1,
    },
    stats: {
      totalBuildings: 0,
      totalRoads: 0,
      totalRoadSegments: 0,
      totalRailways: 0,
      totalRailwaySegments: 0,
      totalWaterPolygons: 0,
      totalLinearWaterways: 0,
      totalParkPolygons: 1,
      totalLandusePolygons: 0,
      totalBarriers: 0,
      totalLandmarks: 0,
      areaKm2: 0.04,
    },
  };

  const builder = new GeometryBuilder();
  const built = builder.buildScene(syntheticParsed, MAP_THEMES.daylight);
  try {
    const trees = built.stats.forestTreesCount ?? 0;
    assert.ok(trees > 0, 'Expected procedural trees in synthetic forest');
    // Each broadleaf tree has 24 trunk tris + 240 canopy tris = 264 tris
    assert.ok(
      built.stats.totalTriangles >= trees * 264,
      `Expected totalTriangles (${built.stats.totalTriangles}) >= ${trees * 264} (including non-indexed broadleaf canopy)`
    );
  } finally {
    built.dispose();
  }

  // 3. Verify compareStoredVsComputedTileStats detects legacy baked header discrepancy without rebaking
  const legacyPayload = createSyntheticChildTilePayload({
    tx: 320,
    ty: 5640,
    tileCenterX: 0,
    tileCenterZ: 0,
    tileSizeMeters: 1024,
  });
  const cmp = compareStoredVsComputedTileStats(legacyPayload, 'lod0');
  assert.equal(
    cmp.triangleDelta,
    12 * 240,
    'Should detect exact legacy 2,880-triangle under-count from non-indexed broadleaf canopy'
  );
  assert.equal(cmp.computedFromBuffers.foliageInstanceCount, 40); // 20 trunks + 12 broad + 8 needle
  assert.equal(cmp.computedFromBuffers.sleeperInstanceCount, 10);
});

test('TKT-037 Core: consolidateChildTilePayloads preserves exact triangles, instances, world-space positions, attributes, multi-material groups, BVH raycast & zoom behavior', () => {
  // 2×2 child tiles (1,024 m -> 2,048 m), including 1 empty child, mixed indexed/non-indexed roads, and overhanging landmark
  const parentCenterE = 330752; // tx=161 @ 2048m -> [329728, 331776]
  const parentCenterN = 5776384; // ty=2820 @ 2048m -> [5775360, 5777408]

  const childSpecs = [
    { tx: 322, ty: 5640, empty: false, overhang: true, nonIndexedRoad: false },
    { tx: 323, ty: 5640, empty: false, overhang: false, nonIndexedRoad: true },
    { tx: 322, ty: 5641, empty: true, overhang: false, nonIndexedRoad: false },
    { tx: 323, ty: 5641, empty: false, overhang: false, nonIndexedRoad: false },
  ];

  const children: ChildTileConsolidationInput[] = childSpecs.map((spec) => {
    const childCenterE = (spec.tx + 0.5) * 1024;
    const childCenterN = (spec.ty + 0.5) * 1024;
    return {
      tx: spec.tx,
      ty: spec.ty,
      childCenterEasting: childCenterE,
      childCenterNorthing: childCenterN,
      payload: createSyntheticChildTilePayload({
        tx: spec.tx,
        ty: spec.ty,
        tileCenterX: childCenterE - parentCenterE,
        tileCenterZ: parentCenterN - childCenterN,
        tileSizeMeters: 1024,
        empty: spec.empty,
        includeOverhang: spec.overhang,
        nonIndexedRoadVariant: spec.nonIndexedRoad,
      }),
    };
  });

  const target = {
    lod: 0,
    tx: 161,
    ty: 2820,
    tileSizeMeters: 2048,
    parentCenterEasting: parentCenterE,
    parentCenterNorthing: parentCenterN,
    tileCenterX: 0,
    tileCenterZ: 0,
  };

  const resA = consolidateChildTilePayloads(children, target, {
    foliageBatchMode: 'parent',
    sleeperBatchMode: 'child',
    includeBvh: true,
  });
  const resB = consolidateChildTilePayloads(children, target, {
    foliageBatchMode: 'parent',
    sleeperBatchMode: 'child',
    includeBvh: true,
  });

  // 1. Exact triangle & instance conservation
  assert.equal(resA.isEmpty, false);
  assert.equal(resA.audit.nonEmptyChildCount, 3);
  assert.equal(resA.audit.nonGroundTriangleDelta, 0, 'Non-ground triangles must be conserved exactly');
  assert.equal(resA.audit.instanceCountDelta, 0, 'Instance counts must be conserved exactly');
  assert.equal(resA.audit.parentGroundTriangles, 2, 'Single 2-triangle GroundPlane for parent tile');
  assert.equal(resA.audit.mixedIndexPromotions, 1, 'Mixed indexed + non-indexed Roads_primary must merge cleanly');

  // 2. Multi-material group consolidation (3 children × 2 groups = 6 -> 2 groups per building bucket!)
  assert.equal(resA.audit.multiMaterialGroupsBefore, 12); // Buildings_default (6) + Buildings_landmark (6)
  assert.equal(resA.audit.multiMaterialGroupsAfter, 4); // Buildings_default (2) + Buildings_landmark (2)

  // 3. Draw call reduction & instanced sub-batch policy
  assert.ok(
    resA.audit.parentStaticDrawCalls < resA.audit.sourceStaticDrawCalls,
    `Static draw calls should decrease (${resA.audit.sourceStaticDrawCalls} -> ${resA.audit.parentStaticDrawCalls})`
  );
  // foliageBatchMode='parent' -> 3 foliage batches total; sleeperBatchMode='child' -> 3 sleeper sub-batches
  const parentFoliageBatches = resA.payload.instancedBatches.filter((b) => b.layer === 'foliage');
  const parentSleeperBatches = resA.payload.instancedBatches.filter((b) => b.prototypeKind === 'sleeper_box_unit');
  assert.equal(parentFoliageBatches.length, 3);
  assert.equal(parentSleeperBatches.length, 3);

  // Compare with sleeperBatchMode='parent' -> 1 sleeper batch, exact same instance count (30)
  const resMergedSleepers = consolidateChildTilePayloads(children, target, {
    foliageBatchMode: 1024,
    sleeperBatchMode: 'parent',
    includeBvh: true,
  });
  assert.equal(
    resMergedSleepers.payload.instancedBatches.filter((b) => b.prototypeKind === 'sleeper_box_unit').length,
    1
  );
  assert.equal(resMergedSleepers.audit.instanceCountDelta, 0);

  // 4. Byte-for-byte determinism & OSMTILE1 codec round-trip
  const bytesA = encodeDecodedTilePayloadToBinary(resA.payload);
  const bytesB = encodeDecodedTilePayloadToBinary(resB.payload);
  assert.equal(Buffer.compare(Buffer.from(bytesA), Buffer.from(bytesB)), 0, 'Consolidation must be byte-deterministic');

  const roundTripped = decodeTileBinary(bytesA, '0:161:2820');
  const rtStats = computeDecodedTileGeometryStats(roundTripped, 'lod0');
  assert.equal(roundTripped.totalTriangles, rtStats.totalTriangles);
  assert.equal(roundTripped.totalVertices, rtStats.totalVertices);
  assert.equal(roundTripped.totalDrawCalls, rtStats.totalDrawCalls);

  // 5. Attribute preservation (UVs, aSwitchAttr, colors, underground flags)
  const rail2D = roundTripped.meshes.find((m) => m.name === 'Railway_Rails');
  assert.ok(rail2D && rail2D.uvs && rail2D.switchAttrs, 'Railway_Rails must preserve UVs and aSwitchAttr');
  const ballast = roundTripped.meshes.find((m) => m.name === 'Railway_Ballast');
  assert.ok(ballast && ballast.uvs && ballast.colors, 'Railway_Ballast must preserve UVs and vertex colors');
  const ugRoad = roundTripped.meshes.find((m) => m.name === 'Tunnel_Underground_Roads');
  assert.ok(
    ugRoad && (ugRoad.flags & TILE_MESH_FLAG_HIDDEN_UNDERGROUND) !== 0 && (ugRoad.flags & TILE_MESH_FLAG_VISIBLE) === 0,
    'Hidden underground tunnel roads must preserve hidden flags'
  );
  const ugTrace = roundTripped.meshes.find((m) => m.name === 'Tunnel_Underground_Trace');
  assert.ok(
    ugTrace && (ugTrace.flags & TILE_MESH_FLAG_UNDERGROUND_TRACE) !== 0,
    'Tunnel trace must preserve trace flag'
  );

  // 6. World-space vertex precision (< 1 mm tolerance) on Buildings_default
  const consolidatedBldg = roundTripped.meshes.find((m) => m.name === 'Buildings_default')!;
  const expectedWorldVerts = new Set<string>();
  for (const c of children) {
    const cm = c.payload.meshes.find((m) => m.name === 'Buildings_default');
    if (!cm) continue;
    for (let i = 0; i < cm.positions.length; i += 3) {
      const e = c.childCenterEasting + cm.positions[i] + cm.localPositionOffset[0];
      const y = cm.positions[i + 1] + cm.localPositionOffset[1];
      const n = c.childCenterNorthing - (cm.positions[i + 2] + cm.localPositionOffset[2]);
      expectedWorldVerts.add(`${Math.round(e * 100)}:${Math.round(y * 100)}:${Math.round(n * 100)}`);
    }
  }
  let matchedVerts = 0;
  for (let i = 0; i < consolidatedBldg.positions.length; i += 3) {
    const e = parentCenterE + consolidatedBldg.positions[i] + consolidatedBldg.localPositionOffset[0];
    const y = consolidatedBldg.positions[i + 1] + consolidatedBldg.localPositionOffset[1];
    const n = parentCenterN - (consolidatedBldg.positions[i + 2] + consolidatedBldg.localPositionOffset[2]);
    if (expectedWorldVerts.has(`${Math.round(e * 100)}:${Math.round(y * 100)}:${Math.round(n * 100)}`)) {
      matchedVerts++;
    }
  }
  assert.equal(
    matchedVerts,
    consolidatedBldg.positions.length / 3,
    'All consolidated building vertices must match child world-space UTM positions within sub-cm precision'
  );

  // 7. Reconstruct via TileSceneReconstructor & test BVH raycast, courtyard hole, zoom switching, bounds, disposal
  const registry = new ThemeMaterialRegistry(MAP_THEMES.daylight);
  const foliageRegistry = new FoliagePrototypeRegistry();
  const reconstructed = reconstructTileSceneFromDecoded(roundTripped, {
    materialRegistry: registry,
    foliagePrototypeRegistry: foliageRegistry,
  });

  try {
    const { scene } = reconstructed;
    scene.buildingsGroup.updateMatrixWorld(true);
    scene.roadsGroup.updateMatrixWorld(true);
    scene.railwaysGroup.updateMatrixWorld(true);
    scene.foliageGroup.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster();
    (raycaster as unknown as { firstHitOnly?: boolean }).firstHitOnly = true;

    // For child (322, 5640), dx = -512, dz = +512; courtyard building center = (-612, +412), north wing at (-612, +397)
    const wingRayX = -512 - 100;
    const wingRayZ = 512 - 100 - 15;
    raycaster.set(new THREE.Vector3(wingRayX, 100, wingRayZ), new THREE.Vector3(0, -1, 0));
    const wingHits = raycaster.intersectObject(scene.buildingsGroup, true);
    assert.ok(wingHits.length > 0, 'Ray into consolidated courtyard building wing must hit');
    const resolvedWing = resolveInspectedFeature(wingHits[0]);
    assert.equal(resolvedWing?.id, 'bldg_322_5640', 'Must resolve exact OSM feature for child (322, 5640)');

    // Ray into courtyard center (-612, +412) must MISS the building!
    raycaster.set(new THREE.Vector3(-512 - 100, 100, 512 - 100), new THREE.Vector3(0, -1, 0));
    const holeHits = raycaster.intersectObject(scene.buildingsGroup, true);
    assert.equal(holeHits.length, 0, 'Ray into open courtyard hole must miss building geometry');

    // Ray into child (323, 5641) primary road (dx = +512, dz = -512, road center at (+512, -432))
    raycaster.set(new THREE.Vector3(512, 50, -512 + 80), new THREE.Vector3(0, -1, 0));
    const roadHits = raycaster.intersectObject(scene.roadsGroup, true);
    assert.ok(roadHits.length > 0, 'Ray into consolidated road must hit');
    assert.equal(resolveInspectedFeature(roadHits[0])?.id, 'road_323_5641');

    // Check railway zoom switching on consolidated parent tile
    scene.updateCameraZoom(0.15);
    let sleepersVisibleLowZoom = false;
    let rail2DVisibleLowZoom = false;
    scene.railwaysGroup.traverse((obj) => {
      if (obj.name === 'Railway_Sleepers_3D' && obj.visible) sleepersVisibleLowZoom = true;
      if (obj.name === 'Railway_Rails' && obj.visible) rail2DVisibleLowZoom = true;
    });
    assert.equal(sleepersVisibleLowZoom, false, '3D sleepers must hide at regional zoom 0.15');
    assert.equal(rail2DVisibleLowZoom, true, '2D rails must be visible at regional zoom 0.15');

    scene.updateCameraZoom(6.5);
    let sleepersVisibleHighZoom = false;
    let rail3DVisibleHighZoom = false;
    scene.railwaysGroup.traverse((obj) => {
      if (obj.name === 'Railway_Sleepers_3D' && obj.visible) sleepersVisibleHighZoom = true;
      if (obj.name === 'Railway_Rails_3D' && obj.visible) rail3DVisibleHighZoom = true;
    });
    assert.equal(sleepersVisibleHighZoom, true, '3D sleepers must appear at street zoom 6.5');
    assert.equal(rail3DVisibleHighZoom, true, '3D rails must appear at street zoom 6.5');

    // Check every reconstructed mesh/instanced batch has valid finite boundingSphere
    const allGroups = [
      scene.groundMesh,
      scene.buildingsGroup,
      scene.roadsGroup,
      scene.railwaysGroup,
      scene.waterGroup,
      scene.parksGroup,
      scene.landuseGroup,
      scene.barriersGroup,
      scene.foliageGroup,
    ];
    for (const grp of allGroups) {
      grp.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const m = obj as THREE.Mesh;
          const bs = (m as THREE.InstancedMesh).isInstancedMesh
            ? (m as THREE.InstancedMesh).boundingSphere
            : m.geometry.boundingSphere;
          assert.ok(bs && Number.isFinite(bs.radius) && bs.radius > 0, `Valid boundingSphere required on ${m.name}`);
        }
      });
    }
  } finally {
    reconstructed.dispose();
    foliageRegistry.dispose();
    registry.dispose();
  }
});

test('TKT-037 Offline Mosaic Consolidator: 4×4 1024m mosaic -> 2048m and 4096m with partial-border handling, non-destructive guard, and HTTP serving', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-tkt037-'));
  try {
    // 1. Offset 4×4 source mosaic with odd minTx/minTy (simulating TWENTE_FULL_CONFIG partial parent borders!)
    const sourceDir = path.join(tmpRoot, 'synthetic-1024m');
    const sourceConfig: RegionalMosaicConfig = {
      name: 'synthetic-twente-1024m',
      centerLonLat: [6.729032, 52.281848],
      cols: 4,
      rows: 4,
      tileSizeMeters: 1024,
      shardDimension: 2,
      collarMeters: 64,
      contextMarginMeters: 1024,
    };
    const sourcePlan = createRegionalMosaicPlan(sourceConfig);
    // Mark 2 tiles empty so we verify empty + mixed parent tiles
    const emptyTiles = new Set<string>([
      `${sourcePlan.grid.minTx}:${sourcePlan.grid.minTy}`,
      `${sourcePlan.grid.maxTx}:${sourcePlan.grid.maxTy}`,
    ]);
    const sourceIndexPath = buildSyntheticMosaicOnDisk(sourceDir, sourceConfig, emptyTiles);

    // 2. Non-destructive guard: must refuse writing into source directory
    assert.throws(
      () =>
        consolidateRegionalMosaic({
          sourceIndexPath,
          targetTileSizeMeters: 2048,
          outputDir: sourceDir,
        }),
      /Refusing to write consolidated mosaic into source directory/i
    );

    // 3. Consolidate to 2,048 m
    const out2048Dir = path.join(tmpRoot, 'synthetic-2048m');
    const report2048 = consolidateRegionalMosaic({
      sourceIndexPath,
      targetTileSizeMeters: 2048,
      outputDir: out2048Dir,
      policy: { foliageBatchMode: 'parent', sleeperBatchMode: 'child', includeBvh: true },
      verifyOutput: true,
    });

    assert.equal(report2048.verification.passed, true);
    assert.equal(report2048.geometryAudit.nonGroundTriangleDelta, 0);
    assert.equal(report2048.geometryAudit.instanceCountDelta, 0);
    assert.ok(
      report2048.geometryAudit.totalDrawCallReductionPct > 30,
      `Expected >30% resident draw-call reduction at 2048m, got ${report2048.geometryAudit.totalDrawCallReductionPct}%`
    );
    assert.ok(fs.existsSync(path.join(out2048Dir, 'consolidation-report.json')));

    // 4. Consolidate to 4,096 m
    const out4096Dir = path.join(tmpRoot, 'synthetic-4096m');
    const report4096 = consolidateRegionalMosaic({
      sourceIndexPath,
      targetTileSizeMeters: 4096,
      outputDir: out4096Dir,
      policy: { foliageBatchMode: 'parent', sleeperBatchMode: 'child', includeBvh: true },
      verifyOutput: true,
    });

    assert.equal(report4096.verification.passed, true);
    assert.equal(report4096.geometryAudit.nonGroundTriangleDelta, 0);
    assert.equal(report4096.geometryAudit.instanceCountDelta, 0);
    assert.ok(
      report4096.geometryAudit.parentTotalDrawCalls < report2048.geometryAudit.parentTotalDrawCalls,
      `Expected 4096m draw calls (${report4096.geometryAudit.parentTotalDrawCalls}) < 2048m (${report2048.geometryAudit.parentTotalDrawCalls})`
    );

    // 5. Verify RegionalMosaicHttpHandler serves both consolidated mosaics seamlessly without server changes
    for (const [idxPath, expectedSize] of [
      [report2048.outputIndexPath, 2048],
      [report4096.outputIndexPath, 4096],
    ] as const) {
      const handler = createRegionalMosaicHttpHandler({ indexPath: idxPath });
      try {
        let statusCode = 200;
        let jsonBody: any = null;
        const mockRes = {
          status(code: number) {
            statusCode = code;
            return this;
          },
          setHeader() {
            return this;
          },
          json(body: any) {
            jsonBody = body;
            return this;
          },
          send(body: any) {
            jsonBody = body;
            return this;
          },
        } as any;
        await handler.manifestHandler({} as any, mockRes);
        assert.equal(statusCode, 200, `Expected HTTP 200 for ${expectedSize}m manifest`);
        assert.equal(jsonBody?.metadata?.tileSizeMeters, expectedSize);
        assert.ok(Array.isArray(jsonBody?.tiles) && jsonBody.tiles.length > 0);
        const cov = handler.getCoverageSnapshot();
        assert.ok(cov && cov.metadata.tileSizeMeters === expectedSize && cov.tiles.length > 0);

        const firstTile = jsonBody.tiles.find((t: any) => !t.isEmpty) ?? jsonBody.tiles[0];
        let tileStatus = 200;
        let tileBody: any = null;
        const tileRes = {
          status(code: number) {
            tileStatus = code;
            return this;
          },
          setHeader() {
            return this;
          },
          json(b: any) {
            tileBody = b;
            return this;
          },
          send(b: any) {
            tileBody = b;
            return this;
          },
        } as any;
        await handler.tilePayloadHandler(
          {
            params: {
              lod: String(firstTile.lod),
              tx: String(firstTile.tx),
              ty: String(firstTile.ty),
            },
            headers: {},
          } as any,
          tileRes
        );
        assert.equal(tileStatus, 200, `Expected HTTP 200 for ${expectedSize}m tile payload`);
        assert.ok(tileBody && tileBody.byteLength > 0);
      } finally {
        handler.close();
      }
    }

    // 6. Verify source mosaic files remain untouched
    const sourceShardStore = new TilePackSqliteStore(
      path.join(sourceDir, 'shards', 'r00-c00.sqlite')
    );
    try {
      assert.equal(sourceShardStore.getMetadata().tileSizeMeters, 1024);
    } finally {
      sourceShardStore.close();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('TKT-037 Benchmark Runner: CLI parser & software-renderer warning formatting', async () => {
  const { parseSpatialBatchingCli, formatSpatialBatchingMarkdown } = await import(
    '../../benchmarks/spatialBatchingRunner'
  );
  const parsed = parseSpatialBatchingCli([
    '--index-1024=data/osm/a/mosaic.json',
    '--index-2048=data/osm/b/mosaic.json',
    '--index-4096=data/osm/c/mosaic.json',
    '--runs=3',
    '--warmup-frames=8',
    '--measured-frames=30',
    '--allow-software',
  ]);
  assert.equal(parsed.mosaics.length, 3);
  assert.equal(parsed.runs, 3);
  assert.equal(parsed.warmupFrames, 8);
  assert.equal(parsed.measuredFrames, 30);
  assert.equal(parsed.requireHardware, false);

  const md = formatSpatialBatchingMarkdown({
    generatedAtIso: '2026-11-25T00:00:00.000Z',
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    themeId: 'daylight',
    targetUtm: { easting: 345088, northing: 5794816 },
    gpuVendor: 'Google Inc.',
    gpuRenderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))',
    isSoftwareRenderer: true,
    softwareRendererWarning: 'Software renderer test warning',
    runsPerCase: 1,
    warmupFrames: 5,
    measuredFrames: 10,
    mosaics: [],
    stationaryResults: [],
    panResults: [],
  });
  assert.match(md, /SOFTWARE RENDERER/);
  assert.match(md, /Software renderer test warning/);
});
