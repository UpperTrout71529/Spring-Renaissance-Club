import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { makeEnv, post, seedClient, withFetch } from './harness.mjs';

const OK_GEMINI = async () => new Response(
  JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } }
);

const ENV = { STRIPE_WEBHOOK_SECRET: 'whsec_test_secret', GEMINI_API_KEY: 'g', RESEND_API_KEY: 'r' };

const count = (env, sql, ...b) => env.DB._row(sql, ...b);
const plan = (env, sql) =>
  env.DB._db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail).join(' | ');

// ---------------------------------------------------------------------------
// E-1: /api/auth/request-link is unauthenticated by design. withinRateLimit is
// insert-then-count, so EVERY call writes two rate_events rows — email bucket
// and IP bucket — before either limit is consulted, and the rows live for the
// full 120s window.
//
// One HTTP request from an attacker therefore costs two D1 writes plus a
// full-table DELETE, with no session required. D1's free tier allows 100k row
// writes per day: ~50k unauthenticated requests exhaust it, and once writes
// start failing withinRateLimit's catch fails OPEN — every limit in the system
// stops enforcing at exactly the moment it is under attack.
// ---------------------------------------------------------------------------
test('E-1 refused request-link calls must not accumulate rate_events rows', async () => {
  const env = makeEnv(ENV);

  await withFetch(OK_GEMINI, async () => {
    for (let i = 0; i < 40; i++) {
      const r = await worker.fetch(
        post('/api/auth/request-link', { email: `probe${i}@example.com` },
          { 'CF-Connecting-IP': '203.0.113.9' }),
        env
      );
      assert.equal(r.status, 202, 'the response must stay uniform');
    }
  });

  const stored = count(env, 'SELECT COUNT(*) AS c FROM rate_events').c;
  // One IP, budget 5 per 2 minutes. Everything past the 5th is refused, so a
  // refused call should leave nothing behind.
  assert.ok(
    stored <= 12,
    `refused requests accumulate: ${stored} rate_events rows after 40 unauthenticated calls`
  );
});

// ---------------------------------------------------------------------------
// E-2: a refused request leaves its own row behind, and that row counts against
// the next request. A client whose network retries, or who double-taps send,
// keeps their window saturated: the refusals themselves hold the limit closed.
// "10 per minute" degrades into "locked out for a minute after any burst".
// ---------------------------------------------------------------------------
test('E-2 a burst must not hold the limit closed with its own refusals', async () => {
  const env = makeEnv(ENV);
  await seedClient(env, { token: 'TOK' });

  await withFetch(OK_GEMINI, async () => {
    await Promise.all(Array.from({ length: 25 }, () =>
      worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'hi' }), env)
    ));
  });

  const stored = count(env,
    "SELECT COUNT(*) AS c FROM rate_events WHERE bucket = 'chat' AND subject = 'a@b.com'").c;

  assert.ok(
    stored <= 10,
    `refused attempts are counted against the client: ${stored} rows for a budget of 10`
  );
});

// ---------------------------------------------------------------------------
// E-3: both opportunistic cleanups sit on hot paths and neither can use an
// index. D1 meters rows READ, not just returned, so the cost of one chat
// message or one webhook grows with the size of the whole table instead of
// staying constant. The free tier allows 5M row reads per day.
// ---------------------------------------------------------------------------
test('E-3 hot-path cleanups must not full-scan their tables', () => {
  const env = makeEnv(ENV);

  const ratePlan = plan(env, 'DELETE FROM rate_events WHERE created_at < 1');
  assert.ok(!/SCAN rate_events/.test(ratePlan), `rate_events cleanup full-scans: ${ratePlan}`);

  const eventPlan = plan(env, 'DELETE FROM processed_events WHERE processed_at < 1');
  assert.ok(!/SCAN processed_events/.test(eventPlan), `processed_events cleanup full-scans: ${eventPlan}`);
});

// ---------------------------------------------------------------------------
// The E-2 withdrawal is built on `meta.last_row_id` coming back from batch().
// The emulator provides it; whether a given D1 release does is a property of
// the platform, not of this code. If it ever comes back undefined the
// withdrawal would silently become a no-op and E-2 would regress in production
// with every local test still green — so the fallback is exercised here rather
// than left as a line in a deploy checklist.
// ---------------------------------------------------------------------------
test('E-2 withdrawal still works when batch() omits last_row_id', async () => {
  const env = makeEnv(ENV);
  await seedClient(env, { token: 'TOK' });

  // Strip last_row_id from every batch result, emulating a runtime that does
  // not report it.
  const realBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (statements) => {
    const results = await realBatch(statements);
    return results.map((r) => ({ ...r, meta: { ...r.meta, last_row_id: undefined } }));
  };

  await withFetch(OK_GEMINI, async () => {
    for (let i = 0; i < 14; i++) {
      await worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'hi' }), env);
    }
  });

  const stored = count(env,
    "SELECT COUNT(*) AS c FROM rate_events WHERE bucket = 'chat' AND subject = 'a@b.com'").c;
  assert.ok(stored <= 10,
    `fallback withdrawal did not fire: ${stored} rows for a budget of 10`);
});

// ---------------------------------------------------------------------------
// E-3 above asserts the INDEXES exist, and that is the decisive half: with
// idx_rate_events_created in place even the unscoped `WHERE created_at < ?`
// plans as a SEARCH rather than a SCAN. Verified directly — both forms are
// index-backed once the schema is applied.
//
// So the scoping in the hot path is a second, smaller win: it touches only
// this subject's expired rows instead of every subject's. Nothing above would
// notice if it were reverted, which is exactly why it is pinned here.
// ---------------------------------------------------------------------------
test('E-3 the hot-path sweep is scoped to its own subject', async () => {
  const env = makeEnv(ENV);
  await seedClient(env, { token: 'TOK' });

  // An expired row belonging to somebody else.
  env.DB._db.prepare('INSERT INTO rate_events (bucket, subject, created_at) VALUES (?,?,?)')
    .run('chat', 'someone-else@b.com', Date.now() - 600000);

  // Pin the probabilistic global sweep off, or this is flaky 1 run in 64.
  const realRandom = Math.random;
  Math.random = () => 1;
  try {
    await withFetch(OK_GEMINI, () =>
      worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'hi' }), env));
  } finally {
    Math.random = realRandom;
  }

  const others = count(env,
    "SELECT COUNT(*) AS c FROM rate_events WHERE subject = 'someone-else@b.com'").c;
  assert.equal(others, 1,
    'the hot-path delete reached beyond its own bucket+subject');
});
