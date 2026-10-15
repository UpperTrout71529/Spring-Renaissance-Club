// S2: sign-in by email link, sessions, limits, Turnstile, the sign_in_link
// email, Shopify customer linking and the auth events.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, post, get } from './harness.mjs';
import { createApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { sanitizeReturnTo } from '../src/routes/auth.js';

const CLUB = 'https://club.springrenaissance.store';
const T0 = Date.parse('2026-10-15T12:00:00.000Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const trusted = { Origin: CLUB, 'X-SR-Client': 'portal' };

// ---- a fake outside world: Resend, Turnstile, Shopify ----------------------

function makeWorld({ turnstileOk = true, resendOk = true, shopifyCustomers = [] } = {}) {
  const world = {
    emails: [],
    turnstileCalls: 0,
    shopify: { customers: shopifyCustomers.map((c) => ({ tags: [], numberOfOrders: '0', ...c })), creates: 0, tagged: [] },
  };
  world.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.resend.com/')) {
      if (!resendOk) return new Response('{}', { status: 500 });
      world.emails.push({ ...JSON.parse(init.body), idempotencyKey: init.headers['Idempotency-Key'] });
      return Response.json({ id: `re_${world.emails.length}` });
    }
    if (u.startsWith('https://challenges.cloudflare.com/')) {
      world.turnstileCalls++;
      return Response.json({ success: turnstileOk && init.body.get('response') === 'ok-token' });
    }
    if (u.includes('.myshopify.com/admin/api/')) {
      assert.equal(init.headers['X-Shopify-Access-Token'], 'shpat_test');
      const { query, variables } = JSON.parse(init.body);
      const s = world.shopify;
      // Yield so concurrent callers genuinely interleave around the store.
      await new Promise((r) => setTimeout(r, 0));
      if (query.includes('customers(')) {
        const email = /email:"(.*)"/.exec(variables.query)[1];
        const c = s.customers.find((x) => x.email === email);
        return Response.json({ data: { customers: { nodes: c ? [{ id: c.id, numberOfOrders: c.numberOfOrders }] : [] } } });
      }
      if (query.includes('customerCreate')) {
        const { email, tags } = variables.input;
        if (s.customers.some((x) => x.email === email)) {
          return Response.json({ data: { customerCreate: { customer: null, userErrors: [{ field: ['email'], message: 'Email has already been taken' }] } } });
        }
        s.creates++;
        const c = { id: `gid://shopify/Customer/${100 + s.customers.length}`, email, tags: [...tags], numberOfOrders: '0' };
        s.customers.push(c);
        return Response.json({ data: { customerCreate: { customer: { id: c.id, numberOfOrders: '0' }, userErrors: [] } } });
      }
      if (query.includes('tagsAdd')) {
        const c = s.customers.find((x) => x.id === variables.id);
        c.tags.push(...variables.tags);
        s.tagged.push(variables.id);
        return Response.json({ data: { tagsAdd: { userErrors: [] } } });
      }
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return world;
}

function setup({ world = makeWorld(), envOverrides = {} } = {}) {
  let nowMs = T0;
  const pending = [];
  const env = makeEnv({
    SESSION_PEPPER: 'pepper',
    TURNSTILE_SECRET: 'ts_secret',
    RESEND_API_KEY: 're_key',
    SHOPIFY_SHOP: 'example.myshopify.com',
    SHOPIFY_ADMIN_TOKEN: 'shpat_test',
    ...envOverrides,
  });
  const app = createApp({ now: () => nowMs, fetch: world.fetch });
  const executionCtx = { waitUntil: (p) => pending.push(p) };
  const call = async (req) => {
    const res = await app.fetch(req, env, executionCtx);
    await Promise.all(pending.splice(0));
    return res;
  };
  return {
    env, world, call,
    setNow: (ms) => { nowMs = ms; },
    rows: (sql, ...a) => env.DB._rows(sql, ...a),
  };
}

const requestLink = (email, extra = {}, headers = {}) =>
  post('/api/auth/magic-link', { email, turnstile_token: 'ok-token', ...extra }, { ...trusted, ...headers });
const verify = (token, headers = {}) => post('/api/auth/verify', { token }, { ...trusted, ...headers });

function tokenFromEmail(email) {
  return /#t=([A-Za-z0-9_-]{43})/.exec(email.text)[1];
}

function sessionToken(res) {
  const c = res.headers.get('Set-Cookie') || '';
  const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(c);
  return m ? m[1] : null;
}

async function signIn(t, email = 'clara@example.com') {
  await t.call(requestLink(email));
  const token = tokenFromEmail(t.world.emails.at(-1));
  const res = await t.call(verify(token));
  return { res, token, cookie: `${SESSION_COOKIE}=${sessionToken(res)}` };
}

const body = async (res) => JSON.parse(await res.text());

// ---- magic-link ----------------------------------------------------------

test('S2-1: the magic-link answer is identical for a known and an unknown email', async () => {
  const t = setup();
  await signIn(t, 'known@example.com');
  const a = await t.call(requestLink('known@example.com'));
  const b = await t.call(requestLink('stranger@example.com'));
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.equal(await a.text(), await b.text());
  // Both get a link: the same link signs in or creates the account.
  assert.deepEqual(t.world.emails.slice(-2).map((e) => e.to[0]), ['known@example.com', 'stranger@example.com']);
});

test('S2-2: the email carries a #fragment link to the portal; D1 keeps only the hash', async () => {
  const t = setup();
  await t.call(requestLink('  Clara@Example.COM '));
  const [mail] = t.world.emails;
  assert.equal(mail.from, 'Spring Renaissance <concierge@springrenaissance.store>');
  assert.equal(mail.subject, 'Your sign-in link');
  assert.deepEqual(mail.to, ['clara@example.com']);
  const token = tokenFromEmail(mail);
  assert.ok(mail.text.includes(`https://club.springrenaissance.store/auth#t=${token}`));
  assert.ok(mail.html.includes(`/auth#t=${token}`));
  assert.match(mail.text, /works once, for 15 minutes/);
  assert.match(mail.idempotencyKey, /^sign_in_link:[0-9a-f]{64}$/);

  const [row] = t.rows('SELECT * FROM magic_links');
  assert.notEqual(row.token_hash, token);
  assert.ok(!JSON.stringify(row).includes(token));
  assert.equal(row.email, 'clara@example.com');
  assert.equal(row.expires_at, new Date(T0 + 15 * MIN).toISOString());
  assert.equal(t.rows("SELECT status FROM email_log WHERE template = 'sign_in_link'")[0].status, 'sent');
});

test('S2-3: a malformed email → 400 invalid_email, nothing sent', async () => {
  const t = setup();
  for (const email of ['nope', 'a@b', '"q"@example.com', '', 42]) {
    const res = await t.call(requestLink(email));
    assert.equal(res.status, 400);
    assert.equal((await body(res)).error.code, 'invalid_email');
  }
  assert.equal(t.world.emails.length, 0);
});

test('S2-4: Turnstile fails closed — a bad token or a missing secret sends nothing', async () => {
  const t = setup();
  const res = await t.call(requestLink('clara@example.com', { turnstile_token: 'bad' }));
  assert.equal(res.status, 400);
  assert.equal((await body(res)).error.code, 'turnstile_failed');

  const t2 = setup({ envOverrides: { TURNSTILE_SECRET: undefined } });
  const res2 = await t2.call(requestLink('clara@example.com'));
  assert.equal(res2.status, 400);
  assert.equal(t2.world.turnstileCalls, 0);
  assert.equal(t.world.emails.length + t2.world.emails.length, 0);
});

test('S2-5: 3 links per email per 10 minutes, then 429; the window slides', async () => {
  const t = setup();
  for (let i = 0; i < 3; i++) assert.equal((await t.call(requestLink('clara@example.com'))).status, 202);
  const over = await t.call(requestLink('clara@example.com'));
  assert.equal(over.status, 429);
  assert.equal((await body(over)).error.code, 'rate_limited');
  // Another address is unaffected.
  assert.equal((await t.call(requestLink('other@example.com'))).status, 202);
  t.setNow(T0 + 10 * MIN + 1);
  assert.equal((await t.call(requestLink('clara@example.com'))).status, 202);
  assert.equal(t.world.emails.filter((e) => e.to[0] === 'clara@example.com').length, 4);
});

test('S2-6: 10 links per email per day', async () => {
  const t = setup();
  let sent = 0;
  for (let i = 0; i < 12; i++) {
    t.setNow(T0 + i * 11 * MIN); // always outside the 10-minute window
    if ((await t.call(requestLink('clara@example.com'))).status === 202) sent++;
  }
  assert.equal(sent, 10);
});

test('S2-7: 20 link requests per IP per hour', async () => {
  const t = setup();
  const statuses = [];
  for (let i = 0; i < 21; i++) {
    statuses.push((await t.call(requestLink(`p${i}@example.com`, {}, { 'CF-Connecting-IP': '203.0.113.9' }))).status);
  }
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(202));
  assert.equal(statuses[20], 429);
});

test('S2-8: return_to keeps portal paths and storefront URLs only', () => {
  assert.equal(sanitizeReturnTo('/orders/1042'), '/orders/1042');
  assert.equal(sanitizeReturnTo('https://springrenaissance.store/products/vase'), 'https://springrenaissance.store/products/vase');
  for (const bad of ['//evil.example/x', '/\\evil.example', 'https://evil.example/', 'https://springrenaissance.store.evil.example/',
    'javascript:alert(1)', 'https://user:pw@springrenaissance.store/', 42, null]) {
    assert.equal(sanitizeReturnTo(bad), null, String(bad));
  }
});

test('S2-9: a Resend failure is logged as failed and still answers 202', async () => {
  const t = setup({ world: makeWorld({ resendOk: false }) });
  const res = await t.call(requestLink('clara@example.com'));
  assert.equal(res.status, 202);
  assert.equal(t.rows('SELECT status FROM email_log')[0].status, 'failed');
});

// ---- verify --------------------------------------------------------------

test('S2-10: verify → 200, a __Host- session cookie for 14 days, a new Club user', async () => {
  const t = setup();
  await t.call(requestLink('clara@example.com', { return_to: '/orders' }));
  const res = await t.call(verify(tokenFromEmail(t.world.emails[0]), { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }));
  assert.equal(res.status, 200);
  const b = await body(res);
  assert.equal(b.user.email, 'clara@example.com');
  assert.equal(b.user.tier, 'club');
  assert.equal(b.return_to, '/orders');

  const cookie = res.headers.get('Set-Cookie');
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=1209600$`));
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), CLUB);
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), 'true');

  const [s] = t.rows('SELECT * FROM sessions');
  assert.equal(s.user_id, b.user.id);
  assert.equal(s.auth_method, 'magic_link');
  assert.equal(s.ua_summary, 'Safari on iPhone');
  assert.equal(s.idle_expires_at, new Date(T0 + 14 * DAY).toISOString());
  assert.equal(s.absolute_expires_at, new Date(T0 + 90 * DAY).toISOString());
  assert.ok(!JSON.stringify(s).includes(sessionToken(res)));
  const [u] = t.rows('SELECT * FROM users');
  assert.equal(u.email_verified_at, new Date(T0).toISOString());
  assert.equal(u.last_login_at, new Date(T0).toISOString());
});

test('S2-11: the link is one-time — a second verify → 410 link_expired', async () => {
  const t = setup();
  const { token } = await signIn(t);
  const again = await t.call(verify(token));
  assert.equal(again.status, 410);
  const b = await body(again);
  assert.equal(b.error.code, 'link_expired');
  assert.equal(again.headers.get('Set-Cookie'), null);
  assert.equal(t.rows('SELECT COUNT(*) AS n FROM sessions')[0].n, 1);
});

test('S2-12: two concurrent verifies of one link → exactly one session', async () => {
  const t = setup();
  await t.call(requestLink('clara@example.com'));
  const token = tokenFromEmail(t.world.emails[0]);
  const results = await Promise.all([t.call(verify(token)), t.call(verify(token))]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 410]);
  assert.equal(t.rows('SELECT COUNT(*) AS n FROM sessions')[0].n, 1);
});

test('S2-13: a link expires after 15 minutes → 410', async () => {
  const t = setup();
  await t.call(requestLink('clara@example.com'));
  const token = tokenFromEmail(t.world.emails[0]);
  t.setNow(T0 + 15 * MIN);
  assert.equal((await t.call(verify(token))).status, 410);
  t.setNow(T0 + 15 * MIN - 1);
  assert.equal((await t.call(verify(token))).status, 200);
});

test('S2-14: unknown and malformed tokens → 410, indistinguishable', async () => {
  const t = setup();
  for (const token of ['Z'.repeat(43), 'short', undefined, 42]) {
    const res = await t.call(verify(token));
    assert.equal(res.status, 410);
    assert.equal((await body(res)).error.code, 'link_expired');
  }
});

test('S2-15: verify is limited to 10 per minute per IP', async () => {
  const t = setup();
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await t.call(verify('Z'.repeat(43), { 'CF-Connecting-IP': '198.51.100.7' }))).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(410));
  assert.equal(statuses[10], 429);
});

test('S2-16: signing in again reuses the account; a different address gets its own', async () => {
  const t = setup();
  const first = await body((await signIn(t)).res);
  t.setNow(T0 + 11 * MIN);
  const second = await body((await signIn(t, 'CLARA@example.com')).res);
  assert.equal(second.user.id, first.user.id);
  const other = await body((await signIn(t, 'david@example.com')).res);
  assert.notEqual(other.user.id, first.user.id);
  assert.equal(t.rows('SELECT COUNT(*) AS n FROM users')[0].n, 2);
});

test('S2-17: the session cookie from verify opens /api/me', async () => {
  const t = setup();
  const { cookie } = await signIn(t);
  const me = await t.call(get('/api/me', { Origin: CLUB, Cookie: cookie }));
  assert.equal(me.status, 200);
  assert.equal((await body(me)).user.email, 'clara@example.com');
});

// ---- sessions: sliding window, absolute cap, logout ------------------------

test('S2-18: the session slides at most hourly and refreshes the cookie', async () => {
  const t = setup();
  const { cookie } = await signIn(t);
  t.setNow(T0 + 30 * MIN);
  const early = await t.call(get('/api/me', { Cookie: cookie }));
  assert.equal(early.headers.get('Set-Cookie'), null);

  t.setNow(T0 + 13 * DAY);
  const later = await t.call(get('/api/me', { Cookie: cookie }));
  assert.equal(later.status, 200);
  assert.match(later.headers.get('Set-Cookie'), /Max-Age=1209600$/);
  assert.equal(t.rows('SELECT idle_expires_at FROM sessions')[0].idle_expires_at, new Date(T0 + 27 * DAY).toISOString());

  // 14 idle days after the last activity: gone.
  t.setNow(T0 + 27 * DAY);
  assert.equal((await t.call(get('/api/me', { Cookie: cookie }))).status, 401);
});

test('S2-19: activity cannot extend a session past 90 days', async () => {
  const t = setup();
  const { cookie } = await signIn(t);
  for (let d = 10; d < 90; d += 10) {
    t.setNow(T0 + d * DAY);
    assert.equal((await t.call(get('/api/me', { Cookie: cookie }))).status, 200, `day ${d}`);
  }
  t.setNow(T0 + 89 * DAY);
  const last = await t.call(get('/api/me', { Cookie: cookie }));
  assert.match(last.headers.get('Set-Cookie'), /Max-Age=86400$/);
  t.setNow(T0 + 90 * DAY);
  assert.equal((await t.call(get('/api/me', { Cookie: cookie }))).status, 401);
});

test('S2-20: SESSION_IDLE_DAYS configures the idle window', async () => {
  const t = setup({ envOverrides: { SESSION_IDLE_DAYS: '7' } });
  const { res } = await signIn(t);
  assert.match(res.headers.get('Set-Cookie'), /Max-Age=604800$/);
});

test('S2-21: logout revokes the session and clears the cookie', async () => {
  const t = setup();
  const { cookie } = await signIn(t);
  const out = await t.call(post('/api/auth/logout', {}, { ...trusted, Cookie: cookie }));
  assert.equal(out.status, 204);
  assert.equal(out.headers.get('Set-Cookie'), `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
  assert.equal(out.headers.get('Access-Control-Allow-Origin'), CLUB);
  assert.ok(t.rows('SELECT revoked_at FROM sessions')[0].revoked_at);
  assert.equal((await t.call(get('/api/me', { Cookie: cookie }))).status, 401);
});

test('S2-22: logout without a session still answers 204; from a foreign origin 403', async () => {
  const t = setup();
  assert.equal((await t.call(post('/api/auth/logout', {}, trusted))).status, 204);
  const evil = await t.call(post('/api/auth/logout', {}, { Origin: 'https://evil.example', 'X-SR-Client': 'portal' }));
  assert.equal(evil.status, 403);
});

test('S2-23: magic-link and verify need the portal Origin and X-SR-Client', async () => {
  const t = setup();
  const res = await t.call(post('/api/auth/magic-link', { email: 'clara@example.com', turnstile_token: 'ok-token' }, { Origin: CLUB }));
  assert.equal(res.status, 403);
  assert.equal(t.world.emails.length, 0);
});

// ---- Shopify linking -----------------------------------------------------

test('S2-24: a new customer is created in Shopify once, tagged sr-club, without marketing consent', async () => {
  const t = setup();
  await signIn(t);
  assert.equal(t.world.shopify.creates, 1);
  const [c] = t.world.shopify.customers;
  assert.deepEqual(c.tags, ['sr-club']);
  assert.equal(t.rows('SELECT shopify_customer_id FROM users')[0].shopify_customer_id, c.id);

  // Later sign-ins do not touch Shopify again.
  t.setNow(T0 + 11 * MIN);
  await signIn(t);
  assert.equal(t.world.shopify.creates, 1);
  assert.equal(t.world.shopify.tagged.length, 0);
});

test('S2-25: an existing Shopify customer is found, tagged and linked — not duplicated', async () => {
  const world = makeWorld({ shopifyCustomers: [{ id: 'gid://shopify/Customer/7', email: 'clara@example.com', tags: ['reserve'], numberOfOrders: '3' }] });
  const t = setup({ world });
  await signIn(t);
  assert.equal(world.shopify.creates, 0);
  assert.deepEqual(world.shopify.customers[0].tags, ['reserve', 'sr-club']);
  assert.equal(t.rows('SELECT shopify_customer_id FROM users')[0].shopify_customer_id, 'gid://shopify/Customer/7');
  const ev = t.rows("SELECT props_json FROM events WHERE name = 'account_created'");
  assert.deepEqual(JSON.parse(ev[0].props_json), { had_shopify_orders: true });
});

test('S2-26: two first sign-ins racing for one email → one user and one Shopify customer', async () => {
  const t = setup();
  await t.call(requestLink('clara@example.com'));
  await t.call(requestLink('clara@example.com'));
  const [a, b] = t.world.emails.map(tokenFromEmail);
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let results;
  try {
    results = await Promise.all([t.call(verify(a)), t.call(verify(b))]);
  } finally {
    console.error = realError;
  }
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  // The loser of the create race re-reads the winner's customer instead of failing.
  assert.deepEqual(errors, []);
  assert.equal(t.rows('SELECT COUNT(*) AS n FROM users')[0].n, 1);
  assert.equal(t.world.shopify.customers.length, 1);
  assert.equal(t.world.shopify.creates, 1);
  assert.ok(t.rows('SELECT shopify_customer_id FROM users')[0].shopify_customer_id);
});

test('S2-27: Shopify down or unconfigured → sign-in still works; linking retries next time', async () => {
  const world = makeWorld();
  const realFetch = world.fetch;
  let shopifyUp = false;
  world.fetch = (url, init) => (String(url).includes('myshopify') && !shopifyUp ? Promise.resolve(new Response('', { status: 503 })) : realFetch(url, init));
  const realError = console.error;
  console.error = () => {};
  try {
    const t = setup({ world });
    const { res } = await signIn(t);
    assert.equal(res.status, 200);
    assert.equal(t.rows('SELECT shopify_customer_id FROM users')[0].shopify_customer_id, null);
    shopifyUp = true;
    t.setNow(T0 + 11 * MIN);
    await signIn(t);
    assert.ok(t.rows('SELECT shopify_customer_id FROM users')[0].shopify_customer_id);

    const t2 = setup({ envOverrides: { SHOPIFY_SHOP: undefined } });
    assert.equal((await signIn(t2)).res.status, 200);
  } finally {
    console.error = realError;
  }
});

// ---- events --------------------------------------------------------------

test('S2-28: login_requested, login_succeeded and account_created are recorded', async () => {
  const t = setup();
  await signIn(t);
  t.setNow(T0 + 11 * MIN);
  await signIn(t);
  const evs = t.rows('SELECT name, props_json FROM events ORDER BY created_at, rowid')
    .map((e) => [e.name, JSON.parse(e.props_json)]);
  assert.deepEqual(evs, [
    ['login_requested', { method: 'magic_link' }],
    ['login_succeeded', { method: 'magic_link', is_first: true }],
    ['account_created', { had_shopify_orders: false }],
    ['login_requested', { method: 'magic_link' }],
    ['login_succeeded', { method: 'magic_link', is_first: false }],
  ]);
});
