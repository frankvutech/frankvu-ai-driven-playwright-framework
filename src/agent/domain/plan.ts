import { z } from 'zod';
import { APPLICATIONS, LAYERS, supportsLayer } from './application';
import type { Requirement, RequirementAssessment } from './requirement';

export const ScenarioTypeSchema = z.enum(['positive', 'negative', 'boundary', 'authorization']);

export const ScenarioSchema = z
  .object({
    id: z.string().regex(/^[A-Z][A-Z0-9]*-\d+-SC-\d{2,}$/, 'scenario ids look like REQ-101-SC-01'),
    requirementId: z.string(),
    acceptanceCriteriaIds: z.array(z.string()),
    title: z.string().min(1).max(200),
    objective: z.string().min(1).max(1000),
    type: ScenarioTypeSchema,
    /** ui, api or combined (UI and API in one test). Defaults to ui for older plans. */
    layer: z.enum(LAYERS).default('ui'),
    priority: z.enum(['high', 'medium', 'low']),
    priorityRationale: z.string().max(500),
    preconditions: z.array(z.string().max(500)).max(20),
    steps: z.array(z.string().max(500)).min(1).max(30),
    testData: z.array(z.string().max(500)).max(20),
    expectedOutcomes: z.array(z.string().max(500)).min(1).max(20),
    assumptions: z.array(z.string().max(500)).max(20),
    openQuestions: z.array(z.string().max(500)).max(20),
  })
  .strict();

export const TestPlanSchema = z
  .object({
    requirementId: z.string(),
    scenarios: z.array(ScenarioSchema).max(20),
    ambiguities: z.array(z.string().max(1000)).max(20),
    uncoveredAcceptanceCriteria: z
      .array(z.object({ id: z.string(), reason: z.string().max(500) }).strict())
      .max(50),
  })
  .strict();

export type Scenario = z.infer<typeof ScenarioSchema>;
export type TestPlan = z.infer<typeof TestPlanSchema>;

export type PlanIssueCode =
  | 'requirement_mismatch'
  | 'unknown_acceptance_criterion'
  | 'duplicate_scenario_id'
  | 'untraceable_scenario'
  | 'assumption_scenario'
  | 'undeclared_uncovered_criterion'
  | 'unsupported_layer'
  | 'declared_uncovered_criterion'
  | 'ambiguity_not_surfaced';

export interface PlanIssue {
  code: PlanIssueCode;
  severity: 'error' | 'warning';
  scenarioId?: string;
  message: string;
}

export interface PlanValidation {
  valid: boolean;
  issues: PlanIssue[];
  coverage: { covered: string[]; uncovered: string[] };
  /** Scenarios with no acceptance criterion: must be reviewed, never auto-generated. */
  assumptionScenarioIds: string[];
  /** Scenarios that trace to at least one acceptance criterion. */
  traceableScenarioIds: string[];
}

/**
 * Deterministic traceability and coverage checks on a schema-valid plan.
 * Errors make the plan unusable; warnings are surfaced for human review.
 */
export function validatePlan(
  plan: TestPlan,
  req: Requirement,
  assessment: RequirementAssessment,
): PlanValidation {
  const issues: PlanIssue[] = [];
  const acIds = new Set(req.acceptanceCriteria.map((ac) => ac.id));
  const covered = new Set<string>();
  const assumptionScenarioIds: string[] = [];
  const traceableScenarioIds: string[] = [];
  const seenIds = new Set<string>();

  if (plan.requirementId !== req.id) {
    issues.push({
      code: 'requirement_mismatch',
      severity: 'error',
      message: `plan is for ${plan.requirementId}, expected ${req.id}`,
    });
  }

  for (const sc of plan.scenarios) {
    if (seenIds.has(sc.id)) {
      issues.push({ code: 'duplicate_scenario_id', severity: 'error', scenarioId: sc.id, message: `duplicate id ${sc.id}` });
    }
    seenIds.add(sc.id);

    if (sc.requirementId !== req.id || !sc.id.startsWith(`${req.id}-SC-`)) {
      issues.push({
        code: 'requirement_mismatch',
        severity: 'error',
        scenarioId: sc.id,
        message: `scenario ${sc.id} does not trace to ${req.id}`,
      });
    }

    // Older inputs that bypassed schema parsing have no application or layer: use the schema defaults.
    const application = req.application ?? 'storefront';
    const layer = sc.layer ?? 'ui';
    if (!supportsLayer(application, layer)) {
      issues.push({
        code: 'unsupported_layer',
        severity: 'error',
        scenarioId: sc.id,
        message: `${application} supports ${APPLICATIONS[application].layers.join(', ')} tests, not ${layer}`,
      });
    }

    const unknown = sc.acceptanceCriteriaIds.filter((id) => !acIds.has(id));
    for (const id of unknown) {
      issues.push({
        code: 'unknown_acceptance_criterion',
        severity: 'error',
        scenarioId: sc.id,
        message: `references ${id}, which is not in ${req.id}`,
      });
    }
    const known = sc.acceptanceCriteriaIds.filter((id) => acIds.has(id));
    known.forEach((id) => covered.add(id));

    if (known.length === 0) {
      if (sc.assumptions.length === 0) {
        issues.push({
          code: 'untraceable_scenario',
          severity: 'error',
          scenarioId: sc.id,
          message: 'no acceptance criterion and no declared assumption',
        });
      } else {
        assumptionScenarioIds.push(sc.id);
        issues.push({
          code: 'assumption_scenario',
          severity: 'warning',
          scenarioId: sc.id,
          message: 'based only on assumptions; needs human review before it can be generated',
        });
      }
    } else {
      traceableScenarioIds.push(sc.id);
    }
  }

  const declared = new Set(plan.uncoveredAcceptanceCriteria.map((u) => u.id));
  const uncovered = [...acIds].filter((id) => !covered.has(id));
  for (const id of uncovered) {
    issues.push(
      declared.has(id)
        ? { code: 'declared_uncovered_criterion', severity: 'warning', message: `${id} is not covered (declared by planner)` }
        : { code: 'undeclared_uncovered_criterion', severity: 'error', message: `${id} was silently left uncovered` },
    );
  }

  const hasVagueTerms = assessment.issues.some((i) => i.code === 'vague_term');
  if (hasVagueTerms && plan.ambiguities.length === 0) {
    issues.push({
      code: 'ambiguity_not_surfaced',
      severity: 'warning',
      message: 'requirement contains vague terms but the plan lists no ambiguities',
    });
  }

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    issues,
    coverage: { covered: [...covered].sort(), uncovered: uncovered.sort() },
    assumptionScenarioIds,
    traceableScenarioIds,
  };
}
