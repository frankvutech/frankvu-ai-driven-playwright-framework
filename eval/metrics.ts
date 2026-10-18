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

export function formatRatio(r: Ratio): string {
  return r.value === null ? 'n/a (0 cases)' : `${(r.value * 100).toFixed(1)}% (${r.n}/${r.d})`;
}

/** Confusion pairs (expected -> predicted) for categorical agreement. */
export function confusion(pairs: Array<{ expected: string; predicted: string }>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const { expected, predicted } of pairs) {
    out[expected] ??= {};
    out[expected][predicted] = (out[expected][predicted] ?? 0) + 1;
  }
  return out;
}
