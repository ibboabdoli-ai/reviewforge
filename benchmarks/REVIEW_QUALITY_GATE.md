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

## Multi-batch reviewer

ReviewForge now partitions diffs into <=6,500-character valid hunks and
groups them in <=65,000-character / 35-entry batches. Up to four model
batches are supported by default, with verified new-line anchors. Entire
batch count is reserved atomically against the daily model-attempt budget
before contacting the model. A 79-file PR typically needs at least three
model attempts: **the existing production daily cap of two means it cannot
run there until the cap is deliberately raised**. AI is still off.

## PR #953 quality baseline (offline)

- Golden set: proffera-pr953-gold.json, three reviewed cases from exact PR SHA.
- Earlier ReviewForge review #4 returned zero findings; this is the **0/3 observed baseline**, not a measured improvement.
- Run: node benchmarks/score-review.mjs to print the zero-findings baseline; optionally pass a local sanitized JSON findings file.
- Synthetic tests verify cross-file input, scoped project hints, risk routing, and zero GitHub posts. They do not run OpenAI or prove the new reviewer detects the cases.
- AI_CONTEXT_REPOSITORIES defaults to empty. Explicitly allowing a repository enables immutable SHA-pinned source snippets and stronger routing, which can increase model cost.
- Any project guidance or source excerpt is untrusted data. Only actual added diff lines can anchor a finding.
- New model reviews record model-suggestion counts and filtered-finding counts without storing raw model responses.
- Do not turn a 3/3 gold-set score into a general accuracy claim; test unseen PRs and false positives first.
