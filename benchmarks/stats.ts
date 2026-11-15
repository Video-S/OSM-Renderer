import {
  MetricComparisonDelta,
  RegressionThresholdConfig,
  SampleStatistics,
} from './types';

export const DEFAULT_REGRESSION_THRESHOLDS: Readonly<RegressionThresholdConfig> = Object.freeze({
  maxCpuTimeRegressionPct: 20.0,
  maxFrameTimeRegressionPct: 20.0,
  maxDrawCallsRegressionPct: 5.0,
  maxCpuBufferMemoryRegressionPct: 5.0,
  minTimingRegressionAbsoluteDeltaMs: 1.0,
});

/**
 * Computes linear-interpolated or exact rank-order percentile on a pre-sorted ascending array.
 */
export function computeQuantileFromSorted(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const clamped = Math.max(0, Math.min(1, quantile));
  const pos = (sorted.length - 1) * clamped;
  const lowerIdx = Math.floor(pos);
  const upperIdx = Math.ceil(pos);
  if (lowerIdx === upperIdx) {
    return sorted[lowerIdx];
  }
  const weight = pos - lowerIdx;
  return sorted[lowerIdx] * (1 - weight) + sorted[upperIdx] * weight;
}

/**
 * Computes descriptive statistics (min, max, mean, median/p50, p95, p99, stdDev, IQR, CV)
 * from a numeric sample array. Filters non-finite values defensively.
 */
export function computeSampleStatistics(
  rawSamples: readonly number[],
  precisionDigits: number = 3
): SampleStatistics {
  const valid = rawSamples.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (valid.length === 0) {
    return {
      sampleCount: 0,
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p95: 0,
      p99: 0,
      stdDev: 0,
      iqr: 0,
      coefficientOfVariation: 0,
      samples: [],
    };
  }

  const sorted = [...valid].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / n;

  let varianceSum = 0;
  for (let i = 0; i < n; i++) {
    const diff = sorted[i] - mean;
    varianceSum += diff * diff;
  }
  // Sample standard deviation (Bessel-corrected when n > 1)
  const variance = n > 1 ? varianceSum / (n - 1) : 0;
  const stdDev = Math.sqrt(variance);

  const median = computeQuantileFromSorted(sorted, 0.5);
  const p25 = computeQuantileFromSorted(sorted, 0.25);
  const p75 = computeQuantileFromSorted(sorted, 0.75);
  const p95 = computeQuantileFromSorted(sorted, 0.95);
  const p99 = computeQuantileFromSorted(sorted, 0.99);
  const iqr = p75 - p25;
  const cv = Math.abs(mean) > 1e-9 ? stdDev / Math.abs(mean) : 0;

  const round = (val: number) => Number(val.toFixed(precisionDigits));

  return {
    sampleCount: n,
    min: round(sorted[0]),
    max: round(sorted[n - 1]),
    mean: round(mean),
    median: round(median),
    p95: round(p95),
    p99: round(p99),
    stdDev: round(stdDev),
    iqr: round(iqr),
    coefficientOfVariation: round(cv),
    samples: valid.map(round),
  };
}

/**
 * Computes absolute and percentage delta between baseline and candidate metric values
 * and evaluates regression status against configurable thresholds.
 */
export function evaluateMetricComparison(params: {
  metricPath: string;
  label: string;
  unit: MetricComparisonDelta['unit'];
  baselineValue: number | null | undefined;
  candidateValue: number | null | undefined;
  higherIsWorse?: boolean;
  thresholdPct?: number;
  minAbsoluteDeltaForRegression?: number;
}): MetricComparisonDelta {
  const {
    metricPath,
    label,
    unit,
    baselineValue,
    candidateValue,
    higherIsWorse = true,
    thresholdPct,
    minAbsoluteDeltaForRegression = 0,
  } = params;

  const baseNull = baselineValue === null || baselineValue === undefined || !Number.isFinite(baselineValue);
  const candNull = candidateValue === null || candidateValue === undefined || !Number.isFinite(candidateValue);

  if (baseNull && candNull) {
    return {
      metricPath,
      label,
      unit,
      baselineValue: null,
      candidateValue: null,
      absoluteDelta: null,
      percentChange: null,
      status: 'unsupported',
      thresholdPct,
    };
  }

  if (baseNull) {
    return {
      metricPath,
      label,
      unit,
      baselineValue: null,
      candidateValue: Number(candidateValue!.toFixed(3)),
      absoluteDelta: null,
      percentChange: null,
      status: 'missing_in_baseline',
      thresholdPct,
    };
  }

  if (candNull) {
    return {
      metricPath,
      label,
      unit,
      baselineValue: Number(baselineValue!.toFixed(3)),
      candidateValue: null,
      absoluteDelta: null,
      percentChange: null,
      status: 'missing_in_candidate',
      thresholdPct,
    };
  }

  const b = baselineValue!;
  const c = candidateValue!;
  const absDelta = Number((c - b).toFixed(3));
  const pctChange =
    Math.abs(b) > 1e-9
      ? Number((((c - b) / Math.abs(b)) * 100).toFixed(2))
      : Math.abs(c) <= 1e-9
        ? 0
        : null;

  if (Math.abs(absDelta) <= 1e-6) {
    return {
      metricPath,
      label,
      unit,
      baselineValue: Number(b.toFixed(3)),
      candidateValue: Number(c.toFixed(3)),
      absoluteDelta: 0,
      percentChange: 0,
      status: 'unchanged',
      thresholdPct,
    };
  }

  if (thresholdPct === undefined) {
    return {
      metricPath,
      label,
      unit,
      baselineValue: Number(b.toFixed(3)),
      candidateValue: Number(c.toFixed(3)),
      absoluteDelta: absDelta,
      percentChange: pctChange,
      status: 'changed_neutral',
    };
  }

  const isWorseDirection = higherIsWorse ? absDelta > 0 : absDelta < 0;
  const exceedsAbsFloor = Math.abs(absDelta) >= minAbsoluteDeltaForRegression;
  const exceedsPct =
    pctChange !== null ? Math.abs(pctChange) > thresholdPct : exceedsAbsFloor;

  if (isWorseDirection && exceedsAbsFloor && exceedsPct) {
    return {
      metricPath,
      label,
      unit,
      baselineValue: Number(b.toFixed(3)),
      candidateValue: Number(c.toFixed(3)),
      absoluteDelta: absDelta,
      percentChange: pctChange,
      status: 'regressed',
      thresholdPct,
    };
  }

  const isBetterDirection = higherIsWorse ? absDelta < 0 : absDelta > 0;
  if (isBetterDirection && exceedsAbsFloor && pctChange !== null && Math.abs(pctChange) > 2.0) {
    return {
      metricPath,
      label,
      unit,
      baselineValue: Number(b.toFixed(3)),
      candidateValue: Number(c.toFixed(3)),
      absoluteDelta: absDelta,
      percentChange: pctChange,
      status: 'improved',
      thresholdPct,
    };
  }

  return {
    metricPath,
    label,
    unit,
    baselineValue: Number(b.toFixed(3)),
    candidateValue: Number(c.toFixed(3)),
    absoluteDelta: absDelta,
    percentChange: pctChange,
    status: 'unchanged',
    thresholdPct,
  };
}
