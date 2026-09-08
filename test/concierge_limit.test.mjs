// ============================================================================
// Step 3: regular tier gets 5 concierge consultations per UTC calendar
// month; VIP has no ceiling. No new counter or table — chat_messages
// already logs every message with ts and role, so the count IS the real
// history and can never drift from what a curator actually sees.
//
// Month boundary: a message counts toward whichever UTC calendar month
// Date.now() falls in at the instant it is sent. No session-level
// grandfathering — a client mid-conversation at 23:59:59 UTC on the last
// day of the month gets a fresh allowance one second later, same as anyone
// else. This is the explicit, stated choice for the deliberately
// unspecified boundary behaviour in the brief.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { makeEnv, post, get, seedClient, chatMessages, withFrozenClock } from './harness.mjs';

const env0 = (over = {}) => makeEnv(over);

async function sendMessages(env, count, { token = 'TOK', prefix = 'm' } = {}) {
  const statuses = [];
  for (let i = 0; i < count; i++) {
    const res = await worker.fetch(post('/api/curator/chat', { authToken: token, message: prefix + i }), env);
    statuses.push(res.status);
  }
  return statuses;
}

test('a regular-tier member sends 5 consultations this month, the 6th is blocked', async () => {
  const env = env0();
  await seedClient(env, { tier: 'regular' });

  const statuses = await sendMessages(env, 6);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 403]);
  assert.equal(chatMessages(env).filter((m) => m.role === 'user').length, 5, 'the blocked 6th must not be stored');
});

test('the 6th message answers with limitReached and a zero-remaining quota, distinct from the abuse rate limit', async () => {
  const env = env0();
  await seedClient(env, { tier: 'regular' });
  await sendMessages(env, 5);

  const res = await worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'one too many' }), env);
  const body = await res.json();
  assert.equal(res.status, 403, 'distinct from the 429 the abuse rate limiter uses');
  assert.equal(body.limitReached, true);
  assert.deepEqual(body.concierge, { limit: 5, used: 5, remaining: 0 });
});

test('a 7th, 8th, ... attempt after the limit stays blocked (retrying the 6th is a no-op, not a leak)', async () => {
  const env = env0();
  await seedClient(env, { tier: 'regular' });
  await sendMessages(env, 5);

  const retries = await sendMessages(env, 3, { prefix: 'retry' });
  assert.deepEqual(retries, [403, 403, 403]);
  assert.equal(chatMessages(env).filter((m) => m.role === 'user').length, 5);
});

test('images count toward the same limit as text — no separate attachment budget', async () => {
  const env = env0();
  await seedClient(env, { tier: 'regular' });

  const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const res = await worker.fetch(post('/api/curator/chat', {
      authToken: 'TOK', message: '', imageBase64: tinyPngBase64, imageMime: 'image/png'
    }), env);
    statuses.push(res.status);
  }
  const sixth = await worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'text this time' }), env);

  assert.deepEqual(statuses, Array(5).fill(200));
  assert.equal(sixth.status, 403, 'an image-only run of 5 must exhaust the same monthly budget as text');
});

test('VIP has no monthly ceiling', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });

  const statuses = await sendMessages(env, 8);
  // The shared abuse rate limiter is untouched by Step 3 and still applies —
  // 10/minute — so all 8 of these pass under it too.
  assert.deepEqual(statuses, Array(8).fill(200));

  const res = await worker.fetch(get('/api/curator/messages?auth_token=TOK'), env);
  const body = await res.json();
  assert.equal(body.concierge, null, 'VIP must not carry a quota object at all, not a large one');
});

test('the count resets at the UTC calendar month boundary, with no grandfathering', async () => {
  const env = env0();
  await seedClient(env, { tier: 'regular' });

  const lastSecondOfJanuary = Date.UTC(2024, 0, 31, 23, 59, 59);
  const firstSecondOfFebruary = Date.UTC(2024, 1, 1, 0, 0, 0);

  await withFrozenClock(lastSecondOfJanuary, () => sendMessages(env, 5));
  const stillJanuary = await withFrozenClock(lastSecondOfJanuary, () =>
    worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'blocked in january' }), env));
  assert.equal(stillJanuary.status, 403);

  // One second later, a new UTC month: the same client gets a fresh
  // allowance without any special-casing on our part.
  const nowFebruary = await withFrozenClock(firstSecondOfFebruary, () =>
    worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'first in february' }), env));
  assert.equal(nowFebruary.status, 200);

  const usage = await withFrozenClock(firstSecondOfFebruary, () =>
    worker.fetch(get('/api/curator/messages?auth_token=TOK'), env));
  const usageBody = await usage.json();
  assert.deepEqual(usageBody.concierge, { limit: 5, used: 1, remaining: 4 });
});

test('/api/curator/messages reports the running count for a regular-tier member', async () => {
  const env = env0();
  await seedClient(env, { tier: 'regular' });
  await sendMessages(env, 3);

  const res = await worker.fetch(get('/api/curator/messages?auth_token=TOK'), env);
  const body = await res.json();
  assert.equal(body.tier, 'regular');
  assert.deepEqual(body.concierge, { limit: 5, used: 3, remaining: 2 });
});

// ---- adversarial: the guard must be atomic, not a racy check-then-insert ---

test('a burst of 20 concurrent messages from a regular-tier member never stores more than 5', async () => {
  const env = env0();
  await seedClient(env, { tier: 'regular' });

  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'burst' + i }), env)));

  const admitted = results.filter((r) => r.status === 200).length;
  const stored = chatMessages(env).filter((m) => m.role === 'user').length;

  // A plain SELECT-COUNT-then-INSERT would let many concurrent callers all
  // observe the same pre-insert count and all get through — exactly the
  // class of bug ADR-005 exists to close for the abuse rate limiter. The
  // guard here lives inside the INSERT itself, so it cannot overshoot.
  assert.ok(admitted <= 5, `expected at most 5 admitted, got ${admitted}`);
  assert.equal(stored, admitted, 'D1 must hold exactly the admitted messages, no more');
});

test('(interleaved) the same burst still never overshoots, with a forced macrotask yield before every statement', async () => {
  // interleave: true forces a yield before every standalone statement (see
  // harness.mjs), the same stress this project's own rate-limiter
  // concurrency tests (AC-1..AC-6 "(interleaved)") use to expose a
  // lost-update a same-tick mock would hide.
  const env = makeEnv({ interleave: true });
  await seedClient(env, { tier: 'regular' });

  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'burst' + i }), env)));

  const admitted = results.filter((r) => r.status === 200).length;
  const stored = chatMessages(env).filter((m) => m.role === 'user').length;

  assert.ok(admitted <= 5, `expected at most 5 admitted, got ${admitted}`);
  assert.equal(stored, admitted, 'D1 must hold exactly the admitted messages, no more');
});
