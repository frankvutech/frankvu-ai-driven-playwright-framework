import { readFileSync } from 'node:fs';
import { AnthropicProvider, type AnthropicConfig } from '../llm/anthropic';
import { MockProvider, type MockReply } from '../llm/mock';
import type { LlmProvider } from '../llm/provider';

/** Explicit model configuration. Every value can be overridden by env; nothing is implicit. */
export function anthropicConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AnthropicConfig {
  const effort = env.RELYNX_EFFORT ?? 'high';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`invalid RELYNX_EFFORT "${effort}"`);
  return {
    model: env.RELYNX_MODEL ?? 'claude-opus-5-5',
    effort: effort as AnthropicConfig['effort'],
    timeoutMs: Number(env.RELYNX_LLM_TIMEOUT_MS ?? 180_000),
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

export function createProvider(kind: string | undefined, mockFile: string | undefined, env: NodeJS.ProcessEnv = process.env): LlmProvider {
  switch (kind) {
    case 'anthropic':
      return new AnthropicProvider(anthropicConfigFromEnv(env));
    case 'mock':
      if (!mockFile) throw new Error('--provider mock requires --mock-replies <file>');
      return mockFromFile(mockFile);
    default:
      throw new Error('choose a provider explicitly: --provider anthropic | mock');
  }
}
