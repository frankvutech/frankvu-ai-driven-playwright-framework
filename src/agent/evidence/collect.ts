import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { JSONReport, JSONReportSuite, JSONReportTest } from '@playwright/test/reporter';
import { RESULT_SCHEMA_VERSION, type AttachmentRef, type RunEvidence, type TestEvidence } from '../domain/result';
import { redact, stripAnsi } from './redact';

export interface CollectInput {
  runId: string;
  repoRoot: string;
  reportPath: string;
  startedAt: Date;
  finishedAt: Date;
  target: { name: string; host: string };
  sessionVariant?: string;
  exampleAppVariant?: string;
  runner: { exitCode: number | null; timedOut: boolean; stderr: string };
  secrets?: string[];
}

const clean = (s: string, secrets?: string[]) => redact(stripAnsi(s), secrets);

function annotation(test: JSONReportTest, type: string): string | undefined {
  return test.annotations.find((a) => a.type === type)?.description;
}

function mapStatus(test: JSONReportTest): TestEvidence['status'] {
  switch (test.status) {
    case 'expected':
      return 'passed';
    case 'flaky':
      return 'flaky';
    case 'skipped':
      return 'skipped';
    case 'unexpected': {
      const last = test.results[test.results.length - 1]?.status;
      return last === 'timedOut' ? 'timedOut' : last === 'interrupted' ? 'interrupted' : 'failed';
    }
    default:
      return 'unknown';
  }
}

function* walk(suites: JSONReportSuite[]): Generator<{ spec: JSONReportSuite['specs'][number]; test: JSONReportTest }> {
  for (const suite of suites) {
    for (const spec of suite.specs) for (const test of spec.tests) yield { spec, test };
    if (suite.suites) yield* walk(suite.suites);
  }
}

/**
 * Turn Playwright's JSON report into versioned run evidence. Only artifacts
 * that exist on disk are referenced; all text is ANSI-stripped and redacted.
 */
export function collectEvidence(input: CollectInput): RunEvidence {
  const { repoRoot, secrets } = input;
  let report: JSONReport | undefined;
  if (existsSync(input.reportPath)) {
    try {
      report = JSON.parse(readFileSync(input.reportPath, 'utf8')) as JSONReport;
    } catch {
      report = undefined;
    }
  }

  const rel = (p: string) => path.relative(repoRoot, p).split(path.sep).join('/');
  const tests: TestEvidence[] = [];
  if (report) {
    for (const { spec, test } of walk(report.suites)) {
      const attempts = test.results.map((r) => {
        const attachments: AttachmentRef[] = r.attachments
          .filter((a) => a.path && existsSync(a.path))
          .map((a) => ({ name: a.name, contentType: a.contentType, path: rel(a.path!) }));
        return {
          retry: r.retry,
          status: r.status ?? 'unknown',
          durationMs: r.duration,
          errors: r.errors.map((e) => ({
            message: clean(e.message, secrets),
            location: e.location ? `${rel(e.location.file)}:${e.location.line}` : undefined,
          })),
          attachments,
        };
      });
      const all = attempts.flatMap((a) => a.attachments);
      tests.push({
        testId: spec.id,
        title: spec.title,
        file: spec.file,
        project: test.projectName,
        requirementId: annotation(test, 'requirement'),
        scenarioId: annotation(test, 'scenario'),
        status: mapStatus(test),
        durationMs: attempts.reduce((n, a) => n + a.durationMs, 0),
        retries: Math.max(0, attempts.length - 1),
        attempts,
        traceRef: all.find((a) => a.name === 'trace')?.path,
        screenshotRefs: all.filter((a) => a.contentType.startsWith('image/')).map((a) => a.path),
      });
    }
  }

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    runId: input.runId,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    environment: {
      targetName: input.target.name,
      baseUrlHost: input.target.host,
      sessionVariant: input.sessionVariant ?? 'standard',
      exampleAppVariant: input.exampleAppVariant ?? 'standard',
      playwrightVersion: report?.config.version ?? 'unknown',
      node: process.version,
      platform: process.platform,
      ci: Boolean(process.env.CI),
    },
    runner: {
      exitCode: input.runner.exitCode,
      timedOut: input.runner.timedOut,
      reportFound: report !== undefined,
      globalErrors: (report?.errors ?? []).map((e) => clean(e.message ?? String(e.value ?? ''), secrets)),
      stderrTail: clean(input.runner.stderr.slice(-4000), secrets),
    },
    tests,
  };
}
