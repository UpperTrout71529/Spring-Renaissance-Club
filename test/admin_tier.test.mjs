// ============================================================================
// Step 0: manual tier flag + POST /api/admin/set-tier.
//
// Tier is a membership class, not a Stripe-derived fact — the club sells one
// price today, so there is no billing signal to compute it from. This is a
// hand-operated switch, gated by the same authorizeAdmin seam as
// /api/curator/human-reply, with the same posture: never called from a page
// shipped to a browser.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { makeEnv, post, get, WEBHOOK_SECRET, seedClient, userRow } from './harness.mjs';

const env0 = (over = {}) => makeEnv({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, ADMIN_SECRET: 's', ...over });

test('new members default to the regular tier', async () => {
  const env = env0();
  await seedClient(env);
  assert.equal(userRow(env).tier, 'regular');
});

test('set-tier promotes a member to vip and mirrors to KV', async () => {
  const env = env0();
  await seedClient(env);

  const res = await worker.fetch(
    post('/api/admin/set-tier', { email: 'a@b.com', tier: 'vip' }, { 'X-Admin-Secret': 's' }), env);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, { success: true, email: 'a@b.com', tier: 'vip' });
  assert.equal(userRow(env).tier, 'vip');
  assert.equal(JSON.parse(await env.CLIENT_KV.get('user_a@b.com')).status, 'Active');
});

test('set-tier can demote vip back to regular', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });

  await worker.fetch(post('/api/admin/set-tier', { email: 'a@b.com', tier: 'regular' }, { 'X-Admin-Secret': 's' }), env);
  assert.equal(userRow(env).tier, 'regular');
});

test('set-tier requires the admin secret', async () => {
  const env = env0();
  await seedClient(env);

  const noHeader = await worker.fetch(post('/api/admin/set-tier', { email: 'a@b.com', tier: 'vip' }), env);
  assert.equal(noHeader.status, 401);

  const wrong = await worker.fetch(
    post('/api/admin/set-tier', { email: 'a@b.com', tier: 'vip' }, { 'X-Admin-Secret': 'wrong' }), env);
  assert.equal(wrong.status, 401);

  assert.equal(userRow(env).tier, 'regular', 'an unauthorized call must not move the tier');
});

test('set-tier rejects a tier value outside regular/vip', async () => {
  const env = env0();
  await seedClient(env);

  const res = await worker.fetch(
    post('/api/admin/set-tier', { email: 'a@b.com', tier: 'super-vip' }, { 'X-Admin-Secret': 's' }), env);
  assert.equal(res.status, 400);
  assert.equal(userRow(env).tier, 'regular');
});

test('set-tier on an unknown member is 404 and creates no row', async () => {
  const env = env0();
  const res = await worker.fetch(
    post('/api/admin/set-tier', { email: 'ghost@example.com', tier: 'vip' }, { 'X-Admin-Secret': 's' }), env);
  assert.equal(res.status, 404);
  assert.equal(env.DB._rows('SELECT * FROM users').length, 0);
});

test('set-tier migrates a legacy KV-only client before promoting them', async () => {
  const env = env0();
  await env.CLIENT_KV.put('user_legacy@b.com', JSON.stringify({
    email: 'legacy@b.com', status: 'Active', tokens: 40, skipped: false
  }));

  const res = await worker.fetch(
    post('/api/admin/set-tier', { email: 'legacy@b.com', tier: 'vip' }, { 'X-Admin-Secret': 's' }), env);
  assert.equal(res.status, 200);
  assert.equal(userRow(env, 'legacy@b.com').tier, 'vip');
});

test('a cancelled membership can still be flagged vip ahead of resubscribing', async () => {
  const env = env0();
  await seedClient(env, { status: 'Canceled', credits: 0 });

  const res = await worker.fetch(
    post('/api/admin/set-tier', { email: 'a@b.com', tier: 'vip' }, { 'X-Admin-Secret': 's' }), env);
  assert.equal(res.status, 200);
  const row = userRow(env);
  assert.equal(row.tier, 'vip');
  assert.equal(row.status, 'Canceled', 'tier is orthogonal to billing status');
});

test('/api/user response shape is unchanged: no tier field leaks', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const body = await (await worker.fetch(get('/api/user?auth_token=TOK'), env)).json();
  assert.deepEqual(Object.keys(body).sort(), ['email', 'skipped', 'status', 'tokens', 'updatedAt']);
});

test('a VIP re-checking out through Stripe keeps their tier', async () => {
  const { webhookRequest } = await import('./harness.mjs');
  const env = env0();
  await seedClient(env, { tier: 'vip', status: 'Canceled', credits: 0 });

  await worker.fetch(await webhookRequest({
    id: 'resub_vip', type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', payment_status: 'paid', customer: 'cus_1', id: 'cs',
                      customer_details: { email: 'a@b.com', name: 'A' } } }
  }), env);

  const row = userRow(env);
  assert.equal(row.status, 'Active');
  assert.equal(row.tier, 'vip', 'checkout must not reset tier to the row default');
});
