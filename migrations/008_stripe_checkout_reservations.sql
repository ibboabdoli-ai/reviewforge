-- Tie a pending billing reservation to one Checkout session and restore a
-- previously terminal subscription when that session expires.
BEGIN;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS checkout_session_id TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS checkout_previous_status TEXT;
COMMIT;
