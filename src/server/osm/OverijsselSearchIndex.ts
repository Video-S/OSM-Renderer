import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { geoToUtm32N } from '../../world/tiling/RegionalProjection';
import { formatTileId } from '../../world/tiling/TileGrid';
import type {
  TileManifestEntry,
  TilePackMetadata,
} from '../../world/tiling/TilePackContract';
import {
  OVERIJSSEL_SEARCH_INDEX_SCHEMA_VERSION,
  resolveOverijsselSearchIndexPath,
} from './overijsselConfig';
import {
  OverijsselIndexMissingError,
  OverijsselOsmStore,
  type OverijsselSnapshotMetadata,
  type OverijsselStoreOpenOptions,
} from './OverijsselOsmStore';

export type SearchFeatureCategory =
  | 'place'
  | 'street'
  | 'station'
  | 'building'
  | 'poi'
  | 'address';

export type SearchMosaicCoverageStatus =
  | 'covered'
  | 'empty_tile'
  | 'outside_mosaic'
  | 'unknown';

export interface ActiveMosaicCoverageContext {
  mosaicName: string | null;
  packPath: string | null;
  metadata: TilePackMetadata;
  tiles: readonly TileManifestEntry[];
}

export interface SearchDestinationCoverage {
  status: SearchMosaicCoverageStatus;
  tx: number | null;
  ty: number | null;
  tileKey: string | null;
  worldX: number | null;
  worldZ: number | null;
  reason: string | null;
}

export interface LocalSearchResultItem {
  id: string;
  osmType: 'node' | 'way' | 'relation';
  osmId: number;
  category: SearchFeatureCategory;
  subtype: string;
  name: string;
  displayLabel: string;
  locality: string | null;
  street: string | null;
  housenumber: string | null;
  postcode: string | null;
  lon: number;
  lat: number;
  utmEasting: number;
  utmNorthing: number;
  coverage: SearchDestinationCoverage;
}

export interface OverijsselSearchMetadata {
  searchSchemaVersion: string;
  snapshotId: string;
  snapshotMode: string;
  sourceSha256: string;
  sourceFile: string;
  spatialIndexPath: string;
  builtAtIso: string;
  entryCount: number;
  categoryCounts: Record<SearchFeatureCategory, number>;
}

export interface OverijsselSearchQueryResponse {
  query: string;
  category: SearchFeatureCategory | 'all';
  totalReturned: number;
  elapsedMs: number;
  snapshotId: string;
  mosaicName: string | null;
  results: LocalSearchResultItem[];
}

export class OverijsselSearchIndexMissingError extends Error {
  constructor(
    message: string,
    public readonly searchIndexPath: string
  ) {
    super(message);
    this.name = 'OverijsselSearchIndexMissingError';
  }
}

export class OverijsselSearchIndexIncompatibleError extends OverijsselSearchIndexMissingError {
  constructor(
    message: string,
    searchIndexPath: string,
    public readonly reason: string
  ) {
    super(message, searchIndexPath);
    this.name = 'OverijsselSearchIndexIncompatibleError';
  }
}

export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSearchQuery(query: string): string[] {
  const norm = normalizeSearchText(query);
  // Keep alphanumeric/unicode-folded tokens and split punctuation cleanly
  const raw = norm.split(/[^a-z0-9]+/i).filter((t) => t.length > 0);
  // Deduplicate identical tokens while preserving order
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const t of raw) {
    if (!seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  }
  return tokens.slice(0, 8);
}

const EXCLUDED_HIGHWAY_TAGS = new Set([
  'bus_stop',
  'crossing',
  'give_way',
  'milestone',
  'passing_place',
  'speed_camera',
  'stop',
  'street_lamp',
  'traffic_mirror',
  'traffic_signals',
  'turning_circle',
  'turning_loop',
]);

const HIGHWAY_RANK: Record<string, number> = {
  motorway: 95,
  motorway_link: 90,
  trunk: 88,
  trunk_link: 84,
  primary: 82,
  primary_link: 78,
  secondary: 76,
  secondary_link: 72,
  tertiary: 70,
  tertiary_link: 66,
  unclassified: 60,
  residential: 58,
  living_street: 55,
  pedestrian: 52,
  road: 50,
  service: 40,
  cycleway: 35,
  footway: 30,
  path: 28,
  track: 24,
  steps: 20,
};

const PLACE_PRIORITY: Record<string, number> = {
  city: 140,
  town: 132,
  village: 122,
  suburb: 112,
  quarter: 108,
  hamlet: 102,
  neighbourhood: 98,
  isolated_dwelling: 78,
};

const EXCLUDED_RELATION_TYPES = new Set([
  'route',
  'superroute',
  'route_master',
  'network',
  'public_transport',
  'tmc',
  'tmc:area',
  'restriction',
  'enforcement',
  'boundary',
]);

function parseTagsJson(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : null;
  } catch {
    return null;
  }
}

interface CandidatePlace {
  name: string;
  subtype: string;
  utmEasting: number;
  utmNorthing: number;
  rank: number;
}

interface PendingSearchRow {
  osmType: 'node' | 'way' | 'relation';
  osmId: number;
  category: SearchFeatureCategory;
  subtype: string;
  name: string;
  displayLabel: string;
  locality: string | null;
  street: string | null;
  housenumber: string | null;
  postcode: string | null;
  lon: number;
  lat: number;
  utmEasting: number;
  utmNorthing: number;
  priority: number;
  dedupKey: string;
  rankTieBreaker: number;
}

function classifyOsmTags(
  tags: Record<string, string>,
  osmType: 'node' | 'way' | 'relation'
): {
  category: SearchFeatureCategory;
  subtype: string;
  name: string;
  street: string | null;
  housenumber: string | null;
  postcode: string | null;
  localityTag: string | null;
  priority: number;
  rankTieBreaker: number;
} | null {
  if (osmType === 'relation' && tags.type && EXCLUDED_RELATION_TYPES.has(tags.type)) {
    return null;
  }

  const rawName = typeof tags.name === 'string' ? tags.name.trim() : '';
  const addrStreet = typeof tags['addr:street'] === 'string' ? tags['addr:street'].trim() : '';
  const addrHouse =
    typeof tags['addr:housenumber'] === 'string' ? tags['addr:housenumber'].trim() : '';
  const addrPostcode =
    typeof tags['addr:postcode'] === 'string' ? tags['addr:postcode'].trim() : null;
  const addrCity =
    typeof tags['addr:city'] === 'string'
      ? tags['addr:city'].trim()
      : typeof tags['addr:place'] === 'string'
        ? tags['addr:place'].trim()
        : null;

  // 1. Settlements / Places
  if (tags.place && rawName && PLACE_PRIORITY[tags.place] !== undefined) {
    return {
      category: 'place',
      subtype: tags.place,
      name: rawName,
      street: null,
      housenumber: null,
      postcode: null,
      localityTag: addrCity ?? (typeof tags['is_in:municipality'] === 'string' ? tags['is_in:municipality'].trim() : null),
      priority: PLACE_PRIORITY[tags.place],
      rankTieBreaker: PLACE_PRIORITY[tags.place],
    };
  }

  // 2. Railway Stations / Halts
  if (
    rawName &&
    (tags.railway === 'station' ||
      tags.railway === 'halt' ||
      tags.railway === 'tram_stop' ||
      (tags.public_transport === 'station' && tags.train === 'yes'))
  ) {
    const subtype = tags.railway || tags.public_transport || 'station';
    const isMainStation = tags.railway === 'station';
    return {
      category: 'station',
      subtype,
      name: rawName,
      street: addrStreet || null,
      housenumber: addrHouse || null,
      postcode: addrPostcode,
      localityTag: addrCity,
      priority: isMainStation ? 96 : 86,
      rankTieBreaker: isMainStation ? 96 : 86,
    };
  }

  // 3. Streets / Highways
  if (
    osmType === 'way' &&
    tags.highway &&
    !EXCLUDED_HIGHWAY_TAGS.has(tags.highway) &&
    rawName
  ) {
    const hwRank = HIGHWAY_RANK[tags.highway] ?? 25;
    return {
      category: 'street',
      subtype: tags.highway,
      name: rawName,
      street: rawName,
      housenumber: null,
      postcode: addrPostcode,
      localityTag: addrCity,
      priority: 76,
      rankTieBreaker: hwRank,
    };
  }

  // 4. Named POIs (amenity / shop / tourism / leisure / historic / office / sport / craft)
  const poiKey =
    tags.amenity ||
    tags.shop ||
    tags.tourism ||
    tags.leisure ||
    tags.historic ||
    tags.office ||
    tags.sport ||
    tags.craft;
  if (rawName && poiKey) {
    return {
      category: 'poi',
      subtype: poiKey,
      name: rawName,
      street: addrStreet || null,
      housenumber: addrHouse || null,
      postcode: addrPostcode,
      localityTag: addrCity,
      priority: 64,
      rankTieBreaker: tags.amenity || tags.tourism ? 65 : 55,
    };
  }

  // 5. Named Buildings
  if (rawName && tags.building && tags.building !== 'no') {
    return {
      category: 'building',
      subtype: tags.building === 'yes' ? 'building' : tags.building,
      name: rawName,
      street: addrStreet || null,
      housenumber: addrHouse || null,
      postcode: addrPostcode,
      localityTag: addrCity,
      priority: 66,
      rankTieBreaker: 66,
    };
  }

  // 6. Genuine Tagged Addresses (addr:street + addr:housenumber)
  if (addrStreet && addrHouse) {
    const addressName = `${addrStreet} ${addrHouse}`;
    return {
      category: 'address',
      subtype: 'address',
      name: addressName,
      street: addrStreet,
      housenumber: addrHouse,
      postcode: addrPostcode,
      localityTag: addrCity,
      priority: 52,
      rankTieBreaker: osmType === 'node' ? 54 : 52,
    };
  }

  return null;
}

function findNearestPlaceName(
  utmE: number,
  utmN: number,
  places: readonly CandidatePlace[],
  maxDistMeters = 5500
): string | null {
  if (places.length === 0) return null;
  let bestScore = Infinity;
  let bestName: string | null = null;
  const maxSq = maxDistMeters * maxDistMeters;
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    const dE = utmE - p.utmEasting;
    const dN = utmN - p.utmNorthing;
    const distSq = dE * dE + dN * dN;
    if (distSq > maxSq) continue;
    // Slight weighting favoring cities/towns/villages over tiny hamlets
    const weight = p.subtype === 'city' ? 0.55 : p.subtype === 'town' ? 0.7 : p.subtype === 'village' ? 0.85 : 1.0;
    const score = distSq * weight;
    if (score < bestScore) {
      bestScore = score;
      bestName = p.name;
    }
  }
  return bestName;
}

export interface BuildOverijsselSearchIndexOptions {
  spatialIndexPath: string;
  outSearchIndexPath?: string;
  expectedSha256?: string;
  expectedSnapshotId?: string;
  allowCustomSnapshot?: boolean;
  onProgress?: (msg: string) => void;
}

export interface BuildOverijsselSearchIndexResult {
  searchIndexPath: string;
  spatialIndexPath: string;
  snapshotId: string;
  sourceSha256: string;
  entryCount: number;
  categoryCounts: Record<SearchFeatureCategory, number>;
  elapsedMs: number;
}

/**
 * Derives a standalone SQLite FTS5 search index (`*.search.sqlite`) directly from
 * a validated `OverijsselOsmStore` database without re-reading the PBF archive.
 */
export function buildOverijsselSearchIndex(
  options: BuildOverijsselSearchIndexOptions
): BuildOverijsselSearchIndexResult {
  const t0 = performance.now();
  const log = options.onProgress ?? ((msg: string) => console.log(msg));
  const spatialIndexPath = path.resolve(options.spatialIndexPath);
  const outSearchPath = path.resolve(
    options.outSearchIndexPath ?? resolveOverijsselSearchIndexPath(spatialIndexPath)
  );

  // Validate source spatial store integrity & provenance first
  const osmStore = new OverijsselOsmStore(spatialIndexPath, {
    expectedSha256: options.expectedSha256,
    expectedSnapshotId: options.expectedSnapshotId,
    allowCustomSnapshot: options.allowCustomSnapshot,
  });
  let meta: OverijsselSnapshotMetadata;
  try {
    meta = osmStore.getSnapshotMetadata();
  } finally {
    osmStore.close();
  }

  log(
    `Building FTS5 local search index from ${path.basename(spatialIndexPath)} (snapshot=${meta.snapshotId})...`
  );

  const srcDb = new DatabaseSync(spatialIndexPath, { readOnly: true });
  const pendingByDedupKey = new Map<string, PendingSearchRow>();
  const nonDedupRows: PendingSearchRow[] = [];
  const candidatePlaces: CandidatePlace[] = [];

  try {
    const selectNodeCoord = srcDb.prepare('SELECT lon, lat FROM nodes WHERE id = ?');

    // 1. Scan tagged nodes
    const nodeStmt = srcDb.prepare(
      'SELECT id, lon, lat, tags_json FROM nodes WHERE tags_json IS NOT NULL'
    );
    for (const row of nodeStmt.iterate() as IterableIterator<{
      id: number;
      lon: number;
      lat: number;
      tags_json: string;
    }>) {
      const tags = parseTagsJson(row.tags_json);
      if (!tags) continue;
      const cls = classifyOsmTags(tags, 'node');
      if (!cls) continue;
      const [utmE, utmN] = geoToUtm32N(row.lon, row.lat);

      if (cls.category === 'place') {
        candidatePlaces.push({
          name: cls.name,
          subtype: cls.subtype,
          utmEasting: utmE,
          utmNorthing: utmN,
          rank: cls.priority,
        });
      }

      const normName = normalizeSearchText(cls.name);
      const normLoc = normalizeSearchText(cls.localityTag ?? '');
      let dedupKey = `node:${row.id}`;
      if (cls.category === 'address') {
        dedupKey = `addr:${normalizeSearchText(cls.street ?? '')}:${normalizeSearchText(
          cls.housenumber ?? ''
        )}:${normalizeSearchText(cls.postcode ?? normLoc)}`;
      }

      const pending: PendingSearchRow = {
        osmType: 'node',
        osmId: row.id,
        category: cls.category,
        subtype: cls.subtype,
        name: cls.name,
        displayLabel: cls.name,
        locality: cls.localityTag,
        street: cls.street,
        housenumber: cls.housenumber,
        postcode: cls.postcode,
        lon: row.lon,
        lat: row.lat,
        utmEasting: utmE,
        utmNorthing: utmN,
        priority: cls.priority,
        dedupKey,
        rankTieBreaker: cls.rankTieBreaker,
      };

      if (cls.category === 'address') {
        const existing = pendingByDedupKey.get(dedupKey);
        if (!existing || pending.rankTieBreaker > existing.rankTieBreaker) {
          pendingByDedupKey.set(dedupKey, pending);
        }
      } else {
        nonDedupRows.push(pending);
      }

      void normName;
    }

    // 2. Scan tagged ways
    const wayStmt = srcDb.prepare(
      'SELECT id, refs_json, tags_json FROM ways WHERE tags_json IS NOT NULL'
    );
    for (const row of wayStmt.iterate() as IterableIterator<{
      id: number;
      refs_json: string;
      tags_json: string;
    }>) {
      const tags = parseTagsJson(row.tags_json);
      if (!tags) continue;
      const cls = classifyOsmTags(tags, 'way');
      if (!cls) continue;

      let refs: number[] = [];
      try {
        refs = JSON.parse(row.refs_json) as number[];
      } catch {
        continue;
      }
      if (!Array.isArray(refs) || refs.length === 0) continue;

      // Sample up to 3 evenly spaced nodes to get representative centroid/midpoint without full ring lookup
      const sampleIndices =
        refs.length === 1
          ? [0]
          : refs.length === 2
            ? [0, 1]
            : [0, Math.floor(refs.length / 2), refs.length - 1];
      let sumLon = 0;
      let sumLat = 0;
      let validCount = 0;
      for (const idx of sampleIndices) {
        const coord = selectNodeCoord.get(refs[idx]) as
          | { lon: number; lat: number }
          | undefined;
        if (coord && Number.isFinite(coord.lon) && Number.isFinite(coord.lat)) {
          sumLon += coord.lon;
          sumLat += coord.lat;
          validCount++;
        }
      }
      if (validCount === 0) continue;
      const lon = sumLon / validCount;
      const lat = sumLat / validCount;
      const [utmE, utmN] = geoToUtm32N(lon, lat);

      if (cls.category === 'street') {
        // Fold split street segments within ~1.5 km grid cells and same explicit locality
        const cellX = Math.floor(utmE / 1500);
        const cellY = Math.floor(utmN / 1500);
        const dedupKey = `street:${normalizeSearchText(cls.name)}:${normalizeSearchText(
          cls.localityTag ?? ''
        )}:${cellX}:${cellY}`;
        const pending: PendingSearchRow = {
          osmType: 'way',
          osmId: row.id,
          category: 'street',
          subtype: cls.subtype,
          name: cls.name,
          displayLabel: cls.name,
          locality: cls.localityTag,
          street: cls.street,
          housenumber: null,
          postcode: cls.postcode,
          lon,
          lat,
          utmEasting: utmE,
          utmNorthing: utmN,
          priority: cls.priority,
          dedupKey,
          rankTieBreaker: cls.rankTieBreaker,
        };
        const existing = pendingByDedupKey.get(dedupKey);
        if (!existing || pending.rankTieBreaker > existing.rankTieBreaker) {
          pendingByDedupKey.set(dedupKey, pending);
        }
      } else if (cls.category === 'address') {
        const dedupKey = `addr:${normalizeSearchText(cls.street ?? '')}:${normalizeSearchText(
          cls.housenumber ?? ''
        )}:${normalizeSearchText(cls.postcode ?? cls.localityTag ?? '')}`;
        const pending: PendingSearchRow = {
          osmType: 'way',
          osmId: row.id,
          category: 'address',
          subtype: cls.subtype,
          name: cls.name,
          displayLabel: cls.name,
          locality: cls.localityTag,
          street: cls.street,
          housenumber: cls.housenumber,
          postcode: cls.postcode,
          lon,
          lat,
          utmEasting: utmE,
          utmNorthing: utmN,
          priority: cls.priority,
          dedupKey,
          rankTieBreaker: cls.rankTieBreaker,
        };
        const existing = pendingByDedupKey.get(dedupKey);
        if (!existing || pending.rankTieBreaker > existing.rankTieBreaker) {
          pendingByDedupKey.set(dedupKey, pending);
        }
      } else {
        nonDedupRows.push({
          osmType: 'way',
          osmId: row.id,
          category: cls.category,
          subtype: cls.subtype,
          name: cls.name,
          displayLabel: cls.name,
          locality: cls.localityTag,
          street: cls.street,
          housenumber: cls.housenumber,
          postcode: cls.postcode,
          lon,
          lat,
          utmEasting: utmE,
          utmNorthing: utmN,
          priority: cls.priority,
          dedupKey: `way:${row.id}`,
          rankTieBreaker: cls.rankTieBreaker,
        });
      }
    }

    // 3. Scan tagged relations (using relation_rtree centroids)
    const relStmt = srcDb.prepare(
      'SELECT r.id, r.tags_json, b.min_lon, b.max_lon, b.min_lat, b.max_lat ' +
        'FROM relations r JOIN relation_rtree b ON b.id = r.id WHERE r.tags_json IS NOT NULL'
    );
    for (const row of relStmt.iterate() as IterableIterator<{
      id: number;
      tags_json: string;
      min_lon: number;
      max_lon: number;
      min_lat: number;
      max_lat: number;
    }>) {
      const tags = parseTagsJson(row.tags_json);
      if (!tags) continue;
      const cls = classifyOsmTags(tags, 'relation');
      if (!cls) continue;
      const lon = (row.min_lon + row.max_lon) * 0.5;
      const lat = (row.min_lat + row.max_lat) * 0.5;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const [utmE, utmN] = geoToUtm32N(lon, lat);

      if (cls.category === 'place') {
        candidatePlaces.push({
          name: cls.name,
          subtype: cls.subtype,
          utmEasting: utmE,
          utmNorthing: utmN,
          rank: cls.priority,
        });
      }

      nonDedupRows.push({
        osmType: 'relation',
        osmId: row.id,
        category: cls.category,
        subtype: cls.subtype,
        name: cls.name,
        displayLabel: cls.name,
        locality: cls.localityTag,
        street: cls.street,
        housenumber: cls.housenumber,
        postcode: cls.postcode,
        lon,
        lat,
        utmEasting: utmE,
        utmNorthing: utmN,
        priority: cls.priority,
        dedupKey: `rel:${row.id}`,
        rankTieBreaker: cls.rankTieBreaker,
      });
    }
  } finally {
    srcDb.close();
  }

  const allEntries = [...nonDedupRows, ...pendingByDedupKey.values()];

  // Fill missing locality display context from nearest OSM settlement when not explicitly tagged
  for (let i = 0; i < allEntries.length; i++) {
    const entry = allEntries[i];
    if (!entry.locality && entry.category !== 'place') {
      entry.locality = findNearestPlaceName(
        entry.utmEasting,
        entry.utmNorthing,
        candidatePlaces
      );
    }
    entry.displayLabel = entry.locality
      ? `${entry.name} · ${entry.locality}`
      : entry.name;
  }

  // Write atomically via temp file
  fs.mkdirSync(path.dirname(outSearchPath), { recursive: true });
  const tempPath = `${outSearchPath}.tmp.${process.pid}`;
  if (fs.existsSync(tempPath)) {
    fs.rmSync(tempPath, { force: true });
  }

  const categoryCounts: Record<SearchFeatureCategory, number> = {
    place: 0,
    street: 0,
    station: 0,
    building: 0,
    poi: 0,
    address: 0,
  };

  const outDb = new DatabaseSync(tempPath);
  let writeSuccess = false;
  try {
    outDb.exec(`
      PRAGMA page_size = 8192;
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -65536;
      PRAGMA locking_mode = EXCLUSIVE;
    `);

    outDb.exec(`
      CREATE TABLE search_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE search_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        osm_type TEXT NOT NULL,
        osm_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        subtype TEXT NOT NULL,
        name TEXT NOT NULL,
        display_label TEXT NOT NULL,
        locality TEXT,
        street TEXT,
        housenumber TEXT,
        postcode TEXT,
        normalized_name TEXT NOT NULL,
        normalized_locality TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        lon REAL NOT NULL,
        lat REAL NOT NULL,
        utm_easting REAL NOT NULL,
        utm_northing REAL NOT NULL,
        category_priority INTEGER NOT NULL,
        dedup_key TEXT NOT NULL
      );

      CREATE INDEX idx_search_entries_category ON search_entries(category);

      CREATE VIRTUAL TABLE search_fts USING fts5(
        name,
        display_label,
        locality,
        street,
        postcode,
        subtype,
        content='search_entries',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);

    const insertEntry = outDb.prepare(`
      INSERT INTO search_entries (
        osm_type, osm_id, category, subtype, name, display_label,
        locality, street, housenumber, postcode,
        normalized_name, normalized_locality, normalized_text,
        lon, lat, utm_easting, utm_northing, category_priority, dedup_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    outDb.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < allEntries.length; i++) {
      const e = allEntries[i];
      const normName = normalizeSearchText(e.name);
      const normLoc = normalizeSearchText(e.locality ?? '');
      const normText = normalizeSearchText(
        [e.name, e.locality, e.street, e.postcode, e.subtype]
          .filter(Boolean)
          .join(' ')
      );
      insertEntry.run(
        e.osmType,
        e.osmId,
        e.category,
        e.subtype,
        e.name,
        e.displayLabel,
        e.locality,
        e.street,
        e.housenumber,
        e.postcode,
        normName,
        normLoc,
        normText,
        e.lon,
        e.lat,
        e.utmEasting,
        e.utmNorthing,
        e.priority,
        e.dedupKey
      );
      categoryCounts[e.category] += 1;
    }
    outDb.exec('COMMIT');

    // Populate FTS5 content index from search_entries
    outDb.exec("INSERT INTO search_fts(search_fts) VALUES('rebuild');");
    outDb.exec("INSERT INTO search_fts(search_fts) VALUES('optimize');");

    const builtAtIso = new Date().toISOString();
    const insertMeta = outDb.prepare(
      'INSERT INTO search_metadata (key, value) VALUES (?, ?)'
    );
    const metaRows: ReadonlyArray<[string, string]> = [
      ['search_schema_version', OVERIJSSEL_SEARCH_INDEX_SCHEMA_VERSION],
      ['snapshot_id', meta.snapshotId],
      ['snapshot_mode', meta.snapshotMode],
      ['source_sha256', meta.sourceSha256],
      ['source_file', meta.sourceFile],
      ['spatial_index_path', spatialIndexPath],
      ['built_at_iso', builtAtIso],
      ['entry_count', String(allEntries.length)],
      ['category_counts_json', JSON.stringify(categoryCounts)],
    ];
    outDb.exec('BEGIN IMMEDIATE');
    for (const [k, v] of metaRows) {
      insertMeta.run(k, v);
    }
    outDb.exec('COMMIT');
    outDb.exec('PRAGMA journal_mode = DELETE;');
    writeSuccess = true;
  } finally {
    outDb.close();
    if (!writeSuccess && fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }

  fs.renameSync(tempPath, outSearchPath);
  const elapsedMs = Number((performance.now() - t0).toFixed(2));
  log(
    `Local FTS5 search index ready: ${outSearchPath} (${allEntries.length.toLocaleString()} entries in ${elapsedMs} ms)`
  );

  return {
    searchIndexPath: outSearchPath,
    spatialIndexPath,
    snapshotId: meta.snapshotId,
    sourceSha256: meta.sourceSha256,
    entryCount: allEntries.length,
    categoryCounts,
    elapsedMs,
  };
}

/**
 * Evaluates whether a geographic / UTM coordinate falls inside an active baked
 * regional mosaic AND inside a non-empty tile (explicitly distinguishing empty
 * border tiles outside the Overijssel OSM extract from populated tiles).
 */
export function evaluateSearchMosaicCoverage(
  utmEasting: number,
  utmNorthing: number,
  mosaicContext?: ActiveMosaicCoverageContext | null
): SearchDestinationCoverage {
  if (!mosaicContext) {
    return {
      status: 'unknown',
      tx: null,
      ty: null,
      tileKey: null,
      worldX: null,
      worldZ: null,
      reason: 'Active regional mosaic manifest unavailable',
    };
  }
  const meta = mosaicContext.metadata;
  const tileSize = meta.tileSizeMeters;
  const tx = Math.floor(utmEasting / tileSize);
  const ty = Math.floor(utmNorthing / tileSize);
  const tileKey = formatTileId(tx, ty);
  const worldX = utmEasting - meta.studyOriginEasting;
  const worldZ = meta.studyOriginNorthing - utmNorthing;

  const minTx = meta.minTx;
  const maxTx = meta.maxTx;
  const minTy = meta.minTy;
  const maxTy = meta.maxTy;
  if (
    typeof minTx === 'number' &&
    typeof maxTx === 'number' &&
    typeof minTy === 'number' &&
    typeof maxTy === 'number' &&
    (tx < minTx || tx > maxTx || ty < minTy || ty > maxTy)
  ) {
    return {
      status: 'outside_mosaic',
      tx,
      ty,
      tileKey,
      worldX,
      worldZ,
      reason: `Outside active mosaic grid (${mosaicContext.mosaicName ?? 'regional mosaic'})`,
    };
  }

  const matchedTile = mosaicContext.tiles.find(
    (t) => t.tx === tx && t.ty === ty
  );
  if (!matchedTile) {
    return {
      status: 'outside_mosaic',
      tx,
      ty,
      tileKey,
      worldX,
      worldZ,
      reason: `Tile ${tileKey} is not present in the active mosaic manifest`,
    };
  }
  if (matchedTile.isEmpty) {
    return {
      status: 'empty_tile',
      tx,
      ty,
      tileKey,
      worldX,
      worldZ,
      reason: `Tile ${tileKey} is empty in the active baked mosaic`,
    };
  }

  return {
    status: 'covered',
    tx,
    ty,
    tileKey,
    worldX,
    worldZ,
    reason: null,
  };
}

/**
 * Read-only FTS5 search store over `<spatialIndex>.search.sqlite` with strict
 * provenance matching against the parent Overijssel spatial store.
 */
export class OverijsselSearchStore {
  private readonly db: DatabaseSync;
  private readonly metadata: OverijsselSearchMetadata;
  private closed = false;

  constructor(
    public readonly searchIndexPath: string,
    public readonly spatialIndexPath: string,
    options?: OverijsselStoreOpenOptions
  ) {
    const resolvedSearch = path.resolve(searchIndexPath);
    const resolvedSpatial = path.resolve(spatialIndexPath);

    // 1. Ensure parent spatial store exists & passes SHA-256 / snapshot verification
    const parentStore = new OverijsselOsmStore(resolvedSpatial, options);
    let parentMeta: OverijsselSnapshotMetadata;
    try {
      parentMeta = parentStore.getSnapshotMetadata();
    } finally {
      parentStore.close();
    }

    if (!fs.existsSync(resolvedSearch)) {
      throw new OverijsselSearchIndexMissingError(
        `Offline Overijssel search index not found at "${resolvedSearch}". Run "npm run osm:build-search-index" to generate it from the spatial SQLite store.`,
        resolvedSearch
      );
    }

    try {
      this.db = new DatabaseSync(resolvedSearch, { readOnly: true });
    } catch (err: any) {
      throw new OverijsselSearchIndexMissingError(
        `Failed to open Overijssel search index at "${resolvedSearch}": ${err?.message ?? err}`,
        resolvedSearch
      );
    }

    try {
      const metaRows = this.db
        .prepare('SELECT key, value FROM search_metadata')
        .all() as Array<{ key: string; value: string }>;
      const metaMap = new Map<string, string>();
      for (const r of metaRows) {
        metaMap.set(r.key, r.value);
      }
      const schemaVersion = metaMap.get('search_schema_version') ?? '';
      const snapshotId = metaMap.get('snapshot_id') ?? '';
      const sourceSha256 = (metaMap.get('source_sha256') ?? '').trim().toLowerCase();

      if (schemaVersion !== OVERIJSSEL_SEARCH_INDEX_SCHEMA_VERSION) {
        throw new OverijsselSearchIndexIncompatibleError(
          `Search index schema mismatch at "${resolvedSearch}": expected ${OVERIJSSEL_SEARCH_INDEX_SCHEMA_VERSION}, found "${schemaVersion}". Run "npm run osm:build-search-index -- --force".`,
          resolvedSearch,
          'schema_version_mismatch'
        );
      }
      if (snapshotId !== parentMeta.snapshotId || sourceSha256 !== parentMeta.sourceSha256) {
        throw new OverijsselSearchIndexIncompatibleError(
          `Search index snapshot provenance mismatch at "${resolvedSearch}": expected snapshot="${parentMeta.snapshotId}" (sha256=${parentMeta.sourceSha256.slice(0, 12)}), found snapshot="${snapshotId}" (sha256=${sourceSha256.slice(0, 12)}). Run "npm run osm:build-search-index -- --force".`,
          resolvedSearch,
          'snapshot_provenance_mismatch'
        );
      }

      let categoryCounts: Record<SearchFeatureCategory, number> = {
        place: 0,
        street: 0,
        station: 0,
        building: 0,
        poi: 0,
        address: 0,
      };
      const countsRaw = metaMap.get('category_counts_json');
      if (countsRaw) {
        try {
          categoryCounts = { ...categoryCounts, ...JSON.parse(countsRaw) };
        } catch {
          // ignore
        }
      }

      this.metadata = {
        searchSchemaVersion: schemaVersion,
        snapshotId,
        snapshotMode: metaMap.get('snapshot_mode') ?? parentMeta.snapshotMode,
        sourceSha256,
        sourceFile: metaMap.get('source_file') ?? parentMeta.sourceFile,
        spatialIndexPath: metaMap.get('spatial_index_path') ?? resolvedSpatial,
        builtAtIso: metaMap.get('built_at_iso') ?? '',
        entryCount: Number(metaMap.get('entry_count') ?? 0),
        categoryCounts,
      };
    } catch (err) {
      this.db.close();
      this.closed = true;
      if (err instanceof OverijsselSearchIndexMissingError || err instanceof OverijsselIndexMissingError) {
        throw err;
      }
      throw new OverijsselSearchIndexIncompatibleError(
        `Invalid Overijssel search index at "${resolvedSearch}": ${err instanceof Error ? err.message : String(err)}`,
        resolvedSearch,
        'corrupt_metadata'
      );
    }
  }

  getMetadata(): OverijsselSearchMetadata {
    return { ...this.metadata };
  }

  search(params: {
    query: string;
    category?: SearchFeatureCategory | 'all';
    limit?: number;
    mosaicContext?: ActiveMosaicCoverageContext | null;
  }): OverijsselSearchQueryResponse {
    if (this.closed) {
      throw new Error('OverijsselSearchStore is closed');
    }
    const t0 = performance.now();
    const rawQuery = params.query.trim();
    const category = params.category ?? 'all';
    const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 20)));
    const tokens = tokenizeSearchQuery(rawQuery);
    const normQuery = normalizeSearchText(rawQuery);

    if (tokens.length === 0) {
      return {
        query: rawQuery,
        category,
        totalReturned: 0,
        elapsedMs: Number((performance.now() - t0).toFixed(2)),
        snapshotId: this.metadata.snapshotId,
        mosaicName: params.mosaicContext?.mosaicName ?? null,
        results: [],
      };
    }

    // Build safe FTS5 prefix expression: `"tok1"* "tok2"*`
    const ftsQuery = tokens.map((tok) => `"${tok.replace(/"/g, '""')}"*`).join(' ');
    const candidateLimit = Math.max(400, limit * 20);

    interface FtsJoinedRow {
      id: number;
      osm_type: 'node' | 'way' | 'relation';
      osm_id: number;
      category: SearchFeatureCategory;
      subtype: string;
      name: string;
      display_label: string;
      locality: string | null;
      street: string | null;
      housenumber: string | null;
      postcode: string | null;
      normalized_name: string;
      normalized_locality: string;
      normalized_text: string;
      lon: number;
      lat: number;
      utm_easting: number;
      utm_northing: number;
      category_priority: number;
      dedup_key: string;
    }

    const sql =
      category !== 'all'
        ? `
          SELECT e.*
          FROM search_fts f
          JOIN search_entries e ON e.id = f.rowid
          WHERE search_fts MATCH ? AND e.category = ?
          ORDER BY bm25(search_fts, 10.0, 4.0, 2.0, 3.0, 1.0, 1.0)
          LIMIT ?
        `
        : `
          SELECT e.*
          FROM search_fts f
          JOIN search_entries e ON e.id = f.rowid
          WHERE search_fts MATCH ?
          ORDER BY bm25(search_fts, 10.0, 4.0, 2.0, 3.0, 1.0, 1.0)
          LIMIT ?
        `;

    const rawRows = (
      category !== 'all'
        ? this.db.prepare(sql).all(ftsQuery, category, candidateLimit)
        : this.db.prepare(sql).all(ftsQuery, candidateLimit)
    ) as unknown as FtsJoinedRow[];

    const scored = rawRows.map((r) => {
      let score = r.category_priority;
      if (r.normalized_name === normQuery) {
        score += 1000;
      } else if (r.normalized_name.startsWith(normQuery)) {
        score += 520;
      } else if (
        r.normalized_name.includes(normQuery) ||
        r.normalized_text.startsWith(normQuery)
      ) {
        score += 240;
      }
      let tokenMatches = 0;
      for (const t of tokens) {
        if (r.normalized_name.includes(t)) {
          tokenMatches += 2;
        } else if (r.normalized_text.includes(t)) {
          tokenMatches += 1;
        }
      }
      score += tokenMatches * 35;

      const coverage = evaluateSearchMosaicCoverage(
        r.utm_easting,
        r.utm_northing,
        params.mosaicContext
      );
      if (coverage.status === 'covered') {
        score += 45;
      }

      return { row: r, score, coverage };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.row.category_priority !== a.row.category_priority) {
        return b.row.category_priority - a.row.category_priority;
      }
      const nameCmp = a.row.name.localeCompare(b.row.name);
      if (nameCmp !== 0) return nameCmp;
      return a.row.osm_id - b.row.osm_id;
    });

    // Deduplicate identical visible entries within the same locality or ~2 km cell
    const seenKeys = new Set<string>();
    const results: LocalSearchResultItem[] = [];
    for (const item of scored) {
      const r = item.row;
      const locKey =
        r.normalized_locality ||
        `${Math.round(r.utm_easting / 2000)},${Math.round(r.utm_northing / 2000)}`;
      const visibleKey = `${r.category}:${r.normalized_name}:${locKey}`;
      if (seenKeys.has(visibleKey)) continue;
      seenKeys.add(visibleKey);

      results.push({
        id: `${r.osm_type}/${r.osm_id}`,
        osmType: r.osm_type,
        osmId: r.osm_id,
        category: r.category,
        subtype: r.subtype,
        name: r.name,
        displayLabel: r.display_label,
        locality: r.locality,
        street: r.street,
        housenumber: r.housenumber,
        postcode: r.postcode,
        lon: r.lon,
        lat: r.lat,
        utmEasting: r.utm_easting,
        utmNorthing: r.utm_northing,
        coverage: item.coverage,
      });

      if (results.length >= limit) break;
    }

    return {
      query: rawQuery,
      category,
      totalReturned: results.length,
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
      snapshotId: this.metadata.snapshotId,
      mosaicName: params.mosaicContext?.mosaicName ?? null,
      results,
    };
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
