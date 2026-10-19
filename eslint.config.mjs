import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import playwright from 'eslint-plugin-playwright';

export default tseslint.config(
  { ignores: ['node_modules/', 'playwright-report/', 'test-results/', '.agent/', 'eval-results/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['tests/**/*.ts', 'generated/**/*.ts'],
    ...playwright.configs['flat/recommended'],
  },
  {
    // Deterministic test code must not depend on browser-exploration tooling
    // (e.g. a future Playwright MCP integration). Such tools stay outside the
    // test run and may only produce artifacts that go through normal review.
    files: ['src/**/*.ts', 'tests/**/*.ts', 'example-app/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['@playwright/mcp', '@playwright/mcp/*', '@modelcontextprotocol/*'] }],
    },
  },
  {
    // Generated tests: stricter rules on top of the AST allowlist in
    // src/agent/validation/artifacts.ts.
    files: ['generated/**/*.ts'],
    rules: {
      'playwright/no-wait-for-timeout': 'error',
      'playwright/no-skipped-test': 'error',
      'playwright/no-focused-test': 'error',
      'playwright/no-force-option': 'error',
      'playwright/no-page-pause': 'error',
      'playwright/no-eval': 'error',
      'playwright/no-networkidle': 'error',
      'playwright/expect-expect': 'error',
      'playwright/no-conditional-in-test': 'error',
      'playwright/prefer-web-first-assertions': 'error',
      'no-restricted-imports': ['error', { patterns: ['node:*', 'child_process', 'fs', 'http', 'https', 'net'] }],
    },
  },
);
