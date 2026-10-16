// S11 security pass (Felix, 16 Oct): attacks an agent-built app most often
// misses — other people's data, trusting the client, brute force, open
// redirects, leaked internals, session fixation, CSRF, injection. Two
// accounts, A and B; every test tries to break something and expects a
// refusal. Attacks already covered elsewhere are listed in docs/security-s11.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post } from './harness.mjs';
import { T0, MIN, trusted, makeWorld, setup, signIn, requestLink, verify, tokenFromEmail, sessionToken, body } from './api-helpers.mjs';
import { sanitizeReturnTo } from '../src/routes/auth.js';
import { SESSION_COOKIE } from '../src/auth/session.js';

// Shopify: every handle is an active product priced $10.00.
function world() {
  const w = makeWorld();
  const base = w.fetch;
  w.fetch = async (url, init = {}) => {
    if (String(url).includes('myshopify.com/admin/api/')) {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes('ProductByHandle')) {
        return Response.json({ data: { productByIdentifier: {
          id: `gid://shopify/Product/${variables.handle.length}`, handle: variables.handle, title: 'Piece', status: 'ACTIVE',
          onlineStoreUrl: `https://springrenaissance.store/products/${variables.handle}`, isGiftCard: false, tags: [],
          collections: { nodes: [] }, featuredMedia: null,
          priceRangeV2: { minVariantPrice: { amount: '10.0', currencyCode: 'USD' } }, variants: { nodes: [{ availableForSale: true }] },
        } } });
      }
      if (query.includes('CustomerTags')) return Response.json({ data: { customer: { id: 'x', tags: [] } } });
    }
    return base(url, init);
  };
  return w;
}

const req = (method, path, b, headers = {}) => new Request('https://w.dev' + path, {
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: b === undefined ? undefined : JSON.stringify(b),
});

async function twoAccounts(opts = {}) {
  const t = setup({ world: world(), ...opts });
  const mk = async (email) => {
    const { res, cookie } = await signIn(t, email);
    const user = (await body(res)).user;
    return { user, cookie, as: (extra = {}) => ({ ...trusted, Cookie: cookie, ...extra }) };
  };
  const a = await mk('alice@example.com');
  t.setNow(T0 + 11 * MIN);
  const b = await mk('bob@example.com');
  return { t, a, b };
}

// ---- 1. Other people's data (IDOR) ----------------------------------------

test('IDOR: the sessions list exposes no database key — ids are not the stored session hashes', async () => {
  const { t, a } = await twoAccounts();
  const { sessions } = await body(await t.call(get('/api/sessions', { Cookie: a.cookie })));
  const hashes = new Set(t.rows('SELECT id_hash FROM sessions').map((r) => r.id_hash));
  assert.ok(sessions.length > 0);
  for (const s of sessions) assert.equal(hashes.has(s.id), false, 'a session id is the stored hash');
});

test("IDOR: A cannot sign out B's session with B's own session id", async () => {
  const { t, a, b } = await twoAccounts();
  const bId = (await body(await t.call(get('/api/sessions', { Cookie: b.cookie })))).sessions[0].id;
  assert.equal((await t.call(req('DELETE', `/api/sessions/${bId}`, undefined, a.as()))).status, 404);
  assert.equal((await t.call(get('/api/me', { Cookie: b.cookie }))).status, 200);
  // …while B can, with the same id.
  const other = await signIn(t, 'bob@example.com');
  assert.equal((await t.call(req('DELETE', `/api/sessions/${bId}`, undefined, { ...trusted, Cookie: other.cookie }))).status, 204);
  assert.equal((await t.call(get('/api/me', { Cookie: b.cookie }))).status, 401);
});

test("IDOR: Saved and Held lists are per person; A removing a piece leaves B's copy", async () => {
  const { t, a, b } = await twoAccounts();
  for (const x of [a, b]) await t.call(post('/api/wishlist', { product_handle: 'kouros' }, x.as()));
  await t.call(post('/api/holds', { product_handle: 'ember' }, b.as()));
  assert.equal((await t.call(req('DELETE', '/api/wishlist/kouros', undefined, a.as()))).status, 204);
  const bSaved = await body(await t.call(get('/api/wishlist/handles', { Cookie: b.cookie })));
  assert.deepEqual(bSaved.handles, ['kouros']);
  const aHolds = await body(await t.call(get('/api/holds', { Cookie: a.cookie })));
  assert.deepEqual(aHolds.holds, []);
});

// ---- 2. Trusting the client ------------------------------------------------

test('client cannot write for someone else or set price/status: extra fields are ignored', async () => {
  const { t, a, b } = await twoAccounts();
  await t.call(post('/api/wishlist', { product_handle: 'kouros', user_id: b.user.id, price_cents: 1, product_gid: 'gid://shopify/Product/999' }, a.as()));
  await t.call(post('/api/holds', { product_handle: 'ember', user_id: b.user.id, status: 'converted', kind: 'circle_waitlist', source: 'import' }, a.as()));
  assert.deepEqual(t.rows('SELECT user_id, product_gid FROM wishlist_items').map((r) => ({ ...r })), [{ user_id: a.user.id, product_gid: 'gid://shopify/Product/6' }]);
  assert.deepEqual(t.rows('SELECT user_id, kind, status, source FROM holds').map((r) => ({ ...r })),
    [{ user_id: a.user.id, kind: 'object_hold', status: 'open', source: 'portal' }]);
  // Prices are never stored: the list reads them from Shopify at request time.
  const cols = t.rows("SELECT name FROM pragma_table_info('wishlist_items')").map((r) => r.name);
  assert.equal(cols.some((c) => /price|amount|cents/.test(c)), false);
});

test('client cannot change tier, email, Shopify link or deletion through PATCH /api/me', async () => {
  const { t, a } = await twoAccounts();
  for (const field of [{ tier: 'vip' }, { email: 'x@example.com' }, { shopify_customer_id: 'gid://shopify/Customer/1' }, { deleted_at: null }, { id: 'X' }, { first_name: 'A', tier: 'vip' }]) {
    const res = await t.call(req('PATCH', '/api/me', field, a.as()));
    assert.equal(res.status, 400, JSON.stringify(field));
  }
  const [row] = t.rows('SELECT tier, email, shopify_customer_id FROM users WHERE id = ?', a.user.id);
  assert.equal(row.tier, 'club');
  assert.equal(row.email, 'alice@example.com');
});

test('bad shapes and sizes are refused: arrays, huge strings, non-strings', async () => {
  const { t, a } = await twoAccounts();
  for (const b of [[], 'x', { first_name: 'x'.repeat(81) }, { first_name: 42 }, { seasonal_email_opt_in: 'yes' }, { circle_teaser_snooze: false }]) {
    assert.equal((await t.call(req('PATCH', '/api/me', b, a.as()))).status, 400, JSON.stringify(b).slice(0, 40));
  }
  for (const handle of ['', 'a'.repeat(300), "x' OR '1'='1", '../admin', 'kouros?x=1', { a: 1 }]) {
    const res = await t.call(post('/api/wishlist', { product_handle: handle }, a.as()));
    assert.equal(res.status, 400, String(handle).slice(0, 30));
  }
  assert.equal((await t.call(get('/api/orders?cursor=' + 'x'.repeat(600), { Cookie: a.cookie }))).status, 400);
  const big = await t.call(new Request('https://w.dev/api/me', { method: 'PATCH', headers: { ...a.as(), 'Content-Type': 'application/json' }, body: JSON.stringify({ first_name: 'x'.repeat(70000) }) }));
  assert.equal(big.status, 413);
});

test('race: two simultaneous identical holds and Saved adds give one row each', async () => {
  const { t, a } = await twoAccounts({ envOverrides: { interleave: true } });
  await Promise.all([1, 2, 3, 4].map(() => t.call(post('/api/holds', { product_handle: 'ember' }, a.as()))));
  await Promise.all([1, 2, 3, 4].map(() => t.call(post('/api/wishlist', { product_handle: 'ember' }, a.as()))));
  assert.equal(t.rows("SELECT COUNT(*) AS n FROM holds WHERE status = 'open'")[0].n, 1);
  assert.equal(t.rows('SELECT COUNT(*) AS n FROM wishlist_items')[0].n, 1);
});

// ---- 3. Brute force ---------------------------------------------------------

test('guessing sign-in tokens: 10 tries a minute per IP, then 429 — even for a valid token', async () => {
  const t = setup({ world: world() });
  await t.call(requestLink('alice@example.com'));
  const good = tokenFromEmail(t.world.emails.at(-1));
  const ip = { 'CF-Connecting-IP': '203.0.113.9' };
  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push((await t.call(verify('A'.repeat(43 - String(i).length) + i, ip))).status);
  assert.ok(statuses.every((s) => s === 410 || s === 400), statuses.join());
  assert.equal((await t.call(verify(good, ip))).status, 429);
});

test('sign-in tokens are 256-bit, single-use, and the answer is the same for known and unknown emails', async () => {
  const t = setup({ world: world() });
  await signIn(t, 'alice@example.com');
  const known = await t.call(requestLink('alice@example.com'));
  const unknown = await t.call(requestLink('nobody@example.com'));
  assert.equal(known.status, unknown.status);
  assert.deepEqual(await body(known), await body(unknown));
  const token = tokenFromEmail(t.world.emails.at(-2));
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.equal((await t.call(verify(token))).status, 200);
  assert.equal((await t.call(verify(token))).status, 410);
});

test('passkey sign-in options: 30 a minute per IP, then 429 (no unbounded challenge rows)', async () => {
  const t = setup({ world: world() });
  const ip = { 'CF-Connecting-IP': '203.0.113.7' };
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await t.call(post('/api/auth/passkey/login/options', {}, { ...trusted, ...ip }))).status);
  assert.equal(statuses.slice(0, 30).every((s) => s === 200), true);
  assert.equal(statuses[30], 429);
});

// ---- 4. SSRF / open redirect -------------------------------------------------

test('return_to only accepts a path on the portal or the storefront itself (no open redirect)', () => {
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com/x', 'javascript:alert(1)', 'https://springrenaissance.store@evil.com/',
    'https://springrenaissance.store.evil.com/', 'http://springrenaissance.store/', '/\tevil', 'data:text/html,x', ' /orders']) {
    assert.equal(sanitizeReturnTo(bad), null, bad);
  }
  assert.equal(sanitizeReturnTo('/orders?x=1'), '/orders?x=1');
  assert.equal(sanitizeReturnTo('https://springrenaissance.store/products/kouros'), 'https://springrenaissance.store/products/kouros');
});

// ---- 5. Leaks -----------------------------------------------------------------

test("no response to A carries B's email, any session hash, or internal ids of other systems", async () => {
  const { t, a, b } = await twoAccounts();
  await t.call(post('/api/wishlist', { product_handle: 'kouros' }, a.as()));
  const hashes = t.rows('SELECT id_hash FROM sessions').map((r) => r.id_hash);
  for (const path of ['/api/me', '/api/sessions', '/api/passkeys', '/api/wishlist', '/api/wishlist/handles', '/api/holds', '/api/gift-cards', '/api/orders', '/api/circle/teaser']) {
    const text = await (await t.call(get(path, { Cookie: a.cookie }))).text();
    assert.equal(text.includes(b.user.email), false, `${path} leaks B's email`);
    for (const h of hashes) assert.equal(text.includes(h), false, `${path} leaks a session hash`);
    assert.doesNotMatch(text, /stripe_customer_id|shopify_customer_id|id_hash|token_hash|code_hash|public_key/, path);
  }
});

test('errors carry no stack traces or SQL', async () => {
  const { t, a } = await twoAccounts();
  const bad = await t.call(new Request('https://w.dev/api/me', { method: 'PATCH', headers: { ...a.as(), 'Content-Type': 'application/json' }, body: '{"first_name":' }));
  assert.equal(bad.status, 400);
  const text = await bad.text();
  assert.doesNotMatch(text, /at \w+ \(|SQLITE|SELECT|\.js:\d+/);
});

// ---- 6. Session and CSRF ---------------------------------------------------------

test('session fixation: a cookie planted before sign-in is never adopted', async () => {
  const t = setup({ world: world() });
  const planted = `${SESSION_COOKIE}=${'P'.repeat(43)}`;
  await t.call(requestLink('alice@example.com', {}, { Cookie: planted }));
  const res = await t.call(verify(tokenFromEmail(t.world.emails.at(-1)), { Cookie: planted }));
  assert.equal(res.status, 200);
  const issued = sessionToken(res);
  assert.ok(issued && issued !== 'P'.repeat(43));
  assert.equal((await t.call(get('/api/me', { Cookie: planted }))).status, 401);
  assert.equal((await t.call(get('/api/me', { Cookie: `${SESSION_COOKIE}=${issued}` }))).status, 200);
});

test('sign-out ends the session on the server: the old cookie stops working', async () => {
  const { t, a } = await twoAccounts();
  assert.equal((await t.call(post('/api/auth/logout', {}, a.as()))).status, 204);
  assert.equal((await t.call(get('/api/me', { Cookie: a.cookie }))).status, 401);
});

test('CSRF: state changes with a valid cookie but a foreign Origin, no Origin, or no X-SR-Client are refused', async () => {
  const { t, a } = await twoAccounts();
  const attempts = [
    { Origin: 'https://evil.example', 'X-SR-Client': 'portal' },
    { 'X-SR-Client': 'portal' },
    { Origin: trusted.Origin },
    { Origin: 'null', 'X-SR-Client': 'portal' },
  ];
  for (const h of attempts) {
    for (const [method, path, b] of [['PATCH', '/api/me', { first_name: 'Pwned' }], ['DELETE', '/api/sessions', undefined], ['DELETE', '/api/account', { confirm: 'DELETE' }], ['POST', '/api/me/email-change', { new_email: 'evil@example.com' }]]) {
      const res = await t.call(req(method, path, b, { Cookie: a.cookie, ...h }));
      assert.equal(res.status, 403, `${method} ${path} ${JSON.stringify(h)}`);
    }
  }
  assert.equal(t.rows('SELECT first_name FROM users WHERE id = ?', a.user.id)[0].first_name, null);
});

// ---- 7. Injection -----------------------------------------------------------------

test('names are stored as text; SQL-looking input changes nothing else', async () => {
  const { t, a, b } = await twoAccounts();
  const evil = "Robert'); DROP TABLE users;--<img src=x onerror=alert(1)>";
  assert.equal((await t.call(req('PATCH', '/api/me', { first_name: evil.slice(0, 80) }, a.as()))).status, 200);
  assert.equal(t.rows('SELECT first_name FROM users WHERE id = ?', a.user.id)[0].first_name, evil.slice(0, 80));
  assert.equal(t.rows('SELECT COUNT(*) AS n FROM users')[0].n, 2);
  assert.equal((await t.call(get('/api/me', { Cookie: b.cookie }))).status, 200);
});
