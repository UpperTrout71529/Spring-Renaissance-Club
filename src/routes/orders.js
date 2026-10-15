// GET /api/orders?cursor= and GET /api/orders/:id (spec §8.3, §9.2.3; S5).
// Orders come from Shopify by the customer linked at sign-in; an order is
// served only when it belongs to that customer (404 otherwise, never 403, so
// order numbers cannot be probed). Responses are cached in KV for 5 minutes
// per user.

import { HttpError, badRequest, notFound } from "../http/errors.js";
import { shopifyConfigured } from "../shopify/admin.js";
import { fetchCustomerOrders, fetchOrder } from "../shopify/orders.js";

const CACHE_TTL_SECONDS = 5 * 60;

const unavailable = () =>
  new HttpError(503, "orders_unavailable", "We couldn't load your orders right now. Please try again in a moment.");

async function cached(env, key, load) {
  try {
    const hit = await env.CLIENT_KV.get(key, { type: "json" });
    if (hit) return hit;
  } catch (e) {
    console.error("orders cache read failed", e && e.name);
  }
  const value = await load();
  try {
    await env.CLIENT_KV.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS });
  } catch (e) {
    console.error("orders cache write failed", e && e.name);
  }
  return value;
}

async function customerIdOf(env, userId) {
  const row = await env.DB.prepare("SELECT shopify_customer_id FROM users WHERE id = ?1").bind(userId).first();
  return row && row.shopify_customer_id;
}

export async function listOrders(ctx) {
  const { env, session, url, json } = ctx;
  const cursor = url.searchParams.get("cursor") || "";
  if (cursor.length > 512) throw badRequest("invalid_cursor", "This page of orders is no longer available.");

  const customerId = await customerIdOf(env, session.user.id);
  // No Shopify customer linked yet: no orders under this email.
  if (!customerId) return json({ orders: [], next_cursor: null });
  if (!shopifyConfigured(env)) throw unavailable();

  try {
    const page = await cached(env, `orders:v1:${session.user.id}:${cursor || "-"}`,
      () => fetchCustomerOrders(env, ctx.fetch, { customerId, after: cursor || null }));
    return json(page);
  } catch (e) {
    console.error("orders: shopify failed", e && e.message);
    throw unavailable();
  }
}

export async function getOrder(ctx) {
  const { env, session, params, json } = ctx;
  if (!/^\d{1,20}$/.test(params.id)) throw notFound();
  const customerId = await customerIdOf(env, session.user.id);
  if (!customerId) throw notFound();
  if (!shopifyConfigured(env)) throw unavailable();

  let order;
  try {
    // The cache key carries the user, so one user's cached order can never
    // be served to another.
    order = await cached(env, `order:v1:${session.user.id}:${params.id}`,
      async () => (await fetchOrder(env, ctx.fetch, { customerId, orderId: params.id })) || { missing: true });
  } catch (e) {
    console.error("order: shopify failed", e && e.message);
    throw unavailable();
  }
  if (!order || order.missing) throw notFound();
  return json({ order });
}
