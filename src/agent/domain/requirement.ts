import { z } from 'zod';

/**
 * Requirement input model. Requirements come from outside the repository
 * (tickets, docs, people), so they are validated at runtime and treated as
 * untrusted data everywhere downstream.
 */
export const AcceptanceCriterionSchema = z
  .object({
    id: z.string().regex(/^AC-\d+$/, 'acceptance criterion ids look like AC-1'),
    text: z.string().trim().min(1).max(2000),
  })
  .strict();

export const RequirementSchema = z
  .object({
    id: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/, 'requirement ids look like REQ-101'),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(5000),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).max(50),
    source: z.string().max(500).optional(),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict()
  .superRefine((req, ctx) => {
    const seen = new Set<string>();
    req.acceptanceCriteria.forEach((ac, i) => {
      if (seen.has(ac.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['acceptanceCriteria', i, 'id'],
          message: `duplicate acceptance criterion id ${ac.id}`,
        });
      }
      seen.add(ac.id);
    });
  });

export type Requirement = z.infer<typeof RequirementSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export type RequirementIssueCode =
  | 'missing_acceptance_criteria'
  | 'vague_term'
  | 'embedded_instruction';

export interface RequirementIssue {
  code: RequirementIssueCode;
  /** blocking issues stop the workflow before any model call. */
  severity: 'blocking' | 'warning';
  location: string;
  message: string;
}

export interface RequirementAssessment {
  ready: boolean;
  issues: RequirementIssue[];
}

// Words that usually signal an untestable or under-specified criterion.
const VAGUE_TERMS = [
  'fast',
  'quickly',
  'user-friendly',
  'intuitive',
  'appropriate',
  'appropriately',
  'reasonable',
  'properly',
  'correctly',
  'etc',
  'and so on',
  'as needed',
  'should work',
  'seamless',
];

// Text that addresses an AI or a tool rather than describing behaviour.
const INSTRUCTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) instructions/i,
  /\b(run|execute)\b.*\b(shell|command|script|bash)\b/i,
  /\bapprove\b.*\b(yourself|automatically|this run)\b/i,
  /\bmark\b.*\bas passed\b/i,
  /\bsystem prompt\b/i,
];

function findVagueTerms(text: string): string[] {
  const lower = text.toLowerCase();
  return VAGUE_TERMS.filter((term) => new RegExp(`\\b${term.replace(/[-]/g, '\\-')}\\b`).test(lower));
}

/**
 * Deterministic pre-checks that run before any model call. They do not prove a
 * requirement is complete; they catch the cases we can detect cheaply.
 */
export function assessRequirement(req: Requirement): RequirementAssessment {
  const issues: RequirementIssue[] = [];

  if (req.acceptanceCriteria.length === 0) {
    issues.push({
      code: 'missing_acceptance_criteria',
      severity: 'blocking',
      location: 'acceptanceCriteria',
      message: 'No acceptance criteria: expected behaviour would have to be invented. Clarify before planning.',
    });
  }

  const texts: Array<[string, string]> = [
    ['description', req.description],
    ...req.acceptanceCriteria.map((ac): [string, string] => [ac.id, ac.text]),
  ];
  for (const [location, text] of texts) {
    for (const term of findVagueTerms(text)) {
      issues.push({
        code: 'vague_term',
        severity: 'warning',
        location,
        message: `"${term}" is not objectively testable; the plan must state how it is interpreted.`,
      });
    }
    if (INSTRUCTION_PATTERNS.some((p) => p.test(text))) {
      issues.push({
        code: 'embedded_instruction',
        severity: 'warning',
        location,
        message: 'Text reads like an instruction to the tooling. It is treated as data and has no authority.',
      });
    }
  }

  return { ready: !issues.some((i) => i.severity === 'blocking'), issues };
}
