import type { Arg, Step, TestSpec } from '../domain/testSpec';
import { splitTarget } from './catalog';

/** Generated files live two levels below the repo root: generated/<runId>/. */
const ROOT = '../..';

export const GENERATED_MARKER = '// @relynx-generated';

/**
 * Deterministically render a validated spec to a Playwright test. Identifiers
 * come only from the catalog (already checked); every model-supplied string
 * is emitted through JSON.stringify, so it cannot escape a string literal.
 */
export function renderSpec(spec: TestSpec, runId: string): string {
  const fixtures: string[] = [];
  const use = (name: string) => {
    if (!fixtures.includes(name)) fixtures.push(name);
  };
  let usesUsers = false;
  let usesCustomer = false;

  const arg = (a: Arg): string => {
    switch (a.kind) {
      case 'literal':
        return JSON.stringify(a.value);
      case 'data':
        usesUsers = true;
        return a.ref;
      case 'customer':
        usesCustomer = true;
        return a.omit.length === 0
          ? 'defaultCustomer'
          : `{ ...defaultCustomer, ${a.omit.map((f) => `${f}: undefined`).join(', ')} }`;
    }
  };

  const line = (step: Step): string => {
    if (step.kind === 'expectUrl') {
      use('page');
      return `await expect(page)${step.negate ? '.not' : ''}.toHaveURL(new RegExp(${JSON.stringify(step.pathPattern)}));`;
    }
    const { fixture, member } = splitTarget(step.target)!;
    use(fixture);
    if (step.kind === 'action') {
      return `await ${fixture}.${member}(${step.args.map(arg).join(', ')});`;
    }
    const select = step.select === 'first' ? '.first()' : step.select === 'last' ? '.last()' : '';
    const expected = step.expected === null ? '' : JSON.stringify(step.expected);
    return `await expect(${fixture}.${member}${select})${step.negate ? '.not' : ''}.${step.matcher}(${expected});`;
  };

  const body = spec.steps.map((s) => `    ${line(s)}`).join('\n');

  const imports = [`import { test, expect } from '${ROOT}/src/fixtures/agent';`];
  if (!spec.startSignedIn) imports.push(`import { SIGNED_OUT } from '${ROOT}/src/config/auth';`);
  if (usesUsers) imports.push(`import { users } from '${ROOT}/src/data/users';`);
  if (usesCustomer) imports.push(`import { defaultCustomer } from '${ROOT}/src/data/customers';`);

  const annotations = [
    ['requirement', spec.requirementId],
    ['scenario', spec.scenarioId],
    ['relynx-run', runId],
  ]
    .map(([type, description]) => `{ type: ${JSON.stringify(type)}, description: ${JSON.stringify(description)} }`)
    .join(',\n      ');

  return `${GENERATED_MARKER}
// Candidate test proposed by the Relynx AI Test Agent. Not reviewed.
// Requirement ${spec.requirementId} / scenario ${spec.scenarioId} / run ${runId}
${imports.join('\n')}

${spec.startSignedIn ? '' : 'test.use({ storageState: SIGNED_OUT });\n\n'}test(
  ${JSON.stringify(spec.title)},
  {
    tag: '@generated',
    annotation: [
      ${annotations},
    ],
  },
  async ({ ${fixtures.join(', ')} }) => {
${body}
  },
);
`;
}
