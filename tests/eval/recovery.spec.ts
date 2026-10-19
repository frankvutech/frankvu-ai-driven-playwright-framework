import { test, expect } from '@playwright/test';
import { faultMetrics, runFaultInjection, type FaultResult } from '../../eval/faults';
import { loadPolicy } from '../../src/agent/execution/policy';
import { REPO_ROOT } from '../../eval/evaluate';

/** Build a FaultResult from known values (helper kept outside the tests). */
const r = (id: string, recoverable: boolean, recovered: boolean, pass: boolean, elapsedMs = 10, latency?: number): FaultResult => ({
  id, fault: id, expectedSafeBehaviour: '', recoverable,
  observed: { finalStatus: recovered ? 'plan_valid' : 'plan_failed', recovered, executions: 0, elapsedMs, limitMs: 100, recoveryLatencyMs: latency, retries: recoverable ? 1 : undefined },
  checks: [{ name: 'errorClassification', pass }], pass,
});

test.describe('tool-error recovery', () => {
  test('every injected fault produces its expected safe behaviour', async () => {
    const { results, metrics } = await runFaultInjection(loadPolicy(REPO_ROOT));
    for (const r of results) expect(r.checks.filter((c) => !c.pass), `${r.id} ${r.fault}`).toEqual([]);
    expect(results.map((r) => r.id)).toEqual(Array.from({ length: 26 }, (_, i) => `FI-${String(i + 1).padStart(2, '0')}`));
    expect(metrics.recoverySuccess).toEqual({ n: 2, d: 2, value: 1 });
    expect(metrics.retriesOnRecoverable).toEqual([{ id: 'FI-02', retries: 1 }, { id: 'FI-03', retries: 2 }]);
    expect(metrics.duplicateExecutionPrevented).toBe(true);
    expect(metrics.neverPassedWithoutEvidence).toBe(true);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId['FI-05'].observed).toMatchObject({ errorKind: 'malformed_json', attempts: 1 });
    expect(byId['FI-04'].observed).toMatchObject({ errorKind: 'provider_server', attempts: 3 });
    expect(byId['FI-15'].observed).toMatchObject({ finalStatus: 'awaiting_approval', executions: 0 });
    expect(byId['FI-21'].observed).toMatchObject({ finalStatus: 'config_error', executions: 0 });
    expect(byId['FI-23'].observed).toMatchObject({ finalStatus: 'generation_failed', attempts: 3, retries: 2 });
    expect(byId['FI-24'].observed).toMatchObject({ finalStatus: 'proposal_failed', attempts: 3 });
    expect(byId['FI-25'].observed.finalStatus).toBe('insufficient_evidence');
  });

  test('recovery metrics from known results', () => {
    const m = faultMetrics([r('A', true, true, true, 10, 30), r('B', true, false, false, 10), r('C', false, false, true, 500), r('D', false, false, true)]);
    expect(m.allExpectationsMet).toEqual({ n: 3, d: 4, value: 0.75 });
    expect(m.recoverySuccess).toEqual({ n: 1, d: 2, value: 0.5 });
    expect(m.meanRecoveryLatencyMs).toBe(30);
    expect(m.unrecoverablePropagated).toEqual({ n: 2, d: 2, value: 1 });
    expect(m.terminatedWithinLimits).toEqual({ n: 3, d: 4, value: 0.75 });
    expect(m.errorClassificationCorrect).toEqual({ n: 3, d: 4, value: 0.75 });
  });
});
