import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { InspectableFeatureInfo } from '../../types/MapFeature';
import type { BuiltSceneGeometry, FaceFeatureRange } from '../GeometryBuilder';
import type { SleeperBearerBox3D } from '../infrastructure/railways/RailwayTopology';
import type { TileDescriptor } from './TileGrid';
import {
  OSMTILE1_FORMAT_VERSION,
  OSMTILE1_MAGIC,
  TILE_MESH_FLAG_CAST_SHADOW,
  TILE_MESH_FLAG_FRUSTUM_CULLED,
  TILE_MESH_FLAG_HAS_BVH,
  TILE_MESH_FLAG_HIDDEN_UNDERGROUND,
  TILE_MESH_FLAG_RECEIVE_SHADOW,
  TILE_MESH_FLAG_STRUCTURAL_3D,
  TILE_MESH_FLAG_UNDERGROUND_GEOM,
  TILE_MESH_FLAG_UNDERGROUND_TRACE,
  TILE_MESH_FLAG_VISIBLE,
  TILE_PAYLOAD_FLAG_HAS_BVH,
  TilePackCorruptError,
  resolveMaterialSlotKeysFromMesh,
  resolvePrototypeKindFromMeshName,
  type DecodedTilePayload,
  type TileFaceRangeRecord,
  type TileInstancedBatchRecord,
  type TileLayerKind,
  type TileMeshGroupRecord,
  type TileMeshRecord,
  type TilePrototypeKind,
  type TileSerializedBvhRecord,
  type TileSleeperBearerBox,
} from './TilePackContract';

const HEADER_BYTES = 112;
const CRC_FIELD_OFFSET = 28;
const INVALID_STR_IDX = 0xffffffff;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeOsmTileCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    if (i >= CRC_FIELD_OFFSET && i < CRC_FIELD_OFFSET + 4) {
      continue;
    }
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialCapacity = 16384) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  get length(): number {
    return this.pos;
  }

  private ensure(extra: number): void {
    const needed = this.pos + extra;
    if (needed <= this.buf.length) return;
    let nextCap = this.buf.length * 2;
    while (nextCap < needed) {
      nextCap *= 2;
    }
    const next = new Uint8Array(nextCap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  align4(): void {
    const rem = this.pos & 3;
    if (rem !== 0) {
      const pad = 4 - rem;
      this.ensure(pad);
      this.buf.fill(0, this.pos, this.pos + pad);
      this.pos += pad;
    }
  }

  writeUint8(v: number): void {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  writeUint16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.pos, v >>> 0, true);
    this.pos += 2;
  }

  writeUint32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }

  writeInt32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.pos, v | 0, true);
    this.pos += 4;
  }

  writeFloat32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }

  writeFloat64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  writeRawBytes(src: Uint8Array): void {
    this.ensure(src.byteLength);
    this.buf.set(src, this.pos);
    this.pos += src.byteLength;
  }

  writeAlignedTypedArray(arr: ArrayBufferView | ArrayBuffer): void {
    const view =
      arr instanceof ArrayBuffer
        ? new Uint8Array(arr)
        : new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    this.align4();
    this.writeUint32(view.byteLength);
    this.writeRawBytes(view);
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

class ByteReader {
  private view: DataView;
  public pos = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly tileKey: string
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private assertRemaining(needed: number, context: string): void {
    if (this.pos + needed > this.bytes.byteLength) {
      throw new TilePackCorruptError(
        `Unexpected EOF while reading ${context} (need ${needed} bytes at ${this.pos}, len=${this.bytes.byteLength})`,
        this.tileKey,
        'truncated_payload'
      );
    }
  }

  align4(): void {
    const rem = this.pos & 3;
    if (rem !== 0) {
      const pad = 4 - rem;
      this.assertRemaining(pad, 'align4');
      this.pos += pad;
    }
  }

  readUint8(): number {
    this.assertRemaining(1, 'uint8');
    return this.bytes[this.pos++];
  }

  readUint16(): number {
    this.assertRemaining(2, 'uint16');
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readUint32(): number {
    this.assertRemaining(4, 'uint32');
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readInt32(): number {
    this.assertRemaining(4, 'int32');
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readFloat32(): number {
    this.assertRemaining(4, 'float32');
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readFloat64(): number {
    this.assertRemaining(8, 'float64');
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  readRawSlice(byteLength: number): Uint8Array {
    this.assertRemaining(byteLength, `slice(${byteLength})`);
    const out = this.bytes.slice(this.pos, this.pos + byteLength);
    this.pos += byteLength;
    return out;
  }

  readAlignedArrayBuffer(): ArrayBuffer {
    this.align4();
    const byteLength = this.readUint32();
    const copy = this.readRawSlice(byteLength);
    return copy.buffer;
  }
}

class StringPool {
  private readonly indexByValue = new Map<string, number>();
  private readonly values: string[] = [];

  intern(value: string): number {
    const existing = this.indexByValue.get(value);
    if (existing !== undefined) return existing;
    const idx = this.values.length;
    this.values.push(value);
    this.indexByValue.set(value, idx);
    return idx;
  }

  internOptional(value: string | undefined): number {
    return value === undefined ? INVALID_STR_IDX : this.intern(value);
  }

  get list(): readonly string[] {
    return this.values;
  }
}

const LAYER_ORDER: readonly TileLayerKind[] = [
  'ground',
  'buildings',
  'roads',
  'railways',
  'water',
  'parks',
  'landuse',
  'barriers',
  'foliage',
];

const LAYER_TO_CODE = new Map<TileLayerKind, number>(LAYER_ORDER.map((k, idx) => [k, idx]));

const PROTOTYPE_TO_CODE: Record<Exclude<TilePrototypeKind, 'none'>, number> = {
  tree_trunk: 1,
  tree_broadleaved: 2,
  tree_needleleaved: 3,
  sleeper_box_unit: 4,
};

const CODE_TO_PROTOTYPE: Record<number, Exclude<TilePrototypeKind, 'none'>> = {
  1: 'tree_trunk',
  2: 'tree_broadleaved',
  3: 'tree_needleleaved',
  4: 'sleeper_box_unit',
};

function encodeMeshFlags(obj: THREE.Object3D, hasBvh: boolean): number {
  let flags = 0;
  if (obj.visible) flags |= TILE_MESH_FLAG_VISIBLE;
  if (obj.castShadow) flags |= TILE_MESH_FLAG_CAST_SHADOW;
  if (obj.receiveShadow) flags |= TILE_MESH_FLAG_RECEIVE_SHADOW;
  if (obj.frustumCulled) flags |= TILE_MESH_FLAG_FRUSTUM_CULLED;
  if (obj.userData?.isStructural3D) flags |= TILE_MESH_FLAG_STRUCTURAL_3D;
  if (obj.userData?.isUndergroundTunnelGeometry) flags |= TILE_MESH_FLAG_UNDERGROUND_GEOM;
  if (obj.userData?.isUndergroundTunnelTrace) flags |= TILE_MESH_FLAG_UNDERGROUND_TRACE;
  if (obj.userData?.isHiddenUnderground) flags |= TILE_MESH_FLAG_HIDDEN_UNDERGROUND;
  if (hasBvh) flags |= TILE_MESH_FLAG_HAS_BVH;
  return flags;
}

export function buildTileLocalBvh(
  positions: Float32Array,
  indices: Uint32Array | Uint16Array | null
): TileSerializedBvhRecord | null {
  if (positions.length < 9) return null;
  if (indices && indices.length < 3) return null;
  const tempGeo = new THREE.BufferGeometry();
  tempGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (indices) {
    tempGeo.setIndex(new THREE.BufferAttribute(indices, 1));
  }
  try {
    const bvh = new MeshBVH(tempGeo, { indirect: true });
    const serialized = MeshBVH.serialize(bvh, { cloneBuffers: true }) as {
      version?: number;
      roots: ArrayBuffer[];
      indirectBuffer?: Uint16Array | Uint32Array | null;
    };
    return {
      version: serialized.version ?? 1,
      roots: serialized.roots,
      indirectBuffer: serialized.indirectBuffer ?? null,
    };
  } finally {
    tempGeo.dispose();
  }
}

export function computePositionBBox(
  positions: Float32Array,
  offsetX = 0,
  offsetY = 0,
  offsetZ = 0
): { min: [number, number, number]; max: [number, number, number] } {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] + offsetX;
    const y = positions[i + 1] + offsetY;
    const z = positions[i + 2] + offsetZ;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function extractCompactAttributeFloat32(
  attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined,
  itemSize: number
): Float32Array | null {
  if (!attr) return null;
  if (!('isInterleavedBufferAttribute' in attr) && attr.array instanceof Float32Array && attr.itemSize === itemSize) {
    return attr.array.slice();
  }
  const out = new Float32Array(attr.count * itemSize);
  for (let i = 0; i < attr.count; i++) {
    out[i * itemSize] = attr.getX(i);
    if (itemSize >= 2) out[i * itemSize + 1] = attr.getY(i);
    if (itemSize >= 3) out[i * itemSize + 2] = attr.getZ(i);
    if (itemSize >= 4) out[i * itemSize + 3] = attr.getW(i);
  }
  return out;
}

function extractCompactIndices(
  idxAttr: THREE.BufferAttribute | null,
  vertexCount: number
): Uint32Array | Uint16Array | null {
  if (!idxAttr) return null;
  const maxIdx = vertexCount - 1;
  if (idxAttr.array instanceof Uint16Array && maxIdx <= 65535) {
    return idxAttr.array.slice();
  }
  if (maxIdx <= 65535) {
    const out = new Uint16Array(idxAttr.count);
    for (let i = 0; i < idxAttr.count; i++) {
      out[i] = idxAttr.getX(i);
    }
    return out;
  }
  const out = new Uint32Array(idxAttr.count);
  for (let i = 0; i < idxAttr.count; i++) {
    out[i] = idxAttr.getX(i);
  }
  return out;
}

function extractInspectableInfoDirect(ud: Record<string, unknown>): InspectableFeatureInfo | null {
  if (typeof ud.id !== 'string' || typeof ud.category !== 'string') return null;
  return {
    id: ud.id,
    sourceFeatureId: typeof ud.sourceFeatureId === 'string' ? ud.sourceFeatureId : ud.id,
    sourceFeatureIds: Array.isArray(ud.sourceFeatureIds) ? (ud.sourceFeatureIds as string[]) : undefined,
    name: typeof ud.name === 'string' ? ud.name : ud.id,
    category: ud.category,
    cartoLabel: typeof ud.cartoLabel === 'string' ? ud.cartoLabel : ud.category,
    primaryTag: typeof ud.primaryTag === 'string' ? ud.primaryTag : '',
    subtype: typeof ud.subtype === 'string' ? ud.subtype : '',
    type: typeof ud.type === 'string' ? ud.type : undefined,
    amenity: typeof ud.amenity === 'string' ? ud.amenity : undefined,
    height: typeof ud.height === 'number' ? ud.height : undefined,
    heightFormatted: typeof ud.heightFormatted === 'string' ? ud.heightFormatted : undefined,
    levels: typeof ud.levels === 'number' ? ud.levels : undefined,
    width: typeof ud.width === 'number' ? ud.width : undefined,
    elevation: typeof ud.elevation === 'number' ? ud.elevation : undefined,
    layer: typeof ud.layer === 'number' ? ud.layer : undefined,
    isBridge: typeof ud.isBridge === 'boolean' ? ud.isBridge : undefined,
    isTunnel: typeof ud.isTunnel === 'boolean' ? ud.isTunnel : undefined,
    placementClassification:
      ud.placementClassification as InspectableFeatureInfo['placementClassification'],
    osmTags: (ud.osmTags as Record<string, string | number | boolean>) ?? {},
  };
}

const STRUCTURAL_NON_SURFACE_ROAD_MESH_NAMES = new Set<string>([
  'Bridge_Substructure',
  'Bridge_Piers',
  'Bridge_Parapets',
  'Tunnel_Portals',
  'Tunnel_Entrances',
  'Tunnel_Underground_Trace',
  'Tunnel_Underground_Roads',
]);
const REBASE_MICRO_SLIVER_MAX_AREA_M2 = 1e-3;
const REBASE_MIN_NONDEGENERATE_AREA_M2 = 1e-6;

interface PruneRebasedRoadSliversResult {
  positions: Float32Array;
  normals: Float32Array | null;
  uvs: Float32Array | null;
  switchAttrs: Float32Array | null;
  colors: Float32Array | null;
  indices: Uint32Array | Uint16Array | null;
  groups: TileMeshGroupRecord[];
  faceRanges: TileFaceRangeRecord[];
  prunedTriangles: number;
  prunedVertices: number;
  remainingTriangles: number;
}

function pruneRebasedHorizontalRoadSlivers(params: {
  prePos: Float32Array;
  postPos: Float32Array;
  meshPosX: number;
  meshPosY: number;
  meshPosZ: number;
  normals: Float32Array | null;
  uvs: Float32Array | null;
  switchAttrs: Float32Array | null;
  colors: Float32Array | null;
  indices: Uint32Array | Uint16Array | null;
  groups: TileMeshGroupRecord[];
  faceRanges: TileFaceRangeRecord[];
  featureInfos: readonly InspectableFeatureInfo[];
  directInfo: InspectableFeatureInfo | null;
}): PruneRebasedRoadSliversResult {
  const {
    prePos,
    postPos,
    meshPosX,
    meshPosY,
    meshPosZ,
    normals,
    uvs,
    switchAttrs,
    colors,
    indices,
    groups,
    faceRanges,
    featureInfos,
    directInfo,
  } = params;

  const vertCount = Math.floor(postPos.length / 3);
  const triCount = indices ? Math.floor(indices.length / 3) : Math.floor(vertCount / 3);
  if (triCount <= 0) {
    return {
      positions: postPos,
      normals,
      uvs,
      switchAttrs,
      colors,
      indices,
      groups,
      faceRanges,
      prunedTriangles: 0,
      prunedVertices: 0,
      remainingTriangles: 0,
    };
  }

  const keepFace = new Uint8Array(triCount);
  keepFace.fill(1);
  let droppedCount = 0;
  let rangeCursor = 0;

  for (let f = 0; f < triCount; f++) {
    while (rangeCursor < faceRanges.length && f >= faceRanges[rangeCursor].endFace) {
      rangeCursor++;
    }
    const r =
      rangeCursor < faceRanges.length &&
      f >= faceRanges[rangeCursor].startFace &&
      f < faceRanges[rangeCursor].endFace
        ? faceRanges[rangeCursor]
        : null;
    const faceInfo = r ? featureInfos[r.infoIdx] : directInfo;
    if (faceInfo?.isBridge) {
      continue;
    }

    const i0 = indices ? indices[f * 3] : f * 3;
    const i1 = indices ? indices[f * 3 + 1] : f * 3 + 1;
    const i2 = indices ? indices[f * 3 + 2] : f * 3 + 2;

    const px0 = prePos[i0 * 3] + meshPosX;
    const py0 = prePos[i0 * 3 + 1] + meshPosY;
    const pz0 = prePos[i0 * 3 + 2] + meshPosZ;
    const px1 = prePos[i1 * 3] + meshPosX;
    const py1 = prePos[i1 * 3 + 1] + meshPosY;
    const pz1 = prePos[i1 * 3 + 2] + meshPosZ;
    const px2 = prePos[i2 * 3] + meshPosX;
    const py2 = prePos[i2 * 3 + 1] + meshPosY;
    const pz2 = prePos[i2 * 3 + 2] + meshPosZ;

    if (!faceInfo) {
      const maxY = Math.max(py0, py1, py2);
      const minY = Math.min(py0, py1, py2);
      if (maxY > 0.12 || minY < -0.05) {
        continue;
      }
    }

    const ax0 = px1 - px0;
    const ay0 = py1 - py0;
    const az0 = pz1 - pz0;
    const bx0 = px2 - px0;
    const by0 = py2 - py0;
    const bz0 = pz2 - pz0;
    const cx0 = ay0 * bz0 - az0 * by0;
    const cy0 = az0 * bx0 - ax0 * bz0;
    const cz0 = ax0 * by0 - ay0 * bx0;
    const dPre = Math.hypot(cx0, cy0, cz0);
    const areaPre = dPre * 0.5;
    const nyPre = dPre > 0 ? cy0 / dPre : 0;

    // Never mask pre-existing non-finite or non-degenerate inverted/non-upward triangles
    if (!Number.isFinite(areaPre) || (areaPre > REBASE_MIN_NONDEGENERATE_AREA_M2 && nyPre <= 0.99)) {
      continue;
    }

    const qx0 = postPos[i0 * 3];
    const qy0 = postPos[i0 * 3 + 1];
    const qz0 = postPos[i0 * 3 + 2];
    const qx1 = postPos[i1 * 3];
    const qy1 = postPos[i1 * 3 + 1];
    const qz1 = postPos[i1 * 3 + 2];
    const qx2 = postPos[i2 * 3];
    const qy2 = postPos[i2 * 3 + 1];
    const qz2 = postPos[i2 * 3 + 2];

    const ax1 = qx1 - qx0;
    const ay1 = qy1 - qy0;
    const az1 = qz1 - qz0;
    const bx1 = qx2 - qx0;
    const by1 = qy2 - qy0;
    const bz1 = qz2 - qz0;
    const cx1 = ay1 * bz1 - az1 * by1;
    const cy1 = az1 * bx1 - ax1 * bz1;
    const cz1 = ax1 * by1 - ay1 * bx1;
    const dPost = Math.hypot(cx1, cy1, cz1);
    const areaPost = dPost * 0.5;
    const nyPost = dPost > 0 ? cy1 / dPost : 0;

    const isMicroSliver =
      areaPre <= REBASE_MICRO_SLIVER_MAX_AREA_M2 &&
      (!Number.isFinite(areaPost) || areaPost <= REBASE_MICRO_SLIVER_MAX_AREA_M2);
    const postFailed =
      !Number.isFinite(areaPost) ||
      areaPost <= REBASE_MIN_NONDEGENERATE_AREA_M2 ||
      nyPost <= 0.99;

    if (isMicroSliver && postFailed) {
      keepFace[f] = 0;
      droppedCount++;
    }
  }

  if (droppedCount === 0) {
    return {
      positions: postPos,
      normals,
      uvs,
      switchAttrs,
      colors,
      indices,
      groups,
      faceRanges,
      prunedTriangles: 0,
      prunedVertices: 0,
      remainingTriangles: triCount,
    };
  }

  const keptTriCount = triCount - droppedCount;
  if (keptTriCount === 0) {
    return {
      positions: new Float32Array(0),
      normals: normals ? new Float32Array(0) : null,
      uvs: uvs ? new Float32Array(0) : null,
      switchAttrs: switchAttrs ? new Float32Array(0) : null,
      colors: colors ? new Float32Array(0) : null,
      indices: indices
        ? indices instanceof Uint32Array
          ? new Uint32Array(0)
          : new Uint16Array(0)
        : null,
      groups: [],
      faceRanges: [],
      prunedTriangles: droppedCount,
      prunedVertices: indices ? 0 : droppedCount * 3,
      remainingTriangles: 0,
    };
  }

  const faceRemap = new Int32Array(triCount);
  let nextNewFace = 0;
  for (let f = 0; f < triCount; f++) {
    if (keepFace[f]) {
      faceRemap[f] = nextNewFace++;
    } else {
      faceRemap[f] = -1;
    }
  }

  let newPositions = postPos;
  let newNormals = normals;
  let newUvs = uvs;
  let newSwitchAttrs = switchAttrs;
  let newColors = colors;
  let newIndices = indices;

  if (indices) {
    newIndices =
      indices instanceof Uint32Array
        ? new Uint32Array(keptTriCount * 3)
        : new Uint16Array(keptTriCount * 3);
    for (let f = 0; f < triCount; f++) {
      const nf = faceRemap[f];
      if (nf < 0) continue;
      newIndices[nf * 3] = indices[f * 3];
      newIndices[nf * 3 + 1] = indices[f * 3 + 1];
      newIndices[nf * 3 + 2] = indices[f * 3 + 2];
    }
  } else {
    newPositions = new Float32Array(keptTriCount * 9);
    newNormals = normals ? new Float32Array(keptTriCount * 9) : null;
    newUvs = uvs ? new Float32Array(keptTriCount * 6) : null;
    newSwitchAttrs = switchAttrs ? new Float32Array(keptTriCount * 6) : null;
    newColors = colors ? new Float32Array(keptTriCount * 9) : null;

    for (let f = 0; f < triCount; f++) {
      const nf = faceRemap[f];
      if (nf < 0) continue;
      const src9 = f * 9;
      const dst9 = nf * 9;
      for (let k = 0; k < 9; k++) {
        newPositions[dst9 + k] = postPos[src9 + k];
        if (newNormals && normals) newNormals[dst9 + k] = normals[src9 + k];
        if (newColors && colors) newColors[dst9 + k] = colors[src9 + k];
      }
      if (newUvs && uvs) {
        const src6 = f * 6;
        const dst6 = nf * 6;
        for (let k = 0; k < 6; k++) newUvs[dst6 + k] = uvs[src6 + k];
      }
      if (newSwitchAttrs && switchAttrs) {
        const src6 = f * 6;
        const dst6 = nf * 6;
        for (let k = 0; k < 6; k++) newSwitchAttrs[dst6 + k] = switchAttrs[src6 + k];
      }
    }
  }

  const newFaceRanges: TileFaceRangeRecord[] = [];
  for (const r of faceRanges) {
    const start = Math.max(0, r.startFace);
    const end = Math.min(triCount, r.endFace);
    let minNew = -1;
    let maxNew = -1;
    for (let f = start; f < end; f++) {
      const nf = faceRemap[f];
      if (nf >= 0) {
        if (minNew === -1) minNew = nf;
        maxNew = nf;
      }
    }
    if (minNew !== -1) {
      newFaceRanges.push({
        startFace: minNew,
        endFace: maxNew + 1,
        infoIdx: r.infoIdx,
      });
    }
  }

  const newGroups: TileMeshGroupRecord[] = [];
  for (const g of groups) {
    const startTri = Math.max(0, Math.floor(g.start / 3));
    const endTri = Math.min(triCount, Math.floor((g.start + g.count) / 3));
    let minNew = -1;
    let maxNew = -1;
    for (let f = startTri; f < endTri; f++) {
      const nf = faceRemap[f];
      if (nf >= 0) {
        if (minNew === -1) minNew = nf;
        maxNew = nf;
      }
    }
    if (minNew !== -1) {
      newGroups.push({
        start: minNew * 3,
        count: (maxNew - minNew + 1) * 3,
        materialIndex: g.materialIndex,
      });
    }
  }

  return {
    positions: newPositions,
    normals: newNormals,
    uvs: newUvs,
    switchAttrs: newSwitchAttrs,
    colors: newColors,
    indices: newIndices,
    groups: newGroups,
    faceRanges: newFaceRanges,
    prunedTriangles: droppedCount,
    prunedVertices: indices ? 0 : droppedCount * 3,
    remainingTriangles: keptTriCount,
  };
}

export interface EncodeTileBinaryOptions {
  tile: TileDescriptor;
  scene: BuiltSceneGeometry;
  lod?: number;
  includeBvh?: boolean;
}

export function encodeBuiltTileToBinary(options: EncodeTileBinaryOptions): Uint8Array {
  const { tile, scene, lod = 0, includeBvh = true } = options;
  const tileCenterX = (tile.localBounds.minX + tile.localBounds.maxX) * 0.5;
  const tileCenterZ = (tile.localBounds.minZ + tile.localBounds.maxZ) * 0.5;
  const tileSizeMeters = tile.localBounds.maxX - tile.localBounds.minX;

  const featureInfos: InspectableFeatureInfo[] = [];
  const featureIndexByObj = new WeakMap<InspectableFeatureInfo, number>();
  const featureIndexByKey = new Map<string, number>();

  const internFeatureInfo = (info: InspectableFeatureInfo): number => {
    const byRef = featureIndexByObj.get(info);
    if (byRef !== undefined) return byRef;
    const canonicalKey = JSON.stringify([
      info.id,
      info.sourceFeatureId ?? '',
      info.category,
      info.subtype ?? '',
      info.primaryTag ?? '',
      info.elevation ?? '',
      info.layer ?? '',
    ]);
    const byKey = featureIndexByKey.get(canonicalKey);
    if (byKey !== undefined) {
      featureIndexByObj.set(info, byKey);
      return byKey;
    }
    const idx = featureInfos.length;
    featureInfos.push(info);
    featureIndexByObj.set(info, idx);
    featureIndexByKey.set(canonicalKey, idx);
    return idx;
  };

  const meshRecords: TileMeshRecord[] = [];
  const instancedRecords: TileInstancedBatchRecord[] = [];
  let totalPrunedTriangles = 0;
  let totalPrunedVertices = 0;

  let overMinX = Infinity;
  let overMinY = Infinity;
  let overMinZ = Infinity;
  let overMaxX = -Infinity;
  let overMaxY = -Infinity;
  let overMaxZ = -Infinity;

  const expandOverhang = (bmin: [number, number, number], bmax: [number, number, number]) => {
    if (bmin[0] < overMinX) overMinX = bmin[0];
    if (bmin[1] < overMinY) overMinY = bmin[1];
    if (bmin[2] < overMinZ) overMinZ = bmin[2];
    if (bmax[0] > overMaxX) overMaxX = bmax[0];
    if (bmax[1] > overMaxY) overMaxY = bmax[1];
    if (bmax[2] > overMaxZ) overMaxZ = bmax[2];
  };

  const collectLayer = (layer: TileLayerKind, root: THREE.Object3D) => {
    root.traverse((obj) => {
      if ((obj as THREE.InstancedMesh).isInstancedMesh) {
        const inst = obj as THREE.InstancedMesh;
        const protoKind = resolvePrototypeKindFromMeshName(inst.name);
        if (protoKind === 'none') return;
        const count = inst.count;
        if (count <= 0) return;

        const matrices = new Float32Array(count * 16);
        const srcArr = inst.instanceMatrix.array;
        for (let i = 0; i < count; i++) {
          const base = i * 16;
          for (let k = 0; k < 16; k++) {
            matrices[base + k] = srcArr[base + k];
          }
          matrices[base + 12] += inst.position.x - tileCenterX;
          matrices[base + 13] += inst.position.y;
          matrices[base + 14] += inst.position.z - tileCenterZ;
        }

        const instanceColors = inst.instanceColor
          ? new Float32Array(inst.instanceColor.array.subarray(0, count * 3))
          : null;

        const rawInfos = inst.userData?.instanceInfos as InspectableFeatureInfo[] | undefined;
        const instanceFeatureIdxs = new Int32Array(count);
        for (let i = 0; i < count; i++) {
          const inf = rawInfos?.[i];
          instanceFeatureIdxs[i] = inf ? internFeatureInfo(inf) : -1;
        }

        const rawBoxes = inst.userData?.instanceBoxes as SleeperBearerBox3D[] | undefined;
        let sleeperBoxes: TileSleeperBearerBox[] | null = null;
        if (Array.isArray(rawBoxes) && rawBoxes.length === count) {
          sleeperBoxes = rawBoxes.map((b) => ({
            cx: b.cx + inst.position.x - tileCenterX,
            cz: b.cz + inst.position.z - tileCenterZ,
            yBottom: b.yBottom + inst.position.y,
            yTop: b.yTop + inst.position.y,
            tx: b.tx,
            tz: b.tz,
            nx: b.nx,
            nz: b.nz,
            halfLen: b.halfLen,
            halfWidthLeft: b.halfWidthLeft,
            halfWidthRight: b.halfWidthRight,
            trackId: b.trackId,
          }));
        }

        let bmin: [number, number, number] = [0, 0, 0];
        let bmax: [number, number, number] = [0, 0, 0];
        if (inst.boundingBox) {
          bmin = [
            inst.boundingBox.min.x + inst.position.x - tileCenterX,
            inst.boundingBox.min.y + inst.position.y,
            inst.boundingBox.min.z + inst.position.z - tileCenterZ,
          ];
          bmax = [
            inst.boundingBox.max.x + inst.position.x - tileCenterX,
            inst.boundingBox.max.y + inst.position.y,
            inst.boundingBox.max.z + inst.position.z - tileCenterZ,
          ];
        } else {
          let x0 = Infinity;
          let y0 = Infinity;
          let z0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          let z1 = -Infinity;
          for (let i = 0; i < count; i++) {
            const tx = matrices[i * 16 + 12];
            const ty = matrices[i * 16 + 13];
            const tz = matrices[i * 16 + 14];
            if (tx - 4 < x0) x0 = tx - 4;
            if (tx + 4 > x1) x1 = tx + 4;
            if (ty - 2 < y0) y0 = ty - 2;
            if (ty + 10 > y1) y1 = ty + 10;
            if (tz - 4 < z0) z0 = tz - 4;
            if (tz + 4 > z1) z1 = tz + 4;
          }
          if (Number.isFinite(x0)) {
            bmin = [x0, y0, z0];
            bmax = [x1, y1, z1];
          }
        }
        expandOverhang(bmin, bmax);

        const slotKeys = resolveMaterialSlotKeysFromMesh(layer, inst.name);
        instancedRecords.push({
          layer,
          name: inst.name,
          materialSlotKey: slotKeys[0],
          prototypeKind: protoKind,
          renderOrder: inst.renderOrder,
          flags: encodeMeshFlags(inst, false),
          bboxMin: bmin,
          bboxMax: bmax,
          instanceCount: count,
          matrices,
          instanceColors,
          instanceFeatureIdxs,
          sleeperBoxes,
          chunkKey: typeof inst.userData?.chunkKey === 'string' ? inst.userData.chunkKey : undefined,
        });
        return;
      }

      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const geo = mesh.geometry as THREE.BufferGeometry | undefined;
        if (!geo) return;
        const posAttr = geo.getAttribute('position') as
          | THREE.BufferAttribute
          | THREE.InterleavedBufferAttribute
          | undefined;
        if (!posAttr || posAttr.count === 0) return;

        const rawPos = extractCompactAttributeFloat32(posAttr, 3);
        if (!rawPos) return;

        const dx = mesh.position.x - tileCenterX;
        const dy = mesh.position.y;
        const dz = mesh.position.z - tileCenterZ;
        const isGround = layer === 'ground' || mesh.name === 'GroundPlane';

        const isRebasedHorizontalRoad =
          layer === 'roads' &&
          !isGround &&
          (dx !== 0 || dz !== 0) &&
          !STRUCTURAL_NON_SURFACE_ROAD_MESH_NAMES.has(mesh.name) &&
          mesh.name !== 'Roads_bridge';
        const prePos = isRebasedHorizontalRoad ? rawPos.slice() : null;

        let localPositionOffset: [number, number, number];
        if (isGround) {
          localPositionOffset = [dx, dy, dz];
        } else {
          for (let i = 0; i < rawPos.length; i += 3) {
            rawPos[i] += dx;
            rawPos[i + 2] += dz;
          }
          localPositionOffset = [0, dy, 0];
        }

        let finalPositions = rawPos;
        let normals = extractCompactAttributeFloat32(
          geo.getAttribute('normal') as THREE.BufferAttribute | undefined,
          3
        );
        let uvs = extractCompactAttributeFloat32(
          geo.getAttribute('uv') as THREE.BufferAttribute | undefined,
          2
        );
        let switchAttrs = extractCompactAttributeFloat32(
          geo.getAttribute('aSwitchAttr') as THREE.BufferAttribute | undefined,
          2
        );
        let colors = extractCompactAttributeFloat32(
          geo.getAttribute('color') as THREE.BufferAttribute | undefined,
          3
        );
        let indices = extractCompactIndices(geo.getIndex(), posAttr.count);

        let groups: TileMeshGroupRecord[] = geo.groups.map((g) => ({
          start: g.start,
          count: g.count,
          materialIndex: g.materialIndex ?? 0,
        }));

        const rawRanges = mesh.userData?.faceRanges as FaceFeatureRange[] | undefined;
        let faceRanges: TileFaceRangeRecord[] = Array.isArray(rawRanges)
          ? rawRanges.map((r) => ({
              startFace: r.startFace,
              endFace: r.endFace,
              infoIdx: internFeatureInfo(r.info),
            }))
          : [];

        const directInfo = extractInspectableInfoDirect(mesh.userData || {});
        const singleFeatureIdx = directInfo ? internFeatureInfo(directInfo) : -1;

        if (prePos) {
          const pruned = pruneRebasedHorizontalRoadSlivers({
            prePos,
            postPos: finalPositions,
            meshPosX: mesh.position.x,
            meshPosY: mesh.position.y,
            meshPosZ: mesh.position.z,
            normals,
            uvs,
            switchAttrs,
            colors,
            indices,
            groups,
            faceRanges,
            featureInfos,
            directInfo,
          });
          if (pruned.prunedTriangles > 0) {
            totalPrunedTriangles += pruned.prunedTriangles;
            totalPrunedVertices += pruned.prunedVertices;
            if (pruned.remainingTriangles === 0) {
              return;
            }
            finalPositions = pruned.positions;
            normals = pruned.normals;
            uvs = pruned.uvs;
            switchAttrs = pruned.switchAttrs;
            colors = pruned.colors;
            indices = pruned.indices;
            groups = pruned.groups;
            faceRanges = pruned.faceRanges;
          }
        }

        const bbox = computePositionBBox(finalPositions);
        const worldCheckMin: [number, number, number] = [
          bbox.min[0] + localPositionOffset[0],
          bbox.min[1] + localPositionOffset[1],
          bbox.min[2] + localPositionOffset[2],
        ];
        const worldCheckMax: [number, number, number] = [
          bbox.max[0] + localPositionOffset[0],
          bbox.max[1] + localPositionOffset[1],
          bbox.max[2] + localPositionOffset[2],
        ];
        if (!isGround) {
          expandOverhang(worldCheckMin, worldCheckMax);
        }

        const bvh = includeBvh ? buildTileLocalBvh(finalPositions, indices) : null;
        const materialSlotKeys = resolveMaterialSlotKeysFromMesh(layer, mesh.name);

        meshRecords.push({
          layer,
          name: mesh.name,
          materialSlotKeys,
          renderOrder: mesh.renderOrder,
          flags: encodeMeshFlags(mesh, bvh !== null),
          localPositionOffset,
          bboxMin: bbox.min,
          bboxMax: bbox.max,
          positions: finalPositions,
          normals,
          uvs,
          switchAttrs,
          colors,
          indices,
          groups,
          faceRanges,
          singleFeatureIdx,
          bvh,
          chunkKey: typeof mesh.userData?.chunkKey === 'string' ? mesh.userData.chunkKey : undefined,
        });
      }
    });
  };

  collectLayer('ground', scene.groundMesh);
  collectLayer('buildings', scene.buildingsGroup);
  collectLayer('roads', scene.roadsGroup);
  collectLayer('railways', scene.railwaysGroup);
  collectLayer('water', scene.waterGroup);
  collectLayer('parks', scene.parksGroup);
  collectLayer('landuse', scene.landuseGroup);
  collectLayer('barriers', scene.barriersGroup);
  collectLayer('foliage', scene.foliageGroup);

  if (!Number.isFinite(overMinX)) {
    const half = tileSizeMeters * 0.5;
    overMinX = -half;
    overMaxX = half;
    overMinY = -0.05;
    overMaxY = 0.05;
    overMinZ = -half;
    overMaxZ = half;
  }

  const railStats = scene.railwaysGroup.userData?.railwayStats as
    | { sleeper3DBoxCount?: number; railwayRenderSource?: string }
    | undefined;
  const sleeper3DBoxCount = railStats?.sleeper3DBoxCount ?? 0;
  const railwayRenderSource = railStats?.railwayRenderSource ?? 'graph-R+';
  const adjustedTotalVertices = Math.max(0, scene.stats.totalVertices - totalPrunedVertices);
  const adjustedTotalTriangles = Math.max(0, scene.stats.totalTriangles - totalPrunedTriangles);

  return encodeDecodedTilePayloadToBinary({
    formatVersion: OSMTILE1_FORMAT_VERSION,
    flags: includeBvh ? TILE_PAYLOAD_FLAG_HAS_BVH : 0,
    lod,
    tx: tile.tx,
    ty: tile.ty,
    byteLength: 0,
    renderedFeaturesCount: scene.stats.renderedFeaturesCount,
    forestTreesCount: scene.stats.forestTreesCount ?? 0,
    sleeper3DBoxCount,
    totalVertices: adjustedTotalVertices,
    totalTriangles: adjustedTotalTriangles,
    totalDrawCalls: scene.stats.totalDrawCalls,
    tileCenterX,
    tileCenterZ,
    tileSizeMeters,
    overhangBoundsMin: [overMinX, overMinY, overMinZ],
    overhangBoundsMax: [overMaxX, overMaxY, overMaxZ],
    railwayRenderSource,
    featureInfos,
    meshes: meshRecords,
    instancedBatches: instancedRecords,
  });
}

/**
 * Serializes a DecodedTilePayload directly into the canonical OSMTILE1 v1 binary
 * format with CRC32 checksum. Used both by encodeBuiltTileToBinary and by the
 * standalone offline spatial batching consolidator (TKT-037).
 */
export function encodeDecodedTilePayloadToBinary(payload: DecodedTilePayload): Uint8Array {
  const { featureInfos, meshes: meshRecords, instancedBatches: instancedRecords } = payload;
  const strings = new StringPool();
  const railwayRenderSourceStrIdx = strings.intern(payload.railwayRenderSource || 'graph-R+');

  // Pre-intern all strings referenced by feature infos, meshes, and instanced batches
  const encodedMeshStrings = meshRecords.map((m) => ({
    nameIdx: strings.intern(m.name),
    chunkKeyIdx: strings.internOptional(m.chunkKey),
    slotKeyIdxs: m.materialSlotKeys.map((k) => strings.intern(k)),
  }));
  const encodedInstStrings = instancedRecords.map((b) => ({
    nameIdx: strings.intern(b.name),
    slotKeyIdx: strings.intern(b.materialSlotKey),
    chunkKeyIdx: strings.internOptional(b.chunkKey),
    sleeperTrackIdxs: b.sleeperBoxes ? b.sleeperBoxes.map((sb) => strings.intern(sb.trackId)) : null,
  }));

  const encodedInfos = featureInfos.map((info) => {
    const tagEntries: Array<{ keyIdx: number; valueType: 0 | 1 | 2; value: string | number | boolean }> =
      [];
    if (info.osmTags) {
      for (const [k, v] of Object.entries(info.osmTags)) {
        if (typeof v === 'string') {
          tagEntries.push({ keyIdx: strings.intern(k), valueType: 0, value: strings.intern(v) });
        } else if (typeof v === 'number' && Number.isFinite(v)) {
          tagEntries.push({ keyIdx: strings.intern(k), valueType: 1, value: v });
        } else if (typeof v === 'boolean') {
          tagEntries.push({ keyIdx: strings.intern(k), valueType: 2, value: v });
        }
      }
    }
    const placementJsonIdx = info.placementClassification
      ? strings.intern(JSON.stringify(info.placementClassification))
      : INVALID_STR_IDX;

    return {
      idIdx: strings.intern(info.id),
      sourceFeatureIdIdx: strings.intern(info.sourceFeatureId),
      sourceFeatureIdIdxs: (info.sourceFeatureIds ?? []).map((s) => strings.intern(s)),
      nameIdx: strings.internOptional(info.name),
      categoryIdx: strings.intern(info.category),
      cartoLabelIdx: strings.intern(info.cartoLabel),
      primaryTagIdx: strings.intern(info.primaryTag),
      subtypeIdx: strings.intern(info.subtype),
      typeIdx: strings.internOptional(info.type),
      amenityIdx: strings.internOptional(info.amenity),
      heightFormattedIdx: strings.internOptional(info.heightFormatted),
      placementJsonIdx,
      tagEntries,
      info,
    };
  });

  const hasBvh =
    (payload.flags & TILE_PAYLOAD_FLAG_HAS_BVH) !== 0 ||
    meshRecords.some((m) => m.bvh !== null);
  const payloadFlags = hasBvh
    ? payload.flags | TILE_PAYLOAD_FLAG_HAS_BVH
    : payload.flags & ~TILE_PAYLOAD_FLAG_HAS_BVH;

  const writer = new ByteWriter(32768);
  const magicBytes = textEncoder.encode(OSMTILE1_MAGIC);
  writer.writeRawBytes(magicBytes); // 0..8
  writer.writeUint32(OSMTILE1_FORMAT_VERSION); // 8..12
  writer.writeUint32(payloadFlags); // 12..16
  writer.writeUint32(payload.lod); // 16..20
  writer.writeInt32(payload.tx); // 20..24
  writer.writeInt32(payload.ty); // 24..28
  writer.writeUint32(0); // 28..32 CRC32 placeholder
  writer.writeUint32(0); // 32..36 totalByteLength placeholder
  writer.writeUint32(payload.renderedFeaturesCount); // 36..40
  writer.writeUint32(payload.forestTreesCount); // 40..44
  writer.writeUint32(payload.sleeper3DBoxCount); // 44..48
  writer.writeUint32(payload.totalVertices); // 48..52
  writer.writeUint32(payload.totalTriangles); // 52..56
  writer.writeUint32(payload.totalDrawCalls); // 56..60
  writer.writeUint32(meshRecords.length); // 60..64
  writer.writeFloat64(payload.tileCenterX); // 64..72
  writer.writeFloat64(payload.tileCenterZ); // 72..80
  writer.writeFloat64(payload.tileSizeMeters); // 80..88
  writer.writeFloat32(payload.overhangBoundsMin[0]); // 88..92
  writer.writeFloat32(payload.overhangBoundsMin[1]); // 92..96
  writer.writeFloat32(payload.overhangBoundsMin[2]); // 96..100
  writer.writeFloat32(payload.overhangBoundsMax[0]); // 100..104
  writer.writeFloat32(payload.overhangBoundsMax[1]); // 104..108
  writer.writeFloat32(payload.overhangBoundsMax[2]); // 108..112

  writer.writeUint32(instancedRecords.length);
  writer.writeUint32(railwayRenderSourceStrIdx);

  // 1. String pool
  const strList = strings.list;
  writer.writeUint32(strList.length);
  for (const s of strList) {
    const encoded = textEncoder.encode(s);
    writer.writeUint32(encoded.byteLength);
    writer.writeRawBytes(encoded);
  }

  // 2. Feature info table
  writer.writeUint32(encodedInfos.length);
  for (const entry of encodedInfos) {
    const { info } = entry;
    writer.writeUint32(entry.idIdx);
    writer.writeUint32(entry.sourceFeatureIdIdx);
    writer.writeUint32(entry.nameIdx);
    writer.writeUint32(entry.categoryIdx);
    writer.writeUint32(entry.cartoLabelIdx);
    writer.writeUint32(entry.primaryTagIdx);
    writer.writeUint32(entry.subtypeIdx);
    writer.writeUint32(entry.typeIdx);
    writer.writeUint32(entry.amenityIdx);
    writer.writeUint32(entry.heightFormattedIdx);
    writer.writeUint32(entry.placementJsonIdx);

    writer.writeUint16(entry.sourceFeatureIdIdxs.length);
    for (const sIdx of entry.sourceFeatureIdIdxs) {
      writer.writeUint32(sIdx);
    }

    let numMask = 0;
    if (info.height !== undefined) numMask |= 1 << 0;
    if (info.levels !== undefined) numMask |= 1 << 1;
    if (info.width !== undefined) numMask |= 1 << 2;
    if (info.elevation !== undefined) numMask |= 1 << 3;
    if (info.layer !== undefined) numMask |= 1 << 4;
    if (info.isBridge !== undefined) numMask |= 1 << 5;
    if (info.isTunnel !== undefined) numMask |= 1 << 6;
    writer.writeUint16(numMask);

    let boolBits = 0;
    if (info.isBridge) boolBits |= 1 << 0;
    if (info.isTunnel) boolBits |= 1 << 1;
    writer.writeUint8(boolBits);

    if (info.height !== undefined) writer.writeFloat32(info.height);
    if (info.levels !== undefined) writer.writeInt32(info.levels);
    if (info.width !== undefined) writer.writeFloat32(info.width);
    if (info.elevation !== undefined) writer.writeFloat32(info.elevation);
    if (info.layer !== undefined) writer.writeInt32(info.layer);

    writer.writeUint16(entry.tagEntries.length);
    for (const tag of entry.tagEntries) {
      writer.writeUint32(tag.keyIdx);
      writer.writeUint8(tag.valueType);
      if (tag.valueType === 0) {
        writer.writeUint32(tag.value as number);
      } else if (tag.valueType === 1) {
        writer.writeFloat64(tag.value as number);
      } else {
        writer.writeUint8(tag.value ? 1 : 0);
      }
    }
  }

  // 3. Static meshes
  for (let i = 0; i < meshRecords.length; i++) {
    const m = meshRecords[i];
    const ms = encodedMeshStrings[i];
    writer.writeUint8(LAYER_TO_CODE.get(m.layer) ?? 0);
    writer.writeUint32(ms.nameIdx);
    writer.writeUint32(ms.chunkKeyIdx);
    writer.writeInt32(m.renderOrder);
    writer.writeUint32(m.flags);
    writer.writeFloat32(m.localPositionOffset[0]);
    writer.writeFloat32(m.localPositionOffset[1]);
    writer.writeFloat32(m.localPositionOffset[2]);
    writer.writeFloat32(m.bboxMin[0]);
    writer.writeFloat32(m.bboxMin[1]);
    writer.writeFloat32(m.bboxMin[2]);
    writer.writeFloat32(m.bboxMax[0]);
    writer.writeFloat32(m.bboxMax[1]);
    writer.writeFloat32(m.bboxMax[2]);
    writer.writeInt32(m.singleFeatureIdx);

    writer.writeUint8(ms.slotKeyIdxs.length);
    for (const skIdx of ms.slotKeyIdxs) {
      writer.writeUint32(skIdx);
    }

    let attrMask = 0;
    if (m.normals) attrMask |= 1 << 0;
    if (m.uvs) attrMask |= 1 << 1;
    if (m.switchAttrs) attrMask |= 1 << 2;
    if (m.colors) attrMask |= 1 << 3;
    if (m.indices) {
      attrMask |= 1 << 4;
      if (m.indices instanceof Uint32Array) attrMask |= 1 << 5;
    }
    if (m.bvh) attrMask |= 1 << 6;
    writer.writeUint8(attrMask);

    writer.writeAlignedTypedArray(m.positions);
    if (m.normals) writer.writeAlignedTypedArray(m.normals);
    if (m.uvs) writer.writeAlignedTypedArray(m.uvs);
    if (m.switchAttrs) writer.writeAlignedTypedArray(m.switchAttrs);
    if (m.colors) writer.writeAlignedTypedArray(m.colors);
    if (m.indices) writer.writeAlignedTypedArray(m.indices);

    writer.writeUint32(m.groups.length);
    for (const g of m.groups) {
      writer.writeUint32(g.start);
      writer.writeUint32(g.count);
      writer.writeUint16(g.materialIndex);
    }

    writer.writeUint32(m.faceRanges.length);
    for (const fr of m.faceRanges) {
      writer.writeUint32(fr.startFace);
      writer.writeUint32(fr.endFace);
      writer.writeInt32(fr.infoIdx);
    }

    if (m.bvh) {
      writer.writeUint16(m.bvh.version);
      writer.writeUint16(m.bvh.roots.length);
      for (const r of m.bvh.roots) {
        writer.writeAlignedTypedArray(r);
      }
      const indirectKind = m.bvh.indirectBuffer
        ? m.bvh.indirectBuffer instanceof Uint32Array
          ? 2
          : 1
        : 0;
      writer.writeUint8(indirectKind);
      if (m.bvh.indirectBuffer) {
        writer.writeAlignedTypedArray(m.bvh.indirectBuffer);
      }
    }
  }

  // 4. Instanced batches
  for (let i = 0; i < instancedRecords.length; i++) {
    const b = instancedRecords[i];
    const bs = encodedInstStrings[i];
    writer.writeUint8(LAYER_TO_CODE.get(b.layer) ?? 0);
    writer.writeUint32(bs.nameIdx);
    writer.writeUint32(bs.slotKeyIdx);
    writer.writeUint32(bs.chunkKeyIdx);
    writer.writeUint8(PROTOTYPE_TO_CODE[b.prototypeKind]);
    writer.writeInt32(b.renderOrder);
    writer.writeUint32(b.flags);
    writer.writeFloat32(b.bboxMin[0]);
    writer.writeFloat32(b.bboxMin[1]);
    writer.writeFloat32(b.bboxMin[2]);
    writer.writeFloat32(b.bboxMax[0]);
    writer.writeFloat32(b.bboxMax[1]);
    writer.writeFloat32(b.bboxMax[2]);
    writer.writeUint32(b.instanceCount);

    writer.writeAlignedTypedArray(b.matrices);
    writer.writeUint8(b.instanceColors ? 1 : 0);
    if (b.instanceColors) {
      writer.writeAlignedTypedArray(b.instanceColors);
    }
    writer.writeAlignedTypedArray(b.instanceFeatureIdxs);

    const hasSleeperBoxes = b.sleeperBoxes !== null && bs.sleeperTrackIdxs !== null;
    writer.writeUint8(hasSleeperBoxes ? 1 : 0);
    if (hasSleeperBoxes && b.sleeperBoxes && bs.sleeperTrackIdxs) {
      for (let j = 0; j < b.sleeperBoxes.length; j++) {
        const sb = b.sleeperBoxes[j];
        writer.writeFloat32(sb.cx);
        writer.writeFloat32(sb.cz);
        writer.writeFloat32(sb.yBottom);
        writer.writeFloat32(sb.yTop);
        writer.writeFloat32(sb.tx);
        writer.writeFloat32(sb.tz);
        writer.writeFloat32(sb.nx);
        writer.writeFloat32(sb.nz);
        writer.writeFloat32(sb.halfLen);
        writer.writeFloat32(sb.halfWidthLeft);
        writer.writeFloat32(sb.halfWidthRight);
        writer.writeUint32(bs.sleeperTrackIdxs[j]);
      }
    }
  }

  const out = writer.toUint8Array();
  const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
  outView.setUint32(32, out.byteLength, true);
  const crc = computeOsmTileCrc32(out);
  outView.setUint32(CRC_FIELD_OFFSET, crc, true);
  return out;
}

export function decodeTileBinary(
  bytes: Uint8Array,
  expectedKeyHint = 'unknown'
): DecodedTilePayload {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new TilePackCorruptError(
      `Tile payload too short (${bytes.byteLength} bytes < ${HEADER_BYTES})`,
      expectedKeyHint,
      'truncated_header'
    );
  }

  const magic = textDecoder.decode(bytes.subarray(0, 8));
  if (magic !== OSMTILE1_MAGIC) {
    throw new TilePackCorruptError(
      `Invalid magic "${magic}" (expected "${OSMTILE1_MAGIC}")`,
      expectedKeyHint,
      'invalid_magic'
    );
  }

  const reader = new ByteReader(bytes, expectedKeyHint);
  reader.pos = 8;
  const formatVersion = reader.readUint32();
  if (formatVersion !== OSMTILE1_FORMAT_VERSION) {
    throw new TilePackCorruptError(
      `Unsupported OSMTILE1 format version ${formatVersion}`,
      expectedKeyHint,
      'unsupported_format_version'
    );
  }

  const flags = reader.readUint32();
  const lod = reader.readUint32();
  const tx = reader.readInt32();
  const ty = reader.readInt32();
  const expectedCrc = reader.readUint32();
  const totalByteLength = reader.readUint32();

  if (totalByteLength !== bytes.byteLength) {
    throw new TilePackCorruptError(
      `Payload length mismatch (header=${totalByteLength}, actual=${bytes.byteLength})`,
      `${lod}:${tx}:${ty}`,
      'length_mismatch'
    );
  }

  const actualCrc = computeOsmTileCrc32(bytes);
  if (actualCrc !== expectedCrc) {
    throw new TilePackCorruptError(
      `CRC32 mismatch (expected=0x${expectedCrc.toString(16)}, actual=0x${actualCrc.toString(16)})`,
      `${lod}:${tx}:${ty}`,
      'crc32_mismatch'
    );
  }

  const renderedFeaturesCount = reader.readUint32();
  const forestTreesCount = reader.readUint32();
  const sleeper3DBoxCount = reader.readUint32();
  const totalVertices = reader.readUint32();
  const totalTriangles = reader.readUint32();
  const totalDrawCalls = reader.readUint32();
  const meshCount = reader.readUint32();
  const tileCenterX = reader.readFloat64();
  const tileCenterZ = reader.readFloat64();
  const tileSizeMeters = reader.readFloat64();
  const overhangBoundsMin: [number, number, number] = [
    reader.readFloat32(),
    reader.readFloat32(),
    reader.readFloat32(),
  ];
  const overhangBoundsMax: [number, number, number] = [
    reader.readFloat32(),
    reader.readFloat32(),
    reader.readFloat32(),
  ];

  const instancedCount = reader.readUint32();
  const railwayRenderSourceStrIdx = reader.readUint32();

  // 1. String pool
  const strCount = reader.readUint32();
  const stringPool: string[] = new Array(strCount);
  for (let i = 0; i < strCount; i++) {
    const byteLen = reader.readUint32();
    const raw = reader.readRawSlice(byteLen);
    stringPool[i] = textDecoder.decode(raw);
  }

  const getStr = (idx: number): string => {
    if (idx >= stringPool.length) {
      throw new TilePackCorruptError(
        `String index ${idx} out of range (${stringPool.length})`,
        `${lod}:${tx}:${ty}`,
        'invalid_string_index'
      );
    }
    return stringPool[idx];
  };
  const getOptStr = (idx: number): string | undefined =>
    idx === INVALID_STR_IDX ? undefined : getStr(idx);

  const railwayRenderSource = getStr(railwayRenderSourceStrIdx);

  // 2. Feature info table
  const infoCount = reader.readUint32();
  const featureInfos: InspectableFeatureInfo[] = new Array(infoCount);
  for (let i = 0; i < infoCount; i++) {
    const id = getStr(reader.readUint32());
    const sourceFeatureId = getStr(reader.readUint32());
    const name = getOptStr(reader.readUint32());
    const category = getStr(reader.readUint32());
    const cartoLabel = getStr(reader.readUint32());
    const primaryTag = getStr(reader.readUint32());
    const subtype = getStr(reader.readUint32());
    const type = getOptStr(reader.readUint32());
    const amenity = getOptStr(reader.readUint32());
    const heightFormatted = getOptStr(reader.readUint32());
    const placementJson = getOptStr(reader.readUint32());

    const srcArrLen = reader.readUint16();
    const sourceFeatureIds: string[] | undefined = srcArrLen > 0 ? new Array(srcArrLen) : undefined;
    for (let s = 0; s < srcArrLen; s++) {
      sourceFeatureIds![s] = getStr(reader.readUint32());
    }

    const numMask = reader.readUint16();
    const boolBits = reader.readUint8();

    const height = (numMask & (1 << 0)) !== 0 ? reader.readFloat32() : undefined;
    const levels = (numMask & (1 << 1)) !== 0 ? reader.readInt32() : undefined;
    const width = (numMask & (1 << 2)) !== 0 ? reader.readFloat32() : undefined;
    const elevation = (numMask & (1 << 3)) !== 0 ? reader.readFloat32() : undefined;
    const layer = (numMask & (1 << 4)) !== 0 ? reader.readInt32() : undefined;
    const isBridge = (numMask & (1 << 5)) !== 0 ? (boolBits & (1 << 0)) !== 0 : undefined;
    const isTunnel = (numMask & (1 << 6)) !== 0 ? (boolBits & (1 << 1)) !== 0 : undefined;

    const tagCount = reader.readUint16();
    const osmTags: Record<string, string | number | boolean> = {};
    for (let t = 0; t < tagCount; t++) {
      const k = getStr(reader.readUint32());
      const vType = reader.readUint8();
      if (vType === 0) {
        osmTags[k] = getStr(reader.readUint32());
      } else if (vType === 1) {
        osmTags[k] = reader.readFloat64();
      } else {
        osmTags[k] = reader.readUint8() !== 0;
      }
    }

    const info: InspectableFeatureInfo = {
      id,
      sourceFeatureId,
      category,
      cartoLabel,
      primaryTag,
      subtype,
      osmTags,
    };
    if (name !== undefined) info.name = name;
    if (sourceFeatureIds !== undefined) info.sourceFeatureIds = sourceFeatureIds;
    if (type !== undefined) info.type = type;
    if (amenity !== undefined) info.amenity = amenity;
    if (heightFormatted !== undefined) info.heightFormatted = heightFormatted;
    if (height !== undefined) info.height = height;
    if (levels !== undefined) info.levels = levels;
    if (width !== undefined) info.width = width;
    if (elevation !== undefined) info.elevation = elevation;
    if (layer !== undefined) info.layer = layer;
    if (isBridge !== undefined) info.isBridge = isBridge;
    if (isTunnel !== undefined) info.isTunnel = isTunnel;
    if (placementJson !== undefined) {
      info.placementClassification = JSON.parse(placementJson);
    }

    featureInfos[i] = info;
  }

  // 3. Static meshes
  const meshes: TileMeshRecord[] = new Array(meshCount);
  for (let i = 0; i < meshCount; i++) {
    const layerCode = reader.readUint8();
    const layer = LAYER_ORDER[layerCode];
    if (!layer) {
      throw new TilePackCorruptError(
        `Invalid layer code ${layerCode}`,
        `${lod}:${tx}:${ty}`,
        'invalid_layer'
      );
    }
    const name = getStr(reader.readUint32());
    const chunkKey = getOptStr(reader.readUint32());
    const renderOrder = reader.readInt32();
    const meshFlags = reader.readUint32();
    const localPositionOffset: [number, number, number] = [
      reader.readFloat32(),
      reader.readFloat32(),
      reader.readFloat32(),
    ];
    const bboxMin: [number, number, number] = [
      reader.readFloat32(),
      reader.readFloat32(),
      reader.readFloat32(),
    ];
    const bboxMax: [number, number, number] = [
      reader.readFloat32(),
      reader.readFloat32(),
      reader.readFloat32(),
    ];
    const singleFeatureIdx = reader.readInt32();

    const slotCount = reader.readUint8();
    const materialSlotKeys: string[] = new Array(slotCount);
    for (let s = 0; s < slotCount; s++) {
      materialSlotKeys[s] = getStr(reader.readUint32());
    }

    const attrMask = reader.readUint8();
    const positions = new Float32Array(reader.readAlignedArrayBuffer());
    const normals =
      (attrMask & (1 << 0)) !== 0 ? new Float32Array(reader.readAlignedArrayBuffer()) : null;
    const uvs =
      (attrMask & (1 << 1)) !== 0 ? new Float32Array(reader.readAlignedArrayBuffer()) : null;
    const switchAttrs =
      (attrMask & (1 << 2)) !== 0 ? new Float32Array(reader.readAlignedArrayBuffer()) : null;
    const colors =
      (attrMask & (1 << 3)) !== 0 ? new Float32Array(reader.readAlignedArrayBuffer()) : null;
    const indices =
      (attrMask & (1 << 4)) !== 0
        ? (attrMask & (1 << 5)) !== 0
          ? new Uint32Array(reader.readAlignedArrayBuffer())
          : new Uint16Array(reader.readAlignedArrayBuffer())
        : null;

    const groupCount = reader.readUint32();
    const groups: TileMeshGroupRecord[] = new Array(groupCount);
    for (let g = 0; g < groupCount; g++) {
      groups[g] = {
        start: reader.readUint32(),
        count: reader.readUint32(),
        materialIndex: reader.readUint16(),
      };
    }

    const rangeCount = reader.readUint32();
    const faceRanges: TileFaceRangeRecord[] = new Array(rangeCount);
    for (let r = 0; r < rangeCount; r++) {
      faceRanges[r] = {
        startFace: reader.readUint32(),
        endFace: reader.readUint32(),
        infoIdx: reader.readInt32(),
      };
    }

    let bvh: TileSerializedBvhRecord | null = null;
    if ((attrMask & (1 << 6)) !== 0) {
      const bvhVersion = reader.readUint16();
      const rootCount = reader.readUint16();
      const roots: ArrayBuffer[] = new Array(rootCount);
      for (let r = 0; r < rootCount; r++) {
        roots[r] = reader.readAlignedArrayBuffer();
      }
      const indirectKind = reader.readUint8();
      const indirectBuffer =
        indirectKind === 2
          ? new Uint32Array(reader.readAlignedArrayBuffer())
          : indirectKind === 1
            ? new Uint16Array(reader.readAlignedArrayBuffer())
            : null;
      bvh = { version: bvhVersion, roots, indirectBuffer };
    }

    meshes[i] = {
      layer,
      name,
      materialSlotKeys,
      renderOrder,
      flags: meshFlags,
      localPositionOffset,
      bboxMin,
      bboxMax,
      positions,
      normals,
      uvs,
      switchAttrs,
      colors,
      indices,
      groups,
      faceRanges,
      singleFeatureIdx,
      bvh,
      chunkKey,
    };
  }

  // 4. Instanced batches
  const instancedBatches: TileInstancedBatchRecord[] = new Array(instancedCount);
  for (let i = 0; i < instancedCount; i++) {
    const layerCode = reader.readUint8();
    const layer = LAYER_ORDER[layerCode];
    if (!layer) {
      throw new TilePackCorruptError(
        `Invalid instanced layer code ${layerCode}`,
        `${lod}:${tx}:${ty}`,
        'invalid_layer'
      );
    }
    const name = getStr(reader.readUint32());
    const materialSlotKey = getStr(reader.readUint32());
    const chunkKey = getOptStr(reader.readUint32());
    const protoCode = reader.readUint8();
    const prototypeKind = CODE_TO_PROTOTYPE[protoCode];
    if (!prototypeKind) {
      throw new TilePackCorruptError(
        `Invalid prototype kind code ${protoCode}`,
        `${lod}:${tx}:${ty}`,
        'invalid_prototype'
      );
    }
    const renderOrder = reader.readInt32();
    const batchFlags = reader.readUint32();
    const bboxMin: [number, number, number] = [
      reader.readFloat32(),
      reader.readFloat32(),
      reader.readFloat32(),
    ];
    const bboxMax: [number, number, number] = [
      reader.readFloat32(),
      reader.readFloat32(),
      reader.readFloat32(),
    ];
    const instanceCount = reader.readUint32();
    const matrices = new Float32Array(reader.readAlignedArrayBuffer());
    const hasColors = reader.readUint8() !== 0;
    const instanceColors = hasColors ? new Float32Array(reader.readAlignedArrayBuffer()) : null;
    const instanceFeatureIdxs = new Int32Array(reader.readAlignedArrayBuffer());

    const hasSleeperBoxes = reader.readUint8() !== 0;
    let sleeperBoxes: TileSleeperBearerBox[] | null = null;
    if (hasSleeperBoxes) {
      sleeperBoxes = new Array(instanceCount);
      for (let j = 0; j < instanceCount; j++) {
        sleeperBoxes[j] = {
          cx: reader.readFloat32(),
          cz: reader.readFloat32(),
          yBottom: reader.readFloat32(),
          yTop: reader.readFloat32(),
          tx: reader.readFloat32(),
          tz: reader.readFloat32(),
          nx: reader.readFloat32(),
          nz: reader.readFloat32(),
          halfLen: reader.readFloat32(),
          halfWidthLeft: reader.readFloat32(),
          halfWidthRight: reader.readFloat32(),
          trackId: getStr(reader.readUint32()),
        };
      }
    }

    instancedBatches[i] = {
      layer,
      name,
      materialSlotKey,
      prototypeKind,
      renderOrder,
      flags: batchFlags,
      bboxMin,
      bboxMax,
      instanceCount,
      matrices,
      instanceColors,
      instanceFeatureIdxs,
      sleeperBoxes,
      chunkKey,
    };
  }

  return {
    formatVersion,
    lod,
    tx,
    ty,
    tileCenterX,
    tileCenterZ,
    tileSizeMeters,
    overhangBoundsMin,
    overhangBoundsMax,
    flags,
    renderedFeaturesCount,
    forestTreesCount,
    sleeper3DBoxCount,
    totalVertices,
    totalTriangles,
    totalDrawCalls,
    railwayRenderSource,
    featureInfos,
    meshes,
    instancedBatches,
    byteLength: bytes.byteLength,
  };
}
