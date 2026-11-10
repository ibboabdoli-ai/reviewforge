# PR #7 — safe next independent AI evaluation (NOT YET AUTHORIZED)

## Frozen target and stack

- Target repository: `ibboabdoli-ai/reviewforge-sandbox`; Draft PR **#7**.
- Frozen base: `420bf122458eb298080bca9e94e6fcfb32339e59`.
- Frozen head: `a628945d7533c7418aed344ed5f90a9a2ec8bc46` (**15 changed files**).
- Review engine: Draft PR #17 (stacked on PR #16, stacked on PR #15). The engine commit must be pinned again just before an authorized run.
- The old 2026-11-09 paid-attempt lock is **untouched**. Its result and billing are unknown. Do not retry that request, remove the lock, or relabel it as completed.

## Verified offline evidence

- The actual frozen target and current experimental engine were checked locally on an authorized Windows PC.
- Coverage planner: **15/15**, one batch, complete; all notification/lock/payment source paths in changed diffs.
- SHA-pinned supplemental context: **10,333 characters**, nine local fixed-SHA file reads; lock-holder source included.
- Prepared Responses payload: **34,627 UTF-8 bytes**. The actual token count is *unknown* until a provider receipt exists.
- The real `reviewWithAI` code has been exercised with a synthetic response through the PR #16 journal; **zero OpenAI calls and zero GitHub comments**.
- GitHub CI/Windows targeted tests include HTTP 200, HTTP 503, TypeError network loss, TimeoutError, malformed JSON, concurrent duplicate requests, deliberate child-process crash before/after usage receipt, token and known-secret redaction, filtered/unanchored finding guard and unchanged prior attempt lock.
- A synthetic answer with zero findings is NOT evidence of model recall.

## Proposed future paid experiment — requires separate explicit user authorization

- One **new, separately authorized experimental attempt**, not an automated retry of the old attempt. Keep a new distinct immutable experiment ID and isolated path while preserving the old historical lock and UNKNOWN state.
- Model: `gpt-6.1-sol`, reasoning `high`, Responses API, `store:false`, output token limit **6,000**.
- Up to **one POST**, **no retries**, no GitHub post, no approval, no Production database/service writes, no provider background mode.
- Request timeout currently configured in engine: **85 seconds**. This was a plausible but unproven contributor to the older missing result. Any deliberate increase (e.g. 180 seconds) must be reviewed and tested *before* a new paid run.
- Hard preflight: immutable target/engine hashes, exact 15-path set, completeness 15/15, one bounded batch, all four critical source paths in diff, SHA-pinned context <= 12,000 chars, provider request <= 50,000 bytes, zero Gold Evidence in the submitted input and no active model request.
- One-time journal: lock before the request, request-id/status and usage receipt if returned, atomic final report, no automatic retry after ambiguity. A caller must explicitly invoke request-start and receipt callbacks.
- USD pricing snapshot, OpenAI public Standard rate (2026-11-10): **$2 per million uncached input tokens and $10 per million output tokens** for `gpt-6.1-sol`. Formula: `(input_tokens * 2 + output_tokens * 10) / 1,000,000`. For hypothetical 8k–12k input and <=6k output: about **$0.076–$0.084**, ignoring cache discounts, taxes and optional region surcharges.
- Recommended **planning budget $0.20 USD** for the single future attempt, including contingency; it is NOT an enforceable API dollar cap. Enforce input/output limits and one attempt, and if account-level spending controls can be verified use them too. Do not promise a guaranteed total without provider billing.
- The local test API key must remain private, passed securely only after authorization; no key in GitHub, chat, logs, reports or command-line arguments.

## Post-response acceptance and adjudication

Gold Evidence is preregistered separately and must never be included in model input or prompt. Only after a completed provider response on the pinned target:

1. Match reported findings to each of two independent validated behavioral defects, requiring the causal path, concrete counterexample, and actionable remediation. Do NOT give credit for generic missing-test or concurrency claims.
2. Compare the frozen, same-SHA CodeRabbit and Codex findings independently; do not import their findings into the model input.
3. Count **TP** (independent real defects found), **FP** (unsupported/duplicate claims), **FN** (missed preregistered defects). Review other novel findings individually, not automatically as false positives.
4. `recall=TP/(TP+FN)`, `precision=TP/(TP+FP)`. Acceptance on this sample: **TP=2, FN=0, FP=0**, reported anchors valid, context 15/15, one request, known token usage or explicit unknown state.
5. Distinguish false *model* findings from findings filtered by the engine's changed-line validation; both should be reported as diagnostics.
6. If Timeout/HTTP/network/invalid-output/crash leaves no completed response: quality is **UNVERIFIED**, not 0/2 and not 2/2. Read the journal without retry.

## Boundary

This file is a PLAN, not an executable paid runner or permission to spend money. No future model call may be performed without explicit new approval and validated metering. Do not merge, deploy, change Proffera or modify sandbox PR #7.
