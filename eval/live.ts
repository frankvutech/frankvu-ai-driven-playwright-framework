import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AnthropicProvider } from '../src/agent/llm/anthropic';
import { anthropicConfigFromEnv } from '../src/agent/config/llm';
import type { UsageRecord } from '../src/agent/llm/structured';
import { generateSpecs, planRequirement } from '../src/agent/workflow/generate';
import { renderSpec } from '../src/agent/generation/render';
import { validateArtifacts } from '../src/agent/validation/artifacts';
import { REPO_ROOT, hasContentAssertion, loadPlanningCases } from './evaluate';
import { countWhere, formatRatio, mean, ratio } from './metrics';

/**
 * Live-provider evaluation. Runs the planning dataset's requirements through
 * a real model, then generation and static validation for valid plans. It
 * never executes generated tests (that needs human approval). Requires
 * RELYNX_LIVE_EVAL=1 and Anthropic credentials; costs money per run.
 */
async function main(): Promise<number> {
  if (process.env.RELYNX_LIVE_EVAL !== '1') {
    process.stderr.write('Set RELYNX_LIVE_EVAL=1 to run the live evaluation (it calls a paid model API).\n');
    return 2;
  }
  const config = anthropicConfigFromEnv();
  const provider = new AnthropicProvider(config);
  const cases = loadPlanningCases().filter((c) => c.category !== 'malformed_output');
  const rows = [];
  const usage: UsageRecord[] = [];

  for (const c of cases) {
    const planned = await planRequirement(c.requirement, provider);
    if ('usage' in planned) usage.push(planned.usage);
    const row: Record<string, unknown> = { id: c.id, category: c.category, expectedOutcome: c.expected.outcome, outcome: planned.outcome };
    if (planned.outcome === 'plan_valid' || planned.outcome === 'plan_rejected') {
      row.scenarios = planned.plan.scenarios.length;
      row.traceable = planned.check.traceableScenarioIds.length;
      row.assumptionScenarios = planned.check.assumptionScenarioIds.length;
      row.coverage = planned.req.acceptanceCriteria.length ? planned.check.coverage.covered.length / planned.req.acceptanceCriteria.length : 1;
      row.ambiguitiesRaised = planned.plan.ambiguities.length + planned.plan.scenarios.reduce((n, s) => n + s.openQuestions.length, 0);
      row.planErrors = planned.check.issues.filter((i) => i.severity === 'error').map((i) => i.code);
    }
    if (planned.outcome === 'plan_valid') {
      const scenarios = planned.plan.scenarios.filter((s) => planned.check.traceableScenarioIds.includes(s.id));
      const gen = await generateSpecs(planned.req, scenarios, provider);
      usage.push(gen.usage);
      row.generationOk = gen.ok;
      if (gen.ok) {
        row.specs = gen.output.tests.length;
        row.specsAccepted = gen.accepted.length;
        row.contentAssertions = countWhere(gen.accepted, hasContentAssertion);
        const scratch = `eval-live-${c.id.toLowerCase()}`;
        const files: Record<string, { requirementId: string; scenarioId: string }> = {};
        mkdirSync(path.join(REPO_ROOT, 'generated', scratch), { recursive: true });
        try {
          for (const spec of gen.accepted) {
            const rel = path.posix.join('generated', scratch, `${spec.scenarioId}.spec.ts`);
            writeFileSync(path.join(REPO_ROOT, rel), renderSpec(spec, scratch));
            files[rel] = { requirementId: spec.requirementId, scenarioId: spec.scenarioId };
          }
          const v = gen.accepted.length ? await validateArtifacts({ repoRoot: REPO_ROOT, generationArea: 'generated', files, workspaceBefore: [], workspaceAfter: [] }) : undefined;
          row.staticallyValid = v ? Object.values(v.files).filter((f) => f.length === 0).length : 0;
        } finally {
          rmSync(path.join(REPO_ROOT, 'generated', scratch), { recursive: true, force: true });
        }
      }
    }
    rows.push(row);
    process.stdout.write(`${c.id} ${String(row.outcome)}\n`);
  }

  const valid = rows.filter((r) => r.outcome === 'plan_valid');
  const metrics = {
    outcomeMatchesDatasetExpectation: ratio(countWhere(rows, (r) => r.outcome === r.expectedOutcome), rows.length),
    planSchemaValidity: ratio(countWhere(rows, (r) => r.outcome !== 'plan_failed'), countWhere(rows, (r) => r.outcome !== 'needs_clarification' && r.outcome !== 'invalid_requirement')),
    meanCoverage: mean(valid.map((r) => r.coverage as number)),
    scenarioTraceability: ratio(rows.reduce((n, r) => n + ((r.traceable as number) ?? 0), 0), rows.reduce((n, r) => n + ((r.scenarios as number) ?? 0), 0)),
    specAcceptance: ratio(rows.reduce((n, r) => n + ((r.specsAccepted as number) ?? 0), 0), rows.reduce((n, r) => n + ((r.specs as number) ?? 0), 0)),
    staticValidity: ratio(rows.reduce((n, r) => n + ((r.staticallyValid as number) ?? 0), 0), rows.reduce((n, r) => n + ((r.specsAccepted as number) ?? 0), 0)),
  };
  const report = {
    kind: 'live',
    model: config.model,
    effort: config.effort,
    generatedAt: new Date().toISOString(),
    metrics,
    rows,
    usage,
    limitations: ['One sample per case; model output varies between runs.', 'Generated tests are not executed here.', `${rows.length} cases is too small for reliability claims.`],
  };
  mkdirSync(path.join(REPO_ROOT, 'eval-results'), { recursive: true });
  writeFileSync(path.join(REPO_ROOT, 'eval-results', 'live.json'), JSON.stringify(report, null, 2) + '\n');
  for (const [k, v] of Object.entries(metrics)) process.stdout.write(`${k.padEnd(36)} ${typeof v === 'object' && v ? formatRatio(v) : String(v)}\n`);
  return 0;
}

main().then((code) => process.exit(code), (e: unknown) => {
  process.stderr.write(String(e instanceof Error ? e.message : e) + '\n');
  process.exit(1);
});
