import { test, expect } from '@playwright/test';
import { loadPricing, summarizeCostLatency, usageCost, type Pricing, type WorkflowMeasurement } from '../../eval/cost';
import type { UsageRecord } from '../../src/agent/llm/structured';

const pricing: Pricing = { effectiveDate: '2026-10-06', currency: 'USD', source: 's', excludes: 'e', models: { 'm-1': { inputPerMTok: 4, outputPerMTok: 20 } } };
const usage = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  useCase: 'test-plan', provider: 'anthropic', model: 'm-1', attempts: 1, latencyMs: 100, inputTokens: 1_000_000, outputTokens: 500_000, tokensAvailable: true, outcome: 'ok', ...over,
});
const wf = (id: string, u: UsageRecord[], totalMs: number, succeeded = true, playwrightMs: number | null = null): WorkflowMeasurement => ({ workflowId: id, caseId: id, usage: u, totalMs, playwrightMs, succeeded });

test.describe('cost', () => {
  test('cost = input tokens x input price + output tokens x output price', () => {
    expect(usageCost(usage(), pricing)).toEqual({ available: true, usd: 4 + 10 });
    expect(usageCost(usage({ inputTokens: 2_000, outputTokens: 1_000 }), pricing)).toEqual({ available: true, usd: 0.008 + 0.02 });
  });

  test('cost is unavailable, never estimated, without complete token data or a price', () => {
    expect(usageCost(usage({ tokensAvailable: false }), pricing)).toEqual({ available: false, reason: 'anthropic did not report complete token usage' });
    expect(usageCost(usage({ model: 'unknown' }), pricing)).toEqual({ available: false, reason: 'no price for model unknown' });
  });

  test('summary statistics across workflows', () => {
    const s = summarizeCostLatency(
      [
        wf('a', [usage({ inputTokens: 1_000_000, outputTokens: 0 }), usage({ useCase: 'test-generation', inputTokens: 0, outputTokens: 1_000_000, attempts: 3, outcome: 'ok' })], 1000, true, 400),
        wf('b', [usage({ inputTokens: 500_000, outputTokens: 0, outcome: 'provider_timeout', attempts: 3 })], 3000, false),
      ],
      pricing,
    );
    expect(s.workflows).toBe(2);
    expect(s.modelCalls).toBe(7);
    expect(s.retryOverhead).toEqual({ n: 4, d: 7, value: 4 / 7 });
    expect(s.failureRate).toEqual({ n: 1, d: 2, value: 0.5 });
    expect(s.tokens).toEqual({ available: true, input: 1_500_000, output: 1_000_000, workflowsWithCompleteTokens: 2 });
    expect(s.cost.status).toBe('ok');
    expect(s.cost.totalUsd).toBeCloseTo(4 + 20 + 2, 10);
    expect(s.cost.perSuccessfulWorkflowUsd).toBeCloseTo(26, 10);
    expect(s.cost.byOperationUsd).toEqual({ 'test-plan': 6, 'test-generation': 20 });
    expect(s.latencyMs.total.median).toBe(1000);
    expect(s.latencyMs.playwright).toMatchObject({ n: 1, median: 400 });
  });

  test('mock usage leaves tokens and cost unavailable', () => {
    const s = summarizeCostLatency([wf('a', [usage({ provider: 'mock', model: 'mock', tokensAvailable: false, inputTokens: 0, outputTokens: 0 })], 10)], pricing);
    expect(s.tokens).toEqual({ available: false, input: null, output: null, workflowsWithCompleteTokens: 0 });
    expect(s.cost).toMatchObject({ status: 'unavailable', reason: 'mock did not report complete token usage', totalUsd: null, perWorkflowUsd: null });
  });

  test('no workflows: everything unavailable', () => {
    const s = summarizeCostLatency([], pricing);
    expect(s.cost).toMatchObject({ status: 'unavailable', reason: 'no workflows measured' });
    expect(s.failureRate.value).toBeNull();
  });

  test('the shipped pricing table parses and records its effective date', () => {
    const p = loadPricing();
    expect(p.effectiveDate).toBe('2026-10-06');
    expect(p.models['claude-opus-5-5']).toEqual({ inputPerMTok: 4, outputPerMTok: 20 });
  });
});
