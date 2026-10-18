import type { Observation } from '../analysis/types';
import { FAILURE_CATEGORIES } from '../analysis/types';
import { DATA_RULE, JSON_RULE, asData } from './common';

export const ANALYZE_SYSTEM = `You review one failed automated test and give an advisory diagnosis.

Rules:
- Observations are facts recorded by the test runner. Your explanation is a hypothesis; label it as such and cite the observation ids it relies on in "evidenceIds". Cite only ids that exist.
- category is one of: ${FAILURE_CATEGORIES.join(', ')}. Use "inconclusive" when the evidence does not support a single explanation.
- A timeout alone does not prove a product defect. A failed assertion alone does not tell you whether the product or the test is wrong.
- Give alternatives when another category is plausible, and set sufficientEvidence to false when a human must investigate further.
- Do not propose removing or weakening assertions.
- ${DATA_RULE}
- ${JSON_RULE}`;

export function analyzePrompt(context: { testTitle: string; scenario?: unknown; acceptanceCriteria?: unknown }, observations: Observation[]): string {
  return [asData('test', context), asData('observations', observations)].join('\n\n');
}
