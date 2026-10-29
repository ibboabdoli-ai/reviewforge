# ReviewForge — open-source MVP (pre-production)

ReviewForge is an AI-assisted GitHub pull-request review application. This is an experimental MVP, **not yet a commercially ready SaaS**. The public repository contains source, not credentials. A private, dedicated Neon Postgres project is configured for hosting.

## Current status

- Dashboard, OAuth routes, GitHub App webhook, review analysis, dry-run pipeline, and Stripe test-mode handlers are implemented.
- **GitHub App registration and AI model credential remain unconfigured:** live AI review is **not active**.
- **Review posting disabled** by default: `REVIEW_POST_MODE=dry-run`.
- **Billing not enabled** until Stripe test credentials and webhook tests are configured.
- Production requires `DATABASE_URL` and a long `SESSION_SECRET`. `DEMO_MODE=false` in production.
- An out-of-process worker scheduler for `POST /internal/process-queue` (Bearer `WORKER_SECRET`) must be configured and validated before claiming automatic review works on a serverless host.

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

1. Use an isolated database. Apply `migrations/001_initial.sql` once with a direct PostgreSQL connection, or verify its existing tables.
2. Deploy with `DATABASE_URL` (pooled), `SESSION_SECRET`, and `REVIEW_POST_MODE=dry-run`.
3. Verify `/healthz` on the intended deployment, without logging any environment variable values.
4. Register a GitHub App in your own GitHub account with minimal permissions and configure OAuth/webhook secrets directly in Vercel.
5. Test a real, **test-only** PR and signed webhook in dry-run mode before allowing posting.
6. Set up an authorized worker, observability, retention, rate limits, tenant isolation checks, and full end-to-end tests.
7. Configure Stripe **test mode** and verify subscription webhooks before any live billing.

**Public repository does not imply a public working SaaS.** Open issues and pull requests before changes are merged. See `GITHUB_AI_SETUP_FA.md` and `VERCEL_NEON_SETUP_FA.md` for the longer setup guides.
