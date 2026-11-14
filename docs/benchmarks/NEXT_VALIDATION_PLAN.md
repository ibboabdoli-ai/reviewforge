# Next validation plan after V4/V5

Date: 2026-11-14. No paid run, merge, deploy, production change, or sandbox mutation is authorized by this plan.

## Priority 0 — preserve and reconcile evidence

1. Keep V1–V5 journal files, locks and phase traces immutable. Retain only the six published SHA-256 digests in the [evidence audit](REVIEWFORGE_V4_V5_EVIDENCE.md); do not commit raw results, request IDs, provider payloads, credentials or cookies.
2. Compare actual provider billing/activity records with the V4/V5 local usage receipts using an authorized read-only route. Until then, quote only standard-rate estimates. Do not retry any historical attempt.
3. Audit the six unresolved [PR #16 review threads](https://github.com/ibboabdoli-ai/reviewforge/pull/16) against the final stacked implementation and close each only with a specific commit/test rationale. Keep PR #21 and this audit draft; no merge is part of this task.
4. Add a future-run per-file coverage receipt before claiming paid-run full coverage. Preserve exact base/head/engine SHA, changed-file list, source-read outcomes, context truncation, request count and model usage without retaining secrets or prompt text. The existing V4/V5 JSON cannot retroactively establish this.

## Priority 1 — next harder, blinded security sample

Use the existing draft sandbox [PR #5](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/5) at exact head `c4054f5e247514c80b76344eb1854e2345aa8037`, base `420bf122458eb298080bca9e94e6fcfb32339e59` (8 changed files). It contains cross-tenant service behavior and a concurrent reservation path, so it tests security and data-integrity reasoning beyond V4/V5. This is a read-only target. Its CodeRabbit comments and any reference answers must remain **outside the reviewer prompt and supplemental source context**. Do not copy the evaluation table or this plan into the model request.

Independent pre-registration before any future model call:

- Freeze the exact source and changed-file list. Two human reviewers independently inspect the SHA-pinned source, record causal scenarios, changed-line anchors, severity, and expected externally observable behavior, then reconcile disagreements. Store the rubric separately from the runner input.
- Score each model finding by one root cause, correct changed-file anchor, reproducible behavior, and risk. Record TP, unsupported FP, duplicate, unverified, and FN against independently verified reference defects. Report major recall, precision, low-severity noise, file coverage, latency and tokens per run. A CodeRabbit match is supporting evidence, not automatic truth.
- Include security-specific checks for tenant isolation, unauthorized data access, and sensitive-data handling; include concurrency/data integrity checks. Do not publish reference issues into the prompt, test fixture PR, or runner logs.

Offline preflight only:

1. Confirm the PR #5 base/head SHA and clean read-only target; ensure no worker changed the target. Resolve the ReviewForge engine from its checkout, pin the exact commit, and check for existing attempt artifacts under a **new** identity. Do not reuse V1–V5 names.
2. Use a fresh isolated temporary checkout for source inspection and any necessary synthetic test; never write sandbox PR #5 or the original journal. Verify the 8/8 changed-file coverage manifest, SHA-pinned supplemental reads, batch count, request size, and prompt exclusion of the separately held rubric.
3. Mock the provider response and test parser, anchoring, rejection of unsupported findings, one-request guard, atomic journal, failure behavior and secret redaction. Ensure the mock is labeled **offline mock**, never an AI quality result.
4. Review the preflight output and cost ceiling with the owner before any separate authorization for a paid call. This plan grants none. No automatic retry after timeout or ambiguous outcome.

## Priority 2 — replacement gate

ReviewForge should not replace CodeRabbit on the basis of two successful synthetic samples. Require a larger, blinded set spanning security, concurrency, data integrity, workflow hardening, and realistic mixed PRs; independent source adjudication and targeted reproductions; explicit per-file coverage; measured major recall and precision with confidence intervals; stable cost/latency and durable failure recovery; and review of meaningful CodeRabbit-only findings. Define acceptance thresholds and sample size **before** looking at new model outputs. Close valid engine gaps only with a source-grounded regression and rerun offline CI plus independent Codex review on the exact final SHA. Keep publishing in dry-run until those gates and operational controls are met.
