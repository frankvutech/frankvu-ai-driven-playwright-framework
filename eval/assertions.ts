import type { Requirement } from '../src/agent/domain/requirement';
import type { Scenario } from '../src/agent/domain/plan';
import type { Step, TestSpec } from '../src/agent/domain/testSpec';
import type { AssertionWeakness } from './schema';
import { API_CATALOG } from '../src/agent/generation/apiCatalog';

/**
 * Deterministic assertion-quality rules over a candidate TestSpec. They detect
 * observable weaknesses; they cannot decide whether an assertion is
 * semantically right. That needs reviewed references or a semantic evaluator.
 */
export interface AssertionFinding {
  scenarioId: string;
  requirementId: string;
  rule: AssertionWeakness;
  /** Acceptance-criteria text the assertions should verify. */
  expectedBehavior: string;
  /** The assertion step(s) involved, as rendered text. */
  observedAssertion: string;
  weakness: string;
  evidence: string;
  method: 'deterministic-rule';
  /** Rules are heuristics; "medium" means a human should confirm. */
  uncertainty: 'low' | 'medium';
}

type Assertion = Extract<Step, { kind: 'expect' }> | Extract<Step, { kind: 'expectUrl' }>;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Quoted values ("...") in acceptance-criterion text. */
export function quotedValues(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

export function describeAssertion(step: Assertion): string {
  if (step.kind === 'expectUrl') return `expect(page)${step.negate ? '.not' : ''}.toHaveURL(/${step.pathPattern}/)`;
  const sel = step.select === 'all' ? '' : `.${step.select}()`;
  return `expect(${step.target}${sel})${step.negate ? '.not' : ''}.${step.matcher}(${step.expected === null ? '' : JSON.stringify(step.expected)})`;
}

function key(step: Assertion): string {
  return step.kind === 'expectUrl' ? `url:${step.pathPattern}` : `${step.target}|${step.select}|${step.matcher}`;
}

/** Does a value from an assertion appear in the criteria text? */
function traced(value: string | number, acText: string): boolean {
  if (typeof value === 'number') return new RegExp(`\\b${value}\\b`).test(acText) || numberWords[value]?.some((w) => norm(acText).includes(w)) === true;
  return norm(acText).includes(norm(value));
}
const numberWords: Record<number, string[]> = { 0: ['zero', 'no '], 1: ['one'], 2: ['two'], 3: ['three'], 4: ['four'], 5: ['five'], 6: ['six'] };

type ApiAssertion = Extract<Step, { kind: 'expectStatus' | 'expectHeader' | 'expectBody' }>;

export function describeApiAssertion(step: ApiAssertion): string {
  switch (step.kind) {
    case 'expectStatus':
      return `expect(${step.response}.status()).toBe(${step.status})`;
    case 'expectHeader':
      return `expect(${step.response}.headers()["${step.header}"]).${step.matcher}(${JSON.stringify(step.expected)})`;
    case 'expectBody': {
      if (step.field === null) return `parseJson(${step.response}, ${step.schema})`;
      const e = step.expected;
      const expected = !e ? '' : e.kind === 'literal' ? JSON.stringify(e.value) : e.kind === 'ref' ? `${e.response}.${e.field}` : `text(${JSON.stringify(e.text)})`;
      return `expect(${step.response}.${step.field})${step.negate ? '.not' : ''}.${step.matcher}(${expected})`;
    }
  }
}

const HTTP_STATUS = /\b[1-5]\d\d\b/g;

/**
 * API assertion rules. Every call must have its status checked. Body and
 * criteria rules judge only the response under test: the response of the
 * test's final assertion, when that assertion is an API one. In a combined test
 * whose final assertion is in the UI, the API calls are setup.
 */
function apiFindings(spec: TestSpec, acText: string, add: (rule: AssertionWeakness, observed: string, weakness: string, evidence: string, uncertainty?: 'low' | 'medium') => void) {
  const calls = spec.steps.filter((s): s is Extract<Step, { kind: 'apiCall' }> => s.kind === 'apiCall');
  if (calls.length === 0) return;
  const of = (r: string) => spec.steps.filter((s): s is ApiAssertion => (s.kind === 'expectStatus' || s.kind === 'expectHeader' || s.kind === 'expectBody') && s.response === r);
  const statedStatuses = [...new Set(acText.match(HTTP_STATUS) ?? [])];
  for (const call of calls) {
    const asserted = of(call.saveAs);
    const statuses = asserted.filter((a): a is Extract<Step, { kind: 'expectStatus' }> => a.kind === 'expectStatus');
    const observed = asserted.map(describeApiAssertion).join('; ') || '(none)';
    if (statuses.length === 0) {
      add('AQ_API_NO_STATUS', observed, `the status of ${call.client}.${call.method} (${call.saveAs}) is never checked`, `no expectStatus on ${call.saveAs}`);
      continue;
    }
    const errorCodeChecked = asserted.some((a) => a.kind === 'expectBody' && a.field === 'error.code' && !a.negate);
    if (call.client !== 'posts' && statuses.some((st) => st.status >= 400) && !errorCodeChecked) {
      add('AQ_API_ERROR_CODE_MISSING', observed, 'an error status is checked but not which error it is', `${call.saveAs} expects ${statuses.map((x) => x.status).join('/')} without error.code`, 'medium');
    }
  }
  const finalAssertion = [...spec.steps].reverse().find((s) => ['expect', 'expectUrl', 'expectStatus', 'expectHeader', 'expectBody'].includes(s.kind));
  if (!finalAssertion || !('response' in finalAssertion)) return;
  const last = calls.find((c) => c.saveAs === finalAssertion.response);
  if (!last) return;
  const lastAsserted = of(last.saveAs);
  const lastStatuses = lastAsserted.filter((a): a is Extract<Step, { kind: 'expectStatus' }> => a.kind === 'expectStatus');
  const lastObserved = lastAsserted.map(describeApiAssertion).join('; ') || '(none)';
  const untraced = lastStatuses.filter((st) => statedStatuses.length > 0 && !statedStatuses.includes(String(st.status)));
  if (untraced.length > 0) {
    add('AQ_API_STATUS_NOT_IN_CRITERIA', lastObserved, 'the expected status differs from the status the criteria state', `expects ${untraced.map((x) => x.status).join('/')}; criteria state ${statedStatuses.join('/')}`, 'medium');
  }
  if (lastStatuses.some((st) => st.status < 300) && API_CATALOG[last.client].methods[last.method]?.returns && !lastAsserted.some((a) => a.kind === 'expectBody' && a.field !== null)) {
    add('AQ_API_BODY_UNCHECKED', lastObserved, 'a successful response is accepted without checking any body field', `${last.saveAs} (${last.client}.${last.method}) has no field assertion`, 'medium');
  }
}

export function assertionFindings(spec: TestSpec, scenario: Scenario | undefined, requirement: Requirement): AssertionFinding[] {
  const acs = requirement.acceptanceCriteria.filter((ac) => scenario?.acceptanceCriteriaIds.includes(ac.id));
  const acText = acs.map((a) => a.text).join('\n');
  const quoted = acs.flatMap((a) => quotedValues(a.text));
  const findings: AssertionFinding[] = [];
  const add = (rule: AssertionWeakness, steps: Assertion[], weakness: string, evidence: string, uncertainty: 'low' | 'medium' = 'low') =>
    findings.push({
      scenarioId: spec.scenarioId,
      requirementId: spec.requirementId,
      rule,
      expectedBehavior: acText || '(no linked acceptance criteria)',
      observedAssertion: steps.map(describeAssertion).join('; ') || '(none)',
      weakness,
      evidence,
      method: 'deterministic-rule',
      uncertainty,
    });

  apiFindings(spec, acText, (rule, observed, weakness, evidence, uncertainty = 'low') =>
    findings.push({ scenarioId: spec.scenarioId, requirementId: spec.requirementId, rule, expectedBehavior: acText || '(no linked acceptance criteria)', observedAssertion: observed, weakness, evidence, method: 'deterministic-rule', uncertainty }),
  );

  // UI assertion rules (expect / expectUrl).
  const assertions = spec.steps.filter((s): s is Assertion => s.kind === 'expect' || s.kind === 'expectUrl');
  const hasApiAssertions = spec.steps.some((s) => s.kind === 'expectStatus' || s.kind === 'expectHeader' || s.kind === 'expectBody');
  if (assertions.length === 0) {
    if (!hasApiAssertions) add('AQ_MISSING', [], 'the test asserts nothing', 'no assertion step');
    return findings;
  }

  const elementAssertions = assertions.filter((a): a is Extract<Step, { kind: 'expect' }> => a.kind === 'expect');
  if (quoted.length > 0) {
    if (elementAssertions.length === 0) {
      add('AQ_NAV_ONLY', assertions, 'only the URL is checked, but the criteria state observable values', `criteria quote: ${quoted.map((q) => `"${q}"`).join(', ')}`);
    } else if (elementAssertions.every((a) => a.matcher === 'toBeVisible' || a.matcher === 'toBeHidden')) {
      add('AQ_VISIBILITY_ONLY', elementAssertions, 'only visibility is checked, but the criteria state observable values', `criteria quote: ${quoted.map((q) => `"${q}"`).join(', ')}`, 'medium');
    }
  }

  if (assertions.every((a) => a.negate)) {
    add('AQ_NEGATIVE_ONLY', assertions, 'every assertion is negated: the test only checks what did not happen', 'all assertion steps have negate=true');
  }

  for (const a of elementAssertions) {
    const values = a.expected === null ? [] : Array.isArray(a.expected) ? a.expected : [a.expected];
    const untraced = values.filter((v) => !traced(v, acText));
    if (untraced.length > 0) {
      add('AQ_UNTRACED', [a], 'the expected value is not stated in the linked acceptance criteria', `not found in criteria: ${untraced.map((v) => JSON.stringify(v)).join(', ')}`, 'medium');
    }
    if (a.matcher === 'toContainText' && typeof a.expected === 'string') {
      const full = quoted.find((q) => norm(q).includes(norm(a.expected as string)) && norm(q) !== norm(a.expected as string));
      if (full && (a.expected as string).length < 0.6 * full.length) {
        add('AQ_WEAK_PARTIAL', [a], 'a short substring is checked where the criteria state the full text', `"${a.expected}" is part of "${full}"`);
      }
    }
  }

  // Contradictions and redundancy: compare assertions with no action between them.
  let segment: Assertion[] = [];
  const flush = () => {
    for (let i = 0; i < segment.length; i++) {
      for (let j = i + 1; j < segment.length; j++) {
        const x = segment[i], y = segment[j];
        if (key(x) !== key(y)) continue;
        const sameExpected = JSON.stringify(x.kind === 'expect' ? x.expected : null) === JSON.stringify(y.kind === 'expect' ? y.expected : null);
        if (sameExpected && x.negate !== y.negate) add('AQ_CONTRADICTORY', [x, y], 'the same check is asserted and negated', 'identical target/matcher/value with opposite negate');
        else if (sameExpected) add('AQ_REDUNDANT', [x, y], 'the same assertion is repeated with no action in between', 'identical assertion steps');
        else if (!x.negate && !y.negate && x.kind === 'expect' && x.matcher === 'toHaveText') {
          add('AQ_CONTRADICTORY', [x, y], 'the same element is expected to have two different texts', 'same target and matcher, different values');
        }
      }
    }
    segment = [];
  };
  for (const step of spec.steps) {
    if (step.kind === 'expect' || step.kind === 'expectUrl') segment.push(step);
    else flush();
  }
  flush();

  for (const a of assertions) {
    if (a.kind !== 'expectUrl') continue;
    let overbroad = false;
    try {
      const re = new RegExp(a.pathPattern);
      overbroad = re.test('https://example.test/') && re.test('https://example.test/any/other/page.html');
    } catch {
      overbroad = false;
    }
    if (overbroad || /\?|#|\d{4,}/.test(a.pathPattern)) {
      add('AQ_UNSTABLE_URL', [a], overbroad ? 'the URL pattern matches any page' : 'the URL pattern depends on query strings, fragments or ids', `pattern /${a.pathPattern}/`);
    }
  }
  return findings;
}
