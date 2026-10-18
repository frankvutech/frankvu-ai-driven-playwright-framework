import { test, expect } from '@playwright/test';
import ts from 'typescript';
import { validateSpec } from '../../src/agent/generation/validateSpec';
import { renderSpec } from '../../src/agent/generation/render';
import { astFindings } from '../../src/agent/validation/artifacts';
import type { Step, TestSpec } from '../../src/agent/domain/testSpec';
import { generation101 } from './helpers';

const allowed = new Set(['REQ-101-SC-01', 'REQ-101-SC-02', 'REQ-101-SC-03']);
const spec = (i = 0): TestSpec => structuredClone(generation101().tests[i]);
const codes = (s: TestSpec) => validateSpec(s, allowed, 'REQ-101').map((i) => i.code);
const trace = (s: TestSpec) => ({ requirementId: s.requirementId, scenarioId: s.scenarioId });

test.describe('spec validation against the page-object catalog', () => {
  test('the example specs are valid', () => {
    for (const s of generation101().tests) expect(validateSpec(s, allowed, 'REQ-101')).toEqual([]);
  });

  test('unknown fixtures, methods and locators are rejected', () => {
    const s = spec();
    s.steps[0] = { kind: 'action', target: 'adminPage.goto', args: [] };
    s.steps[1] = { kind: 'action', target: 'loginPage.signIn', args: [] };
    s.steps[3] = { ...(s.steps[3] as Extract<Step, { kind: 'expect' }>), target: 'inventoryPage.banner' };
    expect(codes(s)).toEqual(expect.arrayContaining(['unknown_fixture', 'unknown_method', 'unknown_locator']));
  });

  test('raw Playwright objects are not reachable through the catalog', () => {
    const s = spec();
    s.steps[0] = { kind: 'action', target: 'page.evaluate', args: [] };
    expect(codes(s)).toContain('unknown_fixture');
  });

  test('argument count and types must match the page-object method', () => {
    const s = spec();
    s.steps[1] = { kind: 'action', target: 'loginPage.login', args: [{ kind: 'literal', value: 'only-one' }] };
    expect(codes(s)).toContain('argument_mismatch');
    const t = spec();
    t.steps.splice(2, 0, { kind: 'action', target: 'inventoryPage.sortBy', args: [{ kind: 'literal', value: 'random' }] });
    expect(codes(t)).toContain('argument_mismatch');
  });

  test('credentials as literals are rejected', () => {
    const s = spec();
    s.steps[1] = { kind: 'action', target: 'loginPage.login', args: [{ kind: 'literal', value: 'standard_user' }, { kind: 'literal', value: 'secret_sauce' }] };
    expect(codes(s)).toContain('literal_secret');
  });

  test('URL assertions may only match paths', () => {
    for (const pathPattern of ['https://evil.example/', '//evil.example', '(unclosed']) {
      const s = spec();
      s.steps[2] = { kind: 'expectUrl', pathPattern, negate: false };
      expect(codes(s)).toContain('unsafe_url_pattern');
    }
  });

  test('matchers must get the right kind of expected value', () => {
    const s = spec();
    s.steps[3] = { kind: 'expect', target: 'inventoryPage.items', select: 'all', matcher: 'toHaveCount', expected: 'six', negate: false };
    expect(codes(s)).toContain('matcher_mismatch');
  });

  test('a test without assertions is rejected; a trailing action is a warning', () => {
    const s = spec();
    s.steps = s.steps.slice(0, 2);
    expect(codes(s)).toContain('no_assertion');
    const t = spec();
    t.steps.push({ kind: 'action', target: 'inventoryPage.header.logout', args: [] });
    expect(validateSpec(t, allowed, 'REQ-101')).toEqual([expect.objectContaining({ code: 'trailing_action', severity: 'warning' })]);
  });

  test('specs must trace to an allowed scenario of this requirement', () => {
    expect(codes({ ...spec(), scenarioId: 'REQ-101-SC-04' })).toContain('unknown_scenario');
    expect(codes({ ...spec(), requirementId: 'REQ-102' })).toContain('requirement_mismatch');
  });
});

test.describe('deterministic rendering', () => {
  test('renders a POM-based test with traceability annotations and only needed imports', () => {
    const source = renderSpec(spec(), 'run-1');
    expect(source).toContain("import { test, expect } from '../../src/fixtures/agent';");
    expect(source).toContain('test.use({ storageState: SIGNED_OUT });');
    expect(source).toContain('await loginPage.login(users.standard.username, users.standard.password);');
    expect(source).toContain('{ type: "requirement", description: "REQ-101" }');
    expect(source).toContain('{ type: "scenario", description: "REQ-101-SC-01" }');
    expect(source).not.toContain('defaultCustomer');
    expect(astFindings('a.spec.ts', source, trace(spec()))).toEqual([]);
  });

  test('rendering is deterministic', () => {
    expect(renderSpec(spec(1), 'run-1')).toBe(renderSpec(spec(1), 'run-1'));
  });

  test('hostile text from the model stays inside string literals', () => {
    const hostile = 'x"); require(\'child_process\').execSync(\'touch /tmp/pwned\'); ("\n*/ `${process.exit(1)}`';
    const s = { ...spec(), title: hostile };
    s.steps[3] = { kind: 'expect', target: 'inventoryPage.title', select: 'all', matcher: 'toHaveText', expected: hostile, negate: false };
    const source = renderSpec(s, 'run-1');
    expect(astFindings('a.spec.ts', source, trace(s))).toEqual([]);
    const sf = ts.createSourceFile('a.ts', source, ts.ScriptTarget.ES2022, true);
    const call = sf.statements.find((st) => ts.isExpressionStatement(st) && ts.isCallExpression(st.expression)
      && ts.isIdentifier(st.expression.expression) && st.expression.expression.text === 'test') as ts.ExpressionStatement;
    expect(((call.expression as ts.CallExpression).arguments[0] as ts.StringLiteral).text).toBe(hostile);
  });

  test('customer arguments omit fields by setting them undefined', () => {
    const s: TestSpec = {
      scenarioId: 'REQ-101-SC-01', requirementId: 'REQ-101', title: 'postal code required', startSignedIn: true,
      steps: [
        { kind: 'action', target: 'checkoutInformationPage.submit', args: [{ kind: 'customer', omit: ['postalCode'] }] },
        { kind: 'expect', target: 'checkoutInformationPage.errorMessage', select: 'all', matcher: 'toHaveText', expected: 'Error: Postal Code is required', negate: false },
      ],
    };
    const source = renderSpec(s, 'run-1');
    expect(source).toContain('await checkoutInformationPage.submit({ ...defaultCustomer, postalCode: undefined });');
    expect(source).not.toContain('SIGNED_OUT');
  });
});
