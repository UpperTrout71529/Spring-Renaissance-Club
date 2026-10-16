// V2 T5: economics in D1 and the admin API (docs/tz-v2-circle.md §3.3, §12):
// versioned settings with save blocking, costs per variant (NULL ≠ 0), the
// Circle price list, the read-only catalog snapshot, computed Circle price
// items with reasons, the Economics snapshot, and the admin same-origin check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v2Rig, catalogProduct, serveCatalog, API_ORIGIN } from './v2-helpers.mjs';

const P = (n) => `gid://shopify/Product/${n}`;
const V = (n) => `gid://shopify/ProductVariant/${n}`;

const CATALOG = [
  catalogProduct({ id: 1, handle: 'vase-a', variants: [{ id: 11, price: '40.00' }, { id: 12, price: '68.00', title: 'Large' }] }),
  catalogProduct({ id: 2, handle: 'gift-card', isGiftCard: true, variants: [{ id: 21, price: '50.00' }] }),
  catalogProduct({ id: 3, handle: 'small-candle', tags: ['catalog'], variants: [{ id: 31, price: '24.00' }] }),
  catalogProduct({ id: 4, handle: 'winter-capsule', tags: ['capsule'], variants: [{ id: 41, price: '120.00' }] }),
  catalogProduct({ id: 5, handle: 'patron-membership', variants: [{ id: 51, price: '50.00' }] }),
  catalogProduct({ id: 6, handle: 'draft-thing', status: 'DRAFT', variants: [{ id: 61, price: '10.00' }] }),
];

async function rigWithCatalog(envOverrides = {}) {
  const r = await v2Rig({ envOverrides });
  serveCatalog(r.world, CATALOG, 2);
  const sync = await r.adminSend('POST', '/api/admin/catalog/sync', {});
  assert.equal(sync.res.status, 200, JSON.stringify(sync.data));
  return r;
}

test('T5-A1: the catalog sync pages through Shopify and stores a read-only snapshot with exclusions', async () => {
  const { t, world, adminSend } = await rigWithCatalog();
  assert.equal(world.shopifyCalls.filter((c) => c.name === 'CatalogPage').length, 3);
  const rows = t.rows('SELECT variant_gid, handle, price_cents, status, published, is_gift_card, product_tags FROM catalog_variants ORDER BY variant_gid');
  assert.equal(rows.length, 7);
  const v12 = rows.find((r) => r.variant_gid === V(12));
  assert.equal(v12.price_cents, 6800);
  assert.equal(v12.handle, 'vase-a');
  // only queries — nothing written to Shopify
  assert.ok(world.shopifyCalls.every((c) => c.query.trim().startsWith('query')));
  // a product that disappears from Shopify leaves the snapshot on the next sync
  serveCatalog(world, CATALOG.slice(0, 1), 2);
  await adminSend('POST', '/api/admin/catalog/sync', {});
  assert.equal(t.rows('SELECT 1 FROM catalog_variants').length, 2);
});

test('T5-A2: settings start at the defaults and every change is versioned and audited', async () => {
  const { t, admin, adminSend } = await rigWithCatalog();
  let { data } = await admin('/api/admin/economics');
  assert.equal(data.settings.min_margin_bps, 1500);
  assert.equal(data.settings.guard_profile, 'worst');
  assert.deepEqual(data.settings.shipping.M, { cents: null, estimate: true });

  const r = await adminSend('PUT', '/api/admin/economics', { changes: { shipping: { M: { cents: 900, estimate: true } }, min_margin_bps: 1600 } });
  assert.equal(r.res.status, 200, JSON.stringify(r.data));
  ({ data } = await admin('/api/admin/economics'));
  assert.equal(data.settings.min_margin_bps, 1600);
  assert.deepEqual(data.settings.shipping.M, { cents: 900, estimate: true });
  assert.deepEqual(data.settings.shipping.S, { cents: null, estimate: true });
  assert.equal(data.versions.min_margin_bps, 1);
  await adminSend('PUT', '/api/admin/economics', { changes: { min_margin_bps: 1700 } });
  ({ data } = await admin('/api/admin/economics'));
  assert.equal(data.versions.min_margin_bps, 2);
  assert.equal(t.rows("SELECT 1 FROM economics_settings_history WHERE key = 'min_margin_bps'").length, 2);
  const audit = t.rows("SELECT action, actor_email FROM admin_audit WHERE action = 'economics_settings_saved'");
  assert.equal(audit.length, 2);
  assert.equal(audit[0].actor_email, 'felix@example.com');
});

test('T5-A3: invalid settings are refused with 400 and nothing is saved', async () => {
  const { t, adminSend } = await rigWithCatalog();
  for (const changes of [
    { min_margin_bps: -1 }, { min_margin_bps: 10001 }, { min_margin_bps: 15.5 }, { guard_profile: 'best' },
    { shipping: { X: { cents: 100, estimate: true } } }, { shipping: { S: { cents: -5, estimate: true } } },
    { referral_discount_cents: 3100 }, { referral_reward_cents: 150 }, { unknown_key: 1 }, { monthly_cents: '2000' },
  ]) {
    const r = await adminSend('PUT', '/api/admin/economics', { changes });
    assert.equal(r.res.status, 400, JSON.stringify(changes));
  }
  assert.equal(t.rows('SELECT 1 FROM economics_settings').length, 0);
});

test('T5-A4: costs per variant — empty means not participating; zero needs an explicit confirmation', async () => {
  const { t, adminSend } = await rigWithCatalog();
  let r = await adminSend('PUT', '/api/admin/costs', { variant_gid: V(11), cost_cents: 0, shipping_class: 'S' });
  assert.equal(r.res.status, 400);
  assert.equal(r.data.error.code, 'zero_cost_needs_confirmation');
  r = await adminSend('PUT', '/api/admin/costs', { variant_gid: V(11), cost_cents: 0, zero_confirmed: true, shipping_class: 'S' });
  assert.equal(r.res.status, 200);
  r = await adminSend('PUT', '/api/admin/costs', { variant_gid: V(11), cost_cents: null, shipping_class: 'S' });
  assert.equal(r.res.status, 200);
  assert.equal(t.rows('SELECT cost_cents FROM variant_costs WHERE variant_gid = ?', V(11))[0].cost_cents, null);
  for (const bad of [{ variant_gid: V(11), cost_cents: -1, shipping_class: 'S' }, { variant_gid: V(11), cost_cents: 1.5, shipping_class: 'S' },
    { variant_gid: V(11), cost_cents: 100, shipping_class: 'XL' }, { variant_gid: V(999), cost_cents: 100, shipping_class: 'S' }]) {
    r = await adminSend('PUT', '/api/admin/costs', bad);
    assert.ok([400, 404].includes(r.res.status), JSON.stringify(bad));
  }
  assert.ok(t.rows("SELECT 1 FROM admin_audit WHERE action = 'variant_cost_saved'").length >= 2);
});

test('T5-A5: Circle price items: on the list + cost + known shipping + rule 2 → eligible; otherwise the reason', async () => {
  const { t, admin, adminSend } = await rigWithCatalog();
  await adminSend('PUT', '/api/admin/economics', { changes: { shipping: { S: { cents: 0, estimate: false }, M: { cents: 500, estimate: true } } } });
  await adminSend('PUT', '/api/admin/circle-price/list', { product_gid: P(1), on_list: true });
  await adminSend('PUT', '/api/admin/costs', { variant_gid: V(11), cost_cents: 2306, shipping_class: 'S' });   // exactly the max
  await adminSend('PUT', '/api/admin/costs', { variant_gid: V(12), cost_cents: 3000, shipping_class: 'M' });   // estimate → 25%
  await adminSend('PUT', '/api/admin/circle-price/list', { product_gid: P(2), on_list: true });                 // gift card
  await adminSend('PUT', '/api/admin/circle-price/list', { product_gid: P(3), on_list: true });                 // catalog

  const items = Object.fromEntries(t.rows('SELECT * FROM circle_price_items').map((r) => [r.variant_gid, r]));
  assert.equal(items[V(11)].eligible, 1);
  assert.equal(items[V(11)].circle_price_cents, 3000);
  assert.equal(items[V(12)].eligible, 0);
  assert.equal(items[V(12)].reason, 'margin_below_min');
  assert.equal(items[V(12)].shipping_estimate, 1);
  assert.equal(items[V(21)].reason, 'excluded_gift_card');
  assert.equal(items[V(31)].reason, 'excluded_catalog');
  assert.equal(items[V(41)].reason, 'excluded_capsule');
  assert.equal(items[V(51)].reason, 'excluded_membership');

  // one cent over the max → out, with the max cost shown
  await adminSend('PUT', '/api/admin/costs', { variant_gid: V(11), cost_cents: 2307, shipping_class: 'S' });
  const v11 = t.rows('SELECT * FROM circle_price_items WHERE variant_gid = ?', V(11))[0];
  assert.deepEqual([v11.eligible, v11.reason, v11.max_cost_cents], [0, 'margin_below_min', 2306]);

  const { data } = await admin('/api/admin/costs');
  const row = data.variants.find((v) => v.variant_gid === V(11));
  assert.equal(row.on_list, true);
  assert.equal(row.cost_cents, 2307);
  assert.equal(row.reason, 'margin_below_min');
  assert.equal(row.max_cost_cents, 2306);
});

test('T5-A6: taking a product off the list removes its variants from the Circle price', async () => {
  const { t, adminSend } = await rigWithCatalog();
  await adminSend('PUT', '/api/admin/economics', { changes: { shipping: { S: { cents: 0, estimate: false } } } });
  await adminSend('PUT', '/api/admin/costs', { variant_gid: V(11), cost_cents: 1000, shipping_class: 'S' });
  await adminSend('PUT', '/api/admin/circle-price/list', { variant_gid: V(11), on_list: true });
  assert.equal(t.rows('SELECT eligible FROM circle_price_items WHERE variant_gid = ?', V(11))[0].eligible, 1);
  await adminSend('PUT', '/api/admin/circle-price/list', { variant_gid: V(11), on_list: false });
  const it = t.rows('SELECT eligible, reason FROM circle_price_items WHERE variant_gid = ?', V(11))[0];
  assert.deepEqual([it.eligible, it.reason], [0, 'not_on_list']);
});

test('T5-A7: the Economics snapshot fails closed and lists what needs data from Felix', async () => {
  const { admin } = await rigWithCatalog();
  const { data } = await admin('/api/admin/economics');
  assert.equal(data.cost_per_credit_ppm, null);
  assert.equal(data.referral.ok, false);
  assert.equal(data.referral.reason, 'needs_cost_data');
  assert.equal(data.anniversary_budget_cents, 0);
  assert.equal(data.profiles.expected.joining_net_cents, 2892);
  assert.equal(data.profiles.expected.monthly_net_cents, 1898);
  assert.equal(data.profiles.expected.monthly_contribution_cents, null);
  const needs = data.needs_data.join(' | ');
  assert.match(needs, /shipping S/);
  assert.match(needs, /cost for 4 variants/); // vase-a ×2, the candle and the capsule (not the gift card, the membership product or the draft)
  assert.match(needs, /welcome pieces/);
});

test('T5-A8: with complete data the snapshot computes c_avg, m, the invitation and the budget', async () => {
  const { admin, adminSend } = await rigWithCatalog();
  await adminSend('PUT', '/api/admin/economics', { changes: { shipping: { S: { cents: 0, estimate: false }, M: { cents: 0, estimate: false }, L: { cents: 0, estimate: false } } } });
  // every active, published, non-gift-card variant has a cost
  for (const [v, cost] of [[11, 1200], [12, 2040], [31, 720], [41, 3600], [51, 0]]) {
    await adminSend('PUT', '/api/admin/costs', { variant_gid: V(v), cost_cents: cost, zero_confirmed: cost === 0, shipping_class: 'S' });
  }
  const { data } = await admin('/api/admin/economics');
  assert.equal(typeof data.cost_per_credit_ppm, 'number');
  assert.ok(data.cost_per_credit_ppm >= 300000);
  assert.equal(typeof data.profiles.worst.monthly_contribution_cents, 'number');
  assert.equal(data.referral.reason, 'needs_welcome_data'); // no welcome pieces yet
  assert.ok(data.anniversary_budget_cents > 0);
});

test('T5-A9: saving invitation amounts that fail rule 3 is refused with the computed explanation', async () => {
  const { t, admin, adminSend } = await rigWithCatalog();
  await adminSend('PUT', '/api/admin/economics', { changes: { shipping: { S: { cents: 0, estimate: false } } } });
  for (const [v, cost] of [[11, 1200], [12, 2040], [31, 720], [41, 3600], [51, 0]]) {
    await adminSend('PUT', '/api/admin/costs', { variant_gid: V(v), cost_cents: cost, zero_confirmed: cost === 0, shipping_class: 'S' });
  }
  // a welcome piece with a known landed cost
  t.env.DB._db.prepare(`INSERT INTO gift_options (id, kind, title, shopify_variant_gid, landed_cost_cents, shipping_class, active, created_at, updated_at)
    VALUES ('g1', 'welcome', 'Sealed', ?, 1500, 'S', 1, 'x', 'x')`).run(V(31));
  const before = (await admin('/api/admin/economics')).data;
  assert.equal(before.referral.ok, true, JSON.stringify(before.referral));
  const r = await adminSend('PUT', '/api/admin/economics', { changes: { referral_reward_cents: 10000 } });
  assert.equal(r.res.status, 422);
  assert.equal(r.data.error.code, 'economics_rule_failed');
  assert.equal(r.data.explanation.ok, false);
  assert.ok(r.data.explanation.terms.lhs_cents > r.data.explanation.terms.rhs_cents);
  assert.equal(typeof r.data.explanation.max_reward_cents, 'number');
  assert.equal((await admin('/api/admin/economics')).data.settings.referral_reward_cents, 1000);
});

test('T5-A10: admin writes need the admin page origin and X-SR-Client: admin; reads need Access', async () => {
  const { adminSend, t } = await rigWithCatalog();
  let r = await adminSend('PUT', '/api/admin/economics', { changes: { min_margin_bps: 1600 } }, { Origin: 'https://club.springrenaissance.store' });
  assert.equal(r.res.status, 403);
  r = await adminSend('PUT', '/api/admin/economics', { changes: { min_margin_bps: 1600 } }, { 'X-SR-Client': 'portal' });
  assert.equal(r.res.status, 403);
  r = await adminSend('PUT', '/api/admin/economics', { changes: { min_margin_bps: 1600 } }, { 'Cf-Access-Jwt-Assertion': 'nope' });
  assert.equal(r.res.status, 403);
  const { get } = await import('./harness.mjs');
  const res = await t.call(get('/api/admin/economics'));
  assert.equal(res.status, 403);
  assert.equal(t.rows('SELECT 1 FROM economics_settings').length, 0);
});

test('T5-A11: the catalog sync without Shopify configured answers 503 and changes nothing', async () => {
  const { adminSend } = await v2Rig({ envOverrides: { SHOPIFY_SHOP: '' } });
  const r = await adminSend('POST', '/api/admin/catalog/sync', {});
  assert.equal(r.res.status, 503);
  assert.equal(API_ORIGIN, 'https://w.dev');
});
