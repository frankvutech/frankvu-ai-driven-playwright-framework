import type { BrowserContext } from '@playwright/test';
import { test as base } from './test';
import { test as apiBase } from './api';
import { test as integrationBase } from './integration';
import { env } from '../config/env';

/** Aborts every browser request to a host other than `allowedHost`. */
async function guardNetwork(context: BrowserContext, allowedHost: string): Promise<void> {
  await context.route('**/*', (route) =>
    new URL(route.request().url()).host === allowedHost ? route.fallback() : route.abort('blockedbyclient'),
  );
}

/**
 * Fixtures for agent-generated tests: the same page objects and API clients
 * as hand-written tests, plus an automatic network guard on the browser.
 * API calls can only go through the API clients, whose base URLs come from
 * validated configuration (the AST rules forbid raw request access).
 */
export const test = base.extend<{ networkGuard: void }>({
  networkGuard: [
    async ({ context }, use) => {
      await guardNetwork(context, new URL(env.uiBaseUrl).host);
      await use();
    },
    { auto: true },
  ],
});

/** Example-app UI and combined tests: the browser may reach the example app only. */
export const notesTest = integrationBase.extend<{ networkGuard: void }>({
  networkGuard: [
    async ({ context, exampleAppUrl }, use) => {
      await guardNetwork(context, new URL(exampleAppUrl).host);
      await use();
    },
    { auto: true },
  ],
});

/** API tests (example app and JSONPlaceholder). No browser is started. */
export const apiTest = apiBase;

export { expect } from '@playwright/test';
