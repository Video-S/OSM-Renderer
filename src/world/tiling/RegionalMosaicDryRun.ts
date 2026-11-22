import fs from 'node:fs';
import path from 'node:path';
import { isPointInOverijssel } from '../../server/osm/overijsselBoundary';
import { geoToUtm32N, utm32NToGeo } from './RegionalProjection';
import {
  TWENTE_PILOT_CONFIG,
  createRegionalMosaicPlan,
  type RegionalMosaicPlan,
  type RegionalMosaicShard,
} from './RegionalMosaicPlan';

export type OverijsselCoverageClass =
  | 'inside_overijssel'
  | 'straddles_overijssel_boundary'
  | 'outside_overijssel';

export interface RegionalSettlementCheck {
  name: string;
  role: 'core_city' | 'town' | 'border_rural';
  lon: number;
  lat: number;
  easting: number;
  northing: number;
  tx: number;
  ty: number;
  inGrid: boolean;
  inOverijsselExtract: boolean;
  shardId: string | null;
}

export interface RegionalShardDryRunEntry {
  id: string;
  row: number;
  col: number;
  minTx: number;
  maxTx: number;
  minTy: number;
  maxTy: number;
  tileCount: number;
  overijsselCoverage: OverijsselCoverageClass;
  insideOverijsselTiles: number;
  straddleOverijsselTiles: number;
  outsideOverijsselTiles: number;
  matchesPilotShardId: string | null;
  existingFilePresent: boolean;
  existingFileBytes: number | null;
  orphanedStagingFiles: string[];
}

export interface RegionalMosaicResourceEstimates {
  /** Explicitly marks every figure in this section as a non-measured estimate. */
  isEstimate: true;
  basis: string;
  /** Compressed SQLite storage estimates in MiB (low / mid / high). */
  estimatedCompressedStorageMiB: {
    low: number;
    mid: number;
    high: number;
  };
  /** Estimated wall-clock bake duration in minutes (depends heavily on local CPU/disk). */
  estimatedWallTimeMinutes: {
    low: number;
    mid: number;
    high: number;
  };
  /** Estimated per-shard peak RSS in MiB (bounded because only 1 shard is ingested at a time). */
  estimatedPerShardPeakRssMiB: {
    low: number;
    high: number;
  };
  caveats: string[];
}

export interface RegionalMosaicDryRunReport {
  generatedAtIso: string;
  configName: string;
  outDir: string | null;
  grid: {
    cols: number;
    rows: number;
    tileSizeMeters: number;
    shardDimension: number;
    shardCols: number;
    shardRows: number;
    totalShards: number;
    totalTiles: number;
    widthKm: number;
    heightKm: number;
    rectangularAreaKm2: number;
    minTx: number;
    maxTx: number;
    minTy: number;
    maxTy: number;
    utmBounds: {
      minEasting: number;
      maxEasting: number;
      minNorthing: number;
      maxNorthing: number;
    };
    centerUtm: [number, number];
    centerLonLat: [number, number];
    approxWgs84Bounds: {
      westLon: number;
      southLat: number;
      eastLon: number;
      northLat: number;
    };
    collarMeters: number;
    contextMarginMeters: number;
    internalShardInterfaces: number;
    fourWayShardJunctions: number;
  };
  pilotAlignment: {
    pilotShardCount: number;
    exactShardMatches: number;
    shardIdMapping: Array<{ pilotShardId: string; targetShardId: string }>;
  };
  overijsselSourceCoverage: {
    note: string;
    tiles: {
      insideOverijssel: number;
      straddlesBoundary: number;
      outsideOverijssel: number;
    };
    shards: {
      insideOverijssel: number;
      straddlesBoundary: number;
      outsideOverijssel: number;
      outsideShardIds: string[];
    };
  };
  settlements: RegionalSettlementCheck[];
  existingOutputScan: {
    scanned: boolean;
    outDirExists: boolean;
    mosaicIndexExists: boolean;
    existingShardFiles: number;
    missingShardFiles: number;
    existingTotalBytes: number;
    orphanedStagingFiles: string[];
  };
  estimates: RegionalMosaicResourceEstimates;
  shards: RegionalShardDryRunEntry[];
}

export const TWENTE_REFERENCE_SETTLEMENTS: ReadonlyArray<{
  name: string;
  role: 'core_city' | 'town' | 'border_rural';
  lon: number;
  lat: number;
}> = Object.freeze([
  { name: 'Enschede', role: 'core_city', lon: 6.8937, lat: 52.2215 },
  { name: 'Hengelo', role: 'core_city', lon: 6.7931, lat: 52.2661 },
  { name: 'Almelo', role: 'core_city', lon: 6.6625, lat: 52.3567 },
  { name: 'Oldenzaal', role: 'core_city', lon: 6.9293, lat: 52.3133 },
  { name: 'Haaksbergen', role: 'town', lon: 6.7419, lat: 52.1558 },
  { name: 'Rijssen', role: 'town', lon: 6.5197, lat: 52.3075 },
  { name: 'Denekamp', role: 'town', lon: 7.0056, lat: 52.3758 },
  { name: 'Borne', role: 'town', lon: 6.7547, lat: 52.3001 },
  { name: 'Delden', role: 'town', lon: 6.711, lat: 52.2602 },
  { name: 'Goor', role: 'town', lon: 6.5861, lat: 52.2336 },
  { name: 'Wierden', role: 'town', lon: 6.5931, lat: 52.3592 },
  { name: 'Enter', role: 'town', lon: 6.5789, lat: 52.2931 },
  { name: 'Vriezenveen', role: 'town', lon: 6.6214, lat: 52.4083 },
  { name: 'Tubbergen', role: 'town', lon: 6.7836, lat: 52.4075 },
  { name: 'Ootmarsum', role: 'town', lon: 6.8972, lat: 52.4081 },
  { name: 'Losser', role: 'town', lon: 7.0044, lat: 52.2614 },
  { name: 'Overdinkel', role: 'border_rural', lon: 7.0372, lat: 52.2356 },
  { name: 'Glanerbrug', role: 'border_rural', lon: 6.9736, lat: 52.2167 },
  { name: 'De Lutte', role: 'border_rural', lon: 6.9886, lat: 52.3156 },
  { name: 'Markelo', role: 'border_rural', lon: 6.4956, lat: 52.2344 },
  { name: 'Diepenheim', role: 'border_rural', lon: 6.5542, lat: 52.2008 },
  { name: 'Holten', role: 'border_rural', lon: 6.4189, lat: 52.2806 },
  { name: 'Nijverdal', role: 'border_rural', lon: 6.4644, lat: 52.3647 },
  { name: 'Vroomshoop', role: 'border_rural', lon: 6.5656, lat: 52.4608 },
  { name: 'Lattrop', role: 'border_rural', lon: 6.9775, lat: 52.4239 },
  { name: 'Buurse', role: 'border_rural', lon: 6.8267, lat: 52.1489 },
]);

/**
 * Classifies a tile against OVERIJSSEL_BOUNDARY_RING using a 3×3 sample grid
 * (4 corners, 4 edge midpoints, and tile center).
 */
export function classifyTileOverijsselCoverage(utmBounds: {
  minEasting: number;
  maxEasting: number;
  minNorthing: number;
  maxNorthing: number;
}): OverijsselCoverageClass {
  const width = utmBounds.maxEasting - utmBounds.minEasting;
  const height = utmBounds.maxNorthing - utmBounds.minNorthing;
  let insideCount = 0;
  let totalCount = 0;
  for (const fx of [0, 0.5, 1]) {
    for (const fy of [0, 0.5, 1]) {
      const [lon, lat] = utm32NToGeo(
        utmBounds.minEasting + fx * width,
        utmBounds.minNorthing + fy * height
      );
      totalCount++;
      if (isPointInOverijssel(lat, lon)) {
        insideCount++;
      }
    }
  }
  if (insideCount === totalCount) return 'inside_overijssel';
  if (insideCount === 0) return 'outside_overijssel';
  return 'straddles_overijssel_boundary';
}

function listOrphanedStagingFiles(outDir: string): string[] {
  if (!fs.existsSync(outDir)) return [];
  return fs
    .readdirSync(outDir)
    .filter((name) => name.includes('.staging-'))
    .sort();
}

export function buildRegionalMosaicDryRunReport(
  plan: RegionalMosaicPlan,
  options?: {
    outDir?: string;
    selectedShardIds?: readonly string[];
  }
): RegionalMosaicDryRunReport {
  const { grid, config, shards } = plan;
  const shardCols = config.cols / config.shardDimension;
  const shardRows = config.rows / config.shardDimension;
  const widthKm = Number(((config.cols * config.tileSizeMeters) / 1000).toFixed(3));
  const heightKm = Number(((config.rows * config.tileSizeMeters) / 1000).toFixed(3));
  const rectangularAreaKm2 = Number((widthKm * heightKm).toFixed(2));
  const internalShardInterfaces =
    (shardCols - 1) * shardRows + shardCols * (shardRows - 1);
  const fourWayShardJunctions = Math.max(0, (shardCols - 1) * (shardRows - 1));

  const centerE = (grid.studyUtmBounds.minEasting + grid.studyUtmBounds.maxEasting) / 2;
  const centerN = (grid.studyUtmBounds.minNorthing + grid.studyUtmBounds.maxNorthing) / 2;
  const centerLonLat = utm32NToGeo(centerE, centerN);
  const sw = utm32NToGeo(grid.studyUtmBounds.minEasting, grid.studyUtmBounds.minNorthing);
  const ne = utm32NToGeo(grid.studyUtmBounds.maxEasting, grid.studyUtmBounds.maxNorthing);

  // Pilot shard alignment check
  const pilotPlan = createRegionalMosaicPlan(TWENTE_PILOT_CONFIG);
  const pilotByBoundsKey = new Map<string, RegionalMosaicShard>();
  for (const ps of pilotPlan.shards) {
    pilotByBoundsKey.set(
      `${ps.grid.minTx}:${ps.grid.maxTx}:${ps.grid.minTy}:${ps.grid.maxTy}`,
      ps
    );
  }
  const shardIdMapping: Array<{ pilotShardId: string; targetShardId: string }> = [];

  const resolvedOutDir = options?.outDir ? path.resolve(options.outDir) : null;
  const outDirExists = resolvedOutDir ? fs.existsSync(resolvedOutDir) : false;
  const orphanedStagingFiles = resolvedOutDir ? listOrphanedStagingFiles(resolvedOutDir) : [];

  let insideTiles = 0;
  let straddleTiles = 0;
  let outsideTiles = 0;
  let insideShards = 0;
  let straddleShards = 0;
  let outsideShards = 0;
  const outsideShardIds: string[] = [];

  let existingShardFiles = 0;
  let existingTotalBytes = 0;

  const selectedSet =
    options?.selectedShardIds && options.selectedShardIds.length > 0
      ? new Set(options.selectedShardIds)
      : null;

  const shardEntries: RegionalShardDryRunEntry[] = [];
  for (const shard of shards) {
    let sInside = 0;
    let sStraddle = 0;
    let sOutside = 0;
    for (const tile of shard.grid.tiles) {
      const cls = classifyTileOverijsselCoverage(tile.utmBounds);
      if (cls === 'inside_overijssel') {
        sInside++;
        insideTiles++;
      } else if (cls === 'straddles_overijssel_boundary') {
        sStraddle++;
        straddleTiles++;
      } else {
        sOutside++;
        outsideTiles++;
      }
    }

    let overijsselCoverage: OverijsselCoverageClass;
    if (sInside === shard.grid.tiles.length) {
      overijsselCoverage = 'inside_overijssel';
      insideShards++;
    } else if (sOutside === shard.grid.tiles.length) {
      overijsselCoverage = 'outside_overijssel';
      outsideShards++;
      outsideShardIds.push(shard.id);
    } else {
      overijsselCoverage = 'straddles_overijssel_boundary';
      straddleShards++;
    }

    const pilotMatch = pilotByBoundsKey.get(
      `${shard.grid.minTx}:${shard.grid.maxTx}:${shard.grid.minTy}:${shard.grid.maxTy}`
    );
    if (pilotMatch) {
      shardIdMapping.push({ pilotShardId: pilotMatch.id, targetShardId: shard.id });
    }

    let existingFilePresent = false;
    let existingFileBytes: number | null = null;
    const shardOrphans: string[] = [];
    if (resolvedOutDir && outDirExists) {
      const shardPath = path.join(resolvedOutDir, `${shard.id}.sqlite`);
      if (fs.existsSync(shardPath)) {
        existingFilePresent = true;
        existingFileBytes = fs.statSync(shardPath).size;
        existingShardFiles++;
        existingTotalBytes += existingFileBytes;
      }
      for (const orphan of orphanedStagingFiles) {
        if (orphan.startsWith(`${shard.id}.sqlite.staging-`)) {
          shardOrphans.push(orphan);
        }
      }
    }

    if (!selectedSet || selectedSet.has(shard.id)) {
      shardEntries.push({
        id: shard.id,
        row: shard.row,
        col: shard.col,
        minTx: shard.grid.minTx,
        maxTx: shard.grid.maxTx,
        minTy: shard.grid.minTy,
        maxTy: shard.grid.maxTy,
        tileCount: shard.grid.tiles.length,
        overijsselCoverage,
        insideOverijsselTiles: sInside,
        straddleOverijsselTiles: sStraddle,
        outsideOverijsselTiles: sOutside,
        matchesPilotShardId: pilotMatch?.id ?? null,
        existingFilePresent,
        existingFileBytes,
        orphanedStagingFiles: shardOrphans,
      });
    }
  }

  // Settlement verification
  const settlements: RegionalSettlementCheck[] = TWENTE_REFERENCE_SETTLEMENTS.map((s) => {
    const [easting, northing] = geoToUtm32N(s.lon, s.lat);
    const tx = Math.floor(easting / config.tileSizeMeters);
    const ty = Math.floor(northing / config.tileSizeMeters);
    const inGrid =
      tx >= grid.minTx && tx <= grid.maxTx && ty >= grid.minTy && ty <= grid.maxTy;
    const matchedShard = inGrid
      ? shards.find(
          (sh) =>
            tx >= sh.grid.minTx &&
            tx <= sh.grid.maxTx &&
            ty >= sh.grid.minTy &&
            ty <= sh.grid.maxTy
        ) ?? null
      : null;
    return {
      name: s.name,
      role: s.role,
      lon: s.lon,
      lat: s.lat,
      easting: Number(easting.toFixed(1)),
      northing: Number(northing.toFixed(1)),
      tx,
      ty,
      inGrid,
      inOverijsselExtract: isPointInOverijssel(s.lat, s.lon),
      shardId: matchedShard?.id ?? null,
    };
  });

  // Clearly labeled non-measured resource estimates anchored to recorded 16-shard pilot baseline
  // Recorded TKT-032 pilot baseline: 235.68 MiB compressed across 16 urban-dense Hengelo/Enschede shards
  // (~14.73 MiB/shard urban average). Full Twente mixes dense cities, smaller towns, rural farmland,
  // and border/outside-Overijssel empty shards.
  const activeShards = insideShards + straddleShards;
  const effectivePopulatedShardEquivalent = insideShards + straddleShards * 0.5;
  const estimatedStorageLow = Math.round(effectivePopulatedShardEquivalent * 6.5);
  const estimatedStorageMid = Math.round(effectivePopulatedShardEquivalent * 10.5);
  const estimatedStorageHigh = Math.round(
    (effectivePopulatedShardEquivalent * 14.73) + outsideShards * 0.25
  );

  // Wall-clock estimate: rough non-measured range assuming ~15–60s/shard on populated shards and ~1–3s on empty outside shards.
  const estimatedWallLow = Math.max(1, Math.round((activeShards * 15 + outsideShards * 2) / 60));
  const estimatedWallMid = Math.max(2, Math.round((activeShards * 35 + outsideShards * 3) / 60));
  const estimatedWallHigh = Math.max(4, Math.round((activeShards * 75 + outsideShards * 5) / 60));

  const estimates: RegionalMosaicResourceEstimates = {
    isEstimate: true,
    basis:
      'Non-measured projection derived from the recorded 16-shard TKT-032 urban Twente pilot baseline (235.68 MiB compressed across 16 shards, ~14.73 MiB/shard average) adjusted for rural density and outside-Overijssel tiles. Actual timings, peak RSS, and disk usage must be recorded from the staged local experimental bake before committing to the full run.',
    estimatedCompressedStorageMiB: {
      low: estimatedStorageLow,
      mid: estimatedStorageMid,
      high: estimatedStorageHigh,
    },
    estimatedWallTimeMinutes: {
      low: estimatedWallLow,
      mid: estimatedWallMid,
      high: estimatedWallHigh,
    },
    estimatedPerShardPeakRssMiB: {
      low: 900,
      high: 2800,
    },
    caveats: [
      'ESTIMATE ONLY — not measured on the 120-shard dataset. Measure actual 1–2 shard timings, RSS, and SQLite size during Stage 1–2 before running the full bake.',
      'Urban shards (Enschede, Hengelo, Almelo, Oldenzaal) will sit near the upper bound for both build time and storage; rural farmland shards will be much smaller and faster.',
      `${outsideShards} of ${shards.length} shards (${outsideTiles} of ${grid.tiles.length} tiles) lie completely outside OVERIJSSEL_BOUNDARY_RING and will produce empty/minimal tiles from the Overijssel-only OSM snapshot.`,
      'Running Node with --expose-gc allows the baker to nudge V8 garbage collection between shards if heap retention trends upward.',
    ],
  };

  return {
    generatedAtIso: new Date().toISOString(),
    configName: config.name,
    outDir: resolvedOutDir,
    grid: {
      cols: config.cols,
      rows: config.rows,
      tileSizeMeters: config.tileSizeMeters,
      shardDimension: config.shardDimension,
      shardCols,
      shardRows,
      totalShards: shards.length,
      totalTiles: grid.tiles.length,
      widthKm,
      heightKm,
      rectangularAreaKm2,
      minTx: grid.minTx,
      maxTx: grid.maxTx,
      minTy: grid.minTy,
      maxTy: grid.maxTy,
      utmBounds: { ...grid.studyUtmBounds },
      centerUtm: [centerE, centerN],
      centerLonLat: [
        Number(centerLonLat[0].toFixed(6)),
        Number(centerLonLat[1].toFixed(6)),
      ],
      approxWgs84Bounds: {
        westLon: Number(sw[0].toFixed(6)),
        southLat: Number(sw[1].toFixed(6)),
        eastLon: Number(ne[0].toFixed(6)),
        northLat: Number(ne[1].toFixed(6)),
      },
      collarMeters: config.collarMeters,
      contextMarginMeters: config.contextMarginMeters,
      internalShardInterfaces,
      fourWayShardJunctions,
    },
    pilotAlignment: {
      pilotShardCount: pilotPlan.shards.length,
      exactShardMatches: shardIdMapping.length,
      shardIdMapping,
    },
    overijsselSourceCoverage: {
      note: 'Rectangular UTM grid coverage is distinct from Overijssel OSM extract availability. Tiles outside OVERIJSSEL_BOUNDARY_RING (Gelderland SW / Germany E-SE-NE) contain no Overijssel PBF features.',
      tiles: {
        insideOverijssel: insideTiles,
        straddlesBoundary: straddleTiles,
        outsideOverijssel: outsideTiles,
      },
      shards: {
        insideOverijssel: insideShards,
        straddlesBoundary: straddleShards,
        outsideOverijssel: outsideShards,
        outsideShardIds,
      },
    },
    settlements,
    existingOutputScan: {
      scanned: resolvedOutDir !== null,
      outDirExists,
      mosaicIndexExists: resolvedOutDir
        ? fs.existsSync(path.join(resolvedOutDir, 'mosaic.json'))
        : false,
      existingShardFiles,
      missingShardFiles: shards.length - existingShardFiles,
      existingTotalBytes,
      orphanedStagingFiles,
    },
    estimates,
    shards: shardEntries,
  };
}

export function formatRegionalMosaicDryRunMarkdown(
  report: RegionalMosaicDryRunReport
): string {
  const g = report.grid;
  const ov = report.overijsselSourceCoverage;
  const est = report.estimates;
  const lines: string[] = [];

  lines.push(`# Regional Mosaic Dry-Run Plan — ${report.configName}`);
  lines.push('');
  lines.push(`Generated: \`${report.generatedAtIso}\``);
  if (report.outDir) {
    lines.push(`Target output directory: \`${report.outDir}\``);
  }
  lines.push('');
  lines.push('## 1. Footprint & Grid Geometry');
  lines.push('');
  lines.push(`- **Grid dimensions:** ${g.cols} × ${g.rows} tiles (${g.tileSizeMeters} m LOD0) = **${g.totalTiles} tiles**`);
  lines.push(`- **Shards:** ${g.shardCols} × ${g.shardRows} shards (${g.shardDimension} × ${g.shardDimension} tiles/shard) = **${g.totalShards} shards**`);
  lines.push(`- **Physical rectangular extent:** ${g.widthKm.toFixed(3)} km × ${g.heightKm.toFixed(3)} km (${g.rectangularAreaKm2.toFixed(2)} km²)`);
  lines.push(`- **Tile index range:** \`tx = ${g.minTx}..${g.maxTx}\`, \`ty = ${g.minTy}..${g.maxTy}\``);
  lines.push(`- **UTM EPSG:25832 bounds:** E \`${g.utmBounds.minEasting}..${g.utmBounds.maxEasting} m\`, N \`${g.utmBounds.minNorthing}..${g.utmBounds.maxNorthing} m\``);
  lines.push(`- **Center (UTM / WGS84):** E \`${g.centerUtm[0]} m\`, N \`${g.centerUtm[1]} m\` (\`[${g.centerLonLat[0]}, ${g.centerLonLat[1]}]\`)`);
  lines.push(`- **Approx WGS84 bbox:** SW \`[${g.approxWgs84Bounds.westLon}, ${g.approxWgs84Bounds.southLat}]\` to NE \`[${g.approxWgs84Bounds.eastLon}, ${g.approxWgs84Bounds.northLat}]\``);
  lines.push(`- **Collar / Query context margin:** ${g.collarMeters} m collar / ${g.contextMarginMeters} m shard query context`);
  lines.push(`- **Internal shard topology:** ${g.internalShardInterfaces} shared shard edges, ${g.fourWayShardJunctions} four-way shard junctions`);
  lines.push(`- **Pilot alignment (TKT-029/TKT-033):** ${report.pilotAlignment.exactShardMatches}/${report.pilotAlignment.pilotShardCount} pilot shards align 1:1 on identical tile/shard boundaries`);
  lines.push('');
  lines.push('## 2. Overijssel OSM Extract Availability (vs. Rectangular Grid)');
  lines.push('');
  lines.push(ov.note);
  lines.push('');
  lines.push(`- **Tiles:** ${ov.tiles.insideOverijssel} fully inside Overijssel, ${ov.tiles.straddlesBoundary} straddling border, ${ov.tiles.outsideOverijssel} outside Overijssel`);
  lines.push(`- **Shards:** ${ov.shards.insideOverijssel} fully inside Overijssel, ${ov.shards.straddlesBoundary} straddling border, ${ov.shards.outsideOverijssel} completely outside Overijssel`);
  if (ov.shards.outsideShardIds.length > 0) {
    lines.push(`- **Outside-Overijssel shards (expected empty/minimal):** \`${ov.shards.outsideShardIds.join(', ')}\``);
  }
  lines.push('');
  lines.push('## 3. Settlement Coverage');
  lines.push('');
  lines.push('| Settlement | Role | Tile (`tx:ty`) | Shard | In Grid | In Overijssel Extract |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const s of report.settlements) {
    lines.push(
      `| ${s.name} | ${s.role} | \`${s.tx}:${s.ty}\` | ${s.shardId ? `\`${s.shardId}\`` : 'NONE'} | ${s.inGrid ? 'Yes' : 'NO'} | ${s.inOverijsselExtract ? 'Yes' : 'NO'} |`
    );
  }
  lines.push('');
  lines.push('## 4. Existing Output Status (Read-Only Scan)');
  lines.push('');
  lines.push(`- Output directory exists: **${report.existingOutputScan.outDirExists ? 'Yes' : 'No'}**`);
  lines.push(`- Existing shard files: **${report.existingOutputScan.existingShardFiles}** / ${g.totalShards} (${report.existingOutputScan.missingShardFiles} remaining)`);
  lines.push(`- Published \`mosaic.json\` present: **${report.existingOutputScan.mosaicIndexExists ? 'Yes' : 'No'}**`);
  lines.push(`- Orphaned staging files: **${report.existingOutputScan.orphanedStagingFiles.length}**`);
  lines.push('');
  lines.push('## 5. Non-Measured Resource Estimates (ESTIMATES ONLY)');
  lines.push('');
  lines.push(`> **Basis:** ${est.basis}`);
  lines.push('');
  lines.push(`- **Estimated compressed SQLite total:** ~${est.estimatedCompressedStorageMiB.low} – ${est.estimatedCompressedStorageMiB.high} MiB (midpoint ~${est.estimatedCompressedStorageMiB.mid} MiB)`);
  lines.push(`- **Estimated full bake wall-clock time:** ~${est.estimatedWallTimeMinutes.low} – ${est.estimatedWallTimeMinutes.high} minutes (midpoint ~${est.estimatedWallTimeMinutes.mid} minutes, hardware-dependent)`);
  lines.push(`- **Estimated per-shard peak RSS:** ~${est.estimatedPerShardPeakRssMiB.low} – ${est.estimatedPerShardPeakRssMiB.high} MiB (single shard ingested at a time)`);
  for (const c of est.caveats) {
    lines.push(`- ${c}`);
  }
  lines.push('');

  return lines.join('\n');
}
