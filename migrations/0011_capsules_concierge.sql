-- ============================================================================
-- Migration 0011: seasonal capsules and Skip (spec v1.1 §7 "0005_v2_extras",
-- §16.2), the concierge and Your rooms (§7, T13 v1). Capsule products are
-- existing Shopify products tagged "capsule"; their credit price is Felix's.
-- Room photos live in R2 (binding ROOMS), never public.
-- ============================================================================

CREATE TABLE capsules (
  id TEXT PRIMARY KEY, season TEXT NOT NULL, title TEXT NOT NULL,
  shopify_product_gid TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  min_consecutive_months INTEGER NOT NULL DEFAULT 2,
  opens_at TEXT NOT NULL, closes_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','scheduled','closed')),
  announced_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE capsule_claims (
  id TEXT PRIMARY KEY, capsule_id TEXT NOT NULL REFERENCES capsules(id),
  user_id TEXT NOT NULL REFERENCES users(id), redemption_id TEXT REFERENCES redemptions(id),
  status TEXT NOT NULL CHECK (status IN ('creating','issued','no_credits','failed')),
  created_at TEXT NOT NULL, UNIQUE (capsule_id, user_id)
);

CREATE TABLE skips (
  id TEXT PRIMARY KEY, membership_id TEXT NOT NULL REFERENCES memberships(id),
  capsule_id TEXT NOT NULL REFERENCES capsules(id),
  created_at TEXT NOT NULL, canceled_at TEXT
);
CREATE UNIQUE INDEX one_live_skip ON skips(membership_id, capsule_id) WHERE canceled_at IS NULL;

CREATE TABLE concierge_threads (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('open','answered','closed')), priority INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE concierge_messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES concierge_threads(id),
  author TEXT NOT NULL CHECK (author IN ('member','maison')), author_email TEXT, body TEXT NOT NULL,
  attachment_keys TEXT, created_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX idx_concierge_messages_thread ON concierge_messages(thread_id, created_at);

CREATE TABLE room_photos (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  room_label TEXT NOT NULL, r2_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_room_photos_user ON room_photos(user_id, created_at);
