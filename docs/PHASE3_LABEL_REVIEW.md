# Phase 3 dataset — label review (2026-10-19)

**Status: AI-agent review, recommendations only.** At Frank Vu's request, an AI agent reviewed every reference label in `eval/dataset/` (version 3.0.0) against its requirement, acceptance criteria, application behaviour and recorded execution evidence. No human has reviewed or confirmed any label yet, so **no label was marked `human-reviewed`**. The agent also helped write the labels, so this review is not independent. Every recommendation below needs confirmation by an authorized person.

**Follow-up applied (dataset 3.0.1), see §6.** Frank Vu decided the relevance policy and approved the factual fixes. He has not yet confirmed any label as reviewed, so all 104 labels are still `pending`.

## 1. Counts

A "label" is one `labels` / `provenance` record. For functional data that is one per suite, and the 6 suite labels cover 62 per-variant reference outcomes.

State after the follow-up (dataset 3.0.1). "Corrected outcome" means a changed reference outcome; "metadata fixed" means a provenance or note correction that changes no outcome.

| Dataset | Labels | Human-reviewed | Pending | Corrected outcome | Metadata fixed | AI: recommend confirm | Still open |
|---|---|---|---|---|---|---|---|
| Planning | 25 | 0 | 25 | 0 | 7 (provenance) | 23 | 2 (PL-18, PL-20) |
| Generation | 31 | 0 | 31 | 0 | 8 (provenance) | 31 (see the caveat in §3) | 0 |
| Failures | 27 (23 labelled + 4 controls) | 0 | 27 | 0 | 0 | 25 | 2 (F-05, F-20) |
| Functional | 6 suites / 62 outcomes | 0 | 6 | 0 | 2 (suite note; relevance policy recorded) | 5 suites | 1 (FS-NOTESUI: drift interpretation) |
| Healing | 15 | 0 | 15 | 0 | 0 | 12 | 3 (HE-10, HE-12, HE-14) |
| **Total** | **104** | **0** | **104** | **0** | **17** | **96** | **8** |

## 2. Evidence used

- Requirement and acceptance-criteria text in each case.
- Recorded model outputs and pinned specs in the dataset.
- **Execution evidence**:
  - the committed baselines (`eval/baselines/*.json`), with functional detection counts identical across 3 runs and healing outcomes identical across 3 runs;
  - the 9 recorded Playwright reports in `eval/dataset/failures/`;
  - the seeded-defect probe (`npm run eval:probe-defects`, 36/36 checks matched, twice each);
  - Phase 1 UI and API tests passing against the live targets.
- The deterministic evaluator's own results (all 25 planning and 31 generation expectations hold). These show that the pipeline behaves as the labels say. They do not show that the labels are right.

## 3. Per-dataset findings

### Planning (25)

| Labels | Recommendation | Evidence |
|---|---|---|
| PL-01, PL-02, PL-04, PL-05, PL-10, PL-14, PL-16, PL-17, PL-22, PL-24, PL-25 | confirm | Expected outcomes, scenario categories, coverage and clarification behaviour follow from the criteria. Messages and values match execution: the lockout text is exact in FS-LOGIN SC-01, which passes; "Products" is exact in Phase 1 `login.spec.ts`; the $29.99 Backpack price is in FS-SORT AC-2. |
| PL-03 | confirm | The outcome does not depend on the wording. Note: the exact error text with the "Epic sadface: " prefix is only verified as a substring by Phase 1 (`login.spec.ts`). |
| PL-06, PL-07, PL-08, PL-09, PL-11, PL-12, PL-13, PL-15, PL-19, PL-21, PL-23 | confirm | The outcome follows from how the case was built (malformed output, untraceable, unknown criterion, silently dropped criterion, foreign scenario, invalid input, silent conflict resolution, invented confirmation, unsupported layer). |
| **PL-18** | **needs decision** | Conflicting criteria (AC-1 stays on the login page; AC-2 reaches the product list). The reference expects the planner to proceed with AC-1 and declare AC-2 uncovered (`surface-ambiguity`). It is equally defensible to require `ask-before-planning`, i.e. no plan until the conflict is resolved. |
| **PL-20** | **needs decision** | Password reset. The reference requires only AC-1 (an email) to be declared uncovered. The recorded plan also declares AC-2 (a "Forgot password?" link the target does not have). Is AC-2 untestable here, or testable with a test that is expected to fail and so shows the requirement does not hold on this target? |

Minor: PL-01 types the locked-out scenario as `authorization`, not `negative`. That is a convention choice, and the expected types follow it. PL-02 reuses the id REQ-201, which `examples/requirements/` also uses for an unrelated requirement. This is cosmetic: dataset requirement ids are scoped to their case.

### Generation (31)

| Labels | Recommendation | Evidence |
|---|---|---|
| GE-01 … GE-19 (UI) | confirm | Accept/reject decisions follow the catalog and validators. Weakness labels match the specs: visibility-only (GE-10, GE-18), navigation-only (GE-11, GE-16), untraced "Our Products" (GE-12), contradictory (GE-13), redundant (GE-14), partial "Epic" (GE-15), negative-only (GE-16), over-broad URL (GE-17), none (GE-19). The required assertions quote the criteria. |
| GE-20, GE-28 (correct API) | confirm | Statuses and fields are as stated in the criteria. The JSONPlaceholder post 1 → userId 1 and post 101 → 404 behaviour is verified by Phase 1 `posts.spec.ts`. |
| GE-21, GE-22, GE-23 (incorrect intent) | confirm | GE-21 asserts status only, so the owner and error code are missing. GE-22 expects 200 against "answers 201", and 404 against "answers 403". GE-23 asserts no status. Each `incorrect` intent label is backed by an explicit criterion. |
| GE-24, GE-25, GE-27, GE-29, GE-30, GE-31 | confirm | Constructed rejections: tautological expectation, unknown endpoint, combined test without API steps, assertion on the token, duplicate spec, unknown scenario. |
| GE-26 (combined) | confirm | AC-1 "the note is listed" is checked by visibility of the note with that exact title. The reference requires only the API status. That is lenient but not wrong. |

**Caveat for every weakness and intent label:** the same author wrote the assertion rules and these labels. The 30/30 rule-label agreement reported in the evaluation is therefore partly circular. Before confirming, a human should label a sample of specs **without looking at the rule output**. Minor: GE-18 checks the Login button for a locked-out user. It is labelled visibility-only; a reviewer might also call it unrelated to the error message the criterion requires.

### Failures (27)

| Labels | Recommendation | Evidence in the recorded report |
|---|---|---|
| F-01, F-09, F-18 (incorrect assertion) | confirm | Expected "Our Products", received "Products"; expected 5, received 6 items; expected 200, received 201. In each, the criterion states the received value. |
| F-02, F-07, F-08 (product regression, storefront) | confirm | The failures match catalogued defects D-SORT, D-ADD and D-FINISH, which the probe confirms on those accounts. |
| F-16, F-17, F-19, F-22 (product regression, example app) | confirm | 500 instead of 201; 200 instead of 403; 201 instead of 400 (F-19's first error; a second, cleanup schema error follows); the note never appears after a 500 on save. Each variant is confirmed by the probe. |
| F-03, F-10, F-21 (locator) | confirm | `promo-banner` and "Add all to cart" do not exist; the button was renamed, as the page snapshot shows. |
| F-04, F-12 (environment) | confirm | `ERR_UNSAFE_PORT`, `ERR_NAME_NOT_RESOLVED`. |
| F-06, F-15 (auth/setup) | confirm | A wrong password in setup; a locked account used as the session. Note: F-15 could equally be `test_data`, but both map to the same classifier category. |
| F-11 (test data) | confirm | "Sauce Labs Hoodie" is not in the six-product catalogue, consistent with FS-SORT AC-2. |
| F-13 (flaky), F-14 (insufficient evidence), F-23 (timeout) | confirm | Fails then passes on retry; a generic `Unexpected state` error; "Received: hidden" on an element that is present. |
| P-01 … P-04 (controls) | confirm | Statuses passed, skipped, passed and passed in the reports. |
| **F-05** | **needs decision** | Labelled `timeout` (performance_glitch_user signs in slowly). The report shows only "element(s) not found" within 1 s, which does not tell a slow page apart from a missing element. The label relies on knowing that account's behaviour, which nothing in the report records. P-03, the same account with 3 s, passed, which is consistent with the label but not proof. |
| **F-20** | **needs decision** | Labelled `product_regression`. The test's own assertion (content type) passed. The recorded failure is the cleanup fixture's schema check rejecting the 121-character note. The root cause is the missing validation, but the failing component is test infrastructure, so `test_data` (setup/cleanup) is also defensible. |

### Functional (6 suites, 62 outcomes)

| Suite | Recommendation | Evidence |
|---|---|---|
| FS-SORT, FS-CART, FS-CHECKOUT, FS-LOGIN | confirm | relevantDefect follows the defect catalogue, which the probe verifies on all three accounts (18/18). Observed outcomes were identical across 3 runs. The deliberate false negatives and the false positive are as the suite notes describe. |
| **FS-NOTESAPI** | **resolved in 3.0.1** (confirm when reviewing) | (1) **Relevance definition.** Under `broken-create`, SC-03 (another user's note is forbidden) is labelled relevant because note creation in its setup fails. The documented definition is "a relevant seeded defect exists *for the behaviour under test*", and creation is a precondition of SC-03, not its behaviour under test. SC-01 and SC-06 test creation directly, so relevant is correct for them. (2) **Suite note is wrong.** It says SC-05 and SC-06 "show a false negative and false-positive failures". The execution evidence shows SC-05 *failed* under `no-title-limit` (via the cleanup fixture), so it is a true positive, not a false negative. The labels themselves are consistent; the note is not. |
| **FS-NOTESUI** | **(1) resolved in 3.0.1; (2) still open** | (1) Under `broken-create`, SC-01 ("Given a note created through the API…") and SC-03 (bob's note is not listed) are labelled relevant, but creation is their precondition, not their behaviour under test. SC-02 creates through the UI, so relevant is correct for it. (2) `renamed-add-button` SC-02 is labelled defect-free, which makes the observed failure a false positive. That is correct if a renamed button is drift, not a product change; confirm that interpretation. |

Changing the relevance labels would move up to 3 outcomes from TP to FP. The reference schema requires that a defect-free outcome expects the test to pass, so those failures would count as false positives. One option is to add a third reference state, "not verifiable because a precondition is broken". That would be a schema change, outside this review.

### Healing (15)

| Labels | Recommendation | Evidence |
|---|---|---|
| HE-01 … HE-08 (UI drift) | confirm | The page snapshot shows `button "Save note"` where the page object expects "Add note". The reference fix, a role button named exactly "Save note", is the element the snapshot shows, and verification passed 2/2. The wrong (Sign out), absent (Publish), wrong-role (heading), declined, malformed, timed-out and assertion-deleting proposals have the expected outcomes. |
| HE-09, HE-11 (product defects) | confirm | 500 on create, and 201 instead of 400, both probe-verified. Reference `not_applicable`, observed `not_applicable`. |
| HE-13, HE-15 | confirm | The wait comes after the failing step, so validation fails; the test passes on `standard`, so there is insufficient evidence. |
| **HE-10** | **needs decision** | The authorization bypass is a probe-verified product defect. The reference `not_applicable` is the ideal outcome. The observed outcome is `insufficient_evidence`, because the classifier does not read `toEqual([403, 403, 403])` diffs. Both outcomes stop safely. Should the reference stay as the ideal (it is currently counted as a mismatch), or name the safe-stop set? |
| **HE-12** | **needs decision** | The reference treats a list that appears after 6 s as a test-timing problem, fixed by a 10 s wait. The requirement (REQ-412 AC-1) states no timing, so a wait does not contradict it. But a 6 s delay could be judged a performance defect that should not be "healed". |
| **HE-14** | **needs decision** | The reference `not_applicable` follows the documented policy that waits are added only to generated tests. Confirm that policy is intended; the label is only as right as the policy. |

## 4. Provenance metadata (no outcome change; applied in 3.0.1)

These labels describe cases whose outcome follows from how they were built, but they were recorded as `author-judgment`. They are now `method: "constructed"`, with a note saying so.

- Planning: PL-07, PL-08, PL-09, PL-11, PL-12, PL-13, PL-15
- Generation: GE-02, GE-03, GE-04, GE-05, GE-06, GE-07, GE-08, GE-09

This changes only the `byMethod` counts in reports. No metric or gate reads them.

## 5. Decisions needed from an authorized human

1. **Confirmations.** For each label you agree with, set `review: { status: "human-reviewed", reviewer: "<your name>", date: "YYYY-MM-DD" }`. Recording a human confirmation is the only way a label becomes reviewed. This review does not do it.
2. **Relevance policy for broken preconditions** (FS-NOTESAPI SC-03, FS-NOTESUI SC-01 and SC-03 under `broken-create`). Keep "exposed on the execution path", the current labels? Or apply "behaviour under test", the documented definition? If the latter, decide whether to relabel or to add a "not verifiable" reference state.
3. **FS-NOTESAPI suite note.** Approve rewording it to match the evidence (SC-05 is detected through the cleanup fixture, not missed).
4. **PL-18, PL-20, F-05, F-20, HE-10, HE-12, HE-14**: the individual questions above.
5. **Provenance reclassification** (§4).
6. **How to apply changes.** Any change to a dataset file needs `manifest.json` → `datasetVersion` bumped (3.0.0 → 3.0.1 for metadata or notes; 3.1.0 if reference outcomes change) and a changelog entry. It also needs the dataset-version expectation in `tests/eval/runner.spec.ts` updated, and the baselines refreshed by an explicit, reviewed rebaseline, because comparisons across dataset versions report "rebaseline required".

## 6. Follow-up applied on 2026-10-19 (dataset 3.0.1)

Decisions by Frank Vu, given in chat on 2026-10-19:

| Decision | Applied as |
|---|---|
| No label is confirmed yet | All 104 labels stay `review.status: "pending"`. |
| Relevance of broken preconditions: keep the current labels | No reference outcome changed. The policy ("a seeded defect on the test's execution path, including a precondition the test exercises, counts as relevant") is recorded in the `labels.notes` of FS-NOTESAPI and FS-NOTESUI, and in the detection definition in PHASE3_EVALUATION.md §5.3. |
| Apply the factual fixes | The FS-NOTESAPI suite `notes` are reworded to match the evidence. 15 provenance methods (§4) changed to `constructed`. |

Mechanics:

- `manifest.json` → `datasetVersion` 3.0.0 → 3.0.1, with a changelog entry.
- The dataset-version expectation in `tests/eval/runner.spec.ts` is updated to 3.0.1.
- The baselines were regenerated after checking that the gated metrics are identical to the 3.0.0 baselines.

Still open: PL-18, PL-20, F-05, F-20, FS-NOTESUI drift interpretation, HE-10, HE-12, HE-14 (§3), and every confirmation (§5, item 1).
