// V2 T0: Stripe client, signature and catalog; migration 0006; the cron
// dispatcher; the legacy VIP switch (docs/tz-v2-circle.md §2, §14, §15).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeKV, post, get, signBody } from './harness.mjs';
import { createApp } from '../src/app.js';
import { verifyStripeSignature } from '../src/stripe/signature.js';
import { formEncode, stripeRequest, StripeError, STRIPE_API_VERSION, stripeConfigured } from '../src/stripe/client.js';
import { resolvePrices, PRICE_KEYS } from '../src/stripe/catalog.js';
import { runScheduled, FREQUENT_CRON, DAILY_CRON } from '../src/cron/index.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const NOW_S = Math.floor(NOW / 1000);
const SECRET = 'whsec_circle_test';

// ---- signature -------------------------------------------------------------

async function header(raw, ts = NOW_S, secret = SECRET) {
  return `t=${ts},v1=${await signBody(raw, ts, secret)}`;
}

test('T0-S1: a correctly signed body verifies', async () => {
  const raw = '{"id":"evt_1"}';
  assert.equal(await verifyStripeSignature(raw, await header(raw), SECRET, NOW_S), true);
});

test('T0-S2: a wrong signature, a wrong secret or a changed body fails', async () => {
  const raw = '{"id":"evt_1"}';
  assert.equal(await verifyStripeSignature(raw, `t=${NOW_S},v1=${'0'.repeat(64)}`, SECRET, NOW_S), false);
  assert.equal(await verifyStripeSignature(raw, await header(raw, NOW_S, 'whsec_other'), SECRET, NOW_S), false);
  assert.equal(await verifyStripeSignature('{"id":"evt_2"}', await header(raw), SECRET, NOW_S), false);
});

test('T0-S3: a timestamp more than 300 s old or ahead fails, inside the window passes', async () => {
  const raw = '{}';
  assert.equal(await verifyStripeSignature(raw, await header(raw, NOW_S - 301), SECRET, NOW_S), false);
  assert.equal(await verifyStripeSignature(raw, await header(raw, NOW_S + 301), SECRET, NOW_S), false);
  assert.equal(await verifyStripeSignature(raw, await header(raw, NOW_S - 300), SECRET, NOW_S), true);
});

test('T0-S4: any one of several v1 signatures may match (secret rotation)', async () => {
  const raw = '{}';
  const good = await signBody(raw, NOW_S, SECRET);
  assert.equal(await verifyStripeSignature(raw, `t=${NOW_S},v1=${'a'.repeat(64)},v1=${good}`, SECRET, NOW_S), true);
});

test('T0-S5: missing header, missing secret, no t or no v1 fails', async () => {
  const raw = '{}';
  assert.equal(await verifyStripeSignature(raw, null, SECRET, NOW_S), false);
  assert.equal(await verifyStripeSignature(raw, await header(raw), '', NOW_S), false);
  assert.equal(await verifyStripeSignature(raw, `v1=${await signBody(raw, NOW_S, SECRET)}`, SECRET, NOW_S), false);
  assert.equal(await verifyStripeSignature(raw, `t=${NOW_S}`, SECRET, NOW_S), false);
  assert.equal(await verifyStripeSignature(raw, `t=abc,v1=${await signBody(raw, NOW_S, SECRET)}`, SECRET, NOW_S), false);
});

// ---- client ----------------------------------------------------------------

test('T0-C1: params are form-encoded the way Stripe expects (nested objects and arrays)', () => {
  const pairs = formEncode({
    mode: 'subscription',
    line_items: [{ price: 'price_a', quantity: 1 }, { price: 'price_b', quantity: 1 }],
    subscription_data: { metadata: { user_id: 'U1' } },
    expand: ['data.product'],
    skip: undefined,
    none: null,
    flag: true,
  });
  assert.deepEqual(pairs, [
    ['mode', 'subscription'],
    ['line_items[0][price]', 'price_a'], ['line_items[0][quantity]', '1'],
    ['line_items[1][price]', 'price_b'], ['line_items[1][quantity]', '1'],
    ['subscription_data[metadata][user_id]', 'U1'],
    ['expand[0]', 'data.product'],
    ['flag', 'true'],
  ]);
});

function stripeFake(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, fetch };
}

test('T0-C2: a request carries the key, the pinned API version and the idempotency key', async () => {
  const env = { STRIPE_SECRET_KEY: 'sk_test_abc' };
  const f = stripeFake(() => Response.json({ id: 'cs_1' }));
  const out = await stripeRequest(env, f.fetch, 'POST', '/v1/checkout/sessions', { mode: 'subscription' }, { idempotencyKey: 'k1' });
  assert.deepEqual(out, { id: 'cs_1' });
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer sk_test_abc');
  assert.equal(init.headers['Stripe-Version'], STRIPE_API_VERSION);
  assert.equal(STRIPE_API_VERSION, '2026-09-30.endive');
  assert.equal(init.headers['Idempotency-Key'], 'k1');
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(init.body, 'mode=subscription');
});

test('T0-C3: GET params go to the query string, without a body', async () => {
  const f = stripeFake(() => Response.json({ data: [] }));
  await stripeRequest({ STRIPE_SECRET_KEY: 'rk_test_1' }, f.fetch, 'GET', '/v1/prices', { lookup_keys: ['a b', 'c'] });
  assert.equal(f.calls[0].url, 'https://api.stripe.com/v1/prices?lookup_keys%5B0%5D=a+b&lookup_keys%5B1%5D=c');
  assert.equal(f.calls[0].init.body, undefined);
});

test('T0-C4: a live key is refused unless the launch flag is on (test mode only)', async () => {
  const f = stripeFake(() => Response.json({}));
  await assert.rejects(stripeRequest({ STRIPE_SECRET_KEY: 'sk_live_x' }, f.fetch, 'GET', '/v1/prices', {}),
    (e) => e instanceof StripeError && e.code === 'stripe_live_key_refused');
  await assert.rejects(stripeRequest({ STRIPE_SECRET_KEY: 'rk_live_x' }, f.fetch, 'GET', '/v1/prices', {}),
    (e) => e instanceof StripeError && e.code === 'stripe_live_key_refused');
  assert.equal(f.calls.length, 0);
  await stripeRequest({ STRIPE_SECRET_KEY: 'sk_live_x', CIRCLE_STRIPE_LIVE: 'on' }, f.fetch, 'GET', '/v1/prices', {});
  assert.equal(f.calls.length, 1);
  assert.equal(stripeConfigured({}), false);
  assert.equal(stripeConfigured({ STRIPE_SECRET_KEY: 'sk_live_x' }), false);
  assert.equal(stripeConfigured({ STRIPE_SECRET_KEY: 'sk_test_x' }), true);
});

test('T0-C5: a Stripe error becomes a StripeError with status, code and type — no key in the message', async () => {
  const f = stripeFake(() => Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such price' } }, { status: 404 }));
  await assert.rejects(stripeRequest({ STRIPE_SECRET_KEY: 'sk_test_secret' }, f.fetch, 'GET', '/v1/prices/x', {}), (e) => {
    assert.ok(e instanceof StripeError);
    assert.equal(e.status, 404);
    assert.equal(e.code, 'resource_missing');
    assert.equal(e.type, 'invalid_request_error');
    assert.ok(!String(e.message).includes('sk_test_secret'));
    return true;
  });
  const down = stripeFake(() => { throw new TypeError('network'); });
  await assert.rejects(stripeRequest({ STRIPE_SECRET_KEY: 'sk_test_1' }, down.fetch, 'GET', '/v1/prices', {}),
    (e) => e instanceof StripeError && e.code === 'stripe_unreachable');
});

// ---- catalog ---------------------------------------------------------------

function priceList() {
  return {
    data: [
      { id: 'price_m', lookup_key: 'circle_monthly_usd', unit_amount: 2000, currency: 'usd', active: true, product: 'prod_A', recurring: { interval: 'month' } },
      { id: 'price_j', lookup_key: 'circle_joining_usd', unit_amount: 3000, currency: 'usd', active: true, product: 'prod_B', recurring: null },
    ],
  };
}

test('T0-K1: prices are resolved by lookup_key and cached in KV', async () => {
  const env = { STRIPE_SECRET_KEY: 'sk_test_1', CLIENT_KV: makeKV() };
  const f = stripeFake(() => Response.json(priceList()));
  const p = await resolvePrices(env, f.fetch, NOW);
  assert.equal(p.monthly.id, 'price_m');
  assert.equal(p.monthly.product, 'prod_A');
  assert.equal(p.joining.id, 'price_j');
  assert.equal(p.joining.product, 'prod_B');
  assert.deepEqual(PRICE_KEYS, { monthly: 'circle_monthly_usd', joining: 'circle_joining_usd' });
  await resolvePrices(env, f.fetch, NOW + 1000);
  assert.equal(f.calls.length, 1, 'second call served from KV');
  await resolvePrices(env, f.fetch, NOW + 2 * 3600 * 1000);
  assert.equal(f.calls.length, 2, 'cache expires after an hour');
});

test('T0-K2: a missing, inactive or wrongly priced lookup key is a configuration error', async () => {
  const env = () => ({ STRIPE_SECRET_KEY: 'sk_test_1', CLIENT_KV: makeKV() });
  const only = (mutate) => stripeFake(() => { const l = priceList(); mutate(l); return Response.json(l); });
  for (const mutate of [
    (l) => { l.data.pop(); },
    (l) => { l.data[0].active = false; },
    (l) => { l.data[1].currency = 'eur'; },
    (l) => { l.data[0].recurring = null; },
  ]) {
    await assert.rejects(resolvePrices(env(), only(mutate).fetch, NOW), (e) => e instanceof StripeError && e.code === 'stripe_catalog_incomplete');
  }
});

// ---- migration 0006 ----------------------------------------------------------

test('T0-M1: migration 0006 creates the membership tables', () => {
  const env = makeEnv();
  const names = env.DB._rows("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  for (const t of ['memberships', 'credit_ledger', 'redemptions', 'cancellations', 'membership_invoices', 'stripe_payments', 'stripe_disputes', 'admin_flags']) {
    assert.ok(names.includes(t), `missing ${t}`);
  }
});

function seedUserRow(env, id = 'U1', email = 'clara@example.com') {
  env.DB._db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, '2026-10-16T00:00:00.000Z')").run(id, email);
}

test('T0-M2: ledger idempotency keys are unique and kinds are checked', () => {
  const env = makeEnv();
  seedUserRow(env);
  const ins = (key, kind = 'accrual') => env.DB._db.prepare(
    "INSERT INTO credit_ledger (id, user_id, amount_cents, kind, idempotency_key, created_at) VALUES (?, 'U1', 2000, ?, ?, 'x')"
  ).run(key + kind, kind, key);
  ins('accrual:in_1');
  assert.throws(() => ins('accrual:in_1'), /UNIQUE/);
  assert.throws(() => ins('k2', 'bogus'), /CHECK/);
  for (const kind of ['welcome_accrual', 'redemption', 'redemption_return', 'manual', 'referral', 'referral_reversal',
    'refund_reversal', 'dispute_reversal', 'dispute_restore', 'expiry']) ins(`k:${kind}`, kind);
});

test('T0-M3: membership status and end reason are checked', () => {
  const env = makeEnv();
  seedUserRow(env);
  const ins = (id, status, reason = null) => env.DB._db.prepare(
    "INSERT INTO memberships (id, user_id, status, end_reason, created_at, updated_at) VALUES (?, 'U1', ?, ?, 'x', 'x')"
  ).run(id, status, reason);
  for (const s of ['pending', 'active', 'past_due', 'canceling', 'ended', 'ended_expired']) ins(`m_${s}`, s);
  assert.throws(() => ins('m_bad', 'paused'), /CHECK/);
  assert.throws(() => ins('m_bad2', 'ended', 'bored'), /CHECK/);
});

// ---- cron dispatcher -------------------------------------------------------------

test('T0-R1: the 5-minute trigger runs the frequent jobs, the daily trigger the daily ones', async () => {
  const ran = [];
  const jobs = {
    frequent: [{ name: 'a', run: async () => { ran.push('a'); return 1; } }],
    daily: [{ name: 'b', run: async () => { ran.push('b'); return 2; } }],
  };
  assert.equal(FREQUENT_CRON, '*/5 * * * *');
  assert.equal(DAILY_CRON, '15 3 * * *');
  const r1 = await runScheduled({}, NOW, FREQUENT_CRON, { jobs });
  assert.deepEqual(ran, ['a']);
  assert.deepEqual(r1, { a: 1 });
  const r2 = await runScheduled({}, NOW, DAILY_CRON, { jobs });
  assert.deepEqual(ran, ['a', 'b']);
  assert.deepEqual(r2, { b: 2 });
});

test('T0-R2: one failing job does not stop the others; an unknown trigger runs nothing', async () => {
  const ran = [];
  const jobs = {
    frequent: [
      { name: 'boom', run: async () => { throw new Error('x'); } },
      { name: 'ok', run: async () => { ran.push('ok'); return 'done'; } },
    ],
    daily: [],
  };
  const r = await runScheduled({}, NOW, FREQUENT_CRON, { jobs });
  assert.deepEqual(ran, ['ok']);
  assert.equal(r.boom, 'failed');
  assert.equal(r.ok, 'done');
  assert.deepEqual(await runScheduled({}, NOW, '0 0 * * *', { jobs }), {});
});

test('T0-R3: the real daily jobs include data retention', async () => {
  const env = makeEnv();
  const r = await runScheduled(env, NOW, DAILY_CRON);
  assert.ok(r.retention && typeof r.retention === 'object', JSON.stringify(r));
});

// ---- legacy VIP switch -----------------------------------------------------------

test('T0-L1: with LEGACY_VIP=off the legacy VIP system answers 410 and never runs', async () => {
  const seen = [];
  const legacy = { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response('legacy'); } };
  const app = createApp({ legacy, now: () => NOW });
  const env = makeEnv({ LEGACY_VIP: 'off' });
  for (const req of [
    get('/api/user?auth_token=x'),
    post('/api/user/skip', {}),
    post('/api/curator/chat', {}),
    post('/api/auth/request-link', { email: 'a@b.com' }),
    post('/hook', '{}'),
    post('/', '{}'),
  ]) {
    const res = await app.fetch(req, env);
    assert.equal(res.status, 410, new URL(req.url).pathname);
    const b = await res.json();
    assert.equal(b.error.code, 'legacy_retired');
  }
  assert.deepEqual(seen, []);
});

test('T0-L2: without the switch the legacy worker still gets every unowned path', async () => {
  const seen = [];
  const legacy = { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response('legacy'); } };
  const app = createApp({ legacy, now: () => NOW });
  const res = await app.fetch(get('/api/user'), makeEnv());
  assert.equal(await res.text(), 'legacy');
  assert.deepEqual(seen, ['/api/user']);
});

test('T0-L3: wrangler.toml switches the legacy VIP system off in production and on staging', async () => {
  const { readFileSync } = await import('node:fs');
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const top = toml.split('[env.staging]')[0];
  const staging = toml.split('[env.staging.vars]')[1].split('[')[0];
  assert.match(top, /\[vars\][^[]*LEGACY_VIP = "off"/);
  assert.match(staging, /LEGACY_VIP = "off"/);
});

// ---- rollback ----------------------------------------------------------------

test('T0-M4: scripts/rollback/v2_down.sql removes every V2 table and its migration rows, V1 stays', async () => {
  const { readFileSync } = await import('node:fs');
  const { DatabaseSync } = await import('node:sqlite');
  const { MIGRATIONS, applyMigrations } = await import('./harness.mjs');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)');
  const v1 = MIGRATIONS.filter((m) => m.name < '0006');
  applyMigrations(db, v1);
  const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).sort();
  const v1Tables = tables();
  applyMigrations(db, MIGRATIONS.filter((m) => m.name >= '0006'));
  for (const m of MIGRATIONS) db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(m.name);
  db.exec(readFileSync(new URL('../scripts/rollback/v2_down.sql', import.meta.url), 'utf8'));
  assert.deepEqual(tables(), v1Tables);
  assert.deepEqual(db.prepare('SELECT name FROM d1_migrations ORDER BY name').all().map((r) => r.name), v1.map((m) => m.name));
});
