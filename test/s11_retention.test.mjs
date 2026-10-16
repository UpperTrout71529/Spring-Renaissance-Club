// S11 / spec §13.2: data is kept only as long as the table says — expired
// sessions 30 days after they end, analytics events 13 months; sign-in links,
// passkey challenges and step-up codes once they are spent or expired.
// Run daily by the cron trigger (wrangler.toml [triggers]).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness.mjs';
import { runRetention } from '../src/cron/retention.js';
import worker from '../src/index.js';

const NOW = Date.parse('2026-10-16T03:15:00.000Z');
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

function seed() {
  const env = makeEnv();
  const ex = (sql, ...a) => env.DB._db.prepare(sql).run(...a);
  ex("INSERT INTO users (id, email, created_at) VALUES ('U1','a@example.com',?)", iso(NOW - 400 * DAY));
  const session = (id, { idle, absolute, revoked = null }) => ex(
    "INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, auth_method, revoked_at) VALUES (?, 'U1', ?, ?, ?, ?, 'magic_link', ?)",
    id, iso(NOW - 100 * DAY), iso(NOW - 40 * DAY), iso(idle), iso(absolute), revoked && iso(revoked));
  session('live', { idle: NOW + 10 * DAY, absolute: NOW + 60 * DAY });
  session('idle-31d', { idle: NOW - 31 * DAY, absolute: NOW + 10 * DAY });
  session('idle-29d', { idle: NOW - 29 * DAY, absolute: NOW + 10 * DAY });
  session('abs-31d', { idle: NOW + 5 * DAY, absolute: NOW - 31 * DAY });
  session('revoked-31d', { idle: NOW + 5 * DAY, absolute: NOW + 50 * DAY, revoked: NOW - 31 * DAY });
  session('revoked-2d', { idle: NOW + 5 * DAY, absolute: NOW + 50 * DAY, revoked: NOW - 2 * DAY });
  ex("INSERT INTO step_up_codes (session_id_hash, code_hash, expires_at, created_at) VALUES ('idle-31d', 'h', ?, ?)", iso(NOW - 40 * DAY), iso(NOW - 40 * DAY));
  ex("INSERT INTO step_up_codes (session_id_hash, code_hash, expires_at, created_at) VALUES ('live', 'h', ?, ?)", iso(NOW + 5 * 60000), iso(NOW));

  const link = (hash, expires, used = null) => ex(
    "INSERT INTO magic_links (token_hash, email, purpose, expires_at, used_at, created_at) VALUES (?, 'a@example.com', 'sign_in', ?, ?, ?)",
    hash, iso(expires), used && iso(used), iso(expires - 15 * 60000));
  link('fresh', NOW + 10 * 60000);
  link('expired-2d', NOW - 2 * DAY);
  link('used-2d', NOW + 10 * 60000, NOW - 2 * DAY);
  link('expired-1h', NOW - 3600000);

  const challenge = (c, expires, used = null) => ex(
    "INSERT INTO webauthn_challenges (challenge, purpose, expires_at, used_at, created_at) VALUES (?, 'login', ?, ?, ?)",
    c, iso(expires), used && iso(used), iso(expires - 300000));
  challenge('c-live', NOW + 60000);
  challenge('c-old', NOW - 2 * DAY);

  const ev = (id, at) => ex("INSERT INTO events (id, name, created_at) VALUES (?, 'login_succeeded', ?)", id, iso(at));
  ev('e-new', NOW - DAY);
  ev('e-12m', Date.parse('2025-10-17T00:00:00.000Z'));
  ev('e-13m+', Date.parse('2025-09-15T00:00:00.000Z'));
  return env;
}

const ids = (env, sql) => env.DB._db.prepare(sql).all().map((r) => Object.values(r)[0]).sort();

test('sessions: removed 30 days after they ended (idle, absolute or revoked); live and recent kept', async () => {
  const env = seed();
  await runRetention(env, NOW);
  assert.deepEqual(ids(env, 'SELECT id_hash FROM sessions'), ['idle-29d', 'live', 'revoked-2d']);
});

test("a removed session's step-up code goes with it; a live one stays", async () => {
  const env = seed();
  await runRetention(env, NOW);
  assert.deepEqual(ids(env, 'SELECT session_id_hash FROM step_up_codes'), ['live']);
});

test('sign-in links: removed one day after use or expiry; a fresh or just-expired one stays', async () => {
  const env = seed();
  await runRetention(env, NOW);
  assert.deepEqual(ids(env, 'SELECT token_hash FROM magic_links'), ['expired-1h', 'fresh']);
});

test('passkey challenges: removed a day after expiry', async () => {
  const env = seed();
  await runRetention(env, NOW);
  assert.deepEqual(ids(env, 'SELECT challenge FROM webauthn_challenges'), ['c-live']);
});

test('analytics events: kept 13 months', async () => {
  const env = seed();
  await runRetention(env, NOW);
  assert.deepEqual(ids(env, 'SELECT id FROM events'), ['e-12m', 'e-new']);
});

test('returns counts, and a second run removes nothing', async () => {
  const env = seed();
  const first = await runRetention(env, NOW);
  assert.deepEqual(first, { sessions: 3, step_up_codes: 1, magic_links: 2, webauthn_challenges: 1, events: 1 });
  const second = await runRetention(env, NOW);
  assert.deepEqual(second, { sessions: 0, step_up_codes: 0, magic_links: 0, webauthn_challenges: 0, events: 0 });
});

test('the Worker entry has a scheduled handler that runs the cleanup', async () => {
  const env = seed();
  const pending = [];
  await worker.scheduled({ cron: '15 3 * * *', scheduledTime: NOW }, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.deepEqual(ids(env, 'SELECT id FROM events'), ['e-12m', 'e-new']);
});
