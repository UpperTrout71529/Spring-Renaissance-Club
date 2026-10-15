// S1: migrations apply to a clean database and to the existing production
// shape (baseline 0000 with data in it), without losing legacy rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, applyMigrations } from './harness.mjs';

const SPEC_TABLES = [
  'users', 'sessions', 'passkeys', 'oauth_identities', 'consents', 'magic_links',
  'wishlist_items', 'holds',
  'webhook_events', 'email_log', 'events', 'admin_audit',
];
const LEGACY_TABLES = ['legacy_users', 'chat_sessions', 'chat_messages', 'processed_events', 'rate_events'];

function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all().map((r) => r.name).sort();
}

function columns(db, table) {
  return db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name);
}

test('S1-M1: migrations are numbered, start at the baseline, and have no gaps', () => {
  const names = MIGRATIONS.map((m) => m.name);
  assert.equal(names[0], '0000_baseline.sql');
  names.forEach((n, i) => assert.match(n, new RegExp(`^${String(i).padStart(4, '0')}_[a-z0-9_]+\\.sql$`)));
});

test('S1-M2: a clean database ends with every spec V1 table and every legacy table', () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  const have = tables(db);
  for (const t of [...SPEC_TABLES, ...LEGACY_TABLES]) assert.ok(have.includes(t), `missing table ${t}`);
});

test('S1-M3: the existing database (baseline with data) migrates forward and keeps its rows', () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, MIGRATIONS.slice(0, 1));
  db.prepare(
    `INSERT INTO users (email, status, credits, stripe_customer_id, updated_at)
     VALUES ('legacy@b.com', 'Active', 40, 'cus_1', 1)`
  ).run();
  db.prepare("INSERT INTO processed_events (event_id, event_type, processed_at) VALUES ('evt_1', 'x', 1)").run();

  applyMigrations(db, MIGRATIONS.slice(1));

  const legacy = db.prepare('SELECT email, credits, stripe_customer_id FROM legacy_users').all();
  assert.deepEqual(legacy.map((r) => ({ ...r })), [{ email: 'legacy@b.com', credits: 40, stripe_customer_id: 'cus_1' }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM processed_events').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  // The legacy customer index followed the table.
  const idx = db.prepare("SELECT tbl_name FROM sqlite_master WHERE name = 'idx_legacy_users_customer'").get();
  assert.equal(idx.tbl_name, 'legacy_users');
});

test('S1-M4: the spec users table has the spec columns and a club/vip tier', () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  assert.deepEqual(columns(db, 'users'), [
    'id', 'email', 'email_verified_at', 'first_name', 'last_name', 'shopify_customer_id',
    'stripe_customer_id', 'tier', 'seasonal_email_opt_in', 'circle_teaser_snoozed_until',
    'onboarding_dismissed_at', 'created_at', 'last_login_at', 'deleted_at',
  ]);
  const now = '2026-10-15T00:00:00.000Z';
  db.prepare("INSERT INTO users (id, email, created_at) VALUES ('U1', 'A@B.com', ?)").run(now);
  assert.equal(db.prepare('SELECT tier FROM users').get().tier, 'club');
  assert.throws(() => db.prepare("UPDATE users SET tier = 'regular'").run(), /CHECK/);
  // Email is unique regardless of case: one account per address.
  assert.throws(() => db.prepare("INSERT INTO users (id, email, created_at) VALUES ('U2', 'a@b.com', ?)").run(now), /UNIQUE/);
});

test('S1-M5: sessions and magic links reference users and enforce their enums', () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  const now = '2026-10-15T00:00:00.000Z';
  assert.throws(() => db.prepare(
    `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, auth_method)
     VALUES ('h', 'nobody', ?1, ?1, ?1, ?1, 'magic_link')`
  ).run(now), /FOREIGN KEY/);
  assert.throws(() => db.prepare(
    `INSERT INTO magic_links (token_hash, email, purpose, expires_at, created_at) VALUES ('t', 'a@b.com', 'other', ?1, ?1)`
  ).run(now), /CHECK/);
});
