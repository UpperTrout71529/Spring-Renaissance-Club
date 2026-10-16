// Regression tests for the findings of the independent V2 backend review
// (16 Oct 2026). Numbers match the review report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { get, post } from './harness.mjs';
import { trusted, signIn, body, T0, DAY, HOUR, MIN } from './api-helpers.mjs';
import { v2Rig, makeV2World, stripeBasics, STRIPE_ENV, stripeEvent, deliver, fx, stripePayments, CIRCLE_WHSEC, catalogProduct, serveCatalog, seedWelcomeSet } from './v2-helpers.mjs';
import { runScheduled, FREQUENT_CRON, DAILY_CRON } from '../src/cron/index.js';

const V = (n) => `gid://shopify/ProductVariant/${n}`;
const P = (n) => `gid://shopify/Product/${n}`;

// A Shopify discount store (as in the T6 tests) with an optional slow create.
function discounts(world, { slow = false } = {}) {
  world.discounts = [];
  const find = (id) => world.discounts.find((d) => d.id === id);
  world.shopifyOps.CirclePriceCreate = async ({ input }) => {
    if (slow) for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    const d = { id: `gid://shopify/DiscountAutomaticNode/${world.discounts.length + 1}`, title: input.title, status: 'ACTIVE',
      customers: [...input.context.customers.add], variants: [...input.customerGets.items.products.productVariantsToAdd] };
    world.discounts.push(d);
    if (world.failCreateAfter) return new Response('timeout', { status: 504 });
    return { discountAutomaticBasicCreate: { automaticDiscountNode: { id: d.id }, userErrors: [] } };
  };
  world.shopifyOps.CirclePriceUpdate = ({ id, input }) => {
    const d = find(id);
    const c = (input.context && input.context.customers) || {};
    d.customers = [...d.customers.filter((x) => !(c.remove || []).includes(x)), ...(c.add || []).filter((x) => !d.customers.includes(x))];
    const p = (input.customerGets && input.customerGets.items && input.customerGets.items.products) || {};
    d.variants = [...d.variants.filter((x) => !(p.productVariantsToRemove || []).includes(x)), ...(p.productVariantsToAdd || []).filter((x) => !d.variants.includes(x))];
    return { discountAutomaticBasicUpdate: { automaticDiscountNode: { id }, userErrors: [] } };
  };
  world.shopifyOps.CirclePriceRead = ({ id }) => {
    const d = find(id);
    return { discountNode: d ? { id, discount: { status: d.status, context: { customers: d.customers.map((x) => ({ id: x })) },
      customerGets: { items: { productVariants: { nodes: d.variants.map((x) => ({ id: x })) } } } } } : null };
  };
  world.shopifyOps.CirclePriceFind = () => ({ discountNodes: { nodes: world.discounts.map((d) => ({ id: d.id, discount: { __typename: 'DiscountAutomaticBasic', title: d.title, status: d.status } })) } });
  world.shopifyOps.CirclePriceActivate = ({ id }) => { find(id).status = 'ACTIVE'; return { discountAutomaticActivate: { automaticDiscountNode: { id }, userErrors: [] } }; };
  world.shopifyOps.CirclePriceDeactivate = ({ id }) => { find(id).status = 'EXPIRED'; return { discountAutomaticDeactivate: { automaticDiscountNode: { id }, userErrors: [] } }; };
}

async function rig({ env = {}, slow = false, catalog = [catalogProduct({ id: 1, handle: 'vase-a', variants: [{ id: 11, price: '100.00' }] })], interleave = false } = {}) {
  const world = stripePayments(stripeBasics(makeV2World({ shopifyCustomers: [{ id: 'gid://shopify/Customer/7', email: 'clara@example.com' }] })));
  serveCatalog(world, catalog, 10);
  discounts(world, { slow });
  world.cards = [];
  world.shopifyOps.CreditsGiftCard = ({ input }) => {
    const n = world.cards.length + 1;
    world.cards.push(input);
    return { giftCardCreate: { giftCard: { id: `gid://shopify/GiftCard/${n}`, lastCharacters: `000${n}`, initialValue: { amount: input.initialValue } }, giftCardCode: `code-${n}`, userErrors: [] } };
  };
  const r = await v2Rig({ world, envOverrides: { ...STRIPE_ENV, STRIPE_CIRCLE_WEBHOOK_SECRET: CIRCLE_WHSEC, SHOPIFY_WEBHOOK_SECRET: 'shpss_v2', ADMIN_NOTIFY_EMAIL: 'felix@example.com', interleave, ...env } });
  await r.adminSend('POST', '/api/admin/catalog/sync', {});
  await r.adminSend('PUT', '/api/admin/economics', { changes: { shipping: { S: { cents: 1000, estimate: false } } } });
  const s = await signIn(r.t, 'clara@example.com');
  const userId = r.t.rows("SELECT id FROM users WHERE email = 'clara@example.com'")[0].id;
  const send = (type, obj, opts) => deliver(r.t, stripeEvent(type, obj, opts));
  const api = async (method, path, payload, headers = {}) => {
    const res = await r.t.call(method === 'GET' ? get(path, { ...trusted, Cookie: s.cookie, ...headers }) : post(path, payload ?? {}, { ...trusted, Cookie: s.cookie, ...headers }));
    return { res, data: await body(res) };
  };
  const join = async () => {
    await send('checkout.session.completed', fx.session({ userId }));
    await send('invoice.paid', fx.invoice({ userId }));
    await send('customer.subscription.updated', fx.subscription({ userId }));
  };
  const balance = () => r.t.rows('SELECT COALESCE(SUM(amount_cents),0) AS b FROM credit_ledger WHERE user_id = ?', userId)[0].b;
  const cron = (ms, which) => runScheduled(r.t.env, ms, which, { deps: { fetch: world.fetch } });
  return { ...r, s, userId, send, api, join, balance, cron };
}

// ---- 1 -------------------------------------------------------------------------------

test('R1: overlapping member-price syncs create one discount; a create that timed out is found and reused', async () => {
  const r = await rig({ env: { CIRCLE_PRICE_SYNC: 'on' }, slow: true });
  await r.adminSend('PUT', '/api/admin/costs', { variant_gid: V(11), cost_cents: 3000, shipping_class: 'S' });
  await r.adminSend('PUT', '/api/admin/circle-price/list', { product_gid: P(1), on_list: true });
  await r.join();
  await Promise.all([r.cron(T0 + MIN, FREQUENT_CRON), r.cron(T0 + MIN, FREQUENT_CRON), r.cron(T0 + MIN, FREQUENT_CRON)]);
  assert.equal(r.world.discounts.length, 1);

  const r2 = await rig({ env: { CIRCLE_PRICE_SYNC: 'on' } });
  await r2.adminSend('PUT', '/api/admin/costs', { variant_gid: V(11), cost_cents: 3000, shipping_class: 'S' });
  await r2.adminSend('PUT', '/api/admin/circle-price/list', { product_gid: P(1), on_list: true });
  r2.world.failCreateAfter = true;
  await r2.join();
  r2.world.failCreateAfter = false;
  await r2.cron(T0 + 10 * MIN, FREQUENT_CRON);
  assert.equal(r2.world.discounts.length, 1, 'the discount Shopify made despite the timeout is reused');
  assert.equal(r2.t.rows('SELECT shopify_discount_gid FROM circle_price_discounts')[0].shopify_discount_gid, r2.world.discounts[0].id);
});

// ---- 2 -------------------------------------------------------------------------------

test('R2: prices follow Shopify: the daily cron re-reads the catalog; products/update marks it for the 5-minute run', async () => {
  const r = await rig();
  await r.adminSend('PUT', '/api/admin/costs', { variant_gid: V(11), cost_cents: 3000, shipping_class: 'S' });
  await r.adminSend('PUT', '/api/admin/circle-price/list', { product_gid: P(1), on_list: true });
  assert.equal(r.t.rows('SELECT price_cents FROM circle_price_items')[0].price_cents, 10000);
  serveCatalog(r.world, [catalogProduct({ id: 1, handle: 'vase-a', variants: [{ id: 11, price: '60.00' }] })], 10);
  await r.cron(T0 + DAY, DAILY_CRON);
  const it = r.t.rows('SELECT price_cents, eligible, reason FROM circle_price_items')[0];
  assert.deepEqual([it.price_cents, it.eligible, it.reason], [6000, 0, 'margin_below_min']);
  // products/update → next 5-minute run
  serveCatalog(r.world, [catalogProduct({ id: 1, handle: 'vase-a', variants: [{ id: 11, price: '100.00' }] })], 10);
  const raw = JSON.stringify({ id: 1, admin_graphql_api_id: P(1) });
  const res = await r.t.call(new Request('https://w.dev/webhooks/shopify', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json',
    'X-Shopify-Topic': 'products/update', 'X-Shopify-Event-Id': 'evt-p-1', 'X-Shopify-Hmac-Sha256': createHmac('sha256', 'shpss_v2').update(raw, 'utf8').digest('base64') } }));
  assert.equal(res.status, 200);
  await r.cron(T0 + DAY + 5 * MIN, FREQUENT_CRON);
  assert.equal(r.t.rows('SELECT price_cents FROM circle_price_items')[0].price_cents, 10000);
});

// ---- 3 + 4 ----------------------------------------------------------------------------

test('R3: a redemption stuck half-way returns its credits after 10 minutes and flags Felix; a stuck capsule claim frees itself', async () => {
  const r = await rig();
  await r.join();
  r.t.env.DB._db.prepare("INSERT INTO redemptions (id, user_id, amount_cents, purpose, status, created_at) VALUES ('rd_stuck', ?, 1000, 'credits', 'creating', ?)").run(r.userId, new Date(T0).toISOString());
  r.t.env.DB._db.prepare("INSERT INTO credit_ledger (id, user_id, amount_cents, kind, ref, idempotency_key, created_at) VALUES ('l1', ?, -1000, 'redemption', 'rd_stuck', 'redemption:rd_stuck', ?)").run(r.userId, new Date(T0).toISOString());
  assert.equal(r.balance(), 1000);
  await r.cron(T0 + 5 * MIN, FREQUENT_CRON);
  assert.equal(r.balance(), 1000, 'not before 10 minutes');
  await r.cron(T0 + 11 * MIN, FREQUENT_CRON);
  assert.equal(r.balance(), 2000);
  assert.equal(r.t.rows("SELECT status FROM redemptions WHERE id = 'rd_stuck'")[0].status, 'failed');
  assert.equal(r.t.rows("SELECT 1 FROM admin_flags WHERE kind = 'redemption_uncertain'").length, 1);
  await r.cron(T0 + 20 * MIN, FREQUENT_CRON);
  assert.equal(r.balance(), 2000, 'once');
});

test('R4: claiming a capsule (credits → a card code) needs a fresh step-up', async () => {
  const r = await rig({ catalog: [catalogProduct({ id: 40, handle: 'winter-capsule', tags: ['capsule'], variants: [{ id: 401, price: '120.00' }] })] });
  const cap = await r.adminSend('POST', '/api/admin/capsules', { season: 'Winter', title: 'Winter', shopify_product_gid: P(40), price_cents: 6000,
    opens_at: new Date(T0 - DAY).toISOString(), closes_at: new Date(T0 + 30 * DAY).toISOString(), min_consecutive_months: 1 });
  await r.join();
  let out = await r.api('POST', `/api/circle/capsules/${cap.data.capsule.id}/claim`, {});
  assert.equal(out.res.status, 403);
  assert.equal(out.data.error.code, 'step_up_required');
  await r.t.env.DB.prepare('UPDATE sessions SET step_up_at = ?1').bind(new Date(T0).toISOString()).run();
  out = await r.api('POST', `/api/circle/capsules/${cap.data.capsule.id}/claim`, {});
  assert.equal(out.res.status, 201);
});

// ---- 5 + 6 + 10 ------------------------------------------------------------------------

test('R5: a dispute after a full refund reverses nothing more; after a partial refund only the rest', async () => {
  const r = await rig();
  await r.join();
  await r.send('invoice.paid', fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', start: T0 + 31 * DAY, end: T0 + 62 * DAY }));
  await r.send('charge.refunded', { id: 'ch_in_2', object: 'charge', payment_intent: 'pi_in_2', amount: 2000, amount_refunded: 2000 });
  await r.send('charge.dispute.created', { id: 'dp_1', object: 'dispute', charge: 'ch_in_2', payment_intent: 'pi_in_2', amount: 2000 });
  assert.equal(r.balance(), 2000);
  await r.send('invoice.paid', fx.invoice({ id: 'in_3', userId: r.userId, reason: 'subscription_cycle', start: T0 + 62 * DAY, end: T0 + 93 * DAY }));
  await r.send('charge.refunded', { id: 'ch_in_3', object: 'charge', payment_intent: 'pi_in_3', amount: 2000, amount_refunded: 1000 });
  await r.send('charge.dispute.created', { id: 'dp_2', object: 'dispute', charge: 'ch_in_3', payment_intent: 'pi_in_3', amount: 2000 });
  assert.equal(r.balance(), 2000, '+2000 −1000 refund −1000 dispute');
  // a refund after a dispute reverses nothing more either
  await r.send('charge.refunded', { id: 'ch_in_3', object: 'charge', payment_intent: 'pi_in_3', amount: 2000, amount_refunded: 2000 });
  assert.equal(r.balance(), 2000);
});

test('R6: a lost dispute raises a flag; Felix can lift the freeze from the admin (audited)', async () => {
  const r = await rig();
  await r.join();
  const dp = { id: 'dp_9', object: 'dispute', charge: 'ch_in_1', payment_intent: 'pi_in_1', amount: 5000 };
  await r.send('charge.dispute.created', dp);
  await r.send('charge.dispute.closed', { ...dp, status: 'lost' });
  assert.equal(r.t.rows("SELECT 1 FROM admin_flags WHERE kind = 'dispute_lost'").length, 1);
  const out = await r.adminSend('POST', `/api/admin/members/${r.userId}/unfreeze`, { memo: 'Spoke with the member' });
  assert.equal(out.res.status, 200);
  assert.equal(r.t.rows('SELECT credits_frozen FROM memberships')[0].credits_frozen, 0);
  assert.equal(r.t.rows("SELECT 1 FROM admin_audit WHERE action = 'credits_unfrozen'").length, 1);
});

test('R10: two refund events processed at once never reverse more than the invoice credited', async () => {
  const r = await rig({ interleave: true });
  await r.join();
  await r.send('invoice.paid', fx.invoice({ id: 'in_2', userId: r.userId, reason: 'subscription_cycle', start: T0 + 31 * DAY, end: T0 + 62 * DAY }));
  await Promise.all([
    r.send('charge.refunded', { id: 'ch_in_2', object: 'charge', payment_intent: 'pi_in_2', amount: 2000, amount_refunded: 1000 }),
    r.send('charge.refunded', { id: 'ch_in_2', object: 'charge', payment_intent: 'pi_in_2', amount: 2000, amount_refunded: 2000 }),
  ]);
  assert.equal(r.balance(), 2000, 'exactly the 2000 of in_2 reversed');
});

// ---- 7 -------------------------------------------------------------------------------

test('R7: every member renewing in the window gets the reminder, not just the first 10', async () => {
  const r = await rig();
  const end = new Date(T0 + 72 * HOUR).toISOString();
  for (let i = 0; i < 13; i++) {
    r.t.env.DB._db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, 'x')").run(`U${i}`, `m${i}@example.com`);
    r.t.env.DB._db.prepare("INSERT INTO memberships (id, user_id, stripe_subscription_id, status, kind, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', 'join', ?, 'x', 'x')")
      .run(`M${i}`, `U${i}`, `sub_${i}`, end);
  }
  r.world.stripeOn('POST', '/v1/invoices/create_preview', () => ({ amount_due: 2000 }));
  await r.cron(T0, FREQUENT_CRON);
  await r.cron(T0 + 5 * MIN, FREQUENT_CRON);
  assert.equal(r.t.rows("SELECT 1 FROM email_log WHERE template = 'renewal_reminder'").length, 13);
});

// ---- 8 -------------------------------------------------------------------------------

test('R8: if completing the welcome order fails after the draft exists, the retry completes that draft — one order', async () => {
  const r = await rig({ catalog: [catalogProduct({ id: 3, handle: 'small-candle', tags: ['catalog'], variants: [{ id: 31, price: '24.00' }] })] });
  r.world.drafts = [];
  r.world.shopifyOps.CircleDraftCreate = ({ input }) => {
    const d = { id: `gid://shopify/DraftOrder/${r.world.drafts.length + 1}`, input, status: 'OPEN' };
    r.world.drafts.push(d);
    return { draftOrderCreate: { draftOrder: { id: d.id, invoiceUrl: 'x', status: 'OPEN', order: null }, userErrors: [] } };
  };
  let failComplete = true;
  r.world.shopifyOps.CircleDraftComplete = ({ id }) => {
    if (failComplete) return new Response('timeout', { status: 504 });
    r.world.drafts.find((d) => d.id === id).status = 'COMPLETED';
    return { draftOrderComplete: { draftOrder: { id, status: 'COMPLETED', order: { id: 'gid://shopify/Order/5' } }, userErrors: [] } };
  };
  r.world.shopifyOps.CircleDraftState = ({ id }) => {
    const d = r.world.drafts.find((x) => x.id === id);
    return { draftOrder: d ? { id, status: d.status, invoiceUrl: 'x', order: d.status === 'COMPLETED' ? { id: 'gid://shopify/Order/5' } : null } : null };
  };
  const a = (await r.adminSend('POST', '/api/admin/gift-options', { kind: 'welcome', title: 'Candle', shopify_variant_gid: V(31), landed_cost_cents: 1000, shipping_class: 'S', active: true })).data.option.id;
  await r.join();
  await r.api('POST', '/api/circle/welcome', { gift_option_id: a });
  const sel = r.t.rows('SELECT id FROM gift_selections')[0].id;
  let out = await r.adminSend('POST', `/api/admin/gift-queue/${sel}/create-order`, {});
  assert.equal(out.res.status, 502);
  failComplete = false;
  out = await r.adminSend('POST', `/api/admin/gift-queue/${sel}/create-order`, {});
  assert.equal(out.res.status, 200, JSON.stringify(out.data));
  assert.equal(r.world.drafts.length, 1);
  assert.equal(r.t.rows('SELECT status FROM gift_selections')[0].status, 'order_created');
});

// ---- 9 -------------------------------------------------------------------------------

test('R9: an older snapshot processed at the same time as a newer one never wins', async () => {
  for (let round = 0; round < 3; round++) {
    const r = await rig({ interleave: true });
    await r.join();
    const base = Math.floor(T0 / 1000) + 50000;
    await Promise.all([
      deliver(r.t, stripeEvent('customer.subscription.updated', fx.subscription({ userId: r.userId }), { created: base + 1 })),
      deliver(r.t, stripeEvent('customer.subscription.updated', fx.subscription({ userId: r.userId, cancelAtPeriodEnd: true }), { created: base + 2 })),
    ]);
    assert.equal(r.t.rows('SELECT status FROM memberships')[0].status, 'canceling', `round ${round}`);
  }
});

// ---- 11 ------------------------------------------------------------------------------

test('R11: credits expire at the latest grace date across the person\'s memberships', async () => {
  const r = await rig();
  r.t.env.DB._db.prepare("INSERT INTO memberships (id, user_id, status, kind, ended_at, credits_grace_until, created_at, updated_at) VALUES ('A', ?, 'ended', 'join', ?, ?, '2026-01-01', 'x')")
    .run(r.userId, new Date(T0 - 40 * DAY).toISOString(), new Date(T0 - DAY).toISOString());
  r.t.env.DB._db.prepare("INSERT INTO memberships (id, user_id, status, kind, ended_at, credits_grace_until, created_at, updated_at) VALUES ('B', ?, 'ended', 'rejoin', ?, ?, '2026-02-01', 'x')")
    .run(r.userId, new Date(T0 - 5 * DAY).toISOString(), new Date(T0 + 25 * DAY).toISOString());
  r.t.env.DB._db.prepare("INSERT INTO credit_ledger (id, user_id, amount_cents, kind, idempotency_key, created_at) VALUES ('c1', ?, 2000, 'accrual', 'accrual:x', 'x')").run(r.userId);
  await r.cron(T0, DAILY_CRON);
  assert.equal(r.balance(), 2000);
  assert.equal(r.t.rows("SELECT status FROM memberships WHERE id = 'A'")[0].status, 'ended_expired');
  await r.cron(T0 + 26 * DAY, DAILY_CRON);
  assert.equal(r.balance(), 0);
});

// ---- 12 ------------------------------------------------------------------------------

test('R12: a Shopify error while creating the object draft keeps the claim for the by-tag check; deletion deletes open drafts', async () => {
  const r = await rig();
  const OBJ_P = 'gid://shopify/Product/900';
  const OBJ_V = 'gid://shopify/ProductVariant/9001';
  r.world.drafts = [];
  r.world.shopifyOps.CircleObjectGuard = () => ({ product: { id: OBJ_P, status: 'ACTIVE', resourcePublicationsV2: { nodes: [] },
    variants: { nodes: [{ id: OBJ_V, price: '450.00', inventoryPolicy: 'DENY', inventoryQuantity: 1, inventoryItem: { tracked: true } }] } } });
  let failDraft = true;
  r.world.shopifyOps.CircleDraftCreate = ({ input }) => {
    const d = { id: `gid://shopify/DraftOrder/${r.world.drafts.length + 1}`, input, status: 'OPEN' };
    r.world.drafts.push(d);
    if (failDraft) return new Response('timeout', { status: 504 });
    return { draftOrderCreate: { draftOrder: { id: d.id, invoiceUrl: 'https://shop/i', status: 'OPEN', order: null }, userErrors: [] } };
  };
  r.world.shopifyOps.CircleDraftByTag = ({ query }) => {
    const tag = query.replace('tag:', '');
    const d = r.world.drafts.find((x) => x.input.tags.includes(tag));
    return { draftOrders: { nodes: d ? [{ id: d.id, status: d.status, invoiceUrl: 'https://shop/i', order: null }] : [] } };
  };
  r.world.shopifyOps.CircleDraftDelete = ({ input }) => { const d = r.world.drafts.find((x) => x.id === input.id); if (d) d.status = 'DELETED'; return { draftOrderDelete: { deletedId: input.id, userErrors: [] } }; };
  await r.adminSend('PUT', '/api/admin/economics', { changes: { shipping: { M: { cents: 1500, estimate: false } } } });
  const rel = await r.adminSend('POST', '/api/admin/member-object/releases', { label: 'Obj', product_gid: OBJ_P, variant_gid: OBJ_V, price_cents: 45000,
    edition_size: 1, unit_cost_cents: 20000, shipping_class: 'M', reserve_hours: 48, opens_at: new Date(T0 - HOUR).toISOString(), closes_at: new Date(T0 + 30 * DAY).toISOString() });
  await r.adminSend('POST', `/api/admin/member-object/releases/${rel.data.release.id}/open`, {});
  await r.join();
  const out = await r.api('POST', '/api/circle/object/claim', { release_id: rel.data.release.id });
  assert.equal(out.res.status, 503);
  assert.equal(r.t.rows('SELECT status FROM member_object_claims')[0].status, 'creating', 'kept for the by-tag recovery');
  await r.cron(T0 + 11 * MIN, FREQUENT_CRON);
  const c = r.t.rows('SELECT status, draft_order_gid FROM member_object_claims')[0];
  assert.deepEqual([c.status, c.draft_order_gid], ['invoiced', 'gid://shopify/DraftOrder/1'], 'the draft Shopify did make is adopted, no second one');
  // deleting the account deletes that open draft
  r.world.stripeOn('DELETE', '/v1/subscriptions/:id', (call, id) => ({ id, status: 'canceled' }));
  await r.t.env.DB.prepare('UPDATE sessions SET step_up_at = ?1').bind(new Date(T0 + 11 * MIN).toISOString()).run();
  r.t.setNow(T0 + 12 * MIN);
  const del = await r.t.call(new Request('https://w.dev/api/account', { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }),
    headers: { ...trusted, Cookie: r.s.cookie, 'Content-Type': 'application/json', 'Content-Length': '20' } }));
  assert.equal(del.status, 202);
  assert.equal(r.world.drafts[0].status, 'DELETED');
});

// ---- 13 ------------------------------------------------------------------------------

test('R13: a double-submitted credit adjustment with the same Idempotency-Key is booked once', async () => {
  const r = await rig();
  await r.join();
  const a = await r.adminSend('POST', '/api/admin/credits/adjust', { user_id: r.userId, amount_cents: 500, memo: 'goodwill' }, { 'Idempotency-Key': 'adj-1' });
  const b = await r.adminSend('POST', '/api/admin/credits/adjust', { user_id: r.userId, amount_cents: 500, memo: 'goodwill' }, { 'Idempotency-Key': 'adj-1' });
  assert.equal(a.res.status, 201);
  assert.equal(b.res.status, 200);
  assert.equal(r.balance(), 2500);
});
