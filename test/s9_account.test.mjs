// S9: profile (names → Shopify, seasonal email consent), email change,
// sessions, data export, account deletion (§8.2, §8.3, §10.4, §13.3–13.4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { get, post } from './harness.mjs';
import { SEASONAL_EMAIL_TEXT, SEASONAL_EMAIL_VERSION } from '../src/routes/me.js';
import { T0, MIN, HOUR, trusted, makeWorld, setup, signIn, body } from './api-helpers.mjs';

const CLARA = 'gid://shopify/Customer/7';

function world() {
  const w = makeWorld({ shopifyCustomers: [{ id: CLARA, email: 'clara@example.com', tags: ['sr-club', 'circle-waitlist'] }] });
  const base = w.fetch;
  w.updates = [];
  w.untags = [];
  w.fetch = async (url, init = {}) => {
    if (String(url).includes('myshopify.com')) {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes('customerUpdate')) {
        w.updates.push(variables.input);
        return Response.json({ data: { customerUpdate: { customer: { id: variables.input.id }, userErrors: [] } } });
      }
      if (query.includes('tagsRemove')) {
        w.untags.push(variables);
        return Response.json({ data: { tagsRemove: { userErrors: [] } } });
      }
      if (query.includes('CustomerTags')) return Response.json({ data: { customer: { id: CLARA, tags: [] } } });
      if (query.includes('ProductByHandle')) {
        return Response.json({ data: { productByIdentifier: {
          id: 'gid://shopify/Product/1', handle: variables.handle, title: 'Piece', status: 'ACTIVE', onlineStoreUrl: 'https://springrenaissance.store/products/x',
          isGiftCard: false, tags: [], collections: { nodes: [] }, featuredMedia: null,
          priceRangeV2: { minVariantPrice: { amount: '10.0', currencyCode: 'USD' } }, variants: { nodes: [{ availableForSale: true }] },
        } } });
      }
    }
    return base(url, init);
  };
  return w;
}

const req = (method, path, b, headers = {}) => new Request('https://w.dev' + path, {
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: b === undefined ? undefined : JSON.stringify(b),
});

async function account(t, email = 'clara@example.com') {
  const { res, cookie } = await signIn(t, email);
  const user = (await body(res)).user;
  return { user, cookie, as: (extra = {}) => ({ ...trusted, Cookie: cookie, ...extra }) };
}

async function stepUp(t, a) {
  await t.call(post('/api/auth/step-up/email-code', {}, a.as()));
  const mail = t.world.emails.filter((e) => e.subject === 'Your confirmation code').at(-1);
  const code = /\b(\d{6})\b/.exec(mail.text)[1];
  assert.equal((await t.call(post('/api/auth/step-up/verify', { code }, a.as()))).status, 204);
}

const lastMail = (t, subject) => t.world.emails.filter((e) => e.subject === subject).at(-1);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ---- profile -------------------------------------------------------------

test('S9-1: names are trimmed, saved, shown by /api/me and mirrored to Shopify', async () => {
  const w = world();
  const t = setup({ world: w });
  const a = await account(t);
  const res = await t.call(req('PATCH', '/api/me', { first_name: '  Clara ', last_name: 'Duval' }, a.as()));
  assert.equal(res.status, 200);
  const me = await body(res);
  assert.equal(me.user.first_name, 'Clara');
  assert.equal(me.user.last_name, 'Duval');
  assert.deepEqual(w.updates.at(-1), { id: CLARA, firstName: 'Clara', lastName: 'Duval' });
  assert.equal((await t.call(req('PATCH', '/api/me', { first_name: 'x'.repeat(81) }, a.as()))).status, 400);
  assert.equal((await t.call(req('PATCH', '/api/me', { first_name: 7 }, a.as()))).status, 400);
  await t.call(req('PATCH', '/api/me', { last_name: '' }, a.as()));
  assert.equal(t.rows('SELECT last_name FROM users')[0].last_name, null);
});

test('S9-2: the seasonal letter switch records a consent with the shown text hash, both ways', async () => {
  const t = setup({ world: world() });
  const a = await account(t);
  await t.call(req('PATCH', '/api/me', { seasonal_email_opt_in: true }, a.as()));
  await t.call(req('PATCH', '/api/me', { seasonal_email_opt_in: false }, a.as()));
  const rows = t.rows('SELECT kind, document_version, shown_text_sha256, granted FROM consents ORDER BY rowid').map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { kind: 'seasonal_email', document_version: SEASONAL_EMAIL_VERSION, shown_text_sha256: sha256(SEASONAL_EMAIL_TEXT), granted: 1 },
    { kind: 'seasonal_email', document_version: SEASONAL_EMAIL_VERSION, shown_text_sha256: sha256(SEASONAL_EMAIL_TEXT), granted: 0 },
  ]);
  assert.equal(t.rows('SELECT seasonal_email_opt_in AS v FROM users')[0].v, 0);
  assert.equal((await t.call(req('PATCH', '/api/me', { seasonal_email_opt_in: 'yes' }, a.as()))).status, 400);
});

test('S9-3: the consent hash is of the exact words the portal shows', async () => {
  const { readFileSync } = await import('node:fs');
  const copy = readFileSync(new URL('../portal/src/copy/en.ts', import.meta.url), 'utf8');
  assert.ok(copy.includes(JSON.stringify(SEASONAL_EMAIL_TEXT)), 'portal copy.account.seasonalLabel must equal SEASONAL_EMAIL_TEXT');
});

// ---- email change --------------------------------------------------------

test('S9-4: email change needs step-up; then a link to the new address and a notice to the old', async () => {
  const t = setup({ world: world() });
  const a = await account(t);
  const blocked = await t.call(post('/api/me/email-change', { new_email: 'new@example.com' }, a.as()));
  assert.equal(blocked.status, 403);
  await stepUp(t, a);
  assert.equal((await t.call(post('/api/me/email-change', { new_email: 'New@Example.com' }, a.as()))).status, 202);
  const confirm = lastMail(t, 'Confirm your new email');
  assert.deepEqual(confirm.to, ['new@example.com']);
  assert.match(confirm.text, /\/account\/email#t=[A-Za-z0-9_-]{43}/);
  const notice = lastMail(t, 'A change to your account email');
  assert.deepEqual(notice.to, ['clara@example.com']);
  assert.match(notice.text, /new@example\.com/);
});

test('S9-5: the same address → 400; an address with an account → 409 with the spec copy', async () => {
  const t = setup({ world: world() });
  await account(t, 'david@example.com');
  t.setNow(T0 + 11 * MIN);
  const a = await account(t);
  await stepUp(t, a);
  assert.equal((await t.call(post('/api/me/email-change', { new_email: 'clara@example.com' }, a.as()))).status, 400);
  const taken = await t.call(post('/api/me/email-change', { new_email: 'DAVID@example.com' }, a.as()));
  assert.equal(taken.status, 409);
  assert.equal((await body(taken)).error.message, 'That email already has an account. Sign in with it, or write to the concierge to merge accounts.');
});

test('S9-6: confirming changes the email (and Shopify), once; the account signs in at the new address', async () => {
  const w = world();
  const t = setup({ world: w });
  const a = await account(t);
  await stepUp(t, a);
  await t.call(post('/api/me/email-change', { new_email: 'new@example.com' }, a.as()));
  const token = /#t=([A-Za-z0-9_-]{43})/.exec(lastMail(t, 'Confirm your new email').text)[1];

  const res = await t.call(post('/api/me/email-change/confirm', { token }, trusted)); // no session needed
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { email: 'new@example.com' });
  assert.equal(t.rows('SELECT email FROM users WHERE id = ?', a.user.id)[0].email, 'new@example.com');
  assert.deepEqual(w.updates.at(-1), { id: CLARA, email: 'new@example.com' });
  assert.equal((await t.call(post('/api/me/email-change/confirm', { token }, trusted))).status, 410);

  t.setNow(T0 + 11 * MIN);
  const again = await account(t, 'new@example.com');
  assert.equal(again.user.id, a.user.id);
});

test('S9-7: a confirm link expires after an hour; a race for the address ends in 409', async () => {
  const t = setup({ world: world() });
  const a = await account(t);
  await stepUp(t, a);
  await t.call(post('/api/me/email-change', { new_email: 'new@example.com' }, a.as()));
  const token = /#t=([A-Za-z0-9_-]{43})/.exec(lastMail(t, 'Confirm your new email').text)[1];
  t.setNow(T0 + HOUR);
  assert.equal((await t.call(post('/api/me/email-change/confirm', { token }, trusted))).status, 410);

  t.setNow(T0 + 2 * HOUR);
  const b = await account(t);
  await stepUp(t, b);
  await t.call(post('/api/me/email-change', { new_email: 'race@example.com' }, b.as()));
  const token2 = /#t=([A-Za-z0-9_-]{43})/.exec(lastMail(t, 'Confirm your new email').text)[1];
  await account(t, 'race@example.com'); // someone signs up with it meanwhile
  assert.equal((await t.call(post('/api/me/email-change/confirm', { token: token2 }, trusted))).status, 409);
});

// ---- sessions ------------------------------------------------------------

test('S9-8: sessions: list with the current one marked; sign out one; sign out everywhere else', async () => {
  const t = setup({ world: world() });
  const a = await account(t);
  const b = await account(t); // a second device
  const c = await account(t); // a third
  const { sessions } = await body(await t.call(get('/api/sessions', { Cookie: a.cookie })));
  assert.equal(sessions.length, 3);
  assert.equal(sessions.filter((s) => s.current).length, 1);
  assert.ok(sessions.every((s) => /^[0-9a-f]{64}$/.test(s.id)));

  const bId = sessions.find((s) => !s.current && t.rows('SELECT 1 FROM sessions WHERE id_hash = ?', s.id).length).id;
  // Revoke one other session by id.
  assert.equal((await t.call(req('DELETE', `/api/sessions/${bId}`, undefined, a.as()))).status, 204);
  assert.equal((await t.call(req('DELETE', `/api/sessions/${bId}`, undefined, a.as()))).status, 404);
  const alive = [b, c].map(async (x) => (await t.call(get('/api/me', { Cookie: x.cookie }))).status);
  assert.deepEqual((await Promise.all(alive)).sort(), [200, 401]);

  assert.equal((await t.call(req('DELETE', '/api/sessions', undefined, a.as()))).status, 204);
  assert.equal((await t.call(get('/api/me', { Cookie: a.cookie }))).status, 200);
  for (const x of [b, c]) assert.equal((await t.call(get('/api/me', { Cookie: x.cookie }))).status, 401);
});

test("S9-9: one cannot sign out someone else's session", async () => {
  const t = setup({ world: world() });
  const a = await account(t);
  t.setNow(T0 + 11 * MIN);
  const d = await account(t, 'david@example.com');
  const dSession = (await body(await t.call(get('/api/sessions', { Cookie: d.cookie })))).sessions[0].id;
  assert.equal((await t.call(req('DELETE', `/api/sessions/${dSession}`, undefined, a.as()))).status, 404);
  assert.equal((await t.call(get('/api/me', { Cookie: d.cookie }))).status, 200);
});

// ---- export --------------------------------------------------------------

test("S9-10: export needs step-up and holds the person's data, nobody else's, no secrets", async () => {
  const t = setup({ world: world() });
  const d = await account(t, 'david@example.com');
  await t.call(post('/api/wishlist', { product_handle: 'davids-piece' }, d.as()));
  t.setNow(T0 + 11 * MIN);
  const a = await account(t);
  await t.call(post('/api/wishlist', { product_handle: 'claras-piece' }, a.as()));
  await t.call(post('/api/holds', { product_handle: 'claras-hold' }, a.as()));
  await t.call(req('PATCH', '/api/me', { seasonal_email_opt_in: true }, a.as()));

  assert.equal((await t.call(get('/api/account/export', { Cookie: a.cookie }))).status, 403);
  await stepUp(t, a);
  const res = await t.call(get('/api/account/export', { Cookie: a.cookie }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Disposition'), /^attachment; filename="spring-renaissance-account-\d{4}-\d{2}-\d{2}\.json"$/);
  const text = await res.text();
  const data = JSON.parse(text);
  assert.equal(data.profile.email, 'clara@example.com');
  assert.deepEqual(data.saved.map((s) => s.product_handle), ['claras-piece']);
  assert.deepEqual(data.holds.map((h) => h.product_handle), ['claras-hold']);
  assert.equal(data.consents.length, 1);
  assert.ok(data.sessions.length >= 1);
  assert.deepEqual(Object.keys(data).sort(), ['consents', 'exported_at', 'holds', 'passkeys', 'profile', 'saved', 'sessions']);
  assert.ok(!text.includes('david'));
  assert.ok(!text.includes('id_hash') && !text.includes('public_key') && !text.includes('token'));
});

// ---- deletion ------------------------------------------------------------

test('S9-11: deletion needs step-up and the typed confirmation', async () => {
  const t = setup({ world: world() });
  const a = await account(t);
  assert.equal((await t.call(req('DELETE', '/api/account', { confirm: 'DELETE' }, a.as()))).status, 403);
  await stepUp(t, a);
  assert.equal((await t.call(req('DELETE', '/api/account', { confirm: 'yes' }, a.as()))).status, 400);
  assert.equal(t.rows('SELECT deleted_at FROM users')[0].deleted_at, null);
});

test('S9-12: deleting erases personal data, signs out everywhere, emails, untags; the old email starts afresh', async () => {
  const w = world();
  const t = setup({ world: w, envOverrides: { ADMIN_NOTIFY_EMAIL: 'felix@example.com' } });
  const a = await account(t);
  const other = await account(t); // second device
  await t.call(post('/api/wishlist', { product_handle: 'claras-piece' }, a.as()));
  await t.call(post('/api/holds', { product_handle: 'claras-hold' }, a.as()));
  await t.call(req('PATCH', '/api/me', { first_name: 'Clara', seasonal_email_opt_in: true }, a.as()));
  await stepUp(t, a);

  const res = await t.call(req('DELETE', '/api/account', { confirm: 'DELETE' }, a.as()));
  assert.equal(res.status, 202);
  assert.match(res.headers.get('Set-Cookie'), /Max-Age=0$/);

  const [u] = t.rows('SELECT * FROM users WHERE id = ?', a.user.id);
  assert.equal(u.email, `deleted+${a.user.id}@invalid`);
  assert.equal(u.first_name, null);
  assert.equal(u.shopify_customer_id, null);
  assert.ok(u.deleted_at);
  for (const table of ['sessions', 'passkeys', 'wishlist_items', 'holds']) {
    assert.equal(t.rows(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, a.user.id)[0].n, 0, table);
  }
  assert.equal(t.rows('SELECT COUNT(*) AS n FROM consents WHERE user_id = ?', a.user.id)[0].n, 1); // kept, no personal data
  for (const x of [a, other]) assert.equal((await t.call(get('/api/me', { Cookie: x.cookie }))).status, 401);

  const goodbye = lastMail(t, 'Your account has been deleted');
  assert.deepEqual(goodbye.to, ['clara@example.com']);
  const notice = lastMail(t, 'Account deleted — Shopify data to review');
  assert.deepEqual(notice.to, ['felix@example.com']);
  assert.ok(!notice.text.includes('clara@example.com'));
  assert.deepEqual(w.untags, [{ id: CLARA, tags: ['sr-club', 'circle-waitlist'] }]);

  // Signing in with the old address creates a new, empty account.
  t.setNow(T0 + 11 * MIN);
  const fresh = await account(t);
  assert.notEqual(fresh.user.id, a.user.id);
  assert.deepEqual(await body(await t.call(get('/api/wishlist', { Cookie: fresh.cookie }))), { items: [] });
  assert.equal((await body(await t.call(get('/api/me', { Cookie: fresh.cookie })))).user.first_name, null);
});
