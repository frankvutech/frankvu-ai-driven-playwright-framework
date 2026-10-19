import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assessRequirement, RequirementSchema, type Requirement, type RequirementAssessment } from '../domain/requirement';
import { TestPlanSchema, validatePlan, type PlanValidation, type Scenario, type TestPlan } from '../domain/plan';
import { GenerationOutputSchema, type GenerationOutput, type TestSpec } from '../domain/testSpec';
import { transition, type ArtifactRecord } from '../domain/state';
import type { LlmProvider } from '../llm/provider';
import { callStructured, DEFAULT_RETRY_POLICY, type RetryPolicy, type UsageRecord } from '../llm/structured';
import { PLAN_SYSTEM, planPrompt } from '../prompts/plan';
import { GENERATE_SYSTEM, generatePrompt } from '../prompts/generate';
import { validateSpec, type SpecIssue } from '../generation/validateSpec';
import { FAMILY_SUFFIX, familyOf, renderSpec } from '../generation/render';
import { validateArtifacts, workspaceSnapshot, type ArtifactValidation } from '../validation/artifacts';
import { sha256File } from '../execution/files';
import type { Policy } from '../execution/policy';
import { newRunId, RunStore, type RunManifest, type StepRecord } from './store';
import { writeReport } from './report';

export interface GenerateDeps {
  repoRoot: string;
  policy: Policy;
  provider: LlmProvider;
  retryPolicy?: RetryPolicy;
  now?: () => Date;
  runId?: string;
  /** Workspace snapshot hook; replaced in unit tests that run outside git. */
  snapshot?: (repoRoot: string, ignored: string[]) => string[];
}

export interface Ambiguities {
  requirementFindings: RequirementAssessment['issues'];
  planAmbiguities: string[];
  openQuestions: Array<{ scenarioId: string; question: string }>;
  assumptions: Array<{ scenarioId: string; assumption: string }>;
  assumptionOnlyScenarios: string[];
  uncoveredAcceptanceCriteria: TestPlan['uncoveredAcceptanceCriteria'];
  missingCapabilities: Array<{ scenarioId: string; description: string; proposedObject: string }>;
}

export type PlanOutcome =
  | { outcome: 'invalid_requirement'; errors: string[] }
  | { outcome: 'needs_clarification'; req: Requirement; assessment: RequirementAssessment }
  | { outcome: 'plan_failed'; req: Requirement; assessment: RequirementAssessment; kind: string; detail: string; usage: UsageRecord }
  | { outcome: 'plan_rejected' | 'plan_valid'; req: Requirement; assessment: RequirementAssessment; plan: TestPlan; check: PlanValidation; usage: UsageRecord };

/** Steps 2-4: validate the requirement, ask for a plan, validate the plan. */
export async function planRequirement(input: unknown, provider: LlmProvider, retry: RetryPolicy = DEFAULT_RETRY_POLICY): Promise<PlanOutcome> {
  const parsed = RequirementSchema.safeParse(input);
  if (!parsed.success) {
    return { outcome: 'invalid_requirement', errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const req = parsed.data;
  const assessment = assessRequirement(req);
  if (!assessment.ready) return { outcome: 'needs_clarification', req, assessment };

  const planned = await callStructured(
    provider,
    { useCase: 'test-plan', system: PLAN_SYSTEM, prompt: planPrompt(req, assessment), maxTokens: 16000 },
    TestPlanSchema,
    retry,
  );
  if (!planned.ok) return { outcome: 'plan_failed', req, assessment, kind: planned.kind, detail: planned.detail, usage: planned.usage };
  const check = validatePlan(planned.value, req, assessment);
  return { outcome: check.valid ? 'plan_valid' : 'plan_rejected', req, assessment, plan: planned.value, check, usage: planned.usage };
}

export type SpecOutcome =
  | { ok: false; kind: string; detail: string; usage: UsageRecord }
  | { ok: true; output: GenerationOutput; accepted: TestSpec[]; issues: Record<string, SpecIssue[]>; usage: UsageRecord };

/** Step 6 (model part): ask for specs and check each against the catalog. */
export async function generateSpecs(
  req: Requirement,
  scenarios: Scenario[],
  provider: LlmProvider,
  retry: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<SpecOutcome> {
  const generated = await callStructured(
    provider,
    { useCase: 'test-generation', system: GENERATE_SYSTEM, prompt: generatePrompt(req, scenarios), maxTokens: 16000 },
    GenerationOutputSchema,
    retry,
  );
  if (!generated.ok) return { ok: false, kind: generated.kind, detail: generated.detail, usage: generated.usage };
  const allowed = new Set(scenarios.map((s) => s.id));
  const seen = new Set<string>();
  const issues: Record<string, SpecIssue[]> = {};
  const accepted: TestSpec[] = [];
  const layers = new Map(scenarios.map((s) => [s.id, s.layer]));
  for (const spec of generated.value.tests) {
    const found = validateSpec(spec, allowed, req.id, { application: req.application, layers });
    if (seen.has(spec.scenarioId)) found.push({ code: 'unknown_scenario', severity: 'error', message: 'more than one spec for this scenario' });
    seen.add(spec.scenarioId);
    issues[spec.scenarioId] = [...(issues[spec.scenarioId] ?? []), ...found];
    if (!found.some((i) => i.severity === 'error')) accepted.push(spec);
  }
  return { ok: true, output: generated.value, accepted, issues, usage: generated.usage };
}

/**
 * Workflow steps 1-8: requirement -> plan -> candidate tests -> validation ->
 * awaiting human approval. It never executes anything and never approves.
 */
export async function planAndGenerate(input: unknown, deps: GenerateDeps): Promise<RunManifest> {
  const now = deps.now ?? (() => new Date());
  const retry = deps.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const reqId = typeof input === 'object' && input && typeof (input as { id?: unknown }).id === 'string' && /^[A-Z][A-Z0-9]*-\d+$/.test((input as { id: string }).id)
    ? (input as { id: string }).id
    : 'INVALID-0';
  const runId = deps.runId ?? newRunId(reqId, now());
  const store = new RunStore(deps.repoRoot, deps.policy.runsArea, runId);
  const steps: StepRecord[] = [];
  const usage: UsageRecord[] = [];
  const step = (name: string, status: StepRecord['status'], detail?: string) => steps.push({ step: name, status, at: now().toISOString(), detail });
  const manifest: RunManifest = {
    runId,
    status: 'invalid_requirement',
    createdAt: now().toISOString(),
    provider: { name: deps.provider.name, model: deps.provider.model },
    steps,
    artifacts: [],
  };
  const finish = (status: RunManifest['status']) => {
    manifest.status = status;
    store.write('manifest.json', manifest);
    store.write('llm-usage.json', usage);
    writeReport(store);
    return manifest;
  };

  // 1. Receive.
  store.write('requirement.input.json', input);
  step('receive', 'ok');

  // 2-4. Validate the requirement, plan, validate the plan.
  const planned = await planRequirement(input, deps.provider, retry);
  if (planned.outcome === 'invalid_requirement') {
    store.write('requirement.errors.json', planned.errors);
    step('validate-requirement', 'failed', planned.errors.join('; '));
    return finish('invalid_requirement');
  }
  const { req, assessment } = planned;
  manifest.requirementId = req.id;
  store.write('requirement.json', req);
  store.write('assessment.json', assessment);
  if (planned.outcome === 'needs_clarification') {
    step('validate-requirement', 'failed', 'blocking issues; clarification needed before planning');
    store.write('ambiguities.json', emptyAmbiguities(assessment));
    return finish('needs_clarification');
  }
  step('validate-requirement', 'ok', `${assessment.issues.length} warning(s)`);
  usage.push(planned.usage);
  if (planned.outcome === 'plan_failed') {
    step('plan', 'failed', `${planned.kind}: ${planned.detail}`);
    return finish('plan_failed');
  }
  const { plan, check: planCheck } = planned;
  store.write('plan.json', plan);
  step('plan', 'ok', `${plan.scenarios.length} scenario(s)`);
  store.write('plan.validation.json', planCheck);
  if (planned.outcome === 'plan_rejected') {
    step('validate-plan', 'failed', planCheck.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; '));
    store.write('ambiguities.json', ambiguitiesFrom(assessment, plan, planCheck, []));
    return finish('plan_rejected');
  }
  step('validate-plan', 'ok', `coverage ${planCheck.coverage.covered.length}/${req.acceptanceCriteria.length}`);

  // 5. Surface ambiguities and assumptions (assumption-only scenarios are not generated).
  const traceable = plan.scenarios.filter((s) => planCheck.traceableScenarioIds.includes(s.id)).slice(0, deps.policy.maxScenariosPerRun);
  step('surface-ambiguities', 'ok');

  // 6. Generate candidate specs.
  const snapshot = deps.snapshot ?? workspaceSnapshot;
  const ignored = [`${deps.policy.generationArea}/`, `${deps.policy.runsArea}/`];
  const workspaceBefore = snapshot(deps.repoRoot, ignored);
  const generated = await generateSpecs(req, traceable, deps.provider, retry);
  usage.push(generated.usage);
  if (!generated.ok) {
    step('generate', 'failed', `${generated.kind}: ${generated.detail}`);
    store.write('ambiguities.json', ambiguitiesFrom(assessment, plan, planCheck, []));
    return finish('generation_failed');
  }
  store.write('generation.json', generated.output);
  store.write('ambiguities.json', ambiguitiesFrom(assessment, plan, planCheck, generated.output.missingCapabilities));

  const specIssues = generated.issues;
  const genDir = path.join(deps.repoRoot, deps.policy.generationArea, runId);
  const toValidate: Record<string, { requirementId: string; scenarioId: string }> = {};
  for (const spec of generated.output.tests) {
    const file = path.posix.join(deps.policy.generationArea, runId, `${spec.scenarioId}${FAMILY_SUFFIX[familyOf(req.application, spec.layer)]}`);
    if (!generated.accepted.includes(spec)) {
      manifest.artifacts.push(
        transition(blankRecord(spec.scenarioId, req.id, file), 'rejected', { kind: 'agent' }, 'spec failed catalog validation', now()),
      );
      continue;
    }
    mkdirSync(genDir, { recursive: true });
    writeFileSync(path.join(deps.repoRoot, file), renderSpec(spec, runId, { application: req.application }));
    manifest.artifacts.push({ ...blankRecord(spec.scenarioId, req.id, file), sha256: sha256File(path.join(deps.repoRoot, file)) });
    toValidate[file] = { requirementId: req.id, scenarioId: spec.scenarioId };
  }
  store.write('spec.validation.json', specIssues);
  step('generate', 'ok', `${Object.keys(toValidate).length} candidate file(s), ${manifest.artifacts.length - Object.keys(toValidate).length} rejected spec(s)`);

  // 7. Validate generated artifacts.
  const validation: ArtifactValidation = await validateArtifacts({
    repoRoot: deps.repoRoot,
    generationArea: deps.policy.generationArea,
    files: toValidate,
    workspaceBefore,
    workspaceAfter: snapshot(deps.repoRoot, ignored),
  });
  store.write('artifact.validation.json', validation);
  manifest.artifacts = manifest.artifacts.map((a) => {
    if (a.state !== 'proposed') return a;
    const findings = validation.files[a.file] ?? [];
    if (findings.length > 0 || validation.workspace.length > 0) {
      return transition(a, 'rejected', { kind: 'agent' }, `static validation failed: ${findings.map((f) => f.message).join('; ') || 'workspace changed'}`, now());
    }
    // 8. Ready for a human decision.
    return transition(transition(a, 'validated', { kind: 'agent' }, `checks passed: ${validation.checksRun.join(', ')}`, now()), 'awaiting_approval', { kind: 'agent' }, 'awaiting human review', now());
  });
  step('validate-artifacts', validation.ok ? 'ok' : 'failed', validation.ok ? undefined : 'see artifact.validation.json');

  const waiting = manifest.artifacts.filter((a) => a.state === 'awaiting_approval').length;
  step('request-approval', waiting > 0 ? 'ok' : 'skipped', `${waiting} artifact(s) awaiting approval`);
  return finish(waiting > 0 ? 'awaiting_approval' : 'nothing_to_execute');
}

function blankRecord(scenarioId: string, requirementId: string, file: string): ArtifactRecord {
  return { scenarioId, requirementId, file, sha256: '', state: 'proposed', history: [] };
}

function emptyAmbiguities(assessment: RequirementAssessment): Ambiguities {
  return {
    requirementFindings: assessment.issues,
    planAmbiguities: [],
    openQuestions: [],
    assumptions: [],
    assumptionOnlyScenarios: [],
    uncoveredAcceptanceCriteria: [],
    missingCapabilities: [],
  };
}

function ambiguitiesFrom(
  assessment: RequirementAssessment,
  plan: TestPlan,
  check: PlanValidation,
  missing: Ambiguities['missingCapabilities'],
): Ambiguities {
  return {
    requirementFindings: assessment.issues,
    planAmbiguities: plan.ambiguities,
    openQuestions: plan.scenarios.flatMap((s) => s.openQuestions.map((question) => ({ scenarioId: s.id, question }))),
    assumptions: plan.scenarios.flatMap((s) => s.assumptions.map((assumption) => ({ scenarioId: s.id, assumption }))),
    assumptionOnlyScenarios: check.assumptionScenarioIds,
    uncoveredAcceptanceCriteria: plan.uncoveredAcceptanceCriteria,
    missingCapabilities: missing,
  };
}
