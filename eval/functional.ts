import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { MockProvider } from '../src/agent/llm/mock';
import { planAndGenerate } from '../src/agent/workflow/generate';
import { recordDecision } from '../src/agent/workflow/decide';
import { executeRun } from '../src/agent/workflow/execute';
import { RunStore } from '../src/agent/workflow/store';
import { renderSpec } from '../src/agent/generation/render';
import { isAcceptableApprover } from '../src/agent/execution/approval';
import type { Policy } from '../src/agent/execution/policy';
import type { RunEvidence } from '../src/agent/domain/result';
import type { FailureAnalysis } from '../src/agent/analysis/types';
import type { UsageRecord } from '../src/agent/llm/structured';
import type { FunctionalDataset, FunctionalSuite } from './schema';
import { specHash } from './dataset';
import { assertionFindings, type AssertionFinding } from './assertions';
import type { WorkflowMeasurement } from './cost';
import { binaryConfusion, countWhere, ratio } from './metrics';
import { REPO_ROOT } from './evaluate';

/**
 * Functional evaluation on seeded defects. Each suite's candidate specs are
 * fixed, sha256-pinned dataset content (no model output is executed). They go
 * through the real Phase 2 workflow: render, static validation, human-named
 * approval, execution through the adapter against one session variant, evidence
 * and rule-based analysis.
 */
export interface FunctionalOptions {
  policy: Policy;
  /** The person authorising execution of the pinned dataset specs (AGENT_EVAL_APPROVER). */
  approver: string;
  env: NodeJS.ProcessEnv;
  /** Keep run directories (evidence, traces) after the evaluation. */
  keepRuns?: boolean;
  concurrency?: number;
  /** Restrict to some suites (by id). */
  suites?: string[];
}

export interface FunctionalCaseResult {
  suiteId: string;
  variant: string;
  scenarioId: string;
  relevantDefect: boolean;
  defectId: string | null;
  expectedTestOutcome: 'pass' | 'fail';
  /** Artifact state from the workflow: passed | failed | inconclusive | rejected | not-run. */
  observedState: string;
  testStatus?: string;
  diagnosis?: { category: string; confidence: string; sufficientEvidence: boolean };
  matchesReference: boolean | null;
  assertionFindings: AssertionFinding[];
}

export interface FunctionalWorkflowResult {
  suiteId: string;
  variant: string;
  runId: string;
  status: string;
  error?: string;
  measurement: WorkflowMeasurement;
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function runSuiteVariant(suite: FunctionalSuite, variant: string, opts: FunctionalOptions) {
  for (const spec of suite.specs) {
    if (specHash(spec) !== suite.specSha256[spec.scenarioId]) throw new Error(`${suite.id}/${spec.scenarioId}: spec does not match pinned hash`);
  }
  const plan = { requirementId: suite.requirement.id, scenarios: suite.scenarios, ambiguities: [], uncoveredAcceptanceCriteria: [] };
  const provider = new MockProvider({ 'test-plan': [JSON.stringify(plan)], 'test-generation': [JSON.stringify({ tests: suite.specs, missingCapabilities: [] })] });
  const started = Date.now();
  const generated = await planAndGenerate(suite.requirement, { repoRoot: REPO_ROOT, policy: opts.policy, provider });
  const store = new RunStore(REPO_ROOT, opts.policy.runsArea, generated.runId);
  let status: string = generated.status;
  let error: string | undefined;
  let playwrightMs: number | null = null;

  try {
    if (generated.status === 'awaiting_approval') {
      // The files must be exactly the pinned specs rendered for this run.
      for (const a of generated.artifacts.filter((x) => x.state === 'awaiting_approval')) {
        const spec = suite.specs.find((s) => s.scenarioId === a.scenarioId)!;
        if (readFileSync(path.join(REPO_ROOT, a.file), 'utf8') !== renderSpec(spec, generated.runId)) throw new Error(`${a.file} differs from the pinned spec`);
      }
      recordDecision(store, 'approved', opts.approver, `pinned dataset specs ${suite.id} (dataset sha256-verified)`);
      const executed = await executeRun(store, { policy: opts.policy, env: opts.env, variant });
      status = executed.status;
      const evidence = store.read<RunEvidence>('evidence.json');
      if (evidence) playwrightMs = Date.parse(evidence.finishedAt) - Date.parse(evidence.startedAt);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const manifest = store.manifest();
  const evidence = store.read<RunEvidence>('evidence.json');
  const analyses = store.read<FailureAnalysis[]>('analysis.json') ?? [];
  const usage = store.read<UsageRecord[]>('llm-usage.json') ?? [];
  const cases: FunctionalCaseResult[] = (suite.variants[variant] ?? []).map((ref) => {
    const artifact = manifest.artifacts.find((a) => a.scenarioId === ref.scenarioId);
    const test = evidence?.tests.find((t) => t.project === 'agent-generated' && t.scenarioId === ref.scenarioId);
    const analysis = analyses.find((a) => a.scenarioId === ref.scenarioId);
    const spec = suite.specs.find((s) => s.scenarioId === ref.scenarioId)!;
    const scenario = suite.scenarios.find((s) => s.id === ref.scenarioId);
    const observedState = artifact?.state ?? 'not-run';
    const observedOutcome = observedState === 'passed' ? 'pass' : observedState === 'failed' ? 'fail' : null;
    return {
      suiteId: suite.id,
      variant,
      scenarioId: ref.scenarioId,
      relevantDefect: ref.relevantDefect,
      defectId: ref.defectId,
      expectedTestOutcome: ref.expectedTestOutcome,
      observedState,
      testStatus: test?.status,
      diagnosis: analysis && { category: analysis.diagnosis.category, confidence: analysis.diagnosis.confidence, sufficientEvidence: analysis.diagnosis.sufficientEvidence },
      matchesReference: observedOutcome === null ? null : observedOutcome === ref.expectedTestOutcome,
      assertionFindings: assertionFindings(spec, scenario, suite.requirement),
    };
  });

  const workflow: FunctionalWorkflowResult = {
    suiteId: suite.id,
    variant,
    runId: generated.runId,
    status,
    error,
    measurement: {
      workflowId: generated.runId,
      caseId: `${suite.id}/${variant}`,
      usage,
      totalMs: Date.now() - started,
      playwrightMs,
      succeeded: status === 'executed' && !error,
    },
  };
  if (!opts.keepRuns) {
    rmSync(path.join(REPO_ROOT, opts.policy.generationArea, generated.runId), { recursive: true, force: true });
    rmSync(store.runDir, { recursive: true, force: true });
  }
  return { cases, workflow };
}

export async function evaluateFunctional(dataset: FunctionalDataset, opts: FunctionalOptions) {
  if (!isAcceptableApprover(opts.approver)) {
    throw new Error('functional evaluation executes tests: set AGENT_EVAL_APPROVER to the name of the person authorising it');
  }
  const jobs = dataset.suites
    .filter((s) => !opts.suites || opts.suites.includes(s.id))
    .flatMap((suite) => Object.keys(suite.variants).map((variant) => ({ suite, variant })));
  const results = await pool(jobs, opts.concurrency ?? 3, ({ suite, variant }) => runSuiteVariant(suite, variant, opts));
  const cases = results.flatMap((r) => r.cases);
  const workflows = results.map((r) => r.workflow);
  return { cases, workflows, metrics: functionalMetrics(cases) };
}

export function functionalMetrics(cases: FunctionalCaseResult[]) {
  const decided = (c: FunctionalCaseResult) => (c.observedState === 'passed' ? false : c.observedState === 'failed' ? true : null);
  // Detection: positive class = "a relevant seeded defect exists"; predicted positive = "the test failed".
  const detection = binaryConfusion(cases.map((c) => ({ actual: c.relevantDefect, predicted: decided(c) })), 'a relevant seeded defect exists', 'the generated test failed');
  // Diagnosis: among failed tests, positive class = "the failure is caused by a product defect"; predicted positive = analysis category product_behavior.
  const failed = cases.filter((c) => c.observedState === 'failed');
  const diagnosis = binaryConfusion(
    failed.map((c) => ({ actual: c.relevantDefect, predicted: c.diagnosis ? c.diagnosis.category === 'product_behavior' : null })),
    'the failure is caused by a seeded product defect',
    'the analysis says product_behavior',
  );
  const control = cases.filter((c) => c.variant === 'standard');
  return {
    detection,
    diagnosis,
    functional: {
      agreementWithReference: ratio(countWhere(cases, (c) => c.matchesReference === true), countWhere(cases, (c) => c.matchesReference !== null)),
      passOnDefectFreeControl: ratio(countWhere(control, (c) => c.observedState === 'passed'), control.length),
      inconclusive: countWhere(cases, (c) => c.matchesReference === null),
      falsePositiveFailures: cases.filter((c) => !c.relevantDefect && c.observedState === 'failed').map((c) => `${c.suiteId}/${c.variant}/${c.scenarioId}`),
      falseNegatives: cases.filter((c) => c.relevantDefect && c.observedState === 'passed').map((c) => `${c.suiteId}/${c.variant}/${c.scenarioId}`),
      /** Do the deterministic assertion rules flag the tests that missed defects? */
      falseNegativesFlaggedByAssertionRules: ratio(
        countWhere(cases.filter((c) => c.relevantDefect && c.observedState === 'passed'), (c) => c.assertionFindings.length > 0),
        countWhere(cases, (c) => c.relevantDefect && c.observedState === 'passed'),
      ),
    },
  };
}
