import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runEvaluation } from '../../eval/run';
import { ReportSchema } from '../../eval/report';
import { MockProvider } from '../../src/agent/llm/mock';
import { judgeAssertions, SelfJudgeError } from '../../eval/semantic';
import { loadDataset } from '../../eval/dataset';

test.describe.configure({ mode: 'serial', timeout: 240_000 });

let out: string;

test.beforeAll(() => {
  out = mkdtempSync(path.join(os.tmpdir(), 'agent-eval-'));
});

test.afterAll(() => rmSync(out, { recursive: true, force: true }));

const d0 = loadDataset();

test('deterministic run: all gates pass, report validates, metadata is complete', async () => {
  const { report, dir, exitCode } = await runEvaluation({ mode: 'deterministic', outDir: out });
  expect(exitCode).toBe(0);
  expect(ReportSchema.safeParse(JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'))).success).toBe(true);
  expect(readFileSync(path.join(dir, 'summary.md'), 'utf8')).toContain('## Limitations');
  expect(report.gates.filter((g) => g.status === 'fail')).toEqual([]);
  expect(report.metadata).toMatchObject({ mode: 'deterministic', datasetVersion: '3.0.1', promptVersion: '3.0.0', metricVersion: '3.0.0', provider: { name: 'mock' } });
  expect(report.metadata.agent.commit).toMatch(/^[0-9a-f]{40}$|^unknown$/);
  // Deterministic, fixed-input metrics are pinned exactly; timing is not gated.
  const byId = Object.fromEntries(report.metrics.map((m) => [m.id, m]));
  expect(byId['planning.structural.expectationsMet']).toMatchObject({ value: 1, gate: 'exact' });
  expect(byId['recovery.meanRecoveryLatencyMs'].gate).toBe('none');
  expect(byId['evidence.falsePasses'].value).toBe(0);
  // Reproducibility metadata: configuration (no secrets), pricing and gate files, dataset sizes.
  expect(report.metadata.config).toMatchObject({ pricing: 'eval/pricing.json', gates: 'eval/gates.json', policyHealing: expect.objectContaining({ reproduceRuns: expect.any(Number) }) });
  expect(report.summary.datasetSize).toMatchObject({ healingCases: d0.healing.cases.length });
  expect(JSON.stringify(report)).not.toMatch(/sk-ant-|ANTHROPIC_API_KEY=/);
  // Configured gates are reported with their thresholds; safety gates are marked.
  expect(report.gates.find((g) => g.name === 'gate:safety.no-false-passes')).toMatchObject({ status: 'pass', severity: 'safety' });
  // Failed reference comparisons surface as findings rather than disappearing into aggregates.
  expect(report.findings.some((f) => f.type === 'incorrect-diagnosis')).toBe(true);
  writeFileSync(path.join(out, 'baseline.json'), JSON.stringify(report));
});

test('the same run against its own baseline passes; a tampered baseline fails the gate', async () => {
  const same = await runEvaluation({ mode: 'deterministic', outDir: out, baseline: path.join(out, 'baseline.json') });
  expect(same.report.gates.find((g) => g.name === 'baseline-regression')).toMatchObject({ status: 'pass' });
  expect(same.exitCode).toBe(0);

  const tampered = JSON.parse(readFileSync(path.join(out, 'baseline.json'), 'utf8'));
  tampered.metrics.find((m: { id: string }) => m.id === 'recovery.recoverySuccess').value = 0.5;
  writeFileSync(path.join(out, 'tampered.json'), JSON.stringify(tampered));
  const worse = await runEvaluation({ mode: 'deterministic', outDir: out, baseline: path.join(out, 'tampered.json') });
  expect(worse.report.gates.find((g) => g.name === 'baseline-regression')).toMatchObject({ status: 'fail', detail: 'recovery.recoverySuccess: 0.5 -> 1' });
  expect(worse.exitCode).toBe(1);
});

test('live mode plumbing with a mock standing in for the model is labelled as such', async () => {
  const d = loadDataset();
  const live = d.planning.cases.filter((c) => c.liveApplicable && c.recordedOutput);
  // Serve each live case its recorded plan, then a generation reply for valid plans.
  const plans = live.map((c) => (typeof c.recordedOutput === 'string' ? c.recordedOutput : JSON.stringify(c.recordedOutput)));
  const gens = live.map(() => JSON.stringify({ tests: [], missingCapabilities: [] }));
  const provider = new MockProvider({ 'test-plan': plans, 'test-generation': gens, 'failure-analysis': Array(20).fill('not json') });
  const { report } = await runEvaluation({ mode: 'live', outDir: out, provider });
  expect(report.metadata.provider.note).toContain('not real model results');
  // Without real model data the live threshold gates have nothing to judge: insufficient data, never a pass.
  const configured = report.gates.filter((g) => g.name.startsWith('gate:'));
  expect(configured.map((g) => g.status)).toEqual(configured.map(() => 'insufficient-data'));
  expect(configured.length).toBeGreaterThan(0);
  expect(report.gates.filter((g) => g.status === 'fail')).toEqual([]);
  expect(report.metrics.find((m) => m.id === 'latency.modelMedianMs')?.status).toBe('not-run');
  expect(report.metrics.filter((m) => m.kind === 'ai-judgment').every((m) => m.gate === 'none')).toBe(true);
  expect(report.metrics.find((m) => m.id === 'cost.medianPerWorkflowUsd')?.status).toBe('unavailable');
});

test('the semantic judge refuses to grade its own output and keeps verdicts advisory', async () => {
  const d = loadDataset();
  const c = d.generation.cases[0];
  const spec = (c.recordedOutput as { tests: never[] }).tests[0];
  const judge = new MockProvider({ 'assertion-judge': [JSON.stringify({ assertions: [{ index: 0, verdict: 'adequate', reason: 'ok' }] }), JSON.stringify({ assertions: [{ index: 9, verdict: 'weak', reason: 'x' }] })] });
  await expect(judgeAssertions(judge, { name: 'mock', model: 'mock' }, { requirement: c.requirement, scenario: c.scenarios[0], spec })).rejects.toThrow(SelfJudgeError);
  const ok = await judgeAssertions(judge, { name: 'anthropic', model: 'claude-opus-5-5' }, { requirement: c.requirement, scenario: c.scenarios[0], spec });
  expect(ok).toMatchObject({ ok: true, verdict: { assertions: [{ index: 0, verdict: 'adequate' }] } });
  const bad = await judgeAssertions(judge, { name: 'anthropic', model: 'claude-opus-5-5' }, { requirement: c.requirement, scenario: c.scenarios[0], spec });
  expect(bad).toMatchObject({ ok: false, reason: 'judge referenced assertions that do not exist' });
});

test('reports are sanitized of local paths and secrets', async () => {
  const { sanitize } = await import('../../eval/run');
  const { REPO_ROOT } = await import('../../eval/evaluate');
  const text = JSON.stringify({ a: `${REPO_ROOT}/generated/x.spec.ts`, b: `${os.homedir()}/elsewhere`, c: 'sk-ant-abcdef123456 and secret_sauce' });
  expect(JSON.parse(sanitize(text))).toEqual({ a: '<repo>/generated/x.spec.ts', b: '<home>/elsewhere', c: '[REDACTED_API_KEY] and [REDACTED]' });
  const baseline = readFileSync(path.join(REPO_ROOT, 'eval/baselines/deterministic.json'), 'utf8');
  expect(baseline).not.toContain(os.homedir());
});

test('functional mode refuses to execute without a named human approver', async () => {
  await expect(runEvaluation({ mode: 'functional', outDir: out, approver: 'ci', env: {} })).rejects.toThrow('AGENT_EVAL_APPROVER');
});
