import { test, expect } from '@playwright/test';
import { confusion, countWhere, formatRatio, mean, ratio } from '../../eval/metrics';
import { hasContentAssertion, parsedTestTitle } from '../../eval/evaluate';
import { generation101 } from './helpers';

test.describe('evaluation metric calculation', () => {
  test('ratios keep sample size and handle empty denominators', () => {
    expect(ratio(3, 4)).toEqual({ n: 3, d: 4, value: 0.75 });
    expect(ratio(0, 0)).toEqual({ n: 0, d: 0, value: null });
    expect(formatRatio(ratio(5, 6))).toBe('83.3% (5/6)');
    expect(formatRatio(ratio(0, 0))).toBe('n/a (0 cases)');
  });

  test('mean and counting', () => {
    expect(mean([])).toBeNull();
    expect(mean([1, 0.5])).toBe(0.75);
    expect(countWhere([1, 2, 3, 4], (n) => n % 2 === 0)).toBe(2);
  });

  test('confusion matrix', () => {
    expect(confusion([
      { expected: 'locator', predicted: 'locator' },
      { expected: 'timeout_sync', predicted: 'locator' },
      { expected: 'timeout_sync', predicted: 'locator' },
    ])).toEqual({ locator: { locator: 1 }, timeout_sync: { locator: 2 } });
  });

  test('content-assertion detection', () => {
    const spec = generation101().tests[0];
    expect(hasContentAssertion(spec)).toBe(true);
    expect(hasContentAssertion({ ...spec, steps: [{ kind: 'expect', target: 'inventoryPage.title', select: 'all', matcher: 'toBeVisible', expected: null, negate: false }] })).toBe(false);
  });

  test('parsed test title reads the first test() argument', () => {
    expect(parsedTestTitle('test("a \\"b\\"", async () => {});')).toBe('a "b"');
    expect(parsedTestTitle('const x = 1;')).toBeUndefined();
  });
});
