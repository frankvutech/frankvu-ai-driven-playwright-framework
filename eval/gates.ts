import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Gate, Metric } from './report';

/**
 * Configurable threshold gates. Each gate reads one metric and states its
 * threshold, the modes it applies to, and whether it is provisional. Missing
 * or too-small data is "insufficient-data", never silently a pass; a gate with
 * requireData fails closed on missing data. Safety gates are evaluated and
 * reported separately so no other result can hide them.
 */
export const GateConfigSchema = z
  .object({
    version: z.literal(1),
    note: z.string(),
    gates: z.array(
      z
        .object({
          id: z.string().regex(/^[a-z]+\.[a-z0-9-]+$/),
          metric: z.string(),
          op: z.enum(['>=', '<=', '==']),
          value: z.number(),
          minDenominator: z.number().int().positive().optional(),
          modes: z.array(z.enum(['deterministic', 'functional', 'live', 'healing'])).min(1),
          severity: z.enum(['safety', 'quality', 'cost']),
          requireData: z.boolean(),
          provisional: z.boolean(),
          rationale: z.string().min(10),
        })
        .strict(),
    ),
  })
  .strict();
export type GateConfig = z.infer<typeof GateConfigSchema>;

export function loadGateConfig(file?: string): GateConfig {
  return GateConfigSchema.parse(JSON.parse(readFileSync(file ?? path.join(__dirname, 'gates.json'), 'utf8')));
}

const compare = (op: '>=' | '<=' | '==', a: number, b: number) => (op === '>=' ? a >= b - 1e-12 : op === '<=' ? a <= b + 1e-12 : Math.abs(a - b) < 1e-12);

export function evaluateGates(config: GateConfig, mode: string, metrics: Metric[]): Gate[] {
  const byId = new Map(metrics.map((m) => [m.id, m]));
  return config.gates
    .filter((g) => (g.modes as string[]).includes(mode))
    .map((g): Gate => {
      const m = byId.get(g.metric);
      const label = `${g.metric} ${g.op} ${g.value}${g.provisional ? ' (provisional)' : ''}`;
      const base = { name: `gate:${g.id}`, severity: g.severity, threshold: label };
      const missing =
        !m ? 'metric not reported' :
        m.value === null ? `metric ${m.status}` :
        m.status === 'unavailable' || m.status === 'not-run' ? `metric ${m.status}` :
        g.minDenominator !== undefined && m.denominator !== undefined && m.denominator < g.minDenominator ? `denominator ${m.denominator} < ${g.minDenominator}` :
        undefined;
      if (missing) {
        return { ...base, status: g.requireData ? 'fail' : 'insufficient-data', detail: `${label}: ${missing}${g.requireData ? ' (data required: fails closed)' : ''}` };
      }
      const ok = compare(g.op, m!.value!, g.value);
      return { ...base, status: ok ? 'pass' : 'fail', detail: `${label}: observed ${m!.value}${m!.denominator !== undefined ? ` (${m!.numerator}/${m!.denominator})` : ''}` };
    });
}
