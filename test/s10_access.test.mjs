// S10 acceptance: the admin is behind Cloudflare Access (spec §12, P0.8).
// Every /api/admin/* and /admin request needs a valid Cf-Access-Jwt-Assertion
// (RS256, signed by the team's key, our AUD, our issuer, not expired) whose
// email is in ADMIN_EMAILS — otherwise 403, even when the request goes
// straight to the Worker past Access.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from './harness.mjs';
import { HOUR, makeWorld, setup, body } from './api-helpers.mjs';
import { ADMIN, accessEnv, makeAccess, withAccess } from './access-helpers.mjs';
import { _resetAccessKeys } from '../src/admin/access.js';

async function rig(envOverrides = accessEnv) {
  _resetAccessKeys();
  const access = await makeAccess();
  const t = setup({ world: withAccess(makeWorld(), access), envOverrides });
  return { t, access };
}
const asAdmin = (jwt, path = '/api/admin/members') => get(path, { 'Cf-Access-Jwt-Assertion': jwt });

test('no Access JWT → 403 on a direct /api/admin request', async () => {
  const { t } = await rig();
  const res = await t.call(get('/api/admin/members'));
  assert.equal(res.status, 403);
  assert.equal((await body(res)).error.code, 'admin_forbidden');
});

test('a valid JWT for an email in ADMIN_EMAILS → 200', async () => {
  const { t, access } = await rig();
  const res = await t.call(asAdmin(await access.sign()));
  assert.equal(res.status, 200);
});

test('ADMIN_EMAILS matches case-insensitively and ignores spaces', async () => {
  const { t, access } = await rig();
  const res = await t.call(asAdmin(await access.sign({ email: 'second@EXAMPLE.com' })));
  assert.equal(res.status, 200);
});

test('a valid JWT for an email not in ADMIN_EMAILS → 403', async () => {
  const { t, access } = await rig();
  const res = await t.call(asAdmin(await access.sign({ email: 'someone@example.com' })));
  assert.equal(res.status, 403);
});

test('a service token (no email claim) → 403', async () => {
  const { t, access } = await rig();
  const res = await t.call(asAdmin(await access.sign({ email: undefined, common_name: 'svc.access' })));
  assert.equal(res.status, 403);
});

test('a JWT signed by another key → 403', async () => {
  const { t, access } = await rig();
  const res = await t.call(asAdmin(await access.sign({}, { key: await access.otherKey() })));
  assert.equal(res.status, 403);
});

test('a tampered payload → 403', async () => {
  const { t, access } = await rig();
  const [h, , s] = (await access.sign({ email: 'someone@example.com' })).split('.');
  const [, p] = (await access.sign()).split('.');
  const res = await t.call(asAdmin(`${h}.${p}.${s}`));
  assert.equal(res.status, 403);
});

test('wrong audience, wrong issuer, expired, not yet valid → 403', async () => {
  const { t, access } = await rig();
  const nowS = Math.floor(Date.parse('2026-10-15T12:00:00.000Z') / 1000);
  for (const claims of [
    { aud: ['another-app'] },
    { iss: 'https://evil.cloudflareaccess.com' },
    { exp: nowS - 120 },
    { nbf: nowS + 600 },
  ]) {
    const res = await t.call(asAdmin(await access.sign(claims)));
    assert.equal(res.status, 403, JSON.stringify(claims));
  }
});

test('alg other than RS256 (e.g. none) → 403', async () => {
  const { t, access } = await rig();
  const [, p] = (await access.sign()).split('.');
  const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'kid-1' })).toString('base64url');
  assert.equal((await t.call(asAdmin(`${none}.${p}.`))).status, 403);
  const hs = await access.sign({}, { header: { alg: 'HS256' } });
  assert.equal((await t.call(asAdmin(hs))).status, 403);
});

test('garbage in the header → 403, not 500', async () => {
  const { t } = await rig();
  for (const jwt of ['x', 'a.b.c', '...', 'e30.e30.']) {
    assert.equal((await t.call(asAdmin(jwt))).status, 403, jwt);
  }
});

test('fails closed when Access is not configured (no team domain, AUD or ADMIN_EMAILS)', async () => {
  for (const missing of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ADMIN_EMAILS']) {
    const { t, access } = await rig({ ...accessEnv, [missing]: undefined });
    const res = await t.call(asAdmin(await access.sign()));
    assert.equal(res.status, 403, missing);
  }
});

test('the team keys are cached, and refetched once for an unknown kid (key rotation)', async () => {
  const { t, access } = await rig();
  await t.call(asAdmin(await access.sign()));
  await t.call(asAdmin(await access.sign()));
  assert.equal(access.certFetches, 1);
  const res = await t.call(asAdmin(await access.sign({}, { header: { kid: 'kid-unknown' } })));
  assert.equal(res.status, 403);
  assert.equal(access.certFetches, 2);
});

test('the keys cache expires after an hour', async () => {
  const { t, access } = await rig();
  await t.call(asAdmin(await access.sign()));
  t.setNow(Date.parse('2026-10-15T12:00:00.000Z') + HOUR + 1000);
  await t.call(asAdmin(await access.sign({ exp: Math.floor(Date.parse('2026-10-15T14:00:00.000Z') / 1000) })));
  assert.equal(access.certFetches, 2);
});

test('the certs endpoint failing → 403 (fail closed), not 500', async () => {
  _resetAccessKeys();
  const access = await makeAccess();
  const world = makeWorld();
  const inner = world.fetch;
  world.fetch = async (url, init) => (String(url).includes('/cdn-cgi/access/certs') ? new Response('', { status: 502 }) : inner(url, init));
  const t = setup({ world, envOverrides: accessEnv });
  assert.equal((await t.call(asAdmin(await access.sign()))).status, 403);
});

test('every /api/admin route is gated, not just one', async () => {
  const { t } = await rig();
  for (const path of ['/api/admin/members', '/api/admin/members/01X', '/api/admin/metrics', '/api/admin/webhooks',
    '/api/admin/emails', '/api/admin/audit', '/admin', '/admin/', '/admin/admin.js']) {
    const res = await t.call(get(path));
    assert.equal(res.status, 403, path);
  }
});

test('the admin email is not taken from any header other than the verified JWT', async () => {
  const { t } = await rig();
  const res = await t.call(get('/api/admin/members', { 'Cf-Access-Authenticated-User-Email': ADMIN }));
  assert.equal(res.status, 403);
});
