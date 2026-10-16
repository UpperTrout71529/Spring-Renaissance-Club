-- ============================================================================
-- Migration 0010: invite a friend (V2; docs/tz-v2-circle.md §4, §11).
-- One code per member; one referral row per friend (a person can be invited
-- only once); at most one credited invitation per member per UTC quarter.
-- ============================================================================

CREATE TABLE referral_codes (
  code TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), created_at TEXT NOT NULL, disabled_at TEXT
);

CREATE TABLE referrals (
  id TEXT PRIMARY KEY, code TEXT NOT NULL REFERENCES referral_codes(code),
  referrer_user_id TEXT NOT NULL REFERENCES users(id), friend_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  season TEXT,                                               -- '2026Q4', UTC quarter of the friend's join
  status TEXT NOT NULL CHECK (status IN ('pending_checkout','expired','joined','qualifying','credited','not_counted_season',
    'not_counted_economics','rejected','void','lapsed','reversed','review')),
  checkout_session_id TEXT, subscription_id TEXT, coupon_id TEXT, discount_cents INTEGER NOT NULL,
  reward_cents INTEGER NOT NULL, friend_paid_invoices INTEGER NOT NULL DEFAULT 0,
  reason TEXT, credited_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_counted_referral_per_season ON referrals(referrer_user_id, season) WHERE status = 'credited';
CREATE INDEX idx_referrals_referrer ON referrals(referrer_user_id);

CREATE TABLE referral_coupons (                              -- one Stripe coupon per discount amount
  amount_cents INTEGER NOT NULL, product_id TEXT NOT NULL, coupon_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (amount_cents, product_id)
);
