-- Additive migration for the dedicated ReviewForge Neon database only.
-- No PR diff or secret is stored: only a plan digest and validated results.
CREATE TABLE IF NOT EXISTS review_progress (
  review_id BIGINT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
  plan_hash TEXT NOT NULL,
  total_batches INTEGER NOT NULL CHECK(total_batches BETWEEN 1 AND 4),
  completed_batches INTEGER NOT NULL DEFAULT 0 CHECK(completed_batches >= 0),
  results_json TEXT NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(completed_batches <= total_batches)
);
