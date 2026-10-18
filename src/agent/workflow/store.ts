import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactRecord } from '../domain/state';

/** Status of a whole run. Per-artifact states live in ArtifactRecord. */
export type RunStatus =
  | 'invalid_requirement'
  | 'needs_clarification'
  | 'plan_failed'
  | 'plan_rejected'
  | 'generation_failed'
  | 'nothing_to_execute'
  | 'awaiting_approval'
  | 'approved_for_execution'
  | 'rejected_by_reviewer'
  | 'execution_refused'
  | 'executed';

export interface StepRecord {
  step: string;
  status: 'ok' | 'failed' | 'skipped';
  at: string;
  detail?: string;
}

export interface RunManifest {
  runId: string;
  requirementId?: string;
  status: RunStatus;
  createdAt: string;
  provider: { name: string; model: string };
  steps: StepRecord[];
  artifacts: ArtifactRecord[];
}

export const RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[A-Z][A-Z0-9]*-\d+-[a-z0-9]{6}$/;

export class RunStore {
  readonly runDir: string;

  constructor(
    readonly repoRoot: string,
    readonly runsArea: string,
    readonly runId: string,
  ) {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error(`invalid run id "${runId}"`);
    this.runDir = path.join(repoRoot, runsArea, runId);
  }

  ensure(): void {
    mkdirSync(this.runDir, { recursive: true });
  }

  write(name: string, data: unknown): void {
    this.ensure();
    const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n';
    writeFileSync(path.join(this.runDir, name), body);
  }

  read<T>(name: string): T | undefined {
    const file = path.join(this.runDir, name);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined;
  }

  manifest(): RunManifest {
    const m = this.read<RunManifest>('manifest.json');
    if (!m) throw new Error(`run ${this.runId} has no manifest`);
    return m;
  }
}

export function newRunId(requirementId: string, now = new Date(), random = Math.random): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const suffix = Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(random() * 36)]).join('');
  return `${stamp}-${requirementId}-${suffix}`;
}
