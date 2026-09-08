// ============================================================================
// Step 4: credits widget grant history.
//
// No new ledger table — GET /api/user/credits-history filters the same
// Stripe invoice list /api/user/invoices already fetches through
// isCreditQualifyingInvoice, the exact predicate the invoice.payment_succeeded
// webhook branch uses to decide +20. This cross-checks the two paths
// directly: the SAME fixture set is played through the real webhook to
// establish which invoices actually credited, then through the real
// credits-history endpoint, and the two outcomes are compared — not
// re-deriving the rule a second time in the test and hoping it agrees.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import {
  makeEnv, post, get, webhookRequest, WEBHOOK_SECRET, seedClient, userRow, withFetch
} from './harness.mjs';

const env0 = (over = {}) => makeEnv({
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_SECRET_KEY: 'sk', ...over
});

function stripeStub(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method });
    return handler(String(url), opts);
  };
  return { calls, fn };
}

// A realistic mix: the initial invoice (already credited via
// checkout.session.completed, never via this webhook branch), two ordinary
// renewals, one underpaid renewal, and one with a billing_reason that is
// neither subscription_create nor subscription_cycle — the current rule
// only special-cases subscription_create, so this one still qualifies as
// long as it clears the $20 floor. That's an existing nuance of the code
// this test deliberately exercises rather than papers over.
const INVOICE_FIXTURES = [
  { id: 'in_first', billing_reason: 'subscription_create', amount_paid: 2000, created: 1700000000, customer: 'cus_1' },
  { id: 'in_renew1', billing_reason: 'subscription_cycle', amount_paid: 2000, created: 1701000000, customer: 'cus_1' },
  { id: 'in_toolow', billing_reason: 'subscription_cycle', amount_paid: 500, created: 1702000000, customer: 'cus_1' },
  { id: 'in_renew2', billing_reason: 'subscription_cycle', amount_paid: 2000, created: 1703000000, customer: 'cus_1' },
  { id: 'in_update', billing_reason: 'subscription_update', amount_paid: 2500, created: 1704000000, customer: 'cus_1' }
];

test('credits-history reports exactly the invoices the webhook actually credited', async () => {
  const env = env0();
  await seedClient(env, { credits: 0 });

  // Play every fixture through the real webhook branch, recording which
  // ones actually moved the balance.
  const creditedDates = [];
  for (const fixture of INVOICE_FIXTURES) {
    const before = userRow(env).credits;
    await worker.fetch(await webhookRequest({
      id: 'evt_' + fixture.id, type: 'invoice.payment_succeeded', data: { object: fixture }
    }), env);
    const after = userRow(env).credits;
    if (after === before + 20) creditedDates.push(fixture.created);
    else assert.equal(after, before, `${fixture.id} must either credit +20 or change nothing`);
  }

  // Sanity check on the fixture set itself: this test is only meaningful if
  // it exercises a real mix of outcomes.
  assert.deepEqual(creditedDates, [1701000000, 1703000000, 1704000000]);

  // Now ask the actual endpoint about the SAME invoices.
  const stub = stripeStub(async () =>
    new Response(JSON.stringify({ data: INVOICE_FIXTURES }), { status: 200 }));
  const res = await withFetch(stub.fn,
    () => worker.fetch(get('/api/user/credits-history?auth_token=TOK'), env));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(
    body.grants.map((g) => g.date).sort((a, b) => a - b),
    creditedDates,
    "credits-history must report exactly the invoices the webhook credited — no more, no fewer"
  );
  for (const grant of body.grants) assert.equal(grant.tokens, 20);
});

test('credits-history is a whitelisted projection: no Stripe ids or PII reach the browser', async () => {
  const env = env0();
  await seedClient(env);
  const stub = stripeStub(async () =>
    new Response(JSON.stringify({ data: [INVOICE_FIXTURES[1]] }), { status: 200 }));

  const res = await withFetch(stub.fn,
    () => worker.fetch(get('/api/user/credits-history?auth_token=TOK'), env));
  const body = await res.json();

  assert.deepEqual(body.grants, [{ date: 1701000000, tokens: 20 }]);
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('cus_1'), 'the customer id must not reach the browser');
});

test('credits-history is 401 without a valid session', async () => {
  const env = env0();
  await seedClient(env);
  assert.equal((await worker.fetch(get('/api/user/credits-history?auth_token=NOPE'), env)).status, 401);
});

test('credits-history is an empty list, not an error, when there is no Stripe customer', async () => {
  const env = env0();
  await seedClient(env, { stripe_customer_id: 'cus_guest' });
  const stub = stripeStub(async () => new Response('{}', { status: 200 }));

  const res = await withFetch(stub.fn,
    () => worker.fetch(get('/api/user/credits-history?auth_token=TOK'), env));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { grants: [] });
  assert.equal(stub.calls.length, 0, 'nothing to bill against means no Stripe call');
});

test('credits-history returns 503 on a Stripe error, same as /api/user/invoices', async () => {
  const env = env0();
  await seedClient(env);
  const res = await withFetch(async () => new Response('{}', { status: 500 }),
    () => worker.fetch(get('/api/user/credits-history?auth_token=TOK'), env));
  assert.equal(res.status, 503);
});

test('a renewal webhook delivered twice (Stripe retry) is not double-counted by credits-history either', async () => {
  const env = env0();
  await seedClient(env, { credits: 0 });

  const fixture = INVOICE_FIXTURES[1]; // in_renew1, qualifying
  const deliver = async () => worker.fetch(await webhookRequest({
    id: 'evt_dup', type: 'invoice.payment_succeeded', data: { object: fixture }
  }), env);
  await deliver();
  await deliver(); // same Stripe event id: ADR-004 idempotency must refuse the second

  assert.equal(userRow(env).credits, 20, 'the duplicate delivery must not credit twice');

  // credits-history is sourced from Stripe's invoice list (one invoice
  // object, however many times its webhook fired), so it reports the
  // invoice once regardless — consistent with the balance actually being
  // credited once.
  const stub = stripeStub(async () =>
    new Response(JSON.stringify({ data: [fixture] }), { status: 200 }));
  const res = await withFetch(stub.fn,
    () => worker.fetch(get('/api/user/credits-history?auth_token=TOK'), env));
  assert.deepEqual((await res.json()).grants, [{ date: fixture.created, tokens: 20 }]);
});
