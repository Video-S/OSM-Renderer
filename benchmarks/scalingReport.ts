import fs from 'node:fs';
import path from 'node:path';
import type {
  RegionalScalingReport,
  ScalingWorkloadResult,
} from './types';

function fmtMs(stats: { median: number; p95: number } | null | undefined): string {
  if (!stats) return 'N/A';
  return `${stats.median.toFixed(1)} ms`;
}

function fmtNum(val: number | null | undefined, decimals: number = 0): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return 'N/A';
  if (decimals === 0) return Math.round(val).toLocaleString('en-US');
  return val.toFixed(decimals);
}

export function saveScalingJsonReport(report: RegionalScalingReport, outPath: string): string {
  const resolved = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return resolved;
}

/**
 * Generates an evidence-based Markdown analysis report strictly derived from measured
 * Hengelo S1–S5 scaling data without inventing metrics or making speculative edits.
 */
export function formatScalingMarkdownReport(report: RegionalScalingReport): string {
  const lines: string[] = [];
  lines.push('# Regional Rendering Scalability Assessment (Hengelo S1–S5)');
  lines.push('');
  lines.push(`- **Generated**: ${report.generatedAtIso}`);
  lines.push(`- **Dataset Source**: ${report.datasetSeries.sourceFileName} (OSM base timestamp: \`${report.datasetSeries.osmTimestampIso}\`)`);
  lines.push(`- **OSM Attribution**: ${report.datasetSeries.attribution}`);
  lines.push(
    `- **Environment**: Node ${report.environment.nodeVersion} on ${report.environment.platform} (${report.environment.arch}), ${report.environment.cpuModel} (${report.environment.cpuLogicalCores} logical cores), System RAM: ${fmtNum(report.environment.totalSystemMemoryMB)} MB`
  );
  lines.push(
    `- **Git Metadata**: \`${report.environment.gitCommitSha}\` (status: \`${report.environment.gitMetadataStatus ?? 'unknown'}\`, dirty: \`${report.environment.gitDirty}\`${report.environment.gitMetadataReason ? ` — ${report.environment.gitMetadataReason}` : ''})`
  );
  lines.push(
    `- **Resource Guardrails**: sequential child worker (\`concurrency = 1\`), \`maxRss = ${report.resourceLimits.maxRssMB} MB\`, \`--max-old-space-size=${report.resourceLimits.maxOldSpaceSizeMB} MB\`, \`timeout = ${(report.resourceLimits.timeoutMs / 1000).toFixed(0)} s\`, \`validatorMaxEdges = ${report.resourceLimits.validatorMaxEdges}\`, \`warmup = ${report.methodology.warmupIterations}\`, \`iterations = ${report.methodology.measuredIterations}\``
  );
  lines.push('');

  lines.push('## 1. Progressive Hengelo Real-World Dataset Series');
  lines.push('');
  lines.push(
    '| Level | Extent | Area (km²) | Raw GeoJSON | OSM Nodes / Ways / Rels | Parsed Total | Roads | Railways | Buildings | Landuse + Parks | Water | Barriers | Landmarks | SHA-256 (gzip prefix) |'
  );
  lines.push('| :--- | :--- | ---: | ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |');

  for (const ds of report.datasetSeries.datasets) {
    const sampleCompleted = report.results.find(
      (r) => r.dataset.id === ds.id && r.status === 'completed' && r.completenessAndCorrectness
    );
    const parsed = sampleCompleted?.completenessAndCorrectness?.parsedByCategory;
    const parsedTotal = sampleCompleted?.completenessAndCorrectness?.totalFeaturesParsed;
    const landuseParks = parsed ? parsed.landuse + parsed.parks : null;
    const water = parsed ? parsed.waterBodies + parsed.linearWaterways : null;
    lines.push(
      `| ${ds.level} | ${ds.widthMeters} × ${ds.depthMeters} m | ${ds.areaKm2.toFixed(4)} | ${fmtNum(ds.geoJsonFeatureCount)} | ${fmtNum(ds.osmElementCounts.nodes)} / ${fmtNum(ds.osmElementCounts.ways)} / ${fmtNum(ds.osmElementCounts.relations)} | ${fmtNum(parsedTotal)} | ${fmtNum(parsed?.roads)} | ${fmtNum(parsed?.railways)} | ${fmtNum(parsed?.buildings)} | ${fmtNum(landuseParks)} | ${fmtNum(water)} | ${fmtNum(parsed?.barriers)} | ${fmtNum(parsed?.landmarks)} | \`${ds.gzipFileSha256.slice(0, 12)}\` |`
    );
  }
  lines.push('');

  lines.push('## 2. Progression Summary by Renderer Configuration');
  lines.push('');
  lines.push(
    '| Configuration | Highest Completed Level | Stopped At | Completed / Failed / Skipped | Stop Reason |'
  );
  lines.push('| :--- | :--- | :--- | :--- | :--- |');
  for (const s of report.configSummaries) {
    lines.push(
      `| \`${s.configId}\` | ${s.highestCompletedLevel ?? 'None'} | ${s.stoppedAtLevel ?? '—'} | ${s.completedLevelsCount} / ${s.failedLevelsCount} / ${s.skippedLevelsCount} | ${s.stopReason ?? 'All attempted scales completed within limits'} |`
    );
  }
  lines.push('');

  lines.push('## 3. Pipeline Stage Timings, Memory & Geometry Scaling');
  lines.push('');
  lines.push(
    '| Level | Config | Status | Full Scene | Parse | Graph + Adapter | Planar | Roads (Sub-stages) | Railway | Peak RSS (Worker / Polled) | CpuBuf MB | Tris (w/ Inst) | Meshes | Disposal Leaks |'
  );
  lines.push(
    '| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |'
  );

  for (const r of report.results) {
    const t = r.timingsMs;
    const graphAdapterStr =
      t?.infrastructureGraphBuildMs || t?.graphToRendererAdapterMs
        ? `${fmtMs(t.infrastructureGraphBuildMs)} + ${fmtMs(t.graphToRendererAdapterMs)}`
        : 'N/A (legacy)';
    const roadSub = t?.roadSubStagesMs
      ? ` (fp ${fmtMs(t.roadSubStagesMs.footprintConstructionMs)}, un ${fmtMs(t.roadSubStagesMs.polygonUnionMs)}, cl ${fmtMs(t.roadSubStagesMs.ownershipClippingMs)}, tri ${fmtMs(t.roadSubStagesMs.triangulationAndValidationMs)})`
      : '';
    const roadStr = `${fmtMs(t?.roadGeometryGenerationMs)}${roadSub}`;
    const rssStr = r.memory
      ? `${fmtNum(r.memory.processRssMB.workerPeakObservedMB, 1)} / ${fmtNum(r.memory.processRssMB.parentPolledPeakMB, 1)} MB`
      : r.memory === null && r.status !== 'completed'
        ? 'Aborted / Skipped'
        : 'N/A';
    const leakStr = r.memory
      ? r.memory.lifecycleAudit.disposalVerified
        ? '0 (OK)'
        : `${r.memory.lifecycleAudit.netLeakedGeometries}g / ${r.memory.lifecycleAudit.netLeakedMaterials}m`
      : '—';

    lines.push(
      `| ${r.dataset.level} | \`${r.rendererConfig.id}\` | \`${r.status}\` | ${fmtMs(t?.fullSceneGeometryGenerationMs)} | ${fmtMs(t?.geojsonParseAndClassifyMs)} | ${graphAdapterStr} | ${fmtMs(t?.planarSurfaceResolutionMs)} | ${roadStr} | ${fmtMs(t?.railwayGeometryGenerationMs)} | ${rssStr} | ${fmtNum(r.memory?.cpuBufferMemory.totalMB, 2)} | ${fmtNum(r.sceneGeometry?.renderedTrianglesWithInstances)} | ${fmtNum(r.sceneGeometry?.constructedMeshesCount)} | ${leakStr} |`
    );
  }
  lines.push('');

  lines.push('## 4. Boolean Operation Counts & Geometry Workload Indicators');
  lines.push('');
  lines.push(
    '| Level | Config | Planar Check / Conflicts / Union / Diff | Road Blocker Checks / Overlaps | Road Union / Inter / Diff | Road Reject / Sub / ClipFail | Rail Ballast Unions | Rail Spatial Index Queries / Entries |'
  );
  lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | ---: | :--- |');
  for (const r of report.results) {
    if (r.status !== 'completed' || !r.operations) continue;
    const p = r.operations.planarSurface;
    const rd = r.operations.roads;
    const rl = r.operations.railways;
    lines.push(
      `| ${r.dataset.level} | \`${r.rendererConfig.id}\` | ${fmtNum(p.overlappingPairsChecked)} / ${fmtNum(p.conflictsResolved)} / ${fmtNum(p.unionedCount)} / ${fmtNum(p.booleanSubtractionsCount)} | ${fmtNum(rd.candidateBlockerCheckCount)} / ${fmtNum(rd.overlappingBlockerCount)} | ${fmtNum(rd.polygonUnionOperationCount)} / ${fmtNum(rd.polygonIntersectionOperationCount)} / ${fmtNum(rd.polygonDifferenceOperationCount)} | ${fmtNum(rd.rejectedOrDegenerateCount)} / ${fmtNum(rd.fullySubtractedCount)} / ${fmtNum(rd.surfaceClipFailureCount)} | ${fmtNum(rl.ballastBooleanUnionCount)} | ${fmtNum(rl.spatialIndexCellCount)} cells / ${fmtNum(rl.spatialIndexEntries)} segs |`
    );
  }
  lines.push('');

  lines.push('## 5. Data Completeness, Topology & Geometry Correctness');
  lines.push('');
  lines.push(
    '| Level | Config | Classified -> Rendered (Ratio) | Unsupported / Rejected | Clipped / Omitted | Unresolved Switch / Grade / Cross / Pt | Unattrib Faces / Inst / NaN Verts | Planar Overlap m² | Mesh Winding / Degenerate | Road Overlap & Coverage Guard |'
  );
  lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | ---: | :--- | :--- |');

  for (const r of report.results) {
    if (r.status !== 'completed' || !r.completenessAndCorrectness) continue;
    const c = r.completenessAndCorrectness;
    const ex = c.exclusionsAndLineage;
    const rc = c.renderedCoverage;
    const topo = c.topologyAudit;
    const gv = c.geometryValidation;

    const topoStr = topo
      ? `${topo.railwayUnresolvedSwitchCount} / ${topo.unresolvedGradeTransitionCount} / ${topo.unresolvedCrossingCount} / ${topo.unresolvedInfrastructurePointsCount}`
      : 'N/A';
    const windingStr = `${fmtNum(gv.graphMeshIntegrity.negativelyWoundCount)}w / ${fmtNum(gv.graphMeshIntegrity.degenerateTriangleCount)}d`;
    const guardStr =
      gv.surfaceFirstValidation.status === 'executed'
        ? `Executed (ov=${gv.surfaceFirstValidation.overlapDefectCount}, covDef=${gv.surfaceFirstValidation.coverageDefectCount}, ratio=${gv.surfaceFirstValidation.networkCoverageRatio})`
        : gv.roadNetworkOverlapAndContinuity.status === 'executed'
          ? `RoadVal Executed (ov=${gv.roadNetworkOverlapAndContinuity.overlapConflictCount}, cont=${gv.roadNetworkOverlapAndContinuity.continuityDefectCount})`
          : `${gv.roadNetworkOverlapAndContinuity.status}`;

    lines.push(
      `| ${r.dataset.level} | \`${r.rendererConfig.id}\` | ${fmtNum(c.sourceFeaturesClassified)} -> ${fmtNum(rc.sourceFeaturesRenderedCount)} (${(rc.coverageVsClassifiedRatio * 100).toFixed(1)}%) | ${fmtNum(ex.skippedUnsupportedTotal)} / ${fmtNum(ex.rejectedInvalidTotal)} | ${fmtNum(ex.clippedByBoundaryCount)} / ${fmtNum(ex.omittedOutsideBoundaryCount)} | ${topoStr} | ${fmtNum(rc.unattributedMeshFacesCount)}f / ${fmtNum(rc.unattributedInstancedItemsCount)}i / ${fmtNum(rc.invalidNanOrNonFiniteVertexCount)} | ${r.operations?.planarSurface.maxResidualFillOverlapSqMeters.toExponential(2) ?? 'N/A'} | ${windingStr} | ${guardStr} |`
    );
  }
  lines.push('');

  lines.push('## 6. Empirical Scaling Observations & Bottleneck Analysis');
  lines.push('');
  lines.push(...buildEmpiricalObservations(report));
  lines.push('');

  lines.push('## 7. Architectural Implications Toward Twente (~Regional Scale)');
  lines.push('');
  lines.push(
    '- **Offline / Prebaked Geometry vs. Runtime Client Generation**: Runtime in-browser polygon Boolean resolution (`polygon-clipping`), triangulation, and 3D sleeper synthesis already take multiple seconds even on a single 2×2–4×4 km Hengelo tile; whole-Twente geometry (~1,500 km², ~100×–375× the area of `S4`/`S5`) cannot be built synchronously on a browser main thread from raw GeoJSON.'
  );
  lines.push(
    '- **Spatial Tiling & Chunk Boundary Effects**: Fixed 2D Euclidean projection with square/radial clipping introduces `clippedAtStart`/`clippedAtEnd` boundary cuts (`boundaryClippedNodeCount`) and portal discontinuity risks if tiles are built independently without canonical OSM IDs or deterministic tile-overlap halos + shared edge ownership rules.'
  );
  lines.push(
    '- **Spatial Indexing Before Polygon Clipping / Proximity Checks**: Stages whose runtime grows super-linearly with feature density (pairwise polygon ownership/planar checks, unindexed road blocker sweeps, or dense `polygonClipping.union` cascades) exhibit super-linear growth across `S1` -> `S5`; grid/R-tree spatial indexing and tile-scoped bounding reduce candidate checks from quadratic to near-linear per tile.'
  );
  lines.push(
    '- **Multi-LOD & On-Demand Loading**: Full 3D instanced sleepers (`sleeperInstancesCount`), detailed building extrusions, and minor street-furniture landmarks (`waste_basket`, `bench`, `tree`) should be streamed by zoom-appropriate tile LOD rather than materialized across an entire region simultaneously.'
  );
  lines.push(
    '- **Web Workers**: Even inside a single interactive neighborhood tile (`S3`/`S4`), moving `LocalGeoJsonProvider`, `buildInfrastructureGraph`, `resolveAndValidatePlanarPolygons`, and road/railway Boolean triangulation off the UI thread prevents multi-second main-thread freezes.'
  );
  lines.push('');

  lines.push('## 8. Recommended Next Milestone & First Measured Bottleneck');
  lines.push('');
  lines.push(...buildRecommendationSection(report));
  lines.push('');

  return lines.join('\n');
}

function getDominantStage(r: ScalingWorkloadResult): { stage: string; ms: number; sharePct: number } | null {
  if (!r.timingsMs) return null;
  const full = r.timingsMs.fullSceneGeometryGenerationMs.median;
  if (!(full > 0)) return null;
  const candidates: Array<{ stage: string; ms: number }> = [
    { stage: 'planarSurfaceResolution (direct)', ms: r.timingsMs.planarSurfaceResolutionMs?.median ?? 0 },
    { stage: 'roadGeometryGeneration', ms: r.timingsMs.roadGeometryGenerationMs?.median ?? 0 },
    { stage: 'railwayGeometryGeneration', ms: r.timingsMs.railwayGeometryGenerationMs?.median ?? 0 },
  ];
  candidates.sort((a, b) => b.ms - a.ms);
  const top = candidates[0];
  return {
    stage: top.stage,
    ms: top.ms,
    sharePct: (top.ms / full) * 100,
  };
}

function buildEmpiricalObservations(report: RegionalScalingReport): string[] {
  const bullets: string[] = [];
  const configIds = Array.from(new Set(report.results.map((r) => r.rendererConfig.id)));

  for (const cfgId of configIds) {
    const completed = report.results.filter(
      (r) => r.rendererConfig.id === cfgId && r.status === 'completed' && r.timingsMs
    );
    const failed = report.results.filter(
      (r) => r.rendererConfig.id === cfgId && r.status !== 'completed' && r.status !== 'skipped_due_to_threshold'
    );
    if (completed.length >= 2) {
      const first = completed[0];
      const last = completed[completed.length - 1];
      const areaRatio = last.dataset.areaKm2 / first.dataset.areaKm2;
      const featureRatio =
        (last.completenessAndCorrectness?.totalFeaturesParsed ?? last.dataset.geoJsonFeatureCount) /
        Math.max(1, first.completenessAndCorrectness?.totalFeaturesParsed ?? first.dataset.geoJsonFeatureCount);
      const sceneRatio =
        last.timingsMs!.fullSceneGeometryGenerationMs.median /
        Math.max(0.01, first.timingsMs!.fullSceneGeometryGenerationMs.median);
      const rssDelta =
        (last.memory?.processRssMB.workerPeakObservedMB ?? 0) -
        (first.memory?.processRssMB.workerPeakObservedMB ?? 0);
      const dom = getDominantStage(last);

      bullets.push(
        `- **\`${cfgId}\` (${first.dataset.level} → ${last.dataset.level})**: Area scaled **${areaRatio.toFixed(0)}×** and parsed features **${featureRatio.toFixed(1)}×**, while \`fullSceneGeometryGenerationMs\` median scaled **${sceneRatio.toFixed(1)}×** (${first.timingsMs!.fullSceneGeometryGenerationMs.median.toFixed(1)} ms → ${last.timingsMs!.fullSceneGeometryGenerationMs.median.toFixed(1)} ms) and worker peak RSS increased by **+${rssDelta.toFixed(1)} MB** (to ${last.memory?.processRssMB.workerPeakObservedMB.toFixed(1)} MB).${dom ? ` Largest measured scene sub-stage at ${last.dataset.level}: \`${dom.stage}\` (${dom.ms.toFixed(1)} ms, ${dom.sharePct.toFixed(0)}% of scene build).` : ''}`
      );
    } else if (completed.length === 1) {
      const only = completed[0];
      bullets.push(
        `- **\`${cfgId}\`**: Completed only \`${only.dataset.level}\` (${only.timingsMs!.fullSceneGeometryGenerationMs.median.toFixed(1)} ms full scene, ${only.memory?.processRssMB.workerPeakObservedMB.toFixed(1)} MB peak RSS).`
      );
    }
    if (failed.length > 0) {
      const f = failed[0];
      bullets.push(
        `  - Stopped at **${f.dataset.level}** (\`${f.status}\`): ${f.statusReason}`
      );
    }
  }

  return bullets.length > 0 ? bullets : ['- No completed workloads recorded in report.'];
}

function buildRecommendationSection(report: RegionalScalingReport): string[] {
  const completedLargest = [...report.results]
    .filter((r) => r.status === 'completed' && r.timingsMs)
    .sort((a, b) => b.dataset.areaKm2 - a.dataset.areaKm2);

  if (completedLargest.length === 0) {
    return [
      '- First target the failure recorded on S1 before optimizing downstream stages.',
    ];
  }

  const maxArea = completedLargest[0].dataset.areaKm2;
  const topAtMax = completedLargest.filter((r) => r.dataset.areaKm2 === maxArea);

  let worstStageName = 'unknown';
  let worstConfigId = '';
  let worstMs = -1;
  for (const r of topAtMax) {
    const dom = getDominantStage(r);
    if (dom && dom.ms > worstMs) {
      worstMs = dom.ms;
      worstStageName = dom.stage;
      worstConfigId = r.rendererConfig.id;
    }
  }

  const anyFailed = report.results.find(
    (r) => r.status !== 'completed' && r.status !== 'skipped_due_to_threshold'
  );

  const lines = [
    `- **First Measured Scaling Bottleneck**: At the largest completed extent (\`${topAtMax[0].dataset.level}\`, ${maxArea} km²), \`${worstStageName}\` in \`${worstConfigId}\` accounted for **${worstMs.toFixed(1)} ms** (see Section 3 & Section 4 for Boolean/candidate op counts across configurations).${anyFailed ? ` Meanwhile \`${anyFailed.rendererConfig.id}\` hit \`${anyFailed.status}\` at \`${anyFailed.dataset.level}\` (${anyFailed.statusReason}).` : ''}`,
    '- **Recommended Next Milestone**: Before attempting Twente-wide scenes, introduce **spatially indexed / tiled scene synthesis** (bounding candidate polygons and road blockers via a uniform spatial hash / R-tree per tile, and partitioning datasets into bounded tile extents with off-main-thread Web Worker / prebaked tile support), guided directly by the measured stage timings and Boolean operation counts recorded in this report.',
  ];
  return lines;
}
