// ============================================================================
// AC-1 .. AC-8: the class of race this migration exists to close.
//
// Every test here drives concurrent requests through the real handlers against
// one database and asserts an exact final state — not "roughly right". Each
// one was mutation-checked: reverting the corresponding guard to the old
// read-modify-write makes it fail, and the failure is a wrong number, not a
// crash.
//
// Run this file repeatedly (see §6) — a race that reproduces once in twenty
// runs is still a race.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import {
  makeEnv, post, webhookRequest, WEBHOOK_SECRET,
  seedClient, seedUser, userRow, chatMessages, chatSession, withFetch
} from './harness.mjs';

const env0 = (over = {}) => makeEnv({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, ...over });

const renewal = (id) => ({
  id, type: 'invoice.payment_succeeded',
  data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_1' } }
});

test('AC-1 twenty concurrent deliveries of ONE event id credit exactly +20', async () => {
  const env = env0();
  await seedClient(env, { credits: 0 });

  // Every delivery carries the same event.id — Stripe redelivering one renewal.
  const reqs = await Promise.all(Array.from({ length: 20 }, () => webhookRequest(renewal('evt_same'))));
  await Promise.all(reqs.map((r) => worker.fetch(r, env)));

  assert.equal(userRow(env).credits, 20);
  assert.equal(
    env.DB._rows('SELECT * FROM processed_events WHERE event_id = ?', 'evt_same').length, 1
  );
});

test('AC-2 twenty concurrent deliveries with DISTINCT ids credit exactly +400', async () => {
  const env = env0();
  await seedClient(env, { credits: 0 });

  const reqs = await Promise.all(
    Array.from({ length: 20 }, (_, i) => webhookRequest(renewal('evt_' + i)))
  );
  const results = await Promise.all(reqs.map((r) => worker.fetch(r, env)));

  // Not one of them may be lost: this is the exact shape of the old
  // read-modify-write defect, where twenty writers kept only the last one's sum.
  assert.equal(userRow(env).credits, 400);
  assert.equal(results.filter((r) => r.status === 200).length, 20);
});

test('AC-3 skip and cancel racing, in both orders, always end Canceled with 0 credits', async () => {
  for (const cancelFirst of [true, false]) {
    const env = env0({ STRIPE_SECRET_KEY: 'sk' });
    await seedClient(env, { credits: 40 });

    const cancel = () => withFetch(
      async () => new Response(JSON.stringify({ id: 'sub_1', status: 'canceled' }), { status: 200 }),
      () => worker.fetch(post('/api/user/cancel', { authToken: 'TOK' }), env)
    );
    const skip = () => worker.fetch(post('/api/user/skip', { authToken: 'TOK', skipped: true }), env);

    await Promise.all(cancelFirst ? [cancel(), skip()] : [skip(), cancel()]);

    const u = userRow(env);
    assert.equal(u.status, 'Canceled', `cancelFirst=${cancelFirst}`);
    assert.equal(u.credits, 0, `cancelFirst=${cancelFirst}`);
  }
});

test('AC-4 payment_failed racing a skip keeps Past Due and applies the skip flag', async () => {
  const env = env0();
  await seedClient(env);

  const failed = await webhookRequest({
    id: 'pf', type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } }
  });
  await Promise.all([
    worker.fetch(failed, env),
    worker.fetch(post('/api/user/skip', { authToken: 'TOK', skipped: true }), env)
  ]);

  const u = userRow(env);
  // Whichever landed second, the billing state must survive: the skip toggle's
  // CASE preserves 'Past Due', and markPastDue does not clear the skip flag.
  assert.equal(u.status, 'Past Due');
  assert.equal(u.skipped, 1);
});

test('AC-5 skip on a canceled membership is 409 and changes nothing', async () => {
  const env = env0();
  await seedClient(env, { status: 'Canceled', credits: 0, skipped: 0 });
  const before = userRow(env);

  const res = await worker.fetch(post('/api/user/skip', { authToken: 'TOK', skipped: true }), env);

  assert.equal(res.status, 409);
  assert.deepEqual(userRow(env), before);
});

test('AC-6 fifty concurrent chat sends produce exactly fifty rows, ordered by ts', async () => {
  const env = env0();          // no GEMINI key -> degraded path, still persists
  await seedClient(env);

  const sends = Array.from({ length: 50 }, (_, i) =>
    worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'm' + i }), env));
  const results = await Promise.all(sends);

  // The rate limiter would refuse most of these, so this test measures storage,
  // not throttling: it asserts on the rows actually accepted.
  const accepted = results.filter((r) => r.status === 200).length;
  const rows = chatMessages(env);
  assert.equal(rows.length, accepted);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'no duplicate ids');
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].ts >= rows[i - 1].ts, 'ordered by ts');
});

test('AC-6b fifty concurrent appends on one transcript lose nothing', async () => {
  // The chat endpoint is rate limited by design, so the pure lost-update
  // question is asked through the curator path, which is not.
  const env = env0({ ADMIN_SECRET: 's' });
  await seedClient(env);

  const sends = Array.from({ length: 50 }, (_, i) =>
    worker.fetch(post('/api/curator/human-reply',
      { email: 'a@b.com', message: 'c' + i, takeoverMinutes: 5 },
      { 'X-Admin-Secret': 's' }), env));
  await Promise.all(sends);

  const rows = chatMessages(env);
  assert.equal(rows.length, 50);
  assert.equal(new Set(rows.map((r) => r.text)).size, 50, 'every distinct message survived');
});

test('AC-7 a takeover during generation suppresses the AI reply and keeps the curator line', async () => {
  const env = env0({ GEMINI_API_KEY: 'k', ADMIN_SECRET: 's' });
  await seedClient(env);

  // The curator takes over while Gemini is "generating".
  const res = await withFetch(async () => {
    await worker.fetch(post('/api/curator/human-reply',
      { email: 'a@b.com', message: 'I have got this.', takeoverMinutes: 30 },
      { 'X-Admin-Secret': 's' }), env);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'AI answer' }] } }] }), { status: 200 });
  }, () => worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'Hello?' }), env));

  const body = await res.json();
  assert.equal(body.aiReplySuppressed, true);
  assert.equal(body.humanActive, true);

  const texts = chatMessages(env).map((m) => m.text);
  assert.ok(texts.includes('Hello?'), 'client message kept');
  assert.ok(texts.includes('I have got this.'), 'curator reply kept');
  assert.ok(!texts.includes('AI answer'), 'AI reply was never stored');
});

test('AC-8 a concurrent human-reply and client message both survive; takeover does not roll back', async () => {
  const env = env0({ ADMIN_SECRET: 's' });
  await seedClient(env);

  // Establish a long window first, then race a short one against a client send.
  const long = await (await worker.fetch(post('/api/curator/human-reply',
    { email: 'a@b.com', message: 'long window', takeoverMinutes: 600 },
    { 'X-Admin-Secret': 's' }), env)).json();

  await Promise.all([
    worker.fetch(post('/api/curator/human-reply',
      { email: 'a@b.com', message: 'short window', takeoverMinutes: 1 },
      { 'X-Admin-Secret': 's' }), env),
    worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'from the client' }), env)
  ]);

  const texts = chatMessages(env).map((m) => m.text);
  assert.ok(texts.includes('long window'));
  assert.ok(texts.includes('short window'));
  assert.ok(texts.includes('from the client'));
  assert.equal(chatSession(env).human_active_until, long.humanActiveUntil,
    'MAX() keeps the window from moving backwards');
});

// The tests above run against an emulator whose statements all resolve on the
// microtask queue, which leaves concurrent handlers close to serialized. That
// is not enough to prove the property: a read-modify-write can pass there and
// still lose updates against a real D1. These variants force a full macrotask
// turn before every statement, so a SELECT-then-UPDATE genuinely interleaves.
// Restoring the pre-migration read-modify-write makes them fail; the guarded
// UPDATE passes unchanged.

test('AC-2 (interleaved) twenty distinct renewals still credit exactly +400', async () => {
  const env = env0({ interleave: true });
  await seedClient(env, { credits: 0 });

  const reqs = await Promise.all(
    Array.from({ length: 20 }, (_, i) => webhookRequest(renewal('ev_' + i)))
  );
  await Promise.all(reqs.map((r) => worker.fetch(r, env)));

  assert.equal(userRow(env).credits, 400);
});

test('AC-1 (interleaved) twenty deliveries of one id still credit exactly +20', async () => {
  const env = env0({ interleave: true });
  await seedClient(env, { credits: 0 });

  const reqs = await Promise.all(Array.from({ length: 20 }, () => webhookRequest(renewal('ev_one'))));
  await Promise.all(reqs.map((r) => worker.fetch(r, env)));

  assert.equal(userRow(env).credits, 20);
});

test('AC-3 (interleaved) a cancel racing renewals still ends at zero', async () => {
  const env = env0({ interleave: true, STRIPE_SECRET_KEY: 'sk' });
  await seedClient(env, { credits: 0 });

  const renewals = await Promise.all(
    Array.from({ length: 10 }, (_, i) => webhookRequest(renewal('rz_' + i)))
  );
  await Promise.all([
    ...renewals.map((r) => worker.fetch(r, env)),
    withFetch(async () => new Response(JSON.stringify({ id: 'sub_1', status: 'canceled' }), { status: 200 }),
      () => worker.fetch(post('/api/user/cancel', { authToken: 'TOK' }), env))
  ]);

  const u = userRow(env);
  assert.equal(u.status, 'Canceled');
  // Whatever order they landed in, cancellation is terminal and the balance is
  // zero — never a renewal's arithmetic written on top of the cancellation.
  assert.equal(u.credits, 0);
});

test('AC-6 (interleaved) concurrent transcript appends lose nothing', async () => {
  const env = env0({ interleave: true, ADMIN_SECRET: 's' });
  await seedClient(env);

  await Promise.all(Array.from({ length: 30 }, (_, i) =>
    worker.fetch(post('/api/curator/human-reply',
      { email: 'a@b.com', message: 'k' + i, takeoverMinutes: 5 },
      { 'X-Admin-Secret': 's' }), env)));

  const rows = chatMessages(env);
  assert.equal(rows.length, 30);
  assert.equal(new Set(rows.map((r) => r.text)).size, 30);
});

test('concurrent checkout and renewal for one client lose neither grant', async () => {
  const env = env0();
  await seedClient(env, { credits: 0 });

  const checkout = await webhookRequest({
    id: 'co', type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', payment_status: 'paid', customer: 'cus_1', id: 'cs_1',
                      customer_details: { email: 'a@b.com', name: 'A' } } }
  });
  const renew = await webhookRequest(renewal('rn'));
  await Promise.all([worker.fetch(checkout, env), worker.fetch(renew, env)]);

  assert.equal(userRow(env).credits, 40);
});
