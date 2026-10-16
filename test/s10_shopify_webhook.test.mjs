// S10: Shopify webhook (spec §8.5, §9.2.8). orders/create → `order_placed
// { tier, is_repeat, used_gift_card }` for the repeat-purchase metric, and
// the buyer's open holds on the bought pieces become `converted`.
// HMAC over the raw body; dedupe by X-Shopify-Event-Id in webhook_events;
// received → processed, or failed + 500 so Shopify retries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { T0, makeWorld, setup, signIn, body } from './api-helpers.mjs';

const SECRET = 'shpss_webhook_secret';
const ORDER_GID = 'gid://shopify/Order/5001';

function order({ customer = 'gid://shopify/Customer/7', email = 'clara@example.com', count = '1', gateways = ['shopify_payments'], handles = ['kouros'] } = {}) {
  return {
    id: ORDER_GID, email, paymentGatewayNames: gateways,
    customer: customer ? { id: customer, numberOfOrders: count } : null,
    lineItems: { nodes: handles.map((h, i) => ({ product: { id: `gid://shopify/Product/${i + 1}`, handle: h } })) },
  };
}

function rig({ shopifyOrder = order(), shopifyFails = false, secret = SECRET } = {}) {
  const world = makeWorld({ shopifyCustomers: [{ id: 'gid://shopify/Customer/7', email: 'clara@example.com' }] });
  const inner = world.fetch;
  world.orderQueries = [];
  world.fetch = async (url, init = {}) => {
    if (String(url).includes('.myshopify.com/admin/api/')) {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes('OrderPlaced')) {
        world.orderQueries.push(variables.id);
        if (shopifyFails) return new Response('oops', { status: 502 });
        return Response.json({ data: { order: shopifyOrder } });
      }
    }
    return inner(url, init);
  };
  const t = setup({ world, envOverrides: { SHOPIFY_WEBHOOK_SECRET: secret } });
  return t;
}

function delivery({ topic = 'orders/create', eventId = 'evt-1', payload = { id: 5001, admin_graphql_api_id: ORDER_GID, created_at: '2026-10-15T08:30:00-04:00' }, hmac } = {}) {
  const raw = JSON.stringify(payload);
  const sig = hmac ?? createHmac('sha256', SECRET).update(raw, 'utf8').digest('base64');
  return new Request('https://w.dev/webhooks/shopify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Shopify-Topic': topic, 'X-Shopify-Event-Id': eventId,
      'X-Shopify-Hmac-Sha256': sig, 'X-Shopify-Shop-Domain': 'example.myshopify.com',
    },
    body: raw,
  });
}

const placed = (t) => t.rows("SELECT id, user_id, props_json, created_at FROM events WHERE name = 'order_placed'")
  .map((r) => ({ id: r.id, user_id: r.user_id, props: JSON.parse(r.props_json), created_at: r.created_at }));
const ledger = (t) => t.rows('SELECT event_id, source, type, status, error FROM webhook_events').map((r) => ({ ...r }));

test('orders/create from a Club member: order_placed with tier, is_repeat, used_gift_card; webhook processed', async () => {
  const t = rig({ shopifyOrder: order({ count: '3', gateways: ['gift_card', 'shopify_payments'] }) });
  await signIn(t);
  const user = t.rows('SELECT id FROM users')[0];
  const res = await t.call(delivery());
  assert.equal(res.status, 200);
  assert.deepEqual(t.world.orderQueries, [ORDER_GID]);
  const [e] = placed(t);
  assert.equal(e.user_id, user.id);
  assert.deepEqual(e.props, { order_id: '5001', customer_id: '7', tier: 'club', is_repeat: true, used_gift_card: true });
  assert.equal(e.created_at, '2026-10-15T12:30:00.000Z'); // the order's own time, in UTC
  assert.deepEqual(ledger(t), [{ event_id: 'evt-1', source: 'shopify', type: 'orders/create', status: 'processed', error: null }]);
});

test('a buyer without an account: tier none, no user; first order is not a repeat', async () => {
  const t = rig({ shopifyOrder: order({ customer: 'gid://shopify/Customer/99', email: 'guest@example.com', count: '1' }) });
  await t.call(delivery());
  const [e] = placed(t);
  assert.equal(e.user_id, null);
  assert.deepEqual(e.props, { order_id: '5001', customer_id: '99', tier: 'none', is_repeat: false, used_gift_card: false });
});

test('the account is found by email when Shopify ids are not linked yet', async () => {
  const t = rig({ shopifyOrder: order({ customer: 'gid://shopify/Customer/55', email: 'Clara@Example.com' }) });
  await signIn(t);
  await t.call(delivery());
  assert.equal(placed(t)[0].props.tier, 'club');
});

test('the linked Shopify customer wins over another account with the order email', async () => {
  const t = rig({ shopifyOrder: order({ customer: 'gid://shopify/Customer/7', email: 'david@example.com' }) });
  await signIn(t, 'david@example.com');
  await signIn(t, 'clara@example.com'); // clara is linked to Customer/7
  const clara = t.rows("SELECT id, shopify_customer_id FROM users WHERE email = 'clara@example.com'")[0];
  assert.equal(clara.shopify_customer_id, 'gid://shopify/Customer/7');
  await t.call(delivery());
  assert.equal(placed(t)[0].user_id, clara.id);
});

test('a deleted account does not get the order', async () => {
  const t = rig();
  await signIn(t);
  t.env.DB.prepare("UPDATE users SET deleted_at = ?1").bind(new Date(T0).toISOString()).run();
  await t.call(delivery());
  assert.equal(placed(t)[0].user_id, null);
});

test("the buyer's open holds on the bought pieces become converted; others stay", async () => {
  const t = rig({ shopifyOrder: order({ handles: ['kouros', 'gift-card'] }) });
  await signIn(t);
  const user = t.rows('SELECT id FROM users')[0];
  const ins = (id, kind, handle, status = 'open', uid = user.id) => t.env.DB.prepare(
    "INSERT INTO holds (id, user_id, kind, product_handle, source, status, created_at) VALUES (?1, ?2, ?3, ?4, 'portal', ?5, ?6)"
  ).bind(id, uid, kind, handle, status, new Date(T0).toISOString()).run();
  await ins('H1', 'object_hold', 'kouros');
  await ins('H2', 'object_hold', 'ember');
  await ins('H3', 'circle_waitlist', null);
  await ins('H4', 'object_hold', 'kouros', 'released');
  await t.call(delivery());
  const holds = Object.fromEntries(t.rows('SELECT id, status FROM holds').map((h) => [h.id, h.status]));
  assert.deepEqual(holds, { H1: 'converted', H2: 'open', H3: 'open', H4: 'released' });
});

test('a redelivery of the same event is a no-op: one event, one ledger row, Shopify asked once', async () => {
  const t = rig();
  assert.equal((await t.call(delivery())).status, 200);
  const again = await t.call(delivery());
  assert.equal(again.status, 200);
  assert.equal((await body(again)).duplicate, true);
  assert.equal(placed(t).length, 1);
  assert.equal(ledger(t).length, 1);
  assert.equal(t.world.orderQueries.length, 1);
});

test('the same order under a new event id still gives one order_placed', async () => {
  const t = rig();
  await t.call(delivery({ eventId: 'evt-1' }));
  assert.equal((await t.call(delivery({ eventId: 'evt-2' }))).status, 200);
  assert.equal(placed(t).length, 1);
  assert.deepEqual(ledger(t).map((l) => l.status), ['processed', 'processed']);
});

test('Shopify unavailable → failed and 500 (Shopify retries); the retry then processes', async () => {
  const t = rig({ shopifyFails: true });
  const res = await t.call(delivery());
  assert.equal(res.status, 500);
  assert.equal(ledger(t)[0].status, 'failed');
  assert.match(ledger(t)[0].error, /shopify/);
  assert.equal(placed(t).length, 0);

  const ok = rig();
  ok.env.DB = t.env.DB; // same database, Shopify back
  assert.equal((await ok.call(delivery())).status, 200);
  assert.equal(ledger(ok)[0].status, 'processed');
  assert.equal(placed(ok).length, 1);
});

test('wrong HMAC → 401 and nothing is written', async () => {
  const t = rig();
  const res = await t.call(delivery({ hmac: createHmac('sha256', 'other').update('x').digest('base64') }));
  assert.equal(res.status, 401);
  assert.deepEqual(ledger(t), []);
});

test('a tampered body under a valid signature → 401', async () => {
  const t = rig();
  const good = delivery();
  const tampered = new Request(good.url, { method: 'POST', headers: good.headers, body: JSON.stringify({ id: 6, admin_graphql_api_id: 'gid://shopify/Order/6' }) });
  assert.equal((await t.call(tampered)).status, 401);
});

test('no SHOPIFY_WEBHOOK_SECRET configured → 401 (fail closed)', async () => {
  const t = rig({ secret: null });
  assert.equal((await t.call(delivery())).status, 401);
});

test('missing event id or topic → 400', async () => {
  const t = rig();
  const d = delivery();
  const h = new Headers(d.headers);
  h.delete('X-Shopify-Event-Id');
  assert.equal((await t.call(new Request(d.url, { method: 'POST', headers: h, body: await d.clone().text() }))).status, 400);
});

test('other topics are acknowledged and marked ignored (V1 handles orders/create only)', async () => {
  const t = rig();
  const res = await t.call(delivery({ topic: 'customers/update', eventId: 'evt-9' }));
  assert.equal(res.status, 200);
  assert.equal(ledger(t)[0].status, 'ignored');
  assert.equal(t.world.orderQueries.length, 0);
});

test('webhooks need no Origin or X-SR-Client (server to server)', async () => {
  const t = rig();
  const res = await t.call(delivery());
  assert.equal(res.status, 200);
});
