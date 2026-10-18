import type { z } from 'zod';

/**
 * Minimal provider boundary. Use cases depend on this interface only; the SDK
 * lives in a single adapter (anthropic.ts). Model output is returned as raw
 * text and validated by the caller (structured.ts), never trusted as-is.
 */
export interface LlmRequest {
  /** Stable identifier for usage records and mock routing, e.g. "test-plan". */
  useCase: string;
  system: string;
  prompt: string;
  /** Expected output shape. Providers may use it to constrain decoding. */
  schema: z.ZodType;
  maxTokens: number;
}

export interface LlmResponse {
  text: string;
  model: string;
  stopReason: string | null;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
}

export type ProviderErrorKind =
  | 'timeout'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'auth'
  | 'bad_request'
  | 'refusal'
  | 'truncated'
  | 'unknown';

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(['timeout', 'rate_limit', 'server', 'network']);

export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = RETRYABLE.has(kind);
  }
}
