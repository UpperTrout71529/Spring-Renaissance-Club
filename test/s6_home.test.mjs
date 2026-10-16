// S6: gift card balances (last 4 only, total, never someone else's card) and
// the /api/me additions Home needs (member since, onboarding dismiss).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from './harness.mjs';
import { giftCardSource } from '../src/shopify/gift-cards.js';
import { trusted, makeWorld, setup, signIn, body } from './api-helpers.mjs';

const CLARA = 'gid://shopify/Customer/7';

function cardsWorld(cards) {
  const world = makeWorld({ shopifyCustomers: [{ id: CLARA, email: 'clara@example.com' }] });
  const base = world.fetch;
  world.cardQueries = [];
  world.fail = false;
  world.fetch = async (url, init = {}) => {
    if (String(url).includes('myshopify.com') && /CustomerGiftCards/.test(init.body)) {
      world.cardQueries.push(JSON.parse(init.body).variables.query);
      if (world.fail) return new Response('', { status: 502 });
      return Response.json({ data: { giftCards: { nodes: cards } } });
    }
    return base(url, init);
  };
  return world;
}

const card = (extra = {}) => ({
  id: 'gid://shopify/GiftCard/1', lastCharacters: 'K7H2', enabled: true, expiresOn: null,
  balance: { amount: '40.0', currencyCode: 'USD' }, initialValue: { amount: '50.0', currencyCode: 'USD' },
  note: null, order: { id: 'gid://shopify/Order/9' }, recipientAttributes: null, ...extra,
});

const patch = (bodyObj, headers) => new Request('https://w.dev/api/me', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(bodyObj),
});

test('S6-1: gift cards by customer_id: last 4, cents, source, total', async () => {
  const world = cardsWorld([
    card(),
    card({ id: 'gid://shopify/GiftCard/2', lastCharacters: 'abcd9X2Q', balance: { amount: '12.5', currencyCode: 'USD' }, initialValue: { amount: '20.0', currencyCode: 'USD' }, order: null, note: 'Circle credits · 01RED', expiresOn: '2027-10-01' }),
    card({ id: 'gid://shopify/GiftCard/3', lastCharacters: 'ZZZZ', order: null, note: 'Thank you' }),
  ]);
  const t = setup({ world });
  const { cookie } = await signIn(t);
  const res = await t.call(get('/api/gift-cards', { Cookie: cookie }));
  assert.equal(res.status, 200);
  const b = await body(res);
  assert.deepEqual(world.cardQueries, ['customer_id:7']);
  assert.deepEqual(b.cards.map((c) => [c.last4, c.balance_cents, c.initial_cents, c.source, c.expires_on]), [
    ['K7H2', 4000, 5000, 'purchased', null],
    ['9X2Q', 1250, 2000, 'credits', '2027-10-01'],
    ['ZZZZ', 4000, 5000, 'issued', null],
  ]);
  assert.equal(b.total_balance_cents, 9250);
  assert.ok(!JSON.stringify(b).includes('abcd'));
});

test("S6-2: disabled cards and cards bought for someone else are left out", async () => {
  const world = cardsWorld([
    card({ enabled: false }),
    card({ lastCharacters: 'GIFT', recipientAttributes: { recipient: { id: 'gid://shopify/Customer/8' } } }),
    card({ lastCharacters: 'MINE', recipientAttributes: { recipient: { id: CLARA } } }),
  ]);
  const t = setup({ world });
  const { cookie } = await signIn(t);
  const b = await body(await t.call(get('/api/gift-cards', { Cookie: cookie })));
  assert.deepEqual(b.cards.map((c) => c.last4), ['MINE']);
  assert.equal(b.total_balance_cents, 4000);
});

test('S6-3: no cards / no linked customer → an empty list and a zero total', async () => {
  const t = setup({ world: cardsWorld([]) });
  const { cookie } = await signIn(t);
  assert.deepEqual(await body(await t.call(get('/api/gift-cards', { Cookie: cookie }))), { cards: [], total_balance_cents: 0 });

  const realError = console.error;
  console.error = () => {};
  try {
    const t2 = setup({ world: cardsWorld([card()]), envOverrides: { SHOPIFY_SHOP: undefined } });
    const s2 = await signIn(t2);
    assert.deepEqual(await body(await t2.call(get('/api/gift-cards', { Cookie: s2.cookie }))), { cards: [], total_balance_cents: 0 });
  } finally {
    console.error = realError;
  }
});

test('S6-4: cached per user; Shopify down → 503 gift_cards_unavailable', async () => {
  const world = cardsWorld([card()]);
  const t = setup({ world });
  const { cookie } = await signIn(t);
  await t.call(get('/api/gift-cards', { Cookie: cookie }));
  await t.call(get('/api/gift-cards', { Cookie: cookie }));
  assert.equal(world.cardQueries.length, 1);

  const w2 = cardsWorld([card()]);
  w2.fail = true;
  const t2 = setup({ world: w2 });
  const s2 = await signIn(t2);
  const realError = console.error;
  console.error = () => {};
  try {
    const res = await t2.call(get('/api/gift-cards', { Cookie: s2.cookie }));
    assert.equal(res.status, 503);
    assert.equal((await body(res)).error.code, 'gift_cards_unavailable');
  } finally {
    console.error = realError;
  }
});

test('S6-5: gift cards need a session', async () => {
  const t = setup({ world: cardsWorld([card()]) });
  assert.equal((await t.call(get('/api/gift-cards'))).status, 401);
});

test('S6-6: giftCardSource', () => {
  assert.equal(giftCardSource({ note: 'Circle credits · 01X', order: null }), 'credits');
  assert.equal(giftCardSource({ note: null, order: { id: 'o' } }), 'purchased');
  assert.equal(giftCardSource({ note: 'Sorry for the delay', order: null }), 'issued');
});

test('S6-7: /api/me carries created_at and onboarding.dismissed; PATCH dismisses once', async () => {
  const t = setup();
  const { cookie } = await signIn(t);
  const me = await body(await t.call(get('/api/me', { Cookie: cookie })));
  assert.equal(me.user.created_at, t.rows('SELECT created_at FROM users')[0].created_at);
  assert.equal(me.onboarding.dismissed, false);

  const res = await t.call(patch({ onboarding_dismissed: true }, { ...trusted, Cookie: cookie }));
  assert.equal(res.status, 200);
  assert.equal((await body(res)).onboarding.dismissed, true);
  const first = t.rows('SELECT onboarding_dismissed_at FROM users')[0].onboarding_dismissed_at;
  await t.call(patch({ onboarding_dismissed: true }, { ...trusted, Cookie: cookie }));
  assert.equal(t.rows('SELECT onboarding_dismissed_at FROM users')[0].onboarding_dismissed_at, first);
});

test('S6-8: PATCH /api/me refuses unknown fields, needs the portal origin and a session', async () => {
  const t = setup();
  const { cookie } = await signIn(t);
  for (const b of [{ tier: 'vip' }, { onboarding_dismissed: false }, {}]) {
    const res = await t.call(patch(b, { ...trusted, Cookie: cookie }));
    assert.equal(res.status, 400, JSON.stringify(b));
    assert.equal((await body(res)).error.code, 'invalid_fields');
  }
  assert.equal(t.rows('SELECT tier FROM users')[0].tier, 'club');
  assert.equal((await t.call(patch({ onboarding_dismissed: true }, { Cookie: cookie }))).status, 403);
  assert.equal((await t.call(patch({ onboarding_dismissed: true }, trusted))).status, 401);
});
