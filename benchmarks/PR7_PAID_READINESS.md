# Held-out ReviewForge PR #7 — independent one-shot readiness

This DRAFT branch adds a new, fixed-identity one-shot runner on top of ReviewForge PR #17. It is **not permission to spend**. Default invocation uses --preflight and only a local frozen Git checkout and inert synthetic response. No provider request in CI.

- Target PR #7 HEAD: `a628945d7533c7418aed344ed5f90a9a2ec8bc46`, base `420bf122458eb298080bca9e94e6fcfb32339e59`.
- Model: `gpt-6.1-sol`; reasoning `high`; `store:false`; 6,000 max output tokens.
- One POST only, never automatic retry; isolated fixed journal ID `rf-pr7-independent-once-20261110-v2`. Old `rf-heldout-pr7-paid-once-20261109.lock` remains unknown and untouched.
- Bounded request: <=50,000 UTF-8 bytes; SHA-pinned 15/15 code coverage, single batch, <=12,000 actual rendered context characters; code under test and model prompts do not reference Gold Evidence.
- Timeout: isolated caller requests 180,000 ms, leaving existing Production default of 85,000 ms unchanged.
- Expected standard per 1M tokens: $2 input and $10 output (cached input may be less). With ~9k input and <=6k output, approximate $0.078. The planning budget is **$0.20**, not an enforceable hard spending cap. Actual invoice may differ due to tokens, routing, residency, tools, taxes or price changes.
- The paid path requires an explicit future authorization ID matching RF_APPROVED_PAID_ATTEMPT, a local OPENAI_TEST_API_KEY, a fixed journal path, and a distinct CLI --execute-paid. Do not supply these without separate approval.
- After a completed result, independently score TP/FP/FN against separately held evidence: 2 validated issues; acceptance TP=2, FN=0, FP=0. A missing response or timeout is unverified, not a clean or failed code review.
- **Do not merge, deploy, run paid API, change sample PR #7 or Proffera, delete old locks, or submit Gold Evidence to the model.**
