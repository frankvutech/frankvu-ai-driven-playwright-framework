import { test, expect } from '@playwright/test';
import { InvalidTransitionError, recordOutcome, transition, type ArtifactRecord } from '../../src/agent/domain/state';
import type { TestEvidence } from '../../src/agent/domain/result';

const human = { kind: 'human' as const, name: 'Frank Vu' };
const agent = { kind: 'agent' as const };
const runner = { kind: 'runner' as const };
const fresh = (): ArtifactRecord => ({ scenarioId: 'REQ-1-SC-01', requirementId: 'REQ-1', file: 'generated/x/a.spec.ts', sha256: 'abc', state: 'proposed', history: [] });
const evidence = (status: TestEvidence['status']): TestEvidence => ({
  testId: 't1', title: 't', file: 'a.spec.ts', project: 'agent-generated', status, durationMs: 1, retries: 0, attempts: [], screenshotRefs: [],
});
const approved = () =>
  transition(transition(transition(fresh(), 'validated', agent, 'ok'), 'awaiting_approval', agent, 'ok'), 'approved', human, 'looks right');
const executed = () => transition(approved(), 'executed', runner, 'ran');

test.describe('artifact state machine', () => {
  test('follows proposed -> validated -> awaiting_approval -> approved -> executed -> passed', () => {
    const done = recordOutcome(executed(), evidence('passed'));
    expect(done.state).toBe('passed');
    expect(done.history.map((h) => `${h.from}>${h.to}:${h.actor}`)).toEqual([
      'proposed>validated:agent',
      'validated>awaiting_approval:agent',
      'awaiting_approval>approved:human:Frank Vu',
      'approved>executed:runner',
      'executed>passed:runner',
    ]);
  });

  test('skipping states is rejected', () => {
    expect(() => transition(fresh(), 'approved', human, 'x')).toThrow(InvalidTransitionError);
    expect(() => transition(fresh(), 'executed', runner, 'x')).toThrow(InvalidTransitionError);
    expect(() => recordOutcome(approved(), evidence('passed'))).toThrow(InvalidTransitionError);
  });

  test('only a named human can approve', () => {
    const waiting = transition(transition(fresh(), 'validated', agent, 'ok'), 'awaiting_approval', agent, 'ok');
    expect(() => transition(waiting, 'approved', agent, 'self-approval')).toThrow('only a named human');
    expect(() => transition(waiting, 'approved', runner, 'x')).toThrow('only a named human');
    expect(() => transition(waiting, 'approved', { kind: 'human', name: '  ' }, 'x')).toThrow('only a named human');
  });

  test('only the runner can mark an artifact executed', () => {
    expect(() => transition(approved(), 'executed', agent, 'pretend')).toThrow('only the execution runner');
  });

  test('outcome states cannot be set by name, even with a cast', () => {
    const t = transition as (r: ArtifactRecord, to: string, a: unknown, reason: string) => ArtifactRecord;
    expect(() => t(executed(), 'passed', runner, 'trust me')).toThrow('derived from Playwright evidence');
  });

  test('outcomes are derived from evidence status', () => {
    expect(recordOutcome(executed(), evidence('failed')).state).toBe('failed');
    expect(recordOutcome(executed(), evidence('timedOut')).state).toBe('failed');
    expect(recordOutcome(executed(), evidence('flaky')).state).toBe('inconclusive');
    expect(recordOutcome(executed(), evidence('skipped')).state).toBe('inconclusive');
    expect(recordOutcome(executed(), evidence('interrupted')).state).toBe('inconclusive');
  });

  test('a test with no result is inconclusive, never passed', () => {
    const r = recordOutcome(executed(), undefined);
    expect(r.state).toBe('inconclusive');
    expect(r.history.at(-1)?.reason).toContain('no result');
  });

  test('terminal states accept no further transitions', () => {
    const rejected = transition(fresh(), 'rejected', agent, 'bad');
    expect(() => transition(rejected, 'validated', agent, 'retry')).toThrow(InvalidTransitionError);
    expect(() => recordOutcome(recordOutcome(executed(), evidence('failed')), evidence('passed'))).toThrow(InvalidTransitionError);
  });
});
