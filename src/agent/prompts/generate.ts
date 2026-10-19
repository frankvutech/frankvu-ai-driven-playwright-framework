import type { Requirement } from '../domain/requirement';
import type { Scenario } from '../domain/plan';
import { CUSTOMER_FIELDS, DATA_REFS, MATCHERS } from '../domain/testSpec';
import { API_CATALOG, SCHEMA_FIELDS } from '../generation/apiCatalog';
import { CATALOG, NOTES_UI_CATALOG, SORT_OPTIONS } from '../generation/catalog';
import { DATA_RULE, JSON_RULE, asData } from './common';

export const GENERATE_SYSTEM = `You convert approved test scenarios into declarative Playwright test specs. You do not write code: deterministic tooling renders your specs into TypeScript that uses the framework's page objects, API clients and fixtures.

Every spec has "layer" equal to its scenario's layer: ui, api or combined (both UI and API steps).

UI steps:
- action: { kind: "action", target: "<fixture>.<method>", args: [...] }. Only methods listed in the page catalog.
- expect: { kind: "expect", target: "<fixture>.<locator or locatorMethod>", locatorArgs?: [...], select: "all"|"first"|"last", matcher, expected, negate, timeoutMs?: 1000..15000 }. Matchers: ${MATCHERS.join(', ')}. toBeVisible/toBeHidden take expected null; toHaveCount takes a number; toHaveText takes a string or an array of strings (one per element, in order). locatorArgs only for locatorMethods.
- expectUrl: { kind: "expectUrl", pathPattern: "<regex on the URL path, e.g. inventory\\\\.html>", negate }.
- signIn (notes app only): { kind: "signIn", as: "alice"|"bob" } signs the browser in without UI steps.

API steps (r1, r2, ... name responses in order):
- apiCall: { kind: "apiCall", saveAs: "r1", client: "notes"|"auth"|"posts", as: "alice"|"bob"|"anonymous"|null, method, args: [...] }. notes is called as alice, bob or anonymous (no token); auth and posts as null.
- expectStatus: { kind: "expectStatus", response: "r1", status: 201 }.
- expectHeader: { kind: "expectHeader", response, header: "<lower-case name>", matcher: "toBe"|"toContain", expected: "<text>" }.
- expectBody: { kind: "expectBody", response, schema, field, matcher: "toBe"|"toContain"|null, expected: { kind: "literal", value } | { kind: "ref", response: "<earlier response>", field } | { kind: "text", text } | null, negate }. field null with matcher and expected null only validates the body against the schema. Assertable fields per schema: ${JSON.stringify(SCHEMA_FIELDS)}.

Arguments:
- UI: { kind: "literal", value } | { kind: "data", ref } with ref in ${DATA_REFS.join(', ')} | { kind: "customer", omit: [...] } with fields ${CUSTOMER_FIELDS.join(', ')} | { kind: "prefixed", suffix }. Sort options: ${SORT_OPTIONS.join(', ')}.
- API: { kind: "ref", response, field: "id" } | { kind: "literal", value } | { kind: "note", title: text|null, body: text|null } | { kind: "post", id, userId, title, body } (null for fields to leave out) | { kind: "query", userId } | { kind: "credentials", user: "alice"|"bob", password: "valid"|"wrong" }.
- text: { kind: "prefixed", suffix } (starts with the test's unique prefix; use it for every note a test creates) | { kind: "padded", length } (prefix padded to an exact length, for boundaries) | { kind: "repeat", char, count } | { kind: "literal", value }.

Rules:
- One spec per scenario you can express. Copy scenarioId, requirementId and layer exactly.
- Use only fixtures, methods, locators, API clients and fields from the catalogs. If a scenario needs something they lack, do not approximate it: add an entry to "missingCapabilities" and produce no spec for it.
- Credentials always come from data refs or credentials arguments, never literals. Never assert on tokens.
- Expected values, status codes and messages must come from the scenario's expected outcomes, the acceptance criteria or the API contract. Never guess a value and never weaken an expectation to something trivially true.
- A ref expected value compares two responses (for example: the list contains the id of the note created earlier). It must not come from the response under test.
- Every spec ends with at least one assertion that checks the scenario's outcome. API tests assert the status code and the relevant body fields; error cases assert the error code.
- startSignedIn applies to storefront tests only (true: start as the signed-in standard user). Notes UI tests sign in with a signIn step or through the sign-in page.
- ${DATA_RULE}
- ${JSON_RULE}`;

export function generatePrompt(req: Requirement, scenarios: Scenario[]): string {
  const catalogs: unknown[] = [];
  if (req.application === 'storefront') catalogs.push(asData('page_catalog', CATALOG));
  if (req.application === 'notes') {
    catalogs.push(asData('page_catalog', NOTES_UI_CATALOG));
    catalogs.push(asData('api_catalog', { notes: API_CATALOG.notes, auth: API_CATALOG.auth }));
  }
  if (req.application === 'posts') catalogs.push(asData('api_catalog', { posts: API_CATALOG.posts }));
  return ['Produce test specs for these scenarios.', asData('requirement', req), asData('scenarios', scenarios), ...catalogs].join('\n\n');
}
