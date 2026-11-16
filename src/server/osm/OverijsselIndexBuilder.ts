import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  OVERIJSSEL_ATTRIBUTION,
  OVERIJSSEL_INDEX_SCHEMA_VERSION,
  OVERIJSSEL_OSM_TIMESTAMP_ISO,
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  OVERIJSSEL_SNAPSHOT_ID,
} from './overijsselConfig';
import { type DecodedOsmRelationMember, scanOsmPbfFile } from './OsmPbfReader';

export interface OverijsselIndexBuildOptions {
  pbfPath: string;
  outIndexPath: string;
  snapshotId?: string;
  expectedSha256?: string;
  allowCustomSnapshot?: boolean;
  onProgress?: (message: string) => void;
}

export interface OverijsselIndexBuildResult {
  indexPath: string;
  pbfPath: string;
  pbfSha256: string;
  snapshotId: string;
  osmTimestampIso: string;
  nodeCount: number;
  taggedNodeCount: number;
  wayCount: number;
  relationCount: number;
  elapsedMs: number;
  indexSizeBytes: number;
}

const SLAB_CAPACITY = 1_048_576;

/**
 * Compact typed-array slab directory for all OSM node coordinates during PBF ingestion.
 * Stores 12M nodes in ~190 MB of off-object heap instead of ~1.5 GB of JS Maps/objects.
 */
class NodeCoordDirectory {
  private slabs: Array<{
    ids: Float64Array;
    lonE7: Int32Array;
    latE7: Int32Array;
    count: number;
    maxId: number;
  }> = [];
  private prevId = -Infinity;
  public isSortedAscending = true;
  public totalCount = 0;

  push(id: number, lon: number, lat: number): void {
    if (id <= this.prevId) {
      this.isSortedAscending = false;
    }
    this.prevId = id;
    this.totalCount++;

    let slab = this.slabs[this.slabs.length - 1];
    if (!slab || slab.count >= SLAB_CAPACITY) {
      slab = {
        ids: new Float64Array(SLAB_CAPACITY),
        lonE7: new Int32Array(SLAB_CAPACITY),
        latE7: new Int32Array(SLAB_CAPACITY),
        count: 0,
        maxId: -Infinity,
      };
      this.slabs.push(slab);
    }

    const idx = slab.count++;
    slab.ids[idx] = id;
    slab.lonE7[idx] = Math.round(lon * 1e7);
    slab.latE7[idx] = Math.round(lat * 1e7);
    slab.maxId = id;
  }

  lookupSorted(id: number): [number, number] | null {
    if (!this.isSortedAscending || this.slabs.length === 0) return null;

    let loSlab = 0;
    let hiSlab = this.slabs.length - 1;
    while (loSlab < hiSlab) {
      const mid = (loSlab + hiSlab) >>> 1;
      if (this.slabs[mid].maxId < id) {
        loSlab = mid + 1;
      } else {
        hiSlab = mid;
      }
    }

    const slab = this.slabs[loSlab];
    if (!slab || id > slab.maxId) return null;

    const ids = slab.ids;
    let lo = 0;
    let hi = slab.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const midId = ids[mid];
      if (midId === id) {
        return [slab.lonE7[mid] * 1e-7, slab.latE7[mid] * 1e-7];
      }
      if (midId < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  clear(): void {
    this.slabs.length = 0;
  }
}

async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function buildOverijsselSpatialIndex(
  options: OverijsselIndexBuildOptions
): Promise<OverijsselIndexBuildResult> {
  const tStart = performance.now();
  const log = options.onProgress ?? ((msg: string) => console.log(msg));

  const pbfPath = path.resolve(options.pbfPath);
  const outIndexPath = path.resolve(options.outIndexPath);
  if (!fs.existsSync(pbfPath)) {
    throw new Error(
      `OSM PBF snapshot file not found at: ${pbfPath}. Run "npm run osm:fetch-overijssel" first.`
    );
  }

  log(`Verifying SHA-256 checksum of ${path.basename(pbfPath)}...`);
  const pbfSha256 = await computeFileSha256(pbfPath);
  const expectedSha = options.expectedSha256 ?? OVERIJSSEL_PBF_EXPECTED_SHA256;
  if (!options.allowCustomSnapshot && expectedSha && pbfSha256 !== expectedSha) {
    throw new Error(
      `Snapshot SHA-256 mismatch for ${pbfPath}: expected ${expectedSha}, got ${pbfSha256}. ` +
        `If intentionally building from a different snapshot, pass --allow-custom-snapshot.`
    );
  }

  fs.mkdirSync(path.dirname(outIndexPath), { recursive: true });
  const tempIndexPath = `${outIndexPath}.tmp.${process.pid}`;
  if (fs.existsSync(tempIndexPath)) {
    fs.rmSync(tempIndexPath, { force: true });
  }

  const db = new DatabaseSync(tempIndexPath);
  const coords = new NodeCoordDirectory();
  let success = false;

  try {
    db.exec(`
      PRAGMA page_size = 8192;
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -131072;
      PRAGMA locking_mode = EXCLUSIVE;
    `);

    db.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY,
        lon REAL NOT NULL,
        lat REAL NOT NULL,
        tags_json TEXT
      );
      CREATE VIRTUAL TABLE tagged_node_rtree USING rtree(
        id, min_lon, max_lon, min_lat, max_lat
      );
      CREATE TABLE ways (
        id INTEGER PRIMARY KEY,
        refs_json TEXT NOT NULL,
        tags_json TEXT
      );
      CREATE VIRTUAL TABLE way_rtree USING rtree(
        id, min_lon, max_lon, min_lat, max_lat
      );
      CREATE TABLE relations (
        id INTEGER PRIMARY KEY,
        members_json TEXT NOT NULL,
        tags_json TEXT
      );
      CREATE VIRTUAL TABLE relation_rtree USING rtree(
        id, min_lon, max_lon, min_lat, max_lat
      );
    `);

    const insertNodeStmt = db.prepare(
      'INSERT OR REPLACE INTO nodes (id, lon, lat, tags_json) VALUES (?, ?, ?, ?)'
    );
    const insertTaggedNodeRtreeStmt = db.prepare(
      'INSERT OR REPLACE INTO tagged_node_rtree (id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)'
    );
    const insertWayStmt = db.prepare(
      'INSERT OR REPLACE INTO ways (id, refs_json, tags_json) VALUES (?, ?, ?)'
    );
    const insertWayRtreeStmt = db.prepare(
      'INSERT OR REPLACE INTO way_rtree (id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)'
    );
    const insertRelStmt = db.prepare(
      'INSERT OR REPLACE INTO relations (id, members_json, tags_json) VALUES (?, ?, ?)'
    );
    const insertRelRtreeStmt = db.prepare(
      'INSERT OR REPLACE INTO relation_rtree (id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)'
    );
    const selectNodeFallbackStmt = db.prepare('SELECT lon, lat FROM nodes WHERE id = ?');
    const selectWayBBoxStmt = db.prepare(
      'SELECT min_lon, max_lon, min_lat, max_lat FROM way_rtree WHERE id = ?'
    );
    const selectRelBBoxStmt = db.prepare(
      'SELECT min_lon, max_lon, min_lat, max_lat FROM relation_rtree WHERE id = ?'
    );

    let headerTimestampUnix: number | null = null;
    let nodeCount = 0;
    let taggedNodeCount = 0;
    let wayCount = 0;
    let relationCount = 0;
    let globalMinLon = Infinity;
    let globalMaxLon = -Infinity;
    let globalMinLat = Infinity;
    let globalMaxLat = -Infinity;

    const TX_BATCH_SIZE = 50_000;
    let inTx = false;
    let txOps = 0;

    const ensureTx = () => {
      if (!inTx) {
        db.exec('BEGIN IMMEDIATE');
        inTx = true;
        txOps = 0;
      }
    };
    const flushTx = (force: boolean = false) => {
      if (inTx && (force || txOps >= TX_BATCH_SIZE)) {
        db.exec('COMMIT');
        inTx = false;
        txOps = 0;
      }
    };

    const resolveNodeCoord = (id: number): [number, number] | null => {
      if (coords.isSortedAscending) {
        return coords.lookupSorted(id);
      }
      const row = selectNodeFallbackStmt.get(id) as { lon: number; lat: number } | undefined;
      return row ? [row.lon, row.lat] : null;
    };

    const nestedRelations: Array<{
      id: number;
      members: DecodedOsmRelationMember[];
    }> = [];

    let phase: 'init' | 'nodes' | 'ways' | 'relations' = 'init';
    log(`Building SQLite + R*Tree spatial index from ${path.basename(pbfPath)}...`);

    scanOsmPbfFile(pbfPath, {
      onHeader: (hdr) => {
        if (hdr.replicationTimestampUnix !== null) {
          headerTimestampUnix = hdr.replicationTimestampUnix;
        }
      },
      onNode: (node) => {
        if (phase !== 'nodes') {
          flushTx(true);
          phase = 'nodes';
        }
        ensureTx();

        const tagsJson = node.tags ? JSON.stringify(node.tags) : null;
        insertNodeStmt.run(node.id, node.lon, node.lat, tagsJson);
        coords.push(node.id, node.lon, node.lat);
        nodeCount++;
        txOps++;

        if (node.lon < globalMinLon) globalMinLon = node.lon;
        if (node.lon > globalMaxLon) globalMaxLon = node.lon;
        if (node.lat < globalMinLat) globalMinLat = node.lat;
        if (node.lat > globalMaxLat) globalMaxLat = node.lat;

        if (tagsJson !== null) {
          insertTaggedNodeRtreeStmt.run(node.id, node.lon, node.lon, node.lat, node.lat);
          taggedNodeCount++;
          txOps++;
        }

        flushTx(false);
      },
      onWay: (way) => {
        if (phase !== 'ways') {
          flushTx(true);
          phase = 'ways';
          log(
            `  Indexed ${nodeCount.toLocaleString()} nodes (${taggedNodeCount.toLocaleString()} tagged). Indexing ways...`
          );
        }
        ensureTx();

        const tagsJson = way.tags ? JSON.stringify(way.tags) : null;
        insertWayStmt.run(way.id, JSON.stringify(way.refs), tagsJson);
        wayCount++;
        txOps++;

        let minLon = Infinity;
        let maxLon = -Infinity;
        let minLat = Infinity;
        let maxLat = -Infinity;
        for (let i = 0; i < way.refs.length; i++) {
          const c = resolveNodeCoord(way.refs[i]);
          if (!c) continue;
          if (c[0] < minLon) minLon = c[0];
          if (c[0] > maxLon) maxLon = c[0];
          if (c[1] < minLat) minLat = c[1];
          if (c[1] > maxLat) maxLat = c[1];
        }
        if (Number.isFinite(minLon)) {
          insertWayRtreeStmt.run(way.id, minLon, maxLon, minLat, maxLat);
          txOps++;
        }

        flushTx(false);
      },
      onRelation: (rel) => {
        if (phase !== 'relations') {
          flushTx(true);
          phase = 'relations';
          log(`  Indexed ${wayCount.toLocaleString()} ways. Indexing relations...`);
        }
        ensureTx();

        const tagsJson = rel.tags ? JSON.stringify(rel.tags) : null;
        insertRelStmt.run(rel.id, JSON.stringify(rel.members), tagsJson);
        relationCount++;
        txOps++;

        let minLon = Infinity;
        let maxLon = -Infinity;
        let minLat = Infinity;
        let maxLat = -Infinity;
        let hasRelationMember = false;

        for (let i = 0; i < rel.members.length; i++) {
          const m = rel.members[i];
          if (m.type === 'node') {
            const c = resolveNodeCoord(m.ref);
            if (!c) continue;
            if (c[0] < minLon) minLon = c[0];
            if (c[0] > maxLon) maxLon = c[0];
            if (c[1] < minLat) minLat = c[1];
            if (c[1] > maxLat) maxLat = c[1];
          } else if (m.type === 'way') {
            const wb = selectWayBBoxStmt.get(m.ref) as
              | { min_lon: number; max_lon: number; min_lat: number; max_lat: number }
              | undefined;
            if (!wb) continue;
            if (wb.min_lon < minLon) minLon = wb.min_lon;
            if (wb.max_lon > maxLon) maxLon = wb.max_lon;
            if (wb.min_lat < minLat) minLat = wb.min_lat;
            if (wb.max_lat > maxLat) maxLat = wb.max_lat;
          } else if (m.type === 'relation') {
            hasRelationMember = true;
          }
        }

        if (Number.isFinite(minLon)) {
          insertRelRtreeStmt.run(rel.id, minLon, maxLon, minLat, maxLat);
          txOps++;
        }
        if (hasRelationMember) {
          nestedRelations.push({ id: rel.id, members: rel.members });
        }

        flushTx(false);
      },
      onBlockProgress: ({ blobIndex, bytesRead, totalBytes }) => {
        const pct = ((bytesRead / Math.max(1, totalBytes)) * 100).toFixed(0);
        log(`  Progress: ${pct}% (blob ${blobIndex}, phase=${phase})`);
      },
    });

    flushTx(true);

    // Resolve bboxes for relations containing nested relation members (2 passes)
    if (nestedRelations.length > 0) {
      for (let pass = 0; pass < 2; pass++) {
        db.exec('BEGIN IMMEDIATE');
        for (const nr of nestedRelations) {
          const existing = selectRelBBoxStmt.get(nr.id) as
            | { min_lon: number; max_lon: number; min_lat: number; max_lat: number }
            | undefined;
          let minLon = existing ? existing.min_lon : Infinity;
          let maxLon = existing ? existing.max_lon : -Infinity;
          let minLat = existing ? existing.min_lat : Infinity;
          let maxLat = existing ? existing.max_lat : -Infinity;
          for (const m of nr.members) {
            if (m.type !== 'relation') continue;
            const child = selectRelBBoxStmt.get(m.ref) as
              | { min_lon: number; max_lon: number; min_lat: number; max_lat: number }
              | undefined;
            if (!child) continue;
            if (child.min_lon < minLon) minLon = child.min_lon;
            if (child.max_lon > maxLon) maxLon = child.max_lon;
            if (child.min_lat < minLat) minLat = child.min_lat;
            if (child.max_lat > maxLat) maxLat = child.max_lat;
          }
          if (Number.isFinite(minLon)) {
            insertRelRtreeStmt.run(nr.id, minLon, maxLon, minLat, maxLat);
          }
        }
        db.exec('COMMIT');
      }
    }

    coords.clear();

    const osmTimestampIso = headerTimestampUnix
      ? new Date(headerTimestampUnix * 1000).toISOString()
      : OVERIJSSEL_OSM_TIMESTAMP_ISO;
    const snapshotId = options.snapshotId ?? OVERIJSSEL_SNAPSHOT_ID;

    const insertMetaStmt = db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)');
    const metaEntries: Array<[string, string]> = [
      ['schema_version', OVERIJSSEL_INDEX_SCHEMA_VERSION],
      ['snapshot_id', snapshotId],
      ['source_file', path.basename(pbfPath)],
      ['source_sha256', pbfSha256],
      ['osm_timestamp_iso', osmTimestampIso],
      ['attribution', OVERIJSSEL_ATTRIBUTION],
      ['indexed_at_iso', new Date().toISOString()],
      ['node_count', String(nodeCount)],
      ['tagged_node_count', String(taggedNodeCount)],
      ['way_count', String(wayCount)],
      ['relation_count', String(relationCount)],
      ['bbox_min_lon', Number.isFinite(globalMinLon) ? String(globalMinLon) : '0'],
      ['bbox_max_lon', Number.isFinite(globalMaxLon) ? String(globalMaxLon) : '0'],
      ['bbox_min_lat', Number.isFinite(globalMinLat) ? String(globalMinLat) : '0'],
      ['bbox_max_lat', Number.isFinite(globalMaxLat) ? String(globalMaxLat) : '0'],
    ];

    db.exec('BEGIN IMMEDIATE');
    for (const [k, v] of metaEntries) {
      insertMetaStmt.run(k, v);
    }
    db.exec('COMMIT');

    log('Finalizing query planner statistics (ANALYZE) & standalone file format...');
    db.exec('ANALYZE;');
    db.exec('PRAGMA journal_mode = DELETE;');
    success = true;

    const elapsedMs = Math.round(performance.now() - tStart);
    db.close();

    if (fs.existsSync(outIndexPath)) {
      fs.rmSync(outIndexPath, { force: true });
    }
    fs.renameSync(tempIndexPath, outIndexPath);
    const stat = fs.statSync(outIndexPath);

    log(
      `Done in ${(elapsedMs / 1000).toFixed(2)} s -> ${outIndexPath} (${(
        stat.size /
        (1024 * 1024)
      ).toFixed(1)} MiB)`
    );

    return {
      indexPath: outIndexPath,
      pbfPath,
      pbfSha256,
      snapshotId,
      osmTimestampIso,
      nodeCount,
      taggedNodeCount,
      wayCount,
      relationCount,
      elapsedMs,
      indexSizeBytes: stat.size,
    };
  } finally {
    try {
      coords.clear();
    } catch {
      // Ignore cleanup errors
    }
    if (!success) {
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
      if (fs.existsSync(tempIndexPath)) {
        try {
          fs.rmSync(tempIndexPath, { force: true });
        } catch {
          // Ignore temp cleanup errors
        }
      }
    }
  }
}
