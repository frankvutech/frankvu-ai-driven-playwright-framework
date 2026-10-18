# Evaluation

The methodology, metric definitions, results and limitations are in [docs/PHASE3_EVALUATION.md](../docs/PHASE3_EVALUATION.md).

```bash
npm run eval                                   # deterministic, gated against baselines/deterministic.json
RELYNX_EVAL_APPROVER="Your Name" npm run eval:functional   # seeded defects on the demo site
npm run eval:probe-defects                     # re-verify the seeded-defect catalogue
RELYNX_LIVE_EVAL=1 npm run eval:live -- --repeat 3 [--judge-model <other-model>]
npm run eval:compare -- eval/baselines/deterministic.json eval-results/latest-deterministic.json
npm run test:eval                              # tests of the evaluation system itself
```

Dataset files live in `dataset/`, versioned by `dataset/manifest.json`. Every label records its provenance and review status, and **none is human-reviewed yet**.
