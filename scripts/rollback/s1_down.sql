-- ============================================================================
-- Manual rollback of migrations 0001–0005 (S1, S4, S9). NOT a migration: it lives
-- outside migrations/ so `wrangler d1 migrations apply` never runs it.
--
-- Use only together with rolling the Worker back to the pre-S1 version
-- (the one that reads `users` with PK email). It DROPS the portal tables, so
-- it is safe only while they hold nothing worth keeping — i.e. right after the
-- rollout. Later, prefer D1 Time Travel (see the PR / README).
--
--   wrangler d1 execute spring-renaissance --remote --file=scripts/rollback/s1_down.sql
-- ============================================================================

-- V2 Circle tables first (same list as scripts/rollback/v2_down.sql).
DROP TABLE IF EXISTS circle_locks;
DROP TABLE IF EXISTS room_photos;
DROP TABLE IF EXISTS concierge_messages;
DROP TABLE IF EXISTS concierge_threads;
DROP TABLE IF EXISTS skips;
DROP TABLE IF EXISTS capsule_claims;
DROP TABLE IF EXISTS capsules;
DROP TABLE IF EXISTS referral_coupons;
DROP TABLE IF EXISTS referrals;
DROP TABLE IF EXISTS referral_codes;
DROP TABLE IF EXISTS member_object_claims;
DROP TABLE IF EXISTS member_object_releases;
DROP TABLE IF EXISTS circle_price_grants;
DROP TABLE IF EXISTS circle_price_discounts;
DROP TABLE IF EXISTS anniversary_gifts;
DROP TABLE IF EXISTS gift_selections;
DROP TABLE IF EXISTS gift_options;
DROP TABLE IF EXISTS circle_price_items;
DROP TABLE IF EXISTS circle_price_list;
DROP TABLE IF EXISTS variant_costs;
DROP TABLE IF EXISTS catalog_variants;
DROP TABLE IF EXISTS economics_settings_history;
DROP TABLE IF EXISTS economics_settings;
DROP TABLE IF EXISTS admin_flags;
DROP TABLE IF EXISTS stripe_disputes;
DROP TABLE IF EXISTS stripe_payments;
DROP TABLE IF EXISTS membership_invoices;
DROP TABLE IF EXISTS cancellations;
DROP TABLE IF EXISTS redemptions;
DROP TABLE IF EXISTS credit_ledger;
DROP TABLE IF EXISTS memberships;
DELETE FROM d1_migrations WHERE name IN ('0006_membership.sql', '0007_economics_gifts.sql', '0008_member_price.sql', '0009_member_object.sql', '0010_referrals.sql', '0011_capsules_concierge.sql', '0012_review_fixes.sql');

DROP TABLE IF EXISTS step_up_codes;
DROP TABLE IF EXISTS webauthn_challenges;
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

DELETE FROM d1_migrations WHERE name IN ('0001_users.sql', '0002_shopping.sql', '0003_ops.sql', '0004_auth_challenges.sql', '0005_email_change.sql');
