# Same-HEAD sandbox comparison — PR #3 (2026-11-07)

## Scope and provenance

- Target: [reviewforge-sandbox PR #3](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/3), immutable HEAD `19037e91babc7ab48e4b6cffa4cc4e53b792bd91`; draft stayed unchanged. No test fixture source or Proffera code was modified.
- Pre-registered primary truth: `benchmarks/sandbox-mixed-blind-20261102-gold.json` from ReviewForge commit `1ef76e493c45faa3524063885205851b99b25ec6`, **three functional cases**, two presumed healthy-control modules.
- Archived ReviewForge run: Neon review ID **8**, completed 2026-11-02, model `gpt-6.1-sol`, 11 eligible files, one complete batch, four findings (three runtime, one supplemental test-integrity gap), no GitHub posting.
- CodeRabbit free/OSS review: requested once on 2026-11-07, completed [review submission](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/3#pullrequestreview-5812737036) against the same exact HEAD. It posted **five actionable suggestions**, represented by four GitHub inline comment objects (two suggestions in one comment).
- This is a retrospective **paired same-HEAD comparison of different reviewer versions and dates**. It is not a blind assessment of current ReviewForge PR #8, nor evidence that ReviewForge has surpassed CodeRabbit.

## Case-by-case outcome

| Verified case | Historical ReviewForge | CodeRabbit |
| --- | --- | --- |
| Exact-capacity ticket reservation rejected by `>=` | Found | [Found](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/3#discussion_r4502080767) |
| Failed delivery incorrectly reserves the ID and blocks retries | Found | [Found](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/3#discussion_r4502080753) |
| Monthly charges fail to filter the requested year | Found | [Found](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/3#discussion_r4502080758) |
| Invalid dot placement in an unquoted email local part is accepted | **Not reported** | [Found](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/3#discussion_r4502080747) |
| A 64-character DNS domain label is accepted | **Not reported** | [Found](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/3#discussion_r4502080747) |

The first three exactly match the three pre-registered functional cases: **3/3** in each reviewer. This is just one deliberately seeded sample. CodeRabbit's two additional findings are on `src/lib/contact-links.mjs`, a module originally registered as a healthy control; the preregistration is not evidence those other edge cases are correct. A control finding must be verified, not mechanically classified as a false positive.

## Independent code counterexamples

At the unchanged fixture HEAD, `safeEmailLink` accepts a local part matching `[a-z0-9._%+'-]+` without enforcing separator placement, and enforces total email length but not per-label DNS length. An isolated Node evaluation of that exact logic returns non-null `mailto:` links for the following invalid addresses:

- `.a@example.se` — leading dot in unquoted local part;
- `a.@example.se` — trailing dot in unquoted local part;
- `a..b@example.se` — consecutive dots;
- `ok@` followed by **64 ASCII letters** then `.se` — DNS label above the 63-character maximum.

A 63-letter label is also accepted, as expected. These are **source-supported validation defects** in a synthetic fixture, not reported production incidents. The existing test suite does not exercise these inputs.

Historical ReviewForge also reported a plausible `tests/delivery-once.test.mjs` assertion gap as supplemental test-integrity feedback; do **not** count this as a fourth primary runtime case or equate unmatched findings with false positives.

## Generalized improvement on ReviewForge PR #8

An audit of the reviewer skill routing showed that `src/lib/contact-links.mjs` did not activate a dedicated input-boundary skill. PR #8 now includes a **generic** `input-boundaries` skill covering user-facing links and parsers, formal input grammar and separators, per-component boundaries, canonicalization, encoding, and valid alternatives. No example email strings or gold answers are embedded in the trusted model instructions.

Two regression tests first failed before the new rule was introduced and now verify the rule is selected and included exactly once in a mocked model request. **This tests reviewer configuration and integration, not actual detection accuracy.** No new paid OpenAI review was executed. Do not replay these seen fixture commits to manufacture an improvement score.

## Next quality gate

Only claim measurable gain after a distinct, held-out, fully covered same-HEAD PR is independently reviewed and the actual outputs adjudicated. Continue shadow mode with CodeRabbit as the primary reviewer. Require a separate isolated model runtime with verified spending controls before any new paid ReviewForge invocation. Do not modify Proffera, merge these PRs, turn on publishing, or change commercial billing as part of this benchmark.
