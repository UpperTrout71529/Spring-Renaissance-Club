// S7: Saved (wishlist) and Held for you — idempotent saves, "No longer
// available", per-user isolation, storefront calls, holds, and the import of
// "Let us hold these for you" reservations from customer tags.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post } from './harness.mjs';
import { reserveTagRemainders } from '../src/shopify/reserve-import.js';
import { T0, MIN, trusted, makeWorld, setup, signIn, body } from './api-helpers.mjs';

const CLARA = 'gid://shopify/Customer/7';
const STORE = 'https://springrenaissance.store';

const product = (n, handle, extra = {}) => ({
  id: `gid://shopify/Product/${n}`, handle, title: handle.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
  status: 'ACTIVE', onlineStoreUrl: `${STORE}/products/${handle}`,
  featuredMedia: { preview: { image: { url: `https://cdn.shopify.com/${handle}.jpg` } } },
  priceRangeV2: { minVariantPrice: { amount: '88.0', currencyCode: 'USD' } },
  variants: { nodes: [{ availableForSale: true }] }, ...extra,
});

function shopWorld({ tags = [] } = {}) {
  const products = [
    product(1, 'pierre-blanche'),
    product(2, 'the-gourd'),
    product(3, 'old-vase', { status: 'ARCHIVED', onlineStoreUrl: null }),
    product(4, 'sold-out', { variants: { nodes: [{ availableForSale: false }] } }),
  ];
  const world = makeWorld({ shopifyCustomers: [{ id: CLARA, email: 'clara@example.com', tags }] });
  const base = world.fetch;
  world.products = products;
  world.productQueries = 0;
  world.fail = false;
  world.fetch = async (url, init = {}) => {
    if (!String(url).includes('myshopify.com')) return base(url, init);
    const { query, variables } = JSON.parse(init.body);
    if (/ProductByHandle|ProductsByIds|CustomerTags|CustomerOrders/.test(query)) {
      if (world.fail) return new Response('', { status: 502 });
      if (query.includes('ProductByHandle')) {
        world.productQueries++;
        return Response.json({ data: { productByIdentifier: world.products.find((p) => p.handle === variables.handle) || null } });
      }
      if (query.includes('ProductsByIds')) {
        world.productQueries++;
        return Response.json({ data: { nodes: variables.ids.map((id) => world.products.find((p) => p.id === id) || null) } });
      }
      if (query.includes('CustomerTags')) {
        const c = world.shopify.customers.find((x) => x.id === variables.id);
        return Response.json({ data: { customer: c ? { id: c.id, tags: c.tags } : null } });
      }
      return Response.json({ data: { customer: { orders: { nodes: [{
        id: 'gid://shopify/Order/5001', name: '#1001', createdAt: '2026-10-10T10:00:00Z',
        displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', currentSubtotalLineItemsQuantity: 1,
        totalPriceSet: { shopMoney: { amount: '88.0', currencyCode: 'USD' } }, fulfillments: [],
        lineItems: { nodes: [{ image: null, sellingPlan: null, product: { handle: 'pierre-blanche', tags: [], collections: { nodes: [{ handle: 'objects' }] }, srRunHide: null } }] },
      }], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    }
    if (query.includes('customers(')) {
      // FindCustomer, with tags (the S2 fake answers without them).
      const email = /email:"(.*)"/.exec(variables.query)[1];
      const c = world.shopify.customers.find((x) => x.email === email);
      return Response.json({ data: { customers: { nodes: c ? [{ id: c.id, numberOfOrders: '0', tags: c.tags }] : [] } } });
    }
    return base(url, init);
  };
  return world;
}

const del = (path, headers) => new Request('https://w.dev' + path, { method: 'DELETE', headers });

async function clara(t) {
  const { cookie } = await signIn(t);
  return { Cookie: cookie };
}

test('S7-1: saving is idempotent and records wishlist_added once', async () => {
  const t = setup({ world: shopWorld() });
  const h = await clara(t);
  for (let i = 0; i < 2; i++) {
    const res = await t.call(post('/api/wishlist', { product_handle: 'pierre-blanche' }, { ...trusted, ...h }));
    assert.equal(res.status, 201);
    assert.deepEqual(await body(res), { item: { product_handle: 'pierre-blanche' } });
  }
  assert.equal(t.rows('SELECT COUNT(*) AS n FROM wishlist_items')[0].n, 1);
  assert.equal(t.rows("SELECT COUNT(*) AS n FROM events WHERE name = 'wishlist_added'")[0].n, 1);
  assert.equal(t.rows('SELECT product_gid FROM wishlist_items')[0].product_gid, 'gid://shopify/Product/1');
});

test('S7-2: a malformed handle → 400; an unknown product → 404', async () => {
  const t = setup({ world: shopWorld() });
  const h = await clara(t);
  for (const bad of ['', 'Has Spaces', '../x', 42]) {
    const res = await t.call(post('/api/wishlist', { product_handle: bad }, { ...trusted, ...h }));
    assert.equal(res.status, 400, String(bad));
  }
  assert.equal((await t.call(post('/api/wishlist', { product_handle: 'no-such-thing' }, { ...trusted, ...h }))).status, 404);
});

test('S7-3: the list carries Shopify data; archived, sold out and deleted pieces are "no longer available"', async () => {
  const world = shopWorld();
  const t = setup({ world });
  const h = await clara(t);
  for (const handle of ['pierre-blanche', 'old-vase', 'sold-out', 'the-gourd']) {
    await t.call(post('/api/wishlist', { product_handle: handle }, { ...trusted, ...h }));
  }
  world.products = world.products.filter((p) => p.handle !== 'the-gourd'); // deleted from Shopify
  await t.env.CLIENT_KV.delete('product:v2:gid://shopify/Product/2');
  const { items } = await body(await t.call(get('/api/wishlist', h)));
  const by = Object.fromEntries(items.map((i) => [i.product_handle, i]));
  assert.deepEqual(
    { title: by['pierre-blanche'].title, price: by['pierre-blanche'].price_cents, img: by['pierre-blanche'].image_url, ok: by['pierre-blanche'].available },
    { title: 'Pierre Blanche', price: 8800, img: 'https://cdn.shopify.com/pierre-blanche.jpg', ok: true },
  );
  assert.equal(by['old-vase'].available, false);
  assert.equal(by['sold-out'].available, false);
  assert.equal(by['the-gourd'].available, false);
  assert.equal(by['the-gourd'].title, null);
});

test('S7-4: removing is idempotent; handles list for the storefront hearts', async () => {
  const t = setup({ world: shopWorld() });
  const h = await clara(t);
  await t.call(post('/api/wishlist', { product_handle: 'pierre-blanche' }, { ...trusted, ...h }));
  await t.call(post('/api/wishlist', { product_handle: 'the-gourd' }, { ...trusted, ...h }));
  assert.deepEqual((await body(await t.call(get('/api/wishlist/handles', h)))).handles.sort(), ['pierre-blanche', 'the-gourd']);
  assert.equal((await t.call(del('/api/wishlist/pierre-blanche', { ...trusted, ...h }))).status, 204);
  assert.equal((await t.call(del('/api/wishlist/pierre-blanche', { ...trusted, ...h }))).status, 204);
  assert.deepEqual((await body(await t.call(get('/api/wishlist/handles', h)))).handles, ['the-gourd']);
  assert.equal(t.rows("SELECT COUNT(*) AS n FROM events WHERE name = 'wishlist_removed'")[0].n, 1);
});

test("S7-5: one person's saved pieces are invisible to another", async () => {
  const t = setup({ world: shopWorld() });
  const h = await clara(t);
  await t.call(post('/api/wishlist', { product_handle: 'pierre-blanche' }, { ...trusted, ...h }));
  t.setNow(T0 + 11 * MIN);
  const { cookie } = await signIn(t, 'david@example.com');
  assert.deepEqual(await body(await t.call(get('/api/wishlist', { Cookie: cookie }))), { items: [] });
  await t.call(del('/api/wishlist/pierre-blanche', { ...trusted, Cookie: cookie }));
  assert.equal(t.rows('SELECT COUNT(*) AS n FROM wishlist_items')[0].n, 1);
});

test('S7-6: the storefront may save (same site, CORS granted to springrenaissance.store)', async () => {
  const t = setup({ world: shopWorld() });
  const h = await clara(t);
  const res = await t.call(post('/api/wishlist', { product_handle: 'pierre-blanche', source: 'storefront' }, { Origin: STORE, 'X-SR-Client': 'portal', ...h }));
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), STORE);
  const ev = t.rows("SELECT props_json FROM events WHERE name = 'wishlist_added'")[0];
  assert.deepEqual(JSON.parse(ev.props_json), { product_handle: 'pierre-blanche', source: 'storefront' });
  // Without a session the storefront gets 401 and sends the visitor to sign in.
  assert.equal((await t.call(post('/api/wishlist', { product_handle: 'pierre-blanche' }, { Origin: STORE, 'X-SR-Client': 'portal' }))).status, 401);
});

test('S7-7: product data is cached for 10 minutes', async () => {
  const world = shopWorld();
  const t = setup({ world });
  const h = await clara(t);
  await t.call(post('/api/wishlist', { product_handle: 'pierre-blanche' }, { ...trusted, ...h }));
  const before = world.productQueries;
  await t.call(get('/api/wishlist', h));
  await t.call(get('/api/wishlist', h));
  assert.equal(world.productQueries, before + 1);
});

test('S7-8: holds — one open hold per piece; listed with titles and open pre-orders', async () => {
  const t = setup({ world: shopWorld() });
  const h = await clara(t);
  for (let i = 0; i < 2; i++) {
    assert.equal((await t.call(post('/api/holds', { product_handle: 'the-gourd', source: 'storefront' }, { ...trusted, ...h }))).status, 201);
  }
  const res = await body(await t.call(get('/api/holds', h)));
  assert.equal(res.holds.length, 1);
  assert.deepEqual([res.holds[0].kind, res.holds[0].product_handle, res.holds[0].title, res.holds[0].status], ['object_hold', 'the-gourd', 'The Gourd', 'open']);
  assert.equal(t.rows('SELECT source FROM holds')[0].source, 'storefront_form');
  assert.deepEqual(res.preorders.map((p) => [p.order_id, p.name]), [['5001', '#1001']]);
});

test('S7-9: reservations from "Let us hold these for you" tags are imported at sign-in, once', async () => {
  const world = shopWorld({ tags: ['reserve', 'reserve-the-gourd-bone', 'reserve-pierre-blanche', 'reserve-no-such-piece', 'vip'] });
  const t = setup({ world });
  await signIn(t);
  const rows = () => t.rows("SELECT product_handle, source, status FROM holds ORDER BY product_handle").map((r) => ({ ...r }));
  assert.deepEqual(rows(), [
    { product_handle: 'pierre-blanche', source: 'import', status: 'open' },
    { product_handle: 'the-gourd', source: 'import', status: 'open' },
  ]);
  // Next sign-in: nothing duplicated; a reservation made since then is picked up.
  world.shopify.customers[0].tags.push('reserve-old-vase');
  t.setNow(T0 + 11 * MIN);
  await signIn(t);
  assert.deepEqual(rows().map((r) => r.product_handle), ['old-vase', 'pierre-blanche', 'the-gourd']);
});

test('S7-10: reserveTagRemainders keeps only reserve-* tags', () => {
  assert.deepEqual(reserveTagRemainders(['reserve', 'reserve-the-gourd-bone', 'RESERVE-X', 'vip', 'reserve-', 7]), ['the-gourd-bone']);
});

test('S7-11: Shopify down → saving and the list answer 503; holds still list without titles', async () => {
  const world = shopWorld();
  const t = setup({ world });
  const h = await clara(t);
  await t.call(post('/api/wishlist', { product_handle: 'pierre-blanche' }, { ...trusted, ...h }));
  await t.call(post('/api/holds', { product_handle: 'the-gourd' }, { ...trusted, ...h }));
  await t.env.CLIENT_KV.delete('product:v2:gid://shopify/Product/1');
  await t.env.CLIENT_KV.delete('product_by_handle:v2:the-gourd');
  await t.env.CLIENT_KV.delete('orders:v1:' + t.rows('SELECT id FROM users')[0].id + ':-');
  world.fail = true;
  const realError = console.error;
  console.error = () => {};
  try {
    const save = await t.call(post('/api/wishlist', { product_handle: 'the-gourd' }, { ...trusted, ...h }));
    assert.equal(save.status, 503);
    assert.equal((await body(save)).error.code, 'saved_unavailable');
    assert.equal((await t.call(get('/api/wishlist', h))).status, 503);
    const holds = await t.call(get('/api/holds', h));
    assert.equal(holds.status, 200);
    const b = await body(holds);
    assert.equal(b.holds[0].title, null);
    assert.deepEqual(b.preorders, []);
  } finally {
    console.error = realError;
  }
});

test('S7-12: saved and holds need a session', async () => {
  const t = setup({ world: shopWorld() });
  for (const req of [get('/api/wishlist'), get('/api/holds'), get('/api/wishlist/handles'), post('/api/holds', { product_handle: 'x' }, trusted)]) {
    assert.equal((await t.call(req)).status, 401);
  }
});
