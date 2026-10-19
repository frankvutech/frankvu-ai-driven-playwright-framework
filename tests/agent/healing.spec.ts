import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { RunEvidence, TestEvidence } from '../../src/agent/domain/result';
import { GenerationOutputSchema, TestSpecSchema } from '../../src/agent/domain/testSpec';
import { sha256File } from '../../src/agent/execution/files';
import { renderSpecWithMap } from '../../src/agent/generation/render';
import { approveHeal, failingStepIndex, healDir, healTest, newHealId, type HealDeps } from '../../src/agent/healing/heal';
import { applyLocatorChange, findMemberLocator, quote, renderLocator, snapshotSupports } from '../../src/agent/healing/locators';
import { HealProposalSchema, type HealChange, type HealTarget } from '../../src/agent/healing/types';
import { summarize, type WorkspaceRun, type WorkspaceRunResult } from '../../src/agent/healing/workspace';
import { MockProvider } from '../../src/agent/llm/mock';
import type { LlmRequest } from '../../src/agent/llm/provider';
import { ProviderError } from '../../src/agent/llm/provider';
import { planAndGenerate } from '../../src/agent/workflow/generate';
import { recordDecision } from '../../src/agent/workflow/decide';
import { executeRun } from '../../src/agent/workflow/execute';
import { RunStore } from '../../src/agent/workflow/store';
import { NO_WAIT, REPO_ROOT, example, policy, scratchRun } from './helpers';

test.describe.configure({ timeout: 180_000 });

const SNAPSHOT = `- main [ref=e2]:
  - paragraph [ref=e4]: Signed in as alice
  - button "Sign out" [ref=e6]
  - heading "Notes" [level=1] [ref=e7]
  - form "New note" [ref=e8]:
    - textbox "Title" [ref=e10]
    - textbox "Body" [ref=e12]
    - button "Save note" [ref=e13]`;

const DRIFT = `TimeoutError: locator.click: Timeout 10000ms exceeded.
Call log:
  - waiting for getByRole('form', { name: 'New note' }).getByRole('button', { name: 'Add note' })
    at NotesPage.addNote (src/pages/example-app/NotesPage.ts:43:30)`;
const SERVER_ERROR = `Error: expect(received).toBe(expected) // Object.is equality

Expected: 201
Received: 500

> 60 |     expect(response.status()).toBe(201);`;
const NOT_FOUND_STATUS = SERVER_ERROR.replace('Expected: 201', 'Expected: 200').replace('Received: 500', 'Received: 404').replace('toBe(201)', 'toBe(200)');
const WRONG_TEXT = `Error: expect(locator).toHaveText(expected) failed

Expected: "Hello"
Received: "Goodbye"`;
const HIDDEN = (location: string) => `Error: expect(locator).toBeVisible() failed

Expected: visible
Received: hidden
Timeout:  5000ms

    at ${location}`;

const TRUSTED: HealTarget = { kind: 'trusted', file: 'tests/integration/notes.spec.ts', title: 'a note added in the UI is returned by the API' };

interface FakeTest {
  status: 'passed' | 'failed' | 'timedOut';
  message?: string;
  location?: string;
  snapshot?: string;
  title?: string;
}

/** A Playwright stand-in: returns scripted evidence per run label and writes error-context files. */
function fakeRunner(script: Record<string, FakeTest[] | ((run: WorkspaceRun) => FakeTest[])>) {
  const runs: WorkspaceRun[] = [];
  const runTests = async (run: WorkspaceRun): Promise<WorkspaceRunResult> => {
    runs.push(run);
    const entry = script[run.label] ?? script.default ?? [];
    const planned = typeof entry === 'function' ? entry(run) : entry;
    const tests: TestEvidence[] = planned.map((t, i) => {
      const attachments = [];
      if (t.snapshot) {
        const rel = path.posix.join('.agent', 'heal-runs', run.label, `t${i}`, 'error-context.md');
        mkdirSync(path.dirname(path.join(run.workspace, rel)), { recursive: true });
        writeFileSync(path.join(run.workspace, rel), `# Error details\n\n# Page snapshot\n\n\`\`\`yaml\n${t.snapshot}\n\`\`\`\n`);
        attachments.push({ name: 'error-context', contentType: 'text/markdown', path: rel });
      }
      return {
        testId: `t${i}`,
        title: t.title ?? run.title ?? 'generated test',
        file: run.files[0]?.split('/').pop() ?? 'x.spec.ts',
        project: run.project,
        status: t.status,
        durationMs: 10,
        retries: 0,
        attempts: [{ retry: 0, status: t.status, durationMs: 10, errors: t.message ? [{ message: t.message, location: t.location }] : [], attachments }],
        screenshotRefs: [],
      };
    });
    const evidence: RunEvidence = {
      schemaVersion: 1,
      runId: run.label,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      environment: { targetName: 'fake', baseUrlHost: 'local', playwrightVersion: 'fake', node: process.version, platform: process.platform, ci: false },
      runner: { exitCode: 0, timedOut: false, reportFound: true, globalErrors: [], stderrTail: '' },
      tests,
    };
    return { summary: summarize(run, evidence, ['fake'], 1), evidence };
  };
  return { runs, runTests };
}

/** A mock model whose reply cites the page-snapshot observation from the prompt. */
function proposing(changes: HealChange[] | ((req: LlmRequest) => unknown), extra: Record<string, unknown> = {}) {
  return new MockProvider({
    'heal-proposal': [
      (req) => {
        if (typeof changes === 'function') return JSON.stringify(changes(req));
        const snapshotId = /"id": "(E\d+)",\s*"source": "attachment\.page-snapshot"/.exec(req.prompt)?.[1];
        return JSON.stringify({
          decision: 'propose',
          failureExplanation: 'The submit button was renamed.',
          intendedBehavior: 'Submit the new-note form.',
          evidenceIds: ['E2', ...(snapshotId ? [snapshotId] : [])],
          changes,
          ...extra,
        });
      },
    ],
  });
}

const RENAME: HealChange = { kind: 'replaceLocator', pageObject: 'NotesPage', member: 'addNoteButton', locator: { by: 'role', role: 'button', name: 'Save note', exact: true } };
const FAIL_WITH_SNAPSHOT: FakeTest = { status: 'timedOut', message: DRIFT, snapshot: SNAPSHOT };

const heals: string[] = [];
async function heal(target: HealTarget, deps: Partial<HealDeps>) {
  const healId = newHealId();
  heals.push(healId);
  return healTest(target, { repoRoot: REPO_ROOT, policy, env: {}, retryPolicy: NO_WAIT, reproduceRuns: 1, verifyRuns: 2, healId, ...deps });
}

test.afterAll(() => {
  for (const id of heals) rmSync(healDir(REPO_ROOT, id), { recursive: true, force: true });
});

test.describe('locator helpers', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'src/pages/example-app/NotesPage.ts'), 'utf8');

  test('render proposed locators as single-quoted literals that cannot break out', () => {
    expect(renderLocator(RENAME.kind === 'replaceLocator' ? RENAME.locator : (undefined as never))).toBe("getByRole('button', { name: 'Save note', exact: true })");
    for (const value of ["it's", 'x\'); require("fs"); (\'', 'a\\b', 'line\nbreak']) {
      expect(new Function(`return ${quote(value)};`)()).toBe(value);
    }
  });

  test('find a page-object member and keep its scope when replacing it', () => {
    expect(findMemberLocator(source, 'NotesPage', 'addNoteButton')).toMatchObject({ receiver: 'form', method: 'getByRole', role: 'button', call: "getByRole('button', { name: 'Add note' })" });
    const applied = applyLocatorChange(source, 'NotesPage', 'addNoteButton', { by: 'role', role: 'button', name: 'Save note', exact: true });
    expect(applied).toMatchObject({ after: "form.getByRole('button', { name: 'Save note', exact: true })" });
    expect('source' in applied && applied.source.split('\n').filter((l, i) => l !== source.split('\n')[i])).toHaveLength(1);
  });

  test('refuse shapes that cannot be repaired automatically', () => {
    expect(findMemberLocator(source, 'NotesPage', 'missing')).toEqual({ error: 'NotesPage.missing is not assigned exactly once in the constructor' });
    expect(findMemberLocator(source, 'Nope', 'x')).toEqual({ error: 'class Nope not found' });
    const filtered = readFileSync(path.join(REPO_ROOT, 'src/pages/InventoryPage.ts'), 'utf8');
    expect(findMemberLocator(filtered, 'InventoryPage', 'itemNames')).toMatchObject({ receiver: 'this.items' });
    expect(applyLocatorChange(source, 'NotesPage', 'addNoteButton', { by: 'role', role: 'button', name: 'Add note', exact: false })).toEqual({ error: 'the proposed locator is identical to the current one' });
  });

  test('a locator is supported only by an element in the page snapshot', () => {
    expect(snapshotSupports({ by: 'role', role: 'button', name: 'Save note', exact: true }, SNAPSHOT).ok).toBe(true);
    expect(snapshotSupports({ by: 'role', role: 'button', name: 'Save', exact: false }, SNAPSHOT).ok).toBe(true);
    expect(snapshotSupports({ by: 'role', role: 'button', name: 'Save', exact: true }, SNAPSHOT).ok).toBe(false);
    expect(snapshotSupports({ by: 'role', role: 'link', name: 'Save note', exact: true }, SNAPSHOT).ok).toBe(false);
    expect(snapshotSupports({ by: 'label', text: 'Title', exact: true }, SNAPSHOT).ok).toBe(true);
    expect(snapshotSupports({ by: 'text', text: 'Signed in as alice', exact: true }, SNAPSHOT).ok).toBe(true);
  });

  test('the proposal schema has no way to remove or rewrite assertions', () => {
    const base = { decision: 'propose', failureExplanation: 'x', intendedBehavior: 'y', evidenceIds: ['E1'] };
    for (const change of [{ kind: 'removeStep', step: 3 }, { kind: 'replaceExpected', step: 3, value: 'Goodbye' }, { kind: 'addRetries', retries: 3 }]) {
      expect(HealProposalSchema.safeParse({ ...base, changes: [change] }).success).toBe(false);
    }
  });
});

test.describe('healing gate: what is never auto-healed', () => {
  const stops: Array<[string, FakeTest[], string, string]> = [
    ['a server error (likely product defect)', [{ status: 'failed', message: SERVER_ERROR }], 'not_applicable', 'product_behavior'],
    ['an API status outside the expected contract', [{ status: 'failed', message: NOT_FOUND_STATUS }], 'not_applicable', 'api_contract'],
    ['a wrong expected value', [{ status: 'failed', message: WRONG_TEXT }], 'not_applicable', 'assertion_logic'],
    ['a timing failure in a hand-written test', [{ status: 'failed', message: HIDDEN('tests/integration/notes.spec.ts:18:47') }], 'not_applicable', 'timeout_sync'],
    ['a locator failure without a page snapshot', [{ status: 'timedOut', message: DRIFT }], 'insufficient_evidence', 'locator'],
    ['an unrecognised failure', [{ status: 'failed', message: 'Error: something odd' }], 'insufficient_evidence', 'inconclusive'],
  ];
  for (const [name, reproduce, outcome, category] of stops) {
    test(`${name} stops before any model call (${outcome})`, async () => {
      const provider = new MockProvider({});
      const record = await heal(TRUSTED, { provider, runTests: fakeRunner({ reproduce }).runTests });
      expect(record.analysis?.diagnosis.category).toBe(category);
      expect(record.outcome, record.history.at(-1)?.reason).toBe(outcome);
      expect(record.gate?.decision).toBe('stop');
      expect(provider.calls).toHaveLength(0);
      expect(record.patch).toBeUndefined();
    });
  }

  test('a test that does not fail is not "healed"', async () => {
    const provider = new MockProvider({});
    const record = await heal(TRUSTED, { provider, runTests: fakeRunner({ reproduce: [{ status: 'passed' }, { status: 'passed' }] }).runTests, reproduceRuns: 2 });
    expect(record.outcome, record.history.at(-1)?.reason).toBe('insufficient_evidence');
    expect(record.history.at(-1)?.reason).toContain('did not fail in 2 run(s)');
    expect(provider.calls).toHaveLength(0);
  });

  test('run counts are bounded by the policy', async () => {
    const { runs, runTests } = fakeRunner({ reproduce: [{ status: 'passed' }] });
    await heal(TRUSTED, { provider: new MockProvider({}), runTests, reproduceRuns: 50 });
    expect(runs[0].repeatEach).toBe(policy.healing.reproduceRuns);
  });

  test('unknown variants and untrusted target paths are refused before anything runs', async () => {
    await expect(heal(TRUSTED, { exampleAppVariant: 'chaos' })).rejects.toThrow('not in the policy');
    await expect(heal({ kind: 'trusted', file: 'example-app/server.ts', title: 'x' }, {})).rejects.toThrow('must be .spec.ts files under tests/');
    await expect(heal({ kind: 'trusted', file: 'tests/integration/../../src/agent/cli.spec.ts', title: 'x' }, {})).rejects.toThrow();
  });
});

test.describe('healing proposals: validation', () => {
  const reproduce = [FAIL_WITH_SNAPSHOT];
  const rejected: Array<[string, HealChange[], string]> = [
    ['an element that is not in the page snapshot', [{ ...RENAME, locator: { by: 'role', role: 'button', name: 'Publish', exact: true } } as HealChange], 'snapshot-evidence:addNoteButton'],
    ['a different role for the same member', [{ ...RENAME, locator: { by: 'role', role: 'heading', name: 'Notes', exact: true } } as HealChange], 'same-role:addNoteButton'],
    ['a member that is not the failing locator', [{ kind: 'replaceLocator', pageObject: 'NotesPage', member: 'errorMessage', locator: { by: 'text', text: 'Signed in as alice', exact: true } }], 'failing-locator:errorMessage'],
    ['a class outside the patchable page objects', [{ kind: 'replaceLocator', pageObject: 'ExampleServer', member: 'addNoteButton', locator: { by: 'role', role: 'button', name: 'Save note', exact: true } }], 'target:ExampleServer.addNoteButton'],
    ['a wait in a locator repair', [{ kind: 'addWait', beforeStep: 0, target: 'notesPage.heading', timeoutMs: 5000 }], 'change-kinds'],
  ];
  for (const [name, changes, failedCheck] of rejected) {
    test(`rejects ${name}`, async () => {
      const { runs, runTests } = fakeRunner({ reproduce });
      const record = await heal(TRUSTED, { provider: proposing(changes), runTests });
      expect(record.outcome, record.history.at(-1)?.reason).toBe('validation_failed');
      expect(record.validation.find((c) => c.name === failedCheck)?.ok).toBe(false);
      expect(runs.map((r) => r.label)).toEqual(['reproduce']);
      expect(record.patch).toBeUndefined();
    });
  }

  test('rejects proposals that cite evidence that does not exist', async () => {
    const provider = proposing(() => ({ decision: 'propose', failureExplanation: 'x', intendedBehavior: 'y', evidenceIds: ['E99'], changes: [RENAME] }));
    const record = await heal(TRUSTED, { provider, runTests: fakeRunner({ reproduce }).runTests });
    expect(record.outcome, record.history.at(-1)?.reason).toBe('validation_failed');
    expect(record.validation.find((c) => c.name === 'evidence-ids')).toMatchObject({ ok: false });
  });

  test('provider errors, malformed output, unknown change kinds and a missing provider fail predictably', async () => {
    const run = () => fakeRunner({ reproduce }).runTests;
    expect((await heal(TRUSTED, { provider: new MockProvider({ 'heal-proposal': [new ProviderError('auth', 'authentication failed (401)')] }), runTests: run() })).outcome).toBe('proposal_failed');
    expect((await heal(TRUSTED, { provider: new MockProvider({ 'heal-proposal': ['not json'] }), runTests: run() })).outcome).toBe('proposal_failed');
    const removal = await heal(TRUSTED, { provider: proposing([{ kind: 'removeStep', step: 2 } as unknown as HealChange]), runTests: run() });
    expect(removal.outcome, removal.history.at(-1)?.reason).toBe('proposal_failed');
    expect(removal.history.at(-1)?.reason).toContain('schema_violation');
    expect((await heal(TRUSTED, { runTests: run() })).history.at(-1)?.reason).toBe('no AI provider configured for healing');
  });

  test('a model that declines leaves the test alone', async () => {
    const record = await heal(TRUSTED, { provider: proposing([], { decision: 'decline' }), runTests: fakeRunner({ reproduce }).runTests });
    expect(record.outcome, record.history.at(-1)?.reason).toBe('insufficient_evidence');
    expect(record.patch).toBeUndefined();
  });
});

test.describe('healing proposals: verification and review', () => {
  const pagePath = path.join(REPO_ROOT, 'src/pages/example-app/NotesPage.ts');

  test('a verified locator repair becomes a reviewable patch; the working tree is untouched', async () => {
    const before = sha256File(pagePath);
    const { runs, runTests } = fakeRunner({
      reproduce: [FAIL_WITH_SNAPSHOT],
      verify: [{ status: 'passed' }, { status: 'passed' }],
      'regression-before': [{ status: 'failed', message: DRIFT, title: 'other' }],
      'regression-after': [{ status: 'passed', title: 'other' }],
    });
    const record = await heal(TRUSTED, { provider: proposing([RENAME]), runTests });
    expect(record.outcome, record.history.at(-1)?.reason).toBe('verified_pending_review');
    expect(runs.map((r) => r.label)).toEqual(['reproduce', 'regression-before', 'verify', 'regression-after']);
    expect(runs.find((r) => r.label === 'regression-after')).toMatchObject({ kind: 'trusted', project: 'integration' });
    expect(record.intent).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'test-file-unchanged', ok: true }), expect.objectContaining({ name: 'assertion-count', ok: true })]));
    const patch = readFileSync(path.join(REPO_ROOT, record.patch!.file), 'utf8');
    expect(patch).toContain("-    this.addNoteButton = form.getByRole('button', { name: 'Add note' });");
    expect(patch).toContain("+    this.addNoteButton = form.getByRole('button', { name: 'Save note', exact: true });");
    expect(record.patch!.changedFiles).toEqual(['src/pages/example-app/NotesPage.ts']);
    expect(sha256File(pagePath)).toBe(before);

    // Approval is a recorded human decision on these exact bytes; it applies nothing.
    expect(() => approveHeal(REPO_ROOT, record.healId, 'test-agent')).toThrow('not an acceptable human approver');
    const approved = approveHeal(REPO_ROOT, record.healId, 'Frank Vu');
    expect(approved).toMatchObject({ outcome: 'approved', approval: { approver: 'Frank Vu', patchSha256: record.patch!.sha256 } });
    expect(sha256File(pagePath)).toBe(before);
    expect(() => approveHeal(REPO_ROOT, record.healId, 'Frank Vu')).toThrow('is approved, not verified_pending_review');
  });

  test('a patch that changed after verification cannot be approved', async () => {
    const record = await heal(TRUSTED, {
      provider: proposing([RENAME]),
      runTests: fakeRunner({ reproduce: [FAIL_WITH_SNAPSHOT], verify: [{ status: 'passed' }, { status: 'passed' }], default: [] }).runTests,
    });
    expect(record.outcome, record.history.at(-1)?.reason).toBe('verified_pending_review');
    appendFileSync(path.join(REPO_ROOT, record.patch!.file), '+ sneaky\n');
    expect(() => approveHeal(REPO_ROOT, record.healId, 'Frank Vu')).toThrow('patch.diff changed after verification');
  });

  test('passing once is not enough: every verification run must pass', async () => {
    const record = await heal(TRUSTED, {
      provider: proposing([RENAME]),
      runTests: fakeRunner({ reproduce: [FAIL_WITH_SNAPSHOT], verify: [{ status: 'passed' }, { status: 'failed', message: DRIFT }], default: [] }).runTests,
    });
    expect(record.outcome, record.history.at(-1)?.reason).toBe('verification_failed');
    expect(record.patch).toBeUndefined();
  });

  test('a patch that breaks another test fails regression', async () => {
    const record = await heal(TRUSTED, {
      provider: proposing([RENAME]),
      runTests: fakeRunner({
        reproduce: [FAIL_WITH_SNAPSHOT],
        verify: [{ status: 'passed' }, { status: 'passed' }],
        'regression-before': [{ status: 'passed', title: 'other' }],
        'regression-after': [{ status: 'failed', message: DRIFT, title: 'other' }],
      }).runTests,
    });
    expect(record.outcome, record.history.at(-1)?.reason).toBe('verification_failed');
    expect(record.regression?.newFailures).toEqual(['integration › x.spec.ts › other']);
  });
});

test.describe('healing a generated test: bounded waits only', () => {
  async function failedGeneratedRun() {
    const run = scratchRun('REQ-202');
    const ex = example('REQ-202');
    const provider = new MockProvider({ 'test-plan': [JSON.stringify(ex.plan)], 'test-generation': [JSON.stringify(ex.generation)] });
    await planAndGenerate(ex.requirement, { repoRoot: REPO_ROOT, policy, provider, runId: run.runId, retryPolicy: NO_WAIT });
    const store = new RunStore(REPO_ROOT, policy.runsArea, run.runId);
    recordDecision(store, 'approved', 'Frank Vu', 'reviewed');
    // A fake Playwright report in which SC-01 failed.
    await executeRun(store, {
      policy,
      env: {},
      spawner: async (_cmd, _args, opts) => {
        const files = JSON.parse(opts.env.AGENT_APPROVED_FILES!) as string[];
        const specs = files.map((f) => {
          const id = path.basename(f).split('.')[0];
          const status = id.endsWith('SC-01') ? 'failed' : 'passed';
          return { id, title: id, file: path.basename(f), tests: [{ projectName: 'agent-generated-notes', status: status === 'failed' ? 'unexpected' : 'expected', annotations: [{ type: 'scenario', description: id }], results: [{ retry: 0, status, duration: 1, errors: status === 'failed' ? [{ message: 'Expected: visible\nReceived: hidden' }] : [], attachments: [] }] }] };
        });
        writeFileSync(opts.env.AGENT_RESULTS_FILE!, JSON.stringify({ config: { version: 'fake' }, suites: [{ title: 'x', specs, suites: [] }], errors: [] }));
        return { exitCode: 1, timedOut: false, stdout: '', stderr: '' };
      },
    });
    expect(store.manifest().artifacts.map((a) => a.state)).toEqual(['failed', 'passed']);
    const spec = TestSpecSchema.parse(GenerationOutputSchema.parse(store.read('generation.json')).tests[0]);
    const file = store.manifest().artifacts[0].file;
    const { stepLines } = renderSpecWithMap(spec, run.runId, { application: 'notes' });
    return { ...run, store, spec, file, failingLocation: `${file}:${stepLines[4]}` };
  }
  const wait = (beforeStep: number, timeoutMs = 10_000): HealChange => ({ kind: 'addWait', beforeStep, target: 'notesPage.note', locatorArgs: [{ kind: 'prefixed', suffix: 'From the API' }], timeoutMs });
  const target = (runId: string): HealTarget => ({ kind: 'generated', runId, scenarioId: 'REQ-202-SC-01' });

  test('an intermittent timing failure gets a verified wait; every original step and assertion is preserved', async () => {
    const g = await failedGeneratedRun();
    try {
      const hidden: FakeTest = { status: 'failed', message: HIDDEN(g.failingLocation) };
      const { runs, runTests } = fakeRunner({ reproduce: [hidden, { status: 'passed' }, hidden], verify: [{ status: 'passed' }, { status: 'passed' }] });
      const record = await heal(target(g.runId), { provider: proposing([wait(4)]), runTests, reproduceRuns: 3, exampleAppVariant: 'intermittent-slow-list' });
      expect(record.reproduction).toMatchObject({ failed: 2, passed: 1, intermittent: true });
      expect(record.gate?.decision).toBe('wait_repair');
      expect(record.outcome, record.history.at(-1)?.reason).toBe('verified_pending_review');
      expect(runs.map((r) => [r.label, r.kind, r.exampleAppVariant])).toEqual([['reproduce', 'generated', 'intermittent-slow-list'], ['verify', 'generated', 'intermittent-slow-list']]);
      expect(record.intent.find((c) => c.name === 'assertions-preserved')).toMatchObject({ ok: true });
      expect(record.intent.find((c) => c.name === 'assertion-count')?.detail).toContain('1 wait(s) added');
      const patched = JSON.parse(readFileSync(path.join(healDir(REPO_ROOT, record.healId), 'patched-spec.json'), 'utf8'));
      expect(patched.steps).toHaveLength(g.spec.steps.length + 1);
      expect(patched.steps[4]).toMatchObject({ matcher: 'toBeVisible', timeoutMs: 10000 });
      expect(readFileSync(path.join(REPO_ROOT, record.patch!.file), 'utf8')).toContain('+    await expect(notesPage.note(testPrefix + " From the API").first()).toBeVisible({ timeout: 10000 });');
      // The candidate file in the run is untouched; the patched test would need a new approval.
      expect(sha256File(path.join(REPO_ROOT, g.file))).toBe(g.store.manifest().artifacts[0].sha256);
    } finally {
      g.cleanup();
    }
  });

  test('a wait after the failing step, or longer than the policy allows, is rejected', async () => {
    const g = await failedGeneratedRun();
    try {
      const hidden: FakeTest = { status: 'failed', message: HIDDEN(g.failingLocation) };
      const late = await heal(target(g.runId), { provider: proposing([wait(5)]), runTests: fakeRunner({ reproduce: [hidden] }).runTests });
      expect(late.outcome, late.history.at(-1)?.reason).toBe('validation_failed');
      expect(late.validation.find((c) => c.name === 'wait-position')).toMatchObject({ ok: false });
      const long = await heal(target(g.runId), { provider: proposing([wait(4, 12_000)]), runTests: fakeRunner({ reproduce: [hidden] }).runTests, policy: { ...policy, healing: { ...policy.healing, maxWaitTimeoutMs: 5_000 } } });
      expect(long.outcome, long.history.at(-1)?.reason).toBe('validation_failed');
      expect(long.validation.find((c) => c.name === 'wait-timeout')).toMatchObject({ ok: false });
      const relocate = await heal(target(g.runId), { provider: proposing([RENAME]), runTests: fakeRunner({ reproduce: [hidden] }).runTests });
      expect(relocate.validation.find((c) => c.name === 'change-kinds')).toMatchObject({ ok: false });
    } finally {
      g.cleanup();
    }
  });

  test('only executed tests that failed can be healed', async () => {
    const g = await failedGeneratedRun();
    try {
      await expect(heal({ kind: 'generated', runId: g.runId, scenarioId: 'REQ-202-SC-02' }, {})).rejects.toThrow('REQ-202-SC-02 is passed; only executed tests that failed can be healed');
    } finally {
      g.cleanup();
    }
  });
});

test('failing step index comes from the error location in the generated file', () => {
  const t = { attempts: [{ errors: [{ message: 'x', location: 'generated/r/REQ-1-SC-01.notes.spec.ts:21' }] }] } as unknown as TestEvidence;
  expect(failingStepIndex(t, 'generated/r/REQ-1-SC-01.notes.spec.ts', [18, 19, 21, 22])).toBe(2);
  const fromStack = { attempts: [{ errors: [{ message: 'at generated/r/REQ-1-SC-01.notes.spec.ts:22:5', location: 'src/pages/x.ts:4' }] }] } as unknown as TestEvidence;
  expect(failingStepIndex(fromStack, 'generated/r/REQ-1-SC-01.notes.spec.ts', [18, 19, 21, 22])).toBe(3);
});
