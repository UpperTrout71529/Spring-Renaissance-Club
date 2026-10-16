# ЛК V2 — The Renaissance Circle (VIP): architecture and build spec

Version 0.1, 16 Oct 2026. **Architecture only — no code until Felix's "yes".**

Sources: spec v1.1 (`ЛК — ТЗ v1 (2026-10-15).md`: §6.7, J5–J11, §7, §8.4,
§9.1, §9.2.4–9.2.6, §16, §17.4) and Felix's brief
`ЛК — промпт V2 VIP Circle (2026-10-16).md` (items B, C, G, H and the
economics rules). Where this document differs from spec v1.1 it says so
(**Δ**). Facts about Shopify and Stripe were researched against official docs
and then checked by an independent reviewer that tried to refute them; the
cited checks live in the session notes. Nothing in Shopify, Stripe, Cloudflare
or D1 was changed for this document.

Hard rules that hold for every task below: no AI anywhere in the portal or in
Circle mechanics; Stripe test mode only until the launch gate; Shopify — only
the draft theme `189482795229`, product data (descriptions, prices, variants,
metafields, tags, publications) only after Felix's "yes"; production only after
"yes"; money in integer cents; no invented costs, prices, editions, dates or
reviews — empty field + "needs data from Felix".

---

## 1. What V2 is

### 1.1 The membership (kept from spec v1.1)
- **Joining:** first invoice $50 = $20 first month + $30 joining fee; then
  $20/month (+ sales tax if the tax advisor says so, §9.1.6).
- **Credits:** each paid month's $20 becomes 20 credits (1 credit = $1); the
  joining fee gives none. Spent as a single-use Shopify gift card.
- **Member price:** 25% off eligible pieces (eligibility now decided by D1 and
  the economics rules — §6, §7).
- **Welcome piece:** a sealed object chosen from a closed set after joining.
  Objects are never named in public copy; "Welcome Gift" / "Complimentary
  Gift" are not used.
- **Seasonal capsules** with Skip (Skip does not stop billing — §16.2 v1).
- **Concierge** — Felix answers, no AI. **Your rooms** (Spatial Profile).
- **Early access, 48 hours,** and first right to numbered editions. Δ Neither
  spec v1.1 nor the brief defines how this works; see §1.4.
- **Refills** — shown as "coming" on the benefits page only; no dates, no
  prices, no mechanism.

### 1.2 New (brief, 16 Oct)
- **B. Members' object** — one a year, purchasable only from the portal (§8).
- **C. Circle price on the storefront** — "Circle price $X" under the price on
  eligible product pages; the 25% really applies to members at checkout (§7).
- **G. Anniversary gift** — at 12, 24, … months of continuous paid
  membership (§10).
- **H. Invite a friend** — once a season, friend gets money off the joining
  fee, member gets credits after the friend's second paid month (§11).

### 1.4 Early access — mechanism to decide
Shopify cannot show a product to members 48 hours before everyone else
without Plus features. Proposal: during the 48-hour window the new piece stays
unpublished and members buy it through the same portal draft-order path as the
Members' object (§8), with the 25% applied as a draft line discount where the
piece is eligible; at the end of the window Felix publishes it. Until Felix
chooses, the benefits page does not list early access (only working benefits
are shown).

### 1.3 Rejected (do not build)
Numbered membership card; holds without payment; lifetime care (maybe later);
certificate and registry.

---

## 2. What changes against spec v1.1 (Δ summary)

| # | Spec v1.1 | V2 |
|---|---|---|
| 1 | §9.2.5: member price by tag + automatic discount, or a Function, or per-member codes (spike) | **Automatic discount limited to specific customers** (`context.customers`), items = D1-computed eligible variants; Worker grants/revokes; reconcile every 5 min. Functions ruled out (custom app + Basic plan). Per-member codes = fallback. §7 |
| 2 | Eligible products = everything except tags `catalog`, `capsule`, gift cards | **Eligibility list in D1** (admin) ∩ economics rule 2 (cost entered, margin ≥ min). Tags `catalog`/`capsule`, gift cards and the Members' object stay hard exclusions. No product tags/metafields needed. |
| 3 | Credits accrue 20 per paid month | Same. **New cost:** this store pays Shopify's **2% third-party transaction fee on every gift-card payment** (stores created on/after 12 May 2025; this one: 10 Mar 2026). Built into the economics (§12). |
| 4 | §9.1.1 one Stripe Product with two prices | **Joining fee becomes its own Product** — the referral coupon must target it alone (`applies_to.products`). |
| 5 | §9.1.3 Smart Retries 3 tries / 10 days | Smart Retries cannot do 10 days (1w/2w/3w/1m/2m). **Custom retry schedule** +3/+4/+3 days, then cancel. |
| 6 | §9.1.4 field names | Pinned Stripe API `2026-09-30.endive`; `current_period_end` lives on subscription items; `charge.invoice` no longer exists (map charge→invoice in D1); upcoming invoice → **Create Preview Invoice**. New events: `checkout.session.expired`, `invoice.payment_action_required`, `customer.subscription.created`. |
| 7 | T14 referral (proposal: 20 credits, 10/year) | **H**: once per season (quarter); defaults −$10 to friend / +10 credits to member; reward after friend's 2nd paid invoice; card-fingerprint + email + history checks; economics rule 3 gate. |
| 8 | — | **B Members' object**, **G anniversary**, **economics engine + admin Economics screen** (new tasks). |
| 9 | `gift_options` = welcome set, ≤ $25 | `gift_options.kind` = `welcome` / `anniversary`; anniversary items limited by the budget rule, not the $25 cap. |
| 10 | V2 migrations "0003_membership", "0005_v2_extras" | Repo already uses 0003–0005 → V2 starts at **0006** (contiguous, enforced by tests). |
| 11 | Legacy VIP system in `worker.js` untouched | **Retired in three steps without deleting code** (§14): AI curator off; legacy Stripe catch-all gated before the V2 webhook exists; legacy `/api/user/*` at launch. The legacy webhook reacts to every subscription event — running it next to V2 would double-process. |
| 12 | Webhook secret `STRIPE_WEBHOOK_SECRET` | V2 uses **`STRIPE_CIRCLE_WEBHOOK_SECRET`** (the legacy handler owns the old name; each Stripe endpoint has its own secret). |
| 13 | Cron: hourly + daily | One `*/5` trigger + the daily one, dispatched in code (Workers Free allows 5 cron triggers per account; see §15 for the plan question). |

---

## 3. Screens

Background `#FBFBF9`, headings DM Serif Display, copy from `portal/src/copy/en.ts`
only, quiet tone (no capitals for emphasis, no exclamation marks). Anything not
working yet is not shown, except Refills ("coming").

### 3.1 Portal (club.)
| Route | Who | Content |
|---|---|---|
| `/circle` (Club) | non-members | Benefits page (§16 copy): what membership is, how it works (3 steps), the list of benefits (only working ones; Refills "coming"), price and renewal disclosure, FAQ (pending legal review, behind `VITE_CIRCLE_FAQ` as in V1), [Join the Circle] when the launch gate allows, otherwise "Reserve a place" (V1). |
| `/circle/join` | Club, no active membership | Offer summary, auto-renewal disclosure (§14.2 v1), two unticked consents (Terms + auto-renewal, 18+), [Continue to payment] → Stripe Checkout. With `?invite=<code>`: one quiet line "Your invitation takes $10 off the joining fee." (amount from settings). Outside the US: "The Circle is currently available in the United States." |
| `/circle/welcome` | after Checkout | "Confirming your membership…" (poll ≤ 20 s, §16.3 #2) → Unsealing (the only rich animation; skippable; off with reduced motion) → choose the sealed piece. |
| `/circle` (member) | active/past_due/canceling/ended(grace) | §6.7 v1 layout + new blocks: **Treasury** (balance, next accrual, [Use credits] [History]); **Welcome piece** (until chosen); **Members' object** (only when a release is open — §8); **Capsules**; **Invite a friend** (§11); **Concierge**; **Your rooms**; **Anniversary** (only when a gift is waiting for an address — §10); **Membership & billing →**. Banners for past_due / canceling / ended per §6.7 v1. |
| `/circle/credits` | member | History table (§6.7 v1) + new row types `Referral — {first name}`, `Reversed — referral`. |
| `/circle/credits/use` | member | 3 steps (§6.7 v1); step-up if older than 15 min. |
| `/circle/object` | active member, release open | Image/description as Felix enters them (no name until he sets one), price, "One per member", remaining count only if Felix enables it, [Reserve mine] → creates the invoice → [Pay now] (Shopify checkout). States: reserved until {date}, paid, expired, sold out. |
| `/circle/invite` | active member | Personal link + code, [Copy link]; rules in one paragraph; status of this season's invitation (none / joined / counted / used this season). |
| `/circle/anniversary` | member with a waiting gift | Confirm or edit the delivery address (US), [Send my gift]. |
| `/circle/capsules`, `/circle/concierge`, `/circle/rooms` | member | As spec T12/T13 v1. |
| `/account/membership` | member | Plan, next charge (from Create Preview Invoice), card (Stripe Customer Portal link), invoices, [Cancel membership] (§16.1 v1, ≤ 3 screens). |
| `/circle/rejoin` | ended | $20/month, no joining fee, no new welcome piece (assumption 18.1 v1). |

### 3.2 Storefront (draft theme 189482795229 only)
- `snippets/sr-circle-price.liquid` on product pages: under the regular price,
  small: "Circle price $X · About the Circle" (link to `club./circle`).
  Data from a public, cacheable Worker endpoint per product (§5.2) — the same
  D1 computation that feeds the Shopify discount, so the page never promises a
  price checkout does not give. Updates on variant change (listens to the
  theme's variant-change event; falls back to the `variant` URL parameter).
  Not shown for: ineligible variants, gift cards, the Members' object,
  capsules, `catalog` (Small Pleasures).
- **Members' object page** (§8.4): "Members only" + link to the Circle, no add
  to cart.
- Circle page (`patron-membership`): button → `club./circle/join` at launch.

### 3.3 Admin (`/admin`, behind Access)
New screens: **Economics** (§12.6), **Costs & Circle price** (cost per variant,
average shipping, eligibility list, computed result + reason, sync status with
Shopify), **Gift pools** (welcome / anniversary options with landed cost),
**Gift queue** (welcome + anniversary, create order), **Members' object**
(releases), **Invitations** (settings, list, manual review queue),
**Capsules**, **Concierge**; **Members** gains membership, ledger, adjust
credits (note required), invoices. Every write → `admin_audit`. Writes need an
admin same-origin check (today `assertTrustedMutation` only allows the portal
origins).

---

## 4. Data model (D1)

All money in cents, times ISO UTC, ids ULID. Migrations continue from 0005.
Spec §7 tables are used as written unless marked Δ.

**0006_membership.sql** — `memberships` (spec §7, + Δ `paid_streak_started_at`
not stored: the streak is derived, §10), `credit_ledger` (spec; Δ kinds add
`referral_reversal`), `redemptions` (spec), `cancellations` (spec), and Δ:
```sql
CREATE TABLE membership_invoices (            -- one row per Stripe invoice of a membership
  invoice_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, membership_id TEXT NOT NULL REFERENCES memberships(id),
  billing_reason TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  amount_paid_cents INTEGER, monthly_cents INTEGER, joining_cents INTEGER, discount_cents INTEGER,
  status TEXT NOT NULL CHECK (status IN ('open','paid','void','uncollectible')),
  had_failure INTEGER NOT NULL DEFAULT 0, paid_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE stripe_payments (                -- charge → invoice map (charge.invoice was removed in basil)
  payment_intent_id TEXT PRIMARY KEY, charge_id TEXT UNIQUE, invoice_id TEXT NOT NULL,
  user_id TEXT NOT NULL, card_fingerprint TEXT, wallet TEXT, amount_cents INTEGER NOT NULL, created_at TEXT NOT NULL
);
```
**0007_gifts.sql** — `gift_options` (spec + Δ `kind TEXT CHECK (kind IN
('welcome','anniversary'))`, Δ `landed_cost_cents` NULL allowed = "needs data";
the ≤ 2500 CHECK applies to `welcome` only), `gift_selections` (spec), and Δ:
```sql
CREATE TABLE anniversary_gifts (
  id TEXT PRIMARY KEY, membership_id TEXT NOT NULL REFERENCES memberships(id), user_id TEXT NOT NULL,
  streak_start TEXT NOT NULL, n INTEGER NOT NULL CHECK (n >= 1),       -- 12·n months
  status TEXT NOT NULL CHECK (status IN ('awaiting_address','ready','order_created','skipped_budget','canceled')),
  gift_option_id TEXT REFERENCES gift_options(id), shipping_json TEXT, shopify_order_gid TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (membership_id, streak_start, n)                                -- one gift per anniversary
);
```
**0008_capsules.sql** — `capsules`, `capsule_claims`, `skips` (spec; skips
after capsules for the FK).
**0009_concierge.sql** — `concierge_threads`, `concierge_messages`,
`room_photos` (spec).
**0010_referrals.sql** — Δ replaces spec `referrals`:
```sql
CREATE TABLE referral_codes (code TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), created_at TEXT NOT NULL, disabled_at TEXT);
CREATE TABLE referrals (
  id TEXT PRIMARY KEY, code TEXT NOT NULL REFERENCES referral_codes(code),
  referrer_user_id TEXT NOT NULL REFERENCES users(id), friend_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  season TEXT NOT NULL,                                  -- '2026Q4', UTC quarter of the friend's join
  status TEXT NOT NULL CHECK (status IN ('pending_checkout','expired','joined','qualifying','credited','not_counted_season','not_counted_economics','rejected','void','lapsed','reversed','review')),
  checkout_session_id TEXT, subscription_id TEXT, coupon_id TEXT, discount_cents INTEGER NOT NULL,
  reward_cents INTEGER NOT NULL, friend_paid_invoices INTEGER NOT NULL DEFAULT 0,
  reason TEXT, credited_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_counted_referral_per_season ON referrals(referrer_user_id, season) WHERE status = 'credited';
```
**0011_economics.sql** — Δ:
```sql
CREATE TABLE economics_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
  -- min_margin_bps 1500; avg_shipping_cents NULL; fee profile (bps, fixed); referral_discount_cents 1000; referral_reward_cents 1000;
  -- anniversary_cap_cents 1500; anniversary_share_bps 2000; guard_profile 'worst'; all versioned + audited
CREATE TABLE variant_costs (variant_gid TEXT PRIMARY KEY, product_gid TEXT NOT NULL, cost_cents INTEGER,   -- NULL = not participating
  zero_confirmed INTEGER NOT NULL DEFAULT 0, entered_by TEXT NOT NULL, entered_at TEXT NOT NULL);
CREATE TABLE circle_price_list (variant_gid TEXT PRIMARY KEY, product_gid TEXT NOT NULL, added_by TEXT NOT NULL, added_at TEXT NOT NULL);  -- Felix's list
CREATE TABLE circle_price_items (                         -- computed, never edited by hand
  variant_gid TEXT PRIMARY KEY, product_gid TEXT NOT NULL, handle TEXT NOT NULL, price_cents INTEGER NOT NULL,
  circle_price_cents INTEGER, eligible INTEGER NOT NULL, reason TEXT, max_cost_cents INTEGER, computed_at TEXT NOT NULL);
CREATE TABLE circle_price_discounts (id TEXT PRIMARY KEY, shopify_discount_gid TEXT UNIQUE, kind TEXT NOT NULL, max_customers INTEGER NOT NULL,
  status TEXT NOT NULL, last_reconciled_at TEXT);
CREATE TABLE circle_price_grants (user_id TEXT NOT NULL REFERENCES users(id), shopify_customer_gid TEXT NOT NULL, discount_id TEXT NOT NULL,
  granted_at TEXT NOT NULL, revoked_at TEXT, revoke_reason TEXT);
CREATE UNIQUE INDEX one_open_grant ON circle_price_grants(user_id) WHERE revoked_at IS NULL;
CREATE TABLE member_object_releases (id TEXT PRIMARY KEY, label TEXT NOT NULL, public_title TEXT, description TEXT, image_url TEXT,
  product_gid TEXT NOT NULL, variant_gid TEXT NOT NULL, price_cents INTEGER, edition_size INTEGER, unit_cost_cents INTEGER,
  reserve_hours INTEGER, opens_at TEXT, closes_at TEXT, status TEXT NOT NULL CHECK (status IN ('draft','open','closed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);      -- any NULL among price/edition/cost/reserve → cannot open
CREATE TABLE member_object_claims (id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES member_object_releases(id),
  user_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK (status IN ('creating','invoiced','paid','expired','failed','cancelled')),
  price_cents INTEGER NOT NULL, draft_order_gid TEXT, invoice_url TEXT, order_gid TEXT, reserved_until TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX one_active_claim ON member_object_claims(release_id, user_id) WHERE status IN ('creating','invoiced','paid');
```

**Invariants** (spec §7 plus): balance = `SUM(credit_ledger)`; every ledger
row has a unique idempotency key; a spend checks balance and inserts in one D1
batch; Stripe objects are keyed by object id (invoice, charge, dispute) — not
only by event id (Stripe can emit two events for one change).

---

## 5. API

### 5.1 Member (session cookie, portal headers on writes)
Spec §8.4 stays. Additions/changes:
| Method | Path | Notes |
|---|---|---|
| POST | `/api/circle/checkout` | Δ body may carry `invite_code`; Worker runs the referral gate (§11.2) before creating the session; Δ joining-fee Product B; idempotency key `circle-checkout:<user>:<day>:<variant>` |
| GET | `/api/circle` | one call for the member page: membership, balance, next accrual, welcome status, open release, invitation status, anniversary waiting |
| GET | `/api/circle/object` | release (public fields only) + my claim |
| POST | `/api/circle/object/claim` | `{ release_id }` only; variant/price/quantity always from D1; active membership required (not past_due/canceling — Felix to confirm); 201 `{ invoice_url, reserved_until }`; same answer for a second tab |
| GET/POST | `/api/circle/invite` | my code/link, season status |
| GET/POST | `/api/circle/anniversary` | waiting gift; `{ address }` → create order |
| GET | `/api/account/membership` | plan, next charge preview, invoices, portal link |

### 5.2 Public (no cookie, cacheable)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/storefront/circle-price?product=<handle>` | `{ variants: { "<numeric id>": { price_cents, circle_price_cents } } }` — eligible variants only; `Cache-Control: public, max-age=300`; CORS for the storefront origin without credentials |
| GET | `/api/me/storefront` | (spec) `{ is_member }` with the session cookie — only for "You'll get this at checkout" wording |

### 5.3 Admin (Access JWT + audit)
Spec §8.6 + Δ: `GET/PUT /api/admin/economics` (settings; save blocked with the
computed explanation, §12.5), `GET/PUT /api/admin/costs` (per variant),
`GET/PUT /api/admin/circle-price/list`, `POST /api/admin/circle-price/sync`,
`GET/POST/PATCH /api/admin/gift-options` (+kind), `GET /api/admin/gift-queue`
(+anniversary), `GET/POST/PATCH /api/admin/member-object/releases`,
`GET /api/admin/member-object/guard`, `GET/PATCH /api/admin/invitations`
(review queue), `POST /api/admin/credits/adjust` (note required).

---

## 6. Webhooks

### 6.1 Stripe — `POST /webhooks/stripe`
Snapshot payload, API version `2026-09-30.endive` pinned on the destination and
on every V2 call; secret `STRIPE_CIRCLE_WEBHOOK_SECRET`; signature checked with
the existing SubtleCrypto verifier; `livemode` must match the environment;
`webhook_events(source='stripe')` reserve → process → `processed`, failure →
500 so Stripe retries. Objects keyed by id.

| Event | Action |
|---|---|
| `checkout.session.completed` | upsert membership by subscription (`active`), consents, tier `vip`, tag, grant member price (§7), welcome selection or welcome_back; referral `joined` |
| `checkout.session.expired` | referral `expired` |
| `customer.subscription.created/updated` | sync status, `cancel_at_period_end`, period from `items.data[0]` → `active`/`canceling`/`past_due` |
| `invoice.paid` (`subscription_create`/`subscription_cycle`) | `membership_invoices` paid; `stripe_payments` (+ card fingerprint via InvoicePayment → PaymentIntent → charge); ledger `accrual` = monthly line without tax, key `accrual:<invoice>`; recover `past_due` → `active` + grant; anniversary recompute (§10); referral count (§11) |
| `invoice.payment_failed` | `had_failure=1` (streak breaks), `past_due`, **revoke member price**, emails per §9.1.4 v1 |
| `invoice.payment_action_required` | email with `hosted_invoice_url`; as payment_failed |
| `customer.subscription.deleted` | `ended`, `end_reason` from `cancellation_details.reason`, grace = last paid period end + 30 days, revoke, tag `vip-circle-past`; friend referral before 2nd payment → `lapsed` |
| `charge.refunded` | via `stripe_payments`: `refund_reversal`; friend's 1st/2nd charge → referral `void`/`reversed` |
| `charge.dispute.created` / `.closed` | freeze + `dispute_reversal` + revoke + mail Felix / won → reverse |
| `payment_method.attached`, `customer.updated` | "I've updated my card" recovery (§9.1.4 v1) |

Missed webhooks: a daily reconcile reads each active/past_due/canceling
membership's subscription and last 30 invoices from Stripe and replays the
derived state (the 5-minute member-price promise also needs this — §7.4).

### 6.2 Shopify — `POST /webhooks/shopify` (exists, V1)
| Topic | Action |
|---|---|
| `orders/create` | V1 `order_placed`; Δ audit: a "Circle price" discount on an order whose customer is not an active member → admin flag; an order containing the Members' object variant that is not a paid claim → admin flag + email to Felix |
| `draft_orders/update` (new subscription) | claim / welcome / anniversary draft completed → `paid` / `order_created` |
| `products/update` (new) | price change → recompute rule 2 for its variants → sync the discount |
| `discounts/update` (optional) | someone edited "Circle price" by hand → reconcile now |

Scopes to add to "Claude Sync": `read_publications`, `read_inventory` (write
scopes already include read).

---

## 7. Member price in Shopify (C)

### 7.1 Decision
One native **automatic** product discount, "Circle price", 25%, created with
`discountAutomaticBasicCreate`:
- **who:** `context.customers` — the Shopify customer ids of active members,
  added/removed by the Worker (`discountAutomaticBasicUpdate`). Not a tag
  segment (segment refresh timing is undocumented).
- **what:** `items.products.productVariantsToAdd/Remove` = the computed
  eligible variants (§12 rule 2).
- `combinesWith`: product and order discounts **false**, shipping true — one
  promotion at a time, Shopify applies the better one; gift cards (credits)
  are a payment, so they still work with the 25%.
- Draft orders the Worker creates (welcome, anniversary, Members' object) set
  `acceptAutomaticDiscounts: false`.

### 7.2 Why
- **Shopify Functions are out:** custom apps containing Functions require
  Plus; "Claude Sync" is a custom app and the store is on Basic.
- **B2B catalogs are out:** company buyers who sign in.
- **Customer-eligible automatic discounts exist since API 2025-10** and the
  docs show no plan restriction. Members are not signed in to Shopify:
  Shopify identifies a buyer at checkout by a signed-in account **or the email
  / phone typed at checkout** (documented for segments and codes; for a
  "specific customers" automatic discount it is not stated explicitly — the
  spike T6.1 must prove it). The member therefore sees the 25% in checkout
  once they type their Circle email; the storefront line sets that
  expectation ("Use your Circle email at checkout").

### 7.3 Grant and revoke
Grant: status `active` or `canceling` (paid period still running). Revoke:
`past_due` (spec #8), `ended`, `ended_expired`, account deletion. Each change
is one synchronous Admin call; a **reconcile every 5 minutes** reads the
discount back (`discountNode`) and diffs it with D1; a **daily Stripe
reconcile** catches missed Stripe webhooks; `canceling` past
`current_period_end` is revoked on D1 time without waiting for Stripe.

### 7.4 Limits and failure modes
- Shopify documents a 100-entity cap (customers + products + variants) for
  discount **codes**; automatic discounts have no documented cap. The design
  shards: several identical discounts, each with ≤ N customers (N in config,
  set by the spike); a store may have 25 active automatic discounts.
- An empty eligible list is possible at launch (no costs entered →
  nothing eligible). Shopify may refuse a discount that applies to nothing
  (`APPLIES_ON_NOTHING`): the discount is then deactivated until the list is
  non-empty, and the storefront shows no Circle price.
- **Impersonation:** someone who types a member's email at checkout gets
  25%. Rule 2 keeps every discounted variant above the minimum margin (on the
  configured shipping average), and the `orders/create` audit flags it.
  Requiring members to sign in to Shopify accounts would close it but the
  store hides login links and it is not a per-customer setting.

### 7.5 Fallback (if the spike fails)
One **discount code per member** (`discountCodeBasicCreate`,
`context.customers` = that member), applied by the portal link
`https://springrenaissance.store/discount/<CODE>`; revoke =
`discountCodeDeactivate`. Everything else (D1 items, reconcile, audit) stays.

### 7.6 Storefront line
`sr-circle-price` reads `/api/storefront/circle-price` — the same
`circle_price_items` that feed the discount — and shows
`circle_price_cents = p − floor(p · 25 / 100)` (= `ceil(0.75 p)`, exactly what
Shopify charges for a 25% line discount; never lower than checkout).

---

## 8. Members' object (B)

### 8.1 Decision — draft orders only
Functions (cart validation) are not available (Plus only). The bypass is
closed by **publishing**, not by theme code:
- The object is its own product, **ACTIVE but published to no sales channel**
  (today: Online Store, Point of Sale, Pinterest, Facebook & Instagram). Never
  UNLISTED (behaves like active in cart/checkout). Created in DRAFT status,
  channels removed, inventory tracked with policy DENY and quantity = edition
  size, only then ACTIVE (new products default to all channels).
- Purchase only through `POST /api/circle/object/claim`: active membership
  checked in D1 → one atomic D1 insert (open release, room in the edition,
  one active claim per member per release) → `draftOrderCreate` with the
  member as customer, quantity 1, `priceOverride` = D1 price, free shipping,
  `acceptAutomaticDiscounts: false`, `allowDiscountCodesInCheckout: false`, no
  applied discount, `reserveInventoryUntil` = now + reservation window, tags
  `circle-object`, `circle-claim-<id>` → the invoice link is shown in the
  portal and sent by our email.
- The 25% never applies: two flags on the draft + the object is excluded from
  the Circle price items.
- Credits: paying a draft invoice with a gift card is undocumented — tested on
  a dev store (§17 question). If it fails, credits can be applied as a
  discount line on the draft (accountant check) or the object is card-only.

### 8.2 Payment, expiry, races
`draft_orders/update` + `draftOrder(id).order` → `paid`. Cron: invoiced past
`reserved_until` → completed ? paid : delete draft → `expired` (slot freed).
`creating` stuck → found by tag → `invoiced`, else `failed` (no second draft).
Two tabs → the same claim and link. Edition capped in D1 (count of
creating+invoiced+paid) and in Shopify inventory.

### 8.3 Bypass tests
Automated (no Shopify network): 401/403/409 paths; snapshot of the draft
variables (flags, price from D1, quantity 1); concurrency (one draft; edition
never exceeded); expiry; release cannot open without price/edition/cost/
window or when rule 5 fails; client-supplied price/variant ignored; guard
logic. Live read-only guard (Admin query: publications, status, inventory
policy, price) nightly and before a release opens — fails closed. Anonymous
storefront probes after Felix's yes: `/products/<handle>.js` 404,
`POST /cart/add.js` with the variant → error, `/cart/<id>:1` → no checkout.
Dev-store e2e (Bogus gateway) for invoice behaviour.

### 8.4 The "product page"
A product unpublished from the Online Store has no product page. Options for
Felix: (a) **recommended:** a Page (or metaobject page) in the draft theme with
the object, "Members only" and the Circle link — nothing to add to a cart;
(b) a published showcase product with no purchasable variant (sold out, DENY)
that also appears in collections — needs the nightly guard and is one
misconfiguration away from a bypass.

### 8.5 Rules
One per member per release; the admin warns when a second release opens in
the same calendar year ("one a year"). Price must pass rule 5 (no 25%).
Everything (price, edition, cost, window, dates, text, image) is entered by
Felix; nothing defaults.

---

## 9. Subscription states

```
pending ─checkout.session.completed─▶ active
active ─invoice.payment_failed─▶ past_due ─invoice.paid─▶ active
past_due ─retries exhausted (Stripe cancels)─▶ ended (payment_failed)
active/past_due ─member cancels─▶ canceling ─undo─▶ active
canceling ─customer.subscription.deleted─▶ ended (canceled)
ended ─now ≥ credits_grace_until─▶ ended_expired
ended/ended_expired ─rejoin checkout─▶ active (new subscription, streak from 0)
```
| State | Member price | New credits | Spend credits | Capsules | Members' object | Invite | Anniversary streak |
|---|---|---|---|---|---|---|---|
| active | on | yes | yes | yes (≥ 2 paid months) | yes | yes | counts |
| canceling | on until period end | last period only | yes | yes | Felix decides | no new invitations | counts until end |
| past_due | **off** | no | yes | no | no | no | **broken** |
| ended (grace) | off | no | until grace end | no | no | no | ended |
| ended_expired | off | no | no | no | no | no | — |

Retries: custom schedule, 3 attempts (+3, +4, +3 days), then cancel.

---

## 10. Anniversary gift (G)

- Every membership invoice is stored (`membership_invoices`). The **streak**
  = consecutive paid invoices without a failure, counted back from the latest,
  contiguous periods, same subscription. A payment failure (even if later
  recovered), a cancellation or a rejoin (new subscription) restarts it.
- Anniversary `n` is reached when invoice `12n + 1` of the streak is paid —
  the renewal that starts month 13, 25, … (conservative reading: the member
  has completed 12n paid months *and* keeps going). Insert
  `anniversary_gifts(membership, streak_start, n)` — the unique key makes it
  one gift per anniversary even if events repeat or arrive out of order.
- Then: budget rule 4 → pick from `gift_options(kind='anniversary', active)`
  with landed cost ≤ budget (Felix chooses in the queue, or the single
  eligible option) → member confirms the US address in the portal → free
  draft order (100% line discount, free shipping, tag `circle-anniversary`,
  `acceptAutomaticDiscounts:false`) completed as paid → email.
- Budget 0 or empty pool → `skipped_budget`, visible in the admin, no promise
  to the member.

---

## 11. Invite a friend (H)

### 11.1 Flow
Member's personal link `club./circle/join?invite=<code>` (one code per
member). The friend signs in, sees the reduced joining fee, pays $40 (default:
$20 month + $30 − $10). The referral row moves `pending_checkout → joined →
qualifying` (friend's first invoice paid) → **credited** at the friend's
second paid invoice (the first renewal, ~1 month after joining; matches the
`2·m` term of rule 3).

### 11.2 Checks (Worker, before Checkout)
Referrer active; code valid; friend ≠ referrer (user id and normalised
email); friend has no membership history in D1 and no `legacy_users` Stripe
id; no existing Stripe customer with that email (Search API); otherwise the
friend joins at full price with a quiet line ("This invitation is for new
members."). The discount is a server-side coupon on the joining-fee Product
only (`amount_off`, `duration=once`); promotion codes are never enabled at
Checkout.

### 11.3 Checks after payment
Card fingerprint of the friend's first payment vs every fingerprint stored
for the referrer → match: no credits (`rejected`; friend keeps the discount).
Wallets (Apple/Google Pay) may tokenise the card and non-card methods have no
fingerprint, so "no match" proves nothing: the same shipping address as the
referrer, or a missing fingerprint, goes to **manual review** in the admin.

### 11.4 Limits and clawback
One `credited` referral per referrer per season (UTC calendar quarter of the
friend's join; partial unique index). Over the limit → `not_counted_season`.
Refund or dispute on either of the friend's first two charges → `void` (before
credit) or `reversed` (ledger −reward). Friend's subscription ends before the
second payment → `lapsed`. Rule 3 fails at credit time → `not_counted_economics`.
Amounts (friend discount, member reward) are admin settings; a change creates a
new Stripe coupon id.

---

## 12. Economics — never go below zero

### 12.1 Units and rounding
Integer cents; rates in basis points; ratios in ppm. Revenue rounds down,
costs and fees round up (any rounding error goes against the house). The
customer-facing Circle price is `p − floor(p·25/100)`. All rates are dated,
versioned settings (§4 `economics_settings`); none is hard-coded in formulas.

### 12.2 Fees (verified 16 Oct 2026, US)
- Stripe card 2.9% + 30¢; international +1.5%; currency conversion +1% (only
  if conversion happens); Billing 0.7% (Felix confirms from his invoice); Stripe
  Tax +0.5% when enabled; dispute $15 (+$15 if countered); refunds do not
  return fees; Radar Lite included.
- Shopify Basic: online 2.9% + 30¢, premium cards 3.5% + 30¢, international
  +1%; **2% third-party fee on gift-card payments** (this store); chargeback
  $15; draft orders marked as paid carry no transaction fee.

F1 `SF(x) = ceil(x·(290 [+150 intl])/1e4) + 30 + ceil(x·70/1e4) [+ ceil(x·50/1e4)]`
→ $20: 102¢ → **net $18.98**; $50: 210¢ → **net $47.90**; joining part
`NJ = N(5000) − N(2000) = $28.92` (brief's figures confirmed exactly).
Friend's $40 first invoice: fee 174¢, net $38.26.

### 12.3 Monthly contribution
`m(c) = 18.98 − 0.40 − 26.67·c` per month when all 20 credits are spent on
discounted pieces (1 credit buys 4/3 of retail; the 0.40 is the 2% gift-card
fee on $20); minus shipping `s` per credit order.

| c (cost / price) | brief m / year | with gift-card fee m / year |
|---|---|---|
| 0.30 | 10.98 / 131.8 | 10.58 / 127.0 |
| 0.40 | 8.31 / 99.7 | 7.91 / 94.9 |
| 0.50 | 5.65 / 67.8 | 5.24 / 62.9 |
| 0.60 | 2.98 / 35.8 | 2.58 / 31.0 |
| 0.70 | 0.31 / 3.7 | **−0.09 / −1.1** |
Break-even c: 0.7118 (brief) → **0.6968** with the gift-card fee (0.6855 with
international cards).

### 12.4 Rules (enforced in code, unit-tested)
1. **Cost.** Per variant in D1; NULL = not participating (≠ 0; 0 needs an
   explicit confirmation). No cost → no Circle price, no 25%. Average shipping
   NULL → nothing is eligible.
2. **Member margin per variant.** Eligible ⇔ on Felix's list ∧ not a hard
   exclusion ∧ cost and shipping known ∧
   `CP − cost − s − fee ≥ ceil(0.15·CP)` (min margin setting, default 15% of
   the member price), where `fee` is the **worst case over how the order is
   paid**: all card (Shopify premium rate), all credits (Stripe cost of the
   credits + 2%), or credits plus a few cents by card (adds the fixed 30¢).
   Closed form ≈ `c ≤ 0.584 − (s + 0.31)/p`. Failing variants leave the
   discount automatically; the admin shows the reason and the maximum cost
   that would pass. Examples (s = 0): $40 → max cost $23.06; $68 → $39.41;
   $220 → $128.22; $495 → $288.88.
3. **Invitation.** Credits are awarded only if
   `D + R·(4/3)·c_avg + R·2% ≤ NJ − (W + s) + 2·m(c_avg)` with
   `NJ = $28.92` (the joining part of an undiscounted first invoice, as the
   brief defines it), `D` = friend discount, `R` = reward, `W` = the highest
   landed cost among active welcome options, `c_avg` from §12.5. With the
   defaults (D = $10, R = 10, W = $25, s = 0) the rule holds up to
   **c_avg ≈ 0.46**; each $1 of shipping lowers that by ≈ 0.045. The admin
   refuses to save values that fail and shows the terms, the largest reward
   at the current discount and the largest discount at the current reward.
4. **Anniversary budget** `B = min($15, 20% · 12·m(c_avg))`; B = 0 when m ≤ 0
   or data are missing. With the gift-card fee: $15 at c ≤ 0.4, $12.57 at 0.5,
   $6.19 at 0.6, $0 at 0.7. An option is allowed only if its landed cost ≤ B.
5. **Members' object.** `P − C − s − fee(P) ≥ ceil(0.15·P)` without the 25%
   (≈ `P_min = (C + s + 0.31)/0.779`); the admin shows `P_min` and refuses to
   open a release below it.
6. **Economics screen** shows on current data: m and 12·m (expected and
   worst-case profile), c_avg and the worst item, NJ (full / with invitation),
   invitation cost vs value, anniversary budget, the rule-2 excluded list with
   reasons, and a "needs data from Felix" list.
7. **Never invented:** no default cost, edition, price or date; empty =
   excluded/blocked, with the reason.

### 12.5 c_avg
Cost per credit-dollar actually spent: the maximum of (a) the plain mean over
active purchasable variants, (b) the price-weighted ratio (each variant at the
price credits really pay — Circle price if eligible, full price otherwise) and,
once there are enough credit-funded orders, (c) the sales-weighted ratio.
Requires costs for every active purchasable variant; otherwise invitation
rewards and anniversary gifts are suspended (fail closed). For an
all-discounted catalogue this equals the brief's `1.333·c_ср`.

### 12.6 Tests (minimum)
Each formula at its boundary (pass at exactly the minimum, fail one cent
below); cost missing; shipping missing; c ≥ 0.70 (m ≤ 0 → budget 0,
invitations off); zero shipping; zero price; variants with different
prices/costs; mixed payment worst case; rounding of the Circle price for
p ≡ 0..3 (mod 4); rule 3 with the defaults across c ∈ {0.3…0.7}; admin save
blocking with the explanation payload.

---

## 13. Stripe setup (test mode)

- Product A "The Renaissance Circle — Membership": price `circle_monthly_usd`
  $20/month, `tax_behavior=exclusive`. Δ Product B "Joining fee — includes your
  welcome piece": price `circle_joining_usd` $30 one-time. Prices resolved by
  `lookup_key`.
- Referral coupon `amount_off` = setting, `duration=once`,
  `applies_to.products=[B]`; fallback if that misbehaves in test: a second
  one-time joining price.
- Checkout params as spec §9.1.2 + referral variant; no
  `payment_method_types` (dynamic methods); terms URL must be set in the
  Dashboard for `consent_collection`.
- Dashboard: custom retry schedule (3, then cancel); Billing Automations off;
  Customer Portal (card + invoices only); Stripe emails off (we send ours);
  event destination per environment (snapshot, pinned version); do **not**
  change the account default API version (legacy handler). Test data:
  test-mode subscriptions are deleted after 90 days and test-clock ones after
  30 — long scenarios run on test clocks.

---

## 14. Legacy retirement (no code deleted)

| Step | When | What |
|---|---|---|
| R0 | with the V1 production deploy ("yes") | `/api/curator/*` (Gemini) → 410 in `app.js`. |
| R1 | before the V2 Stripe endpoint exists anywhere live | legacy POST catch-all gated by `LEGACY_STRIPE_WEBHOOK` (off); Felix disables the legacy endpoint in Stripe. Staging is safe already (no legacy secret → 503). |
| R2 | V2 launch | legacy `/api/user/*`, `/api/auth/request-link` → owned by `src/` with the session cookie (spec §8.1 keeps billing-portal and invoices, pause hidden and closed for VIP); `club.` switches to the V1/V2 portal. Tables `legacy_users`, `chat_*`, `processed_events` stay (empty in production). |

---

## 15. Platform

- Workers **Free** plan limits: 10 ms CPU per request and cron run, 50
  subrequests per invocation, 5 cron triggers per account. V2 adds reconciles
  (Stripe, Shopify discount), reminders, expiry, anniversary and claim expiry.
  Plan: one `*/5` trigger + the existing daily one, dispatching by time in
  code; batch work across runs. **Workers Paid** would remove the CPU and
  subrequest pressure — Felix's decision.
- Staging: Stripe test keys + `STRIPE_CIRCLE_WEBHOOK_SECRET` + test-mode
  endpoint on `api-staging`; Shopify off on staging (as V1) except against a
  **Shopify development store** if Felix creates one (recommended for B, C, G
  end-to-end tests).

---

## 16. English copy (drafts for review)

Benefits page `/circle` (Club):
- Eyebrow: The Renaissance Circle
- Title: A sealed object, chosen by you.
- Lede: Members choose their first piece from a small sealed selection —
  revealed only after joining.
- Value: $20 a month becomes 20 credits to spend on anything in the house,
  plus 25% off eligible pieces.
- How it works: Join for $50 · Choose your sealed piece · $20 a month becomes
  20 credits
- What members have:
  - Credits — 20 each month, to spend as you like.
  - Circle price — 25% off eligible pieces, applied at checkout with your
    Circle email.
  - Your sealed piece — chosen from a small selection after you join.
  - Seasonal capsules — reserved for members; skip any season.
  - The concierge — write to us, and a person answers.
  - Your rooms — share photos of your rooms so we can suggest pieces.
  - Early access — 48 hours before anyone else, and first right to numbered
    editions. (Shown only once §1.4 is decided and built.)
  - The members' object — once a year, a piece offered only to members.
  - An anniversary gift — each year of membership.
  - Invite a friend — once a season.
  - Refills — coming.
- Terms line: $50 to join, which includes your first month. Then $20 a month
  until you cancel. Cancel online at any time.

Storefront: "Circle price $X" · "About the Circle". Members' object page:
"Members only" · "Available to members of the Renaissance Circle." · "About
the Circle".

Members' object (portal): "Reserve mine" · "Reserved for you until {date}." ·
"Pay now" · "Yours. Thank you." · "This release has closed." · "All pieces in
this edition have found homes." · "One per member."

Invite: "Invite a friend" · "Share your link. Your friend's joining fee is
${D} lower, and you receive {R} credits once they have paid their second
month. One invitation counts each season." · "Copy link" · "This invitation
is for new members."

Anniversary: "A year in the Circle" · "To mark your anniversary, we'd like to
send you something. Please confirm where it should go." · "Send my gift".

Emails (subjects): `circle_open` The Circle is open · `welcome` Welcome to the
Circle · `welcome_back` Welcome back to the Circle · `credits_added` 20
credits added · `renewal_reminder` Your membership renews on {date} ·
`payment_failed` We couldn't process your payment · `membership_canceled`
Your membership will end on {date} · `membership_ended_payment` Your
membership has ended · `credits_expiring` Your {N} credits expire on {date} ·
`redemption_code` Your credits are ready to use · `object_invoice` Your
members' object is reserved · `anniversary` A year in the Circle ·
`referral_credited` {R} credits from your invitation · `concierge_reply` You
have a reply from the Maison.

All of this is a draft for Felix; legal-sensitive lines (terms, renewal,
credits after cancellation) stay "pending legal review" (P0.7).

---

## 17. Tasks (V2)

Order: T0 → T1 → T2 → T3 → T5 → (T4, T6) → the rest; T15–T17 after T5 and T2.
Each task: TDD, staging, report in Russian, skills listed.

| Task | Content | Acceptance |
|---|---|---|
| **T0** Foundations | Stripe client/signature/catalog (`src/stripe/*`), `STRIPE_API_VERSION` pin, migration 0006, cron dispatcher, R0/R1 gates, staging Stripe test env | migrations apply clean and on the V1 shape; legacy tests green; legacy catch-all off by default (test); signature tests (good/bad/old timestamp) |
| **T1** Join | `/circle/join`, consents with text hash, Terms draft (pending legal review), Product B, Checkout (+referral variant) | as spec T1 + first invoice $50 (or $40 with invitation: discount only on the joining line, monthly line 2000 → 20 credits) |
| **T2** Stripe webhooks & state | event matrix §6.1, `membership_invoices`, `stripe_payments`, daily Stripe reconcile | test clocks: join → renew → fail → recover → cancel → end; out-of-order and duplicate events change nothing; wrong signature 400; livemode mismatch ignored |
| **T3** Ledger & Credits screen | spec T3 | spec T3 (tax never changes credits; ledger sum = balance) |
| **T4** Spend credits | spec T4 | spec T4 + 2% gift-card fee visible in Economics |
| **T5** Economics engine & admin | `src/circle/economics.js` (pure), settings, costs, Economics screen, save blocking | every §12.6 case; admin refuses failing invitation/anniversary/object values with the computed explanation |
| **T6** Member price (C) | spike on a dev store or with Felix's yes on live (test customers), then discount sync, reconcile, audit, `sr-circle-price` in the draft theme | member gets 25% on an eligible variant at checkout with the Circle email; non-member does not; Small Pleasures/gift card/object never; ended or past_due member loses it ≤ 5 min (incl. injected failure); storefront line = checkout price for every variant |
| **T7** Welcome piece | spec T6 + `kind='welcome'` | spec T6 |
| **T8** Emails & cron | spec T7 + new templates | spec T7 |
| **T9** Failed payments | spec T8 + custom retry schedule | spec T8; member price off during past_due, back on recovery |
| **T10** Skip | spec T9 | spec T9 |
| **T11** Cancel, grace, rejoin | spec T10 | spec T10 |
| **T12** Refunds, disputes, delete | spec T11 + §4 delete additions (cancel Stripe first, fail closed; claims/gifts/referrals closed) | spec T11; delete with active membership cancels in Stripe before any local change |
| **T13** Capsules | spec T12 | spec T12 |
| **T14** Concierge & rooms | spec T13 (people only) | spec T13 |
| **T15** Members' object (B) | §8 | §8.3 automated tests; bypass probes pass (after "yes"); one per member per release; edition never exceeded under concurrency; the 25% never applies |
| **T16** Anniversary (G) | §10 | test clock 12 and 24 months → one gift each; a failure in month 7 restarts the count; rejoin starts from zero; repeated events → one gift; budget 0 → no gift, admin shows why |
| **T17** Invite a friend (H) | §11 | credit only after the friend's 2nd paid invoice; self-invite (email, same card) refused; second credited invitation in a season → not counted; refund/dispute on friend's 1st/2nd charge → reversed; rule 3 failure → not counted |
| **T18** Admin v2 & dashboard | spec T15 + §3.3 screens | spec T15 |
| **T19** Benefits copy & storefront | §16 copy in the portal and the draft theme; Members' object page | only working benefits shown; Refills "coming"; no object names; no testimonials |
| **T21** Early access (if approved) | §1.4 — release window, member purchase via draft order, publish at window end (Felix) | non-members cannot buy during the window (same bypass tests as T15); members get their price; window end is Felix's action |
| **T20** Launch gate | spec T16 + B/C/G/H checks | spec T16; legacy R1/R2 done; Felix's test purchase → refund → reversal correct |

---

## 18. Data needed from Felix (nothing is invented)

1. **Cost per variant** for every product that should carry the Circle price
   (landed: goods + inbound freight + duties + packaging), and which products
   are on the Circle price list.
2. **Average outbound shipping** per order (US, duties included) — one figure,
   or per type (credit orders, welcome piece, anniversary gift, object).
3. **Welcome pieces:** the closed set (≥ 2 active), each with a Shopify
   variant and landed cost ≤ $25.
4. **Anniversary pool:** options with landed costs (the budget rule decides
   which are allowed).
5. **Members' object** per release: product, price, edition size, cost,
   reservation window (hours), open/close dates, public text and image.
6. **Invitation** discount and reward if not the defaults ($10 / 10 credits).
7. Confirmation of the Stripe fees on his account (Billing 0.7%, no paid Radar).

## 19. Decisions for Felix

1. Member price: approve the automatic discount for specific customers and the
   live spike (test customers with his plus-addressed emails, or a Shopify dev
   store).
2. Accept the impersonation risk (someone types a member's email at checkout),
   margin-safe under rule 2 and flagged by the audit?
3. Members' object page: a Page without a buy button (recommended) or a
   sold-out showcase product?
4. Can a member claim again after an expired/cancelled claim in the same
   release? May `canceling` members claim?
5. Anniversary: count from the renewal that starts month 13 (recommended); does
   a recovered past_due break the streak (strict: yes)?
6. Invitation: "second payment" = first invoice + first renewal (recommended);
   season = UTC calendar quarter of the friend's join; fingerprint match →
   auto-deny or manual review?
7. Accept the 2% gift-card fee on credits (built into the economics), or look
   later at delivering credits as draft-order adjustments?
8. Workers Paid plan (for crons and reconciles) — yes/no.
9. Customer tag: keep `vip-circle` / `vip-circle-past` (spec) — the brief's
   `circle-vip` was an example; the price no longer depends on the tag.
10. Guard profile for rule 2: worst case (premium + international cards) —
    recommended.
11. Early access 48 h: approve the draft-order window (§1.4), or keep it off
    the benefits list for now.
