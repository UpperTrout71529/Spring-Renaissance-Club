// V2 T21: early access = members' pre-order of a new piece before its public
// release, through a draft order (Felix §19 #11). Mechanism (my choice, D39):
// the window is the 48 hours before public_release_at unless Felix sets
// opens_at; payment is taken when the member pays the draft invoice (no
// deferred capture); the ship note is Felix's text, shown only when entered;
// members pay the Circle price when the piece passes rule 2, else full price.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { get, post } from './harness.mjs';
import { trusted, signIn, body, T0, DAY, HOUR } from './api-helpers.mjs';
import { v2Rig, makeV2World, stripeBasics, STRIPE_ENV, stripeEvent, deliver, fx, stripePayments, CIRCLE_WHSEC, catalogProduct, serveCatalog } from './v2-helpers.mjs';
import { runScheduled, FREQUENT_CRON } from '../src/cron/index.js';

const P = 'gid://shopify/Product/70';
const V = 'gid://shopify/ProductVariant/701';
const RELEASE_AT = T0 + 3 * DAY;

async function rig() {
  const world = stripePayments(stripeBasics(makeV2World({ shopifyCustomers: [{ id: 'gid://shopify/Customer/7', email: 'clara@example.com' }] })));
  serveCatalog(world, [catalogProduct({ id: 70, handle: 'new-piece', published: false, variants: [{ id: 701, price: '200.00' }] })], 10);
  world.shopifyOps.CircleObjectGuard = () => ({ product: { id: P, status: 'ACTIVE', resourcePublicationsV2: { nodes: [] },
    variants: { nodes: [{ id: V, price: '200.00', inventoryPolicy: 'DENY', inventoryQuantity: 5, inventoryItem: { tracked: true } }] } } });
  world.drafts = [];
  world.shopifyOps.CircleDraftCreate = ({ input }) => {
    const d = { id: `gid://shopify/DraftOrder/${world.drafts.length + 1}`, input };
    world.drafts.push(d);
    return { draftOrderCreate: { draftOrder: { id: d.id, invoiceUrl: `https://shop/inv/${world.drafts.length}`, status: 'OPEN', order: null }, userErrors: [] } };
  };
  const r = await v2Rig({ world, envOverrides: { ...STRIPE_ENV, STRIPE_CIRCLE_WEBHOOK_SECRET: CIRCLE_WHSEC, SHOPIFY_WEBHOOK_SECRET: 'shpss_v2', ADMIN_NOTIFY_EMAIL: 'felix@example.com' } });
  await r.adminSend('POST', '/api/admin/catalog/sync', {});
  await r.adminSend('PUT', '/api/admin/economics', { changes: { shipping: { M: { cents: 1000, estimate: false } } } });
  const s = await signIn(r.t, 'clara@example.com');
  const userId = r.t.rows("SELECT id FROM users WHERE email = 'clara@example.com'")[0].id;
  const send = (type, obj) => deliver(r.t, stripeEvent(type, obj));
  const api = async (method, path, payload) => {
    const res = await r.t.call(method === 'GET' ? get(path, { ...trusted, Cookie: s.cookie }) : post(path, payload ?? {}, { ...trusted, Cookie: s.cookie }));
    return { res, data: await body(res) };
  };
  const join = async () => {
    await send('checkout.session.completed', fx.session({ userId }));
    await send('invoice.paid', fx.invoice({ userId }));
    await send('customer.subscription.updated', fx.subscription({ userId }));
  };
  return { ...r, userId, send, api, join };
}

const EA = { kind: 'early_access', label: 'Spring piece', public_title: 'A new piece', description: 'Before everyone else.',
  product_gid: P, variant_gid: V, price_cents: 20000, edition_size: 3, unit_cost_cents: 8000, shipping_class: 'M', reserve_hours: 24,
  public_release_at: new Date(RELEASE_AT).toISOString(), ships_note: 'Ships from March 3.' };

async function openEA(r, over = {}) {
  const c = await r.adminSend('POST', '/api/admin/member-object/releases', { ...EA, ...over });
  assert.equal(c.res.status, 201, JSON.stringify(c.data));
  const o = await r.adminSend('POST', `/api/admin/member-object/releases/${c.data.release.id}/open`, {});
  return { id: c.data.release.id, open: o };
}

test('T21-1: the window defaults to the 48 hours before the public release and closes at it', async () => {
  const r = await rig();
  const { id, open } = await openEA(r);
  assert.equal(open.res.status, 200, JSON.stringify(open.data));
  const rel = r.t.rows('SELECT opens_at, closes_at FROM member_object_releases WHERE id = ?', id)[0];
  assert.equal(rel.opens_at, new Date(RELEASE_AT - 48 * HOUR).toISOString());
  assert.equal(rel.closes_at, new Date(RELEASE_AT).toISOString());
  const noDate = await openEA(r, { public_release_at: null });
  assert.equal(noDate.open.res.status, 422);
});

test('T21-2: members pre-order in the window at full price when the piece is not on the Circle price; the ship note shows', async () => {
  const r = await rig();
  const { id } = await openEA(r);
  await r.join();
  r.t.setNow(RELEASE_AT - 47 * HOUR);
  const view = await r.api('GET', '/api/circle/early-access');
  assert.equal(view.data.release.title, 'A new piece');
  assert.equal(view.data.release.ships_note, 'Ships from March 3.');
  assert.equal(view.data.release.member_price_cents, 20000);
  const out = await r.api('POST', '/api/circle/early-access/claim', { release_id: id });
  assert.equal(out.res.status, 201, JSON.stringify(out.data));
  const d = r.world.drafts[0].input;
  assert.equal(d.lineItems[0].priceOverride.amount, '200.00');
  assert.deepEqual(d.tags.slice(0, 1), ['circle-early-access']);
  assert.equal(d.acceptAutomaticDiscounts, false);
});

test('T21-3: with the piece eligible for the Circle price (rule 2), members pay 25% less', async () => {
  const r = await rig();
  await r.adminSend('PUT', '/api/admin/circle-price/list', { product_gid: P, on_list: true });
  await r.adminSend('PUT', '/api/admin/costs', { variant_gid: V, cost_cents: 8000, shipping_class: 'M' });
  const { id } = await openEA(r);
  await r.join();
  r.t.setNow(RELEASE_AT - 47 * HOUR);
  const view = await r.api('GET', '/api/circle/early-access');
  assert.equal(view.data.release.member_price_cents, 15000);
  await r.api('POST', '/api/circle/early-access/claim', { release_id: id });
  assert.equal(r.world.drafts[0].input.lineItems[0].priceOverride.amount, '150.00');
});

test('T21-4: before the window, after the public release, or for non-members: no pre-order', async () => {
  const r = await rig();
  const { id } = await openEA(r);
  r.t.setNow(RELEASE_AT - 47 * HOUR);
  let out = await r.api('POST', '/api/circle/early-access/claim', { release_id: id });
  assert.equal(out.res.status, 403, 'not a member');
  await r.join();
  r.t.setNow(RELEASE_AT - 49 * HOUR);
  out = await r.api('POST', '/api/circle/early-access/claim', { release_id: id });
  assert.equal(out.res.status, 409);
  r.t.setNow(RELEASE_AT + HOUR);
  out = await r.api('POST', '/api/circle/early-access/claim', { release_id: id });
  assert.equal(out.res.status, 409);
});

test('T21-5: the release closes itself at the public release; public orders after it are not flagged, orders inside the window are', async () => {
  const r = await rig();
  const { id } = await openEA(r);
  const order = async (n) => {
    r.world.shopifyOps.OrderPlaced = () => ({ order: { id: `gid://shopify/Order/9${n}`, email: 'someone@example.com', tags: [], paymentGatewayNames: [],
      customer: null, discountApplications: { nodes: [] }, lineItems: { nodes: [{ product: { id: P, handle: 'new-piece' }, variant: { id: V } }] } } });
    const raw = JSON.stringify({ id: 900 + n, admin_graphql_api_id: `gid://shopify/Order/9${n}` });
    return r.t.call(new Request('https://w.dev/webhooks/shopify', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json',
      'X-Shopify-Topic': 'orders/create', 'X-Shopify-Event-Id': `evt-ea-${n}`, 'X-Shopify-Hmac-Sha256': createHmac('sha256', 'shpss_v2').update(raw, 'utf8').digest('base64') } }));
  };
  r.t.setNow(RELEASE_AT - 10 * HOUR);
  await order(1);
  assert.equal(r.t.rows("SELECT 1 FROM admin_flags WHERE kind = 'object_bypass'").length, 1);
  r.t.setNow(RELEASE_AT + HOUR);
  await runScheduled(r.t.env, RELEASE_AT + HOUR, FREQUENT_CRON, { deps: { fetch: r.world.fetch } });
  assert.equal(r.t.rows('SELECT status FROM member_object_releases WHERE id = ?', id)[0].status, 'closed');
  await order(2);
  assert.equal(r.t.rows("SELECT 1 FROM admin_flags WHERE kind = 'object_bypass'").length, 1);
});
