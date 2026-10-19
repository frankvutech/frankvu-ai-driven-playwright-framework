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
  for (const f of execFaults) results.push(await executionFault(f, policy));
  return { results, metrics: faultMetrics(results) };
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

