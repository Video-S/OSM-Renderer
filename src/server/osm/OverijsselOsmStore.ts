import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import osmtogeojson from 'osmtogeojson';
import { enrichGeoJsonWithOverpassNodeIds } from '../../world/infrastructure/topology/OsmNodeIdEnricher';
import {
  OVERIJSSEL_ATTRIBUTION,
  OVERIJSSEL_HISTORICAL_BENCHMARK_SHA256,
  OVERIJSSEL_INDEX_SCHEMA_VERSION,
  OVERIJSSEL_OSM_TIMESTAMP_ISO,
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  OVERIJSSEL_PBF_FILENAME,
  OVERIJSSEL_SNAPSHOT_ID,
  type OverijsselSnapshotMode,
} from './overijsselConfig';

export interface OverijsselSnapshotMetadata {
  schemaVersion: string;
  snapshotId: string;
  snapshotMode: OverijsselSnapshotMode;
  sourceFile: string;
  sourceSha256: string;
  sourceMd5?: string;
  sourceBytes?: number;
  osmTimestampIso: string;
  attribution: string;
  indexedAtIso: string;
  nodeCount: number;
  taggedNodeCount: number;
  wayCount: number;
  relationCount: number;
  bbox: {
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
  };
}

export interface OverijsselStoreOpenOptions {
  expectedSha256?: string;
  expectedSnapshotId?: string;
  allowCustomSnapshot?: boolean;
}

export interface OverijsselBBoxQuery {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  locationName?: string;
}

export interface OverijsselRegionQuery {
  centerLat: number;
  centerLon: number;
  radiusMeters: number;
  locationName?: string;
}

export interface OverijsselQueryResult {
  geojson: any;
  timings: {
    spatialQueryMs: number;
    osmtogeojsonMs: number;
    nodeIdEnrichMs: number;
  };
  counts: {
    nodes: number;
    ways: number;
    relations: number;
    features: number;
  };
  snapshotMetadata: OverijsselSnapshotMetadata;
}

export class OverijsselIndexMissingError extends Error {
  constructor(
    message: string,
    public readonly indexPath: string
  ) {
    super(message);
    this.name = 'OverijsselIndexMissingError';
  }
}

export class OverijsselIndexIncompatibleError extends OverijsselIndexMissingError {
  constructor(
    message: string,
    indexPath: string,
    public readonly expectedSha256: string,
    public readonly actualSha256: string
  ) {
    super(message, indexPath);
    this.name = 'OverijsselIndexIncompatibleError';
  }
}

interface StoredNodeRow {
  id: number;
  lon: number;
  lat: number;
  tags_json: string | null;
}

interface StoredWayRow {
  id: number;
  refs_json: string;
  tags_json: string | null;
}

interface StoredRelationRow {
  id: number;
  members_json: string;
  tags_json: string | null;
}

interface StoredRelationMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
}

/**
 * 32-bit IEEE 754 float R*Tree rounding margin (~10m in lon/lat degrees) applied to
 * R*Tree prefiltering before exact 64-bit coordinate boundary verification.
 */
const RTREE_FLOAT32_PAD_DEG = 1e-4;
const SQLITE_IN_CHUNK_SIZE = 500;

const COLLECTION_ONLY_RELATION_TYPES = new Set([
  'route',
  'superroute',
  'route_master',
  'network',
  'public_transport',
  'tmc',
  'tmc:area',
]);

function shouldExpandRelationMembers(
  tags: Record<string, string> | null,
  members: StoredRelationMember[]
): boolean {
  const relType = tags?.type;
  if (relType === 'multipolygon' || relType === 'building') {
    return true;
  }
  if (relType === 'boundary') {
    // Administrative borders span entire provinces/municipalities; expand protected areas/parks cleanly
    return tags?.boundary !== 'administrative';
  }
  if (relType === 'route') {
    return tags?.route === 'ferry';
  }
  if (relType && COLLECTION_ONLY_RELATION_TYPES.has(relType)) {
    return false;
  }
  if (
    relType === 'waterway' ||
    relType === 'bridge' ||
    relType === 'tunnel' ||
    relType === 'railway' ||
    relType === 'site' ||
    relType === 'restriction' ||
    relType === 'enforcement' ||
    relType === 'associatedStreet'
  ) {
    return members.length <= 500;
  }
  return members.length <= 150;
}

export function computeRegionBBox(
  centerLat: number,
  centerLon: number,
  radiusMeters: number
): { minLon: number; minLat: number; maxLon: number; maxLat: number } {
  const dLat = radiusMeters / 111320;
  const dLon = radiusMeters / (111320 * Math.cos((centerLat * Math.PI) / 180));
  return {
    minLon: Number((centerLon - dLon).toFixed(5)),
    minLat: Number((centerLat - dLat).toFixed(5)),
    maxLon: Number((centerLon + dLon).toFixed(5)),
    maxLat: Number((centerLat + dLat).toFixed(5)),
  };
}

/**
 * Persistent read-only SQLite + R*Tree spatial store for the immutable Overijssel OSM snapshot.
 * Queries bounding boxes directly on disk without loading the regional dataset into memory.
 */
export class OverijsselOsmStore {
  private readonly db: DatabaseSync;
  private readonly metadata: OverijsselSnapshotMetadata;
  private closed = false;

  private readonly stmtTaggedNodesInBBox: StatementSync;
  private readonly stmtWaysInBBox: StatementSync;
  private readonly stmtRelsInBBox: StatementSync;
  private readonly stmtNodesBatch500: StatementSync;
  private readonly stmtWaysBatch500: StatementSync;

  constructor(
    public readonly indexPath: string,
    options?: OverijsselStoreOpenOptions
  ) {
    const resolved = path.resolve(indexPath);
    if (!fs.existsSync(resolved)) {
      throw new OverijsselIndexMissingError(
        `Offline Overijssel OSM spatial index not found at "${resolved}". ` +
          `Run "npm run osm:setup-overijssel" (or "npm run osm:fetch-overijssel && npm run osm:build-overijssel-index") to prepare the local dataset.`,
        resolved
      );
    }

    try {
      this.db = new DatabaseSync(resolved, { readOnly: true });
    } catch (err: any) {
      throw new OverijsselIndexMissingError(
        `Failed to open Overijssel OSM spatial index at "${resolved}": ${err?.message ?? err}`,
        resolved
      );
    }

    try {
      const metaRows = this.db.prepare('SELECT key, value FROM metadata').all() as Array<{
        key: string;
        value: string;
      }>;
      const metaMap = new Map<string, string>();
      for (const r of metaRows) {
        metaMap.set(r.key, r.value);
      }
      const schemaVersion = metaMap.get('schema_version');
      const snapshotId = metaMap.get('snapshot_id');
      const sourceSha256 = (metaMap.get('source_sha256') ?? '').trim().toLowerCase();
      if (!schemaVersion || !snapshotId || !sourceSha256) {
        throw new Error(
          'Missing required snapshot metadata keys (schema_version, snapshot_id, source_sha256) in SQLite metadata table.'
        );
      }
      if (schemaVersion !== OVERIJSSEL_INDEX_SCHEMA_VERSION) {
        throw new Error(
          `Unsupported spatial index schema version "${schemaVersion}" (expected "${OVERIJSSEL_INDEX_SCHEMA_VERSION}").`
        );
      }

      const snapshotMode: OverijsselSnapshotMode =
        metaMap.get('snapshot_mode') === 'custom' ? 'custom' : 'canonical';
      const expectedSha = options?.expectedSha256?.trim().toLowerCase();

      if (expectedSha && sourceSha256 !== expectedSha) {
        throw new OverijsselIndexIncompatibleError(
          `Incompatible Overijssel SQLite spatial index at "${resolved}": ` +
            `expected source SHA-256 ${expectedSha}, found ${sourceSha256} (snapshot=${snapshotId}). ` +
            `Rebuild with "npm run osm:setup-overijssel -- --force" or "npx tsx scripts/setup-overijssel.ts --force".`,
          resolved,
          expectedSha,
          sourceSha256
        );
      }

      if (
        !expectedSha &&
        !options?.allowCustomSnapshot &&
        snapshotMode !== 'custom' &&
        sourceSha256 !== OVERIJSSEL_PBF_EXPECTED_SHA256
      ) {
        const historicalNote =
          sourceSha256 === OVERIJSSEL_HISTORICAL_BENCHMARK_SHA256
            ? ' (matches archived TKT-019/TKT-022 snapshot rather than the verified canonical Geofabrik snapshot)'
            : '';
        throw new OverijsselIndexIncompatibleError(
          `Incompatible Overijssel SQLite spatial index at "${resolved}"${historicalNote}: ` +
            `expected canonical snapshot ${OVERIJSSEL_SNAPSHOT_ID} (SHA-256 ${OVERIJSSEL_PBF_EXPECTED_SHA256}), ` +
            `found snapshot "${snapshotId}" (SHA-256 ${sourceSha256}). ` +
            `Run "npm run osm:setup-overijssel" (or "npx tsx scripts/setup-overijssel.ts --force") to install the verified snapshot, ` +
            `or rebuild intentionally with "npx tsx scripts/build-overijssel-index.ts --allow-custom-snapshot".`,
          resolved,
          OVERIJSSEL_PBF_EXPECTED_SHA256,
          sourceSha256
        );
      }

      if (options?.expectedSnapshotId && snapshotId !== options.expectedSnapshotId) {
        throw new OverijsselIndexIncompatibleError(
          `Incompatible Overijssel SQLite spatial index snapshot_id at "${resolved}": ` +
            `expected "${options.expectedSnapshotId}", found "${snapshotId}" (SHA-256 ${sourceSha256}).`,
          resolved,
          expectedSha ?? OVERIJSSEL_PBF_EXPECTED_SHA256,
          sourceSha256
        );
      }

      const rawBytes = metaMap.get('source_bytes');
      const parsedBytes = rawBytes ? Number(rawBytes) : undefined;
      this.metadata = {
        schemaVersion,
        snapshotId,
        snapshotMode,
        sourceFile: metaMap.get('source_file') ?? OVERIJSSEL_PBF_FILENAME,
        sourceSha256,
        ...(metaMap.get('source_md5') ? { sourceMd5: metaMap.get('source_md5') } : {}),
        ...(parsedBytes !== undefined && Number.isFinite(parsedBytes)
          ? { sourceBytes: parsedBytes }
          : {}),
        osmTimestampIso: metaMap.get('osm_timestamp_iso') ?? OVERIJSSEL_OSM_TIMESTAMP_ISO,
        attribution: metaMap.get('attribution') ?? OVERIJSSEL_ATTRIBUTION,
        indexedAtIso: metaMap.get('indexed_at_iso') ?? '',
        nodeCount: Number(metaMap.get('node_count') ?? 0),
        taggedNodeCount: Number(metaMap.get('tagged_node_count') ?? 0),
        wayCount: Number(metaMap.get('way_count') ?? 0),
        relationCount: Number(metaMap.get('relation_count') ?? 0),
        bbox: {
          minLon: Number(metaMap.get('bbox_min_lon') ?? 0),
          maxLon: Number(metaMap.get('bbox_max_lon') ?? 0),
          minLat: Number(metaMap.get('bbox_min_lat') ?? 0),
          maxLat: Number(metaMap.get('bbox_max_lat') ?? 0),
        },
      };

      this.stmtTaggedNodesInBBox = this.db.prepare(
        `SELECT n.id, n.lon, n.lat, n.tags_json
         FROM tagged_node_rtree r
         JOIN nodes n ON n.id = r.id
         WHERE r.min_lon <= ? AND r.max_lon >= ? AND r.min_lat <= ? AND r.max_lat >= ?`
      );
      this.stmtWaysInBBox = this.db.prepare(
        `SELECT w.id, w.refs_json, w.tags_json
         FROM way_rtree r
         JOIN ways w ON w.id = r.id
         WHERE r.min_lon <= ? AND r.max_lon >= ? AND r.min_lat <= ? AND r.max_lat >= ?`
      );
      this.stmtRelsInBBox = this.db.prepare(
        `SELECT rel.id, rel.members_json, rel.tags_json
         FROM relation_rtree r
         JOIN relations rel ON rel.id = r.id
         WHERE r.min_lon <= ? AND r.max_lon >= ? AND r.min_lat <= ? AND r.max_lat >= ?`
      );
      const batchPlaceholders = new Array(SQLITE_IN_CHUNK_SIZE).fill('?').join(',');
      this.stmtNodesBatch500 = this.db.prepare(
        `SELECT id, lon, lat, tags_json FROM nodes WHERE id IN (${batchPlaceholders})`
      );
      this.stmtWaysBatch500 = this.db.prepare(
        `SELECT id, refs_json, tags_json FROM ways WHERE id IN (${batchPlaceholders})`
      );
    } catch (err: any) {
      this.close();
      if (err instanceof OverijsselIndexMissingError) {
        throw err;
      }
      throw new OverijsselIndexMissingError(
        `Invalid or incomplete Overijssel OSM spatial index at "${resolved}": ${err?.message ?? err}. ` +
          `Rebuild with "npm run osm:build-overijssel-index".`,
        resolved
      );
    }
  }

  getSnapshotMetadata(): OverijsselSnapshotMetadata {
    return this.metadata;
  }

  isOpen(): boolean {
    return !this.closed;
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        this.db.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  private fetchNodesByIds(ids: number[]): StoredNodeRow[] {
    if (ids.length === 0) return [];
    const results: StoredNodeRow[] = [];
    for (let i = 0; i < ids.length; i += SQLITE_IN_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + SQLITE_IN_CHUNK_SIZE);
      if (chunk.length === SQLITE_IN_CHUNK_SIZE) {
        const rows = this.stmtNodesBatch500.all(...chunk) as unknown as StoredNodeRow[];
        for (const r of rows) results.push(r);
      } else {
        const placeholders = chunk.map(() => '?').join(',');
        const rows = this.db
          .prepare(`SELECT id, lon, lat, tags_json FROM nodes WHERE id IN (${placeholders})`)
          .all(...chunk) as unknown as StoredNodeRow[];
        for (const r of rows) results.push(r);
      }
    }
    return results;
  }

  private fetchWaysByIds(ids: number[]): StoredWayRow[] {
    if (ids.length === 0) return [];
    const results: StoredWayRow[] = [];
    for (let i = 0; i < ids.length; i += SQLITE_IN_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + SQLITE_IN_CHUNK_SIZE);
      if (chunk.length === SQLITE_IN_CHUNK_SIZE) {
        const rows = this.stmtWaysBatch500.all(...chunk) as unknown as StoredWayRow[];
        for (const r of rows) results.push(r);
      } else {
        const placeholders = chunk.map(() => '?').join(',');
        const rows = this.db
          .prepare(`SELECT id, refs_json, tags_json FROM ways WHERE id IN (${placeholders})`)
          .all(...chunk) as unknown as StoredWayRow[];
        for (const r of rows) results.push(r);
      }
    }
    return results;
  }

  private fetchRelationsByIds(ids: number[]): StoredRelationRow[] {
    if (ids.length === 0) return [];
    const results: StoredRelationRow[] = [];
    for (let i = 0; i < ids.length; i += SQLITE_IN_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + SQLITE_IN_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT id, members_json, tags_json FROM relations WHERE id IN (${placeholders})`)
        .all(...chunk) as unknown as StoredRelationRow[];
      for (const r of rows) results.push(r);
    }
    return results;
  }

  queryRegion(query: OverijsselRegionQuery): OverijsselQueryResult {
    const bbox = computeRegionBBox(query.centerLat, query.centerLon, query.radiusMeters);
    return this.queryBBox({
      ...bbox,
      locationName: query.locationName ?? 'Location',
    });
  }

  queryBBox(query: OverijsselBBoxQuery): OverijsselQueryResult {
    if (this.closed) {
      throw new Error('OverijsselOsmStore has been closed.');
    }

    const tQuery0 = performance.now();
    const { minLon, minLat, maxLon, maxLat } = query;
    const padMaxLon = maxLon + RTREE_FLOAT32_PAD_DEG;
    const padMinLon = minLon - RTREE_FLOAT32_PAD_DEG;
    const padMaxLat = maxLat + RTREE_FLOAT32_PAD_DEG;
    const padMinLat = minLat - RTREE_FLOAT32_PAD_DEG;

    const nodesMap = new Map<
      number,
      { id: number; lon: number; lat: number; tags?: Record<string, string> }
    >();
    const waysMap = new Map<
      number,
      { id: number; refs: number[]; tags?: Record<string, string> }
    >();
    const relsMap = new Map<
      number,
      { id: number; members: StoredRelationMember[]; tags?: Record<string, string> }
    >();

    // 1. All tagged nodes strictly inside the exact bounding box (zero tag filtering)
    const taggedNodeRows = this.stmtTaggedNodesInBBox.all(
      padMaxLon,
      padMinLon,
      padMaxLat,
      padMinLat
    ) as unknown as StoredNodeRow[];
    for (const row of taggedNodeRows) {
      if (row.lon >= minLon && row.lon <= maxLon && row.lat >= minLat && row.lat <= maxLat) {
        const tags = row.tags_json ? (JSON.parse(row.tags_json) as Record<string, string>) : undefined;
        nodesMap.set(row.id, tags ? { id: row.id, lon: row.lon, lat: row.lat, tags } : { id: row.id, lon: row.lon, lat: row.lat });
      }
    }

    // 2. All ways whose bounding boxes overlap the query region
    const wayRows = this.stmtWaysInBBox.all(
      padMaxLon,
      padMinLon,
      padMaxLat,
      padMinLat
    ) as unknown as StoredWayRow[];
    for (const row of wayRows) {
      const refs = JSON.parse(row.refs_json) as number[];
      const tags = row.tags_json ? (JSON.parse(row.tags_json) as Record<string, string>) : undefined;
      waysMap.set(row.id, tags ? { id: row.id, refs, tags } : { id: row.id, refs });
    }

    // 3. All relations whose bounding boxes overlap the query region
    const relRows = this.stmtRelsInBBox.all(
      padMaxLon,
      padMinLon,
      padMaxLat,
      padMinLat
    ) as unknown as StoredRelationRow[];
    const pendingExpandRels: Array<{
      id: number;
      members: StoredRelationMember[];
      tags: Record<string, string> | null;
    }> = [];

    for (const row of relRows) {
      const members = JSON.parse(row.members_json) as StoredRelationMember[];
      const tags = row.tags_json ? (JSON.parse(row.tags_json) as Record<string, string>) : null;
      relsMap.set(row.id, tags ? { id: row.id, members, tags } : { id: row.id, members });
      if (shouldExpandRelationMembers(tags, members)) {
        pendingExpandRels.push({ id: row.id, members, tags });
      }
    }

    // 4. Expand member closure (including nested child relations up to depth 2) for multipolygons & physical structures
    const missingNodeIds = new Set<number>();
    const missingWayIds = new Set<number>();
    let frontier = pendingExpandRels;
    for (let depth = 0; depth < 2 && frontier.length > 0; depth++) {
      const missingRelIds: number[] = [];
      for (const rel of frontier) {
        for (const m of rel.members) {
          if (m.type === 'way' && !waysMap.has(m.ref)) {
            missingWayIds.add(m.ref);
          } else if (m.type === 'node' && !nodesMap.has(m.ref)) {
            missingNodeIds.add(m.ref);
          } else if (m.type === 'relation' && !relsMap.has(m.ref)) {
            missingRelIds.push(m.ref);
          }
        }
      }
      if (missingRelIds.length === 0) break;
      const childRelRows = this.fetchRelationsByIds(Array.from(new Set(missingRelIds)));
      const nextFrontier: typeof frontier = [];
      for (const row of childRelRows) {
        const members = JSON.parse(row.members_json) as StoredRelationMember[];
        const tags = row.tags_json ? (JSON.parse(row.tags_json) as Record<string, string>) : null;
        relsMap.set(row.id, tags ? { id: row.id, members, tags } : { id: row.id, members });
        if (shouldExpandRelationMembers(tags, members)) {
          nextFrontier.push({ id: row.id, members, tags });
        }
      }
      frontier = nextFrontier;
    }

    if (missingWayIds.size > 0) {
      const extraWays = this.fetchWaysByIds(Array.from(missingWayIds));
      for (const row of extraWays) {
        const refs = JSON.parse(row.refs_json) as number[];
        const tags = row.tags_json ? (JSON.parse(row.tags_json) as Record<string, string>) : undefined;
        waysMap.set(row.id, tags ? { id: row.id, refs, tags } : { id: row.id, refs });
      }
    }

    // 5. Gather 100% of all node coordinates referenced by any included way
    for (const way of waysMap.values()) {
      for (let i = 0; i < way.refs.length; i++) {
        const ref = way.refs[i];
        if (!nodesMap.has(ref)) {
          missingNodeIds.add(ref);
        }
      }
    }

    if (missingNodeIds.size > 0) {
      const extraNodes = this.fetchNodesByIds(Array.from(missingNodeIds));
      for (const row of extraNodes) {
        const tags = row.tags_json ? (JSON.parse(row.tags_json) as Record<string, string>) : undefined;
        nodesMap.set(
          row.id,
          tags
            ? { id: row.id, lon: row.lon, lat: row.lat, tags }
            : { id: row.id, lon: row.lon, lat: row.lat }
        );
      }
    }

    // 6. Assemble deterministic Overpass-compatible element list
    const elements: any[] = [];
    const sortedNodeIds = Array.from(nodesMap.keys()).sort((a, b) => a - b);
    for (const id of sortedNodeIds) {
      const n = nodesMap.get(id)!;
      elements.push({
        type: 'node',
        id: n.id,
        lat: n.lat,
        lon: n.lon,
        ...(n.tags ? { tags: n.tags } : {}),
      });
    }

    const sortedWayIds = Array.from(waysMap.keys()).sort((a, b) => a - b);
    for (const id of sortedWayIds) {
      const w = waysMap.get(id)!;
      elements.push({
        type: 'way',
        id: w.id,
        nodes: w.refs,
        ...(w.tags ? { tags: w.tags } : {}),
      });
    }

    const sortedRelIds = Array.from(relsMap.keys()).sort((a, b) => a - b);
    for (const id of sortedRelIds) {
      const r = relsMap.get(id)!;
      elements.push({
        type: 'relation',
        id: r.id,
        members: r.members,
        ...(r.tags ? { tags: r.tags } : {}),
      });
    }

    const spatialQueryMs = performance.now() - tQuery0;

    const overpassPayload = {
      version: 0.6,
      generator: `TKT-022 Offline Overijssel Spatial Store (${this.metadata.snapshotId})`,
      osm3s: {
        timestamp_osm_base: this.metadata.osmTimestampIso,
        copyright: this.metadata.attribution,
      },
      elements,
    };

    const tConvert0 = performance.now();
    const geojson: any = osmtogeojson(overpassPayload);
    const osmtogeojsonMs = performance.now() - tConvert0;

    const tEnrich0 = performance.now();
    enrichGeoJsonWithOverpassNodeIds(geojson, overpassPayload);
    const nodeIdEnrichMs = performance.now() - tEnrich0;

    geojson.name = query.locationName ?? 'Location';
    geojson.crs = {
      type: 'name',
      properties: {
        name: 'urn:ogc:def:crs:OGC:1.3:CRS84',
      },
    };
    geojson.metadata = {
      source: 'overijssel-offline',
      snapshotId: this.metadata.snapshotId,
      sourceFile: this.metadata.sourceFile,
      sourceSha256: this.metadata.sourceSha256,
      osmTimestampIso: this.metadata.osmTimestampIso,
      attribution: this.metadata.attribution,
      bbox: { minLon, minLat, maxLon, maxLat },
    };

    return {
      geojson,
      timings: {
        spatialQueryMs,
        osmtogeojsonMs,
        nodeIdEnrichMs,
      },
      counts: {
        nodes: sortedNodeIds.length,
        ways: sortedWayIds.length,
        relations: sortedRelIds.length,
        features: Array.isArray(geojson?.features) ? geojson.features.length : 0,
      },
      snapshotMetadata: this.metadata,
    };
  }
}
