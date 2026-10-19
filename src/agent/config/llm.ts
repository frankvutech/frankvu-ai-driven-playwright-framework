import { readFileSync } from 'node:fs';
import { AnthropicProvider, type AnthropicConfig } from '../llm/anthropic';
import { MockProvider, type MockReply } from '../llm/mock';
import type { LlmProvider } from '../llm/provider';

/** Explicit model configuration. Every value can be overridden by env; nothing is implicit. */
export function anthropicConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AnthropicConfig {
  const effort = env.AGENT_EFFORT ?? 'high';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new ProviderConfigError(`invalid AGENT_EFFORT "${effort}"`);
  const timeoutMs = Number(env.AGENT_LLM_TIMEOUT_MS ?? 180_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new ProviderConfigError('AGENT_LLM_TIMEOUT_MS must be an integer between 1000 and 600000');
  return {
    model: env.AGENT_MODEL ?? 'claude-opus-5-5',
    effort: effort as AnthropicConfig['effort'],
    timeoutMs,
  };
}

/**
 * Mock replies file: { "<useCase>": [reply, ...] }. A reply that is an
 * object is serialised to JSON; a string is returned verbatim (so malformed
 * output can be represented).
 */
export function mockFromFile(file: string): MockProvider {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown[]>;
  const replies: Record<string, MockReply[]> = {};
  for (const [useCase, list] of Object.entries(raw)) {
    replies[useCase] = list.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
  }
  return new MockProvider(replies);
}

/** A provider cannot be created from the current configuration. Raised before any model call. */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

export function createProvider(kind: string | undefined, mockFile: string | undefined, env: NodeJS.ProcessEnv = process.env): LlmProvider {
  switch (kind) {
    case 'anthropic':
      // Checked here so a missing credential is a clear configuration error, not an SDK exception mid-run.
      if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
        throw new ProviderConfigError('ANTHROPIC_API_KEY is not set: export it, or use --provider mock with --mock-replies');
      }
      return new AnthropicProvider(anthropicConfigFromEnv(env));
    case 'mock':
      if (!mockFile) throw new ProviderConfigError('--provider mock requires --mock-replies <file>');
      return mockFromFile(mockFile);
    default:
      throw new ProviderConfigError('choose a provider explicitly: --provider anthropic | mock');
  }
}
