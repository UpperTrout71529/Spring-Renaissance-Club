// V2 T15: the members' object (docs/tz-v2-circle.md §8; Felix §19 #3/#4).
// Bought only from the portal through a draft order; one per member per
// release; the edition is never exceeded; the 25% never applies; a claim can
// be made again after an expired reservation or a cancelled order; canceling
// members cannot claim. Every figure is Felix's; nothing defaults.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { get, post } from './harness.mjs';
import { trusted, signIn, body, T0, DAY, HOUR, MIN } from './api-helpers.mjs';
import { v2Rig, makeV2World, stripeBasics, STRIPE_ENV, stripeEvent, deliver, fx, stripePayments, CIRCLE_WHSEC } from './v2-helpers.mjs';
import { runScheduled, FREQUENT_CRON, DAILY_CRON } from '../src/cron/index.js';

const OBJ_PRODUCT = 'gid://shopify/Product/900';
const OBJ_VARIANT = 'gid://shopify/ProductVariant/9001';

async function rig({ env = {}, guard = {} } = {}) {
  const world = stripePayments(stripeBasics(makeV2World({ shopifyCustomers: [
    { id: 'gid://shopify/Customer/7', email: 'clara@example.com' }, { id: 'gid://shopify/Customer/8', email: 'david@example.com' },
    { id: 'gid://shopify/Customer/9', email: 'erin@example.com' }] })));
  world.guard = { status: 'ACTIVE', publications: [], policy: 'DENY', tracked: true, ...guard };
  world.shopifyOps.CircleObjectGuard = () => ({ product: { id: OBJ_PRODUCT, status: world.guard.status,
    resourcePublicationsV2: { nodes: world.guard.publications.map((id) => ({ publication: { id } })) },
    variants: { nodes: [{ id: OBJ_VARIANT, price: '450.00', inventoryPolicy: world.guard.policy, inventoryQuantity: 3, inventoryItem: { tracked: world.guard.tracked } }] } } });
  world.drafts = [];
  world.shopifyOps.CircleDraftCreate = ({ input }) => {
    if (world.failDraft) return new Response('down', { status: 502 });
    const d = { id: `gid://shopify/DraftOrder/${world.drafts.length + 1}`, input, status: 'OPEN', order: null };
    world.drafts.push(d);
    return { draftOrderCreate: { draftOrder: { id: d.id, invoiceUrl: `https://shop/invoices/${world.drafts.length}`, status: 'OPEN', order: null }, userErrors: [] } };
  };
  world.shopifyOps.CircleDraftState = ({ id }) => {
    const d = world.drafts.find((x) => x.id === id);
    return { draftOrder: d ? { id, status: d.status, invoiceUrl: 'https://shop/i', order: d.order ? { id: d.order } : null } : null };
  };
  world.shopifyOps.CircleDraftDelete = ({ input }) => { const d = world.drafts.find((x) => x.id === input.id); if (d) d.status = 'DELETED'; return { draftOrderDelete: { deletedId: input.id, userErrors: [] } }; };
  const r = await v2Rig({ world, envOverrides: { ...STRIPE_ENV, STRIPE_CIRCLE_WEBHOOK_SECRET: CIRCLE_WHSEC, SHOPIFY_WEBHOOK_SECRET: 'shpss_v2', ADMIN_NOTIFY_EMAIL: 'felix@example.com', ...env } });
  await r.adminSend('PUT', '/api/admin/economics', { changes: { shipping: { M: { cents: 1500, estimate: false } } } });
  const users = {};
  for (const [email, n] of [['clara@example.com', 1], ['david@example.com', 2], ['erin@example.com', 3]]) {
    const s = await signIn(r.t, email);
    users[email] = { cookie: s.cookie, id: r.t.rows('SELECT id FROM users WHERE email = ?', email)[0].id, n };
  }
  const send = (type, obj) => deliver(r.t, stripeEvent(type, obj));
  const join = async (email) => {
    const u = users[email];
    await send('checkout.session.completed', fx.session({ userId: u.id, sub: `sub_${u.n}`, customer: `cus_${u.n}`, id: `cs_${u.n}` }));
    await send('invoice.paid', fx.invoice({ id: `in_${u.n}`, sub: `sub_${u.n}`, customer: `cus_${u.n}`, userId: u.id }));
    await send('customer.subscription.updated', fx.subscription({ id: `sub_${u.n}`, customer: `cus_${u.n}`, userId: u.id }));
  };
  const as = (email) => ({
    get: async (path) => { const res = await r.t.call(get(path, { ...trusted, Cookie: users[email].cookie })); return { res, data: await body(res) }; },
    post: async (path, p) => { const res = await r.t.call(post(path, p ?? {}, { ...trusted, Cookie: users[email].cookie })); return { res, data: await body(res) }; },
  });
  return { ...r, users, send, join, as };
}

const RELEASE = {
  label: 'Winter object', public_title: 'A members\' object', description: 'Made for the Circle.', image_url: 'https://cdn.example/x.jpg',
  product_gid: OBJ_PRODUCT, variant_gid: OBJ_VARIANT, price_cents: 45000, edition_size: 2, unit_cost_cents: 20000, shipping_class: 'M',
  reserve_hours: 48, opens_at: new Date(T0).toISOString(), closes_at: new Date(T0 + 30 * DAY).toISOString(),
};

async function openRelease(r, over = {}) {
  const c = await r.adminSend('POST', '/api/admin/member-object/releases', { ...RELEASE, ...over });
  assert.equal(c.res.status, 201, JSON.stringify(c.data));
  const o = await r.adminSend('POST', `/api/admin/member-object/releases/${c.data.release.id}/open`, {});
  return { id: c.data.release.id, open: o };
}

test('T15-1: a release cannot open without price, edition, cost, reservation window, dates, or below the rule-5 price', async () => {
  const r = await rig();
  for (const missing of ['price_cents', 'edition_size', 'unit_cost_cents', 'reserve_hours', 'opens_at', 'closes_at', 'shipping_class']) {
    const { open } = await openRelease(r, { [missing]: null });
    assert.equal(open.res.status, 422, missing);
    assert.equal(open.data.error.code, 'release_incomplete');
  }
  const { open } = await openRelease(r, { price_cents: 26000 }); // cost 200 + ship 15 → P_min ≈ 276.4
  assert.equal(open.res.status, 422);
  assert.equal(open.data.error.code, 'price_below_minimum');
  assert.ok(open.data.explanation.min_price_cents > 26000);
  const ok = await openRelease(r);
  assert.equal(ok.open.res.status, 200, JSON.stringify(ok.open.data));
  assert.equal(r.t.rows("SELECT status FROM member_object_releases WHERE id = ?", ok.id)[0].status, 'open');
});

test('T15-2: the live guard must pass before opening: unpublished, active, tracked, DENY — otherwise it fails closed', async () => {
  for (const g of [{ publications: ['gid://shopify/Publication/1'] }, { policy: 'CONTINUE' }, { tracked: false }, { status: 'DRAFT' }]) {
    const r = await rig({ guard: g });
    const { open } = await openRelease(r);
    assert.equal(open.res.status, 422, JSON.stringify(g));
    assert.equal(open.data.error.code, 'guard_failed');
  }
  const r = await rig({ env: { SHOPIFY_SHOP: '' } });
  const { open } = await openRelease(r);
  assert.equal(open.res.status, 422, 'no Shopify → the guard cannot pass');
});

test('T15-3: a member claims: one draft order at the D1 price, quantity 1, no discounts, reservation window, tags; the link is shown', async () => {
  const r = await rig();
  const { id } = await openRelease(r);
  await r.join('clara@example.com');
  const view = await r.as('clara@example.com').get('/api/circle/object');
  assert.equal(view.data.release.title, 'A members\' object');
  assert.equal(view.data.release.price_cents, 45000);
  assert.equal(view.data.can_claim, true);
  assert.equal(view.data.release.remaining, undefined, 'hidden unless Felix enables it');
  const out = await r.as('clara@example.com').post('/api/circle/object/claim', { release_id: id, price_cents: 1, variant_gid: 'gid://shopify/ProductVariant/1', quantity: 5 });
  assert.equal(out.res.status, 201, JSON.stringify(out.data));
  assert.equal(out.data.invoice_url, 'https://shop/invoices/1');
  assert.equal(out.data.reserved_until, new Date(T0 + 48 * HOUR).toISOString());
  const d = r.world.drafts[0].input;
  assert.deepEqual(d.lineItems, [{ variantId: OBJ_VARIANT, quantity: 1, priceOverride: { amount: '450.00', currencyCode: 'USD' } }]);
  assert.equal(d.acceptAutomaticDiscounts, false);
  assert.equal(d.allowDiscountCodesInCheckout, false);
  assert.equal(d.reserveInventoryUntil, new Date(T0 + 48 * HOUR).toISOString());
  assert.deepEqual(d.tags.slice(0, 1), ['circle-object']);
  assert.match(d.tags[1], /^circle-claim-[0-9A-Z]{26}$/);
  assert.equal(d.purchasingEntity.customerId, 'gid://shopify/Customer/7');
  assert.ok(r.world.emails.some((e) => e.subject === "Your members' object is reserved"));
  // a second tab gets the same claim and link
  const again = await r.as('clara@example.com').post('/api/circle/object/claim', { release_id: id });
  assert.equal(again.res.status, 200);
  assert.equal(again.data.invoice_url, out.data.invoice_url);
  assert.equal(r.world.drafts.length, 1);
});

test('T15-4: non-members, canceling and past_due members cannot claim', async () => {
  const r = await rig();
  const { id } = await openRelease(r);
  let out = await r.as('clara@example.com').post('/api/circle/object/claim', { release_id: id });
  assert.equal(out.res.status, 403);
  await r.join('clara@example.com');
  await r.send('customer.subscription.updated', fx.subscription({ id: 'sub_1', customer: 'cus_1', userId: r.users['clara@example.com'].id, cancelAtPeriodEnd: true }));
  out = await r.as('clara@example.com').post('/api/circle/object/claim', { release_id: id });
  assert.equal(out.res.status, 403);
  assert.equal(out.data.error.code, 'members_only');
  assert.equal(r.world.drafts.length, 0);
});

test('T15-5: the edition is never exceeded, even with members claiming at once', async () => {
  const r = await rig();
  const { id } = await openRelease(r, { edition_size: 2 });
  for (const e of ['clara@example.com', 'david@example.com', 'erin@example.com']) await r.join(e);
  const outs = await Promise.all(['clara@example.com', 'david@example.com', 'erin@example.com'].map((e) => r.as(e).post('/api/circle/object/claim', { release_id: id })));
  assert.deepEqual(outs.map((o) => o.res.status).sort(), [201, 201, 409]);
  assert.equal(outs.find((o) => o.res.status === 409).data.error.code, 'sold_out');
  assert.equal(r.world.drafts.length, 2);
});

test('T15-6: an unpaid reservation expires (draft deleted, slot freed) and the member may claim again; a paid one stays', async () => {
  const r = await rig();
  const { id } = await openRelease(r, { edition_size: 1 });
  await r.join('clara@example.com');
  await r.join('david@example.com');
  await r.as('clara@example.com').post('/api/circle/object/claim', { release_id: id });
  let full = await r.as('david@example.com').post('/api/circle/object/claim', { release_id: id });
  assert.equal(full.res.status, 409);
  await runScheduled(r.t.env, T0 + 49 * HOUR, FREQUENT_CRON, { deps: { fetch: r.world.fetch } });
  assert.equal(r.world.drafts[0].status, 'DELETED');
  assert.equal(r.t.rows('SELECT status FROM member_object_claims')[0].status, 'expired');
  r.t.setNow(T0 + 50 * HOUR);
  const d = await r.as('david@example.com').post('/api/circle/object/claim', { release_id: id });
  assert.equal(d.res.status, 201);
  // paid through the invoice before expiry → paid, never expired
  r.world.drafts[1].status = 'COMPLETED';
  r.world.drafts[1].order = 'gid://shopify/Order/77';
  await runScheduled(r.t.env, T0 + 99 * HOUR, FREQUENT_CRON, { deps: { fetch: r.world.fetch } });
  const rows = r.t.rows("SELECT status, order_gid FROM member_object_claims ORDER BY created_at");
  assert.deepEqual(rows.map((x) => x.status), ['expired', 'paid']);
  assert.equal(rows[1].order_gid, 'gid://shopify/Order/77');
  // clara may claim again after her expiry, but the edition is now taken
  r.t.setNow(T0 + 100 * HOUR);
  full = await r.as('clara@example.com').post('/api/circle/object/claim', { release_id: id });
  assert.equal(full.data.error.code, 'sold_out');
});

test('T15-7: one per member per release — a paid claim blocks a second', async () => {
  const r = await rig();
  const { id } = await openRelease(r);
  await r.join('clara@example.com');
  await r.as('clara@example.com').post('/api/circle/object/claim', { release_id: id });
  const claim = r.t.rows('SELECT id FROM member_object_claims')[0].id;
  r.t.env.DB._db.prepare("UPDATE member_object_claims SET status = 'paid' WHERE id = ?").run(claim);
  const out = await r.as('clara@example.com').post('/api/circle/object/claim', { release_id: id });
  assert.equal(out.res.status, 200);
  assert.equal(out.data.status, 'paid');
  assert.equal(r.world.drafts.length, 1);
});

test('T15-8: Shopify failing to create the draft frees the slot and says so calmly', async () => {
  const r = await rig();
  const { id } = await openRelease(r, { edition_size: 1 });
  await r.join('clara@example.com');
  r.world.failDraft = true;
  const out = await r.as('clara@example.com').post('/api/circle/object/claim', { release_id: id });
  assert.equal(out.res.status, 503);
  assert.equal(r.t.rows('SELECT status FROM member_object_claims')[0].status, 'failed');
  r.world.failDraft = false;
  const again = await r.as('clara@example.com').post('/api/circle/object/claim', { release_id: id });
  assert.equal(again.res.status, 201);
});

test('T15-9: an order with the object variant that is not a paid claim is flagged for Felix (bypass audit)', async () => {
  const r = await rig();
  const { id } = await openRelease(r);
  await r.join('clara@example.com');
  await r.as('clara@example.com').post('/api/circle/object/claim', { release_id: id });
  const claim = r.t.rows('SELECT id FROM member_object_claims')[0].id;
  const order = (n, tags) => {
    r.world.shopifyOps.OrderPlaced = () => ({ order: { id: `gid://shopify/Order/6${n}`, email: 'david@example.com', tags, paymentGatewayNames: [],
      customer: { id: 'gid://shopify/Customer/8', numberOfOrders: '1' }, discountApplications: { nodes: [] },
      lineItems: { nodes: [{ product: { id: OBJ_PRODUCT, handle: 'object' }, variant: { id: OBJ_VARIANT } }] } } });
    const raw = JSON.stringify({ id: 600 + n, admin_graphql_api_id: `gid://shopify/Order/6${n}` });
    return r.t.call(new Request('https://w.dev/webhooks/shopify', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json',
      'X-Shopify-Topic': 'orders/create', 'X-Shopify-Event-Id': `evt-${n}`, 'X-Shopify-Hmac-Sha256': createHmac('sha256', 'shpss_v2').update(raw, 'utf8').digest('base64') } }));
  };
  r.world.shopifyOps.OrderPlaced = null;
  await order(1, ['circle-object', `circle-claim-${claim}`]);
  // the claimant's own order (tag of her claim) — david is not the claimant, so it is a bypass
  assert.equal(r.t.rows("SELECT 1 FROM admin_flags WHERE kind = 'object_bypass'").length, 1);
  r.world.shopifyOps.OrderPlaced = null;
  await order(2, []);
  assert.equal(r.t.rows("SELECT 1 FROM admin_flags WHERE kind = 'object_bypass'").length, 2);
  // the claimant's own order from her draft is not flagged
  const legit = (n) => {
    r.world.shopifyOps.OrderPlaced = () => ({ order: { id: `gid://shopify/Order/7${n}`, email: 'clara@example.com', tags: ['circle-object', `circle-claim-${claim}`], paymentGatewayNames: [],
      customer: { id: 'gid://shopify/Customer/7', numberOfOrders: '1' }, discountApplications: { nodes: [] },
      lineItems: { nodes: [{ product: { id: OBJ_PRODUCT, handle: 'object' }, variant: { id: OBJ_VARIANT } }] } } });
    const raw = JSON.stringify({ id: 700 + n, admin_graphql_api_id: `gid://shopify/Order/7${n}` });
    return r.t.call(new Request('https://w.dev/webhooks/shopify', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json',
      'X-Shopify-Topic': 'orders/create', 'X-Shopify-Event-Id': `evt-l-${n}`, 'X-Shopify-Hmac-Sha256': createHmac('sha256', 'shpss_v2').update(raw, 'utf8').digest('base64') } }));
  };
  await legit(1);
  assert.equal(r.t.rows("SELECT 1 FROM admin_flags WHERE kind = 'object_bypass'").length, 2);
});

test('T15-10: the nightly guard closes claims when the product is published by mistake, and tells Felix', async () => {
  const r = await rig();
  const { id } = await openRelease(r);
  await r.join('clara@example.com');
  r.world.guard.publications = ['gid://shopify/Publication/1'];
  await runScheduled(r.t.env, T0 + DAY, DAILY_CRON, { deps: { fetch: r.world.fetch } });
  const out = await r.as('clara@example.com').post('/api/circle/object/claim', { release_id: id });
  assert.equal(out.res.status, 409);
  assert.equal(out.data.error.code, 'release_paused');
  assert.equal(r.t.rows("SELECT 1 FROM admin_flags WHERE kind = 'object_guard_failed'").length, 1);
});

test('T15-11: the admin sees counts and the rule-5 minimum; a second release in a year warns', async () => {
  const r = await rig();
  await openRelease(r);
  const second = await openRelease(r, { label: 'Spring object', opens_at: new Date(T0 + 60 * DAY).toISOString(), closes_at: new Date(T0 + 90 * DAY).toISOString() });
  assert.equal(second.open.res.status, 200);
  assert.match(second.open.data.warning, /second release this year/i);
  const list = (await r.admin('/api/admin/member-object/releases')).data.releases;
  assert.equal(list.length, 2);
  assert.equal(typeof list[0].min_price_cents, 'number');
  assert.deepEqual(list[0].claims, { creating: 0, invoiced: 0, paid: 0, expired: 0, failed: 0, cancelled: 0 });
});
