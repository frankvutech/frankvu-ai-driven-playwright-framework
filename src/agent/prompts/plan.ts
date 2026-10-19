import { APPLICATIONS } from '../domain/application';
import type { Requirement, RequirementAssessment } from '../domain/requirement';
import { API_CATALOG } from '../generation/apiCatalog';
import { CATALOG, NOTES_UI_CATALOG } from '../generation/catalog';
import { DATA_RULE, JSON_RULE, asData } from './common';

export const PLAN_SYSTEM = `You are a senior test analyst. You turn one software requirement into a small, traceable test plan.

Rules:
- Derive expected behaviour only from the requirement and its acceptance criteria. Do not invent product behaviour.
- Every scenario lists the acceptanceCriteriaIds it verifies. A scenario that verifies none is an assumption: give it acceptanceCriteriaIds [] and state the assumption in "assumptions".
- Scenario ids are "<requirementId>-SC-01", "-SC-02", ... and each scenario's requirementId is the input requirement id.
- Add negative, boundary or authorization scenarios only when the requirement makes them relevant. Do not pad the plan.
- Give every scenario a "layer": "ui" (browser only), "api" (HTTP API only) or "combined" (UI and API in one test, e.g. create through the API and check the UI). Use only layers the application supports.
- Use only endpoints, pages, status codes and messages stated in the requirement or the application facts. If a criterion depends on behaviour that is not stated anywhere, ask in "openQuestions" instead of guessing it.
- Put anything vague, contradictory or missing in "ambiguities" (plan level) or "openQuestions" (scenario level). Do not resolve it silently.
- If an acceptance criterion cannot be covered, list it in "uncoveredAcceptanceCriteria" with a reason.
- Expected outcomes quote the observable result (text, count, page) stated in the requirement wherever possible.
- ${DATA_RULE}
- ${JSON_RULE}`;

export function planPrompt(req: Requirement, assessment: RequirementAssessment): string {
  const app = APPLICATIONS[req.application];
  const facts: Record<string, unknown> = { application: req.application, description: app.description, supportedLayers: app.layers };
  if (req.application === 'storefront') facts.pages = Object.entries(CATALOG).map(([fixture, spec]) => `${fixture} (${spec.path})`);
  if (req.application === 'notes') {
    facts.pages = Object.entries(NOTES_UI_CATALOG).map(([fixture, spec]) => `${fixture} (${spec.path})`);
    facts.apiContract = [...API_CATALOG.auth.contract, ...API_CATALOG.notes.contract];
    facts.users = ['alice', 'bob'];
  }
  if (req.application === 'posts') facts.apiContract = API_CATALOG.posts.contract;
  return [
    'Plan tests for this requirement.',
    asData('requirement', req),
    asData('deterministic_findings', assessment.issues),
    asData('application_facts', facts),
  ].join('\n\n');
}
