import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  resolveTilePackPathForTileSize,
  TilePackSqliteStore,
} from '../src/server/tiles/TilePackSqliteStore';
import {
  createRegionalMosaicPlan,
  type RegionalMosaicIndex,
} from '../src/world/tiling/RegionalMosaicPlan';
import {
  analyzeDecodedTileBatching,
  aggregateTileBatchAudits,
  DEFAULT_BATCH_AUDIT_CELL_SIZES,
  type BatchAuditSummary,
  type BatchAuditTile,
} from '../src/world/tiling/TileBatchOpportunityAudit';

export interface BatchAuditCliOptions {
  packPath: string | null;
  regionIndexPath: string | null;
  cellSizesMeters: number[];
  maxTiles: number | null;
  outJson: string;
  outMarkdown: string;
}

export interface BatchAuditReport {
  schemaVersion: 1;
  auditId: 'TKT-030';
  createdAtIso: string;
  mode: 'single-pack' | 'regional-mosaic';
  input: string;
  packsRead: number;
  isPartialSample: boolean;
  sampleLimit: number | null;
  snapshotId: string;
  sourceSha256: string;
  bakeSchemaVersion: string;
  lodPolicyHash: string;
  cellSizesMeters: number[];
  summary: BatchAuditSummary;
  interpretation: string[];
}

const DEFAULT_OUTPUT_DIR = path.resolve('benchmarks/results');

export function parseBatchAuditCli(
  argv: readonly string[] = process.argv.slice(2)
): BatchAuditCliOptions {
  let packPath: string | null = null;
  let regionIndexPath: string | null = null;
  let maxTiles: number | null = null;
  let cellSizesMeters: number[] = [...DEFAULT_BATCH_AUDIT_CELL_SIZES];
  let outJson: string | null = null;
  let outMarkdown: string | null = null;

  for (const arg of argv) {
    if (!arg.startsWith('--') || !arg.includes('=')) {
      throw new Error('Expected --key=value, got ' + arg);
    }
    const [key, value] = [arg.slice(2, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)];
    if (!value) throw new Error('Empty value for --' + key);
    if (key === 'pack') packPath = path.resolve(value);
    else if (key === 'region-index') regionIndexPath = path.resolve(value);
    else if (key === 'max-tiles') {
      maxTiles = Number(value);
      if (!Number.isSafeInteger(maxTiles) || maxTiles < 1) {
        throw new Error('max-tiles must be a positive integer');
      }
    } else if (key === 'cell-meters') {
      cellSizesMeters = value.split(',').map((n) => Number(n));
      if (cellSizesMeters.some((n) => !Number.isSafeInteger(n) || n <= 0) ||
          new Set(cellSizesMeters).size !== cellSizesMeters.length) {
        throw new Error('cell-meters must contain unique positive integers');
      }
      cellSizesMeters.sort((a, b) => a - b);
    } else if (key === 'out') outJson = path.resolve(value);
    else if (key === 'markdown-out') outMarkdown = path.resolve(value);
    else throw new Error('Unknown batching audit option --' + key);
  }
  if (packPath && regionIndexPath) {
    throw new Error('Specify either --pack or --region-index, not both');
  }
  const regional = regionIndexPath !== null;
  return {
    packPath: regional ? null : packPath ?? resolveTilePackPathForTileSize(1024),
    regionIndexPath,
    cellSizesMeters,
    maxTiles,
    outJson: outJson ?? path.join(DEFAULT_OUTPUT_DIR,
      regional ? 'tkt030-batching-region.json' : 'tkt030-batching-hengelo-1024m.json'),
    outMarkdown: outMarkdown ?? path.join(DEFAULT_OUTPUT_DIR,
      regional ? 'tkt030-batching-region.md' : 'tkt030-batching-hengelo-1024m.md'),
  };
}

function resolveMosaicPacks(indexFile: string): string[] {
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as RegionalMosaicIndex;
  if (index.schemaVersion !== 1 || !Array.isArray(index.shards)) {
    throw new Error('Invalid regional mosaic index');
  }
  const plan = createRegionalMosaicPlan(index.config);
  if (index.shards.length !== plan.shards.length) {
    throw new Error('Regional mosaic index is incomplete');
  }
  const expected = new Set(plan.shards.map((shard) => shard.id));
  const seen = new Set<string>();
  return index.shards.map(({ id, file }) => {
    if (!expected.has(id) || seen.has(id) ||
        typeof file !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(file) ||
        path.isAbsolute(file) || file.split('/').includes('..')) {
      throw new Error('Invalid, duplicated or unsafe regional mosaic shard entry');
    }
    seen.add(id);
    return path.resolve(path.dirname(indexFile), file);
  });
}

export function auditBatchingOpportunity(
  opts: BatchAuditCliOptions
): BatchAuditReport {
  const packPaths = opts.regionIndexPath
    ? resolveMosaicPacks(opts.regionIndexPath)
    : [opts.packPath!];
  const tiles: BatchAuditTile[] = [];
  let packsRead = 0;
  const observedTileKeys = new Set<string>();
  let expectedMetadata: {
    snapshotId: string;
    sourceSha256: string;
    bakeSchemaVersion: string;
    lodPolicyHash: string;
  } | null = null;

  for (const packPath of packPaths) {
    if (opts.maxTiles !== null && tiles.length >= opts.maxTiles) break;
    const store = new TilePackSqliteStore(packPath);
    try {
      const meta = store.getMetadata();
      if (!expectedMetadata) {
        expectedMetadata = {
          snapshotId: meta.snapshotId,
          sourceSha256: meta.sourceSha256,
          bakeSchemaVersion: meta.bakeSchemaVersion,
          lodPolicyHash: meta.lodPolicyHash,
        };
      } else if (
        meta.snapshotId !== expectedMetadata.snapshotId ||
        meta.sourceSha256 !== expectedMetadata.sourceSha256 ||
        meta.bakeSchemaVersion !== expectedMetadata.bakeSchemaVersion ||
        meta.lodPolicyHash !== expectedMetadata.lodPolicyHash
      ) {
        throw new Error('Shard packs do not share snapshot, source, schema and LOD policy');
      }
      packsRead++;
      const entries = store.listManifestEntries(0);
      for (const entry of entries) {
        if (opts.maxTiles !== null && tiles.length >= opts.maxTiles) break;
        const key = String(entry.lod) + ':' + entry.tx + ':' + entry.ty;
        if (observedTileKeys.has(key)) throw new Error('Duplicate tile ' + key);
        observedTileKeys.add(key);
        const decoded = store.getTileDecoded(entry.lod, entry.tx, entry.ty);
        if (!decoded || decoded.lod !== entry.lod ||
            decoded.tx !== entry.tx || decoded.ty !== entry.ty ||
            decoded.tileSizeMeters !== meta.tileSizeMeters) {
          throw new Error('Tile manifest/binary identity mismatch at ' + key);
        }
        tiles.push(analyzeDecodedTileBatching(decoded, opts.cellSizesMeters));
      }
      console.log('[batch-audit] Analyzed ' + tiles.length + ' LOD0 tiles; most recent pack ' + path.basename(packPath));
    } finally {
      store.close();
    }
  }
  if (!expectedMetadata || tiles.length === 0) {
    throw new Error('No decoded LOD0 tiles found');
  }

  const totalGridTiles = opts.regionIndexPath
    ? packPaths.length * 16 // replaced by complete-grid validation above for default 4x4 shards
    : null;
  const isPartialSample = opts.maxTiles !== null &&
    (totalGridTiles === null || tiles.length === opts.maxTiles);
  const report: BatchAuditReport = {
    schemaVersion: 1,
    auditId: 'TKT-030',
    createdAtIso: new Date().toISOString(),
    mode: opts.regionIndexPath ? 'regional-mosaic' : 'single-pack',
    input: opts.regionIndexPath ?? opts.packPath!,
    packsRead,
    isPartialSample,
    sampleLimit: opts.maxTiles,
    snapshotId: expectedMetadata.snapshotId,
    sourceSha256: expectedMetadata.sourceSha256,
    bakeSchemaVersion: expectedMetadata.bakeSchemaVersion,
    lodPolicyHash: expectedMetadata.lodPolicyHash,
    cellSizesMeters: [...opts.cellSizesMeters],
    summary: aggregateTileBatchAudits(tiles),
    interpretation: [
      'Dry-run submission proxies, NOT measured WebGL draw calls, FPS improvements, or guaranteed safe merges.',
      'Each source tile is analyzed independently; no cross-tile geometry merging or tile-size change.',
      'Spatial profiles only merge technically compatible single-material meshes wholly contained in one cell.',
      'Render-order equality does not guarantee stencil, depth, transparent sorting or semantic surface correctness.',
      'Flags represent serialized initial visibility, not a live camera: railway zoom alternatives are excluded.',
      'Existing InstancedMesh batches are counted once each and are not presented as new merge opportunities.',
      'OSM feature category counts are tile-local feature-info records; the same OSM feature can appear in multiple tiles.',
      'Candidates with map feature metadata still require preservation of inspection face ranges and rebuilt BVH.',
      'If --max-tiles is used, output is a geographically ordered sample; do not extrapolate across the region.',
    ],
  };
  return report;
}

function pct(n: number, total: number): string {
  return total === 0 ? 'n/a' : (100 * n / total).toFixed(1) + '%';
}
function topEntries(counts: Record<string, number>, maxCount: number):
  Array<[string, number]> {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxCount);
}

export function formatBatchAuditMarkdown(report: BatchAuditReport): string {
  const s = report.summary;
  const lines: string[] = [
    '# TKT-030 — OSMTI​LE1 Batch Opportunity Audit',
    '',
    '- Scope: ' + report.mode + ' / ' + report.input,
    '- Snapshot: ' + report.snapshotId + ' / policy: ' + report.lodPolicyHash,
    '- Tiles analyzed: ' + s.tiles + (report.isPartialSample ? ' (PARTIAL ORDERED SAMPLE)' : ' (all input tiles)'),
    '- Source tile size: ' + s.tileSizeMeters + ' m',
    '- Static mesh records: ' + s.staticMeshes + '; existing instanced batches: ' +
      s.instanceBatches + ' (' + s.instances + ' instances)',
    '- Static + instanced submission proxy: ' + s.submissionProxy +
      '; serialized-visible proxy: ' + s.serializedVisibleSubmissionProxy,
    '- Triangle records: ' + Math.round(s.triangles).toLocaleString('en-US'),
    '- Tile-local OSM feature-info records: ' + s.featureInfoRecords,
    '',
    '## Draw submission proxy by layer',
    '',
    '| Layer | Static meshes | Static submission proxy | Instanced batches / instances | Compatible candidates | Mapped candidates | Semantic review |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const layer of Object.values(s.layers).sort(
    (a, b) => b.staticSubmissionProxy - a.staticSubmissionProxy
  )) {
    lines.push('| ' + layer.layer + ' | ' + layer.meshes + ' | ' +
      layer.staticSubmissionProxy + ' | ' + layer.instancedBatches + ' / ' +
      layer.instances + ' | ' + layer.candidateMeshes + ' | ' +
      layer.candidateWithFeatureMapping + ' | ' +
      layer.candidateRequiringSemanticReview + ' |');
  }
  lines.push('', '## Tile-local batching scenarios', '',
    '| Spatial restriction | Candidates fitting cells | Grouped meshes | Merge groups | Submission proxy after | Potential reduction |',
    '|---|---:|---:|---:|---:|---:|');
  for (const p of s.profiles) {
    lines.push('| ' + p.label + ' | ' + p.candidateMeshesWithinCells + ' | ' +
      p.mergedMeshRecords + ' | ' + p.mergeGroups + ' | ' +
      p.afterSubmissionProxy + ' | ' +
      p.submissionReductionProxy + ' (' +
      pct(p.submissionReductionProxy, s.submissionProxy) + ') |');
  }
  const reference = s.profiles.find((p) => p.cellMeters === 256)
    ?? s.profiles[0];
  lines.push('', '## Candidate merge savings by material (' + reference.label + ')', '',
    '| Layer / material slot | Potential submission reduction |',
    '|---|---:|');
  for (const [name, value] of topEntries(reference.byMaterialReduction, 20)) {
    lines.push('| ' + name + ' | ' + value + ' |');
  }
  lines.push('', '## Most promising tiles (' + reference.label + ')', '',
    '| Tile key | Potential reduction | Static meshes |',
    '|---|---:|---:|');
  for (const hotspot of s.hotspots) {
    lines.push('| ' + hotspot.tile + ' | ' + hotspot.reductionProxy +
      ' | ' + hotspot.staticMeshes + ' |');
  }
  lines.push('', '## OSM-derived feature category references', '',
    '| Category | Tile-local records |',
    '|---|---:|');
  for (const [key, count] of topEntries(s.featureCategories, 15)) {
    lines.push('| ' + key + ' | ' + count + ' |');
  }
  lines.push('', '## Important limitations', '');
  for (const note of report.interpretation) lines.push('- ' + note);
  lines.push('', 'No geometry was changed, merged, rebuilt, or written to any tile database.', '');
  return lines.join('\n');
}

export function runBatchAuditCli(
  opts: BatchAuditCliOptions
): BatchAuditReport {
  const report = auditBatchingOpportunity(opts);
  fs.mkdirSync(path.dirname(opts.outJson), { recursive: true });
  fs.mkdirSync(path.dirname(opts.outMarkdown), { recursive: true });
  fs.writeFileSync(opts.outJson, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(opts.outMarkdown, formatBatchAuditMarkdown(report));
  const best = report.summary.profiles.find((p) => p.cellMeters === 256)
    ?? report.summary.profiles[0];
  console.log('[batch-audit] ' + report.summary.staticMeshes + ' static meshes / ' +
    report.summary.instanceBatches + ' existing instance batches');
  console.log('[batch-audit] ' + best.label + ': ' + best.submissionReductionProxy +
    ' theoretical fewer mesh submissions (' +
    pct(best.submissionReductionProxy, report.summary.submissionProxy) + ')');
  console.log('[batch-audit] JSON: ' + opts.outJson);
  console.log('[batch-audit] Markdown: ' + opts.outMarkdown);
  return report;
}

const isEntrypoint = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  try {
    runBatchAuditCli(parseBatchAuditCli());
  } catch (err) {
    console.error('[batch-audit] Failed:', err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  }
}
