import type { Requirement } from '../domain/requirement';
import type { PlanValidation, TestPlan } from '../domain/plan';
import type { RunEvidence } from '../domain/result';
import type { FailureAnalysis } from '../analysis/types';
import type { UsageRecord } from '../llm/structured';
import type { Approval } from '../execution/approval';
import type { RunManifest, RunStore } from './store';
import type { Ambiguities } from './generate';

export interface RunReport {
  runId: string;
  status: RunManifest['status'];
  requirement?: { id: string; title: string; acceptanceCriteria: Array<{ id: string; text: string }> };
  coverage?: PlanValidation['coverage'];
  scenarios: Array<{
    id: string;
    title: string;
    type: string;
    acceptanceCriteriaIds: string[];
    artifact?: { file: string; sha256: string; state: string };
    result?: { status: string; durationMs: number; traceRef?: string; screenshotRefs: string[] };
    analysis?: { category: string; confidence: string; method: string; sufficientEvidence: boolean };
  }>;
  ambiguities?: Ambiguities;
  approval?: { decision: string; approver: string; decidedAt: string };
  execution?: { exitCode: number | null; timedOut: boolean; reportFound: boolean; target: string };
  llmUsage: UsageRecord[];
  disclaimer: string;
}

const DISCLAIMER =
  'A passed result means the generated assertions held during one Playwright run against the approved test target. ' +
  'It does not prove the requirement is fully satisfied. Failure analyses are advisory hypotheses. ' +
  'Generated tests are candidates: they are not part of the protected test suite until a human promotes them through code review.';

export function buildReport(store: RunStore): RunReport {
  const manifest = store.manifest();
  const req = store.read<Requirement>('requirement.json');
  const plan = store.read<TestPlan>('plan.json');
  const check = store.read<PlanValidation>('plan.validation.json');
  const evidence = store.read<RunEvidence>('evidence.json');
  const analyses = store.read<FailureAnalysis[]>('analysis.json') ?? [];
  const approval = store.read<Approval>('approval.json');

  return {
    runId: manifest.runId,
    status: manifest.status,
    requirement: req && { id: req.id, title: req.title, acceptanceCriteria: req.acceptanceCriteria },
    coverage: check?.coverage,
    scenarios: (plan?.scenarios ?? []).map((s) => {
      const artifact = manifest.artifacts.find((a) => a.scenarioId === s.id);
      const test = evidence?.tests.find((t) => t.scenarioId === s.id && t.project === 'agent-generated');
      const analysis = analyses.find((a) => a.scenarioId === s.id);
      return {
        id: s.id,
        title: s.title,
        type: s.type,
        acceptanceCriteriaIds: s.acceptanceCriteriaIds,
        artifact: artifact && { file: artifact.file, sha256: artifact.sha256, state: artifact.state },
        result: test && { status: test.status, durationMs: Math.round(test.durationMs), traceRef: test.traceRef, screenshotRefs: test.screenshotRefs },
        analysis: analysis && {
          category: analysis.diagnosis.category,
          confidence: analysis.diagnosis.confidence,
          method: analysis.method,
          sufficientEvidence: analysis.diagnosis.sufficientEvidence,
        },
      };
    }),
    ambiguities: store.read<Ambiguities>('ambiguities.json'),
    approval: approval && { decision: approval.decision, approver: approval.approver, decidedAt: approval.decidedAt },
    execution: evidence && {
      exitCode: evidence.runner.exitCode,
      timedOut: evidence.runner.timedOut,
      reportFound: evidence.runner.reportFound,
      target: `${evidence.environment.targetName} (${evidence.environment.baseUrlHost})`,
    },
    llmUsage: store.read<UsageRecord[]>('llm-usage.json') ?? [],
    disclaimer: DISCLAIMER,
  };
}

const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderMarkdown(r: RunReport, manifest: RunManifest, analyses: FailureAnalysis[]): string {
  const lines: string[] = [];
  lines.push(`# Relynx run ${r.runId}`, '', `**Status:** ${r.status}`, '');
  if (r.requirement) {
    lines.push(`## Requirement ${r.requirement.id}: ${r.requirement.title}`, '');
    for (const ac of r.requirement.acceptanceCriteria) lines.push(`- **${ac.id}** ${ac.text}`);
    lines.push('');
  }
  if (r.coverage) lines.push(`Acceptance criteria covered: ${r.coverage.covered.join(', ') || 'none'}; uncovered: ${r.coverage.uncovered.join(', ') || 'none'}`, '');

  lines.push('## Workflow', '', '| Step | Status | Detail |', '|---|---|---|');
  for (const s of manifest.steps) lines.push(`| ${s.step} | ${s.status} | ${cell(s.detail)} |`);
  lines.push('');

  if (r.scenarios.length > 0) {
    lines.push('## Traceability', '', '| Scenario | Type | ACs | Artifact state | Result | Analysis |', '|---|---|---|---|---|---|');
    for (const s of r.scenarios) {
      lines.push(
        `| ${s.id} ${cell(s.title)} | ${s.type} | ${s.acceptanceCriteriaIds.join(', ') || '(assumption)'} | ${s.artifact?.state ?? 'not generated'} | ${s.result ? `${s.result.status} (${s.result.durationMs}ms)` : '-'} | ${s.analysis ? `${s.analysis.category} / ${s.analysis.confidence} (${s.analysis.method})` : '-'} |`,
      );
    }
    lines.push('');
  }

  const amb = r.ambiguities;
  if (amb) {
    const items = [
      ...amb.requirementFindings.map((f) => `Requirement (${f.location}): ${f.message}`),
      ...amb.planAmbiguities.map((a) => `Plan: ${a}`),
      ...amb.openQuestions.map((q) => `${q.scenarioId}: ${q.question}`),
      ...amb.assumptions.map((a) => `${a.scenarioId} assumes: ${a.assumption}`),
      ...amb.uncoveredAcceptanceCriteria.map((u) => `${u.id} not covered: ${u.reason}`),
      ...amb.missingCapabilities.map((m) => `${m.scenarioId} needs ${m.proposedObject}: ${m.description}`),
    ];
    if (items.length) {
      lines.push('## Ambiguities, assumptions and gaps (needs human review)', '');
      items.forEach((i) => lines.push(`- ${cell(i)}`));
      lines.push('');
    }
  }

  if (manifest.artifacts.length > 0) {
    lines.push('## Generated artifacts', '');
    for (const a of manifest.artifacts) {
      lines.push(`### ${a.scenarioId} — ${a.state}`, '', `File: \`${a.file}\`${a.sha256 ? `  sha256 \`${a.sha256.slice(0, 16)}…\`` : ''}`, '');
      for (const h of a.history) lines.push(`- ${h.at} ${h.from} → ${h.to} by ${h.actor}: ${cell(h.reason)}`);
      lines.push('');
    }
  }
  if (r.approval) lines.push(`## Human decision`, '', `${r.approval.decision} by ${r.approval.approver} at ${r.approval.decidedAt}`, '');
  if (r.execution) {
    lines.push('## Execution', '', `Target: ${r.execution.target}. Exit code ${r.execution.exitCode}; timed out: ${r.execution.timedOut}; Playwright report found: ${r.execution.reportFound}.`, '');
    for (const s of r.scenarios.filter((x) => x.result)) {
      const refs = [s.result!.traceRef && `trace \`${s.result!.traceRef}\``, ...s.result!.screenshotRefs.map((p) => `screenshot \`${p}\``)].filter(Boolean);
      if (refs.length) lines.push(`- ${s.id}: ${refs.join(', ')}`);
    }
    lines.push('');
  }
  if (analyses.length > 0) {
    lines.push('## Failure analysis (advisory)', '');
    for (const a of analyses) {
      lines.push(`### ${a.scenarioId ?? a.title}`, '', '**Observed (facts from the runner):**', '');
      for (const o of a.observations) lines.push(`- \`${o.id}\` ${o.source}: ${cell(o.text.split('\n').slice(0, 6).join(' / '))}`);
      const d = a.diagnosis;
      lines.push(
        '',
        `**Hypothesis (${a.method}, confidence ${d.confidence}, evidence ${d.evidenceIds.join(', ')}):** ${d.hypothesis}`,
        '',
        `Category: \`${d.category}\`. Evidence sufficient for a conclusion: ${d.sufficientEvidence ? 'yes' : 'no'}.`,
      );
      if (d.alternatives.length) lines.push('', `Alternatives: ${d.alternatives.map((x) => `${x.category} (${x.why})`).join('; ')}`);
      lines.push('', `Next: ${d.nextSteps.join(' ')}`);
      if (a.notes.length) lines.push('', `Notes: ${a.notes.join('; ')}`);
      lines.push('');
    }
  }
  if (r.llmUsage.length) {
    lines.push('## Model usage', '', '| Use case | Provider/model | Attempts | Latency ms | Tokens in/out | Outcome |', '|---|---|---|---|---|---|');
    for (const u of r.llmUsage) lines.push(`| ${u.useCase} | ${u.provider}/${u.model} | ${u.attempts} | ${u.latencyMs} | ${u.inputTokens}/${u.outputTokens} | ${u.outcome} |`);
    lines.push('');
  }
  lines.push('---', '', `_${r.disclaimer}_`, '');
  return lines.join('\n');
}

export function writeReport(store: RunStore): RunReport {
  const report = buildReport(store);
  store.write('report.json', report);
  store.write('report.md', renderMarkdown(report, store.manifest(), store.read<FailureAnalysis[]>('analysis.json') ?? []));
  return report;
}
