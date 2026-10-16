-- ============================================================================
-- Migration 0009: the members' object (V2; docs/tz-v2-circle.md §4, §8) and,
-- with kind = 'early_access', the members' pre-order of a new piece (T21).
-- Every figure (price, edition, cost, window, dates, text, image) is Felix's;
-- a release cannot open while any is missing. The edition is capped in D1
-- (count of creating + invoiced + paid) and in Shopify inventory.
-- ============================================================================

CREATE TABLE member_object_releases (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'members_object' CHECK (kind IN ('members_object','early_access')),
  label TEXT NOT NULL, public_title TEXT, description TEXT, image_url TEXT,
  product_gid TEXT NOT NULL, variant_gid TEXT NOT NULL,
  price_cents INTEGER, edition_size INTEGER, unit_cost_cents INTEGER,
  shipping_class TEXT CHECK (shipping_class IN ('S','M','L')),
  reserve_hours INTEGER, opens_at TEXT, closes_at TEXT,
  show_remaining INTEGER NOT NULL DEFAULT 0,
  public_release_at TEXT, ships_note TEXT,                 -- early access only
  status TEXT NOT NULL CHECK (status IN ('draft','open','closed')),
  guard_ok INTEGER NOT NULL DEFAULT 0, guard_checked_at TEXT, guard_reasons TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE member_object_claims (
  id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES member_object_releases(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('creating','invoiced','paid','expired','failed','cancelled')),
  price_cents INTEGER NOT NULL, draft_order_gid TEXT, invoice_url TEXT, order_gid TEXT, reserved_until TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_active_claim ON member_object_claims(release_id, user_id) WHERE status IN ('creating','invoiced','paid');
CREATE INDEX idx_member_object_claims_status ON member_object_claims(status, reserved_until);
