// "Claude Sync" is a Dev Dashboard app: no permanent token. The Worker
// exchanges SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET for a 24-hour token
// (client credentials grant), caches it in memory and KV, refreshes it before
// expiry and once on a 401.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, withFrozenClock } from './harness.mjs';
import { getShopifyToken, shopifyConfigured, shopifyGraphql, _resetShopifyTokenCache } from '../src/shopify/admin.js';

const SHOP = 'qyziv4-0c.myshopify.com';
const T0 = Date.parse('2026-10-16T12:00:00Z');
const HOUR = 3600_000;

function fakeShopify({ tokenStatus = 200, tokenBody } = {}) {
  const s = { issued: [], valid: new Set(), tokenRequests: [], graphql: [] };
  s.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === `https://${SHOP}/admin/oauth/access_token`) {
      s.tokenRequests.push({ contentType: init.headers['Content-Type'], body: Object.fromEntries(new URLSearchParams(init.body)) });
      if (tokenStatus !== 200) return new Response(tokenBody ?? '{"error":"shop_not_permitted"}', { status: tokenStatus });
      const token = `shpat_${s.issued.length + 1}`;
      s.issued.push(token);
      s.valid.add(token);
      return Response.json({ access_token: token, scope: 'read_orders', expires_in: 86399 });
    }
    if (u === `https://${SHOP}/admin/api/2026-07/graphql.json`) {
      const token = init.headers['X-Shopify-Access-Token'];
      s.graphql.push(token);
      if (!s.valid.has(token)) return new Response('{"errors":"Invalid API key or access token"}', { status: 401 });
      return Response.json({ data: { ok: true } });
    }
    throw new Error(`unexpected ${u}`);
  };
  return s;
}

const creds = (extra = {}) => makeEnv({
  SHOPIFY_SHOP: SHOP, SHOPIFY_CLIENT_ID: 'cid_123', SHOPIFY_CLIENT_SECRET: 'csecret_456', ...extra,
});

beforeEach(() => _resetShopifyTokenCache());

test('TK-1: the token request is the documented client credentials grant', async () => {
  const shop = fakeShopify();
  await withFrozenClock(T0, () => shopifyGraphql(creds(), shop.fetch, '{ ok }', {}));
  assert.deepEqual(shop.tokenRequests, [{
    contentType: 'application/x-www-form-urlencoded',
    body: { grant_type: 'client_credentials', client_id: 'cid_123', client_secret: 'csecret_456' },
  }]);
  assert.deepEqual(shop.graphql, ['shpat_1']);
});

test('TK-2: one token serves every call until 5 minutes before its 24 hours run out', async () => {
  const shop = fakeShopify();
  const env = creds();
  await withFrozenClock(T0, async () => {
    for (let i = 0; i < 5; i++) await shopifyGraphql(env, shop.fetch, '{ ok }', {});
  });
  await withFrozenClock(T0 + 23 * HOUR, () => shopifyGraphql(env, shop.fetch, '{ ok }', {}));
  assert.equal(shop.tokenRequests.length, 1);
  await withFrozenClock(T0 + 24 * HOUR - 4 * 60_000, () => shopifyGraphql(env, shop.fetch, '{ ok }', {}));
  assert.equal(shop.tokenRequests.length, 2);
  assert.equal(shop.graphql.at(-1), 'shpat_2');
});

test('TK-3: a fresh isolate takes the token from KV instead of asking Shopify again', async () => {
  const shop = fakeShopify();
  const env = creds();
  await withFrozenClock(T0, () => shopifyGraphql(env, shop.fetch, '{ ok }', {}));
  _resetShopifyTokenCache(); // a new isolate: memory empty, KV shared
  await withFrozenClock(T0 + HOUR, () => shopifyGraphql(env, shop.fetch, '{ ok }', {}));
  assert.equal(shop.tokenRequests.length, 1);
  assert.deepEqual(shop.graphql, ['shpat_1', 'shpat_1']);
});

test('TK-4: a 401 (token revoked early) → one new token and one retry', async () => {
  const shop = fakeShopify();
  const env = creds();
  await withFrozenClock(T0, async () => {
    await shopifyGraphql(env, shop.fetch, '{ ok }', {});
    shop.valid.clear(); // revoked
    const data = await shopifyGraphql(env, shop.fetch, '{ ok }', {});
    assert.deepEqual(data, { ok: true });
  });
  assert.equal(shop.tokenRequests.length, 2);
  assert.deepEqual(shop.graphql, ['shpat_1', 'shpat_1', 'shpat_2']);
});

test('TK-5: a refused grant (e.g. shop_not_permitted) surfaces as an error, without the secret', async () => {
  const shop = fakeShopify({ tokenStatus: 400, tokenBody: '{"error":"shop_not_permitted","error_description":"Client credentials cannot be performed on this shop."}' });
  const err = await withFrozenClock(T0, () => shopifyGraphql(creds(), shop.fetch, '{ ok }', {}).catch((e) => e));
  assert.match(err.message, /shopify token http 400 .*shop_not_permitted/);
  assert.ok(!err.message.includes('csecret_456'));
  assert.equal(shop.graphql.length, 0);
});

test('TK-6: a permanent SHOPIFY_ADMIN_TOKEN still works when no client credentials are set', async () => {
  const shop = fakeShopify();
  shop.valid.add('shpat_static');
  const env = makeEnv({ SHOPIFY_SHOP: SHOP, SHOPIFY_ADMIN_TOKEN: 'shpat_static' });
  assert.equal(await getShopifyToken(env, shop.fetch), 'shpat_static');
  await shopifyGraphql(env, shop.fetch, '{ ok }', {});
  assert.equal(shop.tokenRequests.length, 0);
  assert.deepEqual(shop.graphql, ['shpat_static']);
});

test('TK-7: configured with either credential set; not with half of one', () => {
  assert.equal(shopifyConfigured({ SHOPIFY_SHOP: SHOP, SHOPIFY_CLIENT_ID: 'a', SHOPIFY_CLIENT_SECRET: 'b' }), true);
  assert.equal(shopifyConfigured({ SHOPIFY_SHOP: SHOP, SHOPIFY_ADMIN_TOKEN: 't' }), true);
  assert.equal(shopifyConfigured({ SHOPIFY_SHOP: SHOP, SHOPIFY_CLIENT_ID: 'a' }), false);
  assert.equal(shopifyConfigured({ SHOPIFY_CLIENT_ID: 'a', SHOPIFY_CLIENT_SECRET: 'b' }), false);
});

test('TK-8: the token in KV is stored with a TTL that ends before the refresh point', async () => {
  const shop = fakeShopify();
  const env = creds();
  const puts = [];
  const realPut = env.CLIENT_KV.put.bind(env.CLIENT_KV);
  env.CLIENT_KV.put = async (k, v, o) => { puts.push([k, o]); return realPut(k, v, o); };
  await withFrozenClock(T0, () => shopifyGraphql(env, shop.fetch, '{ ok }', {}));
  assert.equal(puts.length, 1);
  assert.equal(puts[0][0], 'shopify_token:v1');
  assert.equal(puts[0][1].expirationTtl, 86399 - 300);
});
