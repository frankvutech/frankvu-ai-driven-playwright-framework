import type { Requirement } from '../src/agent/domain/requirement';
import type { Scenario } from '../src/agent/domain/plan';
import type { Step, TestSpec } from '../src/agent/domain/testSpec';
import type { AssertionWeakness } from './schema';

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

  const assertions = spec.steps.filter((s): s is Assertion => s.kind !== 'action');
  if (assertions.length === 0) {
    add('AQ_MISSING', [], 'the test asserts nothing', 'no expect or expectUrl step');
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
    if (step.kind === 'action') flush();
    else segment.push(step);
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
