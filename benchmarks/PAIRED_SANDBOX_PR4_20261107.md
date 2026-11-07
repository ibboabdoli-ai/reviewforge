# Same-HEAD sandbox reviewer comparison — 2026-11-07

## Fixed target and strict interpretation

- Target: [reviewforge-sandbox PR #4](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/4), exact head `d7fbf0ae810cdee283996e2db3ca691332a96396`.
- The original pre-registered benchmark is `benchmarks/sandbox-precision-20261102-gold.json`, committed before the ReviewForge run. Its primary expected issue is the cursor timestamp tie-break; four candidate source modules are healthy controls.
- Archived ReviewForge review: Neon review ID **9**, completed 2026-11-03, `gpt-6.1-sol`, one batch, complete 11-file coverage, `posted=0`. This is **an older reviewer build**, not the current PR #8 build.
- CodeRabbit full review: 2026-11-07, requested once with free/OSS allowance, same immutable head, two actionable Major findings; no changes to target code or production.
- Never use this public, previously inspected example as an unseen post-improvement quality score; benchmark contamination and different review dates matter.

## Independent case-by-case comparison

| Behavior | Archived ReviewForge | CodeRabbit | Independent witness |
| --- | --- | --- | --- |
| Page continuation omits a record sharing the cursor timestamp because the ID tie-breaker is missing | Detected (review 9, `src/lib/audit-cursor.mjs:15`) | Detected ([inline finding](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/4#discussion_r4501849047)) | Supported by source and the pre-registered pagination witness |
| Valid ISO UTC timestamps with different fractional-second precision are compared as raw strings, reversing chronological order | **Missed** in archived review | Detected ([inline finding](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/4#discussion_r4501849044)) | Independently reproduced, see below |
| Reversed half-open-range tests do not kill a plausible broken guard | Reported as a *test-integrity gap*, not a runtime defect | Not reported | Independently corroborated earlier by a synthetic mutation witness |
| Custom retry/backoff bounds not protected by positive test assertions | Reported as a *test-integrity gap*, not a runtime defect | Not reported | Independently corroborated earlier by a synthetic mutation witness |

**Verified extra chronology counterexample (read-only Node execution):**

- `earlier.createdAt = "2026-11-02T09:00:00Z"`
- `later.createdAt = "2026-11-02T09:00:00.100Z"`
- `Date.parse(earlier.createdAt) < Date.parse(later.createdAt)` is **true**.
- The unchanged target function `pageAuditEvents([earlier,later])` returns **[later, earlier]**.
- `pageAuditEvents([earlier,later], earlier)` returns **[]**, even though `later` is chronologically after `earlier`.

This is a real, independently demonstrated defect in the *synthetic sandbox fixture*, not a production incident in Proffera.

## Reviewer-engine follow-up

The current ReviewForge PR #8 adds a small, reusable `pagination-ordering` review skill for cursor ordering, composite tie-breakers and timestamp instant-normalization checks, plus mocked model-request regression tests. It neither adds model calls nor sends fixture answers or gold labels to the review model. **Green unit/CI tests show only that the intended rule reaches the model request; they do not show that the newer model will actually detect the missed defect.**

## What must happen before a replacement claim

1. Use a separate fresh, held-out synthetic PR with preregistered truth not present in review instructions and no answer-revealing names.
2. Verify the same exact base/head and full review coverage for both tools, log both failures/partial results, and independently adjudicate findings.
3. Record costs, model version, time and true/false positives. A failed/partial review counts against reliability.
4. Keep CodeRabbit as the primary review gate until multiple independent, appropriately sized comparisons support substitution.

**Spending:** The comparison above reused one older archived ReviewForge response and one newly requested free CodeRabbit review. New ReviewForge paid model requests: **0**; observed newly incurred OpenAI API cost in this comparison: **$0**. The user-approved $10 ceiling remains a maximum authorization, **not** evidence that a technical billing hard cap is configured. Local development checkout has no `OPENAI_API_KEY` in its process environment or local `.env`, and the current PR #8 build is not deployed in an isolated test environment; therefore no fresh integrated-model review was attempted.
