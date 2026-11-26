import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import * as THREE from 'three';
import { resolveInspectedFeature } from './GeometryBuilder';
import {
  BAKE_SCHEMA_VERSION,
  CANONICAL_HENGELO_SNAPSHOT_ID,
  CANONICAL_HENGELO_SOURCE_SHA256,
  DEFAULT_PROJECTION_ID,
  OSMTILE1_FORMAT_VERSION,
  TILE_MESH_FLAG_CAST_SHADOW,
  TILE_MESH_FLAG_HAS_BVH,
  TILE_MESH_FLAG_RECEIVE_SHADOW,
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
  encodeDecodedTilePayloadToBinary,
} from './tiling/TileBinaryCodec';
import {
  HIERARCHICAL_MOSAIC_SCHEMA_TYPE,
  HIERARCHICAL_MOSAIC_SCHEMA_VERSION,
  HierarchicalMosaicCompatibilityError,
  findOverlappingTilesByAbsoluteUtm,
  formatHierarchicalTileKey,
  parseHierarchicalTileKey,
  validateAndComposeHierarchicalManifest,
  type HierarchicalRegionalMosaicDescriptor,
} from './tiling/HierarchicalMosaicContract';
import {
  DEFAULT_HIERARCHICAL_RESOLUTION_POLICY,
  computeEffectiveOrthographicScale,
  normalizeHierarchicalResolutionPolicy,
  parseHierarchicalPolicyFromSearch,
  resolveDesiredHierarchicalResolution,
  resolvePhysicalMarginsForResolution,
} from './tiling/HierarchicalResolutionPolicy';
import {
  parseHierarchicalBudgetFromSearch,
} from './tiling/HierarchicalResourceBudget';
import {
  TileStreamManager,
  type TileViewportGroundBounds,
} from './tiling/TileStreamManager';
import { StreamingProfiler } from './tiling/StreamingProfiler';
import { TilePackSqliteWriter } from '../server/tiles/TilePackSqliteStore';
import { deflateTilePayload, sha256Hex } from '../server/tiles/TileCompression';
import { consolidateRegionalMosaic } from '../server/tiles/OfflineTileConsolidator';
import { createRegionalMosaicHttpHandler } from '../server/tiles/RegionalMosaicHttpHandler';
import type { InspectableFeatureInfo } from '../types/MapFeature';

function makeBoxGeometryData(
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number
): {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
} {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(cx, cy, cz);
  const positions = new Float32Array(g.attributes.position.array as Float32Array);
  const normals = new Float32Array(g.attributes.normal.array as Float32Array);
  const uvs = new Float32Array(g.attributes.uv.array as Float32Array);
  const indices = new Uint16Array(g.index!.array as Uint16Array);
  g.dispose();
  return { positions, normals, uvs, indices };
}

function createSynthetic1024TilePayload(params: {
  tx: number;
  ty: number;
  tileCenterX: number;
  tileCenterZ: number;
  tileSizeMeters: number;
  empty?: boolean;
}): DecodedTilePayload {
  const { tx, ty, tileCenterX, tileCenterZ, tileSizeMeters, empty } = params;
  const half = tileSizeMeters * 0.5;
  if (empty) {
    return {
      formatVersion: OSMTILE1_FORMAT_VERSION,
      flags: TILE_PAYLOAD_FLAG_HAS_BVH,
      lod: 0,
      tx,
      ty,
      tileSizeMeters,
      tileCenterX,
      tileCenterZ,
      overhangBoundsMin: [-half, 0, -half],
      overhangBoundsMax: [half, 0, half],
      totalVertices: 0,
      totalTriangles: 0,
      totalDrawCalls: 0,
      renderedFeaturesCount: 0,
      forestTreesCount: 0,
      sleeper3DBoxCount: 0,
      railwayRenderSource: 'graph-R+',
      byteLength: 0,
      featureInfos: [],
      meshes: [],
      instancedBatches: [],
    };
  }

  const buildingFeature: InspectableFeatureInfo = {
    id: `way/bldg_${tx}_${ty}`,
    sourceFeatureId: `way/bldg_${tx}_${ty}`,
    category: 'Building',
    cartoLabel: 'Apartments',
    primaryTag: 'building=apartments',
    subtype: 'apartments',
    name: `Building ${tx},${ty}`,
    type: 'apartments',
    height: 16,
    levels: 5,
    osmTags: { building: 'apartments', name: `Building ${tx},${ty}` },
  };
  const treeFeature: InspectableFeatureInfo = {
    id: `node/tree_${tx}_${ty}`,
    sourceFeatureId: `node/tree_${tx}_${ty}`,
    category: 'Forest & Woodland',
    cartoLabel: 'Tree',
    primaryTag: 'natural=tree',
    subtype: 'tree',
    name: `Tree ${tx},${ty}`,
    type: 'tree',
    height: 9,
    osmTags: { natural: 'tree' },
  };

  // Place a building centered at local (0, 8, 0) and a cluster of instanced trees at local (+120, 0, +120)
  const bBox = makeBoxGeometryData(0, 8, 0, 32, 16, 24);
  const bBvh = buildTileLocalBvh(bBox.positions, bBox.indices);
  const bTriCount = bBox.indices.length / 3;
  const bMesh: TileMeshRecord = {
    layer: 'buildings',
    name: `bldg_${tx}_${ty}`,
    materialSlotKeys: ['building:default:roof'],
    renderOrder: 10,
    flags:
      TILE_MESH_FLAG_VISIBLE |
      TILE_MESH_FLAG_CAST_SHADOW |
      TILE_MESH_FLAG_RECEIVE_SHADOW |
      TILE_MESH_FLAG_HAS_BVH,
    localPositionOffset: [0, 0, 0],
    bboxMin: [-16, 0, -12],
    bboxMax: [16, 16, 12],
    positions: bBox.positions,
    normals: bBox.normals,
    uvs: bBox.uvs,
    switchAttrs: null,
    colors: null,
    indices: bBox.indices,
    groups: [
      {
        start: 0,
        count: bBox.indices.length,
        materialIndex: 0,
      },
    ],
    faceRanges: [
      {
        startFace: 0,
        endFace: bTriCount,
        infoIdx: 0,
      },
    ],
    singleFeatureIdx: 0,
    bvh: bBvh,
  };

  // Add 12 instanced trees in local coordinates around (+120, 0, +120)
  const treeCount = 12;
  const matrices = new Float32Array(treeCount * 16);
  const featureIndices = new Int32Array(treeCount);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < treeCount; i++) {
    const col = i % 4;
    const row = Math.floor(i / 4);
    dummy.position.set(120 + col * 18, 0, 120 + row * 18);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    matrices.set(dummy.matrix.elements, i * 16);
    featureIndices[i] = 1;
  }

  const instancedBatches: TileInstancedBatchRecord[] = [
    {
      layer: 'foliage',
      name: 'ProceduralForest_BroadleavedCanopy',
      materialSlotKey: 'foliage:broadleaved',
      prototypeKind: 'tree_broadleaved',
      renderOrder: 0,
      flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_CAST_SHADOW,
      bboxMin: [110, 0, 110],
      bboxMax: [190, 12, 175],
      instanceCount: treeCount,
      matrices,
      instanceColors: null,
      instanceFeatureIdxs: featureIndices,
      sleeperBoxes: null,
    },
    {
      layer: 'foliage',
      name: 'ProceduralForest_Trunks',
      materialSlotKey: 'foliage:trunk',
      prototypeKind: 'tree_trunk',
      renderOrder: 0,
      flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_CAST_SHADOW,
      bboxMin: [110, 0, 110],
      bboxMax: [190, 6, 175],
      instanceCount: treeCount,
      matrices: new Float32Array(matrices),
      instanceColors: null,
      instanceFeatureIdxs: new Int32Array(featureIndices),
      sleeperBoxes: null,
    },
  ];

  return {
    formatVersion: OSMTILE1_FORMAT_VERSION,
    flags: TILE_PAYLOAD_FLAG_HAS_BVH,
    lod: 0,
    tx,
    ty,
    tileSizeMeters,
    tileCenterX,
    tileCenterZ,
    overhangBoundsMin: [-half, 0, -half],
    overhangBoundsMax: [half, 18, half],
    totalVertices: bBox.positions.length / 3,
    totalTriangles: bTriCount,
    totalDrawCalls: 3,
    renderedFeaturesCount: 2,
    forestTreesCount: treeCount,
    sleeper3DBoxCount: 0,
    railwayRenderSource: 'graph-R+',
    byteLength: 0,
    featureInfos: [buildingFeature, treeFeature],
    meshes: [bMesh],
    instancedBatches,
  };
}

interface SyntheticHierarchyFixture {
  rootDir: string;
  index1024Path: string;
  index2048Path: string;
  index4096Path: string;
  descriptorPath: string;
  plan1024: ReturnType<typeof createRegionalMosaicPlan>;
}

/**
 * Builds a deterministic 4×4 (4,096 m × 4,096 m) synthetic 1,024 m mosaic with 1 empty
 * corner tile, consolidates it into real 2,048 m (2×2) and 4,096 m (1×1) OSMTILE1 SQLite
 * mosaics using `consolidateRegionalMosaic`, and writes a hierarchical descriptor JSON.
 */
async function buildSynthetic3ResolutionFixture(): Promise<SyntheticHierarchyFixture> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkt041-hier-test-'));
  try {
    return await buildSynthetic3ResolutionFixtureInDir(rootDir);
  } catch (err) {
    fs.rmSync(rootDir, { recursive: true, force: true });
    throw err;
  }
}

async function buildSynthetic3ResolutionFixtureInDir(
  rootDir: string
): Promise<SyntheticHierarchyFixture> {
  const dir1024 = path.join(rootDir, 'mosaic-1024m');
  const dir2048 = path.join(rootDir, 'mosaic-2048m');
  const dir4096 = path.join(rootDir, 'mosaic-4096m');
  fs.mkdirSync(path.join(dir1024, 'shards'), { recursive: true });

  const config1024: RegionalMosaicConfig = {
    name: 'synth-twente-1024m',
    centerLonLat: [6.793, 52.265],
    cols: 4,
    rows: 4,
    tileSizeMeters: 1024,
    shardDimension: 4,
    shardCols: 4,
    shardRows: 4,
    collarMeters: 24,
    contextMarginMeters: 48,
  };
  const plan1024 = createRegionalMosaicPlan(config1024);
  const lodPolicyHash = computeLodPolicyHash({
    projectionId: DEFAULT_PROJECTION_ID,
    tileSizeMeters: 1024,
    collarMeters: 24,
    lod: 0,
    includeBvh: true,
  });

  // Mark one corner tile empty to test partial parent tiles & empty-tile handling
  const emptyKey = `${plan1024.grid.maxTx}:${plan1024.grid.minTy}`;
  const shardRefs: Array<{ id: string; file: string }> = [];

  for (const shard of plan1024.shards) {
    const relFile = `shards/${shard.id}.sqlite`;
    const absFile = path.join(dir1024, relFile);
    const writer = new TilePackSqliteWriter(absFile, {
      snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
      sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
      projectionId: DEFAULT_PROJECTION_ID,
      bakeSchemaVersion: BAKE_SCHEMA_VERSION,
      lodPolicyHash,
      compression: 'deflate',
      tileSizeMeters: 1024,
      collarMeters: 24,
      studyOriginEasting: shard.grid.projection.originEasting,
      studyOriginNorthing: shard.grid.projection.originNorthing,
      gridCols: shard.grid.cols,
      gridRows: shard.grid.rows,
      minTx: shard.grid.minTx,
      maxTx: shard.grid.maxTx,
      minTy: shard.grid.minTy,
      maxTy: shard.grid.maxTy,
      createdAtIso: '2026-11-26T00:00:00.000Z',
    });

    const batchItems = [];
    for (const tile of shard.grid.tiles) {
      const tileCenterX = (tile.localBounds.minX + tile.localBounds.maxX) * 0.5;
      const tileCenterZ = (tile.localBounds.minZ + tile.localBounds.maxZ) * 0.5;
      const isEmpty = `${tile.tx}:${tile.ty}` === emptyKey;
      const payload = createSynthetic1024TilePayload({
        tx: tile.tx,
        ty: tile.ty,
        tileCenterX,
        tileCenterZ,
        tileSizeMeters: 1024,
        empty: isEmpty,
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
    writer.finalize('2026-11-26T00:00:01.000Z');
    shardRefs.push({ id: shard.id, file: relFile });
  }

  const index1024Path = path.join(dir1024, 'mosaic.json');
  const index1024: RegionalMosaicIndex = {
    schemaVersion: 1,
    config: config1024,
    snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
    sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
    shards: shardRefs,
  };
  fs.writeFileSync(index1024Path, JSON.stringify(index1024, null, 2), 'utf8');

  // Consolidate into real 2,048 m and 4,096 m mosaics
  await consolidateRegionalMosaic({
    sourceIndexPath: index1024Path,
    outputDir: dir2048,
    targetTileSizeMeters: 2048,
    mosaicName: 'synth-twente-2048m',
  });
  await consolidateRegionalMosaic({
    sourceIndexPath: index1024Path,
    outputDir: dir4096,
    targetTileSizeMeters: 4096,
    mosaicName: 'synth-twente-4096m',
  });

  const index2048Path = path.join(dir2048, 'mosaic.json');
  const index4096Path = path.join(dir4096, 'mosaic.json');

  const descriptor: HierarchicalRegionalMosaicDescriptor = {
    schemaType: HIERARCHICAL_MOSAIC_SCHEMA_TYPE,
    schemaVersion: HIERARCHICAL_MOSAIC_SCHEMA_VERSION,
    name: 'synth-twente-hierarchical',
    snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
    sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
    projectionId: DEFAULT_PROJECTION_ID,
    levels: [
      { tileSizeMeters: 1024, indexPath: 'mosaic-1024m/mosaic.json' },
      { tileSizeMeters: 2048, indexPath: 'mosaic-2048m/mosaic.json' },
      { tileSizeMeters: 4096, indexPath: 'mosaic-4096m/mosaic.json' },
    ],
  };
  const descriptorPath = path.join(rootDir, 'hierarchical-mosaic.json');
  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2), 'utf8');

  return {
    rootDir,
    index1024Path,
    index2048Path,
    index4096Path,
    descriptorPath,
    plan1024,
  };
}

function getAttachedResolutions(manager: TileStreamManager): Set<number> {
  const attached = new Set<number>();
  const scene = manager.scene;
  const groups = [
    scene.buildingsGroup,
    scene.roadsGroup,
    scene.railwaysGroup,
    scene.waterGroup,
    scene.parksGroup,
    scene.landuseGroup,
    scene.barriersGroup,
    scene.foliageGroup,
  ];
  for (const g of groups) {
    for (const child of g.children) {
      const res = child.userData?.resolutionMeters;
      if (typeof res === 'number') {
        attached.add(res);
      }
    }
  }
  return attached;
}

function startExpressServerForMosaic(indexOrDescriptorPath: string): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  handler: ReturnType<typeof createRegionalMosaicHttpHandler>;
}> {
  const app = express();
  const handler = createRegionalMosaicHttpHandler({
    indexPath: indexOrDescriptorPath,
    maxOpenShardHandles: 4,
  });
  app.get('/api/tiles-region/manifest', handler.manifestHandler);
  app.get(
    '/api/tiles-region/r/:tileSizeMeters/:snapshotId/:schemaVersion/:lod/:tx/:ty',
    handler.tilePayloadHandler
  );
  app.get(
    '/api/tiles-region/r/:tileSizeMeters/:lod/:tx/:ty',
    handler.tilePayloadHandler
  );
  app.get(
    '/api/tiles-region/:snapshotId/:schemaVersion/:lod/:tx/:ty',
    handler.tilePayloadHandler
  );
  app.get('/api/tiles-region/:lod/:tx/:ty', handler.tilePayloadHandler);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api/tiles-region`,
        handler,
        close: async () => {
          handler.close();
          await new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
  });
}

test('TKT-041 Section 5/6: resolution-qualified keys, UTM spatial overlap, and compatibility validation', () => {
  const k1024 = formatHierarchicalTileKey(1024, 340, 5790, 0);
  const k2048 = formatHierarchicalTileKey(2048, 340, 5790, 0);
  assert.notEqual(k1024, k2048);
  assert.deepEqual(parseHierarchicalTileKey(k1024), {
    tileSizeMeters: 1024,
    lod: 0,
    tx: 340,
    ty: 5790,
  });
  assert.equal(parseHierarchicalTileKey('tx_340_ty_5790'), null);

  // Absolute UTM spatial overlap across partial/padded grids
  const childTiles: TileManifestEntry[] = [
    {
      lod: 0,
      tx: 10,
      ty: 20,
      minEasting: 10240,
      maxEasting: 11264,
      minNorthing: 20480,
      maxNorthing: 21504,
      tileCenterX: 0,
      tileCenterZ: 0,
      overhangMinX: -512,
      overhangMaxX: 512,
      overhangMinY: 0,
      overhangMaxY: 10,
      overhangMinZ: -512,
      overhangMaxZ: 512,
      triCount: 12,
      vertexCount: 24,
      featureCount: 1,
      isEmpty: false,
      hasBvh: true,
      rawBytes: 100,
      compressedBytes: 50,
      contentHash: 'a',
    },
    {
      lod: 0,
      tx: 11,
      ty: 20,
      minEasting: 11264,
      maxEasting: 12288,
      minNorthing: 20480,
      maxNorthing: 21504,
      tileCenterX: 1024,
      tileCenterZ: 0,
      overhangMinX: -512,
      overhangMaxX: 512,
      overhangMinY: 0,
      overhangMaxY: 10,
      overhangMinZ: -512,
      overhangMaxZ: 512,
      triCount: 12,
      vertexCount: 24,
      featureCount: 1,
      isEmpty: false,
      hasBvh: true,
      rawBytes: 100,
      compressedBytes: 50,
      contentHash: 'b',
    },
  ];
  const overlapping = findOverlappingTilesByAbsoluteUtm(
    {
      minEasting: 10240,
      maxEasting: 12288,
      minNorthing: 20480,
      maxNorthing: 22528,
    },
    childTiles
  );
  assert.equal(overlapping.length, 2);

  // Compatibility checks: reject mismatched snapshot, projection, SHA, ratio, alignment, disjoint coverage
  const makeMeta = (tileSizeMeters: number, overrides: Partial<any> = {}) => ({
    snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
    sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
    projectionId: DEFAULT_PROJECTION_ID,
    bakeSchemaVersion: BAKE_SCHEMA_VERSION,
    lodPolicyHash: computeLodPolicyHash({
      projectionId: DEFAULT_PROJECTION_ID,
      tileSizeMeters,
      collarMeters: 24,
      lod: 0,
      includeBvh: true,
    }),
    compression: 'deflate' as const,
    tileSizeMeters,
    collarMeters: 24,
    studyOriginEasting: tileSizeMeters === 1024 ? 11264 : 12288, // deliberately different native origins!
    studyOriginNorthing: tileSizeMeters === 1024 ? 21504 : 22528,
    gridCols: 2,
    gridRows: 2,
    minTx: 0,
    maxTx: 1,
    minTy: 0,
    maxTy: 1,
    createdAtIso: '2026-11-26T00:00:00.000Z',
    completedAtIso: '2026-11-26T00:00:01.000Z',
    bakeStatus: 'complete' as const,
    ...overrides,
  });

  const parentTile: TileManifestEntry = {
    ...childTiles[0],
    tx: 5,
    ty: 10,
    minEasting: 10240,
    maxEasting: 12288,
    minNorthing: 20480,
    maxNorthing: 22528,
    tileCenterX: -999, // wrong native center; must be rebased from absolute UTM!
    tileCenterZ: -999,
  };

  const validDesc: HierarchicalRegionalMosaicDescriptor = {
    schemaType: HIERARCHICAL_MOSAIC_SCHEMA_TYPE,
    schemaVersion: HIERARCHICAL_MOSAIC_SCHEMA_VERSION,
    name: 'rebased-test',
    snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
    sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
    projectionId: DEFAULT_PROJECTION_ID,
    levels: [
      { tileSizeMeters: 1024, indexPath: 'a/mosaic.json' },
      { tileSizeMeters: 2048, indexPath: 'b/mosaic.json' },
    ],
  };

  const composed = validateAndComposeHierarchicalManifest(
    validDesc,
    '/tmp/desc.json',
    [
      {
        descriptor: validDesc.levels[0],
        resolvedIndexPath: '/tmp/a/mosaic.json',
        dbSizeBytes: 1000,
        metadata: makeMeta(1024),
        tiles: childTiles,
      },
      {
        descriptor: validDesc.levels[1],
        resolvedIndexPath: '/tmp/b/mosaic.json',
        dbSizeBytes: 500,
        metadata: makeMeta(2048),
        tiles: [parentTile],
      },
    ]
  );

  // Verify 2,048 m level was rebased to canonical 1,024 m origin (11264, 21504)
  assert.equal(composed.hierarchy.canonicalOriginEasting, 11264);
  assert.equal(composed.hierarchy.canonicalOriginNorthing, 21504);
  assert.equal(composed.hierarchy.levels[1].wasOriginRebased, true);
  assert.equal(composed.hierarchy.levels[1].tiles[0].tileCenterX, 0);
  assert.equal(composed.hierarchy.levels[1].tiles[0].tileCenterZ, 0);

  // Reject snapshot mismatch
  assert.throws(
    () =>
      validateAndComposeHierarchicalManifest(validDesc, '/tmp/desc.json', [
        {
          descriptor: validDesc.levels[0],
          resolvedIndexPath: '/tmp/a/mosaic.json',
          dbSizeBytes: 1000,
          metadata: makeMeta(1024),
          tiles: childTiles,
        },
        {
          descriptor: validDesc.levels[1],
          resolvedIndexPath: '/tmp/b/mosaic.json',
          dbSizeBytes: 500,
          metadata: makeMeta(2048, { snapshotId: 'other-snapshot' }),
          tiles: [parentTile],
        },
      ]),
    (err: unknown) =>
      err instanceof HierarchicalMosaicCompatibilityError &&
      err.code === 'HIERARCHY_SNAPSHOT_MISMATCH'
  );

  // Reject projection mismatch
  assert.throws(
    () =>
      validateAndComposeHierarchicalManifest(validDesc, '/tmp/desc.json', [
        {
          descriptor: validDesc.levels[0],
          resolvedIndexPath: '/tmp/a/mosaic.json',
          dbSizeBytes: 1000,
          metadata: makeMeta(1024),
          tiles: childTiles,
        },
        {
          descriptor: validDesc.levels[1],
          resolvedIndexPath: '/tmp/b/mosaic.json',
          dbSizeBytes: 500,
          metadata: makeMeta(2048, { projectionId: 'EPSG:3857' }),
          tiles: [parentTile],
        },
      ]),
    (err: unknown) =>
      err instanceof HierarchicalMosaicCompatibilityError &&
      err.code === 'HIERARCHY_PROJECTION_MISMATCH'
  );

  // Reject disjoint coverage
  assert.throws(
    () =>
      validateAndComposeHierarchicalManifest(validDesc, '/tmp/desc.json', [
        {
          descriptor: validDesc.levels[0],
          resolvedIndexPath: '/tmp/a/mosaic.json',
          dbSizeBytes: 1000,
          metadata: makeMeta(1024),
          tiles: childTiles,
        },
        {
          descriptor: validDesc.levels[1],
          resolvedIndexPath: '/tmp/b/mosaic.json',
          dbSizeBytes: 500,
          metadata: makeMeta(2048),
          tiles: [
            {
              ...parentTile,
              tx: 500,
              ty: 500,
              minEasting: 500 * 2048,
              maxEasting: 501 * 2048,
              minNorthing: 500 * 2048,
              maxNorthing: 501 * 2048,
            },
          ],
        },
      ]),
    (err: unknown) =>
      err instanceof HierarchicalMosaicCompatibilityError &&
      err.code === 'HIERARCHY_COVERAGE_DISJOINT'
  );
});

test('TKT-041 Section 7: zoom policy, hysteresis deadbands, direct 1024<->4096 jumps, viewport compensation, and URL overrides', () => {
  const resolutions = [1024, 2048, 4096];
  const policy = normalizeHierarchicalResolutionPolicy(
    DEFAULT_HIERARCHICAL_RESOLUTION_POLICY
  );

  // 1. Initial nominal selection at reference width 1280px
  assert.equal(
    resolveDesiredHierarchicalResolution({
      availableResolutionsMeters: resolutions,
      currentResolutionMeters: null,
      cameraZoom: 1.5,
      viewportWidthPx: 1280,
      policy,
    }).desiredResolutionMeters,
    1024
  );
  assert.equal(
    resolveDesiredHierarchicalResolution({
      availableResolutionsMeters: resolutions,
      currentResolutionMeters: null,
      cameraZoom: 0.6,
      viewportWidthPx: 1280,
      policy,
    }).desiredResolutionMeters,
    2048
  );
  assert.equal(
    resolveDesiredHierarchicalResolution({
      availableResolutionsMeters: resolutions,
      currentResolutionMeters: null,
      cameraZoom: 0.2,
      viewportWidthPx: 1280,
      policy,
    }).desiredResolutionMeters,
    4096
  );

  // 2. Hysteresis deadband prevents flapping around 0.90 (band 0.80..1.00)
  let current = 1024;
  for (const z of [0.95, 0.88, 0.82, 0.81, 0.92, 0.85]) {
    const res = resolveDesiredHierarchicalResolution({
      availableResolutionsMeters: resolutions,
      currentResolutionMeters: current,
      cameraZoom: z,
      viewportWidthPx: 1280,
      policy,
    });
    assert.equal(res.desiredResolutionMeters, 1024, `zoom ${z} should hold 1024`);
    current = res.desiredResolutionMeters;
  }
  // Cross strictly below 0.80 -> switches to 2048
  const to2048 = resolveDesiredHierarchicalResolution({
    availableResolutionsMeters: resolutions,
    currentResolutionMeters: 1024,
    cameraZoom: 0.78,
    viewportWidthPx: 1280,
    policy,
  });
  assert.equal(to2048.desiredResolutionMeters, 2048);
  // Oscillating in [0.80, 1.00] from 2048 holds 2048
  for (const z of [0.82, 0.90, 0.99]) {
    assert.equal(
      resolveDesiredHierarchicalResolution({
        availableResolutionsMeters: resolutions,
        currentResolutionMeters: 2048,
        cameraZoom: z,
        viewportWidthPx: 1280,
        policy,
      }).desiredResolutionMeters,
      2048
    );
  }
  // Cross strictly above 1.00 -> returns to 1024
  assert.equal(
    resolveDesiredHierarchicalResolution({
      availableResolutionsMeters: resolutions,
      currentResolutionMeters: 2048,
      cameraZoom: 1.02,
      viewportWidthPx: 1280,
      policy,
    }).desiredResolutionMeters,
    1024
  );

  // 3. Direct non-adjacent jumps (1024 -> 4096 and 4096 -> 1024)
  const jumpOut = resolveDesiredHierarchicalResolution({
    availableResolutionsMeters: resolutions,
    currentResolutionMeters: 1024,
    cameraZoom: 0.18,
    viewportWidthPx: 1280,
    policy,
  });
  assert.equal(jumpOut.desiredResolutionMeters, 4096);
  assert.equal(jumpOut.reason, 'direct_zoom_out_jump');

  const jumpIn = resolveDesiredHierarchicalResolution({
    availableResolutionsMeters: resolutions,
    currentResolutionMeters: 4096,
    cameraZoom: 1.6,
    viewportWidthPx: 1280,
    policy,
  });
  assert.equal(jumpIn.desiredResolutionMeters, 1024);
  assert.equal(jumpIn.reason, 'direct_zoom_in_jump');

  // 4. Orthographic viewport width compensation
  const refScale = computeEffectiveOrthographicScale(1.0, 1280, policy);
  const wideScale = computeEffectiveOrthographicScale(1.0, 2560, policy);
  assert.equal(refScale.viewportScaleFactor, 1.0);
  assert.ok(
    wideScale.effectiveScalePxPerMeter < refScale.effectiveScalePxPerMeter,
    'wider viewport should lower effective px/m scale so batching engages earlier'
  );

  // 5. Forced override & URL parsing
  const parsedPolicy = parseHierarchicalPolicyFromSearch(
    '?hierarchicalMode=force_4096&hierarchicalThresholds=0.75,0.95,0.25,0.35&hierarchicalPreloadMeters=512&hierarchicalRetainMeters=1536'
  );
  assert.equal(parsedPolicy?.mode, 'force_4096');
  assert.equal(parsedPolicy?.bands?.[0].zoomOutThreshold, 0.75);
  assert.equal(parsedPolicy?.preloadMarginMeters, 512);
  assert.equal(parsedPolicy?.retainMarginMeters, 1536);

  const parsedBudget = parseHierarchicalBudgetFromSearch(
    '?hierarchicalBudgetMb=512&hierarchicalCacheMb=128&hierarchicalCommitBudgetMs=3.5'
  );
  assert.equal(parsedBudget?.totalMemoryBudgetBytes, 512 * 1024 * 1024);
  assert.equal(parsedBudget?.inactiveCacheBudgetBytes, 128 * 1024 * 1024);
  assert.equal(parsedBudget?.maxCommitBudgetMsPerFrame, 3.5);

  const margins4096 = resolvePhysicalMarginsForResolution(4096, policy);
  assert.equal(margins4096.preloadMarginMeters, 1024);
  assert.equal(margins4096.effectivePreloadMarginTiles, 0.25);
});

test('TKT-041 End-to-End: HTTP multi-resolution server, atomic transitions, zero overlap, canonical picking parity, interruptions, LRU cache, and budget deferral', async () => {
  const fixture = await buildSynthetic3ResolutionFixture();
  const server = await startExpressServerForMosaic(fixture.descriptorPath);

  try {
    // 1. Verify HTTP manifest + resolution-qualified tile routes + bad-param rejection
    const manifestRes = await fetch(`${server.baseUrl}/manifest`);
    assert.equal(manifestRes.status, 200);
    const manifestJson = (await manifestRes.json()) as any;
    assert.equal(manifestJson.available, true);
    assert.ok(manifestJson.hierarchy);
    assert.deepEqual(manifestJson.hierarchy.resolutionsMeters, [1024, 2048, 4096]);
    assert.equal(manifestJson.hierarchy.levels.length, 3);

    // Invalid route parameters must return 400; unknown resolution returns 404
    const badResRoute = await fetch(`${server.baseUrl}/r/abc/0/0/0`);
    assert.equal(badResRoute.status, 400);
    const unknownResRoute = await fetch(`${server.baseUrl}/r/512/0/0/0`);
    assert.equal(unknownResRoute.status, 404);

    // 2. Initialize TileStreamManager at zoom 1.5 (selects 1,024 m)
    const profiler = new StreamingProfiler();
    profiler.setEnabled(true, 'tkt041-e2e');

    let gatePendingResolvers: Array<() => void> = [];
    let gateResolutionMeters: number | null = null;
    let failNextResolutionMeters: number | null = null;
    let failedOnce = false;

    const gatedFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (
        failNextResolutionMeters !== null &&
        !failedOnce &&
        url.includes(`/r/${failNextResolutionMeters}/`)
      ) {
        failedOnce = true;
        return new Response('simulated transient error', { status: 500 });
      }
      if (
        gateResolutionMeters !== null &&
        url.includes(`/r/${gateResolutionMeters}/`)
      ) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            reject(
              Object.assign(new Error('Aborted'), { name: 'AbortError' })
            );
          };
          if (init?.signal?.aborted) {
            onAbort();
            return;
          }
          init?.signal?.addEventListener('abort', onAbort, { once: true });
          gatePendingResolvers.push(() => {
            init?.signal?.removeEventListener('abort', onAbort);
            resolve();
          });
        });
      }
      return fetch(input, init);
    };

    const manager = new TileStreamManager({
      apiBaseUrl: server.baseUrl,
      initialCameraZoom: 1.5,
      fetchFn: gatedFetch,
      profiler,
      tilePreparationOptions: 'combined',
      hierarchicalPolicy: {
        mode: 'auto',
        viewportScaleCompensationEnabled: false,
        preloadMarginMeters: 512,
        retainMarginMeters: 1024,
      },
      hierarchicalBudget: {
        totalMemoryBudgetBytes: 256 * 1024 * 1024,
        inactiveCacheBudgetBytes: 64 * 1024 * 1024,
        maxInactiveCachedTiles: 32,
        maxCommitBudgetMsPerFrame: 100,
      },
    });

    await manager.initialize();
    const initialDiag = manager.getDiagnostics();
    assert.equal(initialDiag.hierarchical?.enabled, true);
    assert.equal(initialDiag.hierarchical?.activeResolutionMeters, 1024);

    // Center viewport over tile (minTx+1, minTy+1)
    const targetTile = fixture.plan1024.grid.tiles.find(
      (t) =>
        t.tx === fixture.plan1024.grid.minTx + 1 &&
        t.ty === fixture.plan1024.grid.minTy + 1
    )!;
    const focusX =
      (targetTile.utmBounds.minEasting + targetTile.utmBounds.maxEasting) * 0.5 -
      manifestJson.hierarchy.canonicalOriginEasting;
    const focusZ =
      manifestJson.hierarchy.canonicalOriginNorthing -
      (targetTile.utmBounds.minNorthing + targetTile.utmBounds.maxNorthing) * 0.5;

    const makeViewport = (
      cx: number,
      cz: number,
      halfSpan: number,
      zoom: number
    ): TileViewportGroundBounds => ({
      minX: cx - halfSpan,
      maxX: cx + halfSpan,
      minZ: cz - halfSpan,
      maxZ: cz + halfSpan,
      focusX: cx,
      focusZ: cz,
      cameraZoom: zoom,
      viewportWidthPx: 1280,
      viewportHeightPx: 720,
    });

    manager.updateViewport(makeViewport(focusX, focusZ, 300, 1.5));
    await manager.waitForIdle();

    // Assert ONLY 1024 m is attached
    assert.deepEqual([...getAttachedResolutions(manager)], [1024]);
    assert.ok(manager.scene.buildingsGroup.children.length > 0);
    assert.ok(manager.scene.foliageGroup.children.length > 0);

    // Helper: pick building at (focusX, focusZ) and tree at (focusX + 120, focusZ + 120)
    const pickFeatureAt = (worldX: number, worldZ: number, layer: 'buildings' | 'foliage') => {
      const raycaster = new THREE.Raycaster(
        new THREE.Vector3(worldX, 120, worldZ),
        new THREE.Vector3(0, -1, 0)
      );
      const group =
        layer === 'buildings'
          ? manager.scene.buildingsGroup
          : manager.scene.foliageGroup;
      const hits = raycaster.intersectObjects(group.children, true);
      assert.ok(hits.length > 0, `Expected raycast hit on ${layer} at (${worldX}, ${worldZ})`);
      const resolved = resolveInspectedFeature(hits[0]);
      return {
        featureId: resolved?.id ?? null,
        point: hits[0].point.clone(),
      };
    };

    const pickBldg1024 = pickFeatureAt(focusX, focusZ, 'buildings');
    const pickTree1024 = pickFeatureAt(focusX + 120, focusZ + 120, 'foliage');
    assert.equal(pickBldg1024.featureId, `way/bldg_${targetTile.tx}_${targetTile.ty}`);
    assert.equal(pickTree1024.featureId, `node/tree_${targetTile.tx}_${targetTile.ty}`);

    // 3. Test gated transition 1,024 -> 2,048: verify ZERO overlap while preparing & NO premature activation
    gateResolutionMeters = 2048;
    manager.updateViewport(makeViewport(focusX, focusZ, 500, 0.6));
    const midDiag = manager.getDiagnostics().hierarchical!;
    assert.equal(midDiag.activeResolutionMeters, 1024);
    assert.equal(midDiag.desiredResolutionMeters, 2048);
    assert.equal(midDiag.pendingResolutionMeters, 2048);
    assert.equal(midDiag.transitionState, 'preparing');
    assert.deepEqual(
      [...getAttachedResolutions(manager)],
      [1024],
      'While preparing 2,048 m, only 1,024 m may be attached'
    );

    // 4. Test interruption: zoom reversal back to 1.5 cancels pending 2,048 m transition!
    manager.updateViewport(makeViewport(focusX, focusZ, 300, 1.5));
    const afterCancelDiag = manager.getDiagnostics().hierarchical!;
    assert.equal(afterCancelDiag.activeResolutionMeters, 1024);
    assert.equal(afterCancelDiag.pendingResolutionMeters, null);
    assert.equal(afterCancelDiag.transitionState, 'idle');
    assert.equal(afterCancelDiag.counters.transitionsCancelled, 1);
    assert.deepEqual([...getAttachedResolutions(manager)], [1024]);
    gatePendingResolvers.splice(0);

    // 5. Test rapid multi-crossing retarget (1024 -> 2048 interrupted -> 4096 directly)
    gateResolutionMeters = 2048;
    manager.updateViewport(makeViewport(focusX, focusZ, 500, 0.6));
    assert.equal(manager.getDiagnostics().hierarchical?.pendingResolutionMeters, 2048);
    // Immediately jump zoom to 0.20 (4,096 m) without waiting for 2,048 m!
    gateResolutionMeters = null;
    manager.updateViewport(makeViewport(focusX, focusZ, 1200, 0.2));
    await manager.waitForIdle();
    const after4096Diag = manager.getDiagnostics().hierarchical!;
    assert.equal(after4096Diag.activeResolutionMeters, 4096);
    assert.equal(after4096Diag.pendingResolutionMeters, null);
    assert.equal(after4096Diag.transitionState, 'idle');
    assert.deepEqual(
      [...getAttachedResolutions(manager)],
      [4096],
      'After atomic activation to 4,096 m, ONLY 4,096 m may be attached'
    );

    // Verify canonical position & picking parity at 4,096 m!
    const pickBldg4096 = pickFeatureAt(focusX, focusZ, 'buildings');
    const pickTree4096 = pickFeatureAt(focusX + 120, focusZ + 120, 'foliage');
    assert.equal(pickBldg4096.featureId, pickBldg1024.featureId);
    assert.equal(pickTree4096.featureId, pickTree1024.featureId);
    assert.ok(
      pickBldg4096.point.distanceTo(pickBldg1024.point) < 1e-3,
      `Building 3D pick delta exceeded 1e-3: 1024=${pickBldg1024.point.toArray()} vs 4096=${pickBldg4096.point.toArray()}`
    );
    const treeHorizDelta4096 = Math.hypot(
      pickTree4096.point.x - pickTree1024.point.x,
      pickTree4096.point.z - pickTree1024.point.z
    );
    assert.ok(
      treeHorizDelta4096 < 1e-3,
      `Tree horizontal (X,Z) delta exceeded 1e-3: 1024=${pickTree1024.point.toArray()} vs 4096=${pickTree4096.point.toArray()}`
    );
    assert.ok(
      Math.abs(pickTree4096.point.y - pickTree1024.point.y) < 1.5,
      `Tree Y delta exceeded foliage LOD canopy tolerance: 1024=${pickTree1024.point.toArray()} vs 4096=${pickTree4096.point.toArray()}`
    );

    // 6. Test failed destination fetch blocks activation until retry succeeds (4096 -> 2048)
    failNextResolutionMeters = 2048;
    failedOnce = false;
    manager.updateViewport(makeViewport(focusX, focusZ, 500, 0.6));
    // Wait for the failed fetch to settle
    await manager.waitForIdle();
    // Because the first 2048 tile errored, transition must NOT have prematurely activated with missing tile!
    const afterErrDiag = manager.getDiagnostics().hierarchical!;
    assert.equal(afterErrDiag.activeResolutionMeters, 4096);
    assert.equal(afterErrDiag.pendingResolutionMeters, 2048);
    // Retry via next viewport evaluation -> now succeeds and activates cleanly!
    manager.updateViewport(makeViewport(focusX, focusZ, 500, 0.6));
    await manager.waitForIdle();
    assert.equal(manager.getDiagnostics().hierarchical?.activeResolutionMeters, 2048);
    assert.deepEqual([...getAttachedResolutions(manager)], [2048]);

    // Verify canonical position & picking parity at 2,048 m too!
    const pickBldg2048 = pickFeatureAt(focusX, focusZ, 'buildings');
    const pickTree2048 = pickFeatureAt(focusX + 120, focusZ + 120, 'foliage');
    assert.equal(pickBldg2048.featureId, pickBldg1024.featureId);
    assert.equal(pickTree2048.featureId, pickTree1024.featureId);
    assert.ok(pickBldg2048.point.distanceTo(pickBldg1024.point) < 1e-3);

    // 7. Test movement during pending transition (2048 -> 1024):
    // Gate 1024, start transition at (focusX, focusZ), pan to far corner before releasing gate ->
    // verify stale initial tiles alone do NOT prematurely activate, and final active set covers new focus!
    const otherTile = fixture.plan1024.grid.tiles.find(
      (t) =>
        t.tx === fixture.plan1024.grid.minTx &&
        t.ty === fixture.plan1024.grid.maxTy
    )!;
    const otherX =
      (otherTile.utmBounds.minEasting + otherTile.utmBounds.maxEasting) * 0.5 -
      manifestJson.hierarchy.canonicalOriginEasting;
    const otherZ =
      manifestJson.hierarchy.canonicalOriginNorthing -
      (otherTile.utmBounds.minNorthing + otherTile.utmBounds.maxNorthing) * 0.5;

    gateResolutionMeters = 1024;
    // Evict cache first so 1024 must fetch
    manager.setHierarchicalBudgetConfig({
      inactiveCacheBudgetBytes: 0,
      maxInactiveCachedTiles: 0,
    });
    manager.updateViewport(makeViewport(focusX, focusZ, 200, 1.5));
    assert.equal(manager.getDiagnostics().hierarchical?.activeResolutionMeters, 2048);
    assert.equal(manager.getDiagnostics().hierarchical?.pendingResolutionMeters, 1024);

    // Pan to other corner while transition is preparing!
    manager.updateViewport(makeViewport(otherX, otherZ, 200, 1.5));
    assert.equal(manager.getDiagnostics().hierarchical?.activeResolutionMeters, 2048);

    // Release gate and wait for idle
    gateResolutionMeters = null;
    for (const r of gatePendingResolvers.splice(0)) r();
    await manager.waitForIdle();
    assert.equal(manager.getDiagnostics().hierarchical?.activeResolutionMeters, 1024);
    assert.deepEqual([...getAttachedResolutions(manager)], [1024]);
    const pickOtherBldg = pickFeatureAt(otherX, otherZ, 'buildings');
    assert.equal(
      pickOtherBldg.featureId,
      `way/bldg_${otherTile.tx}_${otherTile.ty}`
    );

    // 8. Test LRU inactive cache hits & bounded memory over repeated zoom cycles
    manager.setHierarchicalBudgetConfig({
      totalMemoryBudgetBytes: 256 * 1024 * 1024,
      inactiveCacheBudgetBytes: 64 * 1024 * 1024,
      maxInactiveCachedTiles: 32,
    });
    const cacheHitsBefore =
      manager.getDiagnostics().hierarchical!.counters.cacheHits;
    const zoomCycle = [0.6, 0.2, 0.6, 1.5, 0.2, 1.5];
    const measuredSamples: number[] = [];
    for (const z of zoomCycle) {
      manager.updateViewport(makeViewport(focusX, focusZ, z < 0.3 ? 1200 : 400, z));
      await manager.waitForIdle();
      const hd = manager.getDiagnostics().hierarchical!;
      measuredSamples.push(hd.resources.totalMeasuredBytes);
      // Verify single-resolution rendering invariant after every cycle step
      assert.equal(getAttachedResolutions(manager).size, 1);
      // Verify measured vs estimated GPU accounting fields are populated & sane
      assert.ok(hd.resources.totalMeasuredBytes > 0);
      assert.ok(hd.resources.totalEstimatedGpuBytes > 0);
      assert.ok(hd.resources.byResolution.length === 3);
    }
    const cacheHitsAfter =
      manager.getDiagnostics().hierarchical!.counters.cacheHits;
    assert.ok(
      cacheHitsAfter > cacheHitsBefore,
      `Expected warm LRU cache hits across repeated zoom cycles (${cacheHitsBefore} -> ${cacheHitsAfter})`
    );
    // Memory stays bounded (final cycle does not grow monotonically vs max)
    const maxMeasured = Math.max(...measuredSamples);
    assert.ok(maxMeasured <= 256 * 1024 * 1024);

    // 9. Test impossible memory budget deferral (`deferred_budget`) without evicting active visible coverage
    const activeBeforeDefer =
      manager.getDiagnostics().hierarchical!.activeResolutionMeters;
    const activeLoadedBeforeDefer = manager.getDiagnostics().loadedTiles;
    assert.ok(activeLoadedBeforeDefer > 0);
    // Set budget to 1 byte (smaller than active visible + destination required) and disable inactive cache
    manager.setHierarchicalBudgetConfig({
      totalMemoryBudgetBytes: 1,
      inactiveCacheBudgetBytes: 0,
      maxInactiveCachedTiles: 0,
    });
    const targetDeferZoom = activeBeforeDefer === 1024 ? 0.2 : 1.5;
    manager.updateViewport(makeViewport(focusX, focusZ, 400, targetDeferZoom));
    await manager.waitForIdle(); // MUST NOT HANG!
    const deferredDiag = manager.getDiagnostics().hierarchical!;
    assert.equal(deferredDiag.transitionState, 'deferred_budget');
    assert.ok(deferredDiag.budgetDeferralReason !== null);
    assert.ok(deferredDiag.counters.transitionsDeferredBudget >= 1);
    assert.equal(
      deferredDiag.activeResolutionMeters,
      activeBeforeDefer,
      'Active resolution must remain intact when transition is deferred for budget'
    );
    assert.ok(
      manager.getDiagnostics().visibleTiles > 0 &&
        manager.getDiagnostics().loadedTiles > 0,
      'Active visible tiles must NEVER be evicted by an impossible transition budget'
    );

    // Increasing budget recovers cleanly and completes the transition
    manager.setHierarchicalBudgetConfig({
      totalMemoryBudgetBytes: 256 * 1024 * 1024,
      inactiveCacheBudgetBytes: 64 * 1024 * 1024,
      maxInactiveCachedTiles: 32,
    });
    await manager.waitForIdle();
    const recoveredDiag = manager.getDiagnostics().hierarchical!;
    assert.equal(recoveredDiag.transitionState, 'idle');
    assert.equal(
      recoveredDiag.activeResolutionMeters,
      targetDeferZoom < 0.3 ? 4096 : 1024
    );

    // Verify profiler captured hierarchical transition & cache events
    const profSnap = profiler.getSnapshot();
    const eventTypes = new Set(profSnap.events.map((e) => e.eventType));
    assert.ok(eventTypes.has('resolution_transition_start'));
    assert.ok(eventTypes.has('resolution_transition_activate'));
    assert.ok(eventTypes.has('resolution_transition_cancel'));
    assert.ok(eventTypes.has('resolution_transition_defer_budget'));
    assert.ok(eventTypes.has('cache_hit'));

    // 10. Clean disposal leaves zero attached geometry
    manager.dispose();
    assert.equal(manager.scene.buildingsGroup.children.length, 0);
    assert.equal(manager.scene.foliageGroup.children.length, 0);
  } finally {
    await server.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test('TKT-041 Backward Compatibility: single-resolution mosaic still loads without hierarchy extension', async () => {
  const fixture = await buildSynthetic3ResolutionFixture();
  const server = await startExpressServerForMosaic(fixture.index1024Path);

  try {
    const manifestRes = await fetch(`${server.baseUrl}/manifest`);
    assert.equal(manifestRes.status, 200);
    const manifestJson = (await manifestRes.json()) as any;
    assert.equal(manifestJson.hierarchy, undefined);

    const manager = new TileStreamManager({
      apiBaseUrl: server.baseUrl,
      initialCameraZoom: 1.2,
    });
    await manager.initialize();
    assert.equal(manager.isHierarchical, false);
    assert.equal(manager.getDiagnostics().hierarchical, null);

    manager.updateViewport({
      minX: -200,
      maxX: 200,
      minZ: -200,
      maxZ: 200,
      focusX: 0,
      focusZ: 0,
      cameraZoom: 1.2,
    });
    await manager.waitForIdle();
    const diag = manager.getDiagnostics();
    assert.ok(diag.loadedTiles > 0);
    assert.ok(
      diag.loadedTileKeys.every((k) => k.startsWith('tx_')),
      'Single-resolution pack must preserve legacy tx_..._ty_... tile keys'
    );
    manager.dispose();
  } finally {
    await server.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});
