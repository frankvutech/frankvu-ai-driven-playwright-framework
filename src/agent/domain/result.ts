import { z } from 'zod';

/**
 * Versioned execution-evidence schema. It is derived from Playwright's own
 * JSON reporter output; nothing here is produced by a model.
 */
export const RESULT_SCHEMA_VERSION = 1;

export const AttachmentRefSchema = z.object({
  name: z.string(),
  contentType: z.string(),
  /** Repo-relative path. Only present when the file existed at collection time. */
  path: z.string(),
});

export const AttemptSchema = z.object({
  retry: z.number().int(),
  status: z.string(),
  durationMs: z.number(),
  errors: z.array(z.object({ message: z.string(), location: z.string().optional() })),
  attachments: z.array(AttachmentRefSchema),
});

export const TestEvidenceSchema = z.object({
  testId: z.string(),
  title: z.string(),
  file: z.string(),
  project: z.string(),
  requirementId: z.string().optional(),
  scenarioId: z.string().optional(),
  /**
   * passed: final attempt passed with no retries.
   * flaky: passed only after a retry (treated as inconclusive downstream).
   */
  status: z.enum(['passed', 'failed', 'timedOut', 'flaky', 'skipped', 'interrupted', 'unknown']),
  durationMs: z.number(),
  retries: z.number().int(),
  attempts: z.array(AttemptSchema),
  traceRef: z.string().optional(),
  screenshotRefs: z.array(z.string()),
});

export const RunEvidenceSchema = z.object({
  schemaVersion: z.literal(RESULT_SCHEMA_VERSION),
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  environment: z.object({
    targetName: z.string(),
    baseUrlHost: z.string(),
    /** Demo account variant used for the signed-in session (absent in older evidence). */
    sessionVariant: z.string().optional(),
    playwrightVersion: z.string(),
    node: z.string(),
    platform: z.string(),
    ci: z.boolean(),
  }),
  runner: z.object({
    exitCode: z.number().nullable(),
    timedOut: z.boolean(),
    reportFound: z.boolean(),
    /** Global errors Playwright reported outside any test (e.g. setup or config failures). */
    globalErrors: z.array(z.string()),
    stderrTail: z.string(),
  }),
  tests: z.array(TestEvidenceSchema),
});

export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;
export type TestEvidence = z.infer<typeof TestEvidenceSchema>;
export type RunEvidence = z.infer<typeof RunEvidenceSchema>;
