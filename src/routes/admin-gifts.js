// Admin: gift pools and the gift queue (spec v1.1 §8.6, §12 screens 4–5,
// §9.2.6; docs/tz-v2-circle.md §3.3). Orders are created only when Felix
// presses the button; each creation claims the row first, so a double click
// makes one order. Every write is audited.

import { readJson } from "../http/body.js";
import { HttpError, conflict, notFound, serviceUnavailable } from "../http/errors.js";
import { shopifyConfigured } from "../shopify/admin.js";
import { completeDraftOrder, createDraftOrder, draftOrderState } from "../shopify/draft-orders.js";
import { loadSettings, economicsBasis } from "../circle/economics-store.js";
import { anniversaryBudget, shippingFor } from "../circle/economics.js";
import { assertSavable, normaliseOption, welcomeCheck } from "../circle/gifts.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ASSIGN_AFTER_DAYS = 14;

async function audit(ctx, action, target, payload = null) {
  await ctx.env.DB.prepare(
    "INSERT INTO admin_audit (id, actor_email, action, target, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  ).bind(ctx.newId(), ctx.admin.email, action, target, payload ? JSON.stringify(payload) : null, ctx.nowIso()).run();
}

const publicOption = (o) => ({
  id: o.id, kind: o.kind, title: o.title, blurb: o.blurb, shopify_variant_gid: o.shopify_variant_gid, image_url: o.image_url,
  landed_cost_cents: o.landed_cost_cents, shipping_class: o.shipping_class, active: !!o.active, sort: o.sort,
});

export async function listGiftOptions(ctx) {
  const { env, url, json } = ctx;
  const kind = url.searchParams.get("kind");
  const { settings } = await loadSettings(env);
  const b = await economicsBasis(env, settings);
  const budget = anniversaryBudget(b.kPpm, settings);
  const { results } = await env.DB.prepare(
    `SELECT * FROM gift_options ${kind === "welcome" || kind === "anniversary" ? "WHERE kind = ?1" : ""} ORDER BY kind DESC, sort, title`
  ).bind(...(kind === "welcome" || kind === "anniversary" ? [kind] : [])).all();
  return json({
    anniversary_budget_cents: budget,
    options: results.map((o) => {
      const ship = shippingFor(o.shipping_class, settings);
      return {
        ...publicOption(o),
        shipping_cents: ship ? ship.cents : null,
        within_cap: o.kind === "welcome" ? welcomeCheck(o, settings).ok : null,
        within_budget: o.kind === "anniversary"
          ? (Number.isInteger(o.landed_cost_cents) && ship ? o.landed_cost_cents + ship.cents <= budget : false) : null,
      };
    }),
  });
}

function explain(e) {
  if (e instanceof HttpError && e.explanation) return e;
  return e;
}

export async function createGiftOption(ctx) {
  const { env } = ctx;
  const body = await readJson(ctx.request);
  const o = normaliseOption(body);
  const { settings } = await loadSettings(env);
  try {
    await assertSavable(env, o, settings);
  } catch (e) {
    throw explain(e);
  }
  const id = ctx.newId();
  const nowIso = ctx.nowIso();
  await env.DB.prepare(
    `INSERT INTO gift_options (id, kind, title, blurb, shopify_variant_gid, image_url, landed_cost_cents, shipping_class, active, sort, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`
  ).bind(id, o.kind, o.title, o.blurb ?? null, o.shopify_variant_gid, o.image_url ?? null, o.landed_cost_cents ?? null,
    o.shipping_class ?? null, o.active, o.sort, nowIso).run();
  await audit(ctx, "gift_option_saved", id, publicOption({ ...o, id }));
  return ctx.json({ option: publicOption({ ...o, id }) }, 201);
}

export async function patchGiftOption(ctx) {
  const { env, params } = ctx;
  const existing = await env.DB.prepare("SELECT * FROM gift_options WHERE id = ?1").bind(params.id).first();
  if (!existing) throw notFound();
  const body = await readJson(ctx.request);
  const o = normaliseOption(body, existing);
  const { settings } = await loadSettings(env);
  await assertSavable(env, o, settings);
  await env.DB.prepare(
    `UPDATE gift_options SET kind = ?1, title = ?2, blurb = ?3, shopify_variant_gid = ?4, image_url = ?5, landed_cost_cents = ?6,
       shipping_class = ?7, active = ?8, sort = ?9, updated_at = ?10 WHERE id = ?11`
  ).bind(o.kind, o.title, o.blurb ?? null, o.shopify_variant_gid, o.image_url ?? null, o.landed_cost_cents ?? null,
    o.shipping_class ?? null, o.active, o.sort, ctx.nowIso(), params.id).run();
  await audit(ctx, "gift_option_saved", params.id, publicOption({ ...o, id: params.id }));
  return ctx.json({ option: publicOption({ ...o, id: params.id }) });
}

// Later tasks add queues (anniversary): (ctx) → { key, value }.
export const giftQueues = [];

export async function getGiftQueue(ctx) {
  const { env, json } = ctx;
  const nowMs = ctx.now();
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.status, s.created_at, s.chosen_at, s.needs_attention, s.shopify_order_gid, s.shipping_json IS NOT NULL AS has_address,
            u.email, u.first_name, u.last_name, o.title AS option_title
       FROM gift_selections s JOIN users u ON u.id = s.user_id LEFT JOIN gift_options o ON o.id = s.gift_option_id
      WHERE s.status IN ('awaiting_choice','chosen','order_created') ORDER BY s.created_at`
  ).all();
  const out = {
    welcome: results.map((r) => ({
      id: r.id, status: r.status, email: r.email, name: [r.first_name, r.last_name].filter(Boolean).join(" ") || null,
      option_title: r.option_title, has_address: !!r.has_address, needs_attention: !!r.needs_attention,
      days_waiting: Math.floor((nowMs - Date.parse(r.created_at)) / DAY_MS), can_assign: r.status === "awaiting_choice"
        && nowMs - Date.parse(r.created_at) >= ASSIGN_AFTER_DAYS * DAY_MS,
      shopify_order_gid: r.shopify_order_gid,
    })),
  };
  for (const q of giftQueues) {
    const s = await q(ctx);
    if (s) out[s.key] = s.value;
  }
  return json(out);
}

export async function assignGift(ctx) {
  const { env, params } = ctx;
  const body = await readJson(ctx.request);
  const sel = await env.DB.prepare("SELECT * FROM gift_selections WHERE id = ?1").bind(params.id).first();
  if (!sel) throw notFound();
  if (sel.status !== "awaiting_choice") throw conflict("already_chosen", "This piece has already been chosen.");
  if (ctx.now() - Date.parse(sel.created_at) < ASSIGN_AFTER_DAYS * DAY_MS) throw conflict("too_early", "The member has 14 days to choose.");
  const opt = await env.DB.prepare("SELECT * FROM gift_options WHERE id = ?1 AND kind = 'welcome' AND active = 1").bind(body.gift_option_id).first();
  const { settings } = await loadSettings(env);
  if (!opt || !welcomeCheck(opt, settings).ok) throw conflict("option_unavailable", "Choose an active welcome piece within the cap.");
  await env.DB.prepare(
    "UPDATE gift_selections SET gift_option_id = ?1, status = 'chosen', chosen_at = ?2, updated_at = ?2 WHERE id = ?3 AND status = 'awaiting_choice'"
  ).bind(opt.id, ctx.nowIso(), sel.id).run();
  await audit(ctx, "welcome_assigned", sel.id, { gift_option_id: opt.id });
  return ctx.json({ status: "chosen" });
}

export async function createGiftOrder(ctx) {
  const { env, params } = ctx;
  const sel = await env.DB.prepare(
    `SELECT s.*, o.shopify_variant_gid, u.shopify_customer_id FROM gift_selections s
       JOIN gift_options o ON o.id = s.gift_option_id JOIN users u ON u.id = s.user_id WHERE s.id = ?1`
  ).bind(params.id).first();
  if (!sel) throw notFound();
  if (sel.status !== "chosen") throw conflict("not_ready", sel.status === "order_created" ? "The order already exists." : "No piece has been chosen yet.");
  if (!sel.shipping_json) throw conflict("needs_address", "There is no delivery address for this piece.");
  if (!shopifyConfigured(env)) throw new HttpError(503, "shopify_not_configured", "Shopify is not configured here.");
  // Claim first: a second click finds the row no longer 'chosen'.
  const claim = await env.DB.prepare("UPDATE gift_selections SET status = 'order_created', updated_at = ?1 WHERE id = ?2 AND status = 'chosen'")
    .bind(ctx.nowIso(), sel.id).run();
  if (!claim.meta || claim.meta.changes !== 1) throw conflict("not_ready", "The order already exists.");
  try {
    // Review finding 8: a retry after a failed completion finishes the same draft.
    let draftId = sel.shopify_draft_gid;
    let orderId = null;
    if (draftId) {
      const st = await draftOrderState(env, ctx.fetch, draftId);
      if (st && st.orderId) orderId = st.orderId;
      else if (!st) draftId = null;
    }
    if (!draftId) {
      const draft = await createDraftOrder(env, ctx.fetch, {
        customerId: sel.shopify_customer_id || null,
        lines: [{ variantId: sel.shopify_variant_gid, quantity: 1, free: "Circle welcome piece" }],
        shipping: JSON.parse(sel.shipping_json),
        shippingTitle: "Circle welcome",
        tags: ["circle-welcome"],
        note: `Circle welcome piece · ${sel.id}`,
      });
      draftId = draft.id;
      await env.DB.prepare("UPDATE gift_selections SET shopify_draft_gid = ?1 WHERE id = ?2").bind(draftId, sel.id).run();
    }
    if (!orderId) orderId = await completeDraftOrder(env, ctx.fetch, draftId);
    await env.DB.prepare("UPDATE gift_selections SET shopify_order_gid = ?1, updated_at = ?2 WHERE id = ?3").bind(orderId, ctx.nowIso(), sel.id).run();
    await audit(ctx, "welcome_order_created", sel.id, { order: orderId });
    return ctx.json({ status: "order_created", shopify_order_gid: orderId });
  } catch (e) {
    await env.DB.prepare("UPDATE gift_selections SET status = 'chosen', needs_attention = 1, updated_at = ?1 WHERE id = ?2").bind(ctx.nowIso(), sel.id).run();
    console.error("welcome order failed", e && e.message);
    throw new HttpError(502, "shopify_order_failed", "Shopify did not create the order. Check Shopify for a draft noted with this piece before trying again.");
  }
}
