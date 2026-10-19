import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MockProvider, type MockReply } from '../src/agent/llm/mock';
import { ProviderError } from '../src/agent/llm/provider';
import type { RetryPolicy, UsageRecord } from '../src/agent/llm/structured';
import { planAndGenerate, planRequirement } from '../src/agent/workflow/generate';
import { recordDecision } from '../src/agent/workflow/decide';
import { executeRun } from '../src/agent/workflow/execute';
import { RunStore, type RunManifest } from '../src/agent/workflow/store';
import { defaultSpawner, type Spawner } from '../src/agent/execution/adapter';
import type { Policy } from '../src/agent/execution/policy';
import type { RunEvidence } from '../src/agent/domain/result';
import type { FailureAnalysis } from '../src/agent/analysis/types';
import { countWhere, mean, ratio } from './metrics';
import { REPO_ROOT } from './evaluate';
import { createProvider, ProviderConfigError } from '../src/agent/config/llm';
import { renderSpec } from '../src/agent/generation/render';
import { validateArtifacts } from '../src/agent/validation/artifacts';
import { GenerationOutputSchema } from '../src/agent/domain/testSpec';
import { healDir, healTest, newHealId } from '../src/agent/healing/heal';
import { summarize, type WorkspaceRun, type WorkspaceRunResult } from '../src/agent/healing/workspace';
import { sha256File } from '../src/agent/execution/files';
import { existsSync, mkdirSync } from 'node:fs';

/**
 * Deterministic fault injection against the Phase 2 workflow. Faults are
 * injected with mock providers and spawner test doubles (plus two real local
 * processes: a broken Playwright config and a process that never exits). No
 * external service is disrupted and nothing runs against the demo site.
 */
export interface FaultResult {
  id: string;
  fault: string;
  expectedSafeBehaviour: string;
  recoverable: boolean;
  observed: {
    finalStatus: string;
    errorKind?: string;
    attempts?: number;
    retries?: number;
    recovered: boolean;
    recoveryLatencyMs?: number;
    executions: number;
    evidencePreserved?: boolean;
    elapsedMs: number;
    limitMs: number;
  };
  checks: Array<{ name: string; pass: boolean; detail?: string }>;
  pass: boolean;
}

const RETRY: RetryPolicy = { maxAttempts: 3, timeoutMs: 200, baseBackoffMs: 10, maxBackoffMs: 40 };
/** Upper bound for a model step: every attempt times out and every backoff is taken, plus scheduling slack. */
const modelLimit = (p: RetryPolicy) => p.maxAttempts * p.timeoutMs + (p.maxAttempts - 1) * p.maxBackoffMs + 1_000;

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, 'examples', file), 'utf8')) as T;
}
const requirement = () => readJson<unknown>('requirements/REQ-101-sign-in.json');
const replies = () => readJson<{ 'test-plan': unknown[]; 'test-generation': unknown[] }>('mock-replies/REQ-101.json');
const planReply = () => JSON.stringify(replies()['test-plan'][0]);
const genReply = () => JSON.stringify(replies()['test-generation'][0]);

/* ----------------------------- provider faults ----------------------------- */

async function providerFault(
  id: string,
  fault: string,
  expected: string,
  planReplies: MockReply[],
  expect: { outcome: string; kind?: string; attempts: number; recoverable: boolean },
  delayMs = 0,
): Promise<FaultResult> {
  const provider = new MockProvider({ 'test-plan': planReplies }, delayMs);
  const started = Date.now();
  const r = await planRequirement(requirement(), provider, RETRY);
  const elapsedMs = Date.now() - started;
  const usage: UsageRecord | undefined = 'usage' in r ? r.usage : undefined;
  const kind = r.outcome === 'plan_failed' ? r.kind : undefined;
  const recovered = expect.recoverable && r.outcome === 'plan_valid';
  const checks = [
    { name: 'outcome', pass: r.outcome === expect.outcome, detail: r.outcome },
    { name: 'errorClassification', pass: expect.kind === undefined || kind === expect.kind, detail: kind ?? '-' },
    { name: 'boundedAttempts', pass: usage?.attempts === expect.attempts && provider.calls.length === expect.attempts, detail: `${usage?.attempts} attempt(s), ${provider.calls.length} call(s)` },
    { name: 'retryOnlyTransient', pass: expect.recoverable || !['malformed_json', 'schema_violation', 'provider_auth'].includes(kind ?? '') || usage?.attempts === 1 },
    { name: 'terminatesWithinLimit', pass: elapsedMs <= modelLimit(RETRY), detail: `${elapsedMs}ms <= ${modelLimit(RETRY)}ms` },
    { name: 'noGenerationAfterFailure', pass: r.outcome === 'plan_valid' || provider.calls.every((c) => c.useCase === 'test-plan') },
  ];
  return {
    id,
    fault,
    expectedSafeBehaviour: expected,
    recoverable: expect.recoverable,
    observed: {
      finalStatus: r.outcome,
      errorKind: kind,
      attempts: usage?.attempts,
      retries: usage ? usage.attempts - 1 : undefined,
      recovered,
      recoveryLatencyMs: recovered ? usage?.latencyMs : undefined,
      executions: 0,
      elapsedMs,
      limitMs: modelLimit(RETRY),
    },
    checks,
    pass: checks.every((c) => c.pass),
  };
}

/* --------------------------- execution-side faults --------------------------- */

async function approvedRun(policy: Policy): Promise<{ store: RunStore; manifest: RunManifest; cleanup: () => void }> {
  const provider = new MockProvider({ 'test-plan': [planReply()], 'test-generation': [genReply()] });
  const manifest = await planAndGenerate(requirement(), { repoRoot: REPO_ROOT, policy, provider, retryPolicy: RETRY });
  const store = new RunStore(REPO_ROOT, policy.runsArea, manifest.runId);
  const cleanup = () => {
    rmSync(path.join(REPO_ROOT, policy.generationArea, manifest.runId), { recursive: true, force: true });
    rmSync(store.runDir, { recursive: true, force: true });
  };
  return { store, manifest, cleanup };
}

function countingSpawner(inner: Spawner) {
  const state = { calls: 0 };
  const spawner: Spawner = async (cmd, args, opts) => {
    state.calls += 1;
    return inner(cmd, args, opts);
  };
  return { state, spawner };
}

/** A spawner double that writes a Playwright-shaped JSON report for the approved files. */
function reportWriter(build: (files: string[]) => object): Spawner {
  return async (_cmd, _args, opts) => {
    writeFileSync(opts.env.AGENT_RESULTS_FILE!, JSON.stringify(build(JSON.parse(opts.env.AGENT_APPROVED_FILES!))));
    return { exitCode: 1, timedOut: false, stdout: '', stderr: '' };
  };
}

function syntheticReport(files: string[], result: (scenarioId: string) => object) {
  return {
    config: { version: 'synthetic-fault-injection' },
    errors: [],
    stats: {},
    suites: files.map((f) => {
      const scenarioId = path.basename(f, '.spec.ts');
      return {
        title: f,
        file: f,
        specs: [{ id: scenarioId, title: scenarioId, file: f, tests: [{ projectName: 'agent-generated', status: 'unexpected', annotations: [{ type: 'scenario', description: scenarioId }], results: [result(scenarioId)] }] }],
      };
    }),
  };
}

interface ExecFault {
  id: string;
  fault: string;
  expected: string;
  /** Runs after the human decision, before execution (e.g. tampering with a file). */
  afterApproval?: (ctx: { store: RunStore; manifest: RunManifest }) => void;
  approve?: boolean;
  spawner: Spawner;
  policy?: (p: Policy) => Policy;
  env?: NodeJS.ProcessEnv;
  executeTwice?: boolean;
  expect: {
    status: string;
    executions: number;
    artifactStates?: string[];
    evidence: boolean;
    analysisCategory?: string;
    stderrIncludes?: string;
    refusalIncludes?: string;
    limitMs: number;
  };
}

async function executionFault(f: ExecFault, basePolicy: Policy): Promise<FaultResult> {
  const policy = f.policy ? f.policy(basePolicy) : basePolicy;
  const run = await approvedRun(policy);
  try {
    if (f.approve !== false) recordDecision(run.store, 'approved', 'Fault Injection Reviewer', 'approved for fault injection');
    f.afterApproval?.(run);
    const { state, spawner } = countingSpawner(f.spawner);
    const started = Date.now();
    let manifest = await executeRun(run.store, { policy, env: f.env ?? { PATH: process.env.PATH, HOME: process.env.HOME }, spawner });
    if (f.executeTwice) manifest = await executeRun(run.store, { policy, env: f.env ?? { PATH: process.env.PATH }, spawner });
    const elapsedMs = Date.now() - started;
    const evidence = run.store.read<RunEvidence>('evidence.json');
    const analyses = run.store.read<FailureAnalysis[]>('analysis.json') ?? [];
    const refusals = run.store.read<string[]>('execution.refusal.json') ?? [];
    const states = manifest.artifacts.map((a) => a.state);
    const checks = [
      { name: 'finalStatus', pass: manifest.status === f.expect.status, detail: manifest.status },
      { name: 'executions', pass: state.calls === f.expect.executions, detail: `${state.calls} runner start(s)` },
      { name: 'neverPassedWithoutEvidence', pass: !states.includes('passed') },
      { name: 'evidencePreserved', pass: !!evidence === f.expect.evidence, detail: evidence ? `reportFound=${evidence.runner.reportFound}` : 'no evidence.json' },
      { name: 'terminatesWithinLimit', pass: elapsedMs <= f.expect.limitMs, detail: `${elapsedMs}ms <= ${f.expect.limitMs}ms` },
    ];
    if (f.expect.artifactStates) checks.push({ name: 'artifactStates', pass: JSON.stringify(states) === JSON.stringify(f.expect.artifactStates), detail: states.join(',') });
    if (f.expect.analysisCategory) checks.push({ name: 'errorClassification', pass: analyses.length > 0 && analyses.every((a) => a.diagnosis.category === f.expect.analysisCategory), detail: analyses.map((a) => a.diagnosis.category).join(',') || 'none' });
    if (f.expect.stderrIncludes) checks.push({ name: 'errorPropagated', pass: !!evidence?.runner.stderrTail.includes(f.expect.stderrIncludes), detail: evidence?.runner.stderrTail.slice(0, 160) });
    if (f.expect.refusalIncludes) checks.push({ name: 'errorClassification', pass: refusals.some((r) => r.includes(f.expect.refusalIncludes!)), detail: refusals.join('; ') || manifest.steps.at(-1)?.detail });
    return {
      id: f.id,
      fault: f.fault,
      expectedSafeBehaviour: f.expected,
      recoverable: false,
      observed: {
        finalStatus: manifest.status,
        recovered: false,
        executions: state.calls,
        evidencePreserved: !!evidence,
        elapsedMs,
        limitMs: f.expect.limitMs,
      },
      checks,
      pass: checks.every((c) => c.pass),
    };
  } finally {
    run.cleanup();
  }
}

/* --------------------------------- catalogue --------------------------------- */

export async function runFaultInjection(policy: Policy): Promise<{ results: FaultResult[]; metrics: ReturnType<typeof faultMetrics> }> {
  const NO_RUN_LIMIT = 30_000;
  const results: FaultResult[] = [];
  const pe = (kind: ConstructorParameters<typeof ProviderError>[0]) => new ProviderError(kind, `injected ${kind}`);

  results.push(await providerFault('FI-01', 'provider timeout (every attempt)', 'retry up to the attempt limit, then fail the step as provider_timeout', [planReply(), planReply(), planReply()], { outcome: 'plan_failed', kind: 'provider_timeout', attempts: 3, recoverable: false }, 1_000));
  results.push(await providerFault('FI-02', 'rate limit, then success', 'retry after backoff and continue with the valid plan', [pe('rate_limit'), planReply()], { outcome: 'plan_valid', attempts: 2, recoverable: true }));
  results.push(await providerFault('FI-03', 'temporary server error twice, then success', 'retry twice and continue', [pe('server'), pe('server'), planReply()], { outcome: 'plan_valid', attempts: 3, recoverable: true }));
  results.push(await providerFault('FI-04', 'persistent server error', 'stop after the attempt limit and report provider_server', Array.from({ length: 6 }, () => pe('server')), { outcome: 'plan_failed', kind: 'provider_server', attempts: 3, recoverable: false }));
  results.push(await providerFault('FI-05', 'malformed structured output', 'do not retry; fail the step as malformed_json', ['{"requirementId": ', planReply()], { outcome: 'plan_failed', kind: 'malformed_json', attempts: 1, recoverable: false }));
  results.push(await providerFault('FI-06', 'schema-invalid output', 'do not retry; fail the step as schema_violation', ['{"requirementId":"REQ-101","scenarios":"none"}', planReply()], { outcome: 'plan_failed', kind: 'schema_violation', attempts: 1, recoverable: false }));
  results.push(await providerFault('FI-07', 'authentication error', 'do not retry; fail the step as provider_auth', [pe('auth'), planReply()], { outcome: 'plan_failed', kind: 'provider_auth', attempts: 1, recoverable: false }));

  const failedAssertion = (files: string[]) =>
    syntheticReport(files, () => ({ retry: 0, status: 'failed', duration: 50, errors: [{ message: 'Error: expect(locator).toHaveText(expected) failed\n\nExpected: "Welcome back"\nReceived: "Products"' }], attachments: [] }));
  const execFaults: ExecFault[] = [
    {
      id: 'FI-08', fault: 'test runner cannot start (missing executable)', expected: 'record the runner error, mark tests inconclusive, never passed, no retry',
      spawner: (_c, args, opts) => defaultSpawner('/nonexistent/agent-node', args, opts),
      expect: { status: 'executed', executions: 1, artifactStates: ['inconclusive', 'inconclusive', 'inconclusive'], evidence: true, stderrIncludes: 'ENOENT', limitMs: NO_RUN_LIMIT },
    },
    {
      id: 'FI-09', fault: 'invalid test configuration', expected: 'Playwright refuses to load; the error is preserved and tests are inconclusive',
      spawner: (cmd, args, opts) => defaultSpawner(cmd, args, { ...opts, env: { ...opts.env, AGENT_APPROVED_FILES: '[]' } }),
      expect: { status: 'executed', executions: 1, artifactStates: ['inconclusive', 'inconclusive', 'inconclusive'], evidence: true, stderrIncludes: 'only runs files approved', limitMs: 60_000 },
    },
    {
      id: 'FI-10', fault: 'test timeout inside Playwright', expected: 'failed (not passed), classified as a timeout, no re-execution',
      spawner: reportWriter((files) => syntheticReport(files, () => ({ retry: 0, status: 'timedOut', duration: 30_000, errors: [{ message: 'Test timeout of 30000ms exceeded.' }], attachments: [] }))),
      expect: { status: 'executed', executions: 1, artifactStates: ['failed', 'failed', 'failed'], evidence: true, analysisCategory: 'timeout_sync', limitMs: NO_RUN_LIMIT },
    },
    {
      id: 'FI-11', fault: 'runner exceeds the wall-clock limit', expected: 'the process group is stopped at the limit; tests inconclusive',
      policy: (p) => ({ ...p, execution: { ...p.execution, maxDurationMs: 1_500 } }),
      spawner: (_c, _a, opts) => defaultSpawner(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], opts),
      expect: { status: 'executed', executions: 1, artifactStates: ['inconclusive', 'inconclusive', 'inconclusive'], evidence: true, limitMs: 1_500 + 5_000 + 2_000 },
    },
    {
      id: 'FI-12', fault: 'report references missing trace and screenshot files', expected: 'failed with no phantom evidence references',
      spawner: reportWriter((files) => syntheticReport(files, () => ({ retry: 0, status: 'failed', duration: 10, errors: [{ message: 'Error: boom' }], attachments: [{ name: 'trace', contentType: 'application/zip', path: '/nonexistent/trace.zip' }, { name: 'screenshot', contentType: 'image/png', path: '/nonexistent/shot.png' }] }))),
      expect: { status: 'executed', executions: 1, artifactStates: ['failed', 'failed', 'failed'], evidence: true, limitMs: NO_RUN_LIMIT },
    },
    {
      id: 'FI-13', fault: 'failed assertion', expected: 'reported as failed exactly once; never retried into a pass',
      spawner: reportWriter(failedAssertion),
      expect: { status: 'executed', executions: 1, artifactStates: ['failed', 'failed', 'failed'], evidence: true, analysisCategory: 'assertion_logic', limitMs: NO_RUN_LIMIT },
    },
    {
      id: 'FI-14', fault: 'execution requested twice', expected: 'the second request is refused; the runner starts once',
      spawner: reportWriter(failedAssertion), executeTwice: true,
      expect: { status: 'executed', executions: 1, evidence: true, limitMs: NO_RUN_LIMIT },
    },
    {
      id: 'FI-15', fault: 'execution without approval', expected: 'refused before starting the runner; run stays awaiting approval',
      approve: false, spawner: reportWriter(failedAssertion),
      expect: { status: 'awaiting_approval', executions: 0, evidence: false, limitMs: NO_RUN_LIMIT },
    },
    {
      id: 'FI-16', fault: 'approved file modified before execution', expected: 'refused (hash mismatch); runner never starts',
      spawner: reportWriter(failedAssertion),
      afterApproval: ({ manifest }) => appendFileSync(path.join(REPO_ROOT, manifest.artifacts[0].file), '\n// tampered after approval\n'),
      expect: { status: 'execution_refused', executions: 0, evidence: false, refusalIncludes: 'changed after approval', limitMs: NO_RUN_LIMIT },
    },
    {
      id: 'FI-17', fault: 'execution against an unapproved (production-like) target', expected: 'refused by policy; runner never starts',
      env: { PATH: process.env.PATH, UI_BASE_URL: 'https://shop.production.example.com' }, spawner: reportWriter(failedAssertion),
      expect: { status: 'execution_refused', executions: 0, evidence: false, refusalIncludes: 'blocked pattern', limitMs: NO_RUN_LIMIT },
    },
  ];
  execFaults.push(
    {
      id: 'FI-18', fault: 'API network error (service unreachable)', expected: 'failed, never passed, classified as an environment problem',
      spawner: reportWriter((files) => syntheticReport(files, () => ({ retry: 0, status: 'failed', duration: 20, errors: [{ message: 'Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:9\nCall log:\n  - -> GET http://127.0.0.1:9/api/notes' }], attachments: [] }))),
      expect: { status: 'executed', executions: 1, artifactStates: ['failed', 'failed', 'failed'], evidence: true, analysisCategory: 'environment', limitMs: NO_RUN_LIMIT },
    },
    {
      id: 'FI-19', fault: 'invalid API response (body breaks the schema)', expected: 'failed, never passed, classified as an API contract failure',
      spawner: reportWriter((files) => syntheticReport(files, () => ({ retry: 0, status: 'failed', duration: 20, errors: [{ message: 'Error: Response from /api/notes (HTTP 200) does not match the expected schema:\n  0.owner: Invalid input: expected string, received undefined' }], attachments: [] }))),
      expect: { status: 'executed', executions: 1, artifactStates: ['failed', 'failed', 'failed'], evidence: true, analysisCategory: 'api_contract', limitMs: NO_RUN_LIMIT },
    },
    {
      id: 'FI-20', fault: 'browser cannot start', expected: 'failed, never passed, classified as an environment problem',
      spawner: reportWriter((files) => syntheticReport(files, () => ({ retry: 0, status: 'failed', duration: 5, errors: [{ message: "Error: browserType.launch: Executable doesn't exist at /ms-playwright/chromium/chrome" }], attachments: [] }))),
      expect: { status: 'executed', executions: 1, artifactStates: ['failed', 'failed', 'failed'], evidence: true, analysisCategory: 'environment', limitMs: NO_RUN_LIMIT },
    },
  );
  for (const f of execFaults) results.push(await executionFault(f, policy));
  results.push(missingCredentials(), await invalidGeneratedCode(), await interruptedGeneration(policy));
  results.push(...(await healingFaults(policy)));
  return { results, metrics: faultMetrics(results) };
}

/* ---------------------------- configuration faults ---------------------------- */

function missingCredentials(): FaultResult {
  const started = Date.now();
  let error: unknown;
  try {
    createProvider('anthropic', undefined, {});
  } catch (e) {
    error = e;
  }
  const elapsedMs = Date.now() - started;
  const checks = [
    { name: 'errorClassification', pass: error instanceof ProviderConfigError, detail: error instanceof Error ? error.message : 'no error' },
    { name: 'noModelCall', pass: true, detail: 'the provider is never constructed, so no request can be sent' },
    { name: 'terminatesWithinLimit', pass: elapsedMs <= 1_000, detail: `${elapsedMs}ms` },
  ];
  return {
    id: 'FI-21', fault: 'missing provider credentials', expectedSafeBehaviour: 'a configuration error before any work or model call; not retried', recoverable: false,
    observed: { finalStatus: error instanceof ProviderConfigError ? 'config_error' : 'no_error', errorKind: 'config', recovered: false, executions: 0, elapsedMs, limitMs: 1_000 },
    checks, pass: checks.every((c) => c.pass),
  };
}

/** Rendered code that no longer type-checks or lints (e.g. edited by hand) never reaches approval. */
async function invalidGeneratedCode(): Promise<FaultResult> {
  const scratch = `fi22-${Date.now().toString(36)}`;
  const dir = path.join(REPO_ROOT, 'generated', scratch);
  const started = Date.now();
  mkdirSync(dir, { recursive: true });
  try {
    const spec = GenerationOutputSchema.parse(replies()['test-generation'][0]).tests[0];
    const typeError = path.posix.join('generated', scratch, 'type-error.spec.ts');
    const lintError = path.posix.join('generated', scratch, 'lint-error.spec.ts');
    writeFileSync(path.join(REPO_ROOT, typeError), renderSpec(spec, scratch).replace('await loginPage.goto();', 'await loginPage.goto(42);'));
    writeFileSync(path.join(REPO_ROOT, lintError), renderSpec(spec, scratch).replace('\ntest(\n', '\ntest.only(\n'));
    const trace = { requirementId: spec.requirementId, scenarioId: spec.scenarioId };
    const v = await validateArtifacts({ repoRoot: REPO_ROOT, generationArea: 'generated', files: { [typeError]: trace, [lintError]: trace }, workspaceBefore: [], workspaceAfter: [] });
    const elapsedMs = Date.now() - started;
    const checks = [
      { name: 'rejected', pass: !v.ok, detail: v.ok ? 'accepted' : 'rejected' },
      { name: 'errorClassification', pass: v.files[typeError].some((f) => f.check === 'typecheck') && v.files[lintError].some((f) => f.check === 'ast' || f.check === 'lint'), detail: [...v.files[typeError], ...v.files[lintError]].map((f) => f.check).join(',') },
      { name: 'terminatesWithinLimit', pass: elapsedMs <= 60_000, detail: `${elapsedMs}ms` },
    ];
    return {
      id: 'FI-22', fault: 'generated code fails type-check and lint', expectedSafeBehaviour: 'rejected by static validation; never approved or executed', recoverable: false,
      observed: { finalStatus: v.ok ? 'accepted' : 'rejected', recovered: false, executions: 0, elapsedMs, limitMs: 60_000 },
      checks, pass: checks.every((c) => c.pass),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The provider fails mid-workflow (after a valid plan): nothing is left approvable or executable. */
async function interruptedGeneration(policy: Policy): Promise<FaultResult> {
  const pe = () => new ProviderError('network', 'injected network failure');
  const provider = new MockProvider({ 'test-plan': [planReply()], 'test-generation': [pe(), pe(), pe(), pe()] });
  const started = Date.now();
  const manifest = await planAndGenerate(requirement(), { repoRoot: REPO_ROOT, policy, provider, retryPolicy: RETRY });
  const elapsedMs = Date.now() - started;
  const store = new RunStore(REPO_ROOT, policy.runsArea, manifest.runId);
  const usage = store.read<UsageRecord[]>('llm-usage.json') ?? [];
  const gen = usage.find((u) => u.useCase === 'test-generation');
  try {
    const checks = [
      { name: 'finalStatus', pass: manifest.status === 'generation_failed', detail: manifest.status },
      { name: 'errorClassification', pass: gen?.outcome === 'provider_network', detail: gen?.outcome },
      { name: 'boundedAttempts', pass: gen?.attempts === RETRY.maxAttempts, detail: `${gen?.attempts} attempt(s)` },
      { name: 'nothingApprovable', pass: manifest.artifacts.length === 0, detail: `${manifest.artifacts.length} artifact(s)` },
      { name: 'terminatesWithinLimit', pass: elapsedMs <= 2 * modelLimit(RETRY), detail: `${elapsedMs}ms` },
    ];
    return {
      id: 'FI-23', fault: 'generation interrupted by persistent provider failure', expectedSafeBehaviour: 'bounded retries, generation_failed, no candidate files to approve or run', recoverable: false,
      observed: { finalStatus: manifest.status, errorKind: gen?.outcome, attempts: gen?.attempts, retries: gen ? gen.attempts - 1 : undefined, recovered: false, executions: 0, elapsedMs, limitMs: 2 * modelLimit(RETRY) },
      checks, pass: checks.every((c) => c.pass),
    };
  } finally {
    rmSync(path.join(REPO_ROOT, policy.generationArea, manifest.runId), { recursive: true, force: true });
    rmSync(store.runDir, { recursive: true, force: true });
  }
}

/* ------------------------------- healing faults ------------------------------- */

const DRIFT_MESSAGE = "TimeoutError: locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByRole('form', { name: 'New note' }).getByRole('button', { name: 'Add note' })";
const SNAPSHOT = '- form "New note" [ref=e8]:\n  - textbox "Title" [ref=e10]\n  - button "Save note" [ref=e13]';

/** A Playwright stand-in for healing runs: scripted outcomes per run label. */
function scriptedRuns(script: Record<string, 'drift' | 'pass' | 'no-report'>) {
  return async (run: WorkspaceRun): Promise<WorkspaceRunResult> => {
    const mode = script[run.label] ?? 'pass';
    const attachments = [];
    if (mode === 'drift') {
      const rel = path.posix.join('.agent', 'heal-runs', run.label, 'error-context.md');
      mkdirSync(path.dirname(path.join(run.workspace, rel)), { recursive: true });
      writeFileSync(path.join(run.workspace, rel), `# Page snapshot\n\n\`\`\`yaml\n${SNAPSHOT}\n\`\`\`\n`);
      attachments.push({ name: 'error-context', contentType: 'text/markdown', path: rel });
    }
    const tests = mode === 'no-report' ? [] : [{
      testId: 't', title: run.title ?? 't', file: 'notes.spec.ts', project: run.project, status: mode === 'drift' ? 'timedOut' as const : 'passed' as const, durationMs: 1, retries: 0,
      attempts: [{ retry: 0, status: mode === 'drift' ? 'timedOut' : 'passed', durationMs: 1, errors: mode === 'drift' ? [{ message: DRIFT_MESSAGE }] : [], attachments }], screenshotRefs: [],
    }];
    const evidence: RunEvidence = {
      schemaVersion: 1, runId: run.label, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      environment: { targetName: 'fault', baseUrlHost: 'local', playwrightVersion: 'fault', node: process.version, platform: process.platform, ci: false },
      runner: { exitCode: mode === 'no-report' ? null : 0, timedOut: mode === 'no-report', reportFound: mode !== 'no-report', globalErrors: [], stderrTail: mode === 'no-report' ? 'killed at the wall-clock limit' : '' },
      tests,
    };
    return { summary: summarize(run, evidence, ['scripted'], 1), evidence };
  };
}

async function healingFaults(policy: Policy): Promise<FaultResult[]> {
  const target = { kind: 'trusted' as const, file: 'tests/integration/notes.spec.ts', title: 'a note added in the UI is returned by the API' };
  const page = path.join(REPO_ROOT, 'src/pages/example-app/NotesPage.ts');
  const proposal = (req: { prompt: string }) => JSON.stringify({
    decision: 'propose', failureExplanation: 'renamed', intendedBehavior: 'submit the form',
    evidenceIds: ['E2', /"id": "(E\d+)",\s*"source": "attachment\.page-snapshot"/.exec(req.prompt)?.[1] ?? 'E0'],
    changes: [{ kind: 'replaceLocator', pageObject: 'NotesPage', member: 'addNoteButton', locator: { by: 'role', role: 'button', name: 'Save note', exact: true } }],
  });
  const cases: Array<{ id: string; fault: string; expected: string; provider: MockProvider; script: Record<string, 'drift' | 'pass' | 'no-report'>; outcome: string; attempts?: number }> = [
    { id: 'FI-24', fault: 'heal proposal: provider times out on every attempt', expected: 'bounded attempts, proposal_failed, no patch, working tree untouched', provider: new MockProvider({ 'heal-proposal': [proposal, proposal, proposal] }, 1_000), script: { reproduce: 'drift' }, outcome: 'proposal_failed', attempts: RETRY.maxAttempts },
    { id: 'FI-25', fault: 'healing interrupted: the reproduction run is killed (no report)', expected: 'insufficient_evidence, no model call, no patch', provider: new MockProvider({}), script: { reproduce: 'no-report' }, outcome: 'insufficient_evidence' },
    { id: 'FI-26', fault: 'heal verification run crashes (no report)', expected: 'verification_failed, no patch', provider: new MockProvider({ 'heal-proposal': [proposal] }), script: { reproduce: 'drift', 'regression-before': 'pass', verify: 'no-report' }, outcome: 'verification_failed' },
  ];
  const results: FaultResult[] = [];
  for (const c of cases) {
    const healId = newHealId();
    const before = sha256File(page);
    const started = Date.now();
    try {
      const record = await healTest(target, { repoRoot: REPO_ROOT, policy, env: {}, provider: c.provider, healId, reproduceRuns: 1, verifyRuns: 1, retryPolicy: RETRY, runTests: scriptedRuns(c.script) });
      const elapsedMs = Date.now() - started;
      const attempts = record.usage[0]?.attempts;
      const checks = [
        { name: 'finalStatus', pass: record.outcome === c.outcome, detail: record.outcome },
        { name: 'noPatch', pass: record.patch === undefined, detail: record.patch ? record.patch.file : 'none' },
        { name: 'workingTreeUntouched', pass: sha256File(page) === before },
        { name: 'recordPreserved', pass: existsSync(path.join(healDir(REPO_ROOT, healId), 'heal-record.json')) },
        { name: 'terminatesWithinLimit', pass: elapsedMs <= 30_000 + modelLimit(RETRY), detail: `${elapsedMs}ms` },
      ];
      if (c.attempts !== undefined) checks.push({ name: 'boundedAttempts', pass: attempts === c.attempts, detail: `${attempts} attempt(s)` });
      if (c.outcome === 'insufficient_evidence') checks.push({ name: 'noModelCall', pass: c.provider.calls.length === 0, detail: `${c.provider.calls.length} call(s)` });
      results.push({
        id: c.id, fault: c.fault, expectedSafeBehaviour: c.expected, recoverable: false,
        observed: { finalStatus: record.outcome, attempts, retries: attempts === undefined ? undefined : attempts - 1, recovered: false, executions: 0, elapsedMs, limitMs: 30_000 + modelLimit(RETRY) },
        checks, pass: checks.every((x) => x.pass),
      });
    } finally {
      rmSync(healDir(REPO_ROOT, healId), { recursive: true, force: true });
    }
  }
  return results;
}

export function faultMetrics(results: FaultResult[]) {
  const recoverable = results.filter((r) => r.recoverable);
  const unrecoverable = results.filter((r) => !r.recoverable);
  const classification = results.flatMap((r) => r.checks.filter((c) => c.name === 'errorClassification').map((c) => ({ r, c })));
  return {
    scenarios: results.length,
    allExpectationsMet: ratio(countWhere(results, (r) => r.pass), results.length),
    errorClassificationCorrect: ratio(countWhere(classification, ({ c }) => c.pass), classification.length),
    recoverySuccess: ratio(countWhere(recoverable, (r) => r.observed.recovered), recoverable.length),
    meanRecoveryLatencyMs: mean(recoverable.flatMap((r) => (r.observed.recoveryLatencyMs === undefined ? [] : [r.observed.recoveryLatencyMs]))),
    retriesOnRecoverable: recoverable.map((r) => ({ id: r.id, retries: r.observed.retries })),
    unrecoverablePropagated: ratio(countWhere(unrecoverable, (r) => r.observed.finalStatus !== 'plan_valid' && !r.observed.recovered), unrecoverable.length),
    terminatedWithinLimits: ratio(countWhere(results, (r) => r.observed.elapsedMs <= r.observed.limitMs), results.length),
    duplicateExecutionPrevented: results.find((r) => r.id === 'FI-14')?.pass ?? null,
    neverPassedWithoutEvidence: results.every((r) => r.checks.find((c) => c.name === 'neverPassedWithoutEvidence')?.pass !== false),
  };
}

