// ============================================================================
// Feature 1: Google Sheets sync for poll votes.
//
// No npm dependency is allowed (googleapis / google-auth-library), so the
// service-account OAuth2 flow in worker.js is hand-rolled: a self-signed
// RS256 JWT exchanged at Google's token endpoint, same posture as the
// hand-rolled WebAuthn crypto elsewhere in this project. These tests drive
// it entirely through the real POST /api/polls/vote endpoint (a black box,
// same philosophy test/webauthn.test.mjs uses) and inspect the outbound
// fetch calls it makes: a real RSA key pair verifies the JWT's signature is
// actually valid, not just shaped like one.
//
// The access-token cache in worker.js is a module-level, per-isolate cache
// by design (production has exactly one service account, so that's the
// right scope there) — but this test file imports that same module once for
// every test in it, so a token cached by one test is, without care, still
// "fresh" by the time the next test runs milliseconds later. Every test
// that touches Google gets its own frozen clock, far enough from every
// other test's, so each one genuinely starts from an expired cache rather
// than silently inheriting a neighbor's.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { makeEnv, post, seedClient, withFetch, withFrozenClock } from './harness.mjs';

let clockSlot = 0;
// Each slot is 10 hours apart — far past the 1-hour token lifetime any
// earlier slot could have cached, in either time direction.
function freshNow() {
  clockSlot += 1;
  return Date.now() + clockSlot * 10 * 60 * 60 * 1000;
}

// Runs fn with both the outbound fetch and the clock swapped for its
// duration — the clock isolates this test's view of the token cache, the
// fetch stub answers Google's endpoints.
function withGoogle(stubFn, fn) {
  return withFrozenClock(freshNow(), () => withFetch(stubFn, fn));
}

// ---- a real RSA key pair, PEM-wrapped like a downloaded service-account key -

async function makeServiceAccountKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const lines = base64.match(/.{1,64}/g).join('\n');
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
  return { keyPair, pem };
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (b64.length % 4)) % 4;
  const bin = atob(b64 + '='.repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyAndDecodeJwt(jwt, publicKey) {
  const [h, c, s] = jwt.split('.');
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(c)));
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', publicKey, b64urlToBytes(s), new TextEncoder().encode(`${h}.${c}`)
  );
  return { header, claims, verified };
}

const env0 = (over = {}) => makeEnv({ ADMIN_SECRET: 's', ...over });

async function createActivePoll(env) {
  await worker.fetch(post('/api/admin/polls',
    { id: 'scent', question: 'Which scent?', options: ['Rose', 'Amber'], active: true },
    { 'X-Admin-Secret': 's' }), env);
}

function googleEnv(over = {}) {
  return env0({
    GOOGLE_SA_EMAIL: 'sa@example.iam.gserviceaccount.com',
    GOOGLE_SHEET_ID: 'sheet123',
    ...over
  });
}

// Builds a stub fetch() that answers Google's token endpoint (verifying the
// JWT for real) and the Sheets read/append/update endpoints, and records
// every call for assertions.
function googleStub({ existingRows = [] } = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    // worker.js builds these URLs with encodeURIComponent, so "Sheet1!A2:F"
    // arrives here as "Sheet1%21A2%3AF" — match on the decoded form so this
    // stub does not silently fall through to its 404 branch.
    const decoded = decodeURIComponent(u);
    calls.push({ url: u, method: opts.method, body: opts.body });

    if (u === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'fake-access-token', expires_in: 3600 }), { status: 200 });
    }
    if (decoded.includes(':append')) {
      return new Response(JSON.stringify({ updates: { updatedRows: 1 } }), { status: 200 });
    }
    if (opts.method === 'PUT') {
      return new Response(JSON.stringify({ updatedRows: 1 }), { status: 200 });
    }
    if (decoded.includes('/values/Sheet1!A2:F') && (!opts.method || opts.method === 'GET')) {
      return new Response(JSON.stringify({ values: existingRows }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  return { calls, fn };
}

// ---- the JWT itself is spec-correct and really signed ------------------------

test('the service-account JWT is well-formed, RS256, and its signature genuinely verifies', async () => {
  const { keyPair, pem } = await makeServiceAccountKeyPair();
  const env = googleEnv({ GOOGLE_SA_PRIVATE_KEY: pem });
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });

  const stub = googleStub();
  await withGoogle(stub.fn, () =>
    worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env));

  const tokenCall = stub.calls.find((c) => c.url === 'https://oauth2.googleapis.com/token');
  assert.ok(tokenCall, 'a token exchange must have happened');
  const params = new URLSearchParams(tokenCall.body);
  assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');

  const jwt = params.get('assertion');
  const { header, claims, verified } = await verifyAndDecodeJwt(jwt, keyPair.publicKey);

  assert.equal(header.alg, 'RS256');
  assert.equal(claims.iss, 'sa@example.iam.gserviceaccount.com');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.ok(claims.exp > claims.iat, 'exp must be after iat');
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(verified, 'the JWT signature must actually verify against the real public key — a malformed signature would silently fail every Google call, not error loudly');
});

// A JWT signed under a DIFFERENT key must not verify against this one — a
// meaningless assertion on its own, but it rules out a verifier that always
// returns true regardless of what it is checking.
test('adversarial: a JWT signed with a different key does not verify against the real public key', async () => {
  const { keyPair } = await makeServiceAccountKeyPair();
  const { pem: otherPem } = await makeServiceAccountKeyPair();
  const env = googleEnv({ GOOGLE_SA_PRIVATE_KEY: otherPem });
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });

  const stub = googleStub();
  await withGoogle(stub.fn, () =>
    worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env));

  const jwt = new URLSearchParams(stub.calls.find((c) => c.url.includes('token')).body).get('assertion');
  const { verified } = await verifyAndDecodeJwt(jwt, keyPair.publicKey); // wrong (real) public key
  assert.equal(verified, false);
});

// ---- upsert-by-row: append for a new voter, update in place for a re-vote ----

test('a first-time voter appends a new row to the Sheet', async () => {
  const { pem } = await makeServiceAccountKeyPair();
  const env = googleEnv({ GOOGLE_SA_PRIVATE_KEY: pem });
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });

  const stub = googleStub({ existingRows: [] });
  await withGoogle(stub.fn, () =>
    worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose', comment: 'nice' }), env));

  const appendCall = stub.calls.find((c) => c.url.includes(':append'));
  assert.ok(appendCall, 'a new voter must append, not update');
  const payload = JSON.parse(appendCall.body);
  const [, pollId, question, choice, comment, email] = payload.values[0];
  assert.deepEqual([pollId, question, choice, comment, email], ['scent', 'Which scent?', 'Rose', 'nice', 'a@b.com']);
  assert.ok(!stub.calls.some((c) => c.method === 'PUT'), 'must not also attempt an update');
});

test('a re-vote already present in the Sheet updates that exact row in place', async () => {
  const { pem } = await makeServiceAccountKeyPair();
  const env = googleEnv({ GOOGLE_SA_PRIVATE_KEY: pem });
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });

  // Row 2 in the sheet (the first data row) already carries this member's
  // prior vote on this poll.
  const stub = googleStub({
    existingRows: [
      ['2024-01-01T00:00:00.000Z', 'scent', 'Which scent?', 'Amber', '', 'a@b.com']
    ]
  });
  await withGoogle(stub.fn, () =>
    worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env));

  const updateCall = stub.calls.find((c) => c.method === 'PUT');
  assert.ok(updateCall, 'an existing voter must update in place, not append a second row');
  assert.ok(decodeURIComponent(updateCall.url).includes('Sheet1!A2:F2'), 'must target the exact row it found, row 2');
  const payload = JSON.parse(updateCall.body);
  assert.equal(payload.values[0][3], 'Rose', 'the row must carry the NEW choice');
  assert.ok(!stub.calls.some((c) => c.url.includes(':append')), 'must not also append a second row');
});

test('a row for a DIFFERENT member on the same poll is not mistaken for this one', async () => {
  const { pem } = await makeServiceAccountKeyPair();
  const env = googleEnv({ GOOGLE_SA_PRIVATE_KEY: pem });
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });

  const stub = googleStub({
    existingRows: [
      ['2024-01-01T00:00:00.000Z', 'scent', 'Which scent?', 'Amber', '', 'someone-else@b.com']
    ]
  });
  await withGoogle(stub.fn, () =>
    worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env));

  assert.ok(stub.calls.some((c) => c.url.includes(':append')), 'a different member\'s row must not block a fresh append');
  assert.ok(!stub.calls.some((c) => c.method === 'PUT'));
});

// ---- token caching -------------------------------------------------------------

test('the access token is cached across votes within its lifetime — one token exchange, two votes', async () => {
  const { pem } = await makeServiceAccountKeyPair();
  const env = googleEnv({ GOOGLE_SA_PRIVATE_KEY: pem });
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });
  await seedClient(env, { email: 'b@b.com', token: 'TOK2', tier: 'vip', stripe_customer_id: 'cus_2' });

  const stub = googleStub();
  await withGoogle(stub.fn, async () => {
    await worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env);
    await worker.fetch(post('/api/polls/vote', { authToken: 'TOK2', pollId: 'scent', choice: 'Amber' }), env);
  });

  const tokenCalls = stub.calls.filter((c) => c.url.includes('oauth2.googleapis.com'));
  assert.equal(tokenCalls.length, 1, 'a cached token must not be re-exchanged for a second vote moments later');
});

test('the access token is re-exchanged once it has actually expired', async () => {
  const { pem } = await makeServiceAccountKeyPair();
  const env = googleEnv({ GOOGLE_SA_PRIVATE_KEY: pem });
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });

  const stub = googleStub();
  const baseTime = freshNow();
  await withFetch(stub.fn, () => withFrozenClock(baseTime, () =>
    worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env)));
  // 2 hours later: well past the 1-hour token lifetime.
  await withFetch(stub.fn, () => withFrozenClock(baseTime + 2 * 60 * 60 * 1000, () =>
    worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Amber' }), env)));

  const tokenCalls = stub.calls.filter((c) => c.url.includes('oauth2.googleapis.com'));
  assert.equal(tokenCalls.length, 2, 'an expired token must be re-exchanged, not reused past its lifetime');
});

// ---- graceful degradation: the vote is never held hostage to Google --------------

test('with no Sheets secrets configured, no Google call is made and the vote still succeeds', async () => {
  const env = env0(); // no GOOGLE_* vars at all
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });

  const stub = googleStub();
  const res = await withGoogle(stub.fn, () =>
    worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env));

  assert.equal(res.status, 200);
  assert.equal(stub.calls.length, 0, 'no GOOGLE_SHEET_ID/GOOGLE_SA_* must mean no outbound call at all');
});

test('a Google token-exchange failure does not fail the vote', async () => {
  const { pem } = await makeServiceAccountKeyPair();
  const env = googleEnv({ GOOGLE_SA_PRIVATE_KEY: pem });
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });

  const res = await withGoogle(async () => new Response('server error', { status: 500 }), () =>
    worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env));

  assert.equal(res.status, 200, 'the vote is real the instant it is in D1 — a Sheets outage must never be reported as a failed vote');
  const row = env.DB._row('SELECT * FROM poll_votes WHERE poll_id = ? AND email = ?', 'scent', 'a@b.com');
  assert.equal(row.choice, 'Rose');
});

test('a malformed private key does not throw and the vote still succeeds', async () => {
  const env = googleEnv({ GOOGLE_SA_PRIVATE_KEY: 'not-a-real-pem-at-all' });
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });

  const stub = googleStub();
  const res = await withGoogle(stub.fn, () =>
    worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env));

  assert.equal(res.status, 200);
  assert.ok(!stub.calls.some((c) => c.url.includes('sheets.googleapis.com')), 'a signing failure must stop before any Sheets call, not attempt one with a bad token');
});

test('a Sheets read (for upsert) failure does not fail the vote', async () => {
  const { pem } = await makeServiceAccountKeyPair();
  const env = googleEnv({ GOOGLE_SA_PRIVATE_KEY: pem });
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });

  const res = await withGoogle(async (url) => {
    const u = String(url);
    if (u === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    return new Response('nope', { status: 500 });
  }, () => worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env));

  assert.equal(res.status, 200);
});

// ---- a duplicate re-vote is idempotent in the Sheet too ------------------------

test('voting the same choice twice in a row still leaves exactly one row in the Sheet (via update, not a duplicate append)', async () => {
  const { pem } = await makeServiceAccountKeyPair();
  const env = googleEnv({ GOOGLE_SA_PRIVATE_KEY: pem });
  await createActivePoll(env);
  await seedClient(env, { tier: 'vip' });

  const sheetRows = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    const decoded = decodeURIComponent(u);
    if (u === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (decoded.includes(':append')) {
      sheetRows.push(JSON.parse(opts.body).values[0]);
      return new Response('{}', { status: 200 });
    }
    if (opts.method === 'PUT') {
      const rowNum = Number(decoded.match(/A(\d+):/)[1]);
      sheetRows[rowNum - 2] = JSON.parse(opts.body).values[0];
      return new Response('{}', { status: 200 });
    }
    if (decoded.includes('/values/Sheet1!A2:F') && (!opts.method || opts.method === 'GET')) {
      return new Response(JSON.stringify({ values: sheetRows }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  await withGoogle(fn, async () => {
    await worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Rose' }), env);
    await worker.fetch(post('/api/polls/vote', { authToken: 'TOK', pollId: 'scent', choice: 'Amber' }), env);
  });

  assert.equal(sheetRows.length, 1, 'the sheet must hold exactly one row per member per poll, same as poll_votes itself');
  assert.equal(sheetRows[0][3], 'Amber');
});
