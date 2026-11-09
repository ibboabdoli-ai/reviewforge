# Single-attempt AI benchmark journal (no network)

This module is an **isolated diagnostic helper**, not a production model trigger. It exports `runSingleAttempt` and `inspectAttempt` and performs zero network calls itself.

## Why

Proffera review benchmark `reviewforge-sandbox#7` at `a628945d7533c7418aed344ed5f90a9a2ec8bc46` attempted a model request on 2026-11-09, but only an immutable one-attempt lock survived. Its caller wrote the final report only after a successful await, and did not persist failures. The existing `AbortSignal.timeout(85000)` may have fired; no console/provider response was captured, so this cause is **plausible, not confirmed**.

The API request used `store:false`; the response cannot be recovered later via API. Never replay this same benchmark without explicit owner approval.

## Usage for a separate, newly approved attempt

1. Before requesting a model, check that neither the exact-SHA lock nor report exists.
2. Run `runSingleAttempt({lockPath,reportPath,metadata,execute})` with absolute paths. The caller's `execute` must call `markModelRequestStart()` immediately before its only HTTP POST, then `recordProviderUsage({httpStatus,inputTokens,outputTokens,requestId})` after reading the response, if available. The caller must still enforce its existing model/cost/size limit and full-coverage gate.
3. On success, an atomic private report preserves accepted findings and observed usage. On TimeoutError, AbortError, malformed output, HTTP errors, or preflight failure, a *non-success* report is saved with a conservative code and no raw error or credential text. A narrow usage receipt is preserved separately if a response was received before later validation failed.
4. A lock is never cleared by this module and no retry is performed. If a process is killed before a final report, `inspectAttempt` returns `orphaned_unverified`, not a clean or completed result.
5. Running `node --test tests/one-shot-journal.test.mjs` exercises synthetic timeout, concurrency, nonretry, partial/HTTP failures, usage, and redaction without calling any model.

Do not use a test's successful unit results to claim model recall, precision, cost, or acceptance. Record an independent gold comparison *only after* a completed actual response. Keep all fixtures and gold evidence separate from model input.

## Safety and scope

No production write; no changes to PR #7, Proffera, database, Vercel, deployment, secrets, webhook permissions or quota. This helper intentionally does **not** recover the lost response, execute a paid request, change timeouts, cancel server-side work, or claim an exact provider charge.
