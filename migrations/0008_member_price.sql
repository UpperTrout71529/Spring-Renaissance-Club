-- ============================================================================
-- Migration 0008: the member price in Shopify (V2; docs/tz-v2-circle.md §4,
-- §7). One automatic "Circle price" discount per shard of members; grants say
-- who should have the price (open = revoked_at IS NULL), the discount rows
-- what Shopify was last told. The reconcile makes Shopify match the grants.
-- ============================================================================

CREATE TABLE circle_price_discounts (
  id TEXT PRIMARY KEY, shard INTEGER NOT NULL UNIQUE, shopify_discount_gid TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active','inactive','error')),
  customers INTEGER NOT NULL DEFAULT 0, variants INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT, last_error TEXT, created_at TEXT NOT NULL
);

CREATE TABLE circle_price_grants (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), shopify_customer_gid TEXT NOT NULL,
  shard INTEGER NOT NULL, granted_at TEXT NOT NULL, revoked_at TEXT, revoke_reason TEXT
);
CREATE UNIQUE INDEX one_open_grant ON circle_price_grants(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_circle_price_grants_open ON circle_price_grants(revoked_at, shard);
