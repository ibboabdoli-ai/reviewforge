# ReviewForge quality gate before replacing CodeRabbit in Proffera

**No Proffera installation or automatic posting until quality is measured.**

Baseline: [proffera-baseline.json](./proffera-baseline.json).
Raw comment counts are not accuracy metrics.

## Blocking requirements

- Never claim a PR is clean if any relevant patch is inaccessible, omitted, or exceeds budget.
- Reviews must quote correct added-line numbers, with evidence and specific actionable change.
- Categorize security, authorization, billing, data integrity, test reliability, and regressions. Ignore style-only remarks.
- Protect secrets and customer data; require explicit permission and review before transmitting private Proffera diffs to an external model.
- Enforce model-call budget, repository allowlist, max retry, user authorization, and no duplicate posting on identical commit SHA.
- Sample a range of PRs: small bugfix, auth/billing, big frontend (50+ files), security, and refactor. Manually validate true/false positives.
- Run ReviewForge **read-only shadow evaluation first**; keep CodeRabbit until repeated reviews match or improve its *verified actionable* findings, with acceptable false positives and costs.
- No automatic change to Proffera merge protection, code-review requirements, or installed bots.

## Current limitation (expected)

Large reviews exceeding 35 files, 65,000 patch characters or 6,500 characters per file are flagged `partial`; ReviewForge does not post that incomplete result as a complete review.
Follow-up work: secure bounded multi-batch review and cross-file context with per-model-call budget accounting, scoring harness and evidence-grounded differential comparison.
