import { test as base } from './test';
import { env } from '../config/env';

/**
 * Fixtures for agent-generated tests: the same page objects as hand-written
 * tests, plus an automatic network guard that aborts any request to a host
 * other than the configured UI target.
 */
export const test = base.extend<{ networkGuard: void }>({
  networkGuard: [
    async ({ context }, use) => {
      const allowedHost = new URL(env.uiBaseUrl).host;
      await context.route('**/*', (route) =>
        new URL(route.request().url()).host === allowedHost ? route.fallback() : route.abort('blockedbyclient'),
      );
      await use();
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
