import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { childEnv, defaultSpawner, type Spawner } from '../execution/adapter';
import type { Policy } from '../execution/policy';
import { collectEvidence } from '../evidence/collect';
import { knownSecrets } from '../evidence/redact';
import type { RunEvidence } from '../domain/result';
import type { TestRunSummary } from './types';

/**
 * Healing never edits the working tree. Each attempt gets a copy of the
 * framework (sources, tests, configs) in which a patch is applied, checked
 * and run; node_modules is linked, not copied. The copy is kept next to the
 * heal record so a reviewer can inspect exactly what was verified.
 */
const COPIED = [
  'src',
  'tests',
  'example-app',
  'playwright.config.ts',
  'playwright.agent.config.ts',
  'tsconfig.json',
  'eslint.config.mjs',
  'package.json',
  'agent.policy.json',
];

export function createWorkspace(repoRoot: string, dir: string, extraPaths: string[] = []): string {
  if (existsSync(dir)) throw new Error(`workspace ${dir} already exists`);
  mkdirSync(dir, { recursive: true });
  for (const rel of [...COPIED, ...extraPaths]) {
    const from = path.join(repoRoot, rel);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(dir, rel), { recursive: true, verbatimSymlinks: true });
  }
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

/** Unified diff of one repo-relative file between the working tree and the workspace. */
export function unifiedDiff(repoRoot: string, workspace: string, rel: string): string {
  const wsRel = path.relative(repoRoot, path.join(workspace, rel)).split(path.sep).join('/');
  // Fixed command and arguments; exit code 1 just means "files differ".
  const result = spawnSync('git', ['diff', '--no-index', '--no-color', '--', rel, wsRel], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 1) throw new Error(`git diff failed: ${result.stderr}`);
  return result.stdout.split(`b/${wsRel}`).join(`b/${rel}`);
}

export interface WorkspaceRun {
  label: string;
  workspace: string;
  /** trusted: base config and project; generated: agent config and agent project. */
  kind: 'trusted' | 'generated';
  project: string;
  /** Workspace-relative test files. */
  files: string[];
  /** Exact test title to select (trusted single-test runs). */
  title?: string;
  repeatEach: number;
  workers: number;
  exampleAppVariant: string;
  sessionUser?: string;
}

export interface WorkspaceRunResult {
  summary: TestRunSummary;
  evidence: RunEvidence;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Run tests inside a workspace with the stock Playwright CLI: fixed argv, no
 * shell, the policy's environment allowlist, the policy's time limit.
 */
export async function runInWorkspace(run: WorkspaceRun, deps: { policy: Policy; env: NodeJS.ProcessEnv; spawner?: Spawner }): Promise<WorkspaceRunResult> {
  const outRoot = path.join(run.workspace, '.agent', 'heal-runs', run.label);
  const reportPath = path.join(outRoot, 'results.json');
  const outputDir = path.join(outRoot, 'artifacts');
  mkdirSync(outRoot, { recursive: true });
  const cli = require.resolve('@playwright/test/cli');
  const common = ['--project', run.project, '--retries', '0', '--workers', String(run.workers), '--repeat-each', String(run.repeatEach)];
  const args =
    run.kind === 'trusted'
      ? [cli, 'test', '--config', 'playwright.config.ts', ...common, '--reporter', 'json', '--output', outputDir, ...(run.title ? ['--grep', escapeRegExp(run.title)] : []), ...run.files]
      : [cli, 'test', '--config', 'playwright.agent.config.ts', ...common, ...run.files];
  const extra: Record<string, string> =
    run.kind === 'trusted'
      ? { EXAMPLE_APP_VARIANT: run.exampleAppVariant, PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath }
      : {
          EXAMPLE_APP_VARIANT: run.exampleAppVariant,
          AGENT_APPROVED_FILES: JSON.stringify(run.files),
          AGENT_RESULTS_FILE: reportPath,
          AGENT_OUTPUT_DIR: outputDir,
          AGENT_SESSION_USER: run.sessionUser ?? 'standard',
        };
  const env = childEnv(deps.policy, deps.env, extra);
  const started = new Date();
  const spawner = deps.spawner ?? defaultSpawner;
  const spawn = await spawner(process.execPath, args, { cwd: run.workspace, env, timeoutMs: deps.policy.execution.maxDurationMs });
  const evidence = collectEvidence({
    runId: run.label,
    repoRoot: run.workspace,
    reportPath,
    startedAt: started,
    finishedAt: new Date(),
    target: { name: 'heal-workspace', host: 'local' },
    exampleAppVariant: run.exampleAppVariant,
    runner: { exitCode: spawn.exitCode, timedOut: spawn.timedOut, stderr: spawn.stderr },
    secrets: knownSecrets(deps.env),
  });
  const command = ['playwright', ...args.slice(1)].map((a) => (a.startsWith(run.workspace) ? path.relative(run.workspace, a) : a));
  return { summary: summarize(run, evidence, command, Date.now() - started.getTime()), evidence };
}

const FAILED = new Set(['failed', 'timedOut', 'interrupted']);

/** Counts for the selected test (or project), from Playwright evidence only. */
export function summarize(run: WorkspaceRun, evidence: RunEvidence, command: string[], durationMs: number): TestRunSummary {
  const tests = evidence.tests.filter((t) => t.project === run.project && (run.title === undefined || t.title === run.title));
  return {
    label: run.label,
    command,
    runs: tests.length,
    passed: tests.filter((t) => t.status === 'passed').length,
    failed: tests.filter((t) => FAILED.has(t.status)).length,
    statuses: tests.map((t) => t.status),
    reportFound: evidence.runner.reportFound,
    failedTests: [...new Set(evidence.tests.filter((t) => t.status !== 'passed' && t.status !== 'skipped').map((t) => `${t.project} › ${t.file} › ${t.title}`))],
    durationMs,
  };
}
