import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { LlmProvider } from '../src/agent/llm/provider';
import { MockProvider } from '../src/agent/llm/mock';
import type { RetryPolicy, UsageRecord } from '../src/agent/llm/structured';
import { planRequirement, generateSpecs } from '../src/agent/workflow/generate';
import { renderSpec } from '../src/agent/generation/render';
import { validateArtifacts } from '../src/agent/validation/artifacts';
import type { TestSpec } from '../src/agent/domain/testSpec';
import type { Requirement } from '../src/agent/domain/requirement';
import type { Scenario } from '../src/agent/domain/plan';
import { collectEvidence } from '../src/agent/evidence/collect';
import { RunEvidenceSchema, type TestEvidence } from '../src/agent/domain/result';
import { recordOutcome, type ArtifactRecord } from '../src/agent/domain/state';
import { classifyFailure } from '../src/agent/analysis/classify';
import { refineWithModel } from '../src/agent/analysis/modelAnalysis';
import type { FailureAnalysis } from '../src/agent/analysis/types';
import { assertionFindings, type AssertionFinding } from './assertions';
import { clarificationBehaviour, prohibitedAssumptionHits, requiredAssertionCoverage } from './semantic';
import { ASSERTION_WEAKNESSES, type FailureCase, type FailureLabel, type GenerationCase, type PlanningCase } from './schema';
import { DATASET_DIR } from './dataset';
import { countWhere, mean, perClass, ratio, confusion } from './metrics';

export const REPO_ROOT = path.resolve(__dirname, '..');
export const FAST_RETRY: RetryPolicy = { maxAttempts: 1, timeoutMs: 10_000, baseBackoffMs: 0, maxBackoffMs: 0 };

export type CheckDimension = 'structural' | 'semantic' | 'reference';
export interface Check {
  name: string;
  dimension: CheckDimension;
  pass: boolean;
  detail?: string;
}

export function recordedProvider(useCase: string, output: unknown): MockProvider {
  if (output === null || output === undefined) return new MockProvider({});
  return new MockProvider({ [useCase]: [typeof output === 'string' ? output : JSON.stringify(output)] });
}

/* ------------------------------ planning ------------------------------ */

export interface PlanningResult {
  id: string;
  category: string;
  outcome: string;
  checks: Check[];
  /** All dataset expectations met. In deterministic mode this checks the evaluator and validators. */
  pass: boolean;
  coverage?: number;
  scenarios?: { total: number; traceable: number; types: string[] };
  flaggedAmbiguity: boolean;
  prohibitedHits: Array<{ scenarioId: string; phrase: string }>;
  clarificationOk: boolean;
  modelCalls: number;
  usage?: UsageRecord;
  /** The validated plan, when one was produced (used by live mode to generate from the same plan). */
  planned?: { requirement: Requirement; traceableScenarios: Scenario[] };
  /** Reference-based properties the agent's own validators do not check. */
  semantic: { requiredCoverage?: boolean; scenarioTypes?: boolean; prohibited: boolean; clarification: { ok: boolean; detail: string } };
}

export async function evaluatePlanningCase(c: PlanningCase, provider: LlmProvider & { calls?: unknown[] }, retry = FAST_RETRY): Promise<PlanningResult> {
  const r = await planRequirement(c.requirement, provider, retry);
  const e = c.expected;
  const checks: Check[] = [];
  const modelCalls = provider.calls?.length ?? -1;
  const add = (name: string, dimension: CheckDimension, pass: boolean, detail?: string) => checks.push({ name, dimension, pass, detail });

  add('outcome', 'structural', r.outcome === e.outcome, `expected ${e.outcome}, got ${r.outcome}`);
  if (e.modelCalls !== undefined) add('modelCalls', 'structural', modelCalls === e.modelCalls, String(modelCalls));
  if (e.failureKind) add('failureKind', 'structural', r.outcome === 'plan_failed' && r.kind === e.failureKind, r.outcome === 'plan_failed' ? r.kind : '-');
  const reqCodes: string[] = 'assessment' in r ? r.assessment.issues.map((i) => i.code) : [];
  for (const code of e.requirementIssueCodes ?? []) add(`requirementIssue:${code}`, 'structural', reqCodes.includes(code));

  let coverage: number | undefined;
  let scenarios: PlanningResult['scenarios'];
  let planCodes: string[] = [];
  let raised = 0;
  let prohibitedHits: PlanningResult['prohibitedHits'] = [];
  const plan = r.outcome === 'plan_valid' || r.outcome === 'plan_rejected' ? r.plan : undefined;
  if (r.outcome === 'plan_valid' || r.outcome === 'plan_rejected') {
    planCodes = r.check.issues.map((i) => i.code);
    raised = r.plan.ambiguities.length + r.plan.scenarios.reduce((n, s) => n + s.openQuestions.length, 0);
    coverage = r.req.acceptanceCriteria.length ? r.check.coverage.covered.length / r.req.acceptanceCriteria.length : 1;
    scenarios = { total: r.plan.scenarios.length, traceable: r.check.traceableScenarioIds.length, types: [...new Set(r.plan.scenarios.map((s) => s.type))] };
    if (e.coverage !== undefined) add('coverage', 'structural', coverage >= e.coverage, coverage.toFixed(2));
    for (const code of e.issueCodes ?? []) add(`planIssue:${code}`, 'structural', planCodes.includes(code));
    for (const code of e.absentIssueCodes ?? []) add(`noPlanIssue:${code}`, 'structural', !planCodes.includes(code));
    for (const id of e.assumptionScenarios ?? []) add(`assumptionScenario:${id}`, 'structural', r.check.assumptionScenarioIds.includes(id));
    prohibitedHits = prohibitedAssumptionHits(r.plan, e.prohibitedAssumptions ?? []);
  } else {
    for (const code of e.issueCodes ?? []) add(`planIssue:${code}`, 'structural', false, 'no plan');
  }

  // Semantic properties against the reference (not checked by the agent's own validators).
  const semantic = {
    requiredCoverage: e.requiredCoverage === undefined ? undefined : (coverage ?? 0) >= e.requiredCoverage,
    scenarioTypes: e.scenarioTypes?.every((t) => scenarios?.types.includes(t)),
    prohibited: prohibitedHits.length === 0,
    clarification: clarificationBehaviour(e.expectedClarification, r.outcome, plan, e.mustDeclareUncovered),
  };

  const flaggedAmbiguity = reqCodes.includes('missing_acceptance_criteria') || raised > 0 || planCodes.includes('ambiguity_not_surfaced');
  if (e.flagsAmbiguity) add('flagsAmbiguity', 'structural', flaggedAmbiguity);

  return {
    id: c.id,
    category: c.category,
    outcome: r.outcome,
    checks,
    pass: checks.every((x) => x.pass),
    coverage,
    scenarios,
    flaggedAmbiguity,
    prohibitedHits,
    clarificationOk: semantic.clarification.ok,
    modelCalls,
    usage: 'usage' in r ? r.usage : undefined,
    planned: r.outcome === 'plan_valid' ? { requirement: r.req, traceableScenarios: r.plan.scenarios.filter((s) => r.check.traceableScenarioIds.includes(s.id)) } : undefined,
    semantic,
  };
}

export function planningMetrics(cases: PlanningCase[], results: PlanningResult[]) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const withPlan = results.filter((r) => r.scenarios);
  const valid = results.filter((r) => r.outcome === 'plan_valid');
  const ambiguity = results.filter((r) => byId.get(r.id)?.expected.flagsAmbiguity);
  const unsupported = results.filter((r) => byId.get(r.id)?.expected.unsupportedAssumption);
  const reqCov = results.filter((r) => r.semantic.requiredCoverage !== undefined);
  const types = results.filter((r) => r.semantic.scenarioTypes !== undefined);
  const withProhibited = results.filter((r) => (byId.get(r.id)?.expected.prohibitedAssumptions?.length ?? 0) > 0 && r.scenarios);
  const clar = results.filter((r) => byId.get(r.id)?.expected.expectedClarification !== 'none');
  return {
    structural: {
      expectationsMet: ratio(countWhere(results, (r) => r.pass), results.length),
      outcomeAccuracy: ratio(countWhere(results, (r) => r.checks.find((c) => c.name === 'outcome')?.pass === true), results.length),
      scenarioTraceability: ratio(withPlan.reduce((n, r) => n + r.scenarios!.traceable, 0), withPlan.reduce((n, r) => n + r.scenarios!.total, 0)),
      meanCoverageOfValidPlans: mean(valid.map((r) => r.coverage ?? 0)),
      ambiguityDetection: ratio(countWhere(ambiguity, (r) => r.flaggedAmbiguity), ambiguity.length),
      unsupportedAssumptionRejection: ratio(countWhere(unsupported, (r) => r.outcome === 'plan_rejected'), unsupported.length),
    },
    semantic: {
      requiredCoverageMet: ratio(countWhere(reqCov, (r) => r.semantic.requiredCoverage === true), reqCov.length),
      expectedScenarioCategoriesPresent: ratio(countWhere(types, (r) => r.semantic.scenarioTypes === true), types.length),
      plansFreeOfProhibitedAssumptions: ratio(countWhere(withProhibited, (r) => r.semantic.prohibited), withProhibited.length),
      clarificationBehaviourCorrect: ratio(countWhere(clar, (r) => r.semantic.clarification.ok), clar.length),
    },
  };
}

/* ----------------------------- generation ----------------------------- */

export interface RenderedResult {
  scenarioId: string;
  typecheckClean: boolean;
  conventionClean: boolean;
  traceable: boolean;
  titlePreserved: boolean;
}

export interface GenerationResult {
  id: string;
  category: string;
  schemaValid: boolean;
  checks: Check[];
  pass: boolean;
  rendered: RenderedResult[];
  specDecisions: { correct: number; total: number };
  assertionFindings: AssertionFinding[];
  ruleVsLabel: Array<{ scenarioId: string; labelled: string[]; predicted: string[] }>;
  requiredAssertions: { required: number; satisfied: number; missing: string[] };
  usage?: UsageRecord;
}

export function parsedTestTitle(source: string): string | undefined {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.ES2022, true);
  for (const st of sf.statements) {
    if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) && ts.isIdentifier(st.expression.expression) && st.expression.expression.text === 'test') {
      const first = st.expression.arguments[0];
      if (first && ts.isStringLiteral(first)) return first.text;
    }
  }
  return undefined;
}

/** Render accepted specs into a scratch folder and run Phase 2's artifact validation on them. */
export async function renderAndValidate(specs: TestSpec[], scratchId: string): Promise<RenderedResult[]> {
  if (specs.length === 0) return [];
  const dir = path.join('generated', scratchId);
  const files: Record<string, { requirementId: string; scenarioId: string }> = {};
  mkdirSync(path.join(REPO_ROOT, dir), { recursive: true });
  try {
    for (const spec of specs) {
      const rel = path.posix.join('generated', scratchId, `${spec.scenarioId}.spec.ts`);
      writeFileSync(path.join(REPO_ROOT, rel), renderSpec(spec, scratchId));
      files[rel] = { requirementId: spec.requirementId, scenarioId: spec.scenarioId };
    }
    const v = await validateArtifacts({ repoRoot: REPO_ROOT, generationArea: 'generated', files, workspaceBefore: [], workspaceAfter: [] });
    return specs.map((spec) => {
      const rel = path.posix.join('generated', scratchId, `${spec.scenarioId}.spec.ts`);
      const findings = v.files[rel] ?? [];
      return {
        scenarioId: spec.scenarioId,
        typecheckClean: !findings.some((f) => f.check === 'typecheck'),
        conventionClean: !findings.some((f) => ['ast', 'lint', 'convention', 'path'].includes(f.check)),
        traceable: !findings.some((f) => f.message.includes('annotation')),
        titlePreserved: parsedTestTitle(readFileSync(path.join(REPO_ROOT, rel), 'utf8')) === spec.title,
      };
    });
  } finally {
    rmSync(path.join(REPO_ROOT, dir), { recursive: true, force: true });
  }
}

export async function evaluateGenerationCase(c: GenerationCase, provider: LlmProvider, scratchId: string, retry = FAST_RETRY): Promise<GenerationResult> {
  const out = await generateSpecs(c.requirement, c.scenarios, provider, retry);
  const e = c.expected;
  const checks: Check[] = [];
  const add = (name: string, dimension: CheckDimension, pass: boolean, detail?: string) => checks.push({ name, dimension, pass, detail });
  const empty = { rendered: [], specDecisions: { correct: 0, total: 0 }, assertionFindings: [], ruleVsLabel: [], requiredAssertions: { required: 0, satisfied: 0, missing: [] } };

  if (!out.ok) {
    add('failureKind', 'structural', out.kind === e.failureKind, out.kind);
    return { id: c.id, category: c.category, schemaValid: false, checks, pass: checks.every((x) => x.pass), ...empty, usage: out.usage };
  }
  if (e.failureKind) add('failureKind', 'structural', false, 'output was accepted');

  let correct = 0;
  let total = 0;
  const acceptedIds = out.accepted.map((s) => s.scenarioId);
  for (const id of e.accepted ?? []) {
    total += 1;
    const ok = acceptedIds.includes(id);
    correct += ok ? 1 : 0;
    add(`accepted:${id}`, 'structural', ok, JSON.stringify(out.issues[id] ?? []));
  }
  for (const [id, codes] of Object.entries(e.rejected ?? {})) {
    total += 1;
    const found: string[] = (out.issues[id] ?? []).map((i) => i.code);
    const ok = !acceptedIds.includes(id) && codes.every((code) => found.includes(code));
    correct += ok ? 1 : 0;
    add(`rejected:${id}`, 'structural', ok, found.join(','));
  }
  if (e.missingCapabilities !== undefined) add('missingCapabilities', 'structural', out.output.missingCapabilities.length === e.missingCapabilities);

  const rendered = await renderAndValidate(out.accepted, scratchId);
  for (const r of rendered) {
    add(`typecheck:${r.scenarioId}`, 'structural', r.typecheckClean);
    add(`convention:${r.scenarioId}`, 'structural', r.conventionClean);
    add(`titlePreserved:${r.scenarioId}`, 'structural', r.titlePreserved);
  }

  // Semantic: assertion quality rules and required reference assertions.
  const findings: AssertionFinding[] = [];
  const ruleVsLabel: GenerationResult['ruleVsLabel'] = [];
  const req = { required: 0, satisfied: 0, missing: [] as string[] };
  for (const spec of out.accepted) {
    const scenario = c.scenarios.find((s) => s.id === spec.scenarioId);
    const f = assertionFindings(spec, scenario, c.requirement);
    findings.push(...f);
    const label = c.assertionLabels[spec.scenarioId];
    if (label) ruleVsLabel.push({ scenarioId: spec.scenarioId, labelled: [...label.weaknesses].sort(), predicted: [...new Set(f.map((x) => x.rule))].sort() });
    const cov = requiredAssertionCoverage(spec, c.requiredAssertions[spec.scenarioId] ?? []);
    req.required += cov.required;
    req.satisfied += cov.satisfied;
    req.missing.push(...cov.missing.map((m) => `${spec.scenarioId}: ${m.target} = ${JSON.stringify(m.expected)}`));
  }
  for (const r of ruleVsLabel) {
    add(`assertionRules:${r.scenarioId}`, 'reference', JSON.stringify(r.labelled) === JSON.stringify(r.predicted), `labelled [${r.labelled}] predicted [${r.predicted}]`);
  }
  return {
    id: c.id,
    category: c.category,
    schemaValid: true,
    checks,
    pass: checks.filter((x) => x.dimension !== 'reference').every((x) => x.pass),
    rendered,
    specDecisions: { correct, total },
    assertionFindings: findings,
    ruleVsLabel,
    requiredAssertions: req,
    usage: out.usage,
  };
}

export function generationMetrics(results: GenerationResult[]) {
  const rendered = results.flatMap((r) => r.rendered);
  return {
    structural: {
      expectationsMet: ratio(countWhere(results, (r) => r.pass), results.length),
      schemaValidity: ratio(countWhere(results, (r) => r.schemaValid), results.length),
      specDecisionAccuracy: ratio(results.reduce((n, r) => n + r.specDecisions.correct, 0), results.reduce((n, r) => n + r.specDecisions.total, 0)),
      typescriptValidity: ratio(countWhere(rendered, (r) => r.typecheckClean), rendered.length),
      conventionCompliance: ratio(countWhere(rendered, (r) => r.conventionClean), rendered.length),
      traceability: ratio(countWhere(rendered, (r) => r.traceable), rendered.length),
    },
    semantic: {
      requiredAssertionsSatisfied: ratio(results.reduce((n, r) => n + r.requiredAssertions.satisfied, 0), results.reduce((n, r) => n + r.requiredAssertions.required, 0)),
      specsWithoutAssertionFindings: ratio(
        countWhere(results.flatMap((r) => r.rendered.map((x) => ({ r, id: x.scenarioId }))), ({ r, id }) => !r.assertionFindings.some((f) => f.scenarioId === id)),
        rendered.length,
      ),
    },
  };
}

/** Agreement between deterministic assertion rules and reference labels, per rule. */
export function assertionRuleAgreement(results: GenerationResult[]) {
  const rows = results.flatMap((r) => r.ruleVsLabel.map((x) => ({ caseId: r.id, ...x })));
  const perRule = ASSERTION_WEAKNESSES.map((rule) => {
    const tp = countWhere(rows, (x) => x.labelled.includes(rule) && x.predicted.includes(rule));
    const fp = countWhere(rows, (x) => !x.labelled.includes(rule) && x.predicted.includes(rule));
    const fn = countWhere(rows, (x) => x.labelled.includes(rule) && !x.predicted.includes(rule));
    return { rule, labelled: tp + fn, tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) };
  });
  return {
    specsLabelled: rows.length,
    exactAgreement: ratio(countWhere(rows, (x) => JSON.stringify(x.labelled) === JSON.stringify(x.predicted)), rows.length),
    perRule,
    disagreements: rows.filter((x) => JSON.stringify(x.labelled) !== JSON.stringify(x.predicted)),
  };
}

/* -------------------- execution evidence and analysis -------------------- */

export function evidenceFor(report: string) {
  return collectEvidence({
    runId: `eval-${report}`,
    repoRoot: REPO_ROOT,
    reportPath: path.join(DATASET_DIR, 'failures', report),
    startedAt: new Date(0),
    finishedAt: new Date(0),
    target: { name: 'saucedemo-public-demo', host: 'www.saucedemo.com' },
    runner: { exitCode: 1, timedOut: false, stderr: '' },
  });
}

function findTest(tests: TestEvidence[], title: string, scenarioId: string | null): TestEvidence | undefined {
  return tests.find((t) => t.title === title && (scenarioId === null ? t.scenarioId === undefined : t.scenarioId === scenarioId)) ?? tests.find((t) => t.title === title);
}

export function evaluateExecution(cases: FailureCase[]) {
  const rows = cases.map((l) => {
    const evidence = evidenceFor(l.report);
    const schemaValid = RunEvidenceSchema.safeParse(evidence).success;
    const phantomRefs = evidence.tests.flatMap((t) => [t.traceRef, ...t.screenshotRefs]).filter((p): p is string => !!p && !existsSync(path.join(REPO_ROOT, p))).length;
    const test = findTest(evidence.tests, l.title, l.expectedScenarioId);
    const record: ArtifactRecord = { scenarioId: l.expectedScenarioId ?? '-', requirementId: '-', file: '-', sha256: '', state: 'executed', history: [] };
    const outcome = recordOutcome(record, test).state;
    return {
      id: l.id,
      expectedStatus: l.expectedStatus,
      parsedStatus: test?.status ?? 'missing',
      statusCorrect: test?.status === l.expectedStatus,
      associationCorrect: (test?.scenarioId ?? null) === l.expectedScenarioId,
      outcome,
      falsePass: outcome === 'passed' && l.expectedStatus !== 'passed',
      schemaValid,
      phantomRefs,
    };
  });
  return {
    rows,
    metrics: {
      statusInterpretation: ratio(countWhere(rows, (r) => r.statusCorrect), rows.length),
      requirementAssociation: ratio(countWhere(rows, (r) => r.associationCorrect), rows.length),
      falsePasses: countWhere(rows, (r) => r.falsePass),
      evidenceSchemaValid: ratio(countWhere(rows, (r) => r.schemaValid), rows.length),
      phantomEvidenceRefs: rows.reduce((n, r) => n + r.phantomRefs, 0),
    },
  };
}

/** Phase 3 labels mapped to the classifier's vocabulary. auth_setup and test_data share one classifier category. */
export const LABEL_TO_CATEGORY: Record<FailureLabel, string> = {
  product_regression: 'product_behavior',
  incorrect_assertion: 'assertion_logic',
  locator: 'locator',
  auth_setup: 'test_data_setup',
  test_data: 'test_data_setup',
  environment: 'environment',
  timeout: 'timeout_sync',
  flaky: 'flaky',
  insufficient_evidence: 'inconclusive',
};
export const ANALYSIS_CLASSES = ['product_behavior', 'assertion_logic', 'locator', 'test_data_setup', 'environment', 'timeout_sync', 'flaky', 'inconclusive', 'not_analyzed'] as const;

export interface AnalysisRow {
  id: string;
  label: FailureLabel;
  expected: string;
  predicted: string;
  method: 'rules' | 'model' | 'none';
  confidence?: string;
  sufficientEvidenceClaimed?: boolean;
  evidenceSufficient: boolean | null | undefined;
  agree: boolean;
  grounded: boolean;
  citesErrorEvidence: boolean;
  unsupportedClaim: boolean;
  labelInTopOrAlternatives: boolean;
}

function analysisRow(l: FailureCase, analysis: FailureAnalysis | undefined): AnalysisRow {
  const expected = LABEL_TO_CATEGORY[l.label!];
  if (!analysis) {
    return { id: l.id, label: l.label!, expected, predicted: 'not_analyzed', method: 'none', evidenceSufficient: l.evidenceSufficient, agree: expected === 'not_analyzed', grounded: false, citesErrorEvidence: false, unsupportedClaim: false, labelInTopOrAlternatives: false };
  }
  const d = analysis.diagnosis;
  const known = new Map(analysis.observations.map((o) => [o.id, o]));
  const agree = d.category === expected;
  return {
    id: l.id,
    label: l.label!,
    expected,
    predicted: d.category,
    method: analysis.method,
    confidence: d.confidence,
    sufficientEvidenceClaimed: d.sufficientEvidence,
    evidenceSufficient: l.evidenceSufficient,
    agree,
    grounded: d.evidenceIds.length > 0 && d.evidenceIds.every((id) => known.has(id)),
    citesErrorEvidence: d.evidenceIds.some((id) => known.get(id)?.source.startsWith('error') || known.get(id)?.source.startsWith('run.')),
    unsupportedClaim: !agree && (d.confidence === 'high' || d.sufficientEvidence),
    labelInTopOrAlternatives: agree || d.alternatives.some((x) => x.category === expected),
  };
}

/**
 * Failure-analysis accuracy on labelled real reports. Mirrors the workflow:
 * only failed/timed-out/interrupted tests are analysed; others are "not_analyzed".
 */
export async function evaluateAnalysis(cases: FailureCase[], modelProvider?: LlmProvider) {
  const labelled = cases.filter((c) => c.label !== null);
  const rules: AnalysisRow[] = [];
  const model: AnalysisRow[] = [];
  const usage: UsageRecord[] = [];
  for (const l of labelled) {
    const evidence = evidenceFor(l.report);
    const test = findTest(evidence.tests, l.title, l.expectedScenarioId);
    const analysable = test && ['failed', 'timedOut', 'interrupted'].includes(test.status);
    const base = analysable ? classifyFailure(test, { acceptanceCriteriaText: l.acceptanceCriteria }, evidence) : undefined;
    rules.push(analysisRow(l, base));
    if (modelProvider && base) {
      const refined = await refineWithModel(modelProvider, base, { acceptanceCriteria: l.acceptanceCriteria });
      usage.push(refined.usage);
      model.push(analysisRow(l, refined.analysis));
    }
  }
  return { rules: summarizeAnalysis(rules), model: modelProvider ? summarizeAnalysis(model) : null, usage };
}

export function summarizeAnalysis(rows: AnalysisRow[]) {
  const pairs = rows.map((r) => ({ expected: r.expected, predicted: r.predicted }));
  const uncertain = rows.filter((r) => r.evidenceSufficient === false);
  const insufficient = rows.filter((r) => r.label === 'insufficient_evidence');
  const analysed = rows.filter((r) => r.method !== 'none');
  return {
    rows,
    n: rows.length,
    classification: perClass(pairs, ANALYSIS_CLASSES),
    confusion: confusion(pairs),
    labelInTopOrAlternatives: ratio(countWhere(rows, (r) => r.labelInTopOrAlternatives), rows.length),
    evidenceGrounding: ratio(countWhere(analysed, (r) => r.grounded), analysed.length),
    evidenceRelevance: ratio(countWhere(analysed, (r) => r.citesErrorEvidence), analysed.length),
    unsupportedRootCauseClaims: countWhere(rows, (r) => r.unsupportedClaim),
    uncertaintyIdentified: ratio(countWhere(uncertain, (r) => r.sufficientEvidenceClaimed === false), uncertain.length),
    escalationOnInsufficientEvidence: ratio(countWhere(insufficient, (r) => r.predicted === 'inconclusive' || r.sufficientEvidenceClaimed === false), insufficient.length),
    taxonomyNote: 'auth_setup and test_data both map to the classifier category test_data_setup; the classifier has no "flaky" category and the workflow does not analyse flaky (passed-on-retry) tests.',
  };
}
