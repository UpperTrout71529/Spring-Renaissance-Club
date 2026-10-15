-- ============================================================================
-- Migration 0003: webhooks, email log, analytics events, admin audit.
--
-- The spec names this file 0004_ops.sql and reserves 0003 for the V2
-- membership tables. Migrations are numbered here in the order they ship, so
-- V2's membership migration will be 0004.
--
-- `webhook_events` is the spec's ledger for Stripe and Shopify deliveries. The
-- baseline `processed_events` keeps serving the legacy Stripe handler until
-- the V2 webhook (/webhooks/stripe, task T2) replaces it.
-- ============================================================================

CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK (source IN ('stripe','shopify')),
  type TEXT NOT NULL, received_at TEXT NOT NULL, processed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('received','processed','failed','ignored')), error TEXT
);

CREATE TABLE email_log (
  id TEXT PRIMARY KEY, user_id TEXT, template TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,           -- e.g. 'renewal_reminder:sub_x:2026-12-14'
  resend_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE events (                        -- product analytics (§15)
  id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, props_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_events_name_time ON events(name, created_at);

CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT, payload_json TEXT, created_at TEXT NOT NULL
);
