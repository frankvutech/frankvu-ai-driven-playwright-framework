import { z } from 'zod';
import type { Scenario, TestPlan } from '../src/agent/domain/plan';
import type { Requirement } from '../src/agent/domain/requirement';
import type { TestSpec } from '../src/agent/domain/testSpec';
import type { LlmProvider } from '../src/agent/llm/provider';
import { callStructured, type UsageRecord } from '../src/agent/llm/structured';
import { asData, DATA_RULE, JSON_RULE } from '../src/agent/prompts/common';
import { describeAssertion } from './assertions';
import type { RequiredAssertion } from './schema';

/* ------------------- reference-based deterministic checks ------------------- */

/**
 * Is each required assertion (from reference properties) present, positive and
 * exact? UI: an expect on the target with that value. API: a status, or a body
 * field with that literal value, on the response of the named client call.
 */
export function requiredAssertionCoverage(spec: TestSpec, required: RequiredAssertion[]) {
  const responsesOf = (call: string) =>
    spec.steps.flatMap((s) => (s.kind === 'apiCall' && `${s.client}.${s.method}` === call ? [s.saveAs] : []));
  const present = (r: RequiredAssertion): boolean => {
    if (!('kind' in r)) {
      return spec.steps.some((s) => s.kind === 'expect' && !s.negate && s.target === r.target && JSON.stringify(s.expected) === JSON.stringify(r.expected));
    }
    const responses = responsesOf(r.call);
    if (r.kind === 'status') return spec.steps.some((s) => s.kind === 'expectStatus' && responses.includes(s.response) && s.status === r.status);
    return spec.steps.some(
      (s) => s.kind === 'expectBody' && responses.includes(s.response) && !s.negate && s.field === r.field && s.expected?.kind === 'literal' && s.expected.value === r.expected,
    );
  };
  const missing = required.filter((r) => !present(r));
  return { required: required.length, satisfied: required.length - missing.length, missing };
}

/** Human-readable form of a required assertion. */
export function describeRequired(r: RequiredAssertion): string {
  if (!('kind' in r)) return `${r.target} = ${JSON.stringify(r.expected)}`;
  return r.kind === 'status' ? `${r.call} status ${r.status}` : `${r.call} ${r.field} = ${JSON.stringify(r.expected)}`;
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
  const assertions = input.spec.steps.filter((s) => s.kind === 'expect' || s.kind === 'expectUrl').map((s, index) => ({ index, assertion: describeAssertion(s as never) }));
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
