import type { TestEvidence } from './result';

/**
 * Lifecycle of one generated test artifact. Transitions are explicit and
 * checked; the terminal execution states can only be derived from real
 * Playwright evidence, never set by name.
 */
export type ArtifactState =
  | 'proposed'
  | 'validated'
  | 'awaiting_approval'
  | 'approved'
  | 'executed'
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'rejected';

export type Actor = { kind: 'agent' } | { kind: 'human'; name: string } | { kind: 'runner' };

export interface StateChange {
  from: ArtifactState;
  to: ArtifactState;
  at: string;
  actor: string;
  reason: string;
}

export interface ArtifactRecord {
  scenarioId: string;
  requirementId: string;
  /** Repo-relative path of the generated spec file. */
  file: string;
  sha256: string;
  state: ArtifactState;
  history: StateChange[];
}

const ALLOWED: Record<ArtifactState, ArtifactState[]> = {
  proposed: ['validated', 'rejected'],
  validated: ['awaiting_approval', 'rejected'],
  awaiting_approval: ['approved', 'rejected'],
  approved: ['executed'],
  executed: ['passed', 'failed', 'inconclusive'],
  passed: [],
  failed: [],
  inconclusive: [],
  rejected: [],
};

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}

function actorLabel(actor: Actor): string {
  return actor.kind === 'human' ? `human:${actor.name}` : actor.kind;
}

function apply(record: ArtifactRecord, to: ArtifactState, actor: Actor, reason: string, now: Date): ArtifactRecord {
  if (!ALLOWED[record.state].includes(to)) {
    throw new InvalidTransitionError(`${record.scenarioId}: ${record.state} -> ${to} is not allowed`);
  }
  return {
    ...record,
    state: to,
    history: [...record.history, { from: record.state, to, at: now.toISOString(), actor: actorLabel(actor), reason }],
  };
}

/** Pre-execution transitions. Approval is reserved for a named human. */
export function transition(
  record: ArtifactRecord,
  to: 'validated' | 'awaiting_approval' | 'approved' | 'rejected' | 'executed',
  actor: Actor,
  reason: string,
  now = new Date(),
): ArtifactRecord {
  // Outcome states are reachable only through recordOutcome(), from evidence.
  if ((['passed', 'failed', 'inconclusive'] as string[]).includes(to)) {
    throw new InvalidTransitionError('execution outcomes can only be derived from Playwright evidence');
  }
  if (to === 'approved') {
    if (actor.kind !== 'human' || actor.name.trim() === '') {
      throw new InvalidTransitionError('only a named human can approve an artifact');
    }
  }
  if (to === 'executed' && actor.kind !== 'runner') {
    throw new InvalidTransitionError('only the execution runner can mark an artifact executed');
  }
  return apply(record, to, actor, reason, now);
}

/**
 * Derive the outcome of an executed artifact from Playwright evidence.
 * `undefined` evidence means the runner produced no result for this test.
 */
export function recordOutcome(record: ArtifactRecord, evidence: TestEvidence | undefined, now = new Date()): ArtifactRecord {
  const runner: Actor = { kind: 'runner' };
  if (!evidence) {
    return apply(record, 'inconclusive', runner, 'no result for this test in the Playwright report', now);
  }
  switch (evidence.status) {
    case 'passed':
      return apply(record, 'passed', runner, `Playwright reported passed (${evidence.testId})`, now);
    case 'failed':
    case 'timedOut':
      return apply(record, 'failed', runner, `Playwright reported ${evidence.status} (${evidence.testId})`, now);
    default:
      return apply(record, 'inconclusive', runner, `Playwright reported ${evidence.status}`, now);
  }
}
