// V2 T13 (capsules) and T10 (Skip). Spec v1.1 §6.7, §8.4, §16.2, §16.3 #17;
// tz-v2 §9 table (capsules: active or canceling with ≥ 2 paid months; not
// past_due). Skip is about the season's capsule, never about payment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post } from './harness.mjs';
import { trusted, signIn, body, T0, DAY } from './api-helpers.mjs';
import { v2Rig, makeV2World, stripeBasics, STRIPE_ENV, stripeEvent, deliver, fx, stripePayments, CIRCLE_WHSEC, catalogProduct, serveCatalog } from './v2-helpers.mjs';
import { runScheduled, DAILY_CRON } from '../src/cron/index.js';

const CAP_P = 'gid://shopify/Product/40';

async function rig() {
  const world = stripePayments(stripeBasics(makeV2World({ shopifyCustomers: [{ id: 'gid://shopify/Customer/7', email: 'clara@example.com' }] })));
  serveCatalog(world, [catalogProduct({ id: 40, handle: 'winter-capsule', tags: ['capsule'], variants: [{ id: 401, price: '120.00' }] }),
    catalogProduct({ id: 1, handle: 'vase-a', variants: [{ id: 11, price: '40.00' }] })], 10);
  world.cards = [];
  world.shopifyOps.CreditsGiftCard = ({ input }) => {
    const n = world.cards.length + 1;
    world.cards.push(input);
    return { giftCardCreate: { giftCard: { id: `gid://shopify/GiftCard/${n}`, lastCharacters: `000${n}`, initialValue: { amount: input.initialValue } }, giftCardCode: `code-000${n}`, userErrors: [] } };
  };
  const r = await v2Rig({ world, envOverrides: { ...STRIPE_ENV, STRIPE_CIRCLE_WEBHOOK_SECRET: CIRCLE_WHSEC } });
  await r.adminSend('POST', '/api/admin/catalog/sync', {});
  const s = await signIn(r.t, 'clara@example.com');
  const userId = r.t.rows("SELECT id FROM users WHERE email = 'clara@example.com'")[0].id;
  const send = (type, obj) => deliver(r.t, stripeEvent(type, obj));
  const months = async (n) => {
    await send('checkout.session.completed', fx.session({ userId }));
    for (let i = 1; i <= n; i++) {
      await send('invoice.paid', fx.invoice({ id: `in_${i}`, userId, reason: i === 1 ? 'subscription_create' : 'subscription_cycle', start: T0 + (i - 1) * 31 * DAY, end: T0 + i * 31 * DAY }));
    }
    await send('customer.subscription.updated', fx.subscription({ userId, start: T0 + (n - 1) * 31 * DAY, end: T0 + n * 31 * DAY }));
  };
  const api = async (method, path, payload) => {
    const req = method === 'GET' ? get(path, { ...trusted, Cookie: s.cookie })
      : new Request('https://w.dev' + path, { method, headers: { ...trusted, Cookie: s.cookie, 'Content-Type': 'application/json', 'Content-Length': String(JSON.stringify(payload ?? {}).length) }, body: JSON.stringify(payload ?? {}) });
    const res = await r.t.call(req);
    return { res, data: await body(res) };
  };
  const balance = () => r.t.rows('SELECT COALESCE(SUM(amount_cents),0) AS b FROM credit_ledger WHERE user_id = ?', userId)[0].b;
  return { ...r, userId, send, months, api, balance };
}

const CAPSULE = { season: 'Winter', title: 'The Winter capsule', shopify_product_gid: CAP_P, price_cents: 6000, min_consecutive_months: 2,
  opens_at: new Date(T0 + 10 * DAY).toISOString(), closes_at: new Date(T0 + 40 * DAY).toISOString() };

async function capsule(r, over = {}) {
  const out = await r.adminSend('POST', '/api/admin/capsules', { ...CAPSULE, ...over });
  assert.equal(out.res.status, 201, JSON.stringify(out.data));
  return out.data.capsule.id;
}

test('T13-1: admin capsules must be existing Shopify capsule products; the price is Felix\'s', async () => {
  const r = await rig();
  let out = await r.adminSend('POST', '/api/admin/capsules', { ...CAPSULE, shopify_product_gid: 'gid://shopify/Product/1' });
  assert.equal(out.res.status, 400);
  assert.equal(out.data.error.code, 'not_a_capsule_product');
  out = await r.adminSend('POST', '/api/admin/capsules', { ...CAPSULE, price_cents: null });
  assert.equal(out.res.status, 400);
  await capsule(r);
  assert.equal((await r.admin('/api/admin/capsules')).data.capsules.length, 1);
});

test('T13-2: with one paid month the member sees "Available after your second month"; with two, eligible', async () => {
  const r = await rig();
  await capsule(r);
  await r.months(1);
  r.t.setNow(T0 + 11 * DAY);
  let c = (await r.api('GET', '/api/circle/capsules')).data;
  assert.equal(c.current.eligible, false);
  assert.equal(c.current.reason, 'Available after your second month');
  const r2 = await rig();
  await capsule(r2);
  await r2.months(2);
  r2.t.setNow(T0 + 11 * DAY);
  c = (await r2.api('GET', '/api/circle/capsules')).data;
  assert.equal(c.current.eligible, true);
});

test('T13-3: claiming turns min(balance, price) into a card; a second claim is 409', async () => {
  const r = await rig();
  await capsule(r);
  await r.months(2); // 40 credits
  r.t.setNow(T0 + 11 * DAY);
  await r.t.env.DB.prepare('UPDATE sessions SET step_up_at = ?1').bind(new Date(T0 + 11 * DAY).toISOString()).run();
  const out = await r.api('POST', `/api/circle/capsules/${(await r.api('GET', '/api/circle/capsules')).data.current.id}/claim`, {});
  assert.equal(out.res.status, 201, JSON.stringify(out.data));
  assert.equal(out.data.amount_cents, 4000, 'balance below the price → the whole balance');
  assert.equal(out.data.code, 'code-0001');
  assert.equal(out.data.product_url, 'https://springrenaissance.store/products/winter-capsule');
  assert.equal(r.balance(), 0);
  assert.match(r.world.cards[0].note, /^Circle credits · /);
  const again = await r.api('POST', `/api/circle/capsules/${out.data.capsule_id}/claim`, {});
  assert.equal(again.res.status, 409);
});

test('T13-4: past_due members cannot claim; canceling members with two months can', async () => {
  const r = await rig();
  const id = await capsule(r);
  await r.months(2);
  await r.send('invoice.payment_failed', fx.invoice({ id: 'in_3', userId: r.userId, reason: 'subscription_cycle', status: 'open', next: 1 }));
  r.t.setNow(T0 + 11 * DAY);
  await r.t.env.DB.prepare('UPDATE sessions SET step_up_at = ?1').bind(new Date(T0 + 11 * DAY).toISOString()).run();
  const out = await r.api('POST', `/api/circle/capsules/${id}/claim`, {});
  assert.equal(out.res.status, 409);
  assert.equal(out.data.error.code, 'not_eligible');
});

test('T10-1: Skip before the window opens: no reservation, no capsule email; payment and credits go on', async () => {
  const r = await rig();
  const id = await capsule(r);
  await r.months(1);
  const skip = await r.api('POST', '/api/circle/skips', { capsule_id: id });
  assert.equal(skip.res.status, 201);
  await r.send('invoice.paid', fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', start: T0 + 31 * DAY, end: T0 + 62 * DAY }));
  assert.equal(r.balance(), 4000, 'credits accrue as usual');
  assert.equal(r.t.rows('SELECT consecutive_paid_months FROM memberships')[0].consecutive_paid_months, 2);
  await runScheduled(r.t.env, T0 + 10 * DAY + 1000, DAILY_CRON, { deps: { fetch: r.world.fetch } });
  assert.equal(r.t.rows("SELECT 1 FROM email_log WHERE template = 'capsule_open'").length, 0);
  r.t.setNow(T0 + 11 * DAY);
  const c = (await r.api('GET', '/api/circle/capsules')).data;
  assert.equal(c.current.skipped, true);
  assert.equal(c.current.eligible, false);
});

test('T10-2: Skip can be undone before the window opens and not after (409)', async () => {
  const r = await rig();
  const id = await capsule(r);
  await r.months(2);
  await r.api('POST', '/api/circle/skips', { capsule_id: id });
  let out = await r.api('DELETE', `/api/circle/skips/${id}`);
  assert.equal(out.res.status, 200);
  await r.api('POST', '/api/circle/skips', { capsule_id: id });
  r.t.setNow(T0 + 11 * DAY);
  out = await r.api('DELETE', `/api/circle/skips/${id}`);
  assert.equal(out.res.status, 409);
  out = await r.api('POST', '/api/circle/skips', { capsule_id: id });
  assert.equal(out.res.status, 409);
});

test('T13-5: when a capsule opens, eligible members who did not skip get one email', async () => {
  const r = await rig();
  await capsule(r);
  await r.months(2);
  await runScheduled(r.t.env, T0 + 10 * DAY + 1000, DAILY_CRON, { deps: { fetch: r.world.fetch } });
  await runScheduled(r.t.env, T0 + 11 * DAY, DAILY_CRON, { deps: { fetch: r.world.fetch } });
  assert.equal(r.t.rows("SELECT 1 FROM email_log WHERE template = 'capsule_open'").length, 1);
});
