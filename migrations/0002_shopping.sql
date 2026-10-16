-- ============================================================================
-- Migration 0002: Saved and Held for you (spec §7, §6.5).
-- ============================================================================

CREATE TABLE wishlist_items (
  user_id TEXT NOT NULL REFERENCES users(id),
  product_gid TEXT NOT NULL, variant_gid TEXT, product_handle TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, product_gid)
);

CREATE TABLE holds (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('object_hold','circle_waitlist')),
  product_handle TEXT, variant_gid TEXT,
  source TEXT NOT NULL CHECK (source IN ('storefront_form','portal','import')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted','released')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_holds_user ON holds(user_id);
