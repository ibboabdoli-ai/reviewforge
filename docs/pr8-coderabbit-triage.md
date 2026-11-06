# PR #8 CodeRabbit finding tracker

Review target: `cb855ed5656b0ec0fa1f8fca5739ed2a84edb640`. The 20 comments below are hypotheses; statuses are updated after reproduction and tests. No production Stripe or PostgreSQL environment is used.

| ID | Severity | File | Finding | Verification / correction |
| --- | --- | --- | --- | --- |
| 4498251963 | Major | `src/ui.mjs` | Repository transfer after grant leaks destination data | **Confirmed and fixed:** failing transfer test now filters by repository and authorizing installation. |
| 4498243925 | Major | `src/stripe.mjs` | Pending row prevents activation | **Confirmed and fixed:** proven Checkout completion repairs pending rows, including missing customer ID. |
| 4498243936 | Major | `src/stripe.mjs` | Equal creation timestamps block replacement | **Confirmed and fixed:** terminal predecessor plus matching Checkout proof permits a tie; ambiguous ties still reject. |
| 4498243947 | Major | `src/stripe.mjs` | Duplicate payable Checkout sessions | **Confirmed and fixed locally:** atomic pending reservation permits only one concurrent Checkout creation. An abandoned/uncertain session stays blocked pending manual Stripe reconciliation. |
| 4498243958 | Major | `src/stripe.mjs` | Checkout proof conflicts with metadata | **Confirmed and fixed:** proof is checked on every subscription assignment; wrong metadata owner test is denied. |
| 4498243965 | Major | `src/stripe.mjs` | Expired incomplete subscription blocks replacement | **Confirmed and fixed for proven replacement events:** `incomplete_expired` is terminal with an incoming Checkout proof. Starting a fresh session after an abandoned one still requires manual reconciliation. |
| 4498243977 | Major | `src/stripe.mjs` | New inactive subscription downgrades active Pro | **Confirmed; reproduced case fixed:** an active current subscription wins over a newer inactive one. Broader reconciliation of three or more simultaneous active Stripe subscriptions requires an authoritative subscription listing and disposable Stripe validation; still a release blocker. |
| 4498251917 | Major | `src/db-postgres.mjs` | Stripe waiters exhaust pool | **Confirmed in code; bounded mitigation:** same-owner quota calls queue before acquiring a pool client. Synthetic gate test passes; live PostgreSQL contention remains unverified. |
| 4498243872 | Minor | `migrations/006_stripe_checkout_proofs.sql` | Migration absent from deployment checklist | **Confirmed and fixed:** README requires 006 before Stripe webhooks and new 007 before scoped deduplication. |
| 4498243881 | Minor | `src/db.mjs` | Review deduplication ignores installation | **Confirmed and fixed:** both adapters scope lookup; SQLite legacy schema migration preserves jobs; forward PostgreSQL migration 007 added. |
| 4498243890 | Minor | `src/github.mjs` | Authorization query loads unrelated repositories | **Confirmed and fixed:** SQL filters by current user's GitHub installation IDs. |
| 4498243899 | Minor | `src/server.mjs` | Delayed webhook rebinds transferred repository | **Confirmed and fixed:** a changed association requires a live App-token repository check; stale sync test fails before and passes after. |
| 4498243917 | Minor | `src/stripe.mjs` | Pro price is not verified | **Confirmed and fixed:** entitlement status requires the configured price on the fetched subscription; wrong price remains free. |
| 4498243986 | Minor | `src/ui.mjs` | Shared member sees personal quota instead of owner quota | **Confirmed and fixed:** dashboard reads quota by authorized installation billing owner. |
| 4498251925 | Minor | `src/db.mjs` | In-memory SQLite helpers open empty connections | **Confirmed and fixed:** unsupported memory mode fails immediately with an explicit error. |
| 4498251935 | Minor | `src/github.mjs` | Concurrent OAuth refresh loses a request | **Confirmed and fixed:** losing request reuses a newly stored valid token; fail closed otherwise. |
| 4498251943 | Minor | `src/manual-review.mjs` | Duplicate full name picks inaccessible row | **Confirmed and fixed:** select the association matching the current repository/installation grant. |
| 4498251959 | Minor | `src/server.mjs` | Stripe failures lose safe diagnostics | **Confirmed and fixed:** webhook logs bounded failure categories without raw exceptions or payloads. |
| 4498251970 | Minor | `src/worker-review.mjs` | Monthly quota returns HTTP 500 | **Confirmed and fixed:** worker route preserves 429. |
| 4498251976 | Minor | `tests/monthly-quota.test.mjs` | Failed quota worker can hang test | **Confirmed and fixed:** all spawned workers terminate in `finally` before DB cleanup. |

Additional six nitpicks were read: deferred sync writes, string-valued PostgreSQL IDs, PostgreSQL quota contention, webhook scheduling behavior, reservation timing, and Checkout test coverage. Deferred-write and string-ID synthetic tests were added. The remaining suggestions do not prove a separate defect; PostgreSQL and real Checkout behavior still require disposable TEST environments.
