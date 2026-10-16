// V2 T18 (API): admin Circle views and actions (spec v1.1 §8.6, §12, §15.2;
// tz-v2 §3.3): Members show membership, balance and next charge; the member
// detail shows the ledger and invoices; "Adjust credits" needs a note; flags
// can be resolved; the Circle overview sums the ledger as credits outstanding.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signIn, T0, DAY } from './api-helpers.mjs';
import { v2Rig, makeV2World, stripeBasics, STRIPE_ENV, stripeEvent, deliver, fx, stripePayments, CIRCLE_WHSEC } from './v2-helpers.mjs';

async function rig() {
  const world = stripePayments(stripeBasics(makeV2World({ shopifyCustomers: [] })));
  const r = await v2Rig({ world, envOverrides: { ...STRIPE_ENV, STRIPE_CIRCLE_WEBHOOK_SECRET: CIRCLE_WHSEC } });
  await signIn(r.t, 'clara@example.com');
  await signIn(r.t, 'club@example.com');
  const id = (e) => r.t.rows('SELECT id FROM users WHERE email = ?', e)[0].id;
  const send = (type, obj) => deliver(r.t, stripeEvent(type, obj));
  await send('checkout.session.completed', fx.session({ userId: id('clara@example.com') }));
  await send('invoice.paid', fx.invoice({ userId: id('clara@example.com') }));
  await send('customer.subscription.updated', fx.subscription({ userId: id('clara@example.com') }));
  return { ...r, id, send };
}

test('T18-1: Members list shows status, balance and next charge for members, nulls for Club', async () => {
  const r = await rig();
  const { data } = await r.admin('/api/admin/members');
  const clara = data.members.find((m) => m.email === 'clara@example.com');
  const club = data.members.find((m) => m.email === 'club@example.com');
  assert.deepEqual([clara.tier, clara.status, clara.credits_balance_cents, clara.next_charge_at],
    ['vip', 'active', 2000, new Date(T0 + 31 * DAY).toISOString()]);
  assert.deepEqual([club.status, club.credits_balance_cents, club.next_charge_at], [null, null, null]);
  const filtered = (await r.admin('/api/admin/members?status=active')).data.members;
  assert.deepEqual(filtered.map((m) => m.email), ['clara@example.com']);
});

test('T18-2: member detail: membership, ledger, invoices', async () => {
  const r = await rig();
  const { data } = await r.admin(`/api/admin/members/${r.id('clara@example.com')}`);
  assert.equal(data.membership.status, 'active');
  assert.equal(data.credits.balance_cents, 2000);
  assert.equal(data.credits.ledger[0].memo, 'Welcome — first month');
  assert.equal(data.invoices[0].amount_paid_cents, 5000);
  const club = (await r.admin(`/api/admin/members/${r.id('club@example.com')}`)).data;
  assert.equal(club.membership, null);
  assert.equal(club.credits, null);
});

test('T18-3: adjusting credits needs a note; it is written as manual by the admin and audited', async () => {
  const r = await rig();
  const uid = r.id('clara@example.com');
  let out = await r.adminSend('POST', '/api/admin/credits/adjust', { user_id: uid, amount_cents: 500 });
  assert.equal(out.res.status, 400);
  assert.equal(out.data.error.code, 'note_required');
  out = await r.adminSend('POST', '/api/admin/credits/adjust', { user_id: uid, amount_cents: 550, memo: 'x' });
  assert.equal(out.res.status, 400, 'whole credits');
  out = await r.adminSend('POST', '/api/admin/credits/adjust', { user_id: uid, amount_cents: 500, memo: 'Delivery was late' });
  assert.equal(out.res.status, 201);
  const row = r.t.rows("SELECT kind, amount_cents, memo, created_by FROM credit_ledger WHERE kind = 'manual'")[0];
  assert.deepEqual({ ...row }, { kind: 'manual', amount_cents: 500, memo: 'Adjustment by the Maison — Delivery was late', created_by: 'admin:felix@example.com' });
  out = await r.adminSend('POST', '/api/admin/credits/adjust', { user_id: uid, amount_cents: -3000, memo: 'too much' });
  assert.equal(out.res.status, 409, 'cannot take the balance below zero');
  out = await r.adminSend('POST', '/api/admin/credits/adjust', { user_id: r.id('club@example.com'), amount_cents: 500, memo: 'x' });
  assert.equal(out.res.status, 409, 'Club members have no ledger');
  assert.equal(r.t.rows("SELECT 1 FROM admin_audit WHERE action = 'credits_adjusted'").length, 1);
});

test('T18-4: the Circle overview: members by status, credits outstanding = the ledger sum, open flags', async () => {
  const r = await rig();
  await r.adminSend('POST', '/api/admin/credits/adjust', { user_id: r.id('clara@example.com'), amount_cents: 300, memo: 'goodwill' });
  r.t.env.DB._db.prepare("INSERT INTO admin_flags (id, kind, dedupe_key, status, created_at) VALUES ('f1', 'object_bypass', 'k1', 'open', 'x')").run();
  const { data } = await r.admin('/api/admin/circle/overview');
  assert.deepEqual(data.members, { active: 1, past_due: 0, canceling: 0, ended: 0, ended_expired: 0, pending: 0 });
  assert.equal(data.credits_outstanding_cents, 2300);
  assert.equal(data.monthly_recurring_cents, 2000);
  assert.equal(data.open_flags, 1);
});

test('T18-5: flags are listed and resolved by Felix, with the audit', async () => {
  const r = await rig();
  r.t.env.DB._db.prepare("INSERT INTO admin_flags (id, kind, dedupe_key, ref, details_json, status, created_at) VALUES ('f1', 'object_bypass', 'k1', 'gid://shopify/Order/1', NULL, 'open', 'x')").run();
  let list = (await r.admin('/api/admin/flags')).data.flags;
  assert.equal(list.length, 1);
  const out = await r.adminSend('POST', '/api/admin/flags/f1/resolve', {});
  assert.equal(out.res.status, 200);
  list = (await r.admin('/api/admin/flags')).data.flags;
  assert.equal(list.length, 0);
  assert.equal((await r.admin('/api/admin/flags?status=resolved')).data.flags[0].resolved_by, 'felix@example.com');
});
