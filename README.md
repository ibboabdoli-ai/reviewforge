# ReviewForge — open-source MVP (pre-production)

ReviewForge is an AI-assisted GitHub pull-request review application. This is an experimental MVP, **not yet a commercially ready SaaS**. The public repository contains source, not credentials. A private, dedicated Neon Postgres project is configured for hosting.

## Current status

- Dashboard, OAuth routes, GitHub App webhook, review analysis, dry-run pipeline, and Stripe test-mode handlers are implemented.
- GitHub App OAuth, signed webhooks and OpenAI integration have been verified on **reviewforge-sandbox**: one dry-run and one live review found three sample issues; the live test posted inline GitHub comments. The AI key is configured as a Vercel secret, but **AI_REVIEW_ENABLED=false** for safety.
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
