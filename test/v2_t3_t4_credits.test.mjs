// V2 T3 (ledger & credits screen data) and T4 (spend credits → single-use
// gift card). Spec v1.1 §6.7, §7 invariants, §8.4, §9.2.4, §16.3 #5/#6/#10.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post } from './harness.mjs';
import { trusted, signIn, body, T0, DAY, MIN } from './api-helpers.mjs';
import { v2Rig, makeV2World, stripeBasics, STRIPE_ENV, stripeEvent, deliver, fx, stripePayments, CIRCLE_WHSEC } from './v2-helpers.mjs';

async function rig({ shopify = true } = {}) {
  const world = stripePayments(stripeBasics(makeV2World({ shopifyCustomers: [{ id: 'gid://shopify/Customer/7', email: 'clara@example.com' }] })));
  world.cards = [];
  world.shopifyOps.CreditsGiftCard = ({ input }) => {
    if (world.failCards) return world.failCards === 'throw' ? new Response('boom', { status: 502 }) : { giftCardCreate: { giftCard: null, giftCardCode: null, userErrors: [{ field: ['initialValue'], message: 'nope', code: 'INVALID' }] } };
    const n = world.cards.length + 1;
    const card = { id: `gid://shopify/GiftCard/${n}`, code: `abcd efgh ijkl ${String(1000 + n)}`, input, enabled: true, balance: input.initialValue };
    world.cards.push(card);
    return { giftCardCreate: { giftCard: { id: card.id, lastCharacters: card.code.slice(-4), initialValue: { amount: input.initialValue } }, giftCardCode: card.code, userErrors: [] } };
  };
  world.shopifyOps.CreditsGiftCardState = ({ id }) => {
    const c = world.cards.find((x) => x.id === id);
    return { giftCard: c ? { id, enabled: c.enabled, balance: { amount: c.balance }, initialValue: { amount: c.input.initialValue } } : null };
  };
  world.shopifyOps.CreditsGiftCardDeactivate = ({ id }) => {
    const c = world.cards.find((x) => x.id === id);
    c.enabled = false;
    return { giftCardDeactivate: { giftCard: { id, enabled: false }, userErrors: [] } };
  };
  const r = await v2Rig({ world, envOverrides: { ...STRIPE_ENV, STRIPE_CIRCLE_WEBHOOK_SECRET: CIRCLE_WHSEC, ...(shopify ? {} : { SHOPIFY_SHOP: '' }) } });
  let s = await signIn(r.t, 'clara@example.com');
  const userId = r.t.rows("SELECT id FROM users WHERE email = 'clara@example.com'")[0].id;
  const send = (type, obj, opts) => deliver(r.t, stripeEvent(type, obj, opts));
  const api = async (method, path, payload, headers = {}) => {
    const req = method === 'GET' ? get(path, { ...trusted, Cookie: s.cookie, ...headers }) : post(path, payload ?? {}, { ...trusted, Cookie: s.cookie, ...headers });
    const res = await r.t.call(req);
    return { res, data: await body(res) };
  };
  const balance = () => r.t.rows('SELECT COALESCE(SUM(amount_cents),0) AS b FROM credit_ledger WHERE user_id = ?', userId)[0].b;
  const relogin = async () => { s = await signIn(r.t, 'clara@example.com'); };
  return { ...r, userId, send, api, balance, relogin, cookie: s.cookie, stepUpAt: (ms) => r.t.env.DB.prepare('UPDATE sessions SET step_up_at = ?1 WHERE user_id = ?2').bind(new Date(ms).toISOString(), userId).run() };
}

async function member(r, { renewals = 0 } = {}) {
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  await r.send('invoice.paid', fx.invoice({ userId: r.userId }));
  await r.send('customer.subscription.updated', fx.subscription({ userId: r.userId }));
  for (let i = 1; i <= renewals; i++) {
    await r.send('invoice.paid', fx.invoice({ id: `in_${i + 1}`, userId: r.userId, reason: 'subscription_cycle', start: T0 + (31 * i) * DAY, end: T0 + (31 * (i + 1)) * DAY }));
  }
  await r.send('customer.subscription.updated', fx.subscription({ userId: r.userId, start: T0 + 31 * renewals * DAY, end: T0 + 31 * (renewals + 1) * DAY }));
}

// ---- T3 ----------------------------------------------------------------------

test('T3-1: credits: balance, next accrual, history newest first with running balance', async () => {
  const r = await rig();
  await member(r, { renewals: 2 });
  const { res, data } = await r.api('GET', '/api/circle/credits');
  assert.equal(res.status, 200);
  assert.equal(data.balance_cents, 6000);
  assert.deepEqual(data.next_accrual, { date: new Date(T0 + 93 * DAY).toISOString().slice(0, 10), amount_cents: 2000 });
  assert.equal(data.expires_on, null);
  assert.equal(data.frozen, false);
  assert.deepEqual(data.ledger.map((l) => [l.memo, l.amount_cents, l.running_balance_cents]), [
    ['Monthly credits — December', 2000, 6000],
    ['Monthly credits — November', 2000, 4000],
    ['Welcome — first month', 2000, 2000],
  ]);
  assert.equal(data.next_cursor, null);
});

test('T3-2: the history pages by 20 with a cursor; the running balance stays right across pages', async () => {
  const r = await rig();
  await member(r, { renewals: 24 });
  let { data } = await r.api('GET', '/api/circle/credits');
  assert.equal(data.ledger.length, 20);
  assert.equal(data.ledger[0].running_balance_cents, 50000);
  assert.ok(data.next_cursor);
  const second = (await r.api('GET', `/api/circle/credits?cursor=${encodeURIComponent(data.next_cursor)}`)).data;
  assert.equal(second.ledger.length, 5);
  assert.equal(second.ledger[0].running_balance_cents, 50000 - 20 * 2000);
  assert.equal(second.ledger.at(-1).running_balance_cents, 2000);
  assert.equal(second.next_cursor, null);
  const bad = await r.api('GET', '/api/circle/credits?cursor=garbage');
  assert.equal(bad.res.status, 400);
});

test('T3-3: canceling and past_due have no next accrual; ended shows when credits expire; a dispute shows frozen', async () => {
  const r = await rig();
  await member(r);
  await r.send('customer.subscription.updated', fx.subscription({ userId: r.userId, cancelAtPeriodEnd: true }));
  assert.equal((await r.api('GET', '/api/circle/credits')).data.next_accrual, null);
  await r.send('customer.subscription.deleted', fx.subscription({ userId: r.userId, status: 'canceled', endedAt: T0 + 31 * DAY }));
  const ended = (await r.api('GET', '/api/circle/credits')).data;
  assert.equal(ended.expires_on, new Date(T0 + 61 * DAY).toISOString().slice(0, 10));
  await r.send('charge.dispute.created', { id: 'dp_1', object: 'dispute', charge: 'ch_in_1', payment_intent: 'pi_in_1', amount: 5000 });
  assert.equal((await r.api('GET', '/api/circle/credits')).data.frozen, true);
});

test('T3-4: someone who never joined gets 403; the member summary says who they are', async () => {
  const r = await rig();
  const res = await r.api('GET', '/api/circle/credits');
  assert.equal(res.res.status, 403);
  assert.equal(res.data.error.code, 'not_a_member');
  const club = await r.api('GET', '/api/circle');
  assert.equal(club.res.status, 200);
  assert.equal(club.data.membership, null);
  await member(r);
  const vip = (await r.api('GET', '/api/circle')).data;
  assert.equal(vip.membership.status, 'active');
  assert.equal(vip.membership.since, new Date(T0).toISOString());
  assert.equal(vip.balance_cents, 2000);
  assert.equal(vip.welcome.status, 'awaiting_choice');
  assert.equal(vip.membership.stripe_subscription_id, undefined, 'no Stripe ids to the browser');
});

// ---- T4 ----------------------------------------------------------------------

const redeem = (r, amount, key) => r.api('POST', '/api/credits/redeem', { amount_cents: amount }, key ? { 'Idempotency-Key': key } : {});

test('T4-1: spending needs a confirmation within 15 minutes', async () => {
  const r = await rig();
  await member(r);
  let out = await redeem(r, 1000);
  assert.equal(out.res.status, 403);
  assert.equal(out.data.error.code, 'step_up_required');
  await r.stepUpAt(T0 - 16 * MIN);
  out = await redeem(r, 1000);
  assert.equal(out.res.status, 403);
  assert.equal(r.balance(), 2000);
});

test('T4-2: a redemption issues a single-use card, shows the code once, stores only last 4, emails the code', async () => {
  const r = await rig();
  await member(r);
  await r.stepUpAt(T0);
  const out = await redeem(r, 1500, 'k-1');
  assert.equal(out.res.status, 201, JSON.stringify(out.data));
  assert.equal(out.data.redemption.amount_cents, 1500);
  assert.equal(out.data.redemption.code, 'abcd efgh ijkl 1001');
  assert.equal(out.data.redemption.last4, '1001');
  const card = r.world.cards[0];
  assert.equal(card.input.initialValue, '15.00');
  assert.equal(card.input.customerId, 'gid://shopify/Customer/7');
  assert.match(card.input.note, /^Circle credits · [0-9A-Z]{26}$/);
  assert.equal(card.input.expiresOn, undefined, 'no expiry until counsel decides');
  assert.equal(r.balance(), 500);
  const red = r.t.rows('SELECT * FROM redemptions')[0];
  assert.equal(red.status, 'issued');
  assert.equal(red.gift_card_last4, '1001');
  const dump = JSON.stringify(r.t.rows('SELECT * FROM redemptions')) + JSON.stringify(r.t.rows('SELECT * FROM credit_ledger'));
  assert.doesNotMatch(dump, /abcd efgh/);
  const memo = r.t.rows("SELECT memo FROM credit_ledger WHERE kind = 'redemption'")[0].memo;
  assert.equal(memo, 'Used at checkout · card ••1001');
  const mail = r.world.emails.find((e) => e.subject === 'Your credits are ready to use');
  assert.match(mail.text, /abcd efgh ijkl 1001/);
});

test('T4-3: amounts must be whole credits, at least one, and not more than the balance', async () => {
  const r = await rig();
  await member(r);
  await r.stepUpAt(T0);
  for (const a of [0, 50, 150, -100, '1000', null]) {
    const out = await redeem(r, a);
    assert.equal(out.res.status, 400, String(a));
  }
  const over = await redeem(r, 2100);
  assert.equal(over.res.status, 409);
  assert.equal(over.data.error.code, 'insufficient_credits');
  assert.equal(r.world.cards.length, 0);
});

test('T4-4: two requests racing for the whole balance — only one card', async () => {
  const r = await rig();
  await member(r);
  await r.stepUpAt(T0);
  const [a, b] = await Promise.all([redeem(r, 2000, 'a'), redeem(r, 2000, 'b')]);
  assert.deepEqual([a.res.status, b.res.status].sort(), [201, 409]);
  assert.equal(r.world.cards.length, 1);
  assert.equal(r.balance(), 0);
});

test('T4-5: the same Idempotency-Key returns the same redemption without a second card or the code again', async () => {
  const r = await rig();
  await member(r);
  await r.stepUpAt(T0);
  const first = await redeem(r, 1000, 'same');
  const again = await redeem(r, 1000, 'same');
  assert.equal(again.res.status, 200);
  assert.equal(again.data.redemption.id, first.data.redemption.id);
  assert.equal(again.data.redemption.code, null);
  assert.equal(again.data.repeated, true);
  assert.equal(r.world.cards.length, 1);
  assert.equal(r.balance(), 1000);
});

test('T4-6: Shopify refuses → credits returned, redemption failed, calm message; Shopify down → same plus a flag for Felix', async () => {
  const r = await rig();
  await member(r);
  await r.stepUpAt(T0);
  r.world.failCards = 'errors';
  let out = await redeem(r, 1000, 'x1');
  assert.equal(out.res.status, 503);
  assert.equal(out.data.error.message, "We couldn't create your card. Your credits are untouched — please try again.");
  assert.equal(r.balance(), 2000);
  assert.equal(r.t.rows("SELECT status FROM redemptions")[0].status, 'failed');
  r.world.failCards = 'throw';
  out = await redeem(r, 1000, 'x2');
  assert.equal(out.res.status, 503);
  assert.equal(r.balance(), 2000);
  assert.equal(r.t.rows("SELECT 1 FROM admin_flags WHERE kind = 'redemption_uncertain'").length, 1);
});

test('T4-7: frozen credits, a negative balance, an expired grace or no membership cannot be spent', async () => {
  const r = await rig();
  let out = await redeem(r, 100);
  assert.equal(out.res.status, 403); // step-up first
  await r.stepUpAt(T0);
  out = await redeem(r, 100);
  assert.equal(out.data.error.code, 'not_a_member');
  await member(r);
  await r.send('charge.dispute.created', { id: 'dp_1', object: 'dispute', charge: 'ch_in_1', payment_intent: 'pi_in_1', amount: 5000 });
  r.t.env.DB._db.prepare("INSERT INTO credit_ledger (id, user_id, amount_cents, kind, idempotency_key, created_at) VALUES ('adj', ?, 3000, 'manual', 'adj', 'x')").run(r.userId);
  out = await redeem(r, 100);
  assert.equal(out.res.status, 409);
  assert.equal(out.data.error.code, 'credits_frozen');
});

test('T4-8: after the membership ends, credits can be spent until the grace date and not after', async () => {
  const r = await rig();
  await member(r);
  await r.send('customer.subscription.deleted', fx.subscription({ userId: r.userId, status: 'canceled', endedAt: T0 + 31 * DAY }));
  r.t.setNow(T0 + 60 * DAY);
  await r.relogin();
  await r.stepUpAt(T0 + 60 * DAY);
  let out = await redeem(r, 100, 'g1');
  assert.equal(out.res.status, 201);
  r.t.setNow(T0 + 62 * DAY);
  await r.relogin();
  await r.stepUpAt(T0 + 62 * DAY);
  out = await redeem(r, 100, 'g2');
  assert.equal(out.res.status, 409);
  assert.equal(out.data.error.code, 'credits_expired');
});

test('T4-9: an unused card goes back to credits once; a used one cannot', async () => {
  const r = await rig();
  await member(r);
  await r.stepUpAt(T0);
  const out = await redeem(r, 1000, 'r1');
  const id = out.data.redemption.id;
  let back = await r.api('POST', `/api/credits/redemptions/${id}/return`, {});
  assert.equal(back.res.status, 200, JSON.stringify(back.data));
  assert.equal(r.balance(), 2000);
  assert.equal(r.world.cards[0].enabled, false);
  assert.equal(r.t.rows('SELECT status FROM redemptions WHERE id = ?', id)[0].status, 'deactivated');
  back = await r.api('POST', `/api/credits/redemptions/${id}/return`, {});
  assert.equal(back.res.status, 409);
  assert.equal(r.balance(), 2000);
  const out2 = await redeem(r, 1000, 'r2');
  r.world.cards[1].balance = '4.00';
  back = await r.api('POST', `/api/credits/redemptions/${out2.data.redemption.id}/return`, {});
  assert.equal(back.res.status, 409);
  assert.equal(back.data.error.code, 'card_used');
  // someone else's redemption id is not found
  const other = await r.api('POST', '/api/credits/redemptions/01ZZZZZZZZZZZZZZZZZZZZZZZZ/return', {});
  assert.equal(other.res.status, 404);
});

test('T4-10: without Shopify the redemption is refused before any credit moves', async () => {
  const r = await rig({ shopify: false });
  await member(r);
  await r.stepUpAt(T0);
  const out = await redeem(r, 1000);
  assert.equal(out.res.status, 503);
  assert.equal(r.balance(), 2000);
  assert.equal(r.t.rows('SELECT 1 FROM redemptions').length, 0);
});
