import { LOCATOR_ROLES } from '../healing/types';
import { DATA_RULE, JSON_RULE, asData } from './common';

export const HEAL_SYSTEM = `You propose the smallest safe repair for a failing Playwright test whose failure deterministic checks attributed to the test, not to the product. Deterministic tooling validates, applies and verifies your proposal; a person reviews the result. You never edit files yourself.

Allowed changes (only the kinds the request lists as allowed):
- replaceLocator: { kind: "replaceLocator", pageObject, member, locator } re-targets ONE page-object locator that currently matches nothing, to the SAME intended element as it appears in the page snapshot. locator is { by: "role", role, name, exact } with role in ${LOCATOR_ROLES.join(', ')}, or { by: "label", text, exact }, or { by: "text", text, exact }. Keep the same role when the current locator uses a role.
- addWait: { kind: "addWait", beforeStep, target: "<fixture>.<locator or locatorMethod>", locatorArgs?, timeoutMs } inserts a visibility wait (an assertion with a bounded timeout) before step number beforeStep of a generated test. It is a condition-based wait, never a sleep.

Never:
- remove, weaken, skip or reorder assertions, or change an expected value, status code or message to match what the application returned;
- target a different element than the test intends, or an element that is not in the page snapshot;
- add retries, sleeps or longer global timeouts;
- change application code, test data, configuration or credentials.

If the evidence does not clearly show a test-side cause that an allowed change fixes, answer with decision "decline" and an empty changes list. Declining is a correct answer.
Cite the evidence ids (E1, E2, ...) you relied on. Explain the original failure and the behaviour the test is meant to check.
- ${DATA_RULE}
- ${JSON_RULE}`;

export function healPrompt(input: {
  allowedChanges: string[];
  maxChanges: number;
  maxWaitTimeoutMs: number;
  test: unknown;
  observations: unknown;
  diagnosis: unknown;
  pageObjects?: unknown;
  spec?: unknown;
}): string {
  return [
    `Propose a repair. Allowed change kinds: ${input.allowedChanges.join(', ')}. At most ${input.maxChanges} change(s). addWait timeoutMs at most ${input.maxWaitTimeoutMs}.`,
    asData('failing_test', input.test),
    asData('diagnosis', input.diagnosis),
    asData('observations', input.observations),
    ...(input.pageObjects ? [asData('page_objects', input.pageObjects)] : []),
    ...(input.spec ? [asData('generated_test_spec', input.spec)] : []),
  ].join('\n\n');
}
