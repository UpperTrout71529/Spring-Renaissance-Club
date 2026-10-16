// S8: the Circle teaser data, the waitlist (+ Shopify tag once) and
// "Not now" for 30 days.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post } from './harness.mjs';
import { memberPriceCents, memberPriceEligible } from '../src/shopify/products.js';
import { T0, MIN, DAY, trusted, makeWorld, setup, signIn, body } from './api-helpers.mjs';

const CLARA = 'gid://shopify/Customer/7';
const STORE = 'https://springrenaissance.store';

const product = (n, handle, price, extra = {}) => ({
  id: `gid://shopify/Product/${n}`, handle, title: handle, status: 'ACTIVE', onlineStoreUrl: `${STORE}/products/${handle}`,
  isGiftCard: false, tags: [], collections: { nodes: [{ handle: 'objects' }] },
  featuredMedia: null, priceRangeV2: { minVariantPrice: { amount: price, currencyCode: 'USD' } },
  variants: { nodes: [{ availableForSale: true }] }, ...extra,
});

function world() {
  const w = makeWorld({ shopifyCustomers: [{ id: CLARA, email: 'clara@example.com', tags: [] }] });
  const base = w.fetch;
  w.products = [
    product(1, 'pierre-blanche', '88.0'),
    product(2, 'le-vase-livre', '48.0', { tags: ['catalog'], collections: { nodes: [{ handle: 'catalog' }] } }),
    product(3, 'sold-out', '120.0', { variants: { nodes: [{ availableForSale: false }] } }),
    product(4, 'the-gourd', '49.99'),
    product(5, 'gift-card', '50.0', { isGiftCard: true }),
    product(6, 'carafe', '210.0'),
    product(7, 'flacon', '64.0'),
  ];
  w.tagCalls = [];
  w.fail = false;
  w.fetch = async (url, init = {}) => {
    if (!String(url).includes('myshopify.com')) return base(url, init);
    const { query, variables } = JSON.parse(init.body);
    if (w.fail && /tagsAdd|CustomerTags/.test(query)) return new Response('', { status: 502 });
    if (query.includes('ProductByHandle')) return Response.json({ data: { productByIdentifier: w.products.find((p) => p.handle === variables.handle) || null } });
    if (query.includes('ProductsByIds')) return Response.json({ data: { nodes: variables.ids.map((id) => w.products.find((p) => p.id === id) || null) } });
    if (query.includes('CustomerTags')) return Response.json({ data: { customer: { id: CLARA, tags: w.shopify.customers[0].tags } } });
    if (query.includes('tagsAdd')) {
      w.tagCalls.push(variables.tags);
      w.shopify.customers[0].tags.push(...variables.tags);
      return Response.json({ data: { tagsAdd: { userErrors: [] } } });
    }
    if (query.includes('customers(')) {
      const c = w.shopify.customers[0];
      return Response.json({ data: { customers: { nodes: [{ id: c.id, numberOfOrders: '0', tags: c.tags }] } } });
    }
    return base(url, init);
  };
  return w;
}

const patch = (b, headers) => new Request('https://w.dev/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(b) });

async function clara(t) {
  const { cookie } = await signIn(t);
  return { Cookie: cookie };
}

test('S8-1: the teaser by default: no count (no Welcome piece options in V1), no snooze, not on the list', async () => {
  const t = setup({ world: world() });
  const h = await clara(t);
  assert.deepEqual(await body(await t.call(get('/api/circle/teaser', h))), {
    sealed_count: 0, show_count: false, member_price_examples: [], snoozed_until: null, on_waitlist: false,
  });
});

test('S8-2: member price examples: saved, available, eligible pieces only; 25% off in cents; at most 3', async () => {
  const t = setup({ world: world() });
  const h = await clara(t);
  const handles = ['pierre-blanche', 'le-vase-livre', 'sold-out', 'the-gourd', 'gift-card', 'carafe', 'flacon'];
  for (const [i, handle] of handles.entries()) {
    t.setNow(T0 + i * 1000); // distinct created_at
    await t.call(post('/api/wishlist', { product_handle: handle }, { ...trusted, ...h }));
  }
  const { member_price_examples: ex } = await body(await t.call(get('/api/circle/teaser', h)));
  // Newest first: flacon, carafe, (gift-card skipped), the-gourd.
  assert.deepEqual(ex.map((e) => [e.handle, e.price_cents, e.member_price_cents]), [
    ['flacon', 6400, 4800], ['carafe', 21000, 15750], ['the-gourd', 4999, 3749],
  ]);
});

test('S8-3: Reserve a place: one place, one event, the Shopify tag once', async () => {
  const w = world();
  const t = setup({ world: w });
  const h = await clara(t);
  for (let i = 0; i < 3; i++) {
    const res = await t.call(post('/api/circle/waitlist', {}, { ...trusted, ...h }));
    assert.equal(res.status, 201);
    assert.deepEqual(await body(res), { on_waitlist: true });
  }
  assert.equal(t.rows("SELECT COUNT(*) AS n FROM holds WHERE kind = 'circle_waitlist'")[0].n, 1);
  assert.equal(t.rows("SELECT COUNT(*) AS n FROM events WHERE name = 'circle_waitlist_joined'")[0].n, 1);
  assert.deepEqual(w.tagCalls.filter((c) => c.includes('circle-waitlist')), [['circle-waitlist']]);
  assert.equal((await body(await t.call(get('/api/circle/teaser', h)))).on_waitlist, true);
  const holds = await body(await t.call(get('/api/holds', h)));
  assert.deepEqual(holds.holds.map((x) => x.kind), ['circle_waitlist']);
});

test('S8-4: if Shopify was down when the place was taken, the tag follows at the next sign-in', async () => {
  const w = world();
  const t = setup({ world: w });
  const h = await clara(t);
  w.fail = true;
  const realError = console.error;
  console.error = () => {};
  try {
    assert.equal((await t.call(post('/api/circle/waitlist', {}, { ...trusted, ...h }))).status, 201);
  } finally {
    console.error = realError;
  }
  assert.ok(!w.shopify.customers[0].tags.includes('circle-waitlist'));
  w.fail = false;
  t.setNow(T0 + 11 * MIN);
  await signIn(t);
  assert.ok(w.shopify.customers[0].tags.includes('circle-waitlist'));
  t.setNow(T0 + 22 * MIN);
  const before = w.tagCalls.length;
  await signIn(t);
  assert.equal(w.tagCalls.length, before); // already tagged: nothing to do
});

test('S8-5: Not now hides the teaser for exactly 30 days', async () => {
  const t = setup({ world: world() });
  const h = await clara(t);
  const res = await t.call(patch({ circle_teaser_snooze: true }, { ...trusted, ...h }));
  assert.equal(res.status, 200);
  const until = new Date(T0 + 30 * DAY).toISOString();
  assert.equal(t.rows('SELECT circle_teaser_snoozed_until AS s FROM users')[0].s, until);
  assert.equal((await body(await t.call(get('/api/circle/teaser', h)))).snoozed_until, until);
  t.setNow(T0 + 13 * DAY);
  assert.equal((await body(await t.call(get('/api/circle/teaser', h)))).snoozed_until, until);
  t.setNow(T0 + 30 * DAY);
  const { cookie } = await signIn(t);
  assert.equal((await body(await t.call(get('/api/circle/teaser', { Cookie: cookie })))).snoozed_until, null);
  assert.equal(t.rows("SELECT COUNT(*) AS n FROM events WHERE name = 'circle_teaser_snoozed'")[0].n, 1);
});

test('S8-6: PATCH /api/me accepts only true for the known flags', async () => {
  const t = setup({ world: world() });
  const h = await clara(t);
  for (const b of [{ circle_teaser_snooze: false }, { circle_teaser_snooze: 'yes' }, { snooze: true }]) {
    assert.equal((await t.call(patch(b, { ...trusted, ...h }))).status, 400, JSON.stringify(b));
  }
  assert.equal((await t.call(patch({ circle_teaser_snooze: true, onboarding_dismissed: true }, { ...trusted, ...h }))).status, 200);
});

test('S8-7: member price rules', () => {
  assert.equal(memberPriceCents(8800), 6600);
  assert.equal(memberPriceCents(4999), 3749);
  assert.equal(memberPriceCents(1), 1);
  const p = (extra) => ({ handle: 'x', isGiftCard: false, tags: [], collections: { nodes: [] }, ...extra });
  assert.equal(memberPriceEligible(p()), true);
  assert.equal(memberPriceEligible(p({ tags: ['catalog'] })), false);
  assert.equal(memberPriceEligible(p({ collections: { nodes: [{ handle: 'catalog' }] } })), false);
  assert.equal(memberPriceEligible(p({ tags: ['capsule'] })), false);
  assert.equal(memberPriceEligible(p({ isGiftCard: true })), false);
  assert.equal(memberPriceEligible(p({ handle: 'patron-membership' })), false);
});
