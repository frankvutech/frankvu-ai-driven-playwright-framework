import type { Requirement } from '../domain/requirement';
import type { TestPlan } from '../domain/plan';
import { recordOutcome, transition } from '../domain/state';
import type { LlmProvider } from '../llm/provider';
import type { UsageRecord } from '../llm/structured';
import { readApproval } from '../execution/approval';
import { agentProjectFor, executeApproved, type Spawner } from '../execution/adapter';
import type { Policy } from '../execution/policy';
import { collectEvidence } from '../evidence/collect';
import { knownSecrets } from '../evidence/redact';
import { classifyFailure } from '../analysis/classify';
import { refineWithModel } from '../analysis/modelAnalysis';
import type { FailureAnalysis } from '../analysis/types';
import type { RunManifest, RunStore } from './store';
import { writeReport } from './report';

export interface ExecuteDeps {
  policy: Policy;
  env: NodeJS.ProcessEnv;
  spawner?: Spawner;
  /** Optional model for advisory failure analysis. Rule-based analysis always runs. */
  analysisProvider?: LlmProvider;
  /** Session variant from the policy (default "standard"). */
  variant?: string;
  /** Example-app failure mode from the policy (default "standard"). */
  exampleAppVariant?: string;
  now?: () => Date;
}

/**
 * Workflow steps 9-12: run approved tests with Playwright, collect evidence,
 * analyse failures, write the final report. Runs at most once per run.
 */
export async function executeRun(store: RunStore, deps: ExecuteDeps): Promise<RunManifest> {
  const now = deps.now ?? (() => new Date());
  const manifest = store.manifest();
  const step = (name: string, status: 'ok' | 'failed' | 'skipped', detail?: string) =>
    manifest.steps.push({ step: name, status, at: now().toISOString(), detail });
  const save = () => {
    store.write('manifest.json', manifest);
    writeReport(store);
    return manifest;
  };

  if (manifest.status !== 'approved_for_execution') {
    // Refuse without changing the run's state: a run awaiting approval stays approvable.
    step('execute', 'failed', `refused: run is ${manifest.status}, not approved_for_execution`);
    return save();
  }

  const result = await executeApproved({
    repoRoot: store.repoRoot,
    runId: manifest.runId,
    runDir: store.runDir,
    artifacts: manifest.artifacts,
    approval: readApproval(store.runDir),
    policy: deps.policy,
    env: deps.env,
    spawner: deps.spawner,
    variant: deps.variant,
    exampleAppVariant: deps.exampleAppVariant,
  });

  if (!result.executed) {
    store.write('execution.refusal.json', result.refusals);
    step('execute', 'failed', `refused: ${result.refusals.join('; ')}`);
    manifest.status = 'execution_refused';
    return save();
  }

  manifest.artifacts = manifest.artifacts.map((a) =>
    a.state === 'approved' ? transition(a, 'executed', { kind: 'runner' }, `Playwright Test run (exit ${result.spawn.exitCode})`, now()) : a,
  );
  step('execute', 'ok', `exit code ${result.spawn.exitCode}${result.spawn.timedOut ? ', stopped at time limit' : ''}`);

  const secrets = knownSecrets(deps.env);
  const evidence = collectEvidence({
    runId: manifest.runId,
    repoRoot: store.repoRoot,
    reportPath: result.reportPath,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    target: result.target,
    sessionVariant: result.variant,
    exampleAppVariant: result.exampleAppVariant,
    runner: { exitCode: result.spawn.exitCode, timedOut: result.spawn.timedOut, stderr: result.spawn.stderr },
    secrets,
  });
  store.write('evidence.json', evidence);
  step('collect-evidence', evidence.runner.reportFound ? 'ok' : 'failed', `${evidence.tests.length} test result(s)`);

  manifest.artifacts = manifest.artifacts.map((a) => {
    if (a.state !== 'executed') return a;
    const fileName = a.file.split('/').pop()!;
    const match = evidence.tests.find((t) => t.project === agentProjectFor(a.file) && t.scenarioId === a.scenarioId && (t.file === fileName || t.file.endsWith(`/${fileName}`)));
    return recordOutcome(a, match, now());
  });

  const req = store.read<Requirement>('requirement.json');
  const plan = store.read<TestPlan>('plan.json');
  const analyses: FailureAnalysis[] = [];
  const usage = store.read<UsageRecord[]>('llm-usage.json') ?? [];
  for (const test of evidence.tests.filter((t) => t.status === 'failed' || t.status === 'timedOut' || t.status === 'interrupted')) {
    const scenario = plan?.scenarios.find((s) => s.id === test.scenarioId);
    const acs = req?.acceptanceCriteria.filter((ac) => scenario?.acceptanceCriteriaIds.includes(ac.id)) ?? [];
    let analysis = classifyFailure(test, { acceptanceCriteriaText: acs.map((a) => a.text).join('\n'), repoRoot: store.repoRoot }, evidence);
    if (deps.analysisProvider) {
      const refined = await refineWithModel(deps.analysisProvider, analysis, { scenario, acceptanceCriteria: acs });
      analysis = refined.analysis;
      usage.push(refined.usage);
    }
    analyses.push(analysis);
  }
  store.write('analysis.json', analyses);
  store.write('llm-usage.json', usage);
  step('analyse-failures', 'ok', `${analyses.length} failure(s) analysed`);

  manifest.status = 'executed';
  step('report', 'ok');
  return save();
}
