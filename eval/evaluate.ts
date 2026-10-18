import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { LlmProvider } from '../src/agent/llm/provider';
import { MockProvider } from '../src/agent/llm/mock';
import type { RetryPolicy } from '../src/agent/llm/structured';
import { planRequirement, generateSpecs } from '../src/agent/workflow/generate';
import { renderSpec } from '../src/agent/generation/render';
import { validateArtifacts } from '../src/agent/validation/artifacts';
import type { Scenario } from '../src/agent/domain/plan';
import type { Requirement } from '../src/agent/domain/requirement';
import type { TestSpec } from '../src/agent/domain/testSpec';
import { collectEvidence } from '../src/agent/evidence/collect';
import { RunEvidenceSchema, type TestEvidence } from '../src/agent/domain/result';
import { recordOutcome, type ArtifactRecord } from '../src/agent/domain/state';
import { classifyFailure } from '../src/agent/analysis/classify';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { confusion, countWhere, mean, ratio, type Ratio } from './metrics';

export const REPO_ROOT = path.resolve(__dirname, '..');
const DATASET = path.join(__dirname, 'dataset');

const FAST_RETRY: RetryPolicy = { maxAttempts: 1, timeoutMs: 10_000, baseBackoffMs: 0, maxBackoffMs: 0 };

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

/* ------------------------------ planning ------------------------------ */

export interface PlanningCase {
  id: string;
  category: string;
  requirement: unknown;
  recordedOutput: unknown;
  expected: {
    outcome: string;
    failureKind?: string;
    coverage?: number;
    scenarioTypes?: string[];
    issueCodes?: string[];
    absentIssueCodes?: string[];
    requirementIssueCodes?: string[];
    flagsAmbiguity?: boolean;
    unsupportedAssumption?: boolean;
    assumptionScenarios?: string[];
    modelCalls?: number;
  };
}

export interface PlanningResult {
  id: string;
  category: string;
  outcome: string;
  checks: Check[];
  pass: boolean;
  coverage?: number;
  scenarios?: { total: number; traceable: number };
  flaggedAmbiguity: boolean;
  modelCalls: number;
}

export function loadPlanningCases(): PlanningCase[] {
  return (JSON.parse(readFileSync(path.join(DATASET, 'planning.json'), 'utf8')) as { cases: PlanningCase[] }).cases;
}

export function recordedProvider(useCase: string, output: unknown): MockProvider {
  if (output === null || output === undefined) return new MockProvider({});
  return new MockProvider({ [useCase]: [typeof output === 'string' ? output : JSON.stringify(output)] });
}

export async function evaluatePlanningCase(c: PlanningCase, provider: LlmProvider & { calls?: unknown[] }, retry = FAST_RETRY): Promise<PlanningResult> {
  const r = await planRequirement(c.requirement, provider, retry);
  const checks: Check[] = [];
  const e = c.expected;
  const modelCalls = provider.calls?.length ?? -1;
  checks.push({ name: 'outcome', pass: r.outcome === e.outcome, detail: `expected ${e.outcome}, got ${r.outcome}` });
  if (e.modelCalls !== undefined) checks.push({ name: 'modelCalls', pass: modelCalls === e.modelCalls, detail: `${modelCalls}` });
  if (e.failureKind) checks.push({ name: 'failureKind', pass: r.outcome === 'plan_failed' && r.kind === e.failureKind, detail: r.outcome === 'plan_failed' ? r.kind : '-' });

  const reqCodes: string[] = 'assessment' in r ? r.assessment.issues.map((i) => i.code) : [];
  for (const code of e.requirementIssueCodes ?? []) checks.push({ name: `requirementIssue:${code}`, pass: reqCodes.includes(code) });

  let coverage: number | undefined;
  let scenarios: PlanningResult['scenarios'];
  let planCodes: string[] = [];
  let planAmbiguities = 0;
  if (r.outcome === 'plan_valid' || r.outcome === 'plan_rejected') {
    planCodes = r.check.issues.map((i) => i.code);
    planAmbiguities = r.plan.ambiguities.length + r.plan.scenarios.reduce((n, s) => n + s.openQuestions.length, 0);
    coverage = r.req.acceptanceCriteria.length ? r.check.coverage.covered.length / r.req.acceptanceCriteria.length : 1;
    scenarios = { total: r.plan.scenarios.length, traceable: r.check.traceableScenarioIds.length };
    if (e.coverage !== undefined) checks.push({ name: 'coverage', pass: coverage >= e.coverage, detail: coverage.toFixed(2) });
    for (const t of e.scenarioTypes ?? []) checks.push({ name: `scenarioType:${t}`, pass: r.plan.scenarios.some((s) => s.type === t) });
    for (const code of e.issueCodes ?? []) checks.push({ name: `planIssue:${code}`, pass: planCodes.includes(code) });
    for (const code of e.absentIssueCodes ?? []) checks.push({ name: `noPlanIssue:${code}`, pass: !planCodes.includes(code) });
    for (const id of e.assumptionScenarios ?? []) checks.push({ name: `assumptionScenario:${id}`, pass: r.check.assumptionScenarioIds.includes(id) });
  } else {
    for (const code of e.issueCodes ?? []) checks.push({ name: `planIssue:${code}`, pass: false, detail: 'no plan' });
  }

  const flaggedAmbiguity =
    reqCodes.includes('missing_acceptance_criteria') || planAmbiguities > 0 || planCodes.includes('ambiguity_not_surfaced');
  if (e.flagsAmbiguity) checks.push({ name: 'flagsAmbiguity', pass: flaggedAmbiguity });

  return { id: c.id, category: c.category, outcome: r.outcome, checks, pass: checks.every((x) => x.pass), coverage, scenarios, flaggedAmbiguity, modelCalls };
}

export function planningMetrics(cases: PlanningCase[], results: PlanningResult[]) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const valid = results.filter((r) => r.outcome === 'plan_valid');
  const withScenarios = results.filter((r) => r.scenarios);
  const ambiguityCases = results.filter((r) => byId.get(r.id)?.expected.flagsAmbiguity);
  const unsupported = results.filter((r) => byId.get(r.id)?.expected.unsupportedAssumption);
  const malformed = results.filter((r) => byId.get(r.id)?.category === 'malformed_output');
  return {
    caseExpectationsMet: ratio(countWhere(results, (r) => r.pass), results.length),
    outcomeAccuracy: ratio(countWhere(results, (r) => r.checks.find((c) => c.name === 'outcome')?.pass === true), results.length),
    acceptanceCriteriaCoverage: mean(valid.map((r) => r.coverage ?? 0)),
    scenarioTraceability: ratio(
      withScenarios.reduce((n, r) => n + r.scenarios!.traceable, 0),
      withScenarios.reduce((n, r) => n + r.scenarios!.total, 0),
    ),
    ambiguityDetection: ratio(countWhere(ambiguityCases, (r) => r.flaggedAmbiguity), ambiguityCases.length),
    unsupportedAssumptionDetection: ratio(countWhere(unsupported, (r) => r.outcome === 'plan_rejected'), unsupported.length),
    malformedOutputHandled: ratio(countWhere(malformed, (r) => r.outcome === 'plan_failed'), malformed.length),
  };
}

/* ----------------------------- generation ----------------------------- */

export interface GenerationCase {
  id: string;
  category: string;
  requirement: Requirement;
  scenarios: Scenario[];
  recordedOutput: unknown;
  expected: {
    failureKind?: string;
    accepted?: string[];
    rejected?: Record<string, string[]>;
    missingCapabilities?: number;
    contentAssertion?: boolean;
  };
}

export interface GenerationResult {
  id: string;
  category: string;
  schemaValid: boolean;
  checks: Check[];
  pass: boolean;
  rendered: Array<{ scenarioId: string; typecheckClean: boolean; conventionClean: boolean; traceable: boolean; contentAssertion: boolean; titlePreserved: boolean }>;
  specDecisions: { correct: number; total: number };
}

export function loadGenerationCases(): GenerationCase[] {
  return (JSON.parse(readFileSync(path.join(DATASET, 'generation.json'), 'utf8')) as { cases: GenerationCase[] }).cases;
}

const CONTENT_MATCHERS = new Set(['toHaveText', 'toContainText', 'toHaveCount', 'toHaveValue']);
export function hasContentAssertion(spec: TestSpec): boolean {
  return spec.steps.some((s) => s.kind === 'expectUrl' || (s.kind === 'expect' && CONTENT_MATCHERS.has(s.matcher)));
}

/** The test title as TypeScript parses it, to prove hostile text stayed a string. */
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

export async function evaluateGenerationCase(c: GenerationCase, provider: LlmProvider, scratchId: string, retry = FAST_RETRY): Promise<GenerationResult> {
  const out = await generateSpecs(c.requirement, c.scenarios, provider, retry);
  const checks: Check[] = [];
  const e = c.expected;
  const rendered: GenerationResult['rendered'] = [];
  let correct = 0;
  let total = 0;

  if (!out.ok) {
    checks.push({ name: 'failureKind', pass: out.kind === e.failureKind, detail: out.kind });
    return { id: c.id, category: c.category, schemaValid: false, checks, pass: checks.every((x) => x.pass), rendered, specDecisions: { correct, total } };
  }
  if (e.failureKind) checks.push({ name: 'failureKind', pass: false, detail: 'output was accepted' });

  const acceptedIds = out.accepted.map((s) => s.scenarioId);
  for (const id of e.accepted ?? []) {
    total += 1;
    const ok = acceptedIds.includes(id);
    correct += ok ? 1 : 0;
    checks.push({ name: `accepted:${id}`, pass: ok, detail: JSON.stringify(out.issues[id] ?? []) });
  }
  for (const [id, codes] of Object.entries(e.rejected ?? {})) {
    total += 1;
    const found = (out.issues[id] ?? []).map((i) => i.code);
    const ok = !acceptedIds.includes(id) && codes.every((code) => (found as string[]).includes(code));
    correct += ok ? 1 : 0;
    checks.push({ name: `rejected:${id}`, pass: ok, detail: found.join(',') });
  }
  if (e.missingCapabilities !== undefined) {
    checks.push({ name: 'missingCapabilities', pass: out.output.missingCapabilities.length === e.missingCapabilities });
  }

  if (out.accepted.length > 0) {
    const dir = path.join('generated', scratchId);
    const files: Record<string, { requirementId: string; scenarioId: string }> = {};
    mkdirSync(path.join(REPO_ROOT, dir), { recursive: true });
    try {
      for (const spec of out.accepted) {
        const rel = path.posix.join('generated', scratchId, `${spec.scenarioId}.spec.ts`);
        writeFileSync(path.join(REPO_ROOT, rel), renderSpec(spec, scratchId));
        files[rel] = { requirementId: spec.requirementId, scenarioId: spec.scenarioId };
      }
      const v = await validateArtifacts({ repoRoot: REPO_ROOT, generationArea: 'generated', files, workspaceBefore: [], workspaceAfter: [] });
      for (const spec of out.accepted) {
        const rel = path.posix.join('generated', scratchId, `${spec.scenarioId}.spec.ts`);
        const findings = v.files[rel] ?? [];
        const source = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        rendered.push({
          scenarioId: spec.scenarioId,
          typecheckClean: !findings.some((f) => f.check === 'typecheck'),
          conventionClean: !findings.some((f) => f.check === 'ast' || f.check === 'lint' || f.check === 'convention' || f.check === 'path'),
          traceable: !findings.some((f) => f.message.includes('annotation')),
          contentAssertion: hasContentAssertion(spec),
          titlePreserved: parsedTestTitle(source) === spec.title,
        });
      }
    } finally {
      rmSync(path.join(REPO_ROOT, dir), { recursive: true, force: true });
    }
    for (const r of rendered) {
      checks.push({ name: `typecheck:${r.scenarioId}`, pass: r.typecheckClean });
      checks.push({ name: `convention:${r.scenarioId}`, pass: r.conventionClean });
      checks.push({ name: `titlePreserved:${r.scenarioId}`, pass: r.titlePreserved });
    }
  }
  if (e.contentAssertion !== undefined) {
    checks.push({ name: 'contentAssertion', pass: rendered.every((r) => r.contentAssertion === e.contentAssertion) });
  }
  return { id: c.id, category: c.category, schemaValid: true, checks, pass: checks.every((x) => x.pass), rendered, specDecisions: { correct, total } };
}

export function generationMetrics(results: GenerationResult[]) {
  const rendered = results.flatMap((r) => r.rendered);
  return {
    caseExpectationsMet: ratio(countWhere(results, (r) => r.pass), results.length),
    schemaValidity: ratio(countWhere(results, (r) => r.schemaValid), results.length),
    specDecisionAccuracy: ratio(
      results.reduce((n, r) => n + r.specDecisions.correct, 0),
      results.reduce((n, r) => n + r.specDecisions.total, 0),
    ),
    typescriptValidity: ratio(countWhere(rendered, (r) => r.typecheckClean), rendered.length),
    conventionCompliance: ratio(countWhere(rendered, (r) => r.conventionClean), rendered.length),
    traceability: ratio(countWhere(rendered, (r) => r.traceable), rendered.length),
    contentAssertionRate: ratio(countWhere(rendered, (r) => r.contentAssertion), rendered.length),
  };
}

/* -------------------- execution evidence and analysis -------------------- */

export interface FailureLabel {
  id: string;
  report: string;
  title: string;
  expectedStatus: string;
  expectedScenarioId: string | null;
  label: string | null;
  acceptanceCriteria: string;
  rationale: string;
}

export function loadFailureLabels(): FailureLabel[] {
  return (JSON.parse(readFileSync(path.join(DATASET, 'failures', 'labels.json'), 'utf8')) as { cases: FailureLabel[] }).cases;
}

export function evidenceFor(report: string) {
  return collectEvidence({
    runId: `eval-${report}`,
    repoRoot: REPO_ROOT,
    reportPath: path.join(DATASET, 'failures', report),
    startedAt: new Date(0),
    finishedAt: new Date(0),
    target: { name: 'saucedemo-public-demo', host: 'www.saucedemo.com' },
    runner: { exitCode: 1, timedOut: false, stderr: '' },
  });
}

function findTest(tests: TestEvidence[], title: string, scenarioId: string | null): TestEvidence | undefined {
  return tests.find((t) => t.title === title && (scenarioId === null ? t.scenarioId === undefined : t.scenarioId === scenarioId))
    ?? tests.find((t) => t.title === title);
}

export function evaluateExecution(labels: FailureLabel[]) {
  const rows = labels.map((l) => {
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

export function evaluateAnalysis(labels: FailureLabel[]) {
  const labelled = labels.filter((l) => l.label !== null);
  const rows = labelled.map((l) => {
    const evidence = evidenceFor(l.report);
    const test = findTest(evidence.tests, l.title, l.expectedScenarioId)!;
    const a = classifyFailure(test, { acceptanceCriteriaText: l.acceptanceCriteria }, evidence);
    const known = new Set(a.observations.map((o) => o.id));
    const d = a.diagnosis;
    return {
      id: l.id,
      label: l.label!,
      predicted: d.category,
      confidence: d.confidence,
      agree: d.category === l.label,
      grounded: d.evidenceIds.length > 0 && d.evidenceIds.every((id) => known.has(id)),
      overconfidentWrong: d.category !== l.label && d.confidence === 'high' && d.sufficientEvidence,
      labelInAlternatives: d.category === l.label || d.alternatives.some((x) => x.category === l.label),
    };
  });
  return {
    rows,
    metrics: {
      method: 'rules' as const,
      labelAgreement: ratio(countWhere(rows, (r) => r.agree), rows.length),
      labelInTopOrAlternatives: ratio(countWhere(rows, (r) => r.labelInAlternatives), rows.length),
      evidenceGrounding: ratio(countWhere(rows, (r) => r.grounded), rows.length),
      overconfidentWrongClaims: countWhere(rows, (r) => r.overconfidentWrong),
      confusion: confusion(rows.map((r) => ({ expected: r.label, predicted: r.predicted }))),
      calibration: 'not computed: 6 labelled cases are too few to estimate calibration',
    },
  };
}

export type { Ratio };
