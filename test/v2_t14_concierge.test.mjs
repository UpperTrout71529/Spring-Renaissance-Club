// V2 T14: the concierge (people only — no AI anywhere) and Your rooms.
// Spec v1.1 §6.7, §8.4, §11 concierge_reply, §12 screen 6, T13 v1: Club has no
// access (403); photos are private (served only to their owner or the admin);
// files with EXIF are refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post } from './harness.mjs';
import { trusted, signIn, body, T0, DAY } from './api-helpers.mjs';
import { v2Rig, makeV2World, stripeBasics, STRIPE_ENV, stripeEvent, deliver, fx, stripePayments, CIRCLE_WHSEC } from './v2-helpers.mjs';

function fakeR2() {
  const m = new Map();
  return {
    _m: m,
    async put(key, value, opts) { m.set(key, { bytes: new Uint8Array(await new Response(value).arrayBuffer()), type: opts && opts.httpMetadata && opts.httpMetadata.contentType }); },
    async get(key) { const v = m.get(key); return v ? { body: new Blob([v.bytes]).stream(), httpMetadata: { contentType: v.type } } : null; },
    async delete(key) { m.delete(key); },
  };
}

async function rig({ rooms = true } = {}) {
  const world = stripePayments(stripeBasics(makeV2World({ shopifyCustomers: [] })));
  const r = await v2Rig({ world, envOverrides: { ...STRIPE_ENV, STRIPE_CIRCLE_WEBHOOK_SECRET: CIRCLE_WHSEC, ...(rooms ? { ROOMS: fakeR2() } : {}) } });
  const people = {};
  for (const email of ['clara@example.com', 'club@example.com']) {
    const s = await signIn(r.t, email);
    people[email] = { cookie: s.cookie, id: r.t.rows('SELECT id FROM users WHERE email = ?', email)[0].id };
  }
  const u = people['clara@example.com'];
  await deliver(r.t, stripeEvent('checkout.session.completed', fx.session({ userId: u.id })));
  await deliver(r.t, stripeEvent('invoice.paid', fx.invoice({ userId: u.id })));
  const as = (email) => ({
    get: async (path) => { const res = await r.t.call(get(path, { ...trusted, Cookie: people[email].cookie })); return { res, data: res.headers.get('Content-Type')?.includes('json') ? await body(res) : new Uint8Array(await res.arrayBuffer()) }; },
    post: async (path, p) => { const res = await r.t.call(post(path, p ?? {}, { ...trusted, Cookie: people[email].cookie })); return { res, data: await body(res) }; },
    upload: async (bytes, type, label = 'Living room') => {
      const res = await r.t.call(new Request(`https://w.dev/api/circle/rooms?label=${encodeURIComponent(label)}`, { method: 'PUT', body: bytes,
        headers: { ...trusted, Cookie: people[email].cookie, 'Content-Type': type, 'Content-Length': String(bytes.length) } }));
      return { res, data: await body(res) };
    },
    del: async (path) => { const res = await r.t.call(new Request('https://w.dev' + path, { method: 'DELETE', headers: { ...trusted, Cookie: people[email].cookie } })); return { res, data: await body(res) }; },
  });
  return { ...r, people, as };
}

const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xD9]);
const JPEG_EXIF = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xFF, 0xD9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);

test('T14-1: Club members have no access to the concierge or rooms (403)', async () => {
  const r = await rig();
  assert.equal((await r.as('club@example.com').get('/api/circle/concierge')).res.status, 403);
  assert.equal((await r.as('club@example.com').post('/api/circle/concierge', { body: 'Hello' })).res.status, 403);
  assert.equal((await r.as('club@example.com').get('/api/circle/rooms')).res.status, 403);
});

test('T14-2: a member writes; Felix sees it in the admin and answers; the member is emailed without the text', async () => {
  const r = await rig();
  const m = r.as('clara@example.com');
  let out = await m.post('/api/circle/concierge', { body: 'Could you suggest a vase for a north-facing room?' });
  assert.equal(out.res.status, 201);
  let threads = (await r.admin('/api/admin/concierge')).data.threads;
  assert.equal(threads.length, 1);
  assert.equal(threads[0].unread_from_member, 1);
  assert.equal(threads[0].email, 'clara@example.com');
  const reply = await r.adminSend('POST', `/api/admin/concierge/${threads[0].id}/reply`, { body: 'The pale celadon one, I think.' });
  assert.equal(reply.res.status, 201);
  const mail = r.world.emails.find((e) => e.subject === 'You have a reply from the Maison');
  assert.ok(mail);
  assert.doesNotMatch(mail.text, /celadon/);
  out = await m.get('/api/circle/concierge');
  assert.deepEqual(out.data.messages.map((x) => [x.author, x.body]), [['member', 'Could you suggest a vase for a north-facing room?'], ['maison', 'The pale celadon one, I think.']]);
  assert.equal(out.data.unread, 1);
  out = await m.get('/api/circle/concierge');
  assert.equal(out.data.unread, 0, 'opening the thread marks replies read');
  threads = (await r.admin('/api/admin/concierge')).data.threads;
  assert.equal(threads[0].unread_from_member, 0, 'answered');
});

test('T14-3: messages are 1–4000 characters, 20 a day; a priority note marks the thread', async () => {
  const r = await rig();
  const m = r.as('clara@example.com');
  assert.equal((await m.post('/api/circle/concierge', { body: '   ' })).res.status, 400);
  assert.equal((await m.post('/api/circle/concierge', { body: 'x'.repeat(4001) })).res.status, 400);
  await m.post('/api/circle/concierge', { body: 'An order went wrong.', priority: true });
  assert.equal(r.t.rows('SELECT priority FROM concierge_threads')[0].priority, 1);
  for (let i = 0; i < 19; i++) await m.post('/api/circle/concierge', { body: `note ${i}` });
  const over = await m.post('/api/circle/concierge', { body: 'one more' });
  assert.equal(over.res.status, 429);
});

test('T14-4: room photos: JPEG/PNG/WebP without EXIF, private, deletable', async () => {
  const r = await rig();
  const m = r.as('clara@example.com');
  let up = await m.upload(JPEG, 'image/jpeg');
  assert.equal(up.res.status, 201, JSON.stringify(up.data));
  const id = up.data.photo.id;
  assert.equal((await m.upload(JPEG_EXIF, 'image/jpeg')).data.error.code, 'exif_present');
  assert.equal((await m.upload(PNG, 'image/png', 'Hall')).res.status, 201);
  assert.equal((await m.upload(PNG, 'image/gif')).res.status, 415);
  assert.equal((await m.upload(JPEG, 'image/png')).res.status, 400, 'bytes must match the type');
  const list = (await m.get('/api/circle/rooms')).data.photos;
  assert.deepEqual(list.map((p) => p.room_label).sort(), ['Hall', 'Living room']);
  const img = await m.get(`/api/circle/rooms/${id}/image`);
  assert.equal(img.res.status, 200);
  assert.deepEqual([...img.data], [...JPEG]);
  assert.equal(img.res.headers.get('Cache-Control'), 'private, no-store');
  // not to anyone else
  assert.equal((await r.as('club@example.com').get(`/api/circle/rooms/${id}/image`)).res.status, 403);
  const adminImg = await r.t.call(get(`/api/admin/rooms/${id}/image`, { 'Cf-Access-Jwt-Assertion': r.jwt }));
  assert.equal(adminImg.status, 200);
  const del = await m.del(`/api/circle/rooms/${id}`);
  assert.equal(del.res.status, 200);
  assert.equal(r.t.env.ROOMS._m.size, 1);
});

test('T14-5: without the R2 binding, rooms answer 503 and nothing is stored', async () => {
  const r = await rig({ rooms: false });
  const up = await r.as('clara@example.com').upload(JPEG, 'image/jpeg');
  assert.equal(up.res.status, 503);
  assert.equal(up.data.error.code, 'rooms_unavailable');
});

test('T14-6: "Download my data" includes the Circle; deleting the account erases messages and photos (files too)', async () => {
  const r = await rig();
  const m = r.as('clara@example.com');
  await m.post('/api/circle/concierge', { body: 'Hello from Clara' });
  await m.upload(JPEG, 'image/jpeg');
  await r.t.env.DB.prepare('UPDATE sessions SET step_up_at = ?1').bind(new Date(T0).toISOString()).run();
  const exp = await r.t.call(get('/api/account/export', { ...trusted, Cookie: r.people['clara@example.com'].cookie }));
  const data = JSON.parse(await exp.text());
  assert.equal(data.circle.memberships[0].status, 'active');
  assert.equal(data.circle.credits[0].amount_cents, 2000);
  assert.equal(data.circle.concierge[0].body, 'Hello from Clara');
  assert.equal(data.circle.room_photos.length, 1);
  r.world.stripeOn('DELETE', '/v1/subscriptions/:id', (call, id) => ({ id, status: 'canceled' }));
  const del = await r.t.call(new Request('https://w.dev/api/account', { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }),
    headers: { ...trusted, Cookie: r.people['clara@example.com'].cookie, 'Content-Type': 'application/json', 'Content-Length': '20' } }));
  assert.equal(del.status, 202);
  assert.equal(r.t.rows('SELECT 1 FROM concierge_messages').length, 0);
  assert.equal(r.t.rows('SELECT 1 FROM room_photos').length, 0);
  assert.equal(r.t.env.ROOMS._m.size, 0);
  // a Club member's export has no circle key (V1 shape unchanged)
  await r.t.env.DB.prepare('UPDATE sessions SET step_up_at = ?1').bind(new Date(T0).toISOString()).run();
  const club = await r.t.call(get('/api/account/export', { ...trusted, Cookie: r.people['club@example.com'].cookie }));
  assert.equal(JSON.parse(await club.text()).circle, undefined);
});
