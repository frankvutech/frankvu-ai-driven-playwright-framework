import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Requirement } from '../domain/requirement';
import { transition } from '../domain/state';
import { GenerationOutputSchema } from '../domain/testSpec';
import { isAcceptableApprover } from '../execution/approval';
import { sha256File } from '../execution/files';
import { PROMOTED_DIR, familyOf, renderSpec } from '../generation/render';
import { PROMOTED_IMPORTS, astFindings, lintFindings, typecheckFindings } from '../validation/artifacts';
import type { RunManifest, RunStore } from './store';
import { writeReport } from './report';

export interface PromotionResult {
  manifest: RunManifest;
  promoted: Array<{ scenarioId: string; file: string }>;
  skipped: Array<{ scenarioId: string; reason: string }>;
}

/**
 * Copy passed candidate tests into the trusted regression suite. Entry point:
 * the interactive `promote` CLI command; no workflow calls it. It only adds
 * new files (never overwrites), re-renders them with the ordinary fixtures,
 * re-runs the static checks, and does not commit anything.
 */
export async function promoteRun(store: RunStore, approver: string, now = new Date()): Promise<PromotionResult> {
  if (!isAcceptableApprover(approver)) throw new Error(`"${approver}" is not an acceptable human approver`);
  const manifest = store.manifest();
  const req = store.read<Requirement>('requirement.json');
  const generation = GenerationOutputSchema.parse(store.read('generation.json'));
  if (!req) throw new Error(`run ${manifest.runId} has no requirement`);
  const app = req.application ?? 'storefront';
  const promoted: PromotionResult['promoted'] = [];
  const skipped: PromotionResult['skipped'] = [];

  for (const artifact of manifest.artifacts) {
    if (artifact.state !== 'passed') {
      if (artifact.state !== 'promoted') skipped.push({ scenarioId: artifact.scenarioId, reason: `${artifact.state}, only passed tests can be promoted` });
      continue;
    }
    const candidate = path.join(store.repoRoot, artifact.file);
    if (!existsSync(candidate) || sha256File(candidate) !== artifact.sha256) {
      skipped.push({ scenarioId: artifact.scenarioId, reason: 'the candidate file changed after approval' });
      continue;
    }
    const spec = generation.tests.find((t) => t.scenarioId === artifact.scenarioId);
    if (!spec) {
      skipped.push({ scenarioId: artifact.scenarioId, reason: 'no spec recorded for this scenario' });
      continue;
    }
    const rel = path.posix.join(PROMOTED_DIR[familyOf(app, spec.layer)], `${spec.scenarioId}.spec.ts`);
    const abs = path.join(store.repoRoot, rel);
    if (existsSync(abs)) {
      skipped.push({ scenarioId: artifact.scenarioId, reason: `${rel} already exists; promotion never overwrites` });
      continue;
    }
    const source = renderSpec(spec, manifest.runId, {
      application: app,
      mode: 'promoted',
      provenance: [
        `Promoted from agent run ${manifest.runId} by ${approver} on ${now.toISOString().slice(0, 10)}.`,
        `Requirement ${spec.requirementId} / scenario ${spec.scenarioId}. Candidate sha256 ${artifact.sha256.slice(0, 16)}.`,
        'Generated from a reviewed spec; edit it like any other test.',
      ],
    });
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, source);
    const findings = [
      ...astFindings(rel, source, { requirementId: spec.requirementId, scenarioId: spec.scenarioId }, PROMOTED_IMPORTS),
      ...typecheckFindings(store.repoRoot, [abs]),
      ...(await lintFindings(store.repoRoot, [abs])),
    ];
    if (findings.length > 0) {
      rmSync(abs);
      skipped.push({ scenarioId: artifact.scenarioId, reason: `static checks failed: ${findings.map((f) => f.message).join('; ')}` });
      continue;
    }
    promoted.push({ scenarioId: artifact.scenarioId, file: rel });
    manifest.artifacts = manifest.artifacts.map((a) =>
      a === artifact ? transition(a, 'promoted', { kind: 'human', name: approver }, `promoted to ${rel}`, now) : a,
    );
  }
  manifest.steps.push({ step: 'promote', status: promoted.length > 0 ? 'ok' : 'skipped', at: now.toISOString(), detail: `${promoted.length} promoted by ${approver}, ${skipped.length} skipped` });
  store.write('manifest.json', manifest);
  writeReport(store);
  return { manifest, promoted, skipped };
}
