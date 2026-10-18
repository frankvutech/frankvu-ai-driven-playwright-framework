import { z } from 'zod';

/**
 * The model never writes TypeScript. It returns this declarative spec, which
 * is checked against the page-object catalog and rendered by deterministic
 * code (see generation/render.ts). Every model-supplied string ends up inside
 * a JSON-escaped string literal.
 */
export const DATA_REFS = [
  'users.standard.username',
  'users.standard.password',
  'users.lockedOut.username',
  'users.lockedOut.password',
] as const;

export const CUSTOMER_FIELDS = ['firstName', 'lastName', 'postalCode'] as const;

export const ArgSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string().max(200) }).strict(),
  z.object({ kind: z.literal('data'), ref: z.enum(DATA_REFS) }).strict(),
  z
    .object({
      kind: z.literal('customer'),
      omit: z.array(z.enum(CUSTOMER_FIELDS)).max(3),
    })
    .strict(),
]);

export const MATCHERS = ['toHaveText', 'toContainText', 'toBeVisible', 'toBeHidden', 'toHaveCount', 'toHaveValue'] as const;

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
      select: z.enum(['all', 'first', 'last']),
      matcher: z.enum(MATCHERS),
      expected: z.union([z.string().max(500), z.number().int().min(0).max(1000), z.array(z.string().max(500)).max(50)]).nullable(),
      negate: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('expectUrl'),
      pathPattern: z.string().min(1).max(100),
      negate: z.boolean(),
    })
    .strict(),
]);

export const TestSpecSchema = z
  .object({
    scenarioId: z.string(),
    requirementId: z.string(),
    title: z.string().min(1).max(200),
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

export type Arg = z.infer<typeof ArgSchema>;
export type Step = z.infer<typeof StepSchema>;
export type TestSpec = z.infer<typeof TestSpecSchema>;
export type GenerationOutput = z.infer<typeof GenerationOutputSchema>;
