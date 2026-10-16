// V2 T2/T3/T9/T11/T12 (webhook side): POST /webhooks/stripe and the
// membership state machine (docs/tz-v2-circle.md §6.1, §9; spec v1.1 §9.1.4,
// §16.3). Join → renew → fail → recover → cancel → end; out-of-order and
// duplicate events change nothing; refunds and disputes reverse credits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signIn, T0, DAY } from './api-helpers.mjs';
import { v2Rig, makeV2World, stripeBasics, STRIPE_ENV, stripeEvent, deliver, fx, stripePayments, CIRCLE_WHSEC } from './v2-helpers.mjs';
import { memberPriceHooks } from '../src/circle/effects.js';

async function rig(env = {}) {
  const world = stripePayments(stripeBasics(makeV2World({ shopifyCustomers: [{ id: 'gid://shopify/Customer/7', email: 'clara@example.com' }] })));
  const r = await v2Rig({ world, envOverrides: { ...STRIPE_ENV, STRIPE_CIRCLE_WEBHOOK_SECRET: CIRCLE_WHSEC, ADMIN_NOTIFY_EMAIL: 'felix@example.com', ...env } });
  await signIn(r.t, 'clara@example.com');
  const userId = r.t.rows("SELECT id FROM users WHERE email = 'clara@example.com'")[0].id;
  const send = (type, obj, opts) => deliver(r.t, stripeEvent(type, obj, opts));
  const m = () => r.t.rows('SELECT * FROM memberships WHERE user_id = ?', userId)[0];
  const ledger = () => r.t.rows('SELECT kind, amount_cents, memo, idempotency_key FROM credit_ledger WHERE user_id = ? ORDER BY created_at, rowid', userId).map((x) => ({ ...x }));
  const balance = () => r.t.rows('SELECT COALESCE(SUM(amount_cents),0) AS b FROM credit_ledger WHERE user_id = ?', userId)[0].b;
  const emails = (template) => r.t.rows('SELECT template, dedupe_key FROM email_log WHERE template = ?', template);
  return { ...r, userId, send, m, ledger, balance, emails };
}

async function joined(r) {
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  await r.send('invoice.paid', fx.invoice({ userId: r.userId }));
  await r.send('customer.subscription.updated', fx.subscription({ userId: r.userId }));
}

// ---- the endpoint ----------------------------------------------------------------

test('T2-W1: no secret → 503; bad signature or an old timestamp → 400; nothing recorded', async () => {
  let r = await rig({ STRIPE_CIRCLE_WEBHOOK_SECRET: '' });
  let out = await r.send('invoice.paid', fx.invoice({ userId: r.userId }));
  assert.equal(out.res.status, 503);
  r = await rig();
  out = await deliver(r.t, stripeEvent('invoice.paid', fx.invoice({ userId: r.userId })), { secret: 'whsec_wrong' });
  assert.equal(out.res.status, 400);
  assert.equal(out.data.error.code, 'invalid_signature');
  out = await deliver(r.t, stripeEvent('invoice.paid', fx.invoice({ userId: r.userId })), { ts: Math.floor(T0 / 1000) - 600 });
  assert.equal(out.res.status, 400);
  assert.equal(r.t.rows('SELECT 1 FROM webhook_events').length, 0);
  assert.equal(r.t.rows('SELECT 1 FROM memberships').length, 0);
});

test('T2-W2: a live-mode event on a test environment is acknowledged and ignored', async () => {
  const r = await rig();
  const out = await deliver(r.t, stripeEvent('checkout.session.completed', fx.session({ userId: r.userId }), { livemode: true }));
  assert.equal(out.res.status, 200);
  assert.equal(r.t.rows("SELECT status, error FROM webhook_events")[0].status, 'ignored');
  assert.equal(r.t.rows('SELECT 1 FROM memberships').length, 0);
});

test('T2-W3: the same event delivered twice is processed once', async () => {
  const r = await rig();
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  const ev = stripeEvent('invoice.paid', fx.invoice({ userId: r.userId }));
  await deliver(r.t, ev);
  const again = await deliver(r.t, ev);
  assert.equal(again.data.duplicate, true);
  assert.equal(r.balance(), 2000);
});

test('T2-W4: events of subscriptions that are not the Circle are ignored', async () => {
  const r = await rig();
  const inv = fx.invoice({ userId: r.userId });
  inv.parent.subscription_details.metadata = {};
  const out = await r.send('invoice.paid', inv);
  assert.equal(out.res.status, 200);
  assert.equal(r.t.rows('SELECT status FROM webhook_events')[0].status, 'ignored');
  assert.equal(r.t.rows('SELECT 1 FROM memberships').length, 0);
});

test('T2-W5: a processing error answers 500, is stored as failed, and the retry succeeds', async () => {
  const r = await rig();
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  const real = r.world.stripeRoutes.slice();
  r.world.stripeOn('GET', '/v1/prices', () => Response.json({ error: { message: 'down' } }, { status: 500 }));
  r.t.env.CLIENT_KV._m.clear();
  const ev = stripeEvent('invoice.paid', fx.invoice({ userId: r.userId }));
  let out = await deliver(r.t, ev);
  assert.equal(out.res.status, 500);
  assert.equal(r.t.rows('SELECT status FROM webhook_events WHERE event_id = ?', ev.id)[0].status, 'failed');
  r.world.stripeRoutes = real;
  out = await deliver(r.t, ev);
  assert.equal(out.res.status, 200);
  assert.equal(r.balance(), 2000);
});

// ---- joining ------------------------------------------------------------------------

test('T2-J1: checkout completed + first invoice → active member, 20 welcome credits, welcome piece awaiting, welcome email', async () => {
  const r = await rig();
  await r.t.env.DB.prepare("INSERT INTO holds (id, user_id, kind, source, status, created_at) VALUES ('h1', ?1, 'circle_waitlist', 'portal', 'open', 'x')").bind(r.userId).run();
  await joined(r);
  const m = r.m();
  assert.equal(m.status, 'active');
  assert.equal(m.kind, 'join');
  assert.equal(m.stripe_subscription_id, 'sub_1');
  assert.equal(m.paid_invoices, 1);
  assert.equal(m.last_paid_period_end, new Date(T0 + 31 * DAY).toISOString());
  assert.equal(m.current_period_end, new Date(T0 + 31 * DAY).toISOString());
  assert.equal(r.t.rows('SELECT tier FROM users WHERE id = ?', r.userId)[0].tier, 'vip');
  assert.deepEqual(r.ledger(), [{ kind: 'welcome_accrual', amount_cents: 2000, memo: 'Welcome — first month', idempotency_key: 'accrual:in_1' }]);
  const inv = r.t.rows('SELECT * FROM membership_invoices')[0];
  assert.deepEqual([inv.status, inv.amount_paid_cents, inv.monthly_cents, inv.joining_cents], ['paid', 5000, 2000, 3000]);
  const gift = r.t.rows('SELECT status, shipping_json FROM gift_selections WHERE user_id = ?', r.userId)[0];
  assert.equal(gift.status, 'awaiting_choice');
  assert.equal(JSON.parse(gift.shipping_json).address.postal_code, '78701');
  assert.equal(r.t.rows("SELECT status FROM holds WHERE id = 'h1'")[0].status, 'converted');
  assert.equal(r.emails('welcome').length, 1);
  assert.equal(r.emails('credits_added').length, 0);
  const pay = r.t.rows('SELECT * FROM stripe_payments')[0];
  assert.deepEqual([pay.invoice_id, pay.charge_id, pay.card_fingerprint], ['in_1', 'ch_in_1', 'fp_clara']);
  // Shopify tags: vip-circle added
  assert.ok(r.world.shopify.customers[0].tags.includes('vip-circle'));
  assert.ok(!r.world.shopify.customers[0].tags.includes('circle-waitlist'));
});

test('T2-J2: invoice.paid before checkout.session.completed → one membership, credits once, the piece still offered', async () => {
  const r = await rig();
  await r.send('invoice.paid', fx.invoice({ userId: r.userId }));
  assert.equal(r.m().status, 'active');
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  await r.send('customer.subscription.created', fx.subscription({ userId: r.userId }));
  assert.equal(r.t.rows('SELECT 1 FROM memberships').length, 1);
  assert.equal(r.balance(), 2000);
  assert.equal(r.t.rows('SELECT 1 FROM gift_selections').length, 1);
});

test('T2-J3: the same invoice in two different events credits once (keyed by invoice id)', async () => {
  const r = await rig();
  await joined(r);
  await r.send('invoice.paid', fx.invoice({ userId: r.userId }));
  assert.equal(r.balance(), 2000);
  assert.equal(r.m().paid_invoices, 1);
  assert.equal(r.emails('welcome').length, 1);
});

test('T2-J4: tax never changes credits ($21.65 paid → 20 credits)', async () => {
  const r = await rig();
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  await r.send('invoice.paid', fx.invoice({ userId: r.userId, tax: 165 }));
  assert.equal(r.balance(), 2000);
});

test('T2-J5: renewals add 20 credits with the month name and a credits email; the count grows', async () => {
  const r = await rig();
  await joined(r);
  await r.send('invoice.paid', fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', start: T0 + 31 * DAY, end: T0 + 61 * DAY }));
  const l = r.ledger();
  assert.deepEqual(l[1], { kind: 'accrual', amount_cents: 2000, memo: 'Monthly credits — November', idempotency_key: 'accrual:in_2' });
  assert.equal(r.balance(), 4000);
  assert.equal(r.m().paid_invoices, 2);
  assert.equal(r.m().consecutive_paid_months, 2);
  assert.equal(r.emails('credits_added').length, 1);
});

test('T2-J6: rejoin — no welcome piece, first invoice $20 → 20 credits, welcome back email', async () => {
  const r = await rig();
  await r.send('checkout.session.completed', fx.session({ userId: r.userId, kind: 'rejoin' }));
  await r.send('invoice.paid', fx.invoice({ userId: r.userId, kind: 'rejoin' }));
  assert.equal(r.m().kind, 'rejoin');
  assert.equal(r.t.rows('SELECT 1 FROM gift_selections').length, 0);
  assert.deepEqual(r.ledger().map((x) => [x.kind, x.amount_cents, x.memo]), [['accrual', 2000, 'Monthly credits — October']]);
  assert.equal(r.emails('welcome_back').length, 1);
});

test('T2-J7: a second join of someone who already had a welcome piece creates no second one', async () => {
  const r = await rig();
  await joined(r);
  await r.send('checkout.session.completed', fx.session({ userId: r.userId, sub: 'sub_2', id: 'cs_test_2' }));
  assert.equal(r.t.rows('SELECT 1 FROM gift_selections').length, 1);
  // and Felix gets a duplicate-subscription flag
  assert.equal(r.t.rows("SELECT 1 FROM admin_flags WHERE kind = 'duplicate_subscription'").length, 1);
});

// ---- failing and recovering ------------------------------------------------------------

test('T2-F1: a failed renewal → past_due, member price paused, one email; recovery → active and the price returns', async () => {
  const r = await rig();
  const calls = [];
  memberPriceHooks.grant = async (svc, uid) => calls.push(['grant', uid]);
  memberPriceHooks.revoke = async (svc, uid, why) => calls.push(['revoke', uid, why]);
  try {
    await joined(r);
    const fail = fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', status: 'open', attempt: 1, next: Math.floor((T0 + 34 * DAY) / 1000) });
    await r.send('invoice.payment_failed', fail);
    assert.equal(r.m().status, 'past_due');
    assert.equal(r.t.rows('SELECT had_failure FROM membership_invoices WHERE invoice_id = ?', 'in_2')[0].had_failure, 1);
    assert.equal(r.emails('payment_failed').length, 1);
    assert.deepEqual(calls.at(-1), ['revoke', r.userId, 'past_due']);
    // retry 2 fails: no email; retry 3 (before the last): email
    await r.send('invoice.payment_failed', { ...fail, attempt_count: 2 });
    assert.equal(r.emails('payment_failed').length, 1);
    await r.send('invoice.payment_failed', { ...fail, attempt_count: 3 });
    assert.equal(r.emails('payment_failed').length, 2);
    // the last one (no next attempt): Stripe will cancel; no email from us
    await r.send('invoice.payment_failed', { ...fail, attempt_count: 4, next_payment_attempt: null });
    assert.equal(r.emails('payment_failed').length, 2);

    await r.send('invoice.paid', fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', start: T0 + 31 * DAY, end: T0 + 61 * DAY }));
    assert.equal(r.m().status, 'active');
    assert.equal(r.balance(), 4000);
    assert.deepEqual(calls.at(-1), ['grant', r.userId]);
    assert.equal(r.t.rows('SELECT tier FROM users WHERE id = ?', r.userId)[0].tier, 'vip');
  } finally {
    memberPriceHooks.grant = null;
    memberPriceHooks.revoke = null;
  }
});

test('T2-F2: retries exhausted → Stripe cancels → ended (payment_failed), grace = last paid period end + 30 days', async () => {
  const r = await rig();
  await joined(r);
  await r.send('invoice.payment_failed', fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', status: 'open', next: 1 }));
  await r.send('customer.subscription.deleted', fx.subscription({ userId: r.userId, status: 'canceled', reason: 'payment_failed', endedAt: T0 + 41 * DAY }));
  const m = r.m();
  assert.equal(m.status, 'ended');
  assert.equal(m.end_reason, 'payment_failed');
  assert.equal(m.credits_grace_until, new Date(T0 + 61 * DAY).toISOString());
  assert.equal(r.t.rows('SELECT tier FROM users WHERE id = ?', r.userId)[0].tier, 'club');
  assert.equal(r.emails('membership_ended_payment').length, 1);
  assert.equal(r.balance(), 2000, 'credits stay until the grace ends');
});

test('T2-F3: a payment needing confirmation sends the hosted invoice link once', async () => {
  const r = await rig();
  await joined(r);
  const inv = fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', status: 'open' });
  await r.send('invoice.payment_action_required', inv);
  await r.send('invoice.payment_action_required', inv);
  assert.equal(r.emails('payment_action_required').length, 1);
});

test('T2-F4: a new card while past_due retries the open invoice (customer.updated with a new default)', async () => {
  const r = await rig();
  await joined(r);
  await r.send('invoice.payment_failed', fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', status: 'open', next: 1 }));
  let paid = 0;
  r.world.stripeOn('POST', '/v1/invoices/:id/pay', (call, id) => { paid++; assert.equal(id, 'in_2'); return { id, status: 'paid' }; });
  await r.send('customer.updated', { id: 'cus_1', object: 'customer' }, { previous: { metadata: {} } });
  assert.equal(paid, 0, 'an unrelated customer update does nothing');
  await r.send('customer.updated', { id: 'cus_1', object: 'customer' }, { previous: { invoice_settings: { default_payment_method: 'pm_old' } } });
  assert.equal(paid, 1);
});

// ---- cancelling ----------------------------------------------------------------------

test('T2-C1: cancel at period end → canceling (price stays); undo → active; deletion → ended (canceled) with the email once', async () => {
  const r = await rig();
  await joined(r);
  await r.send('customer.subscription.updated', fx.subscription({ userId: r.userId, cancelAtPeriodEnd: true }));
  assert.equal(r.m().status, 'canceling');
  assert.ok(r.m().cancel_requested_at);
  await r.send('customer.subscription.updated', fx.subscription({ userId: r.userId }));
  assert.equal(r.m().status, 'active');
  assert.equal(r.m().cancel_requested_at, null);
  await r.send('customer.subscription.updated', fx.subscription({ userId: r.userId, cancelAtPeriodEnd: true }));
  await r.send('customer.subscription.deleted', fx.subscription({ userId: r.userId, status: 'canceled', reason: 'cancellation_requested', endedAt: T0 + 31 * DAY }));
  const m = r.m();
  assert.deepEqual([m.status, m.end_reason], ['ended', 'canceled']);
  assert.equal(m.credits_grace_until, new Date(T0 + 61 * DAY).toISOString());
  assert.equal(r.emails('membership_canceled').length, 1);
  // ended is terminal: a late snapshot cannot revive it
  await r.send('customer.subscription.updated', fx.subscription({ userId: r.userId }));
  assert.equal(r.m().status, 'ended');
});

test('T2-C2: an older snapshot arriving late does not undo a newer one', async () => {
  const r = await rig();
  await joined(r);
  const base = Math.floor(T0 / 1000) + 10000;
  await deliver(r.t, stripeEvent('customer.subscription.updated', fx.subscription({ userId: r.userId, cancelAtPeriodEnd: true }), { created: base + 10 }));
  await deliver(r.t, stripeEvent('customer.subscription.updated', fx.subscription({ userId: r.userId }), { created: base + 5 }));
  assert.equal(r.m().status, 'canceling');
});

// ---- refunds and disputes ---------------------------------------------------------------

test('T2-R1: a 50% refund of a $20 renewal reverses 10 credits; the rest of the refund reverses the rest, once', async () => {
  const r = await rig();
  await joined(r);
  await r.send('invoice.paid', fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', start: T0 + 31 * DAY, end: T0 + 61 * DAY }));
  const charge = { id: 'ch_in_2', object: 'charge', payment_intent: 'pi_in_2', amount: 2000, amount_refunded: 1000 };
  await r.send('charge.refunded', charge);
  assert.equal(r.balance(), 3000);
  await r.send('charge.refunded', charge); // same state again
  assert.equal(r.balance(), 3000);
  await r.send('charge.refunded', { ...charge, amount_refunded: 2000 });
  assert.equal(r.balance(), 2000);
  const rev = r.ledger().filter((x) => x.kind === 'refund_reversal');
  assert.deepEqual(rev.map((x) => [x.amount_cents, x.memo]), [[-1000, 'Reversed — refund'], [-1000, 'Reversed — refund']]);
});

test('T2-R2: a refund of a charge the map has not seen yet is found through Stripe', async () => {
  const r = await rig();
  await joined(r);
  r.t.env.DB._db.prepare('DELETE FROM stripe_payments').run();
  await r.send('charge.refunded', { id: 'ch_x', object: 'charge', payment_intent: 'pi_in_1', amount: 5000, amount_refunded: 5000 });
  assert.equal(r.balance(), 0);
});

test('T2-R3: a dispute freezes credits, reverses the invoice credits, pauses the price and tells Felix; won → restored', async () => {
  const r = await rig();
  const calls = [];
  memberPriceHooks.grant = async (svc, uid) => calls.push(['grant', uid]);
  memberPriceHooks.revoke = async (svc, uid, why) => calls.push(['revoke', uid, why]);
  try {
    await joined(r);
    const dp = { id: 'dp_1', object: 'dispute', charge: 'ch_in_1', payment_intent: 'pi_in_1', amount: 5000, status: 'needs_response' };
    await r.send('charge.dispute.created', dp);
    assert.equal(r.balance(), 0);
    assert.equal(r.m().credits_frozen, 1);
    assert.deepEqual(calls.at(-1), ['revoke', r.userId, 'dispute']);
    const felix = r.t.rows("SELECT template FROM email_log WHERE template = 'admin_signal'");
    assert.equal(felix.length, 1);
    await r.send('charge.dispute.created', dp);
    assert.equal(r.balance(), 0, 'reversed once');
    await r.send('charge.dispute.closed', { ...dp, status: 'won' });
    assert.equal(r.balance(), 2000);
    assert.equal(r.m().credits_frozen, 0);
    assert.deepEqual(calls.at(-1), ['grant', r.userId]);
  } finally {
    memberPriceHooks.grant = null;
    memberPriceHooks.revoke = null;
  }
});

test('T2-R4: a lost dispute keeps the credits reversed and frozen', async () => {
  const r = await rig();
  await joined(r);
  const dp = { id: 'dp_2', object: 'dispute', charge: 'ch_in_1', payment_intent: 'pi_in_1', amount: 5000 };
  await r.send('charge.dispute.created', dp);
  await r.send('charge.dispute.closed', { ...dp, status: 'lost' });
  assert.equal(r.balance(), 0);
  assert.equal(r.m().credits_frozen, 1);
});

test('T2-L1: the full lifecycle on a test clock: join → renew → fail → recover → cancel → end', async () => {
  const r = await rig();
  await joined(r);
  await r.send('invoice.paid', fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', start: T0 + 31 * DAY, end: T0 + 61 * DAY }));
  await r.send('invoice.payment_failed', fx.invoice({ id: 'in_3', userId: r.userId, reason: 'subscription_cycle', status: 'open', start: T0 + 61 * DAY, end: T0 + 92 * DAY, next: 1 }));
  assert.equal(r.m().status, 'past_due');
  await r.send('invoice.paid', fx.invoice({ id: 'in_3', userId: r.userId, reason: 'subscription_cycle', start: T0 + 61 * DAY, end: T0 + 92 * DAY }));
  assert.equal(r.m().status, 'active');
  await r.send('customer.subscription.updated', fx.subscription({ userId: r.userId, cancelAtPeriodEnd: true, start: T0 + 61 * DAY, end: T0 + 92 * DAY }));
  await r.send('customer.subscription.deleted', fx.subscription({ userId: r.userId, status: 'canceled', reason: 'cancellation_requested', endedAt: T0 + 92 * DAY }));
  const m = r.m();
  assert.equal(m.status, 'ended');
  assert.equal(m.paid_invoices, 3);
  assert.equal(r.balance(), 6000);
  assert.equal(m.credits_grace_until, new Date(T0 + 122 * DAY).toISOString());
});

test('T2-F5: a failure while canceling, then payment → back to canceling, not active', async () => {
  const r = await rig();
  await joined(r);
  await r.send('customer.subscription.updated', fx.subscription({ userId: r.userId, cancelAtPeriodEnd: true }));
  await r.send('invoice.payment_failed', fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', status: 'open', next: 1 }));
  assert.equal(r.m().status, 'past_due');
  await r.send('invoice.paid', fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', start: T0 + 31 * DAY, end: T0 + 61 * DAY }));
  assert.equal(r.m().status, 'canceling');
});

test('T2-J8: only the first invoice and renewals accrue; other paid invoices (e.g. a manual one) add no credits', async () => {
  const r = await rig();
  await joined(r);
  await r.send('invoice.paid', fx.invoice({ id: 'in_m', userId: r.userId, reason: 'manual', start: T0 + 5 * DAY, end: T0 + 5 * DAY }));
  await r.send('invoice.paid', fx.invoice({ id: 'in_u', userId: r.userId, reason: 'subscription_update', start: T0 + 6 * DAY, end: T0 + 31 * DAY }));
  assert.equal(r.balance(), 2000);
});
