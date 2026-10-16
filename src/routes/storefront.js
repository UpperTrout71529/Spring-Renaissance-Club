// Public endpoints for the storefront (docs/tz-v2-circle.md §5.2, §7.6):
// GET /api/storefront/circle-price?product=<handle> — the Circle price of the
// eligible variants, from the same circle_price_items that feed the Shopify
// discount, and only while that discount is live, so the page never promises a
// price checkout does not give. Cacheable for 5 minutes.
// GET /api/me/storefront — { is_member } for the wording under the price.

import { badRequest } from "../http/errors.js";
import { HANDLE_RE } from "../shopify/products.js";
import { circlePriceLive, isEntitled } from "../circle/member-price.js";

const numericId = (gid) => (/\/(\d+)$/.exec(gid) || [])[1];

export async function getStorefrontCirclePrice(ctx) {
  const { env, url } = ctx;
  const handle = url.searchParams.get("product") || "";
  if (!HANDLE_RE.test(handle)) throw badRequest("invalid_product", "Unknown product.");
  const variants = {};
  if (await circlePriceLive(env)) {
    const { results } = await env.DB.prepare(
      "SELECT variant_gid, price_cents, circle_price_cents FROM circle_price_items WHERE handle = ?1 AND eligible = 1"
    ).bind(handle).all();
    for (const r of results) variants[numericId(r.variant_gid)] = { price_cents: r.price_cents, circle_price_cents: r.circle_price_cents };
  }
  return ctx.json({ variants }, 200, { "Cache-Control": "public, max-age=300" });
}

export async function getMeStorefront(ctx) {
  const s = ctx.session;
  const is = !!s && (await isEntitled(ctx.env, s.user.id, ctx.nowIso()));
  return ctx.json({ is_member: is });
}
