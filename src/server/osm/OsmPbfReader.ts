import fs from 'node:fs';
import zlib from 'node:zlib';

export interface DecodedOsmNode {
  id: number;
  lon: number;
  lat: number;
  tags: Record<string, string> | null;
}

export interface DecodedOsmWay {
  id: number;
  refs: number[];
  tags: Record<string, string> | null;
}

export interface DecodedOsmRelationMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
}

export interface DecodedOsmRelation {
  id: number;
  members: DecodedOsmRelationMember[];
  tags: Record<string, string> | null;
}

export interface OsmPbfHeaderInfo {
  replicationTimestampUnix: number | null;
  source: string | null;
  writingProgram: string | null;
}

export interface OsmPbfScanCallbacks {
  onHeader?: (header: OsmPbfHeaderInfo) => void;
  onNode?: (node: DecodedOsmNode) => void;
  onWay?: (way: DecodedOsmWay) => void;
  onRelation?: (relation: DecodedOsmRelation) => void;
  onBlockProgress?: (progress: { blobIndex: number; bytesRead: number; totalBytes: number }) => void;
}

class ProtoReader {
  constructor(
    public readonly buf: Buffer,
    public pos: number = 0,
    public readonly end: number = buf.length
  ) {}

  eof(): boolean {
    return this.pos >= this.end;
  }

  readVarintBigInt(): bigint {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.end) {
      const byte = BigInt(this.buf[this.pos++]);
      result |= (byte & 0x7fn) << shift;
      if ((byte & 0x80n) === 0n) {
        return result;
      }
      shift += 7n;
    }
    throw new Error('Unexpected EOF while reading OSM PBF protobuf varint.');
  }

  readVarintNumber(): number {
    return Number(this.readVarintBigInt());
  }

  readSignedVarintNumber(): number {
    const u = this.readVarintBigInt();
    return Number(BigInt.asIntN(64, u));
  }

  readSint64Number(): number {
    const u = this.readVarintBigInt();
    const zigzag = (u >> 1n) ^ -(u & 1n);
    return Number(zigzag);
  }

  readBytes(): Buffer {
    const len = this.readVarintNumber();
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  skipField(wireType: number): void {
    switch (wireType) {
      case 0:
        this.readVarintBigInt();
        return;
      case 1:
        this.pos += 8;
        return;
      case 2: {
        const len = this.readVarintNumber();
        this.pos += len;
        return;
      }
      case 5:
        this.pos += 4;
        return;
      default:
        throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }
  }
}

function readPackedUint32(bytes: Buffer): number[] {
  const r = new ProtoReader(bytes);
  const out: number[] = [];
  while (!r.eof()) out.push(r.readVarintNumber());
  return out;
}

function readPackedSint64Delta(bytes: Buffer): number[] {
  const r = new ProtoReader(bytes);
  const out: number[] = [];
  let acc = 0;
  while (!r.eof()) {
    acc += r.readSint64Number();
    out.push(acc);
  }
  return out;
}

function readPackedInt32(bytes: Buffer): number[] {
  const r = new ProtoReader(bytes);
  const out: number[] = [];
  while (!r.eof()) out.push(r.readSignedVarintNumber());
  return out;
}

function parseBlobHeader(bytes: Buffer): { type: string; datasize: number } {
  const r = new ProtoReader(bytes);
  let type = '';
  let datasize = 0;
  while (!r.eof()) {
    const tag = r.readVarintNumber();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      type = r.readBytes().toString('utf8');
    } else if (field === 3 && wire === 0) {
      datasize = r.readVarintNumber();
    } else {
      r.skipField(wire);
    }
  }
  return { type, datasize };
}

function decompressBlob(bytes: Buffer): Buffer {
  const r = new ProtoReader(bytes);
  let raw: Buffer | null = null;
  let zlibData: Buffer | null = null;
  while (!r.eof()) {
    const tag = r.readVarintNumber();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      raw = r.readBytes();
    } else if (field === 3 && wire === 2) {
      zlibData = r.readBytes();
    } else if ((field === 4 || field === 5 || field === 6 || field === 7) && wire === 2) {
      throw new Error(`Unsupported OSM PBF blob compression field ${field} (only raw and zlib are supported).`);
    } else {
      r.skipField(wire);
    }
  }
  if (raw) return raw;
  if (zlibData) return zlib.inflateSync(zlibData);
  throw new Error('OSM PBF Blob contained neither raw nor zlib_data payload.');
}

function parseHeaderBlock(bytes: Buffer): OsmPbfHeaderInfo {
  const r = new ProtoReader(bytes);
  let replicationTimestampUnix: number | null = null;
  let writingProgram: string | null = null;
  let source: string | null = null;
  while (!r.eof()) {
    const tag = r.readVarintNumber();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 16 && wire === 2) {
      writingProgram = r.readBytes().toString('utf8');
    } else if (field === 17 && wire === 2) {
      source = r.readBytes().toString('utf8');
    } else if (field === 32 && wire === 0) {
      replicationTimestampUnix = r.readVarintNumber();
    } else {
      r.skipField(wire);
    }
  }
  return { replicationTimestampUnix, source, writingProgram };
}

function decodeStringTable(bytes: Buffer): string[] {
  const r = new ProtoReader(bytes);
  const strings: string[] = [];
  while (!r.eof()) {
    const tag = r.readVarintNumber();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      strings.push(r.readBytes().toString('utf8'));
    } else {
      r.skipField(wire);
    }
  }
  return strings;
}

function decodeTags(
  keys: number[],
  vals: number[],
  strings: string[]
): Record<string, string> | null {
  const len = Math.min(keys.length, vals.length);
  if (len === 0) return null;
  const tags: Record<string, string> = {};
  let count = 0;
  for (let i = 0; i < len; i++) {
    const k = strings[keys[i]];
    const v = strings[vals[i]];
    if (k !== undefined && v !== undefined) {
      tags[k] = v;
      count++;
    }
  }
  return count > 0 ? tags : null;
}

function parsePrimitiveBlock(bytes: Buffer, cb: OsmPbfScanCallbacks): void {
  const r = new ProtoReader(bytes);
  let strings: string[] = [];
  const groupBuffers: Buffer[] = [];
  let granularity = 100;
  let latOffset = 0;
  let lonOffset = 0;

  while (!r.eof()) {
    const tag = r.readVarintNumber();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      strings = decodeStringTable(r.readBytes());
    } else if (field === 2 && wire === 2) {
      groupBuffers.push(r.readBytes());
    } else if (field === 17 && wire === 0) {
      granularity = r.readSignedVarintNumber();
    } else if (field === 19 && wire === 0) {
      latOffset = r.readSignedVarintNumber();
    } else if (field === 20 && wire === 0) {
      lonOffset = r.readSignedVarintNumber();
    } else {
      r.skipField(wire);
    }
  }

  for (const gb of groupBuffers) {
    const gr = new ProtoReader(gb);
    while (!gr.eof()) {
      const gtag = gr.readVarintNumber();
      const gfield = gtag >>> 3;
      const gwire = gtag & 7;

      if (gfield === 1 && gwire === 2 && cb.onNode) {
        const nb = gr.readBytes();
        const nr = new ProtoReader(nb);
        let id = 0;
        let latRaw = 0;
        let lonRaw = 0;
        let keys: number[] = [];
        let vals: number[] = [];
        while (!nr.eof()) {
          const ntag = nr.readVarintNumber();
          const nfield = ntag >>> 3;
          const nwire = ntag & 7;
          if (nfield === 1 && nwire === 0) id = nr.readSint64Number();
          else if (nfield === 2 && nwire === 2) keys = readPackedUint32(nr.readBytes());
          else if (nfield === 3 && nwire === 2) vals = readPackedUint32(nr.readBytes());
          else if (nfield === 8 && nwire === 0) latRaw = nr.readSint64Number();
          else if (nfield === 9 && nwire === 0) lonRaw = nr.readSint64Number();
          else nr.skipField(nwire);
        }
        const lat = Number((1e-9 * (latOffset + granularity * latRaw)).toFixed(7));
        const lon = Number((1e-9 * (lonOffset + granularity * lonRaw)).toFixed(7));
        const tags = decodeTags(keys, vals, strings);
        cb.onNode({ id, lon, lat, tags });
      } else if (gfield === 2 && gwire === 2 && cb.onNode) {
        const db = gr.readBytes();
        const dr = new ProtoReader(db);
        let ids: number[] = [];
        let lats: number[] = [];
        let lons: number[] = [];
        let keysVals: number[] = [];
        while (!dr.eof()) {
          const dtag = dr.readVarintNumber();
          const dfield = dtag >>> 3;
          const dwire = dtag & 7;
          if (dfield === 1 && dwire === 2) ids = readPackedSint64Delta(dr.readBytes());
          else if (dfield === 8 && dwire === 2) lats = readPackedSint64Delta(dr.readBytes());
          else if (dfield === 9 && dwire === 2) lons = readPackedSint64Delta(dr.readBytes());
          else if (dfield === 10 && dwire === 2) keysVals = readPackedInt32(dr.readBytes());
          else dr.skipField(dwire);
        }
        let kvIdx = 0;
        for (let i = 0; i < ids.length; i++) {
          let tags: Record<string, string> | null = null;
          if (kvIdx < keysVals.length) {
            while (kvIdx < keysVals.length) {
              const kIdx = keysVals[kvIdx++];
              if (kIdx === 0) break;
              const vIdx = keysVals[kvIdx++];
              if (!tags) tags = {};
              const k = strings[kIdx];
              const v = strings[vIdx];
              if (k !== undefined && v !== undefined) {
                tags[k] = v;
              }
            }
          }
          const lat = Number((1e-9 * (latOffset + granularity * lats[i])).toFixed(7));
          const lon = Number((1e-9 * (lonOffset + granularity * lons[i])).toFixed(7));
          cb.onNode({ id: ids[i], lon, lat, tags });
        }
      } else if (gfield === 3 && gwire === 2 && cb.onWay) {
        const wb = gr.readBytes();
        const wr = new ProtoReader(wb);
        let id = 0;
        let keys: number[] = [];
        let vals: number[] = [];
        let refs: number[] = [];
        while (!wr.eof()) {
          const wtag = wr.readVarintNumber();
          const wfield = wtag >>> 3;
          const wwire = wtag & 7;
          if (wfield === 1 && wwire === 0) id = Number(wr.readVarintBigInt());
          else if (wfield === 2 && wwire === 2) keys = readPackedUint32(wr.readBytes());
          else if (wfield === 3 && wwire === 2) vals = readPackedUint32(wr.readBytes());
          else if (wfield === 8 && wwire === 2) refs = readPackedSint64Delta(wr.readBytes());
          else wr.skipField(wwire);
        }
        cb.onWay({ id, refs, tags: decodeTags(keys, vals, strings) });
      } else if (gfield === 4 && gwire === 2 && cb.onRelation) {
        const rb = gr.readBytes();
        const rr = new ProtoReader(rb);
        let id = 0;
        let keys: number[] = [];
        let vals: number[] = [];
        let rolesSid: number[] = [];
        let memids: number[] = [];
        let types: number[] = [];
        while (!rr.eof()) {
          const rtag = rr.readVarintNumber();
          const rfield = rtag >>> 3;
          const rwire = rtag & 7;
          if (rfield === 1 && rwire === 0) id = Number(rr.readVarintBigInt());
          else if (rfield === 2 && rwire === 2) keys = readPackedUint32(rr.readBytes());
          else if (rfield === 3 && rwire === 2) vals = readPackedUint32(rr.readBytes());
          else if (rfield === 8 && rwire === 2) rolesSid = readPackedInt32(rr.readBytes());
          else if (rfield === 9 && rwire === 2) memids = readPackedSint64Delta(rr.readBytes());
          else if (rfield === 10 && rwire === 2) types = readPackedUint32(rr.readBytes());
          else rr.skipField(rwire);
        }
        const members: DecodedOsmRelationMember[] = [];
        for (let i = 0; i < memids.length; i++) {
          const mt = types[i] ?? 0;
          members.push({
            type: mt === 1 ? 'way' : mt === 2 ? 'relation' : 'node',
            ref: memids[i],
            role: strings[rolesSid[i]] ?? '',
          });
        }
        cb.onRelation({ id, members, tags: decodeTags(keys, vals, strings) });
      } else {
        gr.skipField(gwire);
      }
    }
  }
}

/**
 * Streams an `.osm.pbf` file sequentially block-by-block in constant memory.
 */
export function scanOsmPbfFile(pbfPath: string, callbacks: OsmPbfScanCallbacks): void {
  const fd = fs.openSync(pbfPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const lenBuf = Buffer.allocUnsafe(4);
    let offset = 0;
    let blobIndex = 0;
    while (offset < stat.size) {
      const readLen = fs.readSync(fd, lenBuf, 0, 4, offset);
      if (readLen < 4) break;
      offset += 4;
      const hdrSize = lenBuf.readUInt32BE(0);
      const hdrBuf = Buffer.allocUnsafe(hdrSize);
      fs.readSync(fd, hdrBuf, 0, hdrSize, offset);
      offset += hdrSize;
      const { type, datasize } = parseBlobHeader(hdrBuf);

      const blobBuf = Buffer.allocUnsafe(datasize);
      fs.readSync(fd, blobBuf, 0, datasize, offset);
      offset += datasize;
      blobIndex++;

      if (type === 'OSMHeader') {
        if (callbacks.onHeader) {
          const raw = decompressBlob(blobBuf);
          callbacks.onHeader(parseHeaderBlock(raw));
        }
      } else if (type === 'OSMData') {
        const raw = decompressBlob(blobBuf);
        parsePrimitiveBlock(raw, callbacks);
      }

      if (callbacks.onBlockProgress && blobIndex % 100 === 0) {
        callbacks.onBlockProgress({
          blobIndex,
          bytesRead: offset,
          totalBytes: stat.size,
        });
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}
