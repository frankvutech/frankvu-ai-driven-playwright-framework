import { test, expect } from '@playwright/test';
import { assessRequirement } from '../../src/agent/domain/requirement';
import { TestPlanSchema, validatePlan, type Scenario, type TestPlan } from '../../src/agent/domain/plan';
import { plan101, requirement101 } from './helpers';

const req = requirement101();
const ready = assessRequirement(req);
const codes = (plan: TestPlan, assessment = ready) => validatePlan(plan, req, assessment).issues.map((i) => i.code);
const scenario = (over: Partial<Scenario>): Scenario => ({ ...plan101().scenarios[0], ...over });

test.describe('test plan validation', () => {
  test('the example plan is schema-valid, traceable and covers every criterion', () => {
    const plan = TestPlanSchema.parse(plan101());
    const result = validatePlan(plan, req, ready);
    expect(result.valid).toBe(true);
    expect(result.coverage).toEqual({ covered: ['AC-1', 'AC-2', 'AC-3'], uncovered: [] });
    expect(result.traceableScenarioIds).toEqual(['REQ-101-SC-01', 'REQ-101-SC-02', 'REQ-101-SC-03']);
    expect(result.assumptionScenarioIds).toEqual(['REQ-101-SC-04']);
  });

  test('a scenario with no criterion and no stated assumption is an error', () => {
    const plan = plan101();
    plan.scenarios.push(scenario({ id: 'REQ-101-SC-05', acceptanceCriteriaIds: [], assumptions: [] }));
    const result = validatePlan(plan, req, ready);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'untraceable_scenario', scenarioId: 'REQ-101-SC-05' }));
  });

  test('references to criteria that do not exist are errors', () => {
    const plan = plan101();
    plan.scenarios[0] = scenario({ acceptanceCriteriaIds: ['AC-1', 'AC-7'] });
    expect(codes(plan)).toContain('unknown_acceptance_criterion');
  });

  test('scenarios must trace to the input requirement', () => {
    const plan = plan101();
    plan.scenarios[0] = scenario({ id: 'REQ-999-SC-01', requirementId: 'REQ-999' });
    expect(codes(plan)).toContain('requirement_mismatch');
    expect(codes({ ...plan101(), requirementId: 'REQ-1' })).toContain('requirement_mismatch');
  });

  test('duplicate scenario ids are errors', () => {
    const plan = plan101();
    plan.scenarios[1] = { ...plan.scenarios[1], id: 'REQ-101-SC-01' };
    expect(codes(plan)).toContain('duplicate_scenario_id');
  });

  test('a silently dropped criterion is an error; a declared gap is a warning', () => {
    const dropped = { ...plan101(), scenarios: plan101().scenarios.slice(0, 2) };
    expect(validatePlan(dropped, req, ready).valid).toBe(false);
    expect(codes(dropped)).toContain('undeclared_uncovered_criterion');

    const declared = { ...dropped, uncoveredAcceptanceCriteria: [{ id: 'AC-3', reason: 'needs an invalid account' }] };
    const result = validatePlan(declared, req, ready);
    expect(result.valid).toBe(true);
    expect(result.coverage.uncovered).toEqual(['AC-3']);
    expect(codes(declared)).toContain('declared_uncovered_criterion');
  });

  test('vague requirements must have their ambiguity surfaced', () => {
    const vague = assessRequirement({ ...req, description: 'Sign-in should be fast.' });
    expect(codes({ ...plan101(), ambiguities: [] }, vague)).toContain('ambiguity_not_surfaced');
    expect(codes(plan101(), vague)).not.toContain('ambiguity_not_surfaced');
  });

  test('the schema rejects missing fields and unknown scenario types', () => {
    const bad = plan101() as unknown as { scenarios: Array<Record<string, unknown>> };
    bad.scenarios[0].type = 'happy-path';
    delete bad.scenarios[1].expectedOutcomes;
    const parsed = TestPlanSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join('.'))).toEqual(
      expect.arrayContaining(['scenarios.0.type', 'scenarios.1.expectedOutcomes']),
    );
  });
});
