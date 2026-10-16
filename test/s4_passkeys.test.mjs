// S4: passkeys (register, sign in without an email, list, remove) and step-up
// (passkey or 6-digit email code). WebAuthn responses come from a software
// authenticator and are verified by @simplewebauthn/server unmodified.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { post, get } from './harness.mjs';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { sixDigitCode } from '../src/auth/step-up.js';
import { createSoftAuthenticator } from './soft-authenticator.mjs';
import { CLUB, T0, MIN, HOUR, trusted, setup, signIn, sessionToken, body } from './api-helpers.mjs';

const del = (path, headers = {}) => new Request('https://w.dev' + path, { method: 'DELETE', headers });

async function account(t, email = 'clara@example.com') {
  const { res, cookie } = await signIn(t, email);
  const user = (await body(res)).user;
  const as = (extra = {}) => ({ ...trusted, Cookie: cookie, ...extra });
  return { user, cookie, as };
}

async function addPasskey(t, a, auth, extra = {}) {
  const options = await body(await t.call(post('/api/auth/passkey/register/options', {}, a.as())));
  const response = await auth.register(options);
  return t.call(post('/api/auth/passkey/register/verify', { response, ...extra }, a.as()));
}

async function passkeyLogin(t, auth, opts = {}) {
  const options = await body(await t.call(post('/api/auth/passkey/login/options', {}, trusted)));
  const response = await auth.authenticate(options, opts);
  return { res: await t.call(post('/api/auth/passkey/login/verify', { response }, trusted)), response };
}

function lastCode(t) {
  const mail = t.world.emails.filter((e) => e.subject === 'Your confirmation code').at(-1);
  return /\b(\d{6})\b/.exec(mail.text)[1];
}

const sendCode = (t, a) => t.call(post('/api/auth/step-up/email-code', {}, a.as()));
const verifyCode = (t, a, code) => t.call(post('/api/auth/step-up/verify', { code }, a.as()));

// ---- registration --------------------------------------------------------

test('S4-1: registration options follow §10.3', async () => {
  const t = setup();
  const a = await account(t);
  const res = await t.call(post('/api/auth/passkey/register/options', {}, a.as()));
  assert.equal(res.status, 200);
  const o = await body(res);
  assert.deepEqual(o.rp, { name: 'Spring Renaissance', id: 'springrenaissance.store' });
  assert.equal(o.user.name, 'clara@example.com');
  assert.equal(Buffer.from(o.user.id, 'base64url').toString(), a.user.id);
  assert.equal(o.attestation, 'none');
  assert.equal(o.authenticatorSelection.residentKey, 'preferred');
  assert.equal(o.authenticatorSelection.userVerification, 'required');
  assert.deepEqual(o.excludeCredentials, []);
  assert.equal(t.rows("SELECT purpose FROM webauthn_challenges")[0].purpose, 'register');
});

test('S4-2: a verified registration stores the passkey and answers 201', async () => {
  const t = setup();
  const a = await account(t);
  const auth = await createSoftAuthenticator();
  const res = await addPasskey(t, a, auth, { device_label: 'Clara’s iPhone' });
  assert.equal(res.status, 201);
  const { passkey } = await body(res);
  assert.equal(passkey.credential_id, auth.id);
  assert.equal(passkey.device_label, 'Clara’s iPhone');
  const [row] = t.rows('SELECT * FROM passkeys');
  assert.equal(row.user_id, a.user.id);
  assert.equal(row.sign_count, 0);
  assert.deepEqual(JSON.parse(row.transports), ['internal']);
  assert.equal(t.rows("SELECT COUNT(*) AS n FROM events WHERE name = 'passkey_added'")[0].n, 1);

  // The next options exclude it.
  const o = await body(await t.call(post('/api/auth/passkey/register/options', {}, a.as())));
  assert.deepEqual(o.excludeCredentials.map((c) => c.id), [auth.id]);
});

test('S4-3: a registration challenge works once', async () => {
  const t = setup();
  const a = await account(t);
  const auth = await createSoftAuthenticator();
  const options = await body(await t.call(post('/api/auth/passkey/register/options', {}, a.as())));
  const response = await auth.register(options);
  assert.equal((await t.call(post('/api/auth/passkey/register/verify', { response }, a.as()))).status, 201);
  const again = await t.call(post('/api/auth/passkey/register/verify', { response }, a.as()));
  assert.equal(again.status, 400);
  assert.equal((await body(again)).error.code, 'challenge_expired');
});

test('S4-4: wrong origin, wrong RP ID or no user verification → passkey_invalid', async () => {
  for (const opts of [{ originOverride: 'https://evil.example' }, { rpIdOverride: 'evil.example' }, { uv: false }]) {
    const t = setup();
    const a = await account(t);
    const auth = await createSoftAuthenticator();
    const options = await body(await t.call(post('/api/auth/passkey/register/options', {}, a.as())));
    const response = await auth.register(options, opts);
    const res = await t.call(post('/api/auth/passkey/register/verify', { response }, a.as()));
    assert.equal(res.status, 400, JSON.stringify(opts));
    assert.equal((await body(res)).error.code, 'passkey_invalid');
    assert.equal(t.rows('SELECT COUNT(*) AS n FROM passkeys')[0].n, 0);
  }
});

test('S4-5: a challenge issued to one user cannot register a key for another', async () => {
  const t = setup();
  const clara = await account(t, 'clara@example.com');
  t.setNow(T0 + 11 * MIN);
  const david = await account(t, 'david@example.com');
  const auth = await createSoftAuthenticator();
  const options = await body(await t.call(post('/api/auth/passkey/register/options', {}, clara.as())));
  const response = await auth.register(options);
  const res = await t.call(post('/api/auth/passkey/register/verify', { response }, david.as()));
  assert.equal(res.status, 400);
  assert.equal(t.rows('SELECT COUNT(*) AS n FROM passkeys')[0].n, 0);
});

test('S4-6: at most 10 passkeys per user', async () => {
  const t = setup();
  const a = await account(t);
  for (let i = 0; i < 10; i++) assert.equal((await addPasskey(t, a, await createSoftAuthenticator())).status, 201);
  const res = await t.call(post('/api/auth/passkey/register/options', {}, a.as()));
  assert.equal(res.status, 409);
  assert.equal((await body(res)).error.code, 'passkey_limit');
});

test('S4-7: registration needs a session and the portal origin', async () => {
  const t = setup();
  assert.equal((await t.call(post('/api/auth/passkey/register/options', {}, trusted))).status, 401);
  const a = await account(t);
  const evil = await t.call(post('/api/auth/passkey/register/options', {}, { ...a.as(), Origin: 'https://evil.example' }));
  assert.equal(evil.status, 403);
});

// ---- sign-in -------------------------------------------------------------

test('S4-8: sign in with a passkey and no email → session cookie, /api/me works', async () => {
  const t = setup();
  const a = await account(t);
  const auth = await createSoftAuthenticator();
  await addPasskey(t, a, auth);

  t.setNow(T0 + 2 * HOUR);
  const options = await body(await t.call(post('/api/auth/passkey/login/options', {}, trusted)));
  assert.equal(options.rpId, 'springrenaissance.store');
  assert.equal(options.userVerification, 'required');
  assert.deepEqual(options.allowCredentials ?? [], []);

  const response = await auth.authenticate(options);
  const res = await t.call(post('/api/auth/passkey/login/verify', { response }, trusted));
  assert.equal(res.status, 200);
  assert.equal((await body(res)).user.id, a.user.id);
  const token = sessionToken(res);
  assert.ok(token);
  const me = await t.call(get('/api/me', { Cookie: `${SESSION_COOKIE}=${token}` }));
  assert.equal((await body(me)).user.email, 'clara@example.com');

  const sessions = t.rows('SELECT auth_method FROM sessions ORDER BY created_at');
  assert.deepEqual(sessions.map((s) => s.auth_method), ['magic_link', 'passkey']);
  const [pk] = t.rows('SELECT sign_count, last_used_at FROM passkeys');
  assert.equal(pk.sign_count, 1);
  assert.equal(pk.last_used_at, new Date(T0 + 2 * HOUR).toISOString());
  const ev = t.rows("SELECT props_json FROM events WHERE name = 'login_succeeded' ORDER BY created_at DESC LIMIT 1");
  assert.deepEqual(JSON.parse(ev[0].props_json), { method: 'passkey', is_first: false });
});

test('S4-9: a login assertion cannot be replayed', async () => {
  const t = setup();
  const a = await account(t);
  const auth = await createSoftAuthenticator();
  await addPasskey(t, a, auth);
  const { res, response } = await passkeyLogin(t, auth);
  assert.equal(res.status, 200);
  const again = await t.call(post('/api/auth/passkey/login/verify', { response }, trusted));
  assert.equal(again.status, 400);
  assert.equal((await body(again)).error.code, 'challenge_expired');
});

test('S4-10: unknown key, wrong user handle, deleted user → passkey_invalid', async () => {
  const t = setup();
  const a = await account(t);
  const auth = await createSoftAuthenticator();
  await addPasskey(t, a, auth);

  const stranger = await createSoftAuthenticator();
  await stranger.register({ challenge: 'x', user: { id: Buffer.from('nobody').toString('base64url') } });
  assert.equal((await passkeyLogin(t, stranger)).res.status, 400);

  const forged = await passkeyLogin(t, auth, { userHandleOverride: Buffer.from('01OTHER').toString('base64url') });
  assert.equal(forged.res.status, 400);

  t.env.DB._db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(new Date(T0).toISOString(), a.user.id);
  const gone = await passkeyLogin(t, auth);
  assert.equal(gone.res.status, 400);
  assert.equal((await body(gone.res)).error.code, 'passkey_invalid');
});

test('S4-11: login options are identical whether or not an email has passkeys', async () => {
  const t = setup();
  const a = await account(t);
  await addPasskey(t, a, await createSoftAuthenticator());
  const shape = async (email) => {
    const o = await body(await t.call(post('/api/auth/passkey/login/options', { email }, trusted)));
    delete o.challenge;
    return o;
  };
  assert.deepEqual(await shape('clara@example.com'), await shape('nobody@example.com'));
});

// ---- list and remove -----------------------------------------------------

test('S4-12: GET /api/passkeys lists only my keys, without key material', async () => {
  const t = setup();
  const clara = await account(t, 'clara@example.com');
  await addPasskey(t, clara, await createSoftAuthenticator());
  t.setNow(T0 + 11 * MIN);
  const david = await account(t, 'david@example.com');
  await addPasskey(t, david, await createSoftAuthenticator());
  const res = await t.call(get('/api/passkeys', { Cookie: clara.cookie }));
  const { passkeys } = await body(res);
  assert.equal(passkeys.length, 1);
  assert.deepEqual(Object.keys(passkeys[0]).sort(), ['backed_up', 'created_at', 'credential_id', 'device_label', 'last_used_at']);
});

test('S4-13: removing a passkey requires a fresh step-up', async () => {
  const t = setup();
  const a = await account(t);
  const auth = await createSoftAuthenticator();
  await addPasskey(t, a, auth);
  const path = `/api/passkeys/${auth.id}`;

  const blocked = await t.call(del(path, a.as()));
  assert.equal(blocked.status, 403);
  assert.equal((await body(blocked)).error.code, 'step_up_required');

  await sendCode(t, a);
  assert.equal((await verifyCode(t, a, lastCode(t))).status, 204);
  assert.equal((await t.call(del(path, a.as()))).status, 204);
  assert.equal(t.rows('SELECT COUNT(*) AS n FROM passkeys')[0].n, 0);
  assert.equal((await t.call(del(path, a.as()))).status, 404);
});

test('S4-14: step-up lasts 15 minutes', async () => {
  const t = setup();
  const a = await account(t);
  const k1 = await createSoftAuthenticator();
  const k2 = await createSoftAuthenticator();
  await addPasskey(t, a, k1);
  await addPasskey(t, a, k2);
  await sendCode(t, a);
  await verifyCode(t, a, lastCode(t));
  t.setNow(T0 + 15 * MIN);
  assert.equal((await t.call(del(`/api/passkeys/${k1.id}`, a.as()))).status, 204);
  t.setNow(T0 + 15 * MIN + 1);
  assert.equal((await t.call(del(`/api/passkeys/${k2.id}`, a.as()))).status, 403);
});

test("S4-15: nobody can remove someone else's passkey", async () => {
  const t = setup();
  const clara = await account(t, 'clara@example.com');
  const auth = await createSoftAuthenticator();
  await addPasskey(t, clara, auth);
  t.setNow(T0 + 11 * MIN);
  const david = await account(t, 'david@example.com');
  await sendCode(t, david);
  await verifyCode(t, david, lastCode(t));
  assert.equal((await t.call(del(`/api/passkeys/${auth.id}`, david.as()))).status, 404);
  assert.equal(t.rows('SELECT COUNT(*) AS n FROM passkeys')[0].n, 1);
});

// ---- step-up by email code -----------------------------------------------

test('S4-16: the code email carries six digits; D1 keeps only a hash', async () => {
  const t = setup();
  const a = await account(t);
  const res = await sendCode(t, a);
  assert.equal(res.status, 202);
  const mail = t.world.emails.at(-1);
  assert.equal(mail.subject, 'Your confirmation code');
  assert.deepEqual(mail.to, ['clara@example.com']);
  const code = lastCode(t);
  assert.match(mail.text, /works for 10 minutes/);
  const [row] = t.rows('SELECT * FROM step_up_codes');
  assert.ok(!JSON.stringify(row).includes(code));
  assert.equal(row.expires_at, new Date(T0 + 10 * MIN).toISOString());
});

test('S4-17: a wrong code → code_incorrect; the right one → 204 and step_up_at', async () => {
  const t = setup();
  const a = await account(t);
  await sendCode(t, a);
  const code = lastCode(t);
  const wrong = code === '000000' ? '000001' : '000000';
  const bad = await verifyCode(t, a, wrong);
  assert.equal(bad.status, 400);
  assert.equal((await body(bad)).error.code, 'code_incorrect');
  assert.equal((await verifyCode(t, a, code)).status, 204);
  assert.equal(t.rows('SELECT step_up_at FROM sessions WHERE step_up_at IS NOT NULL').length, 1);
  // Spent: the same code does not work twice.
  assert.equal((await body(await verifyCode(t, a, code))).error.code, 'code_expired');
});

test('S4-18: five attempts per code — the sixth fails even with the right code', async () => {
  const t = setup();
  const a = await account(t);
  await sendCode(t, a);
  const code = lastCode(t);
  const wrong = code === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) assert.equal((await verifyCode(t, a, wrong)).status, 400);
  const sixth = await verifyCode(t, a, code);
  assert.equal(sixth.status, 429);
  assert.equal((await body(sixth)).error.code, 'too_many_attempts');
  // A new code resets the count.
  await sendCode(t, a);
  assert.equal((await verifyCode(t, a, lastCode(t))).status, 204);
});

test('S4-19: parallel guesses cannot exceed five attempts', async () => {
  const t = setup({ envOverrides: { interleave: true } });
  const a = await account(t);
  await sendCode(t, a);
  const code = lastCode(t);
  const wrong = code === '111111' ? '222222' : '111111';
  await Promise.all(Array.from({ length: 12 }, () => verifyCode(t, a, wrong)));
  assert.equal(t.rows('SELECT attempts FROM step_up_codes')[0].attempts, 5);
});

test('S4-20: a code expires after 10 minutes', async () => {
  const t = setup();
  const a = await account(t);
  await sendCode(t, a);
  const code = lastCode(t);
  t.setNow(T0 + 10 * MIN);
  const res = await verifyCode(t, a, code);
  assert.equal(res.status, 400);
  assert.equal((await body(res)).error.code, 'code_expired');
});

test("S4-21: a code belongs to the session that asked for it", async () => {
  const t = setup();
  const a = await account(t);
  await sendCode(t, a);
  const code = lastCode(t);
  const other = await account(t); // same user, second session
  assert.equal((await verifyCode(t, other, code)).status, 400);
  assert.equal((await verifyCode(t, a, code)).status, 204);
});

test('S4-22: at most 5 codes per user per hour', async () => {
  const t = setup();
  const a = await account(t);
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await sendCode(t, a)).status);
  assert.deepEqual(statuses, [202, 202, 202, 202, 202, 429]);
});

// ---- step-up by passkey --------------------------------------------------

test("S4-23: step-up with a passkey: options list only the user's keys; success → 204", async () => {
  const t = setup();
  const a = await account(t);
  const auth = await createSoftAuthenticator();
  await addPasskey(t, a, auth);
  const options = await body(await t.call(post('/api/auth/step-up/passkey/options', {}, a.as())));
  assert.deepEqual(options.allowCredentials.map((c) => c.id), [auth.id]);
  const passkey_response = await auth.authenticate(options);
  assert.equal((await t.call(post('/api/auth/step-up/verify', { passkey_response }, a.as()))).status, 204);
  assert.equal((await t.call(del(`/api/passkeys/${auth.id}`, a.as()))).status, 204);
});

test('S4-24: a step-up challenge is bound to its session and cannot sign in', async () => {
  const t = setup();
  const a = await account(t);
  const auth = await createSoftAuthenticator();
  await addPasskey(t, a, auth);
  const options = await body(await t.call(post('/api/auth/step-up/passkey/options', {}, a.as())));
  const assertion = await auth.authenticate(options);

  const login = await t.call(post('/api/auth/passkey/login/verify', { response: assertion }, trusted));
  assert.equal(login.status, 400);
  const other = await account(t); // same user, another session, challenge still fresh
  const res = await t.call(post('/api/auth/step-up/verify', { passkey_response: assertion }, other.as()));
  assert.equal(res.status, 400);
  assert.equal((await body(res)).error.code, 'challenge_expired');
});

test('S4-25: step-up with a passkey when the user has none → 409 no_passkeys', async () => {
  const t = setup();
  const a = await account(t);
  const res = await t.call(post('/api/auth/step-up/passkey/options', {}, a.as()));
  assert.equal(res.status, 409);
  assert.equal((await body(res)).error.code, 'no_passkeys');
});

test('S4-26: sixDigitCode is always six digits', () => {
  for (let i = 0; i < 200; i++) assert.match(sixDigitCode(), /^\d{6}$/);
  assert.equal(sixDigitCode(() => new Uint8Array([0, 0, 0, 7])), '000007');
  // Values at or above the rejection limit are redrawn.
  let calls = 0;
  const code = sixDigitCode(() => (calls++ === 0 ? new Uint8Array([255, 255, 255, 255]) : new Uint8Array([0, 0, 0, 42])));
  assert.equal(code, '000042');
  assert.equal(calls, 2);
});
