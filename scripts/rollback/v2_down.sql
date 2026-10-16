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
