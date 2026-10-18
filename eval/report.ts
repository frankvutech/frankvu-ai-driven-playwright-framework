import { z } from 'zod';
import type { Ratio } from './metrics';
import { formatRatio, wilson } from './metrics';

/**
 * Evaluation report contract. The flat `metrics` list is what comparisons and
 * gates read; `sections` hold the detail each metric is computed from.
 */
export const REPORT_SCHEMA_VERSION = 1;

export const MetricKind = z.enum(['deterministic', 'measured', 'reference-label', 'ai-judgment']);
export type MetricKind = z.infer<typeof MetricKind>;

export const MetricSchema = z
  .object({
    id: z.string().regex(/^[a-z]+(\.[a-zA-Z0-9]+)+$/),
    value: z.number().nullable(),
    numerator: z.number().optional(),
    denominator: z.number().optional(),
    unit: z.enum(['ratio', 'count', 'ms', 'usd']),
    kind: MetricKind,
    higherIsBetter: z.boolean().nullable(),
    /**
     * none: reported only. no-regression: may not move in the worse direction
     * versus the baseline. exact: must equal the baseline (deterministic metrics
     * on fixed inputs, where any change means behaviour changed).
     */
    gate: z.enum(['none', 'no-regression', 'exact']),
    status: z.enum(['ok', 'insufficient-data', 'unavailable', 'not-run']),
    /** 95% Wilson interval for measured proportions: shows uncertainty, not significance. */
    interval: z.object({ low: z.number(), high: z.number() }).strict().optional(),
    definition: z.string().min(10),
    source: z.string().min(3),
  })
  .strict();
export type Metric = z.infer<typeof MetricSchema>;

export const GateSchema = z.object({ name: z.string(), status: z.enum(['pass', 'fail', 'not-applicable']), detail: z.string() }).strict();
export type Gate = z.infer<typeof GateSchema>;

export const FindingSchema = z
  .object({
    type: z.enum([
      'failed-case',
      'incorrect-generated-test',
      'weak-assertion',
      'unsupported-assumption',
      'incorrect-diagnosis',
      'recovery-failure',
      'false-positive-failure',
      'false-negative',
      'latency-outlier',
    ]),
    id: z.string(),
    detail: z.string(),
    source: z.enum(['deterministic', 'measured', 'reference-label', 'ai-judgment']),
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;

export const ReportSchema = z
  .object({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    metadata: z
      .object({
        runId: z.string(),
        timestamp: z.string(),
        mode: z.enum(['deterministic', 'functional', 'live']),
        datasetVersion: z.string(),
        datasetSha256: z.string().regex(/^[0-9a-f]{64}$/),
        agent: z.object({ commit: z.string(), dirty: z.boolean() }).strict(),
        promptVersion: z.string(),
        promptSha256: z.string().regex(/^[0-9a-f]{64}$/),
        provider: z.object({ name: z.string(), model: z.string(), note: z.string() }).strict(),
        judge: z.object({ name: z.string(), model: z.string() }).strict().nullable(),
        metricVersion: z.string(),
        config: z.record(z.string(), z.unknown()),
        target: z.object({ name: z.string(), version: z.string() }).strict(),
        labelReview: z.object({ total: z.number(), humanReviewed: z.number(), byMethod: z.record(z.string(), z.number()) }).strict(),
        executionRefs: z.array(z.string()),
        repeat: z.number().int().min(1),
      })
      .strict(),
    summary: z
      .object({
        casesEvaluated: z.number(),
        passed: z.number(),
        failed: z.number(),
        inconclusive: z.number(),
        datasetSize: z.record(z.string(), z.number()),
      })
      .strict(),
    metrics: z.array(MetricSchema),
    sections: z.record(z.string(), z.unknown()),
    findings: z.array(FindingSchema),
    gates: z.array(GateSchema),
    limitations: z.array(z.string()).min(1),
  })
  .strict();
export type EvaluationReport = z.infer<typeof ReportSchema>;

/** Helper to build a ratio metric with consistent status handling. */
export function ratioMetric(
  id: string,
  r: Ratio,
  o: { kind: MetricKind; definition: string; source: string; gate?: Metric['gate']; higherIsBetter?: boolean; minDenominator?: number },
): Metric {
  const insufficient = r.d === 0 || (o.minDenominator !== undefined && r.d < o.minDenominator);
  return {
    id,
    value: r.value,
    numerator: r.n,
    denominator: r.d,
    unit: 'ratio',
    kind: o.kind,
    higherIsBetter: o.higherIsBetter ?? true,
    gate: o.gate ?? 'none',
    status: r.d === 0 ? 'unavailable' : insufficient ? 'insufficient-data' : 'ok',
    interval: o.kind === 'measured' || o.kind === 'reference-label' ? (wilson(r.n, r.d) ?? undefined) : undefined,
    definition: o.definition,
    source: o.source,
  };
}

export function valueMetric(
  id: string,
  value: number | null,
  o: { unit: Metric['unit']; kind: MetricKind; definition: string; source: string; gate?: Metric['gate']; higherIsBetter?: boolean | null; status?: Metric['status'] },
): Metric {
  return {
    id,
    value,
    unit: o.unit,
    kind: o.kind,
    higherIsBetter: o.higherIsBetter === undefined ? null : o.higherIsBetter,
    gate: o.gate ?? 'none',
    status: o.status ?? (value === null ? 'unavailable' : 'ok'),
    definition: o.definition,
    source: o.source,
  };
}

function fmt(m: Metric): string {
  if (m.value === null) return m.status;
  if (m.unit === 'ratio' && m.numerator === undefined) return `${(m.value * 100).toFixed(1)}%${m.status === 'insufficient-data' ? ' (insufficient data)' : ''}`;
  if (m.unit === 'ratio') {
    const ci = m.interval ? ` [95% CI ${(m.interval.low * 100).toFixed(0)}–${(m.interval.high * 100).toFixed(0)}%]` : '';
    return formatRatio({ n: m.numerator ?? 0, d: m.denominator ?? 0, value: m.value }) + ci + (m.status === 'insufficient-data' ? ' (insufficient data)' : '');
  }
  if (m.unit === 'ms') return `${Math.round(m.value)} ms`;
  if (m.unit === 'usd') return `$${m.value.toFixed(4)}`;
  return String(m.value);
}

/** Concise human-readable summary. Failed cases and limitations are always listed. */
export function renderSummary(r: EvaluationReport): string {
  const m = r.metadata;
  const out: string[] = [
    `# Relynx evaluation ${m.runId}`,
    '',
    `Mode **${m.mode}** · dataset ${m.datasetVersion} (\`${m.datasetSha256.slice(0, 12)}\`) · agent \`${m.agent.commit.slice(0, 10)}\`${m.agent.dirty ? ' (uncommitted changes)' : ''} · prompts ${m.promptVersion} · metrics ${m.metricVersion}`,
    `Provider: ${m.provider.name}/${m.provider.model}. ${m.provider.note}`,
    `Labels: ${m.labelReview.humanReviewed} of ${m.labelReview.total} human-reviewed.`,
    '',
    `Cases evaluated ${r.summary.casesEvaluated}: ${r.summary.passed} met expectations, ${r.summary.failed} did not, ${r.summary.inconclusive} inconclusive.`,
    '',
    '## Gates',
    '',
    ...r.gates.map((g) => `- **${g.status.toUpperCase()}** ${g.name}: ${g.detail}`),
    '',
    '## Metrics',
    '',
    '| Metric | Value | Kind | Gate |',
    '|---|---|---|---|',
    ...r.metrics.map((x) => `| ${x.id} | ${fmt(x)} | ${x.kind} | ${x.gate === 'none' ? '' : x.gate} |`),
    '',
  ];
  if (r.findings.length) {
    out.push('## Findings', '');
    for (const f of r.findings) out.push(`- [${f.type}] **${f.id}** ${f.detail.replace(/\n/g, ' ')} _(${f.source})_`);
    out.push('');
  }
  out.push('## Limitations', '', ...r.limitations.map((l) => `- ${l}`), '');
  return out.join('\n');
}
