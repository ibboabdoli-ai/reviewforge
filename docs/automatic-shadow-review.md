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

- Quota fallback publication is deliberately disabled in this draft, even if all fallback allowlists agree. Durable exact-HEAD quota-origin evidence and publication-time revalidation are not yet implemented. A private result is not a GitHub approval.

- Automatic *attempt* does not mean unlimited paid review. The current production setting is a maximum of 2 AI request reservations per UTC day, with owner-monthly quotas also applying. More complex PRs may be deferred or marked partial. Do not increase those limits without reviewing actual cost.
- Large PRs (for example, Proffera PR #971 with >200 changed files) can exceed the 4-batch coverage limit and must be reported as incomplete rather than clean; no model calls should start for such a preflight.
- Existing Draft PRs need a fresh supported GitHub event to enter this flow; enabling the environment variable does not silently backfill old heads.
- Do not enable on production until approved after test results, budget review and confirmation that current deployed code matches this branch.
- ReviewForge findings must be compared with CodeRabbit and Codex only at matching PR + HEAD. Silence from a reviewer or skipped review is not agreement.
- Do not merge, deploy, change Proffera, widen billing, enable auto-approval, or post to GitHub as part of this PR.

## Paired quality check after both independent reviews

`node benchmarks/compare-paired-reviews.mjs reviewforge.json coderabbit.json adjudication.json`

The offline comparison processor reads two independently saved snapshots. Neither snapshot nor the comparison output is imported into ReviewForge's reviewer prompt. Record the repository, PR number and full 40-character head SHA in **both** snapshots. Each needs `tool` (`reviewforge` or `coderabbit`), `status`, `findings` (unique `id`, `path`, `line`, `severity`), and independently verified `coverage` (`complete`, `eligible`, `analyzed`, `excluded`). A missing or failed review produces a non-comparable report with its status and error; it is never scored as clean. CodeRabbit coverage must be checked from its actual review and diff, not inferred from an approval.

After checking the diff and source at that SHA, create `adjudication.json` with the same `repository`, `pr`, full `headSha`, and `issues`: each issue has a unique `id`, `valid` boolean, `severity`, concrete `evidence`, and arrays `reviewforgeFindingIds` and `coderabbitFindingIds`. Assign every finding exactly once. The processor rejects stale target metadata, unmatched or reused IDs. It reports shared important issues, important issues ReviewForge missed, additional valid findings, false warnings, full-file coverage, duration, token usage, billed cost if supplied from a real invoice, and failures. These labels are evidence for a human quality decision, never merge permission.

Provider input, output and total tokens plus model duration are saved with each completed ReviewForge batch in `review_progress.results_json` and shown on the authorized review detail page. An incomplete provider response can also consume tokens; available counters and elapsed time are retained in the terminal review error, separately from successful batch checkpoints, and shown on the detail page. If the network fails before usage arrives, actual cost remains unknown and the attempt remains terminal. The comparison snapshot's optional `billedCost` must come from actual provider billing. Never calculate a charge from tokens alone or automatically retry a timed-out paid call. A confirmed ReviewForge miss should be fixed on an isolated branch with a regression test, then rechecked on a new SHA through the normal independent review path.

## Bounded Proffera pilot

The Proffera production pilot requires `AI_PILOT_MAX_MODEL_CALLS` in the range 1–10; its default is zero. The limit is one-time across UTC days and survives deployments through the existing database counter. Each PR reserves every needed batch against both the daily cap and this pilot counter in the same transaction before any provider call. Exhaustion yields an incomplete review without an automatic retry. Setting the limit to zero stops a saved review before its next paid batch; changing the limit invalidates its saved plan. The pilot accepts only `gpt-6-luna` or `gpt-6.1-sol` and a request whose diff, instructions and schema total at most 100,000 UTF-8 bytes; output is capped at 6,000 tokens. These limits bound the experiment well below $10 at the [published direct API prices](https://developers.openai.com/api/docs/pricing) checked on 2026-11-27. Provider billing remains the source of actual cost; if model prices or routing change, pause the pilot and recalculate before new calls. The pilot never charges or recharges an account automatically.
