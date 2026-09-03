// ============================================================================
// Pause / resume / billing portal / invoices.
//
// Same shape as the C-3 cancellation tests in regression.test.mjs: Stripe is
// the authority, so every test asserts BOTH the response and whether D1 moved.
// "Stripe said no" and "we could not reach Stripe" must never be recorded as
// a local state change.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import {
  makeEnv, post, get, WEBHOOK_SECRET, seedClient, userRow, withFetch
} from './harness.mjs';

const env0 = (over = {}) => makeEnv({
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_SECRET_KEY: 'sk', ...over
});

// Records what was sent to Stripe so the request itself can be asserted, not
// just the outcome.
function stripeStub(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({
      url: String(url),
      method: opts.method,
      contentType: (opts.headers || {})['Content-Type'],
      body: opts.body
    });
    return handler(String(url), opts);
  };
  return { calls, fn };
}

const okSubscription = async () =>
  new Response(JSON.stringify({ id: 'sub_1', status: 'active' }), { status: 200 });

// ---- pause -----------------------------------------------------------------

test('pause suspends collection in Stripe, then moves D1 and the KV mirror', async () => {
  const env = env0();
  await seedClient(env, { credits: 40 });
  const stub = stripeStub(okSubscription);

  const res = await withFetch(stub.fn,
    () => worker.fetch(post('/api/user/pause', { authToken: 'TOK' }), env));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { paused: true });

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].method, 'POST');
  assert.equal(stub.calls[0].url, 'https://api.stripe.com/v1/subscriptions/sub_1');
  assert.equal(stub.calls[0].contentType, 'application/x-www-form-urlencoded');
  assert.equal(stub.calls[0].body, 'pause_collection[behavior]=mark_uncollectible');

  assert.equal(userRow(env).status, 'Paused');
  assert.equal(userRow(env).credits, 40, 'pausing must not touch the balance');
  assert.equal(JSON.parse(await env.CLIENT_KV.get('user_a@b.com')).status, 'Paused');
});

test('pause returns 503 and leaves D1 untouched on a Stripe 5xx', async () => {
  const env = env0();
  await seedClient(env);

  const res = await withFetch(async () => new Response('{}', { status: 500 }),
    () => worker.fetch(post('/api/user/pause', { authToken: 'TOK' }), env));

  assert.equal(res.status, 503);
  assert.equal(userRow(env).status, 'Active', 'a Stripe outage is not a pause');
  // seedClient does not write the rollback mirror, so its absence is proof
  // that nothing on this path touched KV either.
  assert.equal(await env.CLIENT_KV.get('user_a@b.com'), null);
});

test('pause returns 503 on a Stripe transport failure', async () => {
  const env = env0();
  await seedClient(env);

  const res = await withFetch(async () => { throw new TypeError('network down'); },
    () => worker.fetch(post('/api/user/pause', { authToken: 'TOK' }), env));

  assert.equal(res.status, 503);
  assert.equal(userRow(env).status, 'Active');
});

test('pause returns 503 without STRIPE_SECRET_KEY, and never calls Stripe', async () => {
  const env = makeEnv({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  await seedClient(env);
  const stub = stripeStub(okSubscription);

  const res = await withFetch(stub.fn,
    () => worker.fetch(post('/api/user/pause', { authToken: 'TOK' }), env));

  assert.equal(res.status, 503);
  assert.equal(stub.calls.length, 0);
  assert.equal(userRow(env).status, 'Active');
});

test('pause is 401 without a valid session', async () => {
  const env = env0();
  await seedClient(env);
  assert.equal((await worker.fetch(post('/api/user/pause', { authToken: 'NOPE' }), env)).status, 401);
});

// M-12: cancellation is terminal. Pausing must not resurrect it.
test('pause on a canceled membership is 409 and changes nothing', async () => {
  const env = env0();
  await seedClient(env, { status: 'Canceled', credits: 0 });
  const before = userRow(env);
  const stub = stripeStub(okSubscription);

  const res = await withFetch(stub.fn,
    () => worker.fetch(post('/api/user/pause', { authToken: 'TOK' }), env));

  assert.equal(res.status, 409);
  assert.equal(stub.calls.length, 0, 'a canceled membership never reaches Stripe');
  assert.deepEqual(userRow(env), before);
});

test('pause is 503 when no subscription is on file', async () => {
  const env = env0();
  await seedClient(env, { stripe_subscription_id: null });

  const res = await withFetch(okSubscription,
    () => worker.fetch(post('/api/user/pause', { authToken: 'TOK' }), env));

  assert.equal(res.status, 503);
  assert.equal(userRow(env).status, 'Active');
});

// ---- resume ----------------------------------------------------------------

test('resume clears pause_collection in Stripe, then moves D1 and the mirror', async () => {
  const env = env0();
  await seedClient(env, { status: 'Paused' });
  const stub = stripeStub(okSubscription);

  const res = await withFetch(stub.fn,
    () => worker.fetch(post('/api/user/resume', { authToken: 'TOK' }), env));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { resumed: true });

  assert.equal(stub.calls[0].url, 'https://api.stripe.com/v1/subscriptions/sub_1');
  assert.equal(stub.calls[0].contentType, 'application/x-www-form-urlencoded');
  assert.equal(stub.calls[0].body, 'pause_collection=',
    'Stripe clears a nested object when the key is sent empty');

  assert.equal(userRow(env).status, 'Active');
  assert.equal(JSON.parse(await env.CLIENT_KV.get('user_a@b.com')).status, 'Active');
});

test('resume returns 503 and leaves the member paused on a Stripe 5xx', async () => {
  const env = env0();
  await seedClient(env, { status: 'Paused' });

  const res = await withFetch(async () => new Response('{}', { status: 500 }),
    () => worker.fetch(post('/api/user/resume', { authToken: 'TOK' }), env));

  assert.equal(res.status, 503);
  assert.equal(userRow(env).status, 'Paused', 'a Stripe outage is not a resume');
});

test('resume returns 503 without STRIPE_SECRET_KEY', async () => {
  const env = makeEnv({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  await seedClient(env, { status: 'Paused' });

  const res = await withFetch(okSubscription,
    () => worker.fetch(post('/api/user/resume', { authToken: 'TOK' }), env));

  assert.equal(res.status, 503);
  assert.equal(userRow(env).status, 'Paused');
});

// A-3, applied to the new status: only Stripe may clear a pause.
test('the skip toggle cannot launder a paused membership back to Active', async () => {
  const env = env0();
  await seedClient(env, { status: 'Paused' });

  const off = await worker.fetch(post('/api/user/skip', { authToken: 'TOK', skipped: false }), env);
  assert.equal((await off.json()).status, 'Paused');
  assert.equal(userRow(env).status, 'Paused');

  const on = await worker.fetch(post('/api/user/skip', { authToken: 'TOK', skipped: true }), env);
  assert.equal((await on.json()).skipped, true, 'the skip flag itself still toggles');
  assert.equal(userRow(env).status, 'Paused');
});

// ---- billing portal ---------------------------------------------------------

test('billing-portal returns the session url and writes nothing', async () => {
  const env = env0();
  await seedClient(env, { credits: 40 });
  const before = userRow(env);
  const mirrorBefore = await env.CLIENT_KV.get('user_a@b.com');

  const stub = stripeStub(async () =>
    new Response(JSON.stringify({ url: 'https://billing.stripe.com/session/abc' }), { status: 200 }));

  const res = await withFetch(stub.fn,
    () => worker.fetch(post('/api/user/billing-portal', { authToken: 'TOK' }), env));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: 'https://billing.stripe.com/session/abc' });

  assert.equal(stub.calls[0].url, 'https://api.stripe.com/v1/billing_portal/sessions');
  const sent = new URLSearchParams(stub.calls[0].body);
  assert.equal(sent.get('customer'), 'cus_1');
  assert.equal(sent.get('return_url'), 'https://club.springrenaissance.store');

  assert.deepEqual(userRow(env), before, 'the portal is read-only for D1');
  assert.equal(await env.CLIENT_KV.get('user_a@b.com'), mirrorBefore, 'and for KV');
});

test('billing-portal returns 503 on a Stripe error', async () => {
  const env = env0();
  await seedClient(env);
  const res = await withFetch(async () => new Response('{}', { status: 500 }),
    () => worker.fetch(post('/api/user/billing-portal', { authToken: 'TOK' }), env));
  assert.equal(res.status, 503);
});

test('billing-portal returns 503 when Stripe answers 200 with no url', async () => {
  const env = env0();
  await seedClient(env);
  const res = await withFetch(async () => new Response(JSON.stringify({ id: 'bps_1' }), { status: 200 }),
    () => worker.fetch(post('/api/user/billing-portal', { authToken: 'TOK' }), env));
  assert.equal(res.status, 503, 'a 200 without a url is still unusable');
});

test('billing-portal is 401 without a valid session', async () => {
  const env = env0();
  await seedClient(env);
  assert.equal(
    (await worker.fetch(post('/api/user/billing-portal', { authToken: 'NOPE' }), env)).status, 401);
});

// ---- invoices ----------------------------------------------------------------

const INVOICE = {
  id: 'in_1', created: 1700000000, amount_paid: 2000, currency: 'usd',
  invoice_pdf: 'https://stripe.test/in_1.pdf',
  hosted_invoice_url: 'https://stripe.test/in_1',
  // Fields the projection must drop.
  customer_email: 'a@b.com', customer: 'cus_1', subscription: 'sub_1'
};

test('invoices returns a whitelisted projection of the last 12 paid invoices', async () => {
  const env = env0();
  await seedClient(env);
  const stub = stripeStub(async () =>
    new Response(JSON.stringify({ data: [INVOICE] }), { status: 200 }));

  const res = await withFetch(stub.fn,
    () => worker.fetch(get('/api/user/invoices?auth_token=TOK'), env));

  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.invoices.length, 1);
  assert.deepEqual(Object.keys(body.invoices[0]).sort(),
    ['amount_paid', 'currency', 'date', 'hosted_invoice_url', 'invoice_pdf']);
  assert.equal(body.invoices[0].date, 1700000000);
  assert.equal(body.invoices[0].amount_paid, 2000);

  // M-13: the browser gets what it renders, not a passed-through Stripe object.
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('cus_1'), 'the customer id must not reach the browser');
  assert.ok(!serialized.includes('sub_1'), 'nor the subscription id');

  const url = new URL(stub.calls[0].url);
  assert.equal(url.searchParams.get('customer'), 'cus_1');
  assert.equal(url.searchParams.get('limit'), '12');
  assert.equal(url.searchParams.get('status'), 'paid');
});

test('invoices returns 503 on a Stripe error', async () => {
  const env = env0();
  await seedClient(env);
  const res = await withFetch(async () => new Response('{}', { status: 500 }),
    () => worker.fetch(get('/api/user/invoices?auth_token=TOK'), env));
  assert.equal(res.status, 503);
});

test('invoices is 401 without a valid session', async () => {
  const env = env0();
  await seedClient(env);
  assert.equal((await worker.fetch(get('/api/user/invoices?auth_token=NOPE'), env)).status, 401);
});

test('invoices is an empty list, not an error, when there is no Stripe customer', async () => {
  const env = env0();
  await seedClient(env, { stripe_customer_id: 'cus_guest' });
  const stub = stripeStub(async () => new Response('{}', { status: 200 }));

  const res = await withFetch(stub.fn,
    () => worker.fetch(get('/api/user/invoices?auth_token=TOK'), env));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { invoices: [] });
  assert.equal(stub.calls.length, 0, 'nothing to bill against means no Stripe call');
});

// ---- the endpoints these sit beside are unchanged ---------------------------

test('the new routes did not disturb /api/user', async () => {
  const env = env0();
  await seedClient(env, { credits: 40 });
  const body = await (await worker.fetch(get('/api/user?auth_token=TOK'), env)).json();
  assert.deepEqual(Object.keys(body).sort(), ['email', 'skipped', 'status', 'tokens', 'updatedAt']);
});

test('a paused member is projected to the browser as Paused', async () => {
  const env = env0();
  await seedClient(env, { status: 'Paused' });
  const body = await (await worker.fetch(get('/api/user?auth_token=TOK'), env)).json();
  assert.equal(body.status, 'Paused');
});

// The handler's early status read returns 409 for an already-cancelled
// membership, so it never reaches the UPDATE. The guard in the WHERE is for
// the case the read cannot see: a cancellation committed while the Stripe call
// was in flight. Without it, pause would write 'Paused' over a terminal state.
test('a cancellation landing mid-flight beats the pause write', async () => {
  const env = env0();
  await seedClient(env, { credits: 40 });

  const res = await withFetch(async () => {
    // The client cancels in another tab while Stripe is being called.
    env.DB._db.prepare("UPDATE users SET status = 'Canceled', credits = 0 WHERE email = ?")
      .run('a@b.com');
    return new Response(JSON.stringify({ id: 'sub_1', status: 'active' }), { status: 200 });
  }, () => worker.fetch(post('/api/user/pause', { authToken: 'TOK' }), env));

  assert.equal(res.status, 409);
  assert.equal(userRow(env).status, 'Canceled', 'cancellation is terminal, whatever Stripe said');
  assert.equal(userRow(env).credits, 0);
});
