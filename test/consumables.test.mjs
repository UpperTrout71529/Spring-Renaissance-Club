// ============================================================================
// Consumables replenishment (beta, VIP tier only).
//
// Config-driven: an admin adds/updates/deactivates one via
// POST /api/admin/consumables, and the client renders whatever
// GET /api/consumables returns — no deploy needed to add a third item.
// One row per member per consumable in consumable_interest; re-registering
// changes `frequency` in the same guarded upsert instead of adding a row —
// exactly the class of bug this project's guarded-UPDATE discipline exists
// to close, so it gets the same "(interleaved)" concurrency coverage the
// rest of the suite uses for a PRIMARY-KEY upsert.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { makeEnv, post, get, seedClient } from './harness.mjs';

const env0 = (over = {}) => makeEnv({ ADMIN_SECRET: 's', ...over });

function interest(env) {
  return env.DB._rows('SELECT * FROM consumable_interest ORDER BY consumable_id, email');
}

// ---- seed content ------------------------------------------------------------

test('the two launch consumables (wax, diffuser oil) exist and are active', async () => {
  const env = env0();
  const rows = env.DB._rows('SELECT * FROM consumables ORDER BY id');
  assert.deepEqual(rows.map((r) => r.id), ['diffuser-oil', 'wax']);
  assert.ok(rows.every((r) => r.active === 1));
});

// ---- admin: add/update/deactivate --------------------------------------------

test('admin can add a new consumable with no deploy', async () => {
  const env = env0();
  const res = await worker.fetch(post('/api/admin/consumables',
    { id: 'linen-spray', name: 'Linen Spray', description: 'A light linen refresher.', active: true },
    { 'X-Admin-Secret': 's' }), env);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.consumable.id, 'linen-spray');
  assert.equal(body.consumable.active, 1);

  const row = env.DB._row('SELECT * FROM consumables WHERE id = ?', 'linen-spray');
  assert.equal(row.name, 'Linen Spray');
});

test('admin can update an existing consumable in place, same id', async () => {
  const env = env0();
  await worker.fetch(post('/api/admin/consumables', { id: 'wax', name: 'Wax (renamed)' }, { 'X-Admin-Secret': 's' }), env);

  const row = env.DB._row('SELECT * FROM consumables WHERE id = ?', 'wax');
  assert.equal(row.name, 'Wax (renamed)');
  assert.equal(env.DB._rows('SELECT * FROM consumables').length, 2, 'update must not create a second row');
});

test('omitting active on an update leaves the current active state untouched', async () => {
  const env = env0();
  await worker.fetch(post('/api/admin/consumables', { id: 'wax', active: false }, { 'X-Admin-Secret': 's' }), env);
  assert.equal(env.DB._row('SELECT * FROM consumables WHERE id = ?', 'wax').active, 0);

  // A later edit that only touches the name must not implicitly reactivate it.
  await worker.fetch(post('/api/admin/consumables', { id: 'wax', name: 'Wax' }, { 'X-Admin-Secret': 's' }), env);
  assert.equal(env.DB._row('SELECT * FROM consumables WHERE id = ?', 'wax').active, 0, 'active must stay deactivated');
});

test('admin consumables endpoint requires the admin secret', async () => {
  const env = env0();
  const res = await worker.fetch(post('/api/admin/consumables', { id: 'x', name: 'X' }), env);
  assert.equal(res.status, 401);
  assert.equal(env.DB._row('SELECT * FROM consumables WHERE id = ?', 'x'), null);
});

test('admin consumables requires an id', async () => {
  const env = env0();
  const res = await worker.fetch(post('/api/admin/consumables', { name: 'No id' }, { 'X-Admin-Secret': 's' }), env);
  assert.equal(res.status, 400);
});

test('admin consumables requires a name only to CREATE a new one', async () => {
  const env = env0();
  const res = await worker.fetch(post('/api/admin/consumables', { id: 'brand-new' }, { 'X-Admin-Secret': 's' }), env);
  assert.equal(res.status, 400);
  assert.equal(env.DB._row('SELECT * FROM consumables WHERE id = ?', 'brand-new'), null);
});

// ---- GET /api/consumables -----------------------------------------------------

test('a VIP member sees the active list, deactivated items excluded', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  await worker.fetch(post('/api/admin/consumables', { id: 'wax', active: false }, { 'X-Admin-Secret': 's' }), env);

  const res = await worker.fetch(get('/api/consumables?auth_token=TOK'), env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.consumables.map((c) => c.id), ['diffuser-oil']);
});

test('a regular-tier member cannot see consumables', async () => {
  const env = env0();
  await seedClient(env, { tier: 'regular' });
  const res = await worker.fetch(get('/api/consumables?auth_token=TOK'), env);
  assert.equal(res.status, 403);
});

test('consumables list carries this member\'s existing frequency choice, null when they have none', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  await worker.fetch(post('/api/consumables/interest', { authToken: 'TOK', consumableId: 'wax', frequency: 'monthly' }), env);

  const body = await (await worker.fetch(get('/api/consumables?auth_token=TOK'), env)).json();
  const wax = body.consumables.find((c) => c.id === 'wax');
  const oil = body.consumables.find((c) => c.id === 'diffuser-oil');
  assert.equal(wax.frequency, 'monthly');
  assert.equal(oil.frequency, null);
});

// ---- POST /api/consumables/interest --------------------------------------------

test('a VIP member registers interest with a frequency', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });

  const res = await worker.fetch(post('/api/consumables/interest',
    { authToken: 'TOK', consumableId: 'wax', frequency: 'quarterly' }), env);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, { success: true, consumableId: 'wax', frequency: 'quarterly' });
  assert.deepEqual(interest(env).map((r) => [r.consumable_id, r.email, r.frequency]),
    [['wax', 'a@b.com', 'quarterly']]);
});

test('re-registering changes frequency in place, not a second row', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  await worker.fetch(post('/api/consumables/interest', { authToken: 'TOK', consumableId: 'wax', frequency: 'monthly' }), env);
  await worker.fetch(post('/api/consumables/interest', { authToken: 'TOK', consumableId: 'wax', frequency: 'bimonthly' }), env);

  const rows = interest(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].frequency, 'bimonthly');
});

test('interest rejects a frequency outside the fixed set', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const res = await worker.fetch(post('/api/consumables/interest',
    { authToken: 'TOK', consumableId: 'wax', frequency: 'weekly' }), env);
  assert.equal(res.status, 400);
  assert.equal(interest(env).length, 0);
});

test('interest rejects an unknown consumable id', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const res = await worker.fetch(post('/api/consumables/interest',
    { authToken: 'TOK', consumableId: 'nonexistent', frequency: 'monthly' }), env);
  assert.equal(res.status, 404);
});

test('interest rejects a deactivated consumable', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  await worker.fetch(post('/api/admin/consumables', { id: 'wax', active: false }, { 'X-Admin-Secret': 's' }), env);

  const res = await worker.fetch(post('/api/consumables/interest',
    { authToken: 'TOK', consumableId: 'wax', frequency: 'monthly' }), env);
  assert.equal(res.status, 404);
});

test('a regular-tier member cannot register interest', async () => {
  const env = env0();
  await seedClient(env, { tier: 'regular' });
  const res = await worker.fetch(post('/api/consumables/interest',
    { authToken: 'TOK', consumableId: 'wax', frequency: 'monthly' }), env);
  assert.equal(res.status, 403);
  assert.equal(interest(env).length, 0);
});

// ---- Step 4: Past Due grace period ---------------------------------------------

test('a Past Due VIP member cannot order a consumable, 409, nothing changes', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip', status: 'Past Due' });

  const res = await worker.fetch(post('/api/consumables/interest',
    { authToken: 'TOK', consumableId: 'wax', frequency: 'monthly' }), env);
  assert.equal(res.status, 409);
  assert.equal(interest(env).length, 0);
});

test('a Past Due VIP member can still SEE the consumables list', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip', status: 'Past Due' });
  const res = await worker.fetch(get('/api/consumables?auth_token=TOK'), env);
  assert.equal(res.status, 200, 'viewing what exists is not the privilege being withheld — ordering is');
});

// ---- adversarial: the upsert must be atomic, not a racy read-then-write -------

test('(interleaved) 20 concurrent interest submissions for one member leave exactly one row', async () => {
  const env = makeEnv({ ADMIN_SECRET: 's', interleave: true });
  await seedClient(env, { tier: 'vip' });
  const frequencies = ['monthly', 'bimonthly', 'quarterly'];

  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    worker.fetch(post('/api/consumables/interest',
      { authToken: 'TOK', consumableId: 'wax', frequency: frequencies[i % 3] }), env)));

  assert.ok(results.every((r) => r.status === 200));
  const rows = interest(env);
  assert.equal(rows.length, 1, 'the PRIMARY KEY upsert must never produce a second row for the same member+consumable');
  assert.ok(frequencies.includes(rows[0].frequency), 'the surviving row is whichever write landed last, but it must be a valid one');
});

test('(interleaved) concurrent interest from two different members produces two independent rows', async () => {
  const env = makeEnv({ ADMIN_SECRET: 's', interleave: true });
  await seedClient(env, { tier: 'vip' });
  await seedClient(env, { email: 'second@b.com', token: 'TOK2', tier: 'vip', stripe_customer_id: 'cus_2' });

  const results = await Promise.all([
    worker.fetch(post('/api/consumables/interest', { authToken: 'TOK', consumableId: 'wax', frequency: 'monthly' }), env),
    worker.fetch(post('/api/consumables/interest', { authToken: 'TOK2', consumableId: 'wax', frequency: 'quarterly' }), env)
  ]);

  assert.ok(results.every((r) => r.status === 200));
  const rows = interest(env);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.email).sort(), ['a@b.com', 'second@b.com']);
});
