import { test, expect } from '@playwright/test';
import { assertionFindings, quotedValues } from '../../eval/assertions';
import { requiredAssertionCoverage, prohibitedAssumptionHits, clarificationBehaviour } from '../../eval/semantic';
import type { Step, TestSpec } from '../../src/agent/domain/testSpec';
import type { Requirement } from '../../src/agent/domain/requirement';
import type { Scenario, TestPlan } from '../../src/agent/domain/plan';

const req: Requirement = {
  id: 'REQ-1',
  title: 't',
  description: 'd',
  application: 'storefront',
  acceptanceCriteria: [{ id: 'AC-1', text: 'A locked-out user sees "Epic sadface: Sorry, this user has been locked out." and the list shows six products.' }],
};
const scenario = { id: 'REQ-1-SC-01', acceptanceCriteriaIds: ['AC-1'] } as Scenario;
const login: Step = { kind: 'action', target: 'loginPage.login', args: [] };
const E = (target: string, matcher: Extract<Step, { kind: 'expect' }>['matcher'], expected: string | number | string[] | null, negate = false): Step => ({ kind: 'expect', target, select: 'all', matcher, expected, negate });
const U = (pathPattern: string, negate = false): Step => ({ kind: 'expectUrl', pathPattern, negate });
const spec = (steps: Step[]): TestSpec => ({ scenarioId: 'REQ-1-SC-01', requirementId: 'REQ-1', title: 't', layer: 'ui', startSignedIn: false, steps });
const rules = (steps: Step[]) => [...new Set(assertionFindings(spec(steps), scenario, req).map((f) => f.rule))].sort();
const LOCKED = 'Epic sadface: Sorry, this user has been locked out.';

test.describe('assertion-quality rules', () => {
  test('a strong, traced assertion has no findings', () => {
    expect(rules([login, E('loginPage.errorMessage', 'toHaveText', LOCKED), U('inventory\\.html', true)])).toEqual([]);
  });

  test('missing assertions', () => expect(rules([login])).toEqual(['AQ_MISSING']));

  test('navigation-only checks when the criteria state values', () => expect(rules([login, U('inventory\\.html')])).toEqual(['AQ_NAV_ONLY']));

  test('visibility-only checks', () => expect(rules([login, E('loginPage.errorMessage', 'toBeVisible', null)])).toEqual(['AQ_VISIBILITY_ONLY']));

  test('negative-only checks', () => expect(rules([login, E('loginPage.errorMessage', 'toHaveText', LOCKED, true)])).toEqual(['AQ_NEGATIVE_ONLY']));

  test('values not in the criteria', () => expect(rules([login, E('loginPage.errorMessage', 'toHaveText', 'Account locked')])).toEqual(['AQ_UNTRACED']));

  test('numbers are traced as digits or words', () => {
    expect(rules([login, E('inventoryPage.items', 'toHaveCount', 6)])).toEqual([]);
    expect(rules([login, E('inventoryPage.items', 'toHaveCount', 5)])).toEqual(['AQ_UNTRACED']);
  });

  test('weak partial matches', () => expect(rules([login, E('loginPage.errorMessage', 'toContainText', 'Epic')])).toEqual(['AQ_WEAK_PARTIAL']));

  test('contradictions and redundancy without an action in between', () => {
    expect(rules([login, E('loginPage.errorMessage', 'toHaveText', LOCKED), E('loginPage.errorMessage', 'toHaveText', LOCKED, true)])).toEqual(['AQ_CONTRADICTORY']);
    expect(rules([login, E('loginPage.errorMessage', 'toHaveText', LOCKED), E('loginPage.errorMessage', 'toHaveText', LOCKED)])).toEqual(['AQ_REDUNDANT']);
    // The same check after another action is not redundant.
    expect(rules([login, E('loginPage.errorMessage', 'toHaveText', LOCKED), login, E('loginPage.errorMessage', 'toHaveText', LOCKED)])).toEqual([]);
  });

  test('overbroad or unstable URL patterns', () => {
    expect(rules([login, E('loginPage.errorMessage', 'toHaveText', LOCKED), U('.*')])).toEqual(['AQ_UNSTABLE_URL']);
    expect(rules([login, E('loginPage.errorMessage', 'toHaveText', LOCKED), U('orders/123456')])).toEqual(['AQ_UNSTABLE_URL']);
  });

  test('each finding records the evaluation fields', () => {
    const [f] = assertionFindings(spec([login, E('loginPage.errorMessage', 'toHaveText', 'Account locked')]), scenario, req);
    expect(f).toEqual({
      scenarioId: 'REQ-1-SC-01',
      requirementId: 'REQ-1',
      rule: 'AQ_UNTRACED',
      expectedBehavior: req.acceptanceCriteria[0].text,
      observedAssertion: 'expect(loginPage.errorMessage).toHaveText("Account locked")',
      weakness: 'the expected value is not stated in the linked acceptance criteria',
      evidence: 'not found in criteria: "Account locked"',
      method: 'deterministic-rule',
      uncertainty: 'medium',
    });
  });

  test('quoted values', () => expect(quotedValues('a "b" c "d e"')).toEqual(['b', 'd e']));
});

test.describe('reference-based semantic checks', () => {
  test('required assertions must be present, positive and exact', () => {
    const s = spec([login, E('loginPage.errorMessage', 'toHaveText', LOCKED), E('inventoryPage.title', 'toHaveText', 'Products', true)]);
    const r = requiredAssertionCoverage(s, [
      { target: 'loginPage.errorMessage', expected: LOCKED },
      { target: 'inventoryPage.title', expected: 'Products' },
    ]);
    expect(r).toMatchObject({ required: 2, satisfied: 1 });
    expect(r.missing).toEqual([{ target: 'inventoryPage.title', expected: 'Products' }]);
  });

  test('prohibited assumptions are found in scenario text (case-insensitive)', () => {
    const plan = { scenarios: [{ id: 'S1', title: 'Reset shows "Check your email"', objective: '', steps: [], expectedOutcomes: [], testData: [] }] } as unknown as TestPlan;
    expect(prohibitedAssumptionHits(plan, ['check your email', 'captcha'])).toEqual([{ scenarioId: 'S1', phrase: 'check your email' }]);
  });

  test('clarification behaviour', () => {
    const plan = (amb: string[], unc: string[]) => ({ scenarios: [], ambiguities: amb, uncoveredAcceptanceCriteria: unc.map((id) => ({ id, reason: 'r' })) }) as unknown as TestPlan;
    expect(clarificationBehaviour('ask-before-planning', 'needs_clarification', undefined).ok).toBe(true);
    expect(clarificationBehaviour('ask-before-planning', 'plan_valid', plan([], [])).ok).toBe(false);
    expect(clarificationBehaviour('surface-ambiguity', 'plan_valid', plan(['conflict'], ['AC-2']), ['AC-2']).ok).toBe(true);
    expect(clarificationBehaviour('surface-ambiguity', 'plan_valid', plan([], []), []).ok).toBe(false);
    expect(clarificationBehaviour('declare-uncovered', 'plan_valid', plan([], ['AC-1']), ['AC-1']).ok).toBe(true);
    expect(clarificationBehaviour('declare-uncovered', 'plan_valid', plan([], []), ['AC-1']).ok).toBe(false);
  });
});
