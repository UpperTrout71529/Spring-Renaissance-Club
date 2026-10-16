// V2 T11 (cancel, undo, keep), T9 (card updated → retry), the membership &
// billing page data, and T12 (deleting an account with a membership).
// Spec v1.1 §16.1, §16.3 #9/#12, §13.4; docs/tz-v2-circle.md §3.1, §5.1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post } from './harness.mjs';
import { trusted, signIn, body, T0, DAY } from './api-helpers.mjs';
import { v2Rig, makeV2World, stripeBasics, STRIPE_ENV, stripeEvent, deliver, fx, stripePayments, CIRCLE_WHSEC } from './v2-helpers.mjs';

async function rig(env = {}) {
  const world = stripePayments(stripeBasics(makeV2World({ shopifyCustomers: [{ id: 'gid://shopify/Customer/7', email: 'clara@example.com' }] })));
  world.subs = {};
  world.stripeOn('POST', '/v1/subscriptions/:id', (call, id) => {
    if (world.stripeDown) return Response.json({ error: { message: 'down' } }, { status: 500 });
    world.subs[id] = { ...(world.subs[id] || {}), cancel_at_period_end: call.params.cancel_at_period_end === 'true' };
    return { id, status: 'active', cancel_at_period_end: world.subs[id].cancel_at_period_end };
  });
  world.stripeOn('DELETE', '/v1/subscriptions/:id', (call, id) => {
    if (world.stripeDown) return Response.json({ error: { message: 'down' } }, { status: 500 });
    world.subs[id] = { canceled: true };
    return { id, status: 'canceled' };
  });
  world.stripeOn('POST', '/v1/invoices/create_preview', () => ({ amount_due: 2165, total: 2165, period_end: Math.floor((T0 + 31 * DAY) / 1000), next_payment_attempt: null }));
  world.stripeOn('POST', '/v1/billing_portal/sessions', (call) => ({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/test_1', return_url: call.params.return_url }));
  const r = await v2Rig({ world, envOverrides: { ...STRIPE_ENV, STRIPE_CIRCLE_WEBHOOK_SECRET: CIRCLE_WHSEC, ...env } });
  const s = await signIn(r.t, 'clara@example.com');
  const userId = r.t.rows("SELECT id FROM users WHERE email = 'clara@example.com'")[0].id;
  const send = (type, obj, opts) => deliver(r.t, stripeEvent(type, obj, opts));
  const api = async (method, path, payload) => {
    const req = method === 'GET' ? get(path, { ...trusted, Cookie: s.cookie })
      : new Request('https://w.dev' + path, { method, headers: { ...trusted, Cookie: s.cookie, 'Content-Type': 'application/json', 'Content-Length': String(JSON.stringify(payload ?? {}).length) }, body: JSON.stringify(payload ?? {}) });
    const res = await r.t.call(req);
    return { res, data: await body(res) };
  };
  const m = () => r.t.rows('SELECT * FROM memberships WHERE user_id = ?', userId)[0];
  const balance = () => r.t.rows('SELECT COALESCE(SUM(amount_cents),0) AS b FROM credit_ledger WHERE user_id = ?', userId)[0].b;
  return { ...r, userId, send, api, m, balance };
}

async function member(r) {
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  await r.send('invoice.paid', fx.invoice({ userId: r.userId }));
  await r.send('customer.subscription.updated', fx.subscription({ userId: r.userId }));
}

test('T11-1: start → one offer by reason, the dates and credits; nothing changes in Stripe yet', async () => {
  const r = await rig();
  await member(r);
  const cases = {
    spending_less: null,
    not_finding_pieces: 'concierge',
    too_many_credits: 'use_credits',
    order_issue: 'concierge_priority',
    plans_changed: null,
    other: null,
  };
  for (const [reason, kind] of Object.entries(cases)) {
    const out = await r.api('POST', '/api/circle/cancel/start', { reason, comment: reason === 'other' ? 'Moving abroad' : undefined });
    assert.equal(out.res.status, 201, reason);
    assert.equal(out.data.offer ? out.data.offer.kind : null, kind, reason);
    assert.equal(out.data.ends_on, new Date(T0 + 31 * DAY).toISOString().slice(0, 10));
    assert.equal(out.data.credits_until, new Date(T0 + 61 * DAY).toISOString().slice(0, 10));
    assert.equal(out.data.balance_cents, 2000);
  }
  const credits = await r.api('POST', '/api/circle/cancel/start', { reason: 'too_many_credits' });
  assert.equal(credits.data.offer.copy, 'You have 20 credits. They also work on Small Pleasures.');
  assert.equal(r.t.rows("SELECT 1 FROM cancellations WHERE outcome = 'abandoned'").length, 7);
  assert.equal(r.t.rows("SELECT comment FROM cancellations WHERE reason = 'other'")[0].comment, 'Moving abroad');
  assert.equal(Object.keys(r.world.subs).length, 0);
  const bad = await r.api('POST', '/api/circle/cancel/start', { reason: 'bored' });
  assert.equal(bad.res.status, 400);
});

test('T11-2: confirm → cancel at period end in Stripe, canceling, email once; undo → active again', async () => {
  const r = await rig();
  await member(r);
  const start = await r.api('POST', '/api/circle/cancel/start', { reason: 'spending_less' });
  const out = await r.api('POST', '/api/circle/cancel/confirm', { cancellation_id: start.data.cancellation_id });
  assert.equal(out.res.status, 200, JSON.stringify(out.data));
  assert.deepEqual(out.data, { ends_on: new Date(T0 + 31 * DAY).toISOString().slice(0, 10), credits_until: new Date(T0 + 61 * DAY).toISOString().slice(0, 10) });
  assert.equal(r.world.subs.sub_1.cancel_at_period_end, true);
  const call = r.world.stripeCalls.find((c) => c.method === 'POST' && c.path === '/v1/subscriptions/sub_1');
  assert.equal(call.headers['Idempotency-Key'], `circle-cancel:${start.data.cancellation_id}`);
  assert.equal(r.m().status, 'canceling');
  assert.equal(r.t.rows('SELECT outcome FROM cancellations WHERE id = ?', start.data.cancellation_id)[0].outcome, 'canceled');
  assert.equal(r.t.rows("SELECT 1 FROM email_log WHERE template = 'membership_canceled'").length, 1);
  // the webhook that follows does not send it again
  await r.send('customer.subscription.updated', fx.subscription({ userId: r.userId, cancelAtPeriodEnd: true }));
  await r.send('customer.subscription.deleted', fx.subscription({ userId: r.userId, status: 'canceled', endedAt: T0 + 31 * DAY }));
  assert.equal(r.t.rows("SELECT 1 FROM email_log WHERE template = 'membership_canceled'").length, 1);
});

test('T11-3: undo before the end puts the membership back to active', async () => {
  const r = await rig();
  await member(r);
  const start = await r.api('POST', '/api/circle/cancel/start', { reason: 'other' });
  await r.api('POST', '/api/circle/cancel/confirm', { cancellation_id: start.data.cancellation_id });
  const undo = await r.api('POST', '/api/circle/cancel/undo', {});
  assert.equal(undo.res.status, 200);
  assert.deepEqual(undo.data, { status: 'active' });
  assert.equal(r.world.subs.sub_1.cancel_at_period_end, false);
  assert.equal(r.m().status, 'active');
  assert.equal(r.m().cancel_requested_at, null);
  const again = await r.api('POST', '/api/circle/cancel/undo', {});
  assert.equal(again.res.status, 409);
});

test('T11-4: keep my membership records a save; confirming someone else\'s or a used cancellation is refused', async () => {
  const r = await rig();
  await member(r);
  const start = await r.api('POST', '/api/circle/cancel/start', { reason: 'not_finding_pieces' });
  const keep = await r.api('POST', '/api/circle/cancel/keep', { cancellation_id: start.data.cancellation_id, offer_accepted: true });
  assert.equal(keep.res.status, 200);
  const row = r.t.rows('SELECT outcome, offer_accepted, offer_shown FROM cancellations WHERE id = ?', start.data.cancellation_id)[0];
  assert.deepEqual([row.outcome, row.offer_accepted, row.offer_shown], ['saved', 1, 'concierge']);
  const reuse = await r.api('POST', '/api/circle/cancel/confirm', { cancellation_id: start.data.cancellation_id });
  assert.equal(reuse.res.status, 409);
  const unknown = await r.api('POST', '/api/circle/cancel/confirm', { cancellation_id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' });
  assert.equal(unknown.res.status, 404);
});

test('T11-5: cancelling while past_due ends the subscription now (§16.3 #9); credits until last paid end + 30', async () => {
  const r = await rig();
  await member(r);
  await r.send('invoice.payment_failed', fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', status: 'open', next: 1, start: T0 + 31 * DAY, end: T0 + 61 * DAY }));
  const start = await r.api('POST', '/api/circle/cancel/start', { reason: 'spending_less' });
  assert.equal(start.data.ends_on, new Date(T0).toISOString().slice(0, 10));
  assert.equal(start.data.credits_until, new Date(T0 + 61 * DAY).toISOString().slice(0, 10));
  const out = await r.api('POST', '/api/circle/cancel/confirm', { cancellation_id: start.data.cancellation_id });
  assert.equal(out.res.status, 200);
  assert.equal(r.world.subs.sub_1.canceled, true);
});

test('T11-6: Stripe down → 503, nothing marked as cancelled', async () => {
  const r = await rig();
  await member(r);
  const start = await r.api('POST', '/api/circle/cancel/start', { reason: 'spending_less' });
  r.world.stripeDown = true;
  const out = await r.api('POST', '/api/circle/cancel/confirm', { cancellation_id: start.data.cancellation_id });
  assert.equal(out.res.status, 503);
  assert.equal(r.m().status, 'active');
  assert.equal(r.t.rows('SELECT outcome FROM cancellations WHERE id = ?', start.data.cancellation_id)[0].outcome, 'abandoned');
});

test('T11-7: non-members and ended members cannot start a cancellation; canceling members are told so', async () => {
  const r = await rig();
  let out = await r.api('POST', '/api/circle/cancel/start', { reason: 'other' });
  assert.equal(out.res.status, 403);
  await member(r);
  await r.send('customer.subscription.updated', fx.subscription({ userId: r.userId, cancelAtPeriodEnd: true }));
  out = await r.api('POST', '/api/circle/cancel/start', { reason: 'other' });
  assert.equal(out.res.status, 409);
  assert.equal(out.data.error.code, 'already_canceling');
});

// ---- T9: "I've updated my card" ------------------------------------------------------

test('T9-1: the retry button pays the open invoice of a past_due membership', async () => {
  const r = await rig();
  await member(r);
  await r.send('invoice.payment_failed', fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', status: 'open', next: 1 }));
  let paid = 0;
  r.world.stripeOn('POST', '/v1/invoices/:id/pay', (call, id) => { paid++; return { id, status: 'paid' }; });
  const out = await r.api('POST', '/api/circle/billing/retry', {});
  assert.equal(out.res.status, 200);
  assert.equal(out.data.result, 'paid');
  assert.equal(paid, 1);
  r.world.stripeOn('POST', '/v1/invoices/:id/pay', () => Response.json({ error: { code: 'card_declined', message: 'declined' } }, { status: 402 }));
  const declined = await r.api('POST', '/api/circle/billing/retry', {});
  assert.equal(declined.data.result, 'declined');
});

// ---- membership & billing -----------------------------------------------------------------

test('T11-8: membership & billing: plan, next charge from Stripe (with tax), invoices, portal link', async () => {
  const r = await rig();
  await member(r);
  const out = await r.api('GET', '/api/account/membership');
  assert.equal(out.res.status, 200);
  assert.equal(out.data.status, 'active');
  assert.equal(out.data.monthly_cents, 2000);
  assert.deepEqual(out.data.next_charge, { date: new Date(T0 + 31 * DAY).toISOString().slice(0, 10), amount_cents: 2165 });
  assert.deepEqual(out.data.invoices.map((i) => [i.amount_paid_cents, i.status, i.url]), [[5000, 'paid', 'https://invoice.stripe.com/i/in_1']]);
  const portal = await r.api('POST', '/api/account/membership/portal', {});
  assert.equal(portal.data.url, 'https://billing.stripe.com/p/session/test_1');
  const call = r.world.stripeCalls.find((c) => c.path === '/v1/billing_portal/sessions');
  assert.equal(call.params.customer, 'cus_1');
  assert.equal(call.params.return_url, 'https://club.springrenaissance.store/account/membership');
});

// ---- T12: deleting an account with a membership ---------------------------------------------

test('T12-1: deleting with a live membership cancels in Stripe first, then expires credits and closes the welcome piece', async () => {
  const r = await rig();
  await member(r);
  await r.t.env.DB.prepare('UPDATE sessions SET step_up_at = ?1').bind(new Date(T0).toISOString()).run();
  const out = await r.api('DELETE', '/api/account', { confirm: 'DELETE' });
  assert.equal(out.res.status, 202, JSON.stringify(out.data));
  assert.equal(r.world.subs.sub_1.canceled, true);
  const m = r.m();
  assert.deepEqual([m.status, m.end_reason], ['ended_expired', 'account_deleted']);
  assert.equal(r.balance(), 0);
  const g = r.t.rows('SELECT status, shipping_json FROM gift_selections')[0];
  assert.deepEqual([g.status, g.shipping_json], ['canceled', null]);
  // the webhook that follows keeps the reason
  await r.send('customer.subscription.deleted', fx.subscription({ userId: r.userId, status: 'canceled', endedAt: T0 }));
  assert.equal(r.m().end_reason, 'account_deleted');
  assert.equal(r.t.rows("SELECT 1 FROM email_log WHERE template = 'membership_canceled'").length, 0);
});

test('T12-2: if Stripe cannot cancel, the account is not deleted (fail closed)', async () => {
  const r = await rig();
  await member(r);
  await r.t.env.DB.prepare('UPDATE sessions SET step_up_at = ?1').bind(new Date(T0).toISOString()).run();
  r.world.stripeDown = true;
  const out = await r.api('DELETE', '/api/account', { confirm: 'DELETE' });
  assert.equal(out.res.status, 503);
  assert.equal(r.t.rows('SELECT deleted_at FROM users WHERE id = ?', r.userId)[0].deleted_at, null);
  assert.equal(r.m().status, 'active');
  assert.equal(r.balance(), 2000);
});
