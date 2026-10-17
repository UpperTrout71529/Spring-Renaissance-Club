// scripts/stripe-test-setup.mjs: creates the Circle catalog in Stripe TEST
// mode, idempotently, and the staging webhook endpoint (docs/v2-blockers.md B1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ensureCatalog, ensureWebhook, WEBHOOK_EVENTS, assertTestKey, readKey, checkPermissions, PERMISSION_PROBES, run } from '../scripts/stripe-test-setup.mjs';

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

// ---- One command for Felix (17 Oct): the key is typed into a hidden prompt,
// the key's permissions are checked without side effects, and both secrets go
// to wrangler on stdin. Neither the key nor the webhook secret is ever printed.

function fakeTty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.rawModes = [];
  input.setRawMode = (on) => { input.rawModes.push(on); return input; };
  const output = new PassThrough();
  let written = '';
  output.on('data', (d) => { written += d; });
  return { input, output, written: () => written };
}

test('readKey: STRIPE_SECRET_KEY from the environment wins, no prompt', async () => {
  const t = fakeTty();
  assert.equal(await readKey({ env: { STRIPE_SECRET_KEY: 'rk_test_env' }, input: t.input, output: t.output }), 'rk_test_env');
  assert.equal(t.written(), '');
});

test('readKey: hidden prompt in raw mode — nothing echoed, backspace works, paste markers dropped, raw mode restored', async () => {
  const t = fakeTty();
  const p = readKey({ env: {}, input: t.input, output: t.output });
  t.input.write('\x1b[200~rk_test_abcX');
  t.input.write('\x7f');
  t.input.write('def\x1b[201~\r');
  assert.equal(await p, 'rk_test_abcdef');
  assert.deepEqual(t.input.rawModes, [true, false]);
  assert.ok(!t.written().includes('abc'), 'the key never reaches the terminal');
  assert.match(t.written(), /hidden/i);
});

test('readKey: Ctrl+C cancels; a piped (non-TTY) line is read too', async () => {
  const t = fakeTty();
  const p = readKey({ env: {}, input: t.input, output: t.output });
  t.input.write('rk_te\x03');
  await assert.rejects(p, /Cancelled/);
  const input = new PassThrough();
  const p2 = readKey({ env: {}, input, output: new PassThrough() });
  input.end('  sk_test_piped  \n');
  assert.equal(await p2, 'sk_test_piped');
});

test('readKey: anything that is not a clean test key is refused', async () => {
  for (const typed of ['sk_live_abc\r', 'rk_test_ab"c\r', '\r']) {
    const t = fakeTty();
    const p = readKey({ env: {}, input: t.input, output: t.output });
    t.input.write(typed);
    await assert.rejects(p, /test-mode key|unexpected characters/);
  }
});

function denying(names, base = fakeStripe()) {
  const probes = PERMISSION_PROBES.filter((p) => names.includes(p.name));
  const inner = base.fetch;
  base.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const hit = probes.find((p) => p.method === method && p.path === u.pathname);
    if (hit) return Response.json({ error: { type: 'invalid_request_error', message: `The provided key 'rk_test_***abcd' does not have the required permissions for this endpoint. Having the 'rak_coupon_write' permission would allow this request to continue.` } }, { status: 403 });
    return inner(url, init);
  };
  return base;
}

test('checkPermissions: every probe is side-effect free (unknown ids or missing params) and a 403 names the permission', async () => {
  const s = fakeStripe();
  assert.deepEqual(await checkPermissions('rk_test_x', s.fetch), []);
  for (const c of s.calls) {
    if (c.method === 'GET') continue;
    assert.ok(/srprobe/.test(c.path) || [...c.params.values()].some((v) => /srprobe/.test(v)), `${c.method} ${c.path} must not create anything`);
  }
  const names = PERMISSION_PROBES.map((p) => p.name);
  for (const need of ['Customers', 'Checkout Sessions', 'Subscriptions', 'Invoices', 'Coupons', 'Customer portal', 'Payment Intents', 'Charges', 'Prices', 'Products', 'Webhook Endpoints']) {
    assert.ok(names.some((n) => n.startsWith(need)), `probe for ${need}`);
  }
  const d = denying(['Coupons — Write']);
  const missing = await checkPermissions('rk_test_x', d.fetch);
  assert.deepEqual(missing.map((m) => m.name), ['Coupons — Write']);
  assert.equal(missing[0].hint, 'Stripe: rak_coupon_write', 'the redacted key in the message is not repeated');
});

test('checkPermissions: a rejected key (401) stops everything', async () => {
  const fetch401 = async () => Response.json({ error: { message: 'Invalid API Key provided' } }, { status: 401 });
  await assert.rejects(checkPermissions('rk_test_bad', fetch401), /did not accept this key/);
});

function recorder({ failOn } = {}) {
  const saved = [];
  const putSecret = async (name, value, envName) => {
    if (name === failOn) throw new Error('wrangler exited with 1');
    saved.push({ name, value, envName });
  };
  return { saved, putSecret };
}

test('run: missing permissions → nothing created in Stripe and nothing saved', async () => {
  const s = denying(['Subscriptions — Write']);
  const r = recorder();
  const lines = [];
  await assert.rejects(run({ key: 'rk_test_secretkey', fetchImpl: s.fetch, putSecret: r.putSecret, log: (l) => lines.push(l) }), /permissions/);
  assert.equal(s.products.length, 0);
  assert.equal(s.endpoints.length, 0);
  assert.deepEqual(r.saved, []);
  assert.ok(lines.join('\n').includes('Subscriptions — Write'));
});

test('run: a live key is refused before any request', async () => {
  const s = fakeStripe();
  const r = recorder();
  await assert.rejects(run({ key: 'sk_live_x', fetchImpl: s.fetch, putSecret: r.putSecret, log: () => {} }), /test-mode key/);
  assert.equal(s.calls.length, 0);
});

test('run: catalog, endpoint, then the webhook secret and the key go to wrangler (staging by default); neither is logged', async () => {
  const s = fakeStripe();
  const r = recorder();
  const lines = [];
  const out = await run({ key: 'rk_test_secretkey', fetchImpl: s.fetch, putSecret: r.putSecret, log: (l) => lines.push(l) });
  assert.deepEqual(r.saved.map((x) => [x.name, x.envName]), [['STRIPE_CIRCLE_WEBHOOK_SECRET', 'staging'], ['STRIPE_SECRET_KEY', 'staging']]);
  assert.deepEqual(r.saved.map((x) => x.value), ['whsec_created', 'rk_test_secretkey']);
  assert.equal(s.endpoints[0].url, 'https://api-staging.springrenaissance.store/webhooks/stripe');
  assert.equal(out.webhook, 'created');
  const log = lines.join('\n');
  assert.ok(!log.includes('rk_test_secretkey') && !log.includes('whsec_created'));
});

test('run: if wrangler fails on the webhook secret, the new endpoint is deleted and the key is not saved', async () => {
  const s = fakeStripe();
  const inner = s.fetch;
  s.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if ((init.method || 'GET') === 'DELETE' && u.pathname.startsWith('/v1/webhook_endpoints/')) {
      const id = u.pathname.split('/').pop();
      s.endpoints = s.endpoints.filter((e) => e.id !== id);
      return Response.json({ id, deleted: true });
    }
    return inner(url, init);
  };
  const r = recorder({ failOn: 'STRIPE_CIRCLE_WEBHOOK_SECRET' });
  await assert.rejects(run({ key: 'rk_test_secretkey', fetchImpl: s.fetch, putSecret: r.putSecret, log: () => {} }), /wrangler/);
  assert.equal(s.endpoints.length, 0, 'a rerun starts clean');
  assert.deepEqual(r.saved, []);
});

test('run: an existing endpoint keeps its secret; the key is still saved', async () => {
  const s = fakeStripe();
  s.endpoints.push({ id: 'we_old', url: 'https://api-staging.springrenaissance.store/webhooks/stripe' });
  const r = recorder();
  const lines = [];
  const out = await run({ key: 'sk_test_k', fetchImpl: s.fetch, putSecret: r.putSecret, log: (l) => lines.push(l) });
  assert.equal(out.webhook, 'exists');
  assert.deepEqual(r.saved.map((x) => x.name), ['STRIPE_SECRET_KEY']);
  assert.match(lines.join('\n'), /already exists/);
});
