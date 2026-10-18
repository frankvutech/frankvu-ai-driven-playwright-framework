import { test, expect } from '@playwright/test';
import path from 'node:path';
import { classifyFailure, expectedValue } from '../../src/agent/analysis/classify';
import { refineWithModel } from '../../src/agent/analysis/modelAnalysis';
import { collectEvidence } from '../../src/agent/evidence/collect';
import { MockProvider } from '../../src/agent/llm/mock';
import type { TestEvidence } from '../../src/agent/domain/result';
import { NO_WAIT, REPO_ROOT } from './helpers';

const evidence = (report: string) =>
  collectEvidence({
    runId: 'r', repoRoot: REPO_ROOT, reportPath: path.join(REPO_ROOT, 'eval/dataset/failures', report),
    startedAt: new Date(0), finishedAt: new Date(0), target: { name: 't', host: 'h' }, runner: { exitCode: 1, timedOut: false, stderr: '' },
  });
const capture = evidence('playwright-report.capture.json');
const byTitle = (title: string): TestEvidence => capture.tests.find((t) => t.title === title)!;

test.describe('rule-based failure classification on real reports', () => {
  test('separates observations (facts) from the diagnosis (hypothesis)', () => {
    const a = classifyFailure(byTitle('locator-missing'));
    expect(a.observations.map((o) => o.source)).toEqual(expect.arrayContaining(['status', 'error[0].message']));
    expect(a.observations.every((o) => /^E\d+$/.test(o.id))).toBe(true);
    expect(a.diagnosis.evidenceIds.every((id) => a.observations.some((o) => o.id === id))).toBe(true);
    expect(a.method).toBe('rules');
  });

  test('a mismatch whose expected value comes from the criteria points at the product', () => {
    const a = classifyFailure(byTitle('product-defect-sort'), { acceptanceCriteriaText: 'Sorting Z to A lists "Test.allTheThings() T-Shirt (Red)" first.' });
    expect(a.diagnosis).toMatchObject({ category: 'product_behavior', confidence: 'medium', sufficientEvidence: false });
    expect(a.diagnosis.alternatives.map((x) => x.category)).toContain('assertion_logic');
  });

  test('a mismatch with an expectation not found in the criteria points at the test', () => {
    const a = classifyFailure(byTitle('assertion-not-from-requirement'), { acceptanceCriteriaText: 'the product list titled "Products" is shown' });
    expect(a.diagnosis.category).toBe('assertion_logic');
  });

  test('missing elements are locator failures, with product and timing as alternatives', () => {
    const a = classifyFailure(byTitle('locator-missing'));
    expect(a.diagnosis.category).toBe('locator');
    expect(a.diagnosis.alternatives.map((x) => x.category)).toEqual(['product_behavior', 'timeout_sync']);
  });

  test('network errors are environment failures', () => {
    expect(classifyFailure(byTitle('environment-unreachable')).diagnosis).toMatchObject({ category: 'environment', confidence: 'high' });
  });

  test('setup failures are attributed to setup', () => {
    const setup = evidence('playwright-report.setup-failure.json').tests.find((t) => t.project === 'setup')!;
    expect(classifyFailure(setup).diagnosis.category).toBe('test_data_setup');
  });

  test('a timeout never gets high confidence', () => {
    const t: TestEvidence = { ...byTitle('locator-missing'), attempts: [{ retry: 0, status: 'timedOut', durationMs: 30000, attachments: [], errors: [{ message: 'Test timeout of 30000ms exceeded.' }] }] };
    expect(classifyFailure(t).diagnosis).toMatchObject({ category: 'timeout_sync', confidence: 'low', sufficientEvidence: false });
  });

  test('unrecognised failures are inconclusive', () => {
    const t: TestEvidence = { ...byTitle('locator-missing'), attempts: [{ retry: 0, status: 'failed', durationMs: 1, attachments: [], errors: [{ message: 'Something odd' }] }] };
    expect(classifyFailure(t).diagnosis.category).toBe('inconclusive');
  });

  test('extracts expected values from assertion messages', () => {
    expect(expectedValue('Expected: "Our Products"\nReceived: "Products"')).toBe('Our Products');
    expect(expectedValue('Expected pattern: /inventory/')).toBe('/inventory/');
  });
});

test.describe('model-assisted analysis is advisory and grounded', () => {
  const baseline = () => classifyFailure(byTitle('locator-missing'));
  const diag = (over: object) => JSON.stringify({
    category: 'product_behavior', confidence: 'medium', hypothesis: 'The banner was removed from the page.',
    alternatives: [], evidenceIds: ['E2'], sufficientEvidence: false, nextSteps: ['Check the release notes.'], ...over,
  });

  test('a grounded, schema-valid diagnosis is used and the baseline is noted', async () => {
    const { analysis, usage } = await refineWithModel(new MockProvider({ 'failure-analysis': [diag({})] }), baseline(), {}, NO_WAIT);
    expect(analysis).toMatchObject({ method: 'model', diagnosis: { category: 'product_behavior' } });
    expect(analysis.notes[0]).toContain('rule-based baseline: locator');
    expect(usage.outcome).toBe('ok');
  });

  test('citing evidence that does not exist rejects the model output', async () => {
    const { analysis } = await refineWithModel(new MockProvider({ 'failure-analysis': [diag({ evidenceIds: ['E2', 'E99'] })] }), baseline(), {}, NO_WAIT);
    expect(analysis.method).toBe('rules');
    expect(analysis.diagnosis.category).toBe('locator');
    expect(analysis.notes).toContain('model analysis rejected: cited unknown evidence E99');
  });

  test('malformed or failing model output keeps the rule-based result', async () => {
    for (const reply of ['not json', diag({ category: 'cosmic_rays' })]) {
      const { analysis } = await refineWithModel(new MockProvider({ 'failure-analysis': [reply] }), baseline(), {}, NO_WAIT);
      expect(analysis.method).toBe('rules');
      expect(analysis.notes[0]).toContain('model analysis unavailable');
    }
  });

  test('high confidence with insufficient evidence is lowered', async () => {
    const { analysis } = await refineWithModel(new MockProvider({ 'failure-analysis': [diag({ confidence: 'high', sufficientEvidence: false })] }), baseline(), {}, NO_WAIT);
    expect(analysis.diagnosis.confidence).toBe('medium');
    expect(analysis.notes).toContain('confidence lowered: the model reported insufficient evidence');
  });
});
