import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  evaluateAnalysis,
  evaluateExecution,
  evaluateGenerationCase,
  evaluatePlanningCase,
  generationMetrics,
  loadFailureLabels,
  loadGenerationCases,
  loadPlanningCases,
  planningMetrics,
  recordedProvider,
} from './evaluate';
import { formatRatio, type Ratio } from './metrics';

/**
 * Deterministic evaluation. Model responses are the hand-written recordings
 * in eval/dataset, so this measures the pipeline's validators, renderer,
 * evidence parsing and rule-based analysis, not model quality.
 * Exits non-zero if any case expectation fails or any false pass appears.
 */
async function main(): Promise<number> {
  const planningCases = loadPlanningCases();
  const planning = [];
  for (const c of planningCases) planning.push(await evaluatePlanningCase(c, recordedProvider('test-plan', c.recordedOutput)));

  const generationCases = loadGenerationCases();
  const generation = [];
  for (const c of generationCases) {
    generation.push(await evaluateGenerationCase(c, recordedProvider('test-generation', c.recordedOutput), `eval-${c.id.toLowerCase()}`));
  }

  const labels = loadFailureLabels();
  const execution = evaluateExecution(labels);
  const analysis = evaluateAnalysis(labels);

  const report = {
    kind: 'deterministic',
    generatedAt: new Date().toISOString(),
    dataset: { planningCases: planningCases.length, generationCases: generationCases.length, executionCases: labels.length, labelledFailures: analysis.rows.length },
    planning: { metrics: planningMetrics(planningCases, planning), cases: planning },
    generation: { metrics: generationMetrics(generation), cases: generation },
    execution,
    analysis,
    limitations: [
      'Planning and generation inputs are hand-written stand-ins for model output. These numbers measure the deterministic pipeline, not any model.',
      'Execution and analysis use 8 genuine Playwright reports from one demo target; the sample is far too small for statistical claims.',
      'Failure-analysis labels come from how each failure was constructed; there is one labeller and no inter-rater agreement.',
    ],
  };

  const outDir = path.join(REPO_ROOT, 'eval-results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'deterministic.json'), JSON.stringify(report, null, 2) + '\n');

  const line = (k: string, v: Ratio | number | null | string) =>
    `  ${k.padEnd(34)} ${typeof v === 'object' && v !== null ? formatRatio(v) : v === null ? 'n/a' : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : v}`;
  const out: string[] = ['Relynx deterministic evaluation', ''];
  out.push('Planning');
  for (const [k, v] of Object.entries(report.planning.metrics)) out.push(line(k, v as Ratio));
  out.push('Generation');
  for (const [k, v] of Object.entries(report.generation.metrics)) out.push(line(k, v as Ratio));
  out.push('Execution evidence');
  for (const [k, v] of Object.entries(execution.metrics)) out.push(line(k, v as Ratio));
  out.push('Failure analysis (rule-based)');
  for (const [k, v] of Object.entries(analysis.metrics)) if (k !== 'confusion') out.push(line(k, v as Ratio));
  for (const r of analysis.rows) out.push(`    ${r.id} label=${r.label} predicted=${r.predicted} (${r.confidence})${r.agree ? '' : '  <- disagreement'}`);

  const failed = [...planning, ...generation].filter((r) => !r.pass);
  for (const f of failed) out.push(`FAILED ${f.id}: ${f.checks.filter((c) => !c.pass).map((c) => `${c.name} ${c.detail ?? ''}`).join('; ')}`);
  const executionFailures = execution.rows.filter((r) => !r.statusCorrect || !r.associationCorrect || r.falsePass || !r.schemaValid);
  for (const f of executionFailures) out.push(`FAILED ${f.id}: execution evidence mismatch ${JSON.stringify(f)}`);
  out.push('', `report: ${path.relative(REPO_ROOT, path.join(outDir, 'deterministic.json'))}`);
  process.stdout.write(out.join('\n') + '\n');
  return failed.length === 0 && executionFailures.length === 0 && execution.metrics.phantomEvidenceRefs === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (e: unknown) => {
  process.stderr.write(String(e instanceof Error ? e.stack : e) + '\n');
  process.exit(1);
});
