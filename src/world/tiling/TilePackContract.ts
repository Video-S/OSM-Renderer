import type { InspectableFeatureInfo } from '../../types/MapFeature';
import { EPSG_25832_CODE } from './RegionalProjection';

export const OSMTILE1_MAGIC = 'OSMTILE1';
export const OSMTILE1_FORMAT_VERSION = 1;
export const BAKE_SCHEMA_VERSION = '1.0.0';
export const DEFAULT_PROJECTION_ID = EPSG_25832_CODE;

export const CANONICAL_HENGELO_SNAPSHOT_ID = 'overijssel-261114-8ae28196';
export const CANONICAL_HENGELO_SOURCE_SHA256 =
  '8ae281964831675c89f45db6aaa3566168a224767d3313c7068ad255c5f221c0';
export const DEFAULT_TILE_PACK_FILENAME = 'overijssel-tiles-261114-8ae28196.sqlite';

export type TileLayerKind =
  | 'ground'
  | 'buildings'
  | 'roads'
  | 'railways'
  | 'water'
  | 'parks'
  | 'landuse'
  | 'barriers'
  | 'foliage';

export type TilePrototypeKind =
  | 'none'
  | 'tree_trunk'
  | 'tree_broadleaved'
  | 'tree_needleleaved'
  | 'sleeper_box_unit';

export type TileCoordinatePlacementMode = 'tile-local' | 'study-world-mesh-offset';

export type TileCompressionAlgorithm = 'deflate';

export type TileBakeStatus = 'in_progress' | 'complete';

export interface TileMeshGroupRecord {
  start: number;
  count: number;
  materialIndex: number;
}

export interface TileFaceRangeRecord {
  startFace: number;
  endFace: number;
  infoIdx: number;
}

export interface TileSerializedBvhRecord {
  version: number;
  roots: ArrayBuffer[];
  indirectBuffer: Uint16Array | Uint32Array | null;
}

export interface TileMeshRecord {
  layer: TileLayerKind;
  name: string;
  materialSlotKeys: string[];
  renderOrder: number;
  flags: number;
  localPositionOffset: [number, number, number];
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  positions: Float32Array;
  normals: Float32Array | null;
  uvs: Float32Array | null;
  switchAttrs: Float32Array | null;
  colors: Float32Array | null;
  indices: Uint32Array | Uint16Array | null;
  groups: TileMeshGroupRecord[];
  faceRanges: TileFaceRangeRecord[];
  singleFeatureIdx: number; // -1 if none
  bvh: TileSerializedBvhRecord | null;
  chunkKey?: string;
}

export interface TileSleeperBearerBox {
  cx: number;
  cz: number;
  yBottom: number;
  yTop: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  halfLen: number;
  halfWidthLeft: number;
  halfWidthRight: number;
  trackId: string;
}

export interface TileInstancedBatchRecord {
  layer: TileLayerKind;
  name: string;
  materialSlotKey: string;
  prototypeKind: Exclude<TilePrototypeKind, 'none'>;
  renderOrder: number;
  flags: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  instanceCount: number;
  matrices: Float32Array; // 16 * instanceCount
  instanceColors: Float32Array | null; // 3 * instanceCount or null
  instanceFeatureIdxs: Int32Array; // instanceCount (-1 if missing)
  sleeperBoxes: TileSleeperBearerBox[] | null;
  chunkKey?: string;
}

export interface DecodedTilePayload {
  formatVersion: number;
  lod: number;
  tx: number;
  ty: number;
  tileCenterX: number;
  tileCenterZ: number;
  tileSizeMeters: number;
  overhangBoundsMin: [number, number, number];
  overhangBoundsMax: [number, number, number];
  flags: number;
  renderedFeaturesCount: number;
  forestTreesCount: number;
  sleeper3DBoxCount: number;
  totalVertices: number;
  totalTriangles: number;
  totalDrawCalls: number;
  railwayRenderSource: string;
  featureInfos: InspectableFeatureInfo[];
  meshes: TileMeshRecord[];
  instancedBatches: TileInstancedBatchRecord[];
  byteLength: number;
}

export interface TilePackMetadata {
  snapshotId: string;
  sourceSha256: string;
  projectionId: string;
  bakeSchemaVersion: string;
  lodPolicyHash: string;
  compression: TileCompressionAlgorithm;
  tileSizeMeters: number;
  collarMeters: number;
  studyOriginEasting: number;
  studyOriginNorthing: number;
  gridCols: number;
  gridRows: number;
  minTx: number;
  maxTx: number;
  minTy: number;
  maxTy: number;
  bakeStatus: TileBakeStatus;
  createdAtIso: string;
  completedAtIso: string | null;
}

export interface TileManifestEntry {
  lod: number;
  tx: number;
  ty: number;
  minEasting: number;
  maxEasting: number;
  minNorthing: number;
  maxNorthing: number;
  tileCenterX: number;
  tileCenterZ: number;
  overhangMinX: number;
  overhangMaxX: number;
  overhangMinY: number;
  overhangMaxY: number;
  overhangMinZ: number;
  overhangMaxZ: number;
  triCount: number;
  vertexCount: number;
  featureCount: number;
  isEmpty: boolean;
  hasBvh: boolean;
  rawBytes: number;
  compressedBytes: number;
  contentHash: string;
}

export const TILE_MESH_FLAG_VISIBLE = 1 << 0;
export const TILE_MESH_FLAG_CAST_SHADOW = 1 << 1;
export const TILE_MESH_FLAG_RECEIVE_SHADOW = 1 << 2;
export const TILE_MESH_FLAG_FRUSTUM_CULLED = 1 << 3;
export const TILE_MESH_FLAG_STRUCTURAL_3D = 1 << 4;
export const TILE_MESH_FLAG_UNDERGROUND_GEOM = 1 << 5;
export const TILE_MESH_FLAG_UNDERGROUND_TRACE = 1 << 6;
export const TILE_MESH_FLAG_HIDDEN_UNDERGROUND = 1 << 7;
export const TILE_MESH_FLAG_HAS_BVH = 1 << 8;

export const TILE_PAYLOAD_FLAG_HAS_BVH = 1 << 0;

export class TilePackMissingError extends Error {
  constructor(
    message: string,
    public readonly packPath: string
  ) {
    super(message);
    this.name = 'TilePackMissingError';
  }
}

export class TilePackIncompatibleError extends Error {
  constructor(
    message: string,
    public readonly packPath: string,
    public readonly reason: string,
    public readonly expected?: string,
    public readonly actual?: string
  ) {
    super(message);
    this.name = 'TilePackIncompatibleError';
  }
}

export class TilePackCorruptError extends Error {
  constructor(
    message: string,
    public readonly tileKey: string,
    public readonly reason: string
  ) {
    super(message);
    this.name = 'TilePackCorruptError';
  }
}

export function buildCanonicalTileKey(
  snapshotId: string,
  bakeSchemaVersion: string,
  lod: number,
  tx: number,
  ty: number
): string {
  return `${snapshotId}:${bakeSchemaVersion}:${lod}:${tx}:${ty}`;
}

export function computeLodPolicyHash(params: {
  projectionId: string;
  tileSizeMeters: number;
  collarMeters: number;
  lod: number;
  includeBvh: boolean;
}): string {
  const canonical = JSON.stringify({
    projectionId: params.projectionId,
    tileSizeMeters: params.tileSizeMeters,
    collarMeters: params.collarMeters,
    lod: params.lod,
    includeBvh: params.includeBvh,
    bakeSchemaVersion: BAKE_SCHEMA_VERSION,
  });
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < canonical.length; i++) {
    const ch = canonical.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (ch + i) & 0xff;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `lod0-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export function resolveMaterialSlotKeysFromMesh(
  layer: TileLayerKind,
  meshName: string
): string[] {
  const baseName = meshName.split('_chunk_')[0];
  if (layer === 'ground' || baseName === 'GroundPlane') {
    return ['ground'];
  }
  if (layer === 'water' || baseName === 'WaterSurfaces') {
    return ['water'];
  }
  if (baseName === 'Parking_Markings') {
    return ['parking_markings'];
  }
  if (baseName === 'Pitch_Markings') {
    return ['pitch_markings'];
  }
  if (baseName.startsWith('Landuse_')) {
    return [`landuse:${baseName.slice('Landuse_'.length)}`];
  }
  if (baseName.startsWith('ParkSurfaces_')) {
    return [`park:${baseName.slice('ParkSurfaces_'.length)}`];
  }
  if (baseName.startsWith('Roads_')) {
    return [`road:${baseName.slice('Roads_'.length)}`];
  }
  if (baseName === 'Bridge_Substructure' || baseName === 'Bridge_Piers') {
    return ['bridge_substructure'];
  }
  if (baseName === 'Bridge_Parapets') {
    return ['bridge_parapets'];
  }
  if (baseName === 'Tunnel_Portals') {
    return ['tunnel_portals'];
  }
  if (baseName === 'Tunnel_Entrances') {
    return ['tunnel_mouths'];
  }
  if (baseName === 'Tunnel_Underground_Trace') {
    return ['tunnel_traces'];
  }
  if (baseName === 'Tunnel_Underground_Roads') {
    return ['tunnel_underground_roads'];
  }
  if (baseName === 'Tunnel_Underground_Barriers') {
    return ['barrier_underground_wall'];
  }
  if (baseName.startsWith('Barriers_')) {
    return [`barrier:${baseName.slice('Barriers_'.length)}`];
  }
  if (baseName === 'ProceduralForest_Trunks') {
    return ['foliage:trunk'];
  }
  if (baseName === 'ProceduralForest_BroadleavedCanopy') {
    return ['foliage:broadleaved'];
  }
  if (baseName === 'ProceduralForest_NeedleleavedCanopy') {
    return ['foliage:needleleaved'];
  }
  if (baseName === 'PointLandmarks_3D') {
    return ['landmark_point'];
  }
  if (baseName.startsWith('StreetFurniture_')) {
    return [`furniture:${baseName.slice('StreetFurniture_'.length)}`];
  }
  if (baseName.startsWith('Buildings_')) {
    const bucketKey = baseName.slice('Buildings_'.length);
    if (bucketKey === 'default') {
      return ['building:roof:default', 'building:wall:default'];
    }
    if (bucketKey === 'landmark') {
      return ['building:roof:default', 'building:wall:landmark'];
    }
    if (bucketKey.startsWith('arch_')) {
      return [`building:roof:${bucketKey}`, `building:wall:${bucketKey}`];
    }
    return ['building:roof:default', 'building:wall:default'];
  }
  if (baseName === 'Railway_Ballast') {
    return ['railway:ballast'];
  }
  if (baseName === 'Railway_Sleepers') {
    return ['railway:sleepers_uv'];
  }
  if (baseName === 'Railway_Rails') {
    return ['railway:rails_uv'];
  }
  if (baseName === 'Railway_Sleepers_3D') {
    return ['railway:sleepers_3d'];
  }
  if (baseName === 'Railway_Rails_3D') {
    return ['railway:rails_3d'];
  }
  if (baseName === 'Railway_Bridge_Substructure') {
    return ['railway:bridge_substructure'];
  }
  if (baseName === 'Railway_Bridge_Parapets') {
    return ['railway:bridge_parapets'];
  }
  if (baseName === 'Railway_Tunnel_Portals') {
    return ['railway:tunnel_portals'];
  }
  if (baseName === 'Railway_Tunnel_Traces') {
    return ['railway:tunnel_traces'];
  }
  if (baseName === 'Tunnel_Underground_Railway_Ballast') {
    return ['railway:tunnel_ug_ballast'];
  }
  if (baseName === 'Tunnel_Underground_Railway_Sleepers') {
    return ['railway:tunnel_ug_sleepers'];
  }
  if (baseName === 'Tunnel_Underground_Railway_Rails') {
    return ['railway:tunnel_ug_rails'];
  }
  return ['ground'];
}

export function resolvePrototypeKindFromMeshName(meshName: string): TilePrototypeKind {
  const baseName = meshName.split('_chunk_')[0];
  if (baseName === 'ProceduralForest_Trunks') return 'tree_trunk';
  if (baseName === 'ProceduralForest_BroadleavedCanopy') return 'tree_broadleaved';
  if (baseName === 'ProceduralForest_NeedleleavedCanopy') return 'tree_needleleaved';
  if (baseName === 'Railway_Sleepers_3D') return 'sleeper_box_unit';
  return 'none';
}
