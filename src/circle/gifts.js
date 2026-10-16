// Gift pools (welcome set and anniversary pool) — validation and the options
// a member may choose from (spec v1.1 §7 gift_options, §12 screen 4; Felix
// §18: welcome pieces from Small Pleasures, at least 2, ≤ $25 with shipping).

import { badRequest, HttpError } from "../http/errors.js";
import { shippingFor } from "./economics.js";
import { shopifyConfigured } from "../shopify/admin.js";
import { variantsAvailable } from "../shopify/draft-orders.js";

const GID_VARIANT = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

// Normalises an admin payload (full or partial) on top of `base`.
export function normaliseOption(body, base = {}) {
  const o = { ...base };
  const set = (k, v) => { if (v !== undefined) o[k] = v; };
  if (body.kind !== undefined) {
    if (!["welcome", "anniversary"].includes(body.kind)) throw badRequest("invalid_kind", "Kind is welcome or anniversary.");
    set("kind", body.kind);
  }
  if (body.title !== undefined) {
    const t = typeof body.title === "string" ? body.title.trim() : "";
    if (!t || t.length > 120) throw badRequest("invalid_title", "A title of up to 120 characters.");
    set("title", t);
  }
  if (body.blurb !== undefined) set("blurb", body.blurb === null ? null : String(body.blurb).trim().slice(0, 500) || null);
  if (body.shopify_variant_gid !== undefined) {
    if (typeof body.shopify_variant_gid !== "string" || !GID_VARIANT.test(body.shopify_variant_gid)) throw badRequest("invalid_variant", "A Shopify variant id.");
    set("shopify_variant_gid", body.shopify_variant_gid);
  }
  if (body.image_url !== undefined) {
    if (body.image_url !== null && !/^https:\/\/[^\s"'<>]+$/.test(String(body.image_url))) throw badRequest("invalid_image", "An https image link.");
    set("image_url", body.image_url);
  }
  if (body.landed_cost_cents !== undefined) {
    const c = body.landed_cost_cents;
    if (c !== null && (!Number.isInteger(c) || c < 0 || c > 10000000)) throw badRequest("invalid_cost", "Landed cost in whole cents.");
    set("landed_cost_cents", c);
  }
  if (body.shipping_class !== undefined) {
    if (body.shipping_class !== null && !["S", "M", "L"].includes(body.shipping_class)) throw badRequest("invalid_shipping_class", "Shipping class is S, M or L.");
    set("shipping_class", body.shipping_class);
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") throw badRequest("invalid_active", "Active is true or false.");
    set("active", body.active ? 1 : 0);
  }
  if (body.sort !== undefined) {
    if (!Number.isInteger(body.sort)) throw badRequest("invalid_sort", "Sort is a whole number.");
    set("sort", body.sort);
  }
  for (const k of ["kind", "title", "shopify_variant_gid"]) if (o[k] === undefined || o[k] === null) throw badRequest("missing_field", `${k} is required.`);
  o.active = o.active ? 1 : 0;
  o.sort = o.sort || 0;
  return o;
}

// The welcome cap: landed + shipping of its class ≤ welcome_cap_cents.
export function welcomeCheck(o, settings) {
  const ship = shippingFor(o.shipping_class, settings);
  if (!Number.isInteger(o.landed_cost_cents)) return { ok: false, code: "needs_landed_cost" };
  if (!ship) return { ok: false, code: "needs_shipping" };
  const ok = o.landed_cost_cents + ship.cents <= settings.welcome_cap_cents;
  return { ok, code: ok ? null : "welcome_over_cap", explanation: { landed_cost_cents: o.landed_cost_cents, shipping_cents: ship.cents, cap_cents: settings.welcome_cap_cents } };
}

// Throws unless an option may be saved as given.
export async function assertSavable(env, o, settings) {
  if (o.active && !Number.isInteger(o.landed_cost_cents)) throw badRequest("needs_landed_cost", "An active option needs its landed cost.");
  if (o.active && !o.shipping_class) throw badRequest("needs_shipping_class", "An active option needs a shipping class.");
  if (o.kind === "welcome") {
    const snapshot = await env.DB.prepare("SELECT COUNT(*) AS n FROM catalog_variants").first();
    if (snapshot.n > 0) {
      const v = await env.DB.prepare("SELECT product_tags FROM catalog_variants WHERE variant_gid = ?1").bind(o.shopify_variant_gid).first();
      if (!v) throw badRequest("unknown_variant", "That variant is not in the catalog.");
      let tags = [];
      try { tags = JSON.parse(v.product_tags || "[]"); } catch { tags = []; }
      if (!tags.includes("catalog")) throw badRequest("welcome_must_be_small_pleasures", "Welcome pieces come from Small Pleasures.");
    }
    if (o.active) {
      const c = welcomeCheck(o, settings);
      if (!c.ok) {
        const err = new HttpError(422, c.code, c.code === "needs_shipping"
          ? "Enter the shipping for this class first."
          : "With shipping this piece costs more than the welcome cap.");
        err.explanation = c.explanation;
        throw err;
      }
    }
  }
}

// Active welcome options within the cap, available in Shopify (when it can be asked).
export async function welcomeOptions(ctx, settings) {
  const { env } = ctx;
  const { results } = await env.DB.prepare(
    "SELECT id, title, blurb, image_url, shopify_variant_gid, landed_cost_cents, shipping_class FROM gift_options WHERE kind = 'welcome' AND active = 1 ORDER BY sort, title"
  ).all();
  let list = results.filter((o) => welcomeCheck(o, settings).ok);
  if (list.length && shopifyConfigured(env)) {
    try {
      const avail = await variantsAvailable(env, ctx.fetch, list.map((o) => o.shopify_variant_gid));
      list = list.filter((o) => avail.get(o.shopify_variant_gid));
    } catch (e) {
      console.error("welcome availability check failed", e && e.message);
    }
  }
  return list;
}
