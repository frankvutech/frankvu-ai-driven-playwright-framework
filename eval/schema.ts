import { z } from 'zod';
import { RequirementSchema } from '../src/agent/domain/requirement';
import { ScenarioSchema } from '../src/agent/domain/plan';
import { TestSpecSchema } from '../src/agent/domain/testSpec';

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
] as const;
export type AssertionWeakness = (typeof ASSERTION_WEAKNESSES)[number];

export const RequiredAssertionSchema = z
  .object({ target: z.string(), expected: z.union([z.string(), z.number(), z.array(z.string())]) })
  .strict();

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
        rejected: z.record(z.string(), z.array(z.string())).optional(),
        missingCapabilities: z.number().int().optional(),
        contentAssertion: z.boolean().optional(),
        note: z.string().optional(),
      })
      .strict(),
    requiredAssertions: z.record(z.string(), z.array(RequiredAssertionSchema)),
    assertionLabels: z.record(z.string(), z.object({ weaknesses: z.array(z.enum(ASSERTION_WEAKNESSES)) }).strict()),
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
    specs: z.array(TestSpecSchema).min(1),
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
      z.object({ id: z.string(), variants: z.array(z.enum(['problem', 'error'])), behavior: z.string(), verifiedBy: z.string() }).strict(),
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
    files: z.object({ planning: z.string(), generation: z.string(), functional: z.string(), failures: z.string() }).strict(),
    labelPolicy: z.string(),
    changelog: z.array(z.object({ version: z.string(), date: z.string(), changes: z.string() }).strict()),
  })
  .strict();

export type PlanningCase = z.infer<typeof PlanningCaseSchema>;
export type GenerationCase = z.infer<typeof GenerationCaseSchema>;
export type FunctionalSuite = z.infer<typeof FunctionalSuiteSchema>;
export type FunctionalDataset = z.infer<typeof FunctionalDatasetSchema>;
export type FailureCase = z.infer<typeof FailureCaseSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
