// ============================================================================
// Test harness: D1 + KV emulation.
//
// The D1 mock implements exactly the surface worker.js uses and nothing more:
//   prepare(sql).bind(...).run()   -> { success, meta: { changes, last_row_id } }
//   prepare(sql).bind(...).first() -> first row or null
//   prepare(sql).bind(...).all()   -> { results: [...] }
//   batch([stmt, ...])             -> results array, all-or-nothing
//
// It applies the repository's own schema.sql rather than a private copy, so a
// schema that drifts from the code fails the suite instead of passing quietly.
// Same principle as the client suite reading the real index.html.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
const SCHEMA_SQL = readFileSync(join(REPO_ROOT, 'schema.sql'), 'utf8');

// Forces a full macrotask turn before a statement runs. Without it, this
// emulator is too well-behaved to expose a lost update: everything resolves on
// the microtask queue and concurrent handlers end up effectively serialized, so
// a read-modify-write can pass a concurrency test it would fail in production
// against a real D1. With it, twenty concurrent SELECT-then-UPDATE sequences
// interleave every time.
const yieldTurn = () => new Promise((r) => setTimeout(r, 0));

class MockStatement {
  constructor(db, sql, interleave = false) {
    this.db = db;
    this.sql = sql;
    this.args = [];
    this.interleave = interleave;
  }

  bind(...args) {
    // D1's bind() returns a new bound statement; batch() holds several at once,
    // so sharing mutable state between them would cross the wires.
    const next = new MockStatement(this.db, this.sql, this.interleave);
    next.args = args.map(normalizeBindValue);
    return next;
  }

  _prepared() {
    return this.db.prepare(this.sql);
  }

  // Synchronous core. batch() must not await between BEGIN and COMMIT: this
  // mock shares one DatabaseSync connection, so an await there lets a second
  // batch interleave and SQLite rejects the nested BEGIN. Real D1 runs each
  // batch as its own server-side transaction and has no such constraint, so
  // this is a property of the emulation, not of the code under test.
  runSync() {
    const info = this._prepared().run(...this.args);
    return {
      success: true,
      meta: {
        changes: Number(info.changes) || 0,
        last_row_id: Number(info.lastInsertRowid) || 0
      }
    };
  }

  async run() {
    if (this.interleave) await yieldTurn();
    return this.runSync();
  }

  async first(column) {
    if (this.interleave) await yieldTurn();
    const row = this._prepared().get(...this.args);
    if (row === undefined) return null;
    return column === undefined ? row : row[column];
  }

  async all() {
    if (this.interleave) await yieldTurn();
    return { success: true, results: this._prepared().all(...this.args) };
  }
}

// node:sqlite rejects booleans and undefined; D1 accepts them.
function normalizeBindValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

// interleave: yield a macrotask before every standalone statement, so
// concurrent handlers genuinely interleave. batch() is exempt by construction —
// it uses runSync and never yields mid-transaction, matching D1's guarantee.
export function makeDB({ interleave = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);

  return {
    _db: db,
    prepare(sql) {
      return new MockStatement(db, sql, interleave);
    },
    async batch(statements) {
      // D1 runs a batch as one implicit transaction and rolls the whole thing
      // back if any statement fails. Reproduce that, or a test would see a
      // half-applied batch that production never produces.
      //
      // No await inside the transaction — see MockStatement.runSync. On a
      // single-threaded event loop that makes the whole batch atomic with
      // respect to any other batch, which is the guarantee D1 gives.
      db.exec('BEGIN');
      try {
        const results = statements.map((stmt) => stmt.runSync());
        db.exec('COMMIT');
        return results;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    // Test-only conveniences; not part of the D1 surface the worker uses.
    _rows(sql, ...args) {
      return db.prepare(sql).all(...args.map(normalizeBindValue));
    },
    _row(sql, ...args) {
      const r = db.prepare(sql).get(...args.map(normalizeBindValue));
      return r === undefined ? null : r;
    }
  };
}

// KV mock. Unchanged in spirit from the pre-migration suite: KV still backs
// magic_<token> and cust_<id>, plus the rollback mirror (§7).
export function makeKV(seed = {}, opts = {}) {
  const m = new Map(
    Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
  );
  return {
    _m: m,
    async get(k, o) {
      if (opts.onGet) await opts.onGet(k, m);
      if (opts.failGet && opts.failGet(k)) throw new Error('KV get failed');
      const v = m.get(k);
      if (v === undefined) return null;
      return o && o.type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) {
      if (opts.failPut && opts.failPut(k)) throw new Error('KV put failed');
      m.set(k, v);
    },
    async delete(k) {
      m.delete(k);
    }
  };
}

export function makeEnv(overrides = {}) {
  const { interleave, ...rest } = overrides;
  return {
    CLIENT_KV: makeKV(),
    DB: makeDB({ interleave: !!interleave }),
    ...rest
  };
}

// ---- request builders ------------------------------------------------------
// A-4: the worker requires a well-formed Content-Length, which browsers and
// Stripe always send but a hand-built Request does not.

export function post(path, body, headers = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://w.dev' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(new TextEncoder().encode(raw).length),
      ...headers
    },
    body: raw
  });
}

export function postNoContentLength(path, body, headers = {}) {
  return new Request('https://w.dev' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

export function get(path, headers = {}) {
  return new Request('https://w.dev' + path, { method: 'GET', headers });
}

// ---- Stripe webhook helpers ------------------------------------------------

export const WEBHOOK_SECRET = 'whsec_test_secret';

export async function signBody(raw, ts, secret = WEBHOOK_SECRET) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${raw}`));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function webhookRequest(event, { secret = WEBHOOK_SECRET, ts } = {}) {
  const raw = typeof event === 'string' ? event : JSON.stringify(event);
  const stamp = ts ?? Math.floor(Date.now() / 1000);
  return post('/hook', raw, { 'Stripe-Signature': `t=${stamp},v1=${await signBody(raw, stamp, secret)}` });
}

// ---- seeding ---------------------------------------------------------------

export function seedUser(env, row = {}) {
  const u = {
    email: 'a@b.com',
    status: 'Active',
    credits: 40,
    skipped: 0,
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_1',
    magic_revoked_before: 0,
    past_due_at: null,
    canceled_at: null,
    updated_at: Date.now(),
    tier: 'regular',
    ...row
  };
  env.DB._db.prepare(
    `INSERT OR REPLACE INTO users
       (email, status, credits, skipped, stripe_customer_id, stripe_subscription_id,
        magic_revoked_before, past_due_at, canceled_at, updated_at, tier)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    u.email, u.status, u.credits, u.skipped, u.stripe_customer_id,
    u.stripe_subscription_id, u.magic_revoked_before, u.past_due_at, u.canceled_at, u.updated_at, u.tier
  );
  return u;
}

export async function seedToken(env, token = 'TOK', email = 'a@b.com', createdAt = Date.now()) {
  await env.CLIENT_KV.put(`magic_${token}`, JSON.stringify({ email, createdAt }));
  return token;
}

// A fully-provisioned client: D1 row + KV session + customer index.
export async function seedClient(env, { token = 'TOK', ...row } = {}) {
  const u = seedUser(env, row);
  await seedToken(env, token, u.email);
  if (u.stripe_customer_id) await env.CLIENT_KV.put(`cust_${u.stripe_customer_id}`, u.email);
  return u;
}

export function userRow(env, email = 'a@b.com') {
  return env.DB._row('SELECT * FROM users WHERE email = ?', email);
}

export function chatMessages(env, email = 'a@b.com') {
  return env.DB._rows('SELECT * FROM chat_messages WHERE email = ? ORDER BY ts ASC, rowid ASC', email);
}

export function chatSession(env, email = 'a@b.com') {
  return env.DB._row('SELECT * FROM chat_sessions WHERE email = ?', email);
}

// ---- misc ------------------------------------------------------------------

// Swap globalThis.fetch for the duration of fn, always restoring it.
export async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

export async function withFrozenClock(atMs, fn) {
  const real = Date.now;
  Date.now = () => atMs;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}
