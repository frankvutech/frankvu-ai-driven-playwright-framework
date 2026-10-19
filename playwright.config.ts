import { defineConfig, devices, type Project } from '@playwright/test';
import { env, type BrowserName } from './src/config/env';

import { STANDARD_USER_STATE } from './src/config/auth';

const BROWSER_DEVICES: Record<BrowserName, string> = {
  chromium: 'Desktop Chrome',
  firefox: 'Desktop Firefox',
  webkit: 'Desktop Safari',
};

// One UI project per browser in UI_BROWSERS (default: chromium only).
const uiProjects: Project[] = env.uiBrowsers.map((browser) => ({
  name: `ui-${browser}`,
  testDir: './tests/ui',
  dependencies: ['setup'],
  use: {
    ...devices[BROWSER_DEVICES[browser]],
    baseURL: env.uiBaseUrl,
    // saucedemo exposes stable `data-test` attributes.
    testIdAttribute: 'data-test',
    storageState: STANDARD_USER_STATE,
  },
}));

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 5_000 },

  // Structured execution evidence: human-readable HTML plus machine-readable
  // JSON/JUnit that CI (and, later, AI agents) can consume without
  // re-interpreting console output.
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: 'setup',
      testDir: './tests/setup',
      testMatch: /.*\.setup\.ts/,
      use: { baseURL: env.uiBaseUrl, testIdAttribute: 'data-test' },
    },
    ...uiProjects,
    {
      // Unit tests for the AI Test Agent (src/agent). No network; the catalog test opens about:blank.
      name: 'agent-unit',
      testDir: './tests/agent',
    },
    {
      // Agent workflow against the real runner and the approved demo target.
      name: 'agent-integration',
      testDir: './tests/agent-integration',
      timeout: 240_000,
      fullyParallel: false,
    },
    {
      // Tests for the Phase 3 evaluation system (eval/). Local only, no demo-site traffic.
      name: 'eval-unit',
      testDir: './tests/eval',
      timeout: 120_000,
    },
    {
      // API clients build their own request contexts (src/fixtures/api.ts);
      // baseURL here only serves ad-hoc `request` calls.
      name: 'api',
      testDir: './tests/api',
      use: {
        baseURL: env.apiBaseUrl,
        extraHTTPHeaders: { Accept: 'application/json' },
      },
    },
    {
      // UI + API workflows on the local example app (example-app/). The
      // baseURL comes from the exampleAppUrl fixture, not from here.
      name: 'integration',
      testDir: './tests/integration',
      use: { ...devices['Desktop Chrome'], testIdAttribute: 'data-test' },
    },
    {
      // Framework self-tests (configuration parsing). No browser, no network.
      name: 'framework-unit',
      testDir: './tests/framework',
    },
  ],
});
