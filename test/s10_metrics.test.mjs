// S10 acceptance: Overview V1 metrics (spec §15.2) — accounts, sign-ins,
// Saved, waitlist, repeat purchases — counted right on known test data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDB } from './harness.mjs';
import { computeMetrics, parseRange } from '../src/admin/metrics.js';

const D = (s) => `${s}T12:00:00.000Z`;
let seq = 0;
const id = () => `01ID${String(++seq).padStart(6, '0')}`;

function seed() {
  const db = makeDB();
  const ex = (sql, ...a) => db._db.prepare(sql).run(...a);
  const user = (uid, created, extra = {}) => ex(
    'INSERT INTO users (id, email, tier, created_at, deleted_at) VALUES (?, ?, ?, ?, ?)',
    uid, `${uid}@example.com`, extra.tier || 'club', D(created), extra.deleted ? D(created) : null,
  );
  const ev = (name, at, { user: u = null, props = null } = {}) =>
    ex('INSERT INTO events (id, user_id, name, props_json, created_at) VALUES (?, ?, ?, ?, ?)', id(), u, name, props && JSON.stringify(props), D(at));
  const order = (at, customer, u = null) => ev('order_placed', at, { user: u, props: { customer_id: customer, tier: u ? 'club' : 'none', is_repeat: false, used_gift_card: false } });

  // Accounts: two before the period, three in it (one later deleted).
  user('A', '2026-08-01'); user('B', '2026-09-01');
  user('C', '2026-10-02'); user('D', '2026-10-06'); user('E', '2026-10-07', { deleted: true });
  user('V', '2026-08-15', { tier: 'vip' });

  ev('login_succeeded', '2026-10-02', { user: 'C', props: { method: 'magic_link', is_first: true } });
  ev('login_succeeded', '2026-10-05', { user: 'A', props: { method: 'passkey', is_first: false } });
  ev('login_succeeded', '2026-10-09', { user: 'A', props: { method: 'magic_link', is_first: false } });
  ev('login_succeeded', '2026-09-20', { user: 'B' }); // before the period

  ev('wishlist_added', '2026-10-03', { user: 'C' });
  ev('wishlist_added', '2026-10-04', { user: 'C' });
  ex("INSERT INTO wishlist_items (user_id, product_gid, product_handle, created_at) VALUES ('C','gid://shopify/Product/1','kouros',?)", D('2026-10-03'));
  ex("INSERT INTO wishlist_items (user_id, product_gid, product_handle, created_at) VALUES ('C','gid://shopify/Product/2','ember',?)", D('2026-10-04'));
  ex("INSERT INTO wishlist_items (user_id, product_gid, product_handle, created_at) VALUES ('A','gid://shopify/Product/1','kouros',?)", D('2026-09-03'));

  ev('circle_waitlist_joined', '2026-10-08', { user: 'D' });
  ex("INSERT INTO holds (id, user_id, kind, source, status, created_at) VALUES ('W1','D','circle_waitlist','portal','open',?)", D('2026-10-08'));
  ex("INSERT INTO holds (id, user_id, kind, source, status, created_at) VALUES ('W2','B','circle_waitlist','import','open',?)", D('2026-09-08'));
  ex("INSERT INTO holds (id, user_id, kind, source, status, created_at) VALUES ('W3','A','circle_waitlist','import','released',?)", D('2026-09-08'));

  // Orders, 90-day window ending 2026-10-14 → from 2026-07-16.
  order('2026-08-01', 'c1', 'A'); order('2026-10-03', 'c1', 'A'); // Club, repeat
  order('2026-10-04', 'c2', 'C');                                  // Club, once
  order('2026-09-10', 'g1'); order('2026-10-10', 'g1');            // no account, repeat
  order('2026-10-11', 'g2');                                        // no account, once
  order('2026-10-12', 'g3');                                        // no account, once
  order('2026-07-01', 'g4'); order('2026-10-12', 'g4');            // first order outside the window
  return db;
}

const RANGE = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z' };

test('accounts: total excludes deleted; new = created in the period, not deleted; VIP counted apart', async () => {
  const m = await computeMetrics(seed(), RANGE);
  assert.equal(m.accounts.total, 5);           // A B C D V
  assert.equal(m.accounts.new_in_period, 2);   // C D
  assert.equal(m.accounts.club, 4);
  assert.equal(m.accounts.vip, 1);
});

test('sign-ins: count and distinct members in the period', async () => {
  const m = await computeMetrics(seed(), RANGE);
  assert.equal(m.logins.count, 3);
  assert.equal(m.logins.unique_members, 2);
  assert.equal(m.logins.by_passkey, 1);
});

test('Saved: additions in the period, members with something saved now', async () => {
  const m = await computeMetrics(seed(), RANGE);
  assert.equal(m.saved.added_in_period, 2);
  assert.equal(m.saved.members_with_saved, 2);
});

test('waitlist: joined in the period, open places in total', async () => {
  const m = await computeMetrics(seed(), RANGE);
  assert.equal(m.waitlist.joined_in_period, 1);
  assert.equal(m.waitlist.total, 2);
});

test('repeat purchase rate: buyers with 2+ orders in 90 days / all buyers, Club vs no account', async () => {
  const m = await computeMetrics(seed(), RANGE);
  const r = m.repeat_purchase_90d;
  assert.equal(r.window_from, '2026-07-17T00:00:00.000Z');
  assert.equal(r.window_to, RANGE.to);
  assert.deepEqual(r.all, { buyers: 6, repeat: 2, rate_pct: 33.3 });       // c1 c2 g1 g2 g3 g4; repeat c1 g1
  assert.deepEqual(r.club, { buyers: 2, repeat: 1, rate_pct: 50 });
  assert.deepEqual(r.no_account, { buyers: 4, repeat: 1, rate_pct: 25 });
});

test('orders in the period and the share of buyers with an account', async () => {
  const m = await computeMetrics(seed(), RANGE);
  assert.equal(m.orders.count, 6);                    // Oct 3, 4, 10, 11, 12, 12
  assert.equal(m.orders.buyers, 6);
  assert.equal(m.orders.buyers_with_account_pct, 33.3); // c1 c2 of 6
});

test('weekly series: Monday weeks covering the period, zero-filled', async () => {
  const m = await computeMetrics(seed(), RANGE);
  assert.deepEqual(m.weekly.map((w) => w.week_start), ['2026-09-28', '2026-10-05', '2026-10-12']);
  assert.deepEqual(m.weekly.map((w) => w.new_accounts), [1, 1, 0]);
  assert.deepEqual(m.weekly.map((w) => w.logins), [1, 2, 0]);
  assert.deepEqual(m.weekly.map((w) => w.orders), [2, 2, 2]);
});

test('an empty database gives zeros and null rates, not NaN', async () => {
  const m = await computeMetrics(makeDB(), RANGE);
  assert.equal(m.accounts.total, 0);
  assert.deepEqual(m.repeat_purchase_90d.all, { buyers: 0, repeat: 0, rate_pct: null });
  assert.equal(m.orders.buyers_with_account_pct, null);
});

test('parseRange: dates are whole UTC days, `to` inclusive; default is the last 30 days; bad input → 400', () => {
  const now = Date.parse('2026-10-15T09:30:00.000Z');
  assert.deepEqual(parseRange(new URLSearchParams('from=2026-10-01&to=2026-10-14'), now), RANGE);
  assert.deepEqual(parseRange(new URLSearchParams(''), now), { from: '2026-09-16T00:00:00.000Z', to: '2026-10-16T00:00:00.000Z' });
  for (const qs of ['from=2026-10-10&to=2026-10-01', 'from=yesterday', 'from=2026-02-30&to=2026-03-01', 'from=2024-01-01&to=2026-01-01']) {
    assert.throws(() => parseRange(new URLSearchParams(qs), now), (e) => e.status === 400, qs);
  }
});
