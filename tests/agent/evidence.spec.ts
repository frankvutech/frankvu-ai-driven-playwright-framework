import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectEvidence, type CollectInput } from '../../src/agent/evidence/collect';
import { redact, stripAnsi } from '../../src/agent/evidence/redact';
import { RunEvidenceSchema } from '../../src/agent/domain/result';
import { REPO_ROOT } from './helpers';

const FAILURES = path.join(REPO_ROOT, 'eval/dataset/failures');
const input = (reportPath: string, over: Partial<CollectInput> = {}): CollectInput => ({
  runId: 'r1',
  repoRoot: REPO_ROOT,
  reportPath,
  startedAt: new Date(0),
  finishedAt: new Date(1000),
  target: { name: 'saucedemo-public-demo', host: 'www.saucedemo.com' },
  runner: { exitCode: 1, timedOut: false, stderr: '' },
  ...over,
});

test.describe('evidence collection from real Playwright reports', () => {
  test('maps statuses, projects and scenario annotations', () => {
    const ev = collectEvidence(input(path.join(FAILURES, 'playwright-report.capture.json')));
    expect(RunEvidenceSchema.safeParse(ev).success).toBe(true);
    expect(ev.runner.reportFound).toBe(true);
    const byTitle = Object.fromEntries(ev.tests.map((t) => [t.title, t]));
    expect(byTitle['passes']).toMatchObject({ status: 'passed', project: 'agent-generated', scenarioId: 'CAP-1-SC-06', retries: 0 });
    expect(byTitle['assertion-not-from-requirement']).toMatchObject({ status: 'failed', scenarioId: 'CAP-1-SC-01' });
    expect(byTitle['sign in as standard user']).toMatchObject({ status: 'passed', project: 'setup', scenarioId: undefined });
    expect(byTitle['assertion-not-from-requirement'].attempts[0].errors[0].message).toContain('Expected: "Our Products"');
  });

  test('a test that never ran because setup failed is skipped, not passed', () => {
    const ev = collectEvidence(input(path.join(FAILURES, 'playwright-report.setup-failure.json')));
    expect(ev.tests.map((t) => [t.project, t.status])).toEqual([
      ['setup', 'failed'],
      ['agent-generated', 'skipped'],
    ]);
  });

  test('artifact references are only kept when the file exists', () => {
    const dir = path.join(REPO_ROOT, '.agent/runs/evidence-unit');
    mkdirSync(dir, { recursive: true });
    try {
      const shot = path.join(dir, 'shot.png');
      writeFileSync(shot, 'png');
      const report = {
        config: { version: '1.64.1' }, errors: [], stats: {},
        suites: [{ title: 'a', file: 'a.spec.ts', specs: [{ id: 's1', title: 't', file: 'a.spec.ts', tests: [{
          projectName: 'agent-generated', status: 'unexpected', annotations: [{ type: 'scenario', description: 'REQ-1-SC-01' }],
          results: [{ retry: 0, status: 'failed', duration: 5, errors: [{ message: 'boom' }], attachments: [
            { name: 'screenshot', contentType: 'image/png', path: shot },
            { name: 'trace', contentType: 'application/zip', path: path.join(dir, 'missing-trace.zip') },
          ] }],
        }] }] }],
      };
      writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report));
      const [t] = collectEvidence(input(path.join(dir, 'report.json'))).tests;
      expect(t.screenshotRefs).toEqual(['.agent/runs/evidence-unit/shot.png']);
      expect(t.traceRef).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing or corrupt report yields no tests and reportFound=false', () => {
    expect(collectEvidence(input('/nonexistent/report.json'))).toMatchObject({ tests: [], runner: { reportFound: false } });
    const dir = path.join(REPO_ROOT, '.agent/runs/evidence-corrupt');
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path.join(dir, 'r.json'), '{ not json');
      expect(collectEvidence(input(path.join(dir, 'r.json'))).runner.reportFound).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stderr and error text are redacted', () => {
    const ev = collectEvidence(input('/nonexistent', { runner: { exitCode: 1, timedOut: false, stderr: 'key sk-ant-abc123 and secret_sauce' } }));
    expect(ev.runner.stderrTail).toBe('key [REDACTED_API_KEY] and [REDACTED]');
  });
});

test.describe('redaction', () => {
  test('removes known secret values and common credential shapes', () => {
    const text = 'password=hunter2 Authorization: Bearer abc.def token: "t0k3n" sk-ant-api03-XYZ secret_sauce mysecretvalue';
    expect(redact(text, ['mysecretvalue'])).toBe(
      // Authorization values are redacted whatever the scheme (Bearer, Basic, ...).
      'password=[REDACTED] Authorization: [REDACTED] [REDACTED] token: "[REDACTED]" [REDACTED_API_KEY] secret_sauce [REDACTED]',
    );
    expect(redact('login with secret_sauce')).toBe('login with [REDACTED]');
  });

  test('strips terminal colour codes', () => {
    expect(stripAnsi('\u001b[31mExpected\u001b[39m')).toBe('Expected');
  });
});
