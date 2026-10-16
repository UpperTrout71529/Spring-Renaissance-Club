// V2 T7: the welcome piece (spec v1.1 §6.7, §8.4, §9.2.6, §12 screens 4–5,
// §16.3 #18/#19; Felix §18: from Small Pleasures, ≥ 2, ≤ $25 with shipping).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post } from './harness.mjs';
import { trusted, signIn, body, T0, DAY } from './api-helpers.mjs';
import { v2Rig, makeV2World, stripeBasics, STRIPE_ENV, stripeEvent, deliver, fx, stripePayments, CIRCLE_WHSEC, catalogProduct, serveCatalog } from './v2-helpers.mjs';

const V = (n) => `gid://shopify/ProductVariant/${n}`;
const CATALOG = [
  catalogProduct({ id: 3, handle: 'small-candle', tags: ['catalog'], variants: [{ id: 31, price: '24.00' }] }),
  catalogProduct({ id: 4, handle: 'small-dish', tags: ['catalog'], variants: [{ id: 41, price: '28.00' }] }),
  catalogProduct({ id: 5, handle: 'small-bell', tags: ['catalog'], variants: [{ id: 51, price: '18.00' }] }),
  catalogProduct({ id: 1, handle: 'big-vase', variants: [{ id: 11, price: '220.00' }] }),
];

async function rig({ shopify = true } = {}) {
  const world = stripePayments(stripeBasics(makeV2World({ shopifyCustomers: [{ id: 'gid://shopify/Customer/7', email: 'clara@example.com' }] })));
  serveCatalog(world, CATALOG, 10);
  world.unavailable = new Set();
  world.drafts = [];
  world.shopifyOps.CircleVariantsAvailable = ({ ids }) => ({ nodes: ids.map((id) => ({ id, availableForSale: !world.unavailable.has(id) })) });
  world.shopifyOps.CircleDraftCreate = ({ input }) => {
    const d = { id: `gid://shopify/DraftOrder/${world.drafts.length + 1}`, input, status: 'OPEN' };
    world.drafts.push(d);
    return { draftOrderCreate: { draftOrder: { id: d.id, invoiceUrl: `https://shop/invoices/${world.drafts.length}`, status: 'OPEN', order: null }, userErrors: [] } };
  };
  world.shopifyOps.CircleDraftComplete = ({ id }) => {
    const d = world.drafts.find((x) => x.id === id);
    d.status = 'COMPLETED';
    return { draftOrderComplete: { draftOrder: { id, status: 'COMPLETED', order: { id: `gid://shopify/Order/9${id.slice(-1)}` } }, userErrors: [] } };
  };
  const r = await v2Rig({ world, envOverrides: { ...STRIPE_ENV, STRIPE_CIRCLE_WEBHOOK_SECRET: CIRCLE_WHSEC, ...(shopify ? {} : { SHOPIFY_SHOP: '' }) } });
  if (shopify) await r.adminSend('POST', '/api/admin/catalog/sync', {});
  await r.adminSend('PUT', '/api/admin/economics', { changes: { shipping: { S: { cents: 600, estimate: true }, M: { cents: 900, estimate: true }, L: { cents: null, estimate: true } } } });
  const s = await signIn(r.t, 'clara@example.com');
  const userId = r.t.rows("SELECT id FROM users WHERE email = 'clara@example.com'")[0].id;
  const send = (type, obj) => deliver(r.t, stripeEvent(type, obj));
  const api = async (method, path, payload) => {
    const res = await r.t.call(method === 'GET' ? get(path, { ...trusted, Cookie: s.cookie }) : post(path, payload ?? {}, { ...trusted, Cookie: s.cookie }));
    return { res, data: await body(res) };
  };
  return { ...r, userId, send, api };
}

const OPTION = (over = {}) => ({ kind: 'welcome', title: 'The bell', blurb: 'Small and bright.', shopify_variant_gid: V(51), image_url: null, landed_cost_cents: 1200, shipping_class: 'S', active: true, sort: 1, ...over });

async function member(r) {
  await r.send('checkout.session.completed', fx.session({ userId: r.userId }));
  await r.send('invoice.paid', fx.invoice({ userId: r.userId }));
}

test('T7-1: admin adds welcome pieces; active ones need a landed cost and ≤ $25 with shipping', async () => {
  const r = await rig();
  let out = await r.adminSend('POST', '/api/admin/gift-options', OPTION());
  assert.equal(out.res.status, 201, JSON.stringify(out.data));
  out = await r.adminSend('POST', '/api/admin/gift-options', OPTION({ landed_cost_cents: 1901 }));  // 1901 + 600 = 2501
  assert.equal(out.res.status, 422);
  assert.equal(out.data.error.code, 'welcome_over_cap');
  assert.deepEqual(out.data.explanation, { landed_cost_cents: 1901, shipping_cents: 600, cap_cents: 2500 });
  out = await r.adminSend('POST', '/api/admin/gift-options', OPTION({ landed_cost_cents: 1900 }));
  assert.equal(out.res.status, 201);
  out = await r.adminSend('POST', '/api/admin/gift-options', OPTION({ landed_cost_cents: null }));
  assert.equal(out.res.status, 400);
  assert.equal(out.data.error.code, 'needs_landed_cost');
  out = await r.adminSend('POST', '/api/admin/gift-options', OPTION({ landed_cost_cents: null, active: false }));
  assert.equal(out.res.status, 201, 'an inactive draft may wait for data');
  out = await r.adminSend('POST', '/api/admin/gift-options', OPTION({ shipping_class: 'L' }));
  assert.equal(out.res.status, 422);
  assert.equal(out.data.error.code, 'needs_shipping');
  assert.equal(r.t.rows("SELECT 1 FROM admin_audit WHERE action = 'gift_option_saved'").length, 3);
});

test('T7-2: welcome pieces come from Small Pleasures (tag catalog) when the catalog is known', async () => {
  const r = await rig();
  const out = await r.adminSend('POST', '/api/admin/gift-options', OPTION({ shopify_variant_gid: V(11) }));
  assert.equal(out.res.status, 400);
  assert.equal(out.data.error.code, 'welcome_must_be_small_pleasures');
  const unknown = await r.adminSend('POST', '/api/admin/gift-options', OPTION({ shopify_variant_gid: V(999) }));
  assert.equal(unknown.res.status, 400);
});

test('T7-3: options are shown only to a member awaiting a choice; unavailable variants are hidden', async () => {
  const r = await rig();
  await r.adminSend('POST', '/api/admin/gift-options', OPTION());
  await r.adminSend('POST', '/api/admin/gift-options', OPTION({ title: 'The dish', shopify_variant_gid: V(41), landed_cost_cents: 1500, sort: 2 }));
  await r.adminSend('POST', '/api/admin/gift-options', OPTION({ title: 'The candle', shopify_variant_gid: V(31), landed_cost_cents: 1000, sort: 3 }));
  let out = await r.api('GET', '/api/circle/welcome');
  assert.equal(out.res.status, 200);
  assert.deepEqual(out.data, { status: null, options: [] });
  await member(r);
  r.world.unavailable.add(V(31));
  out = await r.api('GET', '/api/circle/welcome');
  assert.equal(out.data.status, 'awaiting_choice');
  assert.deepEqual(out.data.options.map((o) => o.title), ['The bell', 'The dish']);
  assert.deepEqual(Object.keys(out.data.options[0]).sort(), ['blurb', 'id', 'image_url', 'title']);
});

test('T7-4: choosing once; a second choice or an inactive option is refused', async () => {
  const r = await rig();
  const a = (await r.adminSend('POST', '/api/admin/gift-options', OPTION())).data.option.id;
  const b = (await r.adminSend('POST', '/api/admin/gift-options', OPTION({ title: 'The dish', shopify_variant_gid: V(41) }))).data.option.id;
  const off = (await r.adminSend('POST', '/api/admin/gift-options', OPTION({ title: 'Off', active: false }))).data.option.id;
  await member(r);
  let out = await r.api('POST', '/api/circle/welcome', { gift_option_id: off });
  assert.equal(out.res.status, 409);
  out = await r.api('POST', '/api/circle/welcome', { gift_option_id: a });
  assert.equal(out.res.status, 200);
  assert.deepEqual(out.data, { status: 'chosen' });
  out = await r.api('POST', '/api/circle/welcome', { gift_option_id: b });
  assert.equal(out.res.status, 409);
  assert.equal(out.data.error.code, 'already_chosen');
  assert.equal((await r.api('GET', '/api/circle/welcome')).data.options.length, 0);
});

test('T7-5: the gift queue lists waiting days; Felix creates a $0 order tagged circle-welcome, once', async () => {
  const r = await rig();
  const a = (await r.adminSend('POST', '/api/admin/gift-options', OPTION())).data.option.id;
  await r.adminSend('POST', '/api/admin/gift-options', OPTION({ title: 'The dish', shopify_variant_gid: V(41) }));
  await member(r);
  r.t.setNow(T0 + 5 * DAY);
  let q = (await r.admin('/api/admin/gift-queue')).data;
  assert.equal(q.welcome[0].status, 'awaiting_choice');
  assert.equal(q.welcome[0].days_waiting, 5);
  await r.api('POST', '/api/circle/welcome', { gift_option_id: a }).catch(() => {});
  // the member's session is older than 14 days idle? no — 5 days is fine
  q = (await r.admin('/api/admin/gift-queue')).data;
  const sel = q.welcome[0];
  assert.equal(sel.status, 'chosen');
  const out = await r.adminSend('POST', `/api/admin/gift-queue/${sel.id}/create-order`, {});
  assert.equal(out.res.status, 200, JSON.stringify(out.data));
  const d = r.world.drafts[0];
  assert.equal(d.input.lineItems[0].variantId, V(51));
  assert.deepEqual(d.input.lineItems[0].appliedDiscount, { valueType: 'PERCENTAGE', value: 100, title: 'Circle welcome piece' });
  assert.deepEqual(d.input.shippingLine, { title: 'Circle welcome', priceWithCurrency: { amount: '0.00', currencyCode: 'USD' } });
  assert.deepEqual(d.input.tags, ['circle-welcome']);
  assert.equal(d.input.acceptAutomaticDiscounts, false);
  assert.equal(d.input.purchasingEntity.customerId, 'gid://shopify/Customer/7');
  assert.equal(d.input.shippingAddress.zip, '78701');
  assert.equal(d.input.shippingAddress.provinceCode, 'TX');
  assert.equal(d.input.shippingAddress.firstName, 'Clara');
  assert.equal(d.status, 'COMPLETED');
  const row = r.t.rows('SELECT status, shopify_order_gid FROM gift_selections')[0];
  assert.deepEqual([row.status, row.shopify_order_gid], ['order_created', 'gid://shopify/Order/91']);
  const again = await r.adminSend('POST', `/api/admin/gift-queue/${sel.id}/create-order`, {});
  assert.equal(again.res.status, 409);
  assert.equal(r.world.drafts.length, 1);
});

test('T7-6: after 14 days without a choice Felix may assign one; not before', async () => {
  const r = await rig();
  const a = (await r.adminSend('POST', '/api/admin/gift-options', OPTION())).data.option.id;
  await member(r);
  const sel = r.t.rows('SELECT id FROM gift_selections')[0].id;
  r.t.setNow(T0 + 13 * DAY);
  let out = await r.adminSend('POST', `/api/admin/gift-queue/${sel}/assign`, { gift_option_id: a });
  assert.equal(out.res.status, 409);
  r.t.setNow(T0 + 14 * DAY);
  out = await r.adminSend('POST', `/api/admin/gift-queue/${sel}/assign`, { gift_option_id: a });
  assert.equal(out.res.status, 200);
  assert.equal(r.t.rows('SELECT status FROM gift_selections')[0].status, 'chosen');
});

test('T7-7: creating the order without Shopify answers 503 and changes nothing', async () => {
  const r = await rig({ shopify: false });
  const a = (await r.adminSend('POST', '/api/admin/gift-options', OPTION())).data.option.id;
  await member(r);
  await r.api('POST', '/api/circle/welcome', { gift_option_id: a });
  const sel = r.t.rows('SELECT id FROM gift_selections')[0].id;
  const out = await r.adminSend('POST', `/api/admin/gift-queue/${sel}/create-order`, {});
  assert.equal(out.res.status, 503);
  assert.equal(r.t.rows('SELECT status FROM gift_selections')[0].status, 'chosen');
});

test('T7-8: editing an option is validated the same way and audited', async () => {
  const r = await rig();
  const a = (await r.adminSend('POST', '/api/admin/gift-options', OPTION())).data.option.id;
  let out = await r.adminSend('PATCH', `/api/admin/gift-options/${a}`, { landed_cost_cents: 2000 });
  assert.equal(out.res.status, 422);
  out = await r.adminSend('PATCH', `/api/admin/gift-options/${a}`, { active: false, title: 'The bell, small' });
  assert.equal(out.res.status, 200);
  const list = (await r.admin('/api/admin/gift-options')).data.options;
  assert.equal(list[0].title, 'The bell, small');
  assert.equal(list[0].active, false);
  assert.equal(list[0].within_cap, true);
});
