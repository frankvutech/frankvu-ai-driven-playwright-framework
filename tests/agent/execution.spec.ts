import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MockProvider } from '../../src/agent/llm/mock';
import { planAndGenerate } from '../../src/agent/workflow/generate';
import { recordDecision } from '../../src/agent/workflow/decide';
import { executeRun } from '../../src/agent/workflow/execute';
import { RunStore } from '../../src/agent/workflow/store';
import { isAcceptableApprover, readApproval, writeApproval } from '../../src/agent/execution/approval';
import { AGENT_CONFIG, childEnv, executeApproved, type Spawner } from '../../src/agent/execution/adapter';
import { resolveTarget } from '../../src/agent/execution/policy';
import { NO_WAIT, REPO_ROOT, generation101, plan101, policy, requirement101, scratchRun } from './helpers';

test.describe.configure({ timeout: 120_000 });

/** A spawner that records calls and never starts a process. */
function fakeSpawner() {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number }> = [];
  const spawner: Spawner = async (command, args, opts) => {
    calls.push({ command, args, env: opts.env, timeoutMs: opts.timeoutMs });
    return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  };
  return { calls, spawner };
}

async function generatedRun() {
  const run = scratchRun();
  const provider = new MockProvider({ 'test-plan': [JSON.stringify(plan101())], 'test-generation': [JSON.stringify(generation101())] });
  const manifest = await planAndGenerate(requirement101(), { repoRoot: REPO_ROOT, policy, provider, runId: run.runId, retryPolicy: NO_WAIT });
  expect(manifest.status).toBe('awaiting_approval');
  return { ...run, store: new RunStore(REPO_ROOT, policy.runsArea, run.runId) };
}

test.describe('human approval', () => {
  test('approvers must be named people, not automation', () => {
    for (const name of ['Frank Vu', 'QA Lead Mai']) expect(isAcceptableApprover(name)).toBe(true);
    for (const name of ['', ' ', 'x', 'relynx-agent', 'Relynx', 'Claude', 'agent', 'AI', 'ci', 'github-actions', 'dependabot[bot]', 'LLM reviewer']) {
      expect(isAcceptableApprover(name), name).toBe(false);
    }
  });

  test('an agent identity cannot write an approval record', async () => {
    const run = await generatedRun();
    try {
      expect(() => recordDecision(run.store, 'approved', 'relynx-agent', undefined)).toThrow('not an acceptable human approver');
      expect(() => writeApproval(run.store.runDir, { runId: run.runId, decision: 'approved', approver: 'Claude', decidedAt: '', artifacts: [] })).toThrow();
      expect(readApproval(run.store.runDir)).toBeUndefined();
      expect(run.store.manifest().artifacts.every((a) => a.state === 'awaiting_approval')).toBe(true);
    } finally {
      run.cleanup();
    }
  });

  test('a file edited after validation cannot be approved', async () => {
    const run = await generatedRun();
    try {
      appendFileSync(path.join(REPO_ROOT, run.store.manifest().artifacts[0].file), '\n// edited\n');
      expect(() => recordDecision(run.store, 'approved', 'Frank Vu', undefined)).toThrow('changed after validation');
    } finally {
      run.cleanup();
    }
  });

  test('approval binds the exact file hashes and moves artifacts to approved', async () => {
    const run = await generatedRun();
    try {
      const manifest = recordDecision(run.store, 'approved', 'Frank Vu', 'reviewed');
      expect(manifest.status).toBe('approved_for_execution');
      expect(manifest.artifacts.map((a) => a.state)).toEqual(['approved', 'approved', 'approved']);
      expect(manifest.artifacts[0].history.at(-1)).toMatchObject({ to: 'approved', actor: 'human:Frank Vu' });
      expect(readApproval(run.store.runDir)?.artifacts.map((a) => a.sha256)).toEqual(manifest.artifacts.map((a) => a.sha256));
      expect(() => recordDecision(run.store, 'approved', 'Frank Vu', undefined)).toThrow('not awaiting approval');
    } finally {
      run.cleanup();
    }
  });
});

test.describe('execution boundary', () => {
  test('a run awaiting approval is not executed and stays approvable', async () => {
    const run = await generatedRun();
    try {
      const { calls, spawner } = fakeSpawner();
      const manifest = await executeRun(run.store, { policy, env: process.env, spawner });
      expect(calls).toHaveLength(0);
      expect(manifest.status).toBe('awaiting_approval');
      expect(manifest.steps.at(-1)).toMatchObject({ step: 'execute', status: 'failed' });
    } finally {
      run.cleanup();
    }
  });

  test('missing, rejected or stale approvals refuse execution without starting a process', async () => {
    const run = await generatedRun();
    try {
      const { calls, spawner } = fakeSpawner();
      const artifacts = run.store.manifest().artifacts.map((a) => ({ ...a, state: 'approved' as const }));
      const base = { repoRoot: REPO_ROOT, runId: run.runId, runDir: run.store.runDir, artifacts, policy, env: {}, spawner };
      const approval = { runId: run.runId, decision: 'approved' as const, approver: 'Frank Vu', decidedAt: 'now', artifacts: artifacts.map((a) => ({ file: a.file, sha256: a.sha256 })) };

      expect(await executeApproved({ ...base, approval: undefined })).toEqual({ executed: false, refusals: [expect.stringContaining('no approval record')] });
      expect((await executeApproved({ ...base, approval: { ...approval, decision: 'rejected' } })) as { refusals: string[] }).toMatchObject({ refusals: [expect.stringContaining('rejected')] });
      expect((await executeApproved({ ...base, approval: { ...approval, approver: 'relynx-agent' } })) as { refusals: string[] }).toMatchObject({ refusals: [expect.stringContaining('not an acceptable human approver')] });
      expect((await executeApproved({ ...base, approval: { ...approval, runId: 'other' } })) as { refusals: string[] }).toMatchObject({ refusals: [expect.stringContaining('approval is for run other')] });
      expect((await executeApproved({ ...base, approval: { ...approval, artifacts: approval.artifacts.slice(1) } })) as { refusals: string[] }).toMatchObject({ refusals: [expect.stringContaining('not covered by the approval')] });

      appendFileSync(path.join(REPO_ROOT, artifacts[0].file), '\n// tampered after approval\n');
      expect((await executeApproved({ ...base, approval })) as { refusals: string[] }).toMatchObject({ refusals: [expect.stringContaining('changed after approval')] });
      expect(calls).toHaveLength(0);
    } finally {
      run.cleanup();
    }
  });

  test('only approved test targets are allowed; production-looking hosts are blocked', () => {
    expect(resolveTarget(policy, 'https://www.saucedemo.com')).toMatchObject({ ok: true, name: 'saucedemo-public-demo' });
    expect(resolveTarget(policy, 'https://evil.example')).toMatchObject({ ok: false, reason: expect.stringContaining('not an approved test target') });
    expect(resolveTarget(policy, 'https://shop.production.example')).toMatchObject({ ok: false, reason: expect.stringContaining('blocked pattern') });
    expect(resolveTarget(policy, 'not a url')).toMatchObject({ ok: false });
  });

  test('an approved run invokes the stock Playwright CLI with a fixed argv and a minimal environment', async () => {
    const run = await generatedRun();
    try {
      recordDecision(run.store, 'approved', 'Frank Vu', 'ok');
      const { calls, spawner } = fakeSpawner();
      const env = { PATH: '/usr/bin', HOME: '/home/x', ANTHROPIC_API_KEY: 'sk-ant-should-not-leak', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'x' };
      const manifest = await executeRun(run.store, { policy, env, spawner });
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call.command).toBe(process.execPath);
      expect(call.args[0]).toBe(require.resolve('@playwright/test/cli'));
      const files = manifest.artifacts.map((a) => a.file);
      expect(call.args.slice(1)).toEqual(['test', '--config', AGENT_CONFIG, '--project', 'agent-generated', '--retries', '0', '--workers', '2', '--timeout', '30000', ...files]);
      expect(Object.keys(call.env).sort()).toEqual(['HOME', 'PATH', 'RELYNX_APPROVED_FILES', 'RELYNX_OUTPUT_DIR', 'RELYNX_RESULTS_FILE', 'UI_BASE_URL']);
      expect(JSON.parse(call.env.RELYNX_APPROVED_FILES!)).toEqual(files);
      expect(call.timeoutMs).toBe(policy.execution.maxDurationMs);
      // The fake runner produced no report, so nothing can be reported as passed.
      expect(manifest.artifacts.map((a) => a.state)).toEqual(['inconclusive', 'inconclusive', 'inconclusive']);
      // A run executes at most once.
      const again = await executeRun(run.store, { policy, env, spawner });
      expect(calls).toHaveLength(1);
      expect(again.status).toBe('executed');
    } finally {
      run.cleanup();
    }
  });

  test('the child environment contains only allowlisted variables', () => {
    expect(childEnv(policy, { PATH: 'p', SECRET: 's', SAUCE_PASSWORD: 'pw' }, { X: '1' })).toEqual({ PATH: 'p', SAUCE_PASSWORD: 'pw', X: '1' });
  });

  test('the agent Playwright config refuses to load without an approved file list', () => {
    const cli = require.resolve('@playwright/test/cli');
    const run = (env: Record<string, string>) => {
      try {
        execFileSync(process.execPath, [cli, 'test', '--config', AGENT_CONFIG, '--list', '--reporter=list'], { cwd: REPO_ROOT, env: { PATH: process.env.PATH!, ...env }, stdio: 'pipe' });
        return '';
      } catch (e) {
        return String((e as { stderr?: Buffer }).stderr ?? e) + String((e as { stdout?: Buffer }).stdout ?? '');
      }
    };
    expect(run({})).toContain('only runs files approved through the Relynx execution adapter');
    const runs = path.join(REPO_ROOT, '.relynx/runs/x');
    expect(run({ RELYNX_APPROVED_FILES: '["tests/ui/login.spec.ts"]', RELYNX_RESULTS_FILE: `${runs}/r.json`, RELYNX_OUTPUT_DIR: runs })).toContain('approved files must be .spec.ts files inside generated/');
    expect(run({ RELYNX_APPROVED_FILES: '["generated/x/a.spec.ts"]', RELYNX_RESULTS_FILE: '/tmp/r.json', RELYNX_OUTPUT_DIR: runs })).toContain('must be inside .relynx/runs/');
  });

  test('the default Playwright config never picks up generated tests', () => {
    const cli = require.resolve('@playwright/test/cli');
    // --reporter=list so this nested run does not overwrite the outer run's JSON/JUnit/HTML evidence.
    const out = execFileSync(process.execPath, [cli, 'test', '--list', '--reporter=list'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(out).not.toContain('generated/');
  });

  test('workflow modules have no path to recording approvals', () => {
    for (const file of ['generate.ts', 'execute.ts']) {
      const source = readFileSync(path.join(REPO_ROOT, 'src/agent/workflow', file), 'utf8');
      expect(source, file).not.toMatch(/writeApproval|recordDecision/);
    }
  });
});
