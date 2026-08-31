-- ============================================================================
-- Spring Renaissance — D1 schema.
--
-- Everything that is mutated concurrently lives here (ADR-001). Sessions
-- (magic_<token>) and the customer index (cust_<id>) stay in KV: they are
-- written once and read by key, and KV's TTL is a free, reliable expiry
-- mechanism there is no reason to reimplement in SQL.
--
-- Apply with:
--   wrangler d1 execute spring-renaissance --local  --file=./schema.sql
--   wrangler d1 execute spring-renaissance --remote --file=./schema.sql
--
-- Every statement is idempotent, so re-applying is safe. The test harness
-- applies THIS file rather than a copy, so schema drift fails the suite.
-- ============================================================================

-- Client state. The single source of truth after migration.
CREATE TABLE IF NOT EXISTS users (
  email                  TEXT PRIMARY KEY,           -- normalized, lowercase+trim
  status                 TEXT NOT NULL DEFAULT 'Active',
                                                     -- Active | Paused (Offline) | Past Due | Canceled
  credits                INTEGER NOT NULL DEFAULT 0, -- projected into JSON as tokens
  skipped                INTEGER NOT NULL DEFAULT 0, -- 0/1, projected as boolean
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  magic_revoked_before   INTEGER NOT NULL DEFAULT 0, -- A-6, bulk revocation by timestamp
  past_due_at            INTEGER,
  canceled_at            INTEGER,
  updated_at             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_customer ON users (stripe_customer_id);

-- Curator chat state. One row per client.
CREATE TABLE IF NOT EXISTS chat_sessions (
  email              TEXT PRIMARY KEY,
  human_active_until INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL DEFAULT 0
);

-- Messages as individual rows: append becomes an INSERT and stops being a
-- rewrite of a whole array. This is the constructive close of A-5.
CREATE TABLE IF NOT EXISTS chat_messages (
  id      TEXT PRIMARY KEY,                          -- B-3: explicit id, not (ts|role|text)
  email   TEXT NOT NULL,
  author  TEXT NOT NULL,
  role    TEXT NOT NULL,                             -- user | assistant | curator
  text    TEXT NOT NULL,
  ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_email_ts ON chat_messages (email, ts);

-- ADR-004: webhook idempotency. A PRIMARY KEY conflict IS the "already seen"
-- answer, so check-and-reserve is one atomic statement (A-1).
CREATE TABLE IF NOT EXISTS processed_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT,
  processed_at INTEGER NOT NULL,        -- when the reservation was taken
  -- H-1: NULL means "reserved but not finished". A reservation is committed
  -- BEFORE the credit is applied, so an isolate that dies in between (CPU
  -- limit, eviction, OOM) leaves a row no catch and no finally will ever
  -- release. Stripe's retry then hits the PRIMARY KEY, is answered
  -- {duplicate:true}, stops retrying, and the payment is silently lost.
  -- A stale row that never completed is reclaimable; a completed one never is.
  --
  -- Existing deployments: ALTER TABLE processed_events ADD COLUMN completed_at INTEGER;
  completed_at INTEGER
);
-- E-3: the opportunistic cleanup runs on every reserved webhook. Without this
-- index `WHERE processed_at < ?` is a full table scan, and D1 meters rows read.
CREATE INDEX IF NOT EXISTS idx_processed_events_at ON processed_events (processed_at);

-- ADR-005: sliding-window rate limit.
CREATE TABLE IF NOT EXISTS rate_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket     TEXT NOT NULL,                          -- 'chat' | 'link_email' | 'link_ip'
  subject    TEXT NOT NULL,                          -- email or IP
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_events_lookup ON rate_events (bucket, subject, created_at);
-- E-3: the per-subject sweep rides the composite index above. The occasional
-- global sweep (subjects that probe once and never return) needs its own, or it
-- degrades into a full scan of a table an unauthenticated caller can grow.
CREATE INDEX IF NOT EXISTS idx_rate_events_created ON rate_events (created_at);
