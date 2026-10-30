-- ReviewForge only. Additive daily AI request reservation table.
-- Each model attempt reserves a daily slot atomically before execution.
CREATE TABLE IF NOT EXISTS ai_daily_limits (
  day TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0)
);
