import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Requirement } from '../../src/agent/domain/requirement';
import type { TestPlan } from '../../src/agent/domain/plan';
import type { GenerationOutput } from '../../src/agent/domain/testSpec';
import { loadPolicy } from '../../src/agent/execution/policy';
import { newRunId } from '../../src/agent/workflow/store';
import type { RetryPolicy } from '../../src/agent/llm/structured';

export const REPO_ROOT = path.resolve(__dirname, '../..');
export const policy = loadPolicy(REPO_ROOT);

const read = <T>(p: string): T => JSON.parse(readFileSync(path.join(REPO_ROOT, p), 'utf8')) as T;

export const requirement101 = (): Requirement => read<Requirement>('examples/requirements/REQ-101-sign-in.json');
const replies = () => read<{ 'test-plan': [TestPlan]; 'test-generation': [GenerationOutput] }>('examples/mock-replies/REQ-101.json');
export const plan101 = (): TestPlan => replies()['test-plan'][0];
export const generation101 = (): GenerationOutput => replies()['test-generation'][0];

export const NO_WAIT: RetryPolicy = { maxAttempts: 3, timeoutMs: 5_000, baseBackoffMs: 1, maxBackoffMs: 5 };

/** A unique run id; removes its generated/ and .relynx/ folders on cleanup. */
export function scratchRun(requirementId = 'REQ-101') {
  const runId = newRunId(requirementId);
  return {
    runId,
    cleanup: () => {
      rmSync(path.join(REPO_ROOT, 'generated', runId), { recursive: true, force: true });
      rmSync(path.join(REPO_ROOT, '.relynx', 'runs', runId), { recursive: true, force: true });
    },
  };
}
