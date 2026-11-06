# Controlled comparison protocol — 2026-11-06

This is an offline protocol and witness runner, not authorization to spend on AI.
No new model review, CodeRabbit command, merge, deployment or Proffera change was
performed for this audit. Passing engineering tests does not establish AI accuracy.

## Reuse the existing evidence

| Fixture | Immutable head | Existing ground truth | Interpretation |
| --- | --- | --- | --- |
| sandbox PR 2 | `c0f62392822f72d122370753623dda483559130b` | `benchmarks/sandbox-blind-20261031-gold.json` at ReviewForge `cdd2bbeec51bf22d8f264fcb2bd2c35e8e15209b` | Three runtime defects; test gaps are supporting evidence |
| sandbox PR 3 | `19037e91babc7ab48e4b6cffa4cc4e53b792bd91` | `benchmarks/sandbox-mixed-blind-20261102-gold.json` and scorer/tests at `1ef76e493c45faa3524063885205851b99b25ec6` | Three runtime defects plus clean controls |
| sandbox PR 4 | `d7fbf0ae810cdee283996e2db3ca691332a96396` | `sandbox-precision-20261102-gold.json` in this branch | One pre-registered runtime defect, four clean source controls |
| Proffera PR 962 | `a83c202335eb602d6b1c5858a984eaa105f5d169` | `proffera-pr962-gold.json` | Retrospective selected CodeRabbit references; one runtime pattern plus a linked test gap |

The PR 2/3 gold branches are unmerged. Recover their existing artifacts with
`git show <commit>:<path>`; do not recreate the same benchmark under a new name.
Keep gold and independent witnesses outside the target review branch/context.

Run the new deterministic witness against an existing local sandbox checkout:

```sh
node benchmarks/verify-sandbox-precision.mjs ../reviewforge-sandbox
node benchmarks/score-suite.mjs
```

The witness reads only the pinned PR 4 fixture with `git show`, executes its
inspected Node tests in temporary directories, and deletes those directories.
It confirms the timestamp-tie pagination loss. It also shows that the original
suite accepts both a broken overlap predicate and a hardcoded retry schedule,
while independent counterexamples reject them. A temporary cursor repair passes
the original tests and the new witness; this is not a model-generated patch.

Observed on 2026-11-06: all three witnesses passed. Of the three historical
ReviewForge findings, one runtime defect and two supplementary test gaps were
confirmed. No false alarm was found among these three findings. Do not count
the gaps as two additional pre-registered runtime defects or claim population
precision from this one deliberately constructed PR. CodeRabbit has no paired
result available on this PR/SHA. The existing three-PR retrospective scorer
matches 3/11 selected cases across different model/method versions; this is not
an accuracy estimate or a controlled comparison.

## Corpus specification

All new rows below are planned fixtures, not executed AI evaluations. Preserve
existing rows rather than resetting their results. Each new defect needs a
minimal failing behavioral witness, a repaired twin that passes the witness,
and realistic surrounding code without answer-revealing names or comments.

| Category | Existing reusable seed or new witness to implement |
| --- | --- |
| Authentication/authorization | PR 2 workspace-boundary seed; a different tenant must not obtain the record |
| Injection | New parameterized-query twin vs concatenated query; malicious identifier stays data |
| Data leak | New response projection twin; another user's secret field never enters serialized output |
| Input validation | New NaN/negative/overflow amount fixture with observable rejected write |
| Business logic | PR 3 exact-capacity reservation and year-aware monthly totals |
| Race conditions | PR 3 clean awaited lock; new barrier-controlled double-reservation defect |
| State transitions | PR 3 publish failure must not permanently consume a delivery ID |
| Cross-file defects | PR 2 caller/callee retry-unit mismatch; pin both files and dependency path |
| Error handling | PR 2 swallowed persistence error and premature successful acknowledgement |
| Edge cases | PR 4 equal-timestamp cursor and reversed non-overlapping ranges |
| Regressions | PR 4 custom retry parameters; new fixed-twin mutation must break an independent test |
| CI/workflow security | New synthetic workflow: untrusted PR output passed to privileged continuation |
| Misleading approval evidence | Synthetic valid receipt plus malformed second marker based on PR 962; no Proffera writes |
| Large PR coverage | Same defect placed first/middle/last, across batch boundary and beyond capacity; verify explicit partial outcome |
| Harmless controls | PR 3 links/lock and PR 4 ledger/HMAC/range/backoff source; also docs-only and formatting-only changes |

## Pairing and execution rules

1. Record repository, PR, immutable base/head SHA, target diff hash, reviewer
   build, model/configuration, context policy and plan before each attempt.
   Both products must review the same base/head pair. Freeze the branch.
2. Pre-register case IDs, severity, exact witness, allowed evidence and repaired
   twins before seeing outputs. Do not feed gold, adjudication or prior reviews
   to either product. For new tests, separate targets without public answer
   comments and record contamination limitations for old public fixtures.
3. Blind the adjudicator to reviewer identity. Randomize display order; record
   randomization seed. Verify findings against executable behavior, not keyword
   matches alone. Have a second person adjudicate critical or disputed cases.
4. One declared attempt per product per head. Record failed, partial, timed-out,
   truncated and quota-blocked attempts. Never quietly retry until a pass.
   Provider errors and every retry belong in the denominator and cost ledger.
5. Use existing allowlists and spending controls. Default to shadow mode; never
   post approvals. No live run until an owner approves the concrete corpus,
   provider accounts, maximum attempts and hard currency limit. No budget or
   model-cap changes are implied by this document.
6. First live stage proposed: four paired PRs (eight review attempts), with at
   most one ReviewForge model batch per PR and a proposed total ceiling of $10.
   This is a proposal only; verify current provider pricing before approval.
   CodeRabbit may use undisclosed internal calls, so an attempt is not a model
   call. Keep ReviewForge's current daily limit unchanged. Large/multi-batch
   tests are a separately approved stage, not squeezed into this allocation.

## Evidence and scoring contract

Archive sanitized structured snapshots with these fields:

```json
{
  "repository": "owner/authorized-sandbox",
  "pr": 1,
  "baseSha": "40 hex characters",
  "headSha": "40 hex characters",
  "reviewerBuild": "immutable revision or provider version/date",
  "model": "reported identifier or unknown",
  "configurationDigest": "sha256 of nonsecret review policy",
  "attempt": 1,
  "status": "completed",
  "coverage": {"complete": true, "eligible": 10, "analyzed": 10, "excluded": []},
  "timing": {"queuedAt": null, "startedAt": null, "finishedAt": null},
  "usage": {"reservedCalls": 1, "actualCalls": null, "inputTokens": null, "outputTokens": null, "costCurrency": "USD", "cost": null},
  "findings": [],
  "adjudication": {"truePositiveCases": [], "falsePositiveFindings": [], "duplicates": [], "supplementaryTestGaps": [], "unresolved": []}
}
```

Null means unknown, never zero. Do not put tokens, private source or customer
records in exported evidence. Preflight-selected files are not analyzed files.
An aggregate `coverage.complete` cannot substitute for listing exclusions.
The stricter `scoreReviewQualitySameHead` now requires `status: completed` and
`coverage.complete: true` in addition to exact identity. Earlier snapshots
without evidence of those fields must be rejected, not upgraded by assumption.

- Precision: genuine adjudicated findings / all adjudicated reported findings;
  count duplicates separately. Report runtime and test-gap precision separately.
  Unresolved findings remain visible and yield bounds, not assumed true positives.
- Recall: distinct detected pre-registered defects / all eligible gold defects.
  One root cause appearing in production code and its tests counts once in
  primary runtime recall. Report missing coverage and a separate end-to-end
  result; do not omit partial/failed PRs to inflate recall.
- Critical recall: same calculation only for independently assigned critical
  cases. With no critical cases, report N/A, not 100% or 0%.
- False positives per PR: adjudicated false findings / all attempted PRs, with
  separate clean-control rate. A finding outside gold is not automatically false.
- Coverage: eligible hunks/files actually analyzed; excluded, unsupported and
  omitted segments separate. A large PR declared partial is a reliability result,
  not evidence all defects were examined.
- Latency: queue delay and model/execution duration separately; include timeouts.
- Cost: recorded provider usage/billing, including failures and retries; quota
  reservations are neither actual model calls nor money spent.
- Fix correctness: apply a candidate to a disposable checkout, run an independent
  witness that failed before, all relevant regression tests and a fresh re-review.
  Record unsafe/new failures; never equate plausible patch text with correctness.

Publish case-level outcomes and paired counts before aggregate percentages.
Small/selected samples do not establish superiority. Report uncertainty and
selection bias; use a held-out corpus before making comparative marketing claims.

## Minimal future repair workflow (proposal)

Keep review independently usable. Add optional suggestion text only after a
validated finding and frozen head. A separate human-approved operation may
create a patch in a disposable worktree with no deployment credentials, no
network by default, and a strict file/size allowlist. Run the independent
regression witness, relevant tests, secret checks and a fresh review at the new
SHA. A separate draft PR can carry the diff and evidence. Humans approve any
merge. Do not allow the repair agent to alter tests merely to silence failures,
change policies/secrets/workflows, or self-approve. Escalate those changes for
explicit review. No unrestricted repair engine is implemented here.
