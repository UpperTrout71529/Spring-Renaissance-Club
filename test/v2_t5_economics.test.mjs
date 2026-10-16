// V2 T5: the economics engine (docs/tz-v2-circle.md §12). Pure functions;
// every rule at its boundary (passes at exactly the limit, fails one cent
// past it), missing data fails closed, and the brief's figures are reproduced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS, stripeFee, stripeNet, joiningNet, circlePriceCents, orderFee, checkVariant,
  monthlyContribution, costPerCreditPpm, referralCheck, anniversaryBudget, objectCheck, minObjectPrice,
  withSettings,
} from '../src/circle/economics.js';

const S = withSettings({});                      // defaults: guard profile 'worst'
const KNOWN = (cents) => ({ S: { cents, estimate: false }, M: { cents, estimate: false }, L: { cents, estimate: false } });
const SET0 = withSettings({ shipping: KNOWN(0) }); // exact zero shipping
const kOf = (c) => Math.round(c * 4 / 3 * 1e6);   // brief's c (cost/retail) → cost per credit-dollar, all discounted

// ---- fees ------------------------------------------------------------------

test('T5-F1: Stripe fees and nets match the brief ($20 → 18.98, $50 → 47.90, joining part 28.92)', () => {
  assert.equal(stripeFee(2000, S, 'expected'), 102);
  assert.equal(stripeNet(2000, S, 'expected'), 1898);
  assert.equal(stripeFee(5000, S, 'expected'), 210);
  assert.equal(stripeNet(5000, S, 'expected'), 4790);
  assert.equal(joiningNet(S, 'expected'), 2892);
  assert.equal(stripeFee(4000, S, 'expected'), 174, "friend's $40 first invoice");
  // International cards cost 1.5% more.
  assert.equal(stripeFee(2000, S, 'worst'), 132);
  // Stripe Tax, when switched on, adds 0.5%.
  assert.equal(stripeFee(2000, withSettings({ stripe_tax_bps: 50 }), 'expected'), 112);
});

test('T5-F2: the Circle price is p − floor(p/4) = ceil(0.75 p) for every p (never below checkout)', () => {
  assert.equal(circlePriceCents(4000), 3000);
  assert.equal(circlePriceCents(4001), 3001);
  assert.equal(circlePriceCents(4002), 3002);
  assert.equal(circlePriceCents(4003), 3003);
  for (let p = 0; p <= 5000; p++) assert.equal(circlePriceCents(p), Math.ceil(p * 3 / 4), `p=${p}`);
});

test('T5-F3: order fee is the worst of all-card, all-credits and credits plus a few cents by card', () => {
  // CP $30: card (premium + intl) 4.5% + 30 = 165; credits 5.1% + 2% = 153 + 60 = 213; mixed = 213 + 31 = 244.
  assert.equal(orderFee(3000, S, 'worst'), 244);
  // Expected profile: credits 3.6% + 2% = 108 + 60 = 168; mixed 199; card 2.9% + 30 = 117.
  assert.equal(orderFee(3000, S, 'expected'), 199);
});

// ---- rule 2: member margin per variant ------------------------------------------------

test('T5-R2a: the brief examples (s = 0, worst case, 15%): max cost $23.06 / $39.41 / $128.22 / $288.88', () => {
  for (const [price, max] of [[4000, 2306], [6800, 3941], [22000, 12822], [49500, 28888]]) {
    const at = checkVariant({ priceCents: price, costCents: max, shippingClass: 'S', onList: true }, SET0);
    assert.equal(at.eligible, true, `price ${price} at max cost`);
    assert.equal(at.max_cost_cents, max);
    assert.equal(at.circle_price_cents, circlePriceCents(price));
    const over = checkVariant({ priceCents: price, costCents: max + 1, shippingClass: 'S', onList: true }, SET0);
    assert.equal(over.eligible, false, `price ${price} one cent over`);
    assert.equal(over.reason, 'margin_below_min');
    assert.equal(over.max_cost_cents, max);
  }
});

test('T5-R2b: no cost → not participating (not zero); no shipping → nothing eligible', () => {
  const noCost = checkVariant({ priceCents: 4000, costCents: null, shippingClass: 'S', onList: true }, SET0);
  assert.deepEqual([noCost.eligible, noCost.reason, noCost.circle_price_cents], [false, 'no_cost', null]);
  const noShip = checkVariant({ priceCents: 4000, costCents: 1000, shippingClass: 'S', onList: true }, S);
  assert.deepEqual([noShip.eligible, noShip.reason], [false, 'no_shipping']);
  const noClass = checkVariant({ priceCents: 4000, costCents: 1000, shippingClass: null, onList: true }, SET0);
  assert.deepEqual([noClass.eligible, noClass.reason], [false, 'no_shipping']);
});

test('T5-R2c: not on the list, hard exclusions and a zero price are never eligible', () => {
  const base = { priceCents: 4000, costCents: 100, shippingClass: 'S' };
  assert.equal(checkVariant({ ...base, onList: false }, SET0).reason, 'not_on_list');
  for (const ex of ['gift_card', 'catalog', 'capsule', 'members_object', 'membership']) {
    const r = checkVariant({ ...base, onList: true, exclusion: ex }, SET0);
    assert.deepEqual([r.eligible, r.reason], [false, `excluded_${ex}`]);
  }
  assert.equal(checkVariant({ ...base, priceCents: 0, onList: true }, SET0).reason, 'zero_price');
});

test('T5-R2d: shipping lowers the max cost cent for cent; an estimate needs 25% instead of 15%', () => {
  const exact = withSettings({ shipping: KNOWN(500) });
  assert.equal(checkVariant({ priceCents: 4000, costCents: 0, shippingClass: 'M', onList: true }, exact).max_cost_cents, 2306 - 500);
  const est = withSettings({ shipping: { S: { cents: 500, estimate: true }, M: { cents: 500, estimate: true }, L: { cents: 500, estimate: true } } });
  const r = checkVariant({ priceCents: 4000, costCents: 0, shippingClass: 'M', onList: true }, est);
  // required margin ceil(0.25 × 3000) = 750 instead of 450 → 300 less room.
  assert.equal(r.max_cost_cents, 2306 - 500 - 300);
  assert.equal(r.shipping_estimate, true);
  assert.equal(r.required_margin_cents, 750);
});

test('T5-R2e: zero shipping must be exact, an estimated zero still uses the 25% margin', () => {
  const r = checkVariant({ priceCents: 4000, costCents: 0, shippingClass: 'L', onList: true },
    withSettings({ shipping: { S: { cents: 0, estimate: true }, M: { cents: null, estimate: true }, L: { cents: 0, estimate: true } } }));
  assert.equal(r.required_margin_cents, 750);
});

// ---- monthly contribution ---------------------------------------------------------------

test('T5-M1: m(c) with the 2% gift-card fee reproduces the §12.3 table (expected profile)', () => {
  const rows = [[0.3, 1058], [0.4, 791], [0.5, 524], [0.6, 258], [0.7, -9]];
  for (const [c, m] of rows) assert.equal(monthlyContribution(kOf(c), S, 'expected'), m, `c=${c}`);
});

test('T5-M2: cost per credit-dollar: max of the plain mean and the price-weighted ratio; any missing cost → null', () => {
  assert.equal(costPerCreditPpm([]), null);
  assert.equal(costPerCreditPpm([{ price_cents: 1000, cost_cents: 400 }, { price_cents: 3000, cost_cents: null }]), null);
  // mean(0.4, 0.2) = 0.3; weighted (400 + 600) / 4000 = 0.25 → 0.3
  assert.equal(costPerCreditPpm([{ price_cents: 1000, cost_cents: 400 }, { price_cents: 3000, cost_cents: 600 }]), 300000);
  // mean(0.1, 0.5) = 0.3; weighted (100 + 1500) / 4000 = 0.4 → 0.4
  assert.equal(costPerCreditPpm([{ price_cents: 1000, cost_cents: 100 }, { price_cents: 3000, cost_cents: 1500 }]), 400000);
  // a sales-weighted figure wins when it is higher
  assert.equal(costPerCreditPpm([{ price_cents: 1000, cost_cents: 100 }], { salesWeightedPpm: 450000 }), 450000);
  // rounds up (against the house)
  assert.equal(costPerCreditPpm([{ price_cents: 3, cost_cents: 1 }]), 333334);
});

// ---- rule 3: invitation ---------------------------------------------------------------

const DEFAULT_REF = { D: 1000, R: 1000, W: 2500, s: 0 };

test('T5-I1: defaults hold at c = 0.3 and 0.4 and fail at 0.5, 0.6, 0.7 (both profiles)', () => {
  for (const profile of ['expected', 'worst']) {
    const set = withSettings({ guard_profile: profile });
    for (const [c, ok] of [[0.3, true], [0.4, true], [0.5, false], [0.6, false], [0.7, false]]) {
      assert.equal(referralCheck({ ...DEFAULT_REF, kPpm: kOf(c) }, set).ok, ok, `${profile} c=${c}`);
    }
  }
});

test('T5-I2: the expected-profile threshold is c ≈ 0.46 (the brief), the worst-case one ≈ 0.45', () => {
  const exp = withSettings({ guard_profile: 'expected' });
  assert.equal(referralCheck({ ...DEFAULT_REF, kPpm: kOf(0.463) }, exp).ok, true);
  assert.equal(referralCheck({ ...DEFAULT_REF, kPpm: kOf(0.464) }, exp).ok, false);
  assert.equal(referralCheck({ ...DEFAULT_REF, kPpm: kOf(0.447) }, S).ok, true);
  assert.equal(referralCheck({ ...DEFAULT_REF, kPpm: kOf(0.448) }, S).ok, false);
});

test('T5-I3: the explanation carries the terms, the largest reward and the largest discount that pass', () => {
  const r = referralCheck({ ...DEFAULT_REF, kPpm: kOf(0.5) }, S);
  assert.equal(r.ok, false);
  for (const k of ['lhs_cents', 'rhs_cents', 'joining_net_cents', 'monthly_contribution_cents', 'reward_cost_cents', 'giftcard_fee_cents']) {
    assert.equal(typeof r.terms[k], 'number', k);
  }
  assert.ok(r.terms.lhs_cents > r.terms.rhs_cents);
  // the suggested maxima pass and one step more fails
  const R = r.max_reward_cents;
  const D = r.max_discount_cents;
  if (R !== null) {
    assert.equal(referralCheck({ ...DEFAULT_REF, R, kPpm: kOf(0.5) }, S).ok, true);
    assert.equal(referralCheck({ ...DEFAULT_REF, R: R + 100, kPpm: kOf(0.5) }, S).ok, false);
  }
  if (D !== null) {
    assert.equal(referralCheck({ ...DEFAULT_REF, D, kPpm: kOf(0.5) }, S).ok, true);
    assert.equal(referralCheck({ ...DEFAULT_REF, D: D + 1, kPpm: kOf(0.5) }, S).ok, false);
  }
});

test('T5-I4: missing cost data or welcome data fails closed', () => {
  assert.equal(referralCheck({ ...DEFAULT_REF, kPpm: null }, S).ok, false);
  assert.equal(referralCheck({ ...DEFAULT_REF, kPpm: null }, S).reason, 'needs_cost_data');
  assert.equal(referralCheck({ ...DEFAULT_REF, W: null, kPpm: kOf(0.3) }, S).reason, 'needs_welcome_data');
  assert.equal(referralCheck({ ...DEFAULT_REF, s: null, kPpm: kOf(0.3) }, S).reason, 'needs_shipping_data');
});

// ---- rule 4: anniversary budget -------------------------------------------------------------

test('T5-A1: budget = min($15, 20% × 12·m): $15 at c ≤ 0.4, $12.57 at 0.5, $6.19 at 0.6, $0 at 0.7 (expected)', () => {
  const exp = withSettings({ guard_profile: 'expected' });
  for (const [c, b] of [[0.3, 1500], [0.4, 1500], [0.5, 1257], [0.6, 619], [0.7, 0]]) {
    assert.equal(anniversaryBudget(kOf(c), exp), b, `c=${c}`);
  }
  assert.equal(anniversaryBudget(null, exp), 0, 'no data → 0');
  // the worst profile is never more generous
  for (const c of [0.3, 0.5, 0.6]) assert.ok(anniversaryBudget(kOf(c), S) <= anniversaryBudget(kOf(c), exp));
});

// ---- rule 5: members' object ---------------------------------------------------------------

test('T5-O1: the object price must keep the minimum margin without the 25%; P_min passes, P_min − 1 fails', () => {
  for (const [C, s] of [[5000, 0], [5000, 800], [12000, 1500], [0, 0]]) {
    const set = withSettings({ shipping: KNOWN(s) });
    const pmin = minObjectPrice({ costCents: C, shippingClass: 'M' }, set);
    assert.equal(objectCheck({ priceCents: pmin, costCents: C, shippingClass: 'M' }, set).ok, true, `C=${C} s=${s}`);
    assert.equal(objectCheck({ priceCents: pmin - 1, costCents: C, shippingClass: 'M' }, set).ok, false, `C=${C} s=${s}`);
    // ≈ (C + s + 0.31) / 0.779 (worst case, 15%) — within a few cents
    assert.ok(Math.abs(pmin - (C + s + 31) / 0.779) < 5, `C=${C} s=${s} pmin=${pmin}`);
  }
});

test('T5-O2: the object check fails closed without price, cost or shipping', () => {
  assert.equal(objectCheck({ priceCents: null, costCents: 100, shippingClass: 'M' }, SET0).reason, 'needs_price');
  assert.equal(objectCheck({ priceCents: 9000, costCents: null, shippingClass: 'M' }, SET0).reason, 'needs_cost');
  assert.equal(objectCheck({ priceCents: 9000, costCents: 100, shippingClass: 'M' }, S).reason, 'needs_shipping');
  assert.equal(minObjectPrice({ costCents: null, shippingClass: 'M' }, SET0), null);
});

test('T5-D1: defaults are the documented ones; withSettings never mutates them', () => {
  assert.equal(DEFAULTS.min_margin_bps, 1500);
  assert.equal(DEFAULTS.estimate_min_margin_bps, 2500);
  assert.equal(DEFAULTS.guard_profile, 'worst');
  assert.equal(DEFAULTS.referral_discount_cents, 1000);
  assert.equal(DEFAULTS.referral_reward_cents, 1000);
  assert.equal(DEFAULTS.anniversary_cap_cents, 1500);
  assert.equal(DEFAULTS.anniversary_share_bps, 2000);
  assert.equal(DEFAULTS.giftcard_fee_bps, 200);
  assert.deepEqual(DEFAULTS.shipping.S, { cents: null, estimate: true });
  withSettings({ min_margin_bps: 1, shipping: KNOWN(1) });
  assert.equal(DEFAULTS.min_margin_bps, 1500);
  assert.deepEqual(DEFAULTS.shipping.S, { cents: null, estimate: true });
});
