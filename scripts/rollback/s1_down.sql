-- ============================================================================
-- Manual rollback of migrations 0001–0003 (S1). NOT a migration: it lives
-- outside migrations/ so `wrangler d1 migrations apply` never runs it.
--
-- Use only together with rolling the Worker back to the pre-S1 version
-- (the one that reads `users` with PK email). It DROPS the portal tables, so
-- it is safe only while they hold nothing worth keeping — i.e. right after the
-- rollout. Later, prefer D1 Time Travel (see the PR / README).
--
--   wrangler d1 execute spring-renaissance --remote --file=scripts/rollback/s1_down.sql
-- ============================================================================

DROP TABLE IF EXISTS admin_audit;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS email_log;
DROP TABLE IF EXISTS webhook_events;
DROP TABLE IF EXISTS holds;
DROP TABLE IF EXISTS wishlist_items;
DROP TABLE IF EXISTS magic_links;
DROP TABLE IF EXISTS consents;
DROP TABLE IF EXISTS oauth_identities;
DROP TABLE IF EXISTS passkeys;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;

ALTER TABLE legacy_users RENAME TO users;
DROP INDEX IF EXISTS idx_legacy_users_customer;
CREATE INDEX IF NOT EXISTS idx_users_customer ON users (stripe_customer_id);

DELETE FROM d1_migrations WHERE name IN ('0001_users.sql', '0002_shopping.sql', '0003_ops.sql');
