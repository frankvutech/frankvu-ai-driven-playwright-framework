import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { UsageRecord } from '../src/agent/llm/structured';
import { countWhere, distribution, ratio, type Distribution, type Ratio } from './metrics';

export const PricingSchema = z
  .object({
    effectiveDate: z.string(),
    currency: z.literal('USD'),
    source: z.string(),
    excludes: z.string(),
    models: z.record(z.string(), z.object({ inputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative() }).strict()),
  })
  .strict();
export type Pricing = z.infer<typeof PricingSchema>;

/** Pricing metadata: eval/pricing.json by default, or a file given with --pricing. Prices change; nothing here is assumed fixed. */
export function loadPricing(file?: string): Pricing {
  return PricingSchema.parse(JSON.parse(readFileSync(file ?? path.join(__dirname, 'pricing.json'), 'utf8')));
}

export type CostResult = { available: true; usd: number } | { available: false; reason: string };

/** Cost of one usage record from reported tokens. Never estimated when tokens are missing. */
export function usageCost(u: UsageRecord, pricing: Pricing): CostResult {
  if (!u.tokensAvailable) return { available: false, reason: `${u.provider} did not report complete token usage` };
  const price = pricing.models[u.model];
  if (!price) return { available: false, reason: `no price for model ${u.model}` };
  return { available: true, usd: (u.inputTokens * price.inputPerMTok + u.outputTokens * price.outputPerMTok) / 1_000_000 };
}

/** One evaluated workflow (one agent run). Times are measured, not estimated. */
export interface WorkflowMeasurement {
  workflowId: string;
  caseId: string;
  usage: UsageRecord[];
  /** Wall-clock of the whole workflow as measured by the evaluation runner. */
  totalMs: number;
  /** Playwright runner wall-clock (adapter start to finish); null when nothing was executed. */
  playwrightMs: number | null;
  succeeded: boolean;
  /** Phase durations derived from the run's own step timestamps (null when the phase did not run). */
  phases?: { validationMs: number | null; analysisMs: number | null };
}

/** Phase durations from manifest step timestamps: no extra instrumentation, so they include only what the workflow records. */
export function phaseDurations(steps: Array<{ step: string; at: string }>): { validationMs: number | null; analysisMs: number | null } {
  const at = (name: string) => {
    const s = steps.find((x) => x.step === name);
    return s ? Date.parse(s.at) : null;
  };
  const between = (from: string, to: string) => {
    const a = at(from);
    const b = at(to);
    return a === null || b === null ? null : b - a;
  };
  return { validationMs: between('generate', 'validate-artifacts'), analysisMs: between('collect-evidence', 'analyse-failures') };
}

export interface CostLatencySummary {
  workflows: number;
  modelCalls: number;
  failureRate: Ratio;
  /** Extra attempts caused by retries, as a share of all attempts. */
  retryOverhead: Ratio;
  providerErrors: number;
  tokens: { available: boolean; input: number | null; output: number | null; workflowsWithCompleteTokens: number };
  latencyMs: { total: Distribution; model: Distribution; playwright: Distribution; validation: Distribution; analysis: Distribution };
  cost: {
    status: 'ok' | 'unavailable';
    reason?: string;
    pricingEffectiveDate: string;
    perWorkflowUsd: Distribution | null;
    totalUsd: number | null;
    perSuccessfulWorkflowUsd: number | null;
    byOperationUsd: Record<string, number> | null;
  };
}

export function summarizeCostLatency(ms: WorkflowMeasurement[], pricing: Pricing): CostLatencySummary {
  const usages = ms.flatMap((m) => m.usage);
  const attempts = usages.reduce((n, u) => n + u.attempts, 0);
  const complete = ms.filter((m) => m.usage.length > 0 && m.usage.every((u) => u.tokensAvailable));
  const tokensAvailable = ms.length > 0 && complete.length === ms.length;
  const costs = ms.map((m) => m.usage.map((u) => usageCost(u, pricing)));
  const allCostAvailable = ms.length > 0 && costs.every((c) => c.length > 0 && c.every((x) => x.available));
  const perWorkflow = allCostAvailable ? costs.map((c) => c.reduce((s, x) => s + (x.available ? x.usd : 0), 0)) : [];
  const total = allCostAvailable ? perWorkflow.reduce((a, b) => a + b, 0) : null;
  const successes = countWhere(ms, (m) => m.succeeded);
  const byOperation: Record<string, number> = {};
  if (allCostAvailable) {
    for (const u of usages) {
      const c = usageCost(u, pricing);
      if (c.available) byOperation[u.useCase] = (byOperation[u.useCase] ?? 0) + c.usd;
    }
  }
  const firstMissing = costs.flat().find((c) => !c.available) as { available: false; reason: string } | undefined;
  return {
    workflows: ms.length,
    modelCalls: attempts,
    failureRate: ratio(countWhere(ms, (m) => !m.succeeded), ms.length),
    retryOverhead: ratio(usages.reduce((n, u) => n + Math.max(0, u.attempts - 1), 0), attempts),
    providerErrors: countWhere(usages, (u) => u.outcome.startsWith('provider_')) + usages.reduce((n, u) => n + Math.max(0, u.attempts - 1), 0),
    tokens: {
      available: tokensAvailable,
      input: tokensAvailable ? usages.reduce((n, u) => n + u.inputTokens, 0) : null,
      output: tokensAvailable ? usages.reduce((n, u) => n + u.outputTokens, 0) : null,
      workflowsWithCompleteTokens: complete.length,
    },
    latencyMs: {
      total: distribution(ms.map((m) => m.totalMs)),
      model: distribution(ms.map((m) => m.usage.reduce((n, u) => n + u.latencyMs, 0))),
      playwright: distribution(ms.flatMap((m) => (m.playwrightMs === null ? [] : [m.playwrightMs]))),
      validation: distribution(ms.flatMap((m) => (m.phases?.validationMs == null ? [] : [m.phases.validationMs]))),
      analysis: distribution(ms.flatMap((m) => (m.phases?.analysisMs == null ? [] : [m.phases.analysisMs]))),
    },
    cost: {
      status: allCostAvailable ? 'ok' : 'unavailable',
      reason: allCostAvailable ? undefined : ms.length === 0 ? 'no workflows measured' : (firstMissing?.reason ?? 'no model calls recorded'),
      pricingEffectiveDate: pricing.effectiveDate,
      perWorkflowUsd: allCostAvailable ? distribution(perWorkflow) : null,
      totalUsd: total,
      perSuccessfulWorkflowUsd: total !== null && successes > 0 ? total / successes : null,
      byOperationUsd: allCostAvailable ? byOperation : null,
    },
  };
}
