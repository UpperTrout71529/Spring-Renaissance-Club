// V2 T1: joining the Circle (spec v1.1 §9.1.2, §14.2, §16.3 #4/#20/#27;
// docs/tz-v2-circle.md §3.1 /circle/join, §5.1). The offer and the consent
// texts come from the server; Checkout gets exactly the decided line items.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post } from './harness.mjs';
import { trusted, signIn, body, T0, DAY } from './api-helpers.mjs';
import { v2Rig, makeV2World, stripeBasics, STRIPE_ENV, seedWelcomeSet, PRICES } from './v2-helpers.mjs';
import { sha256Hex } from '../src/lib/crypto.js';

async function rig({ env = {}, welcome = true } = {}) {
  const world = stripeBasics(makeV2World());
  const r = await v2Rig({ world, envOverrides: { ...STRIPE_ENV, ...env } });
  if (welcome) seedWelcomeSet(r.t);
  const { cookie } = await signIn(r.t, 'clara@example.com');
  const user = r.t.rows("SELECT id FROM users WHERE email = 'clara@example.com'")[0];
  const call = (req) => r.t.call(req);
  const getJoin = async (qs = '') => {
    const res = await call(get(`/api/circle/join${qs}`, { ...trusted, Cookie: cookie }));
    return { res, data: await body(res) };
  };
  const checkout = async (payload, path = '/api/circle/checkout') => {
    const res = await call(post(path, payload, { ...trusted, Cookie: cookie, 'User-Agent': 'Mozilla/5.0 (iPhone) Safari/605.1' }));
    return { res, data: await body(res) };
  };
  return { ...r, cookie, userId: user.id, getJoin, checkout };
}

const AGREE = (version) => ({ consents: { terms: true, age_18: true }, terms_version: version });

function seedMembership(t, userId, status, extra = {}) {
  t.env.DB._db.prepare(`INSERT INTO memberships (id, user_id, stripe_subscription_id, status, kind, created_at, updated_at, ended_at)
    VALUES (?, ?, ?, ?, 'join', 'x', 'x', ?)`).run(extra.id || `m_${status}`, userId, extra.sub || `sub_${status}`, status, extra.ended_at || null);
}

test('T1-1: the offer is open, $50 today then $20 a month from a month later, with the disclosure and consent texts', async () => {
  const { getJoin } = await rig();
  const { res, data } = await getJoin();
  assert.equal(res.status, 200);
  assert.equal(data.open, true);
  assert.equal(data.kind, 'join');
  assert.equal(data.first_charge_cents, 5000);
  assert.equal(data.monthly_cents, 2000);
  assert.equal(data.joining_cents, 3000);
  assert.equal(data.first_renewal_on, '2026-11-15');
  assert.equal(data.disclosure,
    "By joining, you agree to the Membership Terms. You'll be charged $50 today, then $20 plus applicable tax every month starting November 15, 2026, until you cancel. Cancel anytime online in your account — it takes effect at the end of your paid month.");
  assert.deepEqual(data.consents.map((c) => c.id), ['terms', 'age_18']);
  assert.equal(data.consents[0].text, 'I agree to the Membership Terms and to automatic monthly renewal.');
  assert.equal(data.consents[1].text, 'I am 18 or older.');
  assert.match(data.terms_version, /^membership-terms-/);
  assert.equal(data.terms_url, 'https://club.springrenaissance.store/terms/membership');
  assert.equal(data.region_note, 'The Circle is currently available in the United States.');
});

test('T1-2: the join is closed until the launch switch is on, Stripe is configured and two welcome pieces exist', async () => {
  let r = await rig({ env: { CIRCLE_JOIN_OPEN: '' } });
  let j = await r.getJoin();
  assert.deepEqual([j.data.open, j.data.reason], [false, 'not_open']);
  let c = await r.checkout(AGREE(j.data.terms_version));
  assert.equal(c.res.status, 409);
  assert.equal(c.data.error.code, 'circle_not_open');

  r = await rig({ env: { STRIPE_SECRET_KEY: '' } });
  j = await r.getJoin();
  assert.deepEqual([j.data.open, j.data.reason], [false, 'not_configured']);

  r = await rig({ env: { STRIPE_SECRET_KEY: 'sk_live_nope' } });
  j = await r.getJoin();
  assert.deepEqual([j.data.open, j.data.reason], [false, 'not_configured']);

  r = await rig({ welcome: false });
  j = await r.getJoin();
  assert.deepEqual([j.data.open, j.data.reason], [false, 'welcome_set_incomplete']);
  c = await r.checkout(AGREE(j.data.terms_version));
  assert.equal(c.res.status, 409);
  assert.equal(r.world.stripeCalls.filter((x) => x.path === '/v1/checkout/sessions').length, 0);
});

test('T1-3: a welcome piece over $25 with shipping does not count towards the set', async () => {
  const r = await rig({ welcome: false });
  seedWelcomeSet(r.t, { shippingCents: 1000 }); // 1500 + 1000 ok, 1800 + 1000 over the cap
  const j = await r.getJoin();
  assert.deepEqual([j.data.open, j.data.reason], [false, 'welcome_set_incomplete']);
});

test('T1-4: prices in Stripe that differ from the economics settings close the join', async () => {
  const r = await rig();
  r.world.stripeOn('GET', '/v1/prices', () => ({ data: [{ ...PRICES.monthly, unit_amount: 2500 }, PRICES.joining] }));
  const j = await r.getJoin();
  assert.deepEqual([j.data.open, j.data.reason], [false, 'price_mismatch']);
});

test('T1-5: Checkout is created with the decided parameters, a Stripe customer once, and the consents recorded', async () => {
  const r = await rig();
  const j = await r.getJoin();
  const { res, data } = await r.checkout(AGREE(j.data.terms_version));
  assert.equal(res.status, 201, JSON.stringify(data));
  assert.equal(data.url, 'https://checkout.stripe.com/c/pay/cs_test_1');

  assert.equal(r.world.stripe.customers.length, 1);
  assert.equal(r.world.stripe.customers[0].email, 'clara@example.com');
  assert.equal(r.world.stripe.customers[0].metadata.user_id, r.userId);
  assert.equal(r.t.rows('SELECT stripe_customer_id FROM users WHERE id = ?', r.userId)[0].stripe_customer_id, 'cus_1');

  const call = r.world.stripeCalls.find((x) => x.path === '/v1/checkout/sessions');
  const p = call.params;
  assert.equal(p.mode, 'subscription');
  assert.equal(p.customer, 'cus_1');
  assert.equal(p.client_reference_id, r.userId);
  assert.equal(p['line_items[0][price]'], 'price_monthly');
  assert.equal(p['line_items[0][quantity]'], '1');
  assert.equal(p['line_items[1][price]'], 'price_joining');
  assert.equal(p['line_items[1][quantity]'], '1');
  assert.equal(p['billing_address_collection'], 'required');
  assert.equal(p['shipping_address_collection[allowed_countries][0]'], 'US');
  assert.equal(p['automatic_tax[enabled]'], 'false');
  assert.equal(p['subscription_data[metadata][user_id]'], r.userId);
  assert.equal(p['subscription_data[metadata][kind]'], 'join');
  assert.equal(p['subscription_data[metadata][terms_version]'], j.data.terms_version);
  assert.equal(p['metadata[user_id]'], r.userId);
  assert.equal(p['custom_text[submit][message]'], j.data.disclosure);
  assert.equal(p.success_url, 'https://club.springrenaissance.store/circle/welcome?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(p.cancel_url, 'https://club.springrenaissance.store/circle?checkout=canceled');
  assert.equal(p['payment_method_types[0]'], undefined, 'dynamic payment methods');
  assert.equal(p['consent_collection[terms_of_service]'], undefined, 'off until the Terms URL is set in Stripe');
  assert.equal(call.headers['Idempotency-Key'], `circle-checkout:${r.userId}:2026-10-15:join`);

  const consents = r.t.rows('SELECT kind, document_version, shown_text_sha256, granted, ua_summary FROM consents WHERE user_id = ? ORDER BY kind', r.userId);
  assert.deepEqual(consents.map((c) => c.kind), ['age_18', 'auto_renewal', 'membership_terms']);
  const termsHash = await sha256Hex(`${j.data.consents[0].text}\n${j.data.disclosure}`);
  assert.equal(consents.find((c) => c.kind === 'membership_terms').shown_text_sha256, termsHash);
  assert.equal(consents.find((c) => c.kind === 'auto_renewal').shown_text_sha256, termsHash);
  assert.equal(consents.find((c) => c.kind === 'age_18').shown_text_sha256, await sha256Hex(j.data.consents[1].text));
  assert.ok(consents.every((c) => c.granted === 1 && c.document_version === j.data.terms_version && c.ua_summary === 'Safari on iPhone'));
});

test('T1-6: a second click the same day reuses the customer and the idempotency key', async () => {
  const r = await rig();
  const j = await r.getJoin();
  await r.checkout(AGREE(j.data.terms_version));
  await r.checkout(AGREE(j.data.terms_version));
  assert.equal(r.world.stripe.customers.length, 1);
  const keys = r.world.stripeCalls.filter((x) => x.path === '/v1/checkout/sessions').map((x) => x.headers['Idempotency-Key']);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  r.t.setNow(T0 + DAY);
  await r.checkout(AGREE(j.data.terms_version));
  const later = r.world.stripeCalls.filter((x) => x.path === '/v1/checkout/sessions').at(-1).headers['Idempotency-Key'];
  assert.notEqual(later, keys[0]);
});

test('T1-7: consents must both be given and the terms version must be the current one', async () => {
  const r = await rig();
  const j = await r.getJoin();
  for (const payload of [
    {}, { consents: { terms: true }, terms_version: j.data.terms_version }, { consents: { age_18: true }, terms_version: j.data.terms_version },
    { consents: { terms: 'yes', age_18: true }, terms_version: j.data.terms_version },
  ]) {
    const c = await r.checkout(payload);
    assert.equal(c.res.status, 400, JSON.stringify(payload));
    assert.equal(c.data.error.code, 'consent_required');
  }
  const stale = await r.checkout(AGREE('membership-terms-1999-01-01'));
  assert.equal(stale.res.status, 409);
  assert.equal(stale.data.error.code, 'terms_changed');
  assert.equal(r.t.rows('SELECT 1 FROM consents').length, 0);
  assert.equal(r.world.stripeCalls.filter((x) => x.method === 'POST').length, 0);
});

test('T1-8: a live membership answers 409; a former member is sent to rejoin', async () => {
  for (const status of ['active', 'past_due', 'canceling', 'pending']) {
    const r = await rig();
    seedMembership(r.t, r.userId, status);
    const j = await r.getJoin();
    assert.equal(j.data.kind, 'member');
    assert.equal(j.data.open, false);
    const c = await r.checkout(AGREE(j.data.terms_version));
    assert.equal(c.res.status, 409, status);
    assert.equal(c.data.error.code, 'already_member');
  }
  const r = await rig();
  seedMembership(r.t, r.userId, 'ended', { ended_at: '2026-09-01T00:00:00.000Z' });
  const j = await r.getJoin();
  assert.equal(j.data.kind, 'rejoin');
  const c = await r.checkout(AGREE(j.data.terms_version));
  assert.equal(c.res.status, 409);
  assert.equal(c.data.error.code, 'use_rejoin');
});

test('T1-9: rejoin is $20 today, monthly line only, no welcome piece needed', async () => {
  const r = await rig({ welcome: false });
  seedMembership(r.t, r.userId, 'ended_expired', { ended_at: '2026-08-01T00:00:00.000Z' });
  const j = await r.getJoin();
  assert.equal(j.data.open, true, JSON.stringify(j.data));
  assert.equal(j.data.kind, 'rejoin');
  assert.equal(j.data.first_charge_cents, 2000);
  assert.equal(j.data.disclosure,
    "You'll be charged $20 today, then $20 plus applicable tax every month starting November 15, 2026, until you cancel. Cancel anytime online in your account — it takes effect at the end of your paid month.");
  const c = await r.checkout(AGREE(j.data.terms_version), '/api/circle/rejoin');
  assert.equal(c.res.status, 201, JSON.stringify(c.data));
  const p = r.world.stripeCalls.find((x) => x.path === '/v1/checkout/sessions').params;
  assert.equal(p['line_items[0][price]'], 'price_monthly');
  assert.equal(p['line_items[1][price]'], undefined);
  assert.equal(p['subscription_data[metadata][kind]'], 'rejoin');
  assert.match(r.world.stripeCalls.find((x) => x.path === '/v1/checkout/sessions').headers['Idempotency-Key'], /:rejoin$/);
});

test('T1-10: rejoin without a past membership, or while one is live, is refused', async () => {
  let r = await rig();
  let c = await r.checkout(AGREE((await r.getJoin()).data.terms_version), '/api/circle/rejoin');
  assert.equal(c.res.status, 409);
  assert.equal(c.data.error.code, 'not_a_former_member');
  r = await rig();
  seedMembership(r.t, r.userId, 'active');
  c = await r.checkout(AGREE((await r.getJoin()).data.terms_version), '/api/circle/rejoin');
  assert.equal(c.res.status, 409);
  assert.equal(c.data.error.code, 'already_member');
});

test('T1-11: Stripe down → 503 with a calm message, nothing half-done that matters', async () => {
  const r = await rig();
  const j = await r.getJoin();
  r.world.stripeOn('POST', '/v1/checkout/sessions', () => Response.json({ error: { type: 'api_error', message: 'boom' } }, { status: 500 }));
  const c = await r.checkout(AGREE(j.data.terms_version));
  assert.equal(c.res.status, 503);
  assert.equal(c.data.error.code, 'payment_unavailable');
  assert.doesNotMatch(c.data.error.message, /boom/);
});

test('T1-12: Stripe Tax and the Stripe terms checkbox follow their switches', async () => {
  const r = await rig({ env: { STRIPE_TAX_ENABLED: 'true', STRIPE_CHECKOUT_TOS: 'on' } });
  const j = await r.getJoin();
  await r.checkout(AGREE(j.data.terms_version));
  const p = r.world.stripeCalls.find((x) => x.path === '/v1/checkout/sessions').params;
  assert.equal(p['automatic_tax[enabled]'], 'true');
  assert.equal(p['consent_collection[terms_of_service]'], 'required');
});

test('T1-13: signed-out callers get 401', async () => {
  const r = await rig();
  const res = await r.t.call(get('/api/circle/join', trusted));
  assert.equal(res.status, 401);
  const res2 = await r.t.call(post('/api/circle/checkout', {}, trusted));
  assert.equal(res2.status, 401);
});
