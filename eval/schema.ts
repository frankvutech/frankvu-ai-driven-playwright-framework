import { z } from 'zod';
import { RequirementSchema } from '../src/agent/domain/requirement';
import { ScenarioSchema } from '../src/agent/domain/plan';
import { TestSpecSchema, type TestSpec } from '../src/agent/domain/testSpec';
import { LAYERS } from '../src/agent/domain/application';
import { EXAMPLE_APP_VARIANTS } from '../example-app/server';
import { HealChangeSchema, HEAL_OUTCOMES } from '../src/agent/healing/types';

/**
 * Validates a recorded spec without transforming it. Pinned specs are hashed
 * as written, so schema defaults added later (e.g. layer) must not be applied.
 */
const RecordedSpecSchema = z.custom<TestSpec>((v) => TestSpecSchema.safeParse(v).success, { message: 'not a valid TestSpec' });

/* ------------------------------ provenance ------------------------------ */

export const ReviewSchema = z
  .object({
    status: z.enum(['pending', 'human-reviewed']),
    reviewer: z.string().min(2).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    notes: z.string().optional(),
  })
  .strict()
  .refine((r) => r.status === 'pending' || (r.reviewer && r.date), { message: 'human-reviewed labels need reviewer and date' });

export const ProvenanceSchema = z
  .object({
    /** constructed: the case was built to have this outcome. observed-controlled-variation: verified by an independent probe. author-judgment: an opinion. */
    method: z.enum(['constructed', 'observed-controlled-variation', 'author-judgment']),
    author: z.string().min(1),
    review: ReviewSchema,
    notes: z.string().optional(),
  })
  .strict();

const CLARIFICATION = z.enum(['none', 'ask-before-planning', 'surface-ambiguity', 'declare-uncovered']);

/* ------------------------------- planning ------------------------------- */

export const PlanningCaseSchema = z
  .object({
    id: z.string().regex(/^PL-\d{2}$/),
    requirementId: z.string().nullable(),
    category: z.string(),
    dimensions: z.array(z.string()).min(1),
    requirement: z.unknown(),
    recordedOutput: z.unknown(),
    notes: z.string().optional(),
    /** Whether the case also makes sense with a live model (its expectations concern the requirement, not the recorded output). */
    liveApplicable: z.boolean(),
    expected: z
      .object({
        outcome: z.enum(['invalid_requirement', 'needs_clarification', 'plan_failed', 'plan_rejected', 'plan_valid']),
        failureKind: z.string().optional(),
        coverage: z.number().min(0).max(1).optional(),
        requiredCoverage: z.number().min(0).max(1).optional(),
        scenarioTypes: z.array(z.enum(['positive', 'negative', 'boundary', 'authorization'])).optional(),
        issueCodes: z.array(z.string()).optional(),
        absentIssueCodes: z.array(z.string()).optional(),
        requirementIssueCodes: z.array(z.string()).optional(),
        flagsAmbiguity: z.boolean().optional(),
        unsupportedAssumption: z.boolean().optional(),
        assumptionScenarios: z.array(z.string()).optional(),
        modelCalls: z.number().int().optional(),
        prohibitedAssumptions: z.array(z.string().min(3)).optional(),
        /** Layers the plan must contain (ui/api/combined). */
        layers: z.array(z.enum(LAYERS)).optional(),
        expectedClarification: CLARIFICATION,
        mustDeclareUncovered: z.array(z.string()).optional(),
      })
      .strict(),
    labels: ProvenanceSchema,
  })
  .strict();

/* ------------------------------ generation ------------------------------ */

export const ASSERTION_WEAKNESSES = [
  'AQ_MISSING',
  'AQ_NAV_ONLY',
  'AQ_VISIBILITY_ONLY',
  'AQ_NEGATIVE_ONLY',
  'AQ_UNTRACED',
  'AQ_WEAK_PARTIAL',
  'AQ_CONTRADICTORY',
  'AQ_REDUNDANT',
  'AQ_UNSTABLE_URL',
  // API assertion rules (Phase 3 v3)
  'AQ_API_NO_STATUS',
  'AQ_API_ERROR_CODE_MISSING',
  'AQ_API_STATUS_NOT_IN_CRITERIA',
  'AQ_API_BODY_UNCHECKED',
] as const;
export type AssertionWeakness = (typeof ASSERTION_WEAKNESSES)[number];

/**
 * A reference assertion a correct test must contain. UI: a positive expect on
 * a target with this exact value. API: a status on the response of a call, or
 * a body field with this exact literal value.
 */
export const RequiredAssertionSchema = z.union([
  z.object({ target: z.string(), expected: z.union([z.string(), z.number(), z.array(z.string())]) }).strict(),
  z.object({ kind: z.literal('status'), call: z.string().regex(/^(notes|auth|posts)\.[a-z]+$/), status: z.number().int() }).strict(),
  z.object({ kind: z.literal('body'), call: z.string().regex(/^(notes|auth|posts)\.[a-z]+$/), field: z.string(), expected: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
]);
export type RequiredAssertion = z.infer<typeof RequiredAssertionSchema>;

export const GenerationCaseSchema = z
  .object({
    id: z.string().regex(/^GE-\d{2}$/),
    requirementId: z.string(),
    category: z.string(),
    description: z.string().optional(),
    dimensions: z.array(z.string()).min(1),
    requirement: RequirementSchema,
    scenarios: z.array(ScenarioSchema),
    recordedOutput: z.unknown(),
    expected: z
      .object({
        failureKind: z.string().optional(),
        accepted: z.array(z.string()).optional(),
        /** Total accepted specs (catches duplicates for one scenario). */
        acceptedCount: z.number().int().optional(),
        rejected: z.record(z.string(), z.array(z.string())).optional(),
        missingCapabilities: z.number().int().optional(),
        contentAssertion: z.boolean().optional(),
        note: z.string().optional(),
      })
      .strict(),
    requiredAssertions: z.record(z.string(), z.array(RequiredAssertionSchema)),
    assertionLabels: z.record(z.string(), z.object({ weaknesses: z.array(z.enum(ASSERTION_WEAKNESSES)) }).strict()),
    /**
     * Reference judgement of each spec's intent: does it test the scenario's
     * behaviour as the criteria state it? Independent of whether it compiles or passes.
     */
    intentLabels: z.record(z.string(), z.enum(['correct', 'incorrect'])).optional(),
    labels: ProvenanceSchema,
  })
  .strict();

/* ------------------------------ functional ------------------------------ */

export const FunctionalCaseSchema = z
  .object({
    scenarioId: z.string(),
    relevantDefect: z.boolean(),
    defectId: z.string().nullable(),
    expectedTestOutcome: z.enum(['pass', 'fail']),
  })
  .strict()
  .refine((c) => (c.relevantDefect ? c.expectedTestOutcome === 'fail' && c.defectId : c.expectedTestOutcome === 'pass' && !c.defectId), {
    message: 'relevantDefect, defectId and expectedTestOutcome must agree',
  });

export const FunctionalSuiteSchema = z
  .object({
    id: z.string().regex(/^FS-[A-Z]+$/),
    requirement: RequirementSchema,
    scenarios: z.array(ScenarioSchema).min(1),
    specs: z.array(RecordedSpecSchema).min(1),
    specSha256: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
    variants: z.record(z.string(), z.array(FunctionalCaseSchema)),
    notes: z.string().optional(),
    labels: ProvenanceSchema,
  })
  .strict();

export const FunctionalDatasetSchema = z
  .object({
    provenance: z.string(),
    target: z.object({ name: z.string(), version: z.string() }).strict(),
    defects: z.array(
      z.object({ id: z.string(), variants: z.array(z.enum(['problem', 'error', ...EXAMPLE_APP_VARIANTS])), behavior: z.string(), verifiedBy: z.string() }).strict(),
    ),
    suites: z.array(FunctionalSuiteSchema).min(1),
  })
  .strict();

/* ------------------------------- failures ------------------------------- */

export const FAILURE_LABELS = [
  'product_regression',
  'incorrect_assertion',
  'locator',
  'auth_setup',
  'test_data',
  'environment',
  'timeout',
  'flaky',
  'insufficient_evidence',
] as const;
export type FailureLabel = (typeof FAILURE_LABELS)[number];

export const FailureCaseSchema = z
  .object({
    id: z.string().regex(/^[FP]-\d{2}$/),
    report: z.string(),
    title: z.string(),
    expectedStatus: z.enum(['passed', 'failed', 'timedOut', 'flaky', 'skipped']),
    expectedScenarioId: z.string().nullable(),
    label: z.enum(FAILURE_LABELS).nullable(),
    evidenceSufficient: z.boolean().nullable().optional(),
    acceptanceCriteria: z.string(),
    rationale: z.string(),
    provenance: ProvenanceSchema,
  })
  .strict();

export const FailureDatasetSchema = z
  .object({ provenance: z.string(), categories: z.array(z.enum(FAILURE_LABELS)), cases: z.array(FailureCaseSchema) })
  .strict();

export const ManifestSchema = z
  .object({
    datasetVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string(),
    files: z.object({ planning: z.string(), generation: z.string(), functional: z.string(), failures: z.string(), healing: z.string() }).strict(),
    labelPolicy: z.string(),
    changelog: z.array(z.object({ version: z.string(), date: z.string(), changes: z.string() }).strict()),
  })
  .strict();

/* -------------------------------- healing -------------------------------- */

/**
 * One healing scenario: a failing test in a controlled failure mode, the
 * proposal the (recorded) model returns, and the reference outcome. The
 * reference states what a correct pipeline must do, independent of the agent.
 */
export const HealingCaseSchema = z
  .object({
    id: z.string().regex(/^HE-\d{2}$/),
    description: z.string(),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('trusted'), file: z.string(), title: z.string() }).strict(),
      /** A generated test: a functional suite's pinned spec, executed and failed first. */
      z.object({ kind: z.literal('generated'), suite: z.string(), scenarioId: z.string() }).strict(),
    ]),
    variant: z.enum(EXAMPLE_APP_VARIANTS),
    /** What the recorded model returns: a proposal object, a raw string (malformed output), or a provider error kind. */
    recorded: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('proposal'), proposal: z.unknown() }).strict(),
      z.object({ kind: z.literal('raw'), text: z.string() }).strict(),
      z.object({ kind: z.literal('provider-error'), error: z.enum(['timeout', 'rate_limit', 'server', 'auth']) }).strict(),
      z.object({ kind: z.literal('none') }).strict(),
    ]),
    reproduceRuns: z.number().int().min(1).max(5),
    verifyRuns: z.number().int().min(1).max(10),
    reference: z
      .object({
        /** The cause established when the case was constructed. */
        cause: z.enum(['locator-drift', 'timing', 'product-defect', 'no-failure']),
        /** Should a correct pipeline produce a verified patch here? */
        repairExpected: z.boolean(),
        /** Is the recorded proposal itself a correct repair (null when there is none)? */
        proposalCorrect: z.boolean().nullable(),
        expectedOutcome: z.enum(HEAL_OUTCOMES),
        /** The correct repair, when one exists. */
        correctFix: z.array(HealChangeSchema).optional(),
      })
      .strict(),
    labels: ProvenanceSchema,
  })
  .strict();

export const HealingDatasetSchema = z.object({ provenance: z.string(), cases: z.array(HealingCaseSchema).min(1) }).strict();

export type HealingCase = z.infer<typeof HealingCaseSchema>;
export type PlanningCase = z.infer<typeof PlanningCaseSchema>;
export type GenerationCase = z.infer<typeof GenerationCaseSchema>;
export type FunctionalSuite = z.infer<typeof FunctionalSuiteSchema>;
export type FunctionalDataset = z.infer<typeof FunctionalDatasetSchema>;
export type FailureCase = z.infer<typeof FailureCaseSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
