import { users } from '../../data/users';
import { exampleAppUsers } from '../../data/exampleApp';
import { supportsLayer, type ApplicationId, type Layer } from '../domain/application';
import { isAssertion, type ApiArg, type Arg, type Step, type TestSpec, type Text } from '../domain/testSpec';
import { API_CATALOG, SCHEMA_FIELDS, type ApiParam, type SchemaName } from './apiCatalog';
import { CATALOG, NOTES_UI_CATALOG, SORT_OPTIONS, splitTarget, type FixtureSpec, type ParamType } from './catalog';

export interface SpecIssue {
  code:
    | 'unknown_scenario'
    | 'requirement_mismatch'
    | 'layer_mismatch'
    | 'unknown_fixture'
    | 'unknown_method'
    | 'unknown_locator'
    | 'argument_mismatch'
    | 'matcher_mismatch'
    | 'literal_secret'
    | 'unsafe_url_pattern'
    | 'unknown_response'
    | 'unknown_field'
    | 'step_not_allowed'
    | 'uncleaned_data'
    | 'no_assertion'
    | 'trailing_action';
  severity: 'error' | 'warning';
  step?: number;
  message: string;
}

export interface SpecContext {
  /** Application of the requirement (default storefront). */
  application?: ApplicationId;
  /** Layer of each allowed scenario, from the validated plan. */
  layers?: ReadonlyMap<string, Layer>;
}

const KNOWN_SECRETS = new Set<string>([...Object.values(users), ...Object.values(exampleAppUsers)].map((u) => u.password));

/** Page-object fixtures available to a test of this application. */
function pageCatalog(app: ApplicationId): Record<string, FixtureSpec> {
  return app === 'storefront' ? CATALOG : app === 'notes' ? NOTES_UI_CATALOG : {};
}

function checkArg(arg: Arg, param: ParamType): string | undefined {
  switch (param) {
    case 'string':
      if (arg.kind === 'literal' || arg.kind === 'data') return undefined;
      return 'expected a string (literal or data ref)';
    case 'text':
      if (arg.kind === 'literal' || arg.kind === 'prefixed') return undefined;
      return 'expected a text (literal or prefixed)';
    case 'customer':
      return arg.kind === 'customer' ? undefined : 'expected a customer argument';
    case 'sortOption':
      return arg.kind === 'literal' && (SORT_OPTIONS as readonly string[]).includes(arg.value)
        ? undefined
        : `expected one of ${SORT_OPTIONS.join(', ')}`;
  }
}

function checkApiArg(arg: ApiArg, param: ApiParam): string | undefined {
  switch (param) {
    case 'noteId':
      return arg.kind === 'ref' || (arg.kind === 'literal' && typeof arg.value === 'string') ? undefined : 'expected a note id (ref or string literal)';
    case 'postId':
      return arg.kind === 'literal' && typeof arg.value === 'number' ? undefined : 'expected a numeric post id';
    case 'noteInput':
      return arg.kind === 'note' && arg.title !== null ? undefined : 'expected a note with a title';
    case 'notePatch':
      return arg.kind === 'note' ? undefined : 'expected a note (fields to change)';
    case 'postInput':
      return arg.kind === 'post' && arg.id === null && arg.userId !== null && arg.title !== null && arg.body !== null
        ? undefined
        : 'expected a post with userId, title and body (no id)';
    case 'postReplace':
      return arg.kind === 'post' && arg.id !== null && arg.userId !== null && arg.title !== null && arg.body !== null
        ? undefined
        : 'expected a full post including id';
    case 'postPatch':
      return arg.kind === 'post' && arg.id === null ? undefined : 'expected a post with only the fields to change';
    case 'postQuery':
      return arg.kind === 'query' ? undefined : 'expected a query';
    case 'credentials':
      return arg.kind === 'credentials' ? undefined : 'expected credentials from test data';
  }
}

function textValues(t: Text | null): string[] {
  return t && t.kind === 'literal' ? [t.value] : [];
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

/** Steps each layer may use. UI steps reach the browser; API steps reach API clients. */
const UI_STEPS = new Set(['action', 'expect', 'expectUrl', 'signIn']);
const API_STEPS = new Set(['apiCall', 'expectStatus', 'expectHeader', 'expectBody']);

/**
 * Check a model-proposed spec against the catalogs and the approved scenarios.
 * Anything not expressible through existing page objects and API clients is
 * rejected here, before any code exists.
 */
export function validateSpec(input: TestSpec, allowedScenarioIds: ReadonlySet<string>, requirementId: string, ctx: SpecContext = {}): SpecIssue[] {
  // Specs that bypassed schema parsing (older recordings) default to the ui layer.
  const spec: TestSpec = { ...input, layer: input.layer ?? 'ui' };
  const app = ctx.application ?? 'storefront';
  const pages = pageCatalog(app);
  const issues: SpecIssue[] = [];
  if (!allowedScenarioIds.has(spec.scenarioId)) {
    issues.push({ code: 'unknown_scenario', severity: 'error', message: `${spec.scenarioId} is not a validated, traceable scenario` });
  }
  if (spec.requirementId !== requirementId) {
    issues.push({ code: 'requirement_mismatch', severity: 'error', message: `spec traces to ${spec.requirementId}, expected ${requirementId}` });
  }
  const scenarioLayer = ctx.layers?.get(spec.scenarioId);
  if (scenarioLayer !== undefined && scenarioLayer !== spec.layer) {
    issues.push({ code: 'layer_mismatch', severity: 'error', message: `scenario is a ${scenarioLayer} scenario, spec says ${spec.layer}` });
  }
  if (!supportsLayer(app, spec.layer)) {
    issues.push({ code: 'layer_mismatch', severity: 'error', message: `${app} has no ${spec.layer} tests` });
  }
  if (app !== 'storefront' && spec.startSignedIn) {
    issues.push({ code: 'step_not_allowed', severity: 'error', message: 'startSignedIn applies to the storefront only; use a signIn step' });
  }

  const responses = new Map<string, { client: keyof typeof API_CATALOG; returns: SchemaName | null }>();
  let usesUi = false;
  let usesApi = false;

  spec.steps.forEach((step, i) => {
    const err = (code: SpecIssue['code'], message: string, severity: SpecIssue['severity'] = 'error') =>
      issues.push({ code, severity, step: i, message });

    if (UI_STEPS.has(step.kind)) usesUi = true;
    if (API_STEPS.has(step.kind)) usesApi = true;
    if (spec.layer === 'ui' && API_STEPS.has(step.kind)) return err('step_not_allowed', `${step.kind} is an API step; this is a ui test`);
    if (spec.layer === 'api' && UI_STEPS.has(step.kind)) return err('step_not_allowed', `${step.kind} is a UI step; this is an api test`);

    switch (step.kind) {
      case 'expectUrl': {
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
      case 'signIn':
        if (app !== 'notes') err('step_not_allowed', 'signIn is only available for the notes app');
        return;
      case 'apiCall': {
        const client = API_CATALOG[step.client];
        if (client.application !== app) return err('unknown_method', `${step.client} belongs to ${client.application}, not ${app}`);
        const method = client.methods[step.method];
        if (!method) return err('unknown_method', `${step.client} has no method "${step.method}"`);
        if (!client.principals.includes(step.as)) {
          return err('argument_mismatch', `${step.client} is called as ${client.principals.map((p) => p ?? 'null').join(' | ')}, not ${step.as ?? 'null'}`);
        }
        if (responses.has(step.saveAs)) err('argument_mismatch', `${step.saveAs} is already used`);
        if (step.args.length !== method.params.length) {
          err('argument_mismatch', `${step.client}.${step.method} takes ${method.params.length} argument(s), got ${step.args.length}`);
        } else {
          step.args.forEach((arg, a) => {
            const problem = checkApiArg(arg, method.params[a]);
            if (problem) err('argument_mismatch', `${step.client}.${step.method} argument ${a + 1}: ${problem}`);
            if (arg.kind === 'ref') {
              const source = responses.get(arg.response);
              if (!source) err('unknown_response', `${arg.response} is used before it is defined`);
              else if (source.returns === null || !(arg.field in SCHEMA_FIELDS[source.returns])) err('unknown_field', `${arg.response} has no field "${arg.field}"`);
            }
            if (arg.kind === 'note') {
              const literals = [...textValues(arg.title), ...textValues(arg.body)];
              if (literals.some((v) => KNOWN_SECRETS.has(v))) err('literal_secret', 'credentials must never appear in test data');
              if (step.method === 'create' && arg.title && (arg.title.kind === 'literal' || arg.title.kind === 'repeat')) {
                err('uncleaned_data', 'a note created with a title that does not start with the test prefix is not cleaned up automatically', 'warning');
              }
            }
            if (arg.kind === 'post' && [arg.title, arg.body].some((v) => v !== null && KNOWN_SECRETS.has(v))) {
              err('literal_secret', 'credentials must never appear in test data');
            }
          });
        }
        responses.set(step.saveAs, { client: step.client, returns: method.returns });
        return;
      }
      case 'expectStatus':
      case 'expectHeader': {
        if (!responses.has(step.response)) err('unknown_response', `${step.response} is used before it is defined`);
        if (step.kind === 'expectHeader' && step.header === 'authorization') err('literal_secret', 'tests must not assert on credentials');
        return;
      }
      case 'expectBody': {
        const source = responses.get(step.response);
        if (!source) return err('unknown_response', `${step.response} is used before it is defined`);
        const client = API_CATALOG[source.client];
        if (step.schema !== source.returns && step.schema !== client.errorSchema) {
          err('unknown_field', `${step.response} is ${source.returns ?? 'empty'}${client.errorSchema ? ` or ${client.errorSchema}` : ''}, not ${step.schema}`);
        }
        if (step.field === null) {
          if (step.matcher !== null || step.expected !== null) err('matcher_mismatch', 'a schema-only check takes no matcher or expected value');
          return;
        }
        const fieldType = SCHEMA_FIELDS[step.schema][step.field];
        if (!fieldType) return err('unknown_field', `${step.schema} has no assertable field "${step.field}"`);
        if (step.matcher === null || step.expected === null) return err('matcher_mismatch', 'a field check needs a matcher and an expected value');
        if (step.matcher === 'toContain' && !fieldType.endsWith('[]') && fieldType !== 'string') err('matcher_mismatch', `toContain does not apply to ${fieldType}`);
        if (step.expected.kind === 'ref') {
          const other = responses.get(step.expected.response);
          if (!other) err('unknown_response', `${step.expected.response} is used before it is defined`);
          else if (other.returns === null || !(step.expected.field in SCHEMA_FIELDS[other.returns])) err('unknown_field', `${step.expected.response} has no field "${step.expected.field}"`);
          else if (step.expected.response === step.response) err('matcher_mismatch', 'an expected value cannot come from the response under test');
        }
        if (step.expected.kind === 'literal' && typeof step.expected.value === 'string' && KNOWN_SECRETS.has(step.expected.value)) {
          err('literal_secret', 'expected values must not contain credentials');
        }
        return;
      }
      case 'action': {
        const parts = splitTarget(step.target);
        const fixture = parts && pages[parts.fixture];
        if (!parts || !fixture) return err('unknown_fixture', `"${step.target}" does not start with a known page-object fixture of ${app}`);
        const method = fixture.methods[parts.member];
        if (!method) return err('unknown_method', `${fixture.className} has no action "${parts.member}"`);
        if (step.args.length !== method.params.length) {
          return err('argument_mismatch', `${step.target} takes ${method.params.length} argument(s), got ${step.args.length}`);
        }
        step.args.forEach((arg, a) => {
          const problem = checkArg(arg, method.params[a]);
          if (problem) err('argument_mismatch', `${step.target} argument ${a + 1}: ${problem}`);
          if (arg.kind === 'literal' && KNOWN_SECRETS.has(arg.value)) {
            err('literal_secret', 'credentials must be passed as data refs, never as literals');
          }
          if (arg.kind === 'data' && app === 'storefront' && arg.ref.startsWith('exampleAppUsers.')) err('argument_mismatch', 'example-app users do not exist on the storefront');
          if (arg.kind === 'data' && app === 'notes' && arg.ref.startsWith('users.')) err('argument_mismatch', 'storefront users do not exist in the notes app');
        });
        return;
      }
      case 'expect': {
        const parts = splitTarget(step.target);
        const fixture = parts && pages[parts.fixture];
        if (!parts || !fixture) return err('unknown_fixture', `"${step.target}" does not start with a known page-object fixture of ${app}`);
        const locatorMethod = fixture.locatorMethods?.[parts.member];
        if (locatorMethod) {
          const args = step.locatorArgs ?? [];
          if (args.length !== locatorMethod.params.length) return err('argument_mismatch', `${step.target} takes ${locatorMethod.params.length} argument(s)`);
          args.forEach((arg, a) => {
            const problem = checkArg(arg, locatorMethod.params[a]);
            if (problem) err('argument_mismatch', `${step.target} argument ${a + 1}: ${problem}`);
          });
        } else if (!(parts.member in fixture.locators)) {
          return err('unknown_locator', `${fixture.className} has no locator "${parts.member}"`);
        } else if (step.locatorArgs && step.locatorArgs.length > 0) {
          return err('argument_mismatch', `${step.target} is a locator, not a locator method`);
        }
        const problem = checkMatcher(step);
        if (problem) err('matcher_mismatch', problem);
        const values = Array.isArray(step.expected) ? step.expected : [step.expected];
        if (values.some((v) => typeof v === 'string' && KNOWN_SECRETS.has(v))) {
          err('literal_secret', 'expected values must not contain credentials');
        }
        return;
      }
    }
  });

  if (spec.layer === 'combined' && !(usesUi && usesApi)) {
    issues.push({ code: 'layer_mismatch', severity: 'error', message: 'a combined test must use both UI and API steps' });
  }
  if (!spec.steps.some(isAssertion)) {
    issues.push({ code: 'no_assertion', severity: 'error', message: 'a test must assert something' });
  } else if (!isAssertion(spec.steps[spec.steps.length - 1])) {
    issues.push({ code: 'trailing_action', severity: 'warning', message: 'the last step is an action with no assertion after it' });
  }
  return issues;
}
