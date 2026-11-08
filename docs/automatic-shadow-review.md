# ReviewForge automatic private PR review (opt-in)

## Current state and motivation

ReviewForge already supports GitHub pull_request webhooks for ordinary non-Draft PRs. Until this opt-in, Draft PRs are not enqueued. The experimental Proffera evaluation requires both Draft and ready PRs to be comparable on the exact immutable HEAD.

## Safety gate

Deploying this code alone does not enable automatic Draft review. The new environment variable defaults to empty:

`AI_AUTO_SHADOW_REPOSITORIES=ibboabdoli-ai/proffera`

The repository must also appear in both `AI_ALLOWED_REPOSITORIES` and `AI_SHADOW_REPOSITORIES`. Only GitHub-signed events (opened, synchronize, reopened, ready_for_review) are accepted. Existing installations, repository enablement and per-owner monthly quota remain mandatory.

Every review created through this path receives the existing *durable* no-post marker, reused from manual shadow reviews; the automatic origin is intentionally labeled as shadow in behavior, though the underlying table is named `manual_review_requests`. The marker forces `dry-run`, permits Draft, and prevents a later posting-mode configuration change from turning a queued review into a GitHub comment or approval.

Replays of the same installation/repo/PR/HEAD reuse the existing review. Different HEADs are separate. Invalid or excessive budgets remain fail-closed. No new unlimited budget is activated by this feature.

## Important limitations

- Automatic *attempt* does not mean unlimited paid review. The current production setting is a maximum of 2 AI request reservations per UTC day, with owner-monthly quotas also applying. More complex PRs may be deferred or marked partial. Do not increase those limits without reviewing actual cost.
- Large PRs (for example, Proffera PR #971 with >200 changed files) can exceed the 4-batch coverage limit and must be reported as incomplete rather than clean; no model calls should start for such a preflight.
- Existing Draft PRs need a fresh supported GitHub event to enter this flow; enabling the environment variable does not silently backfill old heads.
- Do not enable on production until approved after test results, budget review and confirmation that current deployed code matches this branch.
- ReviewForge findings must be compared with CodeRabbit and Codex only at matching PR + HEAD. Silence from a reviewer or skipped review is not agreement.
- Do not merge, deploy, change Proffera, widen billing, enable auto-approval, or post to GitHub as part of this PR.
