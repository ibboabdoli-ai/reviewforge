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

## Runtime behavior and test-effectiveness lens (2026-10-31)

- In an explicitly opted-in repository, the immutable HEAD context sampler now
  prioritizes up to three changed tests that overlap changed runtime modules.
- It resolves their local `@/` and relative imports and supported test mocks,
  retrieves up to three related implementations and keeps the overall 12k-char
  context cap. All fetched material stays untrusted and read-only.
- The model inspects two separate questions **in the same paid call**: (A) a
  demonstrable runtime counterexample, and (B) whether the test would fail if
  the relevant implementation broke in a realistic, specific way.
- This is a **static hypothesis check**, not actual mutation testing, test
  execution or proof that all relevant behaviors were covered.
- The synthetic fixture checks that the model input contains runtime/test
  guidance, links and immutable source excerpts without network, tokens or
  posting. `npm test` must pass before deployment.
- Existing `PR #953` and `PR #949` completed evaluations are not replayed.
  Their historical findings are not inputs to the live reviewer. A new real
  model-quality comparison requires separate user authorization and a cap.

## PR #944 shadow baseline and isolated mutation demonstrations (2026-10-31)

- Golden set: `proffera-pr944-gold.json`, two test-integrity defects
  independently checked against exact Proffera HEAD
  `9cd94db396b196b0a5d0818e8a066845704e5bac`.
- ReviewForge shadow review #6 used `gpt-6.1-sol`: **3 raw model
  suggestions, 2 accepted, 1 filtered**, 0 GitHub posts. The 2 accepted
  findings match the two confirmed narrow reference cases. This is an
  **observed 2/2 on one PR**, not a predicted detection rate or proof of
  general quality.
- The earlier CodeRabbit defect about fictitious workplaces (`aeTyp=3`)
  was fixed in this HEAD and its final review was approved; do **not**
  count that historical, already-fixed issue as a current open bug.
- `tests/pr944-mutation-demonstrations.test.mjs` uses **local synthetic
  functions**, not the actual Proffera implementation. It establishes
  that (1) a missing second mocked response can make the weak
  company-validation assertion pass even with the real guard removed,
  and (2) an HTTP-429-only assertion can pass after a simulated API-key
  disclosure. It also verifies that targeted negative assertions would
  reject both simulated mutations. This is evidence for an improved
  test design, **not an executable mutation result against Proffera**.
- Offline, no API, no GitHub post: `node benchmarks/score-review.mjs --pr 944`
  shows the 0/2 empty-findings baseline; supply a sanitized local
  findings JSON as a second argument to score a specific candidate.
  `node benchmarks/score-review.mjs --pr 953` remains supported.
- Gold sets and mutation fixtures must stay **outside the production
  review input and prompt**; never train or prime the model with
  expected answers before measuring unseen changes.
- Keep the ReviewForge runtime shadow-only. No Proffera changes,
  production database test data, or additional paid model calls here.
