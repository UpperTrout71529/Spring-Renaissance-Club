// V2 T16: the anniversary gift (docs/tz-v2-circle.md §10; Felix §19 #5).
// Reached when the renewal that opens month 13 (25, …) is paid. A payment
// that failed and was then paid within the retries does NOT reset the count;
// only the end of the subscription does (a rejoin starts from zero). One gift
// per anniversary even if events repeat; budget 0 → no gift, the admin says why.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post } from './harness.mjs';
import { trusted, signIn, body, T0, DAY } from './api-helpers.mjs';
import { v2Rig, makeV2World, stripeBasics, STRIPE_ENV, stripeEvent, deliver, fx, stripePayments, CIRCLE_WHSEC, catalogProduct, serveCatalog } from './v2-helpers.mjs';

const V = (n) => `gid://shopify/ProductVariant/${n}`;
const CATALOG = [
  catalogProduct({ id: 1, handle: 'vase-a', variants: [{ id: 11, price: '40.00' }] }),
  catalogProduct({ id: 3, handle: 'small-candle', tags: ['catalog'], variants: [{ id: 31, price: '24.00' }] }),
];

async function rig({ costs = true, pool = true } = {}) {
  const world = stripePayments(stripeBasics(makeV2World({ shopifyCustomers: [{ id: 'gid://shopify/Customer/7', email: 'clara@example.com' }] })));
  serveCatalog(world, CATALOG, 10);
  world.drafts = [];
  world.shopifyOps.CircleDraftCreate = ({ input }) => {
    const d = { id: `gid://shopify/DraftOrder/${world.drafts.length + 1}`, input, status: 'OPEN' };
    world.drafts.push(d);
    return { draftOrderCreate: { draftOrder: { id: d.id, invoiceUrl: 'x', status: 'OPEN', order: null }, userErrors: [] } };
  };
  world.shopifyOps.CircleDraftComplete = ({ id }) => ({ draftOrderComplete: { draftOrder: { id, status: 'COMPLETED', order: { id: 'gid://shopify/Order/88' } }, userErrors: [] } });
  const r = await v2Rig({ world, envOverrides: { ...STRIPE_ENV, STRIPE_CIRCLE_WEBHOOK_SECRET: CIRCLE_WHSEC } });
  await r.adminSend('POST', '/api/admin/catalog/sync', {});
  await r.adminSend('PUT', '/api/admin/economics', { changes: { shipping: { S: { cents: 500, estimate: false } } } });
  if (costs) {
    await r.adminSend('PUT', '/api/admin/costs', { variant_gid: V(11), cost_cents: 1200, shipping_class: 'S' });
    await r.adminSend('PUT', '/api/admin/costs', { variant_gid: V(31), cost_cents: 720, shipping_class: 'S' });
  }
  if (pool) {
    await r.adminSend('POST', '/api/admin/gift-options', { kind: 'anniversary', title: 'Anniversary candle', shopify_variant_gid: V(31), landed_cost_cents: 800, shipping_class: 'S', active: true });
  }
  const s = await signIn(r.t, 'clara@example.com');
  const userId = r.t.rows("SELECT id FROM users WHERE email = 'clara@example.com'")[0].id;
  const send = (type, obj) => deliver(r.t, stripeEvent(type, obj));
  const paid = (i, { sub = 'sub_1', kind = 'join' } = {}) => send('invoice.paid', fx.invoice({
    id: `in_${sub}_${i}`, sub, userId, kind, reason: i === 1 ? 'subscription_create' : 'subscription_cycle',
    start: T0 + (i - 1) * 31 * DAY, end: T0 + i * 31 * DAY }));
  const api = async (method, path, payload) => {
    const res = await r.t.call(method === 'GET' ? get(path, { ...trusted, Cookie: s.cookie }) : post(path, payload ?? {}, { ...trusted, Cookie: s.cookie }));
    return { res, data: await body(res) };
  };
  const gifts = () => r.t.rows('SELECT n, status, budget_cents, reason FROM anniversary_gifts ORDER BY n').map((x) => ({ ...x }));
  return { ...r, userId, send, paid, api, gifts };
}

async function months(r, from, to, opts) {
  for (let i = from; i <= to; i++) await r.paid(i, opts);
}

test('T16-1: twelve paid months are not yet an anniversary; the renewal that opens month 13 is', async () => {
  const r = await rig();
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  await months(r, 1, 12);
  assert.deepEqual(r.gifts(), []);
  await r.paid(13);
  assert.deepEqual(r.gifts().map((g) => [g.n, g.status]), [[1, 'awaiting_address']]);
  assert.ok(r.world.emails.some((e) => e.subject === 'A year in the Circle'));
});

test('T16-2: 24 months → a second gift; repeated events never make a second gift for the same year', async () => {
  const r = await rig();
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  await months(r, 1, 25);
  await r.paid(13);
  await r.paid(25);
  assert.deepEqual(r.gifts().map((g) => g.n), [1, 2]);
});

test('T16-3: a failure recovered within the retries does not reset the count (Felix §19 #5)', async () => {
  const r = await rig();
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  await months(r, 1, 6);
  await r.send('invoice.payment_failed', fx.invoice({ id: 'in_sub_1_7', userId: r.userId, reason: 'subscription_cycle', status: 'open', next: 1, start: T0 + 6 * 31 * DAY, end: T0 + 7 * 31 * DAY }));
  await months(r, 7, 13);
  assert.deepEqual(r.gifts().map((g) => g.n), [1]);
});

test('T16-4: the end of the subscription resets: a rejoin counts from zero', async () => {
  const r = await rig();
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  await months(r, 1, 10);
  await r.send('customer.subscription.deleted', fx.subscription({ userId: r.userId, status: 'canceled', endedAt: T0 + 10 * 31 * DAY }));
  await r.send('checkout.session.completed', fx.session({ userId: r.userId, sub: 'sub_2', id: 'cs_2', kind: 'rejoin' }));
  for (let i = 1; i <= 12; i++) await r.paid(i, { sub: 'sub_2', kind: 'rejoin' });
  assert.deepEqual(r.gifts(), []);
  await r.paid(13, { sub: 'sub_2', kind: 'rejoin' });
  assert.deepEqual(r.gifts().map((g) => g.n), [1]);
});

test('T16-5: without cost data (budget 0) no gift is promised; the admin queue says why', async () => {
  const r = await rig({ costs: false });
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  await months(r, 1, 13);
  assert.deepEqual(r.gifts().map((g) => [g.status, g.reason]), [['skipped_budget', 'budget_zero']]);
  assert.ok(!r.world.emails.some((e) => e.subject === 'A year in the Circle'));
  const q = (await r.admin('/api/admin/gift-queue')).data.anniversary;
  assert.equal(q[0].status, 'skipped_budget');
  assert.equal(q[0].reason, 'budget_zero');
});

test('T16-6: an option over the budget is not offered; with no option within budget the gift is skipped', async () => {
  const r = await rig({ pool: false });
  await r.adminSend('POST', '/api/admin/gift-options', { kind: 'anniversary', title: 'Too dear', shopify_variant_gid: V(11), landed_cost_cents: 5000, shipping_class: 'S', active: true });
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  await months(r, 1, 13);
  assert.deepEqual(r.gifts().map((g) => [g.status, g.reason]), [['skipped_budget', 'no_option_within_budget']]);
});

test('T16-7: the member confirms a US address, Felix sends a $0 order tagged circle-anniversary', async () => {
  const r = await rig();
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  await months(r, 1, 13);
  let view = await r.api('GET', '/api/circle/anniversary');
  assert.equal(view.data.gift.status, 'awaiting_address');
  assert.equal(view.data.gift.address.postal_code, '78701', 'prefilled from the joining address');
  const bad = await r.api('POST', '/api/circle/anniversary', { address: { name: 'Clara Moss', line1: '1 Rue', city: 'Paris', state: 'XX', postal_code: '75001', country: 'FR' } });
  assert.equal(bad.res.status, 400);
  const ok = await r.api('POST', '/api/circle/anniversary', { address: { name: 'Clara Moss', line1: '2 Oak St', city: 'Austin', state: 'TX', postal_code: '78702', country: 'US' } });
  assert.equal(ok.res.status, 200);
  assert.equal(r.gifts()[0].status, 'ready');
  const q = (await r.admin('/api/admin/gift-queue')).data.anniversary;
  const out = await r.adminSend('POST', `/api/admin/anniversary/${q[0].id}/create-order`, {});
  assert.equal(out.res.status, 200, JSON.stringify(out.data));
  const d = r.world.drafts[0].input;
  assert.deepEqual(d.tags, ['circle-anniversary']);
  assert.equal(d.shippingAddress.zip, '78702');
  assert.deepEqual(d.lineItems[0].appliedDiscount, { valueType: 'PERCENTAGE', value: 100, title: 'Circle anniversary' });
  assert.equal(r.gifts()[0].status, 'order_created');
  view = await r.api('GET', '/api/circle/anniversary');
  assert.equal(view.data.gift.status, 'order_created');
});
