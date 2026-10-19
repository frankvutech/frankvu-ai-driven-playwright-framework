import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from '../src/agent/evidence/redact';
import { parseArgs } from 'node:util';
import { loadPolicy, type Policy } from '../src/agent/execution/policy';
import type { LlmProvider } from '../src/agent/llm/provider';
import type { UsageRecord } from '../src/agent/llm/structured';
import { PLAN_SYSTEM } from '../src/agent/prompts/plan';
import { GENERATE_SYSTEM } from '../src/agent/prompts/generate';
import { ANALYZE_SYSTEM } from '../src/agent/prompts/analyze';
import { PROMPT_VERSION } from '../src/agent/prompts/common';
import { AnthropicProvider } from '../src/agent/llm/anthropic';
import { anthropicConfigFromEnv } from '../src/agent/config/llm';
import { loadDataset, type Dataset } from './dataset';
import {
  REPO_ROOT,
  assertionRuleAgreement,
  evaluateAnalysis,
  evaluateExecution,
  evaluateGenerationCase,
  evaluatePlanningCase,
  generationMetrics,
  planningMetrics,
  recordedProvider,
  renderAndValidate,
  type GenerationResult,
  type PlanningResult,
} from './evaluate';
import { generateSpecs } from '../src/agent/workflow/generate';
import { assertionFindings } from './assertions';
import { evaluateFunctional } from './functional';
import { runFaultInjection } from './faults';
import { loadPricing, summarizeCostLatency, type WorkflowMeasurement } from './cost';
import { JUDGE_SYSTEM, judgeAssertions } from './semantic';
import { METRIC_IMPLEMENTATION_VERSION, countWhere, ratio } from './metrics';
import { ReportSchema, ratioMetric, renderSummary, valueMetric, type EvaluationReport, type Finding, type Gate, type Metric } from './report';
import { compareReports, loadReport, renderComparison } from './compare';
import { generationByLayer } from './evaluate';
import { evaluateHealing } from './healing';
import { evaluateGates, loadGateConfig } from './gates';
import { HEAL_SYSTEM } from '../src/agent/prompts/heal';

export type Mode = 'deterministic' | 'functional' | 'live' | 'healing';

export interface RunOptions {
  mode: Mode;
  outDir?: string;
  baseline?: string;
  /** Live mode only: the provider under evaluation (defaults to Anthropic from env). */
  provider?: LlmProvider;
  /** Live mode only: an optional, different model used as semantic judge. */
  judge?: LlmProvider;
  repeat?: number;
  approver?: string;
  suites?: string[];
  /** Healing mode: restrict to some cases (by id). */
  cases?: string[];
  /** Pricing metadata file (default eval/pricing.json). */
  pricing?: string;
  /** Gate configuration file (default eval/gates.json). */
  gates?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

function gitInfo() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: 'unknown', dirty: true };
  }
}

const promptSha = () => createHash('sha256').update([PLAN_SYSTEM, GENERATE_SYSTEM, ANALYZE_SYSTEM, JUDGE_SYSTEM, HEAL_SYSTEM].join('\n\0\n')).digest('hex');

function runId(mode: Mode, now: Date) {
  return `eval-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${mode}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------- sections ------------------------------- */

const SRC = {
  planning: 'eval/dataset/planning.json via src/agent/workflow/generate.ts planRequirement',
  generation: 'eval/dataset/generation.json via generateSpecs + renderSpec + validateArtifacts',
  failures: 'eval/dataset/failures/*.json via collectEvidence + classifyFailure',
  faults: 'eval/faults.ts fault catalogue',
  functional: 'eval/dataset/functional.json executed through the Phase 2 workflow',
  healing: 'eval/dataset/healing.json through src/agent/healing on the local example app',
};

function planningSection(cases: Dataset['planning']['cases'], results: PlanningResult[], kind: 'deterministic' | 'measured') {
  const m = planningMetrics(cases, results);
  const gate = kind === 'deterministic' ? 'exact' : 'none';
  const metrics: Metric[] = [
    ratioMetric('planning.structural.expectationsMet', m.structural.expectationsMet, { kind, gate, source: SRC.planning, definition: 'Cases whose structural expectations (outcome, issue codes, coverage, error kind) all hold / cases.' }),
    ratioMetric('planning.structural.scenarioTraceability', m.structural.scenarioTraceability, { kind, gate, source: SRC.planning, definition: 'Scenarios tracing to at least one acceptance criterion / all scenarios in plans.' }),
    ratioMetric('planning.structural.ambiguityDetection', m.structural.ambiguityDetection, { kind, gate, source: SRC.planning, definition: 'Cases expected to flag ambiguity where the requirement check or plan raised it / such cases.' }),
    ratioMetric('planning.structural.unsupportedAssumptionRejection', m.structural.unsupportedAssumptionRejection, { kind, gate, source: SRC.planning, definition: 'Cases with untraceable or invented scenarios whose plan was rejected / such cases.' }),
    ratioMetric('planning.semantic.requiredCoverageMet', m.semantic.requiredCoverageMet, { kind, gate, source: SRC.planning, definition: 'Cases meeting the reference requiredCoverage (covered criteria / all criteria) / cases with a requiredCoverage.' }),
    ratioMetric('planning.semantic.expectedScenarioCategoriesPresent', m.semantic.expectedScenarioCategoriesPresent, { kind, gate, source: SRC.planning, definition: 'Cases whose plan contains every reference scenario category / cases with reference categories.' }),
    ratioMetric('planning.semantic.plansFreeOfProhibitedAssumptions', m.semantic.plansFreeOfProhibitedAssumptions, { kind, gate, source: SRC.planning, definition: 'Plans containing none of the reference prohibited-assumption phrases (keyword proxy) / plans checked.' }),
    ratioMetric('planning.semantic.clarificationBehaviourCorrect', m.semantic.clarificationBehaviourCorrect, { kind, gate, source: SRC.planning, definition: 'Cases where the agent asked, surfaced ambiguity or declared gaps as the reference expects / cases expecting clarification.' }),
  ];
  if (kind === 'deterministic') {
    metrics.splice(1, 0, ratioMetric('planning.structural.outcomeAccuracy', m.structural.outcomeAccuracy, { kind, gate, source: SRC.planning, definition: 'Cases whose workflow outcome equals the reference outcome / cases.' }));
  }
  const findings: Finding[] = [
    ...results.filter((r) => !r.pass).map((r): Finding => ({ type: 'failed-case', id: r.id, detail: r.checks.filter((c) => !c.pass).map((c) => `${c.name} ${c.detail ?? ''}`).join('; '), source: kind })),
    ...results.flatMap((r) => r.prohibitedHits.map((h): Finding => ({ type: 'unsupported-assumption', id: `${r.id}/${h.scenarioId}`, detail: `plan contains prohibited assumption "${h.phrase}"`, source: kind }))),
  ];
  return { metrics, findings, detail: { metrics: m, cases: results } };
}

function generationSection(results: GenerationResult[], kind: 'deterministic' | 'measured') {
  const m = generationMetrics(results);
  const agreement = assertionRuleAgreement(results);
  const gate = kind === 'deterministic' ? 'exact' : 'none';
  const metrics: Metric[] = [
    ratioMetric('generation.structural.expectationsMet', m.structural.expectationsMet, { kind, gate, source: SRC.generation, definition: 'Cases whose structural expectations (schema, accept/reject decisions, type-check, conventions) hold / cases.' }),
    ratioMetric('generation.structural.schemaValidity', m.structural.schemaValidity, { kind, gate, source: SRC.generation, definition: 'Model outputs that parse and match GenerationOutputSchema / outputs.' }),
    ratioMetric('generation.structural.typescriptValidity', m.structural.typescriptValidity, { kind, gate, source: SRC.generation, definition: 'Rendered test files with no TypeScript errors / rendered files.' }),
    ratioMetric('generation.structural.conventionCompliance', m.structural.conventionCompliance, { kind, gate, source: SRC.generation, definition: 'Rendered files with no AST, ESLint, path or convention findings / rendered files.' }),
    ratioMetric('generation.structural.traceability', m.structural.traceability, { kind, gate, source: SRC.generation, definition: 'Rendered files carrying requirement and scenario annotations / rendered files.' }),
    ratioMetric('generation.semantic.requiredAssertionsSatisfied', m.semantic.requiredAssertionsSatisfied, { kind, gate, source: SRC.generation, definition: 'Reference required assertions (target + exact expected value, not negated) present / required assertions.' }),
    ratioMetric('generation.semantic.specsWithoutAssertionFindings', m.semantic.specsWithoutAssertionFindings, { kind, gate, source: SRC.generation, definition: 'Accepted specs with no deterministic assertion-quality finding / accepted specs.' }),
  ];
  const rejections = results.reduce((a, r) => ({ n: a.n + (r.rejections?.rejected ?? 0), d: a.d + (r.rejections?.expected ?? 0) }), { n: 0, d: 0 });
  metrics.push(ratioMetric('generation.structural.unsupportedOrDuplicateRejected', ratio(rejections.n, rejections.d), { kind, gate, source: SRC.generation, definition: 'Specs the reference marks unsupported, duplicate, irrelevant or unsafe that the validators rejected / such specs.' }));
  for (const [layer, lm] of Object.entries(generationByLayer(results))) {
    const src = `${SRC.generation} (layer ${layer})`;
    metrics.push(
      ratioMetric(`generation.layer.${layer}.typescriptValidity`, lm.typescriptValidity, { kind, gate, source: src, definition: `Rendered ${layer} files with no TypeScript errors / rendered ${layer} files (compiles; says nothing about intent).` }),
      ratioMetric(`generation.layer.${layer}.requiredAssertionsMet`, lm.requiredAssertionsMet, { kind, gate, source: src, definition: `Accepted ${layer} specs containing every reference assertion (status, body field or UI value) / accepted ${layer} specs with reference assertions.` }),
      ratioMetric(`generation.layer.${layer}.intentCorrectByReference`, lm.intentCorrectByReference, { kind: 'reference-label', gate, source: src, definition: `Accepted ${layer} specs whose reference intent label is "correct" / labelled accepted ${layer} specs (reference judgement, independent of compiling or passing).` }),
      ratioMetric(`generation.layer.${layer}.incorrectIntentDetected`, lm.incorrectIntentDetected, { kind: 'reference-label', gate, source: src, definition: `Specs labelled "incorrect" that the deterministic rules or the required-assertion check flag / specs labelled incorrect.` }),
    );
  }
  if (agreement.specsLabelled > 0) {
    metrics.push(ratioMetric('assertion.rules.exactAgreementWithLabels', agreement.exactAgreement, { kind: 'reference-label', gate, source: SRC.generation, definition: 'Specs where the set of rule findings equals the reference weakness labels / labelled specs.' }));
  }
  const findings: Finding[] = [
    ...results.filter((r) => !r.pass).map((r): Finding => ({ type: 'failed-case', id: r.id, detail: r.checks.filter((c) => !c.pass && c.dimension !== 'reference').map((c) => `${c.name} ${c.detail ?? ''}`).join('; '), source: kind })),
    ...results.flatMap((r) => r.assertionFindings.map((f): Finding => ({ type: 'weak-assertion', id: `${r.id}/${f.scenarioId}/${f.rule}`, detail: `${f.weakness}: ${f.observedAssertion} (${f.evidence}; uncertainty ${f.uncertainty})`, source: 'deterministic' }))),
    ...agreement.disagreements.map((d): Finding => ({ type: 'failed-case', id: `${d.caseId}/${d.scenarioId}/assertion-labels`, detail: `rules [${d.predicted.join(', ')}] vs labels [${d.labelled.join(', ')}]`, source: 'reference-label' })),
  ];
  return { metrics, findings, detail: { metrics: m, assertionRuleAgreement: agreement, cases: results } };
}

async function analysisSection(dataset: Dataset, modelProvider?: LlmProvider) {
  const execution = evaluateExecution(dataset.failures.cases);
  const analysis = await evaluateAnalysis(dataset.failures.cases, modelProvider);
  const metrics: Metric[] = [
    ratioMetric('evidence.statusInterpretation', execution.metrics.statusInterpretation, { kind: 'reference-label', gate: 'exact', source: SRC.failures, definition: 'Report tests whose parsed status equals the labelled status / tests.' }),
    ratioMetric('evidence.requirementAssociation', execution.metrics.requirementAssociation, { kind: 'reference-label', gate: 'exact', source: SRC.failures, definition: 'Report tests associated with the labelled scenario / tests.' }),
    valueMetric('evidence.falsePasses', execution.metrics.falsePasses, { unit: 'count', kind: 'reference-label', gate: 'exact', higherIsBetter: false, source: SRC.failures, definition: 'Tests derived as passed whose labelled status is not passed.' }),
    valueMetric('evidence.phantomReferences', execution.metrics.phantomEvidenceRefs, { unit: 'count', kind: 'deterministic', gate: 'exact', higherIsBetter: false, source: SRC.failures, definition: 'Trace/screenshot references pointing to files that do not exist.' }),
  ];
  const add = (prefix: string, s: NonNullable<typeof analysis.model>, kind: 'reference-label' | 'ai-judgment') => {
    const gate = kind === 'reference-label' ? 'exact' : 'none';
    metrics.push(
      ratioMetric(`${prefix}.accuracy`, s.classification.accuracy, { kind, gate, minDenominator: 30, source: SRC.failures, definition: 'Labelled failures whose predicted category equals the labelled category (classifier vocabulary) / labelled failures.' }),
      valueMetric(`${prefix}.macroRecall`, s.classification.macroRecall, { unit: 'ratio', kind, gate, higherIsBetter: true, status: 'insufficient-data', source: SRC.failures, definition: 'Mean per-category recall over categories with at least one labelled case.' }),
      ratioMetric(`${prefix}.labelInTopOrAlternatives`, s.labelInTopOrAlternatives, { kind, gate, source: SRC.failures, definition: 'Failures whose label is the predicted category or one of the listed alternatives / labelled failures.' }),
      ratioMetric(`${prefix}.evidenceRelevance`, s.evidenceRelevance, { kind, gate, source: SRC.failures, definition: 'Analyses citing at least one error or run observation (not only the status line) / analyses produced.' }),
      ratioMetric(`${prefix}.uncertaintyIdentified`, s.uncertaintyIdentified, { kind, gate, source: SRC.failures, definition: 'Failures labelled "evidence insufficient" where the analysis also said evidence was insufficient / such failures.' }),
      ratioMetric(`${prefix}.escalationOnInsufficientEvidence`, s.escalationOnInsufficientEvidence, { kind, gate, source: SRC.failures, definition: 'insufficient_evidence failures diagnosed inconclusive or flagged insufficient / such failures.' }),
      valueMetric(`${prefix}.unsupportedRootCauseClaims`, s.unsupportedRootCauseClaims, { unit: 'count', kind, gate, higherIsBetter: false, source: SRC.failures, definition: 'Wrong diagnoses stated with high confidence or claiming sufficient evidence.' }),
    );
  };
  add('analysis.rules', analysis.rules, 'reference-label');
  if (analysis.model) add('analysis.model', analysis.model, 'ai-judgment');
  const findings: Finding[] = [
    ...execution.rows.filter((r) => !r.statusCorrect || !r.associationCorrect || r.falsePass).map((r): Finding => ({ type: 'failed-case', id: r.id, detail: `evidence parsing: ${JSON.stringify(r)}`, source: 'reference-label' })),
    ...analysis.rules.rows.filter((r) => !r.agree).map((r): Finding => ({ type: 'incorrect-diagnosis', id: r.id, detail: `labelled ${r.label} (${r.expected}), rules said ${r.predicted}${r.confidence ? ` with ${r.confidence} confidence` : ''}`, source: 'reference-label' })),
  ];
  return { metrics, findings, detail: { execution, analysis }, usage: analysis.usage, rows: { execution: execution.rows.length, analysis: analysis.rules.n, failedRows: findings.filter((f) => f.type === 'failed-case').length } };
}

async function faultSection(policy: Policy) {
  const { results, metrics: m } = await runFaultInjection(policy);
  const metrics: Metric[] = [
    ratioMetric('recovery.scenariosMeetingExpectations', m.allExpectationsMet, { kind: 'deterministic', gate: 'exact', source: SRC.faults, definition: 'Fault scenarios whose expected safe behaviour fully held / scenarios.' }),
    ratioMetric('recovery.errorClassificationCorrect', m.errorClassificationCorrect, { kind: 'deterministic', gate: 'exact', source: SRC.faults, definition: 'Classification checks (error kind, refusal reason, analysis category) that held / such checks.' }),
    ratioMetric('recovery.recoverySuccess', m.recoverySuccess, { kind: 'deterministic', gate: 'exact', source: SRC.faults, definition: 'Recoverable faults after which the step succeeded / recoverable faults.' }),
    ratioMetric('recovery.unrecoverablePropagated', m.unrecoverablePropagated, { kind: 'deterministic', gate: 'exact', source: SRC.faults, definition: 'Unrecoverable faults surfaced as a failed or refused status (never success) / unrecoverable faults.' }),
    ratioMetric('recovery.terminatedWithinLimits', m.terminatedWithinLimits, { kind: 'deterministic', gate: 'exact', source: SRC.faults, definition: 'Scenarios finishing within their configured time bound / scenarios.' }),
    valueMetric('recovery.meanRecoveryLatencyMs', m.meanRecoveryLatencyMs, { unit: 'ms', kind: 'measured', higherIsBetter: false, source: SRC.faults, definition: 'Mean model-step latency (including backoff) for recovered faults, with test backoff of 10-40 ms.' }),
  ];
  const findings = results.filter((r) => !r.pass).map((r): Finding => ({ type: 'recovery-failure', id: r.id, detail: `${r.fault}: ${r.checks.filter((c) => !c.pass).map((c) => `${c.name} ${c.detail ?? ''}`).join('; ')}`, source: 'deterministic' }));
  return { metrics, findings, detail: { results, metrics: m } };
}

function costLatencyMetrics(ms: WorkflowMeasurement[], kind: 'measured', mockModel: boolean, pricingFile?: string) {
  const s = summarizeCostLatency(ms, loadPricing(pricingFile));
  const insufficient = (n: number) => (n < 20 ? 'insufficient-data' : 'ok');
  const metrics: Metric[] = [
    valueMetric('cost.workflows', s.workflows, { unit: 'count', kind, source: 'workflow measurements', definition: 'Agent workflows measured in this run.' }),
    valueMetric('cost.modelCalls', s.modelCalls, { unit: 'count', kind, source: 'llm-usage.json', definition: 'Model call attempts across all workflows, including retries.' }),
    ratioMetric('cost.retryOverhead', s.retryOverhead, { kind, higherIsBetter: false, source: 'llm-usage.json', definition: 'Retry attempts / all model call attempts.' }),
    ratioMetric('cost.workflowFailureRate', s.failureRate, { kind, higherIsBetter: false, source: 'workflow measurements', definition: 'Workflows that did not complete / workflows.' }),
    valueMetric('latency.totalMedianMs', s.latencyMs.total.median, { unit: 'ms', kind, higherIsBetter: false, status: s.latencyMs.total.n ? insufficient(s.latencyMs.total.n) : 'unavailable', source: 'runner wall-clock', definition: 'Median end-to-end workflow wall-clock (generation, validation, approval, execution, analysis).' }),
    valueMetric('latency.totalP90Ms', s.latencyMs.total.p90, { unit: 'ms', kind, higherIsBetter: false, status: s.latencyMs.total.n ? insufficient(s.latencyMs.total.n) : 'unavailable', source: 'runner wall-clock', definition: 'Nearest-rank 90th percentile of workflow wall-clock.' }),
    valueMetric('latency.modelMedianMs', mockModel ? null : s.latencyMs.model.median, { unit: 'ms', kind, higherIsBetter: false, status: mockModel ? 'not-run' : s.latencyMs.model.n ? insufficient(s.latencyMs.model.n) : 'unavailable', source: 'llm-usage.json latencyMs', definition: 'Median per-workflow model latency (sum over model steps, including retries and backoff).' }),
    valueMetric('latency.playwrightMedianMs', s.latencyMs.playwright.median, { unit: 'ms', kind, higherIsBetter: false, status: s.latencyMs.playwright.n ? insufficient(s.latencyMs.playwright.n) : 'unavailable', source: 'evidence.json startedAt/finishedAt', definition: 'Median Playwright runner wall-clock per executed workflow.' }),
    valueMetric('latency.validationMedianMs', s.latencyMs.validation.median, { unit: 'ms', kind, higherIsBetter: false, status: s.latencyMs.validation.n ? insufficient(s.latencyMs.validation.n) : 'unavailable', source: 'manifest step timestamps (generate -> validate-artifacts)', definition: 'Median static-validation time (path, AST, type-check, lint) per workflow.' }),
    valueMetric('latency.analysisMedianMs', s.latencyMs.analysis.median, { unit: 'ms', kind, higherIsBetter: false, status: s.latencyMs.analysis.n ? insufficient(s.latencyMs.analysis.n) : 'unavailable', source: 'manifest step timestamps (collect-evidence -> analyse-failures)', definition: 'Median failure-analysis time per workflow (rule-based; no model analysis in this mode).' }),
    valueMetric('cost.inputTokens', s.tokens.input, { unit: 'count', kind, source: 'provider usage', status: s.tokens.available ? 'ok' : 'unavailable', definition: 'Input tokens reported by the provider (unavailable if any call lacked usage data).' }),
    valueMetric('cost.outputTokens', s.tokens.output, { unit: 'count', kind, source: 'provider usage', status: s.tokens.available ? 'ok' : 'unavailable', definition: 'Output tokens reported by the provider.' }),
    valueMetric('cost.medianPerWorkflowUsd', s.cost.perWorkflowUsd?.median ?? null, { unit: 'usd', kind, higherIsBetter: false, status: s.cost.status === 'ok' ? insufficient(s.workflows) : 'unavailable', source: `eval/pricing.json (${s.cost.pricingEffectiveDate})`, definition: 'Median per-workflow cost = sum over calls of reported tokens x list price.' }),
    valueMetric('cost.perSuccessfulWorkflowUsd', s.cost.perSuccessfulWorkflowUsd, { unit: 'usd', kind, higherIsBetter: false, status: s.cost.status === 'ok' ? 'ok' : 'unavailable', source: `eval/pricing.json (${s.cost.pricingEffectiveDate})`, definition: 'Total cost / workflows that completed.' }),
  ];
  const med = s.latencyMs.total.median;
  const findings: Finding[] = med === null ? [] : ms.filter((m) => m.totalMs > 2 * med).map((m) => ({ type: 'latency-outlier', id: m.caseId, detail: `${Math.round(m.totalMs)} ms vs median ${Math.round(med)} ms`, source: 'measured' }));
  return { metrics, findings, detail: { summary: s, workflows: ms } };
}

/* -------------------------------- modes -------------------------------- */

async function deterministicMode(dataset: Dataset, policy: Policy) {
  const planning: PlanningResult[] = [];
  for (const c of dataset.planning.cases) planning.push(await evaluatePlanningCase(c, recordedProvider('test-plan', c.recordedOutput)));
  const generation: GenerationResult[] = [];
  for (const c of dataset.generation.cases) generation.push(await evaluateGenerationCase(c, recordedProvider('test-generation', c.recordedOutput), `eval-${c.id.toLowerCase()}`));
  const p = planningSection(dataset.planning.cases, planning, 'deterministic');
  const g = generationSection(generation, 'deterministic');
  const a = await analysisSection(dataset);
  const f = await faultSection(policy);
  const passed = countWhere(planning, (r) => r.pass) + countWhere(generation, (r) => r.pass) + countWhere(f.detail.results, (r) => r.pass) + (a.rows.execution - a.rows.failedRows);
  const total = planning.length + generation.length + f.detail.results.length + a.rows.execution;
  return {
    metrics: [...p.metrics, ...g.metrics, ...a.metrics, ...f.metrics],
    findings: [...p.findings, ...g.findings, ...a.findings, ...f.findings],
    sections: { planning: p.detail, generation: g.detail, assertionQuality: { ruleAgreement: g.detail.assertionRuleAgreement }, evidence: a.detail.execution, failureAnalysis: a.detail.analysis, recovery: f.detail },
    summary: { casesEvaluated: total, passed, failed: total - passed, inconclusive: 0 },
    gates: [
      gate('deterministic-expectations', [...planning, ...generation].every((r) => r.pass), `${countWhere([...planning, ...generation], (r) => !r.pass)} planning/generation case(s) with unmet expectations`),
      gate('no-false-passes', a.detail.execution.metrics.falsePasses === 0 && a.detail.execution.metrics.phantomEvidenceRefs === 0, `${a.detail.execution.metrics.falsePasses} false pass(es), ${a.detail.execution.metrics.phantomEvidenceRefs} phantom reference(s)`),
      gate('fault-recovery', f.detail.results.every((r) => r.pass), `${countWhere(f.detail.results, (r) => !r.pass)} fault scenario(s) failed`),
    ],
    provider: { name: 'mock', model: 'recorded-dataset-outputs', note: 'Model outputs are hand-written dataset recordings: these metrics evaluate the deterministic pipeline and the evaluator, not a model.' },
    refs: [] as string[],
  };
}

async function functionalMode(dataset: Dataset, policy: Policy, opts: RunOptions) {
  const approver = opts.approver ?? opts.env?.AGENT_EVAL_APPROVER ?? process.env.AGENT_EVAL_APPROVER ?? '';
  // Stricter than the protected policy: defective accounts make some tests wait for elements that never appear.
  const evalPolicy: Policy = { ...policy, execution: { ...policy.execution, testTimeoutMs: Math.min(policy.execution.testTimeoutMs, 15_000) } };
  const r = await evaluateFunctional(dataset.functional, { policy: evalPolicy, approver, env: opts.env ?? process.env, suites: opts.suites, keepRuns: true });
  const m = r.metrics;
  const det = m.detection;
  const dia = m.diagnosis;
  const SRCF = SRC.functional;
  const count = (id: string, v: number, def: string, hib: boolean | null = null): Metric => valueMetric(id, v, { unit: 'count', kind: 'measured', gate: 'exact', higherIsBetter: hib, source: SRCF, definition: def });
  const metrics: Metric[] = [
    count('functional.detection.truePositives', det.tp, 'Relevant seeded defect present and the generated test failed.', true),
    count('functional.detection.falseNegatives', det.fn, 'Relevant seeded defect present but the generated test passed.', false),
    count('functional.detection.falsePositives', det.fp, 'No relevant defect but the generated test failed (false-positive failure).', false),
    count('functional.detection.trueNegatives', det.tn, 'No relevant defect and the generated test passed.', true),
    count('functional.detection.inconclusive', det.inconclusive, 'Cases with no pass/fail outcome (not executed, inconclusive, rejected).', false),
    ratioMetric('functional.detection.recall', det.recall, { kind: 'measured', minDenominator: 10, source: SRCF, definition: 'TP / (TP + FN): share of relevant seeded defects detected by a failing test.' }),
    ratioMetric('functional.detection.falsePositiveRate', det.falsePositiveRate, { kind: 'measured', higherIsBetter: false, minDenominator: 10, source: SRCF, definition: 'FP / (FP + TN): share of defect-free cases where the test still failed.' }),
    ratioMetric('functional.detection.precision', det.precision, { kind: 'measured', minDenominator: 10, source: SRCF, definition: 'TP / (TP + FP): share of test failures that point at a relevant seeded defect.' }),
    ...Object.entries(m.detectionByLayer).flatMap(([layer, d]) => [
      ratioMetric(`functional.layer.${layer}.recall`, d.recall, { kind: 'measured', minDenominator: 10, source: `${SRCF} (layer ${layer})`, definition: `TP / (TP + FN) for ${layer} tests.` }),
      ratioMetric(`functional.layer.${layer}.falsePositiveRate`, d.falsePositiveRate, { kind: 'measured', higherIsBetter: false, minDenominator: 10, source: `${SRCF} (layer ${layer})`, definition: `FP / (FP + TN) for ${layer} tests.` }),
    ]),
    count('functional.diagnosis.truePositives', dia.tp, 'Failed tests caused by a seeded defect that the analysis called product_behavior.', true),
    count('functional.diagnosis.falseNegatives', dia.fn, 'Failed tests caused by a seeded defect that the analysis did not call product_behavior.', false),
    count('functional.diagnosis.falsePositives', dia.fp, 'Failed tests with no defect that the analysis called product_behavior.', false),
    count('functional.diagnosis.trueNegatives', dia.tn, 'Failed tests with no defect that the analysis did not call product_behavior.', true),
    ratioMetric('functional.agreementWithReference', m.functional.agreementWithReference, { kind: 'measured', gate: 'exact', source: SRCF, definition: 'Cases whose pass/fail outcome equals the reference expected outcome / decided cases.' }),
    ratioMetric('functional.passOnDefectFreeControl', m.functional.passOnDefectFreeControl, { kind: 'measured', gate: 'exact', source: SRCF, definition: 'Tests passing on the standard (defect-free) account / tests run on it.' }),
    ratioMetric('functional.falseNegativesFlaggedByAssertionRules', m.functional.falseNegativesFlaggedByAssertionRules, { kind: 'deterministic', gate: 'exact', source: SRCF, definition: 'False negatives whose test the deterministic assertion rules had flagged / false negatives.' }),
  ];
  const cl = costLatencyMetrics(r.workflows.map((w) => w.measurement), 'measured', true, opts.pricing);
  const findings: Finding[] = [
    ...m.functional.falsePositiveFailures.map((id): Finding => ({ type: 'false-positive-failure', id, detail: 'failed on a target where the behaviour under test is correct', source: 'measured' })),
    ...m.functional.falseNegatives.map((id): Finding => ({ type: 'false-negative', id, detail: 'passed although a relevant seeded defect is present', source: 'measured' })),
    ...r.cases.filter((c) => c.observedState === 'failed' && c.relevantDefect && c.diagnosis?.category !== 'product_behavior').map((c): Finding => ({ type: 'incorrect-diagnosis', id: `${c.suiteId}/${c.variant}/${c.scenarioId}`, detail: `seeded defect ${c.defectId}, analysis said ${c.diagnosis?.category ?? 'none'}`, source: 'measured' })),
    ...r.workflows.filter((w) => w.error || w.status !== 'executed').map((w): Finding => ({ type: 'failed-case', id: `${w.suiteId}/${w.variant}`, detail: `workflow ${w.status}${w.error ? `: ${w.error}` : ''}`, source: 'measured' })),
    ...cl.findings,
  ];
  const decided = countWhere(r.cases, (c) => c.matchesReference !== null);
  return {
    metrics: [...metrics, ...cl.metrics],
    findings,
    sections: { functional: { cases: r.cases, workflows: r.workflows, metrics: m, defects: dataset.functional.defects }, costLatency: cl.detail },
    summary: { casesEvaluated: r.cases.length, passed: countWhere(r.cases, (c) => c.matchesReference === true), failed: countWhere(r.cases, (c) => c.matchesReference === false), inconclusive: r.cases.length - decided },
    gates: [
      gate('functional-target-available', det.inconclusive === 0 && r.workflows.every((w) => w.status === 'executed'), `${det.inconclusive} inconclusive case(s); workflow statuses ${[...new Set(r.workflows.map((w) => w.status))].join(', ')}`),
    ],
    provider: { name: 'mock', model: 'pinned-dataset-specs', note: 'Executed tests are pinned, hand-written candidate specs (including deliberately weak and incorrect ones) run through the real Phase 2 pipeline against the demo target. They do not measure a model.' },
    refs: r.workflows.map((w) => `.agent/runs/${w.runId}`),
  };
}

async function healingMode(dataset: Dataset, policy: Policy, opts: RunOptions) {
  const approver = opts.approver ?? opts.env?.AGENT_EVAL_APPROVER ?? process.env.AGENT_EVAL_APPROVER ?? '';
  const r = await evaluateHealing(dataset.healing.cases, { policy, approver, env: opts.env ?? process.env, functional: dataset.functional, cases: opts.cases });
  const m = r.metrics;
  const S = SRC.healing;
  const rate = (id: string, v: typeof m.proposalRate, def: string, o: { hib?: boolean; gate?: Metric['gate'] } = {}) =>
    ratioMetric(id, v, { kind: 'reference-label', gate: o.gate ?? 'exact', higherIsBetter: o.hib ?? true, source: S, definition: def });
  const count = (id: string, v: number, def: string) => valueMetric(id, v, { unit: 'count', kind: 'reference-label', gate: 'exact', higherIsBetter: false, source: S, definition: def });
  const usage = r.results.flatMap((x) => x.usage);
  const tokens = usage.length > 0 && usage.every((u) => u.tokensAvailable);
  const pricing = loadPricing(opts.pricing);
  const metrics: Metric[] = [
    rate('healing.outcomeAgreement', m.outcomeAgreement, 'Cases whose healing outcome equals the reference outcome / cases set up.'),
    rate('healing.proposalRate', m.proposalRate, 'Proposals accepted for validation / attempts the deterministic gate let through (eligible).', { gate: 'none' }),
    rate('healing.verifiedSuccessRate', m.verifiedSuccessRate, 'Verified patches equal to the reference repair / cases whose reference says a repair is expected (eligible, with ground truth). Insufficient-evidence and product-defect cases are reported separately. With recorded proposals this depends on how many recorded proposals are correct, so it describes the dataset, not a model.'),
    rate('healing.correctProposalsVerified', m.correctProposalsVerified, 'Recorded proposals labelled correct that ended verified and equal to the reference repair / proposals labelled correct (does the guarded pipeline let good repairs through?).'),
    rate('healing.incorrectHealingRate', m.incorrectHealingRate, 'Verified patches that are not the reference repair / verified patches.', { hib: false }),
    rate('healing.incorrectProposalsBlocked', m.incorrectProposalsBlocked, 'Proposals labelled incorrect that did not end verified / proposals labelled incorrect.'),
    rate('healing.regressionRate', m.regressionRate, 'Verified patches whose before/after regression run had new failures / verified patches.', { hib: false }),
    rate('healing.intentViolationRate', m.intentViolationRate, 'Verified patches failing the independent patch-text intent check (assertion removed or rewritten, files outside the allowed areas) / verified patches.', { hib: false }),
    rate('healing.falseHealingOfProductDefects', m.falseHealingOfProductDefects, 'Product-defect cases that ended verified or approved / product-defect cases.', { hib: false }),
    rate('healing.productDefectsStoppedBeforeModel', m.productDefectsStoppedBeforeModel, 'Product-defect cases stopped by the deterministic gate before any model call / product-defect cases.'),
    rate('healing.insufficientEvidenceCorrectlyRejected', m.insufficientEvidenceCorrectlyRejected, 'Cases the reference marks insufficient-evidence that ended insufficient_evidence / such cases.'),
    rate('healing.manualInterventionRate', m.manualInterventionRate, 'Attempts that produced no verified patch, so a person must act without one / attempts set up. Every verified patch still needs a review.', { gate: 'none', hib: false }),
    valueMetric('healing.reviewAcceptanceRate', null, { unit: 'ratio', kind: 'measured', status: 'unavailable', source: 'heal-approve decisions', definition: 'Verified patches a person approved / verified patches reviewed. No human review decisions exist in the evaluation.' }),
    count('healing.unsafe.verifiedProductDefects', m.unsafe.verifiedProductDefects, 'Product-defect cases that ended with a verified or approved patch (must be 0).'),
    count('healing.unsafe.intentViolations', m.unsafe.intentViolations, 'Verified patches that remove or rewrite an assertion according to the independent patch check (must be 0).'),
    count('healing.unsafe.incorrectVerified', m.unsafe.incorrectVerified, 'Verified patches that are not the reference repair (must be 0).'),
    valueMetric('healing.setupErrors', m.setupErrors, { unit: 'count', kind: 'measured', gate: 'exact', higherIsBetter: false, source: S, definition: 'Cases that could not be set up (e.g. the generated test did not fail); excluded from every rate.' }),
    valueMetric('healing.attemptMedianMs', m.durationMs.median, { unit: 'ms', kind: 'measured', higherIsBetter: false, status: m.durationMs.n >= 20 ? 'ok' : m.durationMs.n ? 'insufficient-data' : 'unavailable', source: 'wall-clock per healing attempt', definition: 'Median wall-clock of one healing attempt (reproduction, gate, proposal, validation, verification, regression).' }),
    valueMetric('healing.attemptP90Ms', m.durationMs.p90, { unit: 'ms', kind: 'measured', higherIsBetter: false, status: m.durationMs.n >= 20 ? 'ok' : m.durationMs.n ? 'insufficient-data' : 'unavailable', source: 'wall-clock per healing attempt', definition: 'Nearest-rank 90th percentile of healing-attempt wall-clock.' }),
    valueMetric('healing.modelCalls', usage.reduce((n, u) => n + u.attempts, 0), { unit: 'count', kind: 'measured', source: 'heal-record usage', definition: 'Proposal-request attempts across all cases, including retries.' }),
    valueMetric('healing.costPerAttemptUsd', null, {
      unit: 'usd', kind: 'measured', higherIsBetter: false, status: 'unavailable', source: `pricing ${pricing.effectiveDate}`,
      definition: tokens ? 'Total proposal cost / attempts.' : 'Unavailable: the recorded (mock) provider reports no token usage, so no cost is estimated.',
    }),
  ];
  const findings: Finding[] = [
    ...r.results.filter((x) => !x.outcomeMatchesReference).map((x): Finding => ({ type: 'healing-mismatch', id: x.id, detail: `expected ${x.expectedOutcome}, got ${x.outcome}${x.error ? `: ${x.error}` : ''}`, source: 'reference-label' })),
    ...r.results.filter((x) => (x.verified && (!x.correctRepair || x.independentIntent?.ok === false)) || (x.cause === 'product-defect' && x.verified)).map((x): Finding => ({ type: 'unsafe-healing', id: x.id, detail: `verified patch is unsafe: correct=${x.correctRepair}, intent=${x.independentIntent?.detail ?? 'n/a'}`, source: 'reference-label' })),
  ];
  return {
    metrics,
    findings,
    sections: { healing: { cases: r.results, metrics: m } },
    summary: { casesEvaluated: r.results.length, passed: countWhere(r.results, (x) => x.outcomeMatchesReference), failed: countWhere(r.results, (x) => !x.outcomeMatchesReference && x.outcome !== 'error'), inconclusive: m.setupErrors },
    gates: [gate('healing-cases-set-up', m.setupErrors === 0, `${m.setupErrors} case(s) could not be set up`)],
    provider: { name: 'mock', model: 'recorded-heal-proposals', note: 'Proposals are recorded dataset replies (correct and deliberately wrong); everything else ran for real. These results measure the guarded pipeline, not how often a model proposes a good repair.' },
    refs: [] as string[],
  };
}

async function liveMode(dataset: Dataset, opts: RunOptions) {
  const provider = opts.provider ?? new AnthropicProvider(anthropicConfigFromEnv(opts.env));
  const repeat = opts.repeat ?? 1;
  const liveCases = dataset.planning.cases.filter((c) => c.liveApplicable);
  const measurements: WorkflowMeasurement[] = [];
  const allPlanning: PlanningResult[][] = [];
  const allGeneration: GenerationResult[] = [];
  const judgeRows: Array<{ caseId: string; scenarioId: string; index: number; verdict: string; ruleFlags: string[] }> = [];
  for (let rep = 0; rep < repeat; rep++) {
    const results: PlanningResult[] = [];
    for (const c of liveCases) {
      const started = Date.now();
      // Live: outcome expectations from recorded output do not apply; only requirement-level ones.
      const liveCase = { ...c, expected: { ...c.expected, outcome: ['invalid_requirement', 'needs_clarification'].includes(c.expected.outcome) ? c.expected.outcome : 'plan_valid', issueCodes: undefined, coverage: undefined, assumptionScenarios: undefined, modelCalls: undefined } } as typeof c;
      const pr = await evaluatePlanningCase(liveCase, provider, undefined);
      results.push(pr);
      const usage: UsageRecord[] = pr.usage ? [pr.usage] : [];
      const again = pr.planned ? { req: pr.planned.requirement, scenarios: pr.planned.traceableScenarios } : undefined;
      if (again) {
        const gen = await generateSpecs(again.req, again.scenarios, provider);
        usage.push(gen.usage);
        if (gen.ok) {
          const rendered = await renderAndValidate(gen.accepted, `eval-live-${c.id.toLowerCase()}-${rep}`);
          const findings = gen.accepted.flatMap((s) => assertionFindings(s, again.scenarios.find((x) => x.id === s.scenarioId), again.req));
          allGeneration.push({ id: `${c.id}#${rep}`, category: c.category, schemaValid: true, checks: [], pass: true, rendered, specDecisions: { correct: gen.accepted.length, total: gen.output.tests.length }, assertionFindings: findings, ruleVsLabel: [], requiredAssertions: { required: 0, satisfied: 0, missing: [] }, usage: gen.usage });
          if (opts.judge) {
            for (const spec of gen.accepted) {
              const verdict = await judgeAssertions(opts.judge, provider, { requirement: again.req, scenario: again.scenarios.find((x) => x.id === spec.scenarioId), spec });
              if (verdict.ok) {
                for (const v of verdict.verdict.assertions) judgeRows.push({ caseId: c.id, scenarioId: spec.scenarioId, index: v.index, verdict: v.verdict, ruleFlags: findings.filter((f) => f.scenarioId === spec.scenarioId).map((f) => f.rule) });
              }
              if (verdict.usage) usage.push(verdict.usage);
            }
          }
        } else {
          allGeneration.push({ id: `${c.id}#${rep}`, category: c.category, schemaValid: false, checks: [], pass: false, rendered: [], specDecisions: { correct: 0, total: 0 }, assertionFindings: [], ruleVsLabel: [], requiredAssertions: { required: 0, satisfied: 0, missing: [] } });
        }
      }
      measurements.push({ workflowId: `${c.id}#${rep}`, caseId: c.id, usage, totalMs: Date.now() - started, playwrightMs: null, succeeded: pr.outcome === liveCase.expected.outcome });
    }
    allPlanning.push(results);
  }
  const last = allPlanning[allPlanning.length - 1];
  const p = planningSection(liveCases, last, 'measured');
  const g = generationSection(allGeneration, 'measured');
  const a = await analysisSection(dataset, provider);
  const cl = costLatencyMetrics(measurements, 'measured', provider.name === 'mock', opts.pricing);
  // Variability across repeats: share of cases with the same outcome every time.
  const consistent = liveCases.filter((_c, i) => new Set(allPlanning.map((rs) => rs[i].outcome)).size === 1).length;
  const metrics: Metric[] = [...p.metrics, ...g.metrics, ...a.metrics, ...cl.metrics];
  if (repeat > 1) metrics.push(ratioMetric('live.outcomeConsistencyAcrossRepeats', ratio(consistent, liveCases.length), { kind: 'measured', source: 'repeated live runs', definition: 'Live cases with the same workflow outcome in every repeat / live cases.' }));
  if (opts.judge) {
    metrics.push(ratioMetric('assertion.judge.flaggedWeak', ratio(countWhere(judgeRows, (r) => r.verdict !== 'adequate'), judgeRows.length), { kind: 'ai-judgment', higherIsBetter: false, source: `judge ${opts.judge.name}/${opts.judge.model}`, definition: 'Assertions the semantic judge called weak, unrelated or incorrect / judged assertions. Advisory; not a gate.' }));
  }
  return {
    metrics,
    findings: [...p.findings, ...g.findings, ...a.findings, ...cl.findings],
    sections: { planning: { ...p.detail, repeats: allPlanning }, generation: g.detail, failureAnalysis: a.detail.analysis, costLatency: cl.detail, judge: opts.judge ? { rows: judgeRows } : null },
    summary: { casesEvaluated: last.length, passed: countWhere(last, (r) => r.pass), failed: countWhere(last, (r) => !r.pass), inconclusive: 0 },
    gates: [] as Gate[],
    provider: { name: provider.name, model: provider.model, note: provider.name === 'mock' ? 'A mock provider stood in for the live model: these are not real model results.' : 'Live model outputs; results vary between runs.' },
    refs: [] as string[],
  };
}

/** Replace the repository path, the home directory and known secret values in serialized report text. */
export function sanitize(json: string): string {
  const esc = (s: string) => JSON.stringify(s).slice(1, -1);
  let out = json.split(esc(REPO_ROOT)).join('<repo>');
  const home = os.homedir();
  if (home.length > 1) out = out.split(esc(home)).join('<home>');
  return redact(out);
}

function gate(name: string, ok: boolean, detail: string): Gate {
  return { name, status: ok ? 'pass' : 'fail', detail };
}

/* -------------------------------- runner -------------------------------- */

export async function runEvaluation(opts: RunOptions): Promise<{ report: EvaluationReport; dir: string; exitCode: number }> {
  const now = (opts.now ?? (() => new Date()))();
  const id = runId(opts.mode, now);
  const policy = loadPolicy(REPO_ROOT);
  const dataset = loadDataset();
  const result =
    opts.mode === 'deterministic' ? await deterministicMode(dataset, policy)
    : opts.mode === 'functional' ? await functionalMode(dataset, policy, opts)
    : opts.mode === 'healing' ? await healingMode(dataset, policy, opts)
    : await liveMode(dataset, opts);

  // Invariant: AI judgments never gate.
  const metrics = result.metrics.map((m) => (m.kind === 'ai-judgment' ? { ...m, gate: 'none' as const } : m));
  const limitations = [
    `${dataset.labelReview.humanReviewed} of ${dataset.labelReview.total} reference labels are human-reviewed; the rest are author-assigned (by the AI assistant that built the framework) and pending review.`,
    'Datasets are small: rates with fewer than 10 cases in the denominator are marked insufficient-data, and percentiles from fewer than 20 samples are not distributions.',
    'The test target is a public demo site with no version identifier; seeded defects are its intentionally broken accounts, verified by eval/probes/seeded-defects.ts.',
    'The failure classifier treats an expected value as coming from the requirement when it appears anywhere in the criterion text (substring), which can turn an incorrect assertion into a product_behavior diagnosis.',
    'Live-provider evaluation has not been run in this repository (no credentials); no model-quality, token or cost figures exist yet.',
  ];
  if (opts.mode === 'deterministic') limitations.push('Deterministic mode replays hand-written model outputs: it verifies the pipeline and the evaluator, not model quality.');
  if (opts.mode === 'healing') limitations.push('Healing mode replays recorded proposals (correct and deliberately wrong); rates describe the guarded pipeline on 15 constructed cases, not model repair quality.', 'Failure modes come from example-app/server.ts variants; real-world drift and flakiness are more varied.', 'No human review decisions exist, so review acceptance is unavailable.');
  if (opts.mode === 'functional') limitations.push('Functional mode executes pinned hand-written candidate specs; detection rates describe those specs and the pipeline, not what a model would generate.', 'Functional runs use a 15 s test timeout (stricter than the policy) so stuck pages fail fast.');

  const report: EvaluationReport = {
    schemaVersion: 1,
    metadata: {
      runId: id,
      timestamp: now.toISOString(),
      mode: opts.mode,
      datasetVersion: dataset.manifest.datasetVersion,
      datasetSha256: dataset.sha256,
      agent: gitInfo(),
      promptVersion: PROMPT_VERSION,
      promptSha256: promptSha(),
      provider: result.provider,
      judge: opts.judge ? { name: opts.judge.name, model: opts.judge.model } : null,
      metricVersion: METRIC_IMPLEMENTATION_VERSION,
      config: { policyExecution: policy.execution, policyHealing: policy.healing, repeat: opts.repeat ?? 1, suites: opts.suites ?? 'all', cases: opts.cases ?? 'all', baseline: opts.baseline ?? null, pricing: opts.pricing ?? 'eval/pricing.json', gates: opts.gates ?? 'eval/gates.json' },
      target: dataset.functional.target,
      labelReview: dataset.labelReview,
      executionRefs: result.refs,
      repeat: opts.repeat ?? 1,
    },
    summary: {
      ...result.summary,
      datasetSize: {
        planningCases: dataset.planning.cases.length,
        generationCases: dataset.generation.cases.length,
        functionalReferenceOutcomes: dataset.functional.suites.reduce((n, s) => n + Object.values(s.variants).flat().length, 0),
        labelledFailures: dataset.failures.cases.filter((c) => c.label !== null).length,
        reportControls: dataset.failures.cases.filter((c) => c.label === null).length,
        healingCases: dataset.healing.cases.length,
      },
    },
    metrics,
    sections: result.sections as Record<string, unknown>,
    findings: result.findings,
    // Configured threshold gates (eval/gates.json), safety gates included.
    gates: [...evaluateGates(loadGateConfig(opts.gates), opts.mode, metrics), ...result.gates],
    limitations,
  };

  if (opts.baseline) {
    const base = loadReport(opts.baseline);
    const cmp = compareReports(base, report);
    if (cmp.datasetChanged) {
      // A new dataset version needs a new, reviewed baseline; changed metrics are listed in the comparison.
      report.gates.push({ name: 'baseline-regression', status: 'not-applicable', detail: `dataset ${base.metadata.datasetVersion} -> ${report.metadata.datasetVersion}: rebaseline required; see sections.comparison` });
    } else {
      report.gates.push(gate('baseline-regression', cmp.gatedRegressions.length === 0, cmp.gatedRegressions.length === 0 ? `no gated regressions vs ${base.metadata.runId}` : cmp.gatedRegressions.map((c) => `${c.id}: ${c.before} -> ${c.after}`).join('; ')));
    }
    report.sections.comparison = cmp;
  } else {
    report.gates.push({ name: 'baseline-regression', status: 'not-applicable', detail: 'no baseline given' });
  }
  // Reports are shareable artefacts: strip local paths and known secrets before validating and writing.
  const sanitized = JSON.parse(sanitize(JSON.stringify(report))) as EvaluationReport;
  Object.assign(report, sanitized);
  const valid = ReportSchema.safeParse(report);
  report.gates.push(gate('report-schema', valid.success, valid.success ? 'report matches ReportSchema' : valid.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')));

  const dir = path.join(opts.outDir ?? path.join(REPO_ROOT, 'eval-results'), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(path.join(dir, 'summary.md'), renderSummary(report));
  copyFileSync(path.join(dir, 'report.json'), path.join(path.dirname(dir), `latest-${opts.mode}.json`));
  const exitCode = report.gates.some((g) => g.status === 'fail') ? 1 : 0;
  return { report, dir, exitCode };
}

/* ---------------------------------- CLI ---------------------------------- */

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: 'string', default: 'deterministic' },
      baseline: { type: 'string' },
      out: { type: 'string' },
      repeat: { type: 'string' },
      suite: { type: 'string', multiple: true },
      compare: { type: 'boolean' },
      'judge-model': { type: 'string' },
      case: { type: 'string', multiple: true },
      pricing: { type: 'string' },
      gates: { type: 'string' },
    },
  });
  if (values.compare) {
    if (positionals.length !== 2) throw new Error('usage: --compare <before.json> <after.json>');
    const cmp = compareReports(loadReport(positionals[0]), loadReport(positionals[1]));
    process.stdout.write(renderComparison(cmp) + '\n');
    return cmp.gatedRegressions.length === 0 ? 0 : 1;
  }
  const mode = values.mode as Mode;
  if (!['deterministic', 'functional', 'live', 'healing'].includes(mode)) throw new Error(`unknown mode ${mode}`);
  if (mode === 'live' && process.env.AGENT_LIVE_EVAL !== '1') {
    process.stderr.write('Set AGENT_LIVE_EVAL=1 to run the live evaluation (it calls a paid model API).\n');
    return 2;
  }
  const judge = values['judge-model'] ? new AnthropicProvider({ ...anthropicConfigFromEnv(), model: values['judge-model'] }) : undefined;
  const { report, dir, exitCode } = await runEvaluation({
    mode,
    baseline: values.baseline,
    outDir: values.out,
    repeat: values.repeat ? Number(values.repeat) : undefined,
    suites: values.suite,
    cases: values.case,
    pricing: values.pricing,
    gates: values.gates,
    judge,
  });
  process.stdout.write(renderSummary(report).split('## Findings')[0]);
  process.stdout.write(`\nreport: ${path.relative(REPO_ROOT, path.join(dir, 'report.json'))}\nsummary: ${path.relative(REPO_ROOT, path.join(dir, 'summary.md'))}\n`);
  return exitCode;
}

if (require.main === module) {
  main().then(
    (c) => process.exit(c),
    (e: unknown) => {
      process.stderr.write(String(e instanceof Error ? e.stack : e) + '\n');
      process.exit(1);
    },
  );
}

