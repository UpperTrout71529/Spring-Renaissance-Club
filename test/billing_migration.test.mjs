// ============================================================================
// Step 4: Patron Membership moves off Shopify's native subscription billing
// onto a Stripe-hosted Payment Link, so this Worker's existing webhook/
// portal code handles it end to end. Three repo-side changes:
//
//   1. tier defaults from the Stripe Price ID paid at checkout
//      (resolveTierFromCheckoutSession), not just the manual admin flag.
//   2. checkout.session.completed already auto-issues a magic link via
//      issuePortalAccess/sendPortalEmail — confirmed here, not rebuilt.
//   3. A Past Due membership loses two specific privileges (consumables,
//      capsule allocation) without VIP being revoked outright — the
//      consumables half is covered in consumables.test.mjs; this file
//      covers the capsule-allocation half (/api/user/skip).
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import {
  makeEnv, post, webhookRequest, WEBHOOK_SECRET, seedClient, userRow, withFetch
} from './harness.mjs';

const env0 = (over = {}) => makeEnv({
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_SECRET_KEY: 'sk',
  PRICE_ID_REGULAR: 'price_regular',
  PRICE_ID_VIP: 'price_vip',
  ...over
});

const paid = (over = {}) => ({
  mode: 'subscription', payment_status: 'paid', customer: 'cus_1', id: 'cs_1',
  customer_details: { email: 'a@b.com', name: 'A' }, ...over
});

function lineItemsResponse(priceId) {
  return new Response(JSON.stringify({ data: [{ price: { id: priceId } }] }), { status: 200 });
}

// ---- tier-from-price-id --------------------------------------------------------

test('a checkout at PRICE_ID_VIP resolves tier to vip', async () => {
  const env = env0();
  await withFetch(async () => lineItemsResponse('price_vip'), async () => {
    const res = await worker.fetch(await webhookRequest({
      id: 'e1', type: 'checkout.session.completed', data: { object: paid() }
    }), env);
    assert.equal(res.status, 200);
  });
  assert.equal(userRow(env).tier, 'vip');
});

test('a checkout at PRICE_ID_REGULAR resolves tier to regular', async () => {
  const env = env0();
  await withFetch(async () => lineItemsResponse('price_regular'), async () => {
    await worker.fetch(await webhookRequest({
      id: 'e2', type: 'checkout.session.completed', data: { object: paid() }
    }), env);
  });
  assert.equal(userRow(env).tier, 'regular');
});

test('an unmapped price leaves a brand-new signup at the row default (regular)', async () => {
  const env = env0();
  await withFetch(async () => lineItemsResponse('price_some_other_legacy_thing'), async () => {
    await worker.fetch(await webhookRequest({
      id: 'e3', type: 'checkout.session.completed', data: { object: paid() }
    }), env);
  });
  assert.equal(userRow(env).tier, 'regular');
});

test('a re-checkout at PRICE_ID_VIP promotes an existing regular member', async () => {
  const env = env0();
  await seedClient(env, { tier: 'regular', status: 'Canceled', credits: 0 });
  await withFetch(async () => lineItemsResponse('price_vip'), async () => {
    await worker.fetch(await webhookRequest({
      id: 'e4', type: 'checkout.session.completed', data: { object: paid() }
    }), env);
  });
  assert.equal(userRow(env).tier, 'vip');
});

test('a re-checkout at PRICE_ID_REGULAR is a live signal too: it downgrades a previously-VIP member', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip', status: 'Canceled', credits: 0 });
  await withFetch(async () => lineItemsResponse('price_regular'), async () => {
    await worker.fetch(await webhookRequest({
      id: 'e5', type: 'checkout.session.completed', data: { object: paid() }
    }), env);
  });
  assert.equal(userRow(env).tier, 'regular');
});

test('a manually-set VIP tier survives a re-checkout whose price cannot be resolved (price ids unconfigured)', async () => {
  const env = env0({ PRICE_ID_REGULAR: undefined, PRICE_ID_VIP: undefined });
  await seedClient(env, { tier: 'vip', status: 'Canceled', credits: 0 });
  const res = await worker.fetch(await webhookRequest({
    id: 'e6', type: 'checkout.session.completed', data: { object: paid() }
  }), env);
  assert.equal(res.status, 200);
  assert.equal(userRow(env).tier, 'vip', 'set-tier is still the manual override — an unresolved price must not touch it');
});

test('a failed Stripe line-items lookup does not fail the whole checkout — tier just stays untouched', async () => {
  const env = env0();
  let status;
  await withFetch(async () => new Response('{}', { status: 500 }), async () => {
    const res = await worker.fetch(await webhookRequest({
      id: 'e7', type: 'checkout.session.completed', data: { object: paid() }
    }), env);
    status = res.status;
  });
  assert.equal(status, 200);
  assert.equal(userRow(env).tier, 'regular');
});

test('the existing set-tier admin override still works exactly as before this change', async () => {
  const env = env0({ ADMIN_SECRET: 's' });
  await seedClient(env);
  const res = await worker.fetch(
    post('/api/admin/set-tier', { email: 'a@b.com', tier: 'vip' }, { 'X-Admin-Secret': 's' }), env);
  assert.equal(res.status, 200);
  assert.equal(userRow(env).tier, 'vip');
});

// ---- auto-issued magic link on checkout (already-existing behaviour) ---------

test('checkout.session.completed already auto-issues exactly one magic link — no separate request-link call needed', async () => {
  const sent = [];
  const env = env0({ RESEND_API_KEY: 'rk' });
  let status;

  await withFetch(async (url, opts) => {
    const u = String(url);
    if (u.includes('/line_items')) return lineItemsResponse('price_regular');
    if (u.includes('api.resend.com')) {
      sent.push(JSON.parse(opts.body).to[0]);
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }, async () => {
    const res = await worker.fetch(await webhookRequest({
      id: 'e8', type: 'checkout.session.completed', data: { object: paid() }
    }), env);
    status = res.status;
  });

  assert.equal(status, 200);
  assert.equal(sent.length, 1, 'exactly one portal-access email on checkout completion');
  assert.equal(sent[0], 'a@b.com');

  const magicKey = [...env.CLIENT_KV._m.keys()].find((k) => k.startsWith('magic_'));
  assert.ok(magicKey, 'a working magic token must already exist — no /api/auth/request-link call needed');
});

// ---- Step 4: Past Due grace period — capsule allocation (/api/user/skip) -----

test('a Past Due member cannot toggle skip at all, 409, nothing changes', async () => {
  const env = env0();
  await seedClient(env, { status: 'Past Due', credits: 20, skipped: 0 });

  const res = await worker.fetch(post('/api/user/skip', { authToken: 'TOK', skipped: true }), env);
  const body = await res.json();

  assert.equal(res.status, 409);
  assert.equal(body.error, 'Payment is past due — please update your card to continue');
  const row = userRow(env);
  assert.equal(row.status, 'Past Due');
  assert.equal(row.skipped, 0);
});

test('a Past Due member who was already skipped stays skipped — the toggle is frozen, not forced', async () => {
  const env = env0();
  await seedClient(env, { status: 'Past Due', credits: 20, skipped: 1 });

  const res = await worker.fetch(post('/api/user/skip', { authToken: 'TOK', skipped: false }), env);
  assert.equal(res.status, 409);
  assert.equal(userRow(env).skipped, 1);
});

test('an Active member can still toggle skip normally — the Past Due guard is not a blanket freeze', async () => {
  const env = env0();
  await seedClient(env, { status: 'Active', credits: 20, skipped: 0 });
  const res = await worker.fetch(post('/api/user/skip', { authToken: 'TOK', skipped: true }), env);
  assert.equal(res.status, 200);
  assert.equal(userRow(env).skipped, 1);
});

test('a cleared Past Due (renewal succeeds) can toggle skip again', async () => {
  const env = env0();
  await seedClient(env, { status: 'Past Due', credits: 20, skipped: 0, past_due_at: 111 });
  await worker.fetch(await webhookRequest({
    id: 'renewal_clears', type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_1' } }
  }), env);
  assert.equal(userRow(env).status, 'Active');

  const res = await worker.fetch(post('/api/user/skip', { authToken: 'TOK', skipped: true }), env);
  assert.equal(res.status, 200);
});
