-- ============================================================================
-- Migration 0004: one-time WebAuthn challenges and step-up email codes
-- (spec §10.3, §10.4; task S4). Not in the spec's data model — they are the
-- server-side state the two flows need. V2's membership tables move to 0005.
--
-- Both live in D1, not KV: each challenge and each code attempt is spent by a
-- guarded UPDATE, which needs D1's strong consistency.
-- ============================================================================

CREATE TABLE webauthn_challenges (
  challenge TEXT PRIMARY KEY,                -- base64url, as sent in the options
  purpose TEXT NOT NULL CHECK (purpose IN ('register','login','step_up')),
  user_id TEXT REFERENCES users(id),         -- register / step_up
  session_id_hash TEXT,                      -- step_up: bound to the session that asked
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);

CREATE TABLE step_up_codes (
  session_id_hash TEXT PRIMARY KEY REFERENCES sessions(id_hash),  -- one live code per session
  code_hash TEXT NOT NULL,                   -- SHA-256(code : session : pepper); the code itself is never stored
  attempts INTEGER NOT NULL DEFAULT 0,       -- 5 allowed
  expires_at TEXT NOT NULL,                  -- created + 10 minutes
  created_at TEXT NOT NULL
);
