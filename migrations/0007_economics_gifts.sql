-- ============================================================================
-- Migration 0007: Circle economics and gift pools (V2; docs/tz-v2-circle.md
-- §4 "0011_economics" and "0007_gifts", §12).
--
-- Costs, shipping and the Circle price list live here, never in Shopify
-- product data. catalog_variants is a read-only snapshot of the Shopify
-- catalog (synced by query only) so the economics can be computed without a
-- Shopify call per request. circle_price_items is computed, never edited.
-- ============================================================================

CREATE TABLE economics_settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, version INTEGER NOT NULL,
  updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE economics_settings_history (
  id TEXT PRIMARY KEY, key TEXT NOT NULL, value_json TEXT NOT NULL, version INTEGER NOT NULL,
  updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE catalog_variants (
  variant_gid TEXT PRIMARY KEY, product_gid TEXT NOT NULL, handle TEXT NOT NULL,
  product_title TEXT, variant_title TEXT, price_cents INTEGER NOT NULL,
  product_tags TEXT NOT NULL DEFAULT '[]', is_gift_card INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0, synced_at TEXT NOT NULL,
  sync_id TEXT NOT NULL                       -- the sync run that last saw it; older ones are removed
);
CREATE INDEX idx_catalog_variants_product ON catalog_variants(product_gid);
CREATE INDEX idx_catalog_variants_handle ON catalog_variants(handle);

CREATE TABLE variant_costs (
  variant_gid TEXT PRIMARY KEY, product_gid TEXT NOT NULL,
  cost_cents INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0),   -- NULL = not participating (≠ 0)
  zero_confirmed INTEGER NOT NULL DEFAULT 0,
  shipping_class TEXT CHECK (shipping_class IN ('S','M','L')),
  entered_by TEXT NOT NULL, entered_at TEXT NOT NULL,
  CHECK (cost_cents IS NULL OR cost_cents > 0 OR zero_confirmed = 1)
);

CREATE TABLE circle_price_list (                -- Felix's list
  variant_gid TEXT PRIMARY KEY, product_gid TEXT NOT NULL, added_by TEXT NOT NULL, added_at TEXT NOT NULL
);

CREATE TABLE circle_price_items (               -- computed from the three above + settings
  variant_gid TEXT PRIMARY KEY, product_gid TEXT NOT NULL, handle TEXT NOT NULL,
  price_cents INTEGER NOT NULL, circle_price_cents INTEGER, eligible INTEGER NOT NULL,
  reason TEXT, max_cost_cents INTEGER, shipping_estimate INTEGER, computed_at TEXT NOT NULL
);
CREATE INDEX idx_circle_price_items_handle ON circle_price_items(handle);

CREATE TABLE gift_options (                     -- welcome set and anniversary pool (Felix fills them in the admin)
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('welcome','anniversary')),
  title TEXT NOT NULL, blurb TEXT, shopify_variant_gid TEXT NOT NULL, image_url TEXT,
  landed_cost_cents INTEGER CHECK (landed_cost_cents IS NULL OR landed_cost_cents >= 0),  -- NULL = needs data
  shipping_class TEXT CHECK (shipping_class IN ('S','M','L')),
  active INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (active = 0 OR landed_cost_cents IS NOT NULL)
);

CREATE TABLE gift_selections (                  -- the welcome piece of one membership
  id TEXT PRIMARY KEY, membership_id TEXT NOT NULL UNIQUE REFERENCES memberships(id), user_id TEXT NOT NULL REFERENCES users(id),
  gift_option_id TEXT REFERENCES gift_options(id),
  status TEXT NOT NULL CHECK (status IN ('awaiting_choice','chosen','order_created','fulfilled','canceled')),
  shipping_json TEXT, shopify_order_gid TEXT, needs_attention INTEGER NOT NULL DEFAULT 0,
  reminded_at TEXT, chosen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT
);
CREATE UNIQUE INDEX uq_gift_per_user ON gift_selections(user_id) WHERE status <> 'canceled';

CREATE TABLE anniversary_gifts (
  id TEXT PRIMARY KEY, membership_id TEXT NOT NULL REFERENCES memberships(id), user_id TEXT NOT NULL REFERENCES users(id),
  streak_start TEXT NOT NULL, n INTEGER NOT NULL CHECK (n >= 1),
  status TEXT NOT NULL CHECK (status IN ('awaiting_address','ready','order_created','skipped_budget','canceled')),
  budget_cents INTEGER, gift_option_id TEXT REFERENCES gift_options(id), shipping_json TEXT, shopify_order_gid TEXT,
  reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (membership_id, streak_start, n)
);
