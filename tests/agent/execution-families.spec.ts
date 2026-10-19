import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readdirSync, rmdirSync } from 'node:fs';
import { GenerationOutputSchema } from '../../src/agent/domain/testSpec';
import { readApproval } from '../../src/agent/execution/approval';
import { executeApproved, type Spawner } from '../../src/agent/execution/adapter';
import { resolveApiTarget } from '../../src/agent/execution/policy';
import { MockProvider } from '../../src/agent/llm/mock';
import { recordDecision } from '../../src/agent/workflow/decide';
import { executeRun } from '../../src/agent/workflow/execute';
import { planAndGenerate } from '../../src/agent/workflow/generate';
import { promoteRun } from '../../src/agent/workflow/promote';
import { RunStore } from '../../src/agent/workflow/store';
import { NO_WAIT, REPO_ROOT, example, policy, scratchRun } from './helpers';

/** Promotion creates tests/<dir>/generated/; remove it again when the test left it empty. */
function removeEmptyPromotionDir(dir: string) {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    /* already gone */
  }
}

test.describe.configure({ timeout: 120_000 });

function fakeSpawner() {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawner: Spawner = async (_command, args, opts) => {
    calls.push({ args, env: opts.env });
    return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  };
  return { calls, spawner };
}

/** `as` renames the requirement (e.g. to keep promoted file names unique per test). */
async function approvedRun(id: 'REQ-201' | 'REQ-202' | 'REQ-203', as: string = id) {
  const run = scratchRun(as);
  const ex = JSON.parse(JSON.stringify(example(id)).split(id).join(as)) as ReturnType<typeof example>;
  const provider = new MockProvider({ 'test-plan': [JSON.stringify(ex.plan)], 'test-generation': [JSON.stringify(ex.generation)] });
  await planAndGenerate(ex.requirement, { repoRoot: REPO_ROOT, policy, provider, runId: run.runId, retryPolicy: NO_WAIT });
  const store = new RunStore(REPO_ROOT, policy.runsArea, run.runId);
  recordDecision(store, 'approved', 'Frank Vu', 'reviewed');
  const artifacts = store.manifest().artifacts;
  const base = { repoRoot: REPO_ROOT, runId: run.runId, runDir: store.runDir, artifacts, approval: readApproval(store.runDir), policy };
  return { ...run, store, base };
}

test.describe('execution of API and combined tests', () => {
  test('each family runs in its own agent project; the example-app variant is passed explicitly', async () => {
    const run = await approvedRun('REQ-202');
    try {
      const { calls, spawner } = fakeSpawner();
      const result = await executeApproved({ ...run.base, env: { PATH: '/bin' }, spawner, exampleAppVariant: 'broken-create' });
      expect(result).toMatchObject({ executed: true, exampleAppVariant: 'broken-create' });
      const args = calls[0].args;
      expect(args.slice(args.indexOf('--project'), args.indexOf('--project') + 2)).toEqual(['--project', 'agent-generated-notes']);
      expect(args).not.toContain('agent-generated');
      expect(calls[0].env.EXAMPLE_APP_VARIANT).toBe('broken-create');
    } finally {
      run.cleanup();
    }
  });

  test('API base URLs, example-app URLs and variants must be approved by the policy', async () => {
    const run = await approvedRun('REQ-203');
    try {
      const { calls, spawner } = fakeSpawner();
      expect(await executeApproved({ ...run.base, env: { API_BASE_URL: 'https://api.production.example' }, spawner })).toMatchObject({ executed: false, refusals: [expect.stringContaining('blocked pattern')] });
      expect(await executeApproved({ ...run.base, env: { API_BASE_URL: 'https://evil.example' }, spawner })).toMatchObject({ executed: false, refusals: [expect.stringContaining('not an approved test target')] });
      expect(calls).toHaveLength(0);
      expect(await executeApproved({ ...run.base, env: {}, spawner })).toMatchObject({ executed: true });
      expect(calls[0].env.API_BASE_URL).toBe('https://jsonplaceholder.typicode.com');
      expect(calls[0].args).toContain('agent-generated-api');
    } finally {
      run.cleanup();
    }
    const notes = await approvedRun('REQ-201');
    try {
      const { calls, spawner } = fakeSpawner();
      expect(await executeApproved({ ...notes.base, env: {}, spawner, exampleAppVariant: 'chaos' })).toMatchObject({ refusals: ['example-app variant "chaos" is not in the policy'] });
      expect(await executeApproved({ ...notes.base, env: { EXAMPLE_APP_URL: 'https://notes.example.com' }, spawner })).toMatchObject({ refusals: [expect.stringContaining('is not approved')] });
      expect(calls).toHaveLength(0);
    } finally {
      notes.cleanup();
    }
    expect(resolveApiTarget(policy, 'not a url')).toMatchObject({ ok: false });
  });
});

test.describe('promotion into the trusted suite', () => {
  async function passedRun(as: string) {
    const run = await approvedRun('REQ-201', as);
    await executeRun(run.store, {
      policy,
      env: {},
      spawner: async (_cmd, _args, opts) => {
        const files = JSON.parse(opts.env.AGENT_APPROVED_FILES!) as string[];
        const specs = files.map((f) => {
          const id = path.basename(f).split('.')[0];
          const ok = !id.endsWith('SC-04');
          return { id, title: id, file: path.basename(f), tests: [{ projectName: 'agent-generated-api', status: ok ? 'expected' : 'unexpected', annotations: [{ type: 'scenario', description: id }], results: [{ retry: 0, status: ok ? 'passed' : 'failed', duration: 1, errors: ok ? [] : [{ message: 'x' }], attachments: [] }] }] };
        });
        writeFileSync(opts.env.AGENT_RESULTS_FILE!, JSON.stringify({ config: { version: 'fake' }, suites: [{ title: 'x', specs, suites: [] }], errors: [] }));
        return { exitCode: 1, timedOut: false, stdout: '', stderr: '' };
      },
    });
    return run;
  }
  const promotedPath = (id: string) => path.join(REPO_ROOT, 'tests/api/generated', `${id}.spec.ts`);

  test('only passed, unmodified tests are promoted by a named human; nothing is overwritten', async () => {
    const req = `REQ-${9000 + test.info().repeatEachIndex}`;
    const run = await passedRun(req);
    const ids = [`${req}-SC-01`, `${req}-SC-02`, `${req}-SC-03`];
    try {
      await expect(promoteRun(run.store, 'test-agent')).rejects.toThrow('not an acceptable human approver');
      const result = await promoteRun(run.store, 'Frank Vu');
      expect(result.promoted.map((p) => p.file)).toEqual(ids.map((id) => `tests/api/generated/${id}.spec.ts`));
      expect(result.skipped).toEqual([{ scenarioId: `${req}-SC-04`, reason: 'failed, only passed tests can be promoted' }]);
      const source = readFileSync(promotedPath(ids[0]), 'utf8');
      expect(source).toContain("import { test, expect } from '../../../src/fixtures/api';");
      expect(source).toContain('Promoted from agent run');
      expect(source).not.toContain('fixtures/agent');
      expect(run.store.manifest().artifacts.map((a) => a.state)).toEqual(['promoted', 'promoted', 'promoted', 'failed']);
      expect(run.store.manifest().artifacts[0].history.at(-1)).toMatchObject({ to: 'promoted', actor: 'human:Frank Vu' });
      // A second promotion has nothing left to do and never overwrites.
      expect((await promoteRun(run.store, 'Frank Vu')).promoted).toEqual([]);
    } finally {
      for (const id of ids) rmSync(promotedPath(id), { force: true });
      removeEmptyPromotionDir(path.join(REPO_ROOT, 'tests/api/generated'));
      run.cleanup();
    }
    expect(existsSync(promotedPath(ids[0]))).toBe(false);
  });

  test('a candidate changed after approval is not promoted', async () => {
    const req = `REQ-${9100 + test.info().repeatEachIndex}`;
    const run = await passedRun(req);
    try {
      const first = run.store.manifest().artifacts[0];
      writeFileSync(path.join(REPO_ROOT, first.file), readFileSync(path.join(REPO_ROOT, first.file), 'utf8') + '\n// edited\n');
      const result = await promoteRun(run.store, 'Frank Vu');
      expect(result.skipped).toContainEqual({ scenarioId: `${req}-SC-01`, reason: 'the candidate file changed after approval' });
      for (const p of result.promoted) rmSync(path.join(REPO_ROOT, p.file), { force: true });
      removeEmptyPromotionDir(path.join(REPO_ROOT, 'tests/api/generated'));
    } finally {
      run.cleanup();
    }
  });

  test('the generation output schema accepts the example API specs', () => {
    expect(GenerationOutputSchema.safeParse(example('REQ-201').generation).success).toBe(true);
  });
});
