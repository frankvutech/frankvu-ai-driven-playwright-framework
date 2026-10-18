# Phase 2 — Relynx AI Test Agent

The agent turns a structured requirement into candidate Playwright tests built on the Phase 1 page objects. It validates them and runs them only after a person approves. It then collects the runner's evidence and gives an advisory analysis of any failures.

What it does not do: write TypeScript freely, approve or merge its own output, retry until green, or run anything against a target that the policy does not list.

## 1. Architecture

```
src/agent/
  domain/        requirement.ts   plan.ts   testSpec.ts   state.ts   result.ts     (typed models + zod schemas)
  llm/           provider.ts (interface)   anthropic.ts (only SDK user)   mock.ts   structured.ts (validation + bounded retry)
  prompts/       plan.ts   generate.ts   analyze.ts   common.ts                     (prompt construction only)
  generation/    catalog.ts (page-object vocabulary)   validateSpec.ts   render.ts (deterministic codegen)
  validation/    artifacts.ts  (path, AST allowlist, tsc, ESLint, workspace check)
  execution/     policy.ts   approval.ts   files.ts   adapter.ts (the only path to a browser)
  evidence/      collect.ts (Playwright JSON -> versioned evidence)   redact.ts
  analysis/      classify.ts (rules)   modelAnalysis.ts (optional, grounded)   types.ts
  workflow/      generate.ts (steps 1-8)   decide.ts (human decision)   execute.ts (steps 9-12)   report.ts   store.ts
  config/llm.ts  cli.ts
src/fixtures/agent.ts        Phase 1 fixtures + an automatic network guard
playwright.agent.config.ts   agent-only Playwright config (approved files only)
relynx.policy.json           protected execution policy
eval/                        dataset, deterministic and live evaluation
```

### How it fits Phase 1

| Phase 1 piece | How Phase 2 uses it |
|---|---|
| Page Object Model (`src/pages`, `HeaderComponent`) | Generated tests can only call members listed in `generation/catalog.ts`. `tests/agent/catalog.spec.ts` checks every entry against the real classes. No new page objects are created. When a scenario needs one, the agent reports a `missingCapabilities` entry for a person to act on. |
| Fixtures (`src/fixtures/test.ts`) | `src/fixtures/agent.ts` extends them with one automatic fixture, `networkGuard`. Generated tests import from there. |
| Auth setup project + storage state | Reused unchanged. The agent config depends on the same `setup` project. |
| Playwright Test runner, reporters | The execution adapter spawns the stock `@playwright/test` CLI. Evidence comes from Playwright's own JSON reporter. |
| `playwright.config.ts` | Gains two projects (`agent-unit`, `agent-integration`) for testing the agent itself. Generated tests are never part of it. |

Patterns used:

- **Adapter**: `AnthropicProvider` behind `LlmProvider`, and the execution adapter in front of the Playwright CLI.
- **Explicit state machine**: `domain/state.ts`.
- **Interpreter/renderer**: the model outputs a declarative spec, and deterministic code renders it.

There is no agent framework, vector store, RAG, multi-agent setup, Screenplay, or custom runner.

## 2. End-to-end workflow

| # | Step | Input → output (files under `.relynx/runs/<runId>/`) | Failure surfaces as |
|---|---|---|---|
| 1 | Receive | requirement JSON → `requirement.input.json` | — |
| 2 | Validate requirement | zod schema + deterministic checks → `requirement.json`, `assessment.json` | `invalid_requirement`; `needs_clarification` (no model call) |
| 3 | Plan | model, `TestPlanSchema` → `plan.json` | `plan_failed` (`malformed_json`, `schema_violation`, `provider_*`) |
| 4 | Validate plan | traceability + coverage → `plan.validation.json` | `plan_rejected` |
| 5 | Surface ambiguities | → `ambiguities.json` (vague terms, open questions, assumptions, uncovered criteria, missing capabilities) | shown in the report |
| 6 | Generate | model, `GenerationOutputSchema` → `generation.json`; catalog check → `spec.validation.json`; rendered files → `generated/<runId>/*.spec.ts` | `generation_failed`; individual specs `rejected` |
| 7 | Validate artifacts | path, AST, type-check, lint, workspace → `artifact.validation.json` | artifacts `rejected` |
| 8 | Request approval | artifacts → `awaiting_approval` | — |
| — | Human decision | `approve` / `reject` CLI → `approval.json` | — |
| 9 | Execute | adapter → Playwright CLI → `playwright-results.json`, `artifacts/` | `execution_refused` |
| 10 | Collect evidence | → `evidence.json` (schema v1) | `reportFound: false` → tests inconclusive |
| 11 | Analyse failures | → `analysis.json` | — |
| 12 | Report | → `report.md`, `report.json`, `llm-usage.json`, `manifest.json` | — |

Bounds:

- One plan call and one generation call per run.
- At most `maxScenariosPerRun` scenarios.
- Transient provider errors are retried at most 3 times in total.
- One execution per run, with `retries: 0` and a hard wall-clock limit.

There is no loop back from results to generation.

## 3. Requirement input schema (`domain/requirement.ts`)

```json
{
  "id": "REQ-101",
  "title": "…",
  "description": "…",
  "acceptanceCriteria": [{ "id": "AC-1", "text": "…" }],
  "source": "optional",
  "metadata": { "optional": "string | number | boolean" }
}
```

Validation rules:

- Unknown fields are rejected.
- Acceptance-criterion ids must be unique.
- Deterministic findings:
  - `missing_acceptance_criteria` blocks the run, before any model call.
  - `vague_term` is a warning ("fast", "appropriately", …).
  - `embedded_instruction` is a warning for text that addresses the tooling. Such text is treated as data and has no authority.

## 4. Test-plan schema (`domain/plan.ts`)

Each scenario has these fields:

- `id` (`REQ-101-SC-01`), `requirementId`, `acceptanceCriteriaIds`
- `title`, `objective`, `type` (`positive | negative | boundary | authorization`)
- `priority` and `priorityRationale`
- `preconditions`, `steps`, `testData`, `expectedOutcomes`
- `assumptions`, `openQuestions`

The plan also lists `ambiguities` and `uncoveredAcceptanceCriteria`.

Plan validation errors:

- a scenario of another requirement
- an unknown criterion
- a duplicate id
- a scenario with no criterion and no stated assumption
- a criterion that was silently left uncovered

Warnings:

- assumption-only scenarios. These are never generated.
- a declared gap
- a vague requirement whose plan lists no ambiguities

## 5. Generated artifact format

The model returns a `TestSpec` (`domain/testSpec.ts`), not code. Steps are:

- `action`: `<fixture>.<method>` with args. An arg is a `literal`, a `data` ref from a fixed list, or a `customer` object with omitted fields.
- `expect`: `<fixture>.<locator>` with one of `toHaveText | toContainText | toBeVisible | toBeHidden | toHaveCount | toHaveValue`.
- `expectUrl`: a path regex.

`validateSpec` rejects:

- anything not in the catalog, or with the wrong argument types
- credentials written as literals
- URL patterns that include a host
- specs without assertions

`render.ts` emits a file like this:

```ts
// @relynx-generated
// Candidate test proposed by the Relynx AI Test Agent. Not reviewed.
import { test, expect } from '../../src/fixtures/agent';
import { SIGNED_OUT } from '../../src/config/auth';
import { users } from '../../src/data/users';

test.use({ storageState: SIGNED_OUT });

test(
  "locked-out user is refused",
  { tag: '@generated', annotation: [
      { type: "requirement", description: "REQ-101" },
      { type: "scenario", description: "REQ-101-SC-02" },
      { type: "relynx-run", description: "<runId>" } ] },
  async ({ loginPage, page }) => {
    await loginPage.goto();
    await loginPage.login(users.lockedOut.username, users.lockedOut.password);
    await expect(loginPage.errorMessage).toHaveText("Epic sadface: Sorry, this user has been locked out.");
    await expect(page).not.toHaveURL(new RegExp("inventory\\.html"));
  },
);
```

Identifiers come only from the catalog. Every model-supplied string goes through `JSON.stringify`, so it cannot leave a string literal. This is tested with a hostile title in `tests/agent/generation.spec.ts`.

## 6. Provider configuration

| Variable | Default | Meaning |
|---|---|---|
| `--provider` (CLI) | none (required) | `anthropic` or `mock` |
| `ANTHROPIC_API_KEY` | — | read by the Anthropic SDK only; never logged or passed to test execution |
| `RELYNX_MODEL` | `claude-opus-5-5` | model id |
| `RELYNX_EFFORT` | `high` | `low…max` |
| `RELYNX_LLM_TIMEOUT_MS` | `180000` | per-attempt timeout |

`AnthropicProvider` works as follows:

- It uses structured outputs (`output_config.format` from the zod schema). The schema is validated again locally.
- SDK retries are off. `structured.ts` owns the single retry policy:
  - 3 attempts, exponential backoff capped at 20 s, honouring `retry-after`.
  - Only timeouts, rate limits, 5xx and network errors are retried.
  - Malformed or schema-invalid output is classified and not retried.
- It enables server-side refusal fallback (`fallbacks: "default"`). A `refusal` or `max_tokens` stop is surfaced as an error.

Usage records hold use case, provider, model, attempts, latency, token counts and outcome. They never hold prompt or response text.

**Not verified:** no Anthropic credentials were available while this was built. The live adapter is type-checked and its error mapping is unit-tested, but it has not made a real API call. Run `npm run eval:live` (or the `Live model evaluation` workflow) to verify it.

## 7. Validation and execution boundaries

Static validation (`validation/artifacts.ts`) runs on every generated file:

1. **Path.** The file must be a regular `.spec.ts` file inside `generated/`. Symlinks, `..` escapes and absolute paths are rejected.
2. **AST allowlist.** The checks are:
   - Imports come only from four framework modules.
   - Top level holds only `import`, `test.use(...)` and `test(...)`.
   - Fixtures come only from the catalog, plus `page` as an `expect(page)` subject.
   - No `require`, `process`, `eval`, dynamic import, computed access or template literals.
   - No `page.*` calls, `.evaluate`, `.route`, `.waitForTimeout`, `.only/.skip`, `expect.soft`, and so on.
   - At least one `expect`.
   - Traceability annotations are present.
3. **Type-check** with the repository `tsconfig.json`, via the TypeScript compiler API.
4. **ESLint** with the repository config, using `eslint-plugin-playwright` (stricter rules for `generated/**`).
5. **Workspace check.** `git status` before and after generation. Any new change outside `generated/` and `.relynx/` rejects the run.

The renderer is the primary control. The checks above are defence in depth, so no single blacklist is the security boundary. They show a file is well-formed and within the rules. They cannot show the test is semantically right.

Execution (`execution/adapter.ts`) runs only when all of these hold:

- the run is `approved_for_execution`
- `approval.json` names an acceptable human
- the sha256 of every approved file, recomputed now, matches the approval
- `UI_BASE_URL` is in `relynx.policy.json` → `approvedTargets` and matches no `blockedHostPatterns`

When those hold, the adapter does this:

- It calls `spawn(process.execPath, [<@playwright/test/cli>, 'test', '--config', 'playwright.agent.config.ts', '--project', 'agent-generated', '--retries', …, '--workers', …, '--timeout', …, ...approvedFiles], { shell: false })`. No model string reaches argv except file paths the agent itself built and the approval covers.
- The child environment contains only `envPassthrough` variables plus the run's paths. The provider key is not passed.
- A wall-clock limit kills the runner's process group, Playwright workers and browsers included: SIGTERM, then SIGKILL after 5 s.

`playwright.agent.config.ts` throws unless the adapter's approved-file list is present and inside `generated/`. Its `testMatch` is exactly those files. The default `npx playwright test` never collects `generated/`.

During the run, the `networkGuard` fixture aborts browser requests to any host other than the configured target.

## 8. Human approval process

```bash
npm run agent -- generate --requirement examples/requirements/REQ-101-sign-in.json --provider mock --mock-replies examples/mock-replies/REQ-101.json
# review generated/<runId>/*.spec.ts and .relynx/runs/<runId>/report.md
npm run agent -- approve <runId> --approver "Your Name"     # interactive: type "approve <digest>"
npm run agent -- reject  <runId> --approver "Your Name" --reason "…"
npm run agent -- execute <runId>
```

How approval is enforced:

- `approve` refuses when stdin/stdout is not a terminal. It shows each file and hash, and needs a typed confirmation that includes a digest of the hashes.
- Names that identify automation (`relynx`, `agent`, `claude`, `ci`, `…[bot]`, …) are rejected.
- The generation and execution workflow modules contain no call that records approval (checked by a test).
- Approval covers exact bytes. Any later edit means the run is refused.

Approval allows one execution of candidates on the test target. It does not accept them into the codebase. To keep a generated test, a person copies it into `tests/`, adapts it, and opens a pull request that goes through normal review and CI. Nothing merges automatically.

## 9. State model

Run status:

```
invalid_requirement | needs_clarification | plan_failed | plan_rejected | generation_failed
| nothing_to_execute | awaiting_approval | approved_for_execution | rejected_by_reviewer | execution_refused | executed
```

Artifact states (`domain/state.ts`):

```
proposed → validated → awaiting_approval → approved → executed → passed | failed | inconclusive
    └────────┴──────────────┴→ rejected
```

Who can move an artifact:

- → `approved` requires a named human.
- → `executed` requires the runner.
- `passed`, `failed` and `inconclusive` can only be produced by `recordOutcome(record, evidence)` from the Playwright evidence. `transition()` refuses them, even with a type cast.

How evidence maps to outcomes:

| Evidence | Outcome |
|---|---|
| passed with no retry | `passed` |
| failed or timed out | `failed` |
| flaky, skipped, interrupted, missing result, or missing report | `inconclusive` |

## 10. Structured result format (`domain/result.ts`, schema version 1)

`evidence.json` contains:

- `runId`, `startedAt`, `finishedAt`
- `environment`: target name, host, Playwright version, Node, platform, CI flag
- `runner`: exit code, `timedOut`, `reportFound`, global errors, redacted stderr tail
- `tests[]`, each with:
  - `testId`, `title`, `file`, `project`, `requirementId`, `scenarioId`
  - `status`, `durationMs`, `retries`
  - `attempts[]`: status, duration, redacted errors with locations, attachments
  - `traceRef`, `screenshotRefs`

## 11. Evidence collection

- Evidence is derived only from Playwright's JSON reporter. Traces and screenshots come from `trace: 'retain-on-failure'` and `screenshot: 'only-on-failure'` in the agent config.
- Attachment references are kept only if the file exists when evidence is collected. No reference is invented.
- Text is ANSI-stripped and redacted. Redaction covers:
  - provider key values, `SAUCE_PASSWORD`, and demo passwords
  - `sk-ant-…` keys and `Bearer …` tokens
  - `password=` / `token:` / `authorization:` values
- Tests are linked to scenarios and requirements through the `requirement` and `scenario` annotations that the renderer writes.

## 12. Failure classification

Categories: `product_behavior`, `assertion_logic`, `locator`, `test_data_setup`, `environment`, `timeout_sync`, `inconclusive`.

Each analysis has two parts:

- **Observations** (`E1…En`): verbatim, redacted facts from the runner.
- **Diagnosis**: a hypothesis, with `evidenceIds`, `confidence`, `alternatives`, `sufficientEvidence` and `nextSteps`.

The rule-based classifier always runs. Two of its rules:

- A value mismatch counts as `product_behavior` only if the expected value appears in the linked acceptance criteria. Otherwise the expectation itself is suspect (`assertion_logic`).
- A timeout never gets high confidence.

Optional model analysis (`--analysis-provider`) is kept only when it is schema-valid and every cited evidence id exists. "High" confidence combined with "insufficient evidence" is lowered to medium. Analysis is advisory. Nothing edits tests, removes assertions, or reruns.

## 13. Evaluation dataset and metrics

Phase 3 replaced this section. See [PHASE3_EVALUATION.md](PHASE3_EVALUATION.md).

## 14. Local development

```bash
npm ci && npx playwright install chromium
npm run lint && npm run typecheck
npm run test:agent               # agent unit tests (mock provider; one test opens a browser on about:blank)
npm run test:agent-integration   # full workflow against www.saucedemo.com
npm test                         # everything: Phase 1 + agent
npm run eval                     # deterministic evaluation → eval-results/deterministic.json
```

`generated/`, `.relynx/` and `eval-results/` are git-ignored.

## 15. CI/CD

`.github/workflows/playwright.yml` sets `permissions: contents: read` and runs these steps in order:

1. `npm ci`
2. lint (zero warnings allowed)
3. type check
4. install browsers
5. agent unit tests
6. Phase 1 UI/API tests and agent integration against the approved demo target
7. deterministic evaluation
8. upload the report, test-results and eval-results artifacts

Any failure fails the job.

`.github/workflows/live-eval.yml` is `workflow_dispatch` only. It runs in the `llm-eval` environment, which holds `ANTHROPIC_API_KEY`, and is not required for pull requests. CI never runs `generate`, `approve` or `execute`.

## 16. Security limitations (residual risk)

- **Approval is attributable but not authenticated.** The approver name is typed in, and anyone with a shell can run `approve`. The TTY requirement stops automation. It does not stop a determined local user. Before shared or privileged use, approval should be backed by signed commits or PR review.
- **Not an OS sandbox.** Generated tests run in a Node process with the developer's user rights. Containment relies on the renderer and validation, the hash-bound approval, the minimal environment, and the network guard. A container or VM without credentials would be stronger.
- **The network guard covers browser traffic only.** It routes requests from the browser context. Node-side network access is blocked by the AST rules, not by the OS.
- **`SAUCE_PASSWORD` is passed to the child process**, because the setup project needs it. It is a public demo password here.
- **Regex-based redaction can miss secrets** in unexpected formats.
- **The workspace check cannot see changes to ignored files.** It relies on `git status`.

## 17. Known limitations and future work

- The live provider path is unverified (no credentials during development).
- The catalog is hand-maintained. It is guarded by a conformance test, not generated.
- One demo target. The policy and network guard assume a single UI host.
- The failure-analysis sample is tiny, and the rules confuse slow pages with missing elements.
- The agent cannot propose new page objects as code. It reports `missingCapabilities` only.
- API tests are not generated. The catalog covers UI page objects only.
