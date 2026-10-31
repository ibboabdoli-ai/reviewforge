-- Apply once in the dedicated ReviewForge database before deploying manual review routes.
-- This table guarantees manual PR analyses can never submit GitHub reviews,
-- even after a worker retry or a posting-mode change.
CREATE TABLE IF NOT EXISTS manual_review_requests (
  review_id BIGINT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
