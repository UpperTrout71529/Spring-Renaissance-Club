// ============================================================================
// Regression suite: every behaviour fixed by audits C-1..C-3, M-4..M-14,
// A-1..A-11 and B-1..B-4, carried across the D1 migration unchanged.
//
// AC-21: these assertions are the pre-migration suite, statement for
// statement. The only thing that changed is how the env is built — the
// migration changes the env contract by design (a DB binding is now required),
// so every test goes through makeEnv(). No assertion was weakened to fit.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import {
  makeEnv, makeKV, makeDB, post, postNoContentLength, get, webhookRequest,
  WEBHOOK_SECRET, seedUser, seedToken, seedClient, userRow, chatMessages,
  withFetch
} from './harness.mjs';

const paid = (over = {}) => ({
  mode: 'subscription', payment_status: 'paid', customer: 'cus_1', id: 'cs_1',
  customer_details: { email: 'a@b.com', name: 'A' }, ...over
});
const env0 = (over = {}) => makeEnv({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, ...over });

// ---- C-1: webhook signature ------------------------------------------------

test('C-1 missing STRIPE_WEBHOOK_SECRET -> 503', async () => {
  const env = makeEnv();
  const res = await worker.fetch(await webhookRequest({ id: 'e', type: 'ping', data: { object: {} } }), env);
  assert.equal(res.status, 503);
});

test('C-1 forged signature -> 400', async () => {
  const env = env0();
  const raw = JSON.stringify({ id: 'e', type: 'ping', data: { object: {} } });
  const ts = Math.floor(Date.now() / 1000);
  const res = await worker.fetch(post('/hook', raw, { 'Stripe-Signature': `t=${ts},v1=deadbeef` }), env);
  assert.equal(res.status, 400);
});

test('C-1 replay outside the +-300s window -> 400', async () => {
  const env = env0();
  const ts = Math.floor(Date.now() / 1000) - 900;
  const res = await worker.fetch(await webhookRequest({ id: 'e', type: 'ping', data: { object: {} } }, { ts }), env);
  assert.equal(res.status, 400);
});

test('C-1 a valid signature is processed', async () => {
  const env = env0();
  const res = await worker.fetch(
    await webhookRequest({ id: 'e1', type: 'checkout.session.completed', data: { object: paid() } }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).success, true);
  assert.ok(userRow(env));
});

// ---- C-2: customer -> email resolution --------------------------------------

test('C-2 subscription.deleted resolves email via the cust_ index', async () => {
  const env = env0();
  await seedClient(env);
  const res = await worker.fetch(await webhookRequest({
    id: 'd1', type: 'customer.subscription.deleted',
    data: { object: { object: 'subscription', id: 'sub_1', customer: 'cus_1', status: 'canceled' } }
  }), env);
  assert.equal((await res.json()).applied, true);
  const u = userRow(env);
  assert.equal(u.status, 'Canceled');
  assert.equal(u.credits, 0);
});

test('C-2 falls back to the Stripe customers API and back-fills the index', async () => {
  const env = env0({ STRIPE_SECRET_KEY: 'sk' });
  seedUser(env, { email: 'z@b.com', stripe_customer_id: null });
  const req = await webhookRequest({
    id: 'd2', type: 'customer.subscription.updated',
    data: { object: { object: 'subscription', id: 'sub_9', customer: 'cus_9', status: 'canceled' } }
  });
  const res = await withFetch(
    async (url) => String(url).includes('/v1/customers/cus_9')
      ? new Response(JSON.stringify({ id: 'cus_9', email: 'z@b.com' }), { status: 200 })
      : new Response('{}', { status: 404 }),
    () => worker.fetch(req, env)
  );
  assert.equal((await res.json()).applied, true);
  assert.equal(await env.CLIENT_KV.get('cust_cus_9'), 'z@b.com');
  assert.equal(userRow(env, 'z@b.com').status, 'Canceled');
});

// ---- C-3: cancellation ------------------------------------------------------

test('C-3 Stripe transport error -> 503 and the account stays Active', async () => {
  const env = env0({ STRIPE_SECRET_KEY: 'sk' });
  await seedClient(env);
  const res = await withFetch(async () => { throw new TypeError('network down'); },
    () => worker.fetch(post('/api/user/cancel', { authToken: 'TOK' }), env));
  assert.equal(res.status, 503);
  assert.equal(userRow(env).status, 'Active');
});

test('C-3 Stripe 5xx -> 503 and the account stays Active', async () => {
  const env = env0({ STRIPE_SECRET_KEY: 'sk' });
  await seedClient(env);
  const res = await withFetch(async () => new Response('{}', { status: 500 }),
    () => worker.fetch(post('/api/user/cancel', { authToken: 'TOK' }), env));
  assert.equal(res.status, 503);
  assert.equal(userRow(env).status, 'Active');
});

test('C-3 happy path issues a real DELETE before touching local state', async () => {
  const env = env0({ STRIPE_SECRET_KEY: 'sk' });
  await seedClient(env);
  const calls = [];
  const res = await withFetch(async (url, opts) => {
    calls.push(`${opts.method} ${String(url).replace('https://api.stripe.com', '')}`);
    return new Response(JSON.stringify({ id: 'sub_1', status: 'canceled' }), { status: 200 });
  }, () => worker.fetch(post('/api/user/cancel', { authToken: 'TOK' }), env));
  const body = await res.json();
  assert.ok(calls.includes('DELETE /v1/subscriptions/sub_1'));
  assert.equal(body.stripeSubscriptionCanceled, true);
  const u = userRow(env);
  assert.equal(u.status, 'Canceled');
  assert.equal(u.credits, 0);
});

test('C-3 no subscription found -> stripeSubscriptionCanceled false', async () => {
  const env = env0({ STRIPE_SECRET_KEY: 'sk' });
  await seedClient(env, { stripe_subscription_id: null });
  const res = await withFetch(
    async (url) => String(url).includes('/v1/subscriptions?')
      ? new Response(JSON.stringify({ data: [] }), { status: 200 })
      : new Response('{}', { status: 404 }),
    () => worker.fetch(post('/api/user/cancel', { authToken: 'TOK' }), env));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).stripeSubscriptionCanceled, false);
});

test('C-3 a past_due subscription is discovered and cancelled', async () => {
  const env = env0({ STRIPE_SECRET_KEY: 'sk' });
  await seedClient(env, { stripe_subscription_id: null });
  const calls = [];
  const res = await withFetch(async (url, opts) => {
    calls.push(`${opts.method} ${String(url).replace('https://api.stripe.com', '')}`);
    return String(url).includes('/v1/subscriptions?')
      ? new Response(JSON.stringify({ data: [{ id: 'sub_found', status: 'past_due' }] }), { status: 200 })
      : new Response(JSON.stringify({ id: 'sub_found', status: 'canceled' }), { status: 200 });
  }, () => worker.fetch(post('/api/user/cancel', { authToken: 'TOK' }), env));
  assert.equal((await res.json()).stripeSubscriptionCanceled, true);
  assert.ok(calls.includes('DELETE /v1/subscriptions/sub_found'));
});

test('C-3 missing STRIPE_SECRET_KEY -> 503, account untouched', async () => {
  const env = env0();
  await seedClient(env);
  const res = await worker.fetch(post('/api/user/cancel', { authToken: 'TOK' }), env);
  assert.equal(res.status, 503);
  assert.equal(userRow(env).status, 'Active');
});

// ---- M-4 / M-5 / M-6: webhook accounting ------------------------------------

test('M-4 the subscription_create invoice is ignored (no double +20)', async () => {
  const env = env0();
  await seedClient(env, { credits: 20 });
  const res = await worker.fetch(await webhookRequest({
    id: 'i0', type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_create', amount_paid: 2000, customer: 'cus_1' } }
  }), env);
  assert.equal((await res.json()).ignored, true);
  assert.equal(userRow(env).credits, 20);
});

test('M-4 a renewal credits +20', async () => {
  const env = env0();
  await seedClient(env, { credits: 20 });
  await worker.fetch(await webhookRequest({
    id: 'i1', type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_1' } }
  }), env);
  assert.equal(userRow(env).credits, 40);
});

test('M-5 a replayed event is a duplicate and does not double-credit', async () => {
  const env = env0();
  await seedClient(env, { credits: 20 });
  const evt = {
    id: 'i2', type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_1' } }
  };
  await worker.fetch(await webhookRequest(evt), env);
  const again = await worker.fetch(await webhookRequest(evt), env);
  assert.equal((await again.json()).duplicate, true);
  assert.equal(userRow(env).credits, 40);
});

test('M-6 a canceled account gets no renewal tokens', async () => {
  const env = env0();
  await seedClient(env, { status: 'Canceled', credits: 0 });
  const res = await worker.fetch(await webhookRequest({
    id: 'i3', type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_1' } }
  }), env);
  assert.equal((await res.json()).ignored, true);
  assert.equal(userRow(env).credits, 0);
});

test('M-4 a renewal under $20 is ignored', async () => {
  const env = env0();
  await seedClient(env, { credits: 20 });
  const res = await worker.fetch(await webhookRequest({
    id: 'i4', type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_cycle', amount_paid: 500, customer: 'cus_1' } }
  }), env);
  assert.equal((await res.json()).ignored, true);
  assert.equal(userRow(env).credits, 20);
});

// ---- M-10: attachment validation --------------------------------------------

test('M-10 rejects a bad MIME, an oversized image, a long message and bad base64', async () => {
  const env = env0();
  await seedClient(env);
  const cases = [
    [{ authToken: 'TOK', message: 'hi', imageBase64: 'AAAA', imageMime: 'application/pdf' }, 415],
    [{ authToken: 'TOK', message: 'hi', imageBase64: 'A'.repeat(6 * 1024 * 1024), imageMime: 'image/png' }, 413],
    [{ authToken: 'TOK', message: 'x'.repeat(5000) }, 413],
    [{ authToken: 'TOK', message: 'hi', imageBase64: 'not base64!!', imageMime: 'image/png' }, 400],
    [{ authToken: 'TOK', message: '' }, 400]
  ];
  for (const [body, expected] of cases) {
    const res = await worker.fetch(post('/api/curator/chat', body), env);
    assert.equal(res.status, expected, JSON.stringify(body).slice(0, 60));
  }
});

// ---- M-12: skip guards -------------------------------------------------------

test('M-12 skip on a canceled membership -> 409, state untouched', async () => {
  const env = env0();
  await seedClient(env, { status: 'Canceled', credits: 0 });
  const res = await worker.fetch(post('/api/user/skip', { authToken: 'TOK', skipped: false }), env);
  assert.equal(res.status, 409);
  assert.equal(userRow(env).status, 'Canceled');
});

test('M-12 skip on an active membership works', async () => {
  const env = env0();
  await seedClient(env);
  const res = await worker.fetch(post('/api/user/skip', { authToken: 'TOK', skipped: true }), env);
  const body = await res.json();
  assert.equal(body.skipped, true);
  assert.equal(body.status, 'Paused (Offline)');
});

// ---- M-13: projection and error hygiene --------------------------------------

test('M-13 /api/user never leaks Stripe identifiers', async () => {
  const env = env0();
  await seedClient(env);
  const res = await worker.fetch(get('/api/user?auth_token=TOK'), env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(!('stripeCustomerId' in body));
  assert.ok(!('stripeSubscriptionId' in body));
  assert.ok(!('stripe_customer_id' in body));
  assert.match(res.headers.get('Cache-Control'), /no-store/);
});

test('M-13 a bad token is 401', async () => {
  const env = env0();
  await seedClient(env);
  const res = await worker.fetch(get('/api/user?auth_token=NOPE'), env);
  assert.equal(res.status, 401);
});

test('M-13 a 500 body carries no internal detail', async () => {
  const env = env0();
  await seedClient(env);
  // Break the database only after the session lookup can succeed, so the
  // request actually reaches the failing layer instead of short-circuiting 401.
  env.DB = { prepare() { throw new Error('CLIENT_KV binding secret detail'); } };
  const res = await worker.fetch(get('/api/user?auth_token=TOK'), env);
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.error, 'Internal error');
  assert.ok(!JSON.stringify(body).includes('CLIENT_KV'));
});

// ---- M-14: transcript cap ----------------------------------------------------

test('M-14 the transcript is capped at 80 messages, newest kept', async () => {
  const env = env0();
  await seedClient(env);
  for (let i = 0; i < 120; i++) {
    env.DB._db.prepare('INSERT INTO chat_messages (id,email,author,role,text,ts) VALUES (?,?,?,?,?,?)')
      .run(`m${i}`, 'a@b.com', 'You', 'user', `m${i}`, i);
  }
  await worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'newest' }), env);
  const rows = chatMessages(env);
  assert.equal(rows.length, 80);
  assert.equal(rows[rows.length - 1].text, 'newest');
});

// ---- MINOR / security --------------------------------------------------------

test('admin secret is required and compared for the takeover endpoint', async () => {
  const env = env0({ ADMIN_SECRET: 'topsecret' });
  await seedClient(env);
  assert.equal((await worker.fetch(post('/api/curator/human-reply', { email: 'a@b.com', message: 'hi' }), env)).status, 401);
  assert.equal((await worker.fetch(post('/api/curator/human-reply', { email: 'a@b.com', message: 'hi' },
    { 'X-Admin-Secret': 'wrong' }), env)).status, 401);
});

test('takeoverMinutes is clamped to 1..1440 with a 30 default', async () => {
  const env = env0({ ADMIN_SECRET: 's' });
  await seedClient(env);
  const call = async (v) => (await (await worker.fetch(
    post('/api/curator/human-reply', { email: 'a@b.com', message: 'hi', takeoverMinutes: v },
      { 'X-Admin-Secret': 's' }), env)).json()).takeoverMinutes;
  assert.equal(await call(99999), 1440);
  assert.equal(await call(-5), 30);
  assert.equal(await call('abc'), 30);
});

test('A-2 a one-off purchase grants nothing; a subscription does', async () => {
  const env = env0();
  const res = await worker.fetch(await webhookRequest({
    id: 'm1', type: 'checkout.session.completed',
    data: { object: paid({ mode: 'payment', customer_details: { email: 'buyer@b.com' } }) }
  }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ignored, true);
  assert.equal(userRow(env, 'buyer@b.com'), null);

  const ok = await worker.fetch(await webhookRequest({
    id: 'm2', type: 'checkout.session.completed', data: { object: paid() }
  }), env);
  assert.equal((await ok.json()).success, true);
  assert.ok(userRow(env));
});

test('checkout requires payment_status paid', async () => {
  const env = env0();
  const res = await worker.fetch(await webhookRequest({
    id: 'm3', type: 'checkout.session.completed', data: { object: paid({ payment_status: 'unpaid' }) }
  }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ignored, true);
  assert.equal(userRow(env), null);
});

// ---- A-3: dunning ------------------------------------------------------------

test('A-3 payment_failed and past_due/unpaid move the client to Past Due', async () => {
  for (const evt of [
    { id: 'p1', type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } } },
    { id: 'p2', type: 'customer.subscription.updated', data: { object: { object: 'subscription', customer: 'cus_1', status: 'past_due' } } },
    { id: 'p3', type: 'customer.subscription.updated', data: { object: { object: 'subscription', customer: 'cus_1', status: 'unpaid' } } }
  ]) {
    const env = env0();
    await seedClient(env);
    const res = await worker.fetch(await webhookRequest(evt), env);
    assert.equal((await res.json()).applied, true, evt.type);
    assert.equal(userRow(env).status, 'Past Due', evt.type);
  }
});

test('A-3 a canceled account is not moved to Past Due', async () => {
  const env = env0();
  await seedClient(env, { status: 'Canceled', credits: 0 });
  await worker.fetch(await webhookRequest({
    id: 'p4', type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } }
  }), env);
  assert.equal(userRow(env).status, 'Canceled');
});

test('A-3 skip cannot launder Past Due back to Active', async () => {
  const env = env0();
  await seedClient(env, { status: 'Past Due', credits: 20 });
  const res = await worker.fetch(post('/api/user/skip', { authToken: 'TOK', skipped: false }), env);
  assert.equal((await res.json()).status, 'Past Due');
  assert.equal(userRow(env).status, 'Past Due');
});

test('A-3 a successful renewal clears Past Due; a skipped member stays paused', async () => {
  const env = env0();
  await seedClient(env, { status: 'Past Due', credits: 20, past_due_at: 111 });
  await worker.fetch(await webhookRequest({
    id: 'p5', type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_1' } }
  }), env);
  const u = userRow(env);
  assert.equal(u.status, 'Active');
  assert.equal(u.credits, 40);
  assert.equal(u.past_due_at, null);

  const env2 = env0();
  await seedClient(env2, { status: 'Past Due', credits: 0, skipped: 1 });
  await worker.fetch(await webhookRequest({
    id: 'p6', type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_1' } }
  }), env2);
  assert.equal(userRow(env2).status, 'Paused (Offline)');
});

// ---- A-4: Content-Length ------------------------------------------------------

test('A-4 a webhook with no or malformed Content-Length is rejected', async () => {
  const env = env0();
  const raw = JSON.stringify({ id: 'cl', type: 'ping', data: { object: {} } });
  const ts = Math.floor(Date.now() / 1000);
  const { signBody } = await import('./harness.mjs');
  const sig = await signBody(raw, ts);

  const none = new Request('https://w.dev/hook', {
    method: 'POST', headers: { 'Stripe-Signature': `t=${ts},v1=${sig}` }, body: raw
  });
  assert.equal((await worker.fetch(none, env)).status, 413);

  for (const bad of ['1e9', '0x10', ' ', 'abc', '-5', '12.5']) {
    const req = new Request('https://w.dev/hook', {
      method: 'POST', headers: { 'Stripe-Signature': `t=${ts},v1=${sig}`, 'Content-Length': bad }, body: raw
    });
    assert.equal((await worker.fetch(req, env)).status, 413, bad);
  }

  const big = new Request('https://w.dev/hook', {
    method: 'POST',
    headers: { 'Stripe-Signature': `t=${ts},v1=${sig}`, 'Content-Length': String(300 * 1024) }, body: raw
  });
  assert.equal((await worker.fetch(big, env)).status, 413);
});

test('A-4 an API POST with no Content-Length -> 400', async () => {
  const env = env0();
  await seedClient(env);
  const res = await worker.fetch(postNoContentLength('/api/user/skip', { authToken: 'TOK', skipped: true }), env);
  assert.equal(res.status, 400);
});

// ---- A-6 / A-11: token revocation ---------------------------------------------

test('A-6 cancelling revokes the presented token and every older link', async () => {
  const env = env0({ STRIPE_SECRET_KEY: 'sk' });
  await seedClient(env);
  await seedToken(env, 'OLDLINK', 'a@b.com', Date.now() - 5000000);

  await withFetch(async () => new Response(JSON.stringify({ id: 'sub_1', status: 'canceled' }), { status: 200 }),
    () => worker.fetch(post('/api/user/cancel', { authToken: 'TOK' }), env));

  assert.equal(await env.CLIENT_KV.get('magic_TOK'), null);
  assert.ok(userRow(env).magic_revoked_before > 0);
  assert.equal((await worker.fetch(get('/api/user?auth_token=OLDLINK'), env)).status, 401);
  assert.equal((await worker.fetch(post('/api/user/skip', { authToken: 'OLDLINK', skipped: true }), env)).status, 401);
  assert.equal((await worker.fetch(post('/api/curator/chat', { authToken: 'OLDLINK', message: 'hi' }), env)).status, 401);
});

test('A-6 re-subscribing issues a working link again', async () => {
  const env = env0();
  seedUser(env, { status: 'Canceled', credits: 0, magic_revoked_before: Date.now() });
  await worker.fetch(await webhookRequest({
    id: 're', type: 'checkout.session.completed', data: { object: paid() }
  }), env);
  const token = [...env.CLIENT_KV._m.keys()].find((k) => k.startsWith('magic_')).slice('magic_'.length);
  assert.equal((await worker.fetch(get('/api/user?auth_token=' + token), env)).status, 200);
});

// ---- B-1: retry semantics -----------------------------------------------------

test('B-1 the four unresolvable-email branches answer 500 and release the event', async () => {
  const cases = [
    ['customer.subscription.deleted', { object: 'subscription', id: 's', customer: 'cus_ghost', status: 'canceled' }],
    ['invoice.payment_failed', { customer: 'cus_ghost' }],
    ['invoice.payment_succeeded', { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_ghost' }],
    ['checkout.session.completed', { mode: 'subscription', payment_status: 'paid', customer: 'cus_ghost', id: 'cs' }]
  ];
  let n = 0;
  for (const [type, object] of cases) {
    const env = env0();
    const id = 'b1_' + (n++);
    const res = await worker.fetch(await webhookRequest({ id, type, data: { object } }), env);
    const body = await res.json();
    assert.equal(res.status, 500, type);
    assert.equal(body.received, false, type);
    assert.equal(env.DB._row('SELECT * FROM processed_events WHERE event_id = ?', id), null, type);
  }
});

test('B-1 the two deliberate ignores stay 200', async () => {
  const env = env0();
  const a = await worker.fetch(await webhookRequest({
    id: 'ig1', type: 'checkout.session.completed', data: { object: paid({ mode: 'payment' }) }
  }), env);
  assert.equal(a.status, 200);
  const b = await worker.fetch(await webhookRequest({
    id: 'ig2', type: 'checkout.session.completed', data: { object: paid({ payment_status: 'unpaid' }) }
  }), env);
  assert.equal(b.status, 200);
});

test('B-1 a retry that can resolve the email is processed, not swallowed', async () => {
  const env = env0();
  seedUser(env, { credits: 20, stripe_customer_id: null });
  const evt = {
    id: 'late', type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_late' } }
  };
  assert.equal((await worker.fetch(await webhookRequest(evt), env)).status, 500);
  await env.CLIENT_KV.put('cust_cus_late', 'a@b.com');
  const second = await worker.fetch(await webhookRequest(evt), env);
  assert.equal((await second.json()).success, true);
  assert.equal(userRow(env).credits, 40);
});

// ---- B-2 / B-3: chat correctness ----------------------------------------------

test('B-2 a takeover present at append time suppresses the AI entirely', async () => {
  const env = env0({ GEMINI_API_KEY: 'k' });
  await seedClient(env);
  env.DB._db.prepare('INSERT INTO chat_sessions (email, human_active_until, updated_at) VALUES (?,?,?)')
    .run('a@b.com', Date.now() + 600000, Date.now());

  let geminiCalls = 0;
  const res = await withFetch(async () => {
    geminiCalls++;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'AI' }] } }] }), { status: 200 });
  }, () => worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'hello' }), env));

  const body = await res.json();
  assert.equal(body.queued, true);
  assert.equal(body.humanActive, true);
  assert.equal(geminiCalls, 0);
  assert.ok(chatMessages(env).some((m) => m.text === 'hello'));
});

test('B-3 two identical messages in the same millisecond both survive', async () => {
  const env = env0({ ADMIN_SECRET: 's' });
  await seedClient(env);
  const body = { email: 'a@b.com', message: 'Are you there?', takeoverMinutes: 30 };
  await worker.fetch(post('/api/curator/human-reply', body, { 'X-Admin-Secret': 's' }), env);
  await worker.fetch(post('/api/curator/human-reply', body, { 'X-Admin-Secret': 's' }), env);
  const same = chatMessages(env).filter((m) => m.text === 'Are you there?');
  assert.equal(same.length, 2);
  assert.notEqual(same[0].id, same[1].id);
});

test('humanActiveUntil never moves backwards', async () => {
  const env = env0({ ADMIN_SECRET: 's' });
  await seedClient(env);
  const long = await (await worker.fetch(post('/api/curator/human-reply',
    { email: 'a@b.com', message: 'long', takeoverMinutes: 600 }, { 'X-Admin-Secret': 's' }), env)).json();
  const short = await (await worker.fetch(post('/api/curator/human-reply',
    { email: 'a@b.com', message: 'short', takeoverMinutes: 1 }, { 'X-Admin-Secret': 's' }), env)).json();
  assert.equal(short.humanActiveUntil, long.humanActiveUntil);
});

// ---- CORS --------------------------------------------------------------------

test('CORS names the portal origin, not *, and honours PORTAL_ORIGIN', async () => {
  const env = env0();
  const pre = await worker.fetch(new Request('https://w.dev/api/user', { method: 'OPTIONS' }), env);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), 'https://springrenaissance.store');
  assert.match(pre.headers.get('Vary'), /Origin/);

  const env2 = env0({ PORTAL_ORIGIN: 'https://staging.example.com' });
  const res = await worker.fetch(get('/api/user?auth_token=nope'), env2);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://staging.example.com');
});
