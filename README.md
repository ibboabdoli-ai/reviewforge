# ReviewForge — open-source MVP (pre-production)

ReviewForge is an AI-assisted GitHub pull-request review application. This is an experimental MVP, **not yet a commercially ready SaaS**. The public repository contains source, not credentials. A private, dedicated Neon Postgres project is configured for hosting.

## Current status

- Dashboard, OAuth routes, GitHub App webhook, review analysis, dry-run pipeline, and Stripe test-mode handlers are implemented.
- GitHub App OAuth, signed webhooks and OpenAI integration have been verified on **reviewforge-sandbox**: one dry-run and one live review found three sample issues; the live test posted inline GitHub comments. The AI key is a Vercel secret. As verified on 30 October 2026, **AI_REVIEW_ENABLED=true** only for explicitly allowlisted Proffera shadow reviews; GitHub review publishing remains `dry-run`. Model calls can incur charges.
- **Review posting disabled** by default: `REVIEW_POST_MODE=dry-run`.
- The beta restricts AI jobs to the exact `AI_ALLOWED_REPOSITORIES` list (`reviewforge-sandbox` in production); a database-atomic `AI_DAILY_REQUEST_LIMIT=2` counts **model attempts per UTC day**. This is not a guaranteed dollar cap; use provider billing alerts/limits too.
- **Billing not enabled** until Stripe test credentials and webhook tests are configured.
- Production requires `DATABASE_URL` and a long `SESSION_SECRET`. `DEMO_MODE=false` in production.
- Protected queue recovery: `POST /internal/process-queue` requires `WORKER_SECRET`; Vercel Cron calls `GET /internal/process-queue` with `CRON_SECRET` at 04:00 UTC daily. Public unauthenticated GET returns 403. Actual scheduled execution has not yet been observed. Initial processing uses Vercel `waitUntil`.

## Local run

Requirements: Node.js 24 recommended.

```sh
npm install --ignore-scripts
cp .env.example .env
npm test
npm run build
npm start
```

The app starts at `http://localhost:3000`. The local demo uses a deterministic rule scanner, **not** an AI model. Do not commit `.env` or private keys.

## Production checklist

1. Use an isolated database. Apply `migrations/001_initial.sql` and additive `migrations/002_ai_daily_limits.sql` once, or verify the tables; both are already present in the dedicated ReviewForge Neon production database.
2. Deploy with `DATABASE_URL` (pooled), `SESSION_SECRET`, and `REVIEW_POST_MODE=dry-run`.
3. Verify `/healthz` on the intended deployment, without logging any environment variable values.
4. Register a GitHub App in your own GitHub account with minimal permissions and configure OAuth/webhook secrets directly in Vercel.
5. Test a real, **test-only** PR and signed webhook in dry-run mode before allowing posting.
6. Confirm the authenticated daily cron runs, simulate failed/stale queue retries, monitor errors, and extend rate limits and tenant-isolation tests. Hobby cron recovery runs only once daily; more frequent retries need a suitable plan or external worker.
7. Configure Stripe **test mode** and verify subscription webhooks before any live billing.

**Public repository does not imply a public working SaaS.** Open issues and pull requests before changes are merged. See `GITHUB_AI_SETUP_FA.md` and `VERCEL_NEON_SETUP_FA.md` for the longer setup guides.

## Proffera shadow pilot (CodeRabbit comparison)

The only authorized Proffera pilot runs in **dry-run**: keep `REVIEW_POST_MODE=dry-run`, set `AI_SHADOW_REPOSITORIES=ibboabdoli-ai/proffera` as an additional immutable-at-review-time gate, and include only `ibboabdoli-ai/proffera` in `AI_ALLOWED_REPOSITORIES`. Use a very small `AI_DAILY_REQUEST_LIMIT`; one model batch consumes one reservation. A review needing more than the cap is not started. The review results remain only in ReviewForge. The GitHub App has repository permission but may not publish review comments to Proffera through this pipeline. Do not remove CodeRabbit or modify Proffera code during shadow evaluation.

## Proffera model routing and unlimited shadow-review count

Proffera's optional shadow pilot (read-only analysis) can bypass daily AI-attempt and monthly SaaS review-count caps **only** when `ibboabdoli-ai/proffera` appears in all three variables:

- `AI_ALLOWED_REPOSITORIES`
- `AI_SHADOW_REPOSITORIES` (forces dry-run and no comments, even if global posting is changed)
- `AI_UNLIMITED_REPOSITORIES`

Automatic model routing is a separate explicit opt-in: `AI_AUTO_MODEL_REPOSITORIES=ibboabdoli-ai/proffera`. The code selects `gpt-6-luna` (medium reasoning) for routine changes and `gpt-6.1-sol` (high reasoning) for security, billing, data integrity, infrastructure or complex changes. The selected model appears in the review summary.

**Removing daily attempt limits does not remove API costs or provider rate limits.** At most four model batches are processed per PR, and SHA deduplication is retained. Set OpenAI project usage alerts and spending limits separately. No code in Proffera is changed; CodeRabbit continues independently.

## Verified CodeRabbit quota fallback (Proffera)

`AI_FALLBACK_ONLY_REPOSITORIES=ibboabdoli-ai/proffera` means that ordinary PR open/update events DO NOT queue ReviewForge. On a GitHub-signed `issue_comment` event from the verified `coderabbitai[bot]` actor explicitly reporting a quota limit, ReviewForge checks for a current-HEAD CodeRabbit review request from `github-actions[bot]`, confirms the PR is open, non-draft, same repository and targets main, and refuses to review if CodeRabbit already completed the exact-head review. The job is unique per repository/PR/SHA. Results remain in the dashboard while shadow-mode posting remains disabled.

**Required GitHub App setting:** Add **Issue comment** under Subscribe to events for `ReviewForge-Ibbo-Dev` (without changing existing PR/Installation events). Otherwise ReviewForge will never receive CodeRabbit quota comments. This event is not installed automatically by a code deployment.

**Important:** This is a validated *review trigger*, not an autonomous merge gate. Proffera's existing gated automerge still requires an owner-signed exact-head authorization, the required Validate/E2E checks and its separate current review policy. ReviewForge results must not silently replace the Codex gate or auto-approve merges. The current ReviewForge bot remains in no-comment shadow mode.

## Authenticated manual shadow reviews

Users signed in via GitHub may navigate to **Code reviews → Manual shadow review** and request analysis of a PR number in an explicitly allowed and owner-linked repository. Enable only with `AI_MANUAL_REVIEW_REPOSITORIES=ibboabdoli-ai/proffera` in addition to existing AI and shadow repository allowlists. The server checks the logged-in installation owner, live exact PR head, main base, same-repository head, open PR, and an atomic per-repository/PR/SHA deduplication key. It accepts Draft PRs only for this non-posting route.

Manual requests have a dedicated durable `manual_review_requests` database marker; the worker **always forces dry-run**, independent of any future global or CodeRabbit-fallback posting policy. No manual analysis can approve, comment, change code or merge. Results appear on `/reviews`. API usage costs still apply. Apply additive `migrations/004_manual_review_requests.sql` on the dedicated ReviewForge Neon project before deployment. Manual reviews never relax the CodeRabbit-only fallback trigger for other PR events.

## Worker-initiated PR review (service-to-service API)

A trusted Worker can now request a **read-only review** and fetch the result using ReviewForge's existing \`WORKER_SECRET\` (stored as a secret in the Worker environment, never in GitHub code, a chat, or a URL). Set \`AI_WORKER_REQUEST_REPOSITORIES=ibboabdoli-ai/proffera\` alongside \`AI_MANUAL_REVIEW_REPOSITORIES\`, \`AI_ALLOWED_REPOSITORIES\`, and \`AI_SHADOW_REPOSITORIES\`. Without all four explicit allowlists or the bearer secret, requests are refused.

Send \`POST /internal/reviews/request\`, JSON: \`{"repository":"ibboabdoli-ai/Proffera","pr_number":943,"head_sha":"<exact 40-character current SHA>"}\`, authenticated with \`Authorization: Bearer $WORKER_SECRET\` and \`Content-Type: application/json\`. A new request returns 202 and \`{"id":...,"status":"queued","created":true,"head_sha":...,"posting":"disabled"}\`. Repeated requests for the same SHA return the prior result with no extra AI call. The server independently checks the current head, base, same-repo PR and active installation ownership. Draft PRs can be reviewed in read-only mode.

Read the result with \`GET /internal/reviews/status?repository=ibboabdoli-ai%2FProffera&pr_number=943&head_sha=<exact-sha>\` and the **same Authorization header**. The JSON returns status, summary, error, findings and \`posted:0\`. Do not rely on unauthenticated database access or UI scraping. Workers should poll modestly, stop at completed/partial/failed/stalled/skipped/superseded, and explicitly treat a partial scan or API model failure as **not approved**.

This Worker endpoint **never** submits comments, GitHub approvals, merges, or direct main changes. Every worker-created review is durably marked in \`manual_review_requests\`; the execution worker forces dry-run even if the CodeRabbit-fallback approval path is later enabled. The service token also authorizes the existing internal queue endpoint: distribute it only to trusted automation runtimes. This is a deployment API, not an OpenAI API key.


### Expired serverless review attempts

An expired Vercel execution is never treated as a clean review. Authenticated status reads and owner dashboard reads reconcile expired `running` jobs to terminal `failed` without starting AI. A request timing out while a paid model may have run is **never replayed automatically**; a failed/stalled review is not eligible for approval, posting, or merge.

**Incremental execution (migration 005):** Each serverless invocation processes **at most one model batch** and saves a durable SHA-256 plan digest and validated results to `review_progress`. Full patches are NOT stored. If more batches remain, the review returns `queued` with `progress.completed_batches` and `progress.total_batches`. The trusted Worker must request the **same exact repository/PR/HEAD** again using the already documented authenticated `POST /internal/reviews/request`; this idempotently resumes the existing queued job and triggers only that review ID. Check `GET /internal/reviews/status` after each continuation, and stop on `completed`, `partial`, `failed`, `skipped` or `superseded`. Do not press Start again for failed/stalled work or try to manually reset it to queued.

When no external Worker invokes another step, the daily authenticated Vercel Cron can process one queued batch, but **rapid unattended multi-batch completion is not guaranteed** on the Hobby schedule. The daily cron's first actual execution must still be verified. If the diff is too large to cover within four bounded batches, the review is explicitly `partial` without a paid model call or a clean verdict.
