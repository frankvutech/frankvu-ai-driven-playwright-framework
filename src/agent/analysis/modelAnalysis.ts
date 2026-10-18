import type { LlmProvider } from '../llm/provider';
import { callStructured, type RetryPolicy, type UsageRecord, DEFAULT_RETRY_POLICY } from '../llm/structured';
import { ANALYZE_SYSTEM, analyzePrompt } from '../prompts/analyze';
import { DiagnosisSchema, type FailureAnalysis } from './types';

/**
 * Optional model-assisted diagnosis layered on the rule-based one. The model
 * output is accepted only if it is schema-valid and every cited evidence id
 * exists; otherwise the rule-based diagnosis stands. Always advisory.
 */
export async function refineWithModel(
  provider: LlmProvider,
  baseline: FailureAnalysis,
  context: { scenario?: unknown; acceptanceCriteria?: unknown },
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<{ analysis: FailureAnalysis; usage: UsageRecord }> {
  const result = await callStructured(
    provider,
    {
      useCase: 'failure-analysis',
      system: ANALYZE_SYSTEM,
      prompt: analyzePrompt({ testTitle: baseline.title, ...context }, baseline.observations),
      maxTokens: 4000,
    },
    DiagnosisSchema,
    policy,
  );
  if (!result.ok) {
    return { analysis: { ...baseline, notes: [...baseline.notes, `model analysis unavailable (${result.kind}); rule-based result kept`] }, usage: result.usage };
  }

  const known = new Set(baseline.observations.map((o) => o.id));
  const unknown = result.value.evidenceIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return {
      analysis: { ...baseline, notes: [...baseline.notes, `model analysis rejected: cited unknown evidence ${unknown.join(', ')}`] },
      usage: result.usage,
    };
  }

  const diagnosis = { ...result.value };
  const notes = [...baseline.notes, `rule-based baseline: ${baseline.diagnosis.category} (${baseline.diagnosis.confidence})`];
  if (!diagnosis.sufficientEvidence && diagnosis.confidence === 'high') {
    diagnosis.confidence = 'medium';
    notes.push('confidence lowered: the model reported insufficient evidence');
  }
  return { analysis: { ...baseline, diagnosis, method: 'model', notes }, usage: result.usage };
}
