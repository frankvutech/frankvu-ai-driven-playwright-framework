import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { EXAMPLE_APP_VARIANTS } from '../../../example-app/server';

/**
 * Execution policy. agent.policy.json is protected configuration: it is
 * changed by people through code review, never by the agent.
 */
export const PolicySchema = z
  .object({
    version: z.literal(1),
    generationArea: z.string().regex(/^[a-z][a-z0-9-]*$/),
    runsArea: z.string().regex(/^\.?[a-z][a-z0-9-/]*$/),
    maxScenariosPerRun: z.number().int().min(1).max(50),
    approvedTargets: z
      .array(z.object({ name: z.string(), uiBaseUrl: z.string().url(), kind: z.literal('test') }).strict())
      .min(1),
    blockedHostPatterns: z.array(z.string().min(1)),
    execution: z
      .object({
        maxDurationMs: z.number().int().min(10_000).max(1_800_000),
        testTimeoutMs: z.number().int().min(1_000).max(300_000),
        retries: z.number().int().min(0).max(2),
        workers: z.number().int().min(1).max(8),
      })
      .strict(),
    envPassthrough: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)),
    /** Which demo account the signed-in session uses. "standard" is the default. */
    sessionVariants: z.record(
      z.string().regex(/^[a-z]+$/),
      z.object({ user: z.enum(['standard', 'problem', 'error']), purpose: z.string() }).strict(),
    ),
    /** HTTP APIs generated API tests may call (besides the example app). */
    apiTargets: z.array(z.object({ name: z.string(), baseUrl: z.string().url(), kind: z.literal('test') }).strict()),
    /** The local example app: deployed copies allowed besides the local one, and allowed failure-mode variants. */
    exampleApp: z
      .object({
        approvedUrls: z.array(z.string().url()),
        variants: z.array(z.enum(EXAMPLE_APP_VARIANTS)).min(1),
      })
      .strict(),
    /** Bounds for guarded healing (src/agent/healing). */
    healing: z
      .object({
        /** Runs of the failing test before any proposal, to confirm and measure the failure. */
        reproduceRuns: z.number().int().min(1).max(5),
        /** Runs of the patched test that must all pass. */
        verifyRuns: z.number().int().min(1).max(10),
        /** Largest wait a proposal may add (condition-based, never a sleep). */
        maxWaitTimeoutMs: z.number().int().min(1_000).max(15_000),
        maxChanges: z.number().int().min(1).max(3),
        /** Repo-relative directories whose files a locator repair may change. */
        patchableRoots: z.array(z.string().regex(/^src\/[a-z-/]+\/$/)).min(1),
      })
      .strict(),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;

export const POLICY_FILE = 'agent.policy.json';

export function loadPolicy(repoRoot: string): Policy {
  return PolicySchema.parse(JSON.parse(readFileSync(path.join(repoRoot, POLICY_FILE), 'utf8')));
}

/** Resolve an API base URL against the policy allowlist. */
export function resolveApiTarget(policy: Policy, baseUrl: string): { ok: true; name: string; host: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, reason: 'API base URL is not a valid URL' };
  }
  const blocked = policy.blockedHostPatterns.find((p) => url.host.toLowerCase().includes(p.toLowerCase()));
  if (blocked) return { ok: false, reason: `API host ${url.host} matches blocked pattern "${blocked}"` };
  const target = policy.apiTargets.find((t) => new URL(t.baseUrl).origin === url.origin);
  if (!target) return { ok: false, reason: `API target ${url.origin} is not an approved test target` };
  return { ok: true, name: target.name, host: url.host };
}

/** Resolve the configured UI target against the policy allowlist. */
export function resolveTarget(policy: Policy, uiBaseUrl: string): { ok: true; name: string; host: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(uiBaseUrl);
  } catch {
    return { ok: false, reason: `UI base URL is not a valid URL` };
  }
  const blocked = policy.blockedHostPatterns.find((p) => url.host.toLowerCase().includes(p.toLowerCase()));
  if (blocked) return { ok: false, reason: `target host ${url.host} matches blocked pattern "${blocked}"` };
  const target = policy.approvedTargets.find((t) => new URL(t.uiBaseUrl).origin === url.origin);
  if (!target) return { ok: false, reason: `target ${url.origin} is not an approved test target` };
  return { ok: true, name: target.name, host: url.host };
}
