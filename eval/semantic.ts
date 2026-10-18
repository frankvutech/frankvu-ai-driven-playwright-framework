import { z } from 'zod';
import type { Scenario, TestPlan } from '../src/agent/domain/plan';
import type { Requirement } from '../src/agent/domain/requirement';
import type { TestSpec } from '../src/agent/domain/testSpec';
import type { LlmProvider } from '../src/agent/llm/provider';
import { callStructured, type UsageRecord } from '../src/agent/llm/structured';
import { asData, DATA_RULE, JSON_RULE } from '../src/agent/prompts/common';
import { describeAssertion } from './assertions';

/* ------------------- reference-based deterministic checks ------------------- */

/** Is each required assertion (from reviewed reference properties) present, positive and exact? */
export function requiredAssertionCoverage(spec: TestSpec, required: Array<{ target: string; expected: string | number | string[] }>) {
  const missing = required.filter(
    (r) => !spec.steps.some((s) => s.kind === 'expect' && !s.negate && s.target === r.target && JSON.stringify(s.expected) === JSON.stringify(r.expected)),
  );
  return { required: required.length, satisfied: required.length - missing.length, missing };
}

/** Prohibited assumptions: phrases the reference says must not appear in the plan (a keyword proxy, not understanding). */
export function prohibitedAssumptionHits(plan: TestPlan, prohibited: string[]) {
  const hits: Array<{ scenarioId: string; phrase: string }> = [];
  for (const s of plan.scenarios) {
    const text = [s.title, s.objective, ...s.steps, ...s.expectedOutcomes, ...s.testData].join(' ').toLowerCase();
    for (const phrase of prohibited) if (text.includes(phrase.toLowerCase())) hits.push({ scenarioId: s.id, phrase });
  }
  return hits;
}

export type Clarification = 'none' | 'ask-before-planning' | 'surface-ambiguity' | 'declare-uncovered';

/** Did the agent behave as the reference expects when information is missing or contradictory? */
export function clarificationBehaviour(
  expected: Clarification,
  outcome: string,
  plan: TestPlan | undefined,
  mustDeclareUncovered: string[] = [],
): { ok: boolean; detail: string } {
  const raised = plan ? plan.ambiguities.length + plan.scenarios.reduce((n, s) => n + s.openQuestions.length, 0) : 0;
  const declared = new Set(plan?.uncoveredAcceptanceCriteria.map((u) => u.id) ?? []);
  const undeclared = mustDeclareUncovered.filter((id) => !declared.has(id));
  switch (expected) {
    case 'none':
      return { ok: true, detail: 'no clarification expected' };
    case 'ask-before-planning':
      return { ok: outcome === 'needs_clarification', detail: `outcome ${outcome}` };
    case 'surface-ambiguity':
      return { ok: raised > 0 && undeclared.length === 0, detail: `${raised} ambiguity/question(s); undeclared: ${undeclared.join(', ') || 'none'}` };
    case 'declare-uncovered':
      return { ok: undeclared.length === 0 && !!plan, detail: `undeclared: ${undeclared.join(', ') || 'none'}` };
  }
}

/* ------------------------- optional semantic judge ------------------------- */

export const JudgeVerdictSchema = z
  .object({
    assertions: z
      .array(
        z
          .object({
            index: z.number().int().min(0),
            verdict: z.enum(['adequate', 'weak', 'unrelated', 'incorrect']),
            reason: z.string().max(500),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export const JUDGE_SYSTEM = `You review the assertions of one automated UI test against the requirement it claims to verify.
For each assertion (by index) answer: adequate (verifies the stated behaviour), weak (related but would also pass if the behaviour were broken), unrelated (does not verify the stated behaviour), or incorrect (contradicts the requirement).
Judge only against the acceptance criteria given. ${DATA_RULE} ${JSON_RULE}`;

export class SelfJudgeError extends Error {}

/**
 * Optional LLM-as-judge. Advisory only: its verdicts are reported separately
 * from deterministic findings, compared against human labels where they exist,
 * and never override a deterministic failure. It refuses to judge with the
 * same provider/model that generated the output, unless explicitly allowed.
 */
export async function judgeAssertions(
  judge: LlmProvider,
  generator: { name: string; model: string },
  input: { requirement: Requirement; scenario: Scenario | undefined; spec: TestSpec },
  options: { allowSelfJudge?: boolean } = {},
): Promise<{ ok: true; verdict: JudgeVerdict; usage: UsageRecord } | { ok: false; reason: string; usage?: UsageRecord }> {
  if (!options.allowSelfJudge && judge.name === generator.name && judge.model === generator.model) {
    throw new SelfJudgeError(`judge ${judge.name}/${judge.model} is the model being evaluated`);
  }
  const assertions = input.spec.steps.filter((s) => s.kind !== 'action').map((s, index) => ({ index, assertion: describeAssertion(s as never) }));
  const result = await callStructured(
    judge,
    {
      useCase: 'assertion-judge',
      system: JUDGE_SYSTEM,
      prompt: [asData('acceptance_criteria', input.requirement.acceptanceCriteria), asData('scenario', input.scenario ?? null), asData('assertions', assertions)].join('\n\n'),
      maxTokens: 4000,
    },
    JudgeVerdictSchema,
  );
  if (!result.ok) return { ok: false, reason: `${result.kind}: ${result.detail}`, usage: result.usage };
  const outOfRange = result.value.assertions.filter((a) => a.index >= assertions.length);
  if (outOfRange.length > 0) return { ok: false, reason: 'judge referenced assertions that do not exist', usage: result.usage };
  return { ok: true, verdict: result.value, usage: result.usage };
}
