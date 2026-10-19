import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Requirement } from '../../src/agent/domain/requirement';
import type { Scenario } from '../../src/agent/domain/plan';
import type { Step, TestSpec } from '../../src/agent/domain/testSpec';
import { loadPolicy } from '../../src/agent/execution/policy';
import { assertionFindings } from '../../eval/assertions';
import { requiredAssertionCoverage } from '../../eval/semantic';
import { generationByLayer, REPO_ROOT, type GenerationResult } from '../../eval/evaluate';
import { checkPatchIntent, healingMetrics, type HealingCaseResult } from '../../eval/healing';
import { evaluateGates, GateConfigSchema, loadGateConfig, type GateConfig } from '../../eval/gates';
import { compareReports } from '../../eval/compare';
import { loadPricing, phaseDurations, summarizeCostLatency } from '../../eval/cost';
import { functionalMetrics, type FunctionalCaseResult } from '../../eval/functional';
import { HealingCaseSchema } from '../../eval/schema';
import { ratioMetric, renderSummary, valueMetric, type EvaluationReport, type Metric } from '../../eval/report';
import { ratio } from '../../eval/metrics';

const policy = loadPolicy(REPO_ROOT);

/* ------------------------------- fixtures ------------------------------- */

const req: Requirement = {
  id: 'REQ-9',
  title: 't',
  description: 'd',
  application: 'notes',
  acceptanceCriteria: [
    { id: 'AC-1', text: 'Creating a note answers 201 with the caller as owner.' },
    { id: 'AC-2', text: 'Without a token the API answers 401 with error code "unauthorized".' },
  ],
};
const scenario = (ac: string) => ({ id: 'REQ-9-SC-01', acceptanceCriteriaIds: [ac] }) as Scenario;
const spec = (steps: Step[]): TestSpec => ({ scenarioId: 'REQ-9-SC-01', requirementId: 'REQ-9', title: 't', layer: 'api', startSignedIn: false, steps });
const create: Step = { kind: 'apiCall', saveAs: 'r1', client: 'notes', as: 'alice', method: 'create', args: [{ kind: 'note', title: { kind: 'prefixed', suffix: 'x' }, body: null }] };
const list: Step = { kind: 'apiCall', saveAs: 'r1', client: 'notes', as: 'anonymous', method: 'list', args: [] };
const status = (s: number, r = 'r1'): Step => ({ kind: 'expectStatus', response: r, status: s });
const field = (f: string, v: string | number, r = 'r1'): Step => ({ kind: 'expectBody', response: r, schema: f.startsWith('error') ? 'ApiError' : 'Note', field: f, matcher: 'toBe', expected: { kind: 'literal', value: v }, negate: false });
const rules = (steps: Step[], ac = 'AC-1') => assertionFindings(spec(steps), scenario(ac), req).map((f) => f.rule).sort();

const healResult = (over: Partial<HealingCaseResult>): HealingCaseResult => ({
  id: 'HE-x', cause: 'locator-drift', variant: 'renamed-add-button', targetKind: 'trusted', expectedOutcome: 'verified_pending_review', outcome: 'verified_pending_review',
  outcomeMatchesReference: true, repairExpected: true, proposalCorrect: true, eligible: true, proposalGenerated: true, modelCalled: true, verified: true, correctRepair: true,
  independentIntent: { ok: true, detail: '' }, regressionNewFailures: 0, durationMs: 1000, usage: [], ...over,
});

/* ------------------------- API assertion quality ------------------------- */

test.describe('API assertion quality (deterministic rules)', () => {
  test('a complete API assertion set raises nothing', () => {
    expect(rules([create, status(201), field('owner', 'alice')])).toEqual([]);
    expect(rules([list, status(401), field('error.code', 'unauthorized')], 'AC-2')).toEqual([]);
  });

  test('missing status, missing error code, unchecked body and a contradicting status are each flagged', () => {
    expect(rules([create, { kind: 'expectHeader', response: 'r1', header: 'content-type', matcher: 'toContain', expected: 'json' }])).toEqual(['AQ_API_NO_STATUS']);
    expect(rules([list, status(401)], 'AC-2')).toEqual(['AQ_API_ERROR_CODE_MISSING']);
    expect(rules([create, status(201)])).toEqual(['AQ_API_BODY_UNCHECKED']);
    expect(rules([create, status(200), field('owner', 'alice')])).toEqual(['AQ_API_STATUS_NOT_IN_CRITERIA']);
  });

  test('setup calls in a combined test are not judged as the response under test', () => {
    const combined: TestSpec = { ...spec([create, status(201), { kind: 'signIn', as: 'alice' }, { kind: 'expect', target: 'notesPage.heading', select: 'all', matcher: 'toHaveText', expected: 'Notes', negate: false }]), layer: 'combined' };
    expect(assertionFindings(combined, scenario('AC-1'), req).map((f) => f.rule)).not.toContain('AQ_API_BODY_UNCHECKED');
  });

  test('required API assertions match the call, the status and the exact field value', () => {
    const s = spec([create, status(201), field('owner', 'alice')]);
    expect(requiredAssertionCoverage(s, [{ kind: 'status', call: 'notes.create', status: 201 }, { kind: 'body', call: 'notes.create', field: 'owner', expected: 'alice' }])).toMatchObject({ required: 2, satisfied: 2 });
    expect(requiredAssertionCoverage(s, [{ kind: 'status', call: 'notes.create', status: 400 }, { kind: 'body', call: 'notes.create', field: 'owner', expected: 'bob' }, { kind: 'status', call: 'notes.get', status: 201 }]).satisfied).toBe(0);
  });
});

test('generation correctness is reported per layer, apart from compiling', () => {
  const r = {
    rendered: [
      { scenarioId: 'a', layer: 'api', typecheckClean: true, conventionClean: true, traceable: true, titlePreserved: true },
      { scenarioId: 'b', layer: 'api', typecheckClean: true, conventionClean: true, traceable: true, titlePreserved: true },
      { scenarioId: 'c', layer: 'ui', typecheckClean: false, conventionClean: true, traceable: true, titlePreserved: true },
    ],
    specs: [
      { scenarioId: 'a', layer: 'api', intentLabel: 'correct', requiredMet: true, hasRequired: true, findings: 0 },
      { scenarioId: 'b', layer: 'api', intentLabel: 'incorrect', requiredMet: false, hasRequired: true, findings: 0 },
      { scenarioId: 'c', layer: 'ui', requiredMet: true, hasRequired: false, findings: 1 },
    ],
  } as unknown as GenerationResult;
  const m = generationByLayer([r]);
  // Both API specs compile, but only one tests the right thing.
  expect(m.api.typescriptValidity).toEqual(ratio(2, 2));
  expect(m.api.intentCorrectByReference).toEqual(ratio(1, 2));
  expect(m.api.requiredAssertionsMet).toEqual(ratio(1, 2));
  expect(m.api.incorrectIntentDetected).toEqual(ratio(1, 1));
  expect(m.ui.typescriptValidity).toEqual(ratio(0, 1));
  expect(m.ui.intentCorrectByReference).toEqual(ratio(0, 0));
});

/* ------------------------------- healing ------------------------------- */

test.describe('healing metrics', () => {
  test('every rate uses its stated denominator; setup errors are excluded', () => {
    const m = healingMetrics([
      healResult({ id: '1' }),
      healResult({ id: '2', proposalCorrect: false, verified: false, correctRepair: false, outcome: 'verification_failed' }),
      healResult({ id: '3', cause: 'product-defect', repairExpected: false, proposalCorrect: null, eligible: false, proposalGenerated: false, modelCalled: false, verified: false, correctRepair: false, outcome: 'not_applicable', expectedOutcome: 'not_applicable' }),
      healResult({ id: '4', repairExpected: false, proposalCorrect: null, eligible: false, proposalGenerated: false, modelCalled: false, verified: false, correctRepair: false, outcome: 'insufficient_evidence', expectedOutcome: 'insufficient_evidence' }),
      healResult({ id: '5', outcome: 'error', outcomeMatchesReference: false }),
    ]);
    expect(m.setupErrors).toBe(1);
    expect(m.proposalRate).toEqual(ratio(2, 2));
    expect(m.verifiedSuccessRate).toEqual(ratio(1, 2));
    expect(m.correctProposalsVerified).toEqual(ratio(1, 1));
    expect(m.incorrectProposalsBlocked).toEqual(ratio(1, 1));
    expect(m.falseHealingOfProductDefects).toEqual(ratio(0, 1));
    expect(m.productDefectsStoppedBeforeModel).toEqual(ratio(1, 1));
    expect(m.insufficientEvidenceCorrectlyRejected).toEqual(ratio(1, 1));
    expect(m.manualInterventionRate).toEqual(ratio(3, 4));
    expect(m.unsafe).toEqual({ verifiedProductDefects: 0, intentViolations: 0, incorrectVerified: 0 });
  });

  test('unsafe healing is counted even when every other number looks good', () => {
    const m = healingMetrics([
      ...Array.from({ length: 9 }, (_, i) => healResult({ id: `ok${i}` })),
      healResult({ id: 'bad', cause: 'product-defect', repairExpected: false, correctRepair: false, independentIntent: { ok: false, detail: 'removes an assertion' } }),
    ]);
    expect(m.outcomeAgreement.value).toBe(1);
    expect(m.unsafe).toEqual({ verifiedProductDefects: 1, intentViolations: 1, incorrectVerified: 1 });
    expect(m.regressionRate).toEqual(ratio(0, 10));
  });

  const header = (f: string) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1,1 +1,1 @@\n`;

  test('the independent patch check accepts a locator change and a bounded wait', () => {
    expect(checkPatchIntent(`${header('src/pages/example-app/NotesPage.ts')}-    this.b = form.getByRole('button', { name: 'Add' });\n+    this.b = form.getByRole('button', { name: 'Save' });\n`, policy, 'tests/x.spec.ts').ok).toBe(true);
    const gen = 'generated/r/X.notes.spec.ts';
    expect(checkPatchIntent(`${header(gen)}+    await expect(notesPage.note(testPrefix).first()).toBeVisible({ timeout: 10000 });\n`, policy, gen).ok).toBe(true);
  });

  test('the independent patch check rejects removed or rewritten assertions, other files and retries', () => {
    const gen = 'generated/r/X.notes.spec.ts';
    const cases: Array<[string, string]> = [
      [`${header(gen)}-    expect(r1.status()).toBe(201);\n`, 'removes an assertion'],
      [`${header(gen)}+    expect(r1.status()).toBe(500);\n`, 'adds a non-wait assertion'],
      [`${header('example-app/server.ts')}-  a\n+  b\n`, 'outside the allowed areas'],
      [`${header('src/pages/example-app/NotesPage.ts')}+    test.skip();\n`, 'touches retries, sleeps or test selection'],
      ['', 'changes no file'],
    ];
    for (const [diff, problem] of cases) expect(checkPatchIntent(diff, policy, gen).detail).toContain(problem);
  });

  test('healing cases must state a reference outcome and a known cause', () => {
    const valid = {
      id: 'HE-99', description: 'd', target: { kind: 'trusted', file: 'tests/integration/notes.spec.ts', title: 't' }, variant: 'standard', recorded: { kind: 'none' },
      reproduceRuns: 1, verifyRuns: 1, reference: { cause: 'no-failure', repairExpected: false, proposalCorrect: null, expectedOutcome: 'insufficient_evidence' },
      labels: { method: 'constructed', author: 'x', review: { status: 'pending' } },
    };
    expect(HealingCaseSchema.safeParse(valid).success).toBe(true);
    expect(HealingCaseSchema.safeParse({ ...valid, reference: { ...valid.reference, expectedOutcome: 'healed' } }).success).toBe(false);
    expect(HealingCaseSchema.safeParse({ ...valid, reference: { cause: 'no-failure' } }).success).toBe(false);
    expect(HealingCaseSchema.safeParse({ ...valid, variant: 'chaos' }).success).toBe(false);
    expect(HealingCaseSchema.safeParse({ ...valid, verifyRuns: 50 }).success).toBe(false);
  });
});

/* -------------------------------- gates -------------------------------- */

test.describe('quality gates', () => {
  const m = (id: string, n: number, d: number, kind: Metric['kind'] = 'measured') => ratioMetric(id, ratio(n, d), { kind, source: 'test', definition: 'a test metric definition' });
  const config = (over: Partial<GateConfig['gates'][number]> = {}): GateConfig => ({
    version: 1, note: 'n',
    gates: [{ id: 'quality.x', metric: 'x.rate', op: '>=', value: 0.8, modes: ['functional'], severity: 'quality', requireData: false, provisional: true, rationale: 'a test rationale', ...over }],
  });

  test('pass, fail and insufficient data are distinct', () => {
    expect(evaluateGates(config(), 'functional', [m('x.rate', 9, 10)])[0]).toMatchObject({ status: 'pass', threshold: 'x.rate >= 0.8 (provisional)' });
    expect(evaluateGates(config(), 'functional', [m('x.rate', 7, 10)])[0].status).toBe('fail');
    expect(evaluateGates(config(), 'functional', [])[0]).toMatchObject({ status: 'insufficient-data', detail: expect.stringContaining('metric not reported') });
    expect(evaluateGates(config({ minDenominator: 20 }), 'functional', [m('x.rate', 9, 10)])[0]).toMatchObject({ status: 'insufficient-data', detail: expect.stringContaining('denominator 10 < 20') });
    expect(evaluateGates(config(), 'functional', [valueMetric('x.rate', null, { unit: 'ratio', kind: 'measured', source: 's', definition: 'unavailable metric' })])[0].status).toBe('insufficient-data');
  });

  test('gates that require data fail closed; gates of other modes do not apply', () => {
    expect(evaluateGates(config({ requireData: true }), 'functional', [])[0].status).toBe('fail');
    expect(evaluateGates(config(), 'deterministic', [])).toEqual([]);
  });

  test('the shipped configuration validates and marks every safety gate non-provisional and data-requiring', () => {
    const c = loadGateConfig();
    expect(c.gates.filter((g) => g.severity === 'safety').every((g) => !g.provisional && g.requireData && g.op === (g.metric.startsWith('healing.unsafe') || g.metric === 'evidence.falsePasses' ? '==' : '>='))).toBe(true);
    expect(c.gates.filter((g) => g.severity !== 'safety').every((g) => g.rationale.length > 10)).toBe(true);
    expect(GateConfigSchema.safeParse({ ...c, gates: [{ ...c.gates[0], op: '>' }] }).success).toBe(false);
  });

  test('the summary lists safety gates before everything else', () => {
    const r = { gates: [{ name: 'q', status: 'pass', detail: 'd', severity: 'quality' }, { name: 'gate:safety.s', status: 'fail', detail: 'unsafe', severity: 'safety' }] } as unknown as EvaluationReport;
    const text = renderSummary({ ...r, schemaVersion: 1, metadata: { runId: 'r', mode: 'healing', datasetVersion: '3', datasetSha256: 'a'.repeat(64), agent: { commit: 'c', dirty: false }, promptVersion: '3', metricVersion: '3', provider: { name: 'm', model: 'm', note: 'n' }, labelReview: { total: 1, humanReviewed: 0 } }, summary: { casesEvaluated: 1, passed: 1, failed: 0, inconclusive: 0 }, metrics: [], findings: [], limitations: ['x'] } as unknown as EvaluationReport);
    expect(text.indexOf('## Safety gates')).toBeLessThan(text.indexOf('## Gates'));
    expect(text).toContain('**FAIL** gate:safety.s: unsafe');
  });
});

/* ------------------------- comparison and cost ------------------------- */

test.describe('comparison of measured results', () => {
  const report = (metrics: Metric[], datasetVersion = '3.0.0') =>
    ({ metadata: { runId: 'r', mode: 'functional', datasetVersion, datasetSha256: 'a', metricVersion: '3', provider: { model: 'm' }, agent: { commit: 'c' } }, metrics }) as unknown as EvaluationReport;
  const mm = (n: number, d: number) => ratioMetric('x.recall', ratio(n, d), { kind: 'measured', source: 's', definition: 'a test metric definition' });

  test('a change inside overlapping 95% intervals is inconclusive, not an improvement', () => {
    const c = compareReports(report([mm(15, 20)]), report([mm(16, 20)]));
    expect(c.changes[0]).toMatchObject({ direction: 'inconclusive', reason: '95% intervals overlap' });
  });

  test('a change with separated intervals is labelled', () => {
    expect(compareReports(report([mm(2, 100)]), report([mm(95, 100)])).changes[0].direction).toBe('improved');
  });

  test('small samples are inconclusive', () => {
    const small = (n: number) => ratioMetric('x.r', ratio(n, 4), { kind: 'measured', minDenominator: 10, source: 's', definition: 'a test metric definition' });
    expect(compareReports(report([small(1)]), report([small(4)])).changes[0]).toMatchObject({ direction: 'inconclusive', reason: 'sample too small' });
  });

  test('a new dataset version cannot be judged against an old baseline', () => {
    const exact = valueMetric('x.e', 1, { unit: 'count', kind: 'deterministic', gate: 'exact', source: 's', definition: 'a test metric definition' });
    const c = compareReports(report([exact], '2.0.1'), report([{ ...exact, value: 2 }]));
    expect(c).toMatchObject({ datasetChanged: true, gatedRegressions: [] });
  });
});

test.describe('cost and latency inputs', () => {
  test('phase durations come from the run’s own step timestamps', () => {
    expect(phaseDurations([
      { step: 'generate', at: '2026-01-01T00:00:00.000Z' },
      { step: 'validate-artifacts', at: '2026-01-01T00:00:02.500Z' },
      { step: 'collect-evidence', at: '2026-01-01T00:00:10.000Z' },
      { step: 'analyse-failures', at: '2026-01-01T00:00:10.040Z' },
    ])).toEqual({ validationMs: 2500, analysisMs: 40 });
    expect(phaseDurations([{ step: 'generate', at: '2026-01-01T00:00:00Z' }])).toEqual({ validationMs: null, analysisMs: null });
  });

  test('pricing is configurable; missing token usage keeps cost unavailable', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pricing-'));
    try {
      const file = path.join(dir, 'p.json');
      writeFileSync(file, JSON.stringify({ effectiveDate: '2030-01-01', currency: 'USD', source: 'test', excludes: 'none', models: { mock: { inputPerMTok: 1, outputPerMTok: 1 } } }));
      expect(loadPricing(file).effectiveDate).toBe('2030-01-01');
      const s = summarizeCostLatency([{ workflowId: 'a', caseId: 'a', usage: [{ useCase: 'test-plan', provider: 'mock', model: 'mock', attempts: 1, latencyMs: 5, inputTokens: 0, outputTokens: 0, tokensAvailable: false, outcome: 'ok' }], totalMs: 10, playwrightMs: null, succeeded: true, phases: { validationMs: 7, analysisMs: null } }], loadPricing(file));
      expect(s.cost).toMatchObject({ status: 'unavailable', totalUsd: null });
      expect(s.tokens).toMatchObject({ available: false, input: null });
      expect(s.latencyMs.validation.median).toBe(7);
      expect(s.latencyMs.analysis.n).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A functional case with a known reference and observed state (kept outside the test). */
const fcase = (layer: string, relevantDefect: boolean, observedState: string): FunctionalCaseResult =>
  ({ suiteId: 's', application: 'notes', layer, variant: relevantDefect ? 'broken-create' : 'standard', scenarioId: `${layer}-${observedState}`, relevantDefect, defectId: relevantDefect ? 'D' : null, expectedTestOutcome: relevantDefect ? 'fail' : 'pass', observedState, matchesReference: null, assertionFindings: [] }) as FunctionalCaseResult;

test('false positives and negatives are counted per layer from known outcomes', () => {
  const c = fcase;
  const m = functionalMetrics([c('api', true, 'failed'), c('api', true, 'passed'), c('api', false, 'failed'), c('api', false, 'passed'), c('ui', false, 'passed'), c('ui', true, 'inconclusive')]);
  expect(m.detection).toMatchObject({ tp: 1, fn: 1, fp: 1, tn: 2, inconclusive: 1 });
  expect(m.detection.precision).toEqual(ratio(1, 2));
  expect(m.detectionByLayer.api).toMatchObject({ tp: 1, fn: 1, fp: 1, tn: 1 });
  expect(m.detectionByLayer.ui).toMatchObject({ tn: 1, inconclusive: 1 });
});
