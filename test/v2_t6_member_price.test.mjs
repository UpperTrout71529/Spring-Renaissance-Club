// V2 T6: the member price in Shopify (docs/tz-v2-circle.md §7): one automatic
// "Circle price" discount (sharded) limited to members' Shopify customers and
// to the D1-computed eligible variants; grant/revoke on state changes; a
// reconcile that repairs drift; the storefront line; the order audit.
// Nothing runs against Shopify unless CIRCLE_PRICE_SYNC=on (after the spike).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from './harness.mjs';
import { trusted, signIn, body, T0, DAY } from './api-helpers.mjs';
import { v2Rig, makeV2World, stripeBasics, STRIPE_ENV, stripeEvent, deliver, fx, stripePayments, CIRCLE_WHSEC, catalogProduct, serveCatalog } from './v2-helpers.mjs';
import { runScheduled, FREQUENT_CRON } from '../src/cron/index.js';

const V = (n) => `gid://shopify/ProductVariant/${n}`;
const P = (n) => `gid://shopify/Product/${n}`;
const CATALOG = [
  catalogProduct({ id: 1, handle: 'vase-a', variants: [{ id: 11, price: '40.00' }, { id: 12, price: '68.00', title: 'Large' }] }),
  catalogProduct({ id: 3, handle: 'small-candle', tags: ['catalog'], variants: [{ id: 31, price: '24.00' }] }),
];

// A Shopify discount store that enforces the safety invariant.
function discountStore(world) {
  world.discounts = [];
  const find = (id) => world.discounts.find((d) => d.id === id);
  const check = (d) => {
    if (d.status === 'ACTIVE' && d.customers.length === 0) throw new Error('INVARIANT: active Circle price with no customers');
  };
  world.shopifyOps.CirclePriceCreate = ({ input }) => {
    const d = { id: `gid://shopify/DiscountAutomaticNode/${world.discounts.length + 1}`, title: input.title, status: 'ACTIVE',
      percentage: input.customerGets.value.percentage, combinesWith: input.combinesWith,
      customers: [...input.context.customers.add], variants: [...input.customerGets.items.products.productVariantsToAdd] };
    check(d);
    world.discounts.push(d);
    return { discountAutomaticBasicCreate: { automaticDiscountNode: { id: d.id }, userErrors: [] } };
  };
  world.shopifyOps.CirclePriceUpdate = ({ id, input }) => {
    const d = find(id);
    const c = (input.context && input.context.customers) || {};
    d.customers = [...d.customers.filter((x) => !(c.remove || []).includes(x)), ...(c.add || []).filter((x) => !d.customers.includes(x))];
    const p = (input.customerGets && input.customerGets.items && input.customerGets.items.products) || {};
    d.variants = [...d.variants.filter((x) => !(p.productVariantsToRemove || []).includes(x)), ...(p.productVariantsToAdd || []).filter((x) => !d.variants.includes(x))];
    check(d);
    return { discountAutomaticBasicUpdate: { automaticDiscountNode: { id }, userErrors: [] } };
  };
  world.shopifyOps.CirclePriceRead = ({ id }) => {
    const d = find(id);
    return { discountNode: d ? { id, discount: { status: d.status, context: { customers: d.customers.map((x) => ({ id: x })) },
      customerGets: { items: { productVariants: { nodes: d.variants.map((x) => ({ id: x })) } } } } } : null };
  };
  world.shopifyOps.CirclePriceActivate = ({ id }) => { const d = find(id); d.status = 'ACTIVE'; check(d); return { discountAutomaticActivate: { automaticDiscountNode: { id }, userErrors: [] } }; };
  world.shopifyOps.CirclePriceDeactivate = ({ id }) => { find(id).status = 'EXPIRED'; return { discountAutomaticDeactivate: { automaticDiscountNode: { id }, userErrors: [] } }; };
}

async function rig(env = {}) {
  const world = stripePayments(stripeBasics(makeV2World({ shopifyCustomers: [
    { id: 'gid://shopify/Customer/7', email: 'clara@example.com' }, { id: 'gid://shopify/Customer/8', email: 'david@example.com' }] })));
  serveCatalog(world, CATALOG, 10);
  discountStore(world);
  const r = await v2Rig({ world, envOverrides: { ...STRIPE_ENV, STRIPE_CIRCLE_WEBHOOK_SECRET: CIRCLE_WHSEC, CIRCLE_PRICE_SYNC: 'on', ...env } });
  await r.adminSend('POST', '/api/admin/catalog/sync', {});
  await r.adminSend('PUT', '/api/admin/economics', { changes: { shipping: { S: { cents: 0, estimate: false } } } });
  await r.adminSend('PUT', '/api/admin/costs', { variant_gid: V(11), cost_cents: 1000, shipping_class: 'S' });
  await r.adminSend('PUT', '/api/admin/circle-price/list', { product_gid: P(1), on_list: true });
  const clara = await signIn(r.t, 'clara@example.com');
  const david = await signIn(r.t, 'david@example.com');
  const id = (e) => r.t.rows('SELECT id FROM users WHERE email = ?', e)[0].id;
  const send = (type, obj, opts) => deliver(r.t, stripeEvent(type, obj, opts));
  const join = async (email, n) => {
    const u = id(email);
    await send('checkout.session.completed', fx.session({ userId: u, sub: `sub_${n}`, customer: `cus_${n}`, id: `cs_${n}` }));
    await send('invoice.paid', fx.invoice({ id: `in_${n}`, sub: `sub_${n}`, customer: `cus_${n}`, userId: u }));
    await send('customer.subscription.updated', fx.subscription({ id: `sub_${n}`, customer: `cus_${n}`, userId: u }));
  };
  const cron = (ms) => runScheduled(r.t.env, ms, FREQUENT_CRON, { deps: { fetch: world.fetch } });
  return { ...r, clara, david, id, send, join, cron };
}

test('T6-1: a new member is granted: one Circle price discount, 25%, members only, eligible variants only, no stacking', async () => {
  const r = await rig();
  await r.join('clara@example.com', 1);
  assert.equal(r.world.discounts.length, 1);
  const d = r.world.discounts[0];
  assert.equal(d.title, 'Circle price');
  assert.equal(d.percentage, 0.25);
  assert.deepEqual(d.customers, ['gid://shopify/Customer/7']);
  assert.deepEqual(d.variants, [V(11)], 'V12 fails rule 2 (no cost), the candle is Small Pleasures');
  assert.deepEqual(d.combinesWith, { productDiscounts: false, orderDiscounts: false, shippingDiscounts: true });
  assert.equal(r.t.rows('SELECT 1 FROM circle_price_grants WHERE revoked_at IS NULL').length, 1);
});

test('T6-2: past_due and the end of a membership revoke; recovery grants again; the last member out deactivates', async () => {
  const r = await rig();
  await r.join('clara@example.com', 1);
  await r.join('david@example.com', 2);
  assert.deepEqual(r.world.discounts[0].customers.sort(), ['gid://shopify/Customer/7', 'gid://shopify/Customer/8']);
  await r.send('invoice.payment_failed', fx.invoice({ id: 'in_x', sub: 'sub_1', customer: 'cus_1', userId: r.id('clara@example.com'), reason: 'subscription_cycle', status: 'open', next: 1 }));
  assert.deepEqual(r.world.discounts[0].customers, ['gid://shopify/Customer/8']);
  await r.send('invoice.paid', fx.invoice({ id: 'in_x', sub: 'sub_1', customer: 'cus_1', userId: r.id('clara@example.com'), reason: 'subscription_cycle', start: T0 + 31 * DAY, end: T0 + 61 * DAY }));
  assert.deepEqual(r.world.discounts[0].customers.sort(), ['gid://shopify/Customer/7', 'gid://shopify/Customer/8']);
  await r.send('customer.subscription.deleted', fx.subscription({ id: 'sub_2', customer: 'cus_2', userId: r.id('david@example.com'), status: 'canceled', endedAt: T0 + 31 * DAY }));
  await r.send('customer.subscription.deleted', fx.subscription({ id: 'sub_1', customer: 'cus_1', userId: r.id('clara@example.com'), status: 'canceled', endedAt: T0 + 61 * DAY }));
  assert.equal(r.world.discounts[0].status, 'EXPIRED', 'never active with nobody in it');
});

test('T6-3: a canceling member keeps the price until the period end, then loses it within 5 minutes (D1 time)', async () => {
  const r = await rig();
  await r.join('clara@example.com', 1);
  await r.send('customer.subscription.updated', fx.subscription({ id: 'sub_1', customer: 'cus_1', userId: r.id('clara@example.com'), cancelAtPeriodEnd: true }));
  await r.cron(T0 + 30 * DAY);
  assert.deepEqual(r.world.discounts[0].customers, ['gid://shopify/Customer/7']);
  await r.cron(T0 + 31 * DAY + 5 * 60000);
  assert.equal(r.world.discounts[0].status, 'EXPIRED');
});

test('T6-4: the reconcile repairs drift (someone edited the discount by hand) and an injected failure', async () => {
  const r = await rig();
  await r.join('clara@example.com', 1);
  const d = r.world.discounts[0];
  d.customers.push('gid://shopify/Customer/999');
  d.variants.push(V(31));
  await r.cron(T0 + DAY);
  assert.deepEqual(d.customers, ['gid://shopify/Customer/7']);
  assert.deepEqual(d.variants, [V(11)]);
  // Shopify fails during a revoke → the next reconcile catches up
  await r.send('customer.subscription.updated', fx.subscription({ id: 'sub_1', customer: 'cus_1', userId: r.id('clara@example.com'), status: 'past_due' }));
  // (the revoke above succeeded; simulate the failure on a grant instead)
  const real = r.world.shopifyOps.CirclePriceUpdate;
  r.world.shopifyOps.CirclePriceUpdate = () => new Response('down', { status: 502 });
  await r.send('invoice.paid', fx.invoice({ id: 'in_y', sub: 'sub_1', customer: 'cus_1', userId: r.id('clara@example.com'), reason: 'subscription_cycle', start: T0 + 31 * DAY, end: T0 + 61 * DAY }));
  r.world.shopifyOps.CirclePriceUpdate = real;
  await r.cron(T0 + DAY + 5 * 60000);
  assert.equal(d.status, 'ACTIVE');
  assert.deepEqual(d.customers, ['gid://shopify/Customer/7']);
});

test('T6-5: variants follow the economics: a variant that fails rule 2 leaves the discount; one that passes joins', async () => {
  const r = await rig();
  await r.join('clara@example.com', 1);
  await r.adminSend('PUT', '/api/admin/costs', { variant_gid: V(12), cost_cents: 1000, shipping_class: 'S' });
  assert.deepEqual(r.world.discounts[0].variants.sort(), [V(11), V(12)]);
  await r.adminSend('PUT', '/api/admin/costs', { variant_gid: V(11), cost_cents: 2307, shipping_class: 'S' });
  assert.deepEqual(r.world.discounts[0].variants, [V(12)]);
  await r.adminSend('PUT', '/api/admin/circle-price/list', { product_gid: P(1), on_list: false });
  assert.equal(r.world.discounts[0].status, 'EXPIRED', 'nothing eligible → deactivated, not "applies to nothing"');
});

test('T6-6: shards: with a shard size of 1 every member sits in their own discount', async () => {
  const r = await rig({ CIRCLE_PRICE_SHARD_SIZE: '1' });
  await r.join('clara@example.com', 1);
  await r.join('david@example.com', 2);
  assert.equal(r.world.discounts.length, 2);
  assert.deepEqual(r.world.discounts.map((d) => d.customers.length), [1, 1]);
  assert.deepEqual(r.world.discounts.map((d) => d.title), ['Circle price', 'Circle price · 2']);
});

test('T6-7: with the sync switched off nothing is sent to Shopify and the storefront shows no Circle price', async () => {
  const r = await rig({ CIRCLE_PRICE_SYNC: '' });
  await r.join('clara@example.com', 1);
  assert.equal(r.world.discounts.length, 0);
  const res = await r.t.call(get('/api/storefront/circle-price?product=vase-a', { Origin: 'https://springrenaissance.store' }));
  assert.deepEqual(await body(res), { variants: {} });
});

test('T6-8: the storefront line: eligible variants only, the exact checkout price, cacheable, CORS for the store', async () => {
  const r = await rig();
  await r.join('clara@example.com', 1);
  const res = await r.t.call(get('/api/storefront/circle-price?product=vase-a', { Origin: 'https://springrenaissance.store' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { variants: { 11: { price_cents: 4000, circle_price_cents: 3000 } } });
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=300');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://springrenaissance.store');
  const none = await r.t.call(get('/api/storefront/circle-price?product=small-candle'));
  assert.deepEqual(await body(none), { variants: {} });
  const bad = await r.t.call(get('/api/storefront/circle-price?product=../etc'));
  assert.equal(bad.status, 400);
});

test('T6-9: /api/me/storefront says whether the signed-in person has the member price', async () => {
  const r = await rig();
  let res = await r.t.call(get('/api/me/storefront', { Origin: 'https://springrenaissance.store', Cookie: r.clara.cookie }));
  assert.deepEqual(await body(res), { is_member: false });
  await r.join('clara@example.com', 1);
  res = await r.t.call(get('/api/me/storefront', { Origin: 'https://springrenaissance.store', Cookie: r.clara.cookie }));
  assert.deepEqual(await body(res), { is_member: true });
  res = await r.t.call(get('/api/me/storefront', { Origin: 'https://springrenaissance.store' }));
  assert.deepEqual(await body(res), { is_member: false });
});

test('T6-10: admin sees the sync state and can run it now', async () => {
  const r = await rig();
  await r.join('clara@example.com', 1);
  const s = (await r.admin('/api/admin/circle-price/status')).data;
  assert.equal(s.sync_enabled, true);
  assert.equal(s.members_with_price, 1);
  assert.equal(s.eligible_variants, 1);
  assert.equal(s.discounts[0].status, 'active');
  const run = await r.adminSend('POST', '/api/admin/circle-price/sync', {});
  assert.equal(run.res.status, 200);
});

// ---- the order audit --------------------------------------------------------------

import { createHmac } from 'node:crypto';

async function orderWebhook(r, { email, customer, circle = true, n = 1 }) {
  r.world.shopifyOps.OrderPlaced = () => ({ order: {
    id: `gid://shopify/Order/50${n}`, email, paymentGatewayNames: ['shopify_payments'], customer: customer ? { id: customer, numberOfOrders: '2' } : null,
    discountApplications: { nodes: circle ? [{ __typename: 'AutomaticDiscountApplication', title: 'Circle price' }] : [] },
    lineItems: { nodes: [{ product: { id: P(1), handle: 'vase-a' }, variant: { id: V(11) } }] },
  } });
  const raw = JSON.stringify({ id: 500 + n, admin_graphql_api_id: `gid://shopify/Order/50${n}`, created_at: '2026-10-16T08:30:00Z' });
  const req = new Request('https://w.dev/webhooks/shopify', { method: 'POST', body: raw, headers: {
    'Content-Type': 'application/json', 'X-Shopify-Topic': 'orders/create', 'X-Shopify-Event-Id': `evt-o-${n}`,
    'X-Shopify-Hmac-Sha256': createHmac('sha256', 'shpss_v2').update(raw, 'utf8').digest('base64') } });
  return r.t.call(req);
}

test('T6-11: a Circle-price order from a non-member raises a flag and tells Felix; a member\'s order does not', async () => {
  const r = await rig({ SHOPIFY_WEBHOOK_SECRET: 'shpss_v2', ADMIN_NOTIFY_EMAIL: 'felix@example.com' });
  await r.join('clara@example.com', 1);
  let res = await orderWebhook(r, { email: 'clara@example.com', customer: 'gid://shopify/Customer/7', n: 1 });
  assert.equal(res.status, 200);
  assert.equal(r.t.rows("SELECT 1 FROM admin_flags").length, 0);
  assert.equal(r.t.rows("SELECT 1 FROM events WHERE name = 'circle_price_order'").length, 1);
  res = await orderWebhook(r, { email: 'david@example.com', customer: 'gid://shopify/Customer/8', n: 2 });
  assert.equal(res.status, 200);
  const flags = r.t.rows("SELECT kind, ref FROM admin_flags");
  assert.deepEqual(flags.map((f) => [f.kind, f.ref]), [['circle_price_non_member', 'gid://shopify/Order/502']]);
  assert.ok(r.world.emails.some((e) => e.to[0] === 'felix@example.com' && /non-member/.test(e.subject)));
  await orderWebhook(r, { email: 'david@example.com', customer: 'gid://shopify/Customer/8', circle: false, n: 3 });
  assert.equal(r.t.rows("SELECT 1 FROM admin_flags").length, 1);
});

test('T6-12: the Club teaser quotes D1 Circle prices only while the discount is live', async () => {
  const product = (id, handle, price) => ({ id: P(id), handle, title: handle, status: 'ACTIVE', onlineStoreUrl: `https://s/${handle}`, isGiftCard: false, tags: [],
    collections: { nodes: [] }, featuredMedia: null, priceRangeV2: { minVariantPrice: { amount: price, currencyCode: 'USD' } }, variants: { nodes: [{ availableForSale: true }] } });
  const teaser = async (r) => {
    const res = await r.t.call(get('/api/circle/teaser', { ...trusted, Cookie: r.david.cookie }));
    return (await body(res)).member_price_examples;
  };
  for (const sync of ['on', '']) {
    const r = await rig({ CIRCLE_PRICE_SYNC: sync });
    r.world.shopifyOps.ProductsByIds = ({ ids }) => ({ nodes: ids.map((id) => (id === P(1) ? product(1, 'vase-a', '40.00') : product(3, 'small-candle', '24.00'))) });
    const uid = r.id('david@example.com');
    for (const [pid, h] of [[1, 'vase-a'], [3, 'small-candle']]) {
      r.t.env.DB._db.prepare("INSERT INTO wishlist_items (user_id, product_gid, product_handle, created_at) VALUES (?, ?, ?, 'x')").run(uid, P(pid), h);
    }
    await r.join('clara@example.com', 1); // makes the discount live when the sync is on
    const ex = await teaser(r);
    if (sync === 'on') assert.deepEqual(ex.map((e) => [e.handle, e.price_cents, e.member_price_cents]), [['vase-a', 4000, 3000]]);
    else assert.deepEqual(ex, []);
  }
});
