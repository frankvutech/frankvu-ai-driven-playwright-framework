import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactRecord } from '../domain/state';
import type { Approval } from './approval';
import { verifyApproval } from './approval';
import { resolveApiTarget, resolveTarget, type Policy } from './policy';

export const AGENT_CONFIG = 'playwright.agent.config.ts';
export const AGENT_PROJECT = 'agent-generated';

/** Agent Playwright project for each generated-file family (see playwright.agent.config.ts). */
export function agentProjectFor(file: string): string {
  if (file.endsWith('.notes.spec.ts')) return 'agent-generated-notes';
  if (file.endsWith('.api.spec.ts')) return 'agent-generated-api';
  return AGENT_PROJECT;
}
export const AGENT_PROJECTS = [AGENT_PROJECT, 'agent-generated-notes', 'agent-generated-api'] as const;

export interface SpawnResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Process launcher. Injected so tests can verify what would be executed. */
export type Spawner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<SpawnResult>;

export interface ExecutionRequest {
  repoRoot: string;
  runId: string;
  runDir: string;
  artifacts: ArtifactRecord[];
  approval: Approval | undefined;
  policy: Policy;
  env: NodeJS.ProcessEnv;
  spawner?: Spawner;
  /** Session variant from policy.sessionVariants (default "standard"). */
  variant?: string;
  /** Example-app failure mode (default "standard"); must be listed in the policy. */
  exampleAppVariant?: string;
}

export type ExecutionResult =
  | { executed: false; refusals: string[] }
  | {
      executed: true;
      target: { name: string; host: string };
      variant: string;
      exampleAppVariant: string;
      files: string[];
      reportPath: string;
      startedAt: Date;
      finishedAt: Date;
      spawn: SpawnResult;
    };

const OUTPUT_LIMIT = 200_000;

export const defaultSpawner: Spawner = (command, args, { cwd, env, timeoutMs }) =>
  new Promise((resolve) => {
    // shell: false — arguments are passed as an argv array, never parsed by a shell.
    // detached: the runner gets its own process group so the time limit can stop
    // Playwright's workers and browsers too, not just the CLI process.
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* already exited */
      }
    };
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => (stdout = (stdout + d.toString()).slice(-OUTPUT_LIMIT)));
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-OUTPUT_LIMIT)));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, stdout, stderr: stderr + String(err) });
    });
  });

/** Build the child environment from the policy allowlist only. */
export function childEnv(policy: Policy, env: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of policy.envPassthrough) if (env[key] !== undefined) out[key] = env[key];
  return { ...out, ...extra };
}

/**
 * The only path from a generated test to a browser. It refuses to start
 * unless a human approval covers the exact bytes on disk and the target is
 * an approved test environment, then invokes the stock Playwright Test CLI
 * with a fixed argument list.
 */
export async function executeApproved(req: ExecutionRequest): Promise<ExecutionResult> {
  const { policy, repoRoot } = req;
  const refusals = verifyApproval(req.approval, req.runId, req.artifacts, repoRoot, policy.generationArea);

  const uiBaseUrl = req.env.UI_BASE_URL ?? policy.approvedTargets[0].uiBaseUrl;
  const target = resolveTarget(policy, uiBaseUrl);
  if (!target.ok) refusals.push(target.reason);
  const variantName = req.variant ?? 'standard';
  const variant = policy.sessionVariants[variantName];
  if (!variant) refusals.push(`session variant "${variantName}" is not in the policy`);

  const files = req.artifacts.filter((a) => a.state === 'approved').map((a) => a.file);
  const projects = [...new Set(files.map(agentProjectFor))].sort();
  const extraEnv: Record<string, string> = {};
  if (projects.includes('agent-generated-api')) {
    const apiBaseUrl = req.env.API_BASE_URL ?? policy.apiTargets[0]?.baseUrl;
    const api = apiBaseUrl ? resolveApiTarget(policy, apiBaseUrl) : { ok: false as const, reason: 'no API target is approved in the policy' };
    if (!api.ok) refusals.push(api.reason);
    else extraEnv.API_BASE_URL = apiBaseUrl!;
  }
  const exampleAppVariant = req.exampleAppVariant ?? 'standard';
  if (projects.some((p) => p !== AGENT_PROJECT)) {
    if (!(policy.exampleApp.variants as string[]).includes(exampleAppVariant)) refusals.push(`example-app variant "${exampleAppVariant}" is not in the policy`);
    const external = req.env.EXAMPLE_APP_URL;
    if (external && !policy.exampleApp.approvedUrls.some((u) => new URL(u).origin === safeOrigin(external))) {
      refusals.push(`example app ${safeOrigin(external) ?? 'URL'} is not approved (unset EXAMPLE_APP_URL to use the local app)`);
    }
    extraEnv.EXAMPLE_APP_VARIANT = exampleAppVariant;
  }
  if (refusals.length > 0 || !target.ok || !variant) return { executed: false, refusals };

  const outputDir = path.join(req.runDir, 'artifacts');
  const reportPath = path.join(req.runDir, 'playwright-results.json');
  mkdirSync(outputDir, { recursive: true });

  const cli = require.resolve('@playwright/test/cli');
  const args = [
    cli,
    'test',
    '--config',
    AGENT_CONFIG,
    ...projects.flatMap((p) => ['--project', p]),
    '--retries',
    String(policy.execution.retries),
    '--workers',
    String(policy.execution.workers),
    '--timeout',
    String(policy.execution.testTimeoutMs),
    ...files,
  ];
  const env = childEnv(policy, req.env, {
    UI_BASE_URL: uiBaseUrl,
    AGENT_APPROVED_FILES: JSON.stringify(files),
    AGENT_RESULTS_FILE: reportPath,
    AGENT_OUTPUT_DIR: outputDir,
    AGENT_SESSION_USER: variant.user,
    ...extraEnv,
  });

  const startedAt = new Date();
  const spawner = req.spawner ?? defaultSpawner;
  const result = await spawner(process.execPath, args, { cwd: repoRoot, env, timeoutMs: policy.execution.maxDurationMs });
  return {
    executed: true,
    target: { name: target.name, host: target.host },
    variant: variantName,
    exampleAppVariant,
    files,
    reportPath,
    startedAt,
    finishedAt: new Date(),
    spawn: result,
  };
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
