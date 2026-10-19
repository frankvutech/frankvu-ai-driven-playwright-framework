import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runEvaluation } from '../../eval/run';
import { REPO_ROOT } from '../../eval/evaluate';

/*
 * Functional evaluation end to end against the demo target: pinned dataset
 * specs go through generation, validation, approval, execution, evidence and
 * analysis, and the report counts outcomes against reference labels.
 */
test('functional evaluation of the login suite counts the incorrect assertion as a false-positive failure', async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'agent-eval-int-'));
  try {
    const { report, exitCode } = await runEvaluation({ mode: 'functional', outDir: out, approver: 'Integration Test Reviewer', suites: ['FS-LOGIN'], env: process.env });
    expect(exitCode).toBe(0);
    const m = Object.fromEntries(report.metrics.map((x) => [x.id, x.value]));
    expect([m['functional.detection.truePositives'], m['functional.detection.falsePositives'], m['functional.detection.trueNegatives'], m['functional.detection.falseNegatives']]).toEqual([0, 1, 1, 0]);
    expect(report.findings).toContainEqual(expect.objectContaining({ type: 'false-positive-failure', id: 'FS-LOGIN/standard/REQ-304-SC-02' }));
    expect(m['latency.playwrightMedianMs']).toBeGreaterThan(0);
    expect(report.metrics.find((x) => x.id === 'cost.inputTokens')?.status).toBe('unavailable');
    expect(report.metadata.executionRefs).toHaveLength(1);
    const run = path.join(REPO_ROOT, report.metadata.executionRefs[0]);
    expect(existsSync(path.join(run, 'evidence.json'))).toBe(true);
    rmSync(run, { recursive: true, force: true });
    rmSync(path.join(REPO_ROOT, 'generated', path.basename(run)), { recursive: true, force: true });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('healing evaluation: safety gates are judged on real runs; a product defect never reaches the model', async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'agent-eval-heal-'));
  try {
    // Fast cases only: a product defect, a rejected proposal and a passing test.
    const { report, exitCode } = await runEvaluation({ mode: 'healing', outDir: out, approver: 'Integration Test Reviewer', cases: ['HE-03', 'HE-09', 'HE-15'], env: process.env });
    expect(exitCode).toBe(0);
    const cases = (report.sections.healing as { cases: Array<{ id: string; outcome: string; modelCalled: boolean }> }).cases;
    expect(cases.map((c) => [c.id, c.outcome])).toEqual([['HE-03', 'validation_failed'], ['HE-09', 'not_applicable'], ['HE-15', 'insufficient_evidence']]);
    expect(cases.find((c) => c.id === 'HE-09')?.modelCalled).toBe(false);
    const safety = report.gates.filter((g) => g.severity === 'safety');
    expect(safety.length).toBeGreaterThanOrEqual(4);
    expect(safety.every((g) => g.status === 'pass')).toBe(true);
    // Rates without a denominator are reported as unavailable, not as 0% or 100%.
    expect(report.metrics.find((m) => m.id === 'healing.verifiedSuccessRate')).toMatchObject({ value: 0, denominator: 1 });
    expect(report.metrics.find((m) => m.id === 'healing.regressionRate')?.status).toBe('unavailable');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
