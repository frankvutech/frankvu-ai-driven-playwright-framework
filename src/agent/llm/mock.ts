import type { LlmProvider, LlmRequest, LlmResponse } from './provider';

export type MockReply = string | Error | ((request: LlmRequest) => string | Error | Promise<string | Error>);

/**
 * Deterministic provider for unit tests, the deterministic evaluation suite
 * and offline demos. Replies are served per use case, in order.
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock';
  readonly calls: LlmRequest[] = [];
  private readonly queues: Map<string, MockReply[]>;

  constructor(replies: Record<string, MockReply[]>, private readonly delayMs = 0) {
    this.queues = new Map(Object.entries(replies).map(([k, v]) => [k, [...v]]));
  }

  async complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    this.calls.push(request);
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    }
    const queue = this.queues.get(request.useCase);
    const next = queue?.shift();
    if (next === undefined) throw new Error(`MockProvider: no reply queued for use case "${request.useCase}"`);
    const value = typeof next === 'function' ? await next(request) : next;
    if (value instanceof Error) throw value;
    // No usage: a mock has no real token counts, and reporting zeros would look like data.
    return { text: value, model: this.model, stopReason: 'end_turn' };
  }
}
