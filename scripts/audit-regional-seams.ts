import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OverijsselOsmStore } from '../src/server/osm/OverijsselOsmStore';
import { resolveOverijsselIndexPath, OVERIJSSEL_PBF_EXPECTED_SHA256 } from '../src/server/osm/overijsselConfig';
import { TilePackSqliteStore } from '../src/server/tiles/TilePackSqliteStore';
import { verifyRegionalMosaic } from './verify-regional-mosaic';
import type { DecodedTilePayload } from '../src/world/tiling/TilePackContract';
import { createRegionalMosaicPlan, type RegionalMosaicIndex } from '../src/world/tiling/RegionalMosaicPlan';
import { utmBoundsToGeoBounds } from '../src/world/tiling/TileGrid';
import {
  collectTileFeatureEvidence, compareFeatureEvidence,
  enumerateRegionalShardSeams, extractSourceCrossings, probeSourceSurfaceAtUtm,
  type ShardSideInterface, type SourceSeamCrossing,
  type SurfaceProbeResult, type TileFeatureEvidence,
} from '../src/world/tiling/RegionalSeamAudit';

export interface RegionalSeamAuditOptions {
  indexPath: string;
  sourceIndexPath: string;
  outPath: string;
  markdownPath: string;
  boundaryId?: string;
  featureId?: string;
  bandMeters: number;
}
export function parseRegionalSeamAuditArgs(argv: readonly string[] = process.argv.slice(2)): RegionalSeamAuditOptions {
  const opts: RegionalSeamAuditOptions = {
    indexPath: path.resolve('data/osm/twente-pilot-1024m/mosaic.json'),
    sourceIndexPath: resolveOverijsselIndexPath(),
    outPath: path.resolve('benchmarks/results/tkt032-seam-audit.json'),
    markdownPath: path.resolve('benchmarks/results/tkt032-seam-audit.md'),
    bandMeters: 32,
  };
  for (const arg of argv) {
    const equal = arg.indexOf('=');
    if (!arg.startsWith('--') || equal < 3) throw new Error('Expected --name=value, got: ' + arg);
    const key = arg.slice(2, equal), val = arg.slice(equal + 1);
    if (!val) throw new Error('Empty value for ' + key);
    if (key === 'index') opts.indexPath = path.resolve(val);
    else if (key === 'source-index') opts.sourceIndexPath = path.resolve(val);
    else if (key === 'out') opts.outPath = path.resolve(val);
    else if (key === 'markdown-out') opts.markdownPath = path.resolve(val);
    else if (key === 'boundary') opts.boundaryId = val;
    else if (key === 'feature') opts.featureId = val;
    else if (key === 'band-meters') {
      const n = Number(val);
      if (!Number.isFinite(n) || n < 2 || n > 128) throw new Error('--band-meters must be 2..128');
      opts.bandMeters = n;
    } else throw new Error('Unknown seam audit flag --' + key);
  }
  return opts;
}

type Classification = 'both' | 'only-a' | 'only-b' | 'neither';
export interface SeamCandidate {
  sourceId: string;
  category: string;
  easting: number;
  northing: number;
  mode: SourceSeamCrossing['mode'];
  tiles: string[];
  classification: Classification;
  layerMismatch: boolean;
  bridgeMismatch: boolean;
  tunnelMismatch: boolean;
  /** Diagnostics only; geometry/sleeper phase is not yet certified. */
  sleeperNearby: [number, number];
  /** Measured from 0.25m inside each tile edge; not a whole-seam continuity proof. */
  surfaceSamples?: [SurfaceProbeResult, SurfaceProbeResult];
  /** Potential discontinuity, never automatically a visual QA verdict. */
  surfaceReview?: 'coverage-asymmetry' | 'height-step';
  sourceLayer?: string;
  sourceBridge?: string;
  sourceTunnel?: string;
  review: 'none' | 'source-missing-output' | 'asymmetric-geometry-attribution' | 'metadata-mismatch' | 'surface-coverage-asymmetry' | 'surface-height-step';
}
export interface SeamSideSummary {
  id: string;
  category: 'interface' | 'control';
  shardA: string;
  shardB: string;
  axis: 'easting' | 'northing';
  lineUtm: { at: number; from: number; to: number };
  checkedTilePairs: number;
  sourceCrossings: number;
  candidates: SeamCandidate[];
}
export interface SeamJunctionSummary {
  id: string;
  easting: number;
  northing: number;
  shards: string[];
  sourceCrossingsNearJunction: number;
  /** Number of the 4 adjacent tiles with an attributed feature, not a parity verdict. */
  attributedQuadrantCounts: Array<{ sourceId: string; presentQuadrants: number }>;
}
export interface RegionalSeamAuditReport {
  ticket: 'TKT-032';
  schemaVersion: 1;
  auditLevel: 'source-to-emitted-feature-metadata-triage';
  createdAt: string;
  input: { index: string; sourceIndex: string; snapshotId: string; sourceSha256: string; bandMeters: number };
  coverage: {
    expectedInterfaces: number;
    checkedInterfaces: number;
    expectedJunctions: number;
    checkedJunctions: number;
    sameShardControls: number;
  };
  totals: {
    crossingCandidates: number;
    asymmetric: number;
    absentBoth: number;
    metadataMismatches: number;
    surfaceAsymmetric: number;
    surfaceHeightSteps: number;
  };
  interfaces: SeamSideSummary[];
  junctions: SeamJunctionSummary[];
  limitations: string[];
}

function packFile(indexFile: string, file: string): string {
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    throw new Error('Unsafe shard path in mosaic index: ' + file);
  }
  return path.resolve(path.dirname(indexFile), file);
}

interface LoadedTileEvidence {
  evidence: TileFeatureEvidence;
  decoded: DecodedTilePayload;
  centerEasting: number;
  centerNorthing: number;
}
function readTileEvidence(
  store: TilePackSqliteStore, tx: number, ty: number
): LoadedTileEvidence {
  const decoded = store.getTileDecoded(0, tx, ty);
  if (!decoded) throw new Error('No decoded tile 0:' + tx + ':' + ty);
  const metadata = store.getMetadata();
  const centerEasting = metadata.studyOriginEasting + decoded.tileCenterX;
  const centerNorthing = metadata.studyOriginNorthing - decoded.tileCenterZ;
  return {
    decoded, centerEasting, centerNorthing,
    evidence: collectTileFeatureEvidence(decoded, centerEasting, centerNorthing),
  };
}

function sourceBBox(side: ShardSideInterface, band: number): ReturnType<typeof utmBoundsToGeoBounds> {
  const isVertical = side.axis === 'easting';
  return utmBoundsToGeoBounds({
    minEasting: isVertical ? side.at - band : side.from - band,
    maxEasting: isVertical ? side.at + band : side.to + band,
    minNorthing: isVertical ? side.from - band : side.at - band,
    maxNorthing: isVertical ? side.to + band : side.at + band,
  });
}
function nearSleeperCount(
  evidence: TileFeatureEvidence, e: number, n: number, radiusMeters = 5
): number {
  const r2 = radiusMeters * radiusMeters;
  return evidence.sleeperBoxes.filter((x) =>
    (x.easting - e) ** 2 + (x.northing - n) ** 2 <= r2).length;
}

function auditSide(
  side: ShardSideInterface,
  kind: 'interface' | 'control',
  source: OverijsselOsmStore,
  openPack: (id: string) => TilePackSqliteStore,
  bandMeters: number,
  featureId?: string
): SeamSideSummary {
  const result = source.queryBBox({ ...sourceBBox(side, bandMeters), locationName: side.id });
  const crossings = extractSourceCrossings(side, result.geojson)
    .filter((x) => !featureId || x.sourceId === featureId);
  const candidates: SeamCandidate[] = [];
  const aStore = openPack(side.shardA);
  const bStore = openPack(side.shardB);
  // Process one neighboring tile pair at a time; release decoded buffers
  // before moving to the next pair. Never retain an entire regional scene.
  for (let i = 0; i < side.pairs.length; i++) {
    const matching = crossings.filter((x) => x.pairIndex === i);
    if (!matching.length) continue;
    const pair = side.pairs[i];
    const a = readTileEvidence(aStore, pair.a.tx, pair.a.ty);
    const b = readTileEvidence(bStore, pair.b.tx, pair.b.ty);
    for (const crossing of matching) {
      const cmp = compareFeatureEvidence(crossing.sourceId, a.evidence, b.evidence);
      let surfaceSamples: [SurfaceProbeResult, SurfaceProbeResult] | undefined;
      let surfaceReview: SeamCandidate['surfaceReview'];
      // A 25cm edge-inset point at the original OSM crossing is an
      // independent triangulation witness; it does not certify connectivity.
      if (crossing.mode === 'segment' &&
          cmp.classification === 'both' &&
          (crossing.category === 'road' || crossing.category === 'water' ||
           crossing.category === 'landuse')) {
        const aE = crossing.easting + (side.axis === 'easting' ? -0.25 : 0);
        const bE = crossing.easting + (side.axis === 'easting' ? 0.25 : 0);
        const aN = crossing.northing + (side.axis === 'northing' ? 0.25 : 0);
        const bN = crossing.northing + (side.axis === 'northing' ? -0.25 : 0);
        surfaceSamples = [
          probeSourceSurfaceAtUtm(a.decoded, a.centerEasting, a.centerNorthing,
            crossing.sourceId, aE, aN),
          probeSourceSurfaceAtUtm(b.decoded, b.centerEasting, b.centerNorthing,
            crossing.sourceId, bE, bN),
        ];
        if ((surfaceSamples[0].status === 'covered') !==
            (surfaceSamples[1].status === 'covered')) {
          surfaceReview = 'coverage-asymmetry';
        } else if (surfaceSamples[0].status === 'covered' &&
                   surfaceSamples[1].status === 'covered' &&
                   Math.abs(surfaceSamples[0].heights[0] - surfaceSamples[1].heights[0]) > 0.75) {
          surfaceReview = 'height-step';
        }
      }
      const review: SeamCandidate['review'] = cmp.layerMismatch || cmp.bridgeMismatch || cmp.tunnelMismatch
        ? 'metadata-mismatch'
        : cmp.classification === 'only-a' || cmp.classification === 'only-b'
          ? 'asymmetric-geometry-attribution'
          : cmp.classification === 'neither' ? 'source-missing-output'
          : surfaceReview === 'coverage-asymmetry' ? 'surface-coverage-asymmetry'
          : surfaceReview === 'height-step' ? 'surface-height-step' : 'none';
      candidates.push({
        sourceId: crossing.sourceId,
        category: crossing.category,
        easting: Number(crossing.easting.toFixed(3)),
        northing: Number(crossing.northing.toFixed(3)),
        mode: crossing.mode,
        tiles: [
          '0:' + pair.a.tx + ':' + pair.a.ty,
          '0:' + pair.b.tx + ':' + pair.b.ty,
        ],
        classification: cmp.classification,
        layerMismatch: cmp.layerMismatch,
        bridgeMismatch: cmp.bridgeMismatch,
        tunnelMismatch: cmp.tunnelMismatch,
        sleeperNearby: [
          nearSleeperCount(a.evidence, crossing.easting, crossing.northing),
          nearSleeperCount(b.evidence, crossing.easting, crossing.northing),
        ],
        surfaceSamples, surfaceReview,
        sourceLayer: crossing.tags.layer === undefined ? undefined : String(crossing.tags.layer),
        sourceBridge: crossing.tags.bridge === undefined ? undefined : String(crossing.tags.bridge),
        sourceTunnel: crossing.tags.tunnel === undefined ? undefined : String(crossing.tags.tunnel),
        review,
      });
    }
  }
  return {
    id: side.id, category: kind,
    shardA: side.shardA, shardB: side.shardB,
    axis: side.axis,
    lineUtm: { at: side.at, from: side.from, to: side.to },
    checkedTilePairs: side.pairs.length,
    sourceCrossings: crossings.length, candidates,
  };
}

function controlsForPlan(
  plan: ReturnType<typeof createRegionalMosaicPlan>
): ShardSideInterface[] {
  if (plan.config.shardDimension < 2) return [];
  const d = plan.config.shardDimension, size = plan.config.tileSizeMeters;
  const cols = plan.config.cols / d, rows = plan.config.rows / d;
  const positions = [[0, 0], [0, cols - 1], [rows - 1, 0], [rows - 1, cols - 1]];
  const uniq = new Set<string>();
  const out: ShardSideInterface[] = [];
  for (const [r, c] of positions) {
    const shard = plan.shards.find((x) => x.row === r && x.col === c);
    if (!shard || uniq.has(shard.id)) continue;
    uniq.add(shard.id);
    const tx = plan.grid.minTx + c * d;
    const ty = plan.grid.maxTy - r * d;
    const at = (tx + 1) * size;
    const from = ty * size, to = (ty + 1) * size;
    out.push({
      id: 'control-' + shard.id,
      kind: 'side', axis: 'easting', at, from, to,
      shardA: shard.id, shardB: shard.id,
      pairs: [{ a: { tx, ty }, b: { tx: tx + 1, ty }, from, to }],
    });
  }
  return out;
}

function auditJunction(
  junction: ReturnType<typeof enumerateRegionalShardSeams>['junctions'][number],
  source: OverijsselOsmStore,
  openPack: (id: string) => TilePackSqliteStore,
  bandMeters: number,
  tileSize: number,
  featureId?: string
): SeamJunctionSummary {
  const e = junction.easting, n = junction.northing;
  const query = source.queryBBox({
    ...utmBoundsToGeoBounds({
      minEasting: e - bandMeters, maxEasting: e + bandMeters,
      minNorthing: n - bandMeters, maxNorthing: n + bandMeters,
    }), locationName: junction.id,
  });
  // A junction can be crossed on either axis, or covered by a polygon
  // without an edge crossing either. This is a candidate inventory only.
  const vertical: ShardSideInterface = {
    id: junction.id + '-v', kind: 'side',
    axis: 'easting', at: e, from: n - bandMeters, to: n + bandMeters,
    shardA: junction.shards[0], shardB: junction.shards[1],
    pairs: [{ a: { tx: 0, ty: 0 }, b: { tx: 0, ty: 0 }, from: n - bandMeters, to: n + bandMeters }],
  };
  const horizontal: ShardSideInterface = {
    id: junction.id + '-h', kind: 'side',
    axis: 'northing', at: n, from: e - bandMeters, to: e + bandMeters,
    shardA: junction.shards[0], shardB: junction.shards[2],
    pairs: [{ a: { tx: 0, ty: 0 }, b: { tx: 0, ty: 0 }, from: e - bandMeters, to: e + bandMeters }],
  };
  const crossings = [...extractSourceCrossings(vertical, query.geojson),
    ...extractSourceCrossings(horizontal, query.geojson)]
    .filter((x) => !featureId || x.sourceId === featureId);
  const sourceIds = [...new Set(crossings.map((x) => x.sourceId))].sort();
  const westTx = Math.round(e / tileSize) - 1;
  const southTy = Math.round(n / tileSize) - 1;
  const positions = [
    { tx: westTx, ty: southTy + 1 },
    { tx: westTx + 1, ty: southTy + 1 },
    { tx: westTx, ty: southTy },
    { tx: westTx + 1, ty: southTy },
  ];
  const evidences = positions.map((p, i) =>
    readTileEvidence(openPack(junction.shards[i]), p.tx, p.ty).evidence);
  return {
    id: junction.id, easting: e, northing: n,
    shards: [...junction.shards],
    sourceCrossingsNearJunction: crossings.length,
    attributedQuadrantCounts: sourceIds.map((sourceId) => ({
      sourceId,
      presentQuadrants: evidences.filter((v) => v.featureIds.has(sourceId)).length,
    })),
  };
}

/**
 * Read-only, bounded analysis. The returned comparison is a source-to-emitted
 * metadata triage, NOT a geometry/graph/sleeper-phase proof and not TKT-029 signoff.
 */
export function auditRegionalSeams(opts: RegionalSeamAuditOptions): RegionalSeamAuditReport {
  if (!fs.existsSync(opts.indexPath)) throw new Error('Mosaic index not found: ' + opts.indexPath);
  if (!fs.existsSync(opts.sourceIndexPath)) throw new Error('Canonical OSM source index not found: ' + opts.sourceIndexPath);
  verifyRegionalMosaic(opts.indexPath);
  const index = JSON.parse(fs.readFileSync(opts.indexPath, 'utf8')) as RegionalMosaicIndex;
  const plan = createRegionalMosaicPlan(index.config);
  const { sides, junctions } = enumerateRegionalShardSeams(plan);
  const controls = controlsForPlan(plan);
  const knownIds = [...sides, ...junctions, ...controls].map((x) => x.id);
  if (opts.boundaryId && !knownIds.includes(opts.boundaryId)) {
    throw new Error('Unknown --boundary=' + opts.boundaryId);
  }
  const shardFiles = new Map(index.shards.map((s) => [s.id, packFile(opts.indexPath, s.file)]));
  const store = new OverijsselOsmStore(opts.sourceIndexPath, {
    expectedSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
  });
  const sourceMetadata = store.getSnapshotMetadata();
  if (sourceMetadata.snapshotId !== index.snapshotId ||
      sourceMetadata.sourceSha256.toLowerCase() !== index.sourceSha256.toLowerCase()) {
    store.close();
    throw new Error('Canonical OSM index snapshot/source SHA differs from mosaic');
  }
  const outSides: SeamSideSummary[] = [];
  const outJunctions: SeamJunctionSummary[] = [];
  // Cache only two to four pack handles per audit target; close promptly.
  const withStores = <T>(run: (get: (id: string) => TilePackSqliteStore) => T): T => {
    const opened = new Map<string, TilePackSqliteStore>();
    try {
      return run((id) => {
        let found = opened.get(id);
        if (!found) {
          const filename = shardFiles.get(id);
          if (!filename) throw new Error('Shard missing in index: ' + id);
          found = new TilePackSqliteStore(filename, {
            expectedSourceSha256: index.sourceSha256,
            expectedSnapshotId: index.snapshotId,
          });
          opened.set(id, found);
        }
        return found;
      });
    } finally {
      for (const handle of opened.values()) handle.close();
    }
  };
  try {
    for (const side of [...sides, ...controls]) {
      if (opts.boundaryId && opts.boundaryId !== side.id) continue;
      const type = side.shardA === side.shardB ? 'control' : 'interface';
      const result = withStores((open) =>
        auditSide(side, type, store, open, opts.bandMeters, opts.featureId));
      outSides.push(result);
      const needsReview = result.candidates.filter((x) => x.review !== 'none').length;
      console.log('[seams] ' + side.id + ': ' + result.sourceCrossings + ' crossings, ' +
        needsReview + ' metadata candidates');
    }
    for (const junction of junctions) {
      if (opts.boundaryId && opts.boundaryId !== junction.id) continue;
      const result = withStores((open) =>
        auditJunction(junction, store, open, opts.bandMeters, index.config.tileSizeMeters, opts.featureId));
      outJunctions.push(result);
      console.log('[seams] ' + junction.id + ': ' + result.sourceCrossingsNearJunction +
        ' source crossings near corner');
    }
  } finally {
    store.close();
  }
  const candidates = outSides.flatMap((s) => s.candidates);
  const report: RegionalSeamAuditReport = {
    ticket: 'TKT-032', schemaVersion: 1,
    auditLevel: 'source-to-emitted-feature-metadata-triage',
    createdAt: new Date().toISOString(),
    input: {
      index: opts.indexPath, sourceIndex: opts.sourceIndexPath,
      snapshotId: index.snapshotId, sourceSha256: index.sourceSha256,
      bandMeters: opts.bandMeters,
    },
    coverage: {
      expectedInterfaces: sides.length,
      checkedInterfaces: outSides.filter((s) => s.category === 'interface').length,
      expectedJunctions: junctions.length,
      checkedJunctions: outJunctions.length,
      sameShardControls: outSides.filter((s) => s.category === 'control').length,
    },
    totals: {
      crossingCandidates: candidates.length,
      asymmetric: candidates.filter((c) => c.classification === 'only-a' || c.classification === 'only-b').length,
      absentBoth: candidates.filter((c) => c.classification === 'neither').length,
      metadataMismatches: candidates.filter((c) => c.layerMismatch || c.bridgeMismatch || c.tunnelMismatch).length,
      surfaceAsymmetric: candidates.filter((c) => c.surfaceReview === 'coverage-asymmetry').length,
      surfaceHeightSteps: candidates.filter((c) => c.surfaceReview === 'height-step').length,
    },
    interfaces: outSides, junctions: outJunctions,
    limitations: [
      'This is stage A: emitted-feature metadata triage, NOT geometric coverage or graph equivalence.',
      'Source IDs absent on both sides are flagged; intentional omissions and unsupported source tags need review.',
      'Tile feature metadata can describe an emitted mesh well away from the seam: presence alone does not prove continuity.',
      'Road/planar triangle inset samples are geometric witnesses only, not full edge coverage or connectivity.',
      'Coverage/height sample warnings may be legitimate source offsets, slopes or parser exclusions; review independently.',
      'Sleeper counts are proximity indicators only; ribbon/3D sleeper phase is not yet measured.',
      'Polygon interior detection currently checks only boundary-line midpoint and ring intersection witnesses.',
      'Owner visual QA and further bounded geometry/reference comparisons are required before TKT-029 acceptance.',
    ],
  };
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  fs.mkdirSync(path.dirname(opts.markdownPath), { recursive: true });
  fs.writeFileSync(opts.outPath, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(opts.markdownPath, formatSeamAuditMarkdown(report));
  return report;
}

export function formatSeamAuditMarkdown(report: RegionalSeamAuditReport): string {
  const lines = [
    '# TKT-032 — Regional source-to-mesh seam triage',
    '',
    '**Not a geometry/graph continuity sign-off.** Owner visual and targeted comparisons remain outstanding.',
    '',
    '- Snapshot: ' + report.input.snapshotId,
    '- Band: ' + report.input.bandMeters + ' m (UTM EPSG:25832)',
    '- Coverage: ' + report.coverage.checkedInterfaces + '/' +
      report.coverage.expectedInterfaces + ' shard interfaces, ' +
      report.coverage.checkedJunctions + '/' + report.coverage.expectedJunctions +
      ' four-way junctions; ' + report.coverage.sameShardControls + ' same-shard controls',
    '- Source crossings: ' + report.totals.crossingCandidates,
    '- Asymmetric attribution: ' + report.totals.asymmetric +
      '; absent both: ' + report.totals.absentBoth +
      '; inconsistent layer/bridge/tunnel metadata: ' + report.totals.metadataMismatches +
      '; surface-asymmetry probes: ' + report.totals.surfaceAsymmetric +
      '; height-step probes: ' + report.totals.surfaceHeightSteps,
    '',
    '## Per-interface triage', '',
    '| Interface | Type | Source crossings | Review candidates |',
    '|---|---|---:|---:|',
  ];
  for (const s of report.interfaces) {
    lines.push('| ' + s.id + ' | ' + s.category + ' | ' + s.sourceCrossings +
      ' | ' + s.candidates.filter((x) => x.review !== 'none').length + ' |');
  }
  lines.push('', '## Reproduction candidates', '',
    '| Interface | OSM feature | Type | UTM easting/northing | Observation | Tiles |',
    '|---|---|---|---|---|---|');
  for (const s of report.interfaces) for (const c of s.candidates) {
    if (c.review === 'none') continue;
    lines.push('| ' + s.id + ' | ' + c.sourceId + ' | ' + c.category + ' | ' +
      c.easting + ' / ' + c.northing + ' | ' + c.review + ' (' +
      c.classification + ') | ' + c.tiles.join(' vs ') + ' |');
  }
  lines.push('', '## Four-way junctions', '',
    '| Junction | Source crossings | Source IDs with partial quadrant attribution |',
    '|---|---:|---:|');
  for (const j of report.junctions) lines.push('| ' + j.id + ' | ' +
    j.sourceCrossingsNearJunction + ' | ' +
    j.attributedQuadrantCounts.filter((x) => x.presentQuadrants > 0 && x.presentQuadrants < 4).length + ' |');
  lines.push('', '## Interpretation limits', '', ...report.limitations.map((s) => '- ' + s), '');
  return lines.join('\n');
}

const isEntrypoint = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  try {
    const report = auditRegionalSeams(parseRegionalSeamAuditArgs());
    console.log('[seams] Wrote source-to-metadata triage: ' +
      report.coverage.checkedInterfaces + ' interfaces / ' +
      report.coverage.checkedJunctions + ' junctions; ' +
      report.totals.asymmetric + ' asymmetric attribution candidates');
    console.log('[seams] Not a geometry/topology sign-off; see Markdown limitations.');
  } catch (error) {
    console.error('[seams] Failed:', error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
