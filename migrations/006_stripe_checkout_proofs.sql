-- Signed Checkout completion proves a subscription/customer/user association.
BEGIN;
CREATE TABLE IF NOT EXISTS stripe_checkout_proofs (
  stripe_subscription_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL UNIQUE
);
COMMIT;
