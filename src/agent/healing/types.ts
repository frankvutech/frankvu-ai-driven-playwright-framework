import { z } from 'zod';
import { ArgSchema } from '../domain/testSpec';
import type { FailureAnalysis } from '../analysis/types';
import type { UsageRecord } from '../llm/structured';

/**
 * Outcome of one healing attempt. Only `verified_pending_review` can be
 * approved, and only by a named human. Nothing here applies, commits or
 * pushes a change: approval records a decision on a reviewable patch.
 */
export const HEAL_OUTCOMES = [
  'not_applicable',
  'insufficient_evidence',
  'proposal_failed',
  'proposal_generated',
  'validation_failed',
  'verification_failed',
  'verified_pending_review',
  'approved',
] as const;
export type HealOutcome = (typeof HEAL_OUTCOMES)[number];

/** What failed: a generated candidate test of a run, or a trusted (hand-written or promoted) test. */
export type HealTarget =
  | { kind: 'generated'; runId: string; scenarioId: string }
  | { kind: 'trusted'; file: string; title: string };

/** Locators a repair may propose. Each kind can be checked against the page snapshot. */
export const LOCATOR_ROLES = ['button', 'link', 'heading', 'textbox', 'checkbox', 'combobox', 'alert', 'listitem', 'form', 'paragraph'] as const;
export const LocatorSpecSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('role'), role: z.enum(LOCATOR_ROLES), name: z.string().min(1).max(200), exact: z.boolean() }).strict(),
  z.object({ by: z.literal('label'), text: z.string().min(1).max(200), exact: z.boolean() }).strict(),
  z.object({ by: z.literal('text'), text: z.string().min(1).max(200), exact: z.boolean() }).strict(),
]);
export type LocatorSpec = z.infer<typeof LocatorSpecSchema>;

export const HealChangeSchema = z.discriminatedUnion('kind', [
  /** Re-target one page-object locator that currently matches nothing. */
  z
    .object({
      kind: z.literal('replaceLocator'),
      pageObject: z.string().regex(/^[A-Z][A-Za-z]+$/),
      member: z.string().regex(/^[a-z][A-Za-z]+$/),
      locator: LocatorSpecSchema,
    })
    .strict(),
  /** Insert a condition-based wait (a visibility assertion with a bounded timeout) into a generated test. */
  z
    .object({
      kind: z.literal('addWait'),
      beforeStep: z.number().int().min(0),
      target: z.string().max(100),
      locatorArgs: z.array(ArgSchema).max(3).optional(),
      timeoutMs: z.number().int().min(1000).max(15_000),
    })
    .strict(),
]);
export type HealChange = z.infer<typeof HealChangeSchema>;

/** The model's output. It proposes; deterministic code validates, applies and verifies. */
export const HealProposalSchema = z
  .object({
    decision: z.enum(['propose', 'decline']),
    /** Why the test failed, citing evidence. */
    failureExplanation: z.string().min(1).max(2000),
    /** What the test is meant to check, and why the change keeps that intent. */
    intendedBehavior: z.string().min(1).max(1000),
    evidenceIds: z.array(z.string()).min(1).max(20),
    changes: z.array(HealChangeSchema).max(3),
  })
  .strict();
export type HealProposal = z.infer<typeof HealProposalSchema>;

export interface TestRunSummary {
  label: string;
  command: string[];
  runs: number;
  passed: number;
  failed: number;
  statuses: string[];
  reportFound: boolean;
  /** Tests that failed, by title (for regression runs). */
  failedTests: string[];
  durationMs: number;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HealRecord {
  healId: string;
  createdAt: string;
  target: HealTarget;
  /** Resolved files: the test that failed and the Playwright project it runs in. */
  testFile: string;
  project: string;
  environment: { exampleAppVariant: string; sessionVariant: string };
  reproduction?: TestRunSummary & { intermittent: boolean };
  analysis?: FailureAnalysis;
  gate?: { decision: 'locator_repair' | 'wait_repair' | 'stop'; reason: string };
  proposal?: HealProposal;
  usage: UsageRecord[];
  validation: Check[];
  verification?: TestRunSummary;
  regression?: { scope: string; before?: TestRunSummary; after?: TestRunSummary; newFailures: string[] };
  intent: Check[];
  patch?: { file: string; sha256: string; changedFiles: string[] };
  outcome: HealOutcome;
  history: Array<{ outcome: HealOutcome; at: string; reason: string }>;
  approval?: { approver: string; decidedAt: string; patchSha256: string };
}
