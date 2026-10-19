import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RequirementSchema } from '../../src/agent/domain/requirement';
import { TestPlanSchema, validatePlan } from '../../src/agent/domain/plan';
import { assessRequirement } from '../../src/agent/domain/requirement';
import { GenerationOutputSchema, TestSpecSchema, type Step, type TestSpec } from '../../src/agent/domain/testSpec';
import { renderSpec, renderSpecWithMap } from '../../src/agent/generation/render';
import { validateSpec } from '../../src/agent/generation/validateSpec';
import { astFindings } from '../../src/agent/validation/artifacts';
import { MockProvider } from '../../src/agent/llm/mock';
import { planAndGenerate } from '../../src/agent/workflow/generate';
import { NO_WAIT, REPO_ROOT, example, policy, scratchRun } from './helpers';

test.describe.configure({ timeout: 120_000 });

const specOf = (id: 'REQ-201' | 'REQ-202' | 'REQ-203', i: number): TestSpec => TestSpecSchema.parse(example(id).generation.tests[i]);
const errors = (spec: TestSpec, app: 'notes' | 'posts' | 'storefront' = 'notes') =>
  validateSpec(spec, new Set([spec.scenarioId]), spec.requirementId, { application: app }).filter((i) => i.severity === 'error');
const withSteps = (spec: TestSpec, steps: Step[]): TestSpec => ({ ...spec, steps });

test.describe('requirements and plans for UI, API and combined tests', () => {
  test('older requirement files default to the storefront; new ones name their application', () => {
    expect(RequirementSchema.parse({ id: 'REQ-1', title: 't', description: 'd', acceptanceCriteria: [] }).application).toBe('storefront');
    expect(RequirementSchema.parse(example('REQ-201').requirement).application).toBe('notes');
    expect(RequirementSchema.safeParse({ ...example('REQ-201').requirement, application: 'banking' }).success).toBe(false);
  });

  test('example plans are traceable and use layers their application supports', () => {
    for (const id of ['REQ-201', 'REQ-202', 'REQ-203'] as const) {
      const req = RequirementSchema.parse(example(id).requirement);
      const check = validatePlan(TestPlanSchema.parse(example(id).plan), req, assessRequirement(req));
      expect(check.issues.filter((i) => i.severity === 'error'), id).toEqual([]);
      expect(check.coverage.uncovered, id).toEqual([]);
    }
  });

  test('a layer the application does not support is a plan error', () => {
    const req = RequirementSchema.parse(example('REQ-203').requirement);
    const plan = TestPlanSchema.parse(example('REQ-203').plan);
    plan.scenarios[0].layer = 'ui';
    expect(validatePlan(plan, req, assessRequirement(req)).issues).toContainEqual(expect.objectContaining({ code: 'unsupported_layer', severity: 'error' }));
  });
});

test.describe('API and combined spec validation', () => {
  test('the example API, combined and posts specs are valid', () => {
    for (const [id, app] of [['REQ-201', 'notes'], ['REQ-202', 'notes'], ['REQ-203', 'posts']] as const) {
      for (const raw of example(id).generation.tests) expect(errors(TestSpecSchema.parse(raw), app), raw.scenarioId).toEqual([]);
    }
  });

  const s1 = () => specOf('REQ-201', 0);
  const call = (over: Partial<Extract<Step, { kind: 'apiCall' }>> = {}): Step => ({ kind: 'apiCall', saveAs: 'r1', client: 'notes', as: 'alice', method: 'list', args: [], ...over });
  const cases: Array<[string, () => TestSpec, string, ('notes' | 'posts')?]> = [
    ['an unknown client method', () => withSteps(s1(), [call({ method: 'purge' }), { kind: 'expectStatus', response: 'r1', status: 200 }]), 'notes has no method "purge"'],
    ['a client of another application', () => withSteps(s1(), [call({ client: 'posts', as: null, method: 'get', args: [{ kind: 'literal', value: 1 }] }), { kind: 'expectStatus', response: 'r1', status: 200 }]), 'posts belongs to posts, not notes'],
    ['a principal the client does not accept', () => withSteps(specOf('REQ-203', 0), [{ kind: 'apiCall', saveAs: 'r1', client: 'posts', as: 'alice', method: 'get', args: [{ kind: 'literal', value: 1 }] }, { kind: 'expectStatus', response: 'r1', status: 200 }]), 'posts is called as null, not alice', 'posts'],
    ['a response used before it exists', () => withSteps(s1(), [{ kind: 'expectStatus', response: 'r2', status: 200 }]), 'r2 is used before it is defined'],
    ['a field the schema does not expose (tokens)', () => withSteps(s1(), [{ kind: 'apiCall', saveAs: 'r1', client: 'auth', as: null, method: 'token', args: [{ kind: 'credentials', user: 'alice', password: 'valid' }] }, { kind: 'expectBody', response: 'r1', schema: 'Token', field: 'token', matcher: 'toBe', expected: { kind: 'literal', value: 'x' }, negate: false }]), 'Token has no assertable field "token"'],
    ['an expected value copied from the response under test', () => withSteps(s1(), [call({ method: 'create', args: [{ kind: 'note', title: { kind: 'prefixed', suffix: 'a' }, body: null }] }), { kind: 'expectBody', response: 'r1', schema: 'Note', field: 'title', matcher: 'toBe', expected: { kind: 'ref', response: 'r1', field: 'title' }, negate: false }]), 'an expected value cannot come from the response under test'],
    ['a schema the response cannot have', () => withSteps(s1(), [call(), { kind: 'expectBody', response: 'r1', schema: 'Post', field: 'id', matcher: 'toBe', expected: { kind: 'literal', value: 1 }, negate: false }]), 'r1 is NoteList or ApiError, not Post'],
    ['credentials as literal test data', () => withSteps(s1(), [call({ method: 'create', args: [{ kind: 'note', title: { kind: 'literal', value: 'example-app-pass' }, body: null }] }), { kind: 'expectStatus', response: 'r1', status: 201 }]), 'credentials must never appear in test data'],
    ['asserting on the authorization header', () => withSteps(s1(), [call(), { kind: 'expectHeader', response: 'r1', header: 'authorization', matcher: 'toBe', expected: 'x' }]), 'tests must not assert on credentials'],
    ['a UI step in an api test', () => withSteps(s1(), [{ kind: 'signIn', as: 'alice' }, { kind: 'expectUrl', pathPattern: 'notes', negate: false }]), 'signIn is a UI step; this is an api test'],
    ['a combined test without API steps', () => ({ ...specOf('REQ-202', 0), steps: specOf('REQ-202', 0).steps.filter((s) => !s.kind.startsWith('api') && s.kind !== 'expectStatus') }), 'a combined test must use both UI and API steps'],
    ['startSignedIn outside the storefront', () => ({ ...specOf('REQ-202', 0), startSignedIn: true }), 'startSignedIn applies to the storefront only; use a signIn step'],
    ['a storefront page object in a notes test', () => withSteps(specOf('REQ-202', 0), [...specOf('REQ-202', 0).steps, { kind: 'action', target: 'loginPage.goto', args: [] }]), '"loginPage.goto" does not start with a known page-object fixture of notes'],
    ['storefront users in the notes app', () => withSteps(specOf('REQ-202', 0), [{ kind: 'action', target: 'notesLoginPage.signIn', args: [{ kind: 'data', ref: 'users.standard.username' }, { kind: 'data', ref: 'users.standard.password' }] }, ...specOf('REQ-202', 0).steps]), 'storefront users do not exist in the notes app'],
  ];
  for (const [name, build, message, app] of cases) {
    test(`rejects ${name}`, () => {
      expect(errors(build(), app ?? 'notes').map((i) => i.message)).toContain(message);
    });
  }

  test('a layer different from the scenario is rejected', () => {
    const spec = { ...specOf('REQ-201', 0), layer: 'combined' as const };
    const issues = validateSpec(spec, new Set([spec.scenarioId]), spec.requirementId, { application: 'notes', layers: new Map([[spec.scenarioId, 'api' as const]]) });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'layer_mismatch', severity: 'error' }));
  });

  test('status codes outside 100..599 are rejected by the schema', () => {
    const raw = structuredClone(example('REQ-201').generation.tests[0]) as unknown as { steps: Array<Record<string, unknown>> };
    raw.steps[1].status = 999;
    expect(TestSpecSchema.safeParse(raw).success).toBe(false);
  });

  test('a note whose title lacks the test prefix is flagged as not cleaned up', () => {
    const spec = withSteps(s1(), [call({ method: 'create', args: [{ kind: 'note', title: { kind: 'literal', value: 'x' }, body: null }] }), { kind: 'expectStatus', response: 'r1', status: 201 }]);
    const issues = validateSpec(spec, new Set([spec.scenarioId]), spec.requirementId, { application: 'notes' });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'uncleaned_data', severity: 'warning' }));
  });
});

test.describe('rendering API and combined tests', () => {
  const s1 = () => specOf('REQ-201', 0);
  const call = (over: Partial<Extract<Step, { kind: 'apiCall' }>> = {}): Step => ({ kind: 'apiCall', saveAs: 'r1', client: 'notes', as: 'alice', method: 'list', args: [], ...over });

  test('API tests use the API fixtures, clients and schemas; values are JSON literals', () => {
    const source = renderSpec(specOf('REQ-201', 2), 'run-1', { application: 'notes' });
    expect(source).toContain("import { apiTest as test, expect } from '../../src/fixtures/agent';");
    expect(source).toContain('const alice = await exampleAppApi.as("alice");');
    expect(source).toContain('const r2 = await bob.get((await parseJson(r1, NoteSchema)).id);');
    expect(source).toContain('expect((await parseJson(r2, ApiErrorSchema)).error.code).toBe("forbidden");');
    expect(astFindings('a.api.spec.ts', source, { requirementId: 'REQ-201', scenarioId: 'REQ-201-SC-03' })).toEqual([]);
  });

  test('combined tests sign in through the API and use example-app page objects', () => {
    const source = renderSpec(specOf('REQ-202', 1), 'run-1', { application: 'notes' });
    expect(source).toContain("import { notesTest as test, expect } from '../../src/fixtures/agent';");
    expect(source).toContain('await signInBrowser("alice");');
    expect(source).toContain('await notesPage.addNote(testPrefix + " From the UI", "Typed in the browser");');
    expect(source).toContain('.map((item) => item.title)).toContain(testPrefix + " From the UI");');
  });

  test('hostile strings stay inside string literals', () => {
    const hostile = 'x"); require("child_process").execSync("touch /tmp/pwned"); ("';
    const spec = withSteps(s1(), [call({ method: 'create', args: [{ kind: 'note', title: { kind: 'prefixed', suffix: hostile }, body: { kind: 'literal', value: hostile } }] }), { kind: 'expectStatus', response: 'r1', status: 201 }]);
    const source = renderSpec(spec, 'run-1', { application: 'notes' });
    expect(astFindings('a.api.spec.ts', source, { requirementId: spec.requirementId, scenarioId: spec.scenarioId })).toEqual([]);
  });

  test('the step-to-line map points at each rendered step', () => {
    const spec = specOf('REQ-202', 1);
    const { source, stepLines } = renderSpecWithMap(spec, 'run-1', { application: 'notes' });
    const lines = source.split('\n');
    expect(lines[stepLines[0] - 1]).toContain('signInBrowser("alice")');
    expect(lines[stepLines[3] - 1]).toContain('toBeVisible()');
    expect(lines[stepLines[4] - 1]).toContain('const r1 = await alice.list();');
  });
});

test.describe('AST rules for API code', () => {
  const trace = { requirementId: 'REQ-201', scenarioId: 'REQ-201-SC-01' };
  const good = () => renderSpec(specOf('REQ-201', 0), 'run-1', { application: 'notes' });
  const messages = (source: string) => astFindings('a.api.spec.ts', source, trace).map((f) => f.message);

  test('header lookups are the only element access allowed', () => {
    expect(messages(good())).toEqual([]);
    expect(messages(good().replace('r1.headers()["location"]', 'r1.headers()[name]'))).toContain('computed member access is not allowed');
  });

  test('raw request access through a client is rejected', () => {
    expect(messages(good().replace('expect(r1.status()).toBe(201);', 'await alice.request.post("https://evil.example");'))).toContain('".request" is not allowed in generated tests');
  });

  test('imports outside the framework modules are rejected', () => {
    expect(messages(good().replace("import { parseJson }", "import { startExampleApp } from '../../example-app/server';\nimport { parseJson }"))).toContain('import from "../../example-app/server" is not allowed');
  });
});

test.describe('generation workflow writes one file per family', () => {
  for (const [id, suffix] of [
    ['REQ-201', '.api.spec.ts'],
    ['REQ-202', '.notes.spec.ts'],
  ] as const) {
    test(`${id} specs become ${suffix} files that pass every static check`, async () => {
      const run = scratchRun(id);
      try {
        const ex = example(id);
        const provider = new MockProvider({ 'test-plan': [JSON.stringify(ex.plan)], 'test-generation': [JSON.stringify(GenerationOutputSchema.parse(ex.generation))] });
        const manifest = await planAndGenerate(ex.requirement, { repoRoot: REPO_ROOT, policy, provider, runId: run.runId, retryPolicy: NO_WAIT });
        expect(manifest.status).toBe('awaiting_approval');
        expect(manifest.artifacts.every((a) => a.file.endsWith(suffix) && a.state === 'awaiting_approval')).toBe(true);
        const source = readFileSync(path.join(REPO_ROOT, manifest.artifacts[0].file), 'utf8');
        expect(source.startsWith('// @agent-generated')).toBe(true);
      } finally {
        run.cleanup();
      }
    });
  }
});
