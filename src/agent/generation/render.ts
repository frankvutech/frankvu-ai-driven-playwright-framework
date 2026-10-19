import type { ApplicationId } from '../domain/application';
import type { ApiArg, ApiExpected, Arg, Step, TestSpec, Text } from '../domain/testSpec';
import { API_CATALOG, SCHEMA_EXPORTS, type SchemaName } from './apiCatalog';
import { splitTarget } from './catalog';

export const GENERATED_MARKER = '// @agent-generated';

/** Wrong password used by credential scenarios; never a real secret. */
export const WRONG_PASSWORD = 'wrong-password';

/**
 * Generated tests fall into three families, each with its own fixtures and
 * Playwright project, so a test only gets the capabilities it needs.
 */
export type Family = 'storefront' | 'notes' | 'api';

export function familyOf(app: ApplicationId, layer: TestSpec['layer']): Family {
  if (layer === 'api') return 'api';
  return app === 'notes' ? 'notes' : 'storefront';
}

export const FAMILY_SUFFIX: Record<Family, string> = {
  storefront: '.spec.ts',
  notes: '.notes.spec.ts',
  api: '.api.spec.ts',
};

/** Candidate files: generated/<runId>/. Promoted files: tests/<dir>/generated/. */
const CANDIDATE_IMPORT: Record<Family, { module: string; name: string }> = {
  storefront: { module: 'fixtures/agent', name: 'test' },
  notes: { module: 'fixtures/agent', name: 'notesTest' },
  api: { module: 'fixtures/agent', name: 'apiTest' },
};
const PROMOTED_IMPORT: Record<Family, { module: string; name: string }> = {
  storefront: { module: 'fixtures/test', name: 'test' },
  notes: { module: 'fixtures/integration', name: 'test' },
  api: { module: 'fixtures/api', name: 'test' },
};
export const PROMOTED_DIR: Record<Family, string> = {
  storefront: 'tests/ui/generated',
  notes: 'tests/integration/generated',
  api: 'tests/api/generated',
};

export interface RenderOptions {
  application?: ApplicationId;
  /** candidate (default): runs under the agent's guarded fixtures. promoted: trusted regression suite. */
  mode?: 'candidate' | 'promoted';
  /** Header lines for promoted files (who promoted it, from which run). */
  provenance?: string[];
}

export interface Rendered {
  source: string;
  family: Family;
  /** 1-based source line of each spec step (same order as spec.steps). */
  stepLines: number[];
}

/**
 * Deterministically render a validated spec to a Playwright test. Identifiers
 * come only from the catalogs (already checked); every model-supplied string
 * is emitted through JSON.stringify, so it cannot escape a string literal.
 */
export function renderSpec(spec: TestSpec, runId: string, options: RenderOptions = {}): string {
  return renderSpecWithMap(spec, runId, options).source;
}

export function renderSpecWithMap(input: TestSpec, runId: string, options: RenderOptions = {}): Rendered {
  const spec: TestSpec = { ...input, layer: input.layer ?? 'ui' };
  const app = options.application ?? 'storefront';
  const family = familyOf(app, spec.layer);
  const mode = options.mode ?? 'candidate';
  const root = mode === 'candidate' ? '../..' : '../../..';

  const fixtures: string[] = [];
  const use = (name: string) => {
    if (!fixtures.includes(name)) fixtures.push(name);
  };
  const imports = new Map<string, Set<string>>();
  const importFrom = (module: string, name: string) => {
    const set = imports.get(module) ?? new Set<string>();
    set.add(name);
    imports.set(module, set);
  };
  const declared = new Set<string>();
  const preamble: string[] = [];

  const text = (t: Text): string => {
    switch (t.kind) {
      case 'literal':
        return JSON.stringify(t.value);
      case 'prefixed':
        use('testPrefix');
        return t.suffix === '' ? 'testPrefix' : `testPrefix + ${JSON.stringify(` ${t.suffix}`)}`;
      case 'padded':
        use('testPrefix');
        return `(testPrefix + " ").padEnd(${t.length}, "x")`;
      case 'repeat':
        return `${JSON.stringify(t.char)}.repeat(${t.count})`;
    }
  };

  const arg = (a: Arg): string => {
    switch (a.kind) {
      case 'literal':
        return JSON.stringify(a.value);
      case 'data':
        importFrom(a.ref.startsWith('users.') ? 'data/users' : 'data/exampleApp', a.ref.split('.')[0]);
        return a.ref;
      case 'customer':
        importFrom('data/customers', 'defaultCustomer');
        return a.omit.length === 0
          ? 'defaultCustomer'
          : `{ ...defaultCustomer, ${a.omit.map((f) => `${f}: undefined`).join(', ')} }`;
      case 'prefixed':
        return text(a);
    }
  };

  const schemaExpr = (name: SchemaName): string => {
    const { symbol, list } = SCHEMA_EXPORTS[name];
    importFrom('api/schemas', symbol);
    return list ? `${symbol}.array()` : symbol;
  };
  const responseSchema = new Map<string, SchemaName | null>();
  const body = (response: string, schema: SchemaName): string => {
    importFrom('api/response', 'parseJson');
    return `(await parseJson(${response}, ${schemaExpr(schema)}))`;
  };
  const field = (subject: string, path: string): string => {
    if (path === 'length') return `${subject}.length`;
    if (path.startsWith('*.')) return `${subject}.map((item) => item.${path.slice(2)})`;
    return `${subject}.${path}`;
  };

  const apiArg = (a: ApiArg): string => {
    switch (a.kind) {
      case 'ref':
        return field(body(a.response, responseSchema.get(a.response)!), a.field);
      case 'literal':
        return JSON.stringify(a.value);
      case 'note': {
        const parts = [a.title && `title: ${text(a.title)}`, a.body && `body: ${text(a.body)}`].filter(Boolean);
        return `{ ${parts.join(', ')} }`;
      }
      case 'post': {
        const parts = (['id', 'userId', 'title', 'body'] as const).filter((k) => a[k] !== null).map((k) => `${k}: ${JSON.stringify(a[k])}`);
        return `{ ${parts.join(', ')} }`;
      }
      case 'query':
        return a.userId === null ? '{}' : `{ userId: ${a.userId} }`;
      case 'credentials':
        importFrom('data/exampleApp', 'exampleAppUsers');
        return a.password === 'valid'
          ? `exampleAppUsers.${a.user}`
          : `{ username: exampleAppUsers.${a.user}.username, password: ${JSON.stringify(WRONG_PASSWORD)} }`;
    }
  };

  const client = (step: Extract<Step, { kind: 'apiCall' }>): string => {
    if (step.client === 'posts') {
      use('postsApi');
      return 'postsApi';
    }
    use('exampleAppApi');
    const name = step.as!;
    if (!declared.has(name)) {
      declared.add(name);
      preamble.push(
        name === 'anonymous' ? `const anonymous = await exampleAppApi.asAnonymous();` : `const ${name} = await exampleAppApi.as(${JSON.stringify(name)});`,
      );
    }
    return name;
  };

  const expected = (e: ApiExpected): string => {
    switch (e.kind) {
      case 'literal':
        return JSON.stringify(e.value);
      case 'ref':
        return field(body(e.response, responseSchema.get(e.response)!), e.field);
      case 'text':
        return text(e.text);
    }
  };

  const lines = (step: Step): string[] => {
    switch (step.kind) {
      case 'expectUrl':
        use('page');
        return [`await expect(page)${step.negate ? '.not' : ''}.toHaveURL(new RegExp(${JSON.stringify(step.pathPattern)}));`];
      case 'signIn':
        use('signInBrowser');
        return [`await signInBrowser(${JSON.stringify(step.as)});`];
      case 'apiCall': {
        responseSchema.set(step.saveAs, API_CATALOG[step.client].methods[step.method].returns);
        if (step.client === 'auth') {
          use('exampleAppApi');
          importFrom('api/NotesClient', 'requestToken');
          return [`const ${step.saveAs} = await requestToken(await exampleAppApi.anonymous(), ${apiArg(step.args[0])});`];
        }
        const target = client(step);
        const call = `const ${step.saveAs} = await ${target}.${step.method}(${step.args.map(apiArg).join(', ')});`;
        const before = preamble.splice(0);
        return [...before, call];
      }
      case 'expectStatus':
        return [`expect(${step.response}.status()).toBe(${step.status});`];
      case 'expectHeader':
        return [`expect(${step.response}.headers()[${JSON.stringify(step.header)}]).${step.matcher}(${JSON.stringify(step.expected)});`];
      case 'expectBody': {
        if (step.field === null) {
          importFrom('api/response', 'parseJson');
          return [`await parseJson(${step.response}, ${schemaExpr(step.schema)});`];
        }
        return [`expect(${field(body(step.response, step.schema), step.field)})${step.negate ? '.not' : ''}.${step.matcher}(${expected(step.expected!)});`];
      }
      case 'action': {
        const { fixture, member } = splitTarget(step.target)!;
        use(fixture);
        return [`await ${fixture}.${member}(${step.args.map(arg).join(', ')});`];
      }
      case 'expect': {
        const { fixture, member } = splitTarget(step.target)!;
        use(fixture);
        const subject = step.locatorArgs ? `${fixture}.${member}(${step.locatorArgs.map(arg).join(', ')})` : `${fixture}.${member}`;
        const select = step.select === 'first' ? '.first()' : step.select === 'last' ? '.last()' : '';
        const args = [step.expected === null ? undefined : JSON.stringify(step.expected), step.timeoutMs ? `{ timeout: ${step.timeoutMs} }` : undefined].filter(
          (a): a is string => a !== undefined,
        );
        return [`await expect(${subject}${select})${step.negate ? '.not' : ''}.${step.matcher}(${args.join(', ')});`];
      }
    }
  };

  const bodyLines: string[] = [];
  const stepOffsets: number[] = [];
  for (const step of spec.steps) {
    const out = lines(step);
    // The step's own line is the last one (client declarations come first).
    stepOffsets.push(bodyLines.length + out.length - 1);
    bodyLines.push(...out.map((l) => `    ${l}`));
  }

  const fixtureImport = (mode === 'candidate' ? CANDIDATE_IMPORT : PROMOTED_IMPORT)[family];
  const importLines = [
    fixtureImport.name === 'test'
      ? `import { test, expect } from '${root}/src/${fixtureImport.module}';`
      : `import { ${fixtureImport.name} as test, expect } from '${root}/src/${fixtureImport.module}';`,
  ];
  if (family === 'storefront' && !spec.startSignedIn) importLines.push(`import { SIGNED_OUT } from '${root}/src/config/auth';`);
  for (const [module, names] of [...imports.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    importLines.push(`import { ${[...names].sort().join(', ')} } from '${root}/src/${module}';`);
  }

  const annotations = [
    ['requirement', spec.requirementId],
    ['scenario', spec.scenarioId],
    ['agent-run', runId],
  ]
    .map(([type, description]) => `{ type: ${JSON.stringify(type)}, description: ${JSON.stringify(description)} }`)
    .join(',\n      ');

  const header =
    mode === 'candidate'
      ? [GENERATED_MARKER, '// Candidate test proposed by the AI Test Agent. Not reviewed.', `// Requirement ${spec.requirementId} / scenario ${spec.scenarioId} / run ${runId}`]
      : [GENERATED_MARKER, ...(options.provenance ?? []).map((l) => `// ${l}`)];

  const signedOut = family === 'storefront' && !spec.startSignedIn ? 'test.use({ storageState: SIGNED_OUT });\n\n' : '';
  const head = `${header.join('\n')}
${importLines.join('\n')}

${signedOut}test(
  ${JSON.stringify(spec.title)},
  {
    tag: '@generated',
    annotation: [
      ${annotations},
    ],
  },
  async ({ ${fixtures.join(', ')} }) => {
`;
  const firstBodyLine = head.split('\n').length;
  const source = `${head}${bodyLines.join('\n')}
  },
);
`;
  return { source, family, stepLines: stepOffsets.map((o) => firstBodyLine + o) };
}
