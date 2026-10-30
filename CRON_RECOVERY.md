## Cron and queue recovery verification
- Actual scheduled invocation: Vercel Cron at 04:00 UTC daily (on Hobby it may arrive any time between 04:00 and 04:59 UTC).
- An authorized GET /internal/process-queue writes a minimal row to scheduler_heartbeats (source=cron, last_run_at, last_result, runs). POST with WORKER_SECRET stores source=worker.
- When AI is disabled, the endpoint returns JSON {status:"disabled"}; it is *not* proof that a review was processed.
- Unauthenticated GET and wrong-secret POST must return 403. Verified by CI tests, not production secrets.
- To verify the first live run, query SELECT source,last_run_at,last_result,runs FROM scheduler_heartbeats; or view Settings > Cron Jobs > View Logs on Vercel.
- Retry backoff is bounded: 60 seconds, 120 seconds, then terminal failed on attempt 3. Local tests do not prove that Vercel will schedule another invocation automatically; it does not retry failed cron executions.
- Stripe stays disabled; verify test-only webhooks before activating checkout.

- Recovery without model spending: an owner visit to /dashboard, /reviews, or review details (or an authorized Worker status read) reconciles a truly expired 'running' lease to 'failed'. This does not launch jobs, requeue an expired run, or consume API credits.
- A paid model invocation now handles one batch only, persisting its SHA-bound checkpoint in review_progress. The same authenticated exact-HEAD Worker POST continues only its existing queued review ID; completed/failed jobs never replay. At most four batches per review; incomplete diff coverage fails closed without AI calls.
- The worker must poll status and issue another authenticated POST after a successful saved batch while status is queued and progress.completed_batches is below progress.total_batches. Cron alone is daily, not an automatic rapid loop.
- Apply additive migrations/005_incremental_review.sql to ReviewForge's dedicated Neon database BEFORE deploying the incremental worker code. Do not apply to Proffera.
