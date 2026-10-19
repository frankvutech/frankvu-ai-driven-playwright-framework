# Evaluation

The methodology, metric definitions, results and limitations are in [docs/PHASE3_EVALUATION.md](../docs/PHASE3_EVALUATION.md).

```bash
npm run eval                                   # deterministic, gated against baselines/deterministic.json
AGENT_EVAL_APPROVER="Your Name" npm run eval:functional   # seeded defects: demo site + local example app
AGENT_EVAL_APPROVER="Your Name" npm run eval:healing      # guarded healing on the local example app
npm run eval:probe-defects                     # re-verify the seeded-defect catalogue (demo site + example app)
AGENT_LIVE_EVAL=1 npm run eval:live -- --repeat 3 [--judge-model <other-model>]
npm run eval:compare -- eval/baselines/deterministic.json eval-results/latest-deterministic.json
npm run test:eval                              # tests of the evaluation system itself
```

Options for every mode: `--pricing <file>` (default `pricing.json`), `--gates <file>` (default `gates.json`), `--baseline <report.json>`. Healing mode also takes `--case HE-01 --case HE-02`.

Dataset files live in `dataset/`, versioned by `dataset/manifest.json`. Every label records its provenance and review status, and **none is human-reviewed yet**.
