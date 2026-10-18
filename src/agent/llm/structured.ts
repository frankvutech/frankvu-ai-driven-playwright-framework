import type { z } from 'zod';
import type { LlmProvider, LlmRequest } from './provider';
import { ProviderError } from './provider';

export interface RetryPolicy {
  /** Total attempts including the first; applies to transient errors only. */
  maxAttempts: number;
  timeoutMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  timeoutMs: 120_000,
  baseBackoffMs: 1_000,
  maxBackoffMs: 20_000,
};

/** One record per use-case call. Prompt and response content are deliberately absent. */
export interface UsageRecord {
  useCase: string;
  provider: string;
  model: string;
  attempts: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** False when any attempt returned no usage data; token counts are then incomplete. */
  tokensAvailable: boolean;
  outcome: 'ok' | StructuredFailureKind;
}

export type StructuredFailureKind = 'malformed_json' | 'schema_violation' | `provider_${ProviderError['kind']}`;

export type StructuredResult<T> =
  | { ok: true; value: T; usage: UsageRecord }
  | { ok: false; kind: StructuredFailureKind; detail: string; usage: UsageRecord };

export interface StructuredDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Call a provider and validate the output against `schema`.
 *
 * - Transient provider errors (timeout, 429, 5xx, network) are retried with
 *   capped exponential backoff, up to `maxAttempts` in total.
 * - Malformed or schema-invalid output is NOT retried: it is returned as a
 *   classified failure so the workflow can surface it.
 */
export async function callStructured<S extends z.ZodType>(
  provider: LlmProvider,
  request: Omit<LlmRequest, 'schema'>,
  schema: S,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  deps: StructuredDeps = {},
): Promise<StructuredResult<z.infer<S>>> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const started = now();
  let attempts = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let tokensAvailable = true;

  const usage = (outcome: UsageRecord['outcome']): UsageRecord => ({
    useCase: request.useCase,
    provider: provider.name,
    model: provider.model,
    attempts,
    latencyMs: now() - started,
    inputTokens,
    outputTokens,
    tokensAvailable: tokensAvailable && attempts > 0,
    outcome,
  });

  for (;;) {
    attempts += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
    let text: string;
    try {
      const response = await Promise.race([
        provider.complete({ ...request, schema }, controller.signal),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener('abort', () =>
            reject(new ProviderError('timeout', `no response within ${policy.timeoutMs}ms`)),
          ),
        ),
      ]);
      if (response.usage) {
        inputTokens += response.usage.inputTokens;
        outputTokens += response.usage.outputTokens;
      } else {
        tokensAvailable = false;
      }
      text = response.text;
    } catch (error) {
      // A failed attempt may still have consumed tokens that the provider did not report.
      tokensAvailable = false;
      const err = error instanceof ProviderError ? error : new ProviderError('unknown', 'provider call failed');
      if (err.retryable && attempts < policy.maxAttempts) {
        const backoff = Math.min(policy.maxBackoffMs, err.retryAfterMs ?? policy.baseBackoffMs * 2 ** (attempts - 1));
        await sleep(backoff);
        continue;
      }
      const kind = `provider_${err.kind}` as const;
      return { ok: false, kind, detail: err.message, usage: usage(kind) };
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(text));
    } catch {
      return { ok: false, kind: 'malformed_json', detail: 'output is not valid JSON', usage: usage('malformed_json') };
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { ok: false, kind: 'schema_violation', detail, usage: usage('schema_violation') };
    }
    return { ok: true, value: result.data, usage: usage('ok') };
  }
}

/** Tolerate a single surrounding ```json fence; anything else must be bare JSON. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(trimmed);
  return match ? match[1] : trimmed;
}
