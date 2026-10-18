import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Execution policy. relynx.policy.json is protected configuration: it is
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
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;

export const POLICY_FILE = 'relynx.policy.json';

export function loadPolicy(repoRoot: string): Policy {
  return PolicySchema.parse(JSON.parse(readFileSync(path.join(repoRoot, POLICY_FILE), 'utf8')));
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
