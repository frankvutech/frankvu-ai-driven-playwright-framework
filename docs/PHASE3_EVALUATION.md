# Phase 3 — AI Test Agent Evaluation & Reliability

Phase 3 measures the Phase 2 agent. It does not change what the agent does, apart from four small instrumentation and test-target changes (see §9). This document describes what is measured, how each figure is calculated, where the reference labels come from, and what the numbers do and do not show.

## 1. Principles

- **Five kinds of result, never mixed.** Every metric in a report has a `kind`:

  | Kind | Meaning |
  |---|---|
  | `deterministic` | Pure code over fixed inputs |
  | `measured` | Observed from a real Playwright run or a real model call, so it can vary between runs |
  | `reference-label` | Agreement with dataset labels |
  | `ai-judgment` | Output of an optional LLM judge. Never gated. |
  | Inconclusive | Not a kind: shown as a `status` of `insufficient-data`, `unavailable` or `not-run` |

- **Labels are not ground truth by assertion.** Each label records how it was produced:
  - `constructed`: the case was built to have that outcome.
  - `observed-controlled-variation`: verified by an independent probe.
  - `author-judgment`: an opinion.

  Each label also has a review status. **No label has been human-reviewed yet.** All 62 were authored by the AI assistant that built the framework. Reports print this count on every run.
- **Nothing is estimated silently.** Token counts, costs and model latency show as `unavailable` or `not-run` when there is no real data. The mock provider deliberately reports no usage.

## 2. Architecture

```
eval/
  dataset/                 versioned dataset (manifest.json, planning, generation, functional, failures/)
  schema.ts  dataset.ts    zod schemas, loader, content sha256, pinned-spec check, label-review counts
  evaluate.ts              case evaluators: planning, generation, evidence parsing, failure analysis
  assertions.ts            deterministic assertion-quality rules
  semantic.ts              reference-based semantic checks + optional LLM judge (never self-judging)
  functional.ts            seeded-defect execution through the real Phase 2 workflow; FP/FN confusion
  faults.ts                deterministic fault injection (17 scenarios)
  cost.ts  pricing.json    usage aggregation, latency statistics, cost from reported tokens only
  metrics.ts               ratios, percentiles, Wilson intervals, binary and per-class confusion
  report.ts  compare.ts    report schema, summary, run-to-run comparison and gate rules
  run.ts                   modes, gates, baseline comparison, CLI
  probes/seeded-defects.ts independent verification of the seeded-defect catalogue
  baselines/               committed deterministic and functional baseline reports
```

The evaluator calls the agent only through its existing interfaces:

- `planRequirement` and `generateSpecs` (Phase 2 workflow steps)
- `planAndGenerate`, `recordDecision` and `executeRun` (the full workflow, approval included)
- `validateArtifacts`, `collectEvidence`, `classifyFailure`, `refineWithModel`

It adds no orchestration engine, and nothing in it can approve, merge or modify generated tests.

## 3. Modes

| Command | What runs | Network | Gates |
|---|---|---|---|
| `npm run eval` | dataset validation; planning and generation on recorded outputs; assertion rules vs labels; evidence parsing and failure analysis on 18 real reports; 17 fault scenarios | none | expectations, no false passes, fault recovery, report schema, exact match with `eval/baselines/deterministic.json` |
| `npm run eval:functional` | 4 seeded-defect suites, 10 workflows, 29 reference outcomes, executed against www.saucedemo.com | demo site | target available (0 inconclusive), report schema, exact match of outcome counts with `eval/baselines/functional.json` |
| `npm run eval:live -- [--repeat N] [--judge-model M]` | live planning, generation, static validation and model-assisted failure analysis | model API | none (report only) |
| `npm run eval:compare -- a.json b.json` | metric-by-metric comparison; exit 1 on gated regressions | none | — |
| `npm run eval:probe-defects` | re-verifies the seeded-defect catalogue on the demo site (2 repetitions each) | demo site | exit 1 on any mismatch |

`eval:functional` needs `RELYNX_EVAL_APPROVER=<a person's name>`. It runs the normal Phase 2 approval path, with that person as approver, for specs that are byte-identical to the sha256-pinned dataset specs. No model output is ever executed by the evaluation. In CI the approver is `github.actor`, so bot accounts are refused. `eval:live` needs `RELYNX_LIVE_EVAL=1` and provider credentials.

Every run writes `eval-results/<runId>/report.json` and `summary.md`. Each report records the following metadata:

- run id and timestamp
- dataset version and content sha256
- git commit and dirty flag
- prompt-template version (`PROMPT_VERSION`) and the sha256 of all system prompts
- provider, model and judge
- metric-implementation version
- configuration, test target, label-review counts, and execution references

Local paths and known secrets are stripped before writing.

## 4. Dataset (version 2.0.0)

| File | Cases | Notes |
|---|---|---|
| `planning.json` | 21 | clear, multiple criteria, positive/negative/boundary/authorization, input validation, ambiguous (surfaced and ignored), missing criteria, conflicting, untestable in this environment, unsupported assumptions, traceability errors, malformed output, embedded instructions, invalid input. Fields: expected outcome, scenario categories, required coverage, prohibited assumptions, expected clarification behaviour, `liveApplicable`. |
| `generation.json` | 19 | structural and security cases plus 9 assertion-quality cases, with reference required assertions and weakness labels |
| `functional.json` | 4 suites, 29 reference outcomes (15 defect-present, 14 defect-free) | pinned candidate specs (some deliberately weak or incorrect), a 6-defect catalogue, per-variant expected outcomes |
| `failures/` | 3 real Playwright reports, 15 labelled failures across all 9 categories, 3 controls | product regression, incorrect assertion, locator, auth/setup, test data, environment, timeout, flaky, insufficient evidence |

**Seeded defects.** The demo site's `problem_user` and `error_user` accounts are intentionally broken. Phase 2 can now run an approved test with the session signed in as a policy-listed variant (`standard`, `problem`, `error`). The catalogue covers six defects:

- D-SORT (sorting)
- D-ADD (add Bolt T-Shirt)
- D-REMOVE (remove Backpack)
- D-LASTNAME (last-name typing)
- D-LASTNAME-VALIDATION
- D-FINISH

`eval/probes/seeded-defects.ts` checks each defect on all three accounts with raw selectors, independent of the agent's page objects and tests. Last result: 18/18 checks matched, twice each.

**Versioning.** Bump `manifest.json` → `datasetVersion` and add a changelog entry for any change. A content change without a version bump shows up as a note in comparisons.

## 5. Metric definitions and results

Every metric in `report.json` carries its definition and source. The results below come from the committed baselines, and all were reproduced on repeated runs.

### 5.1 Test-generation correctness

Structural, semantic and functional results are reported separately.

**Structural** (deterministic mode, recorded outputs):

| Measure | Result |
|---|---|
| Planning expectations | 21/21 |
| Generation expectations | 19/19 |
| Schema validity | 18/19 (one malformed by design) |
| TypeScript validity of rendered files | 15/15 |
| Convention compliance | 15/15 |
| Traceability annotations | 15/15 |
| Scenario traceability | 35/39 |

**Semantic** (reference-based, deterministic). These checks go beyond the agent's own validators:

| Check | Result | Cases the checks catch |
|---|---|---|
| Required coverage met | 2/3 | PL-17 omits every validation scenario but declares the gaps, so it passes structural validation |
| Expected scenario categories present | 4/5 | PL-17 |
| Plans free of prohibited assumptions | 3/4 | PL-21 invents a "Check your email" confirmation that is traceable but unsupported |
| Clarification behaviour | 4/7 | PL-05 ignores vague terms; PL-19 silently resolves a contradiction; PL-21 should declare the untestable criterion |
| Required assertions satisfied | 9/15 | deliberately weak cases |

**Functional** (seeded defects; the pinned specs actually run):

| Measure | Result |
|---|---|
| Outcomes matching the reference | 24/29 |
| Defect-free control passing | 10/11 (the failure is the deliberately incorrect FS-LOGIN SC-02) |

### 5.2 Assertion quality

There are 9 deterministic rules:

- `AQ_MISSING`
- `AQ_NAV_ONLY`
- `AQ_VISIBILITY_ONLY`
- `AQ_NEGATIVE_ONLY`
- `AQ_UNTRACED`: the expected value is not stated in the linked criteria. Numbers are matched as digits or words.
- `AQ_WEAK_PARTIAL`
- `AQ_CONTRADICTORY`
- `AQ_REDUNDANT`: an identical assertion with no action in between.
- `AQ_UNSTABLE_URL`: an over-broad pattern, query strings, or ids.

Each finding records the scenario, requirement, expected behaviour, observed assertion, weakness, evidence, method and uncertainty.

Results:

- Against the 15 labelled specs: exact agreement 15/15, with no false positives or negatives per rule.
- The labels and the rules were written by the same author, so this agreement is optimistic. It shows the rules do what they were designed to do. It does not show independent validity.
- On the functional suites, the rules flagged **all 4 tests that missed seeded defects** (4/4).
- They also flag a correct test: `toBeHidden` on the cart badge is reported as `AQ_VISIBILITY_ONLY`. That is a known false positive of the rule.

An optional LLM judge (`--judge-model`) grades each assertion as adequate, weak, unrelated or incorrect. It refuses to judge with the same provider and model as the agent, its verdicts are `ai-judgment` metrics with no gate, and it is **unverified** (never run with a live model).

### 5.3 False positives and false negatives

Definitions, measured on the 29 functional reference outcomes:

- **Detection.** Positive class: *a relevant seeded defect exists for the behaviour under test*. Predicted positive: *the generated test failed*. A false-positive failure is a failing test where the behaviour is correct. A false negative is a passing test despite a relevant defect.
- **Diagnosis.** Over failed tests only. Positive class: *the failure is caused by a seeded product defect*. Predicted positive: *the analysis says `product_behavior`*.

| | Defect present | No defect |
|---|---|---|
| **Test failed** | TP 11 | FP 1 |
| **Test passed** | FN 4 | TN 13 |
| Inconclusive | 0 | 0 |

- Recall is 11/15 (73%, 95% Wilson interval 48–89%).
- False-positive rate is 1/14 (7%, interval 1–31%).
- The 4 false negatives are the two deliberately weak candidates (FS-SORT SC-03 counts items, FS-CART SC-04 checks the page title), each run on two defective accounts.
- The false positive is the deliberately incorrect FS-LOGIN SC-02.
- These figures describe the pinned specs and the pipeline. They are **not** a model's defect-detection rate.

Diagnosis confusion: TP 2, FN 9, FP 0, TN 1. **The rule-based analysis labelled only 2 of 11 defect-caused failures as product defects.** It called the others `locator` (6, mostly "element not found" when a broken page never shows the expected element), `assertion_logic` (2, where the expected value is not quoted in the criterion) or `inconclusive` (1).

### 5.4 Tool-error recovery

17 deterministic fault scenarios run against the real workflow, using mocks, spawner doubles and two real local processes. All 17 meet their expected safe behaviour.

| Area | Scenarios | Expected safe behaviour |
|---|---|---|
| Provider | timeout, 429-then-ok, 5xx×2-then-ok, persistent 5xx, malformed JSON, schema-invalid, auth | Transient errors retried up to 3 attempts. Recovered after 1 and 2 retries; mean recovery latency 23 ms with 10–40 ms test backoff. Malformed, schema and auth errors are not retried. |
| Runner | missing executable, invalid Playwright config, test timeout, wall-clock limit (process group killed at 1.5 s), missing artifacts, failed assertion | Each surfaces as inconclusive or failed, never passed. Evidence is preserved and errors propagate to the evidence (e.g. ENOENT, the config error). Failed assertions are never retried. |
| Authorization and duplicates | no approval, file tampered after approval, production-like target, duplicate execution | The runner never starts, or starts exactly once for the duplicate. |

Every scenario terminated within its limit.

### 5.5 Failure-analysis accuracy

The rule-based classifier was run on 15 labelled real failures. Labels are mapped to the classifier's vocabulary; `auth_setup` and `test_data` share one category.

| Measure | Result |
|---|---|
| Accuracy | 8/15 (insufficient data) |
| Macro recall | 0.52 |
| Label in top category or alternatives | 11/15 |
| Evidence grounding | 14/14 |
| Evidence relevance | 14/14 |
| Uncertainty identified when the label says evidence is insufficient | 9/10 |
| Escalation on insufficient evidence | 1/1 |
| Unsupported root-cause claims (wrong with high confidence or "sufficient evidence") | 0 |

Per category:

| Category | Recall | Precision |
|---|---|---|
| environment | 2/2 | 2/2 |
| inconclusive | 1/1 | 1/1 |
| locator | 2/2 | 2/7 (overused) |
| product_behavior | 1/3 | 1/1 |
| assertion_logic | 1/2 | 1/2 |
| test_data_setup | 1/3 | 1/1 |
| timeout_sync | 0/1 | — |
| flaky | 0/1 (not analysed) | — |

Errors observed:

- Product regressions and slow pages that show up as "element(s) not found" are called `locator`.
- An incorrect count (F-09) is called `locator`, because the Playwright call log contains "resolved to 0 elements".
- A locked session account (F-15) is called `assertion_logic`.
- Flaky tests are never analysed.
- An expected value counts as "from the requirement" if it appears anywhere in the criterion prose.

Model-assisted analysis is compared against these rules in live mode only. It has not been run.

### 5.6 Cost and latency

Functional mode measured 10 workflows:

| Measure | Result |
|---|---|
| Total median | 8.4 s |
| Total p90 | 12.6 s |
| Total max | 17.4 s |
| Playwright runner median | 7.7 s |
| Retries | 0 |
| Workflow failures | 0/10 |

Ten samples are not a distribution, and the reports say so. Model latency is `not-run` and tokens and cost are `unavailable`, because the model was a mock.

`eval/pricing.json` lists Anthropic list prices effective 2026-10-06 and states what it excludes. Cost is computed only from provider-reported tokens: (input × input price + output × output price) / 10⁶. Live mode will report:

- tokens
- per-workflow, per-successful-workflow and per-operation cost
- retry overhead
- failure rate
- model latency, separate from Playwright and total time

**No real cost or token figure exists yet.**

### 5.7 Reproducibility and regression

Deterministic reports were identical across 3 runs. Functional outcome counts were identical across 4 runs; only latency moved.

Each metric has a gate rule, and the baseline's gate is the one applied, so a run cannot loosen its own gates:

- `exact` for deterministic and outcome counts, because any change means behaviour changed
- `none` for timing and AI judgments
- `no-regression` is available for future live metrics

Comparisons note dataset, metric-version and model changes and make no significance claims. To update a baseline, rerun the mode, copy `eval-results/latest-<mode>.json` to `eval/baselines/`, and commit it with the reason.

## 6. CI quality gates

`.github/workflows/playwright.yml` runs:

1. lint
2. type-check
3. agent unit tests
4. `npm run test:eval` (dataset schema, metrics, assertion rules, cost, compare and report schema, fault injection, runner and gates)
5. `npm run eval` (deterministic, baseline-gated)
6. UI/API tests and agent and evaluation integration
7. the seeded-defect probe
8. `npm run eval:functional` (baseline-gated)

Reports are uploaded as artifacts. Live evaluation is the separate, manual `live-eval.yml`, with repeat and judge-model inputs. Nothing in CI approves releases or merges generated code, and AI-judgment metrics can never gate.

## 7. Limitations

- **0 of 62 labels are human-reviewed.** To review one, set `review: { status: "human-reviewed", reviewer, date }` in the dataset and bump the version.
- **No live-model evaluation has been run**, so there is no model-quality, token or cost data. The live path is tested only with a mock standing in for the model.
- Planning, generation and functional inputs are hand-written stand-ins for agent output. They exercise the pipeline and the evaluator, and they show the kind of weaknesses a model could produce. They say nothing about how often a model produces them.
- The samples are small: 15 labelled failures, 29 functional outcomes and 10 workflows. Accuracy and rates are marked insufficient-data where the denominators are under 30 (analysis) or 10 (rates), and nothing here supports a reliability claim.
- The test target is a public demo site with no version. Seeded defects are its own intentionally broken accounts, verified by the probe but outside our control.
- Assertion rules and labels share an author. The prohibited-assumption check is a keyword proxy.

## 8. Next steps (not implemented)

Run the live evaluation with repeats and an independent judge model, and have a person review the reference labels.

## 9. Changes to Phase 2 made for Phase 3

- `UsageRecord.tokensAvailable`: the mock provider no longer reports zero tokens.
- `PROMPT_VERSION` for report metadata.
- Policy `sessionVariants` plus the agent-only `session.agent-setup.ts`, so approved runs can use a seeded-defect account. The session state is stored inside the run directory, and the variant is recorded in evidence.
- The setup-failure rule now matches any `*setup` project.
- Two demo accounts were added to `src/data/users.ts`.
