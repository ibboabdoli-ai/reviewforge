# Held-out sandbox PR #5 — independent benchmark checkpoint (2026-11-07)

## Identity and preregistration

- **Target:** [reviewforge-sandbox PR #5](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/5), draft, base `main` at `420bf122458eb298080bca9e94e6fcfb32339e59`, frozen HEAD `c4054f5e247514c80b76344eb1854e2345aa8037`.
- Reference cases were committed independently in `benchmarks/heldout-20261107-pr5-gold.json` **before any external model reviewed the target**. The target repo contains no gold or fixture answers.
- Independent reproducible behavioral witness: `benchmarks/verify-heldout-pr5.mjs`; run only on a clean local checkout at the exact frozen SHA.
- The candidate ReviewForge engine build for this attempt is the reviewer code already present in PR #8 at registration; **do not retune the prompt or model configuration using these results before its first model review**.

## Verified fixture and code coverage

- **Normal sandbox unit tests:** 7 passed / 0 failed on a disposable Windows checkout at the frozen SHA. Sandbox GitHub Actions push/PR checks passed.
- **Independent behavior witnesses:** both registered defects reproduced against original functions; isolated tenant-scoped and atomic conditional-update corrected twins passed; owner-scoped metrics control passed. No customer data involved.
- **PR #8 review engine offline preflight:** 8/8 changed files selectable, `coverage.complete=true`, one bounded model batch, no missing/withheld patches. Engine SHA `e6fd806c53a8aa119af42c373dc363dced071066`. **No AI inference was run.**

## CodeRabbit — completed paired component

- One manually requested **free/OSS** full review on exact target SHA, after preregistration.
- [CodeRabbit review](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/5#pullrequestreview-5813662590): **2 actionable Major findings**.
- [Finding 1](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/5#discussion_r4502766392): invoice preview missing viewer-tenant ownership check, matching the first pre-registered functional case.
- [Finding 2](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/5#discussion_r4502766396): non-atomic reservation under concurrent loads/saves, matching the second pre-registered case.
- In this **single, deliberately constructed sample**, CodeRabbit matched **2/2 independent registered defects**. No additional actionable findings on the negative controls were published. This cannot establish population accuracy or general false-positive rate.

## ReviewForge — not yet scored

- The **current new ReviewForge AI build has not reviewed this target**. The offline preflight is not a model run and must not be scored as one.
- Connected Vercel environment metadata confirms `OPENAI_API_KEY` is scoped to Production only; no Preview/TEST key exists. `DATABASE_URL` is shared across Production, Preview and Development, so deploying a Preview to run this test risks contacting production data.
- The local isolated checkout has no test-mode `OPENAI_API_KEY`. Do **not** reuse production secrets or change Vercel production allowlists for the benchmark.
- The user approved a total trial ceiling of **$10**. That is an authorization ceiling, **not** a technically verified OpenAI project hard spending limit. New paid ReviewForge API calls in this phase: **0**.

## Next action

Provision a separate **TEST-only OpenAI API credential** and a provider-verified spending limit (total not more than $10), with an isolated local or disposable runtime. Then run **one** exact-head ReviewForge review in `dry-run` mode using the frozen PR #8 reviewer build and this unchanged sandbox PR. Never expose the gold to the model, never post reviews/approvals, never reuse production DB, and record failures, model/version, accepted/filtered findings, latency, usage and adjudication. Compare against the already frozen CodeRabbit 2/2 findings; no repeated paid model retries on the same SHA.

**Status: CodeRabbit paired result complete; current ReviewForge model comparison BLOCKED on isolated TEST API setup.** No code changes to Proffera, and no merge or production deployment.
