import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  buildWorkerNodeOptions,
  formatScalingMarkdownReport,
  loadHengeloScalingDatasets,
  loadScalingDatasetManifest,
  parseScalingRunnerCliArgs,
  readProcessRssMB,
  runIsolatedScalingWorkload,
  runRegionalScalingBenchmarks,
  saveScalingJsonReport,
} from '../../benchmarks';
import type { RegionalScalingReport } from '../../benchmarks/types';
import { resolveRendererConfigs } from '../../benchmarks/scenarios';

const tempDirsToCleanup: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirsToCleanup.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirsToCleanup.length > 0) {
    const dir = tempDirsToCleanup.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures in temp
    }
  }
});

describe('TKT-019 Regional Scalability Benchmark Infrastructure', () => {
  it('loads Hengelo S1–S5 manifest with ODbL attribution, bboxes, and SHA-256 verified S1 offline data', () => {
    const manifest = loadScalingDatasetManifest();
    assert.equal(manifest.datasets.length, 5);
    assert.deepEqual(
      manifest.datasets.map((d) => d.level),
      ['S1', 'S2', 'S3', 'S4', 'S5']
    );
    assert.ok(manifest.attribution.includes('OpenStreetMap'));
    assert.ok(manifest.sourceSha256.length === 64);

    // Strictly increasing areas and extents
    for (let i = 1; i < manifest.datasets.length; i++) {
      assert.ok(manifest.datasets[i].areaKm2 > manifest.datasets[i - 1].areaKm2);
      assert.ok(
        manifest.datasets[i].geoJsonFeatureCount >
          manifest.datasets[i - 1].geoJsonFeatureCount
      );
    }

    // Load & SHA-256 verify S1 (smallest tier, fast & low-memory for unit tests)
    const { datasets } = loadHengeloScalingDatasets({
      levelsOrIds: ['S1'],
      verifyHashes: true,
    });
    assert.equal(datasets.length, 1);
    const s1 = datasets[0];
    const parsed = s1.parseInput();

    assert.ok(parsed.roads.length > 50, 'S1 should contain real Hengelo roads');
    assert.ok(parsed.railways.length > 10, 'S1 should contain real Hengelo station railways');
    assert.ok(parsed.buildings.length > 30, 'S1 should contain real Hengelo buildings');
    assert.ok(
      parsed.roads.some((r) => Array.isArray(r.nodeIds) && r.nodeIds.length >= 2),
      'S1 must preserve OSM node IDs (_nodeIds) on road features'
    );
    assert.ok(
      parsed.roads.some((r) => typeof r.id === 'string' && r.id.startsWith('way/')),
      'S1 must preserve original OSM way identities'
    );
  });

  it('parses CLI arguments across Bash and Windows PowerShell token splitting', () => {
    const parsed = parseScalingRunnerCliArgs([
      '--datasets',
      'S1,',
      'S2',
      '--configs',
      'surface-first-e2plus-rplus',
      '--max-scale=S4',
      '--warmup=1',
      '--iterations=2',
      '--max-rss-mb=2048',
      '--max-old-space-size-mb=2048',
      '--timeout-ms=45000',
      '--validator-max-edges=300',
      '--out=benchmarks/results/test-scaling.json',
      '--md-out=docs/test-scaling.md',
    ]);

    assert.deepEqual(parsed.datasetIds, ['S1', 'S2']);
    assert.deepEqual(parsed.configIds, ['surface-first-e2plus-rplus']);
    assert.equal(parsed.maxScale, 'S4');
    assert.equal(parsed.warmupIterations, 1);
    assert.equal(parsed.measuredIterations, 2);
    assert.equal(parsed.resourceLimits.maxRssMB, 2048);
    assert.equal(parsed.resourceLimits.maxOldSpaceSizeMB, 2048);
    assert.equal(parsed.resourceLimits.timeoutMs, 45000);
    assert.equal(parsed.resourceLimits.validatorMaxEdges, 300);
    assert.equal(parsed.outputPath, 'benchmarks/results/test-scaling.json');
    assert.equal(parsed.markdownOutputPath, 'docs/test-scaling.md');

    assert.throws(
      () => parseScalingRunnerCliArgs(['--max-scale=TWENTE']),
      /Unsupported --max-scale/
    );
    assert.throws(
      () => parseScalingRunnerCliArgs(['--unknown-flag']),
      /Unknown CLI argument/
    );
  });

  it('reads live RSS for the current process cleanly', async () => {
    const rssMB = await readProcessRssMB(process.pid);
    assert.ok(rssMB !== null && rssMB > 10, `Expected positive RSS in MB, got ${rssMB}`);
  });

  it('executes an isolated child scaling workload cleanly on Hengelo S1 with full completeness metrics and zero leaks', async () => {
    const { datasets, manifest } = loadHengeloScalingDatasets({
      levelsOrIds: ['S1'],
      verifyHashes: true,
    });
    const [sfCfg] = resolveRendererConfigs(['surface-first-e2plus-rplus']);

    const res = await runIsolatedScalingWorkload({
      dataset: datasets[0],
      rendererConfig: sfCfg,
      manifestPath: path.resolve('benchmarks/datasets/hengelo-scaling/manifest.json'),
      warmupIterations: 0,
      measuredIterations: 1,
      resourceLimits: {
        maxRssMB: 2048,
        maxOldSpaceSizeMB: 2048,
        timeoutMs: 60_000,
        validatorMaxEdges: 500,
        rssPollIntervalMs: 100,
      },
    });

    assert.equal(res.status, 'completed', `Unexpected status: ${res.status} (${res.statusReason})`);
    assert.ok(res.timingsMs !== null);
    assert.notEqual(res.timingsMs.infrastructureGraphBuildMs, null);
    assert.notEqual(res.timingsMs.graphToRendererAdapterMs, null);
    assert.ok(res.timingsMs.fullSceneGeometryGenerationMs.median >= 0);
    assert.ok(res.timingsMs.roadGeometryGenerationMs !== null);

    assert.ok(res.memory !== null);
    assert.equal(res.memory.lifecycleAudit.disposalVerified, true);
    assert.equal(res.memory.lifecycleAudit.netLeakedGeometries, 0);
    assert.equal(res.memory.lifecycleAudit.netLeakedMaterials, 0);
    assert.ok(res.memory.processRssMB.workerPeakObservedMB > 0);
    assert.ok(res.memory.cpuBufferMemory.totalBytes > 0);

    assert.ok(res.operations !== null);
    assert.ok(res.operations.planarSurface.totalInputPolygons > 0);
    assert.ok((res.operations.roads.renderedPrimitivesOrRibbonsCount ?? 0) > 0);

    assert.ok(res.completenessAndCorrectness !== null);
    assert.ok(res.completenessAndCorrectness.renderedCoverage.sourceFeaturesRenderedCount > 0);
    assert.ok(res.completenessAndCorrectness.topologyAudit !== null);
    assert.equal(res.completenessAndCorrectness.geometryValidation.graphMeshIntegrity.status, 'executed');

    // Verify Markdown and JSON report serialization on real result
    const tmpDir = createTempDir('tkt019-report-');
    const report: RegionalScalingReport = {
      schemaVersion: '1.0.0',
      suite: 'regional-scaling',
      benchmarkName: 'TKT-019 Test Report',
      generatedAtIso: new Date().toISOString(),
      environment: {
        gitCommitSha: 'unavailable',
        gitDirty: false,
        timestampIso: new Date().toISOString(),
        nodeVersion: process.version,
        v8Version: process.versions.v8,
        platform: process.platform,
        osRelease: os.release(),
        arch: process.arch,
        cpuModel: 'test',
        cpuLogicalCores: 2,
        totalSystemMemoryMB: 16384,
        gcExposed: false,
      },
      datasetSeries: {
        studyArea: manifest.studyArea,
        sourceFileName: manifest.sourceFileName,
        sourceSha256: manifest.sourceSha256,
        osmTimestampIso: manifest.osmTimestampIso,
        attribution: manifest.attribution,
        datasets: [datasets[0].descriptor],
      },
      resourceLimits: {
        maxRssMB: 2048,
        maxOldSpaceSizeMB: 2048,
        timeoutMs: 60_000,
        validatorMaxEdges: 500,
        rssPollIntervalMs: 100,
      },
      methodology: {
        warmupIterations: 0,
        measuredIterations: 1,
        executionModel: 'unit-test',
        metricDefinitions: {},
        memoryMeasurementNotes: [],
      },
      configSummaries: [
        {
          configId: sfCfg.id,
          configLabel: sfCfg.label,
          highestCompletedLevel: 'S1',
          stoppedAtLevel: null,
          stopReason: null,
          completedLevelsCount: 1,
          skippedLevelsCount: 0,
          failedLevelsCount: 0,
        },
      ],
      results: [res],
      errors: [],
    };

    const jsonOut = saveScalingJsonReport(report, path.join(tmpDir, 'out.json'));
    assert.ok(fs.existsSync(jsonOut));
    const md = formatScalingMarkdownReport(report);
    assert.ok(md.includes('250 × 250 m'));
    assert.ok(md.includes('surface-first-e2plus-rplus'));
  });

  it('enforces RSS memory limit, wall-clock timeout, and halts larger-scale progression with skipped_due_to_threshold', async () => {
    const tmpDir = createTempDir('tkt019-guards-');
    const memHogWorker = path.join(tmpDir, 'mem-hog-worker.ts');
    fs.writeFileSync(
      memHogWorker,
      `
      if (process.send) process.send({ type: 'heartbeat', stage: 'allocating', rssMB: 50, heapUsedMB: 30, elapsedMs: 10 });
      const blocks = [];
      for (let i = 0; i < 40; i++) {
        const buf = Buffer.alloc(4 * 1024 * 1024, 0xab);
        blocks.push(buf);
      }
      if (process.send) process.send({ type: 'heartbeat', stage: 'allocated', rssMB: Math.round(process.memoryUsage().rss / (1024*1024)), heapUsedMB: 100, elapsedMs: 50 });
      setTimeout(() => {}, 15000);
      `,
      'utf8'
    );

    const reportMemFail = await runRegionalScalingBenchmarks({
      datasetIds: ['S1', 'S2'],
      configIds: ['surface-first-e2plus-rplus'],
      warmupIterations: 0,
      measuredIterations: 1,
      quiet: true,
      workerScriptPath: memHogWorker,
      resourceLimits: {
        maxRssMB: 110,
        maxOldSpaceSizeMB: 512,
        timeoutMs: 10_000,
        rssPollIntervalMs: 50,
        validatorMaxEdges: 100,
      },
    });

    assert.equal(reportMemFail.results.length, 2);
    assert.equal(reportMemFail.results[0].dataset.level, 'S1');
    assert.equal(reportMemFail.results[0].status, 'failed_memory_limit');
    assert.equal(reportMemFail.results[1].dataset.level, 'S2');
    assert.equal(reportMemFail.results[1].status, 'skipped_due_to_threshold');
    assert.equal(reportMemFail.configSummaries[0].stoppedAtLevel, 'S1');
    assert.equal(reportMemFail.configSummaries[0].skippedLevelsCount, 1);

    const slowWorker = path.join(tmpDir, 'timeout-worker.ts');
    fs.writeFileSync(
      slowWorker,
      `
      if (process.send) process.send({ type: 'heartbeat', stage: 'sleeping_test', rssMB: 40, heapUsedMB: 20, elapsedMs: 5 });
      setTimeout(() => {}, 15000);
      `,
      'utf8'
    );

    const { datasets } = loadHengeloScalingDatasets({ levelsOrIds: ['S1'], verifyHashes: false });
    const [sfCfg] = resolveRendererConfigs(['surface-first-e2plus-rplus']);

    const timeoutRes = await runIsolatedScalingWorkload({
      dataset: datasets[0],
      rendererConfig: sfCfg,
      manifestPath: path.resolve('benchmarks/datasets/hengelo-scaling/manifest.json'),
      warmupIterations: 0,
      measuredIterations: 1,
      workerScriptPath: slowWorker,
      resourceLimits: {
        maxRssMB: 1024,
        maxOldSpaceSizeMB: 512,
        timeoutMs: 1500,
        rssPollIntervalMs: 50,
        validatorMaxEdges: 100,
      },
    });

    assert.equal(timeoutRes.status, 'failed_timeout');
    assert.equal(timeoutRes.lastHeartbeatStage, 'sleeping_test');
  });
});

describe('TKT-020 Phase 1: Benchmark Measurement Reliability & Partial Timeout Recovery', () => {
  it('constructs worker NODE_OPTIONS with --expose-gc and explicit --max-old-space-size without duplication', () => {
    assert.equal(
      buildWorkerNodeOptions(undefined, 2048),
      '--expose-gc --max-old-space-size=2048'
    );
    assert.equal(
      buildWorkerNodeOptions('--no-warnings --max-old-space-size=512 --expose-gc', 3072),
      '--no-warnings --expose-gc --max-old-space-size=3072'
    );
  });

  it('forwards --expose-gc to worker and emits non-overlapping roadSubStagesMs for E2+', async () => {
    const { datasets } = loadHengeloScalingDatasets({
      levelsOrIds: ['S1'],
      verifyHashes: true,
    });
    const [sfCfg] = resolveRendererConfigs(['surface-first-e2plus-rplus']);
    const manifestPath = path.resolve('benchmarks/datasets/hengelo-scaling/manifest.json');
    const limits = {
      maxRssMB: 2048,
      maxOldSpaceSizeMB: 2048,
      timeoutMs: 60_000,
      validatorMaxEdges: 500,
      rssPollIntervalMs: 100,
    };

    const sfRes = await runIsolatedScalingWorkload({
      dataset: datasets[0],
      rendererConfig: sfCfg,
      manifestPath,
      warmupIterations: 0,
      measuredIterations: 1,
      resourceLimits: limits,
    });

    assert.equal(sfRes.status, 'completed', sfRes.statusReason);
    assert.equal(sfRes.memory?.workerV8Heap.gcInvokedBeforeRun, true);
    assert.equal(sfRes.completedMeasuredIterations, 1);
    assert.ok(sfRes.timingsMs !== null);
    assert.ok(
      (sfRes.timingsMs.planarSurfaceResolutionMs?.median ?? 0) +
        (sfRes.timingsMs.roadGeometryGenerationMs?.median ?? 0) +
        (sfRes.timingsMs.railwayGeometryGenerationMs?.median ?? 0) <=
        sfRes.timingsMs.fullSceneGeometryGenerationMs.median + 5.0
    );
    const sub = sfRes.timingsMs?.roadSubStagesMs;
    assert.ok(sub !== null && sub !== undefined);
    assert.ok(sub.primitiveConstructionMs !== null && sub.primitiveConstructionMs !== undefined);
    const nonOverlappingSum =
      sub.primitiveConstructionMs!.median +
      sub.polygonUnionMs.median +
      sub.ownershipClippingMs.median +
      sub.triangulationAndValidationMs.median;
    assert.ok(
      nonOverlappingSum <= sfRes.timingsMs!.roadGeometryGenerationMs!.median + 0.5,
      `Non-overlapping road substages (${nonOverlappingSum.toFixed(2)} ms) exceeded total (${sfRes.timingsMs!.roadGeometryGenerationMs!.median.toFixed(2)} ms)`
    );
  });

  it('preserves completed iteration_partial timings and operations when a later iteration times out', async () => {
    const tmpDir = createTempDir('tkt020-partial-timeout-');
    const partialWorker = path.join(tmpDir, 'partial-timeout-worker.ts');
    fs.writeFileSync(
      partialWorker,
      `
      if (process.send) {
        process.send({ type: 'heartbeat', stage: 'iter_1_scene_build', rssMB: 64, heapUsedMB: 32, elapsedMs: 25 });
        process.send({
          type: 'iteration_partial',
          partial: {
            completedMeasuredIterations: 1,
            timingsMs: {
              geojsonParseAndClassifyMs: { sampleCount: 1, min: 10, max: 10, mean: 10, median: 10, p95: 10, p99: 10, stdDev: 0, iqr: 0, coefficientOfVariation: 0, samples: [10] },
              infrastructureGraphBuildMs: null,
              graphToRendererAdapterMs: null,
              planarSurfaceResolutionMs: { sampleCount: 1, min: 20, max: 20, mean: 20, median: 20, p95: 20, p99: 20, stdDev: 0, iqr: 0, coefficientOfVariation: 0, samples: [20] },
              roadGeometryGenerationMs: { sampleCount: 1, min: 15, max: 15, mean: 15, median: 15, p95: 15, p99: 15, stdDev: 0, iqr: 0, coefficientOfVariation: 0, samples: [15] },
              roadSubStagesMs: null,
              railwayGeometryGenerationMs: { sampleCount: 1, min: 5, max: 5, mean: 5, median: 5, p95: 5, p99: 5, stdDev: 0, iqr: 0, coefficientOfVariation: 0, samples: [5] },
              fullSceneGeometryGenerationMs: { sampleCount: 1, min: 60, max: 60, mean: 60, median: 60, p95: 60, p99: 60, stdDev: 0, iqr: 0, coefficientOfVariation: 0, samples: [60] },
              sceneResourceDisposalMs: { sampleCount: 1, min: 2, max: 2, mean: 2, median: 2, p95: 2, p99: 2, stdDev: 0, iqr: 0, coefficientOfVariation: 0, samples: [2] }
            },
            memory: {
              cpuBufferMemory: { geometryCount: 10, attributeBytes: 1024, indexBytes: 512, totalBytes: 1536, totalMB: 0.001 },
              workerV8Heap: { gcInvokedBeforeRun: true, heapUsedBeforeMB: 30, heapUsedPeakMB: 50, heapUsedAfterDisposeMB: 32, heapDeltaAfterDisposeMB: 2, externalMB: 1, arrayBuffersMB: 1 },
              processRssMB: { workerInitialMB: 50, workerPeakObservedMB: 70, workerAfterDisposeMB: 65, parentPolledPeakMB: null },
              lifecycleAudit: { warmupIterations: 0, measuredIterations: 1, ownedGeometriesAfterDispose: 0, ownedMaterialsAfterDispose: 0, netLeakedGeometries: 0, netLeakedMaterials: 0, disposalVerified: true }
            },
            sceneGeometry: { constructedMeshesCount: 12, totalVertices: 100, totalTriangles: 50, renderedVerticesWithInstances: 100, renderedTrianglesWithInstances: 50, renderedFeaturesCount: 10, forestTreesCount: 0 },
            operations: null,
            unsupportedMetrics: []
          }
        });
        process.send({ type: 'heartbeat', stage: 'iter_2_scene_build', rssMB: 66, heapUsedMB: 34, elapsedMs: 40 });
      }
      setTimeout(() => {}, 15000);
      `,
      'utf8'
    );

    const { datasets } = loadHengeloScalingDatasets({ levelsOrIds: ['S1'], verifyHashes: false });
    const [sfCfg] = resolveRendererConfigs(['surface-first-e2plus-rplus']);

    const timeoutRes = await runIsolatedScalingWorkload({
      dataset: datasets[0],
      rendererConfig: sfCfg,
      manifestPath: path.resolve('benchmarks/datasets/hengelo-scaling/manifest.json'),
      warmupIterations: 0,
      measuredIterations: 3,
      workerScriptPath: partialWorker,
      resourceLimits: {
        maxRssMB: 1024,
        maxOldSpaceSizeMB: 512,
        timeoutMs: 1200,
        rssPollIntervalMs: 50,
        validatorMaxEdges: 100,
      },
    });

    assert.equal(timeoutRes.status, 'failed_timeout');
    assert.equal(timeoutRes.lastHeartbeatStage, 'iter_2_scene_build');
    assert.equal(timeoutRes.completedMeasuredIterations, 1);
    assert.equal(timeoutRes.measuredIterations, 3);
    assert.ok(timeoutRes.statusReason.includes('Preserved 1/3 completed measured iteration(s)'));
    assert.equal(timeoutRes.timingsMs?.fullSceneGeometryGenerationMs.sampleCount, 1);
    assert.equal(timeoutRes.timingsMs?.fullSceneGeometryGenerationMs.median, 60);
    assert.equal(timeoutRes.memory?.workerV8Heap.gcInvokedBeforeRun, true);
    assert.equal(timeoutRes.sceneGeometry?.constructedMeshesCount, 12);
  });
});

