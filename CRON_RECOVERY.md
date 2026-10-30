## Cron and queue recovery verification
- Actual scheduled invocation: Vercel Cron at 04:00 UTC daily (on Hobby it may arrive any time between 04:00 and 04:59 UTC).
- An authorized GET /internal/process-queue writes a minimal row to scheduler_heartbeats (source=cron, last_run_at, last_result, runs). POST with WORKER_SECRET stores source=worker.
- When AI is disabled, the endpoint returns JSON {status:"disabled"}; it is *not* proof that a review was processed.
- Unauthenticated GET and wrong-secret POST must return 403. Verified by CI tests, not production secrets.
- To verify the first live run, query SELECT source,last_run_at,last_result,runs FROM scheduler_heartbeats; or view Settings > Cron Jobs > View Logs on Vercel.
- Retry backoff is bounded: 60 seconds, 120 seconds, then terminal failed on attempt 3. Local tests do not prove that Vercel will schedule another invocation automatically; it does not retry failed cron executions.
- Stripe stays disabled; verify test-only webhooks before activating checkout.
