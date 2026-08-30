// ============================================================================
// AC-9 .. AC-21: rate limiting, re-authentication, lazy migration, and the
// compatibility/security guarantees the migration must not break.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import worker from '../worker.js';
import {
  makeEnv, makeKV, post, get, webhookRequest, WEBHOOK_SECRET,
  seedClient, seedUser, seedToken, userRow, withFetch, withFrozenClock, REPO_ROOT
} from './harness.mjs';

const env0 = (over = {}) => makeEnv({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, ...over });

// ---- Rate limiting -----------------------------------------------------------

test('AC-9 the eleventh chat message in a minute is refused', async () => {
  const env = env0();
  await seedClient(env);

  const statuses = [];
  for (let i = 0; i < 11; i++) {
    const res = await worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'm' + i }), env);
    statuses.push(res.status);
    if (res.status === 429) assert.equal(res.headers.get('Retry-After'), '60');
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.equal(statuses[10], 429);
});

test('AC-10 fifteen concurrent chat requests let no more than ten through', async () => {
  const env = env0();
  await seedClient(env);

  const results = await Promise.all(Array.from({ length: 15 }, (_, i) =>
    worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'x' + i }), env)));
  const passed = results.filter((r) => r.status === 200).length;

  // insert-then-count: each request's own row is inside its own count, so two
  // racing requests cannot both observe limit-1 and both proceed.
  //
  // Under a perfectly simultaneous burst every request sees the whole burst and
  // the honest answer is 0 admitted. That is the conservative direction and it
  // is the point of this ordering: count-then-insert would have let all fifteen
  // through. Real traffic is sequential and admits exactly ten — see AC-9.
  assert.ok(passed <= 10, `expected at most 10 to pass, got ${passed}`);
  assert.equal(results.filter((r) => r.status === 429).length, 15 - passed);
});

test('the window slides: a request outside it is allowed again', async () => {
  const env = env0();
  await seedClient(env);
  for (let i = 0; i < 10; i++) {
    await worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'y' + i }), env);
  }
  assert.equal((await worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'blocked' }), env)).status, 429);

  const later = Date.now() + 61000;
  const res = await withFrozenClock(later, () =>
    worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'ok' }), env));
  assert.equal(res.status, 200);
});

test('a rate-limit failure fails open rather than taking the concierge down', async () => {
  const env = env0();
  await seedClient(env);

  // Break ONLY the rate-limit path. Breaking every batch would also break the
  // message insert, and then a 500 would prove nothing about failing open.
  const realBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (statements) => {
    if (statements.some((s) => /rate_events/.test(s.sql))) throw new Error('D1 unavailable');
    return realBatch(statements);
  };

  const res = await worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'hi' }), env);
  assert.equal(res.status, 200);
});

test('AC-11 two request-link calls for one email send exactly one letter', async () => {
  const sent = [];
  const env = env0({ RESEND_API_KEY: 'rk' });
  await seedClient(env);

  await withFetch(async (url, opts) => {
    sent.push(JSON.parse(opts.body).to[0]);
    return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
  }, async () => {
    await worker.fetch(post('/api/auth/request-link', { email: 'a@b.com' }), env);
    await worker.fetch(post('/api/auth/request-link', { email: 'a@b.com' }), env);
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent, ['a@b.com']);
});

// ---- Re-authentication --------------------------------------------------------

async function requestLink(env, email, headers = {}) {
  const res = await worker.fetch(post('/api/auth/request-link', { email }, headers), env);
  return { status: res.status, body: await res.text() };
}

test('AC-12 the response is identical for a member, a stranger and a bad address', async () => {
  const env = env0({ RESEND_API_KEY: 'rk' });
  await seedClient(env);

  const answers = await withFetch(
    async () => new Response(JSON.stringify({ id: 'em' }), { status: 200 }),
    async () => [
      await requestLink(env, 'a@b.com'),           // a real member
      await requestLink(env, 'nobody@example.com'), // no such client
      await requestLink(env, 'not-an-email'),       // malformed
      await requestLink(env, '')                    // empty
    ]
  );

  for (const a of answers) {
    assert.equal(a.status, 202, JSON.stringify(a));
    assert.equal(a.body, JSON.stringify({ ok: true }), JSON.stringify(a));
  }
});

test('AC-12b a rate-limited caller gets the same 202, not a 429', async () => {
  const env = env0({ RESEND_API_KEY: 'rk' });
  await seedClient(env);
  await withFetch(async () => new Response(JSON.stringify({ id: 'em' }), { status: 200 }), async () => {
    const first = await requestLink(env, 'a@b.com');
    const second = await requestLink(env, 'a@b.com');
    assert.deepEqual(second, first);
  });
});

test('AC-13 a canceled membership gets no link, with the same response', async () => {
  const sent = [];
  const env = env0({ RESEND_API_KEY: 'rk' });
  await seedClient(env, { status: 'Canceled', credits: 0 });

  const answer = await withFetch(async (url, opts) => {
    sent.push(JSON.parse(opts.body).to[0]);
    return new Response(JSON.stringify({ id: 'em' }), { status: 200 });
  }, () => requestLink(env, 'a@b.com'));

  assert.equal(answer.status, 202);
  assert.equal(answer.body, JSON.stringify({ ok: true }));
  assert.equal(sent.length, 0, 'no email for a cancelled account');
});

test('AC-14 a link minted after revocation resolves; the old one does not', async () => {
  const env = env0({ RESEND_API_KEY: 'rk', STRIPE_SECRET_KEY: 'sk' });
  await seedClient(env);

  await withFetch(async () => new Response(JSON.stringify({ id: 'sub_1', status: 'canceled' }), { status: 200 }),
    () => worker.fetch(post('/api/user/cancel', { authToken: 'TOK' }), env));
  assert.equal((await worker.fetch(get('/api/user?auth_token=TOK'), env)).status, 401);

  // Re-subscribe, then ask for a fresh link.
  await worker.fetch(await webhookRequest({
    id: 'resub', type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', payment_status: 'paid', customer: 'cus_1', id: 'cs',
                      customer_details: { email: 'a@b.com', name: 'A' } } }
  }), env);

  await withFetch(async () => new Response(JSON.stringify({ id: 'em' }), { status: 200 }),
    () => worker.fetch(post('/api/auth/request-link', { email: 'a@b.com' }), env));

  const tokens = [...env.CLIENT_KV._m.keys()].filter((k) => k.startsWith('magic_'));
  let resolved = 0;
  for (const key of tokens) {
    const res = await worker.fetch(get('/api/user?auth_token=' + key.slice('magic_'.length)), env);
    if (res.status === 200) resolved++;
  }
  assert.ok(resolved >= 1, 'at least one fresh link works');
  assert.equal((await worker.fetch(get('/api/user?auth_token=TOK'), env)).status, 401, 'the revoked link stays dead');
});

test('request-link never mints a token for an unknown address', async () => {
  const env = env0({ RESEND_API_KEY: 'rk' });
  await withFetch(async () => new Response(JSON.stringify({ id: 'em' }), { status: 200 }),
    () => worker.fetch(post('/api/auth/request-link', { email: 'ghost@example.com' }), env));
  assert.equal([...env.CLIENT_KV._m.keys()].filter((k) => k.startsWith('magic_')).length, 0);
});

// ---- Lazy migration (ADR-003) -------------------------------------------------

const LEGACY = {
  email: 'legacy@b.com',
  status: 'Paused (Offline)',
  tokens: 60,
  skipped: true,
  stripeCustomerId: 'cus_legacy',
  stripeSubscriptionId: 'sub_legacy',
  updatedAt: 1700000000000
};

test('AC-15 a client present only in KV is read through into D1 with fields intact', async () => {
  const env = env0();
  await env.CLIENT_KV.put('user_legacy@b.com', JSON.stringify(LEGACY));
  await seedToken(env, 'LTOK', 'legacy@b.com');

  const res = await worker.fetch(get('/api/user?auth_token=LTOK'), env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, {
    email: 'legacy@b.com',
    status: 'Paused (Offline)',
    skipped: true,
    tokens: 60,
    updatedAt: 1700000000000
  });

  const row = userRow(env, 'legacy@b.com');
  assert.equal(row.credits, 60);
  assert.equal(row.skipped, 1);
  assert.equal(row.stripe_customer_id, 'cus_legacy');
  assert.equal(row.stripe_subscription_id, 'sub_legacy');
  assert.equal(row.updated_at, 1700000000000);
});

test('AC-16 two concurrent first-touches create exactly one row', async () => {
  const env = env0();
  await env.CLIENT_KV.put('user_legacy@b.com', JSON.stringify(LEGACY));
  await seedToken(env, 'LTOK', 'legacy@b.com');

  const [a, b] = await Promise.all([
    worker.fetch(get('/api/user?auth_token=LTOK'), env),
    worker.fetch(get('/api/user?auth_token=LTOK'), env)
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(env.DB._rows('SELECT * FROM users WHERE email = ?', 'legacy@b.com').length, 1);
});

test('AC-17 a client in neither store is 401 and creates no row', async () => {
  const env = env0();
  await seedToken(env, 'GHOST', 'ghost@b.com');

  const res = await worker.fetch(get('/api/user?auth_token=GHOST'), env);
  assert.equal(res.status, 401);
  assert.equal(userRow(env, 'ghost@b.com'), null);
  assert.equal(env.DB._rows('SELECT * FROM users').length, 0);
});

test('a webhook migrates a legacy client who never opened the portal', async () => {
  const env = env0();
  await env.CLIENT_KV.put('user_legacy@b.com', JSON.stringify({ ...LEGACY, status: 'Active', skipped: false, tokens: 20 }));
  await env.CLIENT_KV.put('cust_cus_legacy', 'legacy@b.com');

  await worker.fetch(await webhookRequest({
    id: 'lz', type: 'invoice.payment_succeeded',
    data: { object: { billing_reason: 'subscription_cycle', amount_paid: 2000, customer: 'cus_legacy' } }
  }), env);

  assert.equal(userRow(env, 'legacy@b.com').credits, 40);
});

// ---- §7 rollback mirror --------------------------------------------------------

test('every mutation is mirrored back into the legacy KV shape', async () => {
  const env = env0();
  await seedClient(env, { credits: 20 });

  await worker.fetch(post('/api/user/skip', { authToken: 'TOK', skipped: true }), env);
  const mirrored = JSON.parse(await env.CLIENT_KV.get('user_a@b.com'));
  assert.equal(mirrored.status, 'Paused (Offline)');
  assert.equal(mirrored.skipped, true);
  assert.equal(mirrored.tokens, 20);
  assert.equal(mirrored.stripeCustomerId, 'cus_1');

  await worker.fetch(post('/api/curator/chat', { authToken: 'TOK', message: 'mirror me' }), env);
  const convo = JSON.parse(await env.CLIENT_KV.get('curator_a@b.com'));
  assert.ok(convo.messages.some((m) => m.text === 'mirror me'));
});

// ---- AC-18 / AC-19: contract and headers ----------------------------------------

test('AC-18 /api/user returns exactly the documented keys', async () => {
  const env = env0();
  await seedClient(env);
  const body = await (await worker.fetch(get('/api/user?auth_token=TOK'), env)).json();
  assert.deepEqual(Object.keys(body).sort(), ['email', 'skipped', 'status', 'tokens', 'updatedAt']);
  assert.equal(typeof body.skipped, 'boolean');
  assert.equal(typeof body.tokens, 'number');
});

test('AC-19 every response path carries nosniff and no-referrer', async () => {
  const env = env0();
  await seedClient(env);

  const responses = [
    await worker.fetch(get('/api/user?auth_token=TOK'), env),                          // 200 JSON
    await worker.fetch(get('/api/user?auth_token=nope'), env),                          // 401 JSON
    await worker.fetch(new Request('https://w.dev/api/user', { method: 'OPTIONS' }), env), // preflight
    await worker.fetch(get('/nope'), env)                                               // 405
  ];

  const broken = env0();
  await seedClient(broken);
  broken.DB = { prepare() { throw new Error('boom'); } };
  responses.push(await worker.fetch(get('/api/user?auth_token=TOK'), broken));           // 500

  for (const res of responses) {
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff', String(res.status));
    assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer', String(res.status));
  }
  assert.equal(responses[4].status, 500);
  assert.equal(responses[3].status, 405);
});

test('JSON responses declare a locked-down CSP', async () => {
  const env = env0();
  await seedClient(env);
  const res = await worker.fetch(get('/api/user?auth_token=TOK'), env);
  assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'none'");
});

// ---- AC-20: the page's CSP ------------------------------------------------------

test('AC-20 index.html has no unsafe-inline in script-src and the hash matches', () => {
  const html = readFileSync(join(REPO_ROOT, 'index.html'), 'utf8');

  const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(meta, 'index.html must carry a CSP meta tag');
  const policy = meta[1];

  const scriptSrc = policy.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src'));
  assert.ok(scriptSrc, 'the policy must set script-src');
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), "script-src must not allow 'unsafe-inline'");

  // Recompute the hash from the file and compare. This is the CI step §8.3 asks
  // for: editing the script without re-running it turns the page blank in
  // production, so the failure belongs here, not in a user's browser.
  //
  // Comments are stripped first. A comment that mentions script markup would
  // otherwise be matched instead of the real element, and the hash would end up
  // covering the meta tag that carries it — self-referential and never stable.
  const script = html.replace(/<!--[\s\S]*?-->/g, '').match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, 'the inline script must be present');
  const digest = createHash('sha256').update(script[1], 'utf8').digest('base64');
  assert.ok(
    scriptSrc.includes(`'sha256-${digest}'`),
    `script-src hash is stale.\n  expected 'sha256-${digest}'\n  policy   ${scriptSrc}`
  );
});

// ---- 8.6: no silent degradation --------------------------------------------------

test('a missing D1 binding is 503, never a quiet fall back to KV', async () => {
  const env = makeEnv({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  await seedClient(env);
  const noDb = { ...env, DB: undefined };
  const res = await worker.fetch(get('/api/user?auth_token=TOK'), noDb);
  assert.equal(res.status, 503);
});

// ---- 8.2 marker inventory ---------------------------------------------------------

test('the audit marker inventory did not shrink', () => {
  const worker_js = readFileSync(join(REPO_ROOT, 'worker.js'), 'utf8');
  const index_html = readFileSync(join(REPO_ROOT, 'index.html'), 'utf8');
  const markers = new Set((worker_js + index_html).match(/\b[CMABD]-[0-9]+\b/g) || []);

  // Every marker that existed before this branch must still exist. B-5, D-2 and
  // D-3/D-4 are deliberately absent: they were never in this repository, and
  // inventing them would document work that was never done.
  const required = [
    'C-1', 'C-2', 'C-3',
    'M-4', 'M-5', 'M-6', 'M-7', 'M-8', 'M-9', 'M-10', 'M-11', 'M-12', 'M-13', 'M-14',
    'A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8', 'A-9', 'A-10', 'A-11',
    'B-1', 'B-2', 'B-3', 'B-4',
    'D-1'
  ];
  for (const m of required) assert.ok(markers.has(m), `marker ${m} disappeared`);
  assert.ok(markers.size >= 30, `expected >= 30 unique markers, found ${markers.size}`);
});
