-- Non-secret heartbeat telemetry for the protected ReviewForge cron and worker endpoint.
-- Never store bearer tokens, source code, or request bodies here.
CREATE TABLE IF NOT EXISTS scheduler_heartbeats (
  source TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_result TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0
);
