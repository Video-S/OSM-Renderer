import fs from 'node:fs';
import path from 'node:path';
import {
  BENCHMARK_SCHEMA_VERSION,
  BenchmarkReport,
  SampleStatistics,
} from './types';

function isValidSampleStats(obj: any): obj is SampleStatistics {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    typeof obj.sampleCount === 'number' &&
    typeof obj.min === 'number' &&
    typeof obj.max === 'number' &&
    typeof obj.mean === 'number' &&
    typeof obj.median === 'number' &&
    typeof obj.p95 === 'number' &&
    typeof obj.p99 === 'number' &&
    typeof obj.stdDev === 'number' &&
    Array.isArray(obj.samples)
  );
}

/**
 * Validates any parsed JSON value against the versioned BenchmarkReport schema.
 */
export function validateBenchmarkReport(raw: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Report root must be a non-null object.'] };
  }

  const r = raw as Record<string, any>;

  if (r.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    errors.push(
      `Invalid or unsupported schemaVersion "${String(r.schemaVersion)}"; expected "${BENCHMARK_SCHEMA_VERSION}".`
    );
  }

  if (r.suite !== 'cpu' && r.suite !== 'browser') {
    errors.push(`Invalid suite "${String(r.suite)}"; expected "cpu" or "browser".`);
  }

  if (typeof r.benchmarkName !== 'string' || r.benchmarkName.trim().length === 0) {
    errors.push('Missing or empty benchmarkName.');
  }

  if (!r.environment || typeof r.environment !== 'object') {
    errors.push('Missing environment metadata object.');
  } else {
    const env = r.environment;
    if (typeof env.gitCommitSha !== 'string' || env.gitCommitSha.length === 0) {
      errors.push('environment.gitCommitSha must be a non-empty string.');
    }
    if (typeof env.timestampIso !== 'string' || Number.isNaN(Date.parse(env.timestampIso))) {
      errors.push('environment.timestampIso must be a valid ISO-8601 timestamp.');
    }
    if (typeof env.nodeVersion !== 'string') {
      errors.push('environment.nodeVersion must be a string.');
    }
    if (typeof env.platform !== 'string') {
      errors.push('environment.platform must be a string.');
    }
    if (r.suite === 'browser') {
      if (!env.browser || typeof env.browser !== 'object') {
        errors.push('Browser benchmark report must include environment.browser metadata.');
      } else {
        if (typeof env.browser.gpuRenderer !== 'string') {
          errors.push('environment.browser.gpuRenderer must be a string.');
        }
        if (typeof env.browser.isSoftwareRenderer !== 'boolean') {
          errors.push('environment.browser.isSoftwareRenderer must be a boolean.');
        }
        if (
          typeof env.browser.viewportWidth !== 'number' ||
          typeof env.browser.viewportHeight !== 'number'
        ) {
          errors.push('environment.browser viewport dimensions must be numbers.');
        }
      }
    }
  }

  if (!r.methodology || typeof r.methodology !== 'object') {
    errors.push('Missing methodology metadata.');
  }

  if (!Array.isArray(r.unsupportedMetrics)) {
    errors.push('unsupportedMetrics must be an array.');
  }

  if (!Array.isArray(r.errors)) {
    errors.push('errors must be an array.');
  }

  if (r.suite === 'cpu') {
    if (!Array.isArray(r.cpuResults) || r.cpuResults.length === 0) {
      errors.push('CPU benchmark report must contain a non-empty cpuResults array.');
    } else {
      r.cpuResults.forEach((item: any, idx: number) => {
        if (!item?.dataset?.id || !item?.dataset?.contentHashSha256) {
          errors.push(`cpuResults[${idx}] is missing dataset.id or dataset.contentHashSha256.`);
        }
        if (!item?.rendererConfig?.id) {
          errors.push(`cpuResults[${idx}] is missing rendererConfig.id.`);
        }
        if (!isValidSampleStats(item?.timingsMs?.fullSceneGeometryGenerationMs)) {
          errors.push(
            `cpuResults[${idx}].timingsMs.fullSceneGeometryGenerationMs is missing or invalid.`
          );
        }
        if (!isValidSampleStats(item?.timingsMs?.sceneResourceDisposalMs)) {
          errors.push(
            `cpuResults[${idx}].timingsMs.sceneResourceDisposalMs is missing or invalid.`
          );
        }
        if (typeof item?.memoryAndGeometry?.cpuBufferMemory?.totalBytes !== 'number') {
          errors.push(
            `cpuResults[${idx}].memoryAndGeometry.cpuBufferMemory.totalBytes must be a number.`
          );
        }
        if (typeof item?.memoryAndGeometry?.lifecycleAudit?.disposalVerified !== 'boolean') {
          errors.push(
            `cpuResults[${idx}].memoryAndGeometry.lifecycleAudit.disposalVerified must be a boolean.`
          );
        }
      });
    }
  }

  if (r.suite === 'browser') {
    if (!Array.isArray(r.browserResults) || r.browserResults.length === 0) {
      errors.push('Browser benchmark report must contain a non-empty browserResults array.');
    } else {
      r.browserResults.forEach((item: any, idx: number) => {
        if (!item?.dataset?.id || !item?.dataset?.contentHashSha256) {
          errors.push(
            `browserResults[${idx}] is missing dataset.id or dataset.contentHashSha256.`
          );
        }
        if (!item?.rendererConfig?.id) {
          errors.push(`browserResults[${idx}] is missing rendererConfig.id.`);
        }
        if (!Array.isArray(item?.scenarios) || item.scenarios.length === 0) {
          errors.push(`browserResults[${idx}] must contain a non-empty scenarios array.`);
        } else {
          item.scenarios.forEach((sc: any, sIdx: number) => {
            if (!isValidSampleStats(sc?.frameIntervalMs)) {
              errors.push(
                `browserResults[${idx}].scenarios[${sIdx}].frameIntervalMs is invalid.`
              );
            }
            if (!isValidSampleStats(sc?.webglDrawCallsPerFrame)) {
              errors.push(
                `browserResults[${idx}].scenarios[${sIdx}].webglDrawCallsPerFrame is invalid.`
              );
            }
            if (!isValidSampleStats(sc?.renderedTrianglesPerFrame)) {
              errors.push(
                `browserResults[${idx}].scenarios[${sIdx}].renderedTrianglesPerFrame is invalid.`
              );
            }
          });
        }
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates and serializes a BenchmarkReport to formatted JSON.
 */
export function serializeBenchmarkReport(report: BenchmarkReport): string {
  const check = validateBenchmarkReport(report);
  if (!check.valid) {
    throw new Error(`Cannot serialize invalid BenchmarkReport:\n- ${check.errors.join('\n- ')}`);
  }
  return JSON.stringify(report, null, 2) + '\n';
}

/**
 * Writes a validated BenchmarkReport to disk, creating parent directories if needed.
 */
export function saveBenchmarkReport(report: BenchmarkReport, filePath: string): string {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, serializeBenchmarkReport(report), 'utf8');
  return resolved;
}

/**
 * Loads and validates a BenchmarkReport from disk.
 */
export function loadBenchmarkReport(filePath: string): BenchmarkReport {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Benchmark report file not found: ${resolved}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const check = validateBenchmarkReport(raw);
  if (!check.valid) {
    throw new Error(
      `Invalid benchmark report at ${resolved}:\n- ${check.errors.join('\n- ')}`
    );
  }
  return raw as BenchmarkReport;
}

/**
 * Formats a concise, readable terminal / Markdown summary of a BenchmarkReport.
 */
export function formatBenchmarkReportSummary(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`=== ${report.benchmarkName} (Schema v${report.schemaVersion}) ===`);
  lines.push(
    `Commit: ${report.environment.gitCommitSha}${report.environment.gitDirty ? ' (dirty)' : ''} | Timestamp: ${report.environment.timestampIso}`
  );
  lines.push(
    `Host: ${report.environment.platform} (${report.environment.arch}) | CPU: ${report.environment.cpuModel} (${report.environment.cpuLogicalCores} cores) | Node: ${report.environment.nodeVersion} | GC Exposed: ${report.environment.gcExposed}`
  );

  if (report.environment.browser) {
    const b = report.environment.browser;
    lines.push(
      `Browser: ${b.browserName} ${b.browserVersion} | Viewport: ${b.viewportWidth}x${b.viewportHeight} @ ${b.devicePixelRatio}x DPR`
    );
    lines.push(
      `WebGL GPU: ${b.gpuRenderer} [${b.isSoftwareRenderer ? 'SOFTWARE RASTERIZER (SwiftShader/Mesa)' : 'HARDWARE ACCELERATED'}]`
    );
  }
  lines.push('');

  if (report.suite === 'cpu' && report.cpuResults) {
    lines.push(
      '| Dataset | Config | Parse Med/p95 (ms) | Graph Med/p95 (ms) | Adapter Med (ms) | Planar Med (ms) | Road Gen Med (ms) | Rail Gen Med (ms) | Full Scene Med/p95 (ms) | Dispose Med (ms) | Tris | Meshes | CPU Buf (MB) | Leaks |'
    );
    lines.push(
      '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
    );
    for (const r of report.cpuResults) {
      const t = r.timingsMs;
      const fmtMedP95 = (s: SampleStatistics | null) =>
        s ? `${s.median.toFixed(2)} / ${s.p95.toFixed(2)}` : 'n/a';
      const fmtMed = (s: SampleStatistics | null) => (s ? s.median.toFixed(2) : 'n/a');
      const g = r.memoryAndGeometry;
      const leaks =
        g.lifecycleAudit.netLeakedGeometries + g.lifecycleAudit.netLeakedMaterials;
      lines.push(
        `| ${r.dataset.id} | \`${r.rendererConfig.id}\` | ${fmtMedP95(t.geojsonParseAndClassifyMs)} | ${fmtMedP95(t.infrastructureGraphBuildMs)} | ${fmtMed(t.graphToRendererAdapterMs)} | ${fmtMed(t.planarSurfaceResolutionMs)} | ${fmtMed(t.roadGeometryGenerationMs)} | ${fmtMed(t.railwayGeometryGenerationMs)} | ${fmtMedP95(t.fullSceneGeometryGenerationMs)} | ${fmtMed(t.sceneResourceDisposalMs)} | ${g.sceneGeometry.renderedTrianglesWithInstances.toLocaleString()} | ${g.sceneGeometry.constructedMeshesCount} | ${g.cpuBufferMemory.totalMB.toFixed(3)} | ${leaks} |`
      );
    }
  }

  if (report.suite === 'browser' && report.browserResults) {
    lines.push(
      '| Dataset | Config | Scenario | Frame Int Med/p95/p99 (ms) | CPU Render Med/p95 (ms) | GPU Timer (ms) | Draw Calls Med | Rendered Tris Med | Driver Geos/Tex | JS Heap (MB) |'
    );
    lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const w of report.browserResults) {
      for (const sc of w.scenarios) {
        const fi = sc.frameIntervalMs;
        const cr = sc.cpuFrameRenderTimeMs;
        const gpuStr =
          sc.gpuFrameRenderTimeMs.status === 'supported' && sc.gpuFrameRenderTimeMs.statistics
            ? `${sc.gpuFrameRenderTimeMs.statistics.median.toFixed(2)} (p95 ${sc.gpuFrameRenderTimeMs.statistics.p95.toFixed(2)})`
            : `[${sc.gpuFrameRenderTimeMs.status}]`;
        const dc = sc.webglDrawCallsPerFrame.median.toFixed(0);
        const tris = Math.round(sc.renderedTrianglesPerFrame.median).toLocaleString();
        const drv = `${sc.webglResources.driverGeometries}/${sc.webglResources.driverTextures}`;
        const heap =
          sc.browserMemoryMB.supported && sc.browserMemoryMB.usedJSHeapSizeMB !== null
            ? sc.browserMemoryMB.usedJSHeapSizeMB.toFixed(1)
            : 'unsupported';
        lines.push(
          `| ${w.dataset.id} | \`${w.rendererConfig.id}\` | \`${sc.scenarioId}\` | ${fi.median.toFixed(2)} / ${fi.p95.toFixed(2)} / ${fi.p99.toFixed(2)} | ${cr.median.toFixed(2)} / ${cr.p95.toFixed(2)} | ${gpuStr} | ${dc} | ${tris} | ${drv} | ${heap} |`
        );
      }
    }
  }

  if (report.unsupportedMetrics.length > 0) {
    lines.push('');
    lines.push('Unsupported / Unavailable Metrics:');
    for (const u of report.unsupportedMetrics) {
      lines.push(`- ${u.metricId} (${u.reason}): ${u.explanation}`);
    }
  }

  if (report.errors.length > 0) {
    lines.push('');
    lines.push('Recorded Execution Errors:');
    for (const err of report.errors) {
      lines.push(`- [${err.phase}] ${err.message}`);
    }
  }

  return lines.join('\n');
}
