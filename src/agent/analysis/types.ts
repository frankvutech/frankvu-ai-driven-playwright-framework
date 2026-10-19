import { z } from 'zod';

/**
 * product_behavior: likely product defect. assertion_logic: test logic or
 * expectation defect. locator: locator drift. timeout_sync: timing or
 * synchronisation. test_data_setup / environment: data, setup or target
 * problems. api_contract: an API answered outside the expected contract
 * (status or schema). infrastructure: the runner or tooling failed.
 * inconclusive: insufficient evidence; never forced into a category.
 */
export const FAILURE_CATEGORIES = [
  'product_behavior',
  'assertion_logic',
  'locator',
  'test_data_setup',
  'environment',
  'timeout_sync',
  'api_contract',
  'infrastructure',
  'inconclusive',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** A fact taken verbatim (after redaction) from Playwright evidence. */
export interface Observation {
  id: string;
  source: string;
  text: string;
}

/** The hypothesis part of an analysis. This is also the model's output schema. */
export const DiagnosisSchema = z
  .object({
    category: z.enum(FAILURE_CATEGORIES),
    confidence: z.enum(['low', 'medium', 'high']),
    hypothesis: z.string().min(1).max(1500),
    alternatives: z
      .array(z.object({ category: z.enum(FAILURE_CATEGORIES), why: z.string().max(500) }).strict())
      .max(5),
    evidenceIds: z.array(z.string()).min(1).max(20),
    sufficientEvidence: z.boolean(),
    nextSteps: z.array(z.string().max(500)).min(1).max(5),
  })
  .strict();
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export interface FailureAnalysis {
  testId: string;
  title: string;
  scenarioId?: string;
  /** Facts. */
  observations: Observation[];
  /** Hypothesis, advisory only. */
  diagnosis: Diagnosis;
  method: 'rules' | 'model';
  notes: string[];
}
