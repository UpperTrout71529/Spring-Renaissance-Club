-- ============================================================================
-- Migration 0012: fixes from the V2 backend review (16 Oct 2026).
-- circle_locks: a short D1 lease so only one member-price sync talks to
-- Shopify at a time (no duplicate "Circle price" discounts). Draft ids on the
-- gift rows: a retry after a failed completion reuses the same draft instead
-- of creating a second order.
-- ============================================================================

CREATE TABLE circle_locks (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at TEXT NOT NULL);
ALTER TABLE gift_selections ADD COLUMN shopify_draft_gid TEXT;
ALTER TABLE anniversary_gifts ADD COLUMN shopify_draft_gid TEXT;
ALTER TABLE anniversary_gifts ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0;
