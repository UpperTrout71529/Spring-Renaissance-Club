// Saved (wishlist) and Held for you (spec §8.3, §6.5, §9.2.7; S7).
// D1 holds what the person saved or asked us to hold; Shopify supplies the
// product data (title, image, price, availability).

import { HttpError, badRequest, notFound } from "../http/errors.js";
import { readJson } from "../http/body.js";
import { recordEvent } from "../lib/events.js";
import { shopifyConfigured } from "../shopify/admin.js";
import { HANDLE_RE, productByHandle, productsByIds } from "../shopify/products.js";
import { fetchCustomerOrders } from "../shopify/orders.js";
import { cached } from "../lib/kv-cache.js";
import { customerIdOf } from "./orders.js";

const unavailable = () =>
  new HttpError(503, "saved_unavailable", "We couldn't load your saved pieces right now. Please try again in a moment.");

function readHandle(value) {
  const handle = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!HANDLE_RE.test(handle)) throw badRequest("invalid_product", "This piece can't be saved.");
  return handle;
}

const sourceOf = (body) => (body.source === "storefront" ? "storefront" : "portal");

// Resolves a storefront handle to an active product, or 404.
async function activeProduct(ctx, handle) {
  if (!shopifyConfigured(ctx.env)) throw unavailable();
  let product;
  try {
    product = await productByHandle(ctx.env, ctx.fetch, handle);
  } catch (e) {
    console.error("saved: shopify failed", e && e.message);
    throw unavailable();
  }
  if (!product) throw notFound();
  return product;
}

// POST /api/wishlist { product_handle, variant_gid?, source? } → 201, idempotent.
export async function addToWishlist(ctx) {
  const { env, session, json } = ctx;
  const body = await readJson(ctx.request);
  const handle = readHandle(body.product_handle);
  const product = await activeProduct(ctx, handle);
  const variant = typeof body.variant_gid === "string" && /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(body.variant_gid)
    ? body.variant_gid : null;

  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO wishlist_items (user_id, product_gid, variant_gid, product_handle, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  ).bind(session.user.id, product.id, variant, product.handle, ctx.nowIso()).run();
  if (res.meta && res.meta.changes === 1) {
    await recordEvent(env, {
      id: ctx.newId(), userId: session.user.id, name: "wishlist_added",
      props: { product_handle: product.handle, source: sourceOf(body) }, createdAt: ctx.nowIso(),
    });
  }
  return json({ item: { product_handle: product.handle } }, 201);
}

// DELETE /api/wishlist/:product_handle → 204, idempotent.
export async function removeFromWishlist(ctx) {
  const handle = readHandle(ctx.params.product_handle);
  const res = await ctx.env.DB.prepare("DELETE FROM wishlist_items WHERE user_id = ?1 AND product_handle = ?2")
    .bind(ctx.session.user.id, handle).run();
  if (res.meta && res.meta.changes > 0) {
    await recordEvent(ctx.env, {
      id: ctx.newId(), userId: ctx.session.user.id, name: "wishlist_removed",
      props: { product_handle: handle, source: "portal" }, createdAt: ctx.nowIso(),
    });
  }
  return new Response(null, { status: 204 });
}

// GET /api/wishlist/handles → { handles } — D1 only, cheap enough for the
// storefront's heart buttons to ask on every product page.
export async function wishlistHandles(ctx) {
  const rows = await ctx.env.DB.prepare("SELECT product_handle FROM wishlist_items WHERE user_id = ?1")
    .bind(ctx.session.user.id).all();
  return ctx.json({ handles: rows.results.map((r) => r.product_handle) });
}

// GET /api/wishlist → { items: [{ product_handle, title, image_url, price_cents, currency, url, available }] }
export async function listWishlist(ctx) {
  const { env, session, json } = ctx;
  const rows = (await env.DB.prepare(
    "SELECT product_gid, product_handle, created_at FROM wishlist_items WHERE user_id = ?1 ORDER BY created_at DESC"
  ).bind(session.user.id).all()).results;
  if (!rows.length) return json({ items: [] });
  if (!shopifyConfigured(env)) throw unavailable();

  let products;
  try {
    products = await productsByIds(env, ctx.fetch, rows.map((r) => r.product_gid));
  } catch (e) {
    console.error("wishlist: shopify failed", e && e.message);
    throw unavailable();
  }
  return json({
    items: rows.map((r) => {
      const p = products.get(r.product_gid);
      return {
        product_handle: p ? p.handle : r.product_handle,
        title: p ? p.title : null,
        image_url: p ? p.image_url : null,
        price_cents: p ? p.price_cents : null,
        currency: p ? p.currency : "USD",
        url: p ? p.url : null,
        available: !!(p && p.available),
        saved_at: r.created_at,
      };
    }),
  });
}

// POST /api/holds { product_handle, variant_gid?, source? } → 201 (§9.2.7:
// the storefront's "Let us hold these for you" also posts here when signed
// in). One open hold per product.
export async function addHold(ctx) {
  const { env, session, json } = ctx;
  const body = await readJson(ctx.request);
  const handle = readHandle(body.product_handle);
  const product = await activeProduct(ctx, handle);
  const variant = typeof body.variant_gid === "string" && /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(body.variant_gid)
    ? body.variant_gid : null;
  await env.DB.prepare(
    `INSERT INTO holds (id, user_id, kind, product_handle, variant_gid, source, status, created_at)
     SELECT ?1, ?2, 'object_hold', ?3, ?4, ?5, 'open', ?6
      WHERE NOT EXISTS (SELECT 1 FROM holds WHERE user_id = ?2 AND kind = 'object_hold'
                          AND product_handle = ?3 AND status = 'open')`
  ).bind(ctx.newId(), session.user.id, product.handle, variant,
    body.source === "storefront" ? "storefront_form" : "portal", ctx.nowIso()).run();
  return json({ hold: { kind: "object_hold", product_handle: product.handle, status: "open" } }, 201);
}

// GET /api/holds → { holds, preorders }. A Shopify hiccup leaves titles empty
// and pre-orders out rather than failing the whole screen.
export async function listHolds(ctx) {
  const { env, session, json } = ctx;
  const rows = (await env.DB.prepare(
    `SELECT id, kind, product_handle, status, created_at FROM holds
      WHERE user_id = ?1 AND status = 'open' ORDER BY created_at DESC`
  ).bind(session.user.id).all()).results;

  const holds = [];
  for (const h of rows) {
    let product = null;
    if (h.product_handle && shopifyConfigured(env)) {
      try {
        product = await productByHandle(env, ctx.fetch, h.product_handle);
      } catch (e) {
        console.error("holds: product lookup failed", e && e.message);
      }
    }
    holds.push({
      id: h.id, kind: h.kind, product_handle: h.product_handle, status: h.status, created_at: h.created_at,
      title: product ? product.title : null, image_url: product ? product.image_url : null,
    });
  }

  let preorders = [];
  const customerId = await customerIdOf(env, session.user.id);
  if (customerId && shopifyConfigured(env)) {
    try {
      const page = await cached(env, `orders:v1:${session.user.id}:-`,
        () => fetchCustomerOrders(env, ctx.fetch, { customerId, after: null }));
      preorders = page.orders.filter((o) => o.status === "preorder")
        .map((o) => ({ order_id: o.id, name: o.name, created_at: o.created_at, thumb_url: o.thumb_url }));
    } catch (e) {
      console.error("holds: orders failed", e && e.message);
    }
  }
  return json({ holds, preorders });
}
