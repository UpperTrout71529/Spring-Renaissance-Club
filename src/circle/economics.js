// The Circle economics engine (docs/tz-v2-circle.md §12) — "never below
// zero". Pure functions, no I/O: the admin, the member-price sync, the
// invitation credit, the anniversary gift and the members' object all call
// these with settings loaded from D1 (src/circle/economics-store.js).
//
// Units: integer cents; rates in basis points (bps, 1/10 000); ratios in
// parts per million (ppm). Revenue rounds down, costs and fees round up, so
// any rounding error goes against the house. Nothing is hard-coded in the
// formulas: every rate is a setting with a documented default.
//
// Profiles: "expected" = a US standard card; "worst" = premium and
// international cards (Felix, §19 #10: rule 2 uses the worst case). Every
// rule uses settings.guard_profile unless a profile is passed.

const BPS = 10000;
const PPM = 1000000;
export const MEMBER_DISCOUNT_BPS = 2500;   // the Circle price: 25% off
export const SHIPPING_CLASSES = ["S", "M", "L"];

export const DEFAULTS = Object.freeze({
  monthly_cents: 2000,
  joining_cents: 3000,
  min_margin_bps: 1500,              // rule 2/5: 15% of the price the member pays
  estimate_min_margin_bps: 2500,     // Felix §18: 25% while shipping is an estimate
  // Felix's outbound shipping per class (US, duties included). null = not
  // entered; estimate = true until he confirms exact figures.
  shipping: Object.freeze({
    S: Object.freeze({ cents: null, estimate: true }),
    M: Object.freeze({ cents: null, estimate: true }),
    L: Object.freeze({ cents: null, estimate: true }),
  }),
  stripe_card_bps: 290, stripe_intl_bps: 150, stripe_fixed_cents: 30, stripe_billing_bps: 70, stripe_tax_bps: 0,
  shopify_card_bps: 290, shopify_premium_bps: 350, shopify_intl_bps: 100, shopify_fixed_cents: 30,
  giftcard_fee_bps: 200,             // Shopify's third-party fee on gift-card payments (this store)
  guard_profile: "worst",
  referral_discount_cents: 1000,     // friend: $10 off the joining fee
  referral_reward_cents: 1000,       // member: 10 credits
  anniversary_cap_cents: 1500,
  anniversary_share_bps: 2000,       // 20% of a year's contribution
  welcome_cap_cents: 2500,           // landed cost of a welcome piece
});

export function withSettings(overrides = {}) {
  const shipping = {};
  for (const c of SHIPPING_CLASSES) {
    shipping[c] = { ...DEFAULTS.shipping[c], ...((overrides.shipping || {})[c] || {}) };
  }
  return { ...DEFAULTS, ...overrides, shipping };
}

const ceilDiv = (num, den) => Math.ceil(num / den);
const pct = (x, bps) => ceilDiv(x * bps, BPS);
const profileOf = (s, profile) => profile || s.guard_profile || "worst";

// ---- fees ------------------------------------------------------------------

// F1: Stripe card + Billing (+ international, + Stripe Tax when enabled).
export function stripeFee(x, s, profile) {
  const worst = profileOf(s, profile) === "worst";
  return pct(x, s.stripe_card_bps + (worst ? s.stripe_intl_bps : 0)) + s.stripe_fixed_cents
    + pct(x, s.stripe_billing_bps) + (s.stripe_tax_bps > 0 ? pct(x, s.stripe_tax_bps) : 0);
}

export const stripeNet = (x, s, profile) => x - stripeFee(x, s, profile);

// NJ: what the joining fee leaves after fees (first invoice minus a month).
export function joiningNet(s, profile) {
  return stripeNet(s.monthly_cents + s.joining_cents, s, profile) - stripeNet(s.monthly_cents, s, profile);
}

// The price a member pays: exactly what Shopify charges for a 25% line discount.
export function circlePriceCents(p) {
  return p - Math.floor((p * MEMBER_DISCOUNT_BPS) / BPS);
}

// Paying x with credits: the Stripe cost of the subscription dollars behind
// them (percentage part) plus Shopify's gift-card fee.
function creditsFee(x, s, profile) {
  const worst = profileOf(s, profile) === "worst";
  return pct(x, s.stripe_card_bps + (worst ? s.stripe_intl_bps : 0) + s.stripe_billing_bps + s.stripe_tax_bps)
    + pct(x, s.giftcard_fee_bps);
}

function cardFee(x, s, profile) {
  const worst = profileOf(s, profile) === "worst";
  return pct(x, worst ? s.shopify_premium_bps + s.shopify_intl_bps : s.shopify_card_bps) + s.shopify_fixed_cents;
}

// The worst way an order of x can be paid: all card, all credits, or credits
// plus a few cents by card (which adds the card's fixed fee and a cent).
export function orderFee(x, s, profile) {
  return Math.max(cardFee(x, s, profile), creditsFee(x, s, profile) + s.shopify_fixed_cents + 1);
}

export function shippingFor(cls, s) {
  const row = cls && s.shipping && s.shipping[cls];
  if (!row || !Number.isInteger(row.cents) || row.cents < 0) return null;
  return { cents: row.cents, estimate: row.estimate !== false };
}

const marginBps = (ship, s) => (ship.estimate ? s.estimate_min_margin_bps : s.min_margin_bps);

// ---- rule 2: member margin per variant -------------------------------------

// input: { priceCents, costCents (null = not entered), shippingClass, onList,
// exclusion: 'gift_card'|'catalog'|'capsule'|'members_object'|'membership'|null }
export function checkVariant(input, s, profile) {
  const { priceCents: p, costCents: cost, shippingClass, onList, exclusion } = input;
  const out = {
    eligible: false, reason: null, circle_price_cents: null, max_cost_cents: null,
    required_margin_cents: null, margin_cents: null, fee_cents: null, shipping_cents: null, shipping_estimate: null,
  };
  if (exclusion) return { ...out, reason: `excluded_${exclusion}` };
  if (!onList) return { ...out, reason: "not_on_list" };
  if (!Number.isInteger(p) || p <= 0) return { ...out, reason: "zero_price" };

  const cp = circlePriceCents(p);
  const ship = shippingFor(shippingClass, s);
  if (ship) {
    const fee = orderFee(cp, s, profile);
    const required = pct(cp, marginBps(ship, s));
    Object.assign(out, {
      fee_cents: fee, required_margin_cents: required, shipping_cents: ship.cents, shipping_estimate: ship.estimate,
      max_cost_cents: cp - ship.cents - fee - required,
    });
  }
  if (!Number.isInteger(cost) || cost < 0) return { ...out, reason: "no_cost" };
  if (!ship) return { ...out, reason: "no_shipping" };

  const margin = cp - cost - out.shipping_cents - out.fee_cents;
  out.margin_cents = margin;
  if (margin < out.required_margin_cents) return { ...out, reason: "margin_below_min" };
  return { ...out, eligible: true, circle_price_cents: cp };
}

// ---- monthly contribution and cost per credit-dollar ---------------------------

// m: what one member's month leaves when all 20 credits are spent, before
// shipping. kPpm = cost of goods per credit-dollar (brief: 1.333·c for an
// all-discounted catalogue). null without data.
export function monthlyContribution(kPpm, s, profile) {
  if (!Number.isInteger(kPpm)) return null;
  const mc = s.monthly_cents;
  return stripeNet(mc, s, profile) - pct(mc, s.giftcard_fee_bps) - ceilDiv(mc * kPpm, PPM);
}

// §12.5: the higher of the plain mean and the price-weighted ratio of cost to
// the price credits really pay (Circle price if eligible, full otherwise), and
// a sales-weighted ratio once there are enough credit-funded orders. Any
// variant without a cost → null (fail closed).
export function costPerCreditPpm(variants, { salesWeightedPpm = null } = {}) {
  const rows = (variants || []).filter((v) => Number.isInteger(v.price_cents) && v.price_cents > 0);
  if (rows.length === 0) return null;
  if (rows.some((v) => !Number.isInteger(v.cost_cents) || v.cost_cents < 0)) return null;
  const mean = rows.reduce((a, v) => a + v.cost_cents / v.price_cents, 0) / rows.length;
  const sumCost = rows.reduce((a, v) => a + v.cost_cents, 0);
  const sumPrice = rows.reduce((a, v) => a + v.price_cents, 0);
  const weighted = sumCost / sumPrice;
  // ceil with a tolerance for float noise, so an exact 0.3 stays 300000.
  let ppm = Math.ceil(Math.max(mean, weighted) * PPM - 1e-6);
  if (Number.isInteger(salesWeightedPpm)) ppm = Math.max(ppm, salesWeightedPpm);
  return ppm;
}

// ---- rule 3: invitation -------------------------------------------------------

// D + R·k + R·2% ≤ NJ − (W + s) + 2·m(k)
// D friend discount, R reward (cents of credits), W highest landed cost of an
// active welcome piece, ship its shipping.
export function referralCheck({ D, R, W, s: ship, kPpm }, set, profile) {
  if (!Number.isInteger(kPpm)) return { ok: false, reason: "needs_cost_data" };
  if (!Number.isInteger(W)) return { ok: false, reason: "needs_welcome_data" };
  if (!Number.isInteger(ship)) return { ok: false, reason: "needs_shipping_data" };
  const m = monthlyContribution(kPpm, set, profile);
  const nj = joiningNet(set, profile);
  const rhs = nj - (W + ship) + 2 * m;
  const termsFor = (d, r) => {
    const rewardCost = ceilDiv(r * kPpm, PPM);
    const gc = pct(r, set.giftcard_fee_bps);
    return { lhs: d + rewardCost + gc, rewardCost, gc };
  };
  const t = termsFor(D, R);
  const ok = t.lhs <= rhs;

  let maxReward = null;
  for (let r = 0; r <= 100000; r += 100) {
    if (termsFor(D, r).lhs <= rhs) maxReward = r; else break;
  }
  const dMax = Math.min(rhs - t.rewardCost - t.gc, set.joining_cents);
  return {
    ok,
    reason: ok ? null : "invitation_costs_more_than_it_brings",
    terms: {
      lhs_cents: t.lhs, rhs_cents: rhs, discount_cents: D, reward_cents: R,
      reward_cost_cents: t.rewardCost, giftcard_fee_cents: t.gc,
      joining_net_cents: nj, welcome_cost_cents: W, shipping_cents: ship,
      monthly_contribution_cents: m, cost_per_credit_ppm: kPpm,
    },
    max_reward_cents: maxReward,
    max_discount_cents: dMax >= 0 ? dMax : null,
  };
}

// ---- rule 4: anniversary budget ----------------------------------------------

export function anniversaryBudget(kPpm, s, profile) {
  const m = monthlyContribution(kPpm, s, profile);
  if (m === null || m <= 0) return 0;
  return Math.min(s.anniversary_cap_cents, Math.floor((12 * m * s.anniversary_share_bps) / BPS));
}

// ---- rule 5: members' object ----------------------------------------------------

// P − C − s − fee(P) ≥ min margin, without the 25%.
export function objectCheck({ priceCents: P, costCents: C, shippingClass }, s, profile) {
  if (!Number.isInteger(P) || P <= 0) return { ok: false, reason: "needs_price" };
  if (!Number.isInteger(C) || C < 0) return { ok: false, reason: "needs_cost" };
  const ship = shippingFor(shippingClass, s);
  if (!ship) return { ok: false, reason: "needs_shipping" };
  const fee = orderFee(P, s, profile);
  const required = pct(P, marginBps(ship, s));
  const margin = P - C - ship.cents - fee;
  return {
    ok: margin >= required,
    reason: margin >= required ? null : "margin_below_min",
    margin_cents: margin, required_margin_cents: required, fee_cents: fee,
    shipping_cents: ship.cents, shipping_estimate: ship.estimate,
  };
}

// The lowest price that passes rule 5 (and the cent below it does not).
export function minObjectPrice({ costCents, shippingClass }, s, profile) {
  if (!Number.isInteger(costCents) || costCents < 0 || !shippingFor(shippingClass, s)) return null;
  const passes = (P) => objectCheck({ priceCents: P, costCents, shippingClass }, s, profile).ok;
  let lo = 1;
  let hi = 1;
  while (!passes(hi)) {
    hi *= 2;
    if (hi > 1e9) return null;
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (passes(mid)) hi = mid; else lo = mid + 1;
  }
  while (lo > 1 && passes(lo - 1)) lo -= 1;
  return lo;
}
