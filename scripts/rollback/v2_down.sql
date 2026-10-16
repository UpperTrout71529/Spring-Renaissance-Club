-- ============================================================================
-- Manual rollback of the V2 Circle migrations (0006+). NOT a migration: it
-- lives outside migrations/ so `wrangler d1 migrations apply` never runs it.
-- Drops the Circle tables; the V1 portal tables and the legacy tables stay.
-- Safe only while the Circle tables hold nothing worth keeping (before
-- launch); later prefer D1 Time Travel.
--
--   wrangler d1 execute <db> --remote --file=scripts/rollback/v2_down.sql
--
-- Keep in step with scripts/rollback/s1_down.sql (which drops these too).
-- ============================================================================

DROP TABLE IF EXISTS admin_flags;
DROP TABLE IF EXISTS stripe_disputes;
DROP TABLE IF EXISTS stripe_payments;
DROP TABLE IF EXISTS membership_invoices;
DROP TABLE IF EXISTS cancellations;
DROP TABLE IF EXISTS redemptions;
DROP TABLE IF EXISTS credit_ledger;
DROP TABLE IF EXISTS memberships;

DELETE FROM d1_migrations WHERE name IN ('0006_membership.sql');
