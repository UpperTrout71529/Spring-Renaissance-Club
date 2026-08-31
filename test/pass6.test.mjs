// ============================================================================
// Pass 6 — adversarial. Every test here is written to FAIL against the current
// worker.js if the hypothesis holds. Nothing is asserted from the existing
// suite's assumptions.
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import {
  makeEnv, makeKV, makeDB, post, get, webhookRequest, WEBHOOK_SECRET,
  seedClient, seedUser, userRow, withFetch
} from './harness.mjs';

const OK_GEMINI = async () => new Response(
  JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } }
);
const ENV = { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, GEMINI_API_KEY: 'g', RESEND_API_KEY: 'r' };
const rows = (env, sql, ...b) => env.DB._rows(sql, ...b);
const one = (env, sql, ...b) => env.DB._row(sql, ...b);

// ---------------------------------------------------------------------------
// H-1 (asked): does the MAX(id) fallback in withdrawRateEvent steal a
// concurrent request's row, inflating the attacker's budget?
//
// The invariant that matters is not "each request deletes its own row" but
// "rows surviving in the window == requests admitted". If a refusal ever
// removes MORE than its own share, the next window opens early.
// ---------------------------------------------------------------------------
test('H-1 MAX(id) fallback: surviving rows must equal admitted requests', async () => {
  for (const interleave of [false, true]) {
    const env = makeEnv({ ...ENV, interleave });
    await seedClient(env, { token: 'TOK' });

    // Force the fallback path: no runtime-supplied last_row_id anywhere.
    const realBatch = env.DB.batch.bind(env.DB);
    env.DB.batch = async (st) =>
      (await realBatch(st)).map((r) => ({ ...r, meta: { ...r.meta, last_row_id: undefined } }));

    const results = await withFetch(OK_GEMINI, () => Promise.all(
      Array.from({ length: 40 }, () =>
        worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'hi' }), env))
    ));

    const admitted = results.filter((r) => r.status === 200).length;
    const surviving = one(env,
      "SELECT COUNT(*) AS c FROM rate_events WHERE bucket='chat' AND subject='a@b.com'").c;

    assert.equal(surviving, admitted,
      `interleave=${interleave}: ${surviving} rows survive for ${admitted} admitted requests ` +
      `— the fallback deleted somebody else's row and freed budget`);
  }
});

// ---------------------------------------------------------------------------
// H-2: sweepExpiredRateEvents is handed the floor of the CALLING bucket's
// window and then deletes GLOBALLY.
//
//   chat        window =  60_000 ms
//   link_ip     window = 120_000 ms
//   link_email  window = 120_000 ms
//
// So a chat message computes floor = now - 60s and runs
// `DELETE FROM rate_events WHERE created_at < floor` across every bucket.
// Any link_ip / link_email row between 60s and 120s old is INSIDE its own
// window and is deleted anyway. The unauthenticated link limiter is reset by
// an authenticated caller on another endpoint.
// ---------------------------------------------------------------------------
test('H-2 a chat sweep must not delete link rows that are still inside their window', async () => {
  const env = makeEnv(ENV);
  await seedClient(env, { token: 'TOK' });

  const now = Date.now();
  // Five link_ip rows, 90s old: past the chat window (60s), well inside the
  // link window (120s). This is a caller who has spent their whole IP budget
  // 90 seconds ago and must stay blocked for another 30.
  for (let i = 0; i < 5; i++) {
    env.DB._db.prepare('INSERT INTO rate_events (bucket,subject,created_at) VALUES (?,?,?)')
      .run('link_ip', '203.0.113.9', now - 90_000);
  }

  // Force the 1/64 sweep to fire on this chat message.
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    await withFetch(OK_GEMINI, () =>
      worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'hi' }), env));
  } finally {
    Math.random = realRandom;
  }

  const left = one(env,
    "SELECT COUNT(*) AS c FROM rate_events WHERE bucket='link_ip' AND subject='203.0.113.9'").c;
  assert.equal(left, 5,
    `a chat message swept ${5 - left} link_ip rows that were still inside the 120s link window`);
});

// End-to-end consequence of H-2: the swept caller gets their budget back early.
test('H-2b the IP budget must not reopen early because a chat message swept it', async () => {
  const env = makeEnv(ENV);
  await seedClient(env, { token: 'TOK' });
  const IP = { 'CF-Connecting-IP': '203.0.113.9' };

  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    env.DB._db.prepare('INSERT INTO rate_events (bucket,subject,created_at) VALUES (?,?,?)')
      .run('link_ip', '203.0.113.9', now - 90_000);
  }

  const sent = [];
  const fetchStub = async (url, opts) => {
    if (String(url).includes('resend')) { sent.push(JSON.parse(opts.body).to[0]); return new Response(JSON.stringify({ id: 'e' }), { status: 200 }); }
    return OK_GEMINI();
  };

  await withFetch(fetchStub, async () => {
    // Blocked: 5 rows already in the window, budget is 5.
    await worker.fetch(post('/api/auth/request-link', { email: 'a@b.com' }, IP), env);
    assert.equal(sent.length, 0, 'precondition: the IP is over budget and gets no letter');

    const realRandom = Math.random;
    Math.random = () => 0;                 // the attacker's own chat message sweeps
    try {
      await worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'sweep' }), env);
    } finally { Math.random = realRandom; }

    await worker.fetch(post('/api/auth/request-link', { email: 'a@b.com' }, IP), env);
  });

  assert.equal(sent.length, 0,
    'the link limiter reopened 30s early because a chat message swept its rows');
});

// ---------------------------------------------------------------------------
// H-3: mirrorUserToKv is SELECT-then-PUT in JavaScript — the exact
// read-modify-write shape ADR-001 removed from D1, still live on the KV
// rollback path. Two concurrent mutations can commit to D1 in one order and
// mirror in the other, leaving user_<email> permanently BEHIND D1.
//
// README §"Migration and rollback": "The KV records are current as of the last
// mutation, so nothing is lost." That is the claim under test.
// ---------------------------------------------------------------------------
test('H-3 the KV rollback mirror must match D1 after concurrent renewals', async () => {
  const env = makeEnv({ ...ENV, interleave: true });
  await seedClient(env, { credits: 0 });

  // Widen the SELECT -> PUT window the way a real KV round-trip does.
  const realPut = env.CLIENT_KV.put.bind(env.CLIENT_KV);
  env.CLIENT_KV.put = async (k, v, o) => {
    await new Promise((r) => setTimeout(r, 1));
    return realPut(k, v, o);
  };

  const reqs = await Promise.all(Array.from({ length: 10 }, (_, i) => webhookRequest({
    id: 'mir_' + i, type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_1' } }
  })));
  await Promise.all(reqs.map((r) => worker.fetch(r, env)));

  const d1 = userRow(env).credits;
  const mirrored = JSON.parse(await env.CLIENT_KV.get('user_a@b.com')).tokens;

  assert.equal(d1, 200, 'precondition: D1 credited all ten renewals');
  assert.equal(mirrored, d1,
    `rollback mirror is stale: D1 has ${d1} credits, KV has ${mirrored} — ` +
    `a rollback would hand the client back ${d1 - mirrored} fewer tokens than they paid for`);
});

// ---------------------------------------------------------------------------
// H-4: withinRateLimit short-circuits on a falsy subject.
//   const ip = request.headers.get("CF-Connecting-IP") || "";
//   if (!subject) return true;
// With no CF-Connecting-IP the IP budget is not consulted AND writes no row,
// so the only remaining limit is per-email — and a fresh address is a fresh
// subject with a clean budget. E-1's bound depends entirely on a header the
// worker never verifies is present.
// ---------------------------------------------------------------------------
test('H-4 request-link must stay bounded when CF-Connecting-IP is absent', async () => {
  const env = makeEnv(ENV);

  await withFetch(async () => new Response(JSON.stringify({ id: 'e' }), { status: 200 }), async () => {
    for (let i = 0; i < 40; i++) {
      const r = await worker.fetch(
        post('/api/auth/request-link', { email: `probe${i}@example.com` }), env);  // no IP header
      assert.equal(r.status, 202);
    }
  });

  const stored = one(env, 'SELECT COUNT(*) AS c FROM rate_events').c;
  assert.ok(stored <= 12,
    `no CF-Connecting-IP: 40 unauthenticated calls wrote ${stored} rate_events rows ` +
    `— E-1's bound is gone when the header is missing`);
});

// ---------------------------------------------------------------------------
// H-5: the payment idempotency window. reserveEvent commits the reservation
// BEFORE the credit is applied. Verified directions:
//   (a) parallel duplicates must credit exactly once   [expected: holds]
//   (b) a failure after reservation must release it     [expected: holds]
//   (c) an isolate death after reservation loses the payment for good
// (c) is the one with no catch block to save it.
// ---------------------------------------------------------------------------
test('H-5a 50 parallel duplicate deliveries credit exactly once', async () => {
  const env = makeEnv({ ...ENV, interleave: true });
  await seedClient(env, { credits: 0 });
  const reqs = await Promise.all(Array.from({ length: 50 }, () => webhookRequest({
    id: 'dup_one', type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_1' } }
  })));
  await Promise.all(reqs.map((r) => worker.fetch(r, env)));
  assert.equal(userRow(env).credits, 20);
});

test('H-5c an isolate killed after reservation must not silently eat the payment', async () => {
  const env = makeEnv(ENV);
  await seedClient(env, { credits: 0 });

  const evt = {
    id: 'kill_me', type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_1' } }
  };

  // Simulate the isolate dying between reserve and credit: the reservation is
  // committed, then nothing else runs — no catch, no release. This is a CPU
  // limit / eviction, not an exception.
  await worker.fetch(await webhookRequest(evt), env).catch(() => {});
  // Re-run reserveEvent's effect by hand is not needed; the first call already
  // reserved AND credited. Instead model the kill directly:
  const env2 = makeEnv(ENV);
  await seedClient(env2, { credits: 0 });
  // FIXTURE CORRECTED (assertion untouched): the reservation is aged past
  // RESERVATION_STALE_MS. The original wrote Date.now(), i.e. a reservation
  // taken this instant — but a fresh pending row is indistinguishable from one
  // whose handler is still running, and reclaiming it double-credits. Proven:
  // with the stale window set to 0 this test passes and H-5a credits 40
  // instead of 20. Stripe's first retry arrives minutes later anyway, so the
  // aged row is what an isolate death actually leaves behind.
  env2.DB._db.prepare('INSERT INTO processed_events (event_id,event_type,processed_at) VALUES (?,?,?)')
    .run('kill_me', 'invoice.payment_succeeded', Date.now() - 130_000);

  const retry = await worker.fetch(await webhookRequest(evt), env2);
  const body = await retry.json();

  assert.equal(userRow(env2).credits, 20,
    `Stripe's retry was answered "${JSON.stringify(body)}" and the +20 was never applied — ` +
    `the reservation outlived the isolate that took it`);
});

// ---------------------------------------------------------------------------
// H-6: KV throttling (1 write/sec/key) on the chat mirror. Every message
// writes curator_<email>. Under a burst KV answers 429; the catch swallows it.
// Question: does D1 stay correct, and is the desync bounded?
// ---------------------------------------------------------------------------
test('H-6 KV 429 on the chat mirror must not corrupt D1 or drop a message', async () => {
  let puts = 0;
  const kv = makeKV({}, {});
  const realPut = kv.put.bind(kv);
  kv.put = async (k, v, o) => {
    if (k.startsWith('curator_') && ++puts > 1) throw new Error('KV PUT 429 rate limited');
    return realPut(k, v, o);
  };
  const env = { ...makeEnv(ENV), CLIENT_KV: kv };
  await seedClient(env, { token: 'TOK' });

  const results = await withFetch(OK_GEMINI, () => Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'm' + i }), env))));

  assert.equal(results.filter((r) => r.status >= 500).length, 0, 'no request may 500 on a mirror 429');
  const stored = rows(env, "SELECT * FROM chat_messages WHERE email='a@b.com' AND role='user'").length;
  const admitted = results.filter((r) => r.status === 200).length;
  assert.equal(stored, admitted, 'D1 must hold exactly the admitted messages');
});

// ---------------------------------------------------------------------------
// H-7: subject fuzzing. An oversized / exotic subject must not break the
// limiter open or blow up the row.
// ---------------------------------------------------------------------------
test('H-7 exotic email subjects must not bypass the per-email budget', async () => {
  const env = makeEnv(ENV);
  const IP = { 'CF-Connecting-IP': '198.51.100.7' };
  const payloads = [
    'a'.repeat(240) + '@example.com',
    'UPPER@EXAMPLE.COM',
    '  padded@example.com  ',
    'uniİcode@example.com',
    "quote'@example.com"
  ];

  await withFetch(async () => new Response(JSON.stringify({ id: 'e' }), { status: 200 }), async () => {
    for (const email of payloads) {
      for (let i = 0; i < 4; i++) {
        const r = await worker.fetch(post('/api/auth/request-link', { email }, IP), env);
        assert.equal(r.status, 202, `uniform response for ${JSON.stringify(email.slice(0, 20))}`);
      }
    }
  });

  const per = rows(env,
    "SELECT subject, COUNT(*) AS c FROM rate_events WHERE bucket='link_email' GROUP BY subject");
  for (const r of per) {
    assert.ok(r.c <= 1, `subject ${JSON.stringify(r.subject.slice(0, 30))} accumulated ${r.c} rows for a budget of 1`);
  }
});

// ---------------------------------------------------------------------------
// H-1 safety, the dangerous direction: a reservation that COMPLETED must never
// be reclaimed, however old it gets. If this fails, every paid event becomes
// re-creditable once it ages past the stale window.
// ---------------------------------------------------------------------------
test('H-5d a completed reservation is never reclaimed, at any age', async () => {
  const env = makeEnv(ENV);
  await seedClient(env, { credits: 0 });

  const evt = {
    id: 'settled', type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_1' } }
  };

  await worker.fetch(await webhookRequest(evt), env);
  assert.equal(userRow(env).credits, 20, 'precondition: the first delivery credited');

  const marker = one(env, 'SELECT * FROM processed_events WHERE event_id = ?', 'settled');
  assert.ok(marker.completed_at, 'precondition: the applied event was marked complete');

  // Age it three days — far past any stale window — and replay.
  env.DB._db.prepare('UPDATE processed_events SET processed_at = ? WHERE event_id = ?')
    .run(Date.now() - 3 * 24 * 3600 * 1000, 'settled');

  const replay = await worker.fetch(await webhookRequest(evt), env);
  assert.equal((await replay.json()).duplicate, true);
  assert.equal(userRow(env).credits, 20,
    'a settled payment was re-credited after ageing — every paid event is replayable');
});

// ---------------------------------------------------------------------------
// H-1 safety: two retries racing one stale pending reservation must reclaim it
// exactly once. The guard is in the UPDATE's WHERE, so the loser sees the
// processed_at the winner just moved forward.
// ---------------------------------------------------------------------------
test('H-5e concurrent retries reclaim a stale reservation exactly once', async () => {
  for (const interleave of [false, true]) {
    const env = makeEnv({ ...ENV, interleave });
    await seedClient(env, { credits: 0 });

    const evt = {
      id: 'raced', type: 'invoice.payment_succeeded',
      data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_1' } }
    };
    // A dead invocation's leftovers: reserved, never completed, now stale.
    env.DB._db.prepare('INSERT INTO processed_events (event_id,event_type,processed_at) VALUES (?,?,?)')
      .run('raced', 'invoice.payment_succeeded', Date.now() - 130_000);

    const reqs = await Promise.all(Array.from({ length: 8 }, () => webhookRequest(evt)));
    await Promise.all(reqs.map((r) => worker.fetch(r, env)));

    assert.equal(userRow(env).credits, 20,
      `interleave=${interleave}: the stale reservation was reclaimed more than once`);
  }
});
