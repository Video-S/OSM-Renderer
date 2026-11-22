import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bakeHengeloTilesFromStore } from '../src/server/tiles/OfflineHengeloTileBaker';
import { TilePackSqliteStore } from '../src/server/tiles/TilePackSqliteStore';
import {
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  resolveOverijsselIndexPath,
} from '../src/server/osm/overijsselConfig';
import {
  CANONICAL_HENGELO_SNAPSHOT_ID,
  type TilePackMetadata,
} from '../src/world/tiling/TilePackContract';
import {
  createAlignedStudyGrid,
  type StudyGridSpec,
} from '../src/world/tiling/TileGrid';
import { utm32NToGeo } from '../src/world/tiling/RegionalProjection';
import {
  probeSourceSurfaceAtUtm,
  probeAnyRoadSurfaceAtUtm,
  type SurfaceProbeResult,
} from '../src/world/tiling/RegionalSeamAudit';
import { visibleRoadOnlyTile } from './bake-and-verify-missing-road';

/**
 * TKT-033 follow-up: the ten remaining source-backed, physically absent
 * road/cycleway seam events from the owner's TKT-032 v3 audit.
 *
 * The original eleven events include way/6661112 (Boerrichterkamp), already
 * repaired and visually confirmed. These are source points, not an assertion
 * that every input still represents a real road gap after the fix.
 */
export interface RemainingRoadWitness {
  sourceId: string;
  highway: string;
  easting: number;
  northing: number;
  seamAxis: 'easting' | 'northing';
}

export interface RemainingRoadCaseGroup {
  id: string;
  centerEasting: number;
  centerNorthing: number;
  /** Reuse the already physically verified Boerrichterkamp 2x2 tile pack. */
  reuseBoerrichterkamp: boolean;
  cases: readonly RemainingRoadWitness[];
}

export const REMAINING_MISSING_ROAD_GROUPS: readonly RemainingRoadCaseGroup[] = [
  {
    id: 'central-east-existing',
    centerEasting: 357376, centerNorthing: 5791095.095,
    reuseBoerrichterkamp: true,
    cases: [
      { sourceId: 'way/874072936', highway: 'service', easting: 357376, northing: 5791414.966, seamAxis: 'easting' },
      { sourceId: 'way/137733136', highway: 'cycleway', easting: 357722.202, northing: 5790720, seamAxis: 'northing' },
      { sourceId: 'way/221267376', highway: 'service', easting: 357376, northing: 5790237.696, seamAxis: 'easting' },
      { sourceId: 'way/221267376', highway: 'service', easting: 357376, northing: 5790254.857, seamAxis: 'easting' },
    ],
  },
  {
    id: 'west-north-pair',
    centerEasting: 352327, centerNorthing: 5794816,
    reuseBoerrichterkamp: false,
    cases: [
      { sourceId: 'way/38892898', highway: 'cycleway', easting: 352329.339, northing: 5794816, seamAxis: 'northing' },
      { sourceId: 'way/546666718', highway: 'residential', easting: 352326.079, northing: 5794816, seamAxis: 'northing' },
    ],
  },
  {
    id: 'far-northeast',
    centerEasting: 357376, centerNorthing: 5798521.137,
    reuseBoerrichterkamp: false,
    cases: [
      { sourceId: 'way/51932698', highway: 'residential', easting: 357376, northing: 5798521.137, seamAxis: 'easting' },
    ],
  },
  {
    id: 'west-middle-primary',
    centerEasting: 351822.7, centerNorthing: 5790720,
    reuseBoerrichterkamp: false,
    cases: [
      { sourceId: 'way/6666519', highway: 'primary', easting: 351822.7, northing: 5790720, seamAxis: 'northing' },
    ],
  },
  {
    id: 'west-south-pair',
    centerEasting: 353280, centerNorthing: 5786624,
    reuseBoerrichterkamp: false,
    cases: [
      { sourceId: 'way/6655700', highway: 'residential', easting: 353280, northing: 5786626.158, seamAxis: 'easting' },
      { sourceId: 'way/14119316', highway: 'cycleway', easting: 352312.35, northing: 5786624, seamAxis: 'northing' },
    ],
  },
];

export interface RemainingCheckOptions {
  runId: string;
  outDir: string;
  sourceIndexPath: string;
  existingPackPath: string;
}

export function parseRemainingRoadCheckArgs(
  argv: readonly string[] = process.argv.slice(2),
  root: string = process.cwd()
): RemainingCheckOptions {
  let runId = 'first-pass';
  let sourceIndexPath = resolveOverijsselIndexPath(root);
  for (const arg of argv) {
    if (arg.startsWith('--run-id=')) runId = arg.slice('--run-id='.length);
    else if (arg.startsWith('--source-index=')) sourceIndexPath = path.resolve(root, arg.slice('--source-index='.length));
    else throw Error('Unexpected flag ' + arg + '; supported: --run-id=NAME --source-index=PATH');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,55}$/.test(runId)) {
    throw Error('Run ID must be a short simple filename token (letters, numbers, _ or -)');
  }
  if (!sourceIndexPath) throw Error('Missing canonical source index path');
  return {
    runId,
    outDir: path.resolve(root, 'benchmarks/results/tkt033-remaining', runId),
    sourceIndexPath,
    existingPackPath: path.resolve(root,
      'benchmarks/results/tkt033-disposable/way-6661112-2x2.sqlite'),
  };
}

export function gridForRemainingRoadGroup(group: RemainingRoadCaseGroup): StudyGridSpec {
  const [lon, lat] = utm32NToGeo(group.centerEasting, group.centerNorthing);
  return createAlignedStudyGrid({
    name: 'tkt033-remaining-' + group.id,
    centerLonLat: [lon, lat],
    cols: 2, rows: 2, tileSizeMeters: 1024, collarMeters: 64,
  });
}

/** Make exact 25 cm samples on both sides of the original shard interface. */
export function samplesForRemainingRoadWitness(witness: RemainingRoadWitness) {
  const e = witness.easting, n = witness.northing;
  return [
    { label: 'center', easting: e, northing: n },
    ...(witness.seamAxis === 'easting'
      ? [
          { label: 'west-25cm', easting: e - 0.25, northing: n },
          { label: 'east-25cm', easting: e + 0.25, northing: n },
        ]
      : [
          { label: 'north-25cm', easting: e, northing: n + 0.25 },
          { label: 'south-25cm', easting: e, northing: n - 0.25 },
        ]),
  ];
}

export type RemainingRoadCheckStatus =
  | 'source-covered-both'
  | 'source-one-sided'
  | 'other-road-covered-both'
  | 'axis-inset-uncovered';

export function classifyRemainingRoadCoverage(
  first: { source: Pick<SurfaceProbeResult, 'status'>; anyRoad: Pick<SurfaceProbeResult, 'status'> },
  second: { source: Pick<SurfaceProbeResult, 'status'>; anyRoad: Pick<SurfaceProbeResult, 'status'> }
): RemainingRoadCheckStatus {
  const a = first.source.status === 'covered', b = second.source.status === 'covered';
  if (a && b) return 'source-covered-both';
  if (a !== b) return 'source-one-sided';
  if (first.anyRoad.status === 'covered' && second.anyRoad.status === 'covered') {
    return 'other-road-covered-both';
  }
  // Absence at fixed-axis probes is NOT proof of a road gap: diagonal
  // narrow ways (e.g. canonical 0.2m Hilgenhuesweg) can be entirely covered
  // along their true centerline yet fail both 25cm axis-inset samples.
  return 'axis-inset-uncovered';
}

interface SampleEvidence {
  label: string;
  tx: number;
  ty: number;
  source: SurfaceProbeResult;
  anyRoad: SurfaceProbeResult;
}
interface WitnessResult {
  sourceId: string;
  highway: string;
  easting: number;
  northing: number;
  seamAxis: RemainingRoadWitness['seamAxis'];
  classification: RemainingRoadCheckStatus;
  samples: SampleEvidence[];
}
interface GroupResult {
  groupId: string;
  packPath: string;
  origin: 'reused-verified-pack' | 'new-disposable-bake';
  tiles: number;
  witnesses: WitnessResult[];
  error?: string;
}

function verifyExpectedGrid(meta: TilePackMetadata, grid: StudyGridSpec): void {
  if (meta.tileSizeMeters !== 1024 || meta.gridCols !== 2 || meta.gridRows !== 2 ||
      meta.minTx !== grid.minTx || meta.maxTx !== grid.maxTx ||
      meta.minTy !== grid.minTy || meta.maxTy !== grid.maxTy ||
      meta.collarMeters !== 64 || meta.bakeStatus !== 'complete') {
    throw Error('Disposable tile pack grid does not match target source witness area');
  }
}

function sampleOne(
  pack: TilePackSqliteStore,
  witness: RemainingRoadWitness,
  p: { label: string; easting: number; northing: number },
  cache: Map<string, ReturnType<typeof visibleRoadOnlyTile>>
): SampleEvidence {
  const tx = Math.floor(p.easting / 1024), ty = Math.floor(p.northing / 1024);
  const key = tx + ':' + ty;
  let tile = cache.get(key);
  if (!tile) {
    const decoded = pack.getTileDecoded(0, tx, ty);
    if (!decoded) throw Error('Missing tile ' + key + ' at ' + p.label + ' for ' + witness.sourceId);
    tile = visibleRoadOnlyTile(decoded);
    cache.set(key, tile);
  }
  const centerE = (tx + 0.5) * 1024, centerN = (ty + 0.5) * 1024;
  return {
    label: p.label, tx, ty,
    source: probeSourceSurfaceAtUtm(
      tile, centerE, centerN, witness.sourceId, p.easting, p.northing),
    anyRoad: probeAnyRoadSurfaceAtUtm(
      tile, centerE, centerN, p.easting, p.northing),
  };
}

function inspectGroupPack(
  group: RemainingRoadCaseGroup,
  packPath: string,
  grid: StudyGridSpec,
  reused: boolean
): GroupResult {
  const pack = new TilePackSqliteStore(packPath, {
    expectedSnapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
    expectedSourceSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
  });
  try {
    verifyExpectedGrid(pack.getMetadata(), grid);
    const cache = new Map<string, ReturnType<typeof visibleRoadOnlyTile>>();
    if (reused) {
      // The existing pack is trusted only if it actually contains the owner's
      // verified regression road. A stale pack with matching source SHA is
      // not sufficient, since pack schema does not encode renderer revision.
      const control: RemainingRoadWitness = {
        sourceId: 'way/6661112', highway: 'residential',
        easting: 357376, northing: 5791095.095, seamAxis: 'easting',
      };
      const controlSamples = samplesForRemainingRoadWitness(control).slice(1);
      for (const p of controlSamples) {
        if (sampleOne(pack, control, p, cache).source.status !== 'covered') {
          throw Error('Existing Boerrichterkamp pack did not pass its known fixed-road control. Refuse to trust stale test output.');
        }
      }
    }
    const witnesses = group.cases.map(witness => {
      const samples = samplesForRemainingRoadWitness(witness).map(p =>
        sampleOne(pack, witness, p, cache));
      return {
        sourceId: witness.sourceId, highway: witness.highway,
        easting: witness.easting, northing: witness.northing,
        seamAxis: witness.seamAxis,
        classification: classifyRemainingRoadCoverage(samples[1], samples[2]),
        samples,
      };
    });
    return {
      groupId: group.id, packPath,
      origin: reused ? 'reused-verified-pack' : 'new-disposable-bake',
      tiles: pack.listManifestEntries(0).length,
      witnesses,
    };
  } finally {
    pack.close();
  }
}

export function verifyRemainingMissingRoads(options: RemainingCheckOptions) {
  if (fs.existsSync(options.outDir)) {
    throw Error('Run directory already exists; use --run-id=ANOTHER_NAME to protect earlier output: ' + options.outDir);
  }
  const groups = REMAINING_MISSING_ROAD_GROUPS;
  for (const group of groups) {
    const grid = gridForRemainingRoadGroup(group);
    for (const witness of group.cases) {
      for (const sample of samplesForRemainingRoadWitness(witness)) {
        const b = grid.studyUtmBounds;
        if (sample.easting < b.minEasting || sample.easting >= b.maxEasting ||
            sample.northing < b.minNorthing || sample.northing >= b.maxNorthing) {
          throw Error('Case ' + witness.sourceId + ' falls outside group ' + group.id);
        }
      }
    }
  }
  if (!fs.existsSync(options.existingPackPath)) {
    throw Error('Missing previously verified Boerrichterkamp pack: ' + options.existingPackPath +
      '. Run npm run osm:bake-verify-missing-road first.');
  }
  fs.mkdirSync(options.outDir, { recursive: true });
  const results: GroupResult[] = [];
  for (const group of groups) {
    const grid = gridForRemainingRoadGroup(group);
    const reused = group.reuseBoerrichterkamp;
    const packPath = reused
      ? options.existingPackPath
      : path.join(options.outDir, group.id + '-2x2.sqlite');
    console.log('[tkt033:remaining] ' + group.id + ': ' +
      (reused ? 'reusing verified Boerrichterkamp pack' : 'baking four disposable tiles'));
    try {
      if (!reused) {
        bakeHengeloTilesFromStore({
          indexPath: options.sourceIndexPath,
          expectedSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
          outPath: packPath,
          grid,
          tileSizeMeters: 1024,
          collarMeters: 64,
          queryContextMarginMeters: 768,
          includeBvh: true,
          batchDimension: 2,
        });
      }
      const result = inspectGroupPack(group, packPath, grid, reused);
      for (const witness of result.witnesses) {
        console.log('[tkt033:remaining] ' + witness.sourceId +
          ' (' + witness.easting + ', ' + witness.northing + '): ' + witness.classification);
      }
      results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        groupId: group.id, packPath,
        origin: reused ? 'reused-verified-pack' : 'new-disposable-bake',
        tiles: 0, witnesses: [], error: message,
      });
      console.error('[tkt033:remaining] ' + group.id + ': ' + message);
    }
  }
  const actual = results.flatMap(g => g.witnesses);
  const summary = {
    requestedEventCount: groups.reduce((n, g) => n + g.cases.length, 0),
    inspectedEventCount: actual.length,
    sourceCoveredBoth: actual.filter(w => w.classification === 'source-covered-both').length,
    sourceOneSided: actual.filter(w => w.classification === 'source-one-sided').length,
    otherRoadCoveredBoth: actual.filter(w => w.classification === 'other-road-covered-both').length,
    axisInsetUncovered: actual.filter(w => w.classification === 'axis-inset-uncovered').length,
    groupErrors: results.filter(g => g.error !== undefined).length,
    newTilePacks: results.filter(g => g.origin === 'new-disposable-bake' && !g.error).length,
    reusedTilePacks: results.filter(g => g.origin === 'reused-verified-pack' && !g.error).length,
  };
  const output = {
    ticket: 'TKT-033',
    auditSource: 'TKT-032 v3 original 11 physically-neither-side source road events; excludes visually fixed way/6661112',
    snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
    sourceSha256: OVERIJSSEL_PBF_EXPECTED_SHA256,
    summary,
    groups: results,
    limitations: [
      'Coverage is sampled 25cm on either side of source OSM crossing, not a full-road connectivity proof.',
      'A source may be merged or intentionally occluded by a real higher-priority road. Other-road coverage is reported separately.',
      '2x2 grouped packs have different graph context from the original 4x4 regional shard bake.',
      'Axis-only inset uncovered samples are NOT physical seam gaps. For diagonal narrow roads, re-probe along the exact OSM centerline tangent before assigning a defect.',
      'Original canonical regional 256-tile mosaic is unchanged; no LLM visual acceptance was performed.',
    ],
  };
  const jsonPath = path.join(options.outDir, 'remaining-roads-report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2) + '\n');
  console.log('[tkt033:remaining] summary: ' + JSON.stringify(summary));
  console.log('[tkt033:remaining] report: ' + jsonPath);
  console.log('[tkt033:remaining] original 256-tile Twente mosaic untouched');
  if (summary.groupErrors) process.exitCode = 1;
  return output;
}

const isEntrypoint = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  try {
    verifyRemainingMissingRoads(parseRemainingRoadCheckArgs());
  } catch (err) {
    console.error('[tkt033:remaining] ' + (err instanceof Error ? err.stack : String(err)));
    process.exitCode = 1;
  }
}
