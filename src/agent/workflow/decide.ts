import path from 'node:path';
import { transition } from '../domain/state';
import { isAcceptableApprover, writeApproval } from '../execution/approval';
import { sha256File } from '../execution/files';
import type { RunManifest, RunStore } from './store';
import { writeReport } from './report';

/**
 * Record a human reviewer's decision on every artifact awaiting approval.
 * Entry points: the interactive `approve` / `reject` CLI commands. The
 * generation and execution workflows never call this.
 */
export function recordDecision(
  store: RunStore,
  decision: 'approved' | 'rejected',
  approver: string,
  reason: string | undefined,
  now = new Date(),
): RunManifest {
  const manifest = store.manifest();
  if (manifest.status !== 'awaiting_approval') {
    throw new Error(`run ${manifest.runId} is ${manifest.status}, not awaiting approval`);
  }
  if (!isAcceptableApprover(approver)) throw new Error(`"${approver}" is not an acceptable human approver`);

  const pending = manifest.artifacts.filter((a) => a.state === 'awaiting_approval');
  for (const a of pending) {
    if (sha256File(path.join(store.repoRoot, a.file)) !== a.sha256) {
      throw new Error(`${a.file} changed after validation; regenerate the run instead of approving it`);
    }
  }

  writeApproval(store.runDir, {
    runId: manifest.runId,
    decision,
    approver,
    decidedAt: now.toISOString(),
    reason,
    artifacts: pending.map((a) => ({ file: a.file, sha256: a.sha256 })),
  });

  const actor = { kind: 'human' as const, name: approver };
  manifest.artifacts = manifest.artifacts.map((a) =>
    a.state === 'awaiting_approval' ? transition(a, decision, actor, reason ?? `${decision} by reviewer`, now) : a,
  );
  manifest.status = decision === 'approved' ? 'approved_for_execution' : 'rejected_by_reviewer';
  manifest.steps.push({ step: 'human-decision', status: 'ok', at: now.toISOString(), detail: `${decision} by ${approver}` });
  store.write('manifest.json', manifest);
  writeReport(store);
  return manifest;
}
