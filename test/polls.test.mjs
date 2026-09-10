// ============================================================================
// Feature 1: customizable poll (VIP tier only).
//
// Felix creates/edits a poll without touching code via POST /api/admin/polls.
// At most one poll is ever active — activating one deactivates every other
// in the same batch. One row per member per poll in poll_votes; re-voting
// changes the same row, so this gets the same "(interleaved)" concurrency
// coverage as consumable_interest. Percentages are computed live on every
// GET /api/polls/active, never stored, so they can never go stale.
//
// Sheets sync is deliberately NOT exercised here — env0() carries no
// GOOGLE_SHEET_ID, so upsertVoteRowInSheet's own no-op guard is what every
// test in this file is actually exercising for that path. The sync logic
// itself (JWT signing, upsert-vs-append) is covered in
// test/google_sheets.test.mjs.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { makeEnv, post, get, seedClient } from './harness.mjs';

const env0 = (over = {}) => makeEnv({ ADMIN_SECRET: 's', ...over });

function votes(env) {
  return env.DB._rows('SELECT * FROM poll_votes ORDER BY poll_id, email');
}

const OPTIONS = ['Rose', 'Amber', 'Cedar'];

async function createActivePoll(env, id = 'scent', options = OPTIONS) {
  return worker.fetch(post('/api/admin/polls',
    { id, question: 'Which scent for the next capsule?', options, active: true },
    { 'X-Admin-Secret': 's' }), env);
}

// ---- admin: create/edit --------------------------------------------------------

test('admin creates a new poll, inactive by default', async () => {
  const env = env0();
  const res = await worker.fetch(post('/api/admin/polls',
    { id: 'scent', question: 'Which scent?', options: OPTIONS }, { 'X-Admin-Secret': 's' }), env);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.poll.active, 0, 'a brand-new poll must not silently replace whatever is currently live');
  assert.deepEqual(body.poll.options, OPTIONS);
});

test('admin creates a poll already active: it becomes the (only) active poll', async () => {
  const env = env0();
  const res = await createActivePoll(env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.poll.active, 1);
});

test('activating a new poll deactivates every other active poll', async () => {
  const env = env0();
  await createActivePoll(env, 'first', ['A', 'B']);
  await createActivePoll(env, 'second', ['C', 'D']);

  const polls = env.DB._rows('SELECT * FROM polls ORDER BY id');
  assert.deepEqual(polls.map((p) => [p.id, p.active]), [['first', 0], ['second', 1]]);
});

test('editing the question in place does not touch active state or options', async () => {
  const env = env0();
  await createActivePoll(env);
  await worker.fetch(post('/api/admin/polls', { id: 'scent', question: 'Updated question?' }, { 'X-Admin-Secret': 's' }), env);

  const row = env.DB._row('SELECT * FROM polls WHERE id = ?', 'scent');
  assert.equal(row.question, 'Updated question?');
  assert.equal(row.active, 1, 'omitting active must not deactivate the poll');
  assert.deepEqual(JSON.parse(row.options), OPTIONS);
});

test('deactivating a poll (active:false) does not activate anything else', async () => {
  const env = env0();
  await createActivePoll(env, 'first', ['A', 'B']);
  await worker.fetch(post('/api/admin/polls', { id: 'first', active: false }, { 'X-Admin-Secret': 's' }), env);
  assert.equal(env.DB._row('SELECT * FROM polls WHERE id = ?', 'first').active, 0);
});

test('admin polls requires an id', async () => {
  const env = env0();
  const res = await worker.fetch(post('/api/admin/polls', { question: 'No id?' }, { 'X-Admin-Secret': 's' }), env);
  assert.equal(res.status, 400);
});

test('admin polls requires question and options (2+) only to create a new poll', async () => {
  const env = env0();
  const res = await worker.fetch(post('/api/admin/polls', { id: 'brand-new' }, { 'X-Admin-Secret': 's' }), env);
  assert.equal(res.status, 400);
  assert.equal(env.DB._row('SELECT * FROM polls WHERE id = ?', 'brand-new'), null);
});

test('admin polls rejects fewer than 2 options', async () => {
  const env = env0();
  const res = await worker.fetch(post('/api/admin/polls',
    { id: 'scent', question: 'Q?', options: ['Only one'] }, { 'X-Admin-Secret': 's' }), env);
  assert.equal(res.status, 400);
});

test('admin polls endpoint requires the admin secret', async () => {
  const env = env0();
  const res = await worker.fetch(post('/api/admin/polls', { id: 'scent', question: 'Q?', options: OPTIONS }), env);
  assert.equal(res.status, 401);
  assert.equal(env.DB._row('SELECT * FROM polls WHERE id = ?', 'scent'), null);
});

// ---- GET /api/polls/active -----------------------------------------------------

test('no active poll returns poll: null, not an error', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const res = await worker.fetch(get('/api/polls/active?auth_token=TOK'), env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.poll, null);
});

test('a regular-tier member cannot see the poll', async () => {
  const env = env0();
  await createActivePoll(env);
  await seedClient(env, { tier: 'regular' });
  const res = await worker.fetch(get('/api/polls/active?auth_token=TOK'), env);
  assert.equal(res.status, 403);
});

test('results carry every option, zero-vote options included, and myVote is null before voting', async () => {
  const env = env0();
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });

  const body = await (await worker.fetch(get('/api/polls/active?auth_token=TOK'), env)).json();
  assert.equal(body.poll.question, 'Which scent for the next capsule?');
  assert.deepEqual(body.results.map((r) => r.option), OPTIONS);
  assert.ok(body.results.every((r) => r.count === 0 && r.percent === 0));
  assert.equal(body.totalVotes, 0);
  assert.equal(body.myVote, null);
});

test('percentages are computed live and round to whole numbers', async () => {
  const env = env0();
  await createActivePoll(env, 'scent', ['Rose', 'Amber', 'Cedar']);
  await seedClient(env, { tier: 'vip' });
  await seedClient(env, { email: 'b@b.com', token: 'TOK2', tier: 'vip', stripe_customer_id: 'cus_2' });
  await seedClient(env, { email: 'c@b.com', token: 'TOK3', tier: 'vip', stripe_customer_id: 'cus_3' });

  await worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env);
  await worker.fetch(post('/api/polls/vote', { authToken: 'TOK2', pollId: 'scent', choice: 'Rose' }), env);
  await worker.fetch(post('/api/polls/vote', { authToken: 'TOK3', pollId: 'scent', choice: 'Amber' }), env);

  const body = await (await worker.fetch(get('/api/polls/active?auth_token=TOK'), env)).json();
  const rose = body.results.find((r) => r.option === 'Rose');
  const amber = body.results.find((r) => r.option === 'Amber');
  const cedar = body.results.find((r) => r.option === 'Cedar');
  assert.equal(body.totalVotes, 3);
  assert.deepEqual([rose.count, rose.percent], [2, 67]);
  assert.deepEqual([amber.count, amber.percent], [1, 33]);
  assert.deepEqual([cedar.count, cedar.percent], [0, 0]);
});

test('myVote reflects this member\'s own choice and comment', async () => {
  const env = env0();
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });
  await worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Amber', comment: 'Love it' }), env);

  const body = await (await worker.fetch(get('/api/polls/active?auth_token=TOK'), env)).json();
  assert.deepEqual(body.myVote, { choice: 'Amber', comment: 'Love it' });
});

// ---- POST /api/polls/vote -------------------------------------------------------

test('a VIP member votes once', async () => {
  const env = env0();
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });

  const res = await worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, { success: true, pollId: 'scent', choice: 'Rose' });
  assert.deepEqual(votes(env).map((v) => [v.poll_id, v.email, v.choice]), [['scent', 'a@b.com', 'Rose']]);
});

test('re-voting changes the choice in place, not a second row', async () => {
  const env = env0();
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });
  await worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env);
  await worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Cedar' }), env);

  const rows = votes(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].choice, 'Cedar');
});

test('a comment is optional and stored trimmed', async () => {
  const env = env0();
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });
  await worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose', comment: '  nice one  ' }), env);
  assert.equal(votes(env)[0].comment, 'nice one');
});

test('vote rejects a choice outside the poll\'s options', async () => {
  const env = env0();
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });
  const res = await worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Sandalwood' }), env);
  assert.equal(res.status, 400);
  assert.equal(votes(env).length, 0);
});

test('vote rejects an unknown or inactive poll', async () => {
  const env = env0();
  await worker.fetch(post('/api/admin/polls', { id: 'draft', question: 'Q?', options: OPTIONS }, { 'X-Admin-Secret': 's' }), env);
  await seedClient(env, { tier: 'vip' });

  const unknown = await worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'nonexistent', choice: 'Rose' }), env);
  assert.equal(unknown.status, 404);

  const inactive = await worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'draft', choice: 'Rose' }), env);
  assert.equal(inactive.status, 404);
});

test('a regular-tier member cannot vote', async () => {
  const env = env0();
  await createActivePoll(env);
  await seedClient(env, { tier: 'regular' });
  const res = await worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env);
  assert.equal(res.status, 403);
  assert.equal(votes(env).length, 0);
});

test('vote is rate-limited independently of the chat bucket', async () => {
  const env = env0();
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });

  const statuses = [];
  for (let i = 0; i < 11; i++) {
    const choice = OPTIONS[i % OPTIONS.length];
    const res = await worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice }), env);
    statuses.push(res.status);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.equal(statuses[10], 429);
});

// ---- adversarial: the upsert must be atomic --------------------------------------

test('(interleaved) 20 concurrent votes from one member leave at most one row', async () => {
  const env = makeEnv({ ADMIN_SECRET: 's', interleave: true });
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });

  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: OPTIONS[i % 3] }), env)));

  // The poll_vote rate limiter (10/min, unrelated to this test's actual
  // subject) legitimately refuses most of these — same interaction AC-9/
  // AC-10 document for chat. Forced interleaving is the conservative
  // extreme AC-10's own comment describes: a perfectly simultaneous burst
  // can see every request observe the whole burst and admit zero, which
  // is the safe direction for insert-then-count. The PRIMARY KEY upsert is
  // what is actually under test here: however many of the 20 land (zero
  // included), they must never produce more than one row.
  const admitted = results.filter((r) => r.status === 200).length;
  assert.ok(admitted <= 10, `expected at most 10 admitted, got ${admitted}`);
  const rows = votes(env);
  assert.ok(rows.length <= 1, 'the PRIMARY KEY upsert must never produce a second row for the same member+poll');
  if (rows.length === 1) assert.ok(OPTIONS.includes(rows[0].choice));
});

test('(interleaved) concurrent votes from different members produce independent rows and correct tallies', async () => {
  const env = makeEnv({ ADMIN_SECRET: 's', interleave: true });
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });
  await seedClient(env, { email: 'b@b.com', token: 'TOK2', tier: 'vip', stripe_customer_id: 'cus_2' });

  const results = await Promise.all([
    worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env),
    worker.fetch(post('/api/polls/vote', { authToken: 'TOK2', pollId: 'scent', choice: 'Amber' }), env)
  ]);

  assert.ok(results.every((r) => r.status === 200));
  assert.equal(votes(env).length, 2);
  const body = await (await worker.fetch(get('/api/polls/active?auth_token=TOK'), env)).json();
  assert.equal(body.totalVotes, 2);
});
