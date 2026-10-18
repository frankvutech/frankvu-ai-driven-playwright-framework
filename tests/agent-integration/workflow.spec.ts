import { test, expect } from '@playwright/test';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MockProvider } from '../../src/agent/llm/mock';
import { planAndGenerate } from '../../src/agent/workflow/generate';
import { recordDecision } from '../../src/agent/workflow/decide';
import { executeRun } from '../../src/agent/workflow/execute';
import { RunStore } from '../../src/agent/workflow/store';
import { RunEvidenceSchema, type RunEvidence } from '../../src/agent/domain/result';
import type { FailureAnalysis } from '../../src/agent/analysis/types';
import { NO_WAIT, REPO_ROOT, generation101, plan101, policy, requirement101, scratchRun } from '../agent/helpers';

/*
 * End-to-end: requirement -> plan -> candidate tests -> validation -> approval
 * -> real Playwright run against the approved demo target -> evidence ->
 * failure analysis -> report. Model output comes from the mock provider.
 *
 * The test plays the human reviewer by calling recordDecision() with a
 * person's name, which is what the interactive `approve` command does after
 * its confirmation prompt.
 */
const REVIEWER = 'Integration Test Reviewer';
const env = { ...process.env, ANTHROPIC_API_KEY: undefined };

async function generate(generation: unknown) {
  const run = scratchRun();
  const provider = new MockProvider({ 'test-plan': [JSON.stringify(plan101())], 'test-generation': [JSON.stringify(generation)] });
  const manifest = await planAndGenerate(requirement101(), { repoRoot: REPO_ROOT, policy, provider, runId: run.runId, retryPolicy: NO_WAIT });
  return { ...run, manifest, store: new RunStore(REPO_ROOT, policy.runsArea, run.runId) };
}

test('approved candidate tests run with Playwright and pass with evidence', async () => {
  const run = await generate(generation101());
  try {
    expect(run.manifest.status).toBe('awaiting_approval');
    recordDecision(run.store, 'approved', REVIEWER, 'reviewed generated files');
    const manifest = await executeRun(run.store, { policy, env });

    expect(manifest.status).toBe('executed');
    expect(manifest.artifacts.map((a) => [a.scenarioId, a.state])).toEqual([
      ['REQ-101-SC-01', 'passed'],
      ['REQ-101-SC-02', 'passed'],
      ['REQ-101-SC-03', 'passed'],
    ]);
    const evidence = RunEvidenceSchema.parse(run.store.read<RunEvidence>('evidence.json'));
    expect(evidence.runner).toMatchObject({ exitCode: 0, timedOut: false, reportFound: true });
    expect(evidence.environment).toMatchObject({ targetName: 'saucedemo-public-demo', baseUrlHost: 'www.saucedemo.com' });
    const generated = evidence.tests.filter((t) => t.project === 'agent-generated');
    expect(generated.map((t) => [t.scenarioId, t.requirementId, t.status])).toEqual(
      expect.arrayContaining([
        ['REQ-101-SC-01', 'REQ-101', 'passed'],
        ['REQ-101-SC-02', 'REQ-101', 'passed'],
        ['REQ-101-SC-03', 'REQ-101', 'passed'],
      ]),
    );
    expect(generated.every((t) => t.durationMs > 0)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain('secret_sauce');
    const report = readFileSync(path.join(run.store.runDir, 'report.md'), 'utf8');
    expect(report).toContain('| REQ-101-SC-02 Locked-out user is refused | authorization | AC-2 | passed | passed (');
    expect(report).toContain(`approved by ${REVIEWER}`);
  } finally {
    run.cleanup();
  }
});

test('a failing candidate is reported as failed with analysis and real trace evidence', async () => {
  const gen = generation101();
  // An expectation the requirement never states: the agent must not pass it.
  gen.tests = [{ ...gen.tests[0], steps: [...gen.tests[0].steps.slice(0, 3), { kind: 'expect', target: 'inventoryPage.title', select: 'all', matcher: 'toHaveText', expected: 'Our Products', negate: false }] }];
  const run = await generate(gen);
  try {
    recordDecision(run.store, 'approved', REVIEWER, 'reviewed');
    const manifest = await executeRun(run.store, { policy, env });
    expect(manifest.artifacts.map((a) => a.state)).toEqual(['failed']);

    const evidence = run.store.read<RunEvidence>('evidence.json')!;
    const failed = evidence.tests.find((t) => t.scenarioId === 'REQ-101-SC-01')!;
    expect(failed.status).toBe('failed');
    expect(failed.traceRef).toBeDefined();
    expect(existsSync(path.join(REPO_ROOT, failed.traceRef!))).toBe(true);
    expect(failed.screenshotRefs.length).toBeGreaterThan(0);
    for (const ref of failed.screenshotRefs) expect(existsSync(path.join(REPO_ROOT, ref))).toBe(true);

    const [analysis] = run.store.read<FailureAnalysis[]>('analysis.json')!;
    expect(analysis).toMatchObject({ scenarioId: 'REQ-101-SC-01', method: 'rules', diagnosis: { category: 'assertion_logic', sufficientEvidence: false } });
    expect(analysis.observations.some((o) => o.text.includes('Expected: "Our Products"'))).toBe(true);
    expect(readFileSync(path.join(run.store.runDir, 'report.md'), 'utf8')).toContain('**Observed (facts from the runner):**');
  } finally {
    run.cleanup();
  }
});

test('a file changed after approval is never executed', async () => {
  const run = await generate(generation101());
  try {
    recordDecision(run.store, 'approved', REVIEWER, 'reviewed');
    appendFileSync(path.join(REPO_ROOT, run.manifest.artifacts[0].file), '\n// edited after approval\n');
    const manifest = await executeRun(run.store, { policy, env });
    expect(manifest.status).toBe('execution_refused');
    expect(run.store.read('evidence.json')).toBeUndefined();
    expect(run.store.read<string[]>('execution.refusal.json')).toEqual([expect.stringContaining('changed after approval')]);
    expect(manifest.artifacts.every((a) => a.state === 'approved')).toBe(true);
  } finally {
    run.cleanup();
  }
});

test('an unapproved target is refused even with a valid approval', async () => {
  const run = await generate(generation101());
  try {
    recordDecision(run.store, 'approved', REVIEWER, 'reviewed');
    const manifest = await executeRun(run.store, { policy, env: { ...env, UI_BASE_URL: 'https://shop.production.example.com' } });
    expect(manifest.status).toBe('execution_refused');
    expect(run.store.read<string[]>('execution.refusal.json')).toEqual([expect.stringContaining('blocked pattern')]);
  } finally {
    run.cleanup();
  }
});
