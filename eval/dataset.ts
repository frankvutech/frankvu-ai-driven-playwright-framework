import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  FailureDatasetSchema,
  FunctionalDatasetSchema,
  GenerationCaseSchema,
  HealingDatasetSchema,
  ManifestSchema,
  PlanningCaseSchema,
  type Provenance,
} from './schema';

export const DATASET_DIR = path.join(__dirname, 'dataset');

export class DatasetError extends Error {}

function parse<T>(file: string, schema: z.ZodType<T>): T {
  const raw = JSON.parse(readFileSync(path.join(DATASET_DIR, file), 'utf8'));
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new DatasetError(`${file} is invalid:\n  ${issues.join('\n  ')}`);
  }
  return result.data;
}

/** Load and validate every dataset file, and fingerprint the content. */
export function loadDataset() {
  const manifest = parse('manifest.json', ManifestSchema);
  const planning = parse(manifest.files.planning, z.object({ provenance: z.string(), cases: z.array(PlanningCaseSchema) }).strict());
  const generation = parse(manifest.files.generation, z.object({ provenance: z.string(), cases: z.array(GenerationCaseSchema) }).strict());
  const functional = parse(manifest.files.functional, FunctionalDatasetSchema);
  const failures = parse(manifest.files.failures, FailureDatasetSchema);
  const healing = parse(manifest.files.healing, HealingDatasetSchema);

  const ids = [...planning.cases, ...generation.cases, ...healing.cases].map((c) => c.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new DatasetError(`duplicate case id ${dup}`);
  verifyPinnedSpecs(functional.suites);
  for (const c of healing.cases) {
    if (c.target.kind === 'generated') {
      const target = c.target;
      const suite = functional.suites.find((s) => s.id === target.suite);
      if (!suite?.specs.some((s) => s.scenarioId === target.scenarioId)) throw new DatasetError(`${c.id}: ${target.suite}/${target.scenarioId} is not a functional spec`);
    }
  }
  for (const report of new Set(failures.cases.map((c) => c.report))) {
    JSON.parse(readFileSync(path.join(DATASET_DIR, 'failures', report), 'utf8'));
  }

  const files = [
    'manifest.json',
    manifest.files.planning,
    manifest.files.generation,
    manifest.files.functional,
    manifest.files.failures,
    manifest.files.healing,
    ...[...new Set(failures.cases.map((c) => path.posix.join('failures', c.report)))],
  ].sort();
  const hash = createHash('sha256');
  for (const f of files) hash.update(f).update('\0').update(readFileSync(path.join(DATASET_DIR, f)));

  const provenance: Provenance[] = [
    ...planning.cases.map((c) => c.labels),
    ...generation.cases.map((c) => c.labels),
    ...functional.suites.map((s) => s.labels),
    ...failures.cases.map((c) => c.provenance),
    ...healing.cases.map((c) => c.labels),
  ];
  return {
    manifest,
    planning,
    generation,
    functional,
    failures,
    healing,
    sha256: hash.digest('hex'),
    labelReview: {
      total: provenance.length,
      humanReviewed: provenance.filter((p) => p.review.status === 'human-reviewed').length,
      byMethod: Object.fromEntries(['constructed', 'observed-controlled-variation', 'author-judgment'].map((m) => [m, provenance.filter((p) => p.method === m).length])),
    },
  };
}

export type Dataset = ReturnType<typeof loadDataset>;

/** Every functional spec must match the sha256 pinned next to it in the dataset. */
export function verifyPinnedSpecs(suites: Array<{ id: string; specs: Array<{ scenarioId: string }>; specSha256: Record<string, string> }>): void {
  for (const suite of suites) {
    for (const spec of suite.specs) {
      if (suite.specSha256[spec.scenarioId] !== specHash(spec)) throw new DatasetError(`${suite.id}: spec ${spec.scenarioId} does not match its pinned sha256`);
    }
  }
}

/** Canonical hash of a spec as stored in the dataset (compact JSON, key order as written). */
export function specHash(spec: unknown): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}
