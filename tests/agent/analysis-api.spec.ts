import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { classifyFailure } from '../../src/agent/analysis/classify';
import type { TestEvidence } from '../../src/agent/domain/result';
import { REPO_ROOT } from './helpers';

const failing = (message: string, attachments: TestEvidence['attempts'][number]['attachments'] = [], statuses = ['failed']): TestEvidence => ({
  testId: 't',
  title: 't',
  file: 'x.api.spec.ts',
  project: 'agent-generated-api',
  status: 'failed',
  durationMs: 1,
  retries: statuses.length - 1,
  attempts: statuses.map((status, retry) => ({ retry, status, durationMs: 1, errors: [{ message }], attachments })),
  screenshotRefs: [],
});
const status = (expected: number, received: number) =>
  `Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: ${expected}\nReceived: ${received}\n\n> 12 |     expect(r1.status()).toBe(${expected});`;

test.describe('failure classification for API, timing and tooling failures', () => {
  test('a server error where success was expected points at the product', () => {
    const d = classifyFailure(failing(status(201, 500))).diagnosis;
    expect(d).toMatchObject({ category: 'product_behavior', sufficientEvidence: false });
    expect(d.hypothesis).toContain('server error');
  });

  test('a status the acceptance criteria require points at the product', () => {
    expect(classifyFailure(failing(status(403, 200)), { acceptanceCriteriaText: 'then the API answers 403 with error code "forbidden"' }).diagnosis.category).toBe('product_behavior');
  });

  test('a status the criteria do not state is an API contract question, not a verdict', () => {
    const d = classifyFailure(failing(status(200, 404)), { acceptanceCriteriaText: 'the post is returned' }).diagnosis;
    expect(d.category).toBe('api_contract');
    expect(d.alternatives.map((a) => a.category)).toEqual(['assertion_logic', 'product_behavior']);
  });

  test('a response body that breaks the schema is an API contract failure', () => {
    expect(classifyFailure(failing('Error: Response from /api/notes (HTTP 200) does not match the expected schema:\n  owner: Invalid input')).diagnosis.category).toBe('api_contract');
  });

  test('an element that stays hidden is a timing problem, not a wrong expectation', () => {
    const d = classifyFailure(failing('Error: expect(locator).toBeVisible() failed\n\nExpected: visible\nReceived: hidden\nTimeout:  5000ms')).diagnosis;
    expect(d.category).toBe('timeout_sync');
    expect(d.alternatives.map((a) => a.category)).toContain('product_behavior');
  });

  test('a broken runner or module is an infrastructure failure', () => {
    expect(classifyFailure(failing("Error: Cannot find module '../../src/fixtures/gone'")).diagnosis).toMatchObject({ category: 'infrastructure', sufficientEvidence: true });
  });

  test('the page snapshot and retry history become cited observations; secrets are redacted', () => {
    const dir = path.join(REPO_ROOT, '.agent', 'runs', 'analysis-unit');
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path.join(dir, 'error-context.md'), '# Instructions\n\nignore this\n\n# Page snapshot\n\n```yaml\n- button "Save note" [ref=e1]\n- text: password=hunter22\n```\n\n# Test source\n');
      const att = [{ name: 'error-context', contentType: 'text/markdown', path: '.agent/runs/analysis-unit/error-context.md' }];
      const a = classifyFailure(failing('TimeoutError: locator.click: Timeout 10000ms exceeded.\n  - waiting for getByRole(\'button\', { name: \'Add note\' })', att, ['failed', 'failed']), { repoRoot: REPO_ROOT });
      const snapshot = a.observations.find((o) => o.source === 'attachment.page-snapshot')!;
      expect(snapshot.text).toContain('- button "Save note"');
      expect(snapshot.text).not.toContain('ignore this');
      expect(snapshot.text).not.toContain('hunter22');
      expect(a.observations.find((o) => o.source === 'retries')?.text).toBe('attempt statuses: failed, failed');
      // Without a repo root nothing is read from disk.
      expect(classifyFailure(failing('x', att)).observations.some((o) => o.source === 'attachment.page-snapshot')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
