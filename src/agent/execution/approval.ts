import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ArtifactRecord } from '../domain/state';
import { resolveInside, sha256File } from './files';

export const ApprovalSchema = z
  .object({
    runId: z.string(),
    decision: z.enum(['approved', 'rejected']),
    approver: z.string().min(1),
    decidedAt: z.string(),
    reason: z.string().max(2000).optional(),
    artifacts: z.array(z.object({ file: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()),
  })
  .strict();
export type Approval = z.infer<typeof ApprovalSchema>;

export const APPROVAL_FILE = 'approval.json';

/** Names that identify automation rather than a person. */
const NON_HUMAN = /^(test-agent|agent|ai|bot|ci|claude|llm|model|automation|github-actions)(\b|$)/i;

export function isAcceptableApprover(name: string): boolean {
  const n = name.trim();
  return n.length >= 2 && !NON_HUMAN.test(n) && !/\[bot\]$/i.test(n);
}

export function readApproval(runDir: string): Approval | undefined {
  const file = path.join(runDir, APPROVAL_FILE);
  if (!existsSync(file)) return undefined;
  return ApprovalSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * Write a human decision for the artifacts awaiting approval. Called only by
 * the interactive `approve`/`reject` CLI commands (and by tests acting as the
 * human); the workflow module never calls it.
 */
export function writeApproval(runDir: string, approval: Approval): void {
  const parsed = ApprovalSchema.parse(approval);
  if (!isAcceptableApprover(parsed.approver)) {
    throw new Error(`"${parsed.approver}" is not an acceptable human approver`);
  }
  writeFileSync(path.join(runDir, APPROVAL_FILE), JSON.stringify(parsed, null, 2) + '\n');
}

/**
 * Re-verify an approval against the files on disk right before execution.
 * Any change to an approved file after approval invalidates it.
 */
export function verifyApproval(
  approval: Approval | undefined,
  runId: string,
  artifacts: ArtifactRecord[],
  repoRoot: string,
  generationArea: string,
): string[] {
  if (!approval) return ['no approval record: a human must approve this run before execution'];
  const problems: string[] = [];
  if (approval.runId !== runId) problems.push(`approval is for run ${approval.runId}`);
  if (approval.decision !== 'approved') problems.push('the run was rejected by the reviewer');
  if (!isAcceptableApprover(approval.approver)) problems.push(`"${approval.approver}" is not an acceptable human approver`);

  const approvedFiles = new Map(approval.artifacts.map((a) => [a.file, a.sha256]));
  const toRun = artifacts.filter((a) => a.state === 'approved');
  if (toRun.length === 0) problems.push('no artifacts are in the approved state');
  for (const artifact of toRun) {
    const sha = approvedFiles.get(artifact.file);
    if (!sha) {
      problems.push(`${artifact.file} is not covered by the approval`);
      continue;
    }
    const resolved = resolveInside(repoRoot, generationArea, artifact.file);
    if (!resolved.ok) {
      problems.push(resolved.reason);
      continue;
    }
    const actual = sha256File(resolved.abs);
    if (actual !== sha || actual !== artifact.sha256) {
      problems.push(`${artifact.file} changed after approval (hash mismatch)`);
    }
  }
  return problems;
}
