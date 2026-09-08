// ============================================================================
// Step 2: WebAuthn (VIP tier only) — registration and tokenless login.
//
// This builds real WebAuthn-shaped payloads (CBOR attestationObject, raw
// authenticatorData, DER ECDSA signatures) with independently-written
// test-only encoders and a real generated P-256 key pair, then drives the
// actual worker.js endpoints exactly as a browser's navigator.credentials
// API would. The encoders here are deliberately NOT shared code with
// worker.js's own CBOR decoder / DER-to-raw converter — reusing them would
// let an encode+decode bug cancel itself out and hide from every test.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { makeEnv, post, get, seedClient } from './harness.mjs';

const FRONTEND_ORIGIN = 'https://club.springrenaissance.store';
const RP_ID = 'club.springrenaissance.store';

const env0 = (over = {}) => makeEnv({ PORTAL_ORIGIN: FRONTEND_ORIGIN, ...over });

// ---- base64url --------------------------------------------------------------

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (b64.length % 4)) % 4;
  const bin = atob(b64 + '='.repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatAll(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// ---- CBOR encoder (test-only) ------------------------------------------------

function cborHead(majorType, n) {
  const m = majorType << 5;
  if (n < 24) return Uint8Array.of(m | n);
  if (n < 256) return Uint8Array.of(m | 24, n);
  if (n < 65536) return Uint8Array.of(m | 25, (n >> 8) & 0xff, n & 0xff);
  return Uint8Array.of(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function cborUint(n) { return cborHead(0, n); }
function cborNegInt(n) { return cborHead(1, -1 - n); } // n is the real negative value, e.g. -7
function cborBytes(bytes) { return concatAll([cborHead(2, bytes.length), bytes]); }
function cborText(str) {
  const enc = new TextEncoder().encode(str);
  return concatAll([cborHead(3, enc.length), enc]);
}
function cborMap(entries) {
  return concatAll([cborHead(5, entries.length), ...entries.flat()]);
}

function encodeCoseEc2PublicKey(x, y, { alg = -7, crv = 1 } = {}) {
  return cborMap([
    [cborUint(1), cborUint(2)],           // kty: EC2
    [cborUint(3), cborNegInt(alg)],       // alg
    [cborNegInt(-1), cborUint(crv)],      // crv
    [cborNegInt(-2), cborBytes(x)],       // x
    [cborNegInt(-3), cborBytes(y)]        // y
  ]);
}

function buildAttestationObject(authDataBytes) {
  return cborMap([
    [cborText('fmt'), cborText('none')],
    [cborText('attStmt'), cborMap([])],
    [cborText('authData'), cborBytes(authDataBytes)]
  ]);
}

// ---- DER encoder (test-only; the inverse of worker.js's derSignatureToRaw) --

function derLength(len) {
  if (len < 128) return Uint8Array.of(len);
  const bytes = [];
  let n = len;
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function derInteger(bytes) {
  let b = bytes;
  let start = 0;
  while (start < b.length - 1 && b[start] === 0x00) start++;
  b = b.slice(start);
  if (b[0] & 0x80) {
    const withGuard = new Uint8Array(b.length + 1);
    withGuard.set(b, 1);
    b = withGuard;
  }
  return concatAll([Uint8Array.of(0x02), derLength(b.length), b]);
}

function rawSignatureToDer(raw) {
  const body = concatAll([derInteger(raw.slice(0, 32)), derInteger(raw.slice(32, 64))]);
  return concatAll([Uint8Array.of(0x30), derLength(body.length), body]);
}

// ---- authenticatorData -------------------------------------------------------

async function buildAuthenticatorData({ rpId = RP_ID, up, uv, signCount, credentialId = null, cosePublicKeyBytes = null }) {
  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
  let flagsByte = 0;
  if (up) flagsByte |= 0x01;
  if (uv) flagsByte |= 0x04;
  if (credentialId) flagsByte |= 0x40; // AT: attested credential data present

  const signCountBytes = Uint8Array.of(
    (signCount >>> 24) & 0xff, (signCount >>> 16) & 0xff, (signCount >>> 8) & 0xff, signCount & 0xff
  );

  const parts = [rpIdHash, Uint8Array.of(flagsByte), signCountBytes];
  if (credentialId) {
    const credIdLenBytes = Uint8Array.of((credentialId.length >> 8) & 0xff, credentialId.length & 0xff);
    parts.push(new Uint8Array(16), credIdLenBytes, credentialId, cosePublicKeyBytes);
  }
  return concatAll(parts);
}

function buildClientDataJSON({ type, challenge, origin }) {
  return new TextEncoder().encode(JSON.stringify({ type, challenge, origin }));
}

// ---- a full simulated authenticator -----------------------------------------

async function makeAuthenticator() {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const x = b64urlToBytes(jwk.x);
  const y = b64urlToBytes(jwk.y);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  return { keyPair, x, y, credentialId };
}

async function registerCredential(env, authToken, authenticator, { origin = FRONTEND_ORIGIN, type = 'webauthn.create', up = true, uv = true, rpId = RP_ID, coseOverrides = {} } = {}) {
  const optionsRes = await worker.fetch(post('/api/auth/webauthn/register-options', { authToken }), env);
  const options = await optionsRes.json();
  if (optionsRes.status !== 200) return { res: optionsRes, body: options, options };

  const clientDataJSON = buildClientDataJSON({ type, challenge: options.challenge, origin });
  const cosePublicKeyBytes = encodeCoseEc2PublicKey(authenticator.x, authenticator.y, coseOverrides);
  const authData = await buildAuthenticatorData({
    rpId, up, uv, signCount: 0, credentialId: authenticator.credentialId, cosePublicKeyBytes
  });
  const attestationObject = buildAttestationObject(authData);

  const res = await worker.fetch(post('/api/auth/webauthn/register', {
    authToken,
    credentialId: bytesToB64url(authenticator.credentialId),
    clientDataJSON: bytesToB64url(clientDataJSON),
    attestationObject: bytesToB64url(attestationObject)
  }), env);
  return { res, body: await res.json(), options };
}

async function loginWithCredential(env, authenticator, { origin = FRONTEND_ORIGIN, type = 'webauthn.get', up = true, uv = true, rpId = RP_ID, signCount = 1, userHandleEmail, tamperSignature = false, overrideChallenge } = {}) {
  const optionsRes = await worker.fetch(post('/api/auth/webauthn/login-options', {}), env);
  const options = await optionsRes.json();

  const challenge = overrideChallenge !== undefined ? overrideChallenge : options.challenge;
  const clientDataJSON = buildClientDataJSON({ type, challenge, origin });
  const authenticatorData = await buildAuthenticatorData({ rpId, up, uv, signCount });

  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
  const signedData = concatAll([authenticatorData, clientDataHash]);
  const rawSig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, authenticator.keyPair.privateKey, signedData
  ));
  const derSig = tamperSignature ? rawSignatureToDer(new Uint8Array(rawSig.map((b, i) => i === 0 ? b ^ 0xff : b))) : rawSignatureToDer(rawSig);

  const body = {
    credentialId: bytesToB64url(authenticator.credentialId),
    clientDataJSON: bytesToB64url(clientDataJSON),
    authenticatorData: bytesToB64url(authenticatorData),
    signature: bytesToB64url(derSig)
  };
  if (userHandleEmail !== undefined) {
    body.userHandle = bytesToB64url(new TextEncoder().encode(userHandleEmail));
  }

  const res = await worker.fetch(post('/api/auth/webauthn/login', body), env);
  return { res, body: await res.json(), options };
}

// ---- registration: happy path + gating --------------------------------------

test('a VIP can register a Face/Touch ID credential', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();

  const { res, body } = await registerCredential(env, 'TOK', authenticator);
  assert.equal(res.status, 200);
  assert.deepEqual(body, { success: true });

  const row = env.DB._row(
    'SELECT * FROM webauthn_credentials WHERE credential_id = ?', bytesToB64url(authenticator.credentialId)
  );
  assert.equal(row.email, 'a@b.com');
  assert.equal(row.sign_count, 0);
  assert.ok(JSON.parse(row.public_key).x, 'the stored public key must be usable JWK');
});

test('a regular-tier member cannot register a credential', async () => {
  const env = env0();
  await seedClient(env, { tier: 'regular' });
  const authenticator = await makeAuthenticator();

  const { res } = await registerCredential(env, 'TOK', authenticator);
  assert.equal(res.status, 403);
  assert.equal(env.DB._rows('SELECT * FROM webauthn_credentials').length, 0);
});

test('registration requires a live session', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();

  const optionsRes = await worker.fetch(post('/api/auth/webauthn/register-options', { authToken: 'nope' }), env);
  assert.equal(optionsRes.status, 401);
});

test('registration rejects a wrong origin (not the frontend origin)', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();

  const { res } = await registerCredential(env, 'TOK', authenticator, { origin: 'https://evil.example' });
  assert.equal(res.status, 400);
  assert.equal(env.DB._rows('SELECT * FROM webauthn_credentials').length, 0);
});

test('registration rejects the wrong ceremony type', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();

  const { res } = await registerCredential(env, 'TOK', authenticator, { type: 'webauthn.get' });
  assert.equal(res.status, 400);
});

test('registration rejects a wrong rpIdHash (authenticatorData bound to a different site)', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();

  const { res } = await registerCredential(env, 'TOK', authenticator, { rpId: 'evil.example' });
  assert.equal(res.status, 400);
});

test('registration requires user presence', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();

  const { res } = await registerCredential(env, 'TOK', authenticator, { up: false, uv: false });
  assert.equal(res.status, 400);
});

test('registration requires the biometric (UV), not just presence', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();

  const { res } = await registerCredential(env, 'TOK', authenticator, { up: true, uv: false });
  assert.equal(res.status, 400);
});

test('registration rejects a non-ES256 algorithm', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();

  // -257 is RS256 — a real key mismatch would fail differently, but this
  // exercises the alg gate on the COSE key itself, independent of whether a
  // browser could even produce such a combination.
  const { res } = await registerCredential(env, 'TOK', authenticator, { coseOverrides: { alg: -257 } });
  assert.equal(res.status, 400);
});

test('registration rejects an unsupported curve', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();

  const { res } = await registerCredential(env, 'TOK', authenticator, { coseOverrides: { crv: 2 } }); // P-384
  assert.equal(res.status, 400);
});

test('a registration challenge is single-use: replaying the same completed request fails', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();

  const optionsRes = await worker.fetch(post('/api/auth/webauthn/register-options', { authToken: 'TOK' }), env);
  const options = await optionsRes.json();

  const clientDataJSON = buildClientDataJSON({ type: 'webauthn.create', challenge: options.challenge, origin: FRONTEND_ORIGIN });
  const cosePublicKeyBytes = encodeCoseEc2PublicKey(authenticator.x, authenticator.y);
  const authData = await buildAuthenticatorData({ up: true, uv: true, signCount: 0, credentialId: authenticator.credentialId, cosePublicKeyBytes });
  const attestationObject = buildAttestationObject(authData);
  const reqBody = {
    authToken: 'TOK',
    credentialId: bytesToB64url(authenticator.credentialId),
    clientDataJSON: bytesToB64url(clientDataJSON),
    attestationObject: bytesToB64url(attestationObject)
  };

  const first = await worker.fetch(post('/api/auth/webauthn/register', reqBody), env);
  assert.equal(first.status, 200);

  const second = await worker.fetch(post('/api/auth/webauthn/register', reqBody), env);
  assert.equal(second.status, 400);
});

test('a login challenge cannot be spent on the register endpoint (cross-purpose replay)', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();

  const loginOptionsRes = await worker.fetch(post('/api/auth/webauthn/login-options', {}), env);
  const loginOptions = await loginOptionsRes.json();

  const clientDataJSON = buildClientDataJSON({ type: 'webauthn.create', challenge: loginOptions.challenge, origin: FRONTEND_ORIGIN });
  const cosePublicKeyBytes = encodeCoseEc2PublicKey(authenticator.x, authenticator.y);
  const authData = await buildAuthenticatorData({ up: true, uv: true, signCount: 0, credentialId: authenticator.credentialId, cosePublicKeyBytes });
  const attestationObject = buildAttestationObject(authData);

  const res = await worker.fetch(post('/api/auth/webauthn/register', {
    authToken: 'TOK',
    credentialId: bytesToB64url(authenticator.credentialId),
    clientDataJSON: bytesToB64url(clientDataJSON),
    attestationObject: bytesToB64url(attestationObject)
  }), env);
  assert.equal(res.status, 400);
});

test('a stolen challenge cannot be redeemed under a different VIP session', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  await seedClient(env, { email: 'victim@b.com', token: 'VICTOK', tier: 'vip', stripe_customer_id: 'cus_v' });
  const authenticator = await makeAuthenticator();

  // Challenge issued for a@b.com...
  const optionsRes = await worker.fetch(post('/api/auth/webauthn/register-options', { authToken: 'TOK' }), env);
  const options = await optionsRes.json();

  const clientDataJSON = buildClientDataJSON({ type: 'webauthn.create', challenge: options.challenge, origin: FRONTEND_ORIGIN });
  const cosePublicKeyBytes = encodeCoseEc2PublicKey(authenticator.x, authenticator.y);
  const authData = await buildAuthenticatorData({ up: true, uv: true, signCount: 0, credentialId: authenticator.credentialId, cosePublicKeyBytes });
  const attestationObject = buildAttestationObject(authData);

  // ...but redeemed under victim@b.com's session.
  const res = await worker.fetch(post('/api/auth/webauthn/register', {
    authToken: 'VICTOK',
    credentialId: bytesToB64url(authenticator.credentialId),
    clientDataJSON: bytesToB64url(clientDataJSON),
    attestationObject: bytesToB64url(attestationObject)
  }), env);
  assert.equal(res.status, 400);
  assert.equal(env.DB._rows('SELECT * FROM webauthn_credentials').length, 0);
});

test('registration rejects a credentialId that does not match the attested credential', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();

  const optionsRes = await worker.fetch(post('/api/auth/webauthn/register-options', { authToken: 'TOK' }), env);
  const options = await optionsRes.json();

  const clientDataJSON = buildClientDataJSON({ type: 'webauthn.create', challenge: options.challenge, origin: FRONTEND_ORIGIN });
  const cosePublicKeyBytes = encodeCoseEc2PublicKey(authenticator.x, authenticator.y);
  const authData = await buildAuthenticatorData({ up: true, uv: true, signCount: 0, credentialId: authenticator.credentialId, cosePublicKeyBytes });
  const attestationObject = buildAttestationObject(authData);

  const res = await worker.fetch(post('/api/auth/webauthn/register', {
    authToken: 'TOK',
    credentialId: bytesToB64url(crypto.getRandomValues(new Uint8Array(16))), // different id than the attestation
    clientDataJSON: bytesToB64url(clientDataJSON),
    attestationObject: bytesToB64url(attestationObject)
  }), env);
  assert.equal(res.status, 400);
});

// ---- login: happy path + gating ---------------------------------------------

test('a registered VIP can log in with Face/Touch ID and reach a normal session', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator);

  const { res, body } = await loginWithCredential(env, authenticator, { userHandleEmail: 'a@b.com', signCount: 1 });
  assert.equal(res.status, 200);
  assert.deepEqual(body, { success: true, authToken: body.authToken, email: 'a@b.com' });

  const userRes = await worker.fetch(get(`/api/user?auth_token=${body.authToken}`), env);
  assert.equal(userRes.status, 200);
  const userBody = await userRes.json();
  assert.equal(userBody.email, 'a@b.com');
});

test('login works without a userHandle too, identified purely by credentialId', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator);

  const { res, body } = await loginWithCredential(env, authenticator, { signCount: 1 });
  assert.equal(res.status, 200);
  assert.equal(body.email, 'a@b.com');
});

test('login rejects a userHandle that does not match the credential\'s account', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator);

  const { res } = await loginWithCredential(env, authenticator, { userHandleEmail: 'someone-else@b.com', signCount: 1 });
  assert.equal(res.status, 401);
});

test('login rejects an unknown credentialId', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const stranger = await makeAuthenticator(); // never registered

  const { res } = await loginWithCredential(env, stranger, { signCount: 1 });
  assert.equal(res.status, 401);
});

test('login rejects a wrong origin', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator);

  const { res } = await loginWithCredential(env, authenticator, { origin: 'https://evil.example', signCount: 1 });
  assert.equal(res.status, 401);
});

test('login rejects the wrong ceremony type', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator);

  const { res } = await loginWithCredential(env, authenticator, { type: 'webauthn.create', signCount: 1 });
  assert.equal(res.status, 401);
});

test('login rejects a wrong rpIdHash', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator);

  const { res } = await loginWithCredential(env, authenticator, { rpId: 'evil.example', signCount: 1 });
  assert.equal(res.status, 401);
});

test('login rejects a missing biometric (UV) flag', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator);

  const { res } = await loginWithCredential(env, authenticator, { uv: false, signCount: 1 });
  assert.equal(res.status, 401);
});

test('login rejects a tampered signature byte', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator);

  const { res } = await loginWithCredential(env, authenticator, { tamperSignature: true, signCount: 1 });
  assert.equal(res.status, 401);
});

test('a login challenge is single-use: replaying the same completed assertion fails', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator);

  const optionsRes = await worker.fetch(post('/api/auth/webauthn/login-options', {}), env);
  const options = await optionsRes.json();
  const clientDataJSON = buildClientDataJSON({ type: 'webauthn.get', challenge: options.challenge, origin: FRONTEND_ORIGIN });
  const authenticatorData = await buildAuthenticatorData({ up: true, uv: true, signCount: 1 });
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
  const signedData = concatAll([authenticatorData, clientDataHash]);
  const rawSig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, authenticator.keyPair.privateKey, signedData));
  const reqBody = {
    credentialId: bytesToB64url(authenticator.credentialId),
    clientDataJSON: bytesToB64url(clientDataJSON),
    authenticatorData: bytesToB64url(authenticatorData),
    signature: bytesToB64url(rawSignatureToDer(rawSig))
  };

  const first = await worker.fetch(post('/api/auth/webauthn/login', reqBody), env);
  assert.equal(first.status, 200);

  const second = await worker.fetch(post('/api/auth/webauthn/login', reqBody), env);
  assert.equal(second.status, 401, 'the same challenge must not be redeemable twice');
});

test('a register challenge cannot be spent on the login endpoint (cross-purpose replay)', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator);

  const registerOptionsRes = await worker.fetch(post('/api/auth/webauthn/register-options', { authToken: 'TOK' }), env);
  const registerOptions = await registerOptionsRes.json();

  const { res } = await loginWithCredential(env, authenticator, { signCount: 1, overrideChallenge: registerOptions.challenge });
  assert.equal(res.status, 401);
});

test('a demoted-to-regular member can still log in with an existing credential', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator);

  // Demote directly against D1 (the same effect POST /api/admin/set-tier
  // would have) to isolate this test from that endpoint's own auth handling.
  env.DB._db.prepare("UPDATE users SET tier = 'regular' WHERE email = 'a@b.com'").run();

  const { res, body } = await loginWithCredential(env, authenticator, { signCount: 1 });
  assert.equal(res.status, 200);
  assert.equal(body.email, 'a@b.com');
});

test('a cancelled membership cannot use WebAuthn to re-enter the portal', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator);

  env.DB._db.prepare("UPDATE users SET status = 'Canceled' WHERE email = 'a@b.com'").run();

  const { res } = await loginWithCredential(env, authenticator, { signCount: 1 });
  assert.equal(res.status, 401);
});

// ---- sign_count clone detection ----------------------------------------------

test('sign_count must strictly increase once an authenticator reports a nonzero counter', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator);

  const first = await loginWithCredential(env, authenticator, { signCount: 5 });
  assert.equal(first.res.status, 200);

  // A second assertion reporting a count that did not advance past 5 looks
  // like two authenticators answering for the same credential.
  const replay = await loginWithCredential(env, authenticator, { signCount: 5 });
  assert.equal(replay.res.status, 401);

  const regressed = await loginWithCredential(env, authenticator, { signCount: 3 });
  assert.equal(regressed.res.status, 401);

  const advanced = await loginWithCredential(env, authenticator, { signCount: 6 });
  assert.equal(advanced.res.status, 200);
});

test('an authenticator that never implements a counter (always 0) is not penalised for it', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator); // stored sign_count starts at 0

  const first = await loginWithCredential(env, authenticator, { signCount: 0 });
  assert.equal(first.res.status, 200);

  const second = await loginWithCredential(env, authenticator, { signCount: 0 });
  assert.equal(second.res.status, 200, 'signCount 0 must never be treated as a regression');
});

// ---- register-options shape --------------------------------------------------

test('register-options excludes already-registered credentials and scopes to platform + resident keys', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator);

  const res = await worker.fetch(post('/api/auth/webauthn/register-options', { authToken: 'TOK' }), env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.rp.id, RP_ID);
  assert.deepEqual(body.pubKeyCredParams, [{ type: 'public-key', alg: -7 }]);
  assert.equal(body.authenticatorSelection.residentKey, 'required');
  assert.equal(body.authenticatorSelection.userVerification, 'required');
  assert.deepEqual(body.excludeCredentials, [{ type: 'public-key', id: bytesToB64url(authenticator.credentialId) }]);
});

test('/api/user response shape is unaffected by WebAuthn login', async () => {
  const env = env0();
  await seedClient(env, { tier: 'vip' });
  const authenticator = await makeAuthenticator();
  await registerCredential(env, 'TOK', authenticator);

  const { body } = await loginWithCredential(env, authenticator, { signCount: 1 });
  const userRes = await worker.fetch(get(`/api/user?auth_token=${body.authToken}`), env);
  const userBody = await userRes.json();
  assert.deepEqual(Object.keys(userBody).sort(), ['email', 'skipped', 'status', 'tokens', 'updatedAt']);
});
