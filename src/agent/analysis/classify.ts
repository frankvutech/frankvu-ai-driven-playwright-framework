import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RunEvidence, TestEvidence } from '../domain/result';
import { redact } from '../evidence/redact';
import type { Diagnosis, FailureAnalysis, Observation } from './types';

export interface AnalysisContext {
  /** Acceptance-criteria text of the originating requirement, if known. */
  acceptanceCriteriaText?: string;
  /** Resolves attachment paths; without it, attachment contents are not read. */
  repoRoot?: string;
}

const MAX_OBSERVATION = 1500;
const MAX_SNAPSHOT = 6000;

/**
 * The accessibility snapshot of the page at the moment of failure, from the
 * error-context attachment Playwright writes. Only the snapshot section is
 * kept: the rest of that file includes generic instructions and source.
 */
export function pageSnapshot(test: TestEvidence, repoRoot: string): string | undefined {
  const last = test.attempts[test.attempts.length - 1];
  const ref = last?.attachments.find((a) => a.name === 'error-context');
  if (!ref) return undefined;
  const file = path.resolve(repoRoot, ref.path);
  if (!file.startsWith(path.resolve(repoRoot) + path.sep) || !existsSync(file)) return undefined;
  const match = /# Page snapshot\s*```yaml\n([\s\S]*?)\n```/.exec(readFileSync(file, 'utf8'));
  return match ? redact(match[1]).slice(0, MAX_SNAPSHOT) : undefined;
}

/** Build the fact list for one failed test from runner evidence only. */
export function collectObservations(test: TestEvidence, run?: RunEvidence, repoRoot?: string): Observation[] {
  const obs: Observation[] = [];
  const add = (source: string, text: string, limit = MAX_OBSERVATION) =>
    obs.push({ id: `E${obs.length + 1}`, source, text: text.slice(0, limit) });

  add('status', `final status ${test.status} after ${test.attempts.length} attempt(s), ${Math.round(test.durationMs)}ms`);
  const last = test.attempts[test.attempts.length - 1];
  last?.errors.forEach((e, i) => {
    add(`error[${i}].message`, e.message);
    if (e.location) add(`error[${i}].location`, e.location);
  });
  if (test.traceRef) add('attachment.trace', test.traceRef);
  test.screenshotRefs.forEach((s) => add('attachment.screenshot', s));
  const snapshot = repoRoot ? pageSnapshot(test, repoRoot) : undefined;
  if (snapshot) add('attachment.page-snapshot', snapshot, MAX_SNAPSHOT);
  if (test.attempts.length > 1) add('retries', `attempt statuses: ${test.attempts.map((a) => a.status).join(', ')}`);
  run?.runner.globalErrors.forEach((g, i) => add(`run.globalError[${i}]`, g));
  if (run?.runner.timedOut) add('run.timedOut', 'the runner was stopped by the execution time limit');
  return obs;
}

function find(obs: Observation[], re: RegExp): Observation[] {
  return obs.filter((o) => re.test(o.text));
}

function ids(...groups: Observation[][]): string[] {
  return [...new Set(groups.flat().map((o) => o.id))];
}

/** Pull the value after "Expected:" from a Playwright assertion message. */
export function expectedValue(message: string): string | undefined {
  const m = /^Expected(?: string| pattern| substring)?: (.+)$/m.exec(message);
  if (!m) return undefined;
  return m[1].trim().replace(/^"(.*)"$/, '$1');
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Deterministic, rule-based diagnosis. It is the baseline (and the fallback
 * when model analysis is unavailable or rejected). Rules look only at runner
 * evidence; each cites the observations it used.
 */
export function classifyFailure(test: TestEvidence, ctx: AnalysisContext = {}, run?: RunEvidence): FailureAnalysis {
  const obs = collectObservations(test, run, ctx.repoRoot);
  const errors = obs.filter((o) => o.source.endsWith('.message') || o.source.startsWith('run.'));
  const status = obs.filter((o) => o.source === 'status');
  const d = (diag: Diagnosis): FailureAnalysis => ({
    testId: test.testId,
    title: test.title,
    scenarioId: test.scenarioId,
    observations: obs,
    diagnosis: diag,
    method: 'rules',
    notes: [],
  });

  const infra = find(errors, /Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError: |Error: No tests found|Worker process exited unexpectedly|Error: Project\(s\) .* not found/);
  if (infra.length > 0) {
    return d({
      category: 'infrastructure',
      confidence: 'high',
      hypothesis: 'The test runner or tooling failed before the test could exercise the application.',
      alternatives: [],
      evidenceIds: ids(infra),
      sufficientEvidence: true,
      nextSteps: ['Fix the runner, configuration or dependency problem named in the error, then re-run.'],
    });
  }

  const env = find(errors, /net::ERR_|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Executable doesn't exist|browserType\.launch|ERR_NAME_NOT_RESOLVED/);
  if (env.length > 0) {
    return d({
      category: 'environment',
      confidence: 'high',
      hypothesis: 'The browser could not reach the target or could not start. The test logic was not exercised.',
      alternatives: [],
      evidenceIds: ids(env),
      sufficientEvidence: true,
      nextSteps: ['Check that the target URL is reachable from the runner and that browsers are installed.'],
    });
  }

  const setup = find(errors, /storageState|\.auth\/|ENOENT/);
  if (setup.length > 0 || /setup$/.test(test.project)) {
    return d({
      category: 'test_data_setup',
      confidence: 'medium',
      hypothesis: 'Test setup (authentication state or test data) failed before the scenario ran.',
      alternatives: [{ category: 'environment', why: 'setup can fail because the target is unavailable' }],
      evidenceIds: ids(setup.length ? setup : errors, status),
      sufficientEvidence: false,
      nextSteps: ['Inspect the setup project result and the credentials/data it depends on.'],
    });
  }

  const notFound = find(errors, /element\(s\) not found|resolved to 0 elements/);
  const timeout = find(errors, /Timeout \d+ms exceeded|Test timeout of \d+ms exceeded|Timed out \d+ms/);
  const waitingFor = find(errors, /waiting for (getBy|locator)/);
  if (notFound.length > 0 || (timeout.length > 0 && waitingFor.length > 0 && find(errors, /locator resolved to/).length === 0)) {
    return d({
      category: 'locator',
      confidence: 'medium',
      hypothesis: 'The locator matched no element. Either the locator is wrong or the element is genuinely absent.',
      alternatives: [
        { category: 'product_behavior', why: 'the page may not render the element because of a defect or a changed flow' },
        { category: 'timeout_sync', why: 'the element may appear later than the timeout allows' },
      ],
      evidenceIds: ids(notFound, waitingFor, timeout),
      sufficientEvidence: false,
      nextSteps: ['Open the trace or screenshot and check whether the element exists on the page at that moment.'],
    });
  }

  // The element exists but stayed hidden for the whole assertion timeout.
  const stillHidden = find(errors, /^Expected: visible$/m).filter((o) => /^Received: hidden$/m.test(o.text) || /unexpected value "hidden"/.test(o.text));
  if (stillHidden.length > 0) {
    return d({
      category: 'timeout_sync',
      confidence: 'medium',
      hypothesis: 'The element was found but did not become visible within the assertion timeout: a timing or synchronisation problem.',
      alternatives: [
        { category: 'product_behavior', why: 'the element may never be shown because of a defect' },
        { category: 'locator', why: 'the locator may match a different, hidden element' },
      ],
      evidenceIds: ids(stillHidden),
      sufficientEvidence: false,
      nextSteps: ['Check in the trace when the element became visible, and re-run to see whether the failure is intermittent.'],
    });
  }

  // HTTP status assertions in API tests: expect(<response>.status()).toBe(<n>).
  const statusMismatch = find(errors, /\.status\(\)\)\.toBe\(/).filter((o) => /^Expected: \d{3}$/m.test(o.text) && /^Received: \d{3}$/m.test(o.text));
  if (statusMismatch.length > 0) {
    const expected = /^Expected: (\d{3})$/m.exec(statusMismatch[0].text)![1];
    const received = /^Received: (\d{3})$/m.exec(statusMismatch[0].text)![1];
    const inRequirement = ctx.acceptanceCriteriaText !== undefined && new RegExp(`\\b${expected}\\b`).test(ctx.acceptanceCriteriaText);
    if (received.startsWith('5') || inRequirement) {
      return d({
        category: 'product_behavior',
        confidence: 'medium',
        hypothesis: received.startsWith('5')
          ? `The API answered ${received} (server error) where the test expected ${expected}. A server error is not a valid outcome of the contract.`
          : `The API answered ${received}, but the acceptance criteria require ${expected}.`,
        alternatives: [
          { category: 'environment', why: 'the service may be unhealthy or misconfigured rather than defective' },
          { category: 'api_contract', why: 'the contract may have changed intentionally' },
        ],
        evidenceIds: ids(statusMismatch),
        sufficientEvidence: false,
        nextSteps: ['Reproduce the request and check the service logs; confirm the expected status with the API owner.'],
      });
    }
    return d({
      category: 'api_contract',
      confidence: 'medium',
      hypothesis: `The API answered ${received} where the test expected ${expected}, and the acceptance criteria do not state ${expected}.`,
      alternatives: [
        { category: 'assertion_logic', why: 'the expected status may be a wrong assumption of the test' },
        { category: 'product_behavior', why: 'the API may be wrong' },
      ],
      evidenceIds: ids(statusMismatch),
      sufficientEvidence: false,
      nextSteps: ['Compare the status with the documented API contract before changing either side.'],
    });
  }

  const schemaMismatch = find(errors, /does not match the expected schema|is not JSON \(content-type/);
  if (schemaMismatch.length > 0) {
    return d({
      category: 'api_contract',
      confidence: 'medium',
      hypothesis: 'The response body did not match the expected schema.',
      alternatives: [{ category: 'product_behavior', why: 'the API may return wrong data' }],
      evidenceIds: ids(schemaMismatch),
      sufficientEvidence: false,
      nextSteps: ['Compare the schema problems in the error with the API contract.'],
    });
  }

  const mismatch = find(errors, /^Expected[^:]*: /m).filter((o) => /^Received[^:]*: /m.test(o.text));
  if (mismatch.length > 0) {
    const expected = expectedValue(mismatch[0].text);
    const fromRequirement =
      expected !== undefined && ctx.acceptanceCriteriaText !== undefined && expected.length > 0 && norm(ctx.acceptanceCriteriaText).includes(norm(expected));
    return d(
      fromRequirement
        ? {
            category: 'product_behavior',
            confidence: 'medium',
            hypothesis: 'The application showed a different value from the one the acceptance criteria require.',
            alternatives: [{ category: 'assertion_logic', why: 'the criterion may be outdated or the test may check the wrong element' }],
            evidenceIds: ids(mismatch),
            sufficientEvidence: false,
            nextSteps: ['Confirm the expected value with the requirement owner, then reproduce manually.'],
          }
        : {
            category: 'assertion_logic',
            confidence: 'medium',
            hypothesis: 'The assertion expected a value that does not appear in the acceptance criteria, so the expectation itself is suspect.',
            alternatives: [{ category: 'product_behavior', why: 'the application may genuinely be wrong' }],
            evidenceIds: ids(mismatch),
            sufficientEvidence: false,
            nextSteps: ['Compare the expected value with the requirement and the received value in the error.'],
          },
    );
  }

  if (timeout.length > 0) {
    return d({
      category: 'timeout_sync',
      confidence: 'low',
      hypothesis: 'The test ran out of time. A timeout alone does not identify the cause.',
      alternatives: [
        { category: 'environment', why: 'slow or overloaded target' },
        { category: 'product_behavior', why: 'the application may hang' },
      ],
      evidenceIds: ids(timeout),
      sufficientEvidence: false,
      nextSteps: ['Open the trace to see which step was waiting.'],
    });
  }

  return d({
    category: 'inconclusive',
    confidence: 'low',
    hypothesis: 'The recorded evidence does not match any known failure pattern.',
    alternatives: [],
    evidenceIds: ids(errors.length ? errors : status),
    sufficientEvidence: false,
    nextSteps: ['Inspect the full error output and trace manually.'],
  });
}
