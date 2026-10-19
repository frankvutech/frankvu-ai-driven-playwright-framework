import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { classifyFailure } from '../analysis/classify';
import type { FailureAnalysis } from '../analysis/types';
import type { ApplicationId } from '../domain/application';
import type { Requirement } from '../domain/requirement';
import type { TestPlan } from '../domain/plan';
import type { TestEvidence } from '../domain/result';
import { GenerationOutputSchema, TestSpecSchema, type Step, type TestSpec } from '../domain/testSpec';
import { agentProjectFor, type Spawner } from '../execution/adapter';
import { isAcceptableApprover } from '../execution/approval';
import { resolveInside, sha256File } from '../execution/files';
import type { Policy } from '../execution/policy';
import { ALL_PAGE_FIXTURES, CATALOG, NOTES_UI_CATALOG } from '../generation/catalog';
import { renderSpecWithMap } from '../generation/render';
import { validateSpec } from '../generation/validateSpec';
import type { LlmProvider } from '../llm/provider';
import { callStructured, DEFAULT_RETRY_POLICY, type RetryPolicy } from '../llm/structured';
import { HEAL_SYSTEM, healPrompt } from '../prompts/heal';
import { astFindings, lintFindings, typecheckFindings } from '../validation/artifacts';
import { RunStore } from '../workflow/store';
import { applyLocatorChange, findMemberLocator, normalizeLocator, snapshotSupports } from './locators';
import { HealProposalSchema, type Check, type HealOutcome, type HealRecord, type HealTarget, type TestRunSummary } from './types';
import { createWorkspace, runInWorkspace, unifiedDiff, type WorkspaceRun, type WorkspaceRunResult } from './workspace';

export const HEALS_AREA = '.agent/heals';
export const HEAL_ID_PATTERN = /^heal-[0-9]{8}T[0-9]{6}Z-[a-z0-9]{6}$/;

export interface HealDeps {
  repoRoot: string;
  policy: Policy;
  env: NodeJS.ProcessEnv;
  /** Needed only if the deterministic gate lets the attempt reach the proposal step. */
  provider?: LlmProvider;
  exampleAppVariant?: string;
  sessionVariant?: string;
  /** Override bounded run counts (within policy limits), e.g. to keep tests fast. */
  reproduceRuns?: number;
  verifyRuns?: number;
  retryPolicy?: RetryPolicy;
  spawner?: Spawner;
  now?: () => Date;
  healId?: string;
  /** Test seam: replaces Playwright runs in unit tests. */
  runTests?: (run: WorkspaceRun) => Promise<WorkspaceRunResult>;
}

/** Page-object classes a locator repair may touch, with their source files. */
export function pageObjectSources(): Record<string, string> {
  const out: Record<string, string> = { HeaderComponent: 'src/components/HeaderComponent.ts' };
  for (const spec of Object.values(ALL_PAGE_FIXTURES)) out[spec.className] = spec.source;
  return out;
}

/** Trusted page objects of one application, for the model's context and regression scope. */
function appOf(testFile: string, generatedApp?: ApplicationId): ApplicationId {
  if (generatedApp) return generatedApp;
  if (testFile.startsWith('tests/ui/')) return 'storefront';
  if (testFile.startsWith('tests/integration/')) return 'notes';
  return testFile.includes('posts') ? 'posts' : 'notes';
}
const REGRESSION_PROJECT: Record<ApplicationId, string | undefined> = { storefront: 'ui-chromium', notes: 'integration', posts: undefined };
const TRUSTED_PROJECT: Record<string, string> = { 'tests/ui/': 'ui-chromium', 'tests/api/': 'api', 'tests/integration/': 'integration' };

export function newHealId(now = new Date(), random = Math.random): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `heal-${stamp}-${Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(random() * 36)]).join('')}`;
}

export function healDir(repoRoot: string, healId: string): string {
  if (!HEAL_ID_PATTERN.test(healId)) throw new Error(`invalid heal id "${healId}"`);
  return path.join(repoRoot, HEALS_AREA, healId);
}

export function readHealRecord(repoRoot: string, healId: string): HealRecord {
  const file = path.join(healDir(repoRoot, healId), 'heal-record.json');
  if (!existsSync(file)) throw new Error(`heal ${healId} has no record`);
  return JSON.parse(readFileSync(file, 'utf8')) as HealRecord;
}

export function listHeals(repoRoot: string): Array<{ healId: string; outcome: HealOutcome }> {
  const dir = path.join(repoRoot, HEALS_AREA);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => HEAL_ID_PATTERN.test(d) && existsSync(path.join(dir, d, 'heal-record.json')))
    .sort()
    .map((healId) => ({ healId, outcome: readHealRecord(repoRoot, healId).outcome }));
}

interface ResolvedTarget {
  kind: 'trusted' | 'generated';
  testFile: string;
  project: string;
  title?: string;
  app: ApplicationId;
  spec?: TestSpec;
  acceptanceCriteriaText?: string;
  extraPaths: string[];
}

function resolveTargetTest(target: HealTarget, deps: HealDeps): ResolvedTarget {
  if (target.kind === 'trusted') {
    const file = path.posix.normalize(target.file.split(path.sep).join('/'));
    const prefix = Object.keys(TRUSTED_PROJECT).find((p) => file.startsWith(p));
    if (!prefix || !file.endsWith('.spec.ts')) throw new Error('trusted heal targets must be .spec.ts files under tests/ui, tests/api or tests/integration');
    const resolved = resolveInside(deps.repoRoot, 'tests', file);
    if (!resolved.ok) throw new Error(resolved.reason);
    return { kind: 'trusted', testFile: file, project: TRUSTED_PROJECT[prefix], title: target.title, app: appOf(file), extraPaths: [] };
  }
  const store = new RunStore(deps.repoRoot, deps.policy.runsArea, target.runId);
  const artifact = store.manifest().artifacts.find((a) => a.scenarioId === target.scenarioId);
  if (!artifact) throw new Error(`run ${target.runId} has no artifact for ${target.scenarioId}`);
  if (artifact.state !== 'failed') throw new Error(`${target.scenarioId} is ${artifact.state}; only executed tests that failed can be healed`);
  const req = store.read<Requirement>('requirement.json');
  const plan = store.read<TestPlan>('plan.json');
  const generation = GenerationOutputSchema.parse(store.read('generation.json'));
  const spec = generation.tests.find((t) => t.scenarioId === target.scenarioId);
  if (!req || !spec) throw new Error(`run ${target.runId} is missing its requirement or spec`);
  const scenario = plan?.scenarios.find((s) => s.id === target.scenarioId);
  return {
    kind: 'generated',
    testFile: artifact.file,
    project: agentProjectFor(artifact.file),
    app: req.application ?? 'storefront',
    spec: TestSpecSchema.parse(spec),
    acceptanceCriteriaText: req.acceptanceCriteria.filter((ac) => scenario?.acceptanceCriteriaIds.includes(ac.id)).map((ac) => ac.text).join('\n'),
    extraPaths: [path.posix.dirname(artifact.file)],
  };
}

/** Index of the spec step whose rendered line failed, from the error location or stack. */
export function failingStepIndex(test: TestEvidence, testFile: string, stepLines: number[]): number | undefined {
  const name = testFile.split('/').pop()!;
  const errors = test.attempts[test.attempts.length - 1]?.errors ?? [];
  let line: number | undefined;
  for (const e of errors) {
    const fromLocation = e.location?.endsWith(`${name}:${e.location.split(':').pop()}`) ? Number(e.location.split(':').pop()) : undefined;
    const fromStack = new RegExp(`${name.replace(/[.]/g, '\\.')}:(\\d+)(?::\\d+)?`).exec(e.message);
    line = fromLocation ?? (fromStack ? Number(fromStack[1]) : undefined);
    if (line !== undefined) break;
  }
  if (line === undefined) return undefined;
  const index = stepLines.findIndex((l) => l >= line!);
  return index === -1 ? undefined : index;
}

const countExpects = (source: string) => (source.match(/\bexpect\(/g) ?? []).length;

/**
 * Guarded healing of one failing test. The deterministic gate decides whether
 * a repair may even be proposed; the model only proposes; deterministic code
 * validates, applies the change in a separate workspace, verifies it with
 * Playwright and writes a reviewable patch. The working tree is never changed.
 */
export async function healTest(target: HealTarget, deps: HealDeps): Promise<HealRecord> {
  const now = deps.now ?? (() => new Date());
  const { policy } = deps;
  const exampleAppVariant = deps.exampleAppVariant ?? 'standard';
  const sessionVariant = deps.sessionVariant ?? 'standard';
  if (!(policy.exampleApp.variants as string[]).includes(exampleAppVariant)) throw new Error(`example-app variant "${exampleAppVariant}" is not in the policy`);
  const session = policy.sessionVariants[sessionVariant];
  if (!session) throw new Error(`session variant "${sessionVariant}" is not in the policy`);
  const bound = (value: number | undefined, max: number) => Math.min(Math.max(1, value ?? max), max);
  const reproduceRuns = bound(deps.reproduceRuns, policy.healing.reproduceRuns);
  const verifyRuns = bound(deps.verifyRuns, policy.healing.verifyRuns);

  const resolved = resolveTargetTest(target, deps);
  const healId = deps.healId ?? newHealId(now());
  const dir = healDir(deps.repoRoot, healId);
  const workspace = createWorkspace(deps.repoRoot, path.join(dir, 'workspace'), resolved.extraPaths);
  const run = deps.runTests ?? ((r: WorkspaceRun) => runInWorkspace(r, { policy, env: deps.env, spawner: deps.spawner }));
  const runSpec = (label: string, repeatEach: number, extra: Partial<WorkspaceRun> = {}): WorkspaceRun => ({
    label,
    workspace,
    kind: resolved.kind,
    project: resolved.project,
    files: [resolved.testFile],
    title: resolved.title,
    repeatEach,
    workers: 1,
    exampleAppVariant,
    sessionUser: session.user,
    ...extra,
  });

  const record: HealRecord = {
    healId,
    createdAt: now().toISOString(),
    target,
    testFile: resolved.testFile,
    project: resolved.project,
    environment: { exampleAppVariant, sessionVariant },
    usage: [],
    validation: [],
    intent: [],
    outcome: 'insufficient_evidence',
    history: [],
  };
  const save = () => {
    writeFileSync(path.join(dir, 'heal-record.json'), JSON.stringify(record, null, 2) + '\n');
    writeFileSync(path.join(dir, 'heal-report.md'), renderHealReport(record));
  };
  const finish = (outcome: HealOutcome, reason: string): HealRecord => {
    record.outcome = outcome;
    record.history.push({ outcome, at: now().toISOString(), reason });
    save();
    return record;
  };

  // 1. Capture: reproduce the failure a bounded number of times.
  const repro = await run(runSpec('reproduce', reproduceRuns));
  record.reproduction = { ...repro.summary, intermittent: repro.summary.failed > 0 && repro.summary.passed > 0 };
  if (!repro.summary.reportFound) return finish('insufficient_evidence', 'the test could not be run: Playwright produced no report');
  if (repro.summary.failed === 0) {
    return finish('insufficient_evidence', `the test did not fail in ${repro.summary.runs} run(s) (${repro.summary.statuses.join(', ') || 'no results'}); there is nothing to repair`);
  }

  // 2. Classify from the evidence of the last failing run.
  const failing = [...repro.evidence.tests].reverse().find((t) => t.project === resolved.project && (resolved.title === undefined || t.title === resolved.title) && ['failed', 'timedOut'].includes(t.status))!;
  const analysis: FailureAnalysis = classifyFailure(failing, { acceptanceCriteriaText: resolved.acceptanceCriteriaText, repoRoot: workspace }, repro.evidence);
  record.analysis = analysis;

  // 3. Gate: only test-side causes with enough evidence go further.
  const category = analysis.diagnosis.category;
  const snapshotObs = analysis.observations.find((o) => o.source === 'attachment.page-snapshot');
  const stop = (outcome: HealOutcome, reason: string) => {
    record.gate = { decision: 'stop', reason };
    return finish(outcome, reason);
  };
  switch (category) {
    case 'locator':
      if (!snapshotObs) return stop('insufficient_evidence', 'locator failure, but no page snapshot was captured to identify the intended element');
      record.gate = { decision: 'locator_repair', reason: 'the locator matched no element and a page snapshot is available' };
      break;
    case 'timeout_sync':
      if (resolved.kind !== 'generated') {
        return stop('not_applicable', 'timing failure in a hand-written test: automatic repairs only add waits to generated tests; reported for a person');
      }
      record.gate = { decision: 'wait_repair', reason: 'the element appeared too late for the assertion; a bounded condition-based wait may fix it' };
      break;
    case 'product_behavior':
    case 'api_contract':
      return stop('not_applicable', `classified as ${category}: a possible product defect or contract change is never auto-healed`);
    case 'assertion_logic':
      return stop('not_applicable', 'the expectation itself is in question; changing expected values is not a repair the agent may make');
    case 'test_data_setup':
      return stop('not_applicable', 'test-data or setup problem: identified and reported, not repaired automatically');
    case 'environment':
    case 'infrastructure':
      return stop('not_applicable', `classified as ${category}: not a defect in the test`);
    default:
      return stop('insufficient_evidence', 'the evidence does not identify a cause');
  }

  // 4. Proposal from the model.
  if (!deps.provider) return finish('proposal_failed', 'no AI provider configured for healing');
  const sources = pageObjectSources();
  const appPages = Object.values(resolved.app === 'storefront' ? CATALOG : resolved.app === 'notes' ? NOTES_UI_CATALOG : {});
  const pageObjects =
    record.gate.decision === 'locator_repair'
      ? Object.fromEntries(
          [...appPages.map((p) => p.className), ...(resolved.app === 'storefront' ? ['HeaderComponent'] : [])].map((c) => [c, readFileSync(path.join(workspace, sources[c]), 'utf8')]),
        )
      : undefined;
  const rendered = resolved.spec ? renderSpecWithMap(resolved.spec, (target as { runId?: string }).runId ?? '', { application: resolved.app }) : undefined;
  const stepIndex = rendered ? failingStepIndex(failing, resolved.testFile, rendered.stepLines) : undefined;
  const proposalResult = await callStructured(
    deps.provider,
    {
      useCase: 'heal-proposal',
      system: HEAL_SYSTEM,
      prompt: healPrompt({
        allowedChanges: record.gate.decision === 'locator_repair' ? ['replaceLocator'] : ['addWait'],
        maxChanges: policy.healing.maxChanges,
        maxWaitTimeoutMs: policy.healing.maxWaitTimeoutMs,
        test: { file: resolved.testFile, title: failing.title, failingStepIndex: stepIndex, reproduction: record.reproduction },
        observations: analysis.observations,
        diagnosis: analysis.diagnosis,
        pageObjects,
        spec: resolved.spec ? resolved.spec.steps.map((step, index) => ({ index, ...step })) : undefined,
      }),
      maxTokens: 8000,
    },
    HealProposalSchema,
    deps.retryPolicy ?? DEFAULT_RETRY_POLICY,
  );
  record.usage.push(proposalResult.usage);
  if (!proposalResult.ok) return finish('proposal_failed', `${proposalResult.kind}: ${proposalResult.detail}`);
  const proposal = proposalResult.value;
  record.proposal = proposal;
  if (proposal.decision === 'decline' || proposal.changes.length === 0) {
    return finish('insufficient_evidence', `the model declined to propose a repair: ${proposal.failureExplanation.slice(0, 300)}`);
  }
  record.history.push({ outcome: 'proposal_generated', at: now().toISOString(), reason: `${proposal.changes.length} change(s) proposed` });

  // 5. Validate and apply in the workspace.
  const check = (name: string, ok: boolean, detail: string) => record.validation.push({ name, ok, detail });
  const known = new Set(analysis.observations.map((o) => o.id));
  const unknownIds = proposal.evidenceIds.filter((id) => !known.has(id));
  check('evidence-ids', unknownIds.length === 0, unknownIds.length ? `cites unknown evidence ${unknownIds.join(', ')}` : 'all cited evidence exists');
  check('change-count', proposal.changes.length <= policy.healing.maxChanges, `${proposal.changes.length} change(s), policy allows ${policy.healing.maxChanges}`);
  const allowedKind = record.gate.decision === 'locator_repair' ? 'replaceLocator' : 'addWait';
  const wrongKind = proposal.changes.filter((c) => c.kind !== allowedKind);
  check('change-kinds', wrongKind.length === 0, wrongKind.length ? `${wrongKind.map((c) => c.kind).join(', ')} not allowed for a ${record.gate.decision}` : `only ${allowedKind}`);

  const originals = new Map<string, string>();
  const patched = new Map<string, string>();
  const errorText = normalizeLocator(analysis.observations.filter((o) => o.source.startsWith('error[')).map((o) => o.text).join('\n'));
  for (const change of proposal.changes) {
    // Kinds the gate did not allow were already reported by the change-kinds check; never apply them.
    if (change.kind !== allowedKind) continue;
    if (change.kind === 'replaceLocator') {
      const source = sources[change.pageObject];
      const inRoots = source !== undefined && policy.healing.patchableRoots.some((r) => source.startsWith(r));
      check(`target:${change.pageObject}.${change.member}`, inRoots, inRoots ? `${source} may be patched` : `${change.pageObject} is not a page or component object the policy allows patching`);
      if (!inRoots) continue;
      const current = patched.get(source) ?? readFileSync(path.join(workspace, source), 'utf8');
      if (!originals.has(source)) originals.set(source, current);
      const member = findMemberLocator(current, change.pageObject, change.member);
      if ('error' in member) {
        check(`locator:${change.member}`, false, member.error);
        continue;
      }
      const isFailing = errorText.includes(normalizeLocator(member.call));
      check(`failing-locator:${change.member}`, isFailing, isFailing ? `the failure waited for ${member.call}` : `the failure does not involve ${change.pageObject}.${change.member} (${member.call})`);
      const sameRole = member.role === undefined || change.locator.by !== 'role' || change.locator.role === member.role;
      check(`same-role:${change.member}`, sameRole, sameRole ? 'role unchanged' : `role changed from ${member.role} to ${change.locator.by === 'role' ? change.locator.role : ''}`);
      const support = snapshotSupports(change.locator, snapshotObs!.text);
      check(`snapshot-evidence:${change.member}`, support.ok, support.detail);
      check('cites-snapshot', proposal.evidenceIds.includes(snapshotObs!.id), proposal.evidenceIds.includes(snapshotObs!.id) ? 'the page snapshot is cited' : 'a locator repair must cite the page snapshot');
      const applied = applyLocatorChange(current, change.pageObject, change.member, change.locator);
      if ('error' in applied) {
        check(`apply:${change.member}`, false, applied.error);
        continue;
      }
      check(`apply:${change.member}`, true, `${applied.before} -> ${applied.after}`);
      patched.set(source, applied.source);
    }
  }

  const waits = allowedKind === 'addWait' ? proposal.changes.filter((c) => c.kind === 'addWait') : [];
  if (waits.length > 0 && resolved.spec && rendered) {
    const original = resolved.spec;
    const steps: Step[] = [...original.steps];
    const inserted: number[] = [];
    for (const w of [...waits].sort((a, b) => b.beforeStep - a.beforeStep)) {
      const withinBounds = w.timeoutMs <= policy.healing.maxWaitTimeoutMs;
      check('wait-timeout', withinBounds, `${w.timeoutMs}ms, policy allows ${policy.healing.maxWaitTimeoutMs}ms`);
      const beforeFailure = stepIndex !== undefined && w.beforeStep <= stepIndex;
      check('wait-position', beforeFailure, beforeFailure ? `before step ${w.beforeStep} (failing step ${stepIndex})` : `step ${w.beforeStep} is not at or before the failing step (${stepIndex ?? 'unknown'})`);
      steps.splice(w.beforeStep, 0, {
        kind: 'expect',
        target: w.target,
        ...(w.locatorArgs ? { locatorArgs: w.locatorArgs } : {}),
        select: 'first',
        matcher: 'toBeVisible',
        expected: null,
        negate: false,
        timeoutMs: w.timeoutMs,
      });
      inserted.push(w.beforeStep);
    }
    const patchedSpec: TestSpec = { ...original, steps };
    const issues = validateSpec(patchedSpec, new Set([original.scenarioId]), original.requirementId, { application: resolved.app }).filter((i) => i.severity === 'error');
    check('patched-spec', issues.length === 0, issues.length ? issues.map((i) => i.message).join('; ') : 'the patched spec passes catalog validation');
    // Assertion preservation: removing the inserted waits must give back the original test exactly.
    const insertedAt = [...inserted].sort((a, b) => a - b).map((beforeStep, j) => beforeStep + j);
    const withoutWaits = steps.filter((_, i) => !insertedAt.includes(i));
    const preserved = JSON.stringify(withoutWaits) === JSON.stringify(original.steps);
    record.intent.push({ name: 'assertions-preserved', ok: preserved, detail: preserved ? 'every original step, assertion and expected value is unchanged and in order' : 'the original steps were changed' });
    const runId = (target as { runId: string }).runId;
    const source = renderSpecWithMap(patchedSpec, runId, { application: resolved.app }).source;
    originals.set(resolved.testFile, readFileSync(path.join(workspace, resolved.testFile), 'utf8'));
    patched.set(resolved.testFile, source);
    writeFileSync(path.join(dir, 'patched-spec.json'), JSON.stringify(patchedSpec, null, 2) + '\n');
  }

  for (const [file, source] of patched) writeFileSync(path.join(workspace, file), source);
  const changedFiles = [...patched.keys()].sort();
  const testChanged = changedFiles.includes(resolved.testFile);
  const outside = changedFiles.filter((f) => f !== resolved.testFile && !policy.healing.patchableRoots.some((r) => f.startsWith(r)));
  check('changed-files', changedFiles.length > 0 && outside.length === 0, changedFiles.length === 0 ? 'nothing was changed' : outside.length ? `outside the allowed areas: ${outside.join(', ')}` : changedFiles.join(', '));

  // Intent: the test's assertions are untouched (page-object repairs), or only waits were added (generated tests).
  const before = originals.get(resolved.testFile) ?? readFileSync(path.join(deps.repoRoot, resolved.testFile), 'utf8');
  const after = readFileSync(path.join(workspace, resolved.testFile), 'utf8');
  if (!testChanged) {
    const same = sha256(before) === sha256(after);
    record.intent.push({ name: 'test-file-unchanged', ok: same, detail: same ? `${resolved.testFile} is byte-for-byte unchanged` : `${resolved.testFile} changed` });
  }
  const expectBefore = countExpects(before);
  const expectAfter = countExpects(after);
  const expectedAfter = expectBefore + (testChanged ? waits.length : 0);
  record.intent.push({ name: 'assertion-count', ok: expectAfter === expectedAfter, detail: `expect() calls: ${expectBefore} before, ${expectAfter} after${testChanged ? ` (${waits.length} wait(s) added)` : ''}` });

  if (changedFiles.length > 0) {
    const abs = changedFiles.map((f) => path.join(workspace, f));
    const testAbs = path.join(workspace, resolved.testFile);
    const findings = [...typecheckFindings(workspace, [...new Set([...abs, testAbs])]), ...(await lintFindings(workspace, abs))];
    if (testChanged) {
      findings.push(...astFindings(resolved.testFile, after, { requirementId: resolved.spec!.requirementId, scenarioId: resolved.spec!.scenarioId }));
    }
    check('static-checks', findings.length === 0, findings.length ? findings.map((f) => `${f.check} ${f.file ?? ''}:${f.line ?? ''} ${f.message}`).join('; ') : 'typecheck, lint and AST checks pass');
  }

  const failedChecks = [...record.validation, ...record.intent].filter((c) => !c.ok);
  if (failedChecks.length > 0) return finish('validation_failed', failedChecks.map((c) => `${c.name}: ${c.detail}`).join('; '));

  // 6-8. Verify: the patched test passes every run; the affected regression suite gains no new failures.
  const regressionProject = changedFiles.some((f) => f !== resolved.testFile) ? REGRESSION_PROJECT[resolved.app] : undefined;
  let regressionBefore: TestRunSummary | undefined;
  if (regressionProject) {
    for (const [file, source] of originals) writeFileSync(path.join(workspace, file), source);
    regressionBefore = (await run({ ...runSpec('regression-before', 1), kind: 'trusted', project: regressionProject, files: [], title: undefined, workers: 2 })).summary;
    for (const [file, source] of patched) writeFileSync(path.join(workspace, file), source);
  }
  const verification = (await run(runSpec('verify', verifyRuns))).summary;
  record.verification = verification;
  if (!(verification.runs === verifyRuns && verification.passed === verifyRuns)) {
    return finish('verification_failed', `the patched test passed ${verification.passed}/${verification.runs} run(s) (${verification.statuses.join(', ')})`);
  }
  if (regressionProject && regressionBefore) {
    const regressionAfter = (await run({ ...runSpec('regression-after', 1), kind: 'trusted', project: regressionProject, files: [], title: undefined, workers: 2 })).summary;
    const newFailures = regressionAfter.failedTests.filter((t) => !regressionBefore!.failedTests.includes(t));
    record.regression = { scope: `project ${regressionProject} (tests that use the changed page objects)`, before: regressionBefore, after: regressionAfter, newFailures };
    if (!regressionAfter.reportFound || newFailures.length > 0) {
      return finish('verification_failed', newFailures.length ? `the patch breaks: ${newFailures.join('; ')}` : 'the regression run produced no report');
    }
  } else {
    record.regression = { scope: 'the change is confined to the failing generated test; its verification runs are the regression check', newFailures: [] };
  }

  // 9-10. Reviewable patch and evidence record.
  const diff = changedFiles.map((f) => unifiedDiff(deps.repoRoot, workspace, f)).join('');
  const patchFile = path.join(dir, 'patch.diff');
  writeFileSync(patchFile, diff);
  record.patch = { file: path.relative(deps.repoRoot, patchFile).split(path.sep).join('/'), sha256: sha256File(patchFile), changedFiles };
  return finish('verified_pending_review', 'the patch passed validation, verification and regression; it waits for a person to review it');
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Record a human decision on a verified patch. It never applies, commits or
 * pushes the patch; the reviewer applies it with git after reading it.
 */
export function approveHeal(repoRoot: string, healId: string, approver: string, now = new Date()): HealRecord {
  const record = readHealRecord(repoRoot, healId);
  if (record.outcome !== 'verified_pending_review') throw new Error(`heal ${healId} is ${record.outcome}, not verified_pending_review`);
  if (!isAcceptableApprover(approver)) throw new Error(`"${approver}" is not an acceptable human approver`);
  const patchFile = path.join(repoRoot, record.patch!.file);
  if (sha256File(patchFile) !== record.patch!.sha256) throw new Error('patch.diff changed after verification; heal again instead of approving it');
  record.approval = { approver, decidedAt: now.toISOString(), patchSha256: record.patch!.sha256 };
  record.outcome = 'approved';
  record.history.push({ outcome: 'approved', at: now.toISOString(), reason: `approved by ${approver}; not applied` });
  const dir = healDir(repoRoot, healId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'heal-record.json'), JSON.stringify(record, null, 2) + '\n');
  writeFileSync(path.join(dir, 'heal-report.md'), renderHealReport(record));
  return record;
}

export function renderHealReport(r: HealRecord): string {
  const lines: string[] = [`# Heal ${r.healId}`, '', `**Outcome:** ${r.outcome}`, ''];
  const target = r.target.kind === 'trusted' ? `${r.target.file} › ${r.target.title}` : `run ${r.target.runId} / ${r.target.scenarioId}`;
  lines.push(`- Target: ${target} (project ${r.project})`, `- Environment: example-app variant ${r.environment.exampleAppVariant}, session ${r.environment.sessionVariant}`, '');
  if (r.reproduction) {
    lines.push('## Reproduction', '', `${r.reproduction.failed}/${r.reproduction.runs} run(s) failed (${r.reproduction.statuses.join(', ')})${r.reproduction.intermittent ? ' — intermittent' : ''}.`, '');
  }
  if (r.analysis) {
    const d = r.analysis.diagnosis;
    lines.push('## Failure analysis (advisory)', '', `- Category: **${d.category}** (${d.confidence} confidence, ${r.analysis.method})`, `- Hypothesis: ${d.hypothesis}`, `- Evidence: ${d.evidenceIds.join(', ')}`, '');
  }
  if (r.gate) lines.push('## Gate', '', `${r.gate.decision}: ${r.gate.reason}`, '');
  if (r.proposal) {
    lines.push('## Proposal (model output, untrusted until verified)', '', `- Decision: ${r.proposal.decision}`, `- Original failure: ${r.proposal.failureExplanation}`, `- Intended behaviour: ${r.proposal.intendedBehavior}`, `- Cited evidence: ${r.proposal.evidenceIds.join(', ')}`, '');
    for (const c of r.proposal.changes) lines.push(`  - \`${JSON.stringify(c)}\``);
    lines.push('');
  }
  const table = (title: string, checks: Check[]) => {
    if (checks.length === 0) return;
    lines.push(`## ${title}`, '', '| Check | Result | Detail |', '|---|---|---|');
    for (const c of checks) lines.push(`| ${c.name} | ${c.ok ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
    lines.push('');
  };
  table('Validation', r.validation);
  table('Intent preservation', r.intent);
  if (r.verification) lines.push('## Verification', '', `${r.verification.passed}/${r.verification.runs} patched run(s) passed (${r.verification.statuses.join(', ')}).`, '');
  if (r.regression) {
    lines.push('## Regression', '', `Scope: ${r.regression.scope}.`);
    if (r.regression.before && r.regression.after) {
      lines.push(`Before the patch: ${r.regression.before.failedTests.length} failing; after: ${r.regression.after.failedTests.length} failing; new failures: ${r.regression.newFailures.length}.`);
    }
    lines.push('');
  }
  if (r.patch) lines.push('## Patch', '', `\`${r.patch.file}\` (sha256 ${r.patch.sha256.slice(0, 16)}…) changes ${r.patch.changedFiles.join(', ')}.`, 'It has not been applied. After review: `git apply ' + r.patch.file + '`', '');
  if (r.approval) lines.push('## Approval', '', `Approved by ${r.approval.approver} at ${r.approval.decidedAt}. Not applied, committed or pushed by the agent.`, '');
  lines.push('## History', '', ...r.history.map((h) => `- ${h.at} ${h.outcome}: ${h.reason}`), '');
  return lines.join('\n');
}
