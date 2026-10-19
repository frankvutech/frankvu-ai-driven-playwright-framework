import { test, expect } from '@playwright/test';
import { DatasetError, loadDataset, specHash, verifyPinnedSpecs } from '../../eval/dataset';
import { FunctionalCaseSchema, ProvenanceSchema } from '../../eval/schema';

test.describe('evaluation dataset', () => {
  test('every dataset file validates and the content is fingerprinted', () => {
    const d = loadDataset();
    expect(d.manifest.datasetVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.planning.cases.length).toBeGreaterThanOrEqual(20);
    expect(d.generation.cases.length).toBeGreaterThanOrEqual(19);
    expect(d.functional.suites.length).toBeGreaterThanOrEqual(4);
    expect(d.failures.cases.filter((c) => c.label !== null).length).toBeGreaterThanOrEqual(15);
    expect(d.healing.cases.length).toBeGreaterThanOrEqual(15);
    expect(d.labelReview.total).toBe(d.planning.cases.length + d.generation.cases.length + d.functional.suites.length + d.failures.cases.length + d.healing.cases.length);
  });

  test('the dataset covers the required case categories', () => {
    const d = loadDataset();
    const categories = new Set(d.planning.cases.map((c) => c.category));
    for (const c of ['clear_complete', 'multiple_acceptance_criteria', 'boundary', 'input_validation', 'authorization', 'ambiguous_surfaced', 'missing_acceptance_criteria', 'conflicting_requirement', 'untestable_in_environment', 'unsupported_assumption']) {
      expect(categories, c).toContain(c);
    }
    const types = new Set(d.planning.cases.flatMap((c) => c.expected.scenarioTypes ?? []));
    for (const t of ['positive', 'negative', 'boundary', 'authorization']) expect(types, t).toContain(t);
    const labels = new Set(d.failures.cases.map((c) => c.label).filter(Boolean));
    expect([...labels].sort()).toEqual([...d.failures.categories].sort());
  });

  test('reference outcomes include both defect and defect-free cases', () => {
    const cases = loadDataset().functional.suites.flatMap((s) => Object.values(s.variants).flat());
    expect(cases.filter((c) => c.relevantDefect).length).toBeGreaterThanOrEqual(10);
    expect(cases.filter((c) => !c.relevantDefect).length).toBeGreaterThanOrEqual(10);
  });

  test('a pinned spec that was edited is rejected', () => {
    const suite = structuredClone(loadDataset().functional.suites[0]);
    verifyPinnedSpecs([suite]);
    (suite.specs[0] as { title: string }).title = 'edited';
    expect(() => verifyPinnedSpecs([suite])).toThrow(DatasetError);
    expect(specHash({ a: 1 })).toBe(specHash({ a: 1 }));
  });

  test('a label marked human-reviewed must name the reviewer and date', () => {
    const base = { method: 'author-judgment', author: 'x' };
    expect(ProvenanceSchema.safeParse({ ...base, review: { status: 'pending' } }).success).toBe(true);
    expect(ProvenanceSchema.safeParse({ ...base, review: { status: 'human-reviewed' } }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ ...base, review: { status: 'human-reviewed', reviewer: 'Frank Vu', date: '2026-10-19' } }).success).toBe(true);
  });

  test('functional reference outcomes must be internally consistent', () => {
    expect(FunctionalCaseSchema.safeParse({ scenarioId: 's', relevantDefect: true, defectId: 'D-1', expectedTestOutcome: 'fail' }).success).toBe(true);
    expect(FunctionalCaseSchema.safeParse({ scenarioId: 's', relevantDefect: true, defectId: 'D-1', expectedTestOutcome: 'pass' }).success).toBe(false);
    expect(FunctionalCaseSchema.safeParse({ scenarioId: 's', relevantDefect: false, defectId: 'D-1', expectedTestOutcome: 'pass' }).success).toBe(false);
  });
});
