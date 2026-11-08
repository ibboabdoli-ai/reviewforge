# Maria PR #971 — ReviewForge same-head 66-file baseline (2026-11-07)

## Provenance (do not confuse with the current moving PR head)

- **Authoritative CodeRabbit review commit:** `56544f2fba570b17c157c1bdedcd68325a337e47` ([review](https://github.com/ibboabdoli-ai/Proffera/pull/971#pullrequestreview-5814786778)).
- Selected 66 paths are the exact GitHub compare `105b46799a6ba74660d04d0c314662bfbf5ce794...7f6c9922284e63d5cdcef5599a91cd2b28ceffee`.
- Between the selection endpoint and CodeRabbit's reviewed commit, the only changed path was `.coderabbit.yaml`, the temporary review path filter; functional code in this selected delta is therefore unchanged.
- **Do not compare the current PR #971 tip to these outcomes.** The original 66-file result and its CodeRabbit findings are attached to the frozen SHA above.
- Raw diff patches and private source are **not committed** to this benchmark document. Synthetic review context must remain untrusted. Do not send the CodeRabbit findings or this answer key to the ReviewForge model.

## Verified no-cost coverage preflight

| Scope | Files | Raw patch chars | Resumable model batches (24k-char cap) | Coverage |
|---|---:|---:|---:|---|
| Customer booking, verification, and payments | 27 | 75,847 | 4 | Complete |
| Manager dashboard and calendar | 16 | 80,730 | 4 | Complete |
| Supporting tests, site, and documentation | 23 | 66,942 | 3 | Complete |
| **Total** | **66** | **223,519** | **11** | **66/66** |

- Preflight was executed using the actual `planReviewBatches` implementation from pinned ReviewForge code commit `e6fd806c53a8aa119af42c373dc363dced071066` (functional reviewer code reused by the later integrated draft).
- Every group had zero missing patches, oversized/unanchored deletions, sensitive omissions, or capacity omissions. Batch counts: `4 + 4 + 3`.
- The three `analyzePullRequestStep` pipelines were then exercised in offline dry-run **with injected mock AI responses**, 11 checkpoints, zero GitHub writes, zero production database connections and **zero paid model requests**.
- This is **not an AI quality evaluation**. It only proves scheduling and coverage. A real review must be evaluated against independently validated CodeRabbit findings and held-out gold, not count a mock clean response.

## Frozen exact path groups

### Customer booking, verification, and payments — 27 files / 4 batches

- `public/demo/makeup-by-maria-v2.html`
- `src/app/api/makeup-by-maria/availability/route.ts`
- `src/app/api/makeup-by-maria/booking/route.test.ts`
- `src/app/api/makeup-by-maria/booking/route.ts`
- `src/app/api/makeup-by-maria/config/route.ts`
- `src/app/api/makeup-by-maria/swish-qr/[id]/route.test.ts`
- `src/app/api/makeup-by-maria/swish-qr/[id]/route.ts`
- `src/app/boka/[slug]/page.tsx`
- `src/app/boka/verifiera/[id]/page.test.tsx`
- `src/app/boka/verifiera/[id]/page.tsx`
- `src/app/maria/swish/[id]/page.test.tsx`
- `src/app/maria/swish/[id]/page.tsx`
- `src/app/mina-bokningar/[token]/[bookingId]/boka-om/page.tsx`
- `src/app/mina-bokningar/[token]/page.tsx`
- `src/features/email/booking-verification-email.ts`
- `src/features/email/maria-deposit-email.test.ts`
- `src/features/email/maria-deposit-email.ts`
- `src/lib/customer-reschedule-slots.ts`
- `src/lib/maria-customer-reschedule.ts`
- `src/lib/maria-otp-issuance-gate.test.ts`
- `src/lib/maria-public-booking-locale.test.ts`
- `src/lib/maria-public-booking-locale.ts`
- `src/lib/maria-swish-qr-eligibility.ts`
- `src/lib/maria-verified-booking.test.ts`
- `src/lib/maria-verified-booking.ts`
- `src/lib/public-booking-resend-delivery.test.ts`
- `src/lib/public-booking-verification.ts`

### Manager dashboard and calendar — 16 files / 4 batches

- `src/app/dashboard/bokningar/[id]/page.tsx`
- `src/app/dashboard/maria/kalender/page.tsx`
- `src/app/dashboard/maria/maria-preview-calendar-access.test.tsx`
- `src/app/dashboard/maria/maria-production-schedule-action.test.ts`
- `src/app/dashboard/maria/page.tsx`
- `src/app/dashboard/maria/schedule-actions.ts`
- `src/lib/customer-calendar.ts`
- `src/lib/dashboard-booking-reschedule.ts`
- `src/lib/dashboard-booking-status.ts`
- `src/lib/maria-booking-runtime.test.ts`
- `src/lib/maria-booking-runtime.ts`
- `src/lib/maria-dashboard-reschedule.ts`
- `src/lib/maria-manual-calendar.ts`
- `src/lib/maria-manual-swish.ts`
- `src/lib/maria-production-activation-policy.test.ts`
- `src/lib/maria-production-activation-policy.ts`

### Supporting tests, site, and documentation — 23 files / 3 batches

- `docs/CURRENT_STATUS.md`
- `docs/MARIA_ONE_SHOT_RELEASE.md`
- `src/app/robots.ts`
- `src/app/sitemap.ts`
- `src/features/email/booking-reschedule-email.ts`
- `src/features/email/maria-email-logo-flow.test.ts`
- `src/features/email/unified-booking-confirmation-email.test.ts`
- `src/features/email/unified-booking-confirmation-email.ts`
- `src/lib/customer-portal-language.test.ts`
- `src/lib/customer-portal-language.ts`
- `src/lib/maria-email-logo.ts`
- `src/lib/maria-preview-customer-safety.test.ts`
- `src/lib/maria-preview-customer-safety.ts`
- `src/lib/maria-public-seo-policy.test.ts`
- `src/lib/maria-public-seo-policy.ts`
- `src/lib/public-site-domains.test.ts`
- `src/lib/public-site-domains.ts`
- `src/proxy.ts`
- `tests/maria-manager-saves-postgres.integration.test.ts`
- `tests/maria-production-booking-lifecycle-postgres.integration.test.ts`
- `tests/maria-production-booking-runtime-postgres.integration.test.ts`
- `tests/maria-public-host-booking-closed.test.ts`
- `tests/proxy.test.ts`

## Execution safety gate

**NOT EXECUTED AS PAID AI.** The user-approved overall ceiling was $10; the available OpenAI project UI showed **Limit not enforced**, which is not a hard spending ceiling. Local model `OPENAI_API_KEY` is absent and Vercel's secret is Production-only. No production API key, Neon Production database, or live Vercel worker may be used to get around this.

Before real runs, verify a separate disposable TEST API key and actual spending controls; hard limit or equivalent fixed-bounded prepaid credit must be evidenced. Execute **at most the planned 11 model batches** in dry-run, one group at a time; no automatic retries after an ambiguous paid timeout, and stop before crossing the $10 ceiling. Pin the reviewed commit and model config. Do not make any GitHub review comments, approve, merge, deploy, or change Proffera.

ReviewForge findings must be interpreted per group and compared against the CodeRabbit **24 actionable comments** from the original frozen review. Do not assume all suggested findings are true or that an unmentioned defect is absent.
