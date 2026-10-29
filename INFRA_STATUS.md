# ReviewForge infrastructure (October 29, 2026)

## Connected
- Dedicated Neon database: `divine-cherry-84955471`, Frankfurt (`aws-eu-central-1`)
- Neon branch: `production`
- Vercel project: `reviewforge` (`prj_70oyrQewWkDVuZ3X65B8TPeqzUEn`)
- `DATABASE_URL`: encrypted environment variable on ReviewForge's Vercel project only
- `REVIEW_POST_MODE=dry-run`, `DEMO_MODE=false`
- Dedicated session and worker secrets have been configured in Vercel
- SQL migration run on fresh database; 9 application tables verified

## Not live yet
- Deploy actual application sources to Vercel (repo currently only contains bootstrap files)
- Register ReviewForge GitHub App and secure credentials
- Configure GitHub OAuth, webhook, test delivery, App installations
- Enable AI with provider key and validate dry-run review on a test PR
- Configure a worker scheduler, retry, rate limits and logging
- Stripe integration pending; do not claim working subscriptions

No secrets belong in Git history. This PR records infrastructure bootstrap only, not an application release.
