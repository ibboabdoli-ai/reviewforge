# Maria 66-file same-HEAD ReviewForge vs CodeRabbit — real model outcome

**Date:** 2026-11-07 (Europe/Stockholm). **Run type:** one-time, real OpenAI model inference, offline local isolated dry-run with no GitHub posting.

## Fixed experimental inputs

- Repo: `ibboabdoli-ai/Proffera`; **reference reviewed SHA**: `56544f2fba570b17c157c1bdedcd68325a337e47`.
- Exact selected 66 files: GitHub compare `105b46799a6ba74660d04d0c314662bfbf5ce794...7f6c9922284e63d5cdcef5599a91cd2b28ceffee`. Between the selected delta tip and reference reviewed SHA, only `.coderabbit.yaml` changed.
- Independent CodeRabbit [same-SHA review](https://github.com/ibboabdoli-ai/Proffera/pull/971#pullrequestreview-5814786778): **24 actionable comments**: 5 Major, 16 Minor and 3 Trivial. This is *reference for overlap*, not a validated gold set or proof that every comment is a bug.
- ReviewForge pinned runtime code: `e6fd806c53a8aa119af42c373dc363dced071066`, matching the functional review engine in the integrated draft, before docs-only benchmark commits.
- Model: `gpt-6.1-sol`, reasoning **high**, actual structured Responses API (not mock). Context read only from checked-out pinned source. Gold findings were not supplied to the model.
- No production API key used; separate OpenAI TEST-project key supplied interactively to the local launcher. No API credentials or code patches written to this record.

## Measured delivery

| Area | Files | AI batches | Accepted findings | Full batch/coverage status |
|---|---:|---:|---:|---|
| Customer booking | 27 | 4 | 1 | completed; complete |
| Manager/calendar | 16 | 4 | 2 | completed; complete |
| Site, test and documentation evidence | 23 | 3 | 3 | completed; complete |
| **Total** | **66** | **11** | **6** | **all completed; 66/66** |

- **Exactly 11** paid model requests; no retry triggered; all returned HTTP 200 with reported model usage. **Input tokens:** 102,548; **output tokens:** 19,919.
- Each call was limited to 50,000 UTF-8 request-body bytes and 6,000 max output tokens; no request crossed those limits. The model-only conservative pricing bound calculated at launch was `$1.76` for all calls, assuming the then-current standard rates. This is *not an actual invoice*; consult API usage/billing for the billed amount.
- GitHub writes/comments: 0; production DB connections/writes: 0; deployments/merges: 0. The run was a local dry-run and no finding was posted to Proffera.
- Final local JSON result path on the authorized Windows host: `%TEMP%\rf-maria-66-real-results.json`; attempt log `%TEMP%\rf-maria-66-real-attempts.ndjson`. Not remotely checked in.

## ReviewForge six findings (from the live model)

| Severity | Location | Summary | Same-issue CodeRabbit overlap? |
|---|---|---|---|
| Low | `src/lib/maria-verified-booking.test.ts:98` | Test can pass if a Production/QA-recipient OR predicate regresses | No clear exact match |
| Medium | `src/lib/maria-booking-runtime.test.ts:63` | Separately exercise activation flags without the provider gate masking results | No clear exact match |
| Medium | `src/app/dashboard/maria/maria-production-schedule-action.test.ts:21` | Add readiness-workspace mismatch case | **Yes** — [CodeRabbit](https://github.com/ibboabdoli-ai/Proffera/pull/971#discussion_r4503616387) |
| Medium | `tests/maria-public-host-booking-closed.test.ts:113` | Assert actual `X-Robots-Tag` demo response instead of source-string presence | **Yes** — [CodeRabbit](https://github.com/ibboabdoli-ai/Proffera/pull/971#discussion_r4503612741) |
| Medium | `tests/maria-production-booking-lifecycle-postgres.integration.test.ts:236` | Assert requested closure timestamp rather than existence of any closed start | No clear exact match |
| Low | `src/features/email/unified-booking-confirmation-email.test.ts:104` | Add independent hostile reschedule URL test with canonical portal URL | No clear exact match |

All six were test-coverage suggestions; **none asserted a concrete production runtime defect.** Novel findings require independent validation before labeling them actionable.

## Direct comparison and limitations

- **2/24** CodeRabbit suggestions had an obvious semantic overlap with ReviewForge findings. This is an *agreement count*, **not** independently measured recall or precision; CodeRabbit is not a complete gold standard.
- **0/5** CodeRabbit `Major` findings were matched by ReviewForge, including canonical booking host redirect, single-package year visibility, recorded-deposit payment suppression, notifying managers of reschedule mail failure, and service job reactivation on reconfirmation.
- The comparison is for the **frozen selection of 66 files**, not the full 203-file PR and not its later moving HEAD. CodeRabbit comments may subsequently have been addressed in later source commits.
- ReviewForge's `66/66` coverage is a scheduling/source-diff coverage claim, *not* evidence of model semantic detection completeness. Cross-file behavior can require additional source context.
- Next measured quality target: prioritize reachable business-logic and runtime defects over test-only suggestions; evaluate semantic matches on future held-out, independently witnessed examples; preserve no-post and cost bounds. Do not rerun the same 66-file input merely to optimize overlap after seeing the answers.

## Security status

- No posting to the original PR, no release, no DB migration, no Production credentials; the local launcher stores only token counts and findings, never the OpenAI API key.
- Project spend UI displayed `Limit not enforced`. A bounded one-time request counter and input/output maxima were enforced locally; this is a model-call bound rather than an organization-wide billing hard stop.
