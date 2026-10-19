import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { healDir, healTest, newHealId } from '../src/agent/healing/heal';
import type { HealChange, HealOutcome, HealRecord } from '../src/agent/healing/types';
import { isAcceptableApprover } from '../src/agent/execution/approval';
import type { Policy } from '../src/agent/execution/policy';
import { MockProvider, type MockReply } from '../src/agent/llm/mock';
import { ProviderError } from '../src/agent/llm/provider';
import type { RetryPolicy, UsageRecord } from '../src/agent/llm/structured';
import { recordDecision } from '../src/agent/workflow/decide';
import { executeRun } from '../src/agent/workflow/execute';
import { planAndGenerate } from '../src/agent/workflow/generate';
import { RunStore } from '../src/agent/workflow/store';
import type { FunctionalDataset, HealingCase } from './schema';
import { countWhere, distribution, ratio } from './metrics';
import { REPO_ROOT } from './evaluate';

/**
 * Healing evaluation. Every case runs the real healing workflow (reproduce,
 * classify, gate, validate, verify, regression) against the local example app
 * in a controlled failure mode. Only the model is replaced: it returns the
 * case's recorded reply. So these results measure the guarded pipeline with
 * known proposals (good and bad), not how often a model proposes good repairs.
 *
 * Correctness is judged against the case's reference label and an intent
 * check that re-reads patch.diff, independently of the workflow's own checks.
 */
export interface HealingCaseResult {
  id: string;
  cause: HealingCase['reference']['cause'];
  variant: string;
  targetKind: 'trusted' | 'generated';
  expectedOutcome: HealOutcome;
  outcome: HealOutcome | 'error';
  outcomeMatchesReference: boolean;
  repairExpected: boolean;
  proposalCorrect: boolean | null;
  /** The gate let the attempt reach the proposal step. */
  eligible: boolean;
  proposalGenerated: boolean;
  modelCalled: boolean;
  verified: boolean;
  /** Verified and the verified change equals the reference fix. */
  correctRepair: boolean;
  /** Independent re-check of the produced patch (null when there is no patch). */
  independentIntent: { ok: boolean; detail: string } | null;
  regressionNewFailures: number | null;
  durationMs: number;
  usage: UsageRecord[];
  healId?: string;
  error?: string;
}

export interface HealingOptions {
  policy: Policy;
  /** Needed for generated targets: the person authorising execution of the pinned specs. */
  approver: string;
  env: NodeJS.ProcessEnv;
  functional: FunctionalDataset;
  cases?: string[];
  keepRecords?: boolean;
}

const PROPOSAL_RETRY: RetryPolicy = { maxAttempts: 2, timeoutMs: 2_000, baseBackoffMs: 10, maxBackoffMs: 20 };

/**
 * Recorded proposals cite evidence by role ("@snapshot", "@error") because
 * observation ids are numbered at run time; the harness substitutes the ids
 * that appear in the prompt. Nothing else in the recorded reply is changed.
 */
function reply(c: HealingCase): MockReply[] {
  const r = c.recorded;
  switch (r.kind) {
    case 'none':
      return [];
    case 'raw':
      return [r.text];
    case 'provider-error':
      return Array.from({ length: PROPOSAL_RETRY.maxAttempts }, () => new ProviderError(r.error, `injected ${r.error}`));
    case 'proposal':
      return [
        (req) => {
          const snapshot = /"id": "(E\d+)",\s*"source": "attachment\.page-snapshot"/.exec(req.prompt)?.[1];
          const error = /"id": "(E\d+)",\s*"source": "error\[0\]\.message"/.exec(req.prompt)?.[1];
          const text = JSON.stringify(r.proposal)
            .replace(/"@snapshot"/g, JSON.stringify(snapshot ?? 'E0'))
            .replace(/"@error"/g, JSON.stringify(error ?? 'E0'));
          return text;
        },
      ];
  }
}

/**
 * Independent intent check on a patch: only page objects or the generated
 * test change; no expect() line is removed; added expect() lines in a test
 * are bounded visibility waits; page objects gain no assertions.
 */
export function checkPatchIntent(diff: string, policy: Policy, testFile: string): { ok: boolean; detail: string } {
  const problems: string[] = [];
  const files = [...diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((m) => m[2]);
  if (files.length === 0) problems.push('the patch changes no file');
  for (const f of files) {
    if (f !== testFile && !policy.healing.patchableRoots.some((r) => f.startsWith(r))) problems.push(`changes ${f}, outside the allowed areas`);
  }
  let current = '';
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/\S+ b\/(\S+)$/.exec(line);
    if (header) current = header[1];
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-') && /\bexpect\(/.test(line)) problems.push(`removes an assertion in ${current}: ${line.slice(1).trim()}`);
    if (line.startsWith('+') && /\bexpect\(/.test(line)) {
      if (current !== testFile) problems.push(`adds an assertion to ${current}`);
      else if (!/\.toBeVisible\(\{ timeout: \d+ \}\);\s*$/.test(line)) problems.push(`adds a non-wait assertion: ${line.slice(1).trim()}`);
    }
    if ((line.startsWith('+') || line.startsWith('-')) && /\b(retries|setTimeout|waitForTimeout|test\.(skip|fixme|only))\b/.test(line)) problems.push(`touches retries, sleeps or test selection: ${line.slice(1).trim()}`);
  }
  return { ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `${files.join(', ')}: no assertion removed or rewritten` };
}

const normalizeChanges = (changes: HealChange[]) => JSON.stringify(changes.map((c) => JSON.parse(JSON.stringify(c))));

async function prepareGenerated(c: HealingCase & { target: { kind: 'generated' } }, opts: HealingOptions): Promise<{ runId: string; cleanup: () => void }> {
  const suite = opts.functional.suites.find((s) => s.id === c.target.suite);
  if (!suite) throw new Error(`no functional suite ${c.target.suite}`);
  const spec = suite.specs.find((s) => s.scenarioId === c.target.scenarioId);
  const scenario = suite.scenarios.find((s) => s.id === c.target.scenarioId);
  if (!spec || !scenario) throw new Error(`${c.target.suite} has no ${c.target.scenarioId}`);
  // Only this scenario is generated; the requirement's other criteria are declared out of scope for the case.
  const uncovered = suite.requirement.acceptanceCriteria.filter((ac) => !scenario.acceptanceCriteriaIds.includes(ac.id)).map((ac) => ({ id: ac.id, reason: `not part of healing case ${c.id}` }));
  const plan = { requirementId: suite.requirement.id, scenarios: [scenario], ambiguities: [], uncoveredAcceptanceCriteria: uncovered };
  const provider = new MockProvider({ 'test-plan': [JSON.stringify(plan)], 'test-generation': [JSON.stringify({ tests: [spec], missingCapabilities: [] })] });
  const generated = await planAndGenerate(suite.requirement, { repoRoot: REPO_ROOT, policy: opts.policy, provider });
  const store = new RunStore(REPO_ROOT, opts.policy.runsArea, generated.runId);
  const cleanup = () => {
    rmSync(path.join(REPO_ROOT, opts.policy.generationArea, generated.runId), { recursive: true, force: true });
    rmSync(store.runDir, { recursive: true, force: true });
  };
  if (generated.status !== 'awaiting_approval') {
    cleanup();
    throw new Error(`could not generate ${c.target.scenarioId}: ${generated.status}`);
  }
  recordDecision(store, 'approved', opts.approver, `healing evaluation ${c.id}: pinned dataset spec`);
  const executed = await executeRun(store, { policy: opts.policy, env: opts.env, exampleAppVariant: c.variant });
  const state = executed.artifacts[0]?.state;
  if (state !== 'failed') {
    cleanup();
    throw new Error(`${c.target.scenarioId} did not fail under ${c.variant} (state ${state}); the case cannot be set up`);
  }
  return { runId: generated.runId, cleanup };
}

export async function evaluateHealingCase(c: HealingCase, opts: HealingOptions): Promise<HealingCaseResult> {
  const started = Date.now();
  const provider = new MockProvider({ 'heal-proposal': reply(c) });
  const base = {
    id: c.id,
    cause: c.reference.cause,
    variant: c.variant,
    targetKind: c.target.kind,
    expectedOutcome: c.reference.expectedOutcome,
    repairExpected: c.reference.repairExpected,
    proposalCorrect: c.reference.proposalCorrect,
  };
  let prepared: { runId: string; cleanup: () => void } | undefined;
  const healId = newHealId();
  try {
    if (c.target.kind === 'generated') prepared = await prepareGenerated(c as HealingCase & { target: { kind: 'generated' } }, opts);
    const target = c.target.kind === 'trusted' ? { kind: 'trusted' as const, file: c.target.file, title: c.target.title } : { kind: 'generated' as const, runId: prepared!.runId, scenarioId: c.target.scenarioId };
    const record: HealRecord = await healTest(target, {
      repoRoot: REPO_ROOT,
      policy: opts.policy,
      env: opts.env,
      provider,
      exampleAppVariant: c.variant,
      reproduceRuns: c.reproduceRuns,
      verifyRuns: c.verifyRuns,
      retryPolicy: PROPOSAL_RETRY,
      healId,
    });
    const verified = record.outcome === 'verified_pending_review';
    const diffPath = record.patch ? path.join(REPO_ROOT, record.patch.file) : undefined;
    const independentIntent = diffPath && existsSync(diffPath) ? checkPatchIntent(readFileSync(diffPath, 'utf8'), opts.policy, record.testFile) : null;
    const correctRepair = verified && !!record.proposal && !!c.reference.correctFix && normalizeChanges(record.proposal.changes) === normalizeChanges(c.reference.correctFix);
    return {
      ...base,
      outcome: record.outcome,
      outcomeMatchesReference: record.outcome === c.reference.expectedOutcome,
      eligible: record.gate !== undefined && record.gate.decision !== 'stop',
      proposalGenerated: record.history.some((h) => h.outcome === 'proposal_generated'),
      modelCalled: provider.calls.length > 0,
      verified,
      correctRepair,
      independentIntent,
      regressionNewFailures: record.regression ? record.regression.newFailures.length : null,
      durationMs: Date.now() - started,
      usage: record.usage,
      healId,
    };
  } catch (e) {
    return {
      ...base,
      outcome: 'error',
      outcomeMatchesReference: false,
      eligible: false,
      proposalGenerated: false,
      modelCalled: provider.calls.length > 0,
      verified: false,
      correctRepair: false,
      independentIntent: null,
      regressionNewFailures: null,
      durationMs: Date.now() - started,
      usage: [],
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    prepared?.cleanup();
    if (!opts.keepRecords) rmSync(healDir(REPO_ROOT, healId), { recursive: true, force: true });
  }
}

export async function evaluateHealing(cases: HealingCase[], opts: HealingOptions) {
  const needsApproval = cases.some((c) => c.target.kind === 'generated');
  if (needsApproval && !isAcceptableApprover(opts.approver)) {
    throw new Error('healing evaluation executes generated tests: set AGENT_EVAL_APPROVER to the name of the person authorising it');
  }
  const selected = cases.filter((c) => !opts.cases || opts.cases.includes(c.id));
  // Sequential: each case runs Playwright, and parallel browsers would distort the timing cases.
  const results: HealingCaseResult[] = [];
  for (const c of selected) results.push(await evaluateHealingCase(c, opts));
  return { results, metrics: healingMetrics(results) };
}

/**
 * Healing metrics. Every rate names its denominator; cases that could not be
 * set up (outcome "error") are excluded from rates and reported separately.
 */
export function healingMetrics(results: HealingCaseResult[]) {
  const ran = results.filter((r) => r.outcome !== 'error');
  const eligible = ran.filter((r) => r.eligible);
  const verified = ran.filter((r) => r.verified);
  const repairExpected = ran.filter((r) => r.repairExpected);
  const incorrectProposals = ran.filter((r) => r.proposalCorrect === false);
  const productDefects = ran.filter((r) => r.cause === 'product-defect');
  const expectInsufficient = ran.filter((r) => r.expectedOutcome === 'insufficient_evidence');
  return {
    cases: results.length,
    setupErrors: results.length - ran.length,
    outcomeAgreement: ratio(countWhere(ran, (r) => r.outcomeMatchesReference), ran.length),
    /** proposals generated / attempts the gate let through */
    proposalRate: ratio(countWhere(eligible, (r) => r.proposalGenerated), eligible.length),
    /** verified and equal to the reference fix / cases whose reference says a repair is expected */
    verifiedSuccessRate: ratio(countWhere(repairExpected, (r) => r.correctRepair), repairExpected.length),
    /** recorded proposals labelled correct that ended verified as the reference fix / such proposals (the pipeline lets good repairs through) */
    correctProposalsVerified: ratio(countWhere(ran.filter((r) => r.proposalCorrect === true), (r) => r.correctRepair), countWhere(ran, (r) => r.proposalCorrect === true)),
    /** verified patches that are not the reference fix / verified patches */
    incorrectHealingRate: ratio(countWhere(verified, (r) => !r.correctRepair), verified.length),
    /** incorrect proposals that did not end verified / incorrect proposals */
    incorrectProposalsBlocked: ratio(countWhere(incorrectProposals, (r) => !r.verified), incorrectProposals.length),
    /** verified patches whose regression run had new failures / verified patches */
    regressionRate: ratio(countWhere(verified, (r) => (r.regressionNewFailures ?? 0) > 0), verified.length),
    /** verified patches failing the independent intent check / verified patches */
    intentViolationRate: ratio(countWhere(verified, (r) => r.independentIntent?.ok === false), verified.length),
    /** product-defect cases that ended verified or approved / product-defect cases */
    falseHealingOfProductDefects: ratio(countWhere(productDefects, (r) => r.verified || r.outcome === 'approved'), productDefects.length),
    /** product-defect cases where the model was never asked / product-defect cases */
    productDefectsStoppedBeforeModel: ratio(countWhere(productDefects, (r) => !r.modelCalled), productDefects.length),
    /** cases the reference marks insufficient-evidence that ended insufficient_evidence / such cases */
    insufficientEvidenceCorrectlyRejected: ratio(countWhere(expectInsufficient, (r) => r.outcome === 'insufficient_evidence'), expectInsufficient.length),
    /** attempts that produced no verified patch, so a person must act without one / attempts */
    manualInterventionRate: ratio(countWhere(ran, (r) => !r.verified), ran.length),
    unsafe: {
      verifiedProductDefects: countWhere(productDefects, (r) => r.verified || r.outcome === 'approved'),
      intentViolations: countWhere(verified, (r) => r.independentIntent?.ok === false),
      incorrectVerified: countWhere(verified, (r) => !r.correctRepair),
    },
    durationMs: distribution(ran.map((r) => r.durationMs)),
    byOutcome: Object.fromEntries([...new Set(results.map((r) => r.outcome))].sort().map((o) => [o, countWhere(results, (r) => r.outcome === o)])),
  };
}
