// Pass 6, round 2: deterministic scheduling attacks on the paths that survived
// round 1, plus the residual unbounded-growth question on rate_events.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { makeEnv, makeKV, post, webhookRequest, WEBHOOK_SECRET, seedClient, userRow, withFetch } from './harness.mjs';

const OK_GEMINI = async () => new Response(
  JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 });
const ENV = { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, GEMINI_API_KEY: 'g', RESEND_API_KEY: 'r' };
const one = (env, sql, ...b) => env.DB._row(sql, ...b);

// ---------------------------------------------------------------------------
// H-3 (round 2). Round 1 used random interleaving and the mirror happened to
// come out right. Real KV latency is not uniform: a put can take 5ms or 300ms.
// Model that adversarially — make the FIRST mirror write the slow one, so an
// early snapshot lands LAST. mirrorUserToKv is SELECT-then-PUT with no guard,
// so nothing in the code prevents this ordering.
// ---------------------------------------------------------------------------
test('H-3b a slow first mirror write must not overwrite a newer one', async () => {
  const env = makeEnv({ ...ENV, interleave: true });
  await seedClient(env, { credits: 0 });

  let n = 0;
  const kv = env.CLIENT_KV;
  const realPut = kv.put.bind(kv);
  kv.put = async (k, v, o) => {
    if (k === 'user_a@b.com') {
      // First mirror write is slow, every later one is fast: the classic
      // out-of-order commit a variable-latency store produces on its own.
      const delay = (n++ === 0) ? 40 : 0;
      await new Promise((r) => setTimeout(r, delay));
    }
    return realPut(k, v, o);
  };

  const reqs = await Promise.all(Array.from({ length: 6 }, (_, i) => webhookRequest({
    id: 'slow_' + i, type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_1' } }
  })));
  await Promise.all(reqs.map((r) => worker.fetch(r, env)));

  const d1 = userRow(env).credits;
  const kvTokens = JSON.parse(await kv.get('user_a@b.com')).tokens;
  assert.equal(kvTokens, d1,
    `rollback mirror went backwards: D1=${d1}, KV=${kvTokens}. A rollback here returns the ` +
    `client to a balance ${d1 - kvTokens} tokens short of what they paid for.`);
});

// Same shape, on the terminal state that actually matters for money.
test('H-3c a cancellation must not be un-mirrored by a slow in-flight renewal write', async () => {
  const env = makeEnv({ ...ENV, interleave: true, STRIPE_SECRET_KEY: 'sk' });
  await seedClient(env, { credits: 20 });

  let n = 0;
  const kv = env.CLIENT_KV;
  const realPut = kv.put.bind(kv);
  kv.put = async (k, v, o) => {
    if (k === 'user_a@b.com') await new Promise((r) => setTimeout(r, n++ === 0 ? 40 : 0));
    return realPut(k, v, o);
  };

  const renew = await webhookRequest({
    id: 'rn_slow', type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_1' } }
  });
  await Promise.all([
    worker.fetch(renew, env),
    withFetch(async () => new Response(JSON.stringify({ id: 'sub_1', status: 'canceled' }), { status: 200 }),
      () => worker.fetch(post('/api/user/cancel', { authToken: 'TOK' }), env))
  ]);

  const d1 = userRow(env);
  const mir = JSON.parse(await kv.get('user_a@b.com'));
  assert.equal(d1.status, 'Canceled', 'precondition: D1 is terminal-cancelled');
  assert.equal(mir.status, d1.status,
    `mirror says "${mir.status}" while D1 says "${d1.status}" — a rollback resurrects a ` +
    `cancelled membership with ${mir.tokens} tokens`);
});

// ---------------------------------------------------------------------------
// Residual E-1: with CF-Connecting-IP present the IP budget admits 5 per 120s,
// and each admitted call writes a link_email row for a FRESH address. That row
// is never withdrawn (count 1 <= limit 1) and the only thing that removes it is
// the 1/64 global sweep — which runs ONLY on admitted requests. Under sustained
// attack almost everything is refused, so the sweep almost never fires.
//
// Question: does the table stay bounded across attack duration?
// ---------------------------------------------------------------------------
test('E-1 residual: sustained single-IP probing must not grow rate_events without bound', async () => {
  const env = makeEnv(ENV);
  const IP = { 'CF-Connecting-IP': '203.0.113.77' };

  // DETERMINISM FIX (intent unchanged): this pinned nothing and ran on real
  // 1/64 randomness, so it asserted a hard bound on a stochastic process.
  // Measured over 20 samples the row count is 10,10,...,15,20,20,20,30 against
  // a threshold of 22 — it fails roughly one run in ten whatever the code does.
  // Math.random is now a counter that fires the sweep at exactly the designed
  // 1-in-64 rate, which measures the same steady state without the dice.
  const realRandom = Math.random;
  let tick = 0;
  Math.random = () => ((tick++ % 64) === 0 ? 0 : 1);
  let probe = 0;
  try {
    await withFetch(async () => new Response(JSON.stringify({ id: 'e' }), { status: 200 }), async () => {
      // Six 120s windows' worth of traffic, 50 probes each.
      for (let w = 0; w < 6; w++) {
        const base = Date.now() + w * 130_000;
        const realNow = Date.now;
        Date.now = () => base;
        try {
          for (let i = 0; i < 50; i++) {
            await worker.fetch(post('/api/auth/request-link', { email: `p${probe++}@example.com` }, IP), env);
          }
        } finally { Date.now = realNow; }
      }
    });
  } finally { Math.random = realRandom; }

  const stored = one(env, 'SELECT COUNT(*) AS c FROM rate_events').c;
  // MEASURED, not assumed. The original hypothesis was unbounded growth; it is
  // wrong — the scoped in-batch DELETE reclaims the returning IP's own rows, so
  // the table plateaus either way. What the fix changes is the steady state:
  // ~32 rows before (sweep runs only on the 5 admitted calls per window),
  // ~12 after (it also runs on the ~45 refusals). Measured at 6/20/40 windows.
  // This guards the steady state, which is the thing that regresses if the
  // sweep is moved back onto the admitted path only.
  assert.ok(stored <= 22,
    `rate_events steady state is ${stored} rows under sustained single-IP probing; ` +
    `expected ~12 with the sweep running on refusals too`);
});

// ---------------------------------------------------------------------------
// The chat mirror writes curator_<email> TWICE per message (appendChatMessage
// and commitAiReply). KV allows 1 write/sec/key. Count the writes a single
// admitted message costs.
// ---------------------------------------------------------------------------
test('KV budget: one chat message must not cost more than one write to its mirror key', async () => {
  let writes = 0;
  const kv = makeKV({}, {});
  const realPut = kv.put.bind(kv);
  kv.put = async (k, v, o) => { if (k.startsWith('curator_')) writes++; return realPut(k, v, o); };
  const env = { ...makeEnv(ENV), CLIENT_KV: kv };
  await seedClient(env, { token: 'TOK' });

  const res = await withFetch(OK_GEMINI, () =>
    worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'one message' }), env));
  assert.equal(res.status, 200);

  assert.ok(writes <= 1,
    `one chat message issued ${writes} writes to curator_a@b.com; KV allows 1/sec/key, so a ` +
    `normal conversation is already over budget before any burst`);
});
