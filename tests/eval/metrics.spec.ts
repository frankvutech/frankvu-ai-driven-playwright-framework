import { test, expect } from '@playwright/test';
import { binaryConfusion, confusion, distribution, mean, median, percentile, perClass, ratio, wilson } from '../../eval/metrics';

test.describe('basic statistics', () => {
  test('ratio keeps counts and returns null for an empty denominator', () => {
    expect(ratio(3, 4)).toEqual({ n: 3, d: 4, value: 0.75 });
    expect(ratio(0, 0)).toEqual({ n: 0, d: 0, value: null });
  });

  test('nearest-rank percentiles', () => {
    const xs = [40, 15, 50, 35, 20];
    expect(percentile(xs, 30)).toBe(20); // rank ceil(1.5) = 2
    expect(percentile(xs, 50)).toBe(35); // rank 3
    expect(percentile(xs, 90)).toBe(50); // rank ceil(4.5) = 5
    expect(percentile(xs, 100)).toBe(50);
    expect(percentile([], 50)).toBeNull();
    expect(median([1, 2, 3, 4])).toBe(2);
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  test('distributions flag small samples', () => {
    expect(distribution([10, 30, 20])).toEqual({ n: 3, mean: 20, median: 20, p90: 30, max: 30, sufficientForPercentiles: false });
    expect(distribution([])).toEqual({ n: 0, mean: null, median: null, p90: null, max: null, sufficientForPercentiles: false });
    expect(distribution(Array.from({ length: 20 }, (_, i) => i)).sufficientForPercentiles).toBe(true);
  });

  test('Wilson 95% interval matches a hand calculation', () => {
    // 11/15: p=0.7333, centre=0.6858, half-width=0.2053 -> [0.4805, 0.8910]
    const ci = wilson(11, 15)!;
    expect(ci.low).toBeCloseTo(0.4805, 3);
    expect(ci.high).toBeCloseTo(0.891, 3);
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(0, 10)!.low).toBe(0);
  });
});

test.describe('confusion matrices', () => {
  test('binary confusion counts, rates and inconclusive cases', () => {
    const c = binaryConfusion(
      [
        { actual: true, predicted: true },
        { actual: true, predicted: true },
        { actual: true, predicted: false },
        { actual: false, predicted: true },
        { actual: false, predicted: false },
        { actual: false, predicted: false },
        { actual: false, predicted: false },
        { actual: true, predicted: null },
      ],
      'defect exists',
      'test failed',
    );
    expect([c.tp, c.fn, c.fp, c.tn, c.inconclusive]).toEqual([2, 1, 1, 3, 1]);
    expect(c.recall).toEqual({ n: 2, d: 3, value: 2 / 3 });
    expect(c.precision).toEqual({ n: 2, d: 3, value: 2 / 3 });
    expect(c.falsePositiveRate).toEqual({ n: 1, d: 4, value: 0.25 });
    expect(c.falseNegativeRate).toEqual({ n: 1, d: 3, value: 1 / 3 });
    expect(c.rateStatus).toBe('insufficient-data');
    expect(c.positiveClass).toBe('defect exists');
  });

  test('rates are only "ok" with at least 10 positives and 10 negatives', () => {
    const many = [...Array(10).fill({ actual: true, predicted: true }), ...Array(10).fill({ actual: false, predicted: false })];
    expect(binaryConfusion(many, 'p', 'q').rateStatus).toBe('ok');
  });

  test('per-class precision, recall, F1 and macro averages', () => {
    const pairs = [
      { expected: 'a', predicted: 'a' },
      { expected: 'a', predicted: 'b' },
      { expected: 'b', predicted: 'b' },
      { expected: 'b', predicted: 'b' },
      { expected: 'c', predicted: 'b' },
    ];
    const r = perClass(pairs, ['a', 'b', 'c', 'd']);
    const by = Object.fromEntries(r.classes.map((c) => [c.label, c]));
    expect(by.a).toMatchObject({ support: 2, precision: { value: 1 }, recall: { value: 0.5 } });
    expect(by.a.f1).toBeCloseTo(2 / 3, 10);
    expect(by.b).toMatchObject({ support: 2, precision: { n: 2, d: 4, value: 0.5 }, recall: { value: 1 } });
    expect(by.c).toMatchObject({ support: 1, precision: { value: null }, recall: { value: 0 }, f1: null });
    expect(by.d).toMatchObject({ support: 0, recall: { value: null } });
    expect(r.accuracy).toEqual({ n: 3, d: 5, value: 0.6 });
    expect(r.macroRecall).toBeCloseTo((0.5 + 1 + 0) / 3, 10);
    expect(confusion(pairs)).toEqual({ a: { a: 1, b: 1 }, b: { b: 2 }, c: { b: 1 } });
  });
});
