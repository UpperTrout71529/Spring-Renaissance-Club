// scripts/stripe-test-setup.mjs: creates the Circle catalog in Stripe TEST
// mode, idempotently, and the staging webhook endpoint (docs/v2-blockers.md B1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureCatalog, ensureWebhook, WEBHOOK_EVENTS, assertTestKey } from '../scripts/stripe-test-setup.mjs';

function fakeStripe() {
  const s = { prices: [], products: [], endpoints: [], calls: [] };
  s.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const params = new URLSearchParams(method === 'GET' ? u.search : init.body || '');
    s.calls.push({ method, path: u.pathname, params, headers: init.headers });
    if (u.pathname === '/v1/prices' && method === 'GET') {
      const keys = params.getAll('lookup_keys[0]').concat(params.getAll('lookup_keys[1]'));
      return Response.json({ data: s.prices.filter((p) => keys.includes(p.lookup_key)) });
    }
    if (u.pathname === '/v1/products' && method === 'POST') {
      const p = { id: `prod_${s.products.length + 1}`, name: params.get('name') };
      s.products.push(p);
      return Response.json(p);
    }
    if (u.pathname === '/v1/prices' && method === 'POST') {
      const p = { id: `price_${s.prices.length + 1}`, lookup_key: params.get('lookup_key'), unit_amount: Number(params.get('unit_amount')),
        product: params.get('product'), recurring: params.get('recurring[interval]') ? { interval: params.get('recurring[interval]') } : null,
        tax_behavior: params.get('tax_behavior'), currency: params.get('currency'), active: true };
      s.prices.push(p);
      return Response.json(p);
    }
    if (u.pathname === '/v1/webhook_endpoints' && method === 'GET') return Response.json({ data: s.endpoints });
    if (u.pathname === '/v1/webhook_endpoints' && method === 'POST') {
      const e = { id: `we_${s.endpoints.length + 1}`, url: params.get('url'), secret: 'whsec_created', api_version: params.get('api_version'),
        enabled_events: [...params.entries()].filter(([k]) => k.startsWith('enabled_events')).map(([, v]) => v) };
      s.endpoints.push(e);
      return Response.json(e);
    }
    return Response.json({ error: { message: 'no fake' } }, { status: 404 });
  };
  return s;
}

test('setup refuses anything but a test key', () => {
  assert.throws(() => assertTestKey('sk_live_x'), /test-mode key/);
  assert.throws(() => assertTestKey(''), /test-mode key/);
  assert.doesNotThrow(() => assertTestKey('sk_test_x'));
  assert.doesNotThrow(() => assertTestKey('rk_test_x'));
});

test('the catalog is created once: two products, $20 monthly and $30 one-time, tax exclusive, by lookup key', async () => {
  const s = fakeStripe();
  const first = await ensureCatalog('sk_test_x', s.fetch);
  assert.deepEqual(first.created, ['circle_monthly_usd', 'circle_joining_usd']);
  const m = s.prices.find((p) => p.lookup_key === 'circle_monthly_usd');
  const j = s.prices.find((p) => p.lookup_key === 'circle_joining_usd');
  assert.deepEqual([m.unit_amount, m.recurring.interval, m.tax_behavior, m.currency], [2000, 'month', 'exclusive', 'usd']);
  assert.deepEqual([j.unit_amount, j.recurring, j.tax_behavior], [3000, null, 'exclusive']);
  assert.notEqual(m.product, j.product, 'the joining fee is its own product');
  assert.deepEqual(s.products.map((p) => p.name), ['The Renaissance Circle — Membership', 'Joining fee — includes your welcome piece']);
  const again = await ensureCatalog('sk_test_x', s.fetch);
  assert.deepEqual(again.created, []);
  assert.equal(s.products.length, 2);
  assert.ok(s.calls.every((c) => c.headers['Stripe-Version'] === '2026-09-30.endive'));
});

test('the webhook endpoint is created once with the pinned version and every Circle event; the secret is returned, not printed', async () => {
  const s = fakeStripe();
  const url = 'https://api-staging.springrenaissance.store/webhooks/stripe';
  const w = await ensureWebhook('sk_test_x', s.fetch, url);
  assert.equal(w.created, true);
  assert.equal(w.secret, 'whsec_created');
  assert.equal(s.endpoints[0].api_version, '2026-09-30.endive');
  assert.deepEqual(s.endpoints[0].enabled_events.sort(), [...WEBHOOK_EVENTS].sort());
  const again = await ensureWebhook('sk_test_x', s.fetch, url);
  assert.deepEqual([again.created, again.secret], [false, null]);
});
