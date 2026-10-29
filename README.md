# ReviewForge

AI-assisted GitHub Pull Request review SaaS (work in progress).

## Status

- Database: dedicated Neon PostgreSQL (Frankfurt).
- Hosting: separate Vercel project; production deployment pending.
- Review posting: disabled by default (`REVIEW_POST_MODE=dry-run`).
- GitHub App credentials and production AI integration: not yet configured.

Development happens on feature branches and goes through Pull Requests. Never commit secrets (`.env`, PEM keys, or tokens).
