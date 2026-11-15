import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BENCHMARK_SCHEMA_VERSION,
  computeGeoJsonContentHash,
  computeQuantileFromSorted,
  computeSampleStatistics,
  compareBenchmarkReports,
  DEFAULT_REGRESSION_THRESHOLDS,
  evaluateMetricComparison,
  formatBenchmarkReportSummary,
  formatComparisonReportSummary,
  isSoftwareWebGLRenderer,
  loadBenchmarkDatasets,
  loadBenchmarkReport,
  resolveBrowserScenarios,
  resolveRendererConfigs,
  runCpuBenchmarks,
  saveBenchmarkReport,
  serializeBenchmarkReport,
  validateBenchmarkReport,
  type BenchmarkReport,
} from '../../benchmarks/index';

describe('TKT-016: General Performance Benchmarking Infrastructure', () => {
  describe('1. Statistical Calculation & Regression Threshold Evaluation', () => {
    it('computes exact median, p95, p99, IQR, standard deviation, and coefficient of variation', () => {
      const samples = [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30];
      const stats = computeSampleStatistics(samples);

      assert.equal(stats.sampleCount, 11);
      assert.equal(stats.min, 10);
      assert.equal(stats.max, 30);
      assert.equal(stats.mean, 20);
      assert.equal(stats.median, 20);
      assert.equal(stats.p95, 29);
      assert.equal(stats.p99, 29.8);
      assert.equal(stats.iqr, 10);
      assert.equal(stats.stdDev, 6.633);
      assert.equal(stats.coefficientOfVariation, 0.332);
    });

    it('handles empty and single-element sample arrays deterministically', () => {
      const emptyStats = computeSampleStatistics([]);
      assert.equal(emptyStats.sampleCount, 0);
      assert.equal(emptyStats.median, 0);
      assert.equal(emptyStats.p95, 0);
      assert.equal(emptyStats.p99, 0);

      const singleStats = computeSampleStatistics([42.125]);
      assert.equal(singleStats.sampleCount, 1);
      assert.equal(singleStats.median, 42.125);
      assert.equal(singleStats.p95, 42.125);
      assert.equal(singleStats.p99, 42.125);
      assert.equal(singleStats.stdDev, 0);
      assert.equal(singleStats.iqr, 0);

      assert.equal(computeQuantileFromSorted([], 0.5), 0);
      assert.equal(computeQuantileFromSorted([7], 0.95), 7);
    });

    it('classifies metric deltas into regressed, improved, unchanged, and unsupported', () => {
      // Higher is worse (duration ms): +25% and +5ms -> regressed
      const regressed = evaluateMetricComparison({
        metricPath: 'timingsMs.fullSceneGeometryGenerationMs.median',
        label: 'Full Scene Build (Median)',
        unit: 'ms',
        baselineValue: 20,
        candidateValue: 25,
        higherIsWorse: true,
        thresholdPct: 15,
        minAbsoluteDeltaForRegression: 2.0,
      });
      assert.equal(regressed.status, 'regressed');
      assert.equal(regressed.absoluteDelta, 5);
      assert.equal(regressed.percentChange, 25);

      // Higher is worse, but below minimum absolute delta noise floor (+0.3ms < 1.5ms) -> unchanged
      const belowNoiseFloor = evaluateMetricComparison({
        metricPath: 'timingsMs.planarSurfaceResolutionMs.median',
        label: 'Planar Surface Resolution (Median)',
        unit: 'ms',
        baselineValue: 1.0,
        candidateValue: 1.3,
        higherIsWorse: true,
        thresholdPct: 15,
        minAbsoluteDeltaForRegression: 1.5,
      });
      assert.equal(belowNoiseFloor.status, 'unchanged');

      // Significant improvement (-25% and -5ms) -> improved
      const improved = evaluateMetricComparison({
        metricPath: 'timingsMs.fullSceneGeometryGenerationMs.median',
        label: 'Full Scene Build (Median)',
        unit: 'ms',
        baselineValue: 20,
        candidateValue: 15,
        higherIsWorse: true,
        thresholdPct: 15,
        minAbsoluteDeltaForRegression: 2.0,
      });
      assert.equal(improved.status, 'improved');
      assert.equal(improved.percentChange, -25);

      // Unsupported / missing metric -> unsupported
      const unsupported = evaluateMetricComparison({
        metricPath: 'scenarios.static_overview.gpuFrameRenderTimeMs.median',
        label: 'GPU Timer Query (Median)',
        unit: 'ms',
        baselineValue: null,
        candidateValue: null,
        higherIsWorse: true,
        thresholdPct: 15,
        minAbsoluteDeltaForRegression: 0.5,
      });
      assert.equal(unsupported.status, 'unsupported');
      assert.equal(unsupported.absoluteDelta, null);
      assert.equal(unsupported.percentChange, null);
    });
  });

  describe('2. Reproducible Frozen Datasets & Content Hashing', () => {
    it('loads all frozen benchmark datasets locally with deterministic SHA-256 hashes and feature counts', () => {
      const datasets = loadBenchmarkDatasets();
      assert.ok(datasets.length >= 4, 'Expected at least 4 frozen datasets');

      const scales = new Set(datasets.map((d) => d.metadata.scale));
      assert.ok(scales.has('small-real-world'), 'Must include a small real-world extract');
      assert.ok(
        scales.has('medium-real-world') || scales.has('complex-real-world'),
        'Must include a larger, more complex real-world extract'
      );
      assert.ok(scales.has('synthetic-stress'), 'Must include a synthetic stress-test dataset');

      for (const ds of datasets) {
        assert.match(ds.metadata.contentHashSha256, /^[a-f0-9]{64}$/);
        assert.ok(
          ds.metadata.parsedFeatureCounts.total > 0,
          `Dataset ${ds.metadata.id} must have parsed features > 0`
        );
        // Recomputing hash on identical GeoJSON yields identical digest
        assert.equal(
          computeGeoJsonContentHash(ds.rawGeoJson),
          ds.metadata.contentHashSha256
        );
      }
    });

    it('rejects unknown dataset identifiers with a clear error', () => {
      assert.throws(
        () => loadBenchmarkDatasets(['non-existent-dataset-id']),
        /No benchmark datasets matched filter/
      );
    });

    it('resolves renderer configurations and browser scenarios and rejects unknown IDs', () => {
      const configs = resolveRendererConfigs(['production-legacy', 'graph-e2-e3']);
      assert.equal(configs.length, 2);
      assert.throws(
        () => resolveRendererConfigs(['unknown-config-id']),
        /No renderer configurations matched filter/
      );

      const scenarios = resolveBrowserScenarios(['static_overview', 'repeated_scene_reload']);
      assert.equal(scenarios.length, 2);
      assert.throws(
        () => resolveBrowserScenarios(['unknown-scenario' as any]),
        /No browser scenarios matched filter/
      );
    });
  });

  describe('3. CPU Benchmark Execution, Direct Stage Measurement & Resource Disposal', () => {
    it('executes CPU benchmarks directly across legacy and graph stages and verifies zero resource leaks', () => {
      const report = runCpuBenchmarks({
        datasetIds: ['small-real-europatunnel', 'synthetic-stress-urban-switchyard'],
        configIds: ['production-legacy', 'surface-first-e2plus-rplus'],
        warmupIterations: 1,
        measuredIterations: 3,
      });

      const validation = validateBenchmarkReport(report);
      assert.equal(validation.valid, true, `Validation errors: ${validation.errors.join('; ')}`);
      assert.equal(report.schemaVersion, BENCHMARK_SCHEMA_VERSION);
      assert.equal(report.suite, 'cpu');
      assert.ok(report.cpuResults);
      assert.equal(report.cpuResults.length, 4);

      const legacyWorkload = report.cpuResults.find(
        (w) =>
          w.dataset.id === 'small-real-europatunnel' &&
          w.rendererConfig.id === 'production-legacy'
      )!;
      const surfaceWorkload = report.cpuResults.find(
        (w) =>
          w.dataset.id === 'small-real-europatunnel' &&
          w.rendererConfig.id === 'surface-first-e2plus-rplus'
      )!;

      assert.ok(legacyWorkload);
      assert.ok(surfaceWorkload);

      // Verify direct stage measurements and sample counts
      assert.equal(legacyWorkload.timingsMs.geojsonParseAndClassifyMs?.sampleCount, 3);
      assert.ok((legacyWorkload.timingsMs.geojsonParseAndClassifyMs?.median ?? -1) >= 0);
      assert.ok(legacyWorkload.timingsMs.fullSceneGeometryGenerationMs.median > 0);
      assert.ok(legacyWorkload.timingsMs.sceneResourceDisposalMs.median >= 0);

      // In legacy mode, roadGeometryGenerationMs is null (reported in unsupportedMetrics); in surface-first mode it is populated
      assert.equal(legacyWorkload.timingsMs.roadGeometryGenerationMs, null);
      assert.notEqual(surfaceWorkload.timingsMs.roadGeometryGenerationMs, null);
      assert.notEqual(surfaceWorkload.timingsMs.infrastructureGraphBuildMs, null);
      assert.notEqual(surfaceWorkload.timingsMs.graphToRendererAdapterMs, null);
      assert.notEqual(surfaceWorkload.timingsMs.planarSurfaceResolutionMs, null);
      assert.ok(surfaceWorkload.timingsMs.roadGeometryGenerationMs!.median > 0);

      // Verify deterministic CPU buffer memory and zero leaked SceneResourceManager resources across all workloads
      for (const workload of report.cpuResults) {
        assert.ok(
          workload.memoryAndGeometry.cpuBufferMemory.totalBytes > 0,
          `Expected positive CPU buffer bytes for ${workload.dataset.id}`
        );
        assert.ok(workload.memoryAndGeometry.cpuBufferMemory.totalMB > 0);
        assert.equal(workload.memoryAndGeometry.lifecycleAudit.disposalVerified, true);
        assert.equal(
          workload.memoryAndGeometry.lifecycleAudit.ownedGeometriesAfterDispose,
          0
        );
        assert.equal(
          workload.memoryAndGeometry.lifecycleAudit.ownedMaterialsAfterDispose,
          0
        );
        assert.equal(workload.memoryAndGeometry.lifecycleAudit.netLeakedGeometries, 0);
        assert.equal(workload.memoryAndGeometry.lifecycleAudit.netLeakedMaterials, 0);
      }

      // Summary formatting must include dataset and stage details
      const summary = formatBenchmarkReportSummary(report);
      assert.ok(summary.includes('small-real-europatunnel'));
      assert.ok(summary.includes('synthetic-stress-urban-switchyard'));
    });
  });

  describe('4. Report Schema Validation & Serialization Round-Trip', () => {
    it('serializes, saves, loads, and validates benchmark reports accurately', () => {
      const report = runCpuBenchmarks({
        datasetIds: ['small-real-europatunnel'],
        configIds: ['production-legacy'],
        warmupIterations: 1,
        measuredIterations: 2,
      });

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-bench-test-'));
      const filePath = path.join(tmpDir, 'cpu-report.json');
      try {
        saveBenchmarkReport(report, filePath);
        const loaded = loadBenchmarkReport(filePath);
        assert.equal(loaded.schemaVersion, BENCHMARK_SCHEMA_VERSION);
        assert.equal(loaded.cpuResults![0].dataset.id, 'small-real-europatunnel');
        assert.equal(
          loaded.cpuResults![0].dataset.contentHashSha256,
          report.cpuResults![0].dataset.contentHashSha256
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('rejects malformed or incompatible schema reports during validation', () => {
      const invalidReport = {
        schemaVersion: '0.0.1-invalid',
        suite: 'invalid-suite',
        benchmarkName: '',
        environment: null,
      };
      const res = validateBenchmarkReport(invalidReport);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('schemaVersion')));
      assert.ok(res.errors.some((e) => e.includes('Invalid suite')));

      assert.throws(
        () => serializeBenchmarkReport(invalidReport as unknown as BenchmarkReport),
        /Cannot serialize invalid BenchmarkReport/
      );
    });
  });

  describe('5. Baseline Comparison, Compatibility Checks & Regression Detection', () => {
    it('compares compatible reports, detects synthetic regressions, and handles unsupported metrics', () => {
      const baseline = runCpuBenchmarks({
        datasetIds: ['small-real-europatunnel'],
        configIds: ['surface-first-e2plus-rplus'],
        warmupIterations: 1,
        measuredIterations: 2,
      });

      // Clone baseline into candidate and inject a +50% (+25ms) regression in fullSceneGeometryGenerationMs
      const candidate: BenchmarkReport = JSON.parse(JSON.stringify(baseline));
      const baseMedian =
        baseline.cpuResults![0].timingsMs.fullSceneGeometryGenerationMs.median;
      candidate.cpuResults![0].timingsMs.fullSceneGeometryGenerationMs.median = Number(
        (baseMedian * 1.5 + 25).toFixed(3)
      );

      const comparison = compareBenchmarkReports(
        baseline,
        candidate,
        DEFAULT_REGRESSION_THRESHOLDS
      );

      assert.equal(comparison.compatible, true);
      assert.equal(comparison.incompatibilityErrors.length, 0);
      assert.equal(comparison.totalRegressionsFlagged, 1);

      const fullSceneDelta = comparison.workloadComparisons[0].metrics.find(
        (m) => m.metricPath === 'timingsMs.fullSceneGeometryGenerationMs.median'
      )!;
      assert.equal(fullSceneDelta.status, 'regressed');
      assert.ok((fullSceneDelta.percentChange ?? 0) > 40);

      const summaryText = formatComparisonReportSummary(comparison);
      assert.ok(summaryText.includes('Status: COMPATIBLE'));
      assert.ok(summaryText.includes('regressed'));
    });

    it('detects incompatible dataset content hashes and mismatched hardware/software GPU classes', () => {
      const baseline = runCpuBenchmarks({
        datasetIds: ['small-real-europatunnel'],
        configIds: ['production-legacy'],
        warmupIterations: 1,
        measuredIterations: 2,
      });

      const tamperedCandidate: BenchmarkReport = JSON.parse(JSON.stringify(baseline));
      tamperedCandidate.cpuResults![0].dataset.contentHashSha256 =
        '0000000000000000000000000000000000000000000000000000000000000000';

      const hashMismatch = compareBenchmarkReports(baseline, tamperedCandidate);
      assert.equal(hashMismatch.compatible, false);
      assert.ok(
        hashMismatch.incompatibilityErrors.some((r) => r.includes('content hash mismatch'))
      );

      // Verify hardware vs. software WebGL renderer detection
      assert.equal(
        isSoftwareWebGLRenderer(
          'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'
        ),
        true
      );
      assert.equal(isSoftwareWebGLRenderer('ANGLE (Apple, Apple M3 Max, OpenGL 4.1)'), false);
    });
  });
});
