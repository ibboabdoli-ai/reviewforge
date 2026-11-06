-- Preserve old reviews while allowing a transferred repository to be reviewed
-- under its new installation. Apply before deploying installation-scoped deduplication.
BEGIN;
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_repository_id_pr_number_head_sha_key;
CREATE UNIQUE INDEX IF NOT EXISTS reviews_installation_repository_pr_head_unique
  ON reviews(installation_id,repository_id,pr_number,head_sha);
COMMIT;
