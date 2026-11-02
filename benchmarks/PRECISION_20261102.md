# ReviewForge precision-focused shadow benchmark — November 2, 2026

## Why this sample exists
The previous synthetic blind review (#8, sandbox PR #3, HEAD `19037e91babc7ab48e4b6cffa4cc4e53b792bd91`) was completed at one model batch with **3 of 3 pre-registered runtime bugs** found plus one additional source-supported test-quality issue, with zero findings on its two designated clean controls and zero comments posted. This is a useful *observed synthetic result*, not a measured population recall or precision statistic.

This next sample intentionally reduces bug density and expands negative controls:
- Review target: `ibboabdoli-ai/reviewforge-sandbox`, draft PR #4, HEAD `d7fbf0ae810cdee283996e2db3ca691332a96396`.
- Five independent runtime modules with standalone tests; only **one** known functional edge-case is intentionally seeded, while **four** modules serve as healthy control candidates.
- The canonical pre-registered reference is `sandbox-precision-20261102-gold.json`, committed to ReviewForge (a separate repository) **before any paid model request** for this SHA.
- No golden answers, expected defect descriptions, or ReviewForge review results are included in the sandbox repository.
- CI must pass at this exact SHA. Tests passing is expected and is not evidence the PR is defect-free.
- Review must be manually triggered once, against the exact HEAD, in `dry-run` mode with one bounded model batch, no GitHub comments, no PR merge and no Proffera changes.

## Interpreting results
Use the offline evaluator with a sanitized record after the single review is completed:

```sh
node benchmarks/score-precision.mjs sanitized-review-record.json
```

The evaluator requires exact PR, SHA, status and no-post, then reports the number of pre-registered runtime bugs matched and enumerates findings on controls for **manual adjudication**. It must not treat every extra finding as a false positive. If a genuine bug is found in a presumed healthy control, update the independent truth assessment and document it rather than suppressing the finding.

One deliberately constructed PR cannot establish real-world precision, accuracy or suitability to replace CodeRabbit. Do not run repeated reviews of the same commit to tune against the benchmark.
