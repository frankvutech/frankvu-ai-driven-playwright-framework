import { readFileSync } from 'node:fs';
import { ReportSchema, type EvaluationReport, type Metric } from './report';

export interface MetricChange {
  id: string;
  kind: Metric['kind'];
  gate: Metric['gate'];
  before: number | null;
  after: number | null;
  delta: number | null;
  direction: 'improved' | 'regressed' | 'unchanged' | 'changed' | 'added' | 'removed' | 'not-comparable';
}

export interface Comparison {
  before: { runId: string; datasetVersion: string; commit: string; mode: string };
  after: { runId: string; datasetVersion: string; commit: string; mode: string };
  comparable: boolean;
  notes: string[];
  changes: MetricChange[];
  gatedRegressions: MetricChange[];
}

const EPSILON = 1e-9;

/**
 * Compare two evaluation reports metric by metric. It reports what changed;
 * it does not claim statistical significance.
 */
export function compareReports(before: EvaluationReport, after: EvaluationReport): Comparison {
  const notes: string[] = [];
  if (before.metadata.mode !== after.metadata.mode) notes.push(`different modes (${before.metadata.mode} vs ${after.metadata.mode}): only shared metrics are compared`);
  if (before.metadata.datasetVersion !== after.metadata.datasetVersion) notes.push(`dataset changed ${before.metadata.datasetVersion} -> ${after.metadata.datasetVersion}: differences may come from the dataset`);
  else if (before.metadata.datasetSha256 !== after.metadata.datasetSha256) notes.push('same dataset version but different content hash: the dataset was edited without a version bump');
  if (before.metadata.metricVersion !== after.metadata.metricVersion) notes.push(`metric implementation changed ${before.metadata.metricVersion} -> ${after.metadata.metricVersion}`);
  if (before.metadata.provider.model !== after.metadata.provider.model) notes.push(`model changed ${before.metadata.provider.model} -> ${after.metadata.provider.model}`);

  const b = new Map(before.metrics.map((m) => [m.id, m]));
  const a = new Map(after.metrics.map((m) => [m.id, m]));
  const ids = [...new Set([...b.keys(), ...a.keys()])].sort();
  const changes: MetricChange[] = ids.map((id) => {
    const x = b.get(id);
    const y = a.get(id);
    const base = { id, kind: (y ?? x)!.kind, gate: (x ?? y)!.gate, before: x?.value ?? null, after: y?.value ?? null };
    if (!x) return { ...base, delta: null, direction: 'added' };
    if (!y) return { ...base, delta: null, direction: 'removed' };
    if (x.value === null || y.value === null) return { ...base, delta: null, direction: x.value === y.value ? 'unchanged' : 'not-comparable' };
    const delta = y.value - x.value;
    if (Math.abs(delta) < EPSILON) return { ...base, delta: 0, direction: 'unchanged' };
    const hib = y.higherIsBetter;
    const direction = hib === null ? 'changed' : (delta > 0) === hib ? 'improved' : 'regressed';
    return { ...base, delta, direction };
  });
  return {
    before: { runId: before.metadata.runId, datasetVersion: before.metadata.datasetVersion, commit: before.metadata.agent.commit, mode: before.metadata.mode },
    after: { runId: after.metadata.runId, datasetVersion: after.metadata.datasetVersion, commit: after.metadata.agent.commit, mode: after.metadata.mode },
    comparable: before.metadata.mode === after.metadata.mode,
    notes,
    changes,
    // The baseline decides the gate, so a run cannot loosen its own gates.
    gatedRegressions: changes.filter(
      (c) =>
        (c.gate === 'exact' && c.direction !== 'unchanged' && c.direction !== 'added') ||
        (c.gate === 'no-regression' && (c.direction === 'regressed' || c.direction === 'removed' || c.direction === 'not-comparable')),
    ),
  };
}

export function loadReport(file: string): EvaluationReport {
  return ReportSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function renderComparison(c: Comparison): string {
  const lines = [`Compare ${c.before.runId} (${c.before.commit.slice(0, 10)}) -> ${c.after.runId} (${c.after.commit.slice(0, 10)})`];
  for (const n of c.notes) lines.push(`note: ${n}`);
  for (const ch of c.changes.filter((x) => x.direction !== 'unchanged')) {
    lines.push(`${ch.direction.padEnd(14)} ${ch.id.padEnd(58)} ${ch.before ?? '-'} -> ${ch.after ?? '-'}${ch.gate !== 'none' ? `  [gate: ${ch.gate}]` : ''}`);
  }
  lines.push(`${c.changes.filter((x) => x.direction === 'unchanged').length} unchanged, ${c.gatedRegressions.length} gated regression(s)`);
  return lines.join('\n');
}
