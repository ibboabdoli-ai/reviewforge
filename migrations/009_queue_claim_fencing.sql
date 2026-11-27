-- ReviewForge dedicated database only. Apply before deploying the claim-fenced worker.
-- Stop/drain older workers first; legacy running claims must never be replayed.
BEGIN;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claim_token TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claim_phase TEXT;
COMMIT;
