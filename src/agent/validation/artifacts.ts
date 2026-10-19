import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ESLint } from 'eslint';
import { resolveInside } from '../execution/files';
import { GENERATED_MARKER } from '../generation/render';
import { ALL_PAGE_FIXTURES } from '../generation/catalog';

export type CheckName = 'path' | 'ast' | 'typecheck' | 'lint' | 'convention' | 'workspace';

export interface Finding {
  check: CheckName;
  file?: string;
  line?: number;
  message: string;
}

export interface ArtifactValidation {
  ok: boolean;
  /** Findings per repo-relative file. A file is valid only if its list is empty. */
  files: Record<string, Finding[]>;
  workspace: Finding[];
  checksRun: CheckName[];
}

export interface ExpectedTrace {
  requirementId: string;
  scenarioId: string;
}

/** Framework modules a generated test may import (relative to src/). */
const ALLOWED_MODULES = [
  'fixtures/agent',
  'config/auth',
  'data/users',
  'data/customers',
  'data/exampleApp',
  'api/response',
  'api/schemas',
  'api/NotesClient',
];
/** Promoted tests use the ordinary fixtures instead of the guarded agent ones. */
const PROMOTED_MODULES = ['fixtures/test', 'fixtures/api', 'fixtures/integration', ...ALLOWED_MODULES.filter((m) => m !== 'fixtures/agent')];

/** Imports a candidate test may use (relative to generated/<runId>/). */
export const ALLOWED_IMPORTS = new Set(ALLOWED_MODULES.map((m) => `../../src/${m}`));
/** Imports a promoted test may use (relative to tests/<dir>/generated/). */
export const PROMOTED_IMPORTS = new Set(PROMOTED_MODULES.map((m) => `../../../src/${m}`));

const FORBIDDEN_IDENTIFIERS = new Set([
  'require',
  'process',
  'globalThis',
  'global',
  'window',
  'document',
  'eval',
  'Function',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'fetch',
  'setTimeout',
  'setInterval',
]);

/** Raw Playwright objects: allowed only as the subject of expect(page). */
const RAW_PLAYWRIGHT = new Set(['page', 'context', 'browser', 'request', 'browserName', 'playwright']);

/** Fixtures a generated test may destructure. Which family may use which is enforced by the type checker. */
const ALLOWED_FIXTURES = new Set([...Object.keys(ALL_PAGE_FIXTURES), 'page', 'exampleAppApi', 'postsApi', 'testPrefix', 'signInBrowser']);

const FORBIDDEN_MEMBERS = new Set([
  'evaluate',
  'evaluateHandle',
  '$eval',
  '$$eval',
  'addInitScript',
  'exposeFunction',
  'exposeBinding',
  'route',
  'routeFromHAR',
  'unroute',
  'waitForTimeout',
  'setExtraHTTPHeaders',
  'setDefaultTimeout',
  'setTimeout',
  'request',
  'only',
  'skip',
  'fixme',
  'fail',
  'slow',
  'soft',
  'poll',
  'configure',
]);

/**
 * Structural allowlist on the TypeScript AST. Because generated files come
 * from a deterministic renderer this should never fire; it exists so that a
 * hand-edited or tampered file cannot reach execution.
 */
export function astFindings(file: string, source: string, expected: ExpectedTrace, allowedImports: ReadonlySet<string> = ALLOWED_IMPORTS): Finding[] {
  const findings: Finding[] = [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const add = (check: CheckName, node: ts.Node | undefined, message: string) =>
    findings.push({ check, file, line: node ? at(node) : undefined, message });

  if (!source.startsWith(GENERATED_MARKER)) add('convention', undefined, 'missing generated-file marker');

  let testCalls = 0;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (!allowedImports.has(spec)) add('ast', stmt, `import from "${spec}" is not allowed`);
      continue;
    }
    if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
      const callee = stmt.expression.expression;
      if (ts.isIdentifier(callee) && callee.text === 'test') {
        testCalls += 1;
        continue;
      }
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'test' && callee.name.text === 'use') {
        continue;
      }
    }
    add('ast', stmt, 'only imports, test.use(...) and test(...) are allowed at top level');
  }
  if (testCalls === 0) add('convention', undefined, 'no test(...) declared');

  let expectCalls = 0;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text)) {
      const parent = node.parent;
      const isPropertyName = parent && (ts.isPropertyAccessExpression(parent) && parent.name === node);
      const isObjectKey = parent && ts.isPropertyAssignment(parent) && parent.name === node;
      if (!isPropertyName && !isObjectKey) add('ast', node, `use of "${node.text}" is not allowed`);
    }
    if (ts.isPropertyAccessExpression(node) && FORBIDDEN_MEMBERS.has(node.name.text)) {
      add('ast', node, `".${node.name.text}" is not allowed in generated tests`);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && RAW_PLAYWRIGHT.has(node.expression.text)) {
      add('ast', node, `direct use of "${node.expression.text}.${node.name.text}" is not allowed; use page objects`);
    }
    if (ts.isObjectBindingPattern(node) && ts.isParameter(node.parent)) {
      for (const el of node.elements) {
        const name = el.propertyName ?? el.name;
        if (!ts.isIdentifier(name) || !ALLOWED_FIXTURES.has(name.text) || el.dotDotDotToken) {
          add('ast', el, `fixture "${el.getText(sf)}" is not in the page-object catalog`);
        }
      }
    }
    if (ts.isElementAccessExpression(node) && !isHeaderLookup(node)) add('ast', node, 'computed member access is not allowed');
    if (node.kind === ts.SyntaxKind.ImportKeyword && ts.isCallExpression(node.parent)) add('ast', node, 'dynamic import is not allowed');
    if (ts.isNewExpression(node) && !(ts.isIdentifier(node.expression) && node.expression.text === 'RegExp')) {
      add('ast', node, 'only "new RegExp(...)" is allowed');
    }
    if (ts.isTaggedTemplateExpression(node) || ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) add('ast', node, 'template literals are not allowed');
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'expect') expectCalls += 1;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (expectCalls === 0) add('convention', undefined, 'test has no expect(...) assertion');

  for (const [type, id] of [
    ['requirement', expected.requirementId],
    ['scenario', expected.scenarioId],
  ]) {
    if (!source.includes(`{ type: ${JSON.stringify(type)}, description: ${JSON.stringify(id)} }`)) {
      add('convention', undefined, `missing ${type} annotation for ${id}`);
    }
  }
  return findings;
}

/** `<response>.headers()["name"]`: the only element access a generated test needs. */
function isHeaderLookup(node: ts.ElementAccessExpression): boolean {
  const target = node.expression;
  return (
    ts.isStringLiteral(node.argumentExpression) &&
    ts.isCallExpression(target) &&
    target.arguments.length === 0 &&
    ts.isPropertyAccessExpression(target.expression) &&
    target.expression.name.text === 'headers'
  );
}

/** Type-check the generated files together with the framework they import. */
export function typecheckFindings(repoRoot: string, absFiles: string[]): Finding[] {
  const configPath = path.join(repoRoot, 'tsconfig.json');
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, repoRoot);
  const program = ts.createProgram({ rootNames: absFiles, options: { ...parsed.options, noEmit: true } });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => ({
      check: 'typecheck' as const,
      file: d.file ? path.relative(repoRoot, d.file.fileName) : undefined,
      line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : undefined,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    }));
}

export async function lintFindings(repoRoot: string, absFiles: string[]): Promise<Finding[]> {
  // tsconfigRootDir is explicit so a workspace copy nested in the repo (healing) is linted against its own config.
  const eslint = new ESLint({ cwd: repoRoot, overrideConfig: { languageOptions: { parserOptions: { tsconfigRootDir: repoRoot } } } });
  const results = await eslint.lintFiles(absFiles);
  return results.flatMap((r) =>
    r.messages
      .filter((m) => m.severity === 2 || m.ruleId?.startsWith('playwright/'))
      .map((m) => ({ check: 'lint' as const, file: path.relative(repoRoot, r.filePath), line: m.line, message: `${m.ruleId ?? 'parse'}: ${m.message}` })),
  );
}

/** Snapshot of changed/untracked paths outside the agent's own areas. */
export function workspaceSnapshot(repoRoot: string, ignoredPrefixes: string[]): string[] {
  const out = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3))
    .filter((p) => !ignoredPrefixes.some((prefix) => p.startsWith(prefix)))
    .sort();
}

/**
 * Run every static check over the generated files of one run. Passing these
 * checks says the file is well-formed and inside the rules; it does not say
 * the test is semantically right. That is what human review is for.
 */
export async function validateArtifacts(input: {
  repoRoot: string;
  generationArea: string;
  files: Record<string, ExpectedTrace>;
  workspaceBefore: string[];
  workspaceAfter: string[];
}): Promise<ArtifactValidation> {
  const { repoRoot } = input;
  const files: Record<string, Finding[]> = {};
  const abs: string[] = [];

  for (const [rel, expected] of Object.entries(input.files)) {
    files[rel] = [];
    const resolved = resolveInside(repoRoot, input.generationArea, rel);
    if (!resolved.ok) {
      files[rel].push({ check: 'path', file: rel, message: resolved.reason });
      continue;
    }
    if (!rel.endsWith('.spec.ts')) files[rel].push({ check: 'path', file: rel, message: 'generated tests must be .spec.ts files' });
    abs.push(resolved.abs);
    files[rel].push(...astFindings(rel, readFileSync(resolved.abs, 'utf8'), expected));
  }

  if (abs.length > 0) {
    for (const f of [...typecheckFindings(repoRoot, abs), ...(await lintFindings(repoRoot, abs))]) {
      const key = f.file && f.file in files ? f.file : Object.keys(files)[0];
      files[key].push(f);
    }
  }

  const before = new Set(input.workspaceBefore);
  const workspace: Finding[] = input.workspaceAfter
    .filter((p) => !before.has(p))
    .map((p) => ({ check: 'workspace', file: p, message: 'modified outside the generation area during this run' }));

  return {
    ok: workspace.length === 0 && Object.values(files).every((f) => f.length === 0),
    files,
    workspace,
    checksRun: ['path', 'ast', 'convention', 'typecheck', 'lint', 'workspace'],
  };
}
