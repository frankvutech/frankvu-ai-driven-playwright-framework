import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { readdirSync, rmdirSync } from 'node:fs';
import { sha256File } from '../../src/agent/execution/files';
import { healDir, healTest, newHealId, type HealDeps } from '../../src/agent/healing/heal';
import type { HealChange, HealTarget } from '../../src/agent/healing/types';
import { MockProvider } from '../../src/agent/llm/mock';
import { recordDecision } from '../../src/agent/workflow/decide';
import { executeRun } from '../../src/agent/workflow/execute';
import { planAndGenerate } from '../../src/agent/workflow/generate';
import { promoteRun } from '../../src/agent/workflow/promote';
import { RunStore } from '../../src/agent/workflow/store';
import { NO_WAIT, REPO_ROOT, example, policy, scratchRun } from '../agent/helpers';

/*
 * Guarded healing end to end, with real Playwright runs against the local
 * example app and its deterministic failure modes. The model is a mock that
 * returns a recorded proposal; everything else (reproduction, classification,
 * gating, validation, patching, verification, regression) is real.
 */
/** Promotion creates tests/<dir>/generated/; remove it again when the test left it empty. */
function removeEmptyPromotionDir(dir: string) {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    /* already gone */
  }
}

test.describe.configure({ mode: 'serial', timeout: 240_000 });

const REVIEWER = 'Integration Test Reviewer';
const env = { ...process.env, ANTHROPIC_API_KEY: undefined, EXAMPLE_APP_URL: undefined };
const PAGE = path.join(REPO_ROOT, 'src/pages/example-app/NotesPage.ts');
const UI_TO_API: HealTarget = { kind: 'trusted', file: 'tests/integration/notes.spec.ts', title: 'a note added in the UI is returned by the API' };

const heals: string[] = [];

test.afterAll(() => {
  for (const id of heals) rmSync(healDir(REPO_ROOT, id), { recursive: true, force: true });
});

async function heal(target: HealTarget, deps: Partial<HealDeps>) {
  const healId = newHealId();
  heals.push(healId);
  return healTest(target, { repoRoot: REPO_ROOT, policy, env, retryPolicy: NO_WAIT, reproduceRuns: 1, verifyRuns: 2, healId, ...deps });
}

/** A recorded model reply that cites the page snapshot from the prompt. */
const proposing = (changes: HealChange[]) =>
  new MockProvider({
    'heal-proposal': [
      (req) => {
        const snapshotId = /"id": "(E\d+)",\s*"source": "attachment\.page-snapshot"/.exec(req.prompt)?.[1];
        return JSON.stringify({
          decision: 'propose',
          failureExplanation: 'The locator waited for an element that is no longer on the page.',
          intendedBehavior: 'Submit the new-note form and check the note through the API.',
          evidenceIds: ['E2', ...(snapshotId ? [snapshotId] : [])],
          changes,
        });
      },
    ],
  });

test('UI drift: a verified page-object locator repair, reviewed as a patch; the working tree is unchanged', async () => {
  const before = sha256File(PAGE);
  const record = await heal(UI_TO_API, {
    exampleAppVariant: 'renamed-add-button',
    provider: proposing([{ kind: 'replaceLocator', pageObject: 'NotesPage', member: 'addNoteButton', locator: { by: 'role', role: 'button', name: 'Save note', exact: true } }]),
  });
  expect(record.outcome, record.history.at(-1)?.reason).toBe('verified_pending_review');
  expect(record.analysis?.diagnosis.category).toBe('locator');
  expect(record.analysis?.observations.find((o) => o.source === 'attachment.page-snapshot')?.text).toContain('button "Save note"');
  expect(record.verification).toMatchObject({ runs: 2, passed: 2 });
  // The two integration tests that use the button failed before the patch and pass after it.
  expect(record.regression?.before?.failedTests.length).toBe(2);
  expect(record.regression?.after?.failedTests).toEqual([]);
  expect(readFileSync(path.join(REPO_ROOT, record.patch!.file), 'utf8')).toContain("+    this.addNoteButton = form.getByRole('button', { name: 'Save note', exact: true });");
  expect(sha256File(PAGE)).toBe(before);
});

test('UI drift: a plausible but wrong element passes static checks and fails verification', async () => {
  const record = await heal(UI_TO_API, {
    exampleAppVariant: 'renamed-add-button',
    // "Sign out" is a real button on the page, so validation accepts it; running the test shows it is the wrong one.
    provider: proposing([{ kind: 'replaceLocator', pageObject: 'NotesPage', member: 'addNoteButton', locator: { by: 'role', role: 'button', name: 'Sign out', exact: true } }]),
  });
  expect(record.validation.every((c) => c.ok)).toBe(true);
  expect(record.outcome, record.history.at(-1)?.reason).toBe('verification_failed');
  expect(record.patch).toBeUndefined();
});

test('product defect: a failing create endpoint is classified and never auto-healed', async () => {
  const provider = new MockProvider({});
  const record = await heal({ kind: 'trusted', file: 'tests/api/notes.spec.ts', title: 'creates a note (201, Location header, schema)' }, { exampleAppVariant: 'broken-create', provider });
  expect(record.analysis?.diagnosis.category).toBe('product_behavior');
  expect(record.outcome).toBe('not_applicable');
  expect(provider.calls).toHaveLength(0);
});

test('a test that passes is reported as nothing to heal', async () => {
  const record = await heal(UI_TO_API, { provider: new MockProvider({}) });
  expect(record.outcome).toBe('insufficient_evidence');
  expect(record.reproduction).toMatchObject({ runs: 1, passed: 1, failed: 0 });
});

test('slow list: a generated combined test gets a verified, bounded wait; its assertions are unchanged', async () => {
  const run = scratchRun('REQ-202');
  const ex = example('REQ-202');
  try {
    await planAndGenerate(ex.requirement, {
      repoRoot: REPO_ROOT,
      policy,
      provider: new MockProvider({ 'test-plan': [JSON.stringify(ex.plan)], 'test-generation': [JSON.stringify(ex.generation)] }),
      runId: run.runId,
      retryPolicy: NO_WAIT,
    });
    const store = new RunStore(REPO_ROOT, policy.runsArea, run.runId);
    recordDecision(store, 'approved', REVIEWER, 'reviewed');
    const executed = await executeRun(store, { policy, env, exampleAppVariant: 'intermittent-slow-list' });
    expect(executed.artifacts.map((a) => [a.scenarioId, a.state])).toEqual([
      ['REQ-202-SC-01', 'failed'],
      ['REQ-202-SC-02', 'passed'],
    ]);

    const record = await heal(
      { kind: 'generated', runId: run.runId, scenarioId: 'REQ-202-SC-01' },
      {
        exampleAppVariant: 'intermittent-slow-list',
        reproduceRuns: 2,
        provider: proposing([{ kind: 'addWait', beforeStep: 4, target: 'notesPage.note', locatorArgs: [{ kind: 'prefixed', suffix: 'From the API' }], timeoutMs: 10_000 }]),
      },
    );
    expect(record.analysis?.diagnosis.category).toBe('timeout_sync');
    expect(record.outcome, record.history.at(-1)?.reason).toBe('verified_pending_review');
    expect(record.intent.find((c) => c.name === 'assertions-preserved')?.ok).toBe(true);
    expect(record.verification).toMatchObject({ runs: 2, passed: 2 });
    expect(readFileSync(path.join(REPO_ROOT, record.patch!.file), 'utf8')).toContain('toBeVisible({ timeout: 10000 })');
  } finally {
    run.cleanup();
  }
});

test('promotion: a passed generated API test is promoted and runs in the trusted suite', async () => {
  const req = 'REQ-9201';
  const run = scratchRun(req);
  const ex = JSON.parse(JSON.stringify(example('REQ-201')).split('REQ-201').join(req)) as ReturnType<typeof example>;
  const promoted: string[] = [];
  try {
    await planAndGenerate(ex.requirement, {
      repoRoot: REPO_ROOT,
      policy,
      provider: new MockProvider({ 'test-plan': [JSON.stringify(ex.plan)], 'test-generation': [JSON.stringify(ex.generation)] }),
      runId: run.runId,
      retryPolicy: NO_WAIT,
    });
    const store = new RunStore(REPO_ROOT, policy.runsArea, run.runId);
    recordDecision(store, 'approved', REVIEWER, 'reviewed');
    const executed = await executeRun(store, { policy, env });
    expect(executed.artifacts.every((a) => a.state === 'passed')).toBe(true);

    const result = await promoteRun(store, REVIEWER);
    promoted.push(...result.promoted.map((p) => p.file));
    expect(promoted).toHaveLength(4);
    // The promoted files run under the ordinary api project, not the agent's.
    const out = execFileSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--project', 'api', '--reporter', 'line', ...promoted], {
      cwd: REPO_ROOT,
      env: { ...env, CI: '' },
      encoding: 'utf8',
    });
    expect(out).toContain('4 passed');
  } finally {
    for (const f of promoted) rmSync(path.join(REPO_ROOT, f), { force: true });
    removeEmptyPromotionDir(path.join(REPO_ROOT, 'tests/api/generated'));
    run.cleanup();
  }
});
