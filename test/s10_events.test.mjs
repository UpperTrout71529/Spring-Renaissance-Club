// S10: client analytics — POST /api/events with the §15.1 allowlist. Only
// the events the spec marks "client", only their listed properties; server
// events (sign-in, Saved, waitlist, Not now…) cannot be forged from here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { post } from './harness.mjs';
import { trusted, setup, signIn, body } from './api-helpers.mjs';

const send = (cookie, payload, headers = trusted) => post('/api/events', payload, { ...headers, Cookie: cookie });

async function signedIn() {
  const t = setup();
  const { cookie } = await signIn(t);
  const user = t.rows('SELECT id FROM users')[0];
  const events = () => t.rows("SELECT user_id, name, props_json FROM events WHERE name NOT IN ('login_requested','login_succeeded','account_created')")
    .map((r) => ({ user_id: r.user_id, name: r.name, props: JSON.parse(r.props_json) }));
  return { t, cookie, user, events };
}

test('the allowlisted client events are stored for the signed-in member → 204', async () => {
  const { t, cookie, user, events } = await signedIn();
  for (const payload of [
    { name: 'order_viewed', props: { order_id: '1001', carrier: 'UPS' } },
    { name: 'tracking_clicked', props: { order_id: '1001', carrier: 'UPS' } },
    { name: 'circle_teaser_viewed', props: { placement: 'home' } },
    { name: 'circle_teaser_clicked', props: { placement: 'home' } },
  ]) {
    const res = await t.call(send(cookie, payload));
    assert.equal(res.status, 204, payload.name);
  }
  assert.deepEqual(events().map((e) => [e.user_id, e.name]), [
    [user.id, 'order_viewed'], [user.id, 'tracking_clicked'], [user.id, 'circle_teaser_viewed'], [user.id, 'circle_teaser_clicked'],
  ]);
  assert.deepEqual(events()[0].props, { order_id: '1001', carrier: 'UPS' });
});

test('optional properties may be left out', async () => {
  const { t, cookie, events } = await signedIn();
  assert.equal((await t.call(send(cookie, { name: 'order_viewed', props: { order_id: '1001' } }))).status, 204);
  assert.deepEqual(events()[0].props, { order_id: '1001' });
});

test('server-side and unknown events are refused (400 unknown_event)', async () => {
  const { t, cookie, events } = await signedIn();
  for (const name of ['login_succeeded', 'account_created', 'wishlist_added', 'circle_waitlist_joined', 'circle_teaser_snoozed', 'order_placed', 'credits_accrued', 'anything', '']) {
    const res = await t.call(send(cookie, { name, props: {} }));
    assert.equal(res.status, 400, name);
    assert.equal((await body(res)).error.code, 'unknown_event');
  }
  assert.deepEqual(events(), []);
});

test('properties outside the event\'s list, missing required ones, wrong types or values → 400', async () => {
  const { t, cookie, events } = await signedIn();
  for (const payload of [
    { name: 'order_viewed', props: { order_id: '1001', email: 'x@y.z' } },
    { name: 'order_viewed', props: {} },
    { name: 'order_viewed' },
    { name: 'order_viewed', props: { order_id: 1001 } },
    { name: 'order_viewed', props: { order_id: 'x'.repeat(65) } },
    { name: 'circle_teaser_viewed', props: { placement: 'popup' } },
    { name: 'circle_teaser_viewed', props: ['home'] },
  ]) {
    const res = await t.call(send(cookie, payload));
    assert.equal(res.status, 400, JSON.stringify(payload));
    assert.equal((await body(res)).error.code, 'invalid_event');
  }
  assert.deepEqual(events(), []);
});

test('needs a session (401) and the portal headers (403)', async () => {
  const { t, cookie } = await signedIn();
  assert.equal((await t.call(post('/api/events', { name: 'order_viewed', props: { order_id: '1' } }, trusted))).status, 401);
  assert.equal((await t.call(send(cookie, { name: 'order_viewed', props: { order_id: '1' } }, { Origin: 'https://evil.example' }))).status, 403);
});

test('at most 300 events an hour per member → then 429', async () => {
  const { t, cookie } = await signedIn();
  const payload = { name: 'circle_teaser_viewed', props: { placement: 'home' } };
  for (let i = 0; i < 300; i++) assert.equal((await t.call(send(cookie, payload))).status, 204);
  assert.equal((await t.call(send(cookie, payload))).status, 429);
});
