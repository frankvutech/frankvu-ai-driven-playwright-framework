# Evaluation

| File | Contents | Provenance |
|---|---|---|
| `dataset/planning.json` | 15 requirement cases with expected properties of the planning step | requirements and `recordedOutput` are hand-written; no model produced them |
| `dataset/generation.json` | 10 cases with expected spec accept/reject decisions | hand-written |
| `dataset/failures/playwright-report.*.json` | 2 Playwright JSON reports (8 tests) | genuine runs against www.saucedemo.com on 2026-10-18, using deliberately constructed tests; local paths replaced with `<repo>` / `<home>` |
| `dataset/failures/labels.json` | expected status, scenario and failure category for each test | author-assigned, from how each failure was constructed |

Expectations are properties, not exact text. Examples: "outcome is `plan_rejected` and issues include `untraceable_scenario`", "coverage ≥ 1.0", "spec for SC-01 is rejected with `literal_secret`".

## Deterministic evaluation: `npm run eval`

This replays the recorded outputs through the real pipeline: schemas, plan validation, catalog validation, renderer, static validation, evidence parsing, state derivation and rule-based analysis. It writes `eval-results/deterministic.json`.

It exits non-zero when any case expectation fails, when any evidence row is misread, when a false pass appears, or when any evidence reference points at a file that doesn't exist.

Failure-analysis agreement is reported but not gated.

What it measures: the deterministic machinery. What it does **not** measure: how good any model is.

## Live evaluation: `RELYNX_LIVE_EVAL=1 npm run eval:live`

This sends the planning requirements to the configured Anthropic model, generates specs for valid plans, and statically validates them. It never executes generated tests. It writes `eval-results/live.json` with metrics and per-case rows.

It needs credentials and costs money, so it runs in CI only through the manual `Live model evaluation` workflow. One sample per case is not enough to call a model reliable. Repeat runs and compare before drawing conclusions.

## Limitations

- These datasets are small. Treat the ratios as regression signals, not statistics.
- There is one labeller, and no inter-rater agreement.
- Calibration is not computed.
- No LLM-as-judge is used. If one is added, treat its scores as a second opinion, not ground truth.
