// The member price, kept true in Shopify (docs/tz-v2-circle.md §7.3, §7.4).
//
// Who: a member whose membership is active, or canceling before its period
// end (D1 time — no wait for Stripe), with no open dispute, and with a Shopify
// customer. What: the variants circle_price_items marks eligible (rule 2).
//
// Grants (D1) are the truth; the discounts in Shopify follow them. One
// discount per shard of members (CIRCLE_PRICE_SHARD_SIZE, default 50 — the
// spike sets the real cap). A shard with nobody in it, or an empty variant
// list, is deactivated — never left active with an empty customer list,
// which Shopify could read as "everyone".
//
// Nothing is sent to Shopify unless CIRCLE_PRICE_SYNC = "on" (after the spike
// on a development store, Felix's §19 #1).

import { shopifyConfigured } from "../shopify/admin.js";
import { createCirclePrice, readCirclePrice, setCirclePriceActive, updateCirclePrice } from "../shopify/discounts.js";

export const TITLE = "Circle price";

export function syncEnabled(env) {
  return env.CIRCLE_PRICE_SYNC === "on" && shopifyConfigured(env);
}

const shardSize = (env) => Math.min(1000, Math.max(1, Number.parseInt(env.CIRCLE_PRICE_SHARD_SIZE || "50", 10) || 50));

const ENTITLED = `
  SELECT u.id AS user_id, u.shopify_customer_id AS customer FROM users u
   WHERE u.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id
                  AND (m.status = 'active' OR (m.status = 'canceling' AND (m.current_period_end IS NULL OR m.current_period_end > ?1))))
     AND NOT EXISTS (SELECT 1 FROM memberships f WHERE f.user_id = u.id AND f.credits_frozen = 1)`;

export async function isEntitled(env, userId, nowIso) {
  const row = await env.DB.prepare(`${ENTITLED} AND u.id = ?2`).bind(nowIso, userId).first();
  return !!row;
}

// Makes the open grants match who is entitled now. Returns { granted, revoked }.
export async function refreshGrants(svc) {
  const { env } = svc;
  const nowIso = svc.nowIso();
  const entitled = (await env.DB.prepare(`${ENTITLED} AND u.shopify_customer_id IS NOT NULL`).bind(nowIso).all()).results;
  const want = new Map(entitled.map((e) => [e.user_id, e.customer]));
  const open = (await env.DB.prepare("SELECT id, user_id, shopify_customer_gid, shard FROM circle_price_grants WHERE revoked_at IS NULL").all()).results;
  const stmts = [];
  const kept = [];
  for (const g of open) {
    if (want.get(g.user_id) === g.shopify_customer_gid) { kept.push(g); continue; }
    stmts.push(env.DB.prepare("UPDATE circle_price_grants SET revoked_at = ?1, revoke_reason = ?2 WHERE id = ?3")
      .bind(nowIso, want.has(g.user_id) ? "customer_changed" : "not_entitled", g.id));
  }
  const size = shardSize(env);
  const counts = new Map();
  for (const g of kept) counts.set(g.shard, (counts.get(g.shard) || 0) + 1);
  const keptUsers = new Set(kept.map((g) => g.user_id));
  let granted = 0;
  for (const [userId, customer] of want) {
    if (keptUsers.has(userId)) continue;
    let shard = 0;
    while ((counts.get(shard) || 0) >= size) shard++;
    counts.set(shard, (counts.get(shard) || 0) + 1);
    stmts.push(env.DB.prepare(
      "INSERT INTO circle_price_grants (id, user_id, shopify_customer_gid, shard, granted_at) VALUES (?1, ?2, ?3, ?4, ?5)"
    ).bind(svc.newId(), userId, customer, shard, nowIso));
    granted++;
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { granted, revoked: open.length - kept.length };
}

const titleFor = (shard) => (shard === 0 ? TITLE : `${TITLE} · ${shard + 1}`);
const diff = (want, have) => ({ add: want.filter((x) => !have.includes(x)), remove: have.filter((x) => !want.includes(x)) });

export async function syncMemberPrice(svc) {
  const { env } = svc;
  if (!syncEnabled(env)) return { skipped: "off" };
  const grants = await refreshGrants(svc);
  const nowIso = svc.nowIso();
  const variants = (await env.DB.prepare("SELECT variant_gid FROM circle_price_items WHERE eligible = 1 ORDER BY variant_gid").all())
    .results.map((r) => r.variant_gid);
  const open = (await env.DB.prepare("SELECT shopify_customer_gid, shard FROM circle_price_grants WHERE revoked_at IS NULL").all()).results;
  const byShard = new Map();
  for (const g of open) byShard.set(g.shard, [...(byShard.get(g.shard) || []), g.shopify_customer_gid]);
  const rows = (await env.DB.prepare("SELECT * FROM circle_price_discounts").all()).results;
  const rowOf = new Map(rows.map((r) => [r.shard, r]));
  const shards = [...new Set([...byShard.keys(), ...rowOf.keys()])].sort((a, b) => a - b);
  const out = { ...grants, shards: shards.length, errors: 0 };

  for (const shard of shards) {
    const customers = (byShard.get(shard) || []).slice().sort();
    let row = rowOf.get(shard);
    const save = (fields) => env.DB.prepare(
      `INSERT INTO circle_price_discounts (id, shard, shopify_discount_gid, status, customers, variants, last_synced_at, last_error, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?7)
       ON CONFLICT(shard) DO UPDATE SET shopify_discount_gid = ?3, status = ?4, customers = ?5, variants = ?6, last_synced_at = ?7, last_error = ?8`
    ).bind(row ? row.id : svc.newId(), shard, fields.gid, fields.status, fields.customers, fields.variants, nowIso, fields.error || null).run();
    try {
      if (customers.length === 0 || variants.length === 0) {
        if (row && row.shopify_discount_gid && row.status !== "inactive") {
          await setCirclePriceActive(env, svc.fetch, row.shopify_discount_gid, false);
          await save({ gid: row.shopify_discount_gid, status: "inactive", customers: customers.length, variants: variants.length });
        }
        continue;
      }
      let current = row && row.shopify_discount_gid ? await readCirclePrice(env, svc.fetch, row.shopify_discount_gid) : null;
      if (!current) {
        const gid = await createCirclePrice(env, svc.fetch, { title: titleFor(shard), startsAt: nowIso, customers, variants });
        await save({ gid, status: "active", customers: customers.length, variants: variants.length });
        continue;
      }
      const c = diff(customers, current.customers);
      const v = diff(variants, current.variants);
      await updateCirclePrice(env, svc.fetch, row.shopify_discount_gid,
        { addCustomers: c.add, removeCustomers: c.remove, addVariants: v.add, removeVariants: v.remove });
      if (current.status !== "ACTIVE") await setCirclePriceActive(env, svc.fetch, row.shopify_discount_gid, true);
      await save({ gid: row.shopify_discount_gid, status: "active", customers: customers.length, variants: variants.length });
    } catch (e) {
      out.errors++;
      console.error("circle price sync failed", shard, e && e.message);
      await save({ gid: row ? row.shopify_discount_gid : null, status: "error", customers: customers.length, variants: variants.length,
        error: String((e && e.message) || "error").slice(0, 200) }).catch(() => {});
    }
  }
  return out;
}

// The storefront may show a Circle price only while Shopify really gives it.
export async function circlePriceLive(env) {
  if (!syncEnabled(env)) return false;
  const row = await env.DB.prepare("SELECT 1 AS yes FROM circle_price_discounts WHERE status = 'active' LIMIT 1").first();
  return !!row;
}
