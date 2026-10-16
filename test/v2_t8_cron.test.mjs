// V2 T8: Circle cron jobs (spec v1.1 §9.1.5, §9.4, §11, §16.3 #15/#16/#19;
// docs/tz-v2-circle.md §6.1 missed webhooks, §15). Re-running a job never
// sends twice or writes twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signIn, T0, DAY, HOUR } from './api-helpers.mjs';
import { v2Rig, makeV2World, stripeBasics, STRIPE_ENV, stripeEvent, deliver, fx, stripePayments, CIRCLE_WHSEC } from './v2-helpers.mjs';
import { runScheduled, FREQUENT_CRON, DAILY_CRON } from '../src/cron/index.js';

async function rig() {
  const world = stripePayments(stripeBasics(makeV2World({ shopifyCustomers: [{ id: 'gid://shopify/Customer/7', email: 'clara@example.com' }] })));
  world.previews = 0;
  world.stripeOn('POST', '/v1/invoices/create_preview', () => { world.previews++; return { amount_due: 2165 }; });
  const r = await v2Rig({ world, envOverrides: { ...STRIPE_ENV, STRIPE_CIRCLE_WEBHOOK_SECRET: CIRCLE_WHSEC } });
  await signIn(r.t, 'clara@example.com');
  const userId = r.t.rows("SELECT id FROM users WHERE email = 'clara@example.com'")[0].id;
  const send = (type, obj, opts) => deliver(r.t, stripeEvent(type, obj, opts));
  const cron = (ms, which) => runScheduled(r.t.env, ms, which, { deps: { fetch: world.fetch } });
  const emails = (template) => r.t.rows('SELECT dedupe_key FROM email_log WHERE template = ?', template).map((x) => x.dedupe_key);
  const balance = () => r.t.rows('SELECT COALESCE(SUM(amount_cents),0) AS b FROM credit_ledger WHERE user_id = ?', userId)[0].b;
  const m = () => r.t.rows('SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at', userId);
  return { ...r, userId, send, cron, emails, balance, m };
}

async function member(r) {
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  await r.send('invoice.paid', fx.invoice({ userId: r.userId }));
  await r.send('customer.subscription.updated', fx.subscription({ userId: r.userId }));
}

test('T8-1: the renewal reminder goes 72 hours before each charge, once, with Stripe\'s amount (tax included)', async () => {
  const r = await rig();
  await member(r);
  const charge = T0 + 31 * DAY;
  await r.cron(charge - 80 * HOUR, FREQUENT_CRON);
  assert.equal(r.emails('renewal_reminder').length, 0, 'too early');
  await r.cron(charge - 72 * HOUR, FREQUENT_CRON);
  await r.cron(charge - 72 * HOUR + 5 * 60000, FREQUENT_CRON);
  await r.cron(charge - 71 * HOUR, FREQUENT_CRON);
  const keys = r.emails('renewal_reminder');
  assert.deepEqual(keys, [`renewal_reminder:sub_1:${new Date(charge).toISOString().slice(0, 10)}`]);
  const mail = r.world.emails.find((e) => e.subject.startsWith('Your membership renews on'));
  assert.match(mail.text, /\$21\.65/);
  assert.match(mail.text, /account\/membership/);
});

test('T8-2: no reminder for a membership that is set to end', async () => {
  const r = await rig();
  await member(r);
  await r.send('customer.subscription.updated', fx.subscription({ userId: r.userId, cancelAtPeriodEnd: true }));
  await r.cron(T0 + 31 * DAY - 72 * HOUR, FREQUENT_CRON);
  assert.equal(r.emails('renewal_reminder').length, 0);
});

test('T8-3: credits expire only when the grace date has passed; the balance goes to zero once', async () => {
  const r = await rig();
  await member(r);
  await r.send('customer.subscription.deleted', fx.subscription({ userId: r.userId, status: 'canceled', endedAt: T0 + 31 * DAY }));
  const grace = T0 + 61 * DAY;
  await r.cron(grace - HOUR, DAILY_CRON);
  assert.equal(r.balance(), 2000);
  assert.equal(r.m()[0].status, 'ended');
  await r.cron(grace + HOUR, DAILY_CRON);
  await r.cron(grace + DAY, DAILY_CRON);
  assert.equal(r.balance(), 0);
  assert.equal(r.m()[0].status, 'ended_expired');
  const exp = r.t.rows("SELECT amount_cents, memo FROM credit_ledger WHERE kind = 'expiry'");
  assert.deepEqual(exp.map((x) => [x.amount_cents, x.memo]), [[-2000, 'Expired after membership ended']]);
  assert.equal(r.t.rows("SELECT 1 FROM events WHERE name = 'credits_expired'").length, 1);
});

test('T8-4: rejoining inside the grace keeps the credits (§16.3 #15)', async () => {
  const r = await rig();
  await member(r);
  await r.send('customer.subscription.deleted', fx.subscription({ userId: r.userId, status: 'canceled', endedAt: T0 + 31 * DAY }));
  await r.send('checkout.session.completed', fx.session({ userId: r.userId, sub: 'sub_2', id: 'cs_2', kind: 'rejoin' }));
  await r.send('invoice.paid', fx.invoice({ id: 'in_r', sub: 'sub_2', userId: r.userId, kind: 'rejoin', start: T0 + 40 * DAY, end: T0 + 71 * DAY }));
  await r.cron(T0 + 62 * DAY, DAILY_CRON);
  assert.equal(r.balance(), 4000);
  assert.equal(r.m()[0].status, 'ended_expired');
  assert.equal(r.m()[1].status, 'active');
});

test('T8-5: "credits expiring" 7 days and 1 day before, only with a balance', async () => {
  const r = await rig();
  await member(r);
  await r.send('customer.subscription.deleted', fx.subscription({ userId: r.userId, status: 'canceled', endedAt: T0 + 31 * DAY }));
  const grace = T0 + 61 * DAY;
  await r.cron(grace - 8 * DAY, DAILY_CRON);
  assert.equal(r.emails('credits_expiring').length, 0);
  await r.cron(grace - 7 * DAY + HOUR, DAILY_CRON);
  await r.cron(grace - 6 * DAY, DAILY_CRON);
  assert.equal(r.emails('credits_expiring').length, 1);
  await r.cron(grace - 20 * HOUR, DAILY_CRON);
  assert.equal(r.emails('credits_expiring').length, 2);
});

test('T8-6: one reminder about the welcome piece on day 3, only while it waits', async () => {
  const r = await rig();
  await member(r);
  await r.cron(T0 + 2 * DAY, DAILY_CRON);
  assert.equal(r.emails('welcome_piece_reminder').length, 0);
  await r.cron(T0 + 3 * DAY, DAILY_CRON);
  await r.cron(T0 + 4 * DAY, DAILY_CRON);
  assert.equal(r.emails('welcome_piece_reminder').length, 1);
});

test('T8-7: the Stripe reconcile replays a missed cancellation and a missed renewal', async () => {
  const r = await rig();
  await member(r);
  r.world.stripeOn('GET', '/v1/subscriptions/:id', (call, id) => fx.subscription({ id, userId: r.userId, cancelAtPeriodEnd: true, start: T0 + 31 * DAY, end: T0 + 61 * DAY }));
  r.world.stripeOn('GET', '/v1/invoices', () => ({ data: [
    fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', start: T0 + 31 * DAY, end: T0 + 61 * DAY }),
    fx.invoice({ id: 'in_1', userId: r.userId }),
  ] }));
  await r.cron(T0 + 32 * DAY, FREQUENT_CRON);
  const m = r.m()[0];
  assert.equal(m.status, 'canceling');
  assert.equal(r.balance(), 4000);
  await r.cron(T0 + 32 * DAY + 5 * 60000, FREQUENT_CRON);
  assert.equal(r.balance(), 4000, 'replaying again changes nothing');
});
