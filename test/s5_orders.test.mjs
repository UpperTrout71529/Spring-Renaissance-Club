// S5: orders and tracking from Shopify — ownership (a foreign :id is a 404),
// pagination, split shipments, no invented dates, KV cache, failures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from './harness.mjs';
import { orderStatus, toCents, isPreorderLine, numericId } from '../src/shopify/orders.js';
import { T0, MIN, makeWorld, setup, signIn, body } from './api-helpers.mjs';

const CLARA = 'gid://shopify/Customer/7';
const OTHER = 'gid://shopify/Customer/8';

function order(n, extra = {}) {
  return {
    id: `gid://shopify/Order/${5000 + n}`,
    name: `#${1000 + n}`,
    createdAt: new Date(Date.parse('2026-09-01T10:00:00Z') + n * 3600_000).toISOString(),
    customer: { id: CLARA },
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    currentSubtotalLineItemsQuantity: 1,
    totalPriceSet: { shopMoney: { amount: '88.0', currencyCode: 'USD' } },
    shippingAddress: { city: 'Brooklyn' },
    lineItems: { nodes: [{ title: 'Pierre Blanche', variantTitle: null, quantity: 1, image: { url: `https://cdn.shopify.com/p${n}.jpg` }, originalUnitPriceSet: { shopMoney: { amount: '88.0', currencyCode: 'USD' } }, sellingPlan: null }] },
    fulfillments: [],
    ...extra,
  };
}

function shopWorld() {
  const orders = Array.from({ length: 23 }, (_, i) => order(i + 1));
  orders[22] = order(23, {
    displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
    currentSubtotalLineItemsQuantity: 3,
    totalPriceSet: { shopMoney: { amount: '1234.5', currencyCode: 'USD' } },
    fulfillments: [
      { displayStatus: 'IN_TRANSIT', createdAt: '2026-10-02T09:00:00Z', inTransitAt: '2026-10-03T09:00:00Z', deliveredAt: null, estimatedDeliveryAt: '2026-10-21T00:00:00Z',
        trackingInfo: [{ company: 'UPS', number: '1Z001', url: 'https://ups.example/1Z001' }, { company: 'UPS', number: '1Z002', url: 'https://ups.example/1Z002' }] },
      { displayStatus: 'FULFILLED', createdAt: '2026-10-04T09:00:00Z', inTransitAt: null, deliveredAt: null, estimatedDeliveryAt: null,
        trackingInfo: [{ company: 'USPS', number: '9400', url: null }] },
      { displayStatus: 'CANCELED', createdAt: '2026-10-01T09:00:00Z', inTransitAt: null, deliveredAt: null, estimatedDeliveryAt: null,
        trackingInfo: [{ company: 'FedEx', number: 'void', url: null }] },
    ],
  });
  orders[21] = order(22, { displayFinancialStatus: 'REFUNDED' });
  orders[20] = order(21, {
    displayFulfillmentStatus: 'FULFILLED',
    fulfillments: [{ displayStatus: 'DELIVERED', createdAt: '2026-09-20T00:00:00Z', inTransitAt: null, deliveredAt: '2026-09-25T00:00:00Z', estimatedDeliveryAt: null, trackingInfo: [] }],
  });
  const foreign = order(99, { customer: { id: OTHER } });

  const world = makeWorld({ shopifyCustomers: [{ id: CLARA, email: 'clara@example.com', numberOfOrders: '23' }] });
  const base = world.fetch;
  world.orderQueries = 0;
  world.fail = false;
  world.fetch = async (url, init = {}) => {
    if (String(url).includes('myshopify.com') && /CustomerOrders|OrderDetail/.test(init.body)) {
      world.orderQueries++;
      if (world.fail) return new Response('', { status: 502 });
      const { query, variables } = JSON.parse(init.body);
      if (query.includes('CustomerOrders')) {
        const mine = orders.filter((o) => o.customer.id === variables.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const start = variables.after ? Number(Buffer.from(variables.after, 'base64').toString()) : 0;
        const page = mine.slice(start, start + variables.first);
        const next = start + variables.first;
        return Response.json({ data: { customer: { orders: {
          nodes: page.map((o) => ({ ...o, fulfillments: o.fulfillments.map((f) => ({ displayStatus: f.displayStatus })) })),
          pageInfo: { hasNextPage: next < mine.length, endCursor: page.length ? Buffer.from(String(next)).toString('base64') : null },
        } } } });
      }
      const all = [...orders, foreign];
      const found = all.find((o) => o.id === variables.id) || null;
      return Response.json({ data: { order: found } });
    }
    return base(url, init);
  };
  return world;
}

async function clara(t) {
  const { cookie } = await signIn(t);
  return { Cookie: cookie };
}

test('S5-1: orders page by 10, newest first, with a cursor until the end', async () => {
  const t = setup({ world: shopWorld() });
  const h = await clara(t);
  const seen = [];
  let cursor = null;
  const sizes = [];
  do {
    const res = await t.call(get(`/api/orders${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, h));
    assert.equal(res.status, 200);
    const page = await body(res);
    sizes.push(page.orders.length);
    seen.push(...page.orders.map((o) => o.name));
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(sizes, [10, 10, 3]);
  assert.equal(new Set(seen).size, 23);
  assert.equal(seen[0], '#1023');
  assert.equal(seen.at(-1), '#1001');
});

test('S5-2: list items carry integer cents, a status label and the first image', async () => {
  const t = setup({ world: shopWorld() });
  const h = await clara(t);
  const { orders } = await body(await t.call(get('/api/orders', h)));
  const [split, refunded, delivered, plain] = orders;
  assert.deepEqual(split, {
    id: '5023', name: '#1023', created_at: split.created_at, total_cents: 123450, currency: 'USD',
    financial_status: 'PAID', fulfillment_status: 'PARTIALLY_FULFILLED', status: 'shipped',
    is_preorder: false, thumb_url: 'https://cdn.shopify.com/p23.jpg', items_count: 3,
  });
  assert.equal(refunded.status, 'refunded');
  assert.equal(delivered.status, 'delivered');
  assert.equal(plain.status, 'processing');
  assert.equal(plain.total_cents, 8800);
});

test('S5-3: a split shipment shows every tracking number; cancelled ones are dropped', async () => {
  const t = setup({ world: shopWorld() });
  const h = await clara(t);
  const res = await t.call(get('/api/orders/5023', h));
  assert.equal(res.status, 200);
  const { order } = await body(res);
  assert.deepEqual(order.fulfillments.map((f) => [f.carrier, f.tracking_number]), [['UPS', '1Z001'], ['UPS', '1Z002'], ['USPS', '9400']]);
  assert.equal(order.fulfillments[0].tracking_url, 'https://ups.example/1Z001');
  assert.equal(order.fulfillments[0].shipped_at, '2026-10-03T09:00:00Z');
  assert.equal(order.fulfillments[0].estimated_delivery_at, '2026-10-21T00:00:00Z');
  // No date in Shopify → no date in the API (the UI then shows none).
  assert.equal(order.fulfillments[2].estimated_delivery_at, null);
  assert.equal(order.fulfillments[2].tracking_url, null);
  assert.equal(order.shipping_city, 'Brooklyn');
  assert.deepEqual(order.line_items[0], {
    title: 'Pierre Blanche', variant_title: null, qty: 1, price_cents: 8800,
    image_url: 'https://cdn.shopify.com/p23.jpg', is_preorder: false,
  });
});

test("S5-4: someone else's order id → 404, as does a missing or malformed one", async () => {
  const t = setup({ world: shopWorld() });
  const h = await clara(t);
  for (const id of ['5099', '777777', 'abc', '1;DROP']) {
    const res = await t.call(get(`/api/orders/${id}`, h));
    assert.equal(res.status, 404, id);
    assert.equal((await body(res)).error.code, 'not_found');
  }
});

test('S5-5: no linked Shopify customer → an empty list and 404 on any id', async () => {
  const world = shopWorld();
  const t = setup({ world, envOverrides: { SHOPIFY_SHOP: undefined } });
  const realError = console.error;
  console.error = () => {};
  try {
    const h = await clara(t);
    assert.deepEqual(await body(await t.call(get('/api/orders', h))), { orders: [], next_cursor: null });
    assert.equal((await t.call(get('/api/orders/5023', h))).status, 404);
  } finally {
    console.error = realError;
  }
});

test('S5-6: responses are cached per user for 5 minutes', async () => {
  const world = shopWorld();
  const t = setup({ world });
  const h = await clara(t);
  await t.call(get('/api/orders', h));
  await t.call(get('/api/orders', h));
  await t.call(get('/api/orders/5023', h));
  await t.call(get('/api/orders/5023', h));
  assert.equal(world.orderQueries, 2);
  const keys = [...t.env.CLIENT_KV._m.keys()].filter((k) => k.startsWith('order'));
  const userId = t.rows('SELECT id FROM users')[0].id;
  assert.ok(keys.length === 2 && keys.every((k) => k.includes(userId)), keys.join());
});

test('S5-7: Shopify failing → 503 orders_unavailable, nothing cached', async () => {
  const world = shopWorld();
  const t = setup({ world });
  const h = await clara(t);
  world.fail = true;
  const realError = console.error;
  console.error = () => {};
  try {
    const res = await t.call(get('/api/orders', h));
    assert.equal(res.status, 503);
    assert.equal((await body(res)).error.code, 'orders_unavailable');
    assert.equal((await t.call(get('/api/orders/5023', h))).status, 503);
  } finally {
    console.error = realError;
  }
  world.fail = false;
  assert.equal((await t.call(get('/api/orders', h))).status, 200);
});

test('S5-8: orders need a session', async () => {
  const t = setup({ world: shopWorld() });
  assert.equal((await t.call(get('/api/orders'))).status, 401);
  assert.equal((await t.call(get('/api/orders/5023'))).status, 401);
});

test('S5-9: toCents is exact; numericId reads the gid', () => {
  assert.equal(toCents('88.0'), 8800);
  assert.equal(toCents('1234.5'), 123450);
  assert.equal(toCents('0.07'), 7);
  assert.equal(toCents('19.999'), 1999);
  assert.equal(toCents('100'), 10000);
  assert.equal(toCents('abc'), null);
  assert.equal(numericId('gid://shopify/Order/5023'), '5023');
});

test('S5-10: status labels follow Shopify; pre-order only before shipping', () => {
  assert.equal(orderStatus({ financial: 'REFUNDED', fulfillment: 'FULFILLED', fulfillments: [{ displayStatus: 'DELIVERED' }] }), 'refunded');
  assert.equal(orderStatus({ financial: 'PAID', fulfillment: 'FULFILLED', fulfillments: [{ displayStatus: 'DELIVERED' }, { displayStatus: 'DELIVERED' }] }), 'delivered');
  assert.equal(orderStatus({ financial: 'PAID', fulfillment: 'PARTIALLY_FULFILLED', fulfillments: [{ displayStatus: 'DELIVERED' }] }), 'shipped');
  assert.equal(orderStatus({ financial: 'PAID', fulfillment: 'UNFULFILLED', fulfillments: [], isPreorder: true }), 'preorder');
  assert.equal(orderStatus({ financial: 'PAID', fulfillment: 'UNFULFILLED', fulfillments: [{ displayStatus: 'CANCELED' }] }), 'processing');
  assert.equal(isPreorderLine({ sellingPlan: { name: 'Pre-order', sellingPlanId: 'x' } }), true);
  assert.equal(isPreorderLine({ sellingPlan: null }), false);
});

test("S5-11: a cached order is never served to another user", async () => {
  const t = setup({ world: shopWorld() });
  const h = await clara(t);
  assert.equal((await t.call(get('/api/orders/5023', h))).status, 200); // now cached
  t.setNow(T0 + 11 * MIN);
  const { cookie } = await signIn(t, 'david@example.com');
  const res = await t.call(get('/api/orders/5023', { Cookie: cookie }));
  assert.equal(res.status, 404);
});
