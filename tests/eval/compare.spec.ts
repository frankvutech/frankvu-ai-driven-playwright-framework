import { test, expect } from '@playwright/test';
import { compareReports } from '../../eval/compare';
import { ReportSchema, ratioMetric, renderSummary, valueMetric, type EvaluationReport, type Metric } from '../../eval/report';
import { ratio } from '../../eval/metrics';

const metric = (id: string, value: number | null, gate: Metric['gate'], higherIsBetter: boolean | null = true): Metric =>
  valueMetric(id, value, { unit: 'count', kind: 'deterministic', gate, higherIsBetter, source: 'test', definition: 'a test metric definition' });

function report(metrics: Metric[], over: Partial<EvaluationReport['metadata']> = {}): EvaluationReport {
  return {
    schemaVersion: 1,
    metadata: {
      runId: 'r', timestamp: '2026-10-18T00:00:00Z', mode: 'deterministic', datasetVersion: '2.0.0', datasetSha256: 'a'.repeat(64),
      agent: { commit: 'c'.repeat(40), dirty: false }, promptVersion: '2.0.0', promptSha256: 'b'.repeat(64),
      provider: { name: 'mock', model: 'm', note: 'n' }, judge: null, metricVersion: '3.0.0', config: {},
      target: { name: 't', version: 'v' }, labelReview: { total: 1, humanReviewed: 0, byMethod: {} }, executionRefs: [], repeat: 1, ...over,
    },
    summary: { casesEvaluated: 1, passed: 1, failed: 0, inconclusive: 0, datasetSize: {} },
    metrics,
    sections: {},
    findings: [],
    gates: [],
    limitations: ['small'],
  };
}

test.describe('run comparison', () => {
  test('exact gates fail on any change; no-regression gates only on the worse direction', () => {
    const before = report([metric('x.exact', 5, 'exact'), metric('x.noreg', 0.8, 'no-regression'), metric('x.lowerbetter', 3, 'no-regression', false), metric('x.free', 1, 'none')]);
    const after = report([metric('x.exact', 6, 'exact'), metric('x.noreg', 0.9, 'no-regression'), metric('x.lowerbetter', 4, 'no-regression', false), metric('x.free', 0, 'none')]);
    const c = compareReports(before, after);
    expect(Object.fromEntries(c.changes.map((ch) => [ch.id, ch.direction]))).toEqual({ 'x.exact': 'improved', 'x.noreg': 'improved', 'x.lowerbetter': 'regressed', 'x.free': 'regressed' });
    expect(c.gatedRegressions.map((g) => g.id)).toEqual(['x.exact', 'x.lowerbetter']);
  });

  test('a gated metric that disappears or becomes null is a regression', () => {
    const c = compareReports(report([metric('x.a', 1, 'no-regression'), metric('x.b', 1, 'exact')]), report([metric('x.a', null, 'no-regression')]));
    expect(c.gatedRegressions.map((g) => [g.id, g.direction])).toEqual([['x.a', 'not-comparable'], ['x.b', 'removed']]);
  });

  test('the baseline decides the gate, so a new run cannot loosen it', () => {
    const c = compareReports(report([metric('x.a', 1, 'exact')]), report([metric('x.a', 2, 'none')]));
    expect(c.gatedRegressions.map((g) => g.id)).toEqual(['x.a']);
  });

  test('context changes are reported', () => {
    const c = compareReports(report([], { datasetVersion: '1.0.0' }), report([], { datasetVersion: '2.0.0', metricVersion: '4.0.0' }));
    expect(c.notes).toEqual(['dataset changed 1.0.0 -> 2.0.0: differences may come from the dataset', 'metric implementation changed 3.0.0 -> 4.0.0']);
    const edited = compareReports(report([]), report([], { datasetSha256: 'f'.repeat(64) }));
    expect(edited.notes).toEqual(['same dataset version but different content hash: the dataset was edited without a version bump']);
  });
});

test.describe('report contract', () => {
  test('a well-formed report validates and serialises losslessly', () => {
    const r = report([ratioMetric('a.b', ratio(1, 2), { kind: 'measured', source: 'test', definition: 'a test metric definition' })]);
    expect(ReportSchema.parse(JSON.parse(JSON.stringify(r)))).toEqual(r);
    expect(r.metrics[0]).toMatchObject({ status: 'ok', interval: { low: expect.any(Number), high: expect.any(Number) } });
  });

  test('reports must state limitations and use known metric kinds', () => {
    expect(ReportSchema.safeParse({ ...report([]), limitations: [] }).success).toBe(false);
    expect(ReportSchema.safeParse(report([{ ...metric('a.b', 1, 'none'), kind: 'vibes' as never }])).success).toBe(false);
  });

  test('missing data is marked, not hidden', () => {
    expect(ratioMetric('a.b', ratio(0, 0), { kind: 'measured', source: 's', definition: 'a test metric definition' })).toMatchObject({ value: null, status: 'unavailable' });
    expect(ratioMetric('a.b', ratio(3, 4), { kind: 'measured', source: 's', definition: 'a test metric definition', minDenominator: 10 }).status).toBe('insufficient-data');
    const summary = renderSummary({ ...report([metric('a.b', null, 'none')]), findings: [{ type: 'failed-case', id: 'X-1', detail: 'broke', source: 'deterministic' }] });
    expect(summary).toContain('| a.b | unavailable |');
    expect(summary).toContain('[failed-case] **X-1** broke');
    expect(summary).toContain('## Limitations');
  });
});
