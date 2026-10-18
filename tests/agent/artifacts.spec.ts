import { test, expect } from '@playwright/test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderSpec } from '../../src/agent/generation/render';
import { astFindings, validateArtifacts } from '../../src/agent/validation/artifacts';
import { REPO_ROOT, generation101, scratchRun } from './helpers';

const trace = { requirementId: 'REQ-101', scenarioId: 'REQ-101-SC-01' };
const good = () => renderSpec(generation101().tests[0], 'run-1');
const messages = (source: string) => astFindings('a.spec.ts', source, trace).map((f) => f.message);

test.describe('AST allowlist for generated files', () => {
  const cases: Array<[string, (s: string) => string, string]> = [
    ['node imports', (s) => s.replace("import { test,", "import { execSync } from 'node:child_process';\nimport { test,"), 'import from "node:child_process" is not allowed'],
    ['require', (s) => s.replace('await loginPage.goto();', "require('fs');\n    await loginPage.goto();"), 'use of "require" is not allowed'],
    ['process access', (s) => s.replace('await loginPage.goto();', 'await loginPage.login(process.env.X!, "y");'), 'use of "process" is not allowed'],
    ['raw page calls', (s) => s.replace('await loginPage.goto();', 'await page.goto("https://evil.example");'), 'direct use of "page.goto" is not allowed; use page objects'],
    ['page.evaluate', (s) => s.replace('await loginPage.goto();', 'await page.evaluate(() => 1);'), '".evaluate" is not allowed in generated tests'],
    ['fixed waits', (s) => s.replace('await loginPage.goto();', 'await page.waitForTimeout(1000);'), '".waitForTimeout" is not allowed in generated tests'],
    ['focused tests', (s) => s.replace('\ntest(\n', '\ntest.only(\n'), 'only imports, test.use(...) and test(...) are allowed at top level'],
    ['soft assertions', (s) => s.replace('await expect(inventoryPage.title)', 'await expect.soft(inventoryPage.title)'), '".soft" is not allowed in generated tests'],
    ['non-catalog fixtures', (s) => s.replace('async ({ loginPage,', 'async ({ request, loginPage,'), 'fixture "request" is not in the page-object catalog'],
    ['dynamic import', (s) => s.replace('await loginPage.goto();', "await import('fs');\n    await loginPage.goto();"), 'dynamic import is not allowed'],
    ['computed access', (s) => s.replace('await loginPage.goto();', "await loginPage['goto']();"), 'computed member access is not allowed'],
    ['template literals', (s) => s.replace('"Products"', '`Products`'), 'template literals are not allowed'],
    ['missing traceability', (s) => s.replace('{ type: "scenario", description: "REQ-101-SC-01" },', ''), 'missing scenario annotation for REQ-101-SC-01'],
    ['missing assertions', (s) => s.replace(/\s+await expect\([^\n]+/g, ''), 'test has no expect(...) assertion'],
  ];
  for (const [name, mutate, message] of cases) {
    test(`rejects ${name}`, () => {
      expect(messages(mutate(good()))).toContain(message);
    });
  }

  test('accepts the rendered example', () => {
    expect(messages(good())).toEqual([]);
  });
});

test.describe('full artifact validation', () => {
  test.describe.configure({ timeout: 120_000 });

  test('rendered files pass path, AST, type-check and lint; tampered files do not', async () => {
    const run = scratchRun();
    try {
      const dir = path.join('generated', run.runId);
      mkdirSync(path.join(REPO_ROOT, dir), { recursive: true });
      const ok = path.posix.join(dir, 'REQ-101-SC-01.spec.ts');
      const typeError = path.posix.join(dir, 'REQ-101-SC-02.spec.ts');
      const lintError = path.posix.join(dir, 'REQ-101-SC-03.spec.ts');
      writeFileSync(path.join(REPO_ROOT, ok), good());
      writeFileSync(path.join(REPO_ROOT, typeError), renderSpec(generation101().tests[1], run.runId).replace('loginPage.goto()', 'loginPage.open()'));
      writeFileSync(
        path.join(REPO_ROOT, lintError),
        renderSpec(generation101().tests[2], run.runId).replace('await loginPage.goto();', 'if (Date) { await loginPage.goto(); }'),
      );
      const result = await validateArtifacts({
        repoRoot: REPO_ROOT,
        generationArea: 'generated',
        files: {
          [ok]: trace,
          [typeError]: { requirementId: 'REQ-101', scenarioId: 'REQ-101-SC-02' },
          [lintError]: { requirementId: 'REQ-101', scenarioId: 'REQ-101-SC-03' },
        },
        workspaceBefore: [],
        workspaceAfter: [],
      });
      expect(result.ok).toBe(false);
      expect(result.files[ok]).toEqual([]);
      expect(result.files[typeError]).toContainEqual(expect.objectContaining({ check: 'typecheck', message: expect.stringContaining("'open' does not exist") }));
      expect(result.files[lintError]).toContainEqual(expect.objectContaining({ check: 'lint', message: expect.stringContaining('playwright/no-conditional-in-test') }));
    } finally {
      run.cleanup();
    }
  });

  test('files outside the generation area, symlinks and escapes are rejected', async () => {
    const run = scratchRun();
    try {
      const dir = path.join('generated', run.runId);
      mkdirSync(path.join(REPO_ROOT, dir), { recursive: true });
      const link = path.posix.join(dir, 'link.spec.ts');
      symlinkSync(path.join(REPO_ROOT, 'tests/ui/login.spec.ts'), path.join(REPO_ROOT, link));
      const result = await validateArtifacts({
        repoRoot: REPO_ROOT,
        generationArea: 'generated',
        files: { 'tests/ui/login.spec.ts': trace, [link]: trace, [`${dir}/../../tests/ui/login.spec.ts`]: trace, '/etc/hosts': trace },
        workspaceBefore: [],
        workspaceAfter: [],
      });
      expect(Object.values(result.files).map((f) => f[0]?.message)).toEqual([
        'tests/ui/login.spec.ts: outside generated/',
        `${link}: symbolic links are not allowed`,
        `${dir}/../../tests/ui/login.spec.ts: outside generated/`,
        '/etc/hosts: absolute paths are not allowed',
      ]);
    } finally {
      run.cleanup();
    }
  });

  test('changes outside the generation area during a run are reported', async () => {
    const result = await validateArtifacts({
      repoRoot: REPO_ROOT,
      generationArea: 'generated',
      files: {},
      workspaceBefore: ['README.md'],
      workspaceAfter: ['README.md', 'playwright.config.ts'],
    });
    expect(result.ok).toBe(false);
    expect(result.workspace).toEqual([expect.objectContaining({ file: 'playwright.config.ts', check: 'workspace' })]);
  });
});
