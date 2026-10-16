// V2 T17: invite a friend (docs/tz-v2-circle.md §11; Felix §19 #6): the
// friend's joining fee is $10 lower (first invoice $40); the member gets 10
// credits after the friend's second payment (first invoice + first renewal);
// one counted invitation per member per UTC quarter; a card or address match
// goes to manual review; refunds and disputes undo; rule 3 must hold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post } from './harness.mjs';
import { trusted, signIn, body, T0, DAY } from './api-helpers.mjs';
import { v2Rig, makeV2World, stripeBasics, STRIPE_ENV, stripeEvent, deliver, fx, stripePayments, CIRCLE_WHSEC, catalogProduct, serveCatalog, seedWelcomeSet } from './v2-helpers.mjs';

const V = (n) => `gid://shopify/ProductVariant/${n}`;

async function rig({ costs = true, fingerprint = (pi) => (pi.includes('friend') ? 'fp_friend' : 'fp_member') } = {}) {
  const world = stripePayments(stripeBasics(makeV2World({ shopifyCustomers: [] })), { fingerprint });
  serveCatalog(world, [catalogProduct({ id: 1, handle: 'vase-a', variants: [{ id: 11, price: '40.00' }] })], 10);
  world.coupons = [];
  world.searches = {};
  world.stripeOn('POST', '/v1/coupons', (call) => { const c = { id: `co_${world.coupons.length + 1}`, params: call.params }; world.coupons.push(c); return { id: c.id }; });
  world.stripeOn('GET', '/v1/customers/search', (call) => ({ data: world.searches[call.params.query] || [] }));
  const r = await v2Rig({ world, envOverrides: { ...STRIPE_ENV, STRIPE_CIRCLE_WEBHOOK_SECRET: CIRCLE_WHSEC } });
  await r.adminSend('POST', '/api/admin/catalog/sync', {});
  seedWelcomeSet(r.t, { shippingCents: 0 });
  if (costs) await r.adminSend('PUT', '/api/admin/costs', { variant_gid: V(11), cost_cents: 1000, shipping_class: 'S' });
  const people = {};
  for (const [email, n] of [['clara@example.com', 1], ['friend@example.com', 2], ['other@example.com', 3]]) {
    const s = await signIn(r.t, email);
    people[email] = { cookie: s.cookie, id: r.t.rows('SELECT id FROM users WHERE email = ?', email)[0].id, n };
  }
  const send = (type, obj) => deliver(r.t, stripeEvent(type, obj));
  const as = (email) => ({
    get: async (path) => { const res = await r.t.call(get(path, { ...trusted, Cookie: people[email].cookie })); return { res, data: await body(res) }; },
    post: async (path, p) => { const res = await r.t.call(post(path, p ?? {}, { ...trusted, Cookie: people[email].cookie })); return { res, data: await body(res) }; },
  });
  const join = async (email, { referralId = null, kind = 'join', months = 1 } = {}) => {
    const u = people[email];
    const tag = email.startsWith('friend') ? 'friend' : `m${u.n}`;
    await send('checkout.session.completed', fx.session({ userId: u.id, sub: `sub_${tag}`, customer: `cus_${tag}`, id: `cs_${tag}`, kind, referralId }));
    for (let i = 1; i <= months; i++) {
      const inv = fx.invoice({ id: `in_${tag}_${i}`, sub: `sub_${tag}`, customer: `cus_${tag}`, userId: u.id, kind, reason: i === 1 ? 'subscription_create' : 'subscription_cycle',
        start: T0 + (i - 1) * 31 * DAY, end: T0 + i * 31 * DAY, discount: i === 1 && referralId ? 1000 : 0 });
      await send('invoice.paid', inv);
    }
  };
  const balance = (email) => r.t.rows('SELECT COALESCE(SUM(amount_cents),0) AS b FROM credit_ledger WHERE user_id = ?', people[email].id)[0].b;
  const referral = () => { const x = r.t.rows('SELECT * FROM referrals')[0]; return x ? { ...x } : null; };
  return { ...r, people, send, as, join, balance, referral };
}

// Starts the friend's checkout with Clara's code; returns the referral id.
async function invited(r) {
  const code = (await r.as('clara@example.com').get('/api/circle/invite')).data.code;
  const j = await r.as('friend@example.com').get(`/api/circle/join?invite=${code}`);
  const out = await r.as('friend@example.com').post('/api/circle/checkout', { consents: { terms: true, age_18: true }, terms_version: j.data.terms_version, invite_code: code });
  assert.equal(out.res.status, 201, JSON.stringify(out.data));
  return { code, join: j.data, referralId: r.referral().id };
}

test('T17-1: a member gets a personal code and link; the friend sees $40 and Checkout gets a once-only coupon on the joining fee', async () => {
  const r = await rig();
  await r.join('clara@example.com');
  const inv = (await r.as('clara@example.com').get('/api/circle/invite')).data;
  assert.match(inv.code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(inv.link, `https://club.springrenaissance.store/circle/join?invite=${inv.code}`);
  assert.equal(inv.discount_cents, 1000);
  assert.equal(inv.reward_cents, 1000);
  assert.equal(inv.season, '2026Q4');
  assert.equal(inv.this_season, 'none');
  const { join, referralId } = await invited(r);
  assert.equal(join.first_charge_cents, 4000);
  assert.equal(join.invitation_note, 'Your invitation takes $10 off the joining fee.');
  assert.match(join.disclosure, /charged \$40 today, then \$20/);
  const coupon = r.world.coupons[0].params;
  assert.deepEqual([coupon.amount_off, coupon.currency, coupon.duration, coupon['applies_to[products][0]']], ['1000', 'usd', 'once', 'prod_joining']);
  const p = r.world.stripe.sessions.at(-1).params;
  assert.equal(p['discounts[0][coupon]'], 'co_1');
  assert.equal(p['subscription_data[metadata][referral_id]'], referralId);
  assert.equal(r.referral().status, 'pending_checkout');
});

test('T17-2: no credits after the first payment; 10 credits after the second, with the friend\'s name, once', async () => {
  const r = await rig();
  await r.join('clara@example.com');
  r.t.env.DB._db.prepare("UPDATE gift_selections SET shipping_json = ?").run(JSON.stringify({ name: 'C', address: { line1: '9 Elm St', postal_code: '10001' } }));
  const { referralId } = await invited(r);
  r.t.env.DB._db.prepare("UPDATE users SET first_name = 'Nina' WHERE email = 'friend@example.com'").run();
  await r.join('friend@example.com', { referralId, months: 1 });
  assert.equal(r.referral().status, 'qualifying');
  assert.equal(r.balance('clara@example.com'), 2000);
  await r.join('friend@example.com', { referralId, months: 2 });
  assert.equal(r.referral().status, 'credited');
  assert.equal(r.balance('clara@example.com'), 3000);
  const row = r.t.rows("SELECT memo, kind FROM credit_ledger WHERE kind = 'referral'")[0];
  assert.equal(row.memo, 'Referral — Nina');
  await r.join('friend@example.com', { referralId, months: 3 });
  assert.equal(r.balance('clara@example.com'), 3000);
  assert.ok(r.world.emails.some((e) => e.subject === '10 credits from your invitation'));
});

test('T17-3: inviting yourself or a former member is refused; the friend then pays full price with a quiet line', async () => {
  const r = await rig();
  await r.join('clara@example.com');
  const code = (await r.as('clara@example.com').get('/api/circle/invite')).data.code;
  const self = await r.as('clara@example.com').get(`/api/circle/join?invite=${code}`);
  assert.notEqual(self.data.first_charge_cents, 4000);
  r.t.env.DB._db.prepare("INSERT INTO memberships (id, user_id, status, kind, created_at, updated_at) VALUES ('old', ?, 'ended_expired', 'join', 'x', 'x')").run(r.people['other@example.com'].id);
  const former = await r.as('other@example.com').get(`/api/circle/join?invite=${code}`);
  assert.equal(former.data.kind, 'rejoin');
  assert.equal(former.data.first_charge_cents, 2000);
  // a Stripe customer already exists for the friend's email (someone else's record)
  r.world.searches["email:'friend@example.com'"] = [{ id: 'cus_elsewhere', email: 'friend@example.com' }];
  const j = await r.as('friend@example.com').get(`/api/circle/join?invite=${code}`);
  assert.equal(j.data.first_charge_cents, 5000);
  assert.equal(j.data.invitation_note, 'This invitation is for new members.');
});

test('T17-4: a card that matches the member\'s goes to manual review; Felix credits or rejects', async () => {
  const r = await rig({ fingerprint: () => 'fp_same' });
  await r.join('clara@example.com');
  const { referralId } = await invited(r);
  await r.join('friend@example.com', { referralId, months: 2 });
  assert.equal(r.referral().status, 'review');
  assert.equal(r.balance('clara@example.com'), 2000);
  const list = (await r.admin('/api/admin/invitations')).data;
  assert.equal(list.review.length, 1);
  assert.match(list.review[0].reason, /card/);
  const ok = await r.adminSend('PATCH', `/api/admin/invitations/${referralId}`, { decision: 'credit' });
  assert.equal(ok.res.status, 200, JSON.stringify(ok.data));
  assert.equal(r.referral().status, 'credited');
  assert.equal(r.balance('clara@example.com'), 3000);
});

test('T17-5: the same shipping address as the member also goes to review', async () => {
  const r = await rig();
  await r.join('clara@example.com');
  const { referralId } = await invited(r);
  await r.join('friend@example.com', { referralId, months: 2 }); // fx.session uses the same address for everyone
  assert.equal(r.referral().status, 'review');
  assert.match(r.referral().reason, /address/);
});

test('T17-6: one counted invitation per member per quarter; the second is "not counted this season"', async () => {
  const r = await rig();
  const addr = (email, line1) => r.t.env.DB._db.prepare("UPDATE gift_selections SET shipping_json = ? WHERE user_id = ?").run(JSON.stringify({ name: 'X', address: { line1, postal_code: '1' } }), r.people[email].id);
  await r.join('clara@example.com');
  addr('clara@example.com', 'member street');
  const first = await invited(r);
  await r.join('friend@example.com', { referralId: first.referralId, months: 1 });
  addr('friend@example.com', 'friend street');
  await r.join('friend@example.com', { referralId: first.referralId, months: 2 });
  assert.equal(r.referral().status, 'credited');
  // a second friend in the same quarter
  const code = first.code;
  const j = await r.as('other@example.com').get(`/api/circle/join?invite=${code}`);
  await r.as('other@example.com').post('/api/circle/checkout', { consents: { terms: true, age_18: true }, terms_version: j.data.terms_version, invite_code: code });
  const second = r.t.rows("SELECT id FROM referrals WHERE friend_user_id = ?", r.people['other@example.com'].id)[0].id;
  const u = r.people['other@example.com'];
  await r.send('checkout.session.completed', fx.session({ userId: u.id, sub: 'sub_o', customer: 'cus_o', id: 'cs_o', referralId: second }));
  await r.send('invoice.paid', fx.invoice({ id: 'in_o_1', sub: 'sub_o', customer: 'cus_o', userId: u.id, discount: 1000 }));
  addr('other@example.com', 'other street');
  await r.send('invoice.paid', fx.invoice({ id: 'in_o_2', sub: 'sub_o', customer: 'cus_o', userId: u.id, reason: 'subscription_cycle', start: T0 + 31 * DAY, end: T0 + 62 * DAY }));
  assert.equal(r.t.rows('SELECT status FROM referrals WHERE id = ?', second)[0].status, 'not_counted_season');
  assert.equal(r.balance('clara@example.com'), 3000);
});

test('T17-7: a refund of the friend\'s first payment before the credit voids it; after the credit it is reversed', async () => {
  const r = await rig({ fingerprint: (pi) => `fp_${pi}` });
  const addrs = () => r.t.env.DB._db.prepare("UPDATE gift_selections SET shipping_json = NULL").run();
  await r.join('clara@example.com');
  addrs();
  const { referralId } = await invited(r);
  await r.join('friend@example.com', { referralId, months: 1 });
  addrs();
  await r.send('charge.refunded', { id: 'ch_in_friend_1', object: 'charge', payment_intent: 'pi_in_friend_1', amount: 4000, amount_refunded: 4000 });
  assert.equal(r.referral().status, 'void');
  // a fresh pair where the refund comes after the credit
  const r2 = await rig({ fingerprint: (pi) => `fp_${pi}` });
  await r2.join('clara@example.com');
  r2.t.env.DB._db.prepare("UPDATE gift_selections SET shipping_json = NULL").run();
  const inv2 = await invited(r2);
  await r2.join('friend@example.com', { referralId: inv2.referralId, months: 1 });
  r2.t.env.DB._db.prepare("UPDATE gift_selections SET shipping_json = NULL").run();
  await r2.join('friend@example.com', { referralId: inv2.referralId, months: 2 });
  assert.equal(r2.referral().status, 'credited');
  await r2.send('charge.dispute.created', { id: 'dp_f', object: 'dispute', charge: 'ch_in_friend_2', payment_intent: 'pi_in_friend_2', amount: 2000 });
  assert.equal(r2.referral().status, 'reversed');
  assert.equal(r2.balance('clara@example.com'), 2000);
});

test('T17-8: the friend\'s membership ending before the second payment lapses the invitation', async () => {
  const r = await rig();
  await r.join('clara@example.com');
  const { referralId } = await invited(r);
  await r.join('friend@example.com', { referralId, months: 1 });
  await r.send('customer.subscription.deleted', fx.subscription({ id: 'sub_friend', customer: 'cus_friend', userId: r.people['friend@example.com'].id, status: 'canceled', endedAt: T0 + 20 * DAY }));
  assert.equal(r.referral().status, 'lapsed');
});

test('T17-9: without the cost data rule 3 cannot hold: no discount is offered and the member sees invitations paused', async () => {
  const r = await rig({ costs: false });
  await r.join('clara@example.com');
  const inv = (await r.as('clara@example.com').get('/api/circle/invite')).data;
  assert.equal(inv.paused, true);
  const j = await r.as('friend@example.com').get(`/api/circle/join?invite=${inv.code}`);
  assert.equal(j.data.first_charge_cents, 5000);
});

test('T17-10: an abandoned Checkout expires the invitation; canceling members cannot invite', async () => {
  const r = await rig();
  await r.join('clara@example.com');
  const { referralId } = await invited(r);
  await r.send('checkout.session.expired', { id: 'cs_x', object: 'checkout.session', mode: 'subscription', metadata: { kind: 'join', referral_id: referralId, user_id: r.people['friend@example.com'].id } });
  assert.equal(r.referral().status, 'expired');
  await r.send('customer.subscription.updated', fx.subscription({ id: 'sub_m1', customer: 'cus_m1', userId: r.people['clara@example.com'].id, cancelAtPeriodEnd: true }));
  const out = await r.as('clara@example.com').get('/api/circle/invite');
  assert.equal(out.res.status, 403);
});

test('T17-11: rule 3 is checked again at credit time — if costs rose since, the invitation is not counted', async () => {
  const r = await rig();
  await r.join('clara@example.com');
  r.t.env.DB._db.prepare("UPDATE gift_selections SET shipping_json = NULL").run();
  const { referralId } = await invited(r);
  await r.join('friend@example.com', { referralId, months: 1 });
  r.t.env.DB._db.prepare("UPDATE gift_selections SET shipping_json = NULL").run();
  await r.adminSend('PUT', '/api/admin/costs', { variant_gid: V(11), cost_cents: 3900, shipping_class: 'S' });
  await r.join('friend@example.com', { referralId, months: 2 });
  assert.equal(r.referral().status, 'not_counted_economics');
  assert.equal(r.balance('clara@example.com'), 2000);
});

test('T17-12: a refund of the friend\'s third invoice does not touch a credited invitation', async () => {
  const r = await rig({ fingerprint: (pi) => `fp_${pi}` });
  await r.join('clara@example.com');
  r.t.env.DB._db.prepare("UPDATE gift_selections SET shipping_json = NULL").run();
  const { referralId } = await invited(r);
  await r.join('friend@example.com', { referralId, months: 1 });
  r.t.env.DB._db.prepare("UPDATE gift_selections SET shipping_json = NULL").run();
  await r.join('friend@example.com', { referralId, months: 3 });
  assert.equal(r.referral().status, 'credited');
  await r.send('charge.refunded', { id: 'ch_in_friend_3', object: 'charge', payment_intent: 'pi_in_friend_3', amount: 2000, amount_refunded: 2000 });
  assert.equal(r.referral().status, 'credited');
});
