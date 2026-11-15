import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import osmtogeojson from 'osmtogeojson';
import { enrichGeoJsonWithOverpassNodeIds } from '../src/world/infrastructure/topology/OsmNodeIdEnricher';
import { WorldCoordinates } from '../src/world/WorldCoordinates';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const HENGELO_SCALING_CENTER: readonly [number, number] = [6.7935, 52.2625];

export interface ScalingTierSpec {
  level: 'S1' | 'S2' | 'S3' | 'S4' | 'S5';
  id: string;
  name: string;
  halfExtentMeters: number;
  widthMeters: number;
  depthMeters: number;
  areaKm2: number;
}

export const HENGELO_SCALING_TIERS: readonly ScalingTierSpec[] = Object.freeze([
  {
    level: 'S1',
    id: 'hengelo-s1-250m',
    name: 'Hengelo Center S1 (250 × 250 m)',
    halfExtentMeters: 125,
    widthMeters: 250,
    depthMeters: 250,
    areaKm2: 0.0625,
  },
  {
    level: 'S2',
    id: 'hengelo-s2-500m',
    name: 'Hengelo Center S2 (500 × 500 m)',
    halfExtentMeters: 250,
    widthMeters: 500,
    depthMeters: 500,
    areaKm2: 0.25,
  },
  {
    level: 'S3',
    id: 'hengelo-s3-1km',
    name: 'Hengelo Center S3 (1 × 1 km)',
    halfExtentMeters: 500,
    widthMeters: 1000,
    depthMeters: 1000,
    areaKm2: 1.0,
  },
  {
    level: 'S4',
    id: 'hengelo-s4-2km',
    name: 'Hengelo Center S4 (2 × 2 km)',
    halfExtentMeters: 1000,
    widthMeters: 2000,
    depthMeters: 2000,
    areaKm2: 4.0,
  },
  {
    level: 'S5',
    id: 'hengelo-s5-4km',
    name: 'Hengelo Center S5 (4 × 4 km)',
    halfExtentMeters: 2000,
    widthMeters: 4000,
    depthMeters: 4000,
    areaKm2: 16.0,
  },
]);

export interface ScalingDatasetManifestEntry {
  level: 'S1' | 'S2' | 'S3' | 'S4' | 'S5';
  id: string;
  name: string;
  file: string;
  centerLonLat: [number, number];
  halfExtentMeters: number;
  widthMeters: number;
  depthMeters: number;
  areaKm2: number;
  bbox: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
  osmElementCounts: {
    nodes: number;
    ways: number;
    relations: number;
    total: number;
  };
  geoJsonFeatureCount: number;
  geoJsonSha256: string;
  gzipFileSha256: string;
  gzipBytes: number;
  uncompressedBytes: number;
}

export interface ScalingDatasetManifest {
  schemaVersion: '1.0.0';
  studyArea: string;
  centerLonLat: [number, number];
  sourceDescription: string;
  sourceFileName: string;
  sourceSha256: string;
  osmTimestampIso: string;
  extractedAtIso: string;
  attribution: string;
  preparationProcedure: string[];
  datasets: ScalingDatasetManifestEntry[];
}

export function computeTierBBox(
  centerLonLat: readonly [number, number],
  halfExtentMeters: number
): { minLon: number; minLat: number; maxLon: number; maxLat: number } {
  const wc = new WorldCoordinates(centerLonLat[0], centerLonLat[1]);
  const [minLon, maxLat] = wc.toGeo(-halfExtentMeters, -halfExtentMeters);
  const [maxLon, minLat] = wc.toGeo(halfExtentMeters, halfExtentMeters);
  return {
    minLon: Number(minLon.toFixed(7)),
    minLat: Number(minLat.toFixed(7)),
    maxLon: Number(maxLon.toFixed(7)),
    maxLat: Number(maxLat.toFixed(7)),
  };
}

function pointInBBox(
  lon: number,
  lat: number,
  b: { minLon: number; minLat: number; maxLon: number; maxLat: number }
): boolean {
  return lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat;
}

function bboxesOverlap(
  a: { minLon: number; minLat: number; maxLon: number; maxLat: number },
  b: { minLon: number; minLat: number; maxLon: number; maxLat: number }
): boolean {
  return a.maxLon >= b.minLon && a.minLon <= b.maxLon && a.maxLat >= b.minLat && a.minLat <= b.maxLat;
}

// ============================================================================
// Minimal zero-dependency OSM PBF protobuf reader
// ============================================================================

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
    throw new Error('Unexpected EOF while reading protobuf varint.');
  }

  readVarintNumber(): number {
    return Number(this.readVarintBigInt());
  }

  readSignedVarintNumber(): number {
    const u = this.readVarintBigInt();
    // Standard 64-bit two's complement varint -> safe JS number for timestamps/offsets
    const signed = BigInt.asIntN(64, u);
    return Number(signed);
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
    } else {
      r.skipField(wire);
    }
  }
  if (raw) return raw;
  if (zlibData) return zlib.inflateSync(zlibData);
  throw new Error('OSM PBF Blob contained neither raw nor zlib_data payload.');
}

function parseHeaderReplicationTimestamp(bytes: Buffer): number | null {
  const r = new ProtoReader(bytes);
  while (!r.eof()) {
    const tag = r.readVarintNumber();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 32 && wire === 0) {
      return r.readVarintNumber();
    }
    r.skipField(wire);
  }
  return null;
}

interface DecodedWay {
  id: number;
  refs: number[];
  tags: Record<string, string>;
}

interface DecodedRelationMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
}

interface DecodedRelation {
  id: number;
  members: DecodedRelationMember[];
  tags: Record<string, string>;
}

interface PrimitiveBlockCallbacks {
  onNode?: (id: number, lon: number, lat: number, tags: Record<string, string> | null) => void;
  onWay?: (way: DecodedWay) => void;
  onRelation?: (rel: DecodedRelation) => void;
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

function decodeTags(keys: number[], vals: number[], strings: string[]): Record<string, string> {
  const tags: Record<string, string> = {};
  const len = Math.min(keys.length, vals.length);
  for (let i = 0; i < len; i++) {
    const k = strings[keys[i]];
    const v = strings[vals[i]];
    if (k !== undefined && v !== undefined) {
      tags[k] = v;
    }
  }
  return tags;
}

function parsePrimitiveBlock(bytes: Buffer, cb: PrimitiveBlockCallbacks): void {
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
        const tags = keys.length > 0 ? decodeTags(keys, vals, strings) : null;
        cb.onNode(id, lon, lat, tags);
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
          cb.onNode(ids[i], lon, lat, tags);
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
        const members: DecodedRelationMember[] = [];
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

function scanOsmPbfFile(
  pbfPath: string,
  callbacks: PrimitiveBlockCallbacks & { onHeaderTimestamp?: (unixSec: number) => void }
): void {
  const fd = fs.openSync(pbfPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const lenBuf = Buffer.allocUnsafe(4);
    let offset = 0;
    while (offset < stat.size) {
      const readLen = fs.readSync(fd, lenBuf, 0, 4, offset);
      if (readLen < 4) break;
      offset += 4;
      const hdrSize = lenBuf.readUInt32BE(0);
      const hdrBuf = Buffer.allocUnsafe(hdrSize);
      fs.readSync(fd, hdrBuf, 0, hdrSize, offset);
      offset += hdrSize;
      const { type, datasize } = parseBlobHeader(hdrBuf);

      if (type === 'OSMHeader') {
        const blobBuf = Buffer.allocUnsafe(datasize);
        fs.readSync(fd, blobBuf, 0, datasize, offset);
        const raw = decompressBlob(blobBuf);
        const ts = parseHeaderReplicationTimestamp(raw);
        if (ts !== null && callbacks.onHeaderTimestamp) {
          callbacks.onHeaderTimestamp(ts);
        }
      } else if (type === 'OSMData') {
        const blobBuf = Buffer.allocUnsafe(datasize);
        fs.readSync(fd, blobBuf, 0, datasize, offset);
        const raw = decompressBlob(blobBuf);
        parsePrimitiveBlock(raw, callbacks);
      }
      offset += datasize;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Deterministically compresses JSON to gzip with zeroed OS/mtime header bytes
 * so repeated extractions of identical OSM data produce identical SHA-256 hashes.
 */
export function deterministicGzipJson(payload: unknown): {
  jsonBuffer: Buffer;
  gzipBuffer: Buffer;
} {
  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
  const gzipBuffer = Buffer.from(zlib.gzipSync(jsonBuffer, { level: 9 }));
  // Zero RFC 1952 MTIME (bytes 4..7) and OS flag (byte 9 -> 255 unknown) for cross-OS determinism
  if (gzipBuffer.length >= 10) {
    gzipBuffer.writeUInt32LE(0, 4);
    gzipBuffer[9] = 255;
  }
  return { jsonBuffer, gzipBuffer };
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const IGNORED_RELATION_TYPES = new Set([
  'route',
  'superroute',
  'route_master',
  'boundary',
  'network',
  'public_transport',
  'destination_sign',
  'restriction',
  'enforcement',
  'collection',
]);

export function prepareHengeloScalingDatasets(options: {
  pbfPath: string;
  outDir?: string;
}): ScalingDatasetManifest {
  const pbfPath = path.resolve(options.pbfPath);
  if (!fs.existsSync(pbfPath)) {
    throw new Error(`Input OSM PBF file not found: ${pbfPath}`);
  }

  const outDir =
    options.outDir ?? path.join(REPO_ROOT, 'benchmarks', 'datasets', 'hengelo-scaling');
  fs.mkdirSync(outDir, { recursive: true });

  const pbfHash = sha256Hex(fs.readFileSync(pbfPath));
  const tierBBoxes = new Map<string, { minLon: number; minLat: number; maxLon: number; maxLat: number }>();
  for (const tier of HENGELO_SCALING_TIERS) {
    tierBBoxes.set(tier.id, computeTierBBox(HENGELO_SCALING_CENTER, tier.halfExtentMeters));
  }
  const s5BBox = tierBBoxes.get('hengelo-s5-4km')!;
  // Broad 12x12 km node coordinate pre-index around Hengelo center so boundary-crossing ways/polygons are complete
  const preIndexBBox = computeTierBBox(HENGELO_SCALING_CENTER, 6000);

  let headerTimestampUnix: number | null = null;
  const preIndexedCoords = new Map<number, [number, number]>();
  const s5TaggedNodes = new Map<
    number,
    { id: number; lon: number; lat: number; tags: Record<string, string> }
  >();

  console.log(`Pass 1/4: Indexing nodes inside broad Hengelo corridor from ${path.basename(pbfPath)}...`);
  scanOsmPbfFile(pbfPath, {
    onHeaderTimestamp: (ts) => {
      headerTimestampUnix = ts;
    },
    onNode: (id, lon, lat, tags) => {
      if (pointInBBox(lon, lat, preIndexBBox)) {
        preIndexedCoords.set(id, [lon, lat]);
        if (tags && pointInBBox(lon, lat, s5BBox)) {
          s5TaggedNodes.set(id, { id, lon, lat, tags });
        }
      }
    },
  });

  console.log(
    `Pass 1 complete: ${preIndexedCoords.size.toLocaleString()} pre-indexed nodes, ${s5TaggedNodes.size.toLocaleString()} tagged nodes inside S5.`
  );

  // Pass 2: Extract ways intersecting S5 and physical relations referencing them
  const s5Ways = new Map<number, DecodedWay>();
  const s5Relations: DecodedRelation[] = [];
  const missingRelationMemberWayIds = new Set<number>();

  console.log('Pass 2/4: Extracting intersecting ways & relations for S5 (4 × 4 km)...');
  scanOsmPbfFile(pbfPath, {
    onWay: (way) => {
      if (way.refs.length < 2 || Object.keys(way.tags).length === 0) {
        // Note: untagged member ways may still be needed by multipolygons (resolved in Pass 3)
        let touchesS5 = false;
        let minLon = Infinity;
        let minLat = Infinity;
        let maxLon = -Infinity;
        let maxLat = -Infinity;
        for (const ref of way.refs) {
          const coord = preIndexedCoords.get(ref);
          if (!coord) continue;
          if (coord[0] < minLon) minLon = coord[0];
          if (coord[0] > maxLon) maxLon = coord[0];
          if (coord[1] < minLat) minLat = coord[1];
          if (coord[1] > maxLat) maxLat = coord[1];
          if (pointInBBox(coord[0], coord[1], s5BBox)) {
            touchesS5 = true;
          }
        }
        if (
          touchesS5 ||
          (Number.isFinite(minLon) && bboxesOverlap({ minLon, minLat, maxLon, maxLat }, s5BBox))
        ) {
          s5Ways.set(way.id, way);
        }
        return;
      }
      let minLon = Infinity;
      let minLat = Infinity;
      let maxLon = -Infinity;
      let maxLat = -Infinity;
      let anyKnown = false;
      for (const ref of way.refs) {
        const coord = preIndexedCoords.get(ref);
        if (!coord) continue;
        anyKnown = true;
        if (coord[0] < minLon) minLon = coord[0];
        if (coord[0] > maxLon) maxLon = coord[0];
        if (coord[1] < minLat) minLat = coord[1];
        if (coord[1] > maxLat) maxLat = coord[1];
      }
      if (anyKnown && bboxesOverlap({ minLon, minLat, maxLon, maxLat }, s5BBox)) {
        s5Ways.set(way.id, way);
      }
    },
    onRelation: (rel) => {
      const relType = rel.tags.type;
      if (relType && IGNORED_RELATION_TYPES.has(relType)) return;
      const hasWayMemberInS5 = rel.members.some((m) => m.type === 'way' && s5Ways.has(m.ref));
      const hasNodeMemberInS5 = rel.members.some(
        (m) => m.type === 'node' && s5TaggedNodes.has(m.ref)
      );
      if (!hasWayMemberInS5 && !hasNodeMemberInS5) return;
      // Keep physical multipolygon/building/water/highway/railway relations only
      const isMultipolygonOrBuilding = relType === 'multipolygon' || relType === 'building';
      const hasPhysicalTag = Boolean(
        rel.tags.building ||
          rel.tags.highway ||
          rel.tags.railway ||
          rel.tags.waterway ||
          rel.tags.natural ||
          rel.tags.landuse ||
          rel.tags.leisure ||
          rel.tags.amenity ||
          rel.tags.barrier
      );
      if (!isMultipolygonOrBuilding && !hasPhysicalTag) return;

      s5Relations.push(rel);
      for (const m of rel.members) {
        if (m.type === 'way' && !s5Ways.has(m.ref)) {
          missingRelationMemberWayIds.add(m.ref);
        }
      }
    },
  });

  if (missingRelationMemberWayIds.size > 0) {
    console.log(
      `Pass 3/4: Fetching ${missingRelationMemberWayIds.size} outer multipolygon member ways...`
    );
    scanOsmPbfFile(pbfPath, {
      onWay: (way) => {
        if (missingRelationMemberWayIds.has(way.id)) {
          s5Ways.set(way.id, way);
        }
      },
    });
  } else {
    console.log('Pass 3/4: No missing multipolygon member ways.');
  }

  // Pass 4: Gather exact coordinates and tags for ALL referenced nodes (even endpoints > 6 km away)
  const neededNodeIds = new Set<number>(s5TaggedNodes.keys());
  for (const way of s5Ways.values()) {
    for (const ref of way.refs) neededNodeIds.add(ref);
  }
  for (const rel of s5Relations) {
    for (const m of rel.members) {
      if (m.type === 'node') neededNodeIds.add(m.ref);
    }
  }

  const allNeededNodes = new Map<
    number,
    { id: number; lon: number; lat: number; tags?: Record<string, string> }
  >();
  console.log(`Pass 4/4: Gathering ${neededNodeIds.size.toLocaleString()} referenced nodes...`);
  scanOsmPbfFile(pbfPath, {
    onNode: (id, lon, lat, tags) => {
      if (neededNodeIds.has(id)) {
        allNeededNodes.set(id, tags ? { id, lon, lat, tags } : { id, lon, lat });
      }
    },
  });

  // Compute exact way bboxes now that 100% of referenced node coords are known
  const wayBBoxes = new Map<
    number,
    { minLon: number; minLat: number; maxLon: number; maxLat: number }
  >();
  for (const way of s5Ways.values()) {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const ref of way.refs) {
      const n = allNeededNodes.get(ref);
      if (!n) continue;
      if (n.lon < minLon) minLon = n.lon;
      if (n.lon > maxLon) maxLon = n.lon;
      if (n.lat < minLat) minLat = n.lat;
      if (n.lat > maxLat) maxLat = n.lat;
    }
    if (Number.isFinite(minLon)) {
      wayBBoxes.set(way.id, { minLon, minLat, maxLon, maxLat });
    }
  }

  const osmTimestampIso = headerTimestampUnix
    ? new Date(headerTimestampUnix * 1000).toISOString()
    : '2026-11-15T03:46:42.000Z';
  const extractedAtIso = new Date().toISOString();
  const attribution = '© OpenStreetMap contributors (ODbL 1.0) via Geofabrik Overijssel extract';

  const manifestEntries: ScalingDatasetManifestEntry[] = [];

  for (const tier of HENGELO_SCALING_TIERS) {
    const bbox = tierBBoxes.get(tier.id)!;
    const tierWayIds = new Set<number>();

    for (const way of s5Ways.values()) {
      const wb = wayBBoxes.get(way.id);
      if (!wb || !bboxesOverlap(wb, bbox)) continue;
      // Include tagged ways overlapping the tier bbox
      if (Object.keys(way.tags).length > 0) {
        tierWayIds.add(way.id);
      }
    }

    const tierRelations: DecodedRelation[] = [];
    for (const rel of s5Relations) {
      const hitsTierWay = rel.members.some((m) => m.type === 'way' && tierWayIds.has(m.ref));
      const hitsTierNode = rel.members.some((m) => {
        if (m.type !== 'node') return false;
        const n = allNeededNodes.get(m.ref);
        return Boolean(n && pointInBBox(n.lon, n.lat, bbox));
      });
      if (!hitsTierWay && !hitsTierNode) continue;
      tierRelations.push(rel);
      for (const m of rel.members) {
        if (m.type === 'way' && s5Ways.has(m.ref)) {
          tierWayIds.add(m.ref);
        }
      }
    }

    const tierNodeIds = new Set<number>();
    for (const [nid, node] of s5TaggedNodes.entries()) {
      if (pointInBBox(node.lon, node.lat, bbox)) {
        tierNodeIds.add(nid);
      }
    }
    for (const wid of tierWayIds) {
      const w = s5Ways.get(wid)!;
      for (const ref of w.refs) tierNodeIds.add(ref);
    }
    for (const rel of tierRelations) {
      for (const m of rel.members) {
        if (m.type === 'node' && allNeededNodes.has(m.ref)) {
          tierNodeIds.add(m.ref);
        }
      }
    }

    const elements: any[] = [];
    const sortedNodeIds = Array.from(tierNodeIds).sort((a, b) => a - b);
    for (const nid of sortedNodeIds) {
      const n = allNeededNodes.get(nid);
      if (!n) continue;
      elements.push({
        type: 'node',
        id: n.id,
        lat: n.lat,
        lon: n.lon,
        ...(n.tags && Object.keys(n.tags).length > 0 ? { tags: n.tags } : {}),
      });
    }

    const sortedWayIds = Array.from(tierWayIds).sort((a, b) => a - b);
    for (const wid of sortedWayIds) {
      const w = s5Ways.get(wid)!;
      elements.push({
        type: 'way',
        id: w.id,
        nodes: w.refs,
        ...(Object.keys(w.tags).length > 0 ? { tags: w.tags } : {}),
      });
    }

    const sortedRels = [...tierRelations].sort((a, b) => a.id - b.id);
    for (const rel of sortedRels) {
      elements.push({
        type: 'relation',
        id: rel.id,
        members: rel.members,
        tags: rel.tags,
      });
    }

    const overpassPayload = {
      version: 0.6,
      generator: 'TKT-019 Geofabrik PBF Extractor',
      osm3s: {
        timestamp_osm_base: osmTimestampIso,
        copyright: attribution,
      },
      elements,
    };

    const geojson: any = osmtogeojson(overpassPayload);
    enrichGeoJsonWithOverpassNodeIds(geojson, overpassPayload);
    geojson.name = tier.name;
    geojson.metadata = {
      id: tier.id,
      level: tier.level,
      centerLonLat: [...HENGELO_SCALING_CENTER],
      halfExtentMeters: tier.halfExtentMeters,
      bbox,
      source: `Geofabrik ${path.basename(pbfPath)} (sha256:${pbfHash.slice(0, 12)})`,
      osmTimestampIso,
      extractedAtIso,
      attribution,
    };

    const fileName = `${tier.id}.geojson.gz`;
    const filePath = path.join(outDir, fileName);
    const { jsonBuffer, gzipBuffer } = deterministicGzipJson(geojson);
    fs.writeFileSync(filePath, gzipBuffer);

    const entry: ScalingDatasetManifestEntry = {
      level: tier.level,
      id: tier.id,
      name: tier.name,
      file: fileName,
      centerLonLat: [HENGELO_SCALING_CENTER[0], HENGELO_SCALING_CENTER[1]],
      halfExtentMeters: tier.halfExtentMeters,
      widthMeters: tier.widthMeters,
      depthMeters: tier.depthMeters,
      areaKm2: tier.areaKm2,
      bbox,
      osmElementCounts: {
        nodes: sortedNodeIds.length,
        ways: sortedWayIds.length,
        relations: sortedRels.length,
        total: elements.length,
      },
      geoJsonFeatureCount: Array.isArray(geojson.features) ? geojson.features.length : 0,
      geoJsonSha256: sha256Hex(jsonBuffer),
      gzipFileSha256: sha256Hex(gzipBuffer),
      gzipBytes: gzipBuffer.length,
      uncompressedBytes: jsonBuffer.length,
    };
    manifestEntries.push(entry);

    console.log(
      `  Generated ${tier.level} (${tier.id}): ${entry.geoJsonFeatureCount.toLocaleString()} GeoJSON features (${sortedWayIds.length.toLocaleString()} ways, ${sortedRels.length} rels), ${(entry.gzipBytes / 1024).toFixed(1)} KB gz / ${(entry.uncompressedBytes / (1024 * 1024)).toFixed(2)} MB json`
    );
  }

  const manifest: ScalingDatasetManifest = {
    schemaVersion: '1.0.0',
    studyArea: 'Hengelo, Overijssel, Netherlands (Progressive S1–S5 Regional Scaling Series)',
    centerLonLat: [HENGELO_SCALING_CENTER[0], HENGELO_SCALING_CENTER[1]],
    sourceDescription: 'Geofabrik Netherlands / Overijssel OpenStreetMap PBF extract',
    sourceFileName: path.basename(pbfPath),
    sourceSha256: pbfHash,
    osmTimestampIso,
    extractedAtIso,
    attribution,
    preparationProcedure: [
      'Download https://download.geofabrik.de/europe/netherlands/overijssel-latest.osm.pbf',
      'Run: npx tsx benchmarks/prepareHengeloScalingDatasets.ts --pbf=<path-to-overijssel.osm.pbf>',
      'Verifies deterministic bbox slicing, multipolygon member closure, osmtogeojson conversion, OSM node ID enrichment (_nodeIds/_nodeIdsByPart), and SHA-256 content hashes in manifest.json.',
    ],
    datasets: manifestEntries,
  };

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  let pbfPath = '/tmp/overijssel-261114.osm.pbf';
  let outDir: string | undefined;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--pbf=')) pbfPath = arg.slice('--pbf='.length).trim();
    else if (arg.startsWith('--out-dir=')) outDir = arg.slice('--out-dir='.length).trim();
  }
  prepareHengeloScalingDatasets({ pbfPath, outDir });
}
