-- ============================================================================
-- Migration 0006: the Circle membership (V2; docs/tz-v2-circle.md §4,
-- spec v1.1 §7 "0003_membership").
--
-- memberships, credit_ledger, redemptions and cancellations are the spec's
-- tables with small additions (marked). New: membership_invoices (one row per
-- Stripe invoice — the anniversary count and refunds read it),
-- stripe_payments (charge → invoice: `charge.invoice` no longer exists in the
-- pinned API version), stripe_disputes (credits stay frozen while any dispute
-- is open) and admin_flags (signals for Felix: impersonation, object bypass,
-- duplicate subscription, invitation review).
-- Money in cents, times ISO UTC, ids ULID.
-- ============================================================================

CREATE TABLE memberships (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  stripe_subscription_id TEXT UNIQUE,
  stripe_customer_id TEXT,                                  -- added: the customer the subscription belongs to
  kind TEXT NOT NULL DEFAULT 'join' CHECK (kind IN ('join','rejoin')),   -- added: rejoin = no joining fee, no welcome piece
  status TEXT NOT NULL CHECK (status IN ('pending','active','past_due','canceling','ended','ended_expired')),
  started_at TEXT, current_period_start TEXT, current_period_end TEXT,
  cancel_requested_at TEXT, ended_at TEXT,
  last_paid_period_end TEXT,
  credits_grace_until TEXT,                                 -- last_paid_period_end + 30 days
  end_reason TEXT CHECK (end_reason IN ('canceled','payment_failed','account_deleted','admin')),
  consecutive_paid_months INTEGER NOT NULL DEFAULT 0,
  paid_invoices INTEGER NOT NULL DEFAULT 0,                 -- added: paid invoices of this subscription (anniversary, §10)
  credits_frozen INTEGER NOT NULL DEFAULT 0,
  terms_version TEXT,                                       -- added
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE credit_ledger (                                -- append-only; balance = SUM(amount_cents)
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  membership_id TEXT REFERENCES memberships(id),
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('accrual','welcome_accrual','redemption','redemption_return','manual','referral',
    'referral_reversal','refund_reversal','dispute_reversal','dispute_restore','expiry')),
  ref TEXT, memo TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ledger_user ON credit_ledger(user_id, created_at);

CREATE TABLE redemptions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 100),
  purpose TEXT NOT NULL DEFAULT 'credits' CHECK (purpose IN ('credits','capsule')),   -- added
  capsule_id TEXT,                                          -- added (purpose = capsule)
  client_key TEXT UNIQUE,                                   -- added: the client's Idempotency-Key, scoped by user
  shopify_gift_card_gid TEXT UNIQUE, gift_card_last4 TEXT,
  status TEXT NOT NULL CHECK (status IN ('creating','issued','failed','deactivated')),
  created_at TEXT NOT NULL, updated_at TEXT
);
CREATE INDEX idx_redemptions_user ON redemptions(user_id, created_at);

CREATE TABLE cancellations (
  id TEXT PRIMARY KEY, membership_id TEXT NOT NULL REFERENCES memberships(id),
  reason TEXT NOT NULL, comment TEXT,
  offer_shown TEXT, offer_accepted INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL CHECK (outcome IN ('canceled','saved','abandoned')),
  created_at TEXT NOT NULL, updated_at TEXT
);

CREATE TABLE membership_invoices (
  invoice_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, membership_id TEXT NOT NULL REFERENCES memberships(id),
  billing_reason TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  amount_paid_cents INTEGER, monthly_cents INTEGER, joining_cents INTEGER, discount_cents INTEGER,
  status TEXT NOT NULL CHECK (status IN ('open','paid','void','uncollectible')),
  had_failure INTEGER NOT NULL DEFAULT 0, paid_at TEXT, hosted_invoice_url TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_membership_invoices_membership ON membership_invoices(membership_id, period_start);

CREATE TABLE stripe_payments (
  payment_intent_id TEXT PRIMARY KEY, charge_id TEXT UNIQUE, invoice_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id), card_fingerprint TEXT, wallet TEXT,
  amount_cents INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_stripe_payments_user ON stripe_payments(user_id);

CREATE TABLE stripe_disputes (
  dispute_id TEXT PRIMARY KEY, charge_id TEXT, invoice_id TEXT, user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('open','won','lost')),
  reversed_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, closed_at TEXT
);

CREATE TABLE admin_flags (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                                       -- e.g. circle_price_non_member, object_bypass, duplicate_subscription, referral_review
  dedupe_key TEXT NOT NULL UNIQUE,
  user_id TEXT, ref TEXT, details_json TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT
);
CREATE INDEX idx_admin_flags_status ON admin_flags(status, created_at);
