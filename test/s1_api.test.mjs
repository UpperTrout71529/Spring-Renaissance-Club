// S1: API foundation — router, §8 error shape, CORS / Origin / X-SR-Client,
// /health, session-gated routes, ULIDs and the injected clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, post, get } from './harness.mjs';
import { createApp, ROUTES } from '../src/app.js';
import worker from '../src/index.js';
import { hashSessionToken, SESSION_COOKIE } from '../src/auth/session.js';
import { ulid, ulidTime } from '../src/lib/ulid.js';
import { HttpError } from '../src/http/errors.js';

const CLUB = 'https://club.springrenaissance.store';
const STORE = 'https://springrenaissance.store';
const EVIL = 'https://evil.example';
const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const PEPPER = 'test-pepper';
const TOKEN = 'A'.repeat(43);

const iso = (ms) => new Date(ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

function env(overrides = {}) {
  return makeEnv({ SESSION_PEPPER: PEPPER, ...overrides });
}

async function seedSession(e, {
  token = TOKEN, userId = '01USER', email = 'clara@example.com',
  idleExpires = NOW + 14 * DAY, absoluteExpires = NOW + 90 * DAY, revokedAt = null, deletedAt = null,
  lastSeen = NOW - DAY,
} = {}) {
  e.DB._db.prepare(
    'INSERT OR IGNORE INTO users (id, email, first_name, created_at, deleted_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, email, 'Clara', iso(NOW - DAY), deletedAt);
  e.DB._db.prepare(
    `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, auth_method, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, 'magic_link', ?)`
  ).run(await hashSessionToken(token, PEPPER), userId, iso(NOW - DAY), iso(lastSeen), iso(idleExpires), iso(absoluteExpires), revokedAt);
}

const withSession = (token = TOKEN) => ({ Cookie: `other=1; ${SESSION_COOKIE}=${token}` });
const app = (opts = {}) => createApp({ now: () => NOW, ...opts });

async function body(res) {
  return JSON.parse(await res.text());
}

function assertErrorShape(b, code) {
  assert.deepEqual(Object.keys(b), ['error']);
  assert.equal(b.error.code, code);
  assert.equal(typeof b.error.message, 'string');
  assert.ok(b.error.message.length > 0);
}

// A test-only mutating route, to exercise the guards without S2's endpoints.
const echoRoutes = [
  ...ROUTES,
  { method: 'POST', path: '/api/test/echo', handler: ({ json, newId }) => json({ ok: true, id: newId() }) },
  { method: 'POST', path: '/api/test/private', handler: ({ json, session }) => json({ id: session.user.id }), auth: 'session' },
  { method: 'POST', path: '/api/test/hook', handler: ({ json }) => json({ ok: true }), crossSite: true },
  { method: 'GET', path: '/api/test/boom', handler: () => { throw new Error('secret detail'); } },
  { method: 'GET', path: '/api/test/items/:id', handler: ({ json, params }) => json(params) },
];
const trusted = { Origin: CLUB, 'X-SR-Client': 'portal' };

// ---- /health ---------------------------------------------------------------

test('S1-A1: GET /health → 200 with a D1 round trip, through the real entry point', async () => {
  const res = await worker.fetch(get('/health'), env());
  assert.equal(res.status, 200);
  const b = await body(res);
  assert.equal(b.status, 'ok');
  assert.match(b.time, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('S1-A2: /health → 503 in the error shape when D1 is missing or failing', async () => {
  const r1 = await app().fetch(get('/health'), env({ DB: undefined }));
  assert.equal(r1.status, 503);
  assertErrorShape(await body(r1), 'db_unavailable');

  const e = env();
  e.DB.prepare = () => { throw new Error('D1 down'); };
  const r2 = await app().fetch(get('/health'), e);
  assert.equal(r2.status, 503);
  assertErrorShape(await body(r2), 'db_unavailable');
});

// ---- sessions ------------------------------------------------------------

test('S1-A3: GET /api/me without a session → 401 unauthenticated', async () => {
  const res = await app().fetch(get('/api/me', { Origin: CLUB }), env());
  assert.equal(res.status, 401);
  assertErrorShape(await body(res), 'unauthenticated');
});

test('S1-A4: GET /api/me with a live session → the §8.3 V1 shape', async () => {
  const e = env();
  await seedSession(e);
  const res = await app().fetch(get('/api/me', { Origin: CLUB, ...withSession() }), e);
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), {
    user: { id: '01USER', email: 'clara@example.com', first_name: 'Clara', tier: 'club' },
    membership: null,
    badges: { circle: false },
    onboarding: { passkey: false, saved: false },
  });
});

test('S1-A5: idle-expired, absolute-expired, revoked, deleted-user and unknown sessions → 401', async () => {
  const cases = [
    { idleExpires: NOW },                       // expiry is exclusive
    { absoluteExpires: NOW - 1 },
    { revokedAt: iso(NOW - 1000) },
    { deletedAt: iso(NOW - 1000) },
  ];
  for (const c of cases) {
    const e = env();
    await seedSession(e, c);
    const res = await app().fetch(get('/api/me', withSession()), e);
    assert.equal(res.status, 401, JSON.stringify(c));
  }
  const e = env();
  await seedSession(e);
  for (const token of ['B'.repeat(43), 'short', `${TOKEN}x`]) {
    const res = await app().fetch(get('/api/me', withSession(token)), e);
    assert.equal(res.status, 401, token);
  }
});

test('S1-A6: the injected clock decides session expiry', async () => {
  const e = env();
  // Seen a minute ago, so the first request does not slide the window.
  await seedSession(e, { idleExpires: NOW + 1000, lastSeen: NOW - 60 * 1000 });
  const before = await app().fetch(get('/api/me', withSession()), e);
  assert.equal(before.status, 200);
  const after = await createApp({ now: () => NOW + 1000 }).fetch(get('/api/me', withSession()), e);
  assert.equal(after.status, 401);
});

test('S1-A7: a session cookie without SESSION_PEPPER configured → 503, never a silent pass', async () => {
  const e = env({ SESSION_PEPPER: undefined });
  const res = await app().fetch(get('/api/me', withSession()), e);
  assert.equal(res.status, 503);
  assertErrorShape(await body(res), 'auth_unavailable');
});

// ---- Origin / X-SR-Client ------------------------------------------------

test('S1-A8: a mutating request from a foreign Origin → 403 origin_not_allowed', async () => {
  for (const headers of [{ Origin: EVIL, 'X-SR-Client': 'portal' }, { 'X-SR-Client': 'portal' }]) {
    const res = await app({ routes: echoRoutes }).fetch(post('/api/test/echo', {}, headers), env());
    assert.equal(res.status, 403);
    assertErrorShape(await body(res), 'origin_not_allowed');
  }
});

test('S1-A9: a mutating request without X-SR-Client: portal → 403 client_header_missing', async () => {
  for (const client of [undefined, 'storefront']) {
    const headers = { Origin: CLUB, ...(client ? { 'X-SR-Client': client } : {}) };
    const res = await app({ routes: echoRoutes }).fetch(post('/api/test/echo', {}, headers), env());
    assert.equal(res.status, 403);
    assertErrorShape(await body(res), 'client_header_missing');
  }
});

test('S1-A10: both allowed origins pass the mutation guard', async () => {
  for (const origin of [CLUB, STORE]) {
    const res = await app({ routes: echoRoutes })
      .fetch(post('/api/test/echo', {}, { Origin: origin, 'X-SR-Client': 'portal' }), env());
    assert.equal(res.status, 200, origin);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(res.headers.get('Access-Control-Allow-Credentials'), 'true');
  }
});

test('S1-A11: the Origin check runs before auth — a foreign site learns nothing about the session', async () => {
  const res = await app({ routes: echoRoutes }).fetch(post('/api/test/private', {}, { Origin: EVIL, 'X-SR-Client': 'portal' }), env());
  assert.equal(res.status, 403);
  const res2 = await app({ routes: echoRoutes }).fetch(post('/api/test/private', {}, trusted), env());
  assert.equal(res2.status, 401);
});

test('S1-A12: crossSite routes (webhooks) skip the Origin check', async () => {
  const res = await app({ routes: echoRoutes }).fetch(post('/api/test/hook', {}), env());
  assert.equal(res.status, 200);
});

test('S1-A13: ALLOWED_ORIGINS replaces the default list', async () => {
  const e = env({ ALLOWED_ORIGINS: 'http://localhost:5173, https://club.springrenaissance.store' });
  const ok = await app({ routes: echoRoutes })
    .fetch(post('/api/test/echo', {}, { Origin: 'http://localhost:5173', 'X-SR-Client': 'portal' }), e);
  assert.equal(ok.status, 200);
  const no = await app({ routes: echoRoutes })
    .fetch(post('/api/test/echo', {}, { Origin: STORE, 'X-SR-Client': 'portal' }), e);
  assert.equal(no.status, 403);
});

// ---- CORS ----------------------------------------------------------------

test('S1-A14: preflight from an allowed origin → 204 with credentials, never *', async () => {
  const req = new Request('https://w.dev/api/me', {
    method: 'OPTIONS',
    headers: { Origin: CLUB, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-sr-client' },
  });
  const res = await app().fetch(req, env());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), CLUB);
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /X-SR-Client/);
  assert.match(res.headers.get('Access-Control-Allow-Methods'), /GET/);
  assert.match(res.headers.get('Vary'), /Origin/);
});

test('S1-A15: preflight from a foreign origin → 403 and no CORS grant', async () => {
  const req = new Request('https://w.dev/api/me', { method: 'OPTIONS', headers: { Origin: EVIL } });
  const res = await app().fetch(req, env());
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  assertErrorShape(await body(res), 'origin_not_allowed');
});

test('S1-A16: responses to a foreign origin carry no Access-Control-Allow-Origin', async () => {
  const res = await app().fetch(get('/health', { Origin: EVIL }), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

// ---- error shape and routing ---------------------------------------------

test('S1-A17: wrong method on an owned path → 405 with Allow, in the error shape', async () => {
  const res = await app().fetch(post('/api/me', {}, trusted), env());
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'GET');
  assertErrorShape(await body(res), 'method_not_allowed');
});

test('S1-A18: an unexpected exception → 500 internal_error without leaking the message', async () => {
  const realError = console.error;
  console.error = () => {};
  try {
    const res = await app({ routes: echoRoutes }).fetch(get('/api/test/boom'), env());
    assert.equal(res.status, 500);
    const b = await body(res);
    assertErrorShape(b, 'internal_error');
    assert.ok(!JSON.stringify(b).includes('secret detail'));
  } finally {
    console.error = realError;
  }
});

test('S1-A19: an HttpError thrown by a handler keeps its status, code and headers', async () => {
  const routes = [{ method: 'GET', path: '/api/test/limited', handler: () => { throw new HttpError(429, 'rate_limited', 'Slow down.', { 'Retry-After': '60' }); } }];
  const res = await app({ routes }).fetch(get('/api/test/limited'), env());
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '60');
  assertErrorShape(await body(res), 'rate_limited');
});

test('S1-A20: path params are decoded', async () => {
  const res = await app({ routes: echoRoutes }).fetch(get('/api/test/items/a%20b'), env());
  assert.deepEqual(await body(res), { id: 'a b' });
});

test('S1-A21: paths the router does not own fall through to the legacy worker untouched', async () => {
  const seen = [];
  const legacy = { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response('legacy'); } };
  const a = app({ legacy });
  for (const p of ['/api/user', '/api/auth/request-link', '/']) {
    const res = await a.fetch(post(p, {}), env());
    assert.equal(await res.text(), 'legacy');
  }
  assert.deepEqual(seen, ['/api/user', '/api/auth/request-link', '/']);
});

test('S1-A22: through the real entry point a legacy path still reaches worker.js', async () => {
  const res = await worker.fetch(get('/api/user?auth_token=nope'), env());
  assert.equal(res.status, 401);
  // The legacy shape, not the §8 shape: legacy endpoints are migrated in later tasks.
  assert.deepEqual(await body(res), { error: 'Session expired' });
});

// ---- ULID ----------------------------------------------------------------

test('S1-A23: ULIDs are 26 Crockford chars, carry the injected time and sort by it', async () => {
  const id = ulid(NOW, (n) => new Uint8Array(n).fill(255));
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(ulidTime(id), NOW);
  assert.ok(ulid(NOW) < ulid(NOW + 1));
  assert.throws(() => ulid(-1), RangeError);

  const res = await app({ routes: echoRoutes }).fetch(post('/api/test/echo', {}, trusted), env());
  const b = await body(res);
  assert.equal(ulidTime(b.id), NOW);
});
