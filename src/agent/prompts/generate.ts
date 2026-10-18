import type { Requirement } from '../domain/requirement';
import type { Scenario } from '../domain/plan';
import { CUSTOMER_FIELDS, DATA_REFS, MATCHERS } from '../domain/testSpec';
import { CATALOG, SORT_OPTIONS } from '../generation/catalog';
import { DATA_RULE, JSON_RULE, asData } from './common';

export const GENERATE_SYSTEM = `You convert approved test scenarios into declarative Playwright test specs. You do not write code: deterministic tooling renders your specs into TypeScript.

Step kinds:
- action: { kind: "action", target: "<fixture>.<method>", args: [...] }. Only methods listed in the catalog.
- expect: { kind: "expect", target: "<fixture>.<locator>", select: "all"|"first"|"last", matcher, expected, negate }. Matchers: ${MATCHERS.join(', ')}. toBeVisible/toBeHidden take expected null; toHaveCount takes a number; toHaveText takes a string or an array of strings (one per element, in order).
- expectUrl: { kind: "expectUrl", pathPattern: "<regex on the URL path, e.g. inventory\\\\.html>", negate }.

Arguments: { kind: "literal", value } | { kind: "data", ref } with ref in ${DATA_REFS.join(', ')} | { kind: "customer", omit: [...] } with fields ${CUSTOMER_FIELDS.join(', ')}. Sort options: ${SORT_OPTIONS.join(', ')}.

Rules:
- One spec per scenario you can express. Copy scenarioId and requirementId exactly.
- Use only fixtures, methods and locators from the catalog. If a scenario needs something the catalog lacks, do not approximate it: add an entry to "missingCapabilities" with the page or component object you would propose, and produce no spec for it.
- Credentials always come from data refs, never literals.
- Expected values must come from the scenario's expected outcomes or the acceptance criteria. Never weaken an expectation to something trivially true.
- Every spec ends with at least one assertion that checks the scenario's outcome.
- startSignedIn: true starts with a signed-in standard user; false starts signed out (use for login scenarios).
- ${DATA_RULE}
- ${JSON_RULE}`;

export function generatePrompt(req: Requirement, scenarios: Scenario[]): string {
  return [
    'Produce test specs for these scenarios.',
    asData('requirement', req),
    asData('scenarios', scenarios),
    asData('catalog', CATALOG),
  ].join('\n\n');
}
