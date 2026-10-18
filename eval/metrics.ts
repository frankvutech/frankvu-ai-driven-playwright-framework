/**
 * Metric calculators. Pure functions over validated inputs; every function is
 * covered by tests/eval/metrics.spec.ts with hand-calculated expectations.
 */
export const METRIC_IMPLEMENTATION_VERSION = '3.0.0';

/** A ratio that keeps its numerator and denominator so reports never hide sample size. */
export interface Ratio {
  n: number;
  d: number;
  value: number | null;
}

export function ratio(n: number, d: number): Ratio {
  return { n, d, value: d === 0 ? null : n / d };
}

export function countWhere<T>(items: T[], pred: (t: T) => boolean): number {
  return items.reduce((acc, t) => acc + (pred(t) ? 1 : 0), 0);
}

export function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: number[]): number | null {
  return percentile(values, 50);
}

/** Nearest-rank percentile (p in 0..100). Null for an empty sample. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export interface Distribution {
  n: number;
  mean: number | null;
  median: number | null;
  p90: number | null;
  max: number | null;
  /** Percentiles from fewer than 20 samples are not a distribution; reports say so. */
  sufficientForPercentiles: boolean;
}

export function distribution(values: number[]): Distribution {
  return {
    n: values.length,
    mean: mean(values),
    median: median(values),
    p90: percentile(values, 90),
    max: values.length ? Math.max(...values) : null,
    sufficientForPercentiles: values.length >= 20,
  };
}

/**
 * Wilson score interval (95%) for a proportion. Used to show how uncertain a
 * rate is; it is not a significance test.
 */
export function wilson(n: number, d: number, z = 1.96): { low: number; high: number } | null {
  if (d === 0) return null;
  const p = n / d;
  const denom = 1 + (z * z) / d;
  const centre = (p + (z * z) / (2 * d)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / d + (z * z) / (4 * d * d))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function formatRatio(r: Ratio): string {
  return r.value === null ? 'n/a (0 cases)' : `${(r.value * 100).toFixed(1)}% (${r.n}/${r.d})`;
}

/* --------------------------- binary confusion --------------------------- */

export interface BinaryOutcome {
  /** Reference: the positive condition holds. */
  actual: boolean;
  /** Prediction: the system said positive. null = no usable prediction (inconclusive). */
  predicted: boolean | null;
}

export interface BinaryConfusion {
  positiveClass: string;
  predictedPositive: string;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  inconclusive: number;
  /** TP / (TP + FN). */
  recall: Ratio;
  /** TP / (TP + FP). */
  precision: Ratio;
  /** FP / (FP + TN). */
  falsePositiveRate: Ratio;
  /** FN / (FN + TP). */
  falseNegativeRate: Ratio;
  /** Rates from fewer than 10 cases in the denominator are reported as inconclusive. */
  rateStatus: 'ok' | 'insufficient-data';
  intervals: { recall: ReturnType<typeof wilson>; falsePositiveRate: ReturnType<typeof wilson> };
}

export const MIN_RATE_DENOMINATOR = 10;

export function binaryConfusion(outcomes: BinaryOutcome[], positiveClass: string, predictedPositive: string): BinaryConfusion {
  let tp = 0, fp = 0, tn = 0, fn = 0, inconclusive = 0;
  for (const o of outcomes) {
    if (o.predicted === null) inconclusive += 1;
    else if (o.actual && o.predicted) tp += 1;
    else if (!o.actual && o.predicted) fp += 1;
    else if (!o.actual && !o.predicted) tn += 1;
    else fn += 1;
  }
  return {
    positiveClass,
    predictedPositive,
    tp, fp, tn, fn, inconclusive,
    recall: ratio(tp, tp + fn),
    precision: ratio(tp, tp + fp),
    falsePositiveRate: ratio(fp, fp + tn),
    falseNegativeRate: ratio(fn, fn + tp),
    rateStatus: tp + fn >= MIN_RATE_DENOMINATOR && fp + tn >= MIN_RATE_DENOMINATOR ? 'ok' : 'insufficient-data',
    intervals: { recall: wilson(tp, tp + fn), falsePositiveRate: wilson(fp, fp + tn) },
  };
}

/* ------------------------- multi-class confusion ------------------------- */

export function confusion(pairs: Array<{ expected: string; predicted: string }>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const { expected, predicted } of pairs) {
    out[expected] ??= {};
    out[expected][predicted] = (out[expected][predicted] ?? 0) + 1;
  }
  return out;
}

export interface ClassMetrics {
  label: string;
  support: number;
  precision: Ratio;
  recall: Ratio;
  f1: number | null;
}

/** Per-class precision/recall/F1 plus macro averages over classes with support. */
export function perClass(pairs: Array<{ expected: string; predicted: string }>, labels: readonly string[]) {
  const classes: ClassMetrics[] = labels.map((label) => {
    const tp = countWhere(pairs, (p) => p.expected === label && p.predicted === label);
    const predicted = countWhere(pairs, (p) => p.predicted === label);
    const support = countWhere(pairs, (p) => p.expected === label);
    const precision = ratio(tp, predicted);
    const recall = ratio(tp, support);
    const f1 = precision.value !== null && recall.value !== null && precision.value + recall.value > 0
      ? (2 * precision.value * recall.value) / (precision.value + recall.value)
      : precision.value === null || recall.value === null ? null : 0;
    return { label, support, precision, recall, f1 };
  });
  const supported = classes.filter((c) => c.support > 0);
  return {
    classes,
    accuracy: ratio(countWhere(pairs, (p) => p.expected === p.predicted), pairs.length),
    macroRecall: mean(supported.map((c) => c.recall.value ?? 0)),
    macroF1: mean(supported.map((c) => c.f1 ?? 0)),
  };
}
