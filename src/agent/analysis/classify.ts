import type { RunEvidence, TestEvidence } from '../domain/result';
import type { Diagnosis, FailureAnalysis, Observation } from './types';

export interface AnalysisContext {
  /** Acceptance-criteria text of the originating requirement, if known. */
  acceptanceCriteriaText?: string;
}

const MAX_OBSERVATION = 1500;

/** Build the fact list for one failed test from runner evidence only. */
export function collectObservations(test: TestEvidence, run?: RunEvidence): Observation[] {
  const obs: Observation[] = [];
  const add = (source: string, text: string) =>
    obs.push({ id: `E${obs.length + 1}`, source, text: text.slice(0, MAX_OBSERVATION) });

  add('status', `final status ${test.status} after ${test.attempts.length} attempt(s), ${Math.round(test.durationMs)}ms`);
  const last = test.attempts[test.attempts.length - 1];
  last?.errors.forEach((e, i) => {
    add(`error[${i}].message`, e.message);
    if (e.location) add(`error[${i}].location`, e.location);
  });
  if (test.traceRef) add('attachment.trace', test.traceRef);
  test.screenshotRefs.forEach((s) => add('attachment.screenshot', s));
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
  const obs = collectObservations(test, run);
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
  if (setup.length > 0 || test.project === 'setup') {
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
