-- ============================================================================
-- Migration 0001: accounts, sessions, sign-in methods, consents (spec §7, §10.1).
--
-- The baseline `users` table (PK email, credits as an integer count) is the
-- pre-portal VIP subscriber record. The spec's `users` is a different entity
-- (ULID id, Club/VIP tier, ISO times), so the old table is renamed to
-- `legacy_users` — data moves with it, nothing is dropped — and the legacy
-- worker code reads and writes `legacy_users` from now on.
--
-- All times are ISO 8601 UTC TEXT (always Date#toISOString, so they compare
-- correctly as strings). IDs are ULIDs. Money is integer cents.
-- ============================================================================

ALTER TABLE users RENAME TO legacy_users;
DROP INDEX IF EXISTS idx_users_customer;
CREATE INDEX IF NOT EXISTS idx_legacy_users_customer ON legacy_users (stripe_customer_id);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email_verified_at TEXT,
  first_name TEXT, last_name TEXT,
  shopify_customer_id TEXT UNIQUE,          -- gid://shopify/Customer/…
  stripe_customer_id TEXT UNIQUE,
  tier TEXT NOT NULL DEFAULT 'club' CHECK (tier IN ('club','vip')),
  seasonal_email_opt_in INTEGER NOT NULL DEFAULT 0,
  circle_teaser_snoozed_until TEXT,
  onboarding_dismissed_at TEXT,
  created_at TEXT NOT NULL, last_login_at TEXT,
  deleted_at TEXT                            -- soft delete, then anonymisation (§13.4)
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,                  -- SHA-256(token + SESSION_PEPPER); the token lives only in the cookie
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,             -- sliding: last_seen + 14 days
  absolute_expires_at TEXT NOT NULL,         -- created + 90 days
  step_up_at TEXT,
  auth_method TEXT NOT NULL CHECK (auth_method IN ('magic_link','passkey','google','apple')),
  ua_summary TEXT, geo_city TEXT,            -- no raw IP
  revoked_at TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE passkeys (
  credential_id TEXT PRIMARY KEY,            -- base64url
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key BLOB NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT, aaguid TEXT, device_label TEXT,
  backed_up INTEGER, created_at TEXT NOT NULL, last_used_at TEXT
);
CREATE INDEX idx_passkeys_user ON passkeys(user_id);

CREATE TABLE oauth_identities (
  provider TEXT NOT NULL CHECK (provider IN ('google','apple')),
  subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  email_at_link TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);

CREATE TABLE consents (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('membership_terms','auto_renewal','age_18','seasonal_email','privacy')),
  document_version TEXT NOT NULL,
  shown_text_sha256 TEXT NOT NULL,
  granted INTEGER NOT NULL,                  -- 1 granted / 0 withdrawn
  ua_summary TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_consents_user ON consents(user_id);

-- §10.1: magic links live in D1, not KV — one-time use needs strong
-- consistency, which KV's eventual reads cannot give.
CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,               -- SHA-256 of the token; the token itself is never stored
  email TEXT NOT NULL,
  return_to TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('sign_in','email_change')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_magic_links_expires ON magic_links(expires_at);
