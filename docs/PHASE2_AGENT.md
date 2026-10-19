# Phase 2 — AI Test Agent: generation and guarded healing

The agent turns a structured requirement into candidate Playwright **UI, API and combined UI + API tests** built on the Phase 1 page objects, API clients and fixtures. It validates them, and it runs them only after a person approves them. It then collects the runner's evidence and gives an advisory analysis of any failures. For failures caused by the test itself, it can propose a **minimal repair**: a re-targeted page-object locator or a bounded wait. That repair is verified in a separate workspace and delivered as a patch for a person to review.

What it does not do:

- write TypeScript freely
- approve, apply, commit, push or merge its own output
- change assertions or expected values
- retry until green
- run anything against a target the policy does not list

Playwright Test stays the only pass/fail authority.

## 1. Architecture

```
src/agent/
  domain/        application.ts  requirement.ts  plan.ts  testSpec.ts  state.ts  result.ts   (typed models + zod schemas)
  llm/           provider.ts (interface)  anthropic.ts (only SDK user)  mock.ts  structured.ts (validation + bounded retry)
  prompts/       plan.ts  generate.ts  analyze.ts  heal.ts  common.ts                          (prompt construction only)
  generation/    catalog.ts (page objects)  apiCatalog.ts (API clients, schemas, contracts)  validateSpec.ts  render.ts
  validation/    artifacts.ts (path, AST allowlist, tsc, ESLint, workspace check)
  execution/     policy.ts  approval.ts  files.ts  adapter.ts (the only path from generated code to a runner)
  evidence/      collect.ts (Playwright JSON -> versioned evidence)  redact.ts
  analysis/      classify.ts (rules)  modelAnalysis.ts (optional, grounded)  types.ts
  healing/       heal.ts (workflow)  locators.ts  workspace.ts  types.ts
  workflow/      generate.ts  decide.ts  execute.ts  promote.ts  report.ts  store.ts
  config/llm.ts  cli.ts
src/fixtures/agent.ts        guarded fixtures for generated tests: test (storefront), notesTest, apiTest
playwright.agent.config.ts   agent-only Playwright config (approved files only, one project per family)
agent.policy.json            protected execution and healing policy
example-app/server.ts        local example app, with deterministic failure-mode variants for healing checks
```

### How it fits Phase 1

| Phase 1 piece | How the agent uses it |
|---|---|
| Page objects (`src/pages`, `src/pages/example-app`, `HeaderComponent`) | Generated UI steps can only call members listed in `generation/catalog.ts`. `tests/agent/catalog.spec.ts` checks every entry against the real classes and fixtures. Healing may change one locator in a page object, as a reviewed patch. |
| API clients and schemas (`src/api`) | Generated API steps can only call methods listed in `generation/apiCatalog.ts`, and only assert on fields listed there. The same conformance test checks the clients and schemas. |
| Fixtures (`src/fixtures/{test,api,integration}.ts`) | `src/fixtures/agent.ts` extends each family's fixtures. Browser families get an automatic `networkGuard`. |
| Test-data prefixing and cleanup | Generated notes tests title their data with `testPrefix`, so the `exampleAppApi` fixture deletes it before and after each test. |
| Playwright runner and reporters | The adapter and healing spawn the stock `@playwright/test` CLI. All evidence comes from Playwright's JSON reporter. |

Patterns used:

- **Adapter**: `AnthropicProvider` behind `LlmProvider`, and the execution adapter in front of the Playwright CLI.
- **Explicit state machines**: artifact states and heal outcomes.
- **Interpreter/renderer**: the model outputs declarative specs and repair proposals, and deterministic code turns them into code.

There is no agent framework, RAG, multi-agent orchestration, Screenplay, custom runner or MCP.

## 2. Applications and layers

| Application (`requirement.application`) | Layers | Fixture family → file suffix → agent project |
|---|---|---|
| `storefront` (saucedemo, default) | ui | `test` → `<id>.spec.ts` → `agent-generated` |
| `notes` (local example app) | ui, api, combined | ui/combined: `notesTest` → `<id>.notes.spec.ts` → `agent-generated-notes`; api: `apiTest` → `<id>.api.spec.ts` → `agent-generated-api` |
| `posts` (JSONPlaceholder) | api | `apiTest` → `<id>.api.spec.ts` → `agent-generated-api` |

A plan scenario declares its `layer`. Validation rejects layers the application does not support, and specs whose layer differs from their scenario's.

## 3. End-to-end workflow

| # | Step | Output (under `.agent/runs/<runId>/`) | Failure surfaces as |
|---|---|---|---|
| 1 | Receive | `requirement.input.json` | — |
| 2 | Validate requirement | `requirement.json`, `assessment.json` | `invalid_requirement`; `needs_clarification` (no model call) |
| 3 | Plan | `plan.json` (model, `TestPlanSchema`) | `plan_failed` (`malformed_json`, `schema_violation`, `provider_*`) |
| 4 | Validate plan | `plan.validation.json` (traceability, coverage, layers) | `plan_rejected` |
| 5 | Surface ambiguities | `ambiguities.json` | shown in the report |
| 6 | Generate | `generation.json`, `spec.validation.json`, `generated/<runId>/*.spec.ts` | `generation_failed`; individual specs `rejected` |
| 7 | Validate artifacts | `artifact.validation.json` | artifacts `rejected` |
| 8 | Request approval | artifacts `awaiting_approval` | — |
| — | Human decision | `approval.json` (interactive `approve` / `reject`) | — |
| 9 | Execute | `playwright-results.json`, `artifacts/` | `execution_refused` |
| 10 | Collect evidence | `evidence.json` (schema v1) | `reportFound: false` → inconclusive |
| 11 | Analyse failures | `analysis.json` | — |
| 12 | Report | `report.md`, `report.json`, `llm-usage.json`, `manifest.json` | — |
| — | Heal (optional, per failed test) | `.agent/heals/<healId>/` | see §10 |
| — | Promote (optional, human) | `tests/{ui,api,integration}/generated/<id>.spec.ts` | skipped with a reason |

Bounds:

- One plan call and one generation call per run.
- At most `maxScenariosPerRun` scenarios.
- At most 3 attempts for transient provider errors.
- One execution per run, with `retries: 0` and a hard wall-clock limit.
- Healing makes one proposal call per attempt, with bounded reproduction and verification runs.

Nothing loops back from results into generation.

## 4. Requirement and plan

Requirement input (`domain/requirement.ts`):

```json
{
  "id": "REQ-201",
  "title": "…",
  "application": "notes",
  "description": "…",
  "acceptanceCriteria": [{ "id": "AC-1", "text": "…" }],
  "source": "optional",
  "metadata": { "optional": "string | number | boolean" }
}
```

- `application` defaults to `storefront`, so older files stay valid.
- Unknown fields are rejected, and criterion ids must be unique.
- Deterministic findings before any model call: `missing_acceptance_criteria` (blocking), `vague_term` (warning), `embedded_instruction` (warning; such text is treated as data).

Plan scenarios (`domain/plan.ts`) carry these fields: `id`, `requirementId`, `acceptanceCriteriaIds`, `title`, `objective`, `type` (positive, negative, boundary or authorization), **`layer`** (ui, api or combined), `priority`, `preconditions`, `steps`, `testData`, `expectedOutcomes`, `assumptions` and `openQuestions`. The plan also lists `ambiguities` and `uncoveredAcceptanceCriteria`.

The plan prompt gives the model only the application's facts: its pages, its API contract and its users. It tells the model to ask in `openQuestions` rather than invent endpoints, status codes or messages.

Validation errors:

- a foreign scenario
- an unknown criterion
- a duplicate id
- a scenario with no criterion and no assumption
- a silently uncovered criterion
- an unsupported layer

Assumption-only scenarios are never generated.

## 5. Generated test specs

The model returns `TestSpec`s (`domain/testSpec.ts`), never code.

UI steps:

- `action`: a catalog method.
- `expect`: a catalog locator or locator method, with web-first matchers and an optional bounded `timeoutMs`.
- `expectUrl`.
- `signIn` (notes app): signs the browser in through the login endpoint.

API steps (`r1`, `r2`, … name the responses):

- `apiCall { client: notes | auth | posts, as: alice | bob | anonymous | null, method, args }`
- `expectStatus { response, status }`
- `expectHeader { response, header, matcher, expected }`
- `expectBody { response, schema, field, matcher, expected, negate }`. A `null` field only validates the body against the schema.

Arguments are always data, never expressions:

- note and post objects
- `ref` (the id of an earlier response)
- credentials from test data (`password: valid | wrong`)
- `prefixed`, `padded` and `repeat` texts, for isolation and boundary values

`validateSpec` rejects:

- anything not in the catalogs
- clients of another application, or wrong principals or argument kinds
- responses used before they exist
- fields a schema does not expose (tokens are never assertable)
- an expected value taken from the response under test
- credentials written as literals, and assertions on the `authorization` header
- UI steps in API tests and API steps in UI tests
- combined tests that are not both UI and API
- host-matching URL patterns
- specs without assertions

A created note whose title lacks the test prefix gets a warning (`uncleaned_data`).

A rendered API test (`REQ-201-SC-03`):

```ts
// @agent-generated
// Candidate test proposed by the AI Test Agent. Not reviewed.
import { apiTest as test, expect } from '../../src/fixtures/agent';
import { parseJson } from '../../src/api/response';
import { ApiErrorSchema, NoteSchema } from '../../src/api/schemas';

test("reading another user's note is forbidden", { tag: '@generated', annotation: [ /* requirement, scenario, agent-run */ ] },
  async ({ exampleAppApi, testPrefix }) => {
    const alice = await exampleAppApi.as("alice");
    const r1 = await alice.create({ title: testPrefix + " Private" });
    expect(r1.status()).toBe(201);
    const bob = await exampleAppApi.as("bob");
    const r2 = await bob.get((await parseJson(r1, NoteSchema)).id);
    expect(r2.status()).toBe(403);
    expect((await parseJson(r2, ApiErrorSchema)).error.code).toBe("forbidden");
  },
);
```

Identifiers come only from the catalogs. Every model-supplied string goes through `JSON.stringify`, so it cannot leave a string literal (tested with hostile titles). Examples: `examples/requirements/REQ-20{1,2,3}-*.json`, with recorded model replies in `examples/mock-replies/`.

## 6. Provider configuration

| Variable | Default | Meaning |
|---|---|---|
| `--provider` (CLI) | none (required) | `anthropic` or `mock` |
| `ANTHROPIC_API_KEY` | — | Required for `anthropic`. Its absence is a `ProviderConfigError` before any work starts. It is read by the SDK only, and never logged or passed to test processes. |
| `AGENT_MODEL` | `claude-opus-5-5` | model id |
| `AGENT_EFFORT` | `high` | `low…max`, validated |
| `AGENT_LLM_TIMEOUT_MS` | `180000` | per-attempt timeout, validated (1000–600000) |

`AnthropicProvider` works as follows:

- It uses structured outputs from the zod schema, and the result is validated again locally.
- SDK retries are off. `structured.ts` retries timeouts, 429s, 5xx and network errors at most 3 times in total, with capped backoff that honours `retry-after`.
- Malformed or schema-invalid output is classified and not retried.
- A `refusal` or `max_tokens` stop is an error.

Usage records hold use case, provider, model, attempts, latency, tokens (with `tokensAvailable`) and outcome, never prompt or response text. Cost is computed from those records by the evaluation layer (`eval/cost.ts`, `eval/pricing.json`). It is never estimated when the provider reported no tokens.

**Not verified:** no Anthropic credentials were available. The live adapter is type-checked and its error mapping and configuration are unit-tested, but it has made no real call.

## 7. Validation and execution boundaries

Static validation (`validation/artifacts.ts`) runs on every generated file:

1. **Path.** The file must be a regular `.spec.ts` inside `generated/`. Symlinks, `..` and absolute paths are rejected.
2. **AST allowlist.**
   - Imports come only from these framework modules: fixtures/agent, config/auth, data/users, data/customers, data/exampleApp, api/response, api/schemas and api/NotesClient.
   - Top level holds only `import`, `test.use` and `test`.
   - Fixtures come only from the catalogs.
   - No `require`, `process`, `eval`, `fetch`, timers, dynamic import or template literals.
   - The only element access allowed is `response.headers()["name"]`.
   - No raw `page.*` / `request.*` calls, including `client.request`, and no `.evaluate`, `.route`, `.waitForTimeout`, `.only`/`.skip` or `expect.soft`.
   - At least one `expect`, and traceability annotations.
3. **Type-check** with the repository `tsconfig.json`.
4. **ESLint** with `eslint-plugin-playwright`, with stricter rules for `generated/**`.
5. **Workspace check.** Any change outside `generated/` and `.agent/` during generation rejects the run.

The renderer is the primary control, and the checks above are defence in depth.

Execution (`execution/adapter.ts`) runs only when all of these hold:

- the run is approved
- `approval.json` names an acceptable human and matches the current sha256 of every file
- `UI_BASE_URL` is in `approvedTargets`
- for API files, `API_BASE_URL` is in `apiTargets`
- for notes files, `EXAMPLE_APP_URL` is unset (the local app) or in `exampleApp.approvedUrls`, and the example-app variant is in `exampleApp.variants`
- no host matches `blockedHostPatterns`

When those hold, the adapter spawns the stock Playwright CLI (`shell: false`, fixed argv) with one `--project` per family present. The child gets only `envPassthrough` variables plus the run's paths; provider keys are not passed. A wall-clock limit kills the whole process group. `playwright.agent.config.ts` refuses to load without the approved-file list and matches exactly those files. Browser families run with `networkGuard`: storefront tests may reach only the UI target, notes tests only the example app. API tests reach only the clients' configured base URLs. The AST rules forbid any other network access.

## 8. Human decisions

```bash
npm run agent -- generate --requirement examples/requirements/REQ-201-notes-api.json --provider mock --mock-replies examples/mock-replies/REQ-201.json
# review generated/<runId>/* and .agent/runs/<runId>/report.md
npm run agent -- approve <runId> --approver "Your Name"     # interactive: type "approve <digest>"
npm run agent -- execute <runId>
npm run agent -- promote <runId> --approver "Your Name"     # interactive: copy passed tests into the trusted suite
```

- `approve`, `promote` and `heal-approve` refuse when stdin/stdout is not a terminal, and need a typed confirmation code derived from the exact file or patch hashes.
- Names that identify automation (`agent`, `test-agent`, `claude`, `ci`, `…[bot]`, …) are rejected.
- No workflow module records an approval or a promotion. Only the CLI does, after confirmation, and tests acting as the person.
- **Promotion** (`workflow/promote.ts`) takes only `passed` artifacts whose candidate file is unchanged since approval. It re-renders them with the ordinary fixtures into `tests/{ui,integration,api}/generated/<scenarioId>.spec.ts`, never overwriting a file. The AST, type-check and lint checks run again; a file that fails them is removed. The artifact moves to `promoted`. Nothing is committed: a person reviews and commits the new files.

## 9. State model

Run status:

```
invalid_requirement | needs_clarification | plan_failed | plan_rejected | generation_failed
| nothing_to_execute | awaiting_approval | approved_for_execution | rejected_by_reviewer | execution_refused | executed
```

Artifact states:

```
proposed → validated → awaiting_approval → approved → executed → passed → promoted
                                                                ↘ failed | inconclusive
    └────────┴──────────────┴→ rejected
```

- `approved` and `promoted` require a named human.
- `executed` requires the runner.
- `passed`, `failed` and `inconclusive` come only from `recordOutcome(record, evidence)`.

| Evidence | Outcome |
|---|---|
| passed with no retry | `passed` |
| failed or timed out | `failed` |
| flaky, skipped, interrupted, missing result, missing report | `inconclusive` |

## 10. Guarded healing (`src/agent/healing`)

```bash
# a failed generated test of an executed run
npm run agent -- heal --run <runId> --scenario <scenarioId> --provider anthropic|mock [--mock-replies f] [--example-app-variant v]
# a trusted (hand-written or promoted) test
npm run agent -- heal --test tests/integration/notes.spec.ts --title "a note added in the UI is returned by the API" \
  --provider mock --mock-replies examples/mock-replies/heal-renamed-add-button.json --example-app-variant renamed-add-button
npm run agent -- heals
npm run agent -- heal-approve <healId> --approver "Your Name"   # records a decision; never applies the patch
```

Workflow. Each attempt works in a **copy** of the framework, `.agent/heals/<healId>/workspace/`, with `node_modules` linked. The working tree is never edited.

1. **Reproduce.** Run the failing test `reproduceRuns` times (policy max 5). No failure means `insufficient_evidence`. Passes mixed with failures are recorded as `intermittent`.
2. **Classify** the last failure from Playwright evidence. Observations include the redacted page snapshot from Playwright's `error-context` attachment and the retry history.
3. **Gate.** Deterministic, and decided before any model call:

   | Category | Decision |
   |---|---|
   | `locator` with a page snapshot | locator repair |
   | `locator` without a snapshot | `insufficient_evidence` |
   | `timeout_sync` in a generated test | wait repair |
   | `timeout_sync` in a hand-written test | `not_applicable` (reported for a person) |
   | `product_behavior`, `api_contract` | `not_applicable`: never auto-healed |
   | `assertion_logic` | `not_applicable`: expected values are never changed |
   | `test_data_setup`, `environment`, `infrastructure` | `not_applicable`, reported |
   | `inconclusive` | `insufficient_evidence` |

4. **Propose.** One model call (`HealProposalSchema`) returns either `decline` or at most `maxChanges` changes of the allowed kind:
   - `replaceLocator { pageObject, member, locator: role | label | text }`
   - `addWait { beforeStep, target, locatorArgs?, timeoutMs }`, a visibility assertion with a bounded timeout

   The schema has no operation that removes, reorders or edits a step, an expected value, a status or a retry setting.
5. **Validate**, deterministically. Any failed check means `validation_failed`:
   - cited evidence ids exist
   - the change count and kind are allowed
   - the page object is in `patchableRoots` (`src/pages/`, `src/components/`); the test, `example-app/` and configuration are never patchable
   - the member is a plain `getBy*` locator, and **the failure waited for exactly that locator**
   - a role stays the same role
   - **the page snapshot shows an element the new locator matches**, and the proposal cites the snapshot
   - waits sit at or before the failing step, within `maxWaitTimeoutMs`, and the patched spec passes catalog validation
   - **removing the inserted waits gives back the original steps exactly**
   - the test file is byte-for-byte unchanged (page-object repairs), and the `expect()` count is unchanged or grows only by the added waits
   - type-check, lint and AST checks pass in the workspace
6. **Verify.** The patched test must pass **every** one of `verifyRuns` runs (policy max 10). A single pass is not enough.
7. **Regression.** For page-object changes, the trusted project that uses those page objects (`integration` or `ui-chromium`) runs before and after the patch. Any newly failing test means `verification_failed`.
8. **Output.** `patch.diff` (a unified diff against the working tree), `heal-record.json` (target, reproduction, analysis, gate, proposal, every check, verification and regression results, history) and `heal-report.md`. The outcome is `verified_pending_review`.
9. **Review.** `heal-approve` checks that the patch bytes still match and records `approved`. It does not apply, commit or push anything; the reviewer runs `git apply`. A wait added to a generated test changes that candidate, so it needs a new approval before it can run again.

Outcomes:

- `not_applicable`
- `insufficient_evidence`
- `proposal_failed` (provider error, malformed output, a forbidden change kind, no provider)
- `proposal_generated` (intermediate)
- `validation_failed`
- `verification_failed`
- `verified_pending_review`
- `approved`

The example app's variants make every path reproducible without a live model: `renamed-add-button` (UI drift), `intermittent-slow-list` (timing), `broken-create` (a product defect that must not be healed). See `tests/agent-integration/healing.spec.ts`.

## 11. Evidence and failure classification

Evidence comes only from Playwright's JSON reporter. Attachment references are kept only if the file exists. Text is ANSI-stripped and redacted: provider keys, demo passwords, `Bearer` tokens, and `password=` / `token:` / `authorization:` values. The page snapshot is the only part of `error-context.md` that is read. The rest of that file includes generic instructions and source, and is ignored.

Categories:

- `product_behavior`
- `assertion_logic`
- `locator`
- `timeout_sync`
- `test_data_setup`
- `environment`
- `api_contract`
- `infrastructure`
- `inconclusive`

Rules added in this phase, all deterministic and citing evidence ids:

- An element that was found but stayed hidden for the whole timeout is `timeout_sync`, not a wrong expectation.
- An API status mismatch with a 5xx response, or with a status the acceptance criteria require, is `product_behavior`. Any other status mismatch is `api_contract`, with `assertion_logic` and `product_behavior` as alternatives.
- A response body that fails its schema is `api_contract`.
- A missing module, syntax error, missing project or crashed worker is `infrastructure`.

Optional model analysis is kept only if it is schema-valid and cites existing evidence. It stays advisory, and the healing gate uses the rule-based category. These rule changes left the Phase 3 deterministic evaluation unchanged (compared with the baseline; only a timing metric moved).

## 12. Local development and CI

```bash
npm run test:agent               # agent unit tests: mock provider, fake runners
npm run test:agent-integration   # real runs: storefront workflow, healing on the local example app, promotion
npm run agent -- --help
```

`generated/`, `.agent/` (runs and heals) and `eval-results/` are git-ignored. CI (`.github/workflows/playwright.yml`) runs lint, typecheck, the agent unit tests, and the agent integration tests including healing. CI never runs `approve`, `promote` or `heal-approve`, and never calls a paid model. `live-eval.yml` is manual only.

## 13. Security limitations (residual risk)

- **Approval is attributable, not authenticated.** The approver name is typed in, and anyone with a shell can run the interactive commands. Before shared use, back approval with signed commits or PR review.
- **Not an OS sandbox.** Generated tests and healing verification run in Node processes with the developer's user rights. Containment comes from:
  - the renderer and allowlists
  - hash-bound approval
  - the minimal environment
  - the network guard
  - the separate healing workspace

  A credential-free container would be stronger.
- **Healing verification runs before human review.** It runs only deterministically rendered code (a DSL-rendered spec or a single rendered locator), in the workspace, under the same restricted runner. It is not human-approved code.
- **The network guard covers browser traffic only.** Node-side requests are limited by the AST rules and the clients' configured base URLs, not by the OS.
- **API traces include request headers.** The example app's bearer tokens are random and live only in memory.
- **Regex-based redaction can miss** secrets in unexpected formats.
- **The workspace check cannot see changes to ignored files.**

## 14. Known limitations

- The live provider path is unverified (no credentials).
- Catalogs are hand-maintained, guarded by conformance tests.
- The agent cannot create new page objects or API clients. It reports `missingCapabilities`.
- Healing repairs only two shapes:
  - plain `getBy*` page-object locators (not chains that end in `filter()` or `first()`)
  - visibility waits in generated tests

  Timing problems in hand-written tests and test-data isolation problems are identified and reported, not repaired.
- Locator evidence relies on the accessibility snapshot. Proposals by test id or placeholder cannot be checked against it, so the schema does not allow them.
- Regression scope is the trusted project of the affected application. Generated candidates of other runs are not re-run.
- Healing has not been measured against a live model. Its success and regression rates belong to Phase 3.
