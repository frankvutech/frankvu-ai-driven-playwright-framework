import { z } from 'zod';
import { LAYERS } from './application';
import { SCHEMA_NAMES } from '../generation/apiCatalog';

/**
 * The model never writes TypeScript. It returns this declarative spec, which
 * is checked against the page-object and API catalogs and rendered by
 * deterministic code (see generation/render.ts). Every model-supplied string
 * ends up inside a JSON-escaped string literal.
 */
export const DATA_REFS = [
  'users.standard.username',
  'users.standard.password',
  'users.lockedOut.username',
  'users.lockedOut.password',
  'exampleAppUsers.alice.username',
  'exampleAppUsers.alice.password',
  'exampleAppUsers.bob.username',
  'exampleAppUsers.bob.password',
] as const;

export const CUSTOMER_FIELDS = ['firstName', 'lastName', 'postalCode'] as const;
export const EXAMPLE_USERS = ['alice', 'bob'] as const;

/**
 * Text for example-app titles. "prefixed" starts with the test's unique
 * prefix, so the note is isolated and cleaned up; "padded" is the prefix
 * padded with "x" to an exact length (boundary tests).
 */
export const TextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string().max(1100) }).strict(),
  z.object({ kind: z.literal('prefixed'), suffix: z.string().max(80) }).strict(),
  z.object({ kind: z.literal('padded'), length: z.number().int().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('repeat'), char: z.string().length(1), count: z.number().int().min(0).max(1100) }).strict(),
]);

export const ArgSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string().max(200) }).strict(),
  z.object({ kind: z.literal('data'), ref: z.enum(DATA_REFS) }).strict(),
  z
    .object({
      kind: z.literal('customer'),
      omit: z.array(z.enum(CUSTOMER_FIELDS)).max(3),
    })
    .strict(),
  z.object({ kind: z.literal('prefixed'), suffix: z.string().max(80) }).strict(),
]);

export const MATCHERS = ['toHaveText', 'toContainText', 'toBeVisible', 'toBeHidden', 'toHaveCount', 'toHaveValue'] as const;

const RESPONSE_NAME = z.string().regex(/^r[1-9][0-9]?$/, 'response names are r1, r2, ...');

/** Arguments of API client calls. Which kinds fit which parameter is checked in validateSpec. */
export const ApiArgSchema = z.discriminatedUnion('kind', [
  /** A field of an earlier response, e.g. the id of a created note. */
  z.object({ kind: z.literal('ref'), response: RESPONSE_NAME, field: z.enum(['id']) }).strict(),
  z.object({ kind: z.literal('literal'), value: z.union([z.string().max(100), z.number().int()]) }).strict(),
  z.object({ kind: z.literal('note'), title: TextSchema.nullable(), body: TextSchema.nullable() }).strict(),
  z
    .object({
      kind: z.literal('post'),
      id: z.number().int().nullable(),
      userId: z.number().int().nullable(),
      title: z.string().max(500).nullable(),
      body: z.string().max(2000).nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('query'), userId: z.number().int().nullable() }).strict(),
  /** Example-app credentials from test data; "wrong" substitutes a fixed wrong password. */
  z.object({ kind: z.literal('credentials'), user: z.enum(EXAMPLE_USERS), password: z.enum(['valid', 'wrong']) }).strict(),
]);

/** Expected value of an API body assertion. */
export const ApiExpectedSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.union([z.string().max(500), z.number(), z.boolean()]) }).strict(),
  /** Same field of an earlier response: identity and consistency checks, never observed values. */
  z.object({ kind: z.literal('ref'), response: RESPONSE_NAME, field: z.enum(['id', 'title', 'body', 'owner']) }).strict(),
  z.object({ kind: z.literal('text'), text: TextSchema }).strict(),
]);

export const StepSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('action'),
      target: z.string().max(100),
      args: z.array(ArgSchema).max(5),
    })
    .strict(),
  z
    .object({
      kind: z.literal('expect'),
      target: z.string().max(100),
      /** Arguments when the target is a locator method, e.g. notesPage.note(title). */
      locatorArgs: z.array(ArgSchema).max(3).optional(),
      select: z.enum(['all', 'first', 'last']),
      matcher: z.enum(MATCHERS),
      expected: z.union([z.string().max(500), z.number().int().min(0).max(1000), z.array(z.string().max(500)).max(50)]).nullable(),
      negate: z.boolean(),
      /** Condition-based wait budget for this assertion (bounded). Omit for the default. */
      timeoutMs: z.number().int().min(1000).max(15_000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('expectUrl'),
      pathPattern: z.string().min(1).max(100),
      negate: z.boolean(),
    })
    .strict(),
  /** Example app: sign the browser in through the login endpoint (no UI steps). */
  z.object({ kind: z.literal('signIn'), as: z.enum(EXAMPLE_USERS) }).strict(),
  z
    .object({
      kind: z.literal('apiCall'),
      saveAs: RESPONSE_NAME,
      client: z.enum(['notes', 'posts', 'auth']),
      as: z.enum(['alice', 'bob', 'anonymous']).nullable(),
      method: z.string().max(40),
      args: z.array(ApiArgSchema).max(3),
    })
    .strict(),
  z.object({ kind: z.literal('expectStatus'), response: RESPONSE_NAME, status: z.number().int().min(100).max(599) }).strict(),
  z
    .object({
      kind: z.literal('expectHeader'),
      response: RESPONSE_NAME,
      header: z.string().regex(/^[a-z0-9-]{1,60}$/, 'header names are lower-case'),
      matcher: z.enum(['toBe', 'toContain']),
      expected: z.string().max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('expectBody'),
      response: RESPONSE_NAME,
      schema: z.enum(SCHEMA_NAMES),
      /** null: only validate the body against the schema. */
      field: z.string().max(40).nullable(),
      matcher: z.enum(['toBe', 'toContain']).nullable(),
      expected: ApiExpectedSchema.nullable(),
      negate: z.boolean(),
    })
    .strict(),
]);

export const TestSpecSchema = z
  .object({
    scenarioId: z.string(),
    requirementId: z.string(),
    title: z.string().min(1).max(200),
    /** Must match the scenario's layer. Defaults to ui for older specs. */
    layer: z.enum(LAYERS).default('ui'),
    /** Storefront only: start with a signed-in standard user. */
    startSignedIn: z.boolean(),
    steps: z.array(StepSchema).min(1).max(30),
  })
  .strict();

export const GenerationOutputSchema = z
  .object({
    tests: z.array(TestSpecSchema).max(20),
    missingCapabilities: z
      .array(
        z
          .object({
            scenarioId: z.string(),
            description: z.string().max(1000),
            proposedObject: z.string().max(200),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export type Text = z.infer<typeof TextSchema>;
export type Arg = z.infer<typeof ArgSchema>;
export type ApiArg = z.infer<typeof ApiArgSchema>;
export type ApiExpected = z.infer<typeof ApiExpectedSchema>;
export type Step = z.infer<typeof StepSchema>;
export type TestSpec = z.infer<typeof TestSpecSchema>;
export type GenerationOutput = z.infer<typeof GenerationOutputSchema>;

/** Assertion steps: the parts of a test that a repair must never remove or change. */
export const ASSERTION_KINDS = ['expect', 'expectUrl', 'expectStatus', 'expectHeader', 'expectBody'] as const;
export const isAssertion = (s: Step): boolean => (ASSERTION_KINDS as readonly string[]).includes(s.kind);
