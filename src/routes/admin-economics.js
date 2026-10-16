// Admin: economics, costs, the Circle price list and the catalog sync
// (docs/tz-v2-circle.md §3.3, §5.3, §12). Every write is audited.

import { readJson } from "../http/body.js";
import { badRequest, notFound, serviceUnavailable } from "../http/errors.js";
import { shopifyConfigured } from "../shopify/admin.js";
import { syncCatalog } from "../shopify/catalog.js";
import { economicsSnapshot, exclusionFor, loadSettings, recomputeItems, saveSettings } from "../circle/economics-store.js";
import { checkVariant } from "../circle/economics.js";
import { syncEnabled, syncMemberPrice } from "../circle/member-price.js";

const GID_VARIANT = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const GID_PRODUCT = /^gid:\/\/shopify\/Product\/\d+$/;

async function audit(ctx, action, target, payload = null) {
  await ctx.env.DB.prepare(
    "INSERT INTO admin_audit (id, actor_email, action, target, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  ).bind(ctx.newId(), ctx.admin.email, action, target, payload ? JSON.stringify(payload) : null, ctx.nowIso()).run();
}

// After any change to costs, the list or settings: recompute, then let the
// member-price sync (T6) pick the result up.
export const afterEconomicsChange = { hooks: [(ctx) => syncMemberPrice(ctx)] };
async function recompute(ctx) {
  const { settings } = await loadSettings(ctx.env);
  const out = await recomputeItems(ctx.env, settings, ctx.nowIso());
  for (const hook of afterEconomicsChange.hooks) {
    try { await hook(ctx); } catch (e) { console.error("economics hook failed", e && e.message); }
  }
  return out;
}

export async function getEconomics(ctx) {
  return ctx.json(await economicsSnapshot(ctx.env));
}

export async function putEconomics(ctx) {
  const body = await readJson(ctx.request);
  const result = await saveSettings(ctx, body.changes);
  if (!result.ok) {
    return ctx.json({
      error: { code: "economics_rule_failed", message: "These values would make an invitation cost more than it brings." },
      explanation: result.explanation,
    }, 422);
  }
  for (const hook of afterEconomicsChange.hooks) {
    try { await hook(ctx); } catch (e) { console.error("economics hook failed", e && e.message); }
  }
  return ctx.json({ saved: true, warning: result.warning, economics: await economicsSnapshot(ctx.env) });
}

export async function listCosts(ctx) {
  const { env, url, json } = ctx;
  const q = (url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 100);
  const { settings } = await loadSettings(env);
  const { results } = await env.DB.prepare(
    `SELECT c.variant_gid, c.product_gid, c.handle, c.product_title, c.variant_title, c.price_cents, c.status, c.published,
            c.is_gift_card, c.product_tags, k.cost_cents, k.zero_confirmed, k.shipping_class, k.entered_at,
            CASE WHEN l.variant_gid IS NULL THEN 0 ELSE 1 END AS on_list,
            i.eligible, i.reason, i.circle_price_cents, i.max_cost_cents, i.shipping_estimate
       FROM catalog_variants c
       LEFT JOIN variant_costs k ON k.variant_gid = c.variant_gid
       LEFT JOIN circle_price_list l ON l.variant_gid = c.variant_gid
       LEFT JOIN circle_price_items i ON i.variant_gid = c.variant_gid
      ORDER BY c.handle, c.variant_gid LIMIT 2000`
  ).all();
  const variants = results
    .filter((r) => !q || r.handle.includes(q) || String(r.product_title || "").toLowerCase().includes(q))
    .map((r) => ({
      variant_gid: r.variant_gid, product_gid: r.product_gid, handle: r.handle,
      title: [r.product_title, r.variant_title && r.variant_title !== "Default Title" ? r.variant_title : null].filter(Boolean).join(" — "),
      price_cents: r.price_cents, status: r.status, published: !!r.published, exclusion: exclusionFor(r),
      cost_cents: r.cost_cents === undefined ? null : r.cost_cents, zero_confirmed: !!r.zero_confirmed,
      shipping_class: r.shipping_class || null, on_list: !!r.on_list,
      eligible: !!r.eligible, reason: r.reason || null, circle_price_cents: r.circle_price_cents ?? null,
      max_cost_cents: r.max_cost_cents ?? null, shipping_estimate: r.shipping_estimate === null || r.shipping_estimate === undefined ? null : !!r.shipping_estimate,
    }));
  return json({ variants, shipping: settings.shipping });
}

export async function putCost(ctx) {
  const { env } = ctx;
  const body = await readJson(ctx.request);
  const gid = body.variant_gid;
  if (typeof gid !== "string" || !GID_VARIANT.test(gid)) throw badRequest("invalid_variant", "Unknown variant.");
  const row = await env.DB.prepare("SELECT product_gid FROM catalog_variants WHERE variant_gid = ?1").bind(gid).first();
  if (!row) throw notFound();
  const cost = body.cost_cents === null || body.cost_cents === undefined ? null : body.cost_cents;
  if (cost !== null && (!Number.isInteger(cost) || cost < 0 || cost > 10000000)) throw badRequest("invalid_cost", "Cost must be whole cents.");
  const zero = body.zero_confirmed === true;
  if (cost === 0 && !zero) throw badRequest("zero_cost_needs_confirmation", "A cost of zero must be confirmed — an empty field means not participating.");
  const cls = body.shipping_class === null || body.shipping_class === undefined ? null : body.shipping_class;
  if (cls !== null && !["S", "M", "L"].includes(cls)) throw badRequest("invalid_shipping_class", "Shipping class is S, M or L.");

  await env.DB.prepare(
    `INSERT INTO variant_costs (variant_gid, product_gid, cost_cents, zero_confirmed, shipping_class, entered_by, entered_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(variant_gid) DO UPDATE SET cost_cents = ?3, zero_confirmed = ?4, shipping_class = ?5, entered_by = ?6, entered_at = ?7`
  ).bind(gid, row.product_gid, cost, cost === 0 && zero ? 1 : 0, cls, ctx.admin.email, ctx.nowIso()).run();
  await audit(ctx, "variant_cost_saved", gid, { cost_cents: cost, shipping_class: cls });
  await recompute(ctx);
  const item = await env.DB.prepare("SELECT eligible, reason, circle_price_cents, max_cost_cents FROM circle_price_items WHERE variant_gid = ?1")
    .bind(gid).first();
  return ctx.json({ saved: true, item });
}

export async function putPriceList(ctx) {
  const { env } = ctx;
  const body = await readJson(ctx.request);
  if (typeof body.on_list !== "boolean") throw badRequest("invalid_request", "Say on_list true or false.");
  let gids;
  if (typeof body.variant_gid === "string" && GID_VARIANT.test(body.variant_gid)) {
    const r = await env.DB.prepare("SELECT variant_gid, product_gid FROM catalog_variants WHERE variant_gid = ?1").bind(body.variant_gid).first();
    gids = r ? [r] : [];
  } else if (typeof body.product_gid === "string" && GID_PRODUCT.test(body.product_gid)) {
    gids = (await env.DB.prepare("SELECT variant_gid, product_gid FROM catalog_variants WHERE product_gid = ?1").bind(body.product_gid).all()).results;
  } else {
    throw badRequest("invalid_request", "Name a variant or a product.");
  }
  if (gids.length === 0) throw notFound();
  const stmts = gids.map((g) => (body.on_list
    ? env.DB.prepare("INSERT OR IGNORE INTO circle_price_list (variant_gid, product_gid, added_by, added_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(g.variant_gid, g.product_gid, ctx.admin.email, ctx.nowIso())
    : env.DB.prepare("DELETE FROM circle_price_list WHERE variant_gid = ?1").bind(g.variant_gid)));
  await env.DB.batch(stmts);
  await audit(ctx, "circle_price_list_changed", body.variant_gid || body.product_gid, { on_list: body.on_list, variants: gids.length });
  await recompute(ctx);
  return ctx.json({ saved: true, variants: gids.length });
}

export async function postCatalogSync(ctx) {
  if (!shopifyConfigured(ctx.env)) throw serviceUnavailable("shopify_not_configured");
  const out = await syncCatalog(ctx.env, ctx.fetch, ctx.nowIso(), ctx.newId());
  await audit(ctx, "catalog_synced", "shopify", out);
  const items = await recompute(ctx);
  return ctx.json({ synced: out.variants, eligible: items.eligible });
}

export { checkVariant };

export async function getCirclePriceStatus(ctx) {
  const { env, json } = ctx;
  const discounts = (await env.DB.prepare("SELECT shard, status, customers, variants, last_synced_at, last_error FROM circle_price_discounts ORDER BY shard").all()).results;
  const members = await env.DB.prepare("SELECT COUNT(*) AS n FROM circle_price_grants WHERE revoked_at IS NULL").first();
  const eligible = await env.DB.prepare("SELECT COUNT(*) AS n FROM circle_price_items WHERE eligible = 1").first();
  return json({ sync_enabled: syncEnabled(env), members_with_price: members.n, eligible_variants: eligible.n, discounts });
}

export async function postCirclePriceSync(ctx) {
  if (!syncEnabled(ctx.env)) return ctx.json({ error: { code: "sync_off", message: "The member price sync is switched off (CIRCLE_PRICE_SYNC)." } }, 409);
  const out = await syncMemberPrice(ctx);
  await audit(ctx, "circle_price_synced", "shopify", out);
  return ctx.json(out);
}
