import { users } from '../../data/users';
import type { Arg, Step, TestSpec } from '../domain/testSpec';
import { CATALOG, SORT_OPTIONS, splitTarget, type ParamType } from './catalog';

export interface SpecIssue {
  code:
    | 'unknown_scenario'
    | 'requirement_mismatch'
    | 'unknown_fixture'
    | 'unknown_method'
    | 'unknown_locator'
    | 'argument_mismatch'
    | 'matcher_mismatch'
    | 'literal_secret'
    | 'unsafe_url_pattern'
    | 'no_assertion'
    | 'trailing_action';
  severity: 'error' | 'warning';
  step?: number;
  message: string;
}

const KNOWN_SECRETS = new Set<string>(Object.values(users).map((u) => u.password));

function checkArg(arg: Arg, param: ParamType): string | undefined {
  switch (param) {
    case 'string':
      if (arg.kind === 'literal' || arg.kind === 'data') return undefined;
      return 'expected a string (literal or data ref)';
    case 'customer':
      return arg.kind === 'customer' ? undefined : 'expected a customer argument';
    case 'sortOption':
      return arg.kind === 'literal' && (SORT_OPTIONS as readonly string[]).includes(arg.value)
        ? undefined
        : `expected one of ${SORT_OPTIONS.join(', ')}`;
  }
}

function checkMatcher(step: Extract<Step, { kind: 'expect' }>): string | undefined {
  const e = step.expected;
  switch (step.matcher) {
    case 'toBeVisible':
    case 'toBeHidden':
      return e === null ? undefined : `${step.matcher} takes no expected value`;
    case 'toHaveCount':
      return typeof e === 'number' ? undefined : 'toHaveCount needs a number';
    case 'toHaveText':
      return typeof e === 'string' || Array.isArray(e) ? undefined : 'toHaveText needs a string or string[]';
    case 'toContainText':
    case 'toHaveValue':
      return typeof e === 'string' ? undefined : `${step.matcher} needs a string`;
  }
}

/**
 * Check a model-proposed spec against the catalog and the approved scenarios.
 * Anything not expressible through existing page objects is rejected here,
 * before any code exists.
 */
export function validateSpec(spec: TestSpec, allowedScenarioIds: ReadonlySet<string>, requirementId: string): SpecIssue[] {
  const issues: SpecIssue[] = [];
  if (!allowedScenarioIds.has(spec.scenarioId)) {
    issues.push({ code: 'unknown_scenario', severity: 'error', message: `${spec.scenarioId} is not a validated, traceable scenario` });
  }
  if (spec.requirementId !== requirementId) {
    issues.push({ code: 'requirement_mismatch', severity: 'error', message: `spec traces to ${spec.requirementId}, expected ${requirementId}` });
  }

  spec.steps.forEach((step, i) => {
    const err = (code: SpecIssue['code'], message: string) => issues.push({ code, severity: 'error', step: i, message });

    if (step.kind === 'expectUrl') {
      const p = step.pathPattern;
      if (p.includes('://') || p.startsWith('//') || /\s/.test(p)) {
        err('unsafe_url_pattern', 'URL assertions may only match a path, not a host');
      } else {
        try {
          new RegExp(p);
        } catch {
          err('unsafe_url_pattern', 'pathPattern is not a valid regular expression');
        }
      }
      return;
    }

    const parts = splitTarget(step.target);
    const fixture = parts && CATALOG[parts.fixture];
    if (!parts || !fixture) {
      err('unknown_fixture', `"${step.target}" does not start with a known page-object fixture`);
      return;
    }

    if (step.kind === 'action') {
      const method = fixture.methods[parts.member];
      if (!method) {
        err('unknown_method', `${fixture.className} has no action "${parts.member}"`);
        return;
      }
      if (step.args.length !== method.params.length) {
        err('argument_mismatch', `${step.target} takes ${method.params.length} argument(s), got ${step.args.length}`);
        return;
      }
      step.args.forEach((arg, a) => {
        const problem = checkArg(arg, method.params[a]);
        if (problem) err('argument_mismatch', `${step.target} argument ${a + 1}: ${problem}`);
        if (arg.kind === 'literal' && KNOWN_SECRETS.has(arg.value)) {
          err('literal_secret', 'credentials must be passed as data refs, never as literals');
        }
      });
      return;
    }

    if (!(parts.member in fixture.locators)) {
      err('unknown_locator', `${fixture.className} has no locator "${parts.member}"`);
      return;
    }
    const problem = checkMatcher(step);
    if (problem) err('matcher_mismatch', problem);
    const values = Array.isArray(step.expected) ? step.expected : [step.expected];
    if (values.some((v) => typeof v === 'string' && KNOWN_SECRETS.has(v))) {
      err('literal_secret', 'expected values must not contain credentials');
    }
  });

  const isAssertion = (s: Step) => s.kind !== 'action';
  if (!spec.steps.some(isAssertion)) {
    issues.push({ code: 'no_assertion', severity: 'error', message: 'a test must assert something' });
  } else if (!isAssertion(spec.steps[spec.steps.length - 1])) {
    issues.push({ code: 'trailing_action', severity: 'warning', message: 'the last step is an action with no assertion after it' });
  }
  return issues;
}
