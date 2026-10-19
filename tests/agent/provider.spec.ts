import { test, expect } from '@playwright/test';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { MockProvider } from '../../src/agent/llm/mock';
import { ProviderError } from '../../src/agent/llm/provider';
import { callStructured, type RetryPolicy } from '../../src/agent/llm/structured';
import { mapAnthropicError } from '../../src/agent/llm/anthropic';
import { anthropicConfigFromEnv, createProvider, ProviderConfigError } from '../../src/agent/config/llm';

const Schema = z.object({ answer: z.number() }).strict();
const request = { useCase: 'demo', system: 'SYSTEM', prompt: 'PROMPT-with-sensitive-requirement-text', maxTokens: 100 };
const policy: RetryPolicy = { maxAttempts: 3, timeoutMs: 1_000, baseBackoffMs: 100, maxBackoffMs: 250 };

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

test.describe('structured model calls', () => {
  test('valid JSON that matches the schema is returned with a usage record', async () => {
    const provider = new MockProvider({ demo: ['{"answer": 42}'] });
    const result = await callStructured(provider, request, Schema, policy);
    expect(result).toMatchObject({ ok: true, value: { answer: 42 }, usage: { useCase: 'demo', provider: 'mock', attempts: 1, outcome: 'ok' } });
  });

  test('usage records never contain prompt or response content', async () => {
    const provider = new MockProvider({ demo: ['{"answer": 42}'] });
    const result = await callStructured(provider, request, Schema, policy);
    const serialised = JSON.stringify(result.usage);
    expect(serialised).not.toContain('PROMPT');
    expect(serialised).not.toContain('SYSTEM');
    expect(serialised).not.toContain('42');
  });

  test('a single ```json fence is tolerated', async () => {
    const provider = new MockProvider({ demo: ['```json\n{"answer": 1}\n```'] });
    expect((await callStructured(provider, request, Schema, policy)).ok).toBe(true);
  });

  test('malformed JSON is classified and not retried', async () => {
    const provider = new MockProvider({ demo: ['Sure! {"answer": ', '{"answer": 1}'] });
    const result = await callStructured(provider, request, Schema, policy);
    expect(result).toMatchObject({ ok: false, kind: 'malformed_json', usage: { attempts: 1 } });
    expect(provider.calls).toHaveLength(1);
  });

  test('schema violations are classified with paths and not retried', async () => {
    const provider = new MockProvider({ demo: ['{"answer": "forty-two", "extra": true}'] });
    const result = await callStructured(provider, request, Schema, policy);
    expect(result).toMatchObject({ ok: false, kind: 'schema_violation', detail: expect.stringContaining('answer') });
    expect(provider.calls).toHaveLength(1);
  });

  test('transient errors are retried with capped exponential backoff', async () => {
    const provider = new MockProvider({
      demo: [new ProviderError('rate_limit', '429'), new ProviderError('server', '503'), '{"answer": 7}'],
    });
    const { waits, sleep } = recordingSleep();
    const result = await callStructured(provider, request, Schema, policy, { sleep });
    expect(result).toMatchObject({ ok: true, value: { answer: 7 }, usage: { attempts: 3 } });
    expect(waits).toEqual([100, 200]);
  });

  test('retry-after from the provider is honoured but capped', async () => {
    const provider = new MockProvider({ demo: [new ProviderError('rate_limit', '429', 10_000), '{"answer": 7}'] });
    const { waits, sleep } = recordingSleep();
    await callStructured(provider, request, Schema, policy, { sleep });
    expect(waits).toEqual([250]);
  });

  test('retries stop at maxAttempts', async () => {
    const provider = new MockProvider({ demo: Array.from({ length: 10 }, () => new ProviderError('network', 'reset')) });
    const { waits, sleep } = recordingSleep();
    const result = await callStructured(provider, request, Schema, policy, { sleep });
    expect(result).toMatchObject({ ok: false, kind: 'provider_network', usage: { attempts: 3 } });
    expect(provider.calls).toHaveLength(3);
    expect(waits).toHaveLength(2);
  });

  test('non-transient errors are not retried', async () => {
    for (const kind of ['auth', 'bad_request', 'refusal', 'truncated'] as const) {
      const provider = new MockProvider({ demo: [new ProviderError(kind, kind), '{"answer": 1}'] });
      const result = await callStructured(provider, request, Schema, policy, recordingSleep());
      expect(result).toMatchObject({ ok: false, kind: `provider_${kind}` });
      expect(provider.calls).toHaveLength(1);
    }
  });

  test('a provider that does not answer in time is timed out and retried', async () => {
    const provider = new MockProvider({ demo: ['{"answer": 1}', '{"answer": 1}'] }, 200);
    const result = await callStructured(provider, request, Schema, { ...policy, maxAttempts: 2, timeoutMs: 30 }, recordingSleep());
    expect(result).toMatchObject({ ok: false, kind: 'provider_timeout', usage: { attempts: 2 } });
  });

  test('unexpected exceptions become a non-retried unknown error', async () => {
    const provider = new MockProvider({ demo: [new Error('boom'), '{"answer": 1}'] });
    const result = await callStructured(provider, request, Schema, policy, recordingSleep());
    expect(result).toMatchObject({ ok: false, kind: 'provider_unknown' });
    expect(provider.calls).toHaveLength(1);
  });
});

test.describe('Anthropic adapter error mapping', () => {
  const apiError = (status: number, headers: Record<string, string> = {}) =>
    Anthropic.APIError.generate(status, { error: { type: 'x', message: 'm' } }, 'm', new Headers(headers));

  test('maps SDK errors to provider-neutral kinds', () => {
    const rate = mapAnthropicError(apiError(429, { 'retry-after': '3' }));
    expect([rate.kind, rate.retryable, rate.retryAfterMs]).toEqual(['rate_limit', true, 3000]);
    expect(mapAnthropicError(apiError(500)).kind).toBe('server');
    expect(mapAnthropicError(apiError(529)).kind).toBe('server');
    expect(mapAnthropicError(apiError(401)).kind).toBe('auth');
    expect(mapAnthropicError(apiError(403)).kind).toBe('auth');
    expect(mapAnthropicError(apiError(400)).kind).toBe('bad_request');
    expect(mapAnthropicError(new Anthropic.APIConnectionTimeoutError()).kind).toBe('timeout');
    expect(mapAnthropicError(new Anthropic.APIConnectionError({ message: 'reset' })).kind).toBe('network');
    expect(mapAnthropicError(new Error('other')).kind).toBe('unknown');
  });

  test('only timeouts, rate limits, server and network errors are retryable', () => {
    expect(mapAnthropicError(apiError(400)).retryable).toBe(false);
    expect(mapAnthropicError(apiError(401)).retryable).toBe(false);
    expect(mapAnthropicError(apiError(503)).retryable).toBe(true);
  });
});

test.describe('provider configuration', () => {
  test('the provider must be chosen explicitly', () => {
    expect(() => createProvider(undefined, undefined)).toThrow('choose a provider explicitly');
    expect(() => createProvider('mock', undefined)).toThrow('--mock-replies');
  });

  test('model settings have explicit defaults and validate overrides', () => {
    expect(anthropicConfigFromEnv({})).toEqual({ model: 'claude-opus-5-5', effort: 'high', timeoutMs: 180_000 });
    expect(anthropicConfigFromEnv({ AGENT_MODEL: 'claude-sonnet-5-5', AGENT_EFFORT: 'low' })).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' });
    expect(() => anthropicConfigFromEnv({ AGENT_EFFORT: 'turbo' })).toThrow('invalid AGENT_EFFORT');
    expect(() => anthropicConfigFromEnv({ AGENT_LLM_TIMEOUT_MS: 'soon' })).toThrow('AGENT_LLM_TIMEOUT_MS must be an integer');
  });

  test('a missing credential is a configuration error before any model call', () => {
    expect(() => createProvider('anthropic', undefined, {})).toThrow(ProviderConfigError);
    expect(() => createProvider('anthropic', undefined, {})).toThrow('ANTHROPIC_API_KEY is not set');
    expect(createProvider('anthropic', undefined, { ANTHROPIC_API_KEY: 'sk-ant-test-not-real' }).name).toBe('anthropic');
  });
});
