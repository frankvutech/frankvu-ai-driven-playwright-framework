# Phase 3 — AI Test Quality, Evaluation and Reliability

Phase 3 measures the Phase 2 agent. It covers UI, API and combined test generation, assertion quality, false positives and false negatives, tool-failure recovery, guarded healing, cost and latency, and run-to-run comparison. This document describes what is measured, how each figure is calculated, where the reference labels come from, and what the numbers do and do not show.

All results below come from the committed baselines (`eval/baselines/*.json`, dataset 3.0.0). Each was reproduced on at least one repeated run.

## 1. Principles

- **Kinds of result are never mixed.** Every metric has a `kind`:

  | Kind | Meaning |
  |---|---|
  | `deterministic` | Pure code over fixed inputs |
  | `measured` | Observed from real Playwright runs, so it can vary between runs |
  | `reference-label` | Agreement with dataset labels |
  | `ai-judgment` | Optional LLM judge. Never gated. |

  Missing data is a `status` (`insufficient-data`, `unavailable` or `not-run`), never a number.
- **Labels are not ground truth by assertion.** Each label records how it was produced:
  - `constructed`: built to have that outcome.
  - `observed-controlled-variation`: verified by an independent probe.
  - `author-judgment`: an opinion.

  Each label also has a review status. **0 of 95 labels are human-reviewed.** All were authored by the AI assistant that built the framework, and every report prints this count.
- **Compiling is not correctness.** Type-check and lint, execution, and reference intent are reported separately. A test is never counted as correct because it passes.
- **Nothing is estimated silently.** With a mock provider, token counts, cost and model latency show as `unavailable` or `not-run`. Cost is computed only from provider-reported tokens.
- **The model is replaced, not the pipeline.** Recorded outputs stand in for the model. Planning, rendering, validation, execution, evidence, analysis and healing all run for real.

## 2. Architecture

```
eval/
  dataset/                 versioned dataset: manifest, planning, generation, functional, failures/, healing
  schema.ts  dataset.ts    zod schemas, loader, content sha256, pinned-spec and cross-reference checks, label counts
  evaluate.ts              planning, generation (per layer), evidence parsing, failure analysis
  assertions.ts            deterministic assertion-quality rules (UI and API)
  semantic.ts              reference checks (UI values; API status and body fields) + optional LLM judge
  functional.ts            seeded-defect execution through the real workflow; per-layer FP/FN
  healing.ts               healing cases through src/agent/healing; independent patch intent check
  faults.ts                deterministic fault injection (26 scenarios)
  cost.ts  pricing.json    usage, per-phase latency, cost from reported tokens; pricing file configurable
  gates.ts  gates.json     configurable threshold gates (safety, quality, cost)
  metrics.ts               ratios, percentiles, Wilson intervals, binary and per-class confusion
  report.ts  compare.ts    report schema, summary, run comparison
  run.ts                   modes, gates, baselines, CLI
  probes/seeded-defects.ts independent verification of every seeded defect (demo site and example app)
  baselines/               deterministic, functional and healing baseline reports
```

The evaluator uses only the agent's existing interfaces:

- `planRequirement` and `generateSpecs`
- `planAndGenerate`, `recordDecision` and `executeRun`
- `validateArtifacts`, `collectEvidence` and `classifyFailure`
- `healTest`

Nothing in the evaluator can approve a release, apply a patch, or merge.

## 3. Modes

| Command | What runs | Network | Gates |
|---|---|---|---|
| `npm run eval` | planning (25) and generation (31) on recorded outputs; assertion rules vs labels; evidence parsing and failure analysis on 27 report tests; 26 fault scenarios | none | configured gates, case expectations, no false passes, fault recovery, report schema, exact match with the baseline |
| `npm run eval:functional` | 6 seeded-defect suites, 17 workflows, 62 reference outcomes: 4 storefront suites on saucedemo.com, 2 notes-app suites on the local example app | demo site + local | configured gates, target available, baseline |
| `npm run eval:healing` | 15 healing cases on the local example app (real Playwright runs; recorded proposals) | local only | configured gates (safety included), all cases set up, baseline |
| `npm run eval:live -- [--repeat N] [--judge-model M]` | live planning, generation, static validation and model-assisted analysis | model API | live gates (insufficient data until real data exists) |
| `npm run eval:compare -- a.json b.json` | metric-by-metric comparison | none | exit 1 on gated regressions |
| `npm run eval:probe-defects` | re-verifies every seeded defect, twice each | demo site + local | exit 1 on any mismatch |

`eval:functional` and `eval:healing` need `AGENT_EVAL_APPROVER=<a person's name>`. They execute only sha256-pinned dataset specs through the normal approval path. In CI the approver is `github.actor`. `eval:live` needs `AGENT_LIVE_EVAL=1` and credentials, and runs only from the manual `live-eval.yml` workflow.

Every mode accepts `--pricing <file>`, `--gates <file>` and `--baseline <report>`. Healing mode also accepts `--case HE-xx`.

## 4. Dataset (version 3.0.0)

| File | Size | Content |
|---|---|---|
| `planning.json` | 25 cases | 21 storefront cases (clear, multiple criteria, boundary, validation, authorization, ambiguous, missing criteria, conflicting, untestable, unsupported assumptions, malformed, embedded instructions) and 4 new ones: notes API plan (layers, authorization, boundary), unsupported layer, ambiguous API requirement, combined plan |
| `generation.json` | 31 cases | 19 UI cases and 12 new API/combined ones: correct notes API, status-only (weak), wrong expected statuses, no status at all, expected value copied from the response under test, unknown endpoint, combined, combined without API, posts API, assertion on a token, duplicate spec, irrelevant scenario. API cases carry required status and body assertions and per-spec **intent labels**. |
| `functional.json` | 6 suites, 62 reference outcomes (24 defect-present, 38 defect-free) | storefront suites plus FS-NOTESAPI (6 specs × 4 variants) and FS-NOTESUI (3 combined specs × 3 variants). Some pinned specs are deliberately weak (FS-NOTESAPI SC-05) or wrong (SC-06). |
| `failures/` | 9 real Playwright reports, 23 labelled failures, 4 controls | 6 new captures from the example app: server error, authorization bypass, missing title validation, UI drift, broken UI save, slow list |
| `healing.json` | 15 cases | UI drift with correct, wrong-element, absent-element, wrong-role, declined, malformed, timed-out and assertion-deleting proposals; three product defects; slow list with a correct and a misplaced wait; timing in a hand-written test; no failure |

**Seeded defects.** Storefront defects (6) use saucedemo's broken accounts. Example-app defects (3) are deterministic variants of `example-app/server.ts`:

| Defect | Variant | Behaviour |
|---|---|---|
| D-NOTES-CREATE | `broken-create` | creating a note answers 500 |
| D-NOTES-AUTHZ | `auth-bypass` | another user's note answers 200 instead of 403 |
| D-NOTES-TITLELEN | `no-title-limit` | 121-character titles are accepted |

`renamed-add-button` (UI drift) and `intermittent-slow-list` (timing) are failure modes, not product defects. `eval/probes/seeded-defects.ts` checks each defect against every variant without using the agent's page objects or clients: Playwright with raw selectors for the storefront, raw HTTP for the example app. Last result: **36/36 checks matched, twice each.**

**Versioning.** Any content change bumps `manifest.json` → `datasetVersion` and adds a changelog entry. Reports record the version and a content sha256, and an edit without a version bump shows up in comparisons. Pinned functional specs are hashed as written. Healing cases that target generated tests must reference an existing pinned spec; the loader checks this.

## 5. Metric definitions and results

### 5.1 Test-generation correctness

Correctness has four separate dimensions: structural validity, type-check and lint, execution, and semantic intent.

**Structural** (deterministic, recorded outputs):

| Measure | Result |
|---|---|
| Planning case expectations | 25/25 |
| Generation case expectations | 31/31 |
| Schema validity | 30/31 (one malformed by design) |
| TypeScript validity of rendered files | 30/30 |
| Convention compliance (AST, ESLint, path) | 30/30 |
| Traceability annotations | 30/30 |
| Unsupported, duplicate, irrelevant or unsafe specs rejected | 11/11 |
| Scenario traceability | 44/48 |

**By layer.** Specs are type-checked, then compared with the reference:

| Layer | Type-check | Required assertions met | Intent correct by reference | Labelled-incorrect specs flagged |
|---|---|---|---|---|
| api | 13/13 | 8/13 | 8/13 | 5/5 |
| combined | 2/2 | 2/2 | 2/2 | — (none labelled incorrect) |
| ui | 15/15 | 9/15 | no intent labels | — |

**All 13 API specs compile and pass validation, but 5 of them test the wrong thing** (status only, wrong status, no status). That is exactly the gap between compiling and correct. The deterministic rules and the required-assertion check flag all 5.

**Semantic, planning** (reference-based):

| Check | Result |
|---|---|
| Required coverage met | 4/5 |
| Expected scenario categories present | 5/6 |
| Plans free of prohibited assumptions | 4/5 |
| Clarification behaviour | 5/8 |

These match the storefront findings already documented (PL-05, PL-17, PL-19, PL-21). The 4 new API planning cases meet their expectations.

**Semantic, generation**: required assertions satisfied 30/43, across UI and API.

**Execution and functional** (§5.3): outcomes match the reference in 53/62 cases, and 18/20 tests pass on the defect-free control.

### 5.2 Assertion quality

13 deterministic rules:

- 9 UI rules: `AQ_MISSING`, `AQ_NAV_ONLY`, `AQ_VISIBILITY_ONLY`, `AQ_NEGATIVE_ONLY`, `AQ_UNTRACED`, `AQ_WEAK_PARTIAL`, `AQ_CONTRADICTORY`, `AQ_REDUNDANT`, `AQ_UNSTABLE_URL`
- 4 new API rules:
  - `AQ_API_NO_STATUS`: a call's status is never checked.
  - `AQ_API_ERROR_CODE_MISSING`: an error status is checked without its error code.
  - `AQ_API_STATUS_NOT_IN_CRITERIA`: the expected status differs from the status the criteria state.
  - `AQ_API_BODY_UNCHECKED`: a successful response under test has no field assertion.

The body and criteria rules judge only the *response under test*: the response of the final assertion. Setup calls in combined tests are not penalised. This was found and fixed during evaluation, when the rule fired on a correct combined spec.

Copying the actual response is prevented upstream. An expected value taken from the response under test is rejected by the spec validator (GE-24), and tokens are never assertable (GE-29).

Results:

- Against 30 labelled specs, the rules agree exactly 30/30. Labels and rules share an author, so this is optimistic: it shows the rules do what they were designed for, not independent validity.
- On the functional suites, the rules flagged all 4 tests that missed seeded defects (4/4).
- Assertion removal or weakening by healing is measured separately (§5.5).

### 5.3 False positives and false negatives

Definitions:

- **Detection.** Positive class: *a relevant seeded defect exists for the behaviour under test*. Predicted positive: *the test failed*.
  - A **false positive** is a failing test where the behaviour is correct, for example a stale locator or a wrong expectation.
  - A **false negative** is a passing test despite a relevant defect.
- **Diagnosis.** Over failed tests only. Positive class: *the failure is caused by a seeded defect*. Predicted positive: *the analysis says `product_behavior`*.
- Product behaviour (the variant), test correctness (the pinned spec and its labels) and AI classification (the diagnosis) are separate dimensions.

| | Defect present | No defect |
|---|---|---|
| **Test failed** | TP 20 | FP 5 |
| **Test passed** | FN 4 | TN 33 |
| Inconclusive | 0 | 0 |

| Measure | Result |
|---|---|
| Recall | 20/24 = 83% (95% Wilson interval 64–93%) |
| Precision | 20/25 = 80% |
| False-positive rate | 5/38 = 13% |

| Layer | Recall | False-positive rate |
|---|---|---|
| UI | 11/15 | 1/14 |
| API | 6/6 (insufficient data) | 3/18 |
| Combined | 3/3 (insufficient data) | 1/6 (insufficient data) |

Where the errors come from:

- **The 5 false positives:**
  - FS-NOTESAPI SC-06, which deliberately expects 200 instead of 201, fails on 3 defect-free variants.
  - FS-NOTESUI SC-02 fails under UI drift, where the feature works but the locator is stale.
  - FS-LOGIN SC-02 is deliberately incorrect.
- **The 4 false negatives** are the deliberately weak storefront specs.
- **Observed and kept honest:** the deliberately weak API spec FS-NOTESAPI SC-05 checks only the content type, yet it *failed* under `no-title-limit`. The failure came from the cleanup fixture, whose schema rejects the stored 121-character note, not from the test's own assertion. The reference counts it as a true positive (the test failed and the defect is relevant), and the cause is recorded in the failure dataset (F-20).

Diagnosis:

| | Called product_behavior | Called something else |
|---|---|---|
| Seeded defect | TP 9 | FN 11 |
| No defect | FP 0 | TN 5 |

The rule-based analysis recognises API and authorization defects through status codes, but calls UI symptoms of defects `locator`. These figures describe the pinned specs and the pipeline, not a model's detection rate.

### 5.4 Tool-error recovery

26 deterministic fault scenarios run against the real workflow. **All 26 meet their expected safe behaviour**, and error classification is correct in 17/17 checks.

| Area | Scenarios | Result |
|---|---|---|
| Provider (FI-01..07) | timeout, 429 then OK, 5xx ×2 then OK, persistent 5xx, malformed JSON, schema-invalid, auth | Transient errors are retried up to 3 attempts. Recovered 2/2, after 1 and 2 retries; mean recovery latency 22.5 ms with 10–40 ms test backoff. Malformed, schema and auth errors are never retried. |
| Runner (FI-08..13) | missing executable, invalid config, test timeout, wall-clock kill, missing artifacts, failed assertion | Each ends inconclusive or failed, never passed. Errors are preserved. |
| Authorization (FI-14..17) | duplicate execution, no approval, tampered file, production-like target | The runner never starts, or starts exactly once. |
| API and browser (FI-18..20) | API network error, invalid API response, browser cannot start | failed; classified environment, api_contract, environment |
| Configuration and static checks (FI-21..23) | missing credentials, code failing type-check and lint, generation interrupted by provider failure | configuration error before any call; rejected before approval; generation_failed after 3 bounded attempts with nothing approvable |
| Healing (FI-24..26) | proposal provider timeout, reproduction run killed, verification run crashes | proposal_failed after 3 attempts; insufficient_evidence with no model call; verification_failed. No patch in any case, the working tree is untouched, and the heal record is kept. |

Unrecoverable faults propagated as failures in 24/24 cases. All 26 terminated within their limits.

### 5.5 Healing evaluation

Each healing case runs the real healing workflow: reproduction, classification, gate, validation in a separate workspace, verification, and regression. It runs against the local example app in a controlled failure mode. Only the model is replaced by the case's recorded reply.

Correctness is judged two ways:

- against the reference: the expected outcome and the correct repair, established when the case was constructed;
- by an **independent intent check** that re-reads `patch.diff`. It confirms that only page objects or the generated test changed, that no `expect(` line was removed, and that the only added assertions are bounded visibility waits.

| Metric | Definition (numerator / denominator) | Result |
|---|---|---|
| Outcome agreement | outcome equals reference / cases set up | 14/15 |
| Proposal rate | proposals reaching validation / attempts the gate let through | 6/10 |
| Correct proposals verified | correct recorded proposals that ended verified and equal to the reference fix / correct recorded proposals | 2/2 |
| Verified success | verified reference fixes / cases where a repair is expected | 2/10 (8 of the 10 deliberately carry bad or no proposals, so this describes the dataset, not a model) |
| Incorrect healing | verified patches that are not the reference fix / verified patches | 0/2 |
| Incorrect proposals blocked | incorrect proposals not verified / incorrect proposals | 5/5: 2 by validation (absent element, wrong role), 1 by verification (wrong element passes static checks but fails verification), 1 by schema (assertion deletion), 1 by validation (misplaced wait) |
| Regression after healing | verified patches with new regression failures / verified patches | 0/2 |
| Assertion weakening or intent violation | verified patches failing the independent check / verified patches | 0/2 |
| False healing of product defects | product-defect cases ending verified or approved / product-defect cases | **0/3** |
| Product defects stopped before the model | product-defect cases with no model call / product-defect cases | 3/3 |
| Insufficient evidence correctly rejected | such cases ending insufficient_evidence / such cases | 2/2 |
| Manual intervention | attempts without a verified patch / attempts | 13/15. Every verified patch still needs review. |
| Acceptance after human review | approved / reviewed | **unavailable**: no review decisions exist |
| Time per attempt | wall-clock | median 11.3 s, p90 33.6 s (15 samples, insufficient data for a distribution) |
| Cost per attempt | tokens × pricing | **unavailable**: the recorded provider reports no tokens |

**The one mismatch (HE-10, authorization bypass)** is a genuine classifier gap. The hand-written test asserts `toEqual([403, 403, 403])`, and the rule-based classifier does not recognise array status diffs, so it returned `inconclusive`. The heal ended `insufficient_evidence` instead of `not_applicable`. It was still stopped before any model call, and nothing was patched.

### 5.6 Failure-analysis accuracy

The rule-based classifier was run on 23 labelled real failures.

| Measure | Result |
|---|---|
| Accuracy | 13/23 (insufficient data; was 8/15 before the new captures) |
| Macro recall | 0.58 |
| Label in top category or alternatives | 19/23 |
| Evidence relevance | 22/22 |
| Uncertainty identified | 10/11 |
| Unsupported root-cause claims | 0 |

Of the new captures, the server error, authorization bypass, missing title validation, UI drift and slow list are classified correctly. Three are wrong:

- A wrong expected status is called `api_contract`. Its alternatives include `assertion_logic`.
- A defect surfaced by the cleanup schema is called `api_contract`.
- A broken UI save is called `locator`, the known "element not found" weakness.

### 5.7 Cost and latency

Functional mode measured 17 workflows. Phase timings come from each run's own step timestamps.

| Measure | Result |
|---|---|
| Total median / p90 | 8.1 s / 13.0 s |
| Playwright runner median | 6.9 s |
| Static validation median (path, AST, type-check, lint) | 0.9 s |
| Failure analysis median (rules) | 1 ms |
| Model calls | 34, 0 retries |
| Workflow failures | 0/17 |

All latencies are marked insufficient data: fewer than 20 samples is not a distribution. Model latency is `not-run`, and tokens and cost are `unavailable`, because the model was a mock. Healing time is in §5.5.

Pricing comes from a configurable file (`--pricing`; default `eval/pricing.json`, Anthropic list prices effective 2026-10-06, with stated exclusions):

```
cost = (input tokens × input price + output tokens × output price) / 10⁶
```

It is computed only when every call reported tokens, so it is never estimated. **No real token or cost figure exists yet.**

### 5.8 Reproducibility and comparison

Reports record the run id and timestamp; dataset version and sha256; commit and dirty flag; prompt version and system-prompt sha256 (healing prompt included); provider, model and judge; metric-implementation version; and configuration without secrets (policy execution and healing bounds, pricing and gate files, selected suites or cases, baseline). Local paths and known secrets are stripped.

Repeated results:

- Deterministic reports were identical across runs.
- Functional detection counts were identical across 3 runs; only latency moved.
- Healing outcomes were identical across 3 runs.

`eval:compare` reports every metric change. Several rules keep it from overclaiming:

- **Measured** metrics whose 95% intervals overlap, or whose samples are too small, are marked `inconclusive` instead of improved or regressed. Latency changes are always inconclusive, because no interval is computed.
- A different dataset version makes exact gates non-comparable. The baseline gate becomes `not-applicable` with "rebaseline required", and the changes are still listed.
- Healing and safety metrics are listed first.

## 6. Quality gates

There are two gate mechanisms, and both run in CI:

1. **Baseline gates** (`--baseline`). Each metric's gate rule comes from the baseline: `exact` for deterministic and count metrics, `none` for timing and AI judgments.
2. **Threshold gates** (`eval/gates.json`). Each gate names a metric, an operator, a threshold, its modes, a severity (safety, quality or cost), a minimum denominator, whether data is required, whether it is provisional, and a rationale.

   Results are `pass`, `fail` or **`insufficient-data`**: missing or too-small data is reported, never treated as a pass. Gates with `requireData` fail closed. Safety gates are listed first in every summary and fail the run on their own, so no other result can hide them.

| Gate | Threshold | Status |
|---|---|---|
| safety: no healing of product defects | `healing.unsafe.verifiedProductDefects == 0` | fixed, not provisional |
| safety: no intent violations in patches | `healing.unsafe.intentViolations == 0` | fixed |
| safety: no incorrect verified repairs | `healing.unsafe.incorrectVerified == 0` | fixed |
| safety: product defects stop before the model | `== 100%` | fixed |
| safety: no false passes | `evidence.falsePasses == 0` | fixed |
| reliability: fault expectations | `100%` | fixed |
| healing: insufficient evidence rejected; incorrect proposals blocked | `100%` | provisional |
| functional recall / false-positive rate | `>= 0.6` / `<= 0.3`, min. denominator 10 | provisional |
| live type-check validity, live required assertions, live median cost | `>= 0.95`, `>= 0.8`, `<= $0.50` | provisional; insufficient data until a live run exists |

Provisional thresholds were set by the framework author without baseline data from real model runs. They must be revisited when live results exist.

CI (`.github/workflows/playwright.yml`) runs:

1. lint and type-check
2. framework, agent and evaluation unit tests
3. `npm run eval`
4. the UI, API, integration and agent-integration suites
5. the probe
6. `npm run eval:functional`
7. `npm run eval:healing`

No live model is needed. Live evaluation is the separate, manual `live-eval.yml`.

## 7. Limitations

- **0 of 95 labels are human-reviewed.** The intent labels, assertion-weakness labels and healing references were authored by the same AI assistant that built the rules they score. To review one, set `review: { status: "human-reviewed", reviewer, date }` and bump the version.
- **No live-model evaluation has been run.** There is no model-quality, token or cost data. Generation, planning and healing proposals are recorded stand-ins: they test the pipeline and the evaluator, and say nothing about how often a model produces good or bad output.
- **Samples are small**: 23 labelled failures, 62 functional outcomes, 15 healing cases, 17 workflows. Rates below their minimum denominators are marked insufficient data. Nothing here supports a reliability claim.
- **Test environment:**
  - The storefront is a public demo site with no version.
  - Example-app defects and failure modes are deterministic simulations. Real drift, flakiness and defects are more varied.
  - The `intermittent-slow-list` timing resets when Playwright restarts a worker after a failure.
- **Classifier gaps:**
  - UI symptoms of defects are called `locator`.
  - Array status diffs are not recognised (HE-10).
  - Expected values are traced to criteria by substring.
- **Healing evaluation scope:**
  - Two repair shapes only (page-object locators and waits in generated tests).
  - The regression scope is the trusted project of the affected app.
  - Review acceptance is unavailable.

## 8. Changes to Phase 1 and Phase 2 made for Phase 3

- `example-app/server.ts`: the `auth-bypass` and `no-title-limit` seeded-defect variants, also listed in `agent.policy.json`.
- No change to agent behaviour. The evaluation reuses the agent's existing interfaces only.

Earlier evaluation-driven changes (Phase 3 v2) are recorded in git history:

- `UsageRecord.tokensAvailable`
- `PROMPT_VERSION`
- session variants
- the setup-failure rule
- the extra demo accounts
