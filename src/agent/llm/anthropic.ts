import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { LlmProvider, LlmRequest, LlmResponse } from './provider';
import { ProviderError } from './provider';

export interface AnthropicConfig {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs: number;
}

/**
 * Claude adapter. SDK retries are disabled so structured.ts owns the single,
 * bounded retry policy. Credentials are resolved by the SDK from the
 * environment and never pass through this code.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly config: AnthropicConfig) {
    this.model = config.model;
    this.client = new Anthropic({ maxRetries: 0, timeout: config.timeoutMs });
  }

  async complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create(
        {
          model: this.config.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          output_config: { effort: this.config.effort, format: zodOutputFormat(request.schema) },
          // Server-side fallback on policy declines; the response still goes
          // through the same schema validation.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { signal },
      );
    } catch (error) {
      throw mapAnthropicError(error);
    }

    if (response.stop_reason === 'refusal') {
      throw new ProviderError('refusal', `model declined (${response.stop_details?.category ?? 'unspecified'})`);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ProviderError('truncated', 'output hit max_tokens before completing');
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return {
      text,
      model: response.model,
      stopReason: response.stop_reason,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }
}

/** Map SDK errors to provider-neutral kinds. Messages never include request bodies. */
export function mapAnthropicError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Anthropic.APIUserAbortError) return new ProviderError('timeout', 'request aborted (timeout)');
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout', 'request timed out');
  if (error instanceof Anthropic.APIConnectionError) return new ProviderError('network', 'connection error');
  if (error instanceof Anthropic.RateLimitError) {
    const retryAfter = Number(error.headers?.get('retry-after'));
    return new ProviderError('rate_limit', 'rate limited (429)', Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError('auth', `authentication failed (${error.status})`);
  }
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError || error instanceof Anthropic.UnprocessableEntityError) {
    return new ProviderError('bad_request', `request rejected (${error.status})`);
  }
  if (error instanceof Anthropic.InternalServerError) return new ProviderError('server', `server error (${error.status})`);
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return new ProviderError(status === 529 || status >= 500 ? 'server' : 'unknown', `API error (${status})`);
  }
  return new ProviderError('unknown', 'unexpected provider error');
}
