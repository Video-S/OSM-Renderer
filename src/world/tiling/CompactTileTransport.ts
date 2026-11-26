/**
 * TKT-040 Work Package B2: Compact binary metadata transport and lazy on-demand
 * feature materialization for OSMTILE1 v1 tile payloads.
 *
 * Reads the exact existing OSMTILE1 v1 binary format (100% compatible with existing
 * baked mosaics, zero rebake required) and preserves high-cardinality metadata
 * (`featureInfos`, `faceRanges`, `groups`, `sleeperBoxes`, string pool) as compact
 * transferable typed arrays instead of large structured-cloned JS object graphs.
 *
 * Inspection metadata (`InspectableFeatureInfo`) is materialized lazily on demand
 * when hovered, clicked, or explicitly inspected by verifiers/tests.
 */
import type { InspectableFeatureInfo } from '../../types/MapFeature';
import type { PreparedInstancedSpatialIndexData } from '../InstancedSpatialIndex';
import { computeOsmTileCrc32 } from './TileBinaryCodec';
import {
  OSMTILE1_FORMAT_VERSION,
  OSMTILE1_MAGIC,
  TilePackCorruptError,
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
import type { TileMemoryFootprint } from './TileStreamManager';

const HEADER_BYTES = 112;
const INVALID_STR_IDX = 0xffffffff;
const textDecoder = new TextDecoder();

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

const CODE_TO_PROTOTYPE: Record<number, Exclude<TilePrototypeKind, 'none'>> = {
  1: 'tree_trunk',
  2: 'tree_broadleaved',
  3: 'tree_needleleaved',
  4: 'sleeper_box_unit',
};

export interface CompactStringTableData {
  bytes: Uint8Array;
  offsets: Uint32Array; // length = count + 1
  count: number;
}

export interface CompactFeatureTableData {
  strings: CompactStringTableData;
  featureBytes: Uint8Array;
  featureOffsets: Uint32Array; // length = count + 1
  count: number;
}

export interface CompactMeshRecord {
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
  /** Offset (in triples) into `CompactDecodedTilePayload.packedGroups` (`Uint32Array`). */
  groupOffset: number;
  groupCount: number;
  /** Offset (in triples) into `CompactDecodedTilePayload.packedFaceRanges` (`Uint32Array`). */
  faceRangeOffset: number;
  faceRangeCount: number;
  singleFeatureIdx: number;
  bvh: TileSerializedBvhRecord | null;
  chunkKey?: string;
}

export interface CompactInstancedBatchRecord {
  layer: TileLayerKind;
  name: string;
  materialSlotKey: string;
  prototypeKind: Exclude<TilePrototypeKind, 'none'>;
  renderOrder: number;
  flags: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  instanceCount: number;
  matrices: Float32Array;
  instanceColors: Float32Array | null;
  instanceFeatureIdxs: Int32Array;
  /** Flat 11-float-per-instance sleeper boxes (`cx, cz, yBottom, yTop, tx, tz, nx, nz, halfLen, halfWidthLeft, halfWidthRight`). */
  sleeperBoxFloats: Float32Array | null;
  /** String table indices for each sleeper box's `trackId`. */
  sleeperBoxTrackStrIdxs: Uint32Array | null;
  chunkKey?: string;
  /** Optional worker-constructed InstancedSpatialIndex typed arrays (TKT-040 Work Package C). */
  preparedSpatialIndex?: PreparedInstancedSpatialIndexData | null;
}

export interface CompactDecodedTilePayload {
  isCompactTransport: true;
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
  byteLength: number;
  featureTable: CompactFeatureTableData;
  /** Contiguous triples `[start, count, materialIndex, ...]` across all static meshes. */
  packedGroups: Uint32Array;
  /** Contiguous triples `[startFace, endFace, infoIdxAsUint32, ...]` across all static meshes. */
  packedFaceRanges: Uint32Array;
  meshes: CompactMeshRecord[];
  instancedBatches: CompactInstancedBatchRecord[];
  precomputedFootprint: TileMemoryFootprint;
}

export type AnyDecodedTilePayload = DecodedTilePayload | CompactDecodedTilePayload;

export function isCompactDecodedTilePayload(
  payload: AnyDecodedTilePayload
): payload is CompactDecodedTilePayload {
  return (payload as CompactDecodedTilePayload).isCompactTransport === true;
}

/**
 * Packed face-range descriptor stored on reconstructed static meshes for O(log R)
 * binary search in `resolveInspectedFeature` without eagerly allocating JS object arrays.
 */
export interface PackedFaceRangeLookup {
  data: Uint32Array;
  offset: number;
  count: number;
  featureTable: LazyTileFeatureTable;
}

/**
 * Lazy string + feature metadata resolver backed by compact transferred TypedArrays.
 * Zero `InspectableFeatureInfo` JS objects or feature strings are materialized until
 * explicitly queried (hover, click, search, or verifier inspection).
 */
export class LazyTileFeatureTable {
  private readonly strBytes: Uint8Array;
  private readonly strOffsets: Uint32Array;
  private readonly strCount: number;
  private readonly strCache: Array<string | undefined>;

  private readonly featureBytes: Uint8Array;
  private readonly featureView: DataView;
  private readonly featureOffsets: Uint32Array;
  public readonly count: number;
  private readonly featureCache: Array<InspectableFeatureInfo | undefined>;

  constructor(data: CompactFeatureTableData) {
    this.strBytes = data.strings.bytes;
    this.strOffsets = data.strings.offsets;
    this.strCount = data.strings.count;
    this.strCache = new Array(this.strCount);

    this.featureBytes = data.featureBytes;
    this.featureView = new DataView(
      this.featureBytes.buffer,
      this.featureBytes.byteOffset,
      this.featureBytes.byteLength
    );
    this.featureOffsets = data.featureOffsets;
    this.count = data.count;
    this.featureCache = new Array(this.count);
  }

  getString(idx: number): string {
    if (idx < 0 || idx >= this.strCount) {
      return '';
    }
    const cached = this.strCache[idx];
    if (cached !== undefined) return cached;
    const start = this.strOffsets[idx];
    const end = this.strOffsets[idx + 1];
    const decoded = textDecoder.decode(this.strBytes.subarray(start, end));
    this.strCache[idx] = decoded;
    return decoded;
  }

  getOptionalString(idx: number): string | undefined {
    return idx === INVALID_STR_IDX ? undefined : this.getString(idx);
  }

  getFeatureInfo(idx: number): InspectableFeatureInfo | null {
    if (idx < 0 || idx >= this.count) return null;
    const cached = this.featureCache[idx];
    if (cached !== undefined) return cached;

    let pos = this.featureOffsets[idx];
    const view = this.featureView;
    const bytes = this.featureBytes;

    const id = this.getString(view.getUint32(pos, true));
    pos += 4;
    const sourceFeatureId = this.getString(view.getUint32(pos, true));
    pos += 4;
    const name = this.getOptionalString(view.getUint32(pos, true));
    pos += 4;
    const category = this.getString(view.getUint32(pos, true));
    pos += 4;
    const cartoLabel = this.getString(view.getUint32(pos, true));
    pos += 4;
    const primaryTag = this.getString(view.getUint32(pos, true));
    pos += 4;
    const subtype = this.getString(view.getUint32(pos, true));
    pos += 4;
    const type = this.getOptionalString(view.getUint32(pos, true));
    pos += 4;
    const amenity = this.getOptionalString(view.getUint32(pos, true));
    pos += 4;
    const heightFormatted = this.getOptionalString(view.getUint32(pos, true));
    pos += 4;
    const placementJson = this.getOptionalString(view.getUint32(pos, true));
    pos += 4;

    const srcArrLen = view.getUint16(pos, true);
    pos += 2;
    const sourceFeatureIds: string[] | undefined =
      srcArrLen > 0 ? new Array(srcArrLen) : undefined;
    for (let s = 0; s < srcArrLen; s++) {
      sourceFeatureIds![s] = this.getString(view.getUint32(pos, true));
      pos += 4;
    }

    const numMask = view.getUint16(pos, true);
    pos += 2;
    const boolBits = bytes[pos++];

    let height: number | undefined;
    let levels: number | undefined;
    let width: number | undefined;
    let elevation: number | undefined;
    let layer: number | undefined;
    if ((numMask & (1 << 0)) !== 0) {
      height = view.getFloat32(pos, true);
      pos += 4;
    }
    if ((numMask & (1 << 1)) !== 0) {
      levels = view.getInt32(pos, true);
      pos += 4;
    }
    if ((numMask & (1 << 2)) !== 0) {
      width = view.getFloat32(pos, true);
      pos += 4;
    }
    if ((numMask & (1 << 3)) !== 0) {
      elevation = view.getFloat32(pos, true);
      pos += 4;
    }
    if ((numMask & (1 << 4)) !== 0) {
      layer = view.getInt32(pos, true);
      pos += 4;
    }
    const isBridge =
      (numMask & (1 << 5)) !== 0 ? (boolBits & (1 << 0)) !== 0 : undefined;
    const isTunnel =
      (numMask & (1 << 6)) !== 0 ? (boolBits & (1 << 1)) !== 0 : undefined;

    const tagCount = view.getUint16(pos, true);
    pos += 2;
    const osmTags: Record<string, string | number | boolean> = {};
    for (let t = 0; t < tagCount; t++) {
      const k = this.getString(view.getUint32(pos, true));
      pos += 4;
      const vType = bytes[pos++];
      if (vType === 0) {
        osmTags[k] = this.getString(view.getUint32(pos, true));
        pos += 4;
      } else if (vType === 1) {
        osmTags[k] = view.getFloat64(pos, true);
        pos += 8;
      } else {
        osmTags[k] = bytes[pos++] !== 0;
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

    this.featureCache[idx] = info;
    return info;
  }

  toArray(): InspectableFeatureInfo[] {
    const out: InspectableFeatureInfo[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      out[i] = this.getFeatureInfo(i)!;
    }
    return out;
  }

  /** Helper for unit tests / diagnostics to inspect how many features were lazily materialized. */
  get materializedCount(): number {
    let n = 0;
    for (let i = 0; i < this.featureCache.length; i++) {
      if (this.featureCache[i] !== undefined) n++;
    }
    return n;
  }
}

/**
 * Binary-searches a packed `[startFace, endFace, infoIdx, ...]` `Uint32Array` slice
 * directly and lazily resolves only the matched feature.
 */
export function lookupPackedFaceRange(
  lookup: PackedFaceRangeLookup,
  faceIndex: number
): InspectableFeatureInfo | null {
  const { data, offset, count, featureTable } = lookup;
  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const base = (offset + mid) * 3;
    const startFace = data[base];
    const endFace = data[base + 1];
    if (faceIndex < startFace) {
      hi = mid - 1;
    } else if (faceIndex >= endFace) {
      lo = mid + 1;
    } else {
      const infoIdx = data[base + 2] | 0;
      return featureTable.getFeatureInfo(infoIdx);
    }
  }
  return null;
}

class CompactByteReader {
  private readonly view: DataView;
  public pos = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly tileKey: string
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  assertRemaining(needed: number, context: string): void {
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

  skip(n: number, context: string): void {
    this.assertRemaining(n, context);
    this.pos += n;
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

class Uint32GrowableBuilder {
  private buf: Uint32Array;
  private len = 0;

  constructor(initialCapacity = 256) {
    this.buf = new Uint32Array(Math.max(16, initialCapacity));
  }

  get length(): number {
    return this.len;
  }

  ensure(extra: number): void {
    const needed = this.len + extra;
    if (needed <= this.buf.length) return;
    let nextCap = this.buf.length * 2;
    while (nextCap < needed) nextCap *= 2;
    const next = new Uint32Array(nextCap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  pushTriple(a: number, b: number, c: number): void {
    this.ensure(3);
    this.buf[this.len++] = a >>> 0;
    this.buf[this.len++] = b >>> 0;
    this.buf[this.len++] = c >>> 0;
  }

  toTrimmedUint32Array(): Uint32Array {
    if (this.len === this.buf.length) return this.buf;
    return this.buf.slice(0, this.len);
  }
}

/**
 * Decodes an `OSMTILE1` v1 binary tile directly into a compact transferable
 * representation without allocating JS object graphs for `featureInfos`,
 * `faceRanges`, `groups`, or `sleeperBoxes`.
 */
export function decodeTileBinaryCompact(
  bytes: Uint8Array,
  expectedKeyHint = 'unknown'
): CompactDecodedTilePayload {
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

  const reader = new CompactByteReader(bytes, expectedKeyHint);
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
  const tileKey = `${lod}:${tx}:${ty}`;

  if (totalByteLength !== bytes.byteLength) {
    throw new TilePackCorruptError(
      `Payload length mismatch (header=${totalByteLength}, actual=${bytes.byteLength})`,
      tileKey,
      'length_mismatch'
    );
  }

  const actualCrc = computeOsmTileCrc32(bytes);
  if (actualCrc !== expectedCrc) {
    throw new TilePackCorruptError(
      `CRC32 mismatch (expected=0x${expectedCrc.toString(16)}, actual=0x${actualCrc.toString(16)})`,
      tileKey,
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

  // 1. Compact string pool: pack into 1 contiguous UTF-8 byte buffer + offsets array
  const strCount = reader.readUint32();
  const strStartPos = reader.pos;
  let totalStrBytes = 0;
  for (let i = 0; i < strCount; i++) {
    const byteLen = reader.readUint32();
    reader.skip(byteLen, `string[${i}]`);
    totalStrBytes += byteLen;
  }
  const strEndPos = reader.pos;

  const strBytes = new Uint8Array(totalStrBytes);
  const strOffsets = new Uint32Array(strCount + 1);
  reader.pos = strStartPos;
  let writeCursor = 0;
  for (let i = 0; i < strCount; i++) {
    const byteLen = reader.readUint32();
    strOffsets[i] = writeCursor;
    strBytes.set(bytes.subarray(reader.pos, reader.pos + byteLen), writeCursor);
    writeCursor += byteLen;
    reader.pos += byteLen;
  }
  strOffsets[strCount] = writeCursor;
  reader.pos = strEndPos;

  // Small worker-local string cache for only structural strings (mesh names, material slots, chunk keys)
  const localStrCache = new Map<number, string>();
  const getStructuralStr = (idx: number): string => {
    if (idx >= strCount) {
      throw new TilePackCorruptError(
        `String index ${idx} out of range (${strCount})`,
        tileKey,
        'invalid_string_index'
      );
    }
    const existing = localStrCache.get(idx);
    if (existing !== undefined) return existing;
    const s = textDecoder.decode(strBytes.subarray(strOffsets[idx], strOffsets[idx + 1]));
    localStrCache.set(idx, s);
    return s;
  };
  const getOptStructuralStr = (idx: number): string | undefined =>
    idx === INVALID_STR_IDX ? undefined : getStructuralStr(idx);

  const railwayRenderSource = getStructuralStr(railwayRenderSourceStrIdx);

  // 2. Compact feature table: record per-feature byte offsets and keep raw binary slice
  const infoCount = reader.readUint32();
  const featureTableStartPos = reader.pos;
  const featureOffsets = new Uint32Array(infoCount + 1);

  for (let i = 0; i < infoCount; i++) {
    featureOffsets[i] = reader.pos - featureTableStartPos;
    // 11 uint32 string indices (validate required/optional indices bounds? checked lazily on access,
    // plus fast structural validation of exact byte sizes here)
    reader.skip(44, `feature[${i}].headerStrings`);
    const srcArrLen = reader.readUint16();
    if (srcArrLen > 0) {
      reader.skip(srcArrLen * 4, `feature[${i}].sourceFeatureIds`);
    }
    const numMask = reader.readUint16();
    reader.skip(1, `feature[${i}].boolBits`);
    let numBytes = 0;
    if ((numMask & (1 << 0)) !== 0) numBytes += 4;
    if ((numMask & (1 << 1)) !== 0) numBytes += 4;
    if ((numMask & (1 << 2)) !== 0) numBytes += 4;
    if ((numMask & (1 << 3)) !== 0) numBytes += 4;
    if ((numMask & (1 << 4)) !== 0) numBytes += 4;
    if (numBytes > 0) {
      reader.skip(numBytes, `feature[${i}].numericFields`);
    }
    const tagCount = reader.readUint16();
    for (let t = 0; t < tagCount; t++) {
      reader.skip(4, `feature[${i}].tagKey`);
      const vType = reader.readUint8();
      if (vType === 0) {
        reader.skip(4, `feature[${i}].tagStrVal`);
      } else if (vType === 1) {
        reader.skip(8, `feature[${i}].tagNumVal`);
      } else {
        reader.skip(1, `feature[${i}].tagBoolVal`);
      }
    }
  }
  featureOffsets[infoCount] = reader.pos - featureTableStartPos;
  const featureBytes = bytes.slice(featureTableStartPos, reader.pos);

  // 3. Static meshes + packed groups & packed faceRanges slabs
  const groupsBuilder = new Uint32GrowableBuilder(Math.max(64, meshCount * 6));
  const faceRangesBuilder = new Uint32GrowableBuilder(Math.max(256, meshCount * 12));
  const meshes: CompactMeshRecord[] = new Array(meshCount);

  let cpuGeometryBytes = 0;
  let bvhBytes = 0;
  let footprintMeshCount = 0;
  let bvhCount = 0;

  for (let i = 0; i < meshCount; i++) {
    const layerCode = reader.readUint8();
    const layer = LAYER_ORDER[layerCode];
    if (!layer) {
      throw new TilePackCorruptError(
        `Invalid layer code ${layerCode}`,
        tileKey,
        'invalid_layer'
      );
    }
    const name = getStructuralStr(reader.readUint32());
    const chunkKey = getOptStructuralStr(reader.readUint32());
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
      materialSlotKeys[s] = getStructuralStr(reader.readUint32());
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
    const groupOffset = groupsBuilder.length / 3;
    if (groupCount > 0) {
      groupsBuilder.ensure(groupCount * 3);
      for (let g = 0; g < groupCount; g++) {
        groupsBuilder.pushTriple(
          reader.readUint32(),
          reader.readUint32(),
          reader.readUint16()
        );
      }
    }

    const rangeCount = reader.readUint32();
    const faceRangeOffset = faceRangesBuilder.length / 3;
    if (rangeCount > 0) {
      faceRangesBuilder.ensure(rangeCount * 3);
      for (let r = 0; r < rangeCount; r++) {
        faceRangesBuilder.pushTriple(
          reader.readUint32(),
          reader.readUint32(),
          reader.readInt32() >>> 0
        );
      }
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

    if (layer !== 'ground') {
      footprintMeshCount += 1;
    }
    cpuGeometryBytes += positions.byteLength;
    cpuGeometryBytes += normals?.byteLength ?? 0;
    cpuGeometryBytes += uvs?.byteLength ?? 0;
    cpuGeometryBytes += switchAttrs?.byteLength ?? 0;
    cpuGeometryBytes += colors?.byteLength ?? 0;
    cpuGeometryBytes += indices?.byteLength ?? 0;
    if (bvh) {
      bvhCount += 1;
      for (let r = 0; r < bvh.roots.length; r++) {
        bvhBytes += bvh.roots[r].byteLength;
      }
      bvhBytes += bvh.indirectBuffer?.byteLength ?? 0;
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
      groupOffset,
      groupCount,
      faceRangeOffset,
      faceRangeCount: rangeCount,
      singleFeatureIdx,
      bvh,
      chunkKey,
    };
  }

  // 4. Instanced batches (with compact flat sleeper box arrays)
  const instancedBatches: CompactInstancedBatchRecord[] = new Array(instancedCount);
  for (let i = 0; i < instancedCount; i++) {
    const layerCode = reader.readUint8();
    const layer = LAYER_ORDER[layerCode];
    if (!layer) {
      throw new TilePackCorruptError(
        `Invalid instanced layer code ${layerCode}`,
        tileKey,
        'invalid_layer'
      );
    }
    const name = getStructuralStr(reader.readUint32());
    const materialSlotKey = getStructuralStr(reader.readUint32());
    const chunkKey = getOptStructuralStr(reader.readUint32());
    const protoCode = reader.readUint8();
    const prototypeKind = CODE_TO_PROTOTYPE[protoCode];
    if (!prototypeKind) {
      throw new TilePackCorruptError(
        `Invalid prototype kind code ${protoCode}`,
        tileKey,
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
    const instanceColors = hasColors
      ? new Float32Array(reader.readAlignedArrayBuffer())
      : null;
    const instanceFeatureIdxs = new Int32Array(reader.readAlignedArrayBuffer());

    const hasSleeperBoxes = reader.readUint8() !== 0;
    let sleeperBoxFloats: Float32Array | null = null;
    let sleeperBoxTrackStrIdxs: Uint32Array | null = null;
    if (hasSleeperBoxes) {
      sleeperBoxFloats = new Float32Array(instanceCount * 11);
      sleeperBoxTrackStrIdxs = new Uint32Array(instanceCount);
      for (let j = 0; j < instanceCount; j++) {
        const base = j * 11;
        sleeperBoxFloats[base] = reader.readFloat32();
        sleeperBoxFloats[base + 1] = reader.readFloat32();
        sleeperBoxFloats[base + 2] = reader.readFloat32();
        sleeperBoxFloats[base + 3] = reader.readFloat32();
        sleeperBoxFloats[base + 4] = reader.readFloat32();
        sleeperBoxFloats[base + 5] = reader.readFloat32();
        sleeperBoxFloats[base + 6] = reader.readFloat32();
        sleeperBoxFloats[base + 7] = reader.readFloat32();
        sleeperBoxFloats[base + 8] = reader.readFloat32();
        sleeperBoxFloats[base + 9] = reader.readFloat32();
        sleeperBoxFloats[base + 10] = reader.readFloat32();
        sleeperBoxTrackStrIdxs[j] = reader.readUint32();
      }
    }

    footprintMeshCount += 1;
    cpuGeometryBytes += matrices.byteLength;
    cpuGeometryBytes += instanceColors?.byteLength ?? 0;

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
      sleeperBoxFloats,
      sleeperBoxTrackStrIdxs,
      chunkKey,
      preparedSpatialIndex: null,
    };
  }

  return {
    isCompactTransport: true,
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
    byteLength: bytes.byteLength,
    featureTable: {
      strings: {
        bytes: strBytes,
        offsets: strOffsets,
        count: strCount,
      },
      featureBytes,
      featureOffsets,
      count: infoCount,
    },
    packedGroups: groupsBuilder.toTrimmedUint32Array(),
    packedFaceRanges: faceRangesBuilder.toTrimmedUint32Array(),
    meshes,
    instancedBatches,
    precomputedFootprint: {
      cpuGeometryBytes,
      bvhBytes,
      meshCount: footprintMeshCount,
      instancedBatchCount: instancedCount,
      bvhCount,
      triangleCount: totalTriangles,
      vertexCount: totalVertices,
    },
  };
}

/**
 * Materializes a `TileSleeperBearerBox[]` array from compact sleeper typed arrays
 * with optional world X/Z shift (used lazily only when `userData.instanceBoxes` is read).
 */
export function materializeSleeperBoxesFromCompact(
  floats: Float32Array,
  trackStrIdxs: Uint32Array,
  featureTable: LazyTileFeatureTable,
  shiftX = 0,
  shiftZ = 0
): TileSleeperBearerBox[] {
  const count = trackStrIdxs.length;
  const out: TileSleeperBearerBox[] = new Array(count);
  for (let j = 0; j < count; j++) {
    const base = j * 11;
    out[j] = {
      cx: floats[base] + shiftX,
      cz: floats[base + 1] + shiftZ,
      yBottom: floats[base + 2],
      yTop: floats[base + 3],
      tx: floats[base + 4],
      tz: floats[base + 5],
      nx: floats[base + 6],
      nz: floats[base + 7],
      halfLen: floats[base + 8],
      halfWidthLeft: floats[base + 9],
      halfWidthRight: floats[base + 10],
      trackId: featureTable.getString(trackStrIdxs[j]),
    };
  }
  return out;
}

/**
 * Materializes a full legacy `DecodedTilePayload` from a `CompactDecodedTilePayload`.
 * Used for parity testing and callers that explicitly require eager JS object graphs.
 */
export function materializeDecodedTilePayloadFromCompact(
  compact: CompactDecodedTilePayload
): DecodedTilePayload {
  const table = new LazyTileFeatureTable(compact.featureTable);
  const featureInfos = table.toArray();

  const meshes: TileMeshRecord[] = compact.meshes.map((m) => {
    const groups: TileMeshGroupRecord[] = new Array(m.groupCount);
    for (let g = 0; g < m.groupCount; g++) {
      const base = (m.groupOffset + g) * 3;
      groups[g] = {
        start: compact.packedGroups[base],
        count: compact.packedGroups[base + 1],
        materialIndex: compact.packedGroups[base + 2],
      };
    }
    const faceRanges: TileFaceRangeRecord[] = new Array(m.faceRangeCount);
    for (let r = 0; r < m.faceRangeCount; r++) {
      const base = (m.faceRangeOffset + r) * 3;
      faceRanges[r] = {
        startFace: compact.packedFaceRanges[base],
        endFace: compact.packedFaceRanges[base + 1],
        infoIdx: compact.packedFaceRanges[base + 2] | 0,
      };
    }
    return {
      layer: m.layer,
      name: m.name,
      materialSlotKeys: m.materialSlotKeys,
      renderOrder: m.renderOrder,
      flags: m.flags,
      localPositionOffset: m.localPositionOffset,
      bboxMin: m.bboxMin,
      bboxMax: m.bboxMax,
      positions: m.positions,
      normals: m.normals,
      uvs: m.uvs,
      switchAttrs: m.switchAttrs,
      colors: m.colors,
      indices: m.indices,
      groups,
      faceRanges,
      singleFeatureIdx: m.singleFeatureIdx,
      bvh: m.bvh,
      chunkKey: m.chunkKey,
    };
  });

  const instancedBatches: TileInstancedBatchRecord[] = compact.instancedBatches.map(
    (b) => ({
      layer: b.layer,
      name: b.name,
      materialSlotKey: b.materialSlotKey,
      prototypeKind: b.prototypeKind,
      renderOrder: b.renderOrder,
      flags: b.flags,
      bboxMin: b.bboxMin,
      bboxMax: b.bboxMax,
      instanceCount: b.instanceCount,
      matrices: b.matrices,
      instanceColors: b.instanceColors,
      instanceFeatureIdxs: b.instanceFeatureIdxs,
      sleeperBoxes:
        b.sleeperBoxFloats && b.sleeperBoxTrackStrIdxs
          ? materializeSleeperBoxesFromCompact(
              b.sleeperBoxFloats,
              b.sleeperBoxTrackStrIdxs,
              table,
              0,
              0
            )
          : null,
      chunkKey: b.chunkKey,
      ...(b.preparedSpatialIndex ? { preparedSpatialIndex: b.preparedSpatialIndex } : {}),
    })
  );

  return {
    formatVersion: compact.formatVersion,
    lod: compact.lod,
    tx: compact.tx,
    ty: compact.ty,
    tileCenterX: compact.tileCenterX,
    tileCenterZ: compact.tileCenterZ,
    tileSizeMeters: compact.tileSizeMeters,
    overhangBoundsMin: compact.overhangBoundsMin,
    overhangBoundsMax: compact.overhangBoundsMax,
    flags: compact.flags,
    renderedFeaturesCount: compact.renderedFeaturesCount,
    forestTreesCount: compact.forestTreesCount,
    sleeper3DBoxCount: compact.sleeper3DBoxCount,
    totalVertices: compact.totalVertices,
    totalTriangles: compact.totalTriangles,
    totalDrawCalls: compact.totalDrawCalls,
    railwayRenderSource: compact.railwayRenderSource,
    featureInfos,
    meshes,
    instancedBatches,
    byteLength: compact.byteLength,
  };
}
