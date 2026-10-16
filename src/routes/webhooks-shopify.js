// POST /webhooks/shopify (spec §8.5, §9.2.8).
//
// Checks: X-Shopify-Hmac-Sha256 = base64 HMAC-SHA256 of the raw body with
// SHOPIFY_WEBHOOK_SECRET (for a subscription made by the "Claude Sync" app
// that is the app's client secret; for one made in Settings → Notifications
// it is the key shown there). No secret configured → 401, never "trust".
//
// Ledger: webhook_events, keyed by X-Shopify-Event-Id — `received` →
// `processed`, or `failed` + 500 so Shopify retries; a redelivery of a
// processed or ignored event answers 200 and does nothing.
//
// orders/create → `order_placed { order_id, customer_id, tier, is_repeat,
// used_gift_card }` (customer_id is the buyer key for the repeat-purchase
// metric) and the buyer's open object holds on the bought pieces become
// `converted`. The event id is derived from the order, so the same order
// delivered under two event ids is still counted once. V1 handles only
// orders/create; other topics are acknowledged and marked `ignored`.

import { HttpError, badRequest } from "../http/errors.js";
import { shopifyConfigured, shopifyGraphql } from "../shopify/admin.js";

const MAX_BODY_BYTES = 1024 * 1024;

const ORDER_PLACED = `query OrderPlaced($id: ID!) {
  order(id: $id) {
    id
    email
    paymentGatewayNames
    customer { id numberOfOrders }
    lineItems(first: 100) { nodes { product { id handle } } }
  }
}`;

const unauthorized = () => new HttpError(401, "invalid_signature", "The webhook signature is not valid.");

function base64ToBytes(value) {
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function validHmac(secret, raw, signature) {
  const sig = signature && base64ToBytes(signature);
  if (!secret || !sig) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  // subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", key, sig, raw);
}

const numericId = (gid) => {
  const m = /\/(\d+)$/.exec(gid || "");
  return m ? m[1] : null;
};

async function processOrderCreated(ctx, payload) {
  const { env } = ctx;
  if (!shopifyConfigured(env)) throw new Error("shopify not configured");
  const gid = typeof payload.admin_graphql_api_id === "string" ? payload.admin_graphql_api_id : null;
  if (!gid) throw new Error("payload without order id");
  const data = await shopifyGraphql(env, ctx.fetch, ORDER_PLACED, { id: gid });
  const order = data && data.order;
  if (!order) throw new Error("shopify order not found");

  const customerGid = order.customer ? order.customer.id : null;
  const email = typeof order.email === "string" ? order.email.trim().toLowerCase() : "";
  const user = await env.DB.prepare(
    `SELECT id, tier FROM users WHERE deleted_at IS NULL AND (shopify_customer_id = ?1 OR email = ?2)
     ORDER BY shopify_customer_id = ?1 DESC LIMIT 1`
  ).bind(customerGid, email || null).first();

  const createdAt = Number.isNaN(Date.parse(payload.created_at)) ? ctx.nowIso() : new Date(payload.created_at).toISOString();
  const orderId = numericId(order.id);
  const props = {
    order_id: orderId,
    customer_id: numericId(customerGid),
    tier: user ? user.tier : "none",
    is_repeat: !!order.customer && Number(order.customer.numberOfOrders) > 1,
    used_gift_card: Array.isArray(order.paymentGatewayNames) && order.paymentGatewayNames.includes("gift_card"),
  };
  const handles = [...new Set(((order.lineItems && order.lineItems.nodes) || [])
    .map((li) => li.product && li.product.handle).filter(Boolean))];

  const stmts = [
    env.DB.prepare("INSERT OR IGNORE INTO events (id, user_id, name, props_json, created_at) VALUES (?1, ?2, 'order_placed', ?3, ?4)")
      .bind(`order_placed:${orderId}`, user ? user.id : null, JSON.stringify(props), createdAt),
  ];
  if (user && handles.length) {
    stmts.push(env.DB.prepare(
      `UPDATE holds SET status = 'converted' WHERE user_id = ?1 AND kind = 'object_hold' AND status = 'open'
       AND product_handle IN (SELECT value FROM json_each(?2))`
    ).bind(user.id, JSON.stringify(handles)));
  }
  return stmts;
}

export async function shopifyWebhook(ctx) {
  const { env, request, json } = ctx;
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "The request is too large.");
  if (!(await validHmac(env.SHOPIFY_WEBHOOK_SECRET, raw, request.headers.get("X-Shopify-Hmac-Sha256")))) throw unauthorized();

  const eventId = request.headers.get("X-Shopify-Event-Id");
  const topic = request.headers.get("X-Shopify-Topic");
  if (!eventId || !topic) throw badRequest("missing_headers", "The webhook headers are incomplete.");
  const nowIso = ctx.nowIso();

  await env.DB.prepare(
    "INSERT OR IGNORE INTO webhook_events (event_id, source, type, received_at, status) VALUES (?1, 'shopify', ?2, ?3, 'received')"
  ).bind(eventId, topic, nowIso).run();
  const row = await env.DB.prepare("SELECT status FROM webhook_events WHERE event_id = ?1").bind(eventId).first();
  if (row && (row.status === "processed" || row.status === "ignored")) return json({ ok: true, duplicate: true });

  const done = (status, error = null) => env.DB.prepare(
    "UPDATE webhook_events SET status = ?1, processed_at = ?2, error = ?3 WHERE event_id = ?4"
  ).bind(status, nowIso, error, eventId);

  if (topic !== "orders/create") {
    await done("ignored").run();
    return json({ ok: true, ignored: true });
  }

  try {
    const payload = JSON.parse(new TextDecoder().decode(raw));
    const stmts = await processOrderCreated(ctx, payload);
    await env.DB.batch([...stmts, done("processed")]);
    return json({ ok: true });
  } catch (e) {
    // The stored error is a short reason, never payload data.
    const reason = String((e && e.message) || "error").slice(0, 200);
    console.error("shopify webhook failed", topic, reason);
    await done("failed", reason).run();
    return json({ error: { code: "webhook_failed", message: "Processing failed; Shopify will retry." } }, 500);
  }
}
