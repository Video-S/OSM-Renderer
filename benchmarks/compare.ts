import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadBenchmarkReport,
  validateBenchmarkReport,
} from './serializer';
import {
  DEFAULT_REGRESSION_THRESHOLDS,
  evaluateMetricComparison,
} from './stats';
import {
  BENCHMARK_SCHEMA_VERSION,
  BenchmarkComparisonReport,
  BenchmarkReport,
  BrowserWorkloadBenchmarkResult,
  CpuWorkloadBenchmarkResult,
  MetricComparisonDelta,
  RegressionThresholdConfig,
  WorkloadComparisonResult,
} from './types';

function makeWorkloadKey(datasetId: string, configId: string): string {
  return `${datasetId}::${configId}`;
}

function compareCpuWorkloads(
  base: CpuWorkloadBenchmarkResult,
  cand: CpuWorkloadBenchmarkResult,
  thresholds: RegressionThresholdConfig
): WorkloadComparisonResult {
  const workloadKey = makeWorkloadKey(base.dataset.id, base.rendererConfig.id);
  const incompatibilityReasons: string[] = [];

  if (base.dataset.contentHashSha256 !== cand.dataset.contentHashSha256) {
    incompatibilityReasons.push(
      `Dataset content hash mismatch for "${base.dataset.id}": baseline=${base.dataset.contentHashSha256.slice(0, 12)} vs candidate=${cand.dataset.contentHashSha256.slice(0, 12)}.`
    );
  }

  if (
    base.rendererConfig.infrastructureRenderOptions.roads !==
      cand.rendererConfig.infrastructureRenderOptions.roads ||
    base.rendererConfig.infrastructureRenderOptions.railways !==
      cand.rendererConfig.infrastructureRenderOptions.railways ||
    base.rendererConfig.railwayPrototypeMode !== cand.rendererConfig.railwayPrototypeMode
  ) {
    incompatibilityReasons.push(
      `Renderer configuration mismatch for "${base.rendererConfig.id}".`
    );
  }

  if (incompatibilityReasons.length > 0) {
    return {
      workloadKey,
      datasetId: base.dataset.id,
      datasetName: base.dataset.name,
      rendererConfigId: base.rendererConfig.id,
      compatible: false,
      incompatibilityReasons,
      metrics: [],
      regressionsFlagged: [],
    };
  }

  const metrics: MetricComparisonDelta[] = [
    evaluateMetricComparison({
      metricPath: 'timingsMs.geojsonParseAndClassifyMs.median',
      label: 'GeoJSON Parse & Classify (Median)',
      unit: 'ms',
      baselineValue: base.timingsMs.geojsonParseAndClassifyMs?.median ?? null,
      candidateValue: cand.timingsMs.geojsonParseAndClassifyMs?.median ?? null,
      higherIsWorse: true,
      thresholdPct: thresholds.maxCpuTimeRegressionPct,
      minAbsoluteDeltaForRegression: thresholds.minTimingRegressionAbsoluteDeltaMs,
    }),
    evaluateMetricComparison({
      metricPath: 'timingsMs.infrastructureGraphBuildMs.median',
      label: 'Infrastructure Graph Build (Median)',
      unit: 'ms',
      baselineValue: base.timingsMs.infrastructureGraphBuildMs?.median ?? null,
      candidateValue: cand.timingsMs.infrastructureGraphBuildMs?.median ?? null,
      higherIsWorse: true,
      thresholdPct: thresholds.maxCpuTimeRegressionPct,
      minAbsoluteDeltaForRegression: thresholds.minTimingRegressionAbsoluteDeltaMs,
    }),
    evaluateMetricComparison({
      metricPath: 'timingsMs.graphToRendererAdapterMs.median',
      label: 'Graph-to-Renderer Adapter (Median)',
      unit: 'ms',
      baselineValue: base.timingsMs.graphToRendererAdapterMs?.median ?? null,
      candidateValue: cand.timingsMs.graphToRendererAdapterMs?.median ?? null,
      higherIsWorse: true,
      thresholdPct: thresholds.maxCpuTimeRegressionPct,
      minAbsoluteDeltaForRegression: thresholds.minTimingRegressionAbsoluteDeltaMs,
    }),
    evaluateMetricComparison({
      metricPath: 'timingsMs.planarSurfaceResolutionMs.median',
      label: 'Planar Surface Resolution (Median)',
      unit: 'ms',
      baselineValue: base.timingsMs.planarSurfaceResolutionMs?.median ?? null,
      candidateValue: cand.timingsMs.planarSurfaceResolutionMs?.median ?? null,
      higherIsWorse: true,
      thresholdPct: thresholds.maxCpuTimeRegressionPct,
      minAbsoluteDeltaForRegression: thresholds.minTimingRegressionAbsoluteDeltaMs,
    }),
    evaluateMetricComparison({
      metricPath: 'timingsMs.roadGeometryGenerationMs.median',
      label: 'Road Geometry Generation (Median)',
      unit: 'ms',
      baselineValue: base.timingsMs.roadGeometryGenerationMs?.median ?? null,
      candidateValue: cand.timingsMs.roadGeometryGenerationMs?.median ?? null,
      higherIsWorse: true,
      thresholdPct: thresholds.maxCpuTimeRegressionPct,
      minAbsoluteDeltaForRegression: thresholds.minTimingRegressionAbsoluteDeltaMs,
    }),
    evaluateMetricComparison({
      metricPath: 'timingsMs.railwayGeometryGenerationMs.median',
      label: 'Railway Geometry Generation (Median)',
      unit: 'ms',
      baselineValue: base.timingsMs.railwayGeometryGenerationMs?.median ?? null,
      candidateValue: cand.timingsMs.railwayGeometryGenerationMs?.median ?? null,
      higherIsWorse: true,
      thresholdPct: thresholds.maxCpuTimeRegressionPct,
      minAbsoluteDeltaForRegression: thresholds.minTimingRegressionAbsoluteDeltaMs,
    }),
    evaluateMetricComparison({
      metricPath: 'timingsMs.fullSceneGeometryGenerationMs.median',
      label: 'Full Scene Build (Median)',
      unit: 'ms',
      baselineValue: base.timingsMs.fullSceneGeometryGenerationMs.median,
      candidateValue: cand.timingsMs.fullSceneGeometryGenerationMs.median,
      higherIsWorse: true,
      thresholdPct: thresholds.maxCpuTimeRegressionPct,
      minAbsoluteDeltaForRegression: thresholds.minTimingRegressionAbsoluteDeltaMs,
    }),
    evaluateMetricComparison({
      metricPath: 'timingsMs.fullSceneGeometryGenerationMs.p95',
      label: 'Full Scene Build (p95)',
      unit: 'ms',
      baselineValue: base.timingsMs.fullSceneGeometryGenerationMs.p95,
      candidateValue: cand.timingsMs.fullSceneGeometryGenerationMs.p95,
      higherIsWorse: true,
      thresholdPct: thresholds.maxCpuTimeRegressionPct,
      minAbsoluteDeltaForRegression: thresholds.minTimingRegressionAbsoluteDeltaMs,
    }),
    evaluateMetricComparison({
      metricPath: 'timingsMs.sceneResourceDisposalMs.median',
      label: 'Scene Resource Disposal (Median)',
      unit: 'ms',
      baselineValue: base.timingsMs.sceneResourceDisposalMs.median,
      candidateValue: cand.timingsMs.sceneResourceDisposalMs.median,
      higherIsWorse: true,
      thresholdPct: thresholds.maxCpuTimeRegressionPct,
      minAbsoluteDeltaForRegression: thresholds.minTimingRegressionAbsoluteDeltaMs,
    }),
    evaluateMetricComparison({
      metricPath: 'memoryAndGeometry.cpuBufferMemory.totalBytes',
      label: 'CPU Buffer Memory (Bytes)',
      unit: 'bytes',
      baselineValue: base.memoryAndGeometry.cpuBufferMemory.totalBytes,
      candidateValue: cand.memoryAndGeometry.cpuBufferMemory.totalBytes,
      higherIsWorse: true,
      thresholdPct: thresholds.maxCpuBufferMemoryRegressionPct,
      minAbsoluteDeltaForRegression: 1024,
    }),
    evaluateMetricComparison({
      metricPath: 'memoryAndGeometry.sceneGeometry.renderedTrianglesWithInstances',
      label: 'Rendered Triangles (with Instances)',
      unit: 'triangles',
      baselineValue: base.memoryAndGeometry.sceneGeometry.renderedTrianglesWithInstances,
      candidateValue: cand.memoryAndGeometry.sceneGeometry.renderedTrianglesWithInstances,
      higherIsWorse: true,
    }),
    evaluateMetricComparison({
      metricPath: 'memoryAndGeometry.sceneGeometry.constructedMeshesCount',
      label: 'Constructed Scene Meshes',
      unit: 'count',
      baselineValue: base.memoryAndGeometry.sceneGeometry.constructedMeshesCount,
      candidateValue: cand.memoryAndGeometry.sceneGeometry.constructedMeshesCount,
      higherIsWorse: true,
      thresholdPct: thresholds.maxDrawCallsRegressionPct,
      minAbsoluteDeltaForRegression: 1,
    }),
  ];

  const regressionsFlagged = metrics.filter((m) => m.status === 'regressed');

  return {
    workloadKey,
    datasetId: base.dataset.id,
    datasetName: base.dataset.name,
    rendererConfigId: base.rendererConfig.id,
    compatible: true,
    incompatibilityReasons: [],
    metrics,
    regressionsFlagged,
  };
}

function compareBrowserWorkloads(
  base: BrowserWorkloadBenchmarkResult,
  cand: BrowserWorkloadBenchmarkResult,
  thresholds: RegressionThresholdConfig
): WorkloadComparisonResult {
  const workloadKey = makeWorkloadKey(base.dataset.id, base.rendererConfig.id);
  const incompatibilityReasons: string[] = [];

  if (base.dataset.contentHashSha256 !== cand.dataset.contentHashSha256) {
    incompatibilityReasons.push(
      `Dataset content hash mismatch for "${base.dataset.id}": baseline=${base.dataset.contentHashSha256.slice(0, 12)} vs candidate=${cand.dataset.contentHashSha256.slice(0, 12)}.`
    );
  }

  if (
    base.rendererConfig.infrastructureRenderOptions.roads !==
      cand.rendererConfig.infrastructureRenderOptions.roads ||
    base.rendererConfig.infrastructureRenderOptions.railways !==
      cand.rendererConfig.infrastructureRenderOptions.railways
  ) {
    incompatibilityReasons.push(
      `Renderer configuration mismatch for "${base.rendererConfig.id}".`
    );
  }

  if (incompatibilityReasons.length > 0) {
    return {
      workloadKey,
      datasetId: base.dataset.id,
      datasetName: base.dataset.name,
      rendererConfigId: base.rendererConfig.id,
      compatible: false,
      incompatibilityReasons,
      metrics: [],
      regressionsFlagged: [],
    };
  }

  const metrics: MetricComparisonDelta[] = [
    evaluateMetricComparison({
      metricPath: 'initializationTimingMs.totalSceneInitToFirstFrameMs',
      label: 'Scene Init to First Render',
      unit: 'ms',
      baselineValue: base.initializationTimingMs.totalSceneInitToFirstFrameMs,
      candidateValue: cand.initializationTimingMs.totalSceneInitToFirstFrameMs,
      higherIsWorse: true,
      thresholdPct: thresholds.maxFrameTimeRegressionPct,
      minAbsoluteDeltaForRegression: thresholds.minTimingRegressionAbsoluteDeltaMs,
    }),
  ];

  const baseScenarioMap = new Map(base.scenarios.map((s) => [s.scenarioId, s]));
  const candScenarioMap = new Map(cand.scenarios.map((s) => [s.scenarioId, s]));
  const allScenarioIds = new Set([...baseScenarioMap.keys(), ...candScenarioMap.keys()]);

  for (const scId of allScenarioIds) {
    const bSc = baseScenarioMap.get(scId);
    const cSc = candScenarioMap.get(scId);

    metrics.push(
      evaluateMetricComparison({
        metricPath: `scenarios.${scId}.frameIntervalMs.median`,
        label: `[${scId}] Frame Interval (Median)`,
        unit: 'ms',
        baselineValue: bSc?.frameIntervalMs.median ?? null,
        candidateValue: cSc?.frameIntervalMs.median ?? null,
        higherIsWorse: true,
        thresholdPct: thresholds.maxFrameTimeRegressionPct,
        minAbsoluteDeltaForRegression: thresholds.minTimingRegressionAbsoluteDeltaMs,
      }),
      evaluateMetricComparison({
        metricPath: `scenarios.${scId}.frameIntervalMs.p95`,
        label: `[${scId}] Frame Interval (p95)`,
        unit: 'ms',
        baselineValue: bSc?.frameIntervalMs.p95 ?? null,
        candidateValue: cSc?.frameIntervalMs.p95 ?? null,
        higherIsWorse: true,
        thresholdPct: thresholds.maxFrameTimeRegressionPct,
        minAbsoluteDeltaForRegression: thresholds.minTimingRegressionAbsoluteDeltaMs,
      }),
      evaluateMetricComparison({
        metricPath: `scenarios.${scId}.cpuFrameRenderTimeMs.median`,
        label: `[${scId}] CPU gl.render Time (Median)`,
        unit: 'ms',
        baselineValue: bSc?.cpuFrameRenderTimeMs.median ?? null,
        candidateValue: cSc?.cpuFrameRenderTimeMs.median ?? null,
        higherIsWorse: true,
        thresholdPct: thresholds.maxFrameTimeRegressionPct,
        minAbsoluteDeltaForRegression: thresholds.minTimingRegressionAbsoluteDeltaMs,
      }),
      evaluateMetricComparison({
        metricPath: `scenarios.${scId}.gpuFrameRenderTimeMs.median`,
        label: `[${scId}] GPU Timer Query (Median)`,
        unit: 'ms',
        baselineValue: bSc?.gpuFrameRenderTimeMs.statistics?.median ?? null,
        candidateValue: cSc?.gpuFrameRenderTimeMs.statistics?.median ?? null,
        higherIsWorse: true,
        thresholdPct: thresholds.maxFrameTimeRegressionPct,
        minAbsoluteDeltaForRegression: thresholds.minTimingRegressionAbsoluteDeltaMs,
      }),
      evaluateMetricComparison({
        metricPath: `scenarios.${scId}.webglDrawCallsPerFrame.median`,
        label: `[${scId}] WebGL Draw Calls / Frame`,
        unit: 'calls',
        baselineValue: bSc?.webglDrawCallsPerFrame.median ?? null,
        candidateValue: cSc?.webglDrawCallsPerFrame.median ?? null,
        higherIsWorse: true,
        thresholdPct: thresholds.maxDrawCallsRegressionPct,
        minAbsoluteDeltaForRegression: 1,
      }),
      evaluateMetricComparison({
        metricPath: `scenarios.${scId}.renderedTrianglesPerFrame.median`,
        label: `[${scId}] Rendered Triangles / Frame`,
        unit: 'triangles',
        baselineValue: bSc?.renderedTrianglesPerFrame.median ?? null,
        candidateValue: cSc?.renderedTrianglesPerFrame.median ?? null,
        higherIsWorse: true,
      })
    );
  }

  const regressionsFlagged = metrics.filter((m) => m.status === 'regressed');

  return {
    workloadKey,
    datasetId: base.dataset.id,
    datasetName: base.dataset.name,
    rendererConfigId: base.rendererConfig.id,
    compatible: true,
    incompatibilityReasons: [],
    metrics,
    regressionsFlagged,
  };
}

/**
 * Compares two saved BenchmarkReports, validating schema compatibility, dataset hash equality,
 * and environment parity while computing absolute and percentage deltas across all metrics.
 */
export function compareBenchmarkReports(
  baseline: BenchmarkReport,
  candidate: BenchmarkReport,
  thresholdOverrides?: Partial<RegressionThresholdConfig>
): BenchmarkComparisonReport {
  const thresholds: RegressionThresholdConfig = {
    ...DEFAULT_REGRESSION_THRESHOLDS,
    ...thresholdOverrides,
  };

  const incompatibilityErrors: string[] = [];
  const environmentWarnings: string[] = [];

  const baseCheck = validateBenchmarkReport(baseline);
  if (!baseCheck.valid) {
    incompatibilityErrors.push(
      `Baseline report failed schema validation: ${baseCheck.errors.join('; ')}`
    );
  }

  const candCheck = validateBenchmarkReport(candidate);
  if (!candCheck.valid) {
    incompatibilityErrors.push(
      `Candidate report failed schema validation: ${candCheck.errors.join('; ')}`
    );
  }

  if (baseline.schemaVersion !== candidate.schemaVersion) {
    incompatibilityErrors.push(
      `Schema version mismatch: baseline=${baseline.schemaVersion} vs candidate=${candidate.schemaVersion}.`
    );
  }

  if (baseline.suite !== candidate.suite) {
    incompatibilityErrors.push(
      `Cannot compare different benchmark suites: baseline="${baseline.suite}" vs candidate="${candidate.suite}".`
    );
  }

  // Check browser viewport/renderer compatibility when comparing browser reports
  if (baseline.suite === 'browser' && candidate.suite === 'browser') {
    const bBrowser = baseline.environment?.browser;
    const cBrowser = candidate.environment?.browser;
    if (bBrowser && cBrowser) {
      if (
        bBrowser.viewportWidth !== cBrowser.viewportWidth ||
        bBrowser.viewportHeight !== cBrowser.viewportHeight ||
        bBrowser.devicePixelRatio !== cBrowser.devicePixelRatio
      ) {
        incompatibilityErrors.push(
          `Browser viewport/DPR mismatch: baseline=${bBrowser.viewportWidth}x${bBrowser.viewportHeight}@${bBrowser.devicePixelRatio}x vs candidate=${cBrowser.viewportWidth}x${cBrowser.viewportHeight}@${cBrowser.devicePixelRatio}x.`
        );
      }
      if (bBrowser.isSoftwareRenderer !== cBrowser.isSoftwareRenderer) {
        incompatibilityErrors.push(
          `Incompatible GPU rasterizer class: baseline isSoftwareRenderer=${bBrowser.isSoftwareRenderer} (${bBrowser.gpuRenderer}) vs candidate isSoftwareRenderer=${cBrowser.isSoftwareRenderer} (${cBrowser.gpuRenderer}).`
        );
      } else if (
        !bBrowser.isSoftwareRenderer &&
        bBrowser.gpuRenderer !== cBrowser.gpuRenderer
      ) {
        environmentWarnings.push(
          `Hardware GPU renderer differs between reports: "${bBrowser.gpuRenderer}" vs "${cBrowser.gpuRenderer}".`
        );
      }
    }
  }

  if (baseline.environment?.cpuModel !== candidate.environment?.cpuModel) {
    environmentWarnings.push(
      `CPU model differs between reports: "${baseline.environment?.cpuModel}" vs "${candidate.environment?.cpuModel}".`
    );
  }
  if (baseline.environment?.nodeVersion !== candidate.environment?.nodeVersion) {
    environmentWarnings.push(
      `Node.js version differs: ${baseline.environment?.nodeVersion} vs ${candidate.environment?.nodeVersion}.`
    );
  }

  if (incompatibilityErrors.length > 0) {
    return {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      comparedAtIso: new Date().toISOString(),
      suite: baseline.suite === candidate.suite ? baseline.suite : 'incompatible',
      compatible: false,
      incompatibilityErrors,
      environmentWarnings,
      baselineCommitSha: baseline.environment?.gitCommitSha || 'unknown',
      candidateCommitSha: candidate.environment?.gitCommitSha || 'unknown',
      thresholds,
      workloadComparisons: [],
      unmatchedBaselineWorkloads: [],
      unmatchedCandidateWorkloads: [],
      totalRegressionsFlagged: 0,
    };
  }

  const workloadComparisons: WorkloadComparisonResult[] = [];
  const unmatchedBaselineWorkloads: string[] = [];
  const unmatchedCandidateWorkloads: string[] = [];

  if (baseline.suite === 'cpu') {
    const baseMap = new Map(
      (baseline.cpuResults || []).map((w) => [
        makeWorkloadKey(w.dataset.id, w.rendererConfig.id),
        w,
      ])
    );
    const candMap = new Map(
      (candidate.cpuResults || []).map((w) => [
        makeWorkloadKey(w.dataset.id, w.rendererConfig.id),
        w,
      ])
    );

    for (const [key, baseW] of baseMap.entries()) {
      const candW = candMap.get(key);
      if (!candW) {
        unmatchedBaselineWorkloads.push(key);
        continue;
      }
      workloadComparisons.push(compareCpuWorkloads(baseW, candW, thresholds));
    }
    for (const key of candMap.keys()) {
      if (!baseMap.has(key)) {
        unmatchedCandidateWorkloads.push(key);
      }
    }
  } else {
    const baseMap = new Map(
      (baseline.browserResults || []).map((w) => [
        makeWorkloadKey(w.dataset.id, w.rendererConfig.id),
        w,
      ])
    );
    const candMap = new Map(
      (candidate.browserResults || []).map((w) => [
        makeWorkloadKey(w.dataset.id, w.rendererConfig.id),
        w,
      ])
    );

    for (const [key, baseW] of baseMap.entries()) {
      const candW = candMap.get(key);
      if (!candW) {
        unmatchedBaselineWorkloads.push(key);
        continue;
      }
      workloadComparisons.push(compareBrowserWorkloads(baseW, candW, thresholds));
    }
    for (const key of candMap.keys()) {
      if (!baseMap.has(key)) {
        unmatchedCandidateWorkloads.push(key);
      }
    }
  }

  const incompatibleWorkloads = workloadComparisons.filter((w) => !w.compatible);
  for (const iw of incompatibleWorkloads) {
    incompatibilityErrors.push(...iw.incompatibilityReasons);
  }

  if (workloadComparisons.length === 0) {
    incompatibilityErrors.push(
      'No matching (datasetId, rendererConfigId) workloads found between baseline and candidate reports.'
    );
  }

  const totalRegressionsFlagged = workloadComparisons.reduce(
    (sum, w) => sum + w.regressionsFlagged.length,
    0
  );

  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    comparedAtIso: new Date().toISOString(),
    suite: baseline.suite,
    compatible: incompatibilityErrors.length === 0,
    incompatibilityErrors,
    environmentWarnings,
    baselineCommitSha: baseline.environment.gitCommitSha,
    candidateCommitSha: candidate.environment.gitCommitSha,
    thresholds,
    workloadComparisons,
    unmatchedBaselineWorkloads,
    unmatchedCandidateWorkloads,
    totalRegressionsFlagged,
  };
}

/**
 * Formats a human-readable terminal summary of a BenchmarkComparisonReport.
 */
export function formatComparisonReportSummary(comp: BenchmarkComparisonReport): string {
  const lines: string[] = [];
  lines.push(
    `=== Benchmark Comparison (${comp.suite.toUpperCase()}) | Baseline: ${comp.baselineCommitSha} -> Candidate: ${comp.candidateCommitSha} ===`
  );
  lines.push(
    `Status: ${comp.compatible ? 'COMPATIBLE' : 'INCOMPATIBLE'} | Flagged Regressions: ${comp.totalRegressionsFlagged}`
  );

  if (comp.incompatibilityErrors.length > 0) {
    lines.push('\nIncompatibility Errors:');
    for (const err of comp.incompatibilityErrors) {
      lines.push(`  [!] ${err}`);
    }
  }

  if (comp.environmentWarnings.length > 0) {
    lines.push('\nEnvironment Warnings:');
    for (const warn of comp.environmentWarnings) {
      lines.push(`  [~] ${warn}`);
    }
  }

  if (comp.unmatchedBaselineWorkloads.length > 0) {
    lines.push(`\nUnmatched Baseline Workloads: ${comp.unmatchedBaselineWorkloads.join(', ')}`);
  }
  if (comp.unmatchedCandidateWorkloads.length > 0) {
    lines.push(`\nUnmatched Candidate Workloads: ${comp.unmatchedCandidateWorkloads.join(', ')}`);
  }

  for (const w of comp.workloadComparisons) {
    lines.push(`\n--- Workload: ${w.datasetId} (${w.rendererConfigId}) ---`);
    if (!w.compatible) {
      lines.push(`  INCOMPATIBLE: ${w.incompatibilityReasons.join('; ')}`);
      continue;
    }
    lines.push('| Metric | Baseline | Candidate | Abs Delta | % Change | Status |');
    lines.push('|---|---:|---:|---:|---:|---|');
    for (const m of w.metrics) {
      const bStr = m.baselineValue !== null ? `${m.baselineValue} ${m.unit}` : 'n/a';
      const cStr = m.candidateValue !== null ? `${m.candidateValue} ${m.unit}` : 'n/a';
      const dStr =
        m.absoluteDelta !== null
          ? `${m.absoluteDelta > 0 ? '+' : ''}${m.absoluteDelta} ${m.unit}`
          : '—';
      const pStr =
        m.percentChange !== null
          ? `${m.percentChange > 0 ? '+' : ''}${m.percentChange.toFixed(2)}%`
          : '—';
      lines.push(`| ${m.label} | ${bStr} | ${cStr} | ${dStr} | ${pStr} | \`${m.status}\` |`);
    }
  }

  return lines.join('\n');
}

function parseCliArgs(argv: string[]) {
  const positional: string[] = [];
  let outPath: string | null = null;
  let failOnRegression = false;
  const thresholdOverrides: Partial<RegressionThresholdConfig> = {};

  const readVal = (idx: number, flagName: string): { val: string; nextIdx: number } => {
    const arg = argv[idx];
    const eqIdx = arg.indexOf('=');
    if (eqIdx !== -1) {
      const val = arg.slice(eqIdx + 1).trim();
      if (!val) throw new Error(`Flag ${flagName} requires a value.`);
      return { val, nextIdx: idx };
    }
    const next = argv[idx + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Flag ${flagName} requires a value.`);
    }
    return { val: next.trim(), nextIdx: idx + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' || arg.startsWith('--out=')) {
      const { val, nextIdx } = readVal(i, '--out');
      outPath = val;
      i = nextIdx;
    } else if (arg === '--fail-on-regression') {
      failOnRegression = true;
    } else if (arg === '--max-cpu-regression-pct' || arg.startsWith('--max-cpu-regression-pct=')) {
      const { val, nextIdx } = readVal(i, '--max-cpu-regression-pct');
      thresholdOverrides.maxCpuTimeRegressionPct = Number(val);
      i = nextIdx;
    } else if (
      arg === '--max-frame-time-regression-pct' ||
      arg.startsWith('--max-frame-time-regression-pct=')
    ) {
      const { val, nextIdx } = readVal(i, '--max-frame-time-regression-pct');
      thresholdOverrides.maxFrameTimeRegressionPct = Number(val);
      i = nextIdx;
    } else if (
      arg === '--max-draw-call-regression-pct' ||
      arg.startsWith('--max-draw-call-regression-pct=')
    ) {
      const { val, nextIdx } = readVal(i, '--max-draw-call-regression-pct');
      thresholdOverrides.maxDrawCallsRegressionPct = Number(val);
      i = nextIdx;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    } else {
      throw new Error(`Unknown CLI argument for bench:compare: "${arg}".`);
    }
  }

  return {
    baselinePath: positional[0],
    candidatePath: positional[1],
    outPath,
    failOnRegression,
    thresholdOverrides,
  };
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const {
    baselinePath,
    candidatePath,
    outPath,
    failOnRegression,
    thresholdOverrides,
  } = parseCliArgs(process.argv.slice(2));

  if (!baselinePath || !candidatePath) {
    console.error(
      'Usage: npm run bench:compare -- <baseline-report.json> <candidate-report.json> [--out comparison.json] [--fail-on-regression]'
    );
    process.exit(1);
  }

  try {
    const baseReport = loadBenchmarkReport(baselinePath);
    const candReport = loadBenchmarkReport(candidatePath);
    const comparison = compareBenchmarkReports(baseReport, candReport, thresholdOverrides);
    console.log(formatComparisonReportSummary(comparison));

    if (outPath) {
      const fsMod = await import('node:fs');
      const resolvedOut = path.resolve(outPath);
      fsMod.mkdirSync(path.dirname(resolvedOut), { recursive: true });
      fsMod.writeFileSync(resolvedOut, JSON.stringify(comparison, null, 2) + '\n', 'utf8');
      console.log(`\nSaved comparison JSON report to ${resolvedOut}`);
    }

    if (!comparison.compatible) {
      process.exit(2);
    }
    if (failOnRegression && comparison.totalRegressionsFlagged > 0) {
      process.exit(3);
    }
  } catch (err: any) {
    console.error(`Comparison failed: ${err.message}`);
    process.exit(1);
  }
}
