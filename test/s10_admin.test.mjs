// S10: admin read views (spec §12) — Members (search, filter, detail
// read-only), System (webhooks, email log, audit) — and the admin page
// itself, served from Workers Static Assets behind the same gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post } from './harness.mjs';
import { T0, MIN, DAY, trusted, makeWorld, setup, signIn, body } from './api-helpers.mjs';
import { ADMIN, accessEnv, makeAccess, withAccess } from './access-helpers.mjs';
import { _resetAccessKeys } from '../src/admin/access.js';

async function rig() {
  _resetAccessKeys();
  const access = await makeAccess();
  const assets = [];
  const t = setup({
    world: withAccess(makeWorld({ shopifyCustomers: [{ id: 'gid://shopify/Customer/7', email: 'clara@example.com' }] }), access),
    envOverrides: {
      ...accessEnv,
      ASSETS: { fetch: async (req) => { assets.push(new URL(req.url).pathname); return new Response('<!doctype html><title>Admin</title>', { headers: { 'Content-Type': 'text/html' } }); } },
    },
  });
  const jwt = await access.sign({ exp: Math.floor((T0 + 30 * DAY) / 1000) }); // outlives the clock jumps below
  const admin = async (path) => {
    const res = await t.call(get(path, { 'Cf-Access-Jwt-Assertion': jwt }));
    return { res, data: res.headers.get('Content-Type')?.includes('json') ? await body(res) : null };
  };
  return { t, admin, assets };
}

const run = (t, sql, ...a) => t.env.DB.prepare(sql).bind(...a).run();

test('members: newest first, search by email or name, LIKE wildcards are literal', async () => {
  const { t, admin } = await rig();
  await signIn(t, 'clara@example.com');
  t.setNow(T0 + MIN);
  await signIn(t, 'david@example.com');
  await run(t, "UPDATE users SET first_name = 'David', last_name = 'Marsh' WHERE email = 'david@example.com'");

  let { res, data } = await admin('/api/admin/members');
  assert.equal(res.status, 200);
  assert.deepEqual(data.members.map((m) => m.email), ['david@example.com', 'clara@example.com']);
  const m = data.members[1];
  assert.equal(m.tier, 'club');
  assert.equal(m.since, new Date(T0).toISOString());
  assert.equal(m.credits_balance_cents, null); // V2
  assert.equal(m.next_charge_at, null); // V2

  ({ data } = await admin('/api/admin/members?q=marsh'));
  assert.deepEqual(data.members.map((x) => x.email), ['david@example.com']);
  ({ data } = await admin('/api/admin/members?q=CLARA'));
  assert.deepEqual(data.members.map((x) => x.email), ['clara@example.com']);
  ({ data } = await admin('/api/admin/members?q=%25'));
  assert.deepEqual(data.members, []);
});

test('members: filter by tier; deleted (anonymised) accounts are left out', async () => {
  const { t, admin } = await rig();
  await signIn(t, 'clara@example.com');
  await signIn(t, 'gone@example.com');
  await run(t, "UPDATE users SET deleted_at = ?1, email = 'deleted+x@invalid' WHERE email = 'gone@example.com'", new Date(T0).toISOString());
  let { data } = await admin('/api/admin/members?tier=club');
  assert.deepEqual(data.members.map((x) => x.email), ['clara@example.com']);
  ({ data } = await admin('/api/admin/members?tier=vip'));
  assert.deepEqual(data.members, []);
  const { res } = await admin('/api/admin/members?tier=gold');
  assert.equal(res.status, 400);
});

test('members: pages of 50', async () => {
  const { t, admin } = await rig();
  for (let i = 0; i < 55; i++) {
    await run(t, "INSERT INTO users (id, email, created_at) VALUES (?1, ?2, ?3)",
      `01U${String(i).padStart(3, '0')}`, `m${i}@example.com`, new Date(T0 + i * MIN).toISOString());
  }
  let { data } = await admin('/api/admin/members');
  assert.equal(data.members.length, 50);
  assert.equal(data.has_more, true);
  ({ data } = await admin('/api/admin/members?page=2'));
  assert.equal(data.members.length, 5);
  assert.equal(data.has_more, false);
});

test('member detail: profile, Shopify link, consents, live sessions, saved, holds, emails — and the view is audited', async () => {
  const { t, admin } = await rig();
  await signIn(t, 'clara@example.com'); // the first link goes out before the account exists (no user_id)
  const { cookie } = await signIn(t, 'clara@example.com');
  const user = t.rows("SELECT id FROM users WHERE email = 'clara@example.com'")[0];
  await run(t, "INSERT INTO wishlist_items (user_id, product_gid, product_handle, created_at) VALUES (?1, 'gid://shopify/Product/1', 'kouros', ?2)", user.id, new Date(T0).toISOString());
  await run(t, "INSERT INTO holds (id, user_id, kind, product_handle, source, created_at) VALUES ('H1', ?1, 'object_hold', 'kouros', 'portal', ?2)", user.id, new Date(T0).toISOString());
  await t.call(new Request('https://w.dev/api/me', {
    method: 'PATCH', headers: { ...trusted, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ seasonal_email_opt_in: true }),
  }));

  const { res, data } = await admin(`/api/admin/members/${user.id}`);
  assert.equal(res.status, 200);
  assert.equal(data.user.email, 'clara@example.com');
  assert.equal(data.shopify_admin_url, 'https://admin.shopify.com/store/example/customers/7');
  assert.equal(data.consents[0].kind, 'seasonal_email');
  assert.equal(data.consents[0].granted, 1);
  assert.equal(data.sessions.length, 2);
  assert.equal(data.sessions[0].auth_method, 'magic_link');
  assert.equal('id_hash' in data.sessions[0], false); // never the session hash
  assert.deepEqual(data.saved.map((s) => s.product_handle), ['kouros']);
  assert.deepEqual(data.holds.map((h) => h.product_handle), ['kouros']);
  assert.ok(data.emails.some((e) => e.template === 'sign_in_link'));
  assert.ok(data.events.some((e) => e.name === 'login_succeeded'));
  assert.equal(data.membership, null); // V2

  const audit = t.rows('SELECT actor_email, action, target FROM admin_audit').map((r) => ({ ...r }));
  assert.deepEqual(audit, [{ actor_email: ADMIN, action: 'member_viewed', target: user.id }]);
});

test('member detail: unknown id → 404', async () => {
  const { admin } = await rig();
  const { res } = await admin('/api/admin/members/01NOPE');
  assert.equal(res.status, 404);
});

test('system: failed webhooks, email log, audit — newest first, filter by status', async () => {
  const { t, admin } = await rig();
  await signIn(t, 'clara@example.com');
  t.setNow(T0 + MIN);
  await signIn(t, 'clara@example.com');
  await run(t, "INSERT INTO webhook_events (event_id, source, type, received_at, status, error) VALUES ('e1','shopify','orders/create',?1,'failed','boom')", new Date(T0).toISOString());
  await run(t, "INSERT INTO webhook_events (event_id, source, type, received_at, status) VALUES ('e2','shopify','orders/create',?1,'processed')", new Date(T0 + MIN).toISOString());

  let { data } = await admin('/api/admin/webhooks?status=failed');
  assert.deepEqual(data.webhooks.map((w) => [w.event_id, w.error]), [['e1', 'boom']]);
  ({ data } = await admin('/api/admin/webhooks'));
  assert.deepEqual(data.webhooks.map((w) => w.event_id), ['e2', 'e1']);
  const { res } = await admin('/api/admin/webhooks?status=weird');
  assert.equal(res.status, 400);

  ({ data } = await admin('/api/admin/emails'));
  assert.equal(data.emails[0].template, 'sign_in_link');
  assert.equal(data.emails[0].email, 'clara@example.com');

  await admin(`/api/admin/members/${t.rows('SELECT id FROM users')[0].id}`);
  ({ data } = await admin('/api/admin/audit'));
  assert.equal(data.audit[0].action, 'member_viewed');
});

test('/admin serves the page from static assets once the gate passes, with a strict CSP', async () => {
  const { admin, assets } = await rig();
  const { res } = await admin('/admin');
  assert.equal(res.status, 200);
  assert.deepEqual(assets, ['/admin/index.html']);
  const csp = res.headers.get('Content-Security-Policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  await admin('/admin/admin.js');
  assert.equal(assets[1], '/admin/admin.js');
  const { res: bad } = await admin('/admin/..%2Fsecret');
  assert.equal(bad.status, 404);
});

test('admin routes are read-only in V1: POST to them is not allowed', async () => {
  const { t } = await rig();
  const res = await t.call(post('/api/admin/members', {}, trusted));
  assert.equal(res.status, 405);
});

test('admin JSON is never cached', async () => {
  const { admin } = await rig();
  const { res } = await admin('/api/admin/members');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('a day-old session row does not show as live once expired', async () => {
  const { t, admin } = await rig();
  await signIn(t, 'clara@example.com');
  const user = t.rows('SELECT id FROM users')[0];
  t.setNow(T0 + 15 * DAY);
  const { data } = await admin(`/api/admin/members/${user.id}`);
  assert.equal(data.sessions.length, 0);
});
