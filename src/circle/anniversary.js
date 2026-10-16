// The anniversary gift (docs/tz-v2-circle.md §10; Felix §19 #5).
//
// Count: the paid invoices of one subscription. A failed payment that is
// paid within the retries keeps the count (Felix); the end of the
// subscription ends it, and a rejoin is a new subscription that starts from
// zero. Anniversary n is reached when paid invoice 12n + 1 arrives — the
// renewal that opens month 13, 25, …  One gift per (membership, n), whatever
// order or number of times the events arrive (unique key).
//
// Budget (rule 4) decides which pool options are allowed; budget 0 or nothing
// within it → skipped_budget, visible to Felix, nothing promised to the member.

import { badRequest, conflict, HttpError, notFound } from "../http/errors.js";
import { loadSettings, economicsBasis } from "./economics-store.js";
import { anniversaryBudget, shippingFor } from "./economics.js";
import { emailUser } from "./notify.js";
import { shopifyConfigured } from "../shopify/admin.js";
import { completeDraftOrder, createDraftOrder, draftOrderState } from "../shopify/draft-orders.js";

export async function poolWithinBudget(env, settings, budget) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM gift_options WHERE kind = 'anniversary' AND active = 1 ORDER BY sort, title"
  ).all();
  return results.filter((o) => {
    const ship = shippingFor(o.shipping_class, settings);
    return ship && Number.isInteger(o.landed_cost_cents) && o.landed_cost_cents + ship.cents <= budget;
  });
}

// circleHooks.invoicePaid
export async function anniversaryOnPaid(svc, { membership }) {
  const { env } = svc;
  const m = await env.DB.prepare("SELECT * FROM memberships WHERE id = ?1").bind(membership.id).first();
  if (!m || !["active", "canceling", "past_due"].includes(m.status)) return;
  const reached = Math.floor((m.paid_invoices - 1) / 12);
  if (reached < 1) return;
  const existing = (await env.DB.prepare("SELECT n FROM anniversary_gifts WHERE membership_id = ?1").bind(m.id).all()).results.map((g) => g.n);
  const missing = [];
  for (let n = 1; n <= reached; n++) if (!existing.includes(n)) missing.push(n);
  if (!missing.length) return;

  const { settings } = await loadSettings(env);
  const basis = await economicsBasis(env, settings);
  const budget = anniversaryBudget(basis.kPpm, settings);
  const options = budget > 0 ? await poolWithinBudget(env, settings, budget) : [];
  const join = await env.DB.prepare(
    "SELECT shipping_json FROM gift_selections WHERE user_id = ?1 AND shipping_json IS NOT NULL ORDER BY created_at DESC LIMIT 1"
  ).bind(m.user_id).first();
  const nowIso = svc.nowIso();
  for (const n of missing) {
    const skipped = budget <= 0 ? "budget_zero" : options.length === 0 ? "no_option_within_budget" : null;
    const id = svc.newId();
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO anniversary_gifts (id, membership_id, user_id, streak_start, n, status, budget_cents, gift_option_id, shipping_json, reason, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`
    ).bind(id, m.id, m.user_id, m.started_at || m.created_at, n, skipped ? "skipped_budget" : "awaiting_address", budget,
      !skipped && options.length === 1 ? options[0].id : null, skipped ? null : (join ? join.shipping_json : null), skipped, nowIso).run();
    if (res.meta && res.meta.changes === 1 && !skipped) {
      svc.waitUntil(emailUser(svc, m.user_id, "anniversary", `anniversary:${m.id}:${n}`, {}));
    }
  }
}

// ---- member ------------------------------------------------------------------------

const waiting = (env, userId) => env.DB.prepare(
  `SELECT g.* FROM anniversary_gifts g WHERE g.user_id = ?1 AND g.status IN ('awaiting_address','ready','order_created')
    ORDER BY g.n DESC, g.created_at DESC LIMIT 1`
).bind(userId).first();

const publicGift = (g) => g && ({
  id: g.id, n: g.n, status: g.status,
  address: g.shipping_json ? (JSON.parse(g.shipping_json).address || null) : null,
  name: g.shipping_json ? (JSON.parse(g.shipping_json).name || null) : null,
});

export async function getAnniversary(ctx) {
  return ctx.json({ gift: publicGift(await waiting(ctx.env, ctx.session.user.id)) });
}

function usAddress(a) {
  const s = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const out = {
    name: s(a && a.name, 100), line1: s(a && a.line1, 120), line2: s(a && a.line2, 120) || null,
    city: s(a && a.city, 80), state: s(a && a.state, 2).toUpperCase(), postal_code: s(a && a.postal_code, 10), country: s(a && a.country, 2).toUpperCase(),
  };
  if (!out.name || !out.line1 || !out.city || !/^[A-Z]{2}$/.test(out.state) || !/^\d{5}(-\d{4})?$/.test(out.postal_code) || out.country !== "US") {
    throw badRequest("invalid_address", "Please enter a full US address.");
  }
  return out;
}

export async function postAnniversary(ctx) {
  const { env, session } = ctx;
  const body = await (await import("../http/body.js")).readJson(ctx.request);
  const a = usAddress(body.address);
  const g = await waiting(env, session.user.id);
  if (!g || !["awaiting_address", "ready"].includes(g.status)) throw conflict("no_gift_waiting", "There is no gift waiting for an address.");
  const shipping = { name: a.name, address: { line1: a.line1, line2: a.line2, city: a.city, state: a.state, postal_code: a.postal_code, country: a.country } };
  await env.DB.prepare("UPDATE anniversary_gifts SET shipping_json = ?1, status = 'ready', updated_at = ?2 WHERE id = ?3 AND status IN ('awaiting_address','ready')")
    .bind(JSON.stringify(shipping), ctx.nowIso(), g.id).run();
  return ctx.json({ status: "ready" });
}

// ---- admin ----------------------------------------------------------------------------

export async function anniversaryQueue(ctx) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT g.id, g.n, g.status, g.reason, g.budget_cents, g.shipping_json IS NOT NULL AS has_address, g.created_at, g.shopify_order_gid,
            u.email, o.title AS option_title
       FROM anniversary_gifts g JOIN users u ON u.id = g.user_id LEFT JOIN gift_options o ON o.id = g.gift_option_id
      WHERE g.status <> 'canceled' ORDER BY g.created_at`
  ).all();
  return { key: "anniversary", value: results.map((r) => ({ ...r, has_address: !!r.has_address })) };
}

async function audit(ctx, action, target, payload = null) {
  await ctx.env.DB.prepare(
    "INSERT INTO admin_audit (id, actor_email, action, target, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  ).bind(ctx.newId(), ctx.admin.email, action, target, payload ? JSON.stringify(payload) : null, ctx.nowIso()).run();
}

export async function assignAnniversary(ctx) {
  const { env, params } = ctx;
  const body = await (await import("../http/body.js")).readJson(ctx.request);
  const g = await env.DB.prepare("SELECT * FROM anniversary_gifts WHERE id = ?1").bind(params.id).first();
  if (!g) throw notFound();
  if (!["awaiting_address", "ready"].includes(g.status)) throw conflict("not_open", "This gift is not waiting.");
  const { settings } = await loadSettings(env);
  const options = await poolWithinBudget(env, settings, g.budget_cents || 0);
  if (!options.some((o) => o.id === body.gift_option_id)) throw conflict("over_budget", "Choose an active option within this gift's budget.");
  await env.DB.prepare("UPDATE anniversary_gifts SET gift_option_id = ?1, updated_at = ?2 WHERE id = ?3").bind(body.gift_option_id, ctx.nowIso(), g.id).run();
  await audit(ctx, "anniversary_assigned", g.id, { gift_option_id: body.gift_option_id });
  return ctx.json({ assigned: true });
}

export async function createAnniversaryOrder(ctx) {
  const { env, params } = ctx;
  const g = await env.DB.prepare(
    `SELECT g.*, o.shopify_variant_gid, u.shopify_customer_id FROM anniversary_gifts g
       LEFT JOIN gift_options o ON o.id = g.gift_option_id JOIN users u ON u.id = g.user_id WHERE g.id = ?1`
  ).bind(params.id).first();
  if (!g) throw notFound();
  if (g.status !== "ready") throw conflict("not_ready", g.status === "order_created" ? "The order already exists." : "The member has not confirmed the address yet.");
  if (!g.shopify_variant_gid) throw conflict("no_option", "Choose the gift first.");
  if (!shopifyConfigured(env)) throw new HttpError(503, "shopify_not_configured", "Shopify is not configured here.");
  const claim = await env.DB.prepare("UPDATE anniversary_gifts SET status = 'order_created', updated_at = ?1 WHERE id = ?2 AND status = 'ready'")
    .bind(ctx.nowIso(), g.id).run();
  if (!claim.meta || claim.meta.changes !== 1) throw conflict("not_ready", "The order already exists.");
  try {
    let draftId = g.shopify_draft_gid;
    let orderId = null;
    if (draftId) {
      const st = await draftOrderState(env, ctx.fetch, draftId);
      if (st && st.orderId) orderId = st.orderId;
      else if (!st) draftId = null;
    }
    if (!draftId) {
      const draft = await createDraftOrder(env, ctx.fetch, {
        customerId: g.shopify_customer_id || null,
        lines: [{ variantId: g.shopify_variant_gid, quantity: 1, free: "Circle anniversary" }],
        shipping: JSON.parse(g.shipping_json),
        shippingTitle: "Circle anniversary",
        tags: ["circle-anniversary"],
        note: `Circle anniversary ${g.n} · ${g.id}`,
      });
      draftId = draft.id;
      await env.DB.prepare("UPDATE anniversary_gifts SET shopify_draft_gid = ?1 WHERE id = ?2").bind(draftId, g.id).run();
    }
    if (!orderId) orderId = await completeDraftOrder(env, ctx.fetch, draftId);
    await env.DB.prepare("UPDATE anniversary_gifts SET shopify_order_gid = ?1, updated_at = ?2 WHERE id = ?3").bind(orderId, ctx.nowIso(), g.id).run();
    await audit(ctx, "anniversary_order_created", g.id, { order: orderId });
    return ctx.json({ status: "order_created", shopify_order_gid: orderId });
  } catch (e) {
    await env.DB.prepare("UPDATE anniversary_gifts SET status = 'ready', needs_attention = 1, updated_at = ?1 WHERE id = ?2").bind(ctx.nowIso(), g.id).run();
    console.error("anniversary order failed", e && e.message);
    throw new HttpError(502, "shopify_order_failed", "Shopify did not create the order. Check Shopify before trying again.");
  }
}
