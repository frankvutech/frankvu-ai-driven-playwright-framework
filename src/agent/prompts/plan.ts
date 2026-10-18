import type { Requirement, RequirementAssessment } from '../domain/requirement';
import { CATALOG } from '../generation/catalog';
import { DATA_RULE, JSON_RULE, asData } from './common';

export const PLAN_SYSTEM = `You are a senior test analyst. You turn one software requirement into a small, traceable test plan.

Rules:
- Derive expected behaviour only from the requirement and its acceptance criteria. Do not invent product behaviour.
- Every scenario lists the acceptanceCriteriaIds it verifies. A scenario that verifies none is an assumption: give it acceptanceCriteriaIds [] and state the assumption in "assumptions".
- Scenario ids are "<requirementId>-SC-01", "-SC-02", ... and each scenario's requirementId is the input requirement id.
- Add negative, boundary or authorization scenarios only when the requirement makes them relevant. Do not pad the plan.
- Put anything vague, contradictory or missing in "ambiguities" (plan level) or "openQuestions" (scenario level). Do not resolve it silently.
- If an acceptance criterion cannot be covered, list it in "uncoveredAcceptanceCriteria" with a reason.
- Expected outcomes quote the observable result (text, count, page) stated in the requirement wherever possible.
- ${DATA_RULE}
- ${JSON_RULE}`;

export function planPrompt(req: Requirement, assessment: RequirementAssessment): string {
  const pages = Object.entries(CATALOG).map(([fixture, spec]) => `${fixture} (${spec.path})`);
  return [
    'Plan tests for this requirement.',
    asData('requirement', req),
    asData('deterministic_findings', assessment.issues),
    `Application under test: an e-commerce demo with these pages: ${pages.join(', ')}.`,
  ].join('\n\n');
}
